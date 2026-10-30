// Extension code on the server's write path: guards, filters, macros, prompt blocks, connection
// kinds and listeners. With none registered a write pays nothing.
import { performance } from 'node:perf_hooks';
import { runWithReader } from './reader-context.js';
import { setCommitGuard, subscribeChanges, runWithRequest, ownerOf, SERVER_SCOPE, CHANGE_VOCABULARY, LIBRARY_WRITE_ENTITIES } from '../db/changes.js';
import { setHookRunner, setRegistryRunner } from '../db/hook-seat.js';
import { BUILTIN_MACROS, macroDefinition } from '../llm/macros.js';
import { normalizeParams } from '../llm/params.js';
import { getAdapter } from '../llm/registry.js';
import { extensionEnabledFor, accountLive } from './extensions.js';
import { assertSlugId } from './ext-contract.js';

// the names a guard may take, one per (entity, op) a library write reports
const GUARD_NAMES = new Set(LIBRARY_WRITE_ENTITIES.flatMap(entity => CHANGE_VOCABULARY[entity].map(op => `store.before.${entity}.${op}`)));
const LISTENER = 'events.on';
const SAMPLES = 200;

// hook name -> [{ owner, row, fn, priority, seq }], highest priority first
const _guards = new Map();
// pipeline name -> [{ owner, row, fn, priority, seq }], highest priority first
const _filters = new Map();
// macro name -> { owner, row, fn }
const _macros = new Map();
// "<owner>/<id>" -> { owner, row, id, role, position, depth, order, text }, in registration order
const _blocks = new Map();
// [{ owner, row, fn }] in registration order
const _listeners = [];
// connection kind -> { owner, row, kind, meta, source }, registered through ctx.llm.registerAdapter
const _adapters = new Map();
// owner -> account -> name -> { count, errors, refused, lastError, totalMs, samples }
const _stats = new Map();
const _asyncWarned = new Set();
let _seq = 0;
let _unsubscribe = null;

/** What ctx.refuse throws: the write rolls back and the route answers 400 in these words. */
export class ExtensionRefusal extends Error {
    constructor(message, owner) {
        super(String(message || 'refused by an extension'));
        this.name = 'ExtensionRefusal';
        this.statusCode = 400;
        this.extension = owner;
    }
}

// ========================================
// TIMING
// ========================================

/** A thrown value as one line, whatever it is; never itself throws (a null-prototype object has no string form). */
export function describeError(error) {
    if (error === undefined || error === null || error === '') return 'rejected with no reason';
    try { return String(error?.message || error); } catch { return Object.prototype.toString.call(error); }
}

/** Count one call an extension made or answered, for one account; any `error` key counts, a thrown undefined too. */
export function recordCall(owner, user, name, ms, opts = {}) {
    const { refused = false } = opts;
    let byUser = _stats.get(owner);
    if (!byUser) _stats.set(owner, byUser = new Map());
    let byName = byUser.get(user);
    if (!byName) byUser.set(user, byName = new Map());
    let s = byName.get(name);
    if (!s) byName.set(name, s = { count: 0, errors: 0, refused: 0, lastError: '', totalMs: 0, samples: [] });
    s.count++;
    s.totalMs += ms;
    s.samples.push(ms);
    if (s.samples.length > SAMPLES) s.samples.shift();
    if (refused) s.refused++;
    if ('error' in opts) { s.errors++; s.lastError = describeError(opts.error); }
}

/** One account's view of an extension's server calls, costliest first; never another account's. */
export function serverHookStats(owner, user) {
    const byName = _stats.get(owner)?.get(user);
    if (!byName) return [];
    return [...byName.entries()].map(([name, s]) => {
        const sorted = [...s.samples].sort((a, b) => a - b);
        const at = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
        return { name, count: s.count, errors: s.errors, refused: s.refused, lastError: s.lastError, totalMs: s.totalMs, p50: at(0.5), p95: at(0.95) };
    }).sort((a, b) => b.totalMs - a.totalMs);
}

/** Drop one account's counts from every extension (its admin deleted it). */
export function forgetAccountStats(user) {
    for (const byUser of _stats.values()) byUser.delete(user);
}

