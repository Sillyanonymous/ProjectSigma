// DataCat Provider: datacat.run, an aggregator of JanitorAI characters; images off ella.janitorai.com, no versions, no auth

import { ProviderBase } from '../provider-interface.js';
import CoreAPI from '../../core-api.js';
import { importFromPng, fetchWithProxy, nullOnMiss, parseProviderUrl } from '../provider-utils.js';
import datacatBrowseView from './datacat-browse.js';
import './datacat-avatar-restore.js';
import {
    resolveDatacatAvatarUrl,
    setApiRequest,
    setSavedTokenGetter,
    fetchDatacatCharacter,
    fetchDatacatDownload,
    validateDcSession,
    clearDcSession,
    initDcSession,
    buildV2FromDatacat,
    buildV2FromDownload,
    extractCharacterBookFromScripts,
    hydrateDatacatScripts,
    hasUnfetchedLorebook,
    submitExtraction,
    fetchExtractionStatus,
    parseJanitoraiSession,
    janitoraiRefreshGrant,
    janitoraiVerifyToken,
    decodeJanitoraiClaims,
} from './datacat-api.js';

// ========================================
// PROVIDER CLASS
// ========================================

class DatacatProvider extends ProviderBase {
    // Identity

    get id() { return 'datacat'; }
    get browseView() { return datacatBrowseView; }

    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-comments', label: 'Chats' },
            stat2: { icon: 'fa-solid fa-envelope', label: 'Messages' },
            stat3: null,
        };
    }

    // Lifecycle

    async init(coreAPI) {
        super.init(coreAPI);
        setApiRequest(coreAPI.apiRequest);
        setSavedTokenGetter(() => coreAPI.getSetting('datacatToken') || null);
    }

    // Character Linking

    readLink(ns) {
        const id = ns.id;
        if (!id) return null;
        return { id, fullPath: String(id), sourceKind: ns.sourceKind || null, linkedAt: ns.linkedAt || null };
    }

    writeLink(linkInfo, existing) {
        return { sourceKind: linkInfo.sourceKind || existing.sourceKind || null };
    }

    // Link Stats

    async fetchLinkStats(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const character = await fetchDatacatCharacter(linkInfo.id, linkInfo.sourceKind || null);
            if (!character) return null;

            CoreAPI.debugLog('[DatacatProvider] fetchLinkStats raw keys:', Object.keys(character).join(', '));
            CoreAPI.debugLog('[DatacatProvider] chatCount:', character.chatCount, 'chat_count:', character.chat_count, 'stats:', JSON.stringify(character.stats));

            const chats = parseInt(character.chatCount || character.chat_count || character.stats?.chat, 10) || 0;
            const messages = parseInt(character.messageCount || character.message_count || character.stats?.message, 10) || 0;
            return { stat1: chats, stat2: messages, stat3: null };
        } catch (e) {
            CoreAPI.debugLog('[DatacatProvider] fetchLinkStats:', e.message);
            return null;
        }
    }

    // Remote Data

    async fetchMetadata(characterId) {
        const char = await fetchDatacatCharacter(characterId);
        if (!char) return null;
        // the API's id is a numeric auto-increment and character_id the UUID every URL and call uses, so expose that as id
        return { ...char, id: char.character_id || char.id };
    }

    async fetchRemoteCard(linkInfo) {
        if (!linkInfo?.id) return null;
        const sk = linkInfo.sourceKind || null;
        // a link stamped with another source has no card mapping here; a throw reads as "could not ask", never as removed
        if (sk && sk !== 'janitor') throw new Error('DataCat no longer serves the source this character was linked from');
        // null means gone (a 404 inside); anything else throws, or the update check
        // reports a live card as Removed / Private
        return nullOnMiss(async () => {
            // Try the download endpoint first (closest to V2 format)
            const downloadData = await fetchDatacatDownload(linkInfo.id, sk, { strict: true });
            if (downloadData?.data) {
                const character = await fetchDatacatCharacter(linkInfo.id, sk, { strict: true });
                if (character) await hydrateDatacatScripts(character);
                const result = buildV2FromDownload(downloadData, character);
                if (result) {
                    result._listingName = this.getListingName(character);
                    // Unknown-not-removed: stops the update check offering a phantom "lorebook removed"
                    if (hasUnfetchedLorebook(character)) result._lorebookUnavailable = true;
                }
                return result;
            }

            // Fallback to building from character metadata
            const character = await fetchDatacatCharacter(linkInfo.id, sk, { strict: true });
            if (character) {
                await hydrateDatacatScripts(character);
                const result = buildV2FromDatacat(character);
                if (result) {
                    result._listingName = this.getListingName(character);
                    if (hasUnfetchedLorebook(character)) result._lorebookUnavailable = true;
                }
                return result;
            }

            return null;
        });
    }

    async fetchLorebook(linkInfo) {
        if (!linkInfo?.id) return null;
        try {
            const character = await fetchDatacatCharacter(linkInfo.id, linkInfo.sourceKind || null);
            if (character) await hydrateDatacatScripts(character);
            return extractCharacterBookFromScripts(character);
        } catch (e) {
            console.error('[DatacatProvider] fetchLorebook failed:', linkInfo.id, e);
            return null;
        }
    }

    async refreshRemoteData(linkInfo, options = {}) {
        if (!linkInfo?.id) return;
        if (CoreAPI.getSetting('datacatReextractOnUpdate') !== true) return;

        const report = options?.onStatus;

        try {
            report?.('Checking the DataCat service...');
            report?.('Validating DataCat session...');
            const sessionOk = await validateDcSession();
            if (!sessionOk) {
                CoreAPI.debugLog('[DatacatProvider] refreshRemoteData: no active DataCat session, skipping re-extraction');
                return;
            }

            // extraction takes JanitorAI pages only, so a link stamped with another source is not re-extracted
            if (linkInfo.sourceKind && linkInfo.sourceKind !== 'janitor') {
                CoreAPI.debugLog('[DatacatProvider] refreshRemoteData: not a JanitorAI-sourced link, skipping re-extraction');
                return;
            }

            const upstreamUrl = `https://janitorai.com/characters/${linkInfo.id}`;
            const publicFeed = CoreAPI.getSetting('datacatPublicFeed') === true;

            report?.('Submitting re-extraction request...');
            const result = await submitExtraction(upstreamUrl, { publicFeed, alwaysReextract: true });
            if (!result?.success && !result?.queued && !result?.started) {
                CoreAPI.debugLog('[DatacatProvider] refreshRemoteData: extraction submit failed:', result?.error);
                return;
            }

            const submitRequestId = result?.requestId || null;

            if (result?.queued) {
                const pos = result.queuePosition ? ` (position ${result.queuePosition})` : '';
                report?.(`Queued for re-extraction${pos}...`);
            } else {
                report?.('Re-extraction started...');
            }

            const signal = options?.signal;
            const POLL_INTERVAL = 3000;
            const MAX_POLLS = 60;
            for (let i = 0; i < MAX_POLLS; i++) {
                if (signal?.aborted) return;
                await new Promise(r => setTimeout(r, POLL_INTERVAL));
                if (signal?.aborted) return;
                const status = await fetchExtractionStatus();
                if (!status) continue;

                // Match by requestId (v0.91+ history accumulates entries per char); fall back to characterId.
                const done = status.history?.find(h => {
                    if (submitRequestId && h.requestId) return h.requestId === submitRequestId;
                    return h.characterId === linkInfo.id || h.character_id === linkInfo.id;
                });
                if (done) {
                    report?.('Re-extraction complete');
                    CoreAPI.debugLog('[DatacatProvider] refreshRemoteData: re-extraction complete for', linkInfo.id);
                    return;
                }

                if (status.inProgress) {
                    const phase = status.inProgress.status;
                    const PHASE_LABELS = {
                        opening_page: 'Opening page',
                        preparing: 'Preparing',
                        initiating: 'Initiating',
                        pulling: 'Pulling data',
                        post_extract: 'Finalizing',
                        complete: 'Completing',
                    };
                    report?.(PHASE_LABELS[phase] || `Extracting (${phase})...`);
                } else if (!status.queue || status.queue.length === 0) {
                    CoreAPI.debugLog('[DatacatProvider] refreshRemoteData: extraction finished (no longer in progress)');
                    report?.('Re-extraction complete');
                    return;
                }
            }
            report?.('Re-extraction timed out, using cached data');
            CoreAPI.debugLog('[DatacatProvider] refreshRemoteData: re-extraction timed out after', MAX_POLLS * POLL_INTERVAL / 1000, 'seconds');
        } catch (err) {
            console.error('[DatacatProvider] refreshRemoteData failed, continuing with cached data:', err);
        }
    }

    // Gallery

    // janitorai cards have no galleries: keeps datacat out of every gallery walk
    get supportsGallery() { return false; }

    // Character URL / Link UI

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.id) return null;
        return `https://datacat.run/characters/${linkInfo.id}`;
    }

    // In-App Preview

    async buildPreviewObject(char, linkInfo) {
        const charId = linkInfo?.id;
        if (!charId) return null;

        try {
            const character = await fetchDatacatCharacter(charId, linkInfo.sourceKind || null);
            if (!character) return null;

            const preview = {
                id: character.character_id || character.characterId,
                name: character.name,
                chat_name: character.chat_name,
                description: character.description,
                avatar: character.avatar,
                tags: character.tags || [],
                custom_tags: character.custom_tags || [],
                is_nsfw: character.is_nsfw,
                creator_id: character.creator_id,
                creator_name: character.creator_name,
                created_at: character.created_at,
                chat_count: character.chat_count ?? character.chatCount ?? character.stats?.chat,
                message_count: character.message_count ?? character.messageCount ?? character.stats?.message,
                primary_content_source_kind: character.primary_content_source_kind || null,
            };
            // Full row rides along so the preview skips its refetch and keeps the right source kind.
            preview._fullCharacter = character;
            return preview;
        } catch (e) {
            console.warn('[DatacatProvider] buildPreviewObject failed:', e.message);
        }

        const dcData = char?.data?.extensions?.datacat || {};
        return {
            id: charId,
            name: char?.name || 'Unknown',
            description: char?.data?.description || '',
            avatar: dcData.avatar || '',
            tags: [],
            is_nsfw: false,
            creator_name: char?.data?.creator || ''
        };
    }

    openPreview(previewChar) {
        window.openDatacatCharPreview?.(previewChar);
    }

    // URL Handling

    parseUrl(url) {
        // Extract UUID from any path containing it (e.g. /characters/recent/:uuid)
        const match = parseProviderUrl(url)?.pathname.match(/\/characters?\/(?:[^/]+\/)*([a-f0-9-]{36})/i);
        return match ? match[1] : null;
    }

    // Import Pipeline

    /**
     * Import a character from DataCat.
     * @param {string} identifier - character UUID
     * @param {Object} [hitData] - Optional pre-fetched character data
     */
    async importCharacter(identifier, hitData, options = {}) {
        try {
            const charId = String(identifier);

            // Fetch full character data; browse hits carry the full row as _fullCharacter.
            let character = hitData?._fullCharacter || hitData || await fetchDatacatCharacter(charId);
            if (!character) throw new Error('Could not fetch character data from DataCat');

            const characterName = character.chat_name || character.chatName || character.name || 'Unnamed';

            // Download-first for the best V2 mapping; the sourceKind hint keeps freshly-extracted chars from 404ing into the metadata fallback.
            let characterCard;
            const sourceKind = character.primary_content_source_kind ? 'janitor' : null;
            const downloadData = await fetchDatacatDownload(charId, sourceKind);
            // Listing-shaped hits carry no body source at all; the metadata build needs the full row.
            if (!downloadData?.data && !character.chara_card_v2_json && !character.content_variants && !character.personality) {
                character = await fetchDatacatCharacter(charId, sourceKind) || character;
            }
            // Lorebook content moved behind a per-script hampter fetch; hydrate before building.
            await hydrateDatacatScripts(character);
            if (downloadData?.data) {
                characterCard = buildV2FromDownload(downloadData, character);
            } else {
                characterCard = buildV2FromDatacat(character);
            }

            if (!characterCard?.data) throw new Error('Failed to build character card');

            // Ensure datacat extension is set. sourceKind persists normalized ('janitor', the API hint value), not the raw row kind.
            if (!characterCard.data.extensions) characterCard.data.extensions = {};
            characterCard.data.extensions.datacat = {
                ...(characterCard.data.extensions.datacat || {}),
                id: charId,
                sourceKind: sourceKind || characterCard.data.extensions.datacat?.sourceKind || null,
                creatorId: character.creator_id || character.creatorId || null,
                creatorName: character.creator_name || character.creatorName || null,
                pageName: this.getListingName(character),
                linkedAt: new Date().toISOString()
            };

            // listing rows top out at the 640/768 variants; only the detail's embedded V2 json has the original (best-effort)
            if (!character.chara_card_v2_json && !character.content_variants) {
                character = await fetchDatacatCharacter(charId, sourceKind) || character;
            }
            const avatarUrl = resolveDatacatAvatarUrl(character, { preferOriginal: true });
            let imageBuffer = null;
            const missing = [];

            if (avatarUrl) {
                try {
                    const resp = await fetchWithProxy(avatarUrl);
                    imageBuffer = await resp.arrayBuffer();
                } catch (e) {
                    console.warn('[DatacatProvider] Avatar download failed:', e.message);
                    missing.push('its picture');
                }
            }

            return await importFromPng({
                source: 'datacat',
                onExisting: options.onExisting,
                characterCard, imageBuffer,
                characterName,
                hasGallery: false,
                providerCharId: charId,
                fullPath: charId,
                avatarUrl: avatarUrl || null,
                missing,
                api: this._coreAPI
            });
        } catch (error) {
            console.error(`[DatacatProvider] importCharacter failed for ${identifier}:`, error);
            return { success: false, error: error.message };
        }
    }

}

