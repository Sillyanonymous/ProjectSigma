// WyvernBrowseView - Wyvern browse/search UI for the Online tab

import {
    BrowseView, registerCdAdapter, featureFilterState, renderFeatureFilterItems, countActiveFeatures,
    browseCardImageWidth, activeFeatureRows, featurePasses, featureBadgesHtml, applyTagsClamp, updateTagStateButton, tagStateButtonHtml, cardTagsHtml,
    renderViewToggle, libraryFeatureRows, libraryBadgeHtml, libraryCardClass, renderAltGreetingsList,
    syncSortStandIn, CREATOR_SORT_STANDIN, setFilterCount, updateNsfwToggleButton,
} from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { IMG_PLACEHOLDER, formatNumber, fetchWithProxy, BROWSE_PURIFY_CONFIG, skeletonLines, deferRender, deferCall, isMobileMode, importThroughCommand, readJsonClassified, renderBrowseError, definitionFailedNotice } from '../provider-utils.js';
import {
    WYVERN_API_BASE,
    WYVERN_SITE_BASE,
    getWyvernHeaders,
    getWyvernCharName,
    getWyvernAltGreetings,
    getAvatarUrl,
    getCharacterPageUrl,
    firebaseSignIn,
    firebaseRefreshToken,
    getTokenTTL,
} from './wyvern-api.js';

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

let wyvernCharacters = [];
let wyvernCurrentPage = 1;
let wyvernHasMore = true;
let wyvernIsLoading = false;
let wyvernLoadGeneration = 0;
let wyvernCurrentSort = 'popular';
let wyvernCurrentSearch = '';
let wyvernSelectedChar = null;
let wyvernToken = null;
let wyvernNsfwEnabled = false;
let wyvernRefreshTimer = null;
let wyvernLoginInProgress = false;

let wyvernTagFilters = new Map(); // Map<tagName, 'include' | 'exclude'>

// all four filter at render time in both modes; the two must-haves share their nodeTest with the card badges
const WYVERN_FEATURE_FILTERS = [
    { key: 'hasLorebook', id: 'wyvernFilterLorebook', section: 'must', icon: 'fa-book', label: 'Lorebook',
      nodeTest: (c) => c.lorebooks?.length > 0,
      badge: { cls: '', title: 'Has Lorebook', icon: 'fa-book' } },
    { key: 'hasAltGreetings', id: 'wyvernFilterGreetings', section: 'must', icon: 'fa-comments', label: 'Alt Greetings',
      nodeTest: (c) => getWyvernAltGreetings(c).length > 0,
      badge: { cls: '', title: 'Alt Greetings', icon: 'fa-comment-dots' } },
    ...libraryFeatureRows('wyvern', () => view, isCharPossibleMatchObj),
];
const wyvernFeatureState = featureFilterState(WYVERN_FEATURE_FILTERS);

const WYVERN_FILTER_SECTIONS = [
    { key: 'must', title: 'Character must have:' },
    { key: 'library', title: 'Library:' },
];

let wyvernViewMode = 'browse';
let wyvernFollowingCharacters = [];
let wyvernFollowingLoading = false;
let wyvernCreatorFilter = null; // { uid, displayName, vanityUrl }
let wyvernCreatorSort = 'created_at';
let wyvernIsFollowingCurrentCreator = false;

let wyvernCardLookup = new Map();
let wyvernDelegatesInitialized = false;
let wyvernModalEventsAttached = false;
let wyvernDetailFetchController = null;
const wyvernDetailCache = new Map();
const WYVERN_DETAIL_CACHE_MAX = 5;

let wyvernGridRenderedCount = 0;

let view; // module-scoped BrowseView instance reference (set once in constructor)

function getCharStats(char) {
    const sr = char.statistics_record || char.entity_statistics || {};
    return {
        views: sr.views || sr.total_views || char.views || 0,
        likes: sr.likes || sr.total_likes || char.likes || 0,
        messages: sr.messages || sr.total_messages || char.messages || 0,
    };
}

function isCharPossibleMatchObj(c) {
    if (view.isHitInLibrary(c)) return false;
    const creator = c.creator?.displayName || c.creator?.username || '';
    return view.isCharPossibleMatch(getWyvernCharName(c), creator);
}

function buildWyvernLookup(characters) {
    wyvernCardLookup.clear();
    for (const char of characters) {
        if (char.id) wyvernCardLookup.set(char.id, char);
    }
}

// Popular tags from Wyvern (populated from API results)
let wyvernPopularTags = [];
let wyvernTagsLoaded = false;

class WyvernBrowseView extends BrowseView {

    constructor(provider) {
        super(provider);
        view = this;
    }

    hitMatchName(hit) {
        return { name: getWyvernCharName(hit), creator: hit.creator?.displayName || hit.creator?.username || '' };
    }

    hitLinkKey(hit) {
        return hit?.id || null;
    }

    get previewModalId() { return 'wyvernCharModal'; }

    // the provider page a finished import's gallery is fetched from (the import summary's row)
    galleryUrlFor(result) { return `${WYVERN_SITE_BASE}/characters/${result.providerCharId}`; }

    _getImageGridIds() {
        return ['wyvernGrid', 'wyvernFollowingGrid'];
    }

    closePreview() {
        closeWyvernCharPreview();
    }

    get mobileFilterIds() {
        return {
            sort: 'wyvernSortSelect',
            tags: 'wyvernTagsBtn',
            filters: 'wyvernFiltersBtn',
            nsfw: 'wyvernNsfwToggle',
            refresh: 'refreshWyvernBtn',
            modeBrowseSelector: '.browse-view-btn[data-wyvern-view="browse"]',
            modeFollowSelector: '.browse-view-btn[data-wyvern-view="following"]',
            modeBtnClass: 'browse-view-btn',
        };
    }

    get hasModeToggle() { return true; }

