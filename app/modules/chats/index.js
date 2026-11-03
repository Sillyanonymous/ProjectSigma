import * as CoreAPI from '../core-api.js';
// chat text is third-party (a card's first_mes, model output): previews go through the browse gate, never raw
import { BROWSE_PURIFY_CONFIG, CHAT_PURIFY_CONFIG } from '../providers/provider-utils.js';
import { STORED_TEXT } from './window.js';
// A sibling INSIDE this feature folder, not a cross-module reach: the conversation owns
// the panel's lifecycle and hands it the chat it should read.
import LorePanel from './lore-panel.js';
import PromptInspector from './prompt-inspector.js';
import GalleryPanel from './gallery-panel.js';
import SwipeCombiner from './swipe-combiner-panel.js';
import BackgroundPanel from './background-panel.js';
import SettingsPanel from './settings-panel.js';
import PersonasPanel from './personas-panel.js';
import CardTextsPanel from './card-texts-panel.js';
import Assistant from './assistant.js';
import ExtensionWindows from './extension-windows.js';
import { EXT_ACTION_EVENT, actionsFor as extActionsFor, hasActions as extHasActions, runAction as extRunAction, chatCardContext, getActions as extGetActions, actionShows as extActionShows } from '../extension-host.js';
import { hasHook, runFilter, runFilterAsync, runActions, watchHooks, fireEvent } from '../ext-registry.js';
import { registerFeedPatcher } from '../feed.js';
import Keymap from '../keymap.js';
import { createLivePainter, createLiveReveal, repaintLive, readerState, restoreReaderState, scrollPin, createPictureTray, picturesHtml, openPictures, wirePictureInputs, attachToChat, followPictureRemovals } from '../ai-panel.js';
import { readinessOf, seesPictures } from '../connection-editor.js';

// ========================================
// THE LIST IS THE SERVER'S
// ========================================
// The view holds the pages of ONE query: the search text, the advanced rules, the sort
// and the grouping compile to /chats params, the server filters, orders and windows, and
// the rows come back keyed by id for the click delegates. Nothing here mirrors the table
// and nothing persists in browser storage; a chat's name is display data, never a key.

// the ONE way a chat's name reaches the screen: the real stored name, no "Started <date>" fallback
function displayChatName(chat) {
    return String(chat?.name || '');
}

// ========================================
// MODULE STATE
// ========================================

let _chatRows = new Map();        // id -> server row, in the answer's order
let _chatsTotal = null;           // the first page's count; null until it answers
let _chatsCursor = null;          // the last page's nextCursor; null at the end
let _chatsQueryKey = '';          // the params the loaded pages answer
let currentGrouping = 'flat'; // 'flat' or 'grouped'
let currentChatSort = 'recent';
let _modalChatsChar = null;
// Last per-character chat list (with chatMetadata) so row actions can resolve the entry.
let _modalChatsList = [];

const PAGE_SIZE = 50;
// avatar URLs known-loaded this session, so re-renders skip the opacity fade
const _seenAvatarUrls = new Set();
let _sentinelObserver = null;

// the sort select as /chats params: the server's sort key plus the direction (oldest is recent ascending)
const CHAT_SORT_PARAMS = {
    recent: { sort: 'recent' },
    oldest: { sort: 'oldest' },
    char_asc: { sort: 'character', order: 'asc' },
    char_desc: { sort: 'character', order: 'desc' },
    most_messages: { sort: 'messages', order: 'desc' },
    least_messages: { sort: 'messages', order: 'asc' },
    most_chats: { sort: 'chats', order: 'desc' },
};

// the server's chats rule fields; a saved preset's unknown field is dropped from the query and named once
const CHAT_RULE_FIELDS = new Set(['chatName', 'charName', 'messageCount', 'messageText', 'lastMessage', 'chatLorebook', 'charFavorite', 'charTags', 'charProviderLink', 'charPlaylist']);
const _droppedRuleFields = new Set();

// the view state as /chats params: the shared search, the advanced rules, the sort, the grouping (paging per page)
function chatsQueryParams() {
    const params = new URLSearchParams();
    const q = (document.getElementById('searchInput')?.value || '').trim();
    if (q) params.set('q', q);
    const rules = [];
    for (const rule of CoreAPI.getAdvFilterRulesForChats() || []) {
        if (!CHAT_RULE_FIELDS.has(rule.field)) {
            if (!_droppedRuleFields.has(rule.field)) {
                _droppedRuleFields.add(rule.field);
                CoreAPI.showToast(`Chat filter "${rule.field}" is no longer available and was skipped`, 'warning');
            }
            continue;
        }
        rules.push({ field: rule.field, op: rule.operator, value: rule.value });
    }
    if (rules.length) params.set('rules', JSON.stringify(rules));
    for (const [k, v] of Object.entries(CHAT_SORT_PARAMS[currentChatSort] || CHAT_SORT_PARAMS.recent)) params.set(k, v);
    if (currentGrouping === 'grouped') params.set('grouped', 'true');
    return params;
}

// the loaded pages as data: reset replaces, append extends in place; cursor from the last page, total from the first
function mergeChatsPage(rows, total, data, { reset }) {
    const next = reset ? new Map() : new Map(rows);
    for (const row of data.items || []) next.set(row.id, row);
    return { rows: next, total: reset ? (data.total ?? null) : total, cursor: data.nextCursor ?? null };
}

// rows contiguous per character, in answer order; a page can begin inside the previous page's last group
function groupRows(rows) {
    const groups = [];
    for (const row of rows) {
        const last = groups[groups.length - 1];
        if (last && last.charId === row.charId) { last.rows.push(row); continue; }
        groups.push({ charId: row.charId, charName: row.charName || '', count: row.charChatCount ?? null, rows: [row] });
    }
    return groups;
}

// the ONE place chats leave or rename in this module's view; separate halves came back as ghost cards
function forgetChatsLocally(chatIds) {
    for (const id of chatIds) {
        if (_chatRows.delete(id) && _chatsTotal !== null) _chatsTotal = Math.max(0, _chatsTotal - 1);
    }
    // the conversation can be parked behind another view, so a delete from any surface takes the open pane too
    if (_convChatId && chatIds.includes(_convChatId)) closeConversation();
    else repaintChatListIfVisible();
}

// a character's chats cascade server-side with no chat record: drop its rows, close its conversation, re-ask a shown list
function onCharactersDeleted(charIds, { elsewhere = false } = {}) {
    const gone = new Set(charIds);
    const convCharId = _convChar?.id || _chatRows.get(_convChatId)?.charId;
    const chatIds = [..._chatRows.values()].filter(r => gone.has(r.charId)).map(r => r.id);
    if (_convChatId && gone.has(convCharId) && !chatIds.includes(_convChatId)) chatIds.push(_convChatId);
    if (elsewhere && _convChatId && chatIds.includes(_convChatId)) CoreAPI.showToast('This chat\'s character was deleted elsewhere', 'info');
    if (chatIds.length) forgetChatsLocally(chatIds);
    if (CoreAPI.getCurrentView() === 'chats' && !isConversationOpen()) void loadAllChats(true);
}

function renameChatLocally(chatId, name) {
    const entry = _chatRows.get(chatId);
    if (entry) entry.name = name;
    repaintChatListIfVisible();
}

// only the chats view shows the list, and closeConversation rebuilds it anyway; hidden repaints are wasted
function repaintChatListIfVisible() {
    if (CoreAPI.getCurrentView() !== 'chats' || isConversationOpen()) return;
    renderChats();
}

/**
 * Delete one chat from any surface: one confirm, the write, the forget, a refusal in the server's words.
 * @param {{id: string, name?: string}} chat
 * @param {{after?: Function}} [opts] after: the surface's own step once the chat is gone
 * @returns {Promise<boolean>} whether it was deleted
 */
async function deleteChatVerb(chat, { after } = {}) {
    if (!chat?.id) return false;
    const ok = await CoreAPI.showConfirm({
        title: 'Delete this chat?',
        message: 'Every message in it goes with it. The character is untouched.',
        confirmLabel: 'Delete',
        danger: true,
        content: [{ type: 'note', text: displayChatName(chat) }],
    });
    if (!ok) return false;
    try {
        await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/chats/${encodeURIComponent(chat.id)}`, 'DELETE'));
    } catch (e) {
        CoreAPI.showToast(`Not deleted: ${e.message}`, 'error', 8000);
        return false;
    }
    forgetChatsLocally([chat.id]);
    CoreAPI.showToast('Chat deleted', 'success');
    await after?.();
    return true;
}

// ========================================
// CHANGE FEED
// ========================================
// Another tab's, device's or process's writes to chats and messages, patched into the list,
// the modal's Chats tab and the open conversation. This tab's own writes never arrive: it
// applied them already.

// a transcript written elsewhere waits while a stream or an open editor holds the rows; their end runs the re-read
let _convStaleWhileBusy = false;
// a reply's end owed behind an open editor: paid at its close, the reply this tab asked for still comes first
let _convOwedBehindOwn = false;

function convEditorOpen() {
    return !!convEls().list?.querySelector('.chat-conv-edit');
}

// the owed rebuild is paid once no stream runs and no editor is open (closing one of two wiped the other)
function convPayOwedRebuild({ behindOwn = false } = {}) {
    if (_convStaleWhileBusy && behindOwn) _convOwedBehindOwn = true;
    if (_convStaleWhileBusy && !_convAbort && !convEditorOpen() && isConversationOpen()) {
        _convStaleWhileBusy = false;
        const own = _convOwedBehindOwn;
        _convOwedBehindOwn = false;
        // turns another tab wrote meanwhile open at the first of them, as the feed opens them; behind this tab's own, below it
        void convRereadNewTurns({ behindOwn: own });
    }
}

// a verb's own re-read waits for an open editor too: rebuilt now, a renumbered row takes the typing with it
async function convRereadOrOwe() {
    if (convEditorOpen()) { _convStaleWhileBusy = true; return; }
    await convReloadMessages();
}

// the chat stopped with no done frame, until the next generation: a late hang-up's reply lands as this tab's own write
let _convStopEcho = null;

/** This tab's own message records: after a stop with no done frame, that chat's transcript is read again. */
async function patchConvOwnEcho(records) {
    if (!records || !_convStopEcho || _convStopEcho !== _convChatId || !isConversationOpen()) return;
    if (!records.some(r => r.chatId === _convStopEcho)) return;
    if (_convAbort || convEditorOpen()) _convStaleWhileBusy = true;
    else await convReloadMessages();
}

function modalChatsTabShowing() {
    return !!_modalChatsChar
        && document.getElementById('pane-chats')?.classList.contains('active')
        && !document.getElementById('charModal')?.classList.contains('hidden');
}

// The field of a character each character rule of the chats query reads (the server's chats rule
// table; a provider link is any extensions.<provider> field)
const CHAR_RULE_READS = Object.freeze({ charTags: 'tags', charFavorite: 'fav', charPlaylist: 'playlists', charProviderLink: 'extensions.' });

// the rule fields of the query the loaded pages answer
function loadedRuleFields() {
    try {
        return new Set(JSON.parse(new URLSearchParams(_chatsQueryKey).get('rules') || '[]').map(r => r.field));
    } catch {
        return new Set();
    }
}

// a character write moves a loaded row through its name, picture or a field a query rule reads; no fields counts
function charFieldsMoveRows(fields, rules) {
    if (!Array.isArray(fields)) return true;
    const reads = ['name', 'avatar', ...[...rules].map(f => CHAR_RULE_READS[f]).filter(Boolean)];
    return fields.some(f => reads.some(k => (k.endsWith('.') ? f.startsWith(k) : f === k)));
}

/**
 * @param {Array<object>|null} records chat, message, character, worldLink and world records, or
 *   null to re-read everything on screen (a reconnect)
 */
async function patchChatsFromFeed(records) {
    const everything = !records;
    const touched = new Set();      // chats whose row or messages changed
    const touchedChars = new Set(); // characters that gained or lost a chat
    const rowFields = new Set();    // the open chat's own fields that changed
    let transcript = everything && isConversationOpen();
    // a loaded row's character renamed, repictured or changed for a rule: no chat record says so, so the list re-asks
    let charsMoved = false;
    let loadedChars = null;
    const rules = loadedRuleFields();
    // a draft typed elsewhere: its row is read again by its character, never the counted first page
    const draftOnly = new Set();
    // chats deleted elsewhere, forgotten in one pass, since every forget repaints the list
    const gone = [];
    // chats whose lorebooks changed elsewhere: their own list, or a book they carry renamed,
    // unbound everywhere or deleted (no chat record says so)
    const worldsMoved = new Set();
    let booksMoved = false;
    for (const r of records || []) {
        // an extension's report names only its own fields, which no chat surface here shows
        if (r.extension) continue;
        if (r.entity === 'character') {
            if (r.op === 'updated' && _chatRows.size && charFieldsMoveRows(r.fields, rules)) {
                loadedChars ??= new Set([..._chatRows.values()].map(row => String(row.charId)));
                if (r.all || (r.ids || []).some(id => loadedChars.has(String(id)))) charsMoved = true;
            }
            continue;
        }
        if (r.entity === 'worldLink' || r.entity === 'world') {
            if (r.entity === 'worldLink' && r.scope === 'chat') {
                for (const id of r.ids || []) worldsMoved.add(id);
                booksMoved = true;
                continue;
            }
            const book = r.entity === 'world' ? ((r.to || r.op === 'deleted') ? r.ids?.[0] : null) : (r.all ? r.world : null);
            if (!book) continue;
            booksMoved = true;
            for (const row of [..._chatRows.values(), ..._modalChatsList]) if (getChatWorlds(row).includes(book)) worldsMoved.add(row.id);
            continue;
        }
        if (r.entity === 'message') {
            touched.add(r.chatId);
            if (r.chatId === _convChatId) transcript = true;
            continue;
        }
        // which connection or preset a chat uses is on no list row, only on the open chat
        if (r.op === 'updated' && r.fields?.length && r.fields.every(f => f === 'profileId' || f === 'presetId')) {
            if ((r.ids || []).includes(_convChatId)) r.fields.forEach(f => rowFields.add(f));
            continue;
        }
        const draftAlone = r.op === 'updated' && (r.fields || []).length === 1 && r.fields[0] === 'draft';
        if (r.charId && !draftAlone) touchedChars.add(r.charId);
        for (const id of r.ids || []) {
            // a draft shows on its loaded row alone: never on the modal's tab, and the open chat's
            // is this tab's own typing
            if (draftAlone) { if (id !== _convChatId && _chatRows.has(id)) draftOnly.add(id); continue; }
            touched.add(id);
            if (r.op === 'deleted') {
                if (id === _convChatId) CoreAPI.showToast('This chat was deleted elsewhere', 'info');
                gone.push(id);
            } else if (id === _convChatId && r.op === 'updated') {
                (r.fields || []).forEach(f => rowFields.add(f));
            }
        }
    }
    // before any re-read, so a deleted open chat is closed first
    if (gone.length) forgetChatsLocally(gone);
    // a reconnect follows the open chat's own row too (its persona is the subject patcher's)
    if (everything && isConversationOpen()) { rowFields.add('name'); rowFields.add('chatMetadata'); }
    // awaited: the feed announces the records once its patchers are done, so a listener that
    // reads the conversation finds it current
    if (transcript && isConversationOpen()) {
        if (_convAbort || convEditorOpen()) _convStaleWhileBusy = true;
        else await convRereadNewTurns();
    }
    // the re-read closes a chat it finds deleted
    if (rowFields.size && isConversationOpen()) await convFollowChatRow(rowFields);
    // the list re-asks in the background, keeping its pages and the reader's scroll; off the
    // view, the next entry re-reads anyway
    const listShowing = CoreAPI.getCurrentView() === 'chats' && !isConversationOpen();
    const reread = new Set([...draftOnly, ...worldsMoved].filter(id => _chatRows.has(id)));
    if ((everything || touched.size || charsMoved || (booksMoved && rules.has('chatLorebook'))) && _chatRows.size && listShowing) await loadAllChats(true);
    else if (reread.size && listShowing) await convRereadRowsOf(reread);
    if (modalChatsTabShowing() && (everything || touchedChars.has(_modalChatsChar.id) || _modalChatsList.some(c => touched.has(c.id) || worldsMoved.has(c.id)))) {
        await fetchCharacterChats(_modalChatsChar, { background: true });
    }
}

// turns another tab wrote open at the first of them, as a finished reply does; a turn changed in place follows the end
async function convRereadNewTurns({ behindOwn = false } = {}) {
    const chatId = _convChatId;
    const shown = _convMessages;
    // where this tab's reply stands in the view as the re-read paints, after any landing of its own: held there through a turn read above
    const mine = shown[shown.length - 1];
    let stood = null;
    await convReloadMessages({ beforeRender: () => {
        const { list } = convEls();
        const row = mine && list ? convRowEl(mine.seq) : null;
        stood = row ? row.offsetTop - list.scrollTop : null;
    } });
    // a chat opened while it read is another transcript, whose rows past this one's last seq are not new
    if (_convChatId !== chatId) return;
    // the rows not shown before, by id (a delete elsewhere renumbers the seqs); a whole rewrite renews every id, so then by seq
    const ids = new Set(shown.map(m => m.id));
    const first = _convMessages.some(m => m.id != null && ids.has(m.id))
        ? _convMessages.find(m => !ids.has(m.id))
        : _convMessages.find(m => m.seq > (shown[shown.length - 1]?.seq ?? -1));
    if (!first) return;
    // this tab's own reply comes first (landing, parked, or as its stream ended): turns below it are news, above it the end stays
    if (behindOwn || _convLandRaf || _convLandOnResume?.chatId === chatId) {
        // a sent reply is stored after the turns written meanwhile, so they sit above it
        if (!ids.has(_convMessages[_convMessages.length - 1].id)) {
            const now = stood === null ? null : _convMessages.find(m => m.id === mine.id);
            const row = now ? convRowEl(now.seq) : null;
            convNewsBelow(row ? row.offsetTop - stood : null);
        }
        return;
    }
    convLandReplyStart(first.seq);
}

// turns another tab wrote below the reply this tab lands: told by the pill, a follower held where they read (`top`, or here)
function convNewsBelow(top = null) {
    _convMissedWhileAway = true;
    const { list } = convEls();
    // a landing still to run places the reader itself; all of it in view, nothing is missed
    if (_convLandRaf || _convSuspended || !list || !_convPin.pinned()) { convSyncJumpPill(); return; }
    const at = top ?? list.scrollTop;
    if (convRestFits(list, at)) { _convMissedWhileAway = false; return; }
    convLandAt(list, at);
}

// these chats' loaded rows read again through their characters' lists, then repainted
async function convRereadRowsOf(chatIds) {
    const charIds = new Set([...chatIds].map(id => _chatRows.get(id)?.charId).filter(Boolean));
    for (const charId of charIds) {
        try {
            for (const row of await CoreAPI.fetchAllPages('/chats', { charId, count: 'false' })) if (_chatRows.has(row.id)) _chatRows.set(row.id, row);
        } catch { /* the row keeps its text until the next read */ }
    }
    repaintChatListIfVisible();
}

// the open chat's row changed elsewhere: name to the header, persona over your turns, metadata to the card mark; never the draft
async function convFollowChatRow(fields) {
    const chatId = _convChatId;
    if (fields.has('name')) {
        try {
            const resp = await CoreAPI.apiRequest(`/chats/${encodeURIComponent(chatId)}?msgTail=1`, 'GET');
            const row = resp.ok ? await resp.json() : null;
            const sub = document.getElementById('chatConvSub');
            if (row && _convChatId === chatId && sub) {
                sub.textContent = displayChatName(row);
                sub.dataset.rawName = row.name || '';
            }
        } catch { /* the header keeps its name until the next open */ }
    }
    if (fields.has('personaId')) {
        const was = _convPersonaId;
        await convFollowPersona();
        // the override decides whose books are in force here; a global switch announces itself
        if (_convChatId === chatId && _convPersonaId !== was) {
            document.dispatchEvent(new CustomEvent('cl-persona-changed', { detail: { scope: 'chat', source: 'feed', personaId: _convPersonaId, chatId } }));
        }
    }
    if (fields.has('chatMetadata')) await convFollowChatMeta();
    if (fields.has('profileId')) await syncConvProfiles();
    if (fields.has('presetId')) await convSyncPreset();
}

// the persona is baked into every row: rebuild only when the name, picture or pronouns moved, and never under an open editor
async function convFollowPersona() {
    const chatId = _convChatId;
    const shownOf = () => `${_convPersonaName}\u0000${_convPersonaAvatarId}\u0000${JSON.stringify(_convPersonaPronouns)}`;
    const was = shownOf();
    await convSyncPersonaName();
    if (_convChatId !== chatId || !_convMessages.length || shownOf() === was) return;
    convRebuildRows();
}

// a persona, connection or preset written elsewhere (null on a reconnect) re-resolves the open conversation's; a delete may free this chat's own
async function patchConvSubjectFromFeed(records) {
    if (!isConversationOpen()) return;
    if (!records || records.some(r => r.entity === 'persona')) await convFollowPersona();
    if (!records || records.some(r => r.entity === 'llmProfile')) await syncConvProfiles();
    if (!records || records.some(r => r.entity === 'preset')) await convSyncPreset();
}

// settings another tab changed, after the shell's re-read, and only what moved since applied
async function patchConvSettingsFromFeed(records) {
    if (!isConversationOpen()) return;
    const all = !records || records.some(r => r.all);
    const keys = new Set(all ? [] : records.flatMap(r => r.ids || []));
    // an extension's setting written elsewhere may be what a composer verb's when() decides on
    const extMoved = all || [...keys].some(k => k.startsWith('ext:'));
    if (extHasActions('composer') && extMoved) convRenderComposerActions();
    // a reconnect's persona follow is the subject patcher's; a wholesale write can move it too
    if (records && (all || keys.has('activePersonaId'))) await convFollowPersona();
    // the defaults: a chat following one answers on another now, a chat holding its own reads the same answer again
    if (all || keys.has('chatProfileId')) await syncConvProfiles();
    if (all || keys.has('activePresetId')) await convSyncPreset();
    const moved = CONV_SETTING_KEYS.filter(k => (all || keys.has(k)) && _convApplied.get(k) !== convSettingValue(k));
    if (moved.length) convApplySettingKeys(moved);
    // an options menu thats open here redraws its switches' ticks
    if (all || convDisplayToggles().some(t => keys.has(t.key))) convRefreshOptionStates(document);
}

// ========================================
// CHARACTER MODAL - CHATS TAB
// ========================================

/**
 * @param {object} char
 * @param {{background?: boolean}} [opts] background: a re-read of the rows on screen, which keep
 *   their place until the answer lands instead of a loading state
 */
async function fetchCharacterChats(char, { background = false } = {}) {
    const sameRows = background && _modalChatsChar?.id === char.id;
    _modalChatsChar = char;
    const chatsList = document.getElementById('chatsList');
    if (!chatsList) return;

    if (!sameRows || !chatsList.querySelector('.chat-item')) CoreAPI.renderLoadingState(chatsList, 'Loading chats...', 'chats-loading');

    try {
        // the server's list rows, newest first, every page of them
        const rows = await CoreAPI.fetchAllPages('/chats', { charId: char.id, count: 'false' });
        // the modal pages between characters: a slow answer for the previous one must not land in this tab
        if (_modalChatsChar?.id !== char.id) return;
        const chats = rows.map(r => ({ ...r, character: char }));

        if (!chats.length) {
            CoreAPI.renderEmptyState(chatsList, {
                icon: 'fa-solid fa-comments',
                title: 'No chats yet',
                hint: `Start your first conversation with ${char.name || 'this character'}.`,
                actionLabel: 'Start a chat',
                actionIcon: 'fa-solid fa-comment-dots',
                onAction: () => createNewChat(char),
            });
            return;
        }

        // Kept (with chatMetadata) so row actions can resolve the entry by id.
        _modalChatsList = chats;

        chatsList.innerHTML = chats.map(chat => {
            const lastDate = chat.lastMesAt ? new Date(chat.lastMesAt).toLocaleDateString() : 'Unknown';
            const messageCount = chat.messageCount ?? '?';
            const chatName = displayChatName(chat);
            const boundWorlds = getChatWorlds(chat);
            const lorePill = boundWorlds.length
                ? `<span class="chat-lore-pill" title="Lorebooks bound to this chat: ${CoreAPI.escapeHtml(boundWorlds.join(', '))}"><i class="fa-solid fa-book-atlas"></i> ${CoreAPI.escapeHtml(boundWorlds[0])}${boundWorlds.length > 1 ? ` +${boundWorlds.length - 1}` : ''}</span>`
                : '';

            return `
                <div class="chat-item" data-chat-id="${CoreAPI.escapeHtml(chat.id)}" data-last-mes="${chat.lastMesAt ?? ''}">
                    <div class="chat-item-icon">
                        <i class="fa-solid fa-message"></i>
                    </div>
                    <div class="chat-item-info">
                        <div class="chat-item-name">${CoreAPI.escapeHtml(chatName)}</div>
                        <div class="chat-item-meta">
                            <span><i class="fa-solid fa-calendar"></i> ${lastDate}</span>
                            <span><i class="fa-solid fa-comment"></i> ${messageCount} messages</span>
                            ${lorePill}
                        </div>
                    </div>
                    <button class="chat-item-kebab" aria-label="Chat actions" title="Actions"><i class="fa-solid fa-ellipsis-vertical"></i></button>
                    <div class="chat-item-actions">
                        <button class="chat-action-btn" title="${boundWorlds.length ? 'Change bound lorebooks' : 'Bind a lorebook to this chat'}" data-action="lore"><i class="fa-solid fa-book-atlas"></i></button>
                        <button class="chat-action-btn" title="Open chat" data-action="open"><i class="fa-solid fa-arrow-right"></i></button>
                        <button class="chat-action-btn danger" title="Delete chat" data-action="delete"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            `;
        }).join('');

    } catch (e) {
        if (_modalChatsChar?.id !== char.id) return;
        chatsList.innerHTML = `<div class="no-chats"><i class="fa-solid fa-exclamation-triangle"></i><p>Failed to load chats: ${CoreAPI.escapeHtml(e.message)}</p></div>`;
    }
}

// opening a chat from the character modal takes you TO it, the conversation over the modal
async function openChat(char, chatId) {
    const entry = _modalChatsList?.find(c => c.id === chatId);
    if (!entry) return;
    if (!entry.character) entry.character = char;
    openChatFor(entry);
}

async function deleteChat(char, chatId) {
    const entry = _modalChatsList?.find(c => c.id === chatId);
    if (!entry) {
        CoreAPI.showToast("Chat not found", "error");
        return;
    }
    await deleteChatVerb(entry, { after: () => fetchCharacterChats(char, { background: true }) });
}

// the server names the chat and seeds the greeting, so a bare start sends no body; a name collision is 409
async function createNewChat(char) {
    const target = char || _modalChatsChar;
    if (!target?.id) return;
    try {
        const detail = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/characters/${encodeURIComponent(target.id)}/chats`, 'POST', {}));
        enterChatsForConversation();
        // the detail is a list row plus its messages; the conversation reads the row fields
        const opened = openConversation({ ...detail, charId: target.id, charName: target.name, character: target });
        // after openConversation's synchronous prologue: the chat is marked open, so this freshen never paints the grid
        void loadAllChats(true);
        await opened;
    } catch (e) {
        CoreAPI.showToast(`Could not start a chat: ${e.message}`, 'error');
    }
}

/** Go to the chats view knowing a conversation opens on top: claim cl-chat-open before the switch (openConversation releases it if nothing opens). */
function enterChatsForConversation() {
    CoreAPI.hideModal('charModal');
    document.documentElement.classList.add('cl-chat-open');
    if (CoreAPI.getCurrentView() !== 'chats') CoreAPI.switchView('chats');
}

async function openConversationForCharacter(char) {
    if (!char?.id) return false;
    let existing;
    try {
        existing = await listCharacterChatsWithMeta(char);
    } catch (e) {
        // unknown is not none: a lookup that failed starts no chat, or each failed read minted another
        CoreAPI.showToast(`Could not read this character's chats: ${e.message}`, 'error');
        return false;
    }
    const target = existing[0] || null;
    if (!target) {
        await createNewChat(char);
        return true;
    }
    enterChatsForConversation();
    const opened = openConversation({ ...target, character: target.character || char });
    // behind the pane, as in createNewChat: a fresh grid to come back to, never painted before the conversation covers it
    void loadAllChats(true);
    await opened;
    return true;
}

// ========================================
// TOP-LEVEL CHATS VIEW
// ========================================

// the setting keeps its key: 'cards' is the classic card, anything else (old density values too) is the list
function chatLayout() {
    return CoreAPI.getSetting('chatCardDensity') === 'cards' ? 'cards' : 'list';
}

// Read on view enter rather than module init so the settings load cant race us.
function syncChatLayout() {
    const layout = chatLayout();
    const view = document.getElementById('chatsView');
    if (view) view.classList.toggle('chat-layout-cards', layout === 'cards');
    document.querySelectorAll('.chat-layout-btn').forEach(b => b.classList.toggle('active', b.dataset.layout === layout));
    // Layout only shapes the recency lens; the character lens is rows by design.
    document.getElementById('chatLayoutToggle')?.classList.toggle('hidden', currentGrouping === 'grouped');
}

// The sort and the lens start a session from their controls, which the shell sets to the view's defaults.
let _viewDefaultsSeeded = false;

function seedFromControls() {
    _viewDefaultsSeeded = true;
    currentChatSort = document.getElementById('chatsSortSelect')?.value || currentChatSort;
    currentGrouping = document.querySelector('.grouping-btn.active')?.dataset.group || currentGrouping;
    syncChatLayout();
}

function resetViewDefaults() {
    seedFromControls();
    if (CoreAPI.getCurrentView() === 'chats' && !isConversationOpen()) void loadAllChats();
}

