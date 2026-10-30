// Lorebook Manager: the full-screen manager for the library's lorebooks (list, edit, create, rename,
// duplicate, import, export). Character-embedded books edit in the detail modal.

import CoreAPI from './core-api.js';
import { fetchWithProxy } from './providers/provider-utils.js';
import { newWorldEntry as newEntry, convertCharacterBookToNative, sanitizeWorldName, importBookToShelf, ENTRY_NUMBER_BLANKS } from './lorebook-shelf.js';
import { EXT_ACTION_EVENT, actionsFor as extActionsFor, hasActions as extHasActions, runAction as extRunAction, loreEntryContext } from './extension-host.js';
import { defineCommand } from './ext-registry.js';

const esc = (s) => CoreAPI.escapeHtml(s);

// ========================================
// WORLD FILE ENTRY SCHEMA (the fields and values world files carry)
// ========================================

const POSITION_OPTIONS = [
    [0, 'Before Character Defs'],
    [1, 'After Character Defs'],
    [2, "Top of Author's Note"],
    [3, "Bottom of Author's Note"],
    [4, '@ Depth'],
    [5, 'Top of Example Msgs'],
    [6, 'Bottom of Example Msgs'],
    [7, 'Outlet (named macro)'],
];

const LOGIC_OPTIONS = [
    [0, 'AND ANY'],
    [3, 'AND ALL'],
    [2, 'NOT ANY'],
    [1, 'NOT ALL'],
];

const ROLE_OPTIONS = [
    [0, 'System'],
    [1, 'User'],
    [2, 'Assistant'],
];

const TRISTATE_OPTIONS = [
    ['', 'Use Global'],
    ['true', 'Yes'],
    ['false', 'No'],
];

// Matching-source toggles ST scans beyond the chat log (newer WI feature).
const MATCH_SOURCES = [
    ['matchPersonaDescription', 'Persona description'],
    ['matchCharacterDescription', 'Character description'],
    ['matchCharacterPersonality', 'Character personality'],
    ['matchCharacterDepthPrompt', 'Character depth prompt'],
    ['matchScenario', 'Scenario'],
    ['matchCreatorNotes', 'Creator notes'],
];

// ST's GENERATION_TYPE_TRIGGERS vocabulary; an empty triggers array means every kind
const TRIGGER_TYPES = [
    ['normal', 'Normal'], ['continue', 'Continue'], ['impersonate', 'Impersonate'],
    ['swipe', 'Swipe'], ['regenerate', 'Regenerate'], ['quiet', 'Quiet'],
];

// Nullable numeric fields: empty input means "inherit the global WI setting".
const NULLABLE_NUMBERS = new Set(Object.keys(ENTRY_NUMBER_BLANKS).filter(k => ENTRY_NUMBER_BLANKS[k] === null));

// ========================================
// MODULE STATE
// ========================================

let isInitialized = false;
let eventsAttached = false;

let worldsList = [];          // [{ file_id, name, entryCount, placeholder, createdAt, updatedAt, extensions }]
// 'unread' | 'read' | 'failed': a shelf never read shows could-not-load on a failure, never the empty shelf
let shelfState = 'unread';
// The shelf's per-book counts (GET /worlds?counts=true, walked): name -> { chars, chats, global, personas }
let countsMap = new Map();
// The OPEN book's whole reach (GET /worlds/{name}/usage), the only book whose bindings are read
let usageMap = new Map();
// Derived views of usageMap, kept because the picker/unbind plumbing reads these shapes.
let linkedMap = new Map();       // file_id -> [{ id, name, char }]
let chatBoundMap = new Map();    // file_id -> [{ id, charId, charName, char, name }]
// Sidebar facet: which binding kind the list is narrowed to. Never re-means the view.
let worldFacet = 'all';          // 'all' | 'chars' | 'chats' | 'global' | 'personas' | 'unbound'

let currentWorld = null;      // file_id of the open world
let workingWorld = null;      // deep-cloned working copy { entries: {...}, ... }
let originalSnapshot = '';    // JSON of workingWorld at load/save, for dirty compare
let diskSnapshot = '';        // JSON of the file AS LOADED (pre-repair), for the save divergence guard
let dirty = false;

let worldSearch = '';
let worldSort = 'name';
let entrySearch = '';
let entrySort = 'order';
let creatingNew = false;
let editingNote = false;      // the book note (spec `description`) is being edited inline

const expandedUids = new Set();
const advancedUids = new Set();

// Link-to-characters picker state
let linkSelection = new Set();   // char uuids (characters mode) OR chat ids (chats mode)
let linkSearch = '';
let linkHideLinked = false;
let linkPlaylistUid = '';        // '' = all characters
let linkPlaylistAvailable = false; // any playlists exist (hides the filter when none)
let linkBook = null;             // file_id the picker is linking
let linkMode = 'characters';     // 'characters' | 'chats'
let linkManageMode = false;      // true = "manage links" view (show only linked, action = unlink)
let linkCarriedSet = new Set();  // char uuids already carrying linkBook (snapshot per picker open)
let manageChatList = [];         // chats mode + manage: the book's bound chats (cross-character)
let linkAllChats = [];           // chats mode: the server's answer to the search (recency-sorted, windowed)
let linkChatsLoading = false;
let linkChatsError = false;      // the last chats read failed: a could-not-load row, never "No chats yet."
let linkChatsTotal = 0;          // how many the search matched, beyond the window shown
let linkChatSeq = 0;             // the newest fetch wins; a slower older one is dropped
let linkSeenChats = new Map();   // id -> row, every chat this picker session has shown (a selection survives a narrower search)
// link picker: server-paged, virtualized candidates
let linkFiltered = [];           // current filtered+sorted candidate array (the "shown" set)
let linkPageCursor = null;       // keyset cursor for the paged candidates; null = exhausted
let linkPageSeq = 0;             // stale-response guard for async refreshes
let linkPageLoading = false;
let linkRowStride = 0;           // measured row height + gap (px); 0 = remeasure on next render
let vlistActive = false;         // is the link list currently windowed
let vlistData = null;            // { items, rowFn } for the active window
let vlistRaf = 0;                // rAF handle coalescing scroll repaints
let vlistListOffset = 0;         // px from the scroll container's top to the list's content (0 when the list scrolls itself)
let linkSearchTimer = 0;         // debounce handle for the picker search box

// Overrides for local saves/deletes between list refreshes; baseline counts ride the list rows.
const entryCountCache = new Map();

// ========================================
// MODAL SHELL
// ========================================

function createModal() {
    const html = `
    <div id="lorebookModal" class="modal-overlay hidden">
        <div class="modal-glass lb-modal-glass" data-fw-min="900x520">
            <div class="modal-header lb-header">
                <h2><i class="fa-solid fa-book-atlas"></i> Lorebooks</h2>
                <div class="modal-controls">
                    <button class="close-btn" id="lbCloseBtn" title="Close">&times;</button>
                </div>
            </div>

            <div class="modal-body lb-body">
                <aside class="lb-sidebar">
                    <div class="lb-sidebar-actions">
                        <div class="lb-split-btn">
                            <button class="lb-newbook-btn" id="lbNewBtn" title="Create a new blank lorebook">
                                <i class="fa-solid fa-plus"></i> New
                            </button>
                            <button class="lb-newbook-btn lb-split-caret" id="lbNewCaret" title="More ways to create" aria-label="More ways to create">
                                <i class="fa-solid fa-caret-down"></i>
                            </button>
                            <div class="lb-split-menu hidden" id="lbNewMenu">
                                <button class="dropdown-item" id="lbAiBtn">
                                    <i class="fa-solid fa-wand-magic-sparkles"></i> Generate with AI
                                </button>
                            </div>
                        </div>
                        <button class="lb-import-btn" id="lbImportBtn" title="Import a lorebook file (.json)">
                            <i class="fa-solid fa-file-import"></i> Import
                        </button>
                        <input type="file" id="lbImportInput" accept=".json,application/json" multiple hidden>
                    </div>
                    <div class="lb-sidebar-tools">
                        <div class="lb-search-wrap">
                            <i class="fa-solid fa-magnifying-glass"></i>
                            <input type="search" id="lbWorldSearch" class="cl-input" placeholder="Search lorebooks, characters, chats..." autocomplete="off">
                        </div>
                        <div class="lb-tools-row">
                            <div class="lb-facets" role="group" aria-label="Filter by binding">
                                <button class="lb-facet active" data-action="facet" data-facet="all" title="All lorebooks">All</button>
                                <button class="lb-facet" data-action="facet" data-facet="chars" title="Linked to characters" aria-label="Linked to characters"><i class="fa-solid fa-user"></i></button>
                                <button class="lb-facet" data-action="facet" data-facet="chats" title="Bound to chats" aria-label="Bound to chats"><i class="fa-solid fa-comment"></i></button>
                                <button class="lb-facet" data-action="facet" data-facet="global" title="Active in every chat" aria-label="Active in every chat"><i class="fa-solid fa-globe"></i></button>
                                <button class="lb-facet" data-action="facet" data-facet="personas" title="Bound to personas" aria-label="Bound to personas"><i class="fa-solid fa-masks-theater"></i></button>
                                <button class="lb-facet" data-action="facet" data-facet="unbound" title="Not bound anywhere" aria-label="Not bound anywhere"><i class="fa-solid fa-link-slash"></i></button>
                                <button class="lb-facet lb-facet-placeholders" id="lbShowPlaceholders" data-action="toggle-placeholders" title="Show placeholder books (names something binds, with no book yet)" aria-label="Show placeholder books" aria-pressed="false"><i class="fa-solid fa-ghost"></i></button>
                            </div>
                            <select id="lbWorldSort" class="lb-sort-select">
                                <option value="name">Name A-Z</option>
                                <option value="name_desc">Name Z-A</option>
                                <option value="entries">Most Entries</option>
                                <option value="linked">Most Bound</option>
                                <option value="created_desc">Created (Newest)</option>
                                <option value="created_asc">Created (Oldest)</option>
                                <option value="modified_desc">Modified (Newest)</option>
                                <option value="modified_asc">Modified (Oldest)</option>
                            </select>
                        </div>
                    </div>
                    <div class="lb-world-list" id="lbWorldList"></div>
                </aside>

                <section class="lb-content" id="lbContent">
                    <div class="lb-empty">
                        <i class="fa-solid fa-book-atlas"></i>
                        <p>Select a lorebook to edit, or create a new one.</p>
                    </div>
                </section>
            </div>
        </div>
    </div>

    <div id="lbLinkModal" class="cl-modal">
        <div class="cl-modal-content lb-link-modal-content" data-fw-min="480x440">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-link cl-modal-header-icon"></i> <span id="lbLinkVerb">Link</span> <strong id="lbLinkBookName"></strong></h3>
                <button class="cl-modal-close" id="lbLinkCloseBtn" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body lb-link-body">
                <div class="lb-link-mode-hint" id="lbLinkModeHint"></div>

                <div class="lb-link-head" id="lbLinkHead">
                    <div class="lb-link-head-inner">
                        <div class="lb-link-tools">
                            <div class="lb-search-wrap">
                                <i class="fa-solid fa-magnifying-glass"></i>
                                <input type="search" id="lbLinkSearch" class="cl-input" placeholder="Search characters..." autocomplete="off">
                            </div>
                            <div class="lb-link-playlist-wrap" id="lbLinkPlaylistWrap" hidden>
                                <select id="lbLinkPlaylistFilter" class="cl-select-fluid" title="Filter by playlist">
                                    <option value="">All Characters</option>
                                </select>
                            </div>
                        </div>

                        <div class="lb-link-selectbar">
                            <button class="lb-icon-btn" id="lbLinkSelectToggle" data-action="link-toggle-select" title="Select all shown"><i class="fa-solid fa-square-check"></i></button>
                            <label class="lb-link-filter-toggle" id="lbLinkHideLinkedWrap">
                                <input type="checkbox" id="lbLinkHideLinked">
                                <span>Hide already-linked</span>
                            </label>
                            <span class="lb-link-count" id="lbLinkCount">0 selected</span>
                        </div>
                    </div>
                </div>

                <div class="lb-link-list" id="lbLinkList"></div>
            </div>
            <div class="cl-modal-footer lb-link-footer">
                <button class="cl-btn cl-btn-secondary" id="lbLinkCancelBtn">Cancel</button>
                <button class="cl-btn cl-btn-primary" id="lbLinkApplyBtn" disabled><i class="fa-solid fa-link"></i> Link <span id="lbLinkApplyCount"></span></button>
            </div>
        </div>
    </div>`;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    Array.from(wrap.children).forEach(el => document.body.appendChild(el));
    CoreAPI.mountDialogSizing('lorebookModal');
    CoreAPI.mountSeam(document.querySelector('#lorebookModal .lb-sidebar'), { key: 'lorebookModal:sidebar', minPx: 320, max: 50 });
    CoreAPI.mountDialogSizing('lbLinkModal');
}

// ========================================
// OPEN / CLOSE
// ========================================

async function openModal(focusWorld) {
    let modal = document.getElementById('lorebookModal');
    if (!modal) {
        createModal();
        modal = document.getElementById('lorebookModal');
        attachEvents();
        const sortSel = document.getElementById('lbWorldSort');
        if (sortSel) CoreAPI.initCustomSelect(sortSel);
    }
    modal.classList.remove('hidden');
    // Sync the persistent facet DOM to the (reset) All facet on each open.
    document.querySelectorAll('.lb-facet[data-facet]').forEach(b => b.classList.toggle('active', b.dataset.facet === worldFacet));
    // focusWorld may arrive as an event object when wired directly to a listener; ignore non-strings.
    const target = typeof focusWorld === 'string' ? focusWorld : null;
    await refreshList({ keepSelection: !target });
    if (target && worldsList.some(w => w.file_id === target)) {
        await selectWorld(target);
    } else if (target && shelfState !== 'failed') {
        CoreAPI.showToast(`Lorebook "${target}" not found`, 'warning');
    }
}

/**
 * The lorebook.open command: the manager, on a book when `name` is given, an entry opened and marked when `uid` is too.
 * @returns {Promise<boolean>} whether it is on screen (false: missing book or entry, or unsaved edits kept)
 */
async function openLorebookFrom({ name, uid } = {}) {
    if (name != null && (typeof name !== 'string' || !name)) throw new Error('lorebook.open: name is a lorebook\'s name');
    if (uid != null && (!Number.isInteger(uid) || name == null)) throw new Error('lorebook.open: uid is an entry\'s number, given with the name of its book');
    await openModal(name ?? undefined);
    if (name == null) return true;
    if (currentWorld !== name) return false;
    if (uid == null) return true;
    if (revealEntry(uid)) return true;
    CoreAPI.showToast(`That entry is not in "${name}"`, 'warning');
    return false;
}

// One entry of the open book brought into view and marked, opened, with a search that would hide it cleared
function revealEntry(uid) {
    if (!workingWorld?.entries?.[uid]) return false;
    entrySearch = '';
    expandedUids.add(uid);
    renderEditor();
    const row = document.getElementById(`lbEntry-${uid}`);
    if (!row) return false;
    // the head, not the row: an open entry is taller than the pane, and centring it would put its
    // title under the sticky toolbar
    (row.querySelector('.lb-entry-head') || row).scrollIntoView({ block: 'center' });
    row.classList.remove('is-revealed');
    void row.offsetWidth;
    row.classList.add('is-revealed');
    setTimeout(() => row.classList.remove('is-revealed'), 2000);
    return true;
}

function closeModal() {
    if (dirty) {
        CoreAPI.showConfirm({
            title: 'Discard unsaved changes?',
            message: `You have unsaved edits to "${currentWorld}". Discard them?`,
            confirmLabel: 'Discard',
            cancelLabel: 'Keep Editing',
            danger: true,
        }).then(ok => { if (ok) forceClose(); });
        return;
    }
    forceClose();
}

function forceClose() {
    document.getElementById('lorebookModal')?.classList.add('hidden');
    // release the heavy buffers so a closed manager doesnt pin a world file, its snapshot and char refs
    workingWorld = null;
    originalSnapshot = '';
    diskSnapshot = '';
    currentWorld = null;
    dirty = false;
    expandedUids.clear();
    advancedUids.clear();
    usageMap = new Map();
    linkedMap = new Map();
    chatBoundMap = new Map();
    carrierHits = { q: '', byWorld: new Map() };
    linkCarriedSet = new Set();
    linkSelection = new Set();
    linkAllChats = [];
    // Reset the facet to match the freshly-built bar (defaults to All) on reopen.
    worldFacet = 'all';
}

// ========================================
// DATA LOADING
// ========================================

// names to steer clear of, off the SERVER list (the cache misses another tab's create); advisory, the server refuses a taken name
async function takenWorldIds() {
    const shelf = await CoreAPI.listWorldInfoFiles({ placeholders: 'all' }) || [];
    return new Set(shelf.map(w => (w.file_id || '').toLowerCase()));
}

// A read that failed says so with a retry beside its list, never as the list's empty state
function retryButtonHtml(action) {
    return `<button type="button" class="cl-btn cl-btn-secondary cl-btn-sm u-mt-sm" data-action="${action}"><i class="fa-solid fa-rotate-right"></i> Retry</button>`;
}

async function refreshList({ keepSelection = false } = {}) {
    // No first-load loader: the list paints as soon as the fetch resolves; the loading
    // animation was more distracting than the brief empty state it replaced.
    const shelf = await CoreAPI.listWorldInfoFiles({ placeholders: 'all' });
    if (shelf) {
        worldsList = shelf;
        shelfState = 'read';
        entryCountCache.clear();  // fresh rows carry fresh counts; overrides only bridge between refreshes
    } else if (shelfState === 'read') {
        // the rows on screen stay, as the library grid keeps its last good view, and are said to be stale
        CoreAPI.showToast('Your lorebooks could not be refreshed', 'error');
    } else {
        shelfState = 'failed';
    }
    await refreshUsage();
    renderWorldList();
    if (keepSelection && currentWorld && worldsList.some(w => w.file_id === currentWorld)) {
        // working copy already in memory; keep the editor, re-assert mobile editing view
        setEditingMode(true);
    } else if (!currentWorld) {
        renderEmptyContent();
    }
}

// per-book counts and the open book's reach, re-read after a binding verb; a failed counts read keeps the old (unknown isnt none)
async function refreshUsage() {
    try {
        const rows = await CoreAPI.fetchAllPages('/worlds', { counts: 'true', count: 'false' });
        countsMap = new Map(rows.map(r => [r.name, r]));
    } catch (e) {
        console.warn('[Lorebooks] counts read failed', e);
    }
    await readOpenReach();
    // a standing search is asked again: who a book binds may have moved, or a close dropped the hits
    const q = worldSearch.trim().toLowerCase();
    if (q) await searchCarriers(q);
}

// the open book's whole reach; a null charName is an orphan link, skipped for display but seen by the sweeps
async function readOpenReach() {
    const name = currentWorld;
    usageMap = new Map();
    linkedMap = new Map();
    chatBoundMap = new Map();
    if (!name) return;
    let u = null;
    try {
        const resp = await CoreAPI.apiRequest(`/worlds/${encodeURIComponent(name)}/usage`, 'GET');
        if (resp.ok) u = await resp.json();
    } catch (e) {
        console.warn('[Lorebooks] reach read failed', e);
    }
    if (!u || name !== currentWorld) return;
    usageMap.set(name, u);
    const chars = (u.chars || []).filter(c => c.name != null).map(c => ({ id: c.id, name: c.name, char: null }));
    if (chars.length) linkedMap.set(name, chars);
    const chats = (u.chats || []).map(c => ({ id: c.id, charId: c.charId, charName: c.charName, char: null, name: c.name }));
    if (chats.length) chatBoundMap.set(name, chats);
}

// a character deleted while open leaves the reach and the picker: picks drop it and its chats, each list re-reads
async function onCharactersDeleted(charIds) {
    const modal = document.getElementById('lorebookModal');
    if (!modal || modal.classList.contains('hidden')) return;
    const gone = new Set(charIds);
    const goneChats = [...linkSeenChats.values(), ...linkAllChats, ...manageChatList].filter(c => gone.has(c.charId)).map(c => c.id);
    for (const id of [...gone, ...goneChats]) {
        linkSelection.delete(id);
        linkCarriedSet.delete(id);
        linkSeenChats.delete(id);
    }
    linkAllChats = linkAllChats.filter(c => !gone.has(c.charId));
    manageChatList = manageChatList.filter(c => !gone.has(c.charId));
    const openBound = !!currentWorld && ((linkedMap.get(currentWorld) || []).some(c => gone.has(c.id)) || (chatBoundMap.get(currentWorld) || []).some(c => gone.has(c.charId)));
    await refreshUsage();
    renderWorldList();
    // only the bindings strip, and only if the book bound one; fields being typed are never rebuilt for a delete
    if (openBound) {
        const strip = document.querySelector('#lbContent .lb-bindings');
        if (strip) strip.outerHTML = renderBindingsStrip();
    }
    if (document.getElementById('lbLinkModal')?.classList.contains('visible')) {
        if (linkMode === 'chats' && !linkManageMode) void loadAllChatsForPicker();
        else renderLinkList();
        updateLinkFooter();
    }
}

function entryCountOf(world) {
    // Open world: exact from the working copy. Locally saved/deleted: the cache override.
    // Otherwise the list row's own entryCount (GET /worlds carries it).
    if (world.file_id === currentWorld && workingWorld) {
        return Object.keys(workingWorld.entries || {}).length;
    }
    if (entryCountCache.has(world.file_id)) return entryCountCache.get(world.file_id);
    return Number.isFinite(world.entryCount) ? world.entryCount : null;
}

// A book's reach per kind, off the shelf's counts.
function reachOf(fileId) {
    const c = countsMap.get(fileId);
    const chars = c?.chars || 0, chats = c?.chats || 0, personas = c?.personas || 0, global = !!c?.global;
    return { chars, chats, global, personas, total: chars + chats + personas + (global ? 1 : 0) };
}

// The per-kind chip run, shared by the sidebar rows and the mobile details toggle.
function reachChipsHtml(fileId) {
    const r = reachOf(fileId);
    const chips = [];
    if (r.chars) chips.push(`<span class="lb-reach-chip" title="${r.chars} linked character${r.chars === 1 ? '' : 's'}"><i class="fa-solid fa-user"></i>${r.chars}</span>`);
    if (r.chats) chips.push(`<span class="lb-reach-chip" title="${r.chats} bound chat${r.chats === 1 ? '' : 's'}"><i class="fa-solid fa-comment"></i>${r.chats}</span>`);
    if (r.global) chips.push(`<span class="lb-reach-chip is-global" title="Active in every chat"><i class="fa-solid fa-globe"></i></span>`);
    if (r.personas) chips.push(`<span class="lb-reach-chip" title="${r.personas} persona binding${r.personas === 1 ? '' : 's'}"><i class="fa-solid fa-masks-theater"></i>${r.personas}</span>`);
    return chips.join('');
}

function setWorldFacet(facet) {
    if (facet === worldFacet) return;
    worldFacet = facet;
    document.querySelectorAll('.lb-facet[data-facet]').forEach(b => b.classList.toggle('active', b.dataset.facet === facet));
    renderWorldList();
}

// ========================================
// WORLD LIST (SIDEBAR)
// ========================================

// The search's carrier hits, for the query they were asked with: world name -> the names that matched
let carrierHits = { q: '', byWorld: new Map() };
let _carrierTimer = null;
let _carrierSeq = 0;

// who a book binds is the server's answer (name prefix via the indexes), asked once typing settles
function scheduleCarrierSearch() {
    clearTimeout(_carrierTimer);
    const q = worldSearch.trim().toLowerCase();
    if (!q) { _carrierSeq++; carrierHits = { q: '', byWorld: new Map() }; return; }
    _carrierTimer = setTimeout(() => searchCarriers(q), 250);
}

async function searchCarriers(q) {
    const seq = ++_carrierSeq;
    let rows = null;
    try {
        const resp = await CoreAPI.apiRequest(`/world-carriers?prefix=${encodeURIComponent(q)}`, 'GET');
        if (resp.ok) rows = await resp.json();
    } catch { /* the book-name match alone stands */ }
    if (seq !== _carrierSeq || q !== worldSearch.trim().toLowerCase()) return;
    carrierHits = { q, byWorld: new Map((Array.isArray(rows) ? rows : []).map(r => [r.name, r.matches || []])) };
    renderWorldList();
}

// carrier names of ANY kind matching the query, for "I know the character, chat or persona, not the book"
function matchedNamesFor(fileId, q) {
    if (!q || carrierHits.q !== q) return [];
    return carrierHits.byWorld.get(fileId) || [];
}

function worldMatchesQuery(w, q) {
    if (!q) return true;
    // Match on file_id only: ST identifies + displays world files by filename, not the (often stale)
    // internal JSON "name" field, so we mirror that everywhere.
    if (w.file_id.toLowerCase().includes(q)) return true;
    return matchedNamesFor(w.file_id, q).length > 0;
}

function worldMatchesFacet(w) {
    if (worldFacet === 'all') return true;
    const r = reachOf(w.file_id);
    if (worldFacet === 'chars') return r.chars > 0;
    if (worldFacet === 'chats') return r.chats > 0;
    if (worldFacet === 'global') return r.global;
    if (worldFacet === 'personas') return r.personas > 0;
    if (worldFacet === 'unbound') return r.total === 0;
    return true;
}

// placeholders hide behind the ghost chip (the lore panel's switch too, so read at every use); name checks still see them
function showPlaceholders() {
    return CoreAPI.getSetting('loreShowPlaceholders') === true;
}

function syncPlaceholderChip() {
    const chip = document.getElementById('lbShowPlaceholders');
    if (!chip) return;
    const on = showPlaceholders();
    chip.classList.toggle('active', on);
    chip.setAttribute('aria-pressed', String(on));
}

function togglePlaceholders() {
    CoreAPI.setSetting('loreShowPlaceholders', !showPlaceholders());
    renderWorldList();
}

function filteredSortedWorlds() {
    const q = worldSearch.trim().toLowerCase();
    // The open book stays listed even when it is a placeholder being hidden: the shelf
    // must never lose the row the editor is standing on.
    const placeholders = showPlaceholders();
    let list = worldsList.filter(w => (placeholders || !w.placeholder || w.file_id === currentWorld) && worldMatchesFacet(w) && worldMatchesQuery(w, q));
    switch (worldSort) {
        case 'name_desc':
            list.sort((a, b) => b.file_id.localeCompare(a.file_id)); break;
        case 'entries':
            list.sort((a, b) => (entryCountOf(b) ?? -1) - (entryCountOf(a) ?? -1)); break;
        case 'linked':
            list.sort((a, b) => reachOf(b.file_id).total - reachOf(a.file_id).total || a.file_id.localeCompare(b.file_id)); break;
        case 'created_desc':
            list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.file_id.localeCompare(b.file_id)); break;
        case 'created_asc':
            list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.file_id.localeCompare(b.file_id)); break;
        case 'modified_desc':
            list.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.file_id.localeCompare(b.file_id)); break;
        case 'modified_asc':
            list.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || a.file_id.localeCompare(b.file_id)); break;
        default:
            list.sort((a, b) => a.file_id.localeCompare(b.file_id));
    }
    return list;
}

