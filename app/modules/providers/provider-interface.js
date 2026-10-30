// Provider Interface - contract for external character sources

import CoreAPI from '../core-api.js';
import { saveGalleryImage, resolveGalleryMediaName, browserFetch, parseProviderUrl } from './provider-utils.js';

/**
 * @typedef {Object} ProviderLinkInfo
 * @property {string} providerId   - which provider owns this link (e.g. 'chub')
 * @property {string|number} id    - provider-internal numeric/string ID
 * @property {string} fullPath     - canonical path on the provider (e.g. 'creator/slug')
 * @property {string} [linkedAt]   - ISO timestamp of when the link was created
 */

/**
 * @typedef {Object} ProviderVersionEntry
 * @property {string} ref          - version identifier (commit hash, revision ID, etc.)
 * @property {string} date         - ISO timestamp
 * @property {string} [message]    - commit message or version label
 * @property {string} [author]     - author name if available
 */

/**
 * @typedef {Object} ProviderComparableField
 * @property {string} path         - dot-notation field path (e.g. 'extensions.chub.tagline')
 * @property {string} label        - human-readable column label
 * @property {string} [icon]       - Font Awesome icon class
 * @property {boolean} [optional]  - if true, excluded from diff by default
 */

/**
 * Base class for external character source providers.
 *
 * Subclasses MUST implement methods marked @abstract.
 * Optional methods have sensible defaults and can be overridden.
 */
export class ProviderBase {
    // Identity

    /** Unique machine key (e.g. 'chub'). @abstract @returns {string} */
    get id() { throw new Error('Provider must implement get id()'); }

    /** The PROVIDER_MANIFEST row, stamped by the registry at registration; empty before. */
    get manifest() { return this._manifest || {}; }

    /** The data.extensions key holding this provider's link blob. */
    get extNamespace() { return this.manifest.extNamespace || this.id; }

    /** Human display name, from the manifest. @returns {string} */
    get name() { return this.manifest.name || this.id; }

    /** Font Awesome icon class for the tab/pill, from the manifest. @returns {string} */
    get icon() { return this.manifest.icon || 'fa-solid fa-globe'; }

    /** Provider logo url for the selector, from the manifest. @returns {string|null} */
    get iconUrl() { return this.manifest.iconUrl || null; }

    /** Whether this provider is in beta (a badge in the UI), from the manifest. @returns {boolean} */
    get beta() { return !!this.manifest.beta; }

    /** Whether this source is deprecated (a Deprecated badge over Beta, a notice at its switch), from the manifest. @returns {boolean} */
    get deprecated() { return !!this.manifest.deprecated; }

    /** Whether this provider starts switched off, from the manifest. @returns {boolean} */
    get disabledByDefault() { return !!this.manifest.disabledByDefault; }

    /** The confirm shown when the provider is switched on, from the manifest. @returns {string|null} */
    get enableWarning() { return this.manifest.enableWarning || null; }

    /** Reference to this provider's BrowseView subclass instance, if any. @returns {import('./browse-view.js').BrowseView|null} */
    get browseView() { return null; }

    /** The provider's lorebook view (a LorebookView over its adapter), if the site lists lorebooks. @returns {import('./lorebook-view.js').LorebookView|null} */
    get lorebookView() { return null; }

    // Lifecycle

    /**
     * Called once when the provider is registered. Receives the full CoreAPI
     * object so the provider can call back into the library.
     * @param {Object} coreAPI
     */
    async init(coreAPI) {
        this._coreAPI = coreAPI;
    }

    // View

    /** Whether this provider has a browsable view in the Online tab. @returns {boolean} */
    get hasView() { return !!this.browseView; }

    // Character Linking

    /**
     * The character's link to this provider, from its namespace blob: what decides which provider owns it.
     * @param {Object} char - character object (has .data.extensions)
     * @returns {ProviderLinkInfo|null}
     */
    getLinkInfo(char) {
        if (!char) return null;
        const ns = (char.data?.extensions || char.extensions)?.[this.extNamespace];
        if (!ns) return null;
        const info = this.readLink(ns);
        return info ? { providerId: this.id, ...info } : null;
    }

