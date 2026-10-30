import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { listKinds, validKinds } from '../llm/registry.js';
import { chat, chatStream, testProfile, testVision, listModels } from '../llm/service.js';
import { answerReplyFailure } from '../llm/reply-tail.js';
import { normalizeParams } from '../llm/params.js';
import { sseOpen, sseWrite } from '../llm/sse.js';
import { listProfiles, getProfile, createProfile, patchProfile, deleteProfile, duplicateProfile, resolveChatProfile, toProfile } from '../db/llm-profiles-store.js';
import { httpError } from '../lib/http-error.js';

// HTTP + validation only. Generation logic lives in server/llm/service.js,
// wire shapes in server/llm/adapters/. Keys are write-only: no response ever
// carries one (hasKey boolean instead).

export const llmRouter = Router();

// a positive token count, or null for the app's budget; anything else is refused, never read as a clear
function cleanContextSize(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw httpError(400, 'contextSize must be a positive number of tokens, or null for the app\'s budget');
    return Math.round(n);
}

// a whole number of pictures, or null for no limit; anything else is refused, never rounded into one
function cleanMaxImages(v) {
    if (v === null || v === undefined || v === '') return null;
    if (!Number.isInteger(v) || v <= 0) throw httpError(400, 'maxImages must be a whole number of pictures above zero, or null for no limit');
    return v;
}

// true or false as the reader said or a list reported, null for not known; anything else is refused, never read as one of them
function cleanVision(v) {
    if (v === null || v === true || v === false) return v;
    throw httpError(400, 'vision must be true, false, or null for not known');
}

// absent keeps, null clears, an object is validated as a request's, so a profile never holds what a call refuses
function cleanParams(input) {
    if (input === undefined) return undefined;
    if (input === null) return {};
    if (typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'params must be an object, or null to clear them');
    return normalizeParams({ params: input });
}

function cleanName(v) {
    if (typeof v !== 'string' || !v.trim()) throw httpError(400, 'name required');
    return v;
}

// the app's kinds and the ones this account's extensions add
llmRouter.get('/kinds', (req, res) => {
    res.json(listKinds(req.db));
});

llmRouter.get('/profiles', (req, res) => {
    res.json(listProfiles(req.db));
});

// `override` is the chat's raw pointer and `defaultId` the chats' default, so a client tells set-here from inherited
llmRouter.get('/profiles/resolve', (req, res) => {
    const chatId = req.query.chatId ? String(req.query.chatId) : null;
    const { row, source, override, defaultId } = resolveChatProfile(req.db, chatId);
    res.json({ profile: toProfile(row), source, override, defaultId });
});

llmRouter.post('/profiles', (req, res) => {
    const { name, kind = 'openai', baseUrl = '', apiKey = '', model = '', params, contextSize, vision = null, maxImages } = req.body || {};
    cleanName(name);
    const kinds = validKinds(req.db);
    if (!kinds.includes(kind)) return res.status(400).json({ error: `kind must be one of: ${kinds.join(', ')}` });
    let cleaned;
    cleaned = cleanParams(params) ?? {};
    res.json(createProfile(req.db, {
        id: randomUUID(), name, kind, baseUrl, apiKey, model,
        params: cleaned,
        contextSize: cleanContextSize(contextSize),
        vision: cleanVision(vision),
        maxImages: cleanMaxImages(maxImages),
    }));
});

llmRouter.patch('/profiles/:id', (req, res) => {
    if (!getProfile(req.db, req.params.id)) return res.status(404).json({ error: 'profile not found' });
    const b = req.body || {};
    const kinds = validKinds(req.db);
    if (b.kind !== undefined && !kinds.includes(b.kind)) {
        return res.status(400).json({ error: `kind must be one of: ${kinds.join(', ')}` });
    }
    if (b.name !== undefined) cleanName(b.name);
    let cleaned;
    cleaned = cleanParams(b.params);
    res.json(patchProfile(req.db, req.params.id, {
        name: b.name, kind: b.kind, baseUrl: b.baseUrl, model: b.model,
        // apiKey is write-only: absent leaves it, '' or null clears it
        apiKey: b.apiKey,
        params: cleaned,
        contextSize: b.contextSize !== undefined ? cleanContextSize(b.contextSize) : undefined,
        vision: b.vision !== undefined ? cleanVision(b.vision) : undefined,
        maxImages: b.maxImages !== undefined ? cleanMaxImages(b.maxImages) : undefined,
    }));
});

// The copy is made server-side so the key rides along; a name in the body, else "<name> copy".
llmRouter.post('/profiles/:id/duplicate', (req, res) => {
    const src = getProfile(req.db, req.params.id);
    if (!src) return res.status(404).json({ error: 'profile not found' });
    const typed = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    res.json(duplicateProfile(req.db, req.params.id, { newId: randomUUID(), name: typed || `${src.name} copy` }));
});

llmRouter.delete('/profiles/:id', (req, res) => {
    if (!deleteProfile(req.db, req.params.id)) return res.status(404).json({ error: 'profile not found' });
    res.json({ ok: true });
});

llmRouter.get('/models', async (req, res) => {
    res.json(await listModels(req.db, req.query.profileId ? String(req.query.profileId) : undefined));
});

// The POST form carries editor drafts: overrides ride the body so a pasted key never
// lands in a query string or an access log.
llmRouter.post('/models', async (req, res) => {
    res.json(await listModels(
        req.db,
        req.body?.profileId ? String(req.body.profileId) : undefined,
        undefined,
        req.body?.overrides && typeof req.body.overrides === 'object' ? req.body.overrides : null,
    ));
});

// the test takes the editor's draft as overrides, so a key is checked before it is saved
llmRouter.post('/test', async (req, res) => {
    const overrides = req.body?.overrides && typeof req.body.overrides === 'object' ? req.body.overrides : null;
    res.json(await testProfile(req.db, req.body?.profileId, overrides));
});

// whether the draft's model sees pictures, asked by showing it two and checking what it says
llmRouter.post('/test-vision', async (req, res) => {
    const overrides = req.body?.overrides && typeof req.body.overrides === 'object' ? req.body.overrides : null;
    res.json(await testVision(req.db, req.body?.profileId, overrides));
});

llmRouter.post('/chat', async (req, res) => {
    const db = req.db;
    const controller = new AbortController();
    // res 'close' + !writableEnded = the CLIENT went away mid-call (req 'close'
    // fires on normal body completion in modern node and must not be used here)
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    if (req.body?.stream === true) {
        // normalized SSE: chunk({text}|{reasoning}) / done / error - the client
        // never sees a provider shape, and mid-stream failures are typed events
        try {
            const events = chatStream(db, { ...req.body, purpose: 'tool' }, controller.signal);
            let opened = false;
            for await (const event of events) {
                if (!opened) { sseOpen(res); opened = true; }
                if (event.done) sseWrite(res, 'done', event.done);
                else sseWrite(res, 'chunk', event);
            }
            if (!opened) sseOpen(res);
            res.end();
        } catch (err) {
            if (err?.name === 'AbortError') { res.end(); return; }
            answerReplyFailure(res, err);
        }
        return;
    }

    try {
        res.json(await chat(db, { ...req.body, purpose: 'tool' }, controller.signal));
    } catch (err) {
        if (err?.name === 'AbortError') return;
        answerReplyFailure(res, err);
    }
});
