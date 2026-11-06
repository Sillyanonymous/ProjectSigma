// SPDX-License-Identifier: MIT

// Anthropic, the server half: the Messages API as a kind of connection, translated to and from the
// app's neutral vocabulary.

const VERSION = '2023-06-01';
const DEFAULT_BASE = 'https://api.anthropic.com';
// the API requires max_tokens and a model's thinking spends from it, so a request that names none
// asks for the app's own roomy ceiling
const DEFAULT_MAX_TOKENS = 8192;
// Claude models from 4.7 on refuse their own samplers with a 400 (older ones while thinking); a
// non-Claude model keeps them
const SAMPLERS = ['temperature', 'top_p', 'top_k'];
const OLDER_CLAUDE = /^claude-(?:3-|(?:opus|sonnet|haiku)-4(?:-[0-6])?(?:-\d{8})?$)/;
const refusesSamplers = (model, thinking) => /^claude-/.test(model || '') && (thinking || !OLDER_CLAUDE.test(model));
// current models refuse a prefill, so a conversation opens and ends on the user's turn
const OPENING = '(The conversation begins.)';
const CLOSING = '(The conversation continues.)';
// why the model stopped, in the app's words
const FINISH = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', model_context_window_exceeded: 'length' };
// each error type's status outside a stream, so a mid-stream error is classified and retried alike
const STATUS_OF = {
    invalid_request_error: 400, authentication_error: 401, billing_error: 402, permission_error: 403, not_found_error: 404,
    conflict_error: 409, request_too_large: 413, rate_limit_error: 429, api_error: 500, timeout_error: 504, overloaded_error: 529,
};

