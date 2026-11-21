// Combine a message's alternates into one new reply; it lands as a fresh swipe, so nothing it replaces is touched.

import CoreAPI from '../core-api.js';
import { mountChatWindow, wireCwinInputGrow, openChatWindow, closeChatWindow, registerChatWindow } from './window.js';


const DEFAULT_INSTRUCTION = 'Combine the strongest elements of all the drafts into a single best version.';

// No roleplay preamble: unlike ST's quiet prompts this is a standalone request, so there
// is no chat context to break out of.
const COMBINE_TEMPLATE = `{{name}}'s latest reply has several alternative drafts, numbered below.

{{swipes}}

Task: write one new reply for {{name}} following this instruction: {{instruction}}

Use only material from the drafts unless the instruction says otherwise. Keep their voice, tense, formatting, and a similar length. Output only the new reply text, with no draft numbers, labels, or commentary.`;

/** Function replacers (no '$' patterns), swipes substituted LAST, drafts keep their 1-based numbers to match the cluster. */
function buildCombinePrompt(swipes, includedIndices, instruction, name) {
    const block = includedIndices.map(i => `[Swipe ${i + 1}]\n${swipes[i]}`).join('\n\n');
    return COMBINE_TEMPLATE
        .replaceAll('{{instruction}}', () => String(instruction || '').trim() || DEFAULT_INSTRUCTION)
        .replaceAll('{{name}}', () => name)
        .replaceAll('{{swipes}}', () => block);
}

let panelInjected = false;
let panelOpen = false;

let _chatId = null;
let _seq = null;
let _charName = '';
let _swipes = [];
let _currentId = 0;
let _included = new Set();
let _previewIdx = 0;
let _busy = false;
let _result = null;     // null = compose view; a string = result view
let _onApply = null;    // (seq, text) => Promise<boolean>, the conversation's writer
let _render = (text) => CoreAPI.escapeHtml(text);   // the conversation's renderer (its producer and gate), handed at init
let _fitField = () => {};

function buildPanelHTML() {
    return `
    <div class="cl-cwin csw-panel" id="chatCombinePanel" aria-hidden="true">
        <aside class="cl-cwin-sheet csw-sheet" role="dialog" aria-label="Combine swipes">
            ${CoreAPI.windowGripsHtml('the combine panel')}
            <div class="cl-cwin-header">
                <div class="cl-cwin-title">
                    <i class="fa-solid fa-code-merge"></i>
                    <span class="cl-cwin-name">Combine Swipes</span>
                    <span class="cl-cwin-sep">·</span>
                    <span class="cl-cwin-meta" id="cswMeta"></span>
                </div>
                <button type="button" class="cl-cwin-btn is-close" data-csw-act="close" title="Close (Esc)" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="csw-body">
                <div class="csw-chips" id="cswChips"></div>
                <p class="csw-hint" id="cswHint">Tap a number to preview it. Untick to leave it out of the mix. A blank guide merges the best parts.</p>
                <div class="csw-preview" id="cswPreview"></div>
                <div class="cl-cwin-input-row csw-compose-row" id="cswComposeRow">
                    <textarea id="cswInstruction" rows="1"
                        placeholder="Guide the mix (optional)"></textarea>
                    <button type="button" class="cl-cwin-send" id="cswGenerate" data-csw-act="generate"
                        title="Generate the combined draft (Enter)" aria-label="Generate the combined draft">
                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                    </button>
                    <button type="button" class="cl-cwin-send is-stop hidden" id="cswStop" data-csw-act="stop"
                        title="Stop" aria-label="Stop">
                        <i class="fa-solid fa-stop"></i>
                    </button>
                </div>
            </div>
            <div class="csw-foot" id="cswResultFoot" hidden>
                <button type="button" class="cl-cwin-btn-text csw-btn" data-csw-act="back"><i class="fa-solid fa-chevron-left"></i> Back</button>
                <button type="button" class="cl-cwin-btn-text csw-btn" data-csw-act="retry" id="cswRetry"><i class="fa-solid fa-rotate-right"></i> Retry</button>
                <span class="csw-spacer"></span>
                <button type="button" class="cl-cwin-btn-text is-primary csw-btn" data-csw-act="accept"><i class="fa-solid fa-plus"></i> Add as Swipe</button>
            </div>
        </aside>
    </div>`;
}

