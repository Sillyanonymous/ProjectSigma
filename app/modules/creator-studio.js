// The creator studio: one conversation about the WHOLE card. The server judges and applies; this owns surface + review state.

import CoreAPI from './core-api.js';
import { CHAT_PURIFY_CONFIG } from './providers/provider-utils.js';
import { cardValuesEqual } from './card-fields.js';
import { syncRangeFill, syncFieldAvailability } from './chats/window.js';
import { propKey, stripBlocks, createPromptStore, promptChipsHtml, promptsEditorHtml, settingSelectHtml, paintPanelStatus, LIVE_FORMATTING_FIELD, paintPanelReply, closePanelStream, carryPanelReply, scrollPin, redrawTranscript, readerState, restoreReaderState, markKnownEmpty, createReviewState, createPressGuard, fieldProposalCardHtml, fieldCardLabel, canRetry, retryAskText, fieldEditKey, reviewFailedHtml, reviewNudgeHtml, reviewBlockHtml, syncReviewChrome, repaintReviewCard, createLivePainter, createPictureTray, picturesHtml, openPictures, connectionSight, wirePanelComposer, followConnectionWrites } from './ai-panel.js';

const esc = (s) => CoreAPI.escapeHtml(s);
const nf = (n) => Number(n || 0).toLocaleString();

// what the creator form hands over at mount: read/write the draft, the import source, the header button
let deps = null;
let injected = false;
let open = false;

let _sessionId = null;
let _sessions = [];
let _messages = [];
let _busy = false;
let _openStream = null;         // the reply whose stream is still open: { painting }, decided when it was sent
let _posting = false;           // the author's turn on its way to the session its reply will be asked in
let _abort = null;
let _livePainter = null;        // the running reply's painter, so the panel reopening lands what streamed meanwhile
let _subjectGen = 0;            // bumped by a subject reset, so a session minted for the old draft is not adopted
const busy = () => _busy || _posting;
let _view = 'chat';
let _context = null;            // the server's summary of the draft, null until read
let _fields = [];               // [{key, label}] from the server: the field vocabulary is its
let _defaultPrompt = '';
let _scope = null;              // Set of field keys, or null for the whole card
let _selection = null;          // { field, text }, rides the next ask only
let _editing = null;
let _rereadOnCancel = false;    // an edit was refused over a changed transcript; Cancel reads it again
let aiConn = null;             // the canonical connection block, mounted in the settings view
let _sees = null;               // its sight: only true offers attaching
// pictures for the next turn, stored with the session (a reference, or the draft's portrait)
const _tray = createPictureTray({ strip: () => document.getElementById('ccsPics'), removeTitle: 'Not with this message' });
let _lastFailure = null;        // { seq, message }: the turn that got no reply, shown until the next send
let _fitInput = () => {};

// The reviewer state both AI panels keep, from the shared surface (keyed by seq + id,
// since ids restart every reply).
const review = createReviewState();
const { openDiffs: _openDiffs, rejected: _rejected, openEdits: _openEdits, edits: _edits } = review;
let _proposals = new Map();

const STATUS_TEXT = {
    ready: 'Ready to apply',
    applied: 'Applied',
    superseded: 'Already handled by an applied change',
    gone: 'That greeting no longer exists',
    ambiguous: 'Cannot be placed as written',
    invalid: 'Malformed proposal',
    failed: 'The apply failed',
};

const fieldLabel = (key) => _fields.find(f => f.key === key)?.label || key;

// ========================================
// MARKUP
// ========================================

function buildHTML() {
    return `
    <aside class="ccs-panel hidden" id="creatorStudio" aria-label="Studio" aria-hidden="true">
        <div class="cl-cwin-header ccs-header">
            <div class="cl-cwin-title">
                <i class="fa-solid fa-wand-magic-sparkles"></i>
                <span class="cl-cwin-name">Studio</span>
                <span class="cl-cwin-sep">·</span>
                <span class="cl-cwin-meta" id="ccsMeta"></span>
            </div>
            <button type="button" class="cl-cwin-btn" data-cas-act="settings" title="Studio settings" aria-label="Studio settings">
                <i class="fa-solid fa-gear"></i>
            </button>
            <button type="button" class="cl-cwin-btn is-close" data-cas-act="close" title="Close" aria-label="Close">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
        <div class="cas-toolbar cl-cwin-fieldrow" id="ccsTabs"></div>
        <div class="cas-body ccs-body" id="ccsBody"></div>
        <div id="ccsConnHome" hidden></div>
        <div class="cas-composer">
            <div class="cas-status hidden" id="ccsStatus"></div>
            <div class="cas-qp-row hidden" id="ccsQpRow"></div>
            <div class="ccs-scope-row" id="ccsScope"></div>
            <div class="cas-pics cl-pic-tray" id="ccsPics" role="list" aria-label="Pictures for your next message" hidden></div>
            <div class="cl-cwin-input-row cas-input-row has-end-tool">
                <button type="button" class="cas-qp-toggle" id="ccsQpToggle" data-cas-act="toggle-prompts"
                    title="Saved prompts" aria-label="Saved prompts" aria-pressed="false">
                    <i class="fa-solid fa-bookmark"></i>
                </button>
                <textarea id="ccsInput" class="cas-input" rows="1" placeholder="Talk about the character..."
                    autocomplete="off" autocorrect="off" spellcheck="true"></textarea>
                <button type="button" class="cas-attach cl-cwin-tool-end" id="ccsAttach" data-cas-act="attach"
                    title="Show the studio pictures (or paste or drop them here)" aria-label="Attach pictures" aria-haspopup="menu">
                    <i class="fa-solid fa-paperclip"></i>
                </button>
                <input type="file" id="ccsAttachInput" multiple accept="image/*" hidden>
                <button type="button" class="cl-cwin-send cas-send" id="ccsSend" data-cas-act="send" title="Send" aria-label="Send">
                    <i class="fa-solid fa-arrow-up"></i>
                </button>
                <button type="button" class="cl-cwin-send cas-send is-stop hidden" id="ccsStop" data-cas-act="stop" title="Stop" aria-label="Stop">
                    <i class="fa-solid fa-stop"></i>
                </button>
            </div>
        </div>
    </aside>`;
}

function toolbarHtml() {
    const opts = _sessions.map(s => `<option value="${esc(s.id)}"${s.id === _sessionId ? ' selected' : ''}>${esc(s.name)}${s.messageCount ? ` (${s.messageCount})` : ''}</option>`).join('');
    return `
        <select id="ccsSessionSel" class="cl-select-fluid" aria-label="Session" title="Session">
            <option value=""${_sessionId ? '' : ' selected'}>New Conversation</option>
            ${opts}
        </select>
        <button type="button" class="cas-tab-add" data-cas-act="new-session" title="New conversation" aria-label="New conversation">
            <i class="fa-solid fa-plus"></i>
        </button>
        <button type="button" class="cas-tab-add" data-cas-act="rename-session" title="Rename this conversation" aria-label="Rename this conversation">
            <i class="fa-solid fa-i-cursor"></i>
        </button>
        <button type="button" class="cas-tab-add is-danger" data-cas-act="delete-session" title="Delete this conversation" aria-label="Delete this conversation">
            <i class="fa-solid fa-trash"></i>
        </button>
        <button type="button" class="cas-tab-menu${_view === 'context' ? ' is-on' : ''}" data-cas-act="context-view"
            title="What it can see: the draft, the reference cards, the request size" aria-label="Context">
            <i class="fa-solid fa-layer-group"></i>
        </button>`;
}

// one summary chip for what the next ask is steered at (fields are picked elsewhere); scope never gates a proposal
function scopeRowHtml() {
    if (!_fields.length) return '';
    const names = _scope ? _fields.filter(f => _scope.has(f.key)).map(f => f.label) : [];
    const scope = _scope
        ? `<span class="ccs-sel-chip ccs-scope-chip" title="The next ask is about ${esc(names.join(', '))}. The wand beside a form field, or a row of the draft in the context view, adds or removes a field"><i class="fa-solid fa-wand-magic-sparkles"></i> Working on ${esc(names.join(', '))}
             <button type="button" data-cas-act="scope" data-field="" title="Back to the whole card" aria-label="Back to the whole card"><i class="fa-solid fa-xmark"></i></button></span>`
        : `<button type="button" class="ccs-chip is-on" data-cas-act="context-view" title="The whole card is in play. The wand beside a form field, or a row of the draft in the context view, narrows the ask to a field"><i class="fa-solid fa-id-card"></i> Whole Card</button>`;
    const sel = _selection
        ? `<span class="ccs-sel-chip" title="${esc(_selection.text.slice(0, 200))}"><i class="fa-solid fa-highlighter"></i> Revising a passage in ${esc(fieldLabel(_selection.field))}
             <button type="button" data-cas-act="clear-selection" title="Forget the selection" aria-label="Forget the selection"><i class="fa-solid fa-xmark"></i></button></span>`
        : '';
    // the reference cards live in the context view; this chip finds them and says whether any ride the next ask
    const poolName = _poolPlaylistUid ? (_playlists.find(p => p.uid === _poolPlaylistUid)?.name || 'a playlist') : '';
    const pool = `<button type="button" class="ccs-chip ccs-pool-chip${_references ? ' is-on' : ''}" data-cas-act="context-view"
        title="${_references ? `Reference cards from ${esc(poolName)} ride each message; open the context view to change them` : 'Pick a playlist of your own characters as reference cards for the partner'}">
        <i class="fa-solid fa-layer-group"></i> ${_references ? `References: ${esc(poolName)}` : 'Add reference cards'}</button>`;
    return scope + sel + pool;
}

