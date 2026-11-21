// Botbooru Provider: /download/json/{id} is a ready V2 envelope (no field mapping); /post/{id} adds listing name, stats, avatar

import { ProviderBase } from '../provider-interface.js';
import { LorebookView } from '../lorebook-view.js';
import { botbooruLorebooks } from './botbooru-lorebooks.js';
import CoreAPI from '../../core-api.js';
import { PROVIDER_MANIFEST } from '../provider-registry.js';
import { importFromPng, nullOnMiss, parseProviderUrl } from '../provider-utils.js';
import botbooruBrowseView, { openBotbooruLoginModal } from './botbooru-browse.js';
import {
    initBotbooruApi,
    BOTBOORU_BASE,
    fetchWithProxy,
    getBotbooruHeaders,
    getBotbooruPreviewUrl,
    getBotbooruDownloadUrl,
    fetchBotbooruPosts,
    fetchBotbooruPost,
    fetchBotbooruCard,
    fetchBotbooruTags,
    fetchBotbooruFollowedTags,
    addBotbooruFollowedTag,
    removeBotbooruFollowedTag,
    fetchBotbooruTagWeights,
    upsertBotbooruTagWeight,
    deleteBotbooruTagWeight,
    fetchBotbooruMe,
    patchBotbooruAccount,
    getBotbooruWriterTag,
    trackBotbooruDownload,
} from './botbooru-api.js';

// Cached raw post from fetchLinkStats - reused by "View on" button
let _cachedLinkNode = null;

// Read per call so late-registered extension providers' namespaces strip too.
function foreignProviderNamespaces() {
    return Object.values(PROVIDER_MANIFEST)
        .map(p => p.extNamespace).filter(ns => ns !== 'botbooru');
}

/**
 * Drop other providers' namespaces from a reupload, or the import would auto-link to the WRONG provider (provenance is kept apart).
 */
function stripForeignProviderNamespaces(card) {
    const ext = card?.data?.extensions;
    if (!ext) return;
    for (const ns of foreignProviderNamespaces()) {
        delete ext[ns];
    }
}

// the Online tab's lorebook kind for this site: the shared view over the site's adapter
const botbooruLorebookView = new LorebookView(botbooruLorebooks);

class BotbooruProvider extends ProviderBase {
    // Identity

    get id() { return 'botbooru'; }
    get browseView() { return botbooruBrowseView; }
    get lorebookView() { return botbooruLorebookView; }

    // Lifecycle

    async init(coreAPI) {
        super.init(coreAPI);
        initBotbooruApi({ apiRequest: coreAPI.apiRequest });
    }

    // Character Linking

    readLink(ns) {
        // site-downloaded cards carry the site's own namespace; accept post_id so they read as linked
        const id = ns.id ?? (ns.post_id != null ? String(ns.post_id) : null);
        if (!id) return null;
        return {
            id,
            // the dupe check compares fullPath; without it, an empty-string match flagged every botbooru import as an exact path match
            fullPath: String(id),
            slug: ns.slug || null,
            filename: ns.filename || null,
            rev: ns.rev || 1,
            uploaderId: ns.uploaderId || null,
            uploaderName: ns.uploaderName || null,
            linkedAt: ns.linkedAt || null,
        };
    }

    writeLink(linkInfo, existing) {
        // the link modal passes only {id, fullPath, pageName}; the rest comes from the cached post detail
        const cached = (_cachedLinkNode && String(_cachedLinkNode.id) === String(linkInfo.id)) ? _cachedLinkNode : null;
        return {
            slug: linkInfo.slug || cached?.slug || existing.slug || null,
            // filename + rev feed the preview-image URL for link UI / enrich
            filename: linkInfo.filename || cached?.filename || existing.filename || null,
            rev: linkInfo.rev || cached?.card_image_revision || existing.rev || 1,
            // The uploader is the creator on Botbooru (the list API only carries the id)
            uploaderId: linkInfo.uploaderId || (cached?.uploader_id != null ? String(cached.uploader_id) : null) || existing.uploaderId || null,
            uploaderName: linkInfo.uploaderName || cached?.uploader_name || existing.uploaderName || null,
            origin: linkInfo.origin || cached?.origin || existing.origin || null,
            sauce: linkInfo.sauce || cached?.sauce || existing.sauce || null,
            // pageName feeds the listing-name display + search key
            pageName: linkInfo.pageName || this.getListingName(cached) || existing.pageName || null,
            tagline: linkInfo.tagline || cached?.tagline || existing.tagline || null,
        };
    }

