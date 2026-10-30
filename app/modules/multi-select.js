

import * as CoreAPI from './core-api.js';
import { actionsFor as extActionsFor, hasActions as extHasActions, runAction as extRunAction, EXT_ACTION_EVENT } from './extension-host.js';
import { defineCommand, runCommand } from './ext-registry.js';
import { registerFeedPatcher } from './feed.js';
import Keymap from './keymap.js';

let isInitialized = false;

// Two selections, one at a time: ids picked by hand, or a Select All (the view's filter, its deselections, the server's count).
const MultiSelect = {
    enabled: false,
    selectedCharacters: new Map(), // char uuid -> character object
    // a Select All: { filter, except: Set of deselected ids, count, favorites }, or null
    all: null,

    enable() {
        this.enabled = true;
        document.body.classList.add('multi-select-mode');

        this.updateToolbar();
        CoreAPI.debugLog('[MultiSelect] Mode enabled');
    },

    // Exit, Space and Escape end the mode and empty the selection through library.select, so a wrapper hears it
    disable() {
        this.enabled = false;
        document.body.classList.remove('multi-select-mode');
        this.updateToolbar();
        void runCommand('library.select', { clear: true });
        CoreAPI.debugLog('[MultiSelect] Mode disabled');
    },

    // The card click and the menu's Select for Batch: one character, through library.select
    toggle(char, cardElement) {
        if (!this.enabled || !char?.id) return;
        return runCommand('library.select', { ids: [char.id], value: !this.isSelected(char.id) });
    },

    // The toolbar's Select All: every character the view's query matches, through library.select
    selectAll() {
        if (!this.enabled) return;
        return runCommand('library.select', { all: true });
    },

    clearSelection() {
        this.all = null;
        this.selectedCharacters.clear();
        document.querySelectorAll('.char-card.selected').forEach(card => {
            card.classList.remove('selected');
        });
        this.updateToolbar();
    },

    // deleted characters leave the selection so no bulk verb acts on a ghost; a Select All is counted again
    forgetMany(ids) {
        if (this.all) {
            for (const id of ids) this.all.except.delete(id);
            retallySoon();
            return;
        }
        let gone = false;
        for (const id of ids) if (this.selectedCharacters.delete(id)) gone = true;
        if (gone) this.updateToolbar();
    },

    // a favorite anywhere can change the toolbar's star: picked unloaded rows take the write's ids, a Select All recounts
    favoritesChanged(ids = [], value = undefined) {
        if (this.all) { retallySoon(); return; }
        if (value !== undefined) for (const id of ids) { const row = this.selectedCharacters.get(id); if (row) row.fav = value; }
        if (this.enabled) updateFavoriteToggleState();
    },

    // the page's row where it has one, the server's { id, fav } otherwise; a Select All is a filter,
    // never a list (a verb reads getSelection)
    getSelected() {
        if (this.all) throw new Error('a Select All holds a filter: read CoreAPI.getSelection()');
        return Array.from(this.selectedCharacters, ([id, row]) => CoreAPI.getCharacterById(id) || row);
    },

    getCount() {
        return this.all ? this.all.count : this.selectedCharacters.size;
    },

    // what a bulk verb sends: exactly one of ids and filter, so it spreads into a command's args
    getSelection() {
        if (this.all) return { count: this.all.count, filter: selectionFilter() };
        return { count: this.selectedCharacters.size, ids: [...this.selectedCharacters.keys()] };
    },

    // the toolbar's star: a Select All's from the server's count, a picked one off its rows
    allFavorited() {
        if (this.all) return this.all.count > 0 && this.all.favorites === this.all.count;
        return areAllSelectedFavorited();
    },

    // the grid re-asked: the Select All's own set recounts, any other set (search, chip, rule, playlist) ends it
    viewQueried(filter) {
        if (!this.all) return;
        if (filter !== null && CoreAPI.sameSet(filter, this.all.filter)) { retallySoon(); return; }
        void runCommand('library.select', { clear: true });
        CoreAPI.showToast('Selection cleared: the view changed', 'info');
    },

    updateToolbar() {
        const toolbar = document.getElementById('multiSelectToolbar');
        const countEl = document.getElementById('multiSelectCount');

        if (!toolbar) return;

        if (this.enabled) {
            const wasHidden = toolbar.classList.contains('hidden');
            toolbar.classList.remove('hidden');
            if (countEl) {
                countEl.textContent = this.getCount().toLocaleString();
            }
            updateFavoriteToggleState();
            renderExtensionBulkActions();
            // fitted before its first paint rather than a frame after
            if (wasHidden) CoreAPI.refitRow(toolbar.querySelector('.multi-select-actions'));
        } else {
            toolbar.classList.add('hidden');
        }
    },

    isSelected(charId) {
        return this.all ? !this.all.except.has(charId) : this.selectedCharacters.has(charId);
    }
};

