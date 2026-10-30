import { httpError } from './http-error.js';

// Query-string readers shared by the routes. a value outside its set is a 400 by name, never a default

// exported for the spec, whose query-flag enum is these words and no others
export const BOOL_TRUE = ['1', 'true', 'yes'];
export const BOOL_FALSE = ['0', 'false', 'no'];

/** A boolean flag: undefined when absent, true or false for the named words, 400 for anything else. */
export function boolOf(v, name) {
    if (v === undefined) return undefined;
    const s = String(v).toLowerCase();
    if (BOOL_TRUE.includes(s)) return true;
    if (BOOL_FALSE.includes(s)) return false;
    throw httpError(400, `${name} must be one of: ${[...BOOL_TRUE, ...BOOL_FALSE].join(', ')}`);
}

/** A comma list (or a repeated param): trimmed, blanks dropped, [] when absent. */
export function listOf(v) {
    return v === undefined ? []
        : (Array.isArray(v) ? v : String(v).split(',')).map(s => String(s).trim()).filter(Boolean);
}

/** An integer: undefined when absent, NaN when not a number (the caller answers 400 by name). */
export function intOf(v) {
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

// a list that grows with the library answers a page; a whole-set reader walks nextCursor
export const PAGE_DEFAULT = 100;
export const PAGE_MAX = 1000;

/**
 * A page's limit and cursor from a list query; a limit outside 1 to max is refused by name.
 * @returns {{ limit: number, after: string|undefined }}
 */
export function pageOf(query, { def = PAGE_DEFAULT, max = PAGE_MAX, what = '', cursor = true } = {}) {
    const limit = query.limit === undefined ? def : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > max) {
        throw httpError(400, `limit is 1 to ${max}${what}${cursor ? '; walk the nextCursor (after) for more' : ''}`);
    }
    return { limit, after: query.after === undefined ? undefined : String(query.after) };
}

// the most keys one probe request names (/characters/match, /provider-links/probe, /worlds/probe);
// the client pages its probes by the same number, PROBE_PAGE
export const PROBE_MAX_KEYS = 500;

// the most character ids a set write or tally names a request: a write's one transaction locks for all of them, so clients chunk
export const IDS_MAX = 10000;

// the most updates a batch card write takes a request: each is a whole PATCH, run back to back, so clients chunk
export const FIELDS_APPLY_MAX = 5000;