    getCharacterUrl(linkInfo) {
        if (!linkInfo?.id) return null;
        // The JSON API lives at /post/{id} but the site's page URL is /character/{id}
        return `${BOTBOORU_BASE}/character/${linkInfo.id}`;
    }

    // In-App Preview

    async buildPreviewObject(char, linkInfo) {
        const post = this.getCachedLinkNode() || await fetchBotbooruPost(linkInfo.id);
        if (!post) return null;

        const previewChar = {
            ...post,
            avatar_url: post.filename ? getBotbooruPreviewUrl(post.filename, post.card_image_revision) : null,
        };

        this.clearCachedLinkNode();
        return previewChar;
    }

    openPreview(previewChar) {
        window.openBotbooruCharPreview?.(previewChar);
    }

    // Local Import Enrichment

    async enrichLocalImport(cardData, _fileName) {
        const ext = cardData.data?.extensions?.botbooru;
        // Site-downloaded cards carry the site's own namespace (post_id, no id)
        const id = ext?.id ?? (ext?.post_id != null ? String(ext.post_id) : null);
        if (!id) return null;

        // a complete stamped namespace skips the detail fetch (batch hot path, tiny post cache); pageName stays out of the check
        if (ext.id != null && ext.filename) {
            return {
                cardData,
                providerInfo: {
                    providerId: 'botbooru',
                    charId: id,
                    fullPath: String(id),
                    hasGallery: false,
                    avatarUrl: getBotbooruPreviewUrl(ext.filename, ext.rev)
                }
            };
        }

        // partial or site namespaces heal anyway; read the real gallery state off the cached detail while its in hand
        const post = await fetchBotbooruPost(id);
        const hasGallery = (post?.mini_gallery?.images || []).some(i => i.status === 'approved');

        // Heal partial namespaces while the detail is in hand: site-downloaded
        // cards have only {schema_version, post_id, post_url}, and older
        // URL/search links stamped nulls
        if (post && cardData.data?.extensions) {
            const existing = cardData.data.extensions.botbooru || {};
            cardData.data.extensions.botbooru = {
                ...existing,
                id: existing.id ?? Number(post.id),
                slug: existing.slug || post.slug || null,
                filename: existing.filename || post.filename || null,
                rev: existing.rev || post.card_image_revision || 1,
                uploaderId: existing.uploaderId || (post.uploader_id != null ? String(post.uploader_id) : null),
                uploaderName: existing.uploaderName || post.uploader_name || null,
                pageName: existing.pageName || this.getListingName(post) || null,
                tagline: existing.tagline || post.tagline || null,
            };
        }

        const healed = cardData.data?.extensions?.botbooru || ext;
        return {
            cardData,
            providerInfo: {
                providerId: 'botbooru',
                charId: id,
                fullPath: String(id),
                hasGallery,
                avatarUrl: healed.filename ? getBotbooruPreviewUrl(healed.filename, healed.rev) : null
            }
        };
    }

    // Remote Data

    /**
     * Resolve a URL's post id to its metadata; the link-by-URL flow needs the id and listing name, or the link saves id: null.
     */
    async fetchMetadata(handle) {
        const post = await fetchBotbooruPost(handle);
        // Cache for setLinkInfo enrichment (the shared modal calls it right after)
        if (post) _cachedLinkNode = post;
        return post;
    }

    /**
     * Fetch the remote card for update comparison.
     * /download/json is already V2-wrapped; the post detail adds the
     * listing title (meta_name, absent on most posts).
     */
    async fetchRemoteCard(linkInfo) {
        if (!linkInfo?.id) return null;
        // null means gone (a 404 inside); anything else throws, or the update check
        // reports a live card as Removed / Private
        return nullOnMiss(async () => {
            const card = await fetchBotbooruCard(linkInfo.id, { strict: true });
            if (!card) return null;
            const post = await fetchBotbooruPost(linkInfo.id);
            // a post with no meta_name answers '' (a real diff); only a failed fetch leaves it unknown, which the check skips
            if (post) card._listingName = this.getListingName(post) || '';
            // mirror the import's creator resolution exactly, or every card shows a creator diff
            if (post) {
                card.data.creator = getBotbooruWriterTag(post) || post.uploader_name || card.data.creator || '';
            }
            // Mirror the import-time strip too, or applying an update would re-add
            // the reupload's foreign link namespaces (eg. extensions.chub).
            stripForeignProviderNamespaces(card);
            // the tagline is a post field, not card json: mirrored at the comparable path so the check can diff it
            if (post && card.data) {
                if (!card.data.extensions) card.data.extensions = {};
                card.data.extensions.botbooru = {
                    ...(card.data.extensions.botbooru || {}),
                    tagline: post.tagline || null,
                };
            }
            return card;
        });
    }

