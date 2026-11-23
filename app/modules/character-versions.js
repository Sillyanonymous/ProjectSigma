// Character version history - local snapshots + remote provider versions

import * as CoreAPI from './core-api.js';
import { matchLorebookEntries, compareLorebookMeta, lorebookEntryName, lorebooksEqual, entryInWorld } from './lorebook-diff.js';
import { CARD_COMPARABLE_FIELDS, RESTORABLE_KEYS, readCardField, cardValuesEqual } from './card-fields.js';
import { defineCommand, runCommand } from './ext-registry.js';
import { registerFeedPatcher } from './feed.js';

// ========================================
// MODULE STATE
// ========================================

let isInitialized = false;

// Remote version caches
const versionListCache = new Map(); // cacheKey -> { versions, fetchedAt }
const VERSION_LIST_CACHE_TTL = 5 * 60 * 1000;
const versionDataCache = new Map(); // cacheKey:ref -> cardData
const VERSION_DATA_CACHE_MAX = 20;

// Active pane state
let paneContainer = null;
let currentChar = null;
let currentProvider = null; // ProviderBase instance for the active character
let currentLinkInfo = null; // ProviderLinkInfo for the active character
let selectedVersionRef = null;
let activeTab = 'remote';
let currentLocalSnapshots = [];
let selectedSnapshotId = null;
let paneDelegationHandler = null;
let _renderGen = 0;

// ========================================
// STORAGE: a character's snapshot rows, behind /api/versions/char/{id}
// ========================================

let charDataCache = new Map(); // character id -> its snapshot history as last read

// Reads

function snapshotsDocEndpoint(charId) {
    return `/versions/char/${encodeURIComponent(charId)}`;
}

async function readSnapshotsDoc(charId) {
    // Only a definitive read may answer: a clean 404 means no snapshots yet, and a failed
    // read is unknown, never an empty history.
    const resp = await CoreAPI.apiRequest(snapshotsDocEndpoint(charId), 'GET');
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`Version read failed (${resp.status})`);
    return resp.json();
}

async function loadSnapshotsDoc(charId) {
    if (charDataCache.has(charId)) return charDataCache.get(charId);
    const history = await readSnapshotsDoc(charId);
    if (history) charDataCache.set(charId, history);
    return history;
}

// Writes

// snapshots are rows, written one per verb, so a snapshot another writer stored after our read is never lost
function snapshotsEndpoint(charId) {
    return `/versions/char/${encodeURIComponent(charId)}/snapshots`;
}

function snapshotEndpoint(charId, snapshotId) {
    return `/versions/char/${encodeURIComponent(charId)}/snapshots/${encodeURIComponent(snapshotId)}`;
}

function backupEndpoint(charId) {
    return `/versions/char/${encodeURIComponent(charId)}/backup`;
}

async function snapshotsRequest(charId, endpoint, method, body) {
    const resp = await CoreAPI.apiRequest(endpoint, method, body);
    charDataCache.delete(charId);
    return CoreAPI.readAnswer(resp);
}

// Storage API

async function storageSaveSnapshot(charName, label, source, data, charId) {
    if (!charId) throw new Error('character id required');
    const { id } = await snapshotsRequest(charId, snapshotsEndpoint(charId), 'POST', { label, source, charName, data });
    return id;
}

async function storageGetSnapshots(charId) {
    if (!charId) return [];
    const history = await loadSnapshotsDoc(charId);
    if (!history || !history.snapshots) return [];
    return [...history.snapshots].sort((a, b) => b.timestamp - a.timestamp);
}

async function storageGetSnapshot(charId, snapshotId) {
    if (!charId) return null;
    const history = await loadSnapshotsDoc(charId);
    if (!history) return null;
    return history.snapshots.find(s => s.id === snapshotId) || null;
}

async function storageDeleteSnapshot(charId, snapshotId) {
    if (!charId) return;
    await snapshotsRequest(charId, snapshotEndpoint(charId, snapshotId), 'DELETE');
}

async function storageRenameSnapshot(charId, snapshotId, newLabel) {
    if (!charId) return;
    await snapshotsRequest(charId, snapshotEndpoint(charId, snapshotId), 'PATCH', { label: newLabel });
}

async function storageSaveBackup(charId, data) {
    if (!charId) return;
    await snapshotsRequest(charId, backupEndpoint(charId), 'PUT', { timestamp: Date.now(), data });
}

async function storageGetBackup(charId) {
    if (!charId) return null;
    const history = await loadSnapshotsDoc(charId);
    return history?.backup || null;
}

async function storageClearBackup(charId) {
    if (!charId) return;
    await snapshotsRequest(charId, backupEndpoint(charId), 'DELETE');
}

// another tab's snapshot writes drop the cached docs they name (all on resync); the shown list re-reads unless a snapshot is open
function patchVersionsFromFeed(records) {
    const ids = records ? records.flatMap(r => r.ids || []) : null;
    if (ids) ids.forEach(id => charDataCache.delete(id));
    else charDataCache.clear();
    const shown = currentChar?.id;
    if (!shown || activeTab !== 'local' || selectedSnapshotId !== null) return;
    if (!ids || ids.includes(shown)) return loadLocalSnapshots();
}

// ========================================
// CARD DATA EXTRACTION
// ========================================

async function extractCardData(char, opts = {}) {
    if (char._slim) await CoreAPI.hydrateCharacter(char);
    // hydrate swallows failure; a slim husk's snapshot stores emptiness a restore reapplies. Callers catch (no backup, restore aborts)
    if (char._slim) throw new Error('card data unavailable (hydrate failed); refusing a hollow snapshot');
    const src = char.data || char;
    const out = JSON.parse(JSON.stringify(src));
    // Preserve avatar URL for snapshot comparisons
    if (char.id) {
        out._avatarUrl = `/avatars/${encodeURIComponent(char.id)}.png`;
    }
    // Optionally embed the live avatar PNG as a base64 data URL so the snapshot
    // remains visually accurate even after the character's PNG is overwritten.
    if (opts.embedAvatar && char.id) {
        try {
            const resp = await fetch(CoreAPI.serverUrl(`/avatars/${encodeURIComponent(char.id)}.png`));
            if (resp.ok) {
                const blob = await resp.blob();
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(reader.error);
                    reader.readAsDataURL(blob);
                });
                out._avatarImageData = dataUrl;
            }
        } catch (e) {
            CoreAPI.debugLog('[CharVersions] Failed to embed avatar image:', e);
        }
    }
    return out;
}

// ========================================
// INITIALIZATION
// ========================================

export function init(deps) {
    if (isInitialized) return;
    isInitialized = true;
    defineCommand('character.snapshot', snapshotCharacterFrom, { title: 'Snapshot a character' });
    registerFeedPatcher('version', patchVersionsFromFeed);
    CoreAPI.debugLog('[CharVersions] Module initialized');
}

// ========================================
// PUBLIC API
// ========================================

export async function openVersionHistory(char) {
    if (!char) return;
    await CoreAPI.openCharacterModal(char);
    const btn = document.querySelector('.tab-btn[data-tab="versions"]');
    if (btn) btn.click();
}

export function renderVersionsPane(container, char) {
    if (!container || !char) return;

    _renderGen++;
    paneContainer = container;
    currentChar = char;

    const match = CoreAPI.getCharacterProvider(char);
    currentProvider = match?.provider?.supportsVersionHistory ? match.provider : null;
    currentLinkInfo = match?.linkInfo || null;

    selectedVersionRef = null;
    currentLocalSnapshots = [];
    selectedSnapshotId = null;
    activeTab = currentProvider ? 'remote' : 'local';

    container.innerHTML = buildPaneHtml();
    setupPaneDelegation(container);

    if (activeTab === 'remote') {
        loadRemoteVersions();
    } else {
        loadLocalSnapshots();
    }
}

export function cleanupVersionsPane() {
    _renderGen++;
    if (paneContainer && paneDelegationHandler) {
        paneContainer.removeEventListener('click', paneDelegationHandler);
    }
    currentChar = null;
    currentProvider = null;
    currentLinkInfo = null;
    selectedVersionRef = null;
    currentLocalSnapshots = [];
    selectedSnapshotId = null;
    paneContainer = null;
    paneDelegationHandler = null;
}

