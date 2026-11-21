// The chat wallpaper: the applier that paints one and the panel that picks it; the url is always built from a row.

import CoreAPI from '../core-api.js';
import { mountChatWindow, syncRangeFill, openChatWindow, closeChatWindow, registerChatWindow } from './window.js';

const esc = (s) => CoreAPI.escapeHtml(s);

// picker tiles render at ~100px; the applied image's tier is the reader's own knob
const TILE_THUMB = 192;

const FITS = [
    ['cover', 'Cover'], ['contain', 'Contain'], ['stretch', 'Stretch'],
    ['center', 'Center'], ['tile', 'Tile'],
];

// null is Auto. 0 is the original. Everything else is a thumb tier.
const RESOLUTIONS = [
    [null, 'Auto'], [768, 'Small'], [1280, 'Medium'], [1920, 'Large'], [0, 'Original'],
];

// Past this much blur a 768 upscale and a 1920 one are indistinguishable, because the blur
// radius already exceeds the detail either one keeps.
const AUTO_BLUR_CUTOFF = 8;

const DEFAULT_KNOBS = { fit: 'cover', opacity: 1, blur: 0, brightness: 1, saturate: 1, renderWidth: null };

let panelInjected = false;
let panelOpen = false;

let _char = null;
let _chatId = null;
let _scope = 'chat';           // which scope the panel is EDITING
let _tab = 'library';
let _library = null;           // null means "not read yet", which is not an empty library
let _gallery = null;
let _galleryError = null;      // the gallery read failed: unknown, never "no gallery images"
let _error = null;
let _loading = false;
let _draft = null;             // the binding being EDITED, or null for "inherit"
let _saved = null;             // what the server holds at this scope, so the header can
                               // never claim "set here" for something merely being tried
let _resolvedSource = 'none';  // which scope the painted wallpaper actually came from
let _resolvedBlank = false;    // that scope's row exists but carries no background

// ========================================
// THE APPLIER
// ========================================

const FIT_CSS = {
    cover: { size: 'cover', repeat: 'no-repeat' },
    contain: { size: 'contain', repeat: 'no-repeat' },
    stretch: { size: '100% 100%', repeat: 'no-repeat' },
    center: { size: 'auto', repeat: 'no-repeat' },
    tile: { size: 'auto', repeat: 'repeat' },
};

const clamp = (n, lo, hi, fallback) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Number(n))) : fallback);

/** Which URL to paint; Auto never scales center or tile, whose served width IS the composition. */
export function wallpaperUrl(background, knobs) {
    if (!background) return null;
    const original = CoreAPI.serverUrl(`/backgrounds/${encodeURIComponent(background.file)}`);
    const tier = knobs.renderWidth;
    if (tier === 0) return original;
    if (tier) return CoreAPI.thumbUrl('background', background.id, tier);

    if (knobs.fit === 'center' || knobs.fit === 'tile') return original;
    return CoreAPI.thumbUrl('background', background.id, knobs.blur >= AUTO_BLUR_CUTOFF ? 768 : 1920);
}

/** The composed filter, or 'none' when every knob sits at its default. */
function filterFor({ blur, brightness, saturate }) {
    const parts = [];
    if (blur > 0) parts.push(`blur(${blur}px)`);
    if (brightness !== 1) parts.push(`brightness(${brightness})`);
    if (saturate !== 1) parts.push(`saturate(${saturate})`);
    // 'none', not blur(0px) brightness(1): the latter still buys a compositor filter layer
    return parts.length ? parts.join(' ') : 'none';
}

/**
 * Paint a resolved binding, or clear when given null. Idempotent, and the only writer of
 * the --cl-chat-wallpaper family.
 */
