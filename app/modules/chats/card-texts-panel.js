// This chat's card: the texts a chat holds of its own (ST's Chat Character Settings Override) and its Author's Note.

import CoreAPI from '../core-api.js';
import { mountChatWindow, openChatWindow, closeChatWindow, registerChatWindow } from './window.js';

const esc = (s) => CoreAPI.escapeHtml(s);

// each under the chat_metadata key SillyTavern keeps it in, and the card field it stands in for
const FIELDS = [
    { key: 'scenario', label: 'Scenario', card: 'scenario', hint: 'Wherever the story places the card\'s scenario, and {{scenario}}.' },
    { key: 'mes_example', label: 'Example dialogue', card: 'mes_example', hint: 'Wherever the story places the card\'s examples. Start each with <START>.' },
    { key: 'system_prompt', label: 'Main prompt', card: 'system_prompt', hint: 'Wherever the preset takes the card\'s own system prompt; {{original}} is the preset\'s.' },
];

// the note's parts, each under the chat_metadata key SillyTavern keeps it in
const NOTE_KEYS = { prompt: 'note_prompt', interval: 'note_interval', depth: 'note_depth', position: 'note_position', role: 'note_role' };
// ST's placements and voices, by the numbers the chat keeps (1 is in the chat, at the depth)
const NOTE_POSITIONS = [[2, 'Before the main prompt'], [0, 'After the main prompt'], [1, 'In the chat, at a depth']];
const NOTE_ROLES = [[0, 'System'], [1, 'User'], [2, 'Assistant']];
const IN_CHAT = 1;
// the default note's settings, what a new chat starts from; the server reads the same keys
const DEFAULT_FIELDS = [
    { part: 'prompt', key: 'chatAuthorsNoteDefault' },
    { part: 'interval', key: 'chatAuthorsNoteDefaultInterval' },
    { part: 'depth', key: 'chatAuthorsNoteDefaultDepth' },
    { part: 'position', key: 'chatAuthorsNoteDefaultPosition' },
    { part: 'role', key: 'chatAuthorsNoteDefaultRole' },
];
const SCAN_FIELD = { key: 'chatAuthorsNoteScanLore' };

/** Whether a chat's metadata holds any of its own card texts. */
export function holdsOwnTexts(meta) {
    return FIELDS.some(f => typeof meta?.[f.key] === 'string' && !!meta[f.key]);
}

let panelInjected = false;
let panelOpen = false;

let _chatId = null;
let _charId = null;
let _onChange = null;
let _own = null;        // the chat's texts as the server holds them, by key; null is not read yet
let _card = null;       // the card's own texts, by key; null is not known, which is not empty
let _error = null;
let _loading = false;
let _dirty = false;
let _saving = false;
let _tab = 'card';      // the view shown: the card's texts or the Author's Note
let _note = null;       // the note as the server answers it (GET /chats/{id}/authors-note); null is not read
let _noteDirty = { chat: false, defaults: false };
let _chatName = '';     // the shown chat's stored name, for the band that says the window stayed on it
let _followTo = null;   // the chat the conversation moved to while typing here was kept; followed once it is settled

const isDirty = () => _dirty || _noteDirty.chat || _noteDirty.defaults;

function buildPanelHTML() {
    return `
    <div class="cl-cwin cct-panel" id="chatCardTextsPanel" aria-hidden="true">
        <aside class="cl-cwin-sheet cct-sheet" role="dialog" aria-label="This chat's card">
            ${CoreAPI.windowGripsHtml('the chat card texts window')}
            <div class="cl-cwin-header">
                <div class="cl-cwin-title">
                    <i class="fa-solid fa-address-card"></i>
                    <span class="cl-cwin-name">This chat's card</span>
                </div>
                <div class="cl-cwin-controls">
                    <button type="button" class="cl-cwin-btn is-close" data-cct-act="close" title="Close (Esc)" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="cl-cwin-tabs cct-tabs" role="tablist" aria-label="What to edit">
                <button type="button" role="tab" class="cl-cwin-tab" data-cct-act="tab" data-tab="card" aria-selected="false">
                    <i class="fa-solid fa-address-card"></i><span>Card Texts</span></button>
                <button type="button" role="tab" class="cl-cwin-tab" data-cct-act="tab" data-tab="note" aria-selected="false">
                    <i class="fa-solid fa-feather-pointed"></i><span>Author's Note</span></button>
            </div>
            <div class="cct-held" id="cctHeld" hidden></div>
            <div class="cct-content" id="cctContent"></div>
            <div class="cct-foot-host" id="cctFoot"></div>
        </aside>
    </div>`;
}