function renderScopeRow() {
    const row = document.getElementById('ccsScope');
    if (row) row.innerHTML = scopeRowHtml();
}

// ========================================
// CONTEXT VIEW
// ========================================

/** What the partner sees, as the server assembled it over the form's draft now (never the panel's own idea of it). */
function contextViewHtml() {
    if (!_context) return '<div class="cl-cwin-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><p>Reading the draft</p></div>';
    const fields = Array.isArray(_context.fields) ? _context.fields : null;
    const empty = Array.isArray(_context.empty) ? _context.empty : [];
    const tok = _context.budget?.tokens;
    const draftBody = fields === null
        ? `<p class="cl-cwin-group-note">This server has not said what it sends of the draft. Reload the page;
            if it stays, the server is running an older build than this panel.</p>`
        : `
            <div class="cl-cwin-fields">
                <div class="cas-book-entries">
                    ${fields.map(f => `
                        <button type="button" class="cl-cwin-row cas-entry is-open ccs-draft-row${_scope?.has(f.key) ? ' is-scoped' : ''}" data-cas-act="scope" data-field="${esc(f.key)}" title="Sent in full. Click to work on this field">
                            <i class="fa-solid fa-circle-dot"></i>
                            <span class="cas-entry-title">${esc(f.label)}</span>
                            <span class="cas-entry-size">${nf(f.chars)}</span>
                            <i class="fa-solid fa-wand-magic-sparkles ccs-draft-wand"></i>
                        </button>`).join('')}
                    ${empty.map(k => `
                        <button type="button" class="cl-cwin-row cas-entry is-off ccs-draft-row${_scope?.has(k) ? ' is-scoped' : ''}" data-cas-act="scope" data-field="${esc(k)}" title="Empty: a field the partner can write. Click to work on it">
                            <i class="fa-solid fa-circle"></i>
                            <span class="cas-entry-title">${esc(fieldLabel(k))}</span>
                            <span class="cas-entry-tag">empty</span>
                            <i class="fa-solid fa-wand-magic-sparkles ccs-draft-wand"></i>
                        </button>`).join('')}
                    <div class="cl-cwin-row cas-entry${_context.tags ? ' is-open' : ' is-off'}">
                        <i class="fa-solid ${_context.tags ? 'fa-circle-dot' : 'fa-circle'}"></i>
                        <span class="cas-entry-title">Tags</span>
                        <span class="cas-entry-size">${nf(_context.tags)}</span>
                    </div>
                    <div class="cl-cwin-row cas-entry${_context.greetings ? ' is-open' : ' is-off'}">
                        <i class="fa-solid ${_context.greetings ? 'fa-circle-dot' : 'fa-circle'}"></i>
                        <span class="cas-entry-title">Alternate greetings</span>
                        <span class="cas-entry-size">${nf(_context.greetings)}</span>
                    </div>
                </div>
            </div>
            <p class="cl-cwin-hint">The whole draft goes with every message, exactly as the form holds it. An empty field is
                one the partner can write for you. Click a field to steer the next ask at it; the wand beside
                a form field does the same.</p>
            ${_context.budget?.overBudget ? `
            <p class="cl-cwin-hint cas-over">The next request (about ${nf(tok)} tokens) is over the context limit you set
                (${nf(_context.budget.maxContext)} tokens${_context.budget.reserve ? `, ${nf(_context.budget.reserve)} of it held back for the reply` : ''}),
                and there is nothing left to trim: the draft is never dropped to make room, only this
                conversation is. Raise the limit in the studio settings, or start a new conversation.</p>` : ''}`;
    return `
    <div class="cas-settings">
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-id-card"></i>The draft</h4>
            ${draftBody}
        </section>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-layer-group"></i>Reference cards</h4>
            <div class="cl-cwin-fields">
                <div class="cl-cwin-block">
                    <div class="cl-cwin-field">
                        <label class="cl-cwin-field-label" for="ccsPoolPlaylist">Playlist</label>
                        <select id="ccsPoolPlaylist" class="cl-select-fluid cl-cwin-field-control" title="Which of your playlists to draw from">
                            <option value="">None</option>
                            ${_playlists.map(p => `<option value="${esc(p.uid)}"${p.uid === _poolPlaylistUid ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
                        </select>
                    </div>
                    <p class="cl-cwin-hint">Your own characters as inspiration: the partner reads them for tone, world and texture and
                        never copies them.${_poolStatus ? ` ${esc(_poolStatus)}` : ''}</p>
                </div>
                ${_poolPlaylistUid ? `
                <div class="cl-cwin-block">
                    ${POOL_FIELDS.map(([key, label, heavy]) => `
                    <label class="cl-cwin-field cl-cwin-toggle ccs-pool-row">
                        <span class="cl-cwin-field-label">${esc(label)}${heavy ? '<small>full card</small>' : ''}</span>
                        <input type="checkbox" class="cl-switch-input" data-pool-field="${key}"${poolFields().has(key) ? ' checked' : ''}>
                        <span class="cl-switch" aria-hidden="true"></span>
                    </label>`).join('')}
                    <p class="cl-cwin-hint">What the partner reads from each card. A field marked full card loads every card whole
                        instead of reading the listing.</p>
                </div>
                <div class="cl-cwin-block">
                    <div class="cl-cwin-field">
                        <label class="cl-cwin-field-label" for="ccsPoolMax">Budget (tokens)</label>
                        <input type="number" id="ccsPoolMax" class="cl-cwin-input cl-cwin-field-control" min="200" max="200000" step="100" value="${poolMaxTokens()}">
                    </div>
                    <p class="cl-cwin-hint">${_references ? `About ${nf(approxTokens(_references))} tokens of references ride each message.` : 'Nothing built yet.'}</p>
                </div>` : ''}
            </div>
        </section>
    </div>`;
}

// ========================================
// THE INSPIRATION POOL (reference cards)
// ========================================

// heavy = a HEAVY_FIELD, so the card must be hydrated before it is read
const POOL_FIELDS = [
    ['tags', 'Tags', false],
    ['creator_notes', 'Creator notes', true],
    ['tagline', 'Tagline', false],
    ['description', 'Description', true],
    ['personality', 'Personality', true],
    ['scenario', 'Scenario', true],
    ['first_mes', 'First message', true],
    ['mes_example', 'Example dialogue', true],
];
const POOL_HEAVY = new Set(POOL_FIELDS.filter(f => f[2]).map(f => f[0]));
const POOL_DEFAULT_FIELDS = ['tags', 'creator_notes', 'description'];
const POOL_MAX_TOKENS_DEFAULT = 2500;
const POOL_PER_CARD_CHARS = 1400;
const POOL_HYDRATE_CHUNK = 12;

let _playlists = [];
let _poolPlaylistUid = '';
let _poolFields = null;
let _poolStatus = '';
let _references = '';
let _poolAbort = null;

function poolFields() {
    if (_poolFields) return _poolFields;
    const valid = new Set(POOL_FIELDS.map(f => f[0]));
    const saved = CoreAPI.getSetting('ccpool_fields');
    _poolFields = new Set((Array.isArray(saved) ? saved : POOL_DEFAULT_FIELDS).filter(k => valid.has(k)));
    return _poolFields;
}

function poolMaxTokens() {
    const v = parseInt(CoreAPI.getSetting('ccpool_maxInputTokens'), 10);
    return Number.isFinite(v) && v >= 200 ? v : POOL_MAX_TOKENS_DEFAULT;
}

const approxTokens = (str) => Math.ceil((str || '').length / 4);

function cleanPoolText(raw) {
    if (!raw) return '';
    const html = raw.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    let text = html;
    try { text = new DOMParser().parseFromString(html, 'text/html').body.textContent || html; } catch { /* keep the raw text */ }
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    text = text.replace(/https?:\/\/\S+/g, '');
    return text.replace(/\s+/g, ' ').trim();
}

function poolCardBlock(char, fields) {
    if (!char) return '';
    const d = char.data || char;
    const parts = [`## ${char.name || char.id}`];
    if (fields.has('tags')) {
        const tags = CoreAPI.getCharacterTags(char) || [];
        if (tags.length) parts.push(`Tags: ${tags.join(', ')}`);
    }
    const pushText = (key, label, v) => {
        if (!fields.has(key)) return;
        const t = cleanPoolText((v || '').toString()).slice(0, POOL_PER_CARD_CHARS);
        if (t) parts.push(`${label}: ${t}`);
    };
    pushText('creator_notes', 'Creator notes', char.creator_notes || d.creator_notes);
    if (fields.has('tagline')) {
        let tl = '';
        try { tl = cleanPoolText(CoreAPI.getDisplayTagline(char) || '').slice(0, 400); } catch { /* no tagline */ }
        if (tl) parts.push(`Tagline: ${tl}`);
    }
    pushText('description', 'Description', d.description);
    pushText('personality', 'Personality', d.personality);
    pushText('scenario', 'Scenario', d.scenario);
    pushText('first_mes', 'First message', d.first_mes);
    pushText('mes_example', 'Example dialogue', d.mes_example);
    return parts.length < 2 ? '' : parts.join('\n');
}

async function loadPlaylists() {
    try { await CoreAPI.playlistsLoadPlaylists(); } catch { /* the select shows what is known */ }
    _playlists = CoreAPI.playlistsGetAll() || [];
}

// Rebuilt on a playlist, field or budget change, never per turn: the block is cached and
// rides every generate as the references.
async function rebuildReferences() {
    _poolAbort?.abort();
    // in place before the first await, so the next rebuild aborts this one whichever read is out
    const ctl = new AbortController();
    _poolAbort = ctl;
    const signal = ctl.signal;
    const uid = _poolPlaylistUid;
    const fields = poolFields();
    try {
        if (!uid || !fields.size) { _references = ''; _poolStatus = ''; return; }
        let chars = [];
        try { await CoreAPI.playlistsLoadPlaylists(); chars = (await CoreAPI.playlistsGetCharacters(uid)) || []; } catch { /* empty */ }
        if (signal.aborted) return;
        if (!chars.length) { _references = ''; _poolStatus = 'The playlist is empty.'; return; }
        const heavy = [...fields].some(k => POOL_HEAVY.has(k));
        const max = poolMaxTokens();
        const blocks = [];
        let used = 0;
        let fit = 0;
        let full = false;
        // a chunk at a time, stopping once the budget is full: a big playlist reads only the cards that fit
        for (let at = 0; at < chars.length && !full; at += POOL_HYDRATE_CHUNK) {
            const chunk = chars.slice(at, at + POOL_HYDRATE_CHUNK);
            if (heavy) {
                _poolStatus = `Loading ${Math.min(at + POOL_HYDRATE_CHUNK, chars.length)} of ${chars.length}.`;
                await CoreAPI.hydrateMany(chunk, { chunk: POOL_HYDRATE_CHUNK, signal });
                if (signal.aborted) return;
            }
            for (const char of chunk) {
                const block = poolCardBlock(char, fields);
                if (!block) continue;
                const t = approxTokens(block);
                if (fit > 0 && used + t > max) { full = true; break; }
                blocks.push(block); used += t; fit++;
                if (used >= max) { full = true; break; }
            }
        }
        if (signal.aborted) return;
        _references = blocks.join('\n\n');
        _poolStatus = fit < chars.length ? `${fit} of ${chars.length} cards fit the budget.` : `${fit} card${fit === 1 ? '' : 's'}.`;
    } catch (err) {
        if (signal.aborted) return;
        console.warn('[Studio] the reference cards did not load:', err?.message || err);
        _references = ''; _poolStatus = 'The reference cards could not be loaded.';
    } finally {
        if (_poolAbort === ctl) _poolAbort = null;
    }
}

// ========================================
// RENDERING
// ========================================

function renderText(text, opts = {}) {
    // a card under construction has no reader yet: {{user}} stays a placeholder, never the global persona's name
    return CoreAPI.safePurify(CoreAPI.formatChatText(String(text ?? ''), deps?.readDraft?.().name || '', { ...opts, userName: '{{user}}' }), CHAT_PURIFY_CONFIG);
}

/** One change's review card, the shared field card over the studio's labels. */
function proposalCardHtml(p, { seq } = {}) {
    return fieldProposalCardHtml(p, {
        pk: propKey(seq, p.id), review, statusText: STATUS_TEXT[p.status || 'ready'] || p.status,
        labelOf: fieldLabel, applyTitle: 'Apply this change to the form now',
    });
}

const liveProposals = (seq) => (_proposals.get(seq)?.proposals || [])
    .filter(p => (p.status || 'ready') === 'ready' && !_rejected.has(propKey(seq, p.id)));
// the cards a Try again answers: refused as written and not set aside (the card engine is always on here)
const retryableProposals = (seq) => (_proposals.get(seq)?.proposals || []).filter(p => canRetry(p, _rejected.has(propKey(seq, p.id))));

function proposalsHtml(seq) {
    const state = _proposals.get(seq);
    if (!state) return '';
    if (state.failed) return reviewFailedHtml(seq);
    const { proposals, errors } = state;
    if (!proposals.length && !errors.length) {
        return seq === _messages.length - 1
            ? reviewNudgeHtml(seq, 'Turn this into changes I can apply')
            : '';
    }
    return reviewBlockHtml({
        seq, icon: 'fa-id-card', live: liveProposals(seq).length, errors,
        canFix: seq === _messages.length - 1,
        units: proposals.map(p => proposalCardHtml(p, { seq })).join(''), retryable: retryableProposals(seq).length,
    });
}

const syncPropsChrome = (seq) => syncReviewChrome(seq, liveProposals(seq).length, { scope: '#ccsBody ' });

const shortTime = (ms) => {
    try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return ''; }
};

