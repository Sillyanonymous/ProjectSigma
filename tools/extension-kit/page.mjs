// SPDX-License-Identifier: 0BSD

// An extension's page in node: the shipped host over one session and one shared document; what the
// kit cannot run is logged (page.log).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { buildHost, repo, sliceDeclaration } from './host.mjs';
import { createElement, mountPoint, cssEscape } from './mini-dom.mjs';

export { sliceDeclaration };

// a declaration lifted out of the page's own script by its opening line and run as it ships
function pageVerb(src, marker, deps = {}) {
    let decl;
    try { decl = sliceDeclaration(src, marker); } catch (e) { throw new Error(`page: app/library.js: ${e.message}`); }
    const name = /function (\w+)/.exec(marker)[1];
    return new Function(...Object.keys(deps), `${decl}; return ${name};`)(...Object.values(deps));
}

// an extension imports the core by absolute /modules/ paths; in node they resolve against the app's folder
let modulesResolved = false;
export function resolveCoreModules() {
    if (modulesResolved) return;
    modulesResolved = true;
    registerHooks({ resolve: (specifier, context, next) => next(specifier.startsWith('/modules/') ? pathToFileURL(path.join(repo, 'app', specifier)).href : specifier, context) });
}

let open = null;
// the open page's log: the stand-in commands live in the process's registry, so their log follows the page
let currentLog = null;

/**
 * Open the page for one session; one page a process, since the registry is the process's as it is a tab's.
 * @param {object} session { apiRequest, base, dataDir, cookie, clientId, attachFeed }
 */
export async function openPage(session) {
    if (open) throw new Error('page: one page a process (the registry is the tab\'s); close the other first');
    // claimed before the first await, so a second page() in flight is refused as an open one is
    open = 'opening';
    const saved = { document: globalThis.document, raf: globalThis.requestAnimationFrame, window: globalThis.window };
    try {
        open = await buildPage(session, saved);
        return open;
    } catch (e) {
        // an open that failed part way gives the process its globals back, as close() does
        globalThis.document = saved.document;
        globalThis.window = saved.window;
        globalThis.requestAnimationFrame = saved.raf;
        currentLog = null;
        open = null;
        throw e;
    }
}

