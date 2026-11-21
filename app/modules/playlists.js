import CoreAPI from './core-api.js';
import { registerFeedPatcher } from './feed.js';

const esc = (s) => CoreAPI.escapeHtml(s);

// ========================================
// PLAYLISTS MODULE
// ========================================

const STORAGE_VERSION = 1;

let playlistsData = null;   // { version, playlists: {}, order: [] }, the server's playlists with their counts
let loaded = false;

// ========================================
// STORAGE LAYER
// ========================================

// the model is the server's playlists with counts; a write adopts the row the server answers. Membership is never held here
async function readPlaylistsDoc() {
    const resp = await CoreAPI.apiRequest('/playlists', 'GET');
    if (!resp.ok) throw new Error(`Playlist read failed (${resp.status})`);
    return resp.json();
}

function createEmptyData() {
    return { version: STORAGE_VERSION, playlists: {}, order: [] };
}

let _loadingPromise = null;

async function loadPlaylists() {
    if (loaded) return playlistsData;
    if (_loadingPromise) return _loadingPromise;
    _loadingPromise = (async () => {
        // only a definitive read becomes the model: any failure is transient, and an unread model would edit emptiness
        try {
            const data = await readPlaylistsDoc();
            if (data && data.version && data.playlists) {
                playlistsData = data;
                const ids = Object.keys(data.playlists);
                const orderSet = new Set(data.order || []);
                for (const id of ids) {
                    if (!orderSet.has(id)) {
                        playlistsData.order.push(id);
                    }
                }
                playlistsData.order = playlistsData.order.filter(id => data.playlists[id]);
            } else {
                playlistsData = createEmptyData();
            }
            loaded = true;
        } catch (e) {
            console.warn('[Playlists] Load failed, editing disabled until a read succeeds:', e.message);
        }
        _loadingPromise = null;
        return playlistsData;
    })();
    return _loadingPromise;
}

// Mutators bail through this so a failed load can never be edited as if it were empty.
function playlistsUnavailable() {
    if (playlistsData) return false;
    CoreAPI.showToast('Playlists could not be read from the server; editing is disabled until they are', 'error');
    return true;
}

// Writes and re-reads run one at a time, so the model always adopts an answer at least as new as
// the one before it.
let _serial = Promise.resolve();
function serial(fn) {
    const run = _serial.then(fn, fn);
    _serial = run.catch(() => { /* the chain only orders the calls; each caller reads its own failure */ });
    return run;
}

async function playlistRequest(path, method, body) {
    return CoreAPI.readAnswer(await CoreAPI.apiRequest(path, method, body));
}

// The row the server stored, as the document holds it.
function adoptPlaylist(row) {
    const { id, ...entry } = row;
    if (!playlistsData.playlists[id]) playlistsData.order.push(id);
    playlistsData.playlists[id] = entry;
}

function reportFailure(e, what) {
    if (e.status === 404) {
        CoreAPI.showToast('That playlist was deleted elsewhere', 'info');
        void reloadPlaylists();
    } else if (e.status === 409) {
        CoreAPI.showToast(e.message.charAt(0).toUpperCase() + e.message.slice(1), 'warning');
    } else {
        CoreAPI.showToast(`Could not ${what}: ${e.message}`, 'error');
    }
}

// ========================================
// CRUD OPERATIONS
// ========================================

async function createPlaylist(name, description = '') {
    await loadPlaylists();
    if (playlistsUnavailable()) return null;
    return serial(async () => {
        try {
            const row = await playlistRequest('/playlists', 'POST', { name, description });
            adoptPlaylist(row);
            return row.id;
        } catch (e) {
            reportFailure(e, 'create the playlist');
            return null;
        }
    });
}

async function deletePlaylist(uid) {
    await loadPlaylists();
    if (playlistsUnavailable()) return false;
    if (!playlistsData.playlists[uid]) return false;
    return serial(async () => {
        try {
            await playlistRequest(`/playlists/${encodeURIComponent(uid)}`, 'DELETE');
        } catch (e) {
            // already gone elsewhere: let go of it all the same
            if (e.status !== 404) { reportFailure(e, 'delete the playlist'); return false; }
        }
        delete playlistsData.playlists[uid];
        playlistsData.order = playlistsData.order.filter(id => id !== uid);
        CoreAPI.forgetPlaylistOnRows(uid);
        // drop the filter if it was pointing here, plus repaint badges/sidebar
        CoreAPI.refreshPlaylistFilterIfActive(uid);
        CoreAPI.refreshPlaylistBadges();
        return true;
    });
}

