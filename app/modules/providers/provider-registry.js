// Provider Registry - manages external source providers for the Online tab

import { invalidateSharedBaseLookup, adoptNameIntoSharedBase } from './browse-view.js';

// the manifest is a classic script (library.js needs it at parse time), so this is the one sanctioned window read
export const PROVIDER_MANIFEST = window.PROVIDER_MANIFEST || {};
if (!Object.keys(PROVIDER_MANIFEST).length) {
    console.error('[ProviderRegistry] provider-manifest.js did not load; every derived provider surface is empty');
}

/** @type {Map<string, import('./provider-interface.js').ProviderBase>} */
const providers = new Map();

/** @type {string|null} */
let activeProviderId = null;

// the Online tab's content KIND; dispatchers read the active view for the kind, never browseView
let activeKind = 'characters';
export function getActiveKind() { return activeKind; }
function viewFor(provider, kind) {
    if (!provider) return null;
    return kind === 'lorebooks' ? (provider.lorebookView ?? null) : (provider.browseView ?? null);
}
/** The view on screen: the active provider's view for the active kind. */
export function getActiveView() { return viewFor(getActiveProvider(), activeKind); }

/** Bumped per activateProvider call so a switch during an in-activate await can be detected. */
let _activationGen = 0;

// per kind, the view whose grid is painted or parked; panes persist side by side, so a kind switch keeps the other's
const renderedKeys = new Map();

/** @type {Object|null} CoreAPI reference, set during init */
let coreAPI = null;

// Bumped whenever a manifest row lands or rolls back, so memoized derivations (the
// per-card listing walk in library.js) rebuild instead of exiling a late provider.
let _manifestGen = 0;
export function manifestGeneration() { return _manifestGen; }

// ========================================
// REGISTRATION
// ========================================

/**
 * Register a provider instance. Call this during module loading, before init.
 * @param {import('./provider-interface.js').ProviderBase} provider
 */
export function registerProvider(provider) {
    if (!provider?.id) {
        console.error('[ProviderRegistry] Cannot register provider without id');
        return;
    }
    if (providers.has(provider.id)) {
        console.warn(`[ProviderRegistry] Provider "${provider.id}" already registered, replacing`);
    }
    // Loud, not fatal: the provider still works, but every manifest-derived surface
    // (search prefixes, adv filter, exclude tags, listing-name walk) is blind to it.
    if (!PROVIDER_MANIFEST[provider.id]) {
        console.error(`[ProviderRegistry] Provider "${provider.id}" has no PROVIDER_MANIFEST row; derived surfaces will miss it`);
    }
    // the base reads its identity, hosts and flags off the row from here on
    provider._manifest = PROVIDER_MANIFEST[provider.id] || null;
    providers.set(provider.id, provider);
    coreAPI?.debugLog(`[ProviderRegistry] Registered provider: ${provider.name} (${provider.id})`);
}

/**
 * Switch a new disabledByDefault provider off for installs that predate it (a saved disabledProviders wins over the default).
 */
function reconcileNewDisabledByDefault() {
    const order = coreAPI?.getSetting('providerOrder');
    const disabled = coreAPI?.getSetting('disabledProviders');
    // Nothing persisted yet: DEFAULT_SETTINGS already carries the right list.
    if (!Array.isArray(disabled) || (!Array.isArray(order) && !disabled.length)) return;

    const seen = new Set([...(Array.isArray(order) ? order : []), ...disabled]);
    const next = [...disabled];
    for (const provider of providers.values()) {
        if (!provider.disabledByDefault || seen.has(provider.id)) continue;
        next.push(provider.id);
        coreAPI?.debugLog(`[ProviderRegistry] New disabled-by-default provider, opting out: ${provider.id}`);
    }
    if (next.length !== disabled.length) coreAPI?.setSetting('disabledProviders', next);
}

/**
 * Initialize all registered providers with the CoreAPI reference.
 * Called once during app startup after CoreAPI is available.
 * @param {Object} api - CoreAPI object
 */
