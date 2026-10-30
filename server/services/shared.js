// Cross-provider helpers for the provider services.
import { settingValue } from '../db/settings-store.js';
import { followRedirects, readBodyCapped, readTextCapped, PROVIDER_RELAY_MAX_BYTES } from '../lib/net-guard.js';
import { httpError } from '../lib/http-error.js';

// express 5 wildcard params arrive as arrays; every proxy route reads them through this
export const wildcardPath = (req) => Array.isArray(req.params?.splat) ? req.params.splat.join('/') : (req.params?.splat ?? req.params?.[0] ?? '');

/**
 * Routine service chatter, logged only under the requesting user's debugMode; failures always warn. A caller-owned tag.
 * @param {object} req the request whose user's setting decides
 * @param {...any} args console.log args, without the [provider-services] prefix
 */
export function debugLogAs(tag, req, ...args) {
    try {
        if (!settingValue(req.db, 'debugMode', false)) return;
    } catch { return; }
    console.log(`${tag}[${req?.userHandle || 'default'}]`, ...args);
}

export function debugLog(req, ...args) {
    debugLogAs('[provider-services]', req, ...args);
}

/**
 * fetch() following redirects only on the pinned host: undici strips Authorization and Cookie off-origin, never custom headers.
 * @param {URL|string} url the vetted target
 * @param {object} init fetch init (redirect is overridden to 'manual')
 * @param {{maxRedirects?: number}} [opts]
 */
export async function sameHostFetch(url, init = {}, { maxRedirects = 4 } = {}) {
    const pinnedHost = new URL(url).hostname;
    return followRedirects(url, init, {
        maxRedirects,
        checkHop: (target) => { if (target.hostname !== pinnedHost) throw httpError(502, 'upstream redirected off-host'); },
        refuse: (reason) => httpError(502, reason),
    });
}

/**
 * The one proxy security gate: normalize, allow-list, rebuild with the query, pin the host. Answers 400/403 itself and returns null.
 * @param {object} opts { base, allowedPaths: RegExp[], hosts: string|Set, label }
 */
export function guardProxyTarget(req, res, { base, allowedPaths, hosts, label }) {
    const targetPath = '/' + (wildcardPath(req) || '');
    let targetUrl;
    try {
        targetUrl = new URL(targetPath, base);
    } catch {
        res.status(400).json({ error: 'Invalid proxy path' });
        return null;
    }
    if (!allowedPaths.some(re => re.test(targetUrl.pathname))) {
        console.warn(`[provider-services] ${label} proxy blocked: ${targetUrl.pathname}`);
        res.status(403).json({ error: 'Proxy path not allowed' });
        return null;
    }
    targetUrl.search = new URL(req.url, 'http://localhost').search;
    const allowedHosts = hosts instanceof Set ? hosts : new Set([hosts]);
    if (!allowedHosts.has(targetUrl.hostname)) {
        res.status(403).json({ error: `Proxy target must be ${[...allowedHosts].join(' or ')}` });
        return null;
    }
    return targetUrl;
}

// every slot, so an account's can be emptied together
const _slots = new Set();

/**
 * A per-user, memory-only slot for an upstream provider credential (a datacat token, a civitai key, a CT cookie).
 */
export function sessionSlot(name) {
    const perUser = new Map();
    const key = (req) => req?.userHandle || 'default';
    _slots.add(perUser);
    return {
        name,
        get: (req) => perUser.get(key(req)) ?? null,
        set: (req, value) => { perUser.set(key(req), value); },
        clear: (req) => { perUser.delete(key(req)); },
    };
}


/** Empty every credential slot of one account (its admin deleted it). */
export function forgetAccountSlots(handle) {
    for (const perUser of _slots) perUser.delete(handle);
}

// one browser-honest User-Agent for every upstream call
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Set a relayed body's content type plus a CSP sandbox: served from our origin, a navigated html or svg would run as the app.
 * @returns {string} the content type set ('' when there was none)
 */
export function setRelayedType(res, response, fallback = '') {
    res.set('Content-Security-Policy', 'sandbox');
    const contentType = response.headers.get('content-type') || fallback;
    if (contentType) res.set('Content-Type', contentType);
    return contentType;
}

/**
 * Copy an upstream Response onto the client response (status, type, kept headers, body); past maxBytes is a 502.
 */
export async function relayUpstream(res, response, { keepHeaders = [], maxBytes = PROVIDER_RELAY_MAX_BYTES } = {}) {
    const body = response.status === 204 ? null : await readBodyCapped(response, maxBytes);
    if (response.status !== 204 && !body) return res.status(502).json({ error: 'response too large' });
    res.status(response.status);
    const contentType = setRelayedType(res, response);
    for (const h of keepHeaders) { const v = response.headers.get(h); if (v) res.set(h, v); }
    if (response.status === 204) return res.end();
    // decoded as Response.text() decodes: UTF-8, a leading BOM dropped
    if (contentType.includes('application/json') || contentType.startsWith('text/')) return res.send(new TextDecoder().decode(body));
    return res.send(body);
}

/**
 * The one upstream call for a relay: sameHostFetch when a credential rides, plain fetch following redirects otherwise.
 */
export function fetchUpstream(targetUrl, init = {}, { pinHost = true } = {}) {
    return pinHost ? sameHostFetch(targetUrl, init) : fetch(String(targetUrl), { ...init, redirect: 'follow' });
}

/**
 * A form-encoded credential login relayed verbatim (pygmalion, botbooru): the same caps, body and answer.
 */
export function formLoginRelay(router, routePath, { url, headers = {}, label }) {
    router.post(routePath, async (req, res) => {
        const { username, password } = req.body ?? {};
        if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
        if (typeof username !== 'string' || typeof password !== 'string' || username.length > 256 || password.length > 256) {
            return res.status(400).json({ error: 'Invalid credentials format' });
        }
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': BROWSER_UA, ...headers },
                body: new URLSearchParams({ username, password }).toString(),
            });
            const text = await readTextCapped(response);
            res.status(response.status);
            setRelayedType(res, response, 'application/json');
            res.send(text);
        } catch (err) {
            console.error(`[provider-services] ${label} login proxy error:`, err.message);
            res.status(502).json({ error: `Failed to reach ${label} auth server` });
        }
    });
}

/**
 * The one validate vocabulary: valid, or invalid as DEFINITIVE (refused) or TRANSIENT (never judged); only definitive costs a saved login.
 */
export function validAnswer(extra = {}) {
    return { valid: true, ...extra };
}
export function invalidAnswer(kind, reason, extra = {}) {
    if (kind !== 'definitive' && kind !== 'transient') throw new Error(`invalidAnswer: kind must be definitive or transient, got ${kind}`);
    return { valid: false, [kind]: true, reason, ...extra };
}
/** The status classes an upstream uses to refuse a credential outright. */
export const rejectedStatus = (status) => status === 401 || status === 403;