async function updatePlaylist(uid, updates) {
    await loadPlaylists();
    if (playlistsUnavailable()) return false;
    if (!playlistsData.playlists[uid]) return false;
    const patch = {};
    for (const key of ['name', 'description', 'icon', 'color']) if (updates[key] !== undefined) patch[key] = updates[key];
    return serial(async () => {
        try {
            adoptPlaylist(await playlistRequest(`/playlists/${encodeURIComponent(uid)}`, 'PATCH', patch));
        } catch (e) {
            reportFailure(e, 'save the playlist');
            return false;
        }
        // the name shows in the filter label, the name, icon and colour on the chips and badges
        if (patch.name !== undefined) CoreAPI.refreshPlaylistFilterIfActive(uid, { members: false });
        CoreAPI.refreshPlaylistBadges();
        return true;
    });
}

// The server takes at most this many ids an apply; a larger selection goes in chunks, in order, each one write
const APPLY_CHUNK = 10000;

function applyChunks(delta) {
    const parts = [];
    for (const side of ['add', 'remove']) {
        const ids = delta[side] || [];
        for (let at = 0; at < ids.length; at += APPLY_CHUNK) parts.push({ [side]: ids.slice(at, at + APPLY_CHUNK) });
    }
    return parts;
}

async function applyMembers(uid, delta, what) {
    await loadPlaylists();
    if (playlistsUnavailable()) return null;
    if (!playlistsData.playlists[uid]) return null;
    return serial(async () => {
        const answer = { added: [], removed: [], skipped: [], playlist: null };
        let failed = null;
        for (const part of applyChunks(delta)) {
            try {
                const got = await playlistRequest(`/playlists/${encodeURIComponent(uid)}/members/apply`, 'POST', part);
                for (const key of ['added', 'removed', 'skipped']) for (const id of got[key]) answer[key].push(id);
                answer.playlist = got.playlist;
            } catch (e) {
                failed = e;
                break;
            }
        }
        // what the chunks before a refused one wrote stands, so it is shown before the refusal is said
        if (answer.playlist) adoptPlaylist(answer.playlist);
        if (answer.added.length || answer.removed.length) {
            CoreAPI.adoptPlaylistMembership(uid, answer.added, answer.removed);
            CoreAPI.refreshPlaylistFilterIfActive(uid);
            CoreAPI.refreshPlaylistBadges();
        }
        if (failed) {
            reportFailure(failed, what);
            return null;
        }
        return answer;
    });
}

async function addToPlaylist(uid, charIds) {
    const answer = await applyMembers(uid, { add: charIds }, 'add to the playlist');
    return answer ? answer.added.length : false;
}

async function removeFromPlaylist(uid, charIds) {
    const answer = await applyMembers(uid, { remove: charIds }, 'remove from the playlist');
    return answer ? answer.removed.length : false;
}

/**
 * A Select All's membership write: a chunked server job followed to its end, then the held rows re-read.
 * @param {'add'|'remove'} op
 * @returns {Promise<{changed: number, total: number, stopped?: true}|null>} changed: memberships that moved; null when it did not land
 */
async function applyMembersByFilter(uid, filter, op) {
    await loadPlaylists();
    if (playlistsUnavailable()) return null;
    if (!playlistsData.playlists[uid]) return null;
    return serial(async () => {
        const what = op === 'add' ? 'add to the playlist' : 'remove from the playlist';
        let job;
        try {
            const answer = await playlistRequest(`/playlists/${encodeURIComponent(uid)}/members/apply`, 'POST', { filter, op });
            job = await CoreAPI.followJob(answer.job);
        } catch (e) {
            reportFailure(e, what);
            return null;
        }
        const out = job.result || {};
        if (out.playlist) adoptPlaylist(out.playlist);
        if (out.changed) {
            await CoreAPI.refreshCharacters(true, { held: true });
            CoreAPI.refreshPlaylistFilterIfActive(uid);
            CoreAPI.refreshPlaylistBadges();
        }
        if (job.status === 'failed') {
            reportFailure(new Error(job.error || 'the job failed'), what);
            return null;
        }
        return { changed: out.changed || 0, total: job.total, ...(job.status === 'stopped' ? { stopped: true } : {}) };
    });
}

// ========================================
// CHANGES MADE ELSEWHERE
// ========================================

