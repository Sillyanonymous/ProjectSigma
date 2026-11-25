import fs from 'node:fs';
import path from 'node:path';
import { emitChange } from './changes.js';
import { encodeCursor, decodeCursor } from './cursor.js';
import { kindForFile, sanitizeDisplayName, mintPhysicalName, uniqueDisplayName, contentHashFor, nameForBytes } from '../lib/stored-file.js';
import { httpError } from '../lib/http-error.js';

// files are <user>/gallery/{char-uuid}/{media-uuid}.ext; callers pass req.paths so no write lands in another users home

// the file rules, kept on this store's door under the names it has always offered
export { kindForFile, sanitizeDisplayName, contentHashFor };

export function galleryDirFor(galleryRoot, charId) {
    return path.join(galleryRoot, charId);
}

function rowToItem(row) {
    return {
        id: row.id,
        charId: row.char_id,
        file: row.file,
        displayName: row.display_name,
        kind: row.kind,
        sourceUrl: row.source_url,
        size: row.size,
        addedAt: row.added_at,
        url: `/gallery/${row.char_id}/${row.file}`,
    };
}

export function listMedia(db, charId) {
    return db.prepare('SELECT * FROM media WHERE char_id = ? ORDER BY added_at, id').all(charId).map(rowToItem);
}

// listMediaPage's statement, exported so its plan can be read: the character's rows walked on
// idx_media_char, which carries the rowid the id is
export const MEDIA_PAGE_SQL = {
    first: 'SELECT * FROM media WHERE char_id = ? ORDER BY id LIMIT ?',
    after: 'SELECT * FROM media WHERE char_id = ? AND id > ? ORDER BY id LIMIT ?',
};

/**
 * A page of a character's gallery in id order (the order added) past a cursor; count: false skips the total.
 * @returns {{ items: object[], total: number|null, limit: number, nextCursor: string|null }}
 */
export function listMediaPage(db, charId, { limit, after, count = true }) {
    let rows;
    if (after === undefined) rows = db.prepare(MEDIA_PAGE_SQL.first).all(charId, limit);
    else {
        const cur = decodeCursor(after, 1, { intLast: true });
        if (!cur) throw httpError(400, 'invalid after cursor');
        rows = db.prepare(MEDIA_PAGE_SQL.after).all(charId, cur[0], limit);
    }
    const total = count === false ? null : db.prepare('SELECT COUNT(*) n FROM media WHERE char_id = ?').get(charId).n;
    return { items: rows.map(rowToItem), total, limit, nextCursor: rows.length === limit ? encodeCursor([rows[rows.length - 1].id]) : null };
}

export function getMedia(db, id) {
    const row = db.prepare('SELECT * FROM media WHERE id = ?').get(Number(id));
    return row ? rowToItem(row) : null;
}

/** The media row a character already holds for a source url, or null. */
export function findMediaByUrlHash(db, charId, urlHash) {
    const row = db.prepare('SELECT * FROM media WHERE char_id = ? AND url_hash = ?').get(charId, urlHash);
    return row ? rowToItem(row) : null;
}

/** Whether the character holds a row under this name, sanitized; a caller holding the bytes asks by `nameForBytes` first, as addMediaFile names. */
export function mediaExistsByName(db, charId, displayName) {
    const display = sanitizeDisplayName(displayName);
    if (!display) return false;
    return !!db.prepare('SELECT 1 FROM media WHERE char_id = ? AND display_name = ?').get(charId, display);
}

/** A page of image rows past an id, in id order: what the thumbnail warm-up walks. */
export function listImageMediaPage(db, afterId, limit) {
    return db.prepare("SELECT id, char_id, file FROM media WHERE kind = 'image' AND id > ? ORDER BY id LIMIT ?").all(afterId, limit)
        .map(r => ({ id: r.id, charId: r.char_id, file: r.file }));
}

/** How many image rows that walk pages through, counted before it starts. */
export function countImageMedia(db) {
    return db.prepare("SELECT COUNT(*) FROM media WHERE kind = 'image'").pluck().get();
}

