// A chat's own gallery and a studio session's pictures: one row and one uuid-named file each, under attachments/{owner id}/
import fs from 'node:fs';
import path from 'node:path';
import { emitChange } from './changes.js';
import { kindForFile, sanitizeDisplayName, mintPhysicalName, uniqueDisplayName, contentHashFor } from '../lib/stored-file.js';
import { httpError } from '../lib/http-error.js';
import { invalidateAttachmentThumbs } from '../lib/thumb-cache.js';

// an attachment belongs to exactly one owner, named by its column; the table's CHECK holds the same
const OWNER_COLUMNS = Object.freeze({ chat: 'chat_id', studio: 'studio_id' });
const OWNER_TABLES = Object.freeze({ chat: 'chats', studio: 'studio_sessions' });
// what a message may carry for the model, and what the gallery shows (audio belongs to the character's detail tab)
const MESSAGE_KINDS = new Set(['image']);
const GALLERY_KINDS = new Set(['image', 'video']);

function ownerColumn(owner) {
    const col = OWNER_COLUMNS[owner?.kind];
    if (!col || typeof owner.id !== 'string' || !owner.id) throw httpError(400, 'an attachment belongs to a chat or a studio session');
    return col;
}

export const attachmentDirFor = (root, ownerId) => path.join(root, ownerId);

function rowToItem(r) {
    const ownerId = r.chat_id ?? r.studio_id;
    return {
        id: r.id,
        chatId: r.chat_id ?? null,
        studioId: r.studio_id ?? null,
        file: r.file,
        name: r.display_name,
        kind: r.kind,
        size: r.size,
        width: r.width ?? null,
        height: r.height ?? null,
        addedAt: r.added_at,
        url: `/attachments/${ownerId}/${r.file}`,
        ...(r.uses !== undefined ? { uses: r.uses } : {}),
    };
}

/** An owner's attachments, the order they were added, each with how many messages show it. */
export function listAttachments(db, owner) {
    return db.prepare(`
        SELECT a.*, (SELECT COUNT(*) FROM message_attachments ma WHERE ma.attachment_id = a.id) AS uses
        FROM attachments a WHERE a.${ownerColumn(owner)} = ? ORDER BY a.id
    `).all(owner.id).map(rowToItem);
}

export function getAttachment(db, id) {
    const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(id));
    return row ? rowToItem(row) : null;
}

/** The owner's attachment holding these bytes, or null: a re-drop is a skip, never a second copy. */
export function findAttachmentByContent(db, owner, hash) {
    const row = db.prepare(`SELECT * FROM attachments WHERE ${ownerColumn(owner)} = ? AND content_hash = ?`).get(owner.id, hash);
    return row ? rowToItem(row) : null;
}

/**
 * Store bytes as an owner's attachment, its size read by the caller; bytes the owner holds already answer that one.
 * @returns {{ attachment: object, created: boolean }}
 */
