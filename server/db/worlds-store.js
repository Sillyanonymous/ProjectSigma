import { countBindings, headCarriersOf, worldExists } from './world-links-store.js';
import { emitChange, reportCharactersUpdated } from './changes.js';
import { rewritePresetRules, PRESET_LOREBOOK_FIELDS } from './documents-store.js';
import { encodeCursor, decodeCursor } from './cursor.js';
import { caseFold, ftsWordsQuery, textMatch } from './rule-filters.js';
import { entryUid } from '../lib/world-entry.js';
import { httpError } from '../lib/http-error.js';

// Worlds are rows + entry rows; the ST-shaped doc ({ entries: {uid: entry}, ...meta })
// exists only as a compose/decompose view for interchange and the whole-doc PUT.

// an entry keeps its row (and its id, the search index's key) across writes; an unchanged one is not written at all
const ENTRY_UPSERT_SQL = `INSERT INTO world_entries (world_name, uid, data) VALUES (?, ?, ?)
    ON CONFLICT(world_name, uid) DO UPDATE SET data = excluded.data WHERE data IS NOT excluded.data`;

/** A world written whole; expect 'absent' refuses a taken name (any case), 'placeholder' a filled book. false when refused. */
export function upsertWorld(db, name, data, { imported = false, expect = null } = {}) {
    const now = Date.now();
    const doc = data && typeof data === 'object' ? data : {};
    const entries = doc.entries && typeof doc.entries === 'object' ? doc.entries : {};
    const meta = { ...doc };
    delete meta.entries;

    // every entry gets a numeric uid: ST keys pass through, foreign keys (uuid strings) remap onto free uids in key order
    const resolved = [];
    const pending = [];
    for (const [key, entry] of Object.entries(entries)) {
        const uid = entryUid(key, entry);
        if (Number.isFinite(uid)) resolved.push([uid, entry]);
        else pending.push(entry);
    }
    let next = resolved.reduce((m, [u]) => Math.max(m, u), -1) + 1;
    for (const entry of pending) {
        resolved.push([next, { ...entry, uid: next }]);
        next++;
    }

    // entry_count and the rows land together, counted from the ROWS so duplicate uids cant inflate it
    return db.transaction(() => {
        if (expect === 'absent' && db.prepare('SELECT 1 FROM worlds WHERE name = ? COLLATE NOCASE').get(name)) return false;
        if (expect === 'placeholder' && db.prepare('SELECT placeholder FROM worlds WHERE name = ?').get(name)?.placeholder !== 1) return false;
        const existed = worldExists(db, name);
        // created_at is the first write's stamp and never moves after; a placeholder filled
        // in place keeps the mint's
        db.prepare(`
            INSERT INTO worlds (name, data, entry_count, imported_at, created_at, updated_at)
            VALUES (?, ?, 0, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                data = excluded.data,
                imported_at = COALESCE(excluded.imported_at, worlds.imported_at),
                updated_at = excluded.updated_at,
                placeholder = 0
        `).run(name, JSON.stringify(meta), imported ? now : null, now, now);

        // the doc replaces the entry set: the uids it does not hold go, the rest are written over (the last of a duplicate wins)
        db.prepare('DELETE FROM world_entries WHERE world_name = ? AND uid NOT IN (SELECT value FROM json_each(?))').run(name, JSON.stringify(resolved.map(([uid]) => uid)));
        const write = db.prepare(ENTRY_UPSERT_SQL);
        for (const [uid, entry] of resolved) write.run(name, uid, JSON.stringify(entry));
        // the stamp the row was just inserted with: one write, one timestamp
        bumpWorld(db, name, now);
        emitChange(db, { entity: 'world', op: existed ? 'updated' : 'created', ids: [name] });
        return true;
    })();
}

// a shelf row as every list answers it: the summary, its source, and its reach counted per kind when asked
const worldSummary = (r) => ({
    name: r.name, entryCount: r.entry_count, importedAt: r.imported_at, createdAt: r.created_at, updatedAt: r.updated_at, placeholder: !!r.placeholder,
    source: r.src_provider ? { provider: r.src_provider, externalId: r.src_external_id, path: r.src_path, url: r.src_url, linkedAt: r.src_linked_at } : null,
    ...(r.n_chars === undefined ? {} : { chars: r.n_chars, chats: r.n_chats, global: !!r.n_global, personas: r.n_personas }),
});
const WORLD_COLUMNS = `SELECT w.name, w.entry_count, w.imported_at, w.created_at, w.updated_at, w.placeholder,
            s.provider AS src_provider, s.external_id AS src_external_id, s.path AS src_path, s.url AS src_url, s.linked_at AS src_linked_at`;
