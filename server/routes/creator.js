import { Router } from 'express';
import {
    listSessions, getSession, createSession, patchSession, deleteSession,
    appendMessage, patchMessage, truncateFrom, deleteMessage,
} from '../db/studio-store.js';
import { buildCreatorPrompt, buildTagsPrompt, parseTagList, normalizeDraft, DEFAULT_CREATOR_ROLE, DRAFT_FIELDS, TAG_VOCAB_MAX } from '../llm/creator.js';
import { listTagCounts } from '../db/tags-store.js';
import { checkCardProposal, applyCardProposals, mergeOverrides, selfAnchorsFromApplied, laterAnchorsForReply } from '../llm/assistant-edits.js';
import { chat, chatStream } from '../llm/service.js';
import { LENGTH_FINISH_REASONS as LENGTH_REASONS } from '../llm/errors.js';
import { openReply, withReplyCeiling, logStoreFailure } from '../llm/reply-tail.js';
import { replyReserve } from '../llm/prompt.js';
import { settingValue } from '../db/settings-store.js';
import { namedProfileId } from '../db/llm-profiles-store.js';
import { characterExists } from '../db/characters-store.js';
import { runHook } from '../db/hook-seat.js';
import { intOf } from '../lib/query-params.js';
import { sessionLookup, transcriptHandlers, proposalExtra, sessionPictures } from '../lib/session-routes.js';

// The creator studio over an unsaved draft: every request posts it, and the apply is computed here and handed back

export const creatorRouter = Router();


const MAX_REFERENCES = 400000;


const sessionOr404 = sessionLookup(getSession);
// an author turn may show the session's character (portrait, gallery), when it has one, and the session's own pictures
const pictureScope = (db, session) => ({ charId: session.charId || null, studioId: session.id });
const transcript = transcriptHandlers({ sessionOr404, appendMessage, patchMessage, deleteMessage, truncateFrom, pictureScope });

/** The request's draft and steer fields; a missing draft is refused, or generate would erase the stored one. */
function draftOf(body) {
    const draft = normalizeDraft(body?.draft);
    const references = typeof body?.references === 'string' ? body.references.slice(0, MAX_REFERENCES) : '';
    const scope = Array.isArray(body?.scope) ? body.scope.filter(k => typeof k === 'string') : null;
    const sel = body?.selection;
    const selection = sel && typeof sel === 'object' && typeof sel.field === 'string' && typeof sel.text === 'string'
        ? { field: sel.field, text: sel.text } : null;
    return { draft, references, scope, selection };
}

function builderSettings(db) {
    return {
        systemPrompt: String(settingValue(db, 'creatorStudioSystemPrompt', '') || ''),
        maxContext: Number(settingValue(db, 'creatorStudioMaxContext', 0)) || 0,
        // the same reserve the chat's generate budgets with, or the preview shows turns
        // the real send would trim
        reserveForReply: replyReserve(db),
    };
}

/** The model's earlier unapplied replace and set changes before `seq`, newest first, bounded. */
function priorUnapplied(session, seq) {
    const out = [];
    for (let i = seq - 1; i >= 0 && out.length < 12; i--) {
        const m = session.messages[i];
        if (m?.role !== 'assistant') continue;
        const applied = m.extra?.applied || {};
        for (const p of [...(m.extra?.proposals || [])].reverse()) {
            const op = p.change?.op;
            if (p.invalid || (op !== 'replace' && op !== 'set') || applied[p.id]?.status === 'applied') continue;
            out.push({ ...p, seq: i });
        }
    }
    return out;
}

/** The session's turns for the builder, the last reply carrying the judge's verdict on what is unapplied. */
function transcriptFor(session, draft) {
    const msgs = session.messages;
    let last = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant') { last = i; break; }
    return msgs.map((m, i) => {
        if (i !== last || !m.extra?.proposals?.length) return { role: m.role, content: m.content, extra: m.extra };
        const applied = m.extra.applied || {};
        const self = selfAnchorsFromApplied(applied);
        const prior = priorUnapplied(session, i);
        const judged = {};
        for (const p of m.extra.proposals) {
            if (p.invalid || applied[p.id]) continue;
            try {
                const v = checkCardProposal(m.extra.context || null, draft, p, self, prior);
                judged[p.id] = { status: v.status, ...(v.reason ? { reason: v.reason } : {}), ...(v.via ? { via: v.via } : {}) };
            } catch { /* the note goes without a verdict for this one */ }
        }
        return { role: m.role, content: m.content, extra: { ...m.extra, judged } };
    });
}

/** The built-in role text, SENT so the settings view can offer it as a starting point. */
creatorRouter.get('/defaults', (req, res) => {
    // the field vocabulary is the server's, so the panel never offers a field the engine refuses
    res.json({ systemPrompt: DEFAULT_CREATOR_ROLE, fields: DRAFT_FIELDS.map(([key, label]) => ({ key, label })) });
});