function messageHtml(m, seq) {
    const mine = m.role === 'user';
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
    <div class="cas-msg ${mine ? 'is-user' : 'is-assistant'}" data-seq="${seq}"${m.at ? ` data-at="${esc(String(m.at))}"` : ''}>
        <div class="cas-msg-head">
            <span class="cas-msg-who">
                <i class="fa-solid ${mine ? 'fa-user' : 'fa-wand-magic-sparkles'}"></i>${mine ? 'You' : 'Studio'}
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

// Openers, not decoration: brainstorm's onboarding, reshaped as the panel's empty state.
function starters() {
    const name = deps?.readDraft?.().name?.trim() || 'this character';
    return [
        ['fa-lightbulb', `I have a rough idea for ${name}. Help me flesh it out.`],
        ['fa-heart-pulse', `What would make ${name} feel like a real person?`],
        ['fa-pen-nib', 'Draft the card from what we have so far.'],
        ['fa-tags', `Suggest tags for ${name}.`],
    ];
}

function emptyHtml() {
    return `
    <div class="cas-empty">
        <div class="cas-empty-mark"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
        <p class="cas-empty-lead">Your design partner for this card.</p>
        <p class="cas-dim">It reads the whole draft as you write it and proposes text for any field, the tags and the
            greetings. Every change is a card you review and apply; nothing lands on its own.</p>
        <div class="cas-starters">
            ${starters().map(([icon, text]) => `
                <button type="button" class="cas-starter" data-cas-act="starter" data-text="${esc(text)}">
                    <i class="fa-solid ${icon}"></i><span>${esc(text)}</span>
                </button>`).join('')}
        </div>
    </div>`;
}

// ========================================
// SAVED PROMPTS
// ========================================

const prompts = createPromptStore({
    key: 'creator-studio-prompts',
    starters: [
        { icon: '📝', label: 'Draft the card', text: 'Draft every field that is still empty from what we have discussed, as one batch of changes I can review.' },
        { icon: '🏷️', label: 'Suggest tags', text: 'Suggest ten to fifteen tags for {{char}} as a tags change: lowercase, specific, none of the ones already set.' },
        { icon: '👋', label: 'Three greetings', text: 'Write three alternate greetings for {{char}} as greeting changes, each opening the story from a different situation.' },
    ],
});

function expandPromptMacros(text) {
    const name = deps?.readDraft?.().name?.trim();
    return String(text ?? '').replace(/\{\{char\}\}/gi, name || 'this character');
}

function renderPromptChips() {
    const row = document.getElementById('ccsQpRow');
    const btn = document.getElementById('ccsQpToggle');
    if (!row) return;
    const on = CoreAPI.getSetting('creatorStudioPromptsOpen') === true;
    const list = prompts.get();
    row.innerHTML = promptChipsHtml(list);
    row.classList.toggle('hidden', !on || !list?.length);
    btn?.classList.toggle('is-on', on);
    btn?.setAttribute('aria-pressed', String(on));
}

function togglePromptChips() {
    const next = CoreAPI.getSetting('creatorStudioPromptsOpen') !== true;
    CoreAPI.setSetting('creatorStudioPromptsOpen', next);
    renderPromptChips();
    if (next && !prompts.get()?.length) CoreAPI.showToast('No saved prompts yet: add them in the studio settings', 'info');
}

function usePrompt(id) {
    const p = prompts.find(id);
    const input = document.getElementById('ccsInput');
    if (!p || !input) return;
    input.value = expandPromptMacros(p.text);
    input.dispatchEvent(new Event('input'));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
}

// ========================================
// SETTINGS VIEW
// ========================================

function settingsHtml() {
    const custom = String(CoreAPI.getSetting('creatorStudioSystemPrompt') || '');
    const maxCtx = CoreAPI.getSetting('creatorStudioMaxContext') ?? 0;
    return `
    <div class="cas-settings">
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-plug"></i>Connection</h4>
            <div class="cl-cwin-fields">
                <div class="cl-cwin-block">
                    <div id="ccsAiConn"></div>
                    <p class="cl-cwin-hint">Which connection answers the studio, with its own temperature, reasoning and reply
                        ceiling on top of the profile. Streaming paints the reply as it arrives.</p>
                </div>
            </div>
        </section>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-comment-dots"></i>Replies</h4>
            <div class="cl-cwin-fields">
                ${settingSelectHtml({ id: 'ccsSet_creatorStudioLiveFormatting', key: 'creatorStudioLiveFormatting', ...LIVE_FORMATTING_FIELD, value: String(CoreAPI.getSetting('creatorStudioLiveFormatting') || 'chat') })}
            </div>
        </section>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-feather-pointed"></i>Prompt</h4>
            <div class="cl-cwin-fields">
                <div class="cl-cwin-block">
                    <label class="cl-cwin-label" for="ccsPrompt">Studio prompt</label>
                    <textarea id="ccsPrompt" class="cl-cwin-input cl-cwin-textarea cas-set-prompt" rows="10"
                        placeholder="Leave blank to use the built-in prompt.">\n${esc(custom)}</textarea>
                    <div class="cas-set-actions">
                        <button type="button" class="cas-set-btn" data-cas-act="load-default">
                            <i class="fa-solid fa-file-import"></i> Load the Built-In Prompt
                        </button>
                        <button type="button" class="cas-set-btn" data-cas-act="clear-prompt">
                            <i class="fa-solid fa-rotate-left"></i> Back to Built-In
                        </button>
                    </div>
                    <p class="cl-cwin-hint">This replaces the description of what the partner is, and only that. The craft notes
                        for each field, the rule that keeps draft text quoted rather than obeyed, and the instructions for
                        proposing changes are always added after it.</p>
                </div>
            </div>
        </section>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-bookmark"></i>Saved prompts</h4>
            <div class="cl-cwin-fields">
                ${promptsEditorHtml(prompts.get(), { hint: 'Chips above the message box, behind the bookmark button. Clicking one fills the box so you can edit before sending; it never sends by itself. <strong>{{char}}</strong> is filled in with the draft\'s name as you insert.' })}
            </div>
        </section>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-layer-group"></i>Context</h4>
            <div class="cl-cwin-fields">
                <div class="cl-cwin-block">
                    <div class="cl-cwin-field">
                        <label class="cl-cwin-field-label" for="ccsSet_creatorStudioMaxContext">Context budget (tokens)</label>
                        <input type="number" id="ccsSet_creatorStudioMaxContext" class="cl-cwin-input cl-cwin-field-control" data-set="creatorStudioMaxContext"
                            min="0" step="256" placeholder="0 = no limit" value="${esc(maxCtx || '')}">
                    </div>
                    <p class="cl-cwin-hint">Only this conversation is trimmed to fit. The draft and the reference cards are never cut down.</p>
                </div>
            </div>
        </section>
        <div class="cas-set-foot">Changes apply to the next message you send.</div>
    </div>`;
}

// mounted ONCE at open into a hidden home, so the picked profile answers the first send; settings borrows it
let _connMounting = null;
async function mountConnection() {
    if (aiConn) return aiConn;
    if (_connMounting) return _connMounting;
    const home = document.getElementById('ccsConnHome');
    if (!home) return null;
    _connMounting = CoreAPI.mountAiConnectionBlock(home, { surface: 'creator', onChange: () => void syncSight(), onStreamingChange: syncLiveFormattingRow })
        .then((block) => { aiConn = block; _connMounting = null; placeConnection(); void syncSight(); return block; });
    return _connMounting;
}

function placeConnection() {
    const home = document.getElementById('ccsConnHome');
    const seat = document.getElementById('ccsAiConn');
    const block = home?.firstElementChild || seat?.firstElementChild;
    if (!block) return;
    if (_view === 'settings' && seat) { if (block.parentElement !== seat) seat.appendChild(block); }
    else if (home && block.parentElement !== home) home.appendChild(block);
}

// the settings seat lives in the body, so the block goes home before any rewrite or it leaves with the old seat
function paintBody(body, html) {
    const block = document.getElementById('ccsAiConn')?.firstElementChild;
    if (block) document.getElementById('ccsConnHome')?.appendChild(block);
    body.innerHTML = html;
}

// whether a reply is painted as it arrives here: what the stream reads, and what Format as it streams waits on
const studioStreams = () => CoreAPI.aiConnectionStreams('creator');

function syncLiveFormattingRow() {
    syncFieldAvailability(document.getElementById('ccsSet_creatorStudioLiveFormatting'), {
        on: studioStreams(), hint: LIVE_FORMATTING_FIELD.hint, reason: 'Only applies while Stream the reply is on, under Overrides above.',
    });
}

function onSettingInput(el) {
    const key = el.dataset.set;
    if (key === 'creatorStudioLiveFormatting') { CoreAPI.setSetting(key, el.value); return; }
    if (key !== 'creatorStudioMaxContext') return;
    const n = parseInt(el.value, 10);
    // clamp AND reflect: the box shows what was stored, never a typed value the store rewrote
    const v = Number.isFinite(n) && n > 0 ? n : 0;
    el.value = v || '';
    CoreAPI.setSetting(key, v);
}

// ========================================
// RENDER
// ========================================

// the line under the transcript: the messages so far and the next send's size
function paintStatus() {
    paintPanelStatus(document.getElementById('ccsStatus'), _messages.length, _context?.budget?.tokens);
}

function render() {
    const body = document.getElementById('ccsBody');
    if (!body) return;
    // the transcript's place, kept for a reader who scrolled away from its end; another view redrawn returns to the end
    const kept = body.querySelector('.cas-msg') ? scrollPin('ccsBody').place() : null;
    const meta = document.getElementById('ccsMeta');
    if (meta) meta.textContent = _view === 'settings' ? 'Settings' : (_view === 'context' ? 'Context' : '');
    const panel = document.getElementById('creatorStudio');
    panel?.classList.toggle('cas-in-settings', _view === 'settings');
    panel?.classList.toggle('cas-in-context', _view === 'context');

    const bar = document.getElementById('ccsTabs');
    if (bar) {
        bar.innerHTML = _view === 'settings' ? '' : toolbarHtml();
        bar.classList.toggle('hidden', _view === 'settings');
        const sel = document.getElementById('ccsSessionSel');
        if (sel) CoreAPI.initCustomSelect(sel);
    }

    paintStatus();
    renderScopeRow();

    // the connection block moves into the settings view's seat and back to its home
    if (_view === 'settings') {
        paintBody(body, settingsHtml());
        placeConnection();
        // by id: the seated connection block keeps its own plain selects
        const live = document.getElementById('ccsSet_creatorStudioLiveFormatting');
        if (live) CoreAPI.initCustomSelect(live);
        syncLiveFormattingRow();
        return;
    }
    if (_view === 'context') {
        paintBody(body, contextViewHtml());
        syncRangeFill(body);
        body.querySelectorAll('select').forEach(s => CoreAPI.initCustomSelect(s));
        return;
    }
    if (!_messages.length) { paintBody(body, emptyHtml()); return; }
    // the older replies keep what the reader opened: a reader scrolled up through a redraw read on in a box shut under them
    redrawTranscript(body, () => paintBody(body, _messages.map((m, i) => messageHtml(m, i)).join('')));
    if (_lastFailure && !_busy) body.insertAdjacentHTML('beforeend', failedHtml());
    if (_openStream && !document.getElementById('ccsStreaming')) {
        body.insertAdjacentHTML('beforeend', streamingHtml(_openStream.painting));
        _livePainter?.paintNow();
    }
    if (kept == null) scrollPin('ccsBody').pin();
    else scrollPin('ccsBody').follow(kept);
}

// the turn that got no reply stays in the transcript with a resend; a toast is gone before the reader looks up
function failedHtml() {
    return `
        <div class="cas-msg is-assistant is-failed" id="ccsFailed">
            <div class="cas-msg-head">
                <span class="cas-msg-who"><i class="fa-solid fa-triangle-exclamation"></i>No reply</span>
            </div>
            <div class="cas-msg-body">${esc(_lastFailure.message)}</div>
            <button type="button" class="cl-cwin-btn-text is-primary" data-cas-act="retry" data-seq="${_lastFailure.seq}">
                <i class="fa-solid fa-rotate"></i> Resend
            </button>
        </div>`;
}

// After the failed turn's session is reloaded: the last message is the author's turn that
// went unanswered, and the resend asks again from it.
function markFailed(message) {
    const seq = _messages.length - 1;
    if (seq < 0 || _messages[seq]?.role !== 'user') return;
    // drawn by generate's finally, once busy is down: a render here would paint the row
    // and a phantom thinking bubble beside it
    _lastFailure = { seq, message: String(message || 'The studio could not answer.') };
    // the row is the only notice the ask failed, so a reader scrolled up while it thought is taken to it
    scrollPin('ccsBody').pin();
}

function streamingHtml(painting) {
    return `
        <div class="cas-msg is-assistant ${painting ? 'is-streaming' : 'is-pending'}" id="ccsStreaming">
            <div class="cas-msg-head">
                <span class="cas-msg-who"><i class="fa-solid fa-wand-magic-sparkles"></i>Studio</span>
                <span class="cas-msg-time" id="ccsLiveStatus">thinking · 0s</span>
            </div>
            <div class="cas-msg-body">${painting ? '' : '<span class="cas-thinking"><i class="fa-solid fa-circle-notch fa-spin"></i>Thinking</span>'}</div>
        </div>`;
}

// ========================================
// DATA
// ========================================

// a turn's stamp as shown: the server refuses a write whose seq another tab renumbered since
function shownAt(seq) {
    const at = _messages[seq]?.at;
    return Number.isFinite(at) ? `at=${at}` : '';
}

const sourceId = () => deps?.sourceId?.() || null;
const sessionQuery = () => { const id = sourceId(); return id ? `?charId=${encodeURIComponent(id)}` : ''; };

async function loadFields() {
    if (_fields.length) return;
    const d = await CoreAPI.readAnswer(await CoreAPI.apiRequest('/creator/defaults', 'GET'));
    _fields = Array.isArray(d.fields) ? d.fields : [];
    _defaultPrompt = d.systemPrompt || '';
}

async function loadSessions({ pick = null, carry = null } = {}) {
    // a list answered after the author picked another session or the form moved on is late: their screen stands
    const was = _sessionId;
    const gen = _subjectGen;
    const list = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/creator/sessions${sessionQuery()}`, 'GET'));
    if (_sessionId !== was || gen !== _subjectGen) return;
    _sessions = list;
    const wanted = pick || _sessionId;
    const target = _sessions.find(s => s.id === wanted);
    if (target) await openSession(target.id, { keepScroll: !!pick && pick === _sessionId, carry });
    else { _sessionId = null; _tray.clear(); _messages = []; clearReview(); render(); }
}

function clearReview() {
    _proposals.clear();
    review.clear();
}

/** Mint the session on the first turn, never on open: peeking leaves no litter. */
async function ensureSession() {
    if (_sessionId) return _sessionId;
    const draft = deps.readDraft();
    const gen = _subjectGen;
    const created = await CoreAPI.readAnswer(await CoreAPI.apiRequest('/creator/sessions', 'POST', {
        charId: sourceId(),
        name: `${draft.name?.trim() || 'Draft'} · ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`,
        draft,
        profileId: aiConn?.getProfile?.()?.id || null,
    }));
    // the form moved to another draft, or a session arrived meanwhile: this one isnt the screen's
    if (gen !== _subjectGen || _sessionId) return _sessionId;
    _sessionId = created.id;
    _sessions = [created, ..._sessions];
    return created.id;
}

async function openSession(id, { keepScroll = false, carry = null } = {}) {
    // waiting pictures are the session's they were stored in
    if (id !== _sessionId) _tray.clear();
    _sessionId = id;
    _lastFailure = null;
    clearReview();
    let full;
    try {
        full = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/creator/sessions/${encodeURIComponent(id)}`, 'GET'));
    } catch (e) {
        if (_sessionId !== id) return;
        _messages = [];
        render();
        const body = document.getElementById('ccsBody');
        if (body) paintBody(body, `<div class="cas-empty"><i class="fa-solid fa-triangle-exclamation"></i><p>Could not open this conversation.</p><p class="cas-dim">${esc(e.message)}</p></div>`);
        return;
    }
    if (_sessionId !== id) return;
    _messages = full.messages || [];
    if (!keepScroll) {
        // a session opened is an arrival: its end, followed, once it is read; a re-read in place keeps the reader where they are
        scrollPin('ccsBody').pin();
        render();
    }
    const refreshes = [];
    for (let i = 0; i < _messages.length; i++) {
        const m = _messages[i];
        if (m.role !== 'assistant') continue;
        if (m.extra?.proposals?.length) refreshes.push(refreshProposals(i, { patch: false }));
        else markKnownEmpty(_proposals, i, m);
    }
    if (refreshes.length) await Promise.allSettled(refreshes);
    if (_sessionId !== id) return;
    // a re-read in place leaves a Settings or Context view alone; the chat draws it on return
    if (keepScroll && _view !== 'chat') return;
    // read at the render, not the request: the reader scrolls and opens things while the session is read
    const settledBody = () => document.querySelector(`#ccsBody .cas-msg[data-seq="${carry}"] .cas-msg-body`);
    const kept = carry != null ? readerState(settledBody()) : null;
    render();
    // the reply's state goes back before the scroll, or the scroll clamps on a reply redrawn shut
    if (kept) restoreReaderState(settledBody(), kept);
    // the pin's own account, not the body's: a stream's live row, removed before this re-read, clamped the body
    const pin = scrollPin('ccsBody');
    pin.follow(pin.place());
}

