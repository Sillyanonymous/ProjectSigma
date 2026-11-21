
import {
    BrowseView, registerCdAdapter, cdCharId,
    featureFilterState, renderFeatureFilterItems, countActiveFeatures,
    activeFeatureRows, featurePasses, updateNsfwToggleButton, browseCardImageWidth, applyTagsClamp, cardTagsHtml,
    renderViewToggle, tagStateButtonHtml, libraryFeatureRows, libraryBadgeHtml, libraryCardClass,
    syncSortStandIn, CREATOR_SORT_STANDIN, setFilterCount,
} from '../browse-view.js';
import CoreAPI from '../../core-api.js';
import { janitoraiSessionStatus } from '../janitor-session.js';
import { IMG_PLACEHOLDER, formatNumber, BROWSE_PURIFY_CONFIG, skeletonLines, hideSections, deferRender, deferCall, isMobileMode, importThroughCommand, renderBrowseError, buildProviderNotice, definitionFailedNotice } from '../provider-utils.js';
import {
    HAMPTER_PAGE_SIZE,
    HAMPTER_SORTS,
    fetchJanitoraiCharacters,
    fetchJanitoraiCharacter,
    fetchJanitoraiTags,
    fetchJanitoraiFollowing,
    setJanitoraiFollow,
    searchJanitoraiCreators,
    resolveJanitoraiTagIds,
    resolveJanitoraiAvatarUrl,
    janitoraiCharacterUrl,
    hasHiddenDefinition,
    isLockedNoProxy,
    hydrateJanitoraiScripts,
    extractCharacterBookFromScripts,
    hasBrowserEndpoint,
    getBrowserMode,
    getBrowserEndpoint,
    extractViaBrowser,
    recoverViaBrowser,
    recoverPhaseLabel,
    recoverProgressText,
    fetchExtractionLane,
    stripHtml,
    decodeHtmlEntities,
    tagKey,
    pingHampterQueue,
} from './janitorai-api.js';

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
    debounce,
    renderSkeletonGrid,
} = CoreAPI;

// ========================================
// STATE
// ========================================

let jaCharacters = [];
let jaCurrentPage = 1;
let jaTotalPages = 0;
let jaHasMore = true;
let jaIsLoading = false;
let jaLoadToken = 0;
// The token check discards a late response; only this stops the request itself.
let jaFetchController = null;
let jaCurrentSearch = '';
let jaNsfwEnabled = false;
let jaSortMode = 'popular';
let jaSelectedChar = null;
let jaGridRenderedCount = 0;
let jaMode = 'browse';

// all excludes, each reloading; a row's is_proxy_enabled is believable (its showdefinition is not), so only the preview confirms a lock
const JA_FEATURE_FILTERS = [
    ...libraryFeatureRows('janitorai', () => view, isCharPossibleMatchObj),
    { key: 'hideNoProxy', id: 'janitoraiFilterHideNoProxy', section: 'definitions', icon: 'fa-lock', label: 'Hide No-Proxy Characters',
      labelTitle: 'Creators who turn off proxy access make a locked definition unrecoverable by the normal extraction.',
      exclude: (hit) => hit?.is_proxy_enabled === false },
];
const jaFeatureState = featureFilterState(JA_FEATURE_FILTERS);

const JA_FILTER_SECTIONS = [
    { key: 'library', title: 'Library:' },
    { key: 'definitions', title: 'Definitions:', noHr: true },
];
/** @type {Set<number>} */
let jaIncludeTags = new Set();
/** @type {Set<number>} */
let jaExcludeTags = new Set();
/** @type {{id: string, name: string}|null} */
let jaCreatorFilter = null;
// Set when a creator is opened from the Following manager, so clearing lands back there.
let jaFollowingCurrentCreator = false;
/** @type {Array<{id:string,name:string,avatar:string}>} */
let jaFollowed = [];
let jaFollowedLoaded = false;
/** @type {Array<{id:number,name:string,slug:string}>} */
let jaTagCatalogue = [];

let view;

// the server's extraction lane, read while one of this tab's extracting imports runs so its row can say where it sits
let jaLane = [];                  // the account's lane as the server lists it, fresh while one of ours extracts
let jaLaneWatch = 0;              // the lane poll, 0 while nothing of ours is extracting
let jaLaneBusy = false;           // the last lane read: something running or queued on it
let jaLaneBusyRead = null;        // the lane read in flight, which every move asks for meanwhile joins
let jaLaneBusyAgain = false;      // a move landed during it: read once more after it
let jaImportBtnArgs = null;       // the last setImportButtonState call, replayed when the state moves
let jaNoticeArgs = null;          // the last setHiddenNotice call, replayed the same way

// ========================================
// LOCAL LIBRARY LOOKUP
// ========================================

function isCharPossibleMatchObj(hit) {
    if (view.isHitInLibrary(hit)) return false;
    return view.isHitPossibleMatch(hit);
}

// ========================================
// CARD RENDERING
// ========================================

function createCard(hit) {
    const name = hit.name || 'Unknown';
    const desc = stripHtml(hit.description) || '';
    // Cards render small, so request a sized avatar variant, not the full-size original.
    const avatarUrl = resolveJanitoraiAvatarUrl(hit, { width: browseCardImageWidth() }) || '/img/no-portrait.png';
    const tags = (hit.tags || []).map(t => t.name).filter(Boolean);
    const charId = hit.character_id || '';
    const creatorName = hit.creator_name || '';
    const inLibrary = view.isHitInLibrary(hit);
    const possibleTier = inLibrary ? null : view.possibleMatchTierFor(hit);

    const badges = [];
    const importing = view.importingBadge(hit);
    if (importing) badges.push(importing);
    const libraryBadge = libraryBadgeHtml(inLibrary, possibleTier);
    if (libraryBadge) badges.push(libraryBadge);

    const createdDate = hit.created_at ? new Date(hit.created_at).toLocaleDateString() : '';
    const dateInfo = createdDate ? `<span class="browse-card-date"><i class="fa-solid fa-clock"></i> ${createdDate}</span>` : '';
    const cardClass = libraryCardClass(inLibrary, possibleTier);

    return `
        <div class="${cardClass}" data-janitorai-id="${escapeHtml(charId)}"${view.linkKeyAttr(hit)}${view.matchAttr(hit)} ${desc ? `title="${escapeHtml(desc.slice(0, 300))}"` : ''}>
            <div class="browse-card-image">
                <img data-src="${escapeHtml(avatarUrl)}" src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" decoding="async" fetchpriority="low" onerror="this.dataset.failed='1';this.src='/img/no-portrait.png'">
                ${badges.length ? `<div class="browse-feature-badges">${badges.join('')}</div>` : ''}
                ${hit.is_nsfw ? '<span class="browse-nsfw-badge">NSFW</span>' : ''}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(name)}</div>
                ${creatorName ? `<span class="browse-card-creator-link" data-creator-id="${escapeHtml(hit.creator_id || '')}" data-creator-name="${escapeHtml(creatorName)}" title="Click to see all characters by ${escapeHtml(creatorName)}">${escapeHtml(creatorName)}</span>` : ''}
                ${cardTagsHtml(tags)}
            </div>
            <div class="browse-card-footer">
                <span class="browse-card-stat" title="Chats"><i class="fa-solid fa-comments"></i> ${formatNumber(hit.chat_count || 0)}</span>
                <span class="browse-card-stat" title="Messages"><i class="fa-solid fa-envelope"></i> ${formatNumber(hit.message_count || 0)}</span>
                ${dateInfo}
            </div>
        </div>
    `;
}

// ========================================
// GRID RENDERING
// ========================================

function renderGrid(characters, append = false) {
    const grid = document.getElementById(activeGridId());
    if (!grid) return;

    if (!append) {
        grid.innerHTML = '';
        jaGridRenderedCount = 0;
    }

    const startIdx = jaGridRenderedCount;
    grid.insertAdjacentHTML('beforeend', characters.slice(startIdx).map(createCard).join(''));
    jaGridRenderedCount = characters.length;

    view.observeImages(grid);
    updateLoadMore();
}

function updateLoadMore() {
    view.updateLoadMoreVisibility(activeLoadMoreId(), jaHasMore, jaCharacters.length > 0);
}

// ========================================
// LOAD
// ========================================

// Exclude tags with no numeric id are filtered client-side.
let jaUnresolvedExcludes = [];

async function resolvePersistentExcludes() {
    const names = view.persistentExcludeTags();
    if (!names.length) {
        jaUnresolvedExcludes = [];
        return [];
    }
    const { ids, unresolved } = await resolveJanitoraiTagIds(names);
    jaUnresolvedExcludes = unresolved.map(n => tagKey(n));
    return ids;
}

function passesClientFilters(hit) {
    if (!featurePasses(hit, activeFeatureRows(JA_FEATURE_FILTERS, jaFeatureState))) return false;
    // the following feed takes no tag params, so the picked tags apply here, by id as the browse request sends them
    if (jaMode === 'following' && (jaIncludeTags.size || jaExcludeTags.size)) {
        const ids = new Set((hit.tags || []).map(t => t.id));
        if ([...jaIncludeTags].some(id => !ids.has(id)) || [...jaExcludeTags].some(id => ids.has(id))) return false;
    }
    if (jaUnresolvedExcludes.length) {
        // tagKey on both sides: hampter catalogue names carry an emoji prefix ("👨 Male")
        const names = (hit.tags || []).map(t => tagKey(t.name));
        if (jaUnresolvedExcludes.some(ex => names.includes(ex))) return false;
    }
    return true;
}

// the waiting room's spot lives in a cookie that dies after 2 minutes of silence: poll at its 20s cadence, same transport
let jaQueueWatchTimer = null;
let jaQueueWatchUntil = 0;
let jaQueueWatchSince = 0;

function renderQueueBanner(grid, err, waitMinutes, { expired = false } = {}) {
    if (!grid) return;
    const elapsedMin = jaQueueWatchSince ? Math.floor((Date.now() - jaQueueWatchSince) / 60_000) : 0;
    const waited = elapsedMin >= 1 ? ` Waiting ${elapsedMin} minute${elapsedMin === 1 ? '' : 's'} so far.` : '';
    // Verified live: during maintenance holds the estimate sits still and nobody is admitted.
    const stalled = !expired && Number.isFinite(waitMinutes) && elapsedMin >= waitMinutes + 3
        ? ' Their estimate has not held, so this looks like full maintenance; the watch stays on and gets you in the moment they reopen.'
        : '';
    const est = !expired && Number.isFinite(waitMinutes)
        ? ` JanitorAI currently estimates about ${waitMinutes} minute${waitMinutes === 1 ? '' : 's'}.`
        : '';
    renderBrowseError(grid, {
        provider: 'janitorai',
        error: err,
        title: 'JanitorAI queue is active',
        message: expired
            ? `JanitorAI's waiting room is still up after ${elapsedMin} minutes, so automatic checking stopped. Press Retry to check again (it re-enters the queue).`
            : `JanitorAI put visitors in a waiting room (high load or maintenance). Project Σ is holding your place in the queue and checks every 20 seconds; the grid loads by itself the moment you are through.${est}${waited}${stalled}`,
        view: jaMode,
        flags: { nsfw: jaNsfwEnabled, following: jaMode === 'following', managedBrowser: getBrowserMode() === 'managed', hasEndpoint: !!getBrowserEndpoint() },
        retry: () => view.reload({ force: true }),
    });
}

function startQueueWatch() {
    if (jaQueueWatchTimer) return;
    jaQueueWatchUntil = Date.now() + 30 * 60_000;
    if (!jaQueueWatchSince) jaQueueWatchSince = Date.now();
    const tick = async () => {
        jaQueueWatchTimer = null;
        if (!delegatesInitialized) return;
        if (Date.now() > jaQueueWatchUntil) {
            const grid = document.getElementById(activeGridId());
            if (!jaIsLoading && grid?.querySelector('.browse-error-banner')) {
                renderQueueBanner(grid, new Error('JanitorAI waiting room still active when the watch cap expired'), null, { expired: true });
            }
            return;
        }
        const res = await pingHampterQueue();
        if (!delegatesInitialized) return;
        if (res.through) { jaQueueWatchSince = 0; view.reload(); return; }
        // Refresh the on-banner estimate while still queued (skip if a load replaced the banner).
        const grid = document.getElementById(activeGridId());
        if (!jaIsLoading && grid?.querySelector('.browse-error-banner')) {
            renderQueueBanner(grid, res.error, res.waitMinutes);
        }
        jaQueueWatchTimer = setTimeout(tick, 20_000);
    };
    jaQueueWatchTimer = setTimeout(tick, 20_000);
}

