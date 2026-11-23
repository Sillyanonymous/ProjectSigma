// Who you are, as a window inside the conversation: a global persona with a per-chat override.

import CoreAPI from '../core-api.js';
import { mountChatWindow, openChatWindow, closeChatWindow, registerChatWindow } from './window.js';
import { registerFeedPatcher, movesChatPick } from '../feed.js';
import { setActivePersona, writePersona, deletePersona, pronounsHtml, applyPronounPreset, syncPronounPreset, readPronouns, bumpPersonaFace, personaFaceUrl, followPersonaPictures, notePersonaRead, personaRequest } from '../personas.js';

const esc = (s) => CoreAPI.escapeHtml(s);

// the shared face (modules/personas.js): built from the id, stamped by its picture alone
const avatarUrl = (p, size) => (p?.avatar ? personaFaceUrl(p.id, size) : null);

// faces render small, so a thumb tier rather than the full png
const ROW_AVATAR = 96;
const BANNER_AVATAR = 96;

function faceHtml(persona, size, cls) {
    const url = avatarUrl(persona, size);
    return url
        ? `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" decoding="async">`
        : `<span class="${cls} is-blank"><i class="fa-solid fa-user"></i></span>`;
}

let panelInjected = false;
let panelOpen = false;

let _chatId = null;
let _list = null;        // null means "not read yet", which is not an empty library
let _resolved = null;    // { persona, source, override } from the server
let _error = null;
let _loading = false;
let _editing = null;     // persona id being edited inline, or 'new'
let _onChange = null;
let _shelf = null;       // every world name on disk, for the lorebook picker; null = unread
let _shelfFailed = false; // the last read of the shelf failed, which is not an empty shelf

// the open editor across a redraw: its fields as drawn, and what the reader had typed, opened and focused in it
let _editorOpened = null;
let _editorKept = null;
// what the open editor's persona held when it was drawn, and whether it has moved under the reader's typing since
let _editorBase = null;
let _editorStale = false;
let _readSeq = 0;        // reads asked, numbered
let _takenSeq = 0;       // the newest answer taken; an older one landing after it is dropped
let _saving = false;     // the editor's own save is out: its echo is not a write from elsewhere
let _owedFollow = false; // a follow arrived during the save; a save that fails reads it after all

function buildPanelHTML() {
    return `
    <div class="cl-cwin cpp-panel" id="chatPersonasPanel" aria-hidden="true">
        <aside class="cl-cwin-sheet cpp-sheet" role="dialog" aria-label="Personas">
            ${CoreAPI.windowGripsHtml('the personas panel')}
            <div class="cl-cwin-header">
                <div class="cl-cwin-title">
                    <i class="fa-solid fa-masks-theater"></i>
                    <span class="cl-cwin-name">Personas</span>
                </div>
                <div class="cl-cwin-controls">
                    <button type="button" class="cl-cwin-btn is-close" data-cpp-act="close" title="Close (Esc)" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="cpp-content" id="cppContent"></div>
        </aside>
    </div>`;
}

// The one line that answers "who am I right now, and why".
function inForceHtml() {
    const name = _resolved?.persona?.name;
    const source = _resolved?.source || 'none';
    if (!name) {
        return `<div class="cl-cwin-inforce is-none">
            <i class="fa-solid fa-user-slash"></i>
            <div><strong>No persona</strong><span>{{user}} stays unresolved. Pick one below.</span></div>
        </div>`;
    }
    const why = source === 'chat'
        ? 'set for this chat only'
        : 'your global persona, used everywhere';
    return `<div class="cl-cwin-inforce">
        ${faceHtml(_resolved.persona, BANNER_AVATAR, 'cpp-face is-big')}
        <div><strong>${esc(name)}</strong><span>${esc(why)}</span></div>
        ${source === 'chat'
        ? `<button type="button" class="cl-cwin-btn-text cpp-btn" data-cpp-act="clear-override" title="Follow the global persona again">Use Global</button>`
        : ''}
    </div>`;
}

