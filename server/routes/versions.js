import { Router } from 'express';
import { composeCharVersionsDoc, deleteCharVersions, addCharSnapshot, renameCharSnapshot, deleteCharSnapshot, setCharBackup } from '../db/versions-store.js';
import { characterExists } from '../db/characters-store.js';

export const versionsRouter = Router();

versionsRouter.get('/char/:charId', (req, res) => {
    const doc = composeCharVersionsDoc(req.db, req.params.charId);
    if (!doc) return res.status(404).json({ error: 'no versions for this character' });
    res.json(doc);
});

versionsRouter.delete('/char/:charId', (req, res) => {
    deleteCharVersions(req.db, req.params.charId);
    res.json({ ok: true });
});

// one snapshot at a time, server-numbered, so another writer's snapshot is never lost
versionsRouter.post('/char/:charId/snapshots', (req, res) => {
    const { label = null, source = 'local', charName = null, data } = req.body || {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'snapshot data (an object) required' });
    if (typeof source !== 'string' || !source) return res.status(400).json({ error: 'source must be a string' });
    const db = req.db;
    if (!characterExists(db, req.params.charId)) return res.status(404).json({ error: 'character not found' });
    const id = addCharSnapshot(db, req.params.charId, { label, source, charName, data });
    res.json({ id });
});

versionsRouter.patch('/char/:charId/snapshots/:snapId', (req, res) => {
    const snapId = Number(req.params.snapId);
    const label = req.body?.label;
    if (!Number.isInteger(snapId) || snapId < 0) return res.status(400).json({ error: 'snapshot id must be a whole number' });
    if (typeof label !== 'string') return res.status(400).json({ error: 'label (a string) required' });
    if (!renameCharSnapshot(req.db, req.params.charId, snapId, label)) return res.status(404).json({ error: 'no such snapshot' });
    res.json({ ok: true });
});

versionsRouter.delete('/char/:charId/snapshots/:snapId', (req, res) => {
    const snapId = Number(req.params.snapId);
    if (!Number.isInteger(snapId) || snapId < 0) return res.status(400).json({ error: 'snapshot id must be a whole number' });
    if (!deleteCharSnapshot(req.db, req.params.charId, snapId)) return res.status(404).json({ error: 'no such snapshot' });
    res.json({ ok: true });
});

versionsRouter.put('/char/:charId/backup', (req, res) => {
    const data = req.body?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'backup data (an object) required' });
    const db = req.db;
    if (!characterExists(db, req.params.charId)) return res.status(404).json({ error: 'character not found' });
    setCharBackup(db, req.params.charId, { timestamp: Number(req.body.timestamp) || Date.now(), data });
    res.json({ ok: true });
});

versionsRouter.delete('/char/:charId/backup', (req, res) => {
    setCharBackup(req.db, req.params.charId, null);
    res.json({ ok: true });
});
