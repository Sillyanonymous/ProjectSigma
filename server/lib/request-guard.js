// Who a server with accounts off answers, by Host and Origin (the feed's upgrade asks the same rules), and whether a caller still waits

import net from 'node:net';
import { config } from '../config.js';

// the hostname of a Host header ("name:port", "[v6]:port"), lower-cased, with no trailing dot
function hostnameOf(raw) {
    try {
        const name = new URL(`http://${raw}`).hostname.toLowerCase().replace(/\.$/, '');
        return name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
    } catch {
        return null;
    }
}

/** Whether this server answers the Host a request was sent to (IP, localhost, listed names); stops DNS rebinding. */
export function hostAllowed(req) {
    if (config.multiUser) return true;
    const raw = req.headers.host;
    // a client that sends no Host is not a browser page
    if (!raw) return true;
    const name = hostnameOf(raw);
    if (!name) return false;
    if (net.isIP(name)) return true;
    if (name === 'localhost' || name.endsWith('.localhost')) return true;
    return config.hosts.includes(name);
}

/** Whether the sending page may use the API: no Origin, a CL_CORS origin, or the request's own. */
export function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) return true;
    let host;
    try { host = new URL(origin).host; } catch { return false; }
    const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    return host === req.headers.host || (!!forwarded && host === forwarded);
}

/** The Host rule as middleware, ahead of every route and the static files. */
export function hostGuard(req, res, next) {
    if (hostAllowed(req)) return next();
    res.status(403).type('text/plain').send(`This server does not answer to "${hostnameOf(req.headers.host || '') || 'that name'}". `
        + 'Reach it by its IP address, or add the name to hosts in server.yaml (or CL_HOSTS) and restart it.');
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Refuses another site's write while accounts are off: a form or text/plain POST needs no preflight. */
export function originGuard(req, res, next) {
    if (config.multiUser || SAFE_METHODS.has(req.method) || originAllowed(req)) return next();
    res.status(403).json({ error: 'a write from another site\'s page is refused' });
}

// one guarded read a loop turn: a burst parsed together would run back to back, deaf to callers leaving meanwhile
const guarded = [];
let guardTurn = false;
function nextGuarded() {
    const run = guarded.shift();
    if (!run) { guardTurn = false; return; }
    // queued from inside this turn, so it runs after the next poll has read every hang-up
    setImmediate(nextGuarded);
    run();
}

const _closeSignals = new WeakMap();

/** Aborted when the response closes before it was ended (the caller hung up); one signal per response. */
export function closeSignal(res) {
    let gone = _closeSignals.get(res);
    if (!gone) {
        gone = new AbortController();
        _closeSignals.set(res, gone);
        if (res.closed && !res.writableEnded) gone.abort();
        else res.on('close', () => { if (!res.writableEnded) gone.abort(); });
    }
    return gone.signal;
}

/** A search read its caller may drop: it waits its turn, and not at all once the caller has hung up. */
export function skipIfGone(req, res, next) {
    const gone = closeSignal(res);
    // a hang-up read in the same pass as the request marks the socket before its close event fires
    guarded.push(() => {
        if (gone.aborted || req.socket?.destroyed || req.socket?.readableEnded) return;
        next();
    });
    if (!guardTurn) { guardTurn = true; setImmediate(nextGuarded); }
}

// what a page on another site can send without a preflight
const SIMPLE_TYPES = ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'];

/** An archive intake takes only its own types, so no preflight-free request carries one; answers 415 and returns false. */
export function requireArchiveType(req, res, types) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (types.includes(type) && !SIMPLE_TYPES.includes(type)) return true;
    res.status(415).json({ error: `this upload takes ${types.join(' or ')}` });
    return false;
}
