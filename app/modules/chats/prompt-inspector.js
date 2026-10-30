// The prompt inspector: what the model is actually given, as a flat readable transcript.

import CoreAPI from '../core-api.js';
import { mountChatWindow, openChatWindow, closeChatWindow, registerChatWindow } from './window.js';
import { pictureThumbUrl } from '../ai-panel.js';

const esc = (s) => CoreAPI.escapeHtml(s);

let injected = false;
let open = false;
let _chatId = null;
// the conversation's first shown message, which {{firstDisplayedMessageId}} answers
let _firstShown = () => null;

const ROLE_GLYPH = { system: 'fa-gear', user: 'fa-user', assistant: 'fa-robot' };

function buildHTML() {
    return `
    <div class="cl-cwin cpi-panel" id="chatPromptInspector" aria-hidden="true">
        <div class="cl-cwin-sheet cpi-sheet" role="dialog" aria-label="Prompt inspector">
            ${CoreAPI.windowGripsHtml('the prompt inspector')}
            <div class="cl-cwin-header">
                <div class="cl-cwin-title">
                    <i class="fa-solid fa-magnifying-glass-chart"></i>
                    <span class="cl-cwin-name">Prompt inspector</span>
                    <span class="cl-cwin-sep">·</span>
                    <span class="cl-cwin-meta" id="cpiSub"></span>
                </div>
                <button type="button" class="cl-cwin-btn" data-pi-act="copy" title="Copy the whole prompt" aria-label="Copy the whole prompt">
                    <i class="fa-solid fa-copy"></i>
                </button>
                <button type="button" class="cl-cwin-btn" data-pi-act="refresh" title="Rebuild" aria-label="Rebuild">
                    <i class="fa-solid fa-rotate"></i>
                </button>
                <button type="button" class="cl-cwin-btn is-close" data-pi-act="close" title="Close" aria-label="Close">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div class="cl-cwin-filterbar">
                <i class="fa-solid fa-magnifying-glass cl-cwin-filter-icon"></i>
                <input type="search" id="cpiFilter" class="cl-cwin-filter cpi-filter" placeholder="Find in the prompt"
                    autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
                <div class="cpi-find" id="cpiFind" hidden>
                    <span class="cpi-find-count" id="cpiFindCount"></span>
                    <button type="button" class="cpi-find-btn" data-pi-act="prev" title="Previous match (Shift+Enter)" aria-label="Previous match"><i class="fa-solid fa-chevron-up"></i></button>
                    <button type="button" class="cpi-find-btn" data-pi-act="next" title="Next match (Enter)" aria-label="Next match"><i class="fa-solid fa-chevron-down"></i></button>
                </div>
            </div>
            <div class="cpi-body" id="cpiBody"></div>
        </div>
    </div>`;
}

let _last = null;   // the built prompt, kept only while the panel is open
let _filter = '';   // lowercased, so every comparison below is already folded
let _hit = 0;       // which match is current, an index into the rendered .cpi-hit marks

const FILTER_DEBOUNCE_MS = 140;

/**
 * Step to a match and bring it into view. The marks are re-queried on every step rather
 * than cached, since a re-render replaces every node.
 * @param {number} delta +1 or -1, or 0 to re-mark the current one after a render
 */
function gotoHit(delta) {
    const marks = [...document.querySelectorAll('#cpiBody .cpi-hit')];
    const count = document.getElementById('cpiFindCount');
    const find = document.getElementById('cpiFind');
    if (find) find.hidden = !_filter;
    if (!marks.length) {
        if (count) count.textContent = _filter ? '0' : '';
        return;
    }
    _hit = ((_hit + delta) % marks.length + marks.length) % marks.length;
    marks.forEach((m, i) => m.classList.toggle('is-current', i === _hit));
    if (count) count.textContent = `${_hit + 1}/${marks.length}`;
    // `nearest` rather than `center`: a long system block would otherwise jump the whole
    // pane every step even when the next match is already on screen.
    marks[_hit].scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function matches(m) {
    if (!_filter) return true;
    return String(m.role || '').toLowerCase().includes(_filter)
        || String(m.content || '').toLowerCase().includes(_filter);
}

/** Match the RAW string, then escape per segment, so a needle like "amp" never splits an &amp; entity. */
function highlight(text) {
    const raw = String(text ?? '');
    if (!_filter) return esc(raw);
    const needle = _filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!needle) return esc(raw);
    return raw.split(new RegExp(`(${needle})`, 'gi'))
        .map((part, i) => i % 2 ? `<mark class="cpi-hit">${esc(part)}</mark>` : esc(part))
        .join('');
}