function renderWorldList() {
    const listEl = document.getElementById('lbWorldList');
    if (!listEl) return;
    // the chip says what the list it governs is painted under, whichever surface last set it
    syncPlaceholderChip();

    const list = filteredSortedWorlds();
    let html = '';

    if (creatingNew) {
        html += `
            <div class="lb-newbook-row">
                <i class="fa-solid fa-book"></i>
                <input type="search" id="lbNewNameInput" class="lb-newbook-input" placeholder="Lorebook name..." autocomplete="one-time-code">
            </div>`;
    }

    const q = worldSearch.trim().toLowerCase();
    if (shelfState === 'failed' && !creatingNew) {
        html += `<div class="lb-list-empty">Could not load your lorebooks.<br>${retryButtonHtml('shelf-retry')}</div>`;
    } else if (list.length === 0 && !creatingNew) {
        const FACET_EMPTY = {
            chars: 'No books bound to a character yet.',
            chats: 'No books bound to a chat yet.',
            global: 'No global books yet.',
            personas: 'No books bound to a persona yet.',
            unbound: 'Every book is bound somewhere.',
        };
        // the chip only explains an empty shelf when it is what emptied it
        const hiddenByChip = !showPlaceholders() && worldsList.some(w => w.placeholder && w.file_id !== currentWorld && worldMatchesFacet(w) && worldMatchesQuery(w, q));
        html += worldsList.length === 0
            ? `<div class="lb-list-empty">No lorebooks yet.<br>Create or import one to start.</div>`
            : hiddenByChip
                ? `<div class="lb-list-empty">Only placeholder books here.<br>The ghost chip shows them.</div>`
                : q
                    ? `<div class="lb-list-empty">No matches for "${esc(worldSearch)}".</div>`
                    : `<div class="lb-list-empty">${FACET_EMPTY[worldFacet] || 'No lorebooks here.'}</div>`;
    }

    for (const w of list) {
        const count = entryCountOf(w);
        const active = w.file_id === currentWorld ? ' active current' : '';
        // Only flag a carrier match when the query didn't already hit the book name (file_id).
        const nameHit = q && w.file_id.toLowerCase().includes(q);
        const nameHits = nameHit ? [] : matchedNamesFor(w.file_id, q);
        const meta = w.placeholder ? 'placeholder, no book yet' : count === null ? '...' : `${count} ${count === 1 ? 'entry' : 'entries'}`;
        const viaLine = nameHits.length
            ? `<span class="lb-world-via" title="${esc(nameHits.join(', '))}">via ${esc(nameHits.join(', '))}</span>`
            : '';
        const chips = reachChipsHtml(w.file_id);
        html += `
            <button class="lb-world-row lorebook-link-row${active}${nameHits.length ? ' char-match' : ''}" data-action="select-world" data-world="${esc(w.file_id)}" title="${esc(w.file_id)}">
                <i class="fa-solid fa-book lb-world-icon"></i>
                <span class="lb-world-info">
                    <span class="lb-world-name">${esc(w.file_id)}</span>
                    <span class="lb-world-meta">${esc(meta)}</span>
                    ${viaLine}
                </span>
                ${chips ? `<span class="lb-world-reach">${chips}</span>` : ''}
            </button>`;
    }

    listEl.innerHTML = html;

    if (creatingNew) {
        const input = document.getElementById('lbNewNameInput');
        input?.focus();
    }
}

// ========================================
// CONTENT PANE
// ========================================

// Mobile: toggle a class on .lb-body so CSS can swap between the world list and the editor.
function setEditingMode(on) {
    document.querySelector('#lorebookModal .lb-body')?.classList.toggle('lb-editing', !!on);
}

function renderEmptyContent() {
    setEditingMode(false);
    const el = document.getElementById('lbContent');
    if (!el) return;
    if (shelfState === 'failed') {
        el.innerHTML = `<div class="lb-empty">
                <i class="fa-solid fa-plug-circle-xmark"></i>
                <p>Could not load your lorebooks.</p>
                ${retryButtonHtml('shelf-retry')}
           </div>`;
        return;
    }
    el.innerHTML = worldsList.length === 0
        ? `<div class="lb-empty">
                <i class="fa-solid fa-book-atlas"></i>
                <p>You don't have any lorebooks yet.</p>
                <div class="lb-empty-actions">
                    <button class="lb-newbook-btn" data-action="empty-new"><i class="fa-solid fa-plus"></i> New Lorebook</button>
                    <button class="lb-import-btn" data-action="empty-import"><i class="fa-solid fa-file-import"></i> Import</button>
                </div>
           </div>`
        : `<div class="lb-empty">
                <i class="fa-solid fa-book-atlas"></i>
                <p>Select a lorebook to edit, or create a new one.</p>
           </div>`;
}

// adopt loaded data as the working copy: the raw snapshot for the save guard, then the key-canonical uid repair
function adoptWorldData(fileId, data) {
    diskSnapshot = stableStringify(data);
    if (!data.entries || typeof data.entries !== 'object') data.entries = {};
    currentWorld = fileId;
    workingWorld = JSON.parse(JSON.stringify(data));
    for (const [key, entry] of Object.entries(workingWorld.entries)) {
        const n = Number(key);
        if (entry && typeof entry === 'object' && Number.isFinite(n) && entry.uid !== n) entry.uid = n;
    }
    originalSnapshot = JSON.stringify(workingWorld);
    dirty = false;
}

// the open book written elsewhere re-reads in place, keeping the view (expanded, search, sort, scroll)
async function reloadOpenWorld() {
    const fileId = currentWorld;
    const data = await CoreAPI.getWorldInfoData(fileId);
    // the read was out while the reader could type: the house rule is asked again on its answer
    if (!data || currentWorld !== fileId || heldByEdits()) return;
    adoptWorldData(fileId, data);
    const el = document.getElementById('lbContent');
    const top = el?.scrollTop ?? 0;
    renderEditor();
    if (el) el.scrollTop = top;
    renderWorldList();
}

// A field of the open book being typed in: an entry's, the add-key box, the note.
function editorFieldFocused() {
    const active = document.activeElement;
    return !!active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || '') && !!document.getElementById('lbContent')?.contains(active);
}

// a dirty book or a focused field is told, not reloaded (unsaved edits outrank staleness); true when it held
function heldByEdits() {
    if (!dirty && !editorFieldFocused()) return false;
    CoreAPI.showToast('This lorebook changed elsewhere. Save or discard to see the new version.', 'warning');
    return true;
}

// Another surface changed a lorebook while this was open (the in-chat panel, another tab).
async function onWorldsChangedElsewhere(e) {
    const modal = document.getElementById('lorebookModal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (e.detail?.source === 'lorebook-manager') return;

    // null world = several or unknown; the list re-reads either way, only the OPEN book its entries
    const changed = e.detail?.world || null;
    await refreshList({ keepSelection: true });
    if (!currentWorld || (changed && changed !== currentWorld) || heldByEdits()) return;
    await reloadOpenWorld();
}

async function selectWorld(fileId) {
    if (fileId === currentWorld) return;
    if (dirty) {
        const ok = await CoreAPI.showConfirm({
            title: 'Discard unsaved changes?',
            message: `You have unsaved edits to "${currentWorld}". Discard them and switch?`,
            confirmLabel: 'Discard',
            cancelLabel: 'Keep Editing',
            danger: true,
        });
        if (!ok) return;
    }

    // No loader on switch: the load is sub-second, so the previous content simply stays until
    // the editor re-renders, which is smoother than flashing a spinner.
    const data = await CoreAPI.getWorldInfoData(fileId);
    if (!data) {
        CoreAPI.showToast('Failed to load lorebook', 'error');
        renderEmptyContent();
        return;
    }
    adoptWorldData(fileId, data);
    await readOpenReach();
    expandedUids.clear();
    advancedUids.clear();
    entrySearch = '';
    entrySort = 'order';
    editingNote = false;

    setEditingMode(true);
    renderEditor();
    // Barely-there settle so the swap doesn't snap. Scoped here (the switch path), not in
    // renderEditor, so it doesn't replay on every edit-driven re-render.
    document.getElementById('lbContent')?.animate(
        [{ opacity: 0.5 }, { opacity: 1 }],
        { duration: 150, easing: 'ease-out' },
    );
    renderWorldList();
}

// ========================================
// LOREBOOK LIST KEYBOARD NAV (up/down through the sidebar)
// ========================================

// Manager is the frontmost keyboard context (open, nothing on top owning the keys).
function lbNavAllowed() {
    const modal = document.getElementById('lorebookModal');
    if (!modal || modal.classList.contains('hidden')) return false;
    if (document.querySelector('.cl-modal.visible, .confirm-modal:not(.hidden), .cl-confirm-overlay:not(.hidden)')) return false;
    const cm = document.getElementById('charModal');
    if (cm && !cm.classList.contains('hidden')) return false;
    return true;
}

// up/down load the prev/next book (clamped); selectWorld owns the unsaved-edits guard
function moveActiveWorld(dir) {
    const worlds = filteredSortedWorlds();
    if (!worlds.length) return;
    let idx = worlds.findIndex(w => w.file_id === currentWorld);
    if (idx === -1) idx = dir > 0 ? 0 : worlds.length - 1;
    else idx = Math.max(0, Math.min(worlds.length - 1, idx + dir));
    const target = worlds[idx];
    if (!target || target.file_id === currentWorld) return;
    Promise.resolve(selectWorld(target.file_id)).then(() => {
        document.querySelector('#lbWorldList .lb-world-row.active')?.scrollIntoView({ block: 'nearest' });
    });
}

// ========================================
// EDITOR RENDER
// ========================================

function sortedEntries() {
    const list = Object.values(workingWorld.entries).filter(e => e && typeof e === 'object');
    const q = entrySearch.trim().toLowerCase();
    let filtered = list;
    if (q) {
        filtered = list.filter(e =>
            (e.comment || '').toLowerCase().includes(q) ||
            (e.content || '').toLowerCase().includes(q) ||
            (Array.isArray(e.key) ? e.key.join(' ') : '').toLowerCase().includes(q) ||
            (Array.isArray(e.keysecondary) ? e.keysecondary.join(' ') : '').toLowerCase().includes(q)
        );
    }
    switch (entrySort) {
        case 'title':
            filtered.sort((a, b) => (a.comment || '').localeCompare(b.comment || '')); break;
        case 'added':
            filtered.sort((a, b) => Number(a.uid) - Number(b.uid)); break;
        case 'added_desc':
            filtered.sort((a, b) => Number(b.uid) - Number(a.uid)); break;
        default: // order ascending (lower order inserts higher)
            filtered.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || Number(a.uid) - Number(b.uid));
    }
    return filtered;
}

function renderEditor() {
    const el = document.getElementById('lbContent');
    if (!el || !workingWorld) return;

    const entries = sortedEntries();
    const total = Object.keys(workingWorld.entries).length;
    const displayName = currentWorld; // the filename (file_id) is the canonical name, matching ST

    el.innerHTML = `
        <div class="lb-editor">
            <div class="lb-editor-head">
                <div class="lb-editor-title-row">
                    <h3 class="lb-editor-title" id="lbWorldTitle" title="${esc(displayName)}">${esc(displayName)}</h3>
                    <div class="lb-editor-actions">
                        <button class="lb-icon-btn lb-action-desktop" data-action="rename-world" title="Rename"><i class="fa-solid fa-pen"></i></button>
                        <button class="lb-icon-btn lb-action-desktop" data-action="duplicate-world" title="Duplicate"><i class="fa-solid fa-clone"></i></button>
                        <button class="lb-icon-btn lb-action-desktop" data-action="export-world" title="Export JSON"><i class="fa-solid fa-file-export"></i></button>
                        <button class="lb-icon-btn danger lb-action-desktop" data-action="delete-world" title="Delete"><i class="fa-solid fa-trash"></i></button>
                        <div class="lb-editor-overflow lb-action-mobile">
                            <button class="lb-icon-btn" data-action="editor-overflow" aria-label="More actions" title="More"><i class="fa-solid fa-ellipsis-vertical"></i></button>
                            <div class="lb-split-menu lb-editor-overflow-menu hidden" id="lbEditorOverflowMenu">
                                <button class="dropdown-item" data-action="rename-world"><i class="fa-solid fa-pen"></i> Rename</button>
                                <button class="dropdown-item" data-action="duplicate-world"><i class="fa-solid fa-clone"></i> Duplicate</button>
                                <button class="dropdown-item" data-action="export-world"><i class="fa-solid fa-file-export"></i> Export JSON</button>
                                <button class="dropdown-item lb-overflow-danger" data-action="delete-world"><i class="fa-solid fa-trash"></i> Delete</button>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="lb-editor-meta">
                    <span class="lb-meta-pill"><i class="fa-solid fa-list"></i> ${total} ${total === 1 ? 'entry' : 'entries'}</span>
                </div>
                ${renderBindingsStrip()}
                ${renderBookNote()}
            </div>

            <div class="lb-entries-toolbar">
                <div class="lb-search-wrap">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input type="search" id="lbEntrySearch" class="cl-input" placeholder="Search entries..." value="${esc(entrySearch)}" autocomplete="off">
                </div>
                <select id="lbEntrySort" class="lb-sort-select">
                    <option value="order"${entrySort === 'order' ? ' selected' : ''}>By Order</option>
                    <option value="title"${entrySort === 'title' ? ' selected' : ''}>By Title</option>
                    <option value="added"${entrySort === 'added' ? ' selected' : ''}>Oldest First</option>
                    <option value="added_desc"${entrySort === 'added_desc' ? ' selected' : ''}>Newest First</option>
                </select>
                <div class="lb-toolbar-spacer"></div>
                ${(() => {
                    const allExpanded = entries.length > 0 && entries.every(e => expandedUids.has(e.uid));
                    return `<button class="lb-icon-btn" data-action="toggle-all" title="${allExpanded ? 'Collapse all' : 'Expand all'}"><i class="fa-solid ${allExpanded ? 'fa-up-right-and-down-left-from-center' : 'fa-down-left-and-up-right-to-center fa-rotate-90'}"></i></button>`;
                })()}
                <button class="lb-ai-entry-btn" data-action="ai-generate" title="Generate entries with AI"><i class="fa-solid fa-wand-magic-sparkles"></i><span class="lb-ai-entry-label">AI</span></button>
                <button class="lb-add-entry-btn" data-action="add-entry" title="Add entry"><i class="fa-solid fa-plus"></i><span class="lb-add-full">Add Entry</span><span class="lb-add-short">Add</span></button>
                <button class="lb-save-btn${dirty ? ' dirty' : ''}" id="lbSaveBtn" data-action="save" ${dirty ? '' : 'disabled'} title="Save changes">
                    <i class="fa-solid fa-floppy-disk"></i> <span>${dirty ? 'Save *' : 'Saved'}</span>
                </button>
            </div>

            <div class="lb-entries" id="lbEntries">
                ${entries.length ? entries.map(e => renderEntryRow(e)).join('') : renderNoEntries(total)}
            </div>
        </div>`;

    const sortSel = document.getElementById('lbEntrySort');
    if (sortSel) CoreAPI.initCustomSelect(sortSel);
    growVisibleContentFields(); // fit each open entry's content field to its text
}

function renderNoEntries(total) {
    return total === 0
        ? `<div class="lb-entries-empty">
                <i class="fa-solid fa-feather"></i>
                <p>This lorebook is empty.</p>
                <button class="lb-add-entry-btn" data-action="add-entry"><i class="fa-solid fa-plus"></i> Add Your First Entry</button>
           </div>`
        : `<div class="lb-entries-empty"><i class="fa-solid fa-magnifying-glass"></i><p>No entries match "${esc(entrySearch)}".</p></div>`;
}

// The book note: the spec's book-level `description`, stored in the doc
// blank deletes the key, so opening a book never adds description: ""
function renderBookNote() {
    if (editingNote) {
        return `<div class="lb-book-note is-editing">
            <textarea id="lbBookNoteInput" class="lb-book-note-input" rows="2"
                placeholder="Notes about this lorebook (saved inside the book, travels with exports)">\n${esc(String(workingWorld.description || ''))}</textarea>
        </div>`;
    }
    const note = String(workingWorld.description || '').trim();
    return note
        ? `<button class="lb-book-note" data-action="edit-note" title="Edit the note">${esc(note)}</button>`
        : `<button class="lb-book-note is-empty" data-action="edit-note"><i class="fa-solid fa-pen"></i> Add a Note</button>`;
}

function commitBookNote(cancel = false) {
    const box = document.getElementById('lbBookNoteInput');
    if (!editingNote || !box) return;
    if (!cancel) {
        const value = box.value.trim();
        const prev = String(workingWorld.description || '').trim();
        if (value !== prev) {
            if (value) workingWorld.description = box.value;
            else delete workingWorld.description;
            markDirty();
        }
    }
    editingNote = false;
    renderEditor();
}

// The bindings strip: the book's whole reach, every kind editable in place

function bindGroupHtml(icon, label, chipsHtml, addHtml) {
    return `
        <div class="lb-bind-group">
            <span class="lb-bind-label"><i class="fa-solid ${icon}"></i>${label}</span>
            <span class="lb-bind-chips">${chipsHtml}${addHtml}</span>
        </div>`;
}

function renderBindingsStrip() {
    // One row's worth per group; the +N more chip opens the manage view for the rest.
    const BIND_CHIP_CAP = 4;
    const u = usageMap.get(currentWorld);
    const links = linkedMap.get(currentWorld) || [];
    const charChips = links.slice(0, BIND_CHIP_CAP).map(l => `
        <span class="lb-linked-chip" title="Linked to ${esc(l.name)}">
            <button class="lb-linked-chip-open" data-action="open-char" data-char-id="${esc(l.id)}" title="Open ${esc(l.name)}">
                <img src="${esc(CoreAPI.getCharacterAvatarSmallThumbUrl(l.id))}" alt="" loading="lazy">
                <span>${esc(l.name)}</span>
            </button>
            <button class="lb-linked-chip-x" data-action="unlink-char" data-char-id="${esc(l.id)}" title="Unlink this lorebook from ${esc(l.name)}">&times;</button>
        </span>`).join('');
    const charMore = links.length > BIND_CHIP_CAP ? `<button class="lb-linked-more" data-action="manage-links" data-kind="characters" title="See all ${links.length} linked characters">+${links.length - BIND_CHIP_CAP} more</button>` : '';

    const bound = chatBoundMap.get(currentWorld) || [];
    const chatChips = bound.slice(0, BIND_CHIP_CAP).map((c, i) => {
        const chatName = c.name || '';
        const label = `${c.charName || '?'}: ${chatName}`;
        return `
        <span class="lb-linked-chip" title="Bound to the chat &quot;${esc(chatName)}&quot; (${esc(c.charName || '?')})">
            <button class="lb-linked-chip-open" data-action="open-bound-chat" data-idx="${i}" title="Bound to the chat &quot;${esc(chatName)}&quot;. Open ${esc(c.charName || 'the character')}.">
                <img src="${esc(CoreAPI.getCharacterAvatarSmallThumbUrl(c.charId))}" alt="" loading="lazy">
                <span>${esc(label)}</span>
            </button>
            <button class="lb-linked-chip-x" data-action="unbind-chat" data-idx="${i}" title="Unbind this lorebook from &quot;${esc(chatName)}&quot;">&times;</button>
        </span>`;
    }).join('');
    const chatMore = bound.length > BIND_CHIP_CAP ? `<button class="lb-linked-more" data-action="manage-links" data-kind="chats" title="See all ${bound.length} bound chats">+${bound.length - BIND_CHIP_CAP} more</button>` : '';

    const personas = u?.personas || [];
    const personaChips = personas.map(p => `
        <span class="lb-linked-chip" title="Bound to persona ${esc(p.name)}">
            <span class="lb-linked-chip-open is-static"><span>${esc(p.name)}</span></span>
            <button class="lb-linked-chip-x" data-action="unlink-persona" data-persona-id="${esc(p.id)}" title="Unbind this lorebook from ${esc(p.name)}">&times;</button>
        </span>`).join('');

    const addBtn = (action, title) => `<button class="lb-bind-add" data-action="${action}" title="${title}"><i class="fa-solid fa-plus"></i></button>`;
    const globalCtl = `
        <button class="lb-bind-global${u?.global ? ' is-on' : ''}" data-action="toggle-global"
            title="${u?.global ? 'On the global list: active in every chat. Click to remove.' : 'Not global. Click to activate in every chat.'}">
            ${u?.global ? 'Active everywhere' : 'Off'}
        </button>`;

    return `
        <div class="lb-bindings">
            ${bindGroupHtml('fa-user', 'Characters', charChips + charMore, addBtn('link-chars', 'Link to characters'))}
            ${bindGroupHtml('fa-comment', 'Chats', chatChips + chatMore, addBtn('bind-chats', 'Bind to chats'))}
            ${bindGroupHtml('fa-masks-theater', 'Personas', personaChips, `<span class="lb-persona-add-wrap">${addBtn('add-persona', 'Bind to a persona')}<div class="lb-split-menu hidden" id="lbPersonaMenu"></div></span>`)}
            ${bindGroupHtml('fa-globe', 'Global', globalCtl, '')}
        </div>`;
}

// ========================================
// ENTRY ROW
// ========================================

function entryTitle(e) {
    return e.comment?.trim() || (Array.isArray(e.key) && e.key.length ? e.key.join(', ') : 'Untitled Entry');
}

function entryRowHtml(e) {
    const expanded = expandedUids.has(e.uid);
    const isConstant = !!e.constant;
    const keysPreview = isConstant
        ? 'always on'
        : (Array.isArray(e.key) && e.key.length ? e.key.join(', ') : '(no keys)');
    const badges = [];
    if (isConstant) badges.push(`<span class="lb-badge constant" title="Constant: always sent"><i class="fa-solid fa-anchor"></i></span>`);
    if (e.vectorized) badges.push(`<span class="lb-badge vector" title="Vectorized: vector-similarity match"><i class="fa-solid fa-cube"></i></span>`);
    if (!isConstant && Array.isArray(e.keysecondary) && e.keysecondary.length) badges.push(`<span class="lb-badge selective" title="Has an optional secondary-key filter"><i class="fa-solid fa-filter"></i></span>`);
    const posLabel = (POSITION_OPTIONS.find(p => p[0] === Number(e.position)) || [0, ''])[1];

    return `
        <div class="lb-entry-head" data-action="toggle-entry" data-uid="${esc(e.uid)}">
            <label class="lb-switch" title="${e.disable ? 'Disabled' : 'Enabled'}" data-stop>
                <input type="checkbox" data-field="disable" data-uid="${esc(e.uid)}" data-type="bool-inv" ${e.disable ? '' : 'checked'}>
                <span class="lb-switch-track"></span>
            </label>
            <div class="lb-entry-summary">
                <div class="lb-entry-title-line">
                    <span class="lb-entry-title">${esc(entryTitle(e))}</span>
                    <span class="lb-entry-badges">${badges.join('')}</span>
                </div>
                <div class="lb-entry-sub">
                    <span class="lb-entry-keys" title="${esc(keysPreview)}"><i class="fa-solid fa-key"></i> ${esc(keysPreview)}</span>
                    <span class="lb-entry-pos" title="Insertion position"><i class="fa-solid fa-location-dot"></i> ${esc(posLabel)}</span>
                    <span class="lb-entry-order" title="Insertion order">#${esc(e.order ?? 100)}</span>
                </div>
            </div>
            <div class="lb-entry-head-actions">
                <button class="lb-icon-btn small" data-action="duplicate-entry" data-uid="${esc(e.uid)}" title="Duplicate entry"><i class="fa-solid fa-clone"></i></button>
                <button class="lb-icon-btn small danger" data-action="delete-entry" data-uid="${esc(e.uid)}" title="Delete entry"><i class="fa-solid fa-trash"></i></button>
                <i class="fa-solid fa-chevron-down lb-entry-chevron${expanded ? ' open' : ''}"></i>
            </div>
        </div>
        ${expanded ? `<div class="lb-entry-body"><div class="lb-entry-acts" data-uid="${esc(e.uid)}">${entryActsHtml(e)}</div>${renderEntryBody(e)}</div>` : ''}`;
}

// extension verbs for the open entry (lore slot); the strip stays on every open entry, so a registration can fill it
function entryActsHtml(e) {
    if (!extHasActions('lore')) return '';
    return extActionsFor('lore', loreEntryContext(currentWorld, e)).map(a =>
        `<button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-action="ext-act" data-key="${esc(a.key)}" data-uid="${esc(e.uid)}" title="${esc(a.label)}"><i class="fa-solid ${esc(a.icon)}"></i> ${esc(a.label)}</button>`).join('');
}

// a registration changed: the open entries' strips are asked again, their fields left alone
function refreshEntryActs() {
    if (!workingWorld) return;
    document.querySelectorAll('#lbEntries .lb-entry-acts').forEach(strip => {
        const e = workingWorld.entries[Number(strip.dataset.uid)];
        if (e) strip.innerHTML = entryActsHtml(e);
    });
}

function onEntryActsChanged(e) {
    if (e.detail?.slot === 'lore') refreshEntryActs();
}

function renderEntryRow(e) {
    const expanded = expandedUids.has(e.uid);
    return `<div class="lb-entry${expanded ? ' expanded' : ''}${e.disable ? ' disabled' : ''}" id="lbEntry-${esc(e.uid)}">${entryRowHtml(e)}</div>`;
}

function refreshRow(uid) {
    const e = workingWorld.entries[uid];
    const rowEl = document.getElementById(`lbEntry-${uid}`);
    if (!e || !rowEl) return;
    const expanded = expandedUids.has(uid);
    rowEl.className = `lb-entry${expanded ? ' expanded' : ''}${e.disable ? ' disabled' : ''}`;
    rowEl.innerHTML = entryRowHtml(e);
    if (expanded) growVisibleContentFields(rowEl);
}

// Update only the collapsed-summary header bits in place (keeps text-field focus while typing).
function refreshRowHeader(uid) {
    const e = workingWorld.entries[uid];
    const rowEl = document.getElementById(`lbEntry-${uid}`);
    if (!e || !rowEl) return;
    const titleEl = rowEl.querySelector('.lb-entry-title');
    if (titleEl) titleEl.textContent = entryTitle(e);
    const keysEl = rowEl.querySelector('.lb-entry-keys');
    if (keysEl) {
        const preview = Array.isArray(e.key) && e.key.length ? e.key.join(', ') : '(no keys)';
        keysEl.innerHTML = `<i class="fa-solid fa-key"></i> ${esc(preview)}`;
        keysEl.title = preview;
    }
    const orderEl = rowEl.querySelector('.lb-entry-order');
    if (orderEl) orderEl.textContent = `#${e.order ?? 100}`;
}

function autoGrowLb(ta) {
    CoreAPI.fitTextarea(ta);
}

