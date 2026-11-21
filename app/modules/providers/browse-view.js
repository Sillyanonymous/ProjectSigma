// BrowseView - base class for provider browse views in the Online tab

import CoreAPI from '../core-api.js';
import { isMobileMode, scrollBrowseListTop, deferRender, BROWSE_PURIFY_CONFIG, importThroughCommand, finishBrowseImport, PROBE_PAGE } from './provider-utils.js';
import { findImport, importsOf, enqueueImport, importingBadge } from './import-lane.js';

// ========================================
// SHARED IN-LIBRARY LOOKUP BASE
// ========================================

// a remote card's name and creator -> the server's score for it (0 to 100); what was asked, its text too, outlives a library change
const _sharedBaseLookup = {
    answers: new Map(),
    // the score's basis when it is not the plain rule's: otherListing, an unplaced namesake on the card's own site
    bases: new Map(),
    asked: new Set(),
    hits: new Map(),
    gen: -1,
};
const HITS_KEPT = 5000;
// the most of a site's text kept and sent per card: the server reads no more
const HIT_TEXT_MAX = 4000;
const nameKey = (raw) => String(raw || '').toLowerCase().trim();
const matchKey = (name, creator, listing = null) => `${nameKey(name)}\u0000${nameKey(creator)}${listing?.key ? `\u0000${listing.providers.join(',')}\u0000${listing.key}` : ''}`;

// Mobile: reset the browse list to the top on a sort change or a Browse/Following toggle.
let _browseScrollResetWired = false;
function wireBrowseScrollReset() {
    if (_browseScrollResetWired) return;
    const filterArea = document.getElementById('onlineFilterContent');
    const onlineView = document.getElementById('onlineView');
    if (!filterArea || !onlineView) return;
    _browseScrollResetWired = true;
    // Every browse <select> is a sort control (some in the filter bar, some in the view), so bind both.
    const onSortChange = (e) => {
        if (e.target?.tagName === 'SELECT') scrollBrowseListTop();
    };
    filterArea.addEventListener('change', onSortChange);
    onlineView.addEventListener('change', onSortChange);
    // Browse/Following tabs render into the filter bar.
    filterArea.addEventListener('click', (e) => {
        if (e.target?.closest?.('[class*="-view-btn"]')) scrollBrowseListTop();
    });
}
let _baseLookupGen = 0;

// tier bands are fixed so a card reads the same intensity whatever cutoff the slider sets
const POSSIBLE_MATCH_TIER_HIGH = 85;
const POSSIBLE_MATCH_TIER_MED = 65;
const getPossibleMatchMinScore = () => CoreAPI.numberSetting('possibleMatchMinScore');

/** Mark the shared base stale so the next build recomputes it. O(1). */
export function invalidateSharedBaseLookup() {
    _baseLookupGen++;
}

function ensureSharedBaseLookup() {
    if (_sharedBaseLookup.gen === _baseLookupGen) return;
    // a library change: every score is asked again, the old one shown until its answer lands so no badge flickers
    _sharedBaseLookup.asked = new Set();
    _sharedBaseLookup.gen = _baseLookupGen;
}

/**
 * A character this tab took in: its names get re-asked on the next probe, answers kept and no generation bump, so nothing goes dark.
 * @param {Object} char
 */
export function adoptNameIntoSharedBase(char) {
    if (!char) return;
    ensureSharedBaseLookup();
    _sharedBaseLookup.asked.clear();
}

// ========================================
// CREATOR DOWNLOADS: PER-PROVIDER ADAPTER REGISTRY
// ========================================

// providers stamp their creator-filter state on view._cdRef and register an adapter here

export function cdMediaEntry(result, extra = {}) {
    return {
        name: result.characterName,
        id: result.id,
        avatarUrl: result.avatarUrl,
        mediaUrls: result.embeddedMediaUrls || [],
        galleryPageUrls: result.galleryPageUrls || [],
        cardData: result.cardData,
        ...extra,
    };
}

export function cdHasMedia(result) {
    return (result.embeddedMediaUrls?.length || 0) > 0 || (result.galleryPageUrls?.length || 0) > 0;
}

let _cdActiveView = null;

export const cdCharId = (hit) => hit?.characterId || hit?.character_id || hit?.id || '';

const CD_ADAPTERS = {};

// Providers own their adapters: each browse file registers at import time, so this
// base stays provider-blind and an extension provider walks in the same door.
export function registerCdAdapter(id, adapter) {
    CD_ADAPTERS[id] = adapter;
}

// ========================================
// FEATURES-FILTER TABLE DRIVER
// ========================================

// one row per boolean toggle; nodeTest = the card HAS it (filter and badge share it), exclude = hide it

export function featureFilterState(table) {
    return Object.fromEntries(table.map(f => [f.key, false]));
}

// wrapId boxes a section so a visibility rule can address it; noHr drops the divider before it
export function renderFeatureFilterItems(sections, table) {
    const hr = '<hr class="browse-filter-divider">';
    const parts = [];
    sections.forEach((section, i) => {
        const title = section.title ? `<div class="dropdown-section-title">${section.title}</div>` : '';
        const items = table.filter(f => f.section === section.key).map(f =>
            `<label class="filter-checkbox"${f.labelTitle ? ` title="${f.labelTitle}"` : ''}><input type="checkbox" id="${f.id}"> <i class="fa-solid ${f.icon}"${f.iconStyle ? ` style="${f.iconStyle}"` : ''}></i> ${f.label}</label>`
        ).join('\n                    ');
        let block = title ? `${title}\n                    ${items}` : items;
        const next = sections[i + 1];
        const trailing = next && !next.noHr ? hr : '';
        if (section.wrapId) {
            // a wrapped section owns its trailing divider, so hiding the wrap hides it too
            block = `<div id="${section.wrapId}"${section.wrapClass ? ` class="${section.wrapClass}"` : ''}>\n                    ${block}${trailing ? `\n                    ${trailing}` : ''}\n                    </div>`;
        } else if (trailing) {
            block = `${block}\n                    ${trailing}`;
        }
        parts.push(block);
    });
    return parts.join('\n                    ');
}

// browser form caching can desync checkboxes from state, so sync first; beforeChange answering false aborts
export function wireFeatureFilters(table, state, onChange, { beforeChange } = {}) {
    for (const f of table) {
        const checkbox = document.getElementById(f.id);
        if (!checkbox) continue;
        checkbox.checked = !!state[f.key];
        checkbox.addEventListener('change', async (e) => {
            if (beforeChange && await beforeChange(f, e) === false) return;
            state[f.key] = e.target.checked;
            onChange?.(f, e);
        });
    }
}

export function countActiveFeatures(table, state, { inertKeys = [] } = {}) {
    return table.filter(f => state[f.key] && !inertKeys.includes(f.key)).length;
}

// a card slot is ~260 CSS px square; decoding originals into it is what made the grids chug
export function browseCardImageWidth() {
    return (window.devicePixelRatio || 1) > 1.5 ? 600 : 300;
}

// predicate-less rows do nothing client-side, so they grey there with zero wiring
export function browseOnlyFeatureRows(table, { except = [] } = {}) {
    return table.filter(f => !f.nodeTest && !f.exclude && !except.includes(f.key));
}

export function setFeatureRowsDisabled(rows, disabled, title) {
    for (const f of rows) {
        const input = document.getElementById(f.id);
        if (!input) continue;
        input.disabled = disabled;
        const row = input.closest('label.filter-checkbox');
        if (!row) continue;
        row.classList.toggle('browse-option-disabled', disabled);
        if (disabled) row.title = title;
        else row.removeAttribute('title');
    }
}

// Server require_* params, table order preserved.
export function applyFeatureParams(params, table, state) {
    for (const f of table) {
        if (f.param && state[f.key]) params.set(f.param, 'true');
    }
}

export function activeFeatureRows(table, state) {
    return table.filter(f => state[f.key] && (f.nodeTest || f.exclude));
}

export function activeFeatureExcludes(table, state) {
    return table.filter(f => state[f.key] && f.exclude);
}

// One card against the active predicate rows: required features present, excluded
// conditions absent.
export function featurePasses(char, activeRows) {
    for (const f of activeRows) {
        if (f.nodeTest && !f.nodeTest(char)) return false;
        if (f.exclude && f.exclude(char)) return false;
    }
    return true;
}

export function featureBadgesHtml(char, table) {
    const out = [];
    for (const f of table) {
        if (f.badge && f.nodeTest?.(char)) {
            out.push(`<span class="browse-feature-badge${f.badge.cls}" title="${f.badge.title}"><i class="fa-solid ${f.badge.icon}"></i></span>`);
        }
    }
    return out;
}

/**
 * The Features dropdown's two Library rows (Hide Owned, Hide Possible Matches); the view is read when a row runs.
 * @param {string} idPrefix the checkbox id prefix ('chub' gives chubFilterHideOwned)
 * @param {() => BrowseView} viewOf
 * @param {(hit: Object) => boolean} isPossible
 */
export function libraryFeatureRows(idPrefix, viewOf, isPossible) {
    return [
        { key: 'hideOwned', id: `${idPrefix}FilterHideOwned`, section: 'library', icon: 'fa-check', label: 'Hide Owned Characters',
          exclude: (hit) => viewOf().isHitInLibrary(hit) },
        { key: 'hidePossible', id: `${idPrefix}FilterHidePossible`, section: 'library', icon: 'fa-check', iconStyle: 'color: var(--cl-possible-match);', label: 'Hide Possible Matches',
          exclude: isPossible },
    ];
}

// ========================================
// SHARED VIEW HELPERS
// ========================================

// the tri-state tag row: its render and its click read the shell's one table (library.js tagStateLook)
export function tagStateButtonHtml(state) {
    const { state: s, icon, title } = CoreAPI.tagStateLook(state);
    return `<button class="browse-tag-state-btn state-${s}" title="${title}">${icon ? `<i class="fa-solid ${icon}"></i>` : ''}</button>`;
}

export function updateTagStateButton(btn, state) {
    if (!btn) return;
    const { state: s, icon, title } = CoreAPI.tagStateLook(state);
    btn.className = `browse-tag-state-btn state-${s}`;
    btn.innerHTML = icon ? `<i class="fa-solid ${icon}"></i>` : '';
    btn.title = title;
}

// the fit picks from these; data-tag-total counts every tag the listing knows, so "+N" is honest
const CARD_TAGS_RENDERED = 8;
/**
 * The segmented toggle (Browse / Following, Characters / Lorebooks), one markup for every view.
 * @param {string} attr the data attribute the buttons carry (e.g. 'chub-view')
 * @param {Array<{value: string, icon: string, label: string, title?: string, active?: boolean}>} buttons
 * @param {{ id?: string, className?: string }} [opts]
 * @returns {string}
 */
export function renderViewToggle(attr, buttons, { id = '', className = '' } = {}) {
    const esc = (s) => CoreAPI.escapeHtml(s);
    const btn = (b) => `<button type="button" class="browse-view-btn cl-seg-btn${b.active ? ' active' : ''}" data-${attr}="${esc(b.value)}" title="${esc(b.title || '')}"><i class="fa-solid ${esc(b.icon)}"></i> <span>${esc(b.label)}</span></button>`;
    return `<div class="browse-view-toggle cl-seg${className ? ` ${className}` : ''}"${id ? ` id="${esc(id)}"` : ''}>${buttons.map(btn).join('')}</div>`;
}

// a card's library state, one spelling for the card templates and the badge heal
const IN_LIBRARY_BADGE = '<span class="browse-feature-badge in-library" title="In Your Library"><i class="fa-solid fa-check"></i></span>';

/**
 * The badge a card wears for its library state: In Your Library, a graded possible match, or none.
 * @param {boolean} inLibrary
 * @param {{show: boolean, tier: string, tooltip: string}|null} [tier] - getPossibleMatchTier's answer
 * @returns {string}
 */
export function libraryBadgeHtml(inLibrary, tier) {
    if (inLibrary) return IN_LIBRARY_BADGE;
    return tier?.show ? `<span class="browse-feature-badge possible-library pl-${tier.tier}" title="${tier.tooltip}"><i class="fa-solid fa-check"></i></span>` : '';
}

/** The card root's class for the same state. */
export function libraryCardClass(inLibrary, tier) {
    if (inLibrary) return 'browse-card in-library';
    return tier?.show ? 'browse-card possible-library' : 'browse-card';
}

export function cardTagsHtml(tags) {
    const all = (tags || []).filter(t => typeof t === 'string' && t.trim());
    const esc = (s) => CoreAPI.escapeHtml(s);
    return `<div class="browse-card-tags" data-tag-total="${all.length}">${all.slice(0, CARD_TAGS_RENDERED).map(t => `<span class="browse-card-tag" title="${esc(t)}">${esc(t)}</span>`).join('')}</div>`;
}

// the preview tag cloud: the rows that fit, then a "+N" pill flipping to Show Less; the shell owns the fit (library.js clampTagRows)
const BROWSE_TAG_LOOK = { tag: 'browse-tag', more: 'browse-tags-more', overflow: 'browse-tag-hidden', collapsed: 'browse-tags-collapsed', expanded: 'browse-tags-expanded' };

export function applyTagsClamp(tagsEl) {
    if (!tagsEl) return;
    // a fresh render is a fresh character: it opens clamped
    delete tagsEl.dataset.tagsExpanded;
    CoreAPI.clampTagRows(tagsEl, BROWSE_TAG_LOOK);
}

