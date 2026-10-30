// ChartavernBrowseView - CharacterTavern browse/search UI for the Online tab

import {
    BrowseView, registerCdAdapter, featureFilterState, renderFeatureFilterItems, countActiveFeatures,
    browseCardImageWidth, activeFeatureRows, featurePasses, featureBadgesHtml, applyTagsClamp, updateTagStateButton, cardTagsHtml,
    tagStateButtonHtml, libraryFeatureRows, libraryBadgeHtml, libraryCardClass, renderAltGreetingsList,
} from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber, BROWSE_PURIFY_CONFIG, skeletonLines, deferRender, deferCall, isMobileMode, importThroughCommand, renderBrowseError, definitionFailedNotice } from '../provider-utils.js';
import {
    searchCards,
    fetchCharacterDetail,
    fetchTopTags,
    getAvatarUrl,
    getCharacterPageUrl,
    stripHtml,
    parseTags,
    checkCtPluginAvailable,
    checkCtSession,
    ctSetCookie,
    ctValidateSession,
    ctLogout,
    isCtSessionActive,
    getCtCharName,
} from './chartavern-api.js';

const {
    onElement: on,
    showToast,
    escapeHtml,
    safePurify,
    debugLog,
    getSetting,
    setSetting,
    formatRichText,
    debounce,
    apiRequest,
    cleanupCreatorNotesContainer,
    renderCreatorNotesSecure,
    renderCardHtmlSecure,
    renderLoadingState,
    renderSkeletonGrid,
} = CoreAPI;

// ========================================
// STATE
// ========================================

let ctCharacters = [];
let ctCurrentPage = 1;
let ctTotalPages = 1;
let ctHasMore = true;
let ctIsLoading = false;
let ctCurrentSearch = '';
let ctAuthorFilter = null;
let ctSessionChecked = false;
let ctNsfwEnabled = false;
let ctNsfwWarnedThisSession = false;
let ctSortMode = 'most_popular';
let ctSelectedChar = null;
let ctGridRenderedCount = 0;
let ctLoadToken = 0; // Generation counter for search requests

// Auth state
let ctPluginAvailable = false;
let ctLoginInProgress = false;

// hasLorebook and isOC are server-side and carry the nodeTest their badges share, so filter and badge cant drift
const CT_FEATURE_FILTERS = [
    { key: 'hasLorebook', id: 'ctFilterHasLorebook', section: 'must', icon: 'fa-book', label: 'Lorebook',
      nodeTest: (c) => !!c.hasLorebook,
      badge: { cls: '', title: 'Has Lorebook', icon: 'fa-book' } },
    { key: 'isOC', id: 'ctFilterIsOC', section: 'must', icon: 'fa-star', label: 'Original Character',
      nodeTest: (c) => !!c.isOC,
      badge: { cls: '', title: 'Original Character', icon: 'fa-star' } },
    ...libraryFeatureRows('ct', () => view, isCharPossibleMatchObj),
];
const ctFeatureState = featureFilterState(CT_FEATURE_FILTERS);

const CT_FILTER_SECTIONS = [
    { key: 'must', title: 'Character must have:' },
    { key: 'library', title: 'Library:' },
];

// Filter state
let ctMinTokens = 0;
let ctMaxTokens = 0;

// Tag filter state
/** @type {Set<string>} Active include tags */
let ctIncludeTags = new Set();
/** @type {Set<string>} Active exclude tags */
let ctExcludeTags = new Set();

// Cached top tags from API
let ctTopTags = [];
let ctTopTagsFetched = false;

let view; // module-scoped BrowseView instance reference (set once in constructor)

// ========================================
// LOCAL LIBRARY LOOKUP
// ========================================

function isCharPossibleMatchObj(h) {
    if (view.isHitInLibrary(h)) return false;
    return view.isCharPossibleMatch(getCtCharName(h), h.author_username || h.author || h.path?.split('/')[0] || '');
}

// ========================================
// CARD RENDERING
// ========================================

