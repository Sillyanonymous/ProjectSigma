// What the assistant's and the studio's session routes share: the lookup, stored proposals, the message handlers

import { intOf } from './query-params.js';
import { parseProposals, withheldContent, selfAnchorsFromApplied, laterAnchorsForReply } from '../llm/assistant-edits.js';
import { changeLabel } from '../llm/assistant.js';
import { scopedPictures, storedPictures } from '../db/picture-refs.js';
import { profileRow, maxImagesOf } from '../db/llm-profiles-store.js';
import { profileSees } from '../llm/service.js';
import { pictureCapOf } from '../llm/images.js';

const ROLES = new Set(['user', 'assistant']);

// the shown turn's stamp (?at=): a seq is a position, and another tab's delete renumbers it
function seenStamp(req, res) {
    const at = intOf(req.query.at);
    if (Number.isNaN(at)) { res.status(400).json({ error: 'at must be a number' }); return undefined; }
    return at === undefined ? null : at;
}

/** The session lookup over a store's getSession: refuses politely; every route below needs the same two answers. */
export function sessionLookup(getSession) {
    return (req, res) => {
        const session = getSession(req.db, req.params.sid);
        if (!session) { res.status(404).json({ error: 'no such session' }); return null; }
        if (session.damaged) {
            // Reporting an unreadable transcript as empty would invite the next append to write
            // one message over whatever is really stored.
            res.status(500).json({ error: 'this session\'s transcript could not be read' });
            return null;
        }
        return session;
    };
}

/** A reply's parsed proposals as its stored extra carries them, each key only when it has something. */
export function proposalExtra(content, surface = undefined) {
    const { proposals, errors } = parseProposals(content, surface);
    return { ...(proposals.length ? { proposals } : {}), ...(errors.length ? { proposalErrors: errors } : {}) };
}

// a Try again names its reply by stamp (a seq is a position) and the changes by id; null when the body names none
function retryOf(session, raw) {
    if (raw == null) return null;
    // no cap of its own: every id must be one of the reply's changes, which bounds the list
    if (typeof raw !== 'object' || !Number.isInteger(raw.at) || !Array.isArray(raw.ids) || !raw.ids.length || !raw.ids.every(id => typeof id === 'string')) {
        return { status: 400, error: 'retry is { at: the reply\'s stamp, ids: its change ids }' };
    }
    const reply = session.messages.find(m => m.role === 'assistant' && m.at === raw.at);
    if (!reply) return { status: 409, error: 'that reply changed since it was shown' };
    // the ids came from the reply as shown: one missing from it now means it was edited since
    const list = reply.extra?.proposals || [];
    const ids = [...new Set(raw.ids)];
    const at = ids.map(id => list.findIndex(p => p.id === id));
    if (at.some(n => n < 0)) return { status: 409, error: 'that reply changed since it was shown' };
    // the changes as the panel showed them, aligned with ids: an edit elsewhere can reuse an id for another change
    if (raw.shown != null) {
        if (!Array.isArray(raw.shown) || raw.shown.length !== raw.ids.length) return { status: 400, error: 'retry.shown lists one change per id' };
        if (raw.ids.some((id, i) => JSON.stringify(list.find(p => p.id === id).change) !== JSON.stringify(raw.shown[i]))) {
            return { status: 409, error: 'that reply changed since it was shown' };
        }
    }
    // the changes copied as shown, so an edit of the reply afterwards (new ids) cant swap what was asked
    return { at: raw.at, ids, changes: at.map(n => ({ n, proposal: list[n] })) };
}

/**
 * A session's turns for a build: the last reply judged by the route, earlier unapplied changes left out, a pending Try again filled in.
 * @param {object} o surface and words: withheldContent's; judge: (p, { snapshot, self, later }) -> a Try again change's verdict, plus any quote; lastReply: (m, i) -> the last reply's extra
 */
export function modelTranscript(messages, { surface, words, judge, lastReply }) {
    let last = -1;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') { last = i; break; }
    const retry = pendingRetry(messages);
    return messages.map((m, i) => {
        const turn = { role: m.role, content: m.content, extra: m.extra };
        if (retry?.turn === i) return { ...turn, extra: { ...m.extra, retryItems: retryItems(messages, retry, judge) } };
        if (m.role !== 'assistant' || !m.extra?.proposals?.length) return turn;
        return i === last ? { ...turn, extra: lastReply(m, i) } : { ...turn, content: withheldContent(m.content, m.extra, surface, words) };
    });
}

// each change a Try again names, as written, and where it stands now through the route's judge
function retryItems(messages, { seq, reply, changes }, judge) {
    const list = reply.extra?.proposals || [];
    const applied = reply.extra?.applied || {};
    const ctx = { snapshot: reply.extra?.context || null, self: selfAnchorsFromApplied(applied), later: laterAnchorsForReply(messages, seq), seq };
    return changes.map(({ n, proposal: p }) => {
        const item = { label: changeLabel(p, n), change: p.change };
        // applied only while the reply still holds this very change under its id
        const same = JSON.stringify(list.find(x => x.id === p.id)?.change) === JSON.stringify(p.change);
        if (same && applied[p.id]?.status === 'applied') return { ...item, status: 'applied' };
        try {
            return { ...item, ...judge(p, ctx) };
        } catch {
            return { ...item, status: 'unknown', reason: 'the app could not judge it just now' };
        }
    });
}

/**
 * The Try again the next reply answers: the last reader turn, data turns aside, when it carries one and its reply still stands.
 * @returns {{turn: number, seq: number, reply: object, changes: Array<{n: number, proposal: object}>}|null} seq: where the reply sits now
 */
