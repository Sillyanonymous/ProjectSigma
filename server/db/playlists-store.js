import crypto from 'node:crypto';
import { emitChange, reportCharactersUpdated, RECORD_IDS_MAX } from './changes.js';
import { httpError } from '../lib/http-error.js';
// playlists rows plus playlist_chars membership (cascades with the character); members are read off character rows or a tally

const COUNTED_SQL = 'SELECT p.*, (SELECT COUNT(*) FROM playlist_chars pc WHERE pc.playlist_id = p.id) AS count FROM playlists p';

// a row in the document's entry shape: what the client holds under the playlist's id
const entryOf = (p) => ({
    name: p.name,
    description: p.description,
    icon: p.icon,
    color: p.color,
    created: p.created_at,
    modified: p.modified_at,
    count: p.count,
});

/** Every playlist with how many characters it holds, in the library's order. */
export function composePlaylistsDoc(db) {
    const doc = { version: 1, playlists: {}, order: [] };
    for (const p of db.prepare(`${COUNTED_SQL} ORDER BY p.pos, p.created_at`).all()) {
        doc.playlists[p.id] = entryOf(p);
        doc.order.push(p.id);
    }
    return doc;
}

/**
 * How many characters of a set each playlist holds (absent: none); a set less some ids is its filter's counts less theirs.
 * @param {{ sql: string, params: any[], whole?: boolean, less?: { base: object, gone: object } }} set
 * @returns {Object<string, number>}
 */
export function tallyPlaylists(db, set) {
    if (set.less) {
        const out = tallyPlaylists(db, set.less.base);
        for (const [id, n] of Object.entries(tallyPlaylists(db, set.less.gone))) {
            if (out[id] === n) delete out[id];
            else out[id] -= n;
        }
        return out;
    }
    const out = {};
    const rows = set.whole
        ? db.prepare('SELECT playlist_id, COUNT(*) AS n FROM playlist_chars GROUP BY playlist_id').all()
        : db.prepare(`SELECT playlist_id, COUNT(*) AS n FROM playlist_chars WHERE char_id IN (${set.sql}) GROUP BY playlist_id`).all(...set.params);
    for (const r of rows) out[r.playlist_id] = r.n;
    return out;
}

/** A playlist name read off an imported document under the row verbs' rule: trimmed, at most 100 characters, never blank. */
function docPlaylistName(raw) {
    return (typeof raw === 'string' ? raw.trim().slice(0, 100).trim() : '') || 'Playlist';
}

/**
 * Merge a playlists document (the ST migration's step): a held id gains missing members, others are created " (n)"-suffixed. Re-runs change nothing.
 * @returns {{created: number, merged: number, renamed: number, members: number}}
 */
