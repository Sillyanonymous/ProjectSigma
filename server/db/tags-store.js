// tags are two tables cards compose data.tags from: every verb is relation surgery, one transaction, no card rewrite
import { emitChange, reportCharactersUpdated } from './changes.js';
import { replaceTagLinks, appendTagLinks, tagIds } from './tag-links.js';
import { linkJournal, opsJournal, opRunState } from './tag-jobs-store.js';
import { encodeCursor, decodeCursor } from './cursor.js';
import { textMatch } from './rule-filters.js';
import { httpError } from '../lib/http-error.js';
import { rewritePresetRules, PRESET_TAG_FIELDS } from './documents-store.js';

function reportTagged(db, charIds) {
    reportCharactersUpdated(db, charIds, ['tags']);
}

// tag names as a route hands them: a list, each trimmed, blanks and repeats dropped; anything else is refused by name
function namesOf(list, label) {
    if (!Array.isArray(list)) throw httpError(400, `${label} must be an array of tag names`);
    return [...new Set(list.map(t => String(t).trim()).filter(Boolean))];
}

/**
 * The names a tag write takes: trimmed and deduped, something to do, and none both added and removed (case-blind).
 * @returns {{ add: string[], remove: string[] }}
 */
export function tagWriteNames(add = [], remove = []) {
    const addNames = namesOf(add, 'add');
    const removeNames = namesOf(remove, 'remove');
    if (!addNames.length && !removeNames.length) throw httpError(400, 'nothing to add or remove');
    const adding = new Set(addNames.map(n => n.toLowerCase()));
    const both = removeNames.filter(n => adding.has(n.toLowerCase()));
    if (both.length) throw httpError(400, `a tag cannot be added and removed at once: ${both.join(', ')}`);
    return { add: addNames, remove: removeNames };
}

export function findTag(db, name) {
    return db.prepare('SELECT id, name FROM tags WHERE name = ?').get(String(name)) || null;
}

// listTagCounts' statement, exported so its plan can be read: the most used order's own index, walked whole
export const TAG_COUNTS_SQL = 'SELECT name, char_count AS count FROM tags WHERE char_count > 0 ORDER BY char_count DESC, name COLLATE NOCASE';
/**
 * Tag names with their carrier counts, most used first, then by name.
 * @returns {Array<{name: string, count: number}>}
 */
export function listTagCounts(db) {
    return db.prepare(TAG_COUNTS_SQL).all().map(r => ({ name: r.name, count: r.count }));
}

// the orders a page walks, each on its own index; a cursor is its order's key tuple, refused by the other
export const TAG_SORTS = Object.assign(Object.create(null), {
    name: {
        order: 't.name COLLATE NOCASE',
        width: 1,
        seek: ([name]) => (typeof name === 'string' ? { sql: 't.name > ? COLLATE NOCASE', params: [name] } : null),
        key: (r) => [r.name],
    },
    count: {
        order: 't.char_count DESC, t.name COLLATE NOCASE',
        width: 2,
        seek: ([n, name]) => (Number.isInteger(n) && typeof name === 'string'
            ? { sql: 't.char_count <= ? AND (t.char_count < ? OR t.name > ? COLLATE NOCASE)', params: [n, n, name] } : null),
        key: (r) => [r.count, r.name],
    },
});

function tagSortOf(sort) {
    if (sort === undefined) return TAG_SORTS.name;
    if (!(sort in TAG_SORTS)) throw httpError(400, `sort must be one of: ${Object.keys(TAG_SORTS).join(', ')}`);
    return TAG_SORTS[sort];
}

/**
 * The page queryTags runs, exported so its plan can be read: the sort's own index, each tag with its stored carrier count.
 * @returns {{ sql: string, params: any[], countSql: string, countParams: any[] }}
 */
