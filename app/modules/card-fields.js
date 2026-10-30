/**
 * The card's comparable fields: one definition for the update check, the version diff and the restore (provider extras stay with the provider hook).
 * @property {string} key  the write key writeCardFields accepts (depth_prompt.* maps under extensions there)
 * @property {boolean} [long]  a text diff rather than a one-line value
 * @property {boolean} [array]  a list, diffed per item
 * @property {boolean} [optional]  a row the diff hides when neither side carries a value
 * @property {boolean} [orderInsensitive]  a list compared as a set, case-folded
 */
export const CARD_COMPARABLE_FIELDS = Object.freeze([
    { key: 'name', label: 'Name', icon: 'fa-signature' },
    { key: 'description', label: 'Description', icon: 'fa-scroll', long: true },
    { key: 'personality', label: 'Personality', icon: 'fa-brain', long: true },
    { key: 'scenario', label: 'Scenario', icon: 'fa-map', long: true },
    { key: 'first_mes', label: 'First Message', icon: 'fa-comment', long: true },
    { key: 'mes_example', label: 'Example Messages', icon: 'fa-comments', long: true },
    { key: 'system_prompt', label: 'System Prompt', icon: 'fa-terminal', long: true },
    { key: 'post_history_instructions', label: 'Post History Instructions', icon: 'fa-clock-rotate-left', long: true },
    { key: 'creator_notes', label: 'Creator Notes', icon: 'fa-sticky-note', long: true },
    { key: 'creator', label: 'Creator', icon: 'fa-pen-nib' },
    { key: 'tags', label: 'Tags', icon: 'fa-tags', array: true, orderInsensitive: true },
    { key: 'alternate_greetings', label: 'Alternate Greetings', icon: 'fa-list', long: true, array: true },
    // V3
    { key: 'nickname', label: 'Nickname', icon: 'fa-id-badge', optional: true },
    { key: 'group_only_greetings', label: 'Group Only Greetings', icon: 'fa-users', long: true, array: true, optional: true },
    // the Character's Note: stored under extensions.depth_prompt, a provider may answer it at
    // the top level (character_version is deliberately absent: always "main" on ChubAI)
    { key: 'depth_prompt.prompt', label: "Character's Note", icon: 'fa-layer-group', long: true, optional: true },
    { key: 'depth_prompt.depth', label: "Character's Note Depth", icon: 'fa-arrow-down-1-9', optional: true },
    { key: 'depth_prompt.role', label: "Character's Note Role", icon: 'fa-user-tag', optional: true },
    { key: 'character_book', label: 'Embedded Lorebook', icon: 'fa-book' },
].map(Object.freeze));

export const CARD_FIELD_KEYS = Object.freeze(CARD_COMPARABLE_FIELDS.map(f => f.key));
export const LONG_TEXT_KEYS = new Set(CARD_COMPARABLE_FIELDS.filter(f => f.long).map(f => f.key));
export const ORDER_INSENSITIVE_KEYS = new Set(CARD_COMPARABLE_FIELDS.filter(f => f.orderInsensitive).map(f => f.key));
// the flat keys a restore writes whole (depth_prompt rides the extensions namespace restore)
export const RESTORABLE_KEYS = Object.freeze(CARD_FIELD_KEYS.filter(k => !k.includes('.')));

/** A field's value by comparable key; depth_prompt.* reads top level (provider shape) before extensions (stored shape). */
export function readCardField(data, key) {
    if (key.startsWith('depth_prompt.')) {
        const sub = key.slice('depth_prompt.'.length);
        const top = data?.depth_prompt?.[sub];
        if (top !== undefined) return top;
        return data?.extensions?.depth_prompt?.[sub];
    }
    return key.split('.').reduce((o, k) => o?.[k], data);
}


