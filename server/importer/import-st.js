// the ST directory walk's own pieces (legacy gallery folders, a card file, the chats folder); cards go through the funnel
import fs from 'node:fs';
import path from 'node:path';
import { importMediaFile } from '../db/media-store.js';
import { parseStDate, parseStChatJsonl } from '../db/chats-store.js';
import { storeSuppliedChat } from '../llm/prompt.js';
import { importCharacterBuffer } from './card-import.js';

// the two legacy gallery folder shapes: shared folders strip illegal chars (ST's), unique <name>_<id> folders substitute '_'
const stSanitizeFolder = name => String(name || '').replace(/[<>:"/\\|?*]/g, '').trim();
const clSanitizeFolder = name => String(name || '').replace(/[<>:"/\\|?*]/g, '_').trim();

export function legacyGalleryFolders(name, galleryId) {
    const candidates = [];
    if (galleryId) {
        const base = clSanitizeFolder(name);
        candidates.push(base ? `${base}_${galleryId}` : `_${galleryId}`);
    }
    const shared = stSanitizeFolder(name);
    // a name of dots alone is the images root itself (or its parent), never a character's folder
    if (shared && !/^[.\s]+$/.test(shared)) candidates.push(shared);
    return candidates;
}

function importCharacterGallery(db, paths, charId, name, galleryId, imagesRoot, counters) {
    for (const folder of legacyGalleryFolders(name, galleryId)) {
        const dir = path.join(imagesRoot, folder);
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir)) {
            const full = path.join(dir, file);
            if (!fs.statSync(full).isFile()) continue;
            try {
                const result = importMediaFile(db, paths, charId, full);
                if (!result) continue;
                if (result.skipped) counters.mediaSkipped++;
                else counters.mediaImported++;
            } catch (err) {
                counters.errors.push({ file: `${folder}/${file}`, error: err.message });
            }
        }
    }
}


export function importCharacterPng(db, paths, pngPath, { excludeTags = [], imagesRoot = null, counters = null, resolved = null } = {}) {
    const buffer = fs.readFileSync(pngPath);
    const result = importCharacterBuffer(db, buffer, {
        sourceName: path.basename(pngPath),
        filenameIsIdentity: true, // ST keyed characters BY their avatar filename
        excludeTags,
        createdAtFallback: Math.round(fs.statSync(pngPath).mtimeMs),
        paths,
        resolved,
    });
    if (result?.id && imagesRoot && counters) {
        importCharacterGallery(db, paths, result.id, result.cardName, result.galleryId, imagesRoot, counters);
    }
    return result;
}

/** Parse ST chat JSONL folders into rows, each folder resolved to a character by its avatar_file alias; re-runs upsert by (char, name). */
export function importChatsDir(db, chatsDir, summary, { allowDirs = null } = {}) {
    if (!fs.existsSync(chatsDir)) return;
    const byAvatar = db.prepare("SELECT char_id FROM char_aliases WHERE kind = 'avatar_file' AND value = ?");
    for (const dirent of fs.readdirSync(chatsDir, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        // selective migrations restrict to the chosen characters' folders; a skipped
        // folder is out of scope, not unmatched
        if (allowDirs && !allowDirs.has(dirent.name)) continue;
        const charRow = byAvatar.get(`${dirent.name}.png`);
        if (!charRow) { summary.chatsUnmatched++; continue; }
        const dirPath = path.join(chatsDir, dirent.name);
        for (const file of fs.readdirSync(dirPath).filter(f => f.toLowerCase().endsWith('.jsonl'))) {
            const filePath = path.join(dirPath, file);
            try {
                const parsed = parseStChatJsonl(fs.readFileSync(filePath, 'utf8'));
                if (!parsed) continue;
                const { header, messages, dropped } = parsed;
                if (dropped) summary.chatLinesDropped = (summary.chatLinesDropped || 0) + dropped;
                // whole ms: mtimeMs is fractional, and the stamp is a sort key that rides the list cursor
                if (!parseStDate(header.create_date)) header.create_date = Math.round(fs.statSync(filePath).mtimeMs);
                // ST expands a fresh chat's greeting as it shows; a stored greeting here is expanded in the write that stores it
                storeSuppliedChat(db, {
                    charId: charRow.char_id,
                    name: path.basename(file, path.extname(file)),
                    header,
                    messages,
                    imported: true,
                });
                summary.chats++;
            } catch (err) {
                summary.errors.push({ file: `${dirent.name}/${file}`, error: err.message });
            }
        }
    }
}

