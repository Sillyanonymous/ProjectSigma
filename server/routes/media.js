import express, { Router } from 'express';
import { getCharacter } from '../db/characters-store.js';
import { listMediaPage, addMediaFile, deleteMedia, contentHashFor, findMediaByContent, findMediaByUrlHash, adoptMediaSource, copyMediaFrom } from '../db/media-store.js';
import { boolOf, pageOf } from '../lib/query-params.js';
import { invalidateMediaThumbs } from './thumbs.js';
import {
    urlHashFor, displayNameForUrl, fetchMediaBytes, intakeErrorResponse,
} from '../lib/media-intake.js';

export const characterMediaRouter = Router({ mergeParams: true });

// a page of the gallery
characterMediaRouter.get('/', (req, res) => {
    const db = req.db;
    if (!getCharacter(db, req.params.id)) return res.status(404).json({ error: 'character not found' });
    res.json(listMediaPage(db, req.params.id, { ...pageOf(req.query), count: boolOf(req.query.count, 'count') }));
});

// raw body upload; filename rides ?name=, optional ?sourceUrl= records provenance and
// makes re-runs idempotent (same url_hash skip as from-url)
characterMediaRouter.post('/', express.raw({ type: () => true, limit: '200mb' }), (req, res) => {
    const db = req.db;
    if (!getCharacter(db, req.params.id)) return res.status(404).json({ error: 'character not found' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'file body required' });
    // the store's refusals carry statusCode 400; anything else is a real, logged 500
    const sourceUrl = req.query.sourceUrl ? String(req.query.sourceUrl) : null;
    const urlHash = sourceUrl ? urlHashFor(sourceUrl) : null;
    if (urlHash && findMediaByUrlHash(db, req.params.id, urlHash)) {
        return res.json({ skipped: true, reason: 'url' });
    }
    const dupe = findMediaByContent(db, req.params.id, contentHashFor(req.body));
    if (dupe) {
        const adopted = !!sourceUrl && !dupe.sourceUrl && adoptMediaSource(db, dupe.id, sourceUrl, urlHash);
        return res.json({ skipped: true, reason: 'content', duplicateOf: dupe.id, displayName: dupe.displayName, ...(adopted ? { adopted: true } : {}) });
    }
    res.json(addMediaFile(db, req.paths, req.params.id, req.query.name || 'upload.png', req.body, { sourceUrl, urlHash }));
});

// another character's whole gallery copied in on disk, never through the browser
characterMediaRouter.post('/copy', express.json(), async (req, res) => {
    const db = req.db;
    const from = req.body?.from;
    if (typeof from !== 'string' || !from) return res.status(400).json({ error: 'from names the character whose gallery is copied' });
    if (from === req.params.id) return res.status(400).json({ error: 'a gallery cannot be copied onto itself' });
    if (!getCharacter(db, req.params.id) || !getCharacter(db, from)) return res.status(404).json({ error: 'character not found' });
    res.json(await copyMediaFrom(db, req.paths, req.params.id, from));
});

// Server-side localization download: no CORS, no proxy chain, dedup is a url_hash lookup.
characterMediaRouter.post('/from-url', express.json(), async (req, res) => {
    const db = req.db;
    if (!getCharacter(db, req.params.id)) return res.status(404).json({ error: 'character not found' });
    const url = String(req.body?.url || '');
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'http(s) url required' });

    const urlHash = urlHashFor(url);
    if (findMediaByUrlHash(db, req.params.id, urlHash)) {
        return res.json({ skipped: true, reason: 'url' });
    }

    // only the fetch's own failures map through the intake's answer; a disk or store failure is a logged 500
    let fetched;
    try {
        fetched = await fetchMediaBytes(url);
    } catch (err) {
        const { status, error } = intakeErrorResponse(err);
        return res.status(status).json({ error });
    }
    const { bytes, contentType } = fetched;

    // second dedup layer: same BYTES already stored for this char, url or no url
    const dupe = findMediaByContent(db, req.params.id, contentHashFor(bytes));
    if (dupe) {
        const adopted = !dupe.sourceUrl && adoptMediaSource(db, dupe.id, url, urlHash);
        return res.json({ skipped: true, reason: 'content', duplicateOf: dupe.id, displayName: dupe.displayName, ...(adopted ? { adopted: true } : {}) });
    }

    const item = addMediaFile(db, req.paths, req.params.id, displayNameForUrl(url, contentType, bytes), bytes, {
        sourceUrl: url, urlHash,
    });
    res.json(item);
});

export const mediaRouter = Router();

mediaRouter.delete('/:mediaId', (req, res) => {
    const ok = deleteMedia(req.db, req.paths, Number(req.params.mediaId));
    if (!ok) return res.status(404).json({ error: 'media not found' });
    invalidateMediaThumbs(req.paths.mediaThumbsDir, Number(req.params.mediaId));
    res.json({ ok: true });
});
