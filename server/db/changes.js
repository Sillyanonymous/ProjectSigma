// The change feed's source: store writes report through emitChange, delivered only once the write commits
import { AsyncLocalStorage } from 'node:async_hooks';

// server.db's records' owner: a handle never holds a dot, so no account can be routed as the accounts
export const SERVER_SCOPE = 'server.db';

// every entity a report may name with its ops: the feed's vocabulary and the store guards' names
export const CHANGE_VOCABULARY = Object.freeze(Object.fromEntries(Object.entries({
    assistantSession: ['created', 'updated', 'deleted'],
    attachment: ['created', 'deleted'],
    background: ['created', 'updated', 'deleted'],
    backgroundBinding: ['updated', 'deleted'],
    backup: ['updated'],
    character: ['created', 'updated', 'deleted'],
    chat: ['created', 'updated', 'deleted'],
    document: ['updated', 'deleted'],
    extension: ['updated'],
    extensionJob: ['updated', 'deleted'],
    library: ['changed'],
    llmProfile: ['created', 'updated', 'deleted'],
    maintenance: ['updated'],
    media: ['created', 'updated', 'deleted'],
    mediaJob: ['updated', 'deleted'],
    message: ['created', 'updated', 'deleted'],
    persona: ['created', 'updated', 'deleted'],
    playlist: ['created', 'updated', 'deleted'],
    preset: ['created', 'updated', 'deleted'],
    setting: ['updated'],
    studioSession: ['created', 'updated', 'deleted'],
    tag: ['updated', 'deleted'],
    tagRun: ['created', 'deleted'],
    user: ['created', 'updated', 'deleted'],
    version: ['updated', 'deleted'],
    world: ['created', 'updated', 'deleted'],
    worldEntry: ['created', 'updated', 'deleted'],
    worldLink: ['updated'],
}).map(([entity, ops]) => [entity, Object.freeze(ops)])));
export const CHANGE_ENTITIES = Object.freeze(Object.keys(CHANGE_VOCABULARY));

// what a library store write reports; user, library, extension, extensionJob, backup and maintenance are announced outside one
export const LIBRARY_WRITE_ENTITIES = Object.freeze(CHANGE_ENTITIES.filter(e => !['user', 'library', 'extension', 'extensionJob', 'backup', 'maintenance'].includes(e)));

const requestContext = new AsyncLocalStorage();
// db handle -> { owner, frames }
const _tracked = new WeakMap();
const _subscribers = new Set();
let _looseWarned = false;
let _commitGuard = null;

/** The one check every framed write passes before commit: fn(owner, records, db), synchronous; a throw rolls back, null removes it. */
export function setCommitGuard(fn) {
    _commitGuard = typeof fn === 'function' ? fn : null;
}

/** The account a tracked handle belongs to (a user handle, or SERVER_SCOPE); null for one untracked. */
export function ownerOf(db) {
    return _tracked.get(db)?.owner ?? null;
}

/** Run a request's handlers in its context, so each report carries the asking tab (X-CL-Client) as origin. */
export function runWithRequest(context, fn) {
    return requestContext.run(context, fn);
}

/** Be handed every committed batch: fn(owner, records, db), db the handle it committed on. Returns the unsubscribe. */
export function subscribeChanges(fn) {
    _subscribers.add(fn);
    return () => _subscribers.delete(fn);
}

function deliver(state, records) {
    if (!records.length || !_subscribers.size) return;
    for (const fn of _subscribers) {
        try { fn(state.owner, records, state.db); } catch (e) { console.error('[changes] a subscriber failed:', e); }
    }
}

/**
 * Frame a handle's transactions and route its reports to owner (a user handle, or
 * SERVER_SCOPE). Called once per handle, after its migrations ran.
 */
export function trackHandle(db, owner) {
    if (_tracked.has(db)) return;
    const state = { owner, frames: [], db };
    _tracked.set(db, state);
    const original = db.transaction.bind(db);
    // the guard runs only at the outermost level; a savepoint's reports reach it with its parent's
    const guarded = (fn) => function guardedWrite(...args) {
        const result = fn.apply(this, args);
        const frame = state.frames[0];
        if (_commitGuard && state.frames.length === 1 && frame.length) _commitGuard(state.owner, frame, db);
        return result;
    };
    const framed = (run) => (...args) => {
        state.frames.push([]);
        let ok = false;
        let result;
        try {
            result = run(...args);
            ok = true;
        } finally {
            const frame = state.frames.pop();
            if (ok) {
                // appended one at a time: a spread of a set write's frame is an argument list
                if (state.frames.length) for (const r of frame) state.frames[state.frames.length - 1].push(r);
                else if (!db.inTransaction) deliver(state, frame);
                else if (frame.length && !_looseWarned) {
                    // a transaction opened by a raw BEGIN the wrapper never saw: nothing here
                    // can know when it commits, so its reports are dropped, loudly, once
                    _looseWarned = true;
                    console.error('[changes] reports made inside a transaction opened outside db.transaction() were dropped');
                }
            }
        }
        return result;
    };
    // writes lock at BEGIN (immediate): deferred fails at once when another connection commited in between. savepoints ignore the variant
    db.transaction = (fn) => {
        const tx = original(guarded(fn));
        const out = framed(tx.immediate);
        out.deferred = framed(tx.deferred);
        out.immediate = framed(tx.immediate);
        out.exclusive = framed(tx.exclusive);
        return out;
    };
}

// past this many ids a relation write reports all: true and tabs re-read what they hold
export const RECORD_IDS_MAX = 1000;

/** Report the characters a relation write changed, in the named fields, bounded by RECORD_IDS_MAX. */
export function reportCharactersUpdated(db, charIds, fields) {
    if (!charIds.length) return;
    emitChange(db, charIds.length > RECORD_IDS_MAX
        ? { entity: 'character', op: 'updated', all: true, fields }
        : { entity: 'character', op: 'updated', ids: [...charIds], fields });
}

/** Report a write, { entity, op, ids | all: true, fields? }, delivered at commit with the asking tab as origin; untracked handles report nowhere. */
export function emitChange(db, record) {
    const state = _tracked.get(db);
    if (!state) return;
    const rec = { ...record, origin: requestContext.getStore()?.clientId ?? null };
    if (state.frames.length) state.frames[state.frames.length - 1].push(rec);
    else if (!db.inTransaction) deliver(state, [rec]);
    else if (!_looseWarned) {
        _looseWarned = true;
        console.error('[changes] a report made inside a transaction opened outside db.transaction() was dropped');
    }
}
