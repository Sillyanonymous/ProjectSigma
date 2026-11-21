// The change feed's client: one WebSocket per tab; patchers sync caches, events announce.
// Imports only the registries so node runs it as shipped.
import { defineEvent, fireEvent as fire } from './ext-registry.js';

const COALESCE_MS = 150;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;

// announced from the feed alone, for every origin ('self' or 'remote'); payloads carry ids, never objects
defineEvent('character.created');
defineEvent('character.updated');
defineEvent('character.deleted');
defineEvent('chat.created');
defineEvent('chat.updated');
defineEvent('chat.deleted');
defineEvent('message.created');
defineEvent('message.updated');
defineEvent('message.deleted');
defineEvent('settings.changed');
defineEvent('tags.changed');
defineEvent('playlists.changed');
defineEvent('media.changed');
defineEvent('library.changed');

// entity -> Set(patcher)
const _patchers = new Map();
// patcher -> { shell, at, own }: every pass runs the shell's patchers first, then each in registration order
const _rank = new Map();
const OWN = new Set([false, true, 'both']);
let _opts = null;
let _ws = null;
let _backoff = BACKOFF_MIN_MS;
let _retryTimer = null;
let _stopped = true;
let _everConnected = false;
let _flushTimer = null;
let _pending = [];
// a held feed queues what arrives until the page's own first reads have landed
let _held = false;
let _resyncWanted = false;
// flushes and resyncs run one after another on this chain, so batches patch and announce in order
let _work = Promise.resolve();
let _resyncQueued = false;

function enqueue(job) {
    _work = _work.then(job, job);
    return _work;
}

function addPatcher(entities, fn, shell, own = false) {
    if (!OWN.has(own)) throw new Error('a feed patcher\'s own is false, true or "both"');
    const list = Array.isArray(entities) ? entities : [entities];
    const ranked = _rank.get(fn);
    // one rank per function: a second origin or door registered for it would be dropped without a word
    if (ranked && (ranked.own !== own || ranked.shell !== shell)) throw new Error('a feed patcher registered again with another origin or door: register it once, with own "both" for every origin');
    if (!ranked) _rank.set(fn, { shell, at: _rank.size, own });
    for (const e of list) {
        if (!_patchers.has(e)) _patchers.set(e, new Set());
        _patchers.get(e).add(fn);
    }
    return () => { for (const e of list) _patchers.get(e)?.delete(fn); };
}

const byRank = (a, b) => {
    const x = _rank.get(a), y = _rank.get(b);
    return (x.shell === y.shell ? 0 : x.shell ? -1 : 1) || x.at - y.at;
};

/**
 * Keep a cache in line: fn(records) gets other tabs' records for these entities, or null to re-read the whole view.
 * @param {{ own?: boolean | 'both' }} [opts] own: true hands fn this tab's own records instead and never a re-read; 'both' every origin's, re-reads included
 * @returns {Function} the unregister
 */
export function registerFeedPatcher(entities, fn, { own = false } = {}) {
    return addPatcher(entities, fn, false, own);
}

/**
 * The shell's patchers (window.ClFeed's door): they re-read the caches a module's patcher reads, so they run first whenever registered.
 * @returns {Function} the unregister
 */
export function registerShellFeedPatcher(entities, fn) {
    return addPatcher(entities, fn, true);
}

async function runPatcher(fn, records) {
    try { await fn(records); } catch (e) { console.error('[Feed] a patcher failed:', e); }
}

const originOf = (r) => (r.origin && r.origin === _opts?.clientId ? 'self' : 'remote');

function announce(r) {
    const origin = originOf(r);
    const ids = r.ids || [];
    switch (r.entity) {
        case 'character':
            if (r.op === 'created') fire('character.created', { ids, origin });
            else if (r.op === 'deleted') fire('character.deleted', { ids, origin });
            else fire('character.updated', { ids, fields: r.fields || [], all: !!r.all, origin });
            break;
        case 'chat':
            if (r.op === 'created') fire('chat.created', { ids, charId: r.charId ?? null, branchOf: r.branchOf ?? null, origin });
            else if (r.op === 'deleted') fire('chat.deleted', { ids, charId: r.charId ?? null, origin });
            else fire('chat.updated', { ids, fields: r.fields || [], origin });
            break;
        case 'message':
            if (r.op === 'created' || r.op === 'updated' || r.op === 'deleted') {
                fire(`message.${r.op}`, { chatId: r.chatId ?? null, seqs: ids, messageIds: r.messageIds || [], ...(r.op === 'updated' ? { all: !!r.all } : {}), origin });
            }
            break;
        case 'setting':
            fire('settings.changed', { keys: ids, all: !!r.all, origin });
            break;
        case 'tag':
            fire('tags.changed', { names: ids, origin });
            break;
        case 'playlist':
            fire('playlists.changed', { ids, all: !!r.all, origin });
            break;
        case 'media':
            fire('media.changed', { ids, charId: r.charId ?? null, origin });
            break;
        case 'library':
            fire('library.changed', { reason: 'import', origin });
            break;
        default:
    }
}

// every patcher once, handed null, in a batch's order: re-read the whole view
async function rereadAll() {
    const fns = new Set();
    for (const set of _patchers.values()) for (const fn of set) if (_rank.get(fn).own !== true) fns.add(fn);
    for (const fn of [...fns].sort(byRank)) await runPatcher(fn, null);
}

