// Pygmalion Browse View: search, sort and NSFW grid; the preview fetches the full detail over Connect RPC

import {
    BrowseView, registerCdAdapter, featureFilterState, renderFeatureFilterItems, countActiveFeatures,
    activeFeatureRows, featurePasses, applyTagsClamp, updateTagStateButton, tagStateButtonHtml, cardTagsHtml,
    renderViewToggle, libraryFeatureRows, libraryBadgeHtml, libraryCardClass, renderAltGreetingsList,
    syncSortStandIn, CREATOR_SORT_STANDIN, setFeatureRowsDisabled, setFilterCount, updateNsfwToggleButton,
} from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber, BROWSE_PURIFY_CONFIG, skeletonLines, deferRender, deferCall, isMobileMode, importThroughCommand, renderBrowseError, definitionFailedNotice, httpFailureError } from '../provider-utils.js';
import {
    searchCharacters,
    fetchCharacterDetail,
    fetchCharactersByOwner,
    getAvatarUrl,
    getCharacterPageUrl,
    getGalleryImages,
    getFollowedUsers,
    toggleFollowUser,
    stripHtml,
    PYGMALION_SITE_BASE,
    PROVIDER_SERVICES_BASE,
    checkPluginAvailable,
    getTokenTTL,
} from './pygmalion-api.js';

const {
    onElement: on, showToast, escapeHtml, safePurify, debugLog, getSetting, setSetting,
    formatRichText, debounce,
    apiRequest, cleanupCreatorNotesContainer,
    renderCreatorNotesSecure, renderCardHtmlSecure,
    renderLoadingState,
    renderSkeletonGrid,
} = CoreAPI;

// ========================================
// STATE
// ========================================

let pygCharacters = [];
let pygCurrentSearch = '';
let pygSortMode = 'downloads';
let pygNsfwEnabled = false;
let pygCurrentPage = 0;
let pygTotalItems = 0;
let pygHasMore = true;
let pygIsLoading = false;
let pygLoadToken = 0;
let pygGridRenderedCount = 0;

let pygSelectedChar = null;
let delegatesInitialized = false;

let pygIncludeTags = new Set();
let pygExcludeTags = new Set();
let pygKnownTags = new Set();

// sortAscending is server-side (read as orderDescending); it counts toward the badge only where it applies (pygAscendingOff)
const PYG_FEATURE_FILTERS = [
    { key: 'sortAscending', id: 'pygFilterSortDir', section: 'sort', icon: 'fa-arrow-up-short-wide', label: 'Ascending Order' },
    ...libraryFeatureRows('pyg', () => view, isCharPossibleMatchObj),
];
const pygFeatureState = featureFilterState(PYG_FEATURE_FILTERS);

const PYG_FILTER_SECTIONS = [
    { key: 'sort', title: 'Sort:' },
    { key: 'library', title: 'Library:' },
];

// View mode: 'browse' or 'following'
let pygViewMode = 'browse';
let pygToken = null;
let pygFollowedUsers = [];
let pygFollowingCharacters = [];
let pygFollowingLoading = false;
let pygFollowingSort = 'newest';

// Auth state
let pygPluginAvailable = false;
let pygAutoRefreshTimer = null;
let pygLoginInProgress = false;

const PAGE_SIZE = 48;

// Well-known tags seeded from popular characters
const SEED_TAGS = [
    'Female', 'Male', 'Human', 'Non-Human', 'Anime', 'Original', 'Original Character',
    'Ali:Chat', 'minimALIstic', 'Adventure', 'Horror', 'Yandere', 'Scenario', 'Fun',
    'Magical', 'Monster Girl', 'Monster Boy', 'Furry', 'Robot', 'Elf', 'Demon', 'Deity',
    'Video Game', 'Extrovert', 'Introvert', 'Kuudere', 'Deredere', 'Gimmick', 'Joke',
    'Knight', 'Wizard', 'Meme', 'W++',
];
for (const t of SEED_TAGS) pygKnownTags.add(t);

let view; // module-scoped BrowseView instance reference (set once in constructor)

// ========================================
// LIBRARY LOOKUP
// ========================================

function isCharPossibleMatchObj(h) {
    if (view.isHitInLibrary(h)) return false;
    const owner = h.owner || {};
    return view.isHitPossibleMatch(h);
}

// ========================================
// TAG CLAMPING
// ========================================

// ========================================
// CARD RENDERING
// ========================================

function createPygCard(hit) {
    const name = hit.displayName || 'Unknown';
    const desc = stripHtml(hit.description || '');
    const avatarUrl = hit.avatarUrl ? getAvatarUrl(hit.avatarUrl) : '/img/no-portrait.png';
    const tags = (hit.tags || []);
    const owner = hit.owner || {};
    const creator = owner.username || owner.displayName || '';
    const inLibrary = view.isHitInLibrary(hit);
    const possibleTier = inLibrary ? null : view.possibleMatchTierFor(hit);

    const badges = [];
    const importing = view.importingBadge(hit);
    if (importing) badges.push(importing);
    const libraryBadge = libraryBadgeHtml(inLibrary, possibleTier);
    if (libraryBadge) badges.push(libraryBadge);

    const galleryCount = (hit.altAvatars?.length || 0) + (hit.altImages?.length || 0);
    if (galleryCount > 0) {
        badges.push(`<span class="browse-feature-badge" title="${galleryCount} gallery image${galleryCount > 1 ? 's' : ''}"><i class="fa-solid fa-images"></i></span>`);
    }

    const createdDate = hit.approvedAt
        ? new Date(parseInt(hit.approvedAt, 10) * 1000).toLocaleDateString()
        : '';
    const dateInfo = createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';

    const cardClass = libraryCardClass(inLibrary, possibleTier);

    return `
        <div class="${cardClass}" data-pyg-id="${escapeHtml(hit.id || '')}"${view.linkKeyAttr(hit)}${view.matchAttr(hit)} ${desc ? `title="${escapeHtml(desc)}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/no-portrait.png'">
                ${hit.isSensitive ? '<span class="browse-nsfw-badge">NSFW</span>' : ''}
                ${badges.length > 0 ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                ${creator ? `<span class="browse-card-creator-link" data-author="${escapeHtml(creator)}" data-owner-id="${escapeHtml(owner.id || '')}" title="Click to see all characters by ${escapeHtml(creator)}">${escapeHtml(creator)}</span>` : ''}
                ${cardTagsHtml(tags)}
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Downloads"><i class="fa-solid fa-download"></i> ${formatNumber(hit.downloads || 0)}</span>
                <span class="browse-card-stat" title="Stars"><i class="fa-solid fa-star"></i> ${formatNumber(hit.stars || 0)}</span>
                <span class="browse-card-stat" title="Chats"><i class="fa-solid fa-comments"></i> ${formatNumber(hit.chatCount || 0)}</span>
                ${dateInfo}
            </div>
        </div>
    `;
}

function observeNewCards() {
    const grid = document.getElementById('pygGrid');
    if (!grid) return;
    pygmalionBrowseView.observeImages(grid);
}

// ========================================
// GRID RENDERING
// ========================================

function renderGrid(characters, append = false) {
    const grid = document.getElementById('pygGrid');
    if (!grid) return;

    if (!append) {
        grid.innerHTML = '';
        pygGridRenderedCount = 0;
    }

    const startIdx = pygGridRenderedCount;
    const html = characters.slice(startIdx).map(c => createPygCard(c)).join('');
    grid.insertAdjacentHTML('beforeend', html);
    pygGridRenderedCount = characters.length;

    observeNewCards();
    updateLoadMore();
}

function updateLoadMore() {
    // Pyg allows loading more even when current list is empty (client-side filters may hide all results on a page)
    pygmalionBrowseView.updateLoadMoreVisibility('pygLoadMore', pygHasMore, true);
}

// ========================================
// SEARCH / LOAD
// ========================================

function performPygSearch() {
    const input = document.getElementById('pygSearchInput');
    const term = input?.value.trim() || '';
    // a new search leaves the creator scope; the typed term outranks the one restore puts back
    if (pygAuthorFilter) pygmalionBrowseView.clearCreatorScope({ reload: false });
    pygCurrentSearch = term;
    if (input) input.value = term;
    document.getElementById('pygClearSearchBtn')?.classList.toggle('hidden', !term);
    pygmalionBrowseView.reload();
}

async function loadCharacters(append = false) {
    if (append && pygIsLoading) return;
    const thisToken = ++pygLoadToken;
    pygIsLoading = true;

    const grid = document.getElementById('pygGrid');
    const loadMoreBtn = document.getElementById('pygLoadMoreBtn');

    if (!append && grid) {
        renderSkeletonGrid(grid);
    }

    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        await ensureFreshPygToken();

        let data;

        const mergedExclude = [...pygExcludeTags];
        for (const t of view.persistentExcludeTags()) {
            if (!mergedExclude.includes(t)) mergedExclude.push(t);
        }

        if (pygAuthorOwnerId) {
            // Dedicated owner API for author filter
            data = await fetchCharactersByOwner(pygAuthorOwnerId, pygAuthorSort, pygCurrentPage, pygToken || undefined);
        } else {
            data = await searchCharacters({
                query: pygCurrentSearch,
                orderBy: pygSortMode,
                orderDescending: !pygFeatureState.sortAscending,
                includeSensitive: pygNsfwEnabled,
                token: pygNsfwEnabled ? pygToken : undefined,
                pageSize: PAGE_SIZE,
                page: pygCurrentPage,
                tagsNamesInclude: [...pygIncludeTags],
                tagsNamesExclude: mergedExclude,
            });
        }

        if (thisToken !== pygLoadToken) return;
        if (!delegatesInitialized) return;

        let hits = data?.characters || [];
        await pygmalionBrowseView.probeHits(hits);
        pygTotalItems = parseInt(data?.totalItems || '0', 10);
        const totalPages = Math.ceil(pygTotalItems / PAGE_SIZE);

        const passesClientChecks = pygClientCheck(mergedExclude);
        if (passesClientChecks) {
            hits = hits.filter(passesClientChecks);
            debugLog('[PygBrowse] Client-side filtered hits:', hits.length);
        }

        collectTagsFromResults(hits);

        // Client-side: hide owned / possible match characters
        const activeRows = activeFeatureRows(PYG_FEATURE_FILTERS, pygFeatureState);
        if (activeRows.length > 0) {
            hits = hits.filter(h => featurePasses(h, activeRows));
        }

        // Auto-fetch when client-side filters remove too many results
        const hasClientFilters = activeRows.length > 0 || !!passesClientChecks;
        if (hasClientFilters && pygCurrentPage < totalPages - 1) {
            let autoFetches = 0;
            while (hits.length < PAGE_SIZE && pygCurrentPage < totalPages - 1 && autoFetches < 3 && delegatesInitialized) {
                autoFetches++;
                pygCurrentPage++;
                let moreData;
                if (pygAuthorOwnerId) {
                    moreData = await fetchCharactersByOwner(pygAuthorOwnerId, pygAuthorSort, pygCurrentPage, pygToken || undefined);
                } else {
                    moreData = await searchCharacters({
                        query: pygCurrentSearch,
                        orderBy: pygSortMode,
                        orderDescending: !pygFeatureState.sortAscending,
                        includeSensitive: pygNsfwEnabled,
                        token: pygNsfwEnabled ? pygToken : undefined,
                        pageSize: PAGE_SIZE,
                        page: pygCurrentPage,
                        tagsNamesInclude: [...pygIncludeTags],
                        tagsNamesExclude: mergedExclude,
                    });
                }
                if (thisToken !== pygLoadToken || !delegatesInitialized) return;
                let moreHits = moreData?.characters || [];
                await pygmalionBrowseView.probeHits(moreHits);
                if (passesClientChecks) moreHits = moreHits.filter(passesClientChecks);
                collectTagsFromResults(moreHits);
                if (activeRows.length > 0) {
                    moreHits = moreHits.filter(h => featurePasses(h, activeRows));
                }
                hits = hits.concat(moreHits);
            }
            if (autoFetches > 0) {
                debugLog(`[PygBrowse] Auto-fetched ${autoFetches} extra page(s) to compensate for client-side filters`);
            }
        }

        if (append) {
            pygCharacters = pygCharacters.concat(hits);
        } else {
            pygCharacters = hits;
        }

        pygHasMore = pygCurrentPage < totalPages - 1;

        renderGrid(pygCharacters, append);

        if (!append && pygCharacters.length === 0) {
            const msg = pygHasMore ? 'No valid characters found on this page (API fuzzy match filtered out) - try loading more' : 'No characters found';
            grid.innerHTML = `
                <div class="browse-empty-state">
                    <i class="fa-solid fa-search browse-empty-icon"></i>
                    <p class="u-mt-md">${msg}</p>
                </div>
            `;
        }

        debugLog('[PygBrowse] Loaded', hits.length, 'characters, page', pygCurrentPage, '/', totalPages, 'total:', pygTotalItems);

    } catch (err) {
        if (thisToken !== pygLoadToken) return;
        if (err.authFailed && pygNsfwEnabled) {
            console.warn('[PygBrowse] Auth failed during NSFW search, attempting re-login:', err.message);
            // Try auto-login before falling back to SFW
            const recovered = await attemptTokenRecovery();
            if (recovered) {
                debugLog('[PygBrowse] Token recovered, retrying with NSFW');
                setTimeout(() => loadCharacters(false), 0);
            } else {
                pygNsfwEnabled = false;
                updateNsfwToggle();
                showToast('Pygmalion token expired, please re-authenticate.', 'warning', 5000);
                openPygTokenModal();
                setTimeout(() => loadCharacters(false), 0);
            }
        } else {
            console.error('[PygBrowse] Search error:', err);
            showToast(`Pygmalion search failed: ${err.message}`, 'error');
            if (!append && grid) {
                renderBrowseError(grid, {
                    provider: 'pygmalion',
                    error: err,
                    message: `Search failed: ${err.message}`,
                    flags: { token: !!pygToken, nsfw: pygNsfwEnabled },
                    retry: () => loadCharacters(false),
                });
            }
        }
    } finally {
        if (thisToken === pygLoadToken) {
            pygIsLoading = false;
            if (loadMoreBtn) {
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
            }
        }
    }
}

// ========================================
// TAGS FILTER
// ========================================

function collectTagsFromResults(characters) {
    for (const char of characters) {
        if (!Array.isArray(char.tags)) continue;
        for (const tag of char.tags) {
            if (tag) pygKnownTags.add(tag);
        }
    }
}

function getSortedTagList() {
    return [...pygKnownTags].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function renderPygTagsList(filter = '') {
    const container = document.getElementById('pygTagsList');
    if (!container) return;

    const allTags = getSortedTagList();
    const filtered = filter
        ? allTags.filter(t => t.toLowerCase().includes(filter.toLowerCase()))
        : allTags;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    container.innerHTML = filtered.map(tagName => {
        const state = pygIncludeTags.has(tagName) ? 'include' : pygExcludeTags.has(tagName) ? 'exclude' : 'neutral';
        return `
            <div class="browse-tag-filter-item" data-tag-name="${escapeHtml(tagName)}">
                ${tagStateButtonHtml(state)}
                <span class="tag-label">${escapeHtml(tagName)}</span>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const tagName = item.dataset.tagName;
        const stateBtn = item.querySelector('.browse-tag-state-btn');

        item.addEventListener('click', () => {
            if (pygIncludeTags.has(tagName)) {
                pygIncludeTags.delete(tagName);
                pygExcludeTags.add(tagName);
            } else if (pygExcludeTags.has(tagName)) {
                pygExcludeTags.delete(tagName);
            } else {
                pygIncludeTags.add(tagName);
            }
            cyclePygTagState(stateBtn, tagName);
            updatePygTagsButton();
            if (pygViewMode === 'following') {
                renderPygFollowing();
            } else {
                pygmalionBrowseView.reload();
            }
        });
    });
}

