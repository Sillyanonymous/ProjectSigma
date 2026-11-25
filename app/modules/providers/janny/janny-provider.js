// JannyAI Provider: MeiliSearch search, the card page scraped for details; no version history, no gallery

import CoreAPI from '../../core-api.js';
import { ProviderBase } from '../provider-interface.js';
import { importFromPng, proxiedUrl, hasBrowserEndpoint, classifyErrorPage, parseProviderUrl, decodeHtmlEntities } from '../provider-utils.js';
import jannyBrowseView from './janny-browse.js';
import {
    JANNY_IMAGE_BASE,
    jannyCharacterUrl,
    jannyFullPath,
    jannyNameFromSlug,
    jannyPathParts,
    meiliMultiSearch,
    fetchWithProxy,
    slugify,
    stripHtml,
    resolveTagNames
} from './janny-api.js';

// ========================================
// PRIVATE UTILITIES
// ========================================

/**
 * A character page as HTML: the hosted browser first (it holds cf_clearance), /api/proxy as a last resort Cloudflare usually challenges.
 */
async function fetchHtmlPage(url, { signal = null } = {}) {
    const errors = [];
    // a browser never installed, in the service's words, so the preview can say how to add one
    let notInstalled = '';

    if (hasBrowserEndpoint()) {
        try {
            // A rendered HTML page, not the JSON API janitorai fetches, so ask for HTML: the
            // shared browser fetch defaults its in-page Accept to application/json otherwise.
            const res = await jannyProvider.browserFetch(new URL(url).pathname, { headers: { Accept: 'text/html,application/xhtml+xml,*/*' }, signal });
            if (res.status >= 200 && res.status < 300 && isValidCharacterHtml(res.body)) {
                console.info('[JannyProvider] Page fetched via hosted browser');
                return res.body;
            }
            // read the body whatever the status: a challenge comes at 403 as often as 200, and the reader can act on it
            const reason = classifyErrorPage(res.body, res.status, 'the browser') || `HTTP ${res.status || 0} (not a character page)`;
            errors.push(`browser: ${reason}`);
        } catch (e) {
            // the reader closed the card: nothing failed, and the next leg has nobody to answer
            if (e?.name === 'AbortError') throw e;
            if (e?.code === 'NO_BROWSER') notInstalled = e.message;
            errors.push(`browser: ${e.message}`);
        }
    } else {
        errors.push('browser: not set up (Settings, Online, Hosted Browser)');
    }

    try {
        const html = await serverProxyFetchHtml(url, signal);
        console.info('[JannyProvider] Page fetched via server proxy');
        return html;
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        errors.push(`server proxy: ${e.message}`);
        console.warn('[JannyProvider] Server proxy strategy failed:', e.message);
    }

    console.warn(`[JannyProvider] The page could not be fetched for ${url}: ${errors.join(' | ')}`);
    // user copy lives at the browse surface; the throw keeps every leg's reason, the browser's first
    const err = new Error(`The page could not be fetched: ${errors.join(' | ')}`);
    if (notInstalled) Object.assign(err, { browserError: notInstalled, browserErrorCode: 'NO_BROWSER' });
    throw err;
}

function isValidCharacterHtml(html) {
    if (!html || typeof html !== 'string') return false;
    if (html.length < 1000) return false;
    return html.includes('CharacterButtons') || html.includes('astro-island');
}

// ========================================
// SERVER PROXY HELPER
// ========================================

async function serverProxyFetchHtml(url, signal = null) {
    const r = await fetch(proxiedUrl(url), { headers: { 'Accept': 'text/html,application/xhtml+xml,*/*' }, signal });
    // read before the status is judged: Cloudflare serves its challenge at 403, and "HTTP
    // 403" alone hides the one cause the reader can act on
    const html = await r.text();
    if (r.ok && isValidCharacterHtml(html)) return html;
    throw new Error(classifyErrorPage(html, r.status, 'the server') || (r.ok ? `not a character page (${html.length} bytes)` : `HTTP ${r.status}`));
}

