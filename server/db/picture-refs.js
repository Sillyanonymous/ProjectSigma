// The stored pictures a session turn may name: its character's portrait, that character's gallery images, its owner's attachments
import { httpError } from '../lib/http-error.js';

const KINDS = new Set(['avatar', 'media', 'attachment']);
const keyOf = (ref) => `${ref.kind}:${ref.id}`;
const shape = 'pictures are a list of { kind: avatar | media | attachment, id }';

// one picture held to the scope ({ charId, chatId | studioId }); a 400 names it when the scope may not show it
function scopedOne(db, scope, { kind, id }) {
    if (kind === 'avatar') {
        const row = typeof id === 'string' && id && id === scope.charId ? db.prepare('SELECT name FROM characters WHERE id = ?').get(id) : null;
        if (!row) throw httpError(400, `not this session's character: ${id}`);
        return { kind, id, name: `${row.name || 'portrait'}.png`, width: null, height: null, url: `/avatars/${id}.png` };
    }
    if (!Number.isInteger(id) || id <= 0) throw httpError(400, shape);
    if (kind === 'media') {
        const row = db.prepare('SELECT char_id, file, display_name, kind FROM media WHERE id = ?').get(id);
        if (!row || !scope.charId || row.char_id !== scope.charId) throw httpError(400, `not this character's gallery image: ${id}`);
        if (row.kind !== 'image') throw httpError(400, `a turn carries pictures only: ${id}`);
        return { kind, id, name: row.display_name, width: null, height: null, url: `/gallery/${row.char_id}/${row.file}` };
    }
    const row = db.prepare('SELECT chat_id, studio_id, file, display_name, kind, width, height FROM attachments WHERE id = ?').get(id);
    const owned = row && (scope.chatId ? row.chat_id === scope.chatId : !!scope.studioId && row.studio_id === scope.studioId);
    if (!owned) throw httpError(400, `not this session's attachment: ${id}`);
    if (row.kind !== 'image') throw httpError(400, `a turn carries pictures only: ${id}`);
    return { kind, id, name: row.display_name, width: row.width ?? null, height: row.height ?? null, url: `/attachments/${row.chat_id ?? row.studio_id}/${row.file}` };
}

/**
 * A turn's picture references held to its scope, each with its name and size for the budget, duplicates dropped.
 * @param {{charId: string|null, chatId?: string, studioId?: string}} scope the session's character and owner
 * @returns {Array<{kind, id, name, width, height, url}>} url the stored file, for a reader to open
 */
export function scopedPictures(db, scope, refs) {
    if (refs == null) return [];
    if (!Array.isArray(refs) || refs.some(r => !r || typeof r !== 'object' || !KINDS.has(r.kind))) throw httpError(400, shape);
    const seen = new Set();
    return refs.filter(r => !seen.has(keyOf(r)) && seen.add(keyOf(r))).map(r => scopedOne(db, scope, r));
}

/** Of a transcript's picture references, the ones still stored and still the scope's, as kind:id keys; a removed one is left out of a build. */
export function storedPictures(db, scope, refs) {
    const want = { media: new Set(), attachment: new Set() };
    let avatar = false;
    for (const r of refs || []) {
        if (r?.kind === 'avatar') avatar ||= !!scope.charId && r.id === scope.charId;
        else if (r?.kind === 'media' || r?.kind === 'attachment') want[r.kind].add(r.id);
    }
    const out = new Set();
    if (avatar && db.prepare('SELECT 1 FROM characters WHERE id = ?').get(scope.charId)) out.add(`avatar:${scope.charId}`);
    if (want.media.size && scope.charId) {
        for (const r of db.prepare("SELECT id FROM media WHERE char_id = ? AND kind = 'image' AND id IN (SELECT value FROM json_each(?))")
            .all(scope.charId, JSON.stringify([...want.media]))) out.add(`media:${r.id}`);
    }
    const [col, owner] = scope.chatId ? ['chat_id', scope.chatId] : ['studio_id', scope.studioId];
    if (want.attachment.size && owner) {
        for (const r of db.prepare(`SELECT id FROM attachments WHERE ${col} = ? AND kind = 'image' AND id IN (SELECT value FROM json_each(?))`)
            .all(owner, JSON.stringify([...want.attachment]))) out.add(`attachment:${r.id}`);
    }
    return out;
}

/** A stored picture reference's key, as storedPictures answers it. */
export const pictureKey = keyOf;