/** What an extension's server half registered, as the inspector lists registrations: { kind, id }. */
export function serverHookRegistrations(owner) {
    // in the order this extension registered them, whatever order other extensions took the names in
    const own = (map) => [...map].flatMap(([name, list]) => list.filter(x => x.owner === owner).slice(0, 1).map(x => [name, x.seq]))
        .sort((a, b) => a[1] - b[1]).map(([name]) => name);
    const out = [];
    for (const name of own(_guards)) out.push({ kind: 'server hook', id: name });
    for (const name of own(_filters)) out.push({ kind: 'server filter', id: name });
    for (const [name, m] of _macros) if (m.owner === owner) out.push({ kind: 'server macro', id: name });
    for (const b of _blocks.values()) if (b.owner === owner) out.push({ kind: 'server prompt block', id: b.id });
    for (const a of _adapters.values()) if (a.owner === owner) out.push({ kind: 'server connection kind', id: a.kind });
    if (_listeners.some(l => l.owner === owner)) out.push({ kind: 'server events', id: LISTENER });
    return out;
}

// ========================================
// THE WALK
// ========================================

// whether each entry's extension is on for db's account, read once a run; a closed library serves nobody
function enabledMemo(db) {
    const seen = new Map();
    return (entry) => {
        if (!seen.has(entry.owner)) {
            let on = false;
            try { on = extensionEnabledFor(db, entry.row); } catch { /* a closed library serves nobody */ }
            seen.set(entry.owner, on);
        }
        return seen.get(entry.owner);
    };
}

// the account's enabled entries, the facts built at the first ask (their getters cost a lore scan)
function* enabledEntries(entries, info) {
    const db = info?.db;
    const user = ownerOf(db);
    if (!user || user === SERVER_SCOPE) return;
    const on = enabledMemo(db);
    let facts = null;
    const factsOf = () => (facts ??= Object.freeze({ ...info, user }));
    for (const entry of entries) if (on(entry)) yield { entry, user, facts: factsOf };
}

// one call into an extension, timed and contained; a throw is logged in failed's words, when given
function timedCall(entry, user, name, failed, fn) {
    const t0 = performance.now();
    try {
        const value = fn();
        return { ok: true, value, ms: performance.now() - t0 };
    } catch (e) {
        recordCall(entry.owner, user, name, performance.now() - t0, { error: e });
        if (failed) console.error(`[ext:${entry.owner}] ${failed}:`, e);
        return { ok: false };
    }
}

// the filters' and blocks' walk: each enabled entry called now, the facts built inside the call so
// a getter that throws is charged to it
function* enabledCalls(entries, info, { label, failed, call }) {
    for (const { entry, user, facts } of enabledEntries(entries, info)) {
        const name = label(entry);
        const t = timedCall(entry, user, name, failed(entry), () => call(entry, facts()));
        if (t.ok) yield { entry, value: t.value, ms: t.ms, user, name };
    }
}

// a promise where a value was due: nothing awaits it, so its rejection is silenced here
function refusedPromise(v) {
    if (!v || typeof v.then !== 'function') return false;
    v.then(undefined, () => {});
    return true;
}

// ========================================
// STORE GUARDS
// ========================================

// a guard reads the record it is handed, never edits the one the feed delivers
function frozenRecord(rec) {
    const copy = structuredClone(rec);
    for (const v of Object.values(copy)) if (v && typeof v === 'object') Object.freeze(v);
    return Object.freeze(copy);
}

function syncSeats() {
    setCommitGuard(_guards.size ? runGuards : null);
    setHookRunner(_filters.size ? runFilters : null);
    setRegistryRunner(_macros.size || _blocks.size || _adapters.size ? runRegistries : null);
    if (_listeners.length && !_unsubscribe) _unsubscribe = subscribeChanges(deliverToListeners);
    else if (!_listeners.length && _unsubscribe) { _unsubscribe(); _unsubscribe = null; }
}

// a guard or a filter into its table, highest priority first and ties in registration order; answers its removal
function addOrdered(table, name, row, fn, priority) {
    const e = { owner: row.id, row, fn, priority: Number(priority) || 0, seq: ++_seq };
    const list = table.get(name) || [];
    list.push(e);
    list.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    table.set(name, list);
    syncSeats();
    return () => {
        const at = table.get(name)?.indexOf(e) ?? -1;
        if (at === -1) return;
        table.get(name).splice(at, 1);
        if (!table.get(name).length) table.delete(name);
        syncSeats();
    };
}

/**
 * Register a store guard: fn(record, { db, user }) runs after the write, before its commit, synchronously.
 * @param {object} row the extension's inventory row
 * @returns {Function} the removal
 */
