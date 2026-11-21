import { Router } from 'express';
import { regexWrite, regexWriteAll } from '../lib/regex/chat-passes.js';
import { PLACE, screenPlace } from '../lib/regex/engine.js';
import { skipIfGone } from '../lib/request-guard.js';
import {
    listChats, getChatDetail, replaceChatMessages,
    patchChat, deleteChat, composeChatJsonl, searchChatMessages,
    appendChatMessage,
    patchChatMessage, appendSwipe, removeSwipe, appendToMessage, deleteChatMessage, replaceMessageText,
    chatExists, getChatRow, chatNameTaken, messageRowAt, CHAT_SORTS, SEARCH_PAGE_DEFAULT, SEARCH_PAGE_MAX, formatStDate, projectMessages, reservedMessageKey, refuseUnlessShown,
    shownActiveOf, refuseUnlessActiveShown,
} from '../db/chats-store.js';
import { getCharacter } from '../db/characters-store.js';
import { listWorldsFor, replaceWorldsFor, applyWorldsFor, applyWorldsBatch, applyWorldNames } from '../db/world-links-store.js';
import { resolvePersona } from '../db/personas-store.js';
import { resolveChatProfile, namedProfileId } from '../db/llm-profiles-store.js';
import { branchChat } from '../db/chat-branch.js';
import { createChatWithMacros } from '../db/chat-macros.js';
import {
    buildChatPrompt, commitBuild, macrosForChat, finishFirstMessage, storeSuppliedChat, storeSentTurn, runLoreScan, loreInPrompt,
    chatAuthorsNote, worldSourcesOf,
} from '../llm/prompt.js';
import { noteDefaults, noteSeed } from '../llm/authors-note.js';
import { chatStream } from '../llm/service.js';
import { GENERATE_MODES, triggerOfMode } from '../llm/vocabulary.js';
import { openReply, logStoreFailure } from '../llm/reply-tail.js';
import { settingValue } from '../db/settings-store.js';
import { intOf, boolOf, pageOf } from '../lib/query-params.js';
import { entryUid } from '../lib/world-entry.js';
import { runHook } from '../db/hook-seat.js';

export const chatsRouter = Router();

chatsRouter.get('/', skipIfGone, (req, res) => {
    const { limit, after } = pageOf(req.query);
    const offset = intOf(req.query.offset);
    if (Number.isNaN(offset)) return res.status(400).json({ error: 'offset must be a number' });
    // an unknown sort is refused by name, never a silent fallback
    const sort = req.query.sort ? String(req.query.sort) : undefined;
    if (sort !== undefined && !(sort in CHAT_SORTS)) return res.status(400).json({ error: `sort must be one of: ${Object.keys(CHAT_SORTS).join(', ')}` });
    const order = req.query.order !== undefined ? String(req.query.order) : undefined;
    if (order !== undefined && !['asc', 'desc'].includes(order)) return res.status(400).json({ error: "order must be 'asc' or 'desc'" });
    let rules;
    if (req.query.rules !== undefined) {
        try { rules = JSON.parse(String(req.query.rules)); }
        catch { return res.status(400).json({ error: 'rules must be URL-encoded JSON' }); }
    }
    res.json(listChats(req.db, {
        charId: req.query.charId ? String(req.query.charId) : undefined,
        world: req.query.world ? String(req.query.world) : undefined,
        q: req.query.q ? String(req.query.q) : undefined,
        rules,
        sort, order,
        grouped: boolOf(req.query.grouped, 'grouped') === true,
        count: boolOf(req.query.count, 'count'),
        limit, offset, after,
    }));
});

// registered before /:id so the literal path wins the match
chatsRouter.get('/search', skipIfGone, (req, res) => {
    const { limit } = pageOf(req.query, { def: SEARCH_PAGE_DEFAULT, max: SEARCH_PAGE_MAX, cursor: false });
    const offset = intOf(req.query.offset);
    if (Number.isNaN(offset)) return res.status(400).json({ error: 'offset must be a number' });
    const match = req.query.match ? String(req.query.match) : '';
    const q = req.query.q !== undefined ? String(req.query.q) : undefined;
    if (match && q !== undefined) return res.status(400).json({ error: 'name match or q, not both' });
    if (!match && q === undefined) return res.status(400).json({ error: 'match query required (FTS5 syntax), or q (plain text)' });
    // a query FTS5 refuses is the store's 400, answered by the app's error handler
    res.json(searchChatMessages(req.db, {
        match: match || undefined,
        q,
        charId: req.query.charId ? String(req.query.charId) : undefined,
        count: boolOf(req.query.count, 'count'),
        limit, offset,
    }));
});

// the chat the client has open, for an external caller; registered before /:id
chatsRouter.get('/active', (req, res) => {
    const id = settingValue(req.db, 'activeChatId', null);
    if (!id) return res.status(404).json({ error: 'no active chat' });
    const detail = getChatDetail(req.db, id, { msgTail: 1 });
    if (!detail) return res.status(404).json({ error: 'active chat not found' });
    res.json({ chatId: detail.id, chatName: detail.name, charId: detail.charId, charName: detail.charName });
});

