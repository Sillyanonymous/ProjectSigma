import { Router } from 'express';
import { characterExists } from '../db/characters-store.js';
import { listWorldsFor, replaceWorldsFor, applyWorldsBatch, applyWorldNames } from '../db/world-links-store.js';
import { IDS_MAX } from '../lib/query-params.js';

// A character's lorebooks, one ordered list with no primary flag; the head is what an export carries

export const charWorldsRouter = Router();

// link or unlink books over a set of characters in one transaction; an unknown book is a 400 before any write
charWorldsRouter.post('/apply', (req, res) => {
    const { charIds, add, remove } = req.body || {};
    if (!Array.isArray(charIds) || charIds.length === 0) {
        return res.status(400).json({ error: 'charIds array required' });
    }
    if (charIds.length > IDS_MAX) return res.status(400).json({ error: `charIds names at most ${IDS_MAX} characters a request; send the selection in chunks` });
    const addNames = applyWorldNames(add, 'add');
    const removeNames = applyWorldNames(remove, 'remove');
    if (!addNames.length && !removeNames.length) {
        return res.status(400).json({ error: 'nothing to add or remove' });
    }
    // a name with no book throws out of the store with statusCode 400; the app's error
    // handler answers it, and the transaction it interrupted never landed
    res.json({ ok: true, ...applyWorldsBatch(req.db, 'char', charIds, { add: addNames, remove: removeNames }) });
});

// The rename/delete sweep lives at POST /api/worlds/sweep (and the rename itself at
// POST /api/worlds/{name}/rename): world lifecycle, not a character verb.

// mounted at /api/characters/:id/worlds
export const characterWorldsRouter = Router({ mergeParams: true });

characterWorldsRouter.get('/', (req, res) => {
    if (!characterExists(req.db, req.params.id)) return res.status(404).json({ error: 'character not found' });
    res.json(listWorldsFor(req.db, 'char', req.params.id));
});

characterWorldsRouter.put('/', (req, res) => {
    if (!characterExists(req.db, req.params.id)) return res.status(404).json({ error: 'character not found' });
    replaceWorldsFor(req.db, 'char', req.params.id, req.body?.worlds);
    res.json({ ok: true });
});
