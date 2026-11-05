// DatacatBrowseView: DataCat browse, JanitorAI MeiliSearch text search and sorts (janny_*), and cloud extraction

import {
    BrowseView, registerCdAdapter, cdCharId,
    featureFilterState, renderFeatureFilterItems, countActiveFeatures,
    browseCardImageWidth, activeFeatureRows, featurePasses, updateNsfwToggleButton,
    renderAltGreetingsList, cardTagsHtml,
    renderViewToggle, libraryFeatureRows, libraryBadgeHtml, libraryCardClass, setFilterCount,
} from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber, BROWSE_PURIFY_CONFIG, skeletonLines, hideSections, deferRender, deferCall, isMobileMode, importThroughCommand, renderBrowseError, parseProviderUrl } from '../provider-utils.js';
import {
    DATACAT_API_BASE,
    resolveDatacatAvatarUrl,
    stripHtml,
    resolveTagNames,
    initDcSession,
    fetchDatacatCharacter,
    fetchDatacatDownload,
    fetchDatacatCreator,
    fetchDatacatCreatorCharacters,
    fetchRecentPublic,
    fetchFreshCharacters,
    fetchFacetedTags,
    submitExtraction,
    fetchExtractionStatus,
    searchMeiliJanny,
    fetchHampterCharacters,
    JANNY_TAG_MAP,
    pickRecoveryVariant,
    stripDatacatMarkers,
} from './datacat-api.js';

const {
    onElement: on,
    showToast,
    escapeHtml,
    debugLog,
    getSetting,
    setSetting,
    formatRichText,
    safePurify,
    renderCreatorNotesSecure,
    renderCardHtmlSecure,
    cleanupCreatorNotesContainer,
    renderLoadingState,
    renderSkeletonGrid,
} = CoreAPI;

// ========================================
// STATE
// ========================================

let datacatCharacters = [];
let datacatCurrentOffset = 0;
let datacatHasMore = true;
let datacatIsLoading = false;
let datacatLoadToken = 0;
let datacatSelectedChar = null;
let datacatSelectedDetail = null;
let datacatGridRenderedCount = 0;

// Browse mode: 'recent' (default) or 'creator'
let datacatBrowseMode = 'recent';

// Creator browsing state
let datacatCreatorId = null;
let datacatCreatorName = '';
let datacatSortMode = 'recent';
let datacatCreatorSortMode = 'chat_count';

// all render-time excludes; the source row is wrapped so single-source sorts can hide it
const DATACAT_FEATURE_FILTERS = [
    ...libraryFeatureRows('datacat', () => view, isCharPossibleMatchObj),
    { key: 'hideJanitor', id: 'datacatFilterHideJanitor', section: 'source', icon: 'fa-cat', label: 'Hide JanitorAI',
      exclude: (c) => getSourceKind(c) === 'janitor' },
];
const datacatFeatureState = featureFilterState(DATACAT_FEATURE_FILTERS);

const DATACAT_FILTER_SECTIONS = [
    { key: 'library', title: 'Library:' },
    { key: 'source', title: 'Source:', wrapId: 'datacatFilterSourceSection', noHr: true },
];

// Fresh endpoint pagination
let datacatFreshLimit24 = 80;
let datacatFreshLimitWeek = 20;
const FRESH_PAGE_INCREMENT = 20;

// NSFW filter (client-side)
let datacatNsfwEnabled = false;

// Faceted tag filtering
let datacatActiveTagIds = new Set();
let datacatTagGroups = [];
let datacatTags = [];
let datacatTagsLoaded = false;
let datacatTagsLoading = false;

// View mode: 'browse' or 'following'
let datacatViewMode = 'browse';

// Following state
let datacatFollowedCreators = [];
let datacatFollowingCharacters = [];
let datacatFollowingLoading = false;
let datacatFollowingSort = 'newest';
let datacatFollowingDisplayLimit = 60;
let datacatFollowingFiltered = [];

let view; // module-scoped BrowseView instance reference (set once in constructor)
let dcSessionPrimed = false; // initDcSession ran this DOM lifetime, so later reloads skip the re-validate

const PAGE_SIZE = 80;

// MeiliSearch (JanitorAI) state
let meiliCurrentPage = 1;
let meiliTotalPages = 0;
let datacatSearchQuery = ''; // native feed text search (recent-public &search=, matches creator names too)
let meiliSearchQuery = '';

// Shared JanitorAI tag filter state (used by both MeiliSearch and Hampter modes)
let jannyActiveTagIds = new Set();

// Hampter (JanitorAI) state
let hampterCurrentPage = 1;
let hampterTotalPages = 0;
let hampterSearchQuery = '';

// Extraction state
let extractionPollTimer = null;
let extractionStartTime = null;

// ========================================
// FIELD HELPERS (handle camelCase/snake_case from different endpoints)
// ========================================

function getCharId(hit) {
    return hit?.characterId || hit?.character_id || hit?.id || '';
}

function getCreatorId(hit) {
    return hit?.creatorId || hit?.creator_id || '';
}

function getCreatorName(hit) {
    return hit?.creatorName || hit?.creator_name || '';
}

function getChatCount(hit) {
    return parseInt(hit?.chatCount || hit?.chat_count, 10) || 0;
}

function getMsgCount(hit) {
    return parseInt(hit?.messageCount || hit?.message_count, 10) || 0;
}

function getTotalTokens(hit) {
    return parseInt(
        hit?.totalTokens
            || hit?.total_tokens
            || hit?.token_counts?.total_tokens
            || hit?.tokenCounts?.total_tokens,
        10
    ) || 0;
}

function getCreatedDate(hit) {
    const raw = hit?.createdAt || hit?.created_at;
    return raw ? new Date(raw).toLocaleDateString() : '';
}

function isNsfw(hit) {
    return !!(hit?.isNsfw || hit?.is_nsfw);
}

// ========================================
// LOCAL LIBRARY LOOKUP
// ========================================

function isCharPossibleMatchObj(c) {
    if (view.isHitInLibrary(c)) return false;
    return view.isCharPossibleMatch(c.name || '', getCreatorName(c));
}

/**
 * A hit's source: every DataCat row is a JanitorAI one, legacy rows without the field too.
 * @returns {'janitor'}
 */
function getSourceKind() {
    return 'janitor';
}

// ========================================
// CARD RENDERING
// ========================================

