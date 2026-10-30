// The Online tab's LOREBOOK kind: one view on the browse base for every provider, fed by an adapter of data and fetch
import CoreAPI from '../core-api.js';
import { BrowseView, cardTagsHtml, applyTagsClamp, updateNsfwToggleButton, libraryCardClass } from './browse-view.js';
import { BROWSE_PURIFY_CONFIG, IMG_PLACEHOLDER, deferRender, skeletonLines, renderBrowseError, formatNumber } from './provider-utils.js';
import { importBookToShelf, probeShelf } from '../lorebook-shelf.js';

const { escapeHtml, safePurify, formatRichText, showToast, debugLog, renderSkeletonGrid } = CoreAPI;

const LOREBOOK_PREVIEW_MODAL_ID = 'lorebookPreviewModal';
const PAGE_SIZE = 48;

// one preview modal for every provider's view, injected and wired once; its buttons act on the showing view
let _modalWired = false;
let _active = null;

export class LorebookView extends BrowseView {
    /** @param {object} adapter the provider's data-and-fetch adapter (above) */
    constructor(adapter) {
        super(null);
        this.adapter = adapter;
        this._hits = [];
        this._rendered = 0;
        this._page = 1;
        this._hasMore = false;
        this._total = null;
        this._loading = false;
        this._gen = 0;
        this._abort = null;
        this._query = '';
        this._sort = adapter.defaultSort || adapter.sortOptions?.[0]?.value || '';
        this._nsfw = this._nsfwPreference();
        this._shelf = new Set();       // keys the shelf probe answered as present
        this._shelfProbed = new Set(); // keys asked this activation
        this._previewHit = null;
        // a shelf change anywhere stales the badges; the next paint probes again
        document.addEventListener('cl-worlds-changed', (e) => {
            if (e.detail?.source === `lorebooks:${this.provider?.id}`) return;
            this._shelf.clear();
            this._shelfProbed.clear();
            if (_active === this && this._hits.length) this.probeShelf(this._hits).then(() => this._render(false));
        });
    }

    // the single-mode contract

    resetSessionState() {
        this._abort?.abort();
        this._hits = [];
        this._rendered = 0;
        this._page = 1;
        this._hasMore = false;
        this._total = null;
        this._query = '';
        this._sort = this.adapter.defaultSort || this.adapter.sortOptions?.[0]?.value || '';
        this._nsfw = this._nsfwPreference();
        this._shelf.clear();
        this._shelfProbed.clear();
    }

    /** The provider's persisted NSFW preference, the one its character view toggles; off without the setting it requires. */
    _nsfwPreference() {
        const d = this.adapter.nsfw;
        if (!d?.setting) return false;
        if (d.requires && !CoreAPI.getSetting(d.requires)) return false;
        return CoreAPI.getSetting(d.setting) === true;
    }

    get gridElementId() { return 'lorebookGrid'; }
    hasData() { return this._hits.length > 0; }
    rerenderGrid() { this._render(false); }
    loadInitial(opts = {}) { return this._load(opts); }
    canLoadMore() { return this._hasMore && !this._loading; }
    onActivated(isReEntry) {
        _active = this;
        this._shelfProbed.clear();
        // the NSFW setting is shared with the character view: a flip there drops the list on re-entry
        const nsfw = this._nsfwPreference();
        if (isReEntry && nsfw !== this._nsfw) {
            this._nsfw = nsfw;
            updateNsfwToggleButton('lorebookNsfwToggle', nsfw);
            this._hits = []; this._rendered = 0; this._page = 1; this._hasMore = false;
        }
    }
    _getImageGridIds() { return ['lorebookGrid']; }

    get previewModalId() { return LOREBOOK_PREVIEW_MODAL_ID; }
    closePreview() { closePreviewModal(); }
    get mobileFilterIds() {
        const ids = { sort: 'lorebookSortSelect', refresh: 'lorebookRefreshBtn' };
        if (this.adapter.nsfw) ids.nsfw = 'lorebookNsfwToggle';
        return ids;
    }
    getSearchModes() { return ['lorebook']; }
    getSearchInputId() { return 'lorebookSearchInput'; }
    getSearchPlaceholder() { return 'Lorebook name...'; }
    getSearchModeLabel() { return 'Lorebook'; }
    hitLinkKey() { return null; }
    hitMatchName() { return null; }
    refreshInLibraryBadges() { /* the shelf badge repaints from its own probe */ }
    buildLocalLibraryLookup() { /* no character lookup here: the shelf probe answers the badge */ }

