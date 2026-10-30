// What a backup IS, its job and its schedule; the route and the scheduler both call this, so there is one way to back up
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { settingValue } from '../db/settings-store.js';
import { readDocument, writeDocument } from '../db/documents-store.js';
import { copyBytes } from '../db/backup-copy.js';
import { emitChange, ownerOf, runWithRequest } from '../db/changes.js';
import { killTree } from './kill-tree.js';
import { httpError } from './http-error.js';

export const BACKUP_FREQUENCIES = Object.freeze({ off: 0, daily: 86400000, weekly: 604800000 });
const DEFAULT_KEEP = 5;
export const DEFAULT_BACKUP_WINDOW = { start: 3, end: 6 };
// the scheduler's own state: the schedule's shape and since when it holds, the answers to a missed window, the held window
export const BACKUP_SCHEDULE_KEY = 'backup-schedule';
const COPIER = fileURLToPath(new URL('../db/backup-copy.js', import.meta.url));
const ERROR_MAX = 500;
const DAY_MS = 86400000;
// a stored time past this is junk: a date beyond the year 9999 makes every window an Invalid Date
const LATEST_TIME = 253402300800000;
// how many days a next window is looked for; past it the schedule names no next run rather than search on
const WINDOW_SEARCH_DAYS = 400;

