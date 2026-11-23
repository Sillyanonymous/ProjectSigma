// The client extension host: loads enabled extensions last, each with a ctx. Trusted code, no
// sandbox; the ledger lets a switch-off skip the reload.
import CoreAPI, { hostBridge } from './core-api.js';
import ProviderRegistry, { registerExtensionProvider, unregisterExtensionProvider, PROVIDER_MANIFEST } from './providers/provider-registry.js';
import {
    guardExtensionCall, callOwner, recordOwnerCall, trackRegistration, disposeOwner, ownerRegistrations, ownerStats,
    defineSlot, getSlot, listSlots, defineEvent, getEvent, listEvents, onEvent, emitEvent, watchListeners,
    defineCommand, runCommand, listCommands, wrapCommand, commandConflicts,
    defineHook, addHook, listHooks,
} from './ext-registry.js';
import { defineKey } from './keymap.js';
import { browserFetch } from './providers/provider-utils.js';

// re-exported on a line of its own: the kit's host splits this file on it
export { guardExtensionCall };

// '<major>.<minor>', the server's SERVER_EXT_API_VERSION: the minor moves with each batch of new doors
export const EXT_API_VERSION = '2.9';

// id -> { manifest, state: 'loaded'|'failed', error?, module?, styleLink? }
const _status = new Map();
// id -> the generation its files are fetched under since a reload (none before one)
const _generation = new Map();
// a lazy extension's stand-in specs, replaced in place when its code registers the key;
// placeholders: owner -> [{ key, release, drop }]
const _declaredSpecs = new WeakSet();
const _placeholders = new Map();
// id -> a first use's loading, which a later load of the same id waits for rather than races
const _inflight = new Map();
// id -> its dispose() still settling; the next load waits it out, or that undo could take the new load's
const _disposing = new Map();
const DISPOSE_WAIT_MS = 5000;
// the page's sheet loader, kept for a lazy extension's first use (its code and sheet load then)
let _loadModuleCSS = null;
// id -> render(el) callbacks contributed via ctx.ui.addSettingsSection
const _settingsSections = new Map();
// providerId -> { render, opts, injected } via ctx.ui.addProviderSettingsSection; the registrar and
// setupSettingsModal both drain it, so neither boot order strands one
const _providerSections = new Map();
// "<extId>/<windowId>" -> spec via ctx.ui.addChatWindow; the chats module builds the window from
// these, the host only validates, stores and announces
const _chatWindows = new Map();
// Reset window layouts reaches extension windows too: their keys are the host's writes, not first-party ones
document.addEventListener('cl-window-geometry-reset', () => {
    for (const entry of _chatWindows.values()) entry.geometry.reset();
    for (const el of document.querySelectorAll('.fw-window')) el._fwReapply?.();
});
export const EXT_WINDOW_EVENT = 'cl-ext-chat-windows-changed';
const WINDOW_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
// "<extId>/<overlayId>" -> overlay via ctx.ui.addOverlay; its tier closes it before a conversation's
// windows (0.5), after a confirm (-1) or picker (0)
const _overlays = new Map();
const OVERLAY_TIER = 0.25;
const ICON_RE = /^fa-[a-z0-9-]+$/;
// slot -> Map<key, spec> via ctx.ui.addAction; desktop and phone both build from it at open time
export const ACTION_SLOTS = Object.freeze(['chat', 'message', 'character', 'app', 'bulk', 'lore', 'chatCard', 'composer']);
const _actions = new Map(ACTION_SLOTS.map(s => [s, new Map()]));
export const EXT_ACTION_EVENT = 'cl-ext-actions-changed';
// "<extId>/<id>" -> { render(row) } contributed to character.card.badge, in registration order
const _badges = new Map();
const EXT_BADGE_EVENT = 'cl-ext-badges-changed';
const BADGE_TONES = Object.freeze(['neutral', 'accent', 'success', 'warning', 'danger']);
// a grid card is a fixed box: past this many chips a card shows the first ones
const BADGES_PER_CARD = 3;
// "<extId>/<id>" -> { label, icon, render(pane, ctx) } contributed to character.details.tab
const _tabs = new Map();
const EXT_TAB_EVENT = 'cl-ext-tabs-changed';
// "ext:<extId>/<id>" -> { label, icon, render(el), enter?(el), leave?() } contributed to
// shell.view: that name is the view's everywhere (switchView, view.switch, getCurrentView)
const _views = new Map();
const EXT_VIEW_EVENT = 'cl-ext-views-changed';
// what a manifest may declare under "contributes"; the server validates the same list
export const CONTRIBUTIONS = Object.freeze(['chat.window', 'chat.action', 'message.action', 'character.action', 'app.action', 'character.card.badge', 'character.details.tab', 'character.bulk.action', 'shell.view', 'lore.entry.action', 'chat.card.action', 'composer.action']);

let _inventory = null;    // the server's list, as this account sees it
// true during the boot load: a landing badge's rows already carry its projection
let _booting = false;

// ========================================
// THE SLOTS
// ========================================
// The places an extension fills today. ctx.ui.contribute(slotId, spec) fills any of them;
// api 1's addAction, addChatWindow and the two section registrars are its sugar. What each
// hands and takes is ext-contract.js's.

defineSlot({ id: 'chat.action', kind: 'action', phone: 'mirror', title: "The conversation's options menu" });
defineSlot({ id: 'message.action', kind: 'action', phone: 'mirror', title: "A message's overflow menu" });
defineSlot({ id: 'character.action', kind: 'action', phone: 'mirror', title: 'The character context menu' });
defineSlot({ id: 'character.bulk.action', kind: 'action', phone: 'same', title: 'The multi-select toolbar and the context menu of a selection' });
defineSlot({ id: 'app.action', kind: 'action', phone: 'mirror', title: 'The topbar menu' });
defineSlot({ id: 'chat.window', kind: 'window', phone: 'mirror', title: 'A window in the conversation' });
defineSlot({ id: 'extension.settings', kind: 'section', phone: 'same', title: "The extension's row in Settings > Extensions" });
defineSlot({ id: 'provider.settings', kind: 'section', phone: 'same', title: "A provider's section in Settings > Online" });
defineSlot({ id: 'character.card.badge', kind: 'badge', phone: 'same', title: 'A chip on a character grid card' });
defineSlot({ id: 'character.details.tab', kind: 'tab', phone: 'same', title: "A tab in a character's details" });
defineSlot({ id: 'shell.view', kind: 'view', phone: 'mirror', title: 'A top-level view beside Characters, Chats and Online' });
defineSlot({ id: 'lore.entry.action', kind: 'action', phone: 'same', title: "An open lorebook entry, in the manager and the chat's lore window" });
defineSlot({ id: 'chat.card.action', kind: 'action', phone: 'mirror', title: "A chat's menu in the chats view" });
defineSlot({ id: 'composer.action', kind: 'action', phone: 'same', title: "A strip of buttons above the conversation's composer" });

// ========================================
// THE HOOKS
// ========================================
// The client's pipelines, defined here so they exist before any extension loads; each site
// asks hasHook first, so a hook nobody added costs one map read. message.render filters a
// message's purified body (the chat purifies the answer again); message.enhance hands each
// message row put in the DOM, for what the sanitizer cannot pass, and runs again on a row it
// already saw.

defineHook('message.render', { kind: 'filter', shape: v => typeof v === 'string' });
defineHook('message.enhance', { kind: 'action' });
// the text before it is sent; async allowed, and an empty answer means the extension took the text
defineHook('composer.send', { kind: 'filter', shape: v => typeof v === 'string', async: true });

// ========================================
// THE EVENTS
// ========================================
// The public vocabulary. Each one here but the generations relays a DOM event the app already
// dispatches, and the relay is installed only while something listens, so an event nobody hears
// costs nothing.
// Payloads carry ids: a listener re-reads what changed. The data events (characters, chats,
// messages, settings, tags, media) come from the change feed instead, which alone sees every
// write whatever made it. A relayed change the feed patched in from elsewhere carries the
// source 'feed', which is what origin reads. Each payload's keys are ext-contract.js's.