function createCtCard(hit) {
    const name = hit.name || 'Unknown';
    const desc = stripHtml(hit.tagline || hit.pageDescription || '');
    const avatarUrl = hit.path ? getAvatarUrl(hit.path, { width: browseCardImageWidth() }) : '/img/no-portrait.png';
    const tags = parseTags(hit.tags);
    const tokens = formatNumber(hit.totalTokens || 0);
    const author = hit.author || hit.path?.split('/')[0] || '';
    const inLibrary = view.isHitInLibrary(hit);
    const possibleTier = inLibrary ? null : view.getPossibleMatchTier(getCtCharName(hit), author);

    const badges = [];
    const importing = view.importingBadge(hit);
    if (importing) badges.push(importing);
    const libraryBadge = libraryBadgeHtml(inLibrary, possibleTier);
    if (libraryBadge) badges.push(libraryBadge);
    badges.push(...featureBadgesHtml(hit, CT_FEATURE_FILTERS));

    const createdDate = hit.createdAt
        ? new Date(hit.createdAt * 1000).toLocaleDateString()
        : '';
    const dateInfo = createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';

    const cardClass = libraryCardClass(inLibrary, possibleTier);

    return `
        <div class="${cardClass}" data-ct-path="${escapeHtml(hit.path || '')}"${view.linkKeyAttr(hit)} data-match-name="${escapeHtml(getCtCharName(hit))}" ${desc ? `title="${escapeHtml(desc)}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/no-portrait.png'">
                ${hit.isNSFW ? '<span class="browse-nsfw-badge">NSFW</span>' : ''}
                ${badges.length > 0 ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                ${author ? `<span class="browse-card-creator-link" data-author="${escapeHtml(author)}" title="Click to see all characters by ${escapeHtml(author)}">${escapeHtml(author)}</span>` : ''}
                ${cardTagsHtml(tags)}
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Tokens"><i class="fa-solid fa-font"></i> ${tokens}</span>
                <span class="browse-card-stat" title="Downloads"><i class="fa-solid fa-download"></i> ${formatNumber(hit.downloads || 0)}</span>
                <span class="browse-card-stat" title="Likes"><i class="fa-solid fa-heart"></i> ${formatNumber(hit.likes || 0)}</span>
                ${dateInfo}
            </div>
        </div>
    `;
}

function observeNewCards(startIdx) {
    const grid = document.getElementById('ctGrid');
    if (!grid) return;
    chartavernBrowseView.observeImages(grid);
}

// ========================================
// GRID RENDERING
// ========================================

function renderGrid(characters, append = false) {
    const grid = document.getElementById('ctGrid');
    if (!grid) return;

    if (!append) {
        grid.innerHTML = '';
        ctGridRenderedCount = 0;
    }

    const startIdx = ctGridRenderedCount;
    const html = characters.slice(startIdx).map(c => createCtCard(c)).join('');
    grid.insertAdjacentHTML('beforeend', html);
    ctGridRenderedCount = characters.length;

    observeNewCards(startIdx);
    updateLoadMore();
}

function updateLoadMore() {
    chartavernBrowseView.updateLoadMoreVisibility('ctLoadMore', ctHasMore, ctCharacters.length > 0);
}

// ========================================
// SEARCH / LOAD
// ========================================

async function loadCharacters(append = false) {
    if (append && ctIsLoading) return;

    // Concurrency control: prevent stale responses from overwriting newer ones
    const thisToken = ++ctLoadToken;
    ctIsLoading = true;

    const grid = document.getElementById('ctGrid');
    const loadMoreBtn = document.getElementById('ctLoadMoreBtn');

    if (!append && grid) {
        renderSkeletonGrid(grid);
    }

    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        const opts = {
            query: ctAuthorFilter || ctCurrentSearch,
            sort: ctSortMode,
            page: ctCurrentPage,
            limit: 60,
            nsfw: ctNsfwEnabled
        };

        if (ctIncludeTags.size > 0) opts.tags = [...ctIncludeTags].join(',');
        const ctMergedExclude = [...ctExcludeTags];
        for (const t of view.persistentExcludeTags()) {
            if (!ctMergedExclude.includes(t)) ctMergedExclude.push(t);
        }
        if (ctMergedExclude.length > 0) opts.excludeTags = ctMergedExclude.join(',');
        if (ctMinTokens > 0) opts.minimumTokens = ctMinTokens;
        if (ctMaxTokens > 0) opts.maximumTokens = ctMaxTokens;
        if (ctFeatureState.hasLorebook) opts.hasLorebook = true;
        if (ctFeatureState.isOC) opts.isOC = true;

        const data = await searchCards(opts, apiRequest);

        // Stale response check
        if (thisToken !== ctLoadToken) return;

        // Provider was deactivated during the fetch
        if (!delegatesInitialized) return;

        let hits = data?.hits || [];
        await chartavernBrowseView.probeHits(hits);
        ctTotalPages = data?.totalPages || 1;

        // Client-side: filter NSFW when toggle is off (exclude_tags alone doesn't catch all isNSFW cards)
        if (!ctNsfwEnabled) {
            hits = hits.filter(h => !h.isNSFW);
        }

        // Client-side: required features plus hide owned / possible match characters
        const activeRows = activeFeatureRows(CT_FEATURE_FILTERS, ctFeatureState);
        if (activeRows.length > 0) {
            hits = hits.filter(h => featurePasses(h, activeRows));
        }

        // Auto-fetch when client-side filters remove too many results
        const hasClientFilters = activeRows.length > 0 || !ctNsfwEnabled;
        if (hasClientFilters && ctCurrentPage < ctTotalPages) {
            let autoFetches = 0;
            while (hits.length < 60 && ctCurrentPage < ctTotalPages && autoFetches < 3 && delegatesInitialized) {
                autoFetches++;
                ctCurrentPage++;
                opts.page = ctCurrentPage;
                const moreData = await searchCards(opts, apiRequest);
                if (thisToken !== ctLoadToken || !delegatesInitialized) return;
                let moreHits = moreData?.hits || [];
                await chartavernBrowseView.probeHits(moreHits);
                if (!ctNsfwEnabled) moreHits = moreHits.filter(h => !h.isNSFW);
                if (activeRows.length > 0) moreHits = moreHits.filter(h => featurePasses(h, activeRows));
                hits = hits.concat(moreHits);
            }
            if (autoFetches > 0) {
                debugLog(`[CTBrowse] Auto-fetched ${autoFetches} extra page(s) to compensate for client-side filters`);
            }
        }

        if (append) {
            const existingPaths = new Set(ctCharacters.map(c => c.path));
            ctCharacters = ctCharacters.concat(hits.filter(h => !h.path || !existingPaths.has(h.path)));
        } else {
            ctCharacters = hits;
        }

        ctHasMore = ctCurrentPage < ctTotalPages;

        renderGrid(ctCharacters, append);

        if (!append && ctCharacters.length === 0) {
            grid.innerHTML = `
                <div class="browse-empty-state">
                    <i class="fa-solid fa-search browse-empty-icon"></i>
                    <p class="u-mt-md">No characters found</p>
                </div>
            `;
        }

        debugLog('[CTBrowse] Loaded', hits.length, 'characters, page', ctCurrentPage, '/', ctTotalPages);

    } catch (err) {
        if (thisToken !== ctLoadToken) return;

        console.error('[CTBrowse] Search error:', err);
        showToast(`CharacterTavern search failed: ${err.message}`, 'error');
        if (!append && grid) {
            renderBrowseError(grid, {
                provider: 'chartavern',
                error: err,
                message: `Search failed: ${err.message}`,
                flags: { nsfw: ctNsfwEnabled },
                retry: () => chartavernBrowseView.reload({ force: true }),
            });
        }
    } finally {
        if (thisToken === ctLoadToken) {
            ctIsLoading = false;
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

let ctDetailFetchToken = 0;

function openPreviewModal(hit) {
    ctSelectedChar = hit;

    const modal = document.getElementById('ctCharModal');
    if (!modal) return;
    CoreAPI.resetBrowseSectionCollapseState(modal);

    const name = hit.name || 'Unknown';
    const rawAuthor = hit.author || hit.path?.split('/')[0] || '';
    const author = rawAuthor || 'Unknown';
    const avatarUrl = hit.path ? getAvatarUrl(hit.path) : '/img/no-portrait.png';
    const ctUrl = hit.path ? getCharacterPageUrl(hit.path) : '#';

    let charDef = '';

    try {
        const tagline = stripHtml(hit.tagline || '');
        const creatorNotes = hit.pageDescription || '';
        const tags = parseTags(hit.tags);
        const tokens = formatNumber(hit.totalTokens || 0);
        const downloads = formatNumber(hit.downloads || 0);
        const likes = formatNumber(hit.likes || 0);

        const createdDate = hit.createdAt
            ? new Date(hit.createdAt * 1000).toLocaleDateString()
            : '';

        // Header
        const avatarImg = document.getElementById('ctCharAvatar');
        if (avatarImg) {
            BrowseView.setPreviewPortrait(avatarImg, avatarUrl);
        }
        const nameEl = document.getElementById('ctCharName');
        if (nameEl) nameEl.textContent = name;
        const creatorEl = document.getElementById('ctCharCreator');
        if (creatorEl) {
            creatorEl.textContent = author;
            creatorEl.href = '#';
            creatorEl.title = `Click to see all characters by ${author}`;
            creatorEl.onclick = (e) => {
                e.preventDefault();
                if (!rawAuthor) {
                    showToast('No creator is listed for this character', 'info');
                    return;
                }
                filterByAuthor(author);
            };
        }
        const openBtn = document.getElementById('ctOpenInBrowserBtn');
        if (openBtn) openBtn.href = ctUrl;

        // Tagline (above meta grid, no section header - matches Chub pattern)
        const taglineSection = document.getElementById('ctCharTaglineSection');
        const taglineEl = document.getElementById('ctCharTagline');
        if (taglineSection) {
            if (tagline) {
                taglineSection.hidden = false;
                if (taglineEl) taglineEl.textContent = tagline;
            } else {
                taglineSection.hidden = true;
            }
        }

        // Stats
        const tokensEl = document.getElementById('ctCharTokens');
        if (tokensEl) tokensEl.textContent = tokens;
        const downloadsEl = document.getElementById('ctCharDownloads');
        if (downloadsEl) downloadsEl.textContent = downloads;
        const likesEl = document.getElementById('ctCharLikes');
        if (likesEl) likesEl.textContent = likes;
        const dateEl = document.getElementById('ctCharDate');
        if (dateEl) dateEl.textContent = createdDate || 'Unknown';

        const altGreetings = Array.isArray(hit.alternativeFirstMessage) ? hit.alternativeFirstMessage.filter(Boolean) : [];
        renderAltGreetingsList('ct', altGreetings, name);

        // Lorebook stat
        const lorebookStat = document.getElementById('ctCharLorebookStat');
        if (lorebookStat) {
            lorebookStat.hidden = !hit.hasLorebook;
        }

        // Tags
        const tagsEl = document.getElementById('ctCharTags');
        if (tagsEl) {
            tagsEl.innerHTML = tags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
            requestAnimationFrame(() => applyTagsClamp(tagsEl));
        }

        // Skeletons sync, safePurify pipeline RAF-deferred so it doesnt block the modal-open paint.
        const creatorNotesSection = document.getElementById('ctCharCreatorNotesSection');
        const creatorNotesEl = document.getElementById('ctCharCreatorNotes');
        const descSection = document.getElementById('ctCharDescriptionSection');
        const descEl = document.getElementById('ctCharDescription');
        const scenarioSection = document.getElementById('ctCharScenarioSection');
        const scenarioEl = document.getElementById('ctCharScenario');
        const firstMsgSection = document.getElementById('ctCharFirstMsgSection');
        const firstMsgEl = document.getElementById('ctCharFirstMsg');
        charDef = hit.characterDefinition || '';
        const scenario = hit.characterScenario || '';
        const firstMsg = hit.characterFirstMessage || '';
        if (creatorNotesSection && creatorNotesEl) {
            if (creatorNotes && creatorNotes.trim()) {
                creatorNotesSection.hidden = false;
                if (!creatorNotesEl.querySelector('iframe')) creatorNotesEl.innerHTML = skeletonLines(3);
            } else {
                creatorNotesSection.hidden = true;
                cleanupCreatorNotesContainer(creatorNotesEl);
                creatorNotesEl.innerHTML = '';
            }
        }
        if (descSection && descEl) { descSection.hidden = false; descEl.innerHTML = skeletonLines(3); }
        if (scenarioSection && scenarioEl) { scenarioSection.hidden = false; scenarioEl.innerHTML = skeletonLines(2); }
        if (firstMsgSection && firstMsgEl) { firstMsgSection.hidden = false; firstMsgEl.innerHTML = skeletonLines(4); }
        requestAnimationFrame(() => {
            if (creatorNotesEl && creatorNotes && creatorNotes.trim()) {
                deferCall(creatorNotesEl, () => renderCreatorNotesSecure(creatorNotes, name, creatorNotesEl));
            }
            if (descSection && descEl) {
                if (charDef) {
                    deferCall(descEl, () => renderCardHtmlSecure(charDef, name, descEl));
                }
                // No charDef: keep skeleton, fetchAndPopulateDetails fills it.
            }
            if (scenarioSection) {
                if (scenario) {
                    if (scenarioEl) deferRender(scenarioEl, () => safePurify(formatRichText(scenario, name, true), BROWSE_PURIFY_CONFIG));
                } else {
                    scenarioSection.hidden = true;
                }
            }
            if (firstMsgSection) {
                if (firstMsg) {
                    if (firstMsgEl) deferRender(firstMsgEl, () => safePurify(formatRichText(firstMsg, name, true), BROWSE_PURIFY_CONFIG));
                } else {
                    firstMsgSection.hidden = true;
                }
            }
        });

        // Example Dialogs
        const examplesSection = document.getElementById('ctCharExamplesSection');
        const examplesEl = document.getElementById('ctCharExamples');
        const examples = hit.characterExampleMessages || '';
        if (examplesSection && examplesEl) { examplesSection.hidden = false; examplesEl.innerHTML = skeletonLines(3); }
        requestAnimationFrame(() => {
            if (examplesSection) {
                if (examples) {
                    if (examplesEl) deferRender(examplesEl, () => safePurify(formatRichText(examples, name, true), BROWSE_PURIFY_CONFIG));
                } else {
                    examplesSection.hidden = true;
                }
            }
        });

        // Import button state, kept in step with the library while the preview is open
        const restampImport = () => {
            const inLibraryNow = view.isHitInLibrary(hit);
            // scorer gets '' for a missing creator (its name-only branch); the display keeps 'Unknown'
            view.stampImportButton(document.getElementById('ctImportBtn'), { inLibrary: inLibraryNow, possibleMatch: !inLibraryNow && !!view.getPossibleMatchTier(getCtCharName(hit), rawAuthor)?.show });
        };
        restampImport();
        view.trackPreview(restampImport, hit);
    } catch (err) {
        console.error('[CTBrowse] Error populating preview modal:', err);
    }

    modal.classList.remove('hidden');
    const charBody = modal.querySelector('.browse-char-body');
    if (charBody) charBody.scrollTop = 0;

    if (!charDef) {
        const fetchToken = ++ctDetailFetchToken;
        fetchAndPopulateDetails(hit, fetchToken);
    }
}

async function fetchAndPopulateDetails(hit, token) {
    if (!hit.path) return;
    const parts = hit.path.split('/');
    if (parts.length < 2) return;
    const name = hit.name || 'Unknown';

    try {
        const data = await fetchCharacterDetail(parts[0], parts[1], apiRequest);
        if (token !== ctDetailFetchToken) return;

        if (!data?.card) {
            const descEl = document.getElementById('ctCharDescription');
            if (descEl) descEl.innerHTML = definitionFailedNotice('It can still be imported with basic info.');
            return;
        }

        const card = data.card;

        // Store full data on the selected char for import
        if (ctSelectedChar?.path === hit.path) {
            ctSelectedChar._fullDetail = card;
        }

        // Detail-API populate (richer than the search hit). RAF defer in case the modal-open transition is still running.
        const creatorNotesSection = document.getElementById('ctCharCreatorNotesSection');
        const creatorNotesEl = document.getElementById('ctCharCreatorNotes');
        const detailNotes = card.description || '';
        const descSection = document.getElementById('ctCharDescriptionSection');
        const descEl = document.getElementById('ctCharDescription');
        const charDef = card.definition_character_description || '';
        const scenarioSection = document.getElementById('ctCharScenarioSection');
        const scenarioEl = document.getElementById('ctCharScenario');
        const scenario = card.definition_scenario || '';
        const firstMsgSection = document.getElementById('ctCharFirstMsgSection');
        const firstMsgEl = document.getElementById('ctCharFirstMsg');
        const firstMsg = card.definition_first_message || '';
        const examplesSection = document.getElementById('ctCharExamplesSection');
        const examplesEl = document.getElementById('ctCharExamples');
        const examples = card.definition_example_messages || '';
        requestAnimationFrame(() => {
            if (detailNotes && detailNotes.trim() && creatorNotesEl) {
                if (creatorNotesSection) creatorNotesSection.hidden = false;
                deferCall(creatorNotesEl, () => renderCreatorNotesSecure(detailNotes, name, creatorNotesEl));
            }
            if (descSection) {
                if (charDef) {
                    descSection.hidden = false;
                    if (descEl) deferCall(descEl, () => renderCardHtmlSecure(charDef, name, descEl));
                } else {
                    descSection.hidden = true;
                }
            }
            if (scenarioSection) {
                if (scenario) {
                    scenarioSection.hidden = false;
                    if (scenarioEl) deferRender(scenarioEl, () => safePurify(formatRichText(scenario, name, true), BROWSE_PURIFY_CONFIG));
                } else {
                    scenarioSection.hidden = true;
                }
            }
            if (firstMsgSection) {
                if (firstMsg) {
                    firstMsgSection.hidden = false;
                    if (firstMsgEl) deferRender(firstMsgEl, () => safePurify(formatRichText(firstMsg, name, true), BROWSE_PURIFY_CONFIG));
                } else {
                    firstMsgSection.hidden = true;
                }
            }
            if (examplesSection) {
                if (examples) {
                    examplesSection.hidden = false;
                    if (examplesEl) deferRender(examplesEl, () => safePurify(formatRichText(examples, name, true), BROWSE_PURIFY_CONFIG));
                } else {
                    examplesSection.hidden = true;
                }
            }
        });

        // Lorebook stat (detail API has lorebookId; search hit might not)
        const lorebookStat = document.getElementById('ctCharLorebookStat');
        if (lorebookStat && card.lorebookId) {
            lorebookStat.hidden = false;
        }
    } catch (err) {
        debugLog('[CTBrowse] Detail fetch error:', err);
        if (token === ctDetailFetchToken) {
            const descEl = document.getElementById('ctCharDescription');
            if (descEl) descEl.innerHTML = definitionFailedNotice('It can still be imported with basic info.');
        }
    }
}

function cleanupCtCharModal() {
    BrowseView.closeAvatarViewer();
    CoreAPI.setBrowseAltGreetings(null);
    const sectionIds = [
        'ctCharDescription',
        'ctCharScenario',
        'ctCharFirstMsg',
        'ctCharExamples',
        'ctCharAltGreetings',
        'ctCharTags',
    ];
    for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }
    const notesEl = document.getElementById('ctCharCreatorNotes');
    if (notesEl) cleanupCreatorNotesContainer(notesEl);
}

function closePreviewModal() {
    ctDetailFetchToken++;
    cleanupCtCharModal();
    const modal = document.getElementById('ctCharModal');
    if (modal) modal.classList.add('hidden');
    ctSelectedChar = null;
    view.trackPreview(null);
}

// ========================================
// IMPORT
// ========================================

async function importCharacter(charData) {
    if (!charData?.path) return;
    const charName = charData.name || charData.path.split('/').pop() || '';
    const charCreator = charData.author || charData.path?.split('/')[0] || '';
    await view.importFromPreview({
        button: document.getElementById('ctImportBtn'), hit: charData, provider: 'chartavern', id: charData.path, data: charData, label: 'CTBrowse',
        closePreview: closePreviewModal,
        probe: {
            name: charName, creator: charCreator, fullPath: charData.path,
            description: charData.characterDescription || '',
            first_mes: charData.characterFirstMessage || '',
            personality: charData.characterPersonality || '',
            scenario: charData.characterScenario || '',
        },
        dialog: { name: charName, creator: charCreator, fullPath: charData.path, avatarUrl: getAvatarUrl(charData.path) },
    });
}

// ========================================
// TAGS RENDERING
// ========================================

async function loadTopTags() {
    if (ctTopTagsFetched) return;
    try {
        ctTopTags = await fetchTopTags(apiRequest);
        ctTopTagsFetched = true;
    } catch (e) {
        console.warn('[CTBrowse] Failed to fetch top tags:', e.message);
        ctTopTags = [];
    }
}

function renderTagsList(filter = '') {
    const container = document.getElementById('ctTagsList');
    if (!container) return;

    if (!ctTopTagsFetched) {
        container.innerHTML = '<div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>';
        return;
    }

    const filtered = filter
        ? ctTopTags.filter(t => t.tag.toLowerCase().includes(filter.toLowerCase()))
        : ctTopTags;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    container.innerHTML = filtered.map(({ tag, count }) => {
        const state = ctIncludeTags.has(tag) ? 'include' : ctExcludeTags.has(tag) ? 'exclude' : 'neutral';

        return `
            <div class="browse-tag-filter-item" data-tag-name="${escapeHtml(tag)}">
                ${tagStateButtonHtml(state)}
                <span class="tag-label">${escapeHtml(tag)}</span>
                <span class="tag-count">${formatNumber(count)}</span>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const tagName = item.dataset.tagName;
        const stateBtn = item.querySelector('.browse-tag-state-btn');

        item.addEventListener('click', () => {
            // Cycle: neutral → include → exclude → neutral
            if (ctIncludeTags.has(tagName)) {
                ctIncludeTags.delete(tagName);
                ctExcludeTags.add(tagName);
            } else if (ctExcludeTags.has(tagName)) {
                ctExcludeTags.delete(tagName);
            } else {
                ctIncludeTags.add(tagName);
            }
            cycleTagState(stateBtn, tagName);
            updateCtTagsButton();
            chartavernBrowseView.reload();
        });
    });
}