export function addGuard(row, name, fn, { priority = 0 } = {}) {
    if (!GUARD_NAMES.has(String(name))) {
        const entity = /^store\.before\.([A-Za-z]+)\./.exec(String(name))?.[1];
        const ops = LIBRARY_WRITE_ENTITIES.includes(entity) ? CHANGE_VOCABULARY[entity] : null;
        throw new Error(ops
            ? `hooks.add: "${name}" never fires; ${entity} is reported as ${ops.join(', ')}`
            : `hooks.add: "${name}" is not a store guard; the names are store.before.<entity>.<op>, entity one of ${[...new Set([...GUARD_NAMES].map(n => n.split('.')[2]))].join(', ')}`);
    }
    if (typeof fn !== 'function') throw new Error(`hooks.add: ${name} needs a function`);
    return addOrdered(_guards, name, row, fn, priority);
}

function callGuard(g, name, rec, info) {
    const t0 = performance.now();
    let out;
    try {
        out = g.fn(rec, info);
    } catch (e) {
        if (e instanceof ExtensionRefusal) {
            recordCall(g.owner, info.user, name, performance.now() - t0, { refused: true });
            throw e;
        }
        recordCall(g.owner, info.user, name, performance.now() - t0, { error: e });
        console.error(`[ext:${g.owner}] ${name} failed; the write goes ahead:`, e);
        return;
    }
    recordCall(g.owner, info.user, name, performance.now() - t0);
    if (out && typeof out.then === 'function') {
        out.then(undefined, (e) => console.error(`[ext:${g.owner}] ${name} rejected, too late to refuse its write:`, e));
        const key = `${g.owner} ${name}`;
        if (!_asyncWarned.has(key)) {
            _asyncWarned.add(key);
            console.error(`[ext:${g.owner}] ${name}: a store guard must answer synchronously; a promise cannot refuse a write`);
        }
    }
}

// the commit seat (changes.js): every record the outermost transaction produced, before COMMIT
function runGuards(user, records, db) {
    if (user === SERVER_SCOPE) return;
    const enabled = enabledMemo(db);
    // a snapshot: a guard that writes anyway must not grow the list being walked
    for (const rec of [...records]) {
        const name = `store.before.${rec.entity}.${rec.op}`;
        const list = _guards.get(name);
        if (!list) continue;
        // an account without a guard's extension on pays for no copy of the record
        const on = list.filter(g => enabled(g));
        if (!on.length) continue;
        const view = frozenRecord(rec);
        for (const g of on) callGuard(g, name, view, { db, user });
    }
}

// ========================================
// PIPELINE FILTERS
// ========================================

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// what a macro or a block may answer as its text
const isText = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const isLoreEntry = (e) => isPlainObject(e) && typeof e.content === 'string' && (typeof e.uid === 'number' || typeof e.uid === 'string');
/** The lore engine's placed groups, in the order lore.activate hands them (the outlet entries beside them). */
const LORE_GROUPS = Object.freeze(['before', 'after', 'atDepth', 'emBefore', 'emAfter']);
const isPlaced = (c) => isPlainObject(c) && typeof c.world === 'string' && typeof c.content === 'string';
const MESSAGE_ROLES = ['system', 'user', 'assistant'];
const isMessages = (v) => Array.isArray(v) && v.length > 0 && v.every(m => isPlainObject(m) && MESSAGE_ROLES.includes(m.role) && typeof m.content === 'string');
// params in the app's own names, under the rules a caller's params meet
const isParams = (p) => { try { normalizeParams({ params: p }); } catch { return false; } return isPlainObject(p); };
// a card as normalizeCard guarantees it: the importer reads all three, and an export must import
const isCard = (v) => isPlainObject(v) && isPlainObject(v.data) && typeof v.data.name === 'string' && !!v.data.name
    && Array.isArray(v.data.tags) && v.data.tags.every(t => typeof t === 'string') && isPlainObject(v.data.extensions);