/** Existing row with the same bytes for this character, or null. */
export function findMediaByContent(db, charId, contentHash) {
    const row = db.prepare('SELECT * FROM media WHERE char_id = ? AND content_hash = ?').get(charId, contentHash);
    return row ? rowToItem(row) : null;
}

// a content dupe adopts the url only onto a row with none (migrated rows); a row naming another url keeps it
export function adoptMediaSource(db, mediaId, sourceUrl, urlHash) {
    return db.transaction(() => {
        const r = db.prepare('UPDATE media SET source_url = ?, url_hash = ? WHERE id = ? AND source_url IS NULL')
            .run(sourceUrl, urlHash, mediaId);
        if (r.changes) {
            const charId = db.prepare('SELECT char_id FROM media WHERE id = ?').get(mediaId)?.char_id ?? null;
            emitChange(db, { entity: 'media', op: 'updated', ids: [Number(mediaId)], fields: ['source'], charId });
        }
        return r.changes > 0;
    })();
}

/** Store uploaded bytes as a media row + uid-named file. */
export function addMediaFile(db, paths, charId, filename, bytes, { sourceUrl = null, urlHash = null } = {}) {
    const given = sanitizeDisplayName(filename);
    if (!given) throw httpError(400, 'bad filename');
    // the bytes decide the kind: an mp4 named .png lands as .mp4 and shows as video
    const display = nameForBytes(given, bytes);
    const taken = db.prepare('SELECT 1 FROM media WHERE char_id = ? AND display_name = ?');
    const finalDisplay = uniqueDisplayName(display, (name) => !!taken.get(charId, name));
    const physical = mintPhysicalName(finalDisplay);

    const dir = galleryDirFor(paths.galleryRoot, charId);
    fs.mkdirSync(dir, { recursive: true });

    // bytes land before the row, inside the try that removes them: a refused write or a failed INSERT strands no file
    try {
        fs.writeFileSync(path.join(dir, physical), bytes);
        return db.transaction(() => {
            // the character may have left while the bytes were fetched: a missing row is said by
            // name, not as the foreign key's refusal
            if (!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(charId)) throw httpError(404, 'character not found');
            const info = db.prepare(`
                INSERT INTO media (char_id, file, display_name, kind, source_url, url_hash, size, content_hash, added_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(charId, physical, finalDisplay, kindForFile(finalDisplay), sourceUrl, urlHash, bytes.length, contentHashFor(bytes), Date.now());
            emitChange(db, { entity: 'media', op: 'created', ids: [Number(info.lastInsertRowid)], charId });
            return rowToItem(db.prepare('SELECT * FROM media WHERE id = ?').get(info.lastInsertRowid));
        })();
    } catch (e) {
        try { fs.unlinkSync(path.join(dir, physical)); } catch { /* a stray file is tolerated; the insert's error is the answer */ }
        throw e;
    }
}

/**
 * Import-time registration of an existing source file (copies it in).
 * Idempotent by (char, display_name): a re-run skips instead of duplicating.
 */
export function importMediaFile(db, paths, charId, sourcePath) {
    const given = sanitizeDisplayName(path.basename(sourcePath));
    if (!given) return null;
    // the name the first bytes earn, read before the re-run check so a skip still reads no more than them
    const head = Buffer.alloc(16);
    const fd = fs.openSync(sourcePath, 'r');
    let headLen;
    try { headLen = fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
    let display = nameForBytes(given, head.subarray(0, headLen));
    const taken = db.prepare('SELECT size FROM media WHERE char_id = ? AND display_name = ?');
    const named = taken.get(charId, display);
    // the row under that name is this file when the sizes agree; another file the bytes renamed onto it lands beside it
    if (named && named.size === fs.statSync(sourcePath).size) return { skipped: true };

    // read, not copied: the bytes are needed for the content hash, which keeps the row inside dedup
    const bytes = fs.readFileSync(sourcePath);
    // identical bytes under a different name (the shared-vs-unique legacy folder
    // overlap) skip like the download ladder would
    if (findMediaByContent(db, charId, contentHashFor(bytes))) return { skipped: true, reason: 'content' };
    if (named) display = uniqueDisplayName(display, (name) => !!taken.get(charId, name));
    const physical = mintPhysicalName(display);
    const dir = galleryDirFor(paths.galleryRoot, charId);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, physical);
    try {
        fs.writeFileSync(dest, bytes);
        db.transaction(() => {
            const info = db.prepare(`
                INSERT INTO media (char_id, file, display_name, kind, source_url, url_hash, size, content_hash, added_at)
                VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)
            `).run(charId, physical, display, kindForFile(display), bytes.length, contentHashFor(bytes), Date.now());
            emitChange(db, { entity: 'media', op: 'created', ids: [Number(info.lastInsertRowid)], charId });
        })();
    } catch (e) {
        try { fs.unlinkSync(dest); } catch { /* a stray file is tolerated; the insert's error is the answer */ }
        throw e;
    }
    return { skipped: false };
}

/**
 * Copy one character's gallery into another's on disk; a file the target already holds is skipped, one gone from disk counted missing.
 * @returns {Promise<{ copied: number, skipped: number, missing: number }>}
 */
export async function copyMediaFrom(db, paths, toCharId, fromCharId) {
    const rows = db.prepare('SELECT * FROM media WHERE char_id = ? ORDER BY id').all(fromCharId);
    const fromDir = galleryDirFor(paths.galleryRoot, fromCharId);
    const toDir = galleryDirFor(paths.galleryRoot, toCharId);
    const taken = db.prepare('SELECT 1 FROM media WHERE char_id = ? AND display_name = ?');
    const held = (row) => (row.content_hash && findMediaByContent(db, toCharId, row.content_hash)) || (row.url_hash && findMediaByUrlHash(db, toCharId, row.url_hash));
    const out = { copied: 0, skipped: 0, missing: 0 };
    for (const row of rows) {
        if (held(row)) { out.skipped++; continue; }
        const physical = mintPhysicalName(row.display_name);
        const dest = path.join(toDir, physical);
        fs.mkdirSync(toDir, { recursive: true });
        // async so a large gallery never holds the server's other requests
        try { await fs.promises.copyFile(path.join(fromDir, row.file), dest); } catch (e) {
            // a copy the disk refused part way is removed and said; only a source gone from disk counts missing
            try { fs.unlinkSync(dest); } catch { /* never written */ }
            if (e.code !== 'ENOENT') throw e;
            out.missing++;
            continue;
        }
        let landed;
        try {
            // decided again at the insert: a copy running beside this one may have landed the same file meanwhile
            landed = db.transaction(() => {
                if (!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(toCharId)) throw httpError(404, 'character not found');
                if (held(row)) return false;
                const display = uniqueDisplayName(row.display_name, (name) => !!taken.get(toCharId, name));
                const info = db.prepare(`
                    INSERT INTO media (char_id, file, display_name, kind, source_url, url_hash, size, content_hash, added_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(toCharId, physical, display, row.kind, row.source_url, row.url_hash, row.size, row.content_hash, Date.now());
                emitChange(db, { entity: 'media', op: 'created', ids: [Number(info.lastInsertRowid)], charId: toCharId });
                return true;
            })();
        } catch (e) {
            try { fs.unlinkSync(dest); } catch { /* a stray file is tolerated; the insert's error is the answer */ }
            throw e;
        }
        if (landed) out.copied++;
        else {
            try { fs.unlinkSync(dest); } catch { /* a stray file is tolerated, never a row without its file */ }
            out.skipped++;
        }
    }
    return out;
}

export function deleteMedia(db, paths, mediaId) {
    const row = db.prepare('SELECT * FROM media WHERE id = ?').get(mediaId);
    if (!row) return false;
    db.transaction(() => {
        db.prepare('DELETE FROM media WHERE id = ?').run(mediaId);
        emitChange(db, { entity: 'media', op: 'deleted', ids: [Number(mediaId)], charId: row.char_id });
    })();
    // the file goes once the row is gone for good
    try { fs.unlinkSync(path.join(galleryDirFor(paths.galleryRoot, row.char_id), row.file)); } catch { /* a stray file is tolerated, never a row without one */ }
    return true;
}

export function deleteAllMediaFiles(paths, charId) {
    try { fs.rmSync(galleryDirFor(paths.galleryRoot, charId), { recursive: true, force: true }); } catch { /* stray files are tolerated, never a row without its file */ }
}
