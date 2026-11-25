// Extension inventory and install lifecycle. Trusted code, so every mutation is admin-gated; the id
// IS the folder name, checked on every listing.
import fs from 'node:fs';
import path from 'node:path';
import { config, userPaths } from '../config.js';
import { settingValue, patchSettings } from '../db/settings-store.js';
import { emitChange, ownerOf, SERVER_SCOPE } from '../db/changes.js';
import { openServerDb, getUser, forEachAccountLibrary, accountHandles } from '../db/server-store.js';
import { openDb } from '../db/database.js';
import { extTablePrefix } from '../db/ext-migrations.js';
import { NS_RE, PROVIDER_NAMESPACES, FIRST_PARTY_NAMESPACES } from './provider-namespaces.js';
import { OP_STATE_EXTENSIONS, IDENTITY_EXTENSIONS, CARD_FORMAT_EXTENSIONS } from './card-normalize.js';
import { readZipIndex, readZipEntryAsync, quoteName } from './zip.js';
import { assertSlugId } from './ext-contract.js';
import { httpError } from './http-error.js';
import { nextTurn } from './steps.js';
import { GIT_TIMEOUT_MS, runGit, gitOut, gitWords, withRepo } from './git.js';

// 2 to 60 characters: the id rides the store document key `ext-<id>`, whose grammar stops at 64
export const EXT_ID_RE = /^[a-z0-9][a-z0-9-]{1,59}$/;
// the extension api both halves speak, '<major>.<minor>': the minor moves with each batch of new doors, the major on a break
export const SERVER_EXT_API_VERSION = '2.11';

/**
 * An api version as [major, minor]: a whole number from 1 is that major's .0, a 'major.minor' string
 * names both; null for anything else.
 */