export function addAttachment(db, paths, owner, filename, bytes, { width = null, height = null } = {}) {
    const col = ownerColumn(owner);
    const display = sanitizeDisplayName(filename);
    if (!display) throw httpError(400, 'bad filename');
    const kind = kindForFile(display);
    if (!GALLERY_KINDS.has(kind)) throw httpError(415, 'a chat\'s gallery holds pictures and video');
    const hash = contentHashFor(bytes);
    const held = findAttachmentByContent(db, owner, hash);
    if (held) return { attachment: held, created: false };
    const physical = mintPhysicalName(display);
    const dir = attachmentDirFor(paths.attachmentsRoot, owner.id);
    const dest = path.join(dir, physical);
    // written inside the try that removes it, so a write the disk refuses part way leaves nothing behind
    let out;
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(dest, bytes);
        out = db.transaction(() => {
            // the owner may have gone while the bytes were read: said by name, not as the foreign key's refusal
            if (!db.prepare(`SELECT 1 FROM ${OWNER_TABLES[owner.kind]} WHERE id = ?`).get(owner.id)) throw httpError(404, `${owner.kind === 'chat' ? 'chat' : 'studio session'} not found`);
            // an upload beside this one may have landed the same bytes meanwhile
            const raced = findAttachmentByContent(db, owner, hash);
            if (raced) return { attachment: raced, created: false };
            const taken = db.prepare(`SELECT 1 FROM attachments WHERE ${col} = ? AND display_name = ?`);
            const finalDisplay = uniqueDisplayName(display, (name) => !!taken.get(owner.id, name));
            const info = db.prepare(`
                INSERT INTO attachments (${col}, file, display_name, kind, size, width, height, content_hash, added_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(owner.id, physical, finalDisplay, kind, bytes.length, width, height, hash, Date.now());
            const id = Number(info.lastInsertRowid);
            emitChange(db, { entity: 'attachment', op: 'created', ids: [id], [owner.kind === 'chat' ? 'chatId' : 'studioId']: owner.id });
            return { attachment: getAttachment(db, id), created: true };
        })();
    } catch (e) {
        try { fs.unlinkSync(dest); } catch { /* never written, or gone already */ }
        throw e;
    }
    if (!out.created) { try { fs.unlinkSync(dest); } catch { /* gone already */ } }
    return out;
}

/** Remove an attachment: its row, every message's link to it (the foreign key), and its file once the row is gone. */
export function deleteAttachment(db, paths, id) {
    const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(id));
    if (!row) return null;
    const messages = db.transaction(() => {
        // a message is reported by its seq, its row id beside it, as every message record is
        const shown = db.prepare('SELECT m.id, m.seq FROM message_attachments ma JOIN chat_messages m ON m.id = ma.message_id WHERE ma.attachment_id = ? ORDER BY m.seq').all(row.id);
        db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
        emitChange(db, { entity: 'attachment', op: 'deleted', ids: [row.id], ...(row.chat_id ? { chatId: row.chat_id } : { studioId: row.studio_id }) });
        if (shown.length) emitChange(db, { entity: 'message', op: 'updated', chatId: row.chat_id, ids: shown.map(m => m.seq), messageIds: shown.map(m => m.id), fields: ['attachments'] });
        return shown.map(m => m.id);
    })();
    try { fs.unlinkSync(path.join(attachmentDirFor(paths.attachmentsRoot, row.chat_id ?? row.studio_id), row.file)); } catch { /* a stray file is tolerated, never a row without one */ }
    invalidateAttachmentThumbs(paths.attachmentThumbsDir, row.id);
    return { id: row.id, messages };
}

/** What owners about to go hold, read before their rows cascade away: each owner's id and its attachments' ids. */
export function attachmentsHeldBy(db, { chatIds = [], studioIds = [] }) {
    const held = [];
    const ids = (col, owner) => db.prepare(`SELECT id FROM attachments WHERE ${col} = ?`).pluck().all(owner);
    for (const id of chatIds) held.push({ ownerId: id, ids: ids('chat_id', id) });
    for (const id of studioIds) held.push({ ownerId: id, ids: ids('studio_id', id) });
    return held.filter(h => h.ids.length);
}

/** The files and thumbs of owners whose rows are gone (attachmentsHeldBy's answer). */
export function removeAttachmentFiles(paths, held) {
    for (const { ownerId, ids } of held) {
        try { fs.rmSync(attachmentDirFor(paths.attachmentsRoot, ownerId), { recursive: true, force: true }); } catch { /* stray files are tolerated, never a row without its file */ }
        for (const id of ids) invalidateAttachmentThumbs(paths.attachmentThumbsDir, id);
    }
}

/**
 * A chat's gallery copied into another (a branch), hard links where the disk allows; written collects each file for a rollback.
 * @returns {Map<number, number>} each old attachment id to its copy's
 */
export function copyChatAttachments(db, paths, fromChatId, toChatId, written) {
    const rows = db.prepare('SELECT * FROM attachments WHERE chat_id = ? ORDER BY id').all(fromChatId);
    const copies = new Map();
    if (!rows.length) return copies;
    const fromDir = attachmentDirFor(paths.attachmentsRoot, fromChatId);
    const toDir = attachmentDirFor(paths.attachmentsRoot, toChatId);
    fs.mkdirSync(toDir, { recursive: true });
    const insert = db.prepare(`
        INSERT INTO attachments (chat_id, file, display_name, kind, size, width, height, content_hash, added_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
        for (const r of rows) {
            const physical = mintPhysicalName(r.display_name);
            const dest = path.join(toDir, physical);
            // the files are never rewritten, so one inode can serve both chats; a file gone from disk is left out
            try { fs.linkSync(path.join(fromDir, r.file), dest); } catch {
                try { fs.copyFileSync(path.join(fromDir, r.file), dest); } catch (e) {
                    // a copy the disk refused part way is removed, and fails the branch rather than leaving the picture out
                    try { fs.unlinkSync(dest); } catch { /* never written */ }
                    if (e.code !== 'ENOENT') throw e;
                    continue;
                }
            }
            written.push(dest);
            copies.set(r.id, Number(insert.run(toChatId, physical, r.display_name, r.kind, r.size, r.width, r.height, r.content_hash, Date.now()).lastInsertRowid));
        }
        if (copies.size) emitChange(db, { entity: 'attachment', op: 'created', ids: [...copies.values()], chatId: toChatId });
    })();
    return copies;
}

// ---- a message's pictures: link rows, in the order the message shows them

/** A message's picture ids checked: each one this chat's and a picture, else refused by name. Answers them once each. */
export function messageAttachmentIds(db, chatId, ids) {
    if (ids == null) return [];
    if (!Array.isArray(ids) || ids.some(v => !Number.isInteger(v) || v <= 0)) throw httpError(400, 'attachments are a list of the chat\'s attachment ids');
    const unique = [...new Set(ids)];
    const rows = unique.length
        ? db.prepare('SELECT id, chat_id, kind FROM attachments WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(unique))
        : [];
    const held = new Map(rows.map(r => [r.id, r]));
    // read off each picture's own row: one another chat (or a studio session) holds is not this message's to show
    const foreign = unique.filter(v => held.get(v)?.chat_id !== chatId);
    if (foreign.length) throw httpError(400, `not this chat's attachments: ${foreign.join(', ')}`);
    const unseen = unique.filter(v => !MESSAGE_KINDS.has(held.get(v).kind));
    if (unseen.length) throw httpError(400, `a message carries pictures only: ${unseen.join(', ')}`);
    return unique;
}

/** Which pictures each message of a chat shows, by the message's place: seq to attachment ids in order (a bundle's links). */
export function chatPictureLinks(db, chatId) {
    const out = {};
    for (const r of db.prepare(`
        SELECT m.seq, ma.attachment_id AS id FROM message_attachments ma JOIN chat_messages m ON m.id = ma.message_id
        WHERE m.chat_id = ? ORDER BY m.seq, ma.pos
    `).all(chatId)) (out[r.seq] ||= []).push(r.id);
    return out;
}

/** Set a message of the chat to show these (already checked) pictures, in order, inside the write that reports the message. */
export function setMessageAttachments(db, chatId, messageId, ids) {
    if (!db.inTransaction) throw new Error('a message\'s pictures are linked inside the write that reports the message');
    db.prepare('DELETE FROM message_attachments WHERE message_id = ?').run(messageId);
    const insert = db.prepare('INSERT INTO message_attachments (message_id, attachment_id, pos) VALUES (?, ?, ?)');
    ids.forEach((id, pos) => insert.run(messageId, id, pos));
}

/** Each message's pictures, one query for the lot: message id to its items in order. */
export function attachmentsOfMessages(db, messageIds) {
    const out = new Map();
    if (!messageIds.length) return out;
    const rows = db.prepare(`
        SELECT ma.message_id AS mid, a.* FROM message_attachments ma JOIN attachments a ON a.id = ma.attachment_id
        WHERE ma.message_id IN (SELECT value FROM json_each(?)) ORDER BY ma.message_id, ma.pos
    `).all(JSON.stringify(messageIds));
    for (const r of rows) {
        if (!out.has(r.mid)) out.set(r.mid, []);
        out.get(r.mid).push(rowToItem(r));
    }
    return out;
}