export function applyWallpaper(binding) {
    const backdrop = document.querySelector('.chat-conv-backdrop');
    if (!backdrop) return;

    const bg = binding?.background;
    if (!bg) {
        backdrop.removeAttribute('data-wallpaper');
        for (const n of ['', '-size', '-repeat', '-pos', '-opacity', '-blur', '-filter']) {
            CoreAPI.removeRuntimeToken(`--cl-chat-wallpaper${n}`);
        }
        return;
    }

    const knobs = {
        fit: FIT_CSS[binding.fit] ? binding.fit : 'cover',
        opacity: clamp(binding.opacity, 0, 1, 1),
        blur: clamp(binding.blur, 0, 40, 0),
        brightness: clamp(binding.brightness, 0, 2, 1),
        saturate: clamp(binding.saturate, 0, 2, 1),
        renderWidth: binding.renderWidth,
    };
    const css = FIT_CSS[knobs.fit];

    CoreAPI.setRuntimeToken('--cl-chat-wallpaper', `url("${wallpaperUrl(bg, knobs)}")`);
    CoreAPI.setRuntimeToken('--cl-chat-wallpaper-size', css.size);
    CoreAPI.setRuntimeToken('--cl-chat-wallpaper-repeat', css.repeat);
    CoreAPI.setRuntimeToken('--cl-chat-wallpaper-pos', 'center');
    CoreAPI.setRuntimeToken('--cl-chat-wallpaper-opacity', String(knobs.opacity));
    CoreAPI.setRuntimeToken('--cl-chat-wallpaper-blur', `${knobs.blur}px`);
    CoreAPI.setRuntimeToken('--cl-chat-wallpaper-filter', filterFor(knobs));
    backdrop.setAttribute('data-wallpaper', '');
}

export function clearWallpaper() {
    applyWallpaper(null);
}

/** Ask the server what this chat wears and paint it; every conversation open runs it, which is how the module learns the chat. */
export async function loadWallpaperFor(chatId, char) {
    _chatId = chatId || null;
    if (char) _char = char;
    clearWallpaper();
    if (!chatId) return;
    try {
        const resp = await CoreAPI.apiRequest(`/backgrounds/resolve?chatId=${encodeURIComponent(chatId)}`, 'GET');
        if (!resp.ok) return;
        const { binding, source } = await resp.json();
        _resolvedSource = source || 'none';
        // an explicit-none row paints nothing while shadowing lower scopes; the header
        // has to be able to SAY that, or the blank reads as a bug
        _resolvedBlank = !!(binding && !binding.background);
        // the reader may have left for another chat meanwhile; dont paint the previous one's wallpaper over it
        if (_chatId && _chatId !== chatId) return;
        applyWallpaper(binding);
    } catch { /* a wallpaper that will not load is not worth an error surface */ }
}

// ========================================
// THE PANEL
// ========================================

function buildPanelHTML() {
    return `
    <div class="cl-cwin cbg-panel" id="chatBgPanel" aria-hidden="true">
        <aside class="cl-cwin-sheet cbg-sheet" role="dialog" aria-label="Background">
            ${CoreAPI.windowGripsHtml('the background picker')}
            <div class="cl-cwin-header">
                <div class="cl-cwin-title">
                    <i class="fa-solid fa-image"></i>
                    <span class="cl-cwin-name">Background</span>
                    <span class="cl-cwin-sep">·</span>
                    <span class="cl-cwin-meta" id="cbgSource"></span>
                </div>
                <div class="cl-cwin-controls">
                    <button type="button" class="cl-cwin-btn is-close" data-bg-act="close" title="Close (Esc)" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="cbg-content" id="cbgContent"></div>
        </aside>
    </div>`;
}

function scopeRowHtml() {
    const scopes = [
        ['chat', 'This Chat'],
        ['character', 'This Character'],
        ['global', 'Everywhere'],
    ];
    return `<div class="cbg-scopes" role="tablist" aria-label="Which scope to edit">
        ${scopes.map(([k, label]) => `<button type="button" role="tab" class="cbg-scope${_scope === k ? ' is-on' : ''}"
            data-bg-act="scope" data-scope="${k}" aria-selected="${_scope === k}"
            ${k === 'character' && !_char?.id ? 'disabled' : ''}>${label}</button>`).join('')}
    </div>`;
}

function tabsHtml() {
    const tabs = [['library', 'Library', 'fa-images'], ['gallery', 'Gallery', 'fa-user'], ['upload', 'Add', 'fa-plus']];
    return `<div class="cl-cwin-tabs" role="tablist" aria-label="Where to pick from">
        ${tabs.map(([k, label, icon]) => `<button type="button" role="tab" class="cl-cwin-tab${_tab === k ? ' is-on' : ''}"
            data-bg-act="tab" data-tab="${k}" aria-selected="${_tab === k}">
            <i class="fa-solid ${icon}"></i><span>${label}</span></button>`).join('')}
    </div>`;
}