// never throws: a snapshot is a convenience, so the change goes ahead and a failure is said once per write
export async function autoSnapshotBeforeChange(char, source = 'edit', opts = {}) {
    if (!char) return;
    const enabled = CoreAPI.getSetting('autoSnapshotOnEdit');
    if (!enabled) return;
    const charName = char.data?.name || char.name || 'Unknown';
    try {
        const data = await extractCardData(char, opts);
        const timestamp = new Date().toLocaleString();
        const label = `${source.charAt(0).toUpperCase() + source.slice(1)} - ${timestamp}`;
        await storageSaveSnapshot(charName, label, 'auto_backup', data, char.id);
    } catch (e) {
        console.error('[CharVersions] Auto-snapshot failed:', e);
        CoreAPI.showToast(`No snapshot of "${charName}" was taken before this change: ${e?.message || String(e)}`, 'warning', 8000,
            { group: 'auto-snapshot-failed', item: charName, many: summarizeSnapshotFailures });
    }
}

// a batch's failed snapshots in one line, as summarizeCardRefusals folds a batch's refusals
function summarizeSnapshotFailures(names) {
    const shown = names.slice(0, 3).map(n => `"${n}"`).join(', ');
    const more = names.length > 3 ? ` and ${names.length - 3} more` : '';
    return `No snapshot was taken of ${names.length} characters before this change: ${shown}${more}`;
}

/** character.snapshot: the card as it is now under a label (the caller's live object if still that character); answers { snapshot, label }. */
async function snapshotCharacterFrom({ id, label, char } = {}) {
    const want = id == null ? '' : String(id);
    const target = char && char.id === want ? char
        : (want ? (CoreAPI.getCharacterById(want) || await CoreAPI.ensureCharacterById(want)) : null);
    if (!target) throw new Error(`character.snapshot: no character ${want || '(no id)'}`);
    const snapLabel = String(label ?? '').trim() || `Snapshot ${new Date().toLocaleString()}`;
    const data = await extractCardData(target);
    const snapshot = await storageSaveSnapshot(target.data?.name || target.name || 'Unknown', snapLabel, 'local', data, target.id);
    if (currentChar?.id === target.id && activeTab === 'local') await loadLocalSnapshots();
    return { snapshot, label: snapLabel };
}

// ========================================
// SCOPED DOM HELPERS
// ========================================

function el(sel) { return paneContainer?.querySelector(sel); }

// the status line of the pane that started a verb, left alone once another character's pane opened
function paneStatus(gen, html) {
    if (gen !== _renderGen) return;
    const status = el('.vt-status');
    if (status) status.innerHTML = html;
}

// ========================================
// PANE HTML
// ========================================

function buildPaneHtml() {
    const hasRemote = !!currentProvider;
    return `
        <div class="vt-container">
            <button class="vt-btn vt-back-btn"><i class="fa-solid fa-arrow-left"></i> Back to List</button>
            <div class="vt-toolbar">
                ${hasRemote ? `
                <div class="vt-sub-tabs">
                    <button class="vt-sub-tab ${activeTab === 'remote' ? 'active' : ''}" data-vt-tab="remote">
                        <i class="fa-solid fa-cloud"></i> Remote
                    </button>
                    <button class="vt-sub-tab ${activeTab === 'local' ? 'active' : ''}" data-vt-tab="local">
                        <i class="fa-solid fa-bookmark"></i> Local
                    </button>
                </div>` : `
                <div class="vt-sub-tabs">
                    <span class="vt-sub-tab active">
                        <i class="fa-solid fa-bookmark"></i> Local Snapshots
                    </span>
                </div>`}
                <div class="vt-toolbar-right">
                    <button class="vt-btn vt-save-snapshot" title="Save current card state as a snapshot">
                        <i class="fa-solid fa-camera"></i> Save Snapshot
                    </button>
                    <button class="vt-btn vt-refresh" title="Refresh">
                        <i class="fa-solid fa-arrows-rotate"></i>
                    </button>
                </div>
            </div>
            <div class="vt-status">
                <i class="fa-solid fa-spinner fa-spin"></i> Loading...
            </div>
            <div class="vt-body">
                <div class="vt-list"></div>
                <div class="vt-preview vt-hidden"></div>
            </div>
            <div class="vt-actions vt-hidden">
                <div class="vt-actions-left">
                    <button class="vt-btn vt-rename" title="Rename snapshot"><i class="fa-solid fa-pen"></i></button>
                    <button class="vt-btn vt-delete" title="Delete snapshot"><i class="fa-solid fa-trash-can"></i></button>
                </div>
                <div class="vt-actions-right">
                    <button class="vt-btn vt-undo" title="Undo last restore"><i class="fa-solid fa-rotate-left"></i> Undo</button>
                    <button class="vt-btn vt-restore" title="Restore this version"><i class="fa-solid fa-download"></i> Restore</button>
                </div>
            </div>
        </div>
    `;
}

// ========================================
// EVENT DELEGATION
// ========================================

function setupPaneDelegation(container) {
    // Remove previous handler to prevent accumulation on re-renders
    if (paneDelegationHandler) {
        container.removeEventListener('click', paneDelegationHandler);
    }

    paneDelegationHandler = (e) => {
        if (e.target.closest('.vt-back-btn')) { closeMobileDetail(); return; }

        const tab = e.target.closest('[data-vt-tab]');
        if (tab) { switchTab(tab.dataset.vtTab); return; }

        const vItem = e.target.closest('.vt-item[data-ref]');
        if (vItem) {
            if (vItem.dataset.ref === '__provider_page__') { selectProviderPageVersion(); return; }
            selectVersion(vItem.dataset.ref, vItem.dataset.fullId); return;
        }

        const sItem = e.target.closest('.vt-item[data-snapshot-id]');
        if (sItem) { selectSnapshot(Number(sItem.dataset.snapshotId)); return; }

        const lbSh = e.target.closest('.vt-lb-section-header');
        if (lbSh) { lbSh.parentElement.classList.toggle('expanded'); return; }

        // Greeting block expand/collapse (check first so it doesn't bubble to outer diff header)
        const gh = e.target.closest('.vt-greeting-header');
        if (gh) { gh.parentElement.classList.toggle('expanded'); return; }

        const dh = e.target.closest('.vt-diff-header');
        if (dh) { dh.parentElement.classList.toggle('expanded'); return; }

        // Buttons
        if (e.target.closest('.vt-save-snapshot')) { handleSaveSnapshot(); return; }
        if (e.target.closest('.vt-refresh')) { handleRefresh(); return; }
        if (e.target.closest('.vt-restore')) { restoreVersion(); return; }
        if (e.target.closest('.vt-undo')) { undoRestore(); return; }
        if (e.target.closest('.vt-rename')) { handleRenameSnapshot(); return; }
        if (e.target.closest('.vt-delete')) { handleDeleteSnapshot(); return; }

        const applyAvBtn = e.target.closest('.vt-apply-avatar');
        if (applyAvBtn) { handleApplyAvatar(applyAvBtn.dataset.avatarUrl); return; }
    };

    container.addEventListener('click', paneDelegationHandler);
}

// ========================================
// TAB SWITCHING
// ========================================

async function switchTab(tab) {
    if (tab === activeTab) return;
    activeTab = tab;

    paneContainer.querySelectorAll('.vt-sub-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.vtTab === tab);
    });

    selectedVersionRef = null;
    selectedSnapshotId = null;
    const preview = el('.vt-preview');
    if (preview) { preview.innerHTML = ''; preview.classList.add('vt-hidden'); }
    const actions = el('.vt-actions');
    if (actions) actions.classList.add('vt-hidden');
    el('.vt-container')?.classList.remove('vt-detail-open');

    if (tab === 'remote' && currentProvider) {
        await loadRemoteVersions();
    } else if (tab === 'local') {
        await loadLocalSnapshots();
    }
}

function closeMobileDetail() {
    el('.vt-container')?.classList.remove('vt-detail-open');
}

function handleRefresh() {
    if (activeTab === 'remote' && currentProvider) {
        const cacheKey = `${currentProvider.id}:${currentLinkInfo?.fullPath}`;
        versionListCache.delete(cacheKey);
        loadRemoteVersions();
    } else if (activeTab === 'local') {
        loadLocalSnapshots();
    }
}

// ========================================
// REMOTE VERSIONS
// ========================================

