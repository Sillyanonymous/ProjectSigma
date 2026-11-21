// Each card's fingerprint (name keys, creator key, content signature, description bands): the duplicate rule's index
import { cardFingerprint, cardSignature, nameVariantsForDupe, namePrefixesOf, NAME_SEPARATORS, NAME_PREFIX_MIN, descriptionDistance, TWIN_BITS, listingOf } from '../lib/duplicate-match.js';
import { subscribeChanges } from './changes.js';
import { runSteps, scheduleLibraryJob } from '../lib/steps.js';

const REFRESH_WAIT_MS = 1500;
// queued cards read, computed and written per page: one commit a page, the rows read in their order on disk
const DRAIN_PAGE = 500;

const _stmts = new WeakMap();
function stmts(db) {
    let s = _stmts.get(db);
    if (s) return s;
    const cols = 'f.char_id AS id, f.name_key, f.name_key2, f.creator_key, f.sig, f.sig_mask, f.band0, f.band1, f.band2, f.band3';
    s = {
        upsert: db.prepare(`INSERT INTO character_fingerprints (char_id, name_key, name_key2, creator_key, sig, sig_mask, band0, band1, band2, band3)
            VALUES (@id, @nameKey, @nameKey2, @creatorKey, @sig, @mask, @b0, @b1, @b2, @b3)
            ON CONFLICT(char_id) DO UPDATE SET name_key = excluded.name_key, name_key2 = excluded.name_key2, creator_key = excluded.creator_key,
                sig = excluded.sig, sig_mask = excluded.sig_mask, band0 = excluded.band0, band1 = excluded.band1, band2 = excluded.band2, band3 = excluded.band3`),
        unqueueId: db.prepare('DELETE FROM fingerprints_pending WHERE rid = (SELECT rowid FROM characters WHERE id = ?)'),
        // leaves the queue only if no write queued the card again since it was read
        settle: db.prepare('DELETE FROM fingerprints_pending WHERE rid = ? AND seq = ? RETURNING rid').pluck(),
        anyPending: db.prepare('SELECT EXISTS (SELECT 1 FROM fingerprints_pending)').pluck(),
        pendingPage: db.prepare(`SELECT p.rid, p.seq, c.id, c.name, c.creator, c.description, c.first_mes, c.personality, c.creator_notes
            FROM fingerprints_pending p LEFT JOIN characters c ON c.rowid = p.rid WHERE p.rid > ? ORDER BY p.rid LIMIT ?`),
        byIds: db.prepare(`SELECT ${cols}, c.name, c.creator FROM json_each(?) j JOIN character_fingerprints f ON f.char_id = j.value JOIN characters c ON c.id = f.char_id`),
        byName: db.prepare(`SELECT ${cols}, c.name, c.creator FROM character_fingerprints f JOIN characters c ON c.id = f.char_id WHERE f.name_key = ?
            UNION SELECT ${cols}, c.name, c.creator FROM character_fingerprints f JOIN characters c ON c.id = f.char_id WHERE f.name_key2 = ?`),
        byNameRange: db.prepare(`SELECT ${cols}, c.name, c.creator FROM character_fingerprints f JOIN characters c ON c.id = f.char_id WHERE f.name_key >= ? AND f.name_key < ?
            UNION SELECT ${cols}, c.name, c.creator FROM character_fingerprints f JOIN characters c ON c.id = f.char_id WHERE f.name_key2 >= ? AND f.name_key2 < ?`),
        byListing: db.prepare(`SELECT ${cols}, pl.page_name AS name, c.creator FROM provider_links pl JOIN character_fingerprints f ON f.char_id = pl.char_id
            JOIN characters c ON c.id = pl.char_id WHERE pl.page_name = ? COLLATE NOCASE`),
        byListingRange: db.prepare(`SELECT ${cols}, pl.page_name AS name, c.creator FROM provider_links pl JOIN character_fingerprints f ON f.char_id = pl.char_id
            JOIN characters c ON c.id = pl.char_id WHERE pl.page_name >= ? COLLATE NOCASE AND pl.page_name < ? COLLATE NOCASE`),
        byCreator: db.prepare(`SELECT ${cols} FROM character_fingerprints f WHERE f.creator_key >= ? AND f.creator_key < ?`),
        listingsOf: db.prepare("SELECT pl.char_id AS id, pl.page_name FROM json_each(?) j JOIN provider_links pl ON pl.char_id = j.value WHERE pl.page_name IS NOT NULL AND pl.page_name != ''"),
        allListings: db.prepare("SELECT char_id AS id, page_name FROM provider_links WHERE page_name IS NOT NULL AND page_name != ''"),
        linksOf: db.prepare('SELECT pl.char_id AS id, pl.provider_id, pl.external_id, pl.full_path FROM json_each(?) j JOIN provider_links pl ON pl.char_id = j.value'),
        notesOf: db.prepare('SELECT c.id, substr(c.creator_notes, 1, @max) AS notes FROM json_each(@ids) j JOIN characters c ON c.id = j.value'),
        cutFields: db.prepare(`SELECT c.id, CASE WHEN length(c.description) > @max THEN substr(c.description, 1, @max) END AS description,
            CASE WHEN length(c.first_mes) > @max THEN substr(c.first_mes, 1, @max) END AS first_mes,
            CASE WHEN length(c.creator_notes) > @max THEN substr(c.creator_notes, 1, @max) END AS creator_notes
            FROM json_each(@ids) j JOIN characters c ON c.id = j.value`),
        byBand: [0, 1, 2, 3].map(k => db.prepare(`SELECT ${cols} FROM character_fingerprints f WHERE f.band${k} = ?`)),
        all: db.prepare(`SELECT f.rowid AS rid, ${cols}, c.name, c.creator FROM character_fingerprints f JOIN characters c ON c.id = f.char_id WHERE f.rowid > ? ORDER BY f.rowid LIMIT ?`),
    };
    _stmts.set(db, s);
    return s;
}