// each pipeline, and the shape its value keeps: a filter answering anything else is skipped
const FILTER_SHAPES = {
    'card.import': isCard,
    'card.export': isCard,
    'chat.export': (v) => Array.isArray(v) && v.length > 0 && v.every(isPlainObject),
    // books an extension adds to the scan, each named ext:... so none passes for a real book
    'lore.candidates': (v) => Array.isArray(v) && new Set(v.map(w => w?.name)).size === v.length
        && v.every(w => isPlainObject(w) && typeof w.name === 'string' && w.name.startsWith('ext:')
            && isPlainObject(w.data) && isPlainObject(w.data.entries) && Object.values(w.data.entries).every(isLoreEntry)),
    // the placed groups the prompt reads: an entry may leave or change its text, never its shape
    'lore.activate': (v) => isPlainObject(v)
        && LORE_GROUPS.every(g => Array.isArray(v[g]) && v[g].every(isPlaced))
        && v.atDepth.every(c => Number.isInteger(c.depth) && typeof c.role === 'string')
        && (v.outlets === undefined || (Array.isArray(v.outlets) && v.outlets.every(c => isPlaced(c) && typeof c.outlet === 'string' && !!c.outlet)))
        && ['anTop', 'anBottom'].every(g => v[g] === undefined || (Array.isArray(v[g]) && v[g].every(isPlaced))),
    // the messages a reply is asked with, and the request that carries them to the model
    'prompt.final': isMessages,
    'llm.request': (v) => isPlainObject(v) && isMessages(v.messages) && isParams(v.params) && (v.model === undefined || typeof v.model === 'string'),
    // the reply as it is stored: never emptied (an empty reply is not stored at all)
    'reply.final': (v) => typeof v === 'string' && v.trim().length > 0,
};
/** The pipeline names ctx.hooks.add accepts beside the store guards. */
export const PIPELINE_NAMES = Object.freeze(Object.keys(FILTER_SHAPES));

// a book a filter adds is named ext:<its id>:<label>, so the lore window's "added by" is true
const OWNER_RULES = {
    'lore.candidates': (out, input, owner) => {
        const had = new Set(input.map(w => w.name));
        const own = `ext:${owner}:`;
        return out.every(w => had.has(w.name) || (w.name.startsWith(own) && w.name.length > own.length));
    },
};

/**
 * Register what ctx.hooks.add names: a store guard (store.before.<entity>.<op>) or a pipeline
 * filter (PIPELINE_NAMES).
 * @returns {Function} the removal
 */
export function addHook(row, name, fn, opts) {
    if (String(name).startsWith('store.before.')) return addGuard(row, name, fn, opts);
    if (!FILTER_SHAPES[name]) {
        throw new Error(`hooks.add: "${name}" is not a hook; the names are the store guards (store.before.<entity>.<op>) and the pipelines ${Object.keys(FILTER_SHAPES).join(', ')}`);
    }
    return addFilter(row, name, fn, opts);
}

function addFilter(row, name, fn, { priority = 0 } = {}) {
    if (typeof fn !== 'function') throw new Error(`hooks.add: ${name} needs a function`);
    return addOrdered(_filters, name, row, fn, priority);
}

// the seat's runner: each enabled filter on its own copy; a throw, promise or wrong shape passes its input on
function runFilters(name, value, info) {
    const list = _filters.get(name);
    if (!list) return value;
    let current = value;
    for (const { entry: f, value: out, ms, user } of enabledCalls([...list], info, {
        label: () => name,
        failed: () => `${name} failed; its input passes on`,
        call: (filter, facts) => filter.fn(structuredClone(current), facts),
    })) {
        if (refusedPromise(out)) {
            const key = `${f.owner} ${name}`;
            if (!_asyncWarned.has(key)) {
                _asyncWarned.add(key);
                console.error(`[ext:${f.owner}] ${name}: a pipeline filter must answer synchronously; its promise is ignored and its input passes on`);
            }
            recordCall(f.owner, user, name, ms, { error: new Error('answered a promise') });
            continue;
        }
        if (out === undefined) { recordCall(f.owner, user, name, ms); continue; }
        if (!FILTER_SHAPES[name](out)) {
            const e = new Error(`answered a value of the wrong shape for ${name}; its input passes on`);
            recordCall(f.owner, user, name, ms, { error: e });
            console.error(`[ext:${f.owner}] ${e.message}`);
            continue;
        }
        if (OWNER_RULES[name] && !OWNER_RULES[name](out, current, f.owner)) {
            const e = new Error(`${name}: a book it adds is named ext:${f.owner}:<label>; its input passes on`);
            recordCall(f.owner, user, name, ms, { error: e });
            console.error(`[ext:${f.owner}] ${e.message}`);
            continue;
        }
        recordCall(f.owner, user, name, ms);
        current = out;
    }
    return current;
}

// ========================================
// PROMPT REGISTRIES
// ========================================

// {{name}}: lower-case letters and underscores (the engine matches a name whatever its case)
const MACRO_NAME_RE = /^[a-z][a-z_]{0,31}$/;
// a definition's keys, without delay or aliases: control flow stays the app's, so arguments arrive resolved
const MACRO_KEYS = Object.freeze(['args', 'list', 'strict', 'handler']);
const MACRO_ARG_KEYS = Object.freeze(['name', 'type', 'optional']);
const MACRO_ARG_TYPES = Object.freeze(['string', 'integer', 'number', 'boolean']);

