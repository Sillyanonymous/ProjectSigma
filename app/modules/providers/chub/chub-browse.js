// ChubBrowseView - ChubAI browse/search UI for the Online tab

import {
    BrowseView, registerCdAdapter, featureFilterState, renderFeatureFilterItems, countActiveFeatures,
    browseOnlyFeatureRows, setFeatureRowsDisabled, applyFeatureParams,
    activeFeatureRows, activeFeatureExcludes, featurePasses, featureBadgesHtml,
    updateTagStateButton, tagStateButtonHtml, updateNsfwToggleButton, applyTagsClamp, cardTagsHtml,
    renderViewToggle, libraryFeatureRows, libraryBadgeHtml, libraryCardClass, renderAltGreetingsList,
    syncSortStandIn, CREATOR_SORT_STANDIN, setFilterCount,
} from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber, BROWSE_PURIFY_CONFIG, skeletonLines, deferRender, deferCall, isMobileMode, importThroughCommand, proxiedUrl, readJsonClassified, renderBrowseError, definitionFailedNotice } from '../provider-utils.js';
import {
    fetchChubMetadata,
    CHUB_API_BASE,
    CHUB_GATEWAY_BASE,
    CHUB_AVATAR_BASE,
    getChubHeaders,
    extractNodes,
    normalizeChubToken,
    savedChubToken,
} from './chub-api.js';

// ========================================
// CORE-API DESTRUCTURE
// ========================================

/* eslint-disable no-unused-vars */
const {
    onElement: on,
    showElement: show,
    hideElement: hide,
    hideModal,
    debugLog,
    showToast,
    escapeHtml,
    safePurify,
    formatRichText,
    sanitizeTaglineHtml,
    renderLoadingState,
    renderSkeletonGrid,
    getSetting,
    setSetting,
    setSettings,
    getCurrentView,
    debounce,
    renderCreatorNotesSecure,
    renderCardHtmlSecure,
    cleanupCreatorNotesContainer,
} = CoreAPI;
/* eslint-enable no-unused-vars */

// ========================================
// STATE & HELPERS
// ========================================


let chubCharacters = [];
let chubCurrentPage = 1;
let chubHasMore = true;
let chubIsLoading = false;
let chubLoadToken = 0;
let chubDiscoveryPreset = 'popular_week'; // Combined sort + time preset
let chubNsfwEnabled = false;
let chubCurrentSearch = '';
let chubSelectedChar = null;

// Discovery preset definitions (sort + time combinations)
const CHUB_DISCOVERY_PRESETS = {
    'trending':      { sort: 'trending', days: 0 }, // Chub's own trending signal (distinct from raw download_count)
    'popular_week':  { sort: 'download_count', days: 7 },
    'popular_month': { sort: 'download_count', days: 30 },
    'popular_year':  { sort: 'download_count', days: 365 }, // Most downloaded within the last year
    'popular_all':   { sort: 'download_count', days: 0 },
    'rated_week':    { sort: 'star_count', days: 7 },
    'rated_all':     { sort: 'star_count', days: 0 },
    'newest':        { sort: 'id', days: 30 }, // Last 30 days of new chars (id = creation order)
    'updated':       { sort: 'last_activity_at', days: 0 }, // Recently updated characters
    'recent_hits':   { sort: 'default', days: 0, special_mode: 'newcomer' }, // Recent hits - new characters getting lots of activity
    'random':        { sort: 'random', days: 0 }
};

// excludeForks has no param on purpose (include_forks is always sent); favorites is a mechanism, excepted from greying
const CHUB_FEATURE_FILTERS = [
    { key: 'images', id: 'chubFilterImages', section: 'must', icon: 'fa-images', label: 'Image Gallery',
      param: 'require_images', nodeTest: (c) => c.hasGallery || c.has_gallery,
      badge: { cls: ' gallery', title: 'Has Gallery', icon: 'fa-images' } },
    { key: 'lore', id: 'chubFilterLore', section: 'must', icon: 'fa-book', label: 'Lorebook',
      param: 'require_lore', nodeTest: (c) => c.has_lore || c.related_lorebooks?.length > 0,
      badge: { cls: '', title: 'Has Lorebook', icon: 'fa-book' } },
    { key: 'greetings', id: 'chubFilterGreetings', section: 'must', icon: 'fa-comments', label: 'Alt Greetings',
      param: 'require_alternate_greetings', nodeTest: (c) => c.alternate_greetings?.length > 0 || c.n_greetings > 1,
      badge: { cls: '', title: 'Alt Greetings', icon: 'fa-comment-dots' } },
    { key: 'customPrompt', id: 'chubFilterCustomPrompt', section: 'must', icon: 'fa-terminal', label: 'Custom System Prompt',
      param: 'require_custom_prompt' },
    { key: 'exampleDialogues', id: 'chubFilterExampleDialogues', section: 'must', icon: 'fa-comment-dots', label: 'Example Dialogues',
      param: 'require_example_dialogues' },
    { key: 'excludeForks', id: 'chubExcludeForks', section: 'general', icon: 'fa-code-branch', label: 'Exclude Forks' },
    { key: 'favorites', id: 'chubFilterFavorites', section: 'personal', icon: 'fa-heart', iconStyle: 'color: #e74c3c;', label: 'My Favorites' },
    ...libraryFeatureRows('chub', () => view, isCharPossibleMatchObj),
];
const chubFeatureState = featureFilterState(CHUB_FEATURE_FILTERS);

const CHUB_FILTER_SECTIONS = [
    { key: 'must', title: 'Character must have:' },
    { key: 'general' },
    { key: 'personal', title: 'Personal <span class="browse-hint-sub">(requires login)</span>:' },
    { key: 'library', title: 'Library:' },
];

// Advanced ChubAI filters (Tags dropdown)
let chubTagFilters = new Map(); // Map<tagName, 'include' | 'exclude'>
let chubSortAscending = false; // false = descending (default), true = ascending
let chubMinTokens = 50; // Minimum tokens (API default)
let chubMaxTokens = 100000; // Maximum tokens
let chubMinAiRating = 0; // Minimum AI quality score 0-100 (chub's AI judge, not user stars; 0 = off)
let chubAiRatingSortWarned = false; // once-per-session toast for the trending/newcomer incompatibility

// ChubAI View mode and author filter
let chubViewMode = 'browse'; // 'browse' or 'timeline'
let chubAuthorFilter = null; // Username to filter by
let chubAuthorSort = 'id'; // Sort for author view (id = newest)
let chubTimelineCharacters = [];
let chubTimelinePage = 1; // the next page of the source the list came from
let chubTimelineHasMore = true;
let chubTimelineLoadedFrom = null; // 'feed' or 'creators': the source the loaded list came from
let chubTimelineSort = 'newest'; // Sort for the joined timeline (client-side); the feed keeps its own order
let chubUserFavoriteIds = new Set(); // Cache of user's favorited character IDs
let chubFavoriteIdsFetchedAt = 0;    // lets per-card reads reuse the Set instead of refetching 500 rows
let chubTimelineLoadInFlight = false;
// the timeline paints this many cards at a time, revealing more from what it fetched before it asks for more
const CHUB_TIMELINE_WINDOW = 96;
let chubTimelineHidden = 0; // sorted timeline cards not painted yet
let chubTimelineSorted = null; // the last filter and sort, reused by a reveal while the list stands
let chubTimelineLoadGen = 0; // bumped by every fresh load and every reset; a load from an older one discards what it fetched
let chubCardLookup = new Map();
let chubTimelineLookup = new Map();
let chubDelegatesInitialized = false;
let chubModalEventsAttached = false;
let chubDetailFetchController = null; // AbortController for in-flight detail fetches

const chubDetailCache = new Map();
const CHUB_DETAIL_CACHE_MAX = 5; // LRU cap - keep small for mobile memory (stripped entries only)

// Append-only rendering: track how many cards are already in DOM to avoid full re-render on Load More
let chubGridRenderedCount = 0;

let view; // module-scoped BrowseView instance reference (set once in constructor)

function isCharPossibleMatchObj(c) {
    if (view.isHitInLibrary(c)) return false;
    return view.isHitPossibleMatch(c);
}

function getChubFullPath(char) {
    return char.fullPath || char.full_path || '';
}

function buildChubLookup(targetMap, characters) {
    targetMap.clear();
    for (const char of characters) {
        const path = getChubFullPath(char);
        if (path) targetMap.set(path, char);
    }
}

// Dynamic tags - populated from ChubAI API
let chubPopularTags = [];
let chubTagsLoading = false;
let chubTagsLoaded = false;

class ChubBrowseView extends BrowseView {

    constructor(provider) {
        super(provider);
        this._preloadLimit = 90;
        view = this;
    }

    hitMatchName(hit) {
        return { name: hit.name || '', creator: (hit.fullPath || hit.full_path || '').split('/')[0] || '', text: hit.description || '' };
    }

    hitLinkKey(hit) {
        return (hit?.fullPath || hit?.full_path || '').toLowerCase() || null;
    }

    // -- Following Manager --

    get supportsFollowingManager() { return true; }

    async getFollowedCreators() {
        const follows = await fetchMyFollowsList();
        if (!follows || follows.size === 0) return [];
        return [...follows].map(username => {
            const node = chubFollowsNodeMap.get(username);
            return {
                id: username,
                name: node?.user_name || node?.username || node?.name || username,
                username,
                avatar: node?.avatar_url || node?.avatar || '',
            };
        });
    }

    getCreatorAvatarUrl(creator) {
        if (creator.avatar) return creator.avatar;
        // each creator's first timeline card, mapped in one pass whenever the list changes
        const list = chubTimelineCharacters;
        if (this._firstCards?.from !== list || this._firstCards.len !== list.length) {
            const map = new Map();
            for (const c of list) {
                const fp = c.fullPath || c.full_path || '';
                const slash = fp.indexOf('/');
                if (slash <= 0) continue;
                const key = fp.slice(0, slash).toLowerCase();
                if (!map.has(key)) map.set(key, fp);
            }
            this._firstCards = { from: list, len: list.length, map };
        }
        const fp = this._firstCards.map.get(creator.id);
        return fp ? `${CHUB_AVATAR_BASE}${fp}/avatar.webp` : '';
    }

    async followCreator(query) {
        if (!savedChubToken()) {
            showToast('Login required to follow authors on ChubAI', 'warning');
            return null;
        }
        const username = query.trim().replace(/^@/, '');
        if (!username) return null;

        if (chubMyFollowsList?.has(username.toLowerCase())) {
            showToast(`Already following ${username}`, 'info');
            return null;
        }

        try {
            const response = await fetch(`${CHUB_API_BASE}/api/follow/${username}`, {
                method: 'POST',
                headers: { ...getChubHeaders(true), 'Content-Type': 'application/json' },
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            if (chubMyFollowsList) chubMyFollowsList.add(username.toLowerCase());
            showToast(`Following ${username}`, 'success');
            return { id: username.toLowerCase(), name: username, username };
        } catch (e) {
            showToast(`Failed to follow ${username}: ${e.message}`, 'error');
            return null;
        }
    }

    async unfollowCreator(id) {
        if (!savedChubToken()) return false;
        try {
            const response = await fetch(`${CHUB_API_BASE}/api/follow/${id}`, {
                method: 'DELETE',
                headers: getChubHeaders(true),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            if (chubMyFollowsList) chubMyFollowsList.delete(id.toLowerCase());
            showToast(`Unfollowed ${id}`, 'info');
            return true;
        } catch (e) {
            showToast(`Failed to unfollow: ${e.message}`, 'error');
            return false;
        }
    }

    browseCreatorFromManager(creator) {
        filterByAuthor(creator.id);
    }

    get previewModalId() { return 'chubCharModal'; }

    // the provider page a finished import's gallery is fetched from (the import summary's row)
    galleryUrlFor(result) { return `https://chub.ai/characters/${result.fullPath}`; }

    _getImageGridIds() {
        return chubViewMode === 'timeline'
            ? ['chubTimelineGrid']
            : ['chubGrid'];
    }

    closePreview() {
        closeChubCharPreview();
    }

    get mobileFilterIds() {
        return {
            sort: 'chubDiscoveryPreset',
            tags: 'chubTagsBtn',
            filters: 'chubFiltersBtn',
            nsfw: 'chubNsfwToggle',
            refresh: 'refreshChubBtn',
            timelineSort: chubTimelineJoined() ? 'chubTimelineSortHeader' : undefined,
            modeBrowseSelector: '.browse-view-btn[data-chub-view="browse"]',
            modeFollowSelector: '.browse-view-btn[data-chub-view="timeline"]',
            modeBtnClass: 'browse-view-btn',
        };
    }

    get hasModeToggle() { return true; }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'trending', label: 'Trending' },
                { value: 'popular_week', label: 'Hot This Week' },
                { value: 'popular_month', label: 'Hot This Month' },
                { value: 'popular_year', label: 'Popular This Year' },
                { value: 'popular_all', label: 'Most Downloaded' },
                { value: 'rated_week', label: 'Top Rated (Week)' },
                { value: 'rated_all', label: 'Top Rated (All Time)' },
                { value: 'newest', label: 'Newest' },
                { value: 'updated', label: 'Recently Updated' },
                { value: 'recent_hits', label: 'Recent Hits' },
                { value: 'random', label: 'Random' },
            ],
            // the feed has one order, so its timeline offers no default sort (as janitorai's following feed)
            followingSortOptions: !chubTimelineJoined() ? [] : [
                { value: 'newest', label: 'Newest Created' },
                { value: 'updated', label: 'Recently Updated' },
                { value: 'oldest', label: 'Oldest First' },
                { value: 'name_asc', label: 'Name A-Z' },
                { value: 'name_desc', label: 'Name Z-A' },
                { value: 'downloads', label: 'Most Downloads' },
                { value: 'favorites', label: 'Most Favorites' },
                { value: 'rating', label: 'Top Rated' },
            ],
            viewModes: [
                { value: 'browse', label: 'Browse' },
                { value: 'timeline', label: 'Following' },
            ],
        };
    }

    canLoadMore() {
        if (chubViewMode === 'browse') return chubHasMore && !chubIsLoading;
        if (chubViewMode === 'timeline') return (chubTimelineHidden > 0 || chubTimelineHasMore) && !chubTimelineLoadInFlight;
        return false;
    }

    // Filter Bar

