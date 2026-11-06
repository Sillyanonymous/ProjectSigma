import { Router } from 'express';
import {
    listSessions, getSession, createSession, patchSession, deleteSession,
    appendMessage, patchMessage, truncateFrom, deleteMessage,
} from '../db/assistant-store.js';
import { buildAssistantPrompt, parseReadRequests, readSwipesMessage, readLoreMessage, ENGINES, DEFAULT_ROLE } from '../llm/assistant.js';
import { checkProposal, applyProposals, mergeOverrides, selfAnchorsFromApplied, laterAnchorsForReply, appliedTitle } from '../llm/assistant-edits.js';
import { chatStream } from '../llm/service.js';
import { LENGTH_FINISH_REASONS as LENGTH_REASONS } from '../llm/errors.js';
import { openReply, withReplyCeiling, logStoreFailure } from '../llm/reply-tail.js';
import { replyReserve } from '../llm/prompt.js';
import { settingValue } from '../db/settings-store.js';
import { namedProfileId } from '../db/llm-profiles-store.js';
import { chatExists, readMessageRow, getChatRow } from '../db/chats-store.js';
import { runHook } from '../db/hook-seat.js';
import { intOf } from '../lib/query-params.js';
import { sessionLookup, transcriptHandlers, proposalExtra, sessionPictures } from '../lib/session-routes.js';

// The assistant, an out-of-character session bound to a chat. the server stores the reply and the snapshot it built

export const assistantRouter = Router();




const sessionOr404 = sessionLookup(getSession);
// a reader turn may show its chat's character (portrait, gallery) and the chat's own pictures
const pictureScope = (db, session) => ({ charId: getChatRow(db, session.chatId)?.char_id ?? null, chatId: session.chatId });
const transcript = transcriptHandlers({ sessionOr404, appendMessage, patchMessage, deleteMessage, truncateFrom, pictureScope });

/** The built-in role text, sent rather than mirrored; registered before /sessions/:sid so the literal path wins. */
assistantRouter.get('/defaults', (req, res) => {
    res.json({ systemPrompt: DEFAULT_ROLE });
});

/** What the assistant can see, for the context strip, summarised from the real assembler. */
assistantRouter.get('/context', (req, res) => {
    const chatId = req.query.chatId ? String(req.query.chatId) : '';
    if (!chatId) return res.status(400).json({ error: 'chatId query required' });
    const built = buildAssistantPrompt(req.db, chatId, { transcript: [], ...builderSettings(req.db) });
    return res.json({ ...built.summary, engines: built.context.engines, budget: built.budget });
});

assistantRouter.get('/sessions', (req, res) => {
    const chatId = req.query.chatId ? String(req.query.chatId) : '';
    if (!chatId) return res.status(400).json({ error: 'chatId query required' });
    res.json(listSessions(req.db, chatId));
});

assistantRouter.post('/sessions', (req, res) => {
    const chatId = String(req.body?.chatId || '');
    if (!chatId) return res.status(400).json({ error: 'chatId required' });
    if (!chatExists(req.db, chatId)) {
        return res.status(404).json({ error: 'chat not found' });
    }
    const name = typeof req.body?.name === 'string' && req.body.name.trim()
        ? req.body.name.trim()
        : `Session ${listSessions(req.db, chatId).length + 1}`;
    res.status(201).json(createSession(req.db, chatId, name));
});

assistantRouter.get('/sessions/:sid', (req, res) => {
    const session = sessionOr404(req, res);
    if (session) res.json(session);
});

assistantRouter.patch('/sessions/:sid', (req, res) => {
    const patch = {};
    if (typeof req.body?.name === 'string') {
        if (!req.body.name.trim()) return res.status(400).json({ error: 'name cannot be blank' });
        patch.name = req.body.name.trim();
    }
    if ('profileId' in (req.body || {})) patch.profileId = req.body.profileId ? namedProfileId(req.db, req.body.profileId) : null;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to change' });
    const updated = patchSession(req.db, req.params.sid, patch);
    if (!updated) return res.status(404).json({ error: 'no such session' });
    res.json(updated);
});

assistantRouter.delete('/sessions/:sid', (req, res) => {
    if (!deleteSession(req.db, req.params.sid)) return res.status(404).json({ error: 'no such session' });
    res.json({ ok: true });
});

assistantRouter.post('/sessions/:sid/messages', transcript.append);
assistantRouter.patch('/sessions/:sid/messages/:seq', transcript.patch);
assistantRouter.delete('/sessions/:sid/messages/:seq', transcript.remove);

