import { Router } from 'express';
import { listMediaJobsPage, enqueueMediaJob, updateMediaJob, removeMediaJob } from '../db/media-jobs-store.js';
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