function createDatacatCard(hit) {
    const name = hit.name || 'Unknown';
    const desc = stripHtml(hit.description) || '';
    // the grid slot's width, so janitorai-hosted originals dont decode full-size
    const avatarUrl = resolveDatacatAvatarUrl(hit, { width: browseCardImageWidth() }) || '/img/no-portrait.png';
    const charId = getCharId(hit);
    const creatorName = getCreatorName(hit);
    const inLibrary = view.isHitInLibrary(hit);
    const possibleTier = inLibrary ? null : view.getPossibleMatchTier(hit.name || '', creatorName);

    // Tags are only present on creator endpoint items, not recent-public
    const tags = resolveTagNames(hit.tags || []);

    const badges = [];
    const importing = view.importingBadge(hit);
    if (importing) badges.push(importing);
    const libraryBadge = libraryBadgeHtml(inLibrary, possibleTier);
    if (libraryBadge) badges.push(libraryBadge);

    const sourceBadges = [];
    const sourceKind = getSourceKind(hit);
    // the J badge only where a listing could mix sources: single-source sorts (janny_*, hampter_*) hide it
    const isSingleSourceMode = !hit._followedCreatorSource && (
        isJannySortMode(datacatSortMode)
        || isHampterSortMode(datacatSortMode)
    );
    if (!isSingleSourceMode && sourceKind === 'janitor') {
        sourceBadges.push('<span class="browse-feature-badge source-janitor" title="Source: JanitorAI">J</span>');
    }

    const nsfwBadge = isNsfw(hit) ? '<span class="browse-nsfw-badge">NSFW</span>' : '';

    const createdDate = getCreatedDate(hit);
    const dateInfo = createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';

    // Footer stats differ by source
    const chatCount = getChatCount(hit);
    const msgCount = getMsgCount(hit);
    const totalTokens = getTotalTokens(hit);

    let statsHtml;
    if (chatCount || msgCount) {
        statsHtml = `
            <span class="browse-card-stat" title="Chats"><i class="fa-solid fa-comments"></i> ${formatNumber(chatCount)}</span>
            <span class="browse-card-stat" title="Messages"><i class="fa-solid fa-envelope"></i> ${formatNumber(msgCount)}</span>
        `;
    } else if (totalTokens) {
        const scorerTotal = hit.scorerBaseTotal;
        statsHtml = `<span class="browse-card-stat" title="Total Tokens"><i class="fa-solid fa-text-width"></i> ${formatNumber(totalTokens)}</span>`;
        if (scorerTotal != null && scorerTotal > 0) {
            statsHtml += `<span class="browse-card-stat" title="Quality Score"><i class="fa-solid fa-star"></i> ${Math.round(scorerTotal)}</span>`;
        }
    } else {
        statsHtml = '';
    }

    const cardClass = libraryCardClass(inLibrary, possibleTier);

    return `
        <div class="${cardClass}" data-datacat-id="${escapeHtml(charId)}"${view.linkKeyAttr(hit)} ${desc ? `title="${escapeHtml(desc)}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/no-portrait.png'">
                ${nsfwBadge}
                ${sourceBadges.length > 0 ? `<div class="browse-feature-badges browse-feature-badges-tl">${sourceBadges.join('')}</div>` : ''}
                ${badges.length > 0 ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                ${creatorName ? `<span class="browse-card-creator-link" data-creator-id="${escapeHtml(getCreatorId(hit))}" data-author="${escapeHtml(creatorName)}" title="Click to see all characters by ${escapeHtml(creatorName)}">${escapeHtml(creatorName)}</span>` : ''}
                ${cardTagsHtml(tags)}
            </div>
            <div class="browse-card-footer">
                ${statsHtml}
                ${dateInfo}
            </div>
        </div>
    `;
}

// ========================================
// IMAGE OBSERVER
// ========================================

function observeNewCards() {
    const grid = document.getElementById('datacatGrid');
    if (grid) datacatBrowseView.observeImages(grid);
}

// ========================================
// GRID RENDERING
// ========================================

let datacatAutoTopUps = 0; // chained top-up fetches since the last user-initiated load
let datacatTopUpVisible = 0; // visible cards accumulated across those chained fetches

// the one page advance; offset modes move by rows returned at response time, since datacat clamps limit (80 asked, 50 sent)
function advanceDatacatPage() {
    if (datacatBrowseMode === 'creator') {
        // response-time offset advance
    } else if (isHampterSortMode(datacatSortMode)) {
        hampterCurrentPage++;
    } else if (isJannySortMode(datacatSortMode)) {
        meiliCurrentPage++;
    } else {
        const parsed = parseSortMode(datacatSortMode);
        // mirrors isFreshMode: tag-filtered or searched fresh sorts ride the offset, so growing the fresh limits advanced nothing
        if (parsed && datacatActiveTagIds.size === 0 && !datacatSearchQuery) {
            if (parsed.window === '24h') datacatFreshLimit24 += FRESH_PAGE_INCREMENT;
            else datacatFreshLimitWeek += FRESH_PAGE_INCREMENT;
        }
    }
}

function renderGrid(characters, append = false) {
    const grid = document.getElementById('datacatGrid');
    if (!grid) return;

    if (!append) {
        grid.innerHTML = '';
        datacatGridRenderedCount = 0;
    }

    let filtered = datacatNsfwEnabled
        ? characters
        : characters.filter(c => !isNsfw(c));

    const activeRows = activeFeatureRows(DATACAT_FEATURE_FILTERS, datacatFeatureState);
    if (activeRows.length > 0) {
        filtered = filtered.filter(c => featurePasses(c, activeRows));
    }

    // Client-side: persistent exclude tags from settings
    const dcPersistentExclude = view.persistentExcludeTags();
    if (dcPersistentExclude.length > 0) {
        const lowerExclude = dcPersistentExclude.map(t => t.toLowerCase());
        filtered = filtered.filter(c => {
            const names = resolveTagNames(c.tags || []).map(n => n.toLowerCase());
            return !lowerExclude.some(et => names.includes(et));
        });
    }



    // the creator endpoints take no tag params, so in scope the active tags narrow here
    if (datacatBrowseMode === 'creator' && datacatActiveTagIds.size > 0) filtered = filtered.filter(datacatTagsPass);

    const startIdx = append ? datacatGridRenderedCount : 0;
    const html = filtered.slice(startIdx).map(c => createDatacatCard(c)).join('');
    grid.insertAdjacentHTML('beforeend', html);
    datacatGridRenderedCount = filtered.length;

    observeNewCards();
    updateLoadMore();
}

function updateLoadMore() {
    datacatBrowseView.updateLoadMoreVisibility('datacatLoadMore', datacatHasMore, datacatCharacters.length > 0);
}

// ========================================
// LOAD CHARACTERS
// ========================================

async function loadCharacters(append = false) {
    if (append && datacatIsLoading) return;
    if (!append) { datacatAutoTopUps = 0; datacatTopUpVisible = 0; }
    const thisToken = ++datacatLoadToken;
    datacatIsLoading = true;
    let visibleNew = Infinity; // error paths must never trigger the top-up chain

    const grid = document.getElementById('datacatGrid');
    const loadMoreBtn = document.getElementById('datacatLoadMoreBtn');

    if (!append && grid) {
        renderSkeletonGrid(grid);
    }

    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        let list = [];
        let total = 0;

        if (datacatBrowseMode === 'creator' && datacatCreatorId) {
            const data = await fetchDatacatCreatorCharacters(datacatCreatorId, {
                limit: PAGE_SIZE,
                offset: datacatCurrentOffset,
                sortBy: datacatCreatorSortMode
            });
            list = data?.list || [];
            total = data?.total || 0;
            sortCreatorResults(list, datacatCreatorSortMode);
        } else if (isJannySortMode(datacatSortMode)) {
            if (!append) meiliCurrentPage = 1;
            const data = await searchMeiliJanny({
                search: meiliSearchQuery,
                page: meiliCurrentPage,
                limit: PAGE_SIZE,
                sort: datacatSortMode,
                nsfw: datacatNsfwEnabled,
                includeTags: jannyActiveTagIds,
            });
            list = data?.characters || [];
            total = data?.totalHits || 0;
            meiliTotalPages = data?.totalPages || 0;
        } else if (isHampterSortMode(datacatSortMode)) {
            if (!append) hampterCurrentPage = 1;
            const hampterSort = datacatSortMode.replace('hampter_', '');
            const fetchOpts = {
                sort: hampterSort,
                page: hampterCurrentPage,
                search: hampterSearchQuery,
                nsfw: datacatNsfwEnabled,
                authToken: (await window.datacatJanitoraiGetToken?.()) || '',
            };
            let data;
            try {
                // hampter sorts hit janitorai.com behind Cloudflare with only a best-effort direct fetch, so a block is expected
                data = await fetchHampterCharacters(fetchOpts);
            } catch (err) {
                // A 401 despite a token means it was rejected mid-session; refresh once and retry before giving up.
                if (err?.code === 'HAMPTER_TOKEN_EXPIRED') {
                    const fresh = (await window.datacatJanitoraiForceRefresh?.()) || '';
                    if (!fresh) throw err;
                    data = await fetchHampterCharacters({ ...fetchOpts, authToken: fresh });
                } else {
                    throw err;
                }
            }
            list = data?.characters || [];
            total = data?.total || 0;
            hampterTotalPages = total > 0 ? Math.ceil(total / (data?.pageSize || 34)) : 0;
        } else {
            const tagIds = [...datacatActiveTagIds];
            const parsed = parseSortMode(datacatSortMode);
            // Search and tags both force the offset endpoint (fresh has neither); keep this
            // in lockstep with isFreshMode below and the fresh gate in advanceDatacatPage
            const useRecent = !parsed || tagIds.length > 0 || !!datacatSearchQuery;
            if (useRecent) {
                const data = await fetchRecentPublic({
                    limit: PAGE_SIZE,
                    offset: datacatCurrentOffset,
                    tagIds: tagIds.length > 0 ? tagIds : undefined,
                    search: datacatSearchQuery || undefined,
                    // recent-public honors only sortBy=score, so Score sorts survive tag/search
                    // filtering; the other fresh sorts fall back to newest-first on this path
                    sortBy: parsed?.sortBy === 'score' ? 'score' : undefined
                });
                list = data?.characters || [];
                total = data?.totalCount || 0;
            } else {
                const is24h = parsed.window === '24h';
                const data = await fetchFreshCharacters({
                    sortBy: parsed.sortBy,
                    limit24: is24h ? datacatFreshLimit24 : 0,
                    limitWeek: is24h ? 0 : datacatFreshLimitWeek,
                });
                if (data) {
                    list = is24h ? data.last24h : data.thisWeek;
                    total = list.length;
                }
            }
        }

        if (thisToken !== datacatLoadToken) return;
        if (!delegatesInitialized) return;

        const freshParsed = parseSortMode(datacatSortMode);
        const isFreshMode = datacatBrowseMode !== 'creator' && freshParsed && datacatActiveTagIds.size === 0 && !datacatSearchQuery;
        const isMeili = isJannySortMode(datacatSortMode);
        const isHampter = isHampterSortMode(datacatSortMode);

        // creator mode fetches by offset whatever browse sort lingers, so it routes here first like the fetch branch
        const isOffsetMode = datacatBrowseMode === 'creator' || (!isMeili && !isHampter && !isFreshMode);

        if (isOffsetMode) {
            if (append) {
                const existingIds = new Set(datacatCharacters.map(c => getCharId(c)));
                datacatCharacters = datacatCharacters.concat(list.filter(c => {
                    const id = getCharId(c);
                    return !id || !existingIds.has(id);
                }));
            } else {
                datacatCharacters = list;
            }
            // Advance by what actually arrived, not by PAGE_SIZE: the server clamps the limit
            datacatCurrentOffset = (append ? datacatCurrentOffset : 0) + list.length;
            datacatHasMore = datacatCurrentOffset < total;
        } else if (isMeili) {
            if (append) {
                const existingIds = new Set(datacatCharacters.map(c => getCharId(c)));
                datacatCharacters = datacatCharacters.concat(list.filter(c => {
                    const id = getCharId(c);
                    return !id || !existingIds.has(id);
                }));
            } else {
                datacatCharacters = list;
            }
            datacatHasMore = meiliCurrentPage < meiliTotalPages;
        } else if (isHampter) {
            if (append) {
                const existingIds = new Set(datacatCharacters.map(c => getCharId(c)));
                datacatCharacters = datacatCharacters.concat(list.filter(c => {
                    const id = getCharId(c);
                    return !id || !existingIds.has(id);
                }));
            } else {
                datacatCharacters = list;
            }
            datacatHasMore = hampterCurrentPage < hampterTotalPages;
        } else {
            // Fresh mode: the endpoint returns a cumulative top-N list, replace wholesale
            datacatCharacters = list;
            const activeLimit = freshParsed.window === '24h' ? datacatFreshLimit24 : datacatFreshLimitWeek;
            datacatHasMore = list.length >= activeLimit;
        }

        const renderedBefore = append ? datacatGridRenderedCount : 0;
        await datacatBrowseView.probeHits(datacatCharacters);
        renderGrid(datacatCharacters, append);
        visibleNew = datacatGridRenderedCount - renderedBefore;

        if (!append && datacatCharacters.length === 0) {
            const emptyMsg = datacatBrowseMode === 'creator'
                ? 'No characters found for this creator'
                : 'No characters found';
            grid.innerHTML = `
                <div class="browse-empty-state">
                    <i class="fa-solid fa-cat browse-empty-icon"></i>
                    <p class="u-mt-md">${emptyMsg}</p>
                </div>
            `;
        }

        debugLog('[DatacatBrowse] Loaded', list.length, 'characters, offset', datacatCurrentOffset, '/', total, 'mode:', datacatBrowseMode);

    } catch (err) {
        if (thisToken !== datacatLoadToken) return;
        console.error('[DatacatBrowse] Load error:', err);
        const isHampterBlocked = err?.code === 'HAMPTER_BLOCKED' && isHampterSortMode(datacatSortMode);
        const isHampterLoginGated = err?.code === 'HAMPTER_LOGIN_REQUIRED' && isHampterSortMode(datacatSortMode);
        const isHampterTokenExpired = err?.code === 'HAMPTER_TOKEN_EXPIRED' && isHampterSortMode(datacatSortMode);
        const isInlineNotice = isHampterBlocked || isHampterLoginGated || isHampterTokenExpired;
        if (!isInlineNotice) {
            showToast(`DataCat load failed: ${err.message}`, 'error');
        }
        if (isHampterTokenExpired) {
            // Stale JanitorAI token: stop cleanly on load-more, prompt a re-paste on a fresh load.
            if (append) {
                hampterCurrentPage = Math.max(1, hampterCurrentPage - 1);
                hampterTotalPages = hampterCurrentPage;
                datacatHasMore = false;
                updateLoadMore();
            }
            showToast('Your JanitorAI session expired. Re-paste your token in Settings to keep browsing these sorts.', 'warning', 8000);
            if (append) return;
        }
        if (isHampterLoginGated && append) {
            // JanitorAI login-gates page 2+ anonymously; end pagination cleanly instead of erroring.
            hampterCurrentPage = Math.max(1, hampterCurrentPage - 1);
            hampterTotalPages = hampterCurrentPage;
            datacatHasMore = false;
            updateLoadMore();
            showToast('JanitorAI serves only the first page of this sort without a login. Add your JanitorAI token in Settings for more.', 'info', 7000);
            return;
        }
        if (isHampterBlocked && append) {
            // Cloudflare block; roll the page back so the next Load More refetches it.
            hampterCurrentPage = Math.max(1, hampterCurrentPage - 1);
            showToast('Cloudflare blocked this page load. These JanitorAI sorts are unreliable now; use the MeiliSearch sort orders, which always work.', 'warning', 6000);
            return;
        }
        if (!append && grid) {
            if (isHampterLoginGated || isHampterTokenExpired) {
                const expired = isHampterTokenExpired;
                grid.innerHTML = `
                    <div class="browse-empty-state is-narrow">
                        <i class="fa-solid fa-user-lock browse-empty-icon is-warn"></i>
                        <p class="browse-empty-lead"><strong>${expired ? 'Your JanitorAI session expired' : 'JanitorAI requires an account for this request'}</strong></p>
                        <p class="u-mt-sm">${expired
                            ? 'JanitorAI tokens last about 3 hours. Re-copy the sb-auth-auth-token cookie and paste it under Settings &rarr; Online &rarr; DataCat.'
                            : 'The Hampter sorts show the first page without a login. Paste your JanitorAI token under Settings &rarr; Online &rarr; DataCat to browse further, or use the MeiliSearch sort orders, which need no login.'}</p>
                        <button class="glass-btn u-mt-md" id="datacatRetryBtn">
                            <i class="fa-solid fa-redo"></i> Retry
                        </button>
                    </div>
                `;
            } else if (isHampterBlocked) {
                grid.innerHTML = `
                    <div class="browse-empty-state is-narrow">
                        <i class="fa-solid fa-shield-halved browse-empty-icon is-warn"></i>
                        <p class="browse-empty-lead"><strong>Cloudflare blocked this request</strong></p>
                        <p class="u-mt-sm">JanitorAI's Hampter sort orders sit behind Cloudflare, which blocked this load. Direct access from the server is unreliable; the other JanitorAI sort orders (MeiliSearch) always work.</p>
                        <button class="glass-btn u-mt-md" id="datacatRetryBtn">
                            <i class="fa-solid fa-redo"></i> Retry
                        </button>
                    </div>
                `;
            } else {
                // a failed load may be a dead session; the retry goes back through the bootstrap
                dcSessionPrimed = false;
                renderBrowseError(grid, {
                    provider: 'datacat',
                    error: err,
                    message: `Load failed: ${err.message}`,
                    view: `browse/${datacatSortMode}`,
                    flags: { nsfw: datacatNsfwEnabled },
                    retry: () => view.reload({ force: true }),
                });
            }
            const retryBtn = document.getElementById('datacatRetryBtn');
            if (retryBtn) retryBtn.addEventListener('click', () => view.reload({ force: true }));
        }
    } finally {
        if (thisToken === datacatLoadToken) {
            datacatIsLoading = false;
            if (loadMoreBtn) {
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
            }
        }
    }

    // client filters can shrink a page to a sliver, so chain fetches until a full visible page lands (capped)
    if (Number.isFinite(visibleNew) && thisToken === datacatLoadToken && delegatesInitialized
        && datacatViewMode === 'browse' && datacatHasMore
        && (append || datacatCharacters.length > 0)) {
        datacatTopUpVisible += visibleNew;
        if (datacatTopUpVisible < PAGE_SIZE && datacatAutoTopUps < 3) {
            datacatAutoTopUps++;
            // Chained fetches bypass _triggerLoadMore, so drive the loading bar ourselves
            // (the next render's updateLoadMore restores it to hidden/end)
            datacatBrowseView._setScrollIndicator('loading');
            advanceDatacatPage();
            loadCharacters(true);
        }
    }
}

// ========================================
// FACETED TAG SYSTEM
// ========================================

async function loadFacetedTags() {
    if (datacatTagsLoaded || datacatTagsLoading) return;
    datacatTagsLoading = true;
    const container = document.getElementById('datacatTagsList');
    if (container) container.innerHTML = '<div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>';
    try {
        const data = await fetchFacetedTags({ activeTagIds: [...datacatActiveTagIds] });
        if (!data) {
            if (container) container.innerHTML = '<div class="browse-tags-empty">Failed to load tags</div>';
            return;
        }
        datacatTagGroups = data.groups || [];
        datacatTags = data.tags || [];
        datacatTagsLoaded = true;
        renderTagsList(document.getElementById('datacatTagsSearchInput')?.value || '');
        debugLog('[DatacatBrowse] Faceted tags loaded:', datacatTagGroups.length, 'groups,', datacatTags.length, 'tags');
    } catch (e) {
        console.error('[DatacatBrowse] Failed to load faceted tags:', e);
        if (container) container.innerHTML = '<div class="browse-tags-empty">Failed to load tags</div>';
    } finally {
        datacatTagsLoading = false;
    }
}

async function refreshTagCounts() {
    try {
        const data = await fetchFacetedTags({ activeTagIds: [...datacatActiveTagIds] });
        if (!data) return;
        datacatTags = data.tags || [];
        renderTagsList(document.getElementById('datacatTagsSearchInput')?.value || '');
    } catch (e) {
        debugLog('[DatacatBrowse] Tag count refresh failed:', e);
    }
}

function renderTagsList(filter = '') {
    const container = document.getElementById('datacatTagsList');
    if (!container) return;

    if (datacatTags.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No tags available</div>';
        return;
    }

    const filterLower = filter.toLowerCase();
    const matchesFilter = (tag) => {
        if (!filter) return true;
        const name = (tag.name || tag.slug || '').toLowerCase();
        const slug = (tag.slug || '').toLowerCase();
        return name.includes(filterLower) || slug.includes(filterLower);
    };

    const buildRow = (tag) => {
        const active = datacatActiveTagIds.has(tag.id);
        const stateClass = active ? 'state-include' : 'state-neutral';
        const stateIcon = active ? '<i class="fa-solid fa-plus"></i>' : '';
        const stateTitle = active ? 'Active: click to remove' : 'Click to filter';
        const countStr = tag.count != null ? ` (${formatNumber(tag.count)})` : '';
        const cleanName = (tag.name || tag.slug || '').replace(/^[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D]+\s*/u, '').trim() || tag.name;
        return `
            <div class="browse-tag-filter-item" data-tag-id="${escapeHtml(tag.id)}">
                <button class="browse-tag-state-btn ${stateClass}" title="${stateTitle}">${stateIcon}</button>
                <span class="tag-label">${escapeHtml(cleanName)}${countStr}</span>
            </div>
        `;
    };

    const groupIds = new Set(datacatTagGroups.map(g => g.id));
    const sortedGroups = [...datacatTagGroups].sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

    let html = '';
    for (const group of sortedGroups) {
        const groupTags = datacatTags
            .filter(t => t.groupId === group.id && matchesFilter(t))
            .sort((a, b) => (b.count || 0) - (a.count || 0));
        if (groupTags.length === 0) continue;
        html += `<div class="dropdown-section-title">${escapeHtml(group.name)}</div>`;
        html += groupTags.map(buildRow).join('');
    }

    // the ~76k-tag ungrouped tail renders through the library tag popup's chunked window; active tags pin first
    const ungrouped = datacatTags
        .filter(t => !groupIds.has(t.groupId) && matchesFilter(t))
        .sort((a, b) => {
            const aActive = datacatActiveTagIds.has(a.id) ? 0 : 1;
            const bActive = datacatActiveTagIds.has(b.id) ? 0 : 1;
            if (aActive !== bActive) return aActive - bActive;
            return (b.count || 0) - (a.count || 0);
        });

    if (!html && ungrouped.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    if (ungrouped.length > 0) {
        html += '<div class="dropdown-section-title">All Tags</div>';
    }
    container.innerHTML = html;

    const CHUNK = 250;
    let renderedCount = 0;
    const appendChunk = () => {
        const end = Math.min(renderedCount + CHUNK, ungrouped.length);
        if (end <= renderedCount) return;
        container.insertAdjacentHTML('beforeend', ungrouped.slice(renderedCount, end).map(buildRow).join(''));
        renderedCount = end;
    };
    appendChunk();
    container.onscroll = () => {
        if (renderedCount >= ungrouped.length) return;
        if (container.scrollTop + container.clientHeight >= container.scrollHeight - 200) appendChunk();
    };

    // Delegated so chunk appends dont re-bind and every row shares one handler
    container.onclick = (e) => {
        const item = e.target.closest('.browse-tag-filter-item');
        if (!item || !container.contains(item)) return;
        const tagId = Number(item.dataset.tagId);
        const tag = datacatTags.find(t => t.id === tagId);
        const group = tag ? datacatTagGroups.find(g => g.id === tag.groupId) : null;

        if (datacatActiveTagIds.has(tagId)) {
            datacatActiveTagIds.delete(tagId);
        } else {
            if (group?.exclusive) {
                for (const otherTag of datacatTags.filter(t => t.groupId === group.id)) {
                    datacatActiveTagIds.delete(otherTag.id);
                }
            }
            datacatActiveTagIds.add(tagId);
        }

        cycleTagState(item.querySelector('.browse-tag-state-btn'), datacatActiveTagIds.has(tagId));
        updateTagsButton();
        view.reload();
        refreshTagCounts();
    };
}

function cycleTagState(btn, active) {
    btn.className = 'browse-tag-state-btn';
    if (active) {
        btn.classList.add('state-include');
        btn.innerHTML = '<i class="fa-solid fa-plus"></i>';
        btn.title = 'Active: click to remove';
    } else {
        btn.classList.add('state-neutral');
        btn.innerHTML = '';
        btn.title = 'Click to filter';
    }
}

function updateTagsButton() {
    const btn = document.getElementById('datacatTagsBtn');
    if (!btn) return;

    // a JanitorAI sort sends no tags, so the greyed button counts none there
    const count = isHampterSortMode(datacatSortMode) ? 0 : isJannyTagMode()
        ? jannyActiveTagIds.size
        : datacatActiveTagIds.size;
    setFilterCount(btn, 'Tags', count);
}

// ========================================
// JANITORAI TAG SYSTEM (MeiliSearch + Hampter modes)
// ========================================

function isJannyTagMode() {
    return isJannySortMode(datacatSortMode);
}

// the active tags by id: the endpoints that take no tag params (a creator's list, the following feed) narrow here
function datacatTagsPass(c) {
    const ids = (c.tags || []).map(t => String(t?.id ?? t));
    return [...datacatActiveTagIds].every(id => ids.includes(String(id)));
}

function updateTagsVisibility() {
    const btn = document.getElementById('datacatTagsBtn');
    if (!btn) return;
    // datacat's JanitorAI sorts never wired a picker for the tag params they have, so Tags greys there, saying why
    const off = isHampterSortMode(datacatSortMode);
    btn.disabled = off;
    btn.classList.toggle('browse-option-disabled', off);
    btn.title = off ? 'Not available with JanitorAI sorts' : 'Tag filters';
    if (off) document.getElementById('datacatTagsDropdown')?.classList.add('hidden');
}

function updateSourceFilterVisibility() {
    const section = document.getElementById('datacatFilterSourceSection');
    if (!section) return;
    // source filters only where sources mix: hidden in single-source sorts, always shown on Following
    if (datacatViewMode === 'following') {
        section.hidden = false;
        return;
    }
    const isSingleSourceMode = isJannySortMode(datacatSortMode)
        || isHampterSortMode(datacatSortMode);
    section.hidden = isSingleSourceMode;
}

const JANNY_ALL_TAGS = Object.entries(JANNY_TAG_MAP)
    .map(([id, name]) => ({ id: Number(id), name }))
    .sort((a, b) => a.name.localeCompare(b.name));

function renderJannyTagsList(filter = '') {
    const container = document.getElementById('datacatTagsList');
    if (!container) return;

    const filtered = filter
        ? JANNY_ALL_TAGS.filter(t => t.name.toLowerCase().includes(filter.toLowerCase()))
        : JANNY_ALL_TAGS;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    container.innerHTML = filtered.map(tag => {
        const included = jannyActiveTagIds.has(tag.id);
        const stateClass = included ? 'state-include' : 'state-neutral';
        const stateIcon = included ? '<i class="fa-solid fa-plus"></i>' : '';
        const stateTitle = included ? 'Included: click to remove' : 'Click to include';
        return `
            <div class="browse-tag-filter-item" data-tag-id="${tag.id}">
                <button class="browse-tag-state-btn ${stateClass}" title="${stateTitle}">${stateIcon}</button>
                <span class="tag-label">${escapeHtml(tag.name)}</span>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const tagId = Number(item.dataset.tagId);
        item.addEventListener('click', () => {
            if (jannyActiveTagIds.has(tagId)) {
                jannyActiveTagIds.delete(tagId);
            } else {
                jannyActiveTagIds.add(tagId);
            }
            const btn = item.querySelector('.browse-tag-state-btn');
            cycleTagState(btn, jannyActiveTagIds.has(tagId));
            updateTagsButton();
            view.reload();
        });
    });
}

