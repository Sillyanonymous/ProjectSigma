// Regex scripts: yours, this chat's preset's and its character's, each list with its switches, an editor and a tester.

import CoreAPI from '../core-api.js';
import { mountChatWindow, openChatWindow, closeChatWindow, registerChatWindow } from './window.js';

const esc = (s) => CoreAPI.escapeHtml(s);

// placements by the numbers SillyTavern's script files carry
const PLACES = [
    { n: 1, label: 'Your messages' },
    { n: 2, label: 'AI replies' },
    { n: 3, label: 'Narrator' },
    { n: 5, label: 'Lorebook entries' },
    { n: 6, label: 'Reasoning' },
];
// what a script changes, as SillyTavern's two flags spell it
const MODES = [
    { key: 'screen', label: 'What you see', hint: 'Only on screen. SillyTavern\'s "Alter Chat Display".', flags: { markdownOnly: true, promptOnly: false } },
    { key: 'prompt', label: 'What the AI reads', hint: 'Only in what is sent. SillyTavern\'s "Alter Outgoing Prompt".', flags: { markdownOnly: false, promptOnly: true } },
    { key: 'both', label: 'Both', hint: 'On screen and in what is sent.', flags: { markdownOnly: true, promptOnly: true } },
    { key: 'text', label: 'The message itself', hint: 'As if the message were written that way: on screen and in what is sent, the stored message as it was unless Change what is saved is on.', flags: { markdownOnly: false, promptOnly: false } },
];
const modeOf = (s) => MODES.find(m => m.flags.markdownOnly === !!s.markdownOnly && m.flags.promptOnly === !!s.promptOnly) || MODES[3];
const MACRO_MODES = [{ n: 0, label: 'None' }, { n: 1, label: 'Filled in' }, { n: 2, label: 'Filled in and escaped' }];

let panelInjected = false;
let panelOpen = false;
let _chatId = null;
let _bundle = null;
let _loadError = null;
let _tab = 'yours';
// the script open in the editor: { owner, draft, original } or null for the list
let _editing = null;
// a Save in flight: the editor's buttons wait for it
let _saving = false;
let _testTimer = null;
let _engine = null;
// the conversation's door: its read of the chat's scripts (the one cache) and the re-read that refreshes it
let _ctx = { bundle: () => null, refresh: async () => {}, render: (text) => CoreAPI.escapeHtml(text) };
// the window's writes, one after another, each built from the lists as the one before left them
let _writes = Promise.resolve(true);
// where the list was scrolled when the editor opened over it
let _listScroll = 0;

// ========================================
// THE LISTS
// ========================================

/** The list a tab shows: who owns it, its scripts, and its answer when it needs one. */
function listOf(tab = _tab) {
    if (!_bundle) return null;
    if (tab === 'yours') return { owner: { kind: 'yours' }, scripts: _bundle.yours || [], consent: 'allowed' };
    const part = tab === 'preset' ? _bundle.preset : _bundle.character;
    if (!part) return null;
    const owner = tab === 'preset' ? { kind: 'preset', presetId: part.id, name: part.name } : { kind: 'character', charId: part.id, name: part.name };
    return { owner, scripts: part.scripts || [], consent: part.consent };
}

/** A source with scripts nobody has answered for yet: the window's dot and offer. */
export function waitingSources(bundle = _bundle) {
    return ['preset', 'character'].filter(k => bundle?.[k]?.consent === null && bundle[k].scripts?.length);
}

// a find as it runs, its macros filled, so their braces never read as a broken pattern
function findAsRun(s) {
    return Number(s.substituteRegex) ? String(s.findRegex || '').replace(/\{\{[^{}]*\}\}/g, 'x') : s.findRegex;
}

function problemOf(s) {
    if (!String(s.findRegex || '').trim()) return { tag: 'No pattern', warn: false };
    if (s.stopped) return { tag: 'Too slow', warn: true };
    if (_engine && !_engine.compileFind(findAsRun(s))) return { tag: 'Broken pattern', warn: true };
    if (!(s.placement || []).length) return { tag: 'Runs nowhere', warn: false };
    return null;
}

function chipsOf(s) {
    const mode = modeOf(s);
    const chips = [`<span class="cl-cwin-tag">${esc(mode.label)}</span>`];
    if (mode.key === 'text' && s.alterSaved) chips.push('<span class="cl-cwin-tag is-accent">Changes what is saved</span>');
    const places = PLACES.filter(p => (s.placement || []).includes(p.n)).map(p => p.label);
    if (places.length) chips.push(`<span class="crx-places">${esc(places.join(', '))}</span>`);
    const problem = problemOf(s);
    if (problem) chips.push(`<span class="cl-cwin-tag${problem.warn ? ' is-warn' : ''}">${esc(problem.tag)}</span>`);
    return chips.join('');
}

