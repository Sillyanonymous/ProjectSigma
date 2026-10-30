import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { config, assertHandle, userPaths } from '../config.js';
import { emitChange, trackHandle, SERVER_SCOPE } from './changes.js';
import { httpError } from '../lib/http-error.js';

// server-level state, accounts and secrets, in data/server.db beside the user homes, never inside one

let serverDb = null;

// server.db's own migrations on the libraries' runner: numbered, never edited once shipped, one transaction each
export const SERVER_MIGRATIONS = [
    `
        CREATE TABLE IF NOT EXISTS users (
            handle TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            admin INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            version INTEGER NOT NULL DEFAULT 1,
            must_change_password INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS server_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `,
];

export class ServerDbAheadError extends Error {
    constructor(version) {
        super(`server.db was written by a newer version of the server (schema ${version}, this one knows ${SERVER_MIGRATIONS.length}). Update the server to open it.`);
        this.name = 'ServerDbAheadError';
        this.statusCode = 503;
    }
}

/** Bring a server.db handle to SERVER_MIGRATIONS.length, one transaction a step; a newer file is refused. */
export function migrateServerDb(db) {
    const current = db.pragma('user_version', { simple: true });
    if (current > SERVER_MIGRATIONS.length) throw new ServerDbAheadError(current);
    for (let v = current; v < SERVER_MIGRATIONS.length; v++) {
        db.transaction(() => {
            const m = SERVER_MIGRATIONS[v];
            if (typeof m === 'function') m(db);
            else db.exec(m);
            db.pragma(`user_version = ${v + 1}`);
        })();
    }
}

export function openServerDb() {
    if (serverDb) return serverDb;
    fs.mkdirSync(config.dataDir, { recursive: true });
    const db = new Database(config.serverDbFile, { timeout: 30000 });
    try {
        db.pragma('journal_mode = WAL');
        migrateServerDb(db);
    } catch (err) {
        // a server.db it cannot read is never left open half-used
        db.close();
        throw err;
    }
    serverDb = db;
    trackHandle(serverDb, SERVER_SCOPE);
    return serverDb;
}

export function closeServerDb() {
    if (serverDb) {
        serverDb.close();
        serverDb = null;
    }
}

export function metaGet(db, key) {
    return db.prepare('SELECT value FROM server_meta WHERE key = ?').get(key)?.value ?? null;
}

