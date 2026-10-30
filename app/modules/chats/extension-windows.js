// The host for extension chat windows: each ctx.ui.addChatWindow spec gets the .cl-cwin shell and its own opener.

import CoreAPI from '../core-api.js';
import { getChatWindows, windowShows, windowsAsk, EXT_WINDOW_EVENT } from '../extension-host.js';
import { callOwner } from '../ext-registry.js';
import { registerFeedPatcher } from '../feed.js';
import { mountChatWindow, openChatWindow, closeChatWindow, registerChatWindow } from './window.js';

const esc = (s) => CoreAPI.escapeHtml(s);

// key -> { spec, panelId, buttonId, rendered, open, unmount, unregister }
const _entries = new Map();
let _context = () => ({ chatId: null, character: null });
// told after every sync: what draws from the doors' state besides the header (ie. Chat settings' Extensions group)
const _synced = new Set();

/** The setting that hides a window per form factor: its desktop header opener, its phone Windows tile. */
export const HIDE_SETTING = Object.freeze({ header: 'chatExtHiddenHeader', phone: 'chatExtHiddenPhone' });
const HIDE_KEYS = new Set(Object.values(HIDE_SETTING));

function hiddenSet(scope) {
    const v = CoreAPI.getSetting(HIDE_SETTING[scope]);
    return new Set(Array.isArray(v) ? v : []);
}

/** Whether a window is hidden in one scope; the settings window reads it per switch. */
export function isHidden(key, scope) {
    return hiddenSet(scope).has(key);
}

// read at every sync, so a viewport flip and a Chat settings toggle land on the next open
function currentScope() {
    return document.documentElement.classList.contains('cl-mobile') ? 'phone' : 'header';
}

/** The registered windows whose when() holds for the open conversation, in registration order; Chat settings lists these. */
export function liveSpecs() {
    const c = _context() || {};
    return getChatWindows().filter(s => windowShows(s, { chatId: c.chatId ?? null, character: c.character ?? null }));
}

/** The registered windows the current form factor shows, in registration order. */
export function shownSpecs() {
    const hidden = hiddenSet(currentScope());
    return liveSpecs().filter(s => !hidden.has(s.key));
}

const panelIdFor = (key) => `extWin-${key.replace(/[^a-z0-9-]/g, '-')}`;
const buttonIdFor = (key) => `extBtn-${key.replace(/[^a-z0-9-]/g, '-')}`;

/** The shell an extension window gets; the body is the extension's. */
export function windowShellHtml(spec, panelId) {
    // the extension's name beside the window's, unless the window is named for it
    const meta = String(spec.extName || '').trim().toLowerCase() === String(spec.label || '').trim().toLowerCase()
        ? '' : `<span class="cl-cwin-sep"></span>
                    <span class="cl-cwin-meta">${esc(spec.extName)}</span>`;
    return `
    <div class="cl-cwin cxw-panel" id="${panelId}" data-ext-window="${esc(spec.key)}" aria-hidden="true">
        <aside class="cl-cwin-sheet cxw-sheet" role="dialog" aria-label="${esc(spec.label)}">
            ${CoreAPI.windowGripsHtml(`the ${esc(spec.label)} window`)}
            <div class="cl-cwin-header">
                <div class="cl-cwin-title">
                    <i class="fa-solid ${esc(spec.icon)}"></i>
                    <span class="cl-cwin-name">${esc(spec.label)}</span>
                    ${meta}
                </div>
                <div class="cl-cwin-controls">
                    <button type="button" class="cl-cwin-btn is-close" data-cxw-act="close" title="Close (Esc)" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="cl-cwin-body cxw-body"></div>
        </aside>
    </div>`;
}

function headerRight() { return document.querySelector('#chatConvHeader .chat-conv-header-right'); }
function panelHost() { return document.getElementById('chatsConversation'); }

function ensureWindow(spec) {
    if (_entries.has(spec.key)) return _entries.get(spec.key);
    const host = panelHost();
    const right = headerRight();
    if (!host || !right) return null;
    const entry = { spec, panelId: panelIdFor(spec.key), buttonId: buttonIdFor(spec.key), rendered: false, open: false };
    host.insertAdjacentHTML('beforeend', windowShellHtml(spec, entry.panelId));
    const panel = document.getElementById(entry.panelId);
    const sheet = panel.querySelector('.cxw-sheet');
    entry.unmount = mountChatWindow(sheet, { geometry: spec.geometry, close: () => closeWindow(spec.key), min: spec.min });
    panel.addEventListener('click', (e) => { if (e.target.closest('[data-cxw-act="close"]')) closeWindow(spec.key); });
    entry.unregister = registerChatWindow(entry.panelId, {
        close: () => closeWindow(spec.key),
        follow: (detail) => { if (entry.rendered && typeof spec.follow === 'function') guard(spec, 'follow', () => spec.follow(detail, windowContext(entry))); },
    });
    // openers after the first-party cluster behind one separator, in registration order, all ahead of More
    const more = right.querySelector('.chat-conv-more');
    const place = (html) => (more ? more.insertAdjacentHTML('beforebegin', html) : right.insertAdjacentHTML('beforeend', html));
    if (!right.querySelector('.cxw-sep')) place('<span class="cxw-sep" aria-hidden="true"></span>');
    place(`<button type="button" id="${entry.buttonId}" class="cxw-open-btn" data-ext-window="${esc(spec.key)}" title="${esc(spec.label)}" aria-label="${esc(spec.label)}"><i class="fa-solid ${esc(spec.icon)}"></i></button>`);
    _entries.set(spec.key, entry);
    return entry;
}