/** Pick a stored conversation; its draft is offered back when the form holds something else. */
async function pickSession(id) {
    const s = _sessions.find(x => x.id === id);
    if (!s) return;
    let full;
    try { full = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/creator/sessions/${encodeURIComponent(id)}`, 'GET')); } catch (e) {
        CoreAPI.showToast(`Could not open this conversation: ${e.message}`, 'error');
        return;
    }
    const stored = full.draft && typeof full.draft === 'object' ? full.draft : null;
    if (stored && Object.keys(stored).length) {
        const current = deps.readDraft();
        const differing = draftDifference(current, stored);
        const formEmpty = !Object.values(current).some(v => Array.isArray(v) ? v.length : String(v || '').trim());
        if (differing.length) {
            const names = differing.map(k => (k === 'tags' ? 'Tags' : k === 'alternate_greetings' ? 'Alternate greetings' : fieldLabel(k)));
            const restore = formEmpty ? true : await CoreAPI.showConfirm({
                title: 'Restore this conversation\'s draft?',
                message: `This conversation was about a draft that differs from the form in: ${names.join(', ')}. Put that draft back into the form, or keep what the form holds now and continue the conversation over it.`,
                confirmLabel: 'Restore the draft',
                cancelLabel: 'Keep the form',
            });
            if (restore) { deps.writeDraft(stored); void refreshContext(); }
        }
    }
    await openSession(id);
}

// the fields where two drafts really differ, by cardValuesEqual (tags NOCASE), never byte for byte
function draftDifference(a, b) {
    // an empty greeting box in the form is not a greeting
    const filled = (key, v) => (key === 'alternate_greetings' && Array.isArray(v) ? v.filter(g => String(g ?? '').trim()) : v);
    const out = [];
    for (const key of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
        if (!cardValuesEqual(filled(key, a?.[key]), filled(key, b?.[key]), key)) out.push(key);
    }
    return out;
}

async function refreshProposals(seq, { patch = true } = {}) {
    const sid = _sessionId;
    if (!sid) return;
    try {
        const data = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/creator/sessions/${encodeURIComponent(sid)}/judge`, 'POST', { seq, draft: deps.readDraft() }));
        if (_sessionId !== sid) return;
        _proposals.set(seq, { proposals: data.proposals || [], errors: data.errors || [] });
    } catch (e) {
        console.error('[Studio] Could not read the proposals:', e.message);
        if (_sessionId !== sid) return;
        _proposals.set(seq, { failed: true });
    }
    if (!patch) return;
    const host = document.querySelector(`#ccsBody .cas-msg[data-seq="${seq}"]`);
    const existing = host?.querySelector('.cas-props');
    if (!host) return;
    if (existing) existing.outerHTML = proposalsHtml(seq);
    else host.querySelector('.cas-msg-body')?.insertAdjacentHTML('afterend', proposalsHtml(seq));
}

