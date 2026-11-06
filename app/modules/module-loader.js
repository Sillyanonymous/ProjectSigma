/**
 * Module Loader for Project Σ
 *
 * Two-tier initialization:
 *   Tier 1 - Loaded immediately (critical for Characters grid / detail modal)
 *   Tier 2 - Lazily loaded on first use via proxy stubs
 */

import ProviderRegistry, { PROVIDER_MANIFEST } from './providers/provider-registry.js';
import { proxiedUrl } from './providers/provider-utils.js';
import CoreAPI from './core-api.js';
import { CARD_EDITOR_FIELDS, cardValuesEqual, matchListItems } from './card-fields.js';
import { lorebooksEqual } from './lorebook-diff.js';
import { convertWorldToCharacterBook } from './lorebook-shelf.js';
import { mountConnectionEditor, readinessOf } from './connection-editor.js';
import { setActivePersona, writePersona, deletePersona, pronounsHtml, applyPronounPreset, syncPronounPreset, readPronouns } from './personas.js';
import { defineCommand, runCommand, hasCommand } from './ext-registry.js';
import { registerFeedPatcher, registerShellFeedPatcher, startFeed, releaseFeed, reconnectNow } from './feed.js';
import Keymap from './keymap.js';

// The one connection editor, handed to Settings > AI (settings-modal.js is a classic script)
// at module evaluation; the in-chat panel imports it directly.
window.ConnectionEditor = { mount: mountConnectionEditor, readinessOf };

// The persona writes and the pronouns block, handed to Settings > Chat the same way; the personas panel imports them.
window.Personas = { setActive: setActivePersona, write: writePersona, remove: deletePersona, pronounsHtml, applyPronounPreset, syncPronounPreset, readPronouns };

// the card-field definition for library.js's save confirmation, assigned at evaluation before any gesture
window.CardDiff = { CARD_EDITOR_FIELDS, cardValuesEqual, matchListItems, lorebooksEqual };

// the world-to-book converter for library.js's Insert from library, so one field table serves both directions
window.LoreShelf = { convertWorldToCharacterBook };

// the command registry for library.js, whose DOMContentLoaded defines the shell's verbs through it
window.ExtRegistry = { defineCommand, runCommand, hasCommand };

// the keymap for library.js and Settings > Keyboard (classic scripts); modules import it. Its listener runs the extensions' keys
Keymap.configure({
    getSetting: CoreAPI.getSetting, setSetting: CoreAPI.setSetting, view: CoreAPI.getCurrentView,
    overlayOpen: () => CoreAPI.hasOpenOverlay(['multiSelectToolbar']),
});
window.Keymap = Keymap;
Keymap.install();

// the change feed for library.js (it starts it and registers the shell's patchers, ranked ahead of every module's); modules import it
window.ClFeed = { registerPatcher: registerShellFeedPatcher, start: startFeed, release: releaseFeed, reconnectNow };


// ========================================
// CSS LOADER
// ========================================

const MODULE_CSS_VERSION = 104;

/** Insert a sheet BEFORE the user CSS layer, and a core module's under every extension's too; resolves with the link. */
function loadModuleCSS(path, { extension = false } = {}) {
    return new Promise((resolve) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        const url = new URL(path, import.meta.url);
        url.searchParams.set('v', MODULE_CSS_VERSION);
        link.href = url.href;
        link.onload = () => resolve(link);
        link.onerror = () => resolve(link);
        // marked as it is made, so a core sheet inserted while this one still loads finds it (the host names it after)
        if (extension) link.dataset.extStyle = '';
        const userLayer = document.getElementById('cl-runtime-tokens')
            || document.getElementById('cl-custom-css');
        // a core sheet loaded late (a lazy module) still sits under a theme's, so the theme wins every tie
        const before = (!extension && document.head.querySelector('link[data-ext-style]')) || userLayer;
        if (before) document.head.insertBefore(link, before);
        else document.head.appendChild(link);
    });
}

