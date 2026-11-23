// The duplicate scan, the pre-import match, the browse hint and the link ranking, over the fingerprint index; every verdict is the rule's (duplicate-match.js)
import {
    prepareCard, cardFingerprint, ownKeysOf, worthScoring, isDuplicate, gradeNameMatches, hintScore, publicTextVerdict, providerPathsMatch,
    namePrefixesOf, descriptionDistance, mayBeRenamed, TWIN_BITS, bigramOccurrences, bigramFloor, lowestBigramFloor, similarNameLengths, CONFIDENCE_ORDER,
    listingOf, differentListings, linkVerdict,
} from '../lib/duplicate-match.js';
import { probeProviderLinkOwners, linkedProviderIds, providerPathGroups, UUID_KEY } from './characters-store.js';
import { nameHolderSteps, creatorHolders, cutFieldPrints, descriptionTwins, allFingerprintSteps, drainFingerprints, allListingTitles, listingsOf, creatorNotesOf } from './fingerprint-index.js';
import { pairJudge } from './duplicate-judge.js';
import { nextTurn, finishSteps, runSteps } from '../lib/steps.js';
import { httpError } from '../lib/http-error.js';
import { HINT_TEXT_MAX } from '../lib/query-params.js';

const inflight = new Map();
// the namesakes a browse hint answers per remote card, beside their total: the score reads them all
const HINT_MATCHES = 16;

/** The library's duplicate groups, ids and scores only; a second request while one runs joins it. */
export function scanDuplicates(db) {
    const key = db.name;
    if (inflight.has(key)) return inflight.get(key);
    const run = runScan(db).finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
}

const groupConfidence = (duplicates) => duplicates.reduce((max, d) => (CONFIDENCE_ORDER[d.confidence] > CONFIDENCE_ORDER[max] ? d.confidence : max), duplicates[0].confidence);
const identityOf = (v) => ({ contentIdentical: !!v?.contentIdentical, strictIdentical: !!v?.strictIdentical });
const answerOf = (id, v) => ({ id, score: v.score, breakdown: v.breakdown, confidence: v.confidence, contentIdentical: v.contentIdentical, strictIdentical: v.strictIdentical, matchReason: v.matchReason, matchReasons: v.matchReasons, textCompared: !!v.textCompared });

// the scan's lists hold rows in scan order, filed once each and read from a cursor past the row being probed
const fileRow = (map, key, i) => {
    let list = map.get(key);
    if (!list) map.set(key, list = { rows: [], at: 0 });
    if (list.rows[list.rows.length - 1] !== i) list.rows.push(i);
};
const pastRow = (list, i) => { while (list.at < list.rows.length && list.rows[list.at] <= i) list.at++; return list.at; };

// the scan's setup loops step every this many rows, so a whole-library pass hands the thread back as it goes
const SETUP_STEP = 1000;

// the scan's near-spelling candidates: a key's rarest bigrams at the lengths that can reach the name arm's 0.7 (lossless for bigramFloor)
function* fuzzyNameIndexSteps(rows) {
    const freq = new Map();
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        row.grams = row.own.filter(v => v.length >= 3).map(v => ({ v, len: v.length, occ: bigramOccurrences(v) }));
        for (const g of row.grams) for (const o of g.occ) freq.set(o, (freq.get(o) || 0) + 1);
        if (i % SETUP_STEP === 0) yield;
    }
    const rank = new Map([...freq.keys()].sort((x, y) => (freq.get(x) - freq.get(y)) || (x < y ? -1 : 1)).map((o, k) => [o, k]));
    yield;
    const byLength = new Map();
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (i % SETUP_STEP === 0) yield;
        for (const g of row.grams) {
            g.ids = Int32Array.from(g.occ, o => rank.get(o)).sort();
            g.prefix = Math.max(0, g.ids.length - lowestBigramFloor(g.len) + 1);
            g.reach = similarNameLengths(g.len);
            let byRare = byLength.get(g.len);
            if (!byRare) byLength.set(g.len, byRare = new Map());
            for (let k = 0; k < g.prefix; k++) fileRow(byRare, g.ids[k], i);
            g.occ = null;
        }
    }
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
    // the rows after i a name could reach by spelling; exact names and word prefixes have their own maps in the scan
    return (i, add) => {
        const a = rows[i];
        let work = 0;
        for (const ga of a.grams) {
            for (let len = ga.reach[0]; len <= ga.reach[1]; len++) {
                const byRare = byLength.get(len);
                if (!byRare) continue;
                for (let k = 0; k < ga.prefix; k++) {
                    const list = byRare.get(ga.ids[k]);
                    if (!list) continue;
                    for (let at = pastRow(list, i); at < list.rows.length; at++) {
                        const j = list.rows[at];
                        work++;
                        if (reaches(a, rows[j])) add(j);
                    }
                }
            }
        }
        return work;
    };
}

