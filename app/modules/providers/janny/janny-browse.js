// JannyBrowseView - JannyAI browse/search UI for the Online tab

import {
    BrowseView, registerCdAdapter, featureFilterState, renderFeatureFilterItems, countActiveFeatures,
    activeFeatureRows, featurePasses, applyTagsClamp, updateNsfwToggleButton, cardTagsHtml,
    libraryFeatureRows, libraryBadgeHtml, libraryCardClass, setFilterCount,
} from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber, BROWSE_PURIFY_CONFIG, skeletonLines, hideSections, deferRender, deferCall, isMobileMode, importThroughCommand, renderBrowseError, hasBrowserEndpoint, buildProviderNotice, definitionFailedNotice } from '../provider-utils.js';
import {
    JANNY_IMAGE_BASE,
    jannyCharacterUrl,
    jannyFullPath,
    jannySlug,
    TAG_MAP,
    meiliMultiSearch,
    slugify,
    stripHtml,
    resolveTagNames
} from './janny-api.js';

const {
    onElement: on,
    showToast,
    escapeHtml,
    debugLog,
    getSetting,
    formatRichText,
    safePurify,
    renderCreatorNotesSecure,
    renderCardHtmlSecure,
    cleanupCreatorNotesContainer,
    debounce,
    setSetting,
    renderLoadingState,
    renderSkeletonGrid,
} = CoreAPI;

// ========================================
// CONSTANTS
// ========================================



// ========================================
// STATE
// ========================================

let jannyCharacters = [];
let jannyCurrentPage = 1;
let jannyHasMore = true;
let jannyIsLoading = false;
let jannyLoadToken = 0;
let jannyCurrentSearch = '';
let jannyNsfwEnabled = false;
let jannySortMode = 'newest';
let jannySelectedChar = null;
let jannyGridRenderedCount = 0;

// showLowQuality is server-side (a Meili filter), so no predicate; the library pair filter client-side
const JANNY_FEATURE_FILTERS = [
    { key: 'showLowQuality', id: 'jannyFilterLowQuality', section: 'content', icon: 'fa-filter-circle-xmark', label: 'Show Low-Quality' },
    ...libraryFeatureRows('janny', () => view, isCharPossibleMatchObj),
];
const jannyFeatureState = featureFilterState(JANNY_FEATURE_FILTERS);

const JANNY_FILTER_SECTIONS = [
    { key: 'content', title: 'Content:' },
    { key: 'library', title: 'Library:' },
];

let jannyMinTokens = 29;
let jannyMaxTokens = 100000;
/** @type {Set<number>} Active include tag IDs */
let jannyIncludeTags = new Set();
let jannyAuthorFilter = null;

let view; // module-scoped BrowseView instance reference (set once in constructor)

// ========================================
// SEARCH API
// ========================================

async function searchJanny(opts = {}) {
    const { search = '', page = 1, limit = 80, sort = 'newest' } = opts;

    const filters = [];
    filters.push(`totalToken >= ${jannyMinTokens}`);
    filters.push(`totalToken <= ${jannyMaxTokens}`);
    if (!jannyNsfwEnabled) filters.push('isNsfw = false');
    if (!jannyFeatureState.showLowQuality) filters.push('isLowQuality = false');
    if (jannyIncludeTags.size > 0) {
        const tagClauses = [...jannyIncludeTags].map(id => `tagIds = ${id}`);
        filters.push(tagClauses.join(' AND '));
    }

    // MeiliSearch sort
    const sortMap = {
        newest: ['createdAtStamp:desc'],
        oldest: ['createdAtStamp:asc'],
        tokens_desc: ['totalToken:desc'],
        tokens_asc: ['totalToken:asc'],
        relevant: []
    };

    return meiliMultiSearch({
        search,
        page,
        limit,
        filters,
        facets: ['isLowQuality', 'isNsfw', 'tagIds', 'totalToken'],
        sort: sortMap[sort] || sortMap.newest,
        highlight: true,
    });
}

// ========================================
// LOCAL LIBRARY LOOKUP
// ========================================

function isCharPossibleMatchObj(h) {
    if (view.isHitInLibrary(h)) return false;
    return view.isCharPossibleMatch(h.name || '', h.creatorUsername || '');
}

// ========================================
// CARD RENDERING
// ========================================