const originOfSource = (source) => (source === 'feed' ? 'remote' : 'self');
defineEvent('conversation.changed', { legacy: 'cl-chat-changed', map: d => ({ chatId: d?.chatId ?? null, charId: d?.char?.id ?? null }) });
defineEvent('lorebook.changed', { legacy: 'cl-worlds-changed', map: d => ({ name: d?.world ?? null, origin: originOfSource(d?.source) }) });
defineEvent('persona.changed', { legacy: 'cl-persona-changed', map: d => ({ scope: d?.scope ?? null, personaId: d?.personaId ?? null, chatId: d?.chatId ?? null, origin: originOfSource(d?.source) }) });
defineEvent('library.ready', { legacy: 'cl-characters-loaded', map: () => ({}) });
defineEvent('extensions.ready', { legacy: 'cl-extensions-settled', map: () => ({}) });
defineEvent('ui.formFactorChanged', { legacy: 'cl-mobile-mode-change', map: d => ({ mobile: !!d?.mobile }) });
// the DOM event fires on every refresh; the public one hands on a change only, in three levels (the notice reads as none)
defineEvent('notifications.changed', { legacy: 'cl-notifications-changed', map: d => ({ level: ['warning', 'activity'].includes(d?.level) ? d.level : 'none', visible: !!d?.visible }), dedupe: true });
// emitted by the conversation (fireEvent), which loads after every extension: defined here so a
// listener at init finds them
defineEvent('generation.started');
defineEvent('generation.ended');
defineEvent('generation.failed');

const _relays = new Map(); // event name -> the DOM listener relaying its twin
watchListeners((name, heard) => {
    const ev = getEvent(name);
    if (!ev?.legacy) return;
    if (heard && !_relays.has(name)) {
        const relay = (e) => {
            const payload = Object.freeze(ev.map ? ev.map(e.detail) : { ...(e.detail || {}) });
            if (ev.dedupe) {
                const key = JSON.stringify(payload);
                if (key === relay.last) return;
                relay.last = key;
            }
            emitEvent(name, payload);
        };
        _relays.set(name, relay);
        document.addEventListener(ev.legacy, relay);
    } else if (!heard && _relays.has(name)) {
        document.removeEventListener(ev.legacy, _relays.get(name));
        _relays.delete(name);
    }
});

/**
 * The inventory rows to load: a client entry or a sheet, not broken, and enabled (the server's call).
 * @param {Array<object>} extensions server inventory rows
 * @returns {Array<object>} rows to load
 */
export function decideExtensionsToLoad(extensions) {
    // a style-only extension (a theme) is a client load too: its sheet is its whole job
    return (Array.isArray(extensions) ? extensions : [])
        .filter(e => e && !e.error && (e.client || e.style) && e.enabled === true);
}

function extUrl(id, rel) {
    // a server asset, so a detached client imports it from the server origin; the generation
    // keeps relative imports fresh after a reload
    const gen = _generation.get(id);
    return CoreAPI.serverUrl(`/ext/${id}${gen ? `@${gen}` : ''}/${String(rel).replace(/^\/+/, '')}`);
}

// the action registrar's slot for each action slot row, and the row each slot is declared as
const ACTION_SLOT_OF = Object.freeze({ 'chat.action': 'chat', 'message.action': 'message', 'character.action': 'character', 'app.action': 'app', 'character.bulk.action': 'bulk', 'lore.entry.action': 'lore', 'chat.card.action': 'chatCard', 'composer.action': 'composer' });
const ACTION_ROW_OF = Object.freeze(Object.fromEntries(Object.entries(ACTION_SLOT_OF).map(([row, slot]) => [slot, row])));

// how contribute() fills each slot kind: through api 1's registrar, or one private to the ctx
const FILL = {
    badge: (ui, slot, spec, own) => own.addBadge(spec),
    tab: (ui, slot, spec, own) => own.addDetailTab(spec),
    view: (ui, slot, spec, own) => own.addView(spec),
    action: (ui, slot, spec) => ui.addAction(ACTION_SLOT_OF[slot.id], spec),
    window: (ui, slot, spec) => ui.addChatWindow(spec),
    section: (ui, slot, spec) => {
        if (typeof spec?.render !== 'function') throw new Error(`contribute: ${slot.id} needs render(el)`);
        if (slot.id === 'provider.settings') {
            if (!spec.providerId) throw new Error('contribute: provider.settings needs the providerId');
            return ui.addProviderSettingsSection(spec.providerId, spec.render, spec);
        }
        return ui.addSettingsSection(spec.render);
    },
};

// ========================================
// THE REGISTRARS
// ========================================
// One grammar and one landing for every spec a registrar keeps: the id, the label room, the icon,
// the function it needs and the hooks it may take, one entry a key (frozen, on the ledger, its drop
// announcing the removal), the manifest's declaration and the landing announced. A kind holds what
// differs: the words its refusals use (who heads the spec refusal, at the rest, taken the
// duplicate's), its registry and key, its room and icon rule, its event and its declaration.
const REGISTRARS = {
    badge: {
        who: 'contribute: character.card.badge', at: 'contribute: character.card.badge ', taken: 'contribute: badge',
        needs: ['render', 'needs render(row)'], hooks: [],
        registry: () => _badges, event: EXT_BADGE_EVENT, declares: 'character.card.badge',
        // a badge landing during the boot load reads rows that already carry its projection
        landing: () => ({ boot: _booting }),
    },
    tab: {
        who: 'contribute: character.details.tab', at: 'contribute: character.details.tab ', taken: 'contribute: tab',
        label: 24, icon: 'optional', iconLike: 'fa-note-sticky', needs: ['render', 'needs render(pane, ctx)'], hooks: [],
        registry: () => _tabs, event: EXT_TAB_EVENT, declares: 'character.details.tab',
    },
    view: {
        who: 'contribute: shell.view', at: 'contribute: shell.view ', taken: 'contribute: view',
        label: 24, icon: 'required', iconLike: 'fa-chart-simple', needs: ['render', 'needs render(el)'], hooks: ['enter', 'leave', 'refresh'],
        registry: () => _views, key: (owner, sid) => `ext:${owner}/${sid}`, named: true, event: EXT_VIEW_EVENT, declares: 'shell.view',
        // announced while it is still registered: a shell showing it leaves it first, so its leave() runs
        announceFirst: true,
    },
    window: {
        who: 'addChatWindow', at: 'addChatWindow: ', taken: 'addChatWindow:',
        label: 40, icon: 'required', iconLike: 'fa-puzzle-piece', needs: ['render', 'render(bodyEl, ctx) is required'], hooks: ['follow', 'onOpen', 'onClose', 'when'],
        registry: () => _chatWindows, event: EXT_WINDOW_EVENT, declares: 'chat.window',
    },
    overlay: {
        who: 'addOverlay', at: 'addOverlay: ', taken: 'addOverlay:',
        needs: ['close', 'close() is required'], hooks: ['visible'],
        registry: () => _overlays,
    },
    action: {
        who: 'addAction', at: 'addAction: ', taken: 'addAction:',
        label: 40, icon: 'required', iconLike: 'fa-hand', needs: ['run', 'run(context) is required'], hooks: ['when'],
        // the slot is part of the key: one id may serve two slots, and the runner must never cross them
        registry: (slot) => _actions.get(slot), key: (owner, sid, slot) => `${slot}:${owner}/${sid}`, event: EXT_ACTION_EVENT, declares: (slot) => ACTION_ROW_OF[slot],
    },
};

/**
 * Hold a spec to its kind's grammar, then freeze it into the registry, on the owner's ledger, announced.
 * @returns {object} the entry
 */
function registerSpec(kind, owner, manifest, spec, { slot = null, build = null, landed = null, dropped = null } = {}) {
    const K = REGISTRARS[kind];
    if (!spec || typeof spec !== 'object') throw new Error(`${K.who} needs a spec object`);
    const sid = String(spec.id || '');
    if (!WINDOW_ID_RE.test(sid)) throw new Error(`${K.at}id "${sid}" must match ${WINDOW_ID_RE}`);
    const label = String(spec.label || '').trim();
    if (K.label && (!label || label.length > K.label)) throw new Error(`${K.at}label is required (at most ${K.label} characters)`);
    const icon = spec.icon == null ? '' : String(spec.icon);
    if (K.icon && (icon || K.icon === 'required') && !ICON_RE.test(icon)) throw new Error(`${K.at}icon "${icon}" must be a Font Awesome solid name like ${K.iconLike}`);
    const [fn, needs] = K.needs;
    if (typeof spec[fn] !== 'function') throw new Error(`${K.at}${needs}`);
    for (const hook of K.hooks) {
        if (spec[hook] != null && typeof spec[hook] !== 'function') throw new Error(`${K.at}${hook} must be a function`);
    }
    const registry = K.registry(slot);
    const key = K.key ? K.key(owner, sid, slot) : `${owner}/${sid}`;
    const declared = _declaredSpecs.has(spec);
    if (!replaceable(registry.get(key))) throw new Error(`${K.taken} "${sid}" is already registered by ${owner}${slot ? ` in the ${slot} slot` : ''}`);
    const named = K.named ? { name: key } : {};
    const base = { key, ...(slot ? { slot } : {}), ...named, extId: owner, extName: String(manifest.name || owner), id: sid, label, icon, declared };
    const entry = Object.freeze({ ...base, [fn]: spec[fn], ...Object.fromEntries(K.hooks.map(h => [h, spec[h] || null])), ...build?.(base) });
    registry.set(key, entry);
    const announce = (more) => {
        if (K.event) document.dispatchEvent(new CustomEvent(K.event, { detail: { ...(slot ? { slot } : {}), extId: owner, id: sid, ...named, ...more } }));
    };
    const drop = () => {
        if (registry.get(key) !== entry) return;
        if (!K.announceFirst) registry.delete(key);
        announce({ removed: true });
        registry.delete(key);
        dropped?.(entry);
    };
    settleDeclared(owner, key, declared, trackRegistration(owner, kind, key, drop), drop);
    if (K.declares) warnUndeclared(manifest, typeof K.declares === 'function' ? K.declares(slot) : K.declares);
    announce(K.landing?.() || {});
    landed?.(entry);
    return entry;
}