function renderChips() {
    const row = document.getElementById('cswChips');
    const hint = document.getElementById('cswHint');
    const field = document.getElementById('cswInstruction');
    if (!row) return;
    const inResult = _result !== null;
    row.hidden = inResult;
    if (hint) hint.hidden = inResult;
    if (field) field.hidden = inResult;
    const name = document.querySelector('#chatCombinePanel .cl-cwin-name');
    if (name) name.textContent = inResult ? 'Combined Result' : 'Combine Swipes';
    if (inResult) return;
    // a span: a checkbox cant live in a button; the innermost data-csw-act wins, so the box is 'include'
    row.innerHTML = _swipes.map((_, i) => `
        <span class="csw-chip${i === _previewIdx ? ' is-active' : ''}${_included.has(i) ? '' : ' is-out'}"
            data-csw-act="preview" data-index="${i}" role="button" tabindex="0">
            <input type="checkbox" data-csw-act="include" data-index="${i}"${_included.has(i) ? ' checked' : ''}
                title="Include swipe ${i + 1} in the mix">
            <span>Swipe ${i + 1}</span>${i === _currentId ? '<span class="csw-current">current</span>' : ''}
        </span>`).join('');
}

// Model output and card greetings are third-party content: the preview renders through the transcript's own renderer
function renderPreview() {
    const el = document.getElementById('cswPreview');
    if (!el) return;
    const text = _result !== null ? _result : (_swipes[_previewIdx] ?? '');
    el.innerHTML = _render(text, _charName);
    el.classList.toggle('is-result', _result !== null);
}

function renderAll() {
    const meta = document.getElementById('cswMeta');
    if (meta) meta.textContent = `${_swipes.length} swipes`;
    document.getElementById('cswComposeRow').hidden = _result !== null;
    document.getElementById('cswResultFoot').hidden = _result === null;
    renderChips();
    renderPreview();
}

// Retry face-swaps to Stop while running, so a reader mid-generation has exactly one live verb.
function setBusy(busy) {
    _busy = busy;
    const panel = document.getElementById('chatCombinePanel');
    panel?.querySelectorAll('.csw-btn').forEach(b => { b.disabled = busy; });
    document.getElementById('cswGenerate')?.classList.toggle('hidden', busy);
    document.getElementById('cswStop')?.classList.toggle('hidden', !busy);
    const retry = document.getElementById('cswRetry');
    if (retry) {
        retry.innerHTML = busy ? '<i class="fa-solid fa-stop"></i> Stop' : '<i class="fa-solid fa-rotate-right"></i> Retry';
        retry.dataset.cswAct = busy ? 'stop' : 'retry';
        retry.disabled = false;
        retry.classList.toggle('is-danger', busy);
    }
}

let _abort = null;

// The run in flight belongs to one open; a close or a reopen stops it and forgets it.
function dropRun() {
    _abort?.abort();
    _abort = null;
}

