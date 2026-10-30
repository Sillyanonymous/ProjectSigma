import crypto from 'node:crypto';
import { config, userPaths, ensureUserDirs } from './config.js';
import { openDb } from './db/database.js';
import { openServerDb, getUser, getSessionSecret } from './db/server-store.js';

// handle.issuedAt.userVersion.signature, no store: a version bump revokes, a cookie older than the
// user's row never signs in

const COOKIE = 'cl_session';

function sign(payload, secret) {
    return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

// Secure only over TLS (or a proxy's forwarded https), a plain LAN http visit would lose its cookie
function arrivedOverTls(req) {
    return !!(req?.secure || req?.headers?.['x-forwarded-proto'] === 'https');
}

// browsers keep a cookie at most this long; a cookie with no Max-Age would end with the browser instead
const BROWSER_COOKIE_CAP_DAYS = 400;

export function issueSession(req, res, user) {
    const secret = getSessionSecret(openServerDb());
    const payload = `${user.handle}.${Date.now()}.${user.version}`;
    const days = config.sessionTimeoutDays > 0 ? config.sessionTimeoutDays : BROWSER_COOKIE_CAP_DAYS;
    const secure = arrivedOverTls(req) ? 'Secure; ' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${sign(payload, secret)}; Path=/; HttpOnly; SameSite=Strict; ${secure}Max-Age=${days * 86400}`);
}

export function clearSession(req, res) {
    const secure = arrivedOverTls(req) ? 'Secure; ' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; ${secure}Max-Age=0`);
}

function readSession(req) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0 || part.slice(0, eq).trim() !== COOKIE) continue;
        const segments = part.slice(eq + 1).trim().split('.');
        if (segments.length !== 4) return null;
        const [handle, issued, version, sig] = segments;
        const payload = `${handle}.${issued}.${version}`;
        const expected = sign(payload, getSessionSecret(openServerDb()));
        const a = Buffer.from(sig);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
        if (config.sessionTimeoutDays > 0 && Date.now() - Number(issued) > config.sessionTimeoutDays * 86400_000) return null;
        return { handle, version: Number(version), issuedAt: Number(issued) };
    }
    return null;
}

// user homes get their dirs made once per process, not once per request
const ensured = new Set();
function pathsFor(handle) {
    if (!ensured.has(handle)) {
        ensureUserDirs(handle);
        ensured.add(handle);
    }
    return userPaths(handle);
}

/** Forget that an account's folders were made (its admin deleted it; the folder may go too). */
export function forgetAccountPaths(handle) {
    ensured.delete(handle);
}

/** Resolves the request's user. multiUser off = everyone is 'default', no login. */
export function attachUser(req, res, next) {
    if (!config.multiUser) {
        req.userHandle = 'default';
        req.user = { handle: 'default', displayName: 'Default', admin: true, mustChangePassword: false };
        req.paths = pathsFor('default');
        req.db = openDb('default');
        return next();
    }
    const session = readSession(req);
    if (session) {
        const row = getUser(openServerDb(), session.handle);
        // a cookie from before the row was made belongs to a deleted account of the same handle
        if (row && row.enabled && row.version === session.version && session.issuedAt >= row.created_at) {
            req.userHandle = row.handle;
            req.user = {
                handle: row.handle,
                displayName: row.display_name,
                admin: !!row.admin,
                mustChangePassword: !!row.must_change_password,
            };
            req.paths = pathsFor(row.handle);
            req.db = openDb(row.handle);
            return next();
        }
    }
    req.userHandle = null;
    req.user = null;
    next();
}

export function requireUser(req, res, next) {
    if (req.user) return next();
    res.status(401).json({ error: 'authentication required' });
}

export function requireAdmin(req, res, next) {
    if (req.user?.admin) return next();
    res.status(req.user ? 403 : 401).json({ error: req.user ? 'admin required' : 'authentication required' });
}

// enforced here, not by the overlay a client can ignore; /api/auth mounts above it so the change can land
export function requirePasswordChanged(req, res, next) {
    if (!req.user?.mustChangePassword) return next();
    res.status(403).json({
        error: 'password change required before using this server',
        mustChangePassword: true,
    });
}