function rowHtml(p) {
    const isGlobal = _resolved?.source === 'global' && _resolved?.persona?.id === p.id;
    const isOverride = _resolved?.override === p.id;
    const editing = _editing === p.id;
    return `<li class="cl-cwin-row cpp-row${isOverride || isGlobal ? ' is-active' : ''}">
        <div class="cpp-row-main" data-cpp-act="edit" data-id="${esc(p.id)}" role="button" tabindex="0">
            ${faceHtml(p, ROW_AVATAR, 'cpp-face')}
            <span class="cpp-row-name">${esc(p.name)}</span>
            ${isOverride ? '<span class="cl-cwin-tag is-accent">this chat</span>' : ''}
            ${isGlobal ? '<span class="cl-cwin-tag">global</span>' : ''}
            <span class="cpp-row-desc">${esc((p.description || '').slice(0, 90))}</span>
        </div>
        <div class="cpp-row-acts">
            <button type="button" class="cpp-act is-pick cl-cwin-act" data-cpp-act="use-chat" data-id="${esc(p.id)}" title="Be this person in this chat only">
                <i class="fa-solid fa-comment"></i>
            </button>
            <button type="button" class="cpp-act is-pick cl-cwin-act" data-cpp-act="use-global" data-id="${esc(p.id)}" title="Be this person everywhere">
                <i class="fa-solid fa-globe"></i>
            </button>
            <button type="button" class="cpp-act cl-cwin-act is-danger" data-cpp-act="delete" data-id="${esc(p.id)}" title="Delete this persona">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
        ${editing ? editorHtml(p) : ''}
    </li>`;
}

// The persona's bound lorebooks. Existing personas only: a new one has no id yet.
function bookRowHtml(p) {
    const bound = Array.isArray(p.worlds) ? p.worlds : [];
    const pills = bound.map(w => `<span class="cpp-book-pill">
        <i class="fa-solid fa-book"></i><span class="cpp-book-name">${esc(w)}</span>
        <button type="button" class="cpp-book-x" data-cpp-act="book-remove" data-id="${esc(p.id)}" data-world="${esc(w)}"
            title="Unbind ${esc(w)} from this persona" aria-label="Unbind ${esc(w)}"><i class="fa-solid fa-xmark"></i></button>
    </span>`).join('');
    const options = (_shelf || [])
        .filter(n => !bound.includes(n))
        .map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    return `<div class="cpp-books">
        <label class="cl-cwin-label" for="cppBooks_${esc(p.id)}">Lorebooks</label>
        <div class="cpp-book-pills">${pills || '<span class="cpp-book-none">None bound</span>'}</div>
        <select id="cppBooks_${esc(p.id)}" class="cl-select-fluid cpp-book-add" data-id="${esc(p.id)}">
            <option value="">${_shelfFailed ? 'Could not load your lorebooks' : _shelf === null ? 'Reading the shelf' : options ? 'Add a lorebook' : 'No other lorebooks on the shelf'}</option>
            ${options}
        </select>
        ${_shelfFailed ? '<button type="button" class="cl-cwin-btn-text cpp-btn" data-cpp-act="shelf-retry"><i class="fa-solid fa-rotate-right"></i> Retry</button>' : ''}
        <p class="cl-cwin-hint">Active in any chat where this persona is in force, alongside the
            character's own books and the global list.</p>
    </div>`;
}