// a single message's answer ({ id, seq, message, ... }), its message a ChatMessage
const messageAnswer = (db, stored) => (stored
    ? { ...stored, message: projectMessages(db, [{ id: stored.id, seq: stored.seq, msg: stored.message }])[0] }
    : stored);

// the id of the message the reader was shown at that seq, since a renumber moves a seq; absent is null
function shownMessageId(v, name, res) {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'string' ? Number(v) : v;
    if (Number.isInteger(n) && n > 0) return n;
    res.status(400).json({ error: `${name} must be a message id (a positive integer)` });
    return undefined;
}

// the keys the native shape gives a message never ride a stored row: they would be exported as JSONL
function refuseReservedKey(res, message) {
    const key = reservedMessageKey(message);
    if (!key) return false;
    res.status(400).json({ error: key === 'raw'
        ? 'raw is the native shape\'s copy of the stored row, never a field of one: send each message\'s raw'
        : 'seq is a message\'s place in its chat, never a field of the message' });
    return true;
}

chatsRouter.get('/:id', (req, res) => {
    const msgLimit = intOf(req.query.msgLimit);
    const msgOffset = intOf(req.query.msgOffset);
    const msgTail = intOf(req.query.msgTail);
    if (Number.isNaN(msgLimit) || Number.isNaN(msgOffset) || Number.isNaN(msgTail)) {
        return res.status(400).json({ error: 'msgLimit/msgOffset/msgTail must be numbers' });
    }
    const detail = getChatDetail(req.db, req.params.id, { msgLimit, msgOffset, msgTail });
    if (!detail) return res.status(404).json({ error: 'chat not found' });
    return res.json(detail);
});

// the first message on the reader's screen; absent is null, anything but a seq is refused
const firstShownOf = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'string' ? Number(v) : v;
    return Number.isInteger(n) && n >= 0 ? n : NaN;
};
const FIRST_SHOWN_ERROR = 'firstShown must be a message seq';

/** The prompt this chat would send now, with what the budget did; built on demand, stored nowhere. */
chatsRouter.get('/:id/prompt', (req, res) => {
    if (!chatExists(req.db, req.params.id)) return res.status(404).json({ error: 'chat not found' });
    const firstShown = firstShownOf(req.query.firstShown);
    if (Number.isNaN(firstShown)) return res.status(400).json({ error: FIRST_SHOWN_ERROR });
    const built = buildChatPrompt(req.db, req.params.id, { firstDisplayed: firstShown });
    res.json({
        charName: built.charName,
        userName: built.userName,
        budget: built.budget,
        // what became of the window's pictures: sent, stood in as text, or withheld from a connection that does not see
        pictures: built.pictures,
        // a message holding a macro nothing answers names it; the text is sent as it is
        messages: built.messages.map((m) => { const unanswered = built.unanswered(m.content); return unanswered.length ? { ...m, unanswered } : m; }),
    });
});

// the chat's Author's Note as the next build reads it; written through the metadata PATCH
chatsRouter.get('/:id/authors-note', (req, res) => {
    const chatRow = getChatRow(req.db, req.params.id);
    if (!chatRow) return res.status(404).json({ error: 'chat not found' });
    res.json(chatAuthorsNote(req.db, chatRow));
});