// The memory cost is the whole reason width/height ride the row.
function ramLabel(background, tier) {
    if (!background?.width || !background?.height) return '';
    const w = tier === 0 || tier === null ? background.width : Math.min(tier, background.width);
    const h = Math.round(background.height * (w / background.width));
    return `${w}x${h}, ~${CoreAPI.formatBytes(w * h * 4)} in memory`;
}

function tileHtml(item, kind) {
    const active = kind === 'library' && _draft?.background?.id === item.id;
    const src = kind === 'library'
        ? CoreAPI.thumbUrl('background', item.id, TILE_THUMB)
        : (item.mediaId ? CoreAPI.thumbUrl('media', item.mediaId, TILE_THUMB)
            : (item.url ? CoreAPI.serverUrl(item.url) : item.url));
    const tile = `<button type="button" class="cl-cwin-tile${active ? ' is-active' : ''}"
        data-bg-act="${kind === 'library' ? 'pick' : 'promote'}"
        data-id="${esc(kind === 'library' ? item.id : item.mediaId)}"
        title="${esc(item.displayName || item.name)}">
        <img src="${esc(src)}" alt="${esc(item.displayName || item.name)}" loading="lazy" decoding="async">
    </button>`;
    if (kind !== 'library') return tile;
    // the rail is a SIBLING over the tile (buttons cant nest); the phone's long-press sheet derives its rows from it
    const usedTitle = `Applied at ${item.usedBy} scope${item.usedBy === 1 ? '' : 's'}`;
    return `<div class="cbg-tile-wrap">
        ${tile}
        <span class="cbg-tile-acts">
            <button type="button" class="cbg-tile-act" data-bg-act="rename" data-id="${esc(item.id)}" title="Rename" aria-label="Rename"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="cbg-tile-act is-danger" data-bg-act="delete" data-id="${esc(item.id)}" title="Delete" aria-label="Delete"><i class="fa-solid fa-trash"></i></button>
        </span>
        ${item.usedBy ? `<span class="cbg-tile-badge" title="${esc(usedTitle)}"><i class="fa-solid fa-link"></i>${item.usedBy}</span>` : ''}
    </div>`;
}

// the avatar isnt a media row: its own tile, promoted through the byte upload
function avatarTileHtml() {
    if (!_char?.id) return '';
    const src = CoreAPI.getCharacterAvatarThumbUrl(_char) || CoreAPI.getCharacterAvatarUrl(_char);
    return `<button type="button" class="cl-cwin-tile cbg-tile-avatar" data-bg-act="promote-avatar"
        title="${esc(_char.name || 'Character')} (avatar)">
        <img src="${esc(src)}" alt="${esc(_char.name || 'Avatar')}" loading="lazy" decoding="async">
        <span class="cbg-tile-tag">Avatar</span>
    </button>`;
}

function sliderHtml(field, label, min, max, step, value, format) {
    return `<label class="cbg-row">
        <span class="cbg-label">${label}</span>
        <input type="range" class="cl-range cbg-range" data-bg-field="${field}" min="${min}" max="${max}" step="${step}" value="${value}">
        <span class="cbg-readout" data-bg-readout="${field}">${format}</span>
    </label>`;
}

function knobsHtml() {
    const k = _draft || DEFAULT_KNOBS;
    const bg = _draft?.background;
    return `<div class="cbg-knobs">
        <label class="cbg-row">
            <span class="cbg-label">Fit</span>
            <select class="cl-select-fluid cbg-select" data-bg-field="fit">
                ${FITS.map(([v, l]) => `<option value="${v}"${k.fit === v ? ' selected' : ''}>${l}</option>`).join('')}
            </select>
        </label>
        ${sliderHtml('opacity', 'Opacity', 0, 1, 0.05, k.opacity, Number(k.opacity).toFixed(2))}
        ${sliderHtml('blur', 'Blur', 0, 40, 1, k.blur, `${Math.round(k.blur)}px`)}
        ${sliderHtml('brightness', 'Brightness', 0, 2, 0.05, k.brightness, Number(k.brightness).toFixed(2))}
        ${sliderHtml('saturate', 'Saturate', 0, 2, 0.05, k.saturate, Number(k.saturate).toFixed(2))}
        <label class="cbg-row">
            <span class="cbg-label">Resolution</span>
            <select class="cl-select-fluid cbg-select" data-bg-field="renderWidth">
                ${RESOLUTIONS.map(([v, l]) => `<option value="${v === null ? '' : v}"${(k.renderWidth ?? null) === v ? ' selected' : ''}>${l}</option>`).join('')}
            </select>
        </label>
        <p class="cbg-cost">${esc(ramLabel(bg, k.renderWidth ?? null))}</p>
    </div>`;
}

