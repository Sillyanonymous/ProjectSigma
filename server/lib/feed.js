// The change feed, one WebSocket per tab. not SSE: a stream would eat one of the six http/1.1 lanes the grid budgets
import { WebSocketServer, WebSocket } from 'ws';
import { attachUser } from '../auth.js';
import { hostAllowed, originAllowed } from './request-guard.js';
import { subscribeChanges, SERVER_SCOPE } from '../db/changes.js';

const FEED_PATH = '/api/feed';
const HEARTBEAT_MS = 30000;
// a tab this far behind (a sleeping laptop, a stalled network) is told to re-sync from its
// views instead of being handed an unbounded backlog
const MAX_BUFFERED_BYTES = 1 << 20;
const CLIENT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** The tab id a request or a feed connection names, or null. */
export function clientIdOf(value) {
    const v = Array.isArray(value) ? value[0] : value;
    return typeof v === 'string' && CLIENT_ID_RE.test(v) ? v : null;
}

// a WebSocket handshake skips CORS, so the upgrade asks the API's own host and origin rules

/**
 * The frame for queued records: the records, or one resync while the socket is over its buffer bound.
 * @param {{ ws: { bufferedAmount: number }, resyncPending?: boolean }} conn
 * @param {Array<object>} records
 * @returns {object|null} the frame to send, or null for nothing
 */
export function frameFor(conn, records) {
    if (conn.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        if (conn.resyncPending) return null;
        conn.resyncPending = true;
        return { type: 'resync' };
    }
    conn.resyncPending = false;
    return { type: 'changes', records };
}

function refuse(socket, status, text) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}

// who the cookie names now; a library that cant open resolves nobody, a throw here kills the process
function resolveUser(headers) {
    const probe = { headers };
    try {
        attachUser(probe, null, () => {});
    } catch (e) {
        console.error('[feed] a connection could not be resolved:', e);
        return null;
    }
    return probe.user && !probe.user.mustChangePassword ? probe : null;
}

/**
 * Serve the feed on an HTTP server; the returned handle closes it.
 * @param {{ heartbeatMs?: number }} [opts]
 */
export function attachFeed(server, { heartbeatMs = HEARTBEAT_MS } = {}) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    const connections = new Set();

    const onUpgrade = (req, socket, head) => {
        let pathname;
        try { pathname = new URL(req.url, 'http://feed.invalid').pathname; } catch { pathname = ''; }
        if (pathname !== FEED_PATH) {
            // nothing else upgrades on this server; an unanswered upgrade would hang the socket
            if (server.listenerCount('upgrade') === 1) socket.destroy();
            return;
        }
        if (!hostAllowed(req) || !originAllowed(req)) return refuse(socket, 403, 'Forbidden');
        const who = resolveUser(req.headers);
        if (!who) return refuse(socket, 401, 'Unauthorized');
        const clientId = clientIdOf(new URL(req.url, 'http://feed.invalid').searchParams.get('client'));
        wss.handleUpgrade(req, socket, head, (ws) => {
            const conn = { ws, headers: req.headers, handle: who.userHandle, admin: !!who.user.admin, clientId, alive: true, pending: [], scheduled: false };
            connections.add(conn);
            ws.on('pong', () => { conn.alive = true; });
            ws.on('close', () => connections.delete(conn));
            ws.on('error', () => connections.delete(conn));
            // the feed only speaks; anything a tab says is ignored
            ws.on('message', () => {});
            ws.send(JSON.stringify({ type: 'hello', clientId, handle: conn.handle }));
        });
    };
    server.on('upgrade', onUpgrade);

    const flush = (conn) => {
        conn.scheduled = false;
        const records = conn.pending;
        conn.pending = [];
        if (conn.ws.readyState !== WebSocket.OPEN || !records.length) return;
        const frame = frameFor(conn, records);
        if (frame) conn.ws.send(JSON.stringify(frame));
    };

    // a user's records reach that user's tabs; server.db's (the accounts) reach the admins
    const unsubscribe = subscribeChanges((owner, records) => {
        for (const conn of connections) {
            if (owner === SERVER_SCOPE) {
                // an account record is rare and admins' alone: an admin demoted since the socket
                // opened stops hearing them now, not at the next heartbeat
                conn.admin = !!resolveUser(conn.headers)?.user.admin;
                if (!conn.admin) continue;
            } else if (conn.handle !== owner) continue;
            // appended one at a time: a spread of a set write's frame is an argument list
            for (const r of records) conn.pending.push(r);
            if (!conn.scheduled) {
                conn.scheduled = true;
                setImmediate(() => flush(conn));
            }
        }
    });

    const heartbeat = setInterval(() => {
        for (const conn of connections) {
            const who = resolveUser(conn.headers);
            if (!who || who.userHandle !== conn.handle) {
                conn.ws.close(4001, 'session ended');
                connections.delete(conn);
                continue;
            }
            if (!conn.alive) {
                conn.ws.terminate();
                connections.delete(conn);
                continue;
            }
            conn.alive = false;
            conn.ws.ping();
        }
    }, heartbeatMs);
    heartbeat.unref?.();

    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        server.off('upgrade', onUpgrade);
        for (const conn of connections) conn.ws.terminate();
        connections.clear();
        wss.close();
    };
    server.on('close', close);
    return { close, connections: () => connections.size };
}