// each binding table's count for the row, on its world_name index: a page costs its own books' bindings
const WORLD_COUNT_COLUMNS = `,
            (SELECT COUNT(*) FROM char_worlds b WHERE b.world_name = w.name) AS n_chars,
            (SELECT COUNT(*) FROM chat_worlds b WHERE b.world_name = w.name) AS n_chats,
            EXISTS (SELECT 1 FROM global_worlds b WHERE b.world_name = w.name) AS n_global,
            (SELECT COUNT(*) FROM persona_worlds b WHERE b.world_name = w.name) AS n_personas`;

export function listWorlds(db) {
    return db.prepare(`${WORLD_COLUMNS}
        FROM worlds w LEFT JOIN world_sources s ON s.world_name = w.name ORDER BY w.name COLLATE NOCASE`)
        .all()
        .map(worldSummary);
}

/**
 * The page queryWorlds runs, exported so its plan can be read: NOCASE name order, the rowid breaking case-only ties, past [name, rowid].
 * @returns {{ sql: string, params: any[], countSql: string, countParams: any[] }}
 */
export function worldPageQuery({ q, limit, after, counts = false, placeholders = true }) {
    const conds = [];
    const params = [];
    if (!placeholders) conds.push('w.placeholder = 0');
    if (q) { const m = textMatch('w.name', q); conds.push(m.sql); params.push(...m.params); }
    const countSql = `SELECT COUNT(*) n FROM worlds w${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''}`;
    const countParams = [...params];
    if (after !== undefined) {
        const cur = decodeCursor(after, 2, { intLast: true });
        if (!cur) throw httpError(400, 'invalid after cursor');
        conds.push('w.name >= ? COLLATE NOCASE AND (w.name > ? COLLATE NOCASE OR w.rowid > ?)');
        params.push(cur[0], cur[0], cur[1]);
    }
    const sql = `${WORLD_COLUMNS}, w.rowid AS rid${counts ? WORLD_COUNT_COLUMNS : ''}
        FROM worlds w LEFT JOIN world_sources s ON s.world_name = w.name${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''}
        ORDER BY w.name COLLATE NOCASE, w.rowid LIMIT ?`;
    return { sql, params: [...params, limit], countSql, countParams };
}

/**
 * A page of the shelf in NOCASE name order past a cursor; q narrows by name, counts adds reach, placeholders: false drops them.
 * @returns {{ items: object[], total: number|null, limit: number, nextCursor: string|null }}
 */
export function queryWorlds(db, { q, limit, after, counts = false, placeholders = true, count = true }) {
    const { sql, params, countSql, countParams } = worldPageQuery({ q, limit, after, counts, placeholders });
    const rows = db.prepare(sql).all(...params);
    const total = count === false ? null : db.prepare(countSql).get(...countParams).n;
    const last = rows[rows.length - 1];
    return { items: rows.map(worldSummary), total, limit, nextCursor: rows.length === limit ? encodeCursor([last.name, last.rid]) : null };
}

// where a book came from (world_sources): one row per world, its FK riding a rename and a delete

/** @returns {{provider: string, externalId: string, path: string|null, url: string|null, linkedAt: number}|null} */
function getWorldSource(db, name) {
    const r = db.prepare('SELECT provider, external_id, path, url, linked_at FROM world_sources WHERE world_name = ?').get(name);
    return r ? { provider: r.provider, externalId: r.external_id, path: r.path, url: r.url, linkedAt: r.linked_at } : null;
}

/**
 * Record or replace where a world came from; onlyIfMissing never overwrites a source the world has.
 * @returns {{ok: true, written: boolean}|null} null when the world does not exist
 */
export function setWorldSource(db, name, { provider, externalId, path = null, url = null }, { onlyIfMissing = false } = {}) {
    return db.transaction(() => {
        if (!worldExists(db, name)) return null;
        if (onlyIfMissing && getWorldSource(db, name)) return { ok: true, written: false };
        const now = Date.now();
        db.prepare(`INSERT INTO world_sources (world_name, provider, external_id, path, url, linked_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(world_name) DO UPDATE SET provider = excluded.provider, external_id = excluded.external_id, path = excluded.path, url = excluded.url, linked_at = excluded.linked_at`)
            .run(name, String(provider), String(externalId), path == null ? null : String(path), url == null ? null : String(url), now);
        // a world's stamp moves on every write to it, its provenance included
        db.prepare('UPDATE worlds SET updated_at = ? WHERE name = ?').run(now, name);
        emitChange(db, { entity: 'world', op: 'updated', ids: [name], fields: ['source'] });
        return { ok: true, written: true };
    })();
}