function editorHtml(p) {
    return `<div class="cpp-editor">
        ${p.id === 'new' ? '' : `<div class="settings-band is-warn cpp-band" data-cpp="band" role="status" hidden>
            <i class="fa-solid fa-arrows-rotate settings-band-icon"></i>
            <div class="settings-band-text">
                <span class="settings-band-when">Changed elsewhere</span>
                <span class="settings-band-sub">Another tab, device or the Assistant saved this persona. Reload it before saving over it.</span>
            </div>
            <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-cpp-act="reload-edit">Reload</button>
        </div>`}
        <label class="cl-cwin-label" for="cppName_${esc(p.id)}">Name</label>
        <input type="search" id="cppName_${esc(p.id)}" class="cl-cwin-input cpp-input" data-cpp-field="name"
            value="${esc(p.name)}" autocomplete="off" placeholder="What the character calls you">
        <label class="cl-cwin-label" for="cppDesc_${esc(p.id)}">Description</label>
        <textarea id="cppDesc_${esc(p.id)}" class="cl-cwin-input cl-cwin-textarea cpp-input" data-cpp-field="description"
            rows="4" placeholder="How the character should see you">\n${esc(p.description || '')}</textarea>
        <p class="cl-cwin-hint">The description reaches the model as the persona block; the name is what
            <code>{{user}}</code> resolves to, in the prompt and in every preview.</p>
        ${pronounsHtml(p)}
        ${p.id === 'new' ? '' : `<div class="cpp-avatar-row">
            ${faceHtml(p, BANNER_AVATAR, 'cpp-face is-big')}
            <div class="cpp-avatar-acts">
                <button type="button" class="cl-cwin-btn-text cpp-btn" data-cpp-act="pick-avatar" data-id="${esc(p.id)}">
                    <i class="fa-solid fa-image"></i> ${p.avatar ? 'Replace picture' : 'Add a picture'}
                </button>
                ${p.avatar ? `<button type="button" class="cl-cwin-btn-text cpp-btn" data-cpp-act="drop-avatar" data-id="${esc(p.id)}">Remove</button>` : ''}
            </div>
            <input type="file" accept="image/*" class="cpp-file" id="cppFile_${esc(p.id)}" hidden>
        </div>`}
        ${p.id === 'new' ? '' : bookRowHtml(p)}
        <div class="cpp-editor-acts">
            <button type="button" class="cl-cwin-btn-text cpp-btn" data-cpp-act="cancel-edit">Cancel</button>
            <button type="button" class="cl-cwin-btn-text is-primary cpp-btn" data-cpp-act="save" data-id="${esc(p.id)}">Save</button>
        </div>
    </div>`;
}

// an editor field by what it holds, so a redrawn editor finds it again
const editorFieldKey = (f) => (f.dataset.cppField ? `field:${f.dataset.cppField}` : `pronoun:${f.dataset.cppPronoun}`);
const editorFields = (ed) => [...ed.querySelectorAll('[data-cpp-field], [data-cpp-pronoun]')];
const editorState = (ed) => JSON.stringify(editorFields(ed).map(f => [editorFieldKey(f), f.value]));
// what an editor shows of a persona, so a move under it is told apart from one the editor cannot show
const editableOf = (p) => (p ? JSON.stringify([p.name, p.description || '', p.pronouns || {}]) : null);
const editorTouched = (ed) => editorState(ed) !== _editorOpened;

// before a redraw: the editor on screen, its typing only when touched (Settings > Chat's list keeps the same)
function keepEditor(content) {
    const ed = content.querySelector('.cpp-editor');
    if (!ed) return;
    const active = ed.contains(document.activeElement) && document.activeElement.matches('[data-cpp-field], [data-cpp-pronoun]') ? document.activeElement : null;
    _editorKept = {
        id: ed.querySelector('[data-cpp-act="save"]')?.dataset.id ?? null,
        typed: editorTouched(ed) ? Object.fromEntries(editorFields(ed).map(f => [editorFieldKey(f), f.value])) : null,
        fold: !!ed.querySelector('details.cpp-pronouns')?.hasAttribute('open'),
        focus: active ? { key: editorFieldKey(active), start: active.selectionStart, end: active.selectionEnd } : null,
    };
}