export async function initProviders(api) {
    coreAPI = api;
    for (const [id, provider] of providers) {
        try {
            await provider.init(api);
            if (provider.browseView) provider.browseView.provider = provider;
            if (provider.lorebookView) provider.lorebookView.provider = provider;
            coreAPI.debugLog(`[ProviderRegistry] Initialized provider: ${id}`);
        } catch (err) {
            console.error(`[ProviderRegistry] Failed to init provider "${id}":`, err);
        }
    }
    reconcileNewDisabledByDefault();
    coreAPI.onCharactersDeleted(() => rebuildAllBrowseLookups());
    // the other half of registerProvider's coverage assert; external rows are claimed later and checked by the extension host
    for (const [id, row] of Object.entries(PROVIDER_MANIFEST)) {
        if (!row.external && !providers.has(id)) console.error(`[ProviderRegistry] PROVIDER_MANIFEST row "${id}" has no registered provider`);
    }
}

// the ids registerExtensionProvider landed, the only ones an unregister may take back out
const _extensionProviders = new Set();
// id -> the external row as declared, before an extension claimed it
const _externalClaims = new Map();

/**
 * Register a provider after boot (an extension's): add or claim its manifest row, init it, refresh the derived surfaces.
 * @param {import('./provider-interface.js').ProviderBase} provider
 * @param {Object} manifestRow the provider's PROVIDER_MANIFEST row (sparse rows normalize)
 */
export async function registerExtensionProvider(provider, manifestRow = {}) {
    if (!provider?.id) throw new Error('extension provider needs an id');
    if (!coreAPI) throw new Error('registerExtensionProvider ran before initProviders');
    const existing = PROVIDER_MANIFEST[provider.id];
    if (existing && !(existing.external && !providers.has(provider.id))) {
        throw new Error(`provider id "${provider.id}" is already taken`);
    }
    if (existing) {
        // claiming a pre-declared external row; the row as declared is kept so an unregister hands it back unclaimed
        _externalClaims.set(provider.id, { ...existing });
        Object.assign(existing, manifestRow);
    } else {
        // normalized so a sparse row can never break a shared derivation (an undefined
        // searchPrefixes would throw inside the search parser, for everyone)
        PROVIDER_MANIFEST[provider.id] = {
            name: provider.name || provider.id,
            extNamespace: provider.id,
            searchPrefixes: [],
            excludeTagKey: provider.id,
            dir: null, browseCss: false, cssPrefix: null,
            ...manifestRow,
        };
    }
    _manifestGen++;
    registerProvider(provider);
    try {
        await provider.init(coreAPI);
        if (provider.browseView) provider.browseView.provider = provider;
        if (provider.lorebookView) provider.lorebookView.provider = provider;
    } catch (err) {
        providers.delete(provider.id);
        releaseManifestRow(provider.id);
        _manifestGen++;
        throw err;
    }
    _extensionProviders.add(provider.id);
    reconcileNewDisabledByDefault();
    coreAPI.refreshProviderSelector();
    // cards painted before this provider existed miss its link badge; a light resync
    // re-renders the current grid window without clearing caches
    coreAPI.refreshCharacters(false);
}

// an extension's own row leaves; a claimed external row goes back to its declared shape
function releaseManifestRow(id) {
    const declared = _externalClaims.get(id);
    _externalClaims.delete(id);
    if (!declared) { delete PROVIDER_MANIFEST[id]; return; }
    const row = PROVIDER_MANIFEST[id];
    for (const k of Object.keys(row)) if (!(k in declared)) delete row[k];
    Object.assign(row, declared);
}

/**
 * Take an extension's provider out (its extension switched off): view, then provider and row; first-party never.
 * @returns {boolean} whether the id named a provider an extension registered
 */
export function unregisterExtensionProvider(id) {
    if (!_extensionProviders.has(id)) return false;
    _extensionProviders.delete(id);
    if (activeProviderId === id) {
        const view = getActiveView();
        if (view) { try { view.deactivate(); } catch (e) { console.error('[ProviderRegistry] deactivate error:', e); } }
        activeProviderId = null;
    }
    // its modals leave too, or a reloaded module injects a second set under the same ids
    try { providers.get(id)?.browseView?.removeModals?.(); } catch (e) { console.error('[ProviderRegistry] removeModals error:', e); }
    // and its panes: a stale mark would hand a re-enable the old DOM, skipping the modals it just lost
    for (const [kind, key] of renderedKeys) if (key === `${kind}:${id}`) renderedKeys.delete(kind);
    document.querySelectorAll?.('[data-rendered-provider]').forEach(el => {
        if (String(el.dataset.renderedProvider).endsWith(`:${id}`)) delete el.dataset.renderedProvider;
    });
    providers.delete(id);
    releaseManifestRow(id);
    _manifestGen++;
    coreAPI?.refreshProviderSelector();
    coreAPI?.refreshCharacters(false);
    return true;
}

