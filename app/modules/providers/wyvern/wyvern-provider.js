// Wyvern Provider - implementation for the Wyvern character source
//
// Handles browsing, linking, metadata fetching, and update checking
// against Wyvern's REST API (api.wyvern.chat).

import CoreAPI from '../../core-api.js';
import { ProviderBase } from '../provider-interface.js';
import { LorebookView } from '../lorebook-view.js';
import { wyvernLorebooks } from './wyvern-lorebooks.js';
import { importFromPng, fetchWithProxy, nullOnMiss } from '../provider-utils.js';
import wyvernBrowseView from './wyvern-browse.js';
import {
    WYVERN_API_BASE,
    getWyvernHeaders,
    wyvernMetadataCache,
    fetchWyvernMetadata,
    buildCharacterCardFromWyvern,
    getWyvernCharName,
    getAvatarUrl,
    getCharacterPageUrl,
    parseCharacterUrl,
    firebaseSignIn,
} from './wyvern-api.js';

// Cached raw API result from fetchLinkStats - reused by "View on" button
let _cachedLinkNode = null;

// the Online tab's lorebook kind for this site: the shared view over the site's adapter
const wyvernLorebookView = new LorebookView(wyvernLorebooks);

class WyvernProvider extends ProviderBase {
    // Identity