function cyclePygTagState(btn, tagName) {
    updateTagStateButton(btn,
        pygIncludeTags.has(tagName) ? 'include' : pygExcludeTags.has(tagName) ? 'exclude' : 'neutral');
}

function updatePygTagsButton() {
    const btn = document.getElementById('pygTagsBtn');
    if (!btn) return;

    const count = pygIncludeTags.size + pygExcludeTags.size;
    setFilterCount(btn, 'Tags', count);
}

function updatePygFiltersButton() {
    const btn = document.getElementById('pygFiltersBtn');
    if (!btn) return;
    // Ascending Order does nothing where it greys (pygAscendingOff), so it leaves the count there
    const count = countActiveFeatures(PYG_FEATURE_FILTERS, pygFeatureState, { inertKeys: pygAscendingOff() ? ['sortAscending'] : [] });
    setFilterCount(btn, 'Features', count);
}

// ========================================
// PREVIEW MODAL
// ========================================

let pygDetailFetchToken = 0;

function openPreviewModal(hit) {
    pygSelectedChar = hit;

    const modal = document.getElementById('pygCharModal');
    if (!modal) return;
    CoreAPI.resetBrowseSectionCollapseState(modal);

    const name = hit.displayName || hit.personality?.name || 'Unknown';
    const owner = hit.owner || {};
    const creator = owner.username || owner.displayName || 'Unknown';
    const avatarUrl = hit.avatarUrl ? getAvatarUrl(hit.avatarUrl) : '/img/no-portrait.png';
    const pygUrl = getCharacterPageUrl(hit.id);
    try {
        const tagline = stripHtml(hit.description || '');
        const tags = hit.tags || [];
        const downloads = formatNumber(hit.downloads || 0);
        const stars = formatNumber(hit.stars || 0);
        const views = formatNumber(hit.views || 0);
        const chats = formatNumber(hit.chatCount || 0);

        const createdDate = hit.approvedAt
            ? new Date(parseInt(hit.approvedAt, 10) * 1000).toLocaleDateString()
            : '';

        // Header
        const avatarImg = document.getElementById('pygCharAvatar');
        if (avatarImg) {
            BrowseView.setPreviewPortrait(avatarImg, avatarUrl);
        }
        const nameEl = document.getElementById('pygCharName');
        if (nameEl) nameEl.textContent = name;
        const creatorEl = document.getElementById('pygCharCreator');
        if (creatorEl) {
            creatorEl.textContent = creator;
            creatorEl.href = '#';
            creatorEl.title = `Click to see all characters by ${creator}`;
            creatorEl.dataset.ownerId = owner.id || '';
        }
        // External profile link
        const creatorExternal = document.getElementById('pygCreatorExternal');
        if (creatorExternal) {
            creatorExternal.href = creator ? `${PYGMALION_SITE_BASE}/user/${encodeURIComponent(creator)}` : '#';
        }
        const openBtn = document.getElementById('pygOpenInBrowserBtn');
        if (openBtn) openBtn.href = pygUrl;

        // Tagline
        const taglineSection = document.getElementById('pygCharTaglineSection');
        const taglineEl = document.getElementById('pygCharTagline');
        if (taglineSection) {
            if (tagline) {
                taglineSection.hidden = false;
                if (taglineEl) taglineEl.textContent = tagline;
            } else {
                taglineSection.hidden = true;
            }
        }

        // Stats
        const downloadsEl = document.getElementById('pygCharDownloads');
        if (downloadsEl) downloadsEl.textContent = downloads;
        const starsEl = document.getElementById('pygCharStars');
        if (starsEl) starsEl.textContent = stars;
        const viewsEl = document.getElementById('pygCharViews');
        if (viewsEl) viewsEl.textContent = views;
        const chatsEl = document.getElementById('pygCharChats');
        if (chatsEl) chatsEl.textContent = chats;
        const dateEl = document.getElementById('pygCharDate');
        if (dateEl) dateEl.textContent = createdDate || 'Unknown';

        // Source
        const sourceEl = document.getElementById('pygCharSource');
        const sourceSection = document.getElementById('pygCharSourceStat');
        if (sourceSection) {
            if (hit.source) {
                sourceSection.hidden = false;
                if (sourceEl) sourceEl.textContent = hit.source;
            } else {
                sourceSection.hidden = true;
            }
        }

        // Gallery count
        const galleryImages = getGalleryImages(hit);
        const galleryStat = document.getElementById('pygCharGalleryStat');
        const galleryCountEl = document.getElementById('pygCharGalleryCount');
        if (galleryStat) {
            if (galleryImages.length > 0) {
                galleryStat.hidden = false;
                if (galleryCountEl) galleryCountEl.textContent = String(galleryImages.length);
            } else {
                galleryStat.hidden = true;
            }
        }
        renderPygGalleryGrid(galleryImages);

        const altGreetings = Array.isArray(hit.personality?.alternateGreetings) ? hit.personality.alternateGreetings.filter(Boolean) : [];

        // Tags
        const tagsEl = document.getElementById('pygCharTags');
        if (tagsEl) {
            tagsEl.innerHTML = tags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
            requestAnimationFrame(() => applyTagsClamp(tagsEl));
        }

        const p = hit.personality || {};
        populateDefinitionSections(name, p, altGreetings);

        // Import button state, kept in step with the library while the preview is open
        const restampImport = () => view.stampPreviewImport(document.getElementById('pygImportBtn'), hit);
        restampImport();
        view.trackPreview(restampImport, hit);
    } catch (err) {
        console.error('[PygBrowse] Error populating preview modal:', err);
    }

    // Skeletons only when we know the network wait is coming (no inline personality).
    if (!hit.personality) {
        const _descSection = document.getElementById('pygCharDescriptionSection');
        const _descEl = document.getElementById('pygCharDescription');
        const _firstMsgSection = document.getElementById('pygCharFirstMsgSection');
        const _firstMsgEl = document.getElementById('pygCharFirstMsg');
        const _examplesSection = document.getElementById('pygCharExamplesSection');
        const _examplesEl = document.getElementById('pygCharExamples');
        if (_descSection && _descEl) { _descSection.hidden = false; _descEl.innerHTML = skeletonLines(3); }
        if (_firstMsgSection && _firstMsgEl) { _firstMsgSection.hidden = false; _firstMsgEl.innerHTML = skeletonLines(4); }
        if (_examplesSection && _examplesEl) { _examplesSection.hidden = false; _examplesEl.innerHTML = skeletonLines(3); }
    }

    modal.classList.remove('hidden');
    const charBody = modal.querySelector('.browse-char-body');
    if (charBody) charBody.scrollTop = 0;

    // Search results don't include personality - always fetch full detail
    if (!hit.personality) {
        const fetchToken = ++pygDetailFetchToken;
        fetchAndPopulateDetails(hit, fetchToken);
    }
}

