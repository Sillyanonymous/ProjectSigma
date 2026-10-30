// The OpenAI-compatible adapter, the catch-all kind (any OAI-shaped host is a base_url). Wire shape only.

import { parseSse } from '../sse.js';
import { translateParams } from '../params.js';
import { classifyUpstream, boundedErrorText, networkError, readJsonBody, LlmError } from '../errors.js';

const PARAM_TABLE = {
    temperature: 'temperature',
    topP: 'top_p',
    topK: 'top_k',
    maxTokens: 'max_tokens',
    stop: 'stop',
    presencePenalty: 'presence_penalty',
    frequencyPenalty: 'frequency_penalty',
    seed: 'seed',
    json: (on, body) => { if (on) body.response_format = { type: 'json_object' }; },
    reasoning: (r, body) => { body.reasoning_effort = r.effort; },
};

function joinUrl(base, path) {
    return `${String(base).replace(/\/+$/, '')}${path}`;
}

function headers(profile) {
    return {
        'Content-Type': 'application/json',
        ...(profile.api_key ? { Authorization: `Bearer ${profile.api_key}` } : {}),
    };
}

// a message's images go ahead of its text as data URL parts; the neutral field itself never reaches the wire
function wireMessage({ images, ...m }) {
    if (!images?.length) return m;
    const text = typeof m.content === 'string' ? (m.content ? [{ type: 'text', text: m.content }] : []) : (Array.isArray(m.content) ? m.content : []);
    return { ...m, content: [...images.map(i => ({ type: 'image_url', image_url: { url: `data:${i.mediaType};base64,${i.data}` } })), ...text] };
}

function buildBody(profile, req, stream) {
    const body = {
        model: req.model || profile.model || undefined,
        messages: req.messages.map(wireMessage),
        stream,
    };
    translateParams(req.params, PARAM_TABLE, body, { debug: req.debug });
    return body;
}

// Some hosts put message content in content blocks or legacy text fields.
function contentOf(choice) {
    let content = choice.message?.content;
    if (Array.isArray(content)) content = content.filter(b => b?.type === 'text').map(b => b.text).join('');
    if (typeof content !== 'string') content = choice.text ?? '';
    return content;
}

// a model's sight as hosts publish it (OpenRouter and llama.cpp, DeepSeek, Mistral); nothing when the list says nothing
function listedVision(m) {
    const modalities = m?.architecture?.input_modalities ?? m?.input_modalities;
    if (Array.isArray(modalities)) return { vision: modalities.includes('image') };
    if (typeof m?.capabilities?.vision === 'boolean') return { vision: m.capabilities.vision };
    return {};
}

async function request(profile, path, init, signal) {
    let resp;
    try {
        resp = await fetch(joinUrl(profile.base_url, path), { ...init, signal });
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
        throw networkError(err);
    }
    if (!resp.ok) throw classifyUpstream(resp, await boundedErrorText(resp));
    return resp;
}

export const openaiAdapter = {
    kind: 'openai',
    displayName: 'OpenAI-compatible',
    defaultBaseUrl: '',   // no sane default: every host has its own
    requiresBaseUrl: true,
    capabilities: { streaming: true, json: true, reasoning: true, vision: true },
    paramTable: PARAM_TABLE,

    async chat(profile, req, signal) {
        const resp = await request(profile, '/chat/completions', {
            method: 'POST', headers: headers(profile), body: JSON.stringify(buildBody(profile, req, false)),
        }, signal);
        const data = await readJsonBody(resp, signal);
        if (data?.error) {
            const msg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
            throw new LlmError('upstream', String(msg).slice(0, 500), { status: resp.status });
        }
        const choice = data?.choices?.[0];
        // no body, or a body with no choice (an HTML page, an unrelated JSON) is not an empty reply
        if (!choice) throw new LlmError('upstream', 'unrecognized response shape');
        const content = contentOf(choice);
        if (typeof content !== 'string') throw new LlmError('upstream', 'unrecognized response shape');
        const reasoning = choice.message?.reasoning_content ?? choice.message?.reasoning;
        return {
            content,
            ...(typeof reasoning === 'string' && reasoning ? { reasoning } : {}),
            finishReason: choice.finish_reason ?? null,
            ...(data.usage ? { usage: data.usage } : {}),
        };
    },

    // Yields the normalized event vocabulary: {text} | {reasoning} |
    // {done: {finishReason, usage?}}. Errors throw (LlmError) and the service
    // layer turns them into error events.
    async *chatStream(profile, req, signal) {
        const resp = await request(profile, '/chat/completions', {
            method: 'POST', headers: headers(profile), body: JSON.stringify(buildBody(profile, req, true)),
        }, signal);
        let finishReason = null;
        let usage;
        let ended = false;
        let read = false;
        for await (const frame of parseSse(resp.body, signal)) {
            if (frame.data === '[DONE]') { ended = true; break; }
            let data;
            try { data = JSON.parse(frame.data); } catch { continue; }
            read = true;
            if (data?.error) {
                const msg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
                throw new LlmError('upstream', String(msg).slice(0, 500));
            }
            const choice = data?.choices?.[0];
            const delta = choice?.delta;
            if (typeof delta?.content === 'string' && delta.content) yield { text: delta.content };
            const reasoning = delta?.reasoning_content ?? delta?.reasoning;
            if (typeof reasoning === 'string' && reasoning) yield { reasoning };
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (data?.usage) usage = data.usage;
        }
        // neither [DONE] nor a finish reason means cut off, unless no frame read at all (an HTML page)
        if (!ended && !finishReason && !read) throw new LlmError('upstream', 'unrecognized response shape');
        if (!ended && !finishReason) throw new LlmError('network', 'the reply stream ended before the endpoint finished the reply', { retryable: true });
        yield { done: { finishReason, ...(usage ? { usage } : {}) } };
    },

    async listModels(profile, signal) {
        const resp = await request(profile, '/models', { method: 'GET', headers: headers(profile) }, signal);
        const data = await readJsonBody(resp, signal);
        const rows = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : null);
        if (!rows) throw new LlmError('upstream', 'unrecognized response shape');
        return rows
            .map(m => ({ id: String(m?.id ?? m?.name ?? ''), ...(Number.isFinite(m?.context_length) ? { contextLength: m.context_length } : {}), ...listedVision(m) }))
            .filter(m => m.id)
            .sort((a, b) => a.id.localeCompare(b.id));
    },
};
