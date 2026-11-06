import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
    listBackgrounds, getBackground, findByUrlHash, findByContent, addBackground,
    renameBackground, deleteBackground, bindingsUsing, contentHashFor, isImageFile,
    getBinding, putBinding, deleteBinding, resolveBackground, bindingTargetExists,
    FIT_VALUES, RENDER_WIDTHS, SCOPES,
} from '../db/backgrounds-store.js';
import { getMedia } from '../db/media-store.js';
import {
    urlHashFor, displayNameForUrl, fetchMediaBytes, intakeErrorResponse, IMAGE_CT_RE,
} from '../lib/media-intake.js';
import { invalidateBackgroundThumbs } from './thumbs.js';
import { boolOf } from '../lib/query-params.js';
// dimensions ride the row so the picker can quote a choice's memory cost
import { imageSizeOf } from '../lib/image-size.js';
import { nameForBytes } from '../lib/stored-file.js';

export const backgroundsRouter = Router();


// ========================================
// VALIDATION (fail loud, name the valid set)
// ========================================

const RANGES = {
    opacity: [0, 1],
    blur: [0, 40],
    brightness: [0, 2],
    saturate: [0, 2],
};

/** @returns {string|null} an error message, or null when the patch is acceptable */
function validateBindingPatch(body) {
    if (!body || typeof body !== 'object') return 'JSON body required';

    if (body.backgroundId !== undefined && body.backgroundId !== null && !Number.isInteger(body.backgroundId)) {
        return 'backgroundId must be an integer id, or null for no background';
    }
    if (body.fit !== undefined && !FIT_VALUES.includes(body.fit)) {
        return `fit must be one of: ${FIT_VALUES.join(', ')}`;
    }
    if (body.renderWidth !== undefined && body.renderWidth !== null && !RENDER_WIDTHS.includes(body.renderWidth)) {
        return `renderWidth must be null (auto) or one of: ${RENDER_WIDTHS.join(', ')} (0 means the original)`;
    }
    for (const [field, [lo, hi]] of Object.entries(RANGES)) {
        const v = body[field];
        if (v === undefined) continue;
        if (typeof v !== 'number' || Number.isNaN(v) || v < lo || v > hi) {
            return `${field} must be a number between ${lo} and ${hi}`;
        }
    }
    if (body.blur !== undefined && !Number.isInteger(body.blur)) return 'blur must be a whole number of pixels';
    return null;
}

/** @returns {{scope: string, id: string|null}|{error: string}} */
function readScope(req) {
    const scope = req.params.scope;
    if (!SCOPES.includes(scope)) return { error: `scope must be one of: ${SCOPES.join(', ')}` };
    const id = req.params.id || null;
    if (scope === 'global' && id) return { error: 'the global scope takes no id' };
    if (scope !== 'global' && !id) return { error: `the ${scope} scope needs an id` };
    return { scope, id };
}

// ========================================
// RESOLUTION + BINDINGS
// (declared before /:id so a literal path is never eaten by the parameter)
// ========================================

backgroundsRouter.get('/resolve', (req, res) => {
    const chatId = req.query.chatId ? String(req.query.chatId) : '';
    if (!chatId) return res.status(400).json({ error: 'chatId=<chat id> required' });
    res.json(resolveBackground(req.db, chatId));
});

// two paths, since express 5 throws on the optional `:id?` (the global scope has no id)
const BINDING_PATHS = ['/bindings/:scope', '/bindings/:scope/:id'];

backgroundsRouter.get(BINDING_PATHS, (req, res) => {
    const s = readScope(req);
    if (s.error) return res.status(400).json({ error: s.error });
    // an envelope, not a 404: `binding: null` inherits, a null `background` deliberately stops inheritance
    res.json({ scope: s.scope, id: s.id, binding: getBinding(req.db, s.scope, s.id) });
});

backgroundsRouter.put(BINDING_PATHS, (req, res) => {
    const s = readScope(req);
    if (s.error) return res.status(400).json({ error: s.error });

    const bad = validateBindingPatch(req.body);
    if (bad) return res.status(400).json({ error: bad });
    if (!bindingTargetExists(req.db, s.scope, s.id)) {
        return res.status(404).json({ error: `${s.scope} not found` });
    }
    if (req.body.backgroundId != null && !getBackground(req.db, req.body.backgroundId)) {
        return res.status(404).json({ error: 'background not found' });
    }
    res.json(putBinding(req.db, s.scope, s.id, req.body));
});

backgroundsRouter.delete(BINDING_PATHS, (req, res) => {
    const s = readScope(req);
    if (s.error) return res.status(400).json({ error: s.error });
    if (!deleteBinding(req.db, s.scope, s.id)) return res.status(404).json({ error: 'no binding at this scope' });
    res.json({ ok: true });
});

// ========================================
// THE LIBRARY
// ========================================