/**
 * Decode Astro's island props serialization format.
 * Values are [type, data] where type 0 = primitive/object, 1 = array.
 */
function decodeAstroValue(value) {
    if (!Array.isArray(value)) return value;
    const [type, data] = value;
    if (type === 0) {
        if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
            const decoded = {};
            for (const [key, val] of Object.entries(data)) {
                decoded[key] = decodeAstroValue(val);
            }
            return decoded;
        }
        return data;
    } else if (type === 1) {
        return data.map(item => decodeAstroValue(item));
    }
    return data;
}

// ========================================
// API FUNCTIONS
// ========================================

/**
 * Search JannyAI characters via MeiliSearch.
 * @param {Object} opts
 * @param {string} [opts.search='']
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=40]
 * @returns {Promise<Object>} MeiliSearch multi-search response
 */
async function searchJanny(opts = {}) {
    const { search = '', page = 1, limit = 40 } = opts;

    // no token ceiling: one would hide heavy cards from link stats, previews and bulk linking
    return meiliMultiSearch({
        search,
        page,
        limit,
        filters: ['totalToken >= 29'],
        facets: ['isLowQuality', 'tagIds', 'totalToken'],
        sort: ['createdAtStamp:desc'],
        highlight: true,
    });
}

/**
 * Fetch full character data by scraping the JannyAI character page.
 * Extracts Astro island props containing the full definition.
 */
async function fetchCharacterDetails(characterId, slug, opts = {}) {
    const url = jannyCharacterUrl(characterId, slug);
    console.info(`[JannyProvider] Fetching character details: ${url}`);

    const html = await fetchHtmlPage(url, opts);
    console.info(`[JannyProvider] Got HTML (${html.length} bytes), parsing Astro props...`);

    // Try CharacterButtons first, then fallback to any astro-island with character props
    let astroMatch = html.match(
        /astro-island[^>]*component-export="CharacterButtons"[^>]*props="([^"]+)"/
    );
    if (!astroMatch) {
        astroMatch = html.match(/astro-island[^>]*props="([^"]*character[^"]*)"/);
    }
    if (!astroMatch) {
        const islandCount = (html.match(/astro-island/g) || []).length;
        console.error(`[JannyProvider] No character Astro island found. ${islandCount} islands total.`);
        throw new Error(`Could not parse JannyAI character page (${islandCount} astro-islands, none with character data)`);
    }

    const propsJson = JSON.parse(decodeHtmlEntities(astroMatch[1]));
    const character = decodeAstroValue(propsJson.character);
    const imageUrl = decodeAstroValue(propsJson.imageUrl);

    // Extract creator username from page HTML (rendered server-side as "Creator: @username")
    let creatorUsername = null;
    const creatorMatch = html.match(/Creator:\s*(?:<\/[^>]+>\s*)?<a[^>]*>@?([^<]+)<\/a>/);
    if (creatorMatch) {
        creatorUsername = creatorMatch[1].trim();
    }
    if (creatorUsername && character) {
        character.creatorUsername = creatorUsername;
    }

    if (character?.personality || character?.firstMessage) {
        console.info(`[JannyProvider] Character "${character.name}" parsed. Personality: ${(character.personality || '').length} chars, firstMsg: ${(character.firstMessage || '').length} chars${creatorUsername ? `, creator: @${creatorUsername}` : ''}`);
    } else {
        console.warn(`[JannyProvider] Character parsed but missing definition fields:`, Object.keys(character || {}));
    }

    return { character, imageUrl };
}

// the comparable fields the site never serves, which the builder answers empty: unread, never empty
const JANNY_UNSERVED_FIELDS = ['personality', 'system_prompt', 'post_history_instructions', 'alternate_greetings'];

/**
 * Map a hit to V2 fields: personality is the definition (description), description the site blurb (creator_notes).
 */