// ========================================
// THE DOORS
// ========================================
// What every extension spelled for itself until the host held it: a request to its own server
// half, the connection picker, a dialog in the app's shell, a chat's data read while it is shown,
// and the text a message shows with its digest. Built per extension from the facade alone.

/** ctx.server.call and stream: a request to this extension's server half, answered whole or a line at a time as it lands. */
function serverDoor(id) {
    const serverCall = async (path, method = 'GET', body = null, { signal } = {}) => {
        const resp = await CoreAPI.apiRequest(`/ext/${id}${path}`, method, body, signal ? { signal } : {});
        return CoreAPI.readAnswer(resp);
    };
    // the request goes out at the first read; leaving the loop early lets the answer go
    const serverStream = (path, method = 'POST', body = null, { signal } = {}) => (async function* lines() {
        const resp = await CoreAPI.apiRequest(`/ext/${id}${path}`, method, body, signal ? { signal } : {});
        if (!resp.ok || !/^application\/x-ndjson\b/i.test(resp.headers?.get?.('Content-Type') || '')) {
            yield await CoreAPI.readAnswer(resp);
            return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '', done = false;
        try {
            while (!done) {
                const chunk = await reader.read();
                done = chunk.done;
                buf += decoder.decode(chunk.value, { stream: !done });
                let at;
                while ((at = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, at).trim();
                    buf = buf.slice(at + 1);
                    if (line) yield JSON.parse(line);
                }
            }
            if (buf.trim()) yield JSON.parse(buf);
        } finally {
            if (!done) reader.cancel().catch(() => { /* the stream already ended */ });
        }
    })();
    return { call: serverCall, stream: serverStream };
}

// one connections read shared by every picker a pass draws; the next pass reads again
let _connectionsRead = null;
const readConnections = () => (_connectionsRead ??= CoreAPI.getLlmSettings().finally(() => { _connectionsRead = null; }));

/** ctx.ui.connectionSelect: the account's connections in a select, each pick kept under key; answers { gone }. */
function connectionSelectDoor(settings) {
    return async (select, { key = 'profileId' } = {}) => {
        if (key !== null) select.addEventListener('change', () => settings.set(key, select.value));
        let read = null;
        try { read = await readConnections(); } catch { /* the default alone */ }
        const readOk = !!read && !read.error;
        const profiles = (readOk && read.profiles) || [];
        const esc = (s) => CoreAPI.escapeHtml(s);
        for (const p of profiles) select.insertAdjacentHTML('beforeend', `<option value="${esc(p.id)}">${esc(p.name || p.model || p.kind)}</option>`);
        let gone = false;
        if (key !== null) {
            const picked = settings.get(key) || '';
            const listed = profiles.some(p => String(p.id) === picked);
            select.value = listed ? picked : '';
            gone = !!picked && !listed && readOk;
        }
        CoreAPI.initCustomSelect(select);
        return { gone };
    };
}

/** ctx.ui.dialog: a dialog in the app's own .cl-modal shell and overlay stack, built afresh on each open. */
function dialogDoor(addOverlay, spec) {
    if (!spec || typeof spec !== 'object') throw new Error('dialog needs a spec object');
    const label = String(spec.label || '').trim();
    if (!label || label.length > 60) throw new Error('dialog: label is required (at most 60 characters)');
    const icon = spec.icon == null ? '' : String(spec.icon);
    if (icon && !ICON_RE.test(icon)) throw new Error(`dialog: icon "${icon}" must be a Font Awesome solid name like fa-comment-dots`);
    const className = String(spec.className || '').trim();
    if (!/^[\w -]*$/.test(className)) throw new Error('dialog: className is class names separated by spaces');
    for (const hook of ['canClose', 'onClose']) {
        if (spec[hook] != null && typeof spec[hook] !== 'function') throw new Error(`dialog: ${hook} must be a function`);
    }
    const min = spec.min == null ? null : { w: Number(spec.min.w), h: Number(spec.min.h) };
    if (min && !(Number.isInteger(min.w) && Number.isInteger(min.h) && min.w > 0 && min.h > 0)) throw new Error('dialog: min is { w, h } in whole pixels');
    let el = null;
    // a dismissal asks canClose first (a plain answer closes at once, a promise is awaited); leaving
    // (the extension switched off) and force never ask
    const close = async (how = {}) => {
        const node = el;
        if (!node) return false;
        if (!how.leaving && !how.force && spec.canClose) {
            let ok = spec.canClose(how);
            if (typeof ok?.then === 'function') ok = await ok;
            if (ok === false) return false;
        }
        if (el !== node) return false;
        el = null;
        node.remove();
        spec.onClose?.(how);
        return true;
    };
    const elementId = addOverlay({ id: spec.id, close: (how) => { void close(how || {}); } });
    const esc = (s) => CoreAPI.escapeHtml(s);
    const open = ({ title = label } = {}) => {
        if (el) void close({ force: true });
        const node = document.createElement('div');
        node.id = elementId;
        node.className = 'cl-modal';
        node.innerHTML = `
            <div class="cl-modal-content${className ? ` ${className}` : ''}"${spec.size ? '' : ' data-nosize'}${min ? ` data-fw-min="${min.w}x${min.h}"` : ''} role="dialog" aria-label="${esc(label)}">
                <div class="cl-modal-header">
                    <h3>${icon ? `<i class="fa-solid ${icon}" aria-hidden="true"></i> ` : ''}${esc(title)}</h3>
                    <button type="button" class="cl-modal-close" title="Close" aria-label="Close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
                </div>
                <div class="cl-modal-body"></div>
            </div>`;
        document.body.appendChild(node);
        el = node;
        node.addEventListener('click', (e) => { if (e.target === node || e.target.closest?.('.cl-modal-close')) void close(); });
        // shown on the next frame: the phone's back guard hears a modal turn visible, never one born so
        requestAnimationFrame(() => node.classList.add('visible'));
        if (spec.size) CoreAPI.mountDialogSizing(node);
        return node.querySelector('.cl-modal-body');
    };
    return { open, close, isOpen: () => !!el, get el() { return el; } };
}

/** ctx.chats.follow: one chat's data read while it is shown; the newest read wins. */
function followDoor(spec) {
    if (!spec || typeof spec !== 'object') throw new Error('follow needs a spec object');
    for (const fn of ['read', 'apply']) if (typeof spec[fn] !== 'function') throw new Error(`follow: ${fn} is required`);
    for (const hook of ['fail', 'moved', 'working']) {
        if (spec[hook] != null && typeof spec[hook] !== 'function') throw new Error(`follow: ${hook} must be a function`);
    }
    const soonMs = Number.isFinite(spec.soonMs) ? spec.soonMs : 400;
    const pollMs = Number.isFinite(spec.pollMs) ? spec.pollMs : 2000;
    let chatId = null, open = false, seq = 0, pollTimer = null, soonTimer = null;
    const reload = async () => {
        clearTimeout(pollTimer);
        const mine = ++seq;
        if (!chatId) { spec.apply(null, null); return; }
        const shown = chatId;
        let next;
        try { next = await spec.read(shown); } catch (e) {
            if (mine === seq) spec.fail?.(e, shown);
            return;
        }
        // a newer read owns it now (a chat shown since started one)
        if (mine !== seq) return;
        spec.apply(next, shown);
        if (open && spec.working?.(next)) pollTimer = setTimeout(() => { void reload(); }, pollMs);
    };
    const show = (id) => {
        open = true;
        const was = chatId;
        if ((id || null) !== was) {
            chatId = id || null;
            spec.moved?.(chatId, was);
        }
        return reload();
    };
    const rest = () => {
        open = false;
        clearTimeout(pollTimer);
        clearTimeout(soonTimer);
    };
    const reloadSoon = () => {
        clearTimeout(soonTimer);
        soonTimer = setTimeout(() => { void reload(); }, soonMs);
    };
    return { show, reload, reloadSoon, rest, isOpen: () => open, chatId: () => chatId };
}

/** ctx.messages.shown: the text a message shows, its active alternate when it has several, else mes. */
function shownText(msg) {
    if (!msg || typeof msg !== 'object') return '';
    const swipes = Array.isArray(msg.swipes) ? msg.swipes : null;
    if (swipes && swipes.length > 1) {
        const at = Math.min(Math.max(Number(msg.swipe_id) || 0, 0), swipes.length - 1);
        return typeof swipes[at] === 'string' ? swipes[at] : '';
    }
    return typeof msg.mes === 'string' ? msg.mes : '';
}

/** ctx.messages.digest: FNV-1a over a text, as eight hex digits, the same here and on the server. */
function digestOf(text) {
    let h = 0x811c9dc5;
    const s = String(text ?? '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

function buildCtx(manifest) {
    const id = manifest.id;
    // the store's key grammar is [a-z0-9_-] (no dots), so the namespace joins with a dash
    const storeKey = `ext-${id}`;
    // listener -> Map(event name -> its off), so events.off finds what events.on added
    const listening = new Map();
    // the registrars only contribute() reaches
    const own = {
        // a grid card chip: render(row) answers { icon, label, tone } or null, synchronously, as the grid builds
        addBadge(spec) {
            registerSpec('badge', id, manifest, spec);
        },
        // a details tab after the app's own: render(pane, ctx) paints on its first show per character
        addDetailTab(spec) {
            registerSpec('tab', id, manifest, spec);
        },
        // a top-level view: render(el) on the first entry, enter(el) on each entry, leave() on each exit
        addView(spec) {
            registerSpec('view', id, manifest, spec);
        },
    };
    const ctx = {
        apiVersion: EXT_API_VERSION,
        manifest,
        CoreAPI: ownedCoreApi(id),
        log: (...args) => console.log(`[ext:${id}]`, ...args),
        // a listed name rides the bus, any other is a raw DOM listener (api 1); emits stay ext:<id>:<name>
        events: {
            on(name, fn) {
                // a function, or an EventListener object (api 1 handed these straight to the DOM)
                const call = typeof fn === 'function' ? fn : (typeof fn?.handleEvent === 'function' ? (e) => fn.handleEvent(e) : null);
                if (!call) throw new Error('events.on needs a listener function, or an object with a handleEvent function');
                if (!listening.has(fn)) listening.set(fn, new Map());
                const byName = listening.get(fn);
                if (byName.has(name)) return;
                let off;
                if (getEvent(name)) {
                    off = onEvent(id, name, call);
                } else {
                    const relay = (e) => callOwner(id, `event ${name}`, () => call(e));
                    document.addEventListener(name, relay);
                    let release = () => {};
                    off = () => { document.removeEventListener(name, relay); release(); };
                    release = trackRegistration(id, 'dom-listener', name, off);
                }
                byName.set(name, off);
            },
            off(name, fn) {
                const byName = listening.get(fn);
                const off = byName?.get(name);
                if (!off) return;
                off();
                byName.delete(name);
            },
            emit: (name, detail) => document.dispatchEvent(new CustomEvent(`ext:${id}:${name}`, { detail })),
            list: () => listEventsPublic(),
        },
        // Verbs by id, first-party and extension alike. An extension's own command is
        // "<extId>.<name>", so it can never take a first-party id or another extension's.
        commands: {
            run: (commandId, args) => runCommand(commandId, args),
            list: () => listCommands(),
            register(name, fn, meta = {}) {
                if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/.test(String(name))) {
                    throw new Error(`commands.register: "${name}" must be lowercase words joined by dots or dashes`);
                }
                return defineCommand(`${id}.${name}`, fn, { title: meta.title || '', owner: id });
            },
            wrap: (commandId, wrapper, opts) => wrapCommand(id, commandId, wrapper, opts),
        },
        // an action in the app's keymap, "<extId>.<name>": listed in Settings > Keyboard under the extension and rebound there
        keys: {
            register(spec = {}) {
                const name = String(spec.id ?? '');
                if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/.test(name)) {
                    throw new Error(`keys.register: "${name}" must be lowercase words joined by dots or dashes`);
                }
                if (typeof spec.run !== 'function') throw new Error('keys.register needs run()');
                const full = `${id}.${name}`;
                const off = defineKey({
                    id: full, label: spec.label, key: spec.key, scope: spec.scope ?? 'global', owner: id, ownerName: manifest.name || id,
                    run: () => callOwner(id, `key ${name}`, () => spec.run()),
                });
                trackRegistration(id, 'key', full, off);
                return full;
            },
        },
        // the host's pipelines: a filter answers the value to hand on (undefined leaves it), an action is told
        hooks: {
            add: (name, fn, opts) => addHook(id, name, fn, opts),
            list: () => listHooks().map(({ name, kind, async, value, context, answer }) => ({ name, kind, async, value, context, answer })),
        },
        // this extension's own server half, and the text a message shows with its digest (THE DOORS)
        server: serverDoor(id),
        messages: { shown: shownText, digest: digestOf },
        // a fetch inside the hosted browser through a consumer the server half registered (ctx.browser.consumer there)
        browser: Object.freeze({
            fetch: (name, path, opts = {}) => browserFetch(`${id}:${name}`, path, { ...opts, endpoint: undefined }),
        }),
        // stateless on purpose: a failed load throws rather than caching an empty doc the next save clobbers
        storage: {
            load: () => CoreAPI.storeRead(storeKey),
            save: (doc) => CoreAPI.storeWrite(storeKey, doc),
        },
        // keys ride the wire as ext:<id>:<key>; the fallback is the server's settingValue (unset, null or '' read the default)
        settings: {
            defaults: Object.freeze({ ...(manifest.settings || {}) }),
            get(key) {
                const v = CoreAPI.getSetting(`ext:${id}:${key}`);
                return v === undefined || v === null || v === '' ? (manifest.settings || {})[key] : v;
            },
            set(key, value) {
                CoreAPI.setSetting(`ext:${id}:${key}`, value);
                announceSettingWrite(id, key);
            },
        },
        chats: {
            // sugar over chat.open so a wrapper hears it; async so it always answers a promise
            open: async (chatId, opts) => runCommand('chat.open', { chatId, ...(opts || {}) }),
            follow: (spec) => followDoor(spec),
        },
        ui: {
            // Fill a slot by id (ctx.ui.slots() lists them). The calls below are this one's sugar.
            contribute(slotId, spec) {
                const slot = getSlot(slotId);
                if (!slot) throw new Error(`contribute: unknown slot "${slotId}" (one of ${listSlots().map(s => s.id).join(', ')})`);
                const fill = FILL[slot.kind];
                if (!fill) throw new Error(`contribute: the ${slot.kind} slot ${slotId} takes no contributions yet`);
                return fill(ctx.ui, slot, spec, own);
            },
            slots: () => listSlots(),
            // Renders inside the extension's row in Settings > Extensions, every time the
            // manager draws its list.
            addSettingsSection(render) {
                if (typeof render !== 'function') throw new Error('addSettingsSection needs render(el)');
                _settingsSections.set(id, render);
                trackRegistration(id, 'section', 'extension.settings', () => {
                    if (_settingsSections.get(id) === render) _settingsSections.delete(id);
                });
            },
            // a provider's Settings > Online section, chrome built from its manifest row; call after providers.register
            addProviderSettingsSection(providerId, render, opts) {
                if (!providerId) throw new Error('addProviderSettingsSection needs the providerId');
                if (typeof render !== 'function') throw new Error('addProviderSettingsSection needs render(el)');
                const pid = String(providerId);
                // guarded here because the injector calls it from the classic side, where a
                // rejected promise would surface nowhere
                const guarded = (el) => callOwner(id, `provider section ${pid}`, () => render(el));
                const entry = { render: guarded, opts: opts || {}, injected: false };
                _providerSections.set(pid, entry);
                trackRegistration(id, 'section', `provider.settings/${pid}`, () => {
                    if (_providerSections.get(pid) !== entry) return;
                    _providerSections.delete(pid);
                    if (entry.injected) hostBridge.removeProviderSettingsSection(pid);
                });
                injectPendingProviderSections();
            },
            // a window in the conversation; throws on a bad spec, since a silent refusal reads as a missing window
            addChatWindow(spec) {
                registerSpec('window', id, manifest, spec, { build: ({ id: wid }) => {
                    const min = spec.min && typeof spec.min === 'object'
                        ? { w: Math.max(10, Number(spec.min.w) || 20), h: Math.max(10, Number(spec.min.h) || 25) }
                        : { w: 20, h: 25 };
                    // the first size in percent of the conversation area, held between min and 100
                    const pct = (v, floor, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(floor, n)) : fallback; };
                    const size = spec.size && typeof spec.size === 'object'
                        ? { w: pct(spec.size.w, min.w, 38), h: pct(spec.size.h, min.h, 70) }
                        : { w: 38, h: 70 };
                    const defaults = { ...size, x: Math.min(60, 100 - size.w), y: 8 };
                    // the four geometry keys ride the extension's scoped settings (win-<id>-w and
                    // friends), so a window's place follows the account and never a first-party key
                    const gkey = (axis) => `win-${wid}-${axis}`;
                    const geometry = {
                        defaults,
                        load() {
                            const num = (axis, fallback) => { const v = Number(ctx.settings.get(gkey(axis))); return Number.isFinite(v) ? v : fallback; };
                            return { w: num('w', defaults.w), h: num('h', defaults.h), x: num('x', defaults.x), y: num('y', defaults.y) };
                        },
                        save(g) { for (const axis of ['w', 'h', 'x', 'y']) ctx.settings.set(gkey(axis), Math.round(g[axis])); },
                        // a null reads as unset, so the window loads its defaults
                        reset() { for (const axis of ['w', 'h', 'x', 'y']) ctx.settings.set(gkey(axis), null); },
                    };
                    return { min, geometry };
                } });
            },
            // an overlay the extension builds itself, in the app's overlay stack; answers the element's id
            addOverlay(spec) {
                return registerSpec('overlay', id, manifest, spec, {
                    build: ({ id: oid }) => {
                        const elementId = `ext-${id}-${oid}`;
                        const close = () => { callOwner(id, `overlay ${oid} close`, () => spec.close()); };
                        const cfg = { id: elementId, tier: OVERLAY_TIER, static: false, close };
                        if (spec.visible) cfg.visible = (el) => !!callOwner(id, `overlay ${oid} visible`, () => spec.visible(el));
                        return { elementId, cfg };
                    },
                    landed: ({ cfg }) => hostBridge.registerOverlay(cfg),
                    // leaving: close is told so, and the element goes whatever close did, so none outlives its extension
                    dropped: ({ id: oid, elementId }) => {
                        if (document.getElementById(elementId)) {
                            callOwner(id, `overlay ${oid} close`, () => spec.close({ leaving: true }));
                            document.getElementById(elementId)?.remove?.();
                        }
                        hostBridge.unregisterOverlay(elementId);
                    },
                }).elementId;
            },
            // A dialog in the app's own shell, on top of addOverlay (the host builds and closes it)
            dialog(spec) {
                return dialogDoor(ctx.ui.addOverlay, spec);
            },
            connectionSelect(select, opts) {
                return connectionSelectDoor(ctx.settings)(select, opts);
            },
            // a verb in a first-party menu; desktop and phone render it from the one registration
            addAction(slot, spec) {
                if (!ACTION_SLOTS.includes(slot)) throw new Error(`addAction: unknown slot "${slot}" (one of ${ACTION_SLOTS.join(', ')})`);
                // the topbar menu is the classic shell's: rebuilt here and on every open, where when() sees the view
                const rebuildApp = () => { if (slot === 'app') hostBridge.renderExtensionAppActions(); };
                registerSpec('action', id, manifest, spec, { slot, landed: rebuildApp, dropped: rebuildApp });
            },
        },
        // A full character-source provider: every derived surface reads the manifest live, so registering is the whole job
        providers: {
            register: async (provider, manifestRow) => {
                if (!manifest.provider) {
                    throw new Error('manifest.json must declare provider: true so the server diverts your links');
                }
                // the server diverts links on the manifest.json namespace (defaulting to the
                // extension id), so the client row is seeded from that same declaration
                const extNamespace = manifest.extNamespace || id;
                const declared = manifestRow?.extNamespace;
                if (declared != null && declared !== extNamespace) {
                    throw new Error(`extNamespace "${declared}" disagrees with manifest.json ("${extNamespace}"); declare it once, in manifest.json`);
                }
                // one name everywhere: the server keys links by namespace, the app finds them by provider id
                if (provider?.id !== extNamespace) {
                    throw new Error(`the provider's id "${provider?.id}" must be its namespace "${extNamespace}" (manifest.json's extNamespace, else the extension id)`);
                }
                const out = await registerExtensionProvider(provider, { extNamespace, ...(manifestRow || {}) });
                trackRegistration(id, 'provider', provider.id, () => unregisterExtensionProvider(provider.id));
                return out;
            },
        },
    };
    return ctx;
}