export function apiParts(v) {
    if (Number.isInteger(v) && v >= 1) return [v, 0];
    const m = typeof v === 'string' ? /^([1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.exec(v) : null;
    return m ? [Number(m[1]), Number(m[2])] : null;
}

// the refusal of a manifest whose requires.api (read by readManifest) is newer than this server's, or null
function apiProblem(m) {
    const want = apiParts(m.requires?.api);
    const [major, minor] = apiParts(SERVER_EXT_API_VERSION);
    if (!want || want[0] < major || (want[0] === major && want[1] <= minor)) return null;
    return `needs extension api ${m.requires.api}, this server speaks ${SERVER_EXT_API_VERSION}`;
}
// what a manifest may declare under "contributes"; the client host carries the same list
const CONTRIBUTIONS = new Set(['chat.window', 'chat.action', 'message.action', 'character.action', 'app.action', 'character.card.badge', 'character.details.tab', 'character.bulk.action', 'shell.view', 'lore.entry.action', 'chat.card.action', 'composer.action']);

export function extensionsRoot() {
    return config.extensionsDir;
}

// extension-global scratch for both tiers: a dot folder beside the installs, never served and never an id
export function extensionDataDir(id) {
    return path.join(extensionsRoot(), '.data', id);
}

// An extension's own folder in one account's home, beside the account's other files
export function extensionUserDir(handle, id) {
    return path.join(userPaths(handle).root, 'ext', id);
}

// Bundled extensions ship with the app (extensions/bundled/), are read-only from the API,
// and run by default (extensionEnabledFor); extensions/installed/ holds admin installs.
export function bundledExtensionsRoot() {
    return path.join(config.projectRoot, 'extensions', 'bundled');
}

const idList = (v) => new Set(Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);

/** Whether an extension runs for db's account: a bundled one until switched off, any other once switched on. */
export function extensionEnabledFor(db, row) {
    if (row.bundled && !row.defaultOff) return !idList(settingValue(db, 'disabledExtensions', [])).has(row.id);
    return idList(settingValue(db, 'enabledExtensions', [])).has(row.id);
}

/** Switch an extension on or off for the account whose library db is, in the list its kind reads. */
export function setExtensionEnabledFor(db, row, on) {
    const optOut = row.bundled && !row.defaultOff;
    const key = optOut ? 'disabledExtensions' : 'enabledExtensions';
    const ids = idList(settingValue(db, key, []));
    const listed = optOut ? !on : !!on;
    if (ids.has(row.id) === listed) return;
    if (listed) ids.add(row.id); else ids.delete(row.id);
    patchSettings(db, { [key]: [...ids] });
    // the switch's own record, so another tab re-reads the row; the setting's names a list no client reads
    emitChange(db, { entity: 'extension', op: 'updated', ids: [row.id], fields: ['enabled'] });
}

/**
 * Drop a removed extension's id from both of db's switch lists, so a later install under it starts off.
 * @returns {boolean} whether either list held it
 */
export function forgetExtensionFor(db, id) {
    const patch = {};
    for (const key of ['enabledExtensions', 'disabledExtensions']) {
        const ids = idList(settingValue(db, key, []));
        if (ids.delete(id)) patch[key] = [...ids];
    }
    if (!Object.keys(patch).length) return false;
    patchSettings(db, patch);
    return true;
}

/** forgetExtensionFor in every account's library, a disabled account's and a closed library included. */
export function forgetExtensionEverywhere(id) {
    const onError = (handle, e) => console.error(`[extensions] could not forget ${id} for ${handle}:`, e);
    forEachAccountLibrary({ serverDb: config.multiUser ? openServerDb() : null, enabledOnly: false, onError }, ({ handle }) => forgetExtensionFor(openDb(handle), id));
}

/** Whether an account may still be served: always on a single-user install, else its row is there and enabled. */
export function accountLive(user) {
    if (!config.multiUser) return true;
    const row = getUser(openServerDb(), user);
    return !!row && !!row.enabled;
}

/** The account a door is used for (its library's owner); refused when none, gone, or without the extension on. */
export function doorAccount(row, db, verb) {
    const user = ownerOf(db);
    if (!user || user === SERVER_SCOPE) throw new Error(`${verb}: ${row.id} passed no account's library (use req.db, or the db a listener is handed)`);
    if (!accountLive(user)) throw new Error(`${verb}: the account ${user} is disabled or gone`);
    if (!extensionEnabledFor(db, row)) throw new Error(`${verb}: ${row.id} is not switched on for ${user}`);
    return user;
}

export function extensionDir(id, bundled) {
    return path.join(bundled ? bundledExtensionsRoot() : extensionsRoot(), id);
}

// a provider's link namespace: the one it declares, else its id (the divert and the collision check read the same answer)
const namespaceOf = (m, id) => (m.extNamespace == null ? id : m.extNamespace);

function readManifest(dir) {
    const file = path.join(dir, 'manifest.json');
    if (!fs.existsSync(file)) throw new Error('manifest.json is missing');
    let m;
    try { m = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { throw new Error(`manifest.json is not valid json: ${e.message}`); }
    if (!m || typeof m !== 'object') throw new Error('manifest.json must be an object');
    if (!EXT_ID_RE.test(String(m.id || ''))) throw new Error(`manifest id '${m.id}' is not a valid extension id`);
    if (!m.name || typeof m.name !== 'string') throw new Error('manifest needs a name');
    for (const key of ['client', 'server', 'style']) {
        if (m[key] === undefined) continue;
        const rel = String(m[key]);
        // entry paths stay inside the extension dir; an absolute or dotted path is refused
        if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`manifest ${key} path escapes the extension`);
        if (!fs.existsSync(path.join(dir, rel))) throw new Error(`manifest ${key} '${rel}' does not exist`);
    }
    // the namespace (its id by default) must pass the divert matcher, or link writes land in the card blob
    if (m.provider) {
        const ns = namespaceOf(m, m.id);
        if (typeof ns !== 'string' || !NS_RE.test(ns)) {
            throw new Error(`extNamespace '${ns}' is not a legal provider namespace: lowercase [a-z0-9_-], starting with a letter or digit, at most 32 chars`);
        }
        const taken = namespaceTaken(ns);
        if (taken) throw new Error(`extNamespace '${ns}' ${taken}; choose another (a registered namespace diverts writes for good)`);
    }
    // a whole number or a 'major.minor' string; anything looser would read as no version and mount anywhere
    if (m.requires !== undefined && m.requires !== null) {
        if (typeof m.requires !== 'object' || Array.isArray(m.requires)) throw new Error('manifest requires must be an object, its api the extension api it is written against');
        if (m.requires.api !== undefined && !apiParts(m.requires.api)) {
            throw new Error(`manifest requires.api must be a whole number from 1 or a 'major.minor' string such as '2.1' (the extension api it is written against), not ${JSON.stringify(m.requires.api)}`);
        }
    }
    // declared setting defaults, the one source both halves' scoped facades read; keys unprefixed here
    if (m.settings !== undefined) {
        if (!m.settings || typeof m.settings !== 'object' || Array.isArray(m.settings)) {
            throw new Error('manifest settings must be an object of default values');
        }
        for (const k of Object.keys(m.settings)) {
            if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(k)) throw new Error(`manifest settings key '${k}' is not a valid setting name`);
        }
    }
    // the manager's summary of what it adds; the code stays the truth (the host warns on an undeclared slot)
    if (m.contributes !== undefined) {
        if (!Array.isArray(m.contributes) || m.contributes.some(c => !CONTRIBUTIONS.has(c))) {
            throw new Error(`manifest contributes must be an array of ${[...CONTRIBUTIONS].join(', ')}`);
        }
    }
    checkLazy(m);
    return m;
}

// a lazy extension's declared entry points, held to the page registrars' grammar so a bad one is a broken row
const LAZY_ICON_RE = /^fa-[a-z0-9-]+$/;
const LAZY_ACTION_ROWS = { chat: 'chat.action', message: 'message.action', character: 'character.action', app: 'app.action', bulk: 'character.bulk.action', lore: 'lore.entry.action', chatCard: 'chat.card.action', composer: 'composer.action' };
const LAZY_KINDS = {
    actions: { keys: ['slot', 'id', 'label', 'icon'], label: 40, row: (e) => LAZY_ACTION_ROWS[e.slot] },
    windows: { keys: ['id', 'label', 'icon', 'size', 'min'], label: 40, row: () => 'chat.window' },
    views: { keys: ['id', 'label', 'icon'], label: 24, row: () => 'shell.view' },
};

function checkLazy(m) {
    if (m.lazy === undefined) return;
    if (!m.lazy || typeof m.lazy !== 'object' || Array.isArray(m.lazy)) throw new Error('manifest lazy must be an object of actions, windows and views');
    if (!m.client) throw new Error('manifest lazy needs a client entry, the code a first use loads');
    let count = 0;
    for (const [kind, list] of Object.entries(m.lazy)) {
        const rule = LAZY_KINDS[kind];
        const where = `manifest lazy.${kind}`;
        if (!rule) throw new Error(`${where} is not an entry point that can wait (actions, windows, views)`);
        if (!Array.isArray(list)) throw new Error(`${where} must be an array`);
        const seen = new Set();
        for (const e of list) {
            if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`${where} holds an entry that is not an object`);
            const extra = Object.keys(e).find(k => !rule.keys.includes(k));
            if (extra) throw new Error(`${where}: '${e.id}' has '${extra}', which a declaration does not take (${rule.keys.join(', ')})`);
            if (kind === 'actions' && !LAZY_ACTION_ROWS[e.slot]) throw new Error(`${where}: slot '${e.slot}' is not one of ${Object.keys(LAZY_ACTION_ROWS).join(', ')}`);
            assertSlugId(where, e.id);
            const label = typeof e.label === 'string' ? e.label.trim() : '';
            if (!label || label.length > rule.label) throw new Error(`${where}: '${e.id}' needs a label of at most ${rule.label} characters`);
            if (!LAZY_ICON_RE.test(String(e.icon ?? ''))) throw new Error(`${where}: '${e.id}' needs a Font Awesome solid icon like fa-puzzle-piece`);
            for (const g of ['size', 'min']) {
                if (e[g] !== undefined && !(e[g] && typeof e[g] === 'object' && Number.isFinite(e[g].w) && Number.isFinite(e[g].h))) {
                    throw new Error(`${where}: '${e.id}' ${g} must be { w, h } in percent of the conversation`);
                }
            }
            const key = kind === 'actions' ? `${e.slot}:${e.id}` : e.id;
            if (seen.has(key)) throw new Error(`${where}: '${e.id}' is declared twice`);
            seen.add(key);
            if (Array.isArray(m.contributes) && !m.contributes.includes(rule.row(e))) {
                throw new Error(`${where}: '${e.id}' is a ${rule.row(e)}, which the manifest's contributes does not name`);
            }
            count++;
        }
    }
    if (!count) throw new Error('manifest lazy declares no entry point, so its code would never load');
}