// ctx.macros.add's argument as macroDefinition takes it, or the reason it breaks the rules
function macroSpec(macro) {
    if (typeof macro === 'function') return { handler: macro };
    if (!isPlainObject(macro)) return { error: `is a function or a definition { ${MACRO_KEYS.join(', ')} }` };
    const unknown = Object.keys(macro).filter(k => !MACRO_KEYS.includes(k));
    if (unknown.length) return { error: `takes ${MACRO_KEYS.join(', ')}, not ${unknown.join(', ')}` };
    if (typeof macro.handler !== 'function') return { error: 'needs a handler function' };
    if (macro.args !== undefined && !Array.isArray(macro.args)) return { error: `args is a list of { ${MACRO_ARG_KEYS.join(', ')} }` };
    const args = [];
    for (const [k, a] of (macro.args || []).entries()) {
        const at = `argument ${k + 1}`;
        if (!isPlainObject(a)) return { error: `${at} is { ${MACRO_ARG_KEYS.join(', ')} }` };
        const extra = Object.keys(a).filter(x => !MACRO_ARG_KEYS.includes(x));
        if (extra.length) return { error: `${at} takes ${MACRO_ARG_KEYS.join(', ')}, not ${extra.join(', ')}` };
        if (a.name !== undefined && typeof a.name !== 'string') return { error: `${at}'s name is text` };
        const type = a.type ?? 'string';
        const types = Array.isArray(type) ? type : [type];
        if (!types.length || !types.every(t => MACRO_ARG_TYPES.includes(t))) return { error: `${at}'s type is one of ${MACRO_ARG_TYPES.join(', ')}, or a list of them` };
        if (a.optional !== undefined && typeof a.optional !== 'boolean') return { error: `${at}'s optional is true or false` };
        if (!a.optional && args.some(x => x.optional)) return { error: `${at} is required after an optional one` };
        args.push(Object.freeze({ name: a.name ?? '', type: Array.isArray(type) ? Object.freeze([...type]) : type, optional: !!a.optional }));
    }
    const { list = false } = macro;
    if (typeof list !== 'boolean') {
        if (!isPlainObject(list) || Object.keys(list).some(k => k !== 'min' && k !== 'max')) return { error: 'list is true, false or { min, max }' };
        if (list.min !== undefined && !(Number.isInteger(list.min) && list.min >= 0)) return { error: 'list.min is a whole number from 0' };
        if (list.max !== undefined && !(Number.isInteger(list.max) && list.max >= (list.min ?? 0))) return { error: 'list.max is a whole number from list.min' };
    }
    if (macro.strict !== undefined && typeof macro.strict !== 'boolean') return { error: 'strict is true or false' };
    return { args: Object.freeze(args), list, strict: macro.strict ?? true, handler: macro.handler };
}

/**
 * Register {{name}} (ctx.macros.add): a function or a definition, called where an enabled account's text names it.
 * @returns {Function} the removal
 */
export function addMacro(row, name, macro) {
    const n = String(name);
    if (!MACRO_NAME_RE.test(n)) throw new Error(`macros.add: "${n}" must match ${MACRO_NAME_RE} (it is written {{${n}}})`);
    if (BUILTIN_MACROS.includes(n)) throw new Error(`macros.add: {{${n}}} is one of the app's own macros`);
    const held = _macros.get(n);
    if (held) throw new Error(`macros.add: {{${n}}} is already registered by ${held.owner}`);
    const spec = macroSpec(macro);
    if (spec.error) throw new Error(`macros.add: {{${n}}} ${spec.error}`);
    const m = { owner: row.id, row, name: n, fn: spec.handler, def: Object.freeze(macroDefinition(n, { ...spec, handler: null })), running: false };
    _macros.set(n, m);
    syncSeats();
    return () => {
        if (_macros.get(n) !== m) return;
        _macros.delete(n);
        syncSeats();
    };
}

