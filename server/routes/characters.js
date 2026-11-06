import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { queryCharacters, getCharacter, getRelatedCharacters, patchCharacter, setCharacterFlags, deleteCharacter, deleteCharacters, DELETE_MAX, reportAvatarChange, buildExportCard, tallyCharacters } from '../db/characters-store.js';
import { writeCardChunks, stripCardChunks, isPng } from '../lib/png-card.js';
import { importCharacterBuffer, replaceResolution } from '../importer/card-import.js';
import { importCardFile, amendedCardProblem, newStage, claimStage, dropStage, finishStage } from '../importer/card-file.js';
import { writeFileAtomic } from '../lib/atomic-write.js';
import { invalidateAvatarThumbs } from './thumbs.js';
import { NS_RE } from '../lib/provider-namespaces.js';
import { characterQueryOpts, characterSetFrom } from '../lib/character-query.js';
import { scanDuplicates, matchCharacter, matchNamesForHint } from '../db/duplicates-store.js';
import { requireArchiveType, skipIfGone } from '../lib/request-guard.js';
import { boolOf, pageOf, PAGE_DEFAULT, PAGE_MAX, PROBE_MAX_KEYS, IDS_MAX, FIELDS_APPLY_MAX } from '../lib/query-params.js';
import { safeFileName } from '../lib/stored-file.js';
import { listMedia, galleryDirFor } from '../db/media-store.js';
import { charxExportAssets, writeCharx } from '../lib/charx.js';
import { liftForCharx } from '../lib/card-normalize.js';
import { packPath, dropPack, sendPack } from '../lib/zip.js';
import { startDeleteJob, startFavoriteJob, startFlagsJob } from '../lib/character-jobs.js';
import { clientIdOf } from '../lib/feed.js';

export const charactersRouter = Router();


// A list answers a page, never the whole library. A set is walked by its cursor; ids answer every
// id asked, up to the maximum.
const IDS_ONLY_MAX_LIMIT = 10000;

charactersRouter.get('/', skipIfGone, (req, res) => {
    const opts = characterQueryOpts(req.db, req.query);
    const max = opts.idsOnly ? IDS_ONLY_MAX_LIMIT : PAGE_MAX;
    if (opts.ids.length > max) return res.status(400).json({ error: `ids names at most ${max} characters a request` });
    opts.limit = pageOf(req.query, { def: opts.ids.length || PAGE_DEFAULT, max, what: opts.idsOnly ? ' with idsOnly' : '' }).limit;
    try {
        res.json(queryCharacters(req.db, opts));
    } catch (err) {
        if (err?.statusCode === 400) return res.status(400).json({ error: err.message });
        throw err;
    }
});

// in-library match probe for browse views, graded by the duplicate rule so the badge and the import warning agree
charactersRouter.post('/match', (req, res) => {
    const candidates = req.body?.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
        return res.status(400).json({ error: 'candidates array required' });
    }
    if (candidates.length > PROBE_MAX_KEYS) return res.status(400).json({ error: `max ${PROBE_MAX_KEYS} candidates per probe` });
    res.json(matchNamesForHint(req.db, candidates.map(c => c?.name)));
});

// the duplicate scan and the pre-import match answer ids and scores, never rows; one scan per library
charactersRouter.get('/duplicates', async (req, res) => {
    res.json(await scanDuplicates(req.db));
});
charactersRouter.post('/duplicates/match', (req, res) => {
    const probe = req.body;
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) return res.status(400).json({ error: 'a probe object is required' });
    const named = String(probe.name || probe.definition?.name || '').trim();
    if (!named && !probe.fullPath && !probe.full_path && !probe.externalId) return res.status(400).json({ error: 'a probe needs a name, a fullPath or an externalId' });
    res.json({ matches: matchCharacter(req.db, probe) });
});

// card PNG import; ?name= is a display hint only, never an identity
// each import's two choices: onExisting ('copy' only, never an overwrite) and source
function importChoices({ onExisting = null, source = null } = {}) {
    if (onExisting != null && onExisting !== 'copy') return { error: "onExisting accepts only 'copy'; imports never overwrite" };
    if (source != null && !NS_RE.test(String(source))) return { error: 'source must be a provider namespace' };
    return { onExisting: onExisting ?? null, source: source == null ? null : String(source) };
}