function initChatsView() {
    // capture-phase load delegate fills the seen-Set by raw src, independent of promote's per-img listener timing (races on mobile)
    const chatsView = document.getElementById('chatsView');
    if (chatsView) {
        chatsView.addEventListener('load', (e) => {
            const img = e.target;
            if (!img || img.tagName !== 'IMG') return;
            if (img.closest('.chat-avatar-wrap')) {
                const key = img.getAttribute('src');
                if (key) _seenAvatarUrls.add(key);
            }
        }, true);
    }

    CoreAPI.onViewEnter('chats', () => {
        if (!_viewDefaultsSeeded) seedFromControls();
        syncChatLayout();
        // A parked conversation RESUMES on re-entry (owner-specified); renderChats' conversation
        // guard is what keeps the grid from ever painting under the pane here.
        if (isConversationOpen()) { resumeConversation(); return; }
        void loadAllChats();
    });
    // the lazy import misses the first entry's enter callbacks, so catch up here, the lost load kick included
    if (CoreAPI.getCurrentView() === 'chats') {
        if (!_viewDefaultsSeeded) seedFromControls();
        syncChatLayout();
        if (!_chatRows.size) void loadAllChats();
    }

    CoreAPI.onViewExit('chats', () => {
        disconnectObservers();
    });

    // every control below is a QUERY change: the server answers the new order or shape
    CoreAPI.onElement('chatsSortSelect', 'change', (e) => {
        currentChatSort = e.target.value;
        void loadAllChats();
    });

    document.querySelectorAll('.chat-layout-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            CoreAPI.setSetting('chatCardDensity', btn.dataset.layout);
            syncChatLayout();
            // the two layouts are different markup, not a class over one tree
            renderChats();
        });
    });

    document.querySelectorAll('.grouping-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.grouping-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentGrouping = btn.dataset.group;
            syncChatLayout();
            void loadAllChats();
        });
    });

    CoreAPI.onElement('refreshChatsViewBtn', 'click', () => {
        void loadAllChats(true);
    });

    initConversation();

    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', CoreAPI.debounce(() => {
            if (CoreAPI.getCurrentView() === 'chats' && !isConversationOpen()) {
                void loadAllChats();
            }
        }, 150));
    }

    const chatsList = document.getElementById('chatsList');
    if (chatsList) {
        chatsList.addEventListener('click', (e) => {
            const item = e.target.closest('.chat-item');
            if (!item || !_modalChatsChar) return;
            const chatId = item.dataset.chatId;

            const kebab = e.target.closest('.chat-item-kebab');
            if (kebab) {
                e.stopPropagation();
                const willOpen = !item.classList.contains('menu-open');
                chatsList.querySelectorAll('.chat-item.menu-open').forEach(i => { if (i !== item) i.classList.remove('menu-open'); });
                item.classList.toggle('menu-open', willOpen);
                return;
            }

            const actionBtn = e.target.closest('.chat-action-btn');
            if (actionBtn) {
                e.stopPropagation();
                item.classList.remove('menu-open');
                const action = actionBtn.dataset.action;
                if (action === 'open') openChat(_modalChatsChar, chatId);
                else if (action === 'delete') deleteChat(_modalChatsChar, chatId);
                else if (action === 'lore') {
                    const entry = _modalChatsList.find(c => c.id === chatId);
                    if (entry) openChatLorePicker(_modalChatsChar, entry);
                }
                return;
            }

            openChat(_modalChatsChar, chatId);
        });
    }

    const chatsGrid = document.getElementById('chatsGrid');
    if (chatsGrid) {
        chatsGrid.addEventListener('click', (e) => {
            if (e.target.closest('.chats-retry')) { void loadAllChats(true); return; }
            const card = e.target.closest('.chat-card, .chat-hero');
            if (!card) return;
            const chat = findChatByElement(card);
            if (!chat) return;

            const charNameEl = e.target.closest('.clickable-char-name');
            if (charNameEl) {
                e.stopPropagation();
                openCharacterDetailsFromChats(chat.charId);
                return;
            }

            const actionBtn = e.target.closest('.chat-card-action, .chat-card-kebab');
            if (actionBtn) {
                e.stopPropagation();
                if (actionBtn.dataset.action === 'delete') deleteChatFromView(chat);
                else if (actionBtn.dataset.action === 'lore') openChatLoreForEntry(chat);
                else if (actionBtn.dataset.action === 'menu') CoreAPI.getModule('context-menu')?.showItems?.(e, chatContextItems(chat));
                return;
            }

            openChatFor(chat);
        });
        chatsGrid.addEventListener('contextmenu', (e) => chatContextMenu(e, '.chat-card, .chat-hero'));
        chatsGrid.addEventListener('keydown', (e) => chatRowKeydown(e, '.chat-card, .chat-hero'));
    }

    const groupedView = document.getElementById('chatsGroupedView');
    if (groupedView) {
        groupedView.addEventListener('click', (e) => {
            if (e.target.closest('.chats-retry')) { void loadAllChats(true); return; }
            const header = e.target.closest('.chat-group-header');
            if (header) {
                const charNameEl = e.target.closest('.clickable-char-name');
                if (charNameEl) {
                    e.stopPropagation();
                    openCharacterDetailsFromChats(header.closest('.chat-group')?.dataset.charId);
                    return;
                }
                header.closest('.chat-group')?.classList.toggle('collapsed');
                return;
            }

            const item = e.target.closest('.chat-group-item');
            if (!item) return;
            const chat = findChatByElement(item);
            if (!chat) return;

            const actionBtn = e.target.closest('.chat-card-action, .chat-card-kebab');
            if (actionBtn) {
                e.stopPropagation();
                if (actionBtn.dataset.action === 'delete') deleteChatFromView(chat);
                else if (actionBtn.dataset.action === 'lore') openChatLoreForEntry(chat);
                else if (actionBtn.dataset.action === 'menu') CoreAPI.getModule('context-menu')?.showItems?.(e, chatContextItems(chat));
                return;
            }

            openChatFor(chat);
        });
        groupedView.addEventListener('contextmenu', (e) => chatContextMenu(e, '.chat-group-item'));
        groupedView.addEventListener('keydown', (e) => chatRowKeydown(e, '.chat-group-item'));
    }

    CoreAPI.debugLog('Chats view initialized');
}

// right-click on desktop, long-press on a phone (synthesized); a native and synthetic press within a beat dedupe
let _lastChatCtxAt = 0;
function chatContextMenu(e, selector) {
    const row = e.target.closest(selector);
    if (!row) return;
    const chat = findChatByElement(row);
    const menu = CoreAPI.getModule('context-menu');
    if (!chat || !menu?.showItems) return;
    if (Date.now() - _lastChatCtxAt < 300) { e.preventDefault(); return; }
    _lastChatCtxAt = Date.now();
    menu.showItems(e, chatContextItems(chat));
}

// The row's verbs, one list for the menu and the sheet: open, the lorebooks, an extension's, delete.
function chatContextItems(chat) {
    const items = [
        { type: 'header', label: CoreAPI.truncate(displayChatName(chat) || 'Chat', 32) },
        { icon: 'fa-solid fa-arrow-right', label: 'Open Chat', action: () => openChatFor(chat) },
        { icon: 'fa-solid fa-book-atlas', label: 'Lorebooks', action: () => openChatLoreForEntry(chat) },
    ];
    // extension verbs behind a separator of their own; the phone's sheet clones this rendered menu
    if (extHasActions('chatCard')) {
        const context = chatCardContext(chat);
        const acts = extActionsFor('chatCard', context);
        if (acts.length) {
            items.push({ type: 'separator' });
            for (const a of acts) items.push({ icon: `fa-solid ${a.icon}`, label: a.label, action: () => extRunAction(a.key, context) });
        }
    }
    items.push({ type: 'separator' }, { icon: 'fa-solid fa-trash', label: 'Delete Chat', className: 'danger', action: () => deleteChatFromView(chat) });
    return items;
}

// Enter on a focused row opens it; the buttons inside keep their own keys.
function chatRowKeydown(e, selector) {
    if (e.key !== 'Enter') return;
    const row = e.target.closest(selector);
    if (!row || row !== e.target) return;
    const chat = findChatByElement(row);
    if (!chat) return;
    e.preventDefault();
    openChatFor(chat);
}

// the lore picker wants the character, which a list row resolves on demand
function openChatLoreForEntry(chat) {
    if (chat.character) { openChatLorePicker(chat.character, chat); return; }
    CoreAPI.ensureCharacterById(chat.charId).then(char => {
        if (!char) return;
        chat.character = char;
        openChatLorePicker(char, chat);
    });
}

// A card is addressed by the chat's id: names are not unique, not even within one character.
function findChatByElement(el) {
    const chatId = el.dataset.chatId;
    return chatId ? (_chatRows.get(chatId) || null) : null;
}

// ========================================
// LOADING & FETCHING
// ========================================

let _chatsLoadGen = 0;
let _chatsInflight = null;     // { key, promise }: concurrent callers of one query share a run
let _chatsPageInflight = false;
let chatsFetchController = null;

// page 0 of the query: a matching re-entry paints from memory and re-asks behind; force supersedes a run in flight
function loadAllChats(force = false) {
    const params = chatsQueryParams();
    const key = params.toString();
    if (_chatsInflight && _chatsInflight.key === key && !force) return _chatsInflight.promise;
    const loaded = key === _chatsQueryKey && _chatRows.size > 0;
    if (loaded) renderChats();
    const gen = ++_chatsLoadGen;
    const promise = fetchChatsPage(params, { gen, background: loaded });
    const tracked = promise.finally(() => { if (_chatsInflight?.promise === tracked) _chatsInflight = null; });
    _chatsInflight = { key, promise: tracked };
    return tracked;
}

// The next page of the loaded query, by cursor and without a count; the sentinel's call.
function loadMoreChats() {
    if (!_chatsCursor || _chatsInflight || _chatsPageInflight) return;
    _chatsPageInflight = true;
    void fetchChatsPage(new URLSearchParams(_chatsQueryKey), { gen: _chatsLoadGen, after: _chatsCursor })
        .finally(() => { _chatsPageInflight = false; });
}

async function fetchChatsPage(params, { gen, background = false, after = null } = {}) {
    chatsFetchController?.abort();
    chatsFetchController = new AbortController();
    const { signal } = chatsFetchController;
    const chatsGrid = document.getElementById('chatsGrid');
    const page = new URLSearchParams(params);
    page.set('limit', String(PAGE_SIZE));
    if (after) { page.set('after', after); page.set('count', 'false'); }

    // a loader only over an EMPTY view, deferred a beat so a warm load never flashes it
    const loaderTimer = (!after && !background && !isConversationOpen() && _renderedChatsSig === null)
        ? setTimeout(() => {
            if (gen !== _chatsLoadGen || isConversationOpen() || _renderedChatsSig !== null) return;
            CoreAPI.renderLoadingState(chatsGrid, 'Loading your chats...', 'chats-loading');
        }, 150)
        : 0;
    try {
        const response = await CoreAPI.apiRequest(`/chats?${page}`, 'GET', null, { signal });
        if (gen !== _chatsLoadGen) return;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (gen !== _chatsLoadGen) return;

        if (after) {
            const merged = mergeChatsPage(_chatRows, _chatsTotal, data, { reset: false });
            _chatRows = merged.rows;
            _chatsCursor = merged.cursor;
            renderChats({ appended: data.items || [] });
            return;
        }

        // a background re-ask whose head is unchanged refreshes in place and keeps the pages behind; a changed head starts over
        const ids = (data.items || []).map(r => r.id);
        const head = [..._chatRows.keys()].slice(0, PAGE_SIZE);
        if (background && ids.length && ids.join('\x1f') === head.join('\x1f')) {
            for (const row of data.items) _chatRows.set(row.id, row);
            _chatsTotal = data.total ?? _chatsTotal;
            renderChats();
            return;
        }
        const merged = mergeChatsPage(_chatRows, _chatsTotal, data, { reset: true });
        _chatRows = merged.rows;
        _chatsTotal = merged.total;
        _chatsCursor = merged.cursor;
        _chatsQueryKey = params.toString();
        if (!_chatRows.size) {
            // an empty LIBRARY and an empty ANSWER are different states: only the first
            // offers the Characters tab
            _renderedChatsSig = null;
            disconnectObservers();
            if (!params.has('q') && !params.has('rules')) {
                CoreAPI.renderEmptyState(chatsGrid, {
                    icon: 'fa-solid fa-ghost',
                    title: 'No chats yet',
                    hint: 'Start a conversation with any character to see it here. Open a character from the Characters tab and send your first message.',
                    actionLabel: 'Browse characters',
                    actionIcon: 'fa-solid fa-users',
                    onAction: () => CoreAPI.goToView('characters'),
                });
                document.getElementById('chatsGroupedView')?.classList.add('hidden');
                chatsGrid.classList.remove('hidden');
                return;
            }
        }
        renderChats();
    } catch (e) {
        if (e?.name === 'AbortError' || gen !== _chatsLoadGen) return;
        console.error('Failed to load chats:', e);
        if (after) {
            CoreAPI.showToast(`Could not load more chats: ${e.message}`, 'error');
            return;
        }
        // nothing painted yet means the error state, with a retry; a later failure keeps
        // the last good list and says so
        if (_renderedChatsSig === null) renderChatsLoadError(e.message);
        else CoreAPI.showToast(`Could not refresh chats: ${e.message}`, 'error');
    } finally {
        clearTimeout(loaderTimer);
    }
}

function renderChatsLoadError(message) {
    _renderedChatsSig = null;
    disconnectObservers();
    const target = currentGrouping === 'grouped' ? document.getElementById('chatsGroupedView') : document.getElementById('chatsGrid');
    document.getElementById('chatsGrid')?.classList.toggle('hidden', currentGrouping === 'grouped');
    document.getElementById('chatsGroupedView')?.classList.toggle('hidden', currentGrouping !== 'grouped');
    if (!target) return;
    target.innerHTML = `
        <div class="chats-empty">
            <i class="fa-solid fa-exclamation-triangle"></i>
            <h3>Could not load chats</h3>
            ${message ? `<p>${CoreAPI.escapeHtml(message)}</p>` : ''}
            <button type="button" class="cl-btn cl-btn-primary chats-retry"><i class="fa-solid fa-rotate-right"></i> Retry</button>
        </div>
    `;
}

// a chat card's, hero's or grouped row's preview of its last message, under the transcript's rule
function chatPreviewHtml(text, chat) {
    return CoreAPI.safePurify(CoreAPI.formatRichText(closePreviewMarkers(text), chat?.charName || '', true, { ...STORED_TEXT, pronouns: chatGreetingPronouns(chat) }), BROWSE_PURIFY_CONFIG);
}

// a greeting alone is row 0, which every build expands again: its pronoun macros answer from the chat's persona, as the transcript's do
function chatGreetingPronouns(chat) {
    if ((chat?.messageCount ?? 0) !== 1) return null;
    return chat.personaName ? (chat.personaPronouns ?? null) : CoreAPI.getPersonaPronouns();
}

// the preview is a 150-char slice, so a marker closing past it shows a literal *; re-close dangling ones
function closePreviewMarkers(text) {
    if (!text) return text;
    let out = text;
    // no images in previews: an <img> blows out the fixed card (markdown images go too, alt and all)
    out = out.replace(/!\[[^\]]*\]\((?:(?:[^()]|\([^()]*\))*|[^)]*)\)/g, '').replace(/<img\b[^>]*>/gi, '');
    for (const m of ['```', '~~', '**', '__', '`', '*', '_']) {
        if ((out.split(m).length - 1) % 2 === 1) out += m;
    }
    return out;
}

function previewOf(chat) {
    const text = chat.lastMes || '';
    return text ? text.substring(0, 150) + (text.length > 150 ? '...' : '') : '';
}

// ========================================
// RENDERING
// ========================================

// paints the loaded pages; `appended` rows land under the paint on screen instead of rebuilding it
function renderChats({ appended = null } = {}) {
    // the grid and the conversation are siblings, so a repaint under an open chat would un-hide the grid above it
    if (isConversationOpen()) return;
    const rows = [..._chatRows.values()];
    if (currentGrouping === 'flat') renderFlatChats(rows, appended);
    else renderGroupedChats(rows, appended);
}

// what the cards visibly show, so an identical repaint is skipped (it reset scroll and replayed the fades)
let _renderedChatsSig = null;
// that signature per row plus the layout it was laid out in, so a same-layout repaint redraws only moved rows
let _renderedChatsRows = null;

// One row's share of the signature: what its card, hero or grouped row shows (the hero shows
// the draft itself, up to 240 chars).
function chatRowSignature(c) {
    return `${c.id}\x1f${c.name}\x1f${c.lastMesAt || ''}\x1f${c.messageCount || 0}\x1f`
        + `${previewOf(c)}\x1f${getChatWorlds(c).join(',')}\x1f${c.charChatCount ?? ''}\x1f`
        + `${(c.draft || '').trim().slice(0, 240)}\x1f`
        + `${c.charName || ''}\x1f${c.charId ? CoreAPI.getCharacterAvatarSmallThumbUrl(c.charId) || '' : ''}\x1e`;
}

function noteChatsPaint(sig, layout, rowSigs) {
    _renderedChatsSig = sig;
    _renderedChatsRows = { sig, layout, rowSigs };
}

// redraw only the rows whose signature moved, in place; false when the layout moved and the caller rebuilds
function swapChangedChatRows(container, rows, rowSigs, layout, rowHtml) {
    const was = _renderedChatsRows;
    if (!was || was.sig !== _renderedChatsSig || was.layout !== layout) return false;
    const changed = rows.filter((_, i) => was.rowSigs[i] !== rowSigs[i]);
    const els = new Map([...container.querySelectorAll('[data-chat-id]')].map(el => [el.dataset.chatId, el]));
    if (!changed.every(row => els.has(row.id))) return false;
    for (const row of changed) {
        const holder = document.createElement('div');
        holder.innerHTML = rowHtml(row).trim();
        const fresh = holder.children[0];
        const old = els.get(row.id);
        old.after(fresh);
        old.remove();
        promoteCachedChatAvatars(fresh);
    }
    return true;
}

function renderNoMatch(container) {
    container.innerHTML = `
        <div class="chats-empty">
            <i class="fa-solid fa-search"></i>
            <h3>No Matching Chats</h3>
            <p>Try a different search term.</p>
        </div>
    `;
}

function renderFlatChats(rows, appended) {
    const chatsGrid = document.getElementById('chatsGrid');
    const groupedView = document.getElementById('chatsGroupedView');

    chatsGrid.classList.remove('hidden');
    groupedView.classList.add('hidden');

    // the hero and bands are on screen too, so a mode flip over the same rows still rebuilds
    const heroOn = chatHeroOn(rows);
    const banded = chatBandsOn();
    const modeKey = `flat\x1f${currentChatSort}\x1f${chatLayout()}\x1f${heroOn ? 'H' : ''}\x1f${banded ? 'B' : ''}`;
    const rowSigs = rows.map(chatRowSignature);
    const sig = modeKey + '\x1e' + (rows.length ? rowSigs.join('') : 'EMPTY');
    const layout = modeKey + '\x1e' + rows.map(r => `${r.id}\x1f${chatBandOf(r, banded)}`).join('\x1e');

    if (appended) {
        document.getElementById('chatsSentinel')?.remove();
        appendBandedCards(chatsGrid, appended);
        noteChatsPaint(sig, layout, rowSigs);
        armSentinel(chatsGrid);
        return;
    }
    if (sig === _renderedChatsSig) {
        // Same content already on screen; keep the DOM and the scroll position. The
        // sentinel is re-armed because leaving the view disconnected it (onViewExit).
        armSentinel(chatsGrid);
        return;
    }
    if (rows.length && swapChangedChatRows(chatsGrid, rows, rowSigs, layout, (r) => (heroOn && r === rows[0] ? chatHeroHtml(r) : createChatCard(r)))) {
        noteChatsPaint(sig, layout, rowSigs);
        armSentinel(chatsGrid);
        return;
    }
    disconnectObservers();
    noteChatsPaint(sig, layout, rowSigs);

    if (rows.length === 0) {
        renderNoMatch(chatsGrid);
        return;
    }

    chatsGrid.innerHTML = '';
    let bandRows = rows;
    if (heroOn) {
        chatsGrid.insertAdjacentHTML('beforeend', chatHeroHtml(rows[0]));
        bandRows = rows.slice(1);
    }
    appendBandedCards(chatsGrid, bandRows);
    armSentinel(chatsGrid);
}

// the band a row lands in: its recency under a recency sort, one bare section otherwise
function chatBandOf(row, banded) {
    return banded ? recencyBand(chatStamp(row)) : 'all';
}

// cards land in their recency band; a page continuing the last painted band joins it, no duplicate header
function appendBandedCards(container, rows) {
    const banded = chatBandsOn();
    for (const row of rows) {
        const key = chatBandOf(row, banded);
        let band = container.lastElementChild;
        if (band && band.id === 'chatsSentinel') band = band.previousElementSibling;
        if (!(band && band.classList?.contains('chat-band') && band.dataset.bandKey === key)) {
            container.insertAdjacentHTML('beforeend', chatBandHtml(key, banded));
            band = container.lastElementChild;
        }
        const bandGrid = band.querySelector('.chat-band-grid');
        bandGrid.insertAdjacentHTML('beforeend', createChatCard(row));
        const countEl = band.querySelector('.chat-band-count');
        if (countEl) countEl.textContent = String(bandGrid.children.length);
    }
    promoteCachedChatAvatars(container);
}

function chatBandHtml(key, banded) {
    const head = banded
        ? `<div class="chat-band-head"><span class="chat-band-label">${CoreAPI.escapeHtml(key)}</span><span class="chat-band-count">0</span><span class="chat-band-rule"></span></div>`
        : '';
    return `<section class="chat-band${banded ? '' : ' is-bare'}" data-band-key="${CoreAPI.escapeHtml(key)}">${head}<div class="chat-band-grid"></div></section>`;
}

function renderGroupedChats(rows, appended) {
    const chatsGrid = document.getElementById('chatsGrid');
    const groupedView = document.getElementById('chatsGroupedView');

    chatsGrid.classList.add('hidden');
    groupedView.classList.remove('hidden');

    // Same skip as the flat branch; a preserved rebuild here also keeps which groups the
    // reader had expanded, which a rewrite silently collapses.
    const rowSigs = rows.map(chatRowSignature);
    const sig = 'grouped\x1e' + (rows.length ? rowSigs.join('') : 'EMPTY');
    // a group's header shows its character, its count and its newest row's stamp, so they are layout
    const layout = 'grouped\x1e' + groupRows(rows).map(g => [g.charId, g.charName, g.count ?? '',
        g.charId ? CoreAPI.getCharacterAvatarSmallThumbUrl(g.charId) || '' : '', chatStamp(g.rows[0]), ...g.rows.map(r => r.id)].join('\x1f')).join('\x1e');
    if (appended) {
        document.getElementById('chatsSentinel')?.remove();
        appendGroupedRows(groupedView, appended);
        noteChatsPaint(sig, layout, rowSigs);
        armSentinel(groupedView);
        return;
    }
    if (sig === _renderedChatsSig) { armSentinel(groupedView); return; }
    if (rows.length && swapChangedChatRows(groupedView, rows, rowSigs, layout, createGroupedChatItem)) {
        noteChatsPaint(sig, layout, rowSigs);
        armSentinel(groupedView);
        return;
    }
    noteChatsPaint(sig, layout, rowSigs);
    disconnectObservers();

    if (rows.length === 0) {
        renderNoMatch(groupedView);
        return;
    }

    groupedView.innerHTML = '';
    appendGroupedRows(groupedView, rows);
    armSentinel(groupedView);
}

// a page continuing the last painted character joins its group (collapse state kept), no second header
function appendGroupedRows(container, rows) {
    for (const g of groupRows(rows)) {
        const tail = container.lastElementChild;
        if (tail?.classList.contains('chat-group') && tail.dataset.charId === g.charId) {
            tail.querySelector('.chat-group-content')?.insertAdjacentHTML('beforeend', g.rows.map(createGroupedChatItem).join(''));
            continue;
        }
        container.insertAdjacentHTML('beforeend', createGroupHtml(g));
    }
    promoteCachedChatAvatars(container);
}

function createGroupHtml(g) {
    // the count is the character's, from the row, not the rows on this page
    const count = g.count ?? g.rows.length;
    // rows arrive newest-first within a group, so row 0 is the character's last activity
    const last = g.rows[0] ? relChatTime(chatStamp(g.rows[0])) : '';
    return `
        <div class="chat-group" data-char-id="${CoreAPI.escapeHtml(g.charId)}">
            <div class="chat-group-header">
                <div class="chat-group-portrait">${chatAvatarHtml(g.charId, g.charName, 'chat-group-avatar-size')}</div>
                <div class="chat-group-info">
                    <div class="chat-group-name clickable-char-name" data-char-id="${CoreAPI.escapeHtml(g.charId)}" title="View character details">${CoreAPI.escapeHtml(g.charName)}</div>
                    <div class="chat-group-meta"><span class="chat-group-count">${count} chat${count !== 1 ? 's' : ''}</span>${last ? `<span class="chat-group-last">${last}</span>` : ''}</div>
                </div>
                <i class="fa-solid fa-chevron-down chat-group-toggle"></i>
            </div>
            <div class="chat-group-content">
                ${g.rows.map(createGroupedChatItem).join('')}
            </div>
        </div>
    `;
}

// ========================================
// PAGINATION (the server's pages, continued by cursor)
// ========================================

// One sentinel under the active container; crossing it asks for the next page, and the
// end of the list (no cursor) leaves nothing to observe.
function armSentinel(container) {
    if (_sentinelObserver) { _sentinelObserver.disconnect(); _sentinelObserver = null; }
    document.getElementById('chatsSentinel')?.remove();
    if (!_chatsCursor) return;

    const sentinel = document.createElement('div');
    sentinel.id = 'chatsSentinel';
    sentinel.style.height = '1px';
    container.appendChild(sentinel);

    _sentinelObserver = new IntersectionObserver((entries) => {
        if (!entries[0].isIntersecting) return;
        loadMoreChats();
    }, { rootMargin: '400px' });

    _sentinelObserver.observe(sentinel);
}

function disconnectObservers() {
    if (_sentinelObserver) { _sentinelObserver.disconnect(); _sentinelObserver = null; }
}

// ========================================
// CARD / ITEM CREATION
// ========================================

// skip the fade for a cached avatar, keyed by raw src: a detached <template> img can resolve img.src differently on mobile
function promoteCachedChatAvatars(root) {
    if (!root || !root.querySelectorAll) return;
    for (const wrap of root.querySelectorAll('.chat-avatar-wrap:not(.loaded)')) {
        const img = wrap.querySelector('img');
        if (!img) continue;
        const key = img.getAttribute('src');
        if (key && (_seenAvatarUrls.has(key) || (img.complete && img.naturalWidth > 0))) {
            _seenAvatarUrls.add(key);
            wrap.classList.add('loaded');
        } else if (key) {
            img.addEventListener('load', () => _seenAvatarUrls.add(key), { once: true });
        }
    }
}

// The id addresses the card; data-last-mes carries the raw stamp for the mobile date repair.
function chatDataAttrs(chat) {
    return `data-chat-id="${CoreAPI.escapeHtml(chat.id)}" data-char-id="${CoreAPI.escapeHtml(chat.charId || '')}" data-last-mes="${chat.lastMesAt ?? ''}"`;
}

// Relative time and the recency spine (the browse view's rhythm)
// A chat's age is its newest message, or its creation when it has none yet.
function chatStamp(chat) { return chat?.lastMesAt || chat?.createDate || 0; }

// The relative stamp on the row, the absolute one in its tooltip.
function chatTimeHtml(chat) {
    const ts = chatStamp(chat);
    const abs = ts ? new Date(ts).toLocaleString() : '';
    return `<span class="chat-card-time" title="${CoreAPI.escapeHtml(/Invalid/.test(abs) ? '' : abs)}">${relChatTime(ts)}</span>`;
}