export function register(router, ctx) {
    const { LlmError, classifyUpstream, boundedErrorText, networkError, readJsonBody, parseSse, translateParams } = ctx.llm.kit;

    const PARAMS = {
        temperature: 'temperature',
        topP: 'top_p',
        topK: 'top_k',
        maxTokens: 'max_tokens',
        stop: 'stop_sequences',
        // a current model thinks anyway and leaves the text out unless asked; the summary is what the
        // app keeps as the reply's reasoning
        reasoning: (r, body) => { body.thinking = { type: 'adaptive', display: 'summarized' }; body.output_config = { effort: r.effort }; },
    };

    const baseOf = (profile) => String(profile.base_url || DEFAULT_BASE).replace(/\/+$/, '');
    const headers = (profile) => ({
        'content-type': 'application/json',
        'anthropic-version': VERSION,
        ...(profile.api_key ? { 'x-api-key': profile.api_key } : {}),
    });

    const textOf = (content) => (typeof content === 'string' ? content
        : Array.isArray(content) ? content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('') : '');

    // a user turn's images go ahead of its text, as the vision guide advises
    const blocksOf = (images, text) => [
        ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
        ...(text.trim() ? [{ type: 'text', text }] : []),
    ];

    // leading system messages are the system prompt, later ones user turns (no system turn); empty ones go
    function toMessages(list) {
        const system = [];
        const messages = [];
        for (const m of Array.isArray(list) ? list : []) {
            const text = textOf(m?.content);
            const images = Array.isArray(m?.images) ? m.images : [];
            if (!text.trim() && !images.length) continue;
            if (m.role === 'system' && !messages.length) { system.push(text); continue; }
            messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: images.length ? blocksOf(images, text) : text });
        }
        if (!messages.length && system.length) messages.push({ role: 'user', content: system.pop() });
        if (messages[0]?.role === 'assistant') messages.unshift({ role: 'user', content: OPENING });
        if (messages.at(-1)?.role === 'assistant') messages.push({ role: 'user', content: CLOSING });
        return { system: system.join('\n\n'), messages };
    }

    function buildBody(profile, req, stream) {
        const { system, messages } = toMessages(req.messages);
        const model = req.model || profile.model || undefined;
        const body = { model, messages, stream };
        if (system) body.system = system;
        translateParams(req.params || {}, PARAMS, body, { debug: req.debug });
        if (refusesSamplers(model, !!body.thinking)) for (const k of SAMPLERS) delete body[k];
        if (!Number.isFinite(body.max_tokens)) body.max_tokens = DEFAULT_MAX_TOKENS;
        return body;
    }

    async function request(profile, path, init, signal) {
        let resp;
        try {
            resp = await fetch(`${baseOf(profile)}${path}`, { ...init, signal });
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            throw networkError(err);
        }
        if (!resp.ok) throw classifyUpstream(resp, await boundedErrorText(resp));
        return resp;
    }

    // the app's usage names, the ones its other kind answers with
    const usageOf = (input, output) => ({ prompt_tokens: input, completion_tokens: output, total_tokens: input + output });
    const finishOf = (reason) => (reason ? FINISH[reason] || reason : null);
    // a type the table does not know yet is the upstream's failure, and never retried
    const streamError = (event) => classifyUpstream({ status: STATUS_OF[event?.error?.type] ?? 0 }, JSON.stringify(event));

    ctx.llm.registerAdapter({
        kind: 'anthropic',
        displayName: 'Anthropic Messages API',
        defaultBaseUrl: DEFAULT_BASE,
        requiresBaseUrl: false,
        capabilities: { streaming: true, json: false, reasoning: true, vision: true },
        paramTable: PARAMS,

        async chat(profile, req, signal) {
            const resp = await request(profile, '/v1/messages', {
                method: 'POST', headers: headers(profile), body: JSON.stringify(buildBody(profile, req, false)),
            }, signal);
            const data = await readJsonBody(resp, signal);
            if (!data || data.type !== 'message' || !Array.isArray(data.content)) throw new LlmError('upstream', 'unrecognized response shape');
            const content = data.content.filter(b => b?.type === 'text').map(b => b.text || '').join('');
            const reasoning = data.content.filter(b => b?.type === 'thinking').map(b => b.thinking || '').join('');
            const u = data.usage;
            return {
                content,
                ...(reasoning ? { reasoning } : {}),
                finishReason: finishOf(data.stop_reason),
                ...(u ? { usage: usageOf(u.input_tokens || 0, u.output_tokens || 0) } : {}),
            };
        },

        async *chatStream(profile, req, signal) {
            const resp = await request(profile, '/v1/messages', {
                method: 'POST', headers: headers(profile), body: JSON.stringify(buildBody(profile, req, true)),
            }, signal);
            let finishReason = null;
            let input = null;
            let output = null;
            let ended = false;
            let read = false;
            for await (const frame of parseSse(resp.body, signal)) {
                let data;
                try { data = JSON.parse(frame.data); } catch { continue; }
                read = true;
                if (data?.type === 'error') throw streamError(data);
                if (data?.type === 'message_start') {
                    input = data.message?.usage?.input_tokens ?? input;
                    output = data.message?.usage?.output_tokens ?? output;
                } else if (data?.type === 'content_block_delta') {
                    const d = data.delta;
                    if (d?.type === 'text_delta' && d.text) yield { text: d.text };
                    else if (d?.type === 'thinking_delta' && d.thinking) yield { reasoning: d.thinking };
                } else if (data?.type === 'message_delta') {
                    if (data.delta?.stop_reason) finishReason = finishOf(data.delta.stop_reason);
                    // the output count in a message_delta is the running total
                    if (Number.isFinite(data.usage?.output_tokens)) output = data.usage.output_tokens;
                } else if (data?.type === 'message_stop') {
                    ended = true;
                    break;
                }
            }
            // no message_stop means a cut-off reply, unless nothing read as a frame (an HTML page)
            if (!ended && !read) throw new LlmError('upstream', 'unrecognized response shape');
            if (!ended) throw new LlmError('network', 'the reply stream ended before the endpoint finished the reply', { retryable: true });
            yield { done: { finishReason, ...(input !== null ? { usage: usageOf(input, output || 0) } : {}) } };
        },

        async listModels(profile, signal) {
            const resp = await request(profile, '/v1/models?limit=1000', { method: 'GET', headers: headers(profile) }, signal);
            const data = await readJsonBody(resp, signal);
            if (!Array.isArray(data?.data)) throw new LlmError('upstream', 'unrecognized response shape');
            return data.data
                .map(m => ({
                    id: String(m?.id ?? ''),
                    ...(Number.isFinite(m?.max_input_tokens) && m.max_input_tokens > 0 ? { contextLength: m.max_input_tokens } : {}),
                    // capabilities can be null, and then the list says nothing of sight
                    ...(typeof m?.capabilities?.image_input?.supported === 'boolean' ? { vision: m.capabilities.image_input.supported } : {}),
                }))
                .filter(m => m.id)
                .sort((a, b) => a.id.localeCompare(b.id));
        },
    });
}