// the page itself; saved holds the globals it replaces, which close() gives back
async function buildPage({ apiRequest, base, dataDir, cookie = null, clientId = null, attachFeed }, saved) {
    resolveCoreModules();
    const H = await buildHost({ apiRequest });
    // the feed's events (character.updated and its kin) are defined by the module that relays them
    const feed = await import(pathToFileURL(path.join(repo, 'app/modules/feed.js')).href);
    const { COMMAND_TYPES } = await import(pathToFileURL(path.join(repo, 'app/modules/ext-contract.js')).href);

    // ---- one document: the host's events and the extension's elements
    const doc = H.doc;
    doc.body = createElement('body');
    // the root a script reaches for a class on the whole page (a mode, a theme), holding the body
    doc.documentElement = createElement('html');
    doc.documentElement.appendChild(doc.body);
    doc.createElement = createElement;
    doc.activeElement = null;
    const hostById = doc.getElementById;
    doc.getElementById = (id) => hostById(id) || doc.body.querySelector(`#${id}`);
    const hostQuery = doc.querySelector;
    doc.querySelector = (sel) => (/^link\[data-ext-style=/.test(sel) ? hostQuery(sel) : doc.body.querySelector(sel));
    doc.querySelectorAll = (sel) => doc.body.querySelectorAll(sel);
    globalThis.document = doc;
    globalThis.requestAnimationFrame = saved.raf || ((fn) => setTimeout(fn, 0));

    // ---- the shell's answers
    const lib = fs.readFileSync(path.join(repo, 'app/library.js'), 'utf8').replace(/\r\n/g, '\n');
    const C = H.CoreAPI;
    C.escapeHtml = pageVerb(lib, 'function escapeHtml(text) {');
    C.formatNumber = pageVerb(lib, 'function formatNumber(num) {');
    C.storeRead = pageVerb(lib, 'async function storeRead(key) {', { apiRequest });
    C.storeWrite = pageVerb(lib, 'async function storeWrite(key, doc) {', { apiRequest });
    // a whole list walked page by page, as the page walks it
    C.fetchAllPages = pageVerb(lib, "async function fetchAllPages(path, params = {}, { pageSize = 1000, key = 'items' } = {}) {", {
        apiRequest, readAnswer: C.readAnswer, characterQuery: pageVerb(lib, 'function characterQuery(params = {}, search = new URLSearchParams()) {'),
    });
    // the account's connections, as a connection picker reads them
    C.getLlmSettings = pageVerb(lib, 'async function getLlmSettings() {', { apiRequest });
    // the notifications menu: its bell and dropdown in the document, the shell's verbs over the page's own section list
    const menu = createElement('div');
    menu.className = 'notifications-container hidden';
    menu.innerHTML = '<button id="notificationsBtn" title="Notifications"><i class="fa-solid fa-bell"></i><span class="warning-badge hidden"></span></button>'
        + '<div id="notificationsDropdown" class="hidden"><div class="notif-empty" hidden></div></div>';
    doc.body.appendChild(menu);
    const sections = new Map();
    const getNotificationSectionEl = pageVerb(lib, 'function getNotificationSectionEl(id) {', { document: doc, CSS: { escape: cssEscape } });
    const openNotificationsDropdown = pageVerb(lib, 'function openNotificationsDropdown() {', { document: doc, _notifSections: sections, getNotificationSectionEl });
    C.refreshNotificationsUI = pageVerb(lib, 'function refreshNotificationsUI() {', { document: doc, _notifSections: sections, openNotificationsDropdown });
    const menuVerbs = { document: doc, _notifSections: sections, getNotificationSectionEl, refreshNotificationsUI: C.refreshNotificationsUI };
    C.registerNotificationSection = pageVerb(lib, 'function registerNotificationSection(cfg) {', menuVerbs);
    C.removeNotificationSection = pageVerb(lib, 'function removeNotificationSection(id, cfg) {', menuVerbs);
    // the bell's own wiring, run once as the shell runs it: the shell listens on the document, here the root a click bubbles to
    const dropdownIds = /^const TOPBAR_DROPDOWN_IDS = (\[[^\]\n]*\]);$/m.exec(lib);
    if (!dropdownIds) throw new Error('page: app/library.js: marker missing: const TOPBAR_DROPDOWN_IDS');
    const closeAllTopbarDropdowns = pageVerb(lib, 'function closeAllTopbarDropdowns(exceptId) {', { TOPBAR_DROPDOWN_IDS: new Function(`return ${dropdownIds[1]};`)(), document: doc, window: {} });
    const rootListened = { getElementById: (id) => doc.getElementById(id), addEventListener: (type, fn, opts) => doc.documentElement.addEventListener(type, fn, opts) };
    pageVerb(lib, 'function setupNotificationsCenter() {', { document: rootListened, closeAllTopbarDropdowns, openNotificationsDropdown })();
    // the account's settings as the server holds them; a change goes out as one PATCH a key
    Object.assign(H.settings, await (await apiRequest('/settings', 'GET')).json());
    const writes = [];
    C.setSetting = (key, value) => { H.settings[key] = value; writes.push(apiRequest('/settings', 'PATCH', { [key]: value })); };
    const answers = { confirm: true, mobile: false };
    H.log.confirms = [];
    C.showConfirm = async (opts) => { H.log.confirms.push(opts); return answers.confirm; };
    C.isMobileMode = () => answers.mobile;
    C.initCustomSelect = () => {};
    // a dialog's resize from its edges is a drag over a layout the kit has none of
    C.mountDialogSizing = () => {};
    // the window core modules read the shell through: the declared provider manifest, else the extension's shell
    const declared = {};
    new Function('window', fs.readFileSync(path.join(repo, 'app/provider-manifest.js'), 'utf8'))(declared);
    globalThis.window = new Proxy({ PROVIDER_MANIFEST: declared.PROVIDER_MANIFEST, document: doc }, { get: (own, key) => (key in own ? own[key] : C[key]) });
    // the shell's own commands are defined before any extension loads, as on the page, so one that
    // runs or wraps them at init finds them
    H.log.commands = [];
    currentLog = H.log;
    // chat.open records like the rest and reaches the opener as on the page (module-loader's
    // definition), so ctx.chats.open, which runs it, lands in log.opened
    if (!H.R.hasCommand('chat.open')) {
        H.R.defineCommand('chat.open', (args = {}) => { currentLog?.commands.push(['chat.open', args]); return C.openChatById(args.chatId, { seq: args.seq }); }, { title: 'Open a chat (stands in)' });
    }
    for (const id of Object.keys(COMMAND_TYPES)) {
        if (!H.R.hasCommand(id)) H.R.defineCommand(id, (args) => { currentLog?.commands.push([id, args]); return undefined; }, { title: `${id} (stands in)` });
    }
    // an extension's files: its installed folder, else the one bundled with the app
    H.setModuleResolver((url) => {
        const m = /^\/ext\/([a-z0-9][a-z0-9-]*)(?:@[^/]+)?\/(.+)$/.exec(String(url));
        if (!m) return null;
        const file = [path.join(dataDir, 'extensions', m[1], m[2]), path.join(repo, 'extensions', 'bundled', m[1], m[2])].find(f => fs.existsSync(f));
        return file ? import(pathToFileURL(file).href) : null;
    });

    let listening = false;
    const page = {
        /** the host's reads and verbs: actions, badges, tabs, views, windows, sections, the switch */
        host: H.api,
        /** the registry the extension joined: commands, events, hooks */
        registry: H.R,
        /** the shell the extension is handed; replace a member a test needs */
        CoreAPI: C,
        /** what the shell was asked: toasts, opened chats, overlays, confirms, the shell's commands */
        log: H.log,
        /** what the stand-ins answer: a confirm, whether the page is a phone's */
        answers,
        settings: H.settings,
        document: doc,
        dom: { createElement, mountPoint },
        /** Load what the account has on, as the page's boot does. */
        boot: () => H.api.loadExtensions(H.loadModuleCSS),
        /** Switch an extension on or off as its manager row does: the server, then this page. */
        enable: (id, on = true) => H.api.setExtensionEnabled(id, on, H.loadModuleCSS),
        /** Open the notifications menu as a tap on its bell does: each section showing paints into its node. */
        openNotifications: () => openNotificationsDropdown(),
        /** The settings writes still on their way. */
        settled: () => Promise.all(writes.splice(0)),
        /** Hear the account's changes as the page does, over the feed. */
        listen: async () => {
            attachFeed();
            const { WebSocket } = await import('ws');
            const Socket = class extends WebSocket { constructor(url) { super(url, cookie ? { headers: { Cookie: cookie } } : {}); } };
            feed.startFeed({ url: `${base.replace(/^http/, 'ws')}/api/feed`, clientId: clientId || 'kit-page-tab', WebSocket: Socket });
            listening = true;
            for (let i = 0; i < 250 && !feed.feedConnected(); i++) await new Promise(r => setTimeout(r, 20));
            if (!feed.feedConnected()) throw new Error('page.listen: the feed did not connect');
        },
        /** Unload every extension, stop the feed and give the process its document back. */
        close: () => {
            if (listening) feed.stopFeed();
            for (const row of H.api.__inventory()?.extensions || []) H.api.unloadExtension(row.id);
            globalThis.document = saved.document;
            globalThis.window = saved.window;
            globalThis.requestAnimationFrame = saved.raf;
            currentLog = null;
            open = null;
        },
    };
    return page;
}