async function loadRemoteVersions() {
    const gen = _renderGen;
    const status = el('.vt-status');
    const list = el('.vt-list');
    if (!status || !list || !currentProvider || !currentLinkInfo) return;

    const cacheKey = `${currentProvider.id}:${currentLinkInfo.fullPath}`;

    try {
        const cached = versionListCache.get(cacheKey);
        if (cached && Date.now() - cached.fetchedAt < VERSION_LIST_CACHE_TTL) {
            renderRemoteList(cached.versions);
            return;
        }

        status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Fetching version history...';
        list.innerHTML = '';

        const versions = await currentProvider.fetchVersionList(currentLinkInfo);
        if (gen !== _renderGen) return;

        if (!versions.length) {
            status.innerHTML = '<i class="fa-solid fa-info-circle"></i> No version history found';
            return;
        }

        versionListCache.set(cacheKey, { versions, fetchedAt: Date.now() });
        renderRemoteList(versions);
    } catch (e) {
        if (gen !== _renderGen) return;
        console.error('[CharVersions] loadRemoteVersions:', e);
        status.innerHTML = `<i class="fa-solid fa-xmark"></i> Error: ${esc(e.message)}`;
    }
}

function renderRemoteList(versions) {
    const status = el('.vt-status');
    const list = el('.vt-list');
    status.innerHTML = `<i class="fa-solid fa-clock-rotate-left"></i> ${versions.length} version${versions.length !== 1 ? 's' : ''} found`;

    // Provider "page" entry - shows what the provider's metadata API returns,
    // which can differ from the Git-exported card.json that versions are based on.
    const showPageEntry = currentProvider?.supportsRemotePageVersion;
    const pageInfo = showPageEntry ? currentProvider.getRemotePageInfo() : null;
    const pageDate = pageInfo?.date ? new Date(pageInfo.date) : null;
    const pageDateValid = pageDate && !isNaN(pageDate.getTime());
    const pageLabel = currentProvider?.remoteVersionLabel || 'Provider Page';

    function buildPageEntry() {
        if (!showPageEntry) return '';
        const dateHtml = pageDateValid
            ? `<i class="fa-regular fa-clock"></i> <span title="${esc(pageDate.toLocaleString())}">Last activity ${CoreAPI.formatRelativeAge(pageDate)}</span>`
            : `<i class="fa-solid fa-globe"></i> <span>Metadata API</span>`;
        return `
            <div class="vt-item provider-page" data-ref="__provider_page__">
                <div class="vt-item-header">
                    <span class="vt-item-id">${esc(pageLabel)}</span>
                    <span class="vt-badge provider-page">API</span>
                </div>
                <div class="vt-item-title">Current published state from ${esc(currentProvider.name)}</div>
                <div class="vt-item-date">${dateHtml}</div>
            </div>`;
    }

    // Insert the page entry in chronological order among versions.
    let insertIdx = 0;
    if (pageDateValid && showPageEntry) {
        for (let i = 0; i < versions.length; i++) {
            const vDate = new Date(versions[i].date);
            if (pageDate >= vDate) { insertIdx = i; break; }
            insertIdx = i + 1;
        }
    }

    const versionItems = versions.map((v, idx) => {
        const date = new Date(v.date);
        const vid = v.ref?.substring(0, 8) || v.ref;
        const title = v.message || 'Update';
        const isLatest = idx === 0;
        return `
            <div class="vt-item ${isLatest ? 'latest' : ''}" data-ref="${esc(vid)}" data-full-id="${esc(v.ref)}">
                <div class="vt-item-header">
                    <span class="vt-item-id">${esc(vid)}</span>
                    ${isLatest ? '<span class="vt-badge latest">Latest</span>' : ''}
                </div>
                <div class="vt-item-title">${esc(CoreAPI.truncate(title, 55))}</div>
                <div class="vt-item-date">
                    <i class="fa-regular fa-clock"></i>
                    <span title="${esc(date.toLocaleString())}">${CoreAPI.formatRelativeAge(date)}</span>
                </div>
            </div>`;
    }).join('');

    list.innerHTML = versionItems;

    const pageEntry = buildPageEntry();
    if (pageEntry) {
        const items = list.querySelectorAll('.vt-item');
        if (insertIdx >= items.length) {
            list.insertAdjacentHTML('beforeend', pageEntry);
        } else {
            items[insertIdx].insertAdjacentHTML('beforebegin', pageEntry);
        }
    }
}

// ========================================
// LOCAL SNAPSHOTS
// ========================================

async function loadLocalSnapshots() {
    const gen = _renderGen;
    const status = el('.vt-status');
    const list = el('.vt-list');
    const preview = el('.vt-preview');
    const actions = el('.vt-actions');
    if (!status || !list) return;

    status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading snapshots...';
    list.innerHTML = '';
    if (preview) { preview.innerHTML = ''; preview.classList.add('vt-hidden'); }
    if (actions) actions.classList.add('vt-hidden');

    try {
        const snaps = await storageGetSnapshots(currentChar?.id);
        if (gen !== _renderGen) return;
        currentLocalSnapshots = snaps;
        selectedSnapshotId = null;

        if (!snaps.length) {
            status.innerHTML = '<i class="fa-solid fa-info-circle"></i><span>No snapshots yet - click <b>Save Snapshot</b> to create one</span>';
            return;
        }
        status.innerHTML = `<i class="fa-solid fa-bookmark"></i> ${snaps.length} snapshot${snaps.length !== 1 ? 's' : ''}`;
        renderSnapshotList(snaps);
    } catch (e) {
        if (gen !== _renderGen) return;
        console.error('[CharVersions] loadLocalSnapshots:', e);
        status.innerHTML = '<i class="fa-solid fa-xmark"></i> Error loading snapshots';
    }
}

function renderSnapshotList(snaps) {
    const list = el('.vt-list');
    list.innerHTML = snaps.map(s => {
        const date = new Date(s.timestamp);
        let icon;
        switch (s.source) {
            case 'chub_restore':  // legacy
            case 'remote_restore': icon = 'fa-cloud-arrow-down'; break;
            case 'auto_backup': icon = 'fa-shield-halved'; break;
            case 'assistant': icon = 'fa-wand-magic-sparkles'; break;
            default: icon = 'fa-bookmark';
        }
        return `
            <div class="vt-item" data-snapshot-id="${s.id}">
                <div class="vt-item-header">
                    <i class="fa-solid ${icon} vt-item-icon"></i>
                    <span class="vt-item-label">${esc(CoreAPI.truncate(s.label, 40))}</span>
                </div>
                <div class="vt-item-date">
                    <i class="fa-regular fa-clock"></i>
                    <span title="${esc(date.toLocaleString())}">${CoreAPI.formatRelativeAge(date)}</span>
                </div>
            </div>`;
    }).join('');
}

// ========================================
// SELECTION HANDLERS
// ========================================

async function selectVersion(shortId, fullId) {
    if (!currentProvider) return;
    const gen = _renderGen;
    selectedVersionRef = shortId;
    selectedSnapshotId = null;

    paneContainer.querySelectorAll('.vt-item').forEach(i =>
        i.classList.toggle('selected', i.dataset.ref === shortId)
    );

    updateActionsVisibility();
    el('.vt-container')?.classList.add('vt-detail-open');

    const preview = el('.vt-preview');
    preview.classList.remove('vt-hidden');
    preview.innerHTML = '<div class="vt-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading version data...</div>';

    const ref = fullId || shortId;
    const cacheKey = `${currentProvider.id}:${ref}`;

    try {
        let card;
        if (versionDataCache.has(cacheKey)) {
            card = versionDataCache.get(cacheKey);
        } else {
            card = await currentProvider.fetchVersionData(currentLinkInfo, ref);
            if (gen !== _renderGen) return;
            if (card) {
                if (versionDataCache.size >= VERSION_DATA_CACHE_MAX)
                    versionDataCache.delete(versionDataCache.keys().next().value);
                versionDataCache.set(cacheKey, card);
            }
        }
        if (!card) { preview.innerHTML = '<div class="vt-error"><i class="fa-solid fa-exclamation-triangle"></i> Could not load version data</div>'; return; }
        // remote tags ride the alias ruleset in the diff too (no phantom Tags diff); display copy only, restore aliases its own fetch
        const display = Array.isArray(card.tags) ? { ...card, tags: CoreAPI.applyTagAliases(card.tags) } : card;
        renderDiffPreview(preview, await localDiffData(), display);
        void resolveVersionWorldFileStatus(preview, currentChar?.id);
    } catch (e) {
        preview.innerHTML = '<div class="vt-error"><i class="fa-solid fa-xmark"></i> Error loading preview</div>';
    }
}

