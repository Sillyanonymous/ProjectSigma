// The assistant: an out-of-character writing partner beside the conversation; the server assembles, parses, judges and applies.

import CoreAPI from '../core-api.js';
import { CHAT_PURIFY_CONFIG } from '../providers/provider-utils.js';
import { mountChatWindow, syncRangeFill, syncFieldAvailability, openChatWindow, closeChatWindow, registerChatWindow, STORED_TEXT } from './window.js';
import { registerFeedPatcher } from '../feed.js';
import { propKey, stripBlocks, diffSideBySideHtml, createPromptStore, promptChipsHtml, promptsEditorHtml, settingSelectHtml, LIVE_FORMATTING_FIELD, paintPanelReply, closePanelStream, carryPanelReply, markKnownEmpty, createReviewState, reviewActsHtml, reviewEditBoxHtml, reviewCardHtml, reviewEditedFlagHtml, reviewApproximateFlagHtml, reviewFailedHtml, reviewNudgeHtml, reviewBlockHtml, syncReviewChrome, repaintReviewCard, createLivePainter, createPictureTray, picturesHtml, openPictures, connectionSight, wirePanelComposer, attachToChat, followPictureRemovals, followConnectionWrites } from '../ai-panel.js';

const esc = (s) => CoreAPI.escapeHtml(s);

// one ceiling for the turn count, shared by the context slider and the settings field (they drifted once)
const TURNS_MAX = 200;

let injected = false;
let open = false;

let _chatId = null;
let _char = null;
// the chat's resolved persona name for {{user}} in a saved prompt; null leaves the macro literal
let _personaName = null;
// and its forms for the five pronoun macros: null (not read) leaves them literal, no persona answers the they/them words
let _personaPronouns = null;
let _sessionId = null;
let _sessions = [];
let _messages = [];
let _profiles = [];
let _profileId = null;      // which connection answers; the settings view is its one control
let _sees = null;           // its sight: only true offers attaching
// pictures for the next ask, uploaded to the chat's gallery or the character's portrait by reference
const _tray = createPictureTray({ strip: () => document.getElementById('casPics'), removeTitle: 'Not with this message', onChange: () => syncPickMarks() });
let _profilesNote = '';     // why the list is empty, when it is
let _busy = false;
let _openStream = null;     // the reply whose stream is still open: { painting }, decided when it was sent
let _posting = false;       // the reader's turn on its way to the session its reply will be asked in
let _abort = null;
let _livePainter = null;    // the running reply's painter: back in sight, it lands what streamed meanwhile
// every gate a running reply holds, a turn on its way holds too
const busy = () => _busy || _posting;
// The settings live IN the panel rather than in a second window.
let _view = 'chat';
let _defaultPrompt = '';
// what the assistant can see, as the server computes it; null until read, rendered as reading, never as nothing
let _context = null;
// per-card state is keyed by seq + id (an id is unique only within its message); the two below are this panel's own
const review = createReviewState();
const { openDiffs: _openDiffs, rejected: _rejected, openEdits: _openEdits, edits: _edits } = review;
const _redirects = new Map();   // propKey -> destination book for a create, sent as an apply override
const _namedBooks = new Set();  // books the reviewer named via "New book"; offered in every create's select
let _editing = null;     // transcript seq being edited in place
// per reply seq: the proposals and the server's last verdict on them
let _proposals = new Map();

const STATUS_TEXT = {
    ready: 'Ready to apply',
    applied: 'Applied',
    superseded: 'Already handled by an applied change',
    blind: 'The assistant never read this in full',
    gone: 'The target no longer exists',
    ambiguous: 'The text to change is not unique',
    invalid: 'Malformed proposal',
    failed: 'The write failed',
};

const OP_LABEL = {
    create: 'New lore entry', update: 'Edit lore entry', delete: 'Delete',
    edit: 'Rewrite message', replace: 'Replace text', hide: 'Hide message',
};

// what an update's non-content field is called on the card; the wire keeps the set's names
const FIELD_LABEL = {
    comment: 'Title', keys: 'Keys', secondaryKeys: 'Secondary keys', order: 'Order',
    position: 'Position', depth: 'Depth', disable: 'Disabled', constant: 'Always on',
};
const keyPillsHtml = (list, cap = list.length) => list.slice(0, cap).map(k => `<span>${esc(k)}</span>`).join('');
function fieldValueHtml(v) {
    if (Array.isArray(v)) return v.length ? keyPillsHtml(v) : '<em>none</em>';
    if (typeof v === 'boolean') return v ? 'on' : 'off';
    if (v == null || v === '') return '<em>none</em>';
    return esc(v);
}

// ========================================
// MARKUP
// ========================================

function buildHTML() {
    return `
    <div class="cl-cwin cas-panel" id="chatAssistantPanel" aria-hidden="true">
        <div class="cl-cwin-sheet cas-sheet" role="dialog" aria-label="Assistant">
            ${CoreAPI.windowGripsHtml('the assistant')}
            <div class="cl-cwin-header">
                <div class="cl-cwin-title">
                    <i class="fa-solid fa-robot"></i>
                    <span class="cl-cwin-name">Assistant</span>
                    <span class="cl-cwin-sep">·</span>
                    <span class="cl-cwin-meta" id="casMeta"></span>
                </div>
                <button type="button" class="cl-cwin-btn" data-cas-act="settings" title="Assistant settings" aria-label="Assistant settings">
                    <i class="fa-solid fa-gear"></i>
                </button>
                <button type="button" class="cl-cwin-btn is-close" data-cas-act="close" title="Close" aria-label="Close">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div class="cas-toolbar cl-cwin-fieldrow" id="casTabs"></div>
            <div class="cas-body" id="casBody"></div>
            <div class="cas-composer">
                <div class="cas-status hidden" id="casStatus"></div>
                <div class="cas-qp-row hidden" id="casQpRow"></div>
                <div class="cas-pick" id="casPick" role="group" aria-label="The character's gallery" hidden></div>
                <div class="cas-pics cl-pic-tray" id="casPics" role="list" aria-label="Pictures for your next message" hidden></div>
                <div class="cl-cwin-input-row cas-input-row has-end-tool">
                    <button type="button" class="cas-qp-toggle" id="casQpToggle" data-cas-act="toggle-prompts"
                        title="Saved prompts" aria-label="Saved prompts" aria-pressed="false">
                        <i class="fa-solid fa-bookmark"></i>
                    </button>
                    <textarea id="casInput" class="cas-input" rows="1" placeholder="Ask about the story..."
                        autocomplete="off" autocorrect="off" spellcheck="true"></textarea>
                    <button type="button" class="cas-attach cl-cwin-tool-end" id="casAttach" data-cas-act="attach"
                        title="Show the assistant pictures (or paste or drop them here)" aria-label="Attach pictures" aria-haspopup="menu">
                        <i class="fa-solid fa-paperclip"></i>
                    </button>
                    <input type="file" id="casAttachInput" multiple accept="image/*" hidden>
                    <button type="button" class="cl-cwin-send cas-send" id="casSend" data-cas-act="send" title="Send" aria-label="Send">
                        <i class="fa-solid fa-arrow-up"></i>
                    </button>
                    <button type="button" class="cl-cwin-send cas-send is-stop hidden" id="casStop" data-cas-act="stop" title="Stop" aria-label="Stop">
                        <i class="fa-solid fa-stop"></i>
                    </button>
                </div>
            </div>
        </div>
    </div>`;
}

// ========================================
// SESSION TABS
// ========================================

/**
 * One toolbar row: a session selector (custom-select, so mobile gets the canonical sheet for
 * free), the session verbs as slim buttons, and the context-view toggle.
 */
function toolbarHtml() {
    if (!_chatId) return '';
    return `
        <select id="casSessionSel" class="cl-select-fluid" aria-label="Session" title="Session">
            ${_sessions.map(s => `<option value="${esc(s.id)}"${s.id === _sessionId ? ' selected' : ''}>${esc(s.name)}${s.messageCount ? ` (${s.messageCount})` : ''}</option>`).join('')}
        </select>
        <button type="button" class="cas-tab-add" data-cas-act="new-session" title="New session" aria-label="New session">
            <i class="fa-solid fa-plus"></i>
        </button>
        <button type="button" class="cas-tab-add" data-cas-act="rename-session" title="Rename this session" aria-label="Rename this session">
            <i class="fa-solid fa-i-cursor"></i>
        </button>
        <button type="button" class="cas-tab-add is-danger" data-cas-act="delete-session" title="Delete this session" aria-label="Delete this session">
            <i class="fa-solid fa-trash"></i>
        </button>
        <button type="button" class="cas-tab-menu${_view === 'context' ? ' is-on' : ''}" data-cas-act="context-view"
            title="What it can see: story range, lorebooks, edit engines" aria-label="Context">
            <i class="fa-solid fa-layer-group"></i>
        </button>`;
}

// ========================================
// CONTEXT STRIP
// ========================================

const nf = (n) => Number(n || 0).toLocaleString();

/** Is either edit engine live? Read from the setting, which is what the request will use. */
const enginesOn = () => CoreAPI.getSetting('assistantLoreEdits') === true
    || CoreAPI.getSetting('assistantChatEdits') === true;