// batched (reset, read, write all) so expanding many doesnt thrash layout; the one grow outside fitTextarea
function growVisibleContentFields(scope) {
    const tas = (scope || document.getElementById('lbEntries'))?.querySelectorAll('textarea.lb-textarea');
    if (!tas || !tas.length) return;
    tas.forEach(ta => { ta.style.height = 'auto'; });
    const heights = Array.from(tas, ta => ta.scrollHeight);
    tas.forEach((ta, i) => { ta.style.height = `${heights[i]}px`; });
}

// ========================================
// ENTRY EDITOR BODY (fields)
// ========================================

function fieldId(uid, field) { return `lbf-${uid}-${field}`; }

function textInput(uid, field, value, { placeholder = '', type = 'string' } = {}) {
    return `<input class="cl-input" id="${fieldId(uid, field)}" data-field="${field}" data-uid="${esc(uid)}" data-type="${type}" value="${esc(value ?? '')}" placeholder="${esc(placeholder)}" autocomplete="off">`;
}

function numberInput(uid, field, value, { placeholder = '', min, max, step } = {}) {
    const type = NULLABLE_NUMBERS.has(field) ? 'number-null' : 'number';
    const attrs = [
        min !== undefined ? `min="${min}"` : '',
        max !== undefined ? `max="${max}"` : '',
        step !== undefined ? `step="${step}"` : '',
    ].join(' ');
    const v = value === null || value === undefined ? '' : value;
    return `<input class="cl-input lb-input-num" type="number" id="${fieldId(uid, field)}" data-field="${field}" data-uid="${esc(uid)}" data-type="${type}" value="${esc(v)}" placeholder="${esc(placeholder)}" ${attrs} autocomplete="off">`;
}

function toggle(uid, field, value, label, { inverted = false } = {}) {
    const checked = inverted ? !value : !!value;
    return `
        <label class="lb-check">
            <input type="checkbox" data-field="${field}" data-uid="${esc(uid)}" data-type="${inverted ? 'bool-inv' : 'bool'}" ${checked ? 'checked' : ''}>
            <span class="lb-check-box"></span>
            <span class="lb-check-label">${esc(label)}</span>
        </label>`;
}

function selectInput(uid, field, value, options, { type = 'int' } = {}) {
    const opts = options.map(([v, label]) =>
        `<option value="${esc(v)}"${String(v) === String(value ?? '') ? ' selected' : ''}>${esc(label)}</option>`).join('');
    return `<select class="cl-input lb-select" data-field="${field}" data-uid="${esc(uid)}" data-type="${type}">${opts}</select>`;
}

function pillField(uid, field, values, placeholder = 'Type a keyword, Enter to add') {
    const arr = Array.isArray(values) ? values : [];
    const pills = arr.map((k, i) => `
        <span class="lb-pill">${esc(k)}<button class="lb-pill-x" data-action="remove-key" data-uid="${esc(uid)}" data-field="${field}" data-index="${i}" title="Remove">&times;</button></span>`).join('');
    return `
        <div class="lb-pill-field" data-pillfield="${field}" data-uid="${esc(uid)}">
            ${pills}
            <input type="search" class="lb-pill-input" data-action="add-key" data-uid="${esc(uid)}" data-field="${field}" placeholder="${arr.length ? '' : esc(placeholder)}" autocomplete="one-time-code">
        </div>`;
}

function fieldGroup(label, control, hint = '') {
    return `<div class="lb-field"><label class="lb-field-label">${esc(label)}</label>${control}${hint ? `<span class="lb-field-hint">${esc(hint)}</span>` : ''}</div>`;
}

function entryState(e) {
    // ST treats constant/normal/vectorized as one mutually-exclusive state, not 3 toggles.
    return e.constant ? 'constant' : e.vectorized ? 'vectorized' : 'normal';
}

function renderEntryBody(e) {
    const uid = e.uid;
    const advOpen = advancedUids.has(uid);
    const atDepth = Number(e.position) === 4;
    const isOutlet = Number(e.position) === 7;
    const state = entryState(e);
    const keyDriven = state !== 'constant'; // constant always fires, keywords are irrelevant

    const stateSeg = `
        <div class="lb-state-seg" role="group" aria-label="Entry status">
            <button class="lb-state-opt${state === 'normal' ? ' active' : ''}" data-action="set-state" data-uid="${esc(uid)}" data-state="normal" title="Activates when a keyword is found in chat">
                <i class="fa-solid fa-circle"></i> Normal
            </button>
            <button class="lb-state-opt${state === 'constant' ? ' active' : ''}" data-action="set-state" data-uid="${esc(uid)}" data-state="constant" title="Always inserted into the prompt">
                <i class="fa-solid fa-anchor"></i> Constant
            </button>
            <button class="lb-state-opt${state === 'vectorized' ? ' active' : ''}" data-action="set-state" data-uid="${esc(uid)}" data-state="vectorized" title="Activates when the message matches by vector similarity">
                <i class="fa-solid fa-cube"></i> Vectorized
            </button>
        </div>`;

    const main = `
        <div class="lb-body-section">
            <div class="lb-field-grid two">
                ${fieldGroup('Title / Memo', textInput(uid, 'comment', e.comment, { placeholder: 'A label for this entry' }))}
                ${fieldGroup('Status', stateSeg, state === 'constant'
                    ? 'Always sent to the AI, regardless of keywords.'
                    : state === 'vectorized'
                        ? 'Activated by vector similarity. Keywords below are the vector source.'
                        : 'Activated when a primary keyword appears in chat.')}
            </div>
            ${fieldGroup('Content', `<textarea class="cl-input lb-textarea" data-field="content" data-uid="${esc(uid)}" data-type="string" rows="5" placeholder="The lore text injected when this entry triggers...">\n${esc(e.content)}</textarea>`)}
        </div>`;

    const keywordRow = keyDriven ? `
            <div class="lb-keys-row">
                <div class="lb-keys-primary">
                    ${fieldGroup(state === 'vectorized' ? 'Keywords (vector source)' : 'Primary Keywords', pillField(uid, 'key', e.key))}
                </div>
                <div class="lb-keys-logic">
                    ${fieldGroup('Logic', selectInput(uid, 'selectiveLogic', e.selectiveLogic, LOGIC_OPTIONS))}
                </div>
                <div class="lb-keys-secondary">
                    ${fieldGroup('Optional Filter', pillField(uid, 'keysecondary', e.keysecondary), 'Refines the match; ignored when empty')}
                </div>
            </div>` : '';

    const logic = `
        <div class="lb-body-section">
            <div class="lb-section-title">Activation</div>
            ${keywordRow}
            <div class="lb-field-grid ${atDepth ? 'three' : 'two'}">
                ${fieldGroup('Position', selectInput(uid, 'position', e.position, POSITION_OPTIONS))}
                ${atDepth ? fieldGroup('Depth', numberInput(uid, 'depth', e.depth, { placeholder: '4', min: 0 })) : ''}
                ${atDepth ? fieldGroup('Role', selectInput(uid, 'role', e.role, ROLE_OPTIONS)) : ''}
                ${isOutlet ? fieldGroup('Outlet Name', textInput(uid, 'outletName', e.outletName, { placeholder: 'macro name' })) : ''}
            </div>
            <div class="lb-field-grid three">
                ${fieldGroup('Insertion Order', numberInput(uid, 'order', e.order, { placeholder: String(ENTRY_NUMBER_BLANKS.order) }), 'Lower inserts higher')}
                ${fieldGroup('Trigger %', numberInput(uid, 'probability', e.probability, { placeholder: '100', min: 0, max: 100 }))}
                <div class="lb-field lb-field-inline"><label class="lb-field-label lb-field-label-spacer" aria-hidden="true">&nbsp;</label>${toggle(uid, 'useProbability', e.useProbability, 'Use trigger %')}</div>
            </div>
        </div>`;

    const advanced = `
        <div class="lb-advanced">
            <button class="lb-advanced-toggle" data-action="toggle-advanced" data-uid="${esc(uid)}">
                <i class="fa-solid fa-chevron-${advOpen ? 'down' : 'right'}"></i> Advanced
            </button>
            ${advOpen ? `
            <div class="lb-advanced-body">
                <div class="lb-section-title">Recursion</div>
                <div class="lb-toggle-row">
                    ${toggle(uid, 'excludeRecursion', e.excludeRecursion, 'Non-recursable (won\'t be activated by others)')}
                    ${toggle(uid, 'preventRecursion', e.preventRecursion, 'Prevent further recursion')}
                </div>
                <div class="lb-field-grid two">
                    ${fieldGroup('Delay until recursion', numberInput(uid, 'delayUntilRecursion', e.delayUntilRecursion, { placeholder: '0', min: 0 }))}
                    <div></div>
                </div>

                <div class="lb-section-title">Inclusion Group</div>
                <div class="lb-field-grid three">
                    ${fieldGroup('Group label(s)', textInput(uid, 'group', e.group, { placeholder: 'comma,separated' }))}
                    ${fieldGroup('Group weight', numberInput(uid, 'groupWeight', e.groupWeight, { placeholder: '100', min: 0 }))}
                    ${fieldGroup('Use group scoring', selectInput(uid, 'useGroupScoring', tristateValue(e.useGroupScoring), TRISTATE_OPTIONS, { type: 'tristate' }))}
                </div>
                <div class="lb-toggle-row">
                    ${toggle(uid, 'groupOverride', e.groupOverride, 'Prioritize (group override)')}
                </div>

                <div class="lb-section-title">Scan Overrides <span class="lb-section-sub">(blank = use global)</span></div>
                <div class="lb-field-grid three">
                    ${fieldGroup('Scan depth', numberInput(uid, 'scanDepth', e.scanDepth, { placeholder: 'global', min: 0 }))}
                    ${fieldGroup('Case-sensitive', selectInput(uid, 'caseSensitive', tristateValue(e.caseSensitive), TRISTATE_OPTIONS, { type: 'tristate' }))}
                    ${fieldGroup('Match whole words', selectInput(uid, 'matchWholeWords', tristateValue(e.matchWholeWords), TRISTATE_OPTIONS, { type: 'tristate' }))}
                </div>

                <div class="lb-section-title">Timed Effects <span class="lb-section-sub">(blank = off)</span></div>
                <div class="lb-field-grid three">
                    ${fieldGroup('Sticky', numberInput(uid, 'sticky', e.sticky, { placeholder: 'off', min: 0 }))}
                    ${fieldGroup('Cooldown', numberInput(uid, 'cooldown', e.cooldown, { placeholder: 'off', min: 0 }))}
                    ${fieldGroup('Delay', numberInput(uid, 'delay', e.delay, { placeholder: 'off', min: 0 }))}
                </div>

                <div class="lb-section-title">Generation Types <span class="lb-section-sub">(none = every kind)</span></div>
                <div class="lb-toggle-grid">
                    ${TRIGGER_TYPES.map(([t, label]) => `
                    <label class="lb-check">
                        <input type="checkbox" data-action="toggle-trigger" data-uid="${esc(uid)}" data-trigger="${t}"${Array.isArray(e.triggers) && e.triggers.includes(t) ? ' checked' : ''}>
                        <span class="lb-check-box"></span>
                        <span class="lb-check-label">${label}</span>
                    </label>`).join('')}
                </div>

                <div class="lb-section-title">Character Filter <span class="lb-section-sub">(blank = everyone)</span></div>
                <div class="lb-field-grid two">
                    ${fieldGroup('Characters', pillField(uid, 'characterFilter.names', e.characterFilter?.names, 'Type a name, Enter to add'))}
                    ${fieldGroup('Tags', pillField(uid, 'characterFilter.tags', e.characterFilter?.tags, 'Type a tag, Enter to add'))}
                </div>
                <div class="lb-toggle-row">
                    ${toggle(uid, 'characterFilter.isExclude', e.characterFilter?.isExclude, 'Exclude these instead (never fires for them)')}
                </div>

                <div class="lb-section-title">Additional Matching Sources</div>
                <div class="lb-toggle-grid">
                    ${MATCH_SOURCES.map(([f, label]) => toggle(uid, f, e[f], label)).join('')}
                </div>

                <div class="lb-section-title">Misc</div>
                <div class="lb-toggle-row">
                    ${toggle(uid, 'ignoreBudget', e.ignoreBudget, 'Ignore token budget')}
                </div>
                <div class="lb-field-grid two">
                    ${fieldGroup('Automation ID', textInput(uid, 'automationId', e.automationId, { placeholder: 'optional' }))}
                    <div></div>
                </div>
            </div>` : ''}
        </div>`;

    return main + logic + advanced;
}

function tristateValue(v) {
    if (v === null || v === undefined) return '';
    return v ? 'true' : 'false';
}

// ========================================
// MUTATIONS
// ========================================

function markDirty() {
    // Once dirty, stay dirty until save resets the snapshot. Skips a full
    // JSON.stringify of the working copy on every keystroke for large books.
    if (dirty) return;
    dirty = JSON.stringify(workingWorld) !== originalSnapshot;
    if (dirty) updateSaveButton();
}

function updateSaveButton() {
    const btn = document.getElementById('lbSaveBtn');
    if (!btn) return;
    btn.disabled = !dirty;
    btn.classList.toggle('dirty', dirty);
    const label = btn.querySelector('span');
    if (label) label.textContent = dirty ? 'Save *' : 'Saved';
}

function nextUid() {
    const uids = Object.keys(workingWorld.entries).map(Number).filter(n => !isNaN(n));
    return uids.length ? Math.max(...uids) + 1 : 0;
}

// characterFilter is the one NESTED entry field: resolve 'characterFilter.names' etc, creating it on write
function entryFieldRef(entry, field) {
    if (!field.startsWith('characterFilter.')) return { obj: entry, key: field };
    if (!entry.characterFilter || typeof entry.characterFilter !== 'object') {
        entry.characterFilter = { isExclude: false, names: [], tags: [] };
    }
    return { obj: entry.characterFilter, key: field.split('.')[1] };
}

function normalizeCharacterFilter(entry) {
    const cf = entry?.characterFilter;
    if (cf && !cf.names?.length && !cf.tags?.length && !cf.isExclude) delete entry.characterFilter;
}

function coerceStore(uid, field, type, rawValue) {
    const e = workingWorld.entries[uid];
    if (!e) return;
    let value;
    switch (type) {
        case 'bool': value = !!rawValue; break;
        case 'bool-inv': value = !rawValue; break;
        case 'number': value = rawValue === '' ? (ENTRY_NUMBER_BLANKS[field] ?? 0) : Number(rawValue); break;
        case 'number-null': value = rawValue === '' ? null : Number(rawValue); break;
        case 'int': value = Number(rawValue); break;
        case 'tristate': value = rawValue === '' ? null : rawValue === 'true'; break;
        default: value = rawValue;
    }
    const ref = entryFieldRef(e, field);
    ref.obj[ref.key] = value;
    if (field.startsWith('characterFilter.')) normalizeCharacterFilter(e);
    if (field === 'comment') e.addMemo = !!String(value).trim();
}

function addEntry() {
    const uid = nextUid();
    workingWorld.entries[uid] = newEntry(uid, uid);
    expandedUids.add(uid);
    markDirty();
    renderEditor();
    requestAnimationFrame(() => {
        document.getElementById(`lbEntry-${uid}`)?.scrollIntoView({ behavior: CoreAPI.scrollBehavior(), block: 'center' });
    });
}

function duplicateEntry(uid) {
    const src = workingWorld.entries[uid];
    if (!src) return;
    const newId = nextUid();
    const clone = JSON.parse(JSON.stringify(src));
    clone.uid = newId;
    clone.displayIndex = newId;
    clone.comment = (clone.comment || 'Untitled') + ' (copy)';
    workingWorld.entries[newId] = clone;
    expandedUids.add(newId);
    markDirty();
    renderEditor();
}

async function deleteEntry(uid) {
    const e = workingWorld.entries[uid];
    if (!e) return;
    const ok = await CoreAPI.showConfirm({
        title: 'Delete entry?',
        message: `Delete "${entryTitle(e)}" from this lorebook?`,
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
        danger: true,
    });
    if (!ok) return;
    delete workingWorld.entries[uid];
    expandedUids.delete(uid);
    advancedUids.delete(uid);
    markDirty();
    renderEditor();
}

// key-order-insensitive: the server recomposes {...meta, entries}, which a plain stringify reads as changed on disk
function stableStringify(value) {
    if (typeof value === 'object' && value !== null) {
        if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
        let body = '';
        for (const key of Object.keys(value).sort()) body += `${body ? ',' : ''}${JSON.stringify(key)}:${stableStringify(value[key])}`;
        return `{${body}}`;
    }
    const text = JSON.stringify(value);
    return text === undefined ? 'null' : text;
}

async function confirmDiskDivergence(name) {
    let disk;
    try {
        disk = await CoreAPI.getWorldInfoData(name, { throwUnread: true });
    } catch {
        // unknown is not absent: what another tab wrote cannot be checked, so the save asks
        return CoreAPI.showConfirm({
            title: 'Lorebook could not be read',
            message: `"${name}" could not be read from the server, so changes made outside this editor cannot be checked. Saving will write this editor's copy over whatever is there.`,
            confirmLabel: 'Save Anyway',
            cancelLabel: 'Cancel',
            danger: true,
        });
    }
    if (!disk) return true;
    const diskStr = stableStringify(disk);
    if (diskStr === diskSnapshot) return true;
    if (diskStr === '{"entries":{}}') {
        // fresh list, not the cached worldsList: that still holds the deleted book; an unread list is unknown, so it asks
        const files = await CoreAPI.listWorldInfoFiles({ placeholders: 'all' }).catch(() => null);
        if (files && !files.some(w => String(w.file_id || '').toLowerCase() === name.toLowerCase())) return true;
    }
    return CoreAPI.showConfirm({
        title: 'Lorebook changed on disk',
        message: `"${name}" was modified outside this editor since you opened it (another tab, or a card update). Saving will overwrite those changes with this editor's copy.`,
        confirmLabel: 'Overwrite',
        cancelLabel: 'Cancel',
        danger: true,
    });
}

// ONE serialized body is what counts as saved, so an edit typed during the PUT stays dirty; null on failure
async function putWorkingCopy(name) {
    const working = workingWorld;
    const sent = JSON.stringify(working);
    const body = JSON.parse(sent);
    if (!(await CoreAPI.saveWorldInfoData(name, body, 'lorebook-manager'))) return null;
    // a book closed or switched while the write was out keeps its own snapshots
    if (workingWorld === working) {
        originalSnapshot = sent;
        diskSnapshot = stableStringify(body);
        dirty = JSON.stringify(working) !== sent;
    }
    return body;
}

async function saveWorld() {
    if (!dirty || !currentWorld) return;
    // secondary keys only fire while selective is set, in our matcher and in STs, so keep it on
    for (const e of Object.values(workingWorld.entries || {})) {
        if (e && Array.isArray(e.keysecondary) && e.keysecondary.length && !e.selective) {
            e.selective = true;
        }
    }
    const btn = document.getElementById('lbSaveBtn');
    if (btn) { btn.disabled = true; btn.classList.add('saving'); }
    if (!(await confirmDiskDivergence(currentWorld))) {
        if (btn) { btn.disabled = false; btn.classList.remove('saving'); }
        return;
    }
    const world = currentWorld;
    const sent = await putWorkingCopy(world);
    if (btn) btn.classList.remove('saving');
    if (sent) {
        entryCountCache.set(world, Object.keys(sent.entries || {}).length);
        updateSaveButton();
        renderWorldList();
        CoreAPI.showToast('Lorebook saved.', 'success');
    } else {
        if (btn) btn.disabled = false;
        CoreAPI.showToast('Failed to save lorebook', 'error');
    }
}

// ========================================
// WORLD-LEVEL OPS
// ========================================

function startCreate() {
    creatingNew = true;
    renderWorldList();
}

async function commitCreate(name) {
    creatingNew = false;
    // Use the name the server will store, so our state and the server agree.
    const fileId = sanitizeWorldName(name);
    if (!fileId) {
        if ((name || '').trim()) CoreAPI.showToast('That name has no usable filename characters', 'warning');
        renderWorldList();
        return;
    }
    if ((await takenWorldIds()).has(fileId.toLowerCase())) {
        CoreAPI.showToast('A lorebook with that name already exists', 'warning');
        renderWorldList();
        return;
    }
    const made = await CoreAPI.createWorldInfoData(fileId, { entries: {} });
    if (made === 'exists') { CoreAPI.showToast('A lorebook with that name already exists', 'warning'); renderWorldList(); return; }
    if (made !== 'created') { CoreAPI.showToast('Failed to create lorebook', 'error'); renderWorldList(); return; }
    await refreshList();
    await selectWorld(fileId);
    CoreAPI.showToast(`Created "${fileId}"`, 'success');
}

function startRename() {
    const titleEl = document.getElementById('lbWorldTitle');
    if (!titleEl || titleEl.querySelector('input')) return;
    const current = currentWorld;
    titleEl.innerHTML = `<input type="search" class="lb-rename-input" id="lbRenameInput" value="${esc(current)}" autocomplete="one-time-code">`;
    const input = document.getElementById('lbRenameInput');
    input?.focus();
    input?.select();
    // Enter and blur both commit; the guard stops the post-Enter blur from double-firing.
    let done = false;
    const commit = async () => {
        if (done) return;
        done = true;
        const newName = sanitizeWorldName(input.value);
        if (!newName || newName === current) { renderEditor(); return; }
        if (worldsList.some(w => w.file_id.toLowerCase() === newName.toLowerCase())) {
            CoreAPI.showToast('A lorebook with that name already exists', 'warning');
            renderEditor();
            return;
        }
        await doRename(current, newName);
    };
    input?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); done = true; renderEditor(); }
    });
    input?.addEventListener('blur', commit, { once: true });
}

async function doRename(oldName, newName) {
    // Persist any pending edits into the new file as part of the rename copy.
    if (dirty) {
        if (!(await confirmDiskDivergence(oldName))) { renderEditor(); return; }
        await putWorkingCopy(oldName);
    }
    // one server transaction moves the row, entries and every binding; a taken name is refused there
    const renamed = await CoreAPI.renameWorldInfo(oldName, newName, 'lorebook-manager');
    if (!renamed) { CoreAPI.showToast('Rename failed (is the name already taken?)', 'error'); renderEditor(); return; }
    currentWorld = newName;
    const swept = renamed.touched;
    const sweptNote = swept > 0 ? ` Re-pointed ${swept} binding${swept === 1 ? '' : 's'}.` : '';

    await refreshList({ keepSelection: true });
    renderEditor();
    CoreAPI.showToast(`Renamed to "${newName}".${sweptNote}`, 'success', sweptNote ? 5000 : 3000);
}

async function duplicateWorld() {
    if (!currentWorld) return;
    // a no-op safety net: currentWorld is already sanitized and " (copy)" adds nothing illegal
    let name = sanitizeWorldName(`${currentWorld} (copy)`);
    let n = 2;
    const taken = await takenWorldIds();
    const nextName = () => { name = sanitizeWorldName(`${currentWorld} (copy ${n++})`); };
    while (taken.has(name.toLowerCase())) nextName();
    const data = await CoreAPI.getWorldInfoData(currentWorld);
    if (!data) { CoreAPI.showToast('Could not read source lorebook', 'error'); return; }
    // the server refuses a taken name; the next copy name is tried, a few times at most
    let made = await CoreAPI.createWorldInfoData(name, data);
    for (let tries = 0; made === 'exists' && tries < 20; tries++) { nextName(); made = await CoreAPI.createWorldInfoData(name, data); }
    if (made !== 'created') { CoreAPI.showToast('Duplicate failed', 'error'); return; }
    await refreshList();
    await selectWorld(name);
    CoreAPI.showToast(`Duplicated as "${name}"`, 'success');
}

function exportWorld() {
    if (!workingWorld || !currentWorld) return;
    const blob = new Blob([JSON.stringify(workingWorld, null, 4)], { type: 'application/json' });
    CoreAPI.downloadBlobAsFile(blob, `${currentWorld}.json`);
}

async function deleteWorld() {
    if (!currentWorld) return;
    const deletedName = currentWorld;
    const reach = reachOf(currentWorld).total;

    const ok = await CoreAPI.showConfirm({
        title: 'Delete lorebook?',
        message: reach > 0
            ? `"${deletedName}" has ${reach} binding${reach === 1 ? '' : 's'} (characters, chats, global or personas); deleting it removes them too. Permanently delete it? This cannot be undone.`
            : `Permanently delete "${deletedName}"? This cannot be undone.`,
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
        danger: true,
    });
    if (!ok) return;

    const done = await CoreAPI.deleteWorldInfo(deletedName);
    if (!done) { CoreAPI.showToast('Delete failed', 'error'); return; }

    // The delete cascaded every binding (char, chat, global, persona) server-side; the
    // answer says how many.
    const swept = done.unbound || 0;
    const sweptNote = swept > 0 ? ` Removed ${swept} binding${swept === 1 ? '' : 's'}.` : '';

    entryCountCache.delete(deletedName);
    currentWorld = null;
    workingWorld = null;
    dirty = false;
    await refreshList();
    renderEmptyContent();
    CoreAPI.showToast(`Deleted "${deletedName}".${sweptNote}`, 'success', sweptNote ? 5000 : 3000);
}

/**
 * Unlink the current world from one character: remove it from that character's
 * linked-lorebook list. The world file is untouched.
 */
async function unlinkCharFromCurrentWorld(charId) {
    if (!currentWorld || !charId) return;
    const entry = (linkedMap.get(currentWorld) || []).find(l => l.id === charId);
    const charName = entry?.name || charId;
    const ok = await CoreAPI.showConfirm({
        title: 'Unlink character?',
        message: `Unlink "${currentWorld}" from ${charName}? The lorebook is kept; only this character's link is removed.`,
        confirmLabel: 'Unlink',
        cancelLabel: 'Cancel',
        danger: true,
    });
    if (!ok) return;
    const success = await CoreAPI.applyCharWorlds(charId, { remove: [currentWorld] });
    if (!success) { CoreAPI.showToast('Failed to unlink', 'error'); return; }
    await refreshUsage();
    renderEditor();
    renderWorldList();
    CoreAPI.showToast(`Unlinked from ${charName}.`, 'success', 5000);
}

/**
 * Unbind the current world from one chat (removes it from that chat's own list).
 * @param {{id, charId, charName, char, name}} c - a bound-chat entry from chatBoundMap
 */
async function unbindChatFromCurrentWorld(c) {
    if (!currentWorld || !c?.id) return;
    const chatName = c.name || '';
    const ok = await CoreAPI.showConfirm({
        title: 'Unbind chat?',
        message: `Unbind "${currentWorld}" from ${c.charName}'s chat "${chatName}"? The lorebook is kept; only this chat's binding is removed.`,
        confirmLabel: 'Unbind',
        cancelLabel: 'Cancel',
        danger: true,
    });
    if (!ok) return;
    const success = await CoreAPI.applyChatWorlds(c.id, { remove: [currentWorld], source: 'lorebook-manager' });
    if (!success) { CoreAPI.showToast('Failed to unbind the lorebook from this chat', 'error'); return; }
    await refreshUsage();
    renderEditor();
    renderWorldList();
    CoreAPI.showToast(`Unbound from "${chatName}".`, 'success', 5000);
}

