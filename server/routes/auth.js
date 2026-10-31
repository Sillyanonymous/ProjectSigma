import { Router } from 'express';
import { config, HANDLE_RE } from '../config.js';
import { issueSession, clearSession, requireUser, authRequired } from '../auth.js';
import { openServerDb, getUser, verifyPassword, setPassword } from '../db/server-store.js';

export const authRouter = Router();

// Login throttle, keyed on the handle first (a proxy hides the client), then the socket address, never req.ip
const HANDLE_FAIL_LIMIT = 5;      // free attempts per handle inside the window
const IP_FAIL_LIMIT = 30;         // loose backstop: behind Funnel every user shares one
                                  // address, so a tight IP lock would let one guesser
                                  // sign everyone out of the login form
const FAIL_WINDOW_MS = 15 * 60_000;
const LOCK_BASE_MS = 30_000;      // then 30s, doubling per further failure, capped
const LOCK_MAX_MS = 15 * 60_000;
const _fails = new Map();         // key -> { count, first, lockedUntil }; swept at most once a minute and capped, a flood never evicts a live lock
const FAILS_MAX = 10_000;
const SWEEP_EVERY_MS = 60_000;
let _nextSweep = 0;

const expired = (v, now) => now - v.first > FAIL_WINDOW_MS && now > (v.lockedUntil || 0);

function sweepFailures(now) {
    for (const [k, v] of _fails) if (expired(v, now)) _fails.delete(k);
}

function throttleState(key) {
    const now = Date.now();
    const s = _fails.get(key);
    if (!s || (now - s.first > FAIL_WINDOW_MS && now > (s.lockedUntil || 0))) return null;
    return s;
}

function retryAfterS(key) {
    const s = throttleState(key);
    if (!s || !s.lockedUntil || Date.now() > s.lockedUntil) return 0;
    return Math.ceil((s.lockedUntil - Date.now()) / 1000);
}

function recordFailure(key, limit) {
    const now = Date.now();
    if (now >= _nextSweep) {
        _nextSweep = now + SWEEP_EVERY_MS;
        sweepFailures(now);
    }
    const s = throttleState(key) || { count: 0, first: now, lockedUntil: 0 };
    s.count += 1;
    if (s.count >= limit) {
        const over = s.count - limit;
        s.lockedUntil = now + Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** over);
    }
    _fails.set(key, s);
    if (_fails.size > FAILS_MAX) {
        sweepFailures(now);
        for (const [k, v] of _fails) {
            if (_fails.size <= FAILS_MAX) break;
            if (!(v.lockedUntil > now)) _fails.delete(k);
        }
    }
}

function clearFailures(key) { _fails.delete(key); }

authRouter.post('/login', (req, res) => {
    if (!config.multiUser) return res.status(400).json({ error: 'multi-user is disabled on this server' });
    const { handle, password } = req.body || {};
    const cleanHandle = typeof handle === 'string' ? handle.toLowerCase().trim() : '';
    // a handle outside the grammar matches no account, so every such guess shares one key
    const handleKey = HANDLE_RE.test(cleanHandle) ? `h:${cleanHandle}` : 'h:';
    const ipKey = `ip:${req.socket.remoteAddress || 'unknown'}`;
    const wait = Math.max(retryAfterS(handleKey), retryAfterS(ipKey));
    if (wait > 0) {
        res.set('Retry-After', String(wait));
        return res.status(429).json({ error: `too many attempts, retry in ${wait}s` });
    }
    const user = cleanHandle ? getUser(openServerDb(), cleanHandle) : null;
    // one generic error for every failure shape: no account enumeration
    if (!user || !user.enabled || typeof password !== 'string' || !verifyPassword(user, password)) {
        recordFailure(handleKey, HANDLE_FAIL_LIMIT);
        recordFailure(ipKey, IP_FAIL_LIMIT);
        return res.status(401).json({ error: 'invalid credentials' });
    }
    clearFailures(handleKey);
    issueSession(req, res, user);
    res.json({
        handle: user.handle,
        displayName: user.display_name,
        admin: !!user.admin,
        mustChangePassword: !!user.must_change_password,
    });
});

authRouter.post('/logout', (req, res) => {
    clearSession(req, res);
    res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
    if (!config.multiUser) {
        return res.json({ multiUser: false, handle: 'default', displayName: 'Default', admin: true, mustChangePassword: false });
    }
    if (!req.user) return authRequired(res);
    res.json({ multiUser: true, ...req.user });
});

// self-service and forced password change; the version bump kills the old cookie, so a fresh one ships
authRouter.post('/password', requireUser, (req, res) => {
    if (!config.multiUser) return res.status(400).json({ error: 'multi-user is disabled on this server' });
    const { currentPassword, newPassword } = req.body || {};
    // the current password is a guess, so it counts against the account's login lock
    const handleKey = `h:${req.userHandle}`;
    const wait = retryAfterS(handleKey);
    if (wait > 0) {
        res.set('Retry-After', String(wait));
        return res.status(429).json({ error: `too many attempts, retry in ${wait}s` });
    }
    const db = openServerDb();
    const user = getUser(db, req.userHandle);
    if (!user || typeof currentPassword !== 'string' || !verifyPassword(user, currentPassword)) {
        recordFailure(handleKey, HANDLE_FAIL_LIMIT);
        return res.status(401).json({ error: 'current password is wrong' });
    }
    clearFailures(handleKey);
    const updated = setPassword(db, user.handle, newPassword, { mustChange: false });
    issueSession(req, res, updated);
    res.json({ ok: true });
});
