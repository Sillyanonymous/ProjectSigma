import { Router } from 'express';
import { getSettings, patchSettings, replaceSettings } from '../db/settings-store.js';

// One row per setting key. PATCH upserts only the provided keys, which is what
// makes concurrent writers safe (no whole-object last-write-wins clobber).
export const settingsRouter = Router();

function validBody(req, res) {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        res.status(400).json({ error: 'settings body must be an object' });
        return false;
    }
    return true;
}

settingsRouter.get('/', (req, res) => {
    res.json(getSettings(req.db));
});

settingsRouter.put('/', (req, res) => {
    if (!validBody(req, res)) return;
    replaceSettings(req.db, req.body);
    res.json({ ok: true });
});

settingsRouter.patch('/', (req, res) => {
    if (!validBody(req, res)) return;
    patchSettings(req.db, req.body);
    res.json({ ok: true });
});
