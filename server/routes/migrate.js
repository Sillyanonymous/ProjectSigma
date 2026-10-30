import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { userPaths } from '../config.js';
import { migrationState } from '../importer/migrate-st.js';
import { refreshFtsIfOpen } from '../db/database.js';
import { emitChange, runWithRequest } from '../db/changes.js';
import { sseOpen, sseWrite } from '../llm/sse.js';
import { readJsonFile } from '../lib/json-file.js';
import { killTree } from '../lib/kill-tree.js';
import { httpError } from '../lib/http-error.js';

// The ST migration wizard, into the caller's own library only. a child process, since the engine is synchronous

export const migrateRouter = Router();

const CLI = fileURLToPath(new URL('../importer/migrate-st.js', import.meta.url));
const LOG_RING = 200;
let _run = null; // { mode, target, source, startedAt, proc, lines, done }
// a plan's child reads the library a run would write, so the two never overlap
let _plan = null; // { target }

// the caller's own home, always; a client still naming another account is told so
function targetOf(req, body) {
    const wanted = typeof body?.targetHandle === 'string' ? body.targetHandle.trim().toLowerCase() : '';
    if (wanted && wanted !== req.userHandle) throw httpError(400, 'a migration lands in your own library; there is no migrating into another account');
    return req.userHandle;
}

function sourceOf(body) {
    const p = typeof body?.path === 'string' ? body.path.trim() : '';
    if (!p) throw httpError(400, 'a SillyTavern user folder path is required');
    const abs = path.resolve(p);
    if (!fs.existsSync(path.join(abs, 'characters'))) {
        throw httpError(400, `no characters/ folder under ${abs}; point at the SillyTavern user data folder (usually data/default-user)`);
    }
    return abs;
}

// the CLI's own flags, from the wizard's options
function argsOf(body, target) {
    const args = ['--user', target];
    for (const t of Array.isArray(body?.excludeTags) ? body.excludeTags : []) if (typeof t === 'string' && t.trim()) args.push('--exclude-tag', t.trim());
    for (const n of Array.isArray(body?.only) ? body.only : []) if (typeof n === 'string' && n.trim()) args.push('--only', n.trim());
    if (Number.isInteger(body?.sample) && body.sample > 0) args.push('--sample', String(body.sample));
    if (body?.warmThumbs === true) args.push('--warm-thumbs');
    if (body?.verify === 'off' || body?.verify === 'fast' || body?.verify === 'full') args.push('--verify', body.verify);
    return args;
}

