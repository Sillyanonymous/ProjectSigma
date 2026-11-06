// Extension inventory and lifecycle. install, update and remove are admin-only: an extension is trusted code for everyone
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router } from 'express';
import { requireAdmin } from '../auth.js';
import { config } from '../config.js';
import { listExtensions, installFromGit, installFromZip, ZIP_INSTALL_LIMITS, updateExtension, removeExtension, extensionEnabledFor, setExtensionEnabledFor, forgetExtensionEverywhere, extensionUpdates, checkExtensionUpdates } from '../lib/extensions.js';
import { serverStateOf, markServerHalf, readyHalfFor, browserConsumerRegistrations } from '../lib/extensions-server.js';
import { serverHookRegistrations, serverHookStats } from '../lib/ext-hooks.js';
import { forEachOpenLibrary } from '../db/database.js';
import { emitChange } from '../db/changes.js';
import { listJobs, cancelJob, clearFinishedJobs, cancelExtensionJobs, scheduleRegistrations } from '../lib/ext-jobs.js';
import { queryDoorsOf } from '../db/ext-query.js';
import { PROVIDER_NAMESPACES } from '../lib/provider-namespaces.js';

export const extensionsRouter = Router();

// one row as the asking account sees it; halves mount at boot only, so one installed since reports 'restart'
function inventoryRow(req, row) {
    const out = { ...row, enabled: extensionEnabledFor(req.db, row) };
    const st = serverStateOf(row);
    // a half mounted this boot keeps serving after a pull that dropped it from the manifest
    if (!row.server && !st) return out;
    // a broken row was never mounted, and no restart would mount it: its error is the state
    out.serverState = st?.state || (row.error ? 'failed' : 'restart');
    if (st?.error) out.serverError = st.error;
    const hooks = [...serverHookRegistrations(row.id), ...scheduleRegistrations(row.id)];
    if (hooks.length) out.serverHooks = hooks;
    const consumers = browserConsumerRegistrations(row.id);
    if (consumers.length) out.browserConsumers = consumers;
    const calls = serverHookStats(row.id, req.userHandle);
    if (calls.length) out.serverCalls = calls;
    // the query doors it declared: projection fields on the list rows, advanced-filter fields, sort keys
    const query = queryDoorsOf(row.id);
    if (query) out.serverQuery = query;
    return out;
}

extensionsRouter.get('/', (req, res) => {
    // namespaces = the full provider_links divert list (first-party + every ratcheted
    // extension namespace), so the client can tell an orphaned link from card data
    res.json({ enabled: config.extensionsEnabled, extensions: listExtensions().map(row => inventoryRow(req, row)), namespaces: [...PROVIDER_NAMESPACES] });
});

// this account's extension jobs; before /:id, which would read 'jobs' as an extension id
extensionsRouter.get('/jobs', (req, res) => {
    res.json(listJobs(req.userHandle));
});

extensionsRouter.delete('/jobs', (req, res) => {
    res.json({ cleared: clearFinishedJobs(req.userHandle) });
});

// the last update check, for the admins who can act on it; before /:id as /jobs is
extensionsRouter.get('/updates', requireAdmin, (req, res) => {
    res.json(extensionUpdates());
});

// what a check found per install, so tabs hear only a change
const updateKey = (e) => `${e.available}:${e.nextCommit || ''}:${e.error || ''}`;

// asks every git install's repository now, or answers a check younger than maxAge; it never updates anything
extensionsRouter.post('/updates/check', requireAdmin, async (req, res, next) => {
    if (!config.extensionsEnabled) return res.status(400).json({ error: 'extensions are disabled (CL_EXTENSIONS=off)' });
    const maxAge = req.body?.maxAge ?? 0;
    if (!Number.isFinite(maxAge) || maxAge < 0) return res.status(400).json({ error: 'maxAge must be a number of milliseconds, 0 or more' });
    try {
        const before = new Map(extensionUpdates().extensions.map(e => [e.id, updateKey(e)]));
        const out = await checkExtensionUpdates({ maxAge });
        const changed = out.extensions.filter(e => before.get(e.id) !== updateKey(e)).map(e => e.id);
        if (changed.length) forEachOpenLibrary((db) => emitChange(db, { entity: 'extension', op: 'updated', ids: changed, fields: ['update'] }));
        res.json(out);
    } catch (e) { next(e); }
});

