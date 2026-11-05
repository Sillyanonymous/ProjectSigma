// The full-text indexes kept in one large segment, merged by a child of the server so a long merge never holds its event loop
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { SERVER_SCOPE, emitChange, runWithRequest, subscribeChanges } from './changes.js';
import { readDocument, writeDocument } from './documents-store.js';
import { settingValue } from './settings-store.js';
import { performance } from 'node:perf_hooks';
import { backupLive } from '../lib/backup-core.js';
import { killTree, onServerExit } from '../lib/kill-tree.js';

export const FTS_TABLES = Object.freeze(['characters_fts', 'chat_messages_fts', 'world_entries_fts']);
// each index as the API names it
const INDEX_NAMES = Object.freeze({ characters_fts: 'cards', chat_messages_fts: 'chats', world_entries_fts: 'lorebooks' });
// a lookup reads a leaf of every segment, so a segment holding a sixteenth of its index's pages is one worth merging away
const LARGE_SHARE = 1 / 16;
// an index of fewer pages than this is soon read whole into memory, so a merge buys it nothing
export const MIN_PAGES = 256;
// a related open asks this many words, and each segment costs a word one leaf, never more than the segment holds
const LOOKUP_WORDS = 150;
// what a lookup reads against the same index merged, from which the index merges on its own
export const DRIFT_LIMIT = 2;
// pages a step: a cold disk ends a merge soonest in small steps, and a write waits at most one of them
const STEP_PAGES = 64;
// a step slower than this halves the next one, as any write waits out a whole step; never under the floor
const SLOW_STEP_MS = 400;
const MIN_STEP_PAGES = 4;
// FTS5's crisis merge: the save that brings a level to this many segments merges that whole level
const CRISIS_MERGE = 16;
// held at this while a merge of ours is open this low, so no crisis cascade finishes it inside a save
const CRISIS_HELD = 1000;
const SHALLOW_LEVEL = 3;
// rules: what an idle library's tidy-up merges (any index a rule wants), what an asked one does (every index in pieces)
const RULES = Object.freeze(['any', 'all']);
// paces: idle, a short rest between steps, as nobody is waiting; gentle, a rest as long as each step took, for writes
const PACES = Object.freeze(['idle', 'gentle']);
const STEP_GAP_MS = 100;
// a library sits this long with no input in any tab and no write before an automatic tidy-up starts
const IDLE_MS = 2 * 60_000;
// a running merge's progress reaches the tabs no more often than this
const PROGRESS_GAP_MS = 2000;
// the last tidy-up and the last failure, per library
export const UPKEEP_KEY = 'search-index-upkeep';

/** The leaves each segment of an index lists in its _idx table, largest first. */
export function ftsSegments(db, table) {
    return db.prepare(`SELECT COUNT(*) FROM ${table}_idx GROUP BY segid ORDER BY 1 DESC`).pluck().all();
}

// ============================================================================
// an index's shape: its structure record, read as SQLite's fts5StructureDecode reads it
// ============================================================================

const STRUCTURE_ROWID = 10;
const STRUCTURE_V2 = Object.freeze([0xff, 0x00, 0x00, 0x01]);
const MAX_SEGMENTS = 2000;
const MAX_LEVEL = 64;

/** Every segment of an index with its level, pages and whether a merge reads it, and its level count; null when it does not decode. */
export function ftsStructure(db, table) {
    const buf = db.prepare(`SELECT block FROM ${table}_data WHERE id = ${STRUCTURE_ROWID}`).pluck().get();
    if (!Buffer.isBuffer(buf) || buf.length < 6) return null;
    const v2 = STRUCTURE_V2.every((b, k) => buf[4 + k] === b);
    let i = v2 ? 8 : 4;
    // seven bits a byte while the high bit is set, the ninth byte whole
    const read = () => {
        let v = 0;
        for (let n = 0; n < 9; n++) {
            if (i >= buf.length) throw new RangeError('the record ends early');
            const b = buf[i++];
            if (n === 8) return v * 256 + b;
            v = v * 128 + (b & 0x7f);
            if (!(b & 0x80)) return v;
        }
        return v;
    };
    try {
        const nLevel = read(), nSegment = read();
        read();
        if (nLevel > MAX_SEGMENTS || nSegment > MAX_SEGMENTS) return null;
        const segments = [];
        for (let level = 0; level < nLevel; level++) {
            const nMerge = read(), nSeg = read();
            if (nMerge > nSeg) return null;
            for (let s = 0; s < nSeg; s++) {
                const id = read(), first = read(), last = read();
                if (v2) for (let k = 0; k < 5; k++) read();
                if (last < first) return null;
                // a merge trims what it has read off its inputs; one read to its end lists no pages until the merge ends
                segments.push({ id, level, pages: last === 0 ? 0 : last - first + 1, input: s < nMerge });
            }
        }
        return segments.length === nSegment ? { segments, nLevel } : null;
    } catch {
        return null;
    }
}

