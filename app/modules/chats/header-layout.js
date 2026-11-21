// The desktop conversation header as the reader arranged it: the real openers placed by arrangement.js, dragged, grouped, right-clicked.

import CoreAPI from '../core-api.js';
import { registerFeedPatcher } from '../feed.js';
import { liveSpecs, onDoorsSynced } from './extension-windows.js';
import * as A from './arrangement.js';

const SETTING = 'chatHeaderLayout';
const EXT = 'ext:';
const DRAG_THRESHOLD = 5;
const HOVER_OPEN_MS = 450;
// a group's icons: none a core opener or a bundled window wears, so a group never reads as one of its members
export const GROUP_ICONS = Object.freeze([
    'fa-folder', 'fa-folder-open', 'fa-folder-tree', 'fa-layer-group', 'fa-box-archive', 'fa-boxes-stacked', 'fa-inbox', 'fa-table-cells-large',
    'fa-shapes', 'fa-cubes', 'fa-toolbox', 'fa-screwdriver-wrench', 'fa-flask', 'fa-compass-drafting', 'fa-photo-film', 'fa-clapperboard',
    'fa-music', 'fa-palette', 'fa-book-open', 'fa-bookmark', 'fa-scroll', 'fa-feather-pointed', 'fa-note-sticky', 'fa-comments',
    'fa-user-group', 'fa-heart', 'fa-star', 'fa-bolt', 'fa-lightbulb', 'fa-flag', 'fa-thumbtack', 'fa-dice-d20',
]);
// an opener's states, each the class it wears: the header's fitRow, a group and the group's rows all read this one table
export const OPENER_MARKS = Object.freeze({ current: 'is-panel-open', marked: 'is-marked', working: 'is-working', waiting: 'is-waiting' });

const esc = (s) => CoreAPI.escapeHtml(s);
const isMobile = () => document.documentElement.classList.contains('cl-mobile');
const menuApi = () => CoreAPI.getModule('context-menu');

let _row = null;            // .chat-conv-header-right
let _header = null;         // #chatConvHeader, which takes the right-click
let _coreDefaults = [];     // the page's own order of core openers and dividers, read once
let _drawn = [];            // the last resolved list, what the row shows
let _menu = null;           // the open group's list: { el, groupId, button, byDrag }
let _picker = null;         // the open icon grid
let _press = null;          // a press that may become a drag
let _drag = null;           // the drag under way
let _applyOwed = false;     // a repaint held for the drag's end
let _swallowClick = false;  // the click a finished drag would otherwise send

// ========================================
// THE ITEMS
// ========================================

const extKeyOf = (id) => id.slice(EXT.length);

function itemEl(id) {
    if (!_row || !id) return null;
    if (id.startsWith(EXT)) return _row.querySelector(`[data-ext-window="${CSS.escape(extKeyOf(id))}"]`);
    const el = document.getElementById(id);
    return el && _row.contains(el) ? el : null;
}

function itemLabel(id) {
    const el = itemEl(id);
    return (el?.getAttribute('aria-label') || el?.title || id).trim();
}

function itemIcon(id) {
    const i = itemEl(id)?.querySelector('i');
    return String(i?.className || '').split(/\s+/).find(c => c.startsWith('fa-') && c !== 'fa-solid') || 'fa-circle';
}

// the extension's name beside its window's, as Chat settings shows it
function itemOwner(id) {
    if (!id.startsWith(EXT)) return '';
    const spec = liveSpecs().find(s => s.key === extKeyOf(id));
    return spec && String(spec.extName || '').trim().toLowerCase() !== String(spec.label || '').trim().toLowerCase() ? spec.extName : '';
}

// an opener its own surface hid (an extension window this chat does not take) is not live; the reader's hiding is not that
function liveIds() {
    const live = new Set();
    for (const id of _coreDefaults) if (!A.isDivider(id) && itemEl(id) && !itemEl(id).classList.contains('hidden')) live.add(id);
    for (const s of liveSpecs()) if (itemEl(EXT + s.key)) live.add(EXT + s.key);
    return live;
}

function defaultsNow() {
    return [..._coreDefaults, 'sep:ext', ...liveSpecs().map(s => EXT + s.key)];
}

function arrangement() {
    return A.normalizeArrangement(CoreAPI.getSetting(SETTING));
}

const isDefault = () => {
    const a = arrangement();
    return a.order === null && !a.hidden.length;
};

function groupLabel(node) {
    if (node.name) return node.name;
    const names = (node.items || []).filter(n => (typeof n === 'string' ? !A.isDivider(n) : n.kind === 'item')).map(n => itemLabel(typeof n === 'string' ? n : n.id));
    return names.length ? names.join(', ') : 'Group';
}

function save(next, { focus = null } = {}) {
    CoreAPI.setSetting('chatHeaderLayout', next ? A.normalizeArrangement(next) : null);
    apply();
    if (focus) refocus(focus);
}