// Another tab, device or process changed playlists: re-read the set in turn with this tab's
// own writes, then repaint what shows it.
function reloadPlaylists() {
    return serial(async () => {
        const before = playlistsData ? Object.keys(playlistsData.playlists) : [];
        loaded = false;
        await loadPlaylists();
        if (!playlistsData) return;
        // a filter pointing at a playlist that changed re-asks, one pointing at a deleted one drops
        for (const id of new Set([...before, ...Object.keys(playlistsData.playlists)])) CoreAPI.refreshPlaylistFilterIfActive(id);
        CoreAPI.refreshPlaylistBadges();
        if (document.getElementById('playlistPickerModal')?.classList.contains('visible')) await repaintPicker();
        // never under a rename being typed
        const manage = document.getElementById('playlistManageModal');
        if (manage?.classList.contains('visible') && !document.activeElement?.classList?.contains('pl-manage-name')) renderManageList();
    });
}

// ========================================
// QUERY FUNCTIONS
// ========================================

function getAllPlaylists() {
    if (!playlistsData) return [];
    return playlistsData.order
        .filter(id => playlistsData.playlists[id])
        .map(id => ({ uid: id, ...playlistsData.playlists[id] }));
}

function getPlaylist(uid) {
    if (!playlistsData?.playlists[uid]) return null;
    return { uid, ...playlistsData.playlists[uid] };
}

const MEMBERS_PAGE = 10000;

// The members in the playlist's order, read a page at a time, then resolved to rows (deleted
// characters drop out).
async function getPlaylistCharacters(uid) {
    if (!playlistsData?.playlists[uid]) return [];
    const ids = await CoreAPI.fetchAllPages(`/playlists/${encodeURIComponent(uid)}/members`, {}, { pageSize: MEMBERS_PAGE, key: 'ids' });
    return CoreAPI.fetchCharactersByIds(ids);
}

// The playlists a character is in, off its row, in the library's playlist order.
function getPlaylistsForChar(charId) {
    if (!playlistsData) return [];
    const held = CoreAPI.playlistIdsOf(charId);
    if (!held.length) return [];
    return playlistsData.order
        .filter(id => playlistsData.playlists[id] && held.includes(id))
        .map(id => ({ uid: id, ...playlistsData.playlists[id] }));
}

function isCharInAnyPlaylist(charId) {
    if (!playlistsData) return false;
    return CoreAPI.playlistIdsOf(charId).some(id => playlistsData.playlists[id]);
}

// ========================================
// CHARACTER DELETION HOOK
// ========================================

// The memberships cascade on the server with the character; the counts are re-read.
function onCharactersGone() {
    if (playlistsData) void reloadPlaylists();
}

// ========================================
// PLAYLIST PICKER MODAL
// ========================================

let pickerInjected = false;
// the picker's characters: picked ids, or a Select All's filter and the count the server answered for it
let pickerCharIds = [];
let pickerFilter = null;
let pickerCount = 0;
let pickerTally = {};   // { <playlist id>: how many of the picker's characters it holds }, the server's answer
const TALLY_CHUNK = 10000;

const pickerSize = () => (pickerFilter !== null ? pickerCount : pickerCharIds.length);

async function readPickerTally() {
    if (pickerFilter !== null) {
        pickerTally = await playlistRequest('/playlists/tally', 'POST', { filter: pickerFilter }) || {};
        return;
    }
    const tally = {};
    for (let i = 0; i < pickerCharIds.length; i += TALLY_CHUNK) {
        const part = await playlistRequest('/playlists/tally', 'POST', { charIds: pickerCharIds.slice(i, i + TALLY_CHUNK) });
        for (const [id, n] of Object.entries(part || {})) tally[id] = (tally[id] || 0) + n;
    }
    pickerTally = tally;
}

// A failed tally leaves the boxes unknown, never shown as empty.
async function repaintPicker() {
    try {
        await readPickerTally();
    } catch (e) {
        CoreAPI.showToast(`Could not read which playlists hold the selection: ${e.message}`, 'error');
        closePlaylistPicker();
        return false;
    }
    renderPickerList();
    return true;
}



