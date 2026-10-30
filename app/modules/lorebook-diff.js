// The lorebook diff engine for the update check and the version history; structure only, each consumer renders its own view.

export const LOREBOOK_META_FIELDS = {
    name: 'Name',
    description: 'Description',
    scan_depth: 'Scan Depth',
    token_budget: 'Token Budget',
    recursive_scanning: 'Recursive Scanning',
};

// V2-spec entry fields - everything else (uid, display_index, vectorized, etc.) is ST-internal
export const LOREBOOK_ENTRY_FIELDS = [
    'keys', 'secondary_keys', 'content', 'enabled', 'selective',
    'constant', 'position', 'insertion_order', 'priority', 'case_sensitive',
    'name', 'comment', 'id'
];

export function lorebookEntryName(entry) {
    if (entry.comment?.trim()) return entry.comment.trim();
    if (entry.name?.trim()) return entry.name.trim();
    const keys = entry.keys || [];
    if (keys.length > 0) return keys.slice(0, 3).join(', ');
    return `Entry #${entry.id ?? '?'}`;
}

export function hasLorebookMeta(book) {
    if (!book) return false;
    return Object.keys(LOREBOOK_META_FIELDS).some(k => book[k] != null);
}

export function normalizeLorebookKeys(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return [];
    const expanded = [];
    for (const k of arr) {
        for (const part of String(k).split(',')) {
            const trimmed = part.trim();
            if (trimmed) expanded.push(trimmed);
        }
    }
    return expanded.sort();
}

export function normalizeLorebookEntry(entry, { normalizeKeys = true } = {}) {
    const out = {};
    for (const f of LOREBOOK_ENTRY_FIELDS) {
        if (entry[f] !== undefined) {
            out[f] = (normalizeKeys && (f === 'keys' || f === 'secondary_keys')) ? normalizeLorebookKeys(entry[f]) : entry[f];
        }
    }
    return out;
}

// A key list as the matchers read it: comma-joined keys split, each lowercased and trimmed, as a set
export function expandLorebookKeys(keys) {
    const expanded = new Set();
    for (const k of (keys || [])) {
        for (const part of String(k).split(',')) {
            const trimmed = part.toLowerCase().trim();
            if (trimmed) expanded.add(trimmed);
        }
    }
    return expanded;
}

export function lorebookEntryMatchScore(a, b) {
    const aKeys = expandLorebookKeys(a.keys);
    const bKeys = expandLorebookKeys(b.keys);

    if (aKeys.size > 0 && bKeys.size > 0) {
        let intersection = 0;
        for (const k of aKeys) { if (bKeys.has(k)) intersection++; }
        const union = new Set([...aKeys, ...bKeys]).size;
        if (union > 0) {
            const jaccard = intersection / union;
            if (jaccard > 0) return jaccard;
        }
    }

    const aName = (a.comment || a.name || '').toLowerCase().trim();
    const bName = (b.comment || b.name || '').toLowerCase().trim();
    if (aName && bName) {
        if (aName === bName) return 1;
        if (aName.includes(bName) || bName.includes(aName)) return 0.8;
    }

    const aCont = (a.content || '').slice(0, 200).toLowerCase().trim();
    const bCont = (b.content || '').slice(0, 200).toLowerCase().trim();
    if (aCont.length > 20 && bCont.length > 20 && aCont === bCont) return 0.7;

    return 0;
}

/**
 * Whether an embedded entry also lives in a linked lorebook: key Jaccard above 0.3, or name/comment containment.
 * @param {{keys?: string[], name?: string}} entry - the embedded entry's keys and display name
 * @param {Object[]} worldEntries - the file's entries (`key`, `comment`)
 * @returns {boolean}
 */