function createJannyCard(hit) {
    const name = hit.name || 'Unknown';
    const desc = stripHtml(hit.description) || '';
    const avatarUrl = hit.avatar ? `${JANNY_IMAGE_BASE}${hit.avatar}` : '/img/no-portrait.png';
    const tags = resolveTagNames(hit.tagIds);
    const tokens = formatNumber(hit.totalToken || 0);
    const charId = hit.id || '';
    const slug = slugify(name);
    const creatorName = hit.creatorUsername || '';
    const inLibrary = view.isHitInLibrary(hit);
    const possibleTier = inLibrary ? null : view.getPossibleMatchTier(hit.name || '', creatorName);

    const badges = [];
    const importing = view.importingBadge(hit);
    if (importing) badges.push(importing);
    const libraryBadge = libraryBadgeHtml(inLibrary, possibleTier);
    if (libraryBadge) badges.push(libraryBadge);

    const createdDate = hit.createdAt
        ? new Date(hit.createdAt).toLocaleDateString()
        : (hit.createdAtStamp ? new Date(hit.createdAtStamp * 1000).toLocaleDateString() : '');
    const dateInfo = createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';

    const cardClass = libraryCardClass(inLibrary, possibleTier);

    return `
        <div class="${cardClass}" data-janny-id="${escapeHtml(charId)}"${view.linkKeyAttr(hit)} data-slug="${escapeHtml(slug)}" ${desc ? `title="${escapeHtml(desc)}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/no-portrait.png'">
                ${badges.length > 0 ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                ${creatorName ? `<span class="browse-card-creator-link" data-author="${escapeHtml(creatorName)}" title="Click to see all characters by ${escapeHtml(creatorName)}">${escapeHtml(creatorName)}</span>` : ''}
                ${cardTagsHtml(tags)}
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Tokens"><i class="fa-solid fa-font"></i> ${tokens}</span>
                ${dateInfo}
            </div>
        </div>
    `;
}

// ========================================
// IMAGE OBSERVER
// ========================================

function observeNewCards() {
    const grid = document.getElementById('jannyGrid');
    if (grid) jannyBrowseView.observeImages(grid);
}

// ========================================
// GRID RENDERING
// ========================================

function renderGrid(characters, append = false) {
    const grid = document.getElementById('jannyGrid');
    if (!grid) return;

    if (!append) {
        grid.innerHTML = '';
        jannyGridRenderedCount = 0;
    }

    const startIdx = jannyGridRenderedCount;
    const html = characters.slice(startIdx).map(c => createJannyCard(c)).join('');
    grid.insertAdjacentHTML('beforeend', html);
    jannyGridRenderedCount = characters.length;

    observeNewCards(startIdx);
    updateLoadMore();
}

function updateLoadMore() {
    jannyBrowseView.updateLoadMoreVisibility('jannyLoadMore', jannyHasMore, jannyCharacters.length > 0);
}

// ========================================
// SEARCH / LOAD
// ========================================

async function loadCharacters(append = false) {
    if (append && jannyIsLoading) return;
    const thisToken = ++jannyLoadToken;
    jannyIsLoading = true;

    const grid = document.getElementById('jannyGrid');
    const loadMoreBtn = document.getElementById('jannyLoadMoreBtn');

    if (!append && grid) {
        renderSkeletonGrid(grid);
    }

    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        const effectiveSearch = jannyAuthorFilter || jannyCurrentSearch;
        const data = await searchJanny({
            search: effectiveSearch,
            page: jannyCurrentPage,
            limit: 80,
            sort: jannySortMode
        });

        if (thisToken !== jannyLoadToken) return;
        if (!delegatesInitialized) return;

        const result = data?.results?.[0];
        let hits = result?.hits || [];
        await jannyBrowseView.probeHits(hits);
        const totalPages = result?.totalPages || 1;

        // Client-side: persistent exclude tags from settings
        const jannyPersistentExclude = view.persistentExcludeTags();
        if (jannyPersistentExclude.length > 0) {
            const lowerExclude = jannyPersistentExclude.map(t => t.toLowerCase());
            hits = hits.filter(h => {
                const names = resolveTagNames(h.tagIds).map(n => n.toLowerCase());
                return !lowerExclude.some(et => names.includes(et));
            });
        }

        // Client-side: hide owned / possible match characters
        const activeRows = activeFeatureRows(JANNY_FEATURE_FILTERS, jannyFeatureState);
        if (activeRows.length > 0) {
            hits = hits.filter(h => featurePasses(h, activeRows));
        }

        // Auto-fetch when client-side filters remove too many results
        const hasClientFilters = activeRows.length > 0 || jannyPersistentExclude.length > 0;
        if (hasClientFilters && jannyCurrentPage < totalPages) {
            let autoFetches = 0;
            while (hits.length < 80 && jannyCurrentPage < totalPages && autoFetches < 3 && delegatesInitialized) {
                autoFetches++;
                jannyCurrentPage++;
                const moreData = await searchJanny({
                    search: effectiveSearch,
                    page: jannyCurrentPage,
                    limit: 80,
                    sort: jannySortMode
                });
                if (thisToken !== jannyLoadToken || !delegatesInitialized) return;
                const moreResult = moreData?.results?.[0];
                let moreHits = moreResult?.hits || [];
                await jannyBrowseView.probeHits(moreHits);
                if (jannyPersistentExclude.length > 0) {
                    const lowerExclude = jannyPersistentExclude.map(t => t.toLowerCase());
                    moreHits = moreHits.filter(h => {
                        const names = resolveTagNames(h.tagIds).map(n => n.toLowerCase());
                        return !lowerExclude.some(et => names.includes(et));
                    });
                }
                if (activeRows.length > 0) moreHits = moreHits.filter(h => featurePasses(h, activeRows));
                hits = hits.concat(moreHits);
            }
            if (autoFetches > 0) {
                debugLog(`[JannyBrowse] Auto-fetched ${autoFetches} extra page(s) to compensate for "hide owned" filter`);
            }
        }

        if (append) {
            const existingIds = new Set(jannyCharacters.map(c => c.id));
            jannyCharacters = jannyCharacters.concat(hits.filter(h => !h.id || !existingIds.has(h.id)));
        } else {
            jannyCharacters = hits;
        }

        jannyHasMore = jannyCurrentPage < totalPages;

        renderGrid(jannyCharacters, append);

        if (!append && jannyCharacters.length === 0) {
            grid.innerHTML = `
                <div class="browse-empty-state">
                    <i class="fa-solid fa-ghost browse-empty-icon"></i>
                    <p class="browse-empty-title">No matches on JannyAI</p>
                    <p class="browse-empty-text">Try a different search term or relax your tag filters. JannyAI search is keyword-based, broad terms tend to surface more results.</p>
                </div>
            `;
        }

        debugLog('[JannyBrowse] Loaded', hits.length, 'characters, page', jannyCurrentPage, '/', totalPages);

    } catch (err) {
        if (thisToken !== jannyLoadToken) return;
        console.error('[JannyBrowse] Search error:', err);
        showToast(`JannyAI search failed: ${err.message}`, 'error');
        if (!append && grid) {
            renderBrowseError(grid, {
                provider: 'janny',
                error: err,
                message: `Search failed: ${err.message}`,
                flags: { nsfw: jannyNsfwEnabled },
                retry: () => jannyBrowseView.reload({ force: true }),
            });
        }
    } finally {
        if (thisToken === jannyLoadToken) {
            jannyIsLoading = false;
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

let jannyDetailFetchToken = 0;
let jannyDetailFetchPromise = null;
let jannyDetailController = null;

function openPreviewModal(hit) {
    jannySelectedChar = hit;

    const modal = document.getElementById('jannyCharModal');
    if (!modal) return;
    CoreAPI.resetBrowseSectionCollapseState(modal);

    const name = hit.name || 'Unknown';
    const avatarUrl = hit.avatar ? `${JANNY_IMAGE_BASE}${hit.avatar}` : '/img/no-portrait.png';
    const tags = resolveTagNames(hit.tagIds);
    const tokens = formatNumber(hit.totalToken || 0);
    const charId = hit.id || '';
    const jannyUrl = jannyCharacterUrl(charId, jannySlug(name));
    const createdDate = hit.createdAt
        ? new Date(hit.createdAt).toLocaleDateString()
        : (hit.createdAtStamp ? new Date(hit.createdAtStamp * 1000).toLocaleDateString() : '');

    // Header
    const avatarImg = document.getElementById('jannyCharAvatar');
    BrowseView.setPreviewPortrait(avatarImg, avatarUrl);
    document.getElementById('jannyCharName').textContent = name;
    document.getElementById('jannyCharCreator').textContent = hit.creatorUsername || hit.creatorId || 'Unknown';
    document.getElementById('jannyOpenInBrowserBtn').href = jannyUrl;

    // Stats
    document.getElementById('jannyCharTokens').textContent = tokens;
    document.getElementById('jannyCharDate').textContent = createdDate || 'Unknown';

    // Tags
    const tagsEl = document.getElementById('jannyCharTags');
    tagsEl.innerHTML = tags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
    requestAnimationFrame(() => applyTagsClamp(tagsEl));

    // Creator's Notes (website description - may include inline images from ella.janitorai.com)
    const rawDescription = hit.description || '';
    const creatorNotesSection = document.getElementById('jannyCharCreatorNotesSection');
    const creatorNotesEl = document.getElementById('jannyCharCreatorNotes');
    if (rawDescription.trim()) {
        creatorNotesSection.hidden = false;
        if (creatorNotesEl && !creatorNotesEl.querySelector('iframe')) creatorNotesEl.innerHTML = skeletonLines(3);
        deferCall(creatorNotesEl, () => renderCreatorNotesSecure(rawDescription, name, creatorNotesEl));
    } else {
        creatorNotesSection.hidden = true;
        if (creatorNotesEl) creatorNotesEl.innerHTML = '';
    }

    // Skeletons across all heavy sections during the fetchAndPopulate network wait.
    const descSection = document.getElementById('jannyCharDescriptionSection');
    const descEl = document.getElementById('jannyCharDescription');
    const scenarioSection = document.getElementById('jannyCharScenarioSection');
    const scenarioEl = document.getElementById('jannyCharScenario');
    const firstMsgSection = document.getElementById('jannyCharFirstMsgSection');
    const firstMsgEl = document.getElementById('jannyCharFirstMsg');
    const examplesSection = document.getElementById('jannyCharExamplesSection');
    const examplesEl = document.getElementById('jannyCharExamples');
    if (descSection && descEl) { descSection.hidden = false; descEl.innerHTML = skeletonLines(3); }
    if (scenarioSection && scenarioEl) { scenarioSection.hidden = false; scenarioEl.innerHTML = skeletonLines(2); }
    if (firstMsgSection && firstMsgEl) { firstMsgSection.hidden = false; firstMsgEl.innerHTML = skeletonLines(4); }
    if (examplesSection && examplesEl) { examplesSection.hidden = false; examplesEl.innerHTML = skeletonLines(3); }

    // Import button state, kept in step with the library while the preview is open
    const restampImport = () => {
        const inLibraryNow = view.isHitInLibrary(hit);
        view.stampImportButton(document.getElementById('jannyImportBtn'), { inLibrary: inLibraryNow, possibleMatch: !inLibraryNow && view.isCharPossibleMatch(hit.name || '', hit.creatorUsername || '') });
    };
    restampImport();
    view.trackPreview(restampImport, hit);

    modal.classList.remove('hidden');
    const charBody = modal.querySelector('.browse-char-body');
    if (charBody) charBody.scrollTop = 0;

    // details load in the background for Import to await; it rides the hosted browser, so a closed or swapped card aborts it
    const fetchToken = ++jannyDetailFetchToken;
    jannyDetailController?.abort();
    jannyDetailController = new AbortController();
    jannyDetailFetchPromise = fetchAndPopulateDetails(hit, fetchToken, jannyDetailController.signal);
}

async function fetchAndPopulateDetails(hit, token, signal = null) {
    const charId = hit.id || '';
    const name = hit.name || 'Unknown';

    try {
        const provider = CoreAPI.getProvider('jannyai');
        if (!provider) return;

        let charData = null;
        try {
            const data = await provider.fetchMetadata(jannyFullPath(charId, hit.name), { signal });
            if (data) charData = data;
        } catch (e) {
            console.warn('[JannyBrowse] Detail fetch failed:', e.message);
        }

        // Stale check - user may have opened a different card
        if (token !== jannyDetailFetchToken) return;

        if (!charData) {
            const descSection = document.getElementById('jannyCharDescriptionSection');
            const descEl = document.getElementById('jannyCharDescription');
            if (descSection && descEl) {
                descSection.hidden = false;
                descEl.innerHTML = hasBrowserEndpoint()
                    ? definitionFailedNotice('Under Settings, Online, JannyAI press Check jannyai.com to see what is failing. Importing now would save a card with no definition or greeting.', 'The Hosted Browser could not fetch this card\'s definition.')
                    : buildProviderNotice({
                        kind: 'info',
                        layout: 'cta',
                        message: 'JannyAI Cloudflare-gates card definitions, and only a real browser gets through.',
                        hint: 'Set up the Hosted Browser (Settings, Online). Importing without it would save a card with no definition or greeting.',
                    });
            }
            // the skeletons the open painted would shimmer under a message saying the load failed
            hideSections(['jannyCharScenarioSection', 'jannyCharFirstMsgSection', 'jannyCharExamplesSection']);
            return;
        }

        // Store full data on the selected char for import
        if (jannySelectedChar?.id === hit.id) {
            jannySelectedChar._fullData = charData;
        }

        // Update creator display with scraped username (MeiliSearch only has UUID)
        if (charData.creatorUsername && token === jannyDetailFetchToken) {
            const creatorEl = document.getElementById('jannyCharCreator');
            if (creatorEl) creatorEl.textContent = charData.creatorUsername;
            if (jannySelectedChar?.id === hit.id) {
                jannySelectedChar.creatorUsername = charData.creatorUsername;
            }
        }

        const personality = charData.personality || '';
        const scenario = charData.scenario || '';
        const firstMessage = charData.firstMessage || '';
        const exampleDialogs = charData.exampleDialogs || '';

        const descSection = document.getElementById('jannyCharDescriptionSection');
        const descEl = document.getElementById('jannyCharDescription');
        if (descSection) {
            if (personality) {
                descSection.hidden = false;
                if (descEl) deferCall(descEl, () => renderCardHtmlSecure(personality, name, descEl));
            } else {
                descSection.hidden = true;
            }
        }

        const scenarioSection = document.getElementById('jannyCharScenarioSection');
        const scenarioEl = document.getElementById('jannyCharScenario');
        if (scenarioSection && scenario) {
            scenarioSection.hidden = false;
            if (scenarioEl) deferRender(scenarioEl, () => safePurify(formatRichText(scenario, name, true), BROWSE_PURIFY_CONFIG));
        } else if (scenarioSection) {
            scenarioSection.hidden = true;
        }

        const firstMsgSection = document.getElementById('jannyCharFirstMsgSection');
        const firstMsgEl = document.getElementById('jannyCharFirstMsg');
        if (firstMsgSection && firstMessage) {
            firstMsgSection.hidden = false;
            if (firstMsgEl) {
                deferRender(firstMsgEl, () => safePurify(formatRichText(firstMessage, name, true), BROWSE_PURIFY_CONFIG));
                firstMsgEl.dataset.fullContent = firstMessage;
            }
        } else if (firstMsgSection) {
            firstMsgSection.hidden = true;
        }

        const examplesSection = document.getElementById('jannyCharExamplesSection');
        const examplesEl = document.getElementById('jannyCharExamples');
        if (examplesSection && exampleDialogs) {
            examplesSection.hidden = false;
            if (examplesEl) deferRender(examplesEl, () => safePurify(formatRichText(exampleDialogs, name, true), BROWSE_PURIFY_CONFIG));
        } else if (examplesSection) {
            examplesSection.hidden = true;
        }
    } catch (err) {
        debugLog('[JannyBrowse] Detail fetch error:', err);
        if (token === jannyDetailFetchToken) {
            const descEl = document.getElementById('jannyCharDescription');
            if (descEl) descEl.innerHTML = definitionFailedNotice('Importing now would save a card with no definition or greeting; retry before importing.');
        }
    }
}

function cleanupJannyCharModal() {
    BrowseView.closeAvatarViewer();
    CoreAPI.setBrowseAltGreetings(null);
    const creatorEl = document.getElementById('jannyCharCreator');
    if (creatorEl) creatorEl.textContent = '';
    const sectionIds = [
        'jannyCharDescription',
        'jannyCharScenario',
        'jannyCharFirstMsg',
        'jannyCharExamples',
        'jannyCharTags',
    ];
    for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }
    const notesEl = document.getElementById('jannyCharCreatorNotes');
    if (notesEl) cleanupCreatorNotesContainer(notesEl);
}

function closePreviewModal() {
    jannyDetailFetchToken++;
    jannyDetailController?.abort();
    jannyDetailController = null;
    jannyDetailFetchPromise = null;
    cleanupJannyCharModal();
    const modal = document.getElementById('jannyCharModal');
    if (modal) modal.classList.add('hidden');
    jannySelectedChar = null;
    view.trackPreview(null);
}

// ========================================
// IMPORT
// ========================================

async function importCharacter(charData) {
    if (!charData?.id) return;
    const charId = charData.id;
    const identifier = jannyFullPath(charId, charData.name);
    await view.importFromPreview({
        button: document.getElementById('jannyImportBtn'), hit: charData, provider: 'jannyai', id: identifier, label: 'JannyBrowse',
        closePreview: closePreviewModal,
        prepare: async () => {
            // Wait for the detail fetch to finish so _fullData is populated
            await jannyDetailFetchPromise;
            const fallbackData = charData._fullData || charData;
            if (!fallbackData.tagIds && charData.tagIds) fallbackData.tagIds = charData.tagIds;
            const charName = fallbackData.name || charData.name || '';
            const charCreator = charData.creatorUsername || fallbackData.creatorUsername || '';
            return {
                data: fallbackData,
                probe: {
                    name: charName, creator: charCreator, fullPath: identifier, providerId: 'jannyai', externalId: charId,
                    description: fallbackData.personality || fallbackData.description || '',
                    first_mes: fallbackData.firstMessage || '',
                    scenario: fallbackData.scenario || '',
                },
                dialog: { name: charName, creator: charCreator, fullPath: identifier, avatarUrl: charData.avatar ? `${JANNY_IMAGE_BASE}${charData.avatar}` : '/img/no-portrait.png' },
            };
        },
    });
}

// ========================================
// TAGS RENDERING
// ========================================

const ALL_TAGS = Object.entries(TAG_MAP)
    .map(([id, name]) => ({ id: Number(id), name }))
    .sort((a, b) => a.name.localeCompare(b.name));

function renderTagsList(filter = '') {
    const container = document.getElementById('jannyTagsList');
    if (!container) return;

    const filtered = filter
        ? ALL_TAGS.filter(t => t.name.toLowerCase().includes(filter.toLowerCase()))
        : ALL_TAGS;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    container.innerHTML = filtered.map(tag => {
        const included = jannyIncludeTags.has(tag.id);
        const stateClass = included ? 'state-include' : 'state-neutral';
        const stateIcon = included ? '<i class="fa-solid fa-plus"></i>' : '';
        const stateTitle = included ? 'Included (click to remove)' : 'Click to include';
        return `
            <div class="browse-tag-filter-item" data-tag-id="${tag.id}">
                <button class="browse-tag-state-btn ${stateClass}" title="${stateTitle}">${stateIcon}</button>
                <span class="tag-label">${escapeHtml(tag.name)}</span>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const tagId = Number(item.dataset.tagId);
        const stateBtn = item.querySelector('.browse-tag-state-btn');

        item.addEventListener('click', () => {
            if (jannyIncludeTags.has(tagId)) {
                jannyIncludeTags.delete(tagId);
            } else {
                jannyIncludeTags.add(tagId);
            }
            cycleTagState(stateBtn, jannyIncludeTags.has(tagId));
            updateJannyTagsButton();
            jannyBrowseView.reload();
        });
    });
}