export function metaSet(db, key, value) {
    db.prepare('INSERT INTO server_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, String(value));
}

/** Session-cookie HMAC secret, generated once per deployment. */
export function getSessionSecret(db) {
    let secret = metaGet(db, 'session_secret');
    if (!secret) {
        secret = crypto.randomBytes(32).toString('hex');
        metaSet(db, 'session_secret', secret);
    }
    return secret;
}

const SCRYPT_KEYLEN = 64;

function hashPassword(password, salt = crypto.randomBytes(16).toString('base64')) {
    const hash = crypto.scryptSync(String(password).normalize(), salt, SCRYPT_KEYLEN).toString('base64');
    return { salt, hash };
}

export function verifyPassword(userRow, password) {
    const probe = crypto.scryptSync(String(password).normalize(), userRow.salt, SCRYPT_KEYLEN);
    const stored = Buffer.from(userRow.password_hash, 'base64');
    return probe.length === stored.length && crypto.timingSafeEqual(probe, stored);
}

export function getUser(db, handle) {
    return db.prepare('SELECT * FROM users WHERE handle = ?').get(String(handle)) ?? null;
}

/** Listing shape carries no secret material. */
export function listUsers(db) {
    return db.prepare(`SELECT handle, display_name, admin, enabled, must_change_password, created_at
        FROM users ORDER BY created_at`).all()
        .map(u => ({
            handle: u.handle,
            displayName: u.display_name,
            admin: !!u.admin,
            enabled: !!u.enabled,
            mustChangePassword: !!u.must_change_password,
            createdAt: u.created_at,
        }));
}

/** Every account's handle for background work: 'default' in single-user mode; enabledOnly leaves out disabled accounts. */
export function accountHandles(serverDb, { enabledOnly = false } = {}) {
    if (!config.multiUser) return ['default'];
    if (!serverDb) return [];
    try { return listUsers(serverDb).filter(u => !enabledOnly || u.enabled).map(u => u.handle); } catch { return []; }
}

/** Run fn({ handle, paths }) over every account's library (fn opens it: importing database.js here would cycle); a failure goes to onError. */
export function forEachAccountLibrary({ serverDb = null, enabledOnly, onError = () => {} }, fn) {
    if (typeof enabledOnly !== 'boolean') throw new Error('forEachAccountLibrary: say whether a disabled account is walked (enabledOnly)');
    for (const handle of accountHandles(serverDb, { enabledOnly })) {
        let paths;
        try { paths = userPaths(handle); } catch { continue; }
        if (!fs.existsSync(paths.dbFile)) continue;
        try { fn({ handle, paths }); } catch (e) { onError(handle, e); }
    }
}

export function createUser(db, { handle, displayName, password, admin = false, mustChangePassword = false }) {
    assertHandle(handle);
    if (typeof password !== 'string' || password.length < 4) {
        throw httpError(400, 'password must be at least 4 characters');
    }
    if (getUser(db, handle)) {
        throw httpError(409, `user '${handle}' already exists`);
    }
    const { salt, hash } = hashPassword(password);
    db.prepare(`INSERT INTO users (handle, display_name, password_hash, salt, admin, enabled, version, must_change_password, created_at)
        VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`)
        .run(handle, displayName ? String(displayName) : handle, hash, salt, admin ? 1 : 0, mustChangePassword ? 1 : 0, Date.now());
    emitChange(db, { entity: 'user', op: 'created', ids: [handle] });
    return getUser(db, handle);
}

/** Role/enabled flips bump version so outstanding sessions die with the old state. */
export function updateUser(db, handle, { displayName, admin, enabled }) {
    const user = getUser(db, handle);
    if (!user) return null;
    const roleChanged = (admin !== undefined && !!admin !== !!user.admin)
        || (enabled !== undefined && !!enabled !== !!user.enabled);
    db.prepare(`UPDATE users SET
            display_name = COALESCE(?, display_name),
            admin = COALESCE(?, admin),
            enabled = COALESCE(?, enabled),
            version = version + ?
        WHERE handle = ?`)
        .run(displayName !== undefined ? String(displayName) : null,
            admin !== undefined ? (admin ? 1 : 0) : null,
            enabled !== undefined ? (enabled ? 1 : 0) : null,
            roleChanged ? 1 : 0, handle);
    emitChange(db, { entity: 'user', op: 'updated', ids: [handle] });
    return getUser(db, handle);
}

export function setPassword(db, handle, password, { mustChange = false } = {}) {
    if (typeof password !== 'string' || password.length < 4) {
        throw httpError(400, 'password must be at least 4 characters');
    }
    const user = getUser(db, handle);
    if (!user) return null;
    const { salt, hash } = hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ?, salt = ?, must_change_password = ?, version = version + 1 WHERE handle = ?')
        .run(hash, salt, mustChange ? 1 : 0, handle);
    emitChange(db, { entity: 'user', op: 'updated', ids: [handle], fields: ['password'] });
    return getUser(db, handle);
}

export function deleteUser(db, handle) {
    const gone = db.prepare('DELETE FROM users WHERE handle = ?').run(String(handle)).changes > 0;
    if (gone) emitChange(db, { entity: 'user', op: 'deleted', ids: [String(handle)] });
    return gone;
}

export function countAdmins(db) {
    return db.prepare('SELECT COUNT(*) n FROM users WHERE admin = 1').get().n;
}

export function countUsers(db) {
    return db.prepare('SELECT COUNT(*) n FROM users').get().n;
}
