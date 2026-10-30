// The character's gallery, as a window inside the conversation.

import CoreAPI from '../core-api.js';
import Keymap from '../keymap.js';
// creator notes are third-party and carry authored card CSS: the overlay renders in the sandboxed iframe, never innerHTML
import { deferCall } from '../providers/provider-utils.js';
import { mountChatWindow, openChatWindow, closeChatWindow, registerChatWindow } from './window.js';
import BackgroundPanel from './background-panel.js';
import { registerFeedPatcher } from '../feed.js';

const esc = (s) => CoreAPI.escapeHtml(s);

// strip (64px) and grid (~100px) tiles both take the 192 tier
const TILE_THUMB = 192;
// the hero's tier is rendered width x DPR over the server's rungs; withoutEnlargement means asking big never upscales
const HERO_TIERS = [768, 1280, 1920];
function heroSize() {
    const w = document.querySelector('.cgp-image-wrap')?.clientWidth
        || document.querySelector('.cgp-sheet')?.clientWidth || 700;
    const need = w * Math.min(window.devicePixelRatio || 1, 2);
    return HERO_TIERS.find(t => t >= need) || HERO_TIERS[HERO_TIERS.length - 1];
}

let panelInjected = false;
let panelOpen = false;

let _char = null;
let _chatId = null;     // the chat whose own gallery shows beside the character's
let _filePicker = null;
let _items = null;      // null means "not read yet", which is not the same as an empty gallery
let _error = null;
let _loading = false;
let _index = 0;
let _grid = false;      // the grid is a mode of this panel, not a second panel
let _notes = false;     // the creator's-notes overlay, reset on a character change
let _notesMap = null;       // the media-localization url map for _notesMapCharId
let _notesMapCharId = null;
let _dragDepth = 0;     // dragenter/leave fire per child; the counter is what makes leave real
let _uploading = false;
let _query = '';        // the grid's filename filter: a moment, never a setting
let _search = false;    // the search row is up (grid mode only)
let _focus = null;      // the phone's focus layer while a picture is lifted over the sheet

// in-panel zoom and pan; the expand button opens the full-screen viewer. Reset on every navigation
let _zoom = 1;
let _panX = 0;
let _panY = 0;
let _panning = false;
let _wasPan = false;
let _panStartX = 0;
let _panStartY = 0;
const ZOOM_MIN = 1;
const ZOOM_MAX = 5;

function heroImg() {
    return document.querySelector('.cgp-image-wrap img.cgp-main-media');
}

function applyZoom() {
    const img = heroImg();
    if (!img) return;
    if (_zoom > 1) ensureFullHero();
    if (_zoom <= 1) { _panX = 0; _panY = 0; }
    img.style.transform = _zoom === 1 ? '' : `translate(${_panX}px, ${_panY}px) scale(${_zoom})`;
    img.classList.toggle('is-zoomed', _zoom > 1);
}

function resetZoom() {
    _zoom = 1;
    _panX = 0;
    _panY = 0;
    applyZoom();
}

const isVideo = (item) => CoreAPI.galleryKindOf(item) === 'video';
// an item's url is whole (serverUrl applied where the item is made), so a detached (?server=) frontend reads it as it is
const thumbOf = (item) => {
    if (item?.isAvatar) return CoreAPI.getCharacterAvatarSmallThumbUrl(item.charId);
    if (item?.mediaId) return CoreAPI.thumbUrl('media', item.mediaId, TILE_THUMB);
    if (item?.attachmentId && !isVideo(item)) return CoreAPI.thumbUrl('attachment', item.attachmentId, TILE_THUMB);
    return item?.url;
};
const mainOf = (item) => {
    if (item?.isAvatar) return CoreAPI.getCharacterAvatarThumbUrl(item.charId, heroSize());
    if (item?.mediaId && !isVideo(item)) return CoreAPI.thumbUrl('media', item.mediaId, heroSize());
    if (item?.attachmentId && !isVideo(item)) return CoreAPI.thumbUrl('attachment', item.attachmentId, heroSize());
    return item?.url;
};
// zoom earns the ORIGINAL bytes (a thumb is mush at 5x), fetched once per selection when zoom engages
const originalOf = (item) => {
    if (item?.isAvatar) return CoreAPI.getCharacterAvatarUrl(item.charId);
    return item?.url || null;
};
function ensureFullHero() {
    const img = heroImg();
    const item = _items?.[_index];
    if (!img || !item || img.dataset.full === '1') return;
    const orig = originalOf(item);
    if (!orig) return;
    img.dataset.full = '1';
    img.src = orig;
}

// what the window shows and where an added picture lands are the reader's (the window's options menu)
const shows = () => ({ character: CoreAPI.getSetting('chatGalleryShowCharacter') !== false, chat: CoreAPI.getSetting('chatGalleryShowChat') !== false });
const addsToChat = () => !!_chatId && CoreAPI.getSetting('chatGalleryAddTo') === 'chat';

// The avatar leads the list: it is the picture the character is known by.
const avatarItem = () => ({
    isAvatar: true,
    charId: _char.id,
    name: 'Avatar',
    url: CoreAPI.getCharacterAvatarUrl(_char.id),
    kind: 'image',
});

