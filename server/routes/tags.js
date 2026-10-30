import { Router } from 'express';
import { skipIfGone } from '../lib/request-guard.js';
import { queryTags, resolveTagNames, renameTag, removeTag, applyTags, tallyTags, tagWriteNames } from '../db/tags-store.js';
import { boolOf, pageOf, IDS_MAX } from '../lib/query-params.js';
import { characterSetFrom } from '../lib/character-query.js';
import { startApplyJob } from '../lib/tag-jobs.js';
import { clientIdOf } from '../lib/feed.js';

// Tags are relational, every verb one transaction of relation surgery; a rename or remove journals its undo

export const tagsRouter = Router();

// a page of the tags by name or most used with their counts, q a contains match; an unknown sort is refused by name
tagsRouter.get('/', skipIfGone, (req, res) => {
    const q = req.query.q === undefined ? undefined : String(req.query.q);
    const sort = req.query.sort ? String(req.query.sort) : undefined;
    res.json(queryTags(req.db, { ...pageOf(req.query), q: q || undefined, sort, count: boolOf(req.query.count, 'count') }));
});

// names snapped to the library's spellings with counts, unknown ones marked; a read, never a mint
tagsRouter.post('/resolve', (req, res) => {
    const { names } = req.body || {};
    if (!Array.isArray(names)) return res.status(400).json({ error: 'names array required' });
    res.json({ tags: resolveTagNames(req.db, names.slice(0, 200), { each: req.body?.each === true }) });
});

// Rename a tag everywhere; an existing target (NOCASE unique) makes it a merge.
tagsRouter.post('/rename', (req, res) => {
    const { from, to, run } = req.body || {};
    if (!from || !to || typeof from !== 'string' || typeof to !== 'string' || !to.trim()) {
        return res.status(400).json({ error: '{from, to} required' });
    }
    res.json({ ok: true, ...renameTag(req.db, from, to, { run }) });
});

// Remove a tag from every carrier (and the tag row itself).
tagsRouter.post('/remove', (req, res) => {
    const { name, run } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: '{name} required' });
    res.json({ ok: true, ...removeTag(req.db, name, { run }) });
});

// the tags a set carries and how many carry each, counted here so the client never holds the set
tagsRouter.post('/tally', (req, res) => {
    res.json(tallyTags(req.db, characterSetFrom(req.db, req.body || {})));
});

// batch tagging: by ids in one go, or by filter as a job (202)
tagsRouter.post('/apply', (req, res) => {
    const { charIds, filter, add = [], remove = [] } = req.body || {};
    if (filter !== undefined) {
        const names = tagWriteNames(add, remove);
        const job = startApplyJob(req.db, characterSetFrom(req.db, { charIds, filter }), { ...names, origin: clientIdOf(req.headers['x-cl-client']) });
        res.status(202).json({ ok: true, job });
        return;
    }
    if (!Array.isArray(charIds) || charIds.length === 0) {
        return res.status(400).json({ error: 'charIds array required' });
    }
    if (charIds.length > IDS_MAX) return res.status(400).json({ error: `charIds names at most ${IDS_MAX} characters a request; send the selection in chunks, or its filter` });
    res.json({ ok: true, ...applyTags(req.db, charIds, { add, remove }) });
});