export function listBackups(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.startsWith('library-') && f.endsWith('.db'))
        .map((f) => {
            const st = fs.statSync(path.join(dir, f));
            return { file: f, bytes: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
}

/** The library's size with its write-ahead log, whose pages are library until checkpointed; 0 for a library never written. */
export function libraryBytes(dbFile) {
    let bytes = 0;
    try {
        bytes = fs.statSync(dbFile).size;
        for (const suffix of ['-wal', '-shm']) {
            try { bytes += fs.statSync(dbFile + suffix).size; } catch { /* absent is fine */ }
        }
    } catch { /* a library that has never been written has no file yet */ }
    return bytes;
}

/** The backup settings, read from one place so the route and the scheduler agree; an unknown frequency is off. */
export function backupSettings(db) {
    const read = (key, fallback) => settingValue(db, key, fallback);
    const keep = Number(read('backupKeep', DEFAULT_KEEP));
    const frequency = String(read('backupFrequency', 'off'));
    const hour = (key, fallback) => {
        const h = Number(read(key, fallback));
        return Number.isInteger(h) && h >= 0 && h <= 23 ? h : fallback;
    };
    return {
        frequency: Object.hasOwn(BACKUP_FREQUENCIES, frequency) ? frequency : 'off',
        // clamped here too, this number deletes files and a hand-edited 0 would prune everything
        keep: Number.isFinite(keep) ? Math.min(50, Math.max(1, Math.round(keep))) : DEFAULT_KEEP,
        windowStart: hour('backupWindowStart', DEFAULT_BACKUP_WINDOW.start),
        windowEnd: hour('backupWindowEnd', DEFAULT_BACKUP_WINDOW.end),
    };
}

// ========================================
// THE SCHEDULE
// ========================================

// what the schedule runs on; a change of any of it starts the schedule afresh, so no window before the change is missed
const shapeOf = (s) => (s.frequency === 'off' ? null : `${s.frequency} ${s.windowStart}-${s.windowEnd}`);

const timeOf = (v) => (Number.isFinite(v) && v > 0 && v < LATEST_TIME ? v : null);

function scheduleDoc(db) {
    const doc = readDocument(db, BACKUP_SCHEDULE_KEY, null);
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
}

function scheduleState(db, shape) {
    const doc = scheduleDoc(db);
    return {
        since: doc.shape === shape ? timeOf(doc.since) : null,
        skippedAt: timeOf(doc.skippedAt),
        answeredWindowEnd: timeOf(doc.answeredWindowEnd),
        heldUntil: timeOf(doc.heldUntil),
    };
}

function writeSchedule(db, fields) {
    writeDocument(db, BACKUP_SCHEDULE_KEY, { ...scheduleDoc(db), ...fields });
}

// t's local day moved d days, at an hour; shifted at noon, so a clock change never moves the day
function dayAt(t, d, hour) {
    const x = new Date(t);
    x.setHours(12, 0, 0, 0);
    x.setDate(x.getDate() + d);
    x.setHours(hour, 0, 0, 0);
    return x.getTime();
}

const shiftDays = (t, days) => { const x = new Date(t); x.setDate(x.getDate() + days); return x.getTime(); };

// the window's occurrences around t, server-local; one past midnight ends the next day, one the spring change swallows keeps an hour
function windowsAround(t, startHour, endHour) {
    const out = [];
    for (let d = -2; d <= 1; d++) {
        const start = dayAt(t, d, startHour);
        const end = dayAt(t, d + (endHour <= startHour ? 1 : 0), endHour);
        out.push({ start, end: Math.max(end, start + 3600000) });
    }
    return out;
}

// the first occurrence that starts at or after t and once any hold is over; null when none does within the search
function windowStartingFrom(t, startHour, endHour, heldUntil) {
    for (let i = 0, from = t; i < WINDOW_SEARCH_DAYS && Number.isFinite(from); i++, from += DAY_MS) {
        const w = windowsAround(from, startHour, endHour).find(o => o.start >= t && o.start >= (heldUntil ?? -Infinity));
        if (w) return w;
    }
    return null;
}

/**
 * When this account's next automatic backup runs and whether one was missed; null while the schedule is off.
 * @returns {{ runNow: boolean, windowEnd: number|null, nextRun: number|null, missed: {windowEnd: number}|null, recheckAt: number|null }|null}
 */
export function backupSchedule(db, dir, { now = Date.now() } = {}) {
    const settings = backupSettings(db);
    const shape = shapeOf(settings);
    if (!shape) return null;
    const every = BACKUP_FREQUENCIES[settings.frequency];
    const user = ownerOf(db);
    const busy = !!liveJobOf(user);
    const state = scheduleState(db, shape);
    const latest = timeOf(listBackups(dir)[0]?.mtime);
    const { windowStart, windowEnd } = settings;
    const anyTime = windowStart === windowEnd;
    // with a window, due a day short in local days, run in the first window starting after: daily is every night
    const dueFrom = (t) => (t === null ? -Infinity : anyTime ? t + every : shiftDays(t, every / DAY_MS - 1));
    const dueAt = Math.max(dueFrom(latest), dueFrom(state.skippedAt));
    const heldUntil = state.heldUntil ?? -Infinity;
    if (anyTime) {
        const from = Math.max(dueAt, heldUntil);
        return { runNow: !busy && now >= from, windowEnd: null, nextRun: Math.max(from, now), missed: null, recheckAt: null };
    }
    const around = windowsAround(now, windowStart, windowEnd);
    const current = around.find(w => w.start <= now && now < w.end && dueAt <= w.start && w.start >= heldUntil) || null;
    const lastEnded = around.filter(w => w.end <= now).at(-1);
    // a schedule not yet seen in this shape counts from now, so switching it on or changing it is never a missed window
    const since = state.since ?? now;
    const missed = !busy && lastEnded && dueAt <= lastEnded.start && since <= lastEnded.start && lastEnded.end > (state.answeredWindowEnd ?? -Infinity)
        ? { windowEnd: lastEnded.end } : null;
    const next = current ? null : windowStartingFrom(Math.max(dueAt, now), windowStart, windowEnd, heldUntil);
    return {
        runNow: !busy && !!current,
        windowEnd: current ? current.end : null,
        nextRun: current ? now : next?.start ?? null,
        missed,
        // the next window's end, when a missed window can appear with no backup to say so
        recheckAt: around.find(w => w.end > now)?.end ?? null,
    };
}

/** The scheduler's look at one account: the schedule's shape and since when it holds kept true, then the schedule. */
export function tickBackupSchedule(db, dir, { now = Date.now() } = {}) {
    const shape = shapeOf(backupSettings(db));
    const doc = scheduleDoc(db);
    if ((doc.shape ?? null) !== shape || (shape && timeOf(doc.since) === null)) writeSchedule(db, { shape, since: shape ? now : null });
    return backupSchedule(db, dir, { now });
}

/**
 * The account's answer to a missed window: tonight waits for the next one, skip counts the missed one as taken.
 * @param {'tonight'|'skip'} answer
 */
export function answerMissedBackup(db, dir, answer, { now = Date.now() } = {}) {
    if (answer !== 'tonight' && answer !== 'skip') throw httpError(400, "answer is 'tonight' or 'skip'");
    const missed = backupSchedule(db, dir, { now })?.missed;
    if (!missed) throw httpError(409, 'no missed backup to answer');
    writeSchedule(db, answer === 'tonight' ? { answeredWindowEnd: missed.windowEnd } : { skippedAt: missed.windowEnd });
    announce(db, null);
    return { answer, windowEnd: missed.windowEnd };
}

// ========================================
// THE JOB: one copy at a time, server-wide, in a child process
// ========================================

// ids go on from the clock, so a tab holding one from before a restart never meets it again
let _seq = Date.now();
let _running = null;
const _queue = [];
// user -> the last job that ended, until it is dismissed or another starts
const _ended = new Map();
let _idleWaiters = [];
let _exitHooked = false;

const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };

function viewOf(job) {
    if (!job) return null;
    const copying = job.status === 'running' && job.phase === 'copy';
    return {
        id: job.id, status: job.status, phase: job.phase, done: copying ? sizeOf(job.tmp) : null, total: job.total,
        stopping: job.cancelled && job.status === 'running', scheduled: job.scheduled,
        queuedAt: job.queuedAt, startedAt: job.startedAt, endedAt: job.endedAt, error: job.error, file: job.status === 'done' ? job.file : null, bytes: job.bytes,
    };
}

// every tab re-reads, the starting one too: a job's word is no tab's own
function announce(db, job) {
    runWithRequest({ clientId: null }, () => emitChange(db, { entity: 'backup', op: 'updated', ids: job ? [job.id] : [] }));
}

function liveJobOf(user) {
    if (_running?.user === user) return _running;
    return _queue.find(j => j.user === user) || null;
}

// a server that stops takes its copy down with it; a signal then goes on to end the process as it would have
function hookExit() {
    if (_exitHooked) return;
    _exitHooked = true;
    const stop = () => { if (_running?.proc) killTree(_running.proc); };
    process.once('exit', stop);
    for (const signal of ['SIGTERM', 'SIGINT']) {
        process.once(signal, () => {
            stop();
            if (!process.listenerCount(signal)) process.kill(process.pid, signal);
        });
    }
}

/**
 * Queue a backup of this library; one runs at a time across the server.
 * @param {{ backupsDir: string, dbFile: string }} paths
 * @param {{ scheduled?: boolean, windowEnd?: number|null, onEnd?: Function }} [opts]
 * @returns the job's view
 */
export function startBackup(db, paths, { scheduled = false, windowEnd = null, onEnd = null } = {}) {
    const user = ownerOf(db);
    if (liveJobOf(user)) throw httpError(409, 'a backup is already running');
    const job = {
        id: ++_seq, user, db, dir: paths.backupsDir, dbFile: paths.dbFile, keep: backupSettings(db).keep, scheduled, windowEnd, onEnd,
        status: 'queued', phase: null, total: null, queuedAt: Date.now(), startedAt: null, endedAt: null, error: null,
        file: null, bytes: null, pruned: [], tmp: null, proc: null, cancelled: false, forgotten: false,
    };
    _ended.delete(user);
    _queue.push(job);
    announce(db, job);
    pump();
    return viewOf(job);
}

function pump() {
    while (!_running && _queue.length) {
        const job = _queue.shift();
        _running = job;
        try {
            begin(job);
        } catch (e) {
            end(job, 'failed', e);
        }
    }
    if (!_running && !_queue.length) for (const resolve of _idleWaiters.splice(0)) resolve();
}

function sweepTorn(dir) {
    // a copy cut short leaves a .tmp and its journal, which nothing lists; the next run clears them
    for (const f of fs.readdirSync(dir)) {
        if (f.startsWith('library-') && /\.db\.tmp(?:-journal)?$/.test(f)) {
            try { fs.unlinkSync(path.join(dir, f)); } catch { /* still held: the next run tries again */ }
        }
    }
}

function removeCopy(job) {
    for (const f of [job.tmp, `${job.tmp}-journal`]) {
        try { fs.unlinkSync(f); } catch { /* absent, or the next run sweeps it */ }
    }
}

function begin(job) {
    fs.mkdirSync(job.dir, { recursive: true });
    sweepTorn(job.dir);
    // second-resolution stamp, so two backups in one second need a suffix or VACUUM INTO refuses
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let file = path.join(job.dir, `library-${stamp}.db`);
    for (let n = 2; fs.existsSync(file) && n < 100; n++) file = path.join(job.dir, `library-${stamp}-${n}.db`);
    // tmp-then-rename: the final name only ever holds a complete, verified copy
    job.file = path.basename(file);
    job.tmp = `${file}.tmp`;
    try { job.total = copyBytes(job.db); } catch { job.total = libraryBytes(job.dbFile); }
    job.status = 'running';
    job.phase = 'copy';
    job.startedAt = Date.now();
    hookExit();
    const proc = spawn(process.execPath, [COPIER, job.dbFile, job.tmp], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    job.proc = proc;
    let out = '', err = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
        out += d;
        if (job.phase === 'copy' && /^verify$/m.test(out)) {
            job.phase = 'verify';
            if (!job.forgotten) announce(job.db, job);
        }
    });
    proc.stderr.on('data', (d) => { err = (err + d).slice(-ERROR_MAX); });
    proc.on('error', (e) => {
        removeCopy(job);
        end(job, 'failed', `could not start the backup: ${e.message}`);
    });
    proc.on('close', (code) => settle(job, code, err));
    announce(job.db, job);
}