    _getScrollThreshold() {
        const zoom = parseFloat(document.body.style.zoom) || 1;
        return 3000 / zoom;
    }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'popular', label: 'Popular' },
                { value: 'nsfw-popular', label: 'Popular NSFW' },
                { value: 'recommended', label: 'Recommended' },
                { value: 'created_at', label: 'New' },
                { value: 'votes', label: 'Most Likes' },
                { value: 'messages', label: 'Most Messages' },
            ],
            viewModes: [
                { value: 'browse', label: 'Browse' },
                { value: 'following', label: 'Following' },
            ],
        };
    }

    canLoadMore() {
        if (wyvernViewMode === 'browse') return wyvernHasMore && !wyvernIsLoading;
        if (wyvernViewMode === 'following') return wyvernFollowingHasMore && !wyvernFollowingLoading;
        return false;
    }

    // Filter Bar

    renderFilterBar() {
        return `
            <!-- Mode Toggle -->
            ${renderViewToggle('wyvern-view', [
                { value: 'browse', icon: 'fa-compass', label: 'Browse', title: 'Browse all characters', active: true },
                { value: 'following', icon: 'fa-users', label: 'Following', title: 'New from followed authors (requires login)' },
            ])}

            <!-- Sort dropdown -->
            <div class="browse-sort-container">
                <select id="wyvernSortSelect" class="glass-select" title="Sort characters">
                    <option value="popular" data-icon="fa-solid fa-fire" selected>Popular</option>
                    <option value="nsfw-popular" data-icon="fa-solid fa-pepper-hot">Popular NSFW</option>
                    <option value="recommended" data-icon="fa-solid fa-thumbs-up">Recommended</option>
                    <option value="created_at" data-icon="fa-solid fa-calendar-plus">New</option>
                    <option value="votes" data-icon="fa-solid fa-heart">Most Likes</option>
                    <option value="messages" data-icon="fa-solid fa-comments">Most Messages</option>
                </select>
            </div>

            <!-- Tag Filter -->
            <div class="browse-tags-dropdown-container u-relative">
                <button id="wyvernTagsBtn" class="glass-btn" title="Filter by tag">
                    <i class="fa-solid fa-tags"></i> <span id="wyvernTagsBtnLabel">Tags</span>
                </button>
                <div id="wyvernTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="wyvernTagsSearchInput" placeholder="Type a tag name..." autocomplete="one-time-code">
                        <button id="wyvernTagsClearBtn" class="glass-btn icon-only" title="Clear tag filter">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="wyvernTagsList"></div>
                </div>
            </div>

            <!-- Feature Filters -->
            <div class="browse-more-filters u-relative">
                <button id="wyvernFiltersBtn" class="glass-btn" title="Filter options">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="wyvernFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden">
                    ${renderFeatureFilterItems(WYVERN_FILTER_SECTIONS, WYVERN_FEATURE_FILTERS)}
                </div>
            </div>

            <!-- NSFW Toggle -->
            <button id="wyvernNsfwToggle" class="glass-btn nsfw-toggle u-dim-50">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <!-- Refresh -->
            <button id="refreshWyvernBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // Main View

    renderView() {
        return `
            <div id="wyvernBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="wyvernSearchInput" placeholder="Search Wyvern characters..." autocomplete="one-time-code">
                        <button id="wyvernClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="wyvernSearchBtn" class="browse-search-submit" aria-label="Search">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                    <div class="browse-creator-search">
                        <div class="browse-creator-search-wrapper">
                            <i class="fa-solid fa-user"></i>
                            <input type="search" id="wyvernCreatorSearchInput" placeholder="Search by creator..." autocomplete="one-time-code">
                            <button id="wyvernCreatorSearchBtn" class="browse-search-submit" title="Search by creator">
                                <i class="fa-solid fa-arrow-right"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Creator Filter Banner -->
                <div id="wyvernCreatorBanner" class="browse-author-banner hidden">
                    <div class="browse-author-banner-content">
                        <i class="fa-solid fa-user"></i>
                        <span>Showing characters by <strong id="wyvernCreatorName"></strong></span>
                    </div>
                    <div class="browse-author-banner-actions">
                        <select id="wyvernCreatorSortSelect" class="glass-select" title="Sort creator's characters">
                            <option value="created_at" data-icon="fa-solid fa-calendar-plus" selected>Newest Created</option>
                            <option value="votes" data-icon="fa-solid fa-heart">Most Likes</option>
                            <option value="messages" data-icon="fa-solid fa-comments">Most Messages</option>
                        </select>
                        <button id="wyvernFollowCreatorBtn" class="glass-btn browse-author-follow-btn" title="Follow this creator on Wyvern">
                            <i class="fa-solid fa-heart"></i> <span>Follow</span>
                        </button>
                        <button id="wyvernClearCreatorBtn" class="glass-btn icon-only" title="Clear creator filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <!-- Results Grid -->
                <div id="wyvernGrid" class="browse-grid"></div>

                <!-- Load More -->
                <div class="browse-load-more" id="wyvernLoadMore" hidden>
                    <button id="wyvernLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>

            <!-- Following Section -->
            <div id="wyvernFollowingSection" class="browse-section hidden">
                <div class="browse-timeline-header">
                    <div class="browse-timeline-header-left">
                        <h3><i class="fa-solid fa-clock"></i> Timeline</h3>
                        <p>New characters from authors you follow</p>
                    </div>
                    <div class="browse-timeline-header-right">
                        <button class="follow-mgr-toggle-btn glass-btn" id="wyvernFollowMgrToggle"
                                title="Manage followed creators">
                            <i class="fa-solid fa-users-gear"></i> Manage
                        </button>
                    </div>
                </div>
                ${this.renderFollowingManagerPanel()}
                <div id="wyvernFollowingGrid" class="browse-grid"></div>
                <div class="browse-load-more" id="wyvernFollowingLoadMore" hidden>
                    <button id="wyvernFollowingLoadMoreBtn" class="glass-btn">
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
    <div id="wyvernLoginModal" class="modal-overlay hidden">
        <div class="modal-glass browse-login-modal">
            <div class="modal-header">
                <h2><i class="fa-solid fa-dragon"></i> Wyvern Login</h2>
                <button class="close-btn" id="wyvernLoginClose">&times;</button>
            </div>
            <div class="browse-login-body">
                <p class="browse-login-info">
                    <i class="fa-solid fa-check-circle text-success-bright"></i>
                    <strong>Browsing, search, and NSFW Popular sort work without an account.</strong>
                </p>
                <p class="browse-login-info">
                    <i class="fa-solid fa-fire text-accent"></i>
                    <strong>Log in</strong> to see NSFW content in all sort modes.
                </p>

                <div class="browse-login-form">
                    <div class="form-group">
                        <label for="wyvernLoginEmail">Email</label>
                        <input type="email" id="wyvernLoginEmail" class="glass-input" placeholder="your@email.com" autocomplete="email">
                    </div>
                    <div class="form-group">
                        <label for="wyvernLoginPassword">Password</label>
                        <input type="password" id="wyvernLoginPassword" class="glass-input" placeholder="Password" autocomplete="current-password">
                    </div>
                    <label class="checkbox-label u-mt-sm-md">
                        <input type="checkbox" id="wyvernRememberKey" checked> Remember credentials
                    </label>
                    <div id="wyvernLoginStatus" class="browse-login-status" hidden></div>
                    <div id="wyvernTokenStatus" class="browse-login-status" hidden></div>
                </div>

                <div class="browse-login-actions">
                    <button id="wyvernLoginBtn" class="cl-btn cl-btn-primary">
                        <i class="fa-solid fa-sign-in-alt"></i> Log In
                    </button>
                    <button id="wyvernLogoutBtn" class="cl-btn cl-btn-secondary" hidden>
                        <i class="fa-solid fa-sign-out-alt"></i> Log Out
                    </button>
                    <a href="${WYVERN_SITE_BASE}" target="_blank" class="cl-btn cl-btn-secondary">
                        <i class="fa-solid fa-external-link"></i> Wyvern Website
                    </a>
                </div>
            </div>
        </div>
    </div>`;
    }

    _renderPreviewModal() {
        return `
    <div id="wyvernCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="wyvernCharAvatar" src="" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="wyvernCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="wyvernCharCreator" class="browse-meta-identity" href="#" title="Click to see all characters by this author">Creator</a> •
                            <span id="wyvernCharMessages" title="Messages"><i class="fa-solid fa-message"></i> 0</span> •
                            <span id="wyvernCharLikes" title="Likes"><i class="fa-solid fa-heart"></i> 0</span>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="wyvernOpenInBrowserBtn" href="#" target="_blank" class="cl-btn cl-btn-secondary" title="Open on Wyvern">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="wyvernDownloadBtn" class="cl-btn cl-btn-primary" title="Import into your library">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="wyvernCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-tagline" id="wyvernCharTaglineSection" hidden>
                    <i class="fa-solid fa-quote-left"></i>
                    <div id="wyvernCharTagline" class="browse-tagline-text"></div>
                </div>

                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-eye"></i>
                            <span id="wyvernCharViews">0</span> views
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="wyvernCharDate">Unknown</span>
                        </div>
                        <div class="browse-stat" id="wyvernCharGreetingsStat" hidden>
                            <i class="fa-solid fa-comment-dots"></i>
                            <span id="wyvernCharGreetingsCount">0</span> greetings
                        </div>
                        <div class="browse-stat" id="wyvernCharGalleryStat" hidden>
                            <i class="fa-solid fa-images"></i>
                            <span id="wyvernCharGalleryCount">0</span> gallery
                        </div>
                    </div>
                    <div class="browse-char-tags" id="wyvernCharTags"></div>
                </div>

                <!-- Creator's Notes -->
                <div class="browse-char-section" id="wyvernCharCreatorNotesSection" hidden>
                    <h3 class="browse-section-title" data-section="wyvernCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="wyvernCharCreatorNotes" class="scrolling-text"></div>
                </div>

                <!-- Definition loading indicator -->
                <div id="wyvernCharDefinitionLoading" class="browse-char-section" hidden>
                    <div class="browse-status-note"><i class="fa-solid fa-spinner fa-spin"></i> Loading character definition...</div>
                </div>

                <!-- Description -->
                <div class="browse-char-section" id="wyvernCharDescriptionSection" hidden>
                    <h3 class="browse-section-title" data-section="wyvernCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="wyvernCharDescription" class="scrolling-text"></div>
                </div>

                <!-- Personality -->
                <div class="browse-char-section" id="wyvernCharPersonalitySection" hidden>
                    <h3 class="browse-section-title" data-section="wyvernCharPersonality" data-label="Personality" data-icon="fa-solid fa-brain" title="Click to expand">
                        <i class="fa-solid fa-brain"></i> Personality
                    </h3>
                    <div id="wyvernCharPersonality" class="scrolling-text"></div>
                </div>

                <!-- Scenario -->
                <div class="browse-char-section" id="wyvernCharScenarioSection" hidden>
                    <h3 class="browse-section-title" data-section="wyvernCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="wyvernCharScenario" class="scrolling-text"></div>
                </div>

                <!-- Example Dialogs -->
                <div class="browse-char-section browse-section-collapsed" id="wyvernCharExamplesSection" hidden>
                    <h3 class="browse-section-title" data-section="wyvernCharExamples" data-label="Example Dialogs" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Dialogs
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="wyvernCharExamples" class="scrolling-text"></div>
                </div>

                <!-- First Message -->
                <div class="browse-char-section" id="wyvernCharFirstMsgSection" hidden>
                    <h3 class="browse-section-title" data-section="wyvernCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="wyvernCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>

                <!-- Alternate Greetings -->
                <div class="browse-char-section" id="wyvernCharAltGreetingsSection" hidden>
                    <h3 class="browse-section-title" data-section="browseAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="wyvernCharAltGreetingsCount"></span>
                    </h3>
                    <div id="wyvernCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>

                <!-- Gallery -->
                <div class="browse-char-section" id="wyvernCharGallerySection" hidden>
                    <h3 class="browse-section-title" data-section="wyvernCharGalleryGrid" data-label="Gallery" data-icon="fa-solid fa-images" title="Click to expand">
                        <i class="fa-solid fa-images"></i> Gallery <span class="browse-section-count" id="wyvernCharGalleryLabel"></span>
                    </h3>
                    <div id="wyvernCharGalleryGrid" class="browse-gallery-grid"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // Lifecycle

    init() {
        super.init();
        initWyvernView();
        this._registerDropdownDismiss([
            { dropdownId: 'wyvernFiltersDropdown', buttonId: 'wyvernFiltersBtn' },
            { dropdownId: 'wyvernTagsDropdown', buttonId: 'wyvernTagsBtn' },
        ]);
    }

    getSearchModes() { return ['character', 'creator']; }
    getSearchInputId(mode) {
        return mode === 'creator' ? 'wyvernCreatorSearchInput' : 'wyvernSearchInput';
    }

    applyDefaults(defaults) {
        super.applyDefaults(defaults);
        if (defaults.sort && wyvernViewMode === 'browse') {
            wyvernCurrentSort = defaults.sort;
            const el = document.getElementById('wyvernSortSelect');
            if (el) el.value = defaults.sort;
        }
    }

    // Activation hooks and the two modes

    resetSessionState() {
        wyvernCurrentSearch = '';
        wyvernCharacters = [];
        wyvernCurrentPage = 1;
        wyvernHasMore = true;
        wyvernGridRenderedCount = 0;
        wyvernIsLoading = false;
        wyvernFollowingLoading = false;
        wyvernFollowingCharacters = [];
        wyvernFollowingPage = 1;
        wyvernFollowingHasMore = true;
        wyvernFollowingRenderedCount = 0;
        wyvernTagFilters = new Map();
        for (const k of Object.keys(wyvernFeatureState)) wyvernFeatureState[k] = false;
        wyvernNsfwEnabled = false;
        wyvernCurrentSort = 'popular';
        wyvernViewMode = 'browse';
        wyvernCreatorFilter = null;
        wyvernSelectedChar = null;
    }

    onActivated(isReEntry) {
        wyvernDelegatesInitialized = true;
        // mode loads chain the token refresh themselves; only the has-data path needs it, and a recovered token reloads that mode
        if (this._currentViewMode()?.hasData()) {
            tryWyvernAutoLogin().then(recovered => {
                if (recovered && wyvernNsfwEnabled) this.reload({ force: true });
            });
        }
    }

    get viewModes() {
        return {
            modeAttr: 'data-wyvern-view',
            current: () => wyvernViewMode,
            set: (m) => { wyvernViewMode = m; },
            modes: {
                browse: {
                    sectionId: 'wyvernBrowseSection',
                    gridId: 'wyvernGrid',
                    hasData: () => wyvernCharacters.length > 0,
                    // login first: the token changes what the API returns
                    load: (o) => {
                        if (o?.append) { if (wyvernIsLoading) return; wyvernCurrentPage++; }
                        else { wyvernCharacters = []; wyvernCurrentPage = 1; }
                        return tryWyvernAutoLogin().then(() => loadWyvernCharacters(!!o?.force));
                    },
                    render: () => renderWyvernGrid(),
                    chrome: () => setWyvernModeChrome('browse'),
                },
                following: {
                    sectionId: 'wyvernFollowingSection',
                    gridId: 'wyvernFollowingGrid',
                    hasData: () => wyvernFollowingCharacters.length > 0,
                    load: (o) => {
                        if (o?.append) { if (wyvernFollowingLoading) return; wyvernFollowingPage++; }
                        return tryWyvernAutoLogin().then(() => loadWyvernFollowing(!!o?.force));
                    },
                    render: () => renderWyvernFollowing(),
                    chrome: () => setWyvernModeChrome('following'),
                },
            },
        };
    }

    get creatorScope() {
        return {
            bannerId: 'wyvernCreatorBanner',
            isActive: () => !!wyvernCreatorFilter,
            load: () => fetchWyvernCreatorCharacters(),
            clear: () => {
                wyvernCreatorFilter = null;
                wyvernCreatorSort = 'created_at';
                ++wyvernLoadGeneration;
                wyvernIsLoading = false;
                const sortSelect = document.getElementById('wyvernCreatorSortSelect');
                if (sortSelect) sortSelect.value = 'created_at';
                wyvernCharacters = [];
                wyvernCurrentPage = 1;
                wyvernHasMore = true;
            },
            chrome: () => setWyvernModeChrome(wyvernViewMode),
        };
    }

    // Following Manager

    get supportsFollowingManager() { return true; }

    async getFollowedCreators() {
        if (!wyvernToken) return [];
        const seen = new Map();
        for (const c of wyvernFollowingCharacters) {
            const cr = c.creator;
            if (!cr?.uid || seen.has(cr.uid)) continue;
            seen.set(cr.uid, {
                id: cr.uid,
                name: cr.displayName || cr.username || cr.uid,
                username: cr.vanityUrl || cr.username || '',
                characterCount: 0,
            });
        }
        for (const c of wyvernFollowingCharacters) {
            const entry = c.creator?.uid && seen.get(c.creator.uid);
            if (entry) entry.characterCount++;
        }
        return [...seen.values()];
    }

    async followCreator(query) {
        if (!wyvernToken) {
            showToast('Login required to follow creators on Wyvern', 'warning');
            return null;
        }
        const trimmed = query.trim();
        if (!trimmed) return null;

        try {
            const headers = getWyvernHeaders(false);
            const resp = await fetchWithProxy(
                `${WYVERN_API_BASE}/exploreSearch/users?q=${encodeURIComponent(trimmed)}&page=1&limit=10`,
                { method: 'GET', headers }
            );
            const data = await resp.json();
            const results = data.results || [];
            if (results.length === 0) {
                showToast(`No creators found matching "${trimmed}"`, 'warning');
                return null;
            }
            const exact = results.find(u =>
                u.displayName?.toLowerCase() === trimmed.toLowerCase() ||
                u.vanityUrl?.toLowerCase() === trimmed.toLowerCase());
            const user = exact || results[0];

            // Follow
            const authHeaders = getWyvernHeaders(true);
            const followResp = await fetchWithProxy(
                `${WYVERN_API_BASE}/users/${user.uid}/follow`,
                { method: 'GET', headers: authHeaders }
            );
            const followData = await followResp.json();
            if (followData.message === 'Followed') {
                showToast(`Following ${user.displayName}`, 'success');
                return { id: user.uid, name: user.displayName, username: user.vanityUrl || '' };
            }
            showToast(followData.message || 'Already following this creator', 'info');
            return null;
        } catch (e) {
            showToast(`Failed to follow: ${e.message}`, 'error');
            return null;
        }
    }

    async unfollowCreator(id) {
        if (!wyvernToken) return false;
        try {
            const headers = getWyvernHeaders(true);
            const resp = await fetchWithProxy(
                `${WYVERN_API_BASE}/users/${id}/unfollow`,
                { method: 'GET', headers }
            );
            const data = await resp.json();
            if (data.message === 'Unfollowed') {
                showToast('Unfollowed creator', 'info');
                return true;
            }
            return false;
        } catch (e) {
            showToast(`Failed to unfollow: ${e.message}`, 'error');
            return false;
        }
    }

    browseCreatorFromManager(creator) {
        enterWyvernCreatorScope(creator.id, creator.name || creator.id, creator.username || '');
    }

    getFollowingManagerSortOptions() {
        return [
            { value: 'name_asc', label: 'Name A-Z' },
            { value: 'name_desc', label: 'Name Z-A' },
            { value: 'chars', label: 'Most Characters' },
        ];
    }

    deactivate() {
        super.deactivate();
        wyvernDelegatesInitialized = false;
        // Reset in-flight flags so a stuck flag from a hung fetch can't block
        // the next view re-entry from kicking off a fresh load.
        wyvernIsLoading = false;
        wyvernFollowingLoading = false;
        if (wyvernDetailFetchController) {
            wyvernDetailFetchController.abort();
            wyvernDetailFetchController = null;
        }
    }

}

