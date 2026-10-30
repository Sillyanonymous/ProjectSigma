// CharacterTavern Provider: REST search and details, cards as PNGs with embedded V2 off the CDN; no versions or gallery

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { importFromPng, nullOnMiss } from '../provider-utils.js';
import chartavernBrowseView from './chartavern-browse.js';
import {
    fetchWithProxy,
    searchCards,
    fetchCharacterDetail,
    getAvatarUrl,
    getCardPngUrl,
    getCharacterPageUrl,
    parseCharacterUrl,
    stripHtml,
    parseTags,
    getCtCharName,
    isCtSessionActive,
    ctSetCookie,
    ctValidateSession,
    fetchCtSessionInfo,
} from './chartavern-api.js';

// ========================================
// V2 CARD BUILDING
// ========================================

/**
 * Build a V2 card from the detail API response (/api/character/{author}/{slug}); its definition_* fields map onto the V2 names.
 */
function buildV2FromDetail(card, authorName, altGreetings) {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: getCtCharName(card),
            description: card.definition_character_description || '',
            personality: card.definition_personality || '',
            scenario: card.definition_scenario || '',
            first_mes: card.definition_first_message || '',
            mes_example: card.definition_example_messages || '',
            system_prompt: card.definition_system_prompt || '',
            post_history_instructions: card.definition_post_history_prompt || '',
            creator_notes: card.description || '',
            creator: authorName || '',
            character_version: '',
            tags: card.tags ? parseTags(card.tags) : [],
            alternate_greetings: Array.isArray(altGreetings) ? altGreetings.filter(Boolean) : [],
            extensions: {
                chartavern: {
                    id: card.id || null,
                    path: card.path || null,
                    tagline: card.tagline || ''
                }
            },
            character_book: undefined,
        }
    };
}

/**
 * Build V2 card from a search hit (less detailed than the full API response).
 * Search hits include the actual character definitions.
 */
function buildV2FromSearchHit(hit) {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: getCtCharName(hit),
            description: hit.characterDefinition || '',
            personality: hit.characterPersonality || '',
            scenario: hit.characterScenario || '',
            first_mes: hit.characterFirstMessage || '',
            mes_example: hit.characterExampleMessages || '',
            system_prompt: '',
            post_history_instructions: hit.characterPostHistoryPrompt || '',
            creator_notes: hit.pageDescription || '',
            creator: hit.author || '',
            character_version: '',
            tags: hit.tags ? parseTags(hit.tags) : [],
            alternate_greetings: Array.isArray(hit.alternativeFirstMessage) ? hit.alternativeFirstMessage.filter(Boolean) : [],
            extensions: {
                chartavern: {
                    id: hit.id || null,
                    path: hit.path || null,
                    tagline: hit.tagline || ''
                }
            },
            character_book: undefined,
        }
    };
}

// ========================================
// PROVIDER CLASS
// ========================================

class ChartavernProvider extends ProviderBase {
    // Identity

