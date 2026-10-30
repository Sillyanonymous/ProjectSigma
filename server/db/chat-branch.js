// A chat branched as SillyTavern branches one, each part by its own store in one transaction

import fs from 'node:fs';
import { getChatRow, listMessageRows, upsertChat, chatNameTaken, patchChatMessage, chatMetadataOf, refuseUnlessShown } from './chats-store.js';
import { listWorldsFor, replaceWorldsFor } from './world-links-store.js';
import { getBinding, putBinding } from './backgrounds-store.js';
import { copyChatAttachments, attachmentsOfMessages, setMessageAttachments } from './attachments-store.js';
import { httpError } from '../lib/http-error.js';

// a branch of a branch is named after the root chat (an older "Branch #N - " lead read too), numbered by the first free slot
const BRANCHED = /^(?:Branch #\d+ - )?(.*?)(?: - Branch #\d+)?$/s;
function branchName(db, charId, parentName) {
    const root = BRANCHED.exec(parentName)[1];
    for (let n = 1; ; n++) {
        const name = `${root} - Branch #${n}`;
        if (!chatNameTaken(db, charId, name)) return name;
    }
}

/**
 * Branch a chat at one of its messages: the transcript up to it, with the chat's settings, books, wallpaper and gallery.
 * @param {number} [opts.swipeId] the alternate the branch's last message shows; one it does not hold refuses (400)
 * @param {number} [opts.messageId] the message branched from; another at that seq now refuses (409)
 * @returns {{ id: string, name: string } | null} null when the chat or the message is not there
 */
export function branchChat(db, paths, chatId, seq, { swipeId = null, messageId = null } = {}) {
    const parent = getChatRow(db, chatId);
    if (!parent) return null;
    const rows = listMessageRows(db, chatId).filter(r => r.seq <= seq);
    if (rows.at(-1)?.seq !== seq) return null;
    refuseUnlessShown(rows.at(-1), messageId);
    const last = rows.at(-1).msg;
    // refused, never clamped as a pick clamps: a clamp would branch on another alternate than the one asked for
    if (swipeId !== null && !(Number.isInteger(swipeId) && swipeId >= 0 && Array.isArray(last.swipes) && swipeId < last.swipes.length)) {
        throw httpError(400, 'swipeId is not an alternate of that message');
    }
    // an unreadable blob starts the branch bare
    const metadata = chatMetadataOf(parent.chat_metadata);
    const written = [];
    try {
        return db.transaction(() => {
            const name = branchName(db, parent.char_id, parent.name);
            const { id } = upsertChat(db, {
                charId: parent.char_id,
                name,
                header: {
                    user_name: parent.user_name,
                    character_name: parent.character_name,
                    chat_metadata: { ...metadata, main_chat: parent.name },
                },
                messages: rows.map(r => r.msg),
                facts: { branchOf: { chatId, seq, messageId: rows.at(-1).id } },
                // the persona, the connection and the preset ride the create, so the branch is reported once
                personaId: parent.persona_id || null,
                profileId: parent.profile_id || null,
                presetId: parent.preset_id || null,
            });
            if (swipeId !== null) patchChatMessage(db, id, seq, { swipe_id: swipeId });
            const worlds = listWorldsFor(db, 'chat', chatId);
            if (worlds.length) replaceWorldsFor(db, 'chat', id, worlds);
            const wallpaper = getBinding(db, 'chat', chatId);
            if (wallpaper) {
                putBinding(db, 'chat', id, {
                    backgroundId: wallpaper.background?.id ?? null, fit: wallpaper.fit, opacity: wallpaper.opacity, blur: wallpaper.blur,
                    brightness: wallpaper.brightness, saturate: wallpaper.saturate, renderWidth: wallpaper.renderWidth,
                });
            }
            const copies = copyChatAttachments(db, paths, chatId, id, written);
            if (copies.size) {
                const shown = attachmentsOfMessages(db, rows.map(r => r.id));
                const at = db.prepare('SELECT id FROM chat_messages WHERE chat_id = ? AND seq = ?').pluck();
                for (const r of rows) {
                    const ids = (shown.get(r.id) || []).map(a => copies.get(a.id)).filter(Boolean);
                    if (ids.length) setMessageAttachments(db, id, at.get(id, r.seq), ids);
                }
            }
            return { id, name };
        })();
    } catch (e) {
        for (const file of written) { try { fs.unlinkSync(file); } catch { /* never landed */ } }
        throw e;
    }
}