function stopQueueWatch() {
    if (jaQueueWatchTimer) { clearTimeout(jaQueueWatchTimer); jaQueueWatchTimer = null; }
}

async function loadCharacters(append = false) {
    if (append && jaIsLoading) return;
    stopQueueWatch();
    const thisToken = ++jaLoadToken;
    jaIsLoading = true;
    try { jaFetchController?.abort(); } catch { /* already settled */ }
    jaFetchController = new AbortController();
    const signal = jaFetchController.signal;

    const grid = document.getElementById(activeGridId());
    const loadMoreBtn = document.getElementById(jaMode === 'following' ? 'janitoraiFollowingLoadMoreBtn' : 'janitoraiLoadMoreBtn');

    if (!append) {
        jaCurrentPage = 1;
        // Reset here so the previous query cannot repaint under a new filter.
        jaCharacters = [];
        jaGridRenderedCount = 0;
        if (grid) renderSkeletonGrid(grid);
    }
    if (loadMoreBtn) {
        loadMoreBtn.disabled = true;
        loadMoreBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
    }

    try {
        const following = jaMode === 'following';
        // signed out, the site answers a following ask with its general feed; say so instead of showing strangers
        if (following && !janitoraiSessionStatus()?.loggedIn) {
            jaCharacters = [];
            jaHasMore = false;
            if (!append) renderEmptyFollowing(grid, { signedOut: true });
            return;
        }
        const creatorIds = (!following && jaCreatorFilter) ? [jaCreatorFilter.id] : [];

        // The following feed takes no tag params, so excludes apply client-side by name.
        const excludeTagIds = following ? [] : await resolvePersistentExcludes();
        if (following) jaUnresolvedExcludes = view.persistentExcludeTags().map(n => tagKey(n));
        if (thisToken !== jaLoadToken) return;

        const data = await fetchJanitoraiCharacters({
            signal,
            following,
            sort: jaSortMode,
            page: jaCurrentPage,
            search: jaCurrentSearch,
            mode: jaNsfwEnabled ? 'all' : 'sfw',
            tagIds: [...jaIncludeTags],
            excludeTagIds: [...new Set([...jaExcludeTags, ...excludeTagIds])],
            creatorIds,
        });

        if (thisToken !== jaLoadToken || !delegatesInitialized) return;

        // Nobody followed reads as an empty feed; say so instead of "no characters found".
        if (following && !data.total && !append) {
            jaCharacters = [];
            jaHasMore = false;
            renderEmptyFollowing(grid);
            return;
        }

        await view.probeHits(data.characters);
        let hits = data.characters.filter(passesClientFilters);
        jaTotalPages = data.total > 0 ? Math.ceil(data.total / (data.pageSize || HAMPTER_PAGE_SIZE)) : 0;

        // Client filters can empty a page, so pull a few more while pages remain.
        let autoFetches = 0;
        while (hits.length < 12 && jaCurrentPage < jaTotalPages && autoFetches < 3 && delegatesInitialized) {
            autoFetches++;
            jaCurrentPage++;
            const more = await fetchJanitoraiCharacters({
                signal,
                following,
                sort: jaSortMode,
                page: jaCurrentPage,
                search: jaCurrentSearch,
                mode: jaNsfwEnabled ? 'all' : 'sfw',
                tagIds: [...jaIncludeTags],
                excludeTagIds: [...new Set([...jaExcludeTags, ...excludeTagIds])],
                creatorIds,
            });
            if (thisToken !== jaLoadToken || !delegatesInitialized) return;
            await view.probeHits(more.characters);
            hits = hits.concat(more.characters.filter(passesClientFilters));
        }

        if (append) {
            const seen = new Set(jaCharacters.map(c => c.character_id));
            jaCharacters = jaCharacters.concat(hits.filter(h => !h.character_id || !seen.has(h.character_id)));
        } else {
            jaCharacters = hits;
        }
        jaHasMore = jaCurrentPage < jaTotalPages;
        jaQueueWatchSince = 0;

        renderGrid(jaCharacters, append);

        if (!append && jaCharacters.length === 0 && grid) {
            grid.innerHTML = `
                <div class="browse-empty-state">
                    <i class="fa-solid fa-ghost browse-empty-icon"></i>
                    <p class="browse-empty-title">No characters found</p>
                    <p class="browse-empty-text">Try a different search term or relax your tag filters.</p>
                </div>
            `;
        }

        debugLog('[JanitoraiBrowse] Loaded', hits.length, 'characters, page', jaCurrentPage, '/', jaTotalPages);
    } catch (err) {
        if (thisToken !== jaLoadToken) return;
        // A cancellation is not a failure, so do not show an error banner.
        if (err?.name === 'AbortError') return;
        console.error('[JanitoraiBrowse] Load error:', err);
        handleLoadError(err, append, grid);
    } finally {
        if (thisToken === jaLoadToken) {
            jaIsLoading = false;
            if (loadMoreBtn) {
                loadMoreBtn.disabled = false;
                loadMoreBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More';
            }
        }
    }
}

function handleLoadError(err, append, grid) {
    const code = err?.code;
    // Before the code branches: waiting-room errors carry HAMPTER_BLOCKED and would hit the
    // Cloudflare copy below.
    if (/waiting room/i.test(err?.message || '')) {
        startQueueWatch();
        if (append) {
            jaCurrentPage = Math.max(1, jaCurrentPage - 1);
            showToast('JanitorAI queue is active. Holding your place; the grid refreshes once you are through.', 'info', 8000);
            return;
        }
        renderQueueBanner(grid, err, err?.queueWaitMinutes);
        return;
    }
    const gated = code === 'HAMPTER_LOGIN_REQUIRED' || code === 'HAMPTER_TOKEN_EXPIRED';

    if (gated && append) {
        // Anonymous access stops after page 1; end pagination cleanly rather than erroring.
        jaCurrentPage = Math.max(1, jaCurrentPage - 1);
        jaTotalPages = jaCurrentPage;
        jaHasMore = false;
        updateLoadMore();
        showToast(code === 'HAMPTER_TOKEN_EXPIRED'
            ? 'Your JanitorAI session expired. Re-paste your token in Settings to keep browsing.'
            : 'JanitorAI serves only the first page without a login. Add your JanitorAI session in Settings for more.', 'info', 7000);
        return;
    }
    if (code === 'HAMPTER_RATE_LIMITED' && append) {
        jaCurrentPage = Math.max(1, jaCurrentPage - 1);
        showToast('JanitorAI is rate limiting. Give it a moment, then load more.', 'warning', 6000);
        return;
    }
    if (code === 'HAMPTER_BLOCKED' && append) {
        jaCurrentPage = Math.max(1, jaCurrentPage - 1);
        showToast(err?.browserError
            ? 'The browser endpoint did not answer, so this page could not load. Check it under Settings > Online > Hosted Browser and press Test.'
            : 'Cloudflare blocked this page load. Check the browser under Settings > Online > Hosted Browser: press Test there, then Check janitorai.com under JanitorAI, to see what is failing.', 'warning', 6000);
        return;
    }

    if (code === 'HAMPTER_RATE_LIMITED') {
        showToast('JanitorAI is rate limiting. Wait a moment and try again.', 'warning', 7000);
        if (!append && grid) grid.innerHTML = '';
        return;
    }

    if (!append && grid) {
        if (gated) {
            const expired = code === 'HAMPTER_TOKEN_EXPIRED';
            grid.innerHTML = `
                <div class="browse-empty-state is-narrow">
                    <i class="fa-solid fa-user-lock browse-empty-icon is-warn"></i>
                    <p class="browse-empty-lead"><strong>${expired ? 'Your JanitorAI session expired' : 'JanitorAI requires an account for this request'}</strong></p>
                    <p class="browse-empty-text">Add your JanitorAI session in Settings &gt; Online &gt; JanitorAI to browse past the first page.</p>
                </div>
            `;
            return;
        }
        // Surface the browser-endpoint failure, not the direct-leg fallback's Cloudflare 403.
        const endpointDown = !!err?.browserError;
        const noBrowser = code === 'HAMPTER_BLOCKED' && !hasBrowserEndpoint();
        renderBrowseError(grid, {
            provider: 'janitorai',
            error: err,
            title: endpointDown ? 'Could not reach the browser' : (noBrowser ? 'JanitorAI needs a browser' : undefined),
            message: endpointDown
                ? `The browser endpoint in Settings did not answer (${err.browserError}), so this fell back to a direct request, which Cloudflare refused. Start the built-in browser or fix the endpoint, then press Test.`
                : noBrowser
                    ? 'Cloudflare refuses every request that is not a real browser. Start the built-in browser under Settings > Online > Hosted Browser, or point Project Σ at one you run yourself.'
                    : `Load failed: ${err.message}`,
            view: jaMode,
            flags: { nsfw: jaNsfwEnabled, following: jaMode === 'following', managedBrowser: getBrowserMode() === 'managed', hasEndpoint: !!getBrowserEndpoint() },
            guide: (endpointDown || noBrowser)
                ? { label: 'How the JanitorAI browser works', section: 'online/janitorai' }
                : undefined,
            retry: () => view.reload({ force: true }),
        });
        return;
    }
    showToast(`JanitorAI load failed: ${err.message}`, 'error');
}

function renderEmptyFollowing(grid, { signedOut = false } = {}) {
    if (!grid) return;
    grid.innerHTML = signedOut ? `
        <div class="browse-empty-state is-narrow">
            <i class="fa-solid fa-user-lock browse-empty-icon is-warn"></i>
            <p class="browse-empty-lead"><strong>Following needs your JanitorAI session</strong></p>
            <p class="browse-empty-text">Add your JanitorAI session in Settings &gt; Online &gt; JanitorAI to see new characters from the creators you follow.</p>
        </div>
    ` : `
        <div class="browse-empty-state">
            <i class="fa-solid fa-user-group browse-empty-icon"></i>
            <p class="browse-empty-title">You are not following anyone</p>
            <p class="browse-empty-text">Follow creators on janitorai.com, or use the manager below to add them.</p>
        </div>
    `;
    updateLoadMore();
}

async function loadFollowedCreators() {
    try {
        jaFollowed = await fetchJanitoraiFollowing();
        jaFollowedLoaded = true;
    } catch (e) {
        jaFollowed = [];
        jaFollowedLoaded = false;
        debugLog('[JanitoraiBrowse] following fetch failed:', e.message);
        throw e;
    }
}

// ========================================
// PREVIEW MODAL
// ========================================

let jaDetailToken = 0;
let jaDetailPromise = null;
// What the notes pane currently shows, so the detail only re-renders when it has more.
let jaPaintedNotes = '';

const MODAL_TEXT_IDS = [
    'janitoraiCharDescription',
    'janitoraiCharScenario',
    'janitoraiCharFirstMsg',
    'janitoraiCharExamples',
    'janitoraiCharAltGreetings',
    'janitoraiCharTags',
];