function injectPickerModal() {
    if (pickerInjected) return;
    pickerInjected = true;

    const html = `
    <div id="playlistPickerModal" class="cl-modal cl-modal-drawer cl-drawer-partial playlist-picker-modal">
        <div class="cl-modal-content pl-picker-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-list-ul"></i> Add to Playlist</h3>
                <span id="playlistPickerCount" class="pl-picker-count"></span>
                <button id="playlistPickerCloseBtn" class="cl-modal-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body cl-modal-body-flush">
                <div class="pl-picker-search-wrap">
                    <i class="fa-solid fa-magnifying-glass pl-picker-search-icon"></i>
                    <input type="search" id="playlistPickerSearch" class="cl-input pl-picker-search" placeholder="Search or create..." maxlength="100" autocomplete="one-time-code">
                </div>
                <div id="playlistPickerList" class="pl-picker-list"></div>
                <div id="playlistPickerEmpty" class="pl-picker-empty">No playlists yet. Type a name above to create one.</div>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', html);
    CoreAPI.mountDialogSizing('playlistPickerModal');

    document.getElementById('playlistPickerCloseBtn').addEventListener('click', closePlaylistPicker);
    document.getElementById('playlistPickerModal').addEventListener('click', (e) => {
        if (e.target.id === 'playlistPickerModal') closePlaylistPicker();
    });
    document.getElementById('playlistPickerList').addEventListener('click', handlePickerRowClick);
    document.getElementById('playlistPickerSearch').addEventListener('input', filterPickerList);
    document.getElementById('playlistPickerSearch').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const createRow = document.querySelector('#playlistPickerList .pl-create-row');
            if (createRow && !createRow.hidden) handlePickerCreate();
        }
    });

    window.registerOverlay?.({ id: 'playlistPickerModal', tier: 7, close: () => closePlaylistPicker(), visible: (el) => el.classList.contains('visible') });
}

const plCreateRowHtml = (q) => `<i class="fa-solid fa-plus pl-create-row-icon"></i><span class="pl-create-row-text">Create <strong>${esc(q)}</strong></span>`;

function filterPickerList() {
    CoreAPI.filterListWithInlineCreate({
        searchId: 'playlistPickerSearch',
        listId: 'playlistPickerList',
        rowSel: '.pl-picker-row',
        nameOf: (row) => row.querySelector('.pl-picker-name')?.textContent,
        createRowClass: 'pl-create-row',
        createRowHtml: plCreateRowHtml,
        onCreate: handlePickerCreate,
        emptyId: 'playlistPickerEmpty',
    });
}

/**
 * Open the picker over characters: an array of ids, or a selection as CoreAPI.getSelection answers
 * it ({ ids } picked, or a Select All's { filter, count }).
 * @param {string[]|{ids?: string[], filter?: string, count?: number}} target
 */
async function openPlaylistPicker(target) {
    const byFilter = !Array.isArray(target) && typeof target?.filter === 'string';
    const ids = Array.isArray(target) ? target : (target?.ids || []);
    if (byFilter ? !target.count : !ids.length) return;
    injectPickerModal();
    pickerFilter = byFilter ? target.filter : null;
    pickerCount = byFilter ? target.count : 0;
    pickerCharIds = byFilter ? [] : [...new Set(ids.map(String))];
    await loadPlaylists();

    const searchInput = document.getElementById('playlistPickerSearch');
    if (searchInput) searchInput.value = '';
    if (!(await repaintPicker())) return;

    const countEl = document.getElementById('playlistPickerCount');
    countEl.textContent = pickerSize() === 1 ? '1 character' : `${pickerSize().toLocaleString()} characters`;

    document.getElementById('playlistPickerModal').classList.add('visible');
}

function closePlaylistPicker() {
    document.getElementById('playlistPickerModal')?.classList.remove('visible');
    pickerCharIds = [];
    pickerFilter = null;
    pickerCount = 0;
    pickerTally = {};
}

function renderPickerList() {
    const listEl = document.getElementById('playlistPickerList');
    const emptyEl = document.getElementById('playlistPickerEmpty');
    const playlists = getAllPlaylists();

    if (!playlists.length) {
        listEl.innerHTML = '';
        emptyEl.hidden = false;
        filterPickerList();
        return;
    }
    emptyEl.hidden = true;

    listEl.innerHTML = playlists.map(pl => {
        const inCount = pickerTally[pl.uid] || 0;
        const total = pickerSize();
        let iconCls, rowCls;
        if (inCount === total) {
            iconCls = 'fa-solid fa-square-check';
            rowCls = 'checked';
        } else if (inCount > 0) {
            iconCls = 'fa-solid fa-square-minus';
            rowCls = 'partial';
        } else {
            iconCls = 'fa-regular fa-square';
            rowCls = '';
        }
        const iconColor = pl.color ? ` style="color:${esc(pl.color)}"` : '';
        const plIcon = pl.icon
            ? `<i class="pl-picker-icon ${esc(pl.icon)}"${iconColor}></i>`
            : '';
        return `<div class="pl-picker-row ${rowCls}" data-uid="${esc(pl.uid)}">
            <i class="pl-picker-check ${iconCls}"></i>
            ${plIcon}
            <span class="pl-picker-name">${esc(pl.name)}</span>
            <span class="pl-picker-badge">${pl.count}</span>
        </div>`;
    }).join('');

    filterPickerList();
}

async function handlePickerRowClick(e) {
    const row = e.target.closest('.pl-picker-row');
    if (!row) return;
    const uid = row.dataset.uid;
    const pl = getPlaylist(uid);
    if (!pl) return;

    const inCount = pickerTally[uid] || 0;

    if (pickerFilter !== null) {
        await pickerApplyByFilter(uid, pl, inCount === pickerCount ? 'remove' : 'add');
    } else if (inCount === pickerCharIds.length) {
        // false means the write did not land, and reportFailure has already said why
        const removed = await removeFromPlaylist(uid, pickerCharIds);
        if (removed !== false) CoreAPI.showToast(`Removed from "${pl.name}"`, 'info');
    } else {
        const added = await addToPlaylist(uid, pickerCharIds);
        if (added > 0) CoreAPI.showToast(`Added to "${pl.name}"`, 'success');
    }
    await repaintPicker();
    // badges + sidebar refresh now lives in the mutation primitives
}

// a Select All's row click: the set joins or leaves, and the toast counts what moved and what already was
async function pickerApplyByFilter(uid, pl, op) {
    const out = await applyMembersByFilter(uid, pickerFilter, op);
    if (!out) return;
    const rest = out.total - out.changed;
    const said = op === 'add' ? `Added ${out.changed.toLocaleString()} to "${pl.name}"` : `Removed ${out.changed.toLocaleString()} from "${pl.name}"`;
    const after = rest ? (op === 'add' ? `; ${rest.toLocaleString()} already were` : `; ${rest.toLocaleString()} were not in it`) : '';
    CoreAPI.showToast(out.stopped ? `Stopped: ${said}` : `${said}${after}`, out.stopped ? 'warning' : (op === 'add' ? 'success' : 'info'));
}

async function handlePickerCreate() {
    const input = document.getElementById('playlistPickerSearch');
    const name = (input?.value || '').trim();
    if (!name) return;

    const uid = await createPlaylist(name);
    if (!uid) return;
    if (pickerFilter !== null) {
        await applyMembersByFilter(uid, pickerFilter, 'add');
    } else if (pickerCharIds.length) {
        await addToPlaylist(uid, pickerCharIds);
    }
    input.value = '';
    await repaintPicker();
    CoreAPI.showToast(`Created "${name}"`, 'success');
}

// ========================================
// PLAYLIST MANAGEMENT MODAL
// ========================================

const PRESET_COLORS = ['', '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];

const PRESET_ICONS = [
    '', 'fa-solid fa-heart', 'fa-solid fa-star', 'fa-solid fa-bolt', 'fa-solid fa-fire',
    'fa-solid fa-crown', 'fa-solid fa-gem', 'fa-solid fa-shield', 'fa-solid fa-wand-sparkles',
    'fa-solid fa-dragon', 'fa-solid fa-skull', 'fa-solid fa-ghost', 'fa-solid fa-hat-wizard',
    'fa-solid fa-book', 'fa-solid fa-scroll', 'fa-solid fa-music', 'fa-solid fa-palette',
    'fa-solid fa-moon', 'fa-solid fa-sun', 'fa-solid fa-snowflake', 'fa-solid fa-leaf',
    'fa-solid fa-cat', 'fa-solid fa-dog', 'fa-solid fa-dove', 'fa-solid fa-feather',
    'fa-solid fa-face-smile', 'fa-solid fa-robot', 'fa-solid fa-user-secret', 'fa-solid fa-masks-theater',
    'fa-solid fa-gamepad', 'fa-solid fa-dice-d20', 'fa-solid fa-chess-queen', 'fa-solid fa-puzzle-piece',
    'fa-solid fa-flask', 'fa-solid fa-atom', 'fa-solid fa-rocket', 'fa-solid fa-code',
    'fa-solid fa-seedling', 'fa-solid fa-clover', 'fa-solid fa-tree', 'fa-solid fa-mountain-sun',
    'fa-solid fa-water', 'fa-solid fa-hurricane', 'fa-solid fa-meteor', 'fa-solid fa-explosion',
    'fa-solid fa-wand-magic-sparkles', 'fa-solid fa-hand-sparkles', 'fa-solid fa-broom',
    'fa-solid fa-dungeon', 'fa-solid fa-khanda', 'fa-solid fa-hand-fist', 'fa-solid fa-gun',
    'fa-solid fa-skull-crossbones', 'fa-solid fa-biohazard', 'fa-solid fa-radiation',
    'fa-solid fa-person-running', 'fa-solid fa-person-dress', 'fa-solid fa-people-group',
    'fa-solid fa-children', 'fa-solid fa-baby', 'fa-solid fa-user-ninja', 'fa-solid fa-user-astronaut',
    'fa-solid fa-spider', 'fa-solid fa-crow', 'fa-solid fa-fish', 'fa-solid fa-otter',
    'fa-solid fa-hippo', 'fa-solid fa-frog', 'fa-solid fa-horse', 'fa-solid fa-paw',
    'fa-solid fa-camera', 'fa-solid fa-pen-nib', 'fa-solid fa-paintbrush', 'fa-solid fa-scissors',
    'fa-solid fa-guitar', 'fa-solid fa-headphones', 'fa-solid fa-microphone',
    'fa-solid fa-tv', 'fa-solid fa-film', 'fa-solid fa-clapperboard',
    'fa-solid fa-graduation-cap', 'fa-solid fa-microscope', 'fa-solid fa-dna',
    'fa-solid fa-brain', 'fa-solid fa-eye', 'fa-solid fa-glasses',
    'fa-solid fa-mug-hot', 'fa-solid fa-wine-glass', 'fa-solid fa-martini-glass-citrus',
    'fa-solid fa-cookie-bite', 'fa-solid fa-candy-cane', 'fa-solid fa-ice-cream',
    'fa-solid fa-gift', 'fa-solid fa-cake-candles', 'fa-solid fa-champagne-glasses',
    'fa-solid fa-ring', 'fa-solid fa-hat-cowboy', 'fa-solid fa-vest-patches',
    'fa-solid fa-compass', 'fa-solid fa-map', 'fa-solid fa-anchor', 'fa-solid fa-sailboat',
    'fa-solid fa-plane', 'fa-solid fa-shuttle-space', 'fa-solid fa-satellite',
    'fa-solid fa-house-chimney', 'fa-solid fa-building', 'fa-solid fa-city',
    'fa-solid fa-landmark', 'fa-solid fa-church', 'fa-solid fa-torii-gate',
    'fa-solid fa-yin-yang', 'fa-solid fa-cross', 'fa-solid fa-om', 'fa-solid fa-peace',
    'fa-solid fa-rainbow', 'fa-solid fa-umbrella', 'fa-solid fa-cloud-bolt',
    'fa-solid fa-temperature-high', 'fa-solid fa-wind', 'fa-solid fa-volcano',
];

let manageInjected = false;
let activeIconPickerUid = null;
let iconPickerEl = null;

function injectManageModal() {
    if (manageInjected) return;
    manageInjected = true;

    const html = `
    <div id="playlistManageModal" class="cl-modal playlist-manage-modal">
        <div class="cl-modal-content pl-manage-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-list-ul"></i> Manage Playlists</h3>
                <button id="playlistManageCloseBtn" class="cl-modal-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body cl-modal-body-flush">
                <div class="pl-manage-search-wrap">
                    <i class="fa-solid fa-magnifying-glass pl-manage-search-icon"></i>
                    <input type="search" id="playlistManageSearch" class="cl-input pl-manage-search" placeholder="Search or create..." maxlength="100" autocomplete="one-time-code">
                </div>
                <div id="playlistManageList" class="pl-manage-list"></div>
                <div id="playlistManageEmpty" class="pl-picker-empty">No playlists yet. Type a name above to create one.</div>
            </div>
        </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', html);
    CoreAPI.mountDialogSizing('playlistManageModal');

    document.getElementById('playlistManageCloseBtn').addEventListener('click', closePlaylistManager);
    document.getElementById('playlistManageModal').addEventListener('click', (e) => {
        if (e.target.id === 'playlistManageModal') closePlaylistManager();
    });
    document.getElementById('playlistManageSearch').addEventListener('input', filterManageList);
    document.getElementById('playlistManageSearch').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const createRow = document.querySelector('#playlistManageList .pl-create-row');
            if (createRow && !createRow.hidden) handleManageCreate();
        }
    });

    const list = document.getElementById('playlistManageList');

    list.addEventListener('click', (e) => {
        const iconBtn = e.target.closest('.pl-manage-icon-btn');
        if (iconBtn) {
            e.stopPropagation();
            toggleIconPicker(iconBtn);
            return;
        }

        const delBtn = e.target.closest('.pl-manage-delete');
        if (delBtn) {
            const row = delBtn.closest('.pl-manage-row');
            if (row) handleManageDelete(row.dataset.uid);
            return;
        }
    });

    // Name input blur = save rename
    list.addEventListener('focusout', (e) => {
        if (e.target.classList.contains('pl-manage-name')) {
            const row = e.target.closest('.pl-manage-row');
            if (row) handleManageRename(row.dataset.uid, e.target.value);
        }
    });

    // Name input Enter = blur (triggers save)
    list.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.classList.contains('pl-manage-name')) {
            e.target.blur();
        }
    });

    document.addEventListener('click', () => {
        if (iconPickerEl && !iconPickerEl.classList.contains('hidden')) {
            iconPickerEl.classList.add('hidden');
            activeIconPickerUid = null;
        }
    });

    window.registerOverlay?.({ id: 'playlistManageModal', tier: 7, close: () => closePlaylistManager(), visible: (el) => el.classList.contains('visible') });
}