// ========================================
// WYVERN BROWSE LOGIC
// ========================================

function initWyvernView() {
    const sortEl = document.getElementById('wyvernSortSelect');
    if (sortEl) {
        sortEl.value = wyvernCurrentSort;
        CoreAPI.initCustomSelect(sortEl);
    }

    const creatorSortEl = document.getElementById('wyvernCreatorSortSelect');
    if (creatorSortEl) {
        creatorSortEl.value = wyvernCreatorSort;
        CoreAPI.initCustomSelect(creatorSortEl);
    }

    setupWyvernGridDelegates();

    // Mode toggle (Browse / Following)
    document.querySelectorAll('.browse-view-btn[data-wyvern-view]').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.wyvernView;
            if (!mode || mode === wyvernViewMode) return;
            if (mode === 'following' && !wyvernToken) {
                showToast('Login required for Following. Click Log In to authenticate.', 'warning');
                openWyvernLoginModal();
                return;
            }
            switchWyvernViewMode(mode);
        });
    });

    // Sort change
    on('wyvernSortSelect', 'change', (e) => {
        wyvernCurrentSort = e.target.value;
        wyvernBrowseView.reload();
    });

    // Filters dropdown toggle
    on('wyvernFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns('wyvernFiltersDropdown');
        document.getElementById('wyvernTagsDropdown')?.classList.add('hidden');
        document.getElementById('wyvernFiltersDropdown')?.classList.toggle('hidden');
    });

    // Feature filters apply at render time, in whichever mode is active
    wyvernBrowseView.wireFeatureFilters(WYVERN_FEATURE_FILTERS, wyvernFeatureState, () => {
        if (wyvernViewMode === 'browse') renderWyvernGrid();
        else renderWyvernFollowing();
    }, { badge: updateWyvernFiltersButtonState });

    // Creator filter
    on('wyvernClearCreatorBtn', 'click', clearWyvernCreatorFilter);
    on('wyvernFollowCreatorBtn', 'click', toggleWyvernFollowCreator);
    on('wyvernCreatorSortSelect', 'change', (e) => {
        wyvernCreatorSort = e.target.value;
        renderWyvernGrid();
    });

    // Tags dropdown
    initWyvernTagsDropdown();

    // Refresh
    on('refreshWyvernBtn', 'click', () => wyvernBrowseView.reload({ force: true }));

    // Load more
    on('wyvernFollowingLoadMoreBtn', 'click', () => {
        if (wyvernFollowingLoading) return;
        wyvernBrowseView.reload({ append: true });
    });

    on('wyvernLoadMoreBtn', 'click', () => {
        if (wyvernIsLoading) return;
        wyvernBrowseView.reload({ append: true });
    });

    // Search
    on('wyvernSearchInput', 'keypress', (e) => {
        if (e.key === 'Enter') performWyvernSearch();
    });
    on('wyvernSearchBtn', 'click', () => performWyvernSearch());
    on('wyvernClearSearchBtn', 'click', () => {
        const input = document.getElementById('wyvernSearchInput');
        if (input) { input.value = ''; input.focus(); }
        document.getElementById('wyvernClearSearchBtn')?.classList.add('hidden');
        performWyvernSearch();
    });

    // Creator search
    on('wyvernCreatorSearchInput', 'keypress', (e) => {
        if (e.key === 'Enter') performWyvernCreatorSearch();
    });
    on('wyvernCreatorSearchBtn', 'click', () => performWyvernCreatorSearch());

    // the NSFW button lives in the filter bar, which every provider switch rebuilds
    on('wyvernNsfwToggle', 'click', () => {
        wyvernNsfwEnabled = !wyvernNsfwEnabled;
        setSetting('wyvernNsfw', wyvernNsfwEnabled);
        updateWyvernNsfwToggle();
        wyvernBrowseView.reload();
    });

    // Modal + document-level listeners - attach once (persist across provider switches)
    if (!wyvernModalEventsAttached) {
        wyvernModalEventsAttached = true;

        const wyvernOverlay = document.getElementById('wyvernCharModal');
        BrowseView.wireTitleScroll(document.getElementById('wyvernCharName'), wyvernOverlay, wyvernOverlay?.querySelector('.browse-char-modal'));

        // Avatar click → full-size (desktop only at event time; on mobile bail
        // before stopPropagation so the delegated tap runs)
        const wyvernAvatar = document.getElementById('wyvernCharAvatar');
        if (wyvernAvatar) {
            wyvernAvatar.addEventListener('click', (e) => {
                if (isMobileMode()) return;
                e.stopPropagation();
                if (!wyvernAvatar.src) return;
                BrowseView.openAvatarViewer(wyvernAvatar.src);
            });
        }

        on('wyvernCharClose', 'click', closeWyvernCharPreview);
        on('wyvernDownloadBtn', 'click', () => downloadWyvernCharacter());

        const wyvernGalleryGrid = document.getElementById('wyvernCharGalleryGrid');
        if (wyvernGalleryGrid) {
            wyvernGalleryGrid.addEventListener('click', (e) => {
                if (e.target.classList.contains('browse-gallery-thumb')) {
                    const thumbs = [...wyvernGalleryGrid.querySelectorAll('.browse-gallery-thumb')];
                    const urls = thumbs.map(t => t.src);
                    const idx = thumbs.indexOf(e.target);
                    BrowseView.openAvatarViewer(e.target.src, null, urls, idx);
                }
            });
        }

        on('wyvernCharModal', 'click', (e) => {
            if (e.target.id === 'wyvernCharModal') closeWyvernCharPreview();
        });

        on('wyvernLoginClose', 'click', () => hideModal('wyvernLoginModal'));
        on('wyvernLoginModal', 'click', (e) => {
            if (e.target.id === 'wyvernLoginModal') hideModal('wyvernLoginModal');
        });
        on('wyvernLoginBtn', 'click', wyvernLoginWithCredentials);
        on('wyvernLogoutBtn', 'click', wyvernLogout);

        // Enter key submits login
        const loginKeyHandler = (e) => { if (e.key === 'Enter') wyvernLoginWithCredentials(); };
        document.getElementById('wyvernLoginEmail')?.addEventListener('keypress', loginKeyHandler);
        document.getElementById('wyvernLoginPassword')?.addEventListener('keypress', loginKeyHandler);

        window.registerOverlay?.({ id: 'wyvernCharModal', tier: 7, close: closeWyvernCharPreview });
        window.registerOverlay?.({ id: 'wyvernLoginModal', tier: 6, close: () => hideModal('wyvernLoginModal') });
        window.registerOverlay?.({ id: 'wyvernCreatorBanner', tier: 9, close: () => clearWyvernCreatorFilter() });
    }

    loadWyvernToken();

    debugLog('Wyvern view initialized');
}

// ========================================
// WYVERN AUTH
// ========================================

function loadWyvernToken() {
    const savedToken = getSetting('wyvernToken');
    if (savedToken) {
        wyvernToken = savedToken;
        debugLog('[WyvernAuth] Loaded token from settings');
    }
    wyvernNsfwEnabled = getSetting('wyvernNsfw') === true;
    updateWyvernNsfwToggle();
    updateWyvernLoginUI();
}

async function wyvernLoginWithCredentials() {
    if (wyvernLoginInProgress) return;

    const emailInput = document.getElementById('wyvernLoginEmail');
    const passwordInput = document.getElementById('wyvernLoginPassword');
    const loginBtn = document.getElementById('wyvernLoginBtn');
    const statusEl = document.getElementById('wyvernLoginStatus');

    const email = emailInput?.value.trim();
    const password = passwordInput?.value;
    if (!email || !password) {
        showToast('Please enter your email and password', 'warning');
        return;
    }

    wyvernLoginInProgress = true;
    if (loginBtn) {
        loginBtn.disabled = true;
        loginBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Logging in...';
    }
    if (statusEl) { statusEl.hidden = true; }

    try {
        const result = await firebaseSignIn(email, password);
        const idToken = result.idToken;
        const refreshToken = result.refreshToken;

        wyvernToken = idToken;
        setSettings({
            wyvernToken: idToken,
            wyvernRefreshToken: refreshToken,
            wyvernUid: result.localId || '',
        });

        const rememberCheckbox = document.getElementById('wyvernRememberKey');
        if (rememberCheckbox?.checked) {
            setSettings({ wyvernEmail: email, wyvernPassword: password });
        }

        scheduleWyvernTokenRefresh(idToken, refreshToken);

        wyvernNsfwEnabled = getSetting('wyvernNsfw') === true;
        updateWyvernNsfwToggle();
        updateWyvernLoginUI();

        hideModal('wyvernLoginModal');
        showToast('Logged in to Wyvern', 'success');

        wyvernBrowseView.reload();
    } catch (e) {
        console.error('[WyvernAuth] Login failed:', e);
        if (statusEl) {
            statusEl.hidden = false;
            statusEl.innerHTML = `<i class="fa-solid fa-exclamation-circle text-error-bright"></i> ${escapeHtml(e.message)}`;
        }
        showToast('Login failed: ' + e.message, 'error');
    } finally {
        wyvernLoginInProgress = false;
        if (loginBtn) {
            loginBtn.disabled = false;
            loginBtn.innerHTML = '<i class="fa-solid fa-sign-in-alt"></i> Log In';
        }
    }
}

function wyvernLogout() {
    clearWyvernTokenRefresh();
    wyvernToken = null;
    wyvernNsfwEnabled = false;
    setSettings({
        wyvernToken: null,
        wyvernRefreshToken: null,
        wyvernNsfw: false,
        wyvernEmail: null,
        wyvernPassword: null,
        wyvernUid: null,
    });

    const emailInput = document.getElementById('wyvernLoginEmail');
    const passwordInput = document.getElementById('wyvernLoginPassword');
    if (emailInput) emailInput.value = '';
    if (passwordInput) passwordInput.value = '';

    updateWyvernNsfwToggle();
    updateWyvernLoginUI();
    showToast('Logged out of Wyvern', 'info');

    // Drop following state so logged-out users dont see stale data.
    wyvernFollowingCharacters = [];
    wyvernFollowingLoading = false;
    wyvernFollowingPage = 1;
    wyvernFollowingHasMore = true;
    wyvernFollowingRenderedCount = 0;
    if (wyvernViewMode === 'following') {
        switchWyvernViewMode('browse');
        return;
    }

    wyvernBrowseView.reload();
}