/**
 * The shelf probe: which of a provider's keys (external ids, or paths case folded) name a book on the shelf.
 * @returns {string[]} the keys found, in input order
 */
export function probeWorldSources(db, { provider, keys }) {
    const wanted = [...new Set((keys || []).map(String))];
    if (!wanted.length || !provider) return [];
    const found = new Set(db.prepare(`
        SELECT k.value AS key FROM json_each(?) k
        WHERE EXISTS (SELECT 1 FROM world_sources s WHERE s.provider = ? AND s.external_id = k.value)
           OR EXISTS (SELECT 1 FROM world_sources s WHERE s.provider = ? AND s.path = k.value COLLATE NOCASE)`)
        .all(JSON.stringify(wanted), String(provider), String(provider)).map(r => r.key));
    return wanted.filter(k => found.has(k));
}


// the carrier search's rows per arm and form, unless asked, and the most it answers
export const CARRIERS_DEFAULT = 200;
export const CARRIERS_MAX = 1000;

/**
 * The shelf's search by who a book binds: characters, chats (own or character name) or personas whose name begins with prefix.
 * @returns {Array<{ name: string, matches: string[] }>}
 */
export function searchWorldCarriers(db, prefix, { limit = CARRIERS_DEFAULT } = {}) {
    const typed = String(prefix ?? '').trim();
    if (!typed) return [];
    const cap = Math.max(1, Math.min(CARRIERS_MAX, Number(limit) || CARRIERS_DEFAULT));
    const byWorld = new Map();
    const add = (world, label) => {
        if (!byWorld.has(world)) byWorld.set(world, new Set());
        byWorld.get(world).add(label);
    };
    // NOCASE folds ASCII alone: past it, a range per case of the first letter, each name's letters then matched by their cases
    const fold = caseFold(typed);
    const cased = (col) => (fold ? ` AND ${col} GLOB ?` : '');
    const chars = db.prepare(`SELECT cw.world_name, ch.name FROM characters ch INDEXED BY idx_characters_name_id
            JOIN char_worlds cw ON cw.char_id = ch.id
            WHERE ch.name >= ? COLLATE NOCASE AND ch.name < ? COLLATE NOCASE${cased('ch.name')} LIMIT ?`);
    const chats = db.prepare(`SELECT cw.world_name, ct.name, ch.name AS char_name FROM chats ct INDEXED BY idx_chats_name
            JOIN chat_worlds cw ON cw.chat_id = ct.id
            LEFT JOIN characters ch INDEXED BY idx_characters_id_name ON ch.id = ct.char_id
            WHERE ct.name >= ? COLLATE NOCASE AND ct.name < ? COLLATE NOCASE${cased('ct.name')} LIMIT ?`);
    const charChats = db.prepare(`SELECT cw.world_name, ct.name, ch.name AS char_name FROM characters ch INDEXED BY idx_characters_name_id
            JOIN chats ct INDEXED BY idx_chats_char_sort ON ct.char_id = ch.id
            JOIN chat_worlds cw ON cw.chat_id = ct.id
            WHERE ch.name >= ? COLLATE NOCASE AND ch.name < ? COLLATE NOCASE${cased('ch.name')} LIMIT ?`);
    const personas = db.prepare(`SELECT pw.world_name, pe.name FROM personas pe JOIN persona_worlds pw ON pw.persona_id = pe.id
            WHERE pe.name >= ? COLLATE NOCASE AND pe.name < ? COLLATE NOCASE${cased('pe.name')} LIMIT ?`);
    for (const lo of fold ? fold.starts : [typed]) {
        const hi = `${lo}\uffff`;
        const args = fold ? [lo, hi, `${fold.glob}*`, cap] : [lo, hi, cap];
        for (const r of chars.all(...args)) add(r.world_name, r.name);
        for (const r of chats.all(...args)) add(r.world_name, `${r.char_name || '?'}: ${r.name}`);
        for (const r of charChats.all(...args)) add(r.world_name, `${r.char_name || '?'}: ${r.name}`);
        for (const r of personas.all(...args)) add(r.world_name, `${r.name} (persona)`);
    }
    return [...byWorld.entries()].map(([name, matches]) => ({ name, matches: [...matches] }));
}

