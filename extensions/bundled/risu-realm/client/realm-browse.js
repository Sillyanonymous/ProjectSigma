// SPDX-License-Identifier: MIT

// RisuAI Realm, the browse view; a card's definition lives only in its download, so the preview shows
// what the Realm shows.
import {
    BrowseView, featureFilterState, renderFeatureFilterItems, countActiveFeatures,
    activeFeatureRows, featurePasses, applyTagsClamp, updateNsfwToggleButton, cardTagsHtml, libraryFeatureRows, setFilterCount,
} from '/modules/providers/browse-view.js';
import CoreAPI from '/modules/core-api.js';
import {
    IMG_PLACEHOLDER, formatNumber, skeletonLines, deferCall, isMobileMode,
    renderBrowseError,
} from '/modules/providers/provider-utils.js';
import {
    REALM_SORTS, realmCharacterUrl, realmPictureUrl, searchRealm, realmQueryMixes,
    realmDescSections, pickRealmSection,
} from './realm-api.js';

const {
    onElement: on,
    showToast,
    escapeHtml,
    debugLog,
    renderCreatorNotesSecure,
    cleanupCreatorNotesContainer,
    renderSkeletonGrid,
} = CoreAPI;

// ========================================
// STATE
// ========================================

let realmRows = [];
let realmPage = 0;
let realmHasMore = true;
let realmIsLoading = false;
let realmLoadToken = 0;
let realmSearch = '';
let realmSort = '';
let realmNsfw = false;
let realmSelected = null;
let realmSelectedLang = null;
let realmGridRenderedCount = 0;
// the extension's own settings (ctx.settings), handed over by its entry
let realmSettings = null;

const REALM_FEATURE_FILTERS = [
    ...libraryFeatureRows('realm', () => view, isCharPossibleMatchObj),
];
const realmFeatureState = featureFilterState(REALM_FEATURE_FILTERS);
const REALM_FILTER_SECTIONS = [{ key: 'library', title: 'Library:' }];

let view; // the BrowseView instance (set once in its constructor)

/** The extension's settings facade (ctx.settings), read for the NSFW choice. */
export function setRealmSettings(settings) {
    realmSettings = settings || null;
}

// ========================================
// LOCAL LIBRARY LOOKUP
// ========================================

function isCharPossibleMatchObj(row) {
    if (view.isHitInLibrary(row)) return false;
    return view.isHitPossibleMatch(row);
}

// ========================================
// CARD RENDERING
// ========================================