// the written row as the list answers it, so the asking tab skips a second read
const listRowOf = (db, id) => queryCharacters(db, { ...characterQueryOpts(db, { ids: String(id), count: 'false' }), limit: 1 }).items?.[0] || null;

charactersRouter.post('/import', express.raw({ type: ['image/*', 'application/octet-stream'], limit: '100mb' }), (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'PNG body required' });
    if (!isPng(req.body)) return res.status(415).json({ error: 'card imports are PNG; stage any other card file at /api/characters/import/stage' });
    const choices = importChoices({ onExisting: req.query.onExisting || null, source: req.query.source || null });
    if (choices.error) return res.status(400).json({ error: choices.error });
    // an importer throw reaches the app's error handler: a typed refusal answers its
    // status, anything else is a logged 500 (a route-local 500 never logged the stack)
    const result = importCharacterBuffer(req.db, req.body, {
        sourceName: req.query.name ? String(req.query.name) : null,
        force: choices.onExisting,
        paths: req.paths,
        source: choices.source,
    });
    if (!result) return res.status(422).json({ error: 'no character card found in this PNG' });
    if (result.skipped) {
        return res.json({ skipped: true, reason: result.reason, id: result.id, created: false, name: result.name });
    }
    res.json({ id: result.id, created: result.created, name: result.name, row: listRowOf(req.db, result.id) });
});

// stage any card file (PNG or charx) to read before import; streamed, no body parser. a stage keeps an hour
charactersRouter.post('/import/stage', (req, res, next) => {
    if (!requireArchiveType(req, res, ['application/octet-stream', 'image/png', 'image/webp', 'image/jpeg'])) return;
    const stage = newStage(req.paths);
    const out = fs.createWriteStream(stage.file);
    req.pipe(out);
    // a failed write stops the upload and leaves no half stage; the drop waits for the stream to close
    out.on('error', (err) => {
        req.unpipe(out);
        out.once('close', () => dropStage(req.paths, stage.id));
        next(err);
    });
    // a hang-up leaves no stage; wait for close, since a destroy before open still creates the file
    req.on('close', () => {
        if (req.complete) return;
        out.once('close', () => dropStage(req.paths, stage.id));
        out.destroy();
    });
    out.on('finish', async () => {
        try {
            res.json(await finishStage(req.paths, stage, { name: req.query.name ? String(req.query.name) : null }));
        } catch (err) {
            if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
            next(err);
        }
    });
});

// import a staged card file, once: claimed first, handed back on a refusal
charactersRouter.post('/import/stage/:stageId', async (req, res) => {
    const body = req.body || {};
    const choices = importChoices(body);
    if (choices.error) return res.status(400).json({ error: choices.error });
    const problem = amendedCardProblem(body.card);
    if (problem) return res.status(400).json({ error: problem });
    const stage = claimStage(req.paths, req.params.stageId);
    if (!stage) return res.status(404).json({ error: 'no such stage: committed, dropped, or kept past its hour' });
    let result;
    try {
        result = await importCardFile(req.db, req.paths, stage.file, {
            card: body.card ?? null, sourceName: stage.meta.name ?? null, onExisting: choices.onExisting, source: choices.source,
        });
    } catch (err) {
        stage.release();
        throw err;
    }
    dropStage(req.paths, stage.id);
    if (!result) return res.status(422).json({ error: 'no character card found in this file' });
    if (result.skipped) {
        return res.json({ skipped: true, reason: result.reason, id: result.id, created: false, name: result.name, media: result.media, ...(result.mediaFailed ? { mediaFailed: result.mediaFailed } : {}) });
    }
    res.json({ id: result.id, created: result.created, name: result.name, media: result.media, ...(result.mediaFailed ? { mediaFailed: result.mediaFailed } : {}), row: listRowOf(req.db, result.id) });
});

charactersRouter.delete('/import/stage/:stageId', (req, res) => {
    if (!dropStage(req.paths, req.params.stageId)) return res.status(404).json({ error: 'no such stage' });
    res.json({ ok: true });
});

