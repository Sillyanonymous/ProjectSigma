// Shared CharacterTavern utilities - used by both chartavern-provider.js and chartavern-browse.js
//
// Contains constants, fetch helpers, and text utilities for character-tavern.com's page data.

// ========================================
// CONSTANTS
// ========================================

import { PROVIDER_SERVICES_BASE as CL_HELPER_CT_BASE } from '../provider-utils.js';

export const CT_SITE_BASE = 'https://character-tavern.com';
export const CT_CARDS_CDN = 'https://ct-cards.storage.character-tavern.com';

// ========================================
// NETWORK (shared)
// ========================================

import { fetchWithProxy, readJsonClassified, parseProviderUrl } from '../provider-utils.js';

// ========================================
// AUTH - service cookie session
// ========================================

let ctSessionActive = false;

/**
 * Check if the provider services are reachable.
 * @param {Function} apiRequest - CoreAPI.apiRequest
 * @returns {Promise<boolean>}
 */
export async function checkCtPluginAvailable(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/health`);
        if (!resp.ok) return false;
        const data = await resp.json();
        return data?.ok === true;
    } catch {
        return false;
    }
}

/**
 * Check if a CT session is active in the service.
 * @param {Function} apiRequest - CoreAPI.apiRequest
 * @returns {Promise<boolean>}
 */
export async function checkCtSession(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/ct-session`);
        if (!resp.ok) return false;
        const data = await resp.json();
        ctSessionActive = data?.active === true;
        return ctSessionActive;
    } catch {
        ctSessionActive = false;
        return false;
    }
}

/**
 * Store cookies in the service for proxied CT requests.
 * @param {Function} apiRequest
 * @param {string} cookieString - Raw cookie header value (e.g. "session=abc123")
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function ctSetCookie(apiRequest, cookieString) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/ct-set-cookie`, 'POST', {
            cookie: cookieString,
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            return { ok: false, error: `Server returned ${resp.status}: ${text.substring(0, 100)}` };
        }
        const data = await resp.json();
        if (data?.ok) {
            ctSessionActive = true;
            return { ok: true };
        }
        return { ok: false, error: data?.error || 'Failed to store cookies' };
    } catch (err) {
        return { ok: false, error: err.message || 'Network error' };
    }
}

/**
 * Validate stored CT cookies by making a test request through the service.
 * Clears session state if cookies are expired/invalid.
 * @param {Function} apiRequest
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function ctValidateSession(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/ct-validate`);
        // Client-side failures never judged the cookie, so they are transient by construction
        if (!resp.ok) return { valid: false, transient: true, reason: 'validation request failed' };
        const data = await resp.json();
        if (!data?.valid) {
            ctSessionActive = false;
        }
        return data;
    } catch {
        ctSessionActive = false;
        return { valid: false, transient: true, reason: 'network error' };
    }
}

/**
 * Log out from CharacterTavern via the service.
 * @param {Function} apiRequest
 */
export async function ctLogout(apiRequest) {
    try {
        await apiRequest(`${CL_HELPER_CT_BASE}/ct-logout`, 'POST');
    } catch { /* our own server unreachable: this tab forgets the session either way */ }
    ctSessionActive = false;
}

/** @returns {boolean} */
export function isCtSessionActive() {
    return ctSessionActive;
}

/**
 * The service's last snapshot of CT's rolling expiry; a stored-state read, so it never slides the window.
 * @param {Function} apiRequest
 * @returns {Promise<{active: boolean, expires: number|null}>} expires in ms epoch
 */
export async function fetchCtSessionInfo(apiRequest) {
    try {
        const resp = await apiRequest(`${CL_HELPER_CT_BASE}/ct-session`);
        if (!resp.ok) return { active: false, expires: null };
        const data = await resp.json();
        ctSessionActive = data?.active === true;
        return { active: ctSessionActive, expires: data?.expires ?? null };
    } catch {
        return { active: false, expires: null };
    }
}

/**
 * One CT page's data, read through the server: it decodes the page-data format and carries the session cookie.
 * @param {string} sitePath the page's data path on character-tavern.com, query included
 * @param {Function} apiRequest CoreAPI.apiRequest
 * @returns {Promise<Response>} JSON {nodes} when ok; a page CT could not load answers with its own status
 */