// the standing scopes; persona binds may be created here since it is picked by NAME (the chat panel refuses)
async function toggleGlobalBinding() {
    if (!currentWorld) return;
    const on = !!usageMap.get(currentWorld)?.global;
    const ok = await CoreAPI.applyGlobalWorlds(on ? { remove: [currentWorld] } : { add: [currentWorld] });
    if (!ok) { CoreAPI.showToast('Failed to change the global binding', 'error'); return; }
    await refreshUsage();
    renderEditor();
    renderWorldList();
    CoreAPI.showToast(on ? `"${currentWorld}" is no longer global.` : `"${currentWorld}" is now active in every chat.`, 'success');
}

async function openPersonaMenu() {
    if (!currentWorld) return;
    const menu = document.getElementById('lbPersonaMenu');
    if (!menu) return;
    if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return; }
    menu.innerHTML = '<div class="lb-persona-menu-note">Loading...</div>';
    menu.classList.remove('hidden');
    try {
        const resp = await CoreAPI.apiRequest('/personas', 'GET');
        const personas = resp.ok ? (await resp.json())?.personas : null;
        if (!Array.isArray(personas)) throw new Error('list failed');
        const bound = new Set((usageMap.get(currentWorld)?.personas || []).map(p => p.id));
        const free = personas.filter(p => !bound.has(p.id));
        menu.innerHTML = free.length
            ? free.map(p => `<button class="dropdown-item" data-action="persona-pick" data-persona-id="${esc(p.id)}"><i class="fa-solid fa-masks-theater"></i> ${esc(p.name)}</button>`).join('')
            : `<div class="lb-persona-menu-note">${personas.length ? 'Every persona already carries this book.' : 'No personas yet. Create one from a chat\'s Personas panel.'}</div>`;
    } catch {
        menu.innerHTML = '<div class="lb-persona-menu-note">Could not load personas.</div>';
    }
}

async function bindPersona(personaId) {
    if (!currentWorld || !personaId) return;
    document.getElementById('lbPersonaMenu')?.classList.add('hidden');
    const ok = await CoreAPI.applyPersonaWorlds(personaId, { add: [currentWorld] });
    if (!ok) { CoreAPI.showToast('Failed to bind the persona', 'error'); return; }
    await refreshUsage();
    renderEditor();
    renderWorldList();
    CoreAPI.showToast('Persona bound.', 'success');
}

async function unbindPersona(personaId) {
    if (!currentWorld || !personaId) return;
    const name = (usageMap.get(currentWorld)?.personas || []).find(p => p.id === personaId)?.name || 'this persona';
    const ok = await CoreAPI.showConfirm({
        title: 'Unbind persona?',
        message: `Unbind "${currentWorld}" from ${name}? The lorebook is kept; only the persona binding is removed.`,
        confirmLabel: 'Unbind',
        cancelLabel: 'Cancel',
        danger: true,
    });
    if (!ok) return;
    const success = await CoreAPI.applyPersonaWorlds(personaId, { remove: [currentWorld] });
    if (!success) { CoreAPI.showToast('Failed to unbind', 'error'); return; }
    await refreshUsage();
    renderEditor();
    renderWorldList();
    CoreAPI.showToast(`Unbound from ${name}.`, 'success');
}

// ========================================
// IMPORT
// ========================================

async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let imported = 0;
    // one fresh fetch per batch; names created below join the set so the loop stays honest
    const taken = await takenWorldIds();
    for (const file of files) {
        try {
            const text = await file.text();
            const json = JSON.parse(text);
            const baseName = file.name.replace(/\.json$/i, '').trim();

            let native;
            let name = baseName;
            if (json && json.entries && !Array.isArray(json.entries) && typeof json.entries === 'object') {
                // Native ST world file (entries object)
                native = json;
                name = json.name || baseName;
            } else if (json && Array.isArray(json.entries)) {
                // Embedded character_book (entries array)
                native = convertCharacterBookToNative(json);
                name = json.name || baseName;
            } else if (json?.data?.character_book?.entries) {
                // Full V2/V3 card JSON: pull the embedded book
                native = convertCharacterBookToNative(json.data.character_book);
                name = json.data.character_book.name || json.data?.name || baseName;
            } else {
                CoreAPI.showToast(`"${file.name}" is not a recognized lorebook`, 'warning');
                continue;
            }

            // Use the name the server will store; fall back if it sanitizes to empty.
            const baseId = sanitizeWorldName(name) || sanitizeWorldName(baseName) || 'Imported Lorebook';
            // Avoid clobbering an existing world silently (compare sanitized ids).
            let finalName = baseId;
            let n = 2;
            while (taken.has(finalName.toLowerCase())) {
                finalName = sanitizeWorldName(`${baseId} (${n++})`);
            }
            // the server refuses a taken name the read missed; the next numbered name is tried
            let made = await CoreAPI.createWorldInfoData(finalName, native);
            for (let tries = 0; made === 'exists' && tries < 20; tries++) {
                finalName = sanitizeWorldName(`${baseId} (${n++})`);
                made = await CoreAPI.createWorldInfoData(finalName, native);
            }
            if (made === 'created') {
                taken.add(finalName.toLowerCase());
                imported++;
                worldsList.push({ file_id: finalName, name: finalName, extensions: {} });
            }
        } catch (err) {
            console.error('[Lorebooks] Import failed for', file.name, err);
            CoreAPI.showToast(`Failed to import "${file.name}"`, 'error');
        }
    }
    if (imported > 0) {
        await refreshList();
        CoreAPI.showToast(`Imported ${imported} lorebook${imported === 1 ? '' : 's'}`, 'success');
    }
}

/**
 * Promote a character's embedded book into a linked world and say so; preferredName is used VERBATIM.
 * @param {string} charId
 * @param {string} [preferredName] the world name the server reports it will look for
 * @returns {Promise<{world: string, entries: number, linkedExisting: boolean}|null>} null when backed out or nothing to promote
 */
export async function promoteEmbeddedLorebook(charId, preferredName = '') {
    if (!charId) return null;
    // The grid row is slim: character_book is a HEAVY field and is not on it.
    const slim = CoreAPI.getCharacterById(charId);
    const char = await CoreAPI.hydrateCharacter(slim ? { ...slim } : { id: charId, _slim: true });
    const book = char?.data?.character_book;
    const list = Array.isArray(book?.entries) ? book.entries : [];
    if (!list.length) {
        CoreAPI.showToast('This character has no embedded lorebook to import', 'warning');
        return null;
    }

    // the shelf funnel: a taken name offers the existing book first, a copy is the deliberate answer
    const wanted = String(preferredName || '').trim()
        || String(book.name || '').trim()
        || `${char.name || 'Character'}'s Lorebook`;
    const placed = await importBookToShelf({ name: wanted, book, existingLabel: 'Link the existing one', eventSource: 'promote-embedded', ownerCharId: charId });
    if (!placed) return null;
    const world = placed.world;
    const linkedExisting = placed.usedExisting;

    // server-side idempotent append, no list read (a failed read can never overwrite the other links)
    const linked = await CoreAPI.applyCharWorlds(charId, { add: [world] });
    if (!linked) {
        CoreAPI.showToast(`Created "${world}" but could not link it to the character`, 'error');
        return null;
    }

    if (worldsList.length && !worldsList.some(w => w.file_id === world)) {
        worldsList.push({ file_id: world, name: world, extensions: {} });
    }
    document.dispatchEvent(new CustomEvent('cl-embedded-lore-resolved', { detail: { charId } }));
    CoreAPI.showToast(linkedExisting
        ? `Linked "${world}" to this character`
        : `Imported ${list.length} entr${list.length === 1 ? 'y' : 'ies'} into "${world}"`, 'success');
    return { world, entries: list.length, linkedExisting };
}

// ========================================
// LINK PICKER (characters: primary link, chats: chat-bound lore)
// ========================================

async function openLinkPicker(initialMode = 'characters', { manage = false } = {}) {
    if (!currentWorld) return;
    linkBook = currentWorld;
    linkMode = initialMode === 'chats' ? 'chats' : 'characters';
    linkManageMode = manage;
    linkSelection = new Set();
    linkSearch = '';
    linkHideLinked = false;
    linkCarriedSet = new Set((linkedMap.get(linkBook) || []).map(a => a.id));
    linkPlaylistUid = '';
    linkAllChats = [];
    linkChatsError = false;
    linkChatsTotal = 0;
    linkSeenChats = new Map();
    linkFiltered = [];
    linkRowStride = 0;     // remeasure (desktop vs mobile row height)
    // Manage-chats lists the book's bound chats (unlink view); the bind view lists every chat.
    manageChatList = manage && linkMode === 'chats' ? (chatBoundMap.get(linkBook) || []).slice() : [];
    const nameEl = document.getElementById('lbLinkBookName');
    if (nameEl) nameEl.textContent = currentWorld;
    const verbEl = document.getElementById('lbLinkVerb');
    if (verbEl) verbEl.textContent = manage ? 'Manage links for' : 'Link';
    const searchEl = document.getElementById('lbLinkSearch');
    if (searchEl) searchEl.value = '';
    const hideEl = document.getElementById('lbLinkHideLinked');
    if (hideEl) hideEl.checked = false;
    populateLinkPlaylistFilter();
    document.getElementById('lbLinkHead')?.classList.remove('lb-toolbar-hidden', 'lb-pinned'); // start expanded + unpinned; a prior session may have left either
    syncLinkModeUI();
    setLinkApplyButton();
    renderLinkList();
    updateLinkFooter();
    if (linkMode === 'chats' && !manage) void loadAllChatsForPicker();
    document.getElementById('lbLinkModal')?.classList.add('visible');
    if (!matchMedia('(pointer: coarse)').matches && !manage) searchEl?.focus();
}

// chats are rows: the server searches (chat or character name) and windows them, recency-sorted
async function loadAllChatsForPicker() {
    const book = linkBook;
    const seq = ++linkChatSeq;
    linkChatsLoading = true;
    renderLinkList();
    try {
        const params = new URLSearchParams({ sort: 'recent', limit: String(LINK_CHAT_RENDER_CAP) });
        const q = linkSearch.trim();
        if (q) params.set('q', q);
        const resp = await CoreAPI.apiRequest(`/chats?${params}`, 'GET');
        const data = resp.ok ? await resp.json() : null;
        if (linkBook !== book || linkMode !== 'chats' || seq !== linkChatSeq) return; // repointed or superseded mid-fetch
        linkChatsError = !Array.isArray(data?.items);
        linkAllChats = linkChatsError ? [] : data.items;
        linkChatsTotal = typeof data?.total === 'number' ? data.total : linkAllChats.length;
        for (const ch of linkAllChats) linkSeenChats.set(ch.id, ch);
    } catch {
        if (linkBook !== book || linkMode !== 'chats' || seq !== linkChatSeq) return;
        linkChatsError = true;
        linkAllChats = [];
        linkChatsTotal = 0;
    }
    linkChatsLoading = false;
    renderLinkList();
    updateLinkFooter();
}

// The apply button reads as Link or Unlink Selected (danger).
function setLinkApplyButton() {
    const btn = document.getElementById('lbLinkApplyBtn');
    if (!btn) return;
    btn.classList.toggle('cl-btn-danger', linkManageMode);
    btn.classList.toggle('cl-btn-primary', !linkManageMode);
    btn.innerHTML = linkManageMode
        ? `<i class="fa-solid fa-link-slash"></i> Unlink Selected <span id="lbLinkApplyCount"></span>`
        : `<i class="fa-solid fa-link"></i> Link <span id="lbLinkApplyCount"></span>`;
}

function closeLinkPicker() {
    document.getElementById('lbLinkModal')?.classList.remove('visible');
}

// Reflect the active mode (set by the entry point: link / bind / manage) on the hint, the search
// placeholder, and the hide-already-linked control (characters-only).
function syncLinkModeUI() {
    const hint = document.getElementById('lbLinkModeHint');
    const searchEl = document.getElementById('lbLinkSearch');
    const hideWrap = document.getElementById('lbLinkHideLinkedWrap');
    syncLinkPlaylistVisibility();
    if (linkManageMode) {
        const what = linkMode === 'chats' ? 'chats bound to' : 'characters using';
        if (hint) hint.innerHTML = `Select the ${what} <strong>${esc(linkBook)}</strong> to unlink, then Unlink Selected.`;
        if (searchEl) searchEl.placeholder = linkMode === 'chats' ? 'Search bound chats...' : 'Search linked characters...';
        if (hideWrap) hideWrap.hidden = true;
        return;
    }
    if (linkMode === 'characters') {
        if (hint) {
            hint.innerHTML = `Link <strong>${esc(linkBook)}</strong> to the chosen characters. It is added to their linked lorebooks; existing links are kept.`;
        }
        if (searchEl) searchEl.placeholder = 'Search characters...';
        if (hideWrap) hideWrap.hidden = false;
    } else {
        if (hint) {
            hint.innerHTML = `Bind <strong>${esc(linkBook)}</strong> to the chosen chats (writes to the chat, not the card).`;
        }
        if (searchEl) searchEl.placeholder = 'Search chats or characters...';
        if (hideWrap) hideWrap.hidden = true;
    }
}

// Playlists group characters, so the filter only makes sense in the characters modes.
function syncLinkPlaylistVisibility() {
    const wrap = document.getElementById('lbLinkPlaylistWrap');
    if (wrap) wrap.hidden = !(linkPlaylistAvailable && linkMode === 'characters');
}

// Rebuild the playlist options on each open so renames/new playlists show without a reload.
async function populateLinkPlaylistFilter() {
    const sel = document.getElementById('lbLinkPlaylistFilter');
    if (!sel) return;
    try { await CoreAPI.playlistsLoadPlaylists(); } catch (_) { /* filter just stays hidden */ }
    const lists = CoreAPI.playlistsGetAll() || [];
    sel.innerHTML = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All Characters';
    sel.appendChild(all);
    for (const pl of lists) {
        const o = document.createElement('option');
        o.value = pl.uid;
        o.textContent = pl.name;
        sel.appendChild(o);
    }
    sel.value = lists.some(p => p.uid === linkPlaylistUid) ? linkPlaylistUid : '';
    sel._customSelect?.refresh();
    linkPlaylistAvailable = lists.length > 0;
    syncLinkPlaylistVisibility();
}

// server-paged candidates, never the library; hideLinked filters client-side (no server negation, the carried set is small)
const LINK_PAGE_SIZE = 200;

function linkQueryParams() {
    const params = { qIn: 'name,creator', sort: 'name', limit: LINK_PAGE_SIZE };
    const q = linkSearch.trim();
    if (q) params.q = q;
    if (linkPlaylistUid) params.rules = JSON.stringify([{ field: 'playlist', op: 'in', value: linkPlaylistUid }]);
    return params;
}

async function refreshLinkCandidates() {
    const seq = ++linkPageSeq;
    const listEl = document.getElementById('lbLinkList');
    linkPageCursor = null;
    const loadFailed = () => { linkFiltered = []; clearVList(); if (listEl) listEl.innerHTML = `<div class="lb-link-empty">Could not load characters.<br>${retryButtonHtml('link-chars-retry')}</div>`; };
    if (linkManageMode && linkMode === 'characters') {
        // strict: a chunk that failed is unknown, never a carrier that is gone
        let carriers;
        try { carriers = await CoreAPI.fetchCharactersByIds([...linkCarriedSet], { strict: true }); } catch (err) {
            console.error('[Lorebook] link carriers failed:', err);
            if (seq === linkPageSeq) loadFailed();
            return;
        }
        if (seq !== linkPageSeq) return;
        const q = linkSearch.trim().toLowerCase();
        linkFiltered = q ? carriers.filter(c => (c.name || '').toLowerCase().includes(q)) : carriers;
        renderLinkListLoaded();
        return;
    }
    linkPageLoading = true;
    try {
        const page = await CoreAPI.fetchCharactersPage(linkQueryParams());
        if (seq !== linkPageSeq) return;
        linkPageCursor = page.nextCursor;
        linkFiltered = linkHideLinked && linkMode === 'characters'
            ? page.chars.filter(c => !linkCarriedSet.has(c.id))
            : page.chars;
        renderLinkListLoaded();
    } catch (err) {
        console.error('[Lorebook] link candidates failed:', err);
        if (seq === linkPageSeq) loadFailed();
    } finally {
        if (seq === linkPageSeq) linkPageLoading = false;
    }
}

async function loadMoreLinkCandidates() {
    if (!linkPageCursor || linkPageLoading) return;
    const seq = linkPageSeq;
    linkPageLoading = true;
    try {
        const page = await CoreAPI.fetchCharactersPage({ ...linkQueryParams(), after: linkPageCursor });
        if (seq !== linkPageSeq) return;
        linkPageCursor = page.nextCursor;
        const fresh = linkHideLinked && linkMode === 'characters'
            ? page.chars.filter(c => !linkCarriedSet.has(c.id))
            : page.chars;
        linkFiltered.push(...fresh);
        appendVList();
        syncLinkSelectToggle();
    } catch (err) {
        console.error('[Lorebook] link page failed:', err);
    } finally {
        if (seq === linkPageSeq) linkPageLoading = false;
    }
}

function renderLinkListLoaded() {
    const listEl = document.getElementById('lbLinkList');
    if (!listEl) return;
    if (!linkFiltered.length) {
        clearVList();
        listEl.innerHTML = `<div class="lb-link-empty">No characters match.</div>`;
        updateLinkFooter();
        return;
    }
    renderVList(listEl, linkFiltered, charLinkRowHtml);
    updateLinkFooter();
}

// List virtualization (unbounded character lists; only render what's in view)

// measure a real row once per open so the window math is exact on both platforms without hardcoded pixels
function measureLinkRowStride(listEl) {
    const probe = document.createElement('button');
    probe.className = 'lb-link-row';
    probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:100%;';
    probe.innerHTML = '<span class="lb-link-check"></span><img class="lb-link-avatar" alt=""><span class="lb-link-name">probe</span>';
    listEl.appendChild(probe);
    // offsetHeight (layout px), NOT getBoundingClientRect: under UI Scale (body zoom) painted rows are shorter and overlap
    const h = probe.offsetHeight;
    probe.remove();
    const gap = parseFloat(getComputedStyle(listEl).rowGap) || 4;
    return (h + Math.round(gap)) || 54;
}

function clearVList() {
    vlistActive = false;
    vlistData = null;
}

// mobile scrolls the modal body, desktop the list itself; windowing reads whichever scrolls
function vlistScroller(listEl) {
    return CoreAPI.isMobileMode() ? (listEl.closest('.lb-link-body') || listEl) : listEl;
}