/** The scan's lists over every fingerprint: the rows in name order, filed by key, stem, band and author, and the near-spelling index. */
function* scanSetupSteps(db, prints, judge) {
    // a card's provider page titles are names of it too, read in one pass of the link rows
    const titles = allListingTitles(db);
    yield;
    for (let i = 0; i < prints.length; i += SETUP_STEP) {
        const page = prints.slice(i, i + SETUP_STEP);
        judge.knowTitles(titles, page.map(p => p.id));
        judge.remember(page);
        yield;
    }
    const rows = new Array(prints.length);
    for (let i = 0; i < prints.length; i++) {
        const p = prints[i];
        const print = judge.print(p.id);
        // its own names relate exactly, as a word and by spelling; its listing titles to an own name exactly only
        rows[i] = { p, own: ownKeysOf(print), titles: print.listingKeys || [], sortKey: String(p.name || '').toLowerCase() };
        if (i % SETUP_STEP === 0) yield;
    }
    // name order, as the reader reads the list: the first of a group is its reference
    rows.sort((x, y) => (x.sortKey < y.sortKey ? -1 : x.sortKey > y.sortKey ? 1 : x.p.id < y.p.id ? -1 : 1));
    yield;
    // each list read past the row being probed, so a large name bucket stays linear to walk
    const byKey = new Map(), byTitle = new Map(), byShorter = new Map(), byBand = new Map(), byAuthor = new Map();
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        for (const key of row.own) {
            fileRow(byKey, key, i);
            // a longer name finds this one through the words it begins with
            for (const stem of namePrefixesOf(key)) fileRow(byShorter, stem, i);
        }
        for (const key of row.titles) fileRow(byTitle, key, i);
        row.p.bands?.forEach((b, k) => fileRow(byBand, k * 65536 + b, i));
        // an author's own cards, for one renamed with its description reworded
        if (row.p.creatorKey && row.p.mask & 1) fileRow(byAuthor, row.p.creatorKey, i);
        if (i % SETUP_STEP === 0) yield;
    }
    const fuzzy = yield* fuzzyNameIndexSteps(rows);
    return { rows, byKey, byTitle, byShorter, byBand, byAuthor, fuzzy };
}

