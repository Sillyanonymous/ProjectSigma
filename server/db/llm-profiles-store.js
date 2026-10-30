import { emitChange } from './changes.js';
import { httpError } from '../lib/http-error.js';
import { settingValue } from './settings-store.js';
// LLM connection profiles; keys are write-only above this layer (toProfile never carries one), the default is profileRow's rule

function parseParams(text) {
    try { return JSON.parse(text || '{}'); } catch { return {}; }
}
// a null baseUrl, model or key is empty, never the text "null"
const str = (v) => (v == null ? '' : String(v));

// four chars tell two keys apart without being the key; a shorter key gives no hint (four of eight is half)
export const KEY_HINT_MIN = 12;
export function keyHintOf(key) {
    const k = str(key);
    return k.length >= KEY_HINT_MIN ? k.slice(-4) : null;
}

// the column's 1, 0 or NULL as the wire's true, false or null (not known)
export const visionOf = (row) => (row?.vision == null ? null : row.vision === 1);
const visionColumn = (v) => (v == null ? null : (v ? 1 : 0));

/** The public shape: no key (hasKey and a four-char hint), params parsed; an unset contextSize, vision or maxImages is null. */
export function toProfile(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        baseUrl: row.base_url,
        model: row.model,
        hasKey: !!row.api_key,
        keyHint: keyHintOf(row.api_key),
        params: parseParams(row.params),
        contextSize: row.context_size ?? null,
        vision: visionOf(row),
        maxImages: row.max_images ?? null,
        pos: row.pos,
    };
}

/** The connection a request names: undefined for none, its id when it is one; a 400 when it is no connection. */
export function namedProfileId(db, value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || !value) throw httpError(400, 'profileId must be a connection id');
    if (!profileRow(db, value)) throw httpError(400, 'connection not found');
    return value;
}

/** The raw row by id, or the default profile when no id is given; null when none. */
export function profileRow(db, profileId = null) {
    return profileId
        ? db.prepare('SELECT * FROM llm_profiles WHERE id = ?').get(profileId) || null
        : db.prepare('SELECT * FROM llm_profiles ORDER BY pos, created_at LIMIT 1').get() || null;
}

export function listProfiles(db) {
    return db.prepare('SELECT * FROM llm_profiles ORDER BY pos, created_at').all().map(toProfile);
}

export function getProfile(db, id) {
    return toProfile(profileRow(db, id));
}

/** The stored sampler defaults of a raw row (profileRow's, or a draft over it); {} when none. */
export function rowParams(row) {
    return parseParams(row?.params);
}

/** The stored sampler defaults of a profile (or of the default profile); {} when none. */
export function profileParams(db, profileId = null) {
    return rowParams(profileRow(db, profileId));
}