// the row a fingerprint answers: its keys, its signature as the rule reads it (unknown, mask -1, while the card waits on the queue)
const rowOf = (r) => ({
    id: r.id, name: r.name, creator: r.creator ?? null, nameKey: r.name_key, nameKey2: r.name_key2, creatorKey: r.creator_key || '',
    sig: r.sig || null, mask: r.sig_mask > 0 ? r.sig_mask : 0, unknown: r.sig_mask < 0,
    bands: r.band0 == null ? null : [r.band0, r.band1, r.band2, r.band3],
});

// the string just past every one that begins with this one followed by sep: an exact range on a binary index
const after = (s, sep) => s + String.fromCharCode(sep.charCodeAt(0) + 1);
// the string just past every one that begins with this one: its last code point raised by one (UTF-8 orders by code point)
const prefixEnd = (s) => { const cps = [...s]; const last = cps.pop().codePointAt(0); return cps.join('') + String.fromCodePoint(last + 1); };

const upsertRow = (s, id, f) => s.upsert.run({ id, nameKey: f.nameKey, nameKey2: f.nameKey2, creatorKey: f.creatorKey || null, sig: f.mask ? f.sig : null, mask: f.mask, b0: f.bands?.[0] ?? null, b1: f.bands?.[1] ?? null, b2: f.bands?.[2] ?? null, b3: f.bands?.[3] ?? null });

/** A card written through the funnel gets its fingerprint in the same transaction, and leaves the queue its trigger put it on. */
export function writeFingerprint(db, id, data) {
    const s = stmts(db);
    upsertRow(s, id, cardFingerprint(data));
    s.unqueueId.run(id);
}

/**
 * Fingerprint every queued card as steps: a page read in rowid order and computed outside any transaction, then written in one.
 * @returns {Generator<undefined, number>} how many it wrote; a card queued again meanwhile waits for the next pass
 */
export function* drainFingerprintSteps(db) {
    const s = stmts(db);
    let done = 0;
    for (let progress = true; progress && s.anyPending.get();) {
        progress = false;
        for (let after = 0; ;) {
            const page = s.pendingPage.all(after, DRAIN_PAGE);
            if (!page.length) break;
            after = page[page.length - 1].rid;
            const computed = [];
            for (const row of page) {
                computed.push({ row, print: row.id == null ? null : cardFingerprint(row) });
                yield;
            }
            db.transaction(() => {
                for (const { row, print } of computed) {
                    if (!s.settle.get(row.rid, row.seq)) continue;
                    progress = true;
                    // a character gone since it was queued just leaves the queue
                    if (print) { upsertRow(s, row.id, print); done++; }
                }
            })();
            yield;
        }
    }
    return done;
}

/** Whether any card waits for its fingerprint. */
export const fingerprintsPending = (db) => !!stmts(db).anyPending.get();

const _draining = new WeakMap();

/** Drain the queue now, a slice at a time; one drain per library, so a scan and the background job share the pages it computes. */
export function drainFingerprints(db) {
    let run = _draining.get(db);
    if (!run) {
        run = runSteps(drainFingerprintSteps(db), { alive: () => db.open }).finally(() => _draining.delete(db));
        _draining.set(db, run);
    }
    return run;
}

/** Drain the queue soon, in the background; a call while one waits joins it. */
export function scheduleFingerprintRefresh(db, wait = REFRESH_WAIT_MS) {
    scheduleLibraryJob(db, 'fingerprints', () => drainFingerprints(db), { wait });
}

// a write from another process, or one outside the funnel, is caught by the next character change here
subscribeChanges((owner, records, db) => {
    if (db && records.some(r => r.entity === 'character')) scheduleFingerprintRefresh(db);
});

// ============================================================================
// THE LOOKUPS (each an index seek; nothing here reads a card)
// ============================================================================

/** The fingerprints of these characters, by id; one missing is a character gone or not yet fingerprinted. */
export function fingerprintsOf(db, ids) {
    const out = new Map();
    const list = [...new Set((ids || []).map(String))];
    for (let i = 0; i < list.length; i += 500) for (const r of stmts(db).byIds.all(JSON.stringify(list.slice(i, i + 500)))) out.set(r.id, rowOf(r));
    return out;
}