backgroundsRouter.get('/', (req, res) => {
    res.json(listBackgrounds(req.db));
});

// raw body upload; filename rides ?name=, optional ?sourceUrl= records provenance and
// makes re-runs idempotent (same url_hash skip as from-url)
backgroundsRouter.post('/', express.raw({ type: () => true, limit: '200mb' }), async (req, res) => {
    const db = req.db;
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'file body required' });

    // named by its bytes before the gate, so a video named .png is refused and a picture with a cut name is not
    const name = nameForBytes(String(req.query.name || 'background.png'), req.body);
    if (!isImageFile(name)) {
        return res.status(415).json({ error: 'backgrounds are images only' });
    }
    // the store's refusals carry statusCode 400 and measure never throws; anything
    // else is a real, logged 500
    const sourceUrl = req.query.sourceUrl ? String(req.query.sourceUrl) : null;
    const urlHash = sourceUrl ? urlHashFor(sourceUrl) : null;
    if (urlHash) {
        const known = findByUrlHash(db, urlHash);
        if (known) return res.json({ skipped: true, reason: 'url', duplicateOf: known.id, displayName: known.displayName });
    }
    const dupe = findByContent(db, contentHashFor(req.body));
    if (dupe) return res.json({ skipped: true, reason: 'content', duplicateOf: dupe.id, displayName: dupe.displayName });

    const dims = await imageSizeOf(req.body);
    res.json(addBackground(db, req.paths, name, req.body, { sourceUrl, urlHash, ...dims }));
});

backgroundsRouter.post('/from-url', express.json(), async (req, res) => {
    const db = req.db;
    const url = String(req.body?.url || '');
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'http(s) url required' });

    const urlHash = urlHashFor(url);
    const known = findByUrlHash(db, urlHash);
    if (known) return res.json({ skipped: true, reason: 'url', duplicateOf: known.id, displayName: known.displayName });

    // only the fetch's own failures map through the intake's answer; a disk or store failure is a logged 500
    let fetched;
    try {
        fetched = await fetchMediaBytes(url, IMAGE_CT_RE);
    } catch (err) {
        const { status, error } = intakeErrorResponse(err);
        return res.status(status).json({ error });
    }
    const { bytes, contentType } = fetched;
    const dupe = findByContent(db, contentHashFor(bytes));
    if (dupe) return res.json({ skipped: true, reason: 'content', duplicateOf: dupe.id, displayName: dupe.displayName });

    const dims = await imageSizeOf(bytes);
    const name = displayNameForUrl(url, contentType, bytes);
    if (!isImageFile(name)) return res.status(415).json({ error: 'backgrounds are images only' });
    res.json(addBackground(db, req.paths, name, bytes, { sourceUrl: url, urlHash, ...dims }));
});

// promote a gallery image by server-side copy, not a shared row: media cascades with its character
backgroundsRouter.post('/from-media/:mediaId', async (req, res) => {
    const db = req.db;
    const row = getMedia(db, req.params.mediaId);
    if (!row) return res.status(404).json({ error: 'media not found' });
    if (row.kind !== 'image') return res.status(415).json({ error: 'backgrounds are images only' });

    const source = path.join(req.paths.galleryRoot, row.charId, row.file);
    if (!fs.existsSync(source)) return res.status(404).json({ error: 'file missing' });

    const bytes = fs.readFileSync(source);
    const dupe = findByContent(db, contentHashFor(bytes));
    if (dupe) return res.json({ skipped: true, reason: 'content', duplicateOf: dupe.id, displayName: dupe.displayName });

    const dims = await imageSizeOf(bytes);
    res.json(addBackground(db, req.paths, row.displayName, bytes, { ...dims }));
});

backgroundsRouter.patch('/:id', (req, res) => {
    if (typeof req.body?.displayName !== 'string') return res.status(400).json({ error: 'displayName required' });
    const item = renameBackground(req.db, req.params.id, req.body.displayName);
    if (!item) return res.status(404).json({ error: 'background not found' });
    res.json(item);
});

backgroundsRouter.delete('/:id', (req, res) => {
    const db = req.db;
    if (!getBackground(db, req.params.id)) return res.status(404).json({ error: 'background not found' });

    // a wallpaper in use takes a second ask, its loss would only be noticed later
    const users = bindingsUsing(db, req.params.id);
    if (users.length && !boolOf(req.query.force, 'force')) {
        return res.status(409).json({
            error: `in use by ${users.length} binding${users.length === 1 ? '' : 's'}`,
            usedBy: users,
            hint: 'repeat with ?force=true to delete it and return those scopes to inherited',
        });
    }
    deleteBackground(db, req.paths, req.params.id);
    invalidateBackgroundThumbs(req.paths.backgroundThumbsDir, Number(req.params.id));
    res.json({ ok: true, unbound: users.length });
});