function findProposal(seq, id) {
    return (_proposals.get(seq)?.proposals || []).find(x => x.id === id) || null;
}


function repaintProp(seq, id, { carryPick = true } = {}) {
    const p = findProposal(seq, id);
    if (!p) return;
    repaintReviewCard(seq, id, () => proposalCardHtml(p, { seq }), { carryPick, scope: '#ccsBody ' });
}

function toggleDiff(seq, id) {
    if (!id) return;
    const pk = propKey(seq, id);
    if (_openDiffs.has(pk)) _openDiffs.delete(pk);
    else _openDiffs.add(pk);
    repaintProp(seq, id);
}

async function refreshContext() {
    if (!deps) return;
    try {
        _context = await CoreAPI.readAnswer(await CoreAPI.apiRequest('/creator/context', 'POST', { draft: deps.readDraft(), references: _references, scope: _scope ? [..._scope] : null }));
    } catch (e) {
        _context = null;
        console.error('[Studio] Could not read the context:', e.message);
    }
    // only the Context view shows it; a Settings view redrawn here lost the prompt's typing and an open sheet's pick
    if (_view === 'context') render();
    else paintStatus();
}

// ========================================
// SENDING
// ========================================

function setBusy(on) {
    _busy = on;
    document.getElementById('ccsSend')?.classList.toggle('hidden', on);
    document.getElementById('ccsStop')?.classList.toggle('hidden', !on);
    const input = document.getElementById('ccsInput');
    if (input) input.disabled = on;
    // the openers say a reply is on its way while the panel is closed
    for (const id of deps?.openers || [deps?.button]) if (id) document.getElementById(id)?.classList.toggle('is-working', on);
}

function refuseWhileBusy() {
    if (!busy()) return false;
    CoreAPI.showToast('Wait for the reply to finish, or stop it first', 'info');
    return true;
}

async function send() {
    const input = document.getElementById('ccsInput');
    const text = String(input?.value || '').trim();
    if ((!text && !_tray.items.length) || busy()) return;
    if (!_sessionId) {
        _posting = true;
        try {
            await ensureSession();
        } catch (e) {
            CoreAPI.showToast(`Could not send: ${e.message}`, 'error');
            return;
        } finally {
            _posting = false;
        }
    }
    await askAndGenerate(text, { fromInput: true, pictures: _tray.items });
}

async function generate(sid = _sessionId) {
    // captured once (or handed in by the asking turn): a switch or a reset mid-run makes the rest a no-op
    if (!sid || _sessionId !== sid) return;
    await CoreAPI.flushSettings();
    if (_sessionId !== sid) return;
    _lastFailure = null;
    void adoptSessionName(sid, deps.readDraft());
    setBusy(true);
    _abort = new AbortController();
    const painting = studioStreams();
    _openStream = { painting };
    const body = document.getElementById('ccsBody');
    body?.insertAdjacentHTML('beforeend', streamingHtml(painting));
    scrollPin('ccsBody').pin();

    const t0 = Date.now();
    const liveTimer = setInterval(() => {
        const el = document.getElementById('ccsLiveStatus');
        if (el) el.textContent = `${acc ? 'writing' : 'thinking'} · ${Math.round((Date.now() - t0) / 1000)}s`;
    }, 500);

    let acc = '';
    let sawDone = false;
    const paint = () => {
        const live = document.querySelector('#ccsStreaming .cas-msg-body');
        if (!live) return;
        paintPanelReply(live, 'creator', (opts) => renderText(stripBlocks(acc), opts));
        // the reader's own scroll toward older text lets go; a finger on the body holds it
        scrollPin('ccsBody').follow();
    };
    // the assistant's cadence, and nothing painted while the studio or the tab is out of sight
    const painter = painting ? createLivePainter({ paint, held: () => !open || document.hidden }) : null;
    _livePainter = painter;

    // the selection rides this ask only; the scope stays until the author changes it
    const selection = _selection;
    _selection = null;
    renderScopeRow();
    try {
        await CoreAPI.streamCreatorGeneration(sid, {
            draft: deps.readDraft(),
            references: _references,
            scope: _scope ? [..._scope] : null,
            selection,
            profileId: aiConn?.getProfile?.()?.id || null,
            params: aiConn?.getParams?.(),
            signal: _abort.signal,
        }, (ev) => {
            if (_sessionId !== sid) return;
            if (typeof ev.text === 'string') {
                acc += ev.text;
                painter?.mark();
            }
            if (ev.done?.message) { sawDone = true; _messages.push(ev.done.message); }
        });
        // closed before the settle's render, or it restores the placeholder for the whole proposal judging
        _openStream = null;
        // the live row goes, and the body clamps: a reader away keeps their place for the redraw
        scrollPin('ccsBody').keep();
        const reader = closePanelStream('ccsStreaming', painter);
        if (_sessionId !== sid) return;
        if (acc && !sawDone) {
            await openSession(sid, { keepScroll: true });
            markFailed('The connection dropped before the reply finished.');
            return;
        }
        const last = _messages.length - 1;
        markKnownEmpty(_proposals, last, _messages[last]);
        // a Settings or Context view the reader is in stays as it is (an open sheet, their typing); the chat draws it on return
        if (_view === 'chat') render();
        carryPanelReply('ccsBody', last, reader);
        if (_messages[last]?.extra?.proposals?.length) await refreshProposals(last);
        void refreshContext();
        // the reread renders the reply afresh, and carries what the reader has done to it by then
        void loadSessions({ pick: sid, carry: last });
    } catch (e) {
        _openStream = null;
        scrollPin('ccsBody').keep();
        document.getElementById('ccsStreaming')?.remove();
        if (_sessionId !== sid) return;
        await openSession(sid, { keepScroll: true });
        if (!e.isCancelled) markFailed(`The studio could not answer: ${e.message}`);
    } finally {
        clearInterval(liveTimer);
        painter?.stop();
        if (_livePainter === painter) _livePainter = null;
        setBusy(false);
        _abort = null;
        if (_lastFailure) render();
    }
}

