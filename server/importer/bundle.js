// a bundle pack in, its characters out: the manifest refused whole before anything lands, then the books, then each entry
import fs from 'node:fs';
import path from 'node:path';
import { parseStDate, chatNameTaken, parseStChatJsonl } from '../db/chats-store.js';
import { addMediaFile, mediaExistsByName, galleryDirFor } from '../db/media-store.js';
import { importWorld } from '../db/worlds-store.js';
import { headWorldFor, replaceWorldsFor } from '../db/world-links-store.js';
import { storeSuppliedChat } from '../llm/prompt.js';
import { readZipIndex, readZipEntryAsync, checkArchive } from '../lib/zip.js';
import { importCharacterBuffer } from './card-import.js';
import { addAttachment, attachmentDirFor, setMessageAttachments } from '../db/attachments-store.js';
import { imageSizeOf } from '../lib/image-size.js';
import { nameForBytes } from '../lib/stored-file.js';
import { httpError } from '../lib/http-error.js';
import { nextTurn } from '../lib/steps.js';

// an entry as the export writes it: the books it names, and each chat file's own name
const currentEntry = (c) => Array.isArray(c.worlds) && Array.isArray(c.chatFiles) && !!c.chatNames && typeof c.chatNames === 'object'
    && c.chatFiles.every(f => Object.hasOwn(c.chatNames, f) && typeof c.chatNames[f] === 'string' && c.chatNames[f].trim() !== '');

export async function importBundle(zipPath, { worlds = true, only = null, copyUids = null, db, paths, signal = null } = {}) {
    let entries;
    try { entries = readZipIndex(zipPath); }
    catch (e) { throw httpError(400, `not a readable zip: ${e.message}`); }
    // every member bounded by the archive's budget alone: the export writes its manifest, chats and books unbounded
    const budget = checkArchive(zipPath, entries);
    const read = (entry) => readZipEntryAsync(zipPath, entry, { max: budget });
    const byName = new Map(entries.map(e => [e.name, e]));
    const manifestEntry = byName.get('manifest.json');
    if (!manifestEntry) throw httpError(400, 'no manifest.json in the archive');
    const manifestText = (await read(manifestEntry)).toString('utf8');
    let manifest = null;
    try { manifest = JSON.parse(manifestText); } catch { /* answered below, with the other manifest refusals */ }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw httpError(400, 'manifest.json is not a JSON object');
    if (!Array.isArray(manifest.characters)) throw httpError(400, 'manifest has no characters');
    // v1 packs keyed characters by card filename, an identity two entries can share; the migration tool serves that era
    if (manifest.version !== 2 || manifest.characters.some(c => !c?.uid || !c?.file || !currentEntry(c))) {
        throw httpError(400, 'this bundle was exported by an older Project Σ or the SillyTavern extension; '
            + 're-export it from a current install, or use the SillyTavern migration tool (npm run migrate) for extension-era data');
    }

    // imports never overwrite: an entry lands new, attaches additively to an identical twin, or is reported diverged
    const summary = { imported: 0, identical: 0, diverged: [], chats: 0, chatLinesDropped: 0, media: 0, worlds: 0, worldsRenamed: [], errors: [] };
    if (signal?.aborted) return summary;

    if (worlds) {
        // a partial restore brings the books its entries name
        const wanted = only ? new Set(manifest.characters.filter(c => only.has(String(c.uid))).flatMap(c => c.worlds)) : null;
        for (const w of manifest.worlds || []) {
            if (wanted && !wanted.has(w.name)) continue;
            try {
                const entry = byName.get(w.file);
                if (!entry) continue;
                const finalName = importWorld(db, w.name, JSON.parse((await read(entry)).toString('utf8')));
                summary.worlds++;
                if (finalName !== w.name) summary.worldsRenamed.push({ from: w.name, to: finalName });
            } catch (err) { summary.errors.push({ world: w.name, error: err.message }); }
        }
    }

    for (const c of manifest.characters) {
        // Selection rides the manifest's uid (the exporting library's char id), not the
        // card filename: two entries can share a filename, and a uuid cannot collide.
        if (only && !only.has(String(c.uid))) continue;
        // one yield per character, as the export takes them, or a whole restore holds every account's requests
        await nextTurn();
        // the client hung up (the import's Cancel): the entries already restored stay, whole
        if (signal?.aborted) break;
        // an entry lands whole or not at all: a refusal anywhere rolls back its rows, and its files go with them
        const written = { files: [], dirs: [] };
        try {
            const member = await readMembers(c, byName, read);
            if (signal?.aborted) break;
            const t = db.transaction(() => restoreEntry(db, c, { member, worlds, copyUids, paths, written }))();
            if (t.error) summary.errors.push({ character: c.name || c.uid, error: t.error });
            if (t.diverged) summary.diverged.push(t.diverged);
            summary.imported += t.imported;
            summary.identical += t.identical;
            summary.chats += t.chats;
            summary.chatLinesDropped += t.chatLinesDropped;
            summary.media += t.media;
        } catch (err) {
            for (const f of written.files) { try { fs.unlinkSync(f); } catch { /* never landed */ } }
            for (const d of written.dirs) { try { fs.rmdirSync(d); } catch { /* holds files it had before */ } }
            summary.errors.push({ character: c.name || c.uid, error: err.message });
        }
    }
    return summary;
}

