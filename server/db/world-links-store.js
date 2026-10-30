// the four lore-binding scopes as one shape: an ordered list of world names, each an FK to worlds; every writer comes through here
import { emitChange, reportCharactersUpdated, RECORD_IDS_MAX } from './changes.js';
import { httpError } from '../lib/http-error.js';
import { rewritePresetRules, PRESET_LOREBOOK_FIELDS } from './documents-store.js';

const SCOPES = Object.freeze({
    char: { table: 'char_worlds', key: 'char_id', carrier: { table: 'characters', key: 'id', stamp: false } },
    chat: { table: 'chat_worlds', key: 'chat_id', carrier: { table: 'chats', key: 'id', stamp: true } },
    persona: { table: 'persona_worlds', key: 'persona_id', carrier: null },
    global: { table: 'global_worlds', key: null, carrier: null },
});

function scopeOf(scope) {
    const s = SCOPES[scope];
    if (!s) throw new Error(`unknown world scope: ${scope}`);
    return s;
}

/** Trim, drop blanks, dedupe, keep order. */
function cleanWorldNames(v) {
    return [...new Set((Array.isArray(v) ? v : []).map(w => String(w).trim()).filter(Boolean))];
}

/** A replace's whole list: anything but an array of non-empty names is a 400, before anything is written. */
export function putWorldNames(v) {
    if (!Array.isArray(v) || !v.every(w => typeof w === 'string' && w)) throw httpError(400, 'worlds must be an array of names');
    return cleanWorldNames(v);
}

/** An apply verb's add or remove: absent is none, anything but a list of names a 400 naming it (as /tags/apply refuses). */
export function applyWorldNames(v, label) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || !v.every(w => typeof w === 'string')) throw httpError(400, `${label} must be an array of lorebook names`);
    return cleanWorldNames(v);
}

export function worldExists(db, name) {
    return !!db.prepare('SELECT 1 FROM worlds WHERE name = ?').get(name);
}

/** The one place a world row is born without a book: an empty placeholder, filled in place when a book of that name arrives. */
export function ensureWorld(db, name) {
    return db.transaction(() => {
        const now = Date.now();
        const minted = db.prepare(`INSERT OR IGNORE INTO worlds (name, data, entry_count, imported_at, created_at, updated_at, placeholder)
            VALUES (?, '{}', 0, NULL, ?, ?, 1)`).run(name, now, now).changes > 0;
        if (minted) emitChange(db, { entity: 'world', op: 'created', ids: [name], placeholder: true });
        return minted;
    })();
}

// import paths mint placeholders for names with no book; API verbs only see names the pickers offered, so an unknown one is refused
function resolveNames(db, names, ensure) {
    for (const name of names) {
        if (ensure) ensureWorld(db, name);
        else if (!worldExists(db, name)) throw httpError(400, `no lorebook named "${name}"`);
    }
}

/** How many bindings, across the four scopes, name a world. */
export function countBindings(db, name) {
    let n = 0;
    for (const s of Object.values(SCOPES)) n += db.prepare(`SELECT COUNT(*) n FROM ${s.table} WHERE world_name = ?`).get(name).n;
    return n;
}

// a chat's binding write is an edit of the chat; a character's or persona's is a relation row and leaves its stamp
function touch(db, s, id, now) {
    if (s.carrier?.stamp && id) db.prepare(`UPDATE ${s.carrier.table} SET updated_at = ? WHERE ${s.carrier.key} = ?`).run(now, id);
}

// a character's head book is its card's extensions.world, so moving it reports the character (a worldLink record reaches no character patcher)
const headOfChar = (db, id) => db.prepare('SELECT world_name FROM char_worlds WHERE char_id = ? ORDER BY pos LIMIT 1').get(id)?.world_name ?? null;
function reportHeadMoved(db, scope, id, before) {
    if (scope === 'char' && id && headOfChar(db, id) !== before) reportCharactersUpdated(db, [id], ['extensions.world']);
}

/** The characters whose head book a world is: read before a rename or a delete moves their extensions.world. */
export function headCarriersOf(db, name) {
    return db.prepare(`SELECT cw.char_id AS id FROM char_worlds cw WHERE cw.world_name = ?
        AND cw.pos = (SELECT MIN(pos) FROM char_worlds h WHERE h.char_id = cw.char_id)`).all(name).map(r => r.id);
}

