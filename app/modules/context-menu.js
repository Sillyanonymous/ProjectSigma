import * as CoreAPI from './core-api.js';
import { actionsFor as extActionsFor, runAction as extRunAction } from './extension-host.js';
import { defineCommand, runCommand } from './ext-registry.js';

async function copyLinks(urls) {
    if (!(await CoreAPI.copyTextToClipboard(urls.join('\n')))) throw new Error('The clipboard refused the links');
}

let isInitialized = false;
let menuElement = null;

export function init(deps) {
    if (isInitialized) {
        console.warn('[ContextMenu] Already initialized');
        return;
    }
    
    createMenu();
    setupGlobalListeners();
    defineCommand('character.export', exportCharactersFrom, { title: 'Export characters' });

    window.registerOverlay?.({
        id: 'clContextMenu',
        tier: 8,
        close: () => hide(),
        visible: (el) => el.classList.contains('visible'),
    });

    isInitialized = true;
    CoreAPI.debugLog('[ContextMenu] Module initialized');
}

function createMenu() {
    menuElement = document.createElement('div');
    menuElement.id = 'clContextMenu';
    menuElement.className = 'cl-context-menu';
    document.body.appendChild(menuElement);
}

function setupGlobalListeners() {
    document.addEventListener('click', (e) => {
        if (!menuElement.contains(e.target)) {
            hide();
        }
    });
    
    // a tall menu scrolls itself to reach its lower rows; only a scroll elsewhere closes it
    document.addEventListener('scroll', (e) => {
        if (menuElement.contains(e.target)) return;
        hide();
    }, true);

    // Delegated so cards created before the module loaded still get a menu
    document.addEventListener('contextmenu', (e) => {
        const card = e.target.closest('.char-card');
        if (card) {
            const charId = card.dataset.charId;
            if (charId) {
                const char = CoreAPI.getCharacterById(charId);
                if (char) {
                    show(e, char, card);
                }
            }
        }
    });
}

export function show(event, char, cardElement) {
    event.preventDefault();
    event.stopPropagation();
    
    const menuItems = buildMenuItems(char, cardElement);
    renderMenu(menuItems);
    
    // Force layout for measurement
    menuElement.style.visibility = 'hidden';
    menuElement.classList.add('visible');
    
    positionMenu(event.clientX, event.clientY);
    
    menuElement.style.visibility = '';
}

/** A menu of the caller's own items on the same surface (and phone sheet), no character behind it; `at` anchors to a point. */
export function showItems(event, items, at = null) {
    if (!menuElement) return;
    event.preventDefault();
    event.stopPropagation();
    renderMenu(items);
    menuElement.style.visibility = 'hidden';
    menuElement.classList.add('visible');
    positionMenu(at ? at.x : event.clientX, at ? at.y : event.clientY);
    menuElement.style.visibility = '';
}

export function hide() {
    menuElement.classList.remove('visible');
}

function buildMenuItems(char, cardElement) {
    const isSelected = CoreAPI.isCharacterSelected(char.id);
    const selectionCount = CoreAPI.getSelectionCount();
    
    if (isSelected && selectionCount > 1) {
        return buildBulkMenuItems(selectionCount);
    }
    
    return buildSingleMenuItems(char, cardElement);
}