function cycleTagState(btn, tagName) {
    updateTagStateButton(btn,
        ctIncludeTags.has(tagName) ? 'include' : ctExcludeTags.has(tagName) ? 'exclude' : 'neutral');
}

function updateCtTagsButton() {
    const btn = document.getElementById('ctTagsBtn');
    const label = document.getElementById('ctTagsBtnLabel');
    if (!btn) return;

    const count = ctIncludeTags.size + ctExcludeTags.size;
    if (count > 0) {
        btn.classList.add('has-filters');
        if (label) label.innerHTML = `Tags <span class="tag-count">(${count})</span>`;
    } else {
        btn.classList.remove('has-filters');
        if (label) label.textContent = 'Tags';
    }
}

function updateCtFiltersButton() {
    const btn = document.getElementById('ctFiltersBtn');
    if (!btn) return;

    const count = countActiveFeatures(CT_FEATURE_FILTERS, ctFeatureState);
    btn.classList.toggle('has-filters', count > 0);
    const span = btn.querySelector('span');
    if (span) span.textContent = count > 0 ? `Features (${count})` : 'Features';
}

// ========================================
// EVENT WIRING
// ========================================

let delegatesInitialized = false;
let modalEventsAttached = false;
function initCtView() {
    if (delegatesInitialized) return;
    delegatesInitialized = true;

    const sortEl = document.getElementById('ctSortSelect');
    if (sortEl) CoreAPI.initCustomSelect(sortEl);

    // Grid card click → open preview (delegation)
    const grid = document.getElementById('ctGrid');
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
            const path = card.dataset.ctPath;
            if (!path) return;
            const hit = ctCharacters.find(c => c.path === path);
            if (hit) openPreviewModal(hit);
        });
    }

    // Search
    on('ctSearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doSearch();
        }
    });
    on('ctSearchInput', 'input', (e) => {
        const clearBtn = document.getElementById('ctClearSearchBtn');
        if (clearBtn) clearBtn.classList.toggle('hidden', !e.target.value.trim());
    });
    on('ctSearchBtn', 'click', () => doSearch());
    on('ctClearSearchBtn', 'click', () => {
        // the restore re-shows the pre-scope term, so leave the scope before clearing
        if (ctAuthorFilter) chartavernBrowseView.clearCreatorScope({ reload: false });
        const input = document.getElementById('ctSearchInput');
        const clearBtn = document.getElementById('ctClearSearchBtn');
        if (input) input.value = '';
        if (clearBtn) clearBtn.classList.add('hidden');
        ctCurrentSearch = '';
        chartavernBrowseView.reload();
    });
    on('ctClearAuthorBtn', 'click', () => clearCtAuthorFilter());

    // Load More
    on('ctLoadMoreBtn', 'click', () => {
        chartavernBrowseView.reload({ append: true });
    });

    // NSFW toggle - requires active session for NSFW
    on('ctNsfwToggle', 'click', async () => {
        if (!isCtSessionActive()) {
            showToast('Login required for NSFW content. Use the login option in Settings or click here to log in.', 'warning');
            openCtLoginModal();
            return;
        }
        ctNsfwEnabled = !ctNsfwEnabled;
        setSetting('ctNsfw', ctNsfwEnabled);
        updateNsfwToggle();
        chartavernBrowseView.reload();
    });
    updateNsfwToggle();

    // Sort mode
    on('ctSortSelect', 'change', () => {
        const el = document.getElementById('ctSortSelect');
        if (el) ctSortMode = el.value;
        chartavernBrowseView.reload();
    });

    // Refresh
    on('ctRefreshBtn', 'click', () => chartavernBrowseView.reload({ force: true }));

    // Tags dropdown
    const tagsDropdown = document.getElementById('ctTagsDropdown');

    on('ctTagsBtn', 'click', async (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns('ctTagsDropdown');
        if (filtersDropdown) filtersDropdown.classList.add('hidden');
        if (tagsDropdown) tagsDropdown.classList.toggle('hidden');
        // Lazy-load tags on first open
        if (!ctTopTagsFetched) {
            await loadTopTags();
            renderTagsList();
        }
    });

    if (tagsDropdown) tagsDropdown.addEventListener('click', (e) => e.stopPropagation());

    renderTagsList();

    const tagSearchInput = document.getElementById('ctTagsSearchInput');
    if (tagSearchInput) {
        const debouncedFilter = debounce((val) => renderTagsList(val), 200);
        tagSearchInput.addEventListener('input', () => debouncedFilter(tagSearchInput.value));
    }

    on('ctTagsClearBtn', 'click', () => {
        ctIncludeTags.clear();
        ctExcludeTags.clear();
        renderTagsList(document.getElementById('ctTagsSearchInput')?.value || '');
        updateCtTagsButton();
        chartavernBrowseView.reload();
    });

    // Min/Max tokens
    const tokenDebounce = debounce(() => chartavernBrowseView.reload(), 500);

    on('ctMinTokens', 'change', () => {
        const el = document.getElementById('ctMinTokens');
        if (el) ctMinTokens = parseInt(el.value, 10) || 0;
        tokenDebounce();
    });
    on('ctMaxTokens', 'change', () => {
        const el = document.getElementById('ctMaxTokens');
        if (el) ctMaxTokens = parseInt(el.value, 10) || 0;
        tokenDebounce();
    });

    // Features dropdown
    const filtersDropdown = document.getElementById('ctFiltersDropdown');

    on('ctFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns('ctFiltersDropdown');
        if (tagsDropdown) tagsDropdown.classList.add('hidden');
        if (filtersDropdown) filtersDropdown.classList.toggle('hidden');
    });

    if (filtersDropdown) filtersDropdown.addEventListener('click', (e) => e.stopPropagation());

    chartavernBrowseView.wireFeatureFilters(CT_FEATURE_FILTERS, ctFeatureState, () => {
        chartavernBrowseView.reload();
    }, { badge: updateCtFiltersButton });

    // Close dropdowns when clicking outside (uses .contains() - works after mobile relocation to body)
    chartavernBrowseView._registerDropdownDismiss([
        { dropdownId: 'ctTagsDropdown', buttonId: 'ctTagsBtn' },
        { dropdownId: 'ctFiltersDropdown', buttonId: 'ctFiltersBtn' },
    ]);

    // Preview modal events (attached once - modal DOM persists across provider switches)
    if (!modalEventsAttached) {
        modalEventsAttached = true;

        const ctOverlay = document.getElementById('ctCharModal');
        BrowseView.wireTitleScroll(document.getElementById('ctCharName'), ctOverlay, ctOverlay?.querySelector('.browse-char-modal'));

        on('ctCharClose', 'click', () => closePreviewModal());

        // Avatar click → full-size image viewer (desktop only at event time; on mobile
        // bail before stopPropagation so the delegated tap runs)
        const ctAvatar = document.getElementById('ctCharAvatar');
        if (ctAvatar) {
            ctAvatar.addEventListener('click', (e) => {
                if (isMobileMode()) return;
                e.stopPropagation();
                if (!ctAvatar.src || ctAvatar.src.endsWith('/img/no-portrait.png')) return;
                // Strip CDN resize params to get original full-size PNG
                const fullSrc = ctAvatar.src.replace(/\/cdn-cgi\/image\/[^/]+\//, '/');
                BrowseView.openAvatarViewer(fullSrc, ctAvatar.src);
            });
        }

        on('ctImportBtn', 'click', () => {
            if (ctSelectedChar) importCharacter(ctSelectedChar);
        });

        const modalOverlay = document.getElementById('ctCharModal');
        if (modalOverlay) {
            modalOverlay.addEventListener('click', (e) => {
                if (e.target === modalOverlay) closePreviewModal();
            });
        }

        // Login modal events
        on('ctLoginClose', 'click', () => closeCtLoginModal());

        on('ctSaveCookieBtn', 'click', () => {
            const cookieInput = document.getElementById('ctCookieInput');
            let cookieStr = cookieInput?.value?.trim();
            if (!cookieStr) {
                showToast('Please paste your session cookie value', 'warning');
                return;
            }
            // Accept bare value or session=VALUE format
            if (!cookieStr.includes('=')) cookieStr = `session=${cookieStr}`;
            saveCookieAndConnect(cookieStr);
        });

        on('ctLogoutBtn', 'click', () => ctLogoutAction());

        // Enter key on cookie field
        on('ctCookieInput', 'keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('ctSaveCookieBtn')?.click();
            }
        });

        const loginOverlay = document.getElementById('ctLoginModal');
        if (loginOverlay) {
            loginOverlay.addEventListener('click', (e) => {
                if (e.target === loginOverlay) closeCtLoginModal();
            });
        }

        window.registerOverlay?.({ id: 'ctCharModal', tier: 7, close: () => closePreviewModal() });
        window.registerOverlay?.({ id: 'ctLoginModal', tier: 6, close: () => closeCtLoginModal() });
        window.registerOverlay?.({ id: 'ctAuthorBanner', tier: 9, close: () => clearCtAuthorFilter() });
    }
}