async function openPlaylistManager() {
    injectManageModal();
    await loadPlaylists();
    const searchInput = document.getElementById('playlistManageSearch');
    if (searchInput) searchInput.value = '';
    renderManageList();
    document.getElementById('playlistManageModal').classList.add('visible');
}

function closePlaylistManager() {
    document.getElementById('playlistManageModal')?.classList.remove('visible');
    if (iconPickerEl) {
        iconPickerEl.classList.add('hidden');
        activeIconPickerUid = null;
    }
}

function renderManageList() {
    const listEl = document.getElementById('playlistManageList');
    const emptyEl = document.getElementById('playlistManageEmpty');
    const playlists = getAllPlaylists();

    if (!playlists.length) {
        listEl.innerHTML = '';
        emptyEl.hidden = false;
        filterManageList();
        return;
    }
    emptyEl.hidden = true;

    listEl.innerHTML = playlists.map(pl => {
        const iconColor = pl.color ? ` style="color:${esc(pl.color)}"` : '';
        const iconInner = pl.icon ? `<i class="${esc(pl.icon)}"${iconColor}></i>` : `<i class="fa-solid fa-icons u-dim-30"></i>`;
        const count = pl.count;
        return `<div class="pl-manage-row" data-uid="${esc(pl.uid)}">
            <button class="pl-manage-icon-btn" title="Change icon">${iconInner}</button>
            <input type="search" class="pl-manage-name cl-input" value="${esc(pl.name)}" maxlength="100" autocomplete="one-time-code">
            <span class="pl-manage-count">${count}</span>
            <button class="pl-manage-delete" title="Delete playlist"><i class="fa-solid fa-trash"></i></button>
        </div>`;
    }).join('');

    filterManageList();
}