// the Select All's filter as a verb sends it: the view's set, less the ids deselected since
function selectionFilter() {
    const { filter, except } = MultiSelect.all;
    if (!except.size) return filter;
    const p = new URLSearchParams(filter);
    p.set('notIds', [...except].join(','));
    return p.toString();
}

// A selection's count and its favourites, counted by the server over the set: one request whatever
// the set's size
async function tallySelection(filter) {
    return CoreAPI.readAnswer(await CoreAPI.apiRequest('/characters/tally', 'POST', { filter }));
}

// recount after a write moved the set: once per burst, a stale answer dropped, a failed count keeps the last
let _retallyTimer = null;
const RETALLY_MS = 150;
function retallySoon() {
    clearTimeout(_retallyTimer);
    _retallyTimer = setTimeout(retallyNow, RETALLY_MS);
}
async function retallyNow() {
    const held = MultiSelect.all;
    if (!held) return;
    let tally;
    try { tally = await tallySelection(selectionFilter()); } catch (e) { console.warn('[MultiSelect] the selection could not be counted again:', e.message); return; }
    if (MultiSelect.all !== held) return;
    held.count = tally.total;
    held.favorites = tally.favorites;
    MultiSelect.updateToolbar();
}

// one walk of the selection that stops at the first non-favorite, never a copy of it
function areAllSelectedFavorited() {
    if (!MultiSelect.selectedCharacters.size) return false;
    for (const [id, row] of MultiSelect.selectedCharacters) {
        if (!CoreAPI.isCharacterFavorite(CoreAPI.getCharacterById(id) || row)) return false;
    }
    return true;
}

function updateFavoriteToggleState() {
    const btn = document.getElementById('multiSelectFavToggleBtn');
    if (!btn) return;

    const unfavorite = MultiSelect.allFavorited();
    const state = unfavorite ? 'unfavorite' : 'favorite';
    if (btn.dataset.state === state) return;
    btn.dataset.state = state;
    btn.innerHTML = unfavorite
        ? '<i class="fa-regular fa-star"></i><span>Unfavorite</span>'
        : '<i class="fa-solid fa-star"></i><span>Favorite</span>';
    btn.title = unfavorite ? 'Remove all from favorites' : 'Add all to favorites';
    btn.classList.toggle('ms-btn-ghost', unfavorite);
    // Unfavorite is the wider label, so the bar's cutoff moves with it
    CoreAPI.refitRow(btn.parentElement);
}

// when()'s context: count, filter and characters copied once on first read (null under a Select All: unknown, not empty)
function bulkWhenContext() {
    const selection = { count: MultiSelect.getCount(), filter: MultiSelect.all ? selectionFilter() : null };
    if (MultiSelect.all) return { characters: null, selection };
    let selected = null;
    return { get characters() { return selected || (selected = MultiSelect.getSelected()); }, selection };
}

/**
 * A bulk verb's run context: the characters read at the click (a Select All walks its ids a page at a time) and the selection.
 * @returns {Promise<{characters: Array, selection: {count: number, filter: string|null}}>}
 */
async function bulkRunContext() {
    const sel = MultiSelect.getSelection();
    const selection = { count: sel.count, filter: sel.filter ?? null };
    if (sel.filter === undefined) return { characters: MultiSelect.getSelected(), selection };
    const characters = [];
    for await (const page of CoreAPI.walkCharacterSetWhere(sel.filter)) for (const row of page) characters.push(row);
    return { characters, selection };
}

// An extension's bulk verb over the selection (the toolbar's and the menu's); a set the server could
// not read runs nothing and says so
async function runBulkAction(key) {
    let context;
    try { context = await bulkRunContext(); } catch (e) {
        CoreAPI.showToast(`Could not read the selection: ${e.message}`, 'error');
        return;
    }
    extRunAction(key, context);
}