    renderFilterBar() {
        return `
            <!-- Discovery Mode Toggle -->
            ${renderViewToggle('chub-view', [
                { value: 'browse', icon: 'fa-compass', label: 'Browse', title: 'Browse all characters', active: true },
                { value: 'timeline', icon: 'fa-users', label: 'Following', title: 'New from followed authors (requires token)' },
            ])}

            <!-- Sort dropdown container -->
            <div class="browse-sort-container">
                <!-- Discovery Preset (Browse mode) -->
                <select id="chubDiscoveryPreset" class="glass-select" title="Discovery mode">
                    <optgroup label="Popular">
                        <option value="trending" data-icon="fa-solid fa-arrow-trend-up">Trending</option>
                        <option value="popular_week" data-icon="fa-solid fa-fire" selected>Hot This Week</option>
                        <option value="popular_month" data-icon="fa-solid fa-fire">Hot This Month</option>
                        <option value="popular_year" data-icon="fa-solid fa-fire">Popular This Year</option>
                        <option value="popular_all" data-icon="fa-solid fa-download">Most Downloaded</option>
                    </optgroup>
                    <optgroup label="Quality">
                        <option value="rated_week" data-icon="fa-solid fa-star">Top Rated (Week)</option>
                        <option value="rated_all" data-icon="fa-solid fa-star">Top Rated (All Time)</option>
                    </optgroup>
                    <optgroup label="Discovery">
                        <option value="newest" data-icon="fa-solid fa-calendar-plus">Newest</option>
                        <option value="updated" data-icon="fa-solid fa-clock-rotate-left">Recently Updated</option>
                        <option value="recent_hits" data-icon="fa-solid fa-bolt">Recent Hits</option>
                        <option value="random" data-icon="fa-solid fa-shuffle">Random</option>
                    </optgroup>
                </select>

                <!-- Timeline Sort (Following mode) -->
                <select id="chubTimelineSortHeader" class="glass-select hidden" title="Sort timeline">
                    <option value="newest" data-icon="fa-solid fa-calendar-plus">Newest Created</option>
                    <option value="updated" data-icon="fa-solid fa-clock-rotate-left">Recently Updated</option>
                    <option value="oldest" data-icon="fa-solid fa-hourglass">Oldest First</option>
                    <option value="name_asc" data-icon="fa-solid fa-arrow-down-a-z">Name A-Z</option>
                    <option value="name_desc" data-icon="fa-solid fa-arrow-up-z-a">Name Z-A</option>
                    <option value="downloads" data-icon="fa-solid fa-download">Most Downloads</option>
                    <option value="favorites" data-icon="fa-solid fa-heart">Most Favorites</option>
                    <option value="rating" data-icon="fa-solid fa-star">Top Rated</option>
                </select>
            </div>

            <!-- Tags & Advanced Filters -->
            <div class="browse-tags-dropdown-container u-relative">
                <button id="chubTagsBtn" class="glass-btn" title="Tag filters and advanced options">
                    <i class="fa-solid fa-tags"></i> <span id="chubTagsBtnLabel">Tags</span>
                </button>
                <div id="chubTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="chubTagsSearchInput" placeholder="Search tags..." autocomplete="one-time-code">
                        <button id="chubTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="chubTagsList">
                        <div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>
                    </div>
                    <hr class="browse-filter-divider" id="chubAdvancedDivider">
                    <div id="chubAdvancedOptions">
                    <div class="dropdown-section-title"><i class="fa-solid fa-gear"></i> Advanced Options</div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-arrow-down-wide-short"></i> Sort Direction</label>
                        <select id="chubSortDirection" class="glass-select-small">
                            <option value="desc" selected data-icon="fa-solid fa-arrow-down-wide-short">Descending</option>
                            <option value="asc" data-icon="fa-solid fa-arrow-up-short-wide">Ascending</option>
                        </select>
                    </div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Min Tokens</label>
                        <input type="number" id="chubMinTokens" class="glass-input-small" value="50" min="0" max="100000" step="100">
                    </div>
                    <div class="browse-advanced-option">
                        <label><i class="fa-solid fa-text-width"></i> Max Tokens</label>
                        <input type="number" id="chubMaxTokens" class="glass-input-small" value="100000" min="0" max="500000" step="1000">
                    </div>
                    <div class="browse-advanced-option" title="ChubAI's automated quality score from 0 to 100, not the user star rating. 0 disables the filter. ChubAI scores cards roughly two weeks after upload, so newer cards are always excluded while this is set, and the Trending, Hot This Week, Top Rated (Week), and Recent Hits sorts don't support it at all.">
                        <label><i class="fa-solid fa-ranking-star"></i> Min AI Score</label>
                        <input type="number" id="chubMinAiRating" class="glass-input-small" value="0" min="0" max="100" step="5">
                    </div>
                    </div>
                </div>
            </div>

            <!-- Feature Filters -->
            <div class="browse-more-filters u-relative">
                <button id="chubFiltersBtn" class="glass-btn" title="Filter by character features">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="chubFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden">
                    ${renderFeatureFilterItems(CHUB_FILTER_SECTIONS, CHUB_FEATURE_FILTERS)}
                </div>
            </div>

            <!-- Content Toggles -->
            <button id="chubNsfwToggle" class="glass-btn nsfw-toggle" title="Toggle NSFW content">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Refresh -->
            <button id="refreshChubBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // Main View

    renderView() {
        return `
            <!-- Browse Section -->
            <div id="chubBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="chubSearchInput" placeholder="Search ChubAI characters..." autocomplete="one-time-code">
                        <button id="chubClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="chubSearchBtn" class="browse-search-submit" aria-label="Search">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                    <div class="browse-creator-search">
                        <div class="browse-creator-search-wrapper">
                            <i class="fa-solid fa-user"></i>
                            <input type="search" id="chubCreatorSearchInput" placeholder="Search by creator..." autocomplete="one-time-code">
                            <button id="chubCreatorSearchBtn" class="browse-search-submit" title="Search by creator">
                                <i class="fa-solid fa-arrow-right"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Author Filter Banner -->
                <div id="chubAuthorBanner" class="browse-author-banner hidden">
                    <div class="browse-author-banner-content">
                        <i class="fa-solid fa-user"></i>
                        <span>Showing characters by <strong id="chubAuthorBannerName">Author</strong></span>
                    </div>
                    <div class="browse-author-banner-actions">
                        <select id="chubAuthorSortSelect" class="glass-select" title="Sort author's characters">
                            <option value="id" data-icon="fa-solid fa-calendar-plus" selected>Newest Created</option>
                            <option value="last_activity_at" data-icon="fa-solid fa-clock-rotate-left">Recently Updated</option>
                            <option value="download_count" data-icon="fa-solid fa-download">Most Downloaded</option>
                            <option value="star_count" data-icon="fa-solid fa-star">Top Rated</option>
                        </select>
                        <button id="chubFollowAuthorBtn" class="glass-btn browse-author-follow-btn" title="Follow this author on ChubAI">
                            <i class="fa-solid fa-heart"></i> <span>Follow</span>
                        </button>
                        <button id="chubClearAuthorBtn" class="glass-btn icon-only" title="Clear author filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Results Grid -->
                <div id="chubGrid" class="browse-grid"></div>

                <!-- Load More -->
                <div class="browse-load-more" id="chubLoadMore" hidden>
                    <button id="chubLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>

            <!-- Timeline Section -->
            <div id="chubTimelineSection" class="browse-section hidden">
                <div class="browse-timeline-header">
                    <div class="browse-timeline-header-left">
                        <h3><i class="fa-solid fa-clock"></i> Timeline</h3>
                        <p id="chubTimelineSubtitle"></p>
                    </div>
                    <div class="browse-timeline-header-right">
                        <button class="follow-mgr-toggle-btn glass-btn" id="chubFollowMgrToggle"
                                title="Manage followed creators">
                            <i class="fa-solid fa-users-gear"></i> Manage
                        </button>
                    </div>
                </div>
                ${this.renderFollowingManagerPanel()}
                <div id="chubTimelineGrid" class="browse-grid"></div>
                <div class="browse-load-more" id="chubTimelineLoadMore" hidden>
                    <button id="chubTimelineLoadMoreBtn" class="glass-btn">
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
    <div id="chubLoginModal" class="modal-overlay hidden">
        <div class="modal-glass browse-login-modal">
            <div class="modal-header">
                <h2><i class="fa-solid fa-key"></i> ChubAI Authentication</h2>
                <button class="close-btn" id="chubLoginClose">&times;</button>
            </div>
            <div class="browse-login-body">
                <p class="browse-login-info">
                    <i class="fa-solid fa-check-circle text-success-bright"></i>
                    <strong>Browsing and downloading public characters works without a token.</strong>
                </p>
                <p class="browse-login-info">
                    <i class="fa-solid fa-key text-accent"></i>
                    <strong>Optional:</strong> Add your URQL_TOKEN to access your favorites and restricted content.
                </p>

                <div class="browse-login-form">
                    <div class="form-group">
                        <label for="chubApiKeyInput">URQL_TOKEN</label>
                        <input type="password" id="chubApiKeyInput" class="glass-input" placeholder="Paste your URQL_TOKEN here..." autocomplete="new-password">
                    </div>
                </div>

                <details class="browse-login-help">
                    <summary class="browse-login-help-summary">
                        <i class="fa-solid fa-question-circle"></i> How to get your URQL_TOKEN
                    </summary>
                    <div class="browse-login-help-body">
                        <ol class="browse-login-steps">
                            <li>Go to <a class="text-accent" href="https://chub.ai" target="_blank">chub.ai</a> and log in</li>
                            <li>Open your browser's Developer Tools (F12)</li>
                            <li>Go to the <strong>Application</strong> tab (or Storage in Firefox)</li>
                            <li>In the left sidebar, expand <strong>Local Storage</strong></li>
                            <li>Click on <code>https://chub.ai</code></li>
                            <li>Find the key <code class="text-error-bright u-bold">URQL_TOKEN</code> and copy its value</li>
                        </ol>
                        <p class="browse-login-note">
                            The token is a long string that authenticates you with ChubAI's API.
                        </p>
                    </div>
                </details>

                <div class="browse-login-actions">
                    <button id="chubSaveKeyBtn" class="cl-btn cl-btn-primary">
                        <i class="fa-solid fa-save"></i> Save Token
                    </button>
                    <button id="chubClearKeyBtn" class="cl-btn cl-btn-secondary" hidden>
                        <i class="fa-solid fa-trash"></i> Clear Token
                    </button>
                    <a href="https://chub.ai" target="_blank" class="cl-btn cl-btn-secondary">
                        <i class="fa-solid fa-external-link"></i> ChubAI Website
                    </a>
                </div>
            </div>
        </div>
    </div>`;
    }

    _renderPreviewModal() {
        return `
    <div id="chubCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="chubCharAvatar" src="" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="chubCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="chubCharCreator" class="browse-meta-identity" href="#" title="Click to see all characters by this author">Creator</a>
                            <a id="chubCreatorExternal" href="#" target="_blank" class="creator-external-link" title="Open author's ChubAI profile"><i class="fa-solid fa-external-link"></i></a> •
                            <span id="chubCharRating" title="Rating"><i class="fa-solid fa-star"></i> 0</span> •
                            <span id="chubCharDownloads" title="Downloads"><i class="fa-solid fa-download"></i> 0</span> •
                            <span id="chubCharFavoriteBtn" class="chub-favorite-btn-inline browse-fav-toggle" title="Add to favorites on ChubAI"><i class="fa-regular fa-heart"></i> <span id="chubCharFavoriteCount">0</span></span>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="chubOpenInBrowserBtn" href="#" target="_blank" class="cl-btn cl-btn-secondary" title="Open on ChubAI">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="chubDownloadBtn" class="cl-btn cl-btn-primary" title="Import into your library">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="chubCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-tagline" id="chubCharTaglineSection" hidden>
                    <i class="fa-solid fa-quote-left"></i>
                    <div id="chubCharTagline" class="browse-tagline-text"></div>
                </div>

                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-message"></i>
                            <span id="chubCharTokens">0</span> tokens
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="chubCharDate">Unknown</span>
                        </div>
                        <div class="browse-stat" id="chubCharGreetingsStat" hidden>
                            <i class="fa-solid fa-comment-dots"></i>
                            <span id="chubCharGreetingsCount">0</span> greetings
                        </div>
                        <div class="browse-stat" id="chubCharLorebookStat" hidden>
                            <i class="fa-solid fa-book"></i>
                            Lorebook
                        </div>
                        <div class="browse-stat" id="chubCharGalleryStat" hidden>
                            <i class="fa-solid fa-images"></i>
                            <span id="chubCharGalleryCount">0</span> gallery
                        </div>
                    </div>
                    <div class="browse-char-tags" id="chubCharTags"></div>
                </div>

                <!-- Creator's Notes -->
                <div class="browse-char-section" id="chubCharCreatorNotesSection" hidden>
                    <h3 class="browse-section-title" data-section="chubCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="chubCharCreatorNotes" class="scrolling-text"></div>
                </div>

                <!-- Definition loading indicator -->
                <div id="chubCharDefinitionLoading" class="browse-char-section" hidden>
                    <div class="browse-status-note"><i class="fa-solid fa-spinner fa-spin"></i> Loading character definition...</div>
                </div>

                <!-- Description -->
                <div class="browse-char-section" id="chubCharDescriptionSection" hidden>
                    <h3 class="browse-section-title" data-section="chubCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="chubCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Personality -->
                <div class="browse-char-section" id="chubCharPersonalitySection" hidden>
                    <h3 class="browse-section-title" data-section="chubCharPersonality" data-label="Personality" data-icon="fa-solid fa-brain" title="Click to expand">
                        <i class="fa-solid fa-brain"></i> Personality
                    </h3>
                    <div id="chubCharPersonality" class="scrolling-text"></div>
                </div>

                <!-- Scenario -->
                <div class="browse-char-section" id="chubCharScenarioSection" hidden>
                    <h3 class="browse-section-title" data-section="chubCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="chubCharScenario" class="scrolling-text"></div>
                </div>

                <!-- Example Dialogs -->
                <div class="browse-char-section browse-section-collapsed" id="chubCharExamplesSection" hidden>
                    <h3 class="browse-section-title" data-section="chubCharExamples" data-label="Example Dialogs" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Dialogs
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="chubCharExamples" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="chubCharFirstMsgSection" hidden>
                    <h3 class="browse-section-title" data-section="chubCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="chubCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>

                <!-- Alternate Greetings -->
                <div class="browse-char-section" id="chubCharAltGreetingsSection" hidden>
                    <h3 class="browse-section-title" data-section="browseAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="chubCharAltGreetingsCount"></span>
                    </h3>
                    <div id="chubCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>

                <!-- Gallery -->
                <div class="browse-char-section" id="chubCharGallerySection" hidden>
                    <h3 class="browse-section-title" data-section="chubCharGalleryGrid" data-label="Gallery" data-icon="fa-solid fa-images" title="Click to expand">
                        <i class="fa-solid fa-images"></i> Gallery <span class="browse-section-count" id="chubCharGalleryLabel"></span>
                    </h3>
                    <div id="chubCharGalleryGrid" class="browse-gallery-grid"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // Lifecycle

    init() {
        super.init();
        initChubView();
        this._registerDropdownDismiss([
            { dropdownId: 'chubFiltersDropdown', buttonId: 'chubFiltersBtn' },
            { dropdownId: 'chubTagsDropdown', buttonId: 'chubTagsBtn' },
        ]);
    }

    getSearchModes() { return ['character', 'creator']; }
    getSearchInputId(mode) {
        return mode === 'creator' ? 'chubCreatorSearchInput' : 'chubSearchInput';
    }

    applyDefaults(defaults) {
        super.applyDefaults(defaults);
        if (defaults.sort) {
            if (chubViewMode === 'browse') {
                chubDiscoveryPreset = defaults.sort;
                const el = document.getElementById('chubDiscoveryPreset');
                if (el) el.value = defaults.sort;
            } else {
                chubTimelineSort = defaults.sort;
                const el = document.getElementById('chubTimelineSortHeader');
                if (el) el.value = defaults.sort;
            }
        }
    }

    // Activation hooks: the base runs them in order

    resetSessionState() {
        chubCurrentSearch = '';
        chubAuthorFilter = null;
        chubCharacters = [];
        chubTimelineCharacters = [];
        chubTimelineHidden = 0;
        chubTimelineSorted = null;
        chubCurrentPage = 1;
        chubHasMore = true;
        chubIsLoading = false;
        chubGridRenderedCount = 0;
        chubViewMode = 'browse';
        chubSelectedChar = null;
        chubTimelinePage = 1;
        chubTimelineHasMore = true;
        chubTimelineLoadedFrom = null;
        chubTimelineLoadInFlight = false;
        chubTimelineLoadGen++;
    }

    onActivated(isReEntry) {
        chubDelegatesInitialized = true;
        // the NSFW setting is shared with the lorebook kind: a flip there drops both lists on re-entry
        const nsfw = getSetting('chubNsfw') === true;
        if (isReEntry && nsfw !== chubNsfwEnabled) {
            chubNsfwEnabled = nsfw;
            updateNsfwToggleState();
            chubCharacters = []; chubCurrentPage = 1; chubHasMore = true; chubGridRenderedCount = 0;
            chubTimelineCharacters = []; chubTimelinePage = 1; chubTimelineHasMore = true; chubTimelineHidden = 0; chubTimelineLoadGen++;
        }
    }

    get creatorScope() {
        return {
            bannerId: 'chubAuthorBanner',
            isActive: () => !!chubAuthorFilter,
            // the search query carries the username itself, so the scope loads through the browse hook
            load: (o) => this.viewModes.modes.browse.load(o),
            clear: () => { chubAuthorFilter = null; },
            chrome: () => {
                setChubModeChrome(chubViewMode);
                updateChubFeatureFilterAvailability();
            },
            stash: () => ({ search: chubCurrentSearch, favorites: chubFeatureState.favorites }),
            restore: (s) => {
                chubCurrentSearch = s.search;
                const input = document.getElementById('chubSearchInput');
                if (input) input.value = s.search;
                document.getElementById('chubClearSearchBtn')?.classList.toggle('hidden', !s.search);
                chubFeatureState.favorites = s.favorites;
                const favCheckbox = document.getElementById('chubFilterFavorites');
                if (favCheckbox) favCheckbox.checked = s.favorites;
            },
        };
    }

    get viewModes() {
        return {
            modeAttr: 'data-chub-view',
            current: () => chubViewMode,
            set: (m) => { chubViewMode = m; },
            onSwitch: () => updateChubFeatureFilterAvailability(),
            modes: {
                browse: {
                    sectionId: 'chubBrowseSection',
                    gridId: 'chubGrid',
                    hasData: () => chubCharacters.length > 0,
                    load: (o) => {
                        if (o?.append) chubCurrentPage++;
                        else { chubCharacters = []; chubCurrentPage = 1; }
                        return loadChubCharacters(!!o?.force);
                    },
                    render: () => { chubGridRenderedCount = 0; renderChubGrid(); },
                    chrome: () => setChubModeChrome('browse'),
                    // always reload on switch-in: browse results go stale against the
                    // filters/search the user changed while away
                    reload: true,
                    enter: () => {
                        const grid = document.getElementById('chubGrid');
                        if (grid) renderSkeletonGrid(grid);
                        chubCharacters = [];
                        chubCurrentPage = 1;
                    },
                },
                timeline: {
                    sectionId: 'chubTimelineSection',
                    gridId: 'chubTimelineGrid',
                    // a list from the other source (the setting changed since) is no data: the next entry loads afresh
                    hasData: () => chubTimelineCharacters.length > 0 && chubTimelineLoadedFrom === chubTimelineSource(),
                    // any non-append load starts again from page 1; an append reveals fetched cards before it fetches the next page
                    load: (o) => !o?.append ? loadChubTimeline(true) : chubTimelineHidden > 0 ? Promise.resolve(renderChubTimeline(true)) : loadMoreChubTimeline(),
                    render: () => renderChubTimeline(),
                    chrome: () => setChubModeChrome('timeline'),
                    enter: async () => {
                        if (chubFeatureState.favorites && savedChubToken()) {
                            await fetchChubUserFavoriteIds();
                        }
                    },
                },
            },
        };
    }

    // Library lookup

    // the heal walks both modes' grids: the one not showing keeps its painted cards
    get libraryBadgeGridIds() { return ['chubGrid', 'chubTimelineGrid']; }

    deactivate() {
        super.deactivate();
        chubDelegatesInitialized = false;
        // Reset in-flight flag so a stuck flag from a hung fetch can't block the
        // next view re-entry from kicking off a fresh load.
        chubTimelineLoadInFlight = false;
        if (chubDetailFetchController) {
            chubDetailFetchController.abort();
            chubDetailFetchController = null;
        }
    }

}

// ========================================
// CHUB BROWSE LOGIC
// ========================================



function initChubView() {
    chubNsfwEnabled = getSetting('chubNsfw') === true;

    // Sync dropdown values with JS state (browser may cache old form values)
    const discoveryPresetEl = document.getElementById('chubDiscoveryPreset');
    const timelineSortEl = document.getElementById('chubTimelineSortHeader');
    const authorSortEl = document.getElementById('chubAuthorSortSelect');
    const sortDirectionEl = document.getElementById('chubSortDirection');
    
    if (discoveryPresetEl) discoveryPresetEl.value = chubDiscoveryPreset;
    if (timelineSortEl) timelineSortEl.value = chubTimelineSort;
    if (authorSortEl) authorSortEl.value = chubAuthorSort;
    
    for (const el of [discoveryPresetEl, timelineSortEl, authorSortEl, sortDirectionEl]) {
        if (el) CoreAPI.initCustomSelect(el);
    }
    
    updateNsfwToggleState();

    setupChubGridDelegates();
    
    // View mode toggle (Browse/Timeline)
    document.querySelectorAll('.browse-view-btn[data-chub-view]').forEach(btn => {
        btn.addEventListener('click', () => {
            const newMode = btn.dataset.chubView;
            if (newMode === chubViewMode) return;
            
            // Timeline requires token
            if (newMode === 'timeline' && !savedChubToken()) {
                showToast('Timeline needs your ChubAI URQL token. Add it in the window that opened.', 'warning');
                openChubTokenModal();
                return;
            }
            
            switchChubViewMode(newMode);
        });
    });
    
    // Author filter clear button
    on('chubClearAuthorBtn', 'click', () => {
        clearAuthorFilter();
    });
    
    // Follow author button
    on('chubFollowAuthorBtn', 'click', () => {
        toggleFollowAuthor();
    });
    
    // Timeline load more button
    on('chubTimelineLoadMoreBtn', 'click', () => {
        if (chubTimelineLoadInFlight) return;
        chubBrowseView.reload({ append: true });
    });
    
    // Search handlers
    on('chubSearchInput', 'keypress', (e) => {
        if (e.key === 'Enter') {
            performChubSearch();
        }
    });
    
    on('chubSearchInput', 'input', (e) => {
        const clearBtn = document.getElementById('chubClearSearchBtn');
        if (clearBtn) {
            clearBtn.classList.toggle('hidden', !e.target.value.trim());
        }
    });
    
    on('chubSearchBtn', 'click', () => performChubSearch());
    
    on('chubClearSearchBtn', 'click', () => {
        const input = document.getElementById('chubSearchInput');
        if (input) {
            input.value = '';
            input.focus();
        }
        document.getElementById('chubClearSearchBtn')?.classList.add('hidden');
        performChubSearch();
    });
    
    // Creator search handlers
    on('chubCreatorSearchInput', 'keypress', (e) => {
        if (e.key === 'Enter') {
            performChubCreatorSearch();
        }
    });
    
    on('chubCreatorSearchBtn', 'click', () => performChubCreatorSearch());
    
    // Discovery preset select (combined sort + time)
    on('chubDiscoveryPreset', 'change', (e) => {
        chubDiscoveryPreset = e.target.value;
        chubBrowseView.reload();
    });
    
    // More filters dropdown toggle
    on('chubFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns('chubFiltersDropdown');
        document.getElementById('chubTagsDropdown')?.classList.add('hidden');
        document.getElementById('chubFiltersDropdown')?.classList.toggle('hidden');
    });
    
