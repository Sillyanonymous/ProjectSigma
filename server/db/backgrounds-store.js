import fs from 'node:fs';
import path from 'node:path';
import { characterExists } from './characters-store.js';
import { chatExists } from './chats-store.js';
import { emitChange } from './changes.js';
import { isImageFile, sanitizeDisplayName, mintPhysicalName, uniqueDisplayName, contentHashFor, nameForBytes } from '../lib/stored-file.js';
import { httpError } from '../lib/http-error.js';

// files are <user>/backgrounds/{uuid}.ext, immutable once written; the original filename lives only in display_name

// the file rules the routes read, offered on this store's door
export { sanitizeDisplayName, contentHashFor };

export const FIT_VALUES = ['cover', 'contain', 'stretch', 'center', 'tile'];
export const RENDER_WIDTHS = [0, 768, 1280, 1920];
export const SCOPES = ['global', 'character', 'chat'];

// Ordered most specific first: the resolver walks this and the first row wins, including a
// row that says "none". Reordering this changes the feature's meaning.
const RESOLVE_ORDER = ['chat', 'character', 'global'];

function rowToItem(row) {
    if (!row) return null;
    return {
        id: row.id,
        file: row.file,
        displayName: row.display_name,
        sourceUrl: row.source_url,
        width: row.width,
        height: row.height,
        size: row.size,
        addedAt: row.added_at,
        url: `/backgrounds/${row.file}`,
        thumb: `/thumbs/background/${row.id}?s=192`,
    };
}

// ========================================
// THE LIBRARY
// ========================================

export function listBackgrounds(db) {
    const rows = db.prepare(`
        SELECT b.*, (SELECT COUNT(*) FROM background_bindings WHERE background_id = b.id) AS used_by
        FROM backgrounds b ORDER BY b.added_at DESC, b.id DESC
    `).all();
    return rows.map(r => ({ ...rowToItem(r), usedBy: r.used_by }));
}

export function getBackground(db, id) {
    return rowToItem(db.prepare('SELECT * FROM backgrounds WHERE id = ?').get(Number(id)));
}

/** Whether the thing a binding would hang off exists (the global scope always does). */
export function bindingTargetExists(db, scope, id) {
    if (scope === 'global') return true;
    if (scope === 'character') return characterExists(db, id);
    if (scope === 'chat') return chatExists(db, id);
    return false;
}

export function findByUrlHash(db, urlHash) {
    return rowToItem(db.prepare('SELECT * FROM backgrounds WHERE url_hash = ?').get(urlHash));
}

export function findByContent(db, contentHash) {
    return rowToItem(db.prepare('SELECT * FROM backgrounds WHERE content_hash = ?').get(contentHash));
}

// the wallpaper library is flat: a name is taken across all of it
function freeDisplayName(db, wanted) {
    const taken = db.prepare('SELECT 1 FROM backgrounds WHERE display_name = ?');
    return uniqueDisplayName(wanted, (name) => !!taken.get(name));
}

/**
 * Store bytes as a background row plus a uuid-named file.
 * @param {{width?: number, height?: number}} dims measured by the caller, which owns sharp
 */