const loadExtensionCSS = (path) => loadModuleCSS(path, { extension: true });

// ========================================
// LAZY BRIDGE HELPERS
// ========================================

/** A group of window.* bridges sharing one dynamic import; setupFn swaps every stub for the real function. */
function createLazyBridgeGroup(importFn, setupFn) {
    let loading = null;

    function ensureLoaded() {
        if (!loading) {
            loading = importFn().then(mod => {
                setupFn(mod);
                return mod;
            }).catch(err => {
                console.error('[ModuleLoader] Lazy load failed:', err);
                loading = null;
                throw err;
            });
        }
        return loading;
    }

    /** A stub that runs the shared import, then forwards to getTarget()'s real function. */
    function createStub(getTarget) {
        return function (...args) {
            return ensureLoaded().then(() => {
                const realFn = getTarget();
                if (typeof realFn === 'function') {
                    return realFn(...args);
                }
            });
        };
    }

    return { ensureLoaded, createStub };
}


// ========================================
// MODULE REGISTRY
// ========================================

const ModuleLoader = {
    modules: {},
    _lazyLoaders: {},
    _lazyPromises: {},
    initialized: false,

    register(name, module) {
        this.modules[name] = module;
        delete this._lazyLoaders[name];
        window.debugLog?.(`[ModuleLoader] Registered module: ${name}`);
    },

    async initAll(dependencies) {
        for (const [name, module] of Object.entries(this.modules)) {
            try {
                if (module.init && !module._mlInitDone) {
                    await module.init(dependencies);
                    module._mlInitDone = true;
                    window.debugLog?.(`[ModuleLoader] Initialized module: ${name}`);
                }
            } catch (err) {
                console.error(`[ModuleLoader] Failed to initialize module: ${name}`, err);
            }
        }
        this.initialized = true;
    },

    get(name) {
        if (this.modules[name]) return this.modules[name];
        if (this._lazyLoaders[name]) return this._createLazyProxy(name);
        return null;
    },

    async ensureLoaded(name) {
        if (this.modules[name]) return this.modules[name];
        const loader = this._lazyLoaders[name];
        if (loader) {
            await loader();
            return this.modules[name];
        }
        return null;
    },

    _registerLazy(name, loadFn) {
        this._lazyLoaders[name] = () => {
            if (!this._lazyPromises[name]) {
                this._lazyPromises[name] = loadFn().catch(err => {
                    console.error(`[ModuleLoader] Lazy load of '${name}' failed:`, err);
                    delete this._lazyPromises[name];
                    throw err;
                });
            }
            return this._lazyPromises[name];
        };
    },

    /** A Proxy of async stubs, so getModule(name)?.openModal() triggers the lazy import on first call. */
    _createLazyProxy(name) {
        const self = this;
        return new Proxy({}, {
            get(target, prop) {
                if (prop === 'then' || prop === Symbol.toPrimitive || prop === Symbol.toStringTag) {
                    return undefined;
                }
                return function (...args) {
                    return self.ensureLoaded(name).then(mod => {
                        if (mod && typeof mod[prop] === 'function') {
                            return mod[prop](...args);
                        }
                    });
                };
            }
        });
    }
};


// ========================================
// INITIALIZATION
// ========================================

// the gestation gate: a module loads only when listed (all are; kept for a future module's gestation)
const SLICE_ENABLED = new Set([
    'multi-select',
    'context-menu',
    'gallery-viewer',
    'custom-css',
    'batch-tagging',
    'playlists',
    'character-versions',
    'tags-manager',
    'lorebook-manager',
    'providers',
    'chats',
    'card-updates',
    'recommender',
    'css-assistant',
    'character-creator',
    'media-download-queue',
    'batch-transfer',
    'prompt-manager',
    'connection-manager',
    'command-palette',
]);