// the listed events an extension may hear
function listEventsPublic() {
    return listEvents().map(({ name, payload, types }) => ({ name, payload, types }));
}

// CoreAPI's members that register something and answer its removal
const CORE_API_REGISTRARS = Object.freeze(['onViewEnter', 'onViewExit', 'onCharactersDeleted', 'storeWatch', 'onJob']);
// CoreAPI's members that register a spec by its id and answer what they made, each with the member that removes an id
const CORE_API_ID_REGISTRARS = Object.freeze({ registerNotificationSection: 'removeNotificationSection' });

/** ctx.CoreAPI: the facade read live, but its registrars land on the extension's ledger and answer their removal. */
function ownedCoreApi(owner) {
    const own = {};
    for (const name of CORE_API_REGISTRARS) {
        own[name] = (...args) => {
            const off = CoreAPI[name](...args);
            const undo = () => { if (typeof off === 'function') off(); };
            const release = trackRegistration(owner, 'core-api', name, undo);
            return () => { release(); undo(); };
        };
    }
    for (const [name, remover] of Object.entries(CORE_API_ID_REGISTRARS)) {
        const releases = new Map();
        // the extension's ids live under its own name, as its views do, so it never takes the app's or another's
        const ownId = (id) => (id == null || id === '' ? id : `ext:${owner}/${id}`);
        own[name] = (spec, ...args) => {
            const id = spec?.id;
            const held = id == null || id === '' ? spec : new Proxy(spec, { get: (t, k) => (k === 'id' ? ownId(id) : Reflect.get(t, k)) });
            const made = CoreAPI[name](held, ...args);
            // the spec rides the undo, so a switch-off spares a later registration under the same id
            const release = trackRegistration(owner, 'core-api', name, () => CoreAPI[remover](ownId(id), held));
            releases.set(id, [...(releases.get(id) || []), release]);
            return made;
        };
        own[remover] = (id, ...args) => {
            for (const release of releases.get(id) || []) release();
            releases.delete(id);
            return CoreAPI[remover](ownId(id), ...args);
        };
    }
    return new Proxy(CoreAPI, { get: (target, key, receiver) => (Object.hasOwn(own, key) ? own[key] : Reflect.get(target, key, receiver)) });
}