export function tagPageQuery({ q, limit, after, sort }) {
    // a tag with no carrier never outlives the write that left it (trg_char_tags_prune), so no filter reads the links
    const by = tagSortOf(sort);
    const conds = [];
    const params = [];
    if (q) { const m = textMatch('t.name', q); conds.push(m.sql); params.push(...m.params); }
    const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
    const pageConds = [...conds];
    const pageParams = [...params];
    if (after !== undefined) {
        const cur = decodeCursor(after, by.width);
        const seek = cur && by.seek(cur);
        if (!seek) throw httpError(400, 'invalid after cursor');
        pageConds.push(seek.sql);
        pageParams.push(...seek.params);
    }
    return {
        sql: `SELECT t.name, t.char_count AS count FROM tags t${pageConds.length ? ` WHERE ${pageConds.join(' AND ')}` : ''} ORDER BY ${by.order} LIMIT ?`,
        params: [...pageParams, limit],
        countSql: `SELECT COUNT(*) n FROM tags t${where}`,
        countParams: params,
    };
}

/**
 * A page of tags with their carrier counts past a cursor, A-Z or most used (sort: 'count'); q narrows, count: false skips the total.
 * @returns {{ items: Array<{name: string, count: number}>, total: number|null, limit: number, nextCursor: string|null }}
 */
export function queryTags(db, { q, limit, after, sort, count = true }) {
    const query = tagPageQuery({ q, limit, after, sort });
    const rows = db.prepare(query.sql).all(...query.params);
    const total = count === false ? null : db.prepare(query.countSql).get(...query.countParams).n;
    const items = rows.map(r => ({ name: r.name, count: r.count }));
    return { items, total, limit, nextCursor: rows.length === limit ? encodeCursor(tagSortOf(sort).key(items[items.length - 1])) : null };
}

// a tag's loose identity, case, spacing and punctuation folded: "post-apocalyptic" finds "Post Apocalyptic"
const looseKey = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Names snapped to the library's spelling (NOCASE name or loose key) with their counts; unknown ones come back known: false. Never mints.
 * @param {string[]} names
 * @returns {Array<{tag: string, known: boolean, count: number|null}>}
 */
export function resolveTagNames(db, names, { each = false } = {}) {
    // a tag's count is its stored carrier count, the one the list pages show, so a resolve reads no link
    const exact = db.prepare('SELECT id, name, char_count FROM tags WHERE name = ?');
    const counted = (t) => ({ name: t.name, count: t.char_count });
    let byLoose = null;
    const looseHit = (name) => {
        if (!byLoose) {
            byLoose = new Map();
            for (const t of db.prepare('SELECT id, name, char_count FROM tags').all()) {
                const k = looseKey(t.name);
                if (!k) continue;
                if (!byLoose.has(k)) byLoose.set(k, []);
                byLoose.get(k).push(t);
            }
        }
        const candidates = byLoose.get(looseKey(name)) || [];
        if (!candidates.length) return null;
        // spellings that fold alike: the most carried wins, as the library's own spelling
        return candidates.map(counted).sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))[0];
    };
    const byName = (name) => {
        const t = exact.get(name);
        return t ? counted(t) : null;
    };
    const seen = new Set();
    const out = [];
    for (const raw of Array.isArray(names) ? names : []) {
        const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
        // each: one answer per input in its place, blanks included, so a caller can map each back
        if (!name) { if (each) out.push({ tag: '', known: false, count: null }); continue; }
        const hit = byName(name) || looseHit(name);
        const tag = hit ? hit.name : name;
        const key = looseKey(tag) || tag.toLowerCase();
        if (!each) {
            if (seen.has(key)) continue;
            seen.add(key);
        }
        out.push(hit ? { tag, known: true, count: hit.count } : { tag, known: false, count: null });
    }
    return out;
}

/** Replace a character's tag list verbatim, in the given order; a list that leaves the names as they were is no write. */
export function setCharTags(db, charId, tags) {
    return db.transaction(() => {
        if (replaceTagLinks(db, charId, tags)) reportTagged(db, [charId]);
    })();
}

/** Additive sibling of setCharTags: the given tags join the ones already there; one that links nothing new is no write. */
export function addCharTags(db, charId, tags) {
    return db.transaction(() => {
        if (appendTagLinks(db, charId, tags)) reportTagged(db, [charId]);
    })();
}

