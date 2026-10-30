import { Router } from 'express';
import { getPersona } from '../db/personas-store.js';
import { listWorldsFor, replaceWorldsFor, applyWorldsFor, applyWorldNames } from '../db/world-links-store.js';

// The global and persona lore scopes, ordered lists on the char_worlds shape; HTTP shape only

// mounted at /api/global-worlds (its own mount: /api/worlds/{name} is a catch-all
// param route, so a world literally named "global" would shadow a sub-path there)
export const globalWorldsRouter = Router();

globalWorldsRouter.get('/', (req, res) => {
    res.json({ worlds: listWorldsFor(req.db, 'global') });
});

globalWorldsRouter.put('/', (req, res) => {
    replaceWorldsFor(req.db, 'global', null, req.body?.worlds);
    res.json({ ok: true });
});

// atomic add/remove, so no client reads the list to change it (a failed read would PUT an empty list)
globalWorldsRouter.post('/apply', (req, res) => {
    const add = applyWorldNames(req.body?.add, 'add');
    const remove = applyWorldNames(req.body?.remove, 'remove');
    if (!add.length && !remove.length) return res.status(400).json({ error: 'nothing to add or remove' });
    res.json({ ok: true, ...applyWorldsFor(req.db, 'global', null, { add, remove }) });
});

// mounted at /api/personas/:id/worlds
export const personaWorldsRouter = Router({ mergeParams: true });

personaWorldsRouter.get('/', (req, res) => {
    if (!getPersona(req.db, req.params.id)) return res.status(404).json({ error: 'persona not found' });
    res.json(listWorldsFor(req.db, 'persona', req.params.id));
});

personaWorldsRouter.put('/', (req, res) => {
    if (!getPersona(req.db, req.params.id)) return res.status(404).json({ error: 'persona not found' });
    replaceWorldsFor(req.db, 'persona', req.params.id, req.body?.worlds);
    res.json({ ok: true });
});

personaWorldsRouter.post('/apply', (req, res) => {
    if (!getPersona(req.db, req.params.id)) return res.status(404).json({ error: 'persona not found' });
    const add = applyWorldNames(req.body?.add, 'add');
    const remove = applyWorldNames(req.body?.remove, 'remove');
    if (!add.length && !remove.length) return res.status(400).json({ error: 'nothing to add or remove' });
    res.json({ ok: true, ...applyWorldsFor(req.db, 'persona', req.params.id, { add, remove }) });
});
