// Shared ChubAI API utilities: headers, metadata, lorebook and gallery fetch, the V2 card builder and the metadata cache

import CoreAPI from '../../core-api.js';
import { proxiedUrl, httpFailureError, fetchWithProxy, readJsonClassified } from '../provider-utils.js';

// ========================================
// CONSTANTS
// ========================================

export const CHUB_API_BASE = 'https://api.chub.ai';
export const CHUB_GATEWAY_BASE = 'https://gateway.chub.ai';
export const CHUB_AVATAR_BASE = 'https://avatars.charhub.io/avatars/';

// ========================================
// NETWORK
// ========================================

/**
 * Build Chub API headers with optional Bearer token.
 * @param {boolean} includeAuth
 * @returns {Object}
 */
export function getChubHeaders(includeAuth = true) {
    const headers = { 'Accept': 'application/json' };
    const token = savedChubToken();
    if (includeAuth && token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
}

/** A token as pasted: a copy of the request header carries its "Bearer " scheme. */
export function normalizeChubToken(raw) {
    return String(raw ?? '').trim().replace(/^bearer\s+/i, '').trim();
}

/** The token as saved, wherever it was saved (Settings or the browse popup), read at the moment of use. */
export function savedChubToken() {
    return normalizeChubToken(CoreAPI.getSetting('chubToken'));
}

/**
 * Whether ChubAI accepts a token: an unknown token gets an anonymous account (a negative id), not an error.
 * @param {string} raw the token as pasted
 * @returns {Promise<{ok: true, name: string}|{ok: false, error: string}>}
 */
export async function verifyChubToken(raw) {
    const token = normalizeChubToken(raw);
    if (!token) return { ok: false, error: 'No token entered' };
    const resp = await fetch(`${CHUB_API_BASE}/api/account`, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
    if (!resp.ok) return { ok: false, error: `ChubAI answered HTTP ${resp.status}` };
    const account = await resp.json().catch(() => null);
    if (!(Number(account?.id) > 0)) return { ok: false, error: 'ChubAI did not recognize this token' };
    return { ok: true, name: String(account.user_name || account.name || 'your account') };
}

export { fetchWithProxy } from '../provider-utils.js';

// ========================================
// RESPONSE HELPERS
// ========================================

/**
 * Extract nodes from various Chub API response envelope formats.
 */
export function extractNodes(data) {
    if (data.nodes) return data.nodes;
    if (data.data?.nodes) return data.data.nodes;
    if (Array.isArray(data.data)) return data.data;
    if (Array.isArray(data)) return data;
    return [];
}

// ========================================
// METADATA CACHE
// ========================================

export const chubMetadataCache = new Map();
const CHUB_METADATA_CACHE_MAX = 3;
const CHUB_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ========================================
// METADATA FETCH
// ========================================

/**
 * Character metadata from the REST API (LRU cached), stripped to the fields import, builder and browse read.
 * @param {string} fullPath - e.g. "creator/slug"
 * @returns {Promise<Object|null>}
 */
export async function fetchChubMetadata(fullPath, { strict = false } = {}) {
    const cached = chubMetadataCache.get(fullPath);
    if (cached && Date.now() - cached.time < CHUB_CACHE_TTL) {
        CoreAPI.debugLog('[Chub] Using cached metadata for:', fullPath);
        return cached.value;
    }

    try {
        const url = `${CHUB_API_BASE}/api/characters/${fullPath}?full=true`;
        CoreAPI.debugLog('[Chub] Fetching metadata from:', url);

        let response;
        try {
            response = await fetch(url, { headers: getChubHeaders(true) });
        } catch (directError) {
            CoreAPI.debugLog('[Chub] Direct fetch failed, trying proxy:', directError.message);
            const proxyUrl = proxiedUrl(url);
            response = await fetch(proxyUrl, { headers: getChubHeaders(true) });
        }

        if (!response.ok) {
            if (strict) throw httpFailureError(response.status, await response.text().catch(() => ''));
            return null;
        }

        const data = await response.json();
        const result = data.node || null;

        if (result) {
            const def = result.definition || {};
            const strippedResult = {
                id: result.id,
                name: result.name,
                fullPath: result.fullPath,
                topics: result.topics,
                tagline: result.tagline,
                avatar_url: result.avatar_url,
                max_res_url: result.max_res_url,
                hasGallery: result.hasGallery,
                creator: result.creator,
                definition: {
                    name: def.name,
                    personality: def.personality,
                    tavern_personality: def.tavern_personality,
                    first_message: def.first_message,
                    example_dialogs: def.example_dialogs,
                    description: def.description,
                    scenario: def.scenario,
                    system_prompt: def.system_prompt,
                    post_history_instructions: def.post_history_instructions,
                    alternate_greetings: def.alternate_greetings,
                    extensions: def.extensions,
                    character_version: def.character_version,
                    tagline: def.tagline,
                    embedded_lorebook: def.embedded_lorebook,
                },
                related_lorebooks: result.related_lorebooks || [],
                lastActivityAt: result.lastActivityAt || result.last_activity_at || null,
                createdAt: result.createdAt || result.created_at || null,
                starCount: result.starCount || result.star_count || 0,
                rating: result.rating || 0,
                nTokens: result.nTokens || result.n_tokens || 0,
            };

            while (chubMetadataCache.size >= CHUB_METADATA_CACHE_MAX) {
                const firstKey = chubMetadataCache.keys().next().value;
                chubMetadataCache.delete(firstKey);
            }
            chubMetadataCache.set(fullPath, { value: strippedResult, time: Date.now() });
            return strippedResult;
        }

        return result;
    } catch (error) {
        if (strict) throw error;
        return null;
    }
}

// ========================================
// LOREBOOK FETCH
// ========================================

/**
 * A lorebook project's book through the metadata API: every download route 404s for a lorebook, so the metadata IS the download.
 * @param {string|number} ref - the project's path (lorebooks/creator/slug) or its numeric id
 * @returns {Promise<Object|null>} character_book object or null
 */
export async function fetchChubLorebookBook(ref) {
    const target = /^\d+$/.test(String(ref)) ? `lorebooks/${ref}` : ref;
    const resp = await fetchWithProxy(`${CHUB_API_BASE}/api/${target}?full=true`, { headers: getChubHeaders(true) });
    return (await readJsonClassified(resp))?.node?.definition?.embedded_lorebook || null;
}

/**
 * The book in the card's own export (card.json via the V4 Git API), the one source of a private linked book; rate limited hard.
 * @param {number} projectId - Chub project/character numeric ID
 * @returns {Promise<Object|null>} character_book object or null
 */
async function fetchChubLinkedLorebook(projectId) {
    if (!projectId) return null;
    const headers = getChubHeaders(true);
    // Proxy only when fetch itself rejects (CORS/network); an HTTP error is a valid answer, not a proxy trigger.
    const tryFetch = async (url) => {
        try { return await fetch(url, { headers }); }
        catch (e) {
            if (e.name === 'AbortError') throw e;
            return await fetch(proxiedUrl(url), { headers });
        }
    };
    // a failed read throws, so an import can say it came in without the book; null is a card with none
    const commitsResp = await tryFetch(`${CHUB_API_BASE}/api/v4/projects/${projectId}/repository/commits`);
    if (!commitsResp.ok) throw new Error(`chub answered HTTP ${commitsResp.status} for the card's history`);
    const commits = await commitsResp.json();
    const ref = Array.isArray(commits) && commits[0]?.id;
    if (!ref) return null;

    const cardResp = await tryFetch(`${CHUB_API_BASE}/api/v4/projects/${projectId}/repository/files/raw%252Fcard.json/raw?ref=${ref}`);
    if (!cardResp.ok) throw new Error(`chub answered HTTP ${cardResp.status} for the card file`);
    const card = await cardResp.json();
    const book = card?.data?.character_book || card?.character_book || null;
    if (book) {
        CoreAPI.debugLog('[Chub] Resolved linked lorebook from V4 Git API for project', projectId, `- ${book.entries?.length ?? 0} entries`);
    }
    return book;
}

/**
 * The card's whole book as chub's export lays it out: the embedded entries, then each linked book's, numbered through.
 * @param {Object} apiData - Metadata object from fetchChubMetadata()
 * @param {{missing?: string[]}} [opts] - collects what could not be fetched, for the import to say
 * @returns {Promise<Object|undefined>} character_book object
 */
export async function resolveChubCharacterBook(apiData, { missing = null } = {}) {
    const embedded = apiData.definition?.embedded_lorebook || undefined;
    // -1 stands for the embedded book, which the metadata already carries
    const ids = (apiData.related_lorebooks || []).filter(id => Number(id) > 0);
    if (!ids.length) return embedded;
    const linked = [];
    let unread = false;
    for (const id of ids) {
        try {
            const book = await fetchChubLorebookBook(id);
            if (book) linked.push(book); else unread = true;
        } catch (e) {
            CoreAPI.debugLog('[Chub] Linked lorebook', id, 'unreadable from the metadata API:', e.message);
            unread = true;
        }
    }
    if (unread) {
        // a private book 404s for everyone but its owner, only the export carries it
        try {
            const exported = await fetchChubLinkedLorebook(apiData.id);
            if (exported?.entries?.length) return exported;
        } catch (e) {
            console.warn('[Chub] Failed to fetch linked lorebook for', apiData.fullPath, e);
        }
        missing?.push('its linked lorebook');
    }
    const first = embedded || linked[0];
    if (!first) return undefined;
    const entries = [
        ...(embedded?.entries || []),
        ...linked.flatMap(b => (b.entries || []).map(e => ({ ...e, extensions: { ...e.extensions, linked: true, embedded: false } }))),
    ].map((e, i) => ({ ...e, id: i + 1 }));
    return { ...first, entries };
}

// ========================================
// GALLERY FETCH
// ========================================

// ========================================
// V2 CARD BUILDER
// ========================================

/**
 * Build a V2 card from chub metadata; chub's own field names map onto V2 (definition.personality is the body).
 * @param {Object} apiData - Metadata object from fetchChubMetadata()
 * @param {{missing?: string[]}} [opts] - collects what could not be fetched, for the import to say
 * @returns {Promise<Object>} V2-spec character card { spec, spec_version, data }
 */
export async function buildCharacterCardFromChub(apiData, { missing = null } = {}) {
    const def = apiData.definition || {};
    const characterBook = await resolveChubCharacterBook(apiData, { missing });

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: def.name || apiData.name || 'Unknown',
            description: def.personality || '',
            personality: def.tavern_personality || '',
            scenario: def.scenario || '',
            first_mes: def.first_message || '',
            mes_example: def.example_dialogs || '',
            creator_notes: def.description || '',
            system_prompt: def.system_prompt || '',
            post_history_instructions: def.post_history_instructions || '',
            alternate_greetings: def.alternate_greetings || [],
            tags: apiData.topics || [],
            creator: apiData.fullPath?.split('/')[0] || '',
            character_version: def.character_version || '',
            extensions: {
                ...(def.extensions || {}),
                chub: {
                    ...(def.extensions?.chub || {}),
                    tagline: apiData.tagline || def.tagline || ''
                }
            },
            character_book: characterBook,
        }
    };
}