function footerHtml() {
    const isSet = !!_draft;
    return `<div class="cbg-footer">
        <button type="button" class="cl-cwin-btn-text cbg-btn" data-bg-act="none" title="Show no wallpaper here, and stop inheriting one">
            <i class="fa-solid fa-ban"></i> No Background
        </button>
        <button type="button" class="cl-cwin-btn-text cbg-btn" data-bg-act="inherit" ${isSet ? '' : 'disabled'}
            title="Clear this scope so it follows the one above it">
            <i class="fa-solid fa-arrow-turn-up"></i> Inherit
        </button>
        <button type="button" class="cl-cwin-btn-text is-primary cbg-btn" data-bg-act="apply">
            <i class="fa-solid fa-check"></i> Apply
        </button>
    </div>`;
}

function render() {
    const content = document.getElementById('cbgContent');
    if (!content) return;

    if (_loading) {
        content.innerHTML = '<div class="cl-cwin-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><p>Reading backgrounds</p></div>';
        return;
    }
    if (_error) {
        content.innerHTML = `<div class="cl-cwin-empty is-error"><i class="fa-solid fa-triangle-exclamation"></i>
            <p>Could not read the backgrounds.</p><p class="cl-cwin-dim">${esc(_error)}</p></div>`;
        return;
    }

    let body = '';
    if (_tab === 'library') {
        // Unread and empty are different answers and must not share a rendering.
        body = _library === null ? ''
            : _library.length
                ? `<div class="cl-cwin-tiles">${_library.map(i => tileHtml(i, 'library')).join('')}</div>`
                : `<div class="cl-cwin-empty"><i class="fa-solid fa-images"></i><p>No backgrounds yet.</p>
                   <p class="cl-cwin-dim">Add one from this character's gallery, or upload a file.</p></div>`;
    } else if (_tab === 'gallery') {
        const usable = (_gallery || []).filter(i => i.kind !== 'video' && i.mediaId);
        const avatar = avatarTileHtml();
        // the avatar tile needs no gallery read, so it stays under the failure line
        const failed = _galleryError ? `<div class="cl-cwin-empty is-error"><i class="fa-solid fa-triangle-exclamation"></i>
            <p>Could not read this character's gallery.</p><p class="cl-cwin-dim">${esc(_galleryError)}</p></div>` : '';
        body = _gallery === null && !failed ? ''
            : (usable.length || avatar)
                ? `${failed}<div class="cl-cwin-tiles">${avatar}${usable.map(i => tileHtml(i, 'gallery')).join('')}</div>`
                : failed || `<div class="cl-cwin-empty"><i class="fa-solid fa-user"></i><p>No gallery images for this character.</p></div>`;
    } else {
        body = `<div class="cbg-add">
            <label class="cbg-drop" data-bg-act="pickfile">
                <i class="fa-solid fa-arrow-up-from-bracket"></i>
                <span>Choose an image</span>
                <input type="file" accept="image/*" class="cbg-file" id="cbgFile" hidden>
            </label>
            <div class="cbg-url-row">
                <input type="search" class="cl-cwin-input cbg-url" id="cbgUrl" placeholder="or paste an image URL">
                <button type="button" class="cl-cwin-btn-text cbg-btn" data-bg-act="fromurl">Fetch</button>
            </div>
            <p class="cl-cwin-dim">Images are copied into your library, so they keep working if the source goes away.</p>
        </div>`;
    }

    content.innerHTML = scopeRowHtml() + tabsHtml() + `<div class="cbg-body">${body}</div>` + knobsHtml() + footerHtml();
    syncRangeFill(content);
    content.querySelectorAll('select').forEach(s => CoreAPI.initCustomSelect(s));
    const meta = document.getElementById('cbgSource');
    if (meta) meta.textContent = headerMeta();
}

// ========================================
// STATE
// ========================================

// null when the scope has no subject (eg. no chat row yet), never a path with an empty id
function scopePath() {
    if (_scope === 'global') return '/backgrounds/bindings/global';
    if (_scope === 'character') return _char?.id ? `/backgrounds/bindings/character/${encodeURIComponent(_char.id)}` : null;
    return _chatId ? `/backgrounds/bindings/chat/${encodeURIComponent(_chatId)}` : null;
}

