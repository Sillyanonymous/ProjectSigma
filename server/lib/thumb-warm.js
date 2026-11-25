import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { listImageMediaPage, countImageMedia } from '../db/media-store.js';
import { thumbPath } from './thumb-cache.js';

// Pre-generates the avatar thumb tiers the client renders so a migrated library doesnt pay on first scroll

const AVATAR_THUMB_SIZES = [192, 512];
// 384 is the main gallery grid tier; the chat gallery panel's 192/768 stay on demand
// (per-character surfaces, touched selectively) to keep the warm bounded
const MEDIA_THUMB_SIZES = [384];

// a slice at a time with async cache checks, so a big library is never one listing on the event loop
const SLICE = 500;

const cached = (file) => fsp.access(file).then(() => true, () => false);

// concurrency stays low on purpose: parallel small IO seek-thrashes a spinning disk
async function runJobs(jobs, concurrency, make, tally, onProgress) {
    async function worker() {
        for (;;) {
            const job = jobs.pop();
            if (!job) return;
            const tmp = `${job.out}.tmp-${process.pid}`;
            try {
                await make(job).resize({ width: job.size, withoutEnlargement: true }).webp({ quality: 82 }).toFile(tmp);
                fs.renameSync(tmp, job.out);
                tally.made++;
            } catch {
                tally.failed++; // an unreadable source falls back to on-demand, same as before
                try { fs.unlinkSync(tmp); } catch { /* sharp may never have written it */ }
            }
            tally.done++;
            onProgress?.(tally.done, tally.total, tally.failed);
        }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
}

// a slice's jobs: each width of each source whose thumb is not cached yet; a cached one is counted as handled
async function missing(sources, sizes, dir, tally, onProgress) {
    const jobs = [];
    for (const s of sources) {
        for (const size of sizes) {
            const out = thumbPath(dir, s.key, size);
            if (await cached(out)) {
                tally.done++;
                tally.cached++;
                onProgress?.(tally.done, tally.total, tally.failed);
            } else jobs.push({ ...s, size, out });
        }
    }
    return jobs;
}

const newTally = (sources, sizes) => ({ total: sources * sizes.length, done: 0, made: 0, failed: 0, cached: 0 });
const result = (t) => ({ total: t.total, generated: t.made, failed: t.failed, cached: t.cached });

async function countAvatars(dir) {
    let n = 0;
    for await (const ent of await fsp.opendir(dir)) if (ent.isFile() && ent.name.endsWith('.png')) n++;
    return n;
}

/** Each portrait's widths, counted first: total stands from the first report, a cached thumb counts as done; onCount hears the count before any work. */
export async function warmAvatarThumbs(paths, { concurrency = 2, onProgress = null, onCount = null } = {}) {
    await fsp.mkdir(paths.avatarThumbsDir, { recursive: true });
    let sources;
    try { sources = await countAvatars(paths.avatarsDir); } catch { return result(newTally(0, AVATAR_THUMB_SIZES)); }
    const tally = newTally(sources, AVATAR_THUMB_SIZES);
    onCount?.({ sources, sizes: AVATAR_THUMB_SIZES.length, total: tally.total });
    const dir = await fsp.opendir(paths.avatarsDir);
    const make = (job) => sharp(path.join(paths.avatarsDir, job.f));
    let slice = [];
    const flush = async () => {
        await runJobs(await missing(slice, AVATAR_THUMB_SIZES, paths.avatarThumbsDir, tally, onProgress), concurrency, make, tally, onProgress);
        slice = [];
    };
    for await (const ent of dir) {
        if (!ent.isFile() || !ent.name.endsWith('.png')) continue;
        slice.push({ f: ent.name, key: ent.name.slice(0, -4) });
        if (slice.length >= SLICE) await flush();
    }
    await flush();
    return result(tally);
}

/** Same contract for gallery media: image rows only (a video or sound gets no thumbnail), keyed by row id, a page at a time. */
export async function warmMediaThumbs(db, paths, { sizes = MEDIA_THUMB_SIZES, concurrency = 2, onProgress = null, onCount = null } = {}) {
    await fsp.mkdir(paths.mediaThumbsDir, { recursive: true });
    const sources = countImageMedia(db);
    const tally = newTally(sources, sizes);
    onCount?.({ sources, sizes: sizes.length, total: tally.total });
    const make = (job) => sharp(path.join(paths.galleryRoot, job.charId, job.file), { animated: /\.gif$/i.test(job.file) });
    for (let after = 0; ;) {
        const rows = listImageMediaPage(db, after, SLICE);
        if (!rows.length) break;
        after = rows[rows.length - 1].id;
        await runJobs(await missing(rows.map(r => ({ ...r, key: r.id })), sizes, paths.mediaThumbsDir, tally, onProgress), concurrency, make, tally, onProgress);
    }
    return result(tally);
}