// an edit through the model: the order placed first, so nothing live is lost
function change(fn, opts) {
    save(fn(arrangement(), defaultsNow(), liveIds()), opts);
}

// ========================================
// PLACING THE ROW
// ========================================

function dividerEl(id) {
    let el = _row.querySelector(`.chat-conv-head-sep[data-arr-id="${CSS.escape(id)}"]`);
    if (!el) {
        el = document.createElement('span');
        el.className = 'chat-conv-head-sep';
        el.dataset.arrId = id;
        el.dataset.ownGesture = '';
        el.setAttribute('aria-hidden', 'true');
    }
    return el;
}

function groupEl(node) {
    let el = _row.querySelector(`.chat-conv-group[data-arr-id="${CSS.escape(node.id)}"]`);
    if (!el) {
        el = document.createElement('button');
        el.type = 'button';
        el.className = 'chat-conv-group';
        el.dataset.arrId = node.id;
        el.setAttribute('aria-haspopup', 'menu');
        el.setAttribute('aria-expanded', 'false');
        el.innerHTML = '<i></i><span class="chat-conv-group-mark" aria-hidden="true"></span>';
    }
    const label = groupLabel(node);
    el.title = label;
    el.setAttribute('aria-label', label);
    el.querySelector('i').className = `fa-solid ${node.icon || GROUP_ICONS[0]}`;
    return el;
}

/** Draw the row from the arrangement over the openers present now; safe to call at any time. */
export function apply() {
    if (!_row) return;
    if (_drag) { _applyOwed = true; return; }
    const live = liveIds();
    _drawn = A.resolveArrangement(arrangement(), { defaults: defaultsNow(), live });
    const tail = _row.querySelector('.chat-conv-minimize') || _row.querySelector('.chat-conv-more');
    const placed = new Set();
    const put = (el) => { _row.insertBefore(el, tail); placed.add(el); };
    const show = (el, groupId) => {
        el.classList.remove('is-arranged-out');
        el.classList.toggle('is-filed', !!groupId);
        if (groupId) el.dataset.arrGroup = groupId; else delete el.dataset.arrGroup;
    };
    for (const node of _drawn) {
        if (node.kind === 'divider') { put(dividerEl(node.id)); continue; }
        if (node.kind === 'item') { const el = itemEl(node.id); show(el, null); el.dataset.arrId = node.id; put(el); continue; }
        put(groupEl(node));
        for (const m of node.items) {
            if (m.kind !== 'item') continue;
            const el = itemEl(m.id);
            el.dataset.arrId = m.id;
            show(el, node.id);
            put(el);
        }
    }
    // an opener hidden, filed in no drawn group or not live leaves the row's flow, kept for its listeners and marks
    for (const id of [..._coreDefaults, ...liveSpecs().map(s => EXT + s.key)]) {
        const el = itemEl(id);
        if (!el || placed.has(el)) continue;
        el.dataset.arrId = id;
        el.classList.add('is-arranged-out');
        el.classList.remove('is-filed');
        delete el.dataset.arrGroup;
    }
    for (const el of _row.querySelectorAll('.chat-conv-head-sep, .chat-conv-group')) if (!placed.has(el)) el.remove();
    mirrorMarks();
    if (_menu && !_drawn.some(n => n.kind === 'group' && n.id === _menu.groupId)) closeGroup();
    else if (_menu) renderGroup();
    CoreAPI.refitRow(_row);
    // what draws from the arrangement besides the row (Chat settings' Conversation header group) paints again
    document.dispatchEvent(new CustomEvent('cl-header-arranged'));
}

// a group carries its members' state: lit while one is open, a dot while one is marked, working or waiting
function mirrorMarks() {
    if (!_row) return;
    for (const g of _row.querySelectorAll('.chat-conv-group')) {
        const members = [..._row.querySelectorAll(`[data-arr-group="${CSS.escape(g.dataset.arrId)}"]`)];
        for (const cls of Object.values(OPENER_MARKS)) g.classList.toggle(cls, members.some(m => m.classList.contains(cls)));
    }
    if (_menu) markRows();
}

// a press, a move or a removal moves focus; it is put back on the node the reader acted on
function refocus(target) {
    requestAnimationFrame(() => {
        const el = typeof target === 'string' ? (itemEl(target) || _row?.querySelector(`[data-arr-id="${CSS.escape(target)}"]`)) : target;
        if (el && el.getClientRects().length) el.focus({ preventScroll: true });
        else _header?.querySelector('#chatConvTitle')?.focus({ preventScroll: true });
    });
}

// ========================================
// A GROUP'S LIST
// ========================================

function drawnGroup(id) { return _drawn.find(n => n.kind === 'group' && n.id === id) || null; }