/** A profile's declared context window, or null when it has none or does not exist. */
export function profileContextSize(db, profileId) {
    const n = Number(profileRow(db, profileId)?.context_size);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** The most pictures a raw row's host takes in one request, or null for no limit. */
export const maxImagesOf = (row) => (Number.isInteger(row?.max_images) && row.max_images > 0 ? row.max_images : null);

/** Create a profile at the end of the order; callers hand over validated params, contextSize, vision, maxImages and kind. */
export function createProfile(db, { id, name, kind, baseUrl = '', apiKey = '', model = '', params = {}, contextSize = null, vision = null, maxImages = null }) {
    return db.transaction(() => {
        const now = Date.now();
        const pos = db.prepare('SELECT COALESCE(MAX(pos), -1) + 1 AS p FROM llm_profiles').get().p;
        db.prepare(`INSERT INTO llm_profiles (id, name, kind, base_url, api_key, model, params, context_size, vision, max_images, pos, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, name, kind, str(baseUrl), str(apiKey), str(model), JSON.stringify(params), contextSize, visionColumn(vision), maxImages, pos, now, now);
        emitChange(db, { entity: 'llmProfile', op: 'created', ids: [id] });
        return getProfile(db, id);
    })();
}

/**
 * Copy a profile, stored key included: the client can never read a key back.
 * @returns the new profile, or null when the source id is unknown
 */
export function duplicateProfile(db, id, { newId, name }) {
    const row = profileRow(db, id);
    if (!row) return null;
    return createProfile(db, {
        id: newId, name, kind: row.kind, baseUrl: row.base_url, apiKey: row.api_key, model: row.model,
        params: parseParams(row.params), contextSize: row.context_size ?? null, vision: visionOf(row), maxImages: maxImagesOf(row),
    });
}

/** Partial update, only present keys move; apiKey absent keeps it and '' clears it. null for an unknown id. */
export function patchProfile(db, id, patch = {}) {
    return db.transaction(() => {
        const row = profileRow(db, id);
        if (!row) return null;
        db.prepare(`UPDATE llm_profiles SET
                name = ?, kind = ?, base_url = ?, model = ?, params = ?, api_key = ?, context_size = ?, vision = ?, max_images = ?, updated_at = ?
            WHERE id = ?`)
            .run(
                patch.name !== undefined ? String(patch.name) : row.name,
                patch.kind !== undefined ? patch.kind : row.kind,
                patch.baseUrl !== undefined ? str(patch.baseUrl) : row.base_url,
                patch.model !== undefined ? str(patch.model) : row.model,
                patch.params !== undefined ? JSON.stringify(patch.params) : (row.params || '{}'),
                patch.apiKey !== undefined ? str(patch.apiKey) : row.api_key,
                patch.contextSize !== undefined ? patch.contextSize : row.context_size,
                patch.vision !== undefined ? visionColumn(patch.vision) : row.vision,
                patch.maxImages !== undefined ? patch.maxImages : row.max_images,
                Date.now(), id,
            );
        emitChange(db, { entity: 'llmProfile', op: 'updated', ids: [id], fields: Object.keys(patch) });
        return getProfile(db, id);
    })();
}

// the settings rows that name a profile; the settingsPointers invariant checks each one
export const PROFILE_POINTERS = ['chatProfileId', 'assistantProfileId'];

/**
 * Which connection answers a chat: its own, else the chats' default (the chatProfileId row), else the first.
 * @param {string|null} chatId null resolves the default, which a chat not stored yet answers to
 * @returns {{ row: object|null, source: 'chat'|'default'|'none', override: string|null, defaultId: string|null }}
 */
export function resolveChatProfile(db, chatId) {
    const override = chatId ? (db.prepare('SELECT profile_id FROM chats WHERE id = ?').get(chatId)?.profile_id ?? null) : null;
    const pointed = settingValue(db, 'chatProfileId', null);
    const fallback = (typeof pointed === 'string' && pointed && profileRow(db, pointed)) || profileRow(db, null);
    const defaultId = fallback?.id ?? null;
    if (override) {
        // ON DELETE SET NULL makes a dangling pointer impossible, but falling through keeps it a repair not a failure
        const own = profileRow(db, override);
        if (own) return { row: own, source: 'chat', override, defaultId };
    }
    return { row: fallback, source: fallback ? 'default' : 'none', override, defaultId };
}

/**
 * Delete a profile and every pointer at it (the PROFILE_POINTERS settings rows, the sessions that picked it).
 * @returns {boolean} whether a row was there to delete
 */
export function deleteProfile(db, id) {
    return db.transaction(() => {
        const gone = db.prepare('DELETE FROM llm_profiles WHERE id = ?').run(id).changes > 0;
        if (gone) {
            // every pointer at the profile goes with it: the chat's and the assistant's settings, and
            // the sessions that picked it (no foreign key reaches them)
            for (const key of PROFILE_POINTERS) {
                const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
                let pointed = null;
                try { pointed = row ? JSON.parse(row.value) : null; } catch { pointed = null; }
                if (pointed !== id) continue;
                db.prepare('DELETE FROM settings WHERE key = ?').run(key);
                emitChange(db, { entity: 'setting', op: 'updated', ids: [key] });
            }
            const heldBy = (table) => db.prepare(`UPDATE ${table} SET profile_id = NULL WHERE profile_id = ? RETURNING id`).all(id).map(r => r.id);
            const asked = heldBy('assistant_sessions');
            if (asked.length) emitChange(db, { entity: 'assistantSession', op: 'updated', ids: asked, fields: ['profileId'] });
            const studied = heldBy('studio_sessions');
            if (studied.length) emitChange(db, { entity: 'studioSession', op: 'updated', ids: studied, fields: ['profileId'] });
            emitChange(db, { entity: 'llmProfile', op: 'deleted', ids: [id] });
        }
        return gone;
    })();
}