/**
 * Who could this be, per name: own or listing names equal to a key, beginning with one as a word, or a word of it.
 * @returns {Generator<undefined, Array<Array<object>>>} rows per name, a listing row named by its page name
 */
export function* nameHolderSteps(db, names) {
    const s = stmts(db);
    const out = [];
    for (const raw of names) {
        const name = typeof raw === 'string' ? raw.trim() : '';
        const keys = nameVariantsForDupe(name);
        const rows = new Map();
        const take = (list, viaListing = false) => { for (const r of list) { const k = `${r.id}|${r.name}`; if (!rows.has(k)) rows.set(k, viaListing ? { ...rowOf(r), viaListing } : rowOf(r)); } };
        for (const key of keys) {
            take(s.byName.all(key, key));
            // a shorter key is no word of a longer name: its ranges would read rows the rule never relates
            if (key.length >= NAME_PREFIX_MIN) for (const sep of NAME_SEPARATORS) take(s.byNameRange.all(key + sep, after(key, sep), key + sep, after(key, sep)));
            for (const shorter of namePrefixesOf(key)) take(s.byName.all(shorter, shorter));
        }
        yield;
        // a title asked as written and by the keys, a longer one by its range (a suffix folds away); the grading keeps exact ones
        for (const probe of new Set([name, ...keys].filter(Boolean))) {
            take(s.byListing.all(probe), true);
            if (probe.length >= NAME_PREFIX_MIN) for (const sep of NAME_SEPARATORS) take(s.byListingRange.all(probe + sep, after(probe, sep)), true);
        }
        out.push([...rows.values()]);
        yield;
    }
    return out;
}

/** Per card, the signature of its fields longer than max cut to max: a site text cut so is read against them as they begin. */
export function cutFieldPrints(db, ids, max) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += 500) {
        for (const r of stmts(db).cutFields.all({ max, ids: JSON.stringify(ids.slice(i, i + 500)) })) {
            if (r.description || r.first_mes || r.creator_notes) out.set(r.id, cardSignature(r));
        }
    }
    return out;
}

/** The fingerprints whose creator key begins with this one (a creator the probe begins), no card read. */
export function creatorHolders(db, key) {
    if (!key || key.length < 3) return [];
    return stmts(db).byCreator.all(key, prefixEnd(key)).map(rowOf);
}

/** The cards whose description is within TWIN_BITS of this signature's: a seek per band, each candidate checked. */
export function descriptionTwins(db, print) {
    if (!print?.bands) return [];
    const s = stmts(db);
    const seen = new Map();
    print.bands.forEach((band, k) => { for (const r of s.byBand[k].all(band)) if (!seen.has(r.id)) seen.set(r.id, rowOf(r)); });
    const probe = { sig: print.sig, mask: print.mask };
    return [...seen.values()].filter(r => { const d = descriptionDistance(probe, r); return d !== null && d <= TWIN_BITS; });
}

/** The titles these characters' provider pages carry, by id (a card is known by them too). */
export function listingTitlesOf(db, ids) {
    const out = new Map();
    const list = [...new Set((ids || []).map(String))];
    for (let i = 0; i < list.length; i += 500) {
        for (const r of stmts(db).listingsOf.all(JSON.stringify(list.slice(i, i + 500)))) {
            if (!out.has(r.id)) out.set(r.id, []);
            out.get(r.id).push(r.page_name);
        }
    }
    return out;
}

/** The listings these characters are linked to, by id, as the listing rule reads them (listingOf). */
export function listingsOf(db, ids) {
    const out = new Map();
    const list = [...new Set((ids || []).map(String))];
    for (let i = 0; i < list.length; i += 500) {
        for (const r of stmts(db).linksOf.all(JSON.stringify(list.slice(i, i + 500)))) {
            if (!out.has(r.id)) out.set(r.id, []);
            out.get(r.id).push(listingOf(r.provider_id, r.external_id, r.full_path));
        }
    }
    return out;
}

/** These characters' creator notes, by id, the first max characters (a listing's public description is read against them). */
export function creatorNotesOf(db, ids, max) {
    const out = new Map();
    const list = [...new Set((ids || []).map(String))];
    for (let i = 0; i < list.length; i += 500) {
        for (const r of stmts(db).notesOf.all({ ids: JSON.stringify(list.slice(i, i + 500)), max })) out.set(r.id, r.notes || '');
    }
    return out;
}

/** Every character's provider page titles, by id (the scan's read: one pass of the link rows). */
export function allListingTitles(db) {
    const out = new Map();
    for (const r of stmts(db).allListings.all()) {
        if (!out.has(r.id)) out.set(r.id, []);
        out.get(r.id).push(r.page_name);
    }
    return out;
}

/** Every fingerprint, a page at a time in table order (the scan's read): never an open iterator, so a write between pages lands. */
export function* allFingerprintSteps(db, page = 2000) {
    const s = stmts(db);
    const out = [];
    for (let after = 0; ;) {
        const rows = s.all.all(after, page);
        if (!rows.length) break;
        for (const r of rows) out.push(rowOf(r));
        after = rows[rows.length - 1].rid;
        if (rows.length < page) break;
        yield;
    }
    return out;
}