function scheduleWyvernTokenRefresh(idToken, refreshToken) {
    clearWyvernTokenRefresh();
    if (!refreshToken) return;

    const ttl = getTokenTTL(idToken);
    if (ttl <= 0) return;

    // Refresh at 80% of TTL
    const delay = Math.max(30, Math.floor(ttl * 0.8)) * 1000;
    debugLog(`[WyvernAuth] Scheduling token refresh in ${Math.round(delay / 1000)}s (TTL: ${ttl}s)`);

    wyvernRefreshTimer = setTimeout(async () => {
        try {
            const result = await firebaseRefreshToken(refreshToken);
            const newIdToken = result.id_token;
            const newRefreshToken = result.refresh_token;

            wyvernToken = newIdToken;
            setSettings({
                wyvernToken: newIdToken,
                wyvernRefreshToken: newRefreshToken,
            });
            debugLog('[WyvernAuth] Token refreshed successfully');
            scheduleWyvernTokenRefresh(newIdToken, newRefreshToken);
        } catch (e) {
            console.error('[WyvernAuth] Token refresh failed:', e);
            const recovered = await attemptWyvernTokenRecovery();
            if (!recovered) {
                wyvernToken = null;
                wyvernNsfwEnabled = false;
                updateWyvernNsfwToggle();
                updateWyvernLoginUI();
            }
        }
    }, delay);
}

function clearWyvernTokenRefresh() {
    if (wyvernRefreshTimer) {
        clearTimeout(wyvernRefreshTimer);
        wyvernRefreshTimer = null;
    }
}

async function attemptWyvernTokenRecovery() {
    const refreshToken = getSetting('wyvernRefreshToken');
    if (refreshToken) {
        try {
            const result = await firebaseRefreshToken(refreshToken);
            wyvernToken = result.id_token;
            setSettings({
                wyvernToken: result.id_token,
                wyvernRefreshToken: result.refresh_token,
            });
            scheduleWyvernTokenRefresh(result.id_token, result.refresh_token);
            debugLog('[WyvernAuth] Token recovered via refresh token');
            return true;
        } catch { /* fall through to credential login */ }
    }

    const email = getSetting('wyvernEmail');
    const password = getSetting('wyvernPassword');
    if (!email || !password) return false;

    try {
        const result = await firebaseSignIn(email, password);
        wyvernToken = result.idToken;
        setSettings({
            wyvernToken: result.idToken,
            wyvernRefreshToken: result.refreshToken,
        });
        scheduleWyvernTokenRefresh(result.idToken, result.refreshToken);
        debugLog('[WyvernAuth] Token recovered via stored credentials');
        return true;
    } catch (e) {
        console.error('[WyvernAuth] Token recovery failed:', e);
        return false;
    }
}

// resolves true on a RECOVERED token and starts no load; concurrent callers share one recovery (never two tokens)
let _wyvernAutoLoginInFlight = null;
function tryWyvernAutoLogin() {
    if (_wyvernAutoLoginInFlight) return _wyvernAutoLoginInFlight;
    _wyvernAutoLoginInFlight = (async () => {
        if (wyvernToken && getTokenTTL(wyvernToken) > 60) {
            const refreshToken = getSetting('wyvernRefreshToken');
            if (refreshToken) scheduleWyvernTokenRefresh(wyvernToken, refreshToken);
            return false;
        }
        const recovered = await attemptWyvernTokenRecovery();
        if (recovered) {
            updateWyvernNsfwToggle();
            updateWyvernLoginUI();
        }
        return recovered;
    })().finally(() => { _wyvernAutoLoginInFlight = null; });
    return _wyvernAutoLoginInFlight;
}

function updateWyvernNsfwToggle() {
    updateNsfwToggleButton('wyvernNsfwToggle', wyvernNsfwEnabled, {
        onTitle: wyvernToken ? 'NSFW content enabled - click to disable' : 'NSFW content enabled (limited without login) - click to disable',
        offTitle: 'Click to enable NSFW content',
    });
    const btn = document.getElementById('wyvernNsfwToggle');
    if (btn) btn.style.opacity = wyvernNsfwEnabled ? '1' : '0.7';
}

function updateWyvernLoginUI() {
    const loginBtn = document.getElementById('wyvernLoginBtn');
    const logoutBtn = document.getElementById('wyvernLogoutBtn');
    const tokenStatus = document.getElementById('wyvernTokenStatus');
    const emailInput = document.getElementById('wyvernLoginEmail');
    const passwordInput = document.getElementById('wyvernLoginPassword');

    if (wyvernToken) {
        if (loginBtn) loginBtn.hidden = true;
        if (logoutBtn) logoutBtn.hidden = false;
        if (emailInput) emailInput.disabled = true;
        if (passwordInput) passwordInput.disabled = true;

        const ttl = getTokenTTL(wyvernToken);
        const mins = Math.floor(ttl / 60);
        if (tokenStatus) {
            tokenStatus.hidden = false;
            tokenStatus.innerHTML = `<i class="fa-solid fa-check-circle text-success-bright"></i> Authenticated (token expires in ${mins}m)`;
        }

        const storedEmail = getSetting('wyvernEmail');
        if (storedEmail && emailInput && !emailInput.value) emailInput.value = storedEmail;
    } else {
        if (loginBtn) loginBtn.hidden = false;
        if (logoutBtn) logoutBtn.hidden = true;
        if (emailInput) emailInput.disabled = false;
        if (passwordInput) passwordInput.disabled = false;
        if (tokenStatus) tokenStatus.hidden = true;
    }
}

function openWyvernLoginModal() {
    const modal = document.getElementById('wyvernLoginModal');
    if (!modal) return;
    updateWyvernLoginUI();
    modal.classList.remove('hidden');
}

// ========================================
// WYVERN TAGS DROPDOWN
// ========================================

function initWyvernTagsDropdown() {
    const btn = document.getElementById('wyvernTagsBtn');
    const dropdown = document.getElementById('wyvernTagsDropdown');
    const searchInput = document.getElementById('wyvernTagsSearchInput');
    const clearBtn = document.getElementById('wyvernTagsClearBtn');

    if (!btn || !dropdown) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns('wyvernTagsDropdown');
        document.getElementById('wyvernFiltersDropdown')?.classList.add('hidden');
        const wasHidden = dropdown.classList.contains('hidden');
        dropdown.classList.toggle('hidden');
        if (wasHidden) {
            renderWyvernTagsList();
            if (!isMobileMode()) searchInput?.focus();
        }
    });

    dropdown.addEventListener('click', (e) => e.stopPropagation());

    searchInput?.addEventListener('input', debounce(() => {
        renderWyvernTagsList(searchInput.value);
    }, 150));

    searchInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const value = searchInput.value.trim().toLowerCase();
            if (value && !wyvernTagFilters.has(value)) {
                wyvernTagFilters.set(value, 'include');
                searchInput.value = '';
                updateWyvernTagsButtonState();
                renderWyvernTagsList('');
                triggerWyvernReloadDebounced();
            }
        }
    });

    clearBtn?.addEventListener('click', () => {
        wyvernTagFilters.clear();
        if (searchInput) searchInput.value = '';
        renderWyvernTagsList('');
        updateWyvernTagsButtonState();
        wyvernBrowseView.reload();
    });
}

let wyvernTagFilterDebounceTimeout = null;

function triggerWyvernReloadDebounced() {
    if (wyvernTagFilterDebounceTimeout) clearTimeout(wyvernTagFilterDebounceTimeout);
    wyvernTagFilterDebounceTimeout = setTimeout(() => {
        wyvernTagFilterDebounceTimeout = null;
        wyvernBrowseView.reload();
    }, 500);
}

function renderWyvernTagsList(filter = '') {
    const container = document.getElementById('wyvernTagsList');
    if (!container) return;

    if (wyvernPopularTags.length === 0) {
        container.innerHTML = '<div class="browse-tags-empty">Type a tag name and press Enter to filter</div>';
        return;
    }

    const filterLower = filter.toLowerCase();
    const filteredTags = filter
        ? wyvernPopularTags.filter(tag => tag.toLowerCase().includes(filterLower))
        : wyvernPopularTags;

    const hasExactMatch = filter && filteredTags.some(t => t.toLowerCase() === filterLower);
    const showCustomAdd = filter && filterLower.length >= 2 && !hasExactMatch;

    if (filteredTags.length === 0 && !showCustomAdd) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags - press Enter to add as filter</div>';
        return;
    }

    const sortedTags = [...filteredTags].sort((a, b) => {
        const aState = wyvernTagFilters.get(a);
        const bState = wyvernTagFilters.get(b);
        if (aState && !bState) return -1;
        if (!aState && bState) return 1;
        return a.localeCompare(b);
    });

    const customAddHtml = showCustomAdd ? `
        <div class="browse-tag-filter-item browse-tag-custom-add" data-custom-tag="${escapeHtml(filterLower)}">
            <button class="browse-tag-state-btn state-include" aria-label="Add as filter"><i class="fa-solid fa-plus"></i></button>
            <span class="tag-label">Add <strong>${escapeHtml(filterLower)}</strong> as filter</span>
        </div>
    ` : '';

    container.innerHTML = customAddHtml + sortedTags.map(tag => {
        const state = wyvernTagFilters.get(tag) || 'neutral';

        return `
            <div class="browse-tag-filter-item" data-tag="${escapeHtml(tag)}">
                ${tagStateButtonHtml(state)}
                <span class="tag-label">${escapeHtml(tag)}</span>
            </div>
        `;
    }).join('');

    container.querySelector('.browse-tag-custom-add')?.addEventListener('click', () => {
        if (!wyvernTagFilters.has(filterLower)) {
            wyvernTagFilters.set(filterLower, 'include');
            updateWyvernTagsButtonState();
            renderWyvernTagsList('');
            const searchInput = document.getElementById('wyvernTagsSearchInput');
            if (searchInput) searchInput.value = '';
            triggerWyvernReloadDebounced();
        }
    });

    container.querySelectorAll('.browse-tag-filter-item[data-tag]').forEach(item => {
        const tag = item.dataset.tag;
        const stateBtn = item.querySelector('.browse-tag-state-btn');
        const label = item.querySelector('.tag-label');

        const cycleState = () => {
            const current = wyvernTagFilters.get(tag) || 'neutral';
            let newState;
            if (current === 'neutral') {
                newState = 'include';
                wyvernTagFilters.set(tag, 'include');
            } else if (current === 'include') {
                newState = 'exclude';
                wyvernTagFilters.set(tag, 'exclude');
            } else {
                newState = 'neutral';
                wyvernTagFilters.delete(tag);
            }
            updateTagStateButton(stateBtn, newState);
            updateWyvernTagsButtonState();
            triggerWyvernReloadDebounced();
        };

        stateBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            cycleState();
        });
        label?.addEventListener('click', cycleState);
    });
}

function updateWyvernTagsButtonState() {
    const btn = document.getElementById('wyvernTagsBtn');
    if (!btn) return;

    const includeCount = Array.from(wyvernTagFilters.values()).filter(v => v === 'include').length;
    const excludeCount = Array.from(wyvernTagFilters.values()).filter(v => v === 'exclude').length;

    const parts = [];
    if (includeCount > 0) parts.push(`+${includeCount}`);
    if (excludeCount > 0) parts.push(`-${excludeCount}`);
    setFilterCount(btn, 'Tags', parts.join('/'));
}

