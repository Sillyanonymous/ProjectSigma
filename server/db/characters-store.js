import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROVIDER_NAMESPACES, buildLinkRow, NS_SEGMENT } from '../lib/provider-namespaces.js';
import { buildRuleClauses, textMatch, ftsWordsQuery } from './rule-filters.js';
import { CARD_TEXT_Q_FIELDS, cardTextSearch } from './card-text-search.js';
import { cardContentHash } from '../lib/card-hash.js';
import { headWorldFor, setHeadWorldFor } from './world-links-store.js';
import { replaceTagLinks, appendTagLinks } from './tag-links.js';
import { emitChange, reportCharactersUpdated } from './changes.js';
import { patchSettings, settingValue } from './settings-store.js';
import { projectionSelect, extSortKey, knownSplit, rememberSplit } from './ext-query.js';
import { encodeCursor as encodeTuple, decodeCursor as decodeTuple } from './cursor.js';
import { runHook } from './hook-seat.js';
import { excerptOf } from '../lib/text-excerpt.js';
import { invalidateAvatarThumbs, invalidateMediaThumbs } from '../lib/thumb-cache.js';
import { deleteAllMediaFiles } from './media-store.js';
import { attachmentsHeldBy, removeAttachmentFiles } from './attachments-store.js';
import { UUID_RE } from '../lib/uuid.js';
import { httpError } from '../lib/http-error.js';

const NS_FIELD_RE = new RegExp(`^extensions\\.(${NS_SEGMENT})(?:\\.(.+))?$`);

/**
 * Identity for a card being imported: the portable id, then version_uid, then a provider link, the avatar filename last.
 */
export function resolveByAliases(db, aliases, providerLinks = [], portableId = null) {
    const byId = db.prepare('SELECT id FROM characters WHERE id = ?');
    const stmt = db.prepare('SELECT char_id FROM char_aliases WHERE kind = ? AND value = ?');
    const byKind = new Map(aliases.map(a => [a.kind, a.value]));

    if (portableId && byId.get(portableId)) return portableId;
    {
        const value = byKind.get('version_uid');
        if (value) {
            const row = stmt.get('version_uid', value);
            if (row) return row.char_id;
        }
    }

    // oldest match wins: one external_id can sit on two characters imported before this resolution, and healing onto the original is safe
    const byLink = db.prepare(`
        SELECT pl.char_id FROM provider_links pl
        JOIN characters c ON c.id = pl.char_id
        WHERE pl.provider_id = ? AND pl.external_id = ?
        ORDER BY c.imported_at ASC LIMIT 1
    `);
    for (const link of providerLinks) {
        if (!link?.providerId || link.externalId == null || link.externalId === '') continue;
        const row = byLink.get(link.providerId, String(link.externalId));
        if (row) return row.char_id;
    }

    const avatarFile = byKind.get('avatar_file');
    if (avatarFile) {
        const row = stmt.get('avatar_file', avatarFile);
        if (row) return row.char_id;
    }
    return null;
}

/** The identical / diverged / new triage for an incoming card; imports never overwrite, so both matches come back as skips. */
export function classifyImport(db, { contentHash = null, portableId = null, aliases = [], providerLinks = [] } = {}) {
    if (contentHash) {
        const row = db.prepare('SELECT id FROM characters WHERE content_hash = ? ORDER BY imported_at ASC LIMIT 1').get(contentHash);
        if (row) return { action: 'skip', reason: 'identical', matchId: row.id };
    }
    const matchId = resolveByAliases(db, aliases, providerLinks, portableId);
    if (matchId) {
        return { action: 'skip', reason: matchId === portableId ? 'diverged-uuid' : 'diverged-provenance', matchId };
    }
    return { action: 'new' };
}

// a name is one line of at most NAME_MAX code points, folded at every write; the stored-card invariant folds with this same function
const NAME_MAX = 128;
export function oneLineName(card) {
    if (card?.data && typeof card.data.name === 'string') card.data.name = [...card.data.name.replace(/\s*[\r\n\t\u2028\u2029]\s*/g, ' ').trim()].slice(0, NAME_MAX).join('').trimEnd();
}

// the stored form: the world key lifted to a link row, a provider's data.avatar dropped, the name on one line; the triage hashes it
function toStoredForm(card) {
    if (card?.data?.extensions && 'world' in card.data.extensions) delete card.data.extensions.world;
    if (card?.data && 'avatar' in card.data) delete card.data.avatar;
    oneLineName(card);
    return card;
}

/** The content hash a card would be stored under (toStoredForm), leaving the card as it is. */
export function storedCardHash(card) {
    return cardContentHash(toStoredForm(structuredClone(card)));
}

/**
 * Insert a character from import, or apply a heal (the ST migration's, a Replace's): writes only what moves. Every other caller triages first.
 * @param {object} opts pictureChanged: whether the caller writes a new picture for a heal
 */