// after it: an untouched editor opens again on the fresh row, a touched one gets its typing back over it
function restoreEditor(content) {
    const ed = content.querySelector('.cpp-editor');
    const kept = _editorKept?.id === _editing ? _editorKept : null;
    _editorKept = null;
    if (!ed) return;
    _editorOpened = editorState(ed);
    // drawn from the row: the base is what it shows now; drawn over typing, the base stays what the typing started from
    const row = _list?.find(p => p.id === _editing) || null;
    if (!kept?.typed) { _editorBase = editableOf(row); _editorStale = false; }
    else if (editableOf(row) !== _editorBase) _editorStale = true;
    syncEditorBand(ed);
    if (!kept) return;
    if (kept.typed) {
        for (const f of editorFields(ed)) if (typeof kept.typed[editorFieldKey(f)] === 'string') f.value = kept.typed[editorFieldKey(f)];
        const form = ed.querySelector('[data-cpp-pronoun]');
        if (form) syncPronounPreset(form);
    }
    if (kept.fold) ed.querySelector('details.cpp-pronouns')?.setAttribute('open', '');
    const back = kept.focus && editorFields(ed).find(f => editorFieldKey(f) === kept.focus.key);
    if (back) {
        back.focus();
        try { back.setSelectionRange(kept.focus.start, kept.focus.end); } catch { /* a field with no caret */ }
    }
}

// the band says the persona moved under the typing; Save waits for a reload while it shows
function syncEditorBand(ed) {
    const band = ed?.querySelector('[data-cpp="band"]');
    if (band) band.hidden = !_editorStale;
}

/** @param {{keep?: boolean}} [opts] keep false draws the editor from the stored row, the reader's typing dropped (Reload) */
function render({ keep = true } = {}) {
    const content = document.getElementById('cppContent');
    if (!content) return;
    if (keep) keepEditor(content);
    else _editorKept = null;
    // no header meta: the in-force banner below names the persona and why

    if (_loading) {
        content.innerHTML = '<div class="cl-cwin-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><p>Reading personas</p></div>';
        return;
    }
    if (_error) {
        content.innerHTML = `<div class="cl-cwin-empty is-error"><i class="fa-solid fa-triangle-exclamation"></i>
            <p>Could not read personas.</p><p class="cl-cwin-dim">${esc(_error)}</p></div>`;
        return;
    }
    // Unread and empty are different answers and must not share a rendering.
    if (_list === null) { content.innerHTML = ''; return; }
    // a persona deleted elsewhere takes its editor with it, said when the reader had typed in it
    if (_editing && _editing !== 'new' && !_list.some(p => p.id === _editing)) {
        if (_editorKept?.typed) CoreAPI.showToast('This persona was deleted elsewhere', 'info');
        _editing = null;
    }

    content.innerHTML = `
        ${inForceHtml()}
        ${_list.length
        ? `<ul class="cpp-list">${_list.map(rowHtml).join('')}</ul>`
        : `<div class="cl-cwin-empty"><i class="fa-solid fa-masks-theater"></i>
             <p>No personas yet.</p><p class="cl-cwin-dim">A persona is your side of the chat: the name and
             description the character sees.</p></div>`}
        ${_editing === 'new' ? editorHtml({ id: 'new', name: '', description: '' }) : ''}
        <div class="cpp-foot">
            <button type="button" class="cl-cwin-btn-text cpp-btn" data-cpp-act="new"><i class="fa-solid fa-plus"></i> New Persona</button>
            <span class="cpp-foot-note">The globe applies everywhere. The speech bubble applies to this chat only.</span>
        </div>`;
    content.querySelectorAll('select').forEach(s => CoreAPI.initCustomSelect(s));
    restoreEditor(content);
}

// ========================================
// DATA
// ========================================

/**
 * Read the list and who is in force; an answer older than a later read is dropped.
 * @param {{quiet?: boolean}} [opts] quiet: a failed read keeps what is shown (a follow), rather than saying it failed
 * @returns {Promise<boolean>} whether this read's answer was taken
 */
