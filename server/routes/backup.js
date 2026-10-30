import { Router } from 'express';
import { startBackup, listBackups, backupSettings, backupSchedule, backupActivity, cancelBackup, answerMissedBackup, libraryBytes } from '../lib/backup-core.js';
import { libraryCounts } from '../db/stats-store.js';

// The HTTP shape only; what a backup IS lives in lib/backup-core.js
export const backupRouter = Router();

// queued at once and answered; the copy runs in a child process, followed through /job
backupRouter.post('/', (req, res) => {
    res.status(202).json(startBackup(req.db, req.paths));
});

backupRouter.get('/', (req, res) => {
    res.json(listBackups(req.paths.backupsDir));
});

/** The account's backup job and the window it missed, read while one runs for its progress. */
backupRouter.get('/job', (req, res) => {
    res.json(backupActivity(req.db, req.paths.backupsDir));
});

// a cancel stops a live backup; ?dismiss=true lets go of one that ended
backupRouter.delete('/job/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'numeric id required' });
    const job = cancelBackup(req.db, id, { dismiss: req.query.dismiss === 'true' });
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json(job);
});

backupRouter.post('/missed', (req, res) => {
    res.json(answerMissedBackup(req.db, req.paths.backupsDir, req.body?.answer));
});

/** The settings panel's stats in one round trip, counted from the tables, never a stored summary. */
backupRouter.get('/status', (req, res) => {
    const backups = listBackups(req.paths.backupsDir);
    const { frequency, keep } = backupSettings(req.db);
    const schedule = backupSchedule(req.db, req.paths.backupsDir);

    res.json({
        db: { bytes: libraryBytes(req.paths.dbFile), ...libraryCounts(req.db) },
        latest: backups[0] || null,
        count: backups.length,
        totalBytes: backups.reduce((n, b) => n + b.bytes, 0),
        frequency,
        keep,
        // null when scheduling is off, so the client says so rather than rendering a date from nothing
        nextRun: schedule?.nextRun ?? null,
        missed: schedule?.missed ?? null,
    });
});
