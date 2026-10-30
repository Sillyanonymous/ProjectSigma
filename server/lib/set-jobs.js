// A write over a set of characters as chunked jobs, one lane per account; one big transaction would hold every account
import { ownerOf, runWithRequest, SERVER_SCOPE } from '../db/changes.js';
import { runWithReader } from './reader-context.js';
import { materializeSet, dropSet, setChunk } from '../db/set-jobs-store.js';

const FINISHED_KEEP = 20;

let _seq = 0;
// user -> { running: job | null, queue: job[] }
const _lanes = new Map();
// user -> finished jobs, newest first
const _finished = new Map();

const view = (job) => ({
    id: job.id, kind: job.kind, label: job.label, status: job.status, done: job.done, total: job.total,
    queuedAt: job.queuedAt, startedAt: job.startedAt, endedAt: job.endedAt, error: job.error, result: job.result,
});

function accountOf(db) {
    const user = ownerOf(db);
    if (!user || user === SERVER_SCOPE) throw new Error('a set job runs in an account library');
    return user;
}

/**
 * Start a job on this account's lane; a set is fixed first and admit(total) may refuse it by throwing.
 * @param {object} spec { kind, label, origin?, set?, total?, admit?, step, settle, cleanup? }
 * @returns the job as the route answers it
 */
export function startSetJob(db, { kind, label, origin = null, set = null, total = 0, admit = null, step, settle, cleanup = null }) {
    const user = accountOf(db);
    const id = ++_seq;
    if (set) {
        total = materializeSet(db, id, set);
        try { admit?.(total); } catch (e) { dropSet(db, id); throw e; }
    }
    let after = 0;
    const next = (limit) => {
        const chunk = setChunk(db, id, after, limit);
        if (chunk.last !== null) after = chunk.last;
        return chunk.ids;
    };
    const job = {
        id, user, db, origin: origin || null, kind, label, status: 'queued',
        done: 0, total, queuedAt: Date.now(), startedAt: null, endedAt: null, error: null, result: null,
        stopRequested: false, step: (j) => step(j, next), settle,
        cleanup: () => { if (set) dropSet(db, id); cleanup?.(); },
    };
    let lane = _lanes.get(user);
    if (!lane) _lanes.set(user, lane = { running: null, queue: [] });
    lane.queue.push(job);
    pump(user);
    return view(job);
}

function pump(user) {
    const lane = _lanes.get(user);
    if (!lane || lane.running) return;
    const job = lane.queue.shift();
    if (!job) { _lanes.delete(user); return; }
    lane.running = job;
    job.status = 'running';
    job.startedAt = Date.now();
    setImmediate(() => tick(job));
}

const yieldTurn = () => new Promise(resolve => setImmediate(resolve));

// one chunk per turn of the event loop, in the starting tab's request context (or none)
async function tick(job) {
    try {
        for (;;) {
            // ended while this turn waited (its account went)
            if (job.status !== 'running') break;
            if (job.stopRequested) { finish(job, 'stopped'); break; }
            const more = runWithRequest({ clientId: job.origin }, () => runWithReader(null, () => job.step(job)));
            if (!more) { finish(job, 'done'); break; }
            await yieldTurn();
        }
    } catch (e) {
        console.error(`[jobs] ${job.kind} job "${job.label}" failed:`, e);
        finish(job, 'failed', e);
    }
}

function finish(job, status, error = null) {
    try { job.cleanup(job); } catch (e) { console.error('[jobs] a job cleanup failed:', e); }
    job.status = status;
    job.endedAt = Date.now();
    job.error = error ? String(error?.message || error) : null;
    job.result = job.settle(job);
    job.step = job.settle = job.cleanup = null;
    const list = _finished.get(job.user) || [];
    list.unshift(job);
    if (list.length > FINISHED_KEEP) list.length = FINISHED_KEEP;
    _finished.set(job.user, list);
    const lane = _lanes.get(job.user);
    if (lane?.running === job) lane.running = null;
    pump(job.user);
}

/** Whether this account has a job running or queued, of one of these kinds when they are named. */
export function setJobsBusy(user, kinds = null) {
    const lane = _lanes.get(user);
    if (!lane) return false;
    return [lane.running, ...lane.queue].some(j => j && (!kinds || kinds.includes(j.kind)));
}

/** One of this account's jobs, running, queued or finished; null when it holds none by that id. */
export function getSetJob(user, id) {
    const lane = _lanes.get(user);
    const live = lane && [lane.running, ...lane.queue].find(j => j?.id === id);
    if (live) return view(live);
    const done = (_finished.get(user) || []).find(j => j.id === id);
    return done ? view(done) : null;
}

/**
 * Stop one of this account's jobs: queued never starts, running halts before its next chunk.
 * @returns the job, or null when the account holds none by that id
 */
export function stopSetJob(user, id) {
    const lane = _lanes.get(user);
    if (lane) {
        if (lane.running?.id === id) { lane.running.stopRequested = true; return view(lane.running); }
        const at = lane.queue.findIndex(j => j.id === id);
        if (at !== -1) {
            const job = lane.queue.splice(at, 1)[0];
            finish(job, 'stopped');
            return view(job);
        }
    }
    return getSetJob(user, id);
}

/** An account leaves: its queued jobs never start, its running one halts, its finished ones go. */
export function forgetAccountSetJobs(user) {
    const lane = _lanes.get(user);
    if (lane) {
        for (const job of lane.queue.splice(0)) finish(job, 'stopped');
        // halted now while its library is open: a flag would let its next turn write under a reused handle
        if (lane.running) finish(lane.running, 'stopped');
    }
    _finished.delete(user);
}