    // Filter checkboxes - with getter for syncing
    chubBrowseView.wireFeatureFilters(CHUB_FEATURE_FILTERS, chubFeatureState, async (f, e) => {
        debugLog(`Filter ${f.id} set to:`, e.target.checked);
        // For timeline mode with favorites filter, fetch favorite IDs first
        if (chubViewMode === 'timeline') {
            if (f.key === 'favorites' && e.target.checked) {
                await fetchChubUserFavoriteIds();
            }
            renderChubTimeline();
        } else {
            chubBrowseView.reload();
        }
    }, {
        badge: updateChubFiltersButtonState,
        beforeChange(f, e) {
            // favorites is token-gated: bounce to the login modal instead of flipping
            if (f.key === 'favorites' && e.target.checked && !savedChubToken()) {
                e.target.checked = false;
                showToast('Favorites need your ChubAI URQL token. Add it in the window that opened.', 'warning');
                show('chubLoginModal');
                return false;
            }
        },
    });
    updateChubFeatureFilterAvailability();
    
    // Tags Dropdown Handlers
    initChubTagsDropdown();
    
    // NSFW toggle - single button toggle
    on('chubNsfwToggle', 'click', () => {
        chubNsfwEnabled = !chubNsfwEnabled;
        setSetting('chubNsfw', chubNsfwEnabled);
        updateNsfwToggleState();
        
        chubBrowseView.reload();
    });
    
    // Refresh button - works for both Browse and Timeline modes
    on('refreshChubBtn', 'click', () => chubBrowseView.reload({ force: true }));
    
    // Load more button (guard against rapid clicks - don't increment page while loading)
    on('chubLoadMoreBtn', 'click', () => {
        if (chubIsLoading) return;
        chubBrowseView.reload({ append: true });
    });
    
    // Timeline sort dropdown (header only)
    on('chubTimelineSortHeader', 'change', (e) => {
        chubTimelineSort = e.target.value;
        debugLog('[ChubTimeline] Sort changed to:', chubTimelineSort);
        renderChubTimeline();
    });
    
    // Author sort dropdown
    on('chubAuthorSortSelect', 'change', (e) => {
        chubAuthorSort = e.target.value;
        chubBrowseView.reload();
    });
    
    // Modal and document-level listeners - only attach once since these elements
    // persist in document.body across provider switches (DOM recreation)
    if (!chubModalEventsAttached) {
        chubModalEventsAttached = true;

        const chubOverlay = document.getElementById('chubCharModal');
        BrowseView.wireTitleScroll(document.getElementById('chubCharName'), chubOverlay, chubOverlay?.querySelector('.browse-char-modal'));

        on('chubCharFavoriteBtn', 'click', toggleChubCharFavorite);

        // Avatar click → full-size image viewer (desktop only; mobile has its own handler,
        // so bail BEFORE stopPropagation or the mobile delegated tap never sees the event)
        const chubAvatar = document.getElementById('chubCharAvatar');
        if (chubAvatar) {
            chubAvatar.addEventListener('click', (e) => {
                if (isMobileMode()) return;
                e.stopPropagation();
                if (!chubAvatar.src) return;
                const fullSrc = chubAvatar.src.replace(/\/avatar\.webp$/, '/chara_card_v2.png');
                BrowseView.openAvatarViewer(fullSrc, chubAvatar.src);
            });
        }

        on('chubCharClose', 'click', closeChubCharPreview);
        on('chubDownloadBtn', 'click', () => downloadChubCharacter());

        const chubGalleryGrid = document.getElementById('chubCharGalleryGrid');
        if (chubGalleryGrid) {
            chubGalleryGrid.addEventListener('click', (e) => {
                if (e.target.classList.contains('browse-gallery-thumb')) {
                    const thumbs = [...chubGalleryGrid.querySelectorAll('.browse-gallery-thumb')];
                    const urls = thumbs.map(t => t.src);
                    const idx = thumbs.indexOf(e.target);
                    BrowseView.openAvatarViewer(e.target.src, null, urls, idx);
                }
            });
        }

        on('chubCharModal', 'click', (e) => {
            if (e.target.id === 'chubCharModal') closeChubCharPreview();
        });

        on('chubLoginClose', 'click', () => hideModal('chubLoginModal'));
        on('chubLoginModal', 'click', (e) => {
            if (e.target.id === 'chubLoginModal') {
                hideModal('chubLoginModal');
            }
        });
        on('chubSaveKeyBtn', 'click', saveChubToken);
        on('chubClearKeyBtn', 'click', clearChubToken);

        window.registerOverlay?.({ id: 'chubCharModal', tier: 7, close: closeChubCharPreview });
        window.registerOverlay?.({ id: 'chubLoginModal', tier: 6, close: () => hideModal('chubLoginModal') });
        window.registerOverlay?.({ id: 'chubAuthorBanner', tier: 9, close: () => clearAuthorFilter() });
    }

    loadChubToken();
    
    updateNsfwToggleState();
    
    if (!chubTagsLoaded && !chubTagsLoading) {
        fetchChubPopularTags();
    }
    
    debugLog('ChubAI view initialized');
}

// ============================================================================
// CHUB TOKEN MANAGEMENT (URQL_TOKEN)
// Uses the gallery settings system for persistent storage
// ============================================================================

function loadChubToken() {
    const savedToken = savedChubToken();
    const tokenInput = document.getElementById('chubApiKeyInput');
    if (savedToken && tokenInput) tokenInput.value = savedToken;
}

function saveChubToken() {
    const tokenInput = document.getElementById('chubApiKeyInput');
    
    if (!tokenInput) return;
    
    const token = normalizeChubToken(tokenInput.value);
    if (!token) {
        showToast('Please enter your URQL token', 'warning');
        return;
    }
    
    setSettings({ chubToken: token });
    debugLog('[ChubToken] Saved to gallery settings (persistent)');
    
    const modal = document.getElementById('chubLoginModal');
    if (modal) modal.classList.add('hidden');
    
    showToast('Token saved, and kept for your next visits', 'success');
    
    // Refresh if we have filters that need the token
    if (chubFeatureState.favorites) chubBrowseView.reload();
}

function clearChubToken() {
    setSettings({ chubToken: null });
    debugLog('[ChubToken] Cleared from gallery settings');

    const tokenInput = document.getElementById('chubApiKeyInput');
    if (tokenInput) tokenInput.value = '';

    if (chubFeatureState.favorites) {
        chubFeatureState.favorites = false;
        const favCheckbox = document.getElementById('chubFilterFavorites');
        if (favCheckbox) favCheckbox.checked = false;
        updateChubFiltersButtonState();
    }

    // Drop timeline / follows state so logged-out users dont see stale data.
    chubTimelineCharacters = [];
    chubTimelineHidden = 0;
    chubTimelineLoadGen++;
    chubTimelineLookup = new Map();
    chubFollowsNodeMap.clear();
    if (chubViewMode === 'timeline') {
        switchChubViewMode('browse');
    }

    showToast('Token cleared', 'info');
}

export function openChubTokenModal() {
    const modal = document.getElementById('chubLoginModal');
    if (!modal) return;
    
    const tokenInput = document.getElementById('chubApiKeyInput');
    const clearBtn = document.getElementById('chubClearKeyBtn');
    
    const savedToken = savedChubToken();
    if (tokenInput && savedToken) {
        tokenInput.value = savedToken;
    }

    if (clearBtn) {
        clearBtn.hidden = !savedToken;
    }
    
    modal.classList.remove('hidden');
    window.pushOverlayGuard?.();
    
    if (!chubTagsLoaded && !chubTagsLoading) {
        fetchChubPopularTags();
    }
}

/**
 * Popular tags, aggregated from top characters across several rankings for variety.
 */
async function fetchChubPopularTags() {
    if (chubTagsLoading || chubTagsLoaded) return;
    
    chubTagsLoading = true;
    
    try {
        const headers = getChubHeaders(true);
        const PAGES_PER_SORT = 2;
        
        // Fetch all sort orders in parallel; pages within each are sequential
        const sortOrders = ['download_count', 'id', 'rating', 'default'];
        const results = await Promise.all(sortOrders.map(async (sortOrder) => {
            const chars = [];
            for (let page = 1; page <= PAGES_PER_SORT; page++) {
                try {
                    const params = new URLSearchParams({
                        search: '',
                        first: '200',
                        page: page.toString(),
                        sort: sortOrder,
                        nsfw: 'true',
                        nsfl: 'true',
                        include_forks: 'false',
                        min_tokens: '50'
                    });
                    
                    const response = await fetch(`${CHUB_API_BASE}/search?${params.toString()}`, {
                        method: 'GET',
                        headers
                    });
                    
                    if (!response.ok) break;
                    
                    const data = await response.json();
                    const characters = extractNodes(data);
                    if (characters.length === 0) break;
                    chars.push(...characters);
                } catch (err) {
                    console.warn(`[ChubTags] Failed to fetch sort=${sortOrder} page=${page}:`, err);
                    break;
                }
            }
            return chars;
        }));
        
        const tagCounts = new Map();
        let totalChars = 0;
        for (const chars of results) {
            totalChars += chars.length;
            for (const char of chars) {
                for (const tag of (char.topics || [])) {
                    const normalized = tag.toLowerCase().trim();
                    if (normalized && normalized.length > 1 && normalized.length < 40) {
                        tagCounts.set(normalized, (tagCounts.get(normalized) || 0) + 1);
                    }
                }
            }
        }
        
        const sortedTags = [...tagCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 1000)
            .map(([tag]) => tag);
        
        if (sortedTags.length > 0) {
            chubPopularTags = sortedTags;
            chubTagsLoaded = true;
        }
        
        debugLog(`[ChubTags] Loaded ${chubPopularTags.length} unique tags from ${totalChars} characters`);
        
    } catch (error) {
        console.error('[ChubTags] Error fetching popular tags:', error);
    } finally {
        chubTagsLoading = false;
        
        // If the tags dropdown is already open, refresh it live
        const dropdown = document.getElementById('chubTagsDropdown');
        if (dropdown && !dropdown.classList.contains('hidden')) {
            const searchInput = document.getElementById('chubTagsSearchInput');
            renderChubTagsDropdownList(searchInput?.value || '');
        }
    }
}

/**
 * Extract popular tags from ChubAI search results
 * Supplements existing tags if not fully loaded yet
 */
function extractChubTagsFromResults(characters) {
    if (chubTagsLoaded && chubPopularTags.length >= 250) return;
    
    const tagCounts = new Map();
    
    for (const tag of chubPopularTags) {
        tagCounts.set(tag, 10); // Give existing tags a baseline
    }
    
    for (const char of characters) {
        const topics = char.topics || [];
        for (const tag of topics) {
            const normalizedTag = tag.toLowerCase().trim();
            if (normalizedTag && normalizedTag.length > 1 && normalizedTag.length < 30) {
                tagCounts.set(normalizedTag, (tagCounts.get(normalizedTag) || 0) + 1);
            }
        }
    }
    
    const sortedTags = [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 600)
        .map(([tag]) => tag);
    
    if (sortedTags.length > chubPopularTags.length) {
        chubPopularTags = sortedTags;
    }
}

function updateChubFiltersButtonState() {
    const btn = document.getElementById('chubFiltersBtn');
    if (!btn) return;
    
    // Browse-only toggles (server-param-only rows, DERIVED) don't count in the
    // Following tab, where they can't filter anything
    const inertKeys = chubViewMode === 'timeline'
        ? browseOnlyFeatureRows(CHUB_FEATURE_FILTERS, { except: ['favorites'] }).map(f => f.key)
        : [];
    const count = countActiveFeatures(CHUB_FEATURE_FILTERS, chubFeatureState, { inertKeys });

    setFilterCount(btn, 'Features', count);
}