// an account's macros as definitions: the engine calls each where a text names it, timed and contained
function collectMacros(info) {
    const out = {};
    for (const { entry: m, user, facts } of enabledEntries(_macros.values(), info)) {
        const label = `macro ${m.name}`;
        // this environment's: unansweredMacros names a macro that failed, and the log says it once
        let failed = false;
        const refuse = (reason, ms = 0) => {
            recordCall(m.owner, user, label, ms, { error: new Error(reason) });
            if (!failed) console.error(`[ext:${m.owner}] {{${m.name}}} ${reason}; it stays unexpanded`);
            failed = true;
            throw new Error(reason);
        };
        out[m.name] = Object.freeze({
            ...m.def,
            failed: () => failed,
            handler: (call) => {
                // on the registration, not the environment: ctx.prompt.read builds a new one each level
                if (m.running) refuse('expanded itself');
                m.running = true;
                let t;
                try {
                    t = timedCall(m, user, label, failed ? null : `{{${m.name}}} failed; it stays unexpanded`, () => m.fn(Object.freeze({
                        ...facts(), name: m.name, args: Object.freeze([...call.args]), unnamedArgs: Object.freeze([...call.unnamedArgs]),
                        list: call.list && Object.freeze([...call.list]), isScoped: call.isScoped,
                    })));
                } finally {
                    m.running = false;
                }
                if (!t.ok) { failed = true; throw new Error('failed'); }
                if (isText(t.value)) { recordCall(m.owner, user, label, t.ms); return String(t.value); }
                refuse(refusedPromise(t.value) ? 'answered a promise; a macro answers its text synchronously' : 'answered something other than text', t.ms);
            },
        });
    }
    return out;
}

const BLOCK_POSITIONS = ['pre_history', 'post_history', 'at_depth'];
const BLOCK_PLACEMENT = { role: 'system', position: 'pre_history', depth: 0, order: 100 };

// a block's placement, each field falling back to base's; the reason when a field breaks the rules
function blockPlacement(spec, base) {
    const role = spec.role ?? base.role;
    if (!MESSAGE_ROLES.includes(role)) return { error: `role is one of ${MESSAGE_ROLES.join(', ')}` };
    const position = spec.position ?? base.position;
    if (!BLOCK_POSITIONS.includes(position)) return { error: `position is one of ${BLOCK_POSITIONS.join(', ')}` };
    const depth = spec.depth ?? base.depth;
    if (!Number.isInteger(depth) || depth < 0) return { error: 'depth is a whole number from 0' };
    const order = spec.order ?? base.order;
    if (!Number.isFinite(order)) return { error: 'order is a number' };
    return { role, position, depth, order };
}

/**
 * Register a prompt block (ctx.prompt.addBlock): text(facts) answers once per build, and may place that build's block.
 * @returns {Function} the removal
 */
export function addPromptBlock(row, spec) {
    if (!isPlainObject(spec)) throw new Error('prompt.addBlock needs a spec object');
    const id = String(spec.id || '');
    assertSlugId('prompt.addBlock', id);
    const placed = blockPlacement(spec, BLOCK_PLACEMENT);
    if (placed.error) throw new Error(`prompt.addBlock: ${placed.error}`);
    if (typeof spec.text !== 'function') throw new Error('prompt.addBlock: text() is required');
    const key = `${row.id}/${id}`;
    if (_blocks.has(key)) throw new Error(`prompt.addBlock: "${id}" is already registered by ${row.id}`);
    const b = { owner: row.id, row, id, ...placed, text: spec.text };
    _blocks.set(key, b);
    syncSeats();
    return () => {
        if (_blocks.get(key) !== b) return;
        _blocks.delete(key);
        syncSeats();
    };
}

// every block an account's extensions answer for one build; a throw, non-text or bad placement adds nothing
function collectBlocks(info) {
    const out = [];
    for (const { entry: b, value: v, ms, user, name: call } of enabledCalls(_blocks.values(), info, {
        label: (block) => `prompt block ${block.id}`,
        failed: (block) => `prompt block ${block.id} failed; it adds nothing`,
        call: (block, facts) => block.text(facts),
    })) {
        const answer = isText(v) ? { text: v } : isPlainObject(v) && isText(v.text) ? v : null;
        const placed = answer && blockPlacement(answer, b);
        if (placed && !placed.error) {
            recordCall(b.owner, user, call, ms);
            // blank text is dropped where the preset's own is, in the assembly
            out.push({ id: `ext:${b.owner}/${b.id}`, kind: 'text', marker: null, content: String(answer.text), role: placed.role, position: placed.position, depth: placed.depth, injectionOrder: placed.order, enabled: 1 });
            continue;
        }
        const promised = refusedPromise(v);
        const e = new Error(promised ? 'answered a promise; a block answers its text synchronously'
            : placed ? `placed itself outside the rules: ${placed.error}` : 'answered something other than text');
        recordCall(b.owner, user, call, ms, { error: e });
        console.error(`[ext:${b.owner}] ${call} ${e.message}; it adds nothing`);
    }
    return out;
}