/** What the partner can see, for the context view, built by the real assembler over the posted draft. */
creatorRouter.post('/context', (req, res) => {
    const { draft, references, scope } = draftOf(req.body);
    const built = buildCreatorPrompt({ draft, references, scope, transcript: [], ...builderSettings(req.db) });
    return res.json({ ...built.summary, engines: built.context.engines, budget: built.budget });
});

// the tag wand: one call, no session; the library's vocabulary rides the ask so the model prefers its spellings
creatorRouter.post('/tags', async (req, res) => {
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
        const { draft } = draftOf(req.body);
        const body = { messages: buildTagsPrompt(draft, listTagCounts(req.db).slice(0, TAG_VOCAB_MAX)), purpose: 'creator' };
        const askedProfile = namedProfileId(req.db, req.body?.profileId);
        if (askedProfile) body.profileId = askedProfile;
        if (req.body?.params && typeof req.body.params === 'object') body.params = req.body.params;
        const out = await chat(req.db, body, controller.signal);
        return res.json({ tags: parseTagList(out?.content, draft.tags || []) });
    } catch (err) {
        if (err?.name === 'AbortError') return undefined;
        throw err;
    }
});

creatorRouter.get('/sessions', (req, res) => {
    const charId = req.query.charId ? String(req.query.charId) : null;
    res.json(listSessions(req.db, charId));
});

creatorRouter.post('/sessions', (req, res) => {
    const b = req.body || {};
    const charId = b.charId ? String(b.charId) : null;
    if (charId && !characterExists(req.db, charId)) return res.status(404).json({ error: 'character not found' });
    let draft = {};
    draft = b.draft ? normalizeDraft(b.draft) : {};
    const name = typeof b.name === 'string' && b.name.trim()
        ? b.name.trim()
        : `Session ${listSessions(req.db, charId).length + 1}`;
    res.status(201).json(createSession(req.db, { charId, name, draft, profileId: b.profileId ? namedProfileId(req.db, b.profileId) : null }));
});

creatorRouter.get('/sessions/:sid', (req, res) => {
    const session = sessionOr404(req, res);
    if (session) res.json(session);
});