function updateChubFeatureFilterAvailability() {
    const inTimeline = chubViewMode === 'timeline';
    setFeatureRowsDisabled(
        browseOnlyFeatureRows(CHUB_FEATURE_FILTERS, { except: ['favorites'] }),
        inTimeline, 'Not available in the Following tab');
    // the favorites loader never reads the author, so the row is parked while a creator scope is up (it lives on browse)
    setFeatureRowsDisabled(
        CHUB_FEATURE_FILTERS.filter(f => f.key === 'favorites'),
        !inTimeline && !!chubAuthorFilter, 'Not available while viewing a creator');
    updateChubFiltersButtonState();
}

function updateNsfwToggleState() {
    updateNsfwToggleButton('chubNsfwToggle', chubNsfwEnabled);
}

// ============================================================================
// CHUBAI TAGS DROPDOWN (Tri-state tag filters + advanced options)
// ============================================================================

/**
 * Add a custom tag as an include filter (typed by the user, not from the pre-fetched list)
 */
function addCustomChubTagFilter(tagText) {
    const normalized = tagText.toLowerCase().trim();
    if (!normalized || normalized.length < 2) return;

    if (!chubPopularTags.includes(normalized)) {
        chubPopularTags.unshift(normalized);
    }
    chubTagFilters.set(normalized, 'include');

    const searchInput = document.getElementById('chubTagsSearchInput');
    if (searchInput) searchInput.value = '';
    renderChubTagsDropdownList();
    updateChubTagsButtonState();
    triggerChubReloadDebounced();
}

/**
 * Initialize the Tags dropdown with event handlers
 */
function initChubTagsDropdown() {
    const btn = document.getElementById('chubTagsBtn');
    const dropdown = document.getElementById('chubTagsDropdown');
    const searchInput = document.getElementById('chubTagsSearchInput');
    const clearBtn = document.getElementById('chubTagsClearBtn');
    
    if (!btn || !dropdown) return;
    
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns('chubTagsDropdown');
        const wasHidden = dropdown.classList.contains('hidden');
        document.getElementById('chubFiltersDropdown')?.classList.add('hidden');
        dropdown.classList.toggle('hidden');
        
        if (wasHidden) {
            renderChubTagsDropdownList();
            // Skip auto-focus on mobile - it spawns the virtual keyboard
            if (!isMobileMode()) {
                searchInput?.focus();
            }
        }
    });
    
    // Prevent dropdown from closing when clicking inside
    dropdown.addEventListener('click', (e) => {
        e.stopPropagation();
    });
    
    // Tag search filtering
    searchInput?.addEventListener('input', debounce(() => {
        renderChubTagsDropdownList(searchInput.value);
    }, 150));

    // Enter key adds typed tag directly as a filter
    searchInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const value = searchInput.value.trim();
            if (value) addCustomChubTagFilter(value);
        }
    });
    
    clearBtn?.addEventListener('click', () => {
        chubTagFilters.clear();
        if (searchInput) searchInput.value = '';
        renderChubTagsDropdownList('');
        updateChubTagsButtonState();
        triggerChubReload();
    });
    
    // Advanced options handlers
    const sortDir = document.getElementById('chubSortDirection');
    const minTokens = document.getElementById('chubMinTokens');
    const maxTokens = document.getElementById('chubMaxTokens');
    
    sortDir?.addEventListener('change', (e) => {
        chubSortAscending = e.target.value === 'asc';
        triggerChubReload();
    });
    
    minTokens?.addEventListener('change', (e) => {
        chubMinTokens = parseInt(e.target.value) || 50;
        triggerChubReload();
    });
    
    maxTokens?.addEventListener('change', (e) => {
        chubMaxTokens = parseInt(e.target.value) || 100000;
        triggerChubReload();
    });

    document.getElementById('chubMinAiRating')?.addEventListener('change', (e) => {
        chubMinAiRating = parseInt(e.target.value) || 0;
        triggerChubReload();
    });
}

/**
 * Trigger a reload of ChubAI characters
 */
function triggerChubReload() {
    if (chubViewMode === 'timeline') {
        renderChubTimeline();
    } else {
        chubBrowseView.reload();
    }
}

// Debounce timeout for tag filter changes
let chubTagFilterDebounceTimeout = null;

/**
 * Debounced version of triggerChubReload for tag filtering
 * Waits 500ms after the last change before reloading
 */
function triggerChubReloadDebounced() {
    if (chubTagFilterDebounceTimeout) {
        clearTimeout(chubTagFilterDebounceTimeout);
    }
    chubTagFilterDebounceTimeout = setTimeout(() => {
        chubTagFilterDebounceTimeout = null;
        triggerChubReload();
    }, 500);
}

/**
 * Render the tag list in the dropdown with tri-state buttons
 */
function renderChubTagsDropdownList(filter = '') {
    const container = document.getElementById('chubTagsList');
    if (!container) return;
    
    if (chubTagsLoading) {
        container.innerHTML = '<div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>';
        return;
    }
    
    if (chubPopularTags.length === 0) {
        if (!chubTagsLoaded) {
            fetchChubPopularTags().then(() => renderChubTagsDropdownList(filter));
        } else {
            container.innerHTML = '<div class="browse-tags-empty">No tags available</div>';
        }
        return;
    }
    
    // Filter tags
    const filterLower = filter.toLowerCase();
    const filteredTags = filter
        ? chubPopularTags.filter(tag => tag.toLowerCase().includes(filterLower))
        : chubPopularTags;

    const hasExactMatch = filter && filteredTags.some(t => t.toLowerCase() === filterLower);
    const showCustomAdd = filter && filterLower.length >= 2 && !hasExactMatch;
    
    if (filteredTags.length === 0 && !showCustomAdd) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }
    
    // Sort: active filters first, then alphabetically
    const sortedTags = [...filteredTags].sort((a, b) => {
        const aState = chubTagFilters.get(a);
        const bState = chubTagFilters.get(b);
        if (aState && !bState) return -1;
        if (!aState && bState) return 1;
        return a.localeCompare(b);
    });
    
    // "Add as filter" row when typed text isn't in the list
    const customAddHtml = showCustomAdd ? `
        <div class="browse-tag-filter-item browse-tag-custom-add" data-custom-tag="${escapeHtml(filterLower)}">
            <button class="browse-tag-state-btn state-include" aria-label="Add as filter"><i class="fa-solid fa-plus"></i></button>
            <span class="tag-label">Add <strong>${escapeHtml(filterLower)}</strong> as filter</span>
        </div>
    ` : '';

    container.innerHTML = customAddHtml + sortedTags.map(tag => {
        const state = chubTagFilters.get(tag) || 'neutral';
        
        return `
            <div class="browse-tag-filter-item" data-tag="${escapeHtml(tag)}">
                ${tagStateButtonHtml(state)}
                <span class="tag-label">${escapeHtml(tag)}</span>
            </div>
        `;
    }).join('');
    
    // Custom-add row click handler
    container.querySelector('.browse-tag-custom-add')?.addEventListener('click', () => {
        addCustomChubTagFilter(filterLower);
    });

    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const tag = item.dataset.tag;
        const stateBtn = item.querySelector('.browse-tag-state-btn');
        const label = item.querySelector('.tag-label');
        
        const cycleState = () => {
            const current = chubTagFilters.get(tag) || 'neutral';
            let newState;
            
            // Cycle: neutral -> include -> exclude -> neutral
            if (current === 'neutral') {
                newState = 'include';
                chubTagFilters.set(tag, 'include');
            } else if (current === 'include') {
                newState = 'exclude';
                chubTagFilters.set(tag, 'exclude');
            } else {
                newState = 'neutral';
                chubTagFilters.delete(tag);
            }
            
            updateTagStateButton(stateBtn, newState);
            updateChubTagsButtonState();
            triggerChubReloadDebounced();
        };
        
        stateBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            cycleState();
        });
        
        label?.addEventListener('click', cycleState);
    });
}

/**
 * Update the Tags button to show active filter count
 */
function updateChubTagsButtonState() {
    const btn = document.getElementById('chubTagsBtn');
    if (!btn) return;
    
    const includeCount = Array.from(chubTagFilters.values()).filter(v => v === 'include').length;
    const excludeCount = Array.from(chubTagFilters.values()).filter(v => v === 'exclude').length;
    
    const hasAdvanced = chubSortAscending || chubMinTokens !== 50 || chubMaxTokens !== 100000 || chubMinAiRating > 0;
    
    const parts = [];
    if (includeCount > 0) parts.push(`+${includeCount}`);
    if (excludeCount > 0) parts.push(`-${excludeCount}`);
    setFilterCount(btn, 'Tags', parts.join('/'), parts.length > 0 || hasAdvanced);
}

// ============================================================================
// CHUBAI VIEW MODE SWITCHING (Browse/Timeline)
// ============================================================================

// the timeline's one order, verified live: lastActivityAt, newest first
const CHUB_TIMELINE_STANDIN = Object.freeze({ label: 'Latest Updates', icon: 'fa-solid fa-clock-rotate-left', title: 'The timeline lists the latest updates first' });

// The mode-specific filter chrome (custom selects, tags dropdown, the API-only
// advanced options block); the switching skeleton lives in the base contract.
function setChubModeChrome(mode) {
    const browse = mode === 'browse';
    const discoveryPreset = document.getElementById('chubDiscoveryPreset');
    const timelineSortHeader = document.getElementById('chubTimelineSortHeader');
    const dpTarget = discoveryPreset?._customSelect?.container || discoveryPreset;
    const tsTarget = timelineSortHeader?._customSelect?.container || timelineSortHeader;
    // the username query never reads the preset, so the scope hides it too
    const scoped = browse && !!chubAuthorFilter;
    if (dpTarget) dpTarget.classList.toggle('hidden', !browse || scoped);
    // the feed has one order, so its timeline takes no sort; the joined timeline sorts what it holds
    const joined = chubTimelineJoined();
    if (tsTarget) tsTarget.classList.toggle('hidden', browse || !joined);
    syncSortStandIn(discoveryPreset, scoped ? CREATOR_SORT_STANDIN : !browse && !joined ? CHUB_TIMELINE_STANDIN : null, [CHUB_TIMELINE_STANDIN, CREATOR_SORT_STANDIN]);
    const subtitle = document.getElementById('chubTimelineSubtitle');
    if (subtitle) subtitle.textContent = joined ? 'Newest characters from every creator you follow' : 'Latest updates from creators and tags you follow';
    // the timeline takes no direction, token range or score: those rows grey there, saying why, and keep their own title for browse
    for (const row of document.querySelectorAll('#chubAdvancedOptions .browse-advanced-option')) {
        row.classList.toggle('browse-option-disabled', !browse);
        for (const field of row.querySelectorAll('input, select')) {
            field.disabled = !browse;
            field._customSelect?.update?.();
        }
        if (!browse && !('liveTitle' in row.dataset)) {
            row.dataset.liveTitle = row.title;
            row.title = 'Not available in Following';
        } else if (browse && 'liveTitle' in row.dataset) {
            row.title = row.dataset.liveTitle;
            delete row.dataset.liveTitle;
        }
    }
    updateChubAiRatingFieldState();
}

function switchChubViewMode(mode) {
    return chubBrowseView.switchViewMode(mode);
}

// ============================================================================
// CHUBAI TIMELINE (Chub's own feed; every followed creator merged when chubTimelineJoined is on)
// ============================================================================

const chubTimelineJoined = () => getSetting('chubTimelineJoined') === true;
const chubTimelineSource = () => (chubTimelineJoined() ? 'creators' : 'feed');

// the feed carries every kind a followed creator posts: a character is user/slug, the rest sit under their kind (lorebooks/, presets/ etc)
function isChubTimelineCharacter(node) {
    const path = (node.fullPath || node.full_path || '').replace(/^characters\//, '');
    return path.split('/').length === 2 && !Array.isArray(node.entries);
}

/**
 * One page of Chub's timeline feed, read as chub.ai reads it: numbered, twenty to a page, no cursor; an empty page is its end.
 * @param {number} page
 * @returns {Promise<object[]|null>} the page's nodes, null when the token is refused
 */
async function fetchChubFeedPage(page) {
    const params = new URLSearchParams({ page: String(page), count: 'false', nsfw: String(chubNsfwEnabled), nsfl: String(chubNsfwEnabled) });
    const response = await fetch(`${CHUB_API_BASE}/api/timeline/v1?${params}`, { headers: getChubHeaders(true) });
    if (response.status === 401) return null;
    const data = await readJsonClassified(response);
    return (data.data || data).nodes || [];
}

/**
 * One page of each followed creator's newest characters, 24 a creator; there is more while any creator filled its page.
 * @param {number} page
 * @returns {Promise<{ nodes: object[], more: boolean }|null>} null when ChubAI does not recognize the token
 */
async function fetchJoinedTimelinePage(page) {
    const followedAuthors = await fetchMyFollowsList();
    if (!followedAuthors || followedAuthors.size === 0) return chubFollowsSignedIn === false ? null : { nodes: [], more: false };
    const PAGE_SIZE = 24;
    const authors = [...followedAuthors];
    const nodes = [];
    let more = false;
    for (let i = 0; i < authors.length; i += 5) {
        const results = await Promise.all(authors.slice(i, i + 5).map(async (author) => {
            try {
                const params = new URLSearchParams({ username: author, first: String(PAGE_SIZE), page: String(page), sort: 'id', nsfw: String(chubNsfwEnabled), nsfl: String(chubNsfwEnabled), include_forks: 'true' });
                const response = await fetch(`${CHUB_API_BASE}/search?${params}`, { headers: getChubHeaders(true) });
                if (!response.ok) {
                    debugLog(`[ChubTimeline] Error from ${author}: ${response.status}`);
                    return [];
                }
                const data = await response.json();
                const found = data.nodes || data.data?.nodes || [];
                if (found.length >= PAGE_SIZE) more = true;
                return found;
            } catch (e) {
                debugLog(`[ChubTimeline] Error fetching from ${author}:`, e.message);
                return [];
            }
        }));
        for (const found of results) nodes.push(...found);
    }
    return { nodes, more };
}

// a fresh load starts the source the setting names; an append fetches the next page of the source the list came from
async function loadChubTimeline(forceRefresh = false, append = false) {
    if (!savedChubToken()) {
        renderTimelineEmpty('login');
        return;
    }
    if (chubTimelineLoadInFlight) return;
    chubTimelineLoadInFlight = true;
    const grid = document.getElementById('chubTimelineGrid');
    if (forceRefresh || !append) {
        chubTimelineLoadGen++;
        renderSkeletonGrid(grid);
        chubTimelineCharacters = [];
        chubTimelineHidden = 0;
        chubTimelinePage = 1;
        chubTimelineHasMore = true;
        chubTimelineLoadedFrom = chubTimelineSource();
    }
    // a load a newer one superseded (or a leave dropped) lands on nothing: its page and its cards are the newer load's to fetch
    const gen = chubTimelineLoadGen;

    try {
        const seen = new Set(chubTimelineCharacters.map(c => getChubFullPath(c).toLowerCase()));
        let added = 0;
        // a page of lorebooks or presets alone adds no card, so the next is asked for at once, a few pages at most
        for (let pages = 0; pages < 5 && added === 0 && chubTimelineHasMore; pages++) {
            // the page is claimed before the request, so two appends never ask for the same one
            const page = chubTimelinePage++;
            let nodes;
            if (chubTimelineLoadedFrom === 'creators') {
                const got = await fetchJoinedTimelinePage(page);
                if (gen !== chubTimelineLoadGen) return;
                if (got === null) {
                    renderTimelineEmpty('login');
                    return;
                }
                nodes = got.nodes;
                chubTimelineHasMore = got.more;
            } else {
                nodes = await fetchChubFeedPage(page);
                if (gen !== chubTimelineLoadGen) return;
                if (nodes === null) {
                    renderTimelineEmpty('login');
                    return;
                }
                chubTimelineHasMore = nodes.length > 0;
            }
            await chubBrowseView.probeHits(nodes);
            if (gen !== chubTimelineLoadGen) return;

            for (const node of nodes) {
                const path = getChubFullPath(node).toLowerCase();
                if (!path || seen.has(path) || !isChubTimelineCharacter(node)) continue;
                seen.add(path);
                chubTimelineCharacters.push(node);
                added++;
            }
        }

        if (chubTimelineCharacters.length === 0) {
            if (!chubTimelineHasMore) renderTimelineEmpty('empty');
            reportChubTimelinePage();
        } else {
            renderChubTimeline(append);
        }
    } catch (e) {
        if (gen !== chubTimelineLoadGen) return;
        console.error('[ChubTimeline] Load error:', e);
        if (grid) {
            renderBrowseError(grid, {
                provider: 'chub',
                error: e,
                title: 'Failed to Load Timeline',
                view: 'timeline',
                flags: { token: !!savedChubToken() },
                retry: () => loadChubTimeline(true),
            });
        }
    } finally {
        if (gen === chubTimelineLoadGen) chubTimelineLoadInFlight = false;
    }
}

// the loader sets the in-flight flag itself; pre-setting it here trips its own re-entry guard
async function loadMoreChubTimeline() {
    if (chubTimelineLoadInFlight || !chubTimelineHasMore) return;
    const loadMoreBtn = document.getElementById('chubTimelineLoadMoreBtn');
    const originalLoadMoreHtml = loadMoreBtn ? loadMoreBtn.innerHTML : '';
    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }
    try {
        await loadChubTimeline(false, true);
    } finally {
        if (loadMoreBtn) {
            loadMoreBtn.disabled = false;
            loadMoreBtn.innerHTML = originalLoadMoreHtml || '<i class="fa-solid fa-plus"></i> Load More';
        }
    }
}