function buildBulkMenuItems(count) {
    const items = [];
    
    items.push({
        type: 'header',
        label: `${count} Characters Selected`
    });
    
    items.push({
        icon: 'fa-solid fa-tags',
        label: 'Edit Tags',
        action: () => {
            const batchTagging = CoreAPI.getModule('batch-tagging');
            if (batchTagging?.openModal) {
                batchTagging.openModal();
            }
        }
    });
    
    // Bulk check for updates (provider-linked only)
    items.push({
        icon: 'fa-solid fa-arrows-rotate',
        label: 'Check for Updates',
        action: () => {
            const cardUpdates = CoreAPI.getModule('card-updates');
            if (cardUpdates?.checkSelectedCharacters) {
                cardUpdates.checkSelectedCharacters();
            }
        }
    });

    items.push({
        icon: 'fa-solid fa-list-ul',
        label: 'Add to Playlist',
        action: () => {
            const selection = CoreAPI.getSelection();
            if (selection.count) CoreAPI.openPlaylistPicker(selection);
        }
    });
    
    items.push({ type: 'separator' });
    
    items.push({
        icon: 'fa-solid fa-star',
        label: 'Add All to Favorites',
        action: () => bulkToggleFavorites(true)
    });
    
    items.push({
        icon: 'fa-regular fa-star',
        label: 'Remove All from Favorites',
        action: () => bulkToggleFavorites(false)
    });
    
    items.push({ type: 'separator' });
    
    items.push({
        icon: 'fa-solid fa-download',
        label: 'Export All',
        action: () => bulkExport()
    });

    items.push({ type: 'separator' });

    // extension bulk verbs behind their own separator, with the selection bar's contexts; the phone sheet clones this menu
    const bulk = CoreAPI.getModule('multi-select');
    const extActs = bulk ? extActionsFor('bulk', bulk.bulkWhenContext()) : [];
    if (extActs.length) {
        for (const a of extActs) items.push({ icon: `fa-solid ${a.icon}`, label: a.label, action: () => bulk.runBulkAction(a.key) });
        items.push({ type: 'separator' });
    }

    items.push({
        icon: 'fa-solid fa-trash',
        label: 'Delete All',
        className: 'danger',
        action: () => bulkDelete()
    });
    
    items.push({ type: 'separator' });
    
    items.push({
        icon: 'fa-solid fa-xmark',
        label: 'Clear Selection',
        className: 'secondary',
        action: () => runCommand('library.select', { clear: true })
    });
    
    return items;
}

function buildSingleMenuItems(char, cardElement) {
    const isFavorite = CoreAPI.isCharacterFavorite(char);
    
    const isSelected = CoreAPI.isCharacterSelected(char.id);
    const multiSelectEnabled = CoreAPI.isMultiSelectEnabled();
    
    const providerMatch = CoreAPI.getCharacterProvider(char);
    const provider = providerMatch?.provider || null;
    const linkInfo = providerMatch?.linkInfo || null;
    
    const items = [];
    
    items.push({
        type: 'header',
        label: CoreAPI.truncate(CoreAPI.getCharacterName(char) || 'Character', 25)
    });
    
    items.push({
        icon: 'fa-solid fa-expand',
        label: 'Open Character',
        action: () => CoreAPI.openCharacterModal(char)
    });
    
    items.push({
        icon: isFavorite ? 'fa-solid fa-star' : 'fa-regular fa-star',
        label: isFavorite ? 'Remove from Favorites' : 'Add to Favorites',
        action: () => toggleFavorite(char)
    });
    
    items.push({ type: 'separator' });
    
    // Selection toggle (always show, enables quick selection)
    items.push({
        icon: isSelected ? 'fa-solid fa-square-minus' : 'fa-solid fa-square-check',
        label: isSelected ? 'Deselect' : 'Select for Batch',
        action: () => {
            if (!multiSelectEnabled) {
                CoreAPI.enableMultiSelect();
            }
            CoreAPI.toggleCharacterSelection(char, cardElement);
        }
    });
    
    if (provider && linkInfo) {
        items.push({
            icon: 'fa-solid fa-link',
            label: `${provider.name} Info`,
            action: () => provider.openLinkUI(char)
        });
        
        items.push({
            icon: 'fa-solid fa-arrows-rotate',
            label: 'Check for Updates',
            action: () => {
                const cardUpdates = CoreAPI.getModule('card-updates');
                if (cardUpdates?.checkSingleCharacter) {
                    cardUpdates.checkSingleCharacter(char);
                }
            }
        });
    } else {
        // Unlinked - single entry that opens the global link modal (searches all providers)
        items.push({
            icon: 'fa-solid fa-link',
            label: 'Link to Provider',
            action: () => CoreAPI.openProviderLinkModal(char)
        });
    }
    
    // Version history (available for ALL characters - local snapshots + remote if provider-linked)
    items.push({
        icon: 'fa-solid fa-clock-rotate-left',
        label: 'Version History',
        action: () => {
            const charVersions = CoreAPI.getModule('character-versions');
            if (charVersions?.openVersionHistory) {
                charVersions.openVersionHistory(char);
            }
        }
    });
    
    items.push({
        icon: 'fa-solid fa-images',
        label: 'View Gallery',
        action: () => {
            const galleryViewer = CoreAPI.getModule('gallery-viewer');
            if (galleryViewer?.openViewer) {
                galleryViewer.openViewer(char);
            }
        }
    });
    
    items.push({ type: 'separator' });
    
    items.push({
        icon: 'fa-solid fa-list-ul',
        label: 'Add to Playlist',
        action: () => CoreAPI.openPlaylistPicker([char.id])
    });

    items.push({
        icon: 'fa-solid fa-download',
        label: 'Export Character',
        action: () => exportCharacter(char)
    });

    // extension verbs for one character, behind a separator of their own; the phone's
    // sheet clones this rendered menu, so they reach it with everything else
    const extActs = extActionsFor('character', { character: char });
    if (extActs.length) {
        items.push({ type: 'separator' });
        for (const a of extActs) items.push({ icon: `fa-solid ${a.icon}`, label: a.label, action: () => extRunAction(a.key, { character: char }) });
    }
    
    items.push({ type: 'separator' });
    
    items.push({
        icon: 'fa-solid fa-trash',
        label: 'Delete Character',
        className: 'danger',
        action: () => confirmDelete(char)
    });
    
    return items;
}