async function retryFrom(seq) {
    if (busy() || !_sessionId) return;
    const from = _messages[seq]?.role === 'assistant' ? seq : seq + 1;
    const dropping = Math.max(0, _messages.length - from);
    // the turn as the confirm below was asked over
    const seen = shownAt(from);
    if (dropping > 0) {
        const ok = await CoreAPI.showConfirm({
            title: 'Ask again',
            message: dropping === 1 ? 'This drops that reply and asks again.' : `This drops ${dropping} messages from here on, then asks again.`,
            confirmLabel: 'Ask again',
        });
        if (!ok) return;
    }
    // the drop and the reply belong to one session, held from a switch between them
    const sid = _sessionId;
    if (!sid) return;
    try {
        if (dropping > 0) {
            _posting = true;
            try {
                await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/creator/sessions/${encodeURIComponent(sid)}/messages/${from}?${seen}`, 'DELETE'));
                // the form moved to another draft while the drop was out: the session it left is not reopened
                if (_sessionId !== sid) return;
                await openSession(sid);
            } finally {
                _posting = false;
            }
        }
        await generate(sid);
    } catch (e) {
        // the transcript changed under the author: shown as it is now
        if ((e.status === 404 || e.status === 409) && _sessionId === sid) await openSession(sid, { keepScroll: true }).catch(() => { /* the toast below says what failed */ });
        CoreAPI.showToast(`Could not retry: ${e.message}`, 'error');
    }
}

async function nudgeForProposal(seq) {
    if (busy() || !_sessionId) return;
    const ask = 'Put that into a cl-card-edits block so I can apply it. Same text, no rewording, just the block.';
    await askAndGenerate(ask);
}

async function fixBlock(seq) {
    if (busy() || !_sessionId) return;
    const n = _proposals.get(seq)?.errors?.length || 0;
    if (!n) return;
    const s = n > 1 ? 's' : '';
    await askAndGenerate(`That block${s} did not parse and reached nothing. Re-issue the SAME change${s} as one valid block: keep every change flat, close each object before the next, no rewording.`);
}

// a Try again names the reply by its stamp; the server hands the model each change as written and judged now
async function retryProposals(seq, ids) {
    if (busy() || !_sessionId) return;
    const at = _messages[seq]?.at;
    const chosen = retryableProposals(seq).filter(p => !ids || ids.includes(p.id));
    if (!Number.isInteger(at) || !chosen.length) return;
    const ask = retryAskText(chosen.map(p => ({ label: fieldCardLabel(p, fieldLabel), status: STATUS_TEXT[p.status] || p.status })));
    await askAndGenerate(ask, { retry: { at, ids: chosen.map(p => p.id), shown: chosen.map(p => p.change) } });
}

// the turn and its reply belong to the session captured before the POST; _posting holds every busy gate meanwhile
async function askAndGenerate(ask, { fromInput = false, pictures = [], retry = null } = {}) {
    if (busy() || !_sessionId) return;
    const sid = _sessionId;
    let stored;
    _posting = true;
    const shown = pictures.length ? _tray.take() : [];
    try {
        stored = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/creator/sessions/${encodeURIComponent(sid)}/messages`, 'POST', {
            role: 'user', content: ask, ...(shown.length ? { pictures: shown.map(p => ({ kind: p.kind, id: p.id })) } : {}), ...(retry ? { retry } : {}),
        }));
    } catch (e) {
        if (_sessionId === sid) _tray.giveBack(shown);
        // a reply gone or changed since it was shown: the screen reads again, unless that would drop review work in hand
        const held = _editing !== null || _rejected.size || _edits.size || _openEdits.size;
        if (retry && (e.status === 404 || e.status === 409) && _sessionId === sid && !held) await openSession(sid, { keepScroll: true }).catch(() => { /* the toast below says what failed */ });
        CoreAPI.showToast(`Could not ${fromInput ? 'send' : 'ask'}: ${e.message}`, 'error');
        return;
    } finally {
        _posting = false;
    }
    if (_sessionId !== sid) return;
    _messages.push(stored.message);
    if (fromInput) {
        const input = document.getElementById('ccsInput');
        if (input) { input.value = ''; _fitInput(); }
    }
    render();
    await generate(sid);
}

// ========================================
// PICTURES
// ========================================

// the block's connection's sight, as the conversation's paperclip reads it
async function syncSight() {
    const profile = aiConn?.getProfile?.() || null;
    const sees = await connectionSight(profile);
    if ((aiConn?.getProfile?.() || null) !== profile) return;
    _sees = sees;
    const btn = document.getElementById('ccsAttach');
    if (btn) btn.hidden = _sees !== true;
}

// a connection written anywhere reads again while the studio is open: the block's list is a snapshot of its last read
async function followConnections() {
    if (!open || !aiConn) return;
    await aiConn.refresh();
    await syncSight();
}

/** Store pictures with the session (minted on the first one), held for the next turn; a session left mid-upload holds nothing over. */
async function attachFiles(files) {
    if (_sees !== true) return;
    let sid;
    try { sid = await ensureSession(); } catch (e) { CoreAPI.showToast(`Could not attach: ${e.message}`, 'error'); return; }
    if (!sid) return;
    await _tray.addFiles(files, (file, name, raw) => CoreAPI.apiRequest(`/creator/sessions/${encodeURIComponent(sid)}/attachments?name=${name}`, 'POST', file, raw),
        () => _sessionId === sid);
}

// the form's picture as it stands, saved or not, stored with the session like any other
function attachPortrait() {
    const picture = deps?.portrait?.();
    if (!picture) { CoreAPI.showToast('The draft has no picture yet', 'info'); return; }
    const name = `${deps.readDraft().name?.trim() || 'portrait'}.png`;
    void attachFiles([new File([picture], name, { type: picture.type || 'image/png' })]);
}

function openAttachMenu(e) {
    const r = e.target.closest('[data-cas-act]').getBoundingClientRect();
    CoreAPI.getModule('context-menu')?.showItems?.(e, [
        { icon: 'fa-solid fa-upload', label: 'Pictures from this device', action: () => document.getElementById('ccsAttachInput')?.click() },
        { icon: 'fa-solid fa-user', label: "The draft's picture", disabled: !deps?.portrait?.(), action: attachPortrait },
    ], { x: r.left, y: r.top });
}

function useStarter(text) {
    const input = document.getElementById('ccsInput');
    if (!input) return;
    input.value = text;
    input.focus();
    void send();
}

// ========================================
// APPLYING
// ========================================

async function applySelected(seq) {
    if (refuseWhileBusy()) return;
    const host = document.querySelector(`#ccsBody .cas-props[data-seq="${seq}"]`);
    const ids = [...(host?.querySelectorAll('.cas-prop-pick:checked') || [])]
        .map(cb => cb.closest('.cas-prop')?.dataset.propId).filter(Boolean);
    if (!ids.length) { CoreAPI.showToast('Nothing selected', 'info'); return; }
    await runApply(seq, ids);
}

async function applyOne(seq, id) {
    if (!id || refuseWhileBusy()) return;
    await runApply(seq, [id]);
}