function anchorOf(button) {
    const box = button.getClientRects().length ? button : _row?.querySelector('.chat-conv-more');
    const r = (box || button).getBoundingClientRect();
    return { x: r.left, y: r.bottom + 2 };
}

function openGroup(button, { byDrag = false, focus = false } = {}) {
    const node = drawnGroup(button.dataset.arrId);
    if (!node) return;
    if (_menu?.groupId === node.id) return;
    closeGroup();
    closePicker();
    const el = document.createElement('div');
    el.className = 'cl-context-menu chat-conv-group-menu visible';
    el.id = 'chatConvGroupMenu';
    el.setAttribute('role', 'menu');
    document.body.appendChild(el);
    _menu = { el, groupId: node.id, button, byDrag };
    renderGroup();
    const at = anchorOf(button);
    menuApi()?.placeMenu?.(el, at.x, at.y);
    button.setAttribute('aria-expanded', 'true');
    button.setAttribute('aria-controls', el.id);
    el.addEventListener('click', onGroupClick);
    el.addEventListener('keydown', onGroupKey);
    el.addEventListener('contextmenu', onGroupContext);
    el.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointerdown', onOutsideGroup, true);
    if (focus) el.querySelector('[role="menuitem"]')?.focus();
}

function renderGroup() {
    const node = drawnGroup(_menu.groupId);
    if (!node) return closeGroup();
    _menu.el.setAttribute('aria-label', groupLabel(node));
    _menu.el.innerHTML = node.items.map(m => (m.kind === 'divider'
        ? `<div class="cl-context-menu-separator chat-conv-group-sep" role="separator" data-arr-id="${esc(m.id)}"></div>`
        : `<div class="cl-context-menu-item" role="menuitem" tabindex="-1" data-arr-id="${esc(m.id)}"><i class="fa-solid ${esc(itemIcon(m.id))}"></i><span>${esc(itemLabel(m.id))}</span></div>`)).join('');
    markRows();
}

function markRows() {
    if (!_menu) return;
    for (const row of _menu.el.querySelectorAll('.cl-context-menu-item')) {
        const el = itemEl(row.dataset.arrId);
        // a menu row lights as is-current, as More's rows do; its dots are the opener's own classes
        for (const [k, cls] of Object.entries(OPENER_MARKS)) row.classList.toggle(k === 'current' ? 'is-current' : cls, !!el?.classList.contains(cls));
    }
}

function closeGroup({ focusButton = false } = {}) {
    if (!_menu) return;
    const { el, button } = _menu;
    _menu = null;
    document.removeEventListener('pointerdown', onOutsideGroup, true);
    el.remove();
    button.setAttribute('aria-expanded', 'false');
    button.removeAttribute('aria-controls');
    if (focusButton) refocus(button);
}

function onOutsideGroup(e) {
    if (!_menu || _menu.el.contains(e.target) || _menu.button.contains(e.target)) return;
    // the right-click's menu opened over the list is part of it
    if (e.target.closest?.('#clContextMenu')) return;
    closeGroup();
}

function pressMember(id) {
    closeGroup();
    // pressed once this click has run its course, so it cannot close what it opens
    setTimeout(() => itemEl(id)?.click(), 0);
}

function onGroupClick(e) {
    const row = e.target.closest('.cl-context-menu-item');
    if (!row || _swallowClick) return;
    pressMember(row.dataset.arrId);
}

function onGroupKey(e) {
    menuApi()?.menuKeys?.(e, [..._menu.el.querySelectorAll('[role="menuitem"]')], {
        press: (row) => pressMember(row.dataset.arrId),
        close: () => closeGroup({ focusButton: true }),
        leave: () => closeGroup(),
    });
}

// ========================================
// THE ICON GRID
// ========================================

function openPicker(groupId) {
    closePicker();
    const button = _row?.querySelector(`.chat-conv-group[data-arr-id="${CSS.escape(groupId)}"]`);
    const node = drawnGroup(groupId);
    if (!button || !node) return;
    const el = document.createElement('div');
    el.className = 'cl-context-menu chat-conv-icon-grid visible';
    el.id = 'chatConvIconGrid';
    el.setAttribute('role', 'listbox');
    el.setAttribute('aria-label', 'Group icon');
    const current = node.icon || GROUP_ICONS[0];
    el.innerHTML = GROUP_ICONS.map(icon => `<button type="button" role="option" aria-selected="${icon === current}" class="chat-conv-icon-cell${icon === current ? ' is-current' : ''}" data-icon="${icon}" title="${esc(icon.slice(3).replace(/-/g, ' '))}" aria-label="${esc(icon.slice(3).replace(/-/g, ' '))}"><i class="fa-solid ${icon}"></i></button>`).join('');
    document.body.appendChild(el);
    _picker = { el, groupId, button };
    const at = anchorOf(button);
    menuApi()?.placeMenu?.(el, at.x, at.y);
    el.addEventListener('click', (e) => {
        const cell = e.target.closest('[data-icon]');
        if (!cell) return;
        const { groupId: gid, button: b } = _picker;
        closePicker();
        change((a, d, l) => A.setGroupLook(a, d, l, gid, { icon: cell.dataset.icon }), { focus: b.dataset.arrId });
    });
    el.addEventListener('keydown', (e) => {
        const cells = [...el.querySelectorAll('[data-icon]')];
        const at = cells.indexOf(document.activeElement);
        const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 8, ArrowUp: -8 }[e.key];
        if (step) { e.preventDefault(); cells[Math.min(cells.length - 1, Math.max(0, at + step))]?.focus(); }
    });
    document.addEventListener('pointerdown', onOutsidePicker, true);
    (el.querySelector('.is-current') || el.querySelector('[data-icon]'))?.focus();
}