// a queued or running job is cancelled, a finished one dismissed
extensionsRouter.delete('/jobs/:jobId', (req, res) => {
    const id = Number(req.params.jobId);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'numeric id required' });
    if (!cancelJob(req.userHandle, id)) return res.status(404).json({ error: 'job not found' });
    res.json({ ok: true });
});

// the account's own switch: the client sends the wish and adopts the row it gets back
extensionsRouter.put('/:id/enabled', (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
    const row = listExtensions().find(r => r.id === req.params.id);
    if (!row) return res.status(404).json({ error: `no such extension: ${req.params.id}` });
    setExtensionEnabledFor(req.db, row, req.body.enabled);
    // switched on, its server half's tables and doors are readied in this account's library now;
    // one that cannot be answers its failure in the row
    if (req.body.enabled) readyHalfFor(req.db, row.id);
    // switched off, what it queued or runs for this account stops
    else cancelExtensionJobs(row.id, req.userHandle);
    res.json(inventoryRow(req, row));
});

// one verb, two sources: a git url as JSON, or the extension's folder as a zip body
extensionsRouter.post('/install', requireAdmin, async (req, res, next) => {
    if (!config.extensionsEnabled) return res.status(400).json({ error: 'extensions are disabled (CL_EXTENSIONS=off)' });
    if (req.is('application/zip')) return receiveArchive(req, res, next);
    try {
        res.json(await installFromGit(req.body?.git));
    } catch (e) { next(e); }
});

// an archive streams to a temp file up to the cap, dropped once its handle closes (Windows wont delete it open)
function receiveArchive(req, res, next) {
    const zipPath = path.join(os.tmpdir(), `cl-ext-${crypto.randomUUID()}.zip`);
    const out = fs.createWriteStream(zipPath);
    let size = 0;
    let stopped = null; // why the upload went no further: 'large', 'gone' or 'error'
    const stop = (why) => { if (stopped) return; stopped = why; req.unpipe(out); out.destroy(); };
    req.on('data', (chunk) => { size += chunk.length; if (size > ZIP_INSTALL_LIMITS.upload) stop('large'); });
    req.on('close', () => { if (!req.complete) stop('gone'); });
    out.on('error', (e) => { stop('error'); next(e); });
    req.pipe(out);
    out.on('close', async () => {
        try {
            if (stopped === 'large') return res.status(413).json({ error: `the archive is larger than ${ZIP_INSTALL_LIMITS.upload / 1048576} MB` });
            if (stopped) return;
            res.json(await installFromZip(zipPath));
        } catch (e) { next(e); }
        finally { try { fs.unlinkSync(zipPath); } catch { /* the system's temp folder takes it */ } }
    });
}

extensionsRouter.post('/:id/update', requireAdmin, async (req, res, next) => {
    if (!config.extensionsEnabled) return res.status(400).json({ error: 'extensions are disabled (CL_EXTENSIONS=off)' });
    try {
        const out = await updateExtension(req.params.id);
        // a mounted half runs the code it booted with until restart; a bundled half under the same id isnt its to mark
        const row = listExtensions().find(r => r.id === out.id && !r.bundled) || { id: out.id, bundled: false };
        const restart = out.updated && (serverStateOf(row) !== undefined || !!row.server);
        if (restart) markServerHalf(out.id, 'restart');
        // every tab re-reads the row, its update gone
        if (out.updated) forEachOpenLibrary((db) => emitChange(db, { entity: 'extension', op: 'updated', ids: [out.id], fields: ['update'] }));
        res.json({ ...out, restart });
    } catch (e) { next(e); }
});

extensionsRouter.delete('/:id', requireAdmin, (req, res) => {
    const out = removeExtension(req.params.id);
    if (!out.shadowed) {
        markServerHalf(out.id, 'removed');
        // every account forgets its switch, a closed library too, so code installed later under the id never runs unasked
        forgetExtensionEverywhere(out.id);
        // every open tab of every account unloads it: its row is gone from the inventory they re-read
        forEachOpenLibrary((db) => emitChange(db, { entity: 'extension', op: 'updated', ids: [out.id], fields: ['removed'] }));
    }
    res.json(out);
});
