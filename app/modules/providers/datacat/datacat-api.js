// Shared DataCat API utilities - used by datacat-provider.js and datacat-browse.js
//
// Sections: Network, Metadata, Browse/Search, Tags, V2 Card Builder, Extraction, MeiliSearch

import CoreAPI from '../../core-api.js';
import { PROVIDER_SERVICES_BASE, stripHtml, decodeHtmlEntities, readJsonClassified, httpFailureError } from '../provider-utils.js';
import { meiliMultiSearch, TAG_MAP as JANNY_TAG_MAP } from '../janny/janny-api.js';
// a DataCat row carries JanitorAI's scripts, so its lorebook reads the way JanitorAI's does
import { hasUnfetchedLorebook, extractCharacterBookFromScripts, HAMPTER_SCRIPT_PATH_RE } from '../janitorai/janitorai-api.js';

export { stripHtml, JANNY_TAG_MAP, hasUnfetchedLorebook, extractCharacterBookFromScripts };

// ========================================
// CONSTANTS
// ========================================

export const DATACAT_API_BASE = 'https://datacat.run';

// a JanitorAI avatar is a bare filename under this base, a DataCat-hosted one a full URL; resolve via resolveDatacatAvatarUrl
export const DATACAT_JANITOR_IMAGE_BASE = 'https://ella.janitorai.com/bot-avatars/';

/**
 * Resolve a hit's avatar URL by source: full URLs pass, JanitorAI filenames get the ella prefix.
 * @param {Object} hit - DataCat character object (listing or detail)
 * @returns {string|null} Full URL or null if no avatar
 */
