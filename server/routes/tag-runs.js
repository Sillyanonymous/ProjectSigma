import { Router } from 'express';
import { listTagRuns, getTagRun, deleteTagRun } from '../db/tag-runs-store.js';
import { startUndoJob, TAG_JOB_KINDS } from '../lib/tag-jobs.js';
import { setJobsBusy } from '../lib/set-jobs.js';
import { clientIdOf } from '../lib/feed.js';
import { ownerOf } from '../db/changes.js';

// The bulk tag-run undo journal: the newest run a tag op or job wrote, undone by the server as a job

export const tagRunsRouter = Router();

tagRunsRouter.get('/', (req, res) => {
    res.json(listTagRuns(req.db));
});

tagRunsRouter.get('/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'numeric id required' });
    const run = getTagRun(req.db, id);
    if (!run) return res.status(404).json({ error: 'run not found' });
    res.json(run);
});

// undo the newest tag job's run as a job (202); an older run's undo would work under what came after
tagRunsRouter.post('/:id/undo', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'numeric id required' });
    const run = getTagRun(req.db, id);
    if (!run) return res.status(404).json({ error: 'run not found' });
    if (listTagRuns(req.db)[0]?.id !== id) return res.status(409).json({ error: 'only the newest run can be undone' });
    if (setJobsBusy(ownerOf(req.db), TAG_JOB_KINDS)) return res.status(409).json({ error: 'a tag job is queued or running; undo once it ends' });
    res.status(202).json({ ok: true, job: startUndoJob(req.db, run, { origin: clientIdOf(req.headers['x-cl-client']) }) });
});

tagRunsRouter.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'numeric id required' });
    if (!deleteTagRun(req.db, id)) return res.status(404).json({ error: 'run not found' });
    res.json({ ok: true });
});