/** The provider page pseudo-version: a diff against the provider's metadata API (what the site shows, not the exported card.json). */
async function selectProviderPageVersion() {
    if (!currentProvider?.supportsRemotePageVersion) return;
    const gen = _renderGen;
    selectedVersionRef = '__provider_page__';
    selectedSnapshotId = null;

    paneContainer.querySelectorAll('.vt-item').forEach(i =>
        i.classList.toggle('selected', i.dataset.ref === '__provider_page__')
    );

    updateActionsVisibility();
    el('.vt-container')?.classList.add('vt-detail-open');

    const preview = el('.vt-preview');
    preview.classList.remove('vt-hidden');
    const provName = currentProvider.name;
    preview.innerHTML = `<div class="vt-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading ${esc(provName)} page data...</div>`;

    try {
        const card = await currentProvider.fetchRemotePageCard(currentLinkInfo);
        if (gen !== _renderGen) return;
        if (!card) { preview.innerHTML = '<div class="vt-error"><i class="fa-solid fa-xmark"></i> Could not load page data</div>'; return; }
        // Same display-copy aliasing as the version diff; banner reads stay on the raw card
        const display = Array.isArray(card.tags) ? { ...card, tags: CoreAPI.applyTagAliases(card.tags) } : { ...card };
        // a book that wouldnt read whole shows no difference, as the restore writes none
        if (card._lorebookUnread) display.character_book = (await localDiffData())?.character_book;
        renderDiffPreview(preview, await localDiffData(), display);

        const pageInfo = currentProvider.getRemotePageInfo();
        const banner = document.createElement('div');
        banner.className = 'vt-page-version-banner';
        let bannerText;
        if (card._lorebookUnread) {
            bannerText = `Character fields come from the ${esc(provName)} <strong>metadata API</strong>. Its <strong>linked lorebook</strong> could not be read, so no lorebook difference is shown and a restore keeps this character's lorebook as it is.`;
        } else if (card._linkedLorebook) {
            bannerText = `Character fields come from the ${esc(provName)} <strong>metadata API</strong>. The lorebook is a <strong>linked lorebook</strong> (separate project) resolved via a secondary API - the metadata API only stores ${card._metaLorebookEntries ?? 0} embedded entr${(card._metaLorebookEntries ?? 0) === 1 ? 'y' : 'ies'}.`;
        } else {
            bannerText = pageInfo?.description || `Shows the current state from the ${esc(provName)} metadata API.`;
        }
        banner.innerHTML = `<i class="fa-solid fa-globe"></i><span>${bannerText}</span>`;
        const header = preview.querySelector('.vt-preview-header');
        if (header) header.after(banner);

        void resolveVersionWorldFileStatus(preview, currentChar?.id);
    } catch (e) {
        preview.innerHTML = `<div class="vt-error"><i class="fa-solid fa-xmark"></i> Error loading ${esc(provName)} page data</div>`;
    }
}

async function selectSnapshot(id) {
    const gen = _renderGen;
    selectedSnapshotId = id;
    selectedVersionRef = null;

    paneContainer.querySelectorAll('.vt-item').forEach(i =>
        i.classList.toggle('selected', String(i.dataset.snapshotId) === String(id))
    );

    updateActionsVisibility();
    el('.vt-container')?.classList.add('vt-detail-open');

    const preview = el('.vt-preview');
    preview.classList.remove('vt-hidden');
    preview.innerHTML = '<div class="vt-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading snapshot...</div>';

    try {
        const charId = currentChar?.id;
        if (gen !== _renderGen) return;
        const snap = charId ? await storageGetSnapshot(charId, id) : null;
        if (gen !== _renderGen) return;
        if (!snap) { preview.innerHTML = '<div class="vt-error"><i class="fa-solid fa-exclamation-triangle"></i> Snapshot not found</div>'; return; }
        renderDiffPreview(preview, await localDiffData(), snap.data);
        void resolveVersionWorldFileStatus(preview, currentChar?.id);
    } catch {
        preview.innerHTML = '<div class="vt-error"><i class="fa-solid fa-xmark"></i> Error loading snapshot</div>';
    }
}

function updateActionsVisibility() {
    const actions = el('.vt-actions');
    if (!actions) return;

    const hasSelection = selectedVersionRef || selectedSnapshotId;
    actions.classList.toggle('vt-hidden', !hasSelection);

    const rename = actions.querySelector('.vt-rename');
    const del = actions.querySelector('.vt-delete');
    if (rename) rename.hidden = !(activeTab === 'local' && selectedSnapshotId);
    if (del) del.hidden = !(activeTab === 'local' && selectedSnapshotId);
}

// ========================================
// DIFF PREVIEW
// ========================================

// the extension namespaces a restore carries (providers, cl, depth_prompt); flat keys and orphan namespaces stay sticky
function getKnownProviderNamespaces() {
    const ids = CoreAPI.getAllProviders().map(p => p.id);
    return new Set([...ids, 'cl', 'depth_prompt']);
}

// a restore's flat-key writes, plus (given a live card) a clear for a key added since the snapshot; remote passes none
function buildFlatRestoreUpdates(target, live, keys = RESTORABLE_KEYS) {
    const updates = {};
    const carries = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
    for (const f of keys) {
        if (target?.[f] !== undefined) updates[f] = target[f];
        else if (live && carries(live[f])) updates[f] = null;
    }
    return updates;
}

// targetExt's allowlisted namespaces in, sentinel-deleting what it lacks; an empty targetExt (legacy snapshot) is a no-op
function buildNamespaceUpdates(targetExt, currentExt, deleteValue) {
    if (!targetExt || Object.keys(targetExt).length === 0) return {};
    const deletes = {}, wholes = {}, leaves = {}, clLeaves = {};
    for (const ns of getKnownProviderNamespaces()) {
        const tNs = targetExt[ns];
        const cNs = currentExt?.[ns];
        const tHas = tNs && typeof tNs === 'object';
        const cHas = cNs && typeof cNs === 'object';
        if (!tHas && !cHas) continue;
        if (!tHas) { deletes[`extensions.${ns}`] = deleteValue; continue; }
        if (!cHas) {
            // No link row yet, and the server refuses nested leaves without one: link it whole.
            if (Object.keys(tNs).length) wholes[`extensions.${ns}`] = tNs;
            continue;
        }
        const bucket = ns === 'cl' ? clLeaves : leaves;
        for (const [k, v] of Object.entries(tNs)) bucket[`extensions.${ns}.${k}`] = v;
        for (const k of Object.keys(cNs)) if (!(k in tNs)) bucket[`extensions.${ns}.${k}`] = deleteValue;
    }
    // key order matters: unlinks before whole link writes, cl leaves last (a link lift cant overwrite or undo the snapshot's cl)
    return { ...deletes, ...wholes, ...leaves, ...clLeaves };
}

// Derived Provider Link summary for the diff row; getCharacterProvider picks the first linked provider, so it's active-agnostic. fullPath is the user-meaningful slug.
function summarizeProviderLink(data) {
    const charLike = { data };
    const match = CoreAPI.getCharacterProvider(charLike);
    if (!match?.linkInfo) return 'Unlinked';
    const provider = match.provider;
    const ref = match.linkInfo.fullPath || match.linkInfo.full_path || match.linkInfo.id || '';
    return ref ? `${provider.name}: ${ref}` : provider.name;
}

// the diff's local side is the HYDRATED card: a write leaves the cache row slim, which diffs every heavy field
async function localDiffData() {
    if (currentChar?._slim) await CoreAPI.hydrateCharacter(currentChar);
    if (!currentChar || currentChar._slim) return null;
    return currentChar.data || currentChar;
}