// read before the entry's transaction, which can hold no await; a member's refusal throws only where the restore takes it
async function readMembers(c, byName, read) {
    const names = [`cards/${c.file}`, ...c.chatFiles.map(f => `chats/${c.uid}/${f}`), ...[...(c.galleryFiles || [])].map(f => `gallery/${c.uid}/${f}`)];
    const pictures = new Set(Object.values(c.chatPictures && typeof c.chatPictures === 'object' ? c.chatPictures : {})
        .flatMap(p => (Array.isArray(p?.files) ? p.files : []).filter(x => typeof x?.file === 'string').map(x => `chat-pictures/${c.uid}/${x.file}`)));
    names.push(...pictures);
    const got = new Map();
    for (const name of names) {
        const entry = byName.get(name);
        if (!entry || got.has(name)) continue;
        try {
            const bytes = await read(entry);
            got.set(name, { bytes, ...(pictures.has(name) ? { size: await imageSizeOf(bytes) } : {}) });
        } catch (error) { got.set(name, { error }); }
    }
    const member = (name) => {
        const m = got.get(name);
        if (!m) return null;
        if (m.error) throw m.error;
        return m.bytes;
    };
    member.sizeOf = (name) => got.get(name)?.size ?? { width: null, height: null };
    return member;
}

// a chat's pictures land in its new gallery and its messages show them again by place; a member the pack lacks is left out
function restoreChatPictures(db, paths, chatId, uid, { files, links }, member, written) {
    const ids = new Map();
    for (const f of files) {
        if (typeof f?.file !== 'string' || !Number.isInteger(f.id)) continue;
        const name = `chat-pictures/${uid}/${f.file}`;
        const bytes = member(name);
        if (bytes === null) continue;
        const { attachment, created } = addAttachment(db, paths, { kind: 'chat', id: chatId }, typeof f.name === 'string' && f.name ? f.name : f.file, bytes, member.sizeOf(name));
        if (created) written.files.push(path.join(attachmentDirFor(paths.attachmentsRoot, chatId), attachment.file));
        ids.set(f.id, attachment.id);
    }
    if (!ids.size) return;
    written.dirs.push(attachmentDirFor(paths.attachmentsRoot, chatId));
    const at = db.prepare('SELECT id FROM chat_messages WHERE chat_id = ? AND seq = ?').pluck();
    for (const [seq, list] of Object.entries(links && typeof links === 'object' ? links : {})) {
        const shown = (Array.isArray(list) ? list : []).map(v => ids.get(v)).filter(Boolean);
        const messageId = at.get(chatId, Number(seq));
        if (shown.length && messageId) setMessageAttachments(db, chatId, messageId, [...new Set(shown)]);
    }
}