function buildPanelHTML() {
    return `
    <div class="cl-cwin cgp-panel" id="chatGalleryPanel" aria-hidden="true">
        <aside class="cl-cwin-sheet cgp-sheet" role="dialog" aria-label="Gallery">
            ${CoreAPI.windowGripsHtml('the gallery')}
            <div class="cl-cwin-header">
                <div class="cl-cwin-title">
                    <i class="fa-solid fa-images"></i>
                    <span class="cl-cwin-name">Gallery</span>
                </div>
                <div class="cl-cwin-controls">
                    <button type="button" class="cl-cwin-btn" data-gal-act="add" title="Add pictures" aria-label="Add pictures"><i class="fa-solid fa-plus"></i></button>
                    <button type="button" class="cl-cwin-btn" data-gal-act="remove" title="Remove from this chat's gallery" aria-label="Remove from this chat's gallery" hidden><i class="fa-solid fa-trash"></i></button>
                    <button type="button" class="cl-cwin-btn" data-gal-act="notes" title="Creator's notes (N)" aria-label="Creator's notes"><i class="fa-solid fa-file-lines"></i></button>
                    <button type="button" class="cl-cwin-btn" data-gal-act="setbg" title="Set as background (B)" aria-label="Set as background"><i class="fa-solid fa-image"></i></button>
                    <button type="button" class="cl-cwin-btn" data-gal-act="attach" title="Attach to your next message (A)" aria-label="Attach to your next message"><i class="fa-solid fa-paperclip"></i></button>
                    <button type="button" class="cl-cwin-btn cgp-search-btn" data-gal-act="search" title="Search by filename (/)" aria-label="Search by filename"><i class="fa-solid fa-magnifying-glass"></i></button>
                    <button type="button" class="cl-cwin-btn" data-gal-act="grid" title="Grid view (G)" aria-label="Grid view"><i class="fa-solid fa-grip"></i></button>
                    <button type="button" class="cl-cwin-btn" data-gal-act="viewer" title="Full screen (F)" aria-label="Full screen"><i class="fa-solid fa-expand"></i></button>
                    <button type="button" class="cl-cwin-btn" data-gal-act="options" title="What shows here, and where added pictures go" aria-label="Gallery options" aria-haspopup="menu"><i class="fa-solid fa-sliders"></i></button>
                    <button type="button" class="cl-cwin-btn is-close" data-gal-act="close" title="Close (Esc)" aria-label="Close gallery"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="cgp-body">
                <div class="cl-cwin-filterbar cl-cwin-fieldrow" id="cgpSearch" hidden>
                    <i class="fa-solid fa-magnifying-glass cl-cwin-filter-icon"></i>
                    <input type="search" id="cgpSearchInput" class="cl-cwin-filter" placeholder="Filter by filename" aria-label="Filter by filename"
                        autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
                    <button type="button" class="cl-cwin-btn" data-gal-act="search-clear" title="Clear (Esc)" aria-label="Clear the filter"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="cgp-content" id="cgpContent"></div>
                <div class="cgp-notes" id="cgpNotes" hidden><div class="cgp-notes-body" id="cgpNotesBody"></div></div>
                <div class="cgp-drop-hint" hidden><i class="fa-solid fa-images"></i><span class="cgp-drop-text">Drop to add to the gallery</span></div>
            </div>
        </aside>
    </div>`;
}

function tileHtml(item, i, variant) {
    const active = i === _index ? ' is-active' : '';
    const title = item.attachmentId ? `${item.name} (this chat)` : item.name;
    return `<button type="button" class="cgp-tile cgp-tile-${variant}${active}" data-gal-act="${variant === 'grid' ? 'select-open' : 'select'}" data-index="${i}" title="${esc(title)}">
        ${item.attachmentId ? '<span class="cgp-tile-mark" aria-hidden="true"><i class="fa-solid fa-comment"></i></span>' : ''}
        ${isVideo(item)
            ? `<span class="cgp-tile-video"><i class="fa-solid fa-play"></i></span>`
            : `<img src="${esc(thumbOf(item))}" alt="${esc(item.name)}" loading="lazy" decoding="async">`}
    </button>`;
}

function mainViewHtml() {
    const item = _items[_index];
    const single = _items.length <= 1;
    return `
    <div class="cgp-main">
        <button type="button" class="cgp-nav cgp-prev" data-gal-act="prev" title="Previous (left arrow)" aria-label="Previous"${single ? ' disabled' : ''}>
            <i class="fa-solid fa-chevron-left"></i>
        </button>
        <div class="cgp-image-wrap"${isVideo(item) ? '' : ' title="Scroll to zoom, drag to pan; the expand button opens full screen"'}>
            ${isVideo(item)
                ? `<video class="cgp-main-media" src="${esc(item.url)}" controls playsinline></video>`
                : `<img class="cgp-main-media" src="${esc(mainOf(item))}" alt="${esc(item.name)}">`}
        </div>
        <button type="button" class="cgp-nav cgp-next" data-gal-act="next" title="Next (right arrow)" aria-label="Next"${single ? ' disabled' : ''}>
            <i class="fa-solid fa-chevron-right"></i>
        </button>
    </div>
    <div class="cgp-strip"><div class="cgp-strip-scroll" id="cgpStrip">
        ${_items.map((it, i) => tileHtml(it, i, 'strip')).join('')}
    </div></div>
    <div class="cgp-footer"><span class="cgp-counter">${_index + 1} / ${_items.length}</span></div>`;
}

// The grid's filter: a case-insensitive substring over the filename (the avatar row by its
// label). No query is every index, in order.
function visibleIndices() {
    const q = _query.trim().toLowerCase();
    if (!_items) return [];
    const all = _items.map((_, i) => i);
    return q ? all.filter(i => String(_items[i]?.name || '').toLowerCase().includes(q)) : all;
}

function gridTilesHtml() {
    const vis = visibleIndices();
    if (!vis.length) {
        return `<div class="cl-cwin-empty cgp-grid-empty"><i class="fa-solid fa-magnifying-glass"></i><p>No file matches "${esc(_query.trim())}".</p></div>`;
    }
    return vis.map(i => tileHtml(_items[i], i, 'grid')).join('');
}

function gridCounterText() {
    const vis = visibleIndices();
    return _query.trim() ? `${vis.length} of ${_items.length}` : `${_items.length} image${_items.length === 1 ? '' : 's'}`;
}

// the canon field's red ring while the query matches no file
function markSearchEmpty() {
    document.getElementById('cgpSearchInput')?.classList.toggle('is-empty', !!_query.trim() && !!_items?.length && !visibleIndices().length);
}

// A keystroke repaints the tiles inside the scroller and nothing else, so the grid keeps
// its scroll and the header does not move.
function renderGrid() {
    const scroller = document.querySelector('.cgp-grid-scroll');
    if (!scroller) { render(); return; }
    const top = scroller.scrollTop;
    scroller.innerHTML = gridTilesHtml();
    scroller.scrollTop = top;
    const counter = document.querySelector('.cgp-counter');
    if (counter) counter.textContent = gridCounterText();
    markSearchEmpty();
}

function render() {
    const content = document.getElementById('cgpContent');
    if (!content) return;

    // spinner only over nothing: a reopen re-reads behind the pictures already on screen
    if (_loading && _items === null) {
        content.innerHTML = '<div class="cl-cwin-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><p>Reading the gallery</p></div>';
        return;
    }
    if (_error) {
        content.innerHTML = `<div class="cl-cwin-empty is-error"><i class="fa-solid fa-triangle-exclamation"></i>
            <p>Could not read the gallery.</p><p class="cl-cwin-dim">${esc(_error)}</p></div>`;
        return;
    }
    // Unread and empty are different answers and must not share a rendering.
    if (_items === null) { content.innerHTML = ''; return; }
    if (!_items.length) {
        const show = shows();
        const empty = !show.character && !show.chat ? 'Both galleries are hidden. Turn one on in the options menu.'
            : show.character && show.chat ? 'No pictures for this character or this chat yet.'
                : show.chat ? 'No pictures in this chat\'s gallery yet.' : 'No gallery images for this character yet.';
        content.innerHTML = `<div class="cl-cwin-empty"><i class="fa-solid fa-images"></i><p>${empty}</p></div>`;
        syncItemActs();
        return;
    }

    _index = Math.min(Math.max(_index, 0), _items.length - 1);
    content.innerHTML = _grid
        ? `<div class="cgp-grid-scroll">${gridTilesHtml()}</div><div class="cgp-footer"><span class="cgp-counter">${gridCounterText()}</span></div>`
        : mainViewHtml();
    // a rebuilt hero is a fresh img: it shows the zoom the state holds, never a silent 1x
    if (!_grid) applyZoom();
    else markSearchEmpty();

    document.querySelector('.cgp-sheet')?.classList.toggle('is-grid', _grid);
    document.querySelector('[data-gal-act="grid"]')?.classList.toggle('is-on', _grid);
    // the hero has no filter: leaving the grid takes the search row and its query with it
    if (!_grid && _search) setSearch(false);
    if (!_grid) scrollStripToActive();
    syncItemActs();
}