// each segment's pages off the structure record, the leaves _idx lists where the record does not decode
function segmentSizes(db, table) {
    const st = ftsStructure(db, table);
    return st ? st.segments.map(s => s.pages).filter(n => n > 0) : ftsSegments(db, table);
}

// whether a merge is open on the index: a segment its merge has not read to the end
const isOpen = (st) => !!st?.segments.some(s => s.input && s.pages > 0);
const mergeOpen = (db, table) => isOpen(ftsStructure(db, table));

// the rules on segment sizes: two each holding a sixteenth of the pages, and what a lookup reads against the index merged
const largeTwice = (sizes, minPages) => {
    const total = sizes.reduce((a, n) => a + n, 0);
    return total >= minPages && sizes.filter(n => n >= total * LARGE_SHARE).length >= 2;
};
const driftOf = (sizes) => {
    const pages = sizes.reduce((a, n) => a + n, 0);
    return pages ? sizes.reduce((a, n) => a + Math.min(n, LOOKUP_WORDS), 0) / Math.min(pages, LOOKUP_WORDS) : 1;
};
const sizesWant = (sizes) => largeTwice(sizes, MIN_PAGES) || driftOf(sizes) >= DRIFT_LIMIT;

const crisisSetting = (db, table) => Number(db.prepare(`SELECT v FROM ${table}_config WHERE k = 'crisismerge'`).pluck().get() ?? CRISIS_MERGE);
// FTS5 takes a config value only as a literal
const setCrisis = (db, table, n) => db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES ('crisismerge', ${n})`).run();

// the level a merge's inputs sit on: the open one's, else where FTS5's optimize puts them (one level is kept as it is)
function inputLevel(st) {
    const inputs = st.segments.filter(s => s.input);
    if (inputs.length) return Math.min(...inputs.map(s => s.level));
    const levels = new Set(st.segments.filter(s => s.pages > 0).map(s => s.level));
    return levels.size === 1 ? [...levels][0] : Math.min(st.nLevel, MAX_LEVEL - 1);
}

// pieces saved while crisis merges were held off are merged a page a step, never spilling onto the large segment, before they come back on
function releaseCrisis(db, table) {
    const step = db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES ('merge', 1)`);
    const changes = db.prepare('SELECT total_changes()').pluck();
    for (let n = 0; n < 256; n++) {
        const first = ftsStructure(db, table)?.segments.filter(s => s.level === 0) ?? [];
        if (!first.some(s => s.input && s.pages > 0) && first.filter(s => s.pages > 0).length < CRISIS_MERGE) break;
        const was = changes.get();
        step.run();
        if (changes.get() - was < 2) break;
    }
    setCrisis(db, table, CRISIS_MERGE);
}

// near its end a step asks for a quarter of what the inputs have left, so the step ending a merge cannot spill
function stepBudget(db, table, pages) {
    const st = ftsStructure(db, table);
    const inputs = st?.segments.filter(s => s.input) ?? [];
    const left = inputs.reduce((a, s) => a + s.pages, 0);
    if (!inputs.length || left <= 0 || left > pages * 4) return pages;
    const level = Math.min(...inputs.map(s => s.level));
    const merging = inputs.filter(s => s.level === level).length;
    // a lower level FTS5 merges first keeps the full budget, so the step still reaches this merge
    const outranked = st.segments.some(s => s.level < level && st.segments.filter(g => g.level === s.level).length >= merging);
    return outranked ? pages : Math.max(1, Math.floor(left / 4));
}

// each segment's pages once the open merge ends, its output then holding what its inputs have left
function sizesAfterMerge(st) {
    const inputs = st.segments.filter(s => s.input);
    const out = st.segments.filter(s => s.level === inputs[0].level + 1).at(-1);
    const rest = st.segments.filter(s => !s.input && s !== out && s.pages > 0).map(s => s.pages);
    return [inputs.reduce((a, s) => a + s.pages, out?.pages ?? 0), ...rest];
}