async function initModuleSystem() {
    window.debugLog?.('[ModuleLoader] Initializing module system...');

    const dependencies = {};

    // ============================
    // TIER 2 - Lazy modules
    // ============================
    // Before the tier-1 awaits on purpose: the stubs are synchronous, so every lazy entry point
    // is live while a slow tier-1 import chain is still loading.

    if (SLICE_ENABLED.has('batch-tagging')) setupLazyBatchTagging();
    if (SLICE_ENABLED.has('tags-manager')) setupLazyTagsManager();
    if (SLICE_ENABLED.has('command-palette')) setupLazyCommandPalette();
    if (SLICE_ENABLED.has('batch-transfer')) setupLazyBatchTransfer();
    if (SLICE_ENABLED.has('chats')) {
        loadModuleCSS('./chats/chats.css');
        loadModuleCSS('./chats/lore-panel.css');
        loadModuleCSS('./chats/prompt-inspector.css');
        loadModuleCSS('./chats/gallery-panel.css');
        loadModuleCSS('./chats/swipe-combiner-panel.css');
        loadModuleCSS('./chats/background-panel.css');
        loadModuleCSS('./chats/settings-panel.css');
        loadModuleCSS('./chats/personas-panel.css');
        loadModuleCSS('./chats/card-texts-panel.css');
        loadModuleCSS('./chats/assistant.css');
        setupLazyChats();
    }
    // announced for a start view's enter waiting on the bridge, should this script ever run late
    document.dispatchEvent(new CustomEvent('cl-lazy-bridges-ready'));

    // ============================
    // TIER 1 - Immediate modules
    // ============================

    if (SLICE_ENABLED.has('multi-select')) try {
        const multiSelectModule = await import('./multi-select.js');
        loadModuleCSS('./multi-select.css');
        ModuleLoader.register('multi-select', multiSelectModule.default);
    } catch (err) {
        console.warn('[ModuleLoader] Could not load multi-select module:', err);
    }

    if (SLICE_ENABLED.has('context-menu')) try {
        const contextMenuModule = await import('./context-menu.js');
        loadModuleCSS('./context-menu.css');
        ModuleLoader.register('context-menu', contextMenuModule.default);
    } catch (err) {
        console.warn('[ModuleLoader] Could not load context-menu module:', err);
    }

    if (SLICE_ENABLED.has('gallery-viewer')) try {
        const galleryViewerModule = await import('./gallery-viewer.js');
        loadModuleCSS('./gallery-viewer.css');
        ModuleLoader.register('gallery-viewer', galleryViewerModule.default);

        window.openGalleryViewerWithImages = galleryViewerModule.openViewerWithImages;
        window.closeGalleryViewer = galleryViewerModule.closeViewer;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load gallery-viewer module:', err);
    }

    if (SLICE_ENABLED.has('character-versions')) try {
        const charVersionsModule = await import('./character-versions.js');
        loadModuleCSS('./character-versions.css');
        ModuleLoader.register('character-versions', charVersionsModule.default);

        window.renderVersionsPane = charVersionsModule.renderVersionsPane;
        window.cleanupVersionsPane = charVersionsModule.cleanupVersionsPane;
        window.autoSnapshotBeforeChange = charVersionsModule.autoSnapshotBeforeChange;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load character-versions module:', err);
    }

    if (SLICE_ENABLED.has('card-updates')) try {
        loadModuleCSS('./card-updates.css');
        const cardUpdatesModule = await import('./card-updates.js');
        ModuleLoader.register('card-updates', cardUpdatesModule.default);

        window.checkAllCardUpdates = cardUpdatesModule.checkAllLinkedCharacters;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load card-updates module:', err);
    }

    // gallery-sync.css is the notifications dropdown's shared shell, despite the name
    loadModuleCSS('./gallery-sync.css');

    // the library backup's notifications section; Settings' Library Backup panel follows it through the bridge
    try {
        const backupJobs = await import('./backup-jobs.js');
        window.BackupJobs = { now: backupJobs.backupNow, start: backupJobs.startBackupNow, cancel: backupJobs.cancelBackupJob };
        // its first read waits for the sign-in and the settings load, as a module init that asks the server does
        void CoreAPI.settingsReady().then(() => backupJobs.startBackupJobs({
            apiRequest: CoreAPI.apiRequest,
            readAnswer: CoreAPI.readAnswer,
            registerNotificationSection: CoreAPI.registerNotificationSection,
            refreshNotificationsUI: CoreAPI.refreshNotificationsUI,
            escapeHtml: CoreAPI.escapeHtml,
            formatBytes: CoreAPI.formatBytes,
            showToast: CoreAPI.showToast,
            onChange: (state) => document.dispatchEvent(new CustomEvent('cl-backup-changed', { detail: state })),
        }));
    } catch (err) {
        console.error('[ModuleLoader] Library backup failed:', err);
    }
    // the library's background upkeep (the search index tidy-up) as a notifications section
    try {
        const maintenance = await import('./maintenance.js');
        void CoreAPI.settingsReady().then(() => maintenance.startMaintenance({
            apiRequest: CoreAPI.apiRequest,
            registerNotificationSection: CoreAPI.registerNotificationSection,
            refreshNotificationsUI: CoreAPI.refreshNotificationsUI,
            // Settings' Search Index group re-reads on each, so a tidy-up's progress reaches it too
            onChange: (state) => document.dispatchEvent(new CustomEvent('cl-maintenance-changed', { detail: state })),
        }));
    } catch (err) {
        console.error('[ModuleLoader] Maintenance failed:', err);
    }
    // the connection editor is mounted by Settings > AI as well as by the chat panel
    loadModuleCSS('./connection-editor.css');
    // the pronouns block is drawn by Settings > Chat as well as by the chat's Personas window
    loadModuleCSS('./personas.css');

    if (SLICE_ENABLED.has('recommender')) try {
        loadModuleCSS('./recommender.css');
        const recommenderModule = await import('./recommender.js');
        ModuleLoader.register('recommender', recommenderModule.default);

        window.openRecommender = recommenderModule.openModal;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load recommender module:', err);
    }

    if (SLICE_ENABLED.has('custom-css')) try {
        loadModuleCSS('./custom-css.css');
        const customCssModule = await import('./custom-css.js');
        ModuleLoader.register('custom-css', customCssModule.default);

        window.openCustomCssModal = customCssModule.openModal;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load custom-css module:', err);
    }

    if (SLICE_ENABLED.has('css-assistant')) try {
        loadModuleCSS('./css-assistant.css');
        const cssAssistantModule = await import('./css-assistant.js');
        ModuleLoader.register('css-assistant', cssAssistantModule.default);
    } catch (err) {
        console.warn('[ModuleLoader] Could not load css-assistant module:', err);
    }

    if (SLICE_ENABLED.has('character-creator')) try {
        loadModuleCSS('./character-creator.css');
        loadModuleCSS('./creator-studio.css');
        const creatorModule = await import('./character-creator.js');
        ModuleLoader.register('character-creator', creatorModule.default);

        window.openCharacterCreator = creatorModule.openModal;
        window.closeCharacterCreator = creatorModule.closeModal;
        window.closeNotesPreview = creatorModule.closeNotesPreview;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load character-creator module:', err);
    }

    if (SLICE_ENABLED.has('lorebook-manager')) try {
        loadModuleCSS('./lorebook-manager.css');
        const lorebookModule = await import('./lorebook-manager.js');
        ModuleLoader.register('lorebook-manager', lorebookModule.default);

        window.openLorebookManager = lorebookModule.openModal;
        // the chats module promotes an embedded book through here; the converter lives with the world format
        window.promoteEmbeddedLorebook = lorebookModule.promoteEmbeddedLorebook;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load lorebook-manager module:', err);
    }

    if (SLICE_ENABLED.has('playlists')) try {
        loadModuleCSS('./playlists.css');
        const playlistsModule = await import('./playlists.js');
        ModuleLoader.register('playlists', playlistsModule.default);

        window.playlistsLoadPlaylists = playlistsModule.loadPlaylists;
        window.playlistsRemoveFromPlaylist = playlistsModule.removeFromPlaylist;
        window.playlistsGetAll = playlistsModule.getAllPlaylists;
        window.playlistsGetPlaylist = playlistsModule.getPlaylist;
        window.playlistsGetCharacters = playlistsModule.getPlaylistCharacters;
        window.playlistsGetForChar = playlistsModule.getPlaylistsForChar;
        window.playlistsIsCharInAny = playlistsModule.isCharInAnyPlaylist;
        window.openPlaylistPicker = playlistsModule.openPlaylistPicker;
        window.openPlaylistManager = playlistsModule.openPlaylistManager;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load playlists module:', err);
    }

    if (SLICE_ENABLED.has('media-download-queue')) try {
        const mediaQueueModule = await import('./media-download-queue.js');
        ModuleLoader.register('media-download-queue', mediaQueueModule.default);

        window.enqueueMediaDownloadJob = mediaQueueModule.enqueueJob;
    } catch (err) {
        console.warn('[ModuleLoader] Could not load media-download-queue module:', err);
    }

    // Tier 1 because init() binds the conversation header button, which is in the
    // static shell and can be clicked before any chat module has loaded.
    if (SLICE_ENABLED.has('prompt-manager')) try {
        loadModuleCSS('./chats/prompt-manager.css');
        const promptManagerModule = await import('./chats/prompt-manager.js');
        ModuleLoader.register('prompt-manager', promptManagerModule.default);
    } catch (err) {
        console.warn('[ModuleLoader] Could not load prompt-manager module:', err);
    }

    // same tier, same reason: init() binds a static-shell header button clickable before any chat module loads
    if (SLICE_ENABLED.has('connection-manager')) try {
        loadModuleCSS('./chats/connection-manager.css');
        const connectionManagerModule = await import('./chats/connection-manager.js');
        ModuleLoader.register('connection-manager', connectionManagerModule.default);
    } catch (err) {
        console.warn('[ModuleLoader] Could not load connection-manager module:', err);
    }

    // Gallery Extractors - lazy-loaded on first use to save memory
    // All call sites guard with typeof window.extractGalleryImages === 'function'
    let _extractorsLoaded = false;
    async function ensureExtractorsLoaded() {
        if (_extractorsLoaded) return;
        _extractorsLoaded = true;
        try {
            const { findCharacterGalleryUrls, extractGalleryImages, identifyGallerySources } = await import('./gallery-extractors/extractor-registry.js');
            await Promise.all([
                import('./gallery-extractors/imgchest.js'),
                import('./gallery-extractors/imgbb.js'),
                import('./gallery-extractors/gdrive.js'),
                import('./gallery-extractors/catbox.js'),
                import('./gallery-extractors/mega.js'),
                import('./gallery-extractors/postimg.js'),
                import('./gallery-extractors/imgbox.js'),
                import('./gallery-extractors/civitai.js'),
                import('./gallery-extractors/dropbox.js'),
                import('./gallery-extractors/pixiv.js')
            ]);
            window.findCharacterGalleryUrls = findCharacterGalleryUrls;
            window.extractGalleryImages = extractGalleryImages;
            window.identifyGallerySources = identifyGallerySources;
            window.debugLog?.('[ModuleLoader] Gallery extractors loaded (on demand)');
        } catch (err) {
            _extractorsLoaded = false;
            console.warn('[ModuleLoader] Could not load gallery extractors:', err);
        }
    }
    window.ensureExtractorsLoaded = ensureExtractorsLoaded;

    // Providers - must be Tier 1 because ProviderRegistry is queried
    // during character grid rendering (link indicators, taglines, etc.)
    if (SLICE_ENABLED.has('providers')) {
    loadModuleCSS('./providers/browse-shared.css');
    // a row without a dir is an external row: an extension ships its code, nothing loads here
    const firstPartyRows = Object.values(PROVIDER_MANIFEST).filter(p => p.dir);
    for (const p of firstPartyRows) {
        if (p.browseCss) loadModuleCSS(`./providers/${p.dir}/${p.dir}-browse.css`);
    }
    {
        // manifest key order IS registration order: janitorai precedes janny for getProviderForUrl's tie-break
        const providerImports = firstPartyRows.map(p => (
            { name: p.dir, load: () => import(`./providers/${p.dir}/${p.dir}-provider.js`) }
        ));
        const results = await Promise.allSettled(providerImports.map(p => p.load()));
        for (let i = 0; i < results.length; i++) {
            if (results[i].status === 'fulfilled') {
                ProviderRegistry.registerProvider(results[i].value.default);
            } else {
                console.warn(`[ModuleLoader] Failed to load ${providerImports[i].name} provider:`, results[i].reason);
            }
        }
        try {
            await ProviderRegistry.initProviders(CoreAPI);
        } catch (err) {
            console.warn('[ModuleLoader] Provider initialization error:', err);
        }
        window.ProviderRegistry = ProviderRegistry;
        // the media downloader in library.js (a classic script) builds its proxy leg through the one builder
        window.proxiedUrl = proxiedUrl;
        window.closeActiveBrowseDropdowns = ProviderRegistry.closeActiveBrowseDropdowns;
        // an Online start page entered before this tier landed activates on it
        document.dispatchEvent(new CustomEvent('cl-providers-ready'));
        window.debugLog?.(`[ModuleLoader] Providers registered and initialized (${ProviderRegistry.getAllProviders().length}/${providerImports.length})`);
    }
    }

    await ModuleLoader.initAll(dependencies);

    // extensions load LAST, after everything first-party; the reverse bridge below drives settings' manager UI
    try {
        const extHost = await import('./extension-host.js');
        // another tab's switch arrives as an extension record; the host has no feed import (the kit runs it feedless)
        registerFeedPatcher('extension', extHost.patchExtensionsFromFeed);
        window.ExtensionHost = {
            setEnabled: (id, on) => extHost.setExtensionEnabled(id, on, loadExtensionCSS),
            install: extHost.installExtension,
            reload: (id) => extHost.reloadExtension(id, loadExtensionCSS),
            unload: extHost.unloadExtension,
            inspect: extHost.inspectExtension,
            getExtensionStatus: extHost.getExtensionStatus,
            renderSettingsSection: extHost.renderSettingsSection,
            hasSettingsSection: extHost.hasSettingsSection,
            injectPendingProviderSections: extHost.injectPendingProviderSections,
            actionsFor: extHost.actionsFor,
            runAction: extHost.runAction,
            hasBadges: extHost.hasBadges,
            badgesFor: extHost.badgesFor,
            getDetailTabs: extHost.getDetailTabs,
            renderDetailTab: extHost.renderDetailTab,
            getViews: extHost.getViews,
            enterView: extHost.enterView,
            leaveView: extHost.leaveView,
            refreshView: extHost.refreshView,
            getQueryDoors: extHost.getQueryDoors,
            extensionShapesRows: extHost.extensionShapesRows,
        };
        await extHost.loadExtensions(loadExtensionCSS);
    } catch (err) {
        console.error('[ModuleLoader] Extension host failed:', err);
    } finally {
        // fires whether extensions loaded, bailed, or the host itself failed: consumers
        // gating on late providers (the media queue's resume) wait on this, not on time
        document.dispatchEvent(new CustomEvent('cl-extensions-settled'));
    }

    // server halves queue extension jobs, so their notifications section does not wait on the client host
    try {
        const extJobs = await import('./extension-jobs.js');
        void extJobs.startExtensionJobs({
            apiRequest: CoreAPI.apiRequest,
            registerNotificationSection: CoreAPI.registerNotificationSection,
            refreshNotificationsUI: CoreAPI.refreshNotificationsUI,
            escapeHtml: CoreAPI.escapeHtml,
            showToast: CoreAPI.showToast,
        });
    } catch (err) {
        console.error('[ModuleLoader] Extension jobs failed:', err);
    }
    // installed extensions with a newer version, for an admin who switched on hearing about them
    try {
        const extUpdates = await import('./extension-updates.js');
        void CoreAPI.settingsReady().then(() => extUpdates.startExtensionUpdates({
            apiRequest: CoreAPI.apiRequest,
            readAnswer: CoreAPI.readAnswer,
            getSetting: CoreAPI.getSetting,
            escapeHtml: CoreAPI.escapeHtml,
            showToast: CoreAPI.showToast,
            registerNotificationSection: CoreAPI.registerNotificationSection,
            refreshNotificationsUI: CoreAPI.refreshNotificationsUI,
            openExtensions: () => {
                // Settings brings the first row with an update into view once its list is drawn
                document.dispatchEvent(new CustomEvent('cl-extension-updates-focus'));
                CoreAPI.openSettingsToSection('extensions');
            },
            // Settings' Installed rows show the same answer the bell does
            onChange: (state) => document.dispatchEvent(new CustomEvent('cl-extension-updates-changed', { detail: state })),
        }));
    } catch (err) {
        console.error('[ModuleLoader] Extension updates failed:', err);
    }

    window.debugLog?.('[ModuleLoader] Module system ready');
}