// ========================================
// LAZY ACTIVATION
// ========================================

// a key is free, or held by a placeholder its own code now takes
function replaceable(prior) {
    return !prior || prior.declared;
}

// a placeholder is noted under its owner; the code's registration of its key takes it off the ledger
function settleDeclared(owner, key, declared, release, drop) {
    const list = _placeholders.get(owner) || [];
    if (declared) {
        list.push({ key, release, drop });
        _placeholders.set(owner, list);
        return;
    }
    const at = list.findIndex(p => p.key === key);
    if (at !== -1) {
        list[at].release();
        list.splice(at, 1);
    }
}

// after the code ran: a declared entry point it never registered is a promise nothing keeps
function sweepDeclared(owner) {
    for (const p of _placeholders.get(owner) || []) {
        console.warn(`[ExtensionHost] ${owner} declares ${p.key} in its manifest's lazy block, but its code did not register it`);
        p.release();
        p.drop();
    }
    _placeholders.delete(owner);
}

// a lazy row's stand-ins: each forwards to the code's entry once it ran, so a kept entry still reaches it
function declareRow(row) {
    const ctx = buildCtx(row);
    const lazy = row.lazy || {};
    // a first use loads the code, a teardown or follow waits for one; a lapsed use answers null, a failed one throws
    const reach = async (starts, lookup, what) => {
        const st = _status.get(row.id);
        if (!starts && st?.state !== 'loaded' && !st?.activating) return null;
        if (!await activate(row.id)) {
            const now = _status.get(row.id);
            if (now?.state === 'failed') throw new Error(`${row.id} failed to load: ${now.error}`);
            return null;
        }
        // a declared entry the code never registered was swept when the code finished loading
        const real = lookup();
        if (!real) throw new Error(`${row.id} declares ${what} but its code did not register it`);
        return real;
    };
    for (const a of lazy.actions || []) {
        const key = `${a.slot}:${row.id}/${a.id}`;
        const spec = {
            id: a.id, label: a.label, icon: a.icon,
            async run(context) {
                const real = await reach(true, () => _actions.get(a.slot)?.get(key), `the ${a.slot} action "${a.id}"`);
                if (!real) return undefined;
                // a declaration cannot carry when(); the code's decides now that it is here
                if (real.when && !real.when(context || {})) {
                    CoreAPI.showToast(`${real.extName}: "${real.label}" does not apply here`, 'info');
                    return undefined;
                }
                return real.run(context || {});
            },
        };
        _declaredSpecs.add(spec);
        ctx.ui.addAction(a.slot, spec);
    }
    for (const w of lazy.windows || []) {
        const key = `${row.id}/${w.id}`;
        const call = async (hook, starts, ...args) => (await reach(starts, () => _chatWindows.get(key), `the window "${w.id}"`))?.[hook]?.(...args);
        const spec = {
            id: w.id, label: w.label, icon: w.icon, ...(w.size ? { size: w.size } : {}), ...(w.min ? { min: w.min } : {}),
            render: (el, wctx) => call('render', true, el, wctx),
            onOpen: (wctx) => call('onOpen', true, wctx),
            onClose: (wctx) => call('onClose', false, wctx),
            follow: (detail, wctx) => call('follow', false, detail, wctx),
        };
        _declaredSpecs.add(spec);
        ctx.ui.addChatWindow(spec);
    }
    for (const v of lazy.views || []) {
        const name = `ext:${row.id}/${v.id}`;
        const call = async (hook, starts, ...args) => (await reach(starts, () => _views.get(name), `the view "${v.id}"`))?.[hook]?.(...args);
        const spec = {
            id: v.id, label: v.label, icon: v.icon,
            render: (el) => call('render', true, el), enter: (el) => call('enter', true, el), leave: () => call('leave', false),
        };
        _declaredSpecs.add(spec);
        ctx.ui.contribute('shell.view', spec);
    }
}

