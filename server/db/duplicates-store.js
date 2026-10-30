// The duplicate scan and the pre-import match over the store; the scan answers ids and scores, never rows
import { normalizeRow, fastSimilarity, fullSimilarity, bigramOccurrences, bigramFloor, lowestBigramFloor, similarNameLengths, nameVariantsForDupe, gradeNameMatches, providerPathsMatch, CONFIDENCE_ORDER } from '../lib/duplicate-match.js';
import { matchCharactersByName, probeProviderLinkOwners, linkedProviderIds, providerPathGroups, UUID_KEY } from './characters-store.js';

const tick = () => new Promise(r => setImmediate(r));
const inflight = new Map();

export function scanDuplicates(db) {
    const key = db.name;
    if (inflight.has(key)) return inflight.get(key);
    const run = runScan(db).finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
}

const cardFields = (db, id) => {
    const row = db.prepare('SELECT card FROM characters WHERE id = ?').get(id);
    if (!row) return null;
    try { return JSON.parse(row.card)?.data || {}; } catch { return {}; }
};

const groupConfidence = (duplicates) => duplicates.reduce((max, d) => (CONFIDENCE_ORDER[d.confidence] > CONFIDENCE_ORDER[max] ? d.confidence : max), duplicates[0].confidence);

const SCAN_PAGE = 500;