const datacatProvider = new DatacatProvider();
export default datacatProvider;

// Window-exposed session management (called by settings panel in library.js)
window.datacatValidateSession = async () => {
    return validateDcSession();
};

window.datacatRefreshToken = async () => {
    return initDcSession(null, true);
};

window.datacatClearSession = async () => {
    return clearDcSession();
};

// ========================================
// JANITORAI ACCOUNT SESSION (Supabase; unlocks Hampter pagination)
// ========================================

// one shared in-flight refresh, so concurrent loads cant race the single-use refresh token
let _janitoraiRefreshInFlight = null;

async function janitoraiDoRefresh() {
    if (_janitoraiRefreshInFlight) return _janitoraiRefreshInFlight;
    _janitoraiRefreshInFlight = (async () => {
        const rt = CoreAPI.getSetting('datacatJanitoraiRefreshToken');
        const res = await janitoraiRefreshGrant(rt);
        if (res.access_token) {
            CoreAPI.setSetting('datacatJanitoraiToken', res.access_token);
            if (res.refresh_token) CoreAPI.setSetting('datacatJanitoraiRefreshToken', res.refresh_token);
            return res.access_token;
        }
        // Only wipe the stored session when the refresh token is definitively dead,
        // never on a transient network blip (keeps the user logged in across hiccups).
        if (res.dead) {
            CoreAPI.setSetting('datacatJanitoraiToken', null);
            CoreAPI.setSetting('datacatJanitoraiRefreshToken', null);
        }
        return '';
    })();
    try { return await _janitoraiRefreshInFlight; }
    finally { _janitoraiRefreshInFlight = null; }
}

