// Pygmalion Provider: public Connect RPC reads; gallery from altAvatars, altImages and chatBackground; versions off the detail

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { importFromPng, nullOnMiss } from '../provider-utils.js';
import pygmalionBrowseView from './pygmalion-browse.js';
import {
    searchCharacters,
    fetchCharacterDetail,
    getAvatarUrl,
    getCharacterPageUrl,
    parseCharacterUrl,
    getGalleryImages,
    fetchWithProxy,
    getFollowedUsers,
    toggleFollowUser,
} from './pygmalion-api.js';

// ========================================
// V2 CARD BUILDING
// ========================================

/**
 * Build a V2 card from a full character: personality.persona is the body, characterNotes the notes, description the tagline.
 */
function buildV2FromDetail(char) {
    const p = char.personality || {};
    const owner = char.owner || {};

    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: p.name || char.displayName || 'Unnamed',
            description: p.persona || '',
            personality: '',
            scenario: '',
            first_mes: p.greeting || '',
            mes_example: p.mesExample || '',
            system_prompt: '',
            post_history_instructions: '',
            creator_notes: p.characterNotes || '',
            creator: p.creator || owner.username || owner.displayName || '',
            character_version: char.versionLabel || '',
            tags: Array.isArray(char.tags) ? char.tags : [],
            alternate_greetings: Array.isArray(p.alternateGreetings) ? p.alternateGreetings.filter(Boolean) : [],
            extensions: {
                pygmalion: {
                    id: char.id,
                    versionId: char.versionId || null,
                    source: char.source || null,
                    ownerId: char.ownerId || null,
                    ownerUsername: owner.username || null,
                    tagline: char.description || '',
                    stars: char.stars || 0,
                    views: char.views || 0,
                    downloads: char.downloads || 0,
                    chatCount: char.chatCount || 0,
                }
            },
            character_book: undefined,
        }
    };
}

/**
 * Build a minimal V2 card from a search result (no personality fields).
 * Used as last-resort fallback when full detail fetch fails.
 */
function buildV2FromSearchHit(hit) {
    const owner = hit.owner || {};
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: hit.displayName || 'Unnamed',
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            system_prompt: '',
            post_history_instructions: '',
            creator_notes: '',
            creator: owner.username || owner.displayName || '',
            character_version: '',
            tags: Array.isArray(hit.tags) ? hit.tags : [],
            alternate_greetings: [],
            extensions: {
                pygmalion: {
                    id: hit.id,
                    versionId: hit.versionId || null,
                    source: hit.source || null,
                    ownerId: hit.ownerId || null,
                    ownerUsername: owner.username || null,
                    tagline: hit.description || '',
                    stars: hit.stars || 0,
                    views: hit.views || 0,
                    downloads: hit.downloads || 0,
                    chatCount: hit.chatCount || 0,
                }
            },
            character_book: undefined,
        }
    };
}

// ========================================
// PROVIDER CLASS
// ========================================

class PygmalionProvider extends ProviderBase {
    // Identity