// ========================================
// SORT OPTIONS
// ========================================

const FRESH_SORT_LABELS = [
    { value: 'fresh', label: 'Freshest', icon: 'fa-seedling' },
    { value: 'score', label: 'Score', icon: 'fa-star' },
    { value: 'chat_count', label: 'Chat Count', icon: 'fa-comments' },
    { value: 'messages_per_chat', label: 'MSG/Chat', icon: 'fa-chart-simple' },
    { value: 'first_published', label: 'First Published', icon: 'fa-calendar-check' },
];

const CREATOR_SORT_OPTIONS = [
    { value: 'chat_count', label: 'Most Messages', icon: 'fa-comments' },
    { value: 'newest', label: 'Newest', icon: 'fa-calendar-plus' },
    { value: 'oldest', label: 'Oldest', icon: 'fa-hourglass' },
];

function isJannySortMode(mode) {
    return mode?.startsWith('janny_');
}

function isHampterSortMode(mode) {
    return mode?.startsWith('hampter_');
}

function parseSortMode(mode) {
    if (mode === 'recent') return null;
    if (isJannySortMode(mode)) return null;
    if (isHampterSortMode(mode)) return null;
    if (mode.endsWith('_week')) return { sortBy: mode.slice(0, -5), window: 'week' };
    if (mode.endsWith('_24h')) return { sortBy: mode.slice(0, -4), window: '24h' };
    return { sortBy: mode, window: '24h' };
}

const JANNY_SORT_OPTIONS = [
    { value: 'janny_newest', label: 'Newest', icon: 'fa-calendar-plus' },
    { value: 'janny_oldest', label: 'Oldest', icon: 'fa-hourglass' },
    { value: 'janny_tokens_desc', label: 'Most Tokens', icon: 'fa-weight-hanging' },
    { value: 'janny_tokens_asc', label: 'Least Tokens', icon: 'fa-feather' },
    { value: 'janny_relevant', label: 'Relevance', icon: 'fa-magnifying-glass' },
];

const HAMPTER_SORT_OPTIONS = [
    { value: 'hampter_latest', label: 'Latest', icon: 'fa-calendar-plus' },
    { value: 'hampter_trending', label: 'Trending', icon: 'fa-arrow-trend-up' },
    { value: 'hampter_trending24', label: 'Trending (24h)', icon: 'fa-arrow-trend-up' },
    { value: 'hampter_popular', label: 'Popular', icon: 'fa-fire' },
    { value: 'hampter_relevance', label: 'Relevance', icon: 'fa-magnifying-glass' },
];

// derived from the dropdown's own lists, so a sort retired since it was saved never goes upstream as a literal sortBy
function isKnownSortMode(mode) {
    if (mode === 'recent') return true;
    if (FRESH_SORT_LABELS.some(o => mode === `${o.value}_24h` || mode === `${o.value}_week`)) return true;
    if (HAMPTER_SORT_OPTIONS.some(o => o.value === mode)) return true;
    return JANNY_SORT_OPTIONS.some(o => o.value === mode);
}

function buildSortOptionsHtml(selected) {
    let html = `<option value="recent" data-icon="fa-solid fa-clock" ${selected === 'recent' ? 'selected' : ''}>Recent</option>`;
    html += '<optgroup label="Last 24 Hours">';
    for (const o of FRESH_SORT_LABELS) {
        const val = `${o.value}_24h`;
        html += `<option value="${val}" data-icon="fa-solid ${o.icon}" ${val === selected ? 'selected' : ''}>${o.label}</option>`;
    }
    html += '</optgroup><optgroup label="This Week">';
    for (const o of FRESH_SORT_LABELS) {
        const val = `${o.value}_week`;
        html += `<option value="${val}" data-icon="fa-solid ${o.icon}" ${val === selected ? 'selected' : ''}>${o.label}</option>`;
    }
    html += '</optgroup>';
    html += '<optgroup label="JanitorAI (Hampter)">';
    for (const o of HAMPTER_SORT_OPTIONS) {
        html += `<option value="${o.value}" data-icon="fa-solid ${o.icon}" ${o.value === selected ? 'selected' : ''}>${o.label}</option>`;
    }
    html += '</optgroup>';
    html += '<optgroup label="JanitorAI (MeiliSearch)">';
    for (const o of JANNY_SORT_OPTIONS) {
        html += `<option value="${o.value}" data-icon="fa-solid ${o.icon}" ${o.value === selected ? 'selected' : ''}>${o.label}</option>`;
    }
    html += '</optgroup>';
    return html;
}

function updateSortOptions() {
    const el = document.getElementById('datacatSortSelect');
    if (!el) return;
    const isCreator = datacatBrowseMode === 'creator';
    if (isCreator) {
        const current = datacatCreatorSortMode;
        el.innerHTML = CREATOR_SORT_OPTIONS.map(o =>
            `<option value="${o.value}" data-icon="fa-solid ${o.icon}" ${o.value === current ? 'selected' : ''}>${o.label}</option>`
        ).join('');
    } else {
        el.innerHTML = buildSortOptionsHtml(datacatSortMode);
    }
    el._customSelect?.refresh();
}

function sortCreatorResults(list, mode) {
    if (mode === 'chat_count') {
        list.sort((a, b) => getMsgCount(b) - getMsgCount(a) || getChatCount(b) - getChatCount(a));
    } else if (mode === 'newest') {
        list.sort((a, b) => {
            const da = new Date(a.createdAt || a.created_at || 0);
            const db = new Date(b.createdAt || b.created_at || 0);
            return db - da;
        });
    } else if (mode === 'oldest') {
        list.sort((a, b) => {
            const da = new Date(a.createdAt || a.created_at || 0);
            const db = new Date(b.createdAt || b.created_at || 0);
            return da - db;
        });
    }
}

// ========================================
// CREATOR BROWSING
// ========================================

async function browseCreator(creatorId) {
    if (!creatorId) return;
    const creator = await fetchDatacatCreator(creatorId);
    const name = creator?.userName || creatorId;
    view.enterCreatorScope(() => {
        datacatBrowseMode = 'creator';
        datacatCreatorId = creatorId;
        datacatCreatorName = name;
        datacatCharacters = [];
        datacatHasMore = true;
        datacatGridRenderedCount = 0;
        // the creator endpoints take no query, so the box shows nothing inert (the stash brings it back)
        datacatSearchQuery = '';
        meiliSearchQuery = '';
        hampterSearchQuery = '';
        const input = document.getElementById('datacatSearchInput');
        if (input) input.value = '';
        document.getElementById('datacatClearSearchBtn')?.classList.add('hidden');
        view._cdRef = { creatorId, name };
        const bannerName = document.getElementById('datacatCreatorBannerName');
        if (bannerName) bannerName.textContent = name;
        window.pushOverlayGuard?.();
        updateFollowButton(creatorId);
        datacatCreatorSortMode = 'chat_count';
        const creatorSortEl = document.getElementById('datacatCreatorSortSelect');
        if (creatorSortEl) creatorSortEl.value = 'chat_count';
    });
}

function clearCreatorFilter() {
    view.clearCreatorScope();
}

// A lookup replaced the grid: leave the scope if one was up, otherwise just repaint the listing.
function leaveScopeOrReload() {
    if (datacatBrowseMode === 'creator') view.clearCreatorScope();
    else view.reload();
}

// ========================================
// SEARCH
// ========================================

function updateSearchPlaceholder() {
    const input = document.getElementById('datacatSearchInput');
    if (!input) return;
    input.placeholder = 'Search characters or paste a URL...';
}

function doSearch() {
    const input = document.getElementById('datacatSearchInput');
    const val = (input?.value || '').trim();
    if (!val) {
        // an empty submit in scope exits it like the clear X does (mobile has no X)
        const inScope = datacatBrowseMode === 'creator';
        if (inScope) view.clearCreatorScope({ reload: false });
        if (input) input.value = '';
        document.getElementById('datacatClearSearchBtn')?.classList.add('hidden');
        if (inScope || meiliSearchQuery || hampterSearchQuery || datacatSearchQuery) {
            meiliSearchQuery = '';
            hampterSearchQuery = '';
            datacatSearchQuery = '';
            view.reload();
        }
        return;
    }

    // UUID -> browse creator
    const uuidMatch = val.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
    if (uuidMatch) {
        browseCreator(val);
        return;
    }

    // DataCat URL -> browse creator or look up character
    const url = parseProviderUrl(val);
    if (url) {
        if (/datacat\.run$/i.test(url.hostname)) {
            const charMatch = url.pathname.match(/\/characters?\/(?:[^/]+\/)*([a-f0-9-]{36})/i);
            if (charMatch) {
                fetchCharacterAndOpenPreview(charMatch[1]);
                return;
            }
            const creatorMatch = url.pathname.match(/\/creators?\/([a-f0-9-]{36})/i);
            if (creatorMatch) {
                browseCreator(creatorMatch[1]);
                return;
            }
        }

        // JanitorAI URL -> look up on DataCat, offer extraction if not found
        if (/^(www\.)?janitorai\.com$/i.test(url.hostname) || /^(www\.)?jannyai\.com$/i.test(url.hostname)) {
            const charMatch = url.pathname.match(/\/characters\/([a-f0-9-]{36})/i);
            if (charMatch) {
                lookupExternalCharacter(charMatch[1], val, 'janitor');
                return;
            }
        }
    }

    // a typed search is a generic query, so it leaves the scope; the typed term outranks the restored one
    if (datacatBrowseMode === 'creator') {
        view.clearCreatorScope({ reload: false });
        if (input) input.value = val;
        document.getElementById('datacatClearSearchBtn')?.classList.remove('hidden');
    }

    // Text search in Hampter mode
    if (isHampterSortMode(datacatSortMode)) {
        hampterSearchQuery = val;
        view.reload();
        return;
    }

    // Text search in MeiliSearch mode
    if (isJannySortMode(datacatSortMode)) {
        meiliSearchQuery = val;
        view.reload();
        return;
    }

    // Native text search on the DataCat feed (covers character and creator names)
    datacatSearchQuery = val;
    view.reload();
}

// recent-public's search matches creator names too, so this works with no cards loaded; exact name preferred
async function resolveCreatorFromFeed(name) {
    try {
        const data = await fetchRecentPublic({ limit: 50, offset: 0, search: name, minTotalTokens: 0 });
        const rows = data?.characters || [];
        const lower = name.toLowerCase();
        return rows.find(c => getCreatorName(c).toLowerCase() === lower)
            || rows.find(c => getCreatorName(c).toLowerCase().includes(lower))
            || null;
    } catch {
        return null;
    }
}

async function performDatacatCreatorSearch() {
    const input = document.getElementById('datacatCreatorSearchInput');
    const query = input?.value.trim();
    if (!query) {
        showToast('Please enter a creator name or URL', 'warning');
        return;
    }
    input.value = '';

    // URL detection
    const u = parseProviderUrl(query);
    if (u && /datacat\.run$/i.test(u.hostname)) {
        const creatorMatch = u.pathname.match(/\/creators?\/([a-f0-9-]{36})/i);
        if (creatorMatch) {
            browseCreator(creatorMatch[1]);
            return;
        }
    }

    const lowerQuery = query.toLowerCase();

    const routeFromHit = (hit) => {
        const creatorId = getCreatorId(hit);
        if (!creatorId) return false;
        browseCreator(creatorId);
        return true;
    };

    // Scan followed creators
    const followMatch = datacatFollowedCreators.find(c => c.name?.toLowerCase() === lowerQuery);
    if (followMatch) {
        browseCreator(followMatch.id);
        return;
    }

    // Scan currently loaded browse characters
    const browseMatch = datacatCharacters.find(c => getCreatorName(c).toLowerCase() === lowerQuery);
    if (browseMatch && routeFromHit(browseMatch)) return;

    // Scan following timeline characters
    const followingMatch = datacatFollowingCharacters.find(c => getCreatorName(c).toLowerCase() === lowerQuery);
    if (followingMatch && routeFromHit(followingMatch)) return;

    // Partial match fallback
    const partialFollow = datacatFollowedCreators.find(c => c.name?.toLowerCase().includes(lowerQuery));
    if (partialFollow) {
        browseCreator(partialFollow.id);
        return;
    }

    const partialBrowse = datacatCharacters.find(c => getCreatorName(c).toLowerCase().includes(lowerQuery));
    if (partialBrowse && routeFromHit(partialBrowse)) return;

    const partialFollowing = datacatFollowingCharacters.find(c => getCreatorName(c).toLowerCase().includes(lowerQuery));
    if (partialFollowing && routeFromHit(partialFollowing)) return;

    // Server-side: the feed search covers creator names, so unloaded creators resolve too
    const feedHit = await resolveCreatorFromFeed(query);
    if (feedHit && routeFromHit(feedHit)) return;

    showToast('Creator not found. Try pasting a DataCat creator URL instead.', 'warning');
}

async function fetchCharacterAndOpenPreview(characterId) {
    const grid = document.getElementById('datacatGrid');
    if (grid) {
        renderLoadingState(grid, 'Looking up character...', 'browse-loading');
    }

    try {
        const character = await fetchDatacatCharacter(characterId);
        if (character) {
            openPreviewModal(character);
        } else {
            showToast('Character not found on DataCat', 'error');
        }
        leaveScopeOrReload();
    } catch (e) {
        showToast(`Failed to look up character: ${e.message}`, 'error');
        leaveScopeOrReload();
    }
}

// ========================================
// EXTERNAL SOURCE LOOKUP + EXTRACTION (JanitorAI)
// ========================================

const EXTRACT_SOURCES = {
    janitor: {
        label: 'JanitorAI',
        icon: 'fa-solid fa-cat',
        urlBase: 'https://janitorai.com/characters/',
        notFoundCopy: 'JanitorAI character',
    },
};

async function lookupExternalCharacter(charId, originalUrl, source = 'janitor') {
    const grid = document.getElementById('datacatGrid');
    if (grid) {
        renderLoadingState(grid, 'Looking up character on DataCat...', 'browse-loading');
    }

    // the lookup replaces the grid, so a scope ends here; the preview or the panel owns what follows
    if (datacatBrowseMode === 'creator') view.clearCreatorScope({ reload: false });
    const loadMoreEl = document.getElementById('datacatLoadMore');
    if (loadMoreEl) loadMoreEl.hidden = true;

    try {
        const character = await fetchDatacatCharacter(charId, source);
        if (character) {
            openPreviewModal(character);
            view.reload();
            return;
        }
    } catch { /* not found */ }

    showExtractionPanel(charId, originalUrl, source);
}

function showExtractionPanel(charId, originalUrl, source = 'janitor') {
    const grid = document.getElementById('datacatGrid');
    if (!grid) return;

    const cfg = EXTRACT_SOURCES[source] || EXTRACT_SOURCES.janitor;
    const sourceUrl = originalUrl || `${cfg.urlBase}${charId}`;
    const shortId = charId.substring(0, 8);

    grid.innerHTML = `
        <div class="datacat-extract-panel u-span-all">
            <div class="datacat-extract-icon">
                <i class="${cfg.icon}"></i>
            </div>
            <h3>Character Not on DataCat</h3>
            <p class="datacat-extract-desc">
                This ${cfg.notFoundCopy} (<code>${escapeHtml(shortId)}...</code>) hasn't been extracted yet.
                DataCat can retrieve its definition using a cloud browser instance.
            </p>
            <p class="datacat-extract-note">
                <i class="fa-solid fa-circle-info"></i>
                Extraction typically takes 15-60 seconds. A public account is used by default.
            </p>
            <div class="datacat-extract-actions">
                <button id="datacatExtractBtn" class="cl-btn cl-btn-primary" data-url="${escapeHtml(sourceUrl)}" data-id="${escapeHtml(charId)}" data-source="${escapeHtml(source)}">
                    <i class="fa-solid fa-cloud-arrow-down"></i> Extract Character
                </button>
                <a href="${escapeHtml(sourceUrl)}" target="_blank" class="cl-btn cl-btn-secondary">
                    <i class="fa-solid fa-external-link"></i> View on ${cfg.label}
                </a>
            </div>
            <div id="datacatExtractProgress" class="datacat-extract-progress hidden"></div>
        </div>
    `;

    const extractBtn = document.getElementById('datacatExtractBtn');
    if (extractBtn) {
        extractBtn.addEventListener('click', () => {
            startExtraction(extractBtn.dataset.url, extractBtn.dataset.id, extractBtn.dataset.source || 'janitor');
        });
    }
}