async function runScan(db) {
    const started = Date.now();
    const rows = [];
    // keyset pages, never an open iterator: a statement held across a yield refuses every write on the connection
    const first = db.prepare('SELECT rowid AS rid, id, name, creator, creator_notes FROM characters ORDER BY name COLLATE NOCASE, rowid LIMIT ?');
    const next = db.prepare(`SELECT rowid AS rid, id, name, creator, creator_notes FROM characters
        WHERE name >= ? COLLATE NOCASE AND (name > ? COLLATE NOCASE OR rowid > ?) ORDER BY name COLLATE NOCASE, rowid LIMIT ?`);
    // a rename between pages can carry a row past the cursor, so its second read is skipped
    const read = new Set();
    for (let page = first.all(SCAN_PAGE); page.length; ) {
        for (const r of page) if (!read.has(r.id)) { read.add(r.id); rows.push({ id: r.id, ...normalizeRow(r) }); }
        const last = page[page.length - 1];
        await tick();
        page = next.all(last.name, last.name, last.rid, SCAN_PAGE);
    }

    // candidates: a variant's first four letters, or one of its rarest bigrams at a reachable length (lossless for bigramFloor)
    const freq = new Map();
    for (let i = 0; i < rows.length; i++) {
        if (i % 2000 === 1999) await tick();
        const row = rows[i];
        row.grams = row.nameVariants.filter(v => v.length >= 3).map(v => ({ v, len: v.length, occ: bigramOccurrences(v) }));
        for (const g of row.grams) for (const o of g.occ) freq.set(o, (freq.get(o) || 0) + 1);
    }
    const rank = new Map([...freq.keys()].sort((x, y) => (freq.get(x) - freq.get(y)) || (x < y ? -1 : 1)).map((o, k) => [o, k]));
    // every list holds rows in scan order, so it is read from a cursor past the row being probed
    const byHead = new Map();
    const byLength = new Map();
    const file = (map, key, i) => {
        let list = map.get(key);
        if (!list) map.set(key, list = { rows: [], at: 0 });
        if (list.rows[list.rows.length - 1] !== i) list.rows.push(i);
    };
    for (let i = 0; i < rows.length; i++) {
        if (i % 2000 === 1999) await tick();
        for (const g of rows[i].grams) {
            g.ids = Int32Array.from(g.occ, o => rank.get(o)).sort();
            g.prefix = Math.max(0, g.ids.length - lowestBigramFloor(g.len) + 1);
            g.reach = similarNameLengths(g.len);
            g.head = g.v.slice(0, 4);
            let byRare = byLength.get(g.len);
            if (!byRare) byLength.set(g.len, byRare = new Map());
            for (let k = 0; k < g.prefix; k++) file(byRare, g.ids[k], i);
            file(byHead, g.head, i);
            g.v = g.occ = null;
        }
    }
    const after = (list, i) => { while (list.at < list.rows.length && list.rows[list.at] <= i) list.at++; return list.at; };
    const overlapReaches = (x, y, need) => {
        let p = 0, q = 0, n = 0;
        while (p < x.length && q < y.length) {
            if (n + Math.min(x.length - p, y.length - q) < need) return false;
            if (x[p] === y[q]) { if (++n >= need) return true; p++; q++; } else if (x[p] < y[q]) p++; else q++;
        }
        return false;
    };
    const reaches = (a, b) => a.grams.some(ga => b.grams.some(gb => gb.len >= ga.reach[0] && gb.len <= ga.reach[1]
        && overlapReaches(ga.ids, gb.ids, bigramFloor(ga.len, gb.len))));

    const groups = [];
    const processed = new Uint8Array(rows.length);
    const seen = new Int32Array(rows.length);
    // one provider path is one card imported twice: those group first at 100 and the passes below leave them
    const byLink = new Set();
    const indexOf = new Map(rows.map((r, i) => [r.id, i]));
    for (const link of providerPathGroups(db)) {
        const members = link.charIds.map(id => indexOf.get(id)).filter(i => i !== undefined && !processed[i]).sort((x, y) => x - y);
        if (members.length < 2) continue;
        for (const i of members) processed[i] = 1;
        const group = {
            reference: rows[members[0]].id,
            duplicates: members.slice(1).map(i => ({
                id: rows[i].id, confidence: 'high', score: 100, breakdown: { providerPath: 100 },
                contentIdentical: false, strictIdentical: false,
                matchReason: `Same ${link.providerId} character (one provider path)`, matchReasons: [],
            })),
            confidence: 'high',
        };
        byLink.add(group);
        groups.push(group);
    }
    // the thread is shared with every request, so the scan yields by the work it has done
    let work = 0;
    const YIELD_EVERY = 20000;
    for (let i = 0; i < rows.length; i++) {
        if ((work += 1) >= YIELD_EVERY) { work = 0; await tick(); }
        if (processed[i]) continue;
        const a = rows[i];
        const stamp = i + 1;
        const candidates = [];
        // every head match is a candidate, so the heads go first and a probe skips what they found
        for (const ga of a.grams) {
            const head = byHead.get(ga.head);
            for (let at = after(head, i); at < head.rows.length; at++) {
                const j = head.rows[at];
                if (seen[j] !== stamp) { seen[j] = stamp; candidates.push(j); }
            }
            work += head.rows.length - head.at;
        }
        for (const ga of a.grams) {
            for (let len = ga.reach[0]; len <= ga.reach[1]; len++) {
                const byRare = byLength.get(len);
                if (!byRare) continue;
                for (let k = 0; k < ga.prefix; k++) {
                    const list = byRare.get(ga.ids[k]);
                    if (!list) continue;
                    for (let at = after(list, i); at < list.rows.length; at++) {
                        const j = list.rows[at];
                        if (seen[j] === stamp) continue;
                        seen[j] = stamp;
                        work++;
                        if (reaches(a, rows[j])) candidates.push(j);
                    }
                }
            }
        }
        const duplicates = [];
        for (const j of candidates.sort((x, y) => x - y)) {
            if (processed[j]) continue;
            const sim = fastSimilarity(a, rows[j]);
            if (sim.confidence) duplicates.push({ j, id: rows[j].id, ...sim });
        }
        work += candidates.length;
        if (!duplicates.length) continue;
        processed[i] = 1;
        for (const d of duplicates) { processed[d.j] = 1; delete d.j; }
        duplicates.sort((x, y) => y.score - x.score);
        groups.push({ reference: a.id, duplicates, confidence: groupConfidence(duplicates) });
    }

    // the re-score with the full cards, members only
    for (const [gi, group] of groups.entries()) {
        if (gi % 50 === 0) await tick();
        if (byLink.has(group)) continue;
        const ref = cardFields(db, group.reference) || {};
        for (const dup of group.duplicates) {
            const fields = cardFields(db, dup.id) || {};
            Object.assign(dup, fullSimilarity(ref, fields));
        }
        group.duplicates = group.duplicates.filter(d => d.confidence || d.contentIdentical);
        if (group.duplicates.length) {
            group.confidence = groupConfidence(group.duplicates);
            group.duplicates.sort((x, y) => y.score - x.score);
        }
    }
    const found = groups.filter(g => g.duplicates.length > 0);
    const order = { high: 0, medium: 1, low: 2 };
    found.sort((x, y) => {
        const c = order[x.confidence] - order[y.confidence];
        if (c !== 0) return c;
        return Math.max(...y.duplicates.map(d => d.score)) - Math.max(...x.duplicates.map(d => d.score));
    });
    return { groups: found, scanned: rows.length, ms: Date.now() - started };
}

