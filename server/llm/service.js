// The generation service: profile, params, retries, timeouts and errors around a stateless adapter.
// cfg is injectable so a test can shrink the clocks

import { getAdapter } from './registry.js';
import { profileRow, rowParams, visionOf } from '../db/llm-profiles-store.js';
import { normalizeParams, mergeParams } from './params.js';
import { badRequest, LlmError, networkError } from './errors.js';
import { createThinkSplitter, splitThink } from './think.js';
import { prepareImages, solidPicture } from './images.js';
import { LLM_PURPOSES } from './vocabulary.js';
import { runHook } from '../db/hook-seat.js';

// CL_LLM_CFG (JSON) shrinks the clocks for the conformance suite; not a user setting.
const cfgOverride = (() => {
    try { return process.env.CL_LLM_CFG ? JSON.parse(process.env.CL_LLM_CFG) : {}; } catch { return {}; }
})();

export const DEFAULT_CFG = {
    chatTimeoutMs: 300000,       // non-stream ceiling (single await, nothing to observe)
    streamIdleMs: 120000,        // stream: token-INACTIVITY window once tokens flow, not request age
    streamFirstMs: 300000,       // stream: the wait for the FIRST token; a reasoning model thinks in silence for minutes
    testTimeoutMs: 15000,
    visionTestTimeoutMs: 60000,  // a picture call: a local model reads it slower than a one-token ping
    maxRetries: 2,               // pre-first-token only, retryable failures only
    retryBaseMs: 400,
    retryMaxMs: 5000,
    ...cfgOverride,
};

function resolveProfile(db, profileId, { validate = true } = {}) {
    const row = profileRow(db, profileId || null);
    if (!row) throw badRequest('no LLM profile configured; add one in Settings');
    const adapter = getAdapter(row.kind, db);
    if (validate) {
        if (!adapter) throw badRequest(`profile "${row.name}" has unknown kind '${row.kind}' (a kind an extension adds needs that extension switched on)`);
        if (adapter.requiresBaseUrl && !row.base_url) throw badRequest(`profile "${row.name}" has no base URL`);
    }
    return { profile: row, adapter };
}

// an editor draft over the stored row for a probe; the effective profile is validated, not the stored one
function resolveDraft(db, profileId, draft) {
    let { profile, adapter } = resolveProfile(db, profileId, { validate: !draft });
    if (!draft) return { profile, adapter };
    profile = { ...profile };
    if (typeof draft.kind === 'string' && draft.kind) profile.kind = draft.kind;
    adapter = getAdapter(profile.kind, db);
    if (!adapter) throw badRequest(`unknown kind '${profile.kind}'`);
    if (typeof draft.baseUrl === 'string') profile.base_url = draft.baseUrl.trim();
    if (typeof draft.apiKey === 'string' && draft.apiKey) profile.api_key = draft.apiKey;
    if (typeof draft.model === 'string') profile.model = draft.model.trim();
    // the draft's samplers, its effort among them, checked as a save checks them
    if (draft.params && typeof draft.params === 'object') profile.params = JSON.stringify(normalizeParams({ params: draft.params }));
    if (adapter.requiresBaseUrl && !profile.base_url) throw badRequest('the draft has no base URL');
    return { profile, adapter };
}

// the purposes whose routes stamp a scope; a raw call is a tool's, so a body naming a chat is never read
const SCOPED_PURPOSES = new Set(['chat', 'assistant', 'creator']);
const SCOPE_KEYS = ['chatId', 'sessionId', 'charId', 'mode'];
function scopeFacts(scope) {
    const out = {};
    if (scope && typeof scope === 'object') for (const k of SCOPE_KEYS) if (typeof scope[k] === 'string' && scope[k]) out[k] = scope[k];
    return out;
}

// Body -> the adapter request. Validation throws bad_request before any I/O. A resolved
// profile handed in (the test probe's draft) stands in for the stored row.
function buildRequest(db, body, resolved = null) {
    if (!Array.isArray(body?.messages) || body.messages.length === 0) throw badRequest('messages array required');
    const { profile, adapter } = resolved || resolveProfile(db, body.profileId);
    const params = mergeParams(rowParams(profile), normalizeParams(body));
    // the purpose is what the calling route stamped, never the caller's own body
    const purpose = LLM_PURPOSES.includes(body.purpose) ? body.purpose : 'tool';
    const req = runHook('llm.request', { messages: body.messages, model: body.model || undefined, params }, {
        db, purpose, profileKind: profile.kind, profileId: profile.id ?? null,
        ...(purpose === 'extension' ? { extension: String(body.extension || '') } : {}),
        // which chat or session the call is for, read only under a purpose a route stamps, as `extension` is
        ...(SCOPED_PURPOSES.has(purpose) ? scopeFacts(body.scope) : {}),
    });
    return { profile, adapter, req };
}

