// The extension registries: commands, events, hooks and slots, each registration on its owner's
// ledger. No DOM or CoreAPI, so node imports it as is.

import { COMMAND_TYPES, EVENT_TYPES, HOOK_TYPES, SLOT_TYPES } from './ext-contract.js';

export const CORE = 'core';

// doors still answered but on their way out, by manifest kind ("command chat.open", "ctx ui.addAction")
export const DEPRECATED = Object.freeze([]);

// dotted lowercase ids: "chat.open", "hello-world.greet" (an extension id may start with a digit)
const DOTTED_ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

// ========================================
// CONTAINMENT AND TIMING
// ========================================

/**
 * Call into extension code: a failure is logged and handed to onFail; a sync throw answers undefined, a promise comes back as is.
 * @param {string} what names the call in the console line
 * @param {Function} fn the call
 * @param {Function} [onFail] the caller's report, handed the error
 * @returns {*} whatever fn returned
 */
export function guardExtensionCall(what, fn, onFail) {
    const fail = (e) => {
        console.error(`[ExtensionHost] ${what} failed:`, e);
        try { onFail?.(e); } catch { /* a report that throws must not become the failure */ }
    };
    let result;
    try { result = fn(); } catch (e) { fail(e); return undefined; }
    if (result && typeof result.then === 'function') result.then(undefined, fail);
    return result;
}

const SAMPLES = 200;
// owner -> Map(name -> { count, errors, lastError, totalMs, samples })
const _stats = new Map();
// owner -> its dispose count: a call settling after a switch-off records nothing
const _epochs = new Map();

/** Record one timed call an owner made (the host times init itself, since init must throw). */
export function recordOwnerCall(owner, name, ms, error) {
    if (owner === CORE) return;
    if (!_stats.has(owner)) _stats.set(owner, new Map());
    const byName = _stats.get(owner);
    if (!byName.has(name)) byName.set(name, { count: 0, errors: 0, lastError: '', totalMs: 0, samples: [] });
    const s = byName.get(name);
    s.count++;
    s.totalMs += ms;
    s.samples.push(ms);
    if (s.samples.length > SAMPLES) s.samples.shift();
    if (error) { s.errors++; s.lastError = String(error?.message || error); }
}

/**
 * Call into an owner's code: contained like guardExtensionCall and timed to its settle, so the
 * inspector can say what each extension costs and what failed.
 */
export function callOwner(owner, name, fn, onFail) {
    const t0 = performance.now();
    const epoch = _epochs.get(owner) || 0;
    let recorded = false;
    const done = (error) => {
        if (recorded) return;
        recorded = true;
        if ((_epochs.get(owner) || 0) !== epoch) return;
        recordOwnerCall(owner, name, performance.now() - t0, error);
    };
    const result = guardExtensionCall(`${owner} ${name}`, fn, (e) => { done(e); onFail?.(e); });
    if (result && typeof result.then === 'function') result.then(() => done(), () => { /* the guard reported it */ });
    else done();
    return result;
}

/** An owner's calls, costliest first: { name, count, errors, lastError, totalMs, p50, p95 }. */
export function ownerStats(owner) {
    const byName = _stats.get(owner);
    if (!byName) return [];
    return [...byName.entries()].map(([name, s]) => {
        const sorted = [...s.samples].sort((a, b) => a - b);
        const at = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
        return { name, count: s.count, errors: s.errors, lastError: s.lastError, totalMs: s.totalMs, p50: at(0.5), p95: at(0.95) };
    }).sort((a, b) => b.totalMs - a.totalMs);
}

// ========================================
// THE LEDGER
// ========================================

// owner -> [{ kind, id, dispose }] in registration order
const _ledger = new Map();

/**
 * Record how to undo one registration an owner made (the host's registrars use this too).
 * @returns {Function} the release: drops the record without undoing, for a registration its
 *   owner undid itself (an off, an unwrap)
 */
export function trackRegistration(owner, kind, id, dispose) {
    if (owner === CORE) return () => {};
    if (!_ledger.has(owner)) _ledger.set(owner, []);
    const list = _ledger.get(owner);
    const entry = { kind, id: String(id), dispose };
    list.push(entry);
    return () => { const i = list.indexOf(entry); if (i !== -1) list.splice(i, 1); };
}