/** What the lore engine would do for this chat right now, through the prompt's own runLoreScan. */
chatsRouter.get('/:id/lore', (req, res) => {
    const db = req.db;
    const chatRow = getChatRow(db, req.params.id);
    if (!chatRow) return res.status(404).json({ error: 'chat not found' });

    // always a dry run: rolls carry their odds and timed state never persists; only generate advances it
    const scan = runLoreScan(db, chatRow, { dryRun: true });
    const { lore: selected, worlds, candidates, src, settings, visible } = scan;
    const chatLen = visible.length;

    // "fired" means in the prompt (loreInPrompt), not merely selected; what isnt sent gets a note
    const placed = loreInPrompt(db, req.params.id, selected);
    const notes = [...selected.notes, ...placed.notes];
    const fired = new Map();
    const pending = new Map();
    const groupPending = new Map();
    const firedVia = new Map();
    const outletOf = new Map();
    for (const [key, { group, placed: c, outlet }] of placed.inPrompt) {
        fired.set(key, group);
        if (outlet) outletOf.set(key, outlet);
        if (c.probabilityPending != null) pending.set(key, c.probabilityPending);
        if (c.groupPending != null) groupPending.set(key, c.groupPending);
        if (c.firedVia) firedVia.set(key, c.firedVia);
    }
    // the window index mapped to a seq; a feeder's comment inlined so the panel needs no second lookup
    const commentOf = new Map();
    for (const w of [...worlds, ...candidates]) {
        for (const [key, e] of Object.entries(w.data?.entries || {})) {
            commentOf.set(`${w.name}::${entryUid(key, e)}`, e?.comment || '');
        }
    }
    const projectFiredVia = (v) => {
        if (!v) return null;
        if (v.kind === 'chat') {
            const row = visible[v.messageIndex];
            return { kind: 'chat', messageSeq: row ? row.seq : null };
        }
        if (v.kind === 'recursion') {
            return {
                kind: 'recursion', feederWorld: v.feederWorld, feederUid: v.feederUid,
                feederComment: commentOf.get(`${v.feederWorld}::${v.feederUid}`) || '',
            };
        }
        return v;
    };
    const suppReason = new Map((selected.suppressed || []).map(s => [`${s.world}::${s.uid}`, s.reason]));
    // turns left on sticky/cooldown; the "world.uid" key is looked up, never parsed, since names carry dots
    const timedRemaining = (worldName, uid) => {
        const out = {};
        for (const type of ['sticky', 'cooldown']) {
            const v = selected.timedState?.[type]?.[`${worldName}.${uid}`];
            const left = v ? Number(v.end) - chatLen : 0;
            out[type] = left > 0 ? left : null;
        }
        return out;
    };

    // everything the engine honours, since the panel edits it; the nullable three pass null through (inherit)
    const projectEntry = (worldName, e, uid) => ({
        uid,
        comment: e.comment || '',
        keys: Array.isArray(e.key) ? e.key : [],
        secondaryKeys: Array.isArray(e.keysecondary) ? e.keysecondary : [],
        content: typeof e.content === 'string' ? e.content : '',
        disable: !!e.disable,
        constant: !!e.constant,
        position: e.position ?? 0,
        order: e.order ?? 0,
        depth: Number.isInteger(e.depth) ? e.depth : null,
        selective: e.selective !== false,
        selectiveLogic: e.selectiveLogic ?? 0,
        role: e.role ?? 0,
        scanDepth: Number.isInteger(e.scanDepth) ? e.scanDepth : null,
        caseSensitive: typeof e.caseSensitive === 'boolean' ? e.caseSensitive : null,
        matchWholeWords: typeof e.matchWholeWords === 'boolean' ? e.matchWholeWords : null,
        fired: fired.has(`${worldName}::${uid}`),
        // the outlet a fired outlet entry is held for, which places it where {{outlet::name}} is written
        outlet: outletOf.get(`${worldName}::${uid}`) || null,
        // why it fired, from the engine's own matcher
        firedVia: projectFiredVia(firedVia.get(`${worldName}::${uid}`)),
        // a roll still ahead at send: the panel shows the odds
        probabilityPending: pending.get(`${worldName}::${uid}`) ?? null,
        // One member of a weighted inclusion group still rolling for its group at send: its odds of winning.
        groupPending: groupPending.get(`${worldName}::${uid}`) ?? null,
        // Why an entry that might otherwise fire was held back this scan.
        suppressedReason: suppReason.get(`${worldName}::${uid}`) || null,
        // Remaining turns of an active sticky/cooldown, null when not running.
        timed: timedRemaining(worldName, uid),
        // HONOURED by the engine now; sent so the panel can chip them. Names are
        // ST's, nullable fields stay null (= inherit), never coerced.
        advanced: {
            probability: e.probability ?? null,
            useProbability: e.useProbability ?? null,
            sticky: e.sticky ?? null,
            cooldown: e.cooldown ?? null,
            delay: e.delay ?? null,
            group: e.group || '',
            groupWeight: e.groupWeight ?? null,
            groupOverride: e.groupOverride ?? null,
            useGroupScoring: e.useGroupScoring ?? null,
            excludeRecursion: e.excludeRecursion ?? null,
            preventRecursion: e.preventRecursion ?? null,
            delayUntilRecursion: e.delayUntilRecursion ?? null,
            ignoreBudget: e.ignoreBudget ?? null,
            outletName: e.outletName || '',
            triggers: Array.isArray(e.triggers) ? e.triggers : [],
            characterFilter: e.characterFilter && typeof e.characterFilter === 'object' ? e.characterFilter : null,
            // Raw booleans under ST's own names: the panel EDITS these, and a
            // display list written back would store labels as config.
            matchFlags: {
                matchPersonaDescription: !!e.matchPersonaDescription,
                matchCharacterDescription: !!e.matchCharacterDescription,
                matchCharacterPersonality: !!e.matchCharacterPersonality,
                matchCharacterDepthPrompt: !!e.matchCharacterDepthPrompt,
                matchScenario: !!e.matchScenario,
                matchCreatorNotes: !!e.matchCreatorNotes,
            },
        },
        // stored and preserved, but not acted on (no vector store, no Quick Reply); a field leaves by becoming real
        notHonoured: {
            vectorized: e.vectorized ?? null,
            automationId: e.automationId || '',
        },
    });

    res.json({
        chatId: req.params.id,
        charId: chatRow.char_id,
        // the resolved persona's identity, since the panel's unlink writes that persona's list
        persona: src.persona ? { id: src.persona.id, name: src.persona.name } : null,
        settings,
        scannedMessages: chatLen,
        notes,
        worlds: worlds.map(w => ({
            name: w.name,
            placeholder: !!w.placeholder,
            // A book can be reached by several routes; the client shows it once and says so.
            sources: worldSourcesOf(src, w.name),
            entries: Object.entries(w.data?.entries || {}).map(([key, e]) => projectEntry(w.name, e, entryUid(key, e))),
        })),
        // an extension's own books in this scan (ext:<id>:<label>), listed read-only
        extensionBooks: candidates.map(b => ({
            name: b.name,
            extension: b.name.slice(4, b.name.indexOf(':', 4)),
            label: b.name.slice(b.name.indexOf(':', 4) + 1),
            entries: Object.entries(b.data?.entries || {}).map(([key, e]) => projectEntry(b.name, e, entryUid(key, e))),
        })).filter(b => b.entries.length),
    });
});