/** The ordered names bound at one scope (id ignored for global). */
export function listWorldsFor(db, scope, id) {
    const s = scopeOf(scope);
    const rows = s.key
        ? db.prepare(`SELECT world_name FROM ${s.table} WHERE ${s.key} = ? ORDER BY pos`).all(id)
        : db.prepare(`SELECT world_name FROM ${s.table} ORDER BY pos`).all();
    return rows.map(r => r.world_name);
}

/**
 * Every list of one keyed scope in one read, grouped by carrier, its live name inlined (null for an orphan link).
 * @returns {Array<{id: string, name: string|null, worlds: string[]}>}
 */
export function listAllWorldsFor(db, scope) {
    const s = scopeOf(scope);
    if (!s.key) return [{ id: null, name: null, worlds: listWorldsFor(db, scope) }];
    const nameJoin = s.carrier
        ? `LEFT JOIN ${s.carrier.table} t ON t.${s.carrier.key} = b.${s.key}`
        : '';
    const rows = db.prepare(`
        SELECT b.${s.key} AS id, b.world_name, ${s.carrier ? 't.name' : 'NULL'} AS name
        FROM ${s.table} b ${nameJoin}
        ORDER BY b.${s.key}, b.pos`).all();
    const grouped = new Map();
    for (const r of rows) {
        if (!grouped.has(r.id)) grouped.set(r.id, { id: r.id, name: r.name ?? null, worlds: [] });
        grouped.get(r.id).worlds.push(r.world_name);
    }
    return [...grouped.values()];
}

/** The head of the list: what a card carries as extensions.world, what a chat's JSONL header carries as world_info. */
export function headWorldFor(db, scope, id) {
    return listWorldsFor(db, scope, id)[0] || null;
}

/** Replace the whole list (the PUT shape; putWorldNames refuses a malformed one). Returns the cleaned list that was written. */
export function replaceWorldsFor(db, scope, id, names, { ensure = false } = {}) {
    const s = scopeOf(scope);
    const list = putWorldNames(names);
    db.transaction(() => {
        resolveNames(db, list, ensure);
        const before = scope === 'char' ? headOfChar(db, id) : null;
        if (s.key) db.prepare(`DELETE FROM ${s.table} WHERE ${s.key} = ?`).run(id);
        else db.prepare(`DELETE FROM ${s.table}`).run();
        const ins = s.key
            ? db.prepare(`INSERT OR IGNORE INTO ${s.table} (${s.key}, world_name, pos) VALUES (?, ?, ?)`)
            : db.prepare(`INSERT OR IGNORE INTO ${s.table} (world_name, pos) VALUES (?, ?)`);
        list.forEach((w, i) => (s.key ? ins.run(id, w, i) : ins.run(w, i)));
        touch(db, s, id, Date.now());
        emitChange(db, { entity: 'worldLink', op: 'updated', scope, ids: s.key ? [id] : [] });
        reportHeadMoved(db, scope, id, before);
    })();
    return list;
}

/**
 * Atomic add/remove: appends after the tail, removes by name, never reading the list to change it. Reports only real changes.
 * @returns {{ added: string[], removed: string[] }}
 */
export function applyWorldsFor(db, scope, id, { add = [], remove = [], ensure = false } = {}) {
    const s = scopeOf(scope);
    const addNames = cleanWorldNames(add);
    const removeNames = cleanWorldNames(remove);
    let out;
    db.transaction(() => {
        resolveNames(db, addNames, ensure);
        const before = scope === 'char' ? headOfChar(db, id) : null;
        out = linkRows(db, s, linkStatements(db, s), id, addNames, removeNames);
        if (out.added.length || out.removed.length) {
            emitChange(db, { entity: 'worldLink', op: 'updated', scope, ids: s.key ? [id] : [] });
            reportHeadMoved(db, scope, id, before);
        }
    })();
    return out;
}

function linkStatements(db, s) {
    return {
        ins: s.key
            ? db.prepare(`INSERT OR IGNORE INTO ${s.table} (${s.key}, world_name, pos)
                VALUES (?, ?, (SELECT COALESCE(MAX(pos), -1) + 1 FROM ${s.table} WHERE ${s.key} = ?))`)
            : db.prepare(`INSERT OR IGNORE INTO ${s.table} (world_name, pos)
                VALUES (?, (SELECT COALESCE(MAX(pos), -1) + 1 FROM ${s.table}))`),
        del: s.key
            ? db.prepare(`DELETE FROM ${s.table} WHERE ${s.key} = ? AND world_name = ?`)
            : db.prepare(`DELETE FROM ${s.table} WHERE world_name = ?`),
    };
}