function closePicker({ focusButton = false } = {}) {
    if (!_picker) return;
    const { el, button } = _picker;
    document.removeEventListener('pointerdown', onOutsidePicker, true);
    el.remove();
    _picker = null;
    if (focusButton) refocus(button);
}

function onOutsidePicker(e) {
    if (_picker && !_picker.el.contains(e.target)) closePicker();
}

// ========================================
// THE RIGHT-CLICK
// ========================================

// a keyboard's menu (Shift+F10, the menu key) has no pointer: it opens under what it was asked on
function anchorFor(e, el) {
    if (e.clientX || e.clientY) return { x: e.clientX, y: e.clientY };
    const r = (el || e.target).getBoundingClientRect();
    return { x: r.left, y: r.bottom };
}

// a second menu in the first's place: asked once the click that chose it has closed the first
function showAgain(at, items) {
    setTimeout(() => menuApi()?.showItems?.({ preventDefault() {}, stopPropagation() {}, clientX: at.x, clientY: at.y }, items, at), 0);
}

function where(id) {
    for (const node of _drawn) {
        if (node.id === id) return { list: _drawn, index: _drawn.indexOf(node), group: null };
        if (node.kind === 'group') {
            const at = node.items.findIndex(m => m.id === id);
            if (at !== -1) return { list: node.items, index: at, group: node };
        }
    }
    return null;
}

function moveBy(id, step) {
    const w = where(id);
    if (!w) return;
    const target = w.list[w.index + step];
    if (!target) return;
    const before = step < 0 ? target.id : (w.list[w.index + step + 1]?.id ?? null);
    change((a, d, l) => A.moveNode(a, d, l, id, before ? { before } : (w.group ? { into: w.group.id } : {})), { focus: id });
}

function hide(id) {
    const name = id.startsWith(A.GROUP) ? groupLabel(drawnGroup(id) || {}) : itemLabel(id);
    const w = where(id);
    const next = w ? (w.list[w.index + 1] || w.list[w.index - 1]) : null;
    change((a, d, l) => A.setHidden(a, d, l, id, true));
    refocus(next && next.kind !== 'divider' ? next.id : (w?.group ? w.group.id : null));
    CoreAPI.showToast(`${name} hidden. Right-click the header to bring it back.`, 'info', 4000, { group: 'header-hidden' });
}

function groupsOtherThan(groupId) {
    return _drawn.filter(n => n.kind === 'group' && n.id !== groupId);
}

function newGroupFor(id) {
    const used = new Set(arrangement().order?.filter(A.isGroup).map(g => g.icon) || []);
    const icon = GROUP_ICONS.find(i => !used.has(i)) || GROUP_ICONS[0];
    const { arrangement: next, groupId } = A.newGroup(arrangement(), defaultsNow(), liveIds(), id, { icon });
    if (!groupId) return;
    save(next, { focus: groupId });
    // the icon is the group's only face: the grid opens on it straight away
    requestAnimationFrame(() => openPicker(groupId));
}

function moveToGroupMenu(id, at, back) {
    const w = where(id);
    const items = [
        { type: 'header', label: `Move ${itemLabel(id)} to` },
        { icon: 'fa-solid fa-arrow-left', label: 'Back', action: () => showAgain(at, back()) },
        ...groupsOtherThan(w?.group?.id).map(g => ({ icon: `fa-solid ${g.icon || GROUP_ICONS[0]}`, label: groupLabel(g), action: () => change((a, d, l) => A.moveNode(a, d, l, id, { into: g.id }), { focus: g.id }) })),
        ...(groupsOtherThan(w?.group?.id).length ? [{ type: 'separator' }] : []),
        { icon: 'fa-solid fa-folder-plus', label: 'New Group', action: () => newGroupFor(id) },
    ];
    showAgain(at, items);
}