    // Link Stats

    /**
     * Fetch live stats for the link modal; caches the raw post for reuse
     * by getCachedLinkNode().
     * @returns {Promise<{stat1: number, stat2: number, stat3: number}|null>}
     */
    async fetchLinkStats(linkInfo) {
        if (!linkInfo?.id) return null;
        const post = await fetchBotbooruPost(linkInfo.id);
        if (!post) return null;

        _cachedLinkNode = post;

        // Slot order follows the base linkStatFields (downloads / favorites / tokens)
        return {
            stat1: post.downloads || 0,
            stat2: post.favorite_count || 0,
            stat3: post.token_count || 0
        };
    }

    getCachedLinkNode() {
        return _cachedLinkNode;
    }

    clearCachedLinkNode() {
        _cachedLinkNode = null;
    }

    // Listing Name

    // meta_name is the listing title; character_name duplicates the card's data.name
    getListingName(hitData) { return hitData?.meta_name || null; }

    // Authentication

    get isAuthenticated() {
        return !!(CoreAPI.getSetting('botbooruToken'));
    }

    openAuthUI() {
        openBotbooruLoginModal?.();
    }

    // URL Handling

    parseUrl(url) {
        // Site pages use /character/{id}; tolerate the API-shaped /post(s)/{id} too
        const m = parseProviderUrl(url)?.pathname.match(/^\/(?:character|posts?)\/(\d+)/);
        return m ? m[1] : null;
    }

    // Favorite Tags (curated-sort boosters; settings reaches these via the registry)

    async listFollowedTags() {
        return fetchBotbooruFollowedTags();
    }

    /**
     * Follow a tag by name. The endpoint requires the tag's category, which is
     * resolved from the tag DB (lazy 1.6MB fetch, cached for the session).
     * @returns {Promise<Object|null>} the created entry, or null
     */
    async followTag(tagName, category = null) {
        const name = String(tagName || '').trim().toLowerCase();
        if (!name) return null;
        const tags = await fetchBotbooruTags();
        const catLower = category ? String(category).toLowerCase() : null;
        const hit = (tags || []).find(t => t.name.toLowerCase() === name
            && (!catLower || (t.category || 'General').toLowerCase() === catLower));
        if (!hit) return null;
        // Aliases carry the canonical tag's counts but not its id; follow the target
        const canonical = hit.alias_of
            ? (tags || []).find(t => t.name.toLowerCase() === hit.alias_of.toLowerCase() && !t.alias_of) || hit
            : hit;
        return addBotbooruFollowedTag(canonical.name, canonical.category || 'General');
    }

    /**
     * Substring autocomplete over the tag DB; "category:term" narrows by category prefix, count-sorted, aliases skipped.
     * @returns {Promise<Array<{name, category, count}>>}
     */
    async searchTags(query, limit = 8) {
        const raw = String(query || '').trim().toLowerCase();
        if (!raw) return [];
        const tags = await fetchBotbooruTags();
        if (!tags) return [];
        let term = raw;
        let category = null;
        const ci = raw.indexOf(':');
        if (ci > 0) {
            const prefix = raw.slice(0, ci).trim();
            const categories = [...new Set(tags.map(t => t.category || 'General'))];
            const matched = categories.find(c => c.toLowerCase().startsWith(prefix));
            if (matched) {
                category = matched;
                term = raw.slice(ci + 1).trim();
            }
        }
        const out = [];
        for (const t of tags) {
            if (t.alias_of) continue;
            if (category && (t.category || 'General') !== category) continue;
            if (term && !t.name.toLowerCase().includes(term)) continue;
            out.push(t);
        }
        out.sort((a, b) => (b.count || 0) - (a.count || 0));
        return out.slice(0, limit);
    }

    async unfollowTag(entryId) {
        return removeBotbooruFollowedTag(entryId);
    }

    // Tag Weights (weighted-tag account mode)

    async listTagWeights() {
        return fetchBotbooruTagWeights();
    }