// one carrier's appends and removes with its stamp, reported by the caller (once a carrier, or once a batch)
function linkRows(db, s, { ins, del }, id, addNames, removeNames) {
    const added = [];
    const removed = [];
    for (const w of addNames) { if ((s.key ? ins.run(id, w, id) : ins.run(w)).changes) added.push(w); }
    for (const w of removeNames) { if ((s.key ? del.run(id, w) : del.run(w)).changes) removed.push(w); }
    if (added.length || removed.length) touch(db, s, id, Date.now());
    return { added, removed };
}

// a batch's carriers in one record; past RECORD_IDS_MAX it reads as all, as a character write's report does
function reportLinksUpdated(db, scope, ids) {
    if (!ids.length) return;
    emitChange(db, ids.length > RECORD_IDS_MAX
        ? { entity: 'worldLink', op: 'updated', scope, all: true }
        : { entity: 'worldLink', op: 'updated', scope, ids: [...ids] });
}

/**
 * applyWorldsFor over many carriers (char or chat), one transaction reported once; an unknown id is skipped, a name with no book a 400 before anything lands.
 * @returns {{touched: number, affected: string[], skipped: string[], deltas: Array<{charId?: string, chatId?: string, added: string[], removed: string[]}>}}
 */
export function applyWorldsBatch(db, scope, ids, { add = [], remove = [], ensure = false } = {}) {
    const s = scopeOf(scope);
    if (!s.carrier) throw new Error(`world scope ${scope} has no carrier rows to batch over`);
    const idKey = scope === 'chat' ? 'chatId' : 'charId';
    const addNames = cleanWorldNames(add);
    const removeNames = cleanWorldNames(remove);
    const exists = db.prepare(`SELECT 1 FROM ${s.carrier.table} WHERE ${s.carrier.key} = ?`);
    const skipped = [];
    const touched = [];
    const deltas = [];
    const moved = [];
    const headsMoved = [];
    db.transaction(() => {
        let stmts = null;
        for (const rawId of ids) {
            // no filename tolerance: an unknown id lands in skipped, never in a strip
            const id = String(rawId);
            if (!exists.get(id)) { skipped.push(id); continue; }
            if (!stmts) {
                resolveNames(db, addNames, ensure);
                stmts = linkStatements(db, s);
            }
            const before = scope === 'char' ? headOfChar(db, id) : null;
            const { added, removed } = linkRows(db, s, stmts, id, addNames, removeNames);
            if (added.length || removed.length) {
                deltas.push({ [idKey]: id, added, removed });
                moved.push(id);
                if (scope === 'char' && headOfChar(db, id) !== before) headsMoved.push(id);
            }
            touched.push(id);
        }
        reportLinksUpdated(db, scope, moved);
        if (headsMoved.length) reportCharactersUpdated(db, headsMoved, ['extensions.world']);
    })();
    return { touched: touched.length, affected: touched, skipped, deltas };
}

/**
 * The head slot, the interchange verb: a name moves to the head, '' or null unlinks the head only. extensions.world and world_info write here.
 * @returns {boolean} whether the list changed
 */
export function setHeadWorldFor(db, scope, id, name, { ensure = true } = {}) {
    const s = scopeOf(scope);
    if (!s.key) throw new Error('the global list has no head slot');
    const target = typeof name === 'string' ? name.trim() : '';
    return db.transaction(() => {
        if (target) resolveNames(db, [target], ensure);
        const head = db.prepare(`SELECT world_name, pos FROM ${s.table} WHERE ${s.key} = ? ORDER BY pos LIMIT 1`).get(id);
        if (!target) {
            if (!head) return false;
            db.prepare(`DELETE FROM ${s.table} WHERE ${s.key} = ? AND world_name = ?`).run(id, head.world_name);
            touch(db, s, id, Date.now());
            emitChange(db, { entity: 'worldLink', op: 'updated', scope, ids: [id] });
            reportHeadMoved(db, scope, id, head.world_name);
            return true;
        }
        if (head?.world_name === target) return false;
        const newPos = head ? head.pos - 1 : 0;
        db.prepare(`INSERT INTO ${s.table} (${s.key}, world_name, pos) VALUES (?, ?, ?)
            ON CONFLICT(${s.key}, world_name) DO UPDATE SET pos = excluded.pos`).run(id, target, newPos);
        touch(db, s, id, Date.now());
        emitChange(db, { entity: 'worldLink', op: 'updated', scope, ids: [id] });
        reportHeadMoved(db, scope, id, head?.world_name ?? null);
        return true;
    })();
}