// images load after llm.request, so one a filter adds is read and shrunk like the caller's own
async function withImages(db, profile, adapter, req) {
    if (!req.messages.some(m => m?.images != null)) return req;
    if (req.messages.some(m => Array.isArray(m?.images) && m.images.length)) {
        if (!adapter.capabilities?.vision) throw badRequest(`connections of kind '${adapter.kind}' cannot send images`);
        if (profile.vision === 0) throw badRequest(`the connection "${profile.name}" is set as not seeing pictures`);
        // not checked sends nothing either: only a connection known to see is shown a picture
        if (profile.vision !== 1) throw badRequest(`the connection "${profile.name}" is not checked as seeing pictures: run Check first`);
    }
    return { ...req, messages: await prepareImages(db, req.messages) };
}

const sleep =(ms, signal) => new Promise((resolve, reject) => {
    // a timeout surfaces as its LlmError; a bare AbortError reads as "the client went away"
    const stop = () => reject(signal.reason instanceof LlmError ? signal.reason : new DOMException('aborted', 'AbortError'));
    // a signal aborted before the wait began never fires its event
    if (signal?.aborted) { stop(); return; }
    const onAbort = () => { clearTimeout(t); stop(); };
    // the caller's signal can outlive the wait (a page's session): its listener goes with it
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
});

function backoffMs(attempt, err, cfg) {
    if (err?.retryAfterMs) return Math.min(err.retryAfterMs, cfg.retryMaxMs);
    const cap = Math.min(cfg.retryBaseMs * 2 ** attempt, cfg.retryMaxMs);
    return Math.floor(Math.random() * cap);
}

// Chain an outer signal with a timeout into one signal the adapter consumes.
function withTimeout(signal, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new LlmError('timeout', `LLM call exceeded ${Math.round(ms / 1000)}s`)), ms);
    const onAbort = () => controller.abort(signal.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener('abort', onAbort, { once: true });
    return { signal: controller.signal, done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
}

function throwAbort(signal) {
    // a timeout abort carries the LlmError as its reason; client aborts stay AbortError
    if (signal?.reason instanceof LlmError) throw signal.reason;
    const e = new DOMException('aborted', 'AbortError');
    throw e;
}

export async function chat(db, body, signal, cfg = DEFAULT_CFG, resolved = null) {
    const built = buildRequest(db, body, resolved);
    const { profile, adapter } = built;
    const req = await withImages(db, profile, adapter, built.req);
    const t = withTimeout(signal, cfg.chatTimeoutMs);
    try {
        for (let attempt = 0; ; attempt++) {
            try {
                const out = await adapter.chat(profile, req, t.signal);
                // same think split as streaming: a leading think block breaks the JSON parse of a fine reply
                if (typeof out?.content === 'string' && !out.reasoning) {
                    const { text, reasoning } = splitThink(out.content);
                    if (reasoning) return { ...out, content: text, reasoning, profileId: profile.id };
                }
                return { ...out, profileId: profile.id };
            } catch (err) {
                if (err?.name === 'AbortError') throwAbort(t.signal);
                const retryable = err instanceof LlmError && err.retryable;
                if (!retryable || attempt >= cfg.maxRetries) throw err;
                await sleep(backoffMs(attempt, err, cfg), t.signal);
            }
        }
    } finally {
        t.done();
    }
}

/** Streaming generation: retries only before the first event, an inactivity window instead of a ceiling. */
export async function* chatStream(db, body, signal, cfg = DEFAULT_CFG) {
    const built = buildRequest(db, body);
    const { profile, adapter } = built;
    if (!adapter.capabilities.streaming) throw badRequest(`kind '${adapter.kind}' does not support streaming`);
    const req = await withImages(db, profile, adapter, built.req);

    for (let attempt = 0; ; attempt++) {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        if (signal?.aborted) controller.abort();
        else signal?.addEventListener('abort', onAbort, { once: true });
        let idleTimer = null;
        let idled = false;
        let emitted = false;
        // the long window until the first token: a provider buffering its reasoning sends nothing for minutes
        const armIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => { idled = true; controller.abort(); }, emitted ? cfg.streamIdleMs : cfg.streamFirstMs);
        };
        // per attempt: a splitter holding half a tag from an abandoned attempt would corrupt the retry
        const think = createThinkSplitter();
        try {
            armIdle();
            for await (const event of adapter.chatStream(profile, req, controller.signal)) {
                armIdle();
                emitted = true;
                // A model that writes its reasoning inline as <think> gets it moved to the
                // reasoning channel here, so every adapter answers with one vocabulary.
                if (typeof event.text === 'string') {
                    for (const ev of think.push(event.text)) yield ev;
                    continue;
                }
                // what the splitter still holds (half a tag) is the reply's tail, so it goes out before the done
                if (event.done) for (const ev of think.flush()) yield ev;
                yield event;
            }
            for (const ev of think.flush()) yield ev;
            return;
        } catch (err) {
            if (idled) {
                throw new LlmError('timeout', emitted
                    ? `no tokens for ${Math.round(cfg.streamIdleMs / 1000)}s; stream abandoned`
                    : `no first token in ${Math.round(cfg.streamFirstMs / 1000)}s; stream abandoned`);
            }
            if (err?.name === 'AbortError' || signal?.aborted) { const e = new DOMException('aborted', 'AbortError'); throw e; }
            const retryable = !emitted && err instanceof LlmError && err.retryable && attempt < cfg.maxRetries;
            if (!retryable) throw err;
            await sleep(backoffMs(attempt, err, cfg), signal);
        } finally {
            clearTimeout(idleTimer);
            signal?.removeEventListener('abort', onAbort);
        }
    }
}