async function readPersonas({ quiet = false } = {}) {
    const seq = ++_readSeq;
    try {
        const [listResp, resResp] = await Promise.all([
            CoreAPI.apiRequest('/personas', 'GET'),
            CoreAPI.apiRequest(`/personas/resolve${_chatId ? `?chatId=${encodeURIComponent(_chatId)}` : ''}`, 'GET'),
        ]);
        if (!listResp.ok) throw new Error(`server returned ${listResp.status}`);
        const [payload, resolved] = await Promise.all([listResp.json(), resResp.ok ? resResp.json() : null]);
        if (seq < _takenSeq) return false;
        _takenSeq = seq;
        const fresh = Array.isArray(payload) ? payload : (payload.personas || []);
        notePersonaRead(fresh);
        _list = fresh;
        _resolved = resolved;
        _error = null;
        return true;
    } catch (e) {
        if (seq < _takenSeq || quiet) return false;
        _takenSeq = seq;
        _error = e.message;
        _list = null;
        return true;
    }
}

async function load() {
    _loading = true;
    _error = null;
    render();
    await readPersonas();
    _loading = false;
    render();
}

/** Personas written elsewhere (another tab, the assistant's apply in this one): read again; an editor being typed in is never redrawn. */
async function patchPersonasFromFeed(records) {
    // what the window shows: a persona, the global one, this chat's own, and a persona's lorebooks
    const moves = (r) => movesChatPick(r, { entity: 'persona', setting: 'activePersonaId', chatId: _chatId, chatField: 'personaId' })
        || (r.entity === 'worldLink' && r.scope === 'persona');
    if (records && !records.some(moves)) return;
    // a picture moved elsewhere, the window open or not; a reconnect leaves the next read to tell
    followPersonaPictures(records);
    if (!panelOpen) return;
    // the save re-reads when it lands; read now, its own text would read as a change made elsewhere
    if (_saving) { _owedFollow = true; return; }
    await followRead();
}

/** The follow's read and draw: what moved is drawn, an editor being typed in is never redrawn and says when its persona moved. */
async function followRead() {
    const shown = JSON.stringify([_list, _resolved]);
    if (!(await readPersonas({ quiet: true })) || !panelOpen) return;
    // the window's own verbs echo back here after their own refresh: nothing moved, nothing to draw
    if (JSON.stringify([_list, _resolved]) === shown) return;
    const ed = document.getElementById('cppContent')?.querySelector('.cpp-editor');
    // a redraw under typing would break a phone keyboard's composition: the band says it, the list waits for the editor to close
    if (ed && editorTouched(ed)) {
        if (_editing === 'new') return;
        const row = _list.find(p => p.id === _editing);
        if (!row) { render(); return; }
        if (editableOf(row) !== _editorBase) { _editorStale = true; syncEditorBand(ed); }
        return;
    }
    render();
}

// every write re-reads the resolution; the global and the override interact, so never guess the outcome here
async function refresh() {
    await load();
    _onChange?.();
}

async function setGlobal(id) {
    if (!(await setActivePersona(id))) return;
    await refresh();
}

async function setChatOverride(id) {
    if (!_chatId) { CoreAPI.showToast('Open a chat first', 'info'); return; }
    const r = await personaRequest(`/chats/${encodeURIComponent(_chatId)}`, 'PATCH', { personaId: id });
    if (!r.ok) { CoreAPI.showToast('Could not set the persona for this chat', 'error'); return; }
    // an override move never reaches syncActivePersonaName, so announce it here with the persona the server resolves
    const chatId = _chatId;
    await refresh();
    const personaId = _chatId === chatId ? (_resolved?.persona?.id ?? null) : null;
    document.dispatchEvent(new CustomEvent('cl-persona-changed', { detail: { scope: 'chat', personaId, chatId } }));
}