chatsRouter.put('/:id/messages', (req, res) => {
    const messages = req.body?.messages;
    if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
    if (!messages.every(m => m && typeof m === 'object' && !Array.isArray(m))) {
        return res.status(400).json({ error: 'every message must be an object' });
    }
    if (messages.some(m => refuseReservedKey(res, m))) return undefined;
    const ok = replaceChatMessages(req.db, req.params.id, messages);
    if (!ok) return res.status(404).json({ error: 'chat not found' });
    return res.json({ ok: true });
});

// append one user turn, macros expanded once and stored expanded (ST's send); the server stamps identity
chatsRouter.post('/:id/messages', (req, res) => {
    const mes = typeof req.body?.mes === 'string' ? req.body.mes.trim() : '';
    // the chat's pictures the turn shows, ids from its gallery; a turn of pictures alone has no text
    const attachments = req.body?.attachments ?? [];
    if (!Array.isArray(attachments)) return res.status(400).json({ error: 'attachments are a list of the chat\'s attachment ids' });
    if (!mes && !attachments.length) return res.status(400).json({ error: 'mes text or attachments required' });
    const firstShown = firstShownOf(req.body?.firstShown);
    if (Number.isNaN(firstShown)) return res.status(400).json({ error: FIRST_SHOWN_ERROR });
    const db = req.db;
    const row = getChatRow(db, req.params.id);
    if (!row) return res.status(404).json({ error: 'chat not found' });
    const typed = regexWrite(db, row.id, mes, { where: PLACE.userInput });
    return res.json(messageAnswer(db, storeSentTurn(db, row, typed, { firstDisplayed: firstShown, attachments })));
});

// One message, addressed by its row seq. The whole-list PUT above rewrites every row, and
// every FTS entry with it, for a one-word edit.
chatsRouter.patch('/:id/messages/:seq', (req, res) => {
    const seq = intOf(req.params.seq);
    if (!Number.isInteger(seq) || seq < 0) return res.status(400).json({ error: 'seq must be a non-negative integer' });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ error: 'a message patch object is required' });
    }
    // what the reader was shown rides beside the fields, never as one of them
    const { shown: named, ...patch } = req.body;
    if (refuseReservedKey(res, patch)) return undefined;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'patch is empty' });
    if ('swipes' in patch && patch.swipes !== null && !Array.isArray(patch.swipes)) {
        return res.status(400).json({ error: 'swipes must be an array' });
    }
    if ('swipe_id' in patch && patch.swipe_id !== null && !Number.isInteger(patch.swipe_id)) {
        return res.status(400).json({ error: 'swipe_id must be an integer' });
    }
    const messageId = shownMessageId(req.query.messageId, 'messageId', res);
    if (messageId === undefined) return undefined;
    const shown = shownActiveOf(named);
    const chatRow = getChatRow(req.db, req.params.id);
    if (!chatRow) return res.status(404).json({ error: 'chat not found' });
    // the first message is kept expanded (ST's display); another message at that seq, or another active alternate, is a 409
    const opts = { messageId, shown, ...(seq === 0 ? { finish: finishFirstMessage(req.db, chatRow) } : {}) };
    if (typeof patch.mes === 'string') markEdited(req.db, req.params.id, seq, patch);
    const result = patchChatMessage(req.db, req.params.id, seq, patch, opts);
    if (!result) return res.status(404).json({ error: 'no such message' });
    return res.json(messageAnswer(req.db, result));
});

// an edit through the message editor: the reader's words, marked so read-time text scripts leave them to the run-on-edit ones
function markEdited(db, chatId, seq, patch) {
    const held = messageRowAt(db, chatId, seq);
    const msg = held ? JSON.parse(held.data) : null;
    if (!msg || msg.mes === patch.mes) return;
    // a narrator's line edits at Narrator with no sender standing for {{char}}, as ST edits it
    const narrator = screenPlace(msg) === PLACE.narrator;
    patch.mes = regexWrite(db, chatId, patch.mes, { pass: 'edit', where: screenPlace(msg), charName: narrator ? undefined : msg.name });
    patch.extra = { ...(patch.extra && typeof patch.extra === 'object' ? patch.extra : {}), edited: Date.now() };
}