function renderTimelineEmpty(reason) {
    const grid = document.getElementById('chubTimelineGrid');
    
    if (reason === 'login') {
        grid.innerHTML = `
            <div class="browse-timeline-empty">
                <i class="fa-solid fa-key"></i>
                <h3>Token Required</h3>
                <p>Add your ChubAI URQL token to see new characters from authors you follow.</p>
                <button class="cl-btn cl-btn-primary browse-add-token-btn">
                    <i class="fa-solid fa-key"></i> Add Token
                </button>
            </div>
        `;
    } else if (reason === 'no_follows') {
        grid.innerHTML = `
            <div class="browse-timeline-empty">
                <i class="fa-solid fa-user-plus"></i>
                <h3>No Followed Authors</h3>
                <p>Follow some character creators on ChubAI to see their new characters here.</p>
                <a href="https://chub.ai" target="_blank" class="cl-btn cl-btn-primary">
                    <i class="fa-solid fa-external-link"></i> Find Authors on ChubAI
                </a>
            </div>
        `;
    } else {
        grid.innerHTML = `
            <div class="browse-timeline-empty">
                <i class="fa-solid fa-inbox"></i>
                <h3>No New Characters</h3>
                <p>Authors you follow haven't posted new characters recently.</p>
                <a href="https://chub.ai" target="_blank" class="cl-btn cl-btn-primary">
                    <i class="fa-solid fa-external-link"></i> Browse ChubAI
                </a>
            </div>
        `;
    }
}

/**
 * Sort timeline characters based on the current sort option (client-side)
 */
function sortTimelineCharacters(characters) {
    switch (chubTimelineSort) {
        case 'newest':
            return characters.sort((a, b) => {
                const dateA = a.createdAt || a.created_at || a.id || 0;
                const dateB = b.createdAt || b.created_at || b.id || 0;
                if (typeof dateA === 'string' && typeof dateB === 'string') {
                    return new Date(dateB) - new Date(dateA);
                }
                return dateB - dateA;
            });
        case 'updated':
            return characters.sort((a, b) => {
                const dateA = a.lastActivityAt || a.last_activity_at || a.updatedAt || a.updated_at || a.createdAt || a.created_at || 0;
                const dateB = b.lastActivityAt || b.last_activity_at || b.updatedAt || b.updated_at || b.createdAt || b.created_at || 0;
                if (typeof dateA === 'string' && typeof dateB === 'string') {
                    return new Date(dateB) - new Date(dateA);
                }
                return dateB - dateA;
            });
        case 'oldest':
            return characters.sort((a, b) => {
                const dateA = a.createdAt || a.created_at || a.id || 0;
                const dateB = b.createdAt || b.created_at || b.id || 0;
                if (typeof dateA === 'string' && typeof dateB === 'string') {
                    return new Date(dateA) - new Date(dateB);
                }
                return dateA - dateB;
            });
        case 'name_asc':
            return characters.sort((a, b) => {
                const nameA = (a.name || '').toLowerCase();
                const nameB = (b.name || '').toLowerCase();
                return nameA.localeCompare(nameB);
            });
        case 'name_desc':
            return characters.sort((a, b) => {
                const nameA = (a.name || '').toLowerCase();
                const nameB = (b.name || '').toLowerCase();
                return nameB.localeCompare(nameA);
            });
        case 'downloads':
            // ChubAI's weird naming: starCount is actually downloads
            return characters.sort((a, b) => {
                const dlA = a.starCount || 0;
                const dlB = b.starCount || 0;
                return dlB - dlA;
            });
        case 'rating':
            return characters.sort((a, b) => {
                const ratingA = a.rating || 0;
                const ratingB = b.rating || 0;
                return ratingB - ratingA;
            });
        case 'favorites':
            return characters.sort((a, b) => {
                const favA = a.n_favorites || a.nFavorites || 0;
                const favB = b.n_favorites || b.nFavorites || 0;
                return favB - favA;
            });
        default:
            return characters;
    }
}

function _handleTimelineCardClick(e) {
    if (e.target.closest('.browse-add-token-btn')) { openChubTokenModal(); return; }
    const authorLink = e.target.closest('.browse-card-creator-link');
    if (authorLink) {
        e.stopPropagation();
        const author = authorLink.dataset.author;
        if (author) filterByAuthor(author);
        return;
    }
    const card = e.target.closest('.browse-card');
    if (!card) return;
    const fullPath = card.dataset.fullPath;
    const char = chubTimelineLookup.get(fullPath) || chubTimelineCharacters.find(c => getChubFullPath(c) === fullPath);
    if (char) openChubCharPreview(char);
}

const chubTimelineShowing = () => getCurrentView() === 'online' && chubViewMode === 'timeline';

// the fill check measures the grid showing, so a hidden timeline never reports
function reportChubTimelinePage() {
    if (!chubTimelineShowing()) return;
    chubBrowseView.updateLoadMoreVisibility('chubTimelineLoadMore', chubTimelineHidden > 0 || chubTimelineHasMore, true);
}

// paints the first window, or appending the next cards not yet painted, then reports the page; false when the timeline is hidden
function renderChubTimeline(appendOnly = false) {
    const grid = document.getElementById('chubTimelineGrid');
    if (!chubTimelineShowing()) {
        // an empty grid has the mode dispatch paint it when it shows; the shared image observer stays with the grid showing
        grid.innerHTML = '';
        chubTimelineHidden = 0;
        return false;
    }

    let sortedCharacters;
    const sorted = chubTimelineSorted;
    // a reveal reuses the last sort while the list stands; new cards or a full render sort again
    if (appendOnly && sorted?.from === chubTimelineCharacters && sorted.len === chubTimelineCharacters.length) {
        sortedCharacters = sorted.list;
    } else {
        const includeTags = [];
        const excludeTags = [];
        for (const [tag, state] of chubTagFilters) {
            if (state === 'include') includeTags.push(tag.toLowerCase());
            else if (state === 'exclude') excludeTags.push(tag.toLowerCase());
        }
        // Persistent excludes are user-typed; lowercase to match the charTopics map below.
        for (const t of view.persistentExcludeTags()) {
            const lt = t.toLowerCase();
            if (!excludeTags.includes(lt)) excludeTags.push(lt);
        }

        // active predicate rows precomputed once per render, then one pass per card
        const activeRows = activeFeatureRows(CHUB_FEATURE_FILTERS, chubFeatureState);
        const favoritesActive = chubFeatureState.favorites && chubUserFavoriteIds.size > 0;
        const anyFilterActive = activeRows.length > 0 || favoritesActive ||
            includeTags.length > 0 || excludeTags.length > 0;

        let filteredCharacters;
        if (anyFilterActive) {
            filteredCharacters = chubTimelineCharacters.filter(c => {
                if (!featurePasses(c, activeRows)) return false;
                if (favoritesActive && !chubUserFavoriteIds.has(c.id || c.project_id)) return false;
                // Tag filters (client-side - timeline data already has topics)
                if (includeTags.length > 0 || excludeTags.length > 0) {
                    const charTopics = (c.topics || []).map(t => t.toLowerCase());
                    if (includeTags.length > 0 && !includeTags.every(t => charTopics.includes(t))) return false;
                    if (excludeTags.length > 0 && excludeTags.some(t => charTopics.includes(t))) return false;
                }
                return true;
            });
        } else {
            filteredCharacters = chubTimelineCharacters.slice();
        }

        sortedCharacters = chubTimelineLoadedFrom === 'creators' ? sortTimelineCharacters(filteredCharacters) : filteredCharacters;
        chubTimelineSorted = { from: chubTimelineCharacters, len: chubTimelineCharacters.length, list: sortedCharacters };
        buildChubLookup(chubTimelineLookup, sortedCharacters);
    }

    if (sortedCharacters.length === 0 && chubTimelineCharacters.length > 0) {
        chubTimelineHidden = 0;
        chubTimelineLookup.clear();
        grid.innerHTML = `
            <div class="browse-timeline-empty">
                <i class="fa-solid fa-filter"></i>
                <h3>No Matching Characters</h3>
                <p>No characters match your current filters. Try adjusting the filters.</p>
            </div>
        `;
        reportChubTimelinePage();
        return true;
    }

    const painted = appendOnly ? new Set(Array.from(grid.querySelectorAll('.browse-card[data-full-path]'), c => c.dataset.fullPath)) : null;
    if (painted?.size) {
        // the next window in sort order: cards a fetch sorted above the fold join at the end, never mid-grid
        const next = [];
        let unpainted = 0;
        for (const c of sortedCharacters) {
            if (painted.has(getChubFullPath(c))) continue;
            if (next.length < CHUB_TIMELINE_WINDOW) next.push(c);
            unpainted++;
        }
        if (next.length > 0) {
            grid.insertAdjacentHTML('beforeend', next.map(char => createChubCard(char)).join(''));
            chubBrowseView.observeImages(grid);
        }
        chubTimelineHidden = unpainted - next.length;
    } else {
        chubBrowseView.disconnectImageObserver();
        const first = sortedCharacters.slice(0, CHUB_TIMELINE_WINDOW);
        grid.innerHTML = first.map(char => createChubCard(char)).join('');
        chubBrowseView.observeImages(grid);
        chubTimelineHidden = sortedCharacters.length - first.length;
    }
    reportChubTimelinePage();
    return true;
}

// ============================================================================
// AUTHOR FILTERING
// ============================================================================

/**
 * Search for a creator from the creator search input
 */
function performChubCreatorSearch() {
    const creatorInput = document.getElementById('chubCreatorSearchInput');
    const creatorName = creatorInput?.value.trim();
    
    if (!creatorName) {
        showToast('Please enter a creator name', 'warning');
        return;
    }
    
    creatorInput.value = '';
    
    filterByAuthor(creatorName);
}

// enter the creator scope; the base shows the banner, runs the chrome and loads (later reloads land there too)
function filterByAuthor(authorName) {
    chubBrowseView.enterCreatorScope(() => {
        chubAuthorFilter = authorName;
        view._cdRef = { name: authorName };
        chubCurrentSearch = '';
        const searchInput = document.getElementById('chubSearchInput');
        if (searchInput) searchInput.value = '';
        document.getElementById('chubClearSearchBtn')?.classList.add('hidden');
        // the favorites loader never reads the author; the stash brings the flag back on exit
        chubFeatureState.favorites = false;
        const favCheckbox = document.getElementById('chubFilterFavorites');
        if (favCheckbox) favCheckbox.checked = false;
        // Reset author sort to newest (most useful default when viewing an author)
        chubAuthorSort = 'id';
        const sortSelect = document.getElementById('chubAuthorSortSelect');
        if (sortSelect) sortSelect.value = 'id';
        const bannerName = document.getElementById('chubAuthorBannerName');
        if (bannerName) bannerName.textContent = authorName;
        window.pushOverlayGuard?.();
        updateFollowAuthorButton(authorName);
    });
}

// Track if we're following the current author
let chubIsFollowingCurrentAuthor = false;
let chubMyFollowsList = null; // Cache of who we follow
let chubFollowsSignedIn = null; // the follows read's verdict on the token: true, false, or null when it could not tell
let chubMyFollowsToken = null; // the token the cached follows were read with
let chubFollowsNodeMap = new Map(); // username → node data from follows API

// Fetch list of users we follow (cached)
async function fetchMyFollowsList(forceRefresh = false) {
    // the cache is the account's whose token read it: a token changed anywhere (the view, Settings) reads again
    if (chubMyFollowsList && !forceRefresh && chubMyFollowsToken === savedChubToken()) {
        return chubMyFollowsList;
    }
    
    if (!savedChubToken()) return [];
    
    try {
        const accountResp = await fetch(`${CHUB_API_BASE}/api/account`, {
            headers: getChubHeaders(true)
        });
        
        if (!accountResp.ok) {
            debugLog('[ChubFollow] Could not get account info');
            chubFollowsSignedIn = accountResp.status === 401 ? false : null;
            return [];
        }
        
        const accountData = await accountResp.json();
        // an unrecognized token answers an anonymous account, its id zero or below
        chubFollowsSignedIn = Number(accountData.id ?? accountData.data?.id) > 0;
        if (!chubFollowsSignedIn) return [];
        
        // API returns user_name (with underscore), not username
        const myUsername = accountData.user_name || accountData.name || accountData.username || 
                          accountData.data?.user_name || accountData.data?.name;
        
        if (!myUsername) {
            debugLog('[ChubFollow] No username found in account data');
            return [];
        }
        
        const followsResp = await fetch(`${CHUB_API_BASE}/api/follows/${myUsername}?page=1`, {
            headers: getChubHeaders(true)
        });
        
        if (!followsResp.ok) {
            debugLog('[ChubFollow] Could not get follows list');
            return [];
        }
        
        const followsData = await followsResp.json();
        
        const followsList = followsData.follows || followsData.nodes || followsData.data?.follows || followsData.data?.nodes || [];
        const followedUsernames = new Set();
        chubFollowsNodeMap.clear();
        
        for (const node of followsList) {
            const username = node.user_name || node.username || node.name || node.user?.user_name || node.user?.username;
            if (username) {
                const key = username.toLowerCase();
                followedUsernames.add(key);
                chubFollowsNodeMap.set(key, node);
            }
        }
        
        // Fetch more pages if needed (count tells us total)
        const totalCount = followsData.count || 0;
        let page = 2;
        while (followedUsernames.size < totalCount && page <= 20) {
            const moreResp = await fetch(`${CHUB_API_BASE}/api/follows/${myUsername}?page=${page}`, {
                headers: getChubHeaders(true)
            });
            
            if (!moreResp.ok) break;
            
            const moreData = await moreResp.json();
            const moreFollows = moreData.follows || moreData.nodes || moreData.data?.follows || [];
            
            if (moreFollows.length === 0) break;
            
            for (const node of moreFollows) {
                const username = node.user_name || node.username || node.name || node.user?.user_name;
                if (username) {
                    const key = username.toLowerCase();
                    followedUsernames.add(key);
                    chubFollowsNodeMap.set(key, node);
                }
            }
            page++;
        }
        
        chubMyFollowsList = followedUsernames;
        chubMyFollowsToken = savedChubToken();
        debugLog('[ChubFollow] Following', followedUsernames.size, 'users:', [...followedUsernames]);
        return followedUsernames;
        
    } catch (e) {
        console.error('[ChubFollow] Error fetching follows:', e);
        return [];
    }
}

// Update the follow button based on whether we're already following this author
async function updateFollowAuthorButton(authorName) {
    const followBtn = document.getElementById('chubFollowAuthorBtn');
    if (!followBtn) return;
    
    if (!savedChubToken()) {
        followBtn.hidden = true;
        return;
    }
    
    followBtn.hidden = false;
    followBtn.disabled = true;
    followBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        const followsList = await fetchMyFollowsList();
        chubIsFollowingCurrentAuthor = followsList && followsList.has(authorName.toLowerCase());
        debugLog('[ChubFollow] Checking if following', authorName, ':', chubIsFollowingCurrentAuthor);
    } catch (e) {
        debugLog('[ChubFollow] Could not check follow status:', e);
        chubIsFollowingCurrentAuthor = false;
    }
    
    followBtn.disabled = false;
    if (chubIsFollowingCurrentAuthor) {
        followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
        followBtn.classList.add('following');
        followBtn.title = `Unfollow ${authorName} on ChubAI`;
    } else {
        followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
        followBtn.classList.remove('following');
        followBtn.title = `Follow ${authorName} on ChubAI`;
    }
}