export function resolveDatacatAvatarUrl(hit, opts = {}) {
    // preferOriginal (import, viewer): the embedded V2 json points at the janitorai original, over the 640px card variant
    const absOnly = (c) => (typeof c === 'string' && /^https?:\/\//i.test(c) ? c : null);
    const candidates = opts.preferOriginal
        ? [
            absOnly(hit?.chara_card_v2_json?.data?.avatar),
            absOnly(hit?.content_variants?.[0]?.content?.chara_card_v2_json?.data?.avatar),
            hit?.avatar_variant_urls?.hero || hit?.avatarVariantUrls?.hero,
            hit?.avatar,
        ]
        : [hit?.avatar];
    for (const avatar of candidates) {
        if (!avatar || typeof avatar !== 'string') continue;
        let url = /^https?:\/\//i.test(avatar) ? avatar : `${DATACAT_JANITOR_IMAGE_BASE}${avatar}`;
        const safety = CoreAPI.isUrlSafeForDownload(url);
        if (!safety.ok) continue;
        // grid cards ask janitorai for a thumbnail (its originals chug the grid); datacat-native rows are already card.webp
        if (opts.width && /(^|\.)janitorai\.com$/i.test((() => { try { return new URL(url).hostname; } catch { return ''; } })())) {
            url += (url.includes('?') ? '&' : '?') + `width=${opts.width}`;
        }
        return url;
    }
    return null;
}

// Minimum token threshold for quality filtering (matches DataCat's own frontend default)
export const MIN_TOTAL_TOKENS = 889;

// ========================================
// NETWORK
// ========================================

const DC_PROXY_BASE = `${PROVIDER_SERVICES_BASE}/dc-proxy`;

let _apiRequest = null;
let _getSavedToken = null;
let _bootstrapInFlight = null;

/**
 * Bind the CoreAPI.apiRequest function for use in proxied requests.
 * Called once from the provider's init().
 */
export function setApiRequest(fn) { _apiRequest = fn; }

/**
 * Bind a getter for the saved token, so dcFetch can bootstrap for callers outside the browse view.
 */
export function setSavedTokenGetter(fn) { _getSavedToken = fn; }

/**
 * Push the saved token (or a fresh anonymous one) into the service; concurrent callers share one in-flight bootstrap.
 */
async function tryBootstrapSession() {
    if (_bootstrapInFlight) return _bootstrapInFlight;
    _bootstrapInFlight = (async () => {
        try {
            const savedToken = _getSavedToken?.() ?? null;
            return !!(await initDcSession(savedToken));
        } catch {
            return false;
        } finally {
            _bootstrapInFlight = null;
        }
    })();
    return _bootstrapInFlight;
}

/**
 * Fetch a DataCat API path through the provider service proxy.
 * On 401/403, attempts to bootstrap a session once and retries.
 * @param {string} apiPath - Path relative to datacat.run (e.g. /api/characters/recent-public?...)
 * @returns {Promise<Response>}
 */
async function dcFetch(apiPath) {
    if (!_apiRequest) throw new Error('DataCat: apiRequest not bound');
    let resp = await _apiRequest(`${DC_PROXY_BASE}${apiPath}`);
    if (resp.status === 401 || resp.status === 403) {
        if (await tryBootstrapSession()) {
            resp = await _apiRequest(`${DC_PROXY_BASE}${apiPath}`);
        }
    }
    if (!resp.ok) {
        const body = await resp.clone().text().catch(() => '');
        console.warn(`[DataCat] dcFetch ${resp.status} for ${apiPath}`, body.slice(0, 500));
    }
    return resp;
}

/**
 * Push the saved token and validate it: 'valid', 'invalid' (refused, the only answer that may cost it) or 'transient'.
 * @param {string} savedToken - the saved session token
 * @returns {Promise<'valid'|'invalid'|'transient'>}
 */
async function restoreSavedToken(savedToken) {
    if (!savedToken || typeof savedToken !== 'string') return 'invalid';
    try {
        const setResp = await _apiRequest(`${PROVIDER_SERVICES_BASE}/dc-set-token`, 'POST', { token: savedToken });
        if (!setResp.ok) return 'transient';

        const valResp = await _apiRequest(`${PROVIDER_SERVICES_BASE}/dc-validate`);
        if (!valResp.ok) return 'transient';
        const data = await valResp.json();
        if (data?.valid === true) return 'valid';
        // an answer with no kind is treated as transient: never mint over a token nobody judged
        return data?.definitive === true ? 'invalid' : 'transient';
    } catch {
        return 'transient';
    }
}

/**
 * Initialize a session: restore the saved token first, else request a fresh one; answers the token to persist.
 * @param {string} [savedToken] - the saved session token to try first
 * @param {boolean} [force] - Force a new token even if one is cached
 * @returns {Promise<string|null>} The active session token, or null on failure
 */
export async function initDcSession(savedToken, force = false) {
    try {
        // Try restoring a saved token first (unless forcing refresh)
        if (savedToken && !force) {
            const restored = await restoreSavedToken(savedToken);
            if (restored === 'valid') return savedToken;
            // a transient answer keeps the saved token for a later try; minting here would replace a good one on every blip
            if (restored === 'transient') return null;
        }

        const resp = await _apiRequest(`${PROVIDER_SERVICES_BASE}/dc-init`, 'POST', force ? { force: true } : undefined);
        if (!resp.ok) return null;
        const data = await resp.json();
        if (data?.ok && data?.token) return data.token;
        return null;
    } catch {
        return null;
    }
}

/**
 * Validate the current DataCat session on the server.
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function validateDcSession() {
    try {
        const resp = await _apiRequest(`${PROVIDER_SERVICES_BASE}/dc-validate`);
        if (!resp.ok) return { valid: false, reason: 'request failed' };
        return await resp.json();
    } catch {
        return { valid: false, reason: 'network error' };
    }
}

/**
 * Clear the DataCat session token from the service.
 * @returns {Promise<boolean>}
 */
export async function clearDcSession() {
    try {
        const resp = await _apiRequest(`${PROVIDER_SERVICES_BASE}/dc-clear-token`, 'POST');
        return resp.ok;
    } catch {
        return false;
    }
}

// ========================================
// JANITORAI ACCOUNT AUTH (Supabase GoTrue)
// ========================================
// Unlocks page 2+ of the Hampter sorts. JanitorAI auth is Supabase; the
// anon key below is their PUBLIC publishable key (role:anon), shipped in the janitorai
// frontend bundle, safe to embed. Login/refresh hit supabase.co directly (CORS *, and it is
// NOT behind JanitorAI's Cloudflare bot gate), so the whole flow is client-side, no service route.
// Access tokens live ~3h; the refresh token rotates on every use, so callers must persist the
// new one each refresh. Pure HTTP here; the stateful session layer lives in datacat-provider.

const JANITORAI_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jbXp4dHpvbW1wbnhreW5kZGJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjgzNzA3NDAsImV4cCI6MjA0Mzk0Njc0MH0.UfRPni4ga9Lmin8j0JjV5ouuK9bXp8tsqPJ8pMTDDAI';
const JANITORAI_AUTH_BASE = 'https://mcmzxtzommpnxkynddbo.supabase.co/auth/v1';
const JANITORAI_TOKEN_URL = `${JANITORAI_AUTH_BASE}/token`;

function janitoraiAuthHeaders() {
    return { 'apikey': JANITORAI_ANON_KEY, 'Authorization': `Bearer ${JANITORAI_ANON_KEY}`, 'Content-Type': 'application/json' };
}

/** Decode a JanitorAI access-token JWT's claims (email + exp ms). Empty on failure. */
export function decodeJanitoraiClaims(jwt) {
    try {
        const p = JSON.parse(atob(String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        return { email: p.email || '', expMs: (p.exp || 0) * 1000 };
    } catch { return { email: '', expMs: 0 }; }
}

// no direct password login (Turnstile is domain-locked): the session comes from a real browser's cookie, kept by refresh grants

function janitoraiB64decode(s) {
    let t = s.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    return atob(t);
}

/**
 * The token pair from a pasted session: the cookie value (base64-<json>), raw session JSON, or a bare access JWT (no refresh).
 * @returns {{access_token: string, refresh_token: string}|null}
 */
export function parseJanitoraiSession(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let s = raw.trim();
    if (s.startsWith('base64-')) s = s.slice('base64-'.length);
    let json = null;
    try {
        const dec = janitoraiB64decode(s);
        if (dec.includes('access_token')) json = JSON.parse(dec);
    } catch { /* not base64 json */ }
    if (!json && s.startsWith('{')) {
        try { json = JSON.parse(s); } catch { /* not json */ }
    }
    if (json?.access_token) {
        return { access_token: json.access_token, refresh_token: json.refresh_token || '' };
    }
    const jm = s.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    return jm ? { access_token: jm[0], refresh_token: '' } : null;
}

/**
 * Exchange a (single-use, rotating) refresh token for a fresh pair. `dead` marks a
 * revoked/expired refresh token so the caller can clear the stored session.
 * @returns {Promise<{access_token: string, refresh_token: string, dead?: boolean}>}
 */
export async function janitoraiRefreshGrant(refreshToken) {
    if (!refreshToken) return { access_token: '', refresh_token: '', dead: true };
    let resp;
    try {
        resp = await fetch(`${JANITORAI_TOKEN_URL}?grant_type=refresh_token`, {
            method: 'POST', headers: janitoraiAuthHeaders(), body: JSON.stringify({ refresh_token: refreshToken }),
        });
    } catch (e) {
        return { access_token: '', refresh_token: '', dead: false }; // transient; keep the token for retry
    }
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.access_token) {
        const dead = resp.status === 400 || resp.status === 401;
        return { access_token: '', refresh_token: '', dead };
    }
    return { access_token: data.access_token, refresh_token: data.refresh_token || refreshToken };
}

/**
 * Check an access token against the auth service, off Cloudflare: a hampter probe cant tell a bad token from a block.
 * @returns {Promise<{valid: boolean, transient?: boolean}>} transient = auth service unreachable or erroring (429/5xx)
 */
export async function janitoraiVerifyToken(accessToken) {
    if (!accessToken) return { valid: false };
    let resp;
    try {
        resp = await fetch(`${JANITORAI_AUTH_BASE}/user`, {
            headers: { 'apikey': JANITORAI_ANON_KEY, 'Authorization': `Bearer ${accessToken}` },
        });
    } catch {
        return { valid: false, transient: true };
    }
    if (resp.ok) return { valid: true };
    return { valid: false, transient: resp.status === 429 || resp.status >= 500 };
}

// ========================================
// METADATA FETCH
// ========================================

/**
 * Fetch full character data from the DataCat REST API.
 * @param {string} characterId - UUID
 * @param {string|null} [sourceKind] - upstream source hint ('janitor'); required for freshly-extracted chars
 * @returns {Promise<Object|null>} character object or null
 */
export async function fetchDatacatCharacter(characterId, sourceKind = null, { strict = false } = {}) {
    if (!characterId) return null;
    try {
        const qs = sourceKind ? `?sourceKind=${encodeURIComponent(sourceKind)}` : '';
        const response = await dcFetch(`/api/characters/${characterId}${qs}`);
        if (!response.ok) {
            if (strict) throw httpFailureError(response.status, await response.text().catch(() => ''));
            return null;
        }
        const data = await response.json();
        return data?.character || null;
    } catch (e) {
        if (strict) throw e;
        console.error('[DataCat] fetchDatacatCharacter failed:', characterId, e);
        return null;
    }
}

/**
 * Fetch the V2-like download payload for a character.
 * @param {string} characterId - UUID
 * @param {string|null} [sourceKind] - upstream source hint ('janitor')
 * @returns {Promise<Object|null>} { data: { name, tags, avatar, ... } }
 */
export async function fetchDatacatDownload(characterId, sourceKind = null, { strict = false } = {}) {
    if (!characterId) return null;
    try {
        const params = new URLSearchParams({ t: String(Date.now()) });
        if (sourceKind) params.set('sourceKind', sourceKind);
        const response = await dcFetch(`/api/characters/${characterId}/download?${params.toString()}`);
        if (!response.ok) {
            if (strict) throw httpFailureError(response.status, await response.text().catch(() => ''));
            return null;
        }
        return response.json();
    } catch (e) {
        if (strict) throw e;
        console.error('[DataCat] fetchDatacatDownload failed:', characterId, e);
        return null;
    }
}

/**
 * Fetch creator profile.
 * @param {string} creatorId - UUID
 * @returns {Promise<Object|null>}
 */
export async function fetchDatacatCreator(creatorId) {
    if (!creatorId) return null;
    try {
        const response = await dcFetch(`/api/creators/${creatorId}`);
        if (!response.ok) return null;
        const data = await response.json();
        return data?.creator || null;
    } catch (e) {
        console.error('[DataCat] fetchDatacatCreator failed:', creatorId, e);
        return null;
    }
}

/**
 * Fetch a creator's character list (paginated).
 * @param {string} creatorId - UUID
 * @param {Object} [opts]
 * @param {number} [opts.limit=24]
 * @param {number} [opts.offset=0]
 * @param {string} [opts.sortBy='chat_count']
 * @returns {Promise<{total: number, list: Object[]}|null>} null only for a missing id; failures throw classified errors
 */
export async function fetchDatacatCreatorCharacters(creatorId, opts = {}) {
    if (!creatorId) return null;
    const { limit = 24, offset = 0, sortBy = 'chat_count' } = opts;
    const response = await dcFetch(`/api/creators/${creatorId}/characters?limit=${limit}&offset=${offset}&sortBy=${sortBy}`);
    const data = await readJsonClassified(response);
    return { total: data.total || 0, list: data.list || [] };
}

// ========================================
// BROWSE / SEARCH
// ========================================

/**
 * Fetch recent public characters (the main browse endpoint).
 * @param {Object} [opts]
 * @param {number} [opts.limit=24]
 * @param {number} [opts.offset=0]
 * @param {number[]} [opts.tagIds] - Active tag ID filters
 * @param {string} [opts.search] - Full text search (matches character AND creator names)
 * @param {string} [opts.sortBy] - Result order; the endpoint honors only 'score' (verified live)
 * @param {number} [opts.minTotalTokens=MIN_TOTAL_TOKENS]
 * @returns {Promise<{totalCount: number, characters: Object[]}>} failures throw classified errors
 */
export async function fetchRecentPublic(opts = {}) {
    const { limit = 24, offset = 0, tagIds = [], search = '', sortBy = '', minTotalTokens = MIN_TOTAL_TOKENS } = opts;
    let path = `/api/characters/recent-public?limit=${limit}&offset=${offset}&summary=1&minTotalTokens=${minTotalTokens}`;
    if (tagIds.length > 0) path += `&tagIds=${tagIds.join(',')}`;
    if (search) path += `&search=${encodeURIComponent(search)}`;
    if (sortBy) path += `&sortBy=${encodeURIComponent(sortBy)}`;
    const response = await dcFetch(path);
    const data = await readJsonClassified(response);
    return { totalCount: data.totalCount || 0, characters: data.characters || [] };
}

/**
 * Fetch fresh/sorted characters from the /fresh endpoint.
 * Returns two time windows: last24h and thisWeek.
 * @param {Object} [opts]
 * @param {string} [opts.sortBy='score'] - 'score' | 'fresh' | 'chat_count'
 * @param {number} [opts.limit24=80] - Max characters for last-24h window
 * @param {number} [opts.limitWeek=20] - Max characters for this-week window
 * @returns {Promise<{sortBy: string, last24h: Object[], thisWeek: Object[]}>} failures throw classified errors
 */
export async function fetchFreshCharacters(opts = {}) {
    const { sortBy = 'score', limit24 = 80, limitWeek = 20 } = opts;
    const path = `/api/characters/fresh?summary=1&sortBy=${sortBy}&limit24=${limit24}&limitWeek=${limitWeek}`;
    const response = await dcFetch(path);
    const data = await readJsonClassified(response);
    const w = data.windows || {};
    return {
        sortBy: data.sortBy || sortBy,
        last24h: w.last24h?.characters || [],
        thisWeek: w.thisWeek?.characters || [],
    };
}

/**
 * Fetch faceted tag list with counts (optionally narrowed by active tags).
 * @param {Object} [opts]
 * @param {number[]} [opts.activeTagIds] - Currently selected tag IDs (adjusts counts)
 * @param {number} [opts.minTotalTokens=MIN_TOTAL_TOKENS]
 * @returns {Promise<{groups: Object[], tags: Object[]}|null>}
 */
export async function fetchFacetedTags(opts = {}) {
    const { activeTagIds = [], minTotalTokens = MIN_TOTAL_TOKENS } = opts;
    try {
        let path = `/api/tags/faceted?mode=recent&minTotalTokens=${minTotalTokens}`;
        if (activeTagIds.length > 0) path += `&activeTagIds=${activeTagIds.join(',')}`;
        const response = await dcFetch(path);
        if (!response.ok) return null;
        const data = await response.json();
        return { groups: data.groups || [], tags: data.tags || [] };
    } catch (e) {
        console.error('[DataCat] fetchFacetedTags failed:', e);
        return null;
    }
}

// ========================================
// TAG HELPERS
// ========================================

/**
 * Plain tag names: JanitorAI sends {id, name, slug} objects (emoji-prefixed names); a plain string passes as is.
 * @param {Array<{name: string, slug: string}|string>} tags
 * @returns {string[]}
 */
export function resolveTagNames(tags) {
    if (!Array.isArray(tags)) return [];
    return tags.map(t => {
        if (typeof t === 'string') return t.trim();
        const name = t?.name || t?.slug || '';
        return name.replace(/^[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D]+\s*/u, '').trim() || name;
    }).filter(Boolean);
}

// ========================================
// V2 CARD BUILDER
// ========================================

/**
 * The row's active content variant; a janitor variant's description mirrors the row blurb, never the body.
 * @returns {Object|null} The variant content object, or null when no non-placeholder primary variant is present.
 */
export function pickRecoveryVariant(character) {
    const variants = character?.content_variants;
    if (!Array.isArray(variants) || !variants.length) return null;
    const primary = variants.find(v => v && v.isPrimary && !v.isRecoveryPlaceholder);
    return primary?.content || null;
}

// Recovery-sourced chara_card_v2_json bodies carry edge ##DESCRIPTION START##-style delimiter lines; /download bodies never do.
export function stripDatacatMarkers(text) {
    if (!text || typeof text !== 'string') return text || '';
    return text
        .replace(/^\s*##[A-Z _]*(?:START|END)##[ \t]*\r?\n?/, '')
        .replace(/\r?\n?[ \t]*##[A-Z _]*(?:START|END)##\s*$/, '')
        .trim();
}

/**
 * Fetch missing lorebook content from janitorai (api_path) onto the row's scripts; a plain direct fetch, the proxy leg always 403s.
 * @returns {Promise<boolean>} true when no public lorebook is left unfetched
 */
export async function hydrateDatacatScripts(character, { signal } = {}) {
    const scripts = character?.scripts;
    if (!Array.isArray(scripts) || !scripts.length) return true;
    for (const s of scripts) {
        if (!s || s.type !== 'lorebook' || !s.is_public || s.script) continue;
        // Listed publicly but the creator locked the content; hampter serves metadata only.
        if (s.is_code_public === false) continue;
        if (typeof s.api_path !== 'string' || !HAMPTER_SCRIPT_PATH_RE.test(s.api_path)) continue;
        try {
            const resp = await fetch(`https://janitorai.com${s.api_path}`, {
                signal,
                headers: { 'Accept': 'application/json' },
            });
            if (!resp.ok) {
                console.warn('[DataCat] script hydration got HTTP', resp.status, 'for', s.api_path);
                continue;
            }
            const full = await resp.json();
            if (typeof full?.script === 'string' && full.script) {
                s.script = full.script;
                if (!s.settings && typeof full.settings === 'string') s.settings = full.settings;
            } else {
                console.warn('[DataCat] script hydration returned no content for', s.api_path);
            }
        } catch (e) {
            // leave unfetched; consumers flag it via hasUnfetchedLorebook
            console.warn('[DataCat] script hydration failed for', s.api_path, e?.message || e);
        }
    }
    return !hasUnfetchedLorebook(character);
}

/**
 * Build a V2 card from the character endpoint payload: personality carries the body, description the blurb.
 * @param {Object} character - Character object from /api/characters/:id
 * @returns {Object} V2-spec character card { spec, spec_version, data }
 */
export function buildV2FromDatacat(character) {
    if (!character) return null;

    const tagNames = resolveTagNames(character.tags);
    const recovered = pickRecoveryVariant(character);
    const v2Data = character?.chara_card_v2_json?.data || null;

    // janitor variants mirror the row blurb in description, never the body
    const description = character.personality || recovered?.personality || stripDatacatMarkers(v2Data?.description) || '';
    const scenario = character.scenario || recovered?.scenario || v2Data?.scenario || '';
    const firstMessage = character.first_message || recovered?.first_message || v2Data?.first_mes || '';
    const creatorNotes = character.description || recovered?.description || v2Data?.creator_notes || '';
    const altGreetings = [character.alternate_greetings, recovered?.alternate_greetings, v2Data?.alternate_greetings]
        .find(a => Array.isArray(a) && a.length) || [];

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: character.chat_name || character.chatName || character.name || 'Unknown',
            description,
            personality: '',
            scenario,
            first_mes: firstMessage,
            mes_example: '',
            system_prompt: '',
            post_history_instructions: '',
            creator_notes: creatorNotes,
            creator: character.creator_name || character.creatorName || '',
            character_version: '1.0',
            tags: tagNames,
            alternate_greetings: altGreetings,
            extensions: {
                datacat: {
                    id: character.character_id || character.characterId,
                    sourceKind: character.primary_content_source_kind || null,
                    creatorId: character.creator_id || character.creatorId || null,
                    creatorName: character.creator_name || character.creatorName || null
                }
            },
            character_book: extractCharacterBookFromScripts(character) || undefined
        }
    };
}

/**
 * Build a V2 card from /download; an empty body falls back to the row and its recovery variant.
 * @param {Object} downloadData - Response from /api/characters/:id/download
 * @param {Object} [character] - Optional character metadata for enrichment
 * @returns {Object|null}
 */
export function buildV2FromDownload(downloadData, character) {
    const d = downloadData?.data;
    if (!d) return null;

    const recovered = character ? pickRecoveryVariant(character) : null;
    const v2Data = character?.chara_card_v2_json?.data || null;
    // Old downloads carry the janitor body in personality, new ones are proper V2 (personality empty), so the || order covers both shapes, dont reorder.
    const description = d.personality || d.description
        || character?.personality || recovered?.personality || stripDatacatMarkers(v2Data?.description) || '';
    const scenario = d.scenario || recovered?.scenario || '';
    const firstMes = d.first_mes || recovered?.first_message || '';
    const creatorNotes = d.creator_notes || character?.description || '';
    // New downloads ship URLs in creator/character_version; the real creator name lives in download metadata.
    const isUrl = (s) => typeof s === 'string' && /^https?:\/\//i.test(s);
    const creatorName = character?.creator_name || character?.creatorName
        || downloadData?.metadata?.janitor_creator_name
        || (isUrl(d.creator) ? '' : (d.creator || ''));
    const cardVersion = (d.character_version && !isUrl(d.character_version)) ? d.character_version : '1.0';

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: d.name || character?.chat_name || character?.chatName || character?.name || 'Unknown',
            description,
            personality: '',
            scenario,
            first_mes: firstMes,
            mes_example: d.mes_example || '',
            system_prompt: d.system_prompt || '',
            post_history_instructions: d.post_history_instructions || '',
            creator_notes: creatorNotes,
            creator: creatorName,
            character_version: cardVersion,
            tags: d.tags || [],
            alternate_greetings: d.alternate_greetings || [],
            extensions: {
                ...(d.extensions || {}),
                datacat: {
                    id: character?.character_id || character?.characterId || null,
                    sourceKind: character?.primary_content_source_kind || null,
                    creatorId: character?.creator_id || character?.creatorId || null,
                    creatorName: character?.creator_name || character?.creatorName || null
                }
            },
            // Download's character_book is often present-but-empty; fall through to scripts.
            character_book: (d.character_book?.entries?.length ? d.character_book : null)
                || extractCharacterBookFromScripts(character)
                || undefined
        }
    };
}