function renderDiffPreview(previewEl, localData, compareData) {
    // No local side yet is said so, or every field would read as a change.
    if (!localData) {
        previewEl.innerHTML = `<div class="vt-preview-header"><i class="fa-solid fa-spinner fa-spin"></i> Character data still loading. Open the version diff again in a moment.</div>`;
        return;
    }

    // the card's rows are the one definition; provider rows are pushed behind them
    const fields = CARD_COMPARABLE_FIELDS.map(f => ({ key: f.key, label: f.label, icon: f.icon, long: !!f.long, isArray: !!f.array, optional: !!f.optional }));

    // CL-owned display fallbacks (no provider); gate hides each when neither side carries one.
    fields.push({ key: 'extensions.cl.tagline', label: 'Tagline', icon: 'fa-quote-left', optional: true });
    fields.push({ key: 'extensions.cl.pageName', label: 'Listing Name', icon: 'fa-tag', optional: true });

    // De-dup tracker so currentProvider.getComparableFields() and the all-providers loop dont push the same path twice.
    const seenPaths = new Set();

    // Active provider extras go first so currentProvider's labels win on collision.
    if (currentProvider?.getComparableFields) {
        for (const f of currentProvider.getComparableFields()) {
            const icon = f.icon ? f.icon.replace(/^fa-solid\s+/, '') : 'fa-file-alt';
            fields.push({ key: f.path, label: f.label, icon, optional: !!f.optional });
            seenPaths.add(f.path);
        }
    }

    // All known providers' tagline/pageName so stale orphan namespaces from prior links stay diffable; getAllProviders keeps provider.id correct (jannyai not janny).
    const allProviders = CoreAPI.getAllProviders();
    for (const p of allProviders) {
        const taglinePath = `extensions.${p.id}.tagline`;
        const pageNamePath = `extensions.${p.id}.pageName`;
        if (!seenPaths.has(taglinePath)) {
            fields.push({ key: taglinePath, label: `${p.name} Tagline`, icon: 'fa-quote-left', optional: true });
            seenPaths.add(taglinePath);
        }
        if (!seenPaths.has(pageNamePath)) {
            fields.push({ key: pageNamePath, label: `${p.name} Listing Name`, icon: 'fa-tag', optional: true });
            seenPaths.add(pageNamePath);
        }
    }

    let diffCount = 0;
    let html = '';

    // the snapshot's embedded image beats the live URL (the PNG may be overwritten); _avatarUrl is relative, absolutize here
    const avatarUrl = compareData._avatarImageData
        || (compareData._avatarUrl ? CoreAPI.serverUrl(compareData._avatarUrl) : '');
    if (avatarUrl) {
        html += renderAvatarPreview(avatarUrl);
    }

    const localLink = summarizeProviderLink(localData);
    const remoteLink = summarizeProviderLink(compareData);
    if (localLink !== remoteLink) {
        const linkRendered = renderShortDiff({ label: 'Provider Link', icon: 'fa-link' }, localLink, remoteLink);
        if (linkRendered) { diffCount++; html += linkRendered; }
    }

    for (const f of fields) {
        const lv = readCardField(localData, f.key);
        const rv = readCardField(compareData, f.key);

        // Skip only when BOTH sides are empty, else a cleared-from-snapshot deletion would never show.
        if (f.optional && (rv == null || rv === '') && (lv == null || lv === '')) continue;

        // Lorebook needs semantic comparison (ST adds internal fields like uid, display_index)
        if (f.key === 'character_book') {
            if (lorebooksEqual(lv, rv, { normalizeKeys: false })) continue;
            const lbHtml = renderLorebookDiff(f, lv, rv);
            if (!lbHtml) continue;
            diffCount++;
            html += lbHtml;
            continue;
        }

        if (cardValuesEqual(lv, rv, f.key)) continue;

        const rendered = (() => {
            if (f.key === 'tags') return renderTagsDiff(f, lv, rv);
            if (f.isArray) return renderGreetingsDiff(f, lv, rv);
            if (f.long) return renderLongDiff(f, lv, rv);
            return renderShortDiff(f, lv, rv);
        })();
        if (!rendered) continue;
        diffCount++;
        html += rendered;
    }

    // the avatar block renders whatever differs, so the count decides, never the html
    if (diffCount === 0) {
        previewEl.innerHTML = `<div class="vt-preview-header"><i class="fa-solid fa-check text-success"></i> Identical to your current local card.</div>${html ? `<div class="vt-diff-list">${html}</div>` : ''}`;
        return;
    }

    previewEl.innerHTML = `
        <div class="vt-preview-header">
            <i class="fa-solid fa-arrow-right-arrow-left"></i>
            ${diffCount} field${diffCount !== 1 ? 's differ' : ' differs'} from local
        </div>
        <div class="vt-diff-list">${html}</div>
    `;
}

function renderAvatarPreview(avatarUrl) {
    if (!avatarUrl) return '';
    return `
        <div class="vt-avatar-preview">
            <span class="vt-diff-label">Avatar</span>
            <img class="vt-avatar-thumb" src="${esc(avatarUrl)}" alt="Version avatar"
                 onerror="this.hidden=true" loading="lazy" />
            <button class="vt-btn vt-apply-avatar" data-avatar-url="${esc(avatarUrl)}"
                    title="Apply this avatar to the character">
                <i class="fa-solid fa-file-import"></i>
            </button>
        </div>
    `;
}

function fieldIcon(field) {
    return field.icon ? `<i class="fa-solid ${field.icon} vt-field-icon"></i>` : '';
}

function renderShortDiff(field, lv, rv) {
    const ls = fmtVal(lv), rs = fmtVal(rv);
    return `
        <div class="vt-diff-item short">
            <span class="vt-diff-label">${fieldIcon(field)}${esc(field.label)}</span>
            <div class="vt-diff-vals">
                <span class="vt-local" title="${esc(ls)}">${esc(CoreAPI.truncate(ls, 60))}</span>
                <i class="fa-solid fa-arrow-right"></i>
                <span class="vt-remote" title="${esc(rs)}">${esc(CoreAPI.truncate(rs, 60))}</span>
            </div>
        </div>`;
}

function renderLongDiff(field, lv, rv) {
    const ls = fmtVal(lv), rs = fmtVal(rv);
    const diff = CoreAPI.computeLineDiff(ls.split('\n'), rs.split('\n'));
    let added = 0, removed = 0;
    diff.forEach(d => { if (d.type === 'added') added++; if (d.type === 'removed') removed++; });
    const totalLines = diff.length;

    const stats = [];
    if (added) stats.push(`<span class="vt-stat added">+${added}</span>`);
    if (removed) stats.push(`<span class="vt-stat removed">-${removed}</span>`);

    const lines = diff.map(d => {
        const e = esc(d.line);
        if (d.type === 'added') return `<div class="vt-diff-line added"><span class="vt-prefix">+</span>${e}</div>`;
        if (d.type === 'removed') return `<div class="vt-diff-line removed"><span class="vt-prefix">-</span>${e}</div>`;
        return `<div class="vt-diff-line ctx"><span class="vt-prefix"> </span>${e}</div>`;
    }).join('');

    // Auto-expand small diffs (8 lines or fewer)
    const autoExpand = totalLines <= 8 ? ' expanded' : '';

    return `
        <div class="vt-diff-item long${autoExpand}">
            <div class="vt-diff-header">
                <span class="vt-diff-label">${fieldIcon(field)}${esc(field.label)}</span>
                <div class="vt-diff-stats">${stats.join(' ')}</div>
                <i class="fa-solid fa-chevron-down vt-expand-icon"></i>
            </div>
            <div class="vt-diff-content">${lines || '<div class="vt-diff-line ctx">(empty)</div>'}</div>
        </div>`;
}

function renderTagsDiff(field, localTags, remoteTags) {
    const local = Array.isArray(localTags) ? localTags.map(t => String(t).trim()).filter(Boolean) : [];
    const remote = Array.isArray(remoteTags) ? remoteTags.map(t => String(t).trim()).filter(Boolean) : [];
    const localSet = new Set(local.map(t => t.toLowerCase()));
    const remoteSet = new Set(remote.map(t => t.toLowerCase()));

    const added = remote.filter(t => !localSet.has(t.toLowerCase()));
    const removed = local.filter(t => !remoteSet.has(t.toLowerCase()));
    const kept = local.filter(t => remoteSet.has(t.toLowerCase()));

    if (!added.length && !removed.length) return '';

    const stats = [];
    if (added.length) stats.push(`<span class="vt-stat added">+${added.length}</span>`);
    if (removed.length) stats.push(`<span class="vt-stat removed">-${removed.length}</span>`);

    const pills = [
        ...removed.map(t => `<span class="vt-tag-pill removed" title="Removed">${esc(t)}</span>`),
        ...added.map(t => `<span class="vt-tag-pill added" title="Added">${esc(t)}</span>`),
        ...kept.map(t => `<span class="vt-tag-pill">${esc(t)}</span>`),
    ].join('');

    return `
        <div class="vt-diff-item long expanded">
            <div class="vt-diff-header">
                <span class="vt-diff-label">${fieldIcon(field)}${esc(field.label)}</span>
                <div class="vt-diff-stats">${stats.join(' ')}</div>
                <i class="fa-solid fa-chevron-down vt-expand-icon"></i>
            </div>
            <div class="vt-diff-content vt-tag-content">
                <div class="vt-tag-pills">${pills || '<span class="vt-empty">(no tags)</span>'}</div>
            </div>
        </div>`;
}