// Follow/unfollow the currently viewed author
async function toggleFollowAuthor() {
    if (!chubAuthorFilter || !savedChubToken()) {
        showToast('Login required to follow authors', 'warning');
        return;
    }
    
    const followBtn = document.getElementById('chubFollowAuthorBtn');
    if (followBtn) {
        followBtn.disabled = true;
        followBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }
    
    try {
        // ChubAI follow API: POST to follow, DELETE to unfollow
        // Correct endpoint: /api/follow/{username}
        const method = chubIsFollowingCurrentAuthor ? 'DELETE' : 'POST';
        const headers = getChubHeaders(true);
        headers['Content-Type'] = 'application/json';
        
        const response = await fetch(`${CHUB_API_BASE}/api/follow/${chubAuthorFilter}`, {
            method: method,
            headers
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('[ChubFollow] Error:', response.status, errorText);
            throw new Error(`Failed: ${response.status}`);
        }
        
        const data = await response.json();
        debugLog('[ChubFollow] Response:', data);
        
        chubIsFollowingCurrentAuthor = !chubIsFollowingCurrentAuthor;
        
        if (chubMyFollowsList) {
            const authorLower = chubAuthorFilter.toLowerCase();
            if (chubIsFollowingCurrentAuthor) {
                chubMyFollowsList.add(authorLower);
            } else {
                chubMyFollowsList.delete(authorLower);
            }
        }
        
        if (chubIsFollowingCurrentAuthor) {
            showToast(`Following ${chubAuthorFilter}`, 'success');
            if (followBtn) {
                followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
                followBtn.classList.add('following');
            }
        } else {
            showToast(`Unfollowed ${chubAuthorFilter}`, 'info');
            if (followBtn) {
                followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
                followBtn.classList.remove('following');
            }
        }
        
        if (followBtn) followBtn.disabled = false;
        
    } catch (e) {
        console.error('[ChubFollow] Error:', e);
        showToast(`Failed: ${e.message}`, 'error');
        
        if (followBtn) {
            followBtn.disabled = false;
            if (chubIsFollowingCurrentAuthor) {
                followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
            } else {
                followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
            }
        }
    }
}

function clearAuthorFilter() {
    chubBrowseView.clearCreatorScope();
}

function performChubSearch() {
    const searchInput = document.getElementById('chubSearchInput');
    const term = searchInput?.value.trim() || '';
    // a new search leaves the creator scope; the typed term outranks the one restore puts back
    if (chubAuthorFilter) chubBrowseView.clearCreatorScope({ reload: false });
    chubCurrentSearch = term;
    if (searchInput) searchInput.value = term;
    document.getElementById('chubClearSearchBtn')?.classList.toggle('hidden', !term);
    chubBrowseView.reload();
}

// unscored cards (about two weeks old) fall out of min_ai_rating, so all-fresh sorts return nothing; author views keep it
function chubAiRatingSupported() {
    if (chubAuthorFilter) return true;
    const preset = CHUB_DISCOVERY_PRESETS[chubDiscoveryPreset] || CHUB_DISCOVERY_PRESETS['popular_week'];
    if (preset.sort === 'trending' || preset.sort === 'trending_downloads') return false;
    // Search mode drops special_mode and max_days_ago from the query, so those only block general browsing
    if (chubCurrentSearch) return true;
    return !preset.special_mode && !(preset.days > 0 && preset.days <= 14);
}

function updateChubAiRatingFieldState() {
    const input = document.getElementById('chubMinAiRating');
    if (!input) return;
    // the timeline greys the row too, and this runs after that greying, so the two never disagree
    const supported = chubViewMode !== 'timeline' && chubAiRatingSupported();
    input.disabled = !supported;
    input.closest('.browse-advanced-option')?.classList.toggle('browse-option-disabled', !supported);
}

async function loadChubCharacters(forceRefresh = false) {
    const thisToken = ++chubLoadToken;

    updateChubAiRatingFieldState();

    const grid = document.getElementById('chubGrid');

    // Special handling for favorites filter - use gateway API directly
    if (chubFeatureState.favorites && savedChubToken()) {
        await loadChubFavorites(forceRefresh, thisToken);
        return;
    }
    
    const loadMoreBtn = document.getElementById('chubLoadMoreBtn');

    if (chubCurrentPage === 1) {
        renderSkeletonGrid(grid);
    }
    
    chubIsLoading = true;

    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }
    
    try {
        // Build query parameters - ChubAI uses query params even with POST
        const params = new URLSearchParams();
        params.set('first', '48');
        const preset = CHUB_DISCOVERY_PRESETS[chubDiscoveryPreset] || CHUB_DISCOVERY_PRESETS['popular_week'];
        
        params.set('page', chubCurrentPage.toString());
        params.set('nsfw', chubNsfwEnabled.toString());
        params.set('nsfl', chubNsfwEnabled.toString()); // NSFL follows NSFW setting
        params.set('include_forks', chubFeatureState.excludeForks ? 'false' : 'true'); // Exclude Forks toggle
        params.set('venus', 'false');
        
        if (chubCurrentSearch) {
            params.set('search', chubCurrentSearch);
        }
        
        // Author filter - use 'username' parameter
        if (chubAuthorFilter) {
            params.set('username', chubAuthorFilter);
            params.set('sort', chubAuthorSort);
            // Don't apply time period filter when viewing an author's profile
            // We want to see all their characters, not just recent ones
        } else if (chubCurrentSearch) {
            // When searching, drop time period and special_mode so older
            // characters aren't excluded. Keep the preset sort unless it's
            // 'default' (which triggers server-side relevance).
            if (preset.sort !== 'default') {
                params.set('sort', preset.sort);
            }
        } else {
            if (preset.sort !== 'default') {
                params.set('sort', preset.sort);
            }
            // Add special_mode filter if preset has one (e.g., newcomer for recent hits)
            if (preset.special_mode) {
                params.set('special_mode', preset.special_mode);
            }
            // Add time period filter from preset (max_days_ago) only for general browsing
            if (preset.days > 0) {
                params.set('max_days_ago', preset.days.toString());
            }
        }
        
        applyFeatureParams(params, CHUB_FEATURE_FILTERS, chubFeatureState);

        // Advanced Tag Filters
        // Include tags (topics)
        const includeTags = [];
        const excludeTags = [];
        for (const [tag, state] of chubTagFilters) {
            if (state === 'include') includeTags.push(tag);
            else if (state === 'exclude') excludeTags.push(tag);
        }
        // Merge persistent exclude tags from settings
        for (const t of view.persistentExcludeTags()) {
            if (!excludeTags.includes(t)) excludeTags.push(t);
        }
        if (includeTags.length > 0) {
            params.set('topics', includeTags.join(','));
        }
        if (excludeTags.length > 0) {
            params.set('excludetopics', excludeTags.join(','));
        }
        
        // Sort direction
        if (chubSortAscending) {
            params.set('asc', 'true');
        }
        
        // Token limits (only set if different from defaults)
        if (chubMinTokens !== 50) {
            params.set('min_tokens', chubMinTokens.toString());
        } else {
            params.set('min_tokens', '50');
        }
        if (chubMaxTokens !== 100000) {
            params.set('max_tokens', chubMaxTokens.toString());
        }
        if (chubMinAiRating > 0) {
            if (chubAiRatingSupported()) {
                params.set('min_ai_rating', chubMinAiRating.toString());
            } else if (!chubAiRatingSortWarned) {
                chubAiRatingSortWarned = true;
                showToast('Min AI Score is ignored for the Trending, Hot This Week, Top Rated (Week), and Recent Hits sorts (ChubAI limitation)', 'info');
            }
        }

        debugLog('[ChubAI] Search params:', params.toString());
        
        const headers = getChubHeaders(true);
        
        const response = await fetch(`${CHUB_API_BASE}/search?${params.toString()}`, {
            method: 'GET',
            headers
        });
        
        const data = await readJsonClassified(response);

        if (thisToken !== chubLoadToken) return;
        if (!chubDelegatesInitialized) return;
        
        // Handle different response formats
        let nodes = [];
        if (data.nodes) {
            nodes = data.nodes;
        } else if (data.data?.nodes) {
            nodes = data.data.nodes;
        } else if (Array.isArray(data.data)) {
            nodes = data.data;
        } else if (Array.isArray(data)) {
            nodes = data;
        }
        
        await chubBrowseView.probeHits(nodes);
        if (chubCurrentPage === 1) {
            chubCharacters = nodes;
            extractChubTagsFromResults(nodes);
        } else {
            const existingPaths = new Set(chubCharacters.map(c => getChubFullPath(c)).filter(Boolean));
            for (const node of nodes) {
                const fp = getChubFullPath(node);
                if (!fp || !existingPaths.has(fp)) {
                    chubCharacters.push(node);
                    if (fp) existingPaths.add(fp);
                }
            }
        }
        
        chubHasMore = (data.data?.cursor ?? data.cursor) != null && nodes.length > 0;
        const wasAppend = chubCurrentPage > 1;
        
        // excludes thin the grid, so fetch up to 3 more pages toward 24 visible cards per action
        const activeExcludes = activeFeatureExcludes(CHUB_FEATURE_FILTERS, chubFeatureState);
        if (activeExcludes.length > 0 && chubHasMore) {
            const isFiltered = (c) => activeExcludes.some(f => f.exclude(c));
            let visibleNew = nodes.filter(c => !isFiltered(c)).length;
            let autoFetches = 0;
            const existingPaths = new Set(chubCharacters.map(c => getChubFullPath(c)).filter(Boolean));
            
            while (visibleNew < 48 && chubHasMore && autoFetches < 3 && chubDelegatesInitialized) {
                autoFetches++;
                chubCurrentPage++;
                params.set('page', chubCurrentPage.toString());
                
                const moreRes = await fetch(`${CHUB_API_BASE}/search?${params.toString()}`, {
                    method: 'GET',
                    headers
                });
                if (!moreRes.ok) break;
                
                const moreData = await moreRes.json();
                if (thisToken !== chubLoadToken) return;
                let moreNodes = [];
                if (moreData.nodes) moreNodes = moreData.nodes;
                else if (moreData.data?.nodes) moreNodes = moreData.data.nodes;
                else if (Array.isArray(moreData.data)) moreNodes = moreData.data;
                else if (Array.isArray(moreData)) moreNodes = moreData;
                await chubBrowseView.probeHits(moreNodes);
                
                for (const node of moreNodes) {
                    const fp = getChubFullPath(node);
                    if (!fp || !existingPaths.has(fp)) {
                        chubCharacters.push(node);
                        if (fp) existingPaths.add(fp);
                    }
                }
                chubHasMore = (moreData.data?.cursor ?? moreData.cursor) != null && moreNodes.length > 0;
                visibleNew += moreNodes.filter(c => !isFiltered(c)).length;
            }
            
            if (autoFetches > 0) {
                debugLog(`[ChubAI] Auto-fetched ${autoFetches} extra page(s) to compensate for client-side filters (${visibleNew} visible)`);
            }
        }
        
        renderChubGrid(wasAppend);
        
        chubBrowseView.updateLoadMoreVisibility('chubLoadMore', chubHasMore, chubCharacters.length > 0);
        
    } catch (e) {
        if (thisToken !== chubLoadToken) return;
        console.error('ChubAI load error:', e);
        if (chubCurrentPage === 1) {
            renderBrowseError(grid, {
                provider: 'chub',
                error: e,
                title: 'Failed to load ChubAI',
                flags: { token: !!savedChubToken(), nsfw: chubNsfwEnabled },
                retry: () => loadChubCharacters(true),
            });
        } else {
            showToast('Failed to load more: ' + e.message, 'error');
        }
    } finally {
        if (thisToken === chubLoadToken) {
            chubIsLoading = false;
            if (loadMoreBtn) {
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
            }
        }
    }
}

/**
 * Fetch and cache user's favorite character IDs
 * Used for filtering in timeline view
 */
async function fetchChubUserFavoriteIds({ maxAgeMs = 0 } = {}) {
    if (!savedChubToken()) {
        chubUserFavoriteIds = new Set();
        chubFavoriteIdsFetchedAt = 0;
        return;
    }
    // No-arg callers (the timeline filter paths) keep refetch-always freshness; only opted-in
    // readers accept an aged Set.
    if (maxAgeMs > 0 && chubFavoriteIdsFetchedAt && (Date.now() - chubFavoriteIdsFetchedAt) < maxAgeMs) return;

    try {
        const url = `${CHUB_GATEWAY_BASE}/api/favorites?first=500`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'samwise': savedChubToken(),
                'CH-API-KEY': savedChubToken()
            }
        });

        if (response.ok) {
            const data = await response.json();
            const nodes = data.nodes || data.data || [];
            chubUserFavoriteIds = new Set(nodes.map(n => n.id || n.project_id).filter(Boolean));
            chubFavoriteIdsFetchedAt = Date.now();
            debugLog('[ChubAI] Cached', chubUserFavoriteIds.size, 'favorite IDs');
        }
    } catch (e) {
        debugLog('[ChubAI] Failed to fetch favorite IDs:', e.message);
    }
}

/**
 * Load user's favorites from ChubAI gateway API
 * This uses a different endpoint than the search API
 */
async function loadChubFavorites(forceRefresh = false, loadToken = 0) {
    const grid = document.getElementById('chubGrid');

    if (chubCurrentPage === 1) {
        renderSkeletonGrid(grid);
    }
    
    chubIsLoading = true;
    
    try {
        const params = new URLSearchParams();
        params.set('first', '100'); // Get more items per page from favorites
        
        if (chubCurrentPage > 1) {
            params.set('page', chubCurrentPage.toString());
        }
        
        const url = `${CHUB_GATEWAY_BASE}/api/favorites?${params.toString()}`;
        debugLog('[ChubAI] Loading favorites from:', url);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'samwise': savedChubToken(),
                'CH-API-KEY': savedChubToken()
            }
        });
        
        const data = await readJsonClassified(response);
        debugLog('[ChubAI] Favorites response:', data);
        
        if (loadToken && loadToken !== chubLoadToken) return;
        
        let nodes = data.nodes || data.data || [];
        await chubBrowseView.probeHits(nodes);
        
        const favActiveRows = activeFeatureRows(CHUB_FEATURE_FILTERS, chubFeatureState);
        if (favActiveRows.length > 0) {
            nodes = nodes.filter(c => featurePasses(c, favActiveRows));
        }
        
        if (!chubNsfwEnabled) {
            nodes = nodes.filter(c => !c.nsfw);
        }
        
        // Apply tag filters + persistent excludes client-side (favorites API doesn't support topics param)
        const includeTags = [];
        const excludeTags = [];
        for (const [tag, state] of chubTagFilters) {
            if (state === 'include') includeTags.push(tag.toLowerCase());
            else if (state === 'exclude') excludeTags.push(tag.toLowerCase());
        }
        for (const t of view.persistentExcludeTags()) {
            const lt = t.toLowerCase();
            if (!excludeTags.includes(lt)) excludeTags.push(lt);
        }
        if (includeTags.length > 0 || excludeTags.length > 0) {
            nodes = nodes.filter(c => {
                const charTopics = (c.topics || []).map(t => t.toLowerCase());
                if (includeTags.length > 0 && !includeTags.every(t => charTopics.includes(t))) return false;
                if (excludeTags.length > 0 && excludeTags.some(t => charTopics.includes(t))) return false;
                return true;
            });
        }
        
        if (chubCurrentSearch) {
            const search = chubCurrentSearch.toLowerCase();
            nodes = nodes.filter(c => {
                const name = (c.name || '').toLowerCase();
                const creator = (c.fullPath?.split('/')[0] || '').toLowerCase();
                const tagline = (c.tagline || '').toLowerCase();
                return name.includes(search) || creator.includes(search) || tagline.includes(search);
            });
        }
        
        if (chubCurrentPage === 1) {
            chubCharacters = nodes;
        } else {
            const existingPaths = new Set(chubCharacters.map(c => (c.fullPath || c.full_path || '').toLowerCase()));
            for (const node of nodes) {
                const fp = (node.fullPath || node.full_path || '').toLowerCase();
                if (!fp || !existingPaths.has(fp)) chubCharacters.push(node);
            }
        }
        
        chubHasMore = data.cursor !== null && nodes.length > 0;
        
        renderChubGrid(chubCurrentPage > 1);
        
        chubBrowseView.updateLoadMoreVisibility('chubLoadMore', chubHasMore, chubCharacters.length > 0);
        
    } catch (e) {
        if (loadToken && loadToken !== chubLoadToken) return;
        console.error('[ChubAI] Favorites load error:', e);
        if (chubCurrentPage === 1) {
            renderBrowseError(grid, {
                provider: 'chub',
                error: e,
                title: 'Failed to load favorites',
                view: 'favorites',
                flags: { token: !!savedChubToken() },
                retry: () => chubBrowseView.reload({ force: true }),
            });
        } else {
            showToast('Failed to load more: ' + e.message, 'error');
        }
    } finally {
        if (!loadToken || loadToken === chubLoadToken) {
            chubIsLoading = false;
        }
    }
}