/** Whether a lookup in this index reads more than one large segment: two each holding a sixteenth of its pages. */
export function ftsNeedsMerge(db, table, minPages = MIN_PAGES) {
    return largeTwice(segmentSizes(db, table), minPages);
}

/** An index's segments and pages, and what a lookup in it reads against the same index merged; null when its record does not decode. */
export function ftsDrift(db, table) {
    const st = ftsStructure(db, table);
    if (!st) return null;
    const held = st.segments.map(s => s.pages).filter(n => n > 0);
    return { segments: held.length, pages: held.reduce((a, n) => a + n, 0), drift: driftOf(held) };
}

/** Whether the upkeep merges this index on its own: two large segments, drift at the limit, or a merge a pause left open. */
export function ftsWantsMerge(db, table) {
    const st = ftsStructure(db, table);
    if (!st) return ftsNeedsMerge(db, table);
    return isOpen(st) || sizesWant(st.segments.map(s => s.pages).filter(n => n > 0));
}

/**
 * One index merged into one segment a bounded step at a time (the FTS5 incremental optimize).
 * @param {{ pages?: number, pause?: (tookMs: number, pages: number) => void, whole?: boolean, slowMs?: number }} [opts] whole ends in one segment; slowMs halves a step after a slower one
 * @returns {{ steps: number, open: boolean }} the steps it ran, and whether it ended with a merge still open
 */
export function mergeFts(db, table, { pages = STEP_PAGES, pause = () => {}, whole = false, slowMs = 0 } = {}) {
    const merge = db.prepare(`INSERT INTO ${table}(${table}, rank) VALUES ('merge', ?)`);
    const changes = db.prepare('SELECT total_changes()').pluck();
    const st = ftsStructure(db, table);
    if (st && inputLevel(st) <= SHALLOW_LEVEL && crisisSetting(db, table) !== CRISIS_HELD) setCrisis(db, table, CRISIS_HELD);
    // negative merges every segment (FTS5 goes on with an open merge when only its output stands beside it); positive resumes the open one
    let negative = whole || !isOpen(st) || sizesWant(sizesAfterMerge(st));
    const most = Math.max(pages, STEP_PAGES);
    let nudged = false;
    const end = (steps) => {
        const open = mergeOpen(db, table);
        if (!open && crisisSetting(db, table) === CRISIS_HELD) releaseCrisis(db, table);
        return { steps, open };
    };
    for (let steps = 1; ; steps++) {
        const was = changes.get();
        const started = performance.now();
        const ran = negative ? pages : stepBudget(db, table, pages);
        merge.run(negative ? -ran : ran);
        negative = false;
        if (changes.get() - was < 2) {
            // a step that moved nothing while inputs wait unread: once, every segment onto one level to carry on
            if (!nudged && mergeOpen(db, table)) { nudged = true; negative = true; continue; }
            return end(steps);
        }
        // done once no merge is open: pieces saved meanwhile are left for later, so a stream of writes never keeps it going
        if (!mergeOpen(db, table)) return end(steps);
        nudged = false;
        const took = performance.now() - started;
        if (slowMs) pages = took > slowMs ? Math.max(MIN_STEP_PAGES, pages >> 1) : took < slowMs / 4 ? Math.min(most, pages * 2) : pages;
        pause(took, ran);
    }
}

// ============================================================================
// the server's half: an automatic tidy-up when the library sits idle, an asked one at once; one child at a time
// ============================================================================

const SELF = fileURLToPath(import.meta.url);
let _running = null;
// libraries whose asked tidy-up waits for their backup or another library's asked one
const _queue = [];
const _timers = new WeakMap();
let _exitHooked = false;

const autoTidy = (db) => settingValue(db, 'autoTidySearchIndex', true) !== false;
const upkeepDoc = (db) => { const d = readDocument(db, UPKEEP_KEY, null); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; };
const firstUntidy = (db) => FTS_TABLES.find((t) => (ftsDrift(db, t)?.segments ?? ftsSegments(db, t).length) > 1) || null;

