// Shared JannyAI API utilities - used by both janny-provider.js and janny-browse.js
//
// Contains constants, tag mapping, MeiliSearch token management,
// proxy fetch helpers, and text utilities.

// ========================================
// CONSTANTS
// ========================================

const JANNY_SEARCH_URL = 'https://search.jannyai.com/multi-search';
export const JANNY_IMAGE_BASE = 'https://image.jannyai.com/bot-avatars/';
export const JANNY_SITE_BASE = 'https://jannyai.com';
const JANNY_FALLBACK_TOKEN = '88a6463b66e04fb07ba87ee3db06af337f492ce511d93df6e2d2968cb2ff2b30';

// A character page is /characters/{uuid}_{slug}; the site resolves on the uuid alone, so the
// slug is display and search material, never identity.
const JANNY_SLUG_PREFIX = 'character-';
const JANNY_SLUG_FALLBACK = 'character';

/** The site's slug for a character name; a name with nothing to slug gets the one fallback a bare-id link gets. */
export function jannySlug(name) {
    // slugify hands its own fallback back for an empty name, which would double the word here
    const s = name ? slugify(name) : '';
    return s ? `${JANNY_SLUG_PREFIX}${s}` : JANNY_SLUG_FALLBACK;
}

/** The identifier and stored path for a character: {uuid}_{slug}. */
export function jannyFullPath(id, name) {
    return `${id}_${jannySlug(name)}`;
}

/** The searchable name back out of a slug (ours or one carried on a link), words space-separated. */
export function jannyNameFromSlug(slug) {
    const s = String(slug || '');
    return (s.startsWith(JANNY_SLUG_PREFIX) ? s.slice(JANNY_SLUG_PREFIX.length) : s).replace(/-/g, ' ').trim();
}

/** A stored path or identifier ({uuid}_{slug}, or a bare uuid) back into its two parts. */
export function jannyPathParts(fullPath) {
    const parts = String(fullPath || '').split('_');
    return { id: parts[0], slug: parts.slice(1).join('_') };
}

/** The character page, the one path the hosted browser serves for this provider. */
export function jannyCharacterUrl(id, slug) {
    return `${JANNY_SITE_BASE}/characters/${id}_${slug || JANNY_SLUG_FALLBACK}`;
}

// Tag ID → name mapping (JannyAI uses numeric IDs internally)
export const TAG_MAP = {
    1: 'Male', 2: 'Female', 3: 'Non-binary', 4: 'Celebrity', 5: 'OC',
    6: 'Fictional', 7: 'Real', 8: 'Game', 9: 'Anime', 10: 'Historical',
    11: 'Royalty', 12: 'Detective', 13: 'Hero', 14: 'Villain', 15: 'Magical',
    16: 'Non-human', 17: 'Monster', 18: 'Monster Girl', 19: 'Alien', 20: 'Robot',
    21: 'Politics', 22: 'Vampire', 23: 'Giant', 24: 'OpenAI', 25: 'Elf',
    26: 'Multiple', 27: 'VTuber', 28: 'Dominant', 29: 'Submissive', 30: 'Scenario',
    31: 'Pokemon', 32: 'Assistant', 34: 'Non-English', 36: 'Philosophy',
    38: 'RPG', 39: 'Religion', 41: 'Books', 42: 'AnyPOV', 43: 'Angst',
    44: 'Demi-Human', 45: 'Enemies to Lovers', 46: 'Smut', 47: 'MLM',
    48: 'WLW', 49: 'Action', 50: 'Romance', 51: 'Horror', 52: 'Slice of Life',
    53: 'Fantasy', 54: 'Drama', 55: 'Comedy', 56: 'Mystery', 57: 'Sci-Fi',
    59: 'Yandere', 60: 'Furry', 61: 'Movies/TV'
};

// ========================================
// TOKEN MANAGEMENT
// ========================================

let _cachedToken = null;
let _tokenFetchPromise = null;

/**
 * The MeiliSearch key, scraped from JannyAI's client config bundle (a known key as fallback), cached for every caller.
 */