export function upsertImportedCharacter(db, { card, fav, updateLocked = false, loreDismissed = false, mediaLocalized = false, createdAt, aliases, providerLinks, tags, copy = false, resolved = null, portableId = null, pictureChanged = true }) {
    const now = Date.now();
    // a card silent on extensions.world leaves the binding alone (exports embed it only with a head); a replace ignores the key
    const hasWorldKey = typeof card?.data?.extensions?.world === 'string' && !resolved?.keepOpState;
    const primaryWorld = hasWorldKey ? card.data.extensions.world.trim() : '';
    toStoredForm(card);

    return db.transaction(() => {
        let id;
        let asCopy = copy;
        if (resolved) {
            // caller pre-resolved identity (the ST migration, whose filename-first
            // semantics differ from resolveByAliases' portable-id-first order)
            if (resolved.action === 'heal') id = resolved.id;
            else if (resolved.action === 'copy') asCopy = true;
        }
        const created = !id;

        let healed = null;
        if (created) {
            // the uuid travels: a fresh import keeps a free portable id, copies always mint
            const adoptable = !asCopy && portableId && UUID_RE.test(portableId)
                && !db.prepare('SELECT 1 FROM characters WHERE id = ?').get(portableId);
            id = adoptable ? portableId : crypto.randomUUID();
            db.prepare(`
                INSERT INTO characters (id, card, fav, update_locked, lore_dismissed, media_localized, token_estimate, content_hash, created_at, imported_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(id, JSON.stringify(card), fav ? 1 : 0, updateLocked ? 1 : 0, loreDismissed ? 1 : 0, mediaLocalized ? 1 : 0, computeTokenEstimate(card.data), cardContentHash(card), createdAt ?? now, now, now);
        } else {
            const row = db.prepare('SELECT card, fav, update_locked, content_hash FROM characters WHERE id = ?').get(id);
            const stored = JSON.parse(row?.card || '{}');
            const storedData = { ...(stored.data || {}) };
            const storedHash = cardContentHash(stored);
            // a cross-provider relink lifts the old row's display fields into cl, both cards alike: the link's data moving is no edit
            if (providerLinks.length && row) {
                for (const o of db.prepare('SELECT data FROM provider_links WHERE char_id = ? AND provider_id != ?').all(id, providerLinks[0].providerId)) {
                    liftDisplayFields(card, o.data);
                    liftDisplayFields(stored, o.data);
                }
            }
            const contentHash = cardContentHash(card);
            const cardMoved = !row || contentHash !== storedHash;
            const contentMoved = !row || contentHash !== cardContentHash(stored);
            // a replace keeps the reader's own marks; the migration's heal restores the file's
            const keep = resolved?.keepOpState && row;
            const newFav = (keep ? row.fav : fav) ? 1 : 0;
            const newLocked = (keep ? row.update_locked : updateLocked) ? 1 : 0;
            const flagMoved = { fav: !row || newFav !== row.fav, update_locked: !row || newLocked !== row.update_locked };
            // the snapshot of the card as it stood (a replace's, a changed heal's) lands in this write's transaction
            if (contentMoved || pictureChanged) resolved?.before?.(db, id, { contentHash, storedHash: row?.content_hash ?? null });
            const sets = [];
            const vals = [];
            if (cardMoved) {
                sets.push('card = ?', 'token_estimate = ?', 'content_hash = ?');
                vals.push(JSON.stringify(card), computeTokenEstimate(card.data), contentHash);
            }
            if (contentMoved) {
                // a replace's card brings its own remote media, so nothing of it is localized yet
                sets.push('updated_at = ?', ...(keep ? ['media_localized = 0'] : []));
                vals.push(now);
            }
            if (flagMoved.fav) { sets.push('fav = ?'); vals.push(newFav); }
            if (flagMoved.update_locked) { sets.push('update_locked = ?'); vals.push(newLocked); }
            if (sets.length) db.prepare(`UPDATE characters SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
            healed = { contentMoved, flagMoved, stored: storedData };
        }

        // 'keep' records without stealing: a copy takes the alias values nobody owns, shared ones stay with the group's first import
        const aliasStmt = resolved?.aliasMode === 'keep'
            ? db.prepare('INSERT OR IGNORE INTO char_aliases (kind, value, char_id) VALUES (?, ?, ?)')
            : db.prepare(`
                INSERT INTO char_aliases (kind, value, char_id) VALUES (?, ?, ?)
                ON CONFLICT(kind, value) DO UPDATE SET char_id = excluded.char_id
            `);
        if (!asCopy || resolved?.aliasMode === 'keep') {
            for (const alias of aliases) aliasStmt.run(alias.kind, alias.value, id);
        }

        // one link per character and import silence is no unlink: a carried link replaces the held one, unless it is that one
        let linkMoved = false;
        if (providerLinks.length) {
            const link = providerLinks[0];
            const held = db.prepare('SELECT provider_id, external_id, full_path, page_name, linked_at, data FROM provider_links WHERE char_id = ?').all(id);
            if (!(held.length === 1 && held[0].provider_id === link.providerId && sameLinkRow(held[0], link))) {
                db.prepare('DELETE FROM provider_links WHERE char_id = ?').run(id);
                db.prepare(`
                    INSERT INTO provider_links (char_id, provider_id, external_id, full_path, page_name, linked_at, data)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(id, link.providerId, link.externalId ?? null, link.fullPath ?? null,
                    link.pageName ?? null, link.linkedAt ?? null, JSON.stringify(link.data));
                linkMoved = true;
            }
        }

        // Import silence is not a removal request: an update UNIONS tags (removal has its
        // own UIs) while a fresh import takes the card's set verbatim.
        const tagsMoved = created ? replaceTagLinks(db, id, tags) : appendTagLinks(db, id, tags) > 0;
        // the one record of this write (a created row is every field, a heal names what it rewrote), before the lore head reports its own
        if (created) emitChange(db, { entity: 'character', op: 'created', ids: [id] });
        else {
            const fields = healed.contentMoved
                ? healedFields(healed.stored, card.data, { tags, providerLinks, hasWorldKey, replaced: !!resolved?.keepOpState, pictureChanged })
                : [...(pictureChanged ? ['avatar'] : []), ...(healed.flagMoved.fav ? ['fav'] : []), ...(healed.flagMoved.update_locked ? ['updateLocked'] : []),
                    ...(tagsMoved ? ['tags'] : []), ...(linkMoved ? [`extensions.${providerLinks[0].providerId}`] : [])];
            if (fields.length) emitChange(db, { entity: 'character', op: 'updated', ids: [id], fields });
        }
        if (hasWorldKey) setHeadWorld(db, id, primaryWorld);
        return { id, created };
    })();
}

// a changed card's heal names every key either card holds, its two columns, the picture if it moved, its tags, link and world
function healedFields(before, after, { tags, providerLinks, hasWorldKey, replaced = false, pictureChanged = true }) {
    // a tab redraws a picture only when told
    const fields = new Set([...Object.keys(before || {}), ...Object.keys(after || {}), 'fav', 'updateLocked', ...(pictureChanged ? ['avatar'] : [])]);
    if (replaced) fields.add('mediaLocalized');
    if (tags.length) fields.add('tags');
    if (providerLinks.length) fields.add(`extensions.${providerLinks[0].providerId}`);
    if (hasWorldKey) fields.add('extensions.world');
    return [...fields];
}

const LINKS_SUBQUERY = `(SELECT json_group_array(json_object('providerId', pl.provider_id, 'data', json(pl.data)))
              FROM provider_links pl WHERE pl.char_id = c.id)`;

const LIST_SQL = `
    SELECT c.rowid AS rid, c.id, c.name, c.creator, c.nickname, c.character_version,
           c.fav, c.update_locked, c.media_localized, c.lore_dismissed, c.token_estimate, c.created_at, c.imported_at, c.updated_at,
           (SELECT json_group_array(t.name ORDER BY ct.pos) FROM char_tags ct
              JOIN tags t ON t.id = ct.tag_id WHERE ct.char_id = c.id) AS tags,
           (SELECT json_group_array(pc.playlist_id) FROM playlist_chars pc WHERE pc.char_id = c.id) AS playlists,
           ${LINKS_SUBQUERY} AS links
    FROM characters c
`;

// the notes sit on overflow pages, most of a cold page's reads, so a list reads them only for a reader that names them
const NOTES_FIELDS = Object.freeze(['creatorNotes', 'creatorNotesExcerpt']);
const withNotes = (sql) => sql.replace('c.character_version,', 'c.character_version, c.creator_notes,');

// the row columns a set verb may ask for beside id and fav, plus the list fields a reader names to get them
const CHAR_SET_FIELDS = Object.assign(Object.create(null), {
    name: 'c.name',
    creator: 'c.creator',
    characterVersion: 'c.character_version',
    mediaLocalized: 'c.media_localized',
    links: `${LINKS_SUBQUERY} AS links`,
});
export const CHAR_FIELDS = [...Object.keys(CHAR_SET_FIELDS), ...NOTES_FIELDS];
const fieldColumns = (fields = []) => fields.filter(f => CHAR_SET_FIELDS[f]).map(f => `, ${CHAR_SET_FIELDS[f]}`).join('');
function idsOnlyItem(row, fields = []) {
    const item = { id: row.id, fav: !!row.fav };
    for (const f of fields) {
        if (f === 'name') item.name = row.name;
        else if (f === 'creator') item.creator = row.creator;
        else if (f === 'characterVersion') item.characterVersion = row.character_version;
        else if (f === 'mediaLocalized') item.mediaLocalized = !!row.media_localized;
        else if (f === 'links') item.links = JSON.parse(row.links || '[]');
    }
    return item;
}

// null-prototype like CHAT_SORTS: sort=constructor must never reach the ORDER BY
export const CHAR_SORTS = Object.assign(Object.create(null), {
    name: 'c.name COLLATE NOCASE',
    created: 'c.created_at',
    imported: 'c.imported_at',
    updated: 'c.updated_at',
    tokens: 'c.token_estimate',
});
// the index each sort walks when forced; a missing name errors loudly at prepare, which beats a silent scan
export const CHAR_SORT_INDEX = Object.assign(Object.create(null), {
    name: 'idx_characters_name_nocase',
    created: 'idx_characters_created',
    imported: 'idx_characters_imported',
    updated: 'idx_characters_updated',
    tokens: 'idx_characters_tokens',
});
// the partial favourites index each sort walks when the only row clause is the favourites filter
export const CHAR_FAV_SORT_INDEX = Object.assign(Object.create(null), {
    name: 'idx_characters_fav_name',
    created: 'idx_characters_fav_created',
    imported: 'idx_characters_fav_imported',
    updated: 'idx_characters_fav_updated',
    tokens: 'idx_characters_fav_tokens',
});

// notes and the last three are card text, answered by characters_fts through the term list (card-text-search.js)
export const CHAR_Q_FIELDS = [
    'name', 'nickname', 'creator', 'notes', 'tags', 'listingName', 'tagline',
    'description', 'firstMessage', 'altGreetings',
];

// keyset expressions per sort, mirroring CHAR_SORTS exactly; relevance has no stable key, so its offset-only
const KEYSET_EXPRS = Object.assign(Object.create(null), {
    name: 'c.name COLLATE NOCASE',
    created: 'c.created_at',
    imported: 'c.imported_at',
    updated: 'c.updated_at',
    tokens: 'c.token_estimate',
});
const CURSOR_FIELD = Object.assign(Object.create(null), { name: i => i.name, created: i => i.createdAt, imported: i => i.importedAt, updated: i => i.updatedAt, tokens: i => i.tokenEstimate });

// a cursor is the sort key and the ROWID of the last row (the tiebreak the walk uses), so a
// pre-rowid cursor is simply refused
export function encodeCursor(sortKey, rid) {
    return encodeTuple([sortKey, rid]);
}
export function decodeCursor(cursor) {
    const vals = decodeTuple(cursor, 2, { intLast: true });
    return vals && { sk: vals[0], rid: vals[1] };
}

// one tag's id set, IN-form so the planner drives from the tag side instead of probing every character
const TAG_SUB_SQL = `SELECT ct.char_id FROM char_tags ct JOIN tags t ON t.id = ct.tag_id
    WHERE t.name = ? COLLATE NOCASE`;

/**
 * The SQL behind queryCharacters, exported so its plans can be read: sets alone force the sort's index walk, a row clause frees the planner.
 * @returns {{ countSql: string, pageSql?: string, idSql?: string, ext?: object, params: any[], pageParams?: any[], setsOnly: boolean, sort: string, order: string }}
 */
export function characterListQuery(db, opts = {}) {
    const others = [];
    const params = [];
    // a set clause in both spellings: the id form for a free plan, the rowid form for the forced walk
    const sets = [];
    const idSet = (sub, p, negate = false) => sets.push({
        idSql: `c.id ${negate ? 'NOT IN' : 'IN'} (${sub})`,
        rowidSql: `c.rowid ${negate ? 'NOT IN' : 'IN'} (SELECT c3.rowid FROM characters c3 WHERE c3.id IN (${sub}))`,
        params: p,
    });

    const qText = opts.q;
    if (qText) {
        const fields = (opts.qIn?.length ? opts.qIn : ['name', 'nickname', 'creator'])
            .filter(f => CHAR_Q_FIELDS.includes(f));
        // name, nickname and creator resolve to an id set off idx_characters_q; INDEXED BY since the planner refuses the covering index unaided
        const setSelects = [];
        const setParams = [];
        const idxCols = fields.filter(f => f === 'name' || f === 'nickname' || f === 'creator');
        if (idxCols.length) {
            const colOf = { name: 'c2.name', nickname: 'c2.nickname', creator: 'c2.creator' };
            const matches = idxCols.map(f => textMatch(colOf[f], qText));
            setSelects.push(`SELECT c2.id FROM characters c2 INDEXED BY idx_characters_q
                WHERE ${matches.map(m => m.sql).join(' OR ')}`);
            for (const m of matches) setParams.push(...m.params);
        }
        // the card's text answers from characters_fts, a typed word found inside the words it indexed
        const textFields = fields.filter(f => CARD_TEXT_Q_FIELDS[f]);
        const textSelects = [];
        const textParams = [];
        const rowParts = [];
        const rowParams = [];
        if (textFields.length) {
            const arm = cardTextSearch(db, qText, textFields);
            textSelects.push(...arm.selects);
            textParams.push(...arm.params);
            if (arm.row) { rowParts.push(arm.row.sql); rowParams.push(...arm.row.params); }
        }
        if (fields.includes('tags')) {
            // driven from the matching tags: the join let the planner walk every link in the library
            const m = textMatch('t.name', qText);
            setSelects.push(`SELECT ct.char_id FROM char_tags ct
                WHERE ct.tag_id IN (SELECT t.id FROM tags t WHERE ${m.sql})`);
            setParams.push(...m.params);
        }
        if (fields.includes('listingName')) {
            const m = textMatch('pl.page_name', qText);
            setSelects.push(`SELECT pl.char_id FROM provider_links pl WHERE ${m.sql}`);
            setParams.push(...m.params);
        }
        if (fields.includes('tagline')) {
            // both tagline homes ride expression indexes, so the json_extract text must stay byte-identical to the indexed expression
            const own = textMatch("json_extract(c2.card, '$.data.extensions.cl.tagline')", qText);
            const listing = textMatch("json_extract(pl.data, '$.tagline')", qText);
            setSelects.push(`SELECT c2.id FROM characters c2 INDEXED BY idx_characters_tagline
                WHERE ${own.sql}`);
            setSelects.push(`SELECT pl.char_id FROM provider_links pl INDEXED BY idx_provider_links_tagline
                WHERE ${listing.sql}`);
            setParams.push(...own.params, ...listing.params);
        }
        // UNION ALL: each arm runs on its own plan and the IN dedupes; a UNION merged arms in id order, reading a row per link
        const ids = setSelects.join(' UNION ALL ');
        if (rowParts.length) {
            // a card-text scan is a row clause ORed with the set, so the page walk stops once it has its rows
            const parts = [...(setSelects.length ? [`c.id IN (${ids})`] : []), ...(textSelects.length ? [`c.rowid IN (${textSelects.join(' UNION ALL ')})`] : []), ...rowParts];
            others.push(`(${parts.join(' OR ')})`);
            params.push(...setParams, ...textParams, ...rowParams);
        } else if (textSelects.length) {
            // card text is a rowid set, as a match is: an id per matched row would read each card's row (seconds at 1M)
            const union = [...(setSelects.length ? [`SELECT c3.rowid FROM characters c3 WHERE c3.id IN (${ids})`] : []), ...textSelects].join(' UNION ALL ');
            sets.push({ idSql: `c.rowid IN (${union})`, rowidSql: `c.rowid IN (${union})`, params: [...setParams, ...textParams] });
        } else if (setSelects.length) {
            idSet(ids, setParams);
        }
    }
    // one bound JSON array however long: a placeholder per value hits SQLite's variable limit
    const idList = !!opts.ids?.length;
    if (idList) idSet('SELECT value FROM json_each(?)', [JSON.stringify(opts.ids.map(String))]);
    // the ids a selection over a filter left out after it was taken
    if (opts.notIds?.length) idSet('SELECT value FROM json_each(?)', [JSON.stringify(opts.notIds.map(String))], true);
    if (opts.creator) { others.push('c.creator = ? COLLATE NOCASE'); params.push(opts.creator); }
    for (const t of opts.tags || []) idSet(TAG_SUB_SQL, [t]);
    if (opts.anyTags?.length) {
        idSet(`SELECT ct.char_id FROM char_tags ct JOIN tags t ON t.id = ct.tag_id
            WHERE t.name COLLATE NOCASE IN (SELECT value FROM json_each(?))`, [JSON.stringify(opts.anyTags.map(String))]);
    }
    if (opts.excludeTags?.length) {
        idSet(`SELECT ct.char_id FROM char_tags ct JOIN tags t ON t.id = ct.tag_id
            WHERE t.name COLLATE NOCASE IN (SELECT value FROM json_each(?))`, [JSON.stringify(opts.excludeTags.map(String))], true);
    }
    if (opts.excludeTagsAll?.length) {
        // reject only when the char carries EVERY listed tag (the exclude 'all' mode)
        others.push(`NOT (${opts.excludeTagsAll.map(() => `c.id IN (${TAG_SUB_SQL})`).join(' AND ')})`);
        params.push(...opts.excludeTagsAll);
    }
    if (opts.provider) {
        others.push('EXISTS (SELECT 1 FROM provider_links pl WHERE pl.char_id = c.id AND pl.provider_id = ?)');
        params.push(opts.provider);
    }
    if (opts.linked === true) others.push('EXISTS (SELECT 1 FROM provider_links pl WHERE pl.char_id = c.id)');
    if (opts.linked === false) others.push('NOT EXISTS (SELECT 1 FROM provider_links pl WHERE pl.char_id = c.id)');
    // before the card probe below, so a row the localized flag rules out is never read for its blob
    if (opts.mediaLocalized !== undefined) { others.push('c.media_localized = ?'); params.push(opts.mediaLocalized ? 1 : 0); }
    // substring probe over the whole card JSON: a superset of every real media
    // URL (media-localization prefilter), including fields FTS does not index
    if (opts.hasUrl === true) others.push("c.card LIKE '%http%'");
    if (opts.hasUrl === false) others.push("c.card NOT LIKE '%http%'");
    // a literal, as the favourite rule writes it: a bound value cannot select the partial favourites indexes
    if (opts.fav !== undefined) others.push(opts.fav ? 'c.fav = 1' : 'c.fav = 0');
    if (opts.locked !== undefined) { others.push('c.update_locked = ?'); params.push(opts.locked ? 1 : 0); }
    if (opts.loreDismissed !== undefined) { others.push('c.lore_dismissed = ?'); params.push(opts.loreDismissed ? 1 : 0); }
    if (opts.world) {
        others.push('? IN (SELECT cw.world_name FROM char_worlds cw WHERE cw.char_id = c.id)');
        params.push(opts.world);
    }
    if (opts.hasWorld === true) others.push('EXISTS (SELECT 1 FROM char_worlds cw WHERE cw.char_id = c.id)');
    if (opts.hasWorld === false) others.push('NOT EXISTS (SELECT 1 FROM char_worlds cw WHERE cw.char_id = c.id)');
    if (opts.hasLorebook !== undefined) { others.push('c.has_lorebook = ?'); params.push(opts.hasLorebook ? 1 : 0); }
    if (opts.hasSystemPrompt !== undefined) { others.push('c.has_system_prompt = ?'); params.push(opts.hasSystemPrompt ? 1 : 0); }
    if (opts.altGreetingsMin !== undefined) { others.push('c.alt_greetings >= ?'); params.push(opts.altGreetingsMin); }
    if (opts.specVersion) { others.push('c.spec_version = ?'); params.push(opts.specVersion); }
    for (const [key, clause] of [
        ['tokensMin', 'c.token_estimate >= ?'], ['tokensMax', 'c.token_estimate <= ?'],
        ['createdAfter', 'c.created_at >= ?'], ['createdBefore', 'c.created_at <= ?'],
        ['importedAfter', 'c.imported_at >= ?'], ['importedBefore', 'c.imported_at <= ?'],
        ['updatedAfter', 'c.updated_at >= ?'], ['updatedBefore', 'c.updated_at <= ?'],
    ]) {
        if (opts[key] !== undefined) { others.push(clause); params.push(opts[key]); }
    }

    // structured rules: the advanced-filter model compiled to SQL (rule-filters.js).
    // Opaque here, so a rule always makes the query a mixed one.
    if (opts.rules?.length) {
        const built = buildRuleClauses(db, opts.rules);
        others.push(...built.clauses);
        params.push(...built.params);
    }

    // words is typed text read as the match; a text of no words matches nothing, never the whole library
    const match = opts.words !== undefined ? ftsWordsQuery(opts.words) : opts.match;
    if (opts.words !== undefined && !match) others.push('0');

    // random is a sampling sort with no stable key, so like relevance and an extension sort its offset-only
    const extSort = typeof opts.sort === 'string' && opts.sort.startsWith('ext.') ? extSortKey(db, opts.sort) : undefined;
    const sort = extSort ? opts.sort
        : opts.sort === 'relevance' && match ? 'relevance'
            : opts.sort === 'random' ? 'random'
                : CHAR_SORTS[opts.sort] ? opts.sort : 'name';
    const order = opts.order === 'desc' ? 'desc' : 'asc';
    const dir = order.toUpperCase();
    const sortKey = sort === 'relevance' ? 'fts.rank' : sort === 'random' ? 'random()' : CHAR_SORTS[sort];
    // an index walk serves every sort but relevance and random; a cursor, the core ones
    const walked = sort !== 'relevance' && sort !== 'random';
    const cursorable = walked && !extSort;

    // full-text: FTS5 syntax verbatim; under relevance the rank comes from the joined table, else the match is a set of rowids
    let joinSql = '';
    if (match && sort === 'relevance') {
        joinSql = ' JOIN characters_fts fts ON fts.rowid = c.rowid';
        others.push('fts.characters_fts MATCH ?');
        params.push(match);
    } else if (match) {
        const sub = 'SELECT f.rowid FROM characters_fts f WHERE f.characters_fts MATCH ?';
        sets.push({ idSql: `c.rowid IN (${sub})`, rowidSql: `c.rowid IN (${sub})`, params: [match] });
    }

    const setsOnly = walked && sets.length > 0 && others.length === 0 && !idList;
    // the favourites filter alone walks the sort's partial favourites index: left free, the planner read and sorted every favourite
    const favWalk = walked && !extSort && !idList && others.length === 1 && others[0] === 'c.fav = 1';
    const forcedIndex = setsOnly ? CHAR_SORT_INDEX[sort] : favWalk ? CHAR_FAV_SORT_INDEX[sort] : null;
    // a forced walk (an extension sort's segments included) tests the sets on the rowid
    const where = [...sets.map(s => (setsOnly || favWalk ? s.rowidSql : s.idSql)), ...others];
    const whereParams = [...sets.flatMap(s => s.params), ...params];
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    // the count and the set read no sort key, so they keep the free plan; only the window walks the sort's index
    const freeWhere = [...sets.map(s => s.idSql), ...others];
    const freeWhereSql = freeWhere.length ? ` WHERE ${freeWhere.join(' AND ')}` : '';
    const countSql = `SELECT COUNT(*) n FROM characters c${joinSql}${freeWhereSql}`;
    // the same filter as a set of ids, for a write or a tally over exactly what the list answers
    const setSql = `SELECT c.id FROM characters c${joinSql}${freeWhereSql}`;
    // and as rowids, to meet an index that holds no id (the favourites')
    const setRowidSql = `SELECT c.rowid FROM characters c${joinSql}${freeWhereSql}`;

    // keyset cursor: O(page) at any scroll depth where offset is O(depth). Applied
    // only to the page query, never the total (total describes the filter set).
    let cursorSql = '';
    const cursorParams = [];
    if (opts.after && cursorable) {
        const cur = decodeCursor(opts.after);
        if (!cur) throw httpError(400, 'invalid after cursor');
        const expr = KEYSET_EXPRS[sort];
        const cmp = opts.order === 'desc' ? '<' : '>';
        // the leading k >= ? bound turns the scan into a seek; the OR only trims the tie
        cursorSql = ` AND ${expr} ${cmp}= ? AND (${expr} ${cmp} ? OR c.rowid ${cmp} ?)`;
        if (!where.length) cursorSql = cursorSql.replace(/^ AND/, ' WHERE');
        cursorParams.push(cur.sk, cur.sk, cur.rid);
    }

    const fields = Array.isArray(opts.fields) ? opts.fields : [];
    // the projection fields of the extensions this account has on, a lookup per page row
    const proj = projectionSelect(db);
    const rowSql = fields.some(f => NOTES_FIELDS.includes(f)) ? withNotes(LIST_SQL) : LIST_SQL;
    const listSql = proj.sql ? rowSql.replace('\n    FROM characters c', `${proj.sql}\n    FROM characters c`) : rowSql;

    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : null;
    const offset = limit && !cursorSql ? (Number.isInteger(opts.offset) && opts.offset > 0 ? opts.offset : 0) : 0;
    if (extSort) {
        return extSortQuery(extSort, { where, whereParams, others, idList, order, countSql, listSql, setsOnly, sort, limit, offset, extAliases: proj.aliases, fields });
    }
    const windowFrom = forcedIndex ? `characters c INDEXED BY ${forcedIndex}` : `characters c${joinSql}`;
    const pageParams = [...whereParams, ...cursorParams];
    // the rowid tiebreak sits on every index, so the walk never reads the row for it nor sorts a run of equal keys
    const orderSql = `ORDER BY ${sortKey} ${dir}, c.rowid ${dir}`;

    // idsOnly: id, fav, the sort key and any named set fields, skipping the tag subquery and the list row
    let idSql = `SELECT c.id, c.fav, c.rowid AS rid, ${sortKey} AS sk${fieldColumns(fields)} FROM ${windowFrom}${whereSql}${cursorSql} ${orderSql}`;
    const idParams = [...pageParams];
    if (limit) { idSql += ' LIMIT ? OFFSET ?'; idParams.push(limit, offset); }

    let pageSql;
    if (limit) {
        // deferred join: the window resolves on the index, then the projection runs on the page rows (OFFSET evaluates the select list per skipped row)
        const outerKey = sort === 'name' ? 'pg.sk COLLATE NOCASE' : 'pg.sk';
        const inner = `SELECT c.rowid AS rid, ${sortKey} AS sk FROM ${windowFrom}${whereSql}${cursorSql} ${orderSql} LIMIT ? OFFSET ?`;
        pageSql = `${listSql.replace('FROM characters c', `FROM characters c JOIN (${inner}) pg ON pg.rid = c.rowid`)}
            ORDER BY ${outerKey} ${dir}, c.rowid ${dir}`;
        pageParams.push(limit, offset);
    } else {
        pageSql = `${listSql.replace('FROM characters c', `FROM ${windowFrom}`)}${whereSql}${cursorSql} ${orderSql}`;
    }
    return { countSql, setSql, setRowidSql, whole: where.length === 0, pageSql, idSql, params: whereParams, pageParams, idParams, setsOnly, sort, order, limit, offset, cursorable, extAliases: proj.aliases, fields };
}

/**
 * A filter's characters as a set, exactly what the list answers; notIds adds less (the set without them, and the ids within it).
 * @returns {{ sql: string, rowidSql: string, params: any[], whole: boolean, less?: { base: object, gone: object } }}
 */
export function characterSetQuery(db, opts = {}) {
    const q = characterListQuery(db, { ...opts, sort: 'name', order: 'asc', after: undefined, limit: undefined, offset: undefined });
    const set = { sql: q.setSql, rowidSql: q.setRowidSql, params: q.params, whole: q.whole };
    if (opts.notIds?.length && !opts.ids?.length) {
        set.less = {
            base: characterSetQuery(db, { ...opts, notIds: undefined }),
            gone: characterSetQuery(db, { ...opts, notIds: undefined, ids: opts.notIds }),
        };
    }
    return set;
}

/**
 * How many a set holds and how many are favourites, neither reading a row: favourites meet the set's rowids on their partial index.
 * @param {{ sql: string, rowidSql: string, params: any[], whole?: boolean, less?: { base: object, gone: object } }} set
 * @returns {{ total: number, favorites: number }}
 */
export function tallyCharacters(db, set) {
    if (set.less) {
        const base = tallyCharacters(db, set.less.base);
        const gone = tallyCharacters(db, set.less.gone);
        return { total: base.total - gone.total, favorites: base.favorites - gone.favorites };
    }
    if (set.whole) {
        return { total: db.prepare('SELECT COUNT(*) n FROM characters').get().n, favorites: db.prepare('SELECT COUNT(*) n FROM characters c WHERE c.fav = 1').get().n };
    }
    const total = db.prepare(`SELECT COUNT(*) n FROM (${set.sql})`).get(...set.params).n;
    const favorites = total ? db.prepare(`SELECT COUNT(*) n FROM characters f INDEXED BY idx_characters_fav
        WHERE f.fav = 1 AND f.rowid IN (${set.rowidSql})`).get(...set.params).n : 0;
    return { total, favorites };
}

// the FTS tables a match is asked of; a name outside them is never put in the statement
const FTS_TABLES = ['characters_fts', 'chat_messages_fts'];

/** Refuse a match FTS5 cannot parse with a 400 carrying the parser's words, asked once before a list, tally or set write runs it. */
export function assertMatchQuery(db, match, table = 'characters_fts') {
    if (!FTS_TABLES.includes(table)) throw new Error(`assertMatchQuery: no FTS table named ${table}`);
    try { db.prepare(`SELECT 1 FROM ${table} WHERE ${table} MATCH ? LIMIT 1`).get(String(match)); }
    catch (e) { throw httpError(400, `invalid match query: ${e.message}`); }
}

// an extension sort in two segments: the valued walk forced on the extension's index, then the rest on the (name, id) index
function extSortQuery(door, q) {
    const dir = q.order.toUpperCase();
    const col = `xs.${door.column}`;
    const valued = ` WHERE ${[`${col} IS NOT NULL`, ...q.where].join(' AND ')}`;
    const unvalued = ` WHERE ${[...q.where, `NOT EXISTS (SELECT 1 FROM ${door.table} xs WHERE xs.${door.charColumn} = c.id AND ${col} IS NOT NULL)`].join(' AND ')}`;
    const seg1From = q.idList ? `${door.table} xs JOIN characters c ON c.id = xs.${door.charColumn}`
        : `${door.table} xs CROSS JOIN characters c INDEXED BY idx_characters_id_name ON c.id = xs.${door.charColumn}`;
    const seg2From = q.others.length === 0 && !q.idList ? 'characters c INDEXED BY idx_characters_name_id' : 'characters c';
    const splitSql = `SELECT COUNT(*) AS n FROM ${seg1From}${valued}`;
    return {
        countSql: q.countSql, params: q.whereParams, setsOnly: q.setsOnly, sort: q.sort, order: q.order,
        limit: q.limit, offset: q.offset, cursorable: false, extAliases: q.extAliases, fields: q.fields,
        ext: {
            seg1Sql: `SELECT c.id, c.fav, c.rowid AS rid${fieldColumns(q.fields)} FROM ${seg1From}${valued} ORDER BY ${col} ${dir}, xs.${door.tiebreak} ${dir} LIMIT ? OFFSET ?`,
            seg2Sql: `SELECT c.id, c.fav, c.rowid AS rid${fieldColumns(q.fields)} FROM ${seg2From}${unvalued} ORDER BY c.name COLLATE NOCASE ASC, c.id ASC LIMIT ? OFFSET ?`,
            splitSql,
            rowsSql: `${q.listSql} WHERE c.rowid IN (SELECT value FROM json_each(?))`,
            // the split depends on the filters, never on the direction
            shape: `${splitSql}\u0000${JSON.stringify(q.whereParams)}`,
        },
    };
}

// the valued segment from the offset, then the unvalued from where the page crosses the split, which that page learns
function extSortWindow(db, q) {
    const { ext, params, limit, offset } = q;
    const want = limit ?? Infinity;
    let split = knownSplit(db, ext.shape);
    // a segment can be the whole library, so it is never spread into an argument list
    let rows = [];
    if (split === undefined || offset < split) {
        rows = db.prepare(ext.seg1Sql).all(...params, limit ?? -1, offset);
        if (rows.length < want) {
            split = rows.length || !offset ? offset + rows.length : db.prepare(ext.splitSql).get(...params).n;
            rememberSplit(db, ext.shape, split);
        }
    }
    if (rows.length < want) {
        for (const r of db.prepare(ext.seg2Sql).all(...params, limit === null ? -1 : want - rows.length, Math.max(0, offset - split))) rows.push(r);
    }
    return rows;
}

// relevance ranks every match (bm25 then a sort), so it ranks at most this many and refuses a broader set first
export const RELEVANCE_MAX = 10000;

/**
 * The one place list querying happens: filters, sort and windowing in SQL, every clause param-bound.
 * @returns {{items, total, limit, offset, sort, order}}
 */
export function queryCharacters(db, opts = {}) {
    const q = characterListQuery(db, opts);
    if (q.sort === 'relevance' && db.prepare(`SELECT COUNT(*) n FROM (${q.setSql} LIMIT ?)`).get(...q.params, RELEVANCE_MAX + 1).n > RELEVANCE_MAX) {
        throw httpError(400, `sort=relevance ranks at most ${RELEVANCE_MAX} characters, and this match holds more: narrow the match or the filter, or sort by another key`);
    }
    // the count leg dominates broad queries at scale; count:false skips it and
    // scroll clients lean on nextCursor for "has more"
    const total = opts.count === false ? null : db.prepare(q.countSql).get(...q.params).n;
    if (q.ext) {
        // offset-only and walked in two segments: a whole library of it is minutes of one request
        if (q.limit === null) throw httpError(400, `an extension's sort answers a page: give ${q.sort} a limit`);
        const window = extSortWindow(db, q);
        const page = { total, limit: q.limit, offset: q.offset, sort: q.sort, order: q.order, nextCursor: null };
        if (opts.idsOnly) return { items: window.map(r => idsOnlyItem(r, q.fields)), ...page, idsOnly: true };
        const byRid = new Map(db.prepare(q.ext.rowsSql).all(JSON.stringify(window.map(r => r.rid))).map(r => [r.rid, r]));
        return { items: window.map(r => rowToListItem(byRid.get(r.rid), q.extAliases, q.fields)), ...page };
    }
    if (opts.idsOnly) {
        const rows = db.prepare(q.idSql).all(...q.idParams);
        const items = rows.map(r => idsOnlyItem(r, q.fields));
        const last = rows[rows.length - 1];
        const nextCursor = q.limit && q.cursorable && rows.length === q.limit ? encodeCursor(last.sk ?? 0, last.rid) : null;
        return { items, total, limit: q.limit, offset: q.offset, sort: q.sort, order: q.order, nextCursor, idsOnly: true };
    }
    const rows = db.prepare(q.pageSql).all(...q.pageParams);
    const items = rows.map(r => rowToListItem(r, q.extAliases, q.fields));
    const last = rows[rows.length - 1];
    const nextCursor = q.limit && q.cursorable && rows.length === q.limit
        ? encodeCursor(CURSOR_FIELD[q.sort](items[items.length - 1]), last.rid)
        : null;
    return { items, total, limit: q.limit, offset: q.offset, sort: q.sort, order: q.order, nextCursor };
}

// the notes whole and their plain excerpt (the grid's tooltip) ride a row only when its reader names them
function rowToListItem(row, extAliases = [], fields = []) {
    const links = JSON.parse(row.links || '[]');
    const item = {
        id: row.id,
        name: row.name,
        creator: row.creator,
        nickname: row.nickname,
        characterVersion: row.character_version,
        ...(fields.includes('creatorNotesExcerpt') ? { creatorNotesExcerpt: excerptOf(row.creator_notes) } : {}),
        ...(fields.includes('creatorNotes') ? { creatorNotes: row.creator_notes } : {}),
        fav: !!row.fav,
        updateLocked: !!row.update_locked,
        mediaLocalized: !!row.media_localized,
        loreDismissed: !!row.lore_dismissed,
        tokenEstimate: row.token_estimate,
        tags: JSON.parse(row.tags || '[]'),
        playlists: JSON.parse(row.playlists || '[]'),
        links,
        providers: links.map(l => l.providerId),
        createdAt: row.created_at,
        importedAt: row.imported_at,
        updatedAt: row.updated_at,
        avatarUrl: `/avatars/${row.id}.png`,
    };
    // an extension's projection fields, ext.<owner>.<key>; a character with no value reads null
    if (extAliases.length) {
        item.ext = {};
        for (const alias of extAliases) {
            const [, owner, key] = alias.split(':');
            (item.ext[owner] ??= {})[key] = row[alias] ?? null;
        }
    }
    return item;
}

// mes_example deliberately excluded, matching the frontend's historical estimate
const TOKEN_FIELDS = ['description', 'personality', 'scenario', 'first_mes', 'system_prompt'];

export function computeTokenEstimate(data) {
    let total = 0;
    for (const f of TOKEN_FIELDS) {
        const v = data?.[f];
        if (typeof v === 'string') total += v.length;
    }
    return Math.round(total / 4);
}

const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

// Dot-path write into card.data; null deletes the leaf key.
function setPath(obj, path, value) {
    const keys = String(path).split('.');
    if (keys.some(k => !k || UNSAFE_SEGMENTS.has(k))) throw httpError(400, `invalid field path: ${path}`);
    const last = keys.pop();
    let target = obj;
    for (const k of keys) {
        if (target[k] == null || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {};
        target = target[k];
    }
    if (value === null) delete target[last];
    else target[last] = value;
}

// the ids of a JSON list no character holds: one key probe per id, never a read of the table
export const UNKNOWN_IDS_SQL = 'SELECT j.value AS id FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM characters c WHERE c.id = j.value)';

// the op-state flags a write names, as [column, 0 or 1] pairs
function flagColumns(flags) {
    const out = [];
    if (typeof flags.fav === 'boolean') out.push(['fav', flags.fav ? 1 : 0]);
    if (typeof flags.mediaLocalized === 'boolean') out.push(['media_localized', flags.mediaLocalized ? 1 : 0]);
    if (typeof flags.loreDismissed === 'boolean') out.push(['lore_dismissed', flags.loreDismissed ? 1 : 0]);
    if (!out.length) throw httpError(400, 'at least one flag required');
    return out;
}

/**
 * Bulk op-state flag write over named ids, touching only rows whose value changes, so a count says what moved; a flag never moves updated_at.
 * @param {object} target { ids: string[] }; the whole library is a set job over flagMoversSet
 * @param {object} flags { fav?: boolean, mediaLocalized?: boolean, loreDismissed?: boolean }
 * @returns {{ touched: number, affected: string[], skipped: string[] }}
 */
export function setCharacterFlags(db, { ids } = {}, flags = {}) {
    if (!Array.isArray(ids)) throw httpError(400, 'setCharacterFlags names its characters by ids; a flag over the library runs as a set job');
    const pairs = flagColumns(flags);
    const cols = pairs.map(([c]) => `${c} = ?`);
    const vals = pairs.map(([, v]) => v);
    const affected = [];
    const skipped = [];
    let touched = 0;
    const moved = pairs.map(([c]) => `${c} != ?`).join(' OR ');
    db.transaction(() => {
        const named = [...new Set(ids.map(String))];
        const list = JSON.stringify(named);
        const wrote = new Set(db.prepare(`UPDATE characters SET ${cols.join(', ')} WHERE id IN (SELECT value FROM json_each(?)) AND (${moved}) RETURNING id`)
            .all(...vals, list, ...vals).map(r => r.id));
        for (const id of named) if (wrote.has(id)) affected.push(id);
        for (const r of db.prepare(UNKNOWN_IDS_SQL).all(list)) skipped.push(r.id);
        touched = affected.length;
        // a selection's whole list would ride every socket: past the record cap it reads as all
        if (touched) reportCharactersUpdated(db, affected, Object.keys(flags));
    })();
    return { touched, affected, skipped };
}

/**
 * The characters a flag write would move, as a set for a job: equality on the other value, so a reset walks its partial index.
 * @returns {{ sql: string, params: number[], whole: false }}
 */
export function flagMoversSet(flags) {
    const pairs = flagColumns(flags);
    return { sql: `SELECT id FROM characters WHERE ${pairs.map(([c]) => `${c} = ?`).join(' OR ')}`, params: pairs.map(([, v]) => 1 - v), whole: false };
}

// a card's data root keys: the V2 and V3 fields plus extensions. an import keeps any key, the PATCH refuses a mistyped one
export const CARD_ROOT_FIELDS = new Set([
    'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes',
    'system_prompt', 'post_history_instructions', 'alternate_greetings', 'character_book', 'tags',
    'creator', 'character_version', 'extensions',
    'nickname', 'group_only_greetings', 'assets', 'source', 'creation_date', 'modification_date',
    'creator_notes_multilingual',
]);

/**
 * A partial update (null: unknown id): card dot-paths, null deleting, and flag columns. Only what moves is written; only card content moves updated_at.
 */
export function patchCharacter(db, id, { fields = {}, fav, mediaLocalized, loreDismissed } = {}) {
    for (const fieldPath of Object.keys(fields)) {
        const root = String(fieldPath).split('.')[0];
        if (!CARD_ROOT_FIELDS.has(root)) {
            throw httpError(400, `unknown card field '${fieldPath}': a card's root keys are ${[...CARD_ROOT_FIELDS].join(', ')}; custom data belongs under extensions`, { refusedField: fieldPath });
        }
    }
    const row = db.prepare('SELECT card, fav, update_locked, media_localized, lore_dismissed FROM characters WHERE id = ?').get(id);
    if (!row) return null;

    const card = JSON.parse(row.card);
    card.data = card.data || {};
    // as JSON.stringify writes it, so a card the patch leaves as it was compares equal whatever wrote the row
    const storedJson = JSON.stringify(card);
    // the stored card with only the lifts a relink makes: a lift is the link's data moving, never an edit of the card
    const lifted = JSON.parse(storedJson);

    // one transaction: the divert legs and the card and tags write land together, so a mid-patch throw leaves nothing half applied
    db.transaction(() => {
        let newTags = null;
        let newLocked = row.update_locked;
        let favFromFields;
        // the diverted keys whose rows changed
        const moved = new Set();
        for (const [fieldPath, value] of Object.entries(fields)) {
            // update_locked and fav are library op-state: columns, never card content
            if (fieldPath === 'extensions.update_locked') {
                newLocked = value ? 1 : 0;
                continue;
            }
            if (fieldPath === 'extensions.fav') {
                favFromFields = value === true || value === 'true' ? 1 : 0;
                continue;
            }
            // provider namespaces are rows, never card content, so their writes divert (NS_SEGMENT keeps a registered one from slipping past)
            const nsMatch = fieldPath.match(NS_FIELD_RE);
            if (nsMatch && PROVIDER_NAMESPACES.includes(nsMatch[1])) {
                // a cross-provider relink destroys the old row, so its display fields lift into cl first; an explicit null unlink is the caller's call
                if (!nsMatch[2] && value && typeof value === 'object') {
                    const olds = db.prepare('SELECT data FROM provider_links WHERE char_id = ? AND provider_id != ?').all(id, nsMatch[1]);
                    for (const o of olds) { liftDisplayFields(card, o.data); liftDisplayFields(lifted, o.data); }
                }
                if (applyProviderLinkPatch(db, id, nsMatch[1], nsMatch[2] || null, value)) moved.add(fieldPath);
                continue;
            }
            // the primary world link is a char_worlds row (unified model); '' or null unlinks
            if (fieldPath === 'extensions.world') {
                if (setHeadWorld(db, id, typeof value === 'string' ? value.trim() : '')) moved.add(fieldPath);
                continue;
            }
            // tags are relational-only; the stored card never carries them
            if (fieldPath === 'tags') {
                newTags = (Array.isArray(value) ? value : [])
                    .map(t => String(t).trim()).filter(Boolean);
                continue;
            }
            setPath(card.data, fieldPath, value);
        }
        delete card.data.tags;

        const newFav = fav === undefined ? (favFromFields ?? row.fav) : (fav ? 1 : 0);
        const newMedia = mediaLocalized === undefined ? row.media_localized : (mediaLocalized ? 1 : 0);
        const newLore = loreDismissed === undefined ? row.lore_dismissed : (loreDismissed ? 1 : 0);
        oneLineName(card);
        // the table refuses this too (CHECK), but by name: a nameless card has no sort key for the cursor
        if (typeof card.data.name !== 'string') {
            throw httpError(400, 'name must be a string; a card cannot lose its name');
        }
        if (newTags !== null && replaceTagLinks(db, id, newTags)) moved.add('tags');
        const cardJson = JSON.stringify(card);
        const cardMoved = cardJson !== storedJson;
        delete lifted.data.tags;
        oneLineName(lifted);
        const contentMoved = cardMoved && cardContentHash(card) !== cardContentHash(lifted);
        const flagMoved = { fav: newFav !== row.fav, update_locked: newLocked !== row.update_locked, media_localized: newMedia !== row.media_localized, lore_dismissed: newLore !== row.lore_dismissed };

        const sets = [];
        const vals = [];
        if (cardMoved) {
            sets.push('card = ?', 'token_estimate = ?', 'content_hash = ?');
            vals.push(cardJson, computeTokenEstimate(card.data), cardContentHash(card));
        }
        for (const [col, value] of [['fav', newFav], ['update_locked', newLocked], ['media_localized', newMedia], ['lore_dismissed', newLore]]) {
            if (flagMoved[col]) { sets.push(`${col} = ?`); vals.push(value); }
        }
        // the card's own content alone moves the stamp: tags, the link and the lorebook are rows, flags op state
        if (contentMoved) { sets.push('updated_at = ?'); vals.push(Date.now()); }
        if (!sets.length && !moved.size) return;
        if (sets.length) db.prepare(`UPDATE characters SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);

        // the record names what moved: a card path when the card did, a diverted key when its rows did, a flag when its column did
        const flagOfKey = { 'extensions.fav': 'fav', 'extensions.update_locked': 'update_locked' };
        const named = Object.keys(fields).filter(k => (flagOfKey[k] ? flagMoved[flagOfKey[k]] : moved.has(k) || (cardMoved && !isDivertedKey(k))));
        for (const [key, col] of [['fav', 'fav'], ['mediaLocalized', 'media_localized'], ['loreDismissed', 'lore_dismissed']]) {
            if (({ fav, mediaLocalized, loreDismissed })[key] !== undefined && flagMoved[col]) named.push(key);
        }
        emitChange(db, { entity: 'character', op: 'updated', ids: [id], fields: named });
    })();
    return getCharacter(db, id);
}

// a PATCH key that writes rows or a column instead of the card
function isDivertedKey(fieldPath) {
    if (fieldPath === 'tags' || fieldPath === 'extensions.world' || fieldPath === 'extensions.fav' || fieldPath === 'extensions.update_locked') return true;
    const nsMatch = fieldPath.match(NS_FIELD_RE);
    return !!(nsMatch && PROVIDER_NAMESPACES.includes(nsMatch[1]));
}

// one ordered list of linked worlds per character; the head is what extensions.world carries in an export
export function getHeadWorld(db, charId) {
    return headWorldFor(db, 'char', charId);
}

/** @returns {boolean} whether the character's list changed */
export function setHeadWorld(db, charId, name) {
    return setHeadWorldFor(db, 'char', charId, name);
}

/** A cheap existence probe for bulk routes that must not compose a card per id. */
export function characterExists(db, id) {
    return !!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(id);
}

/** The ids of a list the library holds, in one query: a bulk route's probe, never one per id. @returns {Set<string>} */
export function existingCharacterIds(db, ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
    if (!list.length) return new Set();
    return new Set(db.prepare('SELECT value FROM json_each(?) WHERE value IN (SELECT id FROM characters)').pluck().all(JSON.stringify(list)));
}

// a link destroyed without an unlink keeps its tagline and pageName in cl, only-if-absent, so a real cl value is never clobbered
function liftDisplayFields(card, rowDataJson) {
    let data;
    try { data = typeof rowDataJson === 'string' ? JSON.parse(rowDataJson) : rowDataJson; } catch { return; }
    if (!data || typeof data !== 'object') return;
    card.data.extensions = card.data.extensions || {};
    const cl = card.data.extensions.cl = card.data.extensions.cl || {};
    if (typeof data.tagline === 'string' && data.tagline && !('tagline' in cl)) cl.tagline = data.tagline;
    if (typeof data.pageName === 'string' && data.pageName && !('pageName' in cl)) cl.pageName = data.pageName;
}

/** @returns {boolean} whether any link row changed */
function applyProviderLinkPatch(db, charId, ns, subPath, value) {
    const existing = db.prepare('SELECT external_id, full_path, page_name, linked_at, data FROM provider_links WHERE char_id = ? AND provider_id = ?').get(charId, ns);

    if (!subPath) {
        // whole-namespace write: null unlinks, an object (re)links
        if (value === null) {
            return db.prepare('DELETE FROM provider_links WHERE char_id = ? AND provider_id = ?').run(charId, ns).changes > 0;
        }
        if (!value || typeof value !== 'object') throw httpError(400, `provider link for ${ns} must be an object or null`);
        // one link per character: linking is REPLACING (the unique index backs this up)
        const replaced = db.prepare('DELETE FROM provider_links WHERE char_id = ? AND provider_id != ?').run(charId, ns).changes > 0;
        return writeLinkRow(db, charId, buildLinkRow(ns, value), existing) || replaced;
    }

    // a nested write lands inside the link's data and needs the row to exist: a fragment never mints or steals a card's identity
    if (!existing) {
        const other = db.prepare('SELECT provider_id FROM provider_links WHERE char_id = ?').get(charId);
        const why = other ? `this character is linked to ${other.provider_id}` : 'this character has no link';
        throw httpError(400, `cannot write extensions.${ns}.${subPath}: ${why}; link whole or unlink first`);
    }
    const data = JSON.parse(existing.data);
    setPath(data, subPath, value);
    return writeLinkRow(db, charId, buildLinkRow(ns, data), existing);
}

// the stored row as its columns read, data as JSON.stringify writes it, so a row the write would leave as it is compares equal
function sameLinkRow(old, link) {
    if (!old) return false;
    let data;
    try { data = JSON.stringify(JSON.parse(old.data)); } catch { return false; }
    return old.external_id === (link.externalId ?? null) && old.full_path === (link.fullPath ?? null)
        && old.page_name === (link.pageName ?? null) && old.linked_at === (link.linkedAt ?? null) && data === JSON.stringify(link.data);
}

// existing: the row as it stands, when the caller read it; a write that would leave it as it is is no write
function writeLinkRow(db, charId, link, existing = null) {
    if (sameLinkRow(existing, link)) return false;
    db.prepare(`
        INSERT INTO provider_links (char_id, provider_id, external_id, full_path, page_name, linked_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(char_id, provider_id) DO UPDATE SET
            external_id = excluded.external_id, full_path = excluded.full_path,
            page_name = excluded.page_name, linked_at = excluded.linked_at, data = excluded.data
    `).run(charId, link.providerId, link.externalId ?? null, link.fullPath ?? null,
        link.pageName ?? null, link.linkedAt ?? null, JSON.stringify(link.data));
    return true;
}

// the cards one promotion page holds in memory, and writes in one transaction
export const PROMOTE_PAGE = 500;

// a newly known namespace's blob copies move to rows once per home, or the first diverted write mints a sparse row shadowing them
export function promoteKnownNamespaces(db) {
    let done;
    try { done = JSON.parse(db.prepare("SELECT value FROM app_store WHERE key = 'promoted_namespaces'").get()?.value || '[]'); }
    catch { done = []; }
    const doneSet = new Set(Array.isArray(done) ? done : []);
    const pending = PROVIDER_NAMESPACES.filter(ns => !doneSet.has(ns));
    if (!pending.length) return;
    let moved = 0;
    // one pass, not one per namespace; the LIKE only has to be a superset, the parse decides
    const where = pending.map(() => 'card LIKE ?').join(' OR ');
    const page = db.prepare(`SELECT rowid AS rid, id, card FROM characters WHERE rowid > ? AND (${where}) ORDER BY rowid LIMIT ?`);
    const likes = pending.map(ns => `%"${ns}"%`);
    // a page is read and written in one transaction, so a crash between pages leaves no marker and the next open finishes the rest
    const promotePage = db.transaction((after) => {
        const rows = page.all(after, ...likes, PROMOTE_PAGE);
        for (const row of rows) {
            let card;
            // an unparsable blob must not brick boot forever; it stays put and heals on
            // its next write, same stance as the content-hash migration
            try { card = JSON.parse(row.card); } catch { continue; }
            let touched = false;
            // one link per character: a char with a row keeps it, and a blob with two known namespaces mints only the first
            let hasLink = !!db.prepare('SELECT 1 FROM provider_links WHERE char_id = ?').get(row.id);
            for (const ns of pending) {
                const val = card.data?.extensions?.[ns];
                if (val === undefined) continue;
                if (!hasLink && val && typeof val === 'object') {
                    writeLinkRow(db, row.id, buildLinkRow(ns, val));
                    hasLink = true;
                } else if (val && typeof val === 'object') {
                    // dropped without minting (the char has a link): its display
                    // fields survive into cl like any implicit destruction
                    liftDisplayFields(card, val);
                }
                delete card.data.extensions[ns];
                touched = true;
            }
            if (!touched) continue;
            moved++;
            // storage-shape move, not a user edit: updated_at stays put
            db.prepare('UPDATE characters SET card = ?, content_hash = ? WHERE id = ?')
                .run(JSON.stringify(card), cardContentHash(card), row.id);
        }
        return rows.length === PROMOTE_PAGE ? rows[rows.length - 1].rid : null;
    });
    for (let after = 0; after !== null;) after = promotePage(after);
    for (const ns of pending) doneSet.add(ns);
    db.transaction(() => {
        db.prepare("INSERT OR REPLACE INTO app_store (key, value, updated_at) VALUES ('promoted_namespaces', ?, ?)")
            .run(JSON.stringify([...doneSet]), Date.now());
    })();
    if (moved) console.log(`[db] promoted provider-namespace blobs to rows on ${moved} character(s) (${pending.join(', ')})`);
}

/** Report a character's new picture in a transaction of its own, where a store guard can refuse it before the file is replaced. */
export function reportAvatarChange(db, id) {
    db.transaction(() => emitChange(db, { entity: 'character', op: 'updated', ids: [id], fields: ['avatar'] }))();
}

/**
 * Delete a character, its rows cascading; answers the cascaded media ids, read before the delete, so their thumbs die too.
 * @returns {{mediaIds: number[]}|null} null when the id is unknown
 */
export function deleteCharacter(db, paths, id) {
    const { deleted, mediaIds } = deleteCharacters(db, paths, [id]);
    return deleted.length ? { mediaIds: mediaIds.get(id) } : null;
}

// the cascade costs milliseconds a character at scale, so a set deletes in chunks with other work between them
export const DELETE_MAX = 100;

/**
 * Delete several characters in ONE transaction, reported as one deleted record naming every id, the name preferences pruned with it.
 * @returns {{deleted: string[], missing: string[], mediaIds: Map<string, number[]>}}
 */
export function deleteCharacters(db, paths, ids) {
    const out = db.transaction(() => {
        const deleted = [], missing = [], mediaIds = new Map(), chatPictures = [];
        const mediaOf = db.prepare('SELECT id FROM media WHERE char_id = ?');
        const chatsOf = db.prepare('SELECT id FROM chats WHERE char_id = ?').pluck();
        const studiosOf = db.prepare('SELECT id FROM studio_sessions WHERE char_id = ?').pluck();
        const del = db.prepare('DELETE FROM characters WHERE id = ?');
        for (const id of ids) {
            const media = mediaOf.all(id).map(r => r.id);
            // its chats' galleries and its studio sessions' pictures, read before the cascade takes their rows
            const held = attachmentsHeldBy(db, { chatIds: chatsOf.all(id), studioIds: studiosOf.all(id) });
            if (!del.run(id).changes) { missing.push(id); continue; }
            deleted.push(id);
            mediaIds.set(id, media);
            chatPictures.push(...held);
        }
        if (deleted.length) {
            emitChange(db, { entity: 'character', op: 'deleted', ids: deleted });
            forgetNamePreferences(db, deleted);
        }
        return { deleted, missing, mediaIds, chatPictures };
    })();
    // the files go once the rows are gone for good: the picture, its thumbs, the gallery and its thumbs, its chats' and sessions' pictures
    for (const id of out.deleted) {
        try { fs.unlinkSync(path.join(paths.avatarsDir, `${id}.png`)); } catch { /* none stored */ }
        invalidateAvatarThumbs(paths.avatarThumbsDir, id);
        deleteAllMediaFiles(paths, id);
        for (const mid of out.mediaIds.get(id) || []) invalidateMediaThumbs(paths.mediaThumbsDir, mid);
    }
    removeAttachmentFiles(paths, out.chatPictures);
    delete out.chatPictures;
    return out;
}

// namePreferences is keyed by character id and no FK reaches it, so the delete takes the keys with it
function forgetNamePreferences(db, ids) {
    const prefs = settingValue(db, 'namePreferences', {});
    if (typeof prefs !== 'object' || Array.isArray(prefs)) return;
    const held = ids.filter(id => Object.hasOwn(prefs, id));
    if (!held.length) return;
    for (const id of held) delete prefs[id];
    patchSettings(db, { namePreferences: prefs });
}

// every cut of the candidate before a boundary, four chars or longer: "Scar - The Dark King" asks "Scar", "Scar -", "Scar - The Dark"
const NAME_BOUNDARY = [' ', '-', '|', ':', ',', '.'];
function wordStems(name) {
    const out = new Set();
    for (let i = 4; i < name.length; i++) {
        if (!NAME_BOUNDARY.includes(name[i])) continue;
        const stem = name.slice(0, i).trim();
        if (stem.length >= 4 && stem !== name) out.add(stem);
    }
    return [...out];
}

/**
 * "Who could this be": per name, characters and listing page names equal to it, starting with it as a word, or a word-prefix of it.
 * @returns {Array<{matches: Array<{id: string, name: string, creator: string|null}>}>}
 */
export function matchCharactersByName(db, names) {
    // "starts with name + boundary" as a NOCASE index range: the bounds take the name as written, where a LIKE would need escaping
    const byName = db.prepare('SELECT id, name, creator FROM characters WHERE name = ? COLLATE NOCASE LIMIT 16');
    const byPrefix = db.prepare('SELECT id, name, creator FROM characters WHERE name >= ? COLLATE NOCASE AND name < ? COLLATE NOCASE LIMIT 8');
    const byListing = db.prepare('SELECT c.id, pl.page_name AS name, c.creator FROM provider_links pl JOIN characters c ON c.id = pl.char_id WHERE pl.page_name = ? COLLATE NOCASE LIMIT 16');
    const byListingPrefix = db.prepare('SELECT c.id, pl.page_name AS name, c.creator FROM provider_links pl JOIN characters c ON c.id = pl.char_id WHERE pl.page_name >= ? COLLATE NOCASE AND pl.page_name < ? COLLATE NOCASE LIMIT 8');
    return names.map(raw => {
        const name = typeof raw === 'string' ? raw.trim() : '';
        if (!name) return { matches: [] };
        const seen = new Map();
        const take = (rows) => { for (const row of rows) { const k = `${row.id}|${row.name}`; if (!seen.has(k)) seen.set(k, row); } };
        const stems = wordStems(name);
        for (const [exact, prefix] of [[byName, byPrefix], [byListing, byListingPrefix]]) {
            take(exact.all(name));
            for (const b of NAME_BOUNDARY) take(prefix.all(`${name}${b}`, `${name}${b}￿`));
            for (const s of stems) take(exact.all(s));
        }
        return { matches: [...seen.values()] };
    });
}

/** The providers the link rows name: a seek per provider on the lookup index, never a read of every link. */
export function linkedProviderIds(db) {
    return db.prepare(`
        WITH RECURSIVE p(id) AS (
            SELECT (SELECT MIN(provider_id) FROM provider_links)
            UNION ALL
            SELECT (SELECT MIN(provider_id) FROM provider_links WHERE provider_id > p.id) FROM p WHERE p.id IS NOT NULL
        ) SELECT id FROM p WHERE id IS NOT NULL`).all().map(r => r.id);
}

/** Which remote keys are linked here: external_id, or full_path case-insensitively; matching INPUT keys in input order, each arm on its index. */
export function probeProviderLinks(db, { providers, keys }) {
    const provs = JSON.stringify([...new Set((providers || []).map(String))]);
    const wanted = [...new Set((keys || []).map(String))];
    if (!wanted.length || provs === '[]') return [];
    const found = new Set(db.prepare(`
        SELECT k.value AS key FROM json_each(?) k
        WHERE EXISTS (SELECT 1 FROM provider_links pl WHERE pl.provider_id IN (SELECT value FROM json_each(?)) AND pl.external_id = k.value)
           OR EXISTS (SELECT 1 FROM provider_links pl WHERE pl.provider_id IN (SELECT value FROM json_each(?)) AND pl.full_path = k.value COLLATE NOCASE)`)
        .all(JSON.stringify(wanted), provs, provs).map(r => r.key));
    return wanted.filter(k => found.has(k));
}

// the owners probe's exact arm: a key on external_id, or on full_path case-insensitively
export const PROVIDER_OWNERS_EXACT_SQL = `
        SELECT char_id, provider_id, external_id, full_path FROM provider_links
        WHERE provider_id IN (SELECT value FROM json_each(?)) AND external_id = ?
        UNION
        SELECT char_id, provider_id, external_id, full_path FROM provider_links
        WHERE provider_id IN (SELECT value FROM json_each(?)) AND full_path = ? COLLATE NOCASE
        ORDER BY provider_id, char_id`;

// the loose arms, a path prefix either way, each a seek on idx_provider_links_path
export const PROVIDER_OWNERS_LOOSE_SQL = {
    begins: `
        SELECT char_id, provider_id, external_id, full_path FROM provider_links
        WHERE provider_id IN (SELECT value FROM json_each(?)) AND full_path >= ? COLLATE NOCASE AND full_path < ? COLLATE NOCASE
        ORDER BY provider_id, char_id`,
    begun: `
        SELECT char_id, provider_id, external_id, full_path FROM provider_links
        WHERE provider_id IN (SELECT value FROM json_each(?)) AND full_path COLLATE NOCASE IN (SELECT value FROM json_each(?))
        ORDER BY provider_id, char_id`,
};
export const UUID_KEY = UUID_RE;

/** Every provider path two or more characters are linked to, folded as the path index folds it: one pass of that index. */
export function providerPathGroups(db) {
    return db.prepare(`SELECT provider_id, MIN(full_path) AS full_path, json_group_array(char_id) AS ids FROM provider_links
        WHERE full_path IS NOT NULL AND full_path != '' GROUP BY provider_id, full_path COLLATE NOCASE HAVING COUNT(*) > 1`).all()
        .map(r => ({ providerId: r.provider_id, fullPath: r.full_path, charIds: JSON.parse(r.ids) }));
}

/** The link owners behind a probe, per key: exact rows, and with loose the path-prefix rows either way; numeric and uuid keys match exactly. */
export function probeProviderLinkOwners(db, { providers, keys, loose = false }) {
    const provs = JSON.stringify([...new Set((providers || []).map(String))]);
    const wanted = [...new Set((keys || []).map(String))];
    if (!wanted.length || provs === '[]') return [];
    // the two exact arms apart, each on its own index: under one OR neither index served and every link was read per key
    const exact = db.prepare(PROVIDER_OWNERS_EXACT_SQL);
    const begins = db.prepare(PROVIDER_OWNERS_LOOSE_SQL.begins);
    const begun = db.prepare(PROVIDER_OWNERS_LOOSE_SQL.begun);
    const out = [];
    for (const key of wanted) {
        const seen = new Set();
        const push = (r, isExact) => {
            const k = `${r.provider_id}|${r.char_id}`;
            if (seen.has(k)) return;
            seen.add(k);
            out.push({ key, charId: r.char_id, providerId: r.provider_id, externalId: r.external_id, fullPath: r.full_path, exact: isExact });
        };
        for (const r of exact.all(provs, key, provs, key)) push(r, true);
        if (loose && !/^\d+$/.test(key) && !UUID_KEY.test(key)) {
            const prefixes = [];
            for (let n = 1; n < key.length; n++) prefixes.push(key.slice(0, n));
            for (const r of [...begins.all(provs, key, `${key}\uffff`), ...begun.all(provs, JSON.stringify(prefixes))]) {
                if (!r.full_path || /^\d+$/.test(String(r.full_path))) continue;
                push(r, false);
            }
        }
    }
    return out;
}

/** The interchange card for export: the composed card plus cl.uid, the one portable id; library metadata stays out. */
export function buildExportCard(db, id, char = getCharacter(db, id)) {
    if (!char) return null;
    const card = char.card; // getCharacter already composed tags + provider links
    card.data.extensions = card.data.extensions || {};
    delete card.data.extensions.update_locked; // op-state mirror is for the app, not for exports
    // cl.uid is the ONE portable identity an export carries; re-imports heal through it
    card.data.extensions.cl = { ...(card.data.extensions.cl || {}), uid: id };
    return { card: runHook('card.export', card, { db, id }), name: char.card.data.name };
}

export function getCharacter(db, id) {
    const row = db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
    if (!row) return null;
    const tags = db.prepare(`
        SELECT t.name FROM char_tags ct JOIN tags t ON t.id = ct.tag_id
        WHERE ct.char_id = ? ORDER BY ct.pos
    `).all(id).map(r => r.name);
    const links = db.prepare('SELECT * FROM provider_links WHERE char_id = ?').all(id).map(l => ({
        providerId: l.provider_id,
        externalId: l.external_id,
        fullPath: l.full_path,
        pageName: l.page_name,
        linkedAt: l.linked_at,
        data: JSON.parse(l.data || 'null'),
    }));
    const card = JSON.parse(row.card);
    // compose tags + provider links + world link + op-state mirrors into the response
    // view; the STORED card carries none of them
    card.data = card.data || {};
    card.data.tags = tags;
    card.data.extensions = card.data.extensions || {};
    for (const l of links) card.data.extensions[l.providerId] = l.data;
    const primaryWorld = getHeadWorld(db, id);
    if (primaryWorld) card.data.extensions.world = primaryWorld;
    if (row.update_locked) card.data.extensions.update_locked = true;
    return {
        id: row.id,
        card,
        fav: !!row.fav,
        updateLocked: !!row.update_locked,
        mediaLocalized: !!row.media_localized,
        loreDismissed: !!row.lore_dismissed,
        tokenEstimate: row.token_estimate,
        tags,
        providerLinks: links,
        createdAt: row.created_at,
        importedAt: row.imported_at,
        updatedAt: row.updated_at,
        lastChatAt: row.last_chat_at ?? null,
        chatCount: row.chat_count,
        mediaCount: db.prepare('SELECT COUNT(*) n FROM media WHERE char_id = ?').get(id).n,
        playlists: db.prepare('SELECT playlist_id FROM playlist_chars WHERE char_id = ?').all(id).map(r => r.playlist_id),
        avatarUrl: `/avatars/${row.id}.png`,
    };
}

// the related query's arms, exported so their plans can be read; the tag arm starts at the tag index and never joins characters
export const RELATED_SQL = {
    source: 'SELECT rowid AS rid, id, name, creator, description, personality, scenario, first_mes FROM characters WHERE id = ?',
    posting: 'SELECT rowid FROM characters_fts WHERE characters_fts MATCH ? LIMIT ?',
    ranked: 'SELECT rowid AS rid, bm25(characters_fts) AS r FROM characters_fts WHERE characters_fts MATCH ? ORDER BY r LIMIT ?',
    idsOf: 'SELECT rowid AS rid, id FROM characters WHERE rowid IN (SELECT value FROM json_each(?))',
    sourceFolds: 'SELECT t.fold, t.name FROM char_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.char_id = ? ORDER BY ct.pos',
    foldTags: 'SELECT id, fold, char_count AS n FROM tags WHERE fold IN (SELECT value FROM json_each(?))',
    holders: 'SELECT char_id, tag_id FROM char_tags WHERE tag_id IN (SELECT value FROM json_each(?)) AND char_id != ?',
    tagMass: 'SELECT ct.char_id, t.char_count FROM char_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.char_id IN (SELECT value FROM json_each(?))',
    rows: 'SELECT id, name, creator FROM characters WHERE id IN (SELECT value FROM json_each(?))',
    creatorCount: 'SELECT COUNT(*) FROM characters WHERE creator COLLATE NOCASE IN (?, ?)',
};
const RELATED_COLUMNS = '{name description personality scenario first_mes}';
const RELATED = {
    textWeight: 0.65, tagWeight: 0.35, creatorBonus: 0.12, strong: 22, moderate: 14,
    // words asked about per card, words ranked, candidates kept per arm, copies listed per row, rows one creator may hold
    lookups: 150, picks: 30, pool: 300, copies: 10, perCreator: 5,
};
const PLACEHOLDER_CREATORS = new Set(['', 'anonymous', 'anon', 'unknown', 'none', 'n/a', 'na', '-', '?', 'null', 'undefined']);
const _relatedStmts = new WeakMap();
// a word's card count once past fifty, per library; dropped when the library's size moves a tenth
const _relatedWords = new WeakMap();

function relatedStmts(db) {
    let s = _relatedStmts.get(db);
    if (s) return s;
    s = Object.fromEntries(Object.entries(RELATED_SQL).map(([k, sql]) => [k, db.prepare(sql)]));
    s.posting.pluck();
    s.creatorCount.pluck();
    s.holders.raw();
    s.tagMass.raw();
    s.idsOf.raw();
    s.count = db.prepare('SELECT COUNT(*) FROM characters').pluck();
    _relatedStmts.set(db, s);
    return s;
}

const foldCreator = (c) => String(c || '').trim().replace(/^@+/, '').toLowerCase();
const foldName = (n) => String(n || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// the source's rarest words other cards share, ranked by bm25 over its own score; fills cands' content and terms
function relatedTextArm(db, S, src, N, cands, cand) {
    const raw = [src.name, src.description, src.personality, src.scenario, src.first_mes].filter(Boolean).join(' ')
        .normalize('NFKD').replace(/\p{M}/gu, '');
    const tf = new Map(), shown = new Map();
    for (const m of raw.matchAll(/[\p{L}\p{N}\p{Co}]{3,}/gu)) {
        const w = m[0].toLowerCase();
        if (w === 'char' || w === 'user' || /^\d+$/.test(w)) continue;
        tf.set(w, (tf.get(w) || 0) + 1);
        if (/^\p{Lu}/u.test(m[0]) && !shown.has(w)) shown.set(w, m[0]);
    }
    // the same words on every call: a capitalized one first, then the longest
    const asked = [...tf.keys()].sort((a, b) => (shown.has(b) - shown.has(a)) || (b.length - a.length) || (a < b ? -1 : 1)).slice(0, RELATED.lookups);
    const cap = Math.max(20, Math.min(Math.floor(N * 0.03), 2000));
    let cache = _relatedWords.get(db);
    if (!cache || Math.abs(cache.n - N) > cache.n * 0.1 || cache.df.size > 300000) {
        cache = { n: N, df: new Map() };
        _relatedWords.set(db, cache);
    }
    const match = (w) => `${RELATED_COLUMNS} : "${w}"`;
    const postings = new Map(), scored = [];
    // in term order, so a cold index is read in page order
    for (const w of [...asked].sort()) {
        let df = cache.df.get(w);
        if (df === undefined) {
            const rows = S.posting.all(match(w), cap + 1);
            df = rows.length > cap ? Infinity : rows.length;
            if (df > 50) cache.df.set(w, df);
            else postings.set(w, rows);
        }
        if (df >= 2 && df <= cap) scored.push({ w, df, s: Math.min(tf.get(w), 3) * Math.log(N / df) });
    }
    scored.sort((a, b) => b.s - a.s || (a.w < b.w ? -1 : 1));
    const chosen = scored.slice(0, RELATED.picks);
    if (!chosen.length) return false;
    const picks = chosen.map(p => p.w);
    // the source ranks in its own list: a bm25 read pinned to one rowid weighs the terms differently
    const rows = S.ranked.all(`${RELATED_COLUMNS} : (${picks.map(w => `"${w}"`).join(' OR ')})`, RELATED.pool + 1);
    const self = rows.find(r => r.rid === src.rid)?.r ?? rows[0]?.r;
    if (!(self < 0)) return false;
    const idOf = new Map(S.idsOf.all(JSON.stringify(rows.filter(r => r.rid !== src.rid).map(r => r.rid))));
    for (const r of rows) if (idOf.has(r.rid)) cand(idOf.get(r.rid)).content = Math.min(1, r.r / self);
    // a reason names the rarest shared words first
    for (const { w } of [...chosen].sort((a, b) => a.df - b.df || (a.w < b.w ? -1 : 1))) {
        for (const rid of postings.get(w) || S.posting.all(match(w), cap + 1)) {
            const id = idOf.get(rid);
            if (id) cands.get(id)?.terms.push(shown.get(w) || w);
        }
    }
    return true;
}

// spellings folded, each tag weighed ln(N / carriers), the overlap over the geometric mean of both cards' tag mass
function relatedTagArm(S, src, N, cands, cand) {
    const own = S.sourceFolds.all(src.id);
    if (!own.length) return false;
    const shownAs = new Map();
    for (const t of own) if (!shownAs.has(t.fold)) shownAs.set(t.fold, t.name);
    const tags = S.foldTags.all(JSON.stringify([...shownAs.keys()]));
    const carriers = new Map(), foldOf = new Map();
    for (const t of tags) { carriers.set(t.fold, (carriers.get(t.fold) || 0) + t.n); foldOf.set(t.id, t.fold); }
    const weight = (fold) => Math.log(N / Math.max(1, carriers.get(fold) || 1));
    const srcMass = [...shownAs.keys()].reduce((s, f) => s + weight(f), 0);
    if (!(srcMass > 0)) return false;
    // a tag on over a fifth of the library (and fifty characters) carries no signal and would fan the join out
    const carrierCap = Math.max(50, Math.floor(N * 0.2));
    const usable = tags.filter(t => carriers.get(t.fold) <= carrierCap).map(t => t.id);
    const shared = new Map();
    for (const [id, tagId] of S.holders.all(JSON.stringify(usable), src.id)) {
        let set = shared.get(id);
        if (!set) shared.set(id, set = new Set());
        set.add(foldOf.get(tagId));
    }
    const sumOf = (set) => { let s = 0; for (const f of set) s += weight(f); return s; };
    // a candidate's own tag mass is read for the strongest overlaps and the content arm's candidates alone
    const pool = [...shared].map(([id, set]) => [id, sumOf(set)]).sort((a, b) => b[1] - a[1]).slice(0, RELATED.pool).map(([id]) => id);
    const need = [...new Set([...pool, ...[...cands.keys()].filter(id => shared.has(id))])];
    const mass = new Map();
    for (const [id, n] of S.tagMass.all(JSON.stringify(need))) mass.set(id, (mass.get(id) || 0) + Math.log(N / Math.max(1, n)));
    for (const id of need) {
        const set = shared.get(id), sum = sumOf(set);
        const c = cand(id);
        c.tags = Math.min(1, sum / Math.sqrt(srcMass * Math.max(sum, mass.get(id) || sum)));
        c.shared = [...set].map(f => ({ tag: shownAs.get(f), weight: Math.round(weight(f) * 100) / 100, count: carriers.get(f) }))
            .sort((a, b) => b.weight - a.weight || (a.tag < b.tag ? -1 : 1));
    }
    return true;
}

/** Related characters: rarity-weighted shared words and tags on one scale, a small same-creator lift, one row per name with its copies. */
export function getRelatedCharacters(db, id, opts = {}) {
    const { limit = 20, useTags = true, useCreator = true, useContent = true } = opts;
    const S = relatedStmts(db);
    const src = S.source.get(id);
    if (!src) return null;
    const N = Math.max(2, S.count.get());
    const cands = new Map();
    const cand = (cid) => {
        let c = cands.get(cid);
        if (!c) cands.set(cid, c = { id: cid, content: 0, tags: 0, shared: [], terms: [] });
        return c;
    };
    const wText = useContent && relatedTextArm(db, S, src, N, cands, cand) ? RELATED.textWeight : 0;
    const wTags = useTags && relatedTagArm(S, src, N, cands, cand) ? RELATED.tagWeight : 0;
    if (!wText && !wTags) return { items: [] };
    const ranked = [...cands.values()].map(c => ({ ...c, score: (wText * c.content + wTags * c.tags) / (wText + wTags) })).filter(c => c.score > 0);

    // the creator lifts a match by less the more cards it has, a placeholder never; at most five of the list are its
    const rows = new Map(S.rows.all(JSON.stringify(ranked.map(r => r.id))).map(r => [r.id, r]));
    const srcCreator = foldCreator(src.creator);
    const realCreator = !PLACEHOLDER_CREATORS.has(srcCreator);
    const lift = realCreator && useCreator
        ? RELATED.creatorBonus * Math.max(0, 1 - Math.log(Math.max(1, S.creatorCount.get(srcCreator, `@${srcCreator}`))) / Math.log(N)) : 0;
    for (const r of ranked) {
        r.sameCreator = realCreator && foldCreator(rows.get(r.id)?.creator) === srcCreator;
        // uncapped here, so the lift still orders two matches that both reach the top
        if (r.sameCreator) r.score += lift;
    }
    ranked.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));

    // one row per folded name, its other copies listed under it
    const top = [], byName = new Map(), srcName = foldName(src.name);
    let sameCreatorShown = 0;
    for (const r of ranked) {
        const row = rows.get(r.id);
        if (!row) continue;
        const key = foldName(row.name);
        const held = key && byName.get(key);
        if (held) {
            if (held.copies.length < RELATED.copies) held.copies.push(r.id);
            continue;
        }
        if (top.length >= limit) continue;
        if (r.sameCreator && sameCreatorShown >= RELATED.perCreator) continue;
        if (r.sameCreator) sameCreatorShown++;
        const entry = { r, sameName: !!key && key === srcName, copies: [] };
        if (key) byName.set(key, entry);
        top.push(entry);
    }
    if (!top.length) return { items: [] };

    const { items } = queryCharacters(db, { ids: top.flatMap(t => [t.r.id, ...t.copies]), count: false });
    const byId = new Map(items.map(it => [it.id, it]));
    return {
        items: top.filter(t => byId.has(t.r.id)).map(({ r, sameName, copies }) => {
            const reasons = [];
            if (sameName) reasons.push('Another version of this character');
            if (r.terms.length) reasons.push(`Both mention ${r.terms.slice(0, 3).join(', ')}`);
            if (r.shared.length) reasons.push(`${r.shared.length === 1 ? 'Shared tag' : `${r.shared.length} shared tags`}: ${r.shared.slice(0, 3).map(t => t.tag).join(', ')}`);
            if (r.sameCreator) reasons.push(`Same creator: ${rows.get(r.id).creator}`);
            const score = Math.round(Math.min(1, r.score) * 100);
            return {
                score,
                strength: score >= RELATED.strong ? 'strong' : score >= RELATED.moderate ? 'moderate' : 'possible',
                breakdown: {
                    content: Math.round(r.content * 100), tags: Math.round(r.tags * 100), creator: r.sameCreator ? Math.round(lift * 100) : 0,
                    sharedTagCount: r.shared.length, topTags: r.shared.slice(0, 3), terms: r.terms.slice(0, 5),
                },
                matchReasons: reasons,
                character: byId.get(r.id),
                copies: copies.map(cid => byId.get(cid)).filter(Boolean),
            };
        }),
    };
}
