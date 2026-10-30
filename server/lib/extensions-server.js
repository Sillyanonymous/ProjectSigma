// Server halves: each mounts at /api/ext/<id>/ behind requireUser and answers only the accounts that
// switched it on. Loaded at boot only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Router } from 'express';
import { requireAdmin } from '../auth.js';
import { guardProxyTarget, sessionSlot, sameHostFetch, wildcardPath, debugLogAs } from '../services/shared.js';
import { settingValue } from '../db/settings-store.js';
import { emitChange, subscribeChanges, SERVER_SCOPE } from '../db/changes.js';
import { onLibraryOpen, forEachOpenLibrary } from '../db/database.js';
import { registerExtensionMigrations, dropExtensionMigrations, extTablePrefix } from '../db/ext-migrations.js';
import { addProjection, addRuleField, addSortKey, readyLibrary, dropExtensionQuery } from '../db/ext-query.js';
import { config } from '../config.js';
import { listExtensions, extensionDir, extensionDataDir, extensionUserDir, extensionEnabledFor, sweepInstallStages, segmentOk, SERVER_EXT_API_VERSION } from './extensions.js';
import { writeFileAtomic } from './atomic-write.js';
import { addHook, addMacro, addPromptBlock, addListener, dropExtensionHooks, ExtensionRefusal, extensionReport } from './ext-hooks.js';
import { llmDoor } from './ext-llm.js';
import { runJob, addSchedule, listExtensionJobs, dropExtensionJobs } from './ext-jobs.js';
import { stageCardBody } from '../importer/card-file.js';
import { readChatForPrompt, readChatNames, promptVisible } from '../llm/prompt.js';
import { chatExists, getChatRow, patchChat, chatMetadataOf } from '../db/chats-store.js';

// the extension api version server halves are written against, the inventory's

// id -> { state: 'loaded' | 'failed' | 'restart' | 'removed', error? }; absent = not mounted this boot
const _states = new Map();
// id -> whether the half this boot mounted under the id was the bundled one
const _mountedBundled = new Map();

/**
 * The state of the half a row booted, or undefined; a folder shadowing a bundled id never shares its state.
 * @param {{ id: string, bundled?: boolean }} row
 */
export function serverStateOf(row) {
    return _mountedBundled.get(row.id) === !!row.bundled ? _states.get(row.id) : undefined;
}

/**
 * Record what a lifecycle verb did to a mounted half: 'restart' after an update, 'removed' after a removal.
 * @param {string} id extension id
 * @param {'restart'|'removed'} state
 */
export function markServerHalf(id, state) {
    const now = _states.get(id)?.state;
    // a restart marks only a serving half; a failed or removed one stays so, or its gate would reopen
    if (state === 'restart' ? now === 'loaded' : now !== undefined) _states.set(id, { state });
    // a removed extension's guards, listeners and query doors stop with its routes
    if (state === 'removed') releaseHalf(id);
}

// everything a half registered beyond its routes; its tables stay
function releaseHalf(id) {
    dropExtensionHooks(id);
    dropExtensionJobs(id);
    dropExtensionQuery(id);
    dropExtensionMigrations(id);
}

// a half failing after the mount fails for everyone; the message names no account, only the log does
function failHalf(id, message, error, handle = null) {
    console.error(`[extensions] server half of "${id}" failed ${message}${handle ? ` (the library of ${handle})` : ''}`, error);
    _states.set(id, { state: 'failed', error: message });
    releaseHalf(id);
}

// id -> inventory row, for each half mounted this boot
const _rows = new Map();
const running = (id) => ['loaded', 'restart'].includes(_states.get(id)?.state);
// the account a library belongs to, for a failure's message: data/<handle>/library.db
const handleOfDb = (db) => path.basename(path.dirname(String(db?.name || '')));

/** Make a running half ready (tables built, doors proven) in a library whose account has it on; a refusal fails the half. */
export function readyHalfFor(db, id) {
    const row = _rows.get(id);
    if (!row || !running(id) || !extensionEnabledFor(db, row)) return;
    try { readyLibrary(db, id); } catch (e) { failHalf(id, `in one account's library: ${e.message}`, e, handleOfDb(db)); }
}