function cycleTagState(btn, included) {
    btn.className = 'browse-tag-state-btn';
    if (included) {
        btn.classList.add('state-include');
        btn.innerHTML = '<i class="fa-solid fa-plus"></i>';
        btn.title = 'Included (click to remove)';
    } else {
        btn.classList.add('state-neutral');
        btn.innerHTML = '';
        btn.title = 'Click to include';
    }
}

function updateJannyTagsButton() {
    const btn = document.getElementById('jannyTagsBtn');
    if (!btn) return;

    const count = jannyIncludeTags.size;
    setFilterCount(btn, 'Tags', count);
}

function updateJannyFiltersButton() {
    const btn = document.getElementById('jannyFiltersBtn');
    if (!btn) return;

    const count = countActiveFeatures(JANNY_FEATURE_FILTERS, jannyFeatureState);
    setFilterCount(btn, 'Features', count);
}

// ========================================
// EVENT WIRING
// ========================================

let delegatesInitialized = false;
let modalEventsAttached = false;

function initJannyView() {
    jannyNsfwEnabled = getSetting('jannyNsfw') === true;

    if (delegatesInitialized) return;
    delegatesInitialized = true;

    const sortEl = document.getElementById('jannySortSelect');
    if (sortEl) CoreAPI.initCustomSelect(sortEl);

    // Grid card click → open preview (delegation)
    const grid = document.getElementById('jannyGrid');
    if (grid) {
        grid.addEventListener('click', (e) => {
            const authorLink = e.target.closest('.browse-card-creator-link');
            if (authorLink) {
                e.stopPropagation();
                const author = authorLink.dataset.author;
                if (author) filterByAuthor(author);
                return;
            }

            const card = e.target.closest('.browse-card');
            if (!card) return;
            const charId = card.dataset.jannyId;
            if (!charId) return;
            const hit = jannyCharacters.find(c => String(c.id) === charId);
            if (hit) openPreviewModal(hit);
        });
    }

    // Search
    on('jannySearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doSearch();
        }
    });
    on('jannySearchInput', 'input', (e) => {
        const clearBtn = document.getElementById('jannyClearSearchBtn');
        if (clearBtn) clearBtn.classList.toggle('hidden', !e.target.value.trim());
    });
    on('jannySearchBtn', 'click', () => doSearch());
    on('jannyClearSearchBtn', 'click', () => {
        // the restore re-shows the pre-scope term, so leave the scope before clearing
        if (jannyAuthorFilter) jannyBrowseView.clearCreatorScope({ reload: false });
        const input = document.getElementById('jannySearchInput');
        const clearBtn = document.getElementById('jannyClearSearchBtn');
        if (input) input.value = '';
        if (clearBtn) clearBtn.classList.add('hidden');
        jannyCurrentSearch = '';
        jannyBrowseView.reload();
    });

    // Load More
    on('jannyLoadMoreBtn', 'click', () => {
        jannyBrowseView.reload({ append: true });
    });

    // NSFW toggle
    on('jannyNsfwToggle', 'click', () => {
        jannyNsfwEnabled = !jannyNsfwEnabled;
        setSetting('jannyNsfw', jannyNsfwEnabled);
        updateNsfwToggleButton('jannyNsfwToggle', jannyNsfwEnabled);
        jannyBrowseView.reload();
    });
    updateNsfwToggleButton('jannyNsfwToggle', jannyNsfwEnabled);

    // Sort mode
    on('jannySortSelect', 'change', () => {
        const el = document.getElementById('jannySortSelect');
        if (el) jannySortMode = el.value;

        // Sync search input if user typed without pressing Enter
        const input = document.getElementById('jannySearchInput');
        if (input) jannyCurrentSearch = input.value.trim();

        jannyBrowseView.reload();
    });

    // Author filter banner
    on('jannyClearAuthorBtn', 'click', () => clearAuthorFilter());

    // Refresh
    on('jannyRefreshBtn', 'click', () => jannyBrowseView.reload({ force: true }));

    // Tags dropdown
    const tagsDropdown = document.getElementById('jannyTagsDropdown');

    on('jannyTagsBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns('jannyTagsDropdown');
        if (filtersDropdown) filtersDropdown.classList.add('hidden');
        if (tagsDropdown) tagsDropdown.classList.toggle('hidden');
    });

    if (tagsDropdown) tagsDropdown.addEventListener('click', (e) => e.stopPropagation());

    renderTagsList();

    const tagSearchInput = document.getElementById('jannyTagsSearchInput');
    if (tagSearchInput) {
        const debouncedFilter = debounce((val) => renderTagsList(val), 200);
        tagSearchInput.addEventListener('input', () => debouncedFilter(tagSearchInput.value));
    }

    on('jannyTagsClearBtn', 'click', () => {
        jannyIncludeTags.clear();
        renderTagsList(document.getElementById('jannyTagsSearchInput')?.value || '');
        updateJannyTagsButton();
        jannyBrowseView.reload();
    });

    // Min/Max tokens
    const tokenDebounce = debounce(() => jannyBrowseView.reload(), 500);

    on('jannyMinTokens', 'change', () => {
        const el = document.getElementById('jannyMinTokens');
        if (el) jannyMinTokens = parseInt(el.value, 10) || 0;
        tokenDebounce();
    });
    on('jannyMaxTokens', 'change', () => {
        const el = document.getElementById('jannyMaxTokens');
        if (el) jannyMaxTokens = parseInt(el.value, 10) || 100000;
        tokenDebounce();
    });

    // Features dropdown
    const filtersDropdown = document.getElementById('jannyFiltersDropdown');

    on('jannyFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns('jannyFiltersDropdown');
        if (tagsDropdown) tagsDropdown.classList.add('hidden');
        if (filtersDropdown) filtersDropdown.classList.toggle('hidden');
    });

    if (filtersDropdown) filtersDropdown.addEventListener('click', (e) => e.stopPropagation());

    jannyBrowseView.wireFeatureFilters(JANNY_FEATURE_FILTERS, jannyFeatureState, () => {
        jannyBrowseView.reload();
    }, { badge: updateJannyFiltersButton });

    jannyBrowseView._registerDropdownDismiss([
        { dropdownId: 'jannyTagsDropdown', buttonId: 'jannyTagsBtn' },
        { dropdownId: 'jannyFiltersDropdown', buttonId: 'jannyFiltersBtn' }
    ]);

    // Preview modal events (only attach once - modal DOM persists across provider switches)
    if (!modalEventsAttached) {
        modalEventsAttached = true;

        const jannyOverlay = document.getElementById('jannyCharModal');
        BrowseView.wireTitleScroll(document.getElementById('jannyCharName'), jannyOverlay, jannyOverlay?.querySelector('.browse-char-modal'));

        on('jannyCharClose', 'click', () => closePreviewModal());

        const creatorLink = document.getElementById('jannyCharCreator');
        if (creatorLink) {
            creatorLink.addEventListener('click', (e) => {
                e.preventDefault();
                const name = creatorLink.textContent.trim();
                if (name && name !== 'Unknown') {
                    closePreviewModal();
                    filterByAuthor(name);
                }
            });
        }

        // Avatar click → full-size image viewer (desktop only at event time; on mobile
        // bail before stopPropagation so the delegated tap runs)
        const jannyAvatar = document.getElementById('jannyCharAvatar');
        if (jannyAvatar) {
            jannyAvatar.addEventListener('click', (e) => {
                if (isMobileMode()) return;
                e.stopPropagation();
                if (!jannyAvatar.src || jannyAvatar.src.endsWith('/img/no-portrait.png')) return;
                BrowseView.openAvatarViewer(jannyAvatar.src);
            });
        }

        on('jannyImportBtn', 'click', () => {
            if (jannySelectedChar) importCharacter(jannySelectedChar);
        });

        const modalOverlay = document.getElementById('jannyCharModal');
        if (modalOverlay) {
            modalOverlay.addEventListener('click', (e) => {
                if (e.target === modalOverlay) closePreviewModal();
            });
        }

        window.registerOverlay?.({ id: 'jannyCharModal', tier: 7, close: () => closePreviewModal() });
        window.registerOverlay?.({ id: 'jannyAuthorBanner', tier: 9, close: () => clearAuthorFilter() });
    }
}