function renderMenu(items) {
    menuElement.innerHTML = items.map(item => {
        if (item.type === 'separator') {
            return '<div class="cl-context-menu-separator"></div>';
        }
        
        if (item.type === 'header') {
            return `<div class="cl-context-menu-header">${CoreAPI.escapeHtml(item.label)}</div>`;
        }
        
        const className = `cl-context-menu-item ${item.className || ''} ${item.disabled ? 'disabled' : ''}`;
        // a picture's fallback rides an inline handler, so the phone sheet's cloned row keeps it
        const fallback = item.imgFallback ? ` onerror="this.onerror=null;this.src='${CoreAPI.escapeHtml(item.imgFallback)}'"` : '';
        const lead = item.img ? `<img class="cl-context-menu-img" src="${CoreAPI.escapeHtml(item.img)}" alt="" loading="lazy"${fallback}>` : `<i class="${item.icon}"></i>`;
        const text = item.hint
            ? `<span class="cl-context-menu-text"><span>${CoreAPI.escapeHtml(item.label)}</span><span class="cl-context-menu-hint">${CoreAPI.escapeHtml(item.hint)}</span></span>`
            : `<span>${CoreAPI.escapeHtml(item.label)}</span>`;
        return `
            <div class="${className}" data-action="${CoreAPI.escapeHtml(item.label)}">
                ${lead}
                ${text}
            </div>
        `;
    }).join('');
    
    menuElement.querySelectorAll('.cl-context-menu-item:not(.disabled)').forEach((el, index) => {
        const item = items.filter(i => i.type !== 'separator' && i.type !== 'header' && !i.disabled)[index];
        if (item?.action) {
            el.addEventListener('click', () => {
                hide();
                item.action();
            });
        }
    });
}

function positionMenu(x, y) {
    const zoom = parseFloat(document.body.style.zoom) || 1;
    x /= zoom;
    y /= zoom;

    menuElement.style.left = '0';
    menuElement.style.top = '0';
    
    // layout size, not the painted box: the open animation starts scaled down, so a mid-scale box is short
    const menuWidth = menuElement.offsetWidth;
    const menuHeight = menuElement.offsetHeight;
    const vw = window.innerWidth / zoom;
    const vh = window.innerHeight / zoom;
    const pad = 10;
    
    let finalX = x;
    if (x + menuWidth + pad > vw) finalX = x - menuWidth;
    if (finalX < pad) finalX = pad;
    
    const spaceBelow = vh - y;
    const spaceAbove = y;
    const openUpward = menuHeight + pad > spaceBelow && spaceAbove > spaceBelow;
    
    let finalY;
    if (openUpward) {
        finalY = Math.max(pad, y - menuHeight);
        menuElement.style.transformOrigin = 'bottom left';
    } else {
        finalY = y;
        if (finalY + menuHeight + pad > vh) finalY = vh - menuHeight - pad;
        if (finalY < pad) finalY = pad;
        menuElement.style.transformOrigin = 'top left';
    }
    
    menuElement.style.left = `${finalX}px`;
    menuElement.style.top = `${finalY}px`;
}

async function toggleFavorite(char) {
    await CoreAPI.toggleCharacterFavorite(char);
}

// a selection as a command's args: the ids picked by hand, or a Select All's filter
const selectionArgs = (selection) => (selection.filter !== undefined ? { filter: selection.filter } : { ids: selection.ids });
const charactersOf = (n) => `${n.toLocaleString()} character${n === 1 ? '' : 's'}`;