// A lazy extension's first use: its code and sheet load once, however many uses wait on it
function activate(id) {
    const st = _status.get(id);
    if (!st || st.state !== 'declared') return Promise.resolve(st?.state === 'loaded');
    if (!st.activating) {
        const loading = loadCode(st.manifest, _loadModuleCSS, st);
        st.activating = loading;
        _inflight.set(id, loading);
        loading.finally(() => { if (_inflight.get(id) === loading) _inflight.delete(id); });
    }
    return st.activating.then(() => _status.get(id)?.state === 'loaded');
}

// on for this tab: its code ran, or its declared entry points wait for their first use
function isReady(id) {
    const state = _status.get(id)?.state;
    return state === 'loaded' || state === 'declared';
}

// an eager load whose init is running: on its way to ready, so no second load starts beside it
function isLoading(id) {
    return _status.get(id)?.state === 'loading';
}

// what a load of an id waits out first: a load of it under way, and its last dispose() still settling
async function settledFor(id) {
    while (_inflight.has(id) || _disposing.has(id)) await (_inflight.get(id) || _disposing.get(id));
}

/** Load a row the list says is on, unless ready, once every load of it under way has settled. */
async function loadIfOn(id, loadModuleCSS) {
    await settledFor(id);
    const row = (_inventory?.extensions || []).find(e => e.id === id);
    if (row?.enabled !== true || row.error || !(row.client || row.style) || isReady(id)) return;
    await loadOneRow(row, loadModuleCSS);
}

async function loadOneRow(row, loadModuleCSS) {
    if (loadModuleCSS) _loadModuleCSS = loadModuleCSS;
    // a lazy row waits for its first use: its declared entry points stand in for its code
    if (row.lazy && row.client) {
        try {
            _status.set(row.id, { manifest: row, state: 'declared' });
            declareRow(row);
            CoreAPI.debugLog(`[ExtensionHost] Declared extension: ${row.id} (its code loads at its first use)`);
        } catch (e) {
            console.error(`[ExtensionHost] Extension "${row.id}" failed to declare its entry points:`, e);
            disposeOwner(row.id);
            _placeholders.delete(row.id);
            _status.set(row.id, { manifest: row, state: 'failed', error: e.message });
        }
        return;
    }
    // an eager load is on record while its init runs, so an unload or a Reload meanwhile sees it
    const entry = { manifest: row, state: 'loading' };
    _status.set(row.id, entry);
    const loading = loadCode(row, loadModuleCSS, entry);
    _inflight.set(row.id, loading);
    loading.finally(() => { if (_inflight.get(row.id) === loading) _inflight.delete(row.id); });
    await loading;
}

// import a row's code and run its init; a load whose `from` state went meanwhile keeps nothing
async function loadCode(row, loadModuleCSS, from = null) {
    const current = () => !from || _status.get(row.id) === from;
    let styleLink = null;
    let mod = null;
    let initRan = false;
    // undone in a switch-off's order; an init that ran gets its dispose(), which owns what it did outside ctx
    const discard = () => {
        disposeOwner(row.id);
        _placeholders.delete(row.id);
        if (initRan && typeof mod?.default?.dispose === 'function') runDispose(row.id, mod.default);
        styleLink?.remove?.();
    };
    try {
        if (row.style) {
            styleLink = await loadModuleCSS(extUrl(row.id, row.style)) || null;
            if (styleLink?.dataset) styleLink.dataset.extStyle = row.id;
        }
        if (row.client) {
            mod = await import(extUrl(row.id, row.client));
            if (!current()) { styleLink?.remove?.(); return; }
            const t0 = performance.now();
            initRan = true;
            await mod.default?.init?.(buildCtx(row));
            recordOwnerCall(row.id, 'init', performance.now() - t0);
        }
        if (!current()) { discard(); return; }
        sweepDeclared(row.id);
        _status.set(row.id, { manifest: row, state: 'loaded', module: mod?.default || null, styleLink });
        CoreAPI.debugLog(`[ExtensionHost] Loaded extension: ${row.id}`);
    } catch (e) {
        // what it registered before failing leaves too: a half-initialized action would run on state init never built
        console.error(`[ExtensionHost] Extension "${row.id}" failed to load:`, e);
        const stillCurrent = current();
        discard();
        document.querySelector(`link[data-ext-style="${CSS.escape(row.id)}"]`)?.remove();
        if (stillCurrent) _status.set(row.id, { manifest: row, state: 'failed', error: e.message });
    }
}

// the server's list, re-read on demand (a later install is not in the boot copy); false when unreadable
async function readInventory() {
    try {
        const resp = await CoreAPI.apiRequest('/extensions', 'GET');
        if (!resp?.ok) return false;
        _inventory = await resp.json();
        announceQueryDoors();
        return true;
    } catch { return false; }
}

export const EXT_DOORS_EVENT = 'cl-ext-query-doors-changed';
// the list changed, and with it the sorts and filter fields the server answers for this account
function announceQueryDoors() {
    document.dispatchEvent(new CustomEvent(EXT_DOORS_EVENT));
}

/** The sort keys and rule fields of every extension this account has on; known stays false until the list is read. */
export function getQueryDoors() {
    const sortKeys = [], ruleFields = [];
    for (const row of _inventory?.extensions || []) {
        if (row.enabled !== true || row.error || !row.serverQuery) continue;
        const extName = String(row.name || row.id);
        for (const s of row.serverQuery.sortKeys || []) sortKeys.push({ sort: s.sort, label: s.label, extName });
        for (const f of row.serverQuery.ruleFields || []) ruleFields.push({ field: f.field, label: f.label, type: f.type, ops: [...f.ops], extName });
    }
    return { known: _inventory !== null, sortKeys, ruleFields };
}

/** Whether an extension's reports can move a list row or how the list reads; true while the list is unknown. */
export function extensionShapesRows(id) {
    if (_inventory === null) return true;
    const row = (_inventory.extensions || []).find(r => r.id === id);
    const q = row?.enabled === true && !row.error ? row.serverQuery : null;
    return !!(q && (q.projections?.length || q.ruleFields?.length || q.sortKeys?.length));
}

/** An installed extension's name as its manifest gives it, for saying what it added; its id when unknown. */
export function extensionName(id) {
    return (_inventory?.extensions || []).find(r => r.id === id)?.name || String(id ?? '');
}

/**
 * Boot entry, called by module-loader after the first-party modules initialize.
 * Waits for settings, which an extension's init reads through ctx.settings.
 */
export async function loadExtensions(loadModuleCSS) {
    // kept before anything can return: a boot that loads nothing still hands the loader to a later
    // switch-on (the feed's, a lazy first use)
    if (loadModuleCSS) _loadModuleCSS = loadModuleCSS;
    try { await CoreAPI.settingsReady(); } catch { return; }
    // signed out or unreachable: the manager UI re-reads the list when it opens
    if (!await readInventory() || !_inventory.enabled) return;
    const rows = decideExtensionsToLoad(_inventory.extensions);
    _booting = true;
    try {
        // the feed's patcher is registered before this runs, so a row it loaded or switched off
        // meanwhile is skipped
        for (const row of rows) await loadIfOn(row.id, loadModuleCSS);
    } finally { _booting = false; }
    // the registry's boot assert skips external rows; this is their deferred half
    for (const problem of unclaimedExternalRows(PROVIDER_MANIFEST, _inventory.extensions, (pid) => !!ProviderRegistry.getProvider(pid))) {
        console.error(`[ExtensionHost] ${problem}`);
    }
}

