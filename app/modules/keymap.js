// The keymap: every rebindable shortcut declared once, the user's own keys (one settings row) over the defaults.

const SETTING = 'keybindings';
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const MODIFIERS = ['Mod', 'Ctrl', 'Alt', 'Shift'];

/** Where a shortcut works: an action's keys clash only with those of its own place and Everywhere. */
export const SCOPES = Object.freeze([
    { id: 'global', label: 'Everywhere' },
    { id: 'library', label: 'Library' },
    { id: 'conversation', label: 'Conversation' },
    { id: 'chatGallery', label: 'Chat Gallery' },
    { id: 'viewer', label: 'Image viewer' },
]);
// the places an extension's key may name; it runs there while that place is in front
export const EXTENSION_SCOPES = Object.freeze(['global', 'library', 'conversation']);

// aliases answer only while the action keeps its default: a rebinding replaces them too
const CORE = [
    { id: 'palette.toggle', scope: 'global', label: 'Search everything', key: 'Backquote' },
    { id: 'library.selectionMode', scope: 'library', label: 'Selection mode', key: 'Space' },
    { id: 'conversation.focusInput', scope: 'conversation', label: 'Write a message', key: '/' },
    { id: 'conversation.latest', scope: 'conversation', label: 'Jump to the latest message', key: 'End' },
    { id: 'conversation.regenerate', scope: 'conversation', label: 'Regenerate', key: 'R' },
    { id: 'conversation.continue', scope: 'conversation', label: 'Continue', key: 'C' },
    { id: 'conversation.impersonate', scope: 'conversation', label: 'Impersonate', key: 'I' },
    { id: 'conversation.editLast', scope: 'conversation', label: 'Edit the last message', key: 'E' },
    { id: 'conversation.stop', scope: 'conversation', label: 'Stop generating', key: 'Shift+Escape' },
    { id: 'chatGallery.grid', scope: 'chatGallery', label: 'Grid or single image', key: 'G' },
    { id: 'chatGallery.search', scope: 'chatGallery', label: 'Search the grid', key: '/' },
    { id: 'chatGallery.viewer', scope: 'chatGallery', label: 'Full screen', key: 'F' },
    { id: 'chatGallery.background', scope: 'chatGallery', label: 'Set as background', key: 'B' },
    { id: 'chatGallery.attach', scope: 'chatGallery', label: 'Attach to the next message', key: 'A' },
    { id: 'chatGallery.notes', scope: 'chatGallery', label: 'Notes', key: 'N' },
    { id: 'chatGallery.zoomIn', scope: 'chatGallery', label: 'Zoom in', key: '+', aliases: ['='] },
    { id: 'chatGallery.zoomOut', scope: 'chatGallery', label: 'Zoom out', key: '-', aliases: ['_'] },
    { id: 'chatGallery.zoomReset', scope: 'chatGallery', label: 'Reset zoom', key: '0' },
    { id: 'viewer.zoomReset', scope: 'viewer', label: 'Reset zoom', key: '0' },
];

// id -> { id, scope, label, key, aliases, owner?, ownerName?, run? }
const actions = new Map(CORE.map(a => [a.id, Object.freeze({ ...a, aliases: a.aliases || [] })]));
const listeners = new Set();

// what the keymap reads of the app, handed over by the module loader; a node test or the extension kit hands its own
let app = { getSetting: () => undefined, setSetting: () => {}, view: () => null, overlayOpen: () => false };

/** Hand the keymap the app's settings, its view and whether a layer is open over it. */
export function configure(next) {
    app = { ...app, ...next };
}

// ========================================
// KEYS AS TEXT
// ========================================

