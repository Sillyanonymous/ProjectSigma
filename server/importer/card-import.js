// the card import funnel every import door rides: a card and its picture in, a character out, through the no-overwrite triage
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { upsertImportedCharacter, classifyImport, getCharacter, storedCardHash, patchCharacter } from '../db/characters-store.js';
import { addCharSnapshot } from '../db/versions-store.js';
import { allowedScriptsMark, forgetConsentIfMoved } from '../db/regex-store.js';
import { invalidateAvatarThumbs } from '../lib/thumb-cache.js';
import { PROVIDER_NAMESPACES, extractProviderLinks } from '../lib/provider-namespaces.js';
import { readCardChunks, stripCardChunks } from '../lib/png-card.js';
import { normalizeCard, opStateSourceOf, liftOpState, IDENTITY_EXTENSIONS } from '../lib/card-normalize.js';
import { parseStDate } from '../lib/st-date.js';
import { runHook } from '../db/hook-seat.js';
import { httpError } from '../lib/http-error.js';

/**
 * Import one card PNG buffer. Returns { id, created, name }, { excluded: true } for
 * tag-excluded cards, or null when the PNG carries no card.
 */
export function importCharacterBuffer(db, buffer, opts = {}) {
    if (!opts.paths) throw new Error('importCharacterBuffer needs the importing users paths (opts.paths)');
    const parsed = readCardChunks(buffer);
    if (!parsed) return null;
    return importCharacterParts(db, parsed, () => stripCardChunks(buffer), opts);
}

/**
 * A snapshot of a character's card, its picture embedded unless told not to, in the caller's transaction; its id, or a 404 when gone.
 * @param {{source?: string, keepAutoBackups?: number, embedAvatar?: boolean}} [opts] an automatic snapshot: deduped, trimmed to its source's cap unless keepAutoBackups says, no picture copy
 */
export function snapshotCardAsItStood(db, paths, charId, label, { source = 'local', keepAutoBackups, embedAvatar = true } = {}) {
    const was = getCharacter(db, charId);
    // deleted while a staged file was read: nothing to replace, and nothing written
    if (!was) throw httpError(404, 'character not found');
    const data = JSON.parse(JSON.stringify(was.card.data || {}));
    data._avatarUrl = `/avatars/${encodeURIComponent(charId)}.png`;
    const avatar = path.join(paths.avatarsDir, `${charId}.png`);
    if (embedAvatar && fs.existsSync(avatar)) data._avatarImageData = `data:image/png;base64,${fs.readFileSync(avatar).toString('base64')}`;
    return addCharSnapshot(db, charId, { label, source, charName: data.name || null, data }, { keepAutoBackups });
}

/** A card patch with the card as it stood snapshotted first, both or neither; opts as snapshotCardAsItStood takes them. */
export function patchAfterSnapshot(db, paths, charId, label, fields, opts = {}) {
    db.transaction(() => {
        snapshotCardAsItStood(db, paths, charId, label, opts);
        patchCharacter(db, charId, { fields }, { answer: false });
    })();
}

/** The browse import's Replace resolution: a heal onto the id, favourite and lock kept, the card as it stood snapshotted first. Null when gone. */
export function replaceResolution(db, paths, id, { source = null } = {}) {
    if (!getCharacter(db, id)) return null;
    const resolution = {
        // the card's version_uid is recorded without taking it from a character that holds it
        action: 'heal', id, keepOpState: true, aliasMode: 'keep', snapshotId: null,
        before(dbIn, charId) {
            resolution.snapshotId = snapshotCardAsItStood(dbIn, paths, charId, `Before Replace from ${source || 'an import'}`);
        },
    };
    return resolution;
}

// whether the file holds exactly these bytes; a missing or unreadable file never does
function sameBytes(file, bytes) {
    try { return fs.readFileSync(file).equals(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)); } catch { return false; }
}

/**
 * Import one card from its parts ({ v3, v2 } and a picture, or a function answering one); opState lands only on a new row.
 * @param {object} [opts] raw: the file's own payloads when parsed is an amendment, so its root op state (date, favourite) still lands
 */
