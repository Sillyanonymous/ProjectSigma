import crypto from 'node:crypto';
import path from 'node:path';
import { guardedFetch, readBodyCapped } from './net-guard.js';
import { safeFileName } from './stored-file.js';
import { httpError } from './http-error.js';

// Remote media intake for the gallery and the backgrounds: one copy of the size cap, timeout and type gate.

const FROM_URL_MAX_BYTES = 200 * 1024 * 1024;
const FROM_URL_TIMEOUT_MS = 60_000;
const MEDIA_CT_RE = /^(image|video|audio)\//i;
export const IMAGE_CT_RE = /^image\//i;
// labels that say only "bytes", whatever they hold
const GENERIC_BINARY_RE = /^\s*(application\/(octet-stream|binary|x-binary|download|force-download)|binary\/octet-stream)\s*(;|$)/i;

const CT_EXT = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'image/avif': '.avif', 'video/mp4': '.mp4', 'video/webm': '.webm',
    'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/mp4': '.m4a',
};

export function urlHashFor(url) {
    return crypto.createHash('sha256').update(String(url)).digest('hex');
}

// what the first bytes say, for CDNs that say nothing: an octet-stream with a bare path would never thumbnail
const MAGIC = [
    { ext: '.png', test: b => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
    { ext: '.jpg', test: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { ext: '.gif', test: b => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8' },
    { ext: '.webp', test: b => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
    { ext: '.wav', test: b => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE' },
    { ext: '.avif', test: b => b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp' && /^avi[fs]/.test(b.toString('latin1', 8, 12)) },
    { ext: '.m4a', test: b => b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp' && b.toString('latin1', 8, 12) === 'M4A ' },
    { ext: '.mp4', test: b => b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp' },
    { ext: '.webm', test: b => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
    { ext: '.ogg', test: b => b.length > 4 && b.toString('latin1', 0, 4) === 'OggS' },
    { ext: '.mp3', test: b => b.length > 3 && (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) },
];
function sniffMediaExt(bytes) {
    if (!Buffer.isBuffer(bytes)) return null;
    for (const m of MAGIC) if (m.test(bytes)) return m.ext;
    return null;
}

// the url's last segment, its extension from the content type when missing, else from the bytes
export function displayNameForUrl(url, contentType, bytes = null) {
    let base = 'media';
    try {
        const segs = new URL(url).pathname.split('/').filter(Boolean);
        if (segs.length) base = decodeURIComponent(segs[segs.length - 1]).slice(0, 60);
    } catch { /* a bad url or escape keeps the generic name */ }
    base = safeFileName(base, 'media');
    if (!path.extname(base)) {
        const ext = CT_EXT[(contentType || '').split(';')[0].toLowerCase()] || sniffMediaExt(bytes);
        if (ext) base += ext;
    }
    return base;
}

/**
 * Fetch remote bytes and validate them as media. Throws with `statusCode` set, so callers
 * map the failure to a status instead of flattening everything to 502.
 * @param {string} url
 * @param {RegExp} accept content-type gate; IMAGE_CT_RE for image-only surfaces
 */
export async function fetchMediaBytes(url, accept = MEDIA_CT_RE) {
    // card authors control these URLs, so every hop is guarded off the server's own network
    const resp = await guardedFetch(url, {
        signal: AbortSignal.timeout(FROM_URL_TIMEOUT_MS),
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*,video/*,audio/*,*/*' },
    });
    if (!resp.ok) throw httpError(502, `upstream ${resp.status}`);

    // a generic binary label rides through (CDNs send octet-stream, Dropbox application/binary for good pngs); any other refused type is refused on its word
    const contentType = resp.headers.get('content-type') || '';
    if (contentType && !accept.test(contentType) && !GENERIC_BINARY_RE.test(contentType)) {
        throw httpError(415, `not media: ${contentType.split(';')[0]}`);
    }

    const bytes = await readBodyCapped(resp, FROM_URL_MAX_BYTES);
    if (!bytes) throw httpError(413, 'file too large');
    if (!bytes.length) throw httpError(502, 'empty response');
    return { bytes, contentType };
}

/** The status a caught intake error should answer with, preserving the timeout wording. */
export function intakeErrorResponse(err) {
    if (err.name === 'TimeoutError') return { status: 502, error: 'download timed out' };
    return { status: err.statusCode || 502, error: err.message };
}