// a rename onto a name a carrier already has would collide on the PK, so that row goes first; a plain remove leaves the presets
function sweepRename(db, from, to) {
    let n = 0;
    const carriers = {};
    for (const [scope, s] of Object.entries(SCOPES)) {
        const ids = s.key ? new Set(db.prepare(`SELECT ${s.key} AS id FROM ${s.table} WHERE world_name = ?`).all(from).map(r => r.id)) : null;
        n += (s.key
            ? db.prepare(`DELETE FROM ${s.table} WHERE world_name = ?
                AND ${s.key} IN (SELECT ${s.key} FROM ${s.table} WHERE world_name = ?)`)
            : db.prepare(`DELETE FROM ${s.table} WHERE world_name = ?
                AND EXISTS (SELECT 1 FROM ${s.table} WHERE world_name = ?)`)).run(from, to).changes;
        n += db.prepare(`UPDATE ${s.table} SET world_name = ? WHERE world_name = ?`).run(to, from).changes;
        if (ids?.size) carriers[scope] = [...ids];
    }
    rewritePresetRules(db, PRESET_LOREBOOK_FIELDS, from, to);
    return { n, carriers };
}
function sweepRemove(db, name) {
    let n = 0;
    const carriers = {};
    for (const [scope, s] of Object.entries(SCOPES)) {
        const rows = db.prepare(`DELETE FROM ${s.table} WHERE world_name = ?${s.key ? ` RETURNING ${s.key} AS id` : ''}`)[s.key ? 'all' : 'run'](name);
        if (s.key) { n += rows.length; if (rows.length) carriers[scope] = rows.map(r => r.id); } else n += rows.changes;
    }
    return { n, carriers };
}
function settleSweep(db, carriers) {
    const now = Date.now();
    for (const id of carriers.chat || []) touch(db, SCOPES.chat, id, now);
    if (carriers.char?.length) reportCharactersUpdated(db, carriers.char, ['extensions.world']);
}

/**
 * Re-point every binding naming a world onto an existing book, or drop them all, across the four tables in one transaction.
 * @param {object} op { rename: { from, to } } or { remove: name }
 * @returns {number} rows touched
 */
export function sweepWorldName(db, { rename, remove } = {}) {
    if (rename && typeof rename.from === 'string' && typeof rename.to === 'string') {
        if (!worldExists(db, rename.to)) throw httpError(400, `no lorebook named "${rename.to}"`);
        return db.transaction(() => {
            const { n, carriers } = sweepRename(db, rename.from, rename.to);
            if (n) emitChange(db, { entity: 'worldLink', op: 'updated', all: true, world: rename.from, to: rename.to });
            settleSweep(db, carriers);
            return n;
        })();
    }
    if (typeof remove === 'string' && remove) {
        return db.transaction(() => {
            const { n, carriers } = sweepRemove(db, remove);
            if (n) emitChange(db, { entity: 'worldLink', op: 'updated', all: true, world: remove });
            settleSweep(db, carriers);
            return n;
        })();
    }
    throw httpError(400, 'sweep needs {rename: {from, to}} or {remove: name}');
}

/**
 * Rename a world, its entries and bindings following by ON UPDATE CASCADE; refuses a taken name.
 * @returns {{ touched: number }|null} null when the world does not exist
 */
export function renameWorld(db, from, to) {
    const target = typeof to === 'string' ? to.trim() : '';
    if (!target) throw httpError(400, 'new name required');
    if (!db.prepare('SELECT 1 FROM worlds WHERE name = ?').get(from)) return null;
    if (target === from) return { touched: 0 };
    if (db.prepare('SELECT 1 FROM worlds WHERE name = ?').get(target)) {
        throw httpError(409, 'a world with that name already exists');
    }
    return db.transaction(() => {
        const touched = countBindings(db, from);
        const heads = headCarriersOf(db, from);
        // an ST-shaped world may carry its own name inside the meta blob; it follows the row
        db.prepare(`UPDATE worlds SET name = ?, updated_at = ?,
            data = CASE WHEN json_type(data, '$.name') IS NOT NULL THEN json_set(data, '$.name', ?) ELSE data END
            WHERE name = ?`).run(target, Date.now(), target, from);
        rewritePresetRules(db, PRESET_LOREBOOK_FIELDS, from, target);
        emitChange(db, { entity: 'world', op: 'updated', ids: [from], to: target });
        if (heads.length) reportCharactersUpdated(db, heads, ['extensions.world']);
        return { touched };
    })();
}