async function startExtraction(janitorUrl, janitorId, source = 'janitor') {
    const extractBtn = document.getElementById('datacatExtractBtn');
    const progressEl = document.getElementById('datacatExtractProgress');
    if (!extractBtn || !progressEl) return;

    extractBtn.disabled = true;
    extractBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting...';
    progressEl.classList.remove('hidden');
    progressEl.innerHTML = `
        <div class="datacat-extract-status">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <span>Submitting extraction request...</span>
        </div>
    `;

    extractionStartTime = Date.now();

    try {
        const result = await submitExtraction(janitorUrl, { publicFeed: getSetting('datacatPublicFeed') === true });

        if (result.queued || result.started) {
            extractBtn.innerHTML = '<i class="fa-solid fa-hourglass-half"></i> Extracting...';
            const position = result.queued ? ` (queue position: ${result.queuePosition || 1})` : '';
            updateExtractionProgress('pending', result.queued ? `Queued for extraction${position}` : 'Extraction started, waiting for completion...');
            startExtractionPolling(janitorId, source);
        } else if (result.requiresLogin) {
            extractBtn.disabled = false;
            extractBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Extract Character';
            updateExtractionProgress('error', 'DataCat has no valid session. The extraction service may be temporarily unavailable.');
        } else if (result.error || result.errorCode) {
            extractBtn.disabled = false;
            extractBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
            updateExtractionProgress('error', result.message || result.error || 'Extraction failed');
        } else {
            extractBtn.disabled = false;
            extractBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
            updateExtractionProgress('error', 'Unexpected response from DataCat');
        }
    } catch (e) {
        extractBtn.disabled = false;
        extractBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
        updateExtractionProgress('error', `Failed to submit: ${e.message}`);
    }
}

function humanizeExtractionError(msg) {
    if (!msg) return 'Extraction failed';
    if (/CHARACTER_NOT_FOUND_OR_SET_TO_PRIVATE/i.test(msg)) return 'Character not found or privated';
    if (/WORKER.?ERROR/i.test(msg)) return msg.replace(/WORKER.?ERROR\s*\(?/i, '').replace(/\)$/, '').trim() || 'Extraction failed';
    return msg;
}

function updateExtractionProgress(status, message) {
    const progressEl = document.getElementById('datacatExtractProgress');
    if (!progressEl) return;

    let icon, colorClass;
    switch (status) {
        case 'pending':
            icon = 'fa-solid fa-spinner fa-spin';
            colorClass = 'datacat-extract-pending';
            break;
        case 'success':
            icon = 'fa-solid fa-check-circle';
            colorClass = 'datacat-extract-success';
            break;
        case 'error':
            icon = 'fa-solid fa-exclamation-circle';
            colorClass = 'datacat-extract-error';
            break;
        default:
            icon = 'fa-solid fa-circle-info';
            colorClass = '';
    }

    const elapsed = extractionStartTime ? Math.round((Date.now() - extractionStartTime) / 1000) : 0;
    const elapsedText = elapsed > 0 && status === 'pending' ? ` <span class="datacat-extract-elapsed">(${elapsed}s)</span>` : '';

    progressEl.innerHTML = `
        <div class="datacat-extract-status ${colorClass}">
            <i class="${icon}"></i>
            <span>${escapeHtml(message)}${elapsedText}</span>
        </div>
    `;
}

function startExtractionPolling(janitorId, source = 'janitor') {
    stopExtractionPolling();

    let elapsedTimer = setInterval(() => {
        const progressEl = document.getElementById('datacatExtractProgress');
        if (!progressEl || !extractionStartTime) { clearInterval(elapsedTimer); return; }
        const statusEl = progressEl.querySelector('.datacat-extract-elapsed');
        if (statusEl) {
            const elapsed = Math.round((Date.now() - extractionStartTime) / 1000);
            statusEl.textContent = `(${elapsed}s)`;
        }
    }, 1000);

    extractionPollTimer = setInterval(async () => {
        try {
            const status = await fetchExtractionStatus();
            if (!status) return;

            const completedEntry = status.history?.find(h => {
                const historyId = String(h.characterId || '').trim();
                return historyId === janitorId;
            });

            if (completedEntry) {
                clearInterval(elapsedTimer);
                stopExtractionPolling();

                if (completedEntry.success !== false && completedEntry.status !== 'error') {
                    updateExtractionProgress('success', 'Extraction complete! Loading character...');
                    setTimeout(() => fetchExtractedCharacter(janitorId, source), 1000);
                } else {
                    const errMsg = humanizeExtractionError(completedEntry.error || completedEntry.message);
                    updateExtractionProgress('error', errMsg);
                    const extractBtn = document.getElementById('datacatExtractBtn');
                    if (extractBtn) {
                        extractBtn.disabled = false;
                        extractBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
                    }
                }
                return;
            }

            // Still in progress: update status text
            if (status.inProgress) {
                const phase = status.inProgress.status || 'processing';
                const phaseNames = {
                    opening_page: 'Opening character page',
                    preparing: 'Preparing extraction',
                    initiating: 'Initiating extraction',
                    pulling: 'Pulling character data',
                    post_extract: 'Finalizing',
                    complete: 'Completing',
                };
                const phaseName = phaseNames[phase] || phase.replace(/_/g, ' ');
                updateExtractionProgress('pending', phaseName + '...');
            } else if (status.queueLength > 0) {
                updateExtractionProgress('pending', `Waiting in queue (${status.queueLength} ahead)...`);
            }
        } catch (e) {
            debugLog('[DatacatBrowse] Extraction poll error:', e);
        }
    }, 3000);
}

function stopExtractionPolling() {
    if (extractionPollTimer) {
        clearInterval(extractionPollTimer);
        extractionPollTimer = null;
    }
}

function clearExtractionState() {
    stopExtractionPolling();
    extractionStartTime = null;
}

async function fetchExtractedCharacter(janitorId, source = 'janitor') {
    try {
        const character = await fetchDatacatCharacter(janitorId, source);
        if (character) {
            character._fullCharacter = character;
            openPreviewModal(character);
            return;
        }
        // Might need a brief delay for DataCat indexing
        await new Promise(r => setTimeout(r, 2000));
        const retry = await fetchDatacatCharacter(janitorId, source);
        if (retry) {
            retry._fullCharacter = retry;
            openPreviewModal(retry);
            return;
        }
        updateExtractionProgress('success', 'Extraction complete, but the character could not be loaded yet. Try searching again in a moment.');
    } catch (e) {
        updateExtractionProgress('error', `Character extracted but failed to load: ${e.message}`);
    }
}

// ========================================
// MODAL EXTRACTION (extract from preview modal)
// ========================================