function openPreviewModal(hit) {
    jaSelectedChar = hit;

    const modal = document.getElementById('janitoraiCharModal');
    if (!modal) return;
    // the import button, kept in step with the library while the preview is open: the last
    // stamp's phase replayed over a fresh in-library read
    view.trackPreview(() => {
        if (jaSelectedChar !== hit || !jaImportBtnArgs) return;
        const inLibraryNow = view.isHitInLibrary(hit);
        setImportButtonState(inLibraryNow, !inLibraryNow && view.isHitPossibleMatch(hit), jaImportBtnArgs[2]);
    }, hit);
    CoreAPI.resetBrowseSectionCollapseState(modal);

    const name = hit.name || 'Unknown';
    const charId = hit.character_id || hit.id || '';
    const avatarUrl = resolveJanitoraiAvatarUrl(hit) || '/img/no-portrait.png';
    const inLibrary = view.isHitInLibrary(hit);
    const possibleMatch = !inLibrary && view.isHitPossibleMatch(hit);

    const avatarImg = document.getElementById('janitoraiCharAvatar');
    BrowseView.setPreviewPortrait(avatarImg, avatarUrl);
    document.getElementById('janitoraiCharName').textContent = name;
    const creatorEl = document.getElementById('janitoraiCharCreator');
    creatorEl.textContent = hit.creator_name || 'Unknown';
    creatorEl.dataset.creatorId = hit.creator_id || '';
    document.getElementById('janitoraiOpenInBrowserBtn').href = janitoraiCharacterUrl(charId, name);

    document.getElementById('janitoraiCharChats').textContent = formatNumber(hit.chat_count || 0);
    document.getElementById('janitoraiCharMessages').textContent = formatNumber(hit.message_count || 0);
    document.getElementById('janitoraiCharDate').textContent = hit.created_at
        ? new Date(hit.created_at).toLocaleDateString()
        : 'Unknown';
    setTokenStat(hit.total_tokens || 0);
    setHiddenNotice(null);

    const tagsEl = document.getElementById('janitoraiCharTags');
    tagsEl.innerHTML = (hit.tags || []).map(t => `<span class="browse-tag">${escapeHtml(t.name || '')}</span>`).join('');
    // After paint: the clamp measures offsetTop, which is meaningless until layout has run.
    requestAnimationFrame(() => applyTagsClamp(tagsEl));

    // Paint from the listing row so the section is not empty while the detail loads.
    const rawDescription = hit.description || '';
    jaPaintedNotes = rawDescription;
    const notesSection = document.getElementById('janitoraiCharCreatorNotesSection');
    const notesEl = document.getElementById('janitoraiCharCreatorNotes');
    if (rawDescription.trim()) {
        notesSection.hidden = false;
        if (notesEl && !notesEl.querySelector('iframe')) notesEl.innerHTML = skeletonLines(3);
        deferCall(notesEl, () => renderCreatorNotesSecure(rawDescription, name, notesEl));
    } else {
        notesSection.hidden = true;
        if (notesEl) notesEl.innerHTML = '';
    }

    for (const [sectionId, elId, lines] of [
        ['janitoraiCharDescriptionSection', 'janitoraiCharDescription', 3],
        ['janitoraiCharScenarioSection', 'janitoraiCharScenario', 2],
        ['janitoraiCharFirstMsgSection', 'janitoraiCharFirstMsg', 4],
        ['janitoraiCharExamplesSection', 'janitoraiCharExamples', 3],
    ]) {
        const section = document.getElementById(sectionId);
        const el = document.getElementById(elId);
        if (section && el) { section.hidden = false; el.innerHTML = skeletonLines(lines); }
    }
    const altSection = document.getElementById('janitoraiCharAltGreetingsSection');
    if (altSection) altSection.hidden = true;
    // Reset or a card whose detail fetch fails shows the previous card's lorebook.
    const loreSection = document.getElementById('janitoraiCharLorebookSection');
    if (loreSection) loreSection.hidden = true;
    // Reset the detail-driven stat chips too, or a failed fetch keeps the previous counts.
    hideSections(['janitoraiCharGreetingsStat', 'janitoraiCharLorebookStat']);

    setImportButtonState(inLibrary, possibleMatch, 'pending');

    modal.classList.remove('hidden');
    const body = modal.querySelector('.browse-char-body');
    if (body) body.scrollTop = 0;

    const token = ++jaDetailToken;
    jaDetailPromise = fetchAndPopulateDetails(hit, token);
    // The button says Queue when the lane is busy, and only a browser can extract at all.
    if (hasBrowserEndpoint()) void refreshLaneBusy();
}

// one read in flight and one more after it, however many cards a queue change moves
function refreshLaneBusy() {
    if (jaLaneBusyRead) { jaLaneBusyAgain = true; return jaLaneBusyRead; }
    jaLaneBusyRead = (async () => {
        do {
            jaLaneBusyAgain = false;
            jaLaneBusy = (await fetchExtractionLane()).length > 0;
        } while (jaLaneBusyAgain);
        jaLaneBusyRead = null;
        repaintImportButton();
        repaintHiddenNotice();
    })();
    return jaLaneBusyRead;
}

function repaintImportButton() {
    if (jaImportBtnArgs) setImportButtonState(...jaImportBtnArgs);
}

function repaintHiddenNotice() {
    if (jaNoticeArgs) setHiddenNotice(...jaNoticeArgs);
}

// busy the same way Import reads it: this tab is extracting, or the server has something running or queued
const laneBusy = () => extractionsInFlight().length > 0 || jaLaneBusy;

// needs extracting first: hidden per the detail, a browser configured, nothing recovered into the preview yet
function needsExtraction(hit) {
    const detail = hit?._detail;
    if (!detail || !hasBrowserEndpoint() || !hasHiddenDefinition(detail)) return false;
    return !hit._recoveredDefinition && !hit._recoveredNoProxy;
}

function setImportButtonState(inLibrary, possibleMatch, state = 'ready') {
    const importBtn = document.getElementById('janitoraiImportBtn');
    if (!importBtn) return;
    jaImportBtnArgs = [inLibrary, possibleMatch, state];
    importBtn.title = '';
    if (!inLibrary && view.stampImportInFlight(importBtn, jaSelectedChar)) return;
    if (inLibrary) {
        view.stampImportButton(importBtn, { inLibrary: true });
        return;
    }
    // the DETAIL decides fast path or recovery (the listing's showdefinition lies), so the button waits for it
    if (state === 'pending' || state === 'unavailable') {
        importBtn.innerHTML = state === 'pending'
            ? '<i class="fa-solid fa-spinner fa-spin"></i> Import'
            : '<i class="fa-solid fa-download"></i> Import';
        importBtn.classList.add('cl-btn-primary');
        importBtn.classList.remove('cl-btn-secondary', 'cl-btn-warning');
        importBtn.disabled = true;
        importBtn.title = state === 'pending'
            ? 'Waiting for character details'
            : 'Character details could not be loaded; importing needs the same request';
        return;
    }
    // Queue: another extraction is driving the browser, so this one waits its turn on the
    // server's lane and imports in the background when it comes.
    const queued = needsExtraction(jaSelectedChar) && laneBusy();
    const verb = queued ? 'Queue' : 'Import';
    const icon = queued ? 'fa-clock' : 'fa-download';
    if (possibleMatch) {
        importBtn.innerHTML = `<i class="fa-solid ${icon}"></i> ${verb} (Possible Match)`;
        importBtn.classList.add('cl-btn-warning');
        importBtn.classList.remove('cl-btn-primary', 'cl-btn-secondary');
    } else {
        importBtn.innerHTML = `<i class="fa-solid ${icon}"></i> ${verb}`;
        importBtn.classList.add('cl-btn-primary');
        importBtn.classList.remove('cl-btn-secondary', 'cl-btn-warning');
    }
    if (queued) importBtn.title = 'Another extraction is running; this one waits its turn and imports in the background';
    importBtn.disabled = false;
}

function setTokenStat(total) {
    const el = document.getElementById('janitoraiCharTokens');
    const stat = document.getElementById('janitoraiCharTokensStat');
    if (el) el.textContent = formatNumber(total || 0);
    if (stat) stat.hidden = !total;
}

// tokens: the API's reported size for the withheld definition.
function setHiddenNotice(tokens, noProxy = false) {
    const el = document.getElementById('janitoraiHiddenNotice');
    if (!el) return;
    jaNoticeArgs = [tokens, noProxy];
    if (tokens === null || tokens === undefined) {
        el.hidden = true;
        el.innerHTML = '';
        return;
    }
    const size = tokens ? ` (~${formatNumber(tokens)} tokens)` : '';
    const configured = hasBrowserEndpoint();
    // while something extracts the verb says Queue, so the wait is known before the press
    const busy = configured && laneBusy();
    el.hidden = false;
    // already extracting in the background: say so instead of offering a second extraction
    const onItsWay = view.importInFlight(jaSelectedChar);
    if (onItsWay) {
        el.innerHTML = buildProviderNotice({
            kind: 'info',
            icon: 'fa-solid fa-spinner fa-spin',
            title: `${onItsWay.status === 'running' ? onItsWay.verb : 'Queued'} in the background${size}.`,
            message: 'It lands in your library when done; keep browsing.',
        });
        return;
    }
    // no proxy: only the model's own copy (model output) is left, so this reads as an error, not the amber wait
    if (noProxy) {
        el.innerHTML = buildProviderNotice({
            kind: 'error',
            title: `Locked definition, no proxy${size}.`,
            message: configured
                ? (busy
                    ? 'No proxy access, so only the JanitorAI model can repeat it (not guaranteed exact). Another extraction is running; this one waits its turn.'
                    : 'The creator turned off proxy access, so it cannot be extracted normally. Project Σ can ask the JanitorAI model to repeat it, which usually works but is not guaranteed to be exact.')
                : 'The creator turned off proxy access. Set up a browser in Settings to try recovering it anyway.',
            actions: configured
                ? [busy
                    ? { key: 'tryanyway', label: 'Queue, Try Anyway', icon: 'fa-solid fa-clock' }
                    : { key: 'tryanyway', label: 'Try Anyway', icon: 'fa-solid fa-wand-magic-sparkles' }]
                : [],
        });
        return;
    }
    // No browser means no definition and no greetings, so say so plainly.
    el.innerHTML = buildProviderNotice({
        kind: 'hidden',
        title: `Hidden definition${size}.`,
        message: configured
            ? (busy
                ? 'Another extraction is running; this one waits its turn. Queue it to preview it here, or import it.'
                : 'Importing extracts it first, so it takes longer than usual. Or use the button to preview it now.')
            : 'Set up a browser in Settings to extract it. Importing now gets you no definition and no greetings.',
        actions: configured
            ? [busy
                ? { key: 'recover', label: 'Queue Extraction', icon: 'fa-solid fa-clock' }
                : { key: 'recover', label: 'Extract Now', icon: 'fa-solid fa-unlock' }]
            : [],
    });
}

/**
 * The one owner of a recovery run: only it paints the banner; kind keeps an import alive past a close.
 */
let jaRecoverRun = null;
let jaRecoverSeq = 0;

function startRecoverRun(charId, kind) {
    cancelRecoverRun();
    jaRecoverRun = { id: ++jaRecoverSeq, charId, kind, controller: new AbortController() };
    return jaRecoverRun;
}

function cancelRecoverRun() {
    if (!jaRecoverRun) return;
    CoreAPI.debugLog(`[JanitoraiBrowse] cancelling ${jaRecoverRun.kind} recovery for ${jaRecoverRun.charId}`);
    jaRecoverRun.controller.abort();
    jaRecoverRun = null;
    clearRecoverProgress();
}

/** A run that has been superseded or cancelled must not paint, toast, or write to the preview. */
function isRecoverRunLive(run) {
    return !!run && !!jaRecoverRun && jaRecoverRun.id === run.id;
}

function endRecoverRun(run) {
    if (isRecoverRunLive(run)) jaRecoverRun = null;
}

// Built once, text-only updates, so the spinner doesnt restart on every poll tick.
function setRecoverProgress(text) {
    const host = document.getElementById('janitoraiHiddenNotice');
    if (!host) return;
    const line = text || 'Starting...';
    let bar = document.getElementById('janitoraiRecoverProgress');
    if (!bar) {
        // Swap, dont stack: two banners about one card read as conflicting states.
        for (const n of host.querySelectorAll('.browse-notice')) n.classList.add('cl-hidden');
        const tmp = document.createElement('div');
        // Never seed '': buildProviderNotice drops the <p> entirely, leaving nothing to update.
        tmp.innerHTML = buildProviderNotice({
            kind: 'info',
            icon: 'fa-solid fa-spinner fa-spin',
            title: 'Extracting, this can take a few minutes',
            message: line,
        });
        bar = tmp.firstElementChild;
        if (!bar) return;
        bar.id = 'janitoraiRecoverProgress';
        host.insertBefore(bar, host.firstChild);
        return;
    }
    let msg = bar.querySelector('.browse-notice-message');
    if (!msg) {
        msg = document.createElement('p');
        msg.className = 'browse-notice-message';
        (bar.querySelector('.browse-notice-body') || bar).appendChild(msg);
    }
    msg.textContent = line;
}

function clearRecoverProgress() {
    const bar = document.getElementById('janitoraiRecoverProgress');
    if (!bar) return;
    bar.remove();
    // Restore the notice so a failed run still shows its retry action.
    const host = document.getElementById('janitoraiHiddenNotice');
    if (host) for (const n of host.querySelectorAll('.browse-notice')) n.classList.remove('cl-hidden');
}

// while queued on the server's lane the banner says where it sits; polled every 2s until it runs
function watchLaneWhileQueued(run, charId, onQueued, onRunning) {
    let stopped = false;
    (async () => {
        let wasQueued = false;
        while (!stopped && isRecoverRunLive(run)) {
            const mine = (await fetchExtractionLane()).find(j => j.characterId === String(charId));
            if (stopped || !isRecoverRunLive(run)) return;
            if (mine?.status === 'running') { if (wasQueued) onRunning?.(); return; }
            if (mine) { wasQueued = true; onQueued(mine.position); }
            await new Promise(r => setTimeout(r, 2000));
        }
    })();
    return () => { stopped = true; };
}
const queuedText = (ahead) => `Queued behind ${ahead} extraction${ahead === 1 ? '' : 's'}; it starts when the browser is free.`;

