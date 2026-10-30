// The one reading of a character list query, so a set named by filter is exactly what the list answers
import { CHAR_SORTS, CHAR_Q_FIELDS, CHAR_FIELDS, assertMatchQuery, characterSetQuery } from '../db/characters-store.js';
import { extSortKey } from '../db/ext-query.js';
import { boolOf, listOf, intOf, IDS_MAX } from './query-params.js';
import { httpError } from './http-error.js';

/**
 * queryCharacters' options from a list query's parameters ({ key: string | string[] }).
 * Throws a statusCode 400 naming the parameter it refuses.
 */
export function characterQueryOpts(db, p) {
    const extSort = typeof p.sort === 'string' && p.sort.startsWith('ext.') && !!extSortKey(db, p.sort);
    if (p.sort !== undefined && !CHAR_SORTS[p.sort] && p.sort !== 'relevance' && p.sort !== 'random' && !extSort) {
        throw httpError(400, `unknown sort '${p.sort}'; valid: ${Object.keys(CHAR_SORTS).join(', ')}, relevance (with match or words), random, or the sort key of an extension this account has on (ext.<id>.<key>)`);
    }
    if (p.match && p.words !== undefined) throw httpError(400, 'match or words, not both');
    if (p.sort === 'relevance' && !p.match && p.words === undefined) {
        throw httpError(400, 'sort=relevance requires match or words');
    }
    if (p.after !== undefined && (p.sort === 'relevance' || p.sort === 'random' || extSort)) {
        throw httpError(400, `cursor paging is not available for ${p.sort} sort; use offset`);
    }
    if (p.order !== undefined && !['asc', 'desc'].includes(p.order)) {
        throw httpError(400, "order must be 'asc' or 'desc'");
    }
    const qIn = listOf(p.qIn);
    // an unknown field is refused, a misspelled one would read as an empty value
    const fields = listOf(p.fields);
    const badFields = fields.filter(f => !CHAR_FIELDS.includes(f));
    if (badFields.length) throw httpError(400, `unknown fields(s) ${badFields.join(', ')}; valid: ${CHAR_FIELDS.join(', ')}`);
    const badQIn = qIn.filter(f => !CHAR_Q_FIELDS.includes(f));
    if (badQIn.length) {
        throw httpError(400, `unknown qIn field(s) ${badQIn.join(', ')}; valid: ${CHAR_Q_FIELDS.join(', ')}`);
    }
    const nums = {};
    for (const k of ['limit', 'offset', 'tokensMin', 'tokensMax', 'createdAfter', 'createdBefore',
        'importedAfter', 'importedBefore', 'updatedAfter', 'updatedBefore',
        'altGreetingsMin', 'altGreetingsMax']) {
        nums[k] = intOf(p[k]);
        if (Number.isNaN(nums[k])) throw httpError(400, `${k} must be a number`);
    }
    let rules;
    if (p.rules !== undefined) {
        try { rules = JSON.parse(String(p.rules)); }
        catch { throw httpError(400, 'rules must be URL-encoded JSON'); }
    }
    // checked at the one reading so every route refuses a bad FTS5 match in the same words
    if (p.match) assertMatchQuery(db, String(p.match));
    return {
        q: p.q ? String(p.q) : undefined,
        match: p.match ? String(p.match) : undefined,
        words: p.words !== undefined ? String(p.words) : undefined,
        qIn,
        rules,
        idsOnly: boolOf(p.idsOnly, 'idsOnly') === true,
        fields,
        ids: listOf(p.ids),
        notIds: listOf(p.notIds),
        creator: p.creator ? String(p.creator) : undefined,
        tags: listOf(p.tag),
        anyTags: listOf(p.anyTag),
        excludeTags: listOf(p.excludeTag),
        excludeTagsAll: listOf(p.excludeTagAll),
        provider: p.provider ? String(p.provider) : undefined,
        linked: boolOf(p.linked, 'linked'),
        hasUrl: boolOf(p.hasUrl, 'hasUrl'),
        fav: boolOf(p.fav, 'fav'),
        locked: boolOf(p.locked, 'locked'),
        mediaLocalized: boolOf(p.mediaLocalized, 'mediaLocalized'),
        loreDismissed: boolOf(p.loreDismissed, 'loreDismissed'),
        world: p.world ? String(p.world) : undefined,
        hasWorld: boolOf(p.hasWorld, 'hasWorld'),
        hasLorebook: boolOf(p.hasLorebook, 'hasLorebook'),
        hasSystemPrompt: boolOf(p.hasSystemPrompt, 'hasSystemPrompt'),
        specVersion: p.specVersion ? String(p.specVersion) : undefined,
        sort: p.sort,
        order: p.order,
        after: p.after ? String(p.after) : undefined,
        count: boolOf(p.count, 'count'),
        ...nums,
    };
}

// order, paging and counting describe a list, never a set
const LIST_ONLY = ['sort', 'order', 'after', 'limit', 'offset', 'count', 'idsOnly', 'fields'];

/**
 * A GET /characters query string read as filter options; an unread parameter is a 400, since a typo would name the whole library.
 */
export function characterFilterOpts(db, filter) {
    if (typeof filter !== 'string') throw httpError(400, 'filter must be a GET /characters query string');
    const sp = new URLSearchParams(filter);
    const p = {};
    for (const key of new Set(sp.keys())) {
        if (LIST_ONLY.includes(key)) continue;
        const all = sp.getAll(key);
        p[key] = all.length > 1 ? all : all[0];
    }
    // the parameters the reading reads, recorded as it reads them: what it never asked for is unknown
    const read = new Set();
    const opts = characterQueryOpts(db, new Proxy(p, { get: (target, key) => { if (typeof key === 'string') read.add(key); return target[key]; } }));
    const unknown = Object.keys(p).filter(key => !read.has(key));
    if (unknown.length) throw httpError(400, `unknown filter parameter(s) ${unknown.join(', ')}; a filter takes the parameters of GET /characters`);
    return opts;
}

/**
 * The character set a body names, by charIds (at most IDS_MAX) or by filter (never both). Throws a statusCode 400.
 * @returns {{ sql: string, params: any[], whole: boolean }}
 */
export function characterSetFrom(db, { charIds, filter } = {}) {
    if (charIds !== undefined && filter !== undefined) throw httpError(400, 'charIds or filter, not both');
    if (filter !== undefined) return characterSetQuery(db, characterFilterOpts(db, filter));
    if (!Array.isArray(charIds) || charIds.length === 0) throw httpError(400, 'charIds array or a filter required');
    if (charIds.length > IDS_MAX) throw httpError(400, `charIds names at most ${IDS_MAX} characters a request; send the selection in chunks, or its filter`);
    return characterSetQuery(db, { ids: charIds.map(String) });
}