// The preview modal's alternate-greetings accordion, addressed by element-id prefix; janitorai keeps
// its own, a list of every greeting with the first one in it.
export function renderAltGreetingsList(idPrefix, greetings, charName) {
    const section = document.getElementById(`${idPrefix}CharAltGreetingsSection`);
    const listEl = document.getElementById(`${idPrefix}CharAltGreetings`);
    const countEl = document.getElementById(`${idPrefix}CharAltGreetingsCount`);
    if (!section || !listEl) return;

    const greetingsStat = document.getElementById(`${idPrefix}CharGreetingsStat`);
    const greetingsCountEl = document.getElementById(`${idPrefix}CharGreetingsCount`);

    if (!Array.isArray(greetings) || greetings.length === 0) {
        section.hidden = true;
        listEl.innerHTML = '';
        if (countEl) countEl.textContent = '';
        if (greetingsStat) greetingsStat.hidden = true;
        CoreAPI.setBrowseAltGreetings([]);
        return;
    }

    if (greetingsStat) greetingsStat.hidden = false;
    // +1 accounts for the first_mes greeting.
    if (greetingsCountEl) greetingsCountEl.textContent = String(greetings.length + 1);

    const buildPreview = (text) => {
        const cleaned = (text || '').replace(/\s+/g, ' ').trim();
        if (!cleaned) return 'No content';
        return cleaned.length > 90 ? `${cleaned.slice(0, 87)}...` : cleaned;
    };

    section.hidden = false;
    listEl.innerHTML = greetings.map((greeting, idx) => {
        const label = `#${idx + 1}`;
        const preview = CoreAPI.escapeHtml(buildPreview(greeting));
        return `
            <details class="browse-alt-greeting" data-greeting-idx="${idx}">
                <summary>
                    <span class="browse-alt-greeting-index">${label}</span>
                    <span class="browse-alt-greeting-preview">${preview}</span>
                    <span class="browse-alt-greeting-chevron"><i class="fa-solid fa-chevron-down"></i></span>
                </summary>
                <div class="browse-alt-greeting-body"></div>
            </details>
        `;
    }).join('');

    listEl.querySelectorAll('details.browse-alt-greeting').forEach(details => {
        details.addEventListener('toggle', function onToggle() {
            if (!details.open) return;
            const body = details.querySelector('.browse-alt-greeting-body');
            if (body && !body.dataset.rendered) {
                const idx = parseInt(details.dataset.greetingIdx, 10);
                if (greetings[idx] != null) {
                    deferRender(body, () => CoreAPI.safePurify(CoreAPI.formatRichText(greetings[idx], charName, true), BROWSE_PURIFY_CONFIG));
                }
                body.dataset.rendered = '1';
            }
        }, { once: true });
    });

    if (countEl) countEl.textContent = `(${greetings.length})`;
    CoreAPI.setBrowseAltGreetings(greetings);
}

// every creator view sorts in its own bar, so the main sort's place says where
export const CREATOR_SORT_STANDIN = Object.freeze({ label: 'Creator\'s Sort', icon: 'fa-solid fa-user', title: 'Sort this creator\'s characters with the menu by their name' });

/**
 * The greyed stand-in in the sort's place while no sort applies; it holds every order the site shows, so the slot keeps one width.
 * @param {HTMLSelectElement} sortEl the slot's main sort
 * @param {{label: string, icon: string, title: string} | null} fixed the order shown (one of every), or null while a sort applies
 * @param {Array<{label: string, icon: string, title: string}>} every each order the site can show
 */
export function syncSortStandIn(sortEl, fixed, every) {
    const slot = sortEl?.closest('.browse-sort-container');
    if (!slot) return;
    let el = slot.querySelector('select.browse-sort-standin');
    if (!el) {
        el = document.createElement('select');
        el.className = 'glass-select browse-sort-standin browse-option-disabled';
        el.disabled = true;
        for (const order of every) {
            const option = new Option(order.label);
            option.dataset.icon = order.icon;
            el.add(option);
        }
        slot.appendChild(el);
        CoreAPI.initCustomSelect(el);
    }
    const box = el._customSelect?.container || el;
    box.classList.toggle('hidden', !fixed);
    if (!fixed) return;
    el.selectedIndex = every.indexOf(fixed);
    el._customSelect?.update();
    const trigger = el._customSelect?.trigger;
    // a disabled button shows no tooltip in every browser, so its container carries the reason too
    for (const node of [box, trigger]) if (node) node.title = fixed.title;
    // folded behind the More, the row names the order and the reason rides as its hint
    if (trigger) trigger.dataset.overflowLabel = fixed.label;
}

/**
 * A filter button's count as a badge on its corner, so the button keeps one width and nothing beside it shifts.
 * @param {HTMLElement} btn
 * @param {string} label the button's word, which the More menu names with the count
 * @param {number|string} count a number or a "+2/-1" form; 0 or '' for none
 * @param {boolean} [active] lights the button; a filter the count leaves out can light it too
 */
export function setFilterCount(btn, label, count, active = !!count) {
    if (!btn) return;
    btn.classList.toggle('has-filters', !!active);
    const text = count ? String(count) : '';
    let badge = btn.querySelector('.browse-count-badge');
    if (!text) badge?.remove();
    else {
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'browse-count-badge';
            btn.appendChild(badge);
        }
        badge.textContent = text;
    }
    btn.dataset.overflowLabel = text ? `${label} (${text})` : label;
}

// fixed-width icons, so the icon-only switch of a narrow bar keeps one width too
const NSFW_TOGGLE_LABELS = [
    '<i class="fa-solid fa-fire fa-fw"></i> <span>NSFW On</span>',
    '<i class="fa-solid fa-shield-halved fa-fw"></i> <span>SFW Only</span>',
];

// Every site's NSFW switch: the titles ride as options, and it holds its wider label, so a flip never resizes it
export function updateNsfwToggleButton(btnId, enabled, { offTitle = 'Showing SFW only - click to include NSFW', onTitle = 'NSFW content enabled - click to show SFW only' } = {}) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    CoreAPI.lockMinWidth(btn, () => {
        const current = btn.innerHTML;
        let widest = 0;
        for (const html of NSFW_TOGGLE_LABELS) {
            btn.innerHTML = html;
            widest = Math.max(widest, btn.scrollWidth);
        }
        btn.innerHTML = current;
        return widest;
    });
    btn.classList.toggle('active', !!enabled);
    btn.innerHTML = NSFW_TOGGLE_LABELS[enabled ? 0 : 1];
    btn.title = enabled ? onTitle : offTitle;
}

// the picture a preview shows when its own will not load
const PREVIEW_PORTRAIT_FALLBACK = '/img/no-portrait.png';

/**
 * Base class for Online tab browse views.
 * Subclasses MUST override at least renderView().
 */
export class BrowseView {
    /**
     * @param {import('./provider-interface.js').ProviderBase} provider
     */
    constructor(provider) {
        this.provider = provider;
        this._initialized = false;
        this._modalsInjected = false;
        this._cardObserver = null;
        this._visibleCards = new Set(); // cards inside the observer's band right now
        this._fitGen = 0; // bumped by a grid width change; a row fit under an older gen refits on entry
        this._tagMetrics = null;
        this._gridResizeObserver = null;
        this._gridResizeHost = null;
        this._gridWidth = null;
        this._dropdownCloseHandler = null;
        this._scrollHandler = null;
        this._scrollIndicator = null;
        this._prefetching = false;
        this._preloadLimit = 48;
        this._lookup = {
            byProviderId: new Set(),
            probed: new Set(), // keys the link probe has answered this DOM lifetime
        };
        // Following manager state
        this._mgrOpen = false;
        this._mgrCreators = [];
        this._mgrFilter = '';
        this._mgrSort = 'name_asc';
        this._mgrDebounceTimer = null;
        this._mgrConfirmTimer = null;
    }

    // HTML Rendering

    /**
     * Return filter bar HTML for the topbar filters-wrapper area.
     * Called once; injected into #onlineFilterArea by the registry.
     * @returns {string}
     */
    renderFilterBar() { return ''; }

    /**
     * Return main view HTML (grids, search bars, etc.).
     * Called once; injected into #onlineView by the registry.
     * @returns {string}
     */
    renderView() { return ''; }

    /**
     * Return modal HTML to append to document.body.
     * Called once during first activation.
     * @returns {string}
     */
    renderModals() { return ''; }

    // Lifecycle

    /**
     * One-time setup after HTML has been injected into the DOM.
     * Subclasses attach event handlers here.
     */
    init() {
        this._initialized = true;
        wireBrowseScrollReset();
        if (this.supportsFollowingManager) {
            this._initFollowingManager();
        }
    }

    /**
     * Every time the Online tab shows this view; the first call runs init().
     * @param {HTMLElement} container - #onlineView element
     * @param {Object} [options]
     * @param {boolean} [options.domRecreated] - true when the registry rebuilt the DOM (provider switch)
     */
    activate(container, options = {}) {
        this._container = container;
        // a view with loadInitial or viewModes runs the base lifecycle; never fire those arms for one without
        const migrated = typeof this.loadInitial === 'function' || !!this.viewModes;
        const isReEntry = this._initialized && !options.domRecreated;
        if (options.domRecreated) {
            this._initialized = false;
            // a rebuilt DOM has no paint to be stale and no scope to return from
            this._staleModes?.clear();
            this._creatorScopeStash = null;
            this._creatorScopeReturnMode = null;
            // session filter/data vars reset BEFORE defaults apply, so defaults
            // always land on fresh state (the ordering bug class this kills)
            if (migrated) this.resetSessionState?.();
            // the link probe cache is DOM-scoped: the pages it answered for went with the grid
            this._lookup.byProviderId.clear();
            this._lookup.probed.clear();
        }
        // re-entry asks the probe again: a link made while the tab was parked shows on the next load
        this._lookup.probed.clear();
        if (!this._initialized) {
            this.injectModals();
            this.init();
        }
        if (options.domRecreated && options.defaults) {
            this.applyDefaults(options.defaults);
        }
        // a declared sub-sort sits beside the slot's stacked sorts, never over them
        const subSort = this.mobileFilterIds?.subSort ? document.getElementById(this.mobileFilterIds.subSort) : null;
        (subSort?._customSelect?.container || subSort)?.classList.add('browse-sub-sort');
        // Re-register dropdown dismiss after deactivate removed it
        if (this._dropdownDismissPairs && !this._dropdownCloseHandler) {
            this._registerDropdownDismiss(this._dropdownDismissPairs);
        }
        this._attachScrollListener();
        if (this.creatorDownloadEnabled()) {
            this._injectCreatorDownloadButton(container);
        }
        if (migrated) {
            // the lookup is fresh every activation; only re-entry needs the observer reconnected
            this.buildLocalLibraryLookup?.();
            if (isReEntry) this.reconnectImageObserver?.();
            // per-activation view state (delegate flags etc), with re-entry named
            // instead of every view re-deriving it wrongly from _initialized
            this.onActivated?.(isReEntry);
            this._dispatchCurrent();
        }
        if (isReEntry) void this.healOnReEntry();
    }

    /**
     * DOM-keyed populate: the element dies with the container while its data cache survives; a new marker repopulates.
     * @param {HTMLElement} el
     * @param {string} marker
     * @param {(el: HTMLElement) => void} render
     */
    ensurePopulated(el, marker, render) {
        if (!el || el.dataset.clPopulated === String(marker)) return;
        render(el);
        el.dataset.clPopulated = String(marker);
    }

    /**
     * The Browse/Following dual-mode contract, declared as data; the base owns the switching and the dispatch.
     * @returns {null | { modeAttr: string, current: () => string, set: (m: string) => void, onSwitch?: (m: string) => void, modes: Record<string, { sectionId: string, gridId: string, hasData: () => boolean, load: () => void, render: () => void, chrome?: () => void, enter?: () => any, reload?: boolean }> }}
     */
    get viewModes() { return null; }

    /**
     * Chrome-only mode flip, no dispatch: for a caller that issues its own load, so the base never races it.
     * @param {string} mode
     * @returns {boolean} true when the mode changed
     */
    snapViewMode(mode) {
        const vm = this.viewModes;
        const m = vm?.modes?.[mode];
        if (!m || vm.current() === mode) return false;
        this._applyModeChrome(vm, mode, m);
        return true;
    }