/** One grid card for a listing row. */
export function realmCardHtml(row) {
    const name = row.name || 'Unnamed';
    const author = row.author || '';
    const tags = row.tags;
    const inLibrary = view.isHitInLibrary(row);
    const tier = inLibrary ? null : view.possibleMatchTierFor(row);
    const possible = !!tier?.show;
    const badges = view.importingBadge(row) + (inLibrary
        ? '<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>'
        : possible ? `<span class="browse-feature-badge possible-library pl-${tier.tier}" title="${escapeHtml(tier.tooltip)}"><i class="fa-solid fa-check"></i></span>` : '');
    const picture = realmPictureUrl(row.img) || '/img/no-portrait.png';
    const date = row.date ? new Date(row.date).toLocaleDateString() : '';
    const cardClass = inLibrary ? 'browse-card in-library' : possible ? 'browse-card possible-library' : 'browse-card';
    return `
        <div class="${cardClass}" data-realm-id="${escapeHtml(row.id)}"${view.linkKeyAttr(row)}${view.matchAttr(row)}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(picture)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/no-portrait.png'">
                ${badges ? `<div class="browse-feature-badges">${badges}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                ${author ? `<span class="browse-card-creator" data-author="${escapeHtml(author)}">${escapeHtml(author)}</span>` : ''}
                ${cardTagsHtml(tags)}
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Downloads"><i class="fa-solid fa-download"></i> ${row.downloads == null ? '?' : formatNumber(row.downloads)}</span>
                ${date ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${escapeHtml(date)}</span>` : ''}
            </div>
        </div>
    `;
}

// ========================================
// GRID RENDERING
// ========================================

function renderGrid(rows, append = false) {
    const grid = document.getElementById('realmGrid');
    if (!grid) return;
    if (!append) {
        grid.innerHTML = '';
        realmGridRenderedCount = 0;
    }
    const startIdx = realmGridRenderedCount;
    grid.insertAdjacentHTML('beforeend', rows.slice(startIdx).map(realmCardHtml).join(''));
    realmGridRenderedCount = rows.length;
    realmBrowseView.observeImages(grid);
    realmBrowseView.updateLoadMoreVisibility('realmLoadMore', realmHasMore, realmRows.length > 0);
}

// the persistent exclude tags (Settings, Online, RisuAI Realm) and the library rows, on the client
function passesClientFilters(rows, activeRows) {
    const exclude = view.persistentExcludeTags().map(t => t.toLowerCase());
    return rows.filter(r => (!exclude.length || !r.tags.some(t => exclude.includes(t.toLowerCase())))
        && (!activeRows.length || featurePasses(r, activeRows)));
}

// ========================================
// SEARCH / LOAD
// ========================================

async function loadCharacters(append = false) {
    if (append && realmIsLoading) return;
    const thisToken = ++realmLoadToken;
    realmIsLoading = true;
    const grid = document.getElementById('realmGrid');
    const loadMoreBtn = document.getElementById('realmLoadMoreBtn');
    if (!append && grid) renderSkeletonGrid(grid);
    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        const query = () => ({ search: realmSearch, page: realmPage, nsfw: realmNsfw, sort: realmSort });
        let { rows, hasMore } = await searchRealm(query());
        if (thisToken !== realmLoadToken || !delegatesInitialized) return;
        await realmBrowseView.probeHits(rows);

        const activeRows = activeFeatureRows(REALM_FEATURE_FILTERS, realmFeatureState);
        const filtering = activeRows.length > 0 || view.persistentExcludeTags().length > 0;
        rows = passesClientFilters(rows, activeRows);

        // a page the client filters thinned is topped up from the next ones, three at most
        let autoFetches = 0;
        while (filtering && hasMore && rows.length < 30 && autoFetches < 3 && delegatesInitialized) {
            autoFetches++;
            realmPage++;
            const more = await searchRealm(query());
            if (thisToken !== realmLoadToken || !delegatesInitialized) return;
            await realmBrowseView.probeHits(more.rows);
            rows = rows.concat(passesClientFilters(more.rows, activeRows));
            hasMore = more.hasMore;
        }
        if (autoFetches) debugLog(`[RealmBrowse] fetched ${autoFetches} more page(s) for the client filters`);

        if (append) {
            const seen = new Set(realmRows.map(r => r.id));
            realmRows = realmRows.concat(rows.filter(r => !seen.has(r.id)));
        } else {
            realmRows = rows;
        }
        realmHasMore = hasMore;
        renderGrid(realmRows, append);

        if (!append && realmRows.length === 0 && grid) {
            const mixed = realmQueryMixes(realmSearch);
            grid.innerHTML = `
                <div class="browse-empty-state">
                    <i class="fa-solid fa-ghost browse-empty-icon"></i>
                    <p class="browse-empty-title">No matches on the RisuAI Realm</p>
                    <p class="browse-empty-text">${mixed
                        ? 'The Realm searches words or tag: terms, not both at once: search one or the other.'
                        : 'Try other words, or tag:name to find a tag. The Realm searches names and tags, not creators.'}</p>
                </div>
            `;
        }
        debugLog('[RealmBrowse] Loaded', rows.length, 'characters, page', realmPage);
    } catch (err) {
        if (thisToken !== realmLoadToken) return;
        console.error('[RealmBrowse] Search error:', err);
        showToast(`RisuAI Realm search failed: ${err.message}`, 'error');
        if (!append && grid) {
            renderBrowseError(grid, {
                provider: 'risu-realm',
                error: err,
                message: `Search failed: ${err.message}`,
                flags: { nsfw: realmNsfw },
                retry: () => realmBrowseView.reload({ force: true }),
            });
        }
    } finally {
        if (thisToken === realmLoadToken) {
            realmIsLoading = false;
            if (loadMoreBtn) {
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
            }
        }
    }
}

// ========================================
// PREVIEW MODAL
// ========================================

function languageName(lang) {
    if (!lang) return 'Notes';
    try {
        return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(lang) || lang.toUpperCase();
    } catch {
        return lang.toUpperCase();
    }
}