// CALENDAR days, as recencyBand counts, so a stamp never says yesterday under a This week header
function relChatTime(ts) {
    if (!ts) return '';
    const min = Math.floor((Date.now() - ts) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const day = Math.floor((start.getTime() - ts) / 86400000) + 1;
    if (day <= 0) return `${Math.floor(min / 60)}h ago`;
    if (day === 1) return 'yesterday';
    if (day < 7) return `${day}d ago`;
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Calendar-aware buckets: a message just before midnight reads "yesterday" the next
// morning, whicha rolling 24h window would keep calling "today".
function recencyBand(ts) {
    if (!ts) return 'Earlier';
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const t0 = start.getTime();
    if (ts >= t0) return 'Today';
    if (ts >= t0 - 86400000) return 'Yesterday';
    if (ts >= t0 - 6 * 86400000) return 'This week';
    if (ts >= new Date(start.getFullYear(), start.getMonth(), 1).getTime()) return 'This month';
    if (ts >= new Date(start.getFullYear(), 0, 1).getTime()) return 'This year';
    return 'Earlier';
}

function chatSearchActive() { return !!(document.getElementById('searchInput')?.value || '').trim(); }
// bands mean something only under a recency sort; the cards layout is the classic grid, no bands, no hero
function chatBandsOn() { return currentGrouping === 'flat' && chatLayout() !== 'cards' && (currentChatSort === 'recent' || currentChatSort === 'oldest'); }
// The hero is "jump back into your most recent storyline": newest-first and unfiltered.
function chatHeroOn(rows) { return currentGrouping === 'flat' && chatLayout() !== 'cards' && currentChatSort === 'recent' && !chatSearchActive() && rows.length > 0; }

// One avatar builder for the card, the group header and the hero. Wrap classes match
// what promoteCachedChatAvatars and the load delegate look for.
function chatAvatarHtml(charId, charName, sizeClass) {
    const url = CoreAPI.getCharacterAvatarSmallThumbUrl(charId);
    if (url) {
        return `<div class="chat-avatar-wrap ${sizeClass}"><img src="${url}" alt="${CoreAPI.escapeHtml(charName || '')}" class="chat-card-avatar" onload="this.parentElement.classList.add('loaded')" onerror="this.src='/img/no-portrait.png'"></div>`;
    }
    return `<div class="chat-card-avatar-fallback ${sizeClass}"><i class="fa-solid fa-user"></i></div>`;
}

// The draft is real unsent composer text the reader left here: a resume cue, not chrome.
function chatDraftChipHtml(chat) {
    return (chat.draft || '').trim()
        ? '<span class="chat-chip chat-chip-draft" title="You have an unsent draft in this chat"><i class="fa-solid fa-pen"></i> Draft</span>'
        : '';
}

// whose story this is, only when the chat OVERRIDES the persona (personaName is null while it follows)
function chatPersonaChipHtml(chat) {
    const name = String(chat?.personaName || '').trim();
    if (!name) return '';
    const esc = CoreAPI.escapeHtml(name);
    return `<span class="chat-chip chat-chip-persona" title="Played as ${esc}"><i class="fa-solid fa-masks-theater"></i> ${esc}</span>`;
}

// the meta bits the tile and grouped row share: the count, then chips with something to say
function chatMetaBitsHtml(chat) {
    const n = chat.messageCount || 0;
    return `<span class="chat-card-count" title="${n} message${n === 1 ? '' : 's'}"><i class="fa-solid fa-comment"></i> ${n}</span>`
        + chatPersonaChipHtml(chat) + chatDraftChipHtml(chat);
}

// the row's verbs share the top row's meta slot with the stamp on desktop; the phone carries them in its sheet
function chatActionsHtml(chat) {
    const worlds = getChatWorlds(chat);
    const names = CoreAPI.escapeHtml(worlds.join(', '));
    const loreLabel = worlds.length
        ? (worlds.length === 1 ? `Lorebook: ${names}` : `Lorebooks (${worlds.length}): ${names}`) + ' (click to change)'
        : 'Bind lorebooks to this chat';
    return '<span class="chat-card-actions">'
        + `<button type="button" class="chat-card-action${worlds.length ? ' chat-lore-bound' : ''}" data-action="lore" title="${loreLabel}" aria-label="${loreLabel}"><i class="fa-solid fa-book-atlas"></i></button>`
        + '<button type="button" class="chat-card-action danger" data-action="delete" title="Delete chat" aria-label="Delete chat"><i class="fa-solid fa-trash"></i></button>'
        + '</span>';
}

// the phone has no hover: a corner kebab opens the same verbs through the menu module's sheet
function chatKebabHtml() {
    return '<button type="button" class="chat-card-kebab" data-action="menu" title="Chat actions" aria-label="Chat actions"><i class="fa-solid fa-ellipsis-vertical"></i></button>';
}

function chatMetaSlotHtml(chat) {
    return `<span class="chat-card-meta-slot">${chatTimeHtml(chat)}${chatActionsHtml(chat)}</span>`;
}

// the previous card, kept whole as the cards layout: header band, boxed last message, footer
function chatCardClassicHtml(chat) {
    const chatName = CoreAPI.escapeHtml(displayChatName(chat));
    const charName = CoreAPI.escapeHtml(chat.charName || '');
    const preview = previewOf(chat);
    const previewHtml = preview
        ? chatPreviewHtml(preview, chat)
        : '<span class="chat-card-noprev">No messages yet</span>';

    return `
        <div class="chat-card" ${chatDataAttrs(chat)} tabindex="0">
            <div class="chat-card-header">
                ${chatAvatarHtml(chat.charId, chat.charName, 'chat-card-avatar-size')}
                <div class="chat-card-char-info">
                    <div class="chat-card-char-name clickable-char-name" data-char-id="${CoreAPI.escapeHtml(chat.charId || '')}" title="View character details"><span class="chat-card-char-name-text">${charName}</span></div>
                    <div class="chat-card-chat-name">${chatName}</div>
                </div>
            </div>
            <div class="chat-card-body">
                <div class="chat-card-preview">${previewHtml}</div>
            </div>
            <div class="chat-card-footer">
                <div class="chat-card-meta">
                    <span><i class="fa-solid fa-calendar"></i> ${chatTimeHtml(chat)}</span>
                    ${chatMetaBitsHtml(chat)}
                </div>
                ${chatActionsHtml(chat)}
            </div>
            ${chatKebabHtml()}
        </div>
    `;
}

function createChatCard(chat) {
    if (chatLayout() === 'cards') return chatCardClassicHtml(chat);
    const chatName = CoreAPI.escapeHtml(displayChatName(chat));
    const charName = CoreAPI.escapeHtml(chat.charName || '');
    const preview = previewOf(chat);
    // Row fields, never chat.character: the objects resolve on demand and a card must
    // render whole without them (charId is all an avatar needs).
    const previewHtml = preview
        ? chatPreviewHtml(preview, chat)
        : '<span class="chat-card-noprev">No messages yet</span>';

    return `
        <div class="chat-card" ${chatDataAttrs(chat)} tabindex="0">
            <div class="chat-card-portrait">${chatAvatarHtml(chat.charId, chat.charName, 'chat-card-avatar-size')}</div>
            <div class="chat-card-main">
                <div class="chat-card-top">
                    <span class="chat-card-title">${chatName}</span>
                    ${chatMetaSlotHtml(chat)}
                </div>
                <div class="chat-card-sub">
                    <span class="chat-card-char clickable-char-name" data-char-id="${CoreAPI.escapeHtml(chat.charId || '')}" title="View character details">${charName}</span>
                    ${chatMetaBitsHtml(chat)}
                </div>
                <div class="chat-card-preview">${previewHtml}</div>
            </div>
            ${chatKebabHtml()}
        </div>
    `;
}

// the newest storyline as a poster: the whole card is the verb, and a pending draft is the body line
function chatHeroHtml(chat) {
    const chatName = CoreAPI.escapeHtml(displayChatName(chat));
    const charName = CoreAPI.escapeHtml(chat.charName || '');
    const n = chat.messageCount || 0;
    const worlds = getChatWorlds(chat);
    const loreBit = worlds.length ? `<span>${worlds.length} lorebook${worlds.length > 1 ? 's' : ''}</span>` : '';
    const draft = (chat.draft || '').trim();
    let body;
    if (draft) {
        body = `<div class="chat-hero-preview is-draft"><i class="fa-solid fa-pen"></i>${CoreAPI.escapeHtml(draft.slice(0, 240))}</div>`;
    } else {
        const preview = previewOf(chat);
        const previewHtml = preview
            ? chatPreviewHtml(preview, chat)
            : '<span class="chat-card-noprev">No messages yet</span>';
        // a div, as the tile's: the preview can hold a block (a rule, a div), and the parser closes a <p> at one
        body = `<div class="chat-hero-preview">${previewHtml}</div>`;
    }
    // the 384 rung: the poster renders at 112 css px, sharp at 3x
    const posterUrl = CoreAPI.getCharacterAvatarThumbUrl(chat.charId, 384);
    const poster = posterUrl
        ? `<img class="chat-hero-image" src="${posterUrl}" alt="" onerror="this.src='/img/no-portrait.png'">`
        : '<div class="chat-hero-poster-fallback"><i class="fa-solid fa-user"></i></div>';
    // the same bytes again as the blurred backdrop: one request, the browser serves the second from cache
    const bleed = posterUrl ? `<img class="chat-hero-bleed" src="${posterUrl}" alt="" aria-hidden="true" onerror="this.remove()">` : '';
    return `
        <div class="chat-hero" ${chatDataAttrs(chat)} tabindex="0">
            ${bleed}
            <div class="chat-hero-poster">${poster}<span class="chat-hero-play" aria-hidden="true"><i class="fa-solid fa-play"></i></span></div>
            <div class="chat-hero-main">
                <div class="chat-hero-title">${chatName}</div>
                <div class="chat-hero-meta"><span class="chat-hero-char clickable-char-name" data-char-id="${CoreAPI.escapeHtml(chat.charId || '')}">${charName}</span><span>${n} message${n === 1 ? '' : 's'}</span>${chatTimeHtml(chat)}${loreBit}${chatDraftChipHtml(chat)}</div>
                ${body}
            </div>
        </div>
    `;
}

function createGroupedChatItem(chat) {
    const chatName = CoreAPI.escapeHtml(displayChatName(chat));
    const preview = previewOf(chat);
    const previewText = preview
        ? chatPreviewHtml(preview, chat)
        : '<span class="chat-card-noprev">No messages yet</span>';

    return `
        <div class="chat-group-item" ${chatDataAttrs(chat)} tabindex="0">
            <div class="chat-group-item-main">
                <div class="chat-card-top">
                    <span class="chat-card-title">${chatName}</span>
                    ${chatMetaSlotHtml(chat)}
                </div>
                <div class="chat-card-sub">${chatMetaBitsHtml(chat)}</div>
                <div class="chat-card-preview chat-group-item-preview">${previewText}</div>
            </div>
            ${chatKebabHtml()}
        </div>
    `;
}

// ========================================
// CONVERSATION MODE (the live chat, inside the chats view)
// ========================================
// The chats view has two modes: browse (the card grid) and conversation. The view
// NAME stays 'chats' the whole time so every getCurrentView() consumer keeps
// working unchanged; _convChatId is the mode flag and null means browse.

let _convChatId = null;
let _convChar = null;
// The chat detail's verdict on the card's own character_book, handed to the lore panel and
// read by the badge. null when the card carries none.
let _convEmbeddedLore = null;
// the open chat's messages in the native shape: raw is the stored row, seq its place, id what a verb names
let _convMessages = [];
let _convUserName = null;
let _convPersonaName = null;
// the resolved persona's id, so a follow sees the persona move even when two share a name and no picture
let _convPersonaId = null;
// the resolved persona's id when it has a picture, so the user-side avatar can be addressed
let _convPersonaAvatarId = null;
// the resolved persona's pronoun forms, which the greeting row answers as every build does; null shows it as stored
let _convPersonaPronouns = null;
let _convAbort = null;
// true while an extension's composer.send filter holds the text
let _convSending = false;
// that wait, scoped to its chat ({ chatId, abandoned }): a Stop, a switch or a close abandons it
let _convSendWait = null;
let _convProfileId = null;
// the answering connection's sight: only true offers attaching, and only true is sent pictures
let _convSees = null;
// pictures waiting for the next send: in the chat's gallery already (uploaded on attach), named on the send
const _convTray = createPictureTray({ strip: () => document.getElementById('chatConvPending'), removeTitle: "Not with this message (it stays in the chat's gallery)" });
// the banner text syncConvProfiles last showed, so it clears only its own
let _convProfileNote = null;
// whether this chat holds a connection or a preset of its own, as the server resolved them; their openers wear the mark
let _convOwnProfile = false;
let _convOwnPreset = false;
// the preset in force here (null: the built-in blocks); a switch re-measures the budget
let _convPresetId;
// remote image urls rewritten to local /media/ copies; null is not-built-yet, not none, so the first render repeats
let _convMediaMap = null;
// the open chat's metadata, handed to chat-level surfaces in the shape a chat card gives them
let _convChatMeta = null;

function isConversationOpen() { return _convChatId !== null; }
// the character an open or parked conversation follows: a re-read of held rows past its bound still covers it
function conversationCharacterId() { return isConversationOpen() ? (_convChar?.id ?? null) : null; }

// line length, not column width: past ~75 characters the eye loses its place; the top is the full-width escape
const MEASURE_MIN = 45;
const MEASURE_MAX = 120;
const MEASURE_FILL = MEASURE_MAX + 1;
const MEASURE_DEFAULT = 68;

function convStoredMeasureCh() {
    const v = parseInt(CoreAPI.getSetting('chatMeasureCh'), 10);
    if (!Number.isFinite(v)) return MEASURE_DEFAULT;
    return Math.min(MEASURE_FILL, Math.max(MEASURE_MIN, v));
}

// a switch as the pane applies it: a default-on key is on unless stored false, a default-off one only when stored true
function convSwitchOn(key) {
    const v = CoreAPI.getSetting(key);
    return CoreAPI.getDefaultSetting(key) === true ? v !== false : v === true;
}

/** Every display option is ONE root attribute CSS reads: a toggle is an attribute write, never a re-render. */
function convApplyDisplayOptions() {
    const pane = convEls().pane;
    if (!pane) return;
    const mode = CoreAPI.getSetting('chatDisplayMode');
    pane.dataset.mode = mode === 'column' ? 'column' : 'banner';
    pane.dataset.timestamps = String(convSwitchOn('chatShowTimestamps'));
    pane.dataset.meta = String(convSwitchOn('chatShowMeta'));
    pane.dataset.avatars = String(convSwitchOn('chatShowAvatars'));
    pane.dataset.msgFill = String(convSwitchOn('chatMessageFill'));
    pane.dataset.expandActions = String(convSwitchOn('chatExpandActions'));
    // Stamped RAW: auto resolves in CSS via html.cl-mobile, so a live viewport flip
    // re-scopes the layout without anyone re-running this.
    const layout = CoreAPI.getSetting('chatBodyLayout');
    pane.dataset.bodyLayout = layout === 'beside' || layout === 'full' ? layout : 'auto';
}

// the streaming caret is the product's only loop, so its off switch lives with the display state
function convApplyAmbientMotion() {
    document.documentElement.classList.toggle(
        'cl-no-ambient', CoreAPI.getSetting('chatAmbientMotion') === false);
}

// whether the chat paints a reply as it is written; off, the row waits with its status and the reply lands whole
const convStreams = () => convSwitchOn('chatStreaming');

// switched off mid-reply what is shown stays and the row waits; switched on, everything arrived shows in one paint
function convApplyStreaming() {
    const pane = convEls().pane;
    if (pane) pane.dataset.streaming = String(convStreams());
    if (!_convLiveEl?.isConnected) return;
    if (convStreams()) {
        _convReplyReveal.arrive(_convLiveText.length);
        _convThinkReveal.arrive(_convLiveReasoning.length);
        _convReplyReveal.all();
        _convThinkReveal.all();
        _convLiveDirty = true;
        _convLiveReasoningDirty = !!_convLiveReasoning;
        convMarkLive();
    } else {
        _convLivePainter?.stop();
        _convLivePainter = null;
        _convLiveEnd?.();
        // a formatted row's caret rules outrank the switch's, so the row stops being formatted live
        _convLiveEl.closest('.chat-conv-msg')?.classList.remove('is-live-format');
        _convSightGap = true;
    }
    convSyncLiveStatus();
}

// smooth streaming paces the live reply's reveal; switched off mid-reply, what arrived shows at once
function convApplySmoothStreaming() {
    _convPaced = convSwitchOn('chatSmoothStreaming');
    if (!_convPaced) convRevealLiveAll();
}

function convApplyMeasure(ch = convStoredMeasureCh()) {
    const pane = convEls().pane;
    // 'none' is the valid CSS for an uncapped max-width; a bare number here would compute
    // to auto and silently keep the old cap.
    if (pane) pane.style.setProperty('--cl-chat-measure', ch >= MEASURE_FILL ? 'none' : `${ch}ch`);
}

// ========================================
// THE CONVERSATION WINDOW
// ========================================

// centred on x, top-anchored on y: an east or west edge changes the width at twice its travel; mobile pins it
function initConversationWindow() {
    const win = document.getElementById('chatConvWindow');
    if (!win) return;
    const key = 'chatConversation';
    const defaults = CoreAPI.getDefaultWindowGeometry(key);
    CoreAPI.makeFloatingWindow(win, {
        moveHandle: document.getElementById('chatConvHeader'),
        bounds: convEls().pane,
        centered: { x: true, y: false },
        min: { w: 25, h: 30 },
        defaults,
        pinned: () => CoreAPI.isMobileMode(),
        load: () => ({ ...defaults, ...(CoreAPI.getWindowGeometry(key) || {}) }),
        save: (g) => CoreAPI.setWindowGeometry(key, g),
    });
}

// ========================================
// CONVERSATION DRAFTS
// ========================================

const DRAFT_DEBOUNCE_MS = 400;

let _draftTimer = null;
let _draftPending = null;          // { chatId, text } waiting for the debounce
let _draftChain = Promise.resolve(); // writes land in order, even across chats

// the draft is a column on the chat (PATCH {draft}); a failed write keeps the text in the composer
function writeDraft(chatId, text) {
    _draftChain = _draftChain.then(async () => {
        try {
            const resp = await CoreAPI.apiRequest(`/chats/${encodeURIComponent(chatId)}`, 'PATCH', { draft: text || null });
            if (!resp.ok) throw new Error(`server returned ${resp.status}`);
        } catch {
            CoreAPI.showToast('Could not save your draft', 'error');
        }
    });
    return _draftChain;
}

function flushDraft() {
    clearTimeout(_draftTimer);
    const pending = _draftPending;
    _draftPending = null;
    if (pending) void writeDraft(pending.chatId, pending.text);
}

function queueDraftSave(chatId, text) {
    if (!chatId) return;
    _draftPending = { chatId, text };
    clearTimeout(_draftTimer);
    _draftTimer = setTimeout(flushDraft, DRAFT_DEBOUNCE_MS);
}

// only a SUCCESSFUL send clears the draft; a debounced keystroke for the chat is dropped, not written after the clear
function clearDraft(chatId) {
    if (!chatId) return;
    if (_draftPending?.chatId === chatId) { clearTimeout(_draftTimer); _draftPending = null; }
    void writeDraft(chatId, null);
}

// restore the unsent line, cursor at the end; guarded on the chat id, the caller may have moved on
function convRestoreDraft(chatId, input, text) {
    if (!input || _convChatId !== chatId || typeof text !== 'string' || !text) return;
    input.value = text;
    convAutosize(input);
    input.setSelectionRange(text.length, text.length);
}

function convEls() {
    return {
        pane: document.getElementById('chatsConversation'),
        grid: document.getElementById('chatsGrid'),
        grouped: document.getElementById('chatsGroupedView'),
        list: document.getElementById('chatConvMessages'),
        input: document.getElementById('chatConvInput'),
        send: document.getElementById('chatConvSend'),
        stop: document.getElementById('chatConvStop'),
        err: document.getElementById('chatConvError'),
        composer: document.querySelector('.chat-conv-composer'),
    };
}

/** Say which conversation is on screen, for the panels that outlive it; a broadcast, so a later panel just subscribes. */
function announceConvSubject() {
    document.dispatchEvent(new CustomEvent('cl-chat-changed', {
        detail: { chatId: _convChatId, char: _convChar, chatMeta: _convChatMeta },
    }));
}

/**
 * The header's character half (portrait and name), its own function since the card can change while the chat is open.
 * @param {string} [fallbackName] the chat row's stored character name, for a character that could not be resolved
 */
function convPaintCharacterChrome(fallbackName) {
    const title = document.getElementById('chatConvTitle');
    const avatar = document.getElementById('chatConvAvatar');
    if (title) title.textContent = _convChar?.name || fallbackName || 'Chat';
    if (avatar) {
        // Through the thumb helper every time, because it carries the cache-bust token a
        // replaced portrait bumps; a URL captured earlier would show the old image.
        avatar.src = _convChar ? (CoreAPI.getCharacterAvatarSmallThumbUrl(_convChar.id) || '/img/no-portrait.png') : '/img/no-portrait.png';
        avatar.alt = _convChar?.name || '';
    }
}

async function openConversation(chat) {
    // open, or hand the browse chrome back: a failed entry must not leave the list without its search box
    const giveUp = () => { document.documentElement.classList.remove('cl-chat-open'); };
    if (!chat?.id) return giveUp();
    const { pane, grid, grouped, input } = convEls();
    if (!pane) return giveUp();

    // opening over an open chat: tear the old one down first (its stream, its composer line) while its id is current
    if (_convChatId && _convChatId !== chat.id) {
        convAbortGeneration();
        _convStaleWhileBusy = false;
        _convOwedBehindOwn = false;
        convSetBusy(false);
        if (input) { input.value = ''; convAutosize(input); }
    }
    // A budget measured in the previous chat says nothing about this one: cleared here,
    // re-measured by the seed once this chat's history is on screen.
    invalidateBudget();

    // the last chat's waiting pictures are that chat's; the same chat opened again keeps them, as it keeps its draft
    if (_convChatId !== chat.id) {
        _convTray.clear();
        // a place parked in the last chat says nothing of this one
        _convSuspendScroll = null;
        _convLandOnResume = null;
    }
    _convChatId = chat.id;
    // The server answers "what chat is open" (GET /chats/active) from this setting, for the
    // ComfyUI gallery's send-to-Sigma; cleared on close so "nothing open" is honest.
    CoreAPI.setSetting('activeChatId', chat.id);
    _convChar = chat.character || null;
    _convMessages = [];
    _convPickPending.clear();
    _convEditKept.clear();
    _convEditBack = null;
    // Cleared before the first render, or the previous character's map rewrites this
    // character's URLs to media that belongs to someone else.
    _convMediaMap = null;
    // the last chats verdict on its card's book is no answer for this one, which the read below brings
    _convEmbeddedLore = null;
    _convChatMeta = chat.chatMetadata || null;
    // the last chat's own connection and preset say nothing about this one, which the reads below answer
    _convProfileId = null;
    _convOwnProfile = false;
    _convOwnPreset = false;
    _convPresetId = undefined;
    convPaintOwnMarks();
    _convPin.reset();
    announceConvSubject();

    // a list row may not carry its character yet: fetch this ONE and re-announce when it lands
    if (!_convChar && chat.charId) {
        CoreAPI.ensureCharacterById(chat.charId).then(char => {
            if (!char || _convChatId !== chat.id) return;
            _convChar = char;
            chat.character = char;
            convPaintCharacterChrome();
            announceConvSubject();
            void convSyncEmbeddedLoreBadge();
        });
    }

    grid?.classList.add('hidden');
    grouped?.classList.add('hidden');
    disconnectObservers();
    pane.classList.remove('hidden');
    document.getElementById('chatsView')?.classList.add('conv-open');
    // the browse chrome lives outside #chatsView, so a root class reaches it
    document.documentElement.classList.add('cl-chat-open');
    window.pushOverlayGuard?.();

    const sub = document.getElementById('chatConvSub');
    if (sub) {
        sub.textContent = displayChatName(chat);
        // The rename dialog must prefill the REAL name, never the display fallback:
        // renaming a minted chat to its own "Started ..." label would store the label.
        sub.dataset.rawName = chat.name || '';
    }
    convPaintCharacterChrome(chat.charName);

    // resolved server-side, in parallel with the messages; cleared first, like _convMediaMap
    BackgroundPanel.loadWallpaperFor(chat.id, _convChar);

    convApplyMeasure();
    convApplyAmbientMotion();
    convApplySmoothStreaming();
    convApplyStreaming();
    convApplyDisplayOptions();
    convNoteApplied();
    convStartClock();
    convClearError();
    renderConversation([{ _loading: true }]);
    // kicked together, awaited only where needed; convClearError ran BEFORE the profile sync so its error survives
    const profilesReady = syncConvProfiles();
    const personaReady = convSyncPersonaName();
    // only the openers' mark waits on it, so it is never awaited
    void convSyncPreset();
    // handled now, so a rejection is never unhandled if the catch below runs first; the awaits still see it
    profilesReady.catch(() => { /* awaited below */ });
    personaReady.catch(() => { /* awaited below */ });

    try {
        const resp = await CoreAPI.apiRequest(`/chats/${encodeURIComponent(chat.id)}`, 'GET');
        if (!resp.ok) throw new Error(`server returned ${resp.status}`);
        const detail = await resp.json();
        if (_convChatId !== chat.id) return; // user left while it loaded
        _convMessages = Array.isArray(detail.messages) ? detail.messages : [];
        _convUserName = detail.userName || null;
        _convEmbeddedLore = detail.embeddedLorebook || null;
        LorePanel.followEmbedded(chat.id, _convEmbeddedLore);
        void convSyncEmbeddedLoreBadge();
        // Still awaited before the first render: painting ahead of the resolve is how the
        // previous persona's name ends up over every message.
        await personaReady;
        if (_convChatId !== chat.id) return;
        renderConversation(_convMessages);
        convResetPin();
        // not awaited: the history is on screen, and the media pass and the budget seed paint when they land
        convLoadMediaMap(chat.id, _convChar?.id || chat.charId);
        convSeedBudget(chat.id);
        convRestoreDraft(chat.id, input, detail.draft);
        await profilesReady;
        input?.focus();
    } catch (e) {
        // a failed load is an honest error, never an empty chat a send would append onto unseen
        if (_convChatId !== chat.id) return;
        renderConversation(null);
        convShowError(`Could not load this chat: ${e.message}`);
    }
}

/** Which endpoint answers this chat, as the server resolves it: the chat's own, else the default, else the first. */
async function syncConvProfiles() {
    // The button names the connection in its tooltip rather than on the bar.
    const btn = document.getElementById('chatConvConnections');
    const chatId = _convChatId;
    let resolved = null;
    let failed = false;
    try {
        const resp = await CoreAPI.apiRequest(`/llm/profiles/resolve${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''}`, 'GET');
        if (resp.ok) resolved = await resp.json();
        else failed = true;
    } catch { failed = true; }
    if (_convChatId !== chatId) return;

    const openConnections = () => document.getElementById('chatConvConnections')?.click();
    const chosen = resolved?.profile || null;
    if (!chosen) {
        _convProfileId = null;
        // unknown stays unknown: a failed read keeps the mark and the sight as they were
        if (!failed) { _convOwnProfile = false; convPaintOwnMarks(); _convSees = null; convPaintAttach(); }
        // A transient fetch failure is not a setup problem, and telling a configured
        // user their connection is missing reads as data loss.
        if (btn) btn.title = failed ? 'Connections could not be read' : 'No connection configured';
        if (failed) convProfileNote('Could not read the connections.', { label: 'Retry', onAction: () => void syncConvProfiles() });
        else convProfileNote('No connection is configured yet.', { label: 'Add a Connection', onAction: openConnections });
        return;
    }
    const switched = _convProfileId !== null && _convProfileId !== chosen.id;
    _convProfileId = chosen.id;
    _convOwnProfile = resolved.source === 'chat';
    convPaintOwnMarks();
    if (btn) btn.title = `${chosen.model ? `${chosen.name} (${chosen.model})` : chosen.name}${_convOwnProfile ? ', set for this chat only' : ''}`;
    // a connection switch moves the budget (its context size outranks chatMaxContext): re-measure
    if (switched && chatId) convSeedBudget(chatId);
    // the editor's own readiness rule; unread kinds leave it unjudged, since a kind with its own endpoint needs none
    const kinds = await convLlmKinds();
    if (_convChatId !== chatId) return;
    const kindMeta = kinds?.find(k => k.kind === chosen.kind);
    // unread kinds leave the sight not checked, never a no
    _convSees = kinds ? seesPictures(chosen, kindMeta) : null;
    convPaintAttach();
    const r = kindMeta && readinessOf({ baseUrl: chosen.baseUrl, model: chosen.model }, { kindMeta });
    const named = `"${chosen.name || 'Untitled'}"`;
    if (kinds && !kindMeta) {
        convProfileNote(`${named} cannot send: its kind, ${chosen.kind}, is not available (an extension may be switched off).`, { label: 'Open Connections', onAction: openConnections });
    } else if (r && !r.ready) {
        const needs = [r.endpoint === 'missing' && 'an endpoint', r.model === 'missing' && 'a model'].filter(Boolean).join(' and ');
        convProfileNote(`${named} cannot send yet: it needs ${needs}.`, { label: 'Finish Setting It Up', onAction: openConnections });
    } else {
        convClearProfileNote();
    }
}

/** Which preset builds this chat's prompt, as the server resolves it; only the mark and the budget follow it here. */
async function convSyncPreset() {
    const chatId = _convChatId;
    if (!chatId) return;
    let resolved = null;
    try {
        const resp = await CoreAPI.apiRequest(`/presets/resolve?chatId=${encodeURIComponent(chatId)}`, 'GET');
        resolved = resp.ok ? await resp.json() : null;
    } catch { /* unknown stays unknown: the mark keeps its state until the next read */ }
    if (!resolved || _convChatId !== chatId) return;
    const switched = _convPresetId !== undefined && _convPresetId !== resolved.presetId;
    _convPresetId = resolved.presetId;
    _convOwnPreset = resolved.source === 'chat';
    convPaintOwnMarks();
    const btn = document.getElementById('chatConvPrompts');
    if (btn) btn.title = _convOwnPreset ? 'Prompt manager (a preset set for this chat only)' : 'Prompt manager';
    // the preset's own blocks are part of what the budget measures
    if (switched) convSeedBudget(chatId);
}

// a chat that answers on its own connection or preset says so on their openers, and on a phone on the menu holding them
function convPaintOwnMarks() {
    document.getElementById('chatConvConnections')?.classList.toggle('is-marked', _convOwnProfile);
    document.getElementById('chatConvPrompts')?.classList.toggle('is-marked', _convOwnPreset);
    convPaintCardMark();
}

// read at every sync, never kept: an extension switched on or off adds or takes a kind; null leaves the connection unjudged
async function convLlmKinds() {
    try {
        const resp = await CoreAPI.apiRequest('/llm/kinds', 'GET');
        const data = resp.ok ? await resp.json() : null;
        const list = Array.isArray(data) ? data : data?.kinds;
        return Array.isArray(list) && list.length ? list.map(k => (typeof k === 'string' ? { kind: k } : k)).filter(k => k?.kind) : null;
    } catch {
        return null;
    }
}

// the connection banner: shown and cleared by syncConvProfiles alone, never over an error something else raised since
function convProfileNote(message, action) {
    convShowError(message, action);
    _convProfileNote = message;
}

function convClearProfileNote() {
    const { err } = convEls();
    if (_convProfileNote && err && !err.classList.contains('hidden') && err.textContent.startsWith(_convProfileNote)) convClearError();
    _convProfileNote = null;
}

function closeConversation() {
    if (!isConversationOpen()) return;
    convAbortGeneration();
    _convStaleWhileBusy = false;
    _convOwedBehindOwn = false;
    // Leaving takes the dropdown and its capture listener with it, rather than parking
    // them in the hidden composer until the next document click cleans up.
    convCloseOptions();
    _convChatId = null;
    CoreAPI.setSetting('activeChatId', null);
    _convChar = null;
    _convMessages = [];
    _convPickPending.clear();
    _convEditKept.clear();
    _convEditBack = null;
    // the closed chat's row elements leave with it rather than staying reachable through the cache
    _convRowCache = new Map();
    _convMediaMap = null;
    _convEmbeddedLore = null;
    _convPersonaId = null;
    _convPersonaAvatarId = null;
    _convPersonaPronouns = null;
    _convProfileId = null;
    _convOwnProfile = false;
    _convOwnPreset = false;
    _convPresetId = undefined;
    convPaintOwnMarks();
    _convPin.reset();
    _convSuspended = false;
    _convUnseen = false;
    _convSuspendScroll = null;
    _convLandOnResume = null;
    convSyncViewBadge();
    BackgroundPanel.clearWallpaper();
    document.getElementById('chatConvLore')?.classList.remove('has-embedded-lore');
    announceConvSubject();
    convStopClock();

    const { pane, list, input } = convEls();
    pane?.classList.add('hidden');
    document.getElementById('chatsView')?.classList.remove('conv-open');
    document.documentElement.classList.remove('cl-chat-open');
    if (list) list.innerHTML = '';
    if (input) input.value = '';
    convClearError();

    // Rebuild the grid rather than un-hiding it: layout, lens, sort and the
    // active search term may all have changed while the conversation was open.
    renderChats();
}

// leaving the chats view PARKS the conversation (the stream keeps going); closeConversation is the real teardown
let _convSuspended = false;
let _convUnseen = false;
let _convSuspendScroll = null;
// a reply that landed while parked, landed on the return
let _convLandOnResume = null;

function suspendConversation() {
    if (!isConversationOpen() || _convSuspended) return;
    _convSuspended = true;
    // Same reason closeConversation does it: the dropdown's capture listener must not
    // park in the hidden composer until the next document click.
    convCloseOptions();
    // display:none drops scrollTop: capture an unpinned reader's place; a pinned one re-pins on resume
    _convSuspendScroll = _convPin.pinned() ? null : _convPin.place();
    if (_convLiveEl?.isConnected) _convSightGap = true;
    document.documentElement.classList.remove('cl-chat-open');
    convSyncViewBadge();
}

function resumeConversation() {
    if (!isConversationOpen() || !_convSuspended) return;
    _convSuspended = false;
    _convUnseen = false;
    document.documentElement.classList.add('cl-chat-open');
    convSyncViewBadge();
    // whatever streamed in while parked lands in one paint, and the stamps catch up in one tick
    convScheduleLivePaint();
    convTickClock();
    requestAnimationFrame(() => {
        if (_convSuspended || !isConversationOpen()) return;
        const land = _convLandOnResume?.chatId === _convChatId ? _convLandOnResume : null;
        _convLandOnResume = null;
        if (_convSuspendScroll == null) {
            if (land) convLandReplyStart(land.seq, land.seen, { now: true });
            // a reply still under way opened past what the reader saw (its paint did it) is left there
            else if (_convPin.pinned()) convScrollToEnd();
        } else _convPin.follow(_convSuspendScroll);
        _convSuspendScroll = null;
    });
}

// the toggles carry the parked chat's state: breathing while generating, steady once a reply landed unseen
function convSyncViewBadge() {
    const live = _convSuspended && !!_convAbort;
    const unseen = _convSuspended && _convUnseen;
    const btns = document.querySelectorAll('.view-toggle-btn[data-view="chats"], .mobile-bottom-nav-tab[data-view="chats"]');
    for (const btn of btns) {
        btn.classList.toggle('cl-chat-live', live);
        btn.classList.toggle('cl-chat-unseen', !live && unseen);
    }
}

// never nulls _convAbort, the in-flight gate: the aborted run still tears down, and clearing it let a reroll race in
function convAbortGeneration() {
    if (_convAbort) { try { _convAbort.abort(); } catch { /* already done */ } }
    // what arrived shows at once, a paced reveal's backlog and its catch-up included
    convRevealLiveAll();
    // a send waiting on its filter is abandoned too: nothing posts, the line stays in the box
    if (_convSendWait) { _convSendWait.abandoned = true; convReleaseSendWait(); }
}

// An error that names a fix OFFERS it; the action is optional.
function convShowError(message, action = null) {
    const { err } = convEls();
    if (!err) return;
    err.textContent = message;
    if (action?.label) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cl-cwin-btn-text chat-conv-error-act';
        b.textContent = action.label;
        b.addEventListener('click', action.onAction);
        err.appendChild(b);
    }
    err.classList.remove('hidden');
}

function convClearError() {
    const { err } = convEls();
    if (!err) return;
    err.textContent = '';
    err.classList.add('hidden');
}

// the shared scroll pin (ai-panel.js); the chat adds its jump pill and a writer coalescing a stream's paints to one a frame
const _convPin = scrollPin('chatConvMessages', { rows: '.chat-conv-msg' });
let _convScrollRaf = 0;
let _convScrollNews = false;
let _convMissedWhileAway = false;
// the pin's own band: a reader let go closer to the end than this sees it already, news and all
const CONV_PILL_BELOW_PX = 48;

function convSyncJumpPill() {
    const pill = document.getElementById('chatConvJump');
    if (!pill) return;
    const list = document.getElementById('chatConvMessages');
    // on a phone the pill sits over the last reply's controls and an editor's Save: never inside the band, never while one is open
    const away = !_convPin.pinned() && !convEditorHolds() && (!list || list.scrollHeight - list.scrollTop - list.clientHeight > CONV_PILL_BELOW_PX);
    pill.classList.toggle('hidden', !away);
    pill.classList.toggle('has-new', away && _convMissedWhileAway);
}

// one scroll per frame, the pin asked again when it runs; a QUIET call follows without news for the pill
function convScrollToEnd({ quiet = false, now = false } = {}) {
    if (!_convPin.pinned()) {
        if (!quiet) _convMissedWhileAway = true;
        // a quiet re-read or a picture loading moves the end the pill reads too
        convSyncJumpPill();
        return;
    }
    if (!quiet) _convScrollNews = true;
    cancelAnimationFrame(_convScrollRaf);
    const pin = () => {
        const news = _convScrollNews;
        _convScrollNews = false;
        // the reader's intent can land between scheduling and running
        if (!_convPin.pinned()) {
            if (news) _convMissedWhileAway = true;
            convSyncJumpPill();
            return;
        }
        // a finger on the list holds it; its lift catches up
        _convPin.follow();
    };
    // a paint already in its frame pins in it: a frame later drew every new line past the bottom first
    if (now) pin();
    else _convScrollRaf = requestAnimationFrame(pin);
}

// the landing's own frame, never the pin's: a quiet pin after a re-read cancelled the shared one and pinned the end
let _convLandRaf = 0;

// a finished reply opens at its top or the last line the reader saw, or at the end when the rest fits
function convLandReplyStart(seq, seen = '', { now = false } = {}) {
    // a reader scrolled away keeps their place, told by the jump pill
    if (!_convPin.pinned()) { convScrollToEnd(); return; }
    // a parked list has no layout to measure: the landing waits for the return
    if (_convSuspended) { _convLandOnResume = { chatId: _convChatId, seq, seen }; return; }
    const { list } = convEls();
    if (!list || !Number.isInteger(seq) || !convRowEl(seq)) { convScrollToEnd(); return; }
    cancelAnimationFrame(_convLandRaf);
    const chatId = _convChatId;
    const land = () => {
        _convLandRaf = 0;
        // found again by its seq: a re-read before the frame rebuilt the row; a chat opened meanwhile is another transcript
        const row = _convChatId === chatId ? convRowEl(seq) : null;
        if (!row) return;
        const text = seen ? row.querySelector('.chat-conv-msg-text') : null;
        convLandAt(list, text ? convRowTop(row, text, convSeenAtSettled(text, seen, seq)) : convRowTop(row));
    };
    if (now) land();
    else _convLandRaf = requestAnimationFrame(land);
}

// the reply under way, back in sight, opened past the last line the reader saw before they looked away (its top when none)
function convLandLive(seenAt) {
    const { list } = convEls();
    const row = _convLiveEl?.closest('.chat-conv-msg');
    if (!list || !row) return;
    if (!_convPin.pinned()) { convScrollToEnd({ now: true }); return; }
    convLandAt(list, seenAt === null ? convRowTop(row) : convRowTop(row, _convLiveEl, seenAt));
}

// the list opened at top unless the rest fits; the reader unpinned so the rest waits below the jump pill
function convLandAt(list, top) {
    // the rest fits: the end, which a finger resting on the list catches up to when it lifts; following there, nothing is missed
    if (convRestFits(list, top)) {
        if (_convPin.pinned()) _convMissedWhileAway = false;
        convScrollToEnd({ quiet: true, now: true });
        return;
    }
    // a pin queued before (a return's) would pull the reader past what they are about to read
    cancelAnimationFrame(_convScrollRaf);
    // a finger on the list keeps it where held, the lift kept off the end
    _convPin.land(top);
}

// the rest of the list from `top` fits the view: landing there is landing at the end
function convRestFits(list, top) {
    return top >= list.scrollHeight - list.clientHeight - 1;
}

// an alternate shown in place (paged or added) opens as a finished reply does: at its first line, or the end when the rest fits
function convLandAlternate(seq) {
    const { list } = convEls();
    const row = convRowEl(seq);
    if (!list || !row) return;
    const top = Math.min(list.scrollTop, convRowTop(row));
    // the reader's own verb: at the end they follow again, however they had left (a long alternate paged back to a short one)
    if (convRestFits(list, top)) convResetPin();
    else convLandAt(list, top);
}

// the scroll putting a row's top (its own margin above it), or a line `at` down its text, at the top of the view
function convRowTop(row, text = null, at = 0) {
    if (!text) return Math.max(0, row.offsetTop - (parseFloat(getComputedStyle(row).marginTop) || 0));
    // the measures are the zoomed screen's, the scroll is the layout's
    const zoom = parseFloat(document.body.style.zoom) || 1;
    return Math.max(0, row.offsetTop + (text.getBoundingClientRect().top - row.getBoundingClientRect().top + at) / zoom);
}

// the top of an element's last line of shown text, from its own top; the pill copy is a pseudo-element, never counted
function convLastLineTop(el) {
    let last = null;
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.nodeValue.trim()) last = n;
    if (!last) return 0;
    // text folded in a shut disclosure shows as its summary, and a range still gives it line boxes, so the summary is read
    let shown = last;
    for (let p = last.parentElement; p && p !== el; p = p.parentElement) {
        if (p.tagName !== 'DETAILS' || p.open) continue;
        const summary = p.querySelector(':scope > summary');
        if (!summary?.contains(last)) shown = summary || p;
    }
    const range = document.createRange();
    range.selectNodeContents(shown);
    const lines = range.getClientRects();
    return lines.length ? lines[lines.length - 1].top - el.getBoundingClientRect().top : 0;
}