function renderGreetingsDiff(field, localGreets, remoteGreets) {
    const local = Array.isArray(localGreets) ? localGreets : [];
    const remote = Array.isArray(remoteGreets) ? remoteGreets : [];
    const max = Math.max(local.length, remote.length);

    const stats = [];
    if (remote.length > local.length) stats.push(`<span class="vt-stat added">+${remote.length - local.length}</span>`);
    if (local.length > remote.length) stats.push(`<span class="vt-stat removed">-${local.length - remote.length}</span>`);

    let blocks = '';
    for (let i = 0; i < max; i++) {
        const lv = typeof local[i] === 'string' ? local[i] : '';
        const rv = typeof remote[i] === 'string' ? remote[i] : '';
        if (lv === rv) continue;

        const isNew = i >= local.length;
        const isRemoved = i >= remote.length;
        let badge = '';
        if (isNew) badge = '<span class="vt-greeting-badge added">new</span>';
        else if (isRemoved) badge = '<span class="vt-greeting-badge removed">removed</span>';
        else badge = '<span class="vt-greeting-badge changed">changed</span>';

        let content;
        if (isNew) {
            content = `<div class="vt-diff-line added"><span class="vt-prefix">+</span>${esc(rv)}</div>`;
        } else if (isRemoved) {
            content = `<div class="vt-diff-line removed"><span class="vt-prefix">-</span>${esc(lv)}</div>`;
        } else {
            const diff = CoreAPI.computeLineDiff(lv.split('\n'), rv.split('\n'));
            content = diff.map(d => {
                const e = esc(d.line);
                if (d.type === 'added') return `<div class="vt-diff-line added"><span class="vt-prefix">+</span>${e}</div>`;
                if (d.type === 'removed') return `<div class="vt-diff-line removed"><span class="vt-prefix">-</span>${e}</div>`;
                return `<div class="vt-diff-line ctx"><span class="vt-prefix"> </span>${e}</div>`;
            }).join('');
        }

        blocks += `
            <div class="vt-greeting-block">
                <div class="vt-greeting-header">
                    <i class="fa-solid fa-chevron-right vt-greeting-expand-icon"></i>
                    #${i + 1} ${badge}
                </div>
                <div class="vt-greeting-body">${content}</div>
            </div>`;
    }

    if (!blocks) return '';

    return `
        <div class="vt-diff-item long">
            <div class="vt-diff-header">
                <span class="vt-diff-label">${fieldIcon(field)}${esc(field.label)}</span>
                <div class="vt-diff-stats">${stats.join(' ')}</div>
                <i class="fa-solid fa-chevron-down vt-expand-icon"></i>
            </div>
            <div class="vt-diff-content vt-greetings-content">${blocks}</div>
        </div>`;
}

// ========================================
// VERSION ACTIONS
// ========================================

async function restoreVersion() {
    // captured once: a pane opened on another character while this runs repoints the module state
    const char = currentChar, gen = _renderGen, tab = activeTab, ref = selectedVersionRef;
    const provider = currentProvider, linkInfo = currentLinkInfo, snapId = selectedSnapshotId;
    if (!char) return;

    let cardData = null;
    let label = '';
    let keepBook = false;

    if (tab === 'remote' && ref === '__provider_page__' && provider?.supportsRemotePageVersion) {
        cardData = await provider.fetchRemotePageCard(linkInfo);
        if (!cardData) { CoreAPI.showToast('Could not fetch page data', 'error'); return; }
        // a book the provider couldnt read whole is unknown: the character keeps its own
        keepBook = !!cardData._lorebookUnread;
        label = `${provider.name} metadata API state`;
    } else if (tab === 'remote' && ref && provider) {
        const raw = await provider.fetchVersionData(linkInfo, ref);
        if (!raw) { CoreAPI.showToast('Could not fetch version data', 'error'); return; }
        cardData = raw; // provider returns flat card fields
        label = `${provider.name} version ${ref}`;
    } else if (tab === 'local' && snapId) {
        let snap = null;
        try {
            snap = await storageGetSnapshot(char.id, snapId);
        } catch {
            CoreAPI.showToast('Could not read the stored snapshots', 'error');
            return;
        }
        if (!snap) { CoreAPI.showToast('Snapshot not found', 'error'); return; }
        cardData = snap.data;
        label = `snapshot "${snap.label}"`;
    } else {
        CoreAPI.showToast('Nothing selected', 'warning');
        return;
    }
    // the pane that asked is gone: nothing is asked over a character thats left the screen
    if (gen !== _renderGen) return;

    // remote tags ride the alias ruleset like card-updates applies (or raw tags come back); local snapshots stay byte-faithful
    if (tab === 'remote' && Array.isArray(cardData?.tags)) {
        cardData.tags = CoreAPI.applyTagAliases(cardData.tags);
    }

    const name = char.data?.name || char.name || 'Unknown';
    const ok = await CoreAPI.showConfirm({
        title: 'Restore Version',
        message: `Overwrite "${name}" with ${label}?`,
        confirmLabel: 'Restore',
        danger: true,
        content: [
            ...(keepBook ? [{ type: 'note', text: `Its linked lorebook could not be read from ${provider.name}, so the lorebook stays as it is.` }] : []),
            { type: 'note', text: 'The current state is backed up first.' },
        ],
    });
    if (!ok) return;

    // confirmed for a named character: the restore lands there whatever the pane shows now
    try {
        paneStatus(gen, '<i class="fa-solid fa-spinner fa-spin"></i> Restoring...');
        const curData = await extractCardData(char);
        await storageSaveBackup(char.id, curData);

        const ts = new Date().toLocaleString();
        await storageSaveSnapshot(name,
            `Restore - ${ts}`, 'auto_backup', curData, char.id);

        const updates = {};
        // the embedded book is written whole or cleared; a restore touches no linked lorebook
        const hasLocalBook = char.data?.character_book?.entries?.length > 0;
        const hasTargetBook = cardData.character_book?.entries?.length > 0;
        if (keepBook) {
            // an unread book writes nothing
        } else if (hasTargetBook) {
            updates.character_book = cardData.character_book;
        } else if (hasLocalBook) {
            updates.character_book = null;
        }
        // a key a local snapshot lacks was added since; a remote card lacking a field is unknown and clears nothing
        Object.assign(updates, buildFlatRestoreUpdates(cardData, tab === 'local' ? char.data : null, RESTORABLE_KEYS.filter(k => k !== 'character_book')));

        // namespace-level restore: the snapshot's namespace shape in, absent leaves sentinel-deleted; flat keys stay sticky
        const deleteValue = await CoreAPI.getExtensionDeleteValue();
        const nsUpdates = buildNamespaceUpdates(cardData?.extensions, char.data?.extensions, deleteValue);
        Object.assign(updates, nsUpdates);

        const { ok: success, told } = await CoreAPI.writeCardFields(char, updates);

        if (success) {
            if (tab === 'remote' && ref && provider) {
                const snapLabel = ref === '__provider_page__'
                    ? `${provider.name} metadata API (restored)` : `${provider.name} v${ref} (restored)`;
                const restoredTag = ref === '__provider_page__'
                    ? 'provider_page' : ref;
                // the record holds the book the character kept, never the part that read
                await storageSaveSnapshot(name,
                    snapLabel, 'remote_restore', keepBook ? { ...cardData, character_book: curData.character_book } : cardData, char.id);
                const extKey = `extensions.${provider.id}`;
                await CoreAPI.writeCardFields(char, {
                    [`${extKey}.restored_version`]: restoredTag,
                    [`${extKey}.restored_at`]: new Date().toISOString()
                });
            }
            CoreAPI.showToast(`Restored ${label}`, 'success');
            paneStatus(gen, '<i class="fa-solid fa-check text-success"></i> Restored');
            await CoreAPI.refreshCharacters(true);
        } else {
            if (!told) CoreAPI.showToast('Restore failed', 'error');
            paneStatus(gen, '<i class="fa-solid fa-xmark"></i> Restore failed');
        }
    } catch (e) {
        console.error('[CharVersions] restore:', e);
        CoreAPI.showToast('Error: ' + e.message, 'error');
        paneStatus(gen, '<i class="fa-solid fa-xmark"></i> Restore failed');
    }
}

