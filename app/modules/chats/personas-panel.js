// Who you are, as a window inside the conversation: a global persona with a per-chat override.

import CoreAPI from '../core-api.js';
import { mountChatWindow, openChatWindow, closeChatWindow, registerChatWindow } from './window.js';
import { setActivePersona, writePersona, deletePersona, pronounsHtml, applyPronounPreset, syncPronounPreset, readPronouns } from '../personas.js';

const esc = (s) => CoreAPI.escapeHtml(s);

// built from the persona id, never the stored column, so nothing authored reaches an <img src>
const avatarUrl = (p, size) => (p?.avatar ? CoreAPI.thumbUrl('persona', p.id, size) : null);

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

// before a redraw: the editor on screen, its typing only when touched (Settings > Chat's list keeps the same)
function keepEditor(content) {
    const ed = content.querySelector('.cpp-editor');
    if (!ed) return;
    const active = ed.contains(document.activeElement) && document.activeElement.matches('[data-cpp-field], [data-cpp-pronoun]') ? document.activeElement : null;
    _editorKept = {
        id: ed.querySelector('[data-cpp-act="save"]')?.dataset.id ?? null,
        typed: editorState(ed) === _editorOpened ? null : Object.fromEntries(editorFields(ed).map(f => [editorFieldKey(f), f.value])),
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

function render() {
    const content = document.getElementById('cppContent');
    if (!content) return;
    keepEditor(content);
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
    // a persona deleted elsewhere takes its editor with it
    if (_editing && _editing !== 'new' && !_list.some(p => p.id === _editing)) _editing = null;

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

async function load() {
    _loading = true;
    _error = null;
    render();
    try {
        const [listResp, resResp] = await Promise.all([
            CoreAPI.apiRequest('/personas', 'GET'),
            CoreAPI.apiRequest(`/personas/resolve${_chatId ? `?chatId=${encodeURIComponent(_chatId)}` : ''}`, 'GET'),
        ]);
        if (!listResp.ok) throw new Error(`server returned ${listResp.status}`);
        const payload = await listResp.json();
        _list = Array.isArray(payload) ? payload : (payload.personas || []);
        _resolved = resResp.ok ? await resResp.json() : null;
    } catch (e) {
        _error = e.message;
        _list = null;
    }
    _loading = false;
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
    const r = await CoreAPI.apiRequest(`/chats/${encodeURIComponent(_chatId)}`, 'PATCH', { personaId: id });
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

async function savePersona(id) {
    const sheet = document.querySelector('.cpp-sheet');
    const name = sheet?.querySelector('[data-cpp-field="name"]')?.value?.trim() || '';
    const description = sheet?.querySelector('[data-cpp-field="description"]')?.value ?? '';
    if (!(await writePersona(id === 'new' ? null : id, { name, description, pronouns: readPronouns(sheet) }))) return;
    _editing = null;
    await refresh();
}

async function uploadAvatar(id, file) {
    const r = await CoreAPI.apiRequest(`/personas/${encodeURIComponent(id)}/avatar`, 'PUT', file, {
        raw: true, headers: { 'Content-Type': file.type || 'application/octet-stream' },
    });
    if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        CoreAPI.showToast(err.error || 'Could not save that picture', 'error');
        return;
    }
    await refresh();
}

async function dropAvatar(id) {
    const r = await CoreAPI.apiRequest(`/personas/${encodeURIComponent(id)}/avatar`, 'DELETE');
    if (!r.ok) { CoreAPI.showToast('Could not remove the picture', 'error'); return; }
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
            case 'new': _editing = 'new'; return render();
            case 'edit':
                _editing = _editing === id ? null : id;
                if (_editing) void loadShelf();
                return render();
            case 'cancel-edit': _editing = null; return render();
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

export function closePanel() {
    const panel = document.getElementById('chatPersonasPanel');
    panelOpen = false;
    _editing = null;
    closeChatWindow(panel, { button: 'chatConvPersonas' });
}

export function togglePanel(ctx) {
    if (panelOpen) closePanel();
    else openPanel(ctx);
}

function init() {
    // follow the chat, or the override lands on the one left; read the event, the announce beats the open finishing
    document.addEventListener('cl-chat-changed', (e) => {
        if (!e.detail?.chatId) { if (panelOpen) closePanel(); return; }
        if (e.detail.chatId === _chatId) return;
        _chatId = e.detail.chatId;
        if (panelOpen) load();
    });
}

export default { init, openPanel, closePanel, togglePanel };