export function mergePlaylistsDoc(db, doc) {
    const order = Array.isArray(doc?.order) ? doc.order : Object.keys(doc?.playlists || {});
    const out = { created: 0, merged: 0, renamed: 0, members: 0 };
    db.transaction(() => {
        const exists = db.prepare('SELECT 1 FROM playlists WHERE id = ?');
        const charExists = db.prepare('SELECT 1 FROM characters WHERE id = ?');
        const insertList = db.prepare(`
            INSERT INTO playlists (id, name, description, icon, color, pos, created_at, modified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        let listPos = db.prepare('SELECT COALESCE(MAX(pos), -1) AS p FROM playlists').get().p;
        const insertChar = db.prepare('INSERT OR IGNORE INTO playlist_chars (playlist_id, char_id, pos) VALUES (?, ?, ?)');
        const endOf = db.prepare('SELECT COALESCE(MAX(pos), -1) AS p FROM playlist_chars WHERE playlist_id = ?');
        const touch = db.prepare('UPDATE playlists SET modified_at = ? WHERE id = ?');
        const seen = new Set();
        for (const uid of order) {
            const id = String(uid);
            const p = doc.playlists?.[uid];
            if (seen.has(id) || !p || typeof p !== 'object') continue;
            seen.add(id);
            const held = !!exists.get(id);
            if (held) out.merged++;
            else {
                const base = docPlaylistName(p.name);
                let name = base;
                for (let n = 2; nameTaken(db, name); n++) name = `${base.slice(0, 100 - ` (${n})`.length).trim()} (${n})`;
                if (name !== base) out.renamed++;
                insertList.run(id, name, String(p.description || ''), String(p.icon || ''), String(p.color || ''), ++listPos, p.created ?? null, p.modified ?? null);
                out.created++;
            }
            let pos = endOf.get(id).p;
            let joined = 0;
            for (const charId of Array.isArray(p.characters) ? p.characters : []) {
                if (charExists.get(String(charId)) && insertChar.run(id, String(charId), pos + 1).changes) { pos++; joined++; }
            }
            if (held && joined) touch.run(Date.now(), id);
            out.members += joined;
        }
        if (out.created || out.members) emitChange(db, { entity: 'playlist', op: 'updated', all: true });
    })();
    return out;
}

/**
 * A playlist's members in order, a page past a position cursor.
 * @returns {{ids: string[], nextCursor: string|null}|null} null when there is no such playlist
 */
export function listPlaylistMembers(db, id, { after = -1, limit }) {
    if (!db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(String(id))) return null;
    const rows = db.prepare('SELECT char_id, pos FROM playlist_chars WHERE playlist_id = ? AND pos > ? ORDER BY pos LIMIT ?')
        .all(String(id), after, limit);
    return { ids: rows.map(r => r.char_id), nextCursor: rows.length === limit ? String(rows[rows.length - 1].pos) : null };
}

/** One playlist in the document's entry shape plus its id, or null. */
export function getPlaylist(db, id) {
    const p = db.prepare(`${COUNTED_SQL} WHERE p.id = ?`).get(String(id));
    return p ? { id: p.id, ...entryOf(p) } : null;
}

// names are unique regardless of case and padding
function nameTaken(db, name, exceptId = null) {
    const lower = name.toLowerCase();
    return db.prepare('SELECT id, name FROM playlists').all().some(p => p.id !== exceptId && p.name.trim().toLowerCase() === lower);
}

function nameOf(v) {
    const name = typeof v === 'string' ? v.trim() : '';
    if (!name) throw httpError(400, 'name required');
    if (name.length > 100) throw httpError(400, 'name is longer than 100 characters');
    return name;
}

function textOf(v, field) {
    if (typeof v !== 'string') throw httpError(400, `${field} must be a string`);
    return v;
}

/**
 * Create a playlist at the end of the order, id minted here. Refuses a blank name and one
 * another playlist already has (409).
 * @returns {object} the playlist, as getPlaylist answers it
 */
export function createPlaylist(db, { name, description = '', icon = '', color = '' } = {}) {
    const clean = nameOf(name);
    const desc = textOf(description, 'description').trim();
    const ic = textOf(icon, 'icon');
    const col = textOf(color, 'color');
    return db.transaction(() => {
        if (nameTaken(db, clean)) throw httpError(409, `a playlist named "${clean}" already exists`);
        const id = crypto.randomUUID();
        const now = Date.now();
        db.prepare(`
            INSERT INTO playlists (id, name, description, icon, color, pos, created_at, modified_at)
            VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(pos), -1) + 1 FROM playlists), ?, ?)
        `).run(id, clean, desc, ic, col, now, now);
        emitChange(db, { entity: 'playlist', op: 'created', ids: [id] });
        return getPlaylist(db, id);
    })();
}

/**
 * Update the fields present in the patch (name, description, icon, color); an absent field
 * keeps its value. Refuses a blank name and a taken one (409).
 * @returns {object|null} the playlist, or null when there is none
 */
export function updatePlaylist(db, id, patch = {}) {
    const sets = [];
    const params = [];
    const fields = [];
    if (patch.name !== undefined) { sets.push('name = ?'); params.push(nameOf(patch.name)); fields.push('name'); }
    if (patch.description !== undefined) { sets.push('description = ?'); params.push(textOf(patch.description, 'description').trim()); fields.push('description'); }
    if (patch.icon !== undefined) { sets.push('icon = ?'); params.push(textOf(patch.icon, 'icon')); fields.push('icon'); }
    if (patch.color !== undefined) { sets.push('color = ?'); params.push(textOf(patch.color, 'color')); fields.push('color'); }
    return db.transaction(() => {
        if (!db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(String(id))) return null;
        if (!sets.length) return getPlaylist(db, id);
        if (fields.includes('name') && nameTaken(db, params[0], String(id))) throw httpError(409, `a playlist named "${params[0]}" already exists`);
        db.prepare(`UPDATE playlists SET ${sets.join(', ')}, modified_at = ? WHERE id = ?`).run(...params, Date.now(), String(id));
        emitChange(db, { entity: 'playlist', op: 'updated', ids: [String(id)], fields });
        return getPlaylist(db, id);
    })();
}

/** Delete a playlist; its memberships go with it. @returns {boolean} whether there was one */
export function deletePlaylist(db, id) {
    return db.transaction(() => {
        // its members' rows lose the playlist: named up to the record's bound, past it all of them
        const held = db.prepare('SELECT COUNT(*) AS n FROM playlist_chars WHERE playlist_id = ?').get(String(id)).n;
        const members = held && held <= RECORD_IDS_MAX
            ? db.prepare('SELECT char_id FROM playlist_chars WHERE playlist_id = ?').all(String(id)).map(r => r.char_id) : null;
        const info = db.prepare('DELETE FROM playlists WHERE id = ?').run(String(id));
        if (!info.changes) return false;
        emitChange(db, { entity: 'playlist', op: 'deleted', ids: [String(id)] });
        if (members) reportCharactersUpdated(db, members, ['playlists']);
        else if (held) emitChange(db, { entity: 'character', op: 'updated', all: true, fields: ['playlists'] });
        return true;
    })();
}

const idList = (v, field) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) throw httpError(400, `${field} must be an array of character ids`);
    return [...new Set(v)];
};

/**
 * Add and remove members in one transaction; adds join at the end in order, unknown ids come back as skipped.
 * @returns {{added: string[], removed: string[], skipped: string[], playlist: object}|null}
 */
export function applyPlaylistMembers(db, id, { add, remove } = {}) {
    const addIds = idList(add, 'add');
    const removeIds = idList(remove, 'remove');
    if (!addIds.length && !removeIds.length) throw httpError(400, 'nothing to add or remove');
    return db.transaction(() => {
        if (!db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(String(id))) return null;
        const isChar = db.prepare('SELECT 1 FROM characters WHERE id = ?');
        const ins = db.prepare('INSERT OR IGNORE INTO playlist_chars (playlist_id, char_id, pos) VALUES (?, ?, ?)');
        const del = db.prepare('DELETE FROM playlist_chars WHERE playlist_id = ? AND char_id = ?');
        // the end of the order is read once; a MAX per member walks the whole playlist per member
        let pos = db.prepare('SELECT COALESCE(MAX(pos), -1) AS p FROM playlist_chars WHERE playlist_id = ?').get(String(id)).p;
        const added = [];
        const removed = [];
        const skipped = [];
        for (const charId of addIds) {
            if (!isChar.get(charId)) { skipped.push(charId); continue; }
            if (ins.run(String(id), charId, pos + 1).changes) { pos++; added.push(charId); }
        }
        for (const charId of removeIds) if (del.run(String(id), charId).changes) removed.push(charId);
        if (added.length || removed.length) {
            db.prepare('UPDATE playlists SET modified_at = ? WHERE id = ?').run(Date.now(), String(id));
            emitChange(db, { entity: 'playlist', op: 'updated', ids: [String(id)], fields: ['characters'] });
            // the characters' rows carry their playlists, so a tab holding them re-reads them
            reportCharactersUpdated(db, [...added, ...removed], ['playlists']);
        }
        return { added, removed, skipped, playlist: getPlaylist(db, id) };
    })();
}

/**
 * One chunk of a by-filter membership write in its own transaction; the end is read once, the count never. A gone playlist is a 404.
 * @param {{ ids: string[], op: 'add'|'remove' }} chunk
 * @returns {number} the memberships added or removed
 */
export function applyPlaylistChunk(db, id, { ids, op }) {
    return db.transaction(() => {
        if (!db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(String(id))) throw httpError(404, 'playlist not found');
        let moved = [];
        if (op === 'add') {
            const isChar = db.prepare('SELECT 1 FROM characters WHERE id = ?');
            const ins = db.prepare('INSERT OR IGNORE INTO playlist_chars (playlist_id, char_id, pos) VALUES (?, ?, ?)');
            let pos = db.prepare('SELECT COALESCE(MAX(pos), -1) AS p FROM playlist_chars WHERE playlist_id = ?').get(String(id)).p;
            for (const charId of ids) if (isChar.get(charId) && ins.run(String(id), charId, pos + 1).changes) { pos++; moved.push(charId); }
        } else if (op === 'remove') {
            moved = db.prepare('DELETE FROM playlist_chars WHERE playlist_id = ? AND char_id IN (SELECT value FROM json_each(?)) RETURNING char_id')
                .all(String(id), JSON.stringify(ids.map(String))).map(r => r.char_id);
        } else throw httpError(400, "op must be 'add' or 'remove'");
        if (moved.length) {
            db.prepare('UPDATE playlists SET modified_at = ? WHERE id = ?').run(Date.now(), String(id));
            emitChange(db, { entity: 'playlist', op: 'updated', ids: [String(id)], fields: ['characters'] });
            reportCharactersUpdated(db, moved, ['playlists']);
        }
        return moved.length;
    })();
}