async function runScan(db) {
    const started = Date.now();
    // a whole-library read wants every card fingerprinted: a write outside the funnel is caught up first (the background drain shared)
    await drainFingerprints(db);
    const prints = await runSteps(allFingerprintSteps(db), { alive: () => db.open });
    if (!prints) throw httpError(503, 'the library closed while the scan ran');
    const judge = pairJudge(db);
    const setup = await runSteps(scanSetupSteps(db, prints, judge), { alive: () => db.open });
    if (!setup) throw httpError(503, 'the library closed while the scan ran');
    const { rows, byKey, byTitle, byShorter, byBand, byAuthor, fuzzy } = setup;

    const groups = [];
    const processed = new Uint8Array(rows.length);
    const seen = new Int32Array(rows.length);
    // each grouped row's group, so a card paired late can join the group of the card it is a copy of
    const groupOf = new Map();
    // the pairs whose own names do not relate (a renamed card, a card known by the other's listing title), grouped after the name pass
    const later = [];
    // one provider path is one card imported twice: those group first at 100 and the passes below leave them
    const indexOf = new Map(rows.map((r, i) => [r.p.id, i]));
    for (const link of providerPathGroups(db)) {
        const members = link.charIds.map(id => indexOf.get(id)).filter(i => i !== undefined && !processed[i]).sort((x, y) => x - y);
        if (members.length < 2) continue;
        for (const i of members) processed[i] = 1;
        const group = {
            reference: rows[members[0]].p.id,
            // one page imported twice: 100 whatever changed since, its identity flags the rule's (the safe-delete notice, Exact mode)
            duplicates: members.slice(1).map(i => ({
                id: rows[i].p.id, confidence: 'high', score: 100, breakdown: { providerPath: 100 },
                ...identityOf(judge.judge(rows[members[0]].p.id, rows[i].p.id)),
                matchReason: `Same ${link.providerId} character (one provider path)`, matchReasons: [],
            })),
            confidence: 'high',
        };
        groups.push(group);
        for (const i of members) groupOf.set(i, group);
    }

    // the thread is shared with every request, so the scan yields by the work it has done
    let work = 0;
    const YIELD_EVERY = 20000;
    for (let i = 0; i < rows.length; i++) {
        if (work >= YIELD_EVERY) { work = 0; await nextTurn(); }
        work++;
        if (processed[i]) continue;
        const stamp = i + 1;
        const candidates = [];
        const add = (j) => { if (j > i && seen[j] !== stamp) { seen[j] = stamp; candidates.push(j); } };
        const row = rows[i];
        const walk = (list, keep = null) => {
            if (!list) return;
            for (let at = pastRow(list, i); at < list.rows.length; at++) { work++; if (!keep || keep(list.rows[at])) add(list.rows[at]); }
        };
        for (const key of row.own) {
            walk(byKey.get(key));
            walk(byTitle.get(key));
            walk(byShorter.get(key));
            for (const stem of namePrefixesOf(key)) walk(byKey.get(stem));
        }
        for (const key of row.titles) walk(byKey.get(key));
        const twin = (j) => { const d = descriptionDistance(row.p, rows[j].p); return d !== null && d <= TWIN_BITS; };
        row.p.bands?.forEach((b, k) => walk(byBand.get(k * 65536 + b), twin));
        if (row.p.mask & 1) walk(byAuthor.get(row.p.creatorKey), (j) => mayBeRenamed(row.p, rows[j].p));
        work += fuzzy(i, add);

        const duplicates = [];
        for (const j of candidates.sort((x, y) => x - y)) {
            if (processed[j]) continue;
            const v = judge.judge(row.p.id, rows[j].p.id);
            work += 5;
            if (!isDuplicate(v)) continue;
            // it waits for the name pass, so it never takes a card from the namesakes it is a copy of, nor leads them
            if (!v.ownName) later.push([i, j]);
            else duplicates.push({ j, ...answerOf(rows[j].p.id, v) });
        }
        if (!duplicates.length) continue;
        processed[i] = 1;
        const group = { reference: row.p.id, duplicates, confidence: null };
        groupOf.set(i, group);
        for (const d of duplicates) { processed[d.j] = 1; groupOf.set(d.j, group); delete d.j; }
        groups.push(group);
    }
    // the later pairs, in scan order: two cards left alone make a group, one left alone joins the other's if that group's reference relates
    for (const [i, j] of later) {
        if (processed[i] && processed[j]) continue;
        if (!processed[i] && !processed[j]) {
            const v = judge.judge(rows[i].p.id, rows[j].p.id);
            const group = { reference: rows[i].p.id, duplicates: [answerOf(rows[j].p.id, v)], confidence: null };
            processed[i] = processed[j] = 1;
            groupOf.set(i, group);
            groupOf.set(j, group);
            groups.push(group);
            continue;
        }
        const [grouped, alone] = processed[i] ? [i, j] : [j, i];
        const group = groupOf.get(grouped);
        const v = group && judge.judge(group.reference, rows[alone].p.id);
        if (!isDuplicate(v)) continue;
        group.duplicates.push(answerOf(rows[alone].p.id, v));
        processed[alone] = 1;
        groupOf.set(alone, group);
    }
    for (const group of groups) {
        group.duplicates.sort((x, y) => y.score - x.score);
        group.confidence = groupConfidence(group.duplicates);
    }

    const order = { high: 0, medium: 1, low: 2 };
    groups.sort((x, y) => {
        const c = order[x.confidence] - order[y.confidence];
        if (c !== 0) return c;
        return Math.max(...y.duplicates.map(d => d.score)) - Math.max(...x.duplicates.map(d => d.score));
    });
    return { groups, scanned: rows.length, ms: Date.now() - started };
}

/**
 * One incoming card against the library (link, name, creator and description arms), every candidate the rule scores, best first.
 * @param {object} probe { name, creator, fullPath, externalId, providerId, definition: { description, first_mes, personality, scenario, creator_notes } }
 */
export function matchCharacter(db, probe) {
    return finishSteps(matchCharacterSteps(db, probe));
}

/** The same match as steps: the link arm, the namesakes, the creator's cards, the description's twins, each candidate's card (runSteps drives it). */
export function* matchCharacterSteps(db, probe) {
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
    const judge = pairJudge(db);
    const nameStmt = db.prepare('SELECT name FROM characters WHERE id = ?').pluck();
    const nameOf = (id) => nameStmt.get(id) || '';

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
        yield;
    }

    // its own listing: a namesake linked to another listing on that site is another card unless the text says otherwise
    const own = { print: cardFingerprint(fields), card: prepareCard(fields), links: probe.providerId && keys.length ? [listingOf(probe.providerId, ...keys)] : [] };
    const candidates = new Set();
    const take = (rows) => { judge.remember(rows); for (const r of rows) candidates.add(r.id); };
    const [namesakes] = yield* nameHolderSteps(db, [fields.name]);
    take(namesakes);
    // a creator the probe begins: its cards the gate lets through (a respelled name, the probe renamed) are candidates too
    take(creatorHolders(db, own.print.creatorKey).filter(r => worthScoring(own.print, r)));
    yield;
    take(descriptionTwins(db, own.print));
    yield;
    for (const id of candidates) {
        if (taken.has(id)) continue;
        const v = judge.judgeAgainst(own, id);
        yield;
        if (!isDuplicate(v)) continue;
        taken.add(id);
        matches.push({ id, name: nameOf(id), ...answerOf(id, v) });
    }
    matches.sort((x, y) => y.score - x.score);
    return matches;
}