// Replace: the one door that overwrites, naming its target; relations stay and the old card is snapshotted first
charactersRouter.post('/:id/replace', express.raw({ type: ['image/*', 'application/octet-stream'], limit: '100mb' }), async (req, res) => {
    const png = Buffer.isBuffer(req.body);
    const body = png ? {} : (req.body || {});
    const choices = importChoices({ source: png ? (req.query.source || null) : (body.source ?? null) });
    if (choices.error) return res.status(400).json({ error: choices.error });
    const resolved = replaceResolution(req.db, req.paths, req.params.id, { source: choices.source });
    if (!resolved) return res.status(404).json({ error: 'character not found' });
    let result;
    if (png) {
        if (!req.body.length) return res.status(400).json({ error: 'a card PNG or { stage } required' });
        if (!isPng(req.body)) return res.status(415).json({ error: 'a replace body is a card PNG; stage any other card file and send { stage }' });
        result = importCharacterBuffer(req.db, req.body, { paths: req.paths, source: choices.source, resolved });
    } else {
        if (typeof body.stage !== 'string' || !body.stage) return res.status(400).json({ error: 'a card PNG or { stage } required' });
        const problem = amendedCardProblem(body.card);
        if (problem) return res.status(400).json({ error: problem });
        const stage = claimStage(req.paths, body.stage);
        if (!stage) return res.status(404).json({ error: 'no such stage: committed, dropped, or kept past its hour' });
        try {
            result = await importCardFile(req.db, req.paths, stage.file, { card: body.card ?? null, sourceName: stage.meta.name ?? null, source: choices.source, resolved });
        } catch (err) {
            stage.release();
            throw err;
        }
        dropStage(req.paths, stage.id);
    }
    if (!result) return res.status(422).json({ error: 'no character card found in this file' });
    res.json({ id: result.id, created: false, replaced: true, name: result.name, snapshot: resolved.snapshotId, row: listRowOf(req.db, result.id), ...(result.media != null ? { media: result.media } : {}), ...(result.mediaFailed ? { mediaFailed: result.mediaFailed } : {}) });
});

charactersRouter.get('/:id', (req, res) => {
    const char = getCharacter(req.db, req.params.id);
    if (!char) return res.status(404).json({ error: 'character not found' });
    res.json(char);
});

// related scoring lives in the store (shared rare words and folded tags on one scale); clients render what comes back
charactersRouter.get('/:id/related', (req, res) => {
    const { limit } = pageOf(req.query, { def: 20, max: 100, cursor: false });
    const flags = {};
    for (const [param, key] of [['tags', 'useTags'], ['creator', 'useCreator'], ['content', 'useContent']]) {
        flags[key] = boolOf(req.query[param], param) ?? true;
    }
    const result = getRelatedCharacters(req.db, req.params.id, { limit, ...flags });
    if (!result) return res.status(404).json({ error: 'character not found' });
    res.json(result);
});

charactersRouter.patch('/:id', (req, res) => {
    const { fields, fav, mediaLocalized, loreDismissed } = req.body || {};
    if (fields !== undefined && (typeof fields !== 'object' || Array.isArray(fields) || fields === null)) {
        return res.status(400).json({ error: 'fields must be an object of dot-path updates' });
    }
    for (const [k, v] of Object.entries({ fav, mediaLocalized, loreDismissed })) {
        if (v !== undefined && typeof v !== 'boolean') return res.status(400).json({ error: `${k} must be a boolean` });
    }
    // every refusal the store makes carries its statusCode; anything else is a real 500
    let updated;
    try {
        updated = patchCharacter(req.db, req.params.id, { fields: fields || {}, fav, mediaLocalized, loreDismissed });
    } catch (err) {
        // a refused field is a client bug, logged with the account and character
        if (err?.refusedField) console.warn(`[characters][${req.userHandle}] PATCH ${req.params.id} refused: ${err.message}`);
        throw err;
    }
    if (!updated) return res.status(404).json({ error: 'character not found' });
    res.json(updated);
});

charactersRouter.delete('/:id', (req, res) => {
    const gone = deleteCharacter(req.db, req.paths, req.params.id);
    if (!gone) return res.status(404).json({ error: 'character not found' });
    res.json({ ok: true });
});

// uuids only: a filename is not an identity, and tolerating one would hide an unmigrated client
const cleanIds = ids => [...new Set((Array.isArray(ids) ? ids : [])
    .map(v => String(v)).filter(Boolean))];

// a selection's count and favourites in one read; a POST so the filter rides the body
charactersRouter.post('/tally', (req, res) => {
    res.json(tallyCharacters(req.db, characterSetFrom(req.db, req.body || {})));
});