/** The apply: the server computes over the form's draft NOW and answers the result; the form takes what moved. */
async function runApply(seq, ids) {
    const overrides = {};
    for (const id of ids) {
        const p = findProposal(seq, id);
        if (p && _edits.has(propKey(seq, id))) overrides[id] = { [fieldEditKey(p)]: _edits.get(propKey(seq, id)) };
    }
    try {
        const out = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/creator/sessions/${encodeURIComponent(_sessionId)}/apply`, 'POST', { seq, ids, draft: deps.readDraft(), ...(Object.keys(overrides).length ? { overrides } : {}) }));
        const applied = out.results.filter(r => r.status === 'applied').length;
        const refused = out.results.length - applied;
        // an applied card's touch-up is spent; kept, it would hold every re-read as work in hand
        for (const r of out.results) if (r.status === 'applied') for (const store of [_edits, _openEdits]) store.delete(propKey(seq, r.id));
        if (applied) {
            const patch = {};
            for (const f of out.touched.fields || []) patch[f] = out.draft[f];
            if (out.touched.tags) patch.tags = out.draft.tags;
            if (out.touched.greetings) patch.alternate_greetings = out.draft.alternate_greetings;
            deps.writeDraft(patch);
            CoreAPI.showToast(`Applied ${applied} change${applied === 1 ? '' : 's'} to the form${refused ? `, refused ${refused}` : ''}`, refused ? 'warning' : 'success');
        } else {
            CoreAPI.showToast('Nothing was applied', 'warning');
        }
        await rejudgeProposals(seq);
        void refreshContext();
    } catch (e) {
        CoreAPI.showToast(`Could not apply: ${e.message}`, 'error');
    }
}

// an apply moves the draft under EVERY block: re-judge each one still live (fully applied is terminal), plus the acted one
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
// SESSIONS
// ========================================

// a Draft session is renamed once by the first send with a name; a typed name stands, a failed rename is cosmetic
async function adoptSessionName(sid, draft) {
    const s = _sessions.find(x => x.id === sid);
    const name = draft?.name?.trim();
    if (!s || !name || !/^Draft · /.test(s.name || '')) return;
    const next = s.name.replace(/^Draft · /, `${name} · `);
    try {
        const updated = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/creator/sessions/${encodeURIComponent(sid)}`, 'PATCH', { name: next }));
        s.name = updated?.name || next;
    } catch { /* the list reloads after the reply */ }
}

async function renameSession() {
    if (refuseWhileBusy()) return;
    if (!_sessionId) { CoreAPI.showToast('Nothing to rename yet: the conversation is created with your first message', 'info'); return; }
    const current = _sessions.find(s => s.id === _sessionId);
    const name = await CoreAPI.showConfirm({
        title: 'Rename conversation',
        confirmLabel: 'Rename',
        input: { value: current?.name || '', placeholder: 'Conversation name' },
    });
    if (typeof name !== 'string' || !name.trim() || name === current?.name) return;
    try {
        await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/creator/sessions/${encodeURIComponent(_sessionId)}`, 'PATCH', { name: name.trim() }));
        await loadSessions({ pick: _sessionId });
    } catch (e) { CoreAPI.showToast(`Could not rename: ${e.message}`, 'error'); }
}

async function deleteSession() {
    if (refuseWhileBusy() || !_sessionId) return;
    const ok = await CoreAPI.showConfirm({
        title: 'Delete conversation',
        message: 'This removes the conversation with the studio. The form is untouched.',
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;
    try {
        await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/creator/sessions/${encodeURIComponent(_sessionId)}`, 'DELETE'));
        // the session's pictures went with it
        _tray.clear();
        _sessionId = null;
        await loadSessions();
    } catch (e) { CoreAPI.showToast(`Could not delete: ${e.message}`, 'error'); }
}

function newSession() {
    if (refuseWhileBusy()) return;
    _tray.clear();
    _sessionId = null;
    _messages = [];
    clearReview();
    render();
}

// ========================================
// EDITING THE TRANSCRIPT
// ========================================

function beginEdit(seq) {
    if (busy()) return;
    _editing = seq;
    render();
    const box = document.querySelector(`#ccsBody .cas-edit-box[data-seq="${seq}"]`);
    if (!box) return;
    const fitOpts = { freeze: box.closest('.cas-msg') };
    CoreAPI.fitTextarea(box, fitOpts);
    box.addEventListener('input', () => CoreAPI.fitTextarea(box, fitOpts));
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
}

function cancelEdit() {
    _editing = null;
    // an edit the server refused was made over a transcript that changed: leaving it reads it again
    if (_rereadOnCancel) {
        _rereadOnCancel = false;
        void openSession(_sessionId, { keepScroll: true });
        return;
    }
    // the redraw keeps the reader's place through the pin, or the end for one who follows
    render();
}

async function saveEdit(seq) {
    if (busy() || !_sessionId) return;
    const box = document.querySelector(`#ccsBody .cas-edit-box[data-seq="${seq}"]`);
    const text = String(box?.value ?? '');
    if (!text.trim()) { CoreAPI.showToast('A message cannot be empty', 'warning'); return; }
    try {
        await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/creator/sessions/${encodeURIComponent(_sessionId)}/messages/${seq}?${shownAt(seq)}`, 'PATCH', { content: text }));
        _editing = null;
        await openSession(_sessionId, { keepScroll: true });
    } catch (e) {
        // a refused edit keeps its typing
        if (e.status === 404 || e.status === 409) _rereadOnCancel = true;
        CoreAPI.showToast(`Could not save the edit: ${e.message}`, 'error');
    }
}

async function deleteOne(seq) {
    if (busy() || !_sessionId) return;
    const seen = shownAt(seq);
    const ok = await CoreAPI.showConfirm({
        title: 'Delete message',
        message: 'This removes just this message from the conversation.',
        confirmLabel: 'Delete',
        danger: true,
        content: [{ type: 'note', text: String(_messages[seq]?.content || '').slice(0, 140) }],
    });
    if (!ok) return;
    try {
        await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/creator/sessions/${encodeURIComponent(_sessionId)}/messages/${seq}?mode=one&${seen}`, 'DELETE'));
        await openSession(_sessionId, { keepScroll: true });
    } catch (e) {
        if (e.status === 404 || e.status === 409) await openSession(_sessionId, { keepScroll: true }).catch(() => { /* the toast below says what failed */ });
        CoreAPI.showToast(`Could not delete: ${e.message}`, 'error');
    }
}

async function copyReply(seq) {
    const copied = await CoreAPI.copyTextToClipboard(_messages[seq]?.content || '');
    CoreAPI.showToast(copied ? 'Copied' : 'Could not copy', copied ? 'success' : 'error');
}

function toggleSettings() {
    if (_view === 'settings') {
        const box = document.getElementById('ccsPrompt');
        if (box) CoreAPI.setSetting('creatorStudioSystemPrompt', box.value.trim());
    }
    _view = _view === 'settings' ? 'chat' : 'settings';
    render();
}

async function loadDefaultPrompt() {
    const box = document.getElementById('ccsPrompt');
    if (!box) return;
    try {
        if (!_defaultPrompt) await loadFields();
        box.value = _defaultPrompt;
        CoreAPI.setSetting('creatorStudioSystemPrompt', _defaultPrompt);
        CoreAPI.showToast('Loaded the built-in prompt; edit it as you like', 'success');
    } catch (e) {
        CoreAPI.showToast(`Could not load the built-in prompt: ${e.message}`, 'error');
    }
}

function clearPrompt() {
    const box = document.getElementById('ccsPrompt');
    if (box) box.value = '';
    CoreAPI.setSetting('creatorStudioSystemPrompt', '');
    CoreAPI.showToast('Back to the built-in prompt', 'info');
}

// ========================================
// LIFECYCLE
// ========================================