function placeholderOf(f) {
    if (_card === null) return 'The card\'s text could not be read.';
    return _card[f.key] || `The card has no ${f.label.toLowerCase()}; nothing is sent here unless you write one.`;
}

function fieldHtml(f) {
    const own = !!_own[f.key];
    return `<div class="cl-cwin-block">
        <div class="cct-field-head">
            <label class="cl-cwin-label" for="cctField_${f.key}">${esc(f.label)}</label>
            <span class="cl-cwin-tag${own ? ' is-accent' : ''}">${own ? 'This chat\'s' : 'The card\'s'}</span>
        </div>
        <textarea id="cctField_${f.key}" class="cl-cwin-input cl-cwin-textarea cct-input" data-cct-field="${f.key}"
            rows="5" placeholder="${esc(placeholderOf(f))}">\n${esc(_own[f.key] || '')}</textarea>
        <p class="cl-cwin-hint">${esc(f.hint)}</p>
    </div>`;
}

function paintTabs() {
    document.querySelectorAll('.cct-tabs [data-tab]').forEach(b => {
        const on = b.dataset.tab === _tab;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-selected', String(on));
    });
}

// both views stay in the page, so moving between them never drops what is typed
function showTab(tab) {
    _tab = tab;
    paintTabs();
    document.querySelectorAll('.cct-sheet [data-cct-view]').forEach(v => { v.hidden = v.dataset.cctView !== tab; });
}

function noteOptions(list, value) {
    return list.map(([v, label]) => `<option value="${v}"${Number(value) === v ? ' selected' : ''}>${esc(label)}</option>`).join('');
}

// one note's controls, the chat's or the default's: every one ST offers, hints only where the label isnt enough
function noteFieldsHtml(group, v, hints) {
    const id = (part) => `cctNote_${group}_${part}`;
    const field = `data-cct-note="${group}"`;
    const hint = (text) => (hints && text ? `<p class="cl-cwin-hint">${text}</p>` : '');
    const row = (part, label, control, text, extra = '') => `<div class="cl-cwin-block"${extra}>
            <div class="cl-cwin-field">
                <label class="cl-cwin-field-label" for="${id(part)}">${label}</label>
                ${control}
            </div>
            ${hint(text)}
        </div>`;
    const number = (part) => `<input type="number" id="${id(part)}" class="cl-cwin-input cl-cwin-field-control cl-cwin-num" ${field} data-part="${part}"
                    min="0" max="9999" step="1" inputmode="numeric" value="${esc(v[part])}">`;
    const select = (part, list) => `<select id="${id(part)}" class="cl-select-fluid cl-cwin-field-control" ${field} data-part="${part}">${noteOptions(list, v[part])}</select>`;
    return `<div class="cl-cwin-block">
            <label class="cl-cwin-label" for="${id('prompt')}">Note</label>
            <textarea id="${id('prompt')}" class="cl-cwin-input cl-cwin-textarea cct-input" ${field} data-part="prompt"
                rows="4" placeholder="Nothing is sent while this is empty.">\n${esc(v.prompt)}</textarea>
            ${hint('{{char}}, {{user}} and the other macros work here.')}
        </div>
        ${row('position', 'Placement', select('position', NOTE_POSITIONS), 'Before or after the main prompt, or inside the chat at a depth.')}
        ${row('depth', 'Depth', number('depth'), 'Messages back from the newest; 0 is after the last one.', ` data-cct-depth="${group}"${Number(v.position) === IN_CHAT ? '' : ' hidden'}`)}
        ${row('role', 'Voice', select('role', NOTE_ROLES), 'Who the note speaks as. System suits most models.')}
        ${row('interval', 'Frequency', number('interval'), 'Every so many of your messages: 1 is every reply, 0 never.')}`;
}