function ctPageData(sitePath, apiRequest) {
    if (!apiRequest) throw new Error('CharacterTavern is read through the server');
    return apiRequest(`${CL_HELPER_CT_BASE}/ct-proxy${sitePath}`);
}

// ========================================
// API FUNCTIONS
// ========================================

// the catalog's orders, as its own sort menu sends them; none is its Best, the top matches for a search
export const CT_SORTS = ['new_noteworthy', 'popular', 'most_liked', 'hidden_gems', 'newest', 'recently_updated'];

/**
 * Search the catalog: thin hits (name, tagline, path, author, contentWarnings, tokens), 30 to a page.
 * @param {Object} opts
 * @param {Function} apiRequest - CoreAPI.apiRequest
 * @returns {Promise<{hits: Array, totalHits: number, totalPages: number, page: number}>}
 */
export async function searchCards(opts = {}, apiRequest) {
    const {
        query = '',
        sort = '',
        page = 1,
        tags = '',
        excludeTags = '',
        minimumTokens,
        maximumTokens,
        hasLorebook,
        isOC,
        nsfw = true
    } = opts;

    const params = new URLSearchParams();
    if (query) params.set('query', query);
    if (CT_SORTS.includes(sort)) params.set('sort', sort);
    if (page > 1) params.set('page', String(page));
    if (tags) params.set('tags', tags);
    if (excludeTags) params.set('exclude_tags', excludeTags);
    if (minimumTokens != null) params.set('minimum_tokens', String(minimumTokens));
    if (maximumTokens != null) params.set('maximum_tokens', String(maximumTokens));
    if (hasLorebook) params.set('hasLorebook', 'true');
    if (isOC) params.set('isOC', 'true');

    // CT has no NSFW switch of its own: the nsfw tag excluded stands for it
    if (!nsfw) {
        const existing = excludeTags ? excludeTags.split(',').map(t => t.trim()) : [];
        if (!existing.includes('nsfw')) existing.push('nsfw');
        params.set('exclude_tags', existing.join(','));
    }
    // the search node alone, as the catalog asks when its filters change
    params.set('x-sveltekit-invalidated', '001');

    const data = await readJsonClassified(await ctPageData(`/search/cards/__data.json?${params}`, apiRequest));
    const results = data?.nodes?.find(n => n?.searchResults)?.searchResults;
    if (!results) throw new Error('CharacterTavern answered no search results');
    return { ...results, hits: (results.hits || []).map(h => ({ ...h, totalTokens: h.permanentTokens ?? h.totalTokens })) };
}

/**
 * One character's page data: the card (with its tags, likes and author), its alternate greetings and lorebook.
 * @param {string} author
 * @param {string} slug
 * @param {Function} apiRequest - CoreAPI.apiRequest
 * @returns {Promise<{card: Object, ownerCTId: string|null, alternativeGreetings: string[], lorebook: Object|null}>}
 */
export async function fetchCharacterDetail(author, slug, apiRequest) {
    const resp = await ctPageData(`/character/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/__data.json`, apiRequest);
    // the status rides the error so a 404 reads as a definitive miss upstream
    if (!resp.ok) throw Object.assign(new Error(`CT detail returned HTTP ${resp.status}`), { status: resp.status });
    const data = await resp.json();
    const page = data?.nodes?.find(n => n?.character);
    if (!page) throw new Error('CharacterTavern answered no character');
    return {
        card: {
            ...page.character,
            tags: Array.isArray(page.tags) ? page.tags : [],
            likes: page.likesData?.likeCount ?? null,
            author: page.authorUsername || author,
        },
        ownerCTId: page.authorUserId ?? null,
        alternativeGreetings: Array.isArray(page.alternativeGreetings) ? page.alternativeGreetings.filter(g => typeof g === 'string' && g) : [],
        lorebook: page.lorebook ?? null,
    };
}

/**
 * The rich hit the preview and the importers read, built from a character's page data (a search hit is thin).
 * @param {{card: Object, alternativeGreetings: string[]}} detail fetchCharacterDetail's answer
 * @returns {Object}
 */