function wire(panel) {
    panel.addEventListener('click', (e) => {
        const off = e.target.closest('[data-tray-remove]');
        if (off) return _tray.removeAt(Number(off.dataset.trayRemove));
        const btn = e.target.closest('[data-cas-act]');
        if (!btn) return;
        // read once before any repaint: repaintProp swaps the card via outerHTML, so a later closest() is null
        const seq = Number(btn.closest('.cas-props')?.dataset.seq);
        switch (btn.dataset.casAct) {
            case 'close': return closeStudio();
            case 'send': return void send();
            case 'attach': return openAttachMenu(e);
            case 'picture': return openPictures(_messages[Number(btn.dataset.seq)]?.extra?.pictures, btn.dataset.index, 'Pictures');
            case 'stop': return _abort?.abort();
            case 'new-session': return newSession();
            case 'rename-session': return void renameSession();
            case 'delete-session': return void deleteSession();
            case 'context-view': _view = _view === 'context' ? 'chat' : 'context'; if (_view === 'context') void openContext(); else render(); return undefined;
            case 'settings': return toggleSettings();
            case 'load-default': return void loadDefaultPrompt();
            case 'clear-prompt': return clearPrompt();
            case 'scope': return setScope(btn.dataset.field);
            case 'clear-selection': _selection = null; return renderScopeRow();
            case 'retry-proposals': return void refreshProposals(Number(btn.dataset.seq));
            case 'fix-block': return void fixBlock(Number(btn.dataset.seq));
            case 'retry-one': return void retryProposals(seq, [btn.dataset.propId]);
            case 'retry-all': return void retryProposals(Number(btn.dataset.seq), null);
            case 'apply': return void applySelected(Number(btn.dataset.seq));
            case 'apply-one': return void applyOne(seq, btn.dataset.propId);
            case 'reject-one': _rejected.add(propKey(seq, btn.dataset.propId)); repaintProp(seq, btn.dataset.propId, { carryPick: false }); return syncPropsChrome(seq);
            case 'restore-one': _rejected.delete(propKey(seq, btn.dataset.propId)); repaintProp(seq, btn.dataset.propId, { carryPick: false }); return syncPropsChrome(seq);
            case 'edit-prop': {
                const pk = propKey(seq, btn.dataset.propId);
                if (_openEdits.has(pk)) _openEdits.delete(pk); else _openEdits.add(pk);
                return repaintProp(seq, btn.dataset.propId);
            }
            case 'toggle-diff': return toggleDiff(seq, btn.dataset.propId);
            case 'retry': return void retryFrom(Number(btn.dataset.seq));
            case 'copy': return void copyReply(Number(btn.dataset.seq));
            case 'edit': return beginEdit(Number(btn.dataset.seq));
            case 'edit-cancel': return cancelEdit();
            case 'edit-save': return void saveEdit(Number(btn.dataset.seq));
            case 'delete': return void deleteOne(Number(btn.dataset.seq));
            case 'starter': return useStarter(btn.dataset.text);
            case 'toggle-prompts': return togglePromptChips();
            case 'use-prompt': return usePrompt(btn.dataset.promptId);
            case 'prompt-add': if (prompts.add()) { render(); renderPromptChips(); } return undefined;
            case 'prompt-delete': if (prompts.remove(btn.dataset.promptId)) { render(); renderPromptChips(); } return undefined;
            case 'prompt-up': if (prompts.move(btn.dataset.promptId, -1)) { render(); renderPromptChips(); } return undefined;
            case 'prompt-down': if (prompts.move(btn.dataset.promptId, 1)) { render(); renderPromptChips(); } return undefined;
            case 'retry-prompts': return void prompts.load().then(() => { render(); renderPromptChips(); });
            case 'nudge': return void nudgeForProposal(Number(btn.dataset.seq));
            default: return undefined;
        }
    });

    const afterPress = createPressGuard(panel);
    // delegated, since every view is rebuilt on render
    panel.addEventListener('change', async (e) => {
        const t = e.target;
        if (t.dataset?.poolField) { void togglePoolField(t.dataset.poolField); return; }
        if (t.id === 'ccsSessionSel') {
            if (busy()) { t.value = _sessionId || ''; t._customSelect?.update?.(); refuseWhileBusy(); return; }
            if (!t.value) newSession();
            else if (t.value !== _sessionId) void pickSession(t.value);
            return;
        }
        if (t.id === 'ccsPrompt') { CoreAPI.setSetting('creatorStudioSystemPrompt', t.value.trim()); return; }
        if (t.id === 'ccsPoolPlaylist') {
            _poolPlaylistUid = t.value || '';
            await rebuildReferences();
            render();
            void refreshContext();
            return;
        }
        if (t.id === 'ccsPoolMax') {
            let v = parseInt(t.value, 10);
            if (!Number.isFinite(v) || v < 200) v = POOL_MAX_TOKENS_DEFAULT;
            t.value = v;
            CoreAPI.setSetting('ccpool_maxInputTokens', v);
            await CoreAPI.flushSettings();
            await rebuildReferences();
            render();
            void refreshContext();
            return;
        }
        const set = t.closest('[data-set]');
        if (set) { onSettingInput(set); await CoreAPI.flushSettings(); void refreshContext(); return; }
        const field = t.dataset?.promptField;
        if (field) {
            const id = t.closest('.cas-qp-edit')?.dataset.promptId;
            if (id && prompts.setField(id, field, t.value)) renderPromptChips();
            return;
        }
        const seq = Number(t.closest?.('.cas-props')?.dataset.seq);
        const editId = t.dataset?.propEdit;
        if (editId) {
            const p = findProposal(seq, editId);
            const original = String(p?.change?.[fieldEditKey(p)] ?? '');
            if (t.value === original) _edits.delete(propKey(seq, editId));
            else _edits.set(propKey(seq, editId), t.value);
            afterPress(() => repaintProp(seq, editId));
        }
    });

    const input = document.getElementById('ccsInput');
    _fitInput = wirePanelComposer({ box: input, send, picker: document.getElementById('ccsAttachInput'), drops: [panel], attach: attachFiles, blocked: () => _sees !== true });
}

function setScope(field) {
    if (!field) _scope = null;
    else {
        const next = new Set(_scope || []);
        if (next.has(field)) next.delete(field); else next.add(field);
        _scope = next.size ? next : null;
    }
    // the context view's draft rows show the scope too, so a pick there repaints them
    if (_view === 'context') render(); else renderScopeRow();
}

async function togglePoolField(key) {
    if (!POOL_FIELDS.some(f => f[0] === key)) return;
    const f = poolFields();
    if (f.has(key)) f.delete(key); else f.add(key);
    CoreAPI.setSetting('ccpool_fields', [...f]);
    await CoreAPI.flushSettings();
    await rebuildReferences();
    render();
    void refreshContext();
}

async function openContext() {
    render();
    await loadPlaylists();
    await refreshContext();
    render();
}

/**
 * Mount the panel into the creator. Called once; the creator hands over the draft accessors
 * and which library character the form was filled from.
 * @param {HTMLElement} host where the panel is inserted (the creator body)
 * @param {{readDraft: Function, writeDraft: Function, sourceId: Function, button?: string, openers?: string[]}} d
 */
export function mountCreatorStudio(host, d) {
    deps = d;
    if (injected || !host) return;
    injected = true;
    host.insertAdjacentHTML('beforeend', buildHTML());
    const panel = document.getElementById('creatorStudio');
    wire(panel);
    bindSeam(panel);
    window.registerOverlay?.({ id: 'creatorStudio', tier: 3, close: () => closeStudio() });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) _livePainter?.flush(); });
    followConnectionWrites(followConnections);
}

// the seam is the shared window driver; width is a percent of the body since UI Scale (body zoom) skews pixels
const SEAM_MIN_PCT = 22;
const SEAM_MAX_PCT = 55;

function bindSeam(panel) {
    CoreAPI.mountSeam(panel, { key: 'creatorStudio:seam', side: 'w', min: SEAM_MIN_PCT, max: SEAM_MAX_PCT, minPx: 360 });
}

/** Open the panel, scoped to `field` when a wand opened it; `selection` becomes the passage to revise. */
export async function openStudio({ field = null, selection = null } = {}) {
    const panel = document.getElementById('creatorStudio');
    if (!panel || !deps) return;
    if (field) { _scope = new Set([field]); }
    if (selection?.text?.trim() && field) _selection = { field, text: selection.text };
    panel.classList.remove('hidden');
    panel.setAttribute('aria-hidden', 'false');
    document.getElementById(deps.button || '')?.classList.add('active');
    panel.closest('.modal-glass')?.classList.add('creator-studio-open');
    open = true;
    void mountConnection();
    requestAnimationFrame(_fitInput);
    render();
    _livePainter?.flush();
    try { await loadFields(); } catch (e) { CoreAPI.showToast(`The studio could not start: ${e.message}`, 'error'); }
    renderScopeRow();
    // the playlists name the reference chip; read once per open, never per turn
    void loadPlaylists().then(renderScopeRow);
    void prompts.load().then(renderPromptChips);
    void refreshContext();
    try {
        // a running reply owns the transcript: a re-read would paint the stored rows over its placeholder
        if (!busy()) await loadSessions();
    } catch (e) {
        showStudioLoadFailure(e);
    }
    if (!CoreAPI.isMobileMode()) document.getElementById('ccsInput')?.focus();
}

// the tag wand: model names, then the author's import rules, then the library's spellings and counts. No session
export async function suggestTags(draft) {
    await mountConnection();
    const out = await CoreAPI.readAnswer(await CoreAPI.apiRequest('/creator/tags', 'POST', {
        draft,
        profileId: aiConn?.getProfile?.()?.id || null,
        params: aiConn?.getParams?.(),
    }));
    const names = CoreAPI.applyTagAliases(Array.isArray(out.tags) ? out.tags.filter(t => typeof t === 'string') : []);
    if (!names.length) return [];
    const resolved = await CoreAPI.readAnswer(await CoreAPI.apiRequest('/tags/resolve', 'POST', { names }));
    return Array.isArray(resolved.tags) ? resolved.tags.filter(t => t && typeof t.tag === 'string') : [];
}

// closing is not stopping: only Stop, a subject reset and the creator closing (stop) abort a run
export function closeStudio({ stop = false } = {}) {
    const panel = document.getElementById('creatorStudio');
    if (!panel) return;
    panel.classList.add('hidden');
    panel.setAttribute('aria-hidden', 'true');
    document.getElementById(deps?.button || '')?.classList.remove('active');
    panel.closest('.modal-glass')?.classList.remove('creator-studio-open');
    open = false;
    if (stop) _abort?.abort();
    // the last boundary: the conversation keeps the draft it was about, or a resume would offer back an older one
    if (_sessionId && deps) {
        const sid = _sessionId, draft = deps.readDraft();
        void (async () => {
            try { await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/creator/sessions/${encodeURIComponent(sid)}`, 'PATCH', { draft })); }
            catch (e) { CoreAPI.showToast(`This conversation did not keep the draft: ${e.message}`, 'warning', 8000); }
        })();
    }
}

export function toggleStudio(opts) {
    if (open) closeStudio(); else void openStudio(opts);
}


// a saved draft takes its conversation onto the character; after a landed save, so a failure only logs
export async function bindSessionTo(charId) {
    if (!_sessionId || !charId) return;
    try {
        const updated = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/creator/sessions/${encodeURIComponent(_sessionId)}`, 'PATCH', { charId }));
        const s = _sessions.find(x => x.id === _sessionId);
        if (s) s.charId = updated?.charId ?? charId;
    } catch (e) {
        console.warn('[Studio] the conversation could not follow the saved character:', e?.message || e);
    }
}

/** The form was reset or filled from another character: the conversation belonged to the old draft. */
export function resetStudioSubject() {
    _abort?.abort();
    _subjectGen++;
    _tray.clear();
    _sessionId = null;
    _sessions = [];
    _messages = [];
    _scope = null;
    _selection = null;
    _context = null;
    _editing = null;
    clearReview();
    if (open) {
        render();
        // an unread session list is said, never drawn as none
        void loadSessions().catch(showStudioLoadFailure);
        void refreshContext();
    }
}

function showStudioLoadFailure(e) {
    const body = document.getElementById('ccsBody');
    if (body) paintBody(body, `<div class="cas-empty"><i class="fa-solid fa-triangle-exclamation"></i><p>Could not load the studio.</p><p class="cas-dim">${esc(e.message)}</p></div>`);
}

export default { mountCreatorStudio, openStudio, closeStudio, toggleStudio, resetStudioSubject, bindSessionTo, suggestTags };