function doSearch() {
    const input = document.getElementById('jannySearchInput');
    const clearBtn = document.getElementById('jannyClearSearchBtn');
    const val = (input?.value || '').trim();

    // a typed search leaves the scope; the restore lands first so the relevance
    // flip below decides against the pre-scope sort, not the forced one
    if (jannyAuthorFilter) jannyBrowseView.clearCreatorScope({ reload: false });

    jannyCurrentSearch = val;

    if (clearBtn) {
        clearBtn.classList.toggle('hidden', !val);
    }

    // When searching with text, default to relevance sort
    const sortSelect = document.getElementById('jannySortSelect');
    if (val && sortSelect && jannySortMode === 'newest') {
        jannySortMode = 'relevant';
        sortSelect.value = 'relevant';
    }

    jannyBrowseView.reload();
}

// the author name is the search term (relevance ranks them first); the stash restores term and sort on exit
function filterByAuthor(authorName) {
    jannyBrowseView.enterCreatorScope(() => {
        jannyAuthorFilter = authorName;
        view._cdRef = { creatorName: authorName };
        jannyCurrentSearch = '';
        jannySortMode = 'relevant';

        const sortSelect = document.getElementById('jannySortSelect');
        if (sortSelect) sortSelect.value = 'relevant';

        const searchInput = document.getElementById('jannySearchInput');
        if (searchInput) searchInput.value = '';
        const clearBtn = document.getElementById('jannyClearSearchBtn');
        if (clearBtn) clearBtn.classList.add('hidden');

        const bannerName = document.getElementById('jannyAuthorBannerName');
        if (bannerName) bannerName.textContent = authorName;
        window.pushOverlayGuard?.();
    });
}