function renderPygGalleryGrid(galleryImages) {
    const section = document.getElementById('pygCharGallerySection');
    const grid = document.getElementById('pygCharGalleryGrid');
    const label = document.getElementById('pygCharGalleryLabel');
    if (!section || !grid) return;
    if (galleryImages.length > 0) {
        section.hidden = false;
        if (label) label.textContent = `(${galleryImages.length})`;
        grid.innerHTML = galleryImages.map(img =>
            `<div class="browse-gallery-cell"><img class="browse-gallery-thumb" src="${escapeHtml(img.url)}" alt="Gallery image" title="Gallery image" loading="lazy" onload="this.parentElement.classList.add('loaded')" onerror="this.parentElement.classList.add('load-failed')"></div>`
        ).join('');
    } else {
        section.hidden = true;
        grid.innerHTML = '';
    }
}

function populateDefinitionSections(name, p, altGreetings) {
    // RAF defer so safePurify doesnt block the modal-open paint frame.
    requestAnimationFrame(() => {
        // Creator's Notes - hide the section when empty, like every other section here.
        const creatorNotesSection = document.getElementById('pygCharCreatorNotesSection');
        const creatorNotesEl = document.getElementById('pygCharCreatorNotes');
        if (creatorNotesEl) {
            if (p.characterNotes && p.characterNotes.trim()) {
                if (creatorNotesSection) creatorNotesSection.hidden = false;
                if (!creatorNotesEl.querySelector('iframe')) creatorNotesEl.innerHTML = skeletonLines(3);
                deferCall(creatorNotesEl, () => renderCreatorNotesSecure(p.characterNotes, name, creatorNotesEl));
            } else {
                if (creatorNotesSection) creatorNotesSection.hidden = true;
                cleanupCreatorNotesContainer(creatorNotesEl);
                creatorNotesEl.innerHTML = '';
            }
        }

        // Description (persona)
        const descSection = document.getElementById('pygCharDescriptionSection');
        const descEl = document.getElementById('pygCharDescription');
        if (descSection) {
            if (p.persona) {
                descSection.hidden = false;
                if (descEl) deferCall(descEl, () => renderCardHtmlSecure(p.persona, name, descEl));
            } else {
                descSection.hidden = true;
            }
        }

        // First Message
        const firstMsgSection = document.getElementById('pygCharFirstMsgSection');
        const firstMsgEl = document.getElementById('pygCharFirstMsg');
        if (firstMsgSection) {
            if (p.greeting) {
                firstMsgSection.hidden = false;
                if (firstMsgEl) deferRender(firstMsgEl, () => safePurify(formatRichText(p.greeting, name, true), BROWSE_PURIFY_CONFIG));
            } else {
                firstMsgSection.hidden = true;
            }
        }
    });

    renderAltGreetingsList('pyg', altGreetings, name);

    // Second RAF: alt-greetings above is cheap sync, but mes_example is another safePurify heavy field.
    requestAnimationFrame(() => {
        const examplesSection = document.getElementById('pygCharExamplesSection');
        const examplesEl = document.getElementById('pygCharExamples');
        if (examplesSection) {
            if (p.mesExample) {
                examplesSection.hidden = false;
                if (examplesEl) deferRender(examplesEl, () => safePurify(formatRichText(p.mesExample, name, true), BROWSE_PURIFY_CONFIG));
            } else {
                examplesSection.hidden = true;
            }
        }
    });
}

async function fetchAndPopulateDetails(hit, stalenessToken) {
    if (!hit.id) return;

    try {
        await ensureFreshPygToken();
        const data = await fetchCharacterDetail(hit.id, undefined, pygToken || undefined);
        if (stalenessToken !== pygDetailFetchToken) return;
        if (!data?.character) return;

        const char = data.character;
        const name = char.personality?.name || char.displayName || 'Unknown';

        // Store full data on selected char for import
        if (pygSelectedChar?.id === hit.id) {
            pygSelectedChar._fullDetail = char;
        }

        const p = char.personality || {};
        const altGreetings = Array.isArray(p.alternateGreetings) ? p.alternateGreetings.filter(Boolean) : [];
        populateDefinitionSections(name, p, altGreetings);

        const galleryImages = getGalleryImages(char);
        const galleryStat = document.getElementById('pygCharGalleryStat');
        const galleryCountEl = document.getElementById('pygCharGalleryCount');
        if (galleryStat && galleryImages.length > 0) {
            galleryStat.hidden = false;
            if (galleryCountEl) galleryCountEl.textContent = String(galleryImages.length);
        }
        renderPygGalleryGrid(galleryImages);

        const sourceEl = document.getElementById('pygCharSource');
        const sourceStat = document.getElementById('pygCharSourceStat');
        if (sourceStat && char.source) {
            sourceStat.hidden = false;
            if (sourceEl) sourceEl.textContent = char.source;
        }

    } catch (err) {
        debugLog('[PygBrowse] Detail fetch error:', err);
        if (stalenessToken === pygDetailFetchToken) {
            const descEl = document.getElementById('pygCharDescription');
            if (descEl) descEl.innerHTML = definitionFailedNotice('It can still be imported with basic info.');
        }
    }
}

function cleanupPygCharModal() {
    BrowseView.closeAvatarViewer();
    CoreAPI.setBrowseAltGreetings(null);
    const sectionIds = [
        'pygCharDescription',
        'pygCharFirstMsg',
        'pygCharAltGreetings',
        'pygCharExamples',
        'pygCharTags',
        'pygCharGalleryGrid',
    ];
    for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }
    const notesEl = document.getElementById('pygCharCreatorNotes');
    if (notesEl) cleanupCreatorNotesContainer(notesEl);
}

function closePreviewModal() {
    pygDetailFetchToken++;
    cleanupPygCharModal();
    const modal = document.getElementById('pygCharModal');
    if (modal) modal.classList.add('hidden');
    pygSelectedChar = null;
    view.trackPreview(null);
}

// ========================================
// IMPORT
// ========================================

async function importCharacter(charData) {
    if (!charData?.id) return;
    const charName = charData.personality?.name || charData.displayName || '';
    const charCreator = charData.owner?.username || charData.owner?.displayName || '';
    await view.importFromPreview({
        button: document.getElementById('pygImportBtn'), hit: charData, provider: 'pygmalion', id: charData.id, label: 'PygBrowse',
        closePreview: closePreviewModal,
        // the detail the preview fetched when it has it, read after the dialog: it may land meanwhile
        ready: () => ({ data: charData._fullDetail || charData }),
        prepare: async () => {
            // a search hit carries no definition: the character, read now when the preview has not loaded it
            if (!charData._fullDetail) {
                try {
                    await ensureFreshPygToken();
                    const char = (await fetchCharacterDetail(charData.id, undefined, pygToken || undefined))?.character;
                    if (char) charData._fullDetail = char;
                } catch { /* the check runs on what the hit has */ }
            }
            const p = (charData._fullDetail || charData).personality || {};
            return {
                probe: { name: charName, creator: charCreator, fullPath: charData.id, description: p.persona || '', first_mes: p.greeting || '', creator_notes: p.characterNotes || '' },
                dialog: { name: charName, creator: charCreator, fullPath: charData.id, avatarUrl: charData.avatarUrl ? getAvatarUrl(charData.avatarUrl) : '' },
            };
        },
    });
}

// ========================================
// AUTHOR FILTER
// ========================================

let pygAuthorFilter = null;
let pygAuthorOwnerId = null;
let pygAuthorSort = 'approved_at';

// enter the creator scope; the base shows the banner, runs the chrome and loads (later reloads land there too)
function filterByAuthor(authorName, ownerId) {
    // the owner endpoint IS the scope; without an id the banner would front the generic listing
    if (!ownerId) {
        showToast('Cannot determine author ID', 'warning');
        return;
    }
    closePreviewModal();
    pygmalionBrowseView.enterCreatorScope(() => {
        pygAuthorFilter = authorName;
        pygAuthorOwnerId = ownerId;
        view._cdRef = { ownerId, name: authorName };
        pygCurrentSearch = '';
        const input = document.getElementById('pygSearchInput');
        if (input) input.value = '';
        document.getElementById('pygClearSearchBtn')?.classList.add('hidden');
        const bannerName = document.getElementById('pygAuthorBannerName');
        if (bannerName) bannerName.textContent = authorName;
        window.pushOverlayGuard?.();
        // Reset author sort to newest
        pygAuthorSort = 'approved_at';
        const authorSortEl = document.getElementById('pygAuthorSortSelect');
        if (authorSortEl) authorSortEl.value = 'approved_at';
        updatePygFollowButton(ownerId);
    });
}

function clearAuthorFilter() {
    pygmalionBrowseView.clearCreatorScope();
}

function updateNsfwToggle() {
    updateNsfwToggleButton('pygNsfwToggle', pygNsfwEnabled, {
        onTitle: 'NSFW content enabled (requires auth token) - click to show SFW only',
        offTitle: 'Showing SFW only - click to include NSFW (requires auth token)',
    });
    const btn = document.getElementById('pygNsfwToggle');
    if (btn) btn.style.opacity = pygToken ? '' : '0.5';
}

// ========================================
// VIEW MODE SWITCHING
// ========================================

function setPygModeChrome(mode) {
    const browseSortEl = document.getElementById('pygSortSelect');
    const followingSortEl = document.getElementById('pygFollowingSortSelect');
    const bsTarget = browseSortEl?._customSelect?.container || browseSortEl;
    const fsTarget = followingSortEl?._customSelect?.container || followingSortEl;
    // the owner endpoint ignores the main sort, so the scope hides it too
    const scoped = mode === 'browse' && !!pygAuthorFilter;
    if (bsTarget) bsTarget.classList.toggle('hidden', mode !== 'browse' || scoped);
    if (fsTarget) fsTarget.classList.toggle('hidden', mode === 'browse');
    syncSortStandIn(browseSortEl, scoped ? CREATOR_SORT_STANDIN : null, [CREATOR_SORT_STANDIN]);
    // neither the following feed nor the owner endpoint takes a direction, so Ascending Order greys there, saying why
    setFeatureRowsDisabled(PYG_FEATURE_FILTERS.filter(f => f.key === 'sortAscending'), pygAscendingOff(),
        mode !== 'browse' ? 'Not available in Following' : 'Not available while viewing a creator');
    updatePygFiltersButton();
}

