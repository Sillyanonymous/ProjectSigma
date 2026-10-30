// What the assistant's and the studio's session routes share: the lookup, stored proposals, the message handlers

import { intOf } from './query-params.js';
import { parseProposals } from '../llm/assistant-edits.js';
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
export function proposalExtra(content) {
    const { proposals, errors } = parseProposals(content);
    return { ...(proposals.length ? { proposals } : {}), ...(errors.length ? { proposalErrors: errors } : {}) };
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
export function transcriptHandlers({ sessionOr404, appendMessage, patchMessage, deleteMessage, truncateFrom, pictureScope }) {
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
            // parsed here too, so a reply that arrives any other way still carries its proposals
            const extra = role === 'assistant' ? proposalExtra(content) : (pictures.length ? { pictures } : {});
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
                    const parsed = parseProposals(patch.content);
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