// ========================================
// LAZY: BATCH TAGGING
// ========================================

function setupLazyBatchTagging() {
    ModuleLoader._registerLazy('batch-tagging', async () => {
        const mod = await import('./batch-tagging.js');
        // Awaited: the first open otherwise paints the modal unstyled until the link lands
        await loadModuleCSS('./batch-tagging.css');
        ModuleLoader.register('batch-tagging', mod.default);
        await mod.default.init({});
        mod.default._mlInitDone = true;
        window.debugLog?.('[ModuleLoader] Lazy-loaded batch-tagging');
    });
}


// ========================================
// LAZY: TAGS MANAGER
// ========================================

function setupLazyTagsManager() {
    ModuleLoader._registerLazy('tags-manager', async () => {
        const mod = await import('./tags-manager.js');
        await loadModuleCSS('./tags-manager.css');
        ModuleLoader.register('tags-manager', mod.default);
        await mod.default.init({});
        mod.default._mlInitDone = true;
        window.debugLog?.('[ModuleLoader] Lazy-loaded tags-manager');
    });
}


// ========================================
// LAZY: COMMAND PALETTE
// ========================================

function setupLazyCommandPalette() {
    ModuleLoader._registerLazy('command-palette', async () => {
        const mod = await import('./command-palette.js');
        await loadModuleCSS('./command-palette.css');
        ModuleLoader.register('command-palette', mod.default);
        await mod.default.init({});
        mod.default._mlInitDone = true;
        window.debugLog?.('[ModuleLoader] Lazy-loaded command-palette');
    });
    // warmed once the page is idle, so its first open is instant
    const warm = () => ModuleLoader.ensureLoaded('command-palette').catch(() => { /* a failed warm-up loads on the first open */ });
    const idle = () => (window.requestIdleCallback ? window.requestIdleCallback(warm, { timeout: 5000 }) : setTimeout(warm, 2000));
    if (document.readyState === 'complete') idle();
    else window.addEventListener('load', idle, { once: true });
}


