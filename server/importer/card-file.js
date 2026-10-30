import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { isPng, readCardChunks, stripCardChunks } from '../lib/png-card.js';
import { readZipEntryAsync } from '../lib/zip.js';
import { openCharx, charxAssets, charxIcon, charxMediaName, storedAssets } from '../lib/charx.js';
import { normalizeCard } from '../lib/card-normalize.js';
import { addMediaFile, mediaExistsByName, sanitizeDisplayName } from '../db/media-store.js';
import { accountHandles } from '../db/server-store.js';
import { userPaths } from '../config.js';
import { isUuid } from '../lib/uuid.js';
import { importCharacterParts } from './card-import.js';
import { readJsonFile } from '../lib/json-file.js';
import { httpError } from '../lib/http-error.js';

// a card file in (a card PNG, a charx), a character out, through a stage: the card answered first so a client can amend it

const STAGE_TTL_MS = 60 * 60 * 1000;

// a name sanitizing to nothing takes its member's file name, so preview, commit and gallery agree and the file lands
function galleryNameOf(asset) {
    const name = charxMediaName(asset);
    return sanitizeDisplayName(name) ? name : path.posix.basename(asset.entry.name);
}
// the plain route's limit: a PNG is read whole
const PNG_MAX_BYTES = 100 * 1024 * 1024;

const partsOf = (card) => (card?.spec === 'chara_card_v3' ? { v3: card, v2: null } : { v3: null, v2: card });

/** The file opened as the format it is: a card PNG's bytes, or a charx; null for anything else. */
async function openCardFile(file) {
    const head = Buffer.alloc(16);
    const fd = fs.openSync(file, 'r');
    let n;
    try { n = fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
    if (isPng(head.subarray(0, n))) {
        if (fs.statSync(file).size > PNG_MAX_BYTES) throw httpError(413, 'a card PNG is at most 100 MB');
        return { format: 'png', buffer: await fs.promises.readFile(file) };
    }
    const charx = await openCharx(file);
    return charx ? { format: 'charx', charx } : null;
}

/**
 * What a card file holds: its format, the card as the import would store it, whether it has a picture, the gallery files it adds.
 * @returns {Promise<{ format: 'png'|'charx', card: object|null, picture: boolean, media: {name: string, size: number}[] } | null>}
 */
async function readCardFile(file) {
    const opened = await openCardFile(file);
    if (!opened) return null;
    if (opened.format === 'png') {
        const parsed = readCardChunks(opened.buffer);
        return { format: 'png', card: parsed ? normalizeCard(parsed) : null, picture: true, media: [] };
    }
    const card = normalizeCard(partsOf(opened.charx.card));
    if (card && card.data.assets !== undefined) card.data.assets = storedAssets(card.data.assets);
    const assets = charxAssets(opened.charx);
    const icon = charxIcon(assets);
    return {
        format: 'charx', card, picture: !!icon,
        media: assets.filter(a => a !== icon).map(a => ({ name: galleryNameOf(a), size: a.entry.size })),
    };
}

/** Why an amended card would not import, or null (none given is none wrong): checked before a stage is claimed. */
export function amendedCardProblem(card) {
    if (card == null) return null;
    if (typeof card !== 'object' || Array.isArray(card)) return 'card must be a card object';
    return normalizeCard(partsOf(card)) ? null : 'the card has no name';
}

// a flat square, for a container that carries no picture (or one no decoder reads)
const placeholderPng = () => sharp({ create: { width: 256, height: 256, channels: 3, background: '#2b2b30' } }).png().toBuffer();

async function pictureOf(bytes) {
    if (isPng(bytes)) return stripCardChunks(bytes);
    try { return await sharp(bytes).png().toBuffer(); } catch { return placeholderPng(); }
}

/** Import a card file (or the caller's amended card), its picture the avatar and a charx's other files gallery rows; null with no card. */
export async function importCardFile(db, paths, file, { card = null, sourceName = null, onExisting = null, source = null, resolved = null } = {}) {
    const opened = await openCardFile(file);
    if (!opened) return null;
    const opts = { sourceName, force: onExisting, paths, source, resolved };
    if (opened.format === 'png') {
        const parsed = card ? partsOf(card) : readCardChunks(opened.buffer);
        if (!parsed) return null;
        const result = importCharacterParts(db, parsed, () => stripCardChunks(opened.buffer), opts);
        return result && { ...result, media: 0 };
    }
    const assets = charxAssets(opened.charx);
    const icon = charxIcon(assets);
    const raw = card || opened.charx.card;
    const incoming = Array.isArray(raw?.data?.assets) ? { ...raw, data: { ...raw.data, assets: storedAssets(raw.data.assets) } } : raw;
    const picture = icon ? await pictureOf(await readZipEntryAsync(file, icon.entry)) : await placeholderPng();
    // each file is read, and so checked, before the character exists: a lying archive is refused whole
    for (const a of assets) if (a !== icon) await readZipEntryAsync(file, a.entry);
    const result = importCharacterParts(db, partsOf(incoming), picture, opts);
    if (!result || result.excluded) return result;
    let media = 0, mediaFailed = 0;
    if (!result.skipped || result.reason === 'identical') {
        for (const a of assets) {
            if (a === icon) continue;
            const name = galleryNameOf(a);
            if (result.skipped && mediaExistsByName(db, result.id, name)) continue;
            // the character has landed: a file that cannot be written is counted, never a failed
            // import the caller would send again
            try {
                addMediaFile(db, paths, result.id, name, await readZipEntryAsync(file, a.entry));
                media++;
            } catch (err) {
                mediaFailed++;
                console.error(`[import] ${name} did not join the gallery of ${result.id}:`, err.message);
            }
        }
    }
    return { ...result, media, mediaFailed };
}

// ================================================================ the stage

function sweepStages(dir) {
    const cutoff = Date.now() - STAGE_TTL_MS;
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        try { if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full); } catch { /* raced with its own commit */ }
    }
}