function renderChubGrid(appendOnly = false) {
    const grid = document.getElementById('chubGrid');
    
    // Apply client-side "hide owned" / "hide possible" filters (other filters are server-side)
    let displayCharacters = chubCharacters;
    const activeExcludes = activeFeatureExcludes(CHUB_FEATURE_FILTERS, chubFeatureState);
    for (const f of activeExcludes) {
        displayCharacters = displayCharacters.filter(c => !f.exclude(c));
    }
    
    if (displayCharacters.length === 0) {
        chubGridRenderedCount = 0;
        chubCardLookup.clear();
        chubBrowseView.disconnectImageObserver();
        const message = chubCharacters.length > 0 && activeExcludes.length > 0
            ? 'All characters in this view are already in your library.'
            : 'Try a different search term or adjust your filters.';
        grid.innerHTML = `
            <div class="browse-empty">
                <i class="fa-solid fa-search"></i>
                <h3>No Characters Found</h3>
                <p>${message}</p>
            </div>
        `;
        return;
    }

    buildChubLookup(chubCardLookup, displayCharacters);

    // A page whose characters all got client-filtered adds nothing visible; without this guard
    // the else branch innerHTML-rebuilt the whole grid, teardown-flashing every loaded thumbnail.
    if (appendOnly && chubGridRenderedCount === displayCharacters.length) return;

    if (appendOnly && chubGridRenderedCount > 0 && chubGridRenderedCount < displayCharacters.length) {
        const newChars = displayCharacters.slice(chubGridRenderedCount);
        if (newChars.length > 0) {
            grid.insertAdjacentHTML('beforeend', newChars.map(char => createChubCard(char)).join(''));
        }
    } else {
        // Full re-render: disconnect all tracked images before replacing DOM
        chubBrowseView.disconnectImageObserver();
        grid.innerHTML = displayCharacters.map(char => createChubCard(char)).join('');
    }

    chubGridRenderedCount = displayCharacters.length;
    chubBrowseView.observeImages(grid);
}

function setupChubGridDelegates() {
    if (chubDelegatesInitialized) return;

    const grid = document.getElementById('chubGrid');
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
            const fullPath = card.dataset.fullPath;
            const char = chubCardLookup.get(fullPath) || chubCharacters.find(c => getChubFullPath(c) === fullPath);
            if (char) openChubCharPreview(char);
        });
    }

    const timelineGrid = document.getElementById('chubTimelineGrid');
    if (timelineGrid) {
        timelineGrid.addEventListener('click', _handleTimelineCardClick);
    }

    chubDelegatesInitialized = true;
}

function createChubCard(char) {
    const name = char.name || 'Unknown';
    const fullPath = getChubFullPath(char);
    const creatorName = fullPath.split('/')[0] || 'Unknown';
    const rating = char.rating ? char.rating.toFixed(1) : '0.0';
    const ratingCount = char.ratingCount || 0;
    // ChubAI's weird naming: starCount is actually downloads, n_favorites is the heart/favorite count
    const downloads = formatNumber(char.starCount || 0);
    const favorites = formatNumber(char.n_favorites || char.nFavorites || 0);
    const avatarUrl = char.avatar_url || (fullPath ? `https://avatars.charhub.io/avatars/${fullPath}/avatar.webp` : '/img/no-portrait.png');

    const inLibrary = view.isHitInLibrary(char);
    const possibleTier = inLibrary ? null : view.possibleMatchTierFor(char);

    const tags = (char.topics || []);
    
    const badges = [];
    const importing = view.importingBadge(char);
    if (importing) badges.push(importing);
    const libraryBadge = libraryBadgeHtml(inLibrary, possibleTier);
    if (libraryBadge) badges.push(libraryBadge);
    badges.push(...featureBadgesHtml(char, CHUB_FEATURE_FILTERS));
    if (char.recommended || char.verified) {
        badges.push('<span class="browse-feature-badge verified" title="Verified"><i class="fa-solid fa-check-circle"></i></span>');
    }
    
    const createdDate = char.createdAt ? new Date(char.createdAt).toLocaleDateString() : '';
    const dateInfo = createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';
    
    const cardClass = libraryCardClass(inLibrary, possibleTier);
    
    // Tagline for hover tooltip (escape for HTML attribute)
    const taglineTooltip = char.tagline ? escapeHtml(char.tagline) : '';
    
    return `
        <div class="${cardClass}" data-full-path="${escapeHtml(fullPath)}"${view.linkKeyAttr(char)}${view.matchAttr(char)} ${taglineTooltip ? `title="${taglineTooltip}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/no-portrait.png'">
                ${char.nsfw ? '<span class="browse-nsfw-badge">NSFW</span>' : ''}
                ${badges.length > 0 ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                <span class="browse-card-creator-link" data-author="${escapeHtml(creatorName)}" title="Click to see all characters by ${escapeHtml(creatorName)}">${escapeHtml(creatorName)}</span>
                ${cardTagsHtml(tags)}
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="${ratingCount} rating${ratingCount !== 1 ? 's' : ''}"><i class="fa-solid fa-star"></i> ${rating}</span>
                <span class="browse-card-stat" title="Downloads"><i class="fa-solid fa-download"></i> ${downloads}</span>
                <span class="browse-card-stat" title="Favorites"><i class="fa-solid fa-heart"></i> ${favorites}</span>
                ${dateInfo}
            </div>
        </div>
    `;
}


function abortChubDetailFetch() {
    if (chubDetailFetchController) {
        chubDetailFetchController.abort();
        chubDetailFetchController = null;
    }
}

// Canonical close path. Match sibling-provider closePreviewModal shape so the
// back-button / Escape registerOverlay close goes through the same cleanup.
function closeChubCharPreview() {
    abortChubDetailFetch();
    cleanupChubCharModal();
    hideModal('chubCharModal');
    view.trackPreview(null);
}

async function openChubCharPreview(char) {
    // Abort any in-flight detail fetch from a previous preview
    abortChubDetailFetch();
    chubSelectedChar = char;
    
    const modal = document.getElementById('chubCharModal');
    CoreAPI.resetBrowseSectionCollapseState(modal);
    const avatarImg = document.getElementById('chubCharAvatar');
    const nameEl = document.getElementById('chubCharName');
    const creatorLink = document.getElementById('chubCharCreator');
    const ratingEl = document.getElementById('chubCharRating');
    const downloadsEl = document.getElementById('chubCharDownloads');
    const tagsEl = document.getElementById('chubCharTags');
    const tokensEl = document.getElementById('chubCharTokens');
    const dateEl = document.getElementById('chubCharDate');
    const descEl = document.getElementById('chubCharDescription');
    const taglineSection = document.getElementById('chubCharTaglineSection');
    const taglineEl = document.getElementById('chubCharTagline');
    const openInBrowserBtn = document.getElementById('chubOpenInBrowserBtn');
    
    // Creator's Notes (public ChubAI description). Hidden when empty, like every other section here.
    const creatorNotesSection = document.getElementById('chubCharCreatorNotesSection');
    const creatorNotesEl = document.getElementById('chubCharCreatorNotes');
    const setChubCreatorNotes = (raw) => {
        const notes = (raw || '').trim();
        if (notes) {
            if (creatorNotesSection) creatorNotesSection.hidden = false;
            if (creatorNotesEl && !creatorNotesEl.querySelector('iframe')) creatorNotesEl.innerHTML = skeletonLines(3);
            deferCall(creatorNotesEl, () => renderCreatorNotesSecure(notes, char.name, creatorNotesEl));
        } else {
            if (creatorNotesSection) creatorNotesSection.hidden = true;
            cleanupCreatorNotesContainer(creatorNotesEl);
            if (creatorNotesEl) creatorNotesEl.innerHTML = '';
        }
    };

    // Definition sections (from detailed fetch)
    const greetingsStat = document.getElementById('chubCharGreetingsStat');
    const greetingsCount = document.getElementById('chubCharGreetingsCount');
    const lorebookStat = document.getElementById('chubCharLorebookStat');
    const descSection = document.getElementById('chubCharDescriptionSection');
    const personalitySection = document.getElementById('chubCharPersonalitySection');
    const scenarioSection = document.getElementById('chubCharScenarioSection');
    const scenarioEl = document.getElementById('chubCharScenario');
    const firstMsgSection = document.getElementById('chubCharFirstMsgSection');
    const firstMsgEl = document.getElementById('chubCharFirstMsg');
    const examplesSection = document.getElementById('chubCharExamplesSection');
    const examplesEl = document.getElementById('chubCharExamples');

    const galleryStat = document.getElementById('chubCharGalleryStat');
    const galleryCountEl = document.getElementById('chubCharGalleryCount');
    const gallerySection = document.getElementById('chubCharGallerySection');
    const galleryGrid = document.getElementById('chubCharGalleryGrid');
    const galleryLabel = document.getElementById('chubCharGalleryLabel');
    
    const fullPath = getChubFullPath(char);
    const avatarUrl = char.avatar_url || (fullPath ? `https://avatars.charhub.io/avatars/${fullPath}/avatar.webp` : '/img/no-portrait.png');
    const creatorName = fullPath.split('/')[0] || 'Unknown';
    
    BrowseView.setPreviewPortrait(avatarImg, avatarUrl);
    nameEl.textContent = char.name || 'Unknown';
    creatorLink.textContent = creatorName;
    creatorLink.href = '#'; // In-app filter action
    creatorLink.title = `Click to see all characters by ${creatorName}`;
    creatorLink.onclick = (e) => {
        e.preventDefault();
        modal.classList.add('hidden');
        filterByAuthor(creatorName);
    };
    // External link to author's ChubAI profile
    const creatorExternal = document.getElementById('chubCreatorExternal');
    if (creatorExternal) {
        creatorExternal.href = `https://chub.ai/users/${creatorName}`;
    }
    openInBrowserBtn.href = `https://chub.ai/characters/${fullPath}`;
    const ratingCount = char.ratingCount || 0;
    ratingEl.innerHTML = `<i class="fa-solid fa-star"></i> ${char.rating ? char.rating.toFixed(1) : '0.0'}`;
    ratingEl.title = `${ratingCount} rating${ratingCount !== 1 ? 's' : ''}`;
    // ChubAI's weird naming: starCount is actually downloads, n_favorites is the heart/favorite count
    const downloadCount = char.starCount || 0;
    const favoritesCount = char.n_favorites || char.nFavorites || 0;
    downloadsEl.innerHTML = `<i class="fa-solid fa-download"></i> ${formatNumber(downloadCount)}`;
    downloadsEl.title = 'Downloads';
    
    // Tags
    const tags = char.topics || [];
    tagsEl.innerHTML = tags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
    requestAnimationFrame(() => applyTagsClamp(tagsEl));
    
    // Stats
    tokensEl.textContent = formatNumber(char.nTokens || 0);
    dateEl.textContent = char.createdAt ? new Date(char.createdAt).toLocaleDateString() : 'Unknown';
    
    // n_favorites is the actual favorite count
    const favoriteCountEl = document.getElementById('chubCharFavoriteCount');
    favoriteCountEl.textContent = formatNumber(favoritesCount);
    
    updateChubFavoriteButton(char);

    // skeleton only when notes are likely, else start hidden so an empty card doesnt flash one
    if (creatorNotesSection && creatorNotesEl) {
        cleanupCreatorNotesContainer(creatorNotesEl);
        if ((char.description || char.tagline || '').trim()) {
            creatorNotesSection.hidden = false;
            creatorNotesEl.innerHTML = skeletonLines(3);
        } else {
            creatorNotesSection.hidden = true;
            creatorNotesEl.innerHTML = '';
        }
    }
    
    // Tagline
    if (char.tagline && char.tagline !== char.description) {
        taglineSection.hidden = false;
        taglineEl.innerHTML = sanitizeTaglineHtml(char.tagline, char.name);
    } else {
        taglineSection.hidden = true;
    }
    
    // the greetings the node carries; a search node counts ones only the detail brings
    renderAltGreetingsList('chub', char.alternate_greetings || [], char.name);
    const numGreetings = char.n_greetings || (char.alternate_greetings?.length ? char.alternate_greetings.length + 1 : 1);
    if (numGreetings > 1) {
        greetingsStat.hidden = false;
        greetingsCount.textContent = numGreetings;
    }
    
    // search nodes carry no lore fields (timeline nodes can); the detail fetch upgrades this
    lorebookStat.title = '';
    if (char.has_lore || char.related_lorebooks?.length > 0) {
        lorebookStat.hidden = false;
    } else {
        lorebookStat.hidden = true;
    }

    // Gallery stat - hidden until detail data loads with actual count
    if (galleryStat) galleryStat.hidden = true;
    
    // defLoading kept around for the fetch-failure message path below; skeletons are the loading indicator otherwise.
    const defLoading = document.getElementById('chubCharDefinitionLoading');
    if (defLoading) defLoading.hidden = true;
    descSection.hidden = false; descEl.innerHTML = skeletonLines(3);
    personalitySection.hidden = true;
    scenarioSection.hidden = false; scenarioEl.innerHTML = skeletonLines(2);
    examplesSection.hidden = false; examplesEl.innerHTML = skeletonLines(3);
    firstMsgSection.hidden = false; firstMsgEl.innerHTML = skeletonLines(4);
    if (gallerySection) gallerySection.hidden = true;
    if (galleryGrid) galleryGrid.innerHTML = '';
    
    // Import button state, kept in step with the library while the preview is open
    const restampImport = () => view.stampPreviewImport(document.getElementById('chubDownloadBtn'), char);
    restampImport();
    view.trackPreview(restampImport, char);
    
    modal.classList.remove('hidden');
    const charBody = modal.querySelector('.browse-char-body');
    if (charBody) charBody.scrollTop = 0;

    const applyDetailData = (node) => {
        if (!node) return;
        const def = node.definition || {};

        if (defLoading) defLoading.hidden = true;

        setChubCreatorNotes(node.description || char.description || char.tagline);

        // Search caps topics at 15; the full-metadata detail has them all, so upgrade the tag list.
        if (tagsEl && node.topics?.length) {
            tagsEl.innerHTML = node.topics.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
            requestAnimationFrame(() => applyTagsClamp(tagsEl));
        }

        // ChubAI quirk: def.personality is the main character definition, not a personality field.
        const firstMsg = def.first_message || def.first_mes;

        // RAF defer so safePurify doesnt block the modal-open paint frame.
        requestAnimationFrame(() => {
            if (def.personality) {
                descSection.hidden = false;
                deferCall(descEl, () => renderCardHtmlSecure(def.personality, char.name, descEl));
                descEl.dataset.fullContent = def.personality;
            } else if (descSection) {
                descSection.hidden = true;
            }

            if (def.scenario) {
                scenarioSection.hidden = false;
                deferRender(scenarioEl, () => safePurify(formatRichText(def.scenario, char.name, true), BROWSE_PURIFY_CONFIG));
                scenarioEl.dataset.fullContent = def.scenario;
            } else if (scenarioSection) {
                scenarioSection.hidden = true;
            }

            if (def.mes_example) {
                examplesSection.hidden = false;
                deferRender(examplesEl, () => safePurify(formatRichText(def.mes_example, char.name, true), BROWSE_PURIFY_CONFIG));
                examplesEl.dataset.fullContent = def.mes_example;
            } else if (examplesSection) {
                examplesSection.hidden = true;
            }

            if (firstMsg) {
                firstMsgSection.hidden = false;
                deferRender(firstMsgEl, () => safePurify(formatRichText(firstMsg, char.name, true), BROWSE_PURIFY_CONFIG));
                firstMsgEl.dataset.fullContent = firstMsg;
            } else if (firstMsgSection) {
                firstMsgSection.hidden = true;
            }
        });

        // lore scalars precomputed at the strip, the book never cached; the kind lives in the tooltip
        if (node.hasLinkedLorebook || node.hasWorldRef) {
            lorebookStat.hidden = false;
            lorebookStat.title = node.hasLinkedLorebook ? 'Linked lorebook' : 'Embedded lorebook';
        }

        if (def.alternate_greetings) renderAltGreetingsList('chub', def.alternate_greetings, char.name);

        // Gallery
        if (node.galleryImages?.length > 0) {
            const count = node.galleryImages.length;
            if (galleryStat) {
                galleryStat.hidden = false;
                if (galleryCountEl) galleryCountEl.textContent = count;
            }
            if (gallerySection && galleryGrid) {
                gallerySection.hidden = false;
                if (galleryLabel) galleryLabel.textContent = `(${count})`;
                galleryGrid.innerHTML = node.galleryImages.map(img =>
                    `<div class="browse-gallery-cell"><img class="browse-gallery-thumb" src="${escapeHtml(img.url)}" alt="Gallery image" title="Gallery image" loading="lazy" onload="this.parentElement.classList.add('loaded')" onerror="this.parentElement.classList.add('load-failed')"></div>`
                ).join('');
            }
        } else if (node.hasGallery && gallerySection && galleryGrid) {
            if (galleryStat) galleryStat.hidden = false;
            if (galleryCountEl) galleryCountEl.textContent = '';
            gallerySection.hidden = false;
            if (galleryLabel) galleryLabel.textContent = '';
            galleryGrid.innerHTML = node.galleryAuthRequired
                ? '<div class="browse-gallery-auth"><i class="fa-solid fa-lock"></i> Gallery requires login to view</div>'
                : '<div class="browse-gallery-auth"><i class="fa-solid fa-images"></i> Gallery could not be loaded</div>';
        }
    };

    const cachedDetail = fullPath ? chubDetailCache.get(fullPath) : null;
    if (cachedDetail) {
        // LRU refresh: move to end of Map insertion order
        chubDetailCache.delete(fullPath);
        chubDetailCache.set(fullPath, cachedDetail);
        applyDetailData(cachedDetail);
    }

    if (!cachedDetail && !fullPath) {
        // No fetch path: resolve from the slim data.
        setChubCreatorNotes(char.description || char.tagline);
    }

    if (!cachedDetail && fullPath) {
        chubDetailFetchController = new AbortController();
        const fetchSignal = chubDetailFetchController.signal;
        try {
            const detailUrl = `https://api.chub.ai/api/characters/${fullPath}?full=true`;

            // Gateway only allow-origins https://chub.ai so direct CORS-rejects; inline /proxy/ fallback keeps the Response for the 401/403 auth-required hint.
            const galleryHeaders = { 'Accept': 'application/json' };
            if (savedChubToken()) {
                galleryHeaders['samwise'] = savedChubToken();
                galleryHeaders['CH-API-KEY'] = savedChubToken();
            }
            const charProjectId = char.id || char.project_id;
            const fetchGallery = async (url) => {
                try { return await fetch(url, { headers: galleryHeaders, signal: fetchSignal }); }
                catch (e) {
                    if (e.name === 'AbortError') throw e;
                    return await fetch(proxiedUrl(url), { headers: galleryHeaders, signal: fetchSignal });
                }
            };
            // search hasGallery lies (false where the detail says true), so always probe by project id
            const galleryPromise = charProjectId
                ? fetchGallery(`${CHUB_GATEWAY_BASE}/api/gallery/project/${charProjectId}?limit=100&count=false`)
                    .then(r => {
                        if (r.ok) return r.json();
                        if (r.status === 401 || r.status === 403) return { nodes: [], _authRequired: true };
                        return { nodes: [] };
                    })
                    .then(data => {
                        const images = (data.nodes || []).map(n => ({ url: n.primary_image_path, id: n.uuid, nsfw: n.nsfw_image || false }));
                        if (data._authRequired) images._authRequired = true;
                        return images;
                    })
                    .catch(err => { debugLog('[ChubAI] Gallery fetch failed:', err.message); return []; })
                : Promise.resolve([]);

            const [response, galleryImages] = await Promise.all([
                fetch(detailUrl, { signal: fetchSignal }),
                galleryPromise,
            ]);

            if (response.ok) {
                const detailData = await response.json();
                // If modal was closed or a different character was opened while 
                // we were fetching, discard the result to avoid stale rendering
                if (fetchSignal.aborted || chubSelectedChar !== char) {
                    debugLog('[ChubAI] Detail fetch completed but modal moved on; discarding');
                } else {
                    const node = detailData.node || detailData;
                    // Strip heavy data we never display - character_book (lorebook) can be
                    // 100KB-1MB by itself, mes_example and extensions add more.
                    // Only keep fields actually used in applyDetailData.
                    const stripped = {
                        description: node.description,
                        topics: node.topics,
                        definition: node.definition ? {
                            personality: node.definition.personality,
                            scenario: node.definition.scenario,
                            mes_example: node.definition.mes_example,
                            first_message: node.definition.first_message,
                            first_mes: node.definition.first_mes,
                            alternate_greetings: node.definition.alternate_greetings,
                        } : undefined,
                        // linked books arrive inlined (related_lorebooks is a sentinel); file-embedded ones only hint via a world ref
                        hasLinkedLorebook: !!(node.definition?.embedded_lorebook || node.related_lorebooks?.length > 0),
                        hasWorldRef: !!node.definition?.extensions?.world,
                        galleryImages: galleryImages?.length > 0 ? galleryImages : undefined,
                        galleryAuthRequired: !!(galleryImages?._authRequired && !galleryImages.length),
                        hasGallery: char.hasGallery || node.hasGallery || false,
                    };
                    // Enforce LRU cap - evict oldest entries
                    while (chubDetailCache.size >= CHUB_DETAIL_CACHE_MAX) {
                        const oldestKey = chubDetailCache.keys().next().value;
                        chubDetailCache.delete(oldestKey);
                    }
                    chubDetailCache.set(fullPath, stripped);
                    applyDetailData(stripped);
                }
            }
        } catch (e) {
            if (e.name === 'AbortError') {
                debugLog('[ChubAI] Detail fetch aborted (modal closed)');
            } else {
                debugLog('[ChubAI] Could not fetch detailed character info:', e.message);
                if (chubSelectedChar === char) {
                    // Fall back to search-result description so the creator-notes skeleton doesnt sit forever.
                    setChubCreatorNotes(char.description || char.tagline);
                    // No def data arriving: collapse skeletons.
                    descSection.hidden = true;
                    scenarioSection.hidden = true;
                    examplesSection.hidden = true;
                    firstMsgSection.hidden = true;
                    if (defLoading) {
                        defLoading.innerHTML = definitionFailedNotice('It can still be imported with basic info.');
                        defLoading.hidden = false;
                    }
                }
            }
        }
    }
}

/**
 * Update the favorite button state for ChubAI character
 */
async function updateChubFavoriteButton(char) {
    const favoriteBtn = document.getElementById('chubCharFavoriteBtn');
    if (!favoriteBtn) return;
    
    favoriteBtn.classList.remove('favorited', 'loading');
    favoriteBtn.querySelector('i').className = 'fa-regular fa-heart';
    
    // If no token, show but disable with tooltip
    if (!savedChubToken()) {
        favoriteBtn.title = 'Login to ChubAI to add favorites';
        return;
    }
    
    favoriteBtn.title = 'Add to favorites on ChubAI';
    
    // If we already know the favorited state (from previous check or toggle), use it
    if (char._isFavorited === true) {
        favoriteBtn.classList.add('favorited');
        favoriteBtn.querySelector('i').className = 'fa-solid fa-heart';
        favoriteBtn.title = 'Remove from favorites on ChubAI';
        return;
    } else if (char._isFavorited === false) {
        // Already checked and not favorited
        return;
    }
    
    try {
        const charId = char.id || char.project_id;
        if (!charId) {
            debugLog('[ChubAI] Cannot check favorite status: no character id');
            return;
        }

        favoriteBtn.classList.add('loading');
        // Membership rides the session favorites Set; distinct-card opens within the window
        // cost nothing instead of one 500-row fetch each.
        await fetchChubUserFavoriteIds({ maxAgeMs: 5 * 60_000 });
        favoriteBtn.classList.remove('loading');

        const isFavorited = chubUserFavoriteIds.has(charId)
            || chubUserFavoriteIds.has(String(charId))
            || chubUserFavoriteIds.has(Number(charId));

        // Store state on character for persistence
        char._isFavorited = isFavorited;

        if (isFavorited) {
            favoriteBtn.classList.add('favorited');
            favoriteBtn.querySelector('i').className = 'fa-solid fa-heart';
            favoriteBtn.title = 'Remove from favorites on ChubAI';
        }
    } catch (e) {
        favoriteBtn.classList.remove('loading');
        debugLog('[ChubAI] Could not check favorite status:', e.message);
    }
}

/**
 * Toggle favorite for the currently selected ChubAI character
 */
async function toggleChubCharFavorite() {
    if (!chubSelectedChar || !savedChubToken()) {
        if (!savedChubToken()) {
            showToast('Login to ChubAI to add favorites', 'info');
            openChubTokenModal();
        }
        return;
    }
    
    const favoriteBtn = document.getElementById('chubCharFavoriteBtn');
    const favoriteCountEl = document.getElementById('chubCharFavoriteCount');
    if (!favoriteBtn) return;
    
    // ChubAI favorites API uses numeric project id at gateway.chub.ai
    const charId = chubSelectedChar.id || chubSelectedChar.project_id;
    if (!charId) {
        showToast('Cannot favorite this character - missing ID', 'error');
        return;
    }
    
    const isCurrentlyFavorited = favoriteBtn.classList.contains('favorited');
    
    favoriteBtn.classList.add('loading');
    
    try {
        const url = `${CHUB_GATEWAY_BASE}/api/favorites/${charId}`;
        debugLog('[ChubAI] Toggle favorite:', isCurrentlyFavorited ? 'DELETE' : 'POST', url);
        
        const response = await fetch(url, {
            method: isCurrentlyFavorited ? 'DELETE' : 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'samwise': savedChubToken(),
                'CH-API-KEY': savedChubToken()
            },
            body: '{}'  // ChubAI expects empty JSON body
        });
        
        favoriteBtn.classList.remove('loading');
        
        debugLog('[ChubAI] Favorite toggle response:', response.status, response.statusText);
        
        if (response.ok) {
            const responseData = await response.json().catch(() => ({}));
            debugLog('[ChubAI] Favorite toggle success data:', responseData);
            
            if (isCurrentlyFavorited) {
                favoriteBtn.classList.remove('favorited');
                favoriteBtn.querySelector('i').className = 'fa-regular fa-heart';
                favoriteBtn.title = 'Add to favorites on ChubAI';
                chubSelectedChar._isFavorited = false;
                // Keep the session Set honest so aged reads (other card objects) agree.
                chubUserFavoriteIds.delete(charId);
                chubUserFavoriteIds.delete(Number(charId));
                const currentCount = parseInt(favoriteCountEl.textContent.replace(/[KM]/g, '')) || 0;
                if (currentCount > 0) {
                    chubSelectedChar.n_favorites = (chubSelectedChar.n_favorites || 1) - 1;
                    favoriteCountEl.textContent = formatNumber(chubSelectedChar.n_favorites);
                }
                showToast('Removed from ChubAI favorites', 'info');
            } else {
                favoriteBtn.classList.add('favorited');
                favoriteBtn.querySelector('i').className = 'fa-solid fa-heart';
                favoriteBtn.title = 'Remove from favorites on ChubAI';
                chubSelectedChar._isFavorited = true;
                chubUserFavoriteIds.add(charId);
                chubSelectedChar.n_favorites = (chubSelectedChar.n_favorites || 0) + 1;
                favoriteCountEl.textContent = formatNumber(chubSelectedChar.n_favorites);
                showToast('Added to ChubAI favorites', 'success');
            }
        } else {
            const errorText = await response.text().catch(() => '');
            console.error('[ChubAI] Favorite toggle error response:', response.status, errorText);
            const errorData = JSON.parse(errorText || '{}');
            showToast(errorData.message || `Failed to update favorite (${response.status})`, 'error');
        }
    } catch (e) {
        favoriteBtn.classList.remove('loading');
        console.error('[ChubAI] Favorite toggle error:', e);
        showToast('Failed to update favorite', 'error');
    }
}