/** The look's decision on the server's loop: the child's own rule, or a bounded read of _idx where a record does not decode. */
export function ftsLookWants(db) {
    return FTS_TABLES.some((t) => {
        if (ftsStructure(db, t)) return ftsWantsMerge(db, t);
        const leaves = db.prepare(`SELECT COUNT(*) FROM (SELECT 1 FROM ${t}_idx LIMIT ${MIN_PAGES})`).pluck().get();
        const first = db.prepare(`SELECT segid FROM ${t}_idx ORDER BY segid LIMIT 1`).pluck().get();
        return leaves >= MIN_PAGES && db.prepare(`SELECT 1 FROM ${t}_idx WHERE segid > ? LIMIT 1`).pluck().get(first) !== undefined;
    });
}

function lookAt(db) {
    if (!autoTidy(db)) return;
    // a backup reading the library would hold every page a merge rewrites in the WAL until it ends: look again later
    if (backupLive(db)) { scheduleFtsMerge(db); return; }
    // a tidy-up that stopped is tried again in full; with nothing left in pieces its failure is let go
    if (upkeepDoc(db).failure) {
        if (firstUntidy(db)) { startMerge(db, { rules: 'all', pace: 'idle', reason: 'auto' }); return; }
        writeDocument(db, UPKEEP_KEY, { ...upkeepDoc(db), failure: null });
        announce(db);
    }
    if (ftsLookWants(db)) startMerge(db, { rules: 'any', pace: 'idle', reason: 'auto' });
}

/** Look at a library's indexes once it sits idle for wait, merging what needs it in a child; a call while one waits joins it. */
export function scheduleFtsMerge(db, wait = IDLE_MS) {
    if (_timers.has(db)) return;
    const timer = setTimeout(() => {
        _timers.delete(db);
        if (!db.open) return;
        // another library's child holds the lane: this one looks again after another idle spell
        if (_running) { if (_running.db !== db) scheduleFtsMerge(db); return; }
        try {
            lookAt(db);
        } catch (e) { console.error('[fts] the segment check failed:', e.message); }
    }, wait);
    timer.unref?.();
    _timers.set(db, timer);
}

// paused once, nothing recorded; the child starts nothing of its own, so a kill of its one process never blocks the loop
function pauseRun(run) {
    if (run.paused) return;
    run.paused = true;
    if (run.proc.exitCode === null && run.proc.signalCode === null) run.proc.kill();
    // a paused merge gives FTS5's crisis merges back, or the saves made while it waits pile up on level 0
    if (!run.db.open) return;
    for (const t of FTS_TABLES) {
        try { if (crisisSetting(run.db, t) === CRISIS_HELD) setCrisis(run.db, t, CRISIS_MERGE); } catch (e) { console.error('[fts] a crisis hold could not be let go:', e.message); }
    }
}

// an asked tidy-up takes the lane: an automatic one holding it pauses, its library looking again after its next idle spell
function takeLane() {
    const run = _running;
    if (!run) return;
    pauseRun(run);
    _running = null;
    scheduleFtsMerge(run.db);
}

/** The library is in use (the reader's input, or a write): an automatic tidy-up of it pauses, and the look waits for idle again. */
export function noteFtsActivity(db, idleMs = IDLE_MS) {
    if (_running?.db === db && _running.reason === 'auto') pauseRun(_running);
    clearTimeout(_timers.get(db));
    _timers.delete(db);
    scheduleFtsMerge(db, idleMs);
}

/** A library's waiting look and running merge stopped, before it closes, so no child holds its file. */
export function stopFtsMerge(db) {
    clearTimeout(_timers.get(db));
    _timers.delete(db);
    const queued = _queue.indexOf(db);
    if (queued >= 0) _queue.splice(queued, 1);
    if (_running?.db === db) {
        const { proc } = _running;
        pauseRun(_running);
        _running = null;
        // the library closes next: wait the child out, so nothing holds its file
        killTree(proc);
    }
}

/** Every index in pieces merged, as Settings asks: never paused by the reader, outranking an automatic tidy-up, waiting for a backup or another asked one. */
export function tidyFtsNow(db) {
    if (_running?.db === db && _running.reason === 'asked') return { started: true, running: ftsMergeActivity(db) };
    if (_queue.includes(db)) return { started: true, queued: true, running: null };
    if (!firstUntidy(db)) return { started: false };
    if (backupLive(db) || _running?.reason === 'asked') {
        _queue.push(db);
        announce(db);
        return { started: true, queued: true, running: null };
    }
    takeLane();
    startAsked(db);
    return { started: true, running: ftsMergeActivity(db) };
}