// Manage rows keep the playlist name in a renameable <input>, so nameOf reads .value not textContent.
function filterManageList() {
    CoreAPI.filterListWithInlineCreate({
        searchId: 'playlistManageSearch',
        listId: 'playlistManageList',
        rowSel: '.pl-manage-row',
        nameOf: (row) => row.querySelector('.pl-manage-name')?.value,
        createRowClass: 'pl-create-row',
        createRowHtml: plCreateRowHtml,
        onCreate: handleManageCreate,
        emptyId: 'playlistManageEmpty',
    });
}

function positionPickerAtButton(btn, picker) {
    const zoom = CoreAPI.uiZoom();
    const rect = btn.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.left = `${rect.left / zoom}px`;
    picker.style.top = `${(rect.bottom / zoom) + 4}px`;
}

function toggleIconPicker(btn) {
    if (!iconPickerEl) {
        iconPickerEl = document.createElement('div');
        iconPickerEl.className = 'pl-manage-icon-picker hidden';
        const iconsHtml = PRESET_ICONS.map(ic => {
            const inner = ic ? `<i class="${ic}"></i>` : `<i class="fa-solid fa-xmark u-dim-30"></i>`;
            const title = ic ? ic.split(' ').pop().replace('fa-', '') : 'No icon';
            return `<button class="pl-icon-option" data-icon="${ic}" title="${title}">${inner}</button>`;
        }).join('');
        const swatchesHtml = PRESET_COLORS.map(c => {
            const style = c ? `background:${c}` : 'background:transparent; border: 1px dashed rgba(255,255,255,0.3)';
            const title = c || 'No color';
            return `<button class="pl-color-swatch" data-color="${c}" style="${style}" title="${title}"></button>`;
        }).join('');
        iconPickerEl.innerHTML = `<div class="pl-icon-picker-icons">${iconsHtml}</div><div class="pl-icon-picker-colors"><span class="pl-icon-picker-label">Color</span>${swatchesHtml}</div>`;
        document.body.appendChild(iconPickerEl);

        iconPickerEl.addEventListener('click', (e) => {
            e.stopPropagation();
            const iconOpt = e.target.closest('.pl-icon-option');
            if (iconOpt && activeIconPickerUid) {
                handleManageIconChange(activeIconPickerUid, iconOpt.dataset.icon || '');
                return;
            }
            const swatch = e.target.closest('.pl-color-swatch');
            if (swatch && activeIconPickerUid) {
                handleManageColorChange(activeIconPickerUid, swatch.dataset.color || '');
                return;
            }
        });
    }

    const row = btn.closest('.pl-manage-row');
    const uid = row?.dataset.uid;

    if (activeIconPickerUid === uid && !iconPickerEl.classList.contains('hidden')) {
        iconPickerEl.classList.add('hidden');
        activeIconPickerUid = null;
        return;
    }

    activeIconPickerUid = uid;
    positionPickerAtButton(btn, iconPickerEl);
    iconPickerEl.classList.remove('hidden');
}