/**
 * Rename a tag everywhere, a merge when the target name exists (NOCASE); a run journals every link moved. 404 for an unknown source.
 * @returns {{touched: number, merged: boolean, runId: number|null}}
 */
export function renameTag(db, from, to, { run } = {}) {
    const target = String(to).trim();
    if (!target) throw httpError(400, '{from, to} required');
    const src = findTag(db, from);
    if (!src) throw httpError(404, `no such tag: ${from}`);
    const dst = findTag(db, target);
    const merged = !!(dst && dst.id !== src.id);
    let affected = [];
    const state = run ? opRunState(db, run) : null;
    db.transaction(() => {
        const carriers = db.prepare('SELECT char_id, pos FROM char_tags WHERE tag_id = ?').all(src.id);
        affected = carriers.map(r => r.char_id);
        let alreadyHadTarget = [];
        if (merged) {
            alreadyHadTarget = db.prepare(`SELECT char_id FROM char_tags WHERE tag_id = ? AND char_id IN
                (SELECT char_id FROM char_tags WHERE tag_id = ?)`).all(dst.id, src.id).map(r => r.char_id);
            db.prepare(`DELETE FROM char_tags WHERE tag_id = ? AND char_id IN
                (SELECT char_id FROM char_tags WHERE tag_id = ?)`).run(src.id, dst.id);
            db.prepare('UPDATE char_tags SET tag_id = ? WHERE tag_id = ?').run(dst.id, src.id);
            db.prepare('DELETE FROM tags WHERE id = ?').run(src.id);
        } else {
            // plain rename, or a case/whitespace change of the same NOCASE row
            db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(target, src.id);
        }
        // the undo: each carrier lost the source where it stood and gained the target, unless it already had it
        if (state) {
            const journal = linkJournal(db, state, state.label);
            const had = new Set(alreadyHadTarget);
            const gained = merged ? dst.name : target;
            for (const c of carriers) {
                journal(c.char_id, src.name, 0, c.pos);
                if (!had.has(c.char_id)) journal(c.char_id, gained, 1);
            }
            // the op itself, so its undo can move every tab's live rules back
            opsJournal(db, state, state.label)({ tag: merged ? 'merge' : 'rename', from: src.name, to: gained });
        }
        // a saved filter preset naming the tag follows it, a merge onto the surviving row's spelling, and so does every tab
        const survivor = merged ? dst.name : target;
        rewritePresetRules(db, PRESET_TAG_FIELDS, src.name, survivor, state ? opsJournal(db, state, state.label) : null);
        emitChange(db, { entity: 'tag', op: merged ? 'deleted' : 'updated', ids: [src.name], to: survivor });
        reportTagged(db, affected);
    })();
    return { touched: affected.length, merged, runId: state?.runId ?? null };
}

/**
 * Remove a tag from every carrier and the tag row; a run journals each link with its place. 404 for an unknown tag.
 * @returns {{touched: number, runId: number|null}}
 */
export function removeTag(db, name, { run } = {}) {
    const tag = findTag(db, name);
    if (!tag) throw httpError(404, `no such tag: ${name}`);
    let affected = [];
    const state = run ? opRunState(db, run) : null;
    db.transaction(() => {
        const carriers = db.prepare('SELECT char_id, pos FROM char_tags WHERE tag_id = ?').all(tag.id);
        affected = carriers.map(r => r.char_id);
        if (state) {
            const journal = linkJournal(db, state, state.label);
            for (const c of carriers) journal(c.char_id, tag.name, 0, c.pos);
            opsJournal(db, state, state.label)({ tag: 'delete', from: tag.name, to: null });
        }
        db.prepare('DELETE FROM char_tags WHERE tag_id = ?').run(tag.id);
        db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
        rewritePresetRules(db, PRESET_TAG_FIELDS, tag.name, null, state ? opsJournal(db, state, state.label) : null);
        emitChange(db, { entity: 'tag', op: 'deleted', ids: [tag.name] });
        reportTagged(db, affected);
    })();
    return { touched: affected.length, runId: state?.runId ?? null };
}