// The settings-UI Test button: a 1-token real call under a short ceiling
// (probe-by-tiny-chat is the only reliable key validation).
export async function testProfile(db, profileId, overrides = null, cfg = DEFAULT_CFG) {
    try {
        // a draft that cannot be resolved (no base URL yet) is an honest verdict, not a 400
        const resolved = resolveDraft(db, profileId, overrides);
        await chat(db, {
            profileId,
            messages: [{ role: 'user', content: 'Hi' }],
            params: { maxTokens: 1 },
            purpose: 'test',
        }, null, { ...cfg, chatTimeoutMs: cfg.testTimeoutMs, maxRetries: 0 }, resolved);
        return { ok: true };
    } catch (err) {
        if (err instanceof LlmError) {
            return { ok: false, kind: err.kind, error: err.message, timedOut: err.kind === 'timeout' };
        }
        return { ok: false, kind: 'network', error: err?.message || 'test failed', timedOut: false };
    }
}

/** Whether a connection sends its model pictures: false when its kind cannot carry them, else its row's true, false or null (not known). */
export function profileSees(db, row) {
    if (!row || !getAdapter(row.kind, db)?.capabilities?.vision) return false;
    return visionOf(row);
}

// names no model spells another way, so a blind guess at two in order lands one time in thirty
const PROBE_COLOURS = { red: '#d01818', green: '#18a018', blue: '#1838d0', yellow: '#f0d010', black: '#101010', white: '#f8f8f8' };
const PROBE_ASK = 'Two pictures are attached, each one solid colour. Name the colour of the first, then of the second, in one line and nothing else.';

const notKnown = (err) => (err instanceof LlmError
    ? { sees: null, kind: err.kind, error: err.message }
    : { sees: null, kind: 'network', error: err?.message || 'the check failed' });

/**
 * Whether the draft's model sees: it must name two one-colour pictures in order; refused or wrong is no, a failed or empty call not known.
 * @returns {Promise<{ sees: true } | { sees: false, reason: 'kind'|'refused'|'answer', error?: string, said?: string } | { sees: null, kind: string, error: string }>}
 */
export async function testVision(db, profileId, overrides = null, cfg = DEFAULT_CFG) {
    let resolved;
    try { resolved = resolveDraft(db, profileId, overrides); } catch (err) { return notKnown(err); }
    if (!resolved.adapter.capabilities?.vision) return { sees: false, reason: 'kind', error: `connections of kind '${resolved.adapter.kind}' cannot send pictures` };
    const names = Object.keys(PROBE_COLOURS);
    const first = names[Math.floor(Math.random() * names.length)];
    const rest = names.filter(n => n !== first);
    const second = rest[Math.floor(Math.random() * rest.length)];
    const images = await Promise.all([first, second].map(async (n) => ({ data: await solidPicture(PROBE_COLOURS[n]) })));
    // the check is the one call shown pictures before an answer is known, and a stored no is what it may overturn
    const probe = { ...resolved, profile: { ...resolved.profile, vision: 1 } };
    let out;
    try {
        out = await chat(db, { profileId, messages: [{ role: 'user', content: PROBE_ASK, images }], params: { maxTokens: 400 }, purpose: 'test' },
            null, { ...cfg, chatTimeoutMs: cfg.visionTestTimeoutMs, maxRetries: 0 }, probe);
    } catch (err) {
        // the host refused a call it takes without pictures (the plain Test is the check of the rest)
        if (err instanceof LlmError && err.kind === 'upstream') return { sees: false, reason: 'refused', error: err.message };
        return notKnown(err);
    }
    const said = String(out?.content || '');
    if (!said.trim()) return { sees: null, kind: 'empty', error: 'the model answered nothing; it may have spent its reply thinking' };
    const at = (name) => said.toLowerCase().search(new RegExp(`\\b${name}\\b`));
    return at(first) !== -1 && at(first) < at(second) ? { sees: true } : { sees: false, reason: 'answer', said: said.slice(0, 200) };
}

export async function listModels(db, profileId, signal, overrides = null) {
    const { profile, adapter } = resolveDraft(db, profileId, (overrides && typeof overrides === 'object') ? overrides : null);
    try {
        return await adapter.listModels(profile, signal);
    } catch (err) {
        if (err instanceof LlmError) throw err;
        if (err?.name === 'AbortError') throw err;
        throw networkError(err);
    }
}

// the two clock primitives, for the conformance suite
export { sleep, withTimeout };
