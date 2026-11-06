// SPDX-License-Identifier: 0BSD

// The extension kit: the real server in this process on a temporary home, your extensions installed
// first. Guide: docs/guide.html#extensions/testing-your-extension.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openPage } from './page.mjs';
import { lintExtension, lintReport } from './lint.mjs';

export { lintExtension, CHECKS } from './lint.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// the server's modules read the data folder when first imported, so they load only after it is set
const serverModule = (rel) => import(pathToFileURL(path.join(repo, 'server', rel)).href);

// ---- a 1x1 png a card rides in (the crc is our own, so a card's reader is not checked by itself)
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); }
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([head, typeBuf, data, crc]);
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
export const basePng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0)),
]);

// installed as a reader's install leaves it: under the installed root, named by its manifest's id
function installable(dir) {
    const src = path.resolve(dir);
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
    } catch (e) {
        throw new Error(`startSigma: ${src} has no readable manifest.json (${e.message})`);
    }
    if (!manifest || typeof manifest.id !== 'string' || !manifest.id) throw new Error(`startSigma: ${src}/manifest.json names no id`);
    // the server keys the bundled set by folder and refuses an install of the same id as shadowing it, mounting nothing
    if (fs.statSync(path.join(repo, 'extensions', 'bundled', manifest.id), { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`startSigma: ${src}/manifest.json names "${manifest.id}", the id of an extension bundled with the app; the server would refuse the install as shadowing it. Give your copy an id of its own`);
    }
    return { src, id: manifest.id };
}

let started = false;

/**
 * Boot the server on a temporary home; one server a process, since the server reads its data folder once.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] extension folders, each installed before the boot
 * @param {Array<{ handle: string, password: string, admin?: boolean, displayName?: string }>} [opts.accounts] made before the boot, each signed in
 * @param {string} [opts.prefix] the temporary folder's name prefix
 * @param {(dataDir: string) => void | Promise<void>} [opts.setup] run on the data folder before the boot
 * @param {boolean} [opts.lint] false skips the checks the kit runs on each extension's scripts before the boot
 */