// ========================================
// LAZY: BATCH TRANSFER (bundle export/import)
// ========================================

function setupLazyBatchTransfer() {
    ModuleLoader._registerLazy('batch-transfer', async () => {
        const mod = await import('./batch-transfer.js');
        await loadModuleCSS('./batch-transfer.css');
        ModuleLoader.register('batch-transfer', mod.default);
        await mod.default.init({});
        mod.default._mlInitDone = true;
        window.debugLog?.('[ModuleLoader] Lazy-loaded batch-transfer');
    });

    // library.js's import modal routes dropped .zip bundles here
    window.openBatchImportReview = (...args) =>
        ModuleLoader.ensureLoaded('batch-transfer').then(mod => mod?.openImportReview?.(...args));
}


// ========================================
// LAZY: CHATS
// ========================================

function setupLazyChats() {
    const { createStub } = createLazyBridgeGroup(
        () => import('./chats/index.js'),
        (mod) => {
            const chats = mod.default;
            ModuleLoader.register('chats', chats);
            chats.init({});
            chats._mlInitDone = true;

            window.chatsModule = {
                fetchCharacterChats: chats.fetchCharacterChats,
                createNewChat: chats.createNewChat,
                openConversationForCharacter: chats.openConversationForCharacter,
                openChatById: chats.openChatById,
                loadAllChats: chats.loadAllChats,
                renderChats: chats.renderChats,
                applyChatWorlds: chats.applyChatWorlds,
                applyChatWorldsBatch: chats.applyChatWorldsBatch,
                // absent from the stubs below: each acts on a conversation that cant exist before this module loads
                applyChatMeasure: chats.applyChatMeasure,
                closeConversation: chats.closeConversation,
                suspendConversation: chats.suspendConversation,
                conversationCharacterId: chats.conversationCharacterId,
                syncConversationProfile: chats.syncConversationProfile,
                syncConversationPreset: chats.syncConversationPreset,
                // absent from the stubs too: the session sort it resets is seeded by the module's first enter
                resetViewDefaults: chats.resetViewDefaults,
                composeText: chats.composeText,
                sendText: chats.sendText,
                attachPicture: chats.attachPicture,
                seesPictures: chats.seesPictures,
            };

            window.fetchCharacterChats = chats.fetchCharacterChats;
            window.createNewChat = chats.createNewChat;

            window.debugLog?.('[ModuleLoader] Lazy-loaded chats');
        }
    );

    const chatStub = (method) => createStub(() => window.chatsModule?.[method]);

    window.chatsModule = {
        fetchCharacterChats: chatStub('fetchCharacterChats'),
        createNewChat: chatStub('createNewChat'),
        // Stubbed, unlike the conversation-state bridges: the detail modal can be open
        // long before this module has ever loaded, and its Chat button must still work.
        openConversationForCharacter: chatStub('openConversationForCharacter'),
        // stubbed for the same reason: an extension can open a chat before this module loaded
        openChatById: chatStub('openChatById'),
        loadAllChats: chatStub('loadAllChats'),
        renderChats: chatStub('renderChats'),
        applyChatWorlds: chatStub('applyChatWorlds'),
        applyChatWorldsBatch: chatStub('applyChatWorldsBatch'),
    };

    window.fetchCharacterChats = chatStub('fetchCharacterChats');
    window.createNewChat = chatStub('createNewChat');

    // the conversation's open verb as a command, live before the module loads like its stub
    defineCommand('chat.open', ({ chatId, seq, messageId } = {}) => CoreAPI.openChatById(chatId, { seq, messageId }), { title: 'Open a chat' });
    defineCommand('chat.compose', composeFrom, { title: 'Put text in the composer' });
    defineCommand('chat.send', sendFrom, { title: 'Send a message as the reader' });
}

// the composer's two verbs: no conversation open, the module not loaded included, answers false
function composeFrom({ text, mode } = {}) {
    if (typeof text !== 'string') throw new Error('chat.compose: text must be a string');
    const how = mode ?? 'replace';
    if (how !== 'replace' && how !== 'append') throw new Error(`chat.compose: mode is 'replace' or 'append', not "${how}"`);
    return window.chatsModule?.composeText?.(text, how) ?? false;
}

function sendFrom({ text } = {}) {
    if (typeof text !== 'string') throw new Error('chat.send: text must be a string');
    return window.chatsModule?.sendText?.(text) ?? false;
}


// ========================================
// EXPOSE & BOOTSTRAP
// ========================================

window.ModuleLoader = ModuleLoader;

// a module script evaluates once the page is parsed, so the stubs land before the shell's boot reads them
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initModuleSystem);
} else {
    initModuleSystem();
}