// an extension's portable data lives at card.data.extensions.<id>, so a non-provider id may not be a core key there
function coreExtensionKey(id) {
    return PROVIDER_NAMESPACES.includes(id) || OP_STATE_EXTENSIONS.includes(id) || IDENTITY_EXTENSIONS.includes(id)
        || CARD_FORMAT_EXTENSIONS.includes(id) || id === 'world' || id === 'depth_prompt';
}

// why a provider may not take a namespace, or null: the divert outlives the extension, so another's key loses its data
function namespaceTaken(ns) {
    if (FIRST_PARTY_NAMESPACES.includes(ns)) return 'is a built-in provider\'s namespace, whose links it would share';
    if (OP_STATE_EXTENSIONS.includes(ns) || IDENTITY_EXTENSIONS.includes(ns) || ns === 'world' || ns === 'depth_prompt') {
        return 'is a key the app owns in a card\'s data.extensions';
    }
    if (CARD_FORMAT_EXTENSIONS.includes(ns)) return 'is a key card tools write into data.extensions for their own data, which would become a link on every such card';
    return null;
}

// paths the extension routes answer themselves, which an extension of that id would sit under
const ROUTE_IDS = ['jobs', 'updates'];

// why an id cannot join `others`, or null; the inventory asks per row against the earlier rows, an install against all
function idProblem(id, m, others) {
    if (!m.provider && coreExtensionKey(id)) return `id '${id}' is a key the app owns in a card's data.extensions, where this extension's data would live; choose another id`;
    if (ROUTE_IDS.includes(id)) return `id '${id}' is a path the app's extension routes own (/api/extensions/${id}); choose another id`;
    const p = extTablePrefix(id);
    for (const o of others) {
        const q = extTablePrefix(o.id);
        if (p === q) continue;
        if (p.startsWith(q)) return `its table names (${p}...) would fall under those of '${o.id}' (${q}...); choose another id`;
        if (q.startsWith(p)) return `its table names (${p}...) would take in those of '${o.id}' (${q}...); choose another id`;
    }
    if (m.provider) {
        const ns = namespaceOf(m, id);
        const first = others.find(o => o.provider && o.extNamespace === ns);
        if (first) return `its extNamespace '${ns}' is '${first.id}'s already; choose another`;
    }
    return null;
}