// when the note next rides a reply, from the server's schedule
function scheduleText() {
    if (_note.untilNext === null) return 'Disabled: it is not sent.';
    if (Number(_note.note.interval) === 1) return 'Sent with every reply.';
    if (_note.due) return 'A reply to your last message carries it.';
    return `Sent after ${_note.untilNext} more of your message${_note.untilNext === 1 ? '' : 's'}.`;
}

function noteViewHtml() {
    if (!_note) {
        return `<div class="cl-cwin-empty is-error"><i class="fa-solid fa-triangle-exclamation"></i><p>Could not read this chat's note.</p></div>`;
    }
    const n = _note.note;
    const own = Object.values(n.own || {}).some(Boolean);
    return `<section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-feather-pointed"></i>This chat${own ? ''
                : '<span class="cl-cwin-tag cct-group-tag">Using the default</span>'}</h4>
            <p class="cl-cwin-group-note">Sent with this chat's story every so many of your messages, where you place it.</p>
            <div class="cl-cwin-fields">
                ${noteFieldsHtml('chat', n, true)}
                <p class="cct-schedule" data-cct-schedule><i class="fa-solid fa-clock" aria-hidden="true"></i><span>${esc(scheduleText())}</span></p>
            </div>
        </section>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-file-circle-plus"></i>Default for new chats</h4>
            <p class="cl-cwin-group-note">A new chat starts with this note. A chat with none of its own reads it until a reply is sent.</p>
            <div class="cl-cwin-fields">${noteFieldsHtml('defaults', _note.defaults, false)}</div>
        </section>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-book-atlas"></i>Lorebook scanning</h4>
            <p class="cl-cwin-group-note">Applies to every chat.</p>
            <div class="cl-cwin-fields">
                <div class="cl-cwin-block">
                    <label class="cl-cwin-field cl-cwin-toggle">
                        <span class="cl-cwin-field-label">Scan the note</span>
                        <input type="checkbox" class="cl-switch-input" data-cct-note="defaults" data-part="scanLore" ${_note.scanLore ? 'checked' : ''}>
                        <span class="cl-switch" aria-hidden="true"></span>
                    </label>
                    <p class="cl-cwin-hint">Lorebook entries may fire on the note when it is sent, and on the card's Character's Note.</p>
                </div>
            </div>
        </section>`;
}

function cardViewHtml() {
    return `<section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-address-card"></i>This chat's card texts</h4>
            <p class="cl-cwin-group-note">Used instead of the card's, wherever the story reads the card's. Left empty, the card's is used.</p>
            <div class="cl-cwin-fields">${FIELDS.map(fieldHtml).join('')}</div>
        </section>`;
}

// each tab's verbs, in the bar under the body
function cardVerbsHtml() {
    const anyOwn = FIELDS.some(f => _own[f.key]);
    return `<button type="button" class="cl-cwin-btn-text cct-btn" data-cct-act="remove-all"${anyOwn ? '' : ' disabled'}>Remove All</button>
            <span class="cct-foot-gap"></span>
            <button type="button" class="cl-cwin-btn-text cct-btn" data-cct-act="revert"${_dirty ? '' : ' disabled'}>Cancel</button>
            <button type="button" class="cl-cwin-btn-text is-primary cct-btn" data-cct-act="save"${_dirty ? '' : ' disabled'}>Save</button>`;
}

function noteVerbsHtml() {
    const noteDirty = _noteDirty.chat || _noteDirty.defaults;
    return `<span class="cct-foot-gap"></span>
            <button type="button" class="cl-cwin-btn-text cct-btn" data-cct-act="note-revert"${noteDirty ? '' : ' disabled'}>Cancel</button>
            <button type="button" class="cl-cwin-btn-text is-primary cct-btn" data-cct-act="note-save"${noteDirty && _note ? '' : ' disabled'}>Save</button>`;
}