async function recoverDefinitionIntoPreview() {
    const hit = jaSelectedChar;
    const charId = hit?.character_id || hit?.id;
    if (!charId) return;
    const btn = document.querySelector('#janitoraiHiddenNotice [data-notice-action="recover"]');
    const setBtn = (label) => { if (btn) btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${label}`; };
    if (btn) btn.disabled = true;
    setBtn('Extracting...');
    // No phases here, so it stays static; otherwise a multi-minute wait signals only a spinner.
    const runningText = 'Reading the assembled prompt from JanitorAI.';
    setRecoverProgress(runningText);

    const run = startRecoverRun(charId, 'preview');
    const stopWatch = watchLaneWhileQueued(run, charId,
        (ahead) => { setBtn('Waiting...'); setRecoverProgress(queuedText(ahead)); },
        () => { setBtn('Extracting...'); setRecoverProgress(runningText); });
    try {
        // Closing the card aborts this: queued, the server drops it from the lane unrun.
        const rec = await extractViaBrowser(String(charId), undefined, { signal: run.controller.signal });
        // The user can have moved on to another card during the round trip.
        if (!isRecoverRunLive(run)) return;
        endRecoverRun(run);
        clearRecoverProgress();
        if (!rec?.definition) throw new Error('Nothing came back');
        if (jaSelectedChar && (jaSelectedChar.character_id || jaSelectedChar.id) === charId) {
            jaSelectedChar._recoveredDefinition = rec.definition;
            jaSelectedChar._recoveredFirstMessage = rec.firstMessage || '';
        }
        const name = hit.name || 'Unknown';
        populateSectionSecure('janitoraiCharDescriptionSection', 'janitoraiCharDescription', rec.definition, name);
        // The opening line is withheld alongside the definition, so it only appears now.
        if (rec.firstMessage) {
            populateSection('janitoraiCharFirstMsgSection', 'janitoraiCharFirstMsg', rec.firstMessage, name,
                (el, text) => { el.dataset.fullContent = text; });
        }
        setHiddenNotice(null);
        showToast('Definition and greeting recovered', 'success');
    } catch (err) {
        if (err?.name === 'AbortError' || !isRecoverRunLive(run)) return;
        endRecoverRun(run);
        clearRecoverProgress();
        showToast(`Could not extract this character: ${err.message}`, 'error', 8000);
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-unlock"></i> Extract Now'; }
    } finally {
        stopWatch();
    }
}

// the no-proxy sibling of recoverDefinitionIntoPreview: model output, said so here and on the card
async function recoverLockedIntoPreview() {
    const hit = jaSelectedChar;
    const charId = hit?.character_id || hit?.id;
    if (!charId) return;
    const btn = document.querySelector('#janitoraiHiddenNotice [data-notice-action="tryanyway"]');
    const setBtn = (label) => { if (btn) btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${label}`; };
    if (btn) btn.disabled = true;
    setBtn(recoverPhaseLabel('setup'));
    setRecoverProgress(recoverProgressText('setup'));

    const run = startRecoverRun(charId, 'preview');
    // The recovery's own phase poll paints once it runs; only the wait needs a voice.
    const stopWatch = watchLaneWhileQueued(run, charId,
        (ahead) => { setBtn('Waiting...'); setRecoverProgress(queuedText(ahead)); },
        () => { setBtn(recoverPhaseLabel('setup')); setRecoverProgress(recoverProgressText('setup')); });
    try {
        const rec = await recoverViaBrowser(String(charId), undefined, (phase, detail) => {
            if (!isRecoverRunLive(run)) return;
            setBtn(recoverPhaseLabel(phase));
            setRecoverProgress(recoverProgressText(phase, detail));
        }, { signal: run.controller.signal });
        if (!isRecoverRunLive(run)) return;
        endRecoverRun(run);
        clearRecoverProgress();
        if (!rec?.personality) throw new Error('Nothing came back');
        if (jaSelectedChar && (jaSelectedChar.character_id || jaSelectedChar.id) === charId) {
            jaSelectedChar._recoveredNoProxy = rec;
        }
        const name = hit.name || 'Unknown';
        populateSectionSecure('janitoraiCharDescriptionSection', 'janitoraiCharDescription', rec.personality, name);
        if (rec.scenario) populateSection('janitoraiCharScenarioSection', 'janitoraiCharScenario', rec.scenario, name);
        if (rec.exampleDialogs) populateSection('janitoraiCharExamplesSection', 'janitoraiCharExamples', rec.exampleDialogs, name);
        if (rec.firstMessage) {
            populateSection('janitoraiCharFirstMsgSection', 'janitoraiCharFirstMsg', rec.firstMessage, name,
                (el, text) => { el.dataset.fullContent = text; });
        }
        setHiddenNotice(null);
        showToast('Recovered from the model. Check it before relying on it: this is not the creator file.', 'warning', 9000);
    } catch (err) {
        // A cancel is the reader closing the card, which needs no error about it.
        if (err?.name === 'AbortError' || !isRecoverRunLive(run)) return;
        endRecoverRun(run);
        clearRecoverProgress();
        showToast(`Could not recover this character: ${err.message}`, 'error', 8000);
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Try Anyway'; }
    } finally {
        stopWatch();
    }
}

async function fetchAndPopulateDetails(hit, token) {
    const charId = hit.character_id || hit.id || '';
    const name = hit.name || 'Unknown';

    try {
        let detail = null;
        let failCode = '';
        let failBrowserError = '';
        let failClassified = '';
        try {
            detail = await fetchJanitoraiCharacter(charId);
        } catch (e) {
            failCode = e?.code || '';
            failBrowserError = e?.browserError || '';
            // Cloudflare keeps the bespoke press-Test copy below; other classifications (waiting
            // room, proxy disabled) surface verbatim.
            failClassified = (e?.classified && !/^Cloudflare/.test(e.message || '')) ? (e.message || '') : '';
            debugLog('[JanitoraiBrowse] Detail fetch failed:', e.message);
        }
        if (token !== jaDetailToken) return;

        if (!detail) {
            const descSection = document.getElementById('janitoraiCharDescriptionSection');
            const descEl = document.getElementById('janitoraiCharDescription');
            if (descSection && descEl) {
                descSection.hidden = false;
                // Login gating (401) is a separate wall from Cloudflare, not fixed by the browser.
                const gated = failCode === 'HAMPTER_LOGIN_REQUIRED' || failCode === 'HAMPTER_TOKEN_EXPIRED';
                const limited = failCode === 'HAMPTER_RATE_LIMITED';
                const msg = gated
                    ? (failCode === 'HAMPTER_TOKEN_EXPIRED'
                        ? 'Your JanitorAI session expired, so this character\'s details could not be loaded. Sign in again in Settings.'
                        : 'JanitorAI hides this character\'s details from signed-out visitors. Sign in under Settings > Online > JanitorAI to see them.')
                    : limited
                        ? 'JanitorAI is rate limiting. Wait a moment, then reopen this character.'
                        : failClassified
                            ? `${failClassified}.`
                            : failBrowserError
                                ? 'The browser endpoint did not answer, so the definition could not be fetched. Check it under Settings > Online > Hosted Browser and press Test.'
                                : 'Cloudflare blocked the definition fetch. Check the browser under Settings > Online > Hosted Browser: press Test there, then Check janitorai.com under JanitorAI, to see what is failing.';
                descEl.innerHTML = definitionFailedNotice(limited ? '' : 'Importing uses the same request, so it will not work until this does.', msg);
            }
            hideSections(['janitoraiCharScenarioSection', 'janitoraiCharFirstMsgSection', 'janitoraiCharExamplesSection', 'janitoraiCharLorebookSection']);
            setImportButtonState(view.isHitInLibrary(hit), false, 'unavailable');
            return;
        }

        if (jaSelectedChar && (jaSelectedChar.character_id || jaSelectedChar.id) === charId) {
            jaSelectedChar._detail = detail;
        }

        setTokenStat(detail.token_counts?.total_tokens || hit.total_tokens || 0);
        setHiddenNotice(hasHiddenDefinition(detail)
            ? (detail.token_counts?.personality_tokens || 0)
            : null, isLockedNoProxy(detail, hit));
        // The import path branches on the detail (public vs recovery), and it just arrived.
        const inLib = view.isHitInLibrary(hit);
        setImportButtonState(inLib, !inLib && view.isHitPossibleMatch(hit));

        // The listing truncates description, so replace it with the detail's full copy.
        const fullNotes = decodeHtmlEntities(detail.description || '');
        if (fullNotes && fullNotes !== jaPaintedNotes) {
            const notesSection = document.getElementById('janitoraiCharCreatorNotesSection');
            const notesEl = document.getElementById('janitoraiCharCreatorNotes');
            if (notesSection && notesEl) {
                jaPaintedNotes = fullNotes;
                notesSection.hidden = false;
                deferCall(notesEl, () => renderCreatorNotesSecure(fullNotes, name, notesEl));
            }
        }

        // Detail tags are richer than the listing row's, so re-render them.
        const tagsEl = document.getElementById('janitoraiCharTags');
        if (tagsEl) {
            const allTags = [
                ...(detail.tags || []).map(t => t?.name || ''),
                ...(detail.custom_tags || []).map(t => (typeof t === 'string' ? t : t?.name || '')),
            ].filter(Boolean);
            tagsEl.innerHTML = allTags.map(t => `<span class="browse-tag">${escapeHtml(decodeHtmlEntities(t))}</span>`).join('');
            requestAnimationFrame(() => applyTagsClamp(tagsEl));
        }

        populateSectionSecure('janitoraiCharDescriptionSection', 'janitoraiCharDescription', detail.personality, name);
        populateSection('janitoraiCharScenarioSection', 'janitoraiCharScenario', detail.scenario, name);
        populateSection('janitoraiCharFirstMsgSection', 'janitoraiCharFirstMsg', detail.first_message, name, (el, text) => {
            el.dataset.fullContent = text;
        });
        populateSection('janitoraiCharExamplesSection', 'janitoraiCharExamples', detail.example_dialogs, name);
        renderAltGreetings(detail.first_messages, name);

        // hydrate lorebooks AFTER the paint so nothing waits on them; Import then finds them pre-paid
        await hydrateJanitoraiScripts(detail);
        if (token !== jaDetailToken) return;
        renderLorebookSummary(detail);
    } catch (err) {
        debugLog('[JanitoraiBrowse] Detail error:', err);
        if (token === jaDetailToken) {
            const descEl = document.getElementById('janitoraiCharDescription');
            if (descEl) descEl.innerHTML = definitionFailedNotice('Importing uses the same request, so it will not work until this does.');
            setImportButtonState(view.isHitInLibrary(hit), false, 'unavailable');
        }
    }
}


function populateSection(sectionId, elId, text, charName, after) {
    const section = document.getElementById(sectionId);
    const el = document.getElementById(elId);
    if (!section) return;
    if (text && String(text).trim()) {
        section.hidden = false;
        if (el) {
            deferRender(el, () => safePurify(formatRichText(text, charName, true), BROWSE_PURIFY_CONFIG));
            after?.(el, text);
        }
    } else {
        section.hidden = true;
        if (el) el.innerHTML = '';
    }
}

// Definition body renders in the sandboxed iframe so authored card CSS cant restyle the app
function populateSectionSecure(sectionId, elId, text, charName) {
    const section = document.getElementById(sectionId);
    const el = document.getElementById(elId);
    if (!section) return;
    if (text && String(text).trim()) {
        section.hidden = false;
        if (el) {
            if (!el.querySelector('iframe')) el.innerHTML = skeletonLines(3);
            deferCall(el, () => renderCardHtmlSecure(text, charName, el));
        }
    } else {
        section.hidden = true;
        if (el) {
            cleanupCreatorNotesContainer(el);
            el.innerHTML = '';
        }
    }
}