// the entry search's page, unless asked, the most it answers, and the newest matches it ranks
export const ENTRY_SEARCH_DEFAULT = 50;
export const ENTRY_SEARCH_MAX = 500;
export const ENTRY_SEARCH_RANKED = 10000;

// ranked among the newest matches alone, the marks read for the page's rows alone, each row reached by its id
export const ENTRY_SEARCH_SQL = `
        WITH hit AS (SELECT rowid AS rid, bm25(world_entries_fts, 4.0, 1.0) AS rk FROM world_entries_fts
                     WHERE world_entries_fts MATCH @match ORDER BY rowid DESC LIMIT @ranked),
             page AS (SELECT rid, rk FROM hit ORDER BY rk, rid LIMIT @lim OFFSET @off)
        SELECT e.world_name, e.uid, e.comment, e.enabled, json_extract(e.data, '$.key[0]') AS first_key,
               (SELECT highlight(world_entries_fts, 0, '<mark>', '</mark>') FROM world_entries_fts
                WHERE world_entries_fts MATCH @match AND rowid = page.rid) AS title_mark,
               (SELECT snippet(world_entries_fts, 1, '<mark>', '</mark>', '…', 14) FROM world_entries_fts
                WHERE world_entries_fts MATCH @match AND rowid = page.rid) AS snip
        FROM page JOIN world_entries e ON e.id = page.rid
        ORDER BY page.rk, page.rid
`;

/**
 * Every book's entries whose title or content hold each word typed (each a prefix), the best first; a title weighs four times its content.
 * @returns {{items: object[], total: number|null, limit: number, offset: number, capped: boolean}}
 */
export function searchWorldEntries(db, { q, limit = ENTRY_SEARCH_DEFAULT, offset = 0, count = true } = {}) {
    const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, ENTRY_SEARCH_MAX) : ENTRY_SEARCH_DEFAULT;
    const off = Number.isInteger(offset) && offset > 0 ? offset : 0;
    const match = ftsWordsQuery(q);
    // a text of no words matches nothing, rather than every entry
    if (!match) return { items: [], total: count === false ? null : 0, limit: lim, offset: off, capped: false };
    const total = count === false ? null : db.prepare('SELECT COUNT(*) n FROM world_entries_fts WHERE world_entries_fts MATCH ?').get(match).n;
    const capped = total !== null ? total > ENTRY_SEARCH_RANKED
        : db.prepare('SELECT COUNT(*) n FROM (SELECT 1 FROM world_entries_fts WHERE world_entries_fts MATCH ? LIMIT ?)').get(match, ENTRY_SEARCH_RANKED + 1).n > ENTRY_SEARCH_RANKED;
    const items = db.prepare(ENTRY_SEARCH_SQL).all({ match, ranked: ENTRY_SEARCH_RANKED, lim, off }).map(r => ({
        world: r.world_name,
        uid: r.uid,
        title: typeof r.comment === 'string' ? r.comment : '',
        titleMarked: typeof r.title_mark === 'string' ? r.title_mark : '',
        firstKey: typeof r.first_key === 'string' ? r.first_key : null,
        snippet: typeof r.snip === 'string' ? r.snip : '',
        enabled: r.enabled === 1,
    }));
    return { items, total, limit: lim, offset: off, capped };
}

// the two id-to-name reads of a book's reach; INDEXED BY since the planner never rates (id, name) covering on a generated column
export const WORLD_USAGE_SQL = {
    chars: `SELECT cw.char_id AS id, ch.name FROM char_worlds cw
            LEFT JOIN characters ch INDEXED BY idx_characters_id_name ON ch.id = cw.char_id
            WHERE cw.world_name = ? ORDER BY cw.pos`,
    chats: `SELECT ct.id, ct.name, ct.char_id AS charId, ch.name AS charName FROM chat_worlds cw JOIN chats ct ON ct.id = cw.chat_id
            LEFT JOIN characters ch INDEXED BY idx_characters_id_name ON ch.id = ct.char_id
            WHERE cw.world_name = ? ORDER BY ct.sort_at DESC`,
};