// the child's own reason: its one line, or a crash's error line, never the version banner, a stack frame or a brace
function reasonOf(err) {
    const lines = err.split(/\r?\n/).map(l => l.trim()).filter(l => /[A-Za-z]/.test(l) && !/^Node\.js v\d/.test(l) && !/^at /.test(l));
    return lines.find(l => /^\w*Error\b/.test(l)) || lines.pop() || null;
}

function settle(job, code, err) {
    if (job.status !== 'running') return;
    if (job.cancelled) {
        removeCopy(job);
        return end(job, 'cancelled');
    }
    if (code !== 0) {
        removeCopy(job);
        return end(job, 'failed', reasonOf(err) || `the backup copy stopped (exit code ${code})`);
    }
    const file = path.join(job.dir, job.file);
    try {
        fs.renameSync(job.tmp, file);
        job.bytes = fs.statSync(file).size;
    } catch (e) {
        removeCopy(job);
        return end(job, 'failed', e);
    }
    // retention prunes only after the new copy landed under its name, never before
    for (const old of listBackups(job.dir).slice(job.keep)) {
        try { fs.unlinkSync(path.join(job.dir, old.file)); job.pruned.push(old.file); } catch { /* not a failed backup: the copy landed, and pruned lists only what went */ }
    }
    end(job, 'done');
}