// ========================================
// EXTRACTION
// ========================================

/**
 * Submit a JanitorAI character URL for extraction via DataCat's cloud browser.
 * @param {string} janitorUrl - Full JanitorAI character URL
 * @param {Object} [opts]
 * @param {boolean} [opts.publicFeed=true]
 * @param {boolean} [opts.alwaysReextract=false] - force re-extraction even if DataCat already has the character
 * @returns {Promise<{success: boolean, queued?: boolean, started?: boolean, queuePosition?: number, requestId?: string, error?: string, errorCode?: string}>}
 */
export async function submitExtraction(janitorUrl, { publicFeed = true, alwaysReextract = false } = {}) {
    if (!_apiRequest) throw new Error('DataCat: apiRequest not bound');
    try {
        const resp = await _apiRequest(`${PROVIDER_SERVICES_BASE}/dc-extract`, 'POST', { url: janitorUrl, publicFeed, alwaysReextract });
        if (!resp.ok) {
            const errText = await resp.text();
            console.error('[DataCat] dc-extract error:', resp.status, errText.substring(0, 200));
            return { success: false, error: `Server returned ${resp.status}: ${errText.substring(0, 100)}` };
        }
        try {
            return await resp.json();
        } catch {
            return { success: false, error: 'Invalid JSON response from the DataCat service' };
        }
    } catch (e) {
        console.error('[DataCat] submitExtraction failed:', e);
        return { success: false, error: e.message };
    }
}

