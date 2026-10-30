import crypto from 'node:crypto';
import { emitChange } from './changes.js';
import { attachmentsHeldBy, removeAttachmentFiles } from './attachments-store.js';
import { MAX_SESSION_NAME as MAX_NAME, parseMessages, appendTurn, patchTurn, deleteTurn, truncateTurns } from './transcript-rows.js';

// the creator studio's sessions: one conversation over a draft, bound to its character (NULL is the drafts bucket)

const mapSummary = (r) => ({
    id: r.id,
    charId: r.char_id || null,
    name: r.name,
    profileId: r.profile_id || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count ?? 0,
});

function parseDraft(text) {
    try {
        const v = JSON.parse(text);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch { return {}; }
}

const mapSession = (r) => {
    const messages = parseMessages(r.messages);
    return { ...mapSummary(r), draft: parseDraft(r.draft), messages: messages || [], damaged: messages === null };
};

/** Sessions for one character (charId null = drafts), newest first, WITHOUT transcripts. */
export function listSessions(db, charId) {
    const where = charId ? 'char_id = ?' : 'char_id IS NULL';
    const args = charId ? [charId] : [];
    // json_array_length raises on bad JSON: unguarded, one damaged transcript takes the list down (and with it the delete)
    return db.prepare(`
        SELECT id, char_id, name, profile_id, created_at, updated_at,
               CASE WHEN json_valid(messages) THEN json_array_length(messages) END AS message_count
        FROM studio_sessions WHERE ${where} ORDER BY updated_at DESC
    `).all(...args).map(mapSummary);
}

export function sessionExists(db, id) {
    return !!db.prepare('SELECT 1 FROM studio_sessions WHERE id = ?').get(id);
}

export function getSession(db, id) {
    const row = db.prepare('SELECT * FROM studio_sessions WHERE id = ?').get(id);
    return row ? mapSession(row) : null;
}

export function createSession(db, { charId = null, name, draft = {}, profileId = null }) {
    return db.transaction(() => {
        const now = Date.now();
        const id = crypto.randomUUID();
        db.prepare(`INSERT INTO studio_sessions (id, char_id, name, draft, messages, profile_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, '[]', ?, ?, ?)`)
            .run(id, charId || null, String(name || 'Session').slice(0, MAX_NAME), JSON.stringify(draft || {}), profileId || null, now, now);
        emitChange(db, { entity: 'studioSession', op: 'created', ids: [id], charId: charId || null });
        return getSession(db, id);
    })();
}

export function patchSession(db, id, patch) {
    return db.transaction(() => {
        const row = db.prepare('SELECT id FROM studio_sessions WHERE id = ?').get(id);
        if (!row) return null;
        const sets = [];
        const args = [];
        let touch = false;
        if (typeof patch.name === 'string') { sets.push('name = ?'); args.push(patch.name.slice(0, MAX_NAME)); }
        if ('profileId' in patch) { sets.push('profile_id = ?'); args.push(patch.profileId || null); }
        // a draft that became a saved character takes its conversation with it (null = the
        // drafts bucket); a rebind is bookkeeping, not a working event
        if ('charId' in patch) { sets.push('char_id = ?'); args.push(patch.charId || null); }
        // The draft moving is a working event, so it moves updated_at; a rename reshuffling the
        // recency-ordered list is not what anyone means by renaming.
        if (patch.draft && typeof patch.draft === 'object' && !Array.isArray(patch.draft)) {
            sets.push('draft = ?'); args.push(JSON.stringify(patch.draft)); touch = true;
        }
        if (!sets.length) return getSession(db, id);
        if (touch) { sets.push('updated_at = ?'); args.push(Date.now()); }
        db.prepare(`UPDATE studio_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
        emitChange(db, { entity: 'studioSession', op: 'updated', ids: [id], fields: Object.keys(patch) });
        return getSession(db, id);
    })();
}

/** Delete a session, its pictures' rows cascading and their files after. */
export function deleteSession(db, paths, id) {
    const out = db.transaction(() => {
        const held = attachmentsHeldBy(db, { studioIds: [id] });
        const gone = db.prepare('DELETE FROM studio_sessions WHERE id = ?').run(id).changes > 0;
        if (gone) emitChange(db, { entity: 'studioSession', op: 'deleted', ids: [id] });
        return { gone, held };
    })();
    if (out.gone) removeAttachmentFiles(paths, out.held);
    return out.gone;
}

// the read-modify-write under every message verb; null for a gone session or an unparseable transcript
function rewriteMessages(db, id, edit) {
    return db.transaction(() => {
        const row = db.prepare('SELECT messages FROM studio_sessions WHERE id = ?').get(id);
        const messages = row ? parseMessages(row.messages) : null;
        if (!messages) return null;
        const { write, answer } = edit(messages);
        if (write) {
            db.prepare('UPDATE studio_sessions SET messages = ?, updated_at = ? WHERE id = ?')
                .run(JSON.stringify(write), Date.now(), id);
            emitChange(db, { entity: 'studioSession', op: 'updated', ids: [id], fields: ['messages'] });
        }
        return answer;
    })();
}

/**
 * Append one message and return it with the seq it landed at.
 * @returns {{seq:number, message:object}|null} null when the session is gone or its
 *   transcript is unparseable, which the caller must surface rather than retry
 */
export function appendMessage(db, id, message) {
    return rewriteMessages(db, id, (messages) => appendTurn(messages, message));
}

/** Merge a patch into one message: an edit, or the record that a proposal inside it was applied. */
export function patchMessage(db, id, seq, patch, { at = null } = {}) {
    return rewriteMessages(db, id, (messages) => patchTurn(messages, seq, patch, at));
}

/** Remove ONE message, leaving the rest of the transcript alone. */
export function deleteMessage(db, id, seq, { at = null } = {}) {
    return rewriteMessages(db, id, (messages) => deleteTurn(messages, seq, at));
}

/** Drop one message and everything after it: the only reason to remove a reply is to ask again. */
export function truncateFrom(db, id, seq, { at = null } = {}) {
    return rewriteMessages(db, id, (messages) => truncateTurns(messages, seq, at));
}
