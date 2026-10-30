import { Router } from 'express';
import { getSetJob, stopSetJob } from '../lib/set-jobs.js';
import { ownerOf } from '../db/changes.js';

// The account's set jobs: progress and answers are read here, a stop lands between chunks

export const jobsRouter = Router();

// A job of this account: its progress, then its answer once it ends.
function answerJob(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'numeric id required' });
    const job = getSetJob(ownerOf(req.db), id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json(job);
}

// queued never starts, running halts before its next chunk; what landed stays
function stopJob(req, res) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'numeric id required' });
    const job = stopSetJob(ownerOf(req.db), id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json(job);
}

jobsRouter.get('/:id', (req, res) => answerJob(req, res));
jobsRouter.delete('/:id', (req, res) => stopJob(req, res));