/**
 * Poll extraction status from DataCat.
 * @returns {Promise<{inProgress: Object|null, queueLength: number, queue: Array, history: Array}|null>}
 */
export async function fetchExtractionStatus() {
    try {
        const resp = await dcFetch('/api/extraction/status-projection');
        if (!resp.ok) return null;
        return await resp.json();
    } catch (e) {
        console.error('[DataCat] fetchExtractionStatus failed:', e);
        return null;
    }
}

// ========================================
// MEILISEARCH (JanitorAI index)
// ========================================

const MEILI_SORT_MAP = {
    janny_newest: ['createdAtStamp:desc'],
    janny_oldest: ['createdAtStamp:asc'],
    janny_tokens_desc: ['totalToken:desc'],
    janny_tokens_asc: ['totalToken:asc'],
    janny_relevant: [],
};

/**
 * Search JanitorAI characters via MeiliSearch.
 * Returns results normalized to DataCat-compatible shape.
 * @param {Object} opts
 * @param {string} [opts.search='']
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=80]
 * @param {string} [opts.sort='janny_newest']
 * @param {boolean} [opts.nsfw=true]
 * @param {Set<number>} [opts.includeTags] - JanitorAI tag IDs to require
 * @returns {Promise<{characters: Object[], totalHits: number, totalPages: number}>}
 */