function footHtml() {
    return `<div class="cct-foot" data-cct-view="card"${_tab === 'card' ? '' : ' hidden'}>${cardVerbsHtml()}</div>
        <div class="cct-foot" data-cct-view="note"${_tab === 'note' ? '' : ' hidden'}>${noteVerbsHtml()}</div>`;
}

// one tab repainted from the server's answer (its verbs alone when it already shows that); the other keeps its typing
function paintView(tab, { verbsOnly = false } = {}) {
    const view = document.querySelector(`#cctContent [data-cct-view="${tab}"]`);
    const verbs = document.querySelector(`#cctFoot [data-cct-view="${tab}"]`);
    if (!view || !verbs) { render(); return; }
    if (!verbsOnly) {
        view.innerHTML = tab === 'card' ? cardViewHtml() : noteViewHtml();
        view.querySelectorAll('select').forEach(sel => CoreAPI.initCustomSelect(sel));
    }
    verbs.innerHTML = tab === 'card' ? cardVerbsHtml() : noteVerbsHtml();
}

function render() {
    paintTabs();
    paintHeld();
    const content = document.getElementById('cctContent');
    const foot = document.getElementById('cctFoot');
    if (!content) return;
    const state = (html) => { content.innerHTML = html; if (foot) foot.innerHTML = ''; };
    if (_loading) return state('<div class="cl-cwin-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><p>Reading this chat</p></div>');
    if (_error) {
        return state(`<div class="cl-cwin-empty is-error"><i class="fa-solid fa-triangle-exclamation"></i>
            <p>Could not read this chat.</p><p class="cl-cwin-dim">${esc(_error)}</p></div>`);
    }
    if (_own === null) return state('');
    content.innerHTML = `<div class="cct-view" data-cct-view="card"${_tab === 'card' ? '' : ' hidden'}>${cardViewHtml()}</div>
    <div class="cct-view" data-cct-view="note"${_tab === 'note' ? '' : ' hidden'}>${noteViewHtml()}</div>`;
    if (foot) foot.innerHTML = footHtml();
    content.querySelectorAll('select').forEach(sel => CoreAPI.initCustomSelect(sel));
}

// the held band, painted on its own: render would put the stored texts over the typing
function paintHeld() {
    const slot = document.getElementById('cctHeld');
    if (!slot) return;
    slot.hidden = !_followTo;
    slot.innerHTML = _followTo ? `<div class="settings-band is-warn" role="status">
            <i class="fa-solid fa-thumbtack settings-band-icon"></i>
            <div class="settings-band-text">
                <span class="settings-band-when">Still on ${esc(_chatName || 'the chat you left')}</span>
                <span class="settings-band-sub">These edits are for that chat. Save or cancel them and this window follows the open chat.</span>
            </div>
        </div>` : '';
}

// typing enables the two verbs without a render, which would take the caret away
function markDirty() {
    if (_dirty) return;
    _dirty = true;
    document.querySelectorAll('.cct-sheet [data-cct-act="save"], .cct-sheet [data-cct-act="revert"]').forEach(b => { b.disabled = false; });
}

// which note was touched: a save writes only that one, so a default change never stores the chat's note
function markNoteDirty(group) {
    _noteDirty[group] = true;
    document.querySelectorAll('.cct-sheet [data-cct-act="note-save"], .cct-sheet [data-cct-act="note-revert"]').forEach(b => { b.disabled = false; });
}

// in the chat the note goes at a depth; elsewhere the depth is not asked
function followPlacement(el) {
    if (el?.dataset?.part !== 'position') return;
    const row = document.querySelector(`.cct-sheet [data-cct-depth="${el.dataset.cctNote}"]`);
    if (row) row.hidden = Number(el.value) !== IN_CHAT;
}

// ========================================
// DATA
// ========================================

// the chat's own texts by key, out of its metadata; a missing or non-text key is none
function ownTextsOf(meta) {
    return Object.fromEntries(FIELDS.map(f => [f.key, typeof meta?.[f.key] === 'string' ? meta[f.key] : '']));
}