let _opener = null;
let _switchWatch = null;
const SWITCH_KEYS = ['enabledExtensions', 'disabledExtensions'];
// ready halves on every library open and every switch, however written, so none runs where its tables are not
function watchLibraryOpens() {
    _opener ??= onLibraryOpen((db) => { for (const id of _rows.keys()) readyHalfFor(db, id); });
    _switchWatch ??= subscribeChanges((owner, records, db) => {
        if (!db || owner === SERVER_SCOPE) return;
        const switched = records.some(r => r.entity === 'setting' && (r.all || (r.ids || []).some(k => SWITCH_KEYS.includes(k))));
        if (switched) for (const id of _rows.keys()) readyHalfFor(db, id);
    });
}

/** The library store modules by name (stores.characters), so a half's writes pass the guards and reach the feed. */
export async function loadStores() {
    const dir = fileURLToPath(new URL('../db/', import.meta.url));
    const out = {};
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('-store.js') && f !== 'server-store.js').sort()) {
        const key = f.slice(0, -'-store.js'.length).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        out[key] = await import(pathToFileURL(path.join(dir, f)).href);
    }
    return Object.freeze(out);
}

function openDoor(mount, kind, declare) {
    if (!mount.open) throw new Error(`query.${kind}: declare a door inside register; this one came after the half mounted`);
    return declare();
}

// the text a stored message shows; the client host's twin is held to it over a shared corpus
function shownText(msg) {
    if (!msg || typeof msg !== 'object') return '';
    const swipes = Array.isArray(msg.swipes) ? msg.swipes : null;
    if (swipes && swipes.length > 1) {
        const at = Math.min(Math.max(Number(msg.swipe_id) || 0, 0), swipes.length - 1);
        return typeof swipes[at] === 'string' ? swipes[at] : '';
    }
    return typeof msg.mes === 'string' ? msg.mes : '';
}

