import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';
import { httpError } from './http-error.js';

// SSRF guard: every address a name resolves to is checked, and a name that wont resolve counts as unsafe

const BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'metadata.google.internal',
    'metadata.goog',
    'kubernetes.default',
    'kubernetes.default.svc',
]);
const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal'];

function isPrivateIPv4(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;              // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;    // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 192 && b === 0 && c === 0) return true;     // protocol assignments
    if (a >= 224) return true;                            // multicast + reserved
    return false;
}

// an IPv6 address as its eight groups, whatever the spelling; null when it doesnt parse
function ipv6Groups(ip) {
    let s = String(ip).toLowerCase().split('%')[0];
    const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
    if (dotted) {
        const [a, b, c, d] = dotted.slice(1).map(Number);
        s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
    const parts = tail === null ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
    if (parts.length !== 8 || parts.some(p => !/^[0-9a-f]{1,4}$/.test(p))) return null;
    return parts.map(p => parseInt(p, 16));
}

const isUnspecifiedOrLoopback6 = (g) => g.slice(0, 7).every(n => n === 0) && (g[7] === 0 || g[7] === 1);   // :: and ::1

// The IPv4 an IPv6 address carries, or null: mapped (::ffff:0:0/96), translated (::ffff:0:0:0/96),
// compatible (::/96), NAT64 (64:ff9b::/96) and 6to4 (2002::/16).
function carriedIPv4(g) {
    const zero = (from, to) => g.slice(from, to).every(n => n === 0);
    const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    if (zero(0, 5) && g[5] === 0xffff) return v4(g[6], g[7]);
    if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6], g[7]);
    if (zero(0, 6) && !isUnspecifiedOrLoopback6(g)) return v4(g[6], g[7]);
    if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6], g[7]);
    if (g[0] === 0x2002) return v4(g[1], g[2]);
    return null;
}

// by address, never spelling: URL.hostname writes [::ffff:127.0.0.1] as hex, so an embedded IPv4 is judged as itself
function isPrivateIPv6(ip) {
    const g = ipv6Groups(ip);
    if (!g) return true;
    if (isUnspecifiedOrLoopback6(g)) return true;
    const v4 = carriedIPv4(g);
    if (v4) return isPrivateIPv4(v4);
    if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;                    // 64:ff9b:1::/48 local NAT64
    if ((g[0] & 0xfe00) === 0xfc00) return true;                                        // fc00::/7 ULA
    if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true;          // link-local, site-local
    if ((g[0] & 0xff00) === 0xff00) return true;                                        // multicast
    return false;
}

/** This machine itself: 127/8, 0.0.0.0 (which dials the local host), :: and ::1, and any IPv6 carrying one. */
function isLoopbackAddress(ip) {
    const kind = net.isIP(ip);
    if (kind === 4) return ip.startsWith('127.') || ip === '0.0.0.0';
    if (kind !== 6) return false;
    const g = ipv6Groups(ip);
    if (!g) return false;
    if (isUnspecifiedOrLoopback6(g)) return true;
    const v4 = carriedIPv4(g);
    return !!v4 && isLoopbackAddress(v4);
}

/**
 * Whether a host names this machine (loopback literal, localhost, or a name resolving to loopback).
 * @param {string} hostname from `new URL(...).hostname`
 */
export async function resolvesToLoopback(hostname) {
    const name = String(hostname || '').toLowerCase().replace(/\.$/, '');
    const bare = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
    if (net.isIP(bare)) return isLoopbackAddress(bare);
    if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
    try {
        return (await dns.lookup(bare, { all: true, verbatim: true })).some(a => isLoopbackAddress(a.address));
    } catch { return false; }
}

export function isPrivateAddress(ip) {
    const kind = net.isIP(ip);
    if (kind === 4) return isPrivateIPv4(ip);
    if (kind === 6) return isPrivateIPv6(ip);
    return true;
}

/**
 * Throws (statusCode 403) unless every address the hostname resolves to is public.
 * @param {string} hostname from `new URL(...).hostname` (already normalized)
 */