// remove is a chat picture's verb alone (the character's gallery lives in the details); attach a still picture's, while the connection is known to see
function syncItemActs() {
    const item = _items?.[_index];
    const remove = document.querySelector('[data-gal-act="remove"]');
    if (remove) remove.hidden = !item?.attachmentId;
    const attach = document.querySelector('[data-gal-act="attach"]');
    if (attach) attach.hidden = !item || isVideo(item) || window.chatsModule?.seesPictures?.() !== true;
}

// The search row: grid mode only, focused when it opens, gone with its query on close
function setSearch(on) {
    _search = !!on;
    const row = document.getElementById('cgpSearch');
    const input = document.getElementById('cgpSearchInput');
    document.querySelector('[data-gal-act="search"]')?.classList.toggle('is-on', _search);
    if (row) row.hidden = !_search;
    if (_search) {
        if (input) { input.value = _query; input.focus(); }
    } else if (_query) {
        _query = '';
        if (input) input.value = '';
        if (_grid) renderGrid();
    }
}

function onSearchInput(value) {
    _query = String(value || '');
    if (_grid) renderGrid();
}

// The strip follows the selection rather than the reader having to hunt for it.
function scrollStripToActive() {
    const strip = document.getElementById('cgpStrip');
    const active = strip?.querySelector('.cgp-tile.is-active');
    if (!strip || !active) return;
    const a = active.getBoundingClientRect();
    const s = strip.getBoundingClientRect();
    if (a.left < s.left || a.right > s.right) {
        strip.scrollLeft += (a.left - s.left) - (s.width / 2 - a.width / 2);
    }
}

/** Update the view IN PLACE (a rebuild reset the strip and re-decoded every tile); false when render() must build it. */
function updateSelection() {
    const content = document.getElementById('cgpContent');
    const wrap = content?.querySelector('.cgp-image-wrap');
    const strip = document.getElementById('cgpStrip');
    if (!wrap || !strip) return false;
    const item = _items[_index];

    const hadVideo = !!wrap.querySelector('video');
    if (isVideo(item) !== hadVideo) {
        wrap.innerHTML = isVideo(item)
            ? `<video class="cgp-main-media" src="${esc(item.url)}" controls playsinline></video>`
            : `<img class="cgp-main-media" src="${esc(mainOf(item))}" alt="${esc(item.name)}">`;
        if (isVideo(item)) wrap.removeAttribute('title');
        else wrap.title = 'Scroll to zoom, drag to pan; the expand button opens full screen';
    } else if (hadVideo) {
        const v = wrap.querySelector('video');
        v.src = item.url;
    } else {
        const img = wrap.querySelector('img');
        delete img.dataset.full;
        img.src = mainOf(item);
        img.alt = item.name;
    }

    const prevBtn = content.querySelector('.cgp-prev');
    const nextBtn = content.querySelector('.cgp-next');
    if (prevBtn) prevBtn.disabled = _items.length <= 1;
    if (nextBtn) nextBtn.disabled = _items.length <= 1;
    const counter = content.querySelector('.cgp-counter');
    if (counter) counter.textContent = `${_index + 1} / ${_items.length}`;

    strip.querySelectorAll('.cgp-tile').forEach(t =>
        t.classList.toggle('is-active', Number(t.dataset.index) === _index));
    strip.querySelector('.cgp-tile.is-active')
        ?.scrollIntoView({ behavior: CoreAPI.scrollBehavior(), block: 'nearest', inline: 'nearest' });

    applyZoom();
    syncItemActs();
    return true;
}

// Round robin: past either end wraps, so prev/next are never dead controls and a long
// gallery loops instead of parking at its edges.
function step(delta) {
    if (!_items?.length) return;
    if (_grid && _query.trim()) {
        // the grid shows the filtered set, so arrows move within it and never onto a hidden tile
        const vis = visibleIndices();
        if (!vis.length) return;
        const at = vis.indexOf(_index);
        select(vis[((at < 0 ? 0 : at) + delta + vis.length) % vis.length]);
        return;
    }
    select((_index + delta + _items.length) % _items.length);
}

function select(i, { open = false } = {}) {
    if (!_items?.length) return;
    _index = Math.min(Math.max(i, 0), _items.length - 1);
    // a grid pick returns to the main view: the grid is for finding one
    if (open && _grid) _grid = false;
    _zoom = 1;
    _panX = 0;
    _panY = 0;
    if (_grid) {
        // Same in-place rule as the main view: arrows move the highlight, never rebuild.
        const tiles = document.querySelectorAll('.cgp-grid-scroll .cgp-tile');
        if (tiles.length) {
            tiles.forEach(t => t.classList.toggle('is-active', Number(t.dataset.index) === _index));
            document.querySelector('.cgp-grid-scroll .cgp-tile.is-active')
                ?.scrollIntoView({ behavior: CoreAPI.scrollBehavior(), block: 'nearest', inline: 'nearest' });
            return;
        }
        render();
        return;
    }
    if (!updateSelection()) render();
}

async function load() {
    if (!_char?.id) return;
    _loading = true;
    _error = null;
    render();
    const chatId = _chatId;
    const show = shows();
    try {
        const [info, chatPictures] = await Promise.all([
            show.character ? CoreAPI.getCharacterGalleryInfo(_char) : null,
            show.chat && chatId ? readChatPictures(chatId) : [],
        ]);
        // a chat switched while the reads were out: the next load is the one that paints
        if (chatId !== _chatId) return;
        // audio rows belong to the detail modal's gallery tab, not an image navigator
        const rows = (Array.isArray(info?.items) ? info.items : []).filter(it => it?.kind !== 'audio');
        _items = [...(show.character ? [avatarItem(), ...rows] : []), ...chatPictures];
        // the index survives a re-read (render clamps it), so a reopen keeps your place
        _zoom = 1;
        _panX = 0;
        _panY = 0;
    } catch (e) {
        _error = e.message;
        _items = null;
    }
    _loading = false;
    render();
}