function updateWyvernFiltersButtonState() {
    const btn = document.getElementById('wyvernFiltersBtn');
    if (!btn) return;
    const count = countActiveFeatures(WYVERN_FEATURE_FILTERS, wyvernFeatureState);
    setFilterCount(btn, 'Features', count);
}

function extractWyvernTagsFromResults(characters) {
    if (wyvernTagsLoaded && wyvernPopularTags.length >= 100) return;

    const tagCounts = new Map();
    for (const tag of wyvernPopularTags) tagCounts.set(tag, 10);

    for (const char of characters) {
        for (const tag of (char.tags || [])) {
            const normalized = tag.toLowerCase().trim();
            if (normalized && normalized.length > 1 && normalized.length < 40) {
                tagCounts.set(normalized, (tagCounts.get(normalized) || 0) + 1);
            }
        }
    }

    const sortedTags = [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 200)
        .map(([tag]) => tag);

    if (sortedTags.length > wyvernPopularTags.length) {
        wyvernPopularTags = sortedTags;
        wyvernTagsLoaded = true;
    }
}

// ========================================
// WYVERN SEARCH
// ========================================

function performWyvernSearch() {
    const searchInput = document.getElementById('wyvernSearchInput');
    const term = searchInput?.value.trim() || '';
    // a search is a generic query, so it leaves the scope; the typed term outranks the restored one
    if (wyvernCreatorFilter) wyvernBrowseView.clearCreatorScope({ reload: false });
    wyvernCurrentSearch = term;
    if (searchInput) searchInput.value = term;
    const clearBtn = document.getElementById('wyvernClearSearchBtn');
    if (clearBtn) clearBtn.classList.toggle('hidden', !term);
    wyvernBrowseView.reload();
}

async function performWyvernCreatorSearch() {
    const input = document.getElementById('wyvernCreatorSearchInput');
    const query = input?.value.trim();
    if (!query) {
        showToast('Please enter a creator name', 'warning');
        return;
    }

    input.value = '';

    try {
        const headers = getWyvernHeaders(false);
        const resp = await fetchWithProxy(`${WYVERN_API_BASE}/exploreSearch/users?q=${encodeURIComponent(query)}&page=1&limit=10`, {
            method: 'GET',
            headers,
        });
        const data = await resp.json();
        const results = data.results || [];

        if (results.length === 0) {
            showToast(`No creators found matching "${query}"`, 'warning');
            return;
        }

        // Exact match first, then closest match
        const exact = results.find(u => u.displayName?.toLowerCase() === query.toLowerCase()
            || u.vanityUrl?.toLowerCase() === query.toLowerCase());
        const user = exact || results[0];

        enterWyvernCreatorScope(user.uid, user.displayName, user.vanityUrl || '');
    } catch (e) {
        console.error('[Wyvern] Creator search error:', e);
        showToast('Creator search failed: ' + e.message, 'error');
    }
}

// ========================================
// WYVERN CHARACTER LOADING
// ========================================

async function loadWyvernCharacters(forceRefresh = false) {
    // a fresh load supersedes one in flight through the generation token; bailing here dropped a mid-load click

    const grid = document.getElementById('wyvernGrid');
    const loadMoreBtn = document.getElementById('wyvernLoadMoreBtn');

    if (wyvernCurrentPage === 1) {
        renderSkeletonGrid(grid);
    }

    wyvernIsLoading = true;
    const gen = ++wyvernLoadGeneration;

    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        // Recommended: separate endpoint, single batch, requires auth
        if (wyvernCurrentSort === 'recommended') {
            if (!wyvernToken) {
                showToast('Login required for recommendations', 'warning');
                wyvernIsLoading = false;
                return;
            }

            const headers = getWyvernHeaders(true);
            const response = await fetchWithProxy(`${WYVERN_API_BASE}/recommendations/characters?limit=48`, {
                method: 'GET',
                headers
            });

            const data = await readJsonClassified(response);
            if (!wyvernDelegatesInitialized || gen !== wyvernLoadGeneration) return;

            wyvernCharacters = data.results || [];
            await wyvernBrowseView.probeHits(wyvernCharacters);
            extractWyvernTagsFromResults(wyvernCharacters);
            wyvernHasMore = false;
            renderWyvernGrid(false);
            wyvernBrowseView.updateLoadMoreVisibility('wyvernLoadMore', false, true);
            wyvernIsLoading = false;
            return;
        }

        const params = new URLSearchParams();
        params.set('limit', '48');
        params.set('page', wyvernCurrentPage.toString());

        // Include tags → API parameter (comma-separated)
        const includeTags = [];
        for (const [tag, state] of wyvernTagFilters) {
            if (state === 'include') includeTags.push(tag);
        }
        if (includeTags.length > 0) {
            params.set('tags', includeTags.join(','));
        }

        // Search - omit sort so results are global, not restricted to a trending/votes pool
        if (wyvernCurrentSearch) {
            params.set('q', wyvernCurrentSearch);
        } else {
            params.set('sort', wyvernCurrentSort);
            params.set('order', 'DESC');
        }

        // NSFW rating filter
        if (wyvernNsfwEnabled && wyvernToken) {
            // Authenticated + NSFW on: omit rating to get all content
        } else if (wyvernCurrentSort === 'nsfw-popular') {
            // nsfw-popular sort returns explicit content without auth
        } else {
            params.set('rating', 'none');
        }

        debugLog('[Wyvern] Loading characters:', params.toString());

        const headers = getWyvernHeaders(wyvernNsfwEnabled && !!wyvernToken);
        const response = await fetchWithProxy(`${WYVERN_API_BASE}/exploreSearch/characters?${params}`, {
            method: 'GET',
            headers
        });

        const data = await readJsonClassified(response);

        if (!wyvernDelegatesInitialized || gen !== wyvernLoadGeneration) return;

        const nodes = data.results || [];
        await wyvernBrowseView.probeHits(nodes);

        if (wyvernCurrentPage === 1) {
            wyvernCharacters = nodes;
            extractWyvernTagsFromResults(nodes);
        } else {
            const existingIds = new Set(wyvernCharacters.map(c => c.id));
            for (const node of nodes) {
                if (node.id && !existingIds.has(node.id)) wyvernCharacters.push(node);
            }
        }

        wyvernHasMore = data.hasMore === true;
        const wasAppend = wyvernCurrentPage > 1;

        const autoFetchExcludeTags = [];
        for (const [tag, state] of wyvernTagFilters) {
            if (state === 'exclude') autoFetchExcludeTags.push(tag);
        }
        // Persistent excludes are user-typed so may carry any case; charTags below are lowercased before comparison.
        for (const t of view.persistentExcludeTags()) {
            const lt = t.toLowerCase();
            if (!autoFetchExcludeTags.includes(lt)) autoFetchExcludeTags.push(lt);
        }
        const visibleRows = activeFeatureRows(WYVERN_FEATURE_FILTERS, wyvernFeatureState);
        const hasClientFilters = visibleRows.length > 0 || autoFetchExcludeTags.length > 0;

        const isVisible = (c) => {
            if (!featurePasses(c, visibleRows)) return false;
            if (autoFetchExcludeTags.length > 0) {
                const charTags = (c.tags || []).map(t => t.toLowerCase());
                if (autoFetchExcludeTags.some(et => charTags.includes(et))) return false;
            }
            return true;
        };

        // Auto-fetch more when client-side filters remove too many results
        if (hasClientFilters && wyvernHasMore) {
            let visibleNew = nodes.filter(isVisible).length;
            let autoFetches = 0;

            while (visibleNew < 48 && wyvernHasMore && autoFetches < 3 && wyvernDelegatesInitialized && gen === wyvernLoadGeneration) {
                autoFetches++;
                wyvernCurrentPage++;
                params.set('page', wyvernCurrentPage.toString());

                const moreRes = await fetchWithProxy(`${WYVERN_API_BASE}/exploreSearch/characters?${params}`, {
                    method: 'GET', headers
                });
                if (!moreRes.ok) break;

                const moreData = await moreRes.json();
                const moreNodes = moreData.results || [];
                await wyvernBrowseView.probeHits(moreNodes);
                const existingAutoIds = new Set(wyvernCharacters.map(c => c.id));
                for (const node of moreNodes) {
                    if (node.id && !existingAutoIds.has(node.id)) {
                        existingAutoIds.add(node.id);
                        wyvernCharacters.push(node);
                    }
                }
                wyvernHasMore = moreData.hasMore === true;
                visibleNew += moreNodes.filter(isVisible).length;
            }
        }

        renderWyvernGrid(wasAppend);

        wyvernBrowseView.updateLoadMoreVisibility('wyvernLoadMore', wyvernHasMore, wyvernCharacters.length > 0);

    } catch (e) {
        console.error('[Wyvern] Load error:', e);
        if (wyvernCurrentPage === 1) {
            renderBrowseError(grid, {
                provider: 'wyvern',
                error: e,
                title: 'Failed to load Wyvern',
                flags: { token: !!wyvernToken, nsfw: wyvernNsfwEnabled },
                retry: () => { wyvernIsLoading = false; wyvernBrowseView.reload({ force: true }); },
            });
        } else {
            showToast('Failed to load more: ' + e.message, 'error');
        }
    } finally {
        // a superseded load leaves the flag and the button to the load that replaced it
        if (gen === wyvernLoadGeneration) {
            wyvernIsLoading = false;
            if (loadMoreBtn) {
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
            }
        }
    }
}

// ========================================
// VIEW MODE SWITCHING
// ========================================

// the following feed asks created_at DESC
const WYVERN_FOLLOWING_STANDIN = Object.freeze({ label: 'Newest Created', icon: 'fa-solid fa-calendar-plus', title: 'The following feed lists the newest characters first' });

function setWyvernModeChrome(mode) {
    const sortEl = document.getElementById('wyvernSortSelect');
    const scoped = mode === 'browse' && !!wyvernCreatorFilter;
    // the main sort picks a server pool neither the following feed nor the creator endpoint sees
    (sortEl?._customSelect?.container || sortEl)?.classList.toggle('hidden', mode !== 'browse' || scoped);
    syncSortStandIn(sortEl, scoped ? CREATOR_SORT_STANDIN : mode !== 'browse' ? WYVERN_FOLLOWING_STANDIN : null, [WYVERN_FOLLOWING_STANDIN, CREATOR_SORT_STANDIN]);
}

function switchWyvernViewMode(mode) {
    return wyvernBrowseView.switchViewMode(mode);
}

// ========================================
// FOLLOWING TIMELINE
// ========================================

let wyvernFollowingPage = 1;
let wyvernFollowingHasMore = true;
let wyvernFollowingRenderedCount = 0;
const FOLLOWING_PAGE_SIZE = 48;