// what the reader hid that the row could draw now: a live opener, or a group with a live member
function hiddenRows() {
    const a = arrangement();
    const live = liveIds();
    const groups = new Map((a.order || []).filter(A.isGroup).map(g => [g.id, g]));
    return { groups, rows: a.hidden.filter(id => live.has(id) || (groups.has(id) && groups.get(id).items.some(m => live.has(m)))) };
}

function hiddenMenu(at, back) {
    const { rows, groups } = hiddenRows();
    showAgain(at, [
        { type: 'header', label: 'Hidden Buttons' },
        { icon: 'fa-solid fa-arrow-left', label: 'Back', action: () => showAgain(at, back()) },
        ...rows.map(id => (groups.has(id)
            ? { icon: `fa-solid ${groups.get(id).icon || GROUP_ICONS[0]}`, label: groupLabel(groups.get(id)), hint: 'Group', action: () => change((x, d, l) => A.setHidden(x, d, l, id, false), { focus: id }) }
            : { icon: `fa-solid ${itemIcon(id)}`, label: itemLabel(id), action: () => change((x, d, l) => A.setHidden(x, d, l, id, false), { focus: id }) })),
    ]);
}

async function resetHeader() {
    const ok = await CoreAPI.showConfirm({
        title: 'Reset the header?',
        message: 'The buttons go back to their first order, groups and dividers go, and every hidden button shows again.',
        confirmLabel: 'Reset', danger: true,
    });
    if (ok !== true) return;
    save(null, { focus: _coreDefaults.find(id => !A.isDivider(id)) });
}

// the end of every menu: the way back for a hidden button, and the way back to the header as it ships
function tail(at, back) {
    const n = hiddenRows().rows.length;
    return [
        { type: 'separator' },
        ...(n ? [{ icon: 'fa-solid fa-eye', label: 'Hidden Buttons', hint: `${n} hidden`, action: () => hiddenMenu(at, back) }] : []),
        { icon: 'fa-solid fa-rotate-left', label: 'Reset Header', disabled: isDefault(), hint: isDefault() ? 'Already as it ships' : undefined, action: () => void resetHeader() },
    ];
}

// Left and Right in the row, Up and Down inside a group; neither past an end
function moveItems(id, w) {
    if (!w) return [];
    const filed = !!w.group;
    return [
        ...(w.index === 0 ? [] : [{ icon: `fa-solid ${filed ? 'fa-arrow-up' : 'fa-arrow-left'}`, label: filed ? 'Move Up' : 'Move Left', action: () => moveBy(id, -1) }]),
        ...(w.index === w.list.length - 1 ? [] : [{ icon: `fa-solid ${filed ? 'fa-arrow-down' : 'fa-arrow-right'}`, label: filed ? 'Move Down' : 'Move Right', action: () => moveBy(id, 1) }]),
    ];
}

// a divider on the node's left: never at the edge, never beside another
function dividerItem(id, w) {
    const prev = w?.list[w.index - 1];
    if (!prev || prev.kind === 'divider') return [];
    return [{ icon: 'fa-solid fa-grip-lines-vertical', label: 'Add Divider', action: () => change((a, d, l) => A.addDivider(a, d, l, prev.id), { focus: id }) }];
}

function itemMenu(id, at) {
    const w = where(id);
    const filed = !!w?.group;
    const back = () => itemMenu(id, at);
    return [
        { type: 'header', label: itemLabel(id) },
        ...moveItems(id, w),
        { type: 'separator' },
        ...(filed ? [{ icon: 'fa-solid fa-arrow-up-from-bracket', label: 'Remove from Group', action: () => change((a, d, l) => A.ungroupItem(a, d, l, id), { focus: id }) }] : []),
        { icon: 'fa-solid fa-folder-plus', label: 'Move to Group', action: () => moveToGroupMenu(id, at, back) },
        ...dividerItem(id, w),
        { type: 'separator' },
        { icon: 'fa-solid fa-eye-slash', label: 'Hide', action: () => hide(id) },
        ...tail(at, back),
    ];
}

function groupMenu(id, at) {
    const w = where(id);
    const node = drawnGroup(id);
    const back = () => groupMenu(id, at);
    return [
        { type: 'header', label: groupLabel(node || {}) },
        ...moveItems(id, w),
        { type: 'separator' },
        { icon: 'fa-solid fa-pen', label: 'Rename', action: () => void renameGroup(id) },
        { icon: 'fa-solid fa-icons', label: 'Change Icon', action: () => setTimeout(() => openPicker(id), 0) },
        ...dividerItem(id, w),
        { icon: 'fa-solid fa-object-ungroup', label: 'Ungroup', action: () => change((a, d, l) => A.ungroup(a, d, l, id), { focus: node?.items.find(m => m.kind === 'item')?.id }) },
        { type: 'separator' },
        { icon: 'fa-solid fa-eye-slash', label: 'Hide', action: () => hide(id) },
        ...tail(at, back),
    ];
}