    /**
     * Upsert a weight for a tag by name. Category resolves from the tag DB
     * the same way followTag does (alias-aware).
     * @param {string} tagName
     * @param {{weight?: number, always_follow?: boolean, always_block?: boolean}} opts
     */
    async setTagWeight(tagName, opts = {}) {
        const name = String(tagName || '').trim().toLowerCase();
        if (!name) return null;
        const tags = await fetchBotbooruTags();
        const catLower = opts.category ? String(opts.category).toLowerCase() : null;
        const hit = (tags || []).find(t => t.name.toLowerCase() === name
            && (!catLower || (t.category || 'General').toLowerCase() === catLower));
        if (!hit) return null;
        const canonical = hit.alias_of
            ? (tags || []).find(t => t.name.toLowerCase() === hit.alias_of.toLowerCase() && !t.alias_of) || hit
            : hit;
        return upsertBotbooruTagWeight({
            tag_name: canonical.name,
            category: canonical.category || 'General',
            weight: Math.max(-1000, Math.min(1000, Math.round(Number(opts.weight) || 0))),
            always_follow: !!opts.always_follow,
            always_block: !!opts.always_block,
        });
    }

    /** Re-upsert an existing entry with changed fields (POST is the update). */
    async updateTagWeightEntry(entry, patch = {}) {
        if (!entry?.tag_name) return null;
        return upsertBotbooruTagWeight({
            tag_name: entry.tag_name,
            category: entry.category || 'General',
            weight: Math.max(-1000, Math.min(1000, Math.round(Number(patch.weight ?? entry.weight) || 0))),
            always_follow: !!(patch.always_follow ?? entry.always_follow),
            always_block: !!(patch.always_block ?? entry.always_block),
        });
    }

    async removeTagWeight(entryId) {
        return deleteBotbooruTagWeight(entryId);
    }

    /**
     * Read the accounts use_tag_weights switch fresh and mirror it into the
     * botbooruUseTagWeights setting for synchronous readers (settings UI,
     * browse tooltips, curated sub-sort gating).
     */
    async refreshWeightedModeStatus() {
        if (!CoreAPI.getSetting('botbooruToken')) return null;
        const me = await fetchBotbooruMe();
        if (me && typeof me.use_tag_weights === 'boolean') {
            // every Settings open asks; only an answer that moved is written
            if (CoreAPI.getSetting('botbooruUseTagWeights') !== me.use_tag_weights) CoreAPI.setSetting('botbooruUseTagWeights', me.use_tag_weights);
            return me.use_tag_weights;
        }
        return null;
    }

    /** Flip the account switch; the PATCH response is authoritative. */
    async setWeightedMode(on) {
        const me = await patchBotbooruAccount({ use_tag_weights: !!on });
        if (me && typeof me.use_tag_weights === 'boolean') {
            CoreAPI.setSetting('botbooruUseTagWeights', me.use_tag_weights);
            return me.use_tag_weights;
        }
        return null;
    }

    // Bulk Linking

    /**
     * Search by name (substring; NSFW needs an authed token); uploader and writer arent queryable, so matching is name-only.
     */
    async searchForBulkLink(name, _creator) {
        if (!name?.trim()) return [];
        try {
            const data = await fetchBotbooruPosts({ q: name.trim(), sort: 'downloads', limit: 25 });
            if (!data?.posts?.length) return [];

            const normalizedName = name.toLowerCase().trim();
            const nameWords = normalizedName.split(/\s+/).filter(w => w.length > 2);

            return data.posts
                .filter(p => {
                    const pName = (p.character_name || '').toLowerCase().trim();
                    return pName === normalizedName || pName.includes(normalizedName)
                        || normalizedName.includes(pName) || nameWords.some(w => pName.includes(w));
                })
                .map(p => this._normalizeSearchResult(p));
        } catch (error) {
            console.error('[BotbooruProvider] searchForBulkLink error:', error);
            return [];
        }
    }

    getResultAvatarUrl(result) {
        return result.avatarUrl || null;
    }

    // Import Pipeline