async function undoRestore() {
    // captured once, as restoreVersion does
    const char = currentChar, gen = _renderGen, provider = currentProvider;
    if (!char) return;
    let backup = null;
    try {
        backup = await storageGetBackup(char.id);
    } catch {
        CoreAPI.showToast('Could not read the stored backup', 'error');
        return;
    }
    if (!backup) { CoreAPI.showToast('No backup found', 'warning'); return; }
    if (gen !== _renderGen) return;

    const name = char.data?.name || char.name || 'Unknown';
    const ok = await CoreAPI.showConfirm({
        title: 'Undo Restore',
        message: `Revert "${name}" to its pre-restore state?`,
        confirmLabel: 'Revert',
        danger: true,
        content: [{ type: 'stats', items: [{ icon: 'fa-solid fa-calendar', label: 'backup from', value: new Date(backup.timestamp).toLocaleString() }] }],
    });
    if (!ok) return;

    paneStatus(gen, '<i class="fa-solid fa-spinner fa-spin"></i> Undoing...');

    try {
        // Cherry-pick the restorable keys so we never write the synthetic _avatarUrl, then diff backup vs current namespaces so restore-introduced namespaces get sentinel-deleted.
        const deleteValue = await CoreAPI.getExtensionDeleteValue();
        const undoUpdates = {};
        Object.assign(undoUpdates, buildFlatRestoreUpdates(backup.data, char.data));
        const undoNsUpdates = buildNamespaceUpdates(backup.data?.extensions, char.data?.extensions, deleteValue);
        Object.assign(undoUpdates, undoNsUpdates);
        const { ok: s, told } = await CoreAPI.writeCardFields(char, undoUpdates);
        if (s) {
            await storageClearBackup(char.id);
            const provId = provider?.id;
            if (provId) {
                const extKey = `extensions.${provId}`;
                await CoreAPI.writeCardFields(char, {
                    [`${extKey}.restored_version`]: null,
                    [`${extKey}.restored_at`]: null
                });
            }
            CoreAPI.showToast('Backup restored', 'success');
            paneStatus(gen, '<i class="fa-solid fa-check text-success"></i> Restored');
            await CoreAPI.refreshCharacters(true);
        } else {
            if (!told) CoreAPI.showToast('Undo failed', 'error');
            paneStatus(gen, '<i class="fa-solid fa-xmark"></i> Failed');
        }
    } catch (e) {
        console.error('[CharVersions] undo:', e);
        CoreAPI.showToast('Error undoing restore', 'error');
    }
}

async function handleApplyAvatar(avatarUrl) {
    // captured once, as restoreVersion does
    const char = currentChar, gen = _renderGen;
    if (!char || !avatarUrl) return;

    const name = char.data?.name || char.name || 'Unknown';
    const ok = await CoreAPI.showConfirm({
        title: 'Apply Avatar',
        message: `Replace "${name}"'s avatar with this version's image?`,
        confirmLabel: 'Replace avatar',
    });
    if (!ok) return;

    paneStatus(gen, '<i class="fa-solid fa-spinner fa-spin"></i> Applying avatar...');

    try {
        // Back up the current avatar before it's overwritten so the outgoing image stays restorable via Apply Avatar.
        await autoSnapshotBeforeChange(char, 'edit', { embedAvatar: true });

        const imgResp = await fetch(avatarUrl);
        if (!imgResp.ok) throw new Error(`Failed to fetch image: ${imgResp.status}`);
        const blob = await imgResp.blob();

        await CoreAPI.editAvatar(char.id, blob);
        CoreAPI.showToast('Avatar updated', 'success');
        paneStatus(gen, '<i class="fa-solid fa-check text-success"></i> Avatar applied');
        await CoreAPI.refreshCharacters(true);
    } catch (e) {
        console.error('[CharVersions] apply avatar:', e);
        CoreAPI.showToast('Error applying avatar: ' + e.message, 'error');
        paneStatus(gen, '<i class="fa-solid fa-xmark"></i> Avatar update failed');
    }
}

async function handleSaveSnapshot() {
    // the character the label was asked for, whatever the pane shows once it is typed
    const char = currentChar;
    if (!char) return;
    const label = await CoreAPI.showConfirm({ title: 'Save Snapshot', message: 'Label for this snapshot:', confirmLabel: 'Save',
        input: { value: `Snapshot ${new Date().toLocaleString()}` } });
    if (!label) return;

    try {
        const saved = await runCommand('character.snapshot', { id: char.id, label, char });
        if (saved?.snapshot == null) {
            CoreAPI.showToast('Snapshot not saved', 'warning');
            return;
        }
        CoreAPI.showToast(`Snapshot saved: "${saved.label ?? label}"`, 'success');
    } catch (e) {
        console.error('[CharVersions] save snapshot:', e);
        CoreAPI.showToast(`Snapshot not saved: ${e.message}`, 'error', 8000);
    }
}

async function handleDeleteSnapshot() {
    // captured once, as restoreVersion does
    const char = currentChar, gen = _renderGen, snapId = selectedSnapshotId;
    if (!snapId) return;
    const s = currentLocalSnapshots.find(s => s.id === snapId);
    if (!s) return;

    const ok = await CoreAPI.showConfirm({
        title: 'Delete Snapshot',
        message: `Delete "${s.label}"?`,
        confirmLabel: 'Delete',
        danger: true,
        content: [{ type: 'note', tone: 'danger', text: 'This cannot be undone.' }],
    });
    if (!ok) return;

    try {
        await storageDeleteSnapshot(char?.id, snapId);
        CoreAPI.showToast('Snapshot deleted', 'success');
        if (gen !== _renderGen) return;
        selectedSnapshotId = null;
        const preview = el('.vt-preview');
        if (preview) { preview.innerHTML = ''; preview.classList.add('vt-hidden'); }
        el('.vt-actions')?.classList.add('vt-hidden');
        await loadLocalSnapshots();
    } catch (e) {
        CoreAPI.showToast('Error deleting snapshot', 'error');
    }
}

async function handleRenameSnapshot() {
    // captured once, as restoreVersion does
    const char = currentChar, gen = _renderGen, snapId = selectedSnapshotId;
    if (!snapId) return;
    const s = currentLocalSnapshots.find(s => s.id === snapId);
    if (!s) return;

    const newLabel = await CoreAPI.showConfirm({ title: 'Rename Snapshot', message: 'New label:', confirmLabel: 'Rename', input: { value: s.label } });
    if (!newLabel || newLabel === s.label) return;

    try {
        await storageRenameSnapshot(char?.id, snapId, newLabel);
        CoreAPI.showToast('Snapshot renamed', 'success');
        if (gen === _renderGen) await loadLocalSnapshots();
    } catch (e) {
        CoreAPI.showToast('Error renaming', 'error');
    }
}

// ========================================
// NORMALIZATION & HELPERS
// ========================================

// ========================================
// LOREBOOK DIFF
// ========================================