function dividerMenu(id, at) {
    const w = where(id);
    const back = () => dividerMenu(id, at);
    return [
        { type: 'header', label: 'Divider' },
        ...moveItems(id, w),
        { icon: 'fa-solid fa-xmark', label: 'Remove Divider', action: () => change((a, d, l) => A.removeDivider(a, d, l, id)) },
        ...tail(at, back),
    ];
}

function headerMenu(at) {
    const items = tail(at, () => headerMenu(at)).slice(1);
    return items;
}

async function renameGroup(id) {
    const node = drawnGroup(id);
    if (!node) return;
    const name = await CoreAPI.showConfirm({
        title: 'Rename the group',
        message: 'Its name shows when you point at it, and to a screen reader.',
        confirmLabel: 'Rename',
        input: { value: node.name || '', placeholder: groupLabel(node) },
    });
    if (typeof name !== 'string') return;
    change((a, d, l) => A.setGroupLook(a, d, l, id, { name }), { focus: id });
}

/** The menu for one arranged node, by its id; null for an id the row does not draw. */
export function menuFor(id, at) {
    if (!where(id)) return null;
    if (id.startsWith(A.GROUP)) return groupMenu(id, at);
    if (A.isDivider(id)) return dividerMenu(id, at);
    return itemMenu(id, at);
}

function onHeaderContext(e) {
    if (isMobile() || !_row) return;
    const menu = menuApi();
    if (!menu?.showItems) return;
    const node = _row.contains(e.target) ? e.target.closest('[data-arr-id]') : null;
    const at = anchorFor(e, node);
    const items = (node && menuFor(node.dataset.arrId, at)) || headerMenu(at);
    if (!items.length) return;
    menu.showItems(e, items, at);
}

function onGroupContext(e) {
    const row = e.target.closest('[data-arr-id]');
    const menu = menuApi();
    if (!row || !menu?.showItems) return;
    const at = anchorFor(e, row);
    const items = menuFor(row.dataset.arrId, at);
    if (items) menu.showItems(e, items, at);
}

/** The right-click on a row behind More: the opener's own menu, in the More list's place. */
export function contextForCollapsed(el, e) {
    const id = el?.dataset?.arrId;
    const at = anchorFor(e, e.currentTarget || el);
    const items = id && menuFor(id, at);
    if (items) showAgain(at, items);
}

// ========================================
// DRAGGING
// ========================================