/**
 * Add or remove tag names on characters by id; unknown ids are skipped before any tag is minted, deltas hold real changes only.
 * @returns {{touched: number, affected: string[], skipped: string[], deltas: Array<{charId: string, added: string[], removed: string[]}>}}
 */
export function applyTags(db, charIds, { add = [], remove = [] } = {}) {
    const { add: addNames, remove: removeNames } = tagWriteNames(add, remove);
    const charExists = db.prepare('SELECT 1 FROM characters WHERE id = ?');
    const tags = tagIds(db);
    const linkTag = db.prepare(`INSERT OR IGNORE INTO char_tags (char_id, tag_id, pos)
        VALUES (?, ?, (SELECT COALESCE(MAX(pos), -1) + 1 FROM char_tags WHERE char_id = ?))`);
    const unlink = db.prepare('DELETE FROM char_tags WHERE char_id = ? AND tag_id = ?');
    const skipped = [];
    const touched = [];
    const deltas = [];
    db.transaction(() => {
        const ids = [];
        for (const rawId of charIds) {
            // no filename tolerance: an unknown id lands in skipped, never in a strip
            const id = String(rawId);
            if (!charExists.get(id)) { skipped.push(id); continue; }
            ids.push(id);
        }
        if (!ids.length) return;
        const addIds = addNames.map(n => ({ name: n, id: tags.mint(n) }));
        const removeIds = removeNames.map(n => ({ name: n, id: tags.find(n) })).filter(t => t.id != null);
        for (const id of ids) {
            const added = [];
            const removed = [];
            for (const t of addIds) { if (linkTag.run(id, t.id, id).changes) added.push(t.name); }
            for (const t of removeIds) { if (unlink.run(id, t.id).changes) removed.push(t.name); }
            if (!added.length && !removed.length) continue;
            deltas.push({ charId: id, added, removed });
            touched.push(id);
        }
        if (touched.length) reportTagged(db, touched);
    })();
    return { touched: touched.length, affected: touched, skipped, deltas };
}

/**
 * The tags a set carries, how many of it carry each, and its size; a set less some ids is its filter's tally less theirs.
 * @param {{ sql: string, params: any[], whole?: boolean, less?: { base: object, gone: object } }} set
 * @returns {{ total: number, tags: Array<{name: string, count: number}> }}
 */
export function tallyTags(db, set) {
    if (set.less) {
        const base = tallyTags(db, set.less.base);
        const gone = tallyTags(db, set.less.gone);
        const goneOf = new Map(gone.tags.map(t => [t.name, t.count]));
        const left = base.tags.map(t => ({ name: t.name, count: t.count - (goneOf.get(t.name) || 0) })).filter(t => t.count > 0);
        // ordered again by the list's own collation, which a JS sort would only approximate
        const tags = db.prepare(`SELECT json_extract(value, '$.name') AS name, json_extract(value, '$.count') AS count
            FROM json_each(?) ORDER BY count DESC, name COLLATE NOCASE`).all(JSON.stringify(left)).map(r => ({ name: r.name, count: r.count }));
        return { total: base.total - gone.total, tags };
    }
    if (set.whole) return { total: db.prepare('SELECT COUNT(*) n FROM characters').get().n, tags: listTagCounts(db) };
    const total = db.prepare(`SELECT COUNT(*) n FROM (${set.sql})`).get(...set.params).n;
    if (!total) return { total, tags: [] };
    const tags = db.prepare(`
        SELECT t.name, COUNT(*) AS count
        FROM (${set.sql}) s JOIN char_tags ct ON ct.char_id = s.id JOIN tags t ON t.id = ct.tag_id
        GROUP BY t.id
        ORDER BY count DESC, t.name COLLATE NOCASE
    `).all(...set.params).map(r => ({ name: r.name, count: r.count }));
    return { total, tags };
}