function reportPathFor(target, mode) {
    const root = userPaths(target).root;
    fs.mkdirSync(root, { recursive: true });
    return path.join(root, `migration-${mode}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
}

// the wizard names its report migration-run-<stamp> and the CLI migration-report-<stamp>: the stamp alone orders them
const REPORT_PREFIX = /^migration-(?:run|report)-/;

function newestReport(target) {
    let root;
    try { root = userPaths(target).root; } catch { return null; }
    if (!fs.existsSync(root)) return null;
    const stampOf = (f) => f.replace(REPORT_PREFIX, '');
    const files = fs.readdirSync(root).filter(f => REPORT_PREFIX.test(f) && f.endsWith('.json'));
    if (!files.length) return null;
    const file = files.reduce((newest, f) => (stampOf(f) > stampOf(newest) ? f : newest));
    const data = readJsonFile(path.join(root, file));
    return data ? { file, at: data.at ?? null, mode: data.mode ?? null, counts: data.counts ?? null, summary: data.summary ?? null, verify: data.verify ? { mode: data.verify.mode ?? null, checked: data.verify.checked ?? null, findings: (data.verify.findings || []).length } : null } : null;
}

function spawnCli(source, args) {
    return spawn(process.execPath, [CLI, source, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

// one line at a time off a pipe, whatever chunking the pipe uses
function lineReader(stream, onLine) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (line) onLine(line); }
    });
    stream.on('end', () => { if (buf.trim()) onLine(buf.replace(/\r$/, '')); buf = ''; });
}

function runningView() {
    if (!_run) return null;
    return { mode: _run.mode, target: _run.target, source: _run.source, startedAt: _run.startedAt, lines: _run.lines.slice(-LOG_RING) };
}

// one run per server; another account learns only that it is busy
function ownsRun(req) { return !!_run && _run.target === req.userHandle; }
function busyAnswer(req, res) {
    if (ownsRun(req)) return res.status(409).json({ error: `your migration ${_run.mode} is already running`, running: runningView() });
    if (!_run && _plan) return res.status(409).json({ error: 'a migration plan is being made on this server; try again when it finishes' });
    return res.status(409).json({ error: 'another migration is running on this server; try again when it finishes' });
}

/** The plan: the dry-run's report, nothing written. */
migrateRouter.post('/plan', (req, res) => {
    const target = targetOf(req, req.body), source = sourceOf(req.body);
    if (_run || _plan) return busyAnswer(req, res);
    // named past the second: two plans read in one second shared a file, and the first to close took it
    const report = reportPathFor(target, `plan-${randomUUID().slice(0, 8)}`);
    _plan = { target };
    const lines = [];
    const proc = spawnCli(source, [...argsOf(req.body, target), '--dry-run', '--report', report]);
    lineReader(proc.stdout, l => lines.push(l));
    lineReader(proc.stderr, l => lines.push(l));
    proc.on('error', (e) => {
        _plan = null;
        if (!res.headersSent) res.status(500).json({ error: `could not start the migration tool: ${e.message}` });
    });
    proc.on('close', (code) => {
        _plan = null;
        const plan = readJsonFile(report);
        try { fs.unlinkSync(report); } catch { /* the plan is answered, not kept */ }
        if (code !== 0 || !plan) return res.status(400).json({ error: lines.filter(l => /^ERROR|Error|refused|no characters/i.test(l)).join(' ') || `the migration tool exited with code ${code}`, lines });
        res.json({
            target,
            source,
            counts: plan.counts,
            duplicateGroups: plan.duplicateGroups || [],
            unmatchedChatDirs: plan.unmatchedChatDirs || [],
            groupChats: Array.isArray(plan.groupChats) ? plan.groupChats.length : (plan.groupChats ?? 0),
            worlds: Array.isArray(plan.worlds) ? plan.worlds.length : 0,
            state: migrationState(target),
            lines,
        });
    });
});

function streamRun(req, res, mode, args, target, source) {
    if (_run || _plan) return busyAnswer(req, res);
    const report = mode === 'run' ? reportPathFor(target, 'run') : null;
    const proc = spawnCli(source, report ? [...args, '--report', report] : args);
    _run = { mode, target, source, startedAt: Date.now(), proc, lines: [], done: false };
    sseOpen(res);
    sseWrite(res, 'started', { mode, target, source, startedAt: _run.startedAt });
    const push = (line) => {
        _run.lines.push(line);
        if (_run.lines.length > LOG_RING) _run.lines.splice(0, _run.lines.length - LOG_RING);
        sseWrite(res, 'line', { line });
    };
    lineReader(proc.stdout, push);
    lineReader(proc.stderr, push);
    proc.on('error', (e) => {
        _run = null;
        sseWrite(res, 'error', { message: `could not start the migration tool: ${e.message}`, kind: 'spawn' });
        res.end();
    });
    proc.on('close', (code) => {
        const cancelled = !!_run?.cancelled;
        _run = null;
        // the child wrote the library behind the server's live handle: its FTS structure is refreshed before anyone reads
        refreshFtsIfOpen(target);
        // the child's SQL skipped every store's report, so the whole library is announced once, from no tab
        runWithRequest({ clientId: null }, () => emitChange(req.db, { entity: 'library', op: 'changed', mode }));
        const payload = { mode, target, code, cancelled, report: null, state: migrationState(target) };
        if (report) payload.report = readJsonFile(report) ? newestReport(target) : null;
        sseWrite(res, 'done', payload);
        res.end();
    });
    // a closed stream is a reader who left, not a stop: the run keeps going and status keeps its tail
}

/** The migration itself, log streamed. */
migrateRouter.post('/run', (req, res) => {
    const target = targetOf(req, req.body), source = sourceOf(req.body);
    streamRun(req, res, 'run', argsOf(req.body, target), target, source);
});

/** Finalize: one last verify, then the ST-era aliases are purged (one-way). */
migrateRouter.post('/finalize', (req, res) => {
    const target = targetOf(req, req.body), source = sourceOf(req.body);
    const args = ['--user', target, '--finalize'];
    if (req.body?.verify === 'off' || req.body?.verify === 'fast' || req.body?.verify === 'full') args.push('--verify', req.body.verify);
    if (req.body?.force === true) args.push('--force');
    streamRun(req, res, 'finalize', args, target, source);
});

migrateRouter.post('/cancel', (req, res) => {
    if (!ownsRun(req)) return res.status(404).json({ error: 'no migration of yours is running' });
    _run.cancelled = true;
    killTree(_run.proc);
    res.json({ ok: true, mode: _run.mode });
});

migrateRouter.get('/status', (req, res) => {
    const target = targetOf(req, { targetHandle: req.query.targetHandle });
    res.json({ target, busy: !!_run || !!_plan, running: ownsRun(req) ? runningView() : null, lastReport: newestReport(target), state: migrationState(target) });
});