/** What an owner has registered, in order: [{ kind, id }]. */
export function ownerRegistrations(owner) {
    return (_ledger.get(owner) || []).map(({ kind, id }) => ({ kind, id }));
}

/**
 * Undo everything an owner registered, newest first, each undo contained; the owner's timing
 * goes with it. Answers how many registrations were undone.
 */
export function disposeOwner(owner) {
    const list = _ledger.get(owner) || [];
    _ledger.delete(owner);
    for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i];
        guardExtensionCall(`dispose ${owner} ${r.kind} ${r.id}`, r.dispose);
    }
    _stats.delete(owner);
    _epochs.set(owner, (_epochs.get(owner) || 0) + 1);
    return list.length;
}

// ========================================
// COMMANDS
// ========================================

// id -> { id, fn, owner, title, wrappers: [{ owner, wrapper, priority, override, seq }] }
const _commands = new Map();
// id -> the wrappers of a command whose owner left, waiting for it to come back
const _orphanWrappers = new Map();
let _wrapSeq = 0;

/** Define a command; its owner may define it again (wrappers kept), no other owner may take the id. */
export function defineCommand(id, fn, { title = '', owner = CORE } = {}) {
    if (!DOTTED_ID_RE.test(String(id))) throw new Error(`defineCommand: id "${id}" must be dotted lowercase, like chat.open`);
    if (typeof fn !== 'function') throw new Error(`defineCommand: ${id} needs a function`);
    const existing = _commands.get(id);
    if (existing && existing.owner !== owner) throw new Error(`defineCommand: ${id} belongs to ${existing.owner}`);
    const types = owner === CORE && Object.hasOwn(COMMAND_TYPES, id) ? COMMAND_TYPES[id] : null;
    // a departed owner's wrappers wait under the id and reattach when it defines the command again
    const entry = { id, fn, owner, title: String(title || ''), types, wrappers: existing?.wrappers || _orphanWrappers.get(id) || [] };
    _orphanWrappers.delete(id);
    _commands.set(id, entry);
    trackRegistration(owner, 'command', id, () => {
        if (_commands.get(id) !== entry) return;
        _commands.delete(id);
        if (entry.wrappers.length) _orphanWrappers.set(id, entry.wrappers);
    });
    return id;
}

export function hasCommand(id) {
    return _commands.has(id);
}

/** Every command: { id, title, owner, wrappedBy, args, answers }, the types null for an extension's own. */
export function listCommands() {
    return [..._commands.values()].map(c => ({
        id: c.id, title: c.title, owner: c.owner, wrappedBy: c.wrappers.map(w => w.owner),
        args: c.types?.args ?? null, answers: c.types?.answers ?? null,
    }));
}

/**
 * Wrap a command: wrapper(next, args) hands on, changes the answer, or overrides; higher priority runs outermost.
 * @returns {Function} the unwrap
 */
export function wrapCommand(owner, id, wrapper, { priority = 0, override = false } = {}) {
    const c = _commands.get(id);
    if (!c) throw new Error(`wrapCommand: unknown command ${id}`);
    if (typeof wrapper !== 'function') throw new Error(`wrapCommand: ${id} needs wrapper(next, args)`);
    const w = { owner, wrapper, priority: Number(priority) || 0, override: !!override, seq: ++_wrapSeq };
    c.wrappers.push(w);
    c.wrappers.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    let release = () => {};
    const unwrap = () => {
        const i = c.wrappers.indexOf(w);
        if (i !== -1) c.wrappers.splice(i, 1);
        if (!c.wrappers.length && _orphanWrappers.get(id) === c.wrappers) _orphanWrappers.delete(id);
        release();
    };
    release = trackRegistration(owner, 'wrapper', id, unwrap);
    return unwrap;
}

/** Commands two or more owners declared an override on: { id, owners }. */
export function commandConflicts() {
    return [..._commands.values()]
        .map(c => ({ id: c.id, owners: c.wrappers.filter(w => w.override).map(w => w.owner) }))
        .filter(c => c.owners.length > 1);
}

