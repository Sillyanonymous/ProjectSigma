// ctx.jobs: an extension's background work, in memory, one lane per extension per account, and
// schedules over the accounts that have it on.
import { performance } from 'node:perf_hooks';
import { emitChange, runWithRequest } from '../db/changes.js';
import { openDb } from '../db/database.js';
import { forEachAccountLibrary, openServerDb } from '../db/server-store.js';
import { config } from '../config.js';
import { runWithReader } from './reader-context.js';
import { extensionEnabledFor, doorAccount } from './extensions.js';
import { recordCall, describeError } from './ext-hooks.js';
import { assertSlugId } from './ext-contract.js';

const FINISHED_KEEP = 20;
const SCHEDULE_FLOOR_MS = 60 * 1000;
// node clamps a longer timer to 1 ms, so a schedule past it would tick a thousand times a second
const SCHEDULE_CEILING_MS = 2147483647;
const LABEL_MAX = 120;
const NOTE_MAX = 200;

let _seq = 0;
// `${ext} ${user}` -> { running: job | null, queue: job[] }
const _lanes = new Map();
// user -> finished jobs, newest first
const _finished = new Map();
// `${ext}/${id}` -> { row, id, label, every, run, timer }
const _schedules = new Map();
let _serving = false;

const laneKey = (ext, user) => `${ext} ${user}`;

function laneOf(ext, user) {
    const key = laneKey(ext, user);
    let lane = _lanes.get(key);
    if (!lane) _lanes.set(key, lane = { running: null, queue: [] });
    return lane;
}

// a job's changes tell the account's tabs to re-read the jobs; progress is read, never announced
function announce(job, removed = false) {
    emitChange(job.db, { entity: 'extensionJob', op: removed ? 'deleted' : 'updated', ids: [job.id], extension: job.ext });
}

const view = (job, position = null) => ({
    id: job.id, extension: job.ext, extensionName: job.row?.name || job.ext, key: job.key, label: job.label, status: job.status,
    progress: job.progress, queuedAt: job.queuedAt, startedAt: job.startedAt, endedAt: job.endedAt,
    error: job.error, ...(position != null ? { position } : {}),
});

/**
 * Queue work for db's account (ctx.jobs.run); a queued key is superseded in place, a running one queued behind.
 * @returns {{ id: number }}
 */
export function runJob(row, db, spec) {
    const user = doorAccount(row, db, 'jobs.run');
    const s = spec && typeof spec === 'object' ? spec : {};
    if (typeof s.run !== 'function') throw new Error('jobs.run: run({ db, user, signal, progress }) is required');
    const label = String(s.label ?? '').trim().slice(0, LABEL_MAX);
    if (!label) throw new Error('jobs.run: a label names the job in the notifications center');
    const key = s.key == null ? null : String(s.key);
    const lane = laneOf(row.id, user);
    const queued = key && lane.queue.find(j => j.key === key);
    if (queued) {
        queued.label = label;
        queued.run = s.run;
        announce(queued);
        return { id: queued.id };
    }
    const job = {
        id: ++_seq, ext: row.id, row, user, db, key, label, run: s.run, status: 'queued',
        progress: null, queuedAt: Date.now(), startedAt: null, endedAt: null, error: null,
        controller: new AbortController(),
    };
    lane.queue.push(job);
    announce(job);
    pump(row.id, user);
    return { id: job.id };
}

function pump(ext, user) {
    const key = laneKey(ext, user);
    const lane = _lanes.get(key);
    if (!lane || lane.running) return;
    while (lane.queue.length) {
        const job = lane.queue.shift();
        let on = false;
        try { on = extensionEnabledFor(job.db, job.row); } catch { /* a closed library (the migrate tool's) serves nobody */ }
        if (!on) { finish(job, 'cancelled', 'the extension is switched off'); continue; }
        lane.running = job;
        job.status = 'running';
        job.startedAt = Date.now();
        // outside the queuing request and reader: its writes are no tab's own, its macros read the server's clock
        setImmediate(() => runWithRequest({ clientId: null }, () => runWithReader(null, () => start(job))));
        return;
    }
    _lanes.delete(key);
}