creatorRouter.patch('/sessions/:sid', (req, res) => {
    const session = sessionOr404(req, res);
    if (!session) return undefined;
    const b = req.body || {};
    const patch = {};
    if (typeof b.name === 'string') {
        if (!b.name.trim()) return res.status(400).json({ error: 'name cannot be blank' });
        patch.name = b.name.trim();
    }
    if ('profileId' in b) patch.profileId = b.profileId ? namedProfileId(req.db, b.profileId) : null;
    if ('charId' in b) {
        const charId = b.charId ? String(b.charId) : null;
        if (charId && !characterExists(req.db, charId)) return res.status(404).json({ error: 'character not found' });
        patch.charId = charId;
    }
    if ('draft' in b) {
        patch.draft = normalizeDraft(b.draft);
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to change' });
    return res.json(patchSession(req.db, session.id, patch));
});

creatorRouter.delete('/sessions/:sid', (req, res) => {
    if (!deleteSession(req.db, req.paths, req.params.sid)) return res.status(404).json({ error: 'no such session' });
    res.json({ ok: true });
});

creatorRouter.post('/sessions/:sid/messages', transcript.append);
creatorRouter.patch('/sessions/:sid/messages/:seq', transcript.patch);
creatorRouter.delete('/sessions/:sid/messages/:seq', transcript.remove);

/** Stream the partner's next reply, stored with the snapshot of the draft it was shown. */
creatorRouter.post('/sessions/:sid/generate', async (req, res) => {
    const db = req.db;
    const session = sessionOr404(req, res);
    if (!session) return undefined;
    // refused before the reply opens, as the chat's generate refuses one
    const askedProfile = namedProfileId(db, req.body?.profileId);

    let snapshot = null;

    const reply = openReply(db, res, (text, interrupted, { reasoning }) => {
        text = runHook('reply.final', text, { db, chatId: null, charId: session.charId, surface: 'creator', sessionId: session.id, interrupted: interrupted || null });
        try {
            return appendMessage(db, session.id, {
                role: 'assistant',
                content: text,
                extra: {
                    ...(interrupted ? { interrupted } : {}),
                    ...(reasoning.trim() ? { reasoning } : {}),
                    ...(snapshot ? { context: snapshot } : {}),
                    ...proposalExtra(text),
                },
            });
        } catch (e) { logStoreFailure('creator', e); return null; }
    });

    try {
        const { draft, references, scope, selection } = draftOf(req.body);
        // the draft the conversation is about, kept with the session so a resume can restore it
        patchSession(db, session.id, { draft });
        const profileId = askedProfile || session.profileId;
        const turns = transcriptFor(session, draft);
        const built = buildCreatorPrompt({
            draft, references, scope, selection,
            transcript: turns,
            ...builderSettings(db),
            pictures: sessionPictures(db, pictureScope(db, session), turns, profileId),
        });
        snapshot = built.context;

        const body = { messages: built.messages, stream: true, purpose: 'creator' };
        if (profileId) body.profileId = profileId;
        const params = withReplyCeiling(db, req.body?.params, profileId);
        if (params) body.params = params;

        const finish = await reply.pipe(chatStream(db, body, reply.signal));
        const stored = reply.commit(LENGTH_REASONS.has(finish?.finishReason) ? 'length limit' : null);
        reply.end(stored, finish, { message: stored?.message ?? null, seq: stored?.seq ?? null, budget: built.budget });
    } catch (err) {
        reply.fail(err);
    }
    return undefined;
});

/** A reply's proposals judged against the posted draft; a POST since the draft is the row. never stored. */
creatorRouter.post('/sessions/:sid/judge', (req, res) => {
    const seq = intOf(req.body?.seq);
    if (!Number.isInteger(seq) || seq < 0) return res.status(400).json({ error: 'seq must be a non-negative integer' });
    const session = sessionOr404(req, res);
    if (!session) return undefined;
    const msg = session.messages[seq];
    if (!msg) return res.status(404).json({ error: 'no such message' });
    let draft;
    ({ draft } = draftOf(req.body));
    const snapshot = msg.extra?.context || null;
    const applied = msg.extra?.applied || {};
    const self = selfAnchorsFromApplied(applied);
    const prior = priorUnapplied(session, seq);
    // what later replies' applied changes rewrote: an earlier proposal on the same key is superseded
    const later = laterAnchorsForReply(session.messages, seq);
    const proposals = (msg.extra?.proposals || []).map((p) => {
        if (applied[p.id]?.status === 'applied') {
            return { ...p, status: 'applied', appliedAt: applied[p.id].at, result: applied[p.id].result };
        }
        return { ...p, ...checkCardProposal(snapshot, draft, p, self, prior, later) };
    });
    return res.json({ seq, proposals, errors: msg.extra?.proposalErrors || [] });
});

/** Apply chosen proposals over the posted draft and answer the result; the session keeps it. */
creatorRouter.post('/sessions/:sid/apply', (req, res) => {
    const seq = intOf(req.body?.seq);
    if (!Number.isInteger(seq) || seq < 0) return res.status(400).json({ error: 'seq must be a non-negative integer' });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
    if (!ids || !ids.length) return res.status(400).json({ error: 'ids array required' });
    const session = sessionOr404(req, res);
    if (!session) return undefined;
    const msg = session.messages[seq];
    if (!msg) return res.status(404).json({ error: 'no such message' });
    let draft;
    ({ draft } = draftOf(req.body));
    const already = msg.extra?.applied || {};
    const overrides = (req.body?.overrides && typeof req.body.overrides === 'object') ? req.body.overrides : {};
    const chosen = (msg.extra?.proposals || [])
        .filter(p => ids.includes(p.id) && already[p.id]?.status !== 'applied')
        .map(p => mergeOverrides(p, overrides[p.id]));
    if (!chosen.length) return res.status(400).json({ error: 'nothing to apply (already applied, or no such proposal)' });

    const { results, draft: next } = applyCardProposals(msg.extra?.context || null, draft, chosen, selfAnchorsFromApplied(already), priorUnapplied(session, seq), laterAnchorsForReply(session.messages, seq));

    const at = Date.now();
    const nextApplied = { ...already };
    for (const r of results) nextApplied[r.id] = { status: r.status, at, ...(r.result ? { result: r.result } : {}), ...(r.reason ? { reason: r.reason } : {}) };
    patchMessage(req.db, session.id, seq, { extra: { applied: nextApplied } });
    patchSession(req.db, session.id, { draft: next });

    const landed = results.filter(r => r.status === 'applied').map(r => r.result);
    return res.json({
        results,
        draft: next,
        touched: {
            fields: [...new Set(landed.filter(r => r.field).map(r => r.field))],
            tags: landed.some(r => r.tags),
            greetings: landed.some(r => r.greeting),
        },
    });
});

/** What the partner would be sent right now over the posted draft. Same builder, nothing stored. */
creatorRouter.post('/sessions/:sid/prompt', (req, res) => {
    const session = sessionOr404(req, res);
    if (!session) return undefined;
    const { draft, references, scope, selection } = draftOf(req.body);
    const turns = transcriptFor(session, draft);
    const built = buildCreatorPrompt({
        draft, references, scope, selection,
        transcript: turns,
        ...builderSettings(req.db),
        pictures: sessionPictures(req.db, pictureScope(req.db, session), turns, session.profileId),
    });
    return res.json({ messages: built.messages, budget: built.budget, context: built.context, pictures: built.pictures });
});