// the macros the server found nothing answering in this message, sent as written
function unansweredTag(m) {
    const names = Array.isArray(m.unanswered) ? m.unanswered : [];
    if (!names.length) return '';
    return `<span class="cl-cwin-tag cpi-unanswered" title="Nothing answers these macros, so they are sent as written">${names.map(n => `{{${esc(n)}}}`).join(' ')}</span>`;
}

function picturesRow(m) {
    const imgs = Array.isArray(m.images) ? m.images : [];
    if (!imgs.length) return '';
    return `<div class="cpi-pics">${imgs.map((img) => {
        // a stored picture by its thumbnail; an extension's inline bytes show as an icon
        const src = pictureThumbUrl(img?.ref, 96);
        const name = img?.name || 'picture';
        return `<span class="cpi-pic" title="${esc(name)}">${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async">` : '<i class="fa-solid fa-image"></i>'}<span class="cpi-pic-name">${esc(name)}</span></span>`;
    }).join('')}</div>`;
}

// the pictures the build could not send as pictures, and why
function picturesNote() {
    const p = _last?.pictures || {};
    const n = (k) => `${k} picture${k === 1 ? '' : 's'}`;
    if (p.withheld) return `<p class="cpi-note"><i class="fa-solid fa-eye-slash"></i>This connection is not known to see pictures, so ${n(p.withheld)} in this chat ${p.withheld === 1 ? 'is' : 'are'} not sent. Its <b>Sees pictures</b> set to <b>Yes</b>, or a <b>Check</b> that passes, sends them.</p>`;
    if (p.stoodIn) return `<p class="cpi-note"><i class="fa-solid fa-image"></i>${n(p.stoodIn)} in older messages ${p.stoodIn === 1 ? 'goes' : 'go'} as text, [picture: name], to fit the context budget or the connection's picture limit.</p>`;
    return '';
}

function render() {
    const body = document.getElementById('cpiBody');
    const sub = document.getElementById('cpiSub');
    if (!body) return;
    if (_last === 'loading') {
        body.innerHTML = '<div class="cl-cwin-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><p>Assembling</p></div>';
        return;
    }
    if (typeof _last === 'string') {
        body.innerHTML = `<div class="cl-cwin-empty is-error"><i class="fa-solid fa-triangle-exclamation"></i>
            <p>Could not build the prompt.</p><p class="cl-cwin-dim">${esc(_last)}</p></div>`;
        if (sub) sub.textContent = '';
        return;
    }
    if (!_last) { body.innerHTML = ''; return; }

    const chars = _last.messages.reduce((n, m) => n + (m.content || '').length, 0);
    if (sub) {
        const b = _last.budget || {};
        // Compact past 10k, or the header meta ellipsizes into "207,490 cha..." next to
        // its own buttons; the per-message rows keep exact counts.
        const fmt = (n) => n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : n.toLocaleString();
        const bits = [`${_last.messages.length} message${_last.messages.length === 1 ? '' : 's'}`, `${fmt(chars)} chars`];
        if (b.tokens) bits.push(`~${fmt(Number(b.tokens))} tok`);
        if (b.trimmed) bits.push(`${b.trimmed} turn${b.trimmed === 1 ? '' : 's'} trimmed to fit`);
        const sent = Number(_last.pictures?.sent) || 0;
        if (sent) bits.push(`${sent} picture${sent === 1 ? '' : 's'}`);
        sub.textContent = bits.join(' · ');
    }

    // real positions, so a filtered view still says #7 rather than renumbering
    const shown = _last.messages
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => matches(m));

    const filtering = !!_filter;
    if (filtering && sub) sub.textContent = `${shown.length} of ${_last.messages.length} messages match`;
    document.getElementById('cpiFilter')?.classList.toggle('is-empty', filtering && !shown.length);

    if (!shown.length) {
        body.innerHTML = filtering
            ? `<div class="cl-cwin-empty"><i class="fa-solid fa-magnifying-glass"></i><p>Nothing matches that.</p></div>`
            : '';
        gotoHit(0);
        return;
    }

    body.innerHTML = (filtering ? '' : picturesNote()) + shown.map(({ m, i }) => `
        <section class="cpi-msg cpi-role-${esc(m.role)}">
            <header class="cpi-msg-head">
                <i class="fa-solid ${ROLE_GLYPH[m.role] || 'fa-comment'}"></i>
                <span class="cpi-role">${esc(m.role)}</span>
                ${unansweredTag(m)}
                <span class="cpi-msg-len">${(m.content || '').length.toLocaleString()}</span>
                <span class="cpi-msg-idx">#${i + 1}</span>
            </header>
            ${picturesRow(m)}
            <pre class="cpi-content">${highlight(m.content || '')}</pre>
        </section>`).join('');

    // after the marks exist; 0 re-marks where we were, keeping the position across a rebuild
    gotoHit(0);
}