function doSearch() {
    const input = document.getElementById('ctSearchInput');
    const clearBtn = document.getElementById('ctClearSearchBtn');
    const val = (input?.value || '').trim();

    // a typed search leaves the scope; its own term then replaces the restored one
    if (ctAuthorFilter) chartavernBrowseView.clearCreatorScope({ reload: false });

    ctCurrentSearch = val;

    if (clearBtn) {
        clearBtn.classList.toggle('hidden', !val);
    }

    chartavernBrowseView.reload();
}

// the author name becomes the keyword query and the box empties; the stash brings the user's term back on exit
function filterByAuthor(authorName) {
    closePreviewModal();
    chartavernBrowseView.enterCreatorScope(() => {
        ctAuthorFilter = authorName;
        view._cdRef = { name: authorName };
        ctCurrentSearch = '';

        const input = document.getElementById('ctSearchInput');
        if (input) input.value = '';
        const clearBtn = document.getElementById('ctClearSearchBtn');
        if (clearBtn) clearBtn.classList.add('hidden');

        const bannerName = document.getElementById('ctAuthorBannerName');
        if (bannerName) bannerName.textContent = authorName;
        window.pushOverlayGuard?.();
    });
}

function clearCtAuthorFilter() {
    chartavernBrowseView.clearCreatorScope();
}