// ========================================
// PROVIDER ACCESS
// ========================================

/**
 * Get a provider by ID.
 * @param {string} id
 * @returns {import('./provider-interface.js').ProviderBase|undefined}
 */
export function getProvider(id) {
    return providers.get(id);
}

/**
 * Get all registered providers.
 * @returns {import('./provider-interface.js').ProviderBase[]}
 */
export function getAllProviders() {
    return [...providers.values()];
}

/**
 * Get providers that have a view for a kind (characters by default), respecting saved order.
 * @param {'characters'|'lorebooks'} [kind]
 * @returns {import('./provider-interface.js').ProviderBase[]}
 */
export function getViewProviders(kind = 'characters') {
    const disabledSet = new Set(coreAPI?.getSetting('disabledProviders') || []);
    const all = getAllProviders().filter(p => !!viewFor(p, kind) && !disabledSet.has(p.id));
    const savedOrder = coreAPI?.getSetting('providerOrder');
    if (!Array.isArray(savedOrder) || savedOrder.length === 0) return all;

    const byId = new Map(all.map(p => [p.id, p]));
    const ordered = [];
    for (const id of savedOrder) {
        const p = byId.get(id);
        if (p) {
            ordered.push(p);
            byId.delete(id);
        }
    }
    // Append any providers not in saved order (newly added)
    for (const p of byId.values()) ordered.push(p);
    return ordered;
}

/**
 * Get the currently active provider (the one visible in the Online tab).
 * @returns {import('./provider-interface.js').ProviderBase|null}
 */
export function getActiveProvider() {
    return activeProviderId ? providers.get(activeProviderId) ?? null : null;
}

/**
 * Get the active provider's ID.
 * @returns {string|null}
 */
export function getActiveProviderId() {
    return activeProviderId;
}

// ========================================
// ACTIVATION / DEACTIVATION
// ========================================

/**
 * Switch the Online tab to a provider and kind, deactivating the previous view.
 * @param {string} providerId
 * @param {HTMLElement} container - the provider content area
 * @param {HTMLElement} [filterContainer] - the filter bar area
 * @param {{ kind?: 'characters'|'lorebooks' }} [options]
 */
export async function activateProvider(providerId, container, filterContainer, { kind = 'characters' } = {}) {
    const gen = ++_activationGen;
    const prevView = getActiveView();
    const prevId = activeProviderId;
    const switching = prevView && (prevId !== providerId || activeKind !== kind);
    if (switching) {
        try { prevView.deactivate(); } catch (e) { console.error('[ProviderRegistry] deactivate error:', e); }
    }

    const provider = providers.get(providerId);
    const view = viewFor(provider, kind);
    if (!provider || !view) {
        console.error(`[ProviderRegistry] Provider "${providerId}" has no ${kind} view`);
        return;
    }

    activeProviderId = providerId;
    activeKind = kind;
    // the rendered marks carry the kind: a kind switch on one provider rebuilds its DOM
    const renderKey = `${kind}:${providerId}`;

    if (filterContainer) {
        if (filterContainer.dataset.renderedProvider !== renderKey) {
            filterContainer.innerHTML = view.renderFilterBar() || '';
            filterContainer.dataset.renderedProvider = renderKey;
        }
    }

    const domRecreated = container.dataset.renderedProvider !== renderKey;
    if (domRecreated) {
        container.innerHTML = view.renderView() || '';
        container.dataset.renderedProvider = renderKey;
        renderedKeys.set(kind, renderKey);
    }

    updateProviderSelector(providerId);
    updateKindToggle(providerId, kind);

    try {
        // the settings-panel per-provider defaults are the character listing's
        const providerDefaults = coreAPI?.getSetting('providerDefaults') || {};
        const defaults = kind === 'characters' ? (providerDefaults[providerId] || null) : null;
        await view.activate(container, { domRecreated, defaults });
    } catch (err) {
        console.error(`[ProviderRegistry] activate error for "${providerId}" (${kind}):`, err);
    }

    // a newer switch landed during the await: undo this re-arm, unless that call activated this same view
    if (gen !== _activationGen) {
        if (activeProviderId !== providerId || activeKind !== kind) {
            try { view.deactivate(); } catch (e) { console.error('[ProviderRegistry] stale-activation deactivate error:', e); }
        }
        return;
    }
}