function end(job, status, error = null) {
    job.status = status;
    job.phase = null;
    job.endedAt = Date.now();
    job.error = error ? String(error?.message || error).slice(0, ERROR_MAX) : null;
    job.proc = null;
    if (_running === job) _running = null;
    if (!job.forgotten) {
        // a scheduled backup that did not land waits out its window (any time: a day), across a restart too
        if (job.scheduled && status !== 'done') {
            try { writeSchedule(job.db, { heldUntil: job.windowEnd ?? job.endedAt + DAY_MS }); } catch (e) { console.error('[backup] the hold could not be kept:', e.message); }
        }
        _ended.set(job.user, job);
        announce(job.db, job);
    }
    try { job.onEnd?.(viewOf(job)); } catch (e) { console.error('[backup] an end callback failed:', e); }
    job.onEnd = null;
    pump();
}

/** The account's backup: the running or queued one, else the last that ended; a missed window when none is live; when to look again. */
export function backupActivity(db, dir, { now = Date.now() } = {}) {
    const user = ownerOf(db);
    const live = liveJobOf(user);
    const schedule = backupSchedule(db, dir, { now });
    return { job: viewOf(live || _ended.get(user) || null), missed: live ? null : schedule?.missed ?? null, recheckAt: schedule?.recheckAt ?? null };
}

/**
 * Cancel this account's queued or running backup, or with dismiss let go of the one that ended; the two never stand in for each other.
 * @returns the job's view, or null when the account holds none by that id
 */
export function cancelBackup(db, id, { dismiss = false } = {}) {
    const user = ownerOf(db);
    const live = liveJobOf(user);
    if (live?.id === id) {
        if (dismiss) throw httpError(409, 'the backup is still running');
        if (live === _running) {
            live.cancelled = true;
            killTree(live.proc);
            announce(db, live);
        } else {
            _queue.splice(_queue.indexOf(live), 1);
            end(live, 'cancelled');
        }
        return viewOf(live);
    }
    const ended = _ended.get(user);
    if (ended?.id !== id) return null;
    if (!dismiss) throw httpError(409, 'the backup already ended');
    _ended.delete(user);
    announce(db, ended);
    return viewOf(ended);
}

/** An account leaves: its queued backup never starts, its running one is killed, nothing of it is kept. */
export function forgetAccountBackups(user) {
    for (const job of _queue.filter(j => j.user === user)) {
        _queue.splice(_queue.indexOf(job), 1);
        job.forgotten = true;
        end(job, 'cancelled');
    }
    if (_running?.user === user) {
        _running.forgotten = true;
        _running.cancelled = true;
        killTree(_running.proc);
    }
    _ended.delete(user);
}

/**
 * Take a backup and wait for it, for a tool that backs up before it changes anything.
 * @returns {Promise<object>} the ended job; rejects in its words when the copy did not land
 */
export function takeBackup(db, paths) {
    return new Promise((resolve, reject) => {
        startBackup(db, paths, { onEnd: (job) => (job.status === 'done' ? resolve(job) : reject(new Error(job.error || `the backup ended ${job.status}`))) });
    });
}

/** Resolves once no backup is queued or running. */
export function whenBackupsIdle() {
    if (!_running && !_queue.length) return Promise.resolve();
    return new Promise(resolve => _idleWaiters.push(resolve));
}