async function getSearchToken() {
    if (_cachedToken) return _cachedToken;
    if (_tokenFetchPromise) return _tokenFetchPromise;

    _tokenFetchPromise = (async () => {
        try {
            const pageResp = await fetchWithProxy(`${JANNY_SITE_BASE}/characters/search`);
            const html = await pageResp.text();

            let configPath = null;
            const configMatch = html.match(/client-config\.[a-zA-Z0-9_-]+\.js/);
            if (configMatch) {
                configPath = '/_astro/' + configMatch[0];
            } else {
                const spMatch = html.match(/SearchPage\.[a-zA-Z0-9_-]+\.js/);
                if (spMatch) {
                    const spResp = await fetchWithProxy(`${JANNY_SITE_BASE}/_astro/${spMatch[0]}`);
                    if (spResp.ok) {
                        const spJs = await spResp.text();
                        const impMatch = spJs.match(/client-config\.[a-zA-Z0-9_-]+\.js/);
                        if (impMatch) configPath = '/_astro/' + impMatch[0];
                    }
                }
            }

            if (configPath) {
                const cfgResp = await fetchWithProxy(`${JANNY_SITE_BASE}${configPath}`);
                if (cfgResp.ok) {
                    const cfgJs = await cfgResp.text();
                    const tokenMatch = cfgJs.match(/"([a-f0-9]{64})"/);
                    if (tokenMatch) {
                        _cachedToken = tokenMatch[1];
                        return _cachedToken;
                    }
                }
            }

            throw new Error('Could not extract MeiliSearch token');
        } catch (e) {
            console.warn('[JannyAPI] Token fetch failed, using fallback:', e.message);
            _cachedToken = JANNY_FALLBACK_TOKEN;
            return _cachedToken;
        } finally {
            _tokenFetchPromise = null;
        }
    })();

    return _tokenFetchPromise;
}

// ========================================
// NETWORK & TEXT UTILITIES (shared)
// ========================================

import { fetchWithProxy, readJsonClassified, slugify } from '../provider-utils.js';
export { fetchWithProxy };
export { slugify, stripHtml } from '../provider-utils.js';

/**
 * One JannyAI MeiliSearch multi-search; callers own filters, facets and sort, the envelope and transport are shared.
 * @param {Object} opts
 * @param {string} [opts.search] - q
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=80] - hitsPerPage
 * @param {string[]} [opts.filters] - MeiliSearch filter expressions
 * @param {string[]} [opts.facets]
 * @param {string[]} [opts.sort] - empty for relevance
 * @param {boolean} [opts.highlight] - add the crop/highlight attributes the browse grids render
 * @returns {Promise<Object>} raw multi-search response ({ results: [...] })
 */
export async function meiliMultiSearch({ search = '', page = 1, limit = 80, filters = [], facets = [], sort = [], highlight = false } = {}) {
    const query = {
        indexUid: 'janny-characters',
        q: search,
        filter: filters,
        hitsPerPage: limit,
        page,
    };
    if (facets.length) query.facets = facets;
    if (highlight) {
        query.attributesToCrop = ['description:300'];
        query.cropMarker = '...';
        query.attributesToHighlight = ['name', 'description'];
        query.highlightPreTag = '__ais-highlight__';
        query.highlightPostTag = '__/ais-highlight__';
    }
    if (sort.length) query.sort = sort;

    const token = await getSearchToken();
    const headers = {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Origin': JANNY_SITE_BASE,
        'Referer': `${JANNY_SITE_BASE}/`,
        'x-meilisearch-client': 'Meilisearch instant-meilisearch (v0.19.0) ; Meilisearch JavaScript (v0.41.0)',
    };

    const body = JSON.stringify({ queries: [query] });
    let response;
    try {
        response = await fetch(JANNY_SEARCH_URL, { method: 'POST', headers, body });
    } catch (_) {
        response = await fetchWithProxy(JANNY_SEARCH_URL, { method: 'POST', headers, body });
    }
    return readJsonClassified(response);
}

export function resolveTagNames(tagIds) {
    return (tagIds || []).map(id => TAG_MAP[id] || `Tag ${id}`);
}