const stageFiles = (paths, id) => ({ id, file: path.join(paths.stagingDir, `${id}.card`), meta: path.join(paths.stagingDir, `${id}.json`) });

/** A new stage in the account's home: its id and its two files, the stale stages swept first. */
export function newStage(paths) {
    fs.mkdirSync(paths.stagingDir, { recursive: true });
    sweepStages(paths.stagingDir);
    return stageFiles(paths, crypto.randomUUID());
}

/** Every account's stale stages swept now: a stage nobody committed or dropped is gone after its hour, whether or not another is ever made. */
export function sweepStaleStages({ serverDb = null } = {}) {
    for (const handle of accountHandles(serverDb)) {
        try {
            const dir = userPaths(handle).stagingDir;
            if (fs.existsSync(dir)) sweepStages(dir);
        } catch { /* an account whose home cannot be read keeps its stages until it can */ }
    }
}

/** The sweep at boot and once an hour after, for the serving process alone. */
export function startStageSweeper({ serverDb = null } = {}) {
    sweepStaleStages({ serverDb });
    const timer = setInterval(() => sweepStaleStages({ serverDb }), STAGE_TTL_MS);
    timer.unref?.();
    return timer;
}

/** A stage by id, claimed so no second commit runs it; null when unknown, claimed or stale. 400 for a non-uuid id, before any path. */
export function claimStage(paths, id) {
    if (!isUuid(String(id))) throw httpError(400, 'a stage id is a uuid');
    const stage = stageFiles(paths, id);
    const claimed = `${stage.file}.claimed`;
    try { fs.renameSync(stage.file, claimed); } catch { return null; }
    if (fs.statSync(claimed).mtimeMs < Date.now() - STAGE_TTL_MS) {
        dropStage(paths, id);
        return null;
    }
    // a claim is fresh work: the sweep must not take the file from under the commit reading it
    const now = new Date();
    fs.utimesSync(claimed, now, now);
    // a stage whose meta was lost still imports
    const meta = readJsonFile(stage.meta) ?? {};
    return { ...stage, file: claimed, meta, release: () => { try { fs.renameSync(claimed, stage.file); } catch { /* dropped meanwhile */ } } };
}

/** Remove a stage's files, claimed or not. Answers whether there was one. */
export function dropStage(paths, id) {
    if (!isUuid(String(id))) throw httpError(400, 'a stage id is a uuid');
    const stage = stageFiles(paths, id);
    let found = false;
    for (const f of [stage.file, `${stage.file}.claimed`, stage.meta]) {
        try { fs.unlinkSync(f); found = true; } catch { /* not there */ }
    }
    return found;
}

/** Record what a stage came in as, beside its file. */
function writeStageMeta(stage, meta) {
    fs.writeFileSync(stage.meta, JSON.stringify(meta));
}

/** Read a written stage into the stage route's answer, or throw its refusal (400, 415, 422), the stage dropped either way. */
export async function finishStage(paths, stage, { name = null } = {}) {
    try {
        if (!fs.statSync(stage.file).size) throw httpError(400, 'card file body required');
        const read = await readCardFile(stage.file);
        if (!read) throw httpError(415, 'a card file is a card PNG or a charx');
        if (!read.card) throw httpError(422, 'no character card found in this file');
        writeStageMeta(stage, { format: read.format, name });
        return { stageId: stage.id, format: read.format, card: read.card, picture: read.picture, media: read.media };
    } catch (e) {
        dropStage(paths, stage.id);
        throw e;
    }
}

/** Stage a card file the server holds (a Buffer, or a web or node stream) exactly as an upload to the stage route is staged. */
export async function stageCardBody(paths, body, { name = null } = {}) {
    const stage = newStage(paths);
    try {
        if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
            fs.writeFileSync(stage.file, body);
        } else {
            const source = typeof body?.getReader === 'function' ? Readable.fromWeb(body) : body;
            if (typeof source?.pipe !== 'function') throw httpError(400, 'a staged body is a Buffer or a stream');
            await pipeline(source, fs.createWriteStream(stage.file));
        }
    } catch (e) {
        dropStage(paths, stage.id);
        throw e;
    }
    return finishStage(paths, stage, { name });
}