/**
 * The extensions inventory; a broken one is a row with an error, so the admin sees why.
 * @returns {Array<object>} manifest rows plus { id, error? , git }
 */
/** Every extension id with a folder in either tree, broken or not, whatever the kill switch: the owners a library's x_ tables may have. */
export function presentExtensionIds() {
    const ids = new Set();
    for (const root of [bundledExtensionsRoot(), extensionsRoot()]) {
        if (!fs.existsSync(root)) continue;
        for (const e of fs.readdirSync(root, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) ids.add(e.name);
    }
    return [...ids].sort();
}

export function listExtensions() {
    if (!config.extensionsEnabled) return [];
    const out = [];
    const seen = new Set();
    for (const { root, bundled } of [
        { root: bundledExtensionsRoot(), bundled: true },
        { root: extensionsRoot(), bundled: false },
    ]) {
        if (!fs.existsSync(root)) continue;
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            // dot-dirs are the tree's own: in-flight .install-* clones and the .data scratch
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            const id = entry.name;
            const dir = path.join(root, id);
            const row = { id, bundled, git: !bundled && fs.existsSync(path.join(dir, '.git')) };
            try {
                // an install shadowing a bundled id would serve ambiguous code; refuse it
                if (seen.has(id)) throw new Error('shadows a bundled extension of the same id');
                const m = readManifest(dir);
                if (m.id !== id) throw new Error(`manifest id '${m.id}' does not match folder '${id}'`);
                const tooNew = apiProblem(m);
                if (tooNew) throw new Error(tooNew);
                Object.assign(row, {
                    name: m.name, version: m.version || null, author: m.author || null,
                    description: m.description || null, requires: m.requires || null,
                    client: m.client || null, style: m.style || null,
                    server: m.server || null, provider: !!m.provider,
                    // the provider_links divert namespace, validated above and defaulting
                    // to the id; informational only on a non-provider row
                    extNamespace: m.provider ? namespaceOf(m, id)
                        : (typeof m.extNamespace === 'string' ? m.extNamespace : null),
                    // a bundled extension may ship OFF (examples); only meaningful with bundled
                    defaultOff: !!m.defaultOff,
                    // declared setting defaults, read by both halves' scoped facades
                    settings: m.settings && typeof m.settings === 'object' ? m.settings : {},
                    // the declared contributions summary (validated above); null when undeclared,
                    // so the client host only checks declarations an author actually made
                    contributes: Array.isArray(m.contributes) ? m.contributes : null,
                    // the entry points a lazy extension declares (validated above): the page
                    // registers these and imports the code at their first use
                    lazy: m.lazy === undefined ? null : m.lazy,
                });
            } catch (e) {
                row.error = e.message;
            }
            seen.add(id);
            out.push(row);
        }
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    // table prefixes can nest (x_a_ and x_a_b_) and providers can share a namespace: the later row is refused
    const placed = [];
    for (const r of out) {
        if (r.error) continue;
        const problem = idProblem(r.id, r, placed);
        if (!problem) { placed.push(r); continue; }
        r.error = problem;
        if (ROUTE_IDS.includes(r.id)) {
            r.reserved = true;
            r.error += `; the app cannot remove it for you: delete its folder by hand (${path.join(r.bundled ? bundledExtensionsRoot() : extensionsRoot(), r.id)})`;
        }
    }
    return out;
}

/**
 * Resolve GET /ext/<id>/<rel> to a file the extension publishes: only the client and style entries' folders.
 * @param {string} id extension id from the url
 * @param {string|string[]} rel path below the id (decoded segments or a posix string)
 * @returns {{ root: string, rel: string } | null} sendFile args, or null for a 404
 */
export function resolveServedFile(id, rel) {
    const row = listExtensions().find(r => r.id === id && !r.error);
    if (!row) return null;
    // a decoded segment can carry a slash (..%2f), so re-split; segmentOk stops any disk spelling of another file
    const segments = (Array.isArray(rel) ? rel.join('/') : String(rel)).split('/');
    if (!segments.length || !segments.every(s => segmentOk(s) && !s.includes('\\'))) return null;
    const relPosix = segments.join('/');
    const norm = (p) => path.posix.normalize(p.split(/[\\/]/).join('/'));
    // never the manifest, package file or server half, even beside a root-level client; case-folded for Windows disks
    const key = relPosix.toLowerCase();
    if (key === 'manifest.json' || key === 'package.json') return null;
    if (row.server) {
        const serverEntry = norm(row.server).toLowerCase();
        const serverRoot = path.posix.dirname(serverEntry);
        if (key === serverEntry || (serverRoot !== '.' && key.startsWith(`${serverRoot}/`))) return null;
    }
    const roots = [row.client, row.style].filter(Boolean).map(p => path.posix.dirname(norm(p)).toLowerCase());
    if (!roots.some(root => root === '.' || key === root || key.startsWith(`${root}/`))) return null;
    return { root: extensionDir(row.id, row.bundled), rel: relPosix };
}

// the folder name the inventory listed, whatever its shape; a dot-led or separated segment names no row
function installedDir(id) {
    const name = String(id);
    const dir = path.join(extensionsRoot(), name);
    if (!name || name.startsWith('.') || path.basename(name) !== name || !fs.existsSync(dir)) {
        throw httpError(404, `no such extension: ${name}`);
    }
    return dir;
}

// a stage this old was cut off by a crash or a kill: a clone gives up long before, an archive unpacks in one call
const STALE_INSTALL_MS = 5 * GIT_TIMEOUT_MS;

// an install is staged in a dot folder beside the installs, so a bad one never occupies the tree
function stagingDir() {
    const root = extensionsRoot();
    fs.mkdirSync(root, { recursive: true });
    sweepInstallStages();
    return path.join(root, `.install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

/** The install stages a crash or a kill left behind, removed; the listing skips dot folders, so nothing else would ever see them. */
export function sweepInstallStages() {
    const root = extensionsRoot();
    if (!fs.existsSync(root)) return;
    const cutoff = Date.now() - STALE_INSTALL_MS;
    for (const name of fs.readdirSync(root)) {
        const at = /^\.install-(\d+)-/.exec(name);
        if (!at || Number(at[1]) >= cutoff) continue;
        try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); } catch { /* a locked file waits for the next sweep */ }
    }
}

// the one end of every install: the staged folder's manifest read, then moved into place under its id
function placeInstall(tmp) {
    const m = readManifest(tmp);
    const dest = path.join(extensionsRoot(), m.id);
    if (fs.existsSync(dest) || fs.existsSync(path.join(bundledExtensionsRoot(), m.id))) {
        throw httpError(409, `extension '${m.id}' is already installed`);
    }
    // the inventory's id and api rules, asked of the newcomer before it occupies the tree
    const problem = idProblem(m.id, m, listExtensions().filter(r => !r.error)) || apiProblem(m);
    if (problem) throw httpError(400, problem);
    fs.renameSync(tmp, dest);
    return { id: m.id };
}

/** Clone a git repo into a stage, check its manifest and place it under its own id. */
export async function installFromGit(url) {
    const u = String(url || '').trim();
    // https only: no ssh config exists server-side, and a scheme like ext:: or a bare
    // path would hand git a local-execution vector
    if (!/^https:\/\/[\w.-]+(?::\d+)?\/[\w./~%-]+$/.test(u)) {
        throw httpError(400, 'install url must be a plain https git url');
    }
    const tmp = stagingDir();
    try {
        await runGit(['clone', '--depth', '1', u, tmp]);
        return placeInstall(tmp);
    } catch (e) {
        fs.rmSync(tmp, { recursive: true, force: true });
        if (e.statusCode) throw e;
        throw httpError(400, `install failed: ${e.message}`);
    }
}

// what an archive may hold: its upload, its entries, one entry's bytes and all of them together
export const ZIP_INSTALL_LIMITS = Object.freeze({ upload: 100 * 1024 * 1024, entries: 10000, entry: 50 * 1024 * 1024, total: 200 * 1024 * 1024 });

// a name Windows reads as a device, whatever follows its dot
const DEVICE_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// one path step this server can hold on any disk, so a bad name is refused before a write fails
export const segmentOk = (s) => s !== '' && s !== '.' && s !== '..' && !/[<>:"|?*\x00-\x1f]/.test(s) && !/[. ]$/.test(s) && !DEVICE_RE.test(s);

// every entry an archive would write, under its root or its one wrapping folder; .git and __MACOSX are left out
function archivePlan(index) {
    if (index.length > ZIP_INSTALL_LIMITS.entries) throw httpError(400, `the archive holds ${index.length} entries; at most ${ZIP_INSTALL_LIMITS.entries} are taken`);
    const named = index.map(entry => ({ entry, name: entry.name.replace(/\\/g, '/') })).filter(n => n.name.split('/')[0] !== '__MACOSX');
    let prefix = '';
    if (!named.some(n => n.name === 'manifest.json')) {
        const first = named[0]?.name.split('/')[0];
        if (!first || !named.every(n => n.name.startsWith(`${first}/`)) || !named.some(n => n.name === `${first}/manifest.json`)) {
            throw httpError(400, 'the archive has no manifest.json at its root or inside its one folder');
        }
        if (!segmentOk(first)) throw httpError(400, `the archive's folder ${quoteName(first)} is not a name this server can hold`);
        prefix = `${first}/`;
    }
    const plan = [];
    const seen = new Set();
    let total = 0;
    for (const { entry, name } of named) {
        const rel = name.slice(prefix.length);
        if (!rel) continue;
        const dir = rel.endsWith('/');
        const segments = (dir ? rel.slice(0, -1) : rel).split('/');
        if (!segments.every(segmentOk)) throw httpError(400, `the archive's entry ${quoteName(entry.name)} names a path outside the extension's folder or one this server cannot hold`);
        if (segments[0].toLowerCase() === '.git') continue;
        const key = segments.join('/').toLowerCase();
        if (seen.has(key)) throw httpError(400, `the archive names ${quoteName(entry.name)} twice`);
        seen.add(key);
        if (dir) { plan.push({ segments, dir: true }); continue; }
        if (entry.method !== 0 && entry.method !== 8) throw httpError(400, `the archive's entry ${quoteName(entry.name)} is compressed in a way this server does not read`);
        if (entry.size > ZIP_INSTALL_LIMITS.entry || entry.compressedSize > ZIP_INSTALL_LIMITS.entry) throw httpError(400, `the archive's entry ${quoteName(entry.name)} is larger than ${ZIP_INSTALL_LIMITS.entry / 1048576} MB`);
        total += entry.size;
        if (total > ZIP_INSTALL_LIMITS.total) throw httpError(400, `the archive unpacks to more than ${ZIP_INSTALL_LIMITS.total / 1048576} MB`);
        plan.push({ segments, entry });
    }
    return plan;
}

/** Unpack an extension archive into a stage, every entry checked first and a turn apart, then place it. */
export async function installFromZip(zipPath) {
    let index;
    try { index = readZipIndex(zipPath); } catch (e) { throw httpError(400, `not a readable zip archive: ${e.message}`); }
    const plan = archivePlan(index);
    const tmp = stagingDir();
    try {
        await fs.promises.mkdir(tmp);
        for (const item of plan) {
            await nextTurn();
            const dest = path.join(tmp, ...item.segments);
            if (!dest.startsWith(tmp + path.sep)) throw httpError(400, `the archive's entry ${quoteName(item.segments.join('/'))} leaves the extension's folder`);
            if (item.dir) { await fs.promises.mkdir(dest, { recursive: true }); continue; }
            // bounded by the size it declares and checked against its crc, or a 400 naming it
            const bytes = await readZipEntryAsync(zipPath, item.entry);
            await fs.promises.mkdir(path.dirname(dest), { recursive: true });
            // wx: a name two entries reach (the case this disk ignores) is refused, never overwritten
            await fs.promises.writeFile(dest, bytes, { flag: 'wx' });
        }
        return placeInstall(tmp);
    } catch (e) {
        await fs.promises.rm(tmp, { recursive: true, force: true });
        if (e.statusCode) throw e;
        throw httpError(400, `install failed: ${e.message}`);
    }
}

// ========================================
// UPDATES
// ========================================

// the inventory's row for an install, so an update is held to the same checks a listing is
const installedRow = (id) => listExtensions().find(r => r.id === String(id) && !r.bundled) || null;

/**
 * Bring a git install to its repository's latest commit, whatever its history did; a version that would not load goes back.
 * @returns {Promise<{ id: string, updated: boolean, from: {commit: string, version: string|null}, to: {commit: string, version: string|null} }>}
 */
export async function updateExtension(id) {
    const dir = installedDir(id);
    if (!fs.existsSync(path.join(dir, '.git'))) {
        throw httpError(400, 'not a git install; update it by replacing the folder');
    }
    return withRepo(String(id), async () => {
        const was = installedRow(id);
        let before, after;
        try {
            const branch = await gitOut(['-C', dir, 'symbolic-ref', '--short', 'HEAD']);
            before = await gitOut(['-C', dir, 'rev-parse', 'HEAD']);
            await runGit(['-C', dir, 'fetch', '--depth', '1', 'origin', branch]);
            after = await gitOut(['-C', dir, 'rev-parse', 'FETCH_HEAD']);
            if (after !== before) await runGit(['-C', dir, 'reset', '--hard', 'FETCH_HEAD']);
        } catch (e) {
            throw httpError(400, `update failed: ${gitWords(e)}`);
        }
        const now = installedRow(id);
        // a row that loaded before and would not now keeps the code it had
        if (after !== before && !was?.error && now?.error) {
            try {
                await runGit(['-C', dir, 'reset', '--hard', before]);
            } catch (e) {
                throw httpError(400, `update failed: the new version would not load (${now.error}), and going back to ${before.slice(0, 7)} failed: ${gitWords(e)}`);
            }
            throw httpError(400, `update refused: the new version would not load (${now.error}); the extension stays as it was`);
        }
        const out = { id: String(id), updated: after !== before, from: { commit: before.slice(0, 7), version: was?.version || null }, to: { commit: after.slice(0, 7), version: now?.version || null } };
        noteUpdated(out);
        return out;
    });
}

// the last check: what each git install's repository holds beyond it (kept in memory, re-asked by an admin's tab)
const UPDATE_CHECK_PARALLEL = 4;
let _updates = { checkedAt: null, extensions: [] };
let _checking = null;

async function checkOne(row) {
    const dir = path.join(extensionsRoot(), row.id);
    const base = { id: row.id, name: row.name || row.id, version: row.version || null };
    try {
        return await withRepo(row.id, async () => {
            const branch = await gitOut(['-C', dir, 'symbolic-ref', '--short', 'HEAD']);
            const local = await gitOut(['-C', dir, 'rev-parse', 'HEAD']);
            const remote = (await gitOut(['-C', dir, 'ls-remote', 'origin', `refs/heads/${branch}`])).split(/\s+/)[0] || '';
            if (!remote) return { ...base, available: false, error: `the repository has no branch '${branch}' any more` };
            if (remote === local) return { ...base, available: false, commit: local.slice(0, 7) };
            // the tip itself, so the row can name the version coming; the update reuses what this fetched
            await runGit(['-C', dir, 'fetch', '--depth', '1', 'origin', branch]);
            let nextVersion = null;
            try { nextVersion = JSON.parse(await gitOut(['-C', dir, 'show', 'FETCH_HEAD:manifest.json'])).version || null; } catch { /* the update says what it finds */ }
            return { ...base, available: true, commit: local.slice(0, 7), nextCommit: remote.slice(0, 7), nextVersion };
        });
    } catch (e) {
        return { ...base, available: false, error: gitWords(e) };
    }
}

function noteUpdated(out) {
    _updates = { ..._updates, extensions: _updates.extensions.map(e => (e.id === out.id ? { id: e.id, name: e.name, version: out.to.version, available: false, commit: out.to.commit } : e)) };
}

/** The last check, as an admin's tab reads it; an install removed since drops out. */
export function extensionUpdates() {
    const present = new Set(listExtensions().filter(r => !r.bundled).map(r => r.id));
    return { checkedAt: _updates.checkedAt, checking: !!_checking, extensions: _updates.extensions.filter(e => present.has(e.id)).map(e => ({ ...e })) };
}

/**
 * Ask each git install's repository for its latest commit, never updating; a check younger than maxAge answers as is.
 * @param {{ maxAge?: number }} [opts] milliseconds
 */
export async function checkExtensionUpdates({ maxAge = 0 } = {}) {
    if (maxAge > 0 && _updates.checkedAt && Date.now() - _updates.checkedAt < maxAge) return extensionUpdates();
    if (!_checking) {
        _checking = (async () => {
            const rows = listExtensions().filter(r => r.git && !r.reserved);
            let out = [];
            for (let i = 0; i < rows.length; i += UPDATE_CHECK_PARALLEL) out = out.concat(await Promise.all(rows.slice(i, i + UPDATE_CHECK_PARALLEL).map(checkOne)));
            _updates = { checkedAt: Date.now(), extensions: out };
        })().finally(() => { _checking = null; });
    }
    await _checking;
    return extensionUpdates();
}

export function removeExtension(id) {
    const dir = installedDir(id);
    // a folder shadowing a bundled id was never mounted: only its own files go
    const shadowed = fs.existsSync(path.join(bundledExtensionsRoot(), String(id)));
    fs.rmSync(dir, { recursive: true, force: true });
    if (shadowed) return { id, shadowed };
    fs.rmSync(extensionDataDir(id), { recursive: true, force: true });
    // its folder in every account's home, a disabled account's too, so an install under the id later starts with none
    const leftover = [];
    for (const handle of accountHandles(config.multiUser ? openServerDb() : null)) {
        try { fs.rmSync(extensionUserDir(handle, id), { recursive: true, force: true }); }
        catch (e) { console.error(`[extensions] could not remove ${id}'s files for ${handle}:`, e); leftover.push(handle); }
    }
    // the removal stands; the accounts still holding its files are named so the admin can clear them
    return leftover.length ? { id, leftover } : { id };
}