// the selection's favorite through the one favorite path; the server writes only the characters that move
async function bulkToggleFavorites(setFavorite) {
    const selection = CoreAPI.getSelection();
    if (!selection.count) return;

    let result = null;
    try {
        result = await runCommand('character.favorite', { ...selectionArgs(selection), value: setFavorite });
    } catch (err) {
        CoreAPI.showToast(`Not saved: ${err.message}`, 'error', 8000);
        return;
    }
    if (!result) {
        CoreAPI.showToast('Bulk favorite update failed', 'error');
        return;
    }

    const byFilter = selection.filter !== undefined;
    const moved = byFilter ? (result.changed || 0) : (result.affected || []).length;
    const failCount = byFilter ? 0 : (result.skipped || []).length;
    const already = Math.max(0, selection.count - moved - failCount);
    const said = setFavorite ? `Added ${charactersOf(moved)} to favorites` : `Removed ${charactersOf(moved)} from favorites`;
    const rest = already ? (setFavorite ? `; ${already.toLocaleString()} already were` : `; ${already.toLocaleString()} were not favorites`) : '';
    if (byFilter && result.stopped) CoreAPI.showToast(`Stopped: ${said}`, 'warning');
    else if (failCount) CoreAPI.showToast(`Updated ${charactersOf(moved)}${rest}, ${failCount} not found`, 'warning');
    else CoreAPI.showToast(`${said}${rest}`, 'success');
}

// Fetch a character's card file (png or charx) and save it via the shared anchor-download; throws on a failed fetch.
async function downloadCharacterFile(char, format = 'png') {
    // server rebuilds the file with the CURRENT card + portable cl.uid embedded
    const response = await CoreAPI.apiRequest(`/characters/${encodeURIComponent(char.id)}/export${format === 'charx' ? '?format=charx' : ''}`);
    if (!response.ok) throw new Error('Failed to fetch character file');
    // download name only; a uuid filename would tell the user nothing
    CoreAPI.downloadBlobAsFile(await response.blob(), `${char.name || 'character'}.${format}`);
}

// the card file Export Character downloads, as the setting picks it
const cardFileFormat = () => (CoreAPI.getSetting('exportFormat') === 'charx' ? 'charx' : 'png');

// The provider page a linked character exports as, or null
function providerLinkUrl(char) {
    const match = CoreAPI.getCharacterProvider(char);
    return (match && match.provider.getCharacterUrl?.(match.linkInfo)) || null;
}

// a pause between files, or the browser drops some of a burst of downloads
const PNG_EXPORT_GAP_MS = 200;
const exportCancelled = () => new DOMException('Export cancelled', 'AbortError');

/** character.export: card files (png or charx), the linked ones' provider links, or one bundle; by ids answers per id, by filter answers counts. */
async function exportCharactersFrom({ ids, filter, format = 'png', worlds = true, signal, onProgress } = {}) {
    if (filter !== undefined) return exportFilterFrom({ ids, filter, format, worlds, signal, onProgress });
    const list = Array.isArray(ids) ? [...new Set(ids.map(id => (id == null ? '' : String(id))).filter(Boolean))] : [];
    if (!list.length) throw new Error('character.export: ids required');
    if (format === 'bundle') {
        const out = await CoreAPI.getModule('batch-transfer')?.exportBundleNow?.({ ids: list }, { worlds: worlds !== false, signal });
        if (!out) throw new Error('character.export: bundle export unavailable');
        return out;
    }
    if (format !== 'png' && format !== 'charx' && format !== 'links') throw new Error(`character.export: unknown format ${format}`);
    // the ids the page has not loaded, read in one request per hundred rather than one each
    const unheld = list.filter(id => !CoreAPI.getCharacterById(id));
    if (unheld.length) await CoreAPI.fetchCharactersByIds(unheld);
    const chars = list.map(id => CoreAPI.getCharacterById(id)).filter(Boolean);
    const exported = format === 'links' ? await exportLinksNow(chars) : await exportFilesNow(chars, format, { signal, onProgress });
    const done = new Set(exported);
    return { exported, skipped: list.filter(id => !done.has(id)) };
}