// the chosen section of the description, through the notes renderer (the site's own text)
function showDescSection(row) {
    const sections = realmDescSections(row.desc);
    const section = document.getElementById('realmCharNotesSection');
    const el = document.getElementById('realmCharNotes');
    const langs = document.getElementById('realmCharLangs');
    if (!section || !el || !langs) return;
    if (!sections.length) {
        section.hidden = true;
        el.innerHTML = '';
        langs.innerHTML = '';
        return;
    }
    const chosen = sections.find(s => s.lang === realmSelectedLang) || pickRealmSection(sections, navigator.languages || []);
    realmSelectedLang = chosen.lang;
    section.hidden = false;
    // a select, rebuilt per card: the options are text, and the custom select sweeps the old menu
    langs.innerHTML = sections.length > 1
        ? `<select id="realmCharLang" class="glass-select glass-select-small" title="The language the notes are shown in">${sections.map(s =>
            `<option value="${escapeHtml(s.lang || '')}" ${s === chosen ? 'selected' : ''}>${escapeHtml(languageName(s.lang))}</option>`).join('')}</select>`
        : '';
    const select = langs.querySelector('select');
    if (select) CoreAPI.initCustomSelect?.(select);
    if (!el.querySelector('iframe')) el.innerHTML = skeletonLines(3);
    deferCall(el, () => renderCreatorNotesSecure(chosen.text, row.name || 'Unnamed', el));
}

/** Open the preview for a listing row (a grid card, or a linked character's listing). */
export function openRealmPreview(row) {
    if (!row?.id) return;
    realmSelected = row;
    realmSelectedLang = null;
    const modal = document.getElementById('realmCharModal');
    if (!modal) return;
    CoreAPI.resetBrowseSectionCollapseState?.(modal);

    const name = row.name || 'Unnamed';

    const avatar = document.getElementById('realmCharAvatar');
    BrowseView.setPreviewPortrait(avatar, realmPictureUrl(row.img));
    document.getElementById('realmCharName').textContent = name;
    document.getElementById('realmCharCreator').textContent = row.author || 'Unknown';
    document.getElementById('realmOpenInBrowserBtn').href = realmCharacterUrl(row.id);

    document.getElementById('realmCharDownloads').textContent = row.downloads == null ? '?' : formatNumber(row.downloads);
    document.getElementById('realmCharDate').textContent = row.date ? new Date(row.date).toLocaleDateString() : 'Unknown';
    const license = document.getElementById('realmCharLicense');
    license.textContent = row.license;
    // the attribute, as the other rows toggle: the phone's stats rule outranks a utility class
    const licenseRow = license.closest('.browse-stat');
    if (licenseRow) licenseRow.hidden = !row.license;

    const tagsEl = document.getElementById('realmCharTags');
    tagsEl.innerHTML = (row.tags || []).map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
    requestAnimationFrame(() => applyTagsClamp(tagsEl));

    showDescSection(row);

    // the import button, kept in step with the library while the preview is open
    const restampImport = () => view.stampPreviewImport(document.getElementById('realmImportBtn'), row);
    restampImport();
    view.trackPreview(restampImport, row);

    modal.classList.remove('hidden');
    const body = modal.querySelector('.browse-char-body');
    if (body) body.scrollTop = 0;
}

function closePreviewModal() {
    BrowseView.closeAvatarViewer?.();
    const notes = document.getElementById('realmCharNotes');
    if (notes) cleanupCreatorNotesContainer(notes);
    for (const id of ['realmCharTags', 'realmCharLangs']) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }
    document.getElementById('realmCharModal')?.classList.add('hidden');
    realmSelected = null;
    view?.trackPreview(null);
    realmSelectedLang = null;
}

// ========================================
// IMPORT
// ========================================

async function importCharacter(row) {
    if (!row?.id) return;
    // the definition arrives with the download, so the check has the name, the creator and the link
    await view.importFromPreview({
        button: document.getElementById('realmImportBtn'), hit: row, provider: 'risu-realm', id: row.id, data: row, label: 'RealmBrowse',
        closePreview: closePreviewModal,
        probe: { name: row.name || '', creator: row.author || '', fullPath: row.id, providerId: 'risu-realm', externalId: row.id },
        dialog: { name: row.name || '', creator: row.author || '', fullPath: row.id, avatarUrl: realmPictureUrl(row.img) || '/img/no-portrait.png' },
    });
}

function updateRealmFiltersButton() {
    const btn = document.getElementById('realmFiltersBtn');
    if (!btn) return;
    const count = countActiveFeatures(REALM_FEATURE_FILTERS, realmFeatureState);
    setFilterCount(btn, 'Features', count);
}

// ========================================
// EVENT WIRING
// ========================================

let delegatesInitialized = false;
let realmModalEventsAttached = false;