function onPointerDown(e) {
    if (e.button !== 0 || e.pointerType === 'touch' || isMobile() || _drag) return;
    const el = e.target.closest('[data-arr-id]');
    if (!el || !(_row?.contains(el) || _menu?.el.contains(el))) return;
    if (el.classList.contains('is-arranged-out')) return;
    _press = { id: el.dataset.arrId, el, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', cancelDrag, true);
}

function onPointerMove(e) {
    if (!_press || e.pointerId !== _press.pointerId) return;
    if (!_drag) {
        if (Math.hypot(e.clientX - _press.x, e.clientY - _press.y) < DRAG_THRESHOLD) return;
        startDrag();
    }
    e.preventDefault();
    moveDrag(e);
}

function startDrag() {
    const { id, el } = _press;
    const ghost = document.createElement('div');
    ghost.className = 'chat-conv-drag-ghost';
    ghost.innerHTML = A.isDivider(id) ? '<span class="chat-conv-head-sep"></span>' : `<i class="fa-solid ${esc(id.startsWith(A.GROUP) ? (drawnGroup(id)?.icon || GROUP_ICONS[0]) : itemIcon(id))}"></i>`;
    document.body.appendChild(ghost);
    el.classList.add('is-dragging');
    document.documentElement.classList.add('cl-header-dragging');
    _drag = { id, el, ghost, target: null, hover: null };
    if (id.startsWith(A.GROUP) && _menu?.groupId === id) closeGroup();
    // on the window, ahead of the overlay stack's Escape on the document, so a cancel closes nothing else
    window.addEventListener('keydown', onDragKey, true);
    window.addEventListener('blur', cancelDrag);
}

function clearMarks() {
    for (const el of document.querySelectorAll('.is-drop-before, .is-drop-after, .is-drop-into')) el.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-into');
}

// the slots of a list of drawn nodes along one axis: the reader drops before the node whose half they are past
function slotIn(nodes, pos, axis) {
    for (let i = 0; i < nodes.length; i++) {
        const r = nodes[i].el.getBoundingClientRect();
        const mid = axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2;
        if (pos < mid) return i;
    }
    return nodes.length;
}

function moveDrag(e) {
    const zoom = CoreAPI.uiZoom();
    Object.assign(_drag.ghost.style, { left: `${e.clientX / zoom + 8}px`, top: `${e.clientY / zoom + 8}px` });
    clearMarks();
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const inMenu = _menu && under && _menu.el.contains(under);
    const inRow = under && _row.contains(under) && !under.closest('.chat-conv-more');
    const dragged = _drag.id;
    let target = null;
    if (inMenu) {
        const node = drawnGroup(_menu.groupId);
        const nodes = node.items.map(m => ({ id: m.id, el: _menu.el.querySelector(`[data-arr-id="${CSS.escape(m.id)}"]`) })).filter(n => n.el);
        if (!dragged.startsWith(A.GROUP)) {
            const i = slotIn(nodes, e.clientY, 'y');
            target = { group: node.id, before: nodes[i]?.id ?? null, markEl: nodes[i]?.el || nodes.at(-1)?.el, after: i >= nodes.length };
        }
    } else if (inRow || (under && _header?.contains(under) && !under.closest('.chat-conv-more'))) {
        const nodes = _drawn.map(n => ({ id: n.id, kind: n.kind, el: _row.querySelector(`[data-arr-id="${CSS.escape(n.id)}"]:not(.is-filed)`) })).filter(n => n.el && n.el.getClientRects().length);
        const overGroup = under?.closest?.('.chat-conv-group');
        if (overGroup && !dragged.startsWith(A.GROUP) && overGroup.dataset.arrId !== where(dragged)?.group?.id) {
            const r = overGroup.getBoundingClientRect();
            if (e.clientX > r.left + r.width / 4 && e.clientX < r.right - r.width / 4) target = { into: overGroup.dataset.arrId, markEl: overGroup };
        }
        if (!target) {
            const i = slotIn(nodes, e.clientX, 'x');
            target = { before: nodes[i]?.id ?? null, markEl: nodes[i]?.el || nodes.at(-1)?.el, after: i >= nodes.length };
        }
    }
    // a slot beside the dragged node itself moves nothing, so it shows nothing
    if (target && !target.into) {
        const w = where(dragged);
        const list = target.group ? drawnGroup(target.group)?.items : _drawn;
        const sameList = w && list && w.list === list;
        if (sameList && (target.before === dragged || (target.before ? list[list.findIndex(n => n.id === target.before) - 1]?.id === dragged : list.at(-1)?.id === dragged))) target = null;
    }
    _drag.target = target;
    if (target?.markEl) target.markEl.classList.add(target.into ? 'is-drop-into' : target.after ? 'is-drop-after' : 'is-drop-before');
    // resting on a group opens it after a moment, so a sweep past one never does
    const hoverId = target?.into || null;
    if (hoverId !== _drag.hover?.id) {
        clearTimeout(_drag.hover?.timer);
        _drag.hover = hoverId ? { id: hoverId, timer: setTimeout(() => { const b = _row.querySelector(`.chat-conv-group[data-arr-id="${CSS.escape(hoverId)}"]`); if (b && _drag) openGroup(b, { byDrag: true }); }, HOVER_OPEN_MS) } : null;
    }
}

function onPointerUp(e) {
    if (!_press || e.pointerId !== _press.pointerId) return;
    const drag = _drag;
    endPress();
    if (!drag) return;
    _swallowClick = true;
    setTimeout(() => { _swallowClick = false; }, 0);
    const t = drag.target;
    if (!t || !liveIds().has(drag.id) && !drag.id.startsWith(A.GROUP) && !A.isDivider(drag.id)) { finishDrag(drag); return; }
    finishDrag(drag);
    if (t.into) change((a, d, l) => A.moveNode(a, d, l, drag.id, { into: t.into }), { focus: t.into });
    else if (t.group) change((a, d, l) => A.moveNode(a, d, l, drag.id, t.before ? { before: t.before } : { into: t.group }), { focus: drag.id });
    else change((a, d, l) => A.moveNode(a, d, l, drag.id, t.before ? { before: t.before } : {}), { focus: drag.id });
}

function onDragKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancelDrag();
}

function endPress() {
    _press = null;
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('pointercancel', cancelDrag, true);
}

function finishDrag(drag) {
    clearTimeout(drag.hover?.timer);
    drag.ghost.remove();
    drag.el.classList.remove('is-dragging');
    document.documentElement.classList.remove('cl-header-dragging');
    window.removeEventListener('keydown', onDragKey, true);
    window.removeEventListener('blur', cancelDrag);
    clearMarks();
    _drag = null;
    if (drag.target?.group == null && _menu?.byDrag) closeGroup();
    if (_applyOwed) { _applyOwed = false; apply(); }
}

function cancelDrag() {
    const drag = _drag;
    endPress();
    if (drag) finishDrag({ ...drag, target: null });
}

// a click that ends a drag is no press
function onRowClickCapture(e) {
    if (!_swallowClick) return;
    e.preventDefault();
    e.stopPropagation();
}

// ========================================
// CHAT SETTINGS
// ========================================