// ========================================
// CONNECTION KINDS
// ========================================

const KIND_RE = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * Register a kind of connection (ctx.llm.registerAdapter) on the app's adapter contract; a taken kind is refused.
 * @returns {Function} the removal
 */
export function addAdapter(row, adapter) {
    if (!isPlainObject(adapter)) throw new Error('llm.registerAdapter needs the adapter object');
    const kind = String(adapter.kind || '');
    if (!KIND_RE.test(kind)) throw new Error(`llm.registerAdapter: kind "${kind}" must match ${KIND_RE}`);
    if (getAdapter(kind)) throw new Error(`llm.registerAdapter: '${kind}' is one of the app's own kinds`);
    const held = _adapters.get(kind);
    if (held) throw new Error(`llm.registerAdapter: '${kind}' is already registered by ${held.owner}`);
    if (typeof adapter.displayName !== 'string' || !adapter.displayName.trim()) throw new Error(`llm.registerAdapter: '${kind}' needs a displayName`);
    for (const m of ['chat', 'chatStream', 'listModels']) {
        if (typeof adapter[m] !== 'function') throw new Error(`llm.registerAdapter: '${kind}' needs ${m}()`);
    }
    for (const k of ['capabilities', 'paramTable']) {
        if (adapter[k] !== undefined && !isPlainObject(adapter[k])) throw new Error(`llm.registerAdapter: '${kind}' ${k} is an object`);
    }
    if (adapter.defaultBaseUrl !== undefined && typeof adapter.defaultBaseUrl !== 'string') throw new Error(`llm.registerAdapter: '${kind}' defaultBaseUrl is text`);
    const meta = Object.freeze({
        kind,
        displayName: adapter.displayName.trim(),
        defaultBaseUrl: adapter.defaultBaseUrl || '',
        requiresBaseUrl: !!adapter.requiresBaseUrl,
        capabilities: Object.freeze({ ...(adapter.capabilities || {}) }),
        paramTable: adapter.paramTable || {},
        extension: row.id,
    });
    const entry = { owner: row.id, row, kind, meta, source: adapter };
    _adapters.set(kind, entry);
    syncSeats();
    return () => {
        if (_adapters.get(kind) !== entry) return;
        _adapters.delete(kind);
        syncSeats();
    };
}

// one account's view of an adapter: called on the extension's own object (its this holds), each call counted
function timedAdapter(a, user) {
    const src = a.source;
    const timed = (name, method) => async (...args) => {
        const t0 = performance.now();
        try {
            const v = await src[method](...args);
            recordCall(a.owner, user, name, performance.now() - t0);
            return v;
        } catch (e) {
            recordCall(a.owner, user, name, performance.now() - t0, { error: e });
            throw e;
        }
    };
    return Object.freeze({
        ...a.meta,
        chat: timed(`kind ${a.kind} chat`, 'chat'),
        listModels: timed(`kind ${a.kind} models`, 'listModels'),
        chatStream(...args) {
            return (async function* events() {
                const t0 = performance.now();
                let error = null;
                try {
                    yield* src.chatStream(...args);
                } catch (e) {
                    error = e;
                    throw e;
                } finally {
                    recordCall(a.owner, user, `kind ${a.kind} stream`, performance.now() - t0, { error });
                }
            })();
        },
    });
}

// the kinds an account's extensions serve it
function collectAdapters(info) {
    const db = info?.db;
    const user = ownerOf(db);
    const out = [];
    if (!user || user === SERVER_SCOPE) return out;
    const enabled = enabledMemo(db);
    for (const a of _adapters.values()) if (enabled(a)) out.push(timedAdapter(a, user));
    return out;
}

// the registries' seat (hook-seat.js)
function runRegistries(name, info) {
    if (name === 'macros') return collectMacros(info);
    if (name === 'prompt.blocks') return collectBlocks(info);
    if (name === 'llm.adapters') return collectAdapters(info);
    return null;
}

// ========================================
// CHANGE LISTENERS
// ========================================

/**
 * Hand an extension every committed batch (ctx.events.on) after the write returned; async allowed, contained.
 * @param {object} row the extension's inventory row
 * @returns {Function} the removal
 */
export function addListener(row, fn) {
    if (typeof fn !== 'function') throw new Error('events.on needs a function');
    const l = { owner: row.id, row, fn };
    _listeners.push(l);
    syncSeats();
    return () => {
        const at = _listeners.indexOf(l);
        if (at === -1) return;
        _listeners.splice(at, 1);
        syncSeats();
    };
}