// strict tag match: the API matches substrings ("Male" hits "Female"); the owner endpoint takes no tags and returns sensitive cards, so SFW filters here
function pygClientCheck(mergedExclude) {
    const ownerExclude = pygAuthorOwnerId ? mergedExclude.map(t => t.toLowerCase()) : [];
    const ownerSfw = !!pygAuthorOwnerId && !pygNsfwEnabled;
    if (!(pygIncludeTags.size > 0 || ownerExclude.length > 0 || ownerSfw)) return null;
    return (h) => {
        if (ownerSfw && h.isSensitive) return false;
        const charTags = Array.isArray(h.tags) ? h.tags.map(t => String(t).toLowerCase()) : [];
        if (ownerExclude.some(t => charTags.includes(t))) return false;
        if (pygIncludeTags.size === 0) return true;
        return [...pygIncludeTags].every(rt => charTags.includes(rt.toLowerCase()));
    };
}

// whether Ascending Order can do anything in what the grid shows now
function pygAscendingOff() {
    return pygViewMode !== 'browse' || !!pygAuthorFilter;
}

function switchPygViewMode(mode) {
    return pygmalionBrowseView.switchViewMode(mode);
}

// ========================================
// FOLLOWING TIMELINE
// ========================================

async function loadPygFollowingTimeline(forceRefresh = false) {
    await ensureFreshPygToken();
    if (!pygToken) {
        renderPygFollowingEmpty('login');
        return;
    }

    if (pygFollowingLoading) return;
    pygFollowingLoading = true;

    const grid = document.getElementById('pygFollowingGrid');

    if (forceRefresh) {
        pygFollowingCharacters = [];
        pygFollowedUsers = [];
    }

    if (grid) {
        renderSkeletonGrid(grid);
    }

    let shouldRetry = false;
    try {
        if (pygFollowedUsers.length === 0) {
            let page = 0;
            let hasMore = true;
            const allUsers = [];

            while (hasMore) {
                const resp = await getFollowedUsers(pygToken, { pageNumber: page, pageSize: 50 });
                const users = resp.users || [];
                allUsers.push(...users);
                hasMore = users.length >= 50;
                page++;
                if (page > 20) break; // safety cap
            }

            pygFollowedUsers = allUsers;
            debugLog('[PygFollowing] Following', allUsers.length, 'users');
        }

        if (pygFollowedUsers.length === 0) {
            renderPygFollowingEmpty('no_follows');
            pygFollowingLoading = false;
            return;
        }

        const existingIds = new Set(pygFollowingCharacters.map(c => c.id));
        const BATCH_SIZE = 5;

        for (let i = 0; i < pygFollowedUsers.length; i += BATCH_SIZE) {
            const batch = pygFollowedUsers.slice(i, i + BATCH_SIZE);
            const promises = batch.map(async (user) => {
                try {
                    const userId = user.id || user.userId;
                    if (!userId) return [];
                    const data = await fetchCharactersByOwner(userId, 'approved_at', 0, pygToken || undefined);
                    return (data?.characters || []).map(c => ({
                        ...c,
                        _followedAuthor: user.username || user.displayName || '',
                        _followedAuthorId: userId,
                    }));
                } catch (e) {
                    debugLog('[PygFollowing] Error fetching from user:', e.message);
                    return [];
                }
            });

            const results = await Promise.all(promises);
            for (const chars of results) {
                for (const c of chars) {
                    if (!existingIds.has(c.id)) {
                        existingIds.add(c.id);
                        pygFollowingCharacters.push(c);
                    }
                }
            }
        }

        debugLog('[PygFollowing] Total characters from followed authors:', pygFollowingCharacters.length);

        if (pygFollowingCharacters.length === 0) {
            renderPygFollowingEmpty('empty');
            pygFollowingLoading = false;
            return;
        }

        await pygmalionBrowseView.probeHits(pygFollowingCharacters);
        renderPygFollowing();

    } catch (err) {
        console.error('[PygFollowing] Error loading timeline:', err);

        if (err.authFailed) {
            const recovered = await attemptTokenRecovery();
            if (recovered) {
                debugLog('[PygFollowing] Token recovered, retrying');
                shouldRetry = true;
            } else {
                showToast('Pygmalion token expired. Please re-authenticate.', 'warning', 5000);
                openPygTokenModal();
                renderPygFollowingEmpty('login');
            }
        } else {
            if (grid) {
                renderBrowseError(grid, {
                    provider: 'pygmalion',
                    error: err,
                    title: 'Error loading timeline',
                    view: 'timeline',
                    flags: { token: !!pygToken, nsfw: pygNsfwEnabled },
                    retry: () => loadPygFollowingTimeline(true),
                });
            }
        }
    } finally {
        pygFollowingLoading = false;
        pygmalionBrowseView.updateLoadMoreVisibility('pygFollowingLoadMore', false, true);
    }

    if (shouldRetry) {
        loadPygFollowingTimeline(true);
    }
}

function renderPygFollowingEmpty(reason) {
    const grid = document.getElementById('pygFollowingGrid');
    if (!grid) return;

    if (reason === 'login') {
        grid.innerHTML = `
            <div class="browse-timeline-empty">
                <i class="fa-solid fa-key"></i>
                <h3>Token Required</h3>
                <p>Add your Pygmalion session token to see new characters from authors you follow.</p>
                <button class="cl-btn cl-btn-primary" id="pygFollowingLoginBtn">
                    <i class="fa-solid fa-key"></i> Add Token
                </button>
            </div>
        `;
        document.getElementById('pygFollowingLoginBtn')?.addEventListener('click', () => openPygTokenModal());
    } else if (reason === 'no_follows') {
        grid.innerHTML = `
            <div class="browse-timeline-empty">
                <i class="fa-solid fa-user-plus"></i>
                <h3>No Followed Authors</h3>
                <p>Follow some character creators to see their new characters here.</p>
                <a href="https://pygmalion.chat" target="_blank" class="cl-btn cl-btn-primary">
                    <i class="fa-solid fa-external-link"></i> Find Authors on Pygmalion
                </a>
            </div>
        `;
    } else {
        grid.innerHTML = `
            <div class="browse-timeline-empty">
                <i class="fa-solid fa-inbox"></i>
                <h3>No Characters Yet</h3>
                <p>Authors you follow haven't posted characters yet.</p>
            </div>
        `;
    }
}

function sortPygFollowingCharacters(characters) {
    const sorted = [...characters];
    switch (pygFollowingSort) {
        case 'newest':
            return sorted.sort((a, b) => (parseInt(b.approvedAt || '0', 10)) - (parseInt(a.approvedAt || '0', 10)));
        case 'oldest':
            return sorted.sort((a, b) => (parseInt(a.approvedAt || '0', 10)) - (parseInt(b.approvedAt || '0', 10)));
        case 'name_asc':
            return sorted.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
        case 'name_desc':
            return sorted.sort((a, b) => (b.displayName || '').localeCompare(a.displayName || ''));
        case 'downloads':
            return sorted.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
        case 'stars':
            return sorted.sort((a, b) => (b.stars || 0) - (a.stars || 0));
        default:
            return sorted;
    }
}

function _handleFollowingCardClick(e) {
    const creatorLink = e.target.closest('.browse-card-creator-link');
    if (creatorLink) {
        e.stopPropagation();
        const author = creatorLink.dataset.author;
        const ownerId = creatorLink.dataset.ownerId;
        if (author) filterByAuthor(author, ownerId);
        return;
    }
    const card = e.target.closest('.browse-card');
    if (card) {
        const charId = card.dataset.pygId;
        const hit = pygFollowingCharacters.find(c => c.id === charId);
        if (hit) openPreviewModal(hit);
    }
}