/**
 * One remote card's hint over its namesakes: its text, its twin under another name, and its own site's other listings weighed.
 * @param {{ name: string, creator?: string, text?: string, providers?: string[], key?: string }} hit
 * @returns {{ score: number, basis: ''|'otherListing' }}
 */
export function hintForNamesakes(db, hit, matches, heads = null) {
    // the site's text the same as a library card's description, under any name
    const textPrint = hit?.text ? cardFingerprint({ description: hit.text }) : null;
    const renamedText = !!textPrint?.bands && descriptionTwins(db, textPrint).length > 0;
    let listings = null;
    const hitLinks = hit?.key ? (hit.providers || []).map(p => listingOf(p, hit.key)) : [];
    if (hitLinks.length && matches.length) {
        const held = listingsOf(db, matches.map(m => m.id));
        const apart = matches.filter(m => differentListings(hitLinks, held.get(m.id) || [])).map(m => m.id);
        if (apart.length) {
            const notes = creatorNotesOf(db, apart, HINT_TEXT_MAX);
            listings = new Map(apart.map(id => [id, publicTextVerdict(hit.text, notes.get(id))]));
        }
    }
    return hintScore({ name: hit.name, creator: hit?.creator, text: hit?.text }, matches, { renamedText, textPrint, heads, listings });
}

/**
 * The browse hint (POST /characters/match): per remote card, the namesakes graded by the rule and how likely it is already here.
 * @param {Array<{ name: string, creator?: string, text?: string, providers?: string[], key?: string }>} hits providers and key: its listing
 */
export function matchNamesForHint(db, hits) {
    return finishSteps(matchNamesForHintSteps(db, hits));
}

/** The same probe as steps, a name's lookups at a time, each distinct name's namesakes read once (runSteps drives it). */
export function* matchNamesForHintSteps(db, hits) {
    const out = [];
    const byName = new Map(), cutByName = new Map();
    for (const hit of hits) {
        const name = typeof hit?.name === 'string' ? hit.name.trim() : '';
        let graded = byName.get(name);
        if (!graded) {
            const [rows] = yield* nameHolderSteps(db, [name]);
            byName.set(name, graded = gradeNameMatches(name, rows));
            yield;
        }
        // a text the route cut is read against its namesakes' long fields cut the same way
        const cut = typeof hit?.text === 'string' && hit.text.length >= HINT_TEXT_MAX;
        if (cut && !cutByName.has(name)) { cutByName.set(name, cutFieldPrints(db, graded.matches.map(m => m.id), HINT_TEXT_MAX)); yield; }
        const { score, basis } = hintForNamesakes(db, { ...hit, name }, graded.matches, cut ? cutByName.get(name) : null);
        out.push({
            variants: graded.variants,
            matches: graded.matches.slice(0, HINT_MATCHES).map(m => ({ id: m.id, name: m.name, creator: m.creator, relation: m.relation, on: m.on, as: m.as })),
            total: graded.matches.length,
            score,
            ...(basis ? { basis } : {}),
        });
        yield;
    }
    return out;
}

/**
 * A site's search hits against one library card (POST /characters/{id}/link-match), each judged by the rule, ranked.
 * @param {Array<{ name: string, creator?: string, text?: string, listingName?: string }>} hits
 * @returns {{ ranked: Array<{ index: number, score: number, confidence: string|null, confident: boolean, matchReason: string }>, best: number|null }|null} null when the card is gone
 */
export function* matchLinkHitsSteps(db, id, hits) {
    const local = pairJudge(db).card(id);
    if (!local) return null;
    const ranked = [];
    for (let i = 0; i < hits.length; i++) {
        ranked.push({ index: i, ...linkVerdict(local, hits[i]) });
        if (i % 50 === 49) yield;
    }
    // confident first, the author's own listing before a repost, the name as written before a suffixed one, then the score, then the site's order
    ranked.sort((a, b) => (b.confident - a.confident) || (b.sameAuthor - a.sameAuthor) || (b.literalName - a.literalName) || (b.score - a.score) || (a.index - b.index));
    return { ranked, best: ranked[0]?.confident ? ranked[0].index : null };
}