/** One world's whole reach by its name (every binding table indexes it); null when there is no such world. */
export function worldUsageOf(db, name) {
    const w = db.prepare('SELECT name, entry_count, imported_at, created_at, updated_at, placeholder FROM worlds WHERE name = ?').get(name);
    if (!w) return null;
    return {
        name: w.name, missing: false, placeholder: !!w.placeholder, entryCount: w.entry_count,
        importedAt: w.imported_at, createdAt: w.created_at, updatedAt: w.updated_at,
        chars: db.prepare(WORLD_USAGE_SQL.chars).all(w.name),
        chats: db.prepare(WORLD_USAGE_SQL.chats).all(w.name),
        global: !!db.prepare('SELECT 1 FROM global_worlds WHERE world_name = ?').get(w.name),
        personas: db.prepare(`SELECT pw.persona_id AS id, pe.name FROM persona_worlds pw JOIN personas pe ON pe.id = pw.persona_id
            WHERE pw.world_name = ? ORDER BY pw.pos`).all(w.name),
    };
}

/**
 * Delete a world, its entries and bindings following by FK cascade, a preset rule naming it going too.
 * @returns {{ unbound: number }|null} null when there was no such world
 */
export function deleteWorld(db, name) {
    return db.transaction(() => {
        if (!worldExists(db, name)) return null;
        const unbound = countBindings(db, name);
        const heads = headCarriersOf(db, name);
        db.prepare('DELETE FROM worlds WHERE name = ?').run(name);
        rewritePresetRules(db, PRESET_LOREBOOK_FIELDS, name, null);
        emitChange(db, { entity: 'world', op: 'deleted', ids: [name] });
        // the cascade took their head book, so the next one is their extensions.world now
        if (heads.length) reportCharactersUpdated(db, heads, ['extensions.world']);
        return { unbound };
    })();
}

export function getWorld(db, name) {
    const row = db.prepare('SELECT * FROM worlds WHERE name = ?').get(name);
    if (!row) return null;
    const meta = JSON.parse(row.data);
    const entries = {};
    for (const e of db.prepare('SELECT uid, data FROM world_entries WHERE world_name = ? ORDER BY uid').all(name)) {
        entries[String(e.uid)] = JSON.parse(e.data);
    }
    return { name: row.name, data: { ...meta, entries }, entryCount: row.entry_count, updatedAt: row.updated_at, placeholder: !!row.placeholder, source: getWorldSource(db, name) };
}

// a placeholder stops being one once it holds an entry; emptying a real book never re-flags it
function bumpWorld(db, name, now = Date.now()) {
    db.prepare(`UPDATE worlds SET entry_count = (SELECT COUNT(*) FROM world_entries WHERE world_name = ?), updated_at = ?,
        placeholder = CASE WHEN (SELECT COUNT(*) FROM world_entries WHERE world_name = ?) > 0 THEN 0 ELSE placeholder END
        WHERE name = ?`).run(name, now, name, name);
}

/**
 * One entry as stored, without composing the book around it.
 * @returns {object|null} null when the world, the entry or a readable blob is missing
 */
export function getWorldEntry(db, name, uid) {
    const row = db.prepare('SELECT data FROM world_entries WHERE world_name = ? AND uid = ?').get(name, uid);
    if (!row) return null;
    try { return JSON.parse(row.data); } catch { return null; }
}

/** Write one entry, merging over whats stored: absent keeps a field, null or empty clears it (ST's "inherit the global"). */
export function upsertWorldEntry(db, name, uid, entry) {
    if (!worldExists(db, name)) return false;
    const existing = getWorldEntry(db, name, uid);
    const data = { ...(existing || {}), ...entry, uid };
    db.transaction(() => {
        db.prepare(ENTRY_UPSERT_SQL).run(name, uid, JSON.stringify(data));
        bumpWorld(db, name);
        emitChange(db, { entity: 'worldEntry', op: existing ? 'updated' : 'created', world: name, ids: [uid] });
    })();
    return true;
}

export function createWorldEntry(db, name, entry) {
    if (!worldExists(db, name)) return null;
    return db.transaction(() => {
        const next = db.prepare('SELECT COALESCE(MAX(uid) + 1, 0) AS uid FROM world_entries WHERE world_name = ?').get(name).uid;
        upsertWorldEntry(db, name, next, entry);
        return next;
    })();
}

export function deleteWorldEntry(db, name, uid) {
    return db.transaction(() => {
        const changed = db.prepare('DELETE FROM world_entries WHERE world_name = ? AND uid = ?').run(name, uid).changes > 0;
        if (changed) {
            bumpWorld(db, name);
            emitChange(db, { entity: 'worldEntry', op: 'deleted', world: name, ids: [uid] });
        }
        return changed;
    })();
}