    /**
     * Import by post id: the /download/png is the image source, the V2 json the authoritative card.
     * @param {string|number} idHandle - post id (from parseUrl or the browse grid)
     * @param {Object} [hitData] - post item from the grid, if invoked from browse
     */
    async importCharacter(idHandle, hitData, options = {}) {
        try {
            const id = String(idHandle).match(/\d+/)?.[0];
            if (!id) throw new Error('Invalid Botbooru post id');

            const characterCard = await fetchBotbooruCard(id);
            if (!characterCard) throw new Error('Could not fetch character card from API');

            // Always fetch the detail: the uploader name and slug live only there
            // (the list payload carries just uploader_id). LRU-cached, usually warm.
            const post = await fetchBotbooruPost(id) || hitData || {};
            const characterName = characterCard.data.name || post?.character_name || `botbooru_${id}`;

            // Writer tag, then uploader; the card json's creator is the reupload source's (often a junk link), a last resort
            if (post) {
                characterCard.data.creator = getBotbooruWriterTag(post) || post.uploader_name || characterCard.data.creator || '';
            }

            stripForeignProviderNamespaces(characterCard);

            if (!characterCard.data.extensions) characterCard.data.extensions = {};
            const existing = characterCard.data.extensions.botbooru || {};
            characterCard.data.extensions.botbooru = {
                ...existing,
                id: Number(id),
                slug: post?.slug || existing.slug || null,
                filename: post?.filename || existing.filename || null,
                rev: post?.card_image_revision || existing.rev || 1,
                uploaderId: (post?.uploader_id != null ? String(post.uploader_id) : null) || existing.uploaderId || null,
                uploaderName: post?.uploader_name || existing.uploaderName || null,
                origin: post?.origin || existing.origin || null,
                sauce: post?.sauce || existing.sauce || null,
                pageName: this.getListingName(post) || existing.pageName || null,
                tagline: post?.tagline || existing.tagline || null,
                linkedAt: new Date().toISOString()
            };

            // The card PNG is the best avatar source; fall back to the preview image
            let imageBuffer = null;
            const imageUrls = [getBotbooruDownloadUrl(id, 'png')];
            if (post?.filename) imageUrls.push(getBotbooruPreviewUrl(post.filename, post.card_image_revision));
            for (const url of imageUrls) {
                try {
                    const resp = await fetchWithProxy(url, { headers: getBotbooruHeaders(true) });
                    imageBuffer = await resp.arrayBuffer();
                    break;
                } catch { /* try next */ }
            }
            const missing = imageBuffer ? [] : ['its picture'];

            const hasGallery = (post?.mini_gallery?.images || []).some(i => i.status === 'approved');

            const result = await importFromPng({
                source: 'botbooru',
                onExisting: options.onExisting,
                characterCard, imageBuffer,
                characterName,
                hasGallery,
                providerCharId: Number(id),
                fullPath: String(id),
                avatarUrl: post?.filename ? getBotbooruPreviewUrl(post.filename, post.card_image_revision) : null,
                missing,
                api: this._coreAPI
            });

            // Ping only after the import actually landed (counts real downloads)
            if (result?.success && CoreAPI.getSetting('botbooruTrackDownloads') !== false) {
                trackBotbooruDownload(id, 'png');
            }
            return result;
        } catch (error) {
            console.error(`[BotbooruProvider] importCharacter failed for ${idHandle}:`, error);
            return { success: false, error: error.message };
        }
    }

    // Gallery Download

    get supportsGallery() { return true; }

    /**
     * Mini-gallery images (max 3 per post) as full-resolution URLs; nsfw rides the post's rating, the image API has none.
     */
    async fetchGalleryImages(linkInfo) {
        if (!linkInfo?.id) return [];
        try {
            const post = await fetchBotbooruPost(linkInfo.id);
            const images = post?.mini_gallery?.images || [];
            return images
                .filter(img => img.status === 'approved' && img.download_url)
                .map(img => ({
                    url: `${BOTBOORU_BASE}${img.download_url}`,
                    id: String(img.id),
                    nsfw: false
                }));
        } catch (e) {
            console.error('[BotbooruProvider] fetchGalleryImages failed:', e);
            return [];
        }
    }

    // Private Helpers

    /**
     * Normalize a post item into the standard bulk-link result format.
     */
    _normalizeSearchResult(post) {
        return {
            id: post.id || null,
            fullPath: String(post.id || ''),
            name: post.character_name || '',
            listingName: post.meta_name || '',
            creator: getBotbooruWriterTag(post) || post.uploader_name || '',
            avatarUrl: post.filename ? getBotbooruPreviewUrl(post.filename, post.card_image_revision) : null,
            rating: 0,
            starCount: post.favorite_count || 0,
            description: post.description_excerpt || '',
            tagline: post.creator_notes_excerpt || '',
            nTokens: post.token_count || 0,
        };
    }
}

const botbooruProvider = new BotbooruProvider();
export default botbooruProvider;