// bulk fav flip of only the rows that move: by ids in one transaction, or by filter as a job (202)
charactersRouter.post('/fav', (req, res) => {
    const { charIds, filter, fav } = req.body || {};
    if (filter !== undefined) {
        if (charIds !== undefined) return res.status(400).json({ error: 'charIds or filter, not both' });
        if (typeof fav !== 'boolean') return res.status(400).json({ error: 'fav boolean required' });
        const job = startFavoriteJob(req.db, characterSetFrom(req.db, { filter }), { value: fav, origin: clientIdOf(req.headers['x-cl-client']) });
        return res.status(202).json({ ok: true, job });
    }
    const ids = cleanIds(charIds);
    if (!ids.length) return res.status(400).json({ error: 'charIds array required' });
    if (ids.length > IDS_MAX) return res.status(400).json({ error: `charIds names at most ${IDS_MAX} characters a request; send the selection in chunks, or its filter` });
    if (typeof fav !== 'boolean') return res.status(400).json({ error: 'fav boolean required' });
    res.json({ ok: true, ...setCharacterFlags(req.db, { ids }, { fav }) });
});

// bulk delete: at most DELETE_MAX ids in one transaction, or by filter as a job; expect refuses a moved set (409)
charactersRouter.post('/delete', (req, res) => {
    const { charIds, filter, expect } = req.body || {};
    if (filter !== undefined) {
        if (charIds !== undefined) return res.status(400).json({ error: 'charIds or filter, not both' });
        if (expect !== undefined && (!Number.isInteger(expect) || expect < 0)) return res.status(400).json({ error: 'expect must be the count of characters the reader confirmed' });
        let job;
        try {
            job = startDeleteJob(req.db, req.paths, characterSetFrom(req.db, { filter }), { expect });
        } catch (err) {
            if (err?.statusCode === 409) return res.status(409).json({ error: err.message, total: err.total });
            throw err;
        }
        return res.status(202).json({ ok: true, job });
    }
    const ids = cleanIds(charIds);
    if (!ids.length) return res.status(400).json({ error: 'charIds array required' });
    if (ids.length > DELETE_MAX) return res.status(400).json({ error: `a delete names at most ${DELETE_MAX} characters a request; send the selection in chunks` });
    const { deleted, missing } = deleteCharacters(req.db, req.paths, ids);
    res.json({ ok: true, touched: deleted.length, deleted, missing });
});

// bulk op-state flags, the /fav shape (ids in one transaction, all: true a job); only rows whose value changes, and no flag moves updated_at
charactersRouter.post('/flags', (req, res) => {
    const { charIds, all, mediaLocalized, loreDismissed } = req.body || {};
    const flags = {};
    for (const [k, v] of Object.entries({ mediaLocalized, loreDismissed })) {
        if (v === undefined) continue;
        if (typeof v !== 'boolean') return res.status(400).json({ error: `${k} must be a boolean` });
        flags[k] = v;
    }
    if (!Object.keys(flags).length) return res.status(400).json({ error: 'at least one of mediaLocalized, loreDismissed required' });
    const ids = charIds === undefined ? null : cleanIds(charIds);
    if ((all === true) === (ids !== null)) return res.status(400).json({ error: 'exactly one of charIds (array) or all: true' });
    if (ids && !ids.length) return res.status(400).json({ error: 'charIds array required' });
    if (ids && ids.length > IDS_MAX) return res.status(400).json({ error: `charIds names at most ${IDS_MAX} characters a request; send the selection in chunks` });
    if (!ids) return res.status(202).json({ ok: true, job: startFlagsJob(req.db, flags, { origin: clientIdOf(req.headers['x-cl-client']) }) });
    res.json({ ok: true, ...setCharacterFlags(req.db, { ids }, flags) });
});