/** A chat's own gallery as the window's items, each how many messages show it. */
async function readChatPictures(chatId) {
    const data = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/chats/${encodeURIComponent(chatId)}/attachments`));
    return (Array.isArray(data?.items) ? data.items : []).map(a => ({ attachmentId: a.id, name: a.name, url: CoreAPI.serverUrl(a.url), kind: a.kind, uses: a.uses || 0 }));
}

// the conversation holds it for the next send, copying a character's picture into this chat's gallery first
async function attachToMessage() {
    const item = _items?.[_index];
    if (!item) { CoreAPI.showToast('No image selected', 'info'); return; }
    if (isVideo(item)) { CoreAPI.showToast('Only still pictures go with a message', 'warning'); return; }
    const held = await window.chatsModule?.attachPicture?.({ attachmentId: item.attachmentId || null, name: item.name, src: originalOf(item) });
    if (held) CoreAPI.showToast('Attached to your next message', 'success');
}

// Video is refused with the reason on the toast: a wallpaper is a still image here.
function setAsBackground() {
    const item = _items?.[_index];
    if (!item) { CoreAPI.showToast('No image selected', 'info'); return; }
    // the avatar isnt a media row: the background panel promotes its bytes itself (content-hash deduped)
    if (item.isAvatar) { BackgroundPanel.openPanel({ char: _char, tab: 'gallery', promoteAvatar: true }); return; }
    if (isVideo(item)) { CoreAPI.showToast('Backgrounds are still images, not video', 'warning'); return; }
    // a chat's picture is no gallery row, so it is promoted by its bytes, as the avatar is
    if (item.attachmentId) { BackgroundPanel.openPanel({ char: _char, chatId: _chatId, promotePicture: { name: item.name, url: item.url } }); return; }
    if (!item.mediaId) { CoreAPI.showToast('That image is not stored locally yet', 'warning'); return; }
    BackgroundPanel.openPanel({ char: _char, tab: 'gallery', promoteMediaId: item.mediaId });
}

// The phone's focus layer: the picture lifted over the whole sheet in one compositor flight (phone only)
const FOCUS_MIN = 1;
const FOCUS_MAX = 5;
const FOCUS_TAP_ZOOM = 2.5;
// how long a tap waits for its second, timed to the second's touch-down, not its lift
const FOCUS_TAP_WINDOW = 180;

// the app's motion ladder, read off the token so reduced motion collapses it too
function durMs(token) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return 350;
    return v.endsWith('ms') ? n : n * 1000;
}

// the flights move the way the bottom sheets do: the drawer curve, which leads with the motion
function easeOf(token) {
    return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || 'ease-out';
}

function focusFitRect(sheetRect, natW, natH) {
    const pad = 0;
    const w = sheetRect.width - pad * 2, h = sheetRect.height - pad * 2;
    const r = Math.min(w / Math.max(1, natW), h / Math.max(1, natH), 1e9);
    const fw = Math.max(1, natW * r), fh = Math.max(1, natH * r);
    return { left: (sheetRect.width - fw) / 2, top: (sheetRect.height - fh) / 2, width: fw, height: fh };
}

function focusTransform() {
    if (!_focus) return '';
    return `translate(${_focus.x}px, ${_focus.y}px) scale(${_focus.scale})`;
}

function applyFocus() {
    if (!_focus) return;
    if (_focus.scale > 1 && !_focus.full) {
        // look closer earns the original bytes, the hero's own rule
        const orig = originalOf(_items?.[_index]);
        if (orig) { _focus.full = true; _focus.img.src = orig; }
    }
    if (_focus.scale <= 1) { _focus.x = 0; _focus.y = 0; }
    _focus.img.style.transform = focusTransform();
}

// hero rect to fit rect (or back), centre to centre, since the image scales about its centre
function focusFlight(from, to) {
    const s = from.width / Math.max(1, to.width);
    const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
    const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
    return `translate(${dx}px, ${dy}px) scale(${s})`;
}

function liftFocus() {
    const hero = heroImg();
    const item = _items?.[_index];
    const sheet = document.querySelector('.cgp-sheet');
    if (!hero || !item || !sheet || isVideo(item) || _focus) return;
    const layer = document.createElement('div');
    layer.className = 'cgp-focus';
    layer.id = 'cgpFocus';
    layer.innerHTML = '<div class="cgp-focus-backdrop"></div><img class="cgp-focus-media" alt="" draggable="false">';
    const img = layer.querySelector('img');
    img.src = hero.currentSrc || hero.src;
    img.alt = item.name;
    const sheetRect = sheet.getBoundingClientRect();
    const heroRect = hero.getBoundingClientRect();
    const fit = focusFitRect(sheetRect, hero.naturalWidth || heroRect.width, hero.naturalHeight || heroRect.height);
    img.style.left = `${fit.left}px`;
    img.style.top = `${fit.top}px`;
    img.style.width = `${fit.width}px`;
    img.style.height = `${fit.height}px`;
    sheet.appendChild(layer);
    wireFocusGestures(layer);
    _focus = { el: layer, img, hero, scale: 1, x: 0, y: 0, full: false, flying: true };
    // the picture is on screen exactly once: the hero waits, hidden, for the flight back
    hero.style.visibility = 'hidden';
    const from = { left: heroRect.left - sheetRect.left, top: heroRect.top - sheetRect.top, width: heroRect.width, height: heroRect.height };
    const ms = durMs('--dur-slow');
    const ease = easeOf('--ease-drawer');
    layer.querySelector('.cgp-focus-backdrop').animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: ease, fill: 'forwards' });
    const flight = img.animate([{ transform: focusFlight(from, fit) }, { transform: 'none' }], { duration: ms, easing: ease, fill: 'forwards' });
    flight.finished.then(() => { if (_focus?.el === layer) { _focus.flying = false; flight.cancel(); applyFocus(); } }).catch(() => { /* a close cancels the flight mid-air; nothing waits on it */ });
}

// every way out restores the hero: the dismiss, the close, a character change, a step onto a video
function dropFocus() {
    if (!_focus) return;
    const { el, hero } = _focus;
    _focus = null;
    el.remove();
    if (hero) hero.style.visibility = '';
}

function dismissFocus() {
    if (!_focus || _focus.flying) return;
    const f = _focus;
    f.flying = true;
    const sheet = document.querySelector('.cgp-sheet');
    const hero = heroImg();
    if (!sheet || !hero) { dropFocus(); return; }
    // the hero may have moved (the window, a rotation): the flight lands on its rect NOW
    const sheetRect = sheet.getBoundingClientRect();
    const heroRect = hero.getBoundingClientRect();
    const to = { left: heroRect.left - sheetRect.left, top: heroRect.top - sheetRect.top, width: heroRect.width, height: heroRect.height };
    const fit = { left: parseFloat(f.img.style.left), top: parseFloat(f.img.style.top), width: parseFloat(f.img.style.width), height: parseFloat(f.img.style.height) };
    // put down gently: a curve that eases in as well, so the chrome fades back instead of popping
    const ms = durMs('--dur-slow');
    const ease = easeOf('--ease-standard');
    f.el.querySelector('.cgp-focus-backdrop').animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: ease, fill: 'forwards' });
    const flight = f.img.animate([{ transform: focusTransform() }, { transform: focusFlight(to, fit) }], { duration: ms, easing: ease, fill: 'forwards' });
    flight.finished.then(() => { if (_focus === f) dropFocus(); }).catch(() => { if (_focus === f) dropFocus(); });
}

// a swipe in the layer steps the gallery with a crossfade; a step onto a video drops the layer
function focusStep(delta) {
    if (!_focus) return;
    step(delta);
    const hero = heroImg();
    const item = _items?.[_index];
    if (!hero || !item || isVideo(item)) { dropFocus(); return; }
    hero.style.visibility = 'hidden';
    _focus.hero = hero;
    _focus.scale = 1; _focus.x = 0; _focus.y = 0; _focus.full = false;
    const sheet = document.querySelector('.cgp-sheet');
    const fit = focusFitRect(sheet.getBoundingClientRect(), hero.naturalWidth || 1, hero.naturalHeight || 1);
    const swap = () => {
        _focus.img.style.left = `${fit.left}px`; _focus.img.style.top = `${fit.top}px`;
        _focus.img.style.width = `${fit.width}px`; _focus.img.style.height = `${fit.height}px`;
        _focus.img.src = hero.currentSrc || hero.src;
        applyFocus();
        _focus.img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: durMs('--dur-base'), easing: 'ease-out' });
    };
    if (hero.complete && hero.naturalWidth) swap();
    else hero.addEventListener('load', () => { if (_focus?.hero === hero) swap(); }, { once: true });
}

// pinch scales about the fingers, one finger pans when scaled, double tap looks closer, single tap dismisses, swipe steps
function wireFocusGestures(layer) {
    let t0 = { x: 0, y: 0 }, base = { x: 0, y: 0, scale: 1 }, moved = false, pinch = null;
    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });
    const clamp = (s) => Math.min(FOCUS_MAX, Math.max(FOCUS_MIN, s));
    const settle = () => {
        if (!_focus) return;
        _focus.img.style.transition = `transform ${durMs('--dur-base')}ms ease-out`;
        setTimeout(() => { if (_focus) _focus.img.style.transition = ''; }, durMs('--dur-base') + 20);
    };
    // one or two taps on a zoomed picture both mean whole, so that tap acts at once and swallows its second
    let pending = null, pendingPoint = { x: 0, y: 0 }, pendingTimer = 0, second = null;
    const disarm = () => { clearTimeout(pendingTimer); pendingTimer = 0; pending = null; };
    const arm = (kind, point) => {
        disarm();
        pending = kind;
        pendingPoint = point;
        pendingTimer = setTimeout(() => {
            const k = pending;
            pending = null;
            pendingTimer = 0;
            if (k === 'single' && _focus && !_focus.flying && _focus.scale <= 1) dismissFocus();
        }, FOCUS_TAP_WINDOW);
    };
    layer.addEventListener('touchstart', (e) => {
        if (!_focus || _focus.flying) return;
        e.preventDefault();
        if (e.touches.length === 2) {
            // a pinch is never the second of a tap, and a tap pending before it is dropped
            second = null;
            disarm();
            const m = mid(e.touches[0], e.touches[1]);
            pinch = { d0: dist(e.touches[0], e.touches[1]), m0: m, scale0: _focus.scale, x0: _focus.x, y0: _focus.y };
            moved = true;
            return;
        }
        pinch = null;
        moved = false;
        t0 = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        base = { x: _focus.x, y: _focus.y, scale: _focus.scale };
        // a touch that comes down while a tap is still pending is that tap's second
        second = pending ? { kind: pending, point: pendingPoint } : null;
        disarm();
    }, { passive: false });
    layer.addEventListener('touchmove', (e) => {
        if (!_focus || _focus.flying) return;
        e.preventDefault();
        if (pinch && e.touches.length === 2) {
            const m = mid(e.touches[0], e.touches[1]);
            const next = clamp(pinch.scale0 * dist(e.touches[0], e.touches[1]) / Math.max(1, pinch.d0));
            // the point under the fingers stays under the fingers: translate around the midpoint
            const k = next / pinch.scale0;
            const sheet = _focus.el.getBoundingClientRect();
            const cx = pinch.m0.x - sheet.left - (parseFloat(_focus.img.style.left) + parseFloat(_focus.img.style.width) / 2);
            const cy = pinch.m0.y - sheet.top - (parseFloat(_focus.img.style.top) + parseFloat(_focus.img.style.height) / 2);
            _focus.scale = next;
            _focus.x = pinch.x0 * k + cx * (1 - k) + (m.x - pinch.m0.x);
            _focus.y = pinch.y0 * k + cy * (1 - k) + (m.y - pinch.m0.y);
            applyFocus();
            return;
        }
        if (e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - t0.x, dy = e.touches[0].clientY - t0.y;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
        if (_focus.scale > 1) {
            _focus.x = base.x + dx;
            _focus.y = base.y + dy;
            applyFocus();
        }
    }, { passive: false });
    layer.addEventListener('touchend', (e) => {
        if (!_focus || _focus.flying) return;
        if (pinch) { if (e.touches.length < 2) { pinch = null; if (_focus.scale <= 1) { settle(); _focus.scale = 1; applyFocus(); } } return; }
        const t = e.changedTouches?.[0];
        if (!t) return;
        const dx = t.clientX - t0.x, dy = t.clientY - t0.y;
        const prior = second;
        second = null;
        if (moved) {
            if (_focus.scale <= 1 && Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy)) focusStep(dx < 0 ? 1 : -1);
            return;
        }
        const point = { x: t.clientX, y: t.clientY };
        if (prior && Math.hypot(point.x - prior.point.x, point.y - prior.point.y) < 40) {
            // the second of a tap that already brought the picture back to whole
            if (prior.kind === 'swallow') return;
            // a double tap at rest: a closer look at the tap
            settle();
            const sheet = _focus.el.getBoundingClientRect();
            const cx = point.x - sheet.left - (parseFloat(_focus.img.style.left) + parseFloat(_focus.img.style.width) / 2);
            const cy = point.y - sheet.top - (parseFloat(_focus.img.style.top) + parseFloat(_focus.img.style.height) / 2);
            _focus.scale = FOCUS_TAP_ZOOM;
            _focus.x = cx * (1 - FOCUS_TAP_ZOOM);
            _focus.y = cy * (1 - FOCUS_TAP_ZOOM);
            applyFocus();
            return;
        }
        if (_focus.scale > 1) {
            settle();
            _focus.scale = 1;
            applyFocus();
            arm('swallow', point);
            return;
        }
        arm('single', point);
    });
}

// the full-screen viewer's list can be shorter (non-viewable kinds filtered), so the NAME finds the same image
function openViewer() {
    if (!_items?.length) { CoreAPI.showToast('No gallery images found', 'info'); return; }
    const media = CoreAPI.buildGalleryViewerMedia(_items);
    if (!media?.length) { CoreAPI.showToast('No viewable media found', 'info'); return; }
    const name = _items[_index]?.name;
    const at = Math.max(0, media.findIndex(m => m.name === name));
    CoreAPI.openGalleryViewerWithImages(media, at, _char?.name || 'Gallery');
}

// creator's notes over the pictures; a slim character is hydrated first (list rows carry only an excerpt)
function applyNotes() {
    const overlay = document.getElementById('cgpNotes');
    const body = document.getElementById('cgpNotesBody');
    if (!overlay || !body) return;
    overlay.hidden = !_notes;
    document.querySelector('[data-gal-act="notes"]')?.classList.toggle('is-on', _notes);
    if (!_notes) {
        // The secure renderer parks a ResizeObserver on its iframe; dropping the node
        // without disconnecting leaves the observer alive until GC.
        for (const f of body.querySelectorAll('iframe')) f._resizeObserver?.disconnect?.();
        body.innerHTML = '';
        return;
    }
    body.innerHTML = '';
    // localize before rendering like the modal and the transcript; re-check the toggle and character after the awaits
    const charId = _char?.id;
    void (async () => {
        if (_char?._slim) await CoreAPI.hydrateCharacter(_char);
        if (!_notes || _char?.id !== charId) return;
        const notes = String(_char?.creator_notes ?? _char?.data?.creator_notes ?? '').trim();
        if (!notes) {
            body.innerHTML = `<div class="cl-cwin-empty"><i class="fa-solid fa-file-circle-question"></i>
            <p>No creator's notes on this card.</p></div>`;
            return;
        }
        const map = await notesUrlMap(charId);
        if (!_notes || _char?.id !== charId) return;
        const text = map && Object.keys(map).length ? CoreAPI.replaceMediaUrlsInText(notes, map) : notes;
        // a dedicated pane: full content height and .cgp-notes scrolls; the 600px cap is the detail modal's
        deferCall(body, () => CoreAPI.renderCardHtmlSecure(text, _char?.name || '', body, { maxHeight: Infinity }));
    })();
}