export async function searchMeiliJanny(opts = {}) {
    const { search = '', page = 1, limit = 80, sort = 'janny_newest', nsfw = true, includeTags = new Set() } = opts;

    const filters = [];
    if (!nsfw) filters.push('isNsfw = false');
    if (includeTags.size > 0) {
        const tagClauses = [...includeTags].map(id => `tagIds = ${id}`);
        filters.push(tagClauses.join(' AND '));
    }

    const data = await meiliMultiSearch({
        search,
        page,
        limit,
        filters,
        facets: ['isNsfw', 'tagIds'],
        sort: MEILI_SORT_MAP[sort] || MEILI_SORT_MAP.janny_newest,
    });
    const result = data?.results?.[0] || {};
    const hits = result.hits || [];

    const characters = hits.map(normalizeMeiliHit);

    return {
        characters,
        totalHits: result.totalHits || 0,
        totalPages: result.totalPages || 0,
    };
}

// ========================================
// HAMPTER (JanitorAI internal API)
// ========================================

const HAMPTER_API_BASE = 'https://janitorai.com/hampter/characters';

/**
 * Fetch characters from JanitorAI's Hampter API (trending/popular sort).
 * @param {Object} opts
 * @param {string} [opts.sort='trending'] - 'trending' or 'popular'
 * @param {number} [opts.page=1]
 * @param {string} [opts.search='']
 * @param {boolean} [opts.nsfw=true] - false adds mode=sfw
 * @param {string} [opts.authToken] - JanitorAI bearer; unlocks page 2+ of these sorts
 * @returns {Promise<{characters: Object[], total: number, page: number, pageSize: number}>}
 */