async function loadWyvernFollowing(forceRefresh = false) {
    if (!wyvernToken) {
        renderWyvernFollowingEmpty('login');
        return;
    }

    if (wyvernFollowingLoading) return;
    wyvernFollowingLoading = true;

    const grid = document.getElementById('wyvernFollowingGrid');

    if (forceRefresh) {
        wyvernFollowingCharacters = [];
        wyvernFollowingPage = 1;
        wyvernFollowingHasMore = true;
        wyvernFollowingRenderedCount = 0;
    }

    // Skeleton only on the first page; subsequent pages append.
    if (grid && wyvernFollowingPage === 1) {
        renderSkeletonGrid(grid);
    }

    try {
        const headers = getWyvernHeaders(true);
        const params = new URLSearchParams({
            page: String(wyvernFollowingPage),
            limit: String(FOLLOWING_PAGE_SIZE),
            contentType: 'character',
            source: 'following',
            sort: 'created_at',
            order: 'DESC',
        });

        let feedData;
        try {
            const feedResp = await fetchWithProxy(`${WYVERN_API_BASE}/unified-feed?${params}`, { method: 'GET', headers });
            feedData = await readJsonClassified(feedResp);
        } catch (e) {
            if (e.message?.includes('401')) {
                renderWyvernFollowingEmpty('login');
                return;
            }
            throw e;
        }

        debugLog('[WyvernFollowing] Page', wyvernFollowingPage, ', items:', feedData.items?.length, 'total:', feedData.total, 'hasMore:', feedData.hasMore);

        const items = feedData.items || [];
        wyvernFollowingHasMore = feedData.hasMore === true && items.length > 0;

        if (items.length === 0 && wyvernFollowingCharacters.length === 0) {
            renderWyvernFollowingEmpty('empty');
            wyvernBrowseView.updateLoadMoreVisibility('wyvernFollowingLoadMore', false, false);
            return;
        }

        const existingIds = new Set(wyvernFollowingCharacters.map(c => c.id));
        for (const item of items) {
            const c = item.data || item;
            if (c.id && !existingIds.has(c.id)) {
                existingIds.add(c.id);
                wyvernFollowingCharacters.push(c);
            }
        }

        debugLog('[WyvernFollowing] Total characters:', wyvernFollowingCharacters.length);

        await wyvernBrowseView.probeHits(wyvernFollowingCharacters);
        renderWyvernFollowing(wyvernFollowingPage > 1);
        wyvernBrowseView.updateLoadMoreVisibility('wyvernFollowingLoadMore', wyvernFollowingHasMore, wyvernFollowingCharacters.length > 0);

    } catch (err) {
        console.error('[WyvernFollowing] Error loading timeline:', err);
        if (err.message?.includes('401')) {
            renderWyvernFollowingEmpty('login');
            return;
        }
        if (grid) {
            renderBrowseError(grid, {
                provider: 'wyvern',
                error: err,
                title: 'Error loading timeline',
                view: 'timeline',
                flags: { token: !!wyvernToken, nsfw: wyvernNsfwEnabled },
                retry: () => wyvernBrowseView.reload({ force: true }),
            });
        }
    } finally {
        wyvernFollowingLoading = false;
    }
}

function renderWyvernFollowingEmpty(reason) {
    const grid = document.getElementById('wyvernFollowingGrid');
    if (!grid) return;

    if (reason === 'login') {
        grid.innerHTML = `
            <div class="browse-timeline-empty">
                <i class="fa-solid fa-key"></i>
                <h3>Login Required</h3>
                <p>Log in to your Wyvern account to see new characters from authors you follow.</p>
                <button class="cl-btn cl-btn-primary" id="wyvernFollowingLoginBtn">
                    <i class="fa-solid fa-sign-in-alt"></i> Log In
                </button>
            </div>
        `;
        document.getElementById('wyvernFollowingLoginBtn')?.addEventListener('click', () => {
            const modal = document.getElementById('wyvernLoginModal');
            if (modal) modal.classList.remove('hidden');
        });
    } else if (reason === 'no_follows' || reason === 'empty') {
        grid.innerHTML = `
            <div class="browse-timeline-empty">
                <i class="fa-solid fa-inbox"></i>
                <h3>No Characters Yet</h3>
                <p>Follow some character creators on Wyvern to see their new characters here.</p>
                <a href="${WYVERN_SITE_BASE}" target="_blank" class="cl-btn cl-btn-primary">
                    <i class="fa-solid fa-external-link"></i> Browse Wyvern
                </a>
            </div>
        `;
    }
}

function sortWyvernFollowingCharacters(characters) {
    return [...characters].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

function _handleFollowingCardClick(e) {
    const creatorLink = e.target.closest('.browse-card-creator-link');
    if (creatorLink) {
        e.stopPropagation();
        const uid = creatorLink.dataset.creatorUid;
        const name = creatorLink.dataset.creatorName;
        const vanity = creatorLink.dataset.creatorVanity || '';
        if (uid && name) {
            enterWyvernCreatorScope(uid, name, vanity);
        }
        return;
    }
    const card = e.target.closest('.browse-card');
    if (!card) return;
    const charId = card.dataset.charId;
    const char = wyvernFollowingCharacters.find(c => c.id === charId);
    if (char) openWyvernCharPreview(char);
}

// the picked tags and the saved excludes, lowercased: the feeds whose endpoint takes no tag params filter by them here
function wyvernClientTags() {
    const include = [], exclude = [];
    for (const [tag, state] of wyvernTagFilters) {
        if (state === 'include') include.push(tag.toLowerCase());
        else if (state === 'exclude') exclude.push(tag.toLowerCase());
    }
    for (const t of view.persistentExcludeTags()) {
        const lt = t.toLowerCase();
        if (!exclude.includes(lt)) exclude.push(lt);
    }
    return { include, exclude };
}

function wyvernTagsPass(c, { include, exclude }) {
    const charTags = (c.tags || []).map(t => t.toLowerCase());
    return include.every(t => charTags.includes(t)) && !exclude.some(t => charTags.includes(t));
}

// what the following feed shows of what it loaded: the feature rows, SFW Only and the tags, none of which its request carries
function wyvernFollowingVisible() {
    let filtered = wyvernFollowingCharacters;
    const activeRows = activeFeatureRows(WYVERN_FEATURE_FILTERS, wyvernFeatureState);
    if (activeRows.length > 0) {
        filtered = filtered.filter(c => featurePasses(c, activeRows));
    }
    // a card reads its rating, so a rated one is NSFW here too
    if (!wyvernNsfwEnabled) filtered = filtered.filter(c => !c.rating || c.rating === 'none');
    const tags = wyvernClientTags();
    if (tags.include.length || tags.exclude.length) filtered = filtered.filter(c => wyvernTagsPass(c, tags));
    return filtered;
}

function renderWyvernFollowing(appendOnly = false) {
    const grid = document.getElementById('wyvernFollowingGrid');
    if (!grid) return;

    const sorted = sortWyvernFollowingCharacters(wyvernFollowingVisible());

    if (sorted.length === 0 && wyvernFollowingCharacters.length > 0) {
        grid.innerHTML = `
            <div class="browse-timeline-empty">
                <i class="fa-solid fa-filter"></i>
                <h3>No Matching Characters</h3>
                <p>No characters match your current filters. Try adjusting them.</p>
            </div>
        `;
        wyvernFollowingRenderedCount = 0;
        return;
    }

    // a fetched page adds only its own cards; a full rebuild would flash every loaded thumbnail per scroll page
    if (appendOnly && wyvernFollowingRenderedCount === sorted.length) return;
    if (appendOnly && wyvernFollowingRenderedCount > 0 && wyvernFollowingRenderedCount < sorted.length) {
        grid.insertAdjacentHTML('beforeend', sorted.slice(wyvernFollowingRenderedCount).map(c => createWyvernCard(c)).join(''));
    } else {
        wyvernBrowseView.disconnectImageObserver();
        grid.innerHTML = sorted.map(c => createWyvernCard(c)).join('');
    }
    wyvernFollowingRenderedCount = sorted.length;
    wyvernBrowseView.observeImages(grid);
}

// ========================================
// CREATOR FILTER
// ========================================

// enter the creator scope; the base shows the banner, runs the chrome and loads (later reloads land there too)
function enterWyvernCreatorScope(uid, displayName, vanityUrl) {
    wyvernBrowseView.enterCreatorScope(() => {
        wyvernCreatorFilter = { uid, displayName, vanityUrl };
        view._cdRef = { uid, name: displayName };
        wyvernCreatorSort = 'created_at';
        const sortSelect = document.getElementById('wyvernCreatorSortSelect');
        if (sortSelect) sortSelect.value = 'created_at';
        const nameEl = document.getElementById('wyvernCreatorName');
        if (nameEl) nameEl.textContent = displayName;
        window.pushOverlayGuard?.();
        updateWyvernFollowCreatorButton(uid);
    });
}

// the creator endpoint answers the whole catalogue at once, so sort, search and tags apply at render
async function fetchWyvernCreatorCharacters() {
    const { uid } = wyvernCreatorFilter;
    const gen = ++wyvernLoadGeneration;
    wyvernIsLoading = false;
    wyvernCharacters = [];
    wyvernCurrentPage = 1;
    wyvernHasMore = false;

    const grid = document.getElementById('wyvernGrid');
    wyvernBrowseView.updateLoadMoreVisibility('wyvernLoadMore', false, true);
    renderSkeletonGrid(grid);

    try {
        const headers = getWyvernHeaders(wyvernNsfwEnabled && !!wyvernToken);
        const resp = await fetchWithProxy(`${WYVERN_API_BASE}/characters/user/${uid}`, {
            method: 'GET',
            headers,
        });

        const data = await readJsonClassified(resp);
        // a newer load (a scope change, a refresh) owns the grid now
        if (gen !== wyvernLoadGeneration) return;
        wyvernCharacters = data.characters || data.results || [];
        await wyvernBrowseView.probeHits(wyvernCharacters);
        wyvernHasMore = false;

        renderWyvernGrid();

    } catch (e) {
        if (gen !== wyvernLoadGeneration) return;
        console.error('[Wyvern] Creator filter error:', e);
        renderBrowseError(grid, {
            provider: 'wyvern',
            error: e,
            title: 'Failed to load creator\'s characters',
            view: 'creator',
            flags: { token: !!wyvernToken },
            retry: () => wyvernBrowseView.reload(),
        });
    }
}

async function updateWyvernFollowCreatorButton(uid) {
    const followBtn = document.getElementById('wyvernFollowCreatorBtn');
    if (!followBtn) return;

    if (!wyvernToken) {
        followBtn.hidden = true;
        return;
    }

    followBtn.hidden = false;
    followBtn.disabled = true;
    followBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        const headers = getWyvernHeaders(true);
        const resp = await fetchWithProxy(`${WYVERN_API_BASE}/users/${uid}/followers?page=1&limit=100`, {
            method: 'GET',
            headers,
        });
        const data = await resp.json();
        let myUid = getSetting('wyvernUid');
        if (!myUid && wyvernToken) {
            try {
                const payload = JSON.parse(atob(wyvernToken.split('.')[1]));
                myUid = payload.user_id || '';
                if (myUid) setSetting('wyvernUid', myUid);
            } catch (_) { /* ignore parse errors */ }
        }
        wyvernIsFollowingCurrentCreator = !!(myUid && data.users?.some(u => u.uid === myUid));
    } catch (e) {
        debugLog('[Wyvern] Could not check follow status:', e);
        wyvernIsFollowingCurrentCreator = false;
    }

    followBtn.disabled = false;
    if (wyvernIsFollowingCurrentCreator) {
        followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
        followBtn.classList.add('following');
        followBtn.title = `Unfollow on Wyvern`;
    } else {
        followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
        followBtn.classList.remove('following');
        followBtn.title = `Follow on Wyvern`;
    }
}

async function toggleWyvernFollowCreator() {
    if (!wyvernCreatorFilter?.uid || !wyvernToken) {
        showToast('Login required to follow creators', 'warning');
        return;
    }

    const followBtn = document.getElementById('wyvernFollowCreatorBtn');
    if (followBtn) {
        followBtn.disabled = true;
        followBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }

    try {
        const headers = getWyvernHeaders(true);
        const endpoint = wyvernIsFollowingCurrentCreator ? 'unfollow' : 'follow';
        const resp = await fetchWithProxy(`${WYVERN_API_BASE}/users/${wyvernCreatorFilter.uid}/${endpoint}`, {
            method: 'GET',
            headers,
        });
        const data = await resp.json();

        if (data.message === 'Followed') {
            wyvernIsFollowingCurrentCreator = true;
            showToast(`Following ${wyvernCreatorFilter.displayName}`, 'success');
        } else if (data.message === 'Unfollowed') {
            wyvernIsFollowingCurrentCreator = false;
            showToast(`Unfollowed ${wyvernCreatorFilter.displayName}`, 'info');
        }
    } catch (e) {
        console.error('[Wyvern] Follow toggle error:', e);
        showToast('Follow action failed: ' + e.message, 'error');
    }

    if (followBtn) {
        followBtn.disabled = false;
        if (wyvernIsFollowingCurrentCreator) {
            followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Following</span>';
            followBtn.classList.add('following');
        } else {
            followBtn.innerHTML = '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
            followBtn.classList.remove('following');
        }
    }
}

