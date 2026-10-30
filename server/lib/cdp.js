// Raw Chrome DevTools Protocol, no playwright. the endpoint is the user's own, so private ranges are allowed on purpose
import { readJsonCapped } from './net-guard.js';

const CDP_MAX_ENDPOINT_LEN = 512;
const CDP_CONNECT_TIMEOUT = 15000;
const CDP_COMMAND_TIMEOUT = 30000;
export const CDP_NAV_TIMEOUT = 60000;

// an in-page fetch answer's text for a page expression, null once its bytes pass the cap: what
// crosses the protocol to this server is bounded
export const PAGE_TEXT_CAPPED = `(async (r, cap) => {
    const reader = r.body ? r.body.getReader() : null;
    if (!reader) return '';
    const decoder = new TextDecoder();
    let text = '', n = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > cap) { await reader.cancel().catch(() => { /* the answer is null either way */ }); return null; }
        text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
})`;

export function cdpHttpBase(endpoint) {
    if (typeof endpoint !== 'string' || !endpoint.trim()) throw new Error('Browser endpoint is required');
    if (endpoint.length > CDP_MAX_ENDPOINT_LEN) throw new Error('Browser endpoint is too long');
    const u = new URL(endpoint.trim());
    if (u.protocol === 'ws:') u.protocol = 'http:';
    else if (u.protocol === 'wss:') u.protocol = 'https:';
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error('Browser endpoint must be an http(s) or ws(s) URL');
    }
    u.pathname = '/';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
}

export function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); }),
    ]).finally(() => clearTimeout(timer));
}

export class CdpClient {
    constructor(ws, info) {
        this.ws = ws;
        this.info = info;
        this._id = 0;
        this._pending = new Map();
        this._listeners = new Set();
        this._closed = false;
        ws.addEventListener('message', (ev) => this._onMessage(ev));
        ws.addEventListener('close', () => {
            this._closed = true;
            for (const p of this._pending.values()) p.reject(new Error('Browser connection closed'));
            this._pending.clear();
        });
    }

    static async connect(endpoint) {
        const base = cdpHttpBase(endpoint);
        let resp;
        try {
            // never followed: an endpoint the caller may name redirected the handshake onto this
            // machine's loopback, past the check on the host it named
            resp = await withTimeout(fetch(`${base}/json/version`, { redirect: 'manual' }), CDP_CONNECT_TIMEOUT, 'Browser handshake');
        } catch (e) {
            throw new Error(`Could not reach the browser endpoint: ${e.message}`);
        }
        if (!resp.ok) throw new Error(`Browser endpoint answered HTTP ${resp.status} on /json/version`);
        const info = await readJsonCapped(resp).catch(() => null);
        if (!info?.webSocketDebuggerUrl) throw new Error('That endpoint did not advertise a DevTools websocket (is it a CDP endpoint?)');

        // Chrome reports its loopback host, which a remote dial cant reach; use the host the user gave
        let wsUrl = info.webSocketDebuggerUrl;
        try {
            const reported = new URL(wsUrl);
            const given = new URL(base);
            reported.host = given.host;
            // Carry the scheme too: a TLS-terminated endpoint dialed as plain ws:// never connects.
            reported.protocol = given.protocol === 'https:' ? 'wss:' : 'ws:';
            wsUrl = reported.toString();
        } catch { /* use as reported */ }

        const ws = new WebSocket(wsUrl);
        try {
            await withTimeout(new Promise((res, rej) => {
                ws.addEventListener('open', res, { once: true });
                ws.addEventListener('error', () => rej(new Error('DevTools websocket refused the connection')), { once: true });
            }), CDP_CONNECT_TIMEOUT, 'Browser websocket');
        } catch (e) {
            // The timeout path leaves a live socket that may still open later; dont leak it.
            ws.close();
            throw e;
        }
        return new CdpClient(ws, info);
    }

    _onMessage(ev) {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
        if (msg.id && this._pending.has(msg.id)) {
            const p = this._pending.get(msg.id);
            this._pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message || 'Browser command failed'));
            else p.resolve(msg.result);
            return;
        }
        if (msg.method) for (const fn of this._listeners) { try { fn(msg); } catch { /* a listener throwing is not our failure */ } }
    }

    send(method, params = {}, sessionId) {
        if (this._closed) return Promise.reject(new Error('Browser connection closed'));
        const id = ++this._id;
        const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
        const p = new Promise((resolve, reject) => this._pending.set(id, { resolve, reject }));
        try { this.ws.send(JSON.stringify(payload)); } catch (e) { this._pending.delete(id); return Promise.reject(e); }
        return withTimeout(p, CDP_COMMAND_TIMEOUT, method);
    }

    on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

    waitFor(method, sessionId, ms) {
        let off;
        return withTimeout(new Promise((resolve) => {
            off = this.on((msg) => {
                if (msg.method !== method) return;
                if (sessionId && msg.sessionId !== sessionId) return;
                resolve(msg.params);
            });
        }), ms, method).finally(() => off?.());
    }

    close() { this.ws.close(); this._closed = true; }
}

