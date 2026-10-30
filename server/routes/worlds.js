import { Router } from 'express';
import { skipIfGone } from '../lib/request-guard.js';
import { queryWorlds, worldUsageOf, getWorld, upsertWorld, deleteWorld, createWorldEntry, upsertWorldEntry, deleteWorldEntry, setWorldSource, probeWorldSources, searchWorldCarriers, CARRIERS_DEFAULT, CARRIERS_MAX, searchWorldEntries, ENTRY_SEARCH_DEFAULT, ENTRY_SEARCH_MAX } from '../db/worlds-store.js';
import { sweepWorldName, renameWorld } from '../db/world-links-store.js';
import { boolOf, intOf, pageOf, PROBE_MAX_KEYS } from '../lib/query-params.js';

export const worldsRouter = Router();

// a page of the shelf
worldsRouter.get('/', skipIfGone, (req, res) => {
    const counts = boolOf(req.query.counts, 'counts');
    const placeholders = boolOf(req.query.placeholders, 'placeholders');
    const q = req.query.q === undefined ? undefined : String(req.query.q);
    res.json(queryWorlds(req.db, { ...pageOf(req.query), q: q || undefined, counts: counts === true, placeholders: placeholders !== false, count: boolOf(req.query.count, 'count') }));
});

// beside /worlds, not under it: a book named "carriers" would be unreachable
export const worldCarriersRouter = Router();

// a name prefix, at most limit rows per arm and form
worldCarriersRouter.get('/', (req, res) => {
    const prefix = String(req.query.prefix ?? '').trim();
    if (!prefix) return res.status(400).json({ error: 'prefix required' });
    const { limit } = pageOf(req.query, { def: CARRIERS_DEFAULT, max: CARRIERS_MAX, cursor: false });
    res.json(searchWorldCarriers(req.db, prefix, { limit }));
});

// every book's entries by their words, beside /worlds for the same reason
export const worldEntriesRouter = Router();

worldEntriesRouter.get('/', skipIfGone, (req, res) => {
    const { limit } = pageOf(req.query, { def: ENTRY_SEARCH_DEFAULT, max: ENTRY_SEARCH_MAX, cursor: false });
    const offset = intOf(req.query.offset);
    if (Number.isNaN(offset)) return res.status(400).json({ error: 'offset must be a number' });
    if (req.query.q === undefined) return res.status(400).json({ error: 'q required (plain text)' });
    res.json(searchWorldEntries(req.db, { q: String(req.query.q), count: boolOf(req.query.count, 'count'), limit, offset }));
});

// re-point or drop every binding naming a world, all four tables in one transaction
worldsRouter.post('/sweep', (req, res) => {
    const { rename, remove } = req.body || {};
    res.json({ touched: sweepWorldName(req.db, { rename, remove }) });
});

// the shelf probe; declared before /:name or it reads as a world called "probe"
worldsRouter.post('/probe', (req, res) => {
    const body = req.body || {};
    if (typeof body.provider !== 'string' || !body.provider.trim()) return res.status(400).json({ error: 'provider: a provider id' });
    const keys = body.keys;
    if (!Array.isArray(keys) || !keys.length || !keys.every(k => typeof k === 'string' || typeof k === 'number')) {
        return res.status(400).json({ error: 'keys: a non-empty array of strings' });
    }
    if (keys.length > PROBE_MAX_KEYS) return res.status(400).json({ error: `max ${PROBE_MAX_KEYS} keys per probe` });
    res.json({ found: probeWorldSources(req.db, { provider: body.provider.trim(), keys }) });
});

// rename in one transaction, entries and bindings following by ON UPDATE CASCADE
worldsRouter.post('/:name/rename', (req, res) => {
    const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
    if (!to) return res.status(400).json({ error: 'to (the new name) required' });
    const out = renameWorld(req.db, req.params.name, to);
    if (!out) return res.status(404).json({ error: 'world not found' });
    res.json({ ok: true, ...out });
});

