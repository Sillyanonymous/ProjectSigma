// SPDX-License-Identifier: 0BSD

// The client extension host as it ships, run in node against the real registry; the shell and the
// provider registrar are recording stubs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Lift a declaration from its opening line to the first lone closing brace, a CRLF source read as LF; throws when either is missing.
 * @param {string} src
 * @param {string} marker the declaration's opening line, or its start
 * @param {string} [label] what the error names; the marker by default
 */
export function sliceDeclaration(src, marker, label = marker) {
    const lf = (s) => (s.includes('\r') ? s.replace(/\r\n/g, '\n') : s);
    const text = lf(src);
    const s = text.indexOf(lf(marker));
    if (s < 0) throw new Error(`marker missing: ${label}`);
    const e = text.indexOf('\n}\n', s);
    if (e < 0) throw new Error(`end missing: ${label}`);
    return text.slice(s, e + 3);
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.apiRequest] the apiRequest the host's CoreAPI answers with (a real
 *   server's); by default one that answers every call with the inventory setInventory set
 */
let hostCount = 0;
export async function buildHost({ apiRequest = null } = {}) {
    const host = fs.readFileSync(path.join(repo, 'app/modules/extension-host.js'), 'utf8').replace(/\r\n/g, '\n');
    const R = await import(pathToFileURL(path.join(repo, 'app/modules/ext-registry.js')).href);
    const marker = 'export { guardExtensionCall };';
    const headEnd = host.indexOf(marker);
    if (headEnd === -1) throw new Error('the host import block moved: re-anchor buildHost in tools/extension-kit/host.mjs');
    const body = host.slice(headEnd + marker.length)
        .replace(/^export (const|function|async function) /gm, '$1 ')
        .replace(/await import\(/g, 'await __import(');
    const imported = (host.slice(0, headEnd).match(/\{([^}]*)\} from '\.\/ext-registry\.js'/) || [])[1];
    if (!imported) throw new Error('the host no longer imports the registry by name: re-anchor buildHost in tools/extension-kit/host.mjs');
    const keyNames = (host.slice(0, headEnd).match(/\{([^}]*)\} from '\.\/keymap\.js'/) || [])[1];
    if (!keyNames) throw new Error('the host no longer imports the keymap by name: re-anchor buildHost in tools/extension-kit/host.mjs');
    // a keymap of the host's own (a fresh module), its settings the stub's, so no two hosts share an extension's keys
    const K = await import(`${pathToFileURL(path.join(repo, 'app/modules/keymap.js')).href}?host=${++hostCount}`);
    if (!/^import CoreAPI, \{ hostBridge \} from '\.\/core-api\.js';$/m.test(host.slice(0, headEnd))) throw new Error('the host no longer imports CoreAPI and hostBridge: re-anchor buildHost in tools/extension-kit/host.mjs');
    const names = [...new Set(imported.split(',').map(s => s.trim()).filter(Boolean))];
    const exported = [...host.matchAll(/^export (?:async )?(?:function|const) ([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);

    const doc = new EventTarget();
    const domListeners = new Map(); // type -> live count, to see relays install and leave
    const add = doc.addEventListener.bind(doc), remove = doc.removeEventListener.bind(doc);
    doc.addEventListener = (t, fn, o) => { domListeners.set(t, (domListeners.get(t) || 0) + 1); add(t, fn, o); };
    doc.removeEventListener = (t, fn, o) => { domListeners.set(t, (domListeners.get(t) || 0) - 1); remove(t, fn, o); };
    doc.links = [];
    // the elements a test puts on the page by id (an extension's open overlay)
    doc.elements = new Map();
    doc.getElementById = (id) => doc.elements.get(id) || null;
    doc.querySelector = (sel) => {
        const m = /link\[data-ext-style="([^"]+)"\]/.exec(sel);
        return m ? doc.links.find(l => l.dataset.extStyle === m[1] && !l.removed) || null : null;
    };
    const announced = [];
    // what the host announces is what it declares (EXT_*_EVENT), so a new announcement is recorded with no list to extend
    const announcements = [...host.matchAll(/^(?:export )?const EXT_\w+_EVENT = '([^']+)';/gm)].map(m => m[1]);
    if (!announcements.length) throw new Error('the host declares no EXT_*_EVENT announcements: re-anchor buildHost in tools/extension-kit/host.mjs');
    for (const t of announcements) add(t, (e) => announced.push([t, e.detail]));

    const log = { appRender: 0, injected: [], removedSections: [], toasts: [], opened: [], providersIn: [], providersOut: [], imports: [], overlays: [] };
    // the shell's answer reader, as it ships: the host reads its own doors' answers through it
    const lib = fs.readFileSync(path.join(repo, 'app/library.js'), 'utf8').replace(/\r\n/g, '\n');
    let answer;
    try { answer = sliceDeclaration(lib, 'async function readAnswer(resp) {'); } catch (e) { throw new Error(`buildHost: app/library.js: ${e.message}`); }
    const readAnswer = new Function(`${answer}; return readAnswer;`)();
    const settings = {};
    K.configure({ getSetting: (k) => settings[k], setSetting: (k, v) => { settings[k] = v; } });
    let inventory = { enabled: true, extensions: [] };
    const CoreAPI = {
        serverUrl: (u) => u, debugLog: () => {},
        getSetting: (k) => settings[k], setSetting: (k, v) => { settings[k] = v; },
        settingsReady: async () => {},
        apiRequest: apiRequest || (async () => ({ ok: true, json: async () => inventory })),
        storeRead: async () => null, storeWrite: async () => {}, readAnswer,
        openChatById: async (id, o) => { log.opened.push([id, o]); return true; },
        showToast: (m, t) => log.toasts.push([m, t]),
    };
    // the shell's plumbing the host runs on, which core-api keeps off the facade
    const hostBridge = {
        renderExtensionAppActions: () => { log.appRender++; },
        injectProviderSettingsSection: (pid, render) => { log.injected.push(pid); render({}); return true; },
        removeProviderSettingsSection: (pid) => { log.removedSections.push(pid); return true; },
        registerOverlay: (cfg) => { log.overlays.push(['register', cfg]); },
        unregisterOverlay: (id) => { log.overlays.push(['unregister', id]); },
    };
    const modules = new Map();
    // a URL the test cannot know ahead (a reload's generation) is answered by the resolver
    let resolveModule = null;
    const __import = async (url) => {
        log.imports.push(url);
        if (modules.has(url)) return modules.get(url);
        const mod = resolveModule?.(url);
        if (mod) return mod;
        throw new Error(`no module at ${url}`);
    };
    const loadModuleCSS = async (url) => { const link = { href: url, dataset: {}, removed: false, remove() { this.removed = true; } }; doc.links.push(link); return link; };
    const api = new Function('R', 'K', 'CoreAPI', 'hostBridge', 'ProviderRegistry', 'registerExtensionProvider', 'unregisterExtensionProvider', 'PROVIDER_MANIFEST',
        'document', 'CustomEvent', 'CSS', '__import', `
        const { ${names.join(', ')} } = R;
        const { ${keyNames} } = K;
        ${body}
        return { ${exported.join(', ')}, __inventory: () => _inventory };`)(
        R, K, CoreAPI, hostBridge, { getProvider: () => null },
        async (p) => { log.providersIn.push(p.id); }, (pid) => { log.providersOut.push(pid); return true; }, {},
        doc, CustomEvent, { escape: (s) => s }, __import);
    return {
        // CoreAPI is the stub the host hands every ctx: a test adds the members its extension reads
        R, K, api, doc, domListeners, announced, log, settings, modules, loadModuleCSS, CoreAPI,
        setInventory: (inv) => { inventory = inv; },
        setModuleResolver: (fn) => { resolveModule = fn; },
        load: (id) => api.loadNow(id, loadModuleCSS),
    };
}