// Render a sizer the full height of the list, then fill only the in-view rows (absolute-positioned).
function renderVList(listEl, items, rowFn) {
    if (!linkRowStride) linkRowStride = measureLinkRowStride(listEl);
    vlistData = { items, rowFn };
    vlistActive = true;
    listEl.innerHTML = `<div class="lb-vsizer" style="height:${items.length * linkRowStride}px;"></div>`;
    const scroller = vlistScroller(listEl);
    scroller.scrollTop = 0;
    // the scroll origin to the list's content (0 when the list scrolls itself), stable until the next render
    vlistListOffset = scroller === listEl ? 0
        : Math.max(0, listEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    paintVList();
    // clientHeight can be 0 during the modal open animation; correct the window once laid out.
    requestAnimationFrame(paintVList);
}

function paintVList() {
    const listEl = document.getElementById('lbLinkList');
    if (!listEl || !vlistActive || !vlistData) return;
    const sizer = listEl.firstElementChild;
    if (!sizer || !sizer.classList.contains('lb-vsizer')) return;
    const { items, rowFn } = vlistData;
    const stride = linkRowStride;
    const scroller = vlistScroller(listEl);
    const viewH = scroller.clientHeight || 400;
    const viewTop = scroller.scrollTop - vlistListOffset; // how far we've scrolled into the list's own content
    const OVERSCAN = 6;
    const start = Math.max(0, Math.floor(viewTop / stride) - OVERSCAN);
    const end = Math.min(items.length, Math.ceil((viewTop + viewH) / stride) + OVERSCAN);
    let html = '';
    for (let i = start; i < end; i++) {
        html += `<div class="lb-vrow" style="top:${i * stride}px;">${rowFn(items[i])}</div>`;
    }
    sizer.innerHTML = html;
    // Window reached the loaded tail with more pages behind the cursor: pull the next one.
    if (end >= items.length && linkPageCursor && !linkPageLoading) loadMoreLinkCandidates();
}

// Grow the sizer for rows appended by pagination; no scroll reset, no dataset swap
// (vlistData.items IS linkFiltered, pushed in place by the page loader).
function appendVList() {
    const listEl = document.getElementById('lbLinkList');
    if (!listEl || !vlistActive || !vlistData) return;
    const sizer = listEl.firstElementChild;
    if (!sizer || !sizer.classList.contains('lb-vsizer')) return;
    sizer.style.height = `${vlistData.items.length * linkRowStride}px`;
    paintVList();
}

// Repaint without rebuilding the dataset/scroll (used after select-all flips selection state).
function repaintLinkList() {
    if (vlistActive) paintVList();
    else renderLinkList();
}

function charLinkRowHtml(c) {
    const selected = linkSelection.has(c.id);
    const status = linkCarriedSet.has(c.id)
        ? `<span class="lb-link-status current"><i class="fa-solid fa-check"></i> Linked here</span>`
        : '';
    return `
        <button class="lb-link-row${selected ? ' selected' : ''}" data-action="link-toggle" data-char-id="${esc(c.id)}" title="${esc(c.name || c.id)}">
            <span class="lb-link-check"><i class="fa-solid fa-check"></i></span>
            <img class="lb-link-avatar lb-avatar-clickable" src="${esc(CoreAPI.getCharacterAvatarSmallThumbUrl(c.id))}" alt="" loading="lazy" title="View character details">
            <span class="lb-link-name">${esc(c.name || c.id)}</span>
            ${status}
        </button>`;
}

function renderLinkList() {
    const listEl = document.getElementById('lbLinkList');
    if (!listEl) return;

    if (linkMode === 'chats') { renderChatLinkList(listEl); return; }

    refreshLinkCandidates();
}

// Manage-chats bound list filtered by the current search.
function manageChatVisible() {
    const q = linkSearch.trim().toLowerCase();
    if (!q) return manageChatList;
    return manageChatList.filter(c => {
        const name = (c.name || '').toLowerCase();
        return name.includes(q) || (c.charName || '').toLowerCase().includes(q);
    });
}

// Manage-chats: every chat bound to this book, across characters (no per-char drill-down).
function renderManageChatList(listEl) {
    clearVList(); // bounded list (one book's bound chats); render in full
    const items = manageChatVisible();
    if (!items.length) {
        listEl.innerHTML = `<div class="lb-link-empty">${manageChatList.length ? 'No bound chats match.' : 'No chats are bound to this lorebook.'}</div>`;
        return;
    }
    listEl.innerHTML = items.map(c => {
        // the chat row id IS unique; a name is not, not even within one character
        const key = c.id;
        const name = c.name || '';
        return `
            <button class="lb-link-row${linkSelection.has(key) ? ' selected' : ''}" data-action="link-toggle-managechat" data-key="${esc(key)}" title="${esc(name)}">
                <span class="lb-link-check"><i class="fa-solid fa-check"></i></span>
                <img class="lb-link-avatar" src="${esc(CoreAPI.getCharacterAvatarSmallThumbUrl(c.charId))}" alt="" loading="lazy">
                <span class="lb-link-name">${esc(c.charName)}: ${esc(name)}</span>
            </button>`;
    }).join('');
}

// Chats mode: EVERY chat directly, recency-sorted, capped render (search narrows).
const LINK_CHAT_RENDER_CAP = 400;

function renderChatLinkList(listEl) {
    if (linkManageMode) { renderManageChatList(listEl); return; }
    clearVList();
    if (linkChatsLoading) {
        listEl.innerHTML = `<div class="lb-link-empty">Loading chats...</div>`;
        return;
    }
    if (linkChatsError) {
        listEl.innerHTML = `<div class="lb-link-empty">Could not load chats.<br>${retryButtonHtml('link-chats-retry')}</div>`;
        return;
    }
    const chats = linkVisibleChats();
    if (!chats.length) {
        listEl.innerHTML = `<div class="lb-link-empty">${linkAllChats.length ? 'No chats match.' : 'No chats yet.'}</div>`;
        return;
    }
    const shown = chats.slice(0, LINK_CHAT_RENDER_CAP);
    const capNote = linkChatsTotal > shown.length
        ? `<div class="lb-link-empty">${linkChatsTotal - shown.length} more chats: search to narrow.</div>`
        : '';
    listEl.innerHTML = shown.map(ch => {
        const label = `${ch.charName || '?'}: ${ch.name}`;
        const bound = Array.isArray(ch.worlds) ? ch.worlds : [];
        const selected = linkSelection.has(ch.id);
        const isThis = bound.includes(linkBook);
        const others = bound.filter(w => w !== linkBook);
        // a chat holds a LIST, so other books are information, never a conflict
        const status = isThis
            ? `<span class="lb-link-status current"><i class="fa-solid fa-check"></i> Bound here</span>`
            : others.length
                ? `<span class="lb-link-status other" title="Also bound: ${esc(others.join(', '))}"><i class="fa-solid fa-book"></i> <span class="lb-link-status-name">${esc(others.join(', '))}</span></span>`
                : '';
        return `
            <button class="lb-link-row${selected ? ' selected' : ''}" data-action="link-toggle-chat" data-id="${esc(ch.id)}" title="${esc(label)}">
                <span class="lb-link-check"><i class="fa-solid fa-check"></i></span>
                <img class="lb-link-avatar" src="${esc(CoreAPI.getCharacterAvatarSmallThumbUrl(ch.charId))}" alt="" loading="lazy">
                <span class="lb-link-name">${esc(label)}</span>
                <span class="lb-link-chat-count">${ch.messageCount || 0} msg</span>
                ${status}
            </button>`;
    }).join('') + capNote;
}

function updateLinkFooter() {
    const countEl = document.getElementById('lbLinkCount');
    if (countEl) countEl.textContent = `${linkSelection.size} selected`;
    const applyBtn = document.getElementById('lbLinkApplyBtn');
    const applyCount = document.getElementById('lbLinkApplyCount');
    if (applyBtn) applyBtn.disabled = linkSelection.size === 0;
    if (applyCount) applyCount.textContent = linkSelection.size ? `(${linkSelection.size})` : '';
    const selBar = document.querySelector('.lb-link-selectbar');
    if (selBar) selBar.hidden = false;
    syncLinkSelectToggle();
}

// Chats-mode rows under the search: the server already matched the chat name or its
// character's, so the answer is the visible set.
function linkVisibleChats() {
    return linkAllChats;
}

// Selection keys of the currently-shown rows (mode-aware: chars / per-char chats / manage-chats).
// Reads the cached filtered set for characters, so it never re-filters/re-sorts the library.
function linkShownKeys() {
    if (linkManageMode && linkMode === 'chats') return manageChatVisible().map(c => c.id);
    if (linkMode === 'chats') return linkVisibleChats().slice(0, LINK_CHAT_RENDER_CAP).map(ch => ch.id);
    return linkFiltered.map(c => c.id);
}

// Cheap count of shown rows without materializing the key array (keeps the toggle O(1)).
function linkShownCount() {
    if (linkManageMode && linkMode === 'chats') return manageChatVisible().length;
    if (linkMode === 'chats') return linkVisibleChats().length;
    return linkFiltered.length;
}

function syncLinkSelectToggle() {
    const btn = document.getElementById('lbLinkSelectToggle');
    if (!btn) return;
    const shown = linkShownCount();
    // short-circuit: the membership scan only runs once at least as many are selected as shown
    const allSel = shown > 0 && linkSelection.size >= shown && linkShownKeys().every(k => linkSelection.has(k));
    btn.title = allSel ? 'Deselect all shown' : 'Select all shown';
    btn.innerHTML = `<i class="fa-solid ${allSel ? 'fa-square-minus' : 'fa-square-check'}"></i>`;
}

// Linking is additive: the book is appended to each character's linked-lorebook list,
// so no overwrite conflict can exist. Already-carrying characters are skipped.
async function applyLinks() {
    if (!linkBook || linkSelection.size === 0) return;
    if (linkManageMode) return applyUnlinks();
    if (linkMode === 'chats') return applyChatLinks();

    // Apply-time capture: the picker can be closed + reopened for another world
    // while the request below is in flight, reassigning live linkBook.
    const book = linkBook;
    const targets = [...linkSelection];
    const toLink = targets.filter(av => !linkCarriedSet.has(av));

    if (!toLink.length) {
        CoreAPI.showToast('Nothing to link (all selected already carry this lorebook)', 'info');
        return;
    }

    const applyBtn = document.getElementById('lbLinkApplyBtn');
    const applyBtnHtml = applyBtn?.innerHTML;
    if (applyBtn) { applyBtn.disabled = true; applyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Linking...'; }

    // world links are relation rows; one server transaction covers the set, through the funnel that announces it
    const out = await CoreAPI.applyCharWorlds(toLink, { add: [book], source: 'lorebook-manager' }, { detail: true });
    if (applyBtn) { applyBtn.innerHTML = applyBtnHtml; applyBtn.disabled = false; }

    // Do not close a picker the user re-opened for a different world mid-batch.
    if (linkBook === book) closeLinkPicker();
    await refreshUsage();
    if (currentWorld) renderEditor();
    renderWorldList();
    bulkOutcomeToast({ done: out?.deltas?.length || 0, error: out?.ok ? null : (out?.error || 'the server did not answer'),
        skipped: targets.length - toLink.length, verb: 'Linked', notVerb: 'linked', noun: 'character' });
}

// A bulk verb's outcome in one toast: what landed, what was refused and why; never success at zero
function bulkOutcomeToast({ done, error = null, skipped = 0, verb, notVerb, noun, ms = 5000 }) {
    const count = (n) => `${n} ${noun}${n === 1 ? '' : 's'}`;
    const skip = skipped ? `, skipped ${skipped}` : '';
    // a refusal after some requests of a chunked set landed says both
    if (error && done) CoreAPI.showToast(`${verb} ${count(done)}, then not ${notVerb}: ${error}.`, 'warning', 6000);
    else if (error) CoreAPI.showToast(`Not ${notVerb}: ${error}.`, 'error', 6000);
    else if (!done) CoreAPI.showToast(`Nothing was ${notVerb}${skip}.`, 'info', ms);
    else CoreAPI.showToast(`${verb} ${count(done)}${skip}.`, 'success', ms);
}

async function applyChatLinks() {
    if (linkSelection.size === 0) return;
    // Apply-time captures: the picker can be closed + reopened elsewhere mid-batch.
    const book = linkBook;
    // every row the picker showed this session, so a chat picked under one search and
    // hidden by a narrower one still applies
    const targets = [...linkSelection].map(id => linkSeenChats.get(id)).filter(Boolean);


    const toBind = targets.filter(ch => !(Array.isArray(ch.worlds) ? ch.worlds : []).includes(book));

    if (!toBind.length) {
        CoreAPI.showToast('Nothing to bind (all selected were skipped or already bound)', 'info');
        return;
    }

    const applyBtn = document.getElementById('lbLinkApplyBtn');
    const applyBtnHtml = applyBtn?.innerHTML;
    if (applyBtn) { applyBtn.disabled = true; applyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Binding...'; }

    // chat bindings are relation rows too: one server transaction covers the set, through the chats module's funnel
    let out;
    try {
        out = await CoreAPI.applyChatWorldsBatch(toBind.map(ch => ch.id), { add: [book], source: 'lorebook-manager' })
            .catch((e) => ({ ok: false, deltas: [], skipped: [], error: e?.message || 'the server did not answer' }));
    } finally {
        if (applyBtn) { applyBtn.innerHTML = applyBtnHtml; applyBtn.disabled = false; }
    }
    const bound = new Set(out.deltas.map(d => d.chatId));
    for (const ch of toBind) if (bound.has(ch.id)) ch.worlds = [...(Array.isArray(ch.worlds) ? ch.worlds : []), book];

    if (linkBook === book) closeLinkPicker();
    await refreshUsage();
    if (currentWorld) renderEditor();
    renderWorldList();
    bulkOutcomeToast({ done: bound.size, error: out.error, skipped: targets.length - toBind.length + out.skipped.length, verb: 'Bound', notVerb: 'bound', noun: 'chat' });
}

// Manage-mode batch unlink: remove this book from the selected characters or chats.
async function applyUnlinks() {
    if (!linkBook || linkSelection.size === 0) return;
    const isChat = linkMode === 'chats';
    const book = linkBook; // apply-time capture, same reason as applyLinks
    const n = linkSelection.size;
    const ok = await CoreAPI.showConfirm({
        title: isChat ? 'Unbind selected chats?' : 'Unlink selected characters?',
        message: `Remove "${esc(book)}" from ${n} ${isChat ? `chat${n === 1 ? '' : 's'}` : `character${n === 1 ? '' : 's'}`}?`,
        confirmLabel: isChat ? 'Unbind' : 'Unlink',
        cancelLabel: 'Cancel',
        danger: true,
    });
    if (!ok) return;

    const applyBtn = document.getElementById('lbLinkApplyBtn');
    const applyBtnHtml = applyBtn?.innerHTML;
    if (applyBtn) { applyBtn.disabled = true; applyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Unlinking...'; }

    let done = 0;
    let error = null;
    try {
        if (isChat) {
            const chats = manageChatList.filter(c => linkSelection.has(c.id));
            const out = await CoreAPI.applyChatWorldsBatch(chats.map(c => c.id), { remove: [book], source: 'lorebook-manager' })
                .catch((e) => ({ ok: false, deltas: [], skipped: [], error: e?.message || 'the server did not answer' }));
            const unbound = new Set(out.deltas.map(d => d.chatId));
            for (const c of chats) if (unbound.has(c.id)) c.worlds = (Array.isArray(c.worlds) ? c.worlds : []).filter(w => w !== book);
            done = unbound.size;
            error = out.error;
        } else {
            const out = await CoreAPI.applyCharWorlds([...linkSelection], { remove: [book], source: 'lorebook-manager' }, { detail: true });
            done = out?.deltas?.length || 0;
            if (!out?.ok) error = out?.error || 'the server did not answer';
        }
    } finally {
        if (applyBtn) { applyBtn.innerHTML = applyBtnHtml; applyBtn.disabled = false; }
    }

    if (linkBook === book) closeLinkPicker();
    await refreshUsage();
    if (currentWorld) renderEditor();
    renderWorldList();
    bulkOutcomeToast(isChat
        ? { done, error, verb: 'Unbound', notVerb: 'unbound', noun: 'chat', ms: 4000 }
        : { done, error, verb: 'Unlinked', notVerb: 'unlinked', noun: 'character', ms: 4000 });
}

// ========================================
// EVENTS
// ========================================

// app-bar float, never scroll-linked: scroll events lag the compositor, so pixel-tracking jitters
function createToolbarAutoHide(getToolbar, getHeadH) {
    let lastY = null, lastEl = null, downRun = 0, upRun = 0, hideTimer = 0;
    const showFloat = (el) => {
        clearTimeout(hideTimer); hideTimer = 0;
        el.classList.remove('lb-toolbar-hidden');
        el.classList.add('lb-pinned');
    };
    const hideFloat = (el, instant) => {
        if (!el.classList.contains('lb-pinned')) return;
        if (instant) { clearTimeout(hideTimer); hideTimer = 0; el.classList.remove('lb-pinned', 'lb-toolbar-hidden'); return; }
        if (hideTimer) return;
        el.classList.add('lb-toolbar-hidden');
        hideTimer = setTimeout(() => { hideTimer = 0; el.classList.remove('lb-pinned', 'lb-toolbar-hidden'); }, 220);
    };
    return (y) => {
        const toolbar = getToolbar();
        if (!toolbar) return;
        // A re-rendered toolbar node starts fresh (inline, runs reset).
        if (toolbar !== lastEl) { lastEl = toolbar; lastY = null; downRun = 0; upRun = 0; clearTimeout(hideTimer); hideTimer = 0; }
        const dy = lastY === null ? 0 : y - lastY;
        lastY = y;
        if (dy > 0) { downRun += dy; upRun = 0; } else if (dy < 0) { upRun -= dy; downRun = 0; }
        const slotTop = getHeadH();
        if (y <= slotTop) { hideFloat(toolbar, true); return; }  // natural slot at/below the top edge: pure inline
        const floating = toolbar.classList.contains('lb-pinned');
        if (!floating && y < slotTop + toolbar.offsetHeight) return;  // partially scrolled into view: let it move naturally
        if (!floating && upRun > 8) showFloat(toolbar);
        else if (floating && downRun > 16) hideFloat(toolbar, false);
    };
}

function attachAutoHideToolbar(scrollEl, toolbarSel, headSel) {
    if (!scrollEl) return;
    const autoHide = createToolbarAutoHide(
        () => scrollEl.querySelector(toolbarSel),
        () => { const h = scrollEl.querySelector(headSel); return h ? h.offsetHeight : 48; },
    );
    scrollEl.addEventListener('scroll', () => autoHide(scrollEl.scrollTop), { passive: true });
}

function attachEvents() {
    const modal = document.getElementById('lorebookModal');
    if (!modal) return;

    document.getElementById('lbCloseBtn')?.addEventListener('click', handleModalBack);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    // Mobile: both the entries toolbar and the world-list tools bar auto-hide on scroll (sticky bars).
    attachAutoHideToolbar(document.getElementById('lbContent'), '.lb-entries-toolbar', '.lb-editor-head');
    attachAutoHideToolbar(modal.querySelector('.lb-sidebar'), '.lb-sidebar-tools', '.lb-sidebar-actions');

    // up/down walk the sidebar list; bails while typing or under a sub-modal (attachEvents runs once)
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        if (!lbNavAllowed()) return;
        const tag = e.target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
        e.preventDefault();
        moveActiveWorld(e.key === 'ArrowDown' ? 1 : -1);
    });

    document.getElementById('lbNewBtn')?.addEventListener('click', startCreate);
    // "New" is a split button: the caret reveals secondary create actions (Generate with AI).
    document.getElementById('lbNewCaret')?.addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('lbNewMenu')?.classList.toggle('hidden');
    });
    document.getElementById('lbAiBtn')?.addEventListener('click', () => {
        document.getElementById('lbNewMenu')?.classList.add('hidden');
        aiOpenGenerate('new');
    });
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('lbNewMenu');
        if (menu && !menu.classList.contains('hidden') && !e.target.closest('.lb-split-btn')) menu.classList.add('hidden');
    });
    document.getElementById('lbImportBtn')?.addEventListener('click', () => document.getElementById('lbImportInput')?.click());
    document.getElementById('lbImportInput')?.addEventListener('change', (e) => {
        importFiles(e.target.files);
        e.target.value = '';
    });

    document.getElementById('lbWorldSearch')?.addEventListener('input', (e) => {
        worldSearch = e.target.value;
        renderWorldList();
        scheduleCarrierSearch();
    });
    document.getElementById('lbWorldSort')?.addEventListener('change', (e) => {
        worldSort = e.target.value;
        renderWorldList();
    });
    // facet chips narrow the list by binding kind; the placeholder chip is a view toggle with its own listener
    document.querySelectorAll('.lb-facet[data-facet]').forEach(btn => {
        btn.addEventListener('click', () => setWorldFacet(btn.dataset.facet));
    });
    document.getElementById('lbShowPlaceholders')?.addEventListener('click', togglePlaceholders);

    document.getElementById('lbWorldList')?.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="shelf-retry"]')) { void refreshList({ keepSelection: true }); return; }
        const row = e.target.closest('[data-action="select-world"]');
        if (row) selectWorld(row.dataset.world);
    });
    document.getElementById('lbWorldList')?.addEventListener('keydown', (e) => {
        if (e.target.id === 'lbNewNameInput') {
            if (e.key === 'Enter') { e.preventDefault(); commitCreate(e.target.value); }
            else if (e.key === 'Escape') { e.preventDefault(); creatingNew = false; renderWorldList(); }
        }
    });
    document.getElementById('lbWorldList')?.addEventListener('focusout', (e) => {
        if (e.target.id === 'lbNewNameInput' && creatingNew) {
            // Commit on blur unless the value is empty (treat empty blur as cancel)
            commitCreate(e.target.value);
        }
    });

    const content = document.getElementById('lbContent');
    if (content) {
        content.addEventListener('click', onContentClick);
        content.addEventListener('input', onContentInput);
        content.addEventListener('change', onContentChange);
        content.addEventListener('keydown', onContentKeydown);
        // the note commits on blur (Escape cancels first in keydown, so this no-ops then)
        content.addEventListener('focusout', (e) => { if (e.target?.id === 'lbBookNoteInput') commitBookNote(); });
    }

    document.addEventListener('click', (e) => {
        const menu = document.getElementById('lbEditorOverflowMenu');
        if (menu && !menu.classList.contains('hidden') && !e.target.closest('.lb-editor-overflow')) menu.classList.add('hidden');
        const pMenu = document.getElementById('lbPersonaMenu');
        if (pMenu && !pMenu.classList.contains('hidden') && !e.target.closest('.lb-persona-add-wrap')) pMenu.classList.add('hidden');
    });

    const linkModal = document.getElementById('lbLinkModal');
    document.getElementById('lbLinkCloseBtn')?.addEventListener('click', closeLinkPicker);
    document.getElementById('lbLinkCancelBtn')?.addEventListener('click', closeLinkPicker);
    linkModal?.addEventListener('click', (e) => { if (e.target === linkModal) closeLinkPicker(); });
    document.getElementById('lbLinkApplyBtn')?.addEventListener('click', applyLinks);
    document.getElementById('lbLinkSearch')?.addEventListener('input', (e) => {
        linkSearch = e.target.value;
        // Debounce so a keystroke storm collapses to one pass: a re-query in chats mode
        // (the server searches), a filter+render pass otherwise.
        clearTimeout(linkSearchTimer);
        linkSearchTimer = setTimeout(() => {
            if (linkMode === 'chats' && !linkManageMode) void loadAllChatsForPicker();
            else renderLinkList();
        }, 120);
    });
    document.getElementById('lbLinkHideLinked')?.addEventListener('change', (e) => {
        linkHideLinked = e.target.checked;
        renderLinkList();
    });
    CoreAPI.initCustomSelect(document.getElementById('lbLinkPlaylistFilter'));
    document.getElementById('lbLinkPlaylistFilter')?.addEventListener('change', (e) => {
        linkPlaylistUid = e.target.value || '';
        renderLinkList();
    });
    // in-view rows repaint on scroll (one rAF); attach to both scrollers, only the active one fires
    const linkAutoHide = createToolbarAutoHide(
        () => document.getElementById('lbLinkHead'),
        () => document.querySelector('#lbLinkModal .lb-link-body .lb-link-mode-hint')?.offsetHeight || 0,
    );
    const onLinkScroll = (e) => {
        const scroller = e.currentTarget;
        if (scroller.classList.contains('lb-link-body')) linkAutoHide(scroller.scrollTop);
        if (vlistActive && !vlistRaf) vlistRaf = requestAnimationFrame(() => { vlistRaf = 0; paintVList(); });
    };
    document.getElementById('lbLinkList')?.addEventListener('scroll', onLinkScroll, { passive: true });
    document.querySelector('#lbLinkModal .lb-link-body')?.addEventListener('scroll', onLinkScroll, { passive: true });
    document.getElementById('lbLinkList')?.addEventListener('click', (e) => {
        const retry = e.target.closest('[data-action="link-chats-retry"], [data-action="link-chars-retry"]');
        if (retry) { if (retry.dataset.action === 'link-chats-retry') void loadAllChatsForPicker(); else renderLinkList(); return; }
        const charRow = e.target.closest('[data-action="link-toggle"]');
        if (charRow) {
            const charId = charRow.dataset.charId;
            // Clicking the avatar opens the character detail modal on top (not a selection toggle).
            if (e.target.closest('.lb-avatar-clickable')) {
                void CoreAPI.openCharacterById(charId, { elevated: true });
                return;
            }
            if (linkSelection.has(charId)) linkSelection.delete(charId);
            else linkSelection.add(charId);
            charRow.classList.toggle('selected', linkSelection.has(charId));
            updateLinkFooter();
            return;
        }

        const chatRow = e.target.closest('[data-action="link-toggle-chat"]');
        if (chatRow) {
            const id = chatRow.dataset.id;
            if (linkSelection.has(id)) linkSelection.delete(id);
            else linkSelection.add(id);
            chatRow.classList.toggle('selected', linkSelection.has(id));
            updateLinkFooter();
            return;
        }

        const manageChatRow = e.target.closest('[data-action="link-toggle-managechat"]');
        if (manageChatRow) {
            const key = manageChatRow.dataset.key;
            if (linkSelection.has(key)) linkSelection.delete(key);
            else linkSelection.add(key);
            manageChatRow.classList.toggle('selected', linkSelection.has(key));
            updateLinkFooter();
        }
    });
    document.getElementById('lbLinkSelectToggle')?.addEventListener('click', async () => {
        let keys;
        if (!linkManageMode && linkMode === 'characters') {
            // Paged list: select-all covers every MATCHING character server-side,
            // not just the pages scrolled into view so far.
            try {
                const ids = await CoreAPI.fetchCharacterIdsWhere(linkQueryParams());
                keys = ids;
                if (linkHideLinked) keys = keys.filter(a => !linkCarriedSet.has(a));
            } catch (err) {
                console.error('[Lorebook] select-all enumeration failed:', err);
                return;
            }
        } else {
            keys = linkShownKeys();
        }
        const allSel = keys.length > 0 && linkSelection.size >= keys.length && keys.every(k => linkSelection.has(k));
        keys.forEach(k => allSel ? linkSelection.delete(k) : linkSelection.add(k));
        repaintLinkList(); // selection changed, not the dataset; keep scroll position
        updateLinkFooter();
    });
}

function onContentClick(e) {
    const stop = e.target.closest('[data-stop]');
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    const uid = actionEl.dataset.uid !== undefined ? Number(actionEl.dataset.uid) : null;

    // Any action other than opening it dismisses the editor overflow (kebab) menu.
    if (action !== 'editor-overflow') document.getElementById('lbEditorOverflowMenu')?.classList.add('hidden');

    // Entry expand/collapse: ignore clicks that originate inside the toggle switch or head actions
    if (action === 'toggle-entry') {
        if (stop) return;
        const u = Number(actionEl.dataset.uid);
        if (expandedUids.has(u)) expandedUids.delete(u);
        else expandedUids.add(u);
        refreshRow(u);
        return;
    }

    switch (action) {
        case 'save': saveWorld(); break;
        case 'rename-world': startRename(); break;
        case 'link-chars': openLinkPicker('characters'); break;
        case 'bind-chats': openLinkPicker('chats'); break;
        case 'manage-links': openLinkPicker(actionEl.dataset.kind === 'chats' ? 'chats' : 'characters', { manage: true }); break;
        case 'edit-note': {
            editingNote = true;
            renderEditor();
            const box = document.getElementById('lbBookNoteInput');
            box?.focus();
            box?.setSelectionRange(box.value.length, box.value.length);
            break;
        }
        case 'toggle-global': toggleGlobalBinding(); break;
        case 'add-persona': e.stopPropagation(); openPersonaMenu(); break;
        case 'persona-pick': bindPersona(actionEl.dataset.personaId); break;
        case 'unlink-persona': unbindPersona(actionEl.dataset.personaId); break;
        case 'duplicate-world': duplicateWorld(); break;
        case 'export-world': exportWorld(); break;
        case 'delete-world': deleteWorld(); break;
        case 'add-entry': addEntry(); break;
        case 'editor-overflow': e.stopPropagation(); document.getElementById('lbEditorOverflowMenu')?.classList.toggle('hidden'); break;
        case 'ai-generate': aiOpenGenerate('current'); break;
        case 'toggle-all': {
            const ents = sortedEntries();
            const allExpanded = ents.length > 0 && ents.every(en => expandedUids.has(en.uid));
            if (allExpanded) expandedUids.clear();
            else ents.forEach(en => expandedUids.add(en.uid));
            renderEditor();
            break;
        }
        case 'duplicate-entry': duplicateEntry(uid); break;
        case 'delete-entry': deleteEntry(uid); break;
        case 'ext-act': {
            const en = workingWorld?.entries?.[uid];
            if (en) extRunAction(actionEl.dataset.key, loreEntryContext(currentWorld, en));
            break;
        }
        case 'toggle-advanced':
            if (advancedUids.has(uid)) advancedUids.delete(uid); else advancedUids.add(uid);
            refreshRow(uid);
            break;
        case 'set-state': {
            const en = workingWorld.entries[uid];
            if (!en) break;
            const s = actionEl.dataset.state;
            en.constant = s === 'constant';
            en.vectorized = s === 'vectorized';
            markDirty();
            refreshRow(uid);
            break;
        }
        case 'remove-key': {
            const field = actionEl.dataset.field;
            const idx = Number(actionEl.dataset.index);
            const entry = workingWorld.entries[uid];
            const ref = entry ? entryFieldRef(entry, field) : null;
            const arr = ref ? ref.obj[ref.key] : null;
            if (Array.isArray(arr)) {
                arr.splice(idx, 1);
                if (field.startsWith('characterFilter.')) normalizeCharacterFilter(entry);
                markDirty(); refreshRow(uid); refreshRowHeader(uid);
            }
            break;
        }
        case 'open-char': {
            // Open the character detail modal ABOVE the manager (don't close it); the user
            // returns to the manager when they dismiss the detail modal.
            void CoreAPI.openCharacterById(actionEl.dataset.charId, { elevated: true });
            break;
        }
        case 'unlink-char': unlinkCharFromCurrentWorld(actionEl.dataset.charId); break;
        case 'open-bound-chat': {
            const c = (chatBoundMap.get(currentWorld) || [])[Number(actionEl.dataset.idx)];
            if (c?.charId) void CoreAPI.openCharacterById(c.charId, { elevated: true });
            break;
        }
        case 'unbind-chat': {
            const c = (chatBoundMap.get(currentWorld) || [])[Number(actionEl.dataset.idx)];
            if (c) unbindChatFromCurrentWorld(c);
            break;
        }
        case 'empty-new': startCreate(); break;
        case 'empty-import': document.getElementById('lbImportInput')?.click(); break;
        case 'shelf-retry': void refreshList({ keepSelection: true }); break;
    }
}

async function mobileBackToList() {
    if (dirty) {
        const ok = await CoreAPI.showConfirm({
            title: 'Discard unsaved changes?',
            message: `You have unsaved edits to "${currentWorld}". Discard them?`,
            confirmLabel: 'Discard',
            cancelLabel: 'Keep Editing',
            danger: true,
        });
        if (!ok) return;
    }
    currentWorld = null;
    workingWorld = null;
    dirty = false;
    setEditingMode(false);
    renderEmptyContent();
    renderWorldList();
}

// the one back/close router (header arrow, Android back, Escape): a phone steps back to the list first
function handleModalBack() {
    const body = document.querySelector('#lorebookModal .lb-body');
    if (CoreAPI.isMobileMode() && body?.classList.contains('lb-editing')) {
        mobileBackToList();
    } else {
        closeModal();
    }
}

function onContentInput(e) {
    const target = e.target;
    if (target.id === 'lbEntrySearch') {
        entrySearch = target.value;
        renderEntriesOnly();
        return;
    }
    const field = target.dataset.field;
    if (!field || target.dataset.action === 'add-key') return;
    const uid = Number(target.dataset.uid);
    const type = target.dataset.type || 'string';
    if (type === 'bool' || type === 'bool-inv' || type === 'int' || type === 'tristate') return; // those fire 'change'
    coerceStore(uid, field, type, target.value);
    markDirty();
    if (field === 'content') autoGrowLb(target);
    if (field === 'comment' || field === 'order') refreshRowHeader(uid);
}

function onContentChange(e) {
    const target = e.target;
    if (target.id === 'lbEntrySort') {
        entrySort = target.value;
        renderEntriesOnly();
        return;
    }
    if (target.dataset.action === 'toggle-trigger') {
        const entry = workingWorld.entries[Number(target.dataset.uid)];
        if (!entry) return;
        const t = target.dataset.trigger;
        const arr = Array.isArray(entry.triggers) ? entry.triggers : [];
        entry.triggers = target.checked
            ? (arr.includes(t) ? arr : [...arr, t])
            : arr.filter(x => x !== t);
        markDirty();
        return;
    }
    const field = target.dataset.field;
    if (!field) return;
    const uid = Number(target.dataset.uid);
    const type = target.dataset.type || 'string';
    const raw = (type === 'bool' || type === 'bool-inv') ? target.checked : target.value;
    coerceStore(uid, field, type, raw);
    markDirty();
    // Layout-affecting fields: re-render the row so dependent controls show/hide.
    if (field === 'position' || field === 'disable') refreshRow(uid);
}