/** The session's turns for the builder; only the last reply gets a fresh verdict, older ones keep their stored fate. */
function transcriptFor(db, session) {
    const msgs = session.messages;
    let last = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant') { last = i; break; }
    return msgs.map((m, i) => {
        if (i !== last || !m.extra?.proposals?.length) return { role: m.role, content: m.content, extra: m.extra };
        const applied = m.extra.applied || {};
        const self = selfAnchorsFromApplied(applied);
        const judged = {};
        // an unplaced replace gets its message quoted under the note, once per message, capped
        const quotes = {};
        for (const p of m.extra.proposals) {
            if (p.invalid || applied[p.id]) continue;
            try {
                const v = checkProposal(db, session.chatId, m.extra.context || null, p, self);
                judged[p.id] = { status: v.status, ...(v.reason ? { reason: v.reason } : {}) };
                if (p.engine === 'chat' && p.op === 'replace' && v.status === 'ambiguous' && !(p.change.seq in quotes)) {
                    // the message the model named, where the judge found it now (a delete since moves it)
                    const text = readMessageRow(db, session.chatId, v.resolved?.seq ?? p.change.seq)?.mes;
                    if (typeof text === 'string') quotes[p.change.seq] = text;
                }
            } catch { /* the note goes without a verdict for this one */ }
        }
        return { role: m.role, content: m.content, extra: { ...m.extra, judged, ...(Object.keys(quotes).length ? { quotes } : {}) } };
    });
}

/** Which engines this request may use: the stored setting, minus anything unknown. */
function enabledEngines(db) {
    return ENGINES.filter(e => settingValue(db, `assistant${e[0].toUpperCase()}${e.slice(1)}Edits`, false) === true);
}

/** The settings every assistant build reads, one set for the context view, the send and the preview. */
function builderSettings(db) {
    return {
        engines: enabledEngines(db),
        excerptTurns: Number(settingValue(db, 'assistantChatTurns', 20)) || 20,
        systemPrompt: String(settingValue(db, 'assistantSystemPrompt', '') || ''),
        maxContext: Number(settingValue(db, 'assistantMaxContext', 0)) || 0,
        reserveForReply: replyReserve(db),
    };
}

assistantRouter.post('/sessions/:sid/generate', async (req, res) => {
    const db = req.db;
    const session = sessionOr404(req, res);
    if (!session) return undefined;
    // refused before the reply opens, as the chat's generate refuses one
    const askedProfile = namedProfileId(db, req.body?.profileId);

    // stored with the snapshot every later apply is judged against, never a fresh build
    let snapshot = null;

    const reply = openReply(db, res, (text, interrupted, { reasoning }) => {
        text = runHook('reply.final', text, { db, chatId: session.chatId, surface: 'assistant', sessionId: session.id, interrupted: interrupted || null });
        try {
            // parsed here, once, as it is stored; the client never re-reads the fenced blocks
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
        } catch (e) { logStoreFailure('assistant', e); return null; }
    });

    try {
        const profileId = askedProfile || session.profileId;
        const turns = transcriptFor(req.db, session);
        const built = buildAssistantPrompt(db, session.chatId, { transcript: turns, ...builderSettings(db), pictures: sessionPictures(db, pictureScope(db, session), turns, profileId) });
        snapshot = built.context;

        // llm.request is told the chat and the session on both rounds, as reply.final is
        const body = { messages: built.messages, stream: true, purpose: 'assistant', scope: { chatId: session.chatId, sessionId: session.id } };
        if (profileId) body.profileId = profileId;
        const params = withReplyCeiling(db, req.body?.params, profileId);
        if (params) body.params = params;

        let finish = null;
        let msgs = body.messages;
        // at most two model calls: one cl-read round, its turns stored and pushed as 'row' events
        for (let round = 0; ; round++) {
            finish = await reply.pipe(chatStream(db, { ...body, messages: msgs }, reply.signal));
            const content = reply.content;
            const reads = round === 0 ? parseReadRequests(content) : { swipes: [], lore: [] };
            const swipeAns = reads.swipes.length ? readSwipesMessage(db, session.chatId, reads.swipes, built.context.seqs) : null;
            const loreAns = reads.lore.length ? readLoreMessage(db, session.chatId, reads.lore) : null;
            if (!swipeAns && !loreAns) break;
            const request = reply.commit(LENGTH_REASONS.has(finish?.finishReason) ? 'length limit' : null);
            if (request) reply.write('row', request);
            // entries served in full join the asking reply's whitelist and anchor map
            if (loreAns?.servedKeys?.length) {
                const loreAnchors = { ...(snapshot?.loreAnchors || {}) };
                for (const [a, keys] of Object.entries(loreAns.servedAnchors || {})) {
                    loreAnchors[a] = [...(loreAnchors[a] || []), ...keys];
                }
                const loreTitles = { ...(snapshot?.loreTitles || {}), ...(loreAns.servedTitles || {}) };
                snapshot = { ...snapshot, loreFull: [...(snapshot?.loreFull || []), ...loreAns.servedKeys], loreAnchors, loreTitles };
            }
            const answerContent = [swipeAns?.content, loreAns?.content].filter(Boolean).join('\n\n');
            const dataRow = appendMessage(db, session.id, {
                role: 'user',
                content: answerContent,
                extra: {
                    data: 'read',
                    ...(swipeAns ? { seqs: swipeAns.served } : {}),
                    ...(loreAns ? { lore: loreAns.servedKeys } : {}),
                },
            });
            reply.write('row', dataRow);
            msgs = [...msgs, { role: 'assistant', content: request?.message?.content ?? content }, { role: 'user', content: answerContent }];
            reply.next();
        }
        // a ceiling cut is stored as an interruption, so the reply says "cut short"
        const stored = reply.commit(LENGTH_REASONS.has(finish?.finishReason) ? 'length limit' : null);
        reply.end(stored, finish, { message: stored?.message ?? null, seq: stored?.seq ?? null, budget: built.budget });
    } catch (err) {
        reply.fail(err);
    }
    return undefined;
});