/**
 * One incoming card against the library (link, name and creator arms), every candidate scored on its full card, best first.
 * @param {object} probe { name, creator, fullPath, externalId, providerId, definition: { description, first_mes, personality, scenario, creator_notes } }
 */
export function matchCharacter(db, probe) {
    const def = probe.definition || {};
    const fields = {
        name: probe.name || def.name || '',
        creator: probe.creator || def.creator || '',
        description: probe.description || def.description || '',
        first_mes: probe.first_mes || def.first_mes || '',
        personality: probe.personality || def.personality || '',
        scenario: probe.scenario || def.scenario || '',
        creator_notes: probe.creator_notes || def.creator_notes || '',
    };
    const matches = [];
    const taken = new Set();
    const nameOf = (id) => db.prepare('SELECT name FROM characters WHERE id = ?').get(id)?.name || '';

    const fullPath = String(probe.fullPath || probe.full_path || '').trim();
    const externalId = String(probe.externalId || '').trim();
    const keys = [fullPath, externalId].filter(Boolean);
    if (keys.length) {
        // named provider: exact and loose; the others: exact, uuid keys only (a uuid names one card anywhere); none named: exact everywhere
        const named = probe.providerId ? String(probe.providerId) : null;
        const elsewhere = linkedProviderIds(db).filter(p => p !== named);
        const everywhere = named ? keys.filter(k => UUID_KEY.test(k)) : keys;
        const owners = [
            ...(named ? probeProviderLinkOwners(db, { providers: [named], keys, loose: true }) : []),
            ...(everywhere.length && elsewhere.length ? probeProviderLinkOwners(db, { providers: elsewhere, keys: everywhere, loose: false }) : []),
        ];
        const lowerPath = fullPath.toLowerCase();
        for (const o of owners) {
            if (taken.has(o.charId)) continue;
            const byPath = lowerPath && (o.exact ? String(o.fullPath || '').toLowerCase() === lowerPath || o.externalId === fullPath : providerPathsMatch(String(o.fullPath || '').toLowerCase(), lowerPath));
            const byId = externalId && (o.externalId === externalId || (probe.providerId && String(o.providerId) === String(probe.providerId) && String(o.externalId).toLowerCase() === externalId.toLowerCase()));
            if (!byPath && !byId) continue;
            taken.add(o.charId);
            matches.push({
                id: o.charId, name: nameOf(o.charId), confidence: 'high', score: 100, breakdown: { providerPath: 100 },
                contentIdentical: false, strictIdentical: false,
                matchReason: byPath ? `Same ${o.providerId} character (exact path match)` : `Same ${o.providerId} character (same id)`,
                matchReasons: [],
            });
        }
    }

    const candidates = new Set();
    const probes = [...new Set([fields.name, ...nameVariantsForDupe(fields.name)].map(s => String(s).trim()).filter(s => s.length >= 2))].slice(0, 8);
    if (probes.length) for (const r of matchCharactersByName(db, probes)) for (const m of r.matches || []) candidates.add(m.id);
    const creator = String(fields.creator).trim();
    // a prefix range on the NOCASE creator index; a contains match walks the whole search index
    if (creator.length >= 3) {
        for (const r of db.prepare('SELECT id FROM characters WHERE creator >= ? COLLATE NOCASE AND creator < ? COLLATE NOCASE LIMIT 30').all(creator, `${creator}\uffff`)) candidates.add(r.id);
    }
    for (const id of candidates) {
        if (taken.has(id)) continue;
        const card = cardFields(db, id);
        if (!card) continue;
        const sim = fullSimilarity(fields, card);
        if (!sim.confidence) continue;
        taken.add(id);
        matches.push({ id, name: card.name || nameOf(id), ...sim });
    }
    matches.sort((x, y) => y.score - x.score);
    return matches;
}

/**
 * The browse hint's name probe (POST /characters/match), graded by gradeNameMatches like the pre-import match.
 * @param {string[]} names
 */
export function matchNamesForHint(db, names) {
    return names.map(raw => {
        const name = typeof raw === 'string' ? raw.trim() : '';
        const probes = [...new Set([name, ...nameVariantsForDupe(name)].map(s => String(s).trim()).filter(s => s.length >= 3))];
        if (!probes.length) return { variants: [], matches: [] };
        const rows = new Map();
        for (const r of matchCharactersByName(db, probes)) for (const m of r.matches) if (!rows.has(`${m.id}|${m.name}`)) rows.set(`${m.id}|${m.name}`, m);
        return gradeNameMatches(name, [...rows.values()]);
    });
}
