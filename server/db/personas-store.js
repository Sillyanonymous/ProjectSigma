import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { invalidatePersonaThumbs } from '../lib/thumb-cache.js';
import { emitChange } from './changes.js';

// personas are uuid rows, never keyed by name (two may share one); the active one is the activePersonaId setting

/** A persona's pronoun forms: the API's key -> its column. */
export const PRONOUN_COLUMNS = Object.freeze({ sub: 'pronoun_sub', obj: 'pronoun_obj', poss: 'pronoun_poss', possP: 'pronoun_poss_p', ref: 'pronoun_ref' });

const mapRow = r => ({
    id: r.id,
    name: r.name,
    description: r.description,
    avatar: r.avatar,
    pronouns: Object.fromEntries(Object.entries(PRONOUN_COLUMNS).map(([key, col]) => [key, r[col] ?? ''])),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

export function listPersonas(db) {
    return db.prepare('SELECT * FROM personas ORDER BY name COLLATE NOCASE').all().map(mapRow);
}

export function getPersona(db, id) {
    const row = db.prepare('SELECT * FROM personas WHERE id = ?').get(id);
    return row ? mapRow(row) : null;
}

/** A new persona; pronouns is { sub, obj, poss, possP, ref }, a form omitted stored empty. */
export function createPersona(db, { name, description = '', avatar = null, pronouns = {} }) {
    return db.transaction(() => {
        const now = Date.now();
        const id = crypto.randomUUID();
        const forms = Object.keys(PRONOUN_COLUMNS).map(key => pronouns?.[key] ?? '');
        db.prepare(`INSERT INTO personas (id, name, description, avatar, ${Object.values(PRONOUN_COLUMNS).join(', ')}, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, name, description, avatar, ...forms, now, now);
        emitChange(db, { entity: 'persona', op: 'created', ids: [id] });
        return getPersona(db, id);
    })();
}

// Only the keys actually present are written, so a PATCH of one field cannot blank
// the others by omission.
export function updatePersona(db, id, patch) {
    return db.transaction(() => {
        const existing = getPersona(db, id);
        if (!existing) return null;
        const sets = [];
        const params = [];
        for (const [col, key] of [['name', 'name'], ['description', 'description'], ['avatar', 'avatar']]) {
            if (patch[key] === undefined) continue;
            sets.push(`${col} = ?`);
            params.push(patch[key]);
        }
        // a partial pronouns object writes only the forms it names
        for (const [key, col] of Object.entries(PRONOUN_COLUMNS)) {
            if (patch.pronouns?.[key] === undefined) continue;
            sets.push(`${col} = ?`);
            params.push(patch.pronouns[key]);
        }
        if (!sets.length) return existing;
        sets.push('updated_at = ?');
        params.push(Date.now(), id);
        db.prepare(`UPDATE personas SET ${sets.join(', ')} WHERE id = ?`).run(...params);
        emitChange(db, { entity: 'persona', op: 'updated', ids: [id], fields: Object.keys(patch) });
        return getPersona(db, id);
    })();
}

// deleting the active persona clears the pointer in the same transaction, so the setting never names a gone row
export function deletePersona(db, paths, id) {
    const existing = getPersona(db, id);
    if (!existing) return false;
    db.transaction(() => {
        db.prepare('DELETE FROM personas WHERE id = ?').run(id);
        const active = readActiveId(db);
        if (active === id) {
            db.prepare('DELETE FROM settings WHERE key = ?').run('activePersonaId');
            emitChange(db, { entity: 'setting', op: 'updated', ids: ['activePersonaId'] });
        }
        emitChange(db, { entity: 'persona', op: 'deleted', ids: [id] });
    })();
    // the picture goes once the row is gone for good; no foreign key reaches a file
    try { fs.unlinkSync(path.join(paths.personaAvatarsDir, `${id}.png`)); } catch { /* none stored */ }
    invalidatePersonaThumbs(paths.personaThumbsDir, id);
    return true;
}

function readActiveId(db) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('activePersonaId');
    if (!row) return null;
    try { const v = JSON.parse(row.value); return typeof v === 'string' ? v : null; } catch { return null; }
}

export function getActivePersona(db) {
    const id = readActiveId(db);
    if (!id) return null;
    return getPersona(db, id);
}

export function setActivePersona(db, id) {
    return db.transaction(() => {
        if (id === null) {
            db.prepare('DELETE FROM settings WHERE key = ?').run('activePersonaId');
            emitChange(db, { entity: 'setting', op: 'updated', ids: ['activePersonaId'] });
            return null;
        }
        const persona = getPersona(db, id);
        if (!persona) return null;
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('activePersonaId', JSON.stringify(id));
        emitChange(db, { entity: 'setting', op: 'updated', ids: ['activePersonaId'] });
        return persona;
    })();
}

/**
 * Who the user is in a chat: its own override, else the global active persona (the authority).
 * @param {string|null} chatId null resolves the global, which is what a preview wants
 * @returns {{persona: object|null, source: 'chat'|'global'|'none'}}
 */
export function resolvePersona(db, chatId) {
    if (chatId) {
        const row = db.prepare('SELECT persona_id FROM chats WHERE id = ?').get(chatId);
        if (row?.persona_id) {
            const own = getPersona(db, row.persona_id);
            // ON DELETE SET NULL makes a dangling pointer impossible, but falling through keeps it a repair not a blank
            if (own) return { persona: own, source: 'chat' };
        }
    }
    const global = getActivePersona(db);
    return { persona: global, source: global ? 'global' : 'none' };
}

/** The chat's RAW persona pointer (what "set here" means, as opposed to inherited); null when none or unknown chat. */
export function chatPersonaOverride(db, chatId) {
    return db.prepare('SELECT persona_id FROM chats WHERE id = ?').get(chatId)?.persona_id ?? null;
}

/**
 * Point one chat at a persona, or clear the override with null so it follows the global.
 * @returns {boolean} false when the chat or the persona does not exist
 */
export function setChatPersona(db, chatId, personaId) {
    return db.transaction(() => {
        if (!db.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId)) return false;
        if (personaId && !db.prepare('SELECT 1 FROM personas WHERE id = ?').get(personaId)) return false;
        db.prepare('UPDATE chats SET persona_id = ? WHERE id = ?').run(personaId || null, chatId);
        emitChange(db, { entity: 'chat', op: 'updated', ids: [chatId], fields: ['personaId'] });
        return true;
    })();
}