function renderAltGreetings(greetings, charName) {
    const section = document.getElementById('janitoraiCharAltGreetingsSection');
    const listEl = document.getElementById('janitoraiCharAltGreetings');
    const countEl = document.getElementById('janitoraiCharAltGreetingsCount');
    if (!section || !listEl) return;

    // The API pads this with nulls and invisible-char placeholders, so require a letter or digit.
    const clean = (Array.isArray(greetings) ? greetings : [])
        .map(g => (typeof g === 'string' ? g : g?.first_message || g?.message || ''))
        .filter(g => g && /[\p{L}\p{N}]/u.test(g));

    const greetStat = document.getElementById('janitoraiCharGreetingsStat');
    const greetStatCount = document.getElementById('janitoraiCharGreetingsCount');

    if (!clean.length) {
        section.hidden = true;
        listEl.innerHTML = '';
        if (countEl) countEl.textContent = '';
        if (greetStat) greetStat.hidden = true;
        CoreAPI.setBrowseAltGreetings([]);
        return;
    }

    if (greetStat && greetStatCount) {
        greetStatCount.textContent = String(clean.length);
        greetStat.hidden = false;
    }

    const buildPreview = (text) => {
        const cleaned = (text || '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return 'No content';
        return cleaned.length > 90 ? `${cleaned.slice(0, 87)}...` : cleaned;
    };

    section.hidden = false;
    listEl.innerHTML = clean.map((greeting, idx) => `
            <details class="browse-alt-greeting" data-greeting-idx="${idx}">
                <summary>
                    <span class="browse-alt-greeting-index">#${idx + 1}</span>
                    <span class="browse-alt-greeting-preview">${escapeHtml(buildPreview(greeting))}</span>
                    <span class="browse-alt-greeting-chevron"><i class="fa-solid fa-chevron-down"></i></span>
                </summary>
                <div class="browse-alt-greeting-body"></div>
            </details>
        `).join('');

    listEl.querySelectorAll('details.browse-alt-greeting').forEach(details => {
        details.addEventListener('toggle', function onToggle() {
            if (!details.open) return;
            const body = details.querySelector('.browse-alt-greeting-body');
            if (body && !body.dataset.rendered) {
                const idx = parseInt(details.dataset.greetingIdx, 10);
                if (clean[idx] != null) {
                    deferRender(body, () => safePurify(formatRichText(clean[idx], charName, true), BROWSE_PURIFY_CONFIG));
                }
                body.dataset.rendered = '1';
            }
        }, { once: true });
    });

    if (countEl) countEl.textContent = `(${clean.length})`;
    CoreAPI.setBrowseAltGreetings(clean);
}

function renderLorebookSummary(detail) {
    const section = document.getElementById('janitoraiCharLorebookSection');
    const el = document.getElementById('janitoraiCharLorebook');
    if (!section || !el) return;

    const stat = document.getElementById('janitoraiCharLorebookStat');
    const statCount = document.getElementById('janitoraiCharLorebookCount');

    const book = extractCharacterBookFromScripts(detail);
    const listed = (detail.scripts || []).filter(s => s?.type === 'lorebook' && s.is_public);
    if (!book && !listed.length) {
        section.hidden = true;
        el.innerHTML = '';
        if (stat) stat.hidden = true;
        return;
    }

    // Counts lorebooks, not entries; the entry count shows in the section body.
    const bookCount = Math.max(listed.length, book ? 1 : 0);
    if (stat && statCount) {
        statCount.textContent = String(bookCount);
        stat.innerHTML = `<i class="fa-solid fa-book"></i> <span id="janitoraiCharLorebookCount">${bookCount}</span> lorebook${bookCount === 1 ? '' : 's'}`;
        stat.hidden = false;
    }

    section.hidden = false;
    if (!book) {
        el.innerHTML = buildProviderNotice({ kind: 'hidden', message: `${listed.length} lorebook${listed.length === 1 ? '' : 's'} listed, but the creator kept the contents private.` });
        return;
    }
    // Deferred: a large book is a lot of markup and the section is usually collapsed.
    const header = `<div class="janitorai-lorebook-head">${escapeHtml(book.name)} &middot; ${book.entries.length} ${book.entries.length === 1 ? 'entry' : 'entries'}</div>`;
    deferRender(el, () => header + CoreAPI.renderLorebookEntriesHtml(book.entries));
}

function cleanupCharModal() {
    BrowseView.closeAvatarViewer();
    CoreAPI.setBrowseAltGreetings(null);
    for (const id of MODAL_TEXT_IDS) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    }
    const lore = document.getElementById('janitoraiCharLorebook');
    if (lore) lore.innerHTML = '';
    setHiddenNotice(null);
    jaPaintedNotes = '';
    const notesEl = document.getElementById('janitoraiCharCreatorNotes');
    if (notesEl) cleanupCreatorNotesContainer(notesEl);
}

function closePreviewModal() {
    jaDetailToken++;
    jaDetailPromise = null;
    // closing the card stops the preview's own extraction (the server cleans up); an import registers no run and carries on
    cancelRecoverRun();
    cleanupCharModal();
    const modal = document.getElementById('janitoraiCharModal');
    if (modal) modal.classList.add('hidden');
    jaSelectedChar = null;
    view.trackPreview(null);
}

// ========================================
// IMPORT
// ========================================

async function importCharacter(hit) {
    const charId = hit?.character_id || hit?.id;
    if (!charId) return;
    await view.importFromPreview({
        button: document.getElementById('janitoraiImportBtn'), hit, provider: 'janitorai', id: String(charId), label: 'JanitoraiBrowse',
        closePreview: closePreviewModal,
        prepare: async () => {
            // The preview's detail fetch also hydrates the lorebook; wait so import reuses it.
            await jaDetailPromise;
            const detail = hit._detail || null;
            const charName = detail?.chat_name || detail?.name || hit.name || '';
            const charCreator = detail?.creator_name || hit.creator_name || '';
            return {
                data: { _detail: detail },
                probe: {
                    name: charName, creator: charCreator, fullPath: String(charId),
                    description: detail?.personality || '',
                    first_mes: detail?.first_message || '',
                    scenario: detail?.scenario || '',
                    // the public description, which the card builder keeps as the creator notes: a hidden definition still has it
                    creator_notes: detail?.description || '',
                },
                dialog: { name: charName, creator: charCreator, fullPath: String(charId), avatarUrl: resolveJanitoraiAvatarUrl(detail || hit) || '/img/no-portrait.png' },
                name: charName,
            };
        },
        // read after the dialog: a preview Extract Now or Try Anyway may land meanwhile, and its result is reused
        ready: () => ({
            options: {
                definition: hit._recoveredDefinition || '',
                firstMessage: hit._recoveredFirstMessage || '',
                // Model output from the no-proxy path; the builder stamps it so the card says so.
                recovered: hit._recoveredNoProxy || null,
            },
            // an extraction is minutes on the server's lane, so that import goes to the background whatever the setting
            ...(needsExtraction(hit) ? {
                background: true, verb: 'Extracting',
                meta: { charId: String(charId), kind: isLockedNoProxy(hit._detail || null, hit) ? 'recover' : 'extract' },
            } : {}),
        }),
    });
}

// ========================================
// EXTRACTING IMPORTS
// ========================================

// this tab's extracting imports, as the server's lane has them (read every 2s while one runs)
const extractionsInFlight = () => (view ? view.importsInFlight().filter(e => e.meta?.kind) : []);

function laneRowStatus(entry, lane) {
    const onLane = lane.find(j => j.characterId === entry.meta.charId);
    if (onLane?.status === 'running') return entry.meta.kind === 'recover' ? 'Recovering from the model; the result is model output' : 'Extracting the hidden definition';
    if (onLane?.status === 'queued') return `Queued behind ${onLane.position} extraction${onLane.position === 1 ? '' : 's'}`;
    // listed once and gone since: the extraction is done and the card is being imported
    if (entry.meta.seen) return 'Extracted; importing the character';
    return 'Waiting for its turn';
}

function watchLane() {
    if (jaLaneWatch) return;
    const tick = async () => {
        if (!extractionsInFlight().some(e => e.status === 'running')) { jaLaneWatch = 0; jaLane = []; CoreAPI.refreshNotificationsUI(); return; }
        jaLane = await fetchExtractionLane();
        for (const e of extractionsInFlight()) if (jaLane.some(j => j.characterId === e.meta.charId)) e.meta.seen = true;
        CoreAPI.refreshNotificationsUI();
        jaLaneWatch = setTimeout(tick, 2000);
    };
    jaLaneWatch = setTimeout(tick, 0);
}

// every lane move: re-read the server's lane, since the open-time flag still says busy after ours ends
function onImportLaneChanged() {
    if (extractionsInFlight().some(e => e.status === 'running')) watchLane();
    if (hasBrowserEndpoint()) void refreshLaneBusy();
    else { repaintImportButton(); repaintHiddenNotice(); }
}

// ========================================
// TAGS
// ========================================

async function ensureTagCatalogue() {
    if (jaTagCatalogue.length) return jaTagCatalogue;
    const cat = await fetchJanitoraiTags();
    jaTagCatalogue = [...cat].sort((a, b) => a.name.localeCompare(b.name));
    return jaTagCatalogue;
}

