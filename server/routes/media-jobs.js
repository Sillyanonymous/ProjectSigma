import { Router } from 'express';
import { listMediaJobsPage, enqueueMediaJob, enqueueMediaJobsSteps, updateMediaJob, removeMediaJob } from '../db/media-jobs-store.js';
import { characterSetFrom } from '../lib/character-query.js';
import { characterSetQuery } from '../db/characters-store.js';
import { runSteps } from '../lib/steps.js';
import { boolOf, listOf, pageOf, PAGE_DEFAULT, PAGE_MAX } from '../lib/query-params.js';

// The media download queue the client worker resumes from: one row per character, pending or active

export const mediaJobsRouter = Router();

// a page of the queue, or the jobs ids names at their own count
mediaJobsRouter.get('/', (req, res) => {
    let ids;
    if (req.query.ids !== undefined) {
        ids = listOf(req.query.ids).map(Number);
        if (!ids.length || !ids.every(Number.isInteger)) return res.status(400).json({ error: 'ids is a comma list of job ids' });
        if (ids.length > PAGE_MAX) return res.status(400).json({ error: `ids names at most ${PAGE_MAX} jobs a request` });
    }
    const page = pageOf(req.query, { def: ids?.length || PAGE_DEFAULT });
    res.json(listMediaJobsPage(req.db, { ...page, ids, count: boolOf(req.query.count, 'count') }));
});

mediaJobsRouter.post('/', (req, res) => {
    res.json(enqueueMediaJob(req.db, req.body || {}));
});

// a set's characters queued for a scan: { charIds } | { filter } (a selection, re-scanned) or { all: true } (the processed skipped)
mediaJobsRouter.post('/batch', async (req, res) => {
    const { charIds, filter, all, rescan } = req.body || {};
    if (rescan !== undefined && typeof rescan !== 'boolean') return res.status(400).json({ error: 'rescan must be a boolean' });
    if (all !== undefined && all !== true) return res.status(400).json({ error: 'all must be true when sent' });
    if (all === true && (charIds !== undefined || filter !== undefined)) return res.status(400).json({ error: 'all, charIds or filter, one of them' });
    const set = all === true ? characterSetQuery(req.db, {}) : characterSetFrom(req.db, { charIds, filter });
    // run to its end once begun, a hang-up included: a half-queued set would read as a whole one
    const value = await runSteps(enqueueMediaJobsSteps(req.db, set, { rescan: rescan ?? all !== true }), { alive: () => req.db.open });
    if (!value) return res.status(503).json({ error: 'the library closed while the set was queued' });
    res.json(value);
});

mediaJobsRouter.patch('/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'numeric id required' });
    const out = updateMediaJob(req.db, id, req.body || {});
    if (out === 'held') return res.status(409).json({ error: 'another worker holds this job' });
    if (!out) return res.status(404).json({ error: 'job not found' });
    res.json({ ok: true });
});

mediaJobsRouter.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'numeric id required' });
    if (!removeMediaJob(req.db, id)) return res.status(404).json({ error: 'job not found' });
    res.json({ ok: true });
});