// character.export over a filter: the server walks the bundle, cards and links go a set page at a time, never held
async function exportFilterFrom({ ids, filter, format, worlds, signal, onProgress }) {
    if (ids !== undefined) throw new Error('character.export: ids or a filter, not both');
    if (typeof filter !== 'string') throw new Error('character.export: a filter is a GET /characters query string');
    if (format === 'bundle') {
        const out = await CoreAPI.getModule('batch-transfer')?.exportBundleNow?.({ filter }, { worlds: worlds !== false, signal });
        if (!out) throw new Error('character.export: bundle export unavailable');
        return out;
    }
    if (format !== 'png' && format !== 'charx' && format !== 'links') throw new Error(`character.export: unknown format ${format}`);
    let count = 0, skippedCount = 0, done = 0;
    const links = [];
    for await (const page of CoreAPI.walkCharacterSetWhere(filter, { fields: format === 'links' ? ['name', 'links'] : ['name'], signal })) {
        for (const char of page) {
            if (format === 'links') {
                const url = providerLinkUrl(char);
                if (url) { links.push(url); count++; } else skippedCount++;
            } else {
                if (done) await new Promise(r => setTimeout(r, PNG_EXPORT_GAP_MS));
                if (signal?.aborted) throw exportCancelled();
                try {
                    await downloadCharacterFile(char, format);
                    count++;
                } catch (err) {
                    console.error('[ContextMenu] Export failed for:', char.name, err);
                    skippedCount++;
                }
            }
            onProgress?.(++done);
        }
    }
    // the unlinked are skipped; with none linked the clipboard is left alone
    if (links.length) await copyLinks(links);
    return { count, skippedCount };
}

async function exportFilesNow(chars, format, { signal, onProgress } = {}) {
    const exported = [];
    for (const [i, char] of chars.entries()) {
        if (i) await new Promise(r => setTimeout(r, PNG_EXPORT_GAP_MS));
        if (signal?.aborted) throw exportCancelled();
        try {
            await downloadCharacterFile(char, format);
            exported.push(char.id);
        } catch (err) {
            console.error('[ContextMenu] Export failed for:', char.name, err);
        }
        onProgress?.(i + 1);
    }
    return exported;
}

// the unlinked are skipped; with none linked the clipboard is left alone
async function exportLinksNow(chars) {
    const linked = chars.map(char => [char.id, providerLinkUrl(char)]).filter(([, url]) => url);
    if (linked.length) await copyLinks(linked.map(([, url]) => url));
    return linked.map(([id]) => id);
}

async function bulkExport() {
    const selection = CoreAPI.getSelection();
    if (!selection.count) return;
    return CoreAPI.getSetting('exportAsLinks') ? bulkExportLinks(selection) : bulkExportFiles(selection);
}

// the selection's card files (or provider links) in the export window, with progress and a Cancel between files
async function bulkExportFiles(selection = CoreAPI.getSelection()) {
    if (!selection.count) return;
    await CoreAPI.getModule('batch-transfer')?.runCardsExport?.(selection, cardFileFormat());
}

async function bulkExportLinks(selection = CoreAPI.getSelection()) {
    if (!selection.count) return;
    await CoreAPI.getModule('batch-transfer')?.runCardsExport?.(selection, 'links');
}

// A Select All's count read fresh from the server, and the names of its first five in the view's order
async function filterSetPreview(filter) {
    const first = new URLSearchParams(filter);
    for (const [k, v] of [['idsOnly', 'true'], ['fields', 'name'], ['limit', '5'], ['count', 'false']]) first.set(k, v);
    const [tally, page] = await Promise.all([
        CoreAPI.apiRequest('/characters/tally', 'POST', { filter }).then(CoreAPI.readAnswer),
        CoreAPI.apiRequest(`/characters?${first}`, 'GET').then(CoreAPI.readAnswer),
    ]);
    return { count: tally.total, names: page.items.map(item => item.name) };
}