async function loadScope() {
    _draft = null;
    _saved = null;
    const path = scopePath();
    if (!path) return;
    try {
        const resp = await CoreAPI.apiRequest(path, 'GET');
        if (!resp.ok) return;
        // `binding: null` means this scope inherits. That is an answer, not a failure.
        const { binding } = await resp.json();
        _saved = binding;
        _draft = binding ? { ...binding } : null;
    } catch { /* leaving it inherited is the safe read */ }
}

// the header says what is TRUE: a picked tile paints at once, but nothing is 'set here' before Apply
function headerMeta() {
    const dirty = JSON.stringify(_draft || null) !== JSON.stringify(_saved || null);
    if (dirty) return 'unsaved';
    if (_saved) return _saved.background ? 'set here' : 'blank, set here';
    if (_resolvedSource === 'none') return 'none';
    const from = _resolvedSource === _scope ? 'set here' : `from ${_resolvedSource === 'global' ? 'everywhere' : `this ${_resolvedSource}`}`;
    return _resolvedBlank ? `blank, ${from}` : from;
}

async function loadAll() {
    _loading = true;
    _error = null;
    render();
    try {
        const resp = await CoreAPI.apiRequest('/backgrounds', 'GET');
        if (!resp.ok) throw new Error(`server returned ${resp.status}`);
        _library = await resp.json();
        _galleryError = null;
        if (_char?.id) {
            // the gallery tab's own failure: the library and the scope still load
            try {
                const info = await CoreAPI.getCharacterGalleryInfo(_char);
                _gallery = Array.isArray(info?.items) ? info.items : [];
            } catch (e) {
                _gallery = null;
                _galleryError = e.message;
            }
        } else {
            _gallery = [];
        }
        await loadScope();
    } catch (e) {
        _error = e.message;
        _library = null;
    }
    _loading = false;
    render();
}

/** Paint whatever the panel is currently drafting, without saving it. */
function preview() {
    applyWallpaper(_draft);
}

function setKnob(field, raw) {
    if (!_draft) _draft = { ...DEFAULT_KNOBS, background: null };
    if (field === 'fit') _draft.fit = raw;
    else if (field === 'renderWidth') _draft.renderWidth = raw === '' ? null : Number(raw);
    else _draft[field] = Number(raw);
    preview();
    // knob edits skip render(), so the header is told here or it claims 'set here' over unsaved knobs
    const meta = document.getElementById('cbgSource');
    if (meta) meta.textContent = headerMeta();
}

async function save(body) {
    const path = scopePath();
    if (!path) { CoreAPI.showToast('Nothing to bind this to yet', 'warning'); return false; }
    const resp = await CoreAPI.apiRequest(path, 'PUT', body);
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        CoreAPI.showToast(err.error || 'Could not save the background', 'error');
        return false;
    }
    _saved = await resp.json();
    _draft = { ..._saved };
    await refreshLibrary();
    return true;
}

// Bindings changed, so every tile's used-by count may have: re-read the list so the badges
// tell the truth the delete flow later relies on.
async function refreshLibrary() {
    try {
        const list = await CoreAPI.apiRequest('/backgrounds', 'GET');
        if (list.ok) _library = await list.json();
    } catch { /* stale badges heal on the next open */ }
}

async function applyDraft() {
    // Apply never mints an explicit-none row: it would shadow every scope below, and forcing blank is No Background's job
    if (!_draft?.background && !_saved) {
        CoreAPI.showToast('Pick a background first, or use No Background to force none at this scope', 'warning');
        return;
    }
    const k = _draft || DEFAULT_KNOBS;
    const ok = await save({
        backgroundId: _draft?.background?.id ?? null,
        fit: k.fit, opacity: k.opacity, blur: k.blur,
        brightness: k.brightness, saturate: k.saturate, renderWidth: k.renderWidth ?? null,
    });
    if (!ok) return;
    await repaintFromServer();
    CoreAPI.showToast('Background applied', 'success', 1800);
    render();
}

async function setNone() {
    if (!await save({ backgroundId: null })) return;
    await repaintFromServer();
    render();
}