// FNV-1a over a text, as eight hex digits: small, stable, and the same in the page and in node
function digestOf(text) {
    let h = 0x811c9dc5;
    const s = String(text ?? '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

// a text between fences it cannot close: a run longer than any inside it, three at least
function fencedText(text, { char = '~' } = {}) {
    if (char !== '~' && char !== '`') throw new Error("prompt.fence: char is '~' or '`'");
    const s = String(text ?? '');
    const longest = Math.max(0, ...[...s.matchAll(char === '~' ? /~+/g : /`+/g)].map(m => m[0].length));
    const fence = char.repeat(Math.max(3, longest + 1));
    return `${fence}\n${s}\n${fence}`;
}

const plainObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

// a folder of an extension's own (ctx.files): every name stays inside it, every write lands whole
function fileFolder(root, door) {
    const at = (verb, name, { folder = false } = {}) => {
        const where = `${door}.${verb}`;
        if (folder && (name === undefined || name === null || name === '')) return root;
        if (typeof name !== 'string' || !name) throw new Error(`${where}: name a file by a path relative to the folder, not ${JSON.stringify(name)}`);
        if (path.isAbsolute(name) || /^[\\/]/.test(name) || /^[a-zA-Z]:/.test(name)) throw new Error(`${where}: '${name}' is an absolute path or names a drive; name one relative to the folder`);
        const steps = name.split(/[\\/]/);
        const bad = steps.find(s => s !== '' && s !== '.' && s !== '..' && !segmentOk(s));
        if (bad !== undefined) throw new Error(`${where}: '${name}' holds '${bad}', a name not every disk can hold`);
        const full = path.resolve(root, ...steps);
        const rel = path.relative(root, full);
        if (rel.split(path.sep)[0] === '..' || path.isAbsolute(rel)) throw new Error(`${where}: '${name}' leaves the folder`);
        if (!rel) {
            if (folder) return root;
            throw new Error(`${where}: '${name}' names the folder itself, not a file in it`);
        }
        return full;
    };
    const read = (verb, name) => {
        const file = at(verb, name);
        try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    };
    const write = (verb, name, data) => {
        const file = at(verb, name);
        if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw new Error(`${door}.${verb}: '${name}': write a string or a Buffer`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeFileAtomic(file, data);
    };
    return Object.freeze({
        read: (name) => read('read', name),
        readJson(name, fallback = null) {
            const text = read('readJson', name);
            if (text === null) return fallback;
            try { return JSON.parse(text); } catch (e) { throw new Error(`${door}.readJson: '${name}' is not JSON (${e.message})`); }
        },
        write: (name, data) => write('write', name, data),
        writeJson(name, value) {
            const text = JSON.stringify(value, null, 2);
            if (text === undefined) throw new Error(`${door}.writeJson: '${name}': ${typeof value} is no JSON value`);
            write('writeJson', name, `${text}\n`);
        },
        remove(name) { fs.rmSync(at('remove', name), { recursive: true, force: true }); },
        list(sub) {
            const dir = at('list', sub, { folder: true });
            try { return fs.readdirSync(dir).sort(); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
        },
        path(name) {
            const file = at('path', name);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            return file;
        },
    });
}

// the requesting account's folder of an extension's own, for userDataDir and files.user
function userFolderOf(req, id, door) {
    if (typeof req?.userHandle !== 'string') throw new Error(`${door}: pass the request (req), whose account the folder is`);
    return extensionUserDir(req.userHandle, id);
}

/** The ctx a server half's register(router, ctx) is handed. */
export function buildServerCtx(row, stores, mount = { open: true }) {
    const id = row.id;
    const doorOpts = {
        enabled: (db) => extensionEnabledFor(db, row),
        prefix: extTablePrefix(id),
        // a library the half cannot be made ready in, found by a query: the half fails, the query goes on
        onFail: (e, db) => failHalf(id, `in one account's library: ${e.message}`, e, handleOfDb(db)),
    };
    // the extension's own setting: its scoped key with the manifest default the client facade reads too
    const setting = (db, key) => settingValue(db, `ext:${id}:${key}`, (row.settings || {})[key]);
    return {
        manifest: row,
        // the extension api this server speaks, as the page's ctx carries its own
        apiVersion: SERVER_EXT_API_VERSION,
        // gate any route with it: router.post('/x', ctx.requireAdmin, handler)
        requireAdmin,
        // gate a route whose path names :chatId on that chat existing in the account's library
        requireChat: (req, res, next) => (chatExists(req.db, String(req.params.chatId ?? '')) ? next() : res.status(404).json({ error: 'no such chat' })),
        // whether this server runs with accounts; single-user installs read false
        multiUser: config.multiUser,
        settingValue,
        setting,
        // its slot in chat_metadata.extensions.<id>: get answers {} for none; set replaces it, null removes it
        chatSlot: Object.freeze({
            get: (db, chatId) => plainObject(chatMetadataOf(getChatRow(db, chatId)?.chat_metadata).extensions?.[id]) || {},
            set: (db, chatId, value) => { patchChat(db, chatId, { chatMetadata: { extensions: { [id]: value } } }); },
        }),
        // the text a message shows (its active alternate) and a digest of it, the same as the page's
        messages: Object.freeze({ shown: shownText, digest: digestOf }),
        // the hardened transport helpers first-party provider services run on
        helpers: { guardProxyTarget, sessionSlot, sameHostFetch, wildcardPath },
        // routine logs ride the same per-user debugMode gate as everything else
        debugLog: (req, ...args) => debugLogAs(`[ext:${id}]`, req, ...args),
        // extension-global scratch (caches) beside the installs, at <extensions dir>/.data/<id>:
        // never served, never inside an install, for both tiers; removeExtension deletes it
        dataDir() {
            const dir = extensionDataDir(id);
            fs.mkdirSync(dir, { recursive: true });
            return dir;
        },
        // per-user data, inside that user's own home like every other user file; removeExtension
        // deletes it from every account's home
        userDataDir(req) {
            const dir = userFolderOf(req, id, 'ctx.userDataDir');
            fs.mkdirSync(dir, { recursive: true });
            return dir;
        },
        // the two folders above as handles; synchronous, for small files (path(name) for an engine that opens its own)
        files: Object.freeze({
            user: (req) => fileFolder(userFolderOf(req, id, 'ctx.files.user'), 'ctx.files.user(req)'),
            shared: () => fileFolder(extensionDataDir(id), 'ctx.files.shared()'),
        }),
        // store guards run before a write commits (ctx.refuse rolls it back); filters answer the value to hand on
        hooks: Object.freeze({ add: (name, fn, opts) => addHook(row, name, fn, opts) }),
        // {{name}} in a prompt: a function, or { args, list, strict, handler }, called with the build's facts
        macros: Object.freeze({ add: (name, macro) => addMacro(row, name, macro) }),
        // a block of each prompt build, and a chat read as its prompt reads it (read, names, visible, fence)
        prompt: Object.freeze({
            addBlock: (spec) => addPromptBlock(row, spec),
            read: (db, chatId) => readChatForPrompt(db, chatId),
            names: (db, chatId) => readChatNames(db, chatId),
            visible: (msg) => promptVisible(msg),
            fence: fencedText,
        }),
        // the account's own models: chat(db, { messages, profileId or profileSetting, chatId, model, params },
        // { signal }) and stream(...), for the accounts that switched this extension on
        llm: llmDoor(row, setting),
        // background work, one job at a time per account: run queues one, schedule one per account each interval
        jobs: Object.freeze({ run: (db, spec) => runJob(row, db, spec), schedule: (spec) => addSchedule(row, spec), list: (db) => listExtensionJobs(row, db) }),
        refuse(message) { throw new ExtensionRefusal(message, id); },
        // every committed batch, fn(records, { db, user }), once the write returned, for the
        // accounts that switched this extension on
        events: Object.freeze({ on: (fn) => addListener(row, fn) }),
        stores,
        // a card file the half holds, staged as an upload to POST /characters/import/stage is
        imports: Object.freeze({ stage: (req, body, opts) => stageCardBody(req.paths, body, opts) }),
        // a write to its own tables, reported as the core entity it changes, inside the write's transaction
        report(db, record) {
            if (!db?.inTransaction) throw new Error('report: call it inside the write\'s db.transaction');
            emitChange(db, extensionReport(id, record));
        },
        // doors over its own tables, declared inside register so the mount proves each in every ready library
        query: Object.freeze({
            projection: (spec) => openDoor(mount, 'projection', () => addProjection(id, doorOpts, spec)),
            ruleField: (spec) => openDoor(mount, 'ruleField', () => addRuleField(id, doorOpts, spec)),
            sortKey: (spec) => openDoor(mount, 'sortKey', () => addSortKey(id, doorOpts, spec)),
        }),
    };
}

/**
 * Import and mount every installed extension's server half onto the /api/ext router.
 * One failure disables that extension's half, loudly, and never aborts boot.
 */
export async function mountServerExtensions(parent) {
    sweepInstallStages();
    const rows = listExtensions().filter(row => row.server && !row.error);
    const stores = rows.length ? await loadStores() : null;
    for (const row of rows) {
        _mountedBundled.set(row.id, !!row.bundled);
        try {
            const mod = await import(pathToFileURL(path.join(extensionDir(row.id, row.bundled), row.server)).href);
            if (typeof mod.register !== 'function') throw new Error('server entry must export register(router, ctx)');
            const router = Router();
            // a server built again in this process mounts each half afresh, or its guards would double
            releaseHalf(row.id);
            const mount = { open: true };
            try {
                registerExtensionMigrations(row.id, mod.migrations);
                await mod.register(router, buildServerCtx(row, stores, mount));
                mount.open = false;
                // the libraries open now whose accounts have it on: its tables, then its doors
                forEachOpenLibrary((db) => { if (extensionEnabledFor(db, row)) readyLibrary(db, row.id); });
            } catch (e) {
                mount.open = false;
                // a half that fails part way leaves none of its guards, listeners or doors behind
                releaseHalf(row.id);
                throw e;
            }
            // the gate: a removed or failed half stops answering at once, and serves only accounts that switched it on
            parent.use(`/${row.id}`, (req, res, next) => {
                const st = _states.get(row.id);
                if (st?.state === 'removed') return res.status(404).json({ error: `extension '${row.id}' was removed` });
                if (st?.state === 'failed') return res.status(404).json({ error: `extension '${row.id}' failed: ${st.error}` });
                if (!extensionEnabledFor(req.db, row)) return res.status(404).json({ error: `extension '${row.id}' is not switched on for this account` });
                // switched on by a raw settings write: its tables exist before its first request
                readyHalfFor(req.db, row.id);
                if (_states.get(row.id)?.state === 'failed') return res.status(404).json({ error: `extension '${row.id}' failed: ${_states.get(row.id).error}` });
                return router(req, res, next);
            });
            _states.set(row.id, { state: 'loaded' });
            _rows.set(row.id, row);
            watchLibraryOpens();
        } catch (e) {
            console.error(`[extensions] server half of "${row.id}" failed to load:`, e);
            _states.set(row.id, { state: 'failed', error: e.message });
        }
    }
}