/**
 * Every opener live now in the header's order, hidden ones included, for Chat settings' Conversation header group.
 * @returns {Array<{kind: 'item', id: string, label: string, icon: string, owner: string, hidden: boolean}|{kind: 'divider', id: string}|{kind: 'group', id: string, label: string, icon: string, hidden: boolean, items: Array}>}
 */
export function headerRows() {
    if (!_row) return [];
    const a = arrangement();
    const live = liveIds();
    const hidden = new Set(a.hidden);
    const item = (id) => ({ kind: 'item', id, label: itemLabel(id), icon: itemIcon(id), owner: itemOwner(id), hidden: hidden.has(id) });
    // a divider the row does not draw (at an edge, beside another) is not listed either
    const drawnDividers = new Set(_drawn.flatMap(n => (n.kind === 'divider' ? [n.id] : n.kind === 'group' ? n.items.filter(m => m.kind === 'divider').map(m => m.id) : [])));
    const out = [];
    for (const node of A.placeAll(a, defaultsNow(), live)) {
        if (A.isGroup(node)) {
            const items = node.items.filter(id => (A.isDivider(id) ? drawnDividers.has(id) : live.has(id))).map(id => (A.isDivider(id) ? { kind: 'divider', id } : item(id)));
            if (items.some(n => n.kind === 'item')) out.push({ kind: 'group', id: node.id, label: groupLabel(node), icon: node.icon || GROUP_ICONS[0], hidden: hidden.has(node.id), items });
        } else if (A.isDivider(node)) { if (drawnDividers.has(node)) out.push({ kind: 'divider', id: node }); }
        else if (live.has(node)) out.push(item(node));
    }
    return out;
}

export function setHidden(id, hide) {
    change((a, d, l) => A.setHidden(a, d, l, id, hide));
}

export function removeDivider(id) {
    change((a, d, l) => A.removeDivider(a, d, l, id));
}

export { resetHeader, isDefault };

// ========================================
// INIT
// ========================================

function onMarkMutations(records) {
    let relive = false;
    for (const r of records) {
        const el = r.target;
        if (!el.dataset?.arrId || el.classList.contains('chat-conv-group')) continue;
        if ((r.oldValue || '').split(/\s+/).includes('hidden') !== el.classList.contains('hidden')) relive = true;
    }
    if (relive) apply();
    else mirrorMarks();
}

/** @param {{ header: HTMLElement, row: HTMLElement }} opts the header (its right-click) and its openers' row */
export function init({ header, row } = {}) {
    if (!row || _row) return;
    _row = row;
    _header = header || row.closest('#chatConvHeader');
    // the page's own order: its openers by id and its dividers numbered, extension openers excluded (they arrive later)
    let n = 0;
    for (const el of row.children) {
        if (el.matches('.chat-conv-head-sep')) { el.dataset.arrId = `sep:d${++n}`; el.dataset.ownGesture = ''; _coreDefaults.push(el.dataset.arrId); }
        else if (el.matches('button[id]:not(.chat-conv-minimize):not(.chat-conv-more):not(.cxw-open-btn)')) _coreDefaults.push(el.id);
    }
    _header?.addEventListener('contextmenu', onHeaderContext);
    row.addEventListener('pointerdown', onPointerDown);
    row.addEventListener('click', onRowClickCapture, true);
    row.addEventListener('click', (e) => {
        const g = e.target.closest('.chat-conv-group');
        if (!g || _swallowClick) return;
        if (_menu?.groupId === g.dataset.arrId) closeGroup();
        else openGroup(g, { focus: e.detail === 0 });
    });
    new MutationObserver(onMarkMutations).observe(row, { attributes: true, attributeFilter: ['class'], attributeOldValue: true, subtree: true });
    onDoorsSynced(() => apply());
    registerFeedPatcher('setting', (records) => {
        if (records && !records.some(r => r.all || (r.ids || []).includes(SETTING))) return;
        apply();
    });
    document.addEventListener('cl-mobile-mode-change', () => { closeGroup(); closePicker(); cancelDrag(); });
    document.addEventListener('cl-chat-changed', () => { closeGroup(); closePicker(); });
    const closeFromStack = () => closeGroup({ focusButton: true });
    window.registerOverlay?.({ id: 'chatConvGroupMenu', tier: 7, close: closeFromStack, visible: (el) => !!el && document.documentElement.classList.contains('cl-chat-open') });
    const closePickerFromStack = () => closePicker({ focusButton: true });
    window.registerOverlay?.({ id: 'chatConvIconGrid', tier: 7, close: closePickerFromStack, visible: (el) => !!el && document.documentElement.classList.contains('cl-chat-open') });
    apply();
}

export default { init, apply, headerRows, setHidden, removeDivider, resetHeader, isDefault, menuFor, contextForCollapsed, GROUP_ICONS, OPENER_MARKS };