// Server-side atomic apply: no list read on either verb, so a failed read can never
// become an empty overwrite of the persona's other books.
async function addPersonaBook(id, book) {
    const ok = await CoreAPI.applyPersonaWorlds(id, { add: [book] });
    if (!ok) { CoreAPI.showToast('Could not bind the lorebook', 'error'); return; }
    await refresh();
}

async function removePersonaBook(id, book) {
    const ok = await CoreAPI.applyPersonaWorlds(id, { remove: [book] });
    if (!ok) { CoreAPI.showToast('Could not unbind the lorebook', 'error'); return; }
    await refresh();
}

// the shelf (every world on disk), read once per panel session when an editor first opens; a failed read stays unread
async function loadShelf() {
    if (_shelf !== null) return;
    let files = null;
    try { files = await CoreAPI.listWorldInfoFiles(); } catch { files = null; }
    _shelfFailed = !Array.isArray(files);
    _shelf = _shelfFailed ? null : files.map(f => (typeof f === 'string' ? f : f?.name)).filter(Boolean).sort((a, b) => a.localeCompare(b));
    render();
}

// Reload: the editor drawn from the stored persona, the reader's typing and the band dropped
function reloadEditor() {
    _editorStale = false;
    render({ keep: false });
}

async function savePersona(id) {
    if (_editorStale && id === _editing) { CoreAPI.showToast('This persona changed elsewhere; reload it first', 'warning'); return; }
    const sheet = document.querySelector('.cpp-sheet');
    const name = sheet?.querySelector('[data-cpp-field="name"]')?.value?.trim() || '';
    const description = sheet?.querySelector('[data-cpp-field="description"]')?.value ?? '';
    _saving = true;
    _owedFollow = false;
    let saved;
    try { saved = await writePersona(id === 'new' ? null : id, { name, description, pronouns: readPronouns(sheet) }); } finally { _saving = false; }
    if (!saved) {
        // a write from elsewhere landed while this save was out: read it now, so the band can say so
        if (_owedFollow) { _owedFollow = false; await followRead(); }
        return;
    }
    _owedFollow = false;
    _editing = null;
    await refresh();
}

async function uploadAvatar(id, file) {
    const r = await personaRequest(`/personas/${encodeURIComponent(id)}/avatar`, 'PUT', file, {
        raw: true, headers: { 'Content-Type': file.type || 'application/octet-stream' },
    });
    if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        CoreAPI.showToast(err.error || 'Could not save that picture', 'error');
        return;
    }
    bumpPersonaFace(id);
    await refresh();
}

async function dropAvatar(id) {
    const r = await personaRequest(`/personas/${encodeURIComponent(id)}/avatar`, 'DELETE');
    if (!r.ok) { CoreAPI.showToast('Could not remove the picture', 'error'); return; }
    bumpPersonaFace(id);
    await refresh();
}

async function removePersona(id) {
    if (!(await deletePersona(_list?.find(x => x.id === id) || { id }))) return;
    if (_editing === id) _editing = null;
    await refresh();
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

    const sheet = document.querySelector('.cpp-sheet');
    mountChatWindow(sheet, { key: 'chatPersonasPanel', close: closePanel, min: { w: 22, h: 30 } });

    sheet?.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-cpp-act]');
        if (!btn) return;
        const id = btn.dataset.id;
        switch (btn.dataset.cppAct) {
            case 'close': return closePanel();
            case 'new': return newPersona();
            case 'edit': return editPersona(id);
            case 'cancel-edit': _editing = null; _editorStale = false; return render();
            case 'reload-edit': return reloadEditor();
            case 'pronoun-preset': return applyPronounPreset(btn);
            case 'save': return savePersona(id);
            case 'delete': return removePersona(id);
            case 'pick-avatar': return document.getElementById(`cppFile_${id}`)?.click();
            case 'drop-avatar': return dropAvatar(id);
            case 'book-remove': return removePersonaBook(id, btn.dataset.world);
            case 'shelf-retry': return loadShelf();
            case 'use-global': return setGlobal(id);
            case 'use-chat': return setChatOverride(id);
            case 'clear-override': return setChatOverride(null);
            default: return undefined;
        }
    });

    sheet?.addEventListener('change', async (e) => {
        if (e.target?.matches?.('.cpp-book-add')) {
            const book = e.target.value;
            const id = e.target.dataset.id;
            e.target.value = '';
            // A programmatic write never reaches the custom trigger on its own.
            e.target._customSelect?.update?.();
            if (book && id) await addPersonaBook(id, book);
            return;
        }
        if (!e.target?.matches?.('.cpp-file')) return;
        const file = e.target.files?.[0];
        const id = e.target.id.replace('cppFile_', '');
        e.target.value = '';
        if (file) await uploadAvatar(id, file);
    });

    sheet?.addEventListener('input', (e) => {
        if (e.target?.matches?.('[data-cpp-pronoun]')) syncPronounPreset(e.target);
    });

    registerChatWindow('chatPersonasPanel', { close: closePanel });
}