function rowHtml(s, i) {
    return `<div class="cl-cwin-row crx-row${s.disabled ? ' crx-off' : ''}" data-i="${i}" draggable="true">
        <span class="crx-grip" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
        <button type="button" class="crx-main" data-crx-act="edit" data-i="${i}">
            <span class="crx-name">${esc(s.scriptName || 'Untitled script')}</span>
            <span class="crx-chips">${chipsOf(s)}</span>
        </button>
        <button type="button" class="crx-kebab cl-cwin-act" data-crx-act="acts" data-i="${i}" title="Actions" aria-label="Actions"><i class="fa-solid fa-ellipsis-vertical fa-fw"></i></button>
        <label class="crx-switch" title="${s.disabled ? 'Turn this script on' : 'Turn this script off'}">
            <input type="checkbox" class="cl-switch-input" data-crx-toggle="${i}"${s.disabled ? '' : ' checked'} aria-label="${esc(s.scriptName || 'Script')} on">
            <span class="cl-switch is-sm" aria-hidden="true"></span>
        </label>
    </div>`;
}

function noteOf(list) {
    if (_tab === 'yours') return 'Your scripts run in every chat, before any other.';
    if (_tab === 'preset') return `The scripts of ${list.owner.name || 'this preset'}, run after yours while it is the chat's preset.`;
    return `${list.owner.name || 'This character'}'s scripts, from the card, run last in chats with them.`;
}

function offerHtml(list) {
    const n = list.scripts.length;
    const whose = _tab === 'preset' ? 'This preset' : `${list.owner.name || 'This character'}'s card`;
    return `<section class="cl-cwin-offer">
        <i class="cl-cwin-offer-glyph fa-solid fa-code"></i>
        <div class="cl-cwin-offer-text">
            <p class="cl-cwin-offer-title">${esc(whose)} carries ${n} regex script${n === 1 ? '' : 's'}</p>
            <p class="cl-cwin-offer-body">They stay off until you allow them. A script can change what you see and what the AI reads.</p>
            <div class="cl-cwin-offer-acts">
                <button type="button" class="cl-cwin-btn-text" data-crx-act="allow"><i class="fa-solid fa-check"></i> Allow</button>
                <button type="button" class="cl-cwin-offer-dismiss" data-crx-act="decline" title="Keep these scripts off and stop asking">Leave Them Off</button>
            </div>
        </div>
    </section>`;
}

function consentHtml(list) {
    if (_tab === 'yours') return '';
    if (list.consent === null && list.scripts.length) return offerHtml(list);
    if (list.consent === null) return '';
    return `<label class="cl-cwin-field cl-cwin-toggle crx-consent">
        <span class="cl-cwin-field-label">Run these scripts</span>
        <input type="checkbox" class="cl-switch-input" data-crx-consent${list.consent === 'allowed' ? ' checked' : ''}>
        <span class="cl-switch" aria-hidden="true"></span>
    </label>`;
}

function listViewHtml() {
    if (_loadError) return `<div class="cl-cwin-empty"><i class="fa-solid fa-triangle-exclamation"></i><p>${esc(_loadError)}</p></div>`;
    if (!_bundle) return '<div class="cl-cwin-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><p>Reading the scripts</p></div>';
    const list = listOf();
    if (!list) {
        const why = _tab === 'preset' ? 'This chat uses no preset.' : 'This chat has no character.';
        return `<div class="cl-cwin-empty"><i class="fa-solid fa-code"></i><p>${esc(why)}</p></div>`;
    }
    const rows = list.scripts.map(rowHtml).join('');
    return `<p class="cl-cwin-hint crx-note">${esc(noteOf(list))}</p>
        ${consentHtml(list)}
        <div class="crx-list${list.consent === 'allowed' ? '' : ' is-held'}" id="crxList"${list.consent === 'allowed' ? '' : ' title="Off until you allow these scripts"'}>${rows || '<div class="cl-cwin-empty"><i class="fa-solid fa-code"></i><p>No scripts yet.</p></div>'}</div>
        <div class="crx-foot">
            <button type="button" class="cl-cwin-btn-text" data-crx-act="add"><i class="fa-solid fa-plus"></i> New Script</button>
            <button type="button" class="cl-cwin-btn-text" data-crx-act="import"><i class="fa-solid fa-file-import"></i> Import</button>
            ${list.scripts.length ? '<button type="button" class="cl-cwin-btn-text" data-crx-act="export"><i class="fa-solid fa-file-export"></i> Export</button>' : ''}
        </div>`;
}

// ========================================
// THE EDITOR
// ========================================

