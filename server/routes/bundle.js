import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { queryCharacters, getCharacter, buildExportCard } from '../db/characters-store.js';
import { listChatsForChar, composeChatJsonl } from '../db/chats-store.js';
import { listAttachments, attachmentDirFor, chatPictureLinks } from '../db/attachments-store.js';
import { listMedia, galleryDirFor } from '../db/media-store.js';
import { listWorlds, getWorld } from '../db/worlds-store.js';
import { listWorldsFor } from '../db/world-links-store.js';
import { writeCardChunks } from '../lib/png-card.js';
import { importBundle } from '../importer/bundle.js';
import { ZipFileWriter, packPath, dropPack, sendPack } from '../lib/zip.js';
import { boolOf, listOf } from '../lib/query-params.js';
import { characterFilterOpts } from '../lib/character-query.js';
import { requireArchiveType } from '../lib/request-guard.js';
import { safeFileName } from '../lib/stored-file.js';

export const bundleRouter = Router();

const safeName = s => safeFileName(s, 'character');

// Manifest v2: the character uuid is the only identity
// how many skipped ids the answer names (a header, so bounded); the count stays exact
const SKIPPED_NAMED = 1000;

bundleRouter.post('/export', async (req, res) => {
    const db = req.db;
    const { ids, filter, include = {} } = req.body || {};
    const withChats = include.chats !== false;
    const withMedia = include.media !== false;
    const withWorlds = include.worlds !== false;
    if (ids !== undefined && filter !== undefined) return res.status(400).json({ error: 'ids or filter, not both' });

    // by id, each composed on its turn, keyset pages by creation so a rename mid-export moves no one
    const posted = Array.isArray(ids) && ids.length ? [...new Set(ids.map(String))] : null;
    const filterOpts = filter !== undefined ? characterFilterOpts(db, filter) : {};
    if (posted) {
        if (queryCharacters(db, { ids: posted, idsOnly: true, limit: 1 }).total !== posted.length) return res.status(404).json({ error: 'one or more character ids not found' });
    } else if (!queryCharacters(db, { ...filterOpts, idsOnly: true, limit: 1, count: false }).items.length) {
        return res.status(400).json({ error: 'nothing to export' });
    }
    function* exportIds() {
        if (posted) { yield* posted; return; }
        let after;
        do {
            const page = queryCharacters(db, { ...filterOpts, idsOnly: true, sort: 'created', order: 'asc', fields: [], limit: 500, after, count: false });
            for (const item of page.items) yield item.id;
            after = page.nextCursor;
        } while (after);
    }

    const zipPath = packPath();
    const writer = new ZipFileWriter(zipPath);
    const manifest = { version: 2, generator: 'project-sigma', exportedAt: Date.now(), characters: [], worlds: [] };
    const worldNames = new Set();
    // a character the archive cant carry is named, never dropped in silence
    const skipped = [];

    try {
        for (const id of exportIds()) {
            const avatarFile = path.join(req.paths.avatarsDir, `${id}.png`);
            const baseImage = fs.existsSync(avatarFile) ? fs.readFileSync(avatarFile) : null;
            if (!baseImage) { skipped.push(id); continue; }
            const detail = getCharacter(db, id);
            if (!detail) { skipped.push(id); continue; }
            const name = detail.card.data.name;
            const primaryWorld = detail.card.data.extensions?.world || null;
            const file = `${safeName(name)}_${id.slice(0, 8)}.png`;
            const exportCard = buildExportCard(db, id, detail);
            writer.add(`cards/${file}`, writeCardChunks(baseImage, exportCard.card));

            const entry = {
                uid: id,
                file,
                name,
                create_date: detail.createdAt || null,
                fav: !!detail.fav,
                updateLocked: !!detail.updateLocked,
                loreDismissed: !!detail.loreDismissed,
                mediaLocalized: !!detail.mediaLocalized,
                chatFiles: [],
                // per chat file, the chat's own name: two names can sanitize to one file name
                chatNames: {},
                galleryFiles: [],
                // whole link list minus the head (which travels as extensions.world in the card)
                auxWorlds: listWorldsFor(db, 'char', id).slice(1),
                // per chat file, that chat's list minus its head (which travels as world_info in
                // the JSONL header); same absent-vs-[] contract as auxWorlds
                chatAuxWorlds: {},
                // per chat file with pictures, the chat's gallery and which messages show what (by seq); with media only
                chatPictures: {},
                // every book this entry names (its head, its list, each chat's list): what a
                // restore of this entry alone brings onto the shelf
                worlds: [],
            };
            const entryWorlds = new Set();

            if (withChats) {
                // a taken chat name takes a number, compared without case for case-blind disks
                const taken = new Set();
                for (const chat of listChatsForChar(db, id)) {
                    const jsonl = composeChatJsonl(db, chat.id);
                    if (!jsonl) continue;
                    const stem = safeName(chat.name);
                    let chatFile = `${stem}.jsonl`;
                    for (let n = 2; taken.has(chatFile.toLowerCase()); n++) chatFile = `${stem} (${n}).jsonl`;
                    taken.add(chatFile.toLowerCase());
                    entry.chatNames[chatFile] = chat.name;
                    writer.add(`chats/${id}/${chatFile}`, Buffer.from(jsonl, 'utf8'));
                    entry.chatFiles.push(chatFile);
                    if (withMedia) {
                        const files = [];
                        for (const a of listAttachments(db, { kind: 'chat', id: chat.id })) {
                            const physical = path.join(attachmentDirFor(req.paths.attachmentsRoot, chat.id), a.file);
                            if (!fs.existsSync(physical)) continue;
                            writer.add(`chat-pictures/${id}/${a.file}`, physical);
                            files.push({ id: a.id, file: a.file, name: a.name });
                        }
                        if (files.length) entry.chatPictures[chatFile] = { files, links: chatPictureLinks(db, chat.id) };
                    }
                    const chatWorlds = listWorldsFor(db, 'chat', chat.id);
                    entry.chatAuxWorlds[chatFile] = chatWorlds.slice(1);
                    for (const w of chatWorlds) entryWorlds.add(w);
                }
            }
            if (withMedia) {
                for (const m of listMedia(db, id)) {
                    const physical = path.join(galleryDirFor(req.paths.galleryRoot, id), m.file);
                    if (!fs.existsSync(physical)) continue;
                    writer.add(`gallery/${id}/${m.displayName}`, physical);
                    entry.galleryFiles.push(m.displayName);
                }
            }
            if (primaryWorld) entryWorlds.add(primaryWorld);
            for (const w of entry.auxWorlds) entryWorlds.add(w);
            entry.worlds = [...entryWorlds];
            if (withWorlds) for (const w of entryWorlds) worldNames.add(w);
            manifest.characters.push(entry);
            // one yield per character, or the sync file work holds the event loop for the whole export
            await new Promise(r => setImmediate(r));
        }

        if (withWorlds) {
            const present = new Set(listWorlds(db).map(w => w.name));
            let n = 0;
            for (const name of worldNames) {
                if (!present.has(name)) continue; // dangling ref: ships as name-only, documented tolerance
                const file = `worlds/${n++}.json`;
                writer.add(file, Buffer.from(JSON.stringify(getWorld(db, name).data), 'utf8'));
                manifest.worlds.push({ name, file });
            }
        }

        writer.add('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
        writer.finalize();
    } catch (err) {
        dropPack(zipPath);
        throw err;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="cl-transfer-${stamp}.zip"`);
    // the archive is whole before the headers go: the counts are exact, the skipped ids up to SKIPPED_NAMED
    res.setHeader('X-Bundle-Count', String(manifest.characters.length));
    res.setHeader('X-Bundle-Skipped-Count', String(skipped.length));
    res.setHeader('X-Bundle-Skipped', skipped.slice(0, SKIPPED_NAMED).join(','));
    sendPack(res, zipPath);
});

// a uid list knob (only, copy): absent or empty is no filter at all
const uidSetOf = (v) => { const uids = listOf(v); return uids.length ? new Set(uids) : null; };

// the pack streams to a temp file (no body parser); the review knobs copy=, worlds=, only= ride the query
bundleRouter.post('/import', (req, res, next) => {
    if (!requireArchiveType(req, res, ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'])) return;
    // read before the body streams: a junk flag is refused by name, never read as true
    const worlds = boolOf(req.query.worlds, 'worlds') ?? true;
    const zipPath = packPath();
    const out = fs.createWriteStream(zipPath);
    req.pipe(out);
    out.on('error', next);
    // a client that hangs up mid-upload leaves no temp pack behind and no handler waiting
    // on a finish that never comes
    req.on('close', () => {
        if (req.complete) return;
        out.destroy();
        dropPack(zipPath);
    });
    // one that hangs up once the pack is in (the import's Cancel) stops the restore before its next entry
    const gone = new AbortController();
    res.on('close', () => { if (!res.writableEnded) gone.abort(); });
    out.on('finish', async () => {
        try {
            const summary = await importBundle(zipPath, {
                worlds,
                only: uidSetOf(req.query.only),
                copyUids: uidSetOf(req.query.copy),
                db: req.db,
                paths: req.paths,
                signal: gone.signal,
            });
            res.json(summary);
        } catch (err) {
            if (err?.statusCode) return res.status(err.statusCode).json({ error: err.message });
            next(err);
        } finally {
            dropPack(zipPath);
        }
    });
});
