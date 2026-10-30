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