function updateNsfwToggle() {
    const btn = document.getElementById('ctNsfwToggle');
    if (!btn) return;
    const sessionActive = isCtSessionActive();

    if (ctNsfwEnabled && sessionActive) {
        btn.classList.add('active');
        btn.innerHTML = '<i class="fa-solid fa-fire"></i> <span>NSFW On</span>';
        btn.title = 'NSFW content enabled (logged in) - click to show SFW only';
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>';
        btn.title = 'Showing SFW only - click to include NSFW (requires login)';
    }

    btn.style.opacity = sessionActive ? '' : '0.5';
}

// ========================================
// AUTH - CT COOKIE SESSION VIA CL-HELPER
// ========================================

async function openCtLoginModal() {
    ctPluginAvailable = await checkCtPluginAvailable(apiRequest);
    const sessionActive = await checkCtSession(apiRequest);
    updateCtLoginUI();

    const cookieInput = document.getElementById('ctCookieInput');
    if (cookieInput && !sessionActive) {
        const saved = getSetting('ctCookie');
        if (saved) cookieInput.value = saved;
    }

    const modal = document.getElementById('ctLoginModal');
    if (modal) modal.classList.remove('hidden');
}

function closeCtLoginModal() {
    const modal = document.getElementById('ctLoginModal');
    if (modal) modal.classList.add('hidden');
}