// the lane moves on when its running job ends, however it ends
function release(job) {
    const lane = _lanes.get(laneKey(job.ext, job.user));
    if (lane?.running !== job) return;
    lane.running = null;
    pump(job.ext, job.user);
}

async function start(job) {
    announce(job);
    const t0 = performance.now();
    // a flag, never the caught value's truthiness: a bare reject() or a throw of 0 failed too
    let failed = false;
    let error;
    try {
        await job.run(Object.freeze({ db: job.db, user: job.user, signal: job.controller.signal, progress: (p) => setProgress(job, p) }));
    } catch (e) {
        failed = true;
        error = e;
    }
    // a job cancelled while it ran was settled then; what its run does after is its own
    if (job.status !== 'running') return;
    recordCall(job.ext, job.user, 'jobs.run', performance.now() - t0, failed ? { error } : {});
    if (failed) console.error(`[ext:${job.ext}] job "${job.label}" failed:`, describeError(error));
    finish(job, failed ? 'failed' : 'done', failed ? describeError(error) : null);
    release(job);
}

function setProgress(job, p) {
    if (job.status !== 'running' || !p || typeof p !== 'object') return;
    const count = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
    job.progress = { done: count(p.done), total: count(p.total), note: typeof p.note === 'string' ? p.note.slice(0, NOTE_MAX) : null };
}

function finish(job, status, error = null) {
    job.status = status;
    job.endedAt = Date.now();
    job.error = error ? describeError(error) : null;
    job.run = null;
    const list = _finished.get(job.user) || [];
    list.unshift(job);
    if (list.length > FINISHED_KEEP) list.length = FINISHED_KEEP;
    _finished.set(job.user, list);
    announce(job);
}

// a running job settles at once and frees its lane: one that ignores its signal cannot wedge it
function cancelRunning(job, reason = null) {
    job.controller.abort();
    finish(job, 'cancelled', reason);
    release(job);
}

/** One account's jobs, every extension's: the running, then the queued by position, then the finished newest first. */
export function listJobs(user) {
    const lanes = [..._lanes.values()];
    const running = lanes.filter(l => l.running?.user === user).map(l => view(l.running));
    const queued = lanes.flatMap(l => l.queue.map((j, i) => (j.user === user ? view(j, i + 1) : null)).filter(Boolean));
    return [...running, ...queued, ...(_finished.get(user) || []).map(j => view(j))];
}

/** This extension's own jobs for db's account (ctx.jobs.list), so a half asks the lane instead of keeping a copy. */
export function listExtensionJobs(row, db) {
    const user = doorAccount(row, db, 'jobs.list');
    return listJobs(user).filter(j => j.extension === row.id);
}

/**
 * Cancel a queued or running job of this account, or dismiss a finished one.
 * @returns {boolean} false when the account holds no such job
 */
export function cancelJob(user, id) {
    for (const lane of [..._lanes.values()]) {
        if (lane.running?.user === user && lane.running.id === id) { cancelRunning(lane.running); return true; }
        const at = lane.queue.findIndex(j => j.user === user && j.id === id);
        if (at !== -1) { finish(lane.queue.splice(at, 1)[0], 'cancelled'); return true; }
    }
    const list = _finished.get(user) || [];
    const at = list.findIndex(j => j.id === id);
    if (at === -1) return false;
    announce(list.splice(at, 1)[0], true);
    return true;
}

/** Dismiss every finished job of this account. @returns {number} how many */
export function clearFinishedJobs(user) {
    const list = _finished.get(user) || [];
    _finished.delete(user);
    for (const job of list) announce(job, true);
    return list.length;
}

// cancel every queued and running job pred names, the queued first so a freed lane starts nothing
function cancelWhere(pred, reason) {
    let n = 0;
    for (const [key, lane] of [..._lanes.entries()]) {
        const gone = lane.queue.filter(pred);
        if (gone.length) lane.queue = lane.queue.filter(j => !pred(j));
        for (const j of gone) { finish(j, 'cancelled', reason); n++; }
        if (lane.running && pred(lane.running)) { cancelRunning(lane.running, reason); n++; }
        if (!lane.running && !lane.queue.length) _lanes.delete(key);
    }
    return n;
}