// bulk PATCH /:id writes, at most FIELDS_APPLY_MAX a request, each its own transaction; a failure is reported, not fatal
charactersRouter.post('/fields-apply', (req, res) => {
    const { updates } = req.body || {};
    if (!Array.isArray(updates) || !updates.length) {
        return res.status(400).json({ error: 'updates array required: [{id, fields, fav?}]' });
    }
    if (updates.length > FIELDS_APPLY_MAX) return res.status(400).json({ error: `updates holds at most ${FIELDS_APPLY_MAX} entries a request; send the list in chunks` });
    const db = req.db;
    const affected = [];
    const failed = [];
    for (const u of updates) {
        const id = String(u?.id || '');
        if (!id) { failed.push({ id: null, error: 'missing id' }); continue; }
        if (u.fields !== undefined && (typeof u.fields !== 'object' || Array.isArray(u.fields) || u.fields === null)) {
            failed.push({ id, error: 'fields must be an object of dot-path updates' });
            continue;
        }
        try {
            const bool = (v) => (typeof v === 'boolean' ? v : undefined);
            const out = patchCharacter(db, id, { fields: u.fields || {}, fav: bool(u.fav), mediaLocalized: bool(u.mediaLocalized), loreDismissed: bool(u.loreDismissed) });
            if (out) affected.push(id);
            else failed.push({ id, error: 'character not found' });
        } catch (err) {
            // a refusal is its row's answer; a server fault is logged, and the row still answers
            if (!Number.isInteger(err?.statusCode)) console.error(`[characters][${req.userHandle}] bulk PATCH ${id} failed:`, err);
            else if (err.refusedField) console.warn(`[characters][${req.userHandle}] bulk PATCH ${id} refused: ${err.message}`);
            failed.push({ id, error: err.message });
        }
    }
    res.json({ ok: true, touched: affected.length, affected, failed });
});

// avatars are pure images: card chunks stripped, other formats converted to PNG
charactersRouter.put('/:id/avatar', express.raw({ type: ['image/*', 'application/octet-stream'], limit: '100mb' }), async (req, res) => {
    const char = getCharacter(req.db, req.params.id);
    if (!char) return res.status(404).json({ error: 'character not found' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ error: 'image body required' });
    }
    let png;
    if (isPng(req.body)) {
        png = stripCardChunks(req.body);
    } else {
        try {
            png = await sharp(req.body).png().toBuffer();
        } catch {
            return res.status(415).json({ error: 'body is not a decodable image' });
        }
    }
    // reported BEFORE the file changes, so a store guard refuses it while the old picture stands
    reportAvatarChange(req.db, req.params.id);
    writeFileAtomic(path.join(req.paths.avatarsDir, `${req.params.id}.png`), png);
    invalidateAvatarThumbs(req.paths.avatarThumbsDir, req.params.id);
    res.json({ ok: true });
});

charactersRouter.get('/:id/export', async (req, res) => {
    const format = req.query.format === undefined ? 'png' : String(req.query.format);
    if (format !== 'png' && format !== 'charx') return res.status(400).json({ error: "format is 'png' or 'charx'" });
    const char = getCharacter(req.db, req.params.id);
    const built = char && buildExportCard(req.db, req.params.id, char);
    if (!built) return res.status(404).json({ error: 'character not found' });
    const avatarPath = path.join(req.paths.avatarsDir, `${req.params.id}.png`);
    if (!fs.existsSync(avatarPath)) return res.status(404).json({ error: 'avatar file missing' });

    const safeName = safeFileName(built.name, 'character');
    // headers are Latin1-only; ascii fallback + RFC 5987 filename* carries the real name
    const asciiName = safeName.replace(/[^\x20-\x7e]/g, '_') || 'character';
    const disposition = `attachment; filename="${asciiName}.${format}"; filename*=UTF-8''${encodeURIComponent(safeName)}.${format}`;
    if (format === 'png') {
        res.set('Content-Disposition', disposition);
        res.set('Content-Type', 'image/png');
        return res.send(writeCardChunks(fs.readFileSync(avatarPath), built.card));
    }
    // the card as V3 with its picture and every gallery file, the change recorded so a re-import reads it as stored
    const galleryDir = galleryDirFor(req.paths.galleryRoot, req.params.id);
    const media = listMedia(req.db, req.params.id).map(m => ({ displayName: m.displayName, path: path.join(galleryDir, m.file) })).filter(m => fs.existsSync(m.path));
    const { assets, readBack, files } = charxExportAssets(built.card.data.assets, media);
    const card = liftForCharx(built.card, { createdAt: char.createdAt, updatedAt: char.updatedAt, assets, readBack });
    const zipPath = packPath();
    try {
        await writeCharx(zipPath, card, stripCardChunks(fs.readFileSync(avatarPath), { assets: true }), files);
    } catch (err) {
        dropPack(zipPath);
        throw err;
    }
    res.set('Content-Disposition', disposition);
    res.set('Content-Type', 'application/zip');
    sendPack(res, zipPath);
});