function renderPygFollowing() {
    const grid = document.getElementById('pygFollowingGrid');
    if (!grid) return;

    // Client-side tag + hide-owned filtering
    const includeTags = [...pygIncludeTags];
    const excludeTags = [...pygExcludeTags];
    for (const t of view.persistentExcludeTags()) {
        if (!excludeTags.includes(t)) excludeTags.push(t);
    }
    const activeRows = activeFeatureRows(PYG_FEATURE_FILTERS, pygFeatureState);
    const anyFilterActive = activeRows.length > 0 || includeTags.length > 0 || excludeTags.length > 0;

    let filtered;
    if (anyFilterActive) {
        filtered = pygFollowingCharacters.filter(c => {
            if (!featurePasses(c, activeRows)) return false;
            if (includeTags.length > 0 || excludeTags.length > 0) {
                const charTags = (c.tags || []).map(t => t.toLowerCase());
                if (includeTags.length > 0 && !includeTags.every(t => charTags.includes(t.toLowerCase()))) return false;
                if (excludeTags.length > 0 && excludeTags.some(t => charTags.includes(t.toLowerCase()))) return false;
            }
            return true;
        });
    } else {
        filtered = pygFollowingCharacters.slice();
    }

    let sorted = sortPygFollowingCharacters(filtered);

    // NSFW filter
    if (!pygNsfwEnabled) {
        sorted = sorted.filter(c => !c.isSensitive);
    }

    if (sorted.length === 0 && pygFollowingCharacters.length > 0) {
        grid.innerHTML = `
            <div class="browse-timeline-empty">
                <i class="fa-solid fa-filter"></i>
                <h3>No Matching Characters</h3>
                <p>No characters match your current filters. Try adjusting them.</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = sorted.map(c => createPygCard(c)).join('');
    observeNewFollowingCards();
}

function observeNewFollowingCards() {
    const grid = document.getElementById('pygFollowingGrid');
    if (!grid) return;
    pygmalionBrowseView.observeImages(grid);
}

// ========================================
// TOKEN MANAGEMENT
// ========================================

function loadPygToken() {
    pygToken = getSetting('pygmalionToken') || null;

    if (!pygToken && pygNsfwEnabled) {
        pygNsfwEnabled = false;
    }
    updateNsfwToggle();
    updateLoginUI();
}

function savePygToken(token) {
    pygToken = token || null;
    setSetting('pygmalionToken', pygToken);
    updateLoginUI();
}

async function openPygTokenModal() {
    loadPygToken();

    pygPluginAvailable = await checkPluginAvailable(apiRequest);
    updateLoginUI();

    const emailInput = document.getElementById('pygLoginEmail');
    if (emailInput && getSetting('pygmalionRememberCredentials')) {
        emailInput.value = getSetting('pygmalionEmail') || '';
    }

    const modal = document.getElementById('pygLoginModal');
    if (modal) {
        modal.classList.remove('hidden');
        window.pushOverlayGuard?.();
    }
}

function closePygTokenModal() {
    const modal = document.getElementById('pygLoginModal');
    if (modal) modal.classList.add('hidden');
}

function updateLoginUI() {
    // Plugin status
    const pluginOk = document.getElementById('pygPluginStatusOk');
    const pluginMissing = document.getElementById('pygPluginStatusMissing');
    const loginForm = document.getElementById('pygLoginForm');
    const loginBtn = document.getElementById('pygLoginBtn');

    if (pluginOk) pluginOk.hidden = !pygPluginAvailable;
    if (pluginMissing) pluginMissing.hidden = pygPluginAvailable;
    if (loginForm) loginForm.classList.toggle('pyg-login-disabled', !pygPluginAvailable);
    if (loginBtn) loginBtn.disabled = !pygPluginAvailable || pygLoginInProgress;

    // Auto-expand manual token section when plugin unavailable
    const manualSection = document.querySelector('.pyg-manual-token-section');
    if (manualSection && !pygPluginAvailable) manualSection.open = true;

    // Login button state
    if (loginBtn) {
        loginBtn.innerHTML = pygLoginInProgress
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Logging in...'
            : '<i class="fa-solid fa-sign-in-alt"></i> Log In';
    }

    // Token status area
    const statusArea = document.getElementById('pygTokenStatus');
    if (statusArea) {
        if (pygToken) {
            const ttl = getTokenTTL(pygToken);
            let ttlText;
            if (ttl === Infinity) {
                ttlText = 'no expiry';
            } else if (ttl <= 0) {
                ttlText = '<span class="text-error-bright">expired</span>';
            } else {
                const min = Math.floor(ttl / 60);
                ttlText = min > 0 ? `${min}m remaining` : `${ttl}s remaining`;
            }
            statusArea.innerHTML = `
                <i class="fa-solid fa-check-circle text-success-bright"></i>
                <strong>Authenticated</strong> - token ${ttlText}
            `;
            statusArea.hidden = false;
        } else {
            statusArea.hidden = true;
        }
    }

}

// ========================================
// LOGIN / AUTO-REFRESH
// ========================================

async function loginWithCredentials(email, password) {
    if (pygLoginInProgress) return;
    pygLoginInProgress = true;
    updateLoginUI();

    try {
        const resp = await apiRequest(`${PROVIDER_SERVICES_BASE}/pyg-login`, 'POST', {
            username: email,
            password: password,
        });

        if (resp.status === 201) {
            const data = await resp.json();
            const token = data?.result?.id_token;
            if (!token) throw new Error('Login succeeded but no token in response');

            savePygToken(token);

            // Always remember credentials when logging in via this modal
            setSetting('pygmalionEmail', email);
            setSetting('pygmalionPassword', password);
            setSetting('pygmalionRememberCredentials', true);

            scheduleTokenRefresh(token, email, password);

            pygNsfwEnabled = getSetting('pygmalionNsfw') === true;
            updateNsfwToggle();

            showToast('Logged in to Pygmalion', 'success');
            closePygTokenModal();

            pygFollowedUserIds = null;
            pygFollowedUsers = [];
            pygFollowingCharacters = [];
        } else if (resp.status === 422) {
            showToast('Invalid email or password', 'error');
        } else if (resp.status === 502) {
            showToast('Pygmalion auth server unreachable', 'error');
        } else {
            showToast(`Login failed: ${httpFailureError(resp.status, await resp.text().catch(() => '')).message}`, 'error');
        }
    } catch (err) {
        console.error('[PygAuth] Login error:', err);
        showToast(`Login error: ${err.message}`, 'error');
    } finally {
        pygLoginInProgress = false;
        updateLoginUI();
    }
}

function scheduleTokenRefresh(token, email, password) {
    clearTokenRefresh();

    const ttl = getTokenTTL(token);
    if (ttl === Infinity || ttl <= 0) return;

    // Re-login at 80% of lifetime (~48 min for 1h tokens)
    const refreshIn = Math.max(60, Math.floor(ttl * 0.8)) * 1000;
    debugLog('[PygAuth] Token refresh scheduled in', Math.floor(refreshIn / 1000), 'seconds');

    pygAutoRefreshTimer = setTimeout(async () => {
        debugLog('[PygAuth] Auto-refreshing token...');
        try {
            const resp = await apiRequest(`${PROVIDER_SERVICES_BASE}/pyg-login`, 'POST', {
                username: email,
                password: password,
            });

            if (resp.status === 201) {
                const data = await resp.json();
                const newToken = data?.result?.id_token;
                if (newToken) {
                    savePygToken(newToken);
                    scheduleTokenRefresh(newToken, email, password);
                    debugLog('[PygAuth] Token refreshed successfully');
                }
            } else {
                console.warn('[PygAuth] Token refresh failed:', resp.status);
            }
        } catch (e) {
            console.warn('[PygAuth] Token refresh error:', e);
        }
    }, refreshIn);
}

function clearTokenRefresh() {
    if (pygAutoRefreshTimer) {
        clearTimeout(pygAutoRefreshTimer);
        pygAutoRefreshTimer = null;
    }
}

/**
 * Reactive recovery after an auth failure: always re-login with the stored credentials, whatever the token's state.
 * @returns {Promise<boolean>} true if a new valid token was obtained
 */
async function attemptTokenRecovery() {
    if (!getSetting('pygmalionRememberCredentials')) return false;

    const email = getSetting('pygmalionEmail');
    const password = getSetting('pygmalionPassword');
    if (!email || !password) return false;

    if (!pygPluginAvailable) {
        pygPluginAvailable = await checkPluginAvailable(apiRequest);
        if (!pygPluginAvailable) return false;
    }

    debugLog('[PygAuth] Attempting token recovery...');

    try {
        const resp = await apiRequest(`${PROVIDER_SERVICES_BASE}/pyg-login`, 'POST', {
            username: email,
            password: password,
        });

        if (resp.status === 201) {
            const data = await resp.json();
            const token = data?.result?.id_token;
            if (token) {
                savePygToken(token);
                scheduleTokenRefresh(token, email, password);
                debugLog('[PygAuth] Token recovery successful');
                return true;
            }
        }
    } catch (e) {
        debugLog('[PygAuth] Token recovery failed:', e.message);
    }
    return false;
}

// tokens live 60 minutes and a stale one gets a 500, not 401: refresh before sending, or stop sending a dead one
async function ensureFreshPygToken() {
    if (!pygToken || getTokenTTL(pygToken) > 60) return;
    await tryAutoLogin();
    if (pygToken && getTokenTTL(pygToken) > 60) return;
    pygToken = null;
    if (pygNsfwEnabled) {
        pygNsfwEnabled = false;
        updateNsfwToggle();
        showToast('Pygmalion token expired, please re-authenticate.', 'warning', 5000);
        openPygTokenModal();
    }
}

// The init-time load's freshness gate and activate's own call can overlap; share one login request
let pygAutoLoginInFlight = null;

function tryAutoLogin() {
    if (!pygAutoLoginInFlight) {
        pygAutoLoginInFlight = doAutoLogin().finally(() => { pygAutoLoginInFlight = null; });
    }
    return pygAutoLoginInFlight;
}

/**
 * Auto-login with stored credentials if plugin available and no valid token.
 * Called on activate() - runs silently, no toasts on failure.
 */
async function doAutoLogin() {
    if (pygToken && getTokenTTL(pygToken) > 60) return;
    if (!getSetting('pygmalionRememberCredentials')) return;

    const email = getSetting('pygmalionEmail');
    const password = getSetting('pygmalionPassword');
    if (!email || !password) return;

    pygPluginAvailable = await checkPluginAvailable(apiRequest);
    if (!pygPluginAvailable) return;

    debugLog('[PygAuth] Attempting auto-login with stored credentials...');

    try {
        const resp = await apiRequest(`${PROVIDER_SERVICES_BASE}/pyg-login`, 'POST', {
            username: email,
            password: password,
        });

        if (resp.status === 201) {
            const data = await resp.json();
            const token = data?.result?.id_token;
            if (token) {
                savePygToken(token);
                scheduleTokenRefresh(token, email, password);

                const savedNsfw = getSetting('pygmalionNsfw') === true;
                if (savedNsfw && !pygNsfwEnabled) {
                    pygNsfwEnabled = true;
                    updateNsfwToggle();
                    // the first page went out SFW while the token was still on its way
                    if (pygViewMode === 'browse') pygmalionBrowseView.reload();
                }

                debugLog('[PygAuth] Auto-login successful');
            }
        }
    } catch (e) {
        debugLog('[PygAuth] Auto-login failed:', e.message);
    }
}

// ========================================
// FOLLOW AUTHOR
// ========================================

let pygIsFollowingCurrentAuthor = false;
let pygFollowedUserIds = null; // Set<string> - cached followed user IDs

async function fetchPygFollowedUserIds() {
    await ensureFreshPygToken();
    if (!pygToken) return new Set();

    try {
        let page = 0;
        const ids = new Set();
        let hasMore = true;

        while (hasMore) {
            const resp = await getFollowedUsers(pygToken, { pageNumber: page, pageSize: 50 });
            const users = resp.users || [];
            for (const u of users) {
                if (u.id) ids.add(u.id);
            }
            hasMore = users.length >= 50;
            page++;
            if (page > 20) break;
        }

        pygFollowedUserIds = ids;
        debugLog('[PygFollow] Cached', ids.size, 'followed user IDs');
        return ids;
    } catch (e) {
        console.error('[PygFollow] Error fetching followed users:', e);
        return new Set();
    }
}

async function updatePygFollowButton(ownerId) {
    const followBtn = document.getElementById('pygFollowAuthorBtn');
    if (!followBtn) return;

    if (!pygToken || !ownerId) {
        followBtn.hidden = true;
        return;
    }

    followBtn.hidden = false;
    followBtn.disabled = true;
    followBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        if (!pygFollowedUserIds) {
            await fetchPygFollowedUserIds();
        }
        pygIsFollowingCurrentAuthor = pygFollowedUserIds?.has(ownerId) || false;
    } catch (e) {
        debugLog('[PygFollow] Could not check follow status:', e);
        pygIsFollowingCurrentAuthor = false;
    }

    followBtn.disabled = false;
    if (pygIsFollowingCurrentAuthor) {
        followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
        followBtn.classList.add('following');
        followBtn.title = 'Unfollow this author';
    } else {
        followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
        followBtn.classList.remove('following');
        followBtn.title = 'Follow this author';
    }
}

async function togglePygFollowAuthor() {
    if (!pygToken) {
        showToast('Login required to follow authors', 'warning');
        openPygTokenModal();
        return;
    }

    if (!pygAuthorOwnerId) {
        showToast('Cannot determine author ID', 'warning');
        return;
    }

    const followBtn = document.getElementById('pygFollowAuthorBtn');
    if (followBtn) {
        followBtn.disabled = true;
        followBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }

    try {
        let result;
        try {
            await ensureFreshPygToken();
            result = await toggleFollowUser(pygToken, pygAuthorOwnerId);
        } catch (e) {
            if (e.authFailed) {
                showToast('Pygmalion token expired, please re-authenticate.', 'warning', 5000);
                openPygTokenModal();
            } else {
                showToast(`Follow failed: ${e.message}`, 'error');
            }
            if (followBtn) {
                followBtn.disabled = false;
                followBtn.innerHTML = pygIsFollowingCurrentAuthor
                    ? '<i class="fa-solid fa-heart"></i> <span>Following</span>'
                    : '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
            }
            return;
        }
        pygIsFollowingCurrentAuthor = result.isFollowing ?? !pygIsFollowingCurrentAuthor;

        if (pygFollowedUserIds) {
            if (pygIsFollowingCurrentAuthor) {
                pygFollowedUserIds.add(pygAuthorOwnerId);
            } else {
                pygFollowedUserIds.delete(pygAuthorOwnerId);
            }
        }

        if (pygIsFollowingCurrentAuthor) {
            showToast(`Following ${pygAuthorFilter}`, 'success');
            if (followBtn) {
                followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
                followBtn.classList.add('following');
            }
        } else {
            showToast(`Unfollowed ${pygAuthorFilter}`, 'info');
            if (followBtn) {
                followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
                followBtn.classList.remove('following');
            }
        }

        // Invalidate following timeline cache
        pygFollowingCharacters = [];
        pygFollowedUsers = [];

        if (followBtn) followBtn.disabled = false;
    } catch (e) {
        console.error('[PygFollow] Error:', e);
        showToast(`Follow action failed: ${e.message}`, 'error');

        if (followBtn) {
            followBtn.disabled = false;
            followBtn.innerHTML = pygIsFollowingCurrentAuthor
                ? '<i class="fa-solid fa-heart"></i> <span>Following</span>'
                : '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
        }
    }
}

// ========================================
// EVENT WIRING
// ========================================

let modalEventsAttached = false;

function initPygView() {
    if (delegatesInitialized) return;
    delegatesInitialized = true;

    // Search
    on('pygSearchBtn', 'click', () => performPygSearch());

    const searchInput = document.getElementById('pygSearchInput');
    if (searchInput) {
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('pygSearchBtn')?.click();
            }
        });
    }

    on('pygClearSearchBtn', 'click', () => {
        const input = document.getElementById('pygSearchInput');
        if (input) input.value = '';
        performPygSearch();
    });
    on('pygClearAuthorBtn', 'click', clearAuthorFilter);
    on('pygFollowAuthorBtn', 'click', togglePygFollowAuthor);

    // Sort (browse mode)
    const sortSelect = document.getElementById('pygSortSelect');
    if (sortSelect) {
        CoreAPI.initCustomSelect(sortSelect);
        sortSelect.addEventListener('change', () => {
            pygSortMode = sortSelect.value;
            pygmalionBrowseView.reload();
        });
    }

    // Sort (following mode)
    const followingSortSelect = document.getElementById('pygFollowingSortSelect');
    if (followingSortSelect) {
        CoreAPI.initCustomSelect(followingSortSelect);
        followingSortSelect.addEventListener('change', () => {
            pygFollowingSort = followingSortSelect.value;
            renderPygFollowing();
        });
    }

    // Sort (author filter)
    const authorSortSelect = document.getElementById('pygAuthorSortSelect');
    if (authorSortSelect) {
        CoreAPI.initCustomSelect(authorSortSelect);
        authorSortSelect.addEventListener('change', () => {
            pygAuthorSort = authorSortSelect.value;
            pygmalionBrowseView.reload();
        });
    }

    // View mode toggle (Browse/Following)
    document.querySelectorAll('.browse-view-btn[data-pyg-view]').forEach(btn => {
        btn.addEventListener('click', () => {
            const newMode = btn.dataset.pygView;
            if (newMode === pygViewMode) return;

            if (newMode === 'following') {
                loadPygToken();
                if (!pygToken) {
                    showToast('Following needs your Pygmalion session token. Add it in the window that opened.', 'warning');
                    openPygTokenModal();
                    return;
                }
            }

            switchPygViewMode(newMode);
        });
    });

    // NSFW toggle
    on('pygNsfwToggle', 'click', () => {
        loadPygToken();
        if (!pygToken) {
            showToast('NSFW content needs your Pygmalion session token. Add it in the window that opened.', 'warning');
            openPygTokenModal();
            return;
        }
        pygNsfwEnabled = !pygNsfwEnabled;
        setSetting('pygmalionNsfw', pygNsfwEnabled);
        updateNsfwToggle();
        if (pygViewMode === 'following') {
            renderPygFollowing();
        } else {
            pygmalionBrowseView.reload();
        }
    });

    // Refresh
    on('pygRefreshBtn', 'click', () => pygmalionBrowseView.reload({ force: true }));

    // Tags dropdown
    const tagsDropdown = document.getElementById('pygTagsDropdown');
    const filtersDropdown = document.getElementById('pygFiltersDropdown');

    on('pygTagsBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns('pygTagsDropdown');
        if (filtersDropdown) filtersDropdown.classList.add('hidden');
        if (tagsDropdown) tagsDropdown.classList.toggle('hidden');
    });

    if (tagsDropdown) tagsDropdown.addEventListener('click', (e) => e.stopPropagation());

    renderPygTagsList();

    const tagSearchInput = document.getElementById('pygTagsSearchInput');
    if (tagSearchInput) {
        const debouncedFilter = debounce((val) => renderPygTagsList(val), 200);
        tagSearchInput.addEventListener('input', () => debouncedFilter(tagSearchInput.value));
    }

    on('pygTagsClearBtn', 'click', () => {
        pygIncludeTags.clear();
        pygExcludeTags.clear();
        renderPygTagsList(document.getElementById('pygTagsSearchInput')?.value || '');
        updatePygTagsButton();
        if (pygViewMode === 'following') {
            renderPygFollowing();
        } else {
            pygmalionBrowseView.reload();
        }
    });

    // Features dropdown
    on('pygFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns('pygFiltersDropdown');
        if (tagsDropdown) tagsDropdown.classList.add('hidden');
        if (filtersDropdown) filtersDropdown.classList.toggle('hidden');
    });

    if (filtersDropdown) filtersDropdown.addEventListener('click', (e) => e.stopPropagation());

    pygmalionBrowseView.wireFeatureFilters(PYG_FEATURE_FILTERS, pygFeatureState, () => {
        if (pygViewMode === 'following') {
            renderPygFollowing();
        } else {
            pygmalionBrowseView.reload();
        }
    }, { badge: updatePygFiltersButton });

    pygmalionBrowseView._registerDropdownDismiss([
        { dropdownId: 'pygTagsDropdown', buttonId: 'pygTagsBtn' },
        { dropdownId: 'pygFiltersDropdown', buttonId: 'pygFiltersBtn' }
    ]);

    // Load More
    on('pygLoadMoreBtn', 'click', () => {
        if (pygHasMore && !pygIsLoading) pygmalionBrowseView.reload({ append: true });
    });

    // Grid card click (browse)
    const grid = document.getElementById('pygGrid');
    if (grid) {
        grid.addEventListener('click', (e) => {
            // Creator link
            const creatorLink = e.target.closest('.browse-card-creator-link');
            if (creatorLink) {
                e.stopPropagation();
                const author = creatorLink.dataset.author;
                const ownerId = creatorLink.dataset.ownerId;
                if (author) filterByAuthor(author, ownerId);
                return;
            }

            // Card click → open preview
            const card = e.target.closest('.browse-card');
            if (card) {
                const charId = card.dataset.pygId;
                const hit = pygCharacters.find(c => c.id === charId);
                if (hit) openPreviewModal(hit);
            }
        });
    }

    // Grid card click (following)
    const followingGrid = document.getElementById('pygFollowingGrid');
    if (followingGrid) {
        followingGrid.addEventListener('click', _handleFollowingCardClick);
    }

    // Preview modal events (attached once - persist across provider switches)
    if (!modalEventsAttached) {
        modalEventsAttached = true;

        const pygOverlay = document.getElementById('pygCharModal');
        BrowseView.wireTitleScroll(document.getElementById('pygCharName'), pygOverlay, pygOverlay?.querySelector('.browse-char-modal'));

        on('pygCharClose', 'click', () => closePreviewModal());
        on('pygImportBtn', 'click', () => { if (pygSelectedChar) importCharacter(pygSelectedChar); });

        // Creator name → in-app author filter
        const creatorLink = document.getElementById('pygCharCreator');
        if (creatorLink) {
            creatorLink.addEventListener('click', (e) => {
                e.preventDefault();
                const name = creatorLink.textContent.trim();
                const ownerId = creatorLink.dataset.ownerId;
                if (name && name !== 'Unknown') {
                    closePreviewModal();
                    filterByAuthor(name, ownerId);
                }
            });
        }

        // Avatar click → full-size viewer (desktop only at event time; mobile has its own handler)
        const avatar = document.getElementById('pygCharAvatar');
        if (avatar) {
            avatar.style.cursor = 'pointer';
            avatar.addEventListener('click', () => {
                if (isMobileMode()) return;
                const src = avatar.src;
                if (src && src !== '/img/no-portrait.png') {
                    BrowseView.openAvatarViewer(src, '/img/no-portrait.png');
                }
            });
        }

        // Backdrop click (preview)
        const modalOverlay = document.getElementById('pygCharModal');
        if (modalOverlay) {
            modalOverlay.addEventListener('click', (e) => {
                if (e.target === modalOverlay) closePreviewModal();
            });
        }

        const pygGalleryGrid = document.getElementById('pygCharGalleryGrid');
        if (pygGalleryGrid) {
            pygGalleryGrid.addEventListener('click', (e) => {
                if (e.target.classList.contains('browse-gallery-thumb')) {
                    const thumbs = [...pygGalleryGrid.querySelectorAll('.browse-gallery-thumb')];
                    const urls = thumbs.map(t => t.src);
                    const idx = thumbs.indexOf(e.target);
                    BrowseView.openAvatarViewer(e.target.src, null, urls, idx);
                }
            });
        }

        // Login modal events
        on('pygLoginClose', 'click', closePygTokenModal);

        const loginOverlay = document.getElementById('pygLoginModal');
        if (loginOverlay) {
            loginOverlay.addEventListener('click', (e) => {
                if (e.target === loginOverlay) closePygTokenModal();
            });
        }

        // Email/password login
        on('pygLoginBtn', 'click', () => {
            const email = document.getElementById('pygLoginEmail')?.value.trim();
            const password = document.getElementById('pygLoginPassword')?.value;
            if (!email || !password) {
                showToast('Please enter both email and password', 'warning');
                return;
            }
            loginWithCredentials(email, password);
        });

        // Enter key submits login form
        for (const id of ['pygLoginEmail', 'pygLoginPassword']) {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        document.getElementById('pygLoginBtn')?.click();
                    }
                });
            }
        }

        window.registerOverlay?.({ id: 'pygCharModal', tier: 7, close: () => closePreviewModal() });
        window.registerOverlay?.({ id: 'pygLoginModal', tier: 6, close: () => closePygTokenModal() });
        window.registerOverlay?.({ id: 'pygAuthorBanner', tier: 9, close: () => clearAuthorFilter() });
    }
}

// ========================================
// BROWSE VIEW CLASS
// ========================================

class PygmalionBrowseView extends BrowseView {

    constructor(provider) {
        super(provider);
        view = this;
    }

    hitMatchName(hit) {
        const owner = hit.owner || {};
        return { name: hit.displayName || hit.name || '', creator: owner.username || owner.displayName || '', text: '' };
    }

    hitLinkKey(hit) {
        return hit?.id || null;
    }

    // -- Following Manager --

    get supportsFollowingManager() { return true; }

    async getFollowedCreators() {
        if (!pygToken) return [];
        if (pygFollowedUsers.length > 0) {
            return pygFollowedUsers.map(u => ({
                id: u.id || u.userId,
                name: u.displayName || u.username || 'Unknown',
                username: u.username,
                avatar: u.profilePicture || u.avatarUrl || '',
            }));
        }
        // Fall back to fetching IDs only (no display names available from cache)
        const ids = await fetchPygFollowedUserIds();
        return [...ids].map(id => ({
            id,
            name: id,
        }));
    }

    getCreatorAvatarUrl(creator) {
        return creator.avatar ? getAvatarUrl(creator.avatar) : '';
    }

    async followCreator(query) {
        if (!pygToken) {
            showToast('Login required to follow users on Pygmalion', 'warning');
            return null;
        }
        const trimmed = query.trim();
        if (!trimmed) return null;

        // Pygmalion requires userId UUID to follow
        const uuidMatch = trimmed.match(/^[0-9a-f-]{36}$/i);
        if (!uuidMatch) {
            showToast('Enter a Pygmalion user ID (UUID) to follow', 'info');
            return null;
        }

        try {
            await ensureFreshPygToken();
            const result = await toggleFollowUser(pygToken, trimmed);
            if (result.isFollowing) {
                if (pygFollowedUserIds) pygFollowedUserIds.add(trimmed);
                showToast('Following the user', 'success');
                return { id: trimmed, name: trimmed };
            }
            return null;
        } catch (e) {
            if (e.authFailed) {
                showToast('Token expired, please re-authenticate', 'warning');
            } else {
                showToast(`Failed: ${e.message}`, 'error');
            }
            return null;
        }
    }

    async unfollowCreator(id) {
        if (!pygToken) return false;
        try {
            await ensureFreshPygToken();
            const result = await toggleFollowUser(pygToken, id);
            if (!result.isFollowing) {
                if (pygFollowedUserIds) pygFollowedUserIds.delete(id);
                // Clear cached following data so it reloads
                pygFollowedUsers = pygFollowedUsers.filter(u => (u.id || u.userId) !== id);
                showToast('Unfollowed user', 'info');
                return true;
            }
            return false;
        } catch (e) {
            showToast(`Failed: ${e.message}`, 'error');
            return false;
        }
    }

    browseCreatorFromManager(creator) {
        filterByAuthor(creator.name || creator.id, creator.id);
    }

    get previewModalId() { return 'pygCharModal'; }

    // the provider page a finished import's gallery is fetched from (the import summary's row)
    galleryUrlFor(result) { return getCharacterPageUrl(result.providerCharId); }
    get hasModeToggle() { return true; }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'downloads', label: 'Downloads' },
                { value: 'stars', label: 'Stars' },
                { value: 'views', label: 'Views' },
                { value: 'approved_at', label: 'Newest' },
                { value: 'token_count', label: 'Tokens' },
                { value: 'display_name', label: 'Name' },
            ],
            followingSortOptions: [
                { value: 'newest', label: 'Newest Created' },
                { value: 'oldest', label: 'Oldest First' },
                { value: 'name_asc', label: 'Name A-Z' },
                { value: 'name_desc', label: 'Name Z-A' },
                { value: 'downloads', label: 'Most Downloads' },
                { value: 'stars', label: 'Most Stars' },
            ],
            viewModes: [
                { value: 'browse', label: 'Browse' },
                { value: 'following', label: 'Following' },
            ],
        };
    }

    closePreview() {
        closePreviewModal();
    }

    get mobileFilterIds() {
        return {
            sort: 'pygSortSelect',
            tags: 'pygTagsBtn',
            filters: 'pygFiltersBtn',
            nsfw: 'pygNsfwToggle',
            refresh: 'pygRefreshBtn',
            timelineSort: 'pygFollowingSortSelect',
            modeBrowseSelector: '.browse-view-btn[data-pyg-view="browse"]',
            modeFollowSelector: '.browse-view-btn[data-pyg-view="following"]',
            modeBtnClass: 'browse-view-btn',
        };
    }

    // Filter Bar

    renderFilterBar() {
        return `
            <!-- Mode Toggle -->
            ${renderViewToggle('pyg-view', [
                { value: 'browse', icon: 'fa-compass', label: 'Browse', title: 'Browse all characters', active: true },
                { value: 'following', icon: 'fa-users', label: 'Following', title: 'New from followed authors (requires token)' },
            ])}

            <!-- Sort (Browse mode) -->
            <div class="browse-sort-container">
                <select id="pygSortSelect" class="glass-select" title="Sort order">
                    <option value="downloads" data-icon="fa-solid fa-download" selected>Downloads</option>
                    <option value="stars" data-icon="fa-solid fa-star">Stars</option>
                    <option value="views" data-icon="fa-solid fa-eye">Views</option>
                    <option value="approved_at" data-icon="fa-solid fa-calendar-plus">Newest</option>
                    <option value="token_count" data-icon="fa-solid fa-weight-hanging">Tokens</option>
                    <option value="display_name" data-icon="fa-solid fa-arrow-down-a-z">Name</option>
                </select>

                <!-- Sort (Following mode) -->
                <select id="pygFollowingSortSelect" class="glass-select hidden" title="Sort following timeline">
                    <option value="newest" data-icon="fa-solid fa-calendar-plus" selected>Newest Created</option>
                    <option value="oldest" data-icon="fa-solid fa-hourglass">Oldest First</option>
                    <option value="name_asc" data-icon="fa-solid fa-arrow-down-a-z">Name A-Z</option>
                    <option value="name_desc" data-icon="fa-solid fa-arrow-up-z-a">Name Z-A</option>
                    <option value="downloads" data-icon="fa-solid fa-download">Most Downloads</option>
                    <option value="stars" data-icon="fa-solid fa-star">Most Stars</option>
                </select>
            </div>

            <!-- Tags Dropdown -->
            <div class="browse-tags-dropdown-container u-relative">
                <button id="pygTagsBtn" class="glass-btn" title="Tag filters">
                    <i class="fa-solid fa-tags"></i> <span id="pygTagsBtnLabel">Tags</span>
                </button>
                <div id="pygTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="pygTagsSearchInput" placeholder="Search tags..." autocomplete="one-time-code">
                        <button id="pygTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="pygTagsList"></div>
                </div>
            </div>

            <!-- Feature Filters -->
            <div class="browse-more-filters u-relative">
                <button id="pygFiltersBtn" class="glass-btn" title="Additional filters">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="pygFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden">
                    ${renderFeatureFilterItems(PYG_FILTER_SECTIONS, PYG_FEATURE_FILTERS)}
                </div>
            </div>

            <!-- NSFW toggle (requires auth token for sensitive content) -->
            <button id="pygNsfwToggle" class="glass-btn nsfw-toggle u-dim-50" title="Showing SFW only - click to include NSFW (requires auth token)">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Refresh -->
            <button id="pygRefreshBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // Main View

    renderView() {
        return `
            <!-- Browse Section -->
            <div id="pygBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="pygSearchInput" placeholder="Search Pygmalion characters..." autocomplete="one-time-code">
                        <button id="pygClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="pygSearchBtn" class="browse-search-submit" aria-label="Search">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                </div>

                <div id="pygAuthorBanner" class="browse-author-banner hidden">
                    <div class="browse-author-banner-content">
                        <i class="fa-solid fa-user"></i>
                        <span>Showing characters by <strong id="pygAuthorBannerName">Author</strong></span>
                    </div>
                    <div class="browse-author-banner-actions">
                        <select id="pygAuthorSortSelect" class="glass-select" title="Sort author's characters">
                            <option value="approved_at" data-icon="fa-solid fa-calendar-plus" selected>Newest Created</option>
                            <option value="downloads" data-icon="fa-solid fa-download">Most Downloads</option>
                            <option value="stars" data-icon="fa-solid fa-star">Top Rated</option>
                            <option value="views" data-icon="fa-solid fa-eye">Most Views</option>
                        </select>
                        <button id="pygFollowAuthorBtn" class="glass-btn" title="Follow this author" hidden>
                            <i class="fa-solid fa-heart"></i> <span>Follow</span>
                        </button>
                        <button id="pygClearAuthorBtn" class="glass-btn icon-only" title="Clear author filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Results Grid -->
                <div id="pygGrid" class="browse-grid"></div>

                <!-- Load More -->
                <div class="browse-load-more" id="pygLoadMore" hidden>
                    <button id="pygLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>

            <!-- Following Section -->
            <div id="pygFollowingSection" class="browse-section hidden">
                <div class="browse-timeline-header">
                    <div class="browse-timeline-header-left">
                        <h3><i class="fa-solid fa-clock"></i> Timeline</h3>
                        <p>New characters from authors you follow</p>
                    </div>
                    <div class="browse-timeline-header-right">
                        <button class="follow-mgr-toggle-btn glass-btn" id="pygmalionFollowMgrToggle"
                                title="Manage followed creators">
                            <i class="fa-solid fa-users-gear"></i> Manage
                        </button>
                    </div>
                </div>
                ${this.renderFollowingManagerPanel()}
                <div id="pygFollowingGrid" class="browse-grid"></div>
                <div class="browse-load-more" id="pygFollowingLoadMore" hidden>
                    <button id="pygFollowingLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    // Modals

    renderModals() {
        return this._renderLoginModal() + this._renderPreviewModal();
    }

    _renderLoginModal() {
        return `
    <div id="pygLoginModal" class="modal-overlay hidden">
        <div class="modal-glass browse-login-modal">
            <div class="modal-header">
                <h2><i class="fa-solid fa-key"></i> Pygmalion Authentication</h2>
                <button class="close-btn" id="pygLoginClose">&times;</button>
            </div>
            <div class="browse-login-body">
                <p class="browse-login-info">
                    <i class="fa-solid fa-check-circle text-success-bright"></i>
                    <strong>Browsing and downloading public characters works without logging in.</strong>
                </p>
                <p class="browse-login-info">
                    <i class="fa-solid fa-key text-accent"></i>
                    <strong>Optional:</strong> Log in to enable NSFW content, follow authors, and access your Following timeline.
                </p>

                <!-- Token status -->
                <div id="pygTokenStatus" class="pyg-auth-status" hidden></div>

                <!-- Login form (requires provider service) -->
                <div class="pyg-login-section">
                    <div class="pyg-plugin-status">
                        <span id="pygPluginStatusOk" hidden>
                            <i class="fa-solid fa-plug-circle-check text-success-bright"></i> Login route available
                        </span>
                        <span id="pygPluginStatusMissing" hidden>
                            <i class="fa-solid fa-plug-circle-xmark text-warning-dark"></i>
                            Login route unavailable. The server did not answer, so login is not usable right now.
                        </span>
                    </div>

                    <div id="pygLoginForm" class="browse-login-form">
                        <div class="form-group">
                            <label for="pygLoginEmail">Email</label>
                            <input type="email" id="pygLoginEmail" class="glass-input" placeholder="your-email@example.com" autocomplete="email">
                        </div>
                        <div class="form-group u-mt-sm">
                            <label for="pygLoginPassword">Password</label>
                            <input type="password" id="pygLoginPassword" class="glass-input" placeholder="Your Pygmalion password" autocomplete="current-password">
                        </div>

                        <div class="browse-login-actions is-start">
                            <button id="pygLoginBtn" class="glass-btn is-success" disabled>
                                <i class="fa-solid fa-sign-in-alt"></i> Log In
                            </button>
                            <a href="https://pygmalion.chat" target="_blank" class="glass-btn" title="Go to Pygmalion Website">
                                <i class="fa-solid fa-external-link"></i> Website
                            </a>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;
    }

    _renderPreviewModal() {
        return `
    <div id="pygCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="pygCharAvatar" src="/img/no-portrait.png" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="pygCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="pygCharCreator" class="browse-meta-identity" href="#" title="Click to see all characters by this author">Creator</a>
                            <a id="pygCreatorExternal" href="#" target="_blank" class="creator-external-link" title="Open author's Pygmalion profile"><i class="fa-solid fa-external-link"></i></a>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="pygOpenInBrowserBtn" href="#" target="_blank" class="cl-btn cl-btn-secondary" title="Open on Pygmalion">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="pygImportBtn" class="cl-btn cl-btn-primary" title="Import into your library">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="pygCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-tagline" id="pygCharTaglineSection" hidden>
                    <i class="fa-solid fa-quote-left"></i>
                    <div id="pygCharTagline" class="browse-tagline-text"></div>
                </div>

                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-download"></i>
                            <span id="pygCharDownloads">0</span> downloads
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-star"></i>
                            <span id="pygCharStars">0</span> stars
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-eye"></i>
                            <span id="pygCharViews">0</span> views
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-comments"></i>
                            <span id="pygCharChats">0</span> chats
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="pygCharDate">Unknown</span>
                        </div>
                        <div class="browse-stat" id="pygCharSourceStat" hidden>
                            <i class="fa-solid fa-tag"></i>
                            <span id="pygCharSource"></span>
                        </div>
                        <div class="browse-stat" id="pygCharGalleryStat" hidden>
                            <i class="fa-solid fa-images"></i>
                            <span id="pygCharGalleryCount">0</span> images
                        </div>
                        <div class="browse-stat" id="pygCharGreetingsStat" hidden>
                            <i class="fa-solid fa-comment-dots"></i>
                            <span id="pygCharGreetingsCount">0</span> greetings
                        </div>
                    </div>
                    <div class="browse-char-tags" id="pygCharTags"></div>
                </div>

                <!-- Creator's Notes -->
                <div class="browse-char-section" id="pygCharCreatorNotesSection" hidden>
                    <h3 class="browse-section-title" data-section="pygCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="pygCharCreatorNotes" class="scrolling-text"></div>
                </div>

                <!-- Description (Persona) -->
                <div class="browse-char-section" id="pygCharDescriptionSection" hidden>
                    <h3 class="browse-section-title" data-section="pygCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="pygCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Example Dialogs -->
                <div class="browse-char-section browse-section-collapsed" id="pygCharExamplesSection" hidden>
                    <h3 class="browse-section-title" data-section="pygCharExamples" data-label="Example Dialogs" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Dialogs
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="pygCharExamples" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="pygCharFirstMsgSection" hidden>
                    <h3 class="browse-section-title" data-section="pygCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="pygCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>

                <!-- Alternate Greetings -->
                <div class="browse-char-section" id="pygCharAltGreetingsSection" hidden>
                    <h3 class="browse-section-title" data-section="browseAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="pygCharAltGreetingsCount"></span>
                    </h3>
                    <div id="pygCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>

                <!-- Gallery -->
                <div class="browse-char-section" id="pygCharGallerySection" hidden>
                    <h3 class="browse-section-title" data-section="pygCharGalleryGrid" data-label="Gallery" data-icon="fa-solid fa-images" title="Click to expand">
                        <i class="fa-solid fa-images"></i> Gallery <span class="browse-section-count" id="pygCharGalleryLabel"></span>
                    </h3>
                    <div id="pygCharGalleryGrid" class="browse-gallery-grid"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // Lifecycle

    _getImageGridIds() {
        return ['pygGrid', 'pygFollowingGrid'];
    }

    canLoadMore() { return pygHasMore && !pygIsLoading && pygViewMode === 'browse'; }

    init() {
        super.init();
        loadPygToken();

        // Restore persisted NSFW preference (only if token exists)
        const savedNsfw = getSetting('pygmalionNsfw') === true;
        if (savedNsfw && pygToken) pygNsfwEnabled = true;

        initPygView();
        const grid = document.getElementById('pygGrid');
        if (grid) this.observeImages(grid);
        // No initial load here: the base's migrated activation arm dispatches the
        // current mode's load (and builds the library lookup first).
    }

    getSearchInputId(mode) {
        return mode === 'character' ? 'pygSearchInput' : null;
    }

    applyDefaults(defaults) {
        super.applyDefaults(defaults);
        if (defaults.sort) {
            if (pygViewMode === 'browse') {
                pygSortMode = defaults.sort;
                const el = document.getElementById('pygSortSelect');
                if (el) el.value = defaults.sort;
            } else {
                pygFollowingSort = defaults.sort;
                const el = document.getElementById('pygFollowingSortSelect');
                if (el) el.value = defaults.sort;
            }
        }
    }

    // Activation hooks and the two modes

    resetSessionState() {
        pygCurrentSearch = '';
        pygCharacters = [];
        pygCurrentPage = 0;
        pygHasMore = true;
        pygIsLoading = false;
        pygFollowingLoading = false;
        pygGridRenderedCount = 0;
        pygAuthorFilter = null;
        pygAuthorOwnerId = null;
        pygAuthorSort = 'approved_at';
        pygIncludeTags.clear();
        pygExcludeTags.clear();
        for (const k of Object.keys(pygFeatureState)) pygFeatureState[k] = false;
        pygViewMode = 'browse';
        pygFollowingCharacters = [];
        pygFollowedUsers = [];
        pygSelectedChar = null;
    }

    onActivated(isReEntry) {
        delegatesInitialized = true;
        // the silent auto-login runs every entry; following loads gate on a fresh token, browse rides the current one
        loadPygToken();
        tryAutoLogin();
    }

    get viewModes() {
        return {
            modeAttr: 'data-pyg-view',
            current: () => pygViewMode,
            set: (m) => { pygViewMode = m; },
            onSwitch: () => loadPygToken(),
            modes: {
                browse: {
                    sectionId: 'pygBrowseSection',
                    gridId: 'pygGrid',
                    hasData: () => pygCharacters.length > 0,
                    load: (o) => {
                        if (o?.append) pygCurrentPage++;
                        else pygCurrentPage = 0;
                        return loadCharacters(!!o?.append);
                    },
                    render: () => { pygGridRenderedCount = 0; renderGrid(pygCharacters, false); },
                    chrome: () => setPygModeChrome('browse'),
                    // always reload on switch-in: browse results go stale against the
                    // filters/search the user changed while away
                    reload: true,
                    enter: () => {
                        const grid = document.getElementById('pygGrid');
                        if (grid) renderSkeletonGrid(grid);
                        pygCharacters = [];
                        pygCurrentPage = 0;
                    },
                },
                following: {
                    sectionId: 'pygFollowingSection',
                    gridId: 'pygFollowingGrid',
                    hasData: () => pygFollowingCharacters.length > 0,
                    // the feed needs a live token; the silent login dedupes concurrent
                    // callers, so this never doubles the entry's own attempt
                    load: (o) => Promise.resolve(tryAutoLogin()).then(() => loadPygFollowingTimeline(!!o?.force)),
                    render: () => renderPygFollowing(),
                    chrome: () => setPygModeChrome('following'),
                },
            },
        };
    }

    get creatorScope() {
        return {
            bannerId: 'pygAuthorBanner',
            isActive: () => !!pygAuthorFilter,
            // the search loader branches on the owner id itself, so the scope loads through the browse hook
            load: (o) => this.viewModes.modes.browse.load(o),
            clear: () => {
                pygAuthorFilter = null;
                pygAuthorOwnerId = null;
                const followBtn = document.getElementById('pygFollowAuthorBtn');
                if (followBtn) followBtn.hidden = true;
            },
            chrome: () => setPygModeChrome(pygViewMode),
            stash: () => ({ search: pygCurrentSearch }),
            restore: (s) => {
                pygCurrentSearch = s.search;
                const input = document.getElementById('pygSearchInput');
                if (input) input.value = s.search;
                document.getElementById('pygClearSearchBtn')?.classList.toggle('hidden', !s.search);
            },
        };
    }

    deactivate() {
        pygDetailFetchToken++;
        delegatesInitialized = false;
        // Reset following-tab in-flight flag so a stuck flag from a hung fetch
        // can't block the next view re-entry from kicking off a fresh load.
        pygFollowingLoading = false;
        super.deactivate();
    }
}

const pygmalionBrowseView = new PygmalionBrowseView(null);

window.openPygmalionCharPreview = function(hit) {
    openPreviewModal(hit);
};

window.openPygmalionTokenModal = function() {
    openPygTokenModal();
};

export default pygmalionBrowseView;

// ========================================
// CREATOR DOWNLOADS ADAPTER
// ========================================

registerCdAdapter('pygmalion', {
    async fetchAll(view) {
        const ownerId = view._cdRef?.ownerId;
        if (!ownerId) return [];
        const token = CoreAPI.getSetting('pygmalionToken') || undefined;
        const results = [];
        const seen = new Set();
        const PAGE = 48;
        for (let page = 0; ; page++) {
            const data = await fetchCharactersByOwner(ownerId, 'approved_at', page, token);
            const hits = data?.characters || [];
            let added = 0;
            for (const hit of hits) {
                if (!hit.id || seen.has(hit.id)) continue;
                seen.add(hit.id);
                added++;
                const owner = hit.owner || {};
                results.push({ key: hit.id, name: hit.displayName || hit.name || '', creator: owner.username || owner.displayName || '', raw: hit });
            }
            const totalItems = parseInt(data?.totalItems || '0', 10);
            if (hits.length < PAGE || added === 0 || (totalItems > 0 && results.length >= totalItems)) break;
        }
        return results;
    },
    async importOne(view, card) {
        const provider = CoreAPI.getProvider('pygmalion');
        if (!provider?.importCharacter) return { ok: false, error: 'Provider not available' };
        const hit = card.raw;
        const result = await importThroughCommand(provider, hit.id, hit, {});
        if (!result.success) return { ok: false, error: result.error || 'Import failed' };
        return view.creatorImportAnswer(result, provider);
    },
});