// the least scroll bringing `el` whole into view (scrollIntoView's 'nearest'), written through the pin
function convRevealNearest(el) {
    const { list } = convEls();
    if (!list) return;
    // the measures are the zoomed screen's, the scroll is the layout's
    const zoom = parseFloat(document.body.style.zoom) || 1;
    const view = list.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const above = (box.top - view.top) / zoom;
    const below = (box.bottom - view.bottom) / zoom;
    if (above < 0) _convPin.put(list.scrollTop + above);
    else if (below > 0) _convPin.put(list.scrollTop + Math.min(above, below));
}

// the last line the reader saw, before the paint that writes past it; null when none of the reply was shown
function convLiveSeenAt() {
    return _convLiveShownText.trim() && _convLiveEl?.isConnected ? convLastLineTop(_convLiveEl) : null;
}

// where the text the reader saw ends in a settled row: laid out as the row lays it out, since the live row's markup differed
function convSeenAtSettled(text, seen, seq) {
    const probe = text.cloneNode(false);
    // formatted as it streams: a code box or an island the reader left mid-way is laid out as the settled row shows it
    probe.innerHTML = convRenderText(convLocalizeText(seen), _convChar?.name || '', { ...convRowRenderOpts(seq), streaming: 'live' });
    probe.style.cssText = `position: absolute; visibility: hidden; box-sizing: border-box; width: ${text.getBoundingClientRect().width}px`;
    text.after(probe);
    // the copy keeps its first block's top margin, which the row collapses: measured from that block, both agree
    const lead = (el) => (el.firstElementChild ? el.firstElementChild.getBoundingClientRect().top - el.getBoundingClientRect().top : 0);
    const at = convLastLineTop(probe) - lead(probe) + lead(text);
    probe.remove();
    return at;
}

// after a re-read a kept turn lands as a finished reply would, a reader away kept where they were (`away`, read before it)
function convLandReread(seen, kept, away) {
    if (Number.isFinite(away)) {
        // given back, or held until the list can reach it again (the re-read without the kept turn clamped it)
        _convPin.follow(away);
        convScrollToEnd();
        return;
    }
    const last = _convMessages[_convMessages.length - 1];
    if (kept && seen !== null && last && !last.raw?.is_user) convLandReplyStart(last.seq, seen);
    else convScrollToEnd({ quiet: true });
}

// the place of a reader away from the end, held before a re-read can clamp it; null for one at the end
function convPlaceAway() {
    _convPin.keep();
    return _convPin.pinned() ? null : _convPin.place();
}

// back to the end and following: a send, a generation, a chat opened, the jump to the latest
function convResetPin() {
    _convMissedWhileAway = false;
    // a landing queued for its frame would pull the reader back off the end they asked for
    cancelAnimationFrame(_convLandRaf);
    _convLandRaf = 0;
    _convPin.pin();
    convSyncJumpPill();
    // and again once what the verb renders this frame is laid out
    convScrollToEnd({ quiet: true });
}

// bring one message into view and mark it, after the frame where the open queued its own scroll to the end
async function convRevealMessage(seq) {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const row = convRowEl(seq);
    const { list } = convEls();
    if (!row || !list) return false;
    // centred, and let go so a stream does not pull the reader past it
    _convPin.land(Math.max(0, row.offsetTop - (list.clientHeight - row.offsetHeight) / 2));
    row.classList.remove('is-revealed');
    void row.offsetWidth;
    row.classList.add('is-revealed');
    setTimeout(() => row.classList.remove('is-revealed'), 2000);
    return true;
}

// ========================================
// CONVERSATION ROW ACTIONS
// ========================================

function convIndexOfSeq(seq) {
    return _convMessages.findIndex(e => e.seq === seq);
}

function convEntryAtSeq(seq) {
    return _convMessages[convIndexOfSeq(seq)] ?? null;
}

// the entry with another stored row, its text with it: what a verb shows while its write is out
function convWithRaw(entry, raw) {
    return { ...entry, content: typeof raw?.mes === 'string' ? raw.mes : '', raw };
}

// the message a verb acts on: the one the reader acted on (by id) wherever it is now, else whatever is at seq; -1 if gone
function convIndexOfShown(seq, messageId) {
    return Number.isInteger(messageId) ? _convMessages.findIndex(e => e.id === messageId) : convIndexOfSeq(seq);
}

// what the page shows of a message, as a write names it: the active alternate's place, the alternates counted, its text
function convShownOf(raw) {
    const swipes = Array.isArray(raw?.swipes) ? raw.swipes : [];
    const index = swipes.length ? Math.min(Math.max(Number.isInteger(raw.swipe_id) ? raw.swipe_id : 0, 0), swipes.length - 1) : 0;
    const text = swipes.length ? swipes[index] : raw?.mes;
    return { index, count: swipes.length || 1, text: typeof text === 'string' ? text : '' };
}

// the message id a row carries (data-mid), null for the streaming bubble, which is no message yet
function convMidOf(el) {
    const n = Number(el?.dataset?.mid);
    return Number.isInteger(n) && n > 0 ? n : null;
}

// every row verb mutates history: none mid-stream or while a send waits on its filter; every door asks this gate
function convRowActionsLocked() {
    return !!_convAbort || _convSending;
}