    get id() { return 'chartavern'; }
    get browseView() { return chartavernBrowseView; }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-download', label: 'Downloads' },
            stat2: { icon: 'fa-solid fa-heart', label: 'Likes' },
            stat3: { icon: 'fa-solid fa-coins', label: 'Tokens' },
        };
    }

    // Lifecycle

    async init(coreAPI) {
        super.init(coreAPI);

        // boot keep-alive slides CT's 10-day session for rare visitors; fire-and-forget, init is boot-critical
        (async () => {
            try {
                // init can run before the boot's settings load, when getSetting answers the defaults
                await coreAPI.settingsReady();
                if (coreAPI.getSetting('ctAutoKeepAlive') === false) return;
                const saved = coreAPI.getSetting('ctCookie');
                if (!saved) return;
                const set = await ctSetCookie(coreAPI.apiRequest, saved);
                if (set.ok) await ctValidateSession(coreAPI.apiRequest);
            } catch { /* keep-alive is best-effort */ }
        })();
    }

    // Character Linking

    readLink(ns) {
        const path = ns.path;
        if (!path) return null;
        return { id: ns.id || null, fullPath: path, linkedAt: ns.linkedAt || null };
    }

    writeLink(linkInfo) {
        return { id: linkInfo.id || null, path: linkInfo.fullPath };
    }

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.fullPath) return null;
        return getCharacterPageUrl(linkInfo.fullPath);
    }

    // In-App Preview

    async buildPreviewObject(char, linkInfo) {
        const path = linkInfo?.fullPath;
        if (!path) return null;

        // Find this character via the search API to get the same hit shape the browse view uses
        const slug = path.split('/')[1] || '';
        try {
            const data = await searchCards({ query: slug, sort: 'most_popular', page: 1, limit: 10 }, CoreAPI.apiRequest);
            const hits = data?.hits || [];
            const match = hits.find(h => h.path === path);
            if (match) return match;
        } catch (e) {
            console.warn('[ChartavernProvider] buildPreviewObject search failed:', e.message);
        }

        const ctData = char?.data?.extensions?.chartavern || {};
        return {
            id: ctData.id || linkInfo.id,
            name: char?.name || 'Unknown',
            path: path,
            author: path.split('/')[0] || char?.data?.creator || '',
            tagline: ctData.tagline || '',
            tags: char?.data?.tags || [],
            totalTokens: char?.data?.extensions?.total_tokens || 0,
            createdAt: 0
        };
    }

    openPreview(previewChar) {
        window.openCtCharPreview?.(previewChar);
    }

    // Local Import Enrichment

    localImportInfo(link) {
        return { providerId: 'chartavern', charId: link.id || null, fullPath: link.fullPath, hasGallery: false, avatarUrl: getAvatarUrl(link.fullPath) };
    }

    async enrichUnlinkedImport(cardData, _fileName) {
        const name = cardData.data?.name;
        if (!name) return null;

        try {
            const creator = cardData.data?.creator || '';
            // Strict: require a non-empty creator on the local card. Names alone
            // are too ambiguous to safely auto-link.
            const localCreator = creator.trim();
            if (!localCreator) return null;

            const results = await this.searchForBulkLink(name, localCreator);
            if (results.length === 0) return null;

            const normalizedName = name.toLowerCase().trim();
            // Both name forms: local cards imported before the inChatName remap carry the listing title
            const nameMatches = results.filter(r =>
                [r.name, r.listingName].some(n => (n || '').toLowerCase().trim() === normalizedName));
            if (nameMatches.length === 0) return null;

            // CT fullPath is `creator/slug`. Require exact creator-segment match
            // (case-insensitive) against the local card's creator.
            const creatorLower = localCreator.toLowerCase();
            const match = nameMatches.find(r => {
                const seg = (r.fullPath || '').split('/')[0]?.toLowerCase();
                return seg && seg === creatorLower;
            });
            if (!match) return null;

            // Fetch details for tag/tagline enrichment
            const parts = match.fullPath.split('/');
            let detailData = null;
            if (parts.length >= 2) {
                try {
                    const detail = await fetchCharacterDetail(parts[0], parts[1], CoreAPI.apiRequest);
                    detailData = detail?.card || null;
                } catch (_) { /* best-effort */ }
            }

            if (!cardData.data.extensions) cardData.data.extensions = {};
            cardData.data.extensions.chartavern = {
                id: detailData?.id || match.id || null,
                path: match.fullPath,
                linkedAt: new Date().toISOString(),
                tagline: detailData?.tagline || match.tagline || '',
                pageName: detailData ? this.getListingName(detailData) : (match.listingName || null),
            };

            // Enrich tags if missing; these are PROVIDER-sourced, so they ride the Import
            // Rules ruleset like every provider path (the local file's own tags never do)
            if (!cardData.data.tags?.length && detailData?.tags) {
                cardData.data.tags = CoreAPI.applyTagAliases(parseTags(detailData.tags));
            }

            return {
                cardData,
                providerInfo: {
                    providerId: 'chartavern',
                    charId: match.id || null,
                    fullPath: match.fullPath,
                    hasGallery: false,
                    avatarUrl: match.avatarUrl || null
                }
            };
        } catch (e) {
            console.warn('[ChartavernProvider] enrichLocalImport failed:', e.message);
            return null;
        }
    }

    // Link Stats

    async fetchLinkStats(linkInfo) {
        const path = linkInfo?.fullPath;
        if (!path) return null;
        try {
            const parts = path.split('/');
            if (parts.length < 2) return null;

            // Detail API uses different field names than search: analytics_downloads, tokenTotal.
            // It has no likes/favorites field, so fall back to a search query for that.
            const data = await fetchCharacterDetail(parts[0], parts[1], CoreAPI.apiRequest);
            const card = data?.card;
            if (!card) return null;

            let likes = null;
            try {
                const slug = parts[1];
                const searchData = await searchCards({ query: slug, sort: 'most_popular', page: 1, limit: 10 }, CoreAPI.apiRequest);
                const match = (searchData?.hits || []).find(h => h.path === path);
                if (match) likes = match.likes ?? null;
            } catch (_) { /* search is best-effort */ }

            return {
                stat1: card.analytics_downloads ?? null,
                stat2: likes,
                stat3: card.tokenTotal ?? null
            };
        } catch (e) {
            CoreAPI.debugLog('[ChartavernProvider] fetchLinkStats:', e.message);
            return null;
        }
    }

    // Remote Data

    async fetchMetadata(fullPath) {
        if (!fullPath) return null;
        try {
            const parts = fullPath.split('/');
            if (parts.length < 2) return null;
            const data = await fetchCharacterDetail(parts[0], parts[1], CoreAPI.apiRequest);
            return data?.card || null;
        } catch (e) {
            console.error('[ChartavernProvider] fetchMetadata failed:', fullPath, e);
            return null;
        }
    }

    async fetchRemoteCard(linkInfo) {
        if (!linkInfo?.fullPath) return null;
        // null means gone (a 404 on the detail API); anything else throws, or the update
        // check reports a live card as Removed / Private
        return nullOnMiss(async () => {
            const parts = linkInfo.fullPath.split('/');
            if (parts.length < 2) return null;

            // the CDN PNG first: it embeds the whole card, alternate greetings included, which the detail API lacks
            const pngUrl = getCardPngUrl(linkInfo.fullPath);
            try {
                const resp = await fetchWithProxy(pngUrl);
                const buffer = await resp.arrayBuffer();
                const cardData = CoreAPI.extractCharacterDataFromPng(buffer);
                if (cardData?.data) {
                    // Enrich with detail-API-only fields (tagline, system_prompt, etc.)
                    let detail = null;
                    try {
                        detail = await fetchCharacterDetail(parts[0], parts[1], CoreAPI.apiRequest);
                        if (detail?.card) {
                            if (!cardData.data.system_prompt && detail.card.definition_system_prompt)
                                cardData.data.system_prompt = detail.card.definition_system_prompt;
                            if (!cardData.data.extensions) cardData.data.extensions = {};
                            if (!cardData.data.extensions.chartavern) cardData.data.extensions.chartavern = {};
                            cardData.data.extensions.chartavern.tagline = detail.card.tagline || '';
                            // The PNG embeds the listing title as its name; only the API knows the real one
                            cardData.data.name = getCtCharName(detail.card);
                        }
                    } catch (_) { /* detail enrichment is best-effort */ }
                    cardData._listingName = this.getListingName(detail?.card);
                    return cardData;
                }
            } catch (e) {
                console.warn('[ChartavernProvider] PNG extraction failed, falling back to detail API:', e.message);
            }

            // Fallback: detail API only (alternate_greetings will be empty)
            const data = await fetchCharacterDetail(parts[0], parts[1], CoreAPI.apiRequest);
            if (!data?.card) return null;
            const result = buildV2FromDetail(data.card, parts[0]);
            if (result) result._listingName = this.getListingName(data.card);
            return result;
        });
    }

    // Authentication

    get isAuthenticated() {
        return isCtSessionActive();
    }

    openAuthUI() {
        window.openCtLoginModal?.();
    }

    // URL Handling

    parseUrl(url) {
        return parseCharacterUrl(url);
    }

    // Bulk Linking

    async searchForBulkLink(name, _creator) {
        try {
            // CT search indexes card names/descriptions, not creator usernames
            const data = await searchCards({ query: name, sort: 'most_popular', page: 1, limit: 15 }, CoreAPI.apiRequest);
            return (data?.hits || []).map(hit => this._normalizeSearchResult(hit));
        } catch (e) {
            console.error('[ChartavernProvider] searchForBulkLink error:', e);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        return result.avatarUrl || '';
    }

    // Import Pipeline

    /**
     * Import a character from CharacterTavern.
     * CT serves PNG cards with embedded V2 data, so the CDN PNG is the primary source.
     *
     * @param {string} path - "author/slug" format
     * @param {Object} [hitData] - Optional pre-fetched search hit data
     */
    async importCharacter(path, hitData, options = {}) {
        try {
            const parts = String(path).split('/');
            if (parts.length < 2) throw new Error('Invalid character path');
            const author = parts[0];
            const slug = parts[1];

            let cardData = null;
            try {
                const detail = await fetchCharacterDetail(author, slug, CoreAPI.apiRequest);
                if (detail?.card) cardData = detail.card;
            } catch (e) {
                console.warn('[ChartavernProvider] Detail fetch failed, falling back to hit data:', e.message);
            }

            const characterName = (cardData || hitData) ? getCtCharName(cardData || hitData) : slug;

            const altGreetings = Array.isArray(hitData?.alternativeFirstMessage) ? hitData.alternativeFirstMessage : [];
            let characterCard;
            if (cardData) {
                characterCard = buildV2FromDetail(cardData, author, altGreetings);
                if (!characterCard.data.tags?.length) {
                    if (hitData?.tags) {
                        characterCard.data.tags = parseTags(hitData.tags);
                    } else {
                        try {
                            const searchData = await searchCards({ query: slug, sort: 'most_popular', page: 1, limit: 10 }, CoreAPI.apiRequest);
                            const match = (searchData?.hits || []).find(h => h.path === path);
                            if (match?.tags) characterCard.data.tags = parseTags(match.tags);
                        } catch (_) { /* search fallback is best-effort */ }
                    }
                }
            } else if (hitData) {
                characterCard = buildV2FromSearchHit(hitData);
            } else {
                throw new Error('Could not fetch character data from CharacterTavern');
            }

            if (!characterCard.data.extensions) characterCard.data.extensions = {};
            characterCard.data.extensions.chartavern = {
                ...(characterCard.data.extensions.chartavern || {}),
                id: cardData?.id || hitData?.id || null,
                path: path,
                linkedAt: new Date().toISOString(),
                tagline: cardData?.tagline || hitData?.tagline || '',
                pageName: this.getListingName(cardData || hitData)
            };

            // Download the PNG card from CDN (already has card data embedded)
            const pngUrl = getCardPngUrl(path);
            let imageBuffer = null;
            const missing = [];
            try {
                const resp = await fetchWithProxy(pngUrl);
                imageBuffer = await resp.arrayBuffer();
            } catch (e) {
                console.warn('[ChartavernProvider] PNG download failed:', e.message);
                missing.push('its card file (its picture, and any alternate greetings, tags or lorebook only the file carries)');
            }

            // Extract fields from PNG card data that the detail API omits
            // (alt greetings, tags, character_book/lorebook)
            if (imageBuffer) {
                let pngCard = null;
                try {
                    pngCard = CoreAPI.extractCharacterDataFromPng(imageBuffer);
                } catch (e) {
                    console.warn('[ChartavernProvider] Card file unreadable:', e.message);
                }
                if (pngCard?.data) {
                    if (!characterCard.data.alternate_greetings?.length && pngCard.data.alternate_greetings?.length) {
                        characterCard.data.alternate_greetings = pngCard.data.alternate_greetings;
                    }
                    if (!characterCard.data.tags?.length && pngCard.data.tags?.length) {
                        characterCard.data.tags = pngCard.data.tags;
                    }
                    if (pngCard.data.character_book && !characterCard.data.character_book) {
                        characterCard.data.character_book = pngCard.data.character_book;
                    }
                } else {
                    missing.push('the card inside its card file (any alternate greetings, tags or lorebook only the file carries)');
                }
            }

            return await importFromPng({
                source: 'chartavern',
                onExisting: options.onExisting,
                characterCard, imageBuffer,
                characterName, hasGallery: false,
                providerCharId: cardData?.id || hitData?.id || null,
                fullPath: path,
                avatarUrl: getAvatarUrl(path),
                missing,
                api: this._coreAPI
            });
        } catch (error) {
            console.error(`[ChartavernProvider] importCharacter failed for ${path}:`, error);
            return { success: false, error: error.message };
        }
    }

    // Gallery

    // CT doesn't have a gallery API
    get supportsGallery() { return false; }

    // Private Helpers

    _normalizeSearchResult(hit) {
        return {
            id: hit.id || null,
            fullPath: hit.path || '',
            // Clean name, not the listing title: the shared bulk-link scoring compares it
            // against char.name, which imports now fill from inChatName.
            name: getCtCharName(hit),
            listingName: (hit.name || '').trim(),
            avatarUrl: hit.path ? getAvatarUrl(hit.path) : '',
            rating: 0,
            starCount: hit.likes || 0,
            description: stripHtml(hit.pageDescription || hit.tagline || ''),
            tagline: hit.tagline || '',
            nTokens: hit.totalTokens || 0,
        };
    }
}

const chartavernProvider = new ChartavernProvider();

window.ctValidateSession = async (cookieString) => {
    if (cookieString) {
        const setResp = await ctSetCookie(CoreAPI.apiRequest, cookieString);
        if (!setResp.ok) {
            return { valid: false, reason: setResp.error || 'Failed to set cookie' };
        }
    }
    return ctValidateSession(CoreAPI.apiRequest);
};

// the settings timer's read: the snapshotted expiry, no CT request, so opening settings never slides the window
window.ctSessionInfo = async () => fetchCtSessionInfo(CoreAPI.apiRequest);

export default chartavernProvider;