export function entryInWorld({ keys, name } = {}, worldEntries) {
    const embeddedKeys = expandLorebookKeys(keys);
    const entryName = String(name || '').toLowerCase().trim();
    for (const we of (worldEntries || [])) {
        const wKeys = expandLorebookKeys(we.key);
        if (embeddedKeys.size > 0 && wKeys.size > 0) {
            let inter = 0;
            for (const k of embeddedKeys) { if (wKeys.has(k)) inter++; }
            const union = new Set([...embeddedKeys, ...wKeys]).size;
            if (union > 0 && (inter / union) > 0.3) return true;
        }
        const wName = (we.comment || '').toLowerCase().trim();
        if (entryName && wName && (entryName === wName || entryName.includes(wName) || wName.includes(entryName))) return true;
    }
    return false;
}

export function compareLorebookEntryFields(local, remote, { normalizeKeys = true } = {}) {
    const changed = [];
    for (const f of LOREBOOK_ENTRY_FIELDS) {
        if (f === 'id' || f === 'name' || f === 'comment') continue;
        if (normalizeKeys && (f === 'keys' || f === 'secondary_keys')) {
            if (JSON.stringify(normalizeLorebookKeys(local[f])) !== JSON.stringify(normalizeLorebookKeys(remote[f]))) {
                changed.push(f);
            }
            continue;
        }
        if (JSON.stringify(local[f] ?? null) !== JSON.stringify(remote[f] ?? null)) {
            changed.push(f);
        }
    }
    return changed;
}

export function matchLorebookEntries(localEntries, remoteEntries, opts = {}) {
    const matched = [];
    const usedRemote = new Set();
    const removed = [];

    // Match by key overlap (Jaccard); forward pass + positional tie-break so an identical lorebook doesnt diff as a wall of fake changes.
    for (let i = 0; i < localEntries.length; i++) {
        const local = localEntries[i];
        let bestIdx = -1;
        let bestScore = 0;

        for (let j = 0; j < remoteEntries.length; j++) {
            if (usedRemote.has(j)) continue;
            const score = lorebookEntryMatchScore(local, remoteEntries[j]);
            if (score > bestScore || (score === bestScore && score > 0 && bestIdx >= 0 && Math.abs(j - i) < Math.abs(bestIdx - i))) {
                bestScore = score;
                bestIdx = j;
            }
        }

        if (bestIdx >= 0 && bestScore > 0.3) {
            usedRemote.add(bestIdx);
            const changedFields = compareLorebookEntryFields(local, remoteEntries[bestIdx], opts);
            matched.push({ local, remote: remoteEntries[bestIdx], changedFields });
        } else {
            removed.push(local);
        }
    }

    const added = remoteEntries.filter((_, j) => !usedRemote.has(j));
    return { matched, added, removed };
}

export function compareLorebookMeta(localBook, remoteBook) {
    const diffs = [];
    for (const [key, label] of Object.entries(LOREBOOK_META_FIELDS)) {
        const lv = localBook?.[key];
        const rv = remoteBook?.[key];
        if (JSON.stringify(lv ?? null) !== JSON.stringify(rv ?? null)) {
            diffs.push({
                key,
                label,
                localStr: lv == null ? '(not set)' : typeof lv === 'object' ? JSON.stringify(lv) : String(lv),
                remoteStr: rv == null ? '(not set)' : typeof rv === 'object' ? JSON.stringify(rv) : String(rv)
            });
        }
    }
    return diffs;
}

export function lorebooksEqual(a, b, opts = {}) {
    const aEntries = a?.entries || [];
    const bEntries = b?.entries || [];
    const aEmpty = aEntries.length === 0;
    const bEmpty = bEntries.length === 0;
    if (aEmpty && bEmpty) return true;

    for (const key of Object.keys(LOREBOOK_META_FIELDS)) {
        if (JSON.stringify(a?.[key] ?? null) !== JSON.stringify(b?.[key] ?? null)) return false;
    }

    // Compare entries (order-sensitive by spec)
    if (aEntries.length !== bEntries.length) return false;
    for (let i = 0; i < aEntries.length; i++) {
        const na = normalizeLorebookEntry(aEntries[i], opts);
        const nb = normalizeLorebookEntry(bEntries[i], opts);
        if (JSON.stringify(na) !== JSON.stringify(nb)) return false;
    }
    return true;
}