/** The context view: what the assistant can see, as controls; every figure is the server's own assembly. */
function contextViewHtml() {
    if (!_context) return '<div class="cl-cwin-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><p>Reading the story</p></div>';
    const turns = Number(CoreAPI.getSetting('assistantChatTurns')) || 20;
    const books = _context.books || [];
    const tok = _context.budget?.tokens;
    // three states: a list, a card with none written, and NOT KNOWN (an older server); never coerce unknown to empty
    const card = Array.isArray(_context.card) ? _context.card : null;
    const cardBody = card === null
        ? `<p class="cl-cwin-group-note">This server has not said what it sends of the card. Reload the page;
            if it stays, the server is running an older build than this panel.</p>`
        : card.length ? `
            <div class="cl-cwin-fields">
                <div class="cas-book-entries">
                    ${card.map(f => `
                        <div class="cl-cwin-row cas-entry is-open" title="Sent in full">
                            <i class="fa-solid fa-circle-dot"></i>
                            <span class="cas-entry-title">${esc(f.label)}</span>
                            <span class="cas-entry-size">${nf(f.chars)}</span>
                        </div>`).join('')}
                </div>
            </div>
            <p class="cl-cwin-hint">Every field the card fills is sent whole, the same way the roleplay itself
                gets them. A field the card leaves empty is not listed.</p>`
        : `<p class="cl-cwin-group-note">This character's card has no written fields yet.</p>`;
    // the texts this chat holds of its own, listed only where there are some
    const own = Array.isArray(_context.chatCard) ? _context.chatCard : [];
    const ownGroup = own.length ? `
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-comment-dots"></i>This chat's own</h4>
            <div class="cl-cwin-fields">
                <div class="cas-book-entries">
                    ${own.map(f => `
                        <div class="cl-cwin-row cas-entry is-open" title="Sent in full, in place of the card's">
                            <i class="fa-solid fa-circle-dot"></i>
                            <span class="cas-entry-title">${esc(f.label)}</span>
                            <span class="cas-entry-size">${nf(f.chars)}</span>
                        </div>`).join('')}
                </div>
            </div>
            <p class="cl-cwin-hint">This chat's story reads these instead of the card's; the assistant is shown both, and told which.</p>
        </section>` : '';
    return `
    <div class="cas-settings">
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-id-card"></i>Character card</h4>
            ${cardBody}
        </section>${ownGroup}
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-comments"></i>Story in range</h4>
            <div class="cl-cwin-fields">
                <div class="cl-cwin-block">
                    <div class="cl-cwin-field">
                        <label class="cl-cwin-field-label" for="casTurns">Messages it can see</label>
                        <span class="cl-cwin-range-wrap">
                            <input type="range" id="casTurns" class="cl-range cl-cwin-range" min="1" max="${TURNS_MAX}" step="1" value="${turns}">
                            <span class="cl-cwin-readout" id="casTurnsOut">${turns}</span>
                        </span>
                    </div>
                    <p class="cl-cwin-hint">Reading ${_context.turnsShown} of ${_context.turnsTotal} right now, hidden ones
                        excluded.${tok ? ` The next request is about ${nf(tok)} tokens.` : ''}</p>
                    ${_context.budget?.overBudget ? `
                    <p class="cl-cwin-hint cas-over">The request is over the context limit you set
                        (${nf(_context.budget.maxContext)} tokens${_context.budget.reserve ? `, ${nf(_context.budget.reserve)} of it held back for the reply` : ''}),
                        and there is nothing left to trim: the story material is never dropped to make room, only
                        this conversation is. Raise the limit in Settings, or start a new session.</p>` : ''}
                </div>
            </div>
        </section>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-book-atlas"></i>Lorebooks it can reach</h4>
            ${books.length ? `
            <div class="cl-cwin-fields">
                ${books.map(b => `
                <div class="cas-book">
                    <div class="cas-book-head">
                        <i class="fa-solid fa-book"></i>
                        <span class="cas-book-name">${esc(b.name)}</span>
                        <span class="cas-book-count">${b.open} of ${b.total} open</span>
                    </div>
                    <div class="cas-book-entries">
                        ${b.entries.map(e => `
                            <div class="cl-cwin-row cas-entry${e.open ? ' is-open' : ''}${e.clipped ? ' is-clipped' : ''}${e.disabled ? ' is-off' : ''}"
                                title="${e.open ? 'Sent in full' : e.clipped ? 'Sent, but only the first part of it' : 'Listed by title only'}">
                                <i class="fa-solid ${e.open ? 'fa-circle-dot' : e.clipped ? 'fa-circle-half-stroke' : 'fa-circle'}"></i>
                                <span class="cas-entry-title">${esc(e.title)}</span>
                                ${e.clipped ? '<span class="cas-entry-tag">part</span>' : ''}
                                ${e.constant ? '<span class="cas-entry-tag">always</span>' : ''}
                                ${e.disabled ? '<span class="cas-entry-tag">off</span>' : ''}
                                <span class="cas-entry-size">${nf(e.chars)}</span>
                            </div>`).join('')}
                    </div>
                </div>`).join('')}
            </div>
            <p class="cl-cwin-hint">Entries that fire against the recent messages are sent in full; a very long one is
                sent in part, and the rest are listed by title so it knows they exist and can ask for one. It may
                only rewrite an entry it was sent in full.</p>`
            : `<p class="cl-cwin-group-note">This character has no lorebooks linked, and this chat has none of its own.
                Link one from the Lorebooks panel and it appears here.</p>`}
        </section>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-wand-magic-sparkles"></i>Edit engines</h4>
            <div class="cl-cwin-fields">
                ${togBlock('assistantLoreEdits')}
                ${togBlock('assistantChatEdits')}
            </div>
        </section>
    </div>`;
}

/** The reply body through the conversation's producer and gate, as stored (no macro expanded); never formatRichText. */
function renderText(text, opts = {}) {
    return CoreAPI.safePurify(CoreAPI.formatChatText(String(text ?? ''), _char?.name || '', { ...opts, ...STORED_TEXT }), CHAT_PURIFY_CONFIG);
}

function proposalCardHtml(p, { inGroup = false, seq } = {}) {
    const pk = propKey(seq, p.id);
    const status = p.status || 'ready';
    // in a creates-the-book group the parent names the book; the head shows the RESOLVED target, not the typed label
    const rUid = p.resolved?.uid ?? p.change.uid;
    const rWorld = p.resolved?.world ?? p.change.world;
    // the entry's NAME heads the card; the number only when the verdict read no row (blind) or there is no name
    const loreRow = p.engine === 'lore' && p.change.op !== 'create';
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    // a change addressed by title carries its own name even before any row was read
    const typedTitle = typeof p.change.entry === 'string' ? p.change.entry.trim() : '';
    const name = p.change.op === 'create'
        ? (p.change.comment || 'New entry')
        : loreRow
            ? (title || typedTitle || `Entry #${rUid}`)
            : `Message #${p.resolved?.seq ?? p.change.seq}`;
    const uidMark = loreRow && (title || typedTitle) && rUid != null ? `<span class="cas-prop-uid">#${esc(rUid)}</span>` : '';
    const world = inGroup || p.engine !== 'lore' ? '' : esc(rWorld);
    // the diff is disclosed, never inline; a field-only update offers no toggle, and a stale open toggle paints nothing
    const judged = status !== 'applied' && ('before' in p || 'after' in p);
    const showDiff = _openDiffs.has(pk);
    const hasDiff = judged && p.change.op !== 'hide' && String(p.before ?? '') !== String(p.after ?? '');
    const body = !judged
        ? ''
        : (p.change.op === 'hide'
            ? `<div class="cas-prop-note">${p.change.hidden ? 'Stops being sent to the model; stays readable here.' : 'Sent to the model again.'}</div>`
            : (hasDiff && showDiff ? diffSideBySideHtml(p.before, p.after) : ''));
    // creating a book is said before the entry; a grouped parent says it once instead
    const newBook = p.createsBook && !inGroup ? createsBookHtml(p.createsBook) : '';
    const flags = p.change.op === 'create' && p.change.constant === true
        ? '<span class="cas-prop-flag" title="Injected every turn, not keyword-triggered">always on</span>'
        : '';
    const rejected = _rejected.has(pk);
    // Each non-content field the update moves, live value then proposed, from the verdict.
    const fieldsHtml = Array.isArray(p.fields) && p.fields.length && status !== 'applied' && !rejected
        ? `<div class="cas-prop-fields">${p.fields.map(f => `
            <div class="cas-prop-field">
                <span class="cas-prop-field-k">${esc(FIELD_LABEL[f.key] || f.key)}</span>
                <span class="cas-prop-field-v is-del">${fieldValueHtml(f.before)}</span>
                <i class="fa-solid fa-arrow-right"></i>
                <span class="cas-prop-field-v is-add">${fieldValueHtml(f.after)}</span>
            </div>`).join('')}</div>`
        : '';
    const previewHtml = p.change.op === 'create' && p.after
        ? `<div class="cas-prop-preview">${esc(String(p.after).slice(0, 140))}${String(p.after).length > 140 ? '…' : ''}</div>` : '';
    // rendered even with no known books (the apply creates one), and the chosen name always gets an option
    const destHtml = p.change.op === 'create' && p.engine === 'lore' && !rejected ? (() => {
        const chosen = _redirects.get(pk) || p.change.world;
        const opts = [...new Set([p.change.world, ...(_context?.books || []).map(b => b.name), ..._namedBooks, chosen])];
        return `
        <div class="cas-prop-dest">
            <i class="fa-solid fa-book"></i>
            <label>into</label>
            <select class="cl-select-fluid cas-prop-destsel" data-prop-world="${esc(p.id)}" title="Which book receives this entry">
                ${opts.map(n => `<option value="${esc(n)}"${chosen === n ? ' selected' : ''}>${esc(n)}</option>`).join('')}
                <option value="__cas_new_book__">New Book…</option>
            </select>
        </div>`;
    })() : '';
    // an unplaced replace on the LAST reply only gets the re-quote verb: the note it leans on quotes only that reply
    const requoteBtn = status === 'ambiguous' && p.engine === 'chat' && p.change.op === 'replace' && seq === _messages.length - 1
        ? `<button type="button" class="cas-prop-act" data-cas-act="requote" data-prop-id="${esc(p.id)}"
               title="Ask the assistant to quote the passage as the message reads now and propose this change again"><i class="fa-solid fa-rotate-right"></i></button>`
        : '';
    const head = [
        uidMark,
        world ? `<span class="cas-prop-world">${world}</span>` : '',
        _edits.has(pk) ? reviewEditedFlagHtml() : '',
        _redirects.has(pk) ? (() => {
            const to = _redirects.get(pk);
            const isNew = !(_context?.books || []).some(b => b.name === to);
            return `<span class="cas-prop-flag" title="${isNew ? 'Redirected to a book that will be created on apply' : 'Redirected to another book'}">to ${esc(to)}${isNew ? ' (new book)' : ''}</span>`;
        })() : '',
        p.resolved && p.change.op !== 'create' && p.change.uid != null && !rejected
            ? '<span class="cas-prop-flag" title="The assistant named a different location; matched to the entry it actually read, by content. The change applies there.">matched by content</span>' : '',
        p.engine === 'chat' && p.resolved?.seq != null && !rejected
            ? `<span class="cas-prop-flag" title="The assistant named message #${esc(p.change.seq)}; the quoted passage is in #${esc(p.resolved.seq)} and the change applies there.">found in #${esc(p.resolved.seq)}</span>` : '',
        reviewApproximateFlagHtml(p, status, rejected, 'message'),
        flags,
    ].filter(Boolean).join('\n            ');
    return reviewCardHtml({
        id: p.id, op: p.change.op, opLabel: OP_LABEL[p.change.op] || p.change.op, name, status,
        statusText: STATUS_TEXT[status] || status, rejected, head,
        acts: reviewActsHtml({
            id: p.id, status, rejected, hasDiff, showDiff, editable: typeof p.change.content === 'string',
            editOpen: _openEdits.has(pk), extra: requoteBtn,
        }),
        before: [fieldsHtml, previewHtml, destHtml].filter(Boolean).join('\n        '),
        edit: reviewEditBoxHtml({ id: p.id, open: _openEdits.has(pk), rejected, value: _edits.get(pk) ?? String(p.change.content ?? '') }),
        after: newBook,
        why: p.why, reason: p.reason,
        tail: Array.isArray(p.change.keys) && p.change.keys.length ? `<div class="cas-prop-keys">${keyPillsHtml(p.change.keys, 10)}</div>` : '',
        body,
    });
}

// Said once per book: on the group that holds its entries, or on a lone entry that creates it.
const createsBookHtml = (book) => `<div class="cas-prop-new">
             <i class="fa-solid fa-book-medical"></i>
             Creates the lorebook <b>${esc(book)}</b> and links it to ${esc(_char?.name || 'this character')}
           </div>`;

// applicable now: server-ready AND not set aside; the head count and the Apply footer both read this set
const liveProposals = (seq) => (_proposals.get(seq)?.proposals || [])
    .filter(p => (p.status || 'ready') === 'ready' && !_rejected.has(propKey(seq, p.id)));

function proposalsHtml(seq) {
    const state = _proposals.get(seq);
    // unknown, not empty: verdicts arrive after the first paint, so no nudge under proposals still on their way
    if (!state) return '';
    if (state.failed) return reviewFailedHtml(seq);
    const { proposals, errors } = state;
    if (!proposals.length && !errors.length) {
        // known to carry nothing; last turn ONLY, since the ask says put THAT into a block
        return enginesOn() && seq === _messages.length - 1
            ? reviewNudgeHtml(seq, 'Turn this into a change I can apply')
            : '';
    }
    // creating a book is ONE event: the book is the parent card holding its entries
    const units = [];
    const grouped = new Set();
    for (const p of proposals) {
        if (!p.createsBook) { units.push(proposalCardHtml(p, { seq })); continue; }
        if (grouped.has(p.createsBook)) continue;
        grouped.add(p.createsBook);
        const members = proposals.filter(x => x.createsBook === p.createsBook);
        units.push(`
        <div class="cas-prop-group">
            ${createsBookHtml(p.createsBook)}
            ${members.map(x => proposalCardHtml(x, { inGroup: true, seq })).join('')}
        </div>`);
    }
    return reviewBlockHtml({
        seq, icon: 'fa-book-atlas', live: liveProposals(seq).length, errors,
        canFix: seq === _messages.length - 1, units: units.join(''),
    });
}