export async function assertPublicHost(hostname) {
    if (config.allowPrivateFetch) return;   // tests only; see config.js
    const name = String(hostname || '').toLowerCase().replace(/\.$/, '');
    if (!name) throw httpError(403, 'target host is empty');
    // a bracketed IPv6 literal comes out of URL.hostname wrapped
    const bare = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
    if (net.isIP(bare)) {
        if (isPrivateAddress(bare)) throw httpError(403, 'target resolves to a private address');
        return;
    }
    if (BLOCKED_HOSTNAMES.has(bare)) throw httpError(403, 'target host is blocked');
    if (BLOCKED_SUFFIXES.some(s => bare.endsWith(s))) throw httpError(403, 'target host is blocked');
    let addrs;
    try {
        addrs = await dns.lookup(bare, { all: true, verbatim: true });
    } catch {
        throw httpError(403, 'target host does not resolve');
    }
    if (!addrs.length) throw httpError(403, 'target host does not resolve');
    for (const { address } of addrs) {
        if (isPrivateAddress(address)) throw httpError(403, 'target resolves to a private address');
    }
}

/**
 * The one hand-followed redirect walk; checkHop runs before every fetch. undici's cross-origin credential strip never runs here, so it is done by hand.
 * @param {URL|string} url
 * @param {object} init fetch init; `redirect` is overridden to 'manual'
 * @param {{maxRedirects: number, checkHop: (target: URL) => (void|Promise<void>), refuse: (reason: string) => Error}} opts refuse builds the error a refused hop throws
 */
export async function followRedirects(url, init, { maxRedirects, checkHop, refuse }) {
    let target = new URL(url);
    let method = init.method || 'GET';
    let body = init.body;
    const headers = new Headers(init.headers || {});
    for (let hop = 0; ; hop++) {
        await checkHop(target);
        const resp = await fetch(target, { ...init, headers, method, body, redirect: 'manual' });
        if (![301, 302, 303, 307, 308].includes(resp.status)) return resp;
        const loc = resp.headers.get('location');
        if (!loc) return resp;
        if (hop >= maxRedirects) throw refuse('too many redirects');
        const next = new URL(loc, target);
        if (!/^https?:$/.test(next.protocol)) throw refuse('redirect to a non-http target');
        if (next.origin !== target.origin) for (const h of CREDENTIAL_HEADERS) headers.delete(h);
        target = next;
        if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && method !== 'GET' && method !== 'HEAD')) {
            method = 'GET';
            body = undefined;
            for (const h of BODY_HEADERS) headers.delete(h);
        }
    }
}

/**
 * fetch() with the public-host guard applied to the initial target AND to every redirect
 * hop, which `redirect: 'follow'` cannot do; a refusal is a 403.
 * @param {URL|string} url
 * @param {object} init fetch init; `redirect` is overridden to 'manual'
 * @param {{maxRedirects?: number}} [opts]
 */
export async function guardedFetch(url, init = {}, { maxRedirects = 5 } = {}) {
    return followRedirects(url, init, { maxRedirects, checkHop: (target) => assertPublicHost(target.hostname), refuse: (reason) => httpError(403, reason) });
}

// the fetch spec's lists: what a cross-origin hop drops, and what a hop that drops the body drops
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length'];

// the most an upstream body the generic proxy relays to a client may hold
export const RELAY_MAX_BYTES = 200 * 1024 * 1024;
// a provider relay's (ct, dc, civitai, botbooru, pixiv): a card image or an API answer never comes near the proxy's
export const PROVIDER_RELAY_MAX_BYTES = 50 * 1024 * 1024;

/**
 * An upstream body read whole, never past maxBytes: a declared length over it is refused unread, else counted as it streams.
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<Buffer|null>}
 */
export async function readBodyCapped(response, maxBytes) {
    if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel().catch(() => { /* refused unread either way */ });
        return null;
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => { /* refused past the cap either way */ });
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks, total);
}

// cap on an upstream answer the server parses itself, since the parse holds the thread
export const PARSE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * An upstream body as text (decoded as Response.text() does) through readBodyCapped; throws past the cap.
 * @returns {Promise<string>}
 */
export async function readTextCapped(response, maxBytes = PARSE_MAX_BYTES) {
    const body = await readBodyCapped(response, maxBytes);
    if (body === null) throw new Error(`the upstream answer passed ${maxBytes} bytes`);
    return new TextDecoder().decode(body);
}

/** An upstream body as JSON, read as readTextCapped reads it; throws on a body that is no JSON, as Response.json() does. */
export async function readJsonCapped(response, maxBytes = PARSE_MAX_BYTES) {
    return JSON.parse(await readTextCapped(response, maxBytes));
}