function pendingRetry(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== 'user' || m.extra?.data) continue;
        const retry = m.extra?.retry;
        // a patch merges extra unchecked, so a stored shape this never wrote is no retry
        if (!retry || !Array.isArray(retry.changes)) return null;
        const seq = messages.findIndex(r => r.role === 'assistant' && r.at === retry.at);
        return seq < 0 ? null : { turn: i, seq, reply: messages[seq], changes: retry.changes.filter(c => Number.isInteger(c?.n) && c.proposal?.change) };
    }
    return null;
}

/**
 * What a session's build sends of its pictures through a connection (the default when none is named).
 * @returns {{sees: boolean, cap: number|null, stored: Set<string>}} stored: the transcript's references still held in the scope
 */
export function sessionPictures(db, scope, transcript, profileId) {
    const row = profileRow(db, profileId || null);
    const sees = profileSees(db, row) === true;
    const refs = (transcript || []).flatMap(t => (t.role === 'user' && Array.isArray(t.extra?.pictures) ? t.extra.pictures : []));
    return { sees, cap: sees ? pictureCapOf(maxImagesOf(row)) : null, stored: refs.length ? storedPictures(db, scope, refs) : new Set() };
}

/**
 * The transcript-message handlers over a store's verbs, for a router's own /sessions/:sid/messages paths.
 * @param {Function} opts.pictureScope (db, session) -> the scope a reader turn's pictures are held to (picture-refs.js)
 */
export function transcriptHandlers({ sessionOr404, appendMessage, patchMessage, deleteMessage, truncateFrom, pictureScope, proposals = undefined }) {
    return {
        /** Append ONE message; a client never sends a transcript, so a stale one cant overwrite history. */
        append(req, res) {
            const session = sessionOr404(req, res);
            if (!session) return undefined;
            const role = String(req.body?.role || 'user');
            if (!ROLES.has(role)) return res.status(400).json({ error: `role must be one of ${[...ROLES].join(', ')}` });
            const content = typeof req.body?.content === 'string' ? req.body.content : '';
            // the reader's pictures, each one the session may show; a turn of pictures alone has no text
            if (role !== 'user' && req.body?.pictures != null) return res.status(400).json({ error: 'only a reader turn carries pictures' });
            const pictures = role === 'user' ? scopedPictures(req.db, pictureScope(req.db, session), req.body?.pictures) : [];
            if (!content.trim() && !pictures.length) return res.status(400).json({ error: 'content or pictures required' });
            if (role !== 'user' && req.body?.retry != null) return res.status(400).json({ error: 'only a reader turn carries a retry' });
            const retry = role === 'user' ? retryOf(session, req.body?.retry) : null;
            if (retry?.error) return res.status(retry.status).json({ error: retry.error });
            // parsed here too, so a reply that arrives any other way still carries its proposals
            const extra = role === 'assistant' ? proposalExtra(content, proposals)
                : { ...(pictures.length ? { pictures } : {}), ...(retry ? { retry } : {}) };
            const stored = appendMessage(req.db, session.id, { role, content, ...(Object.keys(extra).length ? { extra } : {}) });
            if (!stored) return res.status(409).json({ error: 'the session changed underneath this write' });
            return res.json(stored);
        },

        patch(req, res) {
            const seq = intOf(req.params.seq);
            if (!Number.isInteger(seq) || seq < 0) return res.status(400).json({ error: 'seq must be a non-negative integer' });
            const session = sessionOr404(req, res);
            if (!session) return undefined;
            const patch = {};
            if (typeof req.body?.content === 'string') {
                patch.content = req.body.content;
                // re-parse on edit, or the card offers to apply text that isnt on screen anymore
                if (session.messages[seq]?.role === 'assistant') {
                    const parsed = parseProposals(patch.content, proposals);
                    patch.extra = {
                        proposals: parsed.proposals.length ? parsed.proposals : undefined,
                        proposalErrors: parsed.errors.length ? parsed.errors : undefined,
                        // an edited reply's previous verdicts describe text that is gone
                        applied: undefined,
                    };
                }
            }
            if (req.body?.extra && typeof req.body.extra === 'object' && !Array.isArray(req.body.extra)) {
                patch.extra = { ...(patch.extra || {}), ...req.body.extra };
            }
            if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to change' });
            const at = seenStamp(req, res);
            if (at === undefined) return undefined;
            const result = patchMessage(req.db, session.id, seq, patch, { at });
            if (!result) return res.status(404).json({ error: 'no such message' });
            if (result.conflict) return res.status(409).json({ error: 'that message changed since it was shown' });
            return res.json(result);
        },

        /** Remove a turn: `?mode=one` splices it, the default truncates from there (a re-ask leaves no non sequiturs). */
        remove(req, res) {
            const seq = intOf(req.params.seq);
            if (!Number.isInteger(seq) || seq < 0) return res.status(400).json({ error: 'seq must be a non-negative integer' });
            const mode = String(req.query.mode || 'truncate');
            if (mode !== 'one' && mode !== 'truncate') return res.status(400).json({ error: "mode must be 'one' or 'truncate'" });
            const at = seenStamp(req, res);
            if (at === undefined) return undefined;
            const session = sessionOr404(req, res);
            if (!session) return undefined;
            const result = mode === 'one'
                ? deleteMessage(req.db, session.id, seq, { at })
                : truncateFrom(req.db, session.id, seq, { at });
            if (!result) return res.status(404).json({ error: 'no such message' });
            if (result.conflict) return res.status(409).json({ error: 'that message changed since it was shown' });
            return res.json(result);
        },
    };
}