// One media list read per character, cached: notes toggling should not refetch it.
async function notesUrlMap(charId) {
    if (!charId) return null;
    if (_notesMapCharId === charId) return _notesMap;
    let map = null;
    try {
        if (CoreAPI.isMediaLocalizationEnabled()) map = await CoreAPI.buildMediaLocalizationMap(charId);
    } catch { map = null; /* unlocalized notes still render, just remotely */ }
    _notesMapCharId = charId;
    _notesMap = map;
    return map;
}

function toggleNotes() {
    _notes = !_notes;
    applyNotes();
}

// the character, the chat and the target are captured up front, so a switch mid-upload cant retarget the writes
async function uploadDropped(files) {
    const charId = _char?.id;
    const chatId = addsToChat() ? _chatId : null;
    if (!charId || _uploading) return;
    const media = files.filter(f => f.type.startsWith('image/') || f.type.startsWith('video/')
        || ['image', 'video'].includes(CoreAPI.galleryKindOf(f.name)));
    if (!media.length) { CoreAPI.showToast('Nothing droppable: images and video only', 'info'); return; }
    _uploading = true;
    CoreAPI.showToast(`Uploading ${media.length} file${media.length === 1 ? '' : 's'}...`, 'info');
    let done = 0;
    let failed = 0;
    for (const file of media) {
        try {
            const resp = await CoreAPI.apiRequest(
                chatId ? `/chats/${encodeURIComponent(chatId)}/attachments?name=${encodeURIComponent(file.name)}`
                    : `/characters/${encodeURIComponent(charId)}/media?name=${encodeURIComponent(file.name)}`,
                'POST', file, { raw: true, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
            if (resp.ok) done++; else failed++;
        } catch { failed++; }
    }
    _uploading = false;
    const where = chatId ? 'this chat\'s gallery' : 'the character\'s gallery';
    // a target the reader hides here is said, or the pictures would seem lost
    const hidden = !shows()[chatId ? 'chat' : 'character'] ? ' (hidden here by the options menu)' : '';
    CoreAPI.showToast(
        failed ? `Added ${done} of ${media.length} file(s) to ${where}; ${failed} failed` : `Added ${done} file${done === 1 ? '' : 's'} to ${where}${hidden}`,
        failed ? 'warning' : 'success');
    if (done && _char?.id === charId) void load();
}

// a tap's way in where a drop has none (a phone); the picker is made once and reused
function pickFiles() {
    if (!_filePicker) {
        _filePicker = Object.assign(document.createElement('input'), { type: 'file', multiple: true, accept: 'image/*,video/*', hidden: true });
        _filePicker.addEventListener('change', () => {
            const files = [..._filePicker.files];
            _filePicker.value = '';
            if (files.length) void uploadDropped(files);
        });
        document.body.appendChild(_filePicker);
    }
    _filePicker.click();
}

// a chat's picture leaves its gallery, and the messages that showed it lose it; the confirm says how many
async function removeChatPicture() {
    const item = _items?.[_index];
    if (!item?.attachmentId) return;
    const uses = item.uses || 0;
    const ok = await CoreAPI.showConfirm({
        title: 'Remove this picture from the chat?',
        message: uses ? `${uses} message${uses === 1 ? ' shows' : 's show'} it, and ${uses === 1 ? 'it loses' : 'they lose'} the picture.` : 'It leaves this chat\'s gallery.',
        confirmLabel: 'Remove', danger: true,
    });
    if (!ok) return;
    try {
        await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/attachments/${encodeURIComponent(item.attachmentId)}`, 'DELETE'));
    } catch (e) {
        CoreAPI.showToast(`Not removed: ${e.message}`, 'error');
        return;
    }
    CoreAPI.showToast('Picture removed from the chat', 'success');
    void load();
}

// Show ticks and the add-to choice, one menu under the options button; a change re-reads at once
function openOptions(e) {
    const show = shows();
    const toChat = addsToChat();
    const tick = (on) => (on ? 'fa-solid fa-square-check' : 'fa-regular fa-square');
    const dot = (on) => (on ? 'fa-solid fa-circle-dot' : 'fa-regular fa-circle');
    const r = e.target.closest('[data-gal-act]').getBoundingClientRect();
    CoreAPI.getModule('context-menu')?.showItems?.(e, [
        { type: 'header', label: 'Show' },
        { icon: tick(show.character), label: 'The character\'s pictures', className: show.character ? 'is-current' : '', action: () => { CoreAPI.setSetting('chatGalleryShowCharacter', !show.character); void load(); } },
        { icon: tick(show.chat), label: 'This chat\'s pictures', className: show.chat ? 'is-current' : '', action: () => { CoreAPI.setSetting('chatGalleryShowChat', !show.chat); void load(); } },
        { type: 'separator' },
        { type: 'header', label: 'Add new pictures to' },
        { icon: dot(!toChat), label: 'The character\'s gallery', className: !toChat ? 'is-current' : '', action: () => { CoreAPI.setSetting('chatGalleryAddTo', 'character'); void load(); } },
        { icon: dot(toChat), label: 'This chat\'s gallery', className: toChat ? 'is-current' : '', disabled: !_chatId, action: () => { CoreAPI.setSetting('chatGalleryAddTo', 'chat'); void load(); } },
    ], { x: r.left, y: r.bottom + 4 });
}

// heard in the capture phase, ahead of the conversation, which leaves a key this one took
function onKeydown(e) {
    if (!panelOpen) return undefined;
    const typing = e.target?.matches?.('input, textarea, select, [contenteditable]');
    if (!typing && !e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        return step(e.key === 'ArrowRight' ? 1 : -1);
    }
    if (Keymap.is(e, 'chatGallery.grid')) { e.preventDefault(); _grid = !_grid; return render(); }
    if (Keymap.is(e, 'chatGallery.search')) { if (!_grid) return undefined; e.preventDefault(); return setSearch(true); }
    if (Keymap.is(e, 'chatGallery.viewer')) { e.preventDefault(); return openViewer(); }
    if (Keymap.is(e, 'chatGallery.background')) { e.preventDefault(); return setAsBackground(); }
    if (Keymap.is(e, 'chatGallery.attach')) { e.preventDefault(); return void attachToMessage(); }
    if (Keymap.is(e, 'chatGallery.notes')) { e.preventDefault(); return toggleNotes(); }
    if (Keymap.is(e, 'chatGallery.zoomIn')) { e.preventDefault(); _zoom = Math.min(ZOOM_MAX, _zoom + 0.25); return applyZoom(); }
    if (Keymap.is(e, 'chatGallery.zoomOut')) { e.preventDefault(); _zoom = Math.max(ZOOM_MIN, _zoom - 0.25); return applyZoom(); }
    if (Keymap.is(e, 'chatGallery.zoomReset')) { e.preventDefault(); return resetZoom(); }
    return undefined;
}

function injectPanel() {
    if (panelInjected) return;
    const host = document.getElementById('chatsConversation');
    if (!host) return;
    panelInjected = true;
    host.insertAdjacentHTML('beforeend', buildPanelHTML());

    const sheet = document.querySelector('.cgp-sheet');
    mountChatWindow(sheet, {
        key: 'chatGalleryPanel',
        close: closePanel,
        min: { w: 20, h: 30 },
    });

    sheet?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-gal-act]');
        if (!btn) return;
        const i = Number(btn.dataset.index);
        switch (btn.dataset.galAct) {
            case 'close': return closeWhole();
            case 'notes': return toggleNotes();
            case 'add': return pickFiles();
            case 'remove': return void removeChatPicture();
            case 'options': return openOptions(e);
            case 'setbg': return setAsBackground();
            case 'attach': return void attachToMessage();
            case 'viewer': return openViewer();
            case 'grid': _grid = !_grid; return render();
            case 'search': return setSearch(!_search);
            case 'search-clear': return setSearch(false);
            case 'prev': return step(-1);
            case 'next': return step(1);
            case 'select': return select(i);
            case 'select-open': return select(i, { open: true });
            default: return undefined;
        }
    });

    // Drag-and-drop upload: dragenter/leave fire once per child crossed, so a depth counter
    // is what tells "left the sheet" from "moved over the strip".
    const dropHint = sheet?.querySelector('.cgp-drop-hint');
    const setDrag = (on) => {
        sheet?.classList.toggle('is-drop', on);
        if (dropHint) dropHint.hidden = !on;
        const text = dropHint?.querySelector('.cgp-drop-text');
        if (on && text) text.textContent = addsToChat() ? 'Drop to add to this chat\'s gallery' : 'Drop to add to the character\'s gallery';
    };
    sheet?.addEventListener('dragenter', (e) => {
        if (!_char?.id || !e.dataTransfer?.types?.includes?.('Files')) return;
        e.preventDefault();
        _dragDepth++;
        setDrag(true);
    });
    sheet?.addEventListener('dragover', (e) => {
        if (!_char?.id || !e.dataTransfer?.types?.includes?.('Files')) return;
        e.preventDefault();
    });
    sheet?.addEventListener('dragleave', () => {
        if (_dragDepth > 0) _dragDepth--;
        if (_dragDepth === 0) setDrag(false);
    });
    sheet?.addEventListener('drop', (e) => {
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        _dragDepth = 0;
        setDrag(false);
        void uploadDropped([...e.dataTransfer.files]);
    });

    // Zoom and pan on the hero; the click that ENDS a drag is swallowed so panning never doubles as a reset.
    sheet?.addEventListener('wheel', (e) => {
        if (!e.target.closest('.cgp-image-wrap') || !heroImg()) return;
        e.preventDefault();
        const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, _zoom + (e.deltaY > 0 ? -0.25 : 0.25)));
        if (next !== _zoom) { _zoom = next; applyZoom(); }
    }, { passive: false });
    sheet?.addEventListener('mousedown', (e) => {
        if (_zoom <= 1 || !e.target.closest('.cgp-image-wrap')) return;
        e.preventDefault();
        _panning = true;
        _wasPan = false;
        _panStartX = e.clientX - _panX;
        _panStartY = e.clientY - _panY;
    });
    document.addEventListener('mousemove', (e) => {
        if (!_panning) return;
        const nx = e.clientX - _panStartX;
        const ny = e.clientY - _panStartY;
        // Only real movement counts as a drag: a motionless press and release is a CLICK,
        // and swallowing it is what broke click-to-reset.
        if (Math.abs(nx - _panX) > 3 || Math.abs(ny - _panY) > 3) _wasPan = true;
        _panX = nx;
        _panY = ny;
        applyZoom();
    });
    document.addEventListener('mouseup', () => {
        _panning = false;
    });
    sheet?.addEventListener('click', (e) => {
        if (!e.target.closest('.cgp-image-wrap')) return;
        if (_wasPan) { _wasPan = false; return; }
        if (_zoom > 1) resetZoom();
    });

    // pan is raw finger pixels: this transform translates before it scales, so no damping
    let lastTapTime = 0;
    let lastTapX = 0;
    let lastTapY = 0;
    let touchPan = false;
    let touchMoved = false;
    let tStartX = 0;
    let tStartY = 0;
    let tBaseX = 0;
    let tBaseY = 0;
    const snap = (img) => {
        img.style.transition = 'transform 0.25s ease-out';
        setTimeout(() => { img.style.transition = ''; }, 260);
    };
    let touchSwipe = false;
    sheet?.addEventListener('touchstart', (e) => {
        const img = heroImg();
        if (!img || !e.target.closest('.cgp-image-wrap')) return;
        // a second finger is a pinch, never the tap or swipe the first one started
        if (e.touches.length !== 1) { touchSwipe = false; return; }
        const x = e.touches[0].clientX;
        const y = e.touches[0].clientY;
        touchMoved = false;
        if (_zoom > 1.05) {
            touchPan = true;
            tStartX = x;
            tStartY = y;
            tBaseX = _panX;
            tBaseY = _panY;
            return;
        }
        const now = Date.now();
        // a touch desktop looks closer in place on a double tap; the phone lifts on one tap (touchend)
        if (!CoreAPI.isMobileMode() && now - lastTapTime < 300 && Math.hypot(x - lastTapX, y - lastTapY) < 40) {
            e.preventDefault();
            lastTapTime = 0;
            snap(img);
            _zoom = 2.5;
            _panX = 0;
            _panY = 0;
            applyZoom();
            return;
        }
        lastTapTime = now;
        lastTapX = x;
        lastTapY = y;
        // At rest the same touch may become a horizontal SWIPE, the chevrons' mobile verb.
        touchSwipe = true;
        tStartX = x;
        tStartY = y;
    }, { passive: false });
    sheet?.addEventListener('touchmove', (e) => {
        if (touchPan) {
            const dx = e.touches[0].clientX - tStartX;
            const dy = e.touches[0].clientY - tStartY;
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) touchMoved = true;
            e.preventDefault();
            _panX = tBaseX + dx;
            _panY = tBaseY + dy;
            applyZoom();
            return;
        }
        if (!touchSwipe) return;
        const dx = e.touches[0].clientX - tStartX;
        const dy = e.touches[0].clientY - tStartY;
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) e.preventDefault();
    }, { passive: false });
    sheet?.addEventListener('touchend', (e) => {
        if (touchPan) {
            touchPan = false;
            if (!touchMoved && _zoom > 1.05) {
                const img = heroImg();
                if (img) snap(img);
                resetZoom();
            }
            return;
        }
        if (!touchSwipe) return;
        touchSwipe = false;
        const t = e.changedTouches?.[0];
        if (!t) return;
        const dx = t.clientX - tStartX;
        const dy = t.clientY - tStartY;
        if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy)) { step(dx < 0 ? 1 : -1); return; }
        // one tap lifts the picture on a phone; preventDefault keeps the compatibility click off the raised layer
        if (CoreAPI.isMobileMode() && Math.hypot(dx, dy) < 10) { e.preventDefault(); liftFocus(); }
    });

    document.addEventListener('keydown', onKeydown, true);

    // the search row: the filter on every keystroke (Escape reaches closePanel through the
    // overlay stack, which clears the search while the box has focus)
    const searchInput = document.getElementById('cgpSearchInput');
    searchInput?.addEventListener('input', () => onSearchInput(searchInput.value));

    registerChatWindow('chatGalleryPanel', { close: closePanel, follow: followCharacter });
}

/** @param {{char: object, chatId: string}} ctx the character and the chat whose galleries these are, handed in by the chat. */
function openPanel(ctx) {
    const changed = (ctx?.char && ctx.char.id !== _char?.id) || (ctx?.chatId && ctx.chatId !== _chatId);
    if (ctx?.char) _char = ctx.char;
    if (ctx?.chatId) _chatId = ctx.chatId;
    injectPanel();
    const panel = document.getElementById('chatGalleryPanel');
    if (!panel) return;
    openChatWindow(panel, { button: 'chatConvGallery' });
    panelOpen = true;
    if (changed) {
        _index = 0;
        // UNKNOWN, not stale: the previous character's items must never paint under the
        // new character's name while the async read is in flight.
        _items = null;
        _error = null;
        _notes = false;
        dropFocus();
        setSearch(false);
    }
    // unconditional: the overlay's DOM must match _notes even when the listener already adopted the char
    applyNotes();
    render();
    // Always re-read on open, so images added mid-chat (downloads, sync) appear on the next open.
    void load();
}

// back/Escape: put a lifted picture down, then clear a focused search, then close (X closes it all)
function closePanel() {
    if (_focus) { dismissFocus(); return; }
    if (_search && document.activeElement?.id === 'cgpSearchInput') { setSearch(false); return; }
    const panel = document.getElementById('chatGalleryPanel');
    panelOpen = false;
    closeChatWindow(panel, { button: 'chatConvGallery' });
}

function closeWhole() {
    dropFocus();
    closePanel();
}

function togglePanel(ctx) {
    if (panelOpen) closeWhole();
    else openPanel(ctx);
}

// a write to the character on show: only a moved avatar is stale here (the id never moves)
function followCharacter(detail) {
    if (!panelOpen || !_char?.id || detail?.charId !== _char.id) return;
    const fresh = CoreAPI.getCharacterById(_char.id);
    if (fresh) _char = fresh;
    // The thumb legs recompute on render; only the stored raw url (the viewer's leg)
    // would keep serving the pre-swap avatar without this.
    const av = _items?.find(it => it.isAvatar);
    const next = CoreAPI.getCharacterAvatarUrl(_char.id);
    if (!av || av.url === next) return;
    av.url = next;
    render();
}

function init() {
    // this tab's own (a paperclip upload, an Attach copy) as well as another tab's
    registerFeedPatcher('attachment', followChatPictures);
    registerFeedPatcher('attachment', (records) => followChatPictures(records), { own: true });
    document.addEventListener('cl-chat-sight', () => { if (panelOpen) syncItemActs(); });
    // follow the conversation, or a drop uploads into the previous character; items reset to null (unknown)
    document.addEventListener('cl-chat-changed', (e) => {
        if (!e.detail?.chatId) { if (panelOpen) closeWhole(); return; }
        const next = e.detail.char;
        if (!next?.id || (next.id === _char?.id && e.detail.chatId === _chatId)) return;
        _char = next;
        _chatId = e.detail.chatId;
        _items = null;
        _error = null;
        _index = 0;
        _notes = false;
        dropFocus();
        setSearch(false);
        // unconditionally: adopting the char here makes openPanel's changed-check pass later, so clear the overlay now
        applyNotes();
        if (!panelOpen) return;
        render();
        void load();
    });
}

// another tab's add or removal reaches an open window on the chat it shows
function followChatPictures(records) {
    if (panelOpen && _chatId && records.some(r => r.chatId === _chatId)) void load();
}

function isOpen() { return panelOpen; }

export { openPanel, closePanel, togglePanel, isOpen };
export default { init, openPanel, closePanel, togglePanel, isOpen };