/** One manifest entry in the caller's transaction (card, chats, gallery); every file written is pushed to written for a rollback's cleanup. */
function restoreEntry(db, c, { member, worlds, copyUids, paths, written }) {
    const tally = { imported: 0, identical: 0, chats: 0, chatLinesDropped: 0, media: 0, diverged: null, error: null };
    const cardBytes = member(`cards/${c.file}`);
    if (cardBytes === null) return { ...tally, error: 'card missing from archive' };
    // identity is the embedded cl.uid (uuids travel); create_date and the op-state land in the insert, so a restore is one created record
    const result = importCharacterBuffer(db, cardBytes, {
        force: copyUids?.has(String(c.uid)) ? 'copy' : null, paths, createdAtFallback: parseStDate(c.create_date),
        opState: { fav: c.fav, updateLocked: c.updateLocked, loreDismissed: c.loreDismissed, mediaLocalized: c.mediaLocalized },
    });
    if (!result) return { ...tally, error: 'no embedded card in PNG' };

    let charId;
    let attachOnly = false;
    if (result.skipped) {
        if (result.reason !== 'identical') return { ...tally, diverged: { uid: c.uid, name: c.name, matchId: result.id, reason: result.reason } };
        // an identical twin exists: nothing to import for the card itself, but the
        // entry's NEW chats and media still attach additively to the twin
        tally.identical = 1;
        charId = result.id;
        attachOnly = true;
    } else {
        charId = result.id;
        tally.imported = 1;
        if (result.created) {
            written.files.push(path.join(paths.avatarsDir, `${charId}.png`));
            written.dirs.push(galleryDirFor(paths.galleryRoot, charId));
        }

        // aux lorebooks: ABSENT never touches state; explicit [] clears everything
        // after the head (the head arrived inside the card as extensions.world)
        if (worlds && Array.isArray(c.auxWorlds)) {
            const head = headWorldFor(db, 'char', charId);
            replaceWorldsFor(db, 'char', charId, [...(head ? [head] : []), ...c.auxWorlds.filter(w => typeof w === 'string' && w)], { ensure: true });
        }
    }

    for (const file of c.chatFiles) {
        const name = `chats/${c.uid}/${file}`;
        if (member(name) === null) continue;
        const chatName = c.chatNames[file];
        // attach mode never replaces: a same-named chat on the twin keeps ITS
        // messages (a store would rewrite them wholesale)
        if (attachOnly && chatNameTaken(db, charId, chatName)) continue;
        const parsed = parseStChatJsonl(member(name).toString('utf8'));
        if (!parsed) continue;
        tally.chatLinesDropped += parsed.dropped;
        // a greeting stored with its macros is expanded in the write that stores it, as the ST import and the create route do
        const { id: chatRowId } = storeSuppliedChat(db, {
            charId,
            name: chatName,
            header: parsed.header,
            messages: parsed.messages,
            imported: true,
        });
        // the header lifted the head; the rest rides the manifest under auxWorlds' rule (absent never touches, [] clears after the head)
        const pictures = c.chatPictures?.[file];
        if (pictures && Array.isArray(pictures.files)) restoreChatPictures(db, paths, chatRowId, c.uid, pictures, member, written);
        const aux = c.chatAuxWorlds?.[file];
        if (worlds && Array.isArray(aux)) {
            const head = headWorldFor(db, 'chat', chatRowId);
            replaceWorldsFor(db, 'chat', chatRowId, [...(head ? [head] : []), ...aux.filter(w => typeof w === 'string' && w)], { ensure: true });
        }
        tally.chats++;
    }

    for (const file of c.galleryFiles || []) {
        const name = `gallery/${c.uid}/${file}`;
        const bytes = member(name);
        if (bytes === null) continue;
        // asked under the name the bytes earn, the one addMediaFile stores, so a second restore finds it
        if (mediaExistsByName(db, charId, nameForBytes(file, bytes))) continue;
        const item = addMediaFile(db, paths, charId, file, bytes);
        written.files.push(path.join(galleryDirFor(paths.galleryRoot, charId), item.file));
        tally.media++;
    }
    return tally;
}