export async function fetchHampterCharacters(opts = {}) {
    const { sort = 'trending', page = 1, search = '', nsfw = true, authToken = '' } = opts;
    const params = new URLSearchParams({ sort, page: String(page) });
    if (search) params.set('search', search);
    if (!nsfw) params.set('mode', 'sfw');

    const url = `${HAMPTER_API_BASE}?${params}`;
    let data;

    if (data === undefined) {
        // best-effort direct fetch only: a cross-origin fetch cant send janitorai's cf_clearance, so Cloudflare usually 403s it
        const headers = { 'Accept': 'application/json' };
        if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
        let response = null;
        try {
            response = await fetch(url, { headers });
        } catch { response = null; }
        if (!response || !response.ok) {
            const status = response?.status ?? 0;
            if (status === 401) {
                // With a token, 401 means it expired/was rejected; without, its the anon page-1 wall.
                const gated = new Error(authToken ? 'JanitorAI session expired' : 'JanitorAI requires signing in for this request');
                gated.code = authToken ? 'HAMPTER_TOKEN_EXPIRED' : 'HAMPTER_LOGIN_REQUIRED';
                gated.status = 401;
                throw gated;
            }
            const blocked = new Error(status ? `Hampter HTTP ${status}` : 'Hampter direct fetch failed');
            blocked.code = 'HAMPTER_BLOCKED';
            blocked.status = status;
            throw blocked;
        }
        data = await response.json();
    }

    return {
        characters: (data.data || []).map(normalizeHampterHit),
        total: data.total || 0,
        page: data.page || page,
        pageSize: data.size || 34,
    };
}