function editorHtml() {
    const d = _editing.draft;
    const mode = modeOf(d);
    const num = (v) => (Number.isInteger(v) ? String(v) : '');
    return `<div class="crx-editor">
        <button type="button" class="cl-cwin-btn-text crx-back" data-crx-act="back"><i class="fa-solid fa-arrow-left"></i> All Scripts</button>
        <label class="cl-cwin-field cl-cwin-toggle">
            <span class="cl-cwin-field-label">On</span>
            <input type="checkbox" class="cl-switch-input" data-crx-field="on"${d.disabled ? '' : ' checked'}>
            <span class="cl-switch" aria-hidden="true"></span>
        </label>
        <div class="cl-cwin-block">
            <label class="cl-cwin-label" for="crxName">Name</label>
            <input type="search" id="crxName" class="cl-cwin-input" data-crx-field="scriptName" value="${esc(d.scriptName || '')}" autocomplete="off">
        </div>
        <div class="cl-cwin-block">
            <label class="cl-cwin-label" for="crxFind">Find</label>
            <textarea id="crxFind" class="cl-cwin-input cl-cwin-textarea is-code" data-crx-field="findRegex" rows="2" spellcheck="false" autocapitalize="off" autocorrect="off">
${esc(d.findRegex || '')}</textarea>
            <p class="cl-cwin-hint">A pattern like /hello/gi, or plain text. Only the first line counts.</p>
        </div>
        <div class="cl-cwin-block">
            <label class="cl-cwin-label" for="crxReplace">Replace with</label>
            <textarea id="crxReplace" class="cl-cwin-input cl-cwin-textarea is-code" data-crx-field="replaceString" rows="2" spellcheck="false" autocapitalize="off" autocorrect="off">
${esc(d.replaceString || '')}</textarea>
            <p class="cl-cwin-hint">{{match}} is what was found, $1 or $&lt;name&gt; a group. Macros like {{char}} work here.</p>
        </div>
        <div class="cl-cwin-block">
            <span class="cl-cwin-label">Runs on</span>
            <div class="cl-cwin-picks" role="group" aria-label="Runs on">${PLACES.map(p => `<label class="cl-cwin-pick"><input type="checkbox" data-crx-place="${p.n}"${(d.placement || []).includes(p.n) ? ' checked' : ''}><span>${esc(p.label)}</span></label>`).join('')}</div>
        </div>
        <div class="cl-cwin-block">
            <label class="cl-cwin-label" for="crxMode">What it changes</label>
            <select id="crxMode" class="cl-select-fluid cl-cwin-field-control" data-crx-field="mode">${MODES.map(m => `<option value="${m.key}"${m.key === mode.key ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
            <p class="cl-cwin-hint" id="crxModeHint">${esc(mode.hint)}</p>
        </div>
        <div class="crx-saved" id="crxSavedRow"${mode.key === 'text' ? '' : ' hidden'}>
            <label class="cl-cwin-field cl-cwin-toggle">
                <span class="cl-cwin-field-label">Change what is saved</span>
                <input type="checkbox" class="cl-switch-input" data-crx-field="alterSaved"${d.alterSaved ? ' checked' : ''}>
                <span class="cl-switch" aria-hidden="true"></span>
            </label>
            <p class="cl-cwin-hint">Rewrites messages as they are stored, as SillyTavern does. Off, the stored message keeps its words.</p>
        </div>
        <details class="cl-cwin-fold crx-advanced">
            <summary class="cl-cwin-fold-summary">
                <i class="fa-solid fa-chevron-right"></i>
                <span>Advanced</span>
                <span class="cl-cwin-fold-hint">depth, macros, trimming, edits</span>
            </summary>
            <div class="cl-cwin-fold-body crx-fold-body">
            <div class="cl-cwin-fieldrow">
                <div class="cl-cwin-block"><label class="cl-cwin-label" for="crxMin">Min depth</label>
                    <input type="number" id="crxMin" class="cl-cwin-input" data-crx-field="minDepth" min="-1" step="1" value="${num(d.minDepth)}"></div>
                <div class="cl-cwin-block"><label class="cl-cwin-label" for="crxMax">Max depth</label>
                    <input type="number" id="crxMax" class="cl-cwin-input" data-crx-field="maxDepth" min="0" step="1" value="${num(d.maxDepth)}"></div>
            </div>
            <p class="cl-cwin-hint">How far back a message may be, 0 the newest. Empty is any.</p>
            <div class="cl-cwin-block">
                <label class="cl-cwin-label" for="crxMacros">Macros in Find</label>
                <select id="crxMacros" class="cl-select-fluid cl-cwin-field-control" data-crx-field="substituteRegex">${MACRO_MODES.map(m => `<option value="${m.n}"${m.n === (d.substituteRegex || 0) ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
            </div>
            <div class="cl-cwin-block">
                <label class="cl-cwin-label" for="crxTrim">Trim out</label>
                <textarea id="crxTrim" class="cl-cwin-input cl-cwin-textarea is-code" data-crx-field="trimStrings" rows="2" spellcheck="false" autocapitalize="off" autocorrect="off">
${esc((d.trimStrings || []).join('\n'))}</textarea>
                <p class="cl-cwin-hint">One per line: cut from what was found before it is put back.</p>
            </div>
            <label class="cl-cwin-field cl-cwin-toggle">
                <span class="cl-cwin-field-label">Run when a message is edited</span>
                <input type="checkbox" class="cl-switch-input" data-crx-field="runOnEdit"${d.runOnEdit ? ' checked' : ''}>
                <span class="cl-switch" aria-hidden="true"></span>
            </label>
            </div>
        </details>
        <div class="cl-cwin-block crx-test">
            <label class="cl-cwin-label" for="crxSample">Try it</label>
            <textarea id="crxSample" class="cl-cwin-input cl-cwin-textarea" rows="3" placeholder="Some text to try the script on">
${esc(_editing.sample || '')}</textarea>
            <div class="crx-result"><span class="cl-cwin-label">On screen</span><div class="crx-out" id="crxOutScreen"></div></div>
            <div class="crx-result"><span class="cl-cwin-label">Sent to the AI</span><div class="crx-out is-plain" id="crxOutPrompt"></div></div>
            <p class="cl-cwin-hint crx-status" id="crxStatus" role="status"></p>
        </div>
        <div class="crx-foot">
            <button type="button" class="cl-cwin-btn-text" data-crx-act="save"><i class="fa-solid fa-check"></i> Save</button>
            <button type="button" class="cl-cwin-btn-text" data-crx-act="back">Cancel</button>
        </div>
    </div>`;
}

/** The editor's fields into the draft, in SillyTavern's script shape. */
function readEditor(sheet) {
    const d = { ..._editing.draft };
    const field = (k) => sheet.querySelector(`[data-crx-field="${k}"]`);
    d.disabled = !field('on').checked;
    d.scriptName = field('scriptName').value;
    d.findRegex = field('findRegex').value;
    d.replaceString = field('replaceString').value;
    d.placement = [...sheet.querySelectorAll('[data-crx-place]')].filter(x => x.checked).map(x => Number(x.dataset.crxPlace));
    Object.assign(d, (MODES.find(m => m.key === field('mode').value) || MODES[3]).flags);
    d.alterSaved = modeOf(d).key === 'text' && field('alterSaved').checked;
    const depth = (v, floor) => (v.trim() === '' || !Number.isInteger(Number(v)) || Number(v) < floor ? null : Number(v));
    d.minDepth = depth(field('minDepth').value, -1);
    d.maxDepth = depth(field('maxDepth').value, 0);
    d.substituteRegex = Number(field('substituteRegex').value) || 0;
    d.trimStrings = field('trimStrings').value.split(/\r?\n/).filter(Boolean);
    d.runOnEdit = field('runOnEdit').checked;
    return d;
}

function blankScript() {
    return { scriptName: '', findRegex: '', replaceString: '', trimStrings: [], placement: [2], disabled: false, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null, alterSaved: false };
}

// ========================================
// WRITES (each its own verb, outside any click handler)
// ========================================

// a card's list as it stands now: it is written whole, so each change applies to the server's copy, never a stale one
async function cardScripts(owner) {
    const read = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/regex/characters/${encodeURIComponent(owner.charId)}`, 'GET'));
    return Array.isArray(read?.scripts) ? read.scripts : [];
}

// a character's list is the card's, written whole
async function characterPut(owner, scripts, sample = '') {
    return CoreAPI.readAnswer(await CoreAPI.apiRequest(`/regex/characters/${encodeURIComponent(owner.charId)}`, 'PUT', { scripts, ...(sample ? { sample } : {}) }));
}

/** Save a script by its id (a new one has none, and lands below the script `after` names); a card's list is written whole. */
async function saveScript(owner, draft, { after = null, sample = '' } = {}) {
    if (owner.kind === 'character') {
        const list = await cardScripts(owner);
        if (draft.id) {
            const at = list.findIndex(x => x.id === draft.id);
            if (at === -1) throw new Error('That script is no longer on the card, so the list was read again.');
            list[at] = draft;
        } else {
            const at = after ? list.findIndex(x => x.id === after) : -1;
            if (at === -1) list.push(draft); else list.splice(at + 1, 0, draft);
        }
        return characterPut(owner, list, sample);
    }
    const body = { script: draft, ...(sample ? { sample } : {}) };
    if (draft.id) return CoreAPI.readAnswer(await CoreAPI.apiRequest(`/regex/scripts/${encodeURIComponent(draft.id)}`, 'PATCH', body));
    return CoreAPI.readAnswer(await CoreAPI.apiRequest('/regex/scripts', 'POST', { ...body, presetId: owner.presetId || null, ...(after ? { after } : {}) }));
}

async function deleteScript(owner, script) {
    if (owner.kind === 'character') return characterPut(owner, (await cardScripts(owner)).filter(x => x.id !== script.id));
    return CoreAPI.readAnswer(await CoreAPI.apiRequest(`/regex/scripts/${encodeURIComponent(script.id)}`, 'DELETE'));
}

/** A list in a new order, by its scripts' ids; on a card, any the order does not name keep their place after it. */
async function reorderScripts(owner, ids) {
    if (owner.kind === 'character') {
        const list = await cardScripts(owner);
        const byId = new Map(list.map(x => [x.id, x]));
        return characterPut(owner, [...ids.map(id => byId.get(id)).filter(Boolean), ...list.filter(x => !ids.includes(x.id))]);
    }
    return CoreAPI.readAnswer(await CoreAPI.apiRequest('/regex/order', 'PUT', { presetId: owner.presetId || null, ids }));
}

async function answerConsent(owner, value) {
    const who = owner.kind === 'preset' ? { presetId: owner.presetId } : { charId: owner.charId };
    return CoreAPI.readAnswer(await CoreAPI.apiRequest('/regex/consent', 'PUT', { ...who, answer: value }));
}

async function importScripts(owner, scripts) {
    if (owner.kind === 'character') return characterPut(owner, [...(await cardScripts(owner)), ...scripts]);
    return CoreAPI.readAnswer(await CoreAPI.apiRequest('/regex/scripts', 'POST', { scripts, presetId: owner.presetId || null }));
}

/** One script tried on a sample by the server, under its time budget. */
async function testDraft(draft, text) {
    return CoreAPI.readAnswer(await CoreAPI.apiRequest('/regex/test', 'POST', { script: draft, text, chatId: _editing?.chatId || _chatId, where: (draft.placement || [])[0] || 2 }));
}

// ========================================
// PAINT
// ========================================

function paintTabs() {
    const waiting = waitingSources();
    document.querySelectorAll('.crx-tabs [data-tab]').forEach(b => {
        const on = b.dataset.tab === _tab;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-selected', String(on));
        b.classList.toggle('is-waiting', waiting.includes(b.dataset.tab));
    });
}

function render() {
    const content = document.getElementById('crxContent');
    const sheet = document.querySelector('.crx-sheet');
    if (!content || !sheet) return;
    sheet.classList.toggle('crx-mode-edit', !!_editing);
    paintTabs();
    const count = document.getElementById('crxCount');
    if (count) count.textContent = _bundle ? `${(_bundle.active || []).filter(s => !s.disabled && !s.stopped && !problemOf(s)).length} running` : '';
    if (_editing) {
        content.innerHTML = editorHtml();
        content.querySelectorAll('select').forEach(sel => CoreAPI.initCustomSelect(sel));
        queueTest();
        return;
    }
    content.innerHTML = listViewHtml();
    const list = document.getElementById('crxList');
    const owner = listOf()?.owner;
    if (list && owner && listOf().scripts.length > 1) {
        // the helper moves the rows; the order is read back from them, each row naming the place it held
        const drawn = listOf().scripts;
        CoreAPI.wireDragReorder(list, { item: '.crx-row', handle: '.crx-grip', key: 'i', onReorder: () => {
            const ids = [...list.querySelectorAll('.crx-row')].map(r => drawn[Number(r.dataset.i)]?.id).filter(Boolean);
            return run(() => reorderScripts(owner, ids));
        } });
    }
}

function status(text, warn = false) {
    const el = document.getElementById('crxStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-warn', warn);
}

function queueTest() {
    clearTimeout(_testTimer);
    _testTimer = setTimeout(runTest, 250);
}

async function runTest() {
    const sheet = document.querySelector('.crx-sheet');
    const sample = document.getElementById('crxSample');
    if (!_editing || !sheet || !sample) return;
    _editing.sample = sample.value;
    const draft = readEditor(sheet);
    const screen = document.getElementById('crxOutScreen');
    const prompt = document.getElementById('crxOutPrompt');
    if (!sample.value) {
        screen.textContent = ''; prompt.textContent = '';
        const broken = !!draft.findRegex && !!_engine && !_engine.compileFind(findAsRun(draft));
        document.getElementById('crxFind')?.classList.toggle('is-invalid', broken);
        status(broken ? 'This pattern does not compile.' : owedNote(), broken);
        return;
    }
    let got;
    try { got = await testDraft(draft, sample.value); } catch (e) { status(e.message || 'The script could not be tried.', true); return; }
    if (!_editing || document.getElementById('crxSample') !== sample) return;
    // through the chat's producer and gate; a script that changes what is saved shows what the save leaves
    const saving = modeOf(draft).key === 'text' && draft.alterSaved;
    screen.innerHTML = _ctx.render(saving ? got.saved : got.screen);
    prompt.textContent = saving ? got.saved : got.prompt;
    document.getElementById('crxFind')?.classList.toggle('is-invalid', !!got.error && got.error !== 'timeout');
    if (got.error === 'timeout') status('This pattern took too long on the sample, so it would be stopped. Save is refused.', true);
    else if (got.error) status('This pattern does not compile.', true);
    else status(`${got.matches} match${got.matches === 1 ? '' : 'es'}.${saving ? ' Applied as messages are saved.' : ''}${owedNote() ? ` ${owedNote()}` : ''}`);
}

// saving into a list not yet allowed does not allow it; the editor says so
function owedNote() {
    if (!_editing || _editing.consent === 'allowed') return '';
    return _editing.owner.kind === 'preset' ? 'It runs once you allow this preset\'s scripts.' : 'It runs once you allow this character\'s scripts.';
}

// ========================================
// LOAD AND RUN
// ========================================

// the conversation reads the chat's scripts again and the window shows that read; the engine names a pattern's problems
async function load() {
    const chatId = _chatId;
    if (!chatId) return;
    try {
        await _ctx.refresh();
        if (chatId !== _chatId) return;
        _bundle = _ctx.bundle();
        _loadError = _bundle ? null : 'The scripts could not be read.';
        const any = ['yours', 'preset', 'character'].some(k => (k === 'yours' ? _bundle?.yours : _bundle?.[k]?.scripts)?.length);
        if (any && !_engine) _engine = await import(CoreAPI.serverUrl('/regex/engine.js'));
    } catch (e) {
        if (chatId !== _chatId) return;
        _loadError = `The scripts could not be read: ${e.message}`;
    }
    if (chatId !== _chatId) return;
    paintDot();
    if (panelOpen && !_editing) render();
}

// a write after the ones before it, then the lists read again (the conversation's rows follow the same read)
function run(write) {
    _writes = _writes.then(async () => {
        try {
            await write();
        } catch (e) {
            CoreAPI.showToast(e.status === 422 ? 'That pattern took too long on the sample text, so it was not saved.' : e.status === 404 ? 'That script is gone (removed elsewhere), so the list was read again.' : (e.message || 'The scripts could not be saved.'), 'error');
            await load();
            return false;
        }
        await load();
        return true;
    });
    return _writes;
}

/** The conversation's door: the Regex button and its phone tile carry a dot while a source waits for an answer. */
export function paintDot(bundle = _bundle) {
    const waiting = waitingSources(bundle).length > 0;
    document.getElementById('chatConvRegex')?.classList.toggle('is-waiting', waiting);
}

function openEditor(index) {
    const list = listOf();
    if (!list) return;
    const original = Number.isInteger(index) ? list.scripts[index] : null;
    _listScroll = document.getElementById('crxContent')?.scrollTop || 0;
    _editing = { owner: list.owner, consent: list.consent, chatId: _chatId, index, original, draft: original ? { ...original } : blankScript(), sample: _editing?.sample || '' };
    render();
    const content = document.getElementById('crxContent');
    if (content) content.scrollTop = 0;
    // a phone keeps its keyboard down until a field is tapped, as the prompt manager's editor does
    if (!CoreAPI.isMobileMode()) document.getElementById('crxName')?.focus();
}

// the editor's fields differ from the script it opened on
function editorDirty() {
    const sheet = document.querySelector('.crx-sheet');
    if (!_editing || !sheet?.querySelector('.crx-editor')) return false;
    const known = (d) => ({ ...d, placement: PLACES.map(x => x.n).filter(n => (d.placement || []).includes(n)) });
    return JSON.stringify(known(readEditor(sheet))) !== JSON.stringify(known(_editing.draft));
}

// true when the editor may close: nothing unsaved, or the reader lets it go
async function leaveEditor() {
    if (_saving) return false;
    if (!editorDirty()) return true;
    // Escape clears a search field as its own default, so a kept edit puts back what was typed
    const typed = [...document.querySelectorAll('.crx-editor input[type="search"]')].map(el => [el, el.value]);
    let go = false;
    try {
        go = !!(await CoreAPI.showConfirm({ title: 'Discard this script\'s changes?', message: 'The changes to this script are not saved.', confirmLabel: 'Discard', cancelLabel: 'Keep Editing', danger: true }));
    } catch { /* kept */ }
    if (!go) for (const [el, value] of typed) el.value = value;
    return go;
}

function closeEditor() {
    _editing = null;
    clearTimeout(_testTimer);
    render();
    // back where the reader left the list; a chat switched under the editor shows its own once it is closed
    const content = document.getElementById('crxContent');
    if (content) content.scrollTop = _listScroll;
    if (!_bundle && panelOpen) void load();
}

async function saveEditor() {
    const sheet = document.querySelector('.crx-sheet');
    if (!_editing || !sheet || _saving) return;
    // the editor as it stood at the press: the write waits its turn, and the editor may be gone by then
    const editing = _editing;
    const draft = readEditor(sheet);
    const sample = document.getElementById('crxSample')?.value || '';
    const hold = (on) => sheet.querySelectorAll('[data-crx-act="save"], [data-crx-act="back"]').forEach((b) => { b.disabled = on; });
    _saving = true;
    hold(true);
    try {
        if (await run(() => saveScript(editing.owner, draft, { sample })) && _editing === editing) closeEditor();
    } finally {
        _saving = false;
        hold(false);
    }
}

function rowActs(e, i) {
    const list = listOf();
    const menu = CoreAPI.getModule('context-menu');
    if (!list || !menu?.showItems) return;
    const n = list.scripts.length;
    const s = list.scripts[i];
    const ids = list.scripts.map(x => x.id);
    const order = (to) => { const rest = ids.filter(x => x !== s.id); rest.splice(to, 0, s.id); return rest; };
    const move = (to) => () => run(() => reorderScripts(list.owner, order(to)));
    // under its kebab, so a menu opened from the keyboard stands where the button is
    const box = e.target.closest('button')?.getBoundingClientRect();
    menu.showItems(e, [
        { type: 'header', label: CoreAPI.truncate(s.scriptName || 'Untitled script', 32) },
        { icon: 'fa-solid fa-pen', label: 'Edit', action: () => openEditor(i) },
        { icon: 'fa-solid fa-clone', label: 'Duplicate', action: () => run(() => saveScript(list.owner, { ...withoutId(s), scriptName: `${s.scriptName || 'Script'} (copy)` }, { after: s.id })) },
        ...(i > 0 ? [{ icon: 'fa-solid fa-arrow-up', label: 'Move Up', action: move(i - 1) }, { icon: 'fa-solid fa-angles-up', label: 'Move to Top', action: move(0) }] : []),
        ...(i < n - 1 ? [{ icon: 'fa-solid fa-arrow-down', label: 'Move Down', action: move(i + 1) }, { icon: 'fa-solid fa-angles-down', label: 'Move to Bottom', action: move(n - 1) }] : []),
        { type: 'separator' },
        { icon: 'fa-solid fa-trash', label: 'Delete', className: 'danger', action: () => confirmDelete(list.owner, s) },
    ], box ? { x: box.left, y: box.bottom } : null);
}

// a copy is a new script: the server gives it its own id
function withoutId(s) {
    const { id, ...rest } = s;
    return rest;
}

async function confirmDelete(owner, s) {
    const yes = await CoreAPI.showConfirm({ title: 'Delete this script?', message: `"${s.scriptName || 'Untitled script'}" will be gone from this list.`, confirmLabel: 'Delete', danger: true });
    if (yes) await run(() => deleteScript(owner, s));
}

function pickImport() {
    const list = listOf();
    if (!list) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        let parsed;
        try { parsed = JSON.parse(await file.text()); } catch { CoreAPI.showToast('That file is not a script file.', 'error'); return; }
        const scripts = (Array.isArray(parsed) ? parsed : [parsed]).filter(x => x && typeof x === 'object' && 'findRegex' in x).map(withoutId);
        if (!scripts.length) { CoreAPI.showToast('No regex scripts were found in that file.', 'warning'); return; }
        if (await run(() => importScripts(list.owner, scripts))) CoreAPI.showToast(`${scripts.length} script${scripts.length === 1 ? '' : 's'} imported.`, 'success');
    }, { once: true });
    input.click();
}

async function exportList() {
    const list = listOf();
    if (!list) return;
    const q = list.owner.kind === 'preset' ? `?presetId=${encodeURIComponent(list.owner.presetId)}` : list.owner.kind === 'character' ? `?charId=${encodeURIComponent(list.owner.charId)}` : '';
    try {
        const scripts = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/regex/export${q}`, 'GET'));
        const name = list.owner.kind === 'yours' ? 'regex-scripts' : `regex-${list.owner.name || list.owner.kind}`;
        CoreAPI.downloadBlobAsFile(new Blob([JSON.stringify(scripts, null, 2)], { type: 'application/json' }), `${name}.json`);
    } catch (e) {
        CoreAPI.showToast(e.message || 'The scripts could not be exported.', 'error');
    }
}