// a wrapper's answer when the chain below it failed and the error came up through it untouched
const PASSED = Symbol('passed');

/** Run a command through its wrappers; a failing wrapper is stepped over, an error from below passes up uncharged. */
export function runCommand(id, args) {
    const c = _commands.get(id);
    if (!c) throw new Error(`unknown command ${id}`);
    const chain = [...c.wrappers];
    const step = (i, a) => {
        // an extension's own command is contained and timed; a rejection answers undefined like a throw
        if (i >= chain.length) {
            if (c.owner === CORE) return c.fn(a);
            const out = callOwner(c.owner, `command ${id}`, () => c.fn(a));
            return out && typeof out.then === 'function' ? out.then(undefined, () => undefined) : out;
        }
        const w = chain[i];
        let handedOn = false;
        let nextAnswer;
        const below = { failed: false, error: undefined };
        const next = (na) => {
            handedOn = true;
            try { nextAnswer = step(i + 1, na === undefined ? a : na); }
            catch (e) { below.failed = true; below.error = e; throw e; }
            if (nextAnswer && typeof nextAnswer.then === 'function') {
                nextAnswer = nextAnswer.then(undefined, (e) => { below.failed = true; below.error = e; throw e; });
            }
            return nextAnswer;
        };
        const passed = (e) => below.failed && e === below.error;
        const recover = () => (handedOn ? nextAnswer : step(i + 1, a));
        let failed = false;
        const out = callOwner(w.owner, `wrap ${id}`, () => {
            let r;
            try { r = w.wrapper(next, a); } catch (e) { if (passed(e)) return PASSED; throw e; }
            if (r && typeof r.then === 'function') return r.then(undefined, (e) => { if (passed(e)) return PASSED; throw e; });
            return r;
        }, () => { failed = true; });
        if (out === PASSED) throw below.error;
        if (failed) {
            if (below.failed) throw below.error;
            return recover();
        }
        if (out && typeof out.then === 'function') {
            return out.then(
                (v) => { if (v === PASSED) throw below.error; return v; },
                () => (below.failed ? Promise.reject(below.error) : recover()),
            );
        }
        return out;
    };
    return step(0, args);
}

// ========================================
// EVENTS
// ========================================

const EVENT_NAME_RE = /^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/;
// name -> { name, payload, legacy, map, listeners: [{ owner, fn }] }
const _events = new Map();
const _listenerWatchers = new Set();

/** Define an event; its payload (ids) is the contract's where it names one, and legacy + map bridge a DOM event. */
export function defineEvent(name, { payload = null, legacy = null, map = null, dedupe = false } = {}) {
    if (!EVENT_NAME_RE.test(String(name))) throw new Error(`defineEvent: "${name}" must be dotted camelCase, like character.updated`);
    const types = Object.hasOwn(EVENT_TYPES, name) ? EVENT_TYPES[name] : null;
    if (types && payload) throw new Error(`defineEvent: ${name}'s payload is the contract's (ext-contract.js); do not restate it`);
    const existing = _events.get(name);
    _events.set(name, { name, payload: types ? Object.keys(types) : [...(payload || [])], types, legacy, map, dedupe: !!dedupe, listeners: existing?.listeners || [] });
    return name;
}

/** The vocabulary: { name, payload, types, legacy }, types null for an event the contract lacks. */
export function listEvents() {
    return [..._events.values()].map(e => ({ name: e.name, payload: e.payload, types: e.types, legacy: e.legacy }));
}

export function getEvent(name) {
    return _events.get(name) || null;
}

export function hasListeners(name) {
    return (_events.get(name)?.listeners.length || 0) > 0;
}

/** Be told whenever a name gains its first listener or loses its last one. */
export function watchListeners(fn) {
    _listenerWatchers.add(fn);
    return () => _listenerWatchers.delete(fn);
}

function listenersChanged(name) {
    for (const w of _listenerWatchers) guardExtensionCall('event bridge', () => w(name, hasListeners(name)));
}