function updateInlineExtractionCTA(state, detail) {
    const cta = document.querySelector('.datacat-modal-extract-cta');
    if (!cta) return;
    const iconWrap = cta.querySelector('.datacat-modal-extract-icon-wrap');
    const message = cta.querySelector('.datacat-modal-extract-message');
    const hint = cta.querySelector('.datacat-modal-extract-hint');
    const btn = cta.querySelector('.datacat-modal-extract-btn');

    cta.classList.remove('extracting', 'success', 'error');

    if (state === 'submitting') {
        cta.classList.add('extracting');
        if (iconWrap) iconWrap.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin datacat-modal-extract-icon"></i>';
        if (message) message.textContent = 'Submitting extraction request...';
        if (hint) hint.textContent = '';
        if (btn) btn.hidden = true;
    } else if (state === 'extracting') {
        cta.classList.add('extracting');
        if (iconWrap) iconWrap.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin datacat-modal-extract-icon"></i>';
        if (message) message.textContent = 'Extraction in progress';
        if (hint) hint.textContent = detail || '';
        if (btn) btn.hidden = true;
    } else if (state === 'progress') {
        if (message) message.textContent = detail || 'Extracting...';
    } else if (state === 'done') {
        cta.classList.add('success');
        if (iconWrap) iconWrap.innerHTML = '<i class="fa-solid fa-circle-check datacat-modal-extract-icon"></i>';
        if (message) message.textContent = 'Extraction complete';
        if (hint) hint.textContent = 'Loading character...';
        if (btn) btn.hidden = true;
    } else if (state === 'error') {
        cta.classList.add('error');
        if (iconWrap) iconWrap.innerHTML = '<i class="fa-solid fa-triangle-exclamation datacat-modal-extract-icon"></i>';
        if (message) message.textContent = detail || 'Extraction failed';
        if (hint) hint.textContent = 'Try again or check back later.';
        if (btn) { btn.disabled = false; btn.hidden = false; btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry'; }
    }
}

async function startModalExtraction(charId, source = 'janitor') {
    const importBtn = document.getElementById('datacatImportBtn');
    if (!importBtn) return;

    const cfg = EXTRACT_SOURCES[source] || EXTRACT_SOURCES.janitor;
    const sourceUrl = `${cfg.urlBase}${charId}`;

    importBtn.disabled = true;
    importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting...';
    updateInlineExtractionCTA('submitting');

    extractionStartTime = Date.now();

    try {
        const result = await submitExtraction(sourceUrl, { publicFeed: getSetting('datacatPublicFeed') === true });

        if (result.queued || result.started) {
            importBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Extracting...';
            const position = result.queued ? ` (${result.queuePosition || 1})` : '';
            updateInlineExtractionCTA('extracting', position.trim() ? `Queue position${position}` : '');
            startModalExtractionPolling(charId, source);
        } else if (result.requiresLogin) {
            importBtn.disabled = false;
            importBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Extract';
            updateInlineExtractionCTA('error', 'Session unavailable');
            showToast('DataCat has no valid session. The extraction service may be temporarily unavailable.', 'error');
        } else {
            importBtn.disabled = false;
            importBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
            updateInlineExtractionCTA('error', result.message || result.error || 'Extraction failed');
            showToast(result.message || result.error || 'Extraction failed', 'error');
        }
    } catch (e) {
        importBtn.disabled = false;
        importBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
        updateInlineExtractionCTA('error', e.message);
        showToast(`Failed to submit extraction: ${e.message}`, 'error');
    }
}

function startModalExtractionPolling(charId, source = 'janitor') {
    stopExtractionPolling();

    const importBtn = document.getElementById('datacatImportBtn');

    let elapsedTimer = setInterval(() => {
        if (!importBtn || !extractionStartTime) { clearInterval(elapsedTimer); return; }
        const elapsed = Math.round((Date.now() - extractionStartTime) / 1000);
        if (importBtn.disabled) {
            const phase = importBtn.dataset.extractPhase || 'Extracting';
            const label = `${phase}... (${elapsed}s)`;
            updateInlineExtractionCTA('progress', label);
        }
    }, 1000);

    extractionPollTimer = setInterval(async () => {
        try {
            const status = await fetchExtractionStatus();
            if (!status) return;

            const completedEntry = status.history?.find(h => {
                const historyId = String(h.characterId || '').trim();
                return historyId === charId;
            });

            if (completedEntry) {
                clearInterval(elapsedTimer);
                clearExtractionState();

                if (completedEntry.success !== false && completedEntry.status !== 'error') {
                    if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-check-circle"></i> Done, loading...';
                    updateInlineExtractionCTA('done');
                    showToast('Extraction complete, loading the character', 'success');
                    await new Promise(r => setTimeout(r, 1000));
                    try {
                        const character = await fetchDatacatCharacter(charId, source);
                        if (character) {
                            character._fullCharacter = character;
                            openPreviewModal(character);
                            return;
                        }
                        await new Promise(r => setTimeout(r, 2000));
                        const retry = await fetchDatacatCharacter(charId, source);
                        if (retry) {
                            retry._fullCharacter = retry;
                            openPreviewModal(retry);
                            return;
                        }
                        showToast('Character extracted but not yet available. Try searching again.', 'warning');
                    } catch (e) {
                        showToast(`Extracted but failed to load: ${e.message}`, 'error');
                    }
                    if (importBtn) {
                        importBtn.disabled = false;
                        importBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
                    }
                    updateInlineExtractionCTA('error', 'Extracted but failed to load');
                } else {
                    const errMsg = humanizeExtractionError(completedEntry.error || completedEntry.message);
                    showToast(errMsg, 'error');
                    if (importBtn) {
                        importBtn.disabled = false;
                        importBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Retry';
                    }
                    updateInlineExtractionCTA('error', errMsg);
                }
                return;
            }

            if (status.inProgress) {
                const phase = status.inProgress.status || 'processing';
                const phaseNames = {
                    opening_page: 'Opening page',
                    preparing: 'Preparing',
                    initiating: 'Initiating',
                    pulling: 'Pulling data',
                    post_extract: 'Finalizing',
                    complete: 'Completing',
                };
                if (importBtn) importBtn.dataset.extractPhase = phaseNames[phase] || phase.replace(/_/g, ' ');
            } else if (status.queueLength > 0 && importBtn) {
                importBtn.dataset.extractPhase = `Queue (${status.queueLength})`;
            }
        } catch (e) {
            debugLog('[DatacatBrowse] Modal extraction poll error:', e);
        }
    }, 3000);
}

// ========================================
// FOLLOWING (local creator follow)
// ========================================

function loadFollowedCreators() {
    const saved = getSetting('datacatFollowedCreators');
    datacatFollowedCreators = Array.isArray(saved) ? saved : [];
}

function saveFollowedCreators() {
    setSetting('datacatFollowedCreators', datacatFollowedCreators);
}

function isCreatorFollowed(creatorId, source = 'datacat') {
    return datacatFollowedCreators.some(c => c.id === creatorId && c.source === source);
}

function followCreator(creatorId, creatorName, source = 'datacat') {
    if (isCreatorFollowed(creatorId, source)) return;
    datacatFollowedCreators.push({ id: creatorId, name: creatorName || creatorId, source });
    saveFollowedCreators();
    updateFollowButton(creatorId, source);
    showToast(`Followed ${creatorName || 'creator'}`, 'success');
}

function unfollowCreator(creatorId, source = 'datacat') {
    const idx = datacatFollowedCreators.findIndex(c => c.id === creatorId && (c.source || 'datacat') === source);
    if (idx === -1) return;
    const name = datacatFollowedCreators[idx].name;
    datacatFollowedCreators.splice(idx, 1);
    saveFollowedCreators();
    updateFollowButton(creatorId, source);
    showToast(`Unfollowed ${name || 'creator'}`, 'info');
}

function updateFollowButton(creatorId, source = 'datacat') {
    const btn = document.getElementById('datacatFollowCreatorBtn');
    if (!btn) return;

    if (datacatBrowseMode !== 'creator' || datacatCreatorId !== creatorId) return;
    if (source !== 'datacat') return;

    if (isCreatorFollowed(creatorId, source)) {
        btn.classList.add('active');
        btn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
        btn.title = 'Unfollow this creator';
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '<i class="fa-regular fa-heart"></i> <span>Follow</span>';
        btn.title = 'Follow this creator';
    }
    btn.hidden = false;
}

function setDatacatModeChrome(mode) {
    const browseSortEl = document.getElementById('datacatSortSelect');
    const followingSortEl = document.getElementById('datacatFollowingSortSelect');
    const bsTarget = browseSortEl?._customSelect?.container || browseSortEl;
    const fsTarget = followingSortEl?._customSelect?.container || followingSortEl;
    if (bsTarget) bsTarget.classList.toggle('hidden', mode !== 'browse');
    if (fsTarget) fsTarget.classList.toggle('hidden', mode === 'browse');
}

// prime the session (saved token, else a fresh anonymous one); every mode's first load chains it
async function primeDcSession() {
    const savedToken = getSetting('datacatToken') || null;
    const token = await initDcSession(savedToken);
    if (token && token !== savedToken) setSetting('datacatToken', token);
    return token;
}

// The browse mode's load hook: a failed init renders the retryable error state
// instead of a load.
async function bootstrapDcSession() {
    const g = document.getElementById('datacatGrid');
    if (g) renderSkeletonGrid(g);
    const token = await primeDcSession();
    if (token) {
        dcSessionPrimed = true;
        loadCharacters(false);
    } else {
        renderBrowseError(document.getElementById('datacatGrid'), {
            provider: 'datacat',
            error: new Error('Failed to initialize a DataCat session (/dc-init returned no token)'),
            message: 'Failed to initialize a DataCat session. DataCat may be temporarily unavailable.',
            retry: bootstrapDcSession,
        });
    }
}

function switchDatacatViewMode(mode) {
    return datacatBrowseView.switchViewMode(mode);
}

async function loadFollowingCharacters(forceRefresh = false) {
    if (datacatFollowingLoading) return;
    datacatFollowingLoading = true;

    const grid = document.getElementById('datacatFollowingGrid');

    if (forceRefresh) {
        datacatFollowingCharacters = [];
        datacatFollowingDisplayLimit = 60;
    }

    loadFollowedCreators();

    if (datacatFollowedCreators.length === 0) {
        renderFollowingEmpty('no_follows');
        datacatFollowingLoading = false;
        return;
    }

    if (grid) {
        renderSkeletonGrid(grid);
    }

    try {
        const existingIds = new Set(datacatFollowingCharacters.map(c => getCharId(c)));
        const BATCH_SIZE = 3;

        for (let i = 0; i < datacatFollowedCreators.length; i += BATCH_SIZE) {
            const batch = datacatFollowedCreators.slice(i, i + BATCH_SIZE);
            const promises = batch.map(async (creator) => {
                try {
                    const allChars = [];
                    // a follow saved from another source stays in the list, unloaded
                    if ((creator.source || 'datacat') !== 'datacat') return allChars;

                    let offset = 0;
                    const limit = 50;
                    while (true) {
                        // Tolerant like the CD adapter: a failed page keeps what this creator
                        // already contributed instead of discarding the partial list
                        const data = await fetchDatacatCreatorCharacters(creator.id, {
                            limit,
                            offset,
                            sortBy: 'newest'
                        }).catch(() => null);
                        if (!data) break;
                        const list = data.list || [];
                        for (const c of list) {
                            allChars.push({
                                ...c,
                                _followedCreatorName: creator.name,
                                _followedCreatorId: creator.id,
                                _followedCreatorSource: 'datacat',
                            });
                        }
                        if (list.length < limit || allChars.length >= (data?.total || 0)) break;
                        offset += limit;
                    }
                    return allChars;
                } catch (e) {
                    debugLog('[DatacatFollowing] Error fetching from creator:', creator.name, e.message);
                    return [];
                }
            });

            const results = await Promise.all(promises);
            for (const chars of results) {
                for (const c of chars) {
                    const id = getCharId(c);
                    if (id && !existingIds.has(id)) {
                        existingIds.add(id);
                        datacatFollowingCharacters.push(c);
                    }
                }
            }
        }

        debugLog('[DatacatFollowing] Total characters from followed creators:', datacatFollowingCharacters.length);

        if (datacatFollowingCharacters.length === 0) {
            renderFollowingEmpty('empty');
            datacatFollowingLoading = false;
            return;
        }

        await datacatBrowseView.probeHits(datacatFollowingCharacters);
        renderFollowing();

    } catch (err) {
        console.error('[DatacatFollowing] Error loading timeline:', err);
        if (grid) {
            renderBrowseError(grid, {
                provider: 'datacat',
                error: err,
                title: 'Error loading timeline',
                view: 'timeline',
                flags: { nsfw: datacatNsfwEnabled },
                retry: () => loadFollowingCharacters(true),
            });
        }
    } finally {
        datacatFollowingLoading = false;
    }
}

function renderFollowingEmpty(reason) {
    const grid = document.getElementById('datacatFollowingGrid');
    if (!grid) return;

    if (reason === 'no_follows') {
        grid.innerHTML = `
            <div class="browse-timeline-empty">
                <i class="fa-solid fa-user-plus"></i>
                <h3>No Followed Creators</h3>
                <p>Browse characters and follow creators from their banner to see their characters here.</p>
            </div>
        `;
    } else {
        grid.innerHTML = `
            <div class="browse-timeline-empty">
                <i class="fa-solid fa-inbox"></i>
                <h3>No Characters Yet</h3>
                <p>Creators you follow haven't posted characters yet.</p>
            </div>
        `;
    }
}

function sortFollowingCharacters(characters) {
    const sorted = [...characters];
    switch (datacatFollowingSort) {
        case 'newest':
            return sorted.sort((a, b) => {
                const da = new Date(a.createdAt || a.created_at || 0);
                const db = new Date(b.createdAt || b.created_at || 0);
                return db - da;
            });
        case 'oldest':
            return sorted.sort((a, b) => {
                const da = new Date(a.createdAt || a.created_at || 0);
                const db = new Date(b.createdAt || b.created_at || 0);
                return da - db;
            });
        case 'name_asc':
            return sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        case 'name_desc':
            return sorted.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
        case 'chat_count':
            return sorted.sort((a, b) => getChatCount(b) - getChatCount(a));
        default:
            return sorted;
    }
}

function _handleFollowingCardClick(e) {
    const authorLink = e.target.closest('.browse-card-creator-link');
    if (authorLink) {
        e.stopPropagation();
        const creatorId = authorLink.dataset.creatorId;
        if (creatorId) browseCreator(creatorId);
        return;
    }
    const card = e.target.closest('.browse-card');
    if (!card) return;
    const charId = card.dataset.datacatId;
    if (!charId) return;
    const hit = datacatFollowingCharacters.find(c => String(getCharId(c)) === charId);
    if (hit) openPreviewModal(hit);
}

function renderFollowing(append = false) {
    const grid = document.getElementById('datacatFollowingGrid');
    if (!grid) return;

    let source = datacatFollowingCharacters;

    let filtered = datacatNsfwEnabled
        ? source
        : source.filter(c => !isNsfw(c));

    const activeRows = activeFeatureRows(DATACAT_FEATURE_FILTERS, datacatFeatureState);
    if (activeRows.length > 0) {
        filtered = filtered.filter(c => featurePasses(c, activeRows));
    }

    // the following feed takes no tag params, so the tags the Tags button counts narrow it here
    if (!isHampterSortMode(datacatSortMode) && !isJannyTagMode() && datacatActiveTagIds.size > 0) filtered = filtered.filter(datacatTagsPass);

    const dcPersistentExclude = view.persistentExcludeTags();
    if (dcPersistentExclude.length > 0) {
        const lowerExclude = dcPersistentExclude.map(t => t.toLowerCase());
        filtered = filtered.filter(c => {
            const names = resolveTagNames(c.tags || []).map(n => n.toLowerCase());
            return !lowerExclude.some(et => names.includes(et));
        });
    }

    const sorted = sortFollowingCharacters(filtered);
    datacatFollowingFiltered = sorted;

    if (sorted.length === 0 && datacatFollowingCharacters.length > 0) {
        grid.innerHTML = `
            <div class="browse-timeline-empty">
                <i class="fa-solid fa-filter"></i>
                <h3>No Matching Characters</h3>
                <p>No characters match your current filters.</p>
            </div>
        `;
        datacatBrowseView.updateLoadMoreVisibility('datacatFollowingLoadMore', false, false);
        return;
    }

    if (append) {
        const existingCount = grid.querySelectorAll('.browse-card').length;
        const newSlice = sorted.slice(existingCount, datacatFollowingDisplayLimit);
        if (newSlice.length > 0) {
            grid.insertAdjacentHTML('beforeend', newSlice.map(c => createDatacatCard(c)).join(''));
            datacatBrowseView.observeImages(grid);
        }
    } else {
        const page = sorted.slice(0, datacatFollowingDisplayLimit);
        grid.innerHTML = page.map(c => createDatacatCard(c)).join('');
        datacatBrowseView.observeImages(grid);
    }

    const hasMore = datacatFollowingDisplayLimit < sorted.length;
    datacatBrowseView.updateLoadMoreVisibility('datacatFollowingLoadMore', hasMore, sorted.length > 0);
}

// ========================================
// PREVIEW MODAL
// ========================================

let datacatDetailFetchToken = 0;
let datacatDetailFetchPromise = null;
let datacatLastCreatorNotes = '';

// the import button's settled state, from the detail (the creator's name is the detail's); a
// button mid-extraction keeps its phase
function stampDatacatImport(hit, character) {
    const importBtn = document.getElementById('datacatImportBtn');
    if (!importBtn || importBtn.dataset.extractId) return;
    const inLibrary = view.isHitInLibrary(hit);
    const creatorName = character?.creator_name || character?.creatorName || hit.creator_name || '';
    view.stampImportButton(importBtn, { inLibrary, possibleMatch: !inLibrary && view.isCharPossibleMatch(character?.name || hit.name || '', creatorName) });
}

function openPreviewModal(hit) {
    datacatSelectedChar = hit;
    datacatSelectedDetail = null;
    // the import button tracks the library while open: from the detail once it lands, In Library alone before
    view.trackPreview(() => {
        if (datacatSelectedChar !== hit) return;
        if (datacatSelectedDetail) return stampDatacatImport(hit, datacatSelectedDetail);
        if (view.isHitInLibrary(hit)) view.stampImportButton(document.getElementById('datacatImportBtn'), { inLibrary: true });
    }, hit);

    // the modal may open from outside the Online tab (Open on DataCat from the link modal), so inject and wire it
    view.injectModals();
    ensureModalEventsAttached();

    const modal = document.getElementById('datacatCharModal');
    if (!modal) return;
    CoreAPI.resetBrowseSectionCollapseState(modal);

    const charId = getCharId(hit);
    const name = hit.name || 'Unknown';
    // Modal header renders ~150px; a thumbnail avoids decoding the full janitorai original on open
    const avatarUrl = resolveDatacatAvatarUrl(hit, { width: 600 }) || '/img/no-portrait.png';
    const tags = resolveTagNames(hit.tags || []);
    const creatorName = getCreatorName(hit) || 'Unknown';
    const inLibrary = view.isHitInLibrary(hit);

    const chatCount = getChatCount(hit);
    const msgCount = getMsgCount(hit);
    const totalTokens = getTotalTokens(hit);
    const createdDate = getCreatedDate(hit) || 'Unknown';

    // clear the last card's image first: an img keeps its old content until the new src decodes
    const avatarImg = document.getElementById('datacatCharAvatar');
    if (avatarImg.getAttribute('src') !== avatarUrl) avatarImg.removeAttribute('src');
    // Full-res (no width param) for the avatar viewer; the square itself stays a thumbnail
    avatarImg.dataset.full = resolveDatacatAvatarUrl(hit, { preferOriginal: true }) || avatarUrl;
    BrowseView.setPreviewPortrait(avatarImg, avatarUrl);
    document.getElementById('datacatCharName').textContent = name;
    document.getElementById('datacatCharCreator').textContent = creatorName;
    const openBtn = document.getElementById('datacatOpenInBrowserBtn');
    if (openBtn) {
        openBtn.href = `${DATACAT_API_BASE}/characters/${charId}`;
        openBtn.title = 'Open on DataCat';
    }

    // Stats (adapt to available data)
    const chatsEl = document.getElementById('datacatCharChats');
    const msgsEl = document.getElementById('datacatCharMessages');
    const tokensEl = document.getElementById('datacatCharTokens');
    const dateEl = document.getElementById('datacatCharDate');

    if (chatsEl) chatsEl.textContent = formatNumber(chatCount);
    if (msgsEl) msgsEl.textContent = formatNumber(msgCount);
    if (tokensEl) tokensEl.textContent = formatNumber(totalTokens);
    if (dateEl) dateEl.textContent = createdDate;

    // Tags
    const tagsEl = document.getElementById('datacatCharTags');
    tagsEl.innerHTML = tags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');

    // Skeleton until fetch resolves source; painting twice rebuilds the iframe and flashes.
    const creatorNotesSection = document.getElementById('datacatCharCreatorNotesSection');
    const creatorNotesEl = document.getElementById('datacatCharCreatorNotes');
    datacatLastCreatorNotes = '';
    if (creatorNotesSection && creatorNotesEl) {
        cleanupCreatorNotesContainer(creatorNotesEl);
        creatorNotesSection.hidden = false;
        creatorNotesEl.innerHTML = skeletonLines(2);
    }

    // Definition sections: all hidden, single loading indicator shown
    const defLoading = document.getElementById('datacatCharDefinitionLoading');
    if (defLoading) defLoading.hidden = false;
    const descSection = document.getElementById('datacatCharDescriptionSection');
    const scenarioSection = document.getElementById('datacatCharScenarioSection');
    const mesExampleSection = document.getElementById('datacatCharMesExampleSection');
    const firstMsgSection = document.getElementById('datacatCharFirstMsgSection');
    // Body sections stay hidden until fetch resolves; defLoading covers the wait.
    if (descSection) descSection.hidden = true;
    if (scenarioSection) scenarioSection.hidden = true;
    if (mesExampleSection) mesExampleSection.hidden = true;
    if (firstMsgSection) firstMsgSection.hidden = true;

    // Hide alt greetings + greetings stat until download data arrives
    const altGreetingsSection = document.getElementById('datacatCharAltGreetingsSection');
    if (altGreetingsSection) altGreetingsSection.hidden = true;
    const greetingsStat = document.getElementById('datacatCharGreetingsStat');
    if (greetingsStat) greetingsStat.hidden = true;
    CoreAPI.setBrowseAltGreetings([]);

    // Hide linked-lorebooks section + stat until detail fetch reveals scripts
    const lorebooksSection = document.getElementById('datacatCharLorebooksSection');
    if (lorebooksSection) lorebooksSection.hidden = true;
    const lorebookStat = document.getElementById('datacatCharLorebookStat');
    if (lorebookStat) lorebookStat.hidden = true;
    const lorebooksList = document.getElementById('datacatCharLorebooksList');
    if (lorebooksList) lorebooksList.innerHTML = '';

    // Import button - neutral loading state until definition fetch resolves
    const importBtn = document.getElementById('datacatImportBtn');
    delete importBtn.dataset.extractId;
    delete importBtn.dataset.extractPhase;
    if (inLibrary) {
        view.stampImportButton(importBtn, { inLibrary: true });
    } else {
        importBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Loading...';
        importBtn.classList.remove('cl-btn-primary', 'cl-btn-secondary', 'cl-btn-warning');
        importBtn.classList.add('cl-btn-secondary');
        importBtn.disabled = true;
    }

    modal.classList.remove('hidden');
    const charBody = modal.querySelector('.browse-char-body');
    if (charBody) charBody.scrollTop = 0;

    // Fetch full details in background
    const fetchToken = ++datacatDetailFetchToken;
    datacatDetailFetchPromise = fetchAndPopulateDetails(hit, fetchToken);
}

async function fetchAndPopulateDetails(hit, token) {
    const charId = getCharId(hit);
    const name = hit.name || 'Unknown';

    function showExtractionCTA(message) {
        const source = 'janitor';
        const cfg = EXTRACT_SOURCES[source];
        // Unextracted cards have no body fields, so skeletons left from modal-open never resolve.
        hideSections(['datacatCharScenarioSection', 'datacatCharFirstMsgSection', 'datacatCharMesExampleSection']);
        // No extraction means hit.description is all the creator-blurb we'll ever get.
        const immediateDesc = (hit.description || '').trim();
        const ctaNotesSection = document.getElementById('datacatCharCreatorNotesSection');
        const ctaNotesEl = document.getElementById('datacatCharCreatorNotes');
        if (ctaNotesSection && ctaNotesEl) {
            if (immediateDesc) {
                ctaNotesSection.hidden = false;
                datacatLastCreatorNotes = immediateDesc;
                if (!ctaNotesEl.querySelector('iframe')) ctaNotesEl.innerHTML = skeletonLines(3);
                deferCall(ctaNotesEl, () => renderCreatorNotesSecure(immediateDesc, name, ctaNotesEl));
            } else {
                ctaNotesSection.hidden = true;
                cleanupCreatorNotesContainer(ctaNotesEl);
            }
        }
        const descSection = document.getElementById('datacatCharDescriptionSection');
        const descEl = document.getElementById('datacatCharDescription');
        if (descSection) descSection.hidden = false;
        if (descEl) descEl.innerHTML = `
            <div class="datacat-modal-extract-cta">
                <div class="datacat-modal-extract-icon-wrap">
                    <i class="fa-solid fa-wand-magic-sparkles datacat-modal-extract-icon"></i>
                </div>
                <p class="datacat-modal-extract-message">${escapeHtml(message)}</p>
                <p class="datacat-modal-extract-hint">Use DataCat's extraction service to retrieve this character's full definition from ${cfg.label}.</p>
                <button class="cl-btn cl-btn-primary datacat-modal-extract-btn" data-extract-id="${escapeHtml(charId)}" data-extract-source="${source}">
                    <i class="fa-solid fa-cloud-arrow-down"></i> Extract Character
                </button>
            </div>
        `;
        const inlineBtn = descEl?.querySelector('.datacat-modal-extract-btn');
        if (inlineBtn) inlineBtn.addEventListener('click', () => startModalExtraction(charId, source));
        const importBtn = document.getElementById('datacatImportBtn');
        if (importBtn) {
            importBtn.disabled = false;
            importBtn.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> Extract';
            importBtn.classList.remove('cl-btn-primary', 'cl-btn-secondary', 'cl-btn-warning');
            importBtn.classList.add('cl-btn-primary');
            importBtn.dataset.extractId = charId;
            importBtn.dataset.extractSource = source;
        }
    }

    // Start download fetch early (runs in parallel with character fetch)
    const hitSource = getSourceKind(hit);
    const downloadPromise = fetchDatacatDownload(charId, hitSource).catch(() => null);

    try {
        const character = hit._fullCharacter || await fetchDatacatCharacter(charId, hitSource);

        if (token !== datacatDetailFetchToken) return;

        const defLoading = document.getElementById('datacatCharDefinitionLoading');
        if (defLoading) defLoading.hidden = true;

        if (!character) {
            showExtractionCTA('Character definition is hidden or unavailable.');
            return;
        }

        // Store full data on the selected char for import
        if (datacatSelectedChar && getCharId(datacatSelectedChar) === charId) {
            datacatSelectedChar._fullCharacter = character;
        }

        // The listing row only knew the 640px card variant; upgrade the avatar viewer to the
        // true original now that the detail payload is here.
        const detailAvatarImg = document.getElementById('datacatCharAvatar');
        if (detailAvatarImg) {
            const fullRes = resolveDatacatAvatarUrl(character, { preferOriginal: true });
            if (fullRes) detailAvatarImg.dataset.full = fullRes;
        }

        // Update creator name if available (MeiliSearch hits lack it)
        const charCreatorName = character.creator_name || character.creatorName || '';
        if (charCreatorName) {
            const creatorEl = document.getElementById('datacatCharCreator');
            if (creatorEl) creatorEl.textContent = charCreatorName;
            if (datacatSelectedChar && getCharId(datacatSelectedChar) === charId) {
                datacatSelectedChar.creator_name = charCreatorName;
            }
        }

        // janitor variants mirror the row blurb in description, so it never paints as the body
        const recoveredVariant = pickRecoveryVariant(character);
        const v2Data = character?.chara_card_v2_json?.data || null;
        const personality = character.personality || recoveredVariant?.personality || stripDatacatMarkers(v2Data?.description) || '';
        const scenario = recoveredVariant?.scenario || character.scenario || v2Data?.scenario || '';
        const firstMessage = recoveredVariant?.first_message || character.first_message || v2Data?.first_mes || '';

        const descSection = document.getElementById('datacatCharDescriptionSection');
        if (descSection) {
            const descEl = document.getElementById('datacatCharDescription');
            if (personality) {
                descSection.hidden = false;
                if (descEl) {
                    // the definition body renders in the contained iframe
                    cleanupCreatorNotesContainer(descEl);
                    descEl.innerHTML = '';
                    const descBody = document.createElement('div');
                    descEl.appendChild(descBody);
                    renderCardHtmlSecure(personality, name, descBody);
                }
            } else {
                descSection.hidden = true;
                if (descEl) descEl.innerHTML = '';
            }
        }

        const scenarioSection = document.getElementById('datacatCharScenarioSection');
        const scenarioEl = document.getElementById('datacatCharScenario');
        if (scenarioSection && scenario) {
            scenarioSection.hidden = false;
            if (scenarioEl) deferRender(scenarioEl, () => safePurify(formatRichText(scenario, name, true), BROWSE_PURIFY_CONFIG));
        } else if (scenarioSection) {
            scenarioSection.hidden = true;
        }

        const firstMsgSection = document.getElementById('datacatCharFirstMsgSection');
        const firstMsgEl = document.getElementById('datacatCharFirstMsg');
        if (firstMsgSection && firstMessage) {
            firstMsgSection.hidden = false;
            if (firstMsgEl) {
                deferRender(firstMsgEl, () => safePurify(formatRichText(firstMessage, name, true), BROWSE_PURIFY_CONFIG));
                firstMsgEl.dataset.fullContent = firstMessage;
            }
        } else if (firstMsgSection) {
            firstMsgSection.hidden = true;
        }

        // Silently update stats values if full character has better data
        const chatsEl = document.getElementById('datacatCharChats');
        const msgsEl = document.getElementById('datacatCharMessages');
        const tokensEl = document.getElementById('datacatCharTokens');
        const fullChatCount = getChatCount(character);
        const fullMsgCount = getMsgCount(character);
        const fullTokens = getTotalTokens(character);
        if (chatsEl && fullChatCount) chatsEl.textContent = formatNumber(fullChatCount);
        if (msgsEl && fullMsgCount) msgsEl.textContent = formatNumber(fullMsgCount);
        if (tokensEl && fullTokens) tokensEl.textContent = formatNumber(fullTokens);

        // refresh notes only on change (no iframe flash); a janitor row's blurb is its description
        const fullCreatorNotes = (character.description || '').trim();
        const creatorNotesSection = document.getElementById('datacatCharCreatorNotesSection');
        const creatorNotesEl = document.getElementById('datacatCharCreatorNotes');
        if (fullCreatorNotes && fullCreatorNotes !== datacatLastCreatorNotes) {
            datacatLastCreatorNotes = fullCreatorNotes;
            if (creatorNotesSection) creatorNotesSection.hidden = false;
            if (creatorNotesEl) {
                if (!creatorNotesEl.querySelector('iframe')) creatorNotesEl.innerHTML = skeletonLines(3);
                deferCall(creatorNotesEl, () => renderCreatorNotesSecure(fullCreatorNotes, name, creatorNotesEl));
            }
        } else if (!fullCreatorNotes && !datacatLastCreatorNotes) {
            if (creatorNotesSection) creatorNotesSection.hidden = true;
            if (creatorNotesEl) creatorNotesEl.innerHTML = '';
        }

        // Update tags only if they differ from what's already rendered
        if (character.tags?.length) {
            const tagsEl = document.getElementById('datacatCharTags');
            if (tagsEl) {
                const fullTags = resolveTagNames(character.tags);
                const newHtml = fullTags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
                if (tagsEl.innerHTML !== newHtml) tagsEl.innerHTML = newHtml;
            }
        }

        // Linked lorebooks (external, metadata-only). DataCat stores attached
        // lorebooks/scripts on `character.scripts[]`. Their entries are not
        // reachable through the service, so this is a heads-up surface only
        renderDatacatLorebooks(character.scripts);

        // Enable import button now that full character data is confirmed
        datacatSelectedDetail = character;
        stampDatacatImport(hit, character);

        // Fetch download data for alternate greetings and example messages
        downloadPromise.then(downloadData => {
            if (token !== datacatDetailFetchToken) return;
            const d = downloadData?.data;

            // /download is authoritative for the body, as the import uses
            if (d) {
                const dlDesc = d.personality || d.description || '';
                const shouldOverwriteDesc = dlDesc && (!personality || dlDesc !== personality);
                if (shouldOverwriteDesc) {
                    const ds = document.getElementById('datacatCharDescriptionSection');
                    const de = document.getElementById('datacatCharDescription');
                    if (ds) ds.hidden = false;
                    if (de) {
                        cleanupCreatorNotesContainer(de);
                        de.innerHTML = '';
                        const deBody = document.createElement('div');
                        de.appendChild(deBody);
                        renderCardHtmlSecure(dlDesc, name, deBody);
                    }
                }
                if (d.scenario && (!scenario || d.scenario !== scenario)) {
                    const ss = document.getElementById('datacatCharScenarioSection');
                    const se = document.getElementById('datacatCharScenario');
                    if (ss) ss.hidden = false;
                    if (se) deferRender(se, () => safePurify(formatRichText(d.scenario, name, true), BROWSE_PURIFY_CONFIG));
                }
                if (d.first_mes && (!firstMessage || d.first_mes !== firstMessage)) {
                    const fs = document.getElementById('datacatCharFirstMsgSection');
                    const fe = document.getElementById('datacatCharFirstMsg');
                    if (fs) fs.hidden = false;
                    if (fe) {
                        deferRender(fe, () => safePurify(formatRichText(d.first_mes, name, true), BROWSE_PURIFY_CONFIG));
                        fe.dataset.fullContent = d.first_mes;
                    }
                }
            }

            // Example messages - only present in the download payload
            const mesExample = d?.mes_example || '';
            const mesSection = document.getElementById('datacatCharMesExampleSection');
            const mesEl = document.getElementById('datacatCharMesExample');
            if (mesExample && mesSection && mesEl) {
                mesSection.hidden = false;
                deferRender(mesEl, () => safePurify(formatRichText(mesExample, name, true), BROWSE_PURIFY_CONFIG));
                mesEl.dataset.fullContent = mesExample;
            } else if (mesSection) {
                mesSection.hidden = true;
            }

            renderAltGreetings(d?.alternate_greetings, name);
        });
    } catch (err) {
        debugLog('[DatacatBrowse] Detail fetch error:', err);
        if (token === datacatDetailFetchToken) {
            const defLoading = document.getElementById('datacatCharDefinitionLoading');
            if (defLoading) defLoading.hidden = true;
            showExtractionCTA('Could not load character definition.');
        }
    }
}

function renderDatacatLorebooks(scripts) {
    const section = document.getElementById('datacatCharLorebooksSection');
    const listEl = document.getElementById('datacatCharLorebooksList');
    const countEl = document.getElementById('datacatCharLorebooksCount');
    const stat = document.getElementById('datacatCharLorebookStat');

    if (!section || !listEl) return;

    const lorebooks = Array.isArray(scripts)
        ? scripts.filter(s => s && s.type === 'lorebook' && s.id)
        : [];

    if (lorebooks.length === 0) {
        section.hidden = true;
        listEl.innerHTML = '';
        if (countEl) countEl.textContent = '';
        if (stat) stat.hidden = true;
        return;
    }

    // Not downloadable = fully private OR listed-but-content-locked (is_code_public false).
    const lockedCount = lorebooks.filter(s => s.is_public === false || s.is_code_public === false).length;
    const allLocked = lockedCount === lorebooks.length;
    const noneDownloadable = lockedCount === 0
        ? null
        : (allLocked
            ? 'These lorebooks are private or content-locked by their creator and cannot be downloaded through Project Σ.'
            : 'Some of these lorebooks are private or content-locked and cannot be downloaded through Project Σ.');

    if (stat) {
        stat.hidden = false;
        const label = lorebooks.length === 1 ? 'lorebook' : 'lorebooks';
        stat.innerHTML = `<i class="fa-solid fa-book"></i> <span id="datacatCharLorebookCount">${lorebooks.length}</span> ${label}`;
        stat.title = noneDownloadable || `Public lorebooks are downloaded as embedded character_book.`;
    }
    if (countEl) countEl.textContent = `(${lorebooks.length})`;

    const note = document.getElementById('datacatCharLorebooksNote');
    const noteText = document.getElementById('datacatCharLorebooksNoteText');
    if (note && noteText) {
        if (!noneDownloadable) {
            note.hidden = true;
        } else {
            note.hidden = false;
            noteText.textContent = noneDownloadable;
        }
    }

    section.hidden = false;
    listEl.innerHTML = lorebooks.map(s => {
        const title = escapeHtml(s.title || 'Untitled lorebook');
        const author = s.user_name ? `<span class="datacat-lorebook-author">by @${escapeHtml(s.user_name)}</span>` : '';
        const desc = (s.description || '').trim();
        const descHtml = desc ? `<div class="datacat-lorebook-desc">${escapeHtml(desc)}</div>` : '';
        const visibility = s.is_public === false
            ? '<span class="datacat-lorebook-meta-item datacat-lorebook-private" title="Not publicly browsable on DataCat"><i class="fa-solid fa-lock"></i> Private</span>'
            : (s.is_code_public === false
                ? '<span class="datacat-lorebook-meta-item datacat-lorebook-private" title="Entries are hidden by the creator; the lorebook cannot be downloaded"><i class="fa-solid fa-lock"></i> Content locked</span>'
                : '');
        const meta = visibility ? `<div class="datacat-lorebook-meta">${visibility}</div>` : '';
        return `
            <div class="datacat-lorebook-row">
                <div class="datacat-lorebook-row-main">
                    <div class="datacat-lorebook-title-line">
                        <i class="fa-solid fa-book"></i>
                        <span class="datacat-lorebook-title">${title}</span>
                        ${author}
                    </div>
                    ${descHtml}
                    ${meta}
                </div>
            </div>
        `;
    }).join('');
}

function renderAltGreetings(greetings, charName) {
    renderAltGreetingsList('datacat', greetings, charName);
}

function cleanupDatacatCharModal() {
    BrowseView.closeAvatarViewer();
    CoreAPI.setBrowseAltGreetings(null);
    const sectionIds = [
        'datacatCharDescription',
        'datacatCharScenario',
        'datacatCharFirstMsg',
        'datacatCharAltGreetings',
        'datacatCharTags',
    ];
    for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }
    const notesEl = document.getElementById('datacatCharCreatorNotes');
    if (notesEl) cleanupCreatorNotesContainer(notesEl);
}