export function importCharacterParts(db, parsed, picture, { sourceName = null, filenameIsIdentity = false, excludeTags = [], createdAtFallback = null, force = null, paths = null, resolved = null, source = null, opState = null, raw = null } = {}) {
    if (!paths) throw new Error('importCharacterParts needs the importing users paths (opts.paths)');
    const normalized = normalizeCard(parsed);
    if (!normalized) return null;
    // an extension may rewrite the card before identity and the content hash are read off it
    const card = runHook('card.import', normalized, { db, sourceName, provider: source });

    if (excludeTags.length && card.data.tags.some(t => excludeTags.includes(t.toLowerCase()))) {
        return { excluded: true };
    }

    const lifted = liftOpState(card, opStateSourceOf(raw || parsed));

    const aliases = [];
    // a filename is identity only where it was one (the ST directory): two cards both saved as character.png are two characters
    if (sourceName && filenameIsIdentity) aliases.push({ kind: 'avatar_file', value: sourceName });
    if (typeof card.data.extensions.version_uid === 'string' && card.data.extensions.version_uid) {
        aliases.push({ kind: 'version_uid', value: card.data.extensions.version_uid });
    }
    // the exported uuid is no alias: an import keeps it as the primary key when free, so re-imports match by id
    const portableId = typeof card.data.extensions.cl?.uid === 'string' && card.data.extensions.cl.uid
        ? card.data.extensions.cl.uid : null;
    const providerLinks = extractProviderLinks(card.data.extensions, source);
    const galleryId = typeof card.data.extensions.gallery_id === 'string' ? card.data.extensions.gallery_id : null;
    for (const ns of [...PROVIDER_NAMESPACES, ...IDENTITY_EXTENSIONS]) {
        if (ns === 'cl') {
            // only the uid is identity; the rest of the cl namespace is user content
            // (tagline for unlinked chars, etc) and MUST survive the import
            if (card.data.extensions.cl && typeof card.data.extensions.cl === 'object') {
                delete card.data.extensions.cl.uid;
                if (Object.keys(card.data.extensions.cl).length === 0) delete card.data.extensions.cl;
            }
            continue;
        }
        delete card.data.extensions[ns];
    }

    // V3 creation_date: the spec says seconds, RisuAI writes ms; no second count reaches 1e11 before the year 5138
    const v3Created = Number(card.data.creation_date);
    // ST writes create_date as a string; a card's numeric stamp is V3's creation_date, read below by its own rule
    const createdAt = (typeof lifted.createDate === 'string' ? parseStDate(lifted.createDate) : null)
        ?? (Number.isFinite(v3Created) && v3Created > 0 ? (v3Created >= 1e11 ? v3Created : v3Created * 1000) : null)
        ?? createdAtFallback ?? Date.now();

    const tags = card.data.tags;
    delete card.data.tags; // relational-only; composed back on reads and exports

    // the ST migration hands its own resolution: the one surface exempt from the no-overwrite policy

    // everything else triages: identical content or a matched identity is a skip the caller surfaces, hashed over the stored form
    if (!resolved && force !== 'copy') {
        const verdict = classifyImport(db, {
            contentHash: storedCardHash(card),
            portableId,
            aliases,
            providerLinks,
        });
        if (verdict.action === 'skip') {
            return { skipped: true, reason: verdict.reason, id: verdict.matchId, created: false, name: card.data.name };
        }
    }

    // the picture goes to a temp file, then is renamed in the row's transaction, so a character never exists without its picture
    const tmp = path.join(paths.avatarsDir, `.import-${crypto.randomBytes(6).toString('hex')}.png`);
    const bytes = typeof picture === 'function' ? picture() : picture;
    // a heal onto the picture it already has writes no picture
    const pictureChanged = resolved?.action !== 'heal' || !sameBytes(path.join(paths.avatarsDir, `${resolved.id}.png`), bytes);
    // a card written over a character may bring other regex scripts than the ones its reader allowed
    const allowed = resolved?.action === 'heal' ? allowedScriptsMark(db, resolved.id) : null;
    let result;
    try {
        // inside the try whose finally removes it, so a write the disk refuses part way leaves no temp
        fs.writeFileSync(tmp, bytes);
        result = db.transaction(() => {
            // a heal keeps the marks the file carried; the sidecar is a new row's alone
            const side = resolved?.action === 'heal' ? null : opState;
            const r = upsertImportedCharacter(db, {
                card,
                fav: side ? !!side.fav : lifted.fav,
                updateLocked: side ? !!side.updateLocked : lifted.updateLocked,
                loreDismissed: !!side?.loreDismissed,
                mediaLocalized: !!side?.mediaLocalized,
                createdAt,
                aliases,
                providerLinks,
                tags,
                copy: force === 'copy',
                resolved,
                portableId,
                pictureChanged,
            });
            forgetConsentIfMoved(db, r.id, allowed);
            if (!r.skipped && (r.created || pictureChanged)) fs.renameSync(tmp, path.join(paths.avatarsDir, `${r.id}.png`));
            return r;
        })();
    } finally {
        try { fs.unlinkSync(tmp); } catch { /* renamed into place */ }
    }
    // the thumb cache never expires on its own, so a re-import that changes the art would keep
    // serving the old picture forever
    if (!result.skipped && !result.created && pictureChanged) invalidateAvatarThumbs(paths.avatarThumbsDir, result.id);
    return { ...result, name: card.data.name, galleryId, cardName: card.data.name };
}
