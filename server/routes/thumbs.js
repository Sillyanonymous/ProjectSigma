import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { warmAvatarThumbs, warmMediaThumbs } from '../lib/thumb-warm.js';
import { THUMB_SIZES, thumbPath } from '../lib/thumb-cache.js';
import { getMedia } from '../db/media-store.js';
import { getBackground } from '../db/backgrounds-store.js';
import { getAttachment, attachmentDirFor } from '../db/attachments-store.js';
import { isUuid } from '../lib/uuid.js';

// on-demand sharp resize, cached as webp per user; a size snaps to the nearest of THUMB_SIZES
function clampSize(raw) {
    const want = Number(raw) || 512;
    return THUMB_SIZES.reduce((best, s) => Math.abs(s - want) < Math.abs(best - want) ? s : best, THUMB_SIZES[0]);
}

/**
 * Resize, cache, serve; tmp-then-rename so two cold requests never serve a half-written file.
 * @param {() => void} onError when sharp cant read the source, each caller falls back to its original
 */
async function serveThumb(res, { source, cacheDir, cacheKey, size, animated = false, cachePolicy = 'public, max-age=86400', onError }) {
    const cached = thumbPath(cacheDir, cacheKey, size);
    let tmp = null;
    try {
        if (!fs.existsSync(cached)) {
            fs.mkdirSync(cacheDir, { recursive: true });
            tmp = `${cached}.tmp-${process.pid}-${Date.now()}`;
            await sharp(source, { animated }).resize({ width: size, withoutEnlargement: true }).webp({ quality: 82 }).toFile(tmp);
            try { fs.renameSync(tmp, cached); } catch { fs.unlinkSync(tmp); }
        }
        res.set('Cache-Control', cachePolicy);
        res.type('image/webp').send(fs.readFileSync(cached));
    } catch {
        // a resize the disk refused part way leaves no temp in the cache
        if (tmp) { try { fs.unlinkSync(tmp); } catch { /* renamed, or never written */ } }
        onError();
    }
}

export const thumbsRouter = Router();

// avatar thumb pre-warm, one background run per home, progress by polling
const warmRuns = new Map(); // paths.root -> { running, done, total, failed }

thumbsRouter.post('/warm', (req, res) => {
    const key = req.paths.root;
    const current = warmRuns.get(key);
    if (current?.running) return res.status(409).json({ error: 'a thumbnail warm-up is already running', ...current });
    const state = { running: true, phase: 'avatars', done: 0, total: 0, failed: 0 };
    warmRuns.set(key, state);
    const { db, paths } = req;
    (async () => {
        const a = await warmAvatarThumbs(paths, {
            onProgress: (done, total, failed) => { state.done = done; state.total = total; state.failed = failed; },
        });
        state.phase = 'media';
        const m = await warmMediaThumbs(db, paths, {
            onProgress: (done, total, failed) => { state.done = a.total + done; state.total = a.total + total; state.failed = a.failed + failed; },
        });
        Object.assign(state, {
            running: false, phase: 'done',
            done: a.total + m.total, total: a.total + m.total, failed: a.failed + m.failed,
            generated: a.generated + m.generated,
        });
    })().catch(() => { state.running = false; });
    res.json({ ok: true, started: true });
});

thumbsRouter.get('/warm', (req, res) => {
    res.json(warmRuns.get(req.paths.root) ?? { running: false, done: 0, total: 0, failed: 0 });
});

thumbsRouter.get('/avatar/:id', async (req, res) => {
    const id = req.params.id.replace(/\.png$/i, '');
    if (!isUuid(id)) return res.status(400).json({ error: 'bad id' });
    const source = path.join(req.paths.avatarsDir, `${id}.png`);
    if (!fs.existsSync(source)) return res.status(404).json({ error: 'avatar not found' });

    await serveThumb(res, {
        source,
        cacheDir: req.paths.avatarThumbsDir,
        cacheKey: id,
        size: clampSize(req.query.s),
        onError: () => res.type('image/png').send(fs.readFileSync(source)),
    });
});

thumbsRouter.get('/media/:mediaId', async (req, res) => {
    const row = getMedia(req.db, req.params.mediaId);
    if (!row) return res.status(404).json({ error: 'media not found' });
    const source = path.join(req.paths.galleryRoot, row.charId, row.file);
    if (!fs.existsSync(source)) return res.status(404).json({ error: 'file missing' });
    if (row.kind !== 'image') return res.status(415).json({ error: 'thumbnails are image-only' });

    await serveThumb(res, {
        source,
        cacheDir: req.paths.mediaThumbsDir,
        cacheKey: row.id,
        size: clampSize(req.query.s),
        animated: /\.gif$/i.test(row.file),
        onError: () => res.sendFile(row.file, { root: path.join(req.paths.galleryRoot, row.charId) }),
    });
});

thumbsRouter.get('/attachment/:id', async (req, res) => {
    const row = getAttachment(req.db, req.params.id);
    if (!row) return res.status(404).json({ error: 'attachment not found' });
    const dir = attachmentDirFor(req.paths.attachmentsRoot, row.chatId ?? row.studioId);
    const source = path.join(dir, row.file);
    if (!fs.existsSync(source)) return res.status(404).json({ error: 'file missing' });
    if (row.kind !== 'image') return res.status(415).json({ error: 'thumbnails are image-only' });

    await serveThumb(res, {
        source,
        cacheDir: req.paths.attachmentThumbsDir,
        cacheKey: row.id,
        size: clampSize(req.query.s),
        animated: /\.gif$/i.test(row.file),
        onError: () => res.sendFile(row.file, { root: dir }),
    });
});

thumbsRouter.get('/background/:id', async (req, res) => {
    const row = getBackground(req.db, req.params.id);
    if (!row) return res.status(404).json({ error: 'background not found' });
    const source = path.join(req.paths.backgroundsDir, row.file);
    if (!fs.existsSync(source)) return res.status(404).json({ error: 'file missing' });

    await serveThumb(res, {
        source,
        cacheDir: req.paths.backgroundThumbsDir,
        cacheKey: row.id,
        size: clampSize(req.query.s),
        animated: /\.gif$/i.test(row.file),
        onError: () => res.sendFile(row.file, { root: req.paths.backgroundsDir }),
    });
});

thumbsRouter.get('/persona/:id', async (req, res) => {
    const id = req.params.id.replace(/\.png$/i, '');
    if (!isUuid(id)) return res.status(400).json({ error: 'bad id' });
    const source = path.join(req.paths.personaAvatarsDir, `${id}.png`);
    if (!fs.existsSync(source)) return res.status(404).json({ error: 'persona avatar not found' });

    await serveThumb(res, {
        source,
        cacheDir: req.paths.personaThumbsDir,
        cacheKey: id,
        size: clampSize(req.query.s),
        // revalidate, never max-age: the persona PNG rewrites in place with no cache-bust token
        cachePolicy: 'no-cache',
        onError: () => res.type('image/png').send(fs.readFileSync(source)),
    });
});

// the invalidators live in lib/ so the importer needs no router; re-exported for the routes that import them here
export { invalidateMediaThumbs, invalidateAvatarThumbs, invalidateBackgroundThumbs, invalidatePersonaThumbs } from '../lib/thumb-cache.js';
