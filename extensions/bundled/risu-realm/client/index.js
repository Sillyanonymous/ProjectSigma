// RisuAI Realm: RisuAI's character hub as a provider, claiming the row the app's provider manifest
// declares for it.
import realmProvider from './realm-provider.js';
import { setRealmSettings, closePreviewModal, isPreviewOpen } from './realm-browse.js';

export default {
    async init(ctx) {
        setRealmSettings(ctx.settings);
        await ctx.providers.register(realmProvider);
        // the preview closes like the app's own dialogs and leaves with the extension, through the ledger
        ctx.ui.addOverlay({ id: 'preview', close: closePreviewModal, visible: isPreviewOpen });
        // the host adds the exclude-tags group under this body
        ctx.ui.addProviderSettingsSection('risu-realm', (el) => {
            el.innerHTML = `
                <div class="settings-group">
                    <div class="settings-group-title"><i class="fa-solid fa-cloud-arrow-down"></i> Downloads</div>
                    <div class="settings-row">
                        <span class="settings-hint">Browse, preview and import from realm.risuai.net. A character downloads on the server, so its picture and its assets (some cards carry hundreds) never pass through this device, and they join its gallery.</span>
                    </div>
                </div>`;
        }, { excludeTagsHint: 'Tags entered here are always left out of RisuAI Realm results.' });
    },
};