// extension bulk verbs beside the app's: when() is asked on every change, the group repainted only when its verbs changed
function renderExtensionBulkActions() {
    const box = document.getElementById('multiSelectExtActions');
    if (!box) return;
    // nothing registered: one map read per toolbar update, never a copy of the selection
    if (!extHasActions('bulk')) {
        if (box.dataset.shown !== '') { box.dataset.shown = ''; box.innerHTML = ''; CoreAPI.refitRow(box.parentElement); }
        return;
    }
    const acts = extActionsFor('bulk', bulkWhenContext());
    const shown = acts.map(a => `${a.key}\n${a.label}\n${a.icon}`).join('\n\n');
    if (box.dataset.shown === shown) return;
    box.dataset.shown = shown;
    box.innerHTML = acts.map(a => {
        const label = CoreAPI.escapeHtml(a.label);
        return `<button class="ms-btn" data-ext-action="${CoreAPI.escapeHtml(a.key)}" data-overflow-group="Extensions" title="${label}"><i class="fa-solid ${CoreAPI.escapeHtml(a.icon)}"></i><span>${label}</span></button>`;
    }).join('');
    CoreAPI.refitRow(box.parentElement);
}

// another tab's write of an extension's setting asks the drawn toolbar's when()s again, as a write here does
function patchBulkActionsFromFeed(records) {
    if (!MultiSelect.enabled || !extHasActions('bulk')) return;
    if (!records || records.some(r => r.all || (r.ids || []).some(k => String(k).startsWith('ext:')))) renderExtensionBulkActions();
}

// ========================================
// TOOLBAR INJECTION
// ========================================