// ========================================
// THE WINDOW
// ========================================

function buildPanelHTML() {
    return `
    <div class="cl-cwin crx-panel" id="chatRegexPanel" aria-hidden="true">
        <aside class="cl-cwin-sheet crx-sheet" role="dialog" aria-label="Regex scripts">
            ${CoreAPI.windowGripsHtml('the regex scripts window')}
            <div class="cl-cwin-header">
                <div class="cl-cwin-title">
                    <i class="fa-solid fa-code"></i>
                    <span class="cl-cwin-name">Regex Scripts</span>
                    <span class="cl-cwin-sep" aria-hidden="true">·</span>
                    <span class="cl-cwin-meta" id="crxCount"></span>
                </div>
                <div class="cl-cwin-controls">
                    <button type="button" class="cl-cwin-btn is-close" data-crx-act="close" title="Close (Esc)" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="cl-cwin-tabs crx-tabs" role="tablist" aria-label="Which scripts">
                <button type="button" role="tab" class="cl-cwin-tab" data-crx-act="tab" data-tab="yours" aria-selected="false"><i class="fa-solid fa-user"></i><span>Yours</span></button>
                <button type="button" role="tab" class="cl-cwin-tab" data-crx-act="tab" data-tab="preset" aria-selected="false"><i class="fa-solid fa-sliders"></i><span>Preset</span></button>
                <button type="button" role="tab" class="cl-cwin-tab" data-crx-act="tab" data-tab="character" aria-selected="false"><i class="fa-solid fa-id-card"></i><span>Character</span></button>
            </div>
            <div class="cl-cwin-body crx-content" id="crxContent"></div>
        </aside>
    </div>`;
}