chatsRouter.delete('/:id/messages/:seq', (req, res) => {
    const seq = intOf(req.params.seq);
    if (!Number.isInteger(seq) || seq < 0) return res.status(400).json({ error: 'seq must be a non-negative integer' });
    const messageId = shownMessageId(req.query.messageId, 'messageId', res);
    if (messageId === undefined) return undefined;
    if (!chatExists(req.db, req.params.id)) return res.status(404).json({ error: 'chat not found' });
    const seqs = deleteChatMessage(req.db, req.params.id, seq, { messageId });
    if (!seqs) return res.status(404).json({ error: 'no such message' });
    return res.json({ ok: true, seqs });
});

// One alternate added to a message, or one dropped, each naming what the reader was shown; a stale page is refused 409
chatsRouter.post('/:id/messages/:seq/swipes', (req, res) => {
    const seq = intOf(req.params.seq);
    if (!Number.isInteger(seq) || seq < 0) return res.status(400).json({ error: 'seq must be a non-negative integer' });
    const { text, count } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text required: the alternate added' });
    if (!Number.isInteger(count) || count < 1) return res.status(400).json({ error: 'count must be the alternates shown (1 for a message with none)' });
    const messageId = shownMessageId(req.body?.messageId, 'messageId', res);
    if (messageId === undefined) return undefined;
    const chatRow = getChatRow(req.db, req.params.id);
    if (!chatRow) return res.status(404).json({ error: 'chat not found' });
    const finish = seq === 0 ? finishFirstMessage(req.db, chatRow) : null;
    const result = appendSwipe(req.db, req.params.id, seq, text, { count, messageId, finish });
    if (!result) return res.status(404).json({ error: 'no such message' });
    return res.json(messageAnswer(req.db, result));
});

chatsRouter.post('/:id/messages/:seq/swipes/delete', (req, res) => {
    const seq = intOf(req.params.seq);
    if (!Number.isInteger(seq) || seq < 0) return res.status(400).json({ error: 'seq must be a non-negative integer' });
    const messageId = shownMessageId(req.body?.messageId, 'messageId', res);
    if (messageId === undefined) return undefined;
    const chatRow = getChatRow(req.db, req.params.id);
    if (!chatRow) return res.status(404).json({ error: 'chat not found' });
    const { index, text, count } = req.body || {};
    const finish = seq === 0 ? finishFirstMessage(req.db, chatRow) : null;
    const result = removeSwipe(req.db, req.params.id, seq, { index, text, count, messageId, finish });
    if (!result) return res.status(404).json({ error: 'no such message' });
    return res.json(messageAnswer(req.db, result));
});