function renderLorebookDiff(field, localBook, remoteBook) {
    const localEntries = localBook?.entries || [];
    const remoteEntries = remoteBook?.entries || [];
    const { matched, added, removed } = matchLorebookEntries(localEntries, remoteEntries, { normalizeKeys: false });
    const modified = matched.filter(m => m.changedFields.length > 0);
    const metaDiffs = compareLorebookMeta(localBook, remoteBook);

    const localOnly = removed;

    if (added.length === 0 && localOnly.length === 0 && modified.length === 0 && metaDiffs.length === 0) return '';

    const statParts = [];
    if (added.length > 0) statParts.push(`<span class="vt-stat added">+${added.length} new</span>`);
    if (localOnly.length > 0) statParts.push(`<span class="vt-stat local-only">${localOnly.length} local only</span>`);
    if (modified.length > 0) statParts.push(`<span class="vt-stat changed">${modified.length} modified</span>`);
    if (metaDiffs.length > 0) statParts.push(`<span class="vt-stat changed">${metaDiffs.length} setting${metaDiffs.length > 1 ? 's' : ''}</span>`);
    const stats = statParts.join(' ');

    let sectionsHtml = '';

    // Settings section
    if (metaDiffs.length > 0) {
        sectionsHtml += `<div class="vt-lb-section">
            <div class="vt-lb-section-header" title="Click to expand">
                <i class="fa-solid fa-gear vt-lb-section-icon"></i>
                <span class="vt-lb-section-title">${metaDiffs.length} setting${metaDiffs.length > 1 ? 's' : ''} changed</span>
                <i class="fa-solid fa-chevron-down vt-lb-section-chevron"></i>
            </div>
            <div class="vt-lb-section-body">
                ${metaDiffs.map(m => `<div class="vt-lb-meta-row">
                    <span class="vt-lb-meta-key">${esc(m.label)}</span>
                    <span class="vt-lb-meta-old">${esc(m.localStr)}</span>
                    <i class="fa-solid fa-arrow-right"></i>
                    <span class="vt-lb-meta-new">${esc(m.remoteStr)}</span>
                </div>`).join('')}
            </div>
        </div>`;
    }

    // New entries section
    if (added.length > 0) {
        const autoExpand = added.length <= 5;
        sectionsHtml += `<div class="vt-lb-section${autoExpand ? ' expanded' : ''}">
            <div class="vt-lb-section-header" title="Click to expand">
                <span class="vt-lb-badge added">+</span>
                <span class="vt-lb-section-title">${added.length} new from remote</span>
                <i class="fa-solid fa-chevron-down vt-lb-section-chevron"></i>
            </div>
            <div class="vt-lb-section-body">
                ${added.map(entry => {
                    const name = lorebookEntryName(entry);
                    const keys = (entry.keys || []).slice(0, 4).join(', ');
                    return `<div class="vt-lb-entry added">
                        <span class="vt-lb-name">${esc(name)}</span>
                        ${keys ? `<span class="vt-lb-keys">${esc(keys)}</span>` : ''}
                    </div>`;
                }).join('')}
            </div>
        </div>`;
    }

    // Local-only entries section
    if (localOnly.length > 0) {
        const autoExpand = localOnly.length <= 5;
        sectionsHtml += `<div class="vt-lb-section${autoExpand ? ' expanded' : ''}">
            <div class="vt-lb-section-header" title="Click to expand">
                <span class="vt-lb-badge local-only">&#9733;</span>
                <span class="vt-lb-section-title">${localOnly.length} local-only (not in this version)</span>
                <i class="fa-solid fa-chevron-down vt-lb-section-chevron"></i>
            </div>
            <div class="vt-lb-section-body">
                ${localOnly.map(entry => {
                    const name = lorebookEntryName(entry);
                    const keys = (entry.keys || []).slice(0, 4).join(', ');
                    const keysJson = esc(JSON.stringify(entry.keys || []));
                    const entryComment = esc(entry.comment || entry.name || '');
                    return `<div class="vt-lb-entry local-only" data-lb-keys="${keysJson}" data-lb-name="${entryComment}">
                        <span class="vt-lb-name">${esc(name)}</span>
                        <span class="vt-lb-world-check"><i class="fa-solid fa-spinner fa-spin u-text-3xs u-dim-50"></i></span>
                        ${keys ? `<span class="vt-lb-keys">${esc(keys)}</span>` : ''}
                    </div>`;
                }).join('')}
            </div>
        </div>`;
    }

    // Modified entries section
    if (modified.length > 0) {
        const autoExpand = modified.length <= 5;
        sectionsHtml += `<div class="vt-lb-section${autoExpand ? ' expanded' : ''}">
            <div class="vt-lb-section-header" title="Click to expand">
                <span class="vt-lb-badge modified">~</span>
                <span class="vt-lb-section-title">${modified.length} modified</span>
                <i class="fa-solid fa-chevron-down vt-lb-section-chevron"></i>
            </div>
            <div class="vt-lb-section-body">
                ${modified.map(m => {
                    const name = lorebookEntryName(m.remote);
                    const changes = m.changedFields.join(', ');
                    return `<div class="vt-lb-entry modified">
                        <span class="vt-lb-name">${esc(name)}</span>
                        <span class="vt-lb-changes">${esc(changes)}</span>
                    </div>`;
                }).join('')}
            </div>
        </div>`;
    }

    // Unchanged summary
    const unchangedCount = matched.length - modified.length;
    if (unchangedCount > 0) {
        sectionsHtml += `<div class="vt-lb-unchanged-row">
            <span class="vt-lb-unchanged">${unchangedCount} unchanged entr${unchangedCount === 1 ? 'y' : 'ies'}</span>
        </div>`;
    }

    const mergedCount = matched.length + added.length + localOnly.length;

    return `
        <div class="vt-diff-item long" data-local-only-count="${localOnly.length}">
            <div class="vt-diff-header vt-lb-header">
                <div class="vt-lb-header-top">
                    <span class="vt-diff-label">${fieldIcon(field)}${esc(field.label)}
                        <span class="vt-lb-counts">
                            <span>${localEntries.length}</span>
                            <i class="fa-solid fa-arrow-right"></i>
                            <span>${mergedCount}</span>
                        </span>
                    </span>
                    <i class="fa-solid fa-chevron-down vt-expand-icon"></i>
                </div>
                <div class="vt-lb-stat-row">${stats}</div>
            </div>
            <div class="vt-diff-content vt-lb-content">
                ${sectionsHtml}
            </div>
        </div>
    `;
}

async function resolveVersionWorldFileStatus(containerEl, charId) {
    if (!containerEl || !charId) return;
    const rows = containerEl.querySelectorAll('.vt-lb-entry.local-only[data-lb-keys]');
    if (rows.length === 0) return;

    const clearSpinners = (reason) => {
        for (const row of rows) {
            const check = row.querySelector('.vt-lb-world-check');
            if (check) { check.innerHTML = ''; check.title = reason; }
        }
    };

    try {
        // the server answers the head of the char_worlds list; the old name-guess
        // fallback existed only because the cache read returned null for slim chars
        const worldName = await CoreAPI.getCharacterWorldName(charId);

        if (!worldName) { clearSpinners('No linked lorebook found.'); return; }

        let worldData;
        try { worldData = await CoreAPI.getWorldInfoData(worldName); } catch (_) { /* fetch failed */ }

        if (!worldData?.entries) { clearSpinners(`The linked lorebook "${worldName}" could not be read.`); return; }

        const worldEntries = Object.values(worldData.entries).filter(e => e && typeof e === 'object');

        for (const row of rows) {
            let entryKeys;
            try { entryKeys = JSON.parse(row.dataset.lbKeys || '[]'); } catch (_) { entryKeys = []; }
            const found = entryInWorld({ keys: entryKeys, name: row.dataset.lbName }, worldEntries);

            const check = row.querySelector('.vt-lb-world-check');
            if (found) {
                if (check) {
                    check.innerHTML = '<i class="fa-solid fa-shield-halved text-success-pale u-text-2xs"></i>';
                    check.title = `Also in the linked lorebook "${worldName}"`;
                }
            } else {
                if (check) {
                    check.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-warning-pale u-text-2xs"></i>';
                    check.title = `Not in the linked lorebook "${worldName}"`;
                }
            }
        }
    } catch (err) {
        console.error('[CharVersions] resolveVersionWorldFileStatus error:', err);
        clearSpinners('The linked lorebook check failed.');
    }
}

function fmtVal(v) {
    if (v == null) return '(empty)';
    if (Array.isArray(v)) return v.length ? v.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(', ') : '(empty)';
    if (typeof v === 'string' && !v.trim()) return '(empty)';
    if (typeof v === 'object') return JSON.stringify(v, null, 2);
    return String(v);
}

function esc(s) { return CoreAPI.escapeHtml(s); }


// ========================================
// EXPORTS
// ========================================

export default {
    init,
    openVersionHistory,
    renderVersionsPane,
    cleanupVersionsPane,
    autoSnapshotBeforeChange
};