    // the surface

    renderFilterBar() {
        const sorts = (this.adapter.sortOptions || []).map(o => `<option value="${escapeHtml(o.value)}"${o.value === this._sort ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
        const nsfw = this.adapter.nsfw
            ? `<button id="lorebookNsfwToggle" class="glass-btn nsfw-toggle" title="Showing SFW only - click to include NSFW"><i class="fa-solid fa-shield-halved"></i> <span>SFW Only</span></button>`
            : '';
        return `
            <div class="browse-sort-container">
                <select id="lorebookSortSelect" class="glass-select" title="Sort lorebooks">${sorts}</select>
            </div>
            ${nsfw}
            <button id="lorebookRefreshBtn" class="glass-btn icon-only" title="Refresh">
                <i class="fa-solid fa-sync"></i>
            </button>
        `;
    }

    renderView() {
        const site = escapeHtml(this.provider?.name || '');
        return `
            <div id="lorebookSection" class="browse-section">
                <div class="browse-search-bar">
                    <div class="browse-search-input-wrapper">
                        <i class="fa-solid fa-search"></i>
                        <input type="search" id="lorebookSearchInput" placeholder="Search ${site} lorebooks..." autocomplete="one-time-code">
                        <button id="lorebookClearSearchBtn" class="browse-search-clear hidden" title="Clear search">
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                        <button id="lorebookSearchBtn" class="browse-search-submit" title="Search">
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </div>
                </div>
                <div id="lorebookGrid" class="browse-grid"></div>
                <div class="browse-load-more" id="lorebookLoadMore" hidden>
                    <button id="lorebookLoadMoreBtn" class="glass-btn">
                        <i class="fa-solid fa-plus"></i> Load More
                    </button>
                </div>
            </div>
        `;
    }

    // one modal for every provider's view; the first view to inject it wins, the rest find it
    renderModals() {
        if (document.getElementById(LOREBOOK_PREVIEW_MODAL_ID)) return '';
        return `
    <div id="${LOREBOOK_PREVIEW_MODAL_ID}" class="modal-overlay hidden">
        <div class="modal-glass browse-char-modal">
            <div class="modal-header">
                <div class="browse-char-header-info">
                    <img id="lorebookPreviewCover" src="" alt="" class="browse-char-avatar">
                    <div>
                        <h2 id="lorebookPreviewName">Lorebook</h2>
                        <p class="browse-char-meta">
                            by <span id="lorebookPreviewCreator" class="browse-meta-identity" data-identity-icon="fa-solid fa-user-pen">Creator</span> •
                            <span id="lorebookPreviewEntries" title="Entries"><i class="fa-solid fa-list"></i> 0</span>
                        </p>
                    </div>
                </div>
                <div class="modal-controls">
                    <a id="lorebookPreviewOpenBtn" href="#" target="_blank" rel="noopener" class="cl-btn cl-btn-secondary" title="Open on the site">
                        <i class="fa-solid fa-external-link"></i> Open
                    </a>
                    <button id="lorebookPreviewImportBtn" class="cl-btn cl-btn-primary" title="Put this lorebook on your shelf">
                        <i class="fa-solid fa-download"></i> Import
                    </button>
                    <button class="close-btn" id="lorebookPreviewClose">&times;</button>
                </div>
            </div>
            <div class="browse-char-body">
                <div class="browse-char-tagline" id="lorebookPreviewTaglineSection" hidden>
                    <i class="fa-solid fa-quote-left"></i>
                    <div id="lorebookPreviewTagline" class="browse-tagline-text"></div>
                </div>
                <div class="browse-char-meta-grid">
                    <div class="browse-char-stats" id="lorebookPreviewStats"></div>
                    <div class="browse-char-tags" id="lorebookPreviewTags"></div>
                </div>
                <div class="browse-char-section" id="lorebookPreviewDescriptionSection" hidden>
                    <h3 class="browse-section-title" data-section="lorebookPreviewDescription" data-label="Description" data-icon="fa-solid fa-scroll" title="Click to expand">
                        <i class="fa-solid fa-scroll"></i> Description
                    </h3>
                    <div id="lorebookPreviewDescription" class="scrolling-text"></div>
                </div>
                <div class="browse-char-section" id="lorebookPreviewEntriesSection">
                    <h3 class="browse-section-title" data-section="lorebookPreviewEntryList" data-label="Entries" data-icon="fa-solid fa-book-atlas" title="Click to expand">
                        <i class="fa-solid fa-book-atlas"></i> Entries <span class="browse-section-count" id="lorebookPreviewEntryCount"></span>
                    </h3>
                    <div id="lorebookPreviewEntryList" class="lorebook-preview-entries"></div>
                </div>
            </div>
        </div>
    </div>`;
    }

    // lifecycle

    init() {
        super.init();
        const sortEl = document.getElementById('lorebookSortSelect');
        if (sortEl) {
            sortEl.value = this._sort;
            CoreAPI.initCustomSelect(sortEl);
            sortEl.addEventListener('change', () => { this._sort = sortEl.value; this.reload(); });
        }
        const nsfwBtn = document.getElementById('lorebookNsfwToggle');
        if (nsfwBtn) {
            updateNsfwToggleButton('lorebookNsfwToggle', this._nsfw);
            nsfwBtn.addEventListener('click', async () => {
                const d = this.adapter.nsfw;
                if (!this._nsfw) {
                    if (d.requires && !CoreAPI.getSetting(d.requires)) { showToast(d.requiresMessage || 'NSFW listings need this provider\'s login (Settings > Online)', 'warning'); return; }
                    if (d.beforeEnable && !(await d.beforeEnable())) return;
                }
                this._nsfw = !this._nsfw;
                if (d.setting) CoreAPI.setSetting(d.setting, this._nsfw);
                updateNsfwToggleButton('lorebookNsfwToggle', this._nsfw);
                this.reload();
            });
        }
        document.getElementById('lorebookRefreshBtn')?.addEventListener('click', () => this.reload({ force: true }));
        const input = document.getElementById('lorebookSearchInput');
        const clearBtn = document.getElementById('lorebookClearSearchBtn');
        const submit = () => {
            const q = (input?.value || '').trim();
            if (q === this._query) return;
            this._query = q;
            this.reload();
        };
        input?.addEventListener('input', () => clearBtn?.classList.toggle('hidden', !input.value));
        input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
        document.getElementById('lorebookSearchBtn')?.addEventListener('click', submit);
        clearBtn?.addEventListener('click', () => { if (input) input.value = ''; clearBtn.classList.add('hidden'); submit(); });
        document.getElementById('lorebookLoadMoreBtn')?.addEventListener('click', () => this.reload({ append: true }));
        document.getElementById('lorebookGrid')?.addEventListener('click', (e) => {
            const card = e.target.closest('.browse-card[data-lorebook-key]');
            if (!card) return;
            const hit = this._hits.find(h => h.key === card.dataset.lorebookKey);
            if (hit) this.openPreview(hit);
        });
        if (!_modalWired) {
            _modalWired = true;
            document.getElementById('lorebookPreviewClose')?.addEventListener('click', () => closePreviewModal());
            document.getElementById(LOREBOOK_PREVIEW_MODAL_ID)?.addEventListener('click', (e) => { if (e.target.id === LOREBOOK_PREVIEW_MODAL_ID) closePreviewModal(); });
            document.getElementById('lorebookPreviewImportBtn')?.addEventListener('click', (e) => {
                if (_active?._previewHit) _active.importHit(_active._previewHit, e.currentTarget);
            });
            window.registerOverlay?.({ id: LOREBOOK_PREVIEW_MODAL_ID, tier: 7, close: () => closePreviewModal() });
        }
    }

    deactivate() {
        super.deactivate();
        this._abort?.abort();
        if (_active === this) _active = null;
    }

    // loading and painting

    async _load({ append = false } = {}) {
        if (append) {
            if (this._loading || !this._hasMore) return;
            this._page++;
        } else {
            this._page = 1;
        }
        const gen = ++this._gen;
        this._abort?.abort();
        this._abort = new AbortController();
        this._loading = true;
        const grid = document.getElementById('lorebookGrid');
        if (!append && grid) {
            this.disconnectImageObserver();
            this._rendered = 0;
            renderSkeletonGrid(grid);
        }
        const btn = document.getElementById('lorebookLoadMoreBtn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...'; }
        try {
            const page = await this.adapter.fetchPage({ query: this._query, sort: this._sort, nsfw: this._nsfw, page: this._page, limit: PAGE_SIZE, signal: this._abort.signal });
            if (gen !== this._gen) return;
            const hits = (page?.hits || []).filter(h => h && h.key != null && h.key !== '');
            await this.probeShelf(hits);
            if (gen !== this._gen) return;
            this._hits = append ? this._hits.concat(hits) : hits;
            this._hasMore = !!page?.hasMore;
            this._total = page?.total ?? null;
            this._render(append);
            this.updateLoadMoreVisibility('lorebookLoadMore', this._hasMore, this._hits.length > 0);
        } catch (err) {
            // an aborted append rolls its page back, unless a newer load already owns the counter
            if (append && gen === this._gen) this._page--;
            if (err?.name === 'AbortError' || gen !== this._gen) return;
            debugLog(`[${this.provider?.name}] lorebook load failed:`, err);
            if (append) { showToast(`Could not load more: ${err.message}`, 'error'); }
            else if (grid) renderBrowseError(grid, { provider: this.provider?.name, error: err, view: 'lorebooks', retry: () => this.reload({ force: true }) });
        } finally {
            if (gen === this._gen) {
                this._loading = false;
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-plus"></i> Load More'; }
            }
        }
    }

    /** The persistent exclude tags, client-side over the hit's tags where the site has any. */
    _visibleHits() {
        const excluded = this.persistentExcludeTags().map(t => t.toLowerCase());
        if (!excluded.length) return this._hits;
        return this._hits.filter(h => !(h.tags || []).some(t => excluded.includes(String(t).toLowerCase())));
    }

    _render(appendOnly) {
        const grid = document.getElementById('lorebookGrid');
        if (!grid) return;
        const hits = this._visibleHits();
        if (!hits.length) {
            this._rendered = 0;
            this.disconnectImageObserver();
            const filtered = this._hits.length > 0;
            grid.innerHTML = `
                <div class="browse-empty">
                    <i class="fa-solid fa-book-atlas"></i>
                    <h3>No Lorebooks Found</h3>
                    <p>${filtered ? 'Every lorebook on this page carries one of your excluded tags.' : 'Try a different search term.'}</p>
                </div>`;
            return;
        }
        if (appendOnly && this._rendered > 0 && this._rendered <= hits.length) {
            const fresh = hits.slice(this._rendered);
            if (fresh.length) grid.insertAdjacentHTML('beforeend', fresh.map(h => this._card(h)).join(''));
        } else {
            this.disconnectImageObserver();
            grid.innerHTML = hits.map(h => this._card(h)).join('');
        }
        this._rendered = hits.length;
        this.observeImages(grid);
    }

    _card(hit) {
        const onShelf = this._shelf.has(hit.key);
        const cover = hit.cover
            ? `<img data-src="${escapeHtml(hit.cover)}" src="${IMG_PLACEHOLDER}" alt="" decoding="async" fetchpriority="low">`
            : `<div class="lorebook-tile"><i class="fa-solid fa-book-atlas"></i><span>${escapeHtml(initialsOf(hit.name))}</span></div>`;
        const stats = [];
        if (hit.entryCount != null) stats.push(`<span class="browse-card-stat" title="Entries"><i class="fa-solid fa-list"></i> ${formatNumber(hit.entryCount)}</span>`);
        if (hit.tokenEstimate != null) stats.push(`<span class="browse-card-stat" title="Tokens"><i class="fa-solid fa-coins"></i> ${formatNumber(hit.tokenEstimate)}</span>`);
        else if (hit.wordCount != null) stats.push(`<span class="browse-card-stat" title="Words"><i class="fa-solid fa-font"></i> ${formatNumber(hit.wordCount)}</span>`);
        if (hit.stats?.favorites != null) stats.push(`<span class="browse-card-stat" title="Favorites"><i class="fa-solid fa-heart"></i> ${formatNumber(hit.stats.favorites)}</span>`);
        else if (hit.stats?.stars != null) stats.push(`<span class="browse-card-stat" title="Stars"><i class="fa-solid fa-star"></i> ${formatNumber(hit.stats.stars)}</span>`);
        if (hit.stats?.downloads != null) stats.push(`<span class="browse-card-stat" title="Downloads"><i class="fa-solid fa-download"></i> ${formatNumber(hit.stats.downloads)}</span>`);
        const badge = onShelf ? '<div class="browse-feature-badges"><span class="browse-feature-badge in-library" title="On your shelf"><i class="fa-solid fa-check"></i></span></div>' : '';
        return `
        <div class="${libraryCardClass(onShelf)}" data-lorebook-key="${escapeHtml(hit.key)}"${hit.tagline ? ` title="${escapeHtml(hit.tagline)}"` : ''}>
            <div class="browse-card-image">
                ${cover}
                ${hit.nsfw ? '<span class="browse-nsfw-badge">NSFW</span>' : ''}
                ${badge}
            </div>
            <div class="browse-card-body">
                <div class="browse-card-name">${escapeHtml(hit.name || 'Untitled')}</div>
                <span class="lorebook-card-creator"><i class="fa-solid fa-user-pen"></i> ${escapeHtml(hit.creator || 'Unknown')}</span>
                ${cardTagsHtml(hit.tags || [])}
            </div>
            <div class="browse-card-footer">${stats.join('')}</div>
        </div>`;
    }

    _repaintCard(key) {
        const grid = document.getElementById('lorebookGrid');
        const old = grid?.querySelector(`.browse-card[data-lorebook-key="${CSS.escape(key)}"]`);
        const hit = this._hits.find(h => h.key === key);
        if (!old || !hit) return;
        old.outerHTML = this._card(hit);
        this.observeImages(grid);
    }

    /**
     * Ask the shelf which hits it holds: one POST per page of at most 500 keys, asked keys skipped, a failure marks nothing.
     */
    async probeShelf(hits) {
        const keys = [];
        const seen = new Set();
        for (const h of hits || []) {
            const k = h?.key;
            if (k == null || k === '' || this._shelfProbed.has(k) || seen.has(k)) continue;
            seen.add(k);
            keys.push(k);
        }
        if (!keys.length) return;
        try {
            const found = await probeShelf(this.provider.id, keys);
            for (const k of found) this._shelf.add(k);
            for (const k of keys) this._shelfProbed.add(k);
        } catch (err) {
            debugLog(`[${this.provider?.name}] shelf probe failed (asked again next load):`, err);
        }
    }

    // the preview

    async openPreview(hit) {
        _active = this;
        this._previewHit = hit;
        const $ = (id) => document.getElementById(id);
        const modal = $(LOREBOOK_PREVIEW_MODAL_ID);
        if (!modal) return;
        const cover = $('lorebookPreviewCover');
        if (cover) { cover.src = hit.cover || '/img/no-portrait.png'; cover.alt = hit.name || ''; }
        $('lorebookPreviewName').textContent = hit.name || 'Untitled';
        $('lorebookPreviewCreator').textContent = hit.creator || 'Unknown';
        // chub's listing rows carry no entry count: the header waits for the fetched book
        paintEntryCount(hit.entryCount);
        const open = $('lorebookPreviewOpenBtn');
        if (open) { open.href = hit.url || '#'; open.classList.toggle('hidden', !hit.url); }
        const importBtn = $('lorebookPreviewImportBtn');
        if (importBtn) {
            importBtn.disabled = false;
            importBtn.innerHTML = this._shelf.has(hit.key) ? '<i class="fa-solid fa-check"></i> On your shelf' : '<i class="fa-solid fa-download"></i> Import';
        }
        const taglineSection = $('lorebookPreviewTaglineSection');
        if (taglineSection) {
            taglineSection.hidden = !hit.tagline;
            $('lorebookPreviewTagline').textContent = hit.tagline || '';
        }
        const stats = [];
        if (hit.tokenEstimate != null) stats.push(`<div class="browse-stat"><i class="fa-solid fa-coins"></i> ${formatNumber(hit.tokenEstimate)} tokens</div>`);
        if (hit.wordCount != null) stats.push(`<div class="browse-stat"><i class="fa-solid fa-font"></i> ${formatNumber(hit.wordCount)} words</div>`);
        if (hit.stats?.favorites != null) stats.push(`<div class="browse-stat"><i class="fa-solid fa-heart"></i> ${formatNumber(hit.stats.favorites)} favorites</div>`);
        if (hit.stats?.stars != null) stats.push(`<div class="browse-stat"><i class="fa-solid fa-star"></i> ${formatNumber(hit.stats.stars)} stars</div>`);
        if (hit.stats?.downloads != null) stats.push(`<div class="browse-stat"><i class="fa-solid fa-download"></i> ${formatNumber(hit.stats.downloads)} downloads</div>`);
        if (hit.createdAt) { const d = new Date(hit.createdAt); if (!Number.isNaN(d.getTime())) stats.push(`<div class="browse-stat"><i class="fa-solid fa-calendar"></i> ${escapeHtml(d.toLocaleDateString())}</div>`); }
        $('lorebookPreviewStats').innerHTML = stats.join('');
        const tagsEl = $('lorebookPreviewTags');
        tagsEl.innerHTML = (hit.tags || []).map(t => `<span class="browse-tag">${escapeHtml(t)}</span>`).join('');
        applyTagsClamp(tagsEl);
        const descSection = $('lorebookPreviewDescriptionSection');
        const desc = $('lorebookPreviewDescription');
        if (hit.description) {
            descSection.hidden = false;
            desc.innerHTML = skeletonLines(3);
            deferRender(desc, () => safePurify(formatRichText(hit.description, hit.name || '', true), BROWSE_PURIFY_CONFIG));
        } else {
            descSection.hidden = true;
            desc.innerHTML = '';
        }
        const list = $('lorebookPreviewEntryList');
        const count = $('lorebookPreviewEntryCount');
        list.innerHTML = skeletonLines(4);
        count.textContent = hit.entryCount != null ? `(${formatNumber(hit.entryCount)})` : '';
        modal.classList.remove('hidden');
        try {
            const fetched = await this._bookFor(hit);
            if (this._previewHit !== hit) return;
            const entries = bookEntries(fetched);
            hit.entryCount = entries.length;
            paintEntryCount(entries.length);
            this._repaintCard(hit.key);
            count.textContent = `(${formatNumber(entries.length)})`;
            list.innerHTML = entries.length ? CoreAPI.renderLorebookEntriesHtml(entries) : '<p class="browse-status-note">This lorebook has no entries.</p>';
        } catch (err) {
            if (this._previewHit !== hit) return;
            list.innerHTML = `<p class="browse-status-note"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(`Could not load the entries: ${err.message}`)}</p>`;
        }
    }

    // the fetched book rides the hit, so the preview and the import pay for it once
    async _bookFor(hit) {
        if (!hit._book) hit._book = await this.adapter.fetchBook(hit);
        return hit._book;
    }

    /** The import verb: the adapter's book through the shelf funnel, then the badge. */
    async importHit(hit, btn) {
        const original = btn?.innerHTML;
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing'; }
        try {
            const fetched = await this._bookFor(hit);
            // the listing's name names the shelf; a book's own name is whatever an editor typed (chub exports "Exported")
            const res = await importBookToShelf({
                name: hit.name || fetched?.name,
                book: fetched?.book || null,
                world: fetched?.world || null,
                source: { provider: this.provider.id, externalId: hit.key, path: hit.path || null, url: hit.url || null },
                existingLabel: 'Keep the existing one',
                eventSource: `lorebooks:${this.provider.id}`,
            });
            if (!res) { if (btn) { btn.disabled = false; btn.innerHTML = original; } return; }
            this._shelf.add(hit.key);
            showToast(res.usedExisting ? `"${res.world}" is already on your shelf` : `Imported "${res.world}" (${res.entries} ${res.entries === 1 ? 'entry' : 'entries'})`, 'success');
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-check"></i> On your shelf'; }
            this._repaintCard(hit.key);
        } catch (err) {
            showToast(`Import failed: ${err.message}`, 'error');
            if (btn) { btn.disabled = false; btn.innerHTML = original; }
        }
    }
}

function paintEntryCount(n) {
    const el = document.getElementById('lorebookPreviewEntries');
    if (el) el.innerHTML = `<i class="fa-solid fa-list"></i> ${n == null ? '…' : formatNumber(n)}`;
}

function closePreviewModal() {
    document.getElementById(LOREBOOK_PREVIEW_MODAL_ID)?.classList.add('hidden');
    if (_active) _active._previewHit = null;
}

/** The entries of a fetched book, whichever shape the adapter answered. */
function bookEntries(fetched) {
    if (fetched?.book && Array.isArray(fetched.book.entries)) return fetched.book.entries;
    if (fetched?.world?.entries && typeof fetched.world.entries === 'object') return Object.values(fetched.world.entries);
    return [];
}

function initialsOf(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    return words.slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