// one world's reach (an item of /usage): who waits on a placeholder before the shelf fills it
worldsRouter.get('/:name/usage', (req, res) => {
    const usage = worldUsageOf(req.db, req.params.name);
    if (!usage) return res.status(404).json({ error: 'world not found' });
    res.json(usage);
});

worldsRouter.get('/:name', (req, res) => {
    const world = getWorld(req.db, req.params.name);
    if (!world) return res.status(404).json({ error: 'world not found' });
    res.json(world);
});

// body IS the world data object ({ entries: {...}, ...meta }); creates or overwrites, or with
// ?expect= only creates (absent) or only fills a placeholder (placeholder), else 409
worldsRouter.put('/:name', (req, res) => {
    const name = String(req.params.name || '').trim();
    if (!name) return res.status(400).json({ error: 'world name required' });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        return res.status(400).json({ error: 'world data object required' });
    }
    const expect = req.query.expect ?? null;
    if (expect !== null && expect !== 'absent' && expect !== 'placeholder') return res.status(400).json({ error: "expect is 'absent' or 'placeholder'" });
    if (!upsertWorld(req.db, name, req.body, { expect })) {
        return res.status(409).json({ error: expect === 'absent' ? 'a lorebook with that name exists' : 'that lorebook is not a placeholder' });
    }
    res.json({ ok: true });
});

// entries and every binding follow through the FK cascades; the answer says how many
worldsRouter.delete('/:name', (req, res) => {
    const out = deleteWorld(req.db, req.params.name);
    if (!out) return res.status(404).json({ error: 'world not found' });
    res.json({ ok: true, unbound: out.unbound });
});

// where a book came from; onlyIfMissing never overwrites a recorded source
worldsRouter.put('/:name/source', (req, res) => {
    const body = req.body || {};
    if (typeof body.provider !== 'string' || !body.provider.trim()) return res.status(400).json({ error: 'provider: a provider id' });
    if ((typeof body.externalId !== 'string' && typeof body.externalId !== 'number') || String(body.externalId).trim() === '') return res.status(400).json({ error: 'externalId: the id on the provider' });
    for (const k of ['path', 'url']) if (body[k] != null && typeof body[k] !== 'string') return res.status(400).json({ error: `${k}: a string` });
    if (body.onlyIfMissing !== undefined && typeof body.onlyIfMissing !== 'boolean') return res.status(400).json({ error: 'onlyIfMissing: a boolean' });
    const out = setWorldSource(req.db, req.params.name, { provider: body.provider.trim(), externalId: String(body.externalId).trim(), path: body.path ?? null, url: body.url ?? null }, { onlyIfMissing: body.onlyIfMissing === true });
    if (!out) return res.status(404).json({ error: 'world not found' });
    res.json(out);
});

// granular entry writes: one row per edit instead of rewriting the whole world doc
worldsRouter.post('/:name/entries', (req, res) => {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'entry object required' });
    const uid = createWorldEntry(req.db, req.params.name, req.body);
    if (uid === null) return res.status(404).json({ error: 'world not found' });
    res.json({ ok: true, uid });
});

worldsRouter.put('/:name/entries/:uid', (req, res) => {
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid)) return res.status(400).json({ error: 'numeric uid required' });
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'entry object required' });
    const ok = upsertWorldEntry(req.db, req.params.name, uid, req.body);
    if (!ok) return res.status(404).json({ error: 'world not found' });
    res.json({ ok: true });
});

worldsRouter.delete('/:name/entries/:uid', (req, res) => {
    const uid = Number(req.params.uid);
    if (!Number.isInteger(uid)) return res.status(400).json({ error: 'numeric uid required' });
    const ok = deleteWorldEntry(req.db, req.params.name, uid);
    if (!ok) return res.status(404).json({ error: 'entry not found' });
    res.json({ ok: true });
});