function normalizeHampterHit(hit) {
    const tagNames = [
        ...(hit.tags || []).map(t => ({ name: t.name, slug: t.slug || t.name?.toLowerCase() })),
        ...(hit.custom_tags || []).map(t => typeof t === 'string' ? { name: t, slug: t.toLowerCase() } : { name: t.name || '', slug: t.slug || '' }),
    ];

    return {
        character_id: hit.id,
        name: decodeHtmlEntities(hit.name || 'Unknown'),
        avatar: hit.avatar || '',
        description: decodeHtmlEntities(hit.description || ''),
        tags: tagNames,
        creator_name: decodeHtmlEntities(hit.creator_name || ''),
        creator_id: hit.creator_id || '',
        created_at: hit.created_at || hit.first_published_at || '',
        is_nsfw: hit.is_nsfw || false,
        chat_count: hit.stats?.chat || 0,
        message_count: hit.stats?.message || 0,
        total_tokens: hit.total_tokens || 0,
        _source: 'hampter',
    };
}

/**
 * Normalize a MeiliSearch hit to match the shape expected by DataCat card rendering.
 */
function normalizeMeiliHit(hit) {
    const tagNames = (hit.tagIds || []).map(id => {
        const name = JANNY_TAG_MAP[id];
        return name ? { name, slug: name.toLowerCase() } : { name: `Tag ${id}`, slug: `tag-${id}` };
    });

    return {
        character_id: hit.id,
        name: decodeHtmlEntities(hit.name || 'Unknown'),
        avatar: hit.avatar || '',
        description: decodeHtmlEntities(hit.description || ''),
        tags: tagNames,
        creator_name: decodeHtmlEntities(hit.creatorUsername || ''),
        creator_id: hit.creatorId || '',
        createdAt: hit.createdAt || (hit.createdAtStamp ? new Date(hit.createdAtStamp * 1000).toISOString() : ''),
        isNsfw: hit.isNsfw || false,
        totalTokens: hit.totalToken || 0,
        _source: 'meilisearch',
    };
}
