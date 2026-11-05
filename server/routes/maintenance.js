import { Router } from 'express';
import { ftsMergeActivity, ftsUpkeepStatus, noteFtsActivity, tidyFtsNow } from '../db/fts-merge.js';

// The HTTP shape only; each piece of upkeep lives where it runs
export const maintenanceRouter = Router();

/** What the library's background upkeep is doing now, read again on every maintenance record of the feed. */
maintenanceRouter.get('/', (req, res) => {
    res.json({ searchIndex: ftsMergeActivity(req.db) });
});

// the reader is using the library: background upkeep holds off until it sits idle again
maintenanceRouter.post('/activity', (req, res) => {
    noteFtsActivity(req.db);
    res.status(204).end();
});

/** Settings' Search Index group in one round trip: each index's shape and drift, the last tidy-up and failure, the one running. */
maintenanceRouter.get('/search-index', (req, res) => {
    res.json(ftsUpkeepStatus(req.db));
});

// started or queued at once and answered; the tidy-up runs beside the server, followed through the maintenance records
maintenanceRouter.post('/search-index/tidy', (req, res) => {
    const out = tidyFtsNow(req.db);
    res.status(out.started ? 202 : 200).json(out);
});