function injectMultiSelectToolbar() {
    if (document.getElementById('multiSelectToolbar')) return;

    const toolbarHtml = `
    <div id="multiSelectToolbar" class="multi-select-toolbar hidden">
        <div class="multi-select-left">
            <div class="multi-select-badge">
                <i class="fa-solid fa-layer-group"></i>
                <span id="multiSelectCount">0</span>
            </div>
            <span class="multi-select-label">characters selected</span>
        </div>

        <div class="multi-select-actions">
            <button id="multiSelectAllBtn" class="ms-btn ms-btn-ghost" title="Select all filtered characters" data-overflow-label="Select all">
                <i class="fa-solid fa-check-double"></i>
                <span>Select All</span>
            </button>
            <button id="multiSelectBatchTagBtn" class="ms-btn" title="Edit tags on selected characters" data-overflow-label="Edit tags" data-phone-bar>
                <i class="fa-solid fa-tags"></i>
                <span>Tags</span>
            </button>
            <button id="multiSelectFavToggleBtn" class="ms-btn" title="Toggle favorites" data-phone-bar>
                <i class="fa-solid fa-star"></i>
                <span>Favorite</span>
            </button>
            <button id="multiSelectExportBtn" class="ms-btn" title="Export all selected characters" data-overflow-label="Export">
                <i class="fa-solid fa-download"></i>
                <span>Export</span>
            </button>
            <button id="multiSelectCheckUpdatesBtn" class="ms-btn" title="Check selected characters for updates from linked providers" data-overflow-label="Check for updates">
                <i class="fa-solid fa-arrows-rotate"></i>
                <span>Updates</span>
            </button>
            <button id="multiSelectPlaylistBtn" class="ms-btn" title="Add selected characters to a playlist" data-overflow-label="Add to playlist">
                <i class="fa-solid fa-list-ul"></i>
                <span>Playlist</span>
            </button>
            <div id="multiSelectExtActions" class="ms-ext-actions"></div>
            <button id="multiSelectMoreBtn" class="ms-btn ms-btn-more" title="More actions" aria-label="More actions">
                <i class="fa-solid fa-ellipsis"></i>
                <span>More</span>
            </button>
        </div>

        <div class="multi-select-right">
            <div class="ms-divider"></div>
            <button id="multiSelectDeleteBtn" class="ms-btn ms-btn-danger" title="Delete all selected characters">
                <i class="fa-solid fa-trash"></i>
                <span>Delete</span>
            </button>
            <button id="multiSelectExitBtn" class="ms-btn ms-btn-exit" title="Exit multi-select mode (Esc)">
                <i class="fa-solid fa-arrow-right-from-bracket"></i>
            </button>
        </div>
    </div>`;

    const galleryContent = document.querySelector('.gallery-content');
    if (galleryContent) {
        galleryContent.insertAdjacentHTML('beforebegin', toolbarHtml);
    } else {
        const header = document.querySelector('header.topbar');
        if (header) {
            header.insertAdjacentHTML('afterend', toolbarHtml);
        } else {
            document.body.insertAdjacentHTML('afterbegin', toolbarHtml);
        }
    }

    document.getElementById('multiSelectAllBtn')?.addEventListener('click', selectAllFromToolbar);
    document.getElementById('multiSelectExitBtn')?.addEventListener('click', () => MultiSelect.disable());

    document.getElementById('multiSelectBatchTagBtn')?.addEventListener('click', () => {
        const batchTagging = CoreAPI.getModule('batch-tagging');
        if (batchTagging?.openModal) {
            batchTagging.openModal();
        }
    });

    document.getElementById('multiSelectFavToggleBtn')?.addEventListener('click', () => {
        const contextMenu = CoreAPI.getModule('context-menu');
        contextMenu?.bulkToggleFavorites?.(!MultiSelect.allFavorited());
    });

    document.getElementById('multiSelectExportBtn')?.addEventListener('click', () => {
        const batchTransfer = CoreAPI.getModule('batch-transfer');
        batchTransfer?.openExportChooser?.();
    });

    document.getElementById('multiSelectDeleteBtn')?.addEventListener('click', () => {
        const contextMenu = CoreAPI.getModule('context-menu');
        contextMenu?.bulkDelete?.();
    });

    document.getElementById('multiSelectCheckUpdatesBtn')?.addEventListener('click', () => {
        const cardUpdates = CoreAPI.getModule('card-updates');
        if (cardUpdates?.checkSelectedCharacters) {
            cardUpdates.checkSelectedCharacters();
        }
    });

    document.getElementById('multiSelectPlaylistBtn')?.addEventListener('click', () => {
        const selection = MultiSelect.getSelection();
        if (selection.count) CoreAPI.openPlaylistPicker(selection);
    });

    document.getElementById('multiSelectExtActions')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-ext-action]');
        if (btn) runBulkAction(btn.dataset.extAction);
    });
    // the bar keeps what fits, the rest behind More (extension verbs last); a phone keeps only Tags and Favorite
    const actions = document.querySelector('#multiSelectToolbar .multi-select-actions');
    CoreAPI.fitRow(actions, {
        entries: () => [...actions.querySelectorAll('.ms-btn:not(#multiSelectMoreBtn)')],
        more: document.getElementById('multiSelectMoreBtn'),
        always: (el) => CoreAPI.isMobileMode() && !el.hasAttribute('data-phone-bar'),
    });
    // a verb that came or went while selecting shows or leaves at once, and a setting written here asks them again
    document.addEventListener(EXT_ACTION_EVENT, (e) => {
        if (e.detail?.slot === 'bulk' && MultiSelect.enabled) renderExtensionBulkActions();
    });
    // the feed runs the shell's settings patcher first, so the when()s read what it re-read
    registerFeedPatcher('setting', patchBulkActionsFromFeed);
}

// ========================================
// THE SELECTION VERB
// ========================================

// library.select: { ids, value } | { all } | { clear }, answering the count; under a Select All ids edit its exceptions
async function selectLibraryFrom({ ids, value = true, all = false, clear = false } = {}) {
    if (clear) {
        MultiSelect.clearSelection();
        return MultiSelect.getCount();
    }
    if (!MultiSelect.enabled) MultiSelect.enable();
    if (all) {
        await selectAllNow();
        return MultiSelect.getCount();
    }
    const list = (Array.isArray(ids) ? ids : []).map(String);
    if (MultiSelect.all) {
        await selectWithinAll(list, value);
        return MultiSelect.getCount();
    }
    // the ids the page has not loaded, read in one request per hundred rather than one each
    const unheld = value ? [...new Set(list.filter(id => !CoreAPI.getCharacterById(id)))] : [];
    if (unheld.length) await CoreAPI.fetchCharactersByIds(unheld);
    for (const id of list) {
        const card = document.querySelector(`.char-card[data-char-id="${CSS.escape(id)}"]`);
        if (value) {
            const char = CoreAPI.getCharacterById(id);
            if (!char) continue;
            MultiSelect.selectedCharacters.set(char.id, char);
            card?.classList.add('selected');
        } else {
            MultiSelect.selectedCharacters.delete(id);
            card?.classList.remove('selected');
        }
    }
    MultiSelect.updateToolbar();
    return MultiSelect.getCount();
}