const syncPropsChrome = (seq) => syncReviewChrome(seq, liveProposals(seq).length);

function messageHtml(m, seq) {
    const mine = m.role === 'user';
    // a read answer is our data on a user-role turn, shown as a chip
    if (m.extra?.data === 'read') {
        const bits = [];
        if (m.extra.seqs?.length) bits.push(`the alternate drafts of ${m.extra.seqs.map(s => `#${s}`).join(', ')}`);
        if (m.extra.lore?.length) bits.push(`${m.extra.lore.length} lorebook entr${m.extra.lore.length === 1 ? 'y' : 'ies'} in full`);
        return `
        <div class="cas-msg is-data" data-seq="${seq}">
            <span class="cas-data-chip"><i class="fa-solid fa-layer-group"></i>Shared ${esc(bits.join(' and ') || 'the requested material')} with the assistant</span>
        </div>`;
    }
    const prose = mine ? m.content : stripBlocks(m.content);
    if (_editing === seq) {
        return `
        <div class="cas-msg ${mine ? 'is-user' : 'is-assistant'} is-editing" data-seq="${seq}">
            <textarea class="cas-edit-box" data-seq="${seq}" spellcheck="true">\n${esc(m.content)}</textarea>
            <div class="cas-edit-actions">
                <button type="button" class="cl-cwin-btn-text" data-cas-act="edit-cancel">Cancel</button>
                <button type="button" class="cl-cwin-btn-text is-primary" data-cas-act="edit-save" data-seq="${seq}">
                    <i class="fa-solid fa-check"></i> Save
                </button>
            </div>
        </div>`;
    }
    return `
    <div class="cas-msg ${mine ? 'is-user' : 'is-assistant'}" data-seq="${seq}">
        <div class="cas-msg-head">
            <span class="cas-msg-who">
                <i class="fa-solid ${mine ? 'fa-user' : 'fa-robot'}"></i>${mine ? 'You' : 'Assistant'}
            </span>
            ${m.at ? `<span class="cas-msg-time">${esc(shortTime(m.at))}</span>` : ''}
            <span class="cas-msg-actions">
                ${mine ? '' : `<button type="button" class="cas-msg-btn" data-cas-act="copy" data-seq="${seq}" title="Copy"><i class="fa-solid fa-copy"></i></button>`}
                <button type="button" class="cas-msg-btn" data-cas-act="edit" data-seq="${seq}" title="Edit this message"><i class="fa-solid fa-pen"></i></button>
                <button type="button" class="cas-msg-btn" data-cas-act="retry" data-seq="${seq}" title="Ask again from here"><i class="fa-solid fa-rotate"></i></button>
                <button type="button" class="cas-msg-btn is-danger" data-cas-act="delete" data-seq="${seq}" title="Delete this message"><i class="fa-solid fa-trash"></i></button>
            </span>
        </div>
        ${!mine && m.extra?.reasoning ? `
        <details class="cas-think">
            <summary><i class="fa-solid fa-brain"></i>Reasoning</summary>
            <div class="cas-think-body">${esc(m.extra.reasoning)}</div>
        </details>` : ''}
        <div class="cas-msg-body">${mine ? esc(prose).replace(/\n/g, '<br>') : renderText(prose)}</div>
        ${mine ? picturesHtml(m.extra?.pictures, { attr: `data-cas-act="picture" data-seq="${seq}"` }) : ''}
        ${m.extra?.interrupted ? `<div class="cas-msg-flag"><i class="fa-solid fa-plug-circle-exclamation"></i> Cut short (${esc(m.extra.interrupted)})</div>` : ''}
        ${mine ? '' : proposalsHtml(seq)}
    </div>`;
}

const shortTime = (ms) => {
    try {
        return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch { return ''; }
};

// openers, not answers: an empty panel that suggests nothing reads as a panel that does nothing
const STARTERS = [
    ['fa-magnifying-glass', 'What is this scene doing?'],
    ['fa-signs-post', 'Where could this go next?'],
    ['fa-user-check', 'Is anyone acting out of character?'],
    ['fa-list-check', 'Summarise what has happened so far'],
];

function emptyHtml() {
    return `
    <div class="cas-empty">
        <div class="cas-empty-mark"><i class="fa-solid fa-robot"></i></div>
        <p class="cas-empty-lead">Your writing partner for this story.</p>
        <p class="cas-dim">It reads the whole character card, any lorebooks in force, and
            ${_context ? `${_context.turnsShown} recent message${_context.turnsShown === 1 ? '' : 's'}` : 'the recent messages'}.
            It never writes the roleplay itself.</p>
        <div class="cas-starters">
            ${STARTERS.map(([icon, text]) => `
                <button type="button" class="cas-starter" data-cas-act="starter" data-text="${esc(text)}">
                    <i class="fa-solid ${icon}"></i><span>${esc(text)}</span>
                </button>`).join('')}
        </div>
    </div>`;
}

// ========================================
// SAVED PROMPTS
// ========================================

// the shared prompt store (ai-panel.js); the chips fill the box, never send
const prompts = createPromptStore({
    key: 'assistant-prompts',
    starters: [
        { icon: '📜', label: 'Summarise', text: 'Summarise what has happened in this story so far, in the order it happened.' },
        { icon: '🔎', label: 'Critique', text: "Critique {{char}}'s last reply as a writing partner: what works, what falls flat, what you would change." },
        { icon: '🧭', label: 'Directions', text: 'Suggest three directions this scene could go next, each in a sentence, without writing any of it.' },
    ],
});

// {{char}}, {{user}} and the pronoun macros expand HERE at insertion, so the box shows what is sent; the server expands nothing here
function expandPromptMacros(text) {
    const char = _char?.name;
    return CoreAPI.answerPronounMacros(String(text ?? '')
        .replace(/\{\{char\}\}/gi, char || '{{char}}')
        .replace(/\{\{user\}\}/gi, _personaName || '{{user}}'), _personaPronouns);
}

// the chat's RESOLVED persona (an override beats the global), once per chat; a failure leaves the token literal
async function syncPromptPersona() {
    const chatId = _chatId;
    if (!chatId) { _personaName = null; _personaPronouns = null; return; }
    try {
        const r = await CoreAPI.apiRequest(`/personas/resolve?chatId=${encodeURIComponent(chatId)}`, 'GET');
        const persona = r.ok ? (await r.json())?.persona : null;
        if (_chatId !== chatId) return;
        _personaName = persona?.name || null;
        // the conversation's rule for row 0: no persona answers the they/them words, as the prompt does
        _personaPronouns = r.ok ? { ...persona?.pronouns } : null;
    } catch { /* leave it unresolved; the macro stays literal */ }
}

// surgical: the chips live in the composer, and a render() would scroll the transcript
function renderPromptChips() {
    const row = document.getElementById('casQpRow');
    const btn = document.getElementById('casQpToggle');
    if (!row) return;
    const on = CoreAPI.getSetting('assistantPromptsOpen') === true;
    const list = prompts.get();
    row.innerHTML = promptChipsHtml(list);
    // Nothing saved yet is not a row worth reserving space for, however the toggle sits.
    row.classList.toggle('hidden', !on || !list?.length);
    btn?.classList.toggle('is-on', on);
    btn?.setAttribute('aria-pressed', String(on));
}

function togglePromptChips() {
    const next = CoreAPI.getSetting('assistantPromptsOpen') !== true;
    CoreAPI.setSetting('assistantPromptsOpen', next);
    renderPromptChips();
    // Open with nothing saved would toggle an invisible row: say where they come from.
    if (next && !prompts.get()?.length) CoreAPI.showToast('No saved prompts yet: add them in the assistant settings', 'info');
}

function usePrompt(id) {
    const p = prompts.find(id);
    const input = document.getElementById('casInput');
    if (!p || !input) return;
    input.value = expandPromptMacros(p.text);
    input.dispatchEvent(new Event('input'));   // the composer autosizes off its own input event
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
}

// ========================================
// SETTINGS VIEW
// ========================================

const SETTING_FIELDS = [
    {
        key: 'assistantReasoningEffort',
        label: 'Reasoning effort',
        kind: 'select',
        options: [['', 'Connection Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']],
        hint: 'Only reasoning models read this. Lower thinks less and answers sooner; the roleplay keeps the connection\'s own setting.',
    },
    {
        key: 'assistantMaxReply',
        label: 'Max reply tokens',
        kind: 'number',
        attrs: 'min="1" max="128000" step="256" placeholder="connection default"',
        hint: 'A ceiling on the reply, thinking included. A reasoning model that runs out mid-thought returns nothing at all.',
    },
    {
        key: 'assistantTemperature',
        label: 'Temperature',
        kind: 'number',
        attrs: 'min="0" max="2" step="0.05" placeholder="connection default"',
        hint: 'Higher wanders further from the likeliest next word. Blank leaves it to the connection.',
    },
    {
        key: 'assistantChatTurns',
        label: 'Messages it can see',
        kind: 'number',
        attrs: `min="1" max="${TURNS_MAX}" step="1"`,
        hint: 'How many recent messages of the roleplay go into its context. Higher costs more per question.',
    },
    {
        key: 'assistantMaxContext',
        label: 'Context budget (tokens)',
        kind: 'number',
        attrs: 'min="0" step="256" placeholder="0 = no limit"',
        hint: 'Only this conversation is trimmed to fit. The story material it was given is never cut down.',
    },
    {
        key: 'assistantStreaming',
        label: 'Show the reply as it is written',
        kind: 'toggle',
        hint: 'Off, the whole reply appears at once when it is done. On, it is shown as it arrives, and a code block reads as raw text until it closes unless Format as it streams, below, is on.',
    },
    { key: 'assistantLiveFormatting', kind: 'select', ...LIVE_FORMATTING_FIELD },
    {
        key: 'assistantLoreEdits',
        label: 'Let it propose lorebook edits',
        kind: 'toggle',
        hint: 'It may only rewrite an entry it was shown in full. Nothing is written until you press Apply.',
    },
    {
        key: 'assistantChatEdits',
        label: 'Let it propose message edits',
        kind: 'toggle',
        hint: 'Rewrite, replace text in, hide or delete messages in this chat. Nothing is written until you press Apply.',
    },
];

// The chat-settings window's form language, defined once in settings-panel.css. Module
// level because the settings AND the context views both build from it.
const settingField = (key) => SETTING_FIELDS.find(f => f.key === key);

// whether a reply is painted as it arrives here: what the stream reads, and what Format as it streams waits on
const assistantStreams = () => CoreAPI.getSetting('assistantStreaming') === true;

function syncLiveFormattingRow() {
    syncFieldAvailability(document.getElementById('casSet_assistantLiveFormatting'), {
        on: assistantStreams(), hint: LIVE_FORMATTING_FIELD.hint, reason: 'Only applies while Show the reply as it is written is on.',
    });
}

function togBlock(key) {
    const f = settingField(key);
    return `
        <div class="cl-cwin-block">
            <label class="cl-cwin-field cl-cwin-toggle">
                <span class="cl-cwin-field-label">${esc(f.label)}</span>
                <input type="checkbox" class="cl-switch-input" data-set="${f.key}" ${CoreAPI.getSetting(f.key) === true ? 'checked' : ''}>
                <span class="cl-switch" aria-hidden="true"></span>
            </label>
            <p class="cl-cwin-hint">${esc(f.hint)}</p>
        </div>`;
}

function settingsHtml() {
    const custom = String(CoreAPI.getSetting('assistantSystemPrompt') || '');
    const numBlock = (key) => {
        const f = settingField(key);
        return `
        <div class="cl-cwin-block">
            <div class="cl-cwin-field">
                <label class="cl-cwin-field-label" for="casSet_${f.key}">${esc(f.label)}</label>
                <input type="number" id="casSet_${f.key}" class="cl-cwin-input cl-cwin-field-control" data-set="${f.key}"
                    ${f.attrs} value="${esc(CoreAPI.getSetting(f.key) ?? '')}">
            </div>
            <p class="cl-cwin-hint">${esc(f.hint)}</p>
        </div>`;
    };
    const selBlock = (key) => {
        const f = settingField(key);
        return settingSelectHtml({
            id: `casSet_${f.key}`, key: f.key, label: f.label, hint: f.hint, value: String(CoreAPI.getSetting(f.key) || ''),
            options: f.options,
        });
    };
    return `
    <div class="cas-settings">
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-plug"></i>Connection</h4>
            <div class="cl-cwin-fields">
                <div class="cl-cwin-block">
                    ${_profiles.length
                        ? `<div class="cl-cwin-field">
                            <label class="cl-cwin-field-label" for="casProfile">Answers with</label>
                            <select id="casProfile" class="cl-select-fluid cl-cwin-field-control">
                                ${_profiles.map(p => `<option value="${esc(p.id)}"${p.id === _profileId ? ' selected' : ''}>${esc(p.name || p.model || p.kind)}</option>`).join('')}
                            </select>
                           </div>`
                        : `<p class="cl-cwin-hint">${esc(_profilesNote || 'No connections yet')}</p>`}
                    <p class="cl-cwin-hint">Which connection answers the assistant. The roleplay keeps its own.</p>
                </div>
                ${selBlock('assistantReasoningEffort')}
                ${numBlock('assistantMaxReply')}
                ${numBlock('assistantTemperature')}
            </div>
        </section>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-feather-pointed"></i>Prompt</h4>
            <div class="cl-cwin-fields">
                <div class="cl-cwin-block">
                    <label class="cl-cwin-label" for="casPrompt">Assistant prompt</label>
                    <textarea id="casPrompt" class="cl-cwin-input cl-cwin-textarea cas-set-prompt" rows="10"
                        placeholder="Leave blank to use the built-in prompt.">\n${esc(custom)}</textarea>
                    <div class="cas-set-actions">
                        <button type="button" class="cas-set-btn" data-cas-act="load-default">
                            <i class="fa-solid fa-file-import"></i> Load the Built-In Prompt
                        </button>
                        <button type="button" class="cas-set-btn" data-cas-act="clear-prompt">
                            <i class="fa-solid fa-rotate-left"></i> Back to Built-In
                        </button>
                    </div>
                    <p class="cl-cwin-hint">This replaces the description of what the assistant is, and only that. The note that
                        keeps story text quoted rather than obeyed, and the instructions for proposing edits, are
                        always added after it, so a custom prompt cannot accidentally switch either off.</p>
                </div>
            </div>
        </section>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-bookmark"></i>Saved prompts</h4>
            <div class="cl-cwin-fields">
                ${promptsEditorHtml(prompts.get(), { hint: 'Chips above the message box, behind the bookmark button. Clicking one fills the box so you can edit before sending; it never sends by itself. <strong>{{char}}</strong> and <strong>{{user}}</strong> are filled in as you insert, so what you see is what gets sent.' })}
            </div>
        </section>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-layer-group"></i>Context</h4>
            <div class="cl-cwin-fields">
                ${numBlock('assistantChatTurns')}
                ${numBlock('assistantMaxContext')}
            </div>
        </section>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-comment-dots"></i>Replies</h4>
            <div class="cl-cwin-fields">
                ${togBlock('assistantStreaming')}
                ${selBlock('assistantLiveFormatting')}
            </div>
        </section>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-wand-magic-sparkles"></i>Proposed edits</h4>
            <div class="cl-cwin-fields">
                ${togBlock('assistantLoreEdits')}
                ${togBlock('assistantChatEdits')}
            </div>
        </section>
        <div class="cas-set-foot">Changes apply to the next message you send.</div>
    </div>`;
}

/** Persist one settings control. Everything here is app-wide, not per session. */
function onSettingInput(el) {
    const key = el.dataset.set;
    if (!key) return;
    if (el.type === 'checkbox') {
        CoreAPI.setSetting(key, el.checked);
        if (key === 'assistantStreaming') syncLiveFormattingRow();
        return;
    }
    if (key === 'assistantReasoningEffort' || key === 'assistantLiveFormatting') { CoreAPI.setSetting(key, el.value); return; }
    // The connection overrides are three-state: a value overrides the profile, blank ('')
    // inherits. Blank is the one inherit spelling, because 0 is a real temperature.
    if (key === 'assistantTemperature') {
        const t = parseFloat(el.value);
        // Clamped AND reflected: silently storing "inherit" while the box shows the typed
        // number would be a lie the next request acts on.
        const v = Number.isFinite(t) ? Math.min(Math.max(t, 0), 2) : '';
        el.value = v;
        CoreAPI.setSetting(key, v);
        return;
    }
    if (key === 'assistantMaxReply') {
        const cap = parseInt(el.value, 10);
        const v = Number.isFinite(cap) && cap > 0 ? cap : '';
        el.value = v;
        CoreAPI.setSetting(key, v);
        return;
    }
    const n = parseInt(el.value, 10);
    // clamp AND reflect; 0 is real for the budget (no limit) but not for the turn count
    if (key === 'assistantMaxContext') {
        const v = Number.isFinite(n) && n > 0 ? n : 0;
        el.value = v || '';
        CoreAPI.setSetting(key, v);
        return;
    }
    if (key === 'assistantChatTurns') {
        const v = Number.isFinite(n) ? Math.min(Math.max(n, 1), TURNS_MAX) : null;
        if (v === null) { el.value = CoreAPI.getSetting(key) ?? ''; return; }
        el.value = v;
        CoreAPI.setSetting(key, v);
        return;
    }
    if (Number.isFinite(n) && n > 0) CoreAPI.setSetting(key, n);
}

function render() {
    const body = document.getElementById('casBody');
    if (!body) return;
    const meta = document.getElementById('casMeta');
    // Never the session name: the toolbar directly under this header already says it.
    if (meta) meta.textContent = _view === 'settings' ? 'Settings' : (_view === 'context' ? 'Context' : '');
    document.getElementById('chatAssistantPanel')?.classList.toggle('cas-in-settings', _view === 'settings');
    document.getElementById('chatAssistantPanel')?.classList.toggle('cas-in-context', _view === 'context');

    // the toolbar stays up in the context view (its button is the way back); only settings clears the deck
    const bar = document.getElementById('casTabs');
    if (bar) {
        bar.innerHTML = _view === 'settings' ? '' : toolbarHtml();
        bar.classList.toggle('hidden', _view === 'settings');
        const sel = document.getElementById('casSessionSel');
        if (sel) CoreAPI.initCustomSelect(sel);
    }

    // Ambient, above the composer: never a claim, just
    // what the session holds and what the next ask roughly costs.
    const statusEl = document.getElementById('casStatus');
    if (statusEl) {
        const tok = _context?.budget?.tokens;
        const bits = [];
        if (_messages.length) bits.push(`${_messages.length} msg${_messages.length === 1 ? '' : 's'}`);
        if (tok) bits.push(`~${nf(tok)} tok next`);
        statusEl.textContent = bits.join(' · ');
        statusEl.classList.toggle('hidden', !bits.length);
    }

    if (_view === 'settings') {
        body.innerHTML = settingsHtml();
        syncRangeFill(body);
        body.querySelectorAll('select').forEach(s => CoreAPI.initCustomSelect(s));
        syncLiveFormattingRow();
        return;
    }
    // a slider's fill is a style only an input or this sets, so a view drawn without it shows the stylesheet's default
    if (_view === 'context') { body.innerHTML = contextViewHtml(); syncRangeFill(body); return; }
    if (!_chatId) {
        body.innerHTML = '<div class="cas-empty"><div class="cas-empty-mark"><i class="fa-solid fa-comments"></i></div><p class="cas-empty-lead">Open a chat to use the assistant.</p></div>';
        return;
    }
    if (!_messages.length) { body.innerHTML = emptyHtml(); return; }
    body.innerHTML = _messages.map((m, i) => messageHtml(m, i)).join('');
    // the streaming placeholder lives outside _messages and the paint loop finds its node per frame, so restore the shell here
    if (_openStream && !document.getElementById('casStreaming')) {
        body.insertAdjacentHTML('beforeend', casStreamingHtml(_openStream.painting));
        _livePainter?.paintNow();
    }
    syncRangeFill(body);
    body.querySelectorAll('select').forEach(s => CoreAPI.initCustomSelect(s));
    body.scrollTop = body.scrollHeight;
}

// One source for the placeholder row: generate() births it, render() restores it.
function casStreamingHtml(painting) {
    return `
        <div class="cas-msg is-assistant ${painting ? 'is-streaming' : 'is-pending'}" id="casStreaming">
            <div class="cas-msg-head">
                <span class="cas-msg-who"><i class="fa-solid fa-robot"></i>Assistant</span>
                <span class="cas-msg-time" id="casLiveStatus">thinking · 0s</span>
            </div>
            <div class="cas-msg-body">${painting ? '' : '<span class="cas-thinking"><i class="fa-solid fa-circle-notch fa-spin"></i>Thinking</span>'}</div>
        </div>`;
}

// ========================================
// DATA
// ========================================

async function api(path, method = 'GET', payload) {
    return CoreAPI.readAnswer(await CoreAPI.apiRequest(path, method, payload));
}

// the stamp of a turn as shown: the server refuses a write whose seq another tab renumbered since
function shownAt(seq) {
    const at = _messages[seq]?.at;
    return Number.isFinite(at) ? `at=${at}` : '';
}

/** Is the session on screen this chat's? A send built against another chat's session lands in the wrong transcript. */
function ownsSession() {
    if (_chatId && _sessionId && _sessions.some(s => s.id === _sessionId && s.chatId === _chatId)) return true;
    console.warn('[Assistant] refused a write against another chat\'s session', { chat: _chatId, session: _sessionId });
    return false;
}

// create: false is the feed's read, which never writes; the reader's first line makes the next session (ensureSession)
async function loadSessions({ pick = null, create = true } = {}) {
    if (!_chatId) { _sessions = []; _sessionId = null; _messages = []; return; }
    // a list answered after the reader picked another session or the chat moved is late: their screen stands
    const chatId = _chatId;
    const was = _sessionId;
    const list = await api(`/assistant/sessions?chatId=${encodeURIComponent(chatId)}`);
    if (_chatId !== chatId || _sessionId !== was) return;
    _sessions = list;
    if (!_sessions.length) {
        if (!create) {
            _sessionId = null;
            _messages = [];
            _proposals.clear();
            review.clear();
            render();
            return;
        }
        const created = await api('/assistant/sessions', 'POST', { chatId });
        if (_chatId !== chatId || _sessionId !== was) return;
        _sessions = [created];
    }
    const wanted = pick || _sessionId;
    const target = _sessions.find(s => s.id === wanted) || _sessions[0];
    await openSession(target.id);
}

// keepScroll: recovery re-reads keep the reader's place (at-bottom re-pins to the NEW
// bottom, since the transcript may have shrunk); the end-jump is for arrivals only.
async function openSession(id, { keepScroll = false } = {}) {
    const scroller = keepScroll ? document.getElementById('casBody') : null;
    const wasAtBottom = !!scroller && scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 48;
    const savedScroll = scroller ? scroller.scrollTop : null;
    const restoreScroll = () => {
        if (savedScroll == null) return;
        const body = document.getElementById('casBody');
        if (body) body.scrollTop = wasAtBottom ? body.scrollHeight : savedScroll;
    };
    _sessionId = id;
    _proposals.clear();
    review.clear();
    _redirects.clear();
    _namedBooks.clear();
    let full;
    try {
        full = await api(`/assistant/sessions/${encodeURIComponent(id)}`);
    } catch (e) {
        // a failed switch must not leave the write address on the new session under the old transcript
        if (_sessionId !== id) return;
        _messages = [];
        render();
        const body = document.getElementById('casBody');
        if (body) {
            body.innerHTML = `<div class="cas-empty"><i class="fa-solid fa-triangle-exclamation"></i>
                <p>Could not open this session.</p><p class="cas-dim">${esc(e.message)}</p></div>`;
        }
        return;
    }
    // Switched again while this was loading: the later pick owns the screen.
    if (_sessionId !== id) return;
    _messages = full.messages || [];
    // the session remembers who answered it; an id missing from the list keeps the current one
    if (full.profileId && _profiles.some(p => p.id === full.profileId)) { _profileId = full.profileId; void syncSight(); } // its sight too
    // recovery re-reads skip this paint: it flashes every proposal card as a skeleton
    if (!keepScroll) render();
    // verdicts judge the world as it is NOW, so fetched per open; a reply with none is marked known-empty; patch: false
    const refreshes = [];
    for (let i = 0; i < _messages.length; i++) {
        const m = _messages[i];
        if (m.role !== 'assistant') continue;
        if (m.extra?.proposals?.length) refreshes.push(refreshProposals(i, { patch: false }));
        else markKnownEmpty(_proposals, i, m);
    }
    // verdicts settle before the paint, so nothing shifts under the restored scroll
    if (refreshes.length) await Promise.allSettled(refreshes);
    if (_sessionId !== id) return;
    // a re-read in place leaves a Settings or Context view alone; the chat draws it on return
    if (keepScroll && _view !== 'chat') return;
    render();
    restoreScroll();
}

// another tab wrote this chat's sessions: re-read in place, unless a stream, review work or Settings holds it (then owed)
let _staleFromFeed = false;

async function patchSessionsFromFeed(records) {
    if (!open || !_chatId) return;
    const ours = (r) => r.chatId === _chatId || (r.ids || []).some(id => _sessions.some(s => s.id === id));
    if (records && !records.some(ours)) return;
    if (busy() || _editing !== null || _rejected.size || _openEdits.size || _edits.size || _redirects.size || _namedBooks.size || _view === 'settings') {
        _staleFromFeed = true;
        return;
    }
    _staleFromFeed = false;
    try {
        if (!records || records.some(r => r.op !== 'updated')) await loadSessions({ create: false });
        else if (records.some(r => (r.ids || []).includes(_sessionId))) await openSession(_sessionId, { keepScroll: true });
    } catch (e) {
        console.warn('[Assistant] could not follow a change made elsewhere:', e.message);
    }
}

// a hold ended: run the owed re-read, checking every other hold first, before the next seq-addressed write
function followOwed() {
    if (_staleFromFeed) void patchSessionsFromFeed(null);
}

async function refreshProposals(seq, { patch = true } = {}) {
    // Captured: a slow response must not paint verdicts across a session switch (the
    // new transcript can legitimately hold the same seq).
    const sid = _sessionId;
    if (!sid) return;
    try {
        const data = await api(`/assistant/sessions/${encodeURIComponent(sid)}/proposals/${seq}`);
        if (_sessionId !== sid) return;
        _proposals.set(seq, { proposals: data.proposals || [], errors: data.errors || [] });
    } catch (e) {
        console.error('[Assistant] Could not read the proposals:', e.message);
        if (_sessionId !== sid) return;
        _proposals.set(seq, { failed: true });
    }
    if (!patch) return;
    const host = document.querySelector(`.cas-msg[data-seq="${seq}"]`);
    const existing = host?.querySelector('.cas-props');
    if (!host) return;
    if (existing) existing.outerHTML = proposalsHtml(seq);
    else host.querySelector('.cas-msg-body')?.insertAdjacentHTML('afterend', proposalsHtml(seq));
    host.parentElement?.querySelectorAll(`.cas-props[data-seq="${seq}"] select`).forEach(s => CoreAPI.initCustomSelect(s));
}

function findProposal(seq, id) {
    return (_proposals.get(seq)?.proposals || []).find(x => x.id === id) || null;
}


// a creates-the-book member re-renders as one (or the per-entry banner returns); the selects get their chrome back
function repaintProp(seq, id, { carryPick = true } = {}) {
    const p = findProposal(seq, id);
    if (!p) return;
    repaintReviewCard(seq, id, (card) => proposalCardHtml(p, { inGroup: !!card.closest('.cas-prop-group'), seq }), {
        carryPick, after: (fresh) => fresh.querySelectorAll('select').forEach(s => CoreAPI.initCustomSelect(s)),
    });
}

function toggleDiff(seq, id) {
    if (!id) return;
    const pk = propKey(seq, id);
    if (_openDiffs.has(pk)) _openDiffs.delete(pk);
    else _openDiffs.add(pk);
    repaintProp(seq, id);
}

async function loadProfiles() {
    const s = await CoreAPI.getLlmSettings();
    _profiles = s.profiles || [];
    _profilesNote = s.error ? 'Could not read the connections'
        : (!_profiles.length ? 'No connections yet: add one in Settings > AI' : '');
    const saved = CoreAPI.getSetting('assistantProfileId');
    _profileId = (saved && _profiles.some(p => p.id === saved)) ? saved : (_profiles[0]?.id || null);
}

// ========================================
// SENDING
// ========================================

function setBusy(on) {
    _busy = on;
    document.getElementById('casSend')?.classList.toggle('hidden', on);
    document.getElementById('casStop')?.classList.toggle('hidden', !on);
    const input = document.getElementById('casInput');
    if (input) input.disabled = on;
    // the opener says a reply is on its way while the panel is closed
    document.getElementById('chatConvAssistant')?.classList.toggle('is-working', on);
    if (!on) followOwed();
}

/** Mint the session on the reader's first line when the chat has none, never on a read: the feed's empty state leaves no litter. */
async function ensureSession() {
    if (_sessionId) return _sessionId;
    const chatId = _chatId;
    const created = await api('/assistant/sessions', 'POST', { chatId });
    // the subject moved on, or a session arrived meanwhile: this one isnt the screen's
    if (_chatId !== chatId || _sessionId) return _sessionId;
    _sessions = [created, ..._sessions];
    _sessionId = created.id;
    _messages = [];
    return created.id;
}

async function send() {
    const input = document.getElementById('casInput');
    const text = String(input?.value || '').trim();
    if ((!text && !_tray.items.length) || busy()) return;
    if (!_sessionId && !_sessions.length && _chatId) {
        _posting = true;
        try {
            await ensureSession();
        } catch (e) {
            CoreAPI.showToast(`Could not start a session: ${e.message}`, 'error');
            return;
        } finally {
            _posting = false;
        }
    }
    // The refusal gets a voice: a silent return here is indistinguishable from a broken
    // send button, and the guard's console.warn is not a user surface.
    if (!ownsSession()) {
        CoreAPI.showToast('The assistant is not ready for this chat yet. Close and reopen the panel.', 'error');
        return;
    }
    await askAndGenerate(text, { fromInput: true, pictures: _tray.items });
}

// the reader's turn and its reply land in the session captured before the POST; _posting holds every busy gate meanwhile
async function askAndGenerate(ask, { fromInput = false, pictures = [] } = {}) {
    if (busy() || !ownsSession()) return;
    const sid = _sessionId;
    let stored;
    _posting = true;
    const shown = pictures.length ? _tray.take() : [];
    try {
        stored = await api(`/assistant/sessions/${encodeURIComponent(sid)}/messages`, 'POST', {
            role: 'user', content: ask, ...(shown.length ? { pictures: shown.map(p => ({ kind: p.kind, id: p.id })) } : {}),
        });
    } catch (e) {
        if (_sessionId === sid) _tray.giveBack(shown);
        _posting = false;
        CoreAPI.showToast(`Could not ${fromInput ? 'send' : 'ask'}: ${e.message}`, 'error');
        followOwed();
        return;
    }
    _posting = false;
    if (_sessionId !== sid) { followOwed(); return; }
    _messages.push(stored.message);
    if (fromInput) {
        const input = document.getElementById('casInput');
        if (input) { input.value = ''; _fitInput(); }
    }
    render();
    await generate(sid);
}

// ========================================
// PICTURES
// ========================================

// the answering connection's sight, as the conversation's paperclip reads it
async function syncSight() {
    const profileId = _profileId;
    const sees = await connectionSight(_profiles.find(p => p.id === profileId) || null);
    if (_profileId !== profileId) return;
    _sees = sees;
    const btn = document.getElementById('casAttach');
    if (btn) btn.hidden = _sees !== true;
    if (_sees !== true && _pick) closeGalleryPick();
}

// a connection written anywhere reads again while the panel is open; a session's own connection stays the one that answers
async function followConnections() {
    if (!open) return;
    const answering = _profileId;
    await loadProfiles();
    if (answering && _profiles.some(p => p.id === answering)) _profileId = answering;
    await syncSight();
}

/** Pictures from the reader's device into the chat's gallery, held for the next ask; a chat left mid-upload holds nothing over. */
async function attachFiles(files) {
    const chatId = _chatId;
    if (!chatId || _sees !== true) return;
    await attachToChat(_tray, chatId, files, () => _chatId === chatId);
}

function openAttachMenu(e) {
    const btn = e.target.closest('[data-cas-act]');
    const r = btn.getBoundingClientRect();
    const name = _char?.name || 'The character';
    CoreAPI.getModule('context-menu')?.showItems?.(e, [
        { icon: 'fa-solid fa-upload', label: 'Pictures from this device', action: () => document.getElementById('casAttachInput')?.click() },
        { icon: 'fa-solid fa-user', label: `${name}'s portrait`, disabled: !_char?.id, action: () => _tray.add({ kind: 'avatar', id: _char.id, name: `${name}.png` }) },
        { icon: 'fa-solid fa-images', label: `${name}'s gallery`, disabled: !_char?.id, action: () => void openGalleryPick() },
    ], { x: r.left, y: r.top });
}

// the character's gallery as a shelf over the composer: each tile a tap into or out of the tray, by reference
let _pick = null; // { charId, items (null while read), error } while the shelf is open

async function openGalleryPick() {
    const char = _char;
    if (!char?.id || _sees !== true) return;
    const pick = { charId: char.id, items: null, error: null };
    _pick = pick;
    renderGalleryPick();
    try {
        const info = await CoreAPI.getCharacterGalleryInfo(char);
        pick.items = (info?.items || []).filter(i => i.mediaId != null && CoreAPI.galleryKindOf(i) === 'image');
    } catch (e) {
        pick.error = e.message;
    }
    // closed, or another character's shelf opened, while the gallery was read
    if (_pick === pick) renderGalleryPick();
}

function closeGalleryPick() {
    _pick = null;
    renderGalleryPick();
}

const pickedMedia = () => new Set(_tray.items.filter(p => p.kind === 'media').map(p => String(p.id)));
const pickedText = (n) => (n ? `${n} picked` : '');

function renderGalleryPick() {
    const shelf = document.getElementById('casPick');
    if (!shelf) return;
    shelf.hidden = !_pick;
    if (!_pick) { shelf.innerHTML = ''; return; }
    const name = esc(_char?.name || 'The character');
    const picked = pickedMedia();
    const body = _pick.error
        ? `<div class="cl-cwin-empty is-error"><i class="fa-solid fa-triangle-exclamation"></i><p>Could not read ${name}'s gallery.</p><p class="cl-cwin-dim">${esc(_pick.error)}</p></div>`
        : _pick.items === null
            ? `<div class="cl-cwin-empty"><i class="fa-solid fa-spinner fa-spin"></i><p>Reading ${name}'s gallery...</p></div>`
            : !_pick.items.length
                ? `<div class="cl-cwin-empty"><i class="fa-solid fa-images"></i><p>No pictures in ${name}'s gallery.</p></div>`
                : `<div class="cl-cwin-tiles cas-pick-grid">${_pick.items.map((i) => {
                    const on = picked.has(String(i.mediaId));
                    return `<button type="button" class="cl-cwin-tile cas-pick-tile${on ? ' is-active' : ''}" data-cas-act="pick-toggle" data-media-id="${esc(i.mediaId)}" aria-pressed="${on}" title="${esc(i.name)}">
                        <img src="${esc(CoreAPI.thumbUrl('media', i.mediaId, 192))}" alt="${esc(i.name)}" loading="lazy" decoding="async">
                        <i class="fa-solid fa-check cas-pick-check" aria-hidden="true"></i>
                    </button>`;
                }).join('')}</div>`;
    shelf.innerHTML = `<div class="cas-pick-head">
            <span class="cas-pick-title"><i class="fa-solid fa-images"></i>${name}'s gallery</span>
            <span class="cas-pick-count" id="casPickCount">${pickedText(picked.size)}</span>
            <button type="button" class="cl-cwin-btn-text is-primary" data-cas-act="pick-done">Done</button>
        </div>
        <div class="cas-pick-body">${body}</div>`;
}

// the tray moved (a tap, a remove, a send): the tiles mark what waits, in place, so the shelf keeps its scroll
function syncPickMarks() {
    const shelf = document.getElementById('casPick');
    if (!_pick || !shelf) return;
    const picked = pickedMedia();
    shelf.querySelectorAll('[data-media-id]').forEach((t) => {
        const on = picked.has(t.dataset.mediaId);
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-pressed', String(on));
    });
    const count = document.getElementById('casPickCount');
    if (count) count.textContent = pickedText(picked.size);
}

function togglePick(mediaId) {
    const item = _pick?.items?.find(i => String(i.mediaId) === String(mediaId));
    if (!item || _sees !== true) return;
    const at = _tray.items.findIndex(p => p.kind === 'media' && String(p.id) === String(item.mediaId));
    if (at !== -1) _tray.removeAt(at);
    else _tray.add({ kind: 'media', id: item.mediaId, name: item.name });
}

/** The assistant's own generation overrides, folded over the profile's params server-side; only set values are named. */
function genOverrides() {
    const p = {};
    const effort = String(CoreAPI.getSetting('assistantReasoningEffort') || '');
    if (effort) p.reasoning = { effort };
    const cap = Number(CoreAPI.getSetting('assistantMaxReply'));
    if (Number.isFinite(cap) && cap > 0) p.maxTokens = cap;
    const t = CoreAPI.getSetting('assistantTemperature');
    if (t !== '' && t != null && Number.isFinite(Number(t))) p.temperature = Number(t);
    return Object.keys(p).length ? p : undefined;
}

async function generate(sid = _sessionId) {
    // captured once (or handed in): every completion path checks the LIVE _sessionId, so a switch makes the rest a no-op
    if (!sid || _sessionId !== sid || !ownsSession()) return;
    // the server reads the engine switches and turn count to build the request, and those writes are debounced
    await CoreAPI.flushSettings();
    if (_sessionId !== sid) return;
    setBusy(true);
    _abort = new AbortController();

    // the placeholder is NOT in _messages (the stored row arrives on done); token painting is opt-in here
    const live_ = assistantStreams();
    _openStream = { painting: live_ };
    const body = document.getElementById('casBody');
    body?.insertAdjacentHTML('beforeend', casStreamingHtml(live_));
    if (body) body.scrollTop = body.scrollHeight;

    const t0 = Date.now();
    const liveTimer = setInterval(() => {
        const el = document.getElementById('casLiveStatus');
        if (el) el.textContent = `${acc ? 'writing' : 'thinking'} · ${Math.round((Date.now() - t0) / 1000)}s`;
    }, 500);

    let acc = '';
    let sawDone = false;
    const paint = () => {
        // Resolved per paint, never captured: a mid-stream render() replaces the
        // placeholder node, and painting into the detached one showed nothing.
        const live = document.querySelector('#casStreaming .cas-msg-body');
        if (!live) return;
        paintPanelReply(live, 'assistant', (opts) => renderText(stripBlocks(acc), opts));
        const host = document.getElementById('casBody');
        if (host) host.scrollTop = host.scrollHeight;
    };
    // the conversation's cadence, nothing painted out of sight; no painter at all when painting is off
    const painter = live_ ? createLivePainter({
        paint,
        held: () => !open || document.hidden || !document.documentElement.classList.contains('cl-chat-open'),
    }) : null;
    _livePainter = painter;

    try {
        const profileId = _profileId || null;
        await CoreAPI.streamAssistantGeneration(sid, { profileId, params: genOverrides(), signal: _abort.signal }, (ev) => {
            if (_sessionId !== sid) return;
            if (typeof ev.text === 'string') {
                acc += ev.text;
                painter?.mark();
            }
            // an intermediate stored turn (a cl-read and its answer): the placeholder paints the follow-up from a clean slate
            if (ev.row?.message) {
                _messages.push(ev.row.message);
                acc = '';
            }
            if (ev.done?.message) {
                sawDone = true;
                _messages.push(ev.done.message);
            }
        });
        // closed before the settle's render, or it restores the placeholder for the whole proposal judging
        _openStream = null;
        const reader = closePanelStream('casStreaming', painter);
        if (_sessionId !== sid) return;
        // a stream that just STOPS (no done, no error: a proxy idle-cut) is a failure; re-read, only the server knows what was stored
        if (acc && !sawDone) {
            CoreAPI.showToast('The connection dropped before the reply finished.', 'error');
            await openSession(sid, { keepScroll: true });
            return;
        }
        const last = _messages.length - 1;
        markKnownEmpty(_proposals, last, _messages[last]);
        // a Settings or Context view the reader is in stays as it is (an open sheet, their typing); the chat draws it on return
        if (_view === 'chat') render();
        carryPanelReply('casBody', last, reader);
        if (_messages[last]?.extra?.proposals?.length) await refreshProposals(last);
    } catch (e) {
        _openStream = null;
        document.getElementById('casStreaming')?.remove();
        // the subject moved on: re-reading or toasting about this session is noise about a chat not shown
        if (_sessionId !== sid) return;
        if (!e.isCancelled) CoreAPI.showToast(`The assistant could not answer: ${e.message}`, 'error');
        // A stop or a failure may still have stored a partial server-side, so the
        // transcript is re-read rather than guessed at.
        await openSession(sid, { keepScroll: true });
    } finally {
        clearInterval(liveTimer);
        painter?.stop();
        if (_livePainter === painter) _livePainter = null;
        setBusy(false);
        _abort = null;
    }
}

/** Ask again from a turn: an assistant turn drops itself and what follows, a user turn what follows (nothing, if last). */
async function retryFrom(seq) {
    if (busy() || !ownsSession()) return;
    const from = _messages[seq]?.role === 'assistant' ? seq : seq + 1;
    const dropping = Math.max(0, _messages.length - from);
    // read now: the transcript may be re-read while the confirm is open
    const seen = shownAt(from);
    if (dropping > 0) {
        const ok = await CoreAPI.showConfirm({
            title: 'Ask again',
            message: dropping === 1
                ? 'This drops that reply and asks again.'
                : `This drops ${dropping} messages from here on, then asks again.`,
            confirmLabel: 'Ask again',
        });
        if (!ok) return;
    }
    // the drop and the reply belong to one session, held from a switch or a re-read between them
    const sid = _sessionId;
    try {
        if (dropping > 0) {
            _posting = true;
            try {
                await api(`/assistant/sessions/${encodeURIComponent(sid)}/messages/${from}?${seen}`, 'DELETE');
                // the chat moved on while the drop was out: the session it left is not reopened
                if (_sessionId !== sid) return;
                await openSession(sid);
            } finally {
                _posting = false;
            }
        }
        await generate(sid);
    } catch (e) {
        // the transcript changed under the reader: shown as it is now
        if ((e.status === 404 || e.status === 409) && _sessionId === sid) await openSession(sid, { keepScroll: true }).catch(() => { /* the toast below says what failed */ });
        CoreAPI.showToast(`Could not retry: ${e.message}`, 'error');
        followOwed();
    }
}

// ========================================
// APPLYING
// ========================================

async function applySelected(seq) {
    if (!ownsSession() || refuseWhileBusy()) return;
    const host = document.querySelector(`.cas-props[data-seq="${seq}"]`);
    const ids = [...(host?.querySelectorAll('.cas-prop-pick:checked') || [])]
        .map(cb => cb.closest('.cas-prop')?.dataset.propId).filter(Boolean);
    if (!ids.length) { CoreAPI.showToast('Nothing selected', 'info'); return; }

    const ok = await CoreAPI.showConfirm({
        title: 'Apply changes',
        message: `${ids.length} change${ids.length === 1 ? '' : 's'} will be written to your lorebooks and chat.`,
        confirmLabel: 'Apply',
    });
    if (!ok) return;
    await runApply(seq, ids);
}

// One item, one click, no confirm. The confirm guards the
// BULK verb, where a stray click writes everything; here the click names exactly one thing.
async function applyOne(seq, id) {
    if (!ownsSession() || !id || refuseWhileBusy()) return;
    await runApply(seq, [id]);
}

// "New book": the apply creates and links it, so no server surface; _namedBooks offers it to every other create
async function pickNewBook(seq, id) {
    const name = await CoreAPI.showConfirm({
        title: 'New lorebook',
        message: 'Name the book this entry should be created in. It is created and linked to the character when you apply.',
        confirmLabel: 'Use this book',
        input: { placeholder: 'Book name' },
    });
    const pk = propKey(seq, id);
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) {
        // A cancel repaints too: the select is sitting on the sentinel and has to snap back.
        repaintProp(seq, id);
        return;
    }
    _namedBooks.add(trimmed);
    if (trimmed === findProposal(seq, id)?.change?.world) _redirects.delete(pk);
    else _redirects.set(pk, trimmed);

    // The rest of this reply's pending creates: ready, not set aside, not this one.
    const others = (_proposals.get(seq)?.proposals || []).filter(p =>
        p.id !== id && p.engine === 'lore' && p.change?.op === 'create'
        && p.status === 'ready' && !_rejected.has(propKey(seq, p.id)));
    if (others.length) {
        const all = await CoreAPI.showConfirm({
            title: 'Same book for the rest?',
            message: `This reply proposes ${others.length} more new ${others.length === 1 ? 'entry' : 'entries'}. Send ${others.length === 1 ? 'it' : 'them'} to "${trimmed}" too?`,
            confirmLabel: 'All of them',
            cancelLabel: 'Just this one',
        });
        if (all === true) {
            for (const p of others) {
                if (trimmed === p.change?.world) _redirects.delete(propKey(seq, p.id));
                else _redirects.set(propKey(seq, p.id), trimmed);
                repaintProp(seq, p.id);
            }
        }
    }
    repaintProp(seq, id);
}

async function runApply(seq, ids) {
    // The reviewer's touch-ups ride the call and never touch the stored proposal.
    const overrides = {};
    for (const id of ids) {
        // The stores key by seq + id; the wire keys by the raw id, unique within this seq.
        const o = {};
        if (_edits.has(propKey(seq, id))) o.content = _edits.get(propKey(seq, id));
        if (_redirects.has(propKey(seq, id))) o.world = _redirects.get(propKey(seq, id));
        if (Object.keys(o).length) overrides[id] = o;
    }
    try {
        const out = await api(`/assistant/sessions/${encodeURIComponent(_sessionId)}/apply`, 'POST',
            { seq, ids, ...(Object.keys(overrides).length ? { overrides } : {}) });
        const applied = out.results.filter(r => r.status === 'applied').length;
        const refused = out.results.length - applied;
        if (applied) CoreAPI.showToast(`Applied ${applied} change${applied === 1 ? '' : 's'}${refused ? `, refused ${refused}` : ''}`, refused ? 'warning' : 'success');
        else CoreAPI.showToast('Nothing was applied', 'warning');

        // the write was the server's, so tell every open surface: lore edits reach the panels, a message edit the conversation
        for (const world of out.touched.worlds || []) CoreAPI.notifyWorldsChanged(world, 'assistant');
        if (out.touched.chat) document.dispatchEvent(new CustomEvent('cl-assistant-edited-chat', { detail: { chatId: _chatId } }));
        // a new book is also a new LINK on the character, so the character's lore surfaces are stale too
        if (out.results.some(r => r.result?.createdBook) && _char?.id) {
            CoreAPI.notifyCharacterChanged(_char.id);
        }

        await rejudgeProposals(seq);
        // The strip counts entries and messages that an apply just changed.
        void refreshContext();
    } catch (e) {
        CoreAPI.showToast(`Could not apply: ${e.message}`, 'error');
    }
}

// an apply moves what EVERY block judged: re-judge each block with a live card; the acted one always refreshes
async function rejudgeProposals(actedSeq) {
    const jobs = [];
    for (let i = 0; i < _messages.length; i++) {
        const m = _messages[i];
        if (m.role !== 'assistant' || !m.extra?.proposals?.length) continue;
        const st = _proposals.get(i);
        const terminal = st && !st.failed && st.proposals.length && st.proposals.every(p => p.status === 'applied');
        if (i !== actedSeq && terminal) continue;
        jobs.push(refreshProposals(i, { patch: true }));
    }
    await Promise.allSettled(jobs);
}

// ========================================
// SESSIONS MENU
// ========================================

// The same gate the send family carries: mid-stream, a session verb or an apply moves the
// ground the running commit is about to land on.
function refuseWhileBusy() {
    if (!busy()) return false;
    CoreAPI.showToast('Wait for the reply to finish, or stop it first', 'info');
    return true;
}

async function renameSession() {
    if (refuseWhileBusy() || !_sessionId) return;
    const current = _sessions.find(s => s.id === _sessionId);
    // showConfirm's input mode IS the prompt in this codebase; it answers with the string.
    const name = await CoreAPI.showConfirm({
        title: 'Rename session',
        confirmLabel: 'Rename',
        input: { value: current?.name || '', placeholder: 'Session name' },
    });
    if (typeof name !== 'string' || !name.trim() || name === current?.name) return;
    try {
        await api(`/assistant/sessions/${encodeURIComponent(_sessionId)}`, 'PATCH', { name: name.trim() });
        await loadSessions({ pick: _sessionId });
    } catch (e) { CoreAPI.showToast(`Could not rename: ${e.message}`, 'error'); }
}

async function deleteSession() {
    if (refuseWhileBusy() || !_sessionId) return;
    const ok = await CoreAPI.showConfirm({
        title: 'Delete session',
        message: 'This removes the conversation with the assistant. Your chat and lorebooks are untouched.',
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;
    try {
        await api(`/assistant/sessions/${encodeURIComponent(_sessionId)}`, 'DELETE');
        _sessionId = null;
        await loadSessions();
    } catch (e) { CoreAPI.showToast(`Could not delete: ${e.message}`, 'error'); }
}

async function newSession() {
    if (!_chatId || refuseWhileBusy()) return;
    try {
        const created = await api('/assistant/sessions', 'POST', { chatId: _chatId });
        await loadSessions({ pick: created.id });
    } catch (e) { CoreAPI.showToast(`Could not start a session: ${e.message}`, 'error'); }
}

// ========================================
// LIFECYCLE
// ========================================

function injectPanel() {
    if (injected) return;
    const host = document.getElementById('chatsConversation');
    if (!host) return;
    injected = true;
    host.insertAdjacentHTML('beforeend', buildHTML());

    const sheet = document.querySelector('.cas-sheet');
    mountChatWindow(sheet, {
        key: 'chatAssistPanel',
        close: closePanel,
        min: { w: 22, h: 30 },
    });

    document.getElementById('chatAssistantPanel')?.addEventListener('click', (e) => {
        const off = e.target.closest('[data-tray-remove]');
        if (off) return _tray.removeAt(Number(off.dataset.trayRemove));
        const btn = e.target.closest('[data-cas-act]');
        if (!btn) return;
        switch (btn.dataset.casAct) {
            case 'close': return closePanel();
            case 'send': return void send();
            case 'attach': return openAttachMenu(e);
            case 'pick-toggle': return togglePick(btn.dataset.mediaId);
            case 'pick-done': return closeGalleryPick();
            case 'picture': return openPictures(_messages[Number(btn.dataset.seq)]?.extra?.pictures, btn.dataset.index, 'Pictures');
            case 'stop': return _abort?.abort();
            case 'new-session': return void newSession();
            case 'rename-session': return void renameSession();
            case 'delete-session': return void deleteSession();
            case 'context-view': _view = _view === 'context' ? 'chat' : 'context'; return render();
            case 'settings': return toggleSettings();
            case 'load-default': return void loadDefaultPrompt();
            case 'clear-prompt': return clearPrompt();
            case 'retry-proposals': return void refreshProposals(Number(btn.dataset.seq));
            case 'fix-block': return void fixBlock(Number(btn.dataset.seq));
            case 'requote': return void requoteProposal(Number(btn.closest('.cas-props')?.dataset.seq), btn.dataset.propId);
            case 'apply': return void applySelected(Number(btn.dataset.seq));
            case 'apply-one': return void applyOne(Number(btn.closest('.cas-props')?.dataset.seq), btn.dataset.propId);
            case 'reject-one': {
                const seq = Number(btn.closest('.cas-props')?.dataset.seq);
                _rejected.add(propKey(seq, btn.dataset.propId));
                repaintProp(seq, btn.dataset.propId, { carryPick: false });
                return syncPropsChrome(seq);
            }
            case 'restore-one': {
                const seq = Number(btn.closest('.cas-props')?.dataset.seq);
                _rejected.delete(propKey(seq, btn.dataset.propId));
                repaintProp(seq, btn.dataset.propId, { carryPick: false });
                syncPropsChrome(seq);
                return followOwed();
            }
            case 'edit-prop': {
                const seq = Number(btn.closest('.cas-props')?.dataset.seq);
                const pk = propKey(seq, btn.dataset.propId);
                if (_openEdits.has(pk)) _openEdits.delete(pk); else _openEdits.add(pk);
                repaintProp(seq, btn.dataset.propId);
                return followOwed();
            }
            case 'retry': return void retryFrom(Number(btn.dataset.seq));
            case 'copy': return void copyReply(Number(btn.dataset.seq));
            case 'edit': return beginEdit(Number(btn.dataset.seq));
            case 'edit-cancel': return cancelEdit();
            case 'edit-save': return void saveEdit(Number(btn.dataset.seq));
            case 'delete': return void deleteOne(Number(btn.dataset.seq));
            case 'starter': return useStarter(btn.dataset.text);
            case 'toggle-prompts': return togglePromptChips();
            case 'use-prompt': return usePrompt(btn.dataset.promptId);
            // add, delete and reorder re-render the settings view (no transcript on screen there)
            case 'prompt-add': if (prompts.add()) { render(); renderPromptChips(); } return undefined;
            case 'prompt-delete': if (prompts.remove(btn.dataset.promptId)) { render(); renderPromptChips(); } return undefined;
            case 'prompt-up': if (prompts.move(btn.dataset.promptId, -1)) { render(); renderPromptChips(); } return undefined;
            case 'prompt-down': if (prompts.move(btn.dataset.promptId, 1)) { render(); renderPromptChips(); } return undefined;
            case 'retry-prompts': return void prompts.load().then(() => { render(); renderPromptChips(); });
            case 'nudge': return void nudgeForProposal(Number(btn.dataset.seq));
            case 'toggle-diff': return toggleDiff(Number(btn.closest('.cas-props')?.dataset.seq), btn.dataset.propId);
            default: return undefined;
        }
    });

    // delegated: the turns slider's view is rebuilt every render
    document.getElementById('chatAssistantPanel')?.addEventListener('input', (e) => {
        if (e.target.id !== 'casTurns') return;
        const out = document.getElementById('casTurnsOut');
        if (out) out.textContent = e.target.value;
    });
    document.getElementById('chatAssistantPanel')?.addEventListener('change', async (e) => {
        if (e.target.id !== 'casTurns') return;
        const n = parseInt(e.target.value, 10);
        if (!Number.isFinite(n) || n < 1) return;
        CoreAPI.setSetting('assistantChatTurns', n);
        // flush first: the server recomputes the range from the number (the engine switches' debounce trap)
        await CoreAPI.flushSettings();
        await refreshContext();
    });

    // one delegated listener for every settings control; change, not input, or the prompt box PATCHes per keystroke
    const panelEl = document.getElementById('chatAssistantPanel');
    panelEl?.addEventListener('change', async (e) => {
        const el = e.target.closest('[data-set]');
        if (!el) return;
        onSettingInput(el);
        // These are the same values the strip and the next request read from the server, so
        // the write goes out before anything asks about it.
        await CoreAPI.flushSettings();
        void refreshContext();
    });
    panelEl?.addEventListener('change', (e) => {
        if (e.target.id !== 'casPrompt') return;
        CoreAPI.setSetting('assistantSystemPrompt', e.target.value.trim());
    });
    // saved-prompt fields, delegated (the editor re-renders on add, delete, reorder); change, or every key queues a write
    panelEl?.addEventListener('change', (e) => {
        const field = e.target.dataset?.promptField;
        if (!field) return;
        const id = e.target.closest('.cas-qp-edit')?.dataset.promptId;
        // field edits repaint the chips only: the reader is typing in one of these boxes
        if (id && prompts.setField(id, field, e.target.value)) renderPromptChips();
    });

    const input = document.getElementById('casInput');
    _fitInput = wirePanelComposer({ box: input, send, picker: document.getElementById('casAttachInput'), drops: [panelEl], attach: attachFiles, blocked: () => _sees !== true });
    // delegated: the toolbar repaints wholesale, so a bound listener dies on the first repaint
    panelEl?.addEventListener('change', (e) => {
        if (e.target.id !== 'casSessionSel') return;
        // Mid-stream the selector snaps back rather than silently holding a value the
        // panel refused: the box must show the session actually on screen.
        if (busy()) {
            e.target.value = _sessionId || '';
            e.target._customSelect?.update?.();
            refuseWhileBusy();
            return;
        }
        if (e.target.value && e.target.value !== _sessionId) void openSession(e.target.value);
    });
    // The reviewer's touch-ups: matching the original clears the override, so "I put it
    // back" and "I never touched it" are the same state.
    panelEl?.addEventListener('change', (e) => {
        const seq = Number(e.target.closest?.('.cas-props')?.dataset.seq);
        const editId = e.target.dataset?.propEdit;
        if (editId) {
            const original = String(findProposal(seq, editId)?.change?.content ?? '');
            if (e.target.value === original) _edits.delete(propKey(seq, editId));
            else _edits.set(propKey(seq, editId), e.target.value);
            repaintProp(seq, editId);
            return followOwed();
        }
        const destId = e.target.dataset?.propWorld;
        if (destId) {
            if (e.target.value === '__cas_new_book__') return void pickNewBook(seq, destId);
            const original = findProposal(seq, destId)?.change?.world;
            if (e.target.value === original) _redirects.delete(propKey(seq, destId));
            else _redirects.set(propKey(seq, destId), e.target.value);
            repaintProp(seq, destId);
            return followOwed();
        }
        return undefined;
    });
    // delegated: the select is re-created on every settings render
    panelEl?.addEventListener('change', (e) => {
        if (e.target.id !== 'casProfile') return;
        _profileId = e.target.value || null;
        void syncSight();
        CoreAPI.setSetting('assistantProfileId', e.target.value);
        if (_sessionId) void api(`/assistant/sessions/${encodeURIComponent(_sessionId)}`, 'PATCH', { profileId: e.target.value })
            .catch(() => { /* the setting still holds for the next send */ });
    });

    registerChatWindow('chatAssistantPanel', { close: closePanel, follow: followCharacter });
}

let _fitInput = () => {};

async function openPanel(ctx) {
    if (ctx?.chatId !== undefined) _chatId = ctx.chatId;
    if (ctx?.char !== undefined) _char = ctx.char;
    injectPanel();
    const panel = document.getElementById('chatAssistantPanel');
    if (!panel) return;
    openChatWindow(panel, { button: 'chatConvAssistant' });
    open = true;
    // after the panel shows, so the width is real: a wrapped placeholder would shear mid-line
    requestAnimationFrame(_fitInput);
    render();
    _livePainter?.flush();
    await loadProfiles();
    void syncSight();
    // not awaited: context, prompts and persona are independent of the transcript
    void refreshContext();
    void prompts.load().then(renderPromptChips);
    void syncPromptPersona();
    try {
        // A run still streaming owns the transcript on screen: re-reading the session now
        // would paint the stored rows over the placeholder the run is filling.
        if (!busy()) await loadSessions();
    } catch (e) {
        const body = document.getElementById('casBody');
        if (body) {
            body.innerHTML = `<div class="cas-empty"><i class="fa-solid fa-triangle-exclamation"></i>
                <p>Could not load the assistant.</p><p class="cas-dim">${esc(e.message)}</p></div>`;
        }
    }
}

// closing isnt stopping: a reply keeps streaming hidden, the opener breathing; only Stop and a subject change abort
function closePanel() {
    const panel = document.getElementById('chatAssistantPanel');
    open = false;
    closeGalleryPick();
    closeChatWindow(panel, { button: 'chatConvAssistant' });
}

/** Whether a reply is streaming, panel open or not; the phone's Windows tile reads it. */
function isBusy() { return _busy; }

function togglePanel(ctx) {
    if (open) closePanel();
    else void openPanel(ctx);
}

// ========================================
// CONTEXT STRIP BEHAVIOUR
// ========================================

/** Re-read what the assistant can see: on the chat, the turn count, an engine toggle, or an applied lore edit. */
async function refreshContext() {
    if (!_chatId) { _context = null; return; }
    try {
        _context = await api(`/assistant/context?chatId=${encodeURIComponent(_chatId)}`);
    } catch (e) {
        // An honest unknown, not a fabricated empty: a strip claiming "no lorebooks"
        // because a fetch failed would be a lie the reader acts on.
        _context = null;
        console.error('[Assistant] Could not read the context:', e.message);
    }
    render();
}

/** Ask for the same change again as an applicable block; a normal turn, so the model re-formats its own answer. */
async function nudgeForProposal(seq) {
    if (busy() || !ownsSession()) return;
    const engines = [
        CoreAPI.getSetting('assistantLoreEdits') === true ? 'the lorebook block' : '',
        CoreAPI.getSetting('assistantChatEdits') === true ? 'the chat-edits block' : '',
    ].filter(Boolean).join(' or ');
    const ask = `Put that into ${engines} so I can apply it. Same change, no rewording, just the block.`;
    await askAndGenerate(ask);
}

// send the 'malformed block' ask for the reader and regenerate; the parser error already rides the app note
async function fixBlock(seq) {
    if (busy() || !ownsSession()) return;
    const state = _proposals.get(seq);
    const n = state?.errors?.length || 0;
    if (!n) return;
    const s = n > 1 ? 's' : '';
    const ask = `That edit block${s} did not parse and reached nothing. Re-issue the SAME change${s} as one valid block: keep every change flat, close each object before the next, no rewording.`;
    await askAndGenerate(ask);
}

// ask by the note's number for an unplaced replace; the note quotes the message beside the ask, where models copy from
async function requoteProposal(seq, id) {
    if (busy() || !ownsSession()) return;
    const list = _proposals.get(seq)?.proposals || [];
    const n = list.findIndex(p => p.id === id);
    if (n < 0) return;
    const at = list[n].change?.seq;
    const ask = `Change ${n + 1} could not be placed in message ${at}. Re-issue that one change, quoting the passage exactly as the app note above shows it: the same edit, nothing else reworded.`;
    await askAndGenerate(ask);
}

function useStarter(text) {
    const input = document.getElementById('casInput');
    if (!input) return;
    input.value = text;
    input.focus();
    void send();
}

// ========================================
// EDITING THE TRANSCRIPT
// ========================================

function beginEdit(seq) {
    // Same guard as retry and the nudge: transcript surgery mid-stream renumbers the seqs
    // the running generation is about to commit against.
    if (busy()) return;
    _editing = seq;
    render();
    const box = document.querySelector(`.cas-edit-box[data-seq="${seq}"]`);
    if (!box) return;
    // the conversation editor's contract: grows while typing, freeze keeps the measure from clamping the scroll
    const fitOpts = { freeze: box.closest('.cas-msg') };
    CoreAPI.fitTextarea(box, fitOpts);
    box.addEventListener('input', () => CoreAPI.fitTextarea(box, fitOpts));
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
}

function cancelEdit() {
    // backing out of an edit keeps the reader's place
    const saved = document.getElementById('casBody')?.scrollTop ?? null;
    _editing = null;
    render();
    if (saved != null) {
        const body = document.getElementById('casBody');
        if (body) body.scrollTop = saved;
    }
    followOwed();
}

async function saveEdit(seq) {
    if (busy() || !ownsSession()) return;
    const box = document.querySelector(`.cas-edit-box[data-seq="${seq}"]`);
    const text = String(box?.value ?? '');
    if (!text.trim()) { CoreAPI.showToast('A message cannot be empty', 'warning'); return; }
    try {
        await api(`/assistant/sessions/${encodeURIComponent(_sessionId)}/messages/${seq}?${shownAt(seq)}`, 'PATCH', { content: text });
        _editing = null;
        await openSession(_sessionId, { keepScroll: true });
        followOwed();
    } catch (e) {
        // a refused edit keeps its typing; leaving the editor reads the transcript as it is now
        if (e.status === 404 || e.status === 409) _staleFromFeed = true;
        CoreAPI.showToast(`Could not save the edit: ${e.message}`, 'error');
    }
}

/** Delete ONE turn; distinct from Ask again's truncate, so tidying a stray message keeps the rest. */
async function deleteOne(seq) {
    if (busy() || !ownsSession()) return;
    const preview = String(_messages[seq]?.content || '').slice(0, 140);
    // the turn the confirm shows: the transcript may be re-read while it is open
    const seen = shownAt(seq);
    const ok = await CoreAPI.showConfirm({
        title: 'Delete message',
        message: 'This removes just this message from the assistant conversation.',
        confirmLabel: 'Delete',
        danger: true,
        content: [{ type: 'note', text: preview }],
    });
    if (!ok) return;
    try {
        await api(`/assistant/sessions/${encodeURIComponent(_sessionId)}/messages/${seq}?mode=one&${seen}`, 'DELETE');
        await openSession(_sessionId, { keepScroll: true });
    } catch (e) {
        if (e.status === 404 || e.status === 409) await openSession(_sessionId, { keepScroll: true }).catch(() => { /* the toast below says what failed */ });
        CoreAPI.showToast(`Could not delete: ${e.message}`, 'error');
    }
}

function toggleSettings() {
    // leaving settings saves the prompt box: clicking straight back means keep it
    if (_view === 'settings') {
        const box = document.getElementById('casPrompt');
        if (box) CoreAPI.setSetting('assistantSystemPrompt', box.value.trim());
    }
    _view = _view === 'settings' ? 'chat' : 'settings';
    render();
    // what other tabs wrote while the Settings view held the panel is read now
    if (_view === 'chat') followOwed();
}

/** Fill the box with the built-in prompt, fetched from the server rather than kept as a drifting copy. */
async function loadDefaultPrompt() {
    const box = document.getElementById('casPrompt');
    if (!box) return;
    try {
        if (!_defaultPrompt) _defaultPrompt = (await api('/assistant/defaults')).systemPrompt || '';
        box.value = _defaultPrompt;
        CoreAPI.setSetting('assistantSystemPrompt', _defaultPrompt);
        CoreAPI.showToast('Loaded the built-in prompt; edit it as you like', 'success');
    } catch (e) {
        CoreAPI.showToast(`Could not load the built-in prompt: ${e.message}`, 'error');
    }
}

function clearPrompt() {
    const box = document.getElementById('casPrompt');
    if (box) box.value = '';
    CoreAPI.setSetting('assistantSystemPrompt', '');
    CoreAPI.showToast('Back to the built-in prompt', 'info');
}

async function copyReply(seq) {
    const copied = await CoreAPI.copyTextToClipboard(_messages[seq]?.content || '');
    CoreAPI.showToast(copied ? 'Copied' : 'Could not copy', copied ? 'success' : 'error');
}

/** Point at another chat: sessions belong to ONE chat, so everything on screen is dropped. */
function setSubject(detail) {
    // a stream still running belongs to the chat being left: abort it, the run's session guard drops the rest
    _abort?.abort();
    _chatId = detail?.chatId || null;
    _char = detail?.char || null;
    _pick = null;
    renderGalleryPick();
    _tray.clear();
    _sessionId = null;
    _sessions = [];
    _messages = [];
    _proposals.clear();
    _openDiffs.clear();
    _rejected.clear();
    _openEdits.clear();
    _edits.clear();
    _redirects.clear();
    _namedBooks.clear();
    _context = null;
    _editing = null;
    // the persona is the left chat's (it would expand {{user}} wrongly); the prompts are per USER and stay
    _personaName = null;
    _personaPronouns = null;
    if (!open) return;
    render();
    if (_chatId) {
        // the honest failure state: an empty state over a failed load hides that every send no-ops (ownsSession)
        loadSessions().catch((e) => {
            const body = document.getElementById('casBody');
            if (body) {
                body.innerHTML = `<div class="cas-empty"><i class="fa-solid fa-triangle-exclamation"></i>
                    <p>Could not load the assistant.</p><p class="cas-dim">${esc(e.message)}</p></div>`;
            }
        });
        void refreshContext();
        void syncPromptPersona();
    }
}

// a character renamed elsewhere: the event names which, never what to, so re-read it from the cache
function followCharacter(detail) {
    if (!_char || detail?.charId !== _char.id) return;
    const fresh = CoreAPI.getCharacterById(_char.id);
    if (fresh) _char = fresh;
}

function init() {
    // The conversation moved to another chat, or left one. Listening rather than being
    // called keeps this right for every route into a conversation.
    document.addEventListener('cl-chat-changed', (e) => setSubject(e.detail?.chatId ? e.detail : null));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) _livePainter?.flush(); });
    registerFeedPatcher('assistantSession', patchSessionsFromFeed);
    followPictureRemovals(_tray);
    followConnectionWrites(followConnections);
}

export { openPanel, closePanel, togglePanel, isBusy };
export default { init, openPanel, closePanel, togglePanel, isBusy };