function onContentKeydown(e) {
    const target = e.target;
    if (target.id === 'lbBookNoteInput') {
        if (e.key === 'Escape') { e.preventDefault(); commitBookNote(true); }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitBookNote(); }
        return;
    }
    if (target.dataset?.action !== 'add-key') return;
    if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const raw = target.value.trim().replace(/,$/, '').trim();
        if (!raw) return;
        const uid = Number(target.dataset.uid);
        const field = target.dataset.field;
        const entry = workingWorld.entries[uid];
        if (!entry) return;
        // Entries from imported files can lack the array entirely; the user is editing this
        // entry, so creating the field is mutate-in-place, not a rebuild.
        const ref = entryFieldRef(entry, field);
        let arr = ref.obj[ref.key];
        if (!Array.isArray(arr)) { arr = []; ref.obj[ref.key] = arr; }
        // Allow comma-paste of multiple keys at once
        for (const part of raw.split(',').map(s => s.trim()).filter(Boolean)) {
            if (!arr.includes(part)) arr.push(part);
        }
        markDirty();
        refreshRow(uid);
        refreshRowHeader(uid);
        requestAnimationFrame(() => {
            const fresh = document.querySelector(`.lb-pill-input[data-uid="${uid}"][data-field="${field}"]`);
            fresh?.focus();
        });
    } else if (e.key === 'Backspace' && target.value === '') {
        const uid = Number(target.dataset.uid);
        const field = target.dataset.field;
        const entry = workingWorld.entries[uid];
        const ref = entry ? entryFieldRef(entry, field) : null;
        const arr = ref ? ref.obj[ref.key] : null;
        if (Array.isArray(arr) && arr.length) {
            arr.pop();
            if (field.startsWith('characterFilter.')) normalizeCharacterFilter(entry);
            markDirty();
            refreshRow(uid);
            refreshRowHeader(uid);
            requestAnimationFrame(() => {
                const fresh = document.querySelector(`.lb-pill-input[data-uid="${uid}"][data-field="${field}"]`);
                fresh?.focus();
            });
        }
    }
}

// Re-render just the entries list (preserves the header/toolbar, used for search/sort)
function renderEntriesOnly() {
    const wrap = document.getElementById('lbEntries');
    if (!wrap || !workingWorld) return;
    const entries = sortedEntries();
    const total = Object.keys(workingWorld.entries).length;
    wrap.innerHTML = entries.length ? entries.map(e => renderEntryRow(e)).join('') : renderNoEntries(total);
    growVisibleContentFields(wrap);
}

// ========================================
// AI: CONNECTION (delegates request/parse to the shared CoreAPI.callLLM + getLlmSettings;
// only the panel's own profile <select> + selection live here.)
// ========================================

let aiConn = null;
let aiActiveSource = '';
let aiActiveModel = '';

// Mounts the canonical connection block into the panel (selection + overrides persist
// per surface); the source/model resolution lives in CoreAPI.getLlmSettings.
async function aiLoadProfiles() {
    const host = document.getElementById('lbAiConn');
    if (!host) return;
    if (!aiConn) {
        aiConn = await CoreAPI.mountAiConnectionBlock(host, {
            surface: 'lorebook',
            layout: 'row',
            panelHost: document.getElementById('lbAiConnPanel'),
        });
    } else {
        await aiConn.refresh();
    }
    const s = aiConn?.getSettings?.();
    if (s) {
        aiActiveSource = s.activeSource;
        aiActiveModel = s.activeModel;
    }
}

function aiSelectedProfile() {
    return aiConn?.getProfile?.() || null;
}

// flat maxTokens is local on purpose (AI_GEN_MAX_TOKENS sizes the page batches); null temperature defers to the connection
function aiCallLLM(messages, { signal, maxTokens = 4000, temperature = null } = {}) {
    return CoreAPI.callLLM(messages, {
        profile: aiSelectedProfile(),
        activeSource: aiActiveSource, activeModel: aiActiveModel,
        temperature, maxTokens, params: aiConn?.getParams?.(), signal,
        stripSurrogates: true, debugTag: 'Lorebooks AI',
    });
}

// ========================================
// AI: SOURCE FETCH (webpage / MediaWiki wiki through the shared direct-then-proxy fetch)
// ========================================

const AI_SOURCE_MAX_CHARS = 24000;
const AI_GEN_MAX_CONTEXT = 24000;   // default per-request char budget; batches a multi-page source across calls
const AI_GEN_MAX_TOKENS = 8000;     // per-batch output token cap (safe across providers)
// one ~450 tok entry per page must fit the reply cap, or the array's tail truncates
const AI_GEN_PAGES_PER_BATCH = Math.max(8, Math.floor(AI_GEN_MAX_TOKENS / 450)); // = 17
const AI_SRC_CHAT_CAP = 12000;       // per-chat char cap (one big chat shouldn't dominate)
const AI_SRC_LASTN_DEFAULT = 50;     // default "Last N" messages for a chat scope
const AI_GEN_CONCURRENCY = 4;       // max simultaneous generate requests when batching
// Character card fields offered per-character in the From-library picker (all on by default).
const AI_SRC_CHAR_FIELDS = [
    ['description', 'Description'],
    ['personality', 'Personality'],
    ['scenario', 'Scenario'],
    ['first_mes', 'First message'],
    ['mes_example', 'Example dialogue'],
];
const aiSrcAllFields = () => new Set(AI_SRC_CHAR_FIELDS.map(f => f[0]));

// Rendered HTML -> readable plain text. DOMParser gives far cleaner extraction than a
// regex strip: we drop non-content nodes, prefer the main/article body, collapse space.
function aiHtmlToText(html) {
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('script, style, noscript, template, svg, nav, header, footer, aside, form, .navbox, .mw-editsection, .reference, sup.reference, .toc, .infobox-image, figure, figcaption').forEach(n => n.remove());
        const root = doc.querySelector('article, main, #mw-content-text, .mw-parser-output') || doc.body || doc.documentElement;
        const text = (root?.textContent || '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        return text;
    } catch {
        // fallback: crude strip
        return String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
}

// Is this a MediaWiki page URL (Fandom, Wikipedia, most wikis)? If so we hit api.php
// for clean parsed HTML instead of scraping the chrome-heavy page.
function aiDetectMediaWiki(u) {
    try {
        const url = new URL(u);
        const host = url.hostname.toLowerCase();
        const isWiki = host.endsWith('fandom.com') || host.endsWith('wikipedia.org') || host.endsWith('wikia.org') || host.includes('.miraheze.org') || /\/wiki\//.test(url.pathname);
        if (!isWiki) return null;
        const m = url.pathname.match(/\/wiki\/([^?#]+)/);
        if (!m) return null;
        const title = decodeURIComponent(m[1]).replace(/_/g, ' ');
        return { api: `${url.origin}/api.php`, title };
    } catch { return null; }
}

// Fetch + extract readable source text from a URL. Returns { text, title }.
async function aiFetchSource(rawUrl) {
    let url = String(rawUrl || '').trim();
    if (!url) throw new Error('Enter a URL first.');
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    const wiki = aiDetectMediaWiki(url);
    if (wiki) {
        const api = `${wiki.api}?action=parse&page=${encodeURIComponent(wiki.title)}&prop=text&format=json&redirects=1&origin=*`;
        try {
            const resp = await fetchWithProxy(api, { headers: { 'Accept': 'application/json' } });
            const data = await resp.json();
            const htmlText = data?.parse?.text?.['*'];
            if (htmlText) {
                return { text: aiHtmlToText(htmlText).slice(0, AI_SOURCE_MAX_CHARS), title: data?.parse?.title || wiki.title };
            }
            if (data?.error) throw new Error(data.error.info || 'wiki API error');
        } catch (e) {
            CoreAPI.debugLog('[Lorebooks AI] wiki API failed, falling back to page scrape:', e?.message || e);
            // fall through to generic page fetch
        }
    }

    const resp = await fetchWithProxy(url, { headers: { 'Accept': 'text/html,*/*' } });
    const html = await resp.text();
    const text = aiHtmlToText(html).slice(0, AI_SOURCE_MAX_CHARS);
    if (!text) throw new Error('Could not extract any text from that page.');
    let title = '';
    title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
    return { text, title };
}

// ========================================
// AI: PROMPTS + ENTRY COERCION
// ========================================

const AI_GEN_SYSTEM = `You are an expert character lorebook author. You turn source material into a set of focused lorebook entries.

How World Info works: each entry has trigger KEYS (keywords). When a key appears in recent chat, that entry's CONTENT is injected into the AI's context. So entries should be atomic, one subject each (a character, place, faction, event, item, or world rule), and keys should be the words a conversation would naturally use to refer to that subject: names, aliases, nicknames, titles.

Return ONLY a JSON array. No prose, no markdown fence. Each element:
{
  "comment": short title naming the subject,
  "keys": [primary trigger words and aliases],
  "secondary_keys": [optional words that must ALSO appear to trigger; usually empty []],
  "content": the lore text to inject, concise and factual, written so it reads cleanly mid-prompt, no meta commentary like "this entry describes",
  "constant": true ONLY for always-relevant world setting/rules that should always be in context (rare); otherwise false,
  "position": 0 (before character definitions) by default; 4 for at-depth notes,
  "order": insertion priority, lower inserts first; 100 unless an entry should dominate
}

Good practice (guidance, not rigid rules): split long source into several focused entries rather than one giant entry; give each subject the aliases a chat would actually use; keep content tight and concrete; drop trivia; never invent facts not supported by the source. Honor the user's instructions on granularity, tone, and length.`;

// Tolerant JSON-array parse: fence-strip, direct parse, greedy [..], then truncation repair.
function aiParseJsonArray(raw) {
    let text = String(raw || '').trim();
    const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fence) text = fence[1].trim();
    try { const a = JSON.parse(text); if (Array.isArray(a)) return a; } catch { /* next */ }
    const m = text.match(/\[[\s\S]*\]/);
    if (m) { try { const a = JSON.parse(m[0]); if (Array.isArray(a)) return a; } catch { /* next */ } }
    // truncation repair: keep up to the last complete object and close the array
    const start = text.indexOf('[');
    if (start !== -1) {
        let frag = text.slice(start);
        const lastBrace = frag.lastIndexOf('}');
        if (lastBrace !== -1) {
            frag = frag.slice(0, lastBrace + 1);
            if (!frag.trimEnd().endsWith(']')) frag = frag.replace(/,\s*$/, '') + ']';
            try { const a = JSON.parse(frag); if (Array.isArray(a) && a.length) return a; } catch { /* give up */ }
        }
    }
    return null;
}

function aiNormStrArray(v) {
    if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
    if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean);
    return [];
}

// built on newEntry so every advanced field gets a default; only what the model gave is overridden
function aiEntryToNative(raw, uid) {
    const e = newEntry(uid, uid);
    e.key = aiNormStrArray(raw.keys ?? raw.key);
    e.keysecondary = aiNormStrArray(raw.secondary_keys ?? raw.keysecondary);
    e.comment = String(raw.comment ?? raw.title ?? raw.name ?? '').trim();
    e.content = String(raw.content ?? '').trim();
    e.constant = !!raw.constant;
    if (raw.vectorized) e.vectorized = true;
    const pos = Number(raw.position);
    if (Number.isFinite(pos) && POSITION_OPTIONS.some(p => p[0] === pos)) e.position = pos;
    const ord = Number(raw.order);
    if (Number.isFinite(ord)) e.order = ord;
    const logic = Number(raw.selectiveLogic);
    if (Number.isFinite(logic) && LOGIC_OPTIONS.some(l => l[0] === logic)) e.selectiveLogic = logic;
    // selective gates the secondary keys (ours and STs alike), so it follows whether there are any
    e.selective = e.keysecondary.length > 0;
    e.addMemo = !!e.comment;
    return e;
}

// Drop empties: an entry with no content AND (no keys unless constant) is useless.
function aiEntryUsable(e) {
    if (!e.content) return false;
    if (!e.constant && !e.vectorized && (!Array.isArray(e.key) || e.key.length === 0)) return false;
    return true;
}

// ========================================
// AI: UI STATE + MODAL SHELL
// ========================================

let aiModalsBuilt = false;
let aiSourceMode = 'paste';      // paste | url | character
let aiFetchedText = '';          // resolved url/character source text
// From-library source: pick characters and/or chats.
let srcMode = 'characters';       // 'characters' | 'chats' sub-tab
let srcSelChars = new Map();      // char uuid -> { fields: Set<fieldKey> } (which card fields to send)
let srcSelChats = new Map();      // chat id -> { id, charId, charName, name, count, scope }
let srcChatsCache = null;         // cached solo chats from /chats/recent
let aiCategoryMembers = null;    // [{ title, selected }] when a wiki Category was fetched
let aiCatWiki = null;            // { api, title } of the fetched category
let aiCategoryBlocks = null;     // ['## Title\n<text>', ...] member content capped to the current detail level
let aiCategoryPages = null;      // [{ title, text }] whole fetched pages (to AI_CAT_PER_PAGE_MAX); detail-capped on demand
let aiPageDetail = 'standard';   // lead | standard | full, how much of each page feeds the model
let aiCatCapped = 0;             // pages dropped by the total cap at the current detail (for the status line)
let aiGenerating = false;
let aiGenAbort = null;
let aiLastGen = null;            // { source, instructions } for single-entry regen

// staging
let stagingEntries = [];         // [{ id, e (native entry), include }]
let stagingSeq = 0;
let stagingTarget = 'current';   // 'current' | 'new'
let stagingNewName = '';         // destination name when stagingTarget === 'new'
let stagingExpanded = new Set(); // sids of expanded review cards
let stagingFilter = '';          // review-list filter query

function aiBuildModals() {
    if (aiModalsBuilt) return;
    aiModalsBuilt = true;
    const html = `
    <div id="lbAiGenerateModal" class="cl-modal">
        <div class="cl-modal-content lb-ai-modal-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-wand-magic-sparkles cl-modal-header-icon"></i> Generate Lorebook with AI</h3>
                <button class="cl-modal-close" id="lbAiGenClose" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body lb-ai-body">
                <div class="lb-ai-grid2">
                    <section class="lb-ai-section lb-ai-col-source">
                        <div class="lb-ai-section-head"><span class="lb-ai-step">1</span> Source material</div>
                        <div class="lb-ai-source-seg" role="group" aria-label="Source">
                            <button class="lb-ai-src-opt active" data-action="ai-src" data-mode="paste"><i class="fa-solid fa-paste"></i> <span>Paste Text</span></button>
                            <button class="lb-ai-src-opt" data-action="ai-src" data-mode="url"><i class="fa-solid fa-globe"></i> <span>Web / Wiki</span></button>
                            <button class="lb-ai-src-opt" data-action="ai-src" data-mode="library"><i class="fa-solid fa-layer-group"></i> <span>From Library</span></button>
                        </div>

                        <div class="lb-ai-src-panel" data-panel="paste">
                            <textarea id="lbAiPasteText" class="lb-ai-textarea lb-ai-textarea-tall" rows="7" placeholder="Paste source material here: a wiki article, a setting doc, a character bio, world notes..."></textarea>
                        </div>

                        <div class="lb-ai-src-panel hidden" data-panel="url">
                            <div class="lb-ai-url-row">
                                <input type="search" id="lbAiUrlInput" class="cl-input lb-ai-url-input" placeholder="https://yourfandom.fandom.com/wiki/Character (or a Category: page)" autocomplete="off">
                                <button class="cl-btn cl-btn-primary lb-ai-fetch-btn" id="lbAiFetchBtn"><i class="fa-solid fa-download"></i> Fetch</button>
                            </div>
                            <div class="lb-ai-cat-panel hidden" id="lbAiCatPanel">
                                <div class="lb-ai-cat-head">
                                    <span class="lb-ai-cat-count" id="lbAiCatCount"></span>
                                </div>
                                <div class="lb-ai-cat-searchrow">
                                    <div class="lb-search-wrap"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="lbAiCatSearch" class="cl-input" placeholder="Filter pages..." autocomplete="off"></div>
                                    <button class="lb-icon-btn" data-action="cat-toggle-select" title="Select all"><i class="fa-solid fa-square-check"></i></button>
                                </div>
                                <div class="lb-ai-cat-list" id="lbAiCatList"></div>
                                <div class="lb-ai-cat-detail">
                                    <span class="lb-ai-cat-detail-label" title="How much of each page to send to the model. More detail means richer entries but more tokens per request.">Detail per page</span>
                                    <div class="lb-ai-detail-seg" role="group" aria-label="Detail per page">
                                        <button type="button" class="lb-ai-detail-opt" data-action="cat-detail" data-detail="lead" title="~1000 characters per page (the intro / lead). Concise entries, fits the most pages per request.">Lead</button>
                                        <button type="button" class="lb-ai-detail-opt" data-action="cat-detail" data-detail="standard" title="~3000 characters per page (lead plus the start of the body). Balanced.">Standard</button>
                                        <button type="button" class="lb-ai-detail-opt" data-action="cat-detail" data-detail="full" title="The entire page, no per-page trim. Richest entries, but the most tokens per request.">Full</button>
                                    </div>
                                </div>
                                <button class="cl-btn cl-btn-primary lb-ai-cat-load" id="lbAiCatLoad" disabled><i class="fa-solid fa-download"></i> Load Selected</button>
                            </div>
                        </div>

                        <div class="lb-ai-src-panel hidden" data-panel="library">
                            <div class="lb-ai-src-modes" role="group" aria-label="Source type">
                                <button type="button" class="lb-ai-src-mode active" data-action="st-mode" data-mode="characters"><i class="fa-solid fa-user"></i> Characters</button>
                                <button type="button" class="lb-ai-src-mode" data-action="st-mode" data-mode="chats"><i class="fa-solid fa-comments"></i> Chats</button>
                            </div>
                            <div class="lb-search-wrap"><i class="fa-solid fa-magnifying-glass"></i><input type="search" id="lbAiSrcSearch" class="cl-input" placeholder="Search characters..." autocomplete="off"></div>
                            <div class="lb-ai-src-list" id="lbAiSrcList"></div>
                            <div class="lb-ai-src-tray hidden" id="lbAiSrcTray"></div>
                        </div>

                        <div class="lb-ai-source-info hidden" id="lbAiSourceInfo"></div>
                    </section>

                    <div class="lb-ai-col-settings">
                        <section class="lb-ai-section">
                            <div class="lb-ai-section-head"><span class="lb-ai-step">2</span> Instructions <span class="lb-ai-section-sub">optional</span></div>
                            <textarea id="lbAiInstructions" class="lb-ai-textarea" rows="5" placeholder="e.g. One entry per named character, location and faction. Keys should be names and common aliases. Keep each entry under 120 words. Skip real-world trivia."></textarea>
                        </section>

                        <section class="lb-ai-section">
                            <div class="lb-ai-section-head"><span class="lb-ai-step">3</span> Output</div>
                            <div class="lb-ai-settings-row">
                                <div class="lb-ai-field lb-ai-conn-field">
                                    <div class="lb-ai-label lb-ai-conn-label-row">
                                        <span>Connection</span>
                                    </div>
                                    <div id="lbAiConn"></div>
                                </div>
                                <div class="lb-ai-field hidden" id="lbAiNewNameWrap">
                                    <label class="lb-ai-label">New lorebook name</label>
                                    <input type="search" id="lbAiNewName" class="cl-input" placeholder="Lorebook name..." autocomplete="off">
                                </div>
                                <div class="lb-ai-field lb-ai-field-narrow">
                                    <label class="lb-ai-label" title="Maximum number of entries to generate. Leave blank (auto) to let the model decide.">Max</label>
                                    <input type="number" id="lbAiMaxEntries" class="cl-input lb-ai-num" min="0" max="100" step="1" placeholder="auto">
                                </div>
                                <div class="lb-ai-field lb-ai-field-narrow">
                                    <label class="lb-ai-label" title="Per-request budget for source material, in characters. A multi-page source is split into batches that each fit this, then results are merged. Each batch is also limited to ${AI_GEN_PAGES_PER_BATCH} pages (the most entries the model can return in one reply), so beyond that a larger budget will not pack more pages per batch. The token figure beside it is an estimate at ~4 chars per token.">Context <span class="lb-ai-label-hint" id="lbAiCtxHint" title="Your Context budget as an estimated token count. Each generate request sends up to about this many tokens of source material; compare it to your model or proxy's context window."></span></label>
                                    <input type="number" id="lbAiMaxContext" class="cl-input lb-ai-num" min="4000" max="200000" step="1000" value="24000">
                                </div>
                            </div>
                            <div id="lbAiConnPanel"></div>
                        </section>
                    </div>
                </div>
            </div>
            <div class="cl-modal-footer">
                <button class="cl-btn cl-btn-secondary" id="lbAiGenCancel">Cancel</button>
                <button class="cl-btn cl-btn-primary" id="lbAiGenerateBtn"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate</button>
            </div>
        </div>
    </div>

    <div id="lbAiStagingModal" class="cl-modal">
        <div class="cl-modal-content lb-ai-staging-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-list-check cl-modal-header-icon"></i> Review generated entries</h3>
                <button class="cl-modal-close" id="lbAiStageClose" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body lb-ai-staging-body">
                <div class="lb-ai-staging-sub" id="lbAiStagingSub"></div>
                <div class="lb-ai-staging-controls">
                    <div class="lb-search-wrap lb-ai-stage-filter">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input type="search" id="lbAiStageFilter" class="cl-input" placeholder="Filter entries by title or key..." autocomplete="off">
                    </div>
                    <div class="lb-ai-staging-toolbar">
                        <button class="lb-icon-btn" data-action="stage-toggle-select" title="Select all"><i class="fa-solid fa-square-check"></i></button>
                        <button class="lb-icon-btn" data-action="stage-toggle-all" title="Expand all"><i class="fa-solid fa-down-left-and-up-right-to-center fa-rotate-90"></i></button>
                        <span class="lb-ai-staging-count" id="lbAiStagingCount"></span>
                    </div>
                </div>
                <div class="lb-ai-staging-list" id="lbAiStagingList"></div>
            </div>
            <div class="cl-modal-footer">
                <button class="cl-btn cl-btn-secondary" id="lbAiStageBack"><i class="fa-solid fa-arrow-left"></i> Back to Generate</button>
                <button class="cl-btn cl-btn-primary" id="lbAiStageCommit"><i class="fa-solid fa-plus"></i> Add Selected</button>
            </div>
        </div>
    </div>`;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    Array.from(wrap.children).forEach(el => document.body.appendChild(el));
    CoreAPI.mountDialogSizing('lbAiGenerateModal');
    CoreAPI.mountDialogSizing('lbAiStagingModal');

    aiAttachModalEvents();
}

// ========================================
// AI: GENERATE PANEL
// ========================================

function aiOpenGenerate(mode) {
    aiBuildModals();
    aiSourceMode = 'paste';
    aiFetchedText = '';
    srcSelChars = new Map(); srcSelChats = new Map(); srcMode = 'characters';
    aiCategoryMembers = null; aiCatWiki = null; aiCategoryBlocks = null; aiCategoryPages = null;
    aiPageDetail = aiGetSavedPageDetail();
    aiSetSourceMode('paste');
    document.getElementById('lbAiPasteText').value = '';
    document.getElementById('lbAiUrlInput').value = '';
    document.getElementById('lbAiInstructions').value = '';
    document.getElementById('lbAiNewName').value = '';
    document.getElementById('lbAiMaxEntries').value = '';
    document.getElementById('lbAiMaxContext').value = aiGetSavedMaxContext();
    document.getElementById('lbAiCatSearch').value = '';
    document.getElementById('lbAiSrcSearch').value = '';
    document.getElementById('lbAiSrcTray').classList.add('hidden');
    document.getElementById('lbAiSourceInfo').classList.add('hidden');
    aiRenderCatPanel();
    aiRenderDetailSeg();
    aiRenderCtxHint();

    // the launch point picks the destination: in-book AI adds to the open book, New creates one
    stagingTarget = (mode === 'current' && currentWorld) ? 'current' : 'new';
    document.getElementById('lbAiNewNameWrap').classList.toggle('hidden', stagingTarget !== 'new');

    aiLoadProfiles();
    document.getElementById('lbAiGenerateModal').classList.add('visible');
    if (!matchMedia('(pointer: coarse)').matches) document.getElementById('lbAiPasteText')?.focus();
}

// dirty on real work; the new name is excluded since fetches prefill it
function aiGenerateDirty() {
    if (aiGenerating) return true;
    const paste = (document.getElementById('lbAiPasteText')?.value || '').trim();
    const instr = (document.getElementById('lbAiInstructions')?.value || '').trim();
    return !!(paste || instr || aiFetchedText || srcSelChars.size || srcSelChats.size || (aiCategoryMembers && aiCategoryMembers.length));
}

function aiCloseGenerate() {
    if (!aiGenerateDirty()) { aiForceCloseGenerate(); return; }
    CoreAPI.showConfirm({
        title: 'Discard this generation?',
        message: 'You have source material or instructions entered. Discard them and close?',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep Editing',
        danger: true,
    }).then(ok => { if (ok) aiForceCloseGenerate(); });
}

function aiForceCloseGenerate() {
    if (aiGenerating) aiGenAbort?.abort(); // cancel an in-flight generation on close
    document.getElementById('lbAiGenerateModal')?.classList.remove('visible');
}

function aiSetSourceMode(mode) {
    aiSourceMode = mode;
    document.querySelectorAll('.lb-ai-src-opt').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    document.querySelectorAll('.lb-ai-src-panel').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== mode));
    if (mode === 'library') aiSrcRefresh();
}

function aiSetSourceInfo(text, ok = true) {
    const el = document.getElementById('lbAiSourceInfo');
    if (!el) return;
    el.classList.remove('hidden');
    el.classList.toggle('error', !ok);
    el.innerHTML = text;
}

async function aiFetchUrl() {
    let url = document.getElementById('lbAiUrlInput').value.trim();
    if (!url) { CoreAPI.showToast('Enter a URL', 'warning'); return; }
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const btn = document.getElementById('lbAiFetchBtn');

    // A wiki Category page lists members, not content; enumerate them for selection instead.
    const wiki = aiDetectMediaWiki(url);
    if (wiki && /^Category:/i.test(wiki.title)) {
        if (btn) { btn.disabled = true; btn.classList.add('lb-saving'); }
        try { await aiFetchCategoryMembers(wiki); }
        finally { if (btn) { btn.disabled = false; btn.classList.remove('lb-saving'); } }
        return;
    }

    aiCategoryMembers = null; aiCatWiki = null; aiCategoryBlocks = null; aiCategoryPages = null; aiRenderCatPanel();
    if (btn) { btn.disabled = true; btn.classList.add('lb-saving'); }
    aiSetSourceInfo('<i class="fa-solid fa-spinner fa-spin"></i> Fetching...');
    try {
        const { text, title } = await aiFetchSource(url);
        aiFetchedText = text;
        aiSetSourceInfo(`<i class="fa-solid fa-circle-check"></i> Fetched <strong>${esc(title || 'page')}</strong> (${text.length.toLocaleString()} chars${text.length >= AI_SOURCE_MAX_CHARS ? ', truncated' : ''})`);
        const nameEl = document.getElementById('lbAiNewName');
        if (nameEl && !nameEl.value && title) nameEl.value = title.slice(0, 60);
    } catch (e) {
        aiFetchedText = '';
        aiSetSourceInfo(`<i class="fa-solid fa-triangle-exclamation"></i> ${esc(e?.message || 'Fetch failed')}`, false);
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('lb-saving'); }
    }
}

// Wiki category crawling: enumerate members, then aggregate their page content

const AI_CAT_MAX_MEMBERS = 500;     // hard cap on enumerated members
const AI_CAT_DEFAULT_SELECTED = 40; // pre-checked by default
// detail tiers apply at generate time, so detail changes never re-fetch
const AI_CAT_PER_PAGE_MAX = 100000; // fetch/Full ceiling per page (the entire text of any real wiki page)
const AI_CAT_DETAIL = { lead: 1000, standard: 3000, full: AI_CAT_PER_PAGE_MAX };
const AI_CAT_TOTAL_CAP = 1000000;   // safety ceiling on total loaded content (memory guard)