function windowContext(entry) {
    const c = _context() || {};
    // the window's own close, as its X closes it; a context kept past a close or a switch-off closes nothing
    const close = () => { if (_entries.get(entry.spec.key) === entry && entry.open) closeWindow(entry.spec.key); };
    return { chatId: c.chatId ?? null, character: c.character ?? null, panel: document.getElementById(entry.panelId), body: document.querySelector(`#${entry.panelId} .cxw-body`), close };
}

// one broken window never takes the conversation down: its error lands in its own body and the console
function guard(spec, what, fn) {
    return callOwner(spec.extId, `window ${spec.id} ${what}`, fn, () => {
        const body = document.querySelector(`#${panelIdFor(spec.key)} .cxw-body`);
        if (body) body.innerHTML = `<div class="cxw-error"><i class="fa-solid fa-triangle-exclamation"></i> This window failed to render; see the console.</div>`;
    });
}

// an extension switched off: closed first so its onClose runs, then everything it registered leaves
function removeWindow(key) {
    const entry = _entries.get(key);
    if (!entry) return;
    if (entry.open) closeWindow(key);
    entry.unregister?.();
    entry.unmount?.();
    document.getElementById(entry.panelId)?.remove();
    document.getElementById(entry.buttonId)?.remove();
    _entries.delete(key);
}

// every SHOWN window keeps its opener, however many; what the header cannot fit waits behind More (fitRow)
function syncHeader() {
    const shownKeys = new Set(shownSpecs().map(s => s.key));
    for (const entry of _entries.values()) document.getElementById(entry.buttonId)?.classList.toggle('hidden', !shownKeys.has(entry.spec.key));
    document.querySelector('.cxw-sep')?.classList.toggle('hidden', ![..._entries.keys()].some(k => shownKeys.has(k)));
    CoreAPI.refitRow(headerRight());
}

/** Build every registered window not built yet and remove every built one the registry dropped; safe to call repeatedly. */
export function syncWindows() {
    if (!panelHost() || !headerRight()) return;
    const specs = getChatWindows();
    const registered = new Set(specs.map(s => s.key));
    for (const key of [..._entries.keys()]) if (!registered.has(key)) removeWindow(key);
    for (const spec of specs) ensureWindow(spec);
    // an open window whose when() now says no closes (its onClose runs); built, it waits for a yes
    const live = new Set(liveSpecs().map(s => s.key));
    for (const [key, entry] of _entries) if (entry.open && !live.has(key)) closeWindow(key);
    syncHeader();
    for (const fn of _synced) fn();
}

/**
 * Hear every sync of the doors: a window registered or gone, a when() asked again, a Header or Phone list written.
 * @returns {Function} the unsubscribe
 */
export function onDoorsSynced(fn) {
    _synced.add(fn);
    return () => _synced.delete(fn);
}

// another tab's Header or Phone list, or an extension's setting a when() reads, after the shell adopted it
function patchDoorsFromFeed(records) {
    const asks = windowsAsk();
    if (records && !records.some(r => r.all || (r.ids || []).some(k => HIDE_KEYS.has(k) || (asks && String(k).startsWith('ext:'))))) return;
    syncWindows();
}

export function openWindow(key) {
    const entry = _entries.get(key);
    const panel = entry && document.getElementById(entry.panelId);
    if (!panel) return;
    // is-panel-open lights the opener, and More while the opener waits behind it
    openChatWindow(panel, { button: entry.buttonId });
    entry.open = true;
    const ctx = windowContext(entry);
    if (!entry.rendered) {
        entry.rendered = true;
        guard(entry.spec, 'render', () => entry.spec.render(ctx.body, ctx));
    }
    if (typeof entry.spec.onOpen === 'function') guard(entry.spec, 'onOpen', () => entry.spec.onOpen(ctx));
}

export function closeWindow(key) {
    const entry = _entries.get(key);
    const panel = entry && document.getElementById(entry.panelId);
    if (!entry) return;
    closeChatWindow(panel, { button: entry.buttonId });
    entry.open = false;
    if (typeof entry.spec.onClose === 'function') guard(entry.spec, 'onClose', () => entry.spec.onClose(windowContext(entry)));
}

export function toggleWindow(key) {
    const entry = _entries.get(key);
    if (!entry) return;
    if (entry.open) closeWindow(key); else openWindow(key);
}

/**
 * The doors this form factor shows, in registration order: each shown window's opener, which its phone tile clicks.
 * @returns {{ buttonId: string, icon: string, label: string }[]}
 */
export function doors() {
    return shownSpecs().map(s => _entries.get(s.key)).filter(Boolean).map(e => ({ buttonId: e.buttonId, icon: e.spec.icon, label: e.spec.label }));
}

/**
 * @param {{ context: () => { chatId: string|null, character: object|null } }} opts the
 *   conversation's live state, read at every open and follow rather than copied
 */
export function init({ context } = {}) {
    if (typeof context === 'function') _context = context;
    // the header cluster delegates: an opener toggles its window, pressed in the header, from More or by a phone tile
    headerRight()?.addEventListener('click', (e) => {
        const opener = e.target.closest('[data-ext-window]');
        if (opener) toggleWindow(opener.dataset.extWindow);
    });
    registerFeedPatcher('setting', patchDoorsFromFeed);
    document.addEventListener(EXT_WINDOW_EVENT, () => syncWindows());
    // a when() is handed the conversation: asked again as one opens, its character lands, or it closes
    document.addEventListener('cl-chat-changed', () => { if (windowsAsk()) syncWindows(); });
    syncWindows();
}

export default { init, syncWindows, onDoorsSynced, openWindow, closeWindow, toggleWindow, doors, liveSpecs, shownSpecs, isHidden, windowShellHtml, HIDE_SETTING };