/**
 * Release the chub modal's memory (globals, dataset.fullContent, greetings HTML, iframes); matters on mobile.
 */
function cleanupChubCharModal() {
    BrowseView.closeAvatarViewer();
    CoreAPI.setBrowseAltGreetings(null);

    const defLoading = document.getElementById('chubCharDefinitionLoading');
    if (defLoading) { defLoading.hidden = true; defLoading.innerHTML = '<div class="browse-status-note"><i class="fa-solid fa-spinner fa-spin"></i> Loading character definition...</div>'; }
    
    const modal = document.getElementById('chubCharModal');
    if (modal) {
        // Clear heavy dataset.fullContent stored on DOM elements
        modal.querySelectorAll('[data-full-content]').forEach(el => {
            delete el.dataset.fullContent;
        });
        
        // Clear all rendered section content (can hold large formatRichText HTML)
        const sectionIds = [
            'chubCharAltGreetings',
            'chubCharDescription',
            'chubCharScenario',
            'chubCharFirstMsg',
            'chubCharTagline',
            'chubCharGalleryGrid',
        ];
        for (const id of sectionIds) {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        }
        
        // Clear creator notes iframe - disconnect ResizeObserver and release its document
        const creatorNotesEl = document.getElementById('chubCharCreatorNotes');
        cleanupCreatorNotesContainer(creatorNotesEl);
    }
    chubSelectedChar = null;
}

async function downloadChubCharacter() {
    const hit = chubSelectedChar;
    if (!hit) return;
    abortChubDetailFetch();
    const fullPath = hit.fullPath;
    const characterName = hit.name || fullPath.split('/').pop();
    const characterCreator = fullPath.split('/')[0] || '';
    await view.importFromPreview({
        button: document.getElementById('chubDownloadBtn'), hit, provider: 'chub', id: fullPath, data: hit, label: 'ChubDownload',
        closePreview: closeChubCharPreview,
        prepare: async () => {
            // the duplicate check compares definitions: a Download pressed before the preview's detail lands reads the metadata the import reads
            const cachedDetail = chubDetailCache.get(fullPath);
            const definition = cachedDetail?.definition || (await fetchChubMetadata(fullPath).catch(() => null))?.definition || {};
            return {
                // its fields as the card builder maps chub's: the body is definition.personality, the public description the creator notes
                probe: {
                    name: characterName, creator: characterCreator, fullPath,
                    description: definition.personality || '',
                    personality: definition.tavern_personality || '',
                    first_mes: definition.first_message || definition.first_mes || '',
                    scenario: definition.scenario || '',
                    creator_notes: cachedDetail?.description || definition.description || '',
                },
                dialog: { name: characterName, creator: characterCreator, fullPath, avatarUrl: hit.avatar_url || `${CHUB_AVATAR_BASE}${fullPath}/avatar.webp` },
            };
        },
    });
}

// ========================================
// WINDOW EXPORTS
// Functions called from library.js
// ========================================

window.openChubCharPreview = openChubCharPreview;

// ========================================
// SINGLETON EXPORT
// ========================================

const chubBrowseView = new ChubBrowseView();
export default chubBrowseView;

// ========================================
// CREATOR DOWNLOADS ADAPTER
// ========================================

registerCdAdapter('chub', {
    async fetchAll(view) {
        const authorName = view._cdRef?.name;
        if (!authorName) return [];
        const nsfw = (CoreAPI.getSetting('chubNsfw') === true).toString();
        const results = [];
        const seen = new Set();
        const MAX_PAGES = 200;
        for (let page = 1; page <= MAX_PAGES; page++) {
            const params = new URLSearchParams();
            params.set('first', '48');
            params.set('page', String(page));
            params.set('username', authorName);
            params.set('sort', 'id');
            params.set('nsfw', nsfw);
            params.set('nsfl', nsfw);
            params.set('include_forks', 'true');
            params.set('venus', 'false');
            params.set('min_tokens', '50');
            const resp = await fetch(`${CHUB_API_BASE}/search?${params.toString()}`, { headers: getChubHeaders(true) });
            if (!resp.ok) throw new Error(`ChubAI API error ${resp.status}`);
            const data = await resp.json();
            const nodes = extractNodes(data);
            let added = 0;
            for (const node of nodes) {
                const fp = node.fullPath || node.full_path || '';
                if (!fp || seen.has(fp)) continue;
                seen.add(fp);
                added++;
                results.push({ key: fp.toLowerCase(), name: node.name || '', creator: fp.split('/')[0] || '', raw: node });
            }
            const hasMore = (data.data?.cursor ?? data.cursor) != null && nodes.length > 0;
            if (!hasMore || added === 0) break;
        }
        return results;
    },
    async importOne(view, card) {
        const provider = CoreAPI.getProvider('chub');
        if (!provider?.importCharacter) return { ok: false, error: 'Provider not available' };
        const fullPath = card.raw.fullPath || card.raw.full_path || '';
        const result = await importThroughCommand(provider, fullPath, card.raw, {});
        if (!result.success) return { ok: false, error: result.error || 'Import failed' };
        return view.creatorImportAnswer(result, provider);
    },
});