    get id() { return 'wyvern'; }
    get browseView() { return wyvernBrowseView; }
    get lorebookView() { return wyvernLorebookView; }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-eye', label: 'Views' },
            stat2: { icon: 'fa-solid fa-heart', label: 'Likes' },
            stat3: null,
        };
    }

    // Lifecycle

    async init(coreAPI) {
        super.init(coreAPI);
    }

    // Character Linking

    writeLink(linkInfo) {
        return { id: linkInfo.id || linkInfo.fullPath };
    }

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.id && !linkInfo?.fullPath) return null;
        return getCharacterPageUrl(linkInfo.id || linkInfo.fullPath);
    }

    // In-App Preview

    async buildPreviewObject(char, linkInfo) {
        let metadata = this.getCachedLinkNode();
        if (!metadata) {
            const charId = linkInfo?.id || linkInfo?.fullPath;
            if (!charId) return null;
            try {
                const url = `${WYVERN_API_BASE}/characters/${charId}`;
                const response = await fetchWithProxy(url, { headers: this._getHeaders() });
                metadata = await response.json();
            } catch (e) {
                return null;
            }
            if (!metadata) return null;
            _cachedLinkNode = metadata;
        } else {
            this.clearCachedLinkNode();
        }

        return metadata;
    }

    openPreview(previewChar) {
        window.openWyvernCharPreview?.(previewChar);
    }

    // Remote Data

    localImportInfo(link) {
        return { ...super.localImportInfo(link), hasGallery: true };
    }

    async fetchMetadata(charId) {
        return fetchWyvernMetadata(charId);
    }

    /**
     * Fetch the remote card for update comparison.
     * Returns V2-wrapped format: { spec, spec_version, data }.
     */
    async fetchRemoteCard(linkInfo) {
        const charId = linkInfo?.id || linkInfo?.fullPath;
        if (!charId) return null;
        // null means gone (a 404 inside); anything else throws, or the update check
        // reports a live card as Removed / Private
        return nullOnMiss(async () => {
            const metadata = await fetchWyvernMetadata(charId, { strict: true });
            if (!metadata) return null;
            const result = buildCharacterCardFromWyvern(metadata);
            if (result) result._listingName = this.getListingName(metadata);
            return result;
        });
    }

    // Link Stats

    /**
     * Fetch live stats for the link modal.
     * Caches the full raw API result for reuse by getCachedLinkNode().
     */
    async fetchLinkStats(linkInfo) {
        const charId = linkInfo?.id || linkInfo?.fullPath;
        if (!charId) return null;
        try {
            const url = `${WYVERN_API_BASE}/characters/${charId}`;
            const response = await fetchWithProxy(url, { headers: this._getHeaders() });
            const node = await response.json();
            if (!node) return null;

            _cachedLinkNode = node;

            const sr = node.statistics_record || node.entity_statistics || {};
            return {
                stat1: sr.views || sr.total_views || node.views || 0,
                stat2: sr.likes || sr.total_likes || node.likes || 0,
                stat3: null
            };
        } catch (e) {
            CoreAPI.debugLog('[WyvernProvider] fetchLinkStats:', e.message);
            return null;
        }
    }

    getCachedLinkNode() {
        return _cachedLinkNode;
    }

    clearCachedLinkNode() {
        _cachedLinkNode = null;
    }

    // Authentication

    get isAuthenticated() {
        return !!(CoreAPI.getSetting('wyvernToken'));
    }

    openAuthUI() {
        window.openWyvernLoginModal?.();
    }

    // URL Handling

    parseUrl(url) {
        return parseCharacterUrl(url);
    }

    // Bulk Linking

    /**
     * Search Wyvern for characters matching name/creator.
     */
    async searchForBulkLink(name, creator) {
        try {
            const headers = this._getHeaders();
            const normalizedName = name.toLowerCase().trim();
            const normalizedCreator = creator ? creator.toLowerCase().trim() : '';

            const params = new URLSearchParams({
                limit: '50',
                sort: 'votes',
                order: 'DESC',
                q: name.trim(),
            });
            const resp = await fetchWithProxy(`${WYVERN_API_BASE}/exploreSearch/characters?${params}`, { headers });
            const data = await resp.json();
            const characters = data.results || [];

            const results = [];
            for (const char of characters) {
                // Match on both name forms: local cards imported before the chat_name remap still
                // carry the listing title as their name.
                const cleanName = getWyvernCharName(char).toLowerCase();
                const listingName = (char.name || '').toLowerCase().trim();
                const charCreator = (char.creator?.displayName || char.creator?.username || '').toLowerCase().trim();
                const nameMatch = [cleanName, listingName].some(n =>
                    n && (n === normalizedName || n.includes(normalizedName) || normalizedName.includes(n)));
                const creatorMatch = !normalizedCreator || charCreator.includes(normalizedCreator);
                if (nameMatch && creatorMatch) {
                    results.push(this._normalizeSearchResult(char));
                }
            }

            return results;
        } catch (error) {
            console.error('[WyvernProvider] searchForBulkLink error:', error);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        return result.avatarUrl || '/img/no-portrait.png';
    }

    // Import Pipeline

    async importCharacter(charId, hitData, options = {}) {
        try {
            const metadata = await this.fetchMetadata(charId);
            if (!metadata) {
                throw new Error('Could not fetch character data from API');
            }

            const characterName = getWyvernCharName(metadata);
            const characterCard = buildCharacterCardFromWyvern(metadata);

            const metadataId = metadata.id;
            const metadataTagline = metadata.tagline || '';

            if (!characterCard.data.extensions) characterCard.data.extensions = {};
            characterCard.data.extensions.wyvern = {
                id: metadataId,
                tagline: metadataTagline,
                pageName: this.getListingName(metadata),
                linkedAt: new Date().toISOString()
            };

            // Avatar download
            const avatarUrl = getAvatarUrl(metadata);
            let imageBuffer = null;
            const missing = [];
            if (avatarUrl && avatarUrl !== '/img/no-portrait.png') {
                try {
                    const resp = await fetchWithProxy(avatarUrl);
                    imageBuffer = await resp.arrayBuffer();
                } catch { missing.push('its picture'); }
            }

            wyvernMetadataCache.delete(charId);

            return await importFromPng({
                source: 'wyvern',
                onExisting: options.onExisting,
                characterCard,
                imageBuffer,
                characterName,
                hasGallery: !!(metadata.gallery?.length),
                providerCharId: metadataId,
                fullPath: metadataId,
                avatarUrl,
                missing,
                api: this._coreAPI
            });
        } catch (error) {
            console.error(`[WyvernProvider] importCharacter failed for ${charId}:`, error);
            return { success: false, error: error.message };
        }
    }

    // Gallery Download

    get supportsGallery() { return true; }

    async fetchGalleryImages(linkInfo) {
        try {
            const data = await fetchWyvernMetadata(linkInfo.id);
            if (!data?.gallery?.length) return [];

            return data.gallery.map(img => ({
                url: img.imageURL,
                id: img.id
            }));
        } catch (e) {
            console.error('[WyvernProvider] fetchGalleryImages failed:', e);
            return [];
        }
    }

    // Private Helpers

    _getHeaders() {
        return getWyvernHeaders();
    }

    _normalizeSearchResult(char) {
        return {
            id: char.id || null,
            fullPath: char.id || '',
            // Clean name, not the listing title: the shared bulk-link scoring compares it
            // against char.name, which imports now fill from chat_name.
            name: getWyvernCharName(char),
            listingName: (char.name || '').trim(),
            // the id is the path here, so the creator has to ride the result itself
            creator: char.creator?.displayName || char.creator?.username || '',
            avatarUrl: getAvatarUrl(char),
            rating: 0,
            starCount: char.likes || 0,
            description: char.tagline || '',
            tagline: char.tagline || '',
            nTokens: 0,
        };
    }
}

const wyvernProvider = new WyvernProvider();

window.wyvernLoginCheck = async (email, password) => {
    try {
        if (!email || !password) return { ok: false, error: 'Email and password required' };
        const result = await firebaseSignIn(email, password);
        if (result.idToken) return { ok: true, token: result.idToken };
        return { ok: false, error: 'No token returned' };
    } catch (err) {
        return { ok: false, error: err.message || 'Authentication failed' };
    }
};

export default wyvernProvider;