// Generate the next assistant turn over normalized SSE. the mode decides the write's shape, and one committer serves every ending
chatsRouter.post('/:id/generate', async (req, res) => {
    const db = req.db;
    const chatId = req.params.id;
    let charName = 'Character';

    const mode = typeof req.body?.mode === 'string' ? req.body.mode : 'append';
    if (!GENERATE_MODES.includes(mode)) {
        return res.status(400).json({ error: `mode must be one of ${GENERATE_MODES.join(', ')}` });
    }
    const firstShown = firstShownOf(req.body?.firstShown);
    if (Number.isNaN(firstShown)) return res.status(400).json({ error: FIRST_SHOWN_ERROR });
    // every mode answers a missing chat alike, ahead of the branch (append's prompt build would say 400)
    if (!chatExists(db, chatId)) return res.status(404).json({ error: 'chat not found' });
    // a one-off connection is refused before anything is built, so a bad one commits no lore timer or variable
    const askedProfile = namedProfileId(db, req.body?.profileId);

    // resolved before the close handler is armed, or a hang-up commits the partial in the wrong shape
    let targetSeq = null;
    // the target row's bytes as chosen; the commit refuses on any difference, since a delete renumbers seqs
    let targetData = null;
    // the direction the target's shown alternate was written to, which a swipe or a reroll of it follows
    let targetGuidance = '';
    if (mode === 'swipe' || mode === 'continue' || mode === 'regenerate') {
        const asked = req.body?.targetSeq == null ? undefined : intOf(req.body.targetSeq);
        if (Number.isNaN(asked)) return res.status(400).json({ error: 'targetSeq must be a number' });
        const targetId = shownMessageId(req.body?.targetId, 'targetId', res);
        if (targetId === undefined) return undefined;
        const targetShown = shownActiveOf(req.body?.targetShown, 'targetShown');
        const row = messageRowAt(db, chatId, asked === undefined ? null : asked);
        if (!row) return res.status(404).json({ error: 'no such message' });
        // the message and the alternate the reader was shown (409 before the model is asked); the bytes check covers the stream
        refuseUnlessShown(row, targetId);
        let target = null;
        try { target = JSON.parse(row.data); } catch { target = null; }
        refuseUnlessActiveShown(target, targetShown);
        const usable = target && !target.is_user && !target.is_system;
        // swipe and continue need an assistant row; a reroll on the user's turn just has nothing to replace
        if (!usable) {
            if (mode !== 'regenerate' || req.body?.targetSeq != null) {
                return res.status(400).json({ error: `${mode} targets an assistant message` });
            }
        } else {
            targetSeq = row.seq;
            targetData = row.data;
            if (mode !== 'continue' && typeof target.extra?.guidance === 'string') targetGuidance = target.extra.guidance.trim();
        }
    }
    // the composer's direction for impersonate or a directed reply; the build turns it into the trailing instruction
    const guidance = (typeof req.body?.guidance === 'string' ? req.body.guidance.trim() : '') || targetGuidance;

    // store what arrived in the mode's shape (openReply runs it once); null when nothing streamed
    let targetConflict = false;
    let draft = null;
    // the chat's preset's settings, once the build has read them (a continue joins on its joiner)
    let presetSettings = null;
    const reply = openReply(db, res, (text, interrupted, { reasoning, usage }) => {
        // impersonate is a draft for the composer, never a stored turn; it takes the reader's text scripts first
        if (mode === 'impersonate') { draft = regexWrite(db, chatId, text, { pass: 'draft', where: PLACE.userInput }); return null; }
        // an extension may rewrite the reply before its stored (the client adopts the stored row)
        text = regexWrite(db, chatId, text, { where: PLACE.aiOutput });
        reasoning = regexWrite(db, chatId, reasoning, { where: PLACE.reasoning });
        text = runHook('reply.final', text, { db, chatId, surface: 'chat', mode, interrupted: interrupted || null });
        // Verify-then-write is atomic here: the store calls are synchronous on the same
        // connection, so nothing can interleave between this read and the write below.
        if (Number.isInteger(targetSeq) && targetData !== null) {
            const live = messageRowAt(db, chatId, targetSeq);
            if (!live || live.data !== targetData) { targetConflict = true; return null; }
        }
        try {
            if (mode === 'swipe') return appendSwipe(db, chatId, targetSeq, text, { interrupted, reasoning, usage, guidance });
            if (mode === 'continue') {
                // stored as SillyTavern stores a continued reply: the text so far as its text scripts wrote it, the new part cleaned the same way
                const held = JSON.parse(targetData);
                const [base] = regexWriteAll(db, chatId, [held.mes], { pass: 'written', where: PLACE.aiOutput, edited: !!held.extra?.edited });
                let [more] = regexWriteAll(db, chatId, [text], { pass: 'written', where: PLACE.aiOutput });
                // the preset's joiner goes between the text so far and the new part, unless the text ends on a space
                if (presetSettings?.continueJoiner && !String(held.mes ?? '').endsWith(' ')) more = presetSettings.continueJoiner + more;
                return appendToMessage(db, chatId, targetSeq, more, { interrupted, reasoning, usage, base });
            }
            if (mode === 'regenerate' && Number.isInteger(targetSeq)) {
                return replaceMessageText(db, chatId, targetSeq, text, { interrupted, reasoning, usage, guidance });
            }
            return appendChatMessage(db, chatId, {
                name: charName,
                is_user: false,
                is_system: false,
                send_date: Date.now(),
                mes: text,
                extra: {
                    ...(interrupted ? { interrupted } : {}),
                    ...(reasoning.trim() ? { reasoning } : {}),
                    ...(usage ? { usage } : {}),
                    ...(guidance ? { guidance } : {}),
                },
            });
        } catch (e) { logStoreFailure('chats', e); return null; } // storing the partial must never mask the original error
    });

    try {
        // a reroll's target is left out of the prompt, not deleted, so a stop keeps the reply on screen
        const rewriting = mode === 'regenerate' && Number.isInteger(targetSeq);
        // the connection that answers: the request's, else the chat's own, else the default; the budget and the call read the same one
        const profileId = askedProfile || resolveChatProfile(db, chatId).row?.id || null;
        const built = buildChatPrompt(db, chatId, {
            // The budget belongs to the model, so the profile that will ANSWER decides it.
            profileId,
            ...((mode === 'swipe' || rewriting) ? { excludeSeq: targetSeq } : {}),
            ...(mode === 'continue' ? { continueSeq: targetSeq } : {}),
            // The ONE non-dry lore scan: probability really rolls, and sticky/cooldown
            // state advances.
            trigger: triggerOfMode(mode),
            loreDryRun: false,
            // {{input}}: the direction for impersonate or a directed reply (its swipes and rerolls too), nothing for a sent turn
            input: guidance,
            firstDisplayed: firstShown,
        });
        charName = built.charName;
        presetSettings = built.settings;
        // commit the build's side effects before the stream; an expiry that never lands resurrects a sticky
        commitBuild(db, chatId, built.commit);
        // a Continue on the greeting re-reads its target, which the build just rewrote, or it conflicts
        if (targetSeq === 0 && built.commit.firstMessage !== null) targetData = messageRowAt(db, chatId, 0)?.data ?? targetData;
        // llm.request is told the chat and the mode, as reply.final is
        const body = { messages: built.messages, stream: true, purpose: 'chat', scope: { chatId, mode } };
        if (profileId) body.profileId = profileId;
        // samplers are the connection's, never the preset's: the profile's defaults under this request's overrides
        if (req.body?.params) body.params = req.body.params;

        const finish = await reply.pipe(chatStream(db, body, reply.signal));
        const stored = reply.commit(null, finish?.usage ?? null);
        // a reply that couldnt land is a failure, never a quiet done the client would settle away
        if (targetConflict) {
            reply.write('error', { kind: 'conflict', message: 'The chat changed while the reply was writing, so it was not stored.' });
            res.end();
            return;
        }
        // impersonate is the one by-design null: a draft for the composer, never a row
        const first = built.commit.firstMessage !== null ? messageRowAt(db, chatId, 0) : null;
        reply.end(stored, finish, {
            ...(finish || {}),
            message: messageAnswer(db, stored)?.message ?? null,
            id: stored?.id ?? null,
            seq: stored?.seq ?? null,
            swipeId: stored?.swipeId ?? null,
            budget: built.budget,
            // the greeting this build rewrote, for the asking tab, since the feed skips a tab's own writes
            ...(first ? { firstMessage: messageAnswer(db, { id: first.id, seq: first.seq, message: JSON.parse(first.data) }).message } : {}),
            ...(mode === 'impersonate' ? { draft } : {}),
        }, { expectsRow: mode !== 'impersonate' });
    } catch (err) {
        reply.fail(err);
    }
});

