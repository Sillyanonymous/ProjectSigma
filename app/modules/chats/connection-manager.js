// Connection manager: the profiles that answer a chat; the editor is the shared connection editor, drilled into from a row.

import CoreAPI from '../core-api.js';
import { mountChatWindow, openChatWindow, closeChatWindow, registerChatWindow } from './window.js';
import { mountConnectionEditor, readinessOf } from '../connection-editor.js';
import { registerFeedPatcher, movesChatPick } from '../feed.js';

const esc = (s) => CoreAPI.escapeHtml(s);

let panelInjected = false;
let panelOpen = false;

let _profiles = [];
let _kinds = [];             // the /llm/kinds rows: { kind, displayName, requiresBaseUrl, ... }
let _chatId = null;         // the conversation's chat, followed off cl-chat-changed
let _resolved = null;       // { profile, source, override, defaultId } for that chat as the server answers it; null unread
let _editingId = null;      // profile open in the editor, or null
let _editor = null;         // the mounted editor, while one is open
let _loadError = null;      // an unknown list is never rendered as an empty one

// ========================================
// I/O
// ========================================

async function loadProfiles() {
    const [listResp, resResp] = await Promise.all([
        CoreAPI.apiRequest('/llm/profiles', 'GET'),
        CoreAPI.apiRequest(`/llm/profiles/resolve${_chatId ? `?chatId=${encodeURIComponent(_chatId)}` : ''}`, 'GET'),
    ]);
    if (!listResp.ok) throw new Error(`profile list failed (${listResp.status})`);
    _profiles = await listResp.json();
    if (!Array.isArray(_profiles)) _profiles = [];
    // which connection answers this chat, and why, is the server's answer, never derived here
    _resolved = resResp.ok ? await resResp.json() : null;
}

async function loadKinds() {
    try {
        const resp = await CoreAPI.apiRequest('/llm/kinds', 'GET');
        if (resp.ok) {
            const data = await resp.json();
            const list = Array.isArray(data) ? data : data?.kinds;
            if (Array.isArray(list) && list.length) _kinds = list.map(k => (typeof k === 'string' ? { kind: k } : k)).filter(k => k?.kind);
        }
    } catch { /* the default kind is enough to create a profile */ }
}

function activeProfile() {
    return _profiles.find(p => p.id === _resolved?.profile?.id) || null;
}

async function reread() {
    try {
        await loadProfiles();
        _loadError = null;
    } catch (e) {
        _loadError = e.message;
    }
    renderAll();
}

// every write re-reads the answer: the default and the chat's own interact, so the outcome is never guessed here
async function refreshChoice() {
    await reread();
    // the conversation re-reads the server's answer too; nothing is handed over, so there is no second copy to keep in step
    window.chatsModule?.syncConversationProfile?.();
}

// the globe: the connection every chat without its own answers on
async function setDefault(id) {
    if (!id) return false;
    CoreAPI.setSetting('chatProfileId', id);
    // the server resolves from the stored row, so the write lands before anything reads it
    const saved = await CoreAPI.flushSettings();
    await refreshChoice();
    return saved !== false;
}

