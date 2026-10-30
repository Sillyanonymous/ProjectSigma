// RisuAI Realm, the provider: a card is its charx download, staged by the server half; the listing adds
// tags and the name.
import { ProviderBase } from '/modules/providers/provider-interface.js';
import { importFromStage, parseProviderUrl } from '/modules/providers/provider-utils.js';
import { realmCharacterUrl, realmPictureUrl, fetchRealmInfo } from './realm-api.js';
import { realmIdOf } from './realm-id.js';
import realmBrowseView, { openRealmPreview } from './realm-browse.js';

let api = null;

class RealmProvider extends ProviderBase {
    get id() { return 'risu-realm'; }
    get browseView() { return realmBrowseView; }

    // the listing counts downloads alone
    get linkStatFields() {
        return { stat1: { icon: 'fa-solid fa-download', label: 'Downloads' }, stat2: null, stat3: null };
    }

    async init(coreAPI) {
        super.init(coreAPI);
        api = coreAPI;
    }

    // ── Link Stats ───────────────────────────────────────────

    async fetchLinkStats(linkInfo) {
        const row = await this.fetchMetadata(linkInfo?.id);
        return row ? { stat1: row.downloads, stat2: null, stat3: null } : null;
    }

    // ── Character URL / Link UI ─────────────────────────────

    getCharacterUrl(linkInfo) {
        const id = realmIdOf(linkInfo?.id);
        return id ? realmCharacterUrl(id) : null;
    }

    // ── In-App Preview ───────────────────────────────────────

    // a linked character's listing, as its preview reads it
    async buildPreviewObject(char, linkInfo) {
        return this.fetchMetadata(linkInfo?.id);
    }

    openPreview(previewChar) {
        openRealmPreview(previewChar);
    }

    // ── Remote Data ─────────────────────────────────────────

    async fetchMetadata(fullPath, opts = {}) {
        const id = realmIdOf(fullPath);
        if (!id) return null;
        try {
            return await fetchRealmInfo(id, opts);
        } catch (e) {
            if (e?.name !== 'AbortError') console.warn('[RealmProvider] fetchMetadata failed:', fullPath, e.message);
            return null;
        }
    }

    // ── URL Handling ────────────────────────────────────────

    parseUrl(url) {
        const match = parseProviderUrl(url)?.pathname.match(/^\/character\/([^/]+)\/?$/);
        return match ? realmIdOf(match[1]) : null;
    }

    // ── Import Pipeline ─────────────────────────────────────

    /**
     * Import a character: the server half stages its file while the listing is read, then the card gains tags and the link.
     * @param {string} identifier - the character's id
     * @param {Object} [hitData] - its listing row, when the caller already read it
     */
    async importCharacter(identifier, hitData, options = {}) {
        try {
            const id = realmIdOf(identifier);
            if (!id) throw new Error(`"${identifier}" is not a RisuAI Realm character id`);
            options.onProgress?.('downloading the card on the server');
            const listing = hitData?.id === id ? hitData : fetchRealmInfo(id).catch((e) => {
                console.warn('[RealmProvider] the listing could not be read; importing without its tags:', e.message);
                return null;
            });
            const [staging, info] = await Promise.all([
                api.apiRequest('/ext/risu-realm/stage', 'POST', { id }),
                listing,
            ]);
            const staged = await staging.json().catch(() => ({}));
            if (!staging.ok) throw new Error(staged.error || `the server could not download the card (${staging.status})`);

            const characterCard = staged.card;
            const characterName = characterCard.data.name || info?.name || 'Unnamed';
            // the card's own tags lead; a site tag it already has (in any case) the server links once
            characterCard.data.tags = [...(characterCard.data.tags || []), ...(info?.tags || [])];
            this.setLinkInfo(characterCard, { id, pageName: this.getListingName(info) });

            return await importFromStage({
                stageId: staged.stageId,
                source: this.id,
                onExisting: options.onExisting,
                characterCard,
                characterName,
                hasGallery: false,
                providerCharId: id,
                fullPath: id,
                avatarUrl: realmPictureUrl(info?.img),
                api,
            });
        } catch (error) {
            console.error(`[RealmProvider] importCharacter failed for ${identifier}:`, error);
            return { success: false, error: error.message };
        }
    }
}

const realmProvider = new RealmProvider();
export default realmProvider;