async function setInherit() {
    const path = scopePath();
    if (!path) return;
    const resp = await CoreAPI.apiRequest(path, 'DELETE');
    if (!resp.ok && resp.status !== 404) {
        CoreAPI.showToast('Could not clear the background', 'error');
        return;
    }
    _draft = null;
    _saved = null;
    await refreshLibrary();
    await repaintFromServer();
    render();
}

// re-read the ladder, never paint the draft: a character edit under a winning chat binding changes nothing here
async function repaintFromServer() {
    await loadWallpaperFor(_chatId);
}

async function renameInLibrary(id) {
    const row = (_library || []).find(b => String(b.id) === String(id));
    if (!row) return;
    const name = await CoreAPI.showConfirm({
        title: 'Rename background',
        confirmLabel: 'Rename',
        input: { value: row.displayName || '', placeholder: 'Display name' },
    });
    if (typeof name !== 'string' || !name.trim() || name.trim() === row.displayName) return;
    const resp = await CoreAPI.apiRequest(`/backgrounds/${encodeURIComponent(id)}`, 'PATCH', { displayName: name.trim() });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        CoreAPI.showToast(err.error || 'Could not rename', 'error');
        return;
    }
    const updated = await resp.json();
    // the binding carries its own copy of the row: every copy takes the stored name
    for (const b of [row, _saved?.background, _draft?.background]) {
        if (b && String(b.id) === String(id)) b.displayName = updated.displayName;
    }
    await repaintFromServer();
    render();
}

// "2 chats and 1 character" out of the 409's {scope, id} rows, so the second ask names
// what actually breaks instead of a bare count.
function describeScopes(usedBy) {
    const counts = new Map();
    for (const u of usedBy || []) counts.set(u.scope, (counts.get(u.scope) || 0) + 1);
    const chats = counts.get('chat') || 0;
    const chars = counts.get('character') || 0;
    const parts = [];
    if (chats) parts.push(`${chats} chat${chats === 1 ? '' : 's'}`);
    if (chars) parts.push(`${chars} character${chars === 1 ? '' : 's'}`);
    if (counts.get('global')) parts.push('the global default');
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] || 'something');
}