export async function startSigma({ extensions = [], accounts = null, prefix = 'sigma-kit', setup = null, lint = true } = {}) {
    if (started) throw new Error('startSigma: one server a process (the server reads its data folder once); run another test file for another');
    // every folder is read and checked before anything starts, so one the kit refuses leaves this process free to start
    const folders = extensions.map(installable);
    if (lint) {
        for (const f of folders) {
            const found = lintExtension(f.src);
            if (found.length) throw new Error(lintReport(f.id, found));
        }
    }
    started = true;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    const dataDir = path.join(tmpDir, 'data');
    process.env.CL_DATA_DIR = dataDir;
    process.env.CL_EXTENSIONS_DIR = path.join(dataDir, 'extensions');
    process.env.CL_MULTI_USER = accounts ? 'true' : 'false';
    for (const { src, id } of folders) fs.cpSync(src, path.join(dataDir, 'extensions', id), { recursive: true, filter: (p) => path.basename(p) !== '.git' });
    const installed = folders.map(f => f.id);
    if (setup) await setup(dataDir);

    const { writeCardChunks } = await serverModule('lib/png-card.js');
    const { openDb, closeDb } = await serverModule('db/database.js');
    const serverStore = await serverModule('db/server-store.js');
    const { subscribeChanges } = await serverModule('db/changes.js');
    const chars = await serverModule('db/characters-store.js');
    const { clientIdOf, attachFeed } = await serverModule('lib/feed.js');
    // the accounts exist before the app boots, so no bootstrap admin is minted
    if (accounts) {
        const sdb = serverStore.openServerDb();
        for (const a of accounts) serverStore.createUser(sdb, { handle: a.handle, displayName: a.displayName || a.handle, password: a.password, admin: !!a.admin });
    }
    // every committed change, as the feed delivers it to the account's tabs
    const changes = [];
    subscribeChanges((owner, records) => { for (const r of records) changes.push({ owner, ...r }); });
    const { createApp } = await serverModule('index.js');
    const { runScheduleNow } = await serverModule('lib/ext-jobs.js');
    const app = await createApp();
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const jsonHeaders = { 'Content-Type': 'application/json' };
    // the feed answers once a page listens, as the served app attaches it beside its listen
    let feedAttached = false;
    const attachFeedOnce = () => { if (!feedAttached) { attachFeed(server); feedAttached = true; } };
    const pages = new Set();

    // what one account's page sends: its cookie when there are accounts, and its tab's id when it has one
    const session = (handle, cookie = null, clientId = null) => {
        const own = { ...(cookie ? { Cookie: cookie } : {}), ...(clientId ? { 'X-CL-Client': clientId } : {}) };
        // the app's apiRequest as a module gets it: a path under /api, a method, a JSON body or raw bytes, the Response
        const apiRequest = (endpoint, method = 'GET', data = null, opts = {}) => fetch(`${base}/api${endpoint}`, {
            method,
            headers: { ...(opts.raw ? (opts.headers || {}) : jsonHeaders), ...own },
            body: data == null ? undefined : (opts.raw ? data : JSON.stringify(data)),
            signal: opts.signal,
        });
        const api = async (endpoint, method = 'GET', data = null) => {
            const resp = await apiRequest(endpoint, method, data);
            return { status: resp.status, body: await resp.json().catch(() => null) };
        };
        return {
            handle,
            /** the tab id its writes carry, null for none */
            clientId,
            apiRequest,
            api,
            /** @param {string} id an extension's routes, under /api/ext/<id> */
            ext: (id) => (p, method = 'GET', data = null) => api(`/ext/${id}${p}`, method, data),
            /** Switch an extension on (or off) for this account, as its manager row does. */
            enable: (id, on = true) => api(`/extensions/${encodeURIComponent(id)}/enabled`, 'PUT', { enabled: on }),
            /** Import a card (a V2 or V3 card, or just its data) as a file upload is imported; answers the import's row. */
            importCard: async (card, name = `${(card.data || card).name || 'card'}.png`) => {
                const whole = card.spec ? card : { spec: 'chara_card_v2', spec_version: '2.0', data: card };
                const resp = await apiRequest(`/characters/import?name=${encodeURIComponent(name)}`, 'POST', writeCardChunks(basePng, whole), { raw: true, headers: { 'Content-Type': 'image/png' } });
                const row = await resp.json().catch(() => null);
                if (!resp.ok || !row?.id) throw new Error(`importCard: the import answered ${resp.status} ${row?.error || ''}`.trim());
                return row;
            },
            /** The page this account's tab would run: the extension's client half in node (page.mjs). */
            page: async () => {
                // a page is a tab: its writes carry its id, so the feed tells the page its own echoes
                const tab = clientId ? { apiRequest, clientId } : session(handle, cookie, `kit-tab-${crypto.randomUUID().slice(0, 8)}`);
                const p = await openPage({ apiRequest: tab.apiRequest, base, dataDir, cookie, clientId: tab.clientId, attachFeed: attachFeedOnce });
                const close = p.close;
                pages.add(p);
                p.close = () => { pages.delete(p); close(); };
                return p;
            },
        };
    };

    return {
        base,
        dataDir,
        tmpDir,
        server,
        /** the ids of the extensions installed from opts.extensions */
        installed,
        changes,
        /** the one account of a server without accounts; null when there are accounts (sign in instead) */
        session: accounts ? null : session('default'),
        /** Sign an account in; answers its session. */
        signIn: async (handle, password, { clientId = null } = {}) => {
            if (!accounts) throw new Error('signIn: this server runs without accounts; use sigma.session');
            // the server drops a tab id it cannot read without a word, and the origins go with it
            if (clientId !== null && clientIdOf(clientId) !== clientId) throw new Error(`signIn: the tab id "${clientId}" is not one the server reads (8 to 64 letters, digits or dashes)`);
            const resp = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ handle, password }) });
            if (resp.status !== 200) throw new Error(`signIn: sign in as ${handle}: ${resp.status}`);
            return session(handle, resp.headers.get('set-cookie').split(';')[0], clientId);
        },
        /** An account's library, the database its routes read and write. */
        db: (handle = 'default') => openDb(handle),
        /** The plan SQLite picks for a statement in an account's library, line by line. */
        explain: (handle, sql, ...params) => openDb(handle).prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(r => r.detail),
        /** Statistics on an account's library, as its tables have them once the server has run a while. */
        analyze: (handle = 'default') => { openDb(handle).exec('ANALYZE'); },
        /** A schedule's tick now (the kit arms no timers): its job queued for every account with the extension on; answers how many. */
        tick: (extId, scheduleId) => runScheduleNow(extId, scheduleId),
        /** n characters in an account's library in one write, for a plan pinned at scale; answers their ids. */
        seed: (handle, n, { name = (i) => `Seed ${i}` } = {}) => {
            const db = openDb(handle);
            const ids = [];
            db.transaction(() => {
                for (let i = 0; i < n; i++) {
                    ids.push(chars.upsertImportedCharacter(db, { card: { spec: 'chara_card_v3', spec_version: '3.0', data: { name: name(i), description: '' } }, tags: [], aliases: [], providerLinks: [] }).id);
                }
            })();
            return ids;
        },
        /** Stop the server, close the libraries and take the temporary home away. */
        close: () => {
            for (const p of [...pages]) p.close();
            try { server.close(); } catch { /* going down */ }
            try { closeDb(); serverStore.closeServerDb(); } catch { /* going down */ }
            fs.rmSync(tmpDir, { recursive: true, force: true });
        },
    };
}