// an asked tidy-up names the first index it will merge and its pages at once, so the reader sees it running from the first read
function startAsked(db) {
    const table = firstUntidy(db);
    const total = table ? segmentSizes(db, table).reduce((a, n) => a + n, 0) : 0;
    startMerge(db, { rules: 'all', pace: 'gentle', reason: 'asked', index: table ? INDEX_NAMES[table] : null, total });
}

// the first library waiting with an asked tidy-up whose backup is not running, once no asked one holds the lane
function startQueued() {
    while (_running?.reason !== 'asked') {
        const at = _queue.findIndex(db => !db.open || !backupLive(db));
        if (at < 0) return;
        const [db] = _queue.splice(at, 1);
        if (!db.open) continue;
        if (!firstUntidy(db)) { announce(db); continue; }
        takeLane();
        startAsked(db);
    }
}

// a backup goes first: a tidy-up of its library pauses, an asked one waiting at the head of the queue until the backup ends
function backupMoved(db) {
    if (backupLive(db) && _running?.db === db) {
        const run = _running;
        pauseRun(run);
        _running = null;
        if (run.reason === 'asked' && !_queue.includes(db)) {
            _queue.unshift(db);
            announce(db);
        }
    }
    startQueued();
}

function hookExit() {
    if (_exitHooked) return;
    _exitHooked = true;
    onServerExit(() => { if (_running?.proc) killTree(_running.proc); });
}

/** The index a library's merge is tidying, since when, how far along, and whether it was asked: only once its first index is known. */
export function ftsMergeActivity(db) {
    if (_running?.db !== db || !_running.index) return null;
    const { index, since, done, total, reason } = _running;
    return { index, since, done, total, reason };
}

/** The library's search index for Settings: each index's shape and drift, the last tidy-up and failure, the one running or waiting. */
export function ftsUpkeepStatus(db) {
    const pageSize = db.pragma('page_size', { simple: true });
    const doc = upkeepDoc(db);
    return {
        indexes: FTS_TABLES.map((t) => {
            const d = ftsDrift(db, t);
            // down, never up: a drift a hair under the limit never reads as the limit the rule has not reached
            return { index: INDEX_NAMES[t], segments: d?.segments ?? null, bytes: d ? d.pages * pageSize : null, drift: d ? Math.floor(d.drift * 100) / 100 : null };
        }),
        driftLimit: DRIFT_LIMIT,
        last: doc.last ?? null,
        failure: doc.failure ?? null,
        running: ftsMergeActivity(db),
        // what an asked tidy-up waits for: this library's backup, or another library's asked tidy-up
        queued: _queue.includes(db) ? (backupLive(db) ? 'backup' : 'library') : null,
        auto: autoTidy(db),
    };
}

// every tab re-reads, the one whose write set the look off too: a merge is no tab's own
function announce(db) {
    if (db.open) runWithRequest({ clientId: null }, () => emitChange(db, { entity: 'maintenance', op: 'updated', ids: [] }));
}

function recordUpkeep(db, run) {
    const at = Date.now();
    writeDocument(db, UPKEEP_KEY, { ...upkeepDoc(db), last: { at, ms: at - run.startedAt, indexes: run.finished, reason: run.reason }, failure: null });
}

function recordFailure(db, run, error) {
    writeDocument(db, UPKEEP_KEY, { ...upkeepDoc(db), failure: { at: Date.now(), index: run.index, error, reason: run.reason } });
}