function renderTagsList(filter = '') {
    const container = document.getElementById('janitoraiTagsList');
    if (!container) return;

    if (!jaTagCatalogue.length) {
        container.innerHTML = '<div class="browse-tags-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading tags...</div>';
        return;
    }

    const needle = filter.toLowerCase();
    const filtered = needle
        ? jaTagCatalogue.filter(t => t.name.toLowerCase().includes(needle) || t.slug.toLowerCase().includes(needle))
        : jaTagCatalogue;

    if (!filtered.length) {
        container.innerHTML = '<div class="browse-tags-empty">No matching tags</div>';
        return;
    }

    container.innerHTML = filtered.map(tag => {
        const state = jaIncludeTags.has(tag.id) ? 'include' : jaExcludeTags.has(tag.id) ? 'exclude' : 'neutral';
        return `
            <div class="browse-tag-filter-item" data-tag-id="${tag.id}">
                ${tagStateButtonHtml(state)}
                <span class="tag-label">${escapeHtml(tag.name)}</span>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.browse-tag-filter-item').forEach(item => {
        const tagId = Number(item.dataset.tagId);
        item.addEventListener('click', () => {
            // neutral -> include -> exclude -> neutral
            if (jaIncludeTags.has(tagId)) {
                jaIncludeTags.delete(tagId);
                jaExcludeTags.add(tagId);
            } else if (jaExcludeTags.has(tagId)) {
                jaExcludeTags.delete(tagId);
            } else {
                jaIncludeTags.add(tagId);
            }
            renderTagsList(document.getElementById('janitoraiTagsSearchInput')?.value || '');
            updateTagsButton();
            view.reload();
        });
    });
}

function updateTagsButton() {
    const btn = document.getElementById('janitoraiTagsBtn');
    if (!btn) return;
    const count = jaIncludeTags.size + jaExcludeTags.size;
    setFilterCount(btn, 'Tags', count);
}

function updateFiltersButton() {
    const btn = document.getElementById('janitoraiFiltersBtn');
    if (!btn) return;
    const count = countActiveFeatures(JA_FEATURE_FILTERS, jaFeatureState);
    setFilterCount(btn, 'Features', count);
}

function updateNsfwToggle() {
    updateNsfwToggleButton('janitoraiNsfwToggle', jaNsfwEnabled);
}

// ========================================
// MODE / CREATOR FILTER
// ========================================

// Per-mode result cache; stash/restore keeps the live vars pointing at the active mode.
const jaModeCache = { browse: null, following: null };

// A cache entry taken under a different query signature is stale and discarded on restore.
function jaQuerySignature() {
    return JSON.stringify([jaSortMode, jaNsfwEnabled, jaCurrentSearch, jaCreatorFilter?.id || null, [...jaIncludeTags].sort(), [...jaExcludeTags].sort()]);
}

function stashModeState(mode) {
    jaModeCache[mode] = {
        sig: jaQuerySignature(),
        chars: jaCharacters,
        page: jaCurrentPage,
        totalPages: jaTotalPages,
        hasMore: jaHasMore,
        rendered: jaGridRenderedCount,
    };
}

// true when usable cached results were restored.
function restoreModeState(mode) {
    const s = jaModeCache[mode]?.sig === jaQuerySignature() ? jaModeCache[mode] : null;
    jaCharacters = s?.chars || [];
    jaCurrentPage = s?.page || 1;
    jaTotalPages = s?.totalPages || 0;
    jaHasMore = s ? s.hasMore : true;
    jaGridRenderedCount = s?.rendered || 0;
    return !!s?.chars?.length;
}

// wipe per-mode inputs BEFORE the restore so the cache signature matches what the restored grid pages under
function jaEnterMode(mode) {
    jaCurrentSearch = '';
    const searchInput = document.getElementById('janitoraiSearchInput');
    if (searchInput) searchInput.value = '';
    document.getElementById('janitoraiClearSearchBtn')?.classList.add('hidden');
    restoreModeState(mode);
}

function setMode(mode) {
    return view.switchViewMode(mode);
}

// the following feed carries no sort, and its order was never verified, so the label names none
const JA_FOLLOWING_STANDIN = Object.freeze({ label: 'Feed Order', icon: 'fa-solid fa-bars-staggered', title: 'JanitorAI sets this feed\'s order' });

// The mode chrome the base does not own (buttons and sections are its), from jaMode.
function syncModeChrome() {
    // the following feed takes no sort, so its stand-in holds the place; its tags filter what loads (passesClientFilters)
    const following = jaMode === 'following';
    const sortEl = document.getElementById('janitoraiSortSelect');
    // the creator request carries its own sort, so the scope hides the main one too
    (sortEl?._customSelect?.container || sortEl)?.classList.toggle('hidden', following || !!jaCreatorFilter);
    syncSortStandIn(sortEl, following ? JA_FOLLOWING_STANDIN : jaCreatorFilter ? CREATOR_SORT_STANDIN : null, [JA_FOLLOWING_STANDIN, CREATOR_SORT_STANDIN]);
}

function activeGridId() {
    return jaMode === 'following' ? 'janitoraiFollowingGrid' : 'janitoraiGrid';
}

function activeLoadMoreId() {
    return jaMode === 'following' ? 'janitoraiFollowingLoadMore' : 'janitoraiLoadMore';
}

function syncCreatorFollowBtn() {
    const btn = document.getElementById('janitoraiFollowCreatorBtn');
    if (!btn) return;
    // Hide when signed out rather than offer a follow button that can only fail.
    const signedIn = !!janitoraiSessionStatus()?.loggedIn;
    btn.hidden = !(jaCreatorFilter && signedIn);
    btn.disabled = false;
    btn.classList.toggle('following', jaFollowingCurrentCreator);
    btn.innerHTML = jaFollowingCurrentCreator
        ? '<i class="fa-solid fa-heart"></i> <span>Following</span>'
        : '<i class="fa-solid fa-heart"></i> <span>Follow</span>';
    btn.title = jaFollowingCurrentCreator ? 'Unfollow this creator on JanitorAI' : 'Follow this creator on JanitorAI';
}

function syncBannerFollowState(creatorId, following) {
    if (!jaCreatorFilter || jaCreatorFilter.id !== creatorId) return;
    jaFollowingCurrentCreator = following;
    syncCreatorFollowBtn();
}

async function refreshCreatorFollowState() {
    jaFollowingCurrentCreator = false;
    syncCreatorFollowBtn();
    if (!jaCreatorFilter?.id || !janitoraiSessionStatus()?.loggedIn) return;

    const opened = jaCreatorFilter.id;
    if (!jaFollowedLoaded) {
        try { await loadFollowedCreators(); } catch { return; }
    }
    // The user can leave or switch creators while the list is in flight.
    if (jaCreatorFilter?.id !== opened) return;
    jaFollowingCurrentCreator = jaFollowed.some(c => c.id === opened);
    syncCreatorFollowBtn();
}

async function toggleCreatorFollow() {
    if (!jaCreatorFilter?.id) return;
    const btn = document.getElementById('janitoraiFollowCreatorBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
    const next = !jaFollowingCurrentCreator;
    try {
        await setJanitoraiFollow(jaCreatorFilter.id, next);
        jaFollowingCurrentCreator = next;
        jaFollowedLoaded = false;   // the manager list is now stale
        showToast(next ? `Now following ${jaCreatorFilter.name}` : `Unfollowed ${jaCreatorFilter.name}`, next ? 'success' : 'info');
    } catch (e) {
        const code = e?.code;
        if (code === 'HAMPTER_TOKEN_EXPIRED') {
            showToast('Your JanitorAI session expired. Re-paste your token in Settings to follow creators.', 'warning', 7000);
        } else if (code === 'HAMPTER_LOGIN_REQUIRED') {
            showToast('Add your JanitorAI session in Settings to follow creators.', 'warning', 7000);
        } else if (code === 'HAMPTER_BLOCKED' && !hasBrowserEndpoint()) {
            // Without a browser the write hits the Cloudflare-blocked direct leg; name the fix.
            showToast('Following needs the browser under Settings > Online > Hosted Browser. Start it there, or follow on janitorai.com.', 'warning', 9000);
        } else {
            showToast(`Could not update follow: ${e.message}`, 'error', 7000);
        }
    } finally {
        syncCreatorFollowBtn();
    }
}

function filterByCreator(creatorId, creatorName) {
    if (!creatorId) {
        showToast('That card did not carry a creator id', 'warning');
        return;
    }
    // the base snaps to browse BEFORE this setter runs, so the outgoing mode is
    // stashed under the inputs it was actually loaded with
    view.enterCreatorScope(() => {
        jaCreatorFilter = { id: creatorId, name: creatorName || 'Creator' };
        view._cdRef = { name: creatorName || '', creatorId };
        jaCurrentSearch = '';

        const searchInput = document.getElementById('janitoraiSearchInput');
        if (searchInput) searchInput.value = '';
        document.getElementById('janitoraiClearSearchBtn')?.classList.add('hidden');

        // Entering a creator resets sort to newest instead of inheriting the global sort.
        jaSortMode = 'latest';
        const creatorSort = document.getElementById('janitoraiCreatorSortSelect');
        if (creatorSort) { creatorSort.value = 'latest'; creatorSort._customSelect?.update?.(); }

        const bannerName = document.getElementById('janitoraiCreatorBannerName');
        if (bannerName) bannerName.textContent = creatorName || 'Creator';
        refreshCreatorFollowState();
        window.pushOverlayGuard?.();
    });
}

// Resolve a creator uuid from a URL/uuid (no network) or a name via /profiles/search; toasts on miss, returns null.
async function resolveCreatorInput(raw) {
    const query = (raw || '').trim();
    if (!query) return null;

    const uuidMatch = query.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuidMatch) {
        const id = uuidMatch[0];
        const known = jaCharacters.find(c => c.creator_id === id) || jaFollowed.find(c => c.id === id);
        return { id, name: known?.creator_name || known?.name || 'Creator' };
    }

    let results;
    try {
        results = await searchJanitoraiCreators(query);
    } catch (e) {
        const msg = e?.code === 'HAMPTER_LOGIN_REQUIRED' ? 'Sign in to JanitorAI to search creators.'
            : e?.code === 'HAMPTER_RATE_LIMITED' ? 'JanitorAI is rate limiting; try the search again in a moment.'
            : (e?.message || 'Creator search failed.');
        showToast(msg, 'error', 8000);
        return null;
    }
    if (!results.length) {
        showToast(`No JanitorAI creator found matching "${query}".`, 'warning', 6000);
        return null;
    }
    const lower = query.toLowerCase();
    const pick = results.find(r => (r.name || '').toLowerCase() === lower) || results[0];
    return { id: pick.id, name: pick.name || 'Creator' };
}

async function doCreatorSearch() {
    const input = document.getElementById('janitoraiCreatorSearchInput');
    const raw = (input?.value || '').trim();
    if (!raw) return;

    const resolved = await resolveCreatorInput(raw);
    if (!resolved) return;
    if (input) input.value = '';
    filterByCreator(resolved.id, resolved.name);
}

function clearCreatorFilter(reload = true) {
    view.clearCreatorScope({ reload });
}

function doSearch() {
    const input = document.getElementById('janitoraiSearchInput');
    const clearBtn = document.getElementById('janitoraiClearSearchBtn');
    const val = (input?.value || '').trim();

    if (jaCreatorFilter) view.clearCreatorScope({ reload: false });

    jaCurrentSearch = val;
    if (clearBtn) clearBtn.classList.toggle('hidden', !val);

    // a query wants relevance: ranked sorts only cover a recency window; the select stays live for a deliberate pick
    const sortSelect = document.getElementById('janitoraiSortSelect');
    if (val && sortSelect && jaSortMode !== 'relevance') {
        jaSortMode = 'relevance';
        sortSelect.value = 'relevance';
        sortSelect._customSelect?.update?.();
    }

    view.reload();
}

// ========================================
// EVENT WIRING
// ========================================

let delegatesInitialized = false;
let modalEventsAttached = false;

function initView() {
    jaNsfwEnabled = getSetting('janitoraiNsfw') === true;

    // Wire + seed from state every init: the flags survive a provider switch but the
    // markup (elements and their listeners) is rebuilt with the DOM.
    view.wireFeatureFilters(JA_FEATURE_FILTERS, jaFeatureState, () => {
        view.reload();
    }, { badge: updateFiltersButton });
    // Tag filters survive a provider switch the same way; reseed their button too
    updateTagsButton();

    if (delegatesInitialized) return;
    delegatesInitialized = true;

    const sortEl = document.getElementById('janitoraiSortSelect');
    if (sortEl) CoreAPI.initCustomSelect(sortEl);
    const creatorSortEl = document.getElementById('janitoraiCreatorSortSelect');
    if (creatorSortEl) CoreAPI.initCustomSelect(creatorSortEl);

    // Both grids get the delegate; Following renders into its own grid.
    for (const gridId of ['janitoraiGrid', 'janitoraiFollowingGrid']) {
        const grid = document.getElementById(gridId);
        if (!grid) continue;
        grid.addEventListener('click', (e) => {
            const creatorLink = e.target.closest('.browse-card-creator-link');
            if (creatorLink) {
                e.stopPropagation();
                filterByCreator(creatorLink.dataset.creatorId, creatorLink.dataset.creatorName);
                return;
            }
            const card = e.target.closest('.browse-card');
            if (!card) return;
            const charId = card.dataset.janitoraiId;
            if (!charId) return;
            const hit = jaCharacters.find(c => String(c.character_id) === charId);
            if (hit) openPreviewModal(hit);
        });
    }

    on('janitoraiSearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
    });
    on('janitoraiSearchInput', 'input', (e) => {
        document.getElementById('janitoraiClearSearchBtn')?.classList.toggle('hidden', !e.target.value.trim());
    });
    on('janitoraiSearchBtn', 'click', () => doSearch());
    on('janitoraiClearSearchBtn', 'click', () => {
        const input = document.getElementById('janitoraiSearchInput');
        if (input) input.value = '';
        document.getElementById('janitoraiClearSearchBtn')?.classList.add('hidden');
        if (jaCreatorFilter) view.clearCreatorScope({ reload: false });
        jaCurrentSearch = '';
        view.reload();
    });

    on('janitoraiLoadMoreBtn', 'click', () => {
        view.reload({ append: true });
    });

    on('janitoraiFollowingLoadMoreBtn', 'click', () => {
        view.reload({ append: true });
    });

    on('janitoraiNsfwToggle', 'click', () => {
        jaNsfwEnabled = !jaNsfwEnabled;
        setSetting('janitoraiNsfw', jaNsfwEnabled);
        updateNsfwToggle();
        view.reload();
    });
    updateNsfwToggle();

    on('janitoraiSortSelect', 'change', () => {
        const el = document.getElementById('janitoraiSortSelect');
        if (el && HAMPTER_SORTS.includes(el.value)) jaSortMode = el.value;
        const input = document.getElementById('janitoraiSearchInput');
        if (input) jaCurrentSearch = input.value.trim();
        view.reload();
    });

    on('janitoraiCreatorSearchBtn', 'click', doCreatorSearch);
    on('janitoraiCreatorSearchInput', 'keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doCreatorSearch(); }
    });

    // sort and user_id[] ride one request; guard against HAMPTER_SORTS (unknown = 400).
    on('janitoraiCreatorSortSelect', 'change', () => {
        const el = document.getElementById('janitoraiCreatorSortSelect');
        if (!el || !HAMPTER_SORTS.includes(el.value)) return;
        jaSortMode = el.value;
        view.reload();
    });

    on('janitoraiRefreshBtn', 'click', () => {
        jaFollowedLoaded = false;
        view.reload({ force: true });
    });

    on('janitoraiFollowCreatorBtn', 'click', toggleCreatorFollow);
    on('janitoraiClearCreatorBtn', 'click', () => clearCreatorFilter());

    document.querySelectorAll('.browse-view-btn[data-janitorai-view]').forEach(btn => {
        btn.addEventListener('click', () => setMode(btn.dataset.janitoraiView));
    });

    // Tags dropdown
    const tagsDropdown = document.getElementById('janitoraiTagsDropdown');
    const filtersDropdown = document.getElementById('janitoraiFiltersDropdown');

    on('janitoraiTagsBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns('janitoraiTagsDropdown');
        filtersDropdown?.classList.add('hidden');
        tagsDropdown?.classList.toggle('hidden');
        // Key the first-open fill off the DOM, not the catalogue: the list dies with the
        // container on provider switches while the fetched catalogue survives.
        const list = document.getElementById('janitoraiTagsList');
        if (list && !list.querySelector('.browse-tag-filter-item')) {
            ensureTagCatalogue()
                .then(() => renderTagsList(document.getElementById('janitoraiTagsSearchInput')?.value || ''))
                .catch(() => { /* list keeps its loading message */ });
        }
    });
    tagsDropdown?.addEventListener('click', (e) => e.stopPropagation());

    const tagSearchInput = document.getElementById('janitoraiTagsSearchInput');
    if (tagSearchInput) {
        const debouncedFilter = debounce((val) => renderTagsList(val), 200);
        tagSearchInput.addEventListener('input', () => debouncedFilter(tagSearchInput.value));
    }

    on('janitoraiTagsClearBtn', 'click', () => {
        jaIncludeTags.clear();
        jaExcludeTags.clear();
        renderTagsList(document.getElementById('janitoraiTagsSearchInput')?.value || '');
        updateTagsButton();
        view.reload();
    });

    // Features dropdown
    on('janitoraiFiltersBtn', 'click', (e) => {
        e.stopPropagation();
        CoreAPI.closeAllTopbarDropdowns('janitoraiFiltersDropdown');
        tagsDropdown?.classList.add('hidden');
        filtersDropdown?.classList.toggle('hidden');
    });
    filtersDropdown?.addEventListener('click', (e) => e.stopPropagation());

    view._registerDropdownDismiss([
        { dropdownId: 'janitoraiTagsDropdown', buttonId: 'janitoraiTagsBtn' },
        { dropdownId: 'janitoraiFiltersDropdown', buttonId: 'janitoraiFiltersBtn' },
    ]);

    // Preview modal
    if (!modalEventsAttached) {
        modalEventsAttached = true;

        const overlay = document.getElementById('janitoraiCharModal');
        BrowseView.wireTitleScroll(document.getElementById('janitoraiCharName'), overlay, overlay?.querySelector('.browse-char-modal'));

        on('janitoraiCharClose', 'click', () => closePreviewModal());

        const creatorLink = document.getElementById('janitoraiCharCreator');
        if (creatorLink) {
            creatorLink.addEventListener('click', (e) => {
                e.preventDefault();
                const id = creatorLink.dataset.creatorId;
                const name = creatorLink.textContent.trim();
                if (id) {
                    closePreviewModal();
                    filterByCreator(id, name);
                }
            });
        }

        // Decide desktop at event time; on mobile bail before stopPropagation so the tap delegate runs.
        const avatar = document.getElementById('janitoraiCharAvatar');
        if (avatar) {
            avatar.addEventListener('click', (e) => {
                if (isMobileMode()) return;
                e.stopPropagation();
                if (!avatar.src || avatar.src.endsWith('/img/no-portrait.png')) return;
                BrowseView.openAvatarViewer(avatar.src);
            });
        }

        on('janitoraiImportBtn', 'click', () => {
            if (jaSelectedChar) importCharacter(jaSelectedChar);
        });

        // The notice buttons are rebuilt each preview open, so delegate off the container.
        document.getElementById('janitoraiHiddenNotice')?.addEventListener('click', (e) => {
            if (e.target.closest('[data-notice-action="recover"]')) recoverDefinitionIntoPreview();
            if (e.target.closest('[data-notice-action="tryanyway"]')) recoverLockedIntoPreview();
        });

        if (overlay) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) closePreviewModal();
            });
        }

        window.registerOverlay?.({ id: 'janitoraiCharModal', tier: 7, close: () => closePreviewModal() });
        window.registerOverlay?.({ id: 'janitoraiCreatorBanner', tier: 9, close: () => clearCreatorFilter() });
    }
}

// ========================================
// BROWSE VIEW CLASS
// ========================================

class JanitoraiBrowseView extends BrowseView {
    constructor(provider) {
        super(provider);
        view = this;
    }

    hitMatchName(hit) {
        return { name: hit?.name || '', creator: hit?.creator_name || '', text: hit?.description || '' };
    }

    hitLinkKey(hit) {
        const id = hit?.character_id || hit?.id;
        return id ? String(id) : null;
    }

    importRowStatus(entry) {
        return entry.meta?.kind && entry.status === 'running' ? laneRowStatus(entry, jaLane) : null;
    }

    importLaneChanged() {
        onImportLaneChanged();
    }

    get previewModalId() { return 'janitoraiCharModal'; }

    get hasModeToggle() { return true; }

    closePreview() {
        closePreviewModal();
    }

    get mobileFilterIds() {
        return {
            sort: 'janitoraiSortSelect',
            // No timelineSort: the following feed takes no sort, so the sheet shows the bar's stand-in there.
            tags: 'janitoraiTagsBtn',
            filters: 'janitoraiFiltersBtn',
            nsfw: 'janitoraiNsfwToggle',
            refresh: 'janitoraiRefreshBtn',
            modeBrowseSelector: '.browse-view-btn[data-janitorai-view="browse"]',
            modeFollowSelector: '.browse-view-btn[data-janitorai-view="following"]',
            modeBtnClass: 'browse-view-btn',
        };
    }

    getSettingsConfig() {
        return {
            browseSortOptions: [
                { value: 'popular', label: 'Popular' },
                { value: 'trending', label: 'Trending' },
                { value: 'trending24', label: 'Trending (24h)' },
                { value: 'latest', label: 'Latest' },
                { value: 'relevance', label: 'Relevance' },
            ],
            // Empty: the following feed accepts no sort.
            followingSortOptions: [],
            // Populated so the "Default view" select appears; library.js gates it on viewModes.length.
            viewModes: [
                { value: 'browse', label: 'Browse' },
                { value: 'following', label: 'Following' },
            ],
        };
    }

    // Following Manager

    get supportsFollowingManager() { return true; }

    async getFollowedCreators() {
        const list = await fetchJanitoraiFollowing();
        jaFollowed = list;
        jaFollowedLoaded = true;
        return list.map(c => ({
            id: c.id,
            name: c.name || c.id,
            username: c.name || '',
            // Use the resolver, not string concat: it handles absolute urls, the safety check, and sizing.
            avatar: resolveJanitoraiAvatarUrl(c, { width: 96 }) || '',
        }));
    }

    // Follow by name, URL, or uuid via the shared creator resolver (toasts on miss itself).
    async followCreator(query) {
        const resolved = await resolveCreatorInput(query);
        if (!resolved) return null;
        await setJanitoraiFollow(resolved.id, true);
        jaFollowedLoaded = false;
        syncBannerFollowState(resolved.id, true);
        return { id: resolved.id, name: resolved.name };
    }

    async unfollowCreator(id) {
        if (!id) return false;
        await setJanitoraiFollow(id, false);
        jaFollowedLoaded = false;
        syncBannerFollowState(id, false);
        return true;
    }

    browseCreatorFromManager(creator) {
        // No toggleFollowingManager(): filterByCreator hides the header with its only close button.
        filterByCreator(creator.id, creator.name);
    }

    getFollowingManagerSortOptions() {
        // Values must match the base's vocabulary; _sortCreators silently disables sorting on unknowns.
        return [
            { value: 'name_asc', label: 'Name A-Z' },
            { value: 'name_desc', label: 'Name Z-A' },
        ];
    }

    // Filter Bar

    renderFilterBar() {
        const sortOpt = (value, label, icon) =>
            `<option value="${value}" data-icon="fa-solid ${icon}" ${jaSortMode === value ? 'selected' : ''}>${label}</option>`;
        return `
            <!-- Mode toggle sits in the filter bar, outside both sections, so switching mode cannot hide it. -->
            ${renderViewToggle('janitorai-view', [
                { value: 'browse', icon: 'fa-compass', label: 'Browse', title: 'Browse all characters', active: true },
                { value: 'following', icon: 'fa-users', label: 'Following', title: 'New from creators you follow (requires login)' },
            ])}

            <div class="browse-sort-container">
                <select id="janitoraiSortSelect" class="glass-select" title="Sort order">
                    <optgroup label="Popularity">
                        ${sortOpt('popular', 'Popular', 'fa-fire')}
                        ${sortOpt('trending', 'Trending', 'fa-arrow-trend-up')}
                        ${sortOpt('trending24', 'Trending (24h)', 'fa-arrow-trend-up')}
                    </optgroup>
                    <optgroup label="Date">
                        ${sortOpt('latest', 'Latest', 'fa-calendar-plus')}
                    </optgroup>
                    <optgroup label="Search">
                        ${sortOpt('relevance', 'Relevance', 'fa-magnifying-glass')}
                    </optgroup>
                </select>
            </div>

            <div class="browse-tags-dropdown-container u-relative">
                <button id="janitoraiTagsBtn" class="glass-btn" title="Tag filters">
                    <i class="fa-solid fa-tags"></i> <span id="janitoraiTagsBtnLabel">Tags</span>
                </button>
                <div id="janitoraiTagsDropdown" class="dropdown-menu browse-tags-dropdown hidden">
                    <div class="browse-tags-search-row">
                        <input type="search" id="janitoraiTagsSearchInput" placeholder="Search tags..." autocomplete="one-time-code">
                        <button id="janitoraiTagsClearBtn" class="glass-btn icon-only" title="Clear all tag filters">
                            <i class="fa-solid fa-rotate-left"></i>
                        </button>
                    </div>
                    <div class="browse-tags-list" id="janitoraiTagsList"></div>
                </div>
            </div>

            <div class="browse-more-filters u-relative">
                <button id="janitoraiFiltersBtn" class="glass-btn" title="Additional filters">
                    <i class="fa-solid fa-sliders"></i> <span>Features</span>
                </button>
                <div id="janitoraiFiltersDropdown" class="dropdown-menu browse-features-dropdown hidden is-wide">
                    ${renderFeatureFilterItems(JA_FILTER_SECTIONS, JA_FEATURE_FILTERS)}
                </div>
            </div>

            <button id="janitoraiNsfwToggle" class="glass-btn nsfw-toggle" title="Toggle NSFW content">
                <i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span>
            </button>

            <button id="janitoraiRefreshBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    // Main View

    renderView() {
        return `
            <div id="janitoraiBrowseSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="janitoraiSearchInput" placeholder="Search JanitorAI characters..." autocomplete="one-time-code">
                        <button id="janitoraiClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="janitoraiSearchBtn" class="browse-search-submit" aria-label="Search">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                    <div class="browse-creator-search">
                        <div class="browse-creator-search-wrapper">
                            <i class="fa-solid fa-user-pen"></i>
                            <input type="search" id="janitoraiCreatorSearchInput" placeholder="Creator name or profile URL..." autocomplete="one-time-code">
                            <button id="janitoraiCreatorSearchBtn" class="browse-search-submit" title="Browse a creator's characters">
                                <i class="fa-solid fa-arrow-right"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <div id="janitoraiCreatorBanner" class="browse-author-banner hidden">
                    <div class="browse-author-banner-content">
                        <i class="fa-solid fa-user-pen"></i>
                        <span>Characters by <strong id="janitoraiCreatorBannerName">Creator</strong></span>
                    </div>
                    <div class="browse-author-banner-actions">
                        <select id="janitoraiCreatorSortSelect" class="glass-select" title="Sort this creator's characters">
                            <option value="latest" data-icon="fa-solid fa-calendar-plus">Newest</option>
                            <option value="popular" data-icon="fa-solid fa-fire">Popular</option>
                            <option value="trending" data-icon="fa-solid fa-arrow-trend-up">Trending</option>
                            <option value="trending24" data-icon="fa-solid fa-arrow-trend-up">Trending (24h)</option>
                        </select>
                        <button id="janitoraiFollowCreatorBtn" class="glass-btn browse-author-follow-btn" title="Follow this creator on JanitorAI" hidden>
                            <i class="fa-solid fa-heart"></i> <span>Follow</span>
                        </button>
                        <button id="janitoraiClearCreatorBtn" class="glass-btn icon-only" title="Clear creator filter">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>

                <div id="janitoraiGrid" class="browse-grid"></div>

                <div class="browse-load-more" id="janitoraiLoadMore" hidden>
                    <button id="janitoraiLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>

            <div id="janitoraiFollowingSection" class="browse-section hidden">
                <div class="browse-timeline-header">
                    <div class="browse-timeline-header-left">
                        <h3><i class="fa-solid fa-user-group"></i> Following</h3>
                        <p>Characters from creators you follow</p>
                    </div>
                    <div class="browse-timeline-header-right">
                        <button class="follow-mgr-toggle-btn glass-btn" id="janitoraiFollowMgrToggle" title="Manage followed creators">
                            <i class="fa-solid fa-users-gear"></i> Manage
                        </button>
                    </div>
                </div>
                ${this.renderFollowingManagerPanel()}

                <div id="janitoraiFollowingGrid" class="browse-grid"></div>

                <div class="browse-load-more" id="janitoraiFollowingLoadMore" hidden>
                    <button id="janitoraiFollowingLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    // Modals

    renderModals() {
        return `
    <div id="janitoraiCharModal" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="janitoraiCharAvatar" src="/img/no-portrait.png" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="janitoraiCharName">Character Name</h2>
                        <p class="browse-char-meta">
                            by <a id="janitoraiCharCreator" href="#" class="creator-link browse-meta-identity" title="Click to see all characters by this creator">Creator</a>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="janitoraiOpenInBrowserBtn" href="#" target="_blank" class="cl-btn cl-btn-secondary" title="Open on JanitorAI">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="janitoraiImportBtn" class="cl-btn cl-btn-primary" title="Import into your library">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="janitoraiCharClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats">
                        <div class="browse-stat">
                            <i class="fa-solid fa-comments"></i>
                            <span id="janitoraiCharChats">0</span> chats
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-envelope"></i>
                            <span id="janitoraiCharMessages">0</span> messages
                        </div>
                        <div class="browse-stat" id="janitoraiCharTokensStat" hidden>
                            <i class="fa-solid fa-font"></i>
                            <span id="janitoraiCharTokens">0</span> tokens
                        </div>
                        <div class="browse-stat" id="janitoraiCharGreetingsStat" hidden>
                            <i class="fa-solid fa-comment-dots"></i>
                            <span id="janitoraiCharGreetingsCount">0</span> greetings
                        </div>
                        <div class="browse-stat" id="janitoraiCharLorebookStat" hidden>
                            <i class="fa-solid fa-book"></i>
                            <span id="janitoraiCharLorebookCount">0</span> lorebook
                        </div>
                        <div class="browse-stat">
                            <i class="fa-solid fa-calendar"></i>
                            <span id="janitoraiCharDate">Unknown</span>
                        </div>
                    </div>
                    <div class="browse-char-tags" id="janitoraiCharTags"></div>
                </div>

                <div id="janitoraiHiddenNotice" hidden></div>

                <div class="browse-char-section" id="janitoraiCharCreatorNotesSection" hidden>
                    <h3 class="browse-section-title" data-section="janitoraiCharCreatorNotes" data-label="Creator's Notes" data-icon="fa-solid fa-feather-pointed" title="Click to expand">
                        <i class="fa-solid fa-feather-pointed"></i> Creator's Notes
                    </h3>
                    <div id="janitoraiCharCreatorNotes" class="scrolling-text"></div>
                </div>

                <div class="browse-char-section" id="janitoraiCharDescriptionSection" hidden>
                    <h3 class="browse-section-title" data-section="janitoraiCharDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="janitoraiCharDescription" class="scrolling-text"></div>
                </div>

                <div class="browse-char-section" id="janitoraiCharScenarioSection" hidden>
                    <h3 class="browse-section-title" data-section="janitoraiCharScenario" data-label="Scenario" data-icon="fa-solid fa-theater-masks" title="Click to expand">
                        <i class="fa-solid fa-theater-masks"></i> Scenario
                    </h3>
                    <div id="janitoraiCharScenario" class="scrolling-text"></div>
                </div>

                <div class="browse-char-section browse-section-collapsed" id="janitoraiCharExamplesSection" hidden>
                    <h3 class="browse-section-title" data-section="janitoraiCharExamples" data-label="Example Dialogs" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Example Dialogs
                        <span class="browse-section-inline-toggle" title="Toggle inline"><i class="fa-solid fa-chevron-down"></i></span>
                    </h3>
                    <div id="janitoraiCharExamples" class="scrolling-text"></div>
                </div>

                <div class="browse-char-section" id="janitoraiCharFirstMsgSection" hidden>
                    <h3 class="browse-section-title" data-section="janitoraiCharFirstMsg" data-label="First Message" data-icon="fa-solid fa-message" title="Click to expand">
                        <i class="fa-solid fa-message"></i> First Message
                    </h3>
                    <div id="janitoraiCharFirstMsg" class="scrolling-text first-message-preview"></div>
                </div>

                <div class="browse-char-section" id="janitoraiCharAltGreetingsSection" hidden>
                    <h3 class="browse-section-title" data-section="browseAltGreetings" data-label="Alternate Greetings" data-icon="fa-solid fa-comments" title="Click to expand">
                        <i class="fa-solid fa-comments"></i> Alternate Greetings <span class="browse-section-count" id="janitoraiCharAltGreetingsCount"></span>
                    </h3>
                    <div id="janitoraiCharAltGreetings" class="browse-alt-greetings-list"></div>
                </div>

                <div class="browse-char-section" id="janitoraiCharLorebookSection" hidden>
                    <h3 class="browse-section-title" data-section="janitoraiCharLorebook" data-label="Lorebook" data-icon="fa-solid fa-book" title="Click to expand">
                        <i class="fa-solid fa-book"></i> Lorebook
                    </h3>
                    <div id="janitoraiCharLorebook" class="scrolling-text"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // Lifecycle

    _getImageGridIds() { return ['janitoraiGrid', 'janitoraiFollowingGrid']; }

    canLoadMore() { return jaHasMore && !jaIsLoading; }

    // 'creator' also gives mobile its Creator tab; the search overlay builds tabs from getSearchModes().
    getSearchModes() { return ['character', 'creator']; }

    getSearchInputId(mode) {
        if (mode === 'character') return 'janitoraiSearchInput';
        if (mode === 'creator') return 'janitoraiCreatorSearchInput';
        return null;
    }

    getSearchPlaceholder(mode) {
        return mode === 'creator' ? 'Creator name or profile URL...' : 'Search JanitorAI characters...';
    }

    applyDefaults(defaults) {
        super.applyDefaults(defaults);
        if (defaults.sort && HAMPTER_SORTS.includes(defaults.sort)) {
            jaSortMode = defaults.sort;
            const el = document.getElementById('janitoraiSortSelect');
            if (el) { el.value = defaults.sort; el._customSelect?.update?.(); }
        }
    }

    init() {
        super.init();
        initView();
        for (const gridId of this._getImageGridIds()) {
            const g = document.getElementById(gridId);
            if (g) this.observeImages(g);
        }
        // No initial load here: init() runs before applyDefaults(), so activate() issues it.
    }

    // Activation hooks and the two modes

    resetSessionState() {
        jaCurrentSearch = '';
        jaCreatorFilter = null;
        jaCharacters = [];
        jaCurrentPage = 1;
        jaTotalPages = 0;
        jaHasMore = true;
        jaIsLoading = false;
        jaGridRenderedCount = 0;
        jaMode = 'browse';
        // The grids are gone with the old DOM, so cached results have nothing to repaint into.
        jaModeCache.browse = null;
        jaModeCache.following = null;
    }

    onActivated(isReEntry) {
        delegatesInitialized = true;
    }

    // The shared jaCharacters vars always hold the CURRENT mode's results; switching
    // stashes them per mode and restores in enter (the query-signature cache).
    get viewModes() {
        const load = (o) => { if (o?.append) jaCurrentPage++; loadCharacters(!!o?.append); };
        return {
            modeAttr: 'data-janitorai-view',
            current: () => jaMode,
            set: (m) => { stashModeState(jaMode); jaMode = m; },
            modes: {
                browse: {
                    sectionId: 'janitoraiBrowseSection',
                    gridId: 'janitoraiGrid',
                    hasData: () => jaCharacters.length > 0,
                    load,
                    render: () => { jaGridRenderedCount = 0; renderGrid(jaCharacters, false); },
                    chrome: syncModeChrome,
                    enter: () => jaEnterMode('browse'),
                },
                following: {
                    sectionId: 'janitoraiFollowingSection',
                    gridId: 'janitoraiFollowingGrid',
                    hasData: () => jaCharacters.length > 0,
                    load,
                    render: () => { jaGridRenderedCount = 0; renderGrid(jaCharacters, false); },
                    chrome: syncModeChrome,
                    enter: () => jaEnterMode('following'),
                },
            },
        };
    }

    // the loader carries user_id[] on every leg, so the scope load is the browse load; entry forces latest
    get creatorScope() {
        return {
            bannerId: 'janitoraiCreatorBanner',
            isActive: () => !!jaCreatorFilter,
            load: (o) => this.viewModes.modes.browse.load(o),
            clear: () => {
                jaCreatorFilter = null;
                jaFollowingCurrentCreator = false;
                jaCharacters = [];
                syncCreatorFollowBtn();
            },
            chrome: () => syncModeChrome(),
            stash: () => ({ sort: jaSortMode, search: jaCurrentSearch }),
            restore: (s) => {
                jaSortMode = s.sort;
                jaCurrentSearch = s.search;
                const mainSort = document.getElementById('janitoraiSortSelect');
                if (mainSort) { mainSort.value = s.sort; mainSort._customSelect?.update?.(); }
                const input = document.getElementById('janitoraiSearchInput');
                if (input) input.value = s.search;
                document.getElementById('janitoraiClearSearchBtn')?.classList.toggle('hidden', !s.search);
            },
        };
    }

    deactivate() {
        stopQueueWatch();
        jaQueueWatchSince = 0;
        // Bump both tokens so an in-flight listing or detail response is discarded.
        jaDetailToken++;
        jaLoadToken++;
        // Reset or an in-flight load leaves the guard set and the next entry can never page.
        jaIsLoading = false;
        // Actually abort: the token check discards the response but the fetch keeps running.
        if (jaFetchController) {
            try { jaFetchController.abort(); } catch { /* already settled */ }
            jaFetchController = null;
        }
        delegatesInitialized = false;
        super.deactivate();
    }
}

const janitoraiBrowseView = new JanitoraiBrowseView(null);

// Called by library.js's viewOnProvider for a linked character's preview.
window.openJanitoraiCharPreview = function (hit) {
    openPreviewModal(hit);
};

export default janitoraiBrowseView;

// ========================================
// CREATOR DOWNLOADS ADAPTER
// ========================================

registerCdAdapter('janitorai', {
    async fetchAll(view) {
        const creatorId = view._cdRef?.creatorId;
        if (!creatorId) return [];
        const results = [];
        const seen = new Set();
        const MAX_PAGES = 200;
        for (let page = 1; page <= MAX_PAGES; page++) {
            let data;
            try {
                data = await fetchJanitoraiCharacters({
                    creatorIds: [creatorId],
                    page,
                    sort: 'latest',
                    mode: CoreAPI.getSetting('janitoraiNsfw') === true ? 'all' : 'sfw',
                });
            } catch (e) {
                // Anonymous listing gates after page 1; keep what the open pages yielded
                // instead of throwing away the run. A first-page failure is a real error.
                if (page > 1) break;
                throw e;
            }
            const hits = data?.characters || [];
            let added = 0;
            for (const hit of hits) {
                const id = cdCharId(hit);
                if (id == null || id === '' || seen.has(String(id))) continue;
                seen.add(String(id));
                results.push({
                    key: String(id),
                    name: hit.name || '',
                    creator: hit.creator_name || view._cdRef?.name || '',
                    raw: hit,
                });
                added++;
            }
            // Stop on a short page or one that added nothing new, so a server that clamps the
            // page number cannot spin this to MAX_PAGES.
            if (!added || hits.length < (data?.pageSize || 34)) break;
        }
        return results;
    },
    async importOne(view, card) {
        const provider = CoreAPI.getProvider('janitorai');
        if (!provider?.importCharacter) return { ok: false, error: 'Provider not available' };
        await new Promise(r => setTimeout(r, 2000));
        const result = await importThroughCommand(provider, card.key, card.raw, { requireDefinition: true });
        if (!result.success) {
            if (/rate limit/i.test(result.error || '')) {
                await new Promise(r => setTimeout(r, 13000));
            }
            return { ok: false, error: result.error || 'Import failed' };
        }
        return view.creatorImportAnswer(result, provider);
    },
});