function injectPanel() {
    if (panelInjected) return;
    const host = document.getElementById('chatsConversation');
    if (!host) return;
    panelInjected = true;
    host.insertAdjacentHTML('beforeend', buildPanelHTML());
    const sheet = document.querySelector('.crx-sheet');
    mountChatWindow(sheet, { key: 'chatRegexPanel', close: closeWhole, min: { w: 24, h: 40 } });
    sheet.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-crx-act]');
        if (!btn || btn.disabled) return undefined;
        const i = Number(btn.dataset.i);
        const list = listOf();
        switch (btn.dataset.crxAct) {
            case 'close': return closeWhole();
            case 'tab': _tab = btn.dataset.tab; _editing = null; return render();
            case 'edit': return openEditor(i);
            case 'acts': return rowActs(e, i);
            case 'add': return openEditor(null);
            case 'back': return leaveEditor().then(ok => { if (ok) closeEditor(); });
            case 'save': return saveEditor();
            case 'allow': return list && run(() => answerConsent(list.owner, 'allowed'));
            case 'decline': return list && run(() => answerConsent(list.owner, 'declined'));
            case 'import': return pickImport();
            case 'export': return exportList();
            default: return undefined;
        }
    });
    sheet.addEventListener('change', (e) => {
        const t = e.target;
        const list = listOf();
        if (t.dataset.crxToggle !== undefined && list) {
            const i = Number(t.dataset.crxToggle);
            return run(() => saveScript(list.owner, { ...list.scripts[i], disabled: !t.checked }));
        }
        if (t.dataset.crxConsent !== undefined && list) return run(() => answerConsent(list.owner, t.checked ? 'allowed' : 'declined'));
        if (t.dataset.crxField === 'mode') {
            const mode = MODES.find(m => m.key === t.value) || MODES[3];
            document.getElementById('crxModeHint').textContent = mode.hint;
            document.getElementById('crxSavedRow').hidden = mode.key !== 'text';
        }
        if (_editing) queueTest();
        return undefined;
    });
    sheet.addEventListener('input', () => { if (_editing) queueTest(); });
    registerChatWindow('chatRegexPanel', { close: closePanel });
}