function initRealmView() {
    realmNsfw = realmSettings?.get('nsfw') === true;
    if (delegatesInitialized) return;
    delegatesInitialized = true;

    const sortEl = document.getElementById('realmSortSelect');
    if (sortEl) CoreAPI.initCustomSelect?.(sortEl);

    document.getElementById('realmGrid')?.addEventListener('click', (e) => {
        const card = e.target.closest('.browse-card');
        if (!card) return;
        const row = realmRows.find(r => r.id === card.dataset.realmId);
        if (row) openRealmPreview(row);
    });

    on('realmSearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doSearch();
        }
    });
    on('realmSearchInput', 'input', (e) => {
        document.getElementById('realmClearSearchBtn')?.classList.toggle('hidden', !e.target.value.trim());
    });
    on('realmSearchBtn', 'click', () => doSearch());
    on('realmClearSearchBtn', 'click', () => {
        const input = document.getElementById('realmSearchInput');
        if (input) input.value = '';
        document.getElementById('realmClearSearchBtn')?.classList.add('hidden');
        realmSearch = '';
        realmBrowseView.reload();
    });

    on('realmLoadMoreBtn', 'click', () => realmBrowseView.reload({ append: true }));

    on('realmNsfwToggle', 'click', () => {
        realmNsfw = !realmNsfw;
        realmSettings?.set('nsfw', realmNsfw);
        updateNsfwToggleButton('realmNsfwToggle', realmNsfw);
        realmBrowseView.reload();
    });
    updateNsfwToggleButton('realmNsfwToggle', realmNsfw);

    on('realmSortSelect', 'change', () => {
        realmSort = document.getElementById('realmSortSelect')?.value || '';
        realmSearch = (document.getElementById('realmSearchInput')?.value || '').trim();
        realmBrowseView.reload();
    });

    on('realmRefreshBtn', 'click', () => realmBrowseView.reload({ force: true }));

    const filtersDropdown = document.getElementById('realmFiltersDropdown');
    on('realmFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns?.('realmFiltersDropdown');
        filtersDropdown?.classList.toggle('hidden');
    });
    filtersDropdown?.addEventListener('click', (e) => e.stopPropagation());
    realmBrowseView.wireFeatureFilters(REALM_FEATURE_FILTERS, realmFeatureState, () => {
        realmBrowseView.reload();
    }, { badge: updateRealmFiltersButton });
    realmBrowseView._registerDropdownDismiss([{ dropdownId: 'realmFiltersDropdown', buttonId: 'realmFiltersBtn' }]);

    // the preview's DOM outlives provider switches, so its listeners attach once
    if (!realmModalEventsAttached) {
        realmModalEventsAttached = true;
        const overlay = document.getElementById('realmCharModal');
        BrowseView.wireTitleScroll?.(document.getElementById('realmCharName'), overlay, overlay?.querySelector('.browse-char-modal'));
        on('realmCharClose', 'click', () => closePreviewModal());
        document.getElementById('realmCharLangs')?.addEventListener('change', (e) => {
            if (e.target?.id !== 'realmCharLang' || !realmSelected) return;
            realmSelectedLang = e.target.value || null;
            showDescSection(realmSelected);
        });
        const avatar = document.getElementById('realmCharAvatar');
        avatar?.addEventListener('click', (e) => {
            // on a phone the delegated tap opens the quick view
            if (isMobileMode()) return;
            e.stopPropagation();
            if (!avatar.src || avatar.src.endsWith('/img/no-portrait.png')) return;
            BrowseView.openAvatarViewer?.(avatar.src);
        });
        on('realmImportBtn', 'click', () => {
            if (realmSelected) importCharacter(realmSelected);
        });
        overlay?.addEventListener('click', (e) => {
            if (e.target === overlay) closePreviewModal();
        });
    }
}

// The preview as the app's overlay stack sees it (the entry registers it through ctx.ui.addOverlay)
export function isPreviewOpen() {
    return !document.getElementById('realmCharModal')?.classList.contains('hidden');
}
export { closePreviewModal };

function doSearch() {
    const val = (document.getElementById('realmSearchInput')?.value || '').trim();
    realmSearch = val;
    document.getElementById('realmClearSearchBtn')?.classList.toggle('hidden', !val);
    realmBrowseView.reload();
}

// ========================================
// BROWSE VIEW CLASS
// ========================================

class RealmBrowseView extends BrowseView {
    constructor(provider) {
        super(provider);
        view = this;
    }

    // the preview's nodes left with the provider: the next injection wires them again
    onModalsRemoved() {
        realmModalEventsAttached = false;
    }

    hitMatchName(hit) {
        return { name: hit.name || '', creator: hit.author || '', text: hit.desc || '' };
    }

    hitLinkKey(hit) {
        return hit?.id ? String(hit.id) : null;
    }

    get previewModalId() { return 'realmCharModal'; }

    getSettingsConfig() {
        return { browseSortOptions: REALM_SORTS.map(s => ({ value: s.value, label: s.label })), followingSortOptions: [], viewModes: [] };
    }