/**
 * Cancel every extension's jobs of an account its admin deleted or disabled (its library stays open).
 * @returns {number} how many
 */
export function cancelAccountJobs(user, reason = 'the account was removed') {
    return cancelWhere(j => j.user === user, reason);
}

/** Cancel an extension's queued and running jobs, for one account (its switch went off) or every account. */
export function cancelExtensionJobs(ext, user = null) {
    cancelWhere(j => j.ext === ext && (!user || j.user === user), 'the extension is switched off');
}

// ========================================
// SCHEDULES
// ========================================

/**
 * Queue a job for every account with the extension on, every `every` ms; timers run only while the server serves.
 * @returns {Function} the removal
 */
export function addSchedule(row, spec) {
    const s = spec && typeof spec === 'object' ? spec : {};
    const id = String(s.id || '');
    assertSlugId('jobs.schedule', id);
    if (!Number.isFinite(s.every) || s.every < SCHEDULE_FLOOR_MS) throw new Error(`jobs.schedule: every is at least ${SCHEDULE_FLOOR_MS} ms`);
    if (s.every > SCHEDULE_CEILING_MS) throw new Error(`jobs.schedule: every is at most ${SCHEDULE_CEILING_MS} ms (about 24 days), the timer's limit`);
    if (typeof s.run !== 'function') throw new Error('jobs.schedule: run({ db, user, signal, progress }) is required');
    const key = `${row.id}/${id}`;
    if (_schedules.has(key)) throw new Error(`jobs.schedule: "${id}" is already scheduled by ${row.id}`);
    const sched = { row, id, label: String(s.label ?? '').trim().slice(0, LABEL_MAX) || id, every: s.every, run: s.run, timer: null };
    _schedules.set(key, sched);
    if (_serving) arm(sched);
    return () => {
        if (_schedules.get(key) !== sched) return;
        clearInterval(sched.timer);
        _schedules.delete(key);
    };
}

function arm(sched) {
    clearInterval(sched.timer);
    sched.timer = setInterval(() => tick(sched), sched.every);
    sched.timer.unref?.();
}

// the enabled accounts only (no disabled library run against, no keys spent), each by its own switch
function tick(sched) {
    let serverDb = null;
    if (config.multiUser) {
        try { serverDb = openServerDb(); } catch { return 0; }
    }
    let queued = 0;
    const onError = (handle, e) => console.error(`[ext:${sched.row.id}] schedule "${sched.id}" could not queue for ${handle}:`, e);
    forEachAccountLibrary({ serverDb, enabledOnly: true, onError }, ({ handle }) => {
        const db = openDb(handle);
        if (!extensionEnabledFor(db, sched.row)) return;
        runJob(sched.row, db, { key: `schedule:${sched.id}`, label: sched.label, run: sched.run });
        queued++;
    });
    return queued;
}

/** Start every schedule's timer; the server calls this once it serves. */
export function startJobSchedules() {
    _serving = true;
    for (const sched of _schedules.values()) arm(sched);
}

/** Test seam: one tick of a schedule now. @returns {number} the accounts it queued a job for */
export function runScheduleNow(ext, id) {
    const sched = _schedules.get(`${ext}/${id}`);
    return sched ? tick(sched) : 0;
}

/** The schedules a half registered, as the inspector lists registrations: { kind, id }. */
export function scheduleRegistrations(ext) {
    return [..._schedules.values()].filter(s => s.row.id === ext).map(s => ({ kind: 'server schedule', id: s.id }));
}

/** Everything an extension's half queued or scheduled: its jobs cancelled, its schedules stopped. */
export function dropExtensionJobs(ext) {
    cancelExtensionJobs(ext);
    for (const [key, sched] of [..._schedules]) {
        if (sched.row.id !== ext) continue;
        clearInterval(sched.timer);
        _schedules.delete(key);
    }
}