    _applyModeChrome(vm, mode, m) {
        vm.set(mode);
        document.querySelectorAll(`.browse-view-btn[${vm.modeAttr}]`).forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute(vm.modeAttr) === mode);
        });
        for (const [name, def] of Object.entries(vm.modes)) {
            document.getElementById(def.sectionId)?.classList.toggle('hidden', name !== mode);
        }
        vm.onSwitch?.(mode);
        m.chrome?.();
    }

    async switchViewMode(mode) {
        const vm = this.viewModes;
        const m = vm?.modes?.[mode];
        if (!m || vm.current() === mode) return;
        // a deliberate mode pick ends any pending return-to-mode a scope entry recorded
        this._creatorScopeReturnMode = null;
        // a toggle during an awaited enter() abandons the stale run: only the
        // newest switch may dispatch its load/render
        const gen = this._viewModeGen = (this._viewModeGen || 0) + 1;
        this._applyModeChrome(vm, mode, m);
        await m.enter?.();
        if (gen !== this._viewModeGen) return;
        this._dispatchMode(mode, m, { forceLoad: !!m.reload });
    }

    // one dispatch for activation, switching and reload: no data loads, unpainted or stale repaints, a painted grid is left alone
    _dispatchMode(name, m, { forceLoad = false, ...loadOpts } = {}) {
        const stale = !!this._staleModes?.delete(name);
        if (forceLoad || !m.hasData()) {
            // the load's promise (when the hook returns one) lets _triggerLoadMore hold its
            // prefetch gate for the real round trip instead of a fixed 300ms
            return this._creatorScopeActive(name) ? this.creatorScope.load(loadOpts) : m.load(loadOpts);
        }
        const grid = m.gridId ? document.getElementById(m.gridId) : null;
        if (stale || !grid?.querySelector('.browse-card')) m.render();
    }

    // The single-mode hook set (loadInitial / hasData / rerenderGrid / gridElementId)
    // shaped as a mode, so single- and dual-mode views take the same dispatch.
    _singleMode() {
        return {
            hasData: () => !!this.hasData?.(),
            load: (opts) => this.loadInitial(opts),
            render: () => this.rerenderGrid?.(),
            gridId: this.gridElementId,
        };
    }

    // The activation arm: the current mode for dual-mode views, the single mode for
    // the rest.
    _dispatchCurrent() {
        const vm = this.viewModes;
        if (vm) {
            const name = vm.current();
            // the markup draws browse unscoped, so the live mode's chrome lands before the first paint
            vm.modes[name].chrome?.();
            this._dispatchMode(name, vm.modes[name]);
            return;
        }
        this._dispatchMode('', this._singleMode());
    }

    /**
     * Reload whats showing, inside the creator scope when active: THE verb for every trigger, never a direct loader call.
     * @param {{ append?: boolean, force?: boolean }} [opts] handed to the load hook as is
     */
    reload(opts = {}) {
        const vm = this.viewModes;
        const name = vm ? vm.current() : '';
        return this._dispatchMode(name, vm ? vm.modes[name] : this._singleMode(), { forceLoad: true, ...opts });
    }

    /**
     * The creator scope, a filter inside one mode declared as data so every load routes through it.
     * @returns {null | { isActive: () => boolean, load: (opts?: { append?: boolean }) => any, clear: () => void, chrome?: (active: boolean) => void, bannerId?: string, mode?: string, stash?: () => any, restore?: (stashed: any) => void }}
     */
    get creatorScope() { return null; }

    _creatorScopeActive(modeName) {
        const scope = this.creatorScope;
        if (!scope?.isActive()) return false;
        return !this.viewModes || modeName === (scope.mode || 'browse');
    }

    /**
     * Enter the creator scope: stash (first entry only), snap to its mode, run setState, show the banner, load.
     * @param {() => void} [setState]
     */
    enterCreatorScope(setState) {
        const scope = this.creatorScope;
        if (!scope) return;
        const vm = this.viewModes;
        const scopeMode = scope.mode || 'browse';
        if (!scope.isActive()) {
            this._creatorScopeStash = scope.stash?.() ?? null;
            this._creatorScopeReturnMode = vm && vm.current() !== scopeMode ? vm.current() : null;
        }
        if (vm && vm.current() !== scopeMode) this.snapViewMode(scopeMode);
        setState?.();
        if (scope.bannerId) document.getElementById(scope.bannerId)?.classList.remove('hidden');
        scope.chrome?.(true);
        this.reload();
    }

    /**
     * Leave the creator scope: restore the stash, revert banner and chrome, then return or reload (unless the caller does).
     */
    clearCreatorScope({ reload = true } = {}) {
        const scope = this.creatorScope;
        if (!scope) return;
        scope.clear();
        this._cdRef = null;
        if (this._creatorScopeStash != null) scope.restore?.(this._creatorScopeStash);
        this._creatorScopeStash = null;
        if (scope.bannerId) document.getElementById(scope.bannerId)?.classList.add('hidden');
        scope.chrome?.(false);
        const back = this._creatorScopeReturnMode;
        this._creatorScopeReturnMode = null;
        // reload:false means the caller owns what happens next (a typed search leaving
        // the scope), so no return jump underneath it either
        if (!reload) return;
        if (back && this.viewModes?.modes?.[back]) { this.switchViewMode(back); return; }
        this.reload();
    }

    // The current mode's slice of the contract, or null for single-mode views.
    _currentViewMode() {
        const vm = this.viewModes;
        return vm ? vm.modes[vm.current()] : null;
    }

    /**
     * Mark every other mode's paint stale: render-time filters read shared state, so hidden grids repaint on entry.
     */
    markModesStale() {
        const vm = this.viewModes;
        if (!vm) return;
        this._staleModes ??= new Set();
        const cur = vm.current();
        for (const name of Object.keys(vm.modes)) if (name !== cur) this._staleModes.add(name);
    }

    /**
     * The filter driver bound to this view: predicate rows mark the other modes stale, opts.badge runs after sync and every change.
     * @param {Array<object>} table
     * @param {object} state
     * @param {(f: object, e: Event) => any} onChange
     * @param {{ beforeChange?: Function, badge?: Function }} [opts]
     */
    wireFeatureFilters(table, state, onChange, { beforeChange, badge } = {}) {
        // applyDefaults ticks the Library rows from these
        this._featureTable = table;
        this._featureState = state;
        this._featureBadge = badge;
        wireFeatureFilters(table, state, (f, e) => {
            badge?.();
            const result = onChange?.(f, e);
            // after the handler's synchronous part, so a snap inside it names the
            // right current mode
            if (f.nodeTest || f.exclude) this.markModesStale();
            return result;
        }, { beforeChange });
        badge?.();
    }

    /**
     * Apply saved defaults once per rebuild: snap the view (no dispatch) and tick the Library rows; subclasses call super, then set sort.
     * @param {Object} defaults - { view?: string, sort?: string, hideOwned?: boolean, hidePossible?: boolean }
     */
    applyDefaults(defaults) {
        if (defaults?.view) this.snapViewMode(defaults.view);
        let ticked = false;
        for (const key of ['hideOwned', 'hidePossible']) {
            const row = defaults?.[key] && this._featureTable?.find(r => r.key === key);
            if (!row) continue;
            this._featureState[key] = true;
            const el = document.getElementById(row.id);
            if (el) el.checked = true;
            ticked = true;
        }
        if (ticked) this._featureBadge?.();
    }

    // Search contract (mobile FAB overlay)

    /** @returns {Array<'character' | 'creator' | 'lorebook'>} */
    getSearchModes() { return ['character']; }

    /** @returns {string | null} DOM id of the inline input to proxy. */
    getSearchInputId(mode) { return null; }

    /** @returns {string} placeholder for the mobile search overlay input. */
    getSearchPlaceholder(mode) {
        return mode === 'creator' ? 'Creator name...' : 'Character name...';
    }

    /** @returns {string} tab label for the mobile search overlay mode. */
    getSearchModeLabel(mode) {
        return mode === 'creator' ? 'Creator' : 'Character';
    }

    /** Default proxies through the inline input + submit button (or Enter). */
    performSearch(mode, query) {
        const inputId = this.getSearchInputId(mode);
        if (!inputId) return;
        const input = document.getElementById(inputId);
        if (!input) return;
        input.value = query;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const submitBtn = input.parentElement?.querySelector('.browse-search-submit');
        if (submitBtn) {
            submitBtn.click();
        } else {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }
    }

    /**
     * Leaving this view: release the card observer and the dismiss and scroll listeners; subclasses call super and abort fetches.
     */
    deactivate() {
        this.disconnectImageObserver();
        this._removeDropdownDismiss();
        this._detachScrollListener();
        this._gridResizeObserver?.disconnect();
        this._gridResizeHost = null;
        this._gridWidth = null;
        this._tagMetrics = null;
        // Reset manager state for clean re-activation
        this._mgrOpen = false;
        clearTimeout(this._mgrDebounceTimer);
        clearTimeout(this._mgrConfirmTimer);
        // Reset any in-progress unfollow confirmation
        const pid = this.provider.id;
        const list = document.getElementById(`${pid}FollowMgrList`);
        if (list) {
            for (const btn of list.querySelectorAll('.follow-mgr-unfollow-btn[data-confirming]')) {
                delete btn.dataset.confirming;
                btn.classList.remove('confirming');
                btn.title = 'Unfollow';
                btn.innerHTML = '<i class="fa-solid fa-user-minus"></i>';
            }
        }
    }

    // Library Lookup

    /**
     * The shared name half of the lookup; both halves fill per page from the probes.
     */
    buildLocalLibraryLookup() {
        ensureSharedBaseLookup();

        CoreAPI.debugLog(`[${this.provider.name}] Library lookup built:`,
            'matches answered:', _sharedBaseLookup.answers.size);
    }

    /**
     * The provider ids this view's links live under (an override adds a legacy provider's rows).
     * @returns {string[]}
     */
    get linkProviders() { return [this.provider.id]; }

    /**
     * The key a hit is tested under in byProviderId (an id string, or a path); null when it has none.
     * @param {Object} hit
     * @returns {string|null}
     */
    hitLinkKey(hit) { return null; }

    /**
     * The name, creator and site text a hit is scored by, asked before render; null when none.
     * @param {Object} hit
     * @returns {{name: string, creator: string, text?: string}|null}
     */
    hitMatchName(hit) { return null; }

    /** hitMatchName with the listing the hit is, so the score knows its own site's other listings; null when none. */
    matchFor(hit) {
        const m = this.hitMatchName(hit);
        return m?.name ? { ...m, listing: this.listingFor(this.hitLinkKey(hit)) } : m;
    }

    /** A link key as the listing the match probe sends (the providers this view links under); null without one. */
    listingFor(key) {
        return key == null || key === '' ? null : { providers: this.linkProviders, key: String(key) };
    }

    /**
     * Ask how likely each card is already here and keep the scores; a failed POST marks nothing.
     * @param {Array<{name: string, creator?: string, text?: string, listing?: {providers: string[], key: string}|null}>} hits
     * @returns {Promise<boolean>} whether every one asked was answered
     */
    async probeMatchesFor(hits) {
        ensureSharedBaseLookup();
        const { answers, asked } = _sharedBaseLookup;
        const kept = _sharedBaseLookup.hits;
        const wanted = new Map();
        for (const h of hits || []) {
            if (!nameKey(h?.name)) continue;
            const key = matchKey(h.name, h.creator, h.listing);
            if (wanted.has(key)) continue;
            const text = h.text ? String(h.text).slice(0, HIT_TEXT_MAX) : (kept.get(key)?.text || '');
            // asked already, unless this ask brings a text the last one lacked (one forgotten past the cap came back without it)
            if (asked.has(key) && (!text || kept.get(key)?.text)) continue;
            const ask = { name: String(h.name), creator: String(h.creator || ''), ...(text ? { text } : {}), ...(h.listing?.key ? { providers: h.listing.providers, key: h.listing.key } : {}) };
            wanted.set(key, ask);
            kept.delete(key);
            kept.set(key, ask);
        }
        // past the cap the oldest asks are forgotten whole, never one this ask carries
        while (kept.size > HITS_KEPT) {
            const oldest = kept.keys().next().value;
            if (wanted.has(oldest)) break;
            kept.delete(oldest);
            answers.delete(oldest);
            _sharedBaseLookup.bases.delete(oldest);
            asked.delete(oldest);
        }
        if (!wanted.size) return true;
        const gen = _baseLookupGen;
        const list = [...wanted];
        for (let i = 0; i < list.length; i += PROBE_PAGE) {
            const chunk = list.slice(i, i + PROBE_PAGE);
            try {
                const resp = await CoreAPI.apiRequest('/characters/match', 'POST', { candidates: chunk.map(([, hit]) => hit) });
                if (!resp.ok) throw new Error(`characters/match ${resp.status}`);
                const graded = await resp.json();
                if (gen !== _baseLookupGen) return false;
                chunk.forEach(([key], j) => {
                    answers.set(key, Number(graded?.[j]?.score) || 0);
                    if (graded?.[j]?.basis) _sharedBaseLookup.bases.set(key, graded[j].basis);
                    else _sharedBaseLookup.bases.delete(key);
                    asked.add(key);
                });
            } catch (err) {
                CoreAPI.debugLog(`[${this.provider.name}] match probe failed (asked again next load):`, err);
                return false;
            }
        }
        return true;
    }

    /** A page's hits through hitMatchName, then probeMatchesFor. */
    async probeNames(hits) {
        const wanted = [];
        for (const h of hits || []) {
            const m = this.matchFor(h);
            if (m?.name) wanted.push(m);
        }
        if (wanted.length) await this.probeMatchesFor(wanted);
    }

    /**
     * Probe a page's links and names BEFORE it is filtered or rendered: the hide-owned row reads byProviderId.
     * @param {Object[]} hits
     */
    async probeHits(hits) {
        await this.probeNames(hits);
        const { probed } = this._lookup;
        const keys = [];
        const seen = new Set();
        for (const h of hits || []) {
            const k = this.hitLinkKey(h);
            if (k == null || k === '' || probed.has(k) || seen.has(k)) continue;
            seen.add(k);
            keys.push(k);
        }
        await this.probeLinkKeys(keys);
    }

    /**
     * Ask which of these keys are linked here, PROBE_PAGE to a POST; a failed POST marks nothing.
     * @param {string[]} keys
     */
    async probeLinkKeys(keys) {
        const { byProviderId, probed } = this._lookup;
        for (let i = 0; i < keys.length; i += PROBE_PAGE) {
            const chunk = keys.slice(i, i + PROBE_PAGE);
            try {
                const resp = await CoreAPI.apiRequest('/provider-links/probe', 'POST', { providers: this.linkProviders, keys: chunk });
                if (!resp.ok) throw new Error(`provider-links/probe ${resp.status}`);
                const { found } = await resp.json();
                // the answer is authoritative for every key asked: a character deleted since
                // the last ask leaves the set instead of keeping its badge
                const hit = new Set(found || []);
                for (const k of chunk) {
                    probed.add(k);
                    if (hit.has(k)) byProviderId.add(k);
                    else byProviderId.delete(k);
                }
            } catch (err) {
                CoreAPI.debugLog(`[${this.provider.name}] link probe failed (asked again next load):`, err);
                return;
            }
        }
    }

    /**
     * The data-link-key stamp a card carries, so the heal reads the key the render read.
     * @param {Object} hit
     * @returns {string}
     */
    linkKeyAttr(hit) {
        const key = this.hitLinkKey(hit);
        return key == null || key === '' ? '' : ` data-link-key="${CoreAPI.escapeHtml(key)}"`;
    }

    /**
     * Whether a key is linked here, as the probe answered it (markLinked's keys included).
     * @param {string|number|null} key
     * @returns {boolean}
     */
    isInLibrary(key) {
        return key != null && key !== '' && this._lookup.byProviderId.has(String(key));
    }

    /**
     * Whether a hit is linked here, through its hitLinkKey: the one key render, filters and heal all read.
     * @param {Object} hit
     * @returns {boolean}
     */
    isHitInLibrary(hit) {
        return hit != null && this.isInLibrary(this.hitLinkKey(hit));
    }

    /**
     * The reader's exclude tags for this provider, under the manifest's excludeTagKey (jannyai keeps 'janny').
     * @returns {string[]}
     */
    persistentExcludeTags() {
        const p = this.provider;
        return CoreAPI.getProviderExcludeTags(p?.manifest?.excludeTagKey || p?.id) || [];
    }

    /** A character that just became linked to this provider lights its badge without a probe. */
    markLinked(char) {
        const link = this.provider?.getLinkInfo?.(char);
        if (!link) return;
        for (const k of [link.id, link.fullPath]) {
            if (k == null || k === '') continue;
            this._lookup.byProviderId.add(String(k));
            this._lookup.byProviderId.add(String(k).toLowerCase());
        }
    }

    /**
     * A skipped import from this view joins the lookup; one the command took in arrives via adoptCharacterInBrowseLookups.
     * @param {Object} char - the character as the library holds it
     */
    addCharToLookup(char) {
        if (!char) return;
        adoptNameIntoSharedBase(char);
        this.markLinked(char);
    }

    /**
     * The server's possible-match score (0-100) for a name and creator; one never asked reads 0 and is asked now.
     * @param {string} [text] the site's text for the card, asked with when the last ask lacked it
     * @param {{providers: string[], key: string}|null} [listing] the listing the card is (listingFor)
     */
    getPossibleMatchScore(name, creator, text = '', listing = null) {
        ensureSharedBaseLookup();
        if (!nameKey(name)) return 0;
        const key = matchKey(name, creator, listing);
        const { answers, asked } = _sharedBaseLookup;
        // a score held from before a library change is shown while it is asked again (the probe adds the text it was asked with)
        if (!asked.has(key) || (text && !_sharedBaseLookup.hits.get(key)?.text)) this._askLater(key, { name, creator: creator || '', ...(text ? { text } : {}), listing });
        return answers.get(key) ?? 0;
    }

    /**
     * A hit's possible-match tier, read by the name and creator its view asks the server with (hitMatchName).
     * @param {Object} hit
     */
    possibleMatchTierFor(hit) {
        const m = this.matchFor(hit);
        return m?.name ? this.getPossibleMatchTier(m.name, m.creator, m.text, m.listing) : { show: false, tier: '', tooltip: '' };
    }

    /**
     * What a hit's possible-match badge flagged, as pre-import matches: the namesakes the server's hint relates, exact ones first.
     * Empty when the hit shows no badge.
     * @param {Object} hit
     */
    async badgeMatchesFor(hit) {
        const m = this.matchFor(hit);
        if (!m?.name || !this.possibleMatchTierFor(hit).show) return [];
        const ask = { name: String(m.name), creator: String(m.creator || ''), ...(m.text ? { text: String(m.text).slice(0, HIT_TEXT_MAX) } : {}), ...(m.listing?.key ? { providers: m.listing.providers, key: m.listing.key } : {}) };
        const resp = await CoreAPI.apiRequest('/characters/match', 'POST', { candidates: [ask] });
        if (!resp.ok) return [];
        const [answer] = await resp.json();
        const ids = (answer?.matches || []).slice().sort((x, y) => (x.relation === 'exact' ? 0 : 1) - (y.relation === 'exact' ? 0 : 1)).map(x => x.id).slice(0, 5);
        if (!ids.length) return [];
        const score = Number(answer.score) || 0;
        return (await CoreAPI.fetchCharactersByIds(ids)).filter(Boolean).map(char => ({
            id: char.id, char, score, confidence: 'low', textCompared: false, breakdown: {},
            matchReason: 'Flagged as a possible match in the browser; its text could not confirm it',
        }));
    }

    /** Whether a hit shows as a possible match, by the key it was asked with. */
    isHitPossibleMatch(hit) {
        return this.possibleMatchTierFor(hit).show;
    }

    /** The data-match stamp a card carries, so the badge heal reads the key the render read. */
    matchAttr(hit) {
        const m = this.hitMatchName(hit);
        return m?.name ? ` data-match-name="${CoreAPI.escapeHtml(m.name)}" data-match-creator="${CoreAPI.escapeHtml(m.creator || '')}"` : '';
    }

    // a score read before anyone asked for it: asked in one batch at the end of the task
    _askLater(key, hit) {
        (this._askQueue ??= new Map()).set(key, hit);
        if (this._askQueued) return;
        this._askQueued = true;
        queueMicrotask(() => { this._askQueued = false; this._flushAsks(); });
    }

    /** Ask what the reads queued, then heal the painted badges and the open preview with the answers. */
    async _flushAsks() {
        if (!this._askQueue?.size) return;
        const hits = [...this._askQueue.values()];
        this._askQueue.clear();
        if (!await this.probeMatchesFor(hits)) return;
        this._gradePossibleBadges(this.libraryBadgeGridIds);
        this._previewRestamp?.();
    }

    /**
     * Graded badge data for a browse card: whether to show it, the intensity tier, the tooltip.
     * @returns {{show: boolean, tier: string, tooltip: string}}
     */
    getPossibleMatchTier(name, creator, text = '', listing = null) {
        const score = this.getPossibleMatchScore(name, creator, text, listing);
        if (!score || score < getPossibleMatchMinScore()) return { show: false, tier: '', tooltip: '' };
        // a namesake on another listing of this site that no text placed: the dim tier, saying why
        if (_sharedBaseLookup.bases.get(matchKey(name, creator, listing)) === 'otherListing') return { show: true, tier: 'low', tooltip: 'Possible match: another listing on this site, its description does not confirm it' };
        if (score >= POSSIBLE_MATCH_TIER_HIGH) return { show: true, tier: 'high', tooltip: 'Very likely in your library' };
        if (score >= POSSIBLE_MATCH_TIER_MED) return { show: true, tier: 'med', tooltip: 'Likely the same character' };
        return { show: true, tier: 'low', tooltip: 'Possible match (same name)' };
    }

    /**
     * Forget the probed answers after a library change; the painted view re-asks its held keys at once and heals.
     * @param {{shown?: boolean}} [opts]
     */
    async rebuildLocalLibraryLookup({ shown = false } = {}) {
        const held = shown ? [...new Set([...this._lookup.probed, ...this._lookup.byProviderId])] : [];
        this._lookup.probed.clear();
        this.buildLocalLibraryLookup();
        // a parked view keeps its found keys and re-asks them on re-entry (healOnReEntry)
        this._lookupStale = !shown;
        if (!shown) return;
        await this.probeLinkKeys(held);
        this.refreshInLibraryBadges();
    }

    /**
     * After a library change while parked: re-ask every held link and heal the painted cards.
     */
    async healOnReEntry() {
        if (!this._lookupStale) return;
        this._lookupStale = false;
        await this.probeLinkKeys([...this._lookup.byProviderId]);
        this.refreshInLibraryBadges();
    }

    /**
     * Possible-match tier for a rendered card in the re-grade; views with other markup (or no name grading) override.
     * @param {HTMLElement} card - Rendered .browse-card
     * @param {string} name - Card's character name
     * @returns {{show: boolean}} Tier object from getPossibleMatchTier
     */
    _cardPossibleTier(card, name) {
        const listing = this.listingFor(card.dataset.linkKey);
        if ('matchCreator' in card.dataset) return this.getPossibleMatchTier(name, card.dataset.matchCreator, '', listing);
        const creatorEl = card.querySelector('.browse-card-creator-link');
        const creator = creatorEl?.dataset.author || creatorEl?.dataset.creatorName || '';
        return this.getPossibleMatchTier(name, creator, '', listing);
    }

    /** The grids whose cards the badge heal walks: the image grids, unless a view keeps more painted. */
    get libraryBadgeGridIds() { return this._getImageGridIds(); }

    /**
     * Heal the rendered cards' badges: links from each card's stamped key both ways, then each card's score, any it lacks asked and healed.
     * @param {string[]} [gridIds]
     * @returns {Promise<void>} settled once the scores the grade lacked are answered and graded
     */
    refreshInLibraryBadges(gridIds = this.libraryBadgeGridIds) {
        this._healLinkedBadges(gridIds);
        this._gradePossibleBadges(gridIds);
        // the open preview's button reads the same lookup the cards do
        this._previewRestamp?.();
        return this._flushAsks();
    }

    /**
     * Register the open preview's restamp (null at close); the base reruns it after every heal and lane move.
     * @param {Function|null} restamp
     * @param {Object|null} [hit] - the row the preview shows
     */
    trackPreview(restamp, hit = null) {
        this._previewRestamp = typeof restamp === 'function' ? restamp : null;
        this._previewHit = this._previewRestamp ? hit : null;
        // a stamp that ran before the row was known read the previous preview's row (a view
        // stamps, then registers): stamped again, it reads this one
        this._previewRestamp?.();
        // a row no page asked about (View on Provider from details) probes its own key
        const key = this._previewHit ? this.hitLinkKey(this._previewHit) : null;
        if (key == null || key === '' || this._lookup.probed.has(key)) return;
        const asked = this._previewRestamp;
        this.probeLinkKeys([key]).then(() => { if (this._previewRestamp === asked) asked(); });
    }

    /**
     * Stamp a preview's import button from the library as it stands: In Library by the hit's link, a possible match by its score.
     * @param {HTMLElement|null} btn
     * @param {Object} hit the row the preview shows
     */
    stampPreviewImport(btn, hit) {
        const inLibrary = this.isHitInLibrary(hit);
        this.stampImportButton(btn, { inLibrary, possibleMatch: !inLibrary && this.isHitPossibleMatch(hit) });
    }

    /**
     * The import button's states (In Library, possible match, Import, plus the lane's); a button importFromPreview holds is left alone.
     * @param {HTMLElement|null} btn
     * @param {{ inLibrary?: boolean, possibleMatch?: boolean }} state
     */
    stampImportButton(btn, { inLibrary = false, possibleMatch = false } = {}) {
        if (!btn || btn === this._busyButton) return;
        if (!inLibrary && this.stampImportInFlight(btn, this._previewHit)) return;
        if (inLibrary) {
            btn.innerHTML = '<i class="fa-solid fa-check"></i> In Library';
            btn.classList.add('cl-btn-secondary');
            btn.classList.remove('cl-btn-primary', 'cl-btn-warning');
        } else if (possibleMatch) {
            btn.innerHTML = '<i class="fa-solid fa-download"></i> Import (Possible Match)';
            btn.classList.add('cl-btn-warning');
            btn.classList.remove('cl-btn-primary', 'cl-btn-secondary');
        } else {
            btn.innerHTML = '<i class="fa-solid fa-download"></i> Import';
            btn.classList.add('cl-btn-primary');
            btn.classList.remove('cl-btn-secondary', 'cl-btn-warning');
        }
        btn.disabled = false;
    }

    /**
     * Stamp a row on its way (Queued, or the run's verb), disabled; no title, since a view's own states never clear one.
     * @returns {boolean} whether the button is spoken for: the row in flight, or the button importFromPreview holds
     */
    stampImportInFlight(btn, hit) {
        if (btn && btn === this._busyButton) return true;
        const entry = this.importInFlight(hit);
        if (!btn || !entry) return false;
        const running = entry.status === 'running';
        btn.innerHTML = running
            ? `<i class="fa-solid fa-spinner fa-spin"></i> ${CoreAPI.escapeHtml(entry.verb)}...`
            : '<i class="fa-solid fa-clock"></i> Queued';
        btn.classList.add('cl-btn-primary');
        btn.classList.remove('cl-btn-secondary', 'cl-btn-warning');
        btn.disabled = true;
        return true;
    }

    /** The background import this view has in flight for a row, or null. */
    importInFlight(hit) {
        return hit ? findImport(this, this.hitLinkKey(hit)) : null;
    }

    /** Every background import this view has in flight, the running one first. */
    importsInFlight() {
        return importsOf(this);
    }

    /** The spinner badge for a card template: '' unless the row is on its way. */
    importingBadge(hit) {
        return hit ? importingBadge(this, this.hitLinkKey(hit)) : '';
    }

    /**
     * The provider page a finished import's gallery comes from, for the summary; null when the provider keeps no gallery.
     * @param {Object} result - the ProviderImportResult
     * @returns {string|null}
     */
    galleryUrlFor(result) { // eslint-disable-line no-unused-vars
        return null;
    }

    /**
     * A Creator Download adapter's answer for a landed import (alreadyPresent counts with the skips, no media queued).
     * @returns {{ ok: true, charId: string, alreadyPresent: boolean, summaryArgs: Object, result: Object }}
     */
    creatorImportAnswer(result, provider) {
        return { ok: true, charId: result.id, alreadyPresent: !!result.alreadyPresent, summaryArgs: this.importSummaryArgs(result, provider), result };
    }

    /**
     * The import summary's args for one import: its gallery row and its media row, when present.
     * @param {Object} result - the ProviderImportResult
     * @param {Object} provider - the provider it came through
     */
    importSummaryArgs(result, provider) {
        const url = result.hasGallery ? this.galleryUrlFor(result) : null;
        return {
            galleryCharacters: url ? [{
                name: result.characterName,
                fullPath: result.fullPath,
                provider,
                // a gallery download reads the link's id (fetchGalleryImages)
                linkInfo: { id: result.providerCharId, fullPath: result.fullPath },
                url,
                id: result.id,
                cardData: result.cardData,
            }] : [],
            mediaCharacters: cdHasMedia(result) ? [cdMediaEntry(result)] : [],
        };
    }

    /**
     * The preview's Import, every view's: the duplicate check, the dialog, then the import (on the lane when background imports are on).
     * @param {Object} spec
     * @param {HTMLElement|null} spec.button - the preview's import button
     * @param {Object} spec.hit - the row the preview shows (the tail lights its card)
     * @param {string} spec.provider - the provider id
     * @param {*} spec.id - the character's identifier there
     * @param {Object|null} [spec.data] - what the view already fetched
     * @param {Object} [spec.options] - the provider's own import options
     * @param {Object} spec.probe - the duplicate check's fields (name, creator, fullPath, the texts)
     * @param {Object} spec.dialog - the dialog's line for it (name, creator, fullPath, avatarUrl)
     * @param {Function} spec.closePreview
     * @param {Function} [spec.prepare] - awaited once the button is held: may answer id, data, options, probe, dialog, name, background, verb, meta, or { cancel: true }
     * @param {Function} [spec.ready] - awaited once the dialog answered, before the import leaves: may answer id, data, options, background, verb, meta
     * @param {boolean} [spec.background] - the lane even with background imports off (minutes of work)
     * @param {string} [spec.verb] - what the lane's button and row say while it runs ('Importing')
     * @param {Object} [spec.meta] - the view's own note on the entry, read back by importRowStatus
     * @param {string} [spec.label] - the console's name for it
     * @returns {Promise<Object|null>} the import's result; null when skipped, queued or failed
     */
    async importFromPreview(spec) {
        const { button = null, hit, provider, closePreview, label = provider } = spec;
        // a run already holds this button: a second press would take its dialog and leave the first hanging
        if (button && button === this._busyButton) return null;
        const original = button?.innerHTML;
        const wasDisabled = !!button?.disabled;
        const say = (html) => { if (button) button.innerHTML = html; };
        if (button) button.disabled = true;
        // held until the import lets go: a heal under the open dialog would re-enable it
        const held = !!button && this._busyButton !== button;
        if (held) this._busyButton = button;
        say('<i class="fa-solid fa-spinner fa-spin"></i> Checking...');
        try {
            // the lane refuses the same card twice
            if (this.importInFlight(hit)) {
                CoreAPI.showToast('That character is already on its way', 'info');
                return null;
            }
            const job = { ...spec, ...(spec.prepare ? await spec.prepare() : {}) };
            if (job.cancel) return null;
            const { id, data = null, options = {}, probe, dialog } = job;
            const source = CoreAPI.getProvider(provider);
            if (!source?.importCharacter) throw new Error(`the ${provider} provider is not available`);
            let onExisting = null;
            // the probe names its provider (the view's, unless it named its own): the loose path match stays inside it
            let matches = [];
            try {
                matches = await CoreAPI.checkCharacterForDuplicatesAsync({ ...probe, providerId: probe?.providerId || provider });
            } catch (err) {
                say('<i class="fa-solid fa-exclamation-triangle"></i> Check failed...');
                const go = await CoreAPI.showConfirm({
                    title: 'Duplicate check failed',
                    message: `Could not check whether "${dialog?.name || probe?.name || 'this character'}" is already in your library: ${err?.message || err}. Import it anyway?`,
                    icon: 'fa-solid fa-triangle-exclamation',
                    confirmLabel: 'Import Anyway',
                });
                if (go !== true) {
                    CoreAPI.showToast('Import cancelled', 'info');
                    return null;
                }
            }
            // a badged card is never imported unasked: the full check found nothing, so the badge's namesakes are shown, unconfirmed
            if (!matches?.length) matches = await this.badgeMatchesFor(hit).catch(() => []);
            if (matches?.length) {
                say('<i class="fa-solid fa-exclamation-triangle"></i> Duplicate found...');
                const answer = await CoreAPI.showPreImportDuplicateWarning(dialog, matches);
                if (answer.choice === 'skip') {
                    CoreAPI.showToast('Import cancelled', 'info');
                    return null;
                }
                if (answer.choice === 'import') onExisting = 'copy';
                if (answer.choice === 'replace') onExisting = { replace: (answer.selectedMatch?.char || matches[0].char).id };
            }
            const go = { id, data, options, background: job.background, verb: job.verb, meta: job.meta, ...(job.ready ? await job.ready() : {}) };
            if (go.background || CoreAPI.getSetting('backgroundImports') !== false) {
                // asked again: the same card may have joined while the dialog was open
                if (this.importInFlight(hit)) {
                    CoreAPI.showToast('That character is already on its way', 'info');
                    return null;
                }
                enqueueImport({
                    view: this, provider, source, hit, linkKey: this.hitLinkKey(hit), id: go.id, data: go.data ?? null, options: go.options || {}, onExisting,
                    name: job.name || probe?.name || dialog?.name || 'Character', verb: go.verb, meta: go.meta, label,
                });
                closePreview?.();
                return null;
            }
            say('<i class="fa-solid fa-spinner fa-spin"></i> Importing...');
            const result = await importThroughCommand(source, go.id, go.data ?? null, { ...(go.options || {}), onExisting });
            if (!result.success) throw new Error(result.error || 'Import failed');
            const summaryArgs = this.importSummaryArgs(result, source);
            const showSummary = (summaryArgs.galleryCharacters.length > 0 || summaryArgs.mediaCharacters.length > 0)
                && CoreAPI.getSetting('importMediaAction') !== 'none';
            await finishBrowseImport({
                view: this, summaryArgs, showSummary, closePreview, importBtn: button,
                characterName: result.characterName, localCharId: result.id,
                alreadyPresent: result.alreadyPresent, replaced: result.replaced, skippedReason: result.skippedReason, hit,
            });
            return result;
        } catch (e) {
            console.error(`[${label}] Import failed:`, e);
            CoreAPI.showToast(`Import failed: ${e.message}`, 'error');
            return null;
        } finally {
            if (held) this._busyButton = null;
            if (button) {
                button.disabled = wasDisabled;
                button.innerHTML = original;
                // the row may have moved meanwhile: stamp it as it stands now, not as at the click
                if (held) this._previewRestamp?.();
            }
        }
    }

    // The bottom badge row (never the top-left source badges datacat keeps in the same class),
    // made when asked for and missing.
    _badgesOf(card, create) {
        const sel = '.browse-feature-badges:not(.browse-feature-badges-tl)';
        let badgesEl = card.querySelector(sel);
        if (!badgesEl && create) {
            card.querySelector('.browse-card-image')?.insertAdjacentHTML('beforeend', '<div class="browse-feature-badges"></div>');
            badgesEl = card.querySelector(sel);
        }
        return badgesEl;
    }

    _healLinkedBadges(gridIds) {
        const { byProviderId } = this._lookup;
        for (const gridId of gridIds) {
            for (const card of document.getElementById(gridId)?.querySelectorAll('.browse-card') || []) {
                const key = card.dataset.linkKey;
                const linked = !!key && byProviderId.has(key);
                if (linked === card.classList.contains('in-library')) continue;
                card.classList.toggle('in-library', linked);
                if (!linked) {
                    this._badgesOf(card, false)?.querySelector('.browse-feature-badge.in-library')?.remove();
                    continue;
                }
                card.classList.remove('possible-library');
                const badgesEl = this._badgesOf(card, true);
                if (!badgesEl) continue;
                badgesEl.querySelector('.possible-library')?.remove();
                badgesEl.insertAdjacentHTML('afterbegin', libraryBadgeHtml(true));
            }
        }
    }

    _gradePossibleBadges(gridIds) {
        for (const gridId of gridIds) {
            for (const card of document.getElementById(gridId)?.querySelectorAll('.browse-card:not(.in-library)') || []) {
                // name-split providers (wyvern, chartavern) stamp the scoring name; healing by listing title killed their badges
                const name = card.dataset.matchName || card.querySelector('.browse-card-name')?.textContent || '';
                const tier = this._cardPossibleTier(card, name);
                const existing = this._badgesOf(card, false)?.querySelector('.possible-library');
                if (!tier.show) {
                    card.classList.remove('possible-library');
                    existing?.remove();
                    continue;
                }
                card.classList.add('possible-library');
                const badgesEl = this._badgesOf(card, true);
                if (!badgesEl) continue;
                if (existing) {
                    existing.className = `browse-feature-badge possible-library pl-${tier.tier}`;
                    existing.title = tier.tooltip;
                } else {
                    badgesEl.insertAdjacentHTML('afterbegin', libraryBadgeHtml(false, tier));
                }
            }
        }
    }

    // Card visibility gate: images + tag rows

    /**
     * Grid element IDs this view uses for card rendering.
     * Used by reconnectImageObserver() to find and re-observe cards.
     * @returns {string[]}
     */
    _getImageGridIds() { return []; }

    /**
     * Load one card image. The one override point for a paced pipeline (botbooru's
     * rate-limited queue); the base loads immediately.
     * @param {HTMLImageElement} img
     * @param {string} src
     * @returns {boolean} whether a load was started
     */
    loadCardImage(img, src) {
        BrowseView.loadImage(img, src);
        return true;
    }

    /**
     * The one observer per view: every per-card layout cost (image, tag fit) runs only for cards in the band.
     */
    _ensureCardObserver() {
        if (this._cardObserver) return;
        this._cardObserver = new IntersectionObserver((entries) => {
            const entered = [];
            for (const entry of entries) {
                const card = entry.target;
                if (!entry.isIntersecting) { this._visibleCards.delete(card); continue; }
                this._visibleCards.add(card);
                this._loadCardImageIfNeeded(card);
                if (card.dataset.tagsFit !== String(this._fitGen)) entered.push(card);
            }
            if (entered.length) this._fitCardRows(entered);
        // Modest image lookahead, deliberately NOT the multi-viewport card-fetch buffer: decoding
        // a viewport-scaled band of images ahead is what chugged large-avatar grids (hampter).
        }, { rootMargin: '600px' });
    }

    _loadCardImageIfNeeded(card) {
        const img = card.querySelector('.browse-card-image:not(.loaded) img[data-src]');
        if (!img || img.dataset.failed) return;
        const realSrc = img.dataset.src;
        if (realSrc && img.src !== realSrc) this.loadCardImage(img, realSrc);
    }

    /**
     * Refit the band's cards on a grid width change; the rest go stale and refit on their next entry.
     * @param {HTMLElement} container the grid the cards were just rendered into
     */
    _watchGridWidth(container) {
        if (typeof ResizeObserver !== 'function') return;
        if (!this._gridResizeObserver) {
            this._gridResizeObserver = new ResizeObserver((entries) => {
                // a hidden grid reports 0 and a re-shown one its old width; neither is a change
                const w = Math.round(entries[entries.length - 1].contentRect.width);
                if (!w || w === this._gridWidth) return;
                const first = this._gridWidth == null;
                this._gridWidth = w;
                if (!first) this._refitVisibleRows();
            });
        }
        if (this._gridResizeHost !== container) {
            if (this._gridResizeHost) this._gridResizeObserver.unobserve(this._gridResizeHost);
            this._gridResizeObserver.observe(container);
            this._gridResizeHost = container;
            this._gridWidth = null;
        }
    }

    _refitVisibleRows() {
        this._fitGen++;
        this._tagMetrics = null;
        if (this._visibleCards.size) this._fitCardRows([...this._visibleCards]);
    }

    // the gap and "+N" pill widths (three probes, one layout), measured once per grid width
    _tagFitMetrics(row) {
        if (this._tagMetrics) return this._tagMetrics;
        const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
        const probes = ['+9', '+99', '+999'].map(txt => { const p = document.createElement('span'); p.className = 'browse-card-tag is-more'; p.textContent = txt; row.appendChild(p); return p; });
        const pillWidths = probes.map(p => p.getBoundingClientRect().width);
        for (const p of probes) p.remove();
        this._tagMetrics = { gap, pillFor: (n) => pillWidths[Math.min(String(n).length, 3) - 1] };
        return this._tagMetrics;
    }

    /**
     * Whole tags or none: a row keeps the tags that fit on one line plus a "+N" pill; a hidden row (0 wide) is skipped.
     * @param {Element[]} cards
     */
    _fitCardRows(cards) {
        const gen = String(this._fitGen);
        const rows = [];
        for (const card of cards) {
            card.dataset.tagsFit = gen;
            const row = card.querySelector('.browse-card-tags');
            if (row) rows.push(row);
        }
        if (!rows.length) return;
        // write: everything visible again, so the measure is of whole tags
        for (const row of rows) {
            row.querySelector('.browse-card-tag.is-more')?.remove();
            for (const t of row.children) t.classList.remove('is-overflow');
        }
        const first = rows.find(r => r.clientWidth > 0);
        if (!first) return;
        const { gap, pillFor } = this._tagFitMetrics(first);
        // fractional widths throughout (offsetWidth rounds, and a half pixel is a cut tag)
        const width = (el) => el.getBoundingClientRect().width;
        // read: every row's width and every tag's natural width in one layout
        const measured = rows.map(row => ({ row, avail: row.clientWidth ? width(row) : 0, tags: Array.from(row.children, t => [t, width(t)]), total: +row.dataset.tagTotal || row.children.length }));
        // write: hide what would not fit whole, append the count
        for (const { row, avail, tags, total } of measured) {
            if (!avail || !tags.length) continue;
            const unrendered = Math.max(0, total - tags.length);
            let keep = tags.length, x = 0;
            for (let i = 0; i < tags.length; i++) {
                const needed = x + (i ? gap : 0) + tags[i][1];
                const rest = tags.length - i - 1 + unrendered;
                if (needed + (rest ? gap + pillFor(rest) : 0) > avail - 0.5) { keep = i; break; }
                x = needed;
            }
            const hidden = tags.length - keep + unrendered;
            if (!hidden) continue;
            for (let i = keep; i < tags.length; i++) tags[i][0].classList.add('is-overflow');
            const pill = document.createElement('span');
            pill.className = 'browse-card-tag is-more';
            pill.textContent = `+${hidden}`;
            const names = tags.slice(keep).map(([t]) => t.title || t.textContent.trim());
            pill.title = names.join(', ') + (unrendered ? `${names.length ? ', ' : ''}and ${unrendered} more` : '');
            row.appendChild(pill);
        }
    }

    /**
     * Put a rendered grid's cards under the visibility gate; every view calls it after a render. Layout-free itself.
     * @param {HTMLElement} container
     */
    observeImages(container) {
        if (!container) return;
        this._ensureCardObserver();
        this._watchGridWidth(container);
        requestAnimationFrame(() => {
            this.eagerPreloadImages(container);
            const cards = Array.from(container.querySelectorAll('.browse-card')).filter(c => !c.dataset.observed);
            if (cards.length === 0) return;
            const observe = (card) => { card.dataset.observed = '1'; this._cardObserver.observe(card); };
            if (cards.length > 120) {
                const batchSize = 80;
                let index = 0;
                const observeBatch = () => {
                    const end = Math.min(index + batchSize, cards.length);
                    for (let i = index; i < end; i++) observe(cards[i]);
                    index = end;
                    if (index < cards.length) requestAnimationFrame(observeBatch);
                };
                observeBatch();
                return;
            }
            for (const card of cards) observe(card);
        });
    }

    /**
     * The lookahead: start the first images in DOM order (up to `_preloadLimit`) before
     * the observer has reported anything, without reading layout.
     * @param {HTMLElement} container
     */
    eagerPreloadImages(container) {
        if (!container) return;
        const images = container.querySelectorAll('.browse-card-image:not(.loaded) img[data-src]');
        let started = 0;
        for (const img of images) {
            if (started >= this._preloadLimit) break;
            if (img.dataset.failed) continue;
            const realSrc = img.dataset.src;
            if (realSrc && img.src !== realSrc && this.loadCardImage(img, realSrc)) started++;
        }
    }

    /**
     * Stop watching every card (a full re-render; leaving the view runs it from the base deactivate).
     */
    disconnectImageObserver() {
        this._cardObserver?.disconnect();
        this._visibleCards.clear();
    }

    /**
     * Re-observe every card of every grid after a disconnect (view re-entry): the observer
     * reports the band again and loads or fits whatever is still missing.
     */
    reconnectImageObserver() {
        for (const gridId of this._getImageGridIds()) {
            const grid = document.getElementById(gridId);
            if (!grid) continue;
            for (const card of grid.querySelectorAll('.browse-card[data-observed]')) delete card.dataset.observed;
            this.observeImages(grid);
        }
    }

    // Infinite Scroll

    /**
     * Whether this view can load more results right now.
     * Subclasses override to check their hasMore + !isLoading state.
     * @returns {boolean}
     */
    canLoadMore() { return false; }

    /**
     * The next page, through reload so the creator scope holds; its promise holds the prefetch gate for the round trip.
     */
    loadMore() {
        return this.reload({ append: true });
    }

    _triggerLoadMore() {
        this._prefetching = true;
        this._setScrollIndicator('loading');
        const result = this.loadMore();
        if (result && typeof result.then === 'function') {
            result.then(() => { this._prefetching = false; }, () => { this._prefetching = false; });
        } else {
            setTimeout(() => { this._prefetching = false; }, 300);
        }
    }

    /**
     * Whether infinite scroll is active for this provider.
     * Reads from the per-provider setting with global fallback.
     * @returns {boolean}
     */
    isInfiniteScrollEnabled() {
        const perProvider = CoreAPI.getSetting('infiniteScroll');
        const id = this.provider?.id;
        if (id && perProvider && typeof perProvider === 'object' && id in perProvider) {
            return perProvider[id];
        }
        return true;
    }

    /**
     * Attach the scroll listener for infinite loading + prefetch.
     * Listens on .gallery-content (the scrollable parent of #onlineView).
     */
    _getScrollThreshold() {
        const zoom = CoreAPI.uiZoom();
        // a content buffer kept below the fold, not a trigger line: four viewports outlast a slow round trip mid-fling
        const viewport = document.querySelector('.gallery-content')?.clientHeight || 0;
        return Math.max(1500 / zoom, viewport * 4);
    }

    _attachScrollListener() {
        this._detachScrollListener();
        const scrollContainer = document.querySelector('.gallery-content');
        if (!scrollContainer) return;

        this._scrollHandler = () => {
            if (!this.isInfiniteScrollEnabled()) return;
            if (this._prefetching || !this.canLoadMore()) return;

            const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
            const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

            if (distanceFromBottom < this._getScrollThreshold()) {
                this._triggerLoadMore();
            }
        };

        scrollContainer.addEventListener('scroll', this._scrollHandler, { passive: true });
    }

    /**
     * Remove the scroll listener.
     */
    _detachScrollListener() {
        if (this._scrollHandler) {
            document.querySelector('.gallery-content')?.removeEventListener('scroll', this._scrollHandler);
            this._scrollHandler = null;
        }
        this._prefetching = false;
        this._removeScrollIndicator();
    }

    /**
     * Update the visibility of the load-more button container.
     * When infinite scroll is enabled, hides the button.
     * Subclasses call this from their updateLoadMore() or renderGrid().
     * @param {string} loadMoreContainerId - DOM ID of the load-more container div
     * @param {boolean} hasMore - whether more results are available
     * @param {boolean} hasResults - whether any results exist
     */
    updateLoadMoreVisibility(loadMoreContainerId, hasMore, hasResults) {
        const el = document.getElementById(loadMoreContainerId);
        if (!el) return;
        if (this.isInfiniteScrollEnabled()) {
            el.hidden = true;
            this._setScrollIndicator(hasMore ? 'hidden' : 'end');
            if (hasMore) this._deferredScrollCheck();
        } else {
            el.hidden = !(hasMore && hasResults);
        }
    }

    _deferredScrollCheck() {
        requestAnimationFrame(() => {
            // a view deactivated since (its listener gone) would measure, and page, whatever pane shows now
            if (!this._scrollHandler || !this.isInfiniteScrollEnabled()) return;
            if (this._prefetching || !this.canLoadMore()) return;
            const sc = document.querySelector('.gallery-content');
            if (!sc) return;
            const distanceFromBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
            if (distanceFromBottom < this._getScrollThreshold()) {
                this._triggerLoadMore();
            }
        });
    }

    _ensureScrollIndicator() {
        if (this._scrollIndicator?.isConnected) return this._scrollIndicator;
        const container = this._container || document.getElementById('onlineView');
        if (!container) return null;
        const el = document.createElement('div');
        el.className = 'browse-scroll-indicator';
        container.appendChild(el);
        this._scrollIndicator = el;
        return el;
    }

    _setScrollIndicator(state) {
        if (!this.isInfiniteScrollEnabled()) return;
        const el = this._ensureScrollIndicator();
        if (!el) return;
        el.classList.remove('loading', 'end');
        el.hidden = state === 'hidden';
        if (state !== 'hidden') el.classList.add(state);
    }

    _removeScrollIndicator() {
        this._scrollIndicator?.remove();
        this._scrollIndicator = null;
    }

    // Dropdown Dismiss

    /**
     * Close this view's registered dropdowns but one; a button passes its own, or the close beats its state read and it only opens.
     * @param {string} [exceptId]
     */
    closeDropdowns(exceptId) {
        if (this._dropdownDismissPairs) {
            for (const { dropdownId } of this._dropdownDismissPairs) {
                if (dropdownId === exceptId) continue;
                document.getElementById(dropdownId)?.classList.add('hidden');
            }
        }
    }

    /**
     * Register a document-level click handler that closes dropdowns when
     * clicking outside. Replaces per-provider boilerplate.
     * @param {Array<{dropdownId: string, buttonId: string}>} pairs
     */
    _registerDropdownDismiss(pairs) {
        this._removeDropdownDismiss();
        this._dropdownDismissPairs = pairs;
        this._dropdownCloseHandler = (e) => {
            for (const { dropdownId, buttonId } of pairs) {
                const dropdown = document.getElementById(dropdownId);
                const btn = document.getElementById(buttonId);
                if (dropdown && !dropdown.classList.contains('hidden')) {
                    if (!dropdown.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) {
                        dropdown.classList.add('hidden');
                    }
                }
            }
        };
        document.addEventListener('click', this._dropdownCloseHandler);

        // a guard on each hidden-to-open click: the mobile back stack catches body-relocated dropdowns at Tier 6
        this._dropdownGuardCleanups = [];
        for (const { dropdownId, buttonId } of pairs) {
            const btn = document.getElementById(buttonId);
            const dropdown = document.getElementById(dropdownId);
            if (!btn || !dropdown) continue;
            const onClick = () => {
                requestAnimationFrame(() => {
                    if (!dropdown.classList.contains('hidden')) {
                        window.pushOverlayGuard?.();
                    }
                });
            };
            btn.addEventListener('click', onClick);
            this._dropdownGuardCleanups.push(() => btn.removeEventListener('click', onClick));
        }
    }

    /**
     * Remove the dropdown dismiss handler. Called automatically from deactivate().
     */
    _removeDropdownDismiss() {
        if (this._dropdownCloseHandler) {
            document.removeEventListener('click', this._dropdownCloseHandler);
            this._dropdownCloseHandler = null;
        }
        if (this._dropdownGuardCleanups) {
            for (const cleanup of this._dropdownGuardCleanups) cleanup();
            this._dropdownGuardCleanups = null;
        }
    }

    // Following Manager (Abstract)

    /** @returns {boolean} */
    get supportsFollowingManager() { return false; }

    /**
     * Fetch followed creators in normalized form.
     * @returns {Promise<Array<{id: string, name: string, username?: string, avatar?: string, characterCount?: number}>>}
     */
    async getFollowedCreators() { return []; }

    /**
     * Follow a creator by query (name, URL, or UUID).
     * @param {string} query
     * @returns {Promise<{id: string, name: string}|null>}
     */
    async followCreator(query) { return null; }

    /**
     * Unfollow a creator by normalized ID.
     * @param {string} id
     * @returns {Promise<boolean>}
     */
    async unfollowCreator(id) { return false; }

    /**
     * @param {{id: string, avatar?: string}} creator
     * @returns {string}
     */
    getCreatorAvatarUrl(creator) { return creator.avatar || ''; }

    _getInitialsColor(name) {
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
        const hue = ((hash % 360) + 360) % 360;
        return `hsl(${hue}, 50%, 35%)`;
    }

    /**
     * Navigate to this creator's characters in the browse grid.
     * Should close the manager panel and switch to browse mode.
     * @param {{id: string, name: string}} creator
     */
    browseCreatorFromManager(creator) {}

    /**
     * Provider-specific sort options for the manager list.
     * @returns {Array<{value: string, label: string}>}
     */
    getFollowingManagerSortOptions() {
        return [
            { value: 'name_asc', label: 'Name A-Z' },
            { value: 'name_desc', label: 'Name Z-A' },
        ];
    }

    // Following Manager (Shared UI)

    /**
     * Render the manager panel HTML. Include in renderView() after the timeline header.
     * @returns {string}
     */
    renderFollowingManagerPanel() {
        if (!this.supportsFollowingManager) return '';
        const pid = this.provider.id;
        const sortOptions = this.getFollowingManagerSortOptions();
        const sortHtml = sortOptions.map(o =>
            `<option value="${o.value}">${o.label}</option>`
        ).join('');

        return `
            <div class="follow-mgr-panel hidden" id="${pid}FollowMgr">
                <div class="follow-mgr-toolbar">
                    <div class="follow-mgr-search-wrap">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input type="search" class="follow-mgr-search glass-input"
                               id="${pid}FollowMgrSearch" placeholder="Filter creators...">
                    </div>
                    <div class="follow-mgr-toolbar-actions">
                        <select class="follow-mgr-sort" id="${pid}FollowMgrSort">
                            ${sortHtml}
                        </select>
                    </div>
                </div>
                <div class="follow-mgr-list" id="${pid}FollowMgrList"></div>
                <div class="follow-mgr-empty hidden" id="${pid}FollowMgrEmpty">
                    <i class="fa-solid fa-user-group"></i>
                    <p>No followed creators</p>
                </div>
                <div class="follow-mgr-add">
                    <input type="search" class="follow-mgr-add-input glass-input"
                           id="${pid}FollowMgrAddInput" placeholder="Follow by name or URL...">
                    <button class="follow-mgr-add-btn glass-btn" id="${pid}FollowMgrAddBtn"
                            title="Follow creator">
                        <i class="fa-solid fa-user-plus"></i>
                    </button>
                </div>
            </div>`;
    }

    /**
     * Attach event listeners for the manager panel. Auto-called from init().
     */
    _initFollowingManager() {
        const pid = this.provider.id;
        const panel = document.getElementById(`${pid}FollowMgr`);
        if (!panel) return;

        const sortEl = document.getElementById(`${pid}FollowMgrSort`);
        if (sortEl) {
            CoreAPI.initCustomSelect(sortEl);
            sortEl.addEventListener('change', () => {
                this._mgrSort = sortEl.value;
                this._renderManagerCreators();
            });
        }

        const searchEl = document.getElementById(`${pid}FollowMgrSearch`);
        if (searchEl) {
            searchEl.addEventListener('input', () => {
                clearTimeout(this._mgrDebounceTimer);
                this._mgrDebounceTimer = setTimeout(() => {
                    this._mgrFilter = searchEl.value.trim().toLowerCase();
                    this._renderManagerCreators();
                }, 150);
            });
        }

        const addInput = document.getElementById(`${pid}FollowMgrAddInput`);
        const addBtn = document.getElementById(`${pid}FollowMgrAddBtn`);
        const handleAdd = async () => {
            const query = addInput?.value?.trim();
            if (!query) return;
            addBtn?.classList.add('loading');
            try {
                const creator = await this.followCreator(query);
                if (creator) {
                    addInput.value = '';
                    await this._loadManagerCreators();
                    this._renderManagerCreators();
                }
            } catch (e) {
                console.error('[FollowingManager] Follow failed:', e);
                CoreAPI.showToast('Failed to follow creator', 'error');
            } finally {
                addBtn?.classList.remove('loading');
            }
        };
        if (addBtn) addBtn.addEventListener('click', handleAdd);
        if (addInput) addInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleAdd(); }
        });

        // Delegation on the list container
        const list = document.getElementById(`${pid}FollowMgrList`);
        if (list) {
            list.addEventListener('click', (e) => {
                const card = e.target.closest('.follow-mgr-card');
                if (!card) return;
                const creatorId = card.dataset.creatorId;
                const creator = this._mgrCreators.find(c => c.id === creatorId);
                if (!creator) return;

                // Unfollow button
                const unfollowBtn = e.target.closest('.follow-mgr-unfollow-btn');
                if (unfollowBtn) {
                    this._handleManagerUnfollow(unfollowBtn, card, creator);
                    return;
                }

                // Card click = browse creator
                this.closeFollowingManager();
                this.browseCreatorFromManager(creator);
            });
        }

        // Toggle button
        const toggleBtn = document.getElementById(`${pid}FollowMgrToggle`);
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => this.toggleFollowingManager());
        }
    }

    toggleFollowingManager() {
        if (this._mgrOpen) {
            this.closeFollowingManager();
        } else {
            this.openFollowingManager();
        }
    }

    async openFollowingManager() {
        const pid = this.provider.id;
        const panel = document.getElementById(`${pid}FollowMgr`);
        const toggleBtn = document.getElementById(`${pid}FollowMgrToggle`);
        if (!panel) return;

        this._mgrOpen = true;
        toggleBtn?.classList.add('active');
        panel.classList.remove('hidden');

        await this._loadManagerCreators();
        this._renderManagerCreators();
    }

    closeFollowingManager() {
        const pid = this.provider.id;
        const panel = document.getElementById(`${pid}FollowMgr`);
        const toggleBtn = document.getElementById(`${pid}FollowMgrToggle`);
        if (!panel) return;

        this._mgrOpen = false;
        toggleBtn?.classList.remove('active');
        panel.classList.add('hidden');

        clearTimeout(this._mgrDebounceTimer);
        this._mgrFilter = '';
        const searchEl = document.getElementById(`${pid}FollowMgrSearch`);
        if (searchEl) searchEl.value = '';
    }

    async _loadManagerCreators() {
        this._mgrCreators = await this.getFollowedCreators();
    }

    _renderManagerCreators() {
        const pid = this.provider.id;
        const list = document.getElementById(`${pid}FollowMgrList`);
        const empty = document.getElementById(`${pid}FollowMgrEmpty`);
        if (!list) return;

        let creators = [...this._mgrCreators];

        // Filter
        if (this._mgrFilter) {
            const q = this._mgrFilter;
            creators = creators.filter(c =>
                c.name.toLowerCase().includes(q) ||
                (c.username && c.username.toLowerCase().includes(q))
            );
        }

        // Sort
        this._sortCreators(creators, this._mgrSort);

        if (creators.length === 0) {
            list.innerHTML = '';
            empty?.classList.remove('hidden');
            return;
        }

        empty?.classList.add('hidden');
        list.innerHTML = creators.map((c, i) =>
            this._renderManagerCreatorCard(c, i)
        ).join('');
    }

    _renderManagerCreatorCard(creator, index) {
        const rawAvatarUrl = this.getCreatorAvatarUrl(creator);
        const avatarUrl = rawAvatarUrl ? CoreAPI.escapeHtml(rawAvatarUrl) : '';
        const name = CoreAPI.escapeHtml(creator.name);
        const username = creator.username ? CoreAPI.escapeHtml(creator.username) : '';
        const charCount = creator.characterCount != null ? creator.characterCount : -1;
        const initial = CoreAPI.escapeHtml((creator.name || '?').charAt(0).toUpperCase());
        const initialsColor = this._getInitialsColor(creator.name || creator.id || '');
        const idAttr = CoreAPI.escapeHtml(creator.id);

        return `
            <div class="follow-mgr-card" data-creator-id="${idAttr}"
                 style="animation-delay: ${index * 0.04}s">
                <div class="follow-mgr-card-avatar">
                    ${avatarUrl
                        ? `<img src="${avatarUrl}" alt="" loading="lazy"
                               onerror="this.hidden=true;this.parentElement.querySelector('.follow-mgr-card-avatar-fallback').hidden=false">`
                        : ''}
                    <div class="follow-mgr-card-avatar-fallback"${avatarUrl ? ' hidden' : ''}
                         style="background-color:${initialsColor}">
                        ${initial}
                    </div>
                </div>
                <div class="follow-mgr-card-info">
                    <div class="follow-mgr-card-name">${name}</div>
                    <div class="follow-mgr-card-meta">
                        ${username ? `<span class="follow-mgr-card-handle">@${username}</span>` : ''}
                        ${charCount >= 0 ? `<span class="follow-mgr-card-count">${charCount} char${charCount !== 1 ? 's' : ''}</span>` : ''}
                    </div>
                </div>
                <div class="follow-mgr-card-actions">
                    <button class="follow-mgr-unfollow-btn glass-btn icon-only"
                            title="Unfollow">
                        <i class="fa-solid fa-user-minus"></i>
                    </button>
                </div>
            </div>`;
    }

    _sortCreators(creators, sort) {
        switch (sort) {
            case 'name_asc':
                creators.sort((a, b) => a.name.localeCompare(b.name));
                break;
            case 'name_desc':
                creators.sort((a, b) => b.name.localeCompare(a.name));
                break;
            case 'recent':
                creators.sort((a, b) => (b.followedAt || 0) - (a.followedAt || 0));
                break;
            case 'chars':
                creators.sort((a, b) => (b.characterCount || 0) - (a.characterCount || 0));
                break;
        }
    }

    async _handleManagerUnfollow(btn, card, creator) {
        // Two-phase confirm
        if (!btn.dataset.confirming) {
            btn.dataset.confirming = '1';
            btn.classList.add('confirming');
            btn.title = 'Click again to confirm';
            btn.innerHTML = '<i class="fa-solid fa-check"></i>';
            this._mgrConfirmTimer = setTimeout(() => {
                delete btn.dataset.confirming;
                btn.classList.remove('confirming');
                btn.title = 'Unfollow';
                btn.innerHTML = '<i class="fa-solid fa-user-minus"></i>';
            }, 3000);
            return;
        }

        clearTimeout(this._mgrConfirmTimer);
        card.classList.add('removing');
        let success = false;
        try {
            success = await this.unfollowCreator(creator.id);
        } catch (e) {
            console.error('[FollowingManager] Unfollow failed:', e);
            CoreAPI.showToast('Failed to unfollow creator', 'error');
        }
        if (success) {
            card.addEventListener('animationend', () => {
                this._mgrCreators = this._mgrCreators.filter(c => c.id !== creator.id);
                this._renderManagerCreators();
            }, { once: true });
        } else {
            card.classList.remove('removing');
            delete btn.dataset.confirming;
            btn.classList.remove('confirming');
            btn.title = 'Unfollow';
            btn.innerHTML = '<i class="fa-solid fa-user-minus"></i>';
        }
    }

    // Creator Downloads

    get supportsCreatorDownload() { return !!CD_ADAPTERS[this.provider?.id]; }

    creatorDownloadEnabled() {
        return this.supportsCreatorDownload && CoreAPI.getSetting('creatorDownloads') === true;
    }

    _injectCreatorDownloadButton(container) {
        const actions = container?.querySelector('.browse-author-banner-actions');
        if (!actions || actions.querySelector('.browse-cdl-btn')) return;
        const btn = document.createElement('button');
        btn.className = 'glass-btn icon-only browse-cdl-btn';
        btn.title = 'Download all cards by this creator';
        btn.innerHTML = '<i class="fa-solid fa-download"></i>';
        btn.addEventListener('click', () => this.runCreatorDownload(btn));
        const last = actions.lastElementChild;
        if (last?.tagName === 'BUTTON' && last.querySelector('.fa-times, .fa-xmark')) {
            actions.insertBefore(btn, last);
        } else {
            actions.appendChild(btn);
        }
    }

    async fetchAllCreatorCards() {
        return CD_ADAPTERS[this.provider?.id]?.fetchAll(this) ?? [];
    }

    async importOneCreatorCard(card) {
        const adapter = CD_ADAPTERS[this.provider?.id];
        return adapter ? adapter.importOne(this, card) : { ok: false, error: 'Not supported' };
    }

    _cdEnqueue(cards) {
        const provider = this.provider?.id;
        const source = CoreAPI.getProvider(provider);
        for (const card of cards) {
            if (this.importInFlight(card.raw)) continue;
            enqueueImport({
                view: this, provider, source, hit: card.raw, linkKey: this.hitLinkKey(card.raw), name: card.name || 'Character', batch: true,
                run: async () => {
                    const res = await this.importOneCreatorCard(card);
                    return res?.ok ? res.result : { success: false, error: res?.error || 'Import failed' };
                },
            });
        }
    }

    async runCreatorDownload(triggerBtn = null) {
        if (!this.creatorDownloadEnabled()) return;
        // one shared modal, so one active run across ALL views
        if (_cdActiveView) {
            CoreAPI.showToast('A creator download is already running', 'warning');
            return;
        }
        _cdActiveView = this;
        this._cdRunning = true;
        this._cdCancelled = false;
        const originalBtnHtml = triggerBtn?.innerHTML;
        if (triggerBtn) {
            triggerBtn.disabled = true;
            triggerBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        }
        try {
            // Display name straight off the banner; the fetch reads provider state itself
            const banner = triggerBtn?.closest('.browse-author-banner');
            const creatorName = banner?.querySelector('strong')?.textContent?.trim() || 'this creator';
            let cards = [];
            try {
                cards = await this.fetchAllCreatorCards();
            } catch (e) {
                CoreAPI.showToast(`Could not fetch creator catalog: ${e?.message || e}`, 'error');
                return;
            }
            if (!cards.length) {
                CoreAPI.showToast('No cards found for this creator', 'info');
                return;
            }

            this.buildLocalLibraryLookup();
            // probe the catalog before classifying: the lookup holds only what painted pages asked, so linked cards read as new
            await this.probeLinkKeys([...new Set(cards.map(c => c.key).filter(k => k != null && k !== '' && !this._lookup.probed.has(k)))]);
            // asked and skipped by the key the grid's badge reads (hitMatchName over the adapter's hit), the adapter's own fields only without one
            const matchOf = (c) => (c.raw && this.matchFor(c.raw)) || { name: c.name || '', creator: c.creator || '', text: '', listing: this.listingFor(c.key) };
            await this.probeMatchesFor(cards.map(matchOf).filter(m => m.name));
            const toImport = [];
            let skipped = 0, flying = 0;
            for (const card of cards) {
                if (card.key && this._lookup.byProviderId.has(card.key)) { skipped++; continue; }
                const m = matchOf(card);
                if (m.name && this.getPossibleMatchTier(m.name, m.creator, m.text, m.listing).show) { skipped++; continue; }
                if (this.importInFlight(card.raw)) { flying++; continue; }
                toImport.push(card);
            }

            if (!toImport.length) {
                CoreAPI.showToast(`All ${cards.length} card${cards.length === 1 ? '' : 's'} by ${creatorName} are already in your library${flying ? ' or on their way' : ''}`, 'info');
                return;
            }

            const background = CoreAPI.getSetting('backgroundImports') !== false;
            const confirmed = await this._cdConfirm(creatorName, cards.length, toImport.length, skipped, flying, background);
            if (!confirmed) return;
            skipped += flying;
            if (background) {
                document.getElementById('creatorDlModal')?.classList.remove('visible');
                this._cdEnqueue(toImport);
                return;
            }

            this._cdShowProgress(creatorName, toImport.length);
            let imported = 0, failed = 0;
            const failures = [];
            for (let i = 0; i < toImport.length; i++) {
                if (this._cdCancelled) break;
                const card = toImport[i];
                this._cdUpdateProgress(i, toImport.length, card.name || '', imported, failed);
                try {
                    const res = await this.importOneCreatorCard(card);
                    if (res?.ok && res.alreadyPresent) {
                        // the server skipped it as present: one more skip, and no media queued for it
                        skipped++;
                    } else if (res?.ok) {
                        // character.import took it in, every view's lookup with it
                        imported++;
                        if (res.summaryArgs && CoreAPI.getSetting('importMediaAction') !== 'none') CoreAPI.queueImportMediaJobs(res.summaryArgs);
                    } else {
                        failed++;
                        failures.push(card.name || '?');
                        CoreAPI.debugLog('[CreatorDownload] Import failed:', card.name, res?.error);
                    }
                } catch (e) {
                    failed++;
                    failures.push(card.name || '?');
                    CoreAPI.debugLog('[CreatorDownload] Import threw:', card.name, e?.message || e);
                }
                await new Promise(r => setTimeout(r, 400));
            }
            this.refreshInLibraryBadges();
            this._cdShowDone({ creatorName, imported, failed, failures, skipped, cancelled: this._cdCancelled });
        } finally {
            this._cdRunning = false;
            _cdActiveView = null;
            if (triggerBtn) {
                triggerBtn.disabled = false;
                triggerBtn.innerHTML = originalBtnHtml;
            }
        }
    }

    _cdEnsureModal() {
        let modal = document.getElementById('creatorDlModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'creatorDlModal';
            modal.className = 'cl-modal cl-modal-drawer cl-drawer-partial';
            modal.innerHTML = `
                <div class="cl-modal-content browse-cdl-content">
                    <div class="cl-modal-header">
                        <h3><i class="fa-solid fa-download"></i> Creator Download</h3>
                        <button class="cl-modal-close" id="creatorDlCloseX" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div class="cl-modal-body browse-cdl-body" id="creatorDlBody"></div>
                    <div class="cl-modal-footer browse-cdl-footer" id="creatorDlFooter"></div>
                </div>`;
            document.body.appendChild(modal);
            document.getElementById('creatorDlCloseX')?.addEventListener('click', () => window.creatorDlModalClose?.());
        }
        window.creatorDlModalClose = () => this._cdHandleClose();
        window.registerOverlay?.({ id: 'creatorDlModal', tier: 5, close: () => window.creatorDlModalClose?.(), visible: (el) => el.classList.contains('visible') });
        return modal;
    }

    _cdHandleClose() {
        const modal = document.getElementById('creatorDlModal');
        if (!modal) return;
        if (this._cdRunning && !this._cdCancelled && this._cdPhase === 'progress') {
            // first close while running = cancel after current card
            this._cdRequestCancel();
            return;
        }
        if (this._cdConfirmResolve) {
            const resolve = this._cdConfirmResolve;
            this._cdConfirmResolve = null;
            resolve(false);
        }
        modal.classList.remove('visible');
    }

    _cdRequestCancel() {
        this._cdCancelled = true;
        const label = document.getElementById('creatorDlCurrent');
        if (label) label.textContent = 'Cancelling after the current card...';
        const btn = document.getElementById('creatorDlCancelBtn');
        if (btn) btn.disabled = true;
    }

    _cdConfirm(creatorName, total, toImport, skipped, flying = 0, background = false) {
        const modal = this._cdEnsureModal();
        this._cdPhase = 'confirm';
        const esc = (s) => CoreAPI.escapeHtml(s);
        const body = document.getElementById('creatorDlBody');
        const footer = document.getElementById('creatorDlFooter');
        body.innerHTML = `
            <p class="browse-cdl-lead">Download <strong>${toImport}</strong> of ${total} card${total === 1 ? '' : 's'} by <strong>${esc(creatorName)}</strong>?</p>
            ${skipped > 0 ? `<p class="browse-cdl-sub">${skipped} already in your library will be skipped.</p>` : ''}
            ${flying > 0 ? `<p class="browse-cdl-sub">${flying} already on ${flying === 1 ? 'its' : 'their'} way will be skipped.</p>` : ''}
            <p class="browse-cdl-sub">${background ? 'Cards import in the background, one at a time; the notifications show their progress.' : 'Cards import one at a time; media downloads continue in the background queue.'}</p>`;
        footer.innerHTML = `
            <button class="cl-btn cl-btn-secondary" id="creatorDlCancelConfirm">Cancel</button>
            <button class="cl-btn cl-btn-primary" id="creatorDlGo"><i class="fa-solid fa-download"></i> Download</button>`;
        modal.classList.add('visible');
        return new Promise(resolve => {
            this._cdConfirmResolve = resolve;
            document.getElementById('creatorDlCancelConfirm')?.addEventListener('click', () => {
                this._cdConfirmResolve = null;
                modal.classList.remove('visible');
                resolve(false);
            });
            document.getElementById('creatorDlGo')?.addEventListener('click', () => {
                this._cdConfirmResolve = null;
                resolve(true);
            });
        });
    }

    _cdShowProgress(creatorName, total) {
        const modal = this._cdEnsureModal();
        this._cdPhase = 'progress';
        const esc = (s) => CoreAPI.escapeHtml(s);
        const body = document.getElementById('creatorDlBody');
        const footer = document.getElementById('creatorDlFooter');
        body.innerHTML = `
            <p class="browse-cdl-lead">Downloading cards by <strong>${esc(creatorName)}</strong></p>
            <div class="browse-cdl-bar"><div class="browse-cdl-bar-fill" id="creatorDlBarFill"></div></div>
            <div class="browse-cdl-count" id="creatorDlCount">0 / ${total}</div>
            <div class="browse-cdl-current" id="creatorDlCurrent"></div>`;
        footer.innerHTML = `<button class="cl-btn cl-btn-danger-hover" id="creatorDlCancelBtn"><i class="fa-solid fa-xmark"></i> Cancel</button>`;
        document.getElementById('creatorDlCancelBtn')?.addEventListener('click', (e) => {
            this._cdRequestCancel();
            CoreAPI.setRunVerb(e.currentTarget, 'stopping');
        });
        modal.classList.add('visible');
    }

    _cdUpdateProgress(index, total, name, imported, failed) {
        const fill = document.getElementById('creatorDlBarFill');
        if (fill) fill.style.width = `${Math.round((index / total) * 100)}%`;
        const count = document.getElementById('creatorDlCount');
        if (count) count.textContent = `${index} / ${total}${failed > 0 ? ` (${failed} failed)` : ''}`;
        const current = document.getElementById('creatorDlCurrent');
        if (current && !this._cdCancelled) current.textContent = name;
    }

    _cdShowDone({ creatorName, imported, failed, failures, skipped, cancelled }) {
        this._cdPhase = 'done';
        const modal = document.getElementById('creatorDlModal');
        if (modal && !modal.classList.contains('visible')) {
            CoreAPI.showToast(`Creator download ${cancelled ? 'cancelled' : 'finished'}: ${imported} imported${failed > 0 ? `, ${failed} failed` : ''}`, failed > 0 ? 'warning' : 'success');
            return;
        }
        const esc = (s) => CoreAPI.escapeHtml(s);
        const body = document.getElementById('creatorDlBody');
        const footer = document.getElementById('creatorDlFooter');
        if (!body || !footer) return;
        const failList = failures.length
            ? `<div class="browse-cdl-failures">${failures.map(n => `<div>${esc(n)}</div>`).join('')}</div>`
            : '';
        body.innerHTML = `
            <p class="browse-cdl-lead">${cancelled ? 'Cancelled' : 'Done'}: <strong>${imported}</strong> imported${failed > 0 ? `, <strong>${failed}</strong> failed` : ''}${skipped > 0 ? `, ${skipped} skipped` : ''}</p>
            ${failList}
            ${imported > 0 ? '<p class="browse-cdl-sub">Media downloads are running in the background queue (see Notifications).</p>' : ''}`;
        footer.innerHTML = `<button class="cl-btn cl-btn-secondary" id="creatorDlDoneBtn"><i class="fa-solid fa-xmark"></i> Close</button>`;
        document.getElementById('creatorDlDoneBtn')?.addEventListener('click', () => {
            document.getElementById('creatorDlModal')?.classList.remove('visible');
        });
    }

    // Mobile Integration

    /**
     * DOM ID of this provider's preview modal (e.g. 'chubCharModal').
     * Used by the mobile back-button handler and STATIC_OVERLAYS set.
     * @returns {string|null}
     */
    get previewModalId() { return null; }

    /**
     * Close the preview modal with proper cleanup (abort fetches, release memory, etc.).
     * Called by the mobile back-button handler. Default hides the modal by ID.
     */
    closePreview() {
        const id = this.previewModalId;
        if (id) {
            const el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        }
    }

    /**
     * Element IDs for the provider's filter bar controls.
     * The mobile settings sheet queries these to build the online section dynamically.
     * @returns {{ sort: string|null, tags: string|null, filters: string|null, nsfw: string|null, refresh: string|null, subSort?: string, timelineSort?: string }}
     */
    get mobileFilterIds() {
        return { sort: null, tags: null, filters: null, nsfw: null, refresh: null };
    }

    /**
     * Whether this provider has a mode toggle (e.g. Browse/Following).
     * Providers returning true should provide mobileModeSections for the settings sheet.
     * @returns {boolean}
     */
    get hasModeToggle() { return false; }

    /**
     * Return sort/view config for the settings modal.
     * @returns {{ browseSortOptions: Array<{value:string, label:string}>, followingSortOptions: Array<{value:string, label:string}>, viewModes: Array<{value:string, label:string}> }}
     */
    getSettingsConfig() {
        return { browseSortOptions: [], followingSortOptions: [], viewModes: [] };
    }

    // Modal Injection

    /**
     * Inject modal HTML into document.body (once).
     * Call from activate() on first run.
     */
    injectModals() {
        if (this._modalsInjected) return;
        const html = this.renderModals();
        if (html) {
            const before = new Set(document.body.children);
            document.body.insertAdjacentHTML('beforeend', html);
            // the base doesnt know the dialogs' ids or count, so it mounts whatever the injection left unmounted
            CoreAPI.mountDialogs();
            // the nodes the injection added are remembered, so a provider that leaves (an
            // extension's, unregistered) takes its modals with it
            this._injectedModals = [...document.body.children].filter(n => !before.has(n));
        }
        this._modalsInjected = true;
    }

    // injected modals leave with an unregistering provider; a once-guard on their events resets in onModalsRemoved
    removeModals() {
        for (const node of this._injectedModals || []) node.remove?.();
        this._injectedModals = [];
        this._modalsInjected = false;
        this.onModalsRemoved?.();
    }

    // Avatar Quick-View

    /**
     * Full-screen view of an image; a multi-image gallery delegates to the shared gallery viewer.
     * @param {string} src
     * @param {string} [fallbackSrc]
     * @param {string[]} [gallery] - image URLs; more than one opens the gallery viewer
     * @param {number} [startIndex]
     */
    static openAvatarViewer(src, fallbackSrc, gallery, startIndex) {
        if (!src) return;
        BrowseView.closeAvatarViewer();

        if (gallery && gallery.length > 1) {
            // name from the url so gv's extension-based gif/video detection works on remote media
            const media = gallery.map((u, i) => ({
                url: u,
                name: (String(u).split('/').pop() || '').split('?')[0].split('#')[0] || `Image ${i + 1}`,
            }));
            CoreAPI.openGalleryViewerWithImages(media, startIndex ?? 0, 'Gallery');
            return;
        }

        const overlay = document.createElement('div');
        overlay.id = 'browseAvatarViewer';
        overlay.className = 'browse-avatar-viewer';

        // covers a first-tap fetch of a bigger asset; the CSS reveal delay keeps cached opens from flashing it
        const spinner = document.createElement('div');
        spinner.className = 'browse-av-spinner';
        spinner.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

        const img = document.createElement('img');
        img.className = 'browse-av-image';
        img.alt = 'Image';
        img.onload = () => spinner.remove();
        img.onerror = () => { img.onerror = null; spinner.remove(); if (fallbackSrc) img.src = fallbackSrc; else img.hidden = true; };
        img.src = src;
        overlay.appendChild(spinner);
        overlay.appendChild(img);

        overlay.addEventListener('click', (e) => { if (e.target === overlay) BrowseView.closeAvatarViewer(); });
        img.addEventListener('click', () => BrowseView.closeAvatarViewer());

        document.body.appendChild(overlay);
    }

    static closeAvatarViewer() {
        document.getElementById('browseAvatarViewer')?.remove();
    }

    // Image loading

    static loadImage(img, src) {
        img.src = src;
        const container = img.closest('.browse-card-image');
        if (!container || container.classList.contains('loaded')) return;
        img.addEventListener('load', function onLoad() {
            img.removeEventListener('load', onLoad);
            container.classList.add('loaded');
            container.classList.remove('load-failed');
        });
        img.addEventListener('error', function onError() {
            img.removeEventListener('error', onError);
            container.classList.add('load-failed');
        });
        BrowseView.adjustPortraitPosition(img);
    }

    // Portrait-aware position

    /**
     * The preview's portrait: hidden until its own picture loads (an img keeps the last face while a new src loads).
     * @param {HTMLImageElement} img
     * @param {string} url
     */
    static setPreviewPortrait(img, url) {
        if (!img) return;
        img.classList.add('loading');
        img.onload = () => img.classList.remove('loading');
        img.onerror = () => {
            img.onerror = null;
            img.src = PREVIEW_PORTRAIT_FALLBACK;
            img.classList.remove('loading');
        };
        img.src = url || PREVIEW_PORTRAIT_FALLBACK;
        if (img.complete && img.naturalWidth > 0) img.classList.remove('loading');
        BrowseView.adjustPortraitPosition(img);
    }

    static adjustPortraitPosition(img) {
        img.style.objectPosition = '';
        const apply = () => {
            const { naturalWidth: w, naturalHeight: h } = img;
            if (w > 0 && h > 0 && h / w > 1.3) {
                img.style.objectPosition = 'center 10%';
            }
        };
        if (img.complete && img.naturalWidth > 0) {
            apply();
        } else {
            img.addEventListener('load', function handler() {
                img.removeEventListener('load', handler);
                apply();
            });
        }
    }

    // Title scroll-reveal on click

    static wireTitleScroll(titleEl, overlayEl, glassEl) {
        if (!titleEl) return;
        let _anim = null;
        let _inner = null;

        function unwrap() {
            if (_inner) {
                titleEl.textContent = _inner.textContent;
                _inner = null;
            }
        }

        function cancel() {
            if (!_anim) return;
            if (_anim.animation) _anim.animation.cancel();
            if (_anim.timeout) clearTimeout(_anim.timeout);
            _anim = null;
            unwrap();
            titleEl.classList.remove('browse-title-scrolling', 'browse-title-scroll-start', 'browse-title-scroll-end');
        }

        titleEl.addEventListener('click', async () => {
            if (isMobileMode()) return; // mobile reveals long titles via its own tap handler
            if (_anim) { cancel(); return; }

            const distance = titleEl.scrollWidth - titleEl.clientWidth;
            if (distance <= 0) return;

            const inner = document.createElement('span');
            inner.className = 'browse-title-scroll-inner';
            inner.textContent = titleEl.textContent;
            titleEl.textContent = '';
            titleEl.appendChild(inner);
            _inner = inner;
            _anim = { animation: null, timeout: null };

            const speed = 80;
            const fwdMs = Math.max(500, (distance / speed) * 1000);
            const retMs = Math.max(350, fwdMs * 0.55);

            titleEl.classList.add('browse-title-scrolling', 'browse-title-scroll-start');

            const fwd = inner.animate(
                [{ transform: 'translateX(0)' }, { transform: `translateX(${-distance}px)` }],
                { duration: fwdMs, easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)', fill: 'forwards', composite: 'replace' }
            );
            _anim.animation = fwd;
            await fwd.finished;
            if (!_anim) return;

            titleEl.classList.remove('browse-title-scroll-start');
            titleEl.classList.add('browse-title-scroll-end');

            await new Promise(r => { _anim.timeout = setTimeout(r, 1200); });
            if (!_anim) return;

            titleEl.classList.remove('browse-title-scroll-end');

            const ret = inner.animate(
                [{ transform: `translateX(${-distance}px)` }, { transform: 'translateX(0)' }],
                { duration: retMs, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards', composite: 'replace' }
            );
            _anim.animation = ret;
            await ret.finished;
            if (_anim) {
                _anim = null;
                unwrap();
                titleEl.classList.remove('browse-title-scrolling');
            }
        });

        if (overlayEl) {
            new MutationObserver(() => {
                if (overlayEl.classList.contains('hidden')) cancel();
            }).observe(overlayEl, { attributes: true, attributeFilter: ['class'] });
        }

        if (glassEl) {
            new MutationObserver(() => {
                if (glassEl.classList.contains('header-collapsed')) cancel();
            }).observe(glassEl, { attributes: true, attributeFilter: ['class'] });
        }
    }
}

window.registerOverlay?.({
    id: 'browseAvatarViewer',
    tier: 0,
    static: false,
    close: () => BrowseView.closeAvatarViewer(),
});

export default BrowseView;