export class CdpPage {
    constructor(client, targetId, sessionId) {
        this.client = client;
        this.targetId = targetId;
        this.sessionId = sessionId;
        // A chat socket is REUSED by every later turn, so a later capture never sees it open.
        this._sockets = new Map();
        this._offSockets = client.on((msg) => {
            if (msg.sessionId !== this.sessionId) return;
            if (msg.method === 'Network.webSocketCreated') this._sockets.set(msg.params.requestId, msg.params.url || '');
            else if (msg.method === 'Network.webSocketClosed') this._sockets.delete(msg.params.requestId);
        });
    }

    static async create(client) {
        const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
        const page = new CdpPage(client, targetId, sessionId);
        await page.send('Page.enable');
        await page.send('Runtime.enable');
        await page.send('Network.enable');
        return page;
    }

    send(method, params) { return this.client.send(method, params, this.sessionId); }

    async goto(url, { timeout = CDP_NAV_TIMEOUT } = {}) {
        const loaded = this.client.waitFor('Page.loadEventFired', this.sessionId, timeout);
        await this.send('Page.navigate', { url });
        await loaded;
    }

    async evaluate(expression, { timeout = CDP_COMMAND_TIMEOUT } = {}) {
        const r = await withTimeout(
            this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
            timeout, 'page evaluate');
        if (r.exceptionDetails) {
            throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'Page script threw');
        }
        return r.result?.value;
    }

    async cookies(urls) {
        const r = await this.send('Network.getCookies', { urls });
        return r.cookies || [];
    }

    /**
     * One-shot capture of the first response matching `re`, armed before the request fires; idle-based.
     * @returns {Promise<{ text: string, complete: boolean, reason: string }>} complete false: ask for a continuation
     */
    captureResponse(re, { timeout = 45000, idleMs = 0, frameDone = null, onFrame = null } = {}) {
        let requestId = null;
        let socketId = null;
        const frames = [];
        let settle;
        let markStarted;
        const done = new Promise((res) => { settle = res; });
        // Headers or socket arriving = generation START, so slow can be told from never-started.
        const started = new Promise((res) => { markStarted = res; });
        // Bind to a matching socket that is ALREADY open (turn 2 onward reuses turn 1's).
        for (const [id, url] of this._sockets) {
            if (re.test(url)) { socketId = id; break; }
        }

        let idleTimer = null;
        let settled = false;
        const finish = (reason) => {
            if (settled) return;
            settled = true;
            clearTimeout(idleTimer);
            off();
            const text = frames.length ? frames.join('\n') : null;
            settle({ text, complete: reason === 'done', reason });
        };
        // armed only once frames flow: http reports nothing until loadingFinished, an idle clock would kill it
        const bumpIdle = () => {
            if (!idleMs) return;
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => finish('stalled'), idleMs);
        };

        const off = this.client.on(async (msg) => {
            if (msg.sessionId !== this.sessionId) return;

            // A websocket endpoint never emits Network.responseReceived; frames come back raw.
            if (!socketId && !requestId && msg.method === 'Network.webSocketCreated') {
                if (re.test(msg.params?.url || '')) { socketId = msg.params.requestId; markStarted(true); }
                return;
            }
            if (socketId && msg.params?.requestId === socketId) {
                if (msg.method === 'Network.webSocketFrameReceived') {
                    const payload = String(msg.params.response?.payloadData ?? '');
                    frames.push(payload);
                    bumpIdle();
                    if (onFrame) { try { onFrame(payload); } catch { /* a frame handler throwing is not the capture's failure */ } }
                    // The socket stays open for the next turn, so a close is never coming.
                    if (frameDone && frameDone(payload)) finish('done');
                    return;
                }
                // Closed or errored without a done frame: hand over whatever did arrive.
                if (msg.method === 'Network.webSocketClosed' || msg.method === 'Network.webSocketFrameError') {
                    finish('closed');
                }
                return;
            }

            if (!requestId && msg.method === 'Network.responseReceived') {
                if (re.test(msg.params?.response?.url || '')) { requestId = msg.params.requestId; markStarted(true); }
                return;
            }
            if (requestId && msg.method === 'Network.loadingFinished' && msg.params?.requestId === requestId) {
                if (settled) return;
                settled = true;
                clearTimeout(idleTimer);
                off();
                try {
                    const r = await this.send('Network.getResponseBody', { requestId });
                    const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
                    settle({ text: body, complete: true, reason: 'done' });
                } catch { settle({ text: null, complete: false, reason: 'unreadable' }); }
            }
        });
        if (socketId) markStarted(true);
        return {
            wait: () => withTimeout(done, timeout, 'response capture').catch(() => {
                // The absolute backstop, not the normal path: keep whatever arrived and say so.
                if (!settled) { settled = true; clearTimeout(idleTimer); off(); }
                return { text: frames.length ? frames.join('\n') : null, complete: false, reason: 'ceiling' };
            }),
            startedWithin: (ms) => Promise.race([started, new Promise((res) => setTimeout(() => res(false), ms))]),
            cancel: () => { clearTimeout(idleTimer); off(); },
        };
    }

    async close() {
        this._offSockets?.();
        try { await this.client.send('Target.closeTarget', { targetId: this.targetId }); } catch { /* a target already gone is closed */ }
    }
}