// Current valid access token, refreshing within 2min of expiry. '' when logged out / refresh failed.
window.datacatJanitoraiGetToken = async () => {
    const tok = CoreAPI.getSetting('datacatJanitoraiToken') || '';
    if (!tok) return '';
    const { expMs } = decodeJanitoraiClaims(tok);
    if (expMs && expMs - Date.now() > 120000) return tok;
    return (await janitoraiDoRefresh()) || '';
};

// Force a refresh (reactive path after an unexpected 401). Returns the new token or ''.
window.datacatJanitoraiForceRefresh = async () => janitoraiDoRefresh();

// seed from a pasted session; verified off hampter, whose preflight can 403 a good token and strand the rotated pair
window.datacatJanitoraiSetSession = async (pasted) => {
    const pair = parseJanitoraiSession(pasted);
    if (!pair) return { ok: false, error: 'Could not find a session in that value. Copy the whole sb-...-auth-token cookie.' };
    const { email, expMs } = decodeJanitoraiClaims(pair.access_token);
    let token = pair.access_token;
    // If the pasted access token is already stale but a refresh token came with it, rotate up front.
    if ((!expMs || expMs - Date.now() < 120000) && pair.refresh_token) {
        const r = await janitoraiRefreshGrant(pair.refresh_token);
        if (!r.access_token) {
            return { ok: false, error: r.dead
                ? 'That session is expired or invalid. Copy a fresh cookie after logging in again.'
                : 'Could not reach the JanitorAI auth service. Try again in a moment.' };
        }
        // A successful grant is itself the proof; the rotation consumed the single-use pasted
        // token, so proceed straight to persist.
        token = r.access_token;
        pair.refresh_token = r.refresh_token;
    } else {
        // No rotation ran, nothing consumed yet: confirm the pasted token before storing.
        const v = await janitoraiVerifyToken(token);
        if (!v.valid) {
            return { ok: false, error: v.transient
                ? 'Could not reach the JanitorAI auth service. Try again in a moment.'
                : 'That session is expired or invalid. Copy a fresh cookie after logging in again.' };
        }
    }
    CoreAPI.setSetting('datacatJanitoraiToken', token);
    CoreAPI.setSetting('datacatJanitoraiRefreshToken', pair.refresh_token || null);
    return { ok: true, email: decodeJanitoraiClaims(token).email || email, hasRefresh: !!pair.refresh_token };
};

window.datacatJanitoraiLogout = () => {
    CoreAPI.setSetting('datacatJanitoraiToken', null);
    CoreAPI.setSetting('datacatJanitoraiRefreshToken', null);
};

window.datacatJanitoraiSessionStatus = () => {
    const tok = CoreAPI.getSetting('datacatJanitoraiToken') || '';
    if (!tok) return { loggedIn: false };
    const { email, expMs } = decodeJanitoraiClaims(tok);
    return { loggedIn: true, email, expMs, hasRefresh: !!CoreAPI.getSetting('datacatJanitoraiRefreshToken') };
};