/**
 * The declared external provider rows nothing claimed, one line each; dormant while their extension is off.
 * @param {Object} manifest - PROVIDER_MANIFEST
 * @param {Array<Object>} extensions - the inventory rows
 * @param {(providerId: string) => boolean} isRegistered
 * @returns {string[]}
 */
export function unclaimedExternalRows(manifest, extensions, isRegistered) {
    const problems = [];
    for (const [pid, row] of Object.entries(manifest)) {
        if (!row.external || isRegistered(pid)) continue;
        const server = (extensions || []).find(e => e.provider && !e.error && e.extNamespace === row.extNamespace);
        if (server && server.enabled !== true) continue;
        problems.push(server
            ? `external provider row "${pid}" was not claimed by "${server.id}", which is on (did it fail to load?)`
            : `external provider row "${pid}" is served by no installed extension (namespace "${row.extNamespace}")`);
    }
    return problems;
}

/**
 * Switch an extension on or off for this account without a reload, by the row the server answers.
 * @returns {Promise<{ ok: boolean, row?: object, loaded?: boolean, error?: string }>}
 */
export async function setExtensionEnabled(id, on, loadModuleCSS) {
    let resp;
    try {
        resp = await CoreAPI.apiRequest(`/extensions/${encodeURIComponent(id)}/enabled`, 'PUT', { enabled: !!on });
    } catch (e) { return { ok: false, error: e?.message || String(e) }; }
    const row = await CoreAPI.readAnswer(resp).catch((e) => ({ error: e.message }));
    if (!row?.id) return { ok: false, error: row?.error || 'the server answered no extension' };
    if (_inventory) {
        const at = _inventory.extensions.findIndex(e => e.id === row.id);
        if (at === -1) _inventory.extensions.push(row); else _inventory.extensions[at] = row;
        announceQueryDoors();
    } else await readInventory();
    if (!row.enabled) {
        unloadExtension(id);
        return { ok: true, row, loaded: false };
    }
    return { ok: true, row, loaded: await loadNow(id, loadModuleCSS) };
}

/**
 * Another tab's switch or an admin's removal (the feed's records, null on a resync): load and unload by the re-read list.
 * @param {Array<object>|null} records
 */
export async function patchExtensionsFromFeed(records) {
    if (!await readInventory() || !_inventory.enabled) return;
    const named = records ? new Set(records.flatMap(r => r.ids || [])) : null;
    for (const row of _inventory.extensions) {
        if (named && !named.has(row.id)) continue;
        // started, never awaited: the feed runs patchers in turn, so a slow init would hold the whole feed
        if (row.enabled) void loadIfOn(row.id, _loadModuleCSS);
        else if (isReady(row.id) || isLoading(row.id)) unloadExtension(row.id);
    }
    const listed = new Set(_inventory.extensions.map(r => r.id));
    for (const id of [..._status.keys()]) {
        if (!listed.has(id) && (isReady(id) || isLoading(id)) && (!named || named.has(id))) unloadExtension(id);
    }
}

/**
 * Install an extension (admin) from a git url or a zip; the list is re-read so an enable needs no reload.
 * @param {string|Blob} source an https git url, or the archive
 * @returns {Promise<{ ok: boolean, id?: string, error?: string }>}
 */
export async function installExtension(source) {
    let resp;
    try {
        resp = typeof source === 'string'
            ? await CoreAPI.apiRequest('/extensions/install', 'POST', { git: source })
            : await CoreAPI.apiRequest('/extensions/install', 'POST', source, { raw: true, headers: { 'Content-Type': 'application/zip' } });
    } catch (e) { return { ok: false, error: e?.message || String(e) }; }
    const out = await CoreAPI.readAnswer(resp).catch((e) => ({ error: e.message }));
    if (!out?.id) return { ok: false, error: out?.error || 'the server answered no extension' };
    await readInventory();
    return { ok: true, id: out.id };
}

/**
 * Load an extension's code again under a new generation (the dev loop); a server half keeps its booted code.
 * @returns {Promise<{ ok: boolean, loaded?: boolean, server?: boolean, error?: string }>}
 */
export async function reloadExtension(id, loadModuleCSS) {
    await _inflight.get(id);
    // an unread list changes nothing here; what the list then says is what this tab runs
    if (!await readInventory()) return { ok: false, error: 'the extension list could not be read' };
    const row = (_inventory.extensions || []).find(e => e.id === id);
    unloadExtension(id);
    _status.delete(id);
    if (!row) return { ok: false, error: `"${id}" is not installed` };
    if (row.error) return { ok: false, error: row.error };
    _generation.set(id, Math.max(Date.now(), (_generation.get(id) || 0) + 1));
    const loaded = row.enabled === true && await loadNow(id, loadModuleCSS);
    return { ok: true, loaded, server: !!row.server, ...(_status.get(id)?.state === 'failed' ? { error: _status.get(id).error } : {}) };
}

/** Load one inventory row now, without a reload (the enable verb, once the server said on). */
export async function loadNow(id, loadModuleCSS) {
    // a load under way, and the id's last dispose(), settle before this decides anything
    await settledFor(id);
    if (isReady(id)) return true;
    const find = () => (_inventory?.extensions || []).find(e => e.id === id);
    let row = find();
    if (!row && await readInventory()) row = find();
    if (!row || row.error || !(row.client || row.style)) return false;
    await loadOneRow(row, loadModuleCSS);
    return isReady(id);
}

// an extension's dispose(), contained; a promise is on record until it settles or DISPOSE_WAIT_MS passes
function runDispose(id, module) {
    const out = guardExtensionCall(`${id} dispose()`, () => module.dispose());
    if (!out || typeof out.then !== 'function') return;
    let timer;
    const limit = new Promise((resolve) => {
        timer = setTimeout(() => {
            console.warn(`[ExtensionHost] ${id} dispose() has not settled after ${DISPOSE_WAIT_MS} ms; its next load goes on without it`);
            resolve();
        }, DISPOSE_WAIT_MS);
    });
    const settled = Promise.race([Promise.resolve(out).then(() => {}, () => {}), limit]).then(() => {
        clearTimeout(timer);
        if (_disposing.get(id) === settled) _disposing.delete(id);
    });
    _disposing.set(id, settled);
}

/**
 * Switch a loaded extension off without a reload: registrations undone newest first, then dispose(), then its sheet.
 * @returns {boolean} whether the extension was loaded
 */
export function unloadExtension(id) {
    const st = _status.get(id);
    if (!st || (st.state !== 'loaded' && st.state !== 'declared' && st.state !== 'loading')) return false;
    disposeOwner(id);
    _placeholders.delete(id);
    if (typeof st.module?.dispose === 'function') runDispose(id, st.module);
    st.styleLink?.remove?.();
    _status.delete(id);
    CoreAPI.debugLog(`[ExtensionHost] Unloaded extension: ${id}`);
    return true;
}

/** What the manager's inspector shows: this tab's registrations, calls and conflicts, beside the server half's, read off its row. */
export function inspectExtension(id, row = null) {
    return {
        registrations: [...ownerRegistrations(id), ...(Array.isArray(row?.serverHooks) ? row.serverHooks : [])],
        calls: [...ownerStats(id), ...(Array.isArray(row?.serverCalls) ? row.serverCalls.map(c => ({ ...c, server: true })) : [])],
        conflicts: commandConflicts().filter(c => c.owners.includes(id)),
    };
}

export function getExtensionStatus(id) {
    return _status.get(id) || null;
}

export function renderSettingsSection(id, el) {
    const render = _settingsSections.get(id);
    if (!render) return false;
    callOwner(id, 'settings section', () => render(el));
    return true;
}

/** Inject every pending provider settings section; safe from either side of the boot race. */
export function injectPendingProviderSections() {
    for (const [providerId, entry] of _providerSections) {
        if (entry.injected) continue;
        try {
            if (hostBridge.injectProviderSettingsSection(providerId, entry.render, entry.opts)) {
                entry.injected = true;
            }
        } catch (e) {
            console.error(`[ExtensionHost] provider settings section "${providerId}" failed:`, e);
            entry.injected = true; // a throwing render never retries into a half-built section
        }
    }
}

export function hasSettingsSection(id) {
    return _settingsSections.has(id);
}

/** Every registered extension chat window, in registration order. */
export function getChatWindows() {
    return [..._chatWindows.values()];
}

// a slot used without its contributes entry is a stale manifest: a console line, nothing more
function warnUndeclared(manifest, kind) {
    if (Array.isArray(manifest.contributes) && !manifest.contributes.includes(kind)) {
        console.warn(`[ExtensionHost] ${manifest.id} uses ${kind} but its manifest.json "contributes" does not declare it`);
    }
}

/** Every action registered for a slot, in registration order; an unknown slot is empty. */
export function getActions(slot) {
    return [...(_actions.get(slot)?.values() || [])];
}