async function handleManageIconChange(uid, icon) {
    await updatePlaylist(uid, { icon });
    if (iconPickerEl) {
        iconPickerEl.classList.add('hidden');
        activeIconPickerUid = null;
    }
    renderManageList();
}

async function handleManageColorChange(uid, color) {
    await updatePlaylist(uid, { color });
    if (iconPickerEl) {
        iconPickerEl.classList.add('hidden');
        activeIconPickerUid = null;
    }
    renderManageList();
}

async function handleManageRename(uid, newName) {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === getPlaylist(uid)?.name) return;
    // a refused name puts the stored one back in the field
    if (!(await updatePlaylist(uid, { name: trimmed }))) renderManageList();
}

async function handleManageDelete(uid) {
    const pl = getPlaylist(uid);
    if (!pl) return;
    const count = pl.count;
    const msg = count > 0
        ? `Delete "${pl.name}"? (${count} character${count !== 1 ? 's' : ''} will be removed from this playlist)`
        : `Delete "${pl.name}"?`;

    if (!(await CoreAPI.showConfirm({ title: 'Delete playlist', message: msg, confirmLabel: 'Delete', danger: true }))) return;

    if (!(await deletePlaylist(uid))) return;
    renderManageList();
    CoreAPI.showToast(`Deleted "${pl.name}"`, 'info');
}