/**
 * Deactivate the current provider (e.g. when leaving the Online tab).
 */
export function deactivateCurrentProvider() {
    const view = getActiveView();
    if (view) {
        try { view.deactivate(); } catch (e) { console.error('[ProviderRegistry] deactivate error:', e); }
    }
}

// ========================================
// GENERIC QUERIES - works across all providers
// ========================================

/**
 * Find which provider owns a character by checking each provider's getLinkInfo.
 * Returns the first match.
 * @param {Object} char - character object
 * @returns {{ provider: import('./provider-interface.js').ProviderBase, linkInfo: import('./provider-interface.js').ProviderLinkInfo }|null}
 */
export function getCharacterProvider(char) {
    for (const provider of providers.values()) {
        const linkInfo = provider.getLinkInfo(char);
        if (linkInfo) {
            return { provider, linkInfo };
        }
    }
    return null;
}

/**
 * Get link info for a character from any provider.
 * @param {Object} char
 * @returns {import('./provider-interface.js').ProviderLinkInfo|null}
 */
export function getLinkInfo(char) {
    return getCharacterProvider(char)?.linkInfo ?? null;
}

// Which extensions namespace owns the tagline. Real provider id when linked, 'cl' when unlinked. cl is the pseudo-provider for the no-real-provider state.
export function getActiveTaglineNamespace(char) {
    return getCharacterProvider(char)?.provider?.id ?? 'cl';
}

/**
 * Pair each character of a server-answered linked set (core-api getAllLinkedCharacters) with its
 * provider and link.
 * @param {Array} linkedSet
 * @returns {Array<{char: Object, provider: import('./provider-interface.js').ProviderBase, linkInfo: import('./provider-interface.js').ProviderLinkInfo}>}
 */
export function getAllLinkedCharacters(linkedSet) {
    const results = [];
    for (const char of linkedSet) {
        const match = getCharacterProvider(char);
        if (match) {
            results.push({ char, provider: match.provider, linkInfo: match.linkInfo });
        }
    }
    return results;
}

/**
 * Find which provider can handle a given URL.
 * @param {string} url
 * @returns {import('./provider-interface.js').ProviderBase|null}
 */
export function getProviderForUrl(url, { accept } = {}) {
    const disabledSet = new Set(coreAPI?.getSetting('disabledProviders') || []);
    // accept adds "and it must parse": janitorai and janny both claim janitorai.com, so scan past a rejecter
    const claims = (provider) => provider.canHandleUrl(url) && (!accept || accept(provider));
    let disabledMatch = null;
    for (const provider of providers.values()) {
        if (!claims(provider)) continue;
        if (!disabledSet.has(provider.id)) return provider;
        if (!disabledMatch) disabledMatch = provider;
    }
    // a disabled provider still claims its links when nothing enabled does: disabling is about the browse selector
    return disabledMatch;
}

// ========================================
// PROVIDER SELECTOR UI
// ========================================

/**
 * The provider selector's native <select> (styled later by initCustomSelect); empty with fewer than 2 view providers.
 * @param {string} activeId - currently active provider ID
 * @returns {string} HTML string (empty if 1 or fewer view providers)
 */
export function renderProviderSelector(activeId) {
    const vps = getViewProviders();
    if (vps.length < 2) return '';

    const options = vps.map(p => {
        const selected = p.id === activeId ? ' selected' : '';
        const iconUrl = p.iconUrl || '';
        const status = p.deprecated ? ' data-deprecated="true"' : (p.beta ? ' data-beta="true"' : '');
        return `<option value="${p.id}"${selected} data-icon-url="${iconUrl}"${status}>${p.name}</option>`;
    }).join('');

    return `<select id="providerSelect" class="glass-select">${options}</select>`;
}

/**
 * Update active state on existing provider selector.
 * @param {string} activeId
 */