function startMerge(db, { rules, pace, reason, index = null, total = 0 }) {
    hookExit();
    const proc = spawn(process.execPath, [SELF, db.name, rules, pace], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const now = Date.now();
    const run = { db, proc, reason, index, since: index ? now : null, done: 0, total, startedAt: now, finished: [], told: 0, paused: false, stalled: null };
    _running = run;
    if (index) announce(db);
    let out = '', err = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
        const lines = (out + d).split('\n');
        out = lines.pop();
        for (const line of lines) {
            if (_running !== run) continue;
            const [head, a, b] = line.trim().split(' ');
            if (head === 'done') {
                if (INDEX_NAMES[a]) run.finished.push({ index: INDEX_NAMES[a], ms: Number(b) || 0 });
                continue;
            }
            if (head === 'stalled') { run.stalled = INDEX_NAMES[a] || a; continue; }
            const named = INDEX_NAMES[head];
            if (!named) continue;
            const fresh = run.index !== named;
            run.index = named;
            run.since ??= Date.now();
            run.done = Number(a) || 0;
            run.total = Number(b) || 0;
            if (fresh || Date.now() - run.told >= PROGRESS_GAP_MS) {
                run.told = Date.now();
                announce(db);
            }
        }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const end = (code, signal) => {
        if (_running === run) _running = null;
        else if (!run.paused) return;
        // a paused child was stopped on purpose: its open merge is resumed later, nothing to record or report
        if (!run.paused && db.open) {
            const why = err.trim().split(/\r?\n/).pop() || (signal ? `signal ${signal}` : `exit code ${code}`);
            try {
                if (code === 0 && !run.stalled) { if (run.finished.length) recordUpkeep(db, run); }
                else recordFailure(db, run, run.stalled ? `the ${run.stalled} index could not finish merging` : why);
            } catch (e) { console.error('[fts] the tidy-up could not be recorded:', e.message); }
            if (code !== 0) console.error(`[fts] the index merge stopped: ${why}`);
        }
        if (run.index && db.open) announce(db);
        startQueued();
    };
    proc.on('error', (e) => { err = e.message; end(1, null); });
    proc.on('close', (code, signal) => end(code, signal));
}

// ============================================================================
// node fts-merge.js <library file> [any|all] [idle|gentle]: merges each index its rules want, the exit code says how it ended
// ============================================================================

// how far a merge is: the pages its inputs held at the start against those it has not read yet
function inputLeft(db, table) {
    const st = ftsStructure(db, table);
    return st ? st.segments.filter(s => s.input).reduce((a, s) => a + s.pages, 0) : null;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (isCli) {
    let db;
    try {
        const rules = RULES.includes(process.argv[3]) ? process.argv[3] : 'any';
        const pace = PACES.includes(process.argv[4]) ? process.argv[4] : 'gentle';
        db = new Database(process.argv[2], { fileMustExist: true, timeout: 30000 });
        const nap = new Int32Array(new SharedArrayBuffer(4));
        // gently, at least as long as the step took, so the server's writes find the lock free half the time or more
        const rest = (took) => Atomics.wait(nap, 0, 0, pace === 'idle' ? STEP_GAP_MS : Math.max(STEP_GAP_MS, took));
        for (const table of FTS_TABLES) {
            // a hold of ours left by a run that ended between its merge's end and the release
            if (!mergeOpen(db, table) && crisisSetting(db, table) === CRISIS_HELD) releaseCrisis(db, table);
            const wanted = rules === 'all' ? (segmentSizes(db, table).length > 1 || mergeOpen(db, table)) : ftsWantsMerge(db, table);
            if (!wanted) continue;
            const total = segmentSizes(db, table).reduce((a, n) => a + n, 0);
            const started = Date.now();
            let run = 0, done = 0;
            // sync writes: off Windows a pipe writes async, and the merge holds this loop until its end
            fs.writeSync(1, `${table} 0 ${total}\n`);
            // asked, every index ends whole; at either pace a slow step shrinks the next, as any write waits out the step in flight
            const result = mergeFts(db, table, { whole: rules === 'all', slowMs: SLOW_STEP_MS, pause: (took, pages) => {
                run += pages;
                const left = inputLeft(db, table);
                done = Math.min(total, Math.max(done, left === null ? run : total - left));
                fs.writeSync(1, `${table} ${done} ${total}\n`);
                rest(took);
            } });
            if (result.open) {
                fs.writeSync(1, `stalled ${table}\n`);
                process.stderr.write(`the merge of ${table} stopped with inputs unread\n`);
                process.exitCode = 3;
                break;
            }
            fs.writeSync(1, `${table} ${total} ${total}\n`);
            fs.writeSync(1, `done ${table} ${Date.now() - started}\n`);
        }
    } catch (e) {
        process.stderr.write(`${e?.message || String(e)}\n`);
        process.exitCode = 1;
    } finally {
        db?.close();
    }
} else {
    // every write to a library is activity, the upkeep's own record and notices aside; a backup's notices move the queue too
    subscribeChanges((owner, records, db) => {
        if (owner === SERVER_SCOPE || !db?.open) return;
        if (records.some(r => r.entity === 'backup')) backupMoved(db);
        if (records.some(r => r.entity !== 'maintenance' && !(r.entity === 'document' && r.ids?.includes(UPKEEP_KEY)))) noteFtsActivity(db);
    });
}
