import fs from 'node:fs';
import path from 'node:path';

// The one thumbnail contract (widths and names) for serving, warming and dropping. a request snaps to the nearest width
export const THUMB_SIZES = [96, 192, 384, 512, 768, 1280, 1920];

/** Where a key's thumb of one width is cached. */
export function thumbPath(dir, key, size) {
    return path.join(dir, `${key}-${size}.webp`);
}

// the disk cache never expires, so a rewritten source drops every width by name (no dir listing)
function invalidateThumbs(dir, key) {
    for (const size of THUMB_SIZES) {
        try { fs.unlinkSync(thumbPath(dir, key, size)); } catch { /* that width was never cached */ }
    }
}

export function invalidateMediaThumbs(mediaThumbsDir, mediaId) {
    invalidateThumbs(mediaThumbsDir, mediaId);
}

export function invalidateAvatarThumbs(avatarThumbsDir, id) {
    invalidateThumbs(avatarThumbsDir, id);
}

export function invalidateBackgroundThumbs(backgroundThumbsDir, id) {
    invalidateThumbs(backgroundThumbsDir, id);
}

export function invalidateAttachmentThumbs(attachmentThumbsDir, id) {
    invalidateThumbs(attachmentThumbsDir, id);
}

// persona avatars are rewritten in place, so their thumbs go stale on every write
export function invalidatePersonaThumbs(personaThumbsDir, id) {
    invalidateThumbs(personaThumbsDir, id);
}