export function hitFromDetail(detail) {
    const c = detail.card;
    return {
        id: c.id || null,
        path: c.path,
        name: c.name,
        inChatName: c.inChatName,
        author: c.author,
        tagline: c.tagline || '',
        pageDescription: c.description || '',
        characterDefinition: c.definition_character_description || '',
        characterPersonality: c.definition_personality || '',
        characterScenario: c.definition_scenario || '',
        characterFirstMessage: c.definition_first_message || '',
        characterExampleMessages: c.definition_example_messages || '',
        characterPostHistoryPrompt: c.definition_post_history_prompt || '',
        alternativeFirstMessage: detail.alternativeGreetings || [],
        tags: c.tags || [],
        likes: c.likes,
        totalTokens: c.tokenTotal ?? null,
        // seconds, as the grid and the preview read a hit's date
        createdAt: c.createdAt ? Math.floor(Date.parse(c.createdAt) / 1000) : null,
        isNSFW: c.isNSFW === true,
        hasLorebook: c.lorebookId != null,
        isOC: c.isOC === true,
    };
}

/**
 * The catalog's tag list, most used first.
 * @param {Function} apiRequest - CoreAPI.apiRequest
 * @returns {Promise<Array<{tag: string, count: number}>>}
 */
export async function fetchTopTags(apiRequest) {
    // the layout's tag node alone, which streams the catalogue
    const resp = await ctPageData('/search/cards/__data.json?x-sveltekit-invalidated=01', apiRequest);
    if (!resp.ok) throw new Error(`Top tags fetch failed (${resp.status})`);
    const data = await resp.json();
    const catalogue = data?.nodes?.find(n => n?.tagCatalogue)?.tagCatalogue;
    if (!Array.isArray(catalogue?.tags)) throw new Error('CharacterTavern answered no tag list');
    return catalogue.tags.filter(t => t && typeof t.value === 'string').map(t => ({ tag: t.value, count: Number(t.count) || 0 }));
}

// ========================================
// URL / PATH HELPERS
// ========================================

/**
 * Card image URL on the storage host, which honours ?width= (webp); card slots pass their width, other surfaces take the full image.
 * @param {string} path - "author/slug" format
 * @param {{width?: number}} [opts]
 * @returns {string}
 */
export function getAvatarUrl(path, { width } = {}) {
    return `${CT_CARDS_CDN}/${path}.png${width ? `?width=${width}` : ''}`;
}

/**
 * Build full-size card PNG URL (for download / import).
 * @param {string} path - "author/slug" format
 * @returns {string}
 */
export function getCardPngUrl(path) {
    return `${CT_CARDS_CDN}/${path}.png`;
}

/**
 * The card file itself. The CDN answers WebP to an image Accept with no Vary, so a preview's cached copy has no card inside.
 * @param {string} path - "author/slug" format
 * @returns {Promise<Response>}
 */
export function fetchCtCardFile(path) {
    return fetchWithProxy(getCardPngUrl(path), { cache: 'no-store', headers: { Accept: 'image/png' } });
}

/**
 * Build the web page URL for a character.
 * @param {string} path - "author/slug" format
 * @returns {string}
 */
export function getCharacterPageUrl(path) {
    return `${CT_SITE_BASE}/character/${path}`;
}

/**
 * Parse a character-tavern.com URL into author/slug path.
 * Accepts: https://character-tavern.com/character/author/slug
 * @param {string} url
 * @returns {string|null} "author/slug" or null
 */
export function parseCharacterUrl(url) {
    const u = parseProviderUrl(url);
    if (!u || !/^(www\.)?character-tavern\.com$/i.test(u.hostname)) return null;
    const match = u.pathname.match(/^\/character\/([^/]+)\/([^/]+)/);
    return match ? `${match[1]}/${match[2]}` : null;
}

// ========================================
// TEXT UTILITIES (shared + local)
// ========================================

export { stripHtml } from '../provider-utils.js';

/**
 * The clean character name: inChatName (nullable, trailing spaces) over the listing title in name.
 * @param {Object} apiData - CT card object (detail card or search hit)
 * @returns {string}
 */
export function getCtCharName(apiData) {
    return (apiData?.inChatName || '').trim() || apiData?.name || 'Unknown';
}

/**
 * Normalize tags into an array of strings.
 * CT API returns tags as an array; handles legacy space-separated strings too.
 */
export function parseTags(tags) {
    if (!tags) return [];
    if (Array.isArray(tags)) return tags.filter(Boolean);
    if (typeof tags === 'string') return tags.split(/\s+/).filter(Boolean);
    return [];
}