function buildV2FromDetails(charData) {
    const char = charData.character || charData;
    const rawDesc = char.description || '';

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: char.name || 'Unnamed',
            description: char.personality || '',
            personality: '',
            scenario: char.scenario || '',
            first_mes: char.firstMessage || '',
            mes_example: char.exampleDialogs || '',
            system_prompt: '',
            post_history_instructions: '',
            creator_notes: rawDesc,
            creator: char.creatorUsername || char.creatorId || '',
            character_version: '1.0',
            tags: resolveTagNames(char.tagIds),
            alternate_greetings: [],
            extensions: {
                jannyai: {
                    id: char.id,
                    creatorId: char.creatorId || null
                }
            },
            character_book: undefined
        }
    };
}

// ========================================
// PROVIDER CLASS
// ========================================

class JannyProvider extends ProviderBase {
    // Identity

    get id() { return 'jannyai'; }
    get browseView() { return jannyBrowseView; }

    get linkStatFields() {
        return {
            stat1: null,
            stat2: null,
            stat3: { icon: 'fa-solid fa-coins', label: 'Tokens' },
        };
    }

    // Lifecycle

    async init(coreAPI) {
        super.init(coreAPI);
    }

    // Character Linking

    readLink(ns) {
        const id = ns.id;
        if (!id) return null;
        return { id, fullPath: ns.slug ? `${id}_${ns.slug}` : String(id), linkedAt: ns.linkedAt || null };
    }

    writeLink(linkInfo) {
        // the link modal, the url paste and the bulk auto-link hand over a fullPath and no slug
        return { slug: jannyPathParts(linkInfo.fullPath).slug || null };
    }

    // Link Stats

