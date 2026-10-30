// The one error shape every LLM path speaks; upstream bodies are read bounded so an error page cant wedge a toast

import { readBodyCapped, PARSE_MAX_BYTES } from '../lib/net-guard.js';

export const ERROR_KINDS = ['auth', 'rate_limit', 'quota', 'context', 'upstream', 'network', 'timeout', 'bad_request'];

// finish reasons that mean the reply hit its token ceiling (a reasoning model can spend
// the whole budget thinking and return no text at all)
export const LENGTH_FINISH_REASONS = new Set(['length', 'max_tokens', 'stop_limit']);

export class LlmError extends Error {
    constructor(kind, message, { status = null, retryAfterMs = null, retryable = false } = {}) {
        super(message);
        this.name = 'LlmError';
        this.kind = ERROR_KINDS.includes(kind) ? kind : 'upstream';
        this.status = status;
        this.retryAfterMs = retryAfterMs;
        this.retryable = retryable;
    }
}

export function badRequest(message) {
    return new LlmError('bad_request', message);
}

const HTTP_BY_KIND = {
    bad_request: 400,
    timeout: 504,
    auth: 502, rate_limit: 502, quota: 502, context: 502, upstream: 502, network: 502,
};

export function httpStatusFor(err) {
    return HTTP_BY_KIND[err?.kind] ?? 502;
}

// Upstream error bodies can be arbitrary HTML walls; cap the read, strip tags,
// clamp the length. Never throws.
const ERROR_BODY_CAP = 16 * 1024;
const ERROR_MESSAGE_CAP = 500;

export async function boundedErrorText(resp) {
    let text = '';
    try {
        const reader = resp.body?.getReader();
        if (!reader) return '';
        const decoder = new TextDecoder();
        while (text.length < ERROR_BODY_CAP) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
        }
        reader.cancel().catch(() => { /* the text is read; the rest is dropped either way */ });
    } catch { /* partial text is fine */ }
    return text.slice(0, ERROR_BODY_CAP);
}

function extractMessage(bodyText) {
    try {
        const data = JSON.parse(bodyText);
        const m = data?.error?.message ?? data?.error ?? data?.message ?? data?.detail;
        if (typeof m === 'string' && m) return m;
        if (m && typeof m === 'object') return JSON.stringify(m);
    } catch { /* not JSON */ }
    return bodyText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseRetryAfterMs(resp) {
    const raw = resp.headers?.get?.('retry-after');
    const secs = Number(raw);
    if (!Number.isFinite(secs) || secs <= 0) return null;
    return Math.min(secs * 1000, 30000);
}

// status + body -> taxonomy. Body sniffs are deliberately loose substring
// checks: providers phrase these differently but the words are stable.
export function classifyUpstream(resp, bodyText) {
    const status = resp.status;
    const message = (extractMessage(bodyText) || `upstream returned ${status}`).slice(0, ERROR_MESSAGE_CAP);
    const lower = message.toLowerCase();
    let kind = 'upstream';
    if (status === 401 || status === 403) kind = 'auth';
    else if (status === 429) kind = /quota|billing|insufficient/.test(lower) ? 'quota' : 'rate_limit';
    else if (/context.length|maximum context|context window|too many tokens|prompt is too long/.test(lower)) kind = 'context';
    else if (/insufficient.quota|billing|exceeded your current quota/.test(lower)) kind = 'quota';
    const retryable = status === 408 || status === 429 || status >= 500;
    return new LlmError(kind, message, { status, retryAfterMs: parseRetryAfterMs(resp), retryable });
}

export function networkError(err) {
    return new LlmError('network', `could not reach the LLM endpoint: ${err?.message || err}`, { retryable: true });
}

/** An upstream body as JSON, null when it isnt JSON, capped at PARSE_MAX_BYTES; a stopped read stays an AbortError. */
export async function readJsonBody(resp, signal) {
    let body;
    try {
        body = await readBodyCapped(resp, PARSE_MAX_BYTES);
    } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') throw new DOMException('aborted', 'AbortError');
        throw networkError(err);
    }
    if (body === null) throw new LlmError('upstream', `the answer passed ${PARSE_MAX_BYTES / (1024 * 1024)} MB`, { status: resp.status });
    try { return JSON.parse(new TextDecoder().decode(body)); } catch { return null; }
}