    closePreview() {
        closePreviewModal();
    }

    get mobileFilterIds() {
        return { sort: 'realmSortSelect', filters: 'realmFiltersBtn', nsfw: 'realmNsfwToggle', refresh: 'realmRefreshBtn' };
    }

    // ── Filter Bar ──────────────────────────────────────────

    renderFilterBar() {
        return `
            <div class="browse-sort-container">
                <select id="realmSortSelect" class="glass-select" title="Sort order">
                    ${REALM_SORTS.map(s => `<option value="${s.value}" ${realmSort === s.value ? 'selected' : ''}>${s.label}</option>`).join('')}
                </select>
            </div>

            <div class="browse-more-filters u-relative">
                <button id="realmFiltersBtn" class="glass-btn" title="Additional filters">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="realmFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden">
                    ${renderFeatureFilterItems(REALM_FILTER_SECTIONS, REALM_FEATURE_FILTERS)}
                </div>
            </div>

            <button id="realmNsfwToggle" class="glass-btn nsfw-toggle" title="Toggle NSFW content">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <button id="realmRefreshBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // ── Main View ───────────────────────────────────────────

    renderView() {
        return `
            <div id="realmBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="realmSearchInput" placeholder="Search the RisuAI Realm, or tag:name..." autocomplete="one-time-code">
                        <button id="realmClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="realmSearchBtn" class="browse-search-submit" aria-label="Search">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                </div>

                <div id="realmGrid" class="browse-grid"></div>

                <div class="browse-load-more" id="realmLoadMore" hidden>
                    <button id="realmLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    // ── Modals ──────────────────────────────────────────────

    renderModals() {
        return `
    <div id="realmCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="realmCharAvatar" src="/img/no-portrait.png" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="realmCharName">Character Name</h2>
                        <p class="browse-char-meta">by <span id="realmCharCreator" class="browse-meta-identity">Creator</span></p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="realmOpenInBrowserBtn" href="#" target="_blank" rel="noopener" class="cl-btn cl-btn-secondary" title="Open on the RisuAI Realm">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="realmImportBtn" class="cl-btn cl-btn-primary" title="Import into your library">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="realmCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-download"></i>
                            <span id="realmCharDownloads">0</span> downloads
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="realmCharDate">Unknown</span>
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-scale-balanced"></i>
                            <span id="realmCharLicense"></span>
                        </div>
                    </div>
                    <div class="browse-char-tags" id="realmCharTags"></div>
                </div>

                <div class="browse-char-section" id="realmCharNotesSection" hidden>
                    <h3 class="browse-section-title" data-section="realmCharNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="realmCharLangs"></div>
                    <div id="realmCharNotes" class="scrolling-text"></div>
                </div>

                <p><em class="text-secondary">The definition, greetings and lorebook arrive with the import.</em></p>
            </div>
        </div>
    </div>`;
    }

    // ── Lifecycle ───────────────────────────────────────────

    _getImageGridIds() { return ['realmGrid']; }

    canLoadMore() { return realmHasMore && !realmIsLoading; }

    init() {
        super.init();
        initRealmView();
        const grid = document.getElementById('realmGrid');
        if (grid) this.observeImages(grid);
    }

    getSearchInputId(mode) {
        return mode === 'character' ? 'realmSearchInput' : null;
    }

    applyDefaults(defaults) {
        super.applyDefaults(defaults);
        if (defaults.sort != null && REALM_SORTS.some(s => s.value === defaults.sort)) {
            realmSort = defaults.sort;
            const el = document.getElementById('realmSortSelect');
            if (el) el.value = defaults.sort;
        }
    }

    // ── The single-mode lifecycle ───────────────────────────

    resetSessionState() {
        realmSearch = '';
        realmRows = [];
        realmPage = 0;
        realmHasMore = true;
        realmIsLoading = false;
        realmGridRenderedCount = 0;
        realmSelected = null;
    }

    loadInitial(opts = {}) {
        if (opts.append) {
            realmPage++;
            return loadCharacters(true);
        }
        realmPage = 0;
        return loadCharacters(false);
    }

    hasData() { return realmRows.length > 0; }

    rerenderGrid() {
        realmGridRenderedCount = 0;
        renderGrid(realmRows, false);
    }

    get gridElementId() { return 'realmGrid'; }

    onActivated(isReEntry) {
        if (isReEntry) delegatesInitialized = true;
    }

    // ── Library Lookup (BrowseView contract) ────────────────

    deactivate() {
        delegatesInitialized = false;
        super.deactivate();
    }
}

const realmBrowseView = new RealmBrowseView(null);
export default realmBrowseView;