// Enumerate a category's member pages via the MediaWiki categorymembers API (paginated).
async function aiFetchCategoryMembers(wiki) {
    aiSetSourceInfo('<i class="fa-solid fa-spinner fa-spin"></i> Reading category members...');
    const members = [];
    let cont = '';
    try {
        do {
            const u = `${wiki.api}?action=query&list=categorymembers&cmtitle=${encodeURIComponent(wiki.title)}&cmtype=page&cmlimit=500&format=json&origin=*${cont ? `&cmcontinue=${encodeURIComponent(cont)}` : ''}`;
            const resp = await fetchWithProxy(u, { headers: { 'Accept': 'application/json' } });
            const data = await resp.json();
            for (const m of (data?.query?.categorymembers || [])) members.push(m.title);
            cont = data?.continue?.cmcontinue || '';
        } while (cont && members.length < AI_CAT_MAX_MEMBERS);
    } catch (e) {
        aiCategoryMembers = null; aiRenderCatPanel();
        aiSetSourceInfo(`<i class="fa-solid fa-triangle-exclamation"></i> Could not read that category: ${esc(e?.message || 'error')}`, false);
        return;
    }
    if (!members.length) {
        aiCategoryMembers = null; aiRenderCatPanel();
        aiSetSourceInfo('<i class="fa-solid fa-triangle-exclamation"></i> No member pages found in that category.', false);
        return;
    }
    aiCatWiki = wiki;
    aiFetchedText = ''; aiCategoryBlocks = null; aiCategoryPages = null; // nothing loaded until the user picks + loads
    aiCategoryMembers = members.map((title, i) => ({ title, selected: i < AI_CAT_DEFAULT_SELECTED }));
    document.getElementById('lbAiSourceInfo')?.classList.add('hidden');
    aiRenderCatPanel();
    const catName = wiki.title.replace(/^Category:/i, '').trim();
    const nameEl = document.getElementById('lbAiNewName');
    if (nameEl && !nameEl.value && catName) nameEl.value = catName.slice(0, 60);
}

function aiRenderCatPanel() {
    const panel = document.getElementById('lbAiCatPanel');
    if (!panel) return;
    if (!aiCategoryMembers) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    const total = aiCategoryMembers.length;
    const sel = aiCategoryMembers.filter(m => m.selected).length;
    const countEl = document.getElementById('lbAiCatCount');
    if (countEl) countEl.textContent = `${total} page${total === 1 ? '' : 's'} found, ${sel} selected`;
    const q = (document.getElementById('lbAiCatSearch')?.value || '').trim().toLowerCase();
    const shown = q ? aiCategoryMembers.filter(m => m.title.toLowerCase().includes(q)) : aiCategoryMembers;
    const toggleBtn = document.querySelector('[data-action="cat-toggle-select"]');
    if (toggleBtn) {
        toggleBtn.hidden = !shown.length; // nothing visible to select
        const allSel = total > 0 && sel === total;
        toggleBtn.title = allSel ? 'Deselect all' : 'Select all';
        toggleBtn.innerHTML = `<i class="fa-solid ${allSel ? 'fa-square-minus' : 'fa-square-check'}"></i>`;
    }
    const listEl = document.getElementById('lbAiCatList');
    if (listEl) {
        listEl.innerHTML = shown.length
            ? shown.map(m => `
                <label class="lb-ai-cat-row">
                    <input type="checkbox" data-cat-title="${esc(m.title)}" ${m.selected ? 'checked' : ''}>
                    <span class="lb-ai-cat-name">${esc(m.title)}</span>
                </label>`).join('')
            : `<div class="lb-link-empty">No pages match.</div>`;
    }
    const loadBtn = document.getElementById('lbAiCatLoad');
    if (loadBtn) { loadBtn.disabled = sel === 0; loadBtn.innerHTML = `<i class="fa-solid fa-download"></i> Load ${sel} selected`; }
}

// each picked member's page via action=parse (Fandom lacks the extracts API), capped, bounded concurrency
async function aiLoadCategorySelection() {
    if (!aiCatWiki || !aiCategoryMembers) return;
    const titles = aiCategoryMembers.filter(m => m.selected).map(m => m.title);
    if (!titles.length) return;
    const btn = document.getElementById('lbAiCatLoad');
    if (btn) { btn.disabled = true; btn.classList.add('lb-saving'); }
    document.getElementById('lbAiSourceInfo')?.classList.remove('hidden');

    const results = new Array(titles.length).fill(null);
    let next = 0, done = 0;
    const worker = async () => {
        while (next < titles.length) {
            const i = next++;
            const title = titles[i];
            try {
                const u = `${aiCatWiki.api}?action=parse&page=${encodeURIComponent(title)}&prop=text&format=json&redirects=1&origin=*`;
                const resp = await fetchWithProxy(u, { headers: { 'Accept': 'application/json' } });
                const data = await resp.json();
                const html = data?.parse?.text?.['*'];
                // Store the whole page (to the fetch ceiling). The Detail-per-page control caps it at
                // generate time, so the user can change detail without re-fetching.
                const text = html ? aiHtmlToText(html).slice(0, AI_CAT_PER_PAGE_MAX).trim() : '';
                if (text) results[i] = { title: data?.parse?.title || title, text };
            } catch { /* skip this page */ }
            done++;
            aiSetSourceInfo(`<i class="fa-solid fa-spinner fa-spin"></i> Fetching page content (${done}/${titles.length})...`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(5, titles.length) }, worker));

    aiCategoryPages = results.filter(Boolean);
    if (!aiCategoryPages.length) {
        aiCategoryPages = null;
        if (btn) { btn.disabled = false; btn.classList.remove('lb-saving'); }
        aiSetSourceInfo('<i class="fa-solid fa-triangle-exclamation"></i> Could not fetch content for any of the selected pages.', false);
        return;
    }
    const { capped } = aiBuildCategoryBlocks();
    aiRenderCatLoadInfo(capped);
    if (btn) { btn.disabled = false; btn.classList.remove('lb-saving'); aiRenderCatPanel(); }
}

// Read the per-request char budget from the settings input (falls back to the default).
function aiCurrentMaxContext() {
    const raw = parseInt(document.getElementById('lbAiMaxContext')?.value, 10);
    return Number.isFinite(raw) && raw >= 4000 ? raw : AI_GEN_MAX_CONTEXT;
}

// Persisted per-request char budget; loaded on modal open, saved on generate.
function aiGetSavedMaxContext() {
    const v = parseInt(CoreAPI.getSetting('lorebook_aiMaxContext'), 10);
    return Number.isFinite(v) && v >= 4000 ? v : AI_GEN_MAX_CONTEXT;
}

// Persisted page-detail level.
function aiGetSavedPageDetail() {
    const v = CoreAPI.getSetting('lorebook_aiPageDetail');
    return AI_CAT_DETAIL[v] !== undefined ? v : 'standard';
}

// Rough token estimate from char count (~4 chars/token, English). Display-only, always prefixed "~".
function aiEstTokens(chars) { return Math.round(chars / 4); }
function aiFmtTokens(chars) { const t = aiEstTokens(chars); return t >= 1000 ? `${(t / 1000).toFixed(1)}k` : `${t}`; }

// rebuild the source blocks from the stored pages at the current detail; answers how many the total cap trimmed
function aiBuildCategoryBlocks() {
    if (!aiCategoryPages) { aiCategoryBlocks = null; aiFetchedText = ''; return { capped: 0 }; }
    const cap = AI_CAT_DETAIL[aiPageDetail] || AI_CAT_DETAIL.standard;
    const blocks = []; let total = 0, capped = 0;
    for (const p of aiCategoryPages) {
        const t = p.text.slice(0, cap).trim();
        if (!t) continue;
        const block = `## ${p.title}\n${t}`;
        if (total + block.length + 2 > AI_CAT_TOTAL_CAP) { capped++; continue; }
        total += block.length + 2; blocks.push(block);
    }
    aiCategoryBlocks = blocks;
    aiFetchedText = blocks.join('\n\n'); // resolved-source check + retry payload
    aiCatCapped = capped;
    return { capped };
}

// Loaded-pages status line with token + batch estimate; recomputed whenever detail or budget changes.
function aiRenderCatLoadInfo(capped = aiCatCapped) {
    const blocks = aiCategoryBlocks || [];
    if (!blocks.length) { aiSetSourceInfo('<i class="fa-solid fa-triangle-exclamation"></i> No usable page content at this detail level.', false); return; }
    const chars = aiFetchedText.length;
    const batches = aiSplitBlocksIntoBatches(blocks, aiCurrentMaxContext());
    const nb = batches.length;
    const perBatchMax = Math.max(...batches.map(b => b.join('\n\n').length));
    const maxPages = Math.max(...batches.map(b => b.length));
    const capNote = capped ? ` (${capped} trimmed past the ${(AI_CAT_TOTAL_CAP / 1000) | 0}k cap)` : '';
    // say WHY there are N batches: the smaller of the Context budget and the page cap wins
    const why = `Each request holds whichever is smaller: your Context budget, or ${AI_GEN_PAGES_PER_BATCH} pages. That page limit is the most entries the model can return in one reply before its output truncates, so a larger Context budget will not pack more pages into a batch.`;
    const batchNote = nb > 1
        ? ` &rarr; <span class="lb-ai-info-why" title="${why}">${nb} batches of up to ${maxPages} pages (~${aiFmtTokens(perBatchMax)} tok input each)</span>`
        : ' &rarr; 1 request';
    aiSetSourceInfo(`<i class="fa-solid fa-circle-check"></i> ${blocks.length} page${blocks.length === 1 ? '' : 's'} at <strong>${aiPageDetail}</strong> detail (~${chars.toLocaleString()} chars, ~${aiFmtTokens(chars)} tokens)${capNote}${batchNote}.`);
}

function aiRenderDetailSeg() {
    document.querySelectorAll('.lb-ai-detail-opt').forEach(b => b.classList.toggle('active', b.dataset.detail === aiPageDetail));
}

function aiSetPageDetail(level) {
    if (!AI_CAT_DETAIL[level]) return;
    aiPageDetail = level;
    CoreAPI.setSetting('lorebook_aiPageDetail', level);
    aiRenderDetailSeg();
    if (aiCategoryPages) { const { capped } = aiBuildCategoryBlocks(); aiRenderCatLoadInfo(capped); }
}

// Token-equivalent shown inside the Context label (kept out of the input flow so it can't shift
// the row's bottom-aligned inputs).
function aiRenderCtxHint() {
    const hint = document.getElementById('lbAiCtxHint');
    if (hint) hint.textContent = `(~${aiFmtTokens(aiCurrentMaxContext())} tok)`;
}

// pulse an accent glow once (nudges the fetch field); the reflow lets repeat clicks restart it
function aiGlow(el) {
    if (!el) return;
    el.classList.remove('lb-ai-glow');
    void el.offsetWidth;
    el.classList.add('lb-ai-glow');
    el.addEventListener('animationend', () => el.classList.remove('lb-ai-glow'), { once: true });
}

// Glow the field the user still needs to fill for the active source mode.
function aiGlowMissingSource() {
    if (aiSourceMode === 'paste') return aiGlow(document.getElementById('lbAiPasteText'));
    if (aiSourceMode === 'library') return aiGlow(document.getElementById('lbAiSrcList'));
    // url mode: an enumerated-but-not-loaded category points at Load selected, otherwise Fetch.
    if (aiCategoryMembers?.length && !aiCategoryBlocks?.length) return aiGlow(document.getElementById('lbAiCatLoad'));
    aiGlow(document.getElementById('lbAiFetchBtn'));
}

// pack whole blocks into batches within the char budget; one oversized block gets its own batch
function aiSplitBlocksIntoBatches(blocks, maxChars) {
    const batches = [];
    let cur = [], len = 0;
    for (const b of blocks) {
        const blen = b.length + 2;
        // a new batch past the INPUT budget or the page cap (one entry a page would overrun the OUTPUT cap)
        if (cur.length && (len + blen > maxChars || cur.length >= AI_GEN_PAGES_PER_BATCH)) {
            batches.push(cur); cur = []; len = 0;
        }
        cur.push(b); len += blen;
    }
    if (cur.length) batches.push(cur);
    return batches;
}

// From library: characters + chats picker