function updateCtLoginUI() {
    const pluginOk = document.getElementById('ctPluginStatusOk');
    const pluginMissing = document.getElementById('ctPluginStatusMissing');
    const cookieForm = document.getElementById('ctCookieForm');
    const saveBtn = document.getElementById('ctSaveCookieBtn');
    const sessionActive = isCtSessionActive();

    if (pluginOk) pluginOk.hidden = !ctPluginAvailable;
    if (pluginMissing) pluginMissing.hidden = ctPluginAvailable;
    if (cookieForm) cookieForm.classList.toggle('ct-login-disabled', !ctPluginAvailable);
    if (saveBtn) saveBtn.disabled = !ctPluginAvailable || ctLoginInProgress;

    if (saveBtn) {
        saveBtn.innerHTML = ctLoginInProgress
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Connecting...'
            : '<i class="fa-solid fa-plug"></i> Save & Connect';
    }

    // Session status
    const statusArea = document.getElementById('ctSessionStatus');
    if (statusArea) {
        if (sessionActive) {
            statusArea.innerHTML = '<i class="fa-solid fa-check-circle text-success-bright"></i> <strong>Connected</strong>, NSFW content available';
            statusArea.hidden = false;
        } else {
            statusArea.hidden = true;
        }
    }

    const logoutBtn = document.getElementById('ctLogoutBtn');
    const cookieFields = document.getElementById('ctCookieFields');
    if (logoutBtn) logoutBtn.hidden = !sessionActive;
    if (saveBtn) saveBtn.hidden = sessionActive;
    if (cookieFields) cookieFields.hidden = sessionActive;
}

async function saveCookieAndConnect(cookieStr) {
    if (ctLoginInProgress) return;

    ctLoginInProgress = true;
    updateCtLoginUI();

    try {
        const result = await ctSetCookie(apiRequest, cookieStr);
        if (!result.ok) {
            showToast(result.error || 'Failed to store cookies', 'error');
            return;
        }

        const validation = await ctValidateSession(apiRequest);
        if (!validation.valid) {
            showToast(`Cookie validation failed: ${validation.reason || 'unknown'}`, 'error');
            await ctLogout(apiRequest);
            return;
        }

        setSetting('ctCookie', cookieStr);

        ctNsfwEnabled = getSetting('ctNsfw') === true;
        updateNsfwToggle();

        if (validation.hasNsfw) {
            showToast('Connected to CharacterTavern, NSFW content available', 'success');
        } else {
            showToast('Connected, but NSFW content not detected. Check that your content preferences are enabled on character-tavern.com, or your session may be expired.', 'warning', 6000);
        }
        closeCtLoginModal();

        chartavernBrowseView.reload();
    } catch (err) {
        console.error('[CTAuth] Cookie save error:', err);
        showToast(`Connection error: ${err.message}`, 'error');
    } finally {
        ctLoginInProgress = false;
        updateCtLoginUI();
    }
}

async function ctLogoutAction() {
    await ctLogout(apiRequest);

    ctNsfwEnabled = false;
    setSetting('ctNsfw', false);
    setSetting('ctCookie', null);
    updateNsfwToggle();

    const cookieInput = document.getElementById('ctCookieInput');
    if (cookieInput) cookieInput.value = '';

    showToast('Disconnected from CharacterTavern', 'info');
    closeCtLoginModal();

    chartavernBrowseView.reload();
}

async function tryCheckSession() {
    const sessionActive = await checkCtSession(apiRequest);
    if (sessionActive) {
        const validation = await ctValidateSession(apiRequest);
        if (!validation.valid) {
            // transient = never judged (CT unreachable, a VPN kill-switch, a restart, a 5xx): keep the session and the cookie
            if (validation.transient) {
                debugLog('[CTAuth] Session validation transient failure, keeping cookie:', validation.reason);
                return;
            }
            debugLog('[CTAuth] Session cookies expired:', validation.reason);
            await ctLogout(apiRequest);
            ctNsfwEnabled = false;
            // Only a DEFINITIVE rejection (CT answered and refused) may destroy the persisted
            // cookie; an unmarked invalid (older server) keeps it, fail-open.
            if (validation.definitive) setSetting('ctCookie', null);
            updateNsfwToggle();
            showToast('CharacterTavern session expired - please re-authenticate.', 'warning', 5000);
            openCtLoginModal();
            return;
        }
        if (!validation.hasNsfw) {
            // a valid session without NSFW still works: keep it and say so once per app session
            ctNsfwEnabled = false;
            updateNsfwToggle();
            if (!ctNsfwWarnedThisSession) {
                ctNsfwWarnedThisSession = true;
                showToast('CharacterTavern session is active but NSFW content is not available. Check your content preferences on character-tavern.com.', 'warning', 6000);
            }
            return;
        }

        // Restore NSFW setting if session is still active
        ctNsfwEnabled = getSetting('ctNsfw') === true;
        updateNsfwToggle();
    } else {
        // No active session in the service - try to restore from saved cookie
        const savedCookie = getSetting('ctCookie');
        if (savedCookie) {
            const result = await ctSetCookie(apiRequest, savedCookie);
            if (result.ok) {
                const validation = await ctValidateSession(apiRequest);
                if (validation.valid) {
                    ctNsfwEnabled = getSetting('ctNsfw') === true;
                    updateNsfwToggle();
                    return;
                }
                if (validation.transient) {
                    debugLog('[CTAuth] Saved-cookie validation transient failure, keeping cookie:', validation.reason);
                    return;
                }
                await ctLogout(apiRequest);
                if (validation.definitive) {
                    // say why, or the saved cookie seems to vanish for no reason
                    setSetting('ctCookie', null);
                    showToast('Saved CharacterTavern session has expired. Log in again to restore it.', 'warning', 5000);
                    debugLog('[CTAuth] Saved cookies expired, cleared');
                } else {
                    debugLog('[CTAuth] Saved-cookie validation failed without a definitive marker (older server?), keeping cookie:', validation.reason);
                }
            }
        }
    }
}

// ========================================
// BROWSE VIEW CLASS
// ========================================

class ChartavernBrowseView extends BrowseView {

    constructor(provider) {
        super(provider);
        view = this;
    }

