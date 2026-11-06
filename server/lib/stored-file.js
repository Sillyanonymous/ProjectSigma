import path from 'node:path';
import crypto from 'node:crypto';

// The one rule for a stored file's name and kind. pure (path and crypto only) so a store and a route both reach it

const ILLEGAL_NAME_RE = /[<>:"/\\|?*\x00-\x1f]/g;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov']);
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.flac']);

/** A name a disk can hold: each character no filesystem takes made '_', trimmed; fallback when nothing is left. */
export function safeFileName(name, fallback = '') {
    return String(name || '').replace(ILLEGAL_NAME_RE, '_').trim() || fallback;
}

/** A stored file's display name: the last segment of what it was called, made safe; null when nothing is left. */
export function sanitizeDisplayName(name) {
    return safeFileName(path.basename(String(name || ''))) || null;
}

/** The uuid name the bytes land under on disk, keeping the display name's extension. */
export function mintPhysicalName(displayName) {
    const ext = path.extname(displayName).toLowerCase().slice(0, 10) || '';
    return `${crypto.randomUUID()}${ext}`;
}

/** The wanted display name, or the first free 'stem (n).ext' after it; exists(name) probes the caller's rows. */
export function uniqueDisplayName(wanted, exists) {
    if (!exists(wanted)) return wanted;
    const ext = path.extname(wanted);
    const stem = wanted.slice(0, wanted.length - ext.length);
    for (let n = 2; ; n++) {
        const candidate = `${stem} (${n})${ext}`;
        if (!exists(candidate)) return candidate;
    }
}

/** sha256 of the bytes: the content key both dedupe ladders compare. */
export function contentHashFor(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function isImageFile(file) {
    return IMAGE_EXT.has(path.extname(file).toLowerCase());
}

/** The kind a stored file is listed and served as, by its extension. */
export function kindForFile(file) {
    const ext = path.extname(file).toLowerCase();
    if (IMAGE_EXT.has(ext)) return 'image';
    if (VIDEO_EXT.has(ext)) return 'video';
    if (AUDIO_EXT.has(ext)) return 'audio';
    return 'file';
}

// what the first bytes say, for CDNs that say nothing: an octet-stream with a bare path would never thumbnail
const MAGIC = [
    { ext: '.png', test: b => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
    { ext: '.jpg', test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { ext: '.gif', test: b => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8' },
    { ext: '.webp', test: b => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
    { ext: '.wav', test: b => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE' },
    { ext: '.avif', test: b => b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp' && /^avi[fs]/.test(b.toString('latin1', 8, 12)) },
    { ext: '.m4a', test: b => b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp' && /^M4[ABP] $/.test(b.toString('latin1', 8, 12)) },
    { ext: '.mov', test: b => b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp' && b.toString('latin1', 8, 12) === 'qt  ' },
    // a HEIC photo or a camera's raw is an ftyp file too, and no kind the app shows: unknown, never a video
    { ext: null, test: b => b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp' && /^(hei[cxms]|hev[cx]|mif1|msf1|crx )$/.test(b.toString('latin1', 8, 12)) },
    { ext: '.mp4', test: b => b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp' },
    { ext: '.webm', test: b => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
    { ext: '.ogg', test: b => b.length > 4 && b.toString('latin1', 0, 4) === 'OggS' },
    { ext: '.mp3', test: b => b.length > 3 && (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && [0x02, 0x04].includes(b[1] & 0x06))) },
];
export function sniffMediaExt(bytes) {
    if (!Buffer.isBuffer(bytes)) return null;
    for (const m of MAGIC) if (m.test(bytes)) return m.ext;
    return null;
}

/**
 * The name the bytes earn: one whose kind they contradict takes their extension; unknown bytes keep it.
 * @param {string} name
 * @param {Buffer} bytes the file, or at least its first 16 bytes
 */
export function nameForBytes(name, bytes) {
    const ext = sniffMediaExt(bytes);
    if (!ext) return name;
    const named = kindForFile(name);
    // an MP4-family box holds sound or picture alike, and its first bytes cannot tell which: a name saying either stands
    if (FTYP_EXTS.has(ext) && (named === 'audio' || named === 'video')) return name;
    if (named === kindForFile(`x${ext}`)) return name;
    const given = path.extname(name);
    // a media extension, or a short word one (a cut '.pn', a '.bin'), gives way; a dot inside a name ('Dr. Smith') stays
    const swap = given && (named !== 'file' || /^\.[a-z][a-z0-9]{0,4}$/i.test(given));
    return `${swap ? name.slice(0, -given.length) : name}${ext}`;
}
const FTYP_EXTS = new Set(['.mp4', '.m4a', '.mov']);