const NAMED = { ' ': 'Space', Spacebar: 'Space', Esc: 'Escape', Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown', Del: 'Delete' };
const isLetter = (k) => k.length === 1 && k.toLowerCase() !== k.toUpperCase();
// a printed character other than a letter already says its shift (a "+" is a shifted "=" on one layout and not on another)
const shiftInKey = (k) => k.length === 1 && !isLetter(k) && k !== ' ';

/** A key's one spelling: modifiers in order, a letter in capitals, a named key as the browser names it; null for no key. */
export function normalize(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    // a "+" is a key of its own: split on the plus signs that join, keeping a final "+"
    const parts = text.trim() === '+' ? ['+'] : text.trim().split(/\+(?!$)/).map(p => p.trim()).filter(Boolean);
    const mods = new Set();
    let key = null;
    for (const p of parts) {
        const m = MODIFIERS.find(x => x.toLowerCase() === p.toLowerCase()) || ({ cmd: 'Mod', meta: 'Mod', control: 'Ctrl', option: 'Alt' })[p.toLowerCase()];
        if (m && key === null && parts.length > 1) { mods.add(m); continue; }
        if (key !== null) return null;
        key = NAMED[p] || p;
    }
    if (!key || MODIFIERS.includes(key)) return null;
    if (key.length === 1) key = key.toUpperCase();
    else if (!/^(?:[A-Z][A-Za-z]*\d*|F\d{1,2})$/.test(key)) return null;
    // only a Mac tells Ctrl from Cmd: elsewhere they are one key
    if (!MAC && mods.has('Ctrl')) { mods.delete('Ctrl'); mods.add('Mod'); }
    if (shiftInKey(key)) mods.delete('Shift');
    return [...MODIFIERS.filter(m => mods.has(m)), key].join('+');
}

/** The key an event pressed, spelled as normalize spells it; null for a modifier alone or a key the browser could not name. */
export function comboOf(e) {
    let key = NAMED[e.key] || e.key;
    if (!key || key === 'Unidentified' || key === 'Process' || key === 'Dead' || ['Control', 'Meta', 'Alt', 'Shift', 'OS', 'AltGraph', 'CapsLock'].includes(key)) return null;
    // off a Mac the Windows key belongs to the system
    if (!MAC && e.metaKey) return null;
    // a character typed through AltGr (Ctrl+Alt to Windows) or Option on a Mac already says that key, as a shifted one does
    const altGr = key.length === 1 && !!e.getModifierState?.('AltGraph');
    const optionChar = MAC && e.altKey && shiftInKey(key);
    const mods = [];
    if (MAC ? e.metaKey : e.ctrlKey && !altGr) mods.push('Mod');
    if (MAC && e.ctrlKey) mods.push('Ctrl');
    if (e.altKey && !altGr && !optionChar) mods.push('Alt');
    if (e.shiftKey && !shiftInKey(key)) mods.push('Shift');
    return normalize([...mods, key].join('+'));
}

// the key under Esc by its place on any layout; an Apple ISO keyboard reports it as IntlBackslash
const PLACES = { Backquote: MAC ? ['Backquote', 'IntlBackslash'] : ['Backquote'] };
// a Japanese keyboard's input-mode toggle sits there too: the IME's own press, never the shortcut
const IME_KEYS = new Set(['Process', 'Hankaku', 'Zenkaku', 'ZenkakuHankaku', 'HankakuZenkaku']);

/** The key an event pressed by its place, for a key bound by place; null for a key that has none. */
export function positionComboOf(e) {
    const place = Object.keys(PLACES).find(p => PLACES[p].includes(e.code));
    if (!place || (!MAC && e.metaKey) || IME_KEYS.has(e.key)) return null;
    const altGr = !!e.getModifierState?.('AltGraph');
    const mods = [];
    if (MAC ? e.metaKey : e.ctrlKey && !altGr) mods.push('Mod');
    if (MAC && e.ctrlKey) mods.push('Ctrl');
    if (e.altKey && !altGr) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    // AltGr types a character of its own there: no shortcut of this key's
    return altGr ? null : normalize([...mods, place].join('+'));
}

const LABELS = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', PageUp: 'Page Up', PageDown: 'Page Down', Space: 'Space' };
const MAC_LABELS = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
const PLACE_LABEL_KEY = 'clKeyUnderEscCap';
// what this layout prints on the key under Esc: the browser's keyboard map, else a plain press of it, else the US cap
let placeLabel = (() => { try { return localStorage.getItem(PLACE_LABEL_KEY) || '`'; } catch { return '`'; } })();

function setPlaceLabel(label) {
    if (!label || label === placeLabel) return;
    placeLabel = label;
    try { localStorage.setItem(PLACE_LABEL_KEY, label); } catch { /* storage off: the cap holds for this tab */ }
    for (const fn of listeners) fn();
}

/** Learn the key under Esc's cap from a plain press of it (a shifted press or a dead key says nothing). */
export function learnPlaceLabel(e) {
    if (!PLACES.Backquote.includes(e.code) || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    if (typeof e.key === 'string' && [...e.key].length === 1) setPlaceLabel(e.key);
}

if (typeof navigator !== 'undefined' && navigator.keyboard?.getLayoutMap) {
    navigator.keyboard.getLayoutMap().then((map) => setPlaceLabel((MAC && map.get('IntlBackslash')) || map.get('Backquote'))).catch(() => { /* no layout map here: a press of the key teaches the cap */ });
}

/** A key as the caps that show it: ['Ctrl', 'K'], or ['⌘', 'K'] on a Mac. */
export function capsOf(combo) {
    if (!combo) return [];
    const parts = combo === '+' ? ['+'] : combo.split(/\+(?!$)/);
    return parts.map(p => (MAC ? MAC_LABELS[p] : null) || (p === 'Mod' ? 'Ctrl' : Object.hasOwn(PLACES, p) ? placeLabel : LABELS[p] || p));
}

// keys with jobs of their own everywhere (closing, sending, focus, the arrows' walks): never a shortcut's bare key
const RESERVED = new Set(['Escape', 'Enter', 'Tab', 'Backspace', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
/** Whether a key keeps its own job and can be no shortcut's: Esc, Enter, Tab, Backspace and the arrows, pressed alone. */
export const isReserved = (combo) => RESERVED.has(normalize(combo) ?? '');

// a key that may fire in a field: one held with Mod, Ctrl or Alt, Escape, or a function key
const fieldSafe = (combo) => /^(?:Mod|Ctrl|Alt)\+/.test(combo) || /(?:^|\+)(?:Escape|F\d{1,2})$/.test(combo);
const inField = (e) => !!e.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');

// ========================================
// BINDINGS
// ========================================

function overrides() {
    const raw = app.getSetting(SETTING);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/** An action's key: the user's own while it is a key (an empty one unbinds it), else the default; null when unbound. */
export function bindingOf(id) {
    const action = actions.get(id);
    if (!action) return null;
    const own = overrides()[id];
    if (own === '') return null;
    return (typeof own === 'string' && normalize(own)) || normalize(action.key);
}

const isDefault = (id) => bindingOf(id) === normalize(actions.get(id)?.key);

/** Whether an event presses an action's key, a single key never while the reader types in a field. */
export function is(e, id) {
    const binding = bindingOf(id);
    if (!binding || e.isComposing) return false;
    // a key bound by its place answers that place on any layout, a dead key's included
    const placed = positionComboOf(e);
    if (placed && placed === binding) return fieldSafe(placed) || !inField(e);
    const combo = comboOf(e);
    if (!combo) return false;
    const hit = combo === binding || (isDefault(id) && actions.get(id).aliases.some(a => normalize(a) === combo));
    return hit && (fieldSafe(combo) || !inField(e));
}

const overlaps = (a, b) => a === b || a === 'global' || b === 'global';
// a key bound by its place is the same key as the character that place prints on this layout
const spelledAt = (combo) => combo && normalize(combo.split('+').map(p => (Object.hasOwn(PLACES, p) ? placeLabel : p)).join('+'));
const sameKey = (a, b) => !!a && !!b && (a === b || spelledAt(a) === spelledAt(b));

/** The other actions a key would clash with where this one works. */
export function clashesOf(id, combo) {
    const action = actions.get(id);
    const key = normalize(combo);
    if (!action || !key) return [];
    return [...actions.values()].filter(a => a.id !== id && overlaps(a.scope, action.scope) && sameKey(bindingOf(a.id), key)).map(a => a.id);
}

function writeOverrides(next) {
    const clean = {};
    for (const [id, v] of Object.entries(next)) {
        const action = actions.get(id);
        // a stored key equal to the default is no override; an unknown id stays, for an extension switched off
        if (action && v !== '' && normalize(v) === normalize(action.key)) continue;
        if (v === '' || normalize(v)) clean[id] = v === '' ? '' : normalize(v);
    }
    app.setSetting(SETTING, clean);
    for (const fn of listeners) fn();
}

/** Rebind an action: a key, '' to unbind it, null for its default. Answers its key now. */
export function setBinding(id, combo) {
    if (!actions.has(id)) throw new Error(`keymap: no action ${id}`);
    const next = { ...overrides() };
    if (combo === null || combo === undefined) delete next[id];
    else if (combo === '') next[id] = '';
    else {
        const key = normalize(combo);
        if (!key) throw new Error(`keymap: "${combo}" is not a key`);
        if (RESERVED.has(key)) throw new Error(`keymap: ${key} keeps its own job`);
        next[id] = key;
    }
    writeOverrides(next);
    return bindingOf(id);
}

/** A clash answered with a swap: the action takes the key, and every action it clashed with takes the old one. */
export function takeKey(id, combo) {
    const key = normalize(combo);
    if (!actions.has(id) || !key) throw new Error(`keymap: no action ${id}, or "${combo}" is no key`);
    if (RESERVED.has(key)) throw new Error(`keymap: ${key} keeps its own job`);
    const mine = bindingOf(id);
    const next = { ...overrides(), [id]: key };
    for (const other of clashesOf(id, key)) next[other] = mine ?? '';
    writeOverrides(next);
}

/** Every action back on its default (an extension switched off keeps nothing either). */
export function resetAll() {
    writeOverrides({});
}

/** Told after every write through here. Answers its removal. */
export function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/** Every action, the app's own first in their places, then each extension's: its key now and its default. */
export function list() {
    return [...actions.values()].map(a => ({
        id: a.id, scope: a.scope, label: a.label, owner: a.owner || null, ownerName: a.ownerName || null,
        key: bindingOf(a.id), defaultKey: normalize(a.key), aliases: a.aliases.map(normalize),
    }));
}

/** The app's own defaults, for the guide's tables and its checks. */
export const DEFAULTS = Object.freeze(CORE.map(a => Object.freeze({ id: a.id, scope: a.scope, label: a.label, key: normalize(a.key), aliases: (a.aliases || []).map(normalize) })));

// ========================================
// AN EXTENSION'S KEYS
// ========================================

/** An extension's action, run on its key while its place is in front; a taken key or id is refused by name. Answers its removal. */
export function defineKey({ id, label, key, scope = 'global', run, owner, ownerName }) {
    if (!id || actions.has(id)) throw new Error(`keys.register: "${id}" is taken`);
    if (!EXTENSION_SCOPES.includes(scope)) throw new Error(`keys.register: scope is one of ${EXTENSION_SCOPES.join(', ')}`);
    if (typeof run !== 'function') throw new Error('keys.register needs run()');
    const combo = key === null || key === undefined || key === '' ? null : normalize(key);
    if (key && !combo) throw new Error(`keys.register: "${key}" is not a key`);
    if (combo && RESERVED.has(combo)) throw new Error(`keys.register: ${combo} keeps its own job`);
    if (combo) {
        const clash = [...actions.values()].find(a => overlaps(a.scope, scope) && (sameKey(normalize(a.key), combo) || sameKey(bindingOf(a.id), combo)));
        if (clash) throw new Error(`keys.register: ${capsOf(combo).join('+')} is ${clash.owner ? `${clash.ownerName || clash.owner}'s` : 'the app\'s'} "${clash.label}" (${clash.id})`);
    }
    const action = Object.freeze({ id, scope, label: String(label || id), key: combo || '', aliases: [], owner, ownerName, run });
    actions.set(id, action);
    for (const fn of listeners) fn();
    return () => {
        if (actions.get(id) !== action) return;
        actions.delete(id);
        for (const fn of listeners) fn();
    };
}

// the places an extension's key can be in front of
const SCOPE_ACTIVE = {
    global: () => true,
    library: () => app.view() === 'characters' && !app.overlayOpen(),
    // a conversation presents under this class; parked, it has none
    conversation: () => document.documentElement.classList.contains('cl-chat-open'),
};

function dispatchExtensionKeys(e) {
    if (e.defaultPrevented || e.repeat) return;
    for (const a of actions.values()) {
        if (!a.run || !SCOPE_ACTIVE[a.scope]?.() || !is(e, a.id)) continue;
        e.preventDefault();
        a.run();
        return;
    }
}

let installed = false;
/** The one listener for the extensions' keys; the app's own handlers ask is() themselves. */
export function install() {
    if (installed || typeof document === 'undefined') return;
    installed = true;
    document.addEventListener('keydown', dispatchExtensionKeys);
}

// ========================================
// A HARDWARE KEYBOARD ON A PHONE
// ========================================

let sawKeyboard = false;
/** Whether a real key was pressed in this tab outside a field: a phone shows the Keyboard settings once one was. */
export function keyboardSeen() {
    return sawKeyboard;
}
if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (e) => {
        if (!sawKeyboard && !inField(e) && (comboOf(e) || positionComboOf(e))) sawKeyboard = true;
        learnPlaceLabel(e);
    }, { capture: true, passive: true });
}

export const scopeOf = (id) => actions.get(id)?.scope ?? null;
export const SCOPE_LABEL = Object.freeze(Object.fromEntries(SCOPES.map(s => [s.id, s.label])));

export default { configure, isReserved, SCOPES, EXTENSION_SCOPES, DEFAULTS, normalize, comboOf, positionComboOf, learnPlaceLabel, capsOf, bindingOf, is, clashesOf, setBinding, takeKey, resetAll, onChange, list, defineKey, install, keyboardSeen, scopeOf, SCOPE_LABEL };
