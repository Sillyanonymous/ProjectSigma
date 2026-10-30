// Images a model reads: loaded from the account's files or the caller's bytes, and shrunk once to what every host takes.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { userPaths } from '../config.js';
import { ownerOf } from '../db/changes.js';
import { getMedia, galleryDirFor } from '../db/media-store.js';
import { characterExists } from '../db/characters-store.js';
import { getPersona } from '../db/personas-store.js';
import { getAttachment, attachmentDirFor } from '../db/attachments-store.js';
import { IMAGE_MAX_EDGE } from './budget.js';
import { badRequest } from './errors.js';

// the tightest per-image cap a host documents (Z.ai)
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
// bounds on one call's work, not a host's rules
const IMAGES_PER_CALL = 100;

/** The most pictures a request through a connection carries: its own limit, never past the service's. */
export const pictureCapOf = (limit) => Math.min(limit ?? IMAGES_PER_CALL, IMAGES_PER_CALL);
const INLINE_MAX_MB = 20;
// measured on the base64 text, so a picture past the cap is refused before it is decoded
const INLINE_MAX_CHARS = Math.ceil((INLINE_MAX_MB * 1024 * 1024) / 3) * 4;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

/** One image as every host takes it: the long edge at most IMAGE_MAX_EDGE, upright, no metadata, PNG only where it is transparent. */
async function normalize(bytes) {
    let meta;
    try { meta = await sharp(bytes).metadata(); } catch { throw badRequest('an image is not a decodable picture'); }
    const attempts = meta.hasAlpha ? ['png', 70, 50] : [85, 70, 50];
    for (const step of attempts) {
        // rotate() with no angle applies the EXIF orientation, and the output carries no metadata
        const img = sharp(bytes, { animated: false }).rotate()
            .resize({ width: IMAGE_MAX_EDGE, height: IMAGE_MAX_EDGE, fit: 'inside', withoutEnlargement: true });
        const out = await (step === 'png' ? img.png({ compressionLevel: 9 }) : img.flatten({ background: '#ffffff' }).jpeg({ quality: step, mozjpeg: true }))
            .toBuffer({ resolveWithObject: true });
        if (out.data.length <= IMAGE_MAX_BYTES) {
            return { mediaType: step === 'png' ? 'image/png' : 'image/jpeg', data: out.data.toString('base64'), width: out.info.width, height: out.info.height };
        }
    }
    throw badRequest('an image stays over 5 MB after shrinking');
}

// a stored file shrunk once per version of it: a portrait or a chat's pictures are read on every turn
const cache = new Map();
let cacheBytes = 0;
const loading = new Map();

async function loadFile(file) {
    let st;
    try { st = await fs.promises.stat(file); } catch { throw badRequest('an image named by reference has no file'); }
    const key = `${file}|${st.mtimeMs}|${st.size}`;
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
    // a second request for the same version waits on the first shrink, so its bytes are counted once
    if (loading.has(key)) return loading.get(key);
    const load = (async () => {
        const out = await normalize(await fs.promises.readFile(file));
        cache.set(key, out);
        cacheBytes += out.data.length;
        for (const [k, v] of cache) {
            if (cacheBytes <= CACHE_MAX_BYTES) break;
            cache.delete(k);
            cacheBytes -= v.data.length;
        }
        return out;
    })().finally(() => loading.delete(key));
    loading.set(key, load);
    return load;
}

// a reference is the account's own: the owner of the db names the folders, and the row must exist
function refFile(db, ref) {
    const owner = ownerOf(db);
    if (!owner) throw badRequest('an image named by reference needs an account\'s library');
    const paths = userPaths(owner);
    if (ref.kind === 'avatar') {
        if (!characterExists(db, String(ref.id))) throw badRequest(`no character ${ref.id} to show the model`);
        return path.join(paths.avatarsDir, `${ref.id}.png`);
    }
    if (ref.kind === 'media') {
        const m = getMedia(db, ref.id);
        if (!m || m.kind !== 'image') throw badRequest(`no gallery image ${ref.id} to show the model`);
        return path.join(galleryDirFor(paths.galleryRoot, m.charId), m.file);
    }
    if (ref.kind === 'persona') {
        const p = getPersona(db, String(ref.id));
        if (!p?.avatar) throw badRequest(`no persona picture ${ref.id} to show the model`);
        return path.join(paths.personaAvatarsDir, `${p.id}.png`);
    }
    if (ref.kind === 'attachment') {
        const a = getAttachment(db, ref.id);
        if (!a || a.kind !== 'image') throw badRequest(`no chat picture ${ref.id} to show the model`);
        return path.join(attachmentDirFor(paths.attachmentsRoot, a.chatId ?? a.studioId), a.file);
    }
    throw badRequest(`an image reference of kind '${ref.kind}' is not one the app knows`);
}

function loadImage(db, img) {
    if (typeof img?.data === 'string') {
        const text = img.data.replace(/^data:[^,]*;base64,/, '');
        if (text.length > INLINE_MAX_CHARS) throw badRequest(`an image is over ${INLINE_MAX_MB} MB`);
        const bytes = Buffer.from(text, 'base64');
        if (!bytes.length) throw badRequest('an image has no bytes');
        return normalize(bytes);
    }
    if (img?.ref && typeof img.ref === 'object') return loadFile(refFile(db, img.ref));
    throw badRequest('an image is { data } (base64 or a data URL) or { ref: { kind: avatar | media | persona | attachment, id } }');
}

// a host's encoder reads a picture much smaller than this as a few blurred tokens, and the model guesses
const PROBE_EDGE = 512;

/** A picture of one solid colour, base64, for the sight probe. */
export async function solidPicture(hex) {
    return (await sharp({ create: { width: PROBE_EDGE, height: PROBE_EDGE, channels: 3, background: hex } }).png().toBuffer()).toString('base64');
}

/** The messages with every image read and shrunk; an image the user's turn does not carry, or one that cannot be read, is refused. */
export async function prepareImages(db, messages) {
    let count = 0;
    const out = [];
    for (const m of messages) {
        if (m?.images == null) { out.push(m); continue; }
        if (!Array.isArray(m.images)) throw badRequest('a message\'s images are a list');
        const { images, ...rest } = m;
        if (!images.length) { out.push(rest); continue; }
        // the hosts take images in the user's turns only
        if (m.role !== 'user') throw badRequest('images ride the user\'s messages only');
        count += images.length;
        if (count > IMAGES_PER_CALL) throw badRequest(`a call carries at most ${IMAGES_PER_CALL} images`);
        out.push({ ...rest, images: await Promise.all(images.map(img => loadImage(db, img))) });
    }
    return out;
}