    get id() { return 'pygmalion'; }
    get browseView() { return pygmalionBrowseView; }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-download', label: 'Downloads' },
            stat2: { icon: 'fa-solid fa-star', label: 'Stars' },
            stat3: { icon: 'fa-solid fa-coins', label: 'Tokens' },
        };
    }

    // Lifecycle

    async init(coreAPI) {
        super.init(coreAPI);
    }

    // Character Linking

    writeLink(linkInfo) {
        return { versionId: linkInfo.versionId || null };
    }

    getListingName(hitData) {
        return hitData?.displayName || hitData?.name || null;
    }

    // Link Stats

    _cachedLinkData = null;

    async fetchLinkStats(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const data = await fetchCharacterDetail(linkInfo.id, undefined, this.getToken());
            const char = data?.character;
            if (!char) return null;

            this._cachedLinkData = char;
            return {
                stat1: char.downloads || 0,
                stat2: char.stars || 0,
                stat3: char.personalityTokenCount || 0
            };
        } catch (e) {
            CoreAPI.debugLog('[PygmalionProvider] fetchLinkStats:', e.message);
            return null;
        }
    }

    getCachedLinkNode() { return this._cachedLinkData; }
    clearCachedLinkNode() { this._cachedLinkData = null; }

    // Remote Data

    async fetchMetadata(fullPath) {
        if (!fullPath) return null;
        try {
            const data = await fetchCharacterDetail(fullPath, undefined, this.getToken());
            return data?.character || null;
        } catch (e) {
            console.error('[PygmalionProvider] fetchMetadata failed:', fullPath, e);
            return null;
        }
    }

    async fetchRemoteCard(linkInfo) {
        if (!linkInfo?.id) return null;
        // null means gone (a 404 inside readJsonClassified); anything else throws, or the
        // update check reports a live card as Removed / Private
        return nullOnMiss(async () => {
            const data = await fetchCharacterDetail(linkInfo.id, undefined, this.getToken());
            if (!data?.character) return null;
            const result = buildV2FromDetail(data.character);
            if (result) result._listingName = this.getListingName(data.character);
            return result;
        });
    }

    // Character URL / Link UI

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.id) return null;
        return getCharacterPageUrl(linkInfo.id);
    }

    // In-App Preview

    async buildPreviewObject(char, linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const data = await fetchCharacterDetail(linkInfo.id, undefined, this.getToken());
            if (data?.character) return data.character;
        } catch (e) {
            console.warn('[PygmalionProvider] buildPreviewObject failed:', e.message);
        }
        return null;
    }

    openPreview(previewChar) {
        window.openPygmalionCharPreview?.(previewChar);
    }

    // Local Import Enrichment

    localImportInfo(link) {
        return { ...super.localImportInfo(link), hasGallery: true };
    }

    async enrichUnlinkedImport(cardData, _fileName) {
        const name = cardData.data?.name;
        if (!name) return null;

        try {
            const creator = cardData.data?.creator || '';
            // no creator, no search: the verification below requires one, so a search per
            // card of a batch could only be wasted
            const localCreator = creator.trim();
            if (!localCreator) return null;
            const results = await this.searchForBulkLink(name, creator);
            if (results.length === 0) return null;

            const normalizedName = name.toLowerCase().trim();
            const match = results.find(r => (r.name || '').toLowerCase().trim() === normalizedName);
            if (!match) return null;

            // Strict creator verification: an exact (case-insensitive) match on both sides.
            // Names alone are too ambiguous.
            const remoteCreator = (match.creator || '').trim();
            if (!remoteCreator) return null;
            if (localCreator.toLowerCase() !== remoteCreator.toLowerCase()) return null;

            // Fetch full detail purely for listing-name + gallery flag.
            // Do NOT replace descriptive fields on the user's local card.
            const detail = await fetchCharacterDetail(match.id, undefined, this.getToken());
            if (!detail?.character) return null;

            if (!cardData.data.extensions) cardData.data.extensions = {};
            cardData.data.extensions.pygmalion = {
                ...(cardData.data.extensions.pygmalion || {}),
                linkedAt: new Date().toISOString(),
                pageName: this.getListingName(detail.character),
            };

            const galleryImages = getGalleryImages(detail.character);
            return {
                cardData,
                providerInfo: {
                    providerId: 'pygmalion',
                    charId: match.id,
                    fullPath: match.id,
                    hasGallery: galleryImages.length > 0,
                    avatarUrl: detail.character.avatarUrl || null
                }
            };
        } catch (e) {
            console.warn('[PygmalionProvider] enrichLocalImport failed:', e.message);
            return null;
        }
    }

    // Authentication

    get isAuthenticated() {
        return !!(CoreAPI.getSetting('pygmalionToken'));
    }

    openAuthUI() {
        window.openPygmalionTokenModal?.();
    }

    getToken() {
        return CoreAPI.getSetting('pygmalionToken') || null;
    }

    async getFollowedUsers(opts = {}) {
        const token = this.getToken();
        if (!token) return { users: [], totalItems: 0 };
        return getFollowedUsers(token, opts);
    }

    async toggleFollowUser(userId) {
        const token = this.getToken();
        if (!token) throw new Error('Not authenticated');
        return toggleFollowUser(token, userId);
    }

    // URL Handling

    parseUrl(url) {
        return parseCharacterUrl(url);
    }

    // Bulk Linking

    async searchForBulkLink(name, _creator) {
        try {
            const data = await searchCharacters({ query: name, orderBy: 'downloads', pageSize: 15, page: 0 });
            return (data?.characters || []).map(hit => this._normalizeSearchResult(hit));
        } catch (e) {
            console.error('[PygmalionProvider] searchForBulkLink error:', e);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        return result.avatarUrl || '';
    }

    // Import Pipeline

    /**
     * Import a character from Pygmalion.
     * @param {string} characterId - Character UUID
     * @param {Object} [hitData] - Optional pre-fetched character data
     */
    async importCharacter(characterId, hitData, options = {}) {
        try {
            let char = null;

            if (hitData?.personality) {
                char = hitData;
            }

            if (!char) {
                try {
                    const data = await fetchCharacterDetail(characterId, undefined, this.getToken());
                    char = data?.character;
                } catch (e) {
                    console.warn('[PygmalionProvider] Detail fetch failed:', e.message);
                }
            }

            // Fall back to search hit data (definitions will be empty)
            if (!char && hitData) {
                console.warn('[PygmalionProvider] Using search hit as last resort; definitions will be incomplete');
                char = hitData;
            }
            if (!char) throw new Error('Could not fetch character data from Pygmalion');

            const characterName = char.personality?.name || char.displayName || 'Unnamed';

            const characterCard = char.personality
                ? buildV2FromDetail(char)
                : buildV2FromSearchHit(char);
            const missing = char.personality ? [] : ['its definition (the character page could not be read)'];

            if (!characterCard.data.extensions) characterCard.data.extensions = {};
            characterCard.data.extensions.pygmalion = {
                ...(characterCard.data.extensions.pygmalion || {}),
                id: char.id || characterId,
                versionId: char.versionId || null,
                source: char.source || null,
                ownerId: char.ownerId || null,
                ownerUsername: char.owner?.username || null,
                linkedAt: new Date().toISOString(),
                tagline: char.description || '',
                pageName: this.getListingName(char),
                stars: char.stars || 0,
                views: char.views || 0,
                downloads: char.downloads || 0,
                chatCount: char.chatCount || 0,
            };

            // Download avatar
            const avatarUrl = char.avatarUrl ? getAvatarUrl(char.avatarUrl) : null;
            let imageBuffer = null;

            if (avatarUrl) {
                try {
                    const resp = await fetchWithProxy(avatarUrl);
                    imageBuffer = await resp.arrayBuffer();
                } catch (e) {
                    console.warn('[PygmalionProvider] Avatar download failed:', e.message);
                    missing.push('its picture');
                }
            }

            const galleryImages = getGalleryImages(char);

            return await importFromPng({
                source: 'pygmalion',
                onExisting: options.onExisting,
                characterCard, imageBuffer,
                characterName,
                hasGallery: galleryImages.length > 0,
                providerCharId: char.id || characterId,
                fullPath: char.id || characterId,
                avatarUrl: avatarUrl || null,
                missing,
                api: this._coreAPI
            });
        } catch (error) {
            console.error(`[PygmalionProvider] importCharacter failed for ${characterId}:`, error);
            return { success: false, error: error.message };
        }
    }

    // Gallery

    get supportsGallery() { return true; }
    get galleryFilePrefix() { return 'pygmaliongallery'; }

    async fetchGalleryImages(linkInfo) {
        if (!linkInfo?.id) return [];
        try {
            const data = await fetchCharacterDetail(linkInfo.id, undefined, this.getToken());
            if (!data?.character) return [];
            return getGalleryImages(data.character);
        } catch (e) {
            console.error('[PygmalionProvider] fetchGalleryImages failed:', e);
            return [];
        }
    }

    // Private Helpers

    _normalizeSearchResult(hit) {
        const owner = hit.owner || {};
        return {
            id: hit.id || null,
            fullPath: hit.id || '',
            name: hit.displayName || 'Unnamed',
            avatarUrl: hit.avatarUrl ? getAvatarUrl(hit.avatarUrl) : '',
            rating: 0,
            starCount: hit.stars || 0,
            description: hit.description || '',
            tagline: hit.description || '',
            nTokens: hit.personalityTokenCount || 0,
            creator: owner.username || owner.displayName || '',
        };
    }
}

const pygmalionProvider = new PygmalionProvider();

// Helper for Settings UI
window.pygmalionLoginCheck = async (email, password) => {
    try {
        if (!email || !password) return { ok: false, error: 'Email and password required' };
        
        const CL_HELPER_BASE = '/provider-services';
        
        const resp = await CoreAPI.apiRequest(`${CL_HELPER_BASE}/pyg-login`, 'POST', {
            username: email,
            password: password,
        });

        if (resp.ok) {
            const data = await resp.json();
            const token = data?.result?.id_token || data.token;
            if (token) return { ok: true, token };
            return { ok: false, error: 'No token returned' };
        } 
        
        if (resp.status === 404) {
             return { ok: false, error: 'Login route not available on this server' };
        }

        let errorMessage = `HTTP ${resp.status}`;
        try {
            const text = await resp.text();
            try {
                const errorJson = JSON.parse(text);
                if (errorJson.error) errorMessage = errorJson.error;
            } catch {
                if (text) errorMessage = `${resp.status} ${text}`;
            }
        } catch { /* body unreadable */ }
        
        return { ok: false, error: errorMessage };
    } catch (err) {
        return { ok: false, error: err.message || 'Unknown network error' };
    }
}

export default pygmalionProvider;