export function openPanel() {
    injectPanel();
    const panel = document.getElementById('chatRegexPanel');
    if (!panel) return;
    openChatWindow(panel, { button: 'chatConvRegex' });
    panelOpen = true;
    // the conversation has read the chat's scripts already: a source waiting for an answer opens on its own tab
    _bundle = _ctx.bundle() || _bundle;
    const waiting = waitingSources();
    if (waiting.length && _tab === 'yours') _tab = waiting[0];
    render();
    void load();
}

// back and Escape: the editor gives way to the list first, then the window closes (its X closes it all)
export function closePanel() {
    if (_editing) { void leaveEditor().then(ok => { if (ok) closeEditor(); }); return false; }
    return closeWhole();
}

async function closeWhole({ force = false } = {}) {
    if (!force && _editing && !(await leaveEditor())) return false;
    const panel = document.getElementById('chatRegexPanel');
    panelOpen = false;
    _editing = null;
    clearTimeout(_testTimer);
    closeChatWindow(panel, { button: 'chatConvRegex' });
    return true;
}

export function togglePanel() {
    if (panelOpen) closeWhole();
    else openPanel();
}

/** The conversation read the chat's scripts again (the feed, a write elsewhere): an open window shows that read, an open editor is left alone. */
export function followScripts() {
    if (!panelOpen) return;
    _bundle = _ctx.bundle();
    if (!_editing) render();
}

/** @param {{ bundle: () => object|null, refresh: () => Promise<void>, render: (text: string) => string }} ctx the conversation's scripts and its renderer */
function init(ctx) {
    if (ctx) _ctx = { ..._ctx, ...ctx };
    document.getElementById('chatConvRegex')?.addEventListener('click', togglePanel);
    document.addEventListener('cl-chat-changed', (e) => {
        const chatId = e.detail?.chatId || null;
        if (chatId === _chatId) return;
        _chatId = chatId;
        _bundle = null;
        // an editor holding changes stays on the list it belongs to; the new chat shows once it closes
        if (_editing && editorDirty()) return;
        _editing = null;
        if (!chatId) { if (panelOpen) void closeWhole({ force: true }); return; }
        if (panelOpen) void load();
    });
}

export default { init, openPanel, closePanel, togglePanel, followScripts, paintDot, waitingSources };