    hitMatchName(hit) {
        return { name: getCtCharName(hit), creator: hit.author_username || hit.author || hit.path?.split('/')[0] || '' };
    }

    hitLinkKey(hit) {
        return hit?.path || null;
    }

    get previewModalId() { return 'ctCharModal'; }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'most_popular', label: 'Most Popular' },
                { value: 'trending', label: 'Trending' },
                { value: 'newest', label: 'Newest' },
                { value: 'oldest', label: 'Oldest' },
                { value: 'most_likes', label: 'Most Liked' },
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
            sort: 'ctSortSelect',
            tags: 'ctTagsBtn',
            filters: 'ctFiltersBtn',
            nsfw: 'ctNsfwToggle',
            refresh: 'ctRefreshBtn'
        };
    }

    // Filter Bar

    renderFilterBar() {
        return `
            <!-- Sort -->
            <div class="browse-sort-container">
                <select id="ctSortSelect" class="glass-select" title="Sort order">
                    <option value="most_popular" data-icon="fa-solid fa-fire" selected>Most Popular</option>
                    <option value="trending" data-icon="fa-solid fa-arrow-trend-up">Trending</option>
                    <option value="newest" data-icon="fa-solid fa-calendar-plus">Newest</option>
                    <option value="oldest" data-icon="fa-solid fa-hourglass">Oldest</option>
                    <option value="most_likes" data-icon="fa-solid fa-heart">Most Liked</option>
                </select>
            </div>

            <!-- Tags & Advanced Filters -->
            <div class="browse-tags-dropdown-container u-relative">
                <button id="ctTagsBtn" class="glass-btn" title="Tag filters and advanced options">
                    <i class="fa-solid fa-tags"></i> <span id="ctTagsBtnLabel">Tags</span>
                </button>
                <div id="ctTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="ctTagsSearchInput" placeholder="Search tags..." autocomplete="one-time-code">
                        <button id="ctTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="ctTagsList">
                        <div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>
                    </div>
                    <hr class="browse-filter-divider">
                    <div class="dropdown-section-title"><i class="fa-solid fa-gear"></i> Advanced Options</div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Min Tokens</label>
                        <input type="number" id="ctMinTokens" class="glass-input-small" value="0" min="0" max="100000" step="100">
                    </div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Max Tokens</label>
                        <input type="number" id="ctMaxTokens" class="glass-input-small" value="0" min="0" max="500000" step="1000" placeholder="No limit">
                    </div>
                </div>
            </div>

            <!-- Feature Filters -->
            <div class="browse-more-filters u-relative">
                <button id="ctFiltersBtn" class="glass-btn" title="Additional filters">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="ctFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden">
                    ${renderFeatureFilterItems(CT_FILTER_SECTIONS, CT_FEATURE_FILTERS)}
                </div>
            </div>

            <!-- NSFW toggle -->
            <button id="ctNsfwToggle" class="glass-btn nsfw-toggle u-dim-50" title="Showing SFW only - click to include NSFW (requires login)">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Refresh -->
            <button id="ctRefreshBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // Main View

    renderView() {
        return `
            <div id="ctBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="ctSearchInput" placeholder="Search CharacterTavern characters..." autocomplete="one-time-code">
                        <button id="ctClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="ctSearchBtn" class="browse-search-submit" aria-label="Search">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                </div>

                <div id="ctAuthorBanner" class="browse-author-banner hidden">
                    <div class="browse-author-banner-content">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <span>Searching for <strong id="ctAuthorBannerName">Author</strong> <span class="browse-author-banner-hint">(keyword search, may include unrelated results)</span></span>
                    </div>
                    <div class="browse-author-banner-actions">
                        <button id="ctClearAuthorBtn" class="glass-btn icon-only" title="Clear author filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Results Grid -->
                <div id="ctGrid" class="browse-grid"></div>

                <!-- Load More -->
                <div class="browse-load-more" id="ctLoadMore" hidden>
                    <button id="ctLoadMoreBtn" class="glass-btn">
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
    <div id="ctLoginModal" class="modal-overlay hidden">
        <div class="modal-glass browse-login-modal">
            <div class="modal-header">
                <h2><i class="fa-solid fa-cookie-bite"></i> CharacterTavern Session</h2>
                <button class="close-btn" id="ctLoginClose">&times;</button>
            </div>
            <div class="browse-login-body">
                <p class="browse-login-info">
                    <i class="fa-solid fa-check-circle text-success-bright"></i>
                    <strong>Browsing and downloading public characters works without logging in.</strong>
                </p>
                <p class="browse-login-info">
                    <i class="fa-solid fa-cookie-bite text-accent"></i>
                    <strong>Optional:</strong> Paste your session cookies to see NSFW-tagged content.
                </p>

                <!-- Session status -->
                <div id="ctSessionStatus" class="pyg-auth-status" hidden></div>

                <!-- Cookie form (requires provider service) -->
                <div class="pyg-login-section">
                    <div class="pyg-plugin-status">
                        <span id="ctPluginStatusOk" hidden>
                            <i class="fa-solid fa-plug-circle-check text-success-bright"></i> Login route available
                        </span>
                        <span id="ctPluginStatusMissing" hidden>
                            <i class="fa-solid fa-plug-circle-xmark text-warning-dark"></i>
                            Login route unavailable. The server did not answer, so cookie login is not usable right now.
                        </span>
                    </div>

                    <div id="ctCookieForm" class="browse-login-form">
                        <div id="ctCookieFields">
                            <div class="form-group">
                                <label for="ctCookieInput">Cookie String</label>
                                <textarea id="ctCookieInput" class="glass-input is-code" rows="2" placeholder="Paste your session cookie value here"></textarea>
                            </div>
                            <div class="ct-cookie-instructions">
                                <details>
                                    <summary><i class="fa-solid fa-circle-question"></i> How to get your session cookie</summary>
                                    <ol>
                                        <li>Log in to <a href="https://character-tavern.com" target="_blank">character-tavern.com</a> in your browser</li>
                                        <li>Open DevTools (<code>F12</code>) → <strong>Application</strong> tab → <strong>Cookies</strong></li>
                                        <li>Find the <code>session</code> cookie for <code>character-tavern.com</code></li>
                                        <li>Copy and paste the value here</li>
                                    </ol>
                                    <p class="ct-cookie-note"><i class="fa-solid fa-clock"></i> The session cookie expires after ~10 days. You'll need to re-paste when it expires.</p>
                                </details>
                            </div>
                        </div>

                        <div class="browse-login-actions">
                            <button id="ctSaveCookieBtn" class="cl-btn cl-btn-primary">
                                <i class="fa-solid fa-plug"></i> Save &amp; Connect
                            </button>
                            <button id="ctLogoutBtn" class="cl-btn cl-btn-danger" hidden>
                                <i class="fa-solid fa-plug-circle-xmark"></i> Disconnect
                            </button>
                            <a href="https://character-tavern.com" target="_blank" class="cl-btn cl-btn-secondary">
                                <i class="fa-solid fa-external-link"></i> CharacterTavern
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
    <div id="ctCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="ctCharAvatar" src="/img/no-portrait.png" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="ctCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="ctCharCreator" class="browse-meta-identity" href="#" title="Click to see all characters by this author">Creator</a>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="ctOpenInBrowserBtn" href="#" target="_blank" class="cl-btn cl-btn-secondary" title="Open on CharacterTavern">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="ctImportBtn" class="cl-btn cl-btn-primary" title="Import into your library">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="ctCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-tagline" id="ctCharTaglineSection" hidden>
                    <i class="fa-solid fa-quote-left"></i>
                    <div id="ctCharTagline" class="browse-tagline-text"></div>
                </div>

                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-message"></i>
                            <span id="ctCharTokens">0</span> tokens
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-download"></i>
                            <span id="ctCharDownloads">0</span> downloads
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-heart"></i>
                            <span id="ctCharLikes">0</span> likes
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="ctCharDate">Unknown</span>
                        </div>
                        <div class="browse-stat" id="ctCharGreetingsStat" hidden>
                            <i class="fa-solid fa-comment-dots"></i>
                            <span id="ctCharGreetingsCount">0</span> greetings
                        </div>
                        <div class="browse-stat" id="ctCharLorebookStat" hidden>
                            <i class="fa-solid fa-book"></i>
                            Lorebook
                        </div>
                    </div>
                    <div class="browse-char-tags" id="ctCharTags"></div>
                </div>

                <!-- Creator's Notes -->
                <div class="browse-char-section" id="ctCharCreatorNotesSection" hidden>
                    <h3 class="browse-section-title" data-section="ctCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="ctCharCreatorNotes" class="scrolling-text"></div>
                </div>

                <!-- Description -->
                <div class="browse-char-section" id="ctCharDescriptionSection" hidden>
                    <h3 class="browse-section-title" data-section="ctCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="ctCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Scenario -->
                <div class="browse-char-section" id="ctCharScenarioSection" hidden>
                    <h3 class="browse-section-title" data-section="ctCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="ctCharScenario" class="scrolling-text"></div>
                </div>

                <!-- Example Dialogs -->
                <div class="browse-char-section browse-section-collapsed" id="ctCharExamplesSection" hidden>
                    <h3 class="browse-section-title" data-section="ctCharExamples" data-label="Example Dialogs" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Dialogs
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="ctCharExamples" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="ctCharFirstMsgSection" hidden>
                    <h3 class="browse-section-title" data-section="ctCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="ctCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>

                <!-- Alternate Greetings -->
                <div class="browse-char-section" id="ctCharAltGreetingsSection" hidden>
                    <h3 class="browse-section-title" data-section="browseAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="ctCharAltGreetingsCount"></span>
                    </h3>
                    <div id="ctCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // Lifecycle

    _getImageGridIds() {
        return ['ctGrid'];
    }

    canLoadMore() { return ctHasMore && !ctIsLoading; }

    init() {
        super.init();
        initCtView();
        const grid = document.getElementById('ctGrid');
        if (grid) this.observeImages(grid);
        // No initial load here: init() runs before applyDefaults(), so the base's
        // migrated activation arm issues it (and builds the library lookup first).
    }

    getSearchInputId(mode) {
        return mode === 'character' ? 'ctSearchInput' : null;
    }

    applyDefaults(defaults) {
        super.applyDefaults(defaults);
        if (defaults.sort) {
            ctSortMode = defaults.sort;
            const el = document.getElementById('ctSortSelect');
            if (el) el.value = defaults.sort;
        }
    }

    // Activation hooks

    resetSessionState() {
        ctCurrentSearch = '';
        ctAuthorFilter = null;
        ctSessionChecked = false;
        ctCharacters = [];
        ctCurrentPage = 1;
        ctHasMore = true;
        ctIsLoading = false;
        ctGridRenderedCount = 0;
        for (const k of Object.keys(ctFeatureState)) ctFeatureState[k] = false;
        ctIncludeTags = new Set();
        ctExcludeTags = new Set();
        ctMinTokens = 0;
        ctMaxTokens = 0;
        ctSortMode = 'most_popular';
        ctNsfwEnabled = false;
        ctSelectedChar = null;
    }

    loadInitial(opts = {}) {
        if (opts.append) {
            ctCurrentPage++;
            loadCharacters(true);
            return;
        }
        ctCurrentPage = 1;
        // Session check before the FIRST fetch of a DOM lifetime, so a logged-in account
        // gets NSFW-inclusive results once, not twice; every later reload skips it.
        if (!ctSessionChecked) {
            ctSessionChecked = true;
            tryCheckSession().then(() => loadCharacters(false));
            return;
        }
        loadCharacters(false);
    }

    // The author name rides the keyword query, so the one loader already lands in scope;
    // the stash keeps the term the entry overwrites.
    get creatorScope() {
        return {
            bannerId: 'ctAuthorBanner',
            isActive: () => !!ctAuthorFilter,
            load: (opts) => this.loadInitial(opts),
            clear: () => { ctAuthorFilter = null; },
            stash: () => ({ search: ctCurrentSearch }),
            restore: (s) => {
                ctCurrentSearch = s.search;
                const input = document.getElementById('ctSearchInput');
                if (input) input.value = s.search;
                document.getElementById('ctClearSearchBtn')?.classList.toggle('hidden', !s.search);
            },
        };
    }

    hasData() { return ctCharacters.length > 0; }

    rerenderGrid() {
        ctGridRenderedCount = 0;
        renderGrid(ctCharacters, false);
    }

    get gridElementId() { return 'ctGrid'; }

    onActivated(isReEntry) {
        delegatesInitialized = true;
    }

    deactivate() {
        ctDetailFetchToken++;
        delegatesInitialized = false;
        super.deactivate();
    }
}