/** Whether a slot has any action at all: the hot paths ask this before building a context. */
export function hasActions(slot) {
    return (_actions.get(slot)?.size || 0) > 0;
}

// the composer's strip, the selection's toolbar and the windows' doors stay drawn, asking each when() as they drew, and a setting may decide one
function announceSettingWrite(owner, key) {
    for (const slot of ['composer', 'bulk']) {
        if (hasActions(slot)) document.dispatchEvent(new CustomEvent(EXT_ACTION_EVENT, { detail: { slot, extId: owner, setting: key } }));
    }
    if (windowsAsk()) document.dispatchEvent(new CustomEvent(EXT_WINDOW_EVENT, { detail: { extId: owner, setting: key } }));
}

/** Whether any registered window has a when(): the doors' extra syncs ask this first. */
export function windowsAsk() {
    for (const w of _chatWindows.values()) if (w.when) return true;
    return false;
}

const _asyncWhenWarned = new Set();

// a when() decides synchronously: one that throws, or answers a promise, says no
function askWhen(spec, what, context) {
    if (!spec.when) return true;
    const shown = callOwner(spec.extId, `${what} when`, () => spec.when(context || {}));
    if (shown && typeof shown.then === 'function') {
        if (!_asyncWhenWarned.has(spec.key)) {
            _asyncWhenWarned.add(spec.key);
            console.error(`[ExtensionHost] ${spec.key} when() returned a promise; it must decide synchronously, so it stays hidden`);
        }
        return false;
    }
    return !!shown;
}

/** Whether one action shows for a context; a throwing when(), or one answering a promise, hides it. */
export function actionShows(a, context) {
    return askWhen(a, `action ${a.slot}/${a.id}`, context);
}

/** Whether one chat window has its doors for the conversation ({ chatId, character }); asked as actionShows asks. */
export function windowShows(w, context) {
    return askWhen(w, `window ${w.id}`, context);
}

/** The actions a surface shows for a context as it opens; a surface handing each action its own context asks actionShows. */
export function actionsFor(slot, context) {
    return getActions(slot).filter(a => actionShows(a, context));
}

// what a lore entry's verbs learn of it, in the book format's names, whichever surface shows it
const LORE_ENTRY_TEXT = ['comment', 'content'];
const LORE_ENTRY_LISTS = ['key', 'keysecondary'];
const LORE_ENTRY_NUMBERS = ['position', 'order'];

/** The lore slot's context: the book, the entry's uid, a frozen copy of the entry, and the lore window's chat. */
export function loreEntryContext(world, entry, chatId = null) {
    const e = entry && typeof entry === 'object' ? entry : {};
    const copy = { uid: e.uid ?? null };
    for (const f of LORE_ENTRY_TEXT) copy[f] = typeof e[f] === 'string' ? e[f] : '';
    for (const f of LORE_ENTRY_LISTS) copy[f] = Object.freeze(Array.isArray(e[f]) ? e[f].map(String) : []);
    copy.constant = !!e.constant;
    copy.disable = !!e.disable;
    for (const f of LORE_ENTRY_NUMBERS) copy[f] = Number.isFinite(Number(e[f])) && e[f] !== null && e[f] !== '' ? Number(e[f]) : null;
    return Object.freeze({ world: String(world ?? ''), uid: copy.uid, entry: Object.freeze(copy), chatId: chatId || null });
}

/** The chat card slot's context: the chat's id, its character's id and a frozen copy of the listed row. */
export function chatCardContext(row) {
    const r = row && typeof row === 'object' ? row : {};
    const count = Number(r.messageCount);
    const last = Number(r.lastMesAt);
    const chat = Object.freeze({
        id: String(r.id ?? ''),
        name: typeof r.name === 'string' ? r.name : '',
        charId: r.charId ? String(r.charId) : null,
        charName: typeof r.charName === 'string' ? r.charName : '',
        messageCount: Number.isFinite(count) ? count : 0,
        lastMesAt: Number.isFinite(last) && last > 0 ? last : null,
    });
    return Object.freeze({ chatId: chat.id, charId: chat.charId, chat });
}

/** Whether any badge is registered: a card build asks this before anything else. */
export function hasBadges() {
    return _badges.size > 0;
}

const _badgeWarned = new Set();

/** The chips a grid card shows for a row, at most BADGES_PER_CARD; a throwing, async or unpaintable answer shows none. */
export function badgesFor(row) {
    const chips = [];
    for (const b of _badges.values()) {
        if (chips.length >= BADGES_PER_CARD) break;
        const out = callOwner(b.extId, `badge ${b.id}`, () => b.render(row));
        if (out == null) continue;
        if (typeof out !== 'object' || typeof out.then === 'function') {
            if (!_badgeWarned.has(b.key)) {
                _badgeWarned.add(b.key);
                console.error(`[ExtensionHost] badge ${b.key} must answer { icon, label, tone } or null, synchronously; its chip stays hidden`);
            }
            continue;
        }
        const icon = ICON_RE.test(String(out.icon || '')) ? out.icon : '';
        const label = String(out.label ?? '').trim().slice(0, 24);
        if (!icon && !label) continue;
        chips.push(Object.freeze({ key: b.key, icon, label, tone: BADGE_TONES.includes(out.tone) ? out.tone : 'neutral' }));
    }
    return chips;
}

/** The details tabs, in registration order: what the strip shows (the key, the label, the icon). */
export function getDetailTabs() {
    return [..._tabs.values()].map(({ key, label, icon }) => ({ key, label, icon }));
}

/**
 * Paint a details tab into its pane; a failure lands in the console and a toast, never the details.
 * @returns {boolean} whether the key named a registered tab
 */
export function renderDetailTab(key, pane, context) {
    const tab = _tabs.get(key);
    if (!tab) return false;
    callOwner(tab.extId, `tab ${tab.id} render`, () => tab.render(pane, context),
        () => CoreAPI.showToast(`${tab.extName}: the "${tab.label}" tab failed; see the console`, 'error'));
    return true;
}

/** The extension views, in registration order: what the nav and the phone's More sheet show. */
export function getViews() {
    return [..._views.values()].map(({ name, label, icon, extName, refresh }) => ({ name, label, icon, extName, refresh: !!refresh }));
}

/**
 * A view's refresh() at the reader's ask (pull-to-refresh); false at once without one, so the pull never arms.
 * @returns {Promise<boolean>} whether a refresh ran
 */
export async function refreshView(name) {
    const view = _views.get(name);
    if (!view?.refresh) return false;
    const failed = () => CoreAPI.showToast(`${view.extName}: the "${view.label}" view failed to refresh; see the console`, 'error');
    await callOwner(view.extId, `view ${view.id} refresh`, () => view.refresh(), failed);
    return true;
}

// name -> a count bumped on every entry and exit, so a render that settles after its view was left
// enters nothing
const _viewVisits = new Map();

/**
 * A view is entered: render(el) on a fresh container, then enter(el) once that settles, skipped if it was left.
 * @returns {boolean} whether the name is a registered view
 */
export function enterView(name, el, { first = false } = {}) {
    const view = _views.get(name);
    if (!view) return false;
    const failed = viewFailed(view);
    const visit = (_viewVisits.get(name) || 0) + 1;
    _viewVisits.set(name, visit);
    const enter = () => {
        if (view.enter && _viewVisits.get(name) === visit) callOwner(view.extId, `view ${view.id} enter`, () => view.enter(el), failed);
    };
    const rendered = first ? callOwner(view.extId, `view ${view.id} render`, () => view.render(el), failed) : undefined;
    if (rendered && typeof rendered.then === 'function') rendered.then(enter, enter);
    else enter();
    return true;
}

/** A view is left: its leave(), contained like enter. @returns {boolean} whether the name is a registered view */
export function leaveView(name) {
    const view = _views.get(name);
    if (!view) return false;
    _viewVisits.set(name, (_viewVisits.get(name) || 0) + 1);
    if (view.leave) callOwner(view.extId, `view ${view.id} leave`, () => view.leave(), viewFailed(view));
    return true;
}

// the toast a view's render, enter or leave gets when it throws or rejects
function viewFailed(view) {
    return () => CoreAPI.showToast(`${view.extName}: the "${view.label}" view failed; see the console`, 'error');
}

/**
 * Run an action by key; a throw or rejection lands in the console and a toast, never the surface.
 * @returns {boolean} whether the key named a registered action
 */
export function runAction(key, context) {
    const slot = String(key || '').split(':')[0];
    const spec = _actions.get(slot)?.get(key) || null;
    if (!spec) return false;
    callOwner(spec.extId, `action ${spec.slot}/${spec.id} run`, () => spec.run(context || {}),
        () => CoreAPI.showToast(`${spec.extName}: "${spec.label}" failed; see the console`, 'error'));
    return true;
}