/** @returns {Function} the off */
export function onEvent(owner, name, fn) {
    const e = _events.get(name);
    if (!e) throw new Error(`onEvent: unknown event ${name} (one of ${[..._events.keys()].join(', ')})`);
    if (typeof fn !== 'function') throw new Error(`onEvent: ${name} needs a listener function`);
    const l = { owner, fn };
    e.listeners.push(l);
    if (e.listeners.length === 1) listenersChanged(name);
    let release = () => {};
    const off = () => {
        const i = e.listeners.indexOf(l);
        if (i === -1) return;
        e.listeners.splice(i, 1);
        release();
        if (!e.listeners.length) listenersChanged(name);
    };
    release = trackRegistration(owner, 'listener', name, off);
    return off;
}

export function emitEvent(name, detail) {
    const e = _events.get(name);
    if (!e) throw new Error(`emitEvent: unknown event ${name}`);
    for (const l of [...e.listeners]) callOwner(l.owner, `event ${name}`, () => l.fn(detail));
}

/** Emit a frozen payload, its lists and objects frozen copies, only while someone listens. */
export function fireEvent(name, detail) {
    if (!hasListeners(name)) return;
    const out = {};
    for (const [k, v] of Object.entries(detail || {})) out[k] = v && typeof v === 'object' ? Object.freeze(Array.isArray(v) ? [...v] : { ...v }) : v;
    emitEvent(name, Object.freeze(out));
}

// ========================================
// HOOKS
// ========================================

const HOOK_KINDS = Object.freeze(['filter', 'action']);
// name -> { name, kind, shape, entries: [{ owner, fn, priority, seq }] }
const _hooks = new Map();
const _hookWatchers = new Set();
let _hookSeq = 0;

/** Define a hook; a filter answer failing shape(answer) is stepped over like a throw, and only an async filter may answer a promise. */
export function defineHook(name, { kind = 'filter', shape = null, async = false } = {}) {
    if (!DOTTED_ID_RE.test(String(name))) throw new Error(`defineHook: "${name}" must be dotted lowercase, like prompt.final`);
    if (!HOOK_KINDS.includes(kind)) throw new Error(`defineHook: ${name} kind must be one of ${HOOK_KINDS.join(', ')}`);
    if (shape !== null && typeof shape !== 'function') throw new Error(`defineHook: ${name} shape must be a function`);
    if (async && kind !== 'filter') throw new Error(`defineHook: ${name} is an action; only a filter waits`);
    const existing = _hooks.get(name);
    const types = Object.hasOwn(HOOK_TYPES, name) ? HOOK_TYPES[name] : null;
    _hooks.set(name, { name, kind, shape, async: !!async, types, entries: existing?.entries || [] });
    return name;
}

/** Be told whenever a hook gains or loses an entry: what it produces may have changed. */
export function watchHooks(fn) {
    _hookWatchers.add(fn);
    return () => _hookWatchers.delete(fn);
}

function hooksChanged(name) {
    for (const w of _hookWatchers) guardExtensionCall('hook watch', () => w(name));
}

/** Every hook: { name, kind, async, owners, value, context, answer }, the types null where the contract lacks the hook. */
export function listHooks() {
    return [..._hooks.values()].map(h => ({
        name: h.name, kind: h.kind, async: h.async, owners: h.entries.map(e => e.owner),
        value: h.types?.value ?? null, context: h.types?.context ?? null, answer: h.types?.answer ?? null,
    }));
}

/** The guard every hook site asks first: nothing registered, nothing built, nothing run. */
export function hasHook(name) {
    return (_hooks.get(name)?.entries.length || 0) > 0;
}

/** @returns {Function} the removal */
export function addHook(owner, name, fn, { priority = 0 } = {}) {
    const h = _hooks.get(name);
    if (!h) throw new Error(`addHook: unknown hook ${name} (one of ${[..._hooks.keys()].join(', ') || 'none yet'})`);
    if (typeof fn !== 'function') throw new Error(`addHook: ${name} needs a function`);
    const e = { owner, fn, priority: Number(priority) || 0, seq: ++_hookSeq };
    h.entries.push(e);
    h.entries.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    let release = () => {};
    const remove = () => {
        const i = h.entries.indexOf(e);
        if (i === -1) return;
        h.entries.splice(i, 1);
        release();
        hooksChanged(name);
    };
    release = trackRegistration(owner, 'hook', name, remove);
    hooksChanged(name);
    return remove;
}