async function deleteFromLibrary(id) {
    const row = (_library || []).find(b => String(b.id) === String(id));
    if (!row) return;
    const ok = await CoreAPI.showConfirm({
        title: 'Delete background',
        message: `"${row.displayName || 'This background'}" and its file are removed from the library. This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
        icon: 'fa-solid fa-trash',
    });
    if (ok !== true) return;
    let resp = await CoreAPI.apiRequest(`/backgrounds/${encodeURIComponent(id)}`, 'DELETE');
    if (resp.status === 409) {
        const body = await resp.json().catch(() => ({}));
        const who = describeScopes(body.usedBy);
        const force = await CoreAPI.showConfirm({
            title: 'Background is in use',
            message: `${who.charAt(0).toUpperCase()}${who.slice(1)} currently wear${(body.usedBy?.length || 0) === 1 ? 's' : ''} it. Delete anyway? Those scopes go back to inheriting.`,
            confirmLabel: 'Delete anyway',
            danger: true,
            icon: 'fa-solid fa-trash',
        });
        if (force !== true) return;
        resp = await CoreAPI.apiRequest(`/backgrounds/${encodeURIComponent(id)}?force=true`, 'DELETE');
    }
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        CoreAPI.showToast(err.error || 'Could not delete', 'error');
        return;
    }
    // the row is gone and its bindings cascaded to inherit; the draft re-reads only if it pointed at it
    _library = (_library || []).filter(b => String(b.id) !== String(id));
    if (String(_draft?.background?.id) === String(id) || String(_saved?.background?.id) === String(id)) {
        await loadScope();
    }
    await repaintFromServer();
    render();
    CoreAPI.showToast('Background deleted', 'success');
}

// the rail's verbs on the shared menu (its sheet on a phone), each row pressing its rail button
function openTileSheet(wrap, e) {
    const menu = CoreAPI.getModule('context-menu');
    const acts = [...wrap.querySelectorAll('.cbg-tile-act')];
    if (!menu?.showItems || !acts.length) return;
    menu.showItems(e, [
        { type: 'header', label: wrap.querySelector('.cl-cwin-tile')?.title || 'Background' },
        ...acts.map(a => ({
            icon: a.querySelector('i')?.className || '',
            label: a.getAttribute('aria-label') || a.title || 'Action',
            className: a.classList.contains('is-danger') ? 'danger' : '',
            action: () => a.click(),
        })),
    ]);
}

// the avatar rides the byte upload; content-hash dedup makes a second promote find the existing row
async function promoteAvatar() {
    if (!_char?.id) return;
    const src = CoreAPI.getCharacterAvatarUrl(_char);
    if (!src) { CoreAPI.showToast('This character has no avatar image', 'info'); return; }
    return promoteFromUrl(`${_char.name || 'Character'} avatar.png`, src, 'the avatar image');
}

// a picture that is no gallery row (the avatar, a chat's own) is promoted by its bytes, as the avatar always was
async function promoteFromUrl(name, src, what) {
    let blob = null;
    try {
        const resp = await fetch(src);
        if (resp.ok) blob = await resp.blob();
    } catch { /* handled below */ }
    if (!blob) { CoreAPI.showToast(`Could not read ${what}`, 'error'); return; }
    const row = await uploadBytes(name, blob);
    return afterAdd(row);
}

async function uploadBytes(name, blob) {
    const resp = await CoreAPI.apiRequest(`/backgrounds?name=${encodeURIComponent(name)}`, 'POST', blob, {
        headers: { 'Content-Type': blob.type || 'application/octet-stream' },
        raw: true,
    });
    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        CoreAPI.showToast(err.error || 'Upload failed', 'error');
        return null;
    }
    return resp.json();
}

async function afterAdd(row) {
    if (!row) return;
    const id = row.skipped ? row.duplicateOf : row.id;
    const resp = await CoreAPI.apiRequest('/backgrounds', 'GET');
    _library = resp.ok ? await resp.json() : _library;
    const picked = (_library || []).find(b => b.id === id);
    if (picked) {
        if (!_draft) _draft = { ...DEFAULT_KNOBS };
        _draft.background = picked;
        preview();
    }
    _tab = 'library';
    render();
}

// ========================================
// LIFECYCLE
// ========================================

function injectPanel() {
    if (panelInjected) return;
    const host = document.getElementById('chatsConversation');
    if (!host) return;
    panelInjected = true;
    host.insertAdjacentHTML('beforeend', buildPanelHTML());

    const sheet = document.querySelector('.cbg-sheet');
    mountChatWindow(sheet, { key: 'chatBgPanel', close: closePanel, min: { w: 22, h: 34 } });

    // peek while a knob is dragged (mobile): everything but the knobs fades, pointer capture keeps the thumb tracking
    sheet?.addEventListener('pointerdown', (e) => {
        if (!CoreAPI.isMobileMode() || !e.target.closest('.cbg-knobs .cl-range')) return;
        sheet.classList.add('cbg-peek');
        const endPeek = () => {
            sheet.classList.remove('cbg-peek');
            window.removeEventListener('pointerup', endPeek);
            window.removeEventListener('pointercancel', endPeek);
        };
        window.addEventListener('pointerup', endPeek);
        window.addEventListener('pointercancel', endPeek);
    });

    // touch has no hover: long-press (contextmenu) opens the rail's verbs as a sheet, its rows derived from the rail
    sheet?.addEventListener('contextmenu', (e) => {
        if (!CoreAPI.isMobileMode()) return;
        const wrap = e.target.closest('.cbg-tile-wrap');
        if (!wrap) return;
        e.preventDefault();
        openTileSheet(wrap, e);
    });

    sheet?.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-bg-act]');
        if (!btn) return;
        switch (btn.dataset.bgAct) {
            case 'close': return closePanel();
            case 'scope':
                _scope = btn.dataset.scope;
                await loadScope();
                // an inheriting scope repaints the truth: previewing its null draft blanked the wallpaper
                if (_draft) preview(); else await repaintFromServer();
                return render();
            case 'tab': _tab = btn.dataset.tab; return render();
            case 'pick': {
                const picked = (_library || []).find(b => String(b.id) === btn.dataset.id);
                if (!picked) return undefined;
                if (!_draft) _draft = { ...DEFAULT_KNOBS };
                _draft.background = picked;
                preview();
                return render();
            }
            case 'promote': {
                const resp = await CoreAPI.apiRequest(`/backgrounds/from-media/${encodeURIComponent(btn.dataset.id)}`, 'POST');
                if (!resp.ok) { CoreAPI.showToast('Could not add that image', 'error'); return undefined; }
                return afterAdd(await resp.json());
            }
            case 'promote-avatar': return promoteAvatar();
            case 'rename': return renameInLibrary(btn.dataset.id);
            case 'delete': return deleteFromLibrary(btn.dataset.id);
            case 'pickfile': return document.getElementById('cbgFile')?.click();
            case 'fromurl': {
                const url = document.getElementById('cbgUrl')?.value?.trim();
                if (!url) return undefined;
                const resp = await CoreAPI.apiRequest('/backgrounds/from-url', 'POST', { url });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    CoreAPI.showToast(err.error || 'Could not fetch that image', 'error');
                    return undefined;
                }
                return afterAdd(await resp.json());
            }
            case 'none': return setNone();
            case 'inherit': return setInherit();
            case 'apply': return applyDraft();
            default: return undefined;
        }
    });

    sheet?.addEventListener('input', (e) => {
        const field = e.target?.dataset?.bgField;
        if (!field) return;
        setKnob(field, e.target.value);
        const readout = sheet.querySelector(`[data-bg-readout="${field}"]`);
        if (readout) {
            readout.textContent = field === 'blur'
                ? `${Math.round(e.target.value)}px`
                : Number(e.target.value).toFixed(2);
        }
        const cost = sheet.querySelector('.cbg-cost');
        if (cost) cost.textContent = ramLabel(_draft?.background, _draft?.renderWidth ?? null);
    });

    sheet?.addEventListener('change', async (e) => {
        if (!e.target?.matches?.('.cbg-file')) return;
        const file = e.target.files?.[0];
        if (!file) return;
        await afterAdd(await uploadBytes(file.name, file));
        e.target.value = '';
    });

    registerChatWindow('chatBgPanel', { close: closePanel, follow: followCharacter });
}

/** @param {{char: object, chatId: string, background: object, promotePicture?: {name: string, url: string}}} ctx handed in by the chat */
export function openPanel(ctx) {
    _char = ctx?.char || _char;
    _chatId = ctx?.chatId || _chatId;
    injectPanel();
    const panel = document.getElementById('chatBgPanel');
    if (!panel) return;
    openChatWindow(panel, { button: 'chatConvBackground' });
    panelOpen = true;
    if (ctx?.tab) _tab = ctx.tab;
    loadAll().then(() => {
        // Opening straight from a gallery image means that image is the point of opening.
        if (ctx?.promoteMediaId) {
            const tile = document.querySelector(`[data-bg-act="promote"][data-id="${CSS.escape(String(ctx.promoteMediaId))}"]`);
            tile?.click();
        } else if (ctx?.promoteAvatar) {
            document.querySelector('[data-bg-act="promote-avatar"]')?.click();
        } else if (ctx?.promotePicture?.url) {
            void promoteFromUrl(ctx.promotePicture.name || 'picture.png', ctx.promotePicture.url, 'that picture');
        }
    });
}

export function closePanel() {
    const panel = document.getElementById('chatBgPanel');
    panelOpen = false;
    closeChatWindow(panel, { button: 'chatConvBackground' });
    // Closing without applying puts back what is actually saved, so a dragged slider that
    // was never committed does not survive as the thing on screen.
    repaintFromServer();
}

export function togglePanel(ctx) {
    if (panelOpen) closePanel();
    else openPanel(ctx);
}

function followCharacter(detail) {
    if (!panelOpen || !_char?.id || detail?.charId !== _char.id) return;
    const fresh = CoreAPI.getCharacterById(_char.id);
    if (fresh) _char = fresh;
}

function init() {
    // follow the conversation, or the old scope and draft land on the new chat; the subject comes from the event
    document.addEventListener('cl-chat-changed', (e) => {
        if (!e.detail?.chatId) {
            // Nulled BEFORE the close: closePanel repaints from the server via _chatId,
            // and the old id here would paint the left chat's wallpaper over the grid.
            _chatId = null;
            _draft = null;
            _saved = null;
            if (panelOpen) closePanel();
            return;
        }
        if (e.detail.chatId === _chatId && (!e.detail.char || e.detail.char.id === _char?.id)) return;
        _chatId = e.detail.chatId;
        if (e.detail.char) _char = e.detail.char;
        _scope = 'chat';
        _draft = null;
        _saved = null;
        _gallery = null;
        _galleryError = null;
        _error = null;
        if (panelOpen) void loadAll();
    });
}

export default { init, openPanel, closePanel, togglePanel, applyWallpaper, clearWallpaper, loadWallpaperFor };