// a burst becomes one pass per patcher, each getting the batch's records of every entity it follows in one call
function flush() {
    _flushTimer = null;
    return enqueue(flushNow);
}

async function flushNow() {
    const batch = _pending;
    _pending = [];
    if (!batch.length) return;
    // a whole-library change in another process (a migration) has no ids to patch: every view re-reads
    if (batch.some(r => r.entity === 'library' && originOf(r) === 'remote')) {
        await rereadAll();
    } else {
        // once per patcher, the shell's first: a module's patcher reads what they re-read
        const byFn = new Map();
        for (const r of batch) {
            const self = originOf(r) === 'self';
            for (const fn of _patchers.get(r.entity) || []) {
                const { own } = _rank.get(fn);
                if (own !== 'both' && self !== own) continue;
                if (!byFn.has(fn)) byFn.set(fn, []);
                byFn.get(fn).push(r);
            }
        }
        for (const fn of [...byFn.keys()].sort(byRank)) await runPatcher(fn, byFn.get(fn));
    }
    // after the patchers, so a listener that re-reads a cache finds it current
    for (const r of batch) announce(r);
}

function scheduleFlush() {
    if (!_held && !_flushTimer && _pending.length) _flushTimer = setTimeout(flush, COALESCE_MS);
}

/**
 * Re-read every view, then announce library.changed 'resync'; requests fold, so a burst costs two passes at most.
 * @returns {Promise<void>} settles when the pass this request rides on is done
 */
export function resyncAll() {
    if (_held) { _resyncWanted = true; return Promise.resolve(); }
    if (_resyncQueued) return _work;
    _resyncQueued = true;
    return enqueue(async () => {
        _resyncQueued = false;
        // the queue is covered by the re-read but still announced: this tab's own writes reach listeners only that way
        clearTimeout(_flushTimer);
        _flushTimer = null;
        const queued = _pending;
        _pending = [];
        await rereadAll();
        for (const r of queued) announce(r);
        fire('library.changed', { reason: 'resync', origin: 'remote' });
    });
}

function onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg?.type === 'changes' && Array.isArray(msg.records)) {
        // appended one at a time: a spread of a set write's frame is an argument list
        for (const r of msg.records) _pending.push(r);
        scheduleFlush();
    } else if (msg?.type === 'resync') {
        resyncAll();
    }
}

function scheduleReconnect() {
    if (_stopped || _retryTimer) return;
    const wait = Math.min(_backoff, BACKOFF_MAX_MS) * (0.75 + Math.random() * 0.5);
    _backoff = Math.min(_backoff * 2, BACKOFF_MAX_MS);
    _retryTimer = setTimeout(() => { _retryTimer = null; connect(); }, wait);
}

function connect() {
    if (_stopped) return;
    let ws;
    try {
        ws = new _opts.WebSocket(`${_opts.url}?client=${encodeURIComponent(_opts.clientId)}`);
    } catch (e) {
        console.warn('[Feed] could not open the feed:', e);
        scheduleReconnect();
        return;
    }
    _ws = ws;
    ws.onopen = () => {
        _backoff = BACKOFF_MIN_MS;
        const reconnected = _everConnected;
        _everConnected = true;
        // the feed kept nothing while away, so re-read; a first open after release missed writes since the first reads too
        if (reconnected || !_held) resyncAll();
    };
    ws.onmessage = (e) => onMessage(typeof e.data === 'string' ? e.data : String(e.data));
    ws.onclose = (e) => {
        if (_ws === ws) _ws = null;
        // 4001: the session ended (a password change, a disabled account); the sign-in
        // overlay takes over, and a new session starts a new feed
        if (e?.code === 4001) { stopFeed(); _opts?.onSessionEnded?.(); return; }
        scheduleReconnect();
    };
    ws.onerror = () => { /* the close that follows decides */ };
}

/**
 * Open the feed (with `held`, BEFORE the page's first reads: records queue until releaseFeed).
 * @param {{url: string, clientId: string, WebSocket: Function, held?: boolean, onSessionEnded?: Function}} opts url is ws(s)://, clientId the X-CL-Client tab id
 */
export function startFeed(opts) {
    if (!opts?.url || !opts?.clientId || typeof opts?.WebSocket !== 'function') throw new Error('startFeed needs url, clientId and WebSocket');
    _opts = opts;
    if (!_stopped) return;
    _stopped = false;
    _held = !!opts.held;
    // a new start is a new session's feed: the caller's own first reads cover what came before
    _everConnected = false;
    connect();
}

/** Let a held feed through: the patchers run on what queued (or re-read, when a resync was asked). */
export function releaseFeed() {
    if (!_held) return;
    _held = false;
    if (_resyncWanted) {
        _resyncWanted = false;
        resyncAll();
        return;
    }
    scheduleFlush();
}

/** Close the feed and stop reconnecting. */
export function stopFeed() {
    _stopped = true;
    clearTimeout(_retryTimer);
    _retryTimer = null;
    const ws = _ws;
    _ws = null;
    try { ws?.close(); } catch { /* already closing */ }
}

/** Try at once instead of waiting out the backoff (the page became visible again). */
export function reconnectNow() {
    if (_stopped || _ws) return;
    clearTimeout(_retryTimer);
    _retryTimer = null;
    _backoff = BACKOFF_MIN_MS;
    connect();
}

/** Whether a connection is open. */
export function feedConnected() {
    return !!_ws && _ws.readyState === 1;
}