async function handleManageCreate() {
    const input = document.getElementById('playlistManageSearch');
    const name = (input?.value || '').trim();
    if (!name) return;

    if (!(await createPlaylist(name))) return;
    input.value = '';
    renderManageList();
    CoreAPI.showToast(`Created "${name}"`, 'success');
}

// ========================================
// INIT
// ========================================

function init() {
    registerFeedPatcher('playlist', () => reloadPlaylists());
    CoreAPI.onCharactersDeleted(onCharactersGone);
    // the load catches its own failure and answers null, so the null is the failure to say
    loadPlaylists()
        .then((data) => {
            if (!data) {
                CoreAPI.showToast('Could not load playlists. Existing playlists may not appear until the issue is fixed.', 'error', 6000);
                return undefined;
            }
            return CoreAPI.refreshPlaylistBadges();
        })
        .catch(err => {
            console.error('[Playlists] init load failed:', err);
            CoreAPI.showToast('Could not load playlists. Existing playlists may not appear until the issue is fixed.', 'error', 6000);
        });
}

// ========================================
// PUBLIC API
// ========================================

export {
    loadPlaylists,
    removeFromPlaylist,
    getAllPlaylists,
    getPlaylist,
    getPlaylistCharacters,
    getPlaylistsForChar,
    isCharInAnyPlaylist,
    openPlaylistPicker,
    openPlaylistManager,
};

export default { init };