// a save's re-read names its tab: no spinner, that tab repainted, the other tab's typing left standing
async function load({ only = null } = {}) {
    if (!_chatId) return;
    // the chat this load is FOR: a switch mid-load must not land (then save) the old chat's texts under the new
    const forChat = _chatId;
    let unread = false;
    if (!only) {
        _loading = true;
        _error = null;
        render();
    }
    try {
        const [chatResp, noteResp] = await Promise.all([
            CoreAPI.apiRequest(`/chats/${encodeURIComponent(forChat)}?msgTail=1`, 'GET'),
            CoreAPI.apiRequest(`/chats/${encodeURIComponent(forChat)}/authors-note`, 'GET'),
        ]);
        if (!chatResp.ok) throw new Error(`server returned ${chatResp.status}`);
        const chat = await chatResp.json();
        const note = noteResp.ok ? await noteResp.json() : null;
        if (forChat !== _chatId) return;
        const own = ownTextsOf(chat.chatMetadata);
        const charId = chat.charId || _charId;
        const charResp = charId ? await CoreAPI.apiRequest(`/characters/${encodeURIComponent(charId)}`, 'GET') : null;
        const data = charResp?.ok ? (await charResp.json())?.card?.data : null;
        if (forChat !== _chatId) return;
        _own = own;
        _note = note;
        _charId = charId;
        _chatName = typeof chat.name === 'string' ? chat.name : '';
        _card = data ? Object.fromEntries(FIELDS.map(f => [f.key, typeof data[f.card] === 'string' ? data[f.card] : ''])) : null;
    } catch (e) {
        if (forChat !== _chatId) return;
        if (only) {
            unread = true;
            CoreAPI.showToast(`Saved, but could not read it back: ${e.message}`, 'warning');
        } else {
            _error = e.message;
            _own = null;
        }
    }
    if (only) {
        if (only === 'card') _dirty = false;
        else _noteDirty = { chat: false, defaults: false };
        // a save whose re-read failed keeps what was typed on screen, which is what the server took
        paintView(only, { verbsOnly: unread });
        return;
    }
    _loading = false;
    _dirty = false;
    _noteDirty = { chat: false, defaults: false };
    render();
}

// meta is the conversation's fresh read of metaChat; under a clean window, follow quietly and repaint only what moved
async function follow(meta, metaChat) {
    if (_own === null || _error) { await load(); return; }
    const forChat = _chatId;
    let note = null;
    try {
        const resp = await CoreAPI.apiRequest(`/chats/${encodeURIComponent(forChat)}/authors-note`, 'GET');
        if (resp.ok) note = await resp.json();
    } catch { /* the note view keeps what it shows until the next read */ }
    if (forChat !== _chatId || isDirty() || _saving || _loading) return;
    if (meta && metaChat === forChat) {
        const own = ownTextsOf(meta);
        if (FIELDS.some(f => own[f.key] !== _own[f.key])) { _own = own; paintView('card'); }
    }
    if (!note) return;
    const shown = (n) => JSON.stringify(n ? { note: n.note, defaults: n.defaults, scanLore: n.scanLore } : null);
    const moved = shown(note) !== shown(_note);
    _note = note;
    const line = document.querySelector('#cctContent [data-cct-schedule] span');
    if (moved || !line) paintView('note');
    else line.textContent = scheduleText();
}

// every write re-reads what the server holds rather than assuming what it became
async function write(texts) {
    if (!_chatId || _saving) return false;
    _saving = true;
    try {
        const r = await CoreAPI.apiRequest(`/chats/${encodeURIComponent(_chatId)}`, 'PATCH', { chatMetadata: texts });
        if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            CoreAPI.showToast(err.error || 'Could not save this chat\'s card', 'error');
            return false;
        }
        await load({ only: 'card' });
        _onChange?.();
        return true;
    } catch (e) {
        // the typing and its Save stay, so the reader can try again
        CoreAPI.showToast(`Could not save this chat's card: ${e.message}`, 'error');
        return false;
    } finally {
        _saving = false;
    }
}

