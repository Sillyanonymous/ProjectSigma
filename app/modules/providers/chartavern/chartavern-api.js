// Shared CharacterTavern API utilities - used by both chartavern-provider.js and chartavern-browse.js
//
// Contains constants, fetch helpers, and text utilities for the
// character-tavern.com API.

// ========================================
// CONSTANTS
// ========================================

import { PROVIDER_SERVICES_BASE as CL_HELPER_CT_BASE } from '../provider-utils.js';

export const CT_API_BASE = 'https://character-tavern.com/api';
export const CT_SITE_BASE = 'https://character-tavern.com';
export const CT_CARDS_CDN = 'https://ct-cards.storage.character-tavern.com';

// ========================================
// NETWORK (shared)
// ========================================

import { fetchWithProxy, readJsonClassified, parseProviderUrl } from '../provider-utils.js';
export { fetchWithProxy };

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

// One /health probe per session backing ctFetch's transport choice; concurrent callers share it.
let _ctHelperProbe = null;

function ctHelperAvailable(apiRequest) {
    if (!apiRequest) return Promise.resolve(false);
    if (!_ctHelperProbe) _ctHelperProbe = checkCtPluginAvailable(apiRequest);
    return _ctHelperProbe;
}

/**
 * Fetch a CT API URL, routing through the service's /ct-proxy whenever the service is available.
 * @param {string} url - Full CT API URL (e.g. https://character-tavern.com/api/search/cards?...)
 * @param {Function} [apiRequest] - CoreAPI.apiRequest (required for proxied requests)
 * @returns {Promise<Response>}
 */
async function ctFetch(url, apiRequest) {
    // /ct-proxy even with no session: CT's edge answers a browser's zstd, which a pass-through relay cant decode
    if (apiRequest && (ctSessionActive || await ctHelperAvailable(apiRequest))) {
        const path = url.replace(CT_SITE_BASE, '');
        return apiRequest(`${CL_HELPER_CT_BASE}/ct-proxy${path}`);
    }
    return fetchWithProxy(url);
}

// ========================================
// API FUNCTIONS
// ========================================

/**
 * Search characters via /api/search/cards
 * @param {Object} opts
 * @param {Function} [apiRequest] - CoreAPI.apiRequest for authenticated proxy
 * @returns {Promise<{hits: Array, totalHits: number, totalPages: number, page: number}>}
 */
export async function searchCards(opts = {}, apiRequest) {
    const {
        query = '',
        sort = 'most_popular',
        page = 1,
        limit = 30,
        tags = '',
        excludeTags = '',
        minimumTokens,
        maximumTokens,
        hasLorebook,
        isOC,
        nsfw = true
    } = opts;

    const params = new URLSearchParams();
    params.set('query', query);
    params.set('sort', sort);
    params.set('page', String(page));
    params.set('limit', String(limit));
    if (tags) params.set('tags', tags);
    if (excludeTags) params.set('exclude_tags', excludeTags);
    if (minimumTokens != null) params.set('minimum_tokens', String(minimumTokens));
    if (maximumTokens != null) params.set('maximum_tokens', String(maximumTokens));
    if (hasLorebook != null) params.set('hasLorebook', String(hasLorebook));
    if (isOC != null) params.set('isOC', String(isOC));

    // CT API has no explicit NSFW toggle - exclude_tags is used instead
    if (!nsfw) {
        const existing = excludeTags ? excludeTags.split(',').map(t => t.trim()) : [];
        if (!existing.includes('nsfw')) existing.push('nsfw');
        params.set('exclude_tags', existing.join(','));
    }

    const url = `${CT_API_BASE}/search/cards?${params}`;
    const resp = await ctFetch(url, apiRequest);
    return readJsonClassified(resp);
}

/**
 * Fetch full character details via /api/character/{author}/{slug}
 * @param {string} author
 * @param {string} slug
 * @param {Function} [apiRequest] - CoreAPI.apiRequest for authenticated proxy
 * @returns {Promise<Object>} { card: {...}, ownerCTId: ... }
 */
export async function fetchCharacterDetail(author, slug, apiRequest) {
    const url = `${CT_API_BASE}/character/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`;
    const resp = await ctFetch(url, apiRequest);
    // the status rides the error so a 404 reads as a definitive miss upstream
    if (!resp.ok) throw Object.assign(new Error(`CT detail returned HTTP ${resp.status}`), { status: resp.status });
    return resp.json();
}

/**
 * Fetch top tags from /api/catalog/top-tags
 * @param {Function} [apiRequest] - CoreAPI.apiRequest for the service transport
 * @returns {Promise<Array<{tag: string, count: number}>>}
 */
export async function fetchTopTags(apiRequest) {
    const url = `${CT_API_BASE}/catalog/top-tags`;
    const resp = await ctFetch(url, apiRequest);
    if (!resp.ok) throw new Error(`Top tags fetch failed (${resp.status})`);
    return resp.json();
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