// A new chat that goes on from one message of this one, carrying the chat with it (chat-branch.js).
chatsRouter.post('/:id/branch', (req, res) => {
    const seq = req.body?.seq;
    if (!Number.isInteger(seq) || seq < 0) return res.status(400).json({ error: 'seq must be a message seq (a non-negative integer)' });
    const swipeId = req.body?.swipeId ?? null;
    if (swipeId !== null && (!Number.isInteger(swipeId) || swipeId < 0)) return res.status(400).json({ error: 'swipeId must be an alternate index (a non-negative integer)' });
    const messageId = shownMessageId(req.body?.messageId, 'messageId', res);
    if (messageId === undefined) return undefined;
    if (!chatExists(req.db, req.params.id)) return res.status(404).json({ error: 'chat not found' });
    // another message at that seq than the one the reader branched from refuses it in the store (409)
    const branch = branchChat(req.db, req.paths, req.params.id, seq, { swipeId, messageId });
    if (!branch) return res.status(404).json({ error: 'no such message' });
    return res.json(getChatDetail(req.db, branch.id));
});

chatsRouter.patch('/:id', (req, res) => {
    // the store's refusals carry their status, which the app's handler answers
    patchChat(req.db, req.params.id, {
        name: req.body?.name,
        chatMetadata: req.body?.chatMetadata,
        personaId: req.body?.personaId,
        profileId: req.body?.profileId,
        presetId: req.body?.presetId,
        draft: req.body?.draft,
    });
    res.json({ ok: true });
});

// The chat's own lorebooks, an ordered list; apply is the atomic add/remove
chatsRouter.get('/:id/worlds', (req, res) => {
    if (!chatExists(req.db, req.params.id)) return res.status(404).json({ error: 'chat not found' });
    res.json(listWorldsFor(req.db, 'chat', req.params.id));
});

chatsRouter.put('/:id/worlds', (req, res) => {
    if (!chatExists(req.db, req.params.id)) return res.status(404).json({ error: 'chat not found' });
    res.json({ ok: true, worlds: replaceWorldsFor(req.db, 'chat', req.params.id, req.body?.worlds) });
});

chatsRouter.post('/:id/worlds/apply', (req, res) => {
    if (!chatExists(req.db, req.params.id)) return res.status(404).json({ error: 'chat not found' });
    const add = applyWorldNames(req.body?.add, 'add');
    const remove = applyWorldNames(req.body?.remove, 'remove');
    if (!add.length && !remove.length) return res.status(400).json({ error: 'nothing to add or remove' });
    const delta = applyWorldsFor(req.db, 'chat', req.params.id, { add, remove });
    res.json({ ok: true, ...delta, worlds: listWorldsFor(req.db, 'chat', req.params.id) });
});

const CHAT_WORLDS_MAX_IDS = 1000;

// add or remove books on a set of chats in one transaction; an unknown book is a 400 before any write
chatsRouter.post('/worlds/apply', (req, res) => {
    const { chatIds } = req.body || {};
    if (!Array.isArray(chatIds) || chatIds.length === 0) return res.status(400).json({ error: 'chatIds array required' });
    if (chatIds.length > CHAT_WORLDS_MAX_IDS) return res.status(400).json({ error: `chatIds names at most ${CHAT_WORLDS_MAX_IDS} chats a request` });
    const add = applyWorldNames(req.body.add, 'add');
    const remove = applyWorldNames(req.body.remove, 'remove');
    if (!add.length && !remove.length) return res.status(400).json({ error: 'nothing to add or remove' });
    const out = applyWorldsBatch(req.db, 'chat', chatIds, { add, remove });
    res.json({ ok: true, ...out, deltas: out.deltas.map(d => ({ ...d, worlds: listWorldsFor(req.db, 'chat', d.chatId) })) });
});