// the speech bubble: this chat only; null follows the default again. Read again refused or not, so the list is the server's
async function setChatOwn(id) {
    if (!_chatId) { CoreAPI.showToast('Open a chat first', 'info'); return false; }
    let ok = true;
    try {
        await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/chats/${encodeURIComponent(_chatId)}`, 'PATCH', { profileId: id }));
    } catch (e) {
        ok = false;
        CoreAPI.showToast(`${id ? 'Could not set the connection for this chat' : 'Could not return this chat to the default connection'}: ${e.message}`, 'error');
    }
    await refreshChoice();
    return ok;
}

async function createProfile(body, toast) {
    let made;
    try {
        made = await CoreAPI.readAnswer(await CoreAPI.apiRequest('/llm/profiles', 'POST', body));
    } catch (e) {
        console.error('[ConnectionManager] Create failed:', e.message);
        CoreAPI.showToast(`Could not create the connection: ${e.message}`, 'error');
        return;
    }
    // put in use nowhere: the speech bubble or the globe picks it; a library's only connection answers every chat as the first
    await refreshChoice();
    openEditor(made.id);
    CoreAPI.showToast(_profiles.length > 1 ? `${toast}. The speech bubble puts it in use for this chat, the globe for every chat.` : toast, 'success');
}

// ========================================
// MARKUP
// ========================================

function buildPanelHTML() {
    return `
    <div id="chatConnPanel" class="cl-cwin ccm-panel" aria-hidden="true">
        <aside class="cl-cwin-sheet ccm-sheet" role="dialog" aria-label="Connection manager">
            ${CoreAPI.windowGripsHtml('the connection manager')}
            <div class="cl-cwin-header">
                <div class="cl-cwin-title">
                    <i class="fa-solid fa-plug"></i>
                    <span class="cl-cwin-name">Connections</span>
                </div>
                <button type="button" class="cl-cwin-btn is-close" id="ccmClose" title="Close" aria-label="Close connection manager">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div class="ccm-inforce" id="ccmInForce"></div>
            <div class="ccm-bar">
                <button type="button" class="cl-cwin-btn-text" data-conn-act="new"><i class="fa-solid fa-plus"></i> New Connection</button>
                <span class="ccm-bar-note">The globe sets the default for every chat. The speech bubble sets this chat only.</span>
            </div>
            <div class="ccm-list" id="ccmList"></div>
            <div class="ccm-editor" id="ccmEditor" hidden></div>
        </aside>
    </div>`;
}

const kindLabel = (kind) => _kinds.find(k => k.kind === kind)?.displayName || kind;

// One glyph per row: ready, or what is missing, from the same derivation the editor shows.
function stateGlyph(p) {
    const r = readinessOf({ baseUrl: p.baseUrl, model: p.model }, { kindMeta: _kinds.find(k => k.kind === p.kind) || null, hasKey: p.hasKey });
    const missing = [r.endpoint === 'missing' && 'endpoint', r.key === 'missing' && 'key', r.model === 'missing' && 'model'].filter(Boolean);
    if (!missing.length) return '<span class="ccm-state is-ready" title="Endpoint, key and model set"><i class="fa-solid fa-circle-check"></i></span>';
    return `<span class="ccm-state is-partial" title="No ${esc(missing.join(', no '))}"><i class="fa-solid fa-circle-exclamation"></i></span>`;
}

// The one line that answers "who answers this chat, and why"; the list's own empty and error states speak when there is no answer.
function inForceHtml() {
    if (_loadError || !_profiles.length) return '';
    const p = _resolved?.profile;
    if (!p) {
        return `<div class="cl-cwin-inforce is-none">
            <i class="fa-solid fa-circle-question"></i>
            <div><strong>Not read</strong><span>Which connection answers this chat could not be read.</span></div>
        </div>`;
    }
    const own = _resolved.source === 'chat';
    return `<div class="cl-cwin-inforce">
        <i class="fa-solid ${own ? 'fa-comment' : 'fa-globe'}"></i>
        <div><strong>${esc(p.name || 'Untitled')}</strong><span>${own ? 'set for this chat only' : 'the default, used by every chat without its own'}</span></div>
        ${own ? '<button type="button" class="cl-cwin-btn-text" data-conn-act="use-default" title="Follow the default connection again">Use Default</button>' : ''}
    </div>`;
}

function rowHTML(p) {
    const own = _resolved?.source === 'chat' && _resolved.override === p.id;
    const isDefault = _resolved?.defaultId === p.id;
    const inForce = _resolved?.profile?.id === p.id;
    const editing = p.id === _editingId;
    const meta = [kindLabel(p.kind), p.model || 'no model set'].filter(Boolean).join(' - ');
    return `<div class="cl-cwin-row ccm-row${inForce ? ' is-active' : ''}${editing ? ' is-editing' : ''}" data-id="${esc(p.id)}">
        <div class="ccm-main">
            <span class="ccm-name">${esc(p.name || 'Untitled')}</span>
            ${stateGlyph(p)}
            ${own ? '<span class="cl-cwin-tag is-accent">this chat</span>' : ''}
            ${isDefault ? '<span class="cl-cwin-tag">default</span>' : ''}
            <span class="ccm-meta">${esc(meta)}</span>
        </div>
        <div class="ccm-acts">
            <button type="button" class="ccm-act is-pick cl-cwin-act${own ? ' is-on' : ''}" data-conn-act="use-chat" data-id="${esc(p.id)}"
                title="${own ? 'Answering this chat only' : 'Answer this chat only with this connection'}" aria-label="Answer this chat only with this connection" aria-pressed="${own}">
                <i class="fa-solid fa-comment"></i>
            </button>
            <button type="button" class="ccm-act is-pick cl-cwin-act${isDefault ? ' is-on' : ''}" data-conn-act="use-default-for" data-id="${esc(p.id)}"
                title="${isDefault ? 'The default for every chat' : 'Make this the default for every chat'}" aria-label="Make this the default for every chat" aria-pressed="${isDefault}">
                <i class="fa-solid fa-globe"></i>
            </button>
            <button type="button" class="ccm-act cl-cwin-act" data-conn-act="edit" data-id="${esc(p.id)}" title="Edit" aria-label="Edit"><i class="fa-solid fa-pen"></i></button>
        </div>
    </div>`;
}

// ========================================
// RENDER
// ========================================

function renderAll() {
    const banner = document.getElementById('ccmInForce');
    if (banner) banner.innerHTML = inForceHtml();
    renderList();
}

function renderList() {
    const list = document.getElementById('ccmList');
    if (!list) return;
    if (_loadError) {
        list.innerHTML = `<div class="cl-cwin-empty is-error">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <p>The connections could not be loaded, so this list is unknown rather than empty.</p>
            <p class="cl-cwin-dim">${esc(_loadError)}</p>
        </div>`;
        return;
    }
    if (!_profiles.length) {
        list.innerHTML = `<div class="cl-cwin-empty">
            <i class="fa-solid fa-plug"></i>
            <p>No connection yet.</p>
            <p class="cl-cwin-dim">Add one and this chat has somewhere to send its prompt.</p>
        </div>`;
        return;
    }
    list.innerHTML = _profiles.map(rowHTML).join('');
}

// ========================================
// THE EDITOR
// ========================================

// the editor's save: the row and the answer that names it hold the saved connection, so the banner never shows an old name
function followSaved(saved) {
    const i = _profiles.findIndex(x => x.id === saved.id);
    if (i !== -1) _profiles[i] = saved;
    if (_resolved?.profile?.id === saved.id) _resolved = { ..._resolved, profile: saved };
}

// editing is a drill-down: a list and an editor stacked in one window is two half-screens and a dead gap
function openEditor(id) {
    const host = document.getElementById('ccmEditor');
    const p = _profiles.find(x => x.id === id);
    if (!host || !p) return;
    _editor?.destroy();
    _editingId = id;
    document.getElementById('chatConnPanel')?.classList.add('ccm-editing');
    host.hidden = false;
    _editor = mountConnectionEditor(host, {
        profile: p, kinds: _kinds, back: true,
        onSaved: followSaved,
        // the band's Reload: the editor opens again on the row as the server holds it now
        onReload: () => openEditor(id),
        onClosed: closeEditor,
        // a deleted connection hands its chats back to the default on the server; the answer is read again
        onDeleted: async () => {
            closeEditor();
            await refreshChoice();
        },
        onDuplicated: async (made) => {
            await loadProfiles();
            renderList();
            openEditor(made.id);
        },
    });
    renderList();
}

function closeEditor() {
    _editor = null;
    _editingId = null;
    const host = document.getElementById('ccmEditor');
    if (host) { host.hidden = true; host.innerHTML = ''; }
    document.getElementById('chatConnPanel')?.classList.remove('ccm-editing');
    renderAll();
}

// straight to the editor: its name field is where the name goes
async function newProfile() {
    await createProfile({ name: 'New connection', kind: _kinds[0]?.kind || 'openai' }, 'Connection created');
}

// ========================================
// PANEL LIFECYCLE
// ========================================

// Inside the conversation, like the prompt manager: Escape resolves the topmost overlay by
// DOM containment, so a nested panel closes before the conversation does.
function injectPanel() {
    if (panelInjected) return;
    const host = document.getElementById('chatsConversation');
    if (!host) return;
    panelInjected = true;
    host.insertAdjacentHTML('beforeend', buildPanelHTML());

    document.getElementById('ccmClose')?.addEventListener('click', closePanel);

    const sheet = document.querySelector('.ccm-sheet');
    mountChatWindow(sheet, {
        key: 'chatConnPanel',
        close: closePanel,
        min: { w: 18, h: 25 },
    });

    // One delegated listener for the panel's own verbs; the editor listens on its root.
    sheet?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-conn-act]');
        if (!btn) return;
        switch (btn.dataset.connAct) {
            case 'use-chat': return setChatOwn(btn.dataset.id);
            case 'use-default-for': return setDefault(btn.dataset.id);
            case 'use-default': return setChatOwn(null);
            case 'edit': return openEditor(btn.dataset.id);
            case 'new': return newProfile();
            default: return undefined;
        }
    });

    registerChatWindow('chatConnPanel', { close: closePanel });
}

async function openPanel() {
    injectPanel();
    const panel = document.getElementById('chatConnPanel');
    if (!panel) return;
    openChatWindow(panel, { button: 'chatConvConnections' });
    panelOpen = true;

    const list = document.getElementById('ccmList');
    if (list && !list.childElementCount) {
        list.innerHTML = '<div class="cl-cwin-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><p>Loading connections</p></div>';
    }
    try {
        await Promise.all([loadProfiles(), loadKinds()]);
        _loadError = null;
    } catch (e) {
        _loadError = e.message;
        console.error('[ConnectionManager] Load failed:', e.message);
    }
    renderAll();
    // an active connection that cannot send opens on its editor, the thing the chat's banner sends you here to finish
    const active = activeProfile();
    if (active && _kinds.length && !_editingId
        && !readinessOf({ baseUrl: active.baseUrl, model: active.model }, { kindMeta: _kinds.find(k => k.kind === active.kind) || null }).ready) openEditor(active.id);
}

function closePanel() {
    const panel = document.getElementById('chatConnPanel');
    panelOpen = false;
    closeChatWindow(panel, { button: 'chatConvConnections' });
}

function togglePanel() {
    if (panelOpen) closePanel();
    else openPanel();
}

// another tab's connection write, default pick (a setting naming chatProfileId) or this chat's own pick: an open panel re-reads
async function patchProfilesFromFeed(records) {
    const moves = (r) => movesChatPick(r, { entity: 'llmProfile', setting: 'chatProfileId', chatId: _chatId, chatField: 'profileId' });
    if (records && !records.some(moves)) return;
    if (!panelOpen) return;
    const editing = _editingId;
    try { await loadProfiles(); } catch (e) { console.error('[ConnectionManager] Re-read failed:', e.message); return; }
    renderAll();
    if (!editing || !_editor || (records && !records.some(r => (r.ids || []).includes(editing)))) return;
    const stored = _profiles.find(p => p.id === editing);
    // a draft of a connection that is gone has nothing to save to or reload from
    if (!stored) {
        await _editor.close({ force: true });
        CoreAPI.showToast('This connection was deleted elsewhere', 'info');
        return;
    }
    // only when the stored row moved: a reconnect names every row, and a needless band holds Save for a reload
    if (JSON.stringify(stored) === JSON.stringify(_editor.profile)) return;
    _editor.markChangedElsewhere();
}

function init() {
    document.getElementById('chatConvConnections')?.addEventListener('click', togglePanel);
    registerFeedPatcher(['llmProfile', 'setting', 'chat'], patchProfilesFromFeed);
    // follow the chat, or a pick lands on the one left; an open window reads the new chat's answer
    document.addEventListener('cl-chat-changed', (e) => {
        const chatId = e.detail?.chatId || null;
        if (chatId === _chatId) return;
        _chatId = chatId;
        if (!panelOpen) return;
        if (!chatId) { closePanel(); return; }
        void reread();
    });
}

export { openPanel, closePanel, togglePanel };
export default { init, openPanel, closePanel, togglePanel };