/** Pass a value through a filter hook; a throw, a promise or a wrong shape fails, and its input passes on. */
export function runFilter(name, value, ctx) {
    const h = _hooks.get(name);
    if (!h || !h.entries.length) return value;
    let v = value;
    for (const e of [...h.entries]) {
        let failed = false;
        const out = callOwner(e.owner, `hook ${name}`, () => {
            const answer = e.fn(v, ctx);
            // a promise or a wrong shape counts as the filter failing, so the inspector names it
            if (answer && typeof answer.then === 'function') {
                answer.then(undefined, () => {});
                throw new Error(`${name} answered a promise; a filter answers synchronously, its input passed on`);
            }
            if (h.shape && answer !== undefined && !h.shape(answer)) {
                throw new Error(`${name} answered the wrong shape; its input passed on`);
            }
            return answer;
        }, () => { failed = true; });
        if (failed) continue;
        if (out !== undefined) v = out;
    }
    return v;
}

/** Pass a value through an async filter hook, each awaited in priority order; a failure passes its input on. */
export async function runFilterAsync(name, value, ctx) {
    const h = _hooks.get(name);
    if (!h || !h.entries.length) return value;
    let v = value;
    for (const e of [...h.entries]) {
        let failed = false;
        let out;
        try {
            out = await callOwner(e.owner, `hook ${name}`, async () => {
                const answer = await e.fn(v, ctx);
                if (h.shape && answer !== undefined && !h.shape(answer)) throw new Error(`${name} answered the wrong shape; its input passed on`);
                return answer;
            }, () => { failed = true; });
        } catch { failed = true; }
        if (!failed && out !== undefined) v = out;
    }
    return v;
}

/** Tell every action hook, highest priority first; each call is contained. */
export function runActions(name, ctx) {
    const h = _hooks.get(name);
    if (!h || !h.entries.length) return;
    for (const e of [...h.entries]) callOwner(e.owner, `hook ${name}`, () => e.fn(ctx));
}

// ========================================
// SLOTS
// ========================================

export const SLOT_KINDS = Object.freeze(['action', 'window', 'section', 'badge', 'tab', 'field', 'view']);
const PHONE_MODES = Object.freeze(['same', 'mirror', 'none']);
// id -> { id, kind, context, types, spec, phone, reason, title }
const _slots = new Map();

/** Declare a place an extension may fill; phone is same, mirror (built at open time) or none with its reason. */
export function defineSlot({ id, kind, context = null, phone, reason = '', title = '' } = {}) {
    if (!DOTTED_ID_RE.test(String(id))) throw new Error(`defineSlot: id "${id}" must be dotted lowercase, like chat.action`);
    if (!SLOT_KINDS.includes(kind)) throw new Error(`defineSlot: ${id} kind must be one of ${SLOT_KINDS.join(', ')}`);
    if (!PHONE_MODES.includes(phone)) throw new Error(`defineSlot: ${id} phone must be one of ${PHONE_MODES.join(', ')}`);
    if (phone === 'none' && !String(reason).trim()) throw new Error(`defineSlot: ${id} says the phone has none, so it needs the reason`);
    const types = Object.hasOwn(SLOT_TYPES, id) ? SLOT_TYPES[id] : null;
    if (types && context) throw new Error(`defineSlot: ${id}'s context is the contract's (ext-contract.js); do not restate it`);
    _slots.set(id, Object.freeze({
        id, kind, context: Object.freeze(types ? Object.keys(types.context) : [...(context || [])]),
        types: types?.context ?? null, spec: types?.spec ?? null, phone, reason: String(reason), title: String(title),
    }));
    return id;
}

export function getSlot(id) {
    return _slots.get(id) || null;
}

export function listSlots() {
    return [..._slots.values()];
}