function updateProviderSelector(activeId) {
    const select = document.getElementById('providerSelect');
    if (select && select.value !== activeId) {
        select.value = activeId;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

// the kind toggle: shown while the active provider lists lorebooks, wearing the kind it switches to (fixed-width icons, so the swap never resizes it)
export function renderKindToggle() {
    return `<button type="button" id="onlineKindToggle" class="glass-btn icon-only online-kind-toggle hidden" title="Browse this site's lorebooks"><i class="fa-solid fa-fw fa-book-atlas"></i></button>`;
}

/** Repaint the kind toggle for the active provider and kind: its icon and title name the other kind. */
export function updateKindToggle(providerId = activeProviderId, kind = activeKind) {
    const btn = document.getElementById('onlineKindToggle');
    if (!btn) return;
    const has = !!providers.get(providerId)?.lorebookView;
    btn.classList.toggle('hidden', !has);
    const toCharacters = kind === 'lorebooks';
    btn.title = toCharacters ? 'Browse this site\'s characters' : 'Browse this site\'s lorebooks';
    const icon = btn.querySelector('i');
    if (icon) icon.className = `fa-solid fa-fw ${toCharacters ? 'fa-users' : 'fa-book-atlas'}`;
}

/**
 * Attach change handler to the provider selector dropdown. Called once after
 * the selector HTML has been injected into the DOM and initCustomSelect() runs.
 * @param {Function} onSwitch - callback(providerId) when user picks a provider
 */
export function initProviderSelector(onSwitch) {
    const select = document.getElementById('providerSelect');
    if (!select) return;

    select.addEventListener('change', () => {
        const id = select.value;
        if (id && id !== activeProviderId) {
            onSwitch(id);
        }
    });

    coreAPI?.initCustomSelect(select);
}

// ========================================
// BROWSE LIBRARY LOOKUP DISPATCHERS
// ========================================

export function rebuildAllBrowseLookups() {
    invalidateSharedBaseLookup();
    for (const [id, p] of providers) {
        void p.browseView?.rebuildLocalLibraryLookup({ shown: renderedKeys.get('characters') === `characters:${id}` });
    }
}

let _adoptHealTimer = null;
/**
 * A character this tab took in reaches every view's lookup at once: name, link, and a heal once the burst settles.
 * @param {Object} char
 */
export function adoptCharacterInBrowseLookups(char) {
    if (!char) return;
    adoptNameIntoSharedBase(char);
    for (const p of providers.values()) p.browseView?.markLinked(char);
    clearTimeout(_adoptHealTimer);
    _adoptHealTimer = setTimeout(() => {
        _adoptHealTimer = null;
        const painted = renderedKeys.get('characters');
        if (painted) providers.get(painted.slice('characters:'.length))?.browseView?.refreshInLibraryBadges();
    }, 600);
}

export function refreshActiveBrowseBadges() {
    getActiveView()?.refreshInLibraryBadges();
}

// ========================================
// MOBILE INTEGRATION HELPERS
// ========================================

export function getPreviewModalIds() {
    const ids = new Set();
    for (const provider of providers.values()) {
        for (const view of [provider.browseView, provider.lorebookView]) {
            const id = view?.previewModalId;
            if (id) ids.add(id);
        }
    }
    return [...ids];
}

export function closeActivePreviewModal() {
    getActiveView()?.closePreview();
}

export function closeActiveBrowseDropdowns(exceptId) {
    getActiveView()?.closeDropdowns(exceptId);
}

export function getActiveMobileFilterIds() {
    return getActiveView()?.mobileFilterIds ?? null;
}

export function activeProviderHasModeToggle() {
    return getActiveView()?.hasModeToggle ?? false;
}

// ========================================
// DEFAULT EXPORT
// ========================================

export default {
    registerProvider,
    initProviders,
    manifestGeneration,
    getProvider,
    getAllProviders,
    getViewProviders,
    getActiveProvider,
    getActiveProviderId,
    getActiveKind,
    getActiveView,
    activateProvider,
    deactivateCurrentProvider,
    getCharacterProvider,
    getLinkInfo,
    getActiveTaglineNamespace,
    getAllLinkedCharacters,
    getProviderForUrl,
    renderProviderSelector,
    renderKindToggle,
    updateKindToggle,
    initProviderSelector,
    rebuildAllBrowseLookups,
    adoptCharacterInBrowseLookups,
    refreshActiveBrowseBadges,
    getPreviewModalIds,
    closeActivePreviewModal,
    closeActiveBrowseDropdowns,
    getActiveMobileFilterIds,
    activeProviderHasModeToggle
};