    /**
     * The link fields inside the namespace blob, or null when it carries no identity.
     * Override when the id or the path lives under another key.
     * @param {Object} ns - the provider's namespace blob
     * @returns {Object|null} fields merged behind providerId
     */
    readLink(ns) {
        const id = ns.id;
        if (!id) return null;
        return { id, fullPath: String(id), linkedAt: ns.linkedAt || null };
    }

    /**
     * Write provider link metadata onto a character object (the caller persists it).
     * @param {Object} char - character object
     * @param {ProviderLinkInfo|null} linkInfo - null to unlink
     */
    setLinkInfo(char, linkInfo) {
        if (!char) return;
        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};
        const ns = this.extNamespace;
        if (!linkInfo) {
            delete char.data.extensions[ns];
            return;
        }
        const existing = char.data.extensions[ns] || {};
        char.data.extensions[ns] = {
            id: linkInfo.id,
            linkedAt: linkInfo.linkedAt || new Date().toISOString(),
            pageName: linkInfo.pageName || existing.pageName || null,
            ...this.writeLink(linkInfo, existing),
        };
    }

    /**
     * The provider's own fields of the link blob; they land after id / linkedAt / pageName
     * and may override them.
     * @param {ProviderLinkInfo} linkInfo
     * @param {Object} existing - the blob being replaced, or {}
     * @returns {Object}
     */
    writeLink(linkInfo, existing) { return {}; }

    /**
     * The listing/page name the provider's site shows, which may differ from the card's data.name.
     * @param {Object} hitData - provider metadata or search hit object
     * @returns {string|null}
     */
    getListingName(hitData) { return hitData?.name || null; }

    /**
     * Return the full URL for viewing a character on this provider's website.
     * @param {ProviderLinkInfo} linkInfo
     * @returns {string|null}
     */
    getCharacterUrl(linkInfo) { return null; }

    /**
     * Whether "View on Provider" opens the provider's preview modal instead of an external
     * URL: true whenever the provider has a browse view.
     * @returns {boolean}
     */
    get supportsInAppPreview() { return this.hasView; }

    /**
     * Build a preview character object from a local character's metadata.
     * Called by viewOnLinkedProvider() when supportsInAppPreview is true.
     * @param {Object} char - local character object
     * @param {ProviderLinkInfo} linkInfo - link info for this character
     * @returns {Promise<Object|null>} provider-specific char object for openPreview()
     */
    async buildPreviewObject(char, linkInfo) { return null; }

    /**
     * Open the provider's browse preview modal for a character.
     * @param {Object} previewChar - object returned by buildPreviewObject()
     */
    openPreview(previewChar) { /* optional */ }

    /**
     * Open the link/unlink UI for a single character (context menus and detail panels).
     * @param {Object} char - character object
     */
    openLinkUI(char) {
        CoreAPI.openProviderLinkModal(char);
    }

    // Remote Data

    /**
     * Refresh or re-extract remote data before an update check, for providers whose data goes stale.
     * @param {ProviderLinkInfo} linkInfo
     * @param {Object} [options]
     * @param {AbortSignal} [options.signal] - abort signal to cancel long-running operations
     * @param {function(string):void} [options.onStatus] - progress callback for UI updates
     * @returns {Promise<void>}
     */
    async refreshRemoteData(linkInfo, options = {}) { return; }

    /**
     * Fetch full remote metadata for a linked character.
     * @param {string} fullPath - provider-specific canonical path
     * @returns {Promise<Object|null>} provider-specific metadata blob
     */
    async fetchMetadata(fullPath) { return null; }

    /**
     * The remote card for update comparison, already mapped to V2 by the provider.
     * @param {ProviderLinkInfo} linkInfo
     * @returns {Promise<Object|null>} V2-spec card data or null
     */
    async fetchRemoteCard(linkInfo) { return null; }

    /** Whether an update check is offered: the provider implements fetchRemoteCard. @returns {boolean} */
    get supportsRemoteCard() { return this.fetchRemoteCard !== ProviderBase.prototype.fetchRemoteCard; }

    /**
     * Fetch the associated lorebook/world for a character (if any).
     * @param {ProviderLinkInfo} linkInfo
     * @returns {Promise<Object|null>} V2 character_book object or null
     */
    async fetchLorebook(linkInfo) { return null; }

    /**
     * Fetch live stats for the link modal.
     * Only providers with public stats APIs need to override this.
     * @param {ProviderLinkInfo} linkInfo
     * @returns {Promise<{stat1: number|null, stat2: number|null, stat3: number|null}|null>}
     */
    async fetchLinkStats(linkInfo) { return null; }

    /**
     * Define the label and icon for each link stat slot.
     * Override to customize stat display in the link modal.
     * @returns {{stat1: {icon: string, label: string}, stat2: {icon: string, label: string}, stat3: {icon: string, label: string}}}
     */
    get linkStatFields() {
        return {
            stat1: { icon: 'fa-solid fa-download', label: 'Downloads' },
            stat2: { icon: 'fa-solid fa-heart', label: 'Favorites' },
            stat3: { icon: 'fa-solid fa-coins', label: 'Tokens' },
        };
    }

    /**
     * Return a provider-specific cached data node from the last fetchLinkStats()
     * call. Used by the "View on" action to avoid a redundant fetch.
     * @returns {Object|null}
     */
    getCachedLinkNode() { return null; }

    /** Clear the cached link node after consumption. */
    clearCachedLinkNode() { /* no-op */ }

    // Update Checking

    /**
     * Provider-specific fields the update diff compares beside the V2 fields: the namespace
     * tagline, for a provider whose manifest declares one.
     * @returns {ProviderComparableField[]}
     */
    getComparableFields() {
        if (!this.manifest.tagline) return [];
        return [{
            path: `extensions.${this.extNamespace}.tagline`,
            label: 'Tagline',
            icon: 'fa-solid fa-quote-left',
            optional: true,
            group: 'tagline',
            groupLabel: 'Tagline',
        }];
    }

    // Version History

    /** Whether remote version history is available: the provider implements fetchVersionList. @returns {boolean} */
    get supportsVersionHistory() { return this.fetchVersionList !== ProviderBase.prototype.fetchVersionList; }

    /**
     * Fetch the list of remote versions (commits, revisions) for a character.
     * @param {ProviderLinkInfo} linkInfo
     * @returns {Promise<ProviderVersionEntry[]>}
     */
    async fetchVersionList(linkInfo) { return []; }

    /**
     * Fetch the V2 card JSON for a specific historical version.
     * @param {ProviderLinkInfo} linkInfo
     * @param {string} ref - version identifier from fetchVersionList()
     * @returns {Promise<Object|null>} V2-spec card data or null
     */
    async fetchVersionData(linkInfo, ref) { return null; }

    /**
     * Human-readable label for the provider's "current remote state" entry
     * shown at the top of the version list (e.g. "Chub Page", "Janitor Live").
     * @returns {string}
     */
    get remoteVersionLabel() { return `${this.name} Current`; }

    /**
     * Whether a "current remote page" pseudo-version is available (the live state, which may
     * differ from the latest committed version): the provider implements fetchRemotePageCard.
     * @returns {boolean}
     */
    get supportsRemotePageVersion() { return this.fetchRemotePageCard !== ProviderBase.prototype.fetchRemotePageCard; }

    /**
     * Return metadata about the remote page entry for the version list.
     * @returns {{ date: string|null, description: string }|null}
     */
    getRemotePageInfo() { return null; }

    /**
     * Build and return the live remote card data for the "page" pseudo-version.
     * Returns flat card fields (not V2-wrapped).
     * @param {ProviderLinkInfo} linkInfo
     * @returns {Promise<Object|null>}
     */
    async fetchRemotePageCard(linkInfo) { return null; }

    // Authentication (optional)

    /** Whether this provider supports auth: it implements openAuthUI. @returns {boolean} */
    get hasAuth() { return this.openAuthUI !== ProviderBase.prototype.openAuthUI; }

    /** Whether the user is currently authenticated. @returns {boolean} */
    get isAuthenticated() { return false; }

    /**
     * Open the provider's login/token UI.
     * Providers manage their own modal or inline UX.
     */
    openAuthUI() { /* optional */ }

    // URL Handling

    /** The hostname patterns built from the manifest's hosts (www. implied). @returns {RegExp[]} */
    get hostPatterns() {
        const hosts = this.manifest.hosts || [];
        if (this._hostSrc !== hosts) {
            this._hostSrc = hosts;
            this._hostPatterns = hosts.map(h => new RegExp(`^(www\\.)?${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'));
        }
        return this._hostPatterns;
    }

    /**
     * Test whether a URL belongs to this provider (the import system routes URL imports by it).
     * @param {string} url
     * @returns {boolean}
     */
    canHandleUrl(url) {
        if (!url) return false;
        const patterns = this.hostPatterns;
        if (!patterns.length) return false;
        const u = parseProviderUrl(url);
        return !!u && patterns.some(re => re.test(u.hostname));
    }

    /**
     * Parse a URL into a provider-specific identifier (e.g. 'creator/slug').
     * @param {string} url
     * @returns {string|null}
     */
    parseUrl(url) { return null; }

    // The hosted browser

    /**
     * A same-origin fetch in the hosted browser under this provider's consumer: the way past a Cloudflare wall.
     * @param {string} path - origin-relative, under the registered prefix
     * @param {{headers?: Object, method?: string, jsonBody?: Object, endpoint?: string}} [opts]
     * @returns {Promise<{status: number, body: string, retryAfter: string}>}
     */
    browserFetch(path, opts = {}) { return browserFetch(this.id, path, opts); }

    // Bulk Linking

    /** Whether bulk auto-linking is available: the provider implements searchForBulkLink. @returns {boolean} */
    get supportsBulkLink() { return this.searchForBulkLink !== ProviderBase.prototype.searchForBulkLink; }

    /**
     * Search for remote matches of a local character, for bulk auto-link; results need at least { id, fullPath, name, avatarUrl, rating, starCount, description, tagline }.
     * @param {string} name    - local character name
     * @param {string} creator - local character creator (may be empty)
     * @returns {Promise<Array<Object>>} search results
     */
    async searchForBulkLink(name, creator) { return []; }

    /**
     * Avatar URL for a searchForBulkLink() result; override when it must be built from other fields.
     * @param {Object} result - a search result object
     * @returns {string}
     */
    getResultAvatarUrl(result) { return result.avatarUrl || ''; }

    // Import Pipeline

    /** Whether URL-based import is available: the provider implements importCharacter. @returns {boolean} */
    get supportsImport() { return this.importCharacter !== ProviderBase.prototype.importCharacter; }

    /**
     * Import a character by its identifier: metadata, V2 card, avatar, PNG embed, upload.
     * @param {string} identifier - provider-specific ID from parseUrl()
     * @param {Object} [hitData] - browse-view hit data when invoked from a grid, else null
     * @param {Object} [options] - import options; `onProgress(message)` receives user-facing status strings during slow phases
     * @returns {Promise<ProviderImportResult>}
     */
    async importCharacter(identifier, hitData, options) {
        return { success: false, error: 'Provider does not support import' };
    }

    /**
     * @typedef {Object} ProviderImportResult
     * @property {boolean} success
     * @property {string} [error]          - error message if !success
     * @property {string} [id]             - the character's uuid (for a skip, the one it matched)
     * @property {boolean} [alreadyPresent] - the server skipped it as a duplicate
 * @property {boolean} [replaced]     - the card was written onto an existing character (onExisting { replace: id })
     * @property {string|null} [skippedReason] - identical, diverged-uuid or diverged-provenance
     * @property {string} [characterName]  - display name
     * @property {boolean} [hasGallery]    - whether gallery images are available
     * @property {string|number} [providerCharId] - provider-side numeric/string ID (for gallery fetch)
     * @property {string} [fullPath]       - canonical path on provider
     * @property {string} [avatarUrl]      - remote avatar URL for display
     * @property {string[]} [embeddedMediaUrls] - media found in card fields
     */

    // Gallery Download

    /**
     * Whether this provider has downloadable gallery images.
     * @returns {boolean}
     */
    get supportsGallery() { return false; }

    /**
     * Fetch the list of gallery images available for a character.
     * @param {ProviderLinkInfo} linkInfo
     * @returns {Promise<Array<{url: string, id?: string, nsfw?: boolean}>>}
     */
    async fetchGalleryImages(linkInfo) { return []; }

    /**
     * Download gallery images with dedup and progress, over fetchGalleryImages(); override for CDN-specific naming.
     * @param {ProviderLinkInfo} linkInfo
     * @param {Object} [options]
     * @param {string} options.charId - character uuid (media rows + upload target)
     * @param {function} [options.onProgress] - (current, total)
     * @param {function} [options.onLog]      - (message, status) → entry
     * @param {function} [options.onLogUpdate] - (entry, message, status)
     * @param {function} [options.shouldAbort] - () → boolean
     * @param {AbortSignal} [options.abortSignal]
     * @returns {Promise<{success: number, skipped: number, errors: number, aborted: boolean}>}
     */
    async downloadGallery(linkInfo, options = {}) {
        const api = this._coreAPI;
        if (!api) return { success: 0, skipped: 0, errors: 0, filenameSkipped: 0, aborted: false };

        const { onProgress, onLog, onLogUpdate, shouldAbort, abortSignal, dedupState: externalDedup, charId } = options;
        let successCount = 0, errorCount = 0, skippedCount = 0;
        let filenameSkippedCount = 0;

        const logEntry = onLog?.('Fetching gallery list...', 'pending') ?? null;
        const galleryImages = await this.fetchGalleryImages(linkInfo);

        if (galleryImages.length === 0) {
            if (onLogUpdate && logEntry) onLogUpdate(logEntry, 'No gallery images found', 'success');
            return { success: 0, skipped: 0, errors: 0, filenameSkipped: 0, aborted: false };
        }
        if (onLogUpdate && logEntry) onLogUpdate(logEntry, `Found ${galleryImages.length} gallery image(s)`, 'success');

        const dedup = externalDedup || await api.buildDedupState(charId);
        const { useFastSkip, ensureHashMap, sourceUrls } = dedup;
        let { fileNameIndex } = dedup;

        if (useFastSkip && !fileNameIndex) {
            fileNameIndex = await api.getExistingFileIndex(charId) || new Map();
            dedup.fileNameIndex = fileNameIndex;
        } else if (!useFastSkip && !fileNameIndex) {
            // Pre-build hash map eagerly when not using fast skip
            await ensureHashMap();
        }

        for (let i = 0; i < galleryImages.length; i++) {
            if ((shouldAbort?.()) || abortSignal?.aborted) {
                return { success: successCount, skipped: skippedCount, errors: errorCount, filenameSkipped: filenameSkippedCount, aborted: true };
            }

            const image = galleryImages[i];
            const displayUrl = image.url.length > 60 ? image.url.substring(0, 60) + '...' : image.url;
            const imgLog = onLog?.(`Checking ${displayUrl}`, 'pending') ?? null;

            // Already saved from this exact URL: the server would discard the upload
            // anyway, so downloading the bytes to find that out is wasted bandwidth.
            if (sourceUrls?.has(image.url)) {
                skippedCount++;
                if (onLogUpdate && imgLog) onLogUpdate(imgLog, `Skipped (already saved): ${displayUrl}`, 'success');
                onProgress?.(i + 1, galleryImages.length);
                continue;
            }

            if (useFastSkip && fileNameIndex) {
                const sanitizedName = resolveGalleryMediaName(image, api);
                if (sanitizedName.length >= 4) {
                    const match = fileNameIndex.get(sanitizedName.toLowerCase());
                    if (match) {
                        skippedCount++;
                        filenameSkippedCount++;
                        if (onLogUpdate && imgLog) onLogUpdate(imgLog, `Skipped (filename match): ${match.fileName}`, 'success');
                        onProgress?.(i + 1, galleryImages.length);
                        continue;
                    }
                }
            }

            let dl = await api.downloadMediaToMemory(image.url, 30000, abortSignal);
            if (!dl?.success) {
                errorCount++;
                if (onLogUpdate && imgLog) onLogUpdate(imgLog, `Failed: ${displayUrl} - ${dl?.error || 'unknown'}`, 'error');
                dl = null;
                onProgress?.(i + 1, galleryImages.length);
                continue;
            }

            const hashMap = await ensureHashMap();
            const contentHash = await api.calculateHash(dl.arrayBuffer);
            if (hashMap.has(contentHash)) {
                skippedCount++;
                dl = null;
                if (onLogUpdate && imgLog) onLogUpdate(imgLog, `Skipped (duplicate): ${displayUrl}`, 'success');
                onProgress?.(i + 1, galleryImages.length);
                continue;
            }

            if (onLogUpdate && imgLog) onLogUpdate(imgLog, `Saving ${displayUrl}...`, 'pending');
            const saveResult = await saveGalleryImage(dl, image, contentHash, this.galleryFilePrefix, api, { charId });
            dl = null;

            if (saveResult.success) {
                successCount++;
                hashMap.set(contentHash, { fileName: saveResult.filename });
                if (fileNameIndex) {
                    const savedSanitized = resolveGalleryMediaName(image, api);
                    if (savedSanitized) fileNameIndex.set(savedSanitized.toLowerCase(), { fileName: saveResult.filename, localPath: saveResult.localPath || '' });
                }
                if (onLogUpdate && imgLog) onLogUpdate(imgLog, `Saved: ${saveResult.filename}`, 'success');
            } else {
                errorCount++;
                if (onLogUpdate && imgLog) onLogUpdate(imgLog, `Failed: ${displayUrl} - ${saveResult.error}`, 'error');
            }

            onProgress?.(i + 1, galleryImages.length);
            await new Promise(r => setTimeout(r, 50));
        }

        return { success: successCount, skipped: skippedCount, errors: errorCount, filenameSkipped: filenameSkippedCount, aborted: false };
    }

    /**
     * Return the gallery naming prefix for files downloaded from this provider.
     * Used by the generic save helper to tag gallery images by source.
     * @returns {string} e.g. 'chubgallery', 'chartaverngallery'
     */
    get galleryFilePrefix() { return `${this.id}gallery`; }

    // Import Duplicate Detection

    /**
     * Claim a locally imported card already linked here, else hand it to enrichUnlinkedImport; the caller re-embeds the result.
     * @param {Object} cardData - Extracted V2 card data ({ spec, data })
     * @param {string} fileName - Original filename of the PNG
     * @returns {Promise<{cardData: Object, providerInfo: {providerId: string, charId: string|null, fullPath: string|null, hasGallery: boolean, avatarUrl: string|null}}|null>}
     */
    async enrichLocalImport(cardData, fileName) {
        const link = this.getLinkInfo({ data: cardData?.data });
        if (link) return { cardData, providerInfo: this.localImportInfo(link, cardData) };
        return this.enrichUnlinkedImport(cardData, fileName);
    }

    /**
     * The providerInfo for a locally-imported card that carries this provider's link.
     * @param {ProviderLinkInfo} link
     * @param {Object} cardData
     * @returns {{providerId: string, charId: string|null, fullPath: string|null, hasGallery: boolean, avatarUrl: string|null}}
     */
    localImportInfo(link, cardData) {
        return { providerId: this.id, charId: link.id ?? null, fullPath: link.fullPath ?? null, hasGallery: false, avatarUrl: null };
    }

    /**
     * Claim a locally imported card with no link here, by a name and creator search; null leaves it alone.
     * @param {Object} cardData
     * @param {string} fileName
     * @returns {Promise<{cardData: Object, providerInfo: Object}|null>}
     */
    async enrichUnlinkedImport(cardData, fileName) { return null; }

}

export default ProviderBase;