// a Select All's deselect/reselect: a painted card moves the count itself, any other id is counted by the server once
async function selectWithinAll(list, value) {
    const held = MultiSelect.all;
    let recount = false;
    for (const id of list) {
        if (value ? !held.except.has(id) : held.except.has(id)) continue;
        const card = document.querySelector(`.char-card[data-char-id="${CSS.escape(id)}"]`);
        if (value) held.except.delete(id); else held.except.add(id);
        card?.classList.toggle('selected', value);
        const row = card ? CoreAPI.getCharacterById(id) : null;
        if (!row) { recount = true; continue; }
        const step = value ? 1 : -1;
        held.count += step;
        if (CoreAPI.isCharacterFavorite(row)) held.favorites += step;
    }
    MultiSelect.updateToolbar();
    if (recount) await retallyNow();
}

// select-all means the whole result set: held as the view's filter, counted by the server in one request, no ids read
async function selectAllNow() {
    const filter = CoreAPI.currentViewFilter();
    if (filter === null) {
        CoreAPI.showToast('This view matches nothing to select', 'info');
        return;
    }
    const tally = await tallySelection(filter);
    MultiSelect.selectedCharacters.clear();
    MultiSelect.all = { filter, except: new Set(), count: tally.total, favorites: tally.favorites };
    document.querySelectorAll('.char-card').forEach(card => {
        if (card.dataset.charId) card.classList.add('selected');
    });
    MultiSelect.updateToolbar();
}

// a set the server could not read leaves the selection as it was and says so (the phone's confirm replays this click)
function selectAllFromToolbar() {
    return Promise.resolve(MultiSelect.selectAll())
        .catch(e => CoreAPI.showToast(`Could not select them all: ${e.message}`, 'error'));
}

// a focused control takes its own Space, and a dialog open over the grid keeps it
const SPACE_OWNERS = 'input, textarea, select, button, a[href], summary, [contenteditable], [role="button"], [role="menuitem"], [role="option"]';
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (!Keymap.is(e, 'library.selectionMode')) return;
        // Space activates a focused control: bound to Space, the shortcut leaves those their key
        if (Keymap.bindingOf('library.selectionMode') === 'Space' && e.target?.closest?.(SPACE_OWNERS)) return;
        if (CoreAPI.getCurrentView() !== 'characters') return;
        if (CoreAPI.hasOpenOverlay(['multiSelectToolbar'])) return;
        e.preventDefault();

        if (MultiSelect.enabled) {
            MultiSelect.disable();
        } else {
            MultiSelect.enable();
        }
    });
}

function init() {
    if (isInitialized) {
        console.warn('[MultiSelect] Already initialized');
        return;
    }

    injectMultiSelectToolbar();
    setupKeyboardShortcuts();
    defineCommand('library.select', selectLibraryFrom, { title: 'Select characters' });
    CoreAPI.onCharactersDeleted((ids) => MultiSelect.forgetMany(ids));

    // Tier 10 - mode toggle, closes after all modals/dropdowns
    window.registerOverlay?.({
        id: 'multiSelectToolbar',
        tier: 10,
        close: () => MultiSelect.disable(),
        visible: () => MultiSelect.enabled,
    });

    window.MultiSelect = MultiSelect;
    window.handleCardClickForMultiSelect = function(char, cardElement) {
        if (MultiSelect.enabled) {
            MultiSelect.toggle(char, cardElement);
            return true;
        }
        return false;
    };

    isInitialized = true;
    CoreAPI.debugLog('[MultiSelect] Module initialized');
}

export default {
    init,
    // the bulk slot's contexts, for the context menu's copy of the toolbar's extension verbs
    bulkWhenContext,
    runBulkAction,
};