// sends only the fields that moved from the read; an empty field is the card's again (its key removed)
async function save() {
    const sheet = document.querySelector('.cct-sheet');
    const norm = (s) => (String(s ?? '').trim() ? String(s) : '');
    const texts = {};
    for (const f of FIELDS) {
        const text = norm(sheet?.querySelector(`[data-cct-field="${f.key}"]`)?.value);
        if (text !== norm(_own?.[f.key])) texts[f.key] = text || null;
    }
    if (!Object.keys(texts).length) {
        _dirty = false;
        paintView('card');
        return true;
    }
    return write(texts);
}

// the number a field holds as ST stores it: a depth is never negative, a frequency is whole
function noteNumber(part, raw) {
    const n = Math.round(Number(raw) || 0);
    return part === 'depth' ? Math.abs(n) : Math.max(0, n);
}

function noteValues(sheet, group) {
    const out = {};
    for (const part of Object.keys(NOTE_KEYS)) {
        const el = sheet?.querySelector(`[data-cct-note="${group}"][data-part="${part}"]`);
        out[part] = part === 'prompt' ? (el?.value ?? '') : noteNumber(part, el?.value);
    }
    return out;
}

// the parts of one note's controls that differ from the note the window read
function notePartsMoved(v, was) {
    return Object.keys(NOTE_KEYS).filter(part => (part === 'prompt' ? v.prompt !== String(was?.prompt ?? '') : v[part] !== noteNumber(part, was?.[part])));
}

// writes only the parts that moved from the read (the chat's under ST's keys, the rest as settings), then reads back
async function saveNote() {
    if (!_chatId || _saving) return false;
    const sheet = document.querySelector('.cct-sheet');
    const forChat = _chatId;
    _saving = true;
    try {
        const typed = _noteDirty.chat ? noteValues(sheet, 'chat') : null;
        const chatMoved = typed ? notePartsMoved(typed, _note?.note) : [];
        if (chatMoved.length) {
            const meta = Object.fromEntries(chatMoved.map(part => [NOTE_KEYS[part], typed[part]]));
            const r = await CoreAPI.apiRequest(`/chats/${encodeURIComponent(forChat)}`, 'PATCH', { chatMetadata: meta });
            if (!r.ok) {
                const err = await r.json().catch(() => ({}));
                CoreAPI.showToast(err.error || 'Could not save this chat\'s note', 'error');
                return false;
            }
        }
        if (_noteDirty.defaults) {
            const v = noteValues(sheet, 'defaults');
            const moved = new Set(notePartsMoved(v, _note?.defaults));
            const changes = Object.fromEntries(DEFAULT_FIELDS.filter(f => moved.has(f.part)).map(f => [f.key, v[f.part]]));
            const scan = !!sheet?.querySelector('[data-cct-note="defaults"][data-part="scanLore"]')?.checked;
            if (scan !== !!_note?.scanLore) changes[SCAN_FIELD.key] = scan;
            if (Object.keys(changes).length) {
                CoreAPI.setSettings(changes);
                await CoreAPI.flushSettings();
            }
        }
    } catch (e) {
        // the typing and its Save stay, so the reader can try again
        CoreAPI.showToast(`Could not save this chat's note: ${e.message}`, 'error');
        return false;
    } finally {
        _saving = false;
    }
    await load({ only: 'note' });
    _onChange?.();
    return true;
}

// each tab's Cancel puts back what the server holds there alone
function revertCard() {
    _dirty = false;
    paintView('card');
}

function revertNote() {
    _noteDirty = { chat: false, defaults: false };
    paintView('note');
}