export function addBackground(db, paths, filename, bytes, { sourceUrl = null, urlHash = null, width = null, height = null } = {}) {
    const given = sanitizeDisplayName(filename);
    if (!given) throw httpError(400, 'bad filename');
    // the one images-only gate, named by its bytes, so a video named .png is refused as the video it is
    const display = nameForBytes(given, bytes);
    if (!isImageFile(display)) throw httpError(415, 'backgrounds are images only');

    const finalDisplay = freeDisplayName(db, display);
    const physical = mintPhysicalName(finalDisplay);

    fs.mkdirSync(paths.backgroundsDir, { recursive: true });

    // bytes land before the row, inside the try: a refused write or a row that doesnt commit takes its file with it
    try {
        fs.writeFileSync(path.join(paths.backgroundsDir, physical), bytes);
        return db.transaction(() => {
            const info = db.prepare(`
                INSERT INTO backgrounds (file, display_name, source_url, url_hash, content_hash, width, height, size, added_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(physical, finalDisplay, sourceUrl, urlHash, contentHashFor(bytes), width, height, bytes.length, Date.now());
            emitChange(db, { entity: 'background', op: 'created', ids: [Number(info.lastInsertRowid)] });
            return getBackground(db, info.lastInsertRowid);
        })();
    } catch (e) {
        try { fs.unlinkSync(path.join(paths.backgroundsDir, physical)); } catch { /* a stray file is tolerated; the insert's error is the answer */ }
        throw e;
    }
}

export function renameBackground(db, id, name) {
    return db.transaction(() => {
        const display = sanitizeDisplayName(name);
        if (!display) throw httpError(400, 'bad name');
        const row = db.prepare('SELECT * FROM backgrounds WHERE id = ?').get(Number(id));
        if (!row) return null;
        // keep the file's real extension so a rename cant make the row lie about its bytes
        const ext = path.extname(row.file);
        const wanted = path.extname(display).toLowerCase() === ext.toLowerCase() ? display : display + ext;
        db.prepare('UPDATE backgrounds SET display_name = ? WHERE id = ?').run(freeDisplayName(db, wanted), Number(id));
        emitChange(db, { entity: 'background', op: 'updated', ids: [Number(id)] });
        return getBackground(db, id);
    })();
}

/** Bindings pointing at this background, so a delete can report what it would break. */
export function bindingsUsing(db, id) {
    return db.prepare('SELECT scope, char_id, chat_id FROM background_bindings WHERE background_id = ?')
        .all(Number(id))
        .map(r => ({ scope: r.scope, id: r.char_id || r.chat_id || null }));
}

export function deleteBackground(db, paths, id) {
    const row = db.prepare('SELECT * FROM backgrounds WHERE id = ?').get(Number(id));
    if (!row) return false;
    // the FK cascade drops its bindings, returning those scopes to inherit rather than pinning them blank
    db.transaction(() => {
        db.prepare('DELETE FROM backgrounds WHERE id = ?').run(Number(id));
        emitChange(db, { entity: 'background', op: 'deleted', ids: [Number(id)] });
    })();
    // the file goes once the row is gone for good
    try { fs.unlinkSync(path.join(paths.backgroundsDir, row.file)); } catch { /* a stray file is tolerated, never a row without one */ }
    return true;
}

// ========================================
// BINDINGS
// ========================================

function bindingRow(db, scope, id) {
    if (scope === 'global') return db.prepare("SELECT * FROM background_bindings WHERE scope = 'global'").get();
    if (scope === 'character') return db.prepare('SELECT * FROM background_bindings WHERE char_id = ?').get(id);
    if (scope === 'chat') return db.prepare('SELECT * FROM background_bindings WHERE chat_id = ?').get(id);
    return undefined;
}

/** A binding as the wire sees it; a null background is "explicitly none", never the same as no row. */
function bindingToWire(db, row) {
    if (!row) return null;
    return {
        scope: row.scope,
        id: row.char_id || row.chat_id || null,
        background: row.background_id ? getBackground(db, row.background_id) : null,
        fit: row.fit,
        opacity: row.opacity,
        blur: row.blur,
        brightness: row.brightness,
        saturate: row.saturate,
        renderWidth: row.render_width,
        updatedAt: row.updated_at,
    };
}

export function getBinding(db, scope, id) {
    return bindingToWire(db, bindingRow(db, scope, id));
}

export function putBinding(db, scope, id, patch) {
    return db.transaction(() => {
        const now = Date.now();
        const existing = bindingRow(db, scope, id);
        const base = existing
            || { background_id: null, fit: 'cover', opacity: 1, blur: 0, brightness: 1, saturate: 1, render_width: null };

        // omitted keeps, explicit null clears: a slider nudge must never drop the picture
        const keep = (v, stored) => (v === undefined ? stored : v);
        const next = {
            background_id: keep(patch.backgroundId, base.background_id),
            fit: keep(patch.fit, base.fit),
            opacity: keep(patch.opacity, base.opacity),
            blur: keep(patch.blur, base.blur),
            brightness: keep(patch.brightness, base.brightness),
            saturate: keep(patch.saturate, base.saturate),
            render_width: keep(patch.renderWidth, base.render_width),
        };

        if (existing) {
            db.prepare(`
                UPDATE background_bindings
                SET background_id = ?, fit = ?, opacity = ?, blur = ?, brightness = ?, saturate = ?, render_width = ?, updated_at = ?
                WHERE id = ?
            `).run(next.background_id, next.fit, next.opacity, next.blur, next.brightness, next.saturate, next.render_width, now, existing.id);
        } else {
            db.prepare(`
                INSERT INTO background_bindings (scope, char_id, chat_id, background_id, fit, opacity, blur, brightness, saturate, render_width, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                scope,
                scope === 'character' ? id : null,
                scope === 'chat' ? id : null,
                next.background_id, next.fit, next.opacity, next.blur, next.brightness, next.saturate, next.render_width, now,
            );
        }
        emitChange(db, { entity: 'backgroundBinding', op: 'updated', scope, ids: scope === 'global' ? [] : [id] });
        return getBinding(db, scope, id);
    })();
}

export function deleteBinding(db, scope, id) {
    return db.transaction(() => {
        const row = bindingRow(db, scope, id);
        if (!row) return false;
        db.prepare('DELETE FROM background_bindings WHERE id = ?').run(row.id);
        emitChange(db, { entity: 'backgroundBinding', op: 'deleted', scope, ids: scope === 'global' ? [] : [id] });
        return true;
    })();
}

/** The one resolver: chat -> character -> global, stopping at the first row even when its background is null. */
export function resolveBackground(db, chatId) {
    const chat = chatId ? db.prepare('SELECT id, char_id FROM chats WHERE id = ?').get(chatId) : null;
    if (!chat) return { source: 'none', binding: null };

    for (const scope of RESOLVE_ORDER) {
        const key = scope === 'chat' ? chat.id : scope === 'character' ? chat.char_id : null;
        if (scope === 'character' && !key) continue;
        const row = bindingRow(db, scope, key);
        if (!row) continue;
        return { source: scope, binding: bindingToWire(db, row) };
    }
    return { source: 'none', binding: null };
}