async function bulkDelete() {
    const selection = CoreAPI.getSelection();
    if (!selection.count) return;

    // a Select All is counted again (the delete holds the server to the confirmed count); five names in one request
    let count = selection.count, names;
    if (selection.filter !== undefined) {
        try {
            ({ count, names } = await filterSetPreview(selection.filter));
        } catch (err) {
            CoreAPI.showToast(`Could not read the selection: ${err.message}`, 'error');
            return;
        }
        if (!count) {
            CoreAPI.showToast('The selection holds no character now', 'info');
            return;
        }
    } else {
        const held = selection.ids.slice(0, 5).map(id => CoreAPI.getCharacterById(id));
        const named = held.every(c => c?.data) ? held : await CoreAPI.fetchCharactersByIds(selection.ids.slice(0, 5));
        names = named.map(c => CoreAPI.getCharacterName(c));
    }
    const whole = selection.filter !== undefined && CoreAPI.filterNamesNothing(selection.filter);

    // the dialog escapes every block itself, so the names go in raw
    const ok = await CoreAPI.showConfirm({
        title: `Delete ${count.toLocaleString()} characters?`,
        confirmLabel: 'Delete all',
        danger: true,
        content: [
            ...(whole ? [{ type: 'note', tone: 'danger', text: 'No search or filter is active: this is every character in your library.' }] : []),
            { type: 'list', items: names },
            ...(count > names.length ? [{ type: 'text', text: `and ${(count - names.length).toLocaleString()} more` }] : []),
            { type: 'text', text: 'Each character is removed together with its chats, gallery files, snapshots, and provider links.' },
            { type: 'note', tone: 'danger', text: 'This cannot be undone.' },
        ],
    });
    if (!ok) return;
    await bulkDeleteCharacters(selection.filter !== undefined ? { filter: selection.filter, count } : selection);
}

/**
 * The selection's delete through the one delete path; a Select All whose set moved since the confirm is asked again.
 * @param {{ids?: string[], filter?: string, count?: number}} target
 * @returns the command's answer, or null when the write did not land
 */
async function bulkDeleteCharacters(target) {
    const byFilter = target.filter !== undefined;
    let result = null;
    try {
        result = await runCommand('character.delete', byFilter ? { filter: target.filter, expect: target.count } : { ids: target.ids });
    } catch (err) {
        if (byFilter && err.status === 409) {
            CoreAPI.showToast(`The selection changed since it was counted: it holds ${charactersOf(err.total ?? 0)} now`, 'warning', 6000);
            void bulkDelete();
            return null;
        }
        // a refusal stops the run at its chunk: the guard's words, and how many went before it, reach the reader
        CoreAPI.showToast(`Not deleted: ${err.message}`, 'error', 8000);
        return null;
    }
    if (!result) {
        CoreAPI.showToast('Bulk delete failed', 'error');
        return null;
    }

    CoreAPI.clearSelection();

    const deletedCount = byFilter ? (result.changed || 0) : (result.deleted || []).length;
    const failCount = byFilter ? (result.missing || 0) : (result.missing || []).length;
    let message = `${result.stopped ? 'Stopped: deleted' : 'Deleted'} ${deletedCount.toLocaleString()} character${deletedCount !== 1 ? 's' : ''}`;
    if (failCount > 0) {
        message += `, ${failCount.toLocaleString()} not found`;
        CoreAPI.showToast(message, 'warning');
    } else {
        CoreAPI.showToast(message, result.stopped ? 'warning' : 'success');
    }

    await CoreAPI.refreshCharacters(true);
    return result;
}

async function exportCharacter(char) {
    let format = cardFileFormat();
    if (CoreAPI.getSetting('exportAsLinks')) {
        if (providerLinkUrl(char)) format = 'links';
        else CoreAPI.showToast(`Character has no provider link - exporting ${format === 'charx' ? 'CHARX' : 'PNG'}`, 'info');
    }

    let result = null;
    try {
        result = await runCommand('character.export', { ids: [char.id], format });
    } catch (err) {
        console.error('[ContextMenu] Export failed:', err);
    }
    const done = !!result?.exported?.includes(char.id);
    if (format === 'links') CoreAPI.showToast(done ? 'Link copied to clipboard' : 'Failed to copy to clipboard', done ? 'success' : 'error');
    else CoreAPI.showToast(done ? 'Character exported' : 'Failed to export character', done ? 'success' : 'error');
}

// Delegate to the shared single-delete dialog (takes the char directly; no detail-modal detour).
function confirmDelete(char) {
    CoreAPI.showDeleteConfirmation(char);
}

export default {
    init,
    show,
    showItems,
    hide,
    // Bulk actions - exposed for multi-select toolbar + batch-transfer chooser
    bulkToggleFavorites,
    bulkExport,
    bulkExportFiles,
    bulkExportLinks,
    bulkDelete
};