async function removeAll() {
    const ok = await CoreAPI.showConfirm({
        title: 'Remove this chat\'s own texts?',
        content: [{ type: 'text', text: 'The card\'s scenario, example dialogue and main prompt are used again in this chat.' }],
        confirmLabel: 'Remove',
        danger: true,
    });
    if (!ok) return false;
    return write(Object.fromEntries(FIELDS.map(f => [f.key, null])));
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

    const sheet = document.querySelector('.cct-sheet');
    mountChatWindow(sheet, { key: 'chatCardTextsPanel', close: closePanel, min: { w: 24, h: 40 } });

    sheet?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-cct-act]');
        if (!btn || btn.disabled) return undefined;
        switch (btn.dataset.cctAct) {
            case 'close': return closePanel();
            case 'save': return save().then(settleFollow);
            case 'revert': revertCard(); return settleFollow();
            case 'remove-all': return removeAll().then(settleFollow);
            case 'tab': return showTab(btn.dataset.tab);
            case 'note-save': return saveNote().then(settleFollow);
            case 'note-revert': revertNote(); return settleFollow();
            default: return undefined;
        }
    });
    sheet?.addEventListener('input', (e) => {
        if (e.target?.matches?.('[data-cct-field]')) markDirty();
        else if (e.target?.dataset?.cctNote) markNoteDirty(e.target.dataset.cctNote);
    });
    // a select and a switch say so on change
    sheet?.addEventListener('change', (e) => {
        if (!e.target?.dataset?.cctNote) return;
        markNoteDirty(e.target.dataset.cctNote);
        followPlacement(e.target);
    });

    registerChatWindow('chatCardTextsPanel', { close: closePanel });
}

/** @param {{chatId: string, charId?: string, onChange?: Function}} ctx handed in by the conversation */
export function openPanel(ctx) {
    if (ctx && 'chatId' in ctx) _chatId = ctx.chatId;
    if (ctx && 'charId' in ctx) _charId = ctx.charId;
    if (ctx && 'onChange' in ctx) _onChange = ctx.onChange;
    injectPanel();
    const panel = document.getElementById('chatCardTextsPanel');
    if (!panel) return;
    openChatWindow(panel);
    panelOpen = true;
    load();
}

// true when nothing is held or the reader lets it go
async function confirmDiscard() {
    if (!isDirty()) return true;
    return CoreAPI.confirmDiscardEdits(_chatName ? `the card texts of ${_chatName}` : 'this chat\'s card texts');
}

// resolves whether it closed (unsaved typing asks first); never rejects, exclusive mode calls it bare
export async function closePanel({ force = false } = {}) {
    if (panelOpen && !force && !(await confirmDiscard())) return false;
    const panel = document.getElementById('chatCardTextsPanel');
    panelOpen = false;
    _dirty = false;
    _noteDirty = { chat: false, defaults: false };
    _followTo = null;
    closeChatWindow(panel);
    return true;
}

// the conversation moved on while this held typing: once it is saved or let go, follow the open chat
function settleFollow() {
    if (!_followTo || isDirty() || _saving) return;
    const { chatId, charId } = _followTo;
    _followTo = null;
    if (!chatId) { void closePanel({ force: true }); return; }
    _chatId = chatId;
    _charId = charId;
    if (panelOpen) load();
}

export function togglePanel(ctx) {
    if (panelOpen) closePanel();
    else openPanel(ctx);
}

/**
 * The chat's stored metadata changed (another tab, a reply's commit): follow it quietly, unless the reader is mid-edit.
 * @param {object|null} [meta] the conversation's fresh read of the chat's metadata
 * @param {string|null} [chatId] the chat that read is of
 */
export function followStored(meta = null, chatId = null) {
    if (panelOpen && !isDirty() && !_saving && !_loading) return follow(meta, chatId);
    return undefined;
}

// follow the conversation, asking first over unsaved typing: Discard follows, Keep Editing holds this chat in the band
async function followConversation(detail) {
    const next = { chatId: detail?.chatId || null, charId: detail?.char?.id || null };
    if (next.chatId && next.chatId === _chatId) {
        if (_followTo) { _followTo = null; paintHeld(); }
        return;
    }
    if (panelOpen && isDirty()) {
        _followTo = next;
        if (!(await confirmDiscard())) { paintHeld(); return; }
        // a later switch, or the conversation coming back here, answered first
        if (_followTo !== next) return;
        _followTo = null;
    }
    if (!next.chatId) { if (panelOpen) void closePanel({ force: true }); return; }
    _chatId = next.chatId;
    _charId = next.charId;
    if (panelOpen) load();
}

function init() {
    document.addEventListener('cl-chat-changed', (e) => { void followConversation(e.detail); });
}

export default { init, openPanel, closePanel, togglePanel, followStored, holdsOwnTexts };