function convOnRowAction(e) {
    // The portrait is the gallery's entry point, the way it is everywhere else in the app.
    if (e.target.closest('.chat-conv-msg-avatar-frame')) {
        const row = e.target.closest('.chat-conv-msg');
        if (row && !row.classList.contains('user')) { convOpenGallery(); return; }
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    // Reads the DOM and mutates nothing, so it needs no seq and stays live mid-stream,
    // unlike every other action below it.
    if (btn.dataset.act === 'copy-code') return convCopyCode(btn);
    if (btn.dataset.act === 'picture') return convOpenPicture(btn);
    const seq = Number(btn.dataset.seq);
    if (!Number.isInteger(seq)) return;
    if (convRowActionsLocked()) return;
    // On touch the overflow opens as a real bottom sheet.
    if (btn.dataset.act === 'more' && CoreAPI.isMobileMode()) {
        return convOpenRowActionSheet(btn.closest('.chat-conv-msg'), seq);
    }
    if (btn.dataset.act === 'more') {
        const row = btn.closest('.chat-conv-msg');
        const wasOpen = row?.classList.contains('actions-open');
        convEls().list?.querySelectorAll('.chat-conv-msg.actions-open')
            .forEach(el => el.classList.remove('actions-open'));
        if (!wasOpen) row?.classList.add('actions-open');
        return undefined;
    }
    return convRunRowAction(btn.dataset.act, seq, btn, convMidOf(btn.closest('.chat-conv-msg')));
}

// messageId: the message the row showed where the reader acted (its data-mid)
function convRunRowAction(act, seq, btn, messageId = null) {
    if (act.startsWith('ext:')) {
        const entry = _convMessages[convIndexOfShown(seq, messageId)] ?? null;
        return extRunAction(act.slice(4), convActionContext({ seq: entry?.seq ?? seq, messageId: entry?.id ?? null, message: entry?.raw ?? null }));
    }
    switch (act) {
        case 'edit': return convBeginEdit(seq, messageId);
        case 'copy': return convCopyMessage(seq);
        case 'delete': return convDeleteMessage(seq, messageId);
        case 'branch': return convBranchFrom(seq, messageId);
        case 'regenerate': return convGenerate({ regenerate: true });
        case 'continue-here': return convGenerate({ mode: 'continue', targetSeq: seq, targetId: messageId });
        case 'hide': return convToggleHidden(seq, messageId);
        case 'swipe': return convSwipe(seq, Number(btn?.dataset.dir) || 1, messageId);
        case 'combine': return convOpenCombiner(seq, messageId);
        default: return undefined;
    }
}

// the sheet is built FROM the row's overflow buttons, so the two surfaces cant drift
function convOpenRowActionSheet(row, seq) {
    // the band's edit and regenerate are hidden at phone width, so the sheet carries them (edit first)
    convEnsureRowActions(row);
    const verbs = [...(row?.querySelectorAll('.chat-conv-msg-actions [data-act="edit"], .chat-conv-msg-actions [data-act="regenerate"], .chat-conv-msg-overflow [data-act]') || [])];
    if (!verbs.length) return;
    const sheet = CoreAPI.createMobileSheet();
    if (!sheet) return;
    // insertAdjacentHTML, never innerHTML: the builder appends the drag handle first, and
    // assigning innerHTML deletes it.
    sheet.sheet.insertAdjacentHTML('beforeend', `<div class="mobile-sheet-group-title">Message</div>` + verbs
        .map(b => `<button type="button" class="dropdown-item${b.dataset.act === 'delete' ? ' danger' : ''}"
            data-sheet-act="${b.dataset.act}" data-seq="${seq}">
            ${b.querySelector('i')?.outerHTML || ''}<span>${CoreAPI.escapeHtml(b.title)}</span></button>`).join(''));
    // the message the row showed as the sheet opened: the transcript may be re-read while it is open
    const messageId = convMidOf(row);
    sheet.sheet.addEventListener('click', (e) => {
        const item = e.target.closest('[data-sheet-act]');
        if (!item) return;
        sheet.close();
        // the delegated handler's gate: a stream or a send waiting on its filter may start while the sheet is open
        if (convRowActionsLocked()) return;
        convRunRowAction(item.dataset.sheetAct, Number(item.dataset.seq), item, messageId);
    });
    sheet.open();
}

// A portrait click opens the gallery WINDOW rather than the full-screen viewer, beside the transcript.
function convOpenGallery() {
    if (!_convChar?.id) return;
    GalleryPanel.togglePanel({ char: _convChar, chatId: _convChatId });
}

// ctx carries a media id from a gallery image, so the picker opens on that picture
function convOpenBackground(ctx = {}) {
    BackgroundPanel.togglePanel({ char: _convChar, chatId: _convChatId, ...ctx });
}

// these four change how a message is PARSED, so the transcript is re-emitted; every other setting patches in place
const SETTINGS_RERENDER = new Set(['chatQuoteFamilies', 'chatRepairEmphasis', 'chatEscapeStrings', 'chatRenderHtml']);

// a persona change moves the name and picture over messages already shown, so the transcript is re-emitted
function convOpenPersonas() {
    PersonasPanel.togglePanel({
        chatId: _convChatId,
        // a write that leaves the name and picture in force as they were (a description, a bound
        // lorebook, another persona's picture) rebuilds nothing
        onChange: convFollowPersona,
    });
}

// this chat's own card texts; its menu row is marked while the chat holds any, so a divergence is never silent
function convOpenCardTexts() {
    CardTextsPanel.togglePanel({ chatId: _convChatId, charId: _convChar?.id || null, onChange: () => convFollowChatMeta({ followWindow: false }) });
}

// the options button wears the dot of the marked row it holds, as More does for a marked opener
function convPaintCardMark() {
    // on a phone the Connections and Prompts tiles live in this menu, so their marks are its own too
    const tiles = CoreAPI.isMobileMode() && (_convOwnProfile || _convOwnPreset);
    document.getElementById('chatConvOptions')?.classList.toggle('is-marked', CardTextsPanel.holdsOwnTexts(_convChatMeta) || tiles);
}

// the open chat's stored metadata, read again (a write here or elsewhere, a reply's commit)
async function convFollowChatMeta({ followWindow = true } = {}) {
    const chatId = _convChatId;
    let meta = null;
    try {
        const resp = await CoreAPI.apiRequest(`/chats/${encodeURIComponent(chatId)}?msgTail=1`, 'GET');
        const row = resp.ok ? await resp.json() : null;
        if (!row || _convChatId !== chatId) return;
        _convChatMeta = row.chatMetadata || null;
        meta = row.chatMetadata || {};
        convPaintCardMark();
    } catch { /* the mark keeps its state until the next read */ }
    // the window follows this read rather than making its own, and quietly (a reply writes the metadata everytime)
    if (followWindow) await CardTextsPanel.followStored(meta, chatId);
}

// settings the open conversation applies on the spot; the panel, the menu's switches and another tab run the same applier
const CONV_SETTING_KEYS = Object.freeze(['chatStreaming', 'chatAmbientMotion', 'chatSmoothStreaming', 'chatBodyLayout', 'chatMessageFill', 'chatDisplayMode', 'chatShowAvatars', 'chatShowTimestamps', 'chatShowMeta', 'chatExpandActions', 'chatReasoningDefaultOpen', 'chatMeasureCh', 'chatMaxContext', 'chatReserveForReply', ...SETTINGS_RERENDER]);
// each key's value as the open conversation last applied it (set at the open and by every apply)
let _convApplied = new Map();
const convSettingValue = (key) => JSON.stringify(CoreAPI.getSetting(key) ?? null);
function convNoteApplied() {
    _convApplied = new Map(CONV_SETTING_KEYS.map(k => [k, convSettingValue(k)]));
}

function convApplySettingKey(key) {
    convApplySettingKeys([key], { written: true });
}

// one pass: each display key's applier, one rebuild for the parse keys, one budget seed for the budget keys
function convApplySettingKeys(keys, { written = false } = {}) {
    for (const key of keys) _convApplied.set(key, convSettingValue(key));
    const has = (...ks) => ks.some(k => keys.includes(k));
    if (has('chatAmbientMotion')) convApplyAmbientMotion();
    if (has('chatSmoothStreaming')) convApplySmoothStreaming();
    if (has('chatStreaming')) convApplyStreaming();
    if (has('chatBodyLayout', 'chatMessageFill', 'chatDisplayMode', 'chatShowAvatars', 'chatShowTimestamps', 'chatShowMeta', 'chatExpandActions')) convApplyDisplayOptions();
    // after the stamp, since a patch reads it (the clock skips a pane whose stamps are off)
    for (const key of keys) TOGGLE_PATCHES[key]?.(convSwitchOn(key));
    // reading the effect while you drag is why this moved here, so it applies on the spot
    if (has('chatMeasureCh')) convApplyMeasure();
    // this tab's own write flushes first (the save is debounced, and the seed asks the server); another tab's is stored
    if (has('chatMaxContext', 'chatReserveForReply')) {
        if (written) CoreAPI.flushSettings().then(() => convSeedBudget(_convChatId));
        else convSeedBudget(_convChatId);
    }
    if (keys.some(k => SETTINGS_RERENDER.has(k))) convRebuildRows();
}

function convOpenSettings() {
    SettingsPanel.togglePanel({ onChange: convApplySettingKey });
}

// copies the SOURCE, not the rendered text: the reader may paste it where it formats too
async function convCopyMessage(seq) {
    const i = convIndexOfSeq(seq);
    if (i === -1) return;
    if (await CoreAPI.copyTextToClipboard(getMessageDisplayText(_convMessages[i].raw) || '')) CoreAPI.showToast('Message copied', 'success');
    else CoreAPI.showToast('Could not copy the message', 'error');
}

/** Hide keeps a message on screen but out of the prompt; the flag rides its extra, the server honours it at assembly. */
async function convToggleHidden(seq, messageId = null) {
    const i = convIndexOfShown(seq, messageId);
    if (i === -1) return;
    const entry = _convMessages[i];
    const raw = { ...entry.raw, extra: { ...(entry.raw.extra || {}) } };
    const hiding = !raw.extra.hidden;
    if (hiding) raw.extra.hidden = true;
    else delete raw.extra.hidden;
    const next = convWithRaw(entry, raw);
    _convMessages[i] = next;
    convReplaceMessage(next);
    invalidateBudget();
    try {
        // the ONE leaf, never the screen's bag: extra merges server-side, where interrupted, reasoning and usage land
        convAdoptStored(entry.seq, await convPersistMessage(entry.seq, { extra: { hidden: hiding ? true : null } }, entry.id), next);
    } catch (err) {
        CoreAPI.showToast(err?.stale ? `Not ${hiding ? 'hidden' : 'shown again'}: ${err.message}` : 'Shown as hidden here, but it could not be saved', 'warning');
    }
}

// copies the <code> text only; the glyph lives in the sibling header so it isnt copied along
async function convCopyCode(btn) {
    const code = btn.closest('.cl-code-block')?.querySelector('code');
    if (!code) return;
    if (!(await CoreAPI.copyTextToClipboard(code.textContent || ''))) {
        CoreAPI.showToast('Could not copy the code', 'error');
        return;
    }
    const icon = btn.querySelector('i');
    if (icon) {
        icon.className = 'fa-solid fa-check';
        setTimeout(() => { icon.className = 'fa-solid fa-copy'; }, 1500);
    }
    CoreAPI.showToast('Code copied', 'success');
}

// convPersistMessage's answer when the reader left the chat mid-write: every adopter drops it
const CONV_LEFT = Symbol('conv-left');

/** The stored row is the truth: when it differs from what the screen shows, the screen takes it. Answers the held entry. */
function convAdoptStored(seq, stored, shown) {
    if (stored === CONV_LEFT || !stored || typeof stored !== 'object') return shown;
    const i = convIndexOfShown(seq, stored.id);
    if (i === -1) return shown;
    if (shown && JSON.stringify(stored) === JSON.stringify(shown)) return shown;
    _convMessages[i] = stored;
    convReplaceMessage(stored);
    return stored;
}

/**
 * Persist a patch of one message's fields and answer it as stored, null, or CONV_LEFT if the reader left meanwhile.
 * @param {number|null} messageId the message the reader acted on; another at that seq refuses the write
 * @returns {Promise<Object|null|symbol>}
 */
async function convPersistMessage(seq, message, messageId) {
    const chatId = _convChatId;
    const patch = await CoreAPI.apiRequest(
        `/chats/${encodeURIComponent(chatId)}/messages/${seq}?messageId=${Number.isInteger(messageId) ? messageId : ''}`, 'PATCH', message);
    return convStoredAnswer(patch, chatId, 'nothing was saved');
}

/** A message write's answer: the row as stored, null, or CONV_LEFT; a refusal throws, the transcript read again (unwritten: what the error says). */
async function convStoredAnswer(resp, chatId, unwritten) {
    const body = resp.ok ? await resp.json().catch(() => null) : null;
    if (_convChatId !== chatId) return CONV_LEFT;
    if (resp.ok) return body?.message && typeof body.message === 'object' ? body.message : null;
    // 409: another message holds the seq, or its alternates moved; 404: past the end. nothing written, so read the truth again
    if (resp.status === 404 || resp.status === 409) {
        // the notice on screen described the rows about to be replaced; the caller's toast is the new word
        convClearError();
        await convRereadOrOwe();
        throw Object.assign(new Error(`that message changed since it was shown; ${unwritten}`), { stale: true, status: resp.status });
    }
    throw new Error(`server returned ${resp.status}`);
}

// an editor's typing a stale Save refused, per message id: it comes back when the editor reopens there; emptied on open and close
const _convEditKept = new Map();
// the follow the first open editor took, given back when the last one closes (the pin's leave answers it)
let _convEditBack = null;

// an open editor holds the reader's place; one a rebuild took without its close (a stream that failed) is gone as a saved one is
function convEditorHolds() {
    if (_convEditBack !== null && !convEditorOpen()) {
        const back = _convEditBack;
        _convEditBack = null;
        back();
    }
    return _convEditBack !== null;
}

// an editor closed or taken by its row's swap (a hide, a stored copy): the last one gives back the first one's follow
function convEditorGone(editor, restore = () => {}, { undone = false } = {}) {
    const last = ![...(convEls().list?.querySelectorAll('.chat-conv-edit') || [])].some(e => e !== editor);
    const back = last ? _convEditBack : null;
    if (last) _convEditBack = null;
    // asked before the text comes back and after: a box shorter than the text clamped the reader onto the end, a taller held it off
    back?.(undone);
    restore();
    back?.(undone);
    // a follower given the end back catches up with what came back below
    if (_convPin.pinned()) convScrollToEnd({ quiet: true, now: true });
    convSyncJumpPill();
    convPayOwedRebuild();
}

function convBeginEdit(seq, messageId = null) {
    const i = convIndexOfShown(seq, messageId);
    const row = i === -1 ? null : convRowEl(_convMessages[i].seq);
    if (!row || row.querySelector('.chat-conv-edit')) return;
    const holder = row.querySelector('.chat-conv-msg-body');
    if (!holder) return;

    // the message and the alternate the editor opened on, which its save names however long the typing takes
    const shownId = _convMessages[i].id;
    const shown = convShownOf(_convMessages[i].raw);
    const original = getMessageDisplayText(_convMessages[i].raw) || '';
    // editing IS holding your place: unpin, or a pinned transcript keeps yanking to the end under the editor
    const back = _convPin.leave();
    // the last editor to close gives back the first one's follow, taken before any place was held
    if (!convEditorOpen()) _convEditBack = back;
    holder.insertAdjacentHTML('beforeend', `
        <div class="chat-conv-edit">
            <textarea class="chat-conv-edit-input" spellcheck="true"></textarea>
            <div class="chat-conv-edit-actions">
                <button class="cl-cwin-btn-text" data-edit="cancel">Cancel</button>
                <button class="cl-cwin-btn-text is-primary" data-edit="save"><i class="fa-solid fa-check"></i> Save</button>
            </div>
        </div>`);
    row.classList.add('editing');
    const box = holder.querySelector('.chat-conv-edit-input');
    const wrap = holder.querySelector('.chat-conv-edit');
    box.value = original;
    // a Save refused as stale kept the typing; it comes back over the message as it now stands, which this editor names
    if (_convEditKept.has(shownId)) { box.value = _convEditKept.get(shownId); _convEditKept.delete(shownId); }
    // fit once the box has its real width; freeze keeps the measure's collapse from clamping the transcript's scroll
    const fit = () => CoreAPI.fitTextarea(box, { freeze: wrap });
    requestAnimationFrame(() => {
        fit();
        // a focus that keeps the list still keeps the box still too: it is scrolled to its caret at the end here
        box.scrollTop = box.scrollHeight;
        // once, at open: on a long message the box bottom and save row can land below the fold
        convRevealNearest(wrap);
    });
    box.addEventListener('input', fit);
    box.focus({ preventScroll: true });
    box.setSelectionRange(box.value.length, box.value.length);

    // a Cancel, a Save of nothing changed or one refused: the message stands as it was, so the close undoes the edit
    const close = () => convEditorGone(holder.querySelector('.chat-conv-edit'), () => {
        row.classList.remove('editing');
        holder.querySelector('.chat-conv-edit')?.remove();
    }, { undone: true });
    holder.querySelector('[data-edit="cancel"]').addEventListener('click', close);
    holder.querySelector('[data-edit="save"]').addEventListener('click', async () => {
        const text = box.value;
        if (text === original) { close(); return; }
        // landed, or refused as stale: the editor closes, and its owed re-read shows the message as stored
        if (await convSaveEdit(seq, text, shownId, shown)) close();
    });
}

/** Write an edit into the ACTIVE alternate and mes, named as the editor opened on it; true when it landed, 'stale' when refused as stale. */
async function convSaveEdit(seq, text, messageId = null, shown = null) {
    const i = convIndexOfShown(seq, messageId);
    if (i === -1) {
        CoreAPI.showToast('Could not save the edit: that message is no longer in the chat', 'error');
        return false;
    }
    const entry = _convMessages[i];
    const raw = { ...entry.raw };
    if (Array.isArray(raw.swipes) && raw.swipes.length > 1) {
        const active = Math.min(raw.swipe_id ?? 0, raw.swipes.length - 1);
        raw.swipes = raw.swipes.slice();
        raw.swipes[active] = text;
    }
    raw.mes = text;
    const next = convWithRaw(entry, raw);
    try {
        // the text alone, beside the alternate it replaces as shown: the server refuses another one active, so a stale page rewrites nothing
        const stored = await convPersistMessage(entry.seq, { mes: text, shown: shown ?? convShownOf(entry.raw) }, entry.id);
        convAdoptStored(entry.seq, stored ?? next, entry);
        return stored !== CONV_LEFT;
    } catch (err) {
        if (err?.stale) {
            // nothing written over an alternate never shown; a message still there keeps the typing for its editor's next open
            if (err.status === 404) CoreAPI.showToast('That message is no longer in the chat; nothing was saved.', 'warning');
            else {
                _convEditKept.set(entry.id, text);
                CoreAPI.showToast('That message changed elsewhere since it was shown; nothing was saved. Edit it again to get your text back.', 'warning');
            }
            return 'stale';
        }
        CoreAPI.showToast(`Could not save the edit: ${err.message}`, 'error');
        return false;
    }
}

/** Drop the ACTIVE draft of several, named by its place, its text and the count shown, then re-read; a stale page removes nothing. */
async function convDeleteDraft(seq, messageId = null) {
    const i = convIndexOfShown(seq, messageId);
    if (i === -1) return false;
    const entry = _convMessages[i];
    const { index, count, text } = convShownOf(entry.raw);
    if (count < 2) return false;
    const chatId = _convChatId;
    try {
        const resp = await CoreAPI.apiRequest(`/chats/${encodeURIComponent(chatId)}/messages/${entry.seq}/swipes/delete`, 'POST',
            { index, text, count, messageId: entry.id });
        const stored = await convStoredAnswer(resp, chatId, 'nothing was removed');
        if (stored === CONV_LEFT) return false;
        await convRereadOrOwe();
        return true;
    } catch (err) {
        convShowError(`Could not delete the draft: ${err.message}`);
        return false;
    }
}

async function convDeleteMessage(seq, messageId = null) {
    const i = convIndexOfShown(seq, messageId);
    if (i === -1) return;
    const msg = _convMessages[i].raw;
    // the message the confirm shows: what is deleted is this one, wherever it sits by then, or nothing
    const shownId = _convMessages[i].id;
    const preview = (getMessageDisplayText(msg) || '').slice(0, 120);
    const swipes = Array.isArray(msg?.swipes) ? msg.swipes : [];

    // A message holding alternate drafts is TWO possible deletions, and guessing which
    // one was meant destroys writing the user wanted kept. Ask which.
    if (swipes.length > 1) {
        const choice = await CoreAPI.showConfirm({
            title: 'Delete what?',
            message: `This message carries ${swipes.length} drafts. Deleting just this draft keeps the other ${swipes.length - 1}.`,
            confirmLabel: 'Whole message',
            extraLabel: 'This draft',
            danger: true,
            content: [{ type: 'note', text: preview }],
        });
        if (!choice) return;
        if (choice === 'extra') { await convDeleteDraft(seq, shownId); return; }
    } else {
        const ok = await CoreAPI.showConfirm({
            title: 'Delete Message',
            message: 'This cannot be undone.',
            confirmLabel: 'Delete',
            danger: true,
            content: [{ type: 'note', text: preview }],
        });
        if (!ok) return;
    }
    const now = _convMessages[convIndexOfShown(seq, shownId)];
    if (!now) { convShowError('Could not delete the message: it is no longer in the chat'); return; }
    try {
        // addresses the ONE row, by place and the confirmed message; a whole-list PUT would delete from stale state
        const resp = await CoreAPI.apiRequest(
            `/chats/${encodeURIComponent(_convChatId)}/messages/${now.seq}?messageId=${shownId}`, 'DELETE');
        // another message at that place by now (a delete elsewhere renumbered the chat): nothing went
        if (resp.status === 409 || resp.status === 404) {
            await convRereadOrOwe();
            throw new Error('that message changed since it was shown; nothing was deleted');
        }
        if (!resp.ok) throw new Error(`server returned ${resp.status}`);
        await convRereadOrOwe();
    } catch (err) {
        convShowError(`Could not delete the message: ${err.message}`);
    }
}

async function convBranchFrom(seq, messageId = null) {
    const entry = _convMessages[convIndexOfShown(seq, messageId)];
    if (!entry || !_convChatId) return;
    try {
        // the server branches the stored chat (metadata, books, persona, wallpaper), ending on the message branched from
        const created = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/chats/${encodeURIComponent(_convChatId)}/branch`, 'POST', { seq: entry.seq, messageId: entry.id }));
        CoreAPI.showToast('Branched into a new chat', 'success');
        if (created?.id) {
            const opened = openConversation({ ...created, character: _convChar });
            // behind the pane, as every entry into a conversation: the branch is not in the list yet
            void loadAllChats(true);
            await opened;
        }
    } catch (err) {
        // another message holds that place by now, or none does: the screen is stale, so the truth is read again
        if (err?.status === 404 || err?.status === 409) await convRereadOrOwe();
        convShowError(`Could not branch here: ${err.message}`);
    }
}

// the fields of a message that belong to the alternate that made them (the store's GENERATION_KEYS)
const CONV_GENERATION_KEYS = Object.freeze(['reasoning', 'usage', 'interrupted']);
// a greeting pick still waiting on its answer, per message id: { target, chain }; emptied on open and close
const _convPickPending = new Map();

/** Make one alternate the active one; the write is the SELECTION alone, and the local mes follows it. */
async function convSelectSwipe(seq, i, target) {
    const entry = _convMessages[i];
    const msg = entry.raw;
    // the picked alternate wears its own thinking, tokens and interrupt mark, as its swipe_info holds them
    const extra = { ...(msg.extra || {}) };
    const kept = msg.swipe_info?.[target]?.extra || {};
    for (const k of CONV_GENERATION_KEYS) {
        if (k in kept) extra[k] = kept[k];
        else delete extra[k];
    }
    const next = convWithRaw(entry, { ...msg, swipe_id: target, mes: msg.swipes?.[target] ?? msg.mes, extra });
    // the greeting's alternates are stored raw and expanded when shown, so it paints from the stored answer
    if (convIsGreetingRow(i)) {
        // a pick in flight is where the next tap steps from; picks go out in order and only the last tap's answer paints
        const chatId = _convChatId;
        const key = entry.id;
        const prior = _convPickPending.get(key);
        const pick = { target };
        pick.chain = (async () => {
            await prior?.chain.catch(() => { /* the earlier pick says its own failure; this one only waits for it */ });
            return _convChatId === chatId ? convPersistMessage(entry.seq, { swipe_id: target }, entry.id) : CONV_LEFT;
        })();
        _convPickPending.set(key, pick);
        let stored;
        try {
            stored = await pick.chain;
        } catch (err) {
            // a later tap's pick answers for the row, its failure included
            if (_convPickPending.get(key) !== pick) return;
            _convPickPending.delete(key);
            throw err;
        }
        if (_convPickPending.get(key) !== pick) return;
        _convPickPending.delete(key);
        // a pick answered after the reader left the chat paints nothing, and lands nowhere
        if (convAdoptStored(entry.seq, stored ?? next, entry) !== entry) convLandAlternate(entry.seq);
        return;
    }
    _convMessages[i] = next;
    convReplaceMessage(next);
    convLandAlternate(entry.seq);
    convAdoptStored(entry.seq, await convPersistMessage(entry.seq, { swipe_id: target }, entry.id), next);
}

// a failed pick: a reply's alternate shows unsaved, a greeting's doesnt; a stale refusal re-read the transcript
function convSwipeFailed(i, err) {
    CoreAPI.showToast(err?.stale ? `Not switched: ${err.message}`
        : convIsGreetingRow(i) ? 'The greeting could not be switched' : 'The alternate is shown but could not be saved', 'warning');
}

/** Move between alternates; past the end the LAST message asks for a fresh one, the greeting wraps. */
async function convSwipe(seq, dir, messageId = null) {
    const i = convIndexOfShown(seq, messageId);
    if (i === -1) return;
    const entry = _convMessages[i];
    const msg = entry.raw;
    const total = msg.swipes?.length || 0;
    const isLastRow = i === _convMessages.length - 1;
    // a greeting pick still out is where the row stands for the next tap: its row paints on the answer
    const pending = _convPickPending.get(entry.id);
    const active = total > 1 ? Math.min(pending ? pending.target : (msg.swipe_id ?? 0), total - 1) : 0;
    const target = active + dir;

    if (total > 1 && target >= 0 && target < total) {
        try { await convSelectSwipe(entry.seq, i, target); }
        catch (err) { convSwipeFailed(i, err); }
        return;
    }
    if (target < 0) return convFlashSwipe(entry.seq);
    // past the end: the greeting is card content, so it wraps (or flashes with one); only a live reply generates
    if (convIsGreetingRow(i)) {
        if (total > 1) {
            try { await convSelectSwipe(entry.seq, i, 0); } catch (err) { convSwipeFailed(i, err); }
        } else {
            convFlashSwipe(entry.seq);
        }
        return;
    }
    if (isLastRow && !msg.is_user && !msg.is_system) return convGenerate({ mode: 'swipe', targetSeq: entry.seq, targetId: entry.id });
    return convFlashSwipe(entry.seq);
}

// the first row when it is the character's: the card's greeting, which the model never rewrites
function convIsGreetingRow(index) {
    const msg = _convMessages[index]?.raw;
    return index === 0 && !!msg && !msg.is_user && !msg.is_system;
}

// the combiner's only writer: the server appends one alternate and makes it active, refusing a page that saw another count
async function convAddSwipe(seq, text, messageId = null) {
    const i = convIndexOfShown(seq, messageId);
    if (i === -1) {
        CoreAPI.showToast('Could not add the swipe: that message is no longer in the chat', 'error');
        return false;
    }
    const entry = _convMessages[i];
    const { count } = convShownOf(entry.raw);
    const chatId = _convChatId;
    try {
        const resp = await CoreAPI.apiRequest(`/chats/${encodeURIComponent(chatId)}/messages/${entry.seq}/swipes`, 'POST',
            { text, count, messageId: entry.id });
        const stored = await convStoredAnswer(resp, chatId, 'nothing was added');
        if (stored === null) await convRereadOrOwe();
        else if (convAdoptStored(entry.seq, stored, entry) !== entry) convLandAlternate(entry.seq);
        return stored !== CONV_LEFT;
    } catch (err) {
        CoreAPI.showToast(`Could not add the swipe: ${err.message}`, 'error');
        return false;
    }
}

function convOpenCombiner(seq, messageId = null) {
    const i = convIndexOfShown(seq, messageId);
    if (i === -1) return;
    const entry = _convMessages[i];
    const msg = entry.raw;
    const swipes = Array.isArray(msg.swipes) && msg.swipes.length ? msg.swipes : [msg.mes || ''];
    if (swipes.length < 2) return;
    SwipeCombiner.openPanel({
        chatId: _convChatId,
        seq: entry.seq,
        charName: _convChar?.name || msg.name || 'the character',
        swipes,
        currentId: Math.min(msg.swipe_id ?? 0, swipes.length - 1),
        // the panel stays open while the transcript moves: its result goes to the message it was opened on
        onApply: (targetSeq, text) => convAddSwipe(targetSeq, text, entry.id),
    });
}

// A swipe that changes nothing says so rather than silently doing nothing.
function convFlashSwipe(seq) {
    const cluster = convRowEl(seq)?.querySelector('.chat-conv-swipes');
    if (!cluster) return;
    cluster.classList.remove('no-op');
    void cluster.offsetWidth;
    cluster.classList.add('no-op');
}

// Re-reads the history from the server. Used after any write that renumbers rows, so the
// client's seqs can never drift from the server's.
async function convReloadMessages({ beforeRender = null } = {}) {
    invalidateBudget();
    const chatId = _convChatId;
    try {
        const resp = await CoreAPI.apiRequest(`/chats/${encodeURIComponent(chatId)}`, 'GET');
        // a chat that is not there was deleted elsewhere, whichever re-read finds it
        if (resp.status === 404) {
            if (chatId && _convChatId === chatId) {
                CoreAPI.showToast('This chat was deleted elsewhere', 'info');
                forgetChatsLocally([chatId]);
            }
            return;
        }
        if (!resp.ok) throw new Error(`server returned ${resp.status}`);
        const detail = await resp.json();
        if (_convChatId !== chatId) return;
        const fresh = Array.isArray(detail.messages) ? detail.messages : [];
        // a message stored as held keeps the page's object, so the funnel reuses its element
        const held = new Map(_convMessages.map(e => [e.id, e]));
        _convMessages = fresh.map((entry) => {
            const was = held.get(entry.id);
            return was && JSON.stringify(was) === JSON.stringify(entry) ? was : entry;
        });
        beforeRender?.();
        renderConversation(_convMessages);
        // a re-read can grow the turn under a reader at the end (a stop's kept text, read late): they stay there
        convScrollToEnd({ quiet: true });
    } catch (e) {
        convShowError(`Could not refresh this chat: ${e.message}`);
    }
}

// one root attribute swaps send for stop and hides the last row's bar at once; the composer stays enabled for drafting
function convSetBusy(busy, { replied = false } = {}) {
    const { pane, send, stop } = convEls();
    if (pane) {
        if (busy) pane.setAttribute('data-generating', 'true');
        else pane.removeAttribute('data-generating');
    }
    send?.classList.toggle('hidden', busy);
    stop?.classList.toggle('hidden', !busy);
    // a reply's end: the reply this tab asked for comes before what another tab wrote meanwhile (an impersonation adds none)
    if (!busy) convPayOwedRebuild({ behindOwn: replied });
    // A stream ending while the conversation is parked is the one completion nobody
    // saw; the toggle's dot is what says so.
    if (_convSuspended) {
        if (!busy) _convUnseen = true;
        convSyncViewBadge();
    }
}

// null means "we could not read the history", which is a different thing from an
// empty array and must not render as one.
function renderConversation(messages) {
    const { list } = convEls();
    if (!list) return;

    // a paint with no rows (an error, the skeleton, an empty chat) leaves no row reachable from the cache
    if (messages === null) {
        _convRowCache = new Map();
        list.innerHTML = `
            <div class="chats-empty">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <h3>Could not load this chat</h3>
                <p>The history was not read, so nothing is shown. Try again.</p>
            </div>`;
        return;
    }
    if (messages.length === 1 && messages[0]?._loading) {
        _convRowCache = new Map();
        // Three rows in the card's own anatomy rather than a spinner: the arrival is a fill rather than a jump.
        list.innerHTML = Array.from({ length: 3 }, () => `
            <div class="chat-conv-skeleton">
                <span class="chat-conv-skel-avatar"></span>
                <span class="chat-conv-skel-bar"></span>
                <span class="chat-conv-skel-bar"></span>
                <span class="chat-conv-skel-bar"></span>
            </div>`).join('');
        return;
    }
    if (!messages.length) {
        _convRowCache = new Map();
        list.innerHTML = `
            <div class="chats-empty">
                <i class="fa-solid fa-comment"></i>
                <h3>No messages yet</h3>
                <p>Write the first one below.</p>
            </div>`;
        return;
    }
    // unchanged rows are the same elements; only fresh ones are enhanced, in one pass
    convEnhanceRows(convPatchRows(list, messages));
    // every full render re-draws the context marker itself; call sites forgot it on toggles and reloads
    convApplyContextMarker();
}

function convRowEl(seq) {
    const { list } = convEls();
    return list?.querySelector(`.chat-conv-msg[data-seq="${seq}"]`) || null;
}

// the row cache: seq to what its row was built from; the entry object's identity is the key, the generation the rest
let _convRowCache = new Map();
let _convRenderGen = 0;

function convInvalidateRows() {
    _convRenderGen++;
}

// rebuild every row from the held messages, but never under a stream or open editor: then it is owed
function convRebuildRows() {
    if (_convAbort || convEditorOpen()) { _convStaleWhileBusy = true; return; }
    convInvalidateRows();
    if (_convMessages.length) renderConversation(_convMessages);
}

// a render or enhance hook added or removed changes what every row shows
function convOnHooksChanged(name) {
    if (name !== 'message.render' && name !== 'message.enhance') return;
    convRebuildRows();
}

// The one seam where row markup becomes elements.
function convRowFromHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    return [...tpl.content.children];
}

// re-assemble in array order from reused and fresh rows; a row swapped behind the cache's back is a miss by construction
function convPatchRows(list, messages) {
    const next = new Map();
    const frag = document.createDocumentFragment();
    const fresh = [];
    // a streaming reply survives any rebuild; rebuilt, the stream would paint into a detached row
    const live = _convLiveEl?.isConnected ? _convLiveEl.closest('.chat-conv-msg') : null;
    const carried = live?.parentNode === list ? live : null;
    const liveSeq = carried ? Number(carried.dataset.seq) : null;
    let livePlaced = false;
    messages.forEach((entry, i) => {
        const seq = entry.seq;
        if (carried && seq === liveSeq) {
            frag.append(carried);
            livePlaced = true;
            return;
        }
        const isLast = i === messages.length - 1;
        const prev = messages[i - 1] || null;
        const divider = convDividerHtml(entry, prev);
        const hit = _convRowCache.get(seq);
        if (hit && hit.entry === entry && hit.isLast === isLast && hit.divider === divider
            && hit.gen === _convRenderGen && hit.els.every(el => el.parentNode === list)) {
            frag.append(...hit.els);
            next.set(seq, hit);
            return;
        }
        const els = convRowFromHtml(convMessageHtml(entry, { isLast, prev }));
        const row = els.find(el => el.classList.contains('chat-conv-msg')) || null;
        if (!row) return; // the ST header line renders nothing
        frag.append(...els);
        fresh.push(row);
        next.set(seq, { entry, isLast, divider, gen: _convRenderGen, els });
    });
    if (carried && !livePlaced) {
        // a new turn's bubble stays the last message, as convOpenLiveBubble made it
        frag.querySelectorAll('.chat-conv-msg.last-message').forEach(r => r.classList.remove('last-message'));
        frag.append(carried);
    }
    list.replaceChildren(frag);
    _convRowCache = next;
    return fresh;
}

// the oldest message still in the prompt; three states, and anything that invalidates it erases the line
let _convBudget = null;

function convApplyContextMarker() {
    const { list } = convEls();
    if (!list) return;
    list.querySelectorAll('.chat-conv-context-divider').forEach(el => el.remove());
    // firstSeq, never trimmed: a trimmed COUNT is relative to an already-filtered list
    const firstSeq = _convBudget?.firstSeq;
    if (!Number.isInteger(firstSeq)) return;
    // Nothing is drawn when nothing was dropped: the whole chat fits, and a line saying
    // "the context starts here" on message 0 is noise.
    if (!Number.isInteger(_convBudget?.trimmed) || _convBudget.trimmed <= 0) return;
    // a divider ELEMENT, never a row class: every layout mode owns the row's plate
    convRowEl(firstSeq)?.insertAdjacentHTML('beforebegin',
        '<div class="chat-conv-divider chat-conv-context-divider"><span>Context starts here</span></div>');
}

// Any edit, delete, branch, swipe or reorder makes the last measurement a lie.
function invalidateBudget() {
    _convBudget = null;
    convApplyContextMarker();
}

// a fresh open starts UNKNOWN; the dry-run assembly measures it so the boundary shows on open; a failed ask stays unknown
async function convSeedBudget(chatId) {
    if (!chatId) return;
    try {
        const first = convFirstShown();
        const resp = await CoreAPI.apiRequest(`/chats/${encodeURIComponent(chatId)}/prompt${Number.isInteger(first) ? `?firstShown=${first}` : ''}`, 'GET');
        if (!resp.ok) return;
        const detail = await resp.json();
        if (_convChatId !== chatId || !detail?.budget) return;
        _convBudget = detail.budget;
        convApplyContextMarker();
    } catch { /* unknown stays unknown */ }
}

// Session-only by design: a running total that survived a reload would be a usage ledger.
let _convSessionTokens = 0;

function convAddSessionUsage(usage) {
    const total = usage?.total_tokens ?? usage?.totalTokens;
    if (Number.isFinite(total)) _convSessionTokens += total;
    convSyncSessionTotal();
}

function convSyncSessionTotal() {
    const el = document.getElementById('chatConvSessionTokens');
    if (!el) return;
    el.textContent = _convSessionTokens
        ? `${_convSessionTokens >= 1000 ? `${(_convSessionTokens / 1000).toFixed(1)}k` : _convSessionTokens} this session`
        : '';
    el.classList.toggle('hidden', !_convSessionTokens);
}

/** A reply landing in a background tab flashes our own title, restored on the next look (never spoofing document.hidden). */
let _convTitleFlash = 0;
let _convTitleOriginal = '';

function convSignalComplete() {
    if (!document.hidden || CoreAPI.getSetting('chatNotifyOnComplete') === false) return;
    if (_convTitleFlash) return;
    // Captured once, so a second reply cannot capture the flashing title as the original.
    _convTitleOriginal = _convTitleOriginal || document.title;
    let on = false;
    _convTitleFlash = setInterval(() => {
        on = !on;
        document.title = on ? 'New reply' : _convTitleOriginal;
    }, 1200);
    const restore = () => {
        if (document.hidden) return;
        clearInterval(_convTitleFlash);
        _convTitleFlash = 0;
        document.title = _convTitleOriginal;
        _convTitleOriginal = '';
        document.removeEventListener('visibilitychange', restore);
    };
    document.addEventListener('visibilitychange', restore);

    // Permission is never REQUESTED here, only used when it already exists, so nothing
    // pops a browser prompt because a reply arrived.
    try {
        if (window.Notification?.permission === 'granted') {
            const last = _convMessages[_convMessages.length - 1];
            new Notification(_convChar?.name || 'Project Σ', {
                body: (last ? getMessageDisplayText(last.raw) || '' : '').slice(0, 80),
                silent: true,
            });
        }
    } catch { /* notifications are a nicety, never a failure path */ }
}

/** Append one row instead of rebuilding: a full rewrite dropped decoded images and reset the scroller (the send flicker). */
function convAppendMessage(entry) {
    const { list } = convEls();
    if (!list) return;
    list.querySelector('.chats-empty')?.remove();
    // the appended row is the new last one, so the previous holder gives up the class
    list.querySelector('.chat-conv-msg.last-message')?.classList.remove('last-message');
    // prev from the array, not the DOM, so a divider opens after a long break exactly as on a reload
    const at = convIndexOfSeq(entry.seq);
    const prev = at > 0 ? _convMessages[at - 1] : null;
    if (prev) convRebuildDethroned(at - 1);
    list.insertAdjacentHTML('beforeend', convMessageHtml(entry, { isLast: true, prev }));
    // lastElementChild is the ROW even when a divider was emitted ahead of it.
    const row = list.lastElementChild;
    convEnhanceRows(row);
    row?.classList.add('entering');
    row?.addEventListener('animationend', () => row.classList.remove('entering'), { once: true });
}

// the dethroned row had isLast baked into its html, so it is rebuilt; an open editor on it owes that to its close
function convRebuildDethroned(at) {
    const entry = _convMessages[at];
    const row = Number.isInteger(entry?.seq) ? convRowEl(entry.seq) : null;
    if (!row) return;
    if (row.querySelector('.chat-conv-edit')) { _convStaleWhileBusy = true; return; }
    convReplaceMessage(entry);
}

/** Swap one row in place, anchored on the row's own offset so a height change above the view doesnt yank it. */
function convReplaceMessage(entry, { carry = null } = {}) {
    const { list } = convEls();
    const old = convRowEl(entry.seq);
    if (!list || !old) return false;
    const beforeTop = old.offsetTop - list.scrollTop;
    const tmp = document.createElement('div');
    // isLast from the DATA (the live bubble stripped the class); no prev, or a duplicate divider gets picked up below
    const isLast = entry.seq === _convMessages[_convMessages.length - 1]?.seq;
    tmp.innerHTML = convMessageHtml(entry, { isLast });
    const next = tmp.querySelector('.chat-conv-msg');
    if (!next) return false;
    old.replaceWith(next);
    convEnhanceRows(next);
    // before the anchor: a row redrawn with its disclosures shut is shorter, and the scroll clamps short of the reader
    carry?.(next);
    _convPin.put(next.offsetTop - beforeTop);
    // an editor the swap took is gone as a closed one is; a row grown or shrunk moves the end the pill reads, unscrolled
    if (old.querySelector('.chat-conv-edit')) convEditorGone(null);
    else convSyncJumpPill();
    return true;
}

/** Point embedded media at the copies on disk; remote urls re-fetch every render and leak the reader to the card's host. */
function convLocalizeText(text) {
    if (!text || !_convMediaMap) return text;
    return CoreAPI.replaceMediaUrlsInText(text, _convMediaMap);
}

/** Build the open character's media map and repaint once if it changed anything; the first render doesnt wait. */
async function convLoadMediaMap(chatId, charId) {
    _convMediaMap = null;
    if (!charId || !CoreAPI.isMediaLocalizationEnabled()) return;
    try {
        const map = await CoreAPI.buildMediaLocalizationMap(charId);
        if (_convChatId !== chatId) return;          // reader moved on while it built
        if (!map || !Object.keys(map).length) return; // nothing localized, nothing to repaint
        _convMediaMap = map;
        convRebuildRows();
    } catch (e) {
        // A failed map is not a failed chat: the message still renders, just remotely.
        console.error('[Chats] media localization pass failed:', e);
    }
}

/**
 * One producer, one gate: every chat body on screen (settled row, streaming partial) resolves through here.
 * @param {string} text raw message source
 * @param {string} charName for {{char}}
 * @param {object} [opts] forwarded to formatChatText (streaming, quoteFamilies, ...)
 */
function convRenderText(text, charName, opts = {}) {
    // shown as stored, as the model reads it: a sent turn was expanded at send, a reply is the model's own
    return CoreAPI.safePurify(CoreAPI.formatChatText(text, charName, { ...opts, ...STORED_TEXT }), CHAT_PURIFY_CONFIG);
}

// row 0 is the one row every build expands again, so a greeting stored with pronoun macros shows the words it sends
function convRowRenderOpts(seq) {
    return seq === 0 ? { pronouns: _convPersonaPronouns } : {};
}

/** Re-pin when body media loads (it grows the card after the scroll), quietly and never yanking a reader away. */
function convRepinOnMediaLoad(root) {
    root?.querySelectorAll?.('.chat-conv-msg-body img, .chat-conv-msg-body video').forEach(el => {
        if (el.dataset.clRepin || el.complete) return;
        el.dataset.clRepin = '1';
        const done = () => convScrollToEnd({ quiet: true });
        el.addEventListener('load', done, { once: true });
        el.addEventListener('error', done, { once: true });
    });
}

// the copy button is added AFTER the sanitiser (no <button> in the allowlist); idempotent, every row path runs it
function convEnhanceRows(root) {
    const roots = Array.isArray(root) ? root : [root];
    for (const r of roots) {
        convRepinOnMediaLoad(r);
        r?.querySelectorAll?.('.cl-code-block .cl-code-head').forEach(head => {
            if (head.querySelector('.cl-code-copy')) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'cl-code-copy';
            btn.dataset.act = 'copy-code';
            btn.title = 'Copy code';
            btn.setAttribute('aria-label', 'Copy code');
            btn.innerHTML = '<i class="fa-solid fa-copy"></i>';
            head.appendChild(btn);
        });
    }
    if (hasHook('message.enhance')) convEnhanceHooked(roots);
}

// An extension's message.enhance hears each stored row put in the DOM; a streaming row waits
// for the stored one that replaces it
function convEnhanceHooked(root) {
    const rows = (Array.isArray(root) ? root : [root]).flatMap(r => (r?.matches?.('.chat-conv-msg[data-seq]') ? [r] : [...(r?.querySelectorAll?.('.chat-conv-msg[data-seq]') || [])]));
    if (!rows.length) return;
    // one seq-to-entry map per pass: per-row lookups made a full rebuild quadratic in the chat's length
    const entryAt = new Map(_convMessages.map(e => [e.seq, e]));
    for (const el of rows) {
        if (el.getAttribute('data-live') === '1') continue;
        const seq = Number(el.dataset.seq);
        const entry = entryAt.get(seq);
        if (entry === undefined) continue;
        runActions('message.enhance', Object.freeze({ chatId: _convChatId, seq, messageId: entry.id, el, message: Object.freeze({ ...entry.raw }) }));
    }
}

// message.render dresses the purified body and its answer is purified again; format is the row's producer
function convRenderHooked(html, entry, charName) {
    const out = runFilter('message.render', html, Object.freeze({
        chatId: _convChatId, charId: _convChar?.id ?? null, seq: entry.seq, messageId: entry.id ?? null, message: Object.freeze({ ...entry.raw }),
        format: (text) => convRenderText(convLocalizeText(String(text ?? '')), charName),
    }));
    return out === html ? html : CoreAPI.safePurify(out, CHAT_PURIFY_CONFIG);
}

// the active alternate IS the display: swipes[swipe_id] past one, else mes; clamped, a swipe_id can outlive its array
function getMessageDisplayText(msg) {
    const rawSwipeId = msg.swipe_id ?? 0;
    const swipeId = msg.swipes?.length > 1 ? Math.min(rawSwipeId, msg.swipes.length - 1) : 0;
    return msg.swipes?.length > 1 ? (msg.swipes[swipeId] || '') : (msg.mes || '');
}

// every row is its own card, never grouped; built from an entry: raw, seq, id and time
function convMessageHtml(entry, { isLast = false, prev = null } = {}) {
    const msg = entry.raw;
    if (msg?.chat_metadata !== undefined && !msg.mes) return ''; // ST header line
    const seq = entry.seq;
    const charName = _convChar?.name || 'Character';
    const isUser = !!msg.is_user;
    const isSystem = !!msg.is_system;
    const name = isUser ? convUserDisplayName(msg) : (msg.name || charName);
    const text = convLocalizeText(getMessageDisplayText(msg));
    // untrusted card and model text: the chat producer and gate, never formatRichText (it collapses spaces)
    const purified = convRenderText(text, charName, convRowRenderOpts(seq));
    const body = hasHook('message.render') ? convRenderHooked(purified, entry, charName) : purified;
    const cls = ['chat-conv-msg', isUser ? 'user' : 'assistant'];
    if (isSystem) cls.push('system');
    if (isLast) cls.push('last-message');
    if (msg.extra?.hidden) cls.push('is-hidden');
    const swipes = convSwipeClusterHtml(entry, { isLast });
    // the prose ends in an unseen copy of the pill, sized by the counter's length
    const room = swipes ? ` data-swipe-len="${convSwipeCount(msg).length}"` : '';

    return `
        ${convDividerHtml(entry, prev)}
        <div class="${cls.join(' ')}" data-seq="${seq}"${Number.isInteger(entry.id) ? ` data-mid="${entry.id}"` : ''}${room}>
            <span class="chat-conv-msg-avatar-frame">${convAvatarInnerHtml(isUser)}</span>
            <div class="chat-conv-msg-head">
                <span class="chat-conv-msg-name">${CoreAPI.escapeHtml(name)}</span>
                ${convMetaChipsHtml(entry, text)}
                ${convActionsHtml(entry, { isLast, isUser, isSystem })}
            </div>
            <div class="chat-conv-msg-body">
                ${convReasoningHtml(msg, charName)}
                <div class="chat-conv-msg-text">${body}</div>
                ${convPicturesHtml(entry)}
            </div>
            ${swipes}
        </div>`;
}

// an unreadable persona list leaves the name null and falls through, never blocking the chat
async function convSyncPersonaName() {
    // One reader of /personas for the whole client.
    const globalName = await CoreAPI.syncActivePersonaName();
    // INSIDE a chat the name over your messages is the RESOLVED one, or an override shows the global name
    if (!_convChatId) {
        _convPersonaName = globalName;
        _convPersonaId = null;
        _convPersonaAvatarId = null;
        _convPersonaPronouns = null;
        return;
    }
    try {
        const r = await CoreAPI.apiRequest(`/personas/resolve?chatId=${encodeURIComponent(_convChatId)}`, 'GET');
        const persona = r.ok ? (await r.json())?.persona : null;
        _convPersonaName = r.ok ? (persona?.name || null) : globalName;
        _convPersonaId = persona?.id ?? null;
        // the id only ADDRESSES the picture; the stored column is a presence marker no caller can set
        _convPersonaAvatarId = persona?.avatar ? persona.id : null;
        // no persona answers the they/them words, as the prompt does; an unread one shows the greeting as stored
        _convPersonaPronouns = r.ok ? { ...persona?.pronouns } : null;
    } catch {
        _convPersonaName = globalName;
        _convPersonaId = null;
        _convPersonaAvatarId = null;
        _convPersonaPronouns = null;
    }
}

// answered at any door (the panel, the details Edit tab): the dot and the offer handed to the panel go together
function convFollowEmbeddedResolved(e) {
    if (!e.detail?.charId || e.detail.charId !== _convChar?.id) return;
    _convEmbeddedLore = null;
    document.getElementById('chatConvLore')?.classList.remove('has-embedded-lore');
}

// a dot on the lore button for a card book the engine cant see; the verdict is the panel's
async function convSyncEmbeddedLoreBadge() {
    const btn = document.getElementById('chatConvLore');
    if (!btn) return;
    const charId = _convChar?.id;
    const flag = await LorePanel.embeddedLoreNeedsAttention(charId, _convEmbeddedLore);
    if (_convChar?.id !== charId) return;    // the conversation moved while the store loaded
    btn.classList.toggle('has-embedded-lore', flag);
    btn.title = flag ? 'Lorebooks: this card carries one that is not imported' : 'Lorebooks';
}

/** The prompt's precedence (active persona over stored user_name), so the screen names who the model is told; 'unused' is no name. */
function convUserDisplayName(msg) {
    const real = (v) => (typeof v === 'string' && v.trim() && v.trim() !== 'unused') ? v.trim() : null;
    return real(_convPersonaName) || real(msg?.name) || real(_convUserName) || 'You';
}

// the user side shows the resolved persona's picture at the 192 tier, else a glyph, never a broken img
function convAvatarInnerHtml(isUser) {
    if (isUser) {
        // built from the persona ID, never the stored column, so no authored string reaches an src
        return _convPersonaAvatarId
            ? `<img class="chat-conv-msg-avatar" src="${CoreAPI.thumbUrl('persona', _convPersonaAvatarId, 192)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
            : '<i class="fa-solid fa-user chat-conv-msg-avatar-glyph"></i>';
    }
    const url = (_convChar && CoreAPI.getCharacterAvatarSmallThumbUrl(_convChar.id)) || '/img/no-portrait.png';
    return `<img class="chat-conv-msg-avatar" src="${url}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
}

/** ONE interval patching stamped chips in place; re-rendering on a timer would lose an editor and the scroll. */
let _convClockTimer = 0;
// past a week a chip's label is its date, which never moves again, so the chip carries no stamp
const CONV_STAMP_LIVE_MS = 7 * 86_400_000;

function convStartClock() {
    if (_convClockTimer) return;
    _convClockTimer = setInterval(convTickClock, 60_000);
}

// one pass, none while parked, hidden or switched off; resume, a returning tab and the switch each run one
function convTickClock() {
    const { list, pane } = convEls();
    if (!list || !isConversationOpen() || _convSuspended || document.hidden || pane?.dataset.timestamps === 'false') return;
    list.querySelectorAll('.chat-conv-msg-chip[data-stamp]').forEach(el => {
        const stamp = Number(el.dataset.stamp);
        const rel = convRelativeTime(stamp);
        if (rel && el.textContent !== rel) el.textContent = rel;
        if (!(Date.now() - stamp < CONV_STAMP_LIVE_MS)) el.removeAttribute('data-stamp');
    });
}

function convStopClock() {
    clearInterval(_convClockTimer);
    _convClockTimer = 0;
}

function convRelativeTime(ms) {
    const then = new Date(ms);
    if (Number.isNaN(then.getTime())) return null;
    const age = Date.now() - ms;
    if (age < 86_400_000) return CoreAPI.formatRelativeAge(ms);
    const hhmm = `${String(then.getHours()).padStart(2, '0')}:${String(then.getMinutes()).padStart(2, '0')}`;
    if (age < CONV_STAMP_LIVE_MS) return `${then.toLocaleDateString(undefined, { weekday: 'short' })} ${hhmm}`;
    return `${then.getDate()} ${then.toLocaleDateString(undefined, { month: 'short' })} ${hhmm}`;
}

function convMetaChipsHtml(entry, text) {
    const msg = entry.raw;
    const chips = [];
    // seq, cost and time chips always render; pane attributes hide them, so a toggle never rebuilds
    chips.push({ text: `#${entry.seq}`, cls: ' is-meta' });
    {
        // A real usage figure when the model reported one, the same chars-over-four
        // approximation the server budgets with otherwise, so the two never disagree.
        const reported = msg.extra?.usage?.completion_tokens ?? msg.extra?.usage?.completionTokens;
        const tokens = Number.isFinite(reported) ? reported : Math.ceil((text || '').length / 4);
        chips.push({
            text: tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`,
            title: Number.isFinite(reported) ? 'Tokens reported by the model' : 'Estimated tokens',
            cls: ' is-meta',
        });
    }
    // the server's reading of the stored send_date: the page's own parse put ST's strings at midnight
    const at = entry.createdAt;
    if (Number.isFinite(at)) {
        const rel = convRelativeTime(at);
        // only a label that can still move is stamped for the clock; every time chip is one for the Timestamps switch
        const stamp = Date.now() - at < CONV_STAMP_LIVE_MS ? at : null;
        if (rel) chips.push({ text: rel, title: new Date(at).toLocaleString(), stamp, cls: ' is-time' });
    }
    if (msg.extra?.interrupted) chips.push({ text: 'interrupted', cls: ' is-interrupted' });
    // State, not decoration: a hidden message dims, and a dim with no label reads as a rendering bug
    if (msg.extra?.hidden) {
        chips.push({ text: 'hidden', cls: ' is-hidden-flag', title: 'Hidden from the prompt: the model does not see this message. Unhide from the message menu.' });
    }
    if (!chips.length) return '<span class="chat-conv-msg-meta"></span>';
    return `<span class="chat-conv-msg-meta">${chips.map(c =>
        `<span class="chat-conv-msg-chip${c.cls || ''}"${c.title ? ` title="${CoreAPI.escapeHtml(c.title)}"` : ''}${c.stamp ? ` data-stamp="${c.stamp}"` : ''}>${CoreAPI.escapeHtml(c.text)}</span>`).join('')}</span>`;
}

/** Reasoning is marginalia (a rule, dimmer text) through the reply's gate: a think block is just as untrusted. */
function convReasoningHtml(msg, charName) {
    const raw = msg.extra?.reasoning;
    if (typeof raw !== 'string' || !raw.trim()) return '';   // absent, never an empty disclosure
    const open = CoreAPI.getSetting('chatReasoningDefaultOpen') === true ? ' open' : '';
    return `<details class="cl-reasoning"${open}>
        <summary>Thought for a moment</summary>
        <div class="cl-reasoning-body">${convRenderText(raw, charName)}</div>
    </details>`;
}

/** A rule between messages when the day changes or the gap runs long; not accent, the context marker owns that. */
const SESSION_GAP_MS = 4 * 3_600_000;

function convDividerHtml(entry, prev) {
    if (!prev || !Number.isFinite(entry?.createdAt) || !Number.isFinite(prev?.createdAt)) return '';
    const a = new Date(prev.createdAt);
    const b = new Date(entry.createdAt);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return '';
    const newDay = a.toDateString() !== b.toDateString();
    const gap = b.getTime() - a.getTime();
    if (!newDay && gap < SESSION_GAP_MS) return '';
    const label = newDay
        ? b.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
        : `${Math.round(gap / 3_600_000)} hours later`;
    return `<div class="chat-conv-divider"><span>${CoreAPI.escapeHtml(label)}</span></div>`;
}

function convActBtn(seq, action, icon, title, cls = 'chat-conv-msg-act') {
    return `<button class="${cls}" data-act="${action}" data-seq="${seq}" title="${title}" aria-label="${title}"><i class="fa-solid ${icon}"></i></button>`;
}

/** Edit and regenerate stay out (an empty slot keeps bands aligned); the rest wait behind an ellipsis, built on first touch. */
function convActionsHtml(entry, { isLast, isUser, isSystem }) {
    if (isSystem) return '';
    const btn = (action, icon, title, cls) => convActBtn(entry.seq, action, icon, title, cls);
    const regen = (isLast && !isUser)
        ? btn('regenerate', 'fa-rotate', 'Regenerate')
        : '<span class="chat-conv-msg-act-slot"></span>';
    const inline = CoreAPI.getSetting('chatExpandActions') === true;
    return `<span class="chat-conv-msg-actions">
        ${btn('edit', 'fa-pen', 'Edit message')}
        ${regen}
        <span class="chat-conv-msg-more-wrap">
            ${btn('more', 'fa-ellipsis', 'More actions', 'chat-conv-msg-act chat-conv-msg-more')}
            <span class="chat-conv-msg-overflow"${inline ? ' data-ready="1"' : ''}>${inline ? convOverflowHtml(entry, { isLast, isUser }) : ''}</span>
        </span>
    </span>`;
}

function convOverflowHtml(entry, { isLast, isUser }) {
    const seq = entry.seq;
    const btn = (action, icon, title, cls) => convActBtn(seq, action, icon, title, cls);
    return `
                ${btn('copy', 'fa-copy', 'Copy source')}
                ${btn('branch', 'fa-code-branch', 'Branch from here')}
                ${!isUser && isLast ? btn('continue-here', 'fa-forward', 'Continue this reply') : ''}
                ${btn('hide', 'fa-eye-slash', entry.raw.extra?.hidden ? 'Send to the model again' : 'Hide from the prompt')}
                ${extHasActions('message') ? extActionsFor('message', convActionContext({ seq, messageId: entry.id ?? null, message: entry.raw })).map(a => btn(`ext:${a.key}`, a.icon, CoreAPI.escapeHtml(a.label))).join('') : ''}
                ${btn('delete', 'fa-trash', 'Delete message')}`;
}

// overflow verbs built on a row's first touch: six buttons per row were a third of the nodes; a rebuild resets them
function convEnsureRowActions(row) {
    const overflow = row?.querySelector('.chat-conv-msg-overflow');
    if (!overflow || overflow.dataset.ready) return;
    const entry = convEntryAtSeq(Number(row.dataset.seq));
    if (!entry) return; // the streaming bubble has no history row yet
    overflow.dataset.ready = '1';
    overflow.innerHTML = convOverflowHtml(entry, { isLast: entry === _convMessages[_convMessages.length - 1], isUser: !!entry.raw.is_user });
}

// the counter the pill shows, active over total; the row hands the same text to its prose
function convSwipeCount(msg) {
    const total = msg.swipes?.length || 0;
    const active = total > 1 ? Math.min(msg.swipe_id ?? 0, total - 1) : 0;
    return `${active + 1}/${Math.max(total, 1)}`;
}

// Chevrons on a plate, sized like every other control: bare guillemet punctuation measured
// 5px wide, present in the DOM and invisible on screen.
function convSwipeClusterHtml(entry, { isLast }) {
    const msg = entry.raw;
    const seq = entry.seq;
    const total = msg.swipes?.length || 0;
    const active = total > 1 ? Math.min(msg.swipe_id ?? 0, total - 1) : 0;
    const swipeable = isLast && !msg.is_user && !msg.is_system;
    // Only the last reply carries the cluster (the ST rule): older messages keep their
    // alternates in the row data, the transcript just stops advertising them.
    if (!swipeable) return '';
    // the right chevron becomes an accent wand where pressing it calls the model rather than paging
    const generates = swipeable && !convIsGreetingRow(convIndexOfSeq(seq)) && active === Math.max(total - 1, 0);
    // left stays clickable at the start: convSwipe flashes the cluster, which teaches the boundary
    const atStart = active === 0;
    const nextLabel = generates ? 'Write another reply' : 'Next alternate';
    // the combiner only when there is something to combine
    const combine = total > 1
        ? `<button class="chat-conv-swipe-btn chat-conv-swipe-combine" data-act="combine" data-seq="${seq}" title="Combine alternates into a new one" aria-label="Combine alternates into a new one"><i class="fa-solid fa-code-merge"></i></button>`
        : '';
    return `<div class="chat-conv-swipes${generates ? ' will-generate' : ''}${atStart ? ' at-start' : ''}" data-seq="${seq}">
        <button class="chat-conv-swipe-btn" data-act="swipe" data-dir="-1" data-seq="${seq}" title="Previous alternate" aria-label="Previous alternate"><i class="fa-solid fa-chevron-left"></i></button>
        <span class="chat-conv-swipe-count">${convSwipeCount(msg)}</span>
        <button class="chat-conv-swipe-btn" data-act="swipe" data-dir="1" data-seq="${seq}" title="${nextLabel}" aria-label="${nextLabel}"><i class="fa-solid fa-chevron-right"></i></button>${combine}
    </div>`;
}

// live state: text accumulates per chunk, the DOM is written on the painter's cadence, nothing while parked or hidden
let _convLiveText = '';
let _convLiveReasoning = '';
// the thinking the live disclosure shows, kept so opening it can format exactly that
let _convShownThought = '';
let _convLiveEl = null;
// the reply under way as written on screen (a continue's stored text, what showed before a flip to off or a park)
let _convLiveShownText = '';
// the reader looked away from it (parked, a hidden tab, streaming off): the next paint opens past what they saw
let _convSightGap = false;
let _convLivePainter = null;
// which partial the next paint writes: the reply, its thinking, or both inside one cadence
let _convLiveDirty = false;
let _convLiveReasoningDirty = false;
// smooth streaming, as the conversation last applied it; each partial is paced on its own arrivals
let _convPaced = false;
const _convReplyReveal = createLiveReveal({ paced: () => _convPaced });
const _convThinkReveal = createLiveReveal({ paced: () => _convPaced });
// the connection whose gaps the reveals learnt
let _convRevealFor = null;
// ends the catch-up wait early (Stop, pacing switched off)
let _convLiveEnd = null;

// thinking arrives first, so the bubble grows its own disclosure, on the reply's cadence (per-event writes went quadratic)
function convPaintLiveReasoning() {
    _convLiveReasoningDirty = true;
    if (!convStreams()) return;
    _convThinkReveal.arrive(_convLiveReasoning.length);
    convMarkLive();
}

// the reply's partial grew; the next paint writes what its reveal shows
function convPaintLive() {
    _convLiveDirty = true;
    // writing once the model sends text: a flip to off mid-reply says so without counting a continue's stored text
    if (!_convWriting) { _convWriting = true; if (!convStreams()) convSyncLiveStatus(); }
    if (!convStreams()) return;
    _convReplyReveal.arrive(_convLiveText.length);
    convMarkLive();
}

// with streaming off the row says how long the reply has been on its way: thinking, then writing once text arrives
let _convStatusTimer = 0;
let _convStatusSince = 0;
let _convWriting = false;
function convSyncLiveStatus() {
    const row = _convLiveEl?.isConnected ? _convLiveEl.closest('.chat-conv-msg') : null;
    let chip = row?.querySelector('.chat-conv-msg-chip.is-status');
    if (!row || convStreams()) {
        chip?.remove();
        clearInterval(_convStatusTimer);
        _convStatusTimer = 0;
        return;
    }
    if (!chip) {
        chip = document.createElement('span');
        chip.className = 'chat-conv-msg-chip is-status';
        row.querySelector('.chat-conv-msg-meta')?.appendChild(chip);
    }
    const tick = () => {
        if (!chip.isConnected) { clearInterval(_convStatusTimer); _convStatusTimer = 0; return; }
        if (_convSuspended || document.hidden) return;
        chip.textContent = `${_convWriting ? 'writing' : 'thinking'} · ${Math.round((Date.now() - _convStatusSince) / 1000)}s`;
    };
    tick();
    if (!_convStatusTimer) _convStatusTimer = setInterval(tick, 500);
}

// one paint per cadence for what is dirty, none parked or hidden; the painter lives from first mark to stop
function convMarkLive() {
    if (!_convLivePainter) _convLivePainter = createLivePainter({ paint: convPaintLiveNow, held: () => _convSuspended || document.hidden, behind: convLiveBehind });
    _convLivePainter.mark();
}

// a paced reveal still holds arrived text back from the row it streams into
function convLiveBehind() {
    return !!_convLiveEl?.isConnected && (_convReplyReveal.behind() || _convThinkReveal.behind());
}

// what of a finished reply the reader saw: null when they watched it stream (it follows the end), else the text shown
function convLandFrom() {
    const seen = _convLiveShownText.trim() ? _convLiveShownText : '';
    return seen && convStreams() && !_convSightGap ? null : seen;
}

// back in sight: whatever streamed in meanwhile lands whole in one paint, and pacing goes on from there
function convScheduleLivePaint() {
    _convReplyReveal.all();
    _convThinkReveal.all();
    _convLivePainter?.flush();
}

// a new stream starts from nothing shown; another connection's gaps say nothing about this one
function convResetLiveReveal() {
    if (_convRevealFor !== _convProfileId) {
        _convReplyReveal.forget();
        _convThinkReveal.forget();
        _convRevealFor = _convProfileId;
    }
    _convReplyReveal.reset();
    _convThinkReveal.reset();
}

// Stop, or smooth streaming switched off: what arrived shows at once, and a catch-up under way ends
function convRevealLiveAll() {
    const behind = convLiveBehind();
    _convReplyReveal.all();
    _convThinkReveal.all();
    _convLiveEnd?.();
    if (behind && !_convSuspended && !document.hidden) convPaintLiveNow();
}

// the stream ended with arrived text unshown: it lands within the catch-up, then the stored row replaces the live one
function convLiveCatchUp() {
    if (_convSuspended || document.hidden || !_convLiveEl?.isConnected || !convStreams()) return null;
    const ms = Math.max(_convReplyReveal.finish(), _convThinkReveal.finish());
    if (ms <= 0) return null;
    _convLivePainter?.mark();
    return new Promise((resolve) => {
        const timer = setTimeout(() => { _convLiveEnd = null; resolve(); }, ms);
        _convLiveEnd = () => { clearTimeout(timer); _convLiveEnd = null; resolve(); };
    });
}

/** Render what the reveal shows through the settled row's producer and gate; streaming keeps a half-arrived fence literal. */
function convPaintLiveNow() {
    if (!convStreams()) return;
    const text = _convLiveDirty || _convReplyReveal.behind();
    const reasoning = _convLiveReasoningDirty || _convThinkReveal.behind();
    _convLiveDirty = false;
    _convLiveReasoningDirty = false;
    if (!_convLiveEl?.isConnected) return;
    // a cut that shows nothing new (paced, between two words) writes nothing
    const thought = reasoning ? _convThinkReveal.cut(_convLiveReasoning) : null;
    const shown = text ? _convReplyReveal.cut(_convLiveText) : null;
    // the first paint since the reader looked away opens past what they saw, measured before it writes
    const seenAt = _convSightGap && shown !== null ? convLiveSeenAt() : undefined;
    if (thought !== null) convWriteLiveReasoning(thought);
    if (shown !== null) {
        const live = CoreAPI.liveFormattingOn('chat');
        // the row's class moves the caret off a box's own line, where it took a line the settled box does not have
        _convLiveEl.closest('.chat-conv-msg')?.classList.toggle('is-live-format', live);
        const html = convRenderText(shown, _convChar?.name || '', { streaming: live ? 'live' : true });
        if (live) repaintLive(_convLiveEl, html);
        else _convLiveEl.innerHTML = html;
        _convLiveShownText = shown;
    }
    if (seenAt !== undefined) {
        _convSightGap = false;
        convLandLive(seenAt);
    } else if (thought !== null || shown !== null) {
        // the thought painted back in sight: the reader follows it, so the reply's first words open nothing above it
        if (thought !== null) _convSightGap = false;
        convScrollToEnd({ now: true });
    }
}

// The live row's disclosure, found from the element the reply streams into.
function convWriteLiveReasoning(thought) {
    const body = _convLiveEl.closest('.chat-conv-msg-body');
    if (!body) return;
    let box = body.querySelector('.cl-reasoning');
    if (!box) {
        // same default as a settled row: a think springing open shoves the awaited reply off screen
        const open = CoreAPI.getSetting('chatReasoningDefaultOpen') === true ? ' open' : '';
        body.insertAdjacentHTML('afterbegin',
            `<details class="cl-reasoning"${open}><summary>Thinking</summary><div class="cl-reasoning-body"></div></details>`);
        box = body.querySelector('.cl-reasoning');
    }
    // once per disclosure, not per paint: opening it formats what it shows
    if (box && !box._liveToggle) {
        box._liveToggle = true;
        // the summary's click comes before the disclosure opens, so the formatting lands in the frame it opens in
        box.querySelector('summary')?.addEventListener('click', () => { if (!box.open && body.contains(_convLiveEl)) convShowLiveThought(box, true); });
        box.addEventListener('toggle', () => { if (body.contains(_convLiveEl)) convShowLiveThought(box); });
    }
    _convShownThought = thought;
    convShowLiveThought(box);
}

// formatted only while open, since hidden text cost the reply paint time; a thought plans markup, so no island opens early
function convShowLiveThought(box, opening = false) {
    const target = box?.querySelector('.cl-reasoning-body');
    if (!target) return;
    if ((box.open || opening) && CoreAPI.liveFormattingOn('chat')) repaintLive(target, convRenderText(_convShownThought, _convChar?.name || '', { streaming: 'live', openIslands: false }));
    else target.textContent = _convShownThought;
}

function convStopLive() {
    _convLivePainter?.stop();
    _convLivePainter = null;
    clearInterval(_convStatusTimer);
    _convStatusTimer = 0;
    _convWriting = false;
    _convLiveDirty = false;
    _convLiveReasoningDirty = false;
    _convLiveEl = null;
    _convLiveShownText = '';
    _convSightGap = false;
    _convLiveText = '';
    _convLiveReasoning = '';
    _convShownThought = '';
    _convReplyReveal.reset();
    _convThinkReveal.reset();
    _convLiveEnd?.();
}

/** Where a reply streams: a fresh turn gets a new bubble, a reroll or swipe streams INTO inPlaceSeq's row. */
function convOpenLiveBubble(inPlaceSeq = null) {
    const { list } = convEls();
    if (!list) return null;
    const reuse = Number.isInteger(inPlaceSeq) ? convRowEl(inPlaceSeq) : null;
    if (reuse) {
        const text = reuse.querySelector('.chat-conv-msg-text');
        if (text) {
            // The previous think belongs to the previous attempt: leaving it would read as
            // the model continuing a thought it never had.
            reuse.querySelector('.cl-reasoning')?.remove();
            text.innerHTML = '';
            // this element stops showing its message, so the cache forgets it: a stop that stores nothing rebuilds the row
            _convRowCache.delete(inPlaceSeq);
            reuse.classList.add('streaming');
            reuse.setAttribute('data-live', '1');
            convScrollToEnd();
            _convLiveText = '';
            _convLiveReasoning = '';
            _convShownThought = '';
            convResetLiveReveal();
            _convLiveEl = text;
            _convLiveShownText = '';
            _convSightGap = !convStreams() || _convSuspended || document.hidden;
            _convStatusSince = Date.now();
            _convWriting = false;
            convSyncLiveStatus();
            return _convLiveEl;
        }
    }
    list.querySelector('.chats-empty')?.remove();
    list.querySelector('.chat-conv-msg.last-message')?.classList.remove('last-message');
    // built by the settled row's producer so it lands at final geometry; no id yet, the next place, now
    const nextSeq = (_convMessages.length ? _convMessages[_convMessages.length - 1].seq : -1) + 1;
    const name = _convChar?.name || 'Character';
    list.insertAdjacentHTML('beforeend', convMessageHtml({
        id: null, seq: nextSeq, createdAt: Date.now(), role: 'assistant', name, content: '',
        raw: { name, is_user: false, is_system: false, send_date: Date.now(), mes: '' },
    }, { isLast: true }));
    const row = list.lastElementChild;
    row?.classList.add('streaming');
    row?.setAttribute('data-live', '1');
    // the settle rebuilds the row this one dethroned, whatever seq the stored reply lands on
    row?.setAttribute('data-turn', 'new');
    convScrollToEnd();
    _convLiveText = '';
    // a stream left mid-thought (the reader switched chats) never ran its stop, so its thinking would lead this one
    _convLiveReasoning = '';
    _convShownThought = '';
    convResetLiveReveal();
    _convLiveEl = row?.querySelector('.chat-conv-msg-text') || null;
    _convLiveShownText = '';
    _convSightGap = !convStreams() || _convSuspended || document.hidden;
    _convStatusSince = Date.now();
    _convWriting = false;
    convSyncLiveStatus();
    return _convLiveEl;
}

/** Retire the streaming bubble for the stored row; a done with no seq falls back to a full render. */
function convSettleLiveBubble() {
    const { list } = convEls();
    // the last tokens land before what the reader did is read, or the carry compares a reply short of its tail
    if (!_convSuspended && !document.hidden) convPaintLiveNow();
    convStopLive();
    if (!list) return;
    const live = list.querySelector('[data-live="1"]');
    const opened = convOpenState(live);
    const newTurn = live?.getAttribute('data-turn') === 'new';
    // an in-place stream took over a real row: unmark and swap it, or its seq leaves the page and the result duplicates
    if (live?.dataset.seq !== undefined && convIndexOfSeq(Number(live.dataset.seq)) !== -1) {
        live.classList.remove('streaming');
        live.removeAttribute('data-live');
    } else {
        live?.remove();
    }
    const i = _convMessages.length - 1;
    const entry = _convMessages[i];
    if (i < 0 || !Number.isInteger(entry?.seq)) { renderConversation(_convMessages); return; }
    // a swipe replaces its row, a new turn appends; a bubble already in its seq's slot is replaced and the dethroned row rebuilt
    if (convRowEl(entry.seq)) {
        convReplaceMessage(entry, { carry: (row) => convRestoreOpenState(row, opened) });
        if (newTurn && i > 0) convRebuildDethroned(i - 1);
    } else {
        convAppendMessage(entry);
        convRestoreOpenState(convRowEl(entry.seq), opened);
    }
}

// what the reader opened while a reply streamed stays open on the stored row: the thinking, and a disclosure by position
function convOpenState(row) {
    if (!row) return null;
    const thinking = row.querySelector('.cl-reasoning');
    return {
        thinking: thinking?.open ?? null,
        thinkingFocused: !!thinking && thinking.querySelector('summary') === document.activeElement,
        inThinking: readerState(thinking?.querySelector('.cl-reasoning-body')),
        inText: readerState(row.querySelector('.chat-conv-msg-text')),
    };
}

function convRestoreOpenState(row, state) {
    if (!row || !state) return;
    const thinking = row.querySelector('.cl-reasoning');
    if (thinking && state.thinking !== null) thinking.open = state.thinking;
    if (thinking && state.thinkingFocused) thinking.querySelector('summary')?.focus({ preventScroll: true });
    // after its open state: a box in a shut thinking has no layout to scroll
    restoreReaderState(thinking?.querySelector('.cl-reasoning-body'), state.inThinking);
    restoreReaderState(row.querySelector('.chat-conv-msg-text'), state.inText);
}

// ========================================
// CONVERSATION OPTIONS MENU
// ========================================

/** The display switches, one list for the menu and the toggler; `on` must agree with convApplyDisplayOptions' defaults. */
function convDisplayToggles() {
    return [
        { key: 'chatExpandActions', icon: 'fa-ellipsis', label: 'Show Every Message Action', on: convSwitchOn('chatExpandActions') },
        { key: 'chatReasoningDefaultOpen', icon: 'fa-brain', label: 'Open Thinking by Default', on: convSwitchOn('chatReasoningDefaultOpen') },
        // not a display switch, but the toggler reads values from this list; `group` keeps it out of Display
        {
            key: 'chatKeepInterrupted', icon: 'fa-hand', label: 'Keep a Stopped Reply',
            on: convSwitchOn('chatKeepInterrupted'), group: 'messages',
        },
    ];
}

function convToggleDisplay(key) {
    CoreAPI.setSetting(key, !convSwitchOn(key));
    // every switch is CSS on a pane attribute except the open disclosure, patched in place; nothing rebuilds
    convApplySettingKeys([key], { written: true });
}

const TOGGLE_PATCHES = {
    chatReasoningDefaultOpen: (on) => {
        convEls().list?.querySelectorAll('details.cl-reasoning').forEach(d => { d.open = !!on; });
    },
    // Showing every action inline needs the overflow built on every row, not on first touch.
    chatExpandActions: (on) => {
        if (on) convEls().list?.querySelectorAll('.chat-conv-msg').forEach(convEnsureRowActions);
    },
    // the clock skips its tick while the stamps are off, so turning them on catches them up
    chatShowTimestamps: (on) => {
        if (on) convTickClock();
    },
};

function convOptionGroups() {
    const hasChar = !!_convChar?.id;
    // extension verbs for this chat, one group; the phone's sheet is this same builder
    const extItems = extActionsFor('chat', convActionContext()).map(a => ({ act: `ext:${a.key}`, icon: a.icon, label: a.label }));
    // no Context section on desktop (it shadowed the header); on mobile a Windows tile grid is the panels' only door
    return [
        ...(CoreAPI.isMobileMode() ? [{
            title: 'Windows',
            layout: 'grid',
            items: [
                { act: 'win:chatConvPersonas', icon: 'fa-masks-theater', label: 'Personas' },
                { act: 'win:chatConvAssistant', icon: 'fa-robot', label: 'Assistant', working: Assistant.isBusy() },
                { act: 'win:chatConvGallery', icon: 'fa-images', label: 'Gallery' },
                { act: 'win:chatConvLore', icon: 'fa-book-atlas', label: 'Lorebooks' },
                { act: 'win:chatConvConnections', icon: 'fa-plug', label: 'Connections', marked: _convOwnProfile },
                { act: 'win:chatConvPrompts', icon: 'fa-sliders', label: 'Prompts', marked: _convOwnPreset },
                { act: 'win:chatConvInspect', icon: 'fa-magnifying-glass-chart', label: 'Inspect' },
                { act: 'win:chatConvSettings', icon: 'fa-gear', label: 'Settings' },
                // every extension window the phone shows gets a tile of its own, clicking its own opener
                ...ExtensionWindows.doors().map(d => ({ act: `win:${d.buttonId}`, icon: d.icon, label: d.label })),
            ],
        }] : []),
        {
            title: 'Display',
            items: [
                { act: 'background', icon: 'fa-image', label: 'Background' },
                ...convDisplayToggles().filter(t => !t.group).map(t => ({
                    act: `display:${t.key}`, icon: t.icon, label: t.label, checked: t.on,
                })),
            ],
        },
        {
            title: 'This chat',
            items: [
                { act: 'card-texts', icon: 'fa-address-card', label: 'Chat Card', marked: CardTextsPanel.holdsOwnTexts(_convChatMeta) },
                { act: 'rename', icon: 'fa-i-cursor', label: 'Rename Chat' },
                { act: 'new-chat', icon: 'fa-plus', label: 'New Chat', disabled: !hasChar },
                { act: 'copy-markdown', icon: 'fa-clipboard', label: 'Copy as Markdown' },
                { act: 'export', icon: 'fa-file-export', label: 'Export JSONL' },
                { act: 'character', icon: 'fa-id-card', label: 'Character Details', disabled: !hasChar },
                { act: 'delete-chat', icon: 'fa-trash', label: 'Delete Chat', danger: true },
            ],
        },
        {
            title: 'Messages',
            items: [
                { act: 'regenerate', icon: 'fa-rotate', label: 'Regenerate Last Reply' },
                { act: 'continue', icon: 'fa-forward', label: 'Continue Last Reply' },
                { act: 'guided', icon: 'fa-wand-magic-sparkles', label: "Direct the Character's Next Reply" },
                { act: 'impersonate', icon: 'fa-user-pen', label: 'Write My Next Message' },
                { act: 'copy-last', icon: 'fa-copy', label: 'Copy Last Reply' },
                ...convDisplayToggles().filter(t => t.group === 'messages').map(t => ({
                    act: `display:${t.key}`, icon: t.icon, label: t.label, checked: t.on,
                })),
            ],
        },
        ...(extItems.length ? [{ title: 'Extensions', items: extItems }] : []),
    ];
}

// what an extension action learns about the conversation it acts on
function convActionContext(extra = {}) {
    return { chatId: _convChatId, character: _convChar, ...extra };
}

// the composer's strip: a button per composer.action its when() shows, grouped by extension in registration order
function convRenderComposerActions() {
    const strip = document.getElementById('chatConvActions');
    const more = document.getElementById('chatConvActionsMore');
    if (!strip || !more) return;
    strip.querySelectorAll('.chat-conv-ext-btn:not(.chat-conv-ext-more), .chat-conv-ext-sep').forEach(el => el.remove());
    const groups = new Map();
    if (isConversationOpen() && extHasActions('composer')) {
        for (const a of extGetActions('composer')) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'chat-conv-ext-btn';
            btn.dataset.extAction = a.key;
            btn.dataset.overflowGroup = a.extName;
            btn.title = a.label;
            btn.setAttribute('aria-label', a.label);
            const glyph = document.createElement('i');
            glyph.className = `fa-solid ${a.icon}`;
            glyph.setAttribute('aria-hidden', 'true');
            btn.appendChild(glyph);
            // when() is handed the button it would show as, the anchor run gets
            if (!extActionShows(a, convActionContext({ anchor: btn }))) continue;
            if (!groups.has(a.extId)) groups.set(a.extId, []);
            groups.get(a.extId).push(btn);
        }
    }
    [...groups.values()].forEach((btns, i) => {
        if (i) {
            const sep = document.createElement('span');
            sep.className = 'chat-conv-ext-sep';
            sep.setAttribute('aria-hidden', 'true');
            strip.insertBefore(sep, more);
        }
        for (const btn of btns) strip.insertBefore(btn, more);
    });
    strip.hidden = groups.size === 0;
    CoreAPI.refitRow(strip);
}

// a verb picked from the strip's More opens what it opens beside the More, the button it stands for being hidden
function convOnComposerAction(e) {
    const btn = e.target.closest('[data-ext-action]');
    if (!btn) return;
    const anchor = btn.classList.contains('cl-overflowed') ? document.getElementById('chatConvActionsMore') || btn : btn;
    extRunAction(btn.dataset.extAction, convActionContext({ anchor }));
}

function convWinTileHtml(it) {
    return `<button type="button" class="chat-conv-win-tile${it.working ? ' is-working' : ''}${it.marked ? ' is-marked' : ''}" data-opt="${it.act}">
        <i class="fa-solid ${it.icon}"></i><span>${CoreAPI.escapeHtml(it.label)}</span>
    </button>`;
}

function convOptionItemHtml(it) {
    // A toggle row says its state on the row itself.
    const tick = it.checked === undefined ? ''
        : `<i class="fa-solid ${it.checked ? 'fa-toggle-on is-on' : 'fa-toggle-off'} chat-conv-opt-state"></i>`;
    const mark = it.marked ? '<span class="chat-conv-opt-mark" aria-hidden="true"></span>' : '';
    return `<button type="button" class="dropdown-item${it.danger ? ' danger' : ''}${it.checked !== undefined ? ' is-toggle' : ''}${it.marked ? ' is-marked' : ''}"
        data-opt="${it.act}"${it.disabled ? ' disabled' : ''}${it.checked === undefined ? '' : ` role="menuitemcheckbox" aria-checked="${it.checked}"`}${it.marked ? ' title="This chat holds texts of its own"' : ''}>
        <i class="fa-solid ${it.icon}"></i><span>${CoreAPI.escapeHtml(it.label)}</span>${tick}${mark}
    </button>`;
}

function convCloseOptions() {
    document.getElementById('chatConvOptionsMenu')?.remove();
    document.getElementById('chatConvOptions')?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', convOptionsOutside, true);
}

function convOptionsOutside(e) {
    if (e.target.closest('#chatConvOptionsMenu, #chatConvOptions')) return;
    convCloseOptions();
}

function convToggleOptions() {
    if (document.getElementById('chatConvOptionsMenu')) { convCloseOptions(); return; }

    const groups = convOptionGroups();
    // Mobile gets the canonical bottom sheet, so it inherits drag-dismiss and the back
    // stack rather than a dropdown anchored off the bottom of the screen.
    const sheet = CoreAPI.isMobileMode() ? CoreAPI.createMobileSheet() : null;
    if (sheet) {
        // insertAdjacentHTML, never innerHTML: the builder has already appended the drag
        // handle, and assigning innerHTML deletes it.
        sheet.sheet.insertAdjacentHTML('beforeend', groups.map(g => `
            <div class="mobile-sheet-group-title">${CoreAPI.escapeHtml(g.title)}</div>
            ${g.layout === 'grid'
                ? `<div class="chat-conv-win-grid">${g.items.map(convWinTileHtml).join('')}</div>`
                : g.items.map(convOptionItemHtml).join('')}`).join(''));
        sheet.sheet.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-opt]');
            if (!btn || btn.disabled) return;
            // a switch leaves the sheet open and redraws its row, so flipping three isnt three trips
            if (btn.dataset.opt.startsWith('display:')) {
                convToggleDisplay(btn.dataset.opt.slice('display:'.length));
                convRefreshOptionStates(sheet.sheet);
                return;
            }
            sheet.close();
            convRunOption(btn.dataset.opt);
        });
        sheet.open();
        return;
    }

    const host = document.querySelector('.chat-conv-composer');
    if (!host) return;
    host.insertAdjacentHTML('beforeend', `
        <div id="chatConvOptionsMenu" class="dropdown-menu chat-conv-options-menu">
            ${groups.map(g => `
                <div class="dropdown-section-title">${CoreAPI.escapeHtml(g.title)}</div>
                ${g.items.map(convOptionItemHtml).join('')}`).join('')}
        </div>`);
    document.getElementById('chatConvOptions')?.setAttribute('aria-expanded', 'true');
    const menu = document.getElementById('chatConvOptionsMenu');
    menu?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-opt]');
        if (!btn || btn.disabled) return;
        if (btn.dataset.opt.startsWith('display:')) {
            convToggleDisplay(btn.dataset.opt.slice('display:'.length));
            convRefreshOptionStates(menu);
            return;
        }
        convCloseOptions();
        convRunOption(btn.dataset.opt);
    });
    // capture so a click on any app chrome closes it, not just the pane
    document.addEventListener('click', convOptionsOutside, true);
}

// redraw the ticks in an open menu without a rebuild, which would drop its scroll
function convRefreshOptionStates(root) {
    if (!root) return;
    for (const t of convDisplayToggles()) {
        for (const btn of root.querySelectorAll(`[data-opt="display:${t.key}"]`)) {
            const state = btn.querySelector('.chat-conv-opt-state');
            if (!state) continue;
            btn.setAttribute('aria-checked', String(t.on));
            state.classList.toggle('fa-toggle-on', t.on);
            state.classList.toggle('is-on', t.on);
            state.classList.toggle('fa-toggle-off', !t.on);
        }
    }
}

function convRunOption(act) {
    // a windows tile clicks its header opener, display:none on mobile but kept in the DOM for this
    if (act.startsWith('win:')) return document.getElementById(act.slice(4))?.click();
    if (act.startsWith('ext:')) return extRunAction(act.slice(4), convActionContext());
    switch (act) {
        // Background keeps a row under Display on every platform, because a wallpaper is
        // what a reader looks for there rather than among the windows.
        case 'background': return document.getElementById('chatConvBackground')?.click();
        case 'rename': return convRenameChat();
        case 'new-chat': return _convChar ? createNewChat(_convChar) : undefined;
        case 'copy-markdown': return convCopyAsMarkdown();
        case 'export': return convExportJsonl();
        case 'character': return convOpenCharacter();
        case 'card-texts': return convOpenCardTexts();
        case 'delete-chat': return convDeleteChat();
        case 'regenerate': return convGenerate({ regenerate: true });
        case 'continue': return convContinue();
        case 'guided': return convGuided();
        case 'impersonate': return convImpersonate();
        case 'copy-last': return convCopyLastReply();
        default: return undefined;
    }
}

// Nobody wants JSONL on a clipboard; the export endpoint stays for restoring into ST.
async function convCopyAsMarkdown() {
    const text = _convMessages.map(e => e.raw)
        .filter(m => m?.mes || m?.swipes?.length)
        .map(m => `**${m.is_user ? convUserDisplayName(m) : (m.name || _convChar?.name || 'Character')}:** ${getMessageDisplayText(m)}`)
        .join('\n\n');
    if (await CoreAPI.copyTextToClipboard(text)) CoreAPI.showToast('Chat copied as markdown', 'success');
    else CoreAPI.showToast('Could not copy the chat', 'error');
}

async function convCopyLastReply() {
    const last = _convMessages.map(e => e.raw).reverse().find(m => !m.is_user && !m.is_system);
    if (!last) { CoreAPI.showToast('No reply to copy yet', 'info'); return; }
    if (await CoreAPI.copyTextToClipboard(getMessageDisplayText(last) || '')) CoreAPI.showToast('Reply copied', 'success');
    else CoreAPI.showToast('Could not copy the reply', 'error');
}

// fetched, not linked: apiRequest carries the session and the server base, so it works detached and under auth
async function convExportJsonl() {
    if (!_convChatId) return;
    try {
        const resp = await CoreAPI.apiRequest(`/chats/${encodeURIComponent(_convChatId)}/export`, 'GET');
        if (!resp.ok) throw new Error(`server returned ${resp.status}`);
        const name = document.getElementById('chatConvSub')?.textContent || 'chat';
        CoreAPI.downloadBlobAsFile(new Blob([await resp.text()], { type: 'application/jsonl' }), `${name}.jsonl`);
    } catch (e) {
        CoreAPI.showToast(`Could not export: ${e.message}`, 'error');
    }
}

function convOpenCharacter() {
    if (_convChar) openCharacterDetailsFromChats(_convChar.id);
}

async function convDeleteChat() {
    if (!_convChatId) return;
    await deleteChatVerb({ id: _convChatId, name: document.getElementById('chatConvSub')?.dataset.rawName || '' });
}

async function convRenameChat() {
    if (!_convChatId) return;
    const subEl = document.getElementById('chatConvSub');
    const current = subEl?.dataset.rawName ?? subEl?.textContent ?? '';
    const name = await CoreAPI.showConfirm({
        title: 'Rename chat',
        confirmLabel: 'Rename',
        input: { value: current, placeholder: 'Chat name' },
    });
    // a blank is refused here: the server maps it to no-rename while answering ok
    if (typeof name !== 'string' || !name.trim() || name === current) return;
    try {
        await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/chats/${encodeURIComponent(_convChatId)}`, 'PATCH', { name: name.trim() }));
        const sub = document.getElementById('chatConvSub');
        if (sub) { sub.textContent = name.trim(); sub.dataset.rawName = name.trim(); }
        renameChatLocally(_convChatId, name.trim());
    } catch (e) {
        CoreAPI.showToast(`Could not rename: ${e.message}`, 'error');
    }
}

/**
 * Continue appends into the last reply rather than starting a turn, which is what the
 * reader wanted when they stopped one mid-sentence.
 */
function convContinue() {
    const last = _convMessages[_convMessages.length - 1];
    if (!last || last.raw.is_user || last.raw.is_system) {
        CoreAPI.showToast('There is no reply to continue', 'info');
        return;
    }
    return convGenerate({ mode: 'continue', targetSeq: last.seq });
}

// impersonate's wait: a quiet spinner chip takes the textarea's slot, so the bar keeps its shape
function convGenHint(on, label = 'Generating...') {
    const { input, composer } = convEls();
    const hint = document.getElementById('chatConvGenHint');
    if (!on) {
        hint?.remove();
        composer?.classList.remove('gen-wait');
        return;
    }
    if (!composer || !input || hint) return;
    composer.classList.add('gen-wait');
    input.insertAdjacentHTML('beforebegin',
        `<span id="chatConvGenHint" class="chat-conv-gen-hint"><i class="fa-solid fa-circle-notch fa-spin"></i>${CoreAPI.escapeHtml(label)}</span>`);
}

async function convImpersonate() {
    if (!isConversationOpen() || _convAbort || _convSending) return;
    const { input } = convEls();
    if (!input) return;
    const chatId = _convChatId;
    const existing = input.value;
    convClearError();
    convSetBusy(true);
    input.value = '';
    convAutosize(input);
    convGenHint(true);
    _convAbort = new AbortController();
    fireEvent('generation.started', { chatId, mode: 'impersonate', targetSeq: null });
    let draft = '';
    // the box is written and fitted on the reply's painter (a fit forces layout), only while this chat is shown
    const writeBox = (text) => { if (_convChatId === chatId) { input.value = text; convAutosize(input); } };
    const painter = createLivePainter({ paint: () => writeBox(draft), held: () => _convSuspended || document.hidden });
    const landBox = (text) => { painter.stop(); writeBox(text); };
    try {
        await CoreAPI.streamChatGeneration(chatId, {
            mode: 'impersonate',
            // what is typed STEERS the draft: half a sentence is the clearest intent the reader can give
            guidance: existing.trim(),
            signal: _convAbort.signal,
        }, (ev) => {
            if (_convChatId !== chatId) return;
            if (typeof ev?.text === 'string') {
                if (!draft) convGenHint(false);
                draft += ev.text;
                // parked or hidden, nothing is written and the last write lands it whole
                painter.mark();
            }
        });
        landBox(draft);
        // a draft is never stored, so there is no seq or id to name
        fireEvent('generation.ended', { chatId, mode: 'impersonate', seq: null, messageId: null });
    } catch (e) {
        fireEvent('generation.failed', { chatId, mode: 'impersonate', cancelled: !!e?.isCancelled, error: e?.isCancelled ? null : (e?.message || 'Could not write a message') });
        if (!e?.isCancelled) convShowError(e.message || 'Could not write a message');
        // Whatever arrived is still a draft worth keeping; only a total failure restores.
        landBox(draft || existing);
    } finally {
        convGenHint(false);
        _convAbort = null;
        convSetBusy(false);
        input.focus();
    }
}

// The character-side twin of impersonate: the composer text is DIRECTION for the
// character's next reply, never a message; it reaches only the prompt's trailing instruction.
async function convGuided() {
    if (!isConversationOpen() || _convAbort || _convSending) return;
    const { input } = convEls();
    const guidance = (input?.value || '').trim();
    if (!guidance) { CoreAPI.showToast("Type a direction for the character's next reply first", 'info'); return; }
    input.value = '';
    convAutosize(input);
    return convGenerate({ regenerate: false, guidance });
}

// box, hint, gate and send/stop come back when the filter wait ends or is abandoned
function convReleaseSendWait() {
    _convSendWait = null;
    _convSending = false;
    const { input, send, stop } = convEls();
    if (input) input.readOnly = false;
    convGenHint(false);
    send?.classList.toggle('hidden', !!_convAbort);
    stop?.classList.toggle('hidden', !_convAbort);
}

// answers whether the line was stored as the reader's message, once the reply it asked for has run
async function convSend() {
    if (!isConversationOpen() || _convAbort || _convSending) return false;
    const { input } = convEls();
    let text = (input?.value || '').trim();
    // Send on an empty box asks for a fresh reply to what is there, unless pictures wait; Continue is its own button
    if (!text && !_convTray.items.length) {
        if (_convMessages.length) await convGenerate({ regenerate: false });
        return false;
    }

    const chatId = _convChatId;
    // an extension may rewrite or take the line and take its time: the box is read-only meanwhile, Stop abandons
    if (hasHook('composer.send')) {
        const wait = { chatId, abandoned: false };
        _convSendWait = wait;
        _convSending = true;
        if (input) input.readOnly = true;
        convGenHint(true, 'Preparing your message...');
        const { send, stop } = convEls();
        send?.classList.add('hidden');
        stop?.classList.remove('hidden');
        const typed = text;
        try {
            text = String(await runFilterAsync('composer.send', text, Object.freeze({ chatId, charId: _convChar?.id ?? null }))).trim();
        } finally {
            // an abandoned wait was released already, and another may hold the box by now
            if (_convSendWait === wait) convReleaseSendWait();
        }
        if (wait.abandoned || _convChatId !== chatId) return false;
        // an extension that took the typed line took the send: the pictures wait for the next one
        if (!text && (typed || !_convTray.items.length)) {
            if (input) { input.value = ''; convAutosize(input); }
            clearDraft(chatId);
            return false;
        }
        // a stream claimed while the filter ran owns the rows now: the line stays in the box
        if (_convAbort) { if (input) { input.value = text; convAutosize(input); } return false; }
    }

    convClearError();
    input.value = '';
    convAutosize(input);

    // the pictures go with this send; a failed one gives them back with the text
    const pictures = _convTray.take();
    try {
        const stored = await convPostMessage(chatId, text, pictures.map(p => p.id));
        if (stored?.message) {
            // Sending is deliberate, so it re-pins even if the reader had scrolled up.
            convResetPin();
        }
        clearDraft(chatId);
    } catch (e) {
        convShowError(`Could not send: ${e.message}`);
        // Give the text back rather than losing it. The stored draft was never cleared,
        // so it also survives a reload from here.
        if (input) { input.value = text; convAutosize(input); }
        if (_convChatId === chatId) _convTray.giveBack(pictures);
        return false;
    }

    // the line is stored in its chat; a reader who moved to another one asks that one for no reply
    if (_convChatId !== chatId) return true;
    await convGenerate({ regenerate: false });
    return true;
}

// what a keystroke in the composer does: the box grows to its text and the draft follows
function convFollowInput(input) {
    convAutosize(input);
    queueDraftSave(_convChatId, input.value);
}

/** chat.compose: text in the open conversation's box as typing puts it; false with none open or the box held by a send. */
function convComposeText(text, mode = 'replace') {
    const { input } = convEls();
    if (!isConversationOpen() || !input || _convSending) return false;
    input.value = mode === 'append' && input.value ? `${input.value}\n${text}` : text;
    convFollowInput(input);
    input.setSelectionRange(input.value.length, input.value.length);
    // a phone keeps its keyboard down until the reader taps the box
    if (!CoreAPI.isMobileMode()) input.focus();
    return true;
}

/** chat.send: the text sent through Send's own path; false with none open, a reply on its way, or no text. */
async function convSendText(text) {
    if (_convAbort || !text.trim() || !convComposeText(text, 'replace')) return false;
    return convSend();
}

// the first message the transcript shows, which {{firstDisplayedMessageId}} answers
function convFirstShown() {
    const seq = _convMessages[0]?.seq;
    return Number.isInteger(seq) ? seq : null;
}

/** Store the user's line, its pictures named by id, and adopt the SERVER's message (id, seq, stamp); null if the reader left the chat meanwhile. */
async function convPostMessage(chatId, text, attachments = []) {
    const first = convFirstShown();
    const stored = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/chats/${encodeURIComponent(chatId)}/messages`, 'POST', {
        mes: text, ...(attachments.length ? { attachments } : {}), ...(Number.isInteger(first) ? { firstShown: first } : {}),
    }));
    if (_convChatId !== chatId) return null;
    if (stored?.message) {
        _convMessages.push(stored.message);
        convAppendMessage(stored.message);
    }
    return stored;
}

// ========================================
// THE COMPOSER'S PICTURES
// ========================================

// only a connection known to see pictures offers attaching; pictures already waiting stay
function convPaintAttach() {
    const btn = document.getElementById('chatConvAttach');
    if (btn) btn.hidden = _convSees !== true;
    document.dispatchEvent(new CustomEvent('cl-chat-sight'));
}

/** Put pictures in the chat's gallery and hold them for the next send, answering how many; a chat left mid-upload holds nothing over. */
async function convAttachFiles(files, chatId = _convChatId) {
    if (!chatId || _convSees !== true) return 0;
    return attachToChat(_convTray, chatId, files, () => _convChatId === chatId);
}

/** A gallery window's picture ({attachmentId?, name, src}) for the next send; one not the chat's is copied into its gallery first. */
async function convAttachPicture(item) {
    // the chat is captured before the bytes are read, so a switch meanwhile copies nothing into the next one
    const chatId = _convChatId;
    if (!chatId || !item) return false;
    if (_convSees !== true) { CoreAPI.showToast("This chat's connection is not set as seeing pictures", 'info'); return false; }
    if (item.attachmentId) {
        _convTray.add({ kind: 'attachment', id: item.attachmentId, name: item.name });
        return true;
    }
    let blob = null;
    try {
        const resp = item.src ? await fetch(item.src) : null;
        if (resp?.ok) blob = await resp.blob();
    } catch { /* said below */ }
    if (!blob) { CoreAPI.showToast('Could not read that picture', 'error'); return false; }
    if (_convChatId !== chatId) return false;
    return (await convAttachFiles([new File([blob], item.name || 'picture.png', { type: blob.type || 'image/png' })], chatId)) > 0;
}

// a message's pictures under its text, each a tap from full screen
function convPicturesHtml(entry) {
    return picturesHtml((Array.isArray(entry.attachments) ? entry.attachments : []).map(a => ({ kind: 'attachment', id: a.id, name: a.name })));
}

function convOpenPicture(btn) {
    const mid = convMidOf(btn.closest('.chat-conv-msg'));
    openPictures(_convMessages.find(m => m.id === mid)?.attachments, btn.dataset.index, _convChar?.name || 'Pictures');
}

async function convGenerate({ regenerate = false, mode = null, targetSeq = null, targetId = null, guidance = null } = {}) {
    if (!isConversationOpen() || _convAbort || _convSending) return;
    const chatId = _convChatId;
    // every path asks for a reply, so re-pin; both rewrites stream into the last reply; the named message wins
    const rewrites = mode === 'regenerate' || mode === 'swipe' || regenerate === true;
    const last = _convMessages[_convMessages.length - 1] ?? null;
    const target = Number.isInteger(targetId) ? (_convMessages.find(e => e.id === targetId) ?? null)
        : Number.isInteger(targetSeq) ? convEntryAtSeq(targetSeq)
        : (rewrites && last && !last.raw.is_user && !last.raw.is_system) ? last
        : null;
    if (Number.isInteger(targetId) && !target) {
        convShowError('That message is no longer in the chat');
        return;
    }
    const inPlaceSeq = target ? target.seq : Number.isInteger(targetSeq) ? targetSeq : null;
    // the row is named on the wire by place and id; a reroll with no reply to rewrite names the trailing message shown
    const wireSeq = inPlaceSeq;
    const named = target ?? (rewrites && !Number.isInteger(inPlaceSeq) ? last : null);
    const wireId = named?.id ?? null;
    // and what it shows: another active alternate there is refused before the model is asked, so a stale page grows nothing unseen
    const wireShown = named ? convShownOf(named.raw) : null;

    // A rewrite settles by replacing the target row wholesale, and an open editor on it goes
    // with it, typed text and all.
    if (Number.isInteger(inPlaceSeq) && convRowEl(inPlaceSeq)?.querySelector('.chat-conv-edit')) {
        CoreAPI.showToast('Finish or cancel the edit on that message first', 'info');
        return;
    }
    // the greeting is the card's: swiping pages it, and regenerating has no reply to regenerate
    if (rewrites && Number.isInteger(inPlaceSeq) && convIsGreetingRow(convIndexOfSeq(inPlaceSeq))) {
        CoreAPI.showToast('The greeting comes from the card: swipe through its alternates or edit it', 'info');
        return;
    }

    convResetPin();
    convClearError();
    convEls().list?.querySelectorAll('.chat-conv-msg.gen-error').forEach(el => el.classList.remove('gen-error'));
    convSetBusy(true);
    _convAbort = new AbortController();
    _convStopEcho = null;
    const wireMode = mode || (regenerate ? 'regenerate' : 'append');
    fireEvent('generation.started', { chatId, mode: wireMode, targetSeq: Number.isInteger(wireSeq) ? wireSeq : null });

    const bubble = convOpenLiveBubble(inPlaceSeq);
    // Continue EXTENDS: the live buffer starts as the existing text, so nothing vanishes and snaps back
    if (mode === 'continue' && bubble && Number.isInteger(inPlaceSeq)) {
        const seedFrom = convEntryAtSeq(inPlaceSeq);
        if (seedFrom) {
            const stored = getMessageDisplayText(seedFrom.raw) || '';
            _convLiveText = stored;
            _convReplyReveal.seed(stored.length);
            // nothing streams with the switch off, so the stored text is written once and waits there
            if (convStreams()) {
                _convLiveDirty = true;
                convMarkLive();
            } else {
                bubble.innerHTML = convRenderText(stored, _convChar?.name || '');
                _convLiveShownText = stored;
            }
        }
    }
    let sawText = false;
    let sawDone = false;
    let doneSeq = null;
    let doneId = null;
    // the generation's end belongs to its chat: the stored reply's seq and id, or a failure for a stream cut without a final frame
    const tellEnded = () => (sawText && !sawDone
        ? fireEvent('generation.failed', { chatId, mode: wireMode, cancelled: false, error: 'The connection dropped before the reply finished' })
        : fireEvent('generation.ended', { chatId, mode: wireMode, seq: doneSeq, messageId: doneId }));
    try {
        await CoreAPI.streamChatGeneration(chatId, {
            ...(wireMode !== 'append' ? { mode: wireMode } : {}),
            ...(Number.isInteger(wireSeq) ? { targetSeq: wireSeq } : {}),
            ...(Number.isInteger(wireId) ? { targetId: wireId, targetShown: wireShown } : {}),
            ...(guidance ? { guidance } : {}),
            firstShown: convFirstShown(),
            signal: _convAbort.signal,
        }, (ev) => {
            if (ev?.done) {
                sawDone = true;
                doneSeq = Number.isInteger(ev.done.seq) ? ev.done.seq : null;
                doneId = Number.isInteger(ev.done.id) ? ev.done.id : null;
            }
            if (_convChatId !== chatId) return;
            if (typeof ev?.text === 'string' && bubble) {
                sawText = true;
                _convLiveText += ev.text;
                convPaintLive();
            } else if (typeof ev?.reasoning === 'string') {
                // On a reasoning model this is the only thing arriving for the first
                // thirty seconds. Without it the reader watches a caret blink.
                _convLiveReasoning += ev.reasoning;
                convPaintLiveReasoning();
            } else if (ev?.done) {
                sawDone = true;
                if (!ev.done.message) return;
                // A swipe generation appends into an EXISTING row rather than creating
                // one, so its result updates in place instead of extending the history.
                const at = Number.isInteger(ev.done.seq) ? convIndexOfSeq(ev.done.seq) : -1;
                if (at !== -1) _convMessages[at] = ev.done.message;
                else _convMessages.push(ev.done.message);
                if (ev.done.budget) _convBudget = ev.done.budget;
                convAddSessionUsage(ev.done.usage);
                // the greeting this build expanded and stored: the feed skips this tab's own writes, so adopt it from the done frame
                if (ev.done.firstMessage && _convMessages[0]?.seq === 0 && at !== 0) {
                    _convMessages[0] = ev.done.firstMessage;
                    renderConversation(_convMessages);
                }
            }
        });
        if (_convChatId !== chatId) { tellEnded(); return; }
        // a stream that just STOPS (no final frame, a proxy idle-cut) is a failure: ask the server what survived and say so
        if (sawText && !sawDone) {
            const seen = convLandFrom();
            const away = convPlaceAway();
            convStopLive();
            document.querySelector('[data-live="1"]')?.removeAttribute('data-live');
            convShowError('The connection dropped before the reply finished. Showing what the server kept.');
            tellEnded();
            await convReloadMessages();
            if (_convChatId === chatId) convLandReread(seen, true, away);
            return;
        }
        // a paced reveal shows the rest first; Stop or switching pacing off ends that wait at once
        const caughtUp = convLiveCatchUp();
        if (caughtUp) {
            await caughtUp;
            if (_convChatId !== chatId) { tellEnded(); return; }
        }
        // where the reader picks the reply up, read before the settle replaces what they saw
        const seen = convLandFrom();
        // the stored row replaces the live bubble so the finished turn goes through the gate; the rest stays untouched
        convSettleLiveBubble();
        convApplyContextMarker();
        if (seen === null) convScrollToEnd();
        else convLandReplyStart(Number.isInteger(doneSeq) ? doneSeq : _convMessages[_convMessages.length - 1]?.seq, seen);
        convSignalComplete();
        tellEnded();
    } catch (e) {
        // read before the stop below drops what the reader saw, and before a re-read can clamp the reader's place
        const seen = convLandFrom();
        const away = convPlaceAway();
        fireEvent('generation.failed', { chatId, mode: wireMode, cancelled: !!e?.isCancelled, error: e?.isCancelled ? null : (e?.message || 'Generation failed') });
        // the server may still store the reply once the hang-up reaches it, as this tab's write: its echo is heard
        if (e?.isCancelled && !sawDone) _convStopEcho = chatId;
        if (_convChatId !== chatId) return;
        convStopLive();
        // only a phantom bubble is removed; an in-place stream sits on a real row, which the reload repaints
        const dead = document.querySelector('[data-live="1"]');
        if (Number.isInteger(inPlaceSeq)) { dead?.classList.remove('streaming'); dead?.removeAttribute('data-live'); }
        else dead?.remove();
        // a refusal that only means the page was behind is no failed generation: no mark, the truth read through the gate
        if (!e?.isCancelled && (e?.status === 409 || e?.status === 404)) {
            convShowError('That message changed elsewhere since it was shown; nothing was written.');
            // owed to an open editor's close, the row the stream took shows the page's copy meanwhile
            const held = Number.isInteger(inPlaceSeq) && convEditorOpen() ? convEntryAtSeq(inPlaceSeq) : null;
            if (held) convReplaceMessage(held);
            await convRereadOrOwe();
            return;
        }
        if (!e?.isCancelled) {
            convShowError(e.message || 'Generation failed', /no llm profile/i.test(String(e?.message))
                ? { label: 'Open Connections', onAction: () => document.getElementById('chatConvConnections')?.click() }
                : null);
        }
        // Nothing is said on a deliberate stop when the fragment was discarded: the
        // transcript going back to how it was IS the feedback.
        else if (sawText && CoreAPI.getSetting('chatKeepInterrupted') === true) {
            convShowError('Stopped. What had arrived was kept, so you can edit it or continue it.');
        }
        // no done frame, yet the server keeps what arrived; repainting from the local copy deleted it, so ask the server
        await convReloadMessages();
        // a kept fragment lands in the server's close handler, maybe after that read: look once more a beat later
        if (e?.isCancelled && sawText && CoreAPI.getSetting('chatKeepInterrupted') === true
            && !_convMessages[_convMessages.length - 1]?.raw?.extra?.interrupted) {
            await new Promise(r => setTimeout(r, 400));
            await convReloadMessages();
        }
        // the re-reads waited: a chat opened meanwhile owns the list
        if (_convChatId !== chatId) return;
        // the re-read rebuilt the turn; a kept one lands as a finished reply would, never left below the fold
        convLandReread(seen, sawText && (!e?.isCancelled || CoreAPI.getSetting('chatKeepInterrupted') === true), away);
        // marked after the re-read, which rebuilds the row a rewrite streamed into
        if (!e?.isCancelled) convRowEl(_convMessages[_convMessages.length - 1]?.seq)?.classList.add('gen-error');
    } finally {
        _convAbort = null;
        convSetBusy(false, { replied: true });
    }
}

/** The arrows' gate: they step the alternates only outside a field and with no modifier held. */
function convTypingInField(e) {
    const t = e.target;
    return !!t?.matches?.('input, textarea, select, [contenteditable], [contenteditable="true"]');
}

// the commands' keys come from the keymap, which keeps a single key out of a field
function convOnKeydown(e) {
    if (!isConversationOpen()) return;

    // Stop works from anywhere, including mid-typing, because that is when you want it.
    if (Keymap.is(e, 'conversation.stop') && (_convAbort || _convSendWait)) { e.preventDefault(); convAbortGeneration(); return; }
    // the open gallery acts first on its own keys and the arrows; what it took stays its own
    if (e.defaultPrevented) return;

    const lastSeq = _convMessages[_convMessages.length - 1]?.seq;
    if (Keymap.is(e, 'conversation.focusInput')) {
        e.preventDefault();
        convEls().input?.focus();
        return;
    }
    if (Keymap.is(e, 'conversation.latest')) {
        e.preventDefault();
        convResetPin();
        return;
    }
    if (Keymap.is(e, 'conversation.regenerate')) { e.preventDefault(); return void convRunOption('regenerate'); }
    if (Keymap.is(e, 'conversation.continue')) { e.preventDefault(); return void convRunOption('continue'); }
    if (Keymap.is(e, 'conversation.impersonate')) { e.preventDefault(); return void convRunOption('impersonate'); }
    if (Keymap.is(e, 'conversation.editLast')) {
        // the row actions' gate: an editor over a row a rewrite streams into loses its text at the settle
        if (convRowActionsLocked() || !Number.isInteger(lastSeq)) return;
        e.preventDefault();
        convBeginEdit(lastSeq);
        return;
    }
    if (convTypingInField(e) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // the open gallery owns the arrows (it steps images on the same keys)
        if (GalleryPanel.isOpen()) return;
        if (convRowActionsLocked() || !Number.isInteger(lastSeq)) return;
        e.preventDefault();
        convSwipe(lastSeq, e.key === 'ArrowRight' ? 1 : -1);
    }
}

function convAutosize(el) {
    // held through the measure, whose collapse would grow the list and clamp the reader's scroll
    CoreAPI.fitTextarea(el, { freeze: el.closest('.chat-conv-composer') });
}

function initConversation() {
    const { input, send, stop } = convEls();
    document.getElementById('chatConvBack')?.addEventListener('click', closeConversation);
    // Minimize is plain navigation: switchView's bridge is what parks the chat.
    document.getElementById('chatConvMinimize')?.addEventListener('click', () => CoreAPI.goToView('characters'));
    // a narrow window keeps the openers that fit; the rest wait behind More, which carries their dots
    const headRight = document.querySelector('#chatConvHeader .chat-conv-header-right');
    if (headRight) CoreAPI.fitRow(headRight, {
        entries: () => [...headRight.querySelectorAll('button:not(.chat-conv-minimize):not(.chat-conv-more)')],
        more: document.getElementById('chatConvMore'),
        current: '.is-panel-open',
        marked: '.is-marked, .has-embedded-lore',
        working: '.is-working',
        separators: '.chat-conv-head-sep, .cxw-sep',
    });
    // the composer's strip keeps the buttons that fit, the rest labelled behind its More
    const strip = document.getElementById('chatConvActions');
    if (strip) {
        CoreAPI.fitRow(strip, {
            entries: () => [...strip.querySelectorAll('.chat-conv-ext-btn:not(.chat-conv-ext-more)')],
            more: document.getElementById('chatConvActionsMore'),
            separators: '.chat-conv-ext-sep',
        });
        strip.addEventListener('click', convOnComposerAction);
    }
    send?.addEventListener('click', convSend);
    stop?.addEventListener('click', convAbortGeneration);
    // pictures for the next message: the button, a paste into the box, a drop on the composer or the transcript
    const picker = document.getElementById('chatConvAttachInput');
    document.getElementById('chatConvAttach')?.addEventListener('click', () => picker?.click());
    wirePictureInputs({ box: input, picker, drops: [convEls().composer, convEls().list], attach: convAttachFiles, blocked: () => !_convChatId || _convSees !== true });
    document.getElementById('chatConvPending')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tray-remove]');
        if (btn) _convTray.removeAt(Number(btn.dataset.trayRemove));
    });

    // the lore panel is a VIEW of this conversation: hand it the context, never let it reach back in
    document.getElementById('chatConvLore')?.addEventListener('click', () => {
        if (!_convChatId) return;
        LorePanel.togglePanel({
            chatId: _convChatId,
            char: _convChar,
            chatMeta: _convChatMeta,
            embeddedLorebook: _convEmbeddedLore,
        });
    });

    document.addEventListener('cl-embedded-lore-resolved', convFollowEmbeddedResolved);
    document.addEventListener('cl-mobile-mode-change', convPaintCardMark);

    // The portrait and this button are the same door: both open the gallery window.
    document.getElementById('chatConvGallery')?.addEventListener('click', () => convOpenGallery());
    document.getElementById('chatConvAvatar')?.addEventListener('click', () => convOpenGallery());
    document.getElementById('chatConvBackground')?.addEventListener('click', () => convOpenBackground());
    document.getElementById('chatConvSettings')?.addEventListener('click', () => convOpenSettings());
    document.getElementById('chatConvPersonas')?.addEventListener('click', () => convOpenPersonas());
    // the inspector asks the server to build the prompt fresh on every open, never a cached guess
    document.getElementById('chatConvInspect')?.addEventListener('click', () => {
        if (_convChatId) PromptInspector.togglePanel({ chatId: _convChatId, firstShown: convFirstShown });
    });
    // the assistant is bound to the chat; it re-points itself off cl-chat-changed like the lore panel
    document.getElementById('chatConvAssistant')?.addEventListener('click', () => {
        if (_convChatId) Assistant.togglePanel({ chatId: _convChatId, char: _convChar });
    });
    // Quick buttons are a shortcut into the options inventory, never a second
    // implementation with its own rules.
    document.getElementById('chatConvOptions')?.addEventListener('click', convToggleOptions);
    document.getElementById('chatConvContinue')?.addEventListener('click', () => convRunOption('continue'));
    document.getElementById('chatConvGuided')?.addEventListener('click', () => convRunOption('guided'));
    document.getElementById('chatConvImpersonate')?.addEventListener('click', () => convRunOption('impersonate'));
    // The character's NAME opens the character, which is what a name reads as everywhere else.
    const convTitle = document.getElementById('chatConvTitle');
    convTitle?.addEventListener('click', convOpenCharacter);
    // It is a div with role=button, so it gets the keyboard behaviour a button would have
    // given it for free.
    convTitle?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        convOpenCharacter();
    });

    // a card edited mid-chat: the header follows; the prompt needs nothing, the server rebuilds it every generate
    document.addEventListener('cl-character-changed', (e) => {
        const id = e.detail?.charId;
        if (!id || !isConversationOpen() || id !== _convChar?.id) return;
        // re-READ: the event names which character, never what to, so the card-write rules live in one place
        const fresh = CoreAPI.getCharacterById(id);
        const renamed = !!fresh && fresh.name !== _convChar?.name;
        if (fresh) _convChar = fresh;
        convPaintCharacterChrome();
        // only a rename touches the transcript (the name is baked into every row); an avatar swap rebuilds nothing
        if (renamed && _convMessages.length) convRebuildRows();
    });

    // an assistant apply makes the transcript stale: re-read in full, since a batch delete renumbers every later seq
    document.addEventListener('cl-assistant-edited-chat', (e) => {
        if (!isConversationOpen() || e.detail?.chatId !== _convChatId) return;
        void convRereadOrOwe();
    });

    document.addEventListener('keydown', convOnKeydown);
    input?.addEventListener('input', () => convFollowInput(input));
    // a backgrounded tab paints and ticks nothing; the partial and the stamps land in one pass when it returns
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (_convLiveEl?.isConnected) _convSightGap = true;
            return;
        }
        convScheduleLivePaint();
        convTickClock();
    });
    // the pin hears the list's scroll, wheel and touch itself; told when it is taken or let go, the pill follows
    _convPin.watch((pinned) => {
        if (pinned) _convMissedWhileAway = false;
        convSyncJumpPill();
    });
    _convPin.reset();
    // away, the pill follows how far there is to jump: the list's scroll, and its own resizes (a growing composer, the window)
    const list = convEls().list;
    list?.addEventListener('scroll', convSyncJumpPill, { passive: true });
    if (list) new ResizeObserver(convSyncJumpPill).observe(list);
    // One delegated listener for every row action; per-row listeners would need re-attaching on each replacement.
    convEls().list?.addEventListener('click', convOnRowAction);
    // a row's first touch builds its overflow ahead of the hover or tap that opens it
    convEls().list?.addEventListener('pointerover', (e) => convEnsureRowActions(e.target.closest('.chat-conv-msg')));
    convEls().list?.addEventListener('focusin', (e) => convEnsureRowActions(e.target.closest('.chat-conv-msg')));
    document.getElementById('chatConvJump')?.addEventListener('click', () => {
        convResetPin();
    });
    input?.addEventListener('keydown', (e) => {
        // Enter sends, Shift+Enter breaks the line. Mobile keeps Enter as newline
        // because there is a send button and no comfortable modifier.
        if (e.key === 'Enter' && !e.shiftKey && !CoreAPI.isMobileMode()) {
            e.preventDefault();
            convSend();
        }
    });

    initConversationWindow();
    convApplyMeasure();

    // viewLevel: the conversation is a VIEW and must close LAST (back over the details closed the chat underneath)
    window.registerOverlay?.({
        id: 'chatsConversation',
        tier: 1,
        viewLevel: true,
        close: () => closeConversation(),
        // the cl-chat-open conjunct keeps Escape and the back sweep off a parked conversation (its pane never carries .hidden)
        visible: (el) => !el.classList.contains('hidden') && document.documentElement.classList.contains('cl-chat-open'),
    });
}

// ========================================
// CHAT ACTIONS (from preview modal / chats view)
// ========================================

// callable from a card, the modal's tab or the options menu, so it shows the chats view before the pane
async function openChatFor(chat) {
    enterChatsForConversation();
    const opened = openConversation(chat);
    // from the modal's tab the list may be cold; it loads behind the pane for the way back to the grid
    if (!_chatRows.size) void loadAllChats();
    await opened;
}

/**
 * Open a chat by id (an extension, a link), read from the server so the list's page, sort and filter dont matter.
 * @param {string} chatId
 * @param {{seq?: number, messageId?: number}} [opts] the message to reveal; messageId wins over seq
 * @returns {Promise<boolean>} whether that chat is now the open conversation
 */
async function openChatById(chatId, { seq, messageId } = {}) {
    const id = typeof chatId === 'string' ? chatId.trim() : '';
    if (!id) return false;
    if (isConversationOpen() && _convChatId === id) {
        // resuming a parked conversation keeps its stream and its composer line; the details
        // modal goes the way the fresh open's enterChatsForConversation takes it
        CoreAPI.hideModal('charModal');
        if (CoreAPI.getCurrentView() !== 'chats') CoreAPI.switchView('chats');
    } else {
        let row = null;
        try {
            // the chat's own row with one message, not the history: the open reads that itself
            const resp = await CoreAPI.apiRequest(`/chats/${encodeURIComponent(id)}?msgTail=1`, 'GET');
            if (resp.ok) row = await resp.json();
        } catch {
            row = null;
        }
        if (!row?.id) return false;
        await openChatFor(row);
        if (_convChatId !== id) return false;
        // a chat the loaded list never saw joins it behind the pane; an empty list is already loading
        if (_chatRows.size && !_chatRows.has(id)) void loadAllChats(true);
    }
    // a message named by id is found where it sits now; one gone since reveals nothing
    const at = Number.isInteger(messageId) ? (_convMessages.find(e => e.id === messageId)?.seq ?? null) : seq;
    if (Number.isInteger(at)) await convRevealMessage(at);
    return true;
}

async function deleteChatFromView(chat) {
    await deleteChatVerb(chat);
}

// A list entry carries no character object (they resolve on demand), so every opener here names
// the id and the one door resolves it.
function openCharacterDetailsFromChats(charId) {
    if (!charId) return;
    // an EMPTY nav list, not absent: absent falls back to the grid's window and grows prev/next arrows
    void CoreAPI.openCharacterById(charId, { navList: [] });
}

// ========================================
// CHAT LORE (the chat's own lorebook list)
// ========================================
// A chat carries an ORDERED LIST of lorebooks (`worlds` on every chat row). The head is
// composed into chat_metadata.world_info on read, the key the exported JSONL header carries;
// nothing here writes it. Every mutation is an atomic apply, never a whole-list PUT.

// Cached world list for the picker, refreshed when the picker opens.
let _chatLoreWorlds = null;
// The chat (from the per-character list) the picker is acting on.
let _chatLorePickerChat = null;

/**
 * The chat's lorebook list off a list entry (no network call); every row carries `worlds`.
 * @returns {string[]} ordered world names, [] when none
 */
function getChatWorlds(chat) {
    return Array.isArray(chat?.worlds) ? chat.worlds : [];
}

// The card itself opens the chat, so there is no open button; the lore button is the one
// action beside delete.
/**
 * Every in-memory copy of one chat row, brought in line with the list that just landed on
 * the server: the list and the modal's list.
 */
function syncCachedChatWorlds(chatId, worlds) {
    const list = Array.isArray(worlds) ? worlds.slice() : [];
    const apply = (row) => {
        if (!row || row.id !== chatId) return false;
        row.worlds = list.slice();
        return true;
    };
    apply(_chatRows.get(chatId));
    for (const row of (_modalChatsList || [])) apply(row);
    // Debounced because the lorebook manager binds in a LOOP: a fifty-chat link would
    // otherwise be fifty full grid rebuilds.
    repaintChatSurfacesDebounced();
}

// renderChats no-ops while a conversation is open, and closing it rebuilds the grid, so
// this covers both ways back to the list.
const repaintChatSurfacesDebounced = CoreAPI.debounce(() => {
    renderChats();
    // only while the modal is up: _modalChatsChar outlives the close, so a closed modal would refetch forever
    const modalUp = !document.getElementById('charModal')?.classList.contains('hidden');
    if (_modalChatsChar && modalUp) fetchCharacterChats(_modalChatsChar, { background: true });
}, 150);

/**
 * Atomic add/remove on a chat's lorebook list; the caches take the server's answer, never a read-then-write.
 * @param {string} chatId - the chat row id; a chat is never addressed by its name
 * @param {{add?: string[], remove?: string[], source?: string}} delta - source lets the writing surface ignore its own echo
 * @returns {Promise<boolean>} success
 */
async function applyChatWorlds(chatId, { add = [], remove = [], source = 'chats' } = {}) {
    // Chat names are not unique, not even within one character, so the old
    // resolve-by-name path could bind a different chat than the one clicked.
    if (!chatId) {
        console.error('[ChatLore] applyChatWorlds needs a chat id:', { add, remove }, new Error().stack);
        return false;
    }
    try {
        const resp = await CoreAPI.apiRequest(`/chats/${encodeURIComponent(chatId)}/worlds/apply`, 'POST', { add, remove });
        if (!resp.ok) return false;
        const data = await resp.json();
        if (data.ok !== true) return false;
        // The write and the caches move together, so no caller has to remember to do this
        // and no caller can do it differently.
        syncCachedChatWorlds(chatId, data.worlds);
        const names = [...add, ...remove];
        CoreAPI.notifyWorldsChanged(names.length === 1 ? names[0] : null, source);
        return true;
    } catch (e) {
        console.error('[ChatLore] applyChatWorlds error:', e);
        return false;
    }
}

// the route's own cap on chatIds a request
const CHAT_WORLDS_CHUNK = 1000;

/**
 * Add/remove books on a set of chats (the applyCharWorlds sibling): one transaction a request, announced once.
 * @param {string[]} chatIds - chat row ids
 * @param {{add?: string[], remove?: string[], source?: string}} delta - source names the writing surface
 * @returns {Promise<{ok: boolean, deltas: Array<{chatId: string, added: string[], removed: string[], worlds: string[]}>, skipped: string[], error: string|null}>} skipped: ids with no chat; error: the server's words
 */
async function applyChatWorldsBatch(chatIds, { add = [], remove = [], source = 'chats' } = {}) {
    const ids = [...new Set((Array.isArray(chatIds) ? chatIds : []).filter(Boolean).map(String))];
    if (!ids.length || (!add.length && !remove.length)) return { ok: false, deltas: [], skipped: [], error: 'nothing to apply' };
    const deltas = [];
    const skipped = [];
    let error = null;
    let answered = false;
    for (let at = 0; at < ids.length && !error; at += CHAT_WORLDS_CHUNK) {
        try {
            const out = await CoreAPI.readAnswer(await CoreAPI.apiRequest('/chats/worlds/apply', 'POST', { chatIds: ids.slice(at, at + CHAT_WORLDS_CHUNK), add, remove }));
            answered = true;
            for (const d of out?.deltas || []) {
                syncCachedChatWorlds(d.chatId, d.worlds);
                deltas.push(d);
            }
            skipped.push(...(out?.skipped || []));
        } catch (e) {
            error = e?.message || 'the server did not answer';
        }
    }
    const names = [...add, ...remove];
    if (answered) CoreAPI.notifyWorldsChanged(names.length === 1 ? names[0] : null, source);
    return { ok: !error, deltas, skipped, error };
}

/**
 * A character's chats with metadata and lorebook lists, as raw rows; an unreadable list throws, never reads as none.
 * @param {Object} char - { id }
 * @returns {Promise<Array>} chat rows, each with chatMetadata and worlds
 */
async function listCharacterChatsWithMeta(char) {
    const charId = char?.id;
    if (!charId) return [];
    // the server's list rows, newest first, every page of them
    const rows = await CoreAPI.fetchAllPages('/chats', { charId, count: 'false' });
    return rows.map(r => ({ ...r, character: char }));
}

/**
 * Open the small picker to set/change/clear the bound lorebook for a single chat.
 * @param {Object} char - the character row ({ id, name })
 * @param {Object} chat - the chat row (its id and current binding)
 */
async function openChatLorePicker(char, chat) {
    _chatLorePickerChat = { char, chat };
    const modal = document.getElementById('chatLoreModal');
    if (!modal) { buildChatLoreModal(); }
    await readChatLoreShelf();
    renderChatLorePicker();
    document.getElementById('chatLoreModal')?.classList.add('visible');
}

// the shelf, or null when it could not be read: the picker says so and offers the read again
async function readChatLoreShelf() {
    try { _chatLoreWorlds = await CoreAPI.listWorldInfoFiles(); } catch { _chatLoreWorlds = null; }
}

function closeChatLorePicker() {
    document.getElementById('chatLoreModal')?.classList.remove('visible');
    _chatLorePickerChat = null;
}

function buildChatLoreModal() {
    const html = `
    <div id="chatLoreModal" class="cl-modal cl-modal-drawer cl-drawer-partial">
        <div class="cl-modal-content chat-lore-modal-content" data-fw-min="360x360">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-book-atlas cl-modal-header-icon"></i> Chat Lorebook</h3>
                <button class="cl-modal-close" id="chatLoreCloseBtn" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body chat-lore-body">
                <div class="chat-lore-subhead" id="chatLoreSubhead"></div>
                <div class="chat-lore-search-wrap">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input type="search" id="chatLoreSearch" class="cl-input chat-lore-search" placeholder="Search lorebooks..." autocomplete="off">
                </div>
                <div class="chat-lore-list" id="chatLoreList"></div>
            </div>
            <div class="cl-modal-footer chat-lore-footer">
                <button class="cl-cwin-btn-text is-danger" id="chatLoreClearBtn"><i class="fa-solid fa-link-slash"></i> Unbind All</button>
            </div>
        </div>
    </div>`;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstElementChild);
    CoreAPI.mountDialogSizing('chatLoreModal');

    document.getElementById('chatLoreCloseBtn')?.addEventListener('click', closeChatLorePicker);
    const modal = document.getElementById('chatLoreModal');
    modal?.addEventListener('click', (e) => { if (e.target === modal) closeChatLorePicker(); });
    document.getElementById('chatLoreSearch')?.addEventListener('input', renderChatLoreList);
    document.getElementById('chatLoreClearBtn')?.addEventListener('click', clearChatLore);
    document.getElementById('chatLoreList')?.addEventListener('click', (e) => {
        if (e.target.closest('[data-shelf-retry]')) { void readChatLoreShelf().then(renderChatLoreList); return; }
        const row = e.target.closest('[data-world]');
        if (row) toggleChatLore(row.dataset.world);
    });

    window.registerOverlay?.({
        id: 'chatLoreModal',
        tier: 3,
        close: () => closeChatLorePicker(),
        visible: (el) => el.classList.contains('visible'),
    });
}

function renderChatLorePicker() {
    const { chat } = _chatLorePickerChat || {};
    const bound = getChatWorlds(chat);
    const sub = document.getElementById('chatLoreSubhead');
    if (sub) {
        const chatName = displayChatName(chat);
        sub.innerHTML = bound.length
            ? `<strong>${bound.length}</strong> lorebook${bound.length === 1 ? '' : 's'} bound to chat "${CoreAPI.escapeHtml(chatName)}": ${CoreAPI.escapeHtml(bound.join(', '))}. Click a book to bind or unbind it.`
            : `Pick the lorebooks to bind to chat "${CoreAPI.escapeHtml(chatName)}".`;
    }
    const searchEl = document.getElementById('chatLoreSearch');
    if (searchEl) searchEl.value = '';
    const clearBtn = document.getElementById('chatLoreClearBtn');
    if (clearBtn) clearBtn.disabled = !bound.length;
    renderChatLoreList();
}

// bound books first in the chat's order, then the shelf; a bound name off the shelf is still a row, so it can be unbound
function chatLorePickerRows(bound, shelf) {
    const onShelf = new Map((shelf || []).map(w => [w.file_id, w]));
    const boundSet = new Set(bound);
    return [
        ...bound.map(name => onShelf.get(name) || (shelf ? { file_id: name, name, placeholder: true, missing: true } : { file_id: name, name })),
        ...(shelf || []).filter(w => !boundSet.has(w.file_id)),
    ];
}

function renderChatLoreList() {
    const listEl = document.getElementById('chatLoreList');
    if (!listEl) return;
    const bound = getChatWorlds(_chatLorePickerChat?.chat);
    const boundSet = new Set(bound);
    const q = (document.getElementById('chatLoreSearch')?.value || '').trim().toLowerCase();
    // Match + display by file_id (filename): ST identifies world files by filename, not the internal JSON "name".
    const rows = chatLorePickerRows(bound, _chatLoreWorlds);
    const worlds = rows.filter(w => !q || w.file_id.toLowerCase().includes(q));
    // a shelf that could not be read says so beneath the bound books, never "no lorebooks"
    const failed = _chatLoreWorlds === null
        ? '<div class="chat-lore-empty">Could not load your lorebooks.<br><button type="button" class="cl-btn cl-btn-secondary cl-btn-sm u-mt-sm" data-shelf-retry><i class="fa-solid fa-rotate-right"></i> Retry</button></div>'
        : '';
    if (!worlds.length) {
        listEl.innerHTML = failed || `<div class="chat-lore-empty">${rows.length ? 'No matches.' : 'No lorebooks found.'}</div>`;
        return;
    }
    listEl.innerHTML = worlds.map(w => {
        const isOn = boundSet.has(w.file_id);
        const note = w.placeholder ? '<span class="chat-lore-row-note" title="A name something binds, with no lorebook file behind it yet">placeholder</span>' : '';
        return `
            <button class="chat-lore-row${isOn ? ' current' : ''}" data-world="${CoreAPI.escapeHtml(w.file_id)}" aria-pressed="${isOn ? 'true' : 'false'}" title="${isOn ? 'Unbind from this chat' : 'Bind to this chat'}">
                <i class="fa-solid ${w.placeholder ? 'fa-book-open' : 'fa-book'}"></i>
                <span class="chat-lore-row-name">${CoreAPI.escapeHtml(w.file_id)}</span>
                ${note}
                ${isOn ? '<i class="fa-solid fa-check chat-lore-row-check"></i>' : ''}
            </button>`;
    }).join('') + failed;
}

// one click binds or unbinds one book; the picker repaints from the row the write synced, never its own guess
async function toggleChatLore(worldName) {
    const ctx = _chatLorePickerChat;
    if (!ctx || !worldName) return;
    const { chat } = ctx;
    const isOn = getChatWorlds(chat).includes(worldName);
    const ok = await applyChatWorlds(chat.id, isOn ? { remove: [worldName] } : { add: [worldName] });
    if (!ok) { CoreAPI.showToast('Failed to update the chat lorebooks', 'error'); return; }
    // the caches ride the write; this only updates the picker's OWN copy, which the list may not hold
    const next = isOn ? getChatWorlds(chat).filter(w => w !== worldName) : [...getChatWorlds(chat), worldName];
    chat.worlds = next;
    renderChatLorePicker();
    CoreAPI.showToast(isOn ? `Unbound "${worldName}" from this chat` : `Bound "${worldName}" to this chat`, 'success');
}

async function clearChatLore() {
    const ctx = _chatLorePickerChat;
    if (!ctx) return;
    const { chat } = ctx;
    const bound = getChatWorlds(chat);
    if (!bound.length) { closeChatLorePicker(); return; }
    const ok = await applyChatWorlds(chat.id, { remove: bound });
    if (!ok) { CoreAPI.showToast('Failed to update the chat lorebooks', 'error'); return; }
    chat.worlds = [];
    closeChatLorePicker();
    CoreAPI.showToast(`Unbound ${bound.length} lorebook${bound.length === 1 ? '' : 's'} from this chat`, 'success');
}

// ========================================
// PUBLIC API
// ========================================

// ========================================
// MODULE INIT & EXPORTS
// ========================================

function init() {
    // these panels arent ModuleLoader-registered (nothing they bind is in the static shell), so init them here
    LorePanel.init?.();
    GalleryPanel.init?.();
    BackgroundPanel.init?.();
    SettingsPanel.init?.();
    PersonasPanel.init?.();
    CardTextsPanel.init?.();
    PromptInspector.init?.();
    SwipeCombiner.init?.();
    Assistant.init?.();
    // the host reads the live conversation at every open and follow rather than a copy
    ExtensionWindows.init({ context: () => ({ chatId: _convChatId, character: _convChar }) });
    registerFeedPatcher(['chat', 'message', 'character', 'worldLink', 'world'], patchChatsFromFeed);
    registerFeedPatcher(['persona', 'llmProfile', 'preset'], patchConvSubjectFromFeed);
    // this tab's own connection writes (the settings modal, the Connections window) move the sight and the budget too
    registerFeedPatcher('llmProfile', () => (isConversationOpen() ? syncConvProfiles() : undefined), { own: true });
    registerFeedPatcher('setting', patchConvSettingsFromFeed);
    followPictureRemovals(_convTray);
    registerFeedPatcher('message', patchConvOwnEcho, { own: true });
    CoreAPI.onCharactersDeleted(onCharactersDeleted);
    // A message action registered or removed after the rows were built lands at once, a composer one in the strip.
    document.addEventListener(EXT_ACTION_EVENT, (e) => {
        if (e.detail?.slot === 'message') convRebuildRows();
        else if (e.detail?.slot === 'composer') convRenderComposerActions();
    });
    // the strip asks each when() again as a conversation opens, its character lands, or it closes
    document.addEventListener('cl-chat-changed', convRenderComposerActions);
    watchHooks(convOnHooksChanged);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initChatsView);
    } else {
        initChatsView();
    }
}

export default {
    init,

    // Modal chats tab
    fetchCharacterChats,
    createNewChat,
    openConversationForCharacter,
    // a chat by its id, for anything that holds an id and no list row (extensions: ctx.chats.open)
    openChatById,

    // Top-level chats view
    initChatsView,
    loadAllChats,
    renderChats,
    resetViewDefaults,

    // Chat lore (chat-bound lorebook) - consumed by the Lorebook Manager too
    applyChatWorlds,
    applyChatWorldsBatch,

    // Settings > Chat drives the line length live; this stays the single writer of
    // --cl-chat-measure so the value can never be set from two places.
    applyChatMeasure: convApplyMeasure,

    // leaving chats suspends (the conversation parks and keeps generating); closeConversation is the real teardown
    suspendConversation,
    closeConversation,
    conversationCharacterId,

    // the two windows write a choice and ask the open conversation to re-read the server's answer; nothing is passed
    syncConversationProfile: syncConvProfiles,
    syncConversationPreset: convSyncPreset,

    // chat.compose and chat.send: the composer's own verbs, never a second send
    composeText: convComposeText,
    sendText: convSendText,

    // the gallery window's Attach to next message, and whether this chat's connection takes pictures (false hides it)
    attachPicture: convAttachPicture,
    seesPictures: () => _convSees,
};
