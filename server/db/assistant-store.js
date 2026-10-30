import crypto from 'node:crypto';
import { emitChange } from './changes.js';
import { MAX_SESSION_NAME as MAX_NAME, parseMessages, appendTurn, patchTurn, deleteTurn, truncateTurns } from './transcript-rows.js';

// The assistant's sessions, one row per transcript bound to a chat; a caller never hands in a whole transcript

const mapSummary = (r) => ({
    id: r.id,
    chatId: r.chat_id,
    name: r.name,
    profileId: r.profile_id || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count ?? 0,
});

const mapSession = (r) => {
    const messages = parseMessages(r.messages);
    return { ...mapSummary(r), messages: messages || [], damaged: messages === null };
};

/** Sessions for one chat, newest first, WITHOUT their transcripts. */
export function listSessions(db, chatId) {
    // json_array_length RAISES on malformed JSON: unguarded, one damaged transcript
    // takes every sibling session down with the whole list query.
    return db.prepare(`
        SELECT id, chat_id, name, profile_id, created_at, updated_at,
               CASE WHEN json_valid(messages) THEN json_array_length(messages) END AS message_count
        FROM assistant_sessions WHERE chat_id = ? ORDER BY updated_at DESC
    `).all(chatId).map(mapSummary);
}

export function getSession(db, id) {
    const row = db.prepare('SELECT * FROM assistant_sessions WHERE id = ?').get(id);
    return row ? mapSession(row) : null;
}

export function createSession(db, chatId, name) {
    return db.transaction(() => {
        const now = Date.now();
        const id = crypto.randomUUID();
        db.prepare(`INSERT INTO assistant_sessions (id, chat_id, name, messages, created_at, updated_at)
            VALUES (?, ?, ?, '[]', ?, ?)`)
            .run(id, chatId, String(name || 'Session').slice(0, MAX_NAME), now, now);
        emitChange(db, { entity: 'assistantSession', op: 'created', ids: [id], chatId });
        return getSession(db, id);
    })();
}

export function patchSession(db, id, patch) {
    return db.transaction(() => {
        const row = db.prepare('SELECT id FROM assistant_sessions WHERE id = ?').get(id);
        if (!row) return null;
        const sets = [];
        const args = [];
        if (typeof patch.name === 'string') { sets.push('name = ?'); args.push(patch.name.slice(0, MAX_NAME)); }
        if ('profileId' in patch) { sets.push('profile_id = ?'); args.push(patch.profileId || null); }
        if (!sets.length) return getSession(db, id);
        // a rename doesnt move updated_at: the session list orders by it
        db.prepare(`UPDATE assistant_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
        emitChange(db, { entity: 'assistantSession', op: 'updated', ids: [id], fields: Object.keys(patch) });
        return getSession(db, id);
    })();
}

export function deleteSession(db, id) {
    return db.transaction(() => {
        const gone = db.prepare('DELETE FROM assistant_sessions WHERE id = ?').run(id).changes > 0;
        if (gone) emitChange(db, { entity: 'assistantSession', op: 'deleted', ids: [id] });
        return gone;
    })();
}

// the read-modify-write under every message verb; null for a gone session or an unparseable transcript
function rewriteMessages(db, id, edit) {
    return db.transaction(() => {
        const row = db.prepare('SELECT messages FROM assistant_sessions WHERE id = ?').get(id);
        const messages = row ? parseMessages(row.messages) : null;
        if (!messages) return null;
        const { write, answer } = edit(messages);
        if (write) {
            db.prepare('UPDATE assistant_sessions SET messages = ?, updated_at = ? WHERE id = ?')
                .run(JSON.stringify(write), Date.now(), id);
            emitChange(db, { entity: 'assistantSession', op: 'updated', ids: [id], fields: ['messages'] });
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