chatsRouter.delete('/:id', (req, res) => {
    const ok = deleteChat(req.db, req.paths, req.params.id);
    if (!ok) return res.status(404).json({ error: 'chat not found' });
    res.json({ ok: true });
});

chatsRouter.get('/:id/export', (req, res) => {
    const db = req.db;
    const chat = getChatRow(db, req.params.id);
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    const jsonl = composeChatJsonl(db, req.params.id);
    const ascii = chat.name.replace(/[^\x20-\x7E]/g, '_').replace(/[\\"]/g, '_') || 'chat';
    res.setHeader('Content-Type', 'application/jsonl; charset=utf-8');
    res.setHeader('Content-Disposition',
        `attachment; filename="${ascii}.jsonl"; filename*=UTF-8''${encodeURIComponent(chat.name)}.jsonl`);
    return res.send(jsonl);
});

// mounted at /api/characters/:id/chats
export const characterChatsRouter = Router({ mergeParams: true });

// Start a chat: header from the card + settings, message 0 = the greetings as written, the
// showing one expanded as ST's display expands a first message
characterChatsRouter.post('/', (req, res) => {
    const db = req.db;
    const char = getCharacter(db, req.params.id);
    if (!char) return res.status(404).json({ error: 'character not found' });
    const card = char.card?.data || {};
    const charName = card.name || char.name || 'Character';
    // null chat: a chat being created has no override, but the one resolver still answers
    const activePersona = resolvePersona(db, null).persona;
    // Same precedence as assembly: the active persona is the authority for {{user}}.
    const userName = activePersona?.name || 'User';

    const name = (typeof req.body?.name === 'string' && req.body.name.trim())
        ? req.body.name.trim()
        : `${charName} - ${formatStDate()}`;
    if (chatNameTaken(db, req.params.id, name)) {
        return res.status(409).json({ error: 'a chat with that name already exists for this character' });
    }

    // a supplied message list wins; only a bare start seeds the greeting
    const supplied = req.body?.messages;
    if (supplied !== undefined && !Array.isArray(supplied)) {
        return res.status(400).json({ error: 'messages must be an array' });
    }
    if (Array.isArray(supplied) && !supplied.every(m => m && typeof m === 'object' && !Array.isArray(m))) {
        return res.status(400).json({ error: 'every message must be an object' });
    }
    if (Array.isArray(supplied) && supplied.some(m => refuseReservedKey(res, m))) return undefined;
    // a copy, never a spread into push: a restored chat can hold more messages than an argument list
    const messages = Array.isArray(supplied) ? supplied.slice() : [];
    // a new chat starts from the default Author's Note, as ST copies it into a chat that has none
    const chatMetadata = noteSeed({}, noteDefaults(db));
    let globals = null;
    if (!Array.isArray(supplied) && typeof card.first_mes === 'string' && card.first_mes.trim()) {
        // alternate greetings are message 0's swipes; written only when there is more than one
        const greetings = [card.first_mes, ...(Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [])]
            .filter(g => typeof g === 'string' && g.trim());
        const greeting = {
            name: charName,
            is_user: false,
            is_system: false,
            send_date: Date.now(),
            mes: greetings[0],
            ...(greetings.length > 1 ? { swipes: greetings, swipe_id: 0 } : {}),
            extra: {},
        };
        // the showing greeting is expanded as ST's display does, the others stay as written until chosen
        const macros = macrosForChat(db, { id: null, name, char_id: req.params.id, chat_metadata: '{}' }, { chat: [greeting] });
        greeting.mes = macros.expand(greeting.mes);
        const changes = macros.changes();
        Object.assign(chatMetadata, changes.metadata);
        globals = changes.globals;
        messages.push(greeting);
    }
    const supHeader = (req.body?.header && typeof req.body.header === 'object') ? req.body.header : {};
    const header = {
        user_name: userName,
        character_name: charName,
        create_date: Date.now(),
        chat_metadata: chatMetadata,
        ...supHeader,
    };
    // the chat and its greeting's macro writes land in one write or neither; a supplied list too
    const chat = { charId: req.params.id, name, header, messages };
    const { id } = Array.isArray(supplied) ? storeSuppliedChat(db, chat) : createChatWithMacros(db, chat, { globals });
    if (!Array.isArray(supplied)) regexGreetings(db, id);
    return res.json(getChatDetail(db, id));
});

// a made chat's greeting and its alternates through the scripts that change what is saved; a supplied list is kept as given
function regexGreetings(db, chatId) {
    const held = messageRowAt(db, chatId, 0);
    const msg = held ? JSON.parse(held.data) : null;
    if (!msg || msg.is_user || msg.is_system) return;
    const [mes, ...rest] = regexWriteAll(db, chatId, [msg.mes, ...(Array.isArray(msg.swipes) ? msg.swipes : [])], { where: PLACE.aiOutput });
    const swipes = Array.isArray(msg.swipes) ? rest : null;
    const changed = mes !== msg.mes || (swipes && swipes.some((t, i) => t !== msg.swipes[i]));
    if (changed) patchChatMessage(db, chatId, 0, { mes, ...(swipes ? { swipes } : {}) });
}