function clearAuthorFilter() {
    jannyBrowseView.clearCreatorScope();
}

// ========================================
// BROWSE VIEW CLASS
// ========================================

class JannyBrowseView extends BrowseView {

    constructor(provider) {
        super(provider);
        view = this;
    }

    hitMatchName(hit) {
        return { name: hit.name || '', creator: hit.creatorUsername || '' };
    }

    hitLinkKey(hit) {
        return hit?.id ? String(hit.id) : null;
    }

    get previewModalId() { return 'jannyCharModal'; }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'newest', label: 'Newest' },
                { value: 'oldest', label: 'Oldest' },
                { value: 'tokens_desc', label: 'Most Tokens' },
                { value: 'tokens_asc', label: 'Least Tokens' },
            ],
            followingSortOptions: [],
            viewModes: [],
        };
    }

    closePreview() {
        closePreviewModal();
    }

    get mobileFilterIds() {
        return {
            sort: 'jannySortSelect',
            tags: 'jannyTagsBtn',
            filters: 'jannyFiltersBtn',
            nsfw: 'jannyNsfwToggle',
            refresh: 'jannyRefreshBtn'
        };
    }

    // Filter Bar

    renderFilterBar() {
        return `
            <!-- Sort -->
            <div class="browse-sort-container">
                <select id="jannySortSelect" class="glass-select" title="Sort order">
                    <optgroup label="Date">
                        <option value="newest" data-icon="fa-solid fa-calendar-plus" ${jannySortMode === 'newest' ? 'selected' : ''}>Newest</option>
                        <option value="oldest" data-icon="fa-solid fa-hourglass" ${jannySortMode === 'oldest' ? 'selected' : ''}>Oldest</option>
                    </optgroup>
                    <optgroup label="Tokens">
                        <option value="tokens_desc" data-icon="fa-solid fa-weight-hanging" ${jannySortMode === 'tokens_desc' ? 'selected' : ''}>Most Tokens</option>
                        <option value="tokens_asc" data-icon="fa-solid fa-feather" ${jannySortMode === 'tokens_asc' ? 'selected' : ''}>Least Tokens</option>
                    </optgroup>
                    <optgroup label="Search">
                        <option value="relevant" data-icon="fa-solid fa-magnifying-glass" ${jannySortMode === 'relevant' ? 'selected' : ''}>Relevance</option>
                    </optgroup>
                </select>
            </div>

            <!-- Tags & Advanced Filters -->
            <div class="browse-tags-dropdown-container u-relative">
                <button id="jannyTagsBtn" class="glass-btn" title="Tag filters and advanced options">
                    <i class="fa-solid fa-tags"></i> <span id="jannyTagsBtnLabel">Tags</span>
                </button>
                <div id="jannyTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="jannyTagsSearchInput" placeholder="Search tags..." autocomplete="one-time-code">
                        <button id="jannyTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="jannyTagsList"></div>
                    <hr class="browse-filter-divider">
                    <div class="dropdown-section-title"><i class="fa-solid fa-gear"></i> Advanced Options</div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Min Tokens</label>
                        <input type="number" id="jannyMinTokens" class="glass-input-small" value="${jannyMinTokens}" min="0" max="100000" step="100">
                    </div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Max Tokens</label>
                        <input type="number" id="jannyMaxTokens" class="glass-input-small" value="${jannyMaxTokens}" min="0" max="500000" step="1000">
                    </div>
                </div>
            </div>

            <!-- Feature Filters -->
            <div class="browse-more-filters u-relative">
                <button id="jannyFiltersBtn" class="glass-btn" title="Additional filters">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="jannyFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden">
                    ${renderFeatureFilterItems(JANNY_FILTER_SECTIONS, JANNY_FEATURE_FILTERS)}
                </div>
            </div>

            <!-- NSFW toggle -->
            <button id="jannyNsfwToggle" class="glass-btn nsfw-toggle" title="Toggle NSFW content">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Refresh -->
            <button id="jannyRefreshBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // Main View

    renderView() {
        return `
            <div id="jannyBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="jannySearchInput" placeholder="Search JannyAI characters..." autocomplete="one-time-code">
                        <button id="jannyClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="jannySearchBtn" class="browse-search-submit" aria-label="Search">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                </div>

                <!-- Author Filter Banner -->
                <div id="jannyAuthorBanner" class="browse-author-banner hidden">
                    <div class="browse-author-banner-content">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <span>Searching for <strong id="jannyAuthorBannerName">Author</strong> <span class="browse-author-banner-hint">(keyword search, may include unrelated results)</span></span>
                    </div>
                    <div class="browse-author-banner-actions">
                        <button id="jannyClearAuthorBtn" class="glass-btn icon-only" title="Clear author filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Results Grid -->
                <div id="jannyGrid" class="browse-grid"></div>

                <!-- Load More -->
                <div class="browse-load-more" id="jannyLoadMore" hidden>
                    <button id="jannyLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    // Modals

    renderModals() {
        return `
    <div id="jannyCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="jannyCharAvatar" src="/img/no-portrait.png" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="jannyCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="jannyCharCreator" href="#" class="creator-link browse-meta-identity" title="Click to see all characters by this author">Creator</a>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="jannyOpenInBrowserBtn" href="#" target="_blank" class="cl-btn cl-btn-secondary" title="Open on JannyAI">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="jannyImportBtn" class="cl-btn cl-btn-primary" title="Import into your library">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="jannyCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-message"></i>
                            <span id="jannyCharTokens">0</span> tokens
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="jannyCharDate">Unknown</span>
                        </div>
                    </div>
                    <div class="browse-char-tags" id="jannyCharTags"></div>
                </div>

                <!-- Creator's Notes (website description, may contain images) -->
                <div class="browse-char-section" id="jannyCharCreatorNotesSection" hidden>
                    <h3 class="browse-section-title" data-section="jannyCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="jannyCharCreatorNotes" class="scrolling-text"></div>
                </div>

                <!-- Description (personality field) -->
                <div class="browse-char-section" id="jannyCharDescriptionSection" hidden>
                    <h3 class="browse-section-title" data-section="jannyCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="jannyCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Scenario -->
                <div class="browse-char-section" id="jannyCharScenarioSection" hidden>
                    <h3 class="browse-section-title" data-section="jannyCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="jannyCharScenario" class="scrolling-text"></div>
                </div>

                <!-- Example Dialogs -->
                <div class="browse-char-section browse-section-collapsed" id="jannyCharExamplesSection" hidden>
                    <h3 class="browse-section-title" data-section="jannyCharExamples" data-label="Example Dialogs" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Dialogs
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="jannyCharExamples" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="jannyCharFirstMsgSection" hidden>
                    <h3 class="browse-section-title" data-section="jannyCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="jannyCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // Lifecycle

    _getImageGridIds() { return ['jannyGrid']; }

    canLoadMore() { return jannyHasMore && !jannyIsLoading; }

    init() {
        super.init();
        initJannyView();
        const grid = document.getElementById('jannyGrid');
        if (grid) this.observeImages(grid);
        // No initial load here: init() runs before applyDefaults(), so the base's
        // migrated activation arm issues it (and builds the library lookup first).
    }

    getSearchInputId(mode) {
        return mode === 'character' ? 'jannySearchInput' : null;
    }

    applyDefaults(defaults) {
        super.applyDefaults(defaults);
        if (defaults.sort) {
            jannySortMode = defaults.sort;
            const el = document.getElementById('jannySortSelect');
            if (el) el.value = defaults.sort;
        }
    }

    // Activation hooks

    resetSessionState() {
        jannyCurrentSearch = '';
        jannyAuthorFilter = null;
        jannyCharacters = [];
        jannyCurrentPage = 1;
        jannyHasMore = true;
        jannyIsLoading = false;
        jannyGridRenderedCount = 0;
        jannySelectedChar = null;
    }

    loadInitial(opts = {}) {
        if (opts.append) {
            jannyCurrentPage++;
            loadCharacters(true);
            return;
        }
        jannyCurrentPage = 1;
        loadCharacters(false);
    }

    // The author name rides the search term, so the one loader already lands in scope;
    // the stash keeps the term and sort the entry overwrites.
    get creatorScope() {
        return {
            bannerId: 'jannyAuthorBanner',
            isActive: () => !!jannyAuthorFilter,
            load: (opts) => this.loadInitial(opts),
            clear: () => {
                jannyAuthorFilter = null;
                jannyCharacters = [];
            },
            stash: () => ({ search: jannyCurrentSearch, sort: jannySortMode }),
            restore: (s) => {
                jannyCurrentSearch = s.search;
                jannySortMode = s.sort;
                const input = document.getElementById('jannySearchInput');
                if (input) input.value = s.search;
                document.getElementById('jannyClearSearchBtn')?.classList.toggle('hidden', !s.search);
                const sortSelect = document.getElementById('jannySortSelect');
                if (sortSelect) sortSelect.value = s.sort;
            },
        };
    }

    hasData() { return jannyCharacters.length > 0; }

    rerenderGrid() {
        jannyGridRenderedCount = 0;
        renderGrid(jannyCharacters, false);
    }

    get gridElementId() { return 'jannyGrid'; }

    onActivated(isReEntry) {
        if (isReEntry) delegatesInitialized = true;
        // browsing rides MeiliSearch (CORS-open); the browser's warm page clears Cloudflare on first card open, so no warm-up
    }

    deactivate() {
        jannyDetailFetchToken++;
        // the token only discards the answer; the browser leg would run on for nobody
        jannyDetailController?.abort();
        jannyDetailController = null;
        delegatesInitialized = false;
        super.deactivate();
    }
}

const jannyBrowseView = new JannyBrowseView(null);

// Expose for library.js to call from viewOnProvider (linked character preview)
window.openJannyCharPreview = function(hit) {
    openPreviewModal(hit);
};

export default jannyBrowseView;

// ========================================
// CREATOR DOWNLOADS ADAPTER
// ========================================

registerCdAdapter('jannyai', {
    async fetchAll(view) {
        const authorName = view._cdRef?.creatorName;
        if (!authorName) return [];
        const wanted = authorName.toLowerCase();
        const nsfw = CoreAPI.getSetting('jannyNsfw') === true;
        const results = [];
        const seen = new Set();
        const MAX_PAGES = 50;
        for (let page = 1; page <= MAX_PAGES; page++) {
            const data = await meiliMultiSearch({
                search: authorName,
                page,
                filters: nsfw ? [] : ['isNsfw = false'],
            });
            const result = data?.results?.[0];
            const hits = result?.hits || [];
            for (const hit of hits) {
                if (!hit.id || seen.has(String(hit.id))) continue;
                // author view is a text search; keep exact creator matches only
                if ((hit.creatorUsername || '').toLowerCase() !== wanted) continue;
                seen.add(String(hit.id));
                results.push({ key: String(hit.id), name: hit.name || '', creator: hit.creatorUsername || '', raw: hit });
            }
            const totalPages = result?.totalPages || 1;
            if (page >= totalPages || hits.length === 0) break;
        }
        return results;
    },
    async importOne(view, card) {
        const provider = CoreAPI.getProvider('jannyai');
        if (!provider?.importCharacter) return { ok: false, error: 'Provider not available' };
        const hit = card.raw;
        const identifier = jannyFullPath(hit.id, hit.name);
        const result = await importThroughCommand(provider, identifier, hit, {});
        if (!result.success) return { ok: false, error: result.error || 'Import failed' };
        return view.creatorImportAnswer(result, provider);
    },
});