const chartavernBrowseView = new ChartavernBrowseView(null);

// Expose for library.js to call from viewOnProvider (linked character preview)
window.openCtCharPreview = function(hit) {
    openPreviewModal(hit);
};

window.openCtLoginModal = function() {
    openCtLoginModal();
};

export default chartavernBrowseView;

// ========================================
// CREATOR DOWNLOADS ADAPTER
// ========================================

registerCdAdapter('chartavern', {
    async fetchAll(view) {
        const authorName = view._cdRef?.name;
        if (!authorName) return [];
        const wanted = authorName.toLowerCase();
        const nsfw = CoreAPI.getSetting('ctNsfw') === true && isCtSessionActive();
        const sort = document.getElementById('ctSortSelect')?.value || 'most_popular';
        const results = [];
        const seen = new Set();
        const MAX_PAGES = 50;
        for (let page = 1; page <= MAX_PAGES; page++) {
            const data = await searchCards({ query: authorName, sort, page, limit: 60, nsfw }, CoreAPI.apiRequest);
            const hits = data?.hits || [];
            for (const hit of hits) {
                const path = hit.path || '';
                if (!path || seen.has(path)) continue;
                // exclude_tags alone doesnt catch all isNSFW cards
                if (!nsfw && hit.isNSFW) continue;
                const hitAuthor = (hit.author_username || hit.author || path.split('/')[0] || '').toLowerCase();
                if (hitAuthor !== wanted) continue;
                seen.add(path);
                results.push({ key: path, name: getCtCharName(hit), creator: hit.author_username || hit.author || '', raw: hit });
            }
            const totalPages = data?.totalPages || 1;
            if (page >= totalPages || hits.length === 0) break;
        }
        return results;
    },
    async importOne(view, card) {
        const provider = CoreAPI.getProvider('chartavern');
        if (!provider?.importCharacter) return { ok: false, error: 'Provider not available' };
        const hit = card.raw;
        const result = await importThroughCommand(provider, hit.path, hit, {});
        if (!result.success) return { ok: false, error: result.error || 'Import failed' };
        return view.creatorImportAnswer(result, provider);
    },
});