/** @param {{chatId: string, onChange?: Function}} ctx handed in by the conversation */
export function openPanel(ctx) {
    if (ctx && 'chatId' in ctx) _chatId = ctx.chatId;
    if (ctx && 'onChange' in ctx) _onChange = ctx.onChange;
    injectPanel();
    const panel = document.getElementById('chatPersonasPanel');
    if (!panel) return;
    openChatWindow(panel, { button: 'chatConvPersonas' });
    panelOpen = true;
    load();
}

// a touched editor asks before its typing goes; true when there is none or the reader lets it go
async function confirmDiscard() {
    const ed = document.getElementById('cppContent')?.querySelector('.cpp-editor');
    if (!ed || !editorTouched(ed)) return true;
    const name = _editing === 'new' ? null : _list?.find(p => p.id === _editing)?.name;
    return CoreAPI.confirmDiscardEdits(_editing === 'new' ? 'the new persona' : name ? `the persona ${name}` : 'this persona');
}

// a persona's editor, or none when its row is pressed again; a touched editor asks first
async function editPersona(id) {
    const was = _editing;
    if (!(await confirmDiscard())) return;
    // the window closed, or the editor moved, while it asked
    if (!panelOpen || _editing !== was) return;
    _editing = _editing === id ? null : id;
    _editorStale = false;
    if (_editing) void loadShelf();
    render({ keep: false });
}

async function newPersona() {
    const was = _editing;
    if (!(await confirmDiscard())) return;
    if (!panelOpen || _editing !== was) return;
    _editing = 'new';
    render({ keep: false });
}

// resolves whether it closed (a touched editor asks first); never rejects, exclusive mode calls it bare
export async function closePanel({ force = false } = {}) {
    if (panelOpen && !force && !(await confirmDiscard())) return false;
    if (!panelOpen) return true;
    const panel = document.getElementById('chatPersonasPanel');
    panelOpen = false;
    _editing = null;
    _editorStale = false;
    closeChatWindow(panel, { button: 'chatConvPersonas' });
    return true;
}

export function togglePanel(ctx) {
    if (panelOpen) closePanel();
    else openPanel(ctx);
}

function init() {
    // follow the chat, or the override lands on the one left; read the event, the announce beats the open finishing
    document.addEventListener('cl-chat-changed', (e) => {
        if (!e.detail?.chatId) { if (panelOpen) void closePanel({ force: true }); return; }
        if (e.detail.chatId === _chatId) return;
        _chatId = e.detail.chatId;
        if (panelOpen) load();
    });
    // both origins: the assistant's apply in this tab is as foreign to the editor as another tab's save
    registerFeedPatcher(['persona', 'setting', 'chat', 'worldLink'], patchPersonasFromFeed, { own: 'both' });
}

export default { init, openPanel, closePanel, togglePanel };