function closePreviewModal() {
    datacatDetailFetchToken++;
    datacatDetailFetchPromise = null;
    cleanupDatacatCharModal();
    clearExtractionState();
    const modal = document.getElementById('datacatCharModal');
    if (modal) modal.classList.add('hidden');
    datacatSelectedChar = null;
    datacatSelectedDetail = null;
    view.trackPreview(null);
}

// ========================================
// IMPORT
// ========================================

async function importCharacter(charData) {
    const charId = getCharId(charData);
    if (!charId) return;
    await view.importFromPreview({
        button: document.getElementById('datacatImportBtn'), hit: charData, provider: 'datacat', id: charId, label: 'DatacatBrowse',
        closePreview: closePreviewModal,
        prepare: async () => {
            await datacatDetailFetchPromise;
            const character = charData._fullCharacter;
            if (!character) {
                showToast('Character definition not available. Try extracting first.', 'warning');
                return { cancel: true };
            }
            const charName = character.chat_name || character.name || charData.name || '';
            const charCreator = character.creator_name || charData.creatorName || charData.creator_name || '';
            // Body resolution mirrors buildV2FromDatacat so the dupe scorer compares body-to-body, not blurb-to-body.
            const dupeRecovered = pickRecoveryVariant(character);
            const dupeV2 = character.chara_card_v2_json?.data || null;
            const dupeBody = character.personality || dupeRecovered?.personality || stripDatacatMarkers(dupeV2?.description) || '';
            return {
                data: character,
                probe: {
                    name: charName, creator: charCreator, fullPath: String(charId),
                    description: dupeBody,
                    first_mes: character.first_message || dupeV2?.first_mes || '',
                    scenario: character.scenario || dupeV2?.scenario || '',
                },
                dialog: { name: charName, creator: charCreator, fullPath: String(charId), avatarUrl: resolveDatacatAvatarUrl(character) || resolveDatacatAvatarUrl(charData) || '/img/no-portrait.png' },
            };
        },
    });
}

// ========================================
// NSFW TOGGLE
// ========================================

function updateDatacatFiltersButtonState() {
    const btn = document.getElementById('datacatFiltersBtn');
    if (!btn) return;
    const count = countActiveFeatures(DATACAT_FEATURE_FILTERS, datacatFeatureState);
    setFilterCount(btn, 'Features', count);
}

// ========================================
// EVENT WIRING
// ========================================

let delegatesInitialized = false;
let modalEventsAttached = false;