async function generateCombined() {
    if (_busy) return;
    const included = [..._included].sort((a, b) => a - b);
    if (included.length < 2) { CoreAPI.showToast('Pick at least two swipes to combine', 'info'); return; }
    const instruction = document.getElementById('cswInstruction')?.value ?? '';
    const prompt = buildCombinePrompt(_swipes, included, instruction, _charName || 'the character');
    const ctrl = new AbortController();
    _abort = ctrl;
    setBusy(true);
    try {
        // the connection this chat answers on, as the server resolves it: its own, else the default
        const resolved = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/llm/profiles/resolve?chatId=${encodeURIComponent(_chatId)}`, 'GET'));
        const profileId = resolved?.profile?.id || null;
        if (!profileId) throw new Error('no connection is configured');
        // null leaves the samplers to the connection; checkFinishReason makes a cap-cut reply a loud error
        const text = String(await CoreAPI.callLLM(
            [{ role: 'user', content: prompt }],
            {
                profile: { id: profileId },
                temperature: null, maxTokens: null, signal: ctrl.signal,
                checkFinishReason: true, stripSurrogates: true, debugTag: 'Swipe Combiner',
            },
        ) ?? '').trim();
        // closed or reopened while it ran: the answer belongs to a message the panel has left
        if (_abort !== ctrl) return;
        if (!text) throw new Error('the model returned an empty response');
        _result = text;
        renderAll();
    } catch (err) {
        // A stop is the reader's own verb, not a failure to report.
        if (!err.isCancelled && _abort === ctrl) CoreAPI.showToast(`Could not combine: ${err.message}`, 'error');
    } finally {
        if (_abort === ctrl) {
            _abort = null;
            setBusy(false);
        }
    }
}

async function acceptResult() {
    if (_busy || _result === null || !_onApply) return;
    setBusy(true);
    try {
        const ok = await _onApply(_seq, _result);
        if (ok) {
            CoreAPI.showToast('Added as a new swipe', 'success');
            closePanel();
        }
    } finally {
        setBusy(false);
    }
}

function injectPanel() {
    if (panelInjected) return;
    const host = document.getElementById('chatsConversation');
    if (!host) return;
    panelInjected = true;
    host.insertAdjacentHTML('beforeend', buildPanelHTML());

    const sheet = document.querySelector('.csw-sheet');
    mountChatWindow(sheet, { key: 'chatCombinePanel', close: closePanel, min: { w: 26, h: 36 } });

    // The strip's field had NO grow at all: typed instructions scrolled invisibly
    // inside the one-line box, and the wrapped placeholder sheared mid-line on phones.
    _fitField = wireCwinInputGrow(document.getElementById('cswInstruction'));

    sheet?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-csw-act]');
        if (!btn) return;
        const i = Number(btn.dataset.index);
        switch (btn.dataset.cswAct) {
            case 'close': if (!_busy) closePanel(); return;
            case 'generate': return void generateCombined();
            case 'stop': _abort?.abort(); return;
            case 'back':
                if (_busy) return;
                _result = null;
                return renderAll();
            case 'retry': return void generateCombined();
            case 'accept': return void acceptResult();
            case 'include':
                if (btn.checked) _included.add(i); else _included.delete(i);
                return renderChips();
            case 'preview':
                _previewIdx = i;
                renderChips();
                return renderPreview();
            default: return undefined;
        }
    });

    sheet?.addEventListener('keydown', (e) => {
        if (e.target?.id !== 'cswInstruction' || e.key !== 'Enter') return;
        // Same contract as the assistant strip: plain Enter generates on desktop (Shift for
        // a newline), a phone keeps Enter as newline; Ctrl/Cmd+Enter works everywhere.
        if (e.ctrlKey || e.metaKey || (!e.shiftKey && !CoreAPI.isMobileMode())) {
            e.preventDefault();
            void generateCombined();
        }
    });

    registerChatWindow('chatCombinePanel', { close: closePanel });
}

/**
 * @param {{chatId: string, seq: number, charName: string, swipes: string[],
 *   currentId: number, onApply: (seq: number, text: string) => Promise<boolean>}} ctx
 *   handed in by the conversation, which owns the message and its write.
 */
function openPanel(ctx) {
    if (!Array.isArray(ctx?.swipes) || ctx.swipes.length < 2) return;
    dropRun();
    _chatId = ctx.chatId;
    _seq = ctx.seq;
    _charName = ctx.charName || 'the character';
    _swipes = ctx.swipes.slice();
    _currentId = Math.min(Math.max(ctx.currentId ?? 0, 0), _swipes.length - 1);
    _included = new Set(_swipes.map((_, i) => i));
    _previewIdx = _currentId;
    _result = null;
    _onApply = ctx.onApply || null;
    injectPanel();
    const panel = document.getElementById('chatCombinePanel');
    if (!panel) return;
    openChatWindow(panel);
    panelOpen = true;
    const field = document.getElementById('cswInstruction');
    if (field) field.value = '';
    // After the panel is visible, so the width is real: the empty box sizes to its
    // wrapped placeholder instead of shearing it mid-line.
    requestAnimationFrame(_fitField);
    setBusy(false);
    renderAll();
}

function closePanel() {
    dropRun();
    const panel = document.getElementById('chatCombinePanel');
    panelOpen = false;
    closeChatWindow(panel);
}

/**
 * @param {{ render?: (text: string, charName: string) => string }} [ctx] the conversation's renderer
 */
function init({ render } = {}) {
    if (render) _render = render;
    // one message in one chat, captured at open: a switch closes rather than combine into the wrong chat
    document.addEventListener('cl-chat-changed', (e) => {
        if (panelOpen && e.detail?.chatId !== _chatId) closePanel();
    });
}

export { openPanel, closePanel, buildCombinePrompt, DEFAULT_INSTRUCTION };
export default { init, openPanel, closePanel };