function clearWyvernCreatorFilter() {
    wyvernBrowseView.clearCreatorScope();
}

// ========================================
// WYVERN GRID RENDERING
// ========================================

function renderWyvernGrid(appendOnly = false) {
    const grid = document.getElementById('wyvernGrid');

    let displayCharacters = wyvernCharacters;

    // Client-side sort for creator view
    if (wyvernCreatorFilter && wyvernCreatorSort !== 'created_at') {
        const stats = (c) => getCharStats(c);
        displayCharacters = [...displayCharacters].sort((a, b) => {
            if (wyvernCreatorSort === 'votes') return stats(b).likes - stats(a).likes;
            if (wyvernCreatorSort === 'messages') return stats(b).messages - stats(a).messages;
            return 0;
        });
    }

    const activeRows = activeFeatureRows(WYVERN_FEATURE_FILTERS, wyvernFeatureState);
    if (activeRows.length > 0) {
        displayCharacters = displayCharacters.filter(c => featurePasses(c, activeRows));
    }
    // the API has no exclude, and the creator endpoint takes no tags at all, so in scope the includes narrow here too
    const clientTags = wyvernClientTags();
    if (!wyvernCreatorFilter) clientTags.include = [];
    const excludeTags = clientTags.exclude;
    if (clientTags.include.length || excludeTags.length) displayCharacters = displayCharacters.filter(c => wyvernTagsPass(c, clientTags));

    if (displayCharacters.length === 0) {
        wyvernGridRenderedCount = 0;
        wyvernCardLookup.clear();
        wyvernBrowseView.disconnectImageObserver();
        const message = wyvernCharacters.length > 0 && (activeRows.length > 0 || excludeTags.length > 0)
            ? 'All characters in this view were filtered out by your current filters.'
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

    buildWyvernLookup(displayCharacters);

    // A page whose characters all got client-filtered adds nothing visible; without this guard
    // the else branch innerHTML-rebuilt the whole grid, teardown-flashing every loaded thumbnail.
    if (appendOnly && wyvernGridRenderedCount === displayCharacters.length) return;

    if (appendOnly && wyvernGridRenderedCount > 0 && wyvernGridRenderedCount < displayCharacters.length) {
        const newChars = displayCharacters.slice(wyvernGridRenderedCount);
        if (newChars.length > 0) {
            grid.insertAdjacentHTML('beforeend', newChars.map(char => createWyvernCard(char)).join(''));
        }
    } else {
        wyvernBrowseView.disconnectImageObserver();
        grid.innerHTML = displayCharacters.map(char => createWyvernCard(char)).join('');
    }

    wyvernGridRenderedCount = displayCharacters.length;
    wyvernBrowseView.observeImages(grid);
}

function setupWyvernGridDelegates() {
    if (wyvernDelegatesInitialized) return;

    const cardClickHandler = (e) => {
        // Creator link click - load creator's characters
        const creatorLink = e.target.closest('.browse-card-creator-link');
        if (creatorLink) {
            e.stopPropagation();
            const uid = creatorLink.dataset.creatorUid;
            const name = creatorLink.dataset.creatorName;
            const vanity = creatorLink.dataset.creatorVanity || '';
            if (uid && name) {
                enterWyvernCreatorScope(uid, name, vanity);
            }
            return;
        }

        const card = e.target.closest('.browse-card');
        if (!card) return;
        const charId = card.dataset.charId;
        const char = wyvernCardLookup.get(charId) || wyvernCharacters.find(c => c.id === charId) || wyvernFollowingCharacters.find(c => c.id === charId);
        if (char) openWyvernCharPreview(char);
    };

    const grid = document.getElementById('wyvernGrid');
    if (grid) grid.addEventListener('click', cardClickHandler);

    const followingGrid = document.getElementById('wyvernFollowingGrid');
    if (followingGrid) followingGrid.addEventListener('click', _handleFollowingCardClick);

    wyvernDelegatesInitialized = true;
}

function createWyvernCard(char) {
    const name = char.name || 'Unknown';
    const charId = char.id || '';
    const creatorName = char.creator?.displayName || char.creator?.username || 'Unknown';
    const creatorUid = char.creator?.uid || '';
    const stats = getCharStats(char);
    const messages = formatNumber(stats.messages);
    const likes = formatNumber(stats.likes);
    const avatarUrl = getAvatarUrl(char, { width: browseCardImageWidth() });

    const inLibrary = view.isHitInLibrary(char);
    // scorer gets '' for a missing creator (its name-only branch); the display keeps 'Unknown'
    const possibleTier = inLibrary ? null : view.getPossibleMatchTier(getWyvernCharName(char), char.creator?.displayName || char.creator?.username || '');

    const tags = (char.tags || []);

    const badges = [];
    const importing = view.importingBadge(char);
    if (importing) badges.push(importing);
    const libraryBadge = libraryBadgeHtml(inLibrary, possibleTier);
    if (libraryBadge) badges.push(libraryBadge);
    badges.push(...featureBadgesHtml(char, WYVERN_FEATURE_FILTERS));

    const ratingLabel = char.rating && char.rating !== 'none' ? char.rating : '';
    const createdDate = char.created_at ? new Date(char.created_at).toLocaleDateString() : '';
    const dateInfo = createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';

    const cardClass = libraryCardClass(inLibrary, possibleTier);
    const taglineTooltip = char.tagline ? escapeHtml(char.tagline) : '';

    return `
        <div class="${cardClass}" data-char-id="${escapeHtml(charId)}"${view.linkKeyAttr(char)} data-match-name="${escapeHtml(getWyvernCharName(char))}" ${taglineTooltip ? `title="${taglineTooltip}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/no-portrait.png'">
                ${ratingLabel ? `<span class="browse-nsfw-badge">${escapeHtml(ratingLabel)}</span>` : ''}
                ${badges.length > 0 ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                <span class="browse-card-creator-link" data-creator-uid="${escapeHtml(creatorUid)}" data-creator-name="${escapeHtml(creatorName)}" data-creator-vanity="${escapeHtml(char.creator?.vanityUrl || '')}" title="Click to see all characters by ${escapeHtml(creatorName)}">${escapeHtml(creatorName)}</span>
                ${cardTagsHtml(tags)}
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Messages"><i class="fa-solid fa-message"></i> ${messages}</span>
                <span class="browse-card-stat" title="Likes"><i class="fa-solid fa-heart"></i> ${likes}</span>
                ${dateInfo}
            </div>
        </div>
    `;
}

// ========================================
// WYVERN CHARACTER PREVIEW
// ========================================

// Canonical close path; matches sibling-provider closePreviewModal so back-button / Escape gets the same cleanup.
function closeWyvernCharPreview() {
    abortWyvernDetailFetch();
    cleanupWyvernCharModal();
    hideModal('wyvernCharModal');
    view.trackPreview(null);
}

function abortWyvernDetailFetch() {
    if (wyvernDetailFetchController) {
        wyvernDetailFetchController.abort();
        wyvernDetailFetchController = null;
    }
}

async function openWyvernCharPreview(char) {
    abortWyvernDetailFetch();
    wyvernSelectedChar = char;

    const modal = document.getElementById('wyvernCharModal');
    CoreAPI.resetBrowseSectionCollapseState(modal);
    const avatarImg = document.getElementById('wyvernCharAvatar');
    const nameEl = document.getElementById('wyvernCharName');
    const creatorEl = document.getElementById('wyvernCharCreator');
    const messagesEl = document.getElementById('wyvernCharMessages');
    const likesEl = document.getElementById('wyvernCharLikes');
    const tagsEl = document.getElementById('wyvernCharTags');
    const viewsEl = document.getElementById('wyvernCharViews');
    const dateEl = document.getElementById('wyvernCharDate');
    const taglineSection = document.getElementById('wyvernCharTaglineSection');
    const taglineEl = document.getElementById('wyvernCharTagline');
    const openInBrowserBtn = document.getElementById('wyvernOpenInBrowserBtn');
    const creatorNotesSection = document.getElementById('wyvernCharCreatorNotesSection');
    const creatorNotesEl = document.getElementById('wyvernCharCreatorNotes');
    const setWyvernCreatorNotes = (raw) => {
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
    const descSection = document.getElementById('wyvernCharDescriptionSection');
    const descEl = document.getElementById('wyvernCharDescription');
    const personalitySection = document.getElementById('wyvernCharPersonalitySection');
    const personalityEl = document.getElementById('wyvernCharPersonality');
    const scenarioSection = document.getElementById('wyvernCharScenarioSection');
    const scenarioEl = document.getElementById('wyvernCharScenario');
    const firstMsgSection = document.getElementById('wyvernCharFirstMsgSection');
    const firstMsgEl = document.getElementById('wyvernCharFirstMsg');
    const examplesSection = document.getElementById('wyvernCharExamplesSection');
    const examplesEl = document.getElementById('wyvernCharExamples');
    const galleryStat = document.getElementById('wyvernCharGalleryStat');
    const galleryCountEl = document.getElementById('wyvernCharGalleryCount');
    const gallerySection = document.getElementById('wyvernCharGallerySection');
    const galleryGrid = document.getElementById('wyvernCharGalleryGrid');
    const galleryLabel = document.getElementById('wyvernCharGalleryLabel');

    const charId = char.id || '';
    const avatarUrl = getAvatarUrl(char);
    const creatorName = char.creator?.displayName || char.creator?.username || 'Unknown';
    BrowseView.setPreviewPortrait(avatarImg, avatarUrl);
    nameEl.textContent = char.name || 'Unknown';
    creatorEl.textContent = creatorName;
    creatorEl.href = '#';
    if (char.creator?.uid) {
        creatorEl.title = `Click to see all characters by ${creatorName}`;
        creatorEl.onclick = (e) => {
            e.preventDefault();
            closeWyvernCharPreview();
            enterWyvernCreatorScope(char.creator.uid, creatorName, char.creator?.vanityUrl || '');
        };
    } else {
        creatorEl.title = creatorName;
        creatorEl.onclick = (e) => e.preventDefault();
    }
    openInBrowserBtn.href = getCharacterPageUrl(charId);
    const stats = getCharStats(char);
    messagesEl.innerHTML = `<i class="fa-solid fa-message"></i> ${formatNumber(stats.messages)}`;
    messagesEl.title = 'Messages';
    likesEl.innerHTML = `<i class="fa-solid fa-heart"></i> ${formatNumber(stats.likes)}`;
    likesEl.title = 'Likes';

    // Tags
    const tags = char.tags || [];
    tagsEl.innerHTML = tags.map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
    requestAnimationFrame(() => applyTagsClamp(tagsEl));

    // Stats
    viewsEl.textContent = formatNumber(stats.views);
    dateEl.textContent = char.created_at ? new Date(char.created_at).toLocaleDateString() : 'Unknown';

    // skeleton only when notes are likely, else start hidden so an empty card doesnt flash one
    if (creatorNotesSection && creatorNotesEl) {
        cleanupCreatorNotesContainer(creatorNotesEl);
        if ((char.creator_notes || char.tagline || '').trim()) {
            creatorNotesSection.hidden = false;
            creatorNotesEl.innerHTML = skeletonLines(3);
        } else {
            creatorNotesSection.hidden = true;
            creatorNotesEl.innerHTML = '';
        }
    }

    // Tagline
    if (char.tagline) {
        taglineSection.hidden = false;
        taglineEl.innerHTML = sanitizeTaglineHtml(char.tagline, char.name);
    } else {
        taglineSection.hidden = true;
    }

    const charAltGreetings = getWyvernAltGreetings(char);
    renderAltGreetingsList('wyvern', charAltGreetings, char.name);

    // defLoading kept around for the fetch-failure message path below; skeletons are the loading indicator otherwise.
    const defLoading = document.getElementById('wyvernCharDefinitionLoading');
    if (defLoading) defLoading.hidden = true;
    descSection.hidden = false; descEl.innerHTML = skeletonLines(3);
    personalitySection.hidden = false; personalityEl.innerHTML = skeletonLines(2);
    scenarioSection.hidden = false; scenarioEl.innerHTML = skeletonLines(2);
    examplesSection.hidden = false; examplesEl.innerHTML = skeletonLines(3);
    firstMsgSection.hidden = false; firstMsgEl.innerHTML = skeletonLines(4);
    if (gallerySection) gallerySection.hidden = true;
    if (galleryGrid) galleryGrid.innerHTML = '';
    if (galleryStat) galleryStat.hidden = true;

    // Import button state, kept in step with the library while the preview is open
    const restampImport = () => {
        const inLibraryNow = view.isHitInLibrary(char);
        view.stampImportButton(document.getElementById('wyvernDownloadBtn'), { inLibrary: inLibraryNow, possibleMatch: !inLibraryNow && !!view.getPossibleMatchTier(getWyvernCharName(char), creatorName)?.show });
    };
    restampImport();
    view.trackPreview(restampImport, char);

    modal.classList.remove('hidden');
    const charBody = modal.querySelector('.browse-char-body');
    if (charBody) charBody.scrollTop = 0;

    const applyDetailData = (node, opts = {}) => {
        if (!node) return;

        if (defLoading) defLoading.hidden = true;

        // Settled data only; the inline-data call passes false to avoid destroy+recreate when fetch follows.
        if (opts.renderCreatorNotes !== false) {
            setWyvernCreatorNotes(node.creator_notes || char.creator_notes || char.tagline);
        }

        // RAF defer so safePurify doesnt block the modal-open paint frame.
        requestAnimationFrame(() => {
            if (node.description) {
                descSection.hidden = false;
                deferCall(descEl, () => renderCardHtmlSecure(node.description, char.name, descEl));
                descEl.dataset.fullContent = node.description;
            } else if (descSection) {
                descSection.hidden = true;
            }

            if (node.personality) {
                personalitySection.hidden = false;
                deferRender(personalityEl, () => safePurify(formatRichText(node.personality, char.name, true), BROWSE_PURIFY_CONFIG));
                personalityEl.dataset.fullContent = node.personality;
            } else if (personalitySection) {
                personalitySection.hidden = true;
            }

            if (node.scenario) {
                scenarioSection.hidden = false;
                deferRender(scenarioEl, () => safePurify(formatRichText(node.scenario, char.name, true), BROWSE_PURIFY_CONFIG));
                scenarioEl.dataset.fullContent = node.scenario;
            } else if (scenarioSection) {
                scenarioSection.hidden = true;
            }

            if (node.mes_example) {
                examplesSection.hidden = false;
                deferRender(examplesEl, () => safePurify(formatRichText(node.mes_example, char.name, true), BROWSE_PURIFY_CONFIG));
                examplesEl.dataset.fullContent = node.mes_example;
            } else if (examplesSection) {
                examplesSection.hidden = true;
            }

            if (node.first_mes) {
                firstMsgSection.hidden = false;
                deferRender(firstMsgEl, () => safePurify(formatRichText(node.first_mes, char.name, true), BROWSE_PURIFY_CONFIG));
                firstMsgEl.dataset.fullContent = node.first_mes;
            } else if (firstMsgSection) {
                firstMsgSection.hidden = true;
            }
        });

        if (node.alternate_greetings?.length > 0) renderAltGreetingsList('wyvern', node.alternate_greetings, char.name);

        // Gallery
        if (node.galleryImages?.length > 0) {
            const count = node.galleryImages.length;
            if (galleryStat) {
                galleryStat.hidden = false;
                galleryCountEl.textContent = count;
            }
            if (gallerySection && galleryGrid) {
                gallerySection.hidden = false;
                if (galleryLabel) galleryLabel.textContent = `(${count})`;
                galleryGrid.innerHTML = node.galleryImages.map(img =>
                    `<div class="browse-gallery-cell"><img class="browse-gallery-thumb" src="${escapeHtml(img.url)}" alt="${escapeHtml(img.title || '')}" title="${escapeHtml(img.title || 'Gallery image')}" loading="lazy" onload="this.parentElement.classList.add('loaded')" onerror="this.parentElement.classList.add('load-failed')"></div>`
                ).join('');
            }
        } else if (node.galleryImages !== undefined) {
            if (gallerySection) gallerySection.hidden = true;
            if (galleryGrid) galleryGrid.innerHTML = '';
        }
    };

    // inline definition data (View on Wyvern, search hits) paints at once; the detail fetch still fills the rest
    const hasInlineDefinition = char.description || char.first_mes || char.personality || char.scenario;
    if (hasInlineDefinition) {
        const galleryImages = Array.isArray(char.gallery) && char.gallery.length > 0
            ? char.gallery.map(img => ({ url: img.imageURL, title: img.title || '', id: img.id }))
            : undefined;
        const inlineDetail = {
            description: char.description,
            personality: char.personality,
            scenario: char.scenario,
            mes_example: char.mes_example,
            first_mes: char.first_mes,
            creator_notes: char.creator_notes,
            alternate_greetings: charAltGreetings,
            galleryImages,
        };
        // Defer the iframe until cache/fetch settles; avoids destroy+recreate flash.
        applyDetailData(inlineDetail, { renderCreatorNotes: false });
    }

    const cachedDetail = charId ? wyvernDetailCache.get(charId) : null;
    if (cachedDetail) {
        wyvernDetailCache.delete(charId);
        wyvernDetailCache.set(charId, cachedDetail);
        applyDetailData(cachedDetail);
    }

    if (!cachedDetail && charId) {
        wyvernDetailFetchController = new AbortController();
        const fetchSignal = wyvernDetailFetchController.signal;
        try {
            const detailUrl = `${WYVERN_API_BASE}/characters/${charId}`;
            const response = await fetchWithProxy(detailUrl, { signal: fetchSignal });
            const detailData = await response.json();
            if (fetchSignal.aborted || wyvernSelectedChar !== char) {
                debugLog('[Wyvern] Detail fetch completed but modal moved on; discarding');
            } else {
                const galleryImages = Array.isArray(detailData.gallery) && detailData.gallery.length > 0
                    ? detailData.gallery.map(img => ({ url: img.imageURL, title: img.title || '', id: img.id }))
                    : null;
                const stripped = {
                    description: detailData.description,
                    personality: detailData.personality,
                    scenario: detailData.scenario,
                    mes_example: detailData.mes_example,
                    first_mes: detailData.first_mes,
                    creator_notes: detailData.creator_notes,
                    alternate_greetings: getWyvernAltGreetings(detailData),
                    galleryImages,
                };
                while (wyvernDetailCache.size >= WYVERN_DETAIL_CACHE_MAX) {
                    const oldestKey = wyvernDetailCache.keys().next().value;
                    wyvernDetailCache.delete(oldestKey);
                }
                wyvernDetailCache.set(charId, stripped);
                applyDetailData(stripped);
            }
        } catch (e) {
            if (e.name === 'AbortError') {
                debugLog('[Wyvern] Detail fetch aborted (modal closed)');
            } else {
                debugLog('[Wyvern] Could not fetch detailed character info:', e.message);
                if (wyvernSelectedChar === char) {
                    // Fall back so the creator-notes skeleton doesnt sit forever.
                    setWyvernCreatorNotes(char.creator_notes || char.tagline);
                    // No def data arriving: collapse skeletons.
                    descSection.hidden = true;
                    personalitySection.hidden = true;
                    scenarioSection.hidden = true;
                    examplesSection.hidden = true;
                    firstMsgSection.hidden = true;
                    if (defLoading) {
                        defLoading.innerHTML = definitionFailedNotice('It can still be imported with basic info.');
                        defLoading.hidden = false;
                    }
                    const gs = document.getElementById('wyvernCharGallerySection');
                    if (gs) gs.hidden = true;
                }
            }
        }
    } else if (!cachedDetail) {
        // No fetch path: resolve from the slim data.
        setWyvernCreatorNotes(char.creator_notes || char.tagline);
    }
}

function cleanupWyvernCharModal() {
    BrowseView.closeAvatarViewer();
    CoreAPI.setBrowseAltGreetings(null);

    const defLoading = document.getElementById('wyvernCharDefinitionLoading');
    if (defLoading) { defLoading.hidden = true; defLoading.innerHTML = '<div class="browse-status-note"><i class="fa-solid fa-spinner fa-spin"></i> Loading character definition...</div>'; }

    const modal = document.getElementById('wyvernCharModal');
    if (modal) {
        modal.querySelectorAll('[data-full-content]').forEach(el => {
            delete el.dataset.fullContent;
        });

        const sectionIds = [
            'wyvernCharAltGreetings',
            'wyvernCharDescription',
            'wyvernCharPersonality',
            'wyvernCharScenario',
            'wyvernCharFirstMsg',
            'wyvernCharTagline',
            'wyvernCharGalleryGrid',
        ];
        for (const id of sectionIds) {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        }

        const creatorNotesEl = document.getElementById('wyvernCharCreatorNotes');
        cleanupCreatorNotesContainer(creatorNotesEl);
    }
    wyvernSelectedChar = null;
}

// ========================================
// WYVERN CHARACTER DOWNLOAD (import)
// ========================================

async function downloadWyvernCharacter() {
    const hit = wyvernSelectedChar;
    if (!hit) return;
    abortWyvernDetailFetch();
    const charId = hit.id;
    // the dupe check probes the STORED name (chat_name), not the listing title, or clones slipped past it
    const characterName = getWyvernCharName(hit);
    const characterCreator = hit.creator?.displayName || hit.creator?.username || '';
    const cachedDetail = wyvernDetailCache.get(charId);
    await view.importFromPreview({
        button: document.getElementById('wyvernDownloadBtn'), hit, provider: 'wyvern', id: charId, data: hit, label: 'Wyvern',
        closePreview: closeWyvernCharPreview,
        probe: {
            name: characterName, creator: characterCreator, fullPath: charId,
            description: cachedDetail?.description || hit.description || '',
            first_mes: cachedDetail?.first_mes || hit.first_mes || '',
            personality: cachedDetail?.personality || hit.personality || '',
            scenario: cachedDetail?.scenario || hit.scenario || '',
        },
        dialog: { name: characterName, creator: characterCreator, fullPath: charId, avatarUrl: getAvatarUrl(hit) },
    });
}

// Expose for provider's openPreview() and auth
window.openWyvernCharPreview = openWyvernCharPreview;
window.openWyvernLoginModal = openWyvernLoginModal;

const wyvernBrowseView = new WyvernBrowseView();
export default wyvernBrowseView;

// ========================================
// CREATOR DOWNLOADS ADAPTER
// ========================================

registerCdAdapter('wyvern', {
    async fetchAll(view) {
        const uid = view._cdRef?.uid;
        if (!uid) return [];
        const headers = getWyvernHeaders(wyvernNsfwEnabled && !!wyvernToken);
        const resp = await fetchWithProxy(`${WYVERN_API_BASE}/characters/user/${uid}`, { method: 'GET', headers });
        if (!resp.ok) throw new Error(`API error: ${resp.status}`);
        const data = await resp.json();
        const nodes = data.characters || data.results || [];
        const results = [];
        const seen = new Set();
        for (const node of nodes) {
            if (!node.id || seen.has(node.id)) continue;
            seen.add(node.id);
            results.push({ key: node.id, name: getWyvernCharName(node), creator: node.creator?.displayName || node.creator?.username || '', raw: node });
        }
        return results;
    },
    async importOne(view, card) {
        const provider = CoreAPI.getProvider('wyvern');
        if (!provider?.importCharacter) return { ok: false, error: 'Provider not available' };
        const node = card.raw;
        const result = await importThroughCommand(provider, node.id, node, {});
        if (!result.success) return { ok: false, error: result.error || 'Import failed' };
        return view.creatorImportAnswer(result, provider);
    },
});