function initDatacatView() {
    datacatNsfwEnabled = getSetting('datacatNsfw') === true;

    if (delegatesInitialized) return;
    delegatesInitialized = true;

    const sortEl = document.getElementById('datacatSortSelect');
    if (sortEl) CoreAPI.initCustomSelect(sortEl);

    const followingSortEl = document.getElementById('datacatFollowingSortSelect');
    if (followingSortEl) CoreAPI.initCustomSelect(followingSortEl);

    const creatorSortEl = document.getElementById('datacatCreatorSortSelect');
    if (creatorSortEl) {
        creatorSortEl.value = datacatCreatorSortMode;
        CoreAPI.initCustomSelect(creatorSortEl);
    }

    // Grid card click --> open preview (delegation)
    const grid = document.getElementById('datacatGrid');
    if (grid) {
        grid.addEventListener('click', (e) => {
            const authorLink = e.target.closest('.browse-card-creator-link');
            if (authorLink) {
                e.stopPropagation();
                const creatorId = authorLink.dataset.creatorId;
                if (creatorId) browseCreator(creatorId);
                return;
            }

            const card = e.target.closest('.browse-card');
            if (!card) return;
            const charId = card.dataset.datacatId;
            if (!charId) return;
            const hit = datacatCharacters.find(c => String(getCharId(c)) === charId);
            if (!hit) return;
            // an item not on DataCat yet gets the extraction CTA in the preview
            openPreviewModal(hit);
        });
    }

    // Search
    on('datacatSearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doSearch();
        }
    });
    on('datacatSearchInput', 'input', (e) => {
        const clearBtn = document.getElementById('datacatClearSearchBtn');
        const val = (e.target.value || '').trim();
        if (clearBtn) clearBtn.classList.toggle('hidden', !val);
    });
    on('datacatSearchBtn', 'click', () => doSearch());

    // Creator search handlers
    on('datacatCreatorSearchInput', 'keypress', (e) => {
        if (e.key === 'Enter') performDatacatCreatorSearch();
    });
    on('datacatCreatorSearchBtn', 'click', () => performDatacatCreatorSearch());
    on('datacatClearSearchBtn', 'click', () => {
        // the restore re-shows the pre-scope query, so leave the scope before clearing
        const inScope = datacatBrowseMode === 'creator';
        if (inScope) view.clearCreatorScope({ reload: false });
        const input = document.getElementById('datacatSearchInput');
        if (input) input.value = '';
        document.getElementById('datacatClearSearchBtn')?.classList.add('hidden');
        if (inScope || hampterSearchQuery || meiliSearchQuery || datacatSearchQuery) {
            hampterSearchQuery = '';
            meiliSearchQuery = '';
            datacatSearchQuery = '';
            view.reload();
        }
    });

    // Load More
    on('datacatLoadMoreBtn', 'click', () => view.reload({ append: true }));

    on('datacatFollowingLoadMoreBtn', 'click', () => {
        datacatFollowingDisplayLimit += 60;
        renderFollowing(true);
    });

    // NSFW toggle
    on('datacatNsfwToggle', 'click', () => {
        datacatNsfwEnabled = !datacatNsfwEnabled;
        setSetting('datacatNsfw', datacatNsfwEnabled);
        updateNsfwToggleButton('datacatNsfwToggle', datacatNsfwEnabled);
        if (datacatViewMode === 'following') {
            renderFollowing();
        } else {
            renderGrid(datacatCharacters, false);
        }
    });
    updateNsfwToggleButton('datacatNsfwToggle', datacatNsfwEnabled);

    updateSourceFilterVisibility();

    // Filters dropdown toggle
    on('datacatFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns('datacatFiltersDropdown');
        document.getElementById('datacatTagsDropdown')?.classList.add('hidden');
        document.getElementById('datacatFiltersDropdown')?.classList.toggle('hidden');
    });

    // Filter checkboxes (render-time filters, both modes)
    datacatBrowseView.wireFeatureFilters(DATACAT_FEATURE_FILTERS, datacatFeatureState, () => {
        if (datacatViewMode === 'following') {
            renderFollowing();
        } else {
            renderGrid(datacatCharacters, false);
        }
    }, { badge: updateDatacatFiltersButtonState });

    // Sort mode
    on('datacatSortSelect', 'change', () => {
        const el = document.getElementById('datacatSortSelect');
        if (!el) return;
        if (datacatBrowseMode === 'creator') {
            datacatCreatorSortMode = el.value;
            const bannerSort = document.getElementById('datacatCreatorSortSelect');
            if (bannerSort) bannerSort.value = el.value;
        } else {
            datacatSortMode = el.value;
            datacatFreshLimit24 = 80;
            datacatFreshLimitWeek = 20;
            meiliCurrentPage = 1;
            hampterCurrentPage = 1;
            hampterSearchQuery = '';
        }
        datacatCurrentOffset = 0;
        updateSearchPlaceholder();
        updateTagsVisibility();
        updateTagsButton();
        // Refresh open tag dropdown so it shows the right tag set for the new mode
        const tagDropdown = document.getElementById('datacatTagsDropdown');
        if (tagDropdown && !tagDropdown.classList.contains('hidden')) {
            if (isJannyTagMode()) renderJannyTagsList();
            else loadFacetedTags();
        }
        updateSourceFilterVisibility();
        view.reload();
    });

    // Creator banner sort
    on('datacatCreatorSortSelect', 'change', () => {
        const el = document.getElementById('datacatCreatorSortSelect');
        if (!el) return;
        datacatCreatorSortMode = el.value;
        const mainSort = document.getElementById('datacatSortSelect');
        if (mainSort) mainSort.value = el.value;
        view.reload();
    });

    // Refresh
    on('datacatRefreshBtn', 'click', () => view.reload({ force: true }));

    // Clear creator filter
    on('datacatClearCreatorBtn', 'click', () => clearCreatorFilter());
    // Tags dropdown toggle
    on('datacatTagsBtn', 'click', () => {
        document.getElementById('datacatFiltersDropdown')?.classList.add('hidden');
        const dropdown = document.getElementById('datacatTagsDropdown');
        if (!dropdown) return;
        dropdown.classList.toggle('hidden');
        if (!dropdown.classList.contains('hidden')) {
            const searchInput = document.getElementById('datacatTagsSearchInput');
            if (searchInput) searchInput.value = '';
            if (isJannyTagMode()) {
                renderJannyTagsList();
            } else if (datacatTagsLoaded) {
                // re-render on every open: the search was just cleared, and a stale filtered DOM would linger
                renderTagsList('');
            } else {
                loadFacetedTags();
            }
            // Focus search after a tick (avoid immediately blurring on open)
            setTimeout(() => searchInput?.focus(), 50);
        }
    });
    on('datacatTagsClearBtn', 'click', () => {
        const searchInput = document.getElementById('datacatTagsSearchInput');
        if (searchInput) searchInput.value = '';
        if (isJannyTagMode()) {
            jannyActiveTagIds.clear();
            renderJannyTagsList();
        } else {
            datacatActiveTagIds.clear();
            renderTagsList();
            refreshTagCounts();
        }
        updateTagsButton();
        view.reload();
    });

    // Tags search input: filter the current rendered list
    on('datacatTagsSearchInput', 'input', () => {
        const searchInput = document.getElementById('datacatTagsSearchInput');
        const filter = searchInput?.value || '';
        if (isJannyTagMode()) {
            renderJannyTagsList(filter);
        } else {
            renderTagsList(filter);
        }
    });

    // Dropdown dismiss (click outside)
    datacatBrowseView._registerDropdownDismiss([
        { dropdownId: 'datacatTagsDropdown', buttonId: 'datacatTagsBtn' },
        { dropdownId: 'datacatFiltersDropdown', buttonId: 'datacatFiltersBtn' },
    ]);

    // View mode toggle (Browse / Following)
    document.querySelectorAll('.browse-view-btn[data-datacat-view]').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.datacatView;
            if (mode && mode !== datacatViewMode) {
                switchDatacatViewMode(mode);
            }
        });
    });

    // Follow button in creator banner
    on('datacatFollowCreatorBtn', 'click', () => {
        if (!datacatCreatorId) return;
        if (isCreatorFollowed(datacatCreatorId)) {
            unfollowCreator(datacatCreatorId);
        } else {
            followCreator(datacatCreatorId, datacatCreatorName);
        }
    });

    // Following sort
    on('datacatFollowingSortSelect', 'change', () => {
        const el = document.getElementById('datacatFollowingSortSelect');
        if (!el) return;
        datacatFollowingSort = el.value;
        datacatFollowingDisplayLimit = 60;
        renderFollowing();
    });

    // Following grid card click --> open preview (delegation)
    const followingGrid = document.getElementById('datacatFollowingGrid');
    if (followingGrid) {
        followingGrid.addEventListener('click', _handleFollowingCardClick);
    }


    // Preview modal events (only attach once)
    ensureModalEventsAttached();
}

function ensureModalEventsAttached() {
    if (modalEventsAttached) return;
    if (!document.getElementById('datacatCharModal')) return;
    modalEventsAttached = true;

    const datacatOverlay = document.getElementById('datacatCharModal');
    BrowseView.wireTitleScroll(document.getElementById('datacatCharName'), datacatOverlay, datacatOverlay?.querySelector('.browse-char-modal'));

    on('datacatCharClose', 'click', () => closePreviewModal());

    const creatorLink = document.getElementById('datacatCharCreator');
    if (creatorLink) {
        creatorLink.addEventListener('click', (e) => {
            e.preventDefault();
            // closePreviewModal nulls the selection, so read the hit first
            const hit = datacatSelectedChar;
            const creatorId = getCreatorId(hit);
            if (creatorId) {
                closePreviewModal();
                browseCreator(creatorId);
            }
        });
    }

    // Desktop only at event time; on mobile bail before stopPropagation so the delegated tap runs
    const avatar = document.getElementById('datacatCharAvatar');
    if (avatar) {
        avatar.addEventListener('click', (e) => {
            if (isMobileMode()) return;
            e.stopPropagation();
            if (!avatar.src || avatar.src.endsWith('/img/no-portrait.png')) return;
            BrowseView.openAvatarViewer(avatar.dataset.full || avatar.src, avatar.src);
        });
    }

    on('datacatImportBtn', 'click', () => {
        const importBtn = document.getElementById('datacatImportBtn');
        const extractId = importBtn?.dataset.extractId;
        if (extractId) {
            const extractSource = importBtn?.dataset.extractSource || 'janitor';
            startModalExtraction(extractId, extractSource);
        } else if (datacatSelectedChar) {
            importCharacter(datacatSelectedChar);
        }
    });

    const modalOverlay = document.getElementById('datacatCharModal');
    if (modalOverlay) {
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) closePreviewModal();
        });
    }

    window.registerOverlay?.({ id: 'datacatCharModal', tier: 7, close: () => closePreviewModal() });
    window.registerOverlay?.({ id: 'datacatCreatorBanner', tier: 9, close: () => clearCreatorFilter() });
}

// ========================================
// EXPOSE openDatacatCharPreview ON WINDOW
// ========================================

window.openDatacatCharPreview = function(char) {
    openPreviewModal(char);
};

// ========================================
// BROWSE VIEW CLASS
// ========================================

