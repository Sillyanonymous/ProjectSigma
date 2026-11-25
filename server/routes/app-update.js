import { Router } from 'express';
import { requireAdmin } from '../auth.js';
import { appUpdateState, checkAppUpdate, dismissAppUpdateFailure, skipAppVersion, startAppUpdate } from '../lib/app-update.js';

// The app's own updates, for the admins who alone can act on them

export const appUpdateRouter = Router();

appUpdateRouter.use(requireAdmin);

appUpdateRouter.get('/update', (req, res) => {
    res.json(appUpdateState());
});

// asks GitHub now, or answers a check younger than maxAge; it never updates anything
appUpdateRouter.post('/update/check', async (req, res, next) => {
    const maxAge = req.body?.maxAge ?? 0;
    if (!Number.isFinite(maxAge) || maxAge < 0) return res.status(400).json({ error: 'maxAge must be a number of milliseconds, 0 or more' });
    try { res.json(await checkAppUpdate({ maxAge })); } catch (e) { next(e); }
});

appUpdateRouter.put('/update/skip', (req, res, next) => {
    if (!req.body || !('version' in req.body)) return res.status(400).json({ error: 'version is required (a version, or null to forget the skipped one)' });
    try { res.json(skipAppVersion(req.body.version)); } catch (e) { next(e); }
});

// a failed update let go of for every tab, so no reload or other tab brings it back
appUpdateRouter.delete('/update/failure', (req, res) => {
    res.json(dismissAppUpdateFailure());
});

// refused with the reason, or started: the answer comes before the backup, the merge and the restart
appUpdateRouter.post('/update', async (req, res, next) => {
    const backup = req.body?.backup ?? true;
    if (typeof backup !== 'boolean') return res.status(400).json({ error: 'backup must be true or false' });
    try { res.status(202).json(await startAppUpdate({ backup })); } catch (e) { next(e); }
});