/** A reply's proposals judged against the world NOW, recomputed per request, never stored. */
assistantRouter.get('/sessions/:sid/proposals/:seq', (req, res) => {
    const seq = intOf(req.params.seq);
    if (!Number.isInteger(seq) || seq < 0) return res.status(400).json({ error: 'seq must be a non-negative integer' });
    const session = sessionOr404(req, res);
    if (!session) return undefined;
    const msg = session.messages[seq];
    if (!msg) return res.status(404).json({ error: 'no such message' });

    const snapshot = msg.extra?.context || null;
    const applied = msg.extra?.applied || {};
    // What this reply's own applies did to each target, so a leftover proposal is judged
    // against OUR changes rather than reported as the target drifting.
    const self = selfAnchorsFromApplied(applied);
    // and what LATER replies' applied changes rewrote: an earlier proposal on it is superseded
    const later = laterAnchorsForReply(session.messages, seq);
    const proposals = (msg.extra?.proposals || []).map((p) => {
        // an applied proposal isnt re-judged: applying it is what changed its anchor
        if (applied[p.id]?.status === 'applied') {
            const r = applied[p.id].result || {};
            // keep the resolved target, so an applied card never reverts to the mislabel
            const resolved = p.engine === 'lore' && r.world && (r.world !== p.change.world || r.uid !== p.change.uid)
                ? { world: r.world, uid: r.uid }
                : p.engine === 'chat' && Number.isInteger(r.seq) && r.seq !== p.change.seq ? { seq: r.seq } : null;
            // and its NAME, live where the row still exists, else as the write recorded it
            const title = p.engine === 'lore' ? appliedTitle(req.db, r) : undefined;
            return {
                ...p, status: 'applied', appliedAt: applied[p.id].at, result: applied[p.id].result,
                ...(resolved ? { resolved } : {}), ...(title !== undefined ? { title } : {}),
            };
        }
        return { ...p, ...checkProposal(req.db, session.chatId, snapshot, p, self, later) };
    });
    return res.json({ seq, proposals, errors: msg.extra?.proposalErrors || [] });
});

/** Apply chosen proposals from one reply: the only write, each re-checked just before it lands. */
assistantRouter.post('/sessions/:sid/apply', (req, res) => {
    const seq = intOf(req.body?.seq);
    if (!Number.isInteger(seq) || seq < 0) return res.status(400).json({ error: 'seq must be a non-negative integer' });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
    if (!ids || !ids.length) return res.status(400).json({ error: 'ids array required' });
    const session = sessionOr404(req, res);
    if (!session) return undefined;
    const msg = session.messages[seq];
    if (!msg) return res.status(404).json({ error: 'no such message' });

    const already = msg.extra?.applied || {};
    // touch-ups ride the apply, the stored proposal keeps what the model said
    const overrides = (req.body?.overrides && typeof req.body.overrides === 'object') ? req.body.overrides : {};
    const chosen = (msg.extra?.proposals || [])
        .filter(p => ids.includes(p.id) && already[p.id]?.status !== 'applied')
        .map(p => mergeOverrides(p, overrides[p.id]));
    if (!chosen.length) return res.status(400).json({ error: 'nothing to apply (already applied, or no such proposal)' });

    const results = applyProposals(req.db, session.chatId, msg.extra?.context || null, chosen, selfAnchorsFromApplied(already), laterAnchorsForReply(session.messages, seq));

    // recorded on the message so a reopened panel shows it done; extra merges, the snapshot survives
    const at = Date.now();
    const nextApplied = { ...already };
    for (const r of results) nextApplied[r.id] = { status: r.status, at, ...(r.result ? { result: r.result } : {}), ...(r.reason ? { reason: r.reason } : {}) };
    patchMessage(req.db, session.id, seq, { extra: { applied: nextApplied } });

    return res.json({
        results,
        // what the client must refresh, said plainly rather than inferred from the ops
        touched: {
            worlds: [...new Set(results.filter(r => r.status === 'applied' && r.result?.world).map(r => r.result.world))],
            chat: results.some(r => r.status === 'applied' && r.result && 'seq' in r.result),
        },
    });
});

/** What the assistant would be sent right now; same builder, nothing stored. */
assistantRouter.get('/sessions/:sid/prompt', (req, res) => {
    const session = sessionOr404(req, res);
    if (!session) return undefined;
    const turns = transcriptFor(req.db, session);
    const built = buildAssistantPrompt(req.db, session.chatId, { transcript: turns, ...builderSettings(req.db), pictures: sessionPictures(req.db, pictureScope(req.db, session), turns, session.profileId) });
    return res.json({ messages: built.messages, budget: built.budget, context: built.context, pictures: built.pictures });
});