const datacatBrowseView = new (class DatacatBrowseView extends BrowseView {

    constructor(provider) {
        super(provider);
        view = this;
    }

    hitMatchName(hit) {
        return { name: hit.name || '', creator: getCreatorName(hit) };
    }

    hitLinkKey(hit) {
        const id = getCharId(hit);
        return id ? String(id) : null;
    }

    // -- Following Manager --

    get supportsFollowingManager() { return true; }

    async getFollowedCreators() {
        return datacatFollowedCreators.map((c, i) => ({
            id: c.id,
            name: c.name,
            source: c.source,
            followedAt: i,
        }));
    }

    _renderManagerCreatorCard(creator, index) {
        const html = super._renderManagerCreatorCard(creator, index);
        // DataCat-tracked creators are JanitorAI creators (DataCat indexes JanitorAI); a follow
        // saved from another source carries no badge
        if ((creator.source || 'datacat') !== 'datacat') return html;
        const badge = '<span class="browse-feature-badge source-janitor" title="Source: JanitorAI">J</span>';
        // Inject the source badge inside the meta line, before the existing meta children.
        return html.replace(
            '<div class="follow-mgr-card-meta">',
            `<div class="follow-mgr-card-meta"><span class="follow-mgr-source-badge">${badge}</span>`
        );
    }

    async followCreator(query) {
        if (!query) return null;
        const raw = query.trim();

        let creatorId = raw;

        // Extract UUID from DataCat creator URL
        const urlMatch = creatorId.match(/creators?\/([0-9a-f-]{36})/i);
        if (urlMatch) creatorId = urlMatch[1];

        if (isCreatorFollowed(creatorId, 'datacat')) {
            showToast('Already following this creator', 'info');
            return null;
        }

        // UUID format: try API lookup
        if (/^[0-9a-f-]{36}$/i.test(creatorId)) {
            const creator = await fetchDatacatCreator(creatorId);
            if (creator) {
                const name = creator.userName || creatorId;
                followCreator(creatorId, name, 'datacat');
                return { id: creatorId, name };
            }
        }

        // Client-side name search across known data
        const lowerQ = raw.toLowerCase();
        const sources = [
            ...datacatFollowedCreators.map(c => ({ id: c.id, name: c.name, source: c.source })),
            ...datacatCharacters.map(c => ({ id: getCreatorId(c), name: getCreatorName(c), source: 'datacat' })),
            ...datacatFollowingCharacters.map(c => ({ id: getCreatorId(c), name: getCreatorName(c), source: 'datacat' })),
        ];
        const exact = sources.find(c => c.name?.toLowerCase() === lowerQ);
        const match = exact || sources.find(c => c.name?.toLowerCase().includes(lowerQ));

        if (match && match.id && !isCreatorFollowed(match.id, match.source)) {
            followCreator(match.id, match.name, match.source);
            return { id: match.id, name: match.name };
        }

        // Server-side: the feed search covers creator names, so unloaded creators resolve too
        const feedHit = await resolveCreatorFromFeed(raw);
        if (feedHit) {
            const id = getCreatorId(feedHit);
            if (id) {
                const name = getCreatorName(feedHit);
                if (isCreatorFollowed(id)) {
                    showToast('Already following this creator', 'info');
                    return null;
                }
                followCreator(id, name);
                return { id, name };
            }
        }

        showToast('Creator not found. Try pasting a DataCat creator URL.', 'warning');
        return null;
    }

    async unfollowCreator(id) {
        const entry = datacatFollowedCreators.find(c => c.id === id);
        unfollowCreator(id, entry?.source || 'datacat');
        return true;
    }

    browseCreatorFromManager(creator) {
        if ((creator.source || 'datacat') !== 'datacat') {
            showToast('This creator was followed from a source DataCat no longer browses; unfollow to clear it', 'info');
            return;
        }
        browseCreator(creator.id);
    }

    getFollowingManagerSortOptions() {
        return [
            { value: 'name_asc', label: 'Name A-Z' },
            { value: 'name_desc', label: 'Name Z-A' },
            { value: 'recent', label: 'Recently Added' },
        ];
    }

    get previewModalId() { return 'datacatCharModal'; }

    // the provider page a finished import's gallery is fetched from (the import summary's row)
    galleryUrlFor(result) { return `https://datacat.run/characters/${result.providerCharId}`; }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'recent', label: 'Recent' },
                { value: 'fresh_24h', label: 'Freshest (24h)' },
                { value: 'score_24h', label: 'Score (24h)' },
                { value: 'chat_count_24h', label: 'Chat Count (24h)' },
                { value: 'messages_per_chat_24h', label: 'MSG/Chat (24h)' },
                { value: 'first_published_24h', label: 'First Published (24h)' },
                { value: 'fresh_week', label: 'Freshest (Week)' },
                { value: 'score_week', label: 'Score (Week)' },
                { value: 'chat_count_week', label: 'Chat Count (Week)' },
                { value: 'messages_per_chat_week', label: 'MSG/Chat (Week)' },
                { value: 'first_published_week', label: 'First Published (Week)' },
            ],
            followingSortOptions: [
                { value: 'newest', label: 'Newest Created' },
                { value: 'oldest', label: 'Oldest First' },
                { value: 'name_asc', label: 'Name A-Z' },
                { value: 'name_desc', label: 'Name Z-A' },
                { value: 'chat_count', label: 'Most Messages' },
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

    get hasModeToggle() { return true; }

    get mobileFilterIds() {
        return {
            sort: 'datacatSortSelect',
            timelineSort: 'datacatFollowingSortSelect',
            tags: 'datacatTagsBtn',
            filters: 'datacatFiltersBtn',
            nsfw: 'datacatNsfwToggle',
            refresh: 'datacatRefreshBtn',
            modeBrowseSelector: '.browse-view-btn[data-datacat-view="browse"]',
            modeFollowSelector: '.browse-view-btn[data-datacat-view="following"]',
        };
    }

    // -- Filter Bar --

    renderFilterBar() {
        return `
            <!-- Mode Toggle -->
            ${renderViewToggle('datacat-view', [
                { value: 'browse', icon: 'fa-compass', label: 'Browse', title: 'Browse all characters', active: true },
                { value: 'following', icon: 'fa-users', label: 'Following', title: 'Characters from creators you follow' },
            ])}

            <!-- Sort -->
            <div id="datacatSortContainer" class="browse-sort-container">
                <select id="datacatSortSelect" class="glass-select" title="Sort order">
                    ${buildSortOptionsHtml(datacatSortMode)}
                </select>
                <select id="datacatFollowingSortSelect" class="glass-select hidden" title="Sort following timeline">
                    <option value="newest" data-icon="fa-solid fa-calendar-plus" selected>Newest Created</option>
                    <option value="oldest" data-icon="fa-solid fa-hourglass">Oldest First</option>
                    <option value="name_asc" data-icon="fa-solid fa-arrow-down-a-z">Name A-Z</option>
                    <option value="name_desc" data-icon="fa-solid fa-arrow-up-z-a">Name Z-A</option>
                    <option value="chat_count" data-icon="fa-solid fa-comments">Most Messages</option>
                </select>
            </div>

            <!-- Tags -->
            <div class="browse-tags-dropdown-container u-relative">
                <button id="datacatTagsBtn" class="glass-btn" title="Tag filters">
                    <i class="fa-solid fa-tags"></i> <span id="datacatTagsBtnLabel">Tags</span>
                </button>
                <div id="datacatTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="datacatTagsSearchInput" placeholder="Search tags..." autocomplete="one-time-code">
                        <button id="datacatTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="datacatTagsList"></div>
                </div>
            </div>

            <!-- Filters -->
            <div class="browse-more-filters u-relative">
                <button id="datacatFiltersBtn" class="glass-btn" title="Filter by character features">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="datacatFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden">
                    ${renderFeatureFilterItems(DATACAT_FILTER_SECTIONS, DATACAT_FEATURE_FILTERS)}
                </div>
            </div>

            <!-- NSFW toggle -->
            <button id="datacatNsfwToggle" class="glass-btn nsfw-toggle" title="Toggle NSFW content">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Refresh -->
            <button id="datacatRefreshBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // -- Main View --

    renderView() {
        return `
            <!-- Browse Section -->
            <div id="datacatBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="datacatSearchInput" placeholder="Paste a DataCat or JanitorAI character URL..." autocomplete="one-time-code">
                        <button id="datacatClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="datacatSearchBtn" class="browse-search-submit" aria-label="Search">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                    <div class="browse-creator-search">
                        <div class="browse-creator-search-wrapper">
                            <i class="fa-solid fa-user"></i>
                            <input type="search" id="datacatCreatorSearchInput" placeholder="Creator name or URL..." autocomplete="one-time-code">
                            <button id="datacatCreatorSearchBtn" class="browse-search-submit" title="Search by creator">
                                <i class="fa-solid fa-arrow-right"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Creator Banner -->
                <div id="datacatCreatorBanner" class="browse-author-banner hidden">
                    <div class="browse-author-banner-content">
                        <i class="fa-solid fa-cat"></i>
                        <span>Browsing characters by <strong id="datacatCreatorBannerName">Creator</strong></span>
                    </div>
                    <div class="browse-author-banner-actions">
                        <select id="datacatCreatorSortSelect" class="glass-select datacat-creator-sort-select" title="Sort creator's characters">
                            ${CREATOR_SORT_OPTIONS.map(o => `<option value="${o.value}" data-icon="fa-solid ${o.icon}">${o.label}</option>`).join('')}
                        </select>
                        <button id="datacatFollowCreatorBtn" class="glass-btn" title="Follow this creator" hidden>
                            <i class="fa-regular fa-heart"></i> <span>Follow</span>
                        </button>
                        <button id="datacatClearCreatorBtn" class="glass-btn icon-only" title="Clear creator filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Results Grid -->
                <div id="datacatGrid" class="browse-grid"></div>

                <!-- Load More -->
                <div class="browse-load-more" id="datacatLoadMore" hidden>
                    <button id="datacatLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>

            <!-- Following Section -->
            <div id="datacatFollowingSection" class="browse-section hidden">
                <div class="browse-timeline-header">
                    <div class="browse-timeline-header-left">
                        <h3><i class="fa-solid fa-clock"></i> Timeline</h3>
                        <p>New characters from creators you follow</p>
                    </div>
                    <div class="browse-timeline-header-right">
                        <button class="follow-mgr-toggle-btn glass-btn" id="datacatFollowMgrToggle"
                                title="Manage followed creators">
                            <i class="fa-solid fa-users-gear"></i> Manage
                        </button>
                    </div>
                </div>
                ${this.renderFollowingManagerPanel()}
                <div id="datacatFollowingGrid" class="browse-grid"></div>
                <div class="browse-load-more" id="datacatFollowingLoadMore" hidden>
                    <button id="datacatFollowingLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    // -- Modals --

    renderModals() {
        return `
    <div id="datacatCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="datacatCharAvatar" src="/img/no-portrait.png" alt="" class="browse-char-avatar" decoding="async">
                    <div>
                        <h2 id="datacatCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="datacatCharCreator" href="#" class="creator-link browse-meta-identity" title="Click to browse this creator's characters">Creator</a>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="datacatOpenInBrowserBtn" href="#" target="_blank" class="cl-btn cl-btn-secondary" title="Open on DataCat">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="datacatImportBtn" class="cl-btn cl-btn-primary" title="Import into your library">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="datacatCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-comments"></i>
                            <span id="datacatCharChats">0</span> chats
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-envelope"></i>
                            <span id="datacatCharMessages">0</span> messages
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-text-width"></i>
                            <span id="datacatCharTokens">0</span> tokens
                        </div>
                        <div class="browse-stat" id="datacatCharGreetingsStat" hidden>
                            <i class="fa-solid fa-comment-dots"></i>
                            <span id="datacatCharGreetingsCount">0</span> greetings
                        </div>
                        <div class="browse-stat" id="datacatCharLorebookStat" hidden>
                            <i class="fa-solid fa-book"></i>
                            <span id="datacatCharLorebookCount">0</span> lorebook
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="datacatCharDate">Unknown</span>
                        </div>
                    </div>
                    <div class="browse-char-tags" id="datacatCharTags"></div>
                </div>

                <!-- Creator's Notes -->
                <div class="browse-char-section" id="datacatCharCreatorNotesSection" hidden>
                    <h3 class="browse-section-title" data-section="datacatCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="datacatCharCreatorNotes" class="scrolling-text"></div>
                </div>

                <!-- Definition loading indicator -->
                <div id="datacatCharDefinitionLoading" class="browse-char-section" hidden>
                    <div class="browse-status-note"><i class="fa-solid fa-spinner fa-spin"></i> Loading character definition...</div>
                </div>

                <!-- Description (personality field) -->
                <div class="browse-char-section" id="datacatCharDescriptionSection" hidden>
                    <h3 class="browse-section-title" data-section="datacatCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="datacatCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Scenario -->
                <div class="browse-char-section" id="datacatCharScenarioSection" hidden>
                    <h3 class="browse-section-title" data-section="datacatCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="datacatCharScenario" class="scrolling-text"></div>
                </div>

                <!-- Example Messages -->
                <div class="browse-char-section browse-section-collapsed" id="datacatCharMesExampleSection" hidden>
                    <h3 class="browse-section-title" data-section="datacatCharMesExample" data-label="Example Messages" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Messages
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="datacatCharMesExample" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="datacatCharFirstMsgSection" hidden>
                    <h3 class="browse-section-title" data-section="datacatCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="datacatCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>

                <!-- Alternate Greetings -->
                <div class="browse-char-section" id="datacatCharAltGreetingsSection" hidden>
                    <h3 class="browse-section-title" data-section="browseAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="datacatCharAltGreetingsCount"></span>
                    </h3>
                    <div id="datacatCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>

                <!-- Linked Lorebooks (public lorebooks are imported as character_book; private ones are metadata only) -->
                <div class="browse-char-section" id="datacatCharLorebooksSection" hidden>
                    <h3 class="browse-section-title" data-section="datacatCharLorebooks" data-label="Linked Lorebooks" data-icon="fa-solid fa-book" title="Click to expand">
                        <i class="fa-solid fa-book"></i> Linked Lorebooks <span class="browse-section-count" id="datacatCharLorebooksCount"></span>
                    </h3>
                    <div id="datacatCharLorebooks">
                        <p class="datacat-lorebooks-note" id="datacatCharLorebooksNote" hidden>
                            <i class="fa-solid fa-circle-info"></i>
                            <span id="datacatCharLorebooksNoteText"></span>
                        </p>
                        <div id="datacatCharLorebooksList" class="datacat-lorebooks-list"></div>
                    </div>
                </div>

            </div>
        </div>
    </div>`;
    }

    // -- Lifecycle --

    _getImageGridIds() { return ['datacatGrid', 'datacatFollowingGrid']; }

    canLoadMore() {
        if (datacatViewMode === 'following') {
            return datacatFollowingDisplayLimit < datacatFollowingFiltered.length;
        }
        return datacatHasMore && !datacatIsLoading && datacatViewMode === 'browse';
    }

    init() {
        super.init();
        loadFollowedCreators();
        initDatacatView();
        const grid = document.getElementById('datacatGrid');
        if (grid) {
            this.observeImages(grid);
            // Show spinner immediately so the user doesnt see a blank grid
            // while the async session init is in flight.
            renderSkeletonGrid(grid);
        }
        // No initial load here: the base's migrated activation arm dispatches the
        // current mode's load, which bootstraps the DataCat session first.
    }

    getSearchModes() { return ['character', 'creator']; }
    getSearchInputId(mode) {
        return mode === 'creator' ? 'datacatCreatorSearchInput' : 'datacatSearchInput';
    }

    applyDefaults(defaults) {
        super.applyDefaults(defaults);
        if (defaults.sort) {
            if (datacatViewMode === 'browse') {
                // A default saved before a sort was retired would otherwise be written back here
                // unchecked and then sent upstream verbatim as sortBy.
                if (isKnownSortMode(defaults.sort)) {
                    datacatSortMode = defaults.sort;
                    const el = document.getElementById('datacatSortSelect');
                    if (el) el.value = defaults.sort;
                }
            } else {
                datacatFollowingSort = defaults.sort;
                const el = document.getElementById('datacatFollowingSortSelect');
                if (el) el.value = defaults.sort;
            }
        }
    }

    // Activation hooks and the two modes

    resetSessionState() {
        datacatBrowseMode = 'recent';
        datacatSelectedChar = null;
        datacatCharacters = [];
        datacatCurrentOffset = 0;
        datacatSearchQuery = '';
        datacatFreshLimit24 = 80;
        datacatFreshLimitWeek = 20;
        datacatHasMore = true;
        datacatIsLoading = false;
        datacatFollowingLoading = false;
        datacatGridRenderedCount = 0;
        datacatCreatorId = null;
        datacatCreatorName = '';
        dcSessionPrimed = false;
        datacatActiveTagIds.clear();
        datacatTagsLoaded = false;
        datacatViewMode = 'browse';
        datacatFollowingCharacters = [];
        datacatFollowingDisplayLimit = 60;
    }

    onActivated(isReEntry) {
        delegatesInitialized = true;
        // Eager background load so the tag picker is ready before its first open
        // (guarded internally, so re-entries are free)
        loadFacetedTags();
        updateSearchPlaceholder();
        updateTagsVisibility();
    }

    get viewModes() {
        return {
            modeAttr: 'data-datacat-view',
            current: () => datacatViewMode,
            set: (m) => { datacatViewMode = m; },
            onSwitch: () => updateSourceFilterVisibility(),
            modes: {
                browse: {
                    sectionId: 'datacatBrowseSection',
                    gridId: 'datacatGrid',
                    hasData: () => datacatCharacters.length > 0,
                    load: (o) => {
                        if (o?.append) {
                            datacatAutoTopUps = 0;
                            datacatTopUpVisible = 0;
                            advanceDatacatPage();
                            return loadCharacters(true);
                        }
                        datacatCurrentOffset = 0;
                        if (isHampterSortMode(datacatSortMode)) hampterCurrentPage = 1;
                        if (isJannySortMode(datacatSortMode)) meiliCurrentPage = 1;
                        if (o?.force) {
                            datacatFreshLimit24 = 80;
                            datacatFreshLimitWeek = 20;
                        }
                        return dcSessionPrimed ? loadCharacters(false) : bootstrapDcSession();
                    },
                    render: () => renderGrid(datacatCharacters, false),
                    chrome: () => setDatacatModeChrome('browse'),
                },
                following: {
                    sectionId: 'datacatFollowingSection',
                    gridId: 'datacatFollowingGrid',
                    hasData: () => datacatFollowingCharacters.length > 0,
                    load: (o) => {
                        if (o?.append) {
                            datacatFollowingDisplayLimit += 60;
                            renderFollowing(true);
                            return;
                        }
                        if (o?.force) {
                            datacatFollowingCharacters = [];
                            datacatFollowingDisplayLimit = 60;
                        }
                        return primeDcSession().then(() => loadFollowingCharacters(!!o?.force));
                    },
                    render: () => renderFollowing(),
                    chrome: () => setDatacatModeChrome('following'),
                },
            },
        };
    }

    // both creator sources ride the browse load; the main select swapping to creator sorts is the scope's chrome
    get creatorScope() {
        return {
            bannerId: 'datacatCreatorBanner',
            isActive: () => datacatBrowseMode === 'creator',
            load: (o) => this.viewModes.modes.browse.load(o),
            clear: () => {
                datacatBrowseMode = 'recent';
                datacatCreatorId = null;
                datacatCreatorName = '';
                datacatCharacters = [];
                datacatCurrentOffset = 0;
                datacatFreshLimit24 = 80;
                datacatFreshLimitWeek = 20;
                datacatHasMore = true;
                datacatGridRenderedCount = 0;
                const followBtn = document.getElementById('datacatFollowCreatorBtn');
                if (followBtn) followBtn.hidden = true;
            },
            chrome: () => updateSortOptions(),
            stash: () => ({
                search: datacatSearchQuery,
                meili: meiliSearchQuery,
                hampter: hampterSearchQuery,
                input: document.getElementById('datacatSearchInput')?.value || '',
            }),
            restore: (s) => {
                datacatSearchQuery = s.search;
                meiliSearchQuery = s.meili;
                hampterSearchQuery = s.hampter;
                const input = document.getElementById('datacatSearchInput');
                if (input) input.value = s.input;
                document.getElementById('datacatClearSearchBtn')?.classList.toggle('hidden', !s.input.trim());
            },
        };
    }

    deactivate() {
        datacatDetailFetchToken++;
        delegatesInitialized = false;
        clearExtractionState();
        super.deactivate();
    }
})();

export default datacatBrowseView;

// ========================================
// CREATOR DOWNLOADS ADAPTER
// ========================================

async function cdDatacatExtract(view, charId, sourceKind) {
    const url = `https://janitorai.com/characters/${charId}`;
    const publicFeed = CoreAPI.getSetting('datacatPublicFeed') === true;
    // anon sessions cap at 3 jobs and timed-out jobs stay alive server-side (no cancel API), so wait for a slot
    let sub = null;
    const slotDeadline = Date.now() + 120000;
    for (;;) {
        sub = await submitExtraction(url, { publicFeed }).catch(() => null);
        const errText = String(sub?.error || sub?.message || '');
        const capped = /Server returned 429/.test(errText) || /already have \d+ jobs/i.test(errText);
        if (!capped) break;
        if (view._cdCancelled || Date.now() >= slotDeadline) {
            view._dcJammed = true;
            return null;
        }
        await new Promise(r => setTimeout(r, 12000));
    }
    if (!sub || sub.error || sub.success === false) return null;
    const targetId = String(charId).trim();
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        if (view._cdCancelled) return null;
        await new Promise(r => setTimeout(r, 3000));
        const status = await fetchExtractionStatus().catch(() => null);
        if (!status) continue;
        const entry = status.history?.find(h => String(h.characterId || '').trim() === targetId);
        if (!entry) continue;
        if (entry.success === false || entry.status === 'error') {
            CoreAPI.debugLog('[Browse] extraction failed:', charId, entry.error || entry.message);
            return null;
        }
        await new Promise(r => setTimeout(r, 1000));
        let character = await fetchDatacatCharacter(charId, sourceKind).catch(() => null);
        if (!character) {
            await new Promise(r => setTimeout(r, 2000));
            character = await fetchDatacatCharacter(charId, sourceKind).catch(() => null);
        }
        return character;
    }
    return null;
}

registerCdAdapter('datacat', {
    async fetchAll(view) {
        const ref = view._cdRef;
        if (!ref?.creatorId) return [];
        view._dcJammed = false;
        const results = [];
        const seen = new Set();
        const push = (hit) => {
            const id = cdCharId(hit);
            if (id == null || id === '') return;
            const key = String(id);
            if (seen.has(key)) return;
            seen.add(key);
            results.push({ key, name: hit.name || '', creator: hit.creator_name || hit.creatorName || ref.name || '', raw: hit });
        };
        const PAGE = 80;
        for (let offset = 0; ; offset += PAGE) {
            // Tolerant on purpose: a mid-pagination failure keeps the partial list (only
            // a first-page failure aborts below); the fetcher itself throws classified now
            const data = await fetchDatacatCreatorCharacters(ref.creatorId, { limit: PAGE, offset, sortBy: 'chat_count' }).catch(() => null);
            if (!data) {
                if (offset === 0) throw new Error('DataCat creator fetch failed');
                break;
            }
            const list = data?.list || [];
            const before = results.length;
            for (const hit of list) push(hit);
            const total = data?.total || 0;
            if (results.length === before || list.length < PAGE || (total > 0 && results.length >= total)) break;
        }
        return results;
    },
    async importOne(view, card) {
        const provider = CoreAPI.getProvider('datacat');
        if (!provider?.importCharacter) return { ok: false, error: 'Provider not available' };
        const hit = card.raw;
        const charId = cdCharId(hit);
        const sourceKind = 'janitor';
        let character = hit._fullCharacter || await fetchDatacatCharacter(charId, sourceKind).catch(() => null);
        if (!character) {
            // once the server queue is provably full, dont burn 2 min per remaining card
            if (view._dcJammed) return { ok: false, error: 'Extraction queue full (skipped)' };
            character = await cdDatacatExtract(view, charId, sourceKind);
            if (!character) {
                return { ok: false, error: view._dcJammed ? 'Extraction queue full' : 'Extraction failed or timed out' };
            }
        }
        const result = await importThroughCommand(provider, charId, character, {});
        if (!result.success) return { ok: false, error: result.error || 'Import failed' };
        return view.creatorImportAnswer(result, provider);
    },
});