function callListener(l, records, info) {
    const t0 = performance.now();
    const failed = (e) => {
        recordCall(l.owner, info.user, LISTENER, performance.now() - t0, { error: e });
        console.error(`[ext:${l.owner}] a change listener failed:`, e);
    };
    let out;
    try { out = l.fn(records, info); } catch (e) { failed(e); return; }
    if (out && typeof out.then === 'function') out.then(() => recordCall(l.owner, info.user, LISTENER, performance.now() - t0), failed);
    else recordCall(l.owner, info.user, LISTENER, performance.now() - t0);
}

function deliverToListeners(user, records, db) {
    if (user === SERVER_SCOPE || !_listeners.length) return;
    // a commit landing after the account was disabled or deleted is heard by no half
    if (!accountLive(user)) return;
    const batch = [...records];
    // outside its request, so every tab patches it, and under no reader, so a macro reads the server's clock
    setImmediate(() => runWithRequest({ clientId: null }, () => runWithReader(null, () => {
        const enabled = enabledMemo(db);
        // one frozen batch shared by every listener; each record is frozen on both levels
        let frozen = null;
        for (const l of [..._listeners]) {
            if (!enabled(l)) continue;
            frozen ??= Object.freeze(batch.map(frozenRecord));
            callListener(l, frozen, { db, user });
        }
    })));
}

// ========================================
// REPORTS
// ========================================

// the extras a record carries for the client's patchers (a message's chat, a medium's character)
const REPORT_EXTRAS = ['chatId', 'charId', 'world', 'scope'];

/** An extension's report of a write to its own tables (ctx.report), checked; its fields are named <id>.<name>. */
export function extensionReport(owner, record) {
    const r = record && typeof record === 'object' ? record : {};
    const ops = LIBRARY_WRITE_ENTITIES.includes(r.entity) ? CHANGE_VOCABULARY[r.entity] : null;
    if (!ops) throw new Error(`report: entity must be one of ${LIBRARY_WRITE_ENTITIES.join(', ')}`);
    if (!ops.includes(r.op)) throw new Error(`report: ${r.entity} is reported as ${ops.join(', ')}, not ${r.op}`);
    const all = r.all === true;
    const ids = Array.isArray(r.ids) ? r.ids.filter(v => typeof v === 'string' || Number.isInteger(v)) : [];
    if (!all && (!ids.length || ids.length !== r.ids.length)) throw new Error('report: name the ids the write touched (strings, or a message\'s seqs), or all: true');
    if (r.entity === 'message' && typeof r.chatId !== 'string') throw new Error('report: a message record names its chatId');
    // a message record's ids are its seqs (its place); beside them, optionally, the messages' own ids
    const messageIds = r.entity === 'message' && r.messageIds !== undefined ? r.messageIds : null;
    if (messageIds !== null && (all || !Array.isArray(messageIds) || messageIds.length !== ids.length || !messageIds.every(v => Number.isInteger(v) && v > 0))) {
        throw new Error('report: messageIds are the messages\' ids, one beside each seq in ids');
    }
    const fields = r.fields === undefined ? [owner] : r.fields;
    if (!Array.isArray(fields) || !fields.length || fields.some(f => typeof f !== 'string' || (f !== owner && !f.startsWith(`${owner}.`)))) {
        throw new Error(`report: fields are this extension's own, named ${owner}.<name>`);
    }
    const extras = {};
    for (const k of REPORT_EXTRAS) if (typeof r[k] === 'string') extras[k] = r[k];
    return { entity: r.entity, op: r.op, ...(all ? { all: true } : { ids }), ...(messageIds ? { messageIds: [...messageIds] } : {}), fields, ...extras, extension: owner };
}

/** Take away every guard, filter, macro and listener an extension registered, and its timing (its removal). */
export function dropExtensionHooks(owner) {
    for (const table of [_guards, _filters]) {
        for (const [name, list] of [...table]) {
            const kept = list.filter(g => g.owner !== owner);
            if (kept.length) table.set(name, kept); else table.delete(name);
        }
    }
    for (let i = _listeners.length - 1; i >= 0; i--) if (_listeners[i].owner === owner) _listeners.splice(i, 1);
    for (const [name, m] of [..._macros]) if (m.owner === owner) _macros.delete(name);
    for (const [key, b] of [..._blocks]) if (b.owner === owner) _blocks.delete(key);
    for (const [kind, a] of [..._adapters]) if (a.owner === owner) _adapters.delete(kind);
    _stats.delete(owner);
    syncSeats();
}