    async fetchLinkStats(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const searchName = jannyNameFromSlug(jannyPathParts(linkInfo.fullPath).slug);
            if (!searchName) return null;

            const data = await searchJanny({ search: searchName, page: 1, limit: 20 });
            const hits = data?.results?.[0]?.hits || [];
            const match = hits.find(h => h.id === linkInfo.id);
            if (!match) return null;

            return {
                stat1: null,
                stat2: null,
                stat3: match.totalToken || 0
            };
        } catch (e) {
            CoreAPI.debugLog('[JannyProvider] fetchLinkStats:', e.message);
            return null;
        }
    }

    // Remote Data

    // the preview's read: the details, or a failure that keeps its reason (fetchMetadata answers null for both)
    async fetchDetails(fullPath, opts = {}) {
        const { id: charId, slug } = jannyPathParts(fullPath);
        const data = await fetchCharacterDetails(charId, slug, opts);
        return data?.character || null;
    }

    async fetchMetadata(fullPath, opts = {}) {
        if (!fullPath) return null;
        try {
            return await this.fetchDetails(fullPath, opts);
        } catch (e) {
            if (e?.name !== 'AbortError') console.error('[JannyProvider] fetchMetadata failed:', fullPath, e);
            return null;
        }
    }

    async fetchRemoteCard(linkInfo) {
        if (!linkInfo?.id) return null;
        // the page ladder has no status to read, so a failure is an error, never null ("removed")
        const data = await fetchCharacterDetails(linkInfo.id, jannyPathParts(linkInfo.fullPath).slug);
        if (!data) return null;
        const result = buildV2FromDetails(data);
        if (result) {
            result._listingName = this.getListingName(data.character);
            result._unavailableFields = new Set(JANNY_UNSERVED_FIELDS);
        }
        return result;
    }

    // Character URL / Link UI

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.fullPath) return null;
        const { id, slug } = jannyPathParts(linkInfo.fullPath);
        return jannyCharacterUrl(id, slug);
    }

    // In-App Preview

    async buildPreviewObject(char, linkInfo) {
        const charId = linkInfo?.id;
        if (!charId) return null;

        const searchName = jannyNameFromSlug(jannyPathParts(linkInfo.fullPath).slug) || char?.name || '';
        if (!searchName) return null;

        try {
            const data = await searchJanny({ search: searchName, page: 1, limit: 20 });
            const hits = data?.results?.[0]?.hits || [];
            const match = hits.find(h => h.id === charId);
            if (match) return match;
        } catch (e) {
            console.warn('[JannyProvider] buildPreviewObject search failed:', e.message);
        }

        const jannyData = char?.data?.extensions?.jannyai || {};
        return {
            id: charId,
            name: char?.name || 'Unknown',
            description: char?.data?.description || '',
            avatar: jannyData.avatar || '',
            tagIds: jannyData.tagIds || [],
            totalToken: jannyData.totalToken || char?.data?.extensions?.total_tokens || 0,
            createdAtStamp: jannyData.createdAtStamp || 0,
            creatorId: jannyData.creatorId || char?.data?.creator || ''
        };
    }

    openPreview(previewChar) {
        window.openJannyCharPreview?.(previewChar);
    }

    // Local Import Enrichment

    async enrichUnlinkedImport(cardData, _fileName) {
        const name = cardData.data?.name;
        if (!name) return null;

        try {
            const creator = cardData.data?.creator || '';
            // no creator, no search: the verification below needs one, so the round trips would be wasted
            const localCreator = creator.trim();
            if (!localCreator) return null;
            const results = await this.searchForBulkLink(name, creator);
            if (results.length === 0) return null;

            const normalizedName = name.toLowerCase().trim();
            const match = results.find(r => (r.name || '').toLowerCase().trim() === normalizedName);
            if (!match) return null;

            // Fetch full details for verification + tagline/listing-name enrichment
            const { id: charId, slug } = jannyPathParts(match.fullPath);

            const data = await fetchCharacterDetails(charId, slug);
            if (!data?.character) return null;

            const char = data.character;

            // strict: both creators present and equal (case-blind), since names alone are far too ambiguous; a URL creator skips
            const remoteCreator = (char.creatorUsername || '').trim();
            if (!remoteCreator) return null;
            if (localCreator.toLowerCase() !== remoteCreator.toLowerCase()) return null;

            // metadata only: the local PNG owns every descriptive field, or a same-named card would overwrite it
            if (!cardData.data.extensions) cardData.data.extensions = {};
            cardData.data.extensions.jannyai = {
                ...(cardData.data.extensions.jannyai || {}),
                id: charId,
                creatorId: char.creatorId || null,
                creatorUsername: char.creatorUsername || null,
                slug: slug || null,
                linkedAt: new Date().toISOString(),
                pageName: this.getListingName(char),
            };

            return {
                cardData,
                providerInfo: {
                    providerId: 'jannyai',
                    charId,
                    fullPath: match.fullPath,
                    hasGallery: false,
                    avatarUrl: null
                }
            };
        } catch (e) {
            console.warn('[JannyProvider] enrichLocalImport failed:', e.message);
            return null;
        }
    }

    // URL Handling

    parseUrl(url) {
        // Path: /characters/{uuid}_{slug}
        const match = parseProviderUrl(url)?.pathname.match(/\/characters\/([a-f0-9-]+(?:_[^/]*)?)/i);
        return match ? match[1] : null;
    }

    // Import Pipeline

    /**
     * Import a character from JannyAI.
     * @param {string} identifier - e.g. "uuid_slug"
     * @param {Object} [hitData] - Optional pre-fetched character data or MeiliSearch hit.
     *   If hitData has definition fields (personality, firstMessage), it's used directly
     *   to avoid a redundant page scrape.
     */
    async importCharacter(identifier, hitData, options = {}) {
        try {
            const { id: charId, slug } = jannyPathParts(identifier);

            let data;

            // If hitData already has definition fields (e.g., from preview modal fetch),
            // use it directly - no need to scrape the page a second time
            const hasDefinitionFields = hitData && (hitData.personality || hitData.firstMessage);
            if (hasDefinitionFields) {
                console.info('[JannyProvider] Using pre-fetched character data for import');
                data = { character: hitData, imageUrl: hitData.avatar ? `${JANNY_IMAGE_BASE}${hitData.avatar}` : null };
            }

            if (!data?.character) {
                try {
                    data = await fetchCharacterDetails(charId, slug);
                } catch (e) {
                    console.warn('[JannyProvider] Page scrape failed, falling back to hit data:', e.message);
                }
            }

            // Fall back to raw MeiliSearch hit data if scrape failed (definitions will be empty)
            if (!data?.character && hitData) {
                console.warn('[JannyProvider] Using MeiliSearch hit as last resort; definitions will be incomplete');
                data = { character: hitData, imageUrl: hitData.avatar ? `${JANNY_IMAGE_BASE}${hitData.avatar}` : null };
            }
            if (!data?.character) throw new Error('Could not fetch character data from JannyAI');

            const char = data.character;
            const characterName = char.name || 'Unnamed';
            const missing = [];
            // a page that would not read, or read without one, leaves the search listing alone: no definition
            if (!char.personality && !char.firstMessage) missing.push('its definition (the character page could not be read)');

            // Page scrape often lacks tagIds/creatorId - backfill from MeiliSearch
            if (!char.tagIds?.length || !char.creatorId) {
                try {
                    const searchData = await searchJanny({ search: char.name || '', page: 1, limit: 20 });
                    const hits = searchData?.results?.[0]?.hits || [];
                    const match = hits.find(h => h.id === charId);
                    if (match) {
                        if (!char.tagIds?.length && match.tagIds) char.tagIds = match.tagIds;
                        if (!char.creatorId && match.creatorId) char.creatorId = match.creatorId;
                    }
                } catch (e) {
                    console.warn('[JannyProvider] MeiliSearch backfill failed:', e.message);
                }
            }

            const characterCard = buildV2FromDetails(data);

            if (!characterCard.data.extensions) characterCard.data.extensions = {};
            const existingJanny = characterCard.data.extensions.jannyai || {};
            characterCard.data.extensions.jannyai = {
                ...existingJanny,
                id: charId,
                creatorId: char.creatorId || null,
                creatorUsername: char.creatorUsername || null,
                slug: slug || null,
                linkedAt: new Date().toISOString(),
                pageName: this.getListingName(char),
            };

            // Download avatar
            const avatarUrl = data.imageUrl || (char.avatar ? `${JANNY_IMAGE_BASE}${char.avatar}` : null);
            let imageBuffer = null;

            if (avatarUrl) {
                try {
                    const resp = await fetchWithProxy(avatarUrl);
                    imageBuffer = await resp.arrayBuffer();
                } catch (e) {
                    console.warn('[JannyProvider] Avatar download failed:', e.message);
                    missing.push('its picture');
                }
            }

            return await importFromPng({
                source: 'jannyai',
                onExisting: options.onExisting,
                characterCard, imageBuffer,
                characterName, hasGallery: false,
                providerCharId: charId,
                fullPath: identifier,
                avatarUrl: avatarUrl || null,
                missing,
                api: this._coreAPI
            });
        } catch (error) {
            console.error(`[JannyProvider] importCharacter failed for ${identifier}:`, error);
            return { success: false, error: error.message };
        }
    }

    // Bulk Linking

    /**
     * Search by name for bulk link (JannyAI has no creator filter); results carry creatorUsername for the match.
     */
    async searchForBulkLink(name, creator) {
        try {
            // JannyAI has no creator filter - search by name only
            const searchTerm = name;
            const data = await searchJanny({ search: searchTerm, page: 1, limit: 15 });
            const hits = data?.results?.[0]?.hits || [];

            return hits.map(hit => this._normalizeSearchResult(hit));
        } catch (e) {
            console.error('[JannyProvider] searchForBulkLink error:', e);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        return result.avatarUrl || '';
    }

    // Private Helpers

    _normalizeSearchResult(hit) {
        const slug = slugify(hit.name);
        const plainDesc = stripHtml(hit.description) || '';
        return {
            id: hit.id || null,
            fullPath: hit.id ? jannyFullPath(hit.id, hit.name) : '',
            name: hit.name || 'Unnamed',
            creator: hit.creatorUsername || '',
            avatarUrl: hit.avatar ? `${JANNY_IMAGE_BASE}${hit.avatar}` : '',
            rating: 0,
            starCount: 0,
            description: plainDesc,
            rawDescription: hit.description || '',
            tagline: plainDesc,
            nTokens: hit.totalToken || 0,
            slug
        };
    }
}

const jannyProvider = new JannyProvider();
export default jannyProvider;