/** The one shape the diffs compare: absent/empty/[] are one nothing, lists compare IN ORDER unless the field is a set. */
export function normalizeCardValue(value, key = '') {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) {
        if (value.length === 0) return '';
        const asSet = ORDER_INSENSITIVE_KEYS.has(key);
        const items = value.map(v => (typeof v === 'string'
            ? (asSet ? v.replace(/\r\n/g, '\n').trim().toLowerCase() : v.replace(/\r\n/g, '\n').trim())
            : JSON.stringify(v)));
        // a set is stored folded (PATCH trims, links by NOCASE name), so compare folded or the update never settles
        if (asSet) return JSON.stringify([...new Set(items)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
        return JSON.stringify(items);
    }
    if (typeof value === 'object') return JSON.stringify(value);
    // a name is stored as one line, folded and capped (by code point) like oneLineName, or the update never settles
    if (key === 'name') return [...String(value).replace(/\s*[\r\n\t\u2028\u2029]\s*/g, ' ').trim()].slice(0, 128).join('').trimEnd();
    return String(value).replace(/\r\n/g, '\n').trim();
}

/** Is this one field the same on both cards? The ONE answer both diff tools give. */
export function cardValuesEqual(a, b, key = '') {
    return normalizeCardValue(a, key) === normalizeCardValue(b, key);
}

// ========================================
// THE EDIT SURFACE
// ========================================

/** The editor's fields in save-confirmation order: [form key, comparable key], null for the three no card diff compares. */
const EDITOR_ROWS = [
    ['name', 'name'],
    ['description', 'description'],
    ['first_mes', 'first_mes'],
    ['personality', 'personality'],
    ['scenario', 'scenario'],
    ['mes_example', 'mes_example'],
    ['system_prompt', 'system_prompt'],
    ['post_history_instructions', 'post_history_instructions'],
    ['creator_notes', 'creator_notes'],
    ['creator', 'creator'],
    ['nickname', 'nickname'],
    ['tagsArray', 'tags'],
    ['depth_prompt', 'depth_prompt.prompt'],
    ['depth_prompt_depth', 'depth_prompt.depth'],
    ['depth_prompt_role', 'depth_prompt.role'],
    ['alternate_greetings', 'alternate_greetings'],
    ['character_book', 'character_book'],
];
// The editor's own three: not card content any diff compares, but a save writes them.
const EDITOR_OWN = [
    ['character_version', 'Version'],
    ['tagline', 'Tagline'],
    ['listingName', 'Listing Name'],
];
const LABEL_OF = new Map(CARD_COMPARABLE_FIELDS.map(f => [f.key, f.label]));
export const CARD_EDITOR_FIELDS = Object.freeze([
    ...EDITOR_ROWS.map(([formKey, key]) => Object.freeze({ formKey, key, label: LABEL_OF.get(key) })),
    ...EDITOR_OWN.map(([formKey, label]) => Object.freeze({ formKey, key: null, label })),
]);

// shared head + tail over the longer text; a low floor (a reworded opener is the same greeting), nonzero or everything pairs
const RESEMBLANCE_FLOOR = 0.25;
function resemblance(a, b) {
    const x = String(a ?? ""), y = String(b ?? "");
    if (!x.length || !y.length) return 0;
    if (x === y) return 1;
    const max = Math.max(x.length, y.length);
    let head = 0;
    while (head < x.length && head < y.length && x[head] === y[head]) head++;
    let tail = 0;
    while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
    return (head + tail) / max;
}

/**
 * Pair two lists so an edit reads as an edit and a deletion as ONE deletion, not a renumbering.
 * @returns {Array<{status, from, to, old, new}>} new-list order, removals last; from/to are zero-based positions
 */
export function matchListItems(oldList, newList, normalize = (v) => String(v ?? '')) {
    const olds = (Array.isArray(oldList) ? oldList : []).map(normalize);
    const news = (Array.isArray(newList) ? newList : []).map(normalize);
    const takenOld = new Set();
    const pairedTo = new Map(); // new index -> old index

    // 1. exact matches first, nearest position wins so a shuffle pairs sensibly
    for (let n = 0; n < news.length; n++) {
        let best = -1;
        for (let o = 0; o < olds.length; o++) {
            if (takenOld.has(o) || olds[o] !== news[n]) continue;
            if (best < 0 || Math.abs(o - n) < Math.abs(best - n)) best = o;
        }
        if (best >= 0) { takenOld.add(best); pairedTo.set(n, best); }
    }
    // 2. leftovers pair by RESEMBLANCE, not position; two unrelated items stay a removal and an addition
    const freeOld = [];
    for (let o = 0; o < olds.length; o++) if (!takenOld.has(o)) freeOld.push(o);
    const freeNew = [];
    for (let n = 0; n < news.length; n++) if (!pairedTo.has(n)) freeNew.push(n);
    const stillFree = new Set(freeOld);
    for (const n of freeNew) {
        let best = -1, bestScore = 0;
        for (const o of stillFree) {
            const score = resemblance(olds[o], news[n]);
            if (score > bestScore) { best = o; bestScore = score; }
        }
        if (best >= 0 && bestScore >= RESEMBLANCE_FLOOR) { stillFree.delete(best); pairedTo.set(n, best); }
    }

    // 3. a move is a real reorder: the longest run that kept its relative order stays put, only what breaks it moved
    const ordered = [...pairedTo.entries()].sort((a, b) => a[0] - b[0]);
    const froms = ordered.map(([, o]) => o);
    const tails = [], links = new Array(froms.length).fill(-1), idx = [];
    for (let k = 0; k < froms.length; k++) {
        let lo = 0, hi = tails.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < froms[k]) lo = mid + 1; else hi = mid; }
        tails[lo] = froms[k];
        idx[lo] = k;
        links[k] = lo > 0 ? idx[lo - 1] : -1;
    }
    const inPlace = new Set();
    for (let k = tails.length ? idx[tails.length - 1] : -1; k >= 0; k = links[k]) inPlace.add(ordered[k][0]);

    // the reader reads in the NEW list order, with what is gone listed after it
    const entries = [];
    for (let n = 0; n < news.length; n++) {
        const o = pairedTo.get(n);
        if (o === undefined) { entries.push({ status: 'added', from: null, to: n, old: null, new: news[n] }); continue; }
        if (olds[o] !== news[n]) entries.push({ status: 'changed', from: o, to: n, old: olds[o], new: news[n] });
        else if (!inPlace.has(n)) entries.push({ status: 'moved', from: o, to: n, old: olds[o], new: news[n] });
        else entries.push({ status: 'same', from: o, to: n, old: olds[o], new: news[n] });
    }
    for (const o of freeOld) if (stillFree.has(o)) entries.push({ status: 'removed', from: o, to: null, old: olds[o], new: null });
    return entries;
}