async function refresh() {
    // captured, so a slow build for the previous chat cant land over this one's
    const chatId = _chatId;
    if (!chatId) return;
    _last = 'loading';
    render();
    try {
        const first = _firstShown();
        const resp = await CoreAPI.apiRequest(`/chats/${encodeURIComponent(chatId)}/prompt${Number.isInteger(first) ? `?firstShown=${first}` : ''}`, 'GET');
        if (_chatId !== chatId) return;
        if (!resp.ok) throw new Error(`(${resp.status}) ${await resp.text().catch(() => resp.statusText)}`);
        _last = await resp.json();
    } catch (e) {
        if (_chatId !== chatId) return;
        _last = e.message;
        console.error('[PromptInspector] Build failed:', e.message);
    }
    if (_chatId !== chatId) return;
    render();
}

async function copyAll() {
    if (!_last || typeof _last === 'string') return;
    const text = _last.messages.map(m => `### ${m.role}\n${m.content || ''}`).join('\n\n');
    if (await CoreAPI.copyTextToClipboard(text)) CoreAPI.showToast('Prompt copied', 'success');
    else CoreAPI.showToast('Could not copy the prompt', 'error');
}

function injectPanel() {
    if (injected) return;
    const host = document.getElementById('chatsConversation');
    if (!host) return;
    injected = true;
    host.insertAdjacentHTML('beforeend', buildHTML());

    // A window like its siblings rather than a modal: the prompt is read WHILE looking at the chat.
    const sheet = document.querySelector('.cpi-sheet');
    mountChatWindow(sheet, {
        key: 'chatInspectPanel',
        close: closePanel,
        min: { w: 24, h: 30 },
    });

    document.getElementById('chatPromptInspector')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-pi-act]');
        if (!btn) return;
        switch (btn.dataset.piAct) {
            case 'close': return closePanel();
            case 'refresh': return void refresh();
            case 'copy': return copyAll();
            case 'prev': return gotoHit(-1);
            case 'next': return gotoHit(1);
            default: return undefined;
        }
    });

    // debounced (each keystroke re-renders every body); read from the field so a fast typist cant land an older value last
    const field = document.getElementById('cpiFilter');
    const onFilter = CoreAPI.debounce(() => {
        const next = String(field?.value || '').trim().toLowerCase();
        if (next === _filter) return;
        _filter = next;
        _hit = 0;            // a new term starts at its first match, not wherever the last one ended
        render();
    }, FILTER_DEBOUNCE_MS);
    field?.addEventListener('input', onFilter);

    // Enter walks the matches from the field itself, which is where the hands already are.
    field?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        gotoHit(e.shiftKey ? -1 : 1);
    });

    registerChatWindow('chatPromptInspector', { close: closePanel });
}

function openPanel(ctx) {
    if (ctx?.chatId) _chatId = ctx.chatId;
    if (typeof ctx?.firstShown === 'function') _firstShown = ctx.firstShown;
    injectPanel();
    const panel = document.getElementById('chatPromptInspector');
    if (!panel) return;
    openChatWindow(panel, { button: 'chatConvInspect' });
    open = true;
    refresh();
}

function closePanel() {
    const panel = document.getElementById('chatPromptInspector');
    open = false;
    closeChatWindow(panel, { button: 'chatConvInspect' });
    // Nothing is kept: the next open rebuilds, so a stale prompt can never be read as live.
    _last = null;
}

function togglePanel(ctx) {
    if (open) closePanel();
    else openPanel(ctx);
}

function init() {
    // The panel follows the conversation, like its siblings. The subject comes from the event
    // because the announce fires before the conversation's own open finishes.
    document.addEventListener('cl-chat-changed', (e) => {
        if (!e.detail?.chatId) {
            _chatId = null;
            if (open) closePanel();
            return;
        }
        if (e.detail.chatId === _chatId) return;
        _chatId = e.detail.chatId;
        if (open) void refresh();
    });
}

export { openPanel, closePanel, togglePanel };
export default { init, openPanel, closePanel, togglePanel };