function aiSrcRefresh() {
    document.querySelectorAll('.lb-ai-src-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === srcMode));
    const search = document.getElementById('lbAiSrcSearch');
    if (search) search.placeholder = srcMode === 'chats' ? 'Search chats...' : 'Search characters...';
    if (srcMode === 'chats') aiRenderSrcChatList(search?.value || '');
    else aiRenderSrcCharList(search?.value || '');
    aiRenderSrcTray();
}

function aiSetSrcMode(mode) {
    srcMode = mode === 'chats' ? 'chats' : 'characters';
    document.querySelectorAll('.lb-ai-src-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === srcMode));
    const search = document.getElementById('lbAiSrcSearch');
    if (search) search.value = '';
    aiSrcRefresh();
}

let _aiSrcCharListGen = 0;
async function aiRenderSrcCharList(q) {
    const listEl = document.getElementById('lbAiSrcList');
    if (!listEl) return;
    const gen = ++_aiSrcCharListGen;
    const query = (q || '').trim();
    let chars = [];
    let failed = false;
    try {
        chars = await CoreAPI.fetchCharactersWhere({
            ...(query ? { q: query, qIn: 'name' } : {}),
            sort: 'name',
            limit: 80,
        });
    } catch { failed = true; }
    if (gen !== _aiSrcCharListGen) return; // superseded by a newer keystroke
    if (failed) { listEl.innerHTML = `<div class="lb-link-empty">Could not load characters.<br>${retryButtonHtml('st-src-retry')}</div>`; return; }
    if (!chars.length) { listEl.innerHTML = `<div class="lb-link-empty">No characters match.</div>`; return; }
    listEl.innerHTML = chars.map(c => `
        <button class="lb-ai-src-row${srcSelChars.has(c.id) ? ' selected' : ''}" data-action="st-pick-char" data-char-id="${esc(c.id)}" title="${esc(c.name || c.id)}">
            <span class="lb-ai-src-check"><i class="fa-solid fa-check"></i></span>
            <img class="lb-link-avatar" src="${esc(CoreAPI.getCharacterAvatarSmallThumbUrl(c.id))}" alt="" loading="lazy">
            <span class="lb-link-name">${esc(c.name || c.id)}</span>
        </button>`).join('');
}

// a scoped server query like aiRenderSrcCharList; rows stay cached only so the tray resolves a scrolled-away pick
let _aiSrcChatListGen = 0;
async function aiRenderSrcChatList(q) {
    const listEl = document.getElementById('lbAiSrcList');
    if (!listEl) return;
    const gen = ++_aiSrcChatListGen;
    const query = (q || '').trim();
    listEl.innerHTML = `<div class="lb-ai-src-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading chats...</div>`;

    let chats = [];
    let failed = false;
    try {
        const params = new URLSearchParams({ sort: 'recent', limit: '120' });
        if (query) params.set('q', query);
        const resp = await CoreAPI.apiRequest(`/chats?${params}`);
        const rows = resp.ok ? (await resp.json()).items : null;
        failed = !Array.isArray(rows);
        chats = (rows || [])
            .filter(r => (r.messageCount || 0) > 0 && r.charName != null)
            .map(r => ({
                id: r.id,
                charId: r.charId,
                charName: r.charName,
                name: r.name,
                count: r.messageCount || 0,
            }));
    } catch { failed = true; }
    if (gen !== _aiSrcChatListGen) return; // superseded by a newer keystroke

    // keep every row we have shown this session, so a tray pick survives a re-search
    srcChatsCache = srcChatsCache || [];
    for (const c of chats) if (!srcChatsCache.some(x => x.id === c.id)) srcChatsCache.push(c);

    if (failed) { listEl.innerHTML = `<div class="lb-link-empty">Could not load chats.<br>${retryButtonHtml('st-src-retry')}</div>`; return; }
    if (!chats.length) { listEl.innerHTML = `<div class="lb-link-empty">No chats match.</div>`; return; }
    listEl.innerHTML = chats.map(c => {
        // the chat row id is the key (a name-based key collapsed same-named chats onto one pick)
        const key = c.id;
        return `
        <button class="lb-ai-src-row${srcSelChats.has(key) ? ' selected' : ''}" data-action="st-pick-chat" data-key="${esc(key)}" title="${esc(c.name)}">
            <span class="lb-ai-src-check"><i class="fa-solid fa-check"></i></span>
            <img class="lb-link-avatar" src="${esc(CoreAPI.getCharacterAvatarSmallThumbUrl(c.charId))}" alt="" loading="lazy">
            <span class="lb-ai-src-chatmeta"><span class="lb-link-name">${esc(c.name)}</span><span class="lb-ai-src-sub">${esc(c.charName)} &middot; ${c.count} msg</span></span>
        </button>`;
    }).join('');
}

function aiToggleSrcChar(charId) {
    if (srcSelChars.has(charId)) srcSelChars.delete(charId);
    else srcSelChars.set(charId, { fields: aiSrcAllFields() }); // all fields on by default
    aiSrcRefresh();
}

// Per-character field toggle (multi-select; mirrors the chat scope control but each is independent).
function aiSrcToggleField(charId, field) {
    const c = srcSelChars.get(charId);
    if (!c) return;
    if (c.fields.has(field)) c.fields.delete(field); else c.fields.add(field);
    aiRenderSrcTray();
}

function aiSrcFieldPills(charId, sel) {
    const pill = (key, label) => `<button type="button" class="lb-ai-src-field-opt${sel.has(key) ? ' active' : ''}" data-action="st-field" data-char-id="${esc(charId)}" data-field="${key}">${esc(label)}</button>`;
    return `<div class="lb-ai-src-fields">${AI_SRC_CHAR_FIELDS.map(f => pill(f[0], f[1])).join('')}</div>`;
}

function aiToggleSrcChat(key) {
    if (srcSelChats.has(key)) srcSelChats.delete(key);
    else {
        const c = (srcChatsCache || []).find(x => x.id === key);
        if (c) srcSelChats.set(key, { ...c, scope: { mode: 'all', n: AI_SRC_LASTN_DEFAULT, from: 1, to: c.count } });
    }
    aiSrcRefresh();
}

// Per-chat scope control (All / Last N / Range), shown on its tray row.
function aiSrcScopeSeg(key, c) {
    const s = c.scope || { mode: 'all' };
    const seg = (mode, label) => `<button type="button" class="lb-ai-src-scope-opt${s.mode === mode ? ' active' : ''}" data-action="st-scope" data-key="${esc(key)}" data-scope="${mode}">${label}</button>`;
    let extra = '';
    if (s.mode === 'last') {
        extra = `<input type="number" class="lb-ai-src-scope-num" data-action="st-scope-n" data-key="${esc(key)}" min="1" value="${s.n || AI_SRC_LASTN_DEFAULT}" title="Most-recent messages to include">`;
    } else if (s.mode === 'range') {
        extra = `<span class="lb-ai-src-range"><input type="number" class="lb-ai-src-scope-num" data-action="st-scope-from" data-key="${esc(key)}" min="1" value="${s.from || 1}" title="From message #"><span class="lb-ai-src-range-dash">to</span><input type="number" class="lb-ai-src-scope-num" data-action="st-scope-to" data-key="${esc(key)}" min="1" value="${s.to || c.count}" title="To message #"></span>`;
    }
    return `<div class="lb-ai-src-scope-seg">${seg('all', 'All')}${seg('last', 'Last')}${seg('range', 'Range')}</div>${extra}`;
}

function aiSrcSetScopeMode(key, mode) {
    const c = srcSelChats.get(key);
    if (!c) return;
    c.scope = c.scope || {};
    c.scope.mode = mode;
    if (mode === 'last' && !c.scope.n) c.scope.n = AI_SRC_LASTN_DEFAULT;
    if (mode === 'range') { if (!c.scope.from) c.scope.from = 1; if (!c.scope.to) c.scope.to = c.count || 1; }
    aiRenderSrcTray();
}

function aiSrcSetScopeNum(key, field, val) {
    const c = srcSelChats.get(key);
    if (!c) return;
    const n = parseInt(val, 10);
    c.scope = c.scope || {};
    c.scope[field] = Number.isFinite(n) && n > 0 ? n : 1;
}

function aiRenderSrcTray() {
    const tray = document.getElementById('lbAiSrcTray');
    if (!tray) return;
    const nChar = srcSelChars.size, nChat = srcSelChats.size;
    if (!nChar && !nChat) { tray.classList.add('hidden'); tray.innerHTML = ''; return; }
    tray.classList.remove('hidden');
    // picked chars entered the identity cache when the picker fetched them
    const charCards = [...srcSelChars].map(([av, sel]) => {
        const c = CoreAPI.getCharacterById(av);
        return `
        <div class="lb-ai-src-chatpick">
            <div class="lb-ai-src-chatpick-top">
                <i class="fa-solid fa-user"></i>
                <span class="lb-ai-src-chatpick-name" title="${esc(c?.name || av)}">${esc(c?.name || av)}</span>
                <button class="lb-ai-src-chip-x" data-action="st-remove-char" data-char-id="${esc(av)}" title="Remove">&times;</button>
            </div>
            <div class="lb-ai-src-chatpick-scope">${aiSrcFieldPills(av, sel.fields)}</div>
        </div>`;
    }).join('');
    const chatCards = [...srcSelChats.values()].map(c => {
        const key = c.id;
        return `
        <div class="lb-ai-src-chatpick">
            <div class="lb-ai-src-chatpick-top">
                <i class="fa-solid fa-comments"></i>
                <span class="lb-ai-src-chatpick-name" title="${esc(c.name)} (${esc(c.charName)})">${esc(c.name)}</span>
                <button class="lb-ai-src-chip-x" data-action="st-remove-chat" data-key="${esc(key)}" title="Remove">&times;</button>
            </div>
            <div class="lb-ai-src-chatpick-scope">${aiSrcScopeSeg(key, c)}</div>
        </div>`;
    }).join('');
    tray.innerHTML = `
        <div class="lb-ai-src-tray-head">Selected <span class="lb-ai-src-tray-count">${nChar} character${nChar === 1 ? '' : 's'}, ${nChat} chat${nChat === 1 ? '' : 's'}</span></div>
        ${(charCards || chatCards) ? `<div class="lb-ai-src-chatpicks">${charCards}${chatCards}</div>` : ''}`;
}

// Build one source block per selected character + chat (chats fetched + scoped here).
async function aiBuildSrcContextBlocks(signal) {
    const blocks = [];
    // a scoped resolve of exactly the picks (heals cache-evicted ones), looked up by uuid like srcSelChars
    const picked = await CoreAPI.fetchCharactersByIds([...srcSelChars.keys()]);
    const charLookup = new Map(picked.map(c => [c.id, c]));
    const total = srcSelChars.size + srcSelChats.size;
    let done = 0;
    for (const [charId, sel] of srcSelChars) {
        if (signal?.aborted) return blocks;
        aiSetSourceInfo(`<i class="fa-solid fa-spinner fa-spin"></i> Reading selection (${++done}/${total})...`);
        const block = await aiSrcCharBlock(charLookup.get(charId), sel.fields);
        if (block) blocks.push(block);
    }
    for (const c of srcSelChats.values()) {
        if (signal?.aborted) return blocks;
        aiSetSourceInfo(`<i class="fa-solid fa-spinner fa-spin"></i> Reading selection (${++done}/${total})...`);
        const block = await aiSrcChatBlock(c);
        if (block) blocks.push(block);
    }
    return blocks;
}

async function aiSrcCharBlock(char, fields) {
    if (!char) return '';
    const enabled = fields || aiSrcAllFields();
    try {
        await CoreAPI.hydrateCharacter(char);
        const d = char.data || char;
        const parts = [`## ${char.name || char.id}`];
        const push = (key, label, v) => { if (!enabled.has(key)) return; const t = (v || '').toString().trim(); if (t) parts.push(`${label}: ${t}`); };
        push('description', 'Description', d.description);
        push('personality', 'Personality', d.personality);
        push('scenario', 'Scenario', d.scenario);
        push('first_mes', 'First message', d.first_mes);
        push('mes_example', 'Example dialogue', d.mes_example);
        if (parts.length < 2) return '';
        return parts.join('\n').slice(0, AI_SOURCE_MAX_CHARS);
    } catch { return ''; }
}

async function aiSrcChatBlock(c) {
    try {
        if (!c.id) return '';
        const resp = await CoreAPI.apiRequest(`/chats/${encodeURIComponent(c.id)}`);
        if (!resp.ok) return '';
        let msgs = (await resp.json()).messages;
        if (!Array.isArray(msgs)) return '';
        msgs = msgs.filter(m => m && m.role !== 'system' && (m.content || '').trim());
        const s = c.scope || { mode: 'all' };
        if (s.mode === 'last') msgs = msgs.slice(-Math.max(1, s.n || AI_SRC_LASTN_DEFAULT));
        else if (s.mode === 'range') {
            const from = Math.max(1, s.from || 1);
            const to = Math.max(from, s.to || msgs.length);
            msgs = msgs.slice(from - 1, to);
        }
        if (!msgs.length) return '';
        const lines = msgs.map(m => `${m.name || (m.role === 'user' ? 'User' : c.charName)}: ${(m.content || '').replace(/\s+/g, ' ').trim()}`);
        let body = lines.join('\n');
        if (body.length > AI_SRC_CHAT_CAP) body = body.slice(-AI_SRC_CHAT_CAP); // keep the most recent within the cap
        return `## Chat: ${c.name} (${c.charName})\n${body}`;
    } catch { return ''; }
}

function aiResolveSource() {
    if (aiSourceMode === 'paste') return (document.getElementById('lbAiPasteText')?.value || '').trim();
    return (aiFetchedText || '').trim();
}

async function aiDoGenerate() {
    if (aiGenerating) { aiGenAbort?.abort(); return; }
    // Source presence check (library source is built async below, so just check the selection).
    if (aiSourceMode === 'library') {
        if (!srcSelChars.size && !srcSelChats.size) { CoreAPI.showToast('Pick characters or chats first', 'warning'); aiGlowMissingSource(); return; }
    } else if (!aiResolveSource()) {
        CoreAPI.showToast('Add some source material first', 'warning'); aiGlowMissingSource(); return;
    }

    const instructions = (document.getElementById('lbAiInstructions')?.value || '').trim();
    const maxRaw = parseInt(document.getElementById('lbAiMaxEntries')?.value, 10);
    const maxEntries = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(maxRaw, 100) : 0;

    // stagingTarget was resolved from the launch point in aiOpenGenerate().
    let newName = '';
    if (stagingTarget === 'new') {
        newName = sanitizeWorldName(document.getElementById('lbAiNewName')?.value || '');
        if (!newName) { CoreAPI.showToast('Enter a name for the new lorebook', 'warning'); document.getElementById('lbAiNewName')?.focus(); return; }
        if (worldsList.some(w => w.file_id.toLowerCase() === newName.toLowerCase())) { CoreAPI.showToast('A lorebook with that name already exists', 'warning'); return; }
    } else if (!currentWorld) {
        CoreAPI.showToast('No lorebook open to add to; choose "New lorebook"', 'warning'); return;
    }
    stagingNewName = newName;

    const maxContext = aiCurrentMaxContext();
    CoreAPI.setSetting('lorebook_aiMaxContext', maxContext); // remember the budget for next time

    aiGenerating = true;
    aiGenAbort = new AbortController();
    const signal = aiGenAbort.signal;
    const btn = document.getElementById('lbAiGenerateBtn');
    // Stays enabled so a second click aborts (handled by the guard at the top).
    if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Stop';
    let batches = [];
    let multi = false;
    let completed = 0;
    const setBtn = () => {
        if (!btn) return;
        btn.innerHTML = multi
            ? `<i class="fa-solid fa-spinner fa-spin"></i> Stop (${completed}/${batches.length})`
            : '<i class="fa-solid fa-spinner fa-spin"></i> Stop';
    };

    // the cap is asked of a single request only; batches are sliced to maxEntries at the end
    const buildMsg = (batchBlocks) => {
        const constraints = (maxEntries && !multi) ? `Produce at most ${maxEntries} entries.\n\n` : '';
        return `${instructions ? `Instructions:\n${instructions}\n\n` : ''}${constraints}SOURCE MATERIAL:\n${batchBlocks.join('\n\n')}`;
    };

    try {
        let sourceBlocks;
        if (aiSourceMode === 'library') {
            sourceBlocks = await aiBuildSrcContextBlocks(signal);
        } else if (aiSourceMode === 'url' && aiCategoryBlocks?.length) {
            sourceBlocks = aiCategoryBlocks;
        } else {
            sourceBlocks = [aiResolveSource()];
        }
        if (signal.aborted) { CoreAPI.showToast('Generation cancelled', 'info'); return; }
        if (!sourceBlocks.length) { CoreAPI.showToast('Could not read the selected sources. Try again.', 'warning'); return; }
        aiLastGen = { source: sourceBlocks.join('\n\n'), instructions };
        batches = aiSplitBlocksIntoBatches(sourceBlocks, maxContext);
        multi = batches.length > 1;
        setBtn();

        // Bounded concurrency: process all batches but cap simultaneous requests so a low
        // context budget (many batches) doesn't hammer the provider or trip rate limits.
        const settled = new Array(batches.length);
        let nextBatch = 0;
        const runOne = async () => {
            while (nextBatch < batches.length && !signal.aborted) {
                const i = nextBatch++;
                try {
                    const raw = await aiCallLLM(
                        [{ role: 'system', content: AI_GEN_SYSTEM }, { role: 'user', content: buildMsg(batches[i]) }],
                        { signal, maxTokens: AI_GEN_MAX_TOKENS, temperature: 0.7 },
                    );
                    const parsed = aiParseJsonArray(raw) || [];
                    // no closing ']' means the output hit the token cap; say so, so an undercount reads as truncation
                    const truncated = !/]\s*(?:```)?\s*$/.test(String(raw).trim());
                    CoreAPI.debugLog(`[Lorebooks AI] batch ${i + 1}/${batches.length}: ${batches[i].length} pages -> ${parsed.length} entries${truncated ? ' (OUTPUT TRUNCATED at the token cap)' : ''}`);
                    settled[i] = { status: 'fulfilled', value: parsed };
                } catch (e) {
                    settled[i] = { status: 'rejected', reason: e };
                }
                completed++; setBtn();
            }
        };
        await Promise.all(Array.from({ length: Math.min(AI_GEN_CONCURRENCY, batches.length) }, runOne));
        if (signal.aborted) { CoreAPI.showToast('Generation cancelled', 'info'); return; }

        let natives = [];
        let failed = 0;
        let firstErr = null;
        for (const r of settled) {
            if (r.status === 'rejected') { failed++; firstErr = firstErr || r.reason; continue; }
            natives.push(...r.value.map((x, i) => aiEntryToNative(x || {}, natives.length + i)).filter(aiEntryUsable));
        }
        natives = aiDedupeEntries(natives);
        if (maxEntries) natives = natives.slice(0, maxEntries);

        if (!natives.length) {
            if (failed === batches.length) {
                CoreAPI.showToast(firstErr?.message || 'The model did not return usable entries. Try again or adjust your instructions.', 'error', 7000);
            } else {
                CoreAPI.showToast('No usable entries were generated. Try again.', 'warning');
            }
            return;
        }

        stagingEntries = natives.map(e => ({ id: ++stagingSeq, e, include: true }));
        document.getElementById('lbAiGenerateModal')?.classList.remove('visible');
        aiOpenStaging();
        if (failed) CoreAPI.showToast(`${failed} of ${batches.length} batches failed; showing partial results.`, 'warning', 6000);
    } catch (e) {
        const msg = e?.message || String(e);
        if (/cancel/i.test(msg)) CoreAPI.showToast('Generation cancelled', 'info');
        else CoreAPI.showToast(msg, 'error', 7000);
    } finally {
        aiGenerating = false;
        aiGenAbort = null;
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate'; }
    }
}

// Drop entries whose title + first key collide (a model occasionally repeats across batches).
function aiDedupeEntries(natives) {
    const seen = new Set();
    const out = [];
    for (const e of natives) {
        const firstKey = (Array.isArray(e.key) && e.key[0] ? e.key[0] : '').toString().trim().toLowerCase();
        const sig = `${(e.comment || '').trim().toLowerCase()}|${firstKey}`;
        if (sig === '|') { out.push(e); continue; } // no title/key to compare on, keep it
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push(e);
    }
    return out;
}

// ========================================
// AI: STAGING TRAY (review before commit)
// ========================================

function aiOpenStaging() {
    aiBuildModals();
    stagingFilter = '';
    stagingExpanded = new Set();
    // Small batches open expanded for immediate review; large ones stay collapsed and scannable.
    if (stagingEntries.length <= 5) stagingEntries.forEach(s => stagingExpanded.add(s.id));
    const filterEl = document.getElementById('lbAiStageFilter');
    if (filterEl) filterEl.value = '';
    aiRenderStaging();
    document.getElementById('lbAiStagingModal').classList.add('visible');
}

function aiCloseStaging() {
    if (!stagingEntries.length) { aiForceCloseStaging(); return; }
    const n = stagingEntries.length;
    CoreAPI.showConfirm({
        title: 'Discard generated entries?',
        message: `You have ${n} generated entr${n === 1 ? 'y' : 'ies'} that haven't been added yet. Discard them?`,
        confirmLabel: 'Discard',
        cancelLabel: 'Keep',
        danger: true,
    }).then(ok => { if (ok) aiForceCloseStaging(); });
}

function aiForceCloseStaging() {
    document.getElementById('lbAiStagingModal')?.classList.remove('visible');
}

function aiStagingSelectedCount() { return stagingEntries.filter(s => s.include).length; }

function aiUpdateStagingCount() {
    const el = document.getElementById('lbAiStagingCount');
    if (el) el.textContent = `${aiStagingSelectedCount()} of ${stagingEntries.length} selected`;
    const commit = document.getElementById('lbAiStageCommit');
    if (commit) commit.disabled = aiStagingSelectedCount() === 0;
    aiUpdateStageToggleSelect();
}

// Master select/deselect-all toggle reflects whether every filtered entry is included.
function aiUpdateStageToggleSelect() {
    const btn = document.querySelector('[data-action="stage-toggle-select"]');
    if (!btn) return;
    const visible = aiVisibleStaging();
    const allSel = visible.length > 0 && visible.every(s => s.include);
    btn.title = allSel ? 'Deselect all' : 'Select all';
    btn.innerHTML = `<i class="fa-solid ${allSel ? 'fa-square-minus' : 'fa-square-check'}"></i>`;
}

// Master expand/collapse-all toggle reflects whether every filtered entry is expanded.
function aiUpdateStageToggleAll() {
    const btn = document.querySelector('[data-action="stage-toggle-all"]');
    if (!btn) return;
    const visible = aiVisibleStaging();
    const allExp = visible.length > 0 && visible.every(s => stagingExpanded.has(s.id));
    btn.title = allExp ? 'Collapse all' : 'Expand all';
    btn.innerHTML = `<i class="fa-solid ${allExp ? 'fa-up-right-and-down-left-from-center' : 'fa-down-left-and-up-right-to-center fa-rotate-90'}"></i>`;
}

// Entries matching the current filter (title or any key). Bulk actions operate on this set.
function aiVisibleStaging() {
    const q = stagingFilter.trim().toLowerCase();
    if (!q) return stagingEntries;
    return stagingEntries.filter(s => {
        const keys = Array.isArray(s.e.key) ? s.e.key.join(' ') : '';
        return (s.e.comment || '').toLowerCase().includes(q) || keys.toLowerCase().includes(q);
    });
}

// First few keys as compact pills (with a +N overflow), or a muted "no keys".
function aiStageKeyPills(keysArr) {
    if (!keysArr.length) return '<span class="lb-stage-nokeys"><i class="fa-solid fa-key"></i> no keys</span>';
    const shown = keysArr.slice(0, 5);
    const extra = keysArr.length - shown.length;
    return shown.map(k => `<span class="lb-stage-keypill">${esc(k)}</span>`).join('')
        + (extra > 0 ? `<span class="lb-stage-keypill lb-stage-keypill-more">+${extra}</span>` : '');
}

// One review card: a collapsible entry mirroring the main editor's lb-entry.
function aiStageCardHtml(s) {
    const e = s.e;
    const expanded = stagingExpanded.has(s.id);
    const keysArr = Array.isArray(e.key) ? e.key : [];
    const keys = keysArr.join(', ');
    const hasTitle = !!(e.comment && e.comment.trim());
    const titleHtml = hasTitle
        ? `<span class="lb-entry-title">${esc(e.comment)}</span>`
        : `<span class="lb-entry-title lb-stage-untitled">Untitled entry</span>`;
    const flat = (e.content || '').replace(/\s+/g, ' ').trim();
    const snippet = flat ? `${esc(flat.slice(0, 140))}${flat.length > 140 ? '…' : ''}` : '';
    return `
    <div class="lb-entry lb-stage-card${expanded ? ' expanded' : ''}${s.include ? '' : ' lb-stage-excluded'}" data-sid="${s.id}">
        <div class="lb-entry-head" data-action="stage-expand" data-sid="${s.id}">
            <label class="lb-switch" data-stop title="${s.include ? 'Included (toggle to exclude)' : 'Excluded (toggle to include)'}">
                <input type="checkbox" data-action="stage-toggle" data-sid="${s.id}" ${s.include ? 'checked' : ''}>
                <span class="lb-switch-track"></span>
            </label>
            <div class="lb-entry-summary">
                <div class="lb-entry-title-line">
                    ${titleHtml}
                    ${e.constant ? '<span class="lb-badge constant" title="Constant: always on"><i class="fa-solid fa-anchor"></i></span>' : ''}
                </div>
                <div class="lb-entry-sub lb-stage-keyrow" title="${esc(keys)}">${aiStageKeyPills(keysArr)}</div>
                ${!expanded && snippet ? `<div class="lb-stage-snippet">${snippet}</div>` : ''}
            </div>
            <div class="lb-entry-head-actions">
                <button class="lb-icon-btn small" data-action="stage-regen" data-sid="${s.id}" data-stop title="Regenerate this entry"><i class="fa-solid fa-rotate"></i></button>
                <button class="lb-icon-btn small danger" data-action="stage-del" data-sid="${s.id}" data-stop title="Discard this entry"><i class="fa-solid fa-trash"></i></button>
                <i class="fa-solid fa-chevron-down lb-entry-chevron${expanded ? ' open' : ''}"></i>
            </div>
        </div>
        ${expanded ? `
        <div class="lb-entry-body lb-stage-body">
            <input type="search" class="lb-ai-stage-title" data-sf="comment" data-sid="${s.id}" value="${esc(e.comment)}" placeholder="Title" autocomplete="one-time-code">
            <div class="lb-ai-stage-keys-row">
                <i class="fa-solid fa-key"></i>
                <input type="search" class="lb-ai-stage-keys" data-sf="key" data-sid="${s.id}" value="${esc(keys)}" placeholder="comma, separated, keys" autocomplete="one-time-code">
            </div>
            <textarea class="lb-ai-stage-content" data-sf="content" data-sid="${s.id}" rows="5" placeholder="Content">\n${esc(e.content)}</textarea>
        </div>` : ''}
    </div>`;
}

// Re-render a single card in place (expand/collapse) without rebuilding the whole list.
function aiRefreshStageCard(sid) {
    const s = aiStageRow(sid);
    const card = document.querySelector(`.lb-stage-card[data-sid="${sid}"]`);
    if (s && card) card.outerHTML = aiStageCardHtml(s);
    aiUpdateStageToggleAll();
}

function aiRenderStaging() {
    const sub = document.getElementById('lbAiStagingSub');
    if (sub) {
        const destIcon = stagingTarget === 'new' ? 'fa-book-medical' : 'fa-book';
        const destName = stagingTarget === 'new' ? stagingNewName : currentWorld;
        const n = stagingEntries.length;
        sub.innerHTML = `<span>${n} entr${n === 1 ? 'y' : 'ies'} generated. Review and edit, then add the selected ones to</span> <span class="lb-meta-pill"><i class="fa-solid ${destIcon}"></i> ${esc(destName || '')}</span>`;
    }
    const listEl = document.getElementById('lbAiStagingList');
    if (!listEl) return;
    if (!stagingEntries.length) { listEl.innerHTML = `<div class="lb-link-empty">No entries left.</div>`; aiUpdateStagingCount(); aiUpdateStageToggleAll(); return; }
    const visible = aiVisibleStaging();
    if (!visible.length) { listEl.innerHTML = `<div class="lb-link-empty">No entries match "${esc(stagingFilter)}".</div>`; aiUpdateStagingCount(); aiUpdateStageToggleAll(); return; }
    listEl.innerHTML = visible.map(aiStageCardHtml).join('');
    aiUpdateStagingCount();
    aiUpdateStageToggleAll();
}

function aiStageRow(sid) { return stagingEntries.find(s => s.id === Number(sid)); }

function aiStageEdit(sid, field, value) {
    const row = aiStageRow(sid);
    if (!row) return;
    if (field === 'key') {
        row.e.key = value.split(',').map(s => s.trim()).filter(Boolean);
    } else if (field === 'comment') {
        row.e.comment = value;
        row.e.addMemo = !!value.trim();
    } else if (field === 'content') {
        row.e.content = value;
    }
}

// a regen's source: the matching member block of a batched category source, else a bounded slice
function aiRegenSource(subject) {
    const full = aiLastGen?.source || '';
    if (Array.isArray(aiCategoryBlocks) && aiCategoryBlocks.length) {
        const subj = (subject || '').trim().toLowerCase();
        if (subj) {
            const match = aiCategoryBlocks.find(b => {
                const head = (b.split('\n', 1)[0] || '').replace(/^#+\s*/, '').trim().toLowerCase();
                return head && (head === subj || head.includes(subj) || subj.includes(head));
            });
            if (match) return match.slice(0, AI_GEN_MAX_CONTEXT);
        }
        return full.slice(0, AI_GEN_MAX_CONTEXT);
    }
    return full;
}

async function aiRegenStageRow(sid) {
    const row = aiStageRow(sid);
    if (!row || !aiLastGen) return;
    const btn = document.querySelector(`.lb-stage-card[data-sid="${sid}"] [data-action="stage-regen"]`);
    if (btn) { btn.disabled = true; btn.querySelector('i')?.classList.add('fa-spin'); }
    try {
        const subject = row.e.comment || (row.e.key || []).join(', ') || 'this subject';
        const regenSource = aiRegenSource(subject);
        const userMsg = `${aiLastGen.instructions ? `Instructions:\n${aiLastGen.instructions}\n\n` : ''}From the SOURCE below, produce ONE improved World Info entry for: ${subject}. Return a JSON array containing exactly one entry object.\n\nSOURCE MATERIAL:\n${regenSource}`;
        const raw = await aiCallLLM(
            [{ role: 'system', content: AI_GEN_SYSTEM }, { role: 'user', content: userMsg }],
            { maxTokens: 2000 },
        );
        const arr = aiParseJsonArray(raw);
        if (arr && arr[0]) {
            const fresh = aiEntryToNative(arr[0], row.e.uid);
            if (aiEntryUsable(fresh)) { row.e = fresh; aiRenderStaging(); CoreAPI.showToast('Regenerated', 'success'); return; }
        }
        CoreAPI.showToast('Could not regenerate that entry', 'warning');
    } catch (e) {
        CoreAPI.showToast(e?.message || 'Regenerate failed', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.querySelector('i')?.classList.remove('fa-spin'); }
    }
}

async function aiCommitStaging() {
    const selected = stagingEntries.filter(s => s.include);
    if (!selected.length) return;

    if (stagingTarget === 'new') {
        const name = stagingNewName;
        if ((await takenWorldIds()).has(name.toLowerCase())) { CoreAPI.showToast('That name now exists; rename and retry', 'warning'); return; }
        const made = await CoreAPI.createWorldInfoData(name, { entries: {} });
        if (made === 'exists') { CoreAPI.showToast('That name now exists; rename and retry', 'warning'); return; }
        if (made !== 'created') { CoreAPI.showToast('Could not create the lorebook', 'error'); return; }
        await refreshList();
        // selectWorld's unsaved-edits guard can cancel the switch: then abort, never append to the wrong copy
        await selectWorld(name);
        if (currentWorld !== name) { CoreAPI.showToast('Switch cancelled; entries not added', 'info'); return; }
    } else if (!currentWorld || !workingWorld) {
        CoreAPI.showToast('No lorebook open to add to', 'error'); return;
    }

    if (!workingWorld) { CoreAPI.showToast('Could not open the target lorebook', 'error'); return; }
    if (!workingWorld.entries) workingWorld.entries = {};

    let added = 0;
    for (const s of selected) {
        const uid = nextUid();
        s.e.uid = uid;
        s.e.displayIndex = uid;
        workingWorld.entries[uid] = s.e;
        added++;
    }
    markDirty();
    updateSaveButton();
    setEditingMode(true);
    renderEditor();
    stagingEntries = []; // committed; clear so the close guard sees a clean tray
    aiForceCloseStaging();
    CoreAPI.showToast(`Added ${added} entr${added === 1 ? 'y' : 'ies'} to "${currentWorld}". Review and Save to apply.`, 'success', 5000);
}

// ========================================
// AI: MODAL EVENT WIRING (one-time)
// ========================================

function aiAttachModalEvents() {
    document.getElementById('lbAiGenClose')?.addEventListener('click', aiCloseGenerate);
    document.getElementById('lbAiGenCancel')?.addEventListener('click', aiCloseGenerate);
    document.getElementById('lbAiGenerateModal')?.addEventListener('click', (e) => { if (e.target.id === 'lbAiGenerateModal') aiCloseGenerate(); });
    document.getElementById('lbAiGenerateBtn')?.addEventListener('click', aiDoGenerate);
    document.getElementById('lbAiFetchBtn')?.addEventListener('click', aiFetchUrl);
    document.getElementById('lbAiUrlInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); aiFetchUrl(); } });
    document.getElementById('lbAiSrcSearch')?.addEventListener('input', () => aiSrcRefresh());
    document.querySelectorAll('.lb-ai-src-mode').forEach(b => b.addEventListener('click', () => aiSetSrcMode(b.dataset.mode)));
    document.getElementById('lbAiSrcTray')?.addEventListener('click', (e) => {
        const rmChar = e.target.closest('[data-action="st-remove-char"]');
        if (rmChar) { aiToggleSrcChar(rmChar.dataset.charId); return; }
        const rmChat = e.target.closest('[data-action="st-remove-chat"]');
        if (rmChat) { aiToggleSrcChat(rmChat.dataset.key); return; }
        const scope = e.target.closest('[data-action="st-scope"]');
        if (scope) { aiSrcSetScopeMode(scope.dataset.key, scope.dataset.scope); return; }
        const fld = e.target.closest('[data-action="st-field"]');
        if (fld) { aiSrcToggleField(fld.dataset.charId, fld.dataset.field); return; }
    });
    document.getElementById('lbAiSrcTray')?.addEventListener('input', (e) => {
        const el = e.target.closest('[data-action^="st-scope-"]');
        if (!el) return;
        const field = el.dataset.action === 'st-scope-n' ? 'n' : el.dataset.action === 'st-scope-from' ? 'from' : 'to';
        aiSrcSetScopeNum(el.dataset.key, field, el.value);
    });
    document.querySelectorAll('.lb-ai-src-opt').forEach(b => b.addEventListener('click', () => aiSetSourceMode(b.dataset.mode)));
    document.getElementById('lbAiSrcList')?.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="st-src-retry"]')) { aiSrcRefresh(); return; }
        const charRow = e.target.closest('[data-action="st-pick-char"]');
        if (charRow) { aiToggleSrcChar(charRow.dataset.charId); return; }
        const chatRow = e.target.closest('[data-action="st-pick-chat"]');
        if (chatRow) { aiToggleSrcChat(chatRow.dataset.key); return; }
    });

    document.getElementById('lbAiCatLoad')?.addEventListener('click', aiLoadCategorySelection);
    document.getElementById('lbAiCatSearch')?.addEventListener('input', aiRenderCatPanel);
    // Context budget drives batch count + token-per-request, so refresh the load line + hint live.
    document.getElementById('lbAiMaxContext')?.addEventListener('input', () => {
        aiRenderCtxHint();
        if (aiCategoryPages) aiRenderCatLoadInfo();
    });
    document.getElementById('lbAiCatList')?.addEventListener('change', (e) => {
        const cb = e.target.closest('input[data-cat-title]');
        if (!cb || !aiCategoryMembers) return;
        const m = aiCategoryMembers.find(x => x.title === cb.dataset.catTitle);
        if (m) { m.selected = cb.checked; aiRenderCatPanel(); }
    });
    document.getElementById('lbAiCatPanel')?.addEventListener('click', (e) => {
        const act = e.target.closest('[data-action]')?.dataset.action;
        if (act === 'cat-toggle-select') {
            const allSel = aiCategoryMembers?.length && aiCategoryMembers.every(m => m.selected);
            aiCategoryMembers?.forEach(m => { m.selected = !allSel; });
            aiRenderCatPanel();
        } else if (act === 'cat-detail') {
            aiSetPageDetail(e.target.closest('[data-action]').dataset.detail);
        }
    });

    document.getElementById('lbAiStageClose')?.addEventListener('click', aiCloseStaging);
    document.getElementById('lbAiStagingModal')?.addEventListener('click', (e) => { if (e.target.id === 'lbAiStagingModal') aiCloseStaging(); });
    document.getElementById('lbAiStageBack')?.addEventListener('click', () => { aiForceCloseStaging(); document.getElementById('lbAiGenerateModal')?.classList.add('visible'); });
    document.getElementById('lbAiStageCommit')?.addEventListener('click', aiCommitStaging);
    const stageList = document.getElementById('lbAiStagingList');
    stageList?.addEventListener('click', (e) => {
        const actionEl = e.target.closest('[data-action]');
        if (!actionEl) return;
        const action = actionEl.dataset.action;
        const sid = Number(actionEl.dataset.sid);
        if (action === 'stage-regen') { aiRegenStageRow(sid); return; }
        if (action === 'stage-del') { stagingExpanded.delete(sid); stagingEntries = stagingEntries.filter(s => s.id !== sid); aiRenderStaging(); return; }
        if (action === 'stage-expand') {
            if (e.target.closest('[data-stop]')) return; // the switch + head buttons don't toggle expand
            if (stagingExpanded.has(sid)) stagingExpanded.delete(sid); else stagingExpanded.add(sid);
            aiRefreshStageCard(sid);
        }
    });
    stageList?.addEventListener('change', (e) => {
        const toggle = e.target.closest('[data-action="stage-toggle"]');
        if (!toggle) return;
        const r = aiStageRow(toggle.dataset.sid);
        if (r) { r.include = toggle.checked; e.target.closest('.lb-stage-card')?.classList.toggle('lb-stage-excluded', !r.include); aiUpdateStagingCount(); }
    });
    stageList?.addEventListener('input', (e) => {
        const field = e.target.dataset.sf;
        if (field) aiStageEdit(e.target.dataset.sid, field, e.target.value);
    });
    document.getElementById('lbAiStageFilter')?.addEventListener('input', (e) => { stagingFilter = e.target.value; aiRenderStaging(); });
    // Two master toggles (selection + expansion), each acting on the filtered set so they
    // compose with the filter box.
    document.querySelector('[data-action="stage-toggle-select"]')?.addEventListener('click', () => {
        const visible = aiVisibleStaging();
        const allSel = visible.length > 0 && visible.every(s => s.include);
        visible.forEach(s => { s.include = !allSel; });
        aiRenderStaging();
    });
    document.querySelector('[data-action="stage-toggle-all"]')?.addEventListener('click', () => {
        const visible = aiVisibleStaging();
        const allExpanded = visible.length > 0 && visible.every(s => stagingExpanded.has(s.id));
        visible.forEach(s => allExpanded ? stagingExpanded.delete(s.id) : stagingExpanded.add(s.id));
        aiRenderStaging();
    });

}

// ========================================
// LIFECYCLE
// ========================================

function init() {
    if (isInitialized) return;
    isInitialized = true;

    // Register overlays so Escape and Android back close them (picker first, then manager).
    if (!eventsAttached) {
        eventsAttached = true;
        window.registerOverlay?.({
            id: 'lbLinkModal',
            tier: 6,
            close: () => closeLinkPicker(),
            visible: (el) => el.classList.contains('visible'),
        });
        // AI leaf modals close before the link picker / manager (lower tier closes first).
        window.registerOverlay?.({
            id: 'lbAiStagingModal',
            tier: 4,
            close: () => aiCloseStaging(),
            visible: (el) => el.classList.contains('visible'),
        });
        window.registerOverlay?.({
            id: 'lbAiGenerateModal',
            tier: 5,
            close: () => aiCloseGenerate(),
            visible: (el) => el.classList.contains('visible'),
        });
        window.registerOverlay?.({
            id: 'lorebookModal',
            tier: 7,
            close: () => handleModalBack(),
        });
    }
    document.addEventListener('cl-worlds-changed', (e) => { void onWorldsChangedElsewhere(e); });
    CoreAPI.onCharactersDeleted((ids) => { void onCharactersDeleted(ids); });
    // An entry verb registered or removed while entries are open lands in their strips at once.
    document.addEventListener(EXT_ACTION_EVENT, onEntryActsChanged);
    // every way the app opens the manager runs it, so an extension can run and wrap it too
    defineCommand('lorebook.open', openLorebookFrom, { title: 'Open a lorebook' });

    CoreAPI.debugLog('[Lorebooks] Module initialized');
}

export { openModal, closeModal };

export default {
    init,
    openModal,
};
