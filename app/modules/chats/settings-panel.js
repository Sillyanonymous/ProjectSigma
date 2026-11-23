// Chat settings, as a window beside the conversation rather than a section in the app's
// settings modal.

import CoreAPI from '../core-api.js';
import { mountChatWindow, syncRangeFill, selectFieldHtml, syncFieldAvailability, openChatWindow, closeChatWindow, registerChatWindow } from './window.js';
import { registerFeedPatcher } from '../feed.js';
import ExtensionWindows, { isHidden, liveSpecs, onDoorsSynced, phoneHidden } from './extension-windows.js';
import HeaderLayout from './header-layout.js';

const esc = (s) => CoreAPI.escapeHtml(s);

/** The declarative field list; a new setting is a row here, never a new bespoke control. */
const FIELDS = [
    {
        group: 'Reading',
        icon: 'fa-text-width',
        note: 'The shape of the column you read in.',
        items: [
            {
                key: 'chatMeasureCh',
                label: 'Line length',
                kind: 'range',
                // The input's own min/max are the single source for the bounds the renderer clamps to.
                attrs: 'min="45" max="121" step="1"',
                fill: 121,
                hint: 'How many characters a line may reach before it wraps, whatever the window width. '
                    + 'Around 68 is where a long reply stays easiest to read. Drag to the far right for Fill, '
                    + 'which removes the cap and uses the whole window.',
            },
            {
                key: 'chatMessageFill',
                label: 'Message fill',
                kind: 'toggle',
                hint: 'Paint each message on its own plate. Off drops the plate, its outline and its shadow '
                    + 'in both layouts, leaving bare text over the backdrop.',
            },
            {
                key: 'chatBodyLayout',
                label: 'Message layout',
                kind: 'select',
                options: [
                    ['auto', 'Auto (Full Width on Mobile)'],
                    ['beside', 'Text Beside the Avatar'],
                    ['full', 'Full-Width Text'],
                ],
                hint: 'Where the text sits against the avatar. Beside keeps the classic column, which reserves '
                    + 'the avatar strip for the whole message. Full width keeps the avatar next to the name and '
                    + 'lets the text use the entire card, which wins most of a phone\'s width back.',
            },
        ],
    },
    {
        group: 'Display',
        icon: 'fa-table-columns',
        note: 'How each message is drawn, and what it carries besides the text. A change shows on the open chat at once.',
        items: [
            {
                key: 'chatDisplayMode',
                label: 'Layout',
                kind: 'select',
                options: [
                    ['banner', 'Banner'],
                    ['column', 'Column'],
                ],
                hint: 'Banner sets each message on a card of its own, the avatar and name across its top. Column drops '
                    + 'the card: the avatar and name stand on the backdrop and the text sits in a bubble under them. '
                    + 'Message layout, under Reading, places the text against the avatar in either one.',
            },
            {
                key: 'chatShowAvatars',
                label: 'Show avatars',
                kind: 'toggle',
                hint: 'The speaker\'s portrait beside every message. Off gives its column back to the text.',
            },
            {
                key: 'chatShowTimestamps',
                label: 'Timestamps',
                kind: 'toggle',
                hint: 'When each message was written, as a chip by the name: how long ago within a day, the weekday '
                    + 'and time within a week, the date after that.',
            },
            {
                key: 'chatShowMeta',
                label: 'Reply cost',
                kind: 'toggle',
                hint: 'Each message\'s number in the chat and its length in tokens: the count the model reported, or '
                    + 'an estimate where it reported none. Instrumentation, so it starts off.',
            },
            {
                key: 'chatRenderClosedThinking',
                label: 'Render closed thinking up front',
                kind: 'toggle',
                hint: 'A closed Thinking fold is filled the first time you open it, which keeps long chats quick to open. '
                    + 'On, every fold is filled as the chat opens, so the browser\'s find reaches the words inside closed '
                    + 'thinking and an extension reading the page sees them.',
            },
        ],
    },
    {
        group: 'Message text',
        icon: 'fa-quote-left',
        note: 'How a reply is read when it is turned into what you see. Rendering only; nothing here is sent to the model.',
        items: [
            {
                key: 'chatQuoteFamilies',
                label: 'Dialogue quotes',
                kind: 'select',
                options: [
                    ['default', 'Straight and Curly'],
                    ['extended', 'Add CJK and Guillemets'],
                ],
                hint: 'Which quote glyphs colour as speech. Straight and curly covers "..." and “...”. '
                    + 'The wider set adds «», 「」, 『』 and fullwidth ＂. '
                    + 'The curly apostrophe is never included, because it is nearly always an apostrophe.',
            },
            {
                key: 'chatRepairEmphasis',
                label: 'Close unfinished emphasis',
                kind: 'toggle',
                hint: 'Models drop a closing * or " constantly. With this on, one stray glyph stops italicising '
                    + 'the rest of the message.',
            },
            {
                key: 'chatRenderHtml',
                label: 'Render HTML blocks',
                kind: 'toggle',
                hint: 'Some cards and models write styled panels (status blocks, trackers) as HTML. With this on, '
                    + 'a complete block renders as intended, its styles kept to its own message; scripts and event handlers are always stripped, and comments '
                    + 'and tags that are not HTML (a preset\'s own markers) are hidden, their text kept. Off shows the raw tags.',
            },
            {
                key: 'chatEscapeStrings',
                label: 'Keep these literal',
                kind: 'text',
                attrs: 'placeholder="e.g. **, ~~, ::"',
                hint: 'Comma separated. Anything listed is shown exactly as written instead of being read as '
                    + 'markup, which is what you want when a card uses * or _ as decoration rather than emphasis.',
            },
        ],
    },
    {
        group: 'Context budget',
        icon: 'fa-gauge-high',
        note: 'The prompt is bounded by tokens and by nothing else. There is no message count and no way to '
            + 'switch this off: when a chat outgrows the budget the OLDEST turns stop being sent, and the marker '
            + 'in the transcript shows where that currently falls.',
        items: [
            {
                key: 'chatMaxContext',
                label: 'Context budget',
                kind: 'number',
                attrs: 'min="512" step="256"',
                hint: 'Total tokens the whole prompt may occupy. A connection that declares its own context size '
                    + 'overrides this, which is where it belongs, since the window is the model\'s not the chat\'s. '
                    + 'The card, its lore and its examples are never trimmed; if those alone exceed the budget you '
                    + 'get a clear error naming the size rather than a provider failure.',
            },
            {
                key: 'chatReserveForReply',
                label: 'Reserve for the reply',
                kind: 'number',
                attrs: 'min="0" step="50"',
                hint: 'Held back from the budget so the model has room to answer. Zero is allowed and means '
                    + 'hold nothing back.',
            },
        ],
    },
    {
        group: 'While you read',
        icon: 'fa-eye',
        items: [
            {
                key: 'chatStreaming',
                label: 'Show the reply as it is written',
                kind: 'toggle',
                hint: 'On, the reply and its thinking appear as they arrive. Off, the reply appears whole when it is done, '
                    + 'and its row says how long it has been thinking or writing.',
            },
            {
                key: 'chatAmbientMotion',
                label: 'Streaming caret',
                kind: 'toggle',
                hint: 'The caret at the end of a reply being written breathes slowly. Off, it holds still.',
                needs: 'chatStreaming', reason: 'Only applies while Show the reply as it is written is on.',
            },
            {
                key: 'chatSmoothStreaming',
                label: 'Smooth streaming',
                kind: 'toggle',
                needs: 'chatStreaming', reason: 'Only applies while Show the reply as it is written is on.',
                hint: 'A reply that arrives in bursts is shown word by word across the pauses, so the text can '
                    + 'trail what has arrived by up to a second. Off while your system asks for reduced motion.',
            },
            {
                key: 'chatLiveFormatting',
                label: 'Format as it streams',
                kind: 'toggle',
                needs: 'chatStreaming',
                reason: 'In the chat, only applies while Show the reply as it is written is on. The assistant and the studio still follow it where set to Same as Chat.',
                hint: 'Code blocks, HTML blocks and tables take their shape while the reply is still arriving, and the '
                    + 'thinking is formatted as it comes in. Off, they appear when the reply finishes. A block the model '
                    + 'never closes goes back to plain text at the end.',
            },
            {
                key: 'chatNotifyOnComplete',
                label: 'Flash the tab when a reply lands',
                kind: 'toggle',
                hint: 'Only while this tab is in the background, and it stops the moment you look at it. '
                    + 'A desktop notification is a separate permission this cannot grant itself.',
            },
            {
                key: 'chatPanelsExclusive',
                label: 'One panel at a time',
                kind: 'toggle',
                // absent on mobile: every panel is pinned full screen and held to one there, so it changes nothing
                desktopOnly: true,
                hint: 'Opening a panel closes the others. Off, each keeps its own size and position, so an '
                    + 'arrangement worth having is worth keeping.',
            },
        ],
    },
];

// Where everything that is NOT here actually lives.
const ELSEWHERE = [
    ['Prompt manager', 'presets, blocks and their order, and each preset\'s wording for Continue, Write My Next Message and a directed reply'],
    ['Connections', 'which endpoint answers, and its samplers'],
    ['Lorebooks', 'what this chat has bound, and every entry'],
    ['This chat\'s card', 'its own scenario, examples and main prompt'],
    ['Background', 'the wallpaper, and which chats wear it'],
    ['Assistant', 'its own model, budget and edit engines'],
];

let panelInjected = false;
let panelOpen = false;
let _onChange = null;
let _filterTerms = [];   // the find field's words, lowercased
let _owed = false;       // a write elsewhere the open window holds while the reader is in a field
let _doorsHtml = '';     // the Extensions group as last painted
let _headerHtml = '';    // the Conversation header group as last painted

const FILTER_DEBOUNCE_MS = 140;

/** A row stays while every word of the query is in its label, its hint or its group's title. */
function matches(...texts) {
    if (!_filterTerms.length) return true;
    const hay = texts.join(' ').toLowerCase();
    return _filterTerms.every(t => hay.includes(t));
}

function buildPanelHTML() {
    return `
    <div class="cl-cwin" id="chatSettingsPanel" aria-hidden="true">
        <aside class="cl-cwin-sheet" role="dialog" aria-label="Chat settings">
            ${CoreAPI.windowGripsHtml('the chat settings')}
            <div class="cl-cwin-header">
                <div class="cl-cwin-title">
                    <i class="fa-solid fa-gear"></i>
                    <span class="cl-cwin-name">Chat settings</span>
                    <span class="cl-cwin-sep">·</span>
                    <span class="cl-cwin-meta">applies everywhere</span>
                </div>
                <div class="cl-cwin-controls">
                    <button type="button" class="cl-cwin-btn is-close" data-cset-act="close" title="Close (Esc)" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="cl-cwin-filterbar">
                <i class="fa-solid fa-magnifying-glass cl-cwin-filter-icon"></i>
                <input type="search" id="cstFilter" class="cl-cwin-filter" placeholder="Find a setting" aria-label="Find a setting"
                    autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
            </div>
            <div class="cl-cwin-content" id="cstContent"></div>
        </aside>
    </div>`;
}

/** The readout beside a range, so the number is never a mystery mid-drag. */
function rangeReadout(f, v) {
    const n = Number(v);
    if (f.fill && n >= f.fill) return 'Fill';
    return Number.isFinite(n) ? String(n) : '';
}

function controlHtml(f) {
    const v = CoreAPI.getSetting(f.key);
    if (f.kind === 'toggle') {
        // the label is the row: the whole width is the target and the switches line up in one column
        return `<label class="cl-cwin-field cl-cwin-toggle">
            <span class="cl-cwin-field-label">${esc(f.label)}</span>
            <input type="checkbox" class="cl-switch-input" data-set="${esc(f.key)}" ${v === false ? '' : 'checked'}>
            <span class="cl-switch" aria-hidden="true"></span>
        </label>`;
    }
    if (f.kind === 'range') {
        return `<div class="cl-cwin-field">
            <label class="cl-cwin-field-label" for="cstSet_${esc(f.key)}">${esc(f.label)}</label>
            <span class="cl-cwin-range-wrap">
                <input type="range" id="cstSet_${esc(f.key)}" class="cl-range cl-cwin-range" data-set="${esc(f.key)}" ${f.attrs || ''} value="${esc(v ?? '')}">
                <span class="cl-cwin-readout" data-readout="${esc(f.key)}">${esc(rangeReadout(f, v))}</span>
            </span>
        </div>`;
    }
    if (f.kind === 'select') return selectFieldHtml({ id: `cstSet_${f.key}`, key: f.key, label: f.label, options: f.options, value: v });
    if (f.kind === 'number') {
        return `<div class="cl-cwin-field">
            <label class="cl-cwin-field-label" for="cstSet_${esc(f.key)}">${esc(f.label)}</label>
            <input type="number" id="cstSet_${esc(f.key)}" class="cl-cwin-input cl-cwin-field-control cl-cwin-num"
                data-set="${esc(f.key)}" ${f.attrs || ''} value="${esc(v ?? '')}">
        </div>`;
    }
    if (f.kind === 'textarea') {
        return `<label class="cl-cwin-label" for="cstSet_${esc(f.key)}">${esc(f.label)}</label>
        <textarea id="cstSet_${esc(f.key)}" class="cl-cwin-input cl-cwin-textarea" data-set="${esc(f.key)}"
            ${f.attrs || ''}>\n${esc(v ?? '')}</textarea>`;
    }
    return `<label class="cl-cwin-label" for="cstSet_${esc(f.key)}">${esc(f.label)}</label>
    <input type="search" id="cstSet_${esc(f.key)}" class="cl-cwin-input" data-set="${esc(f.key)}"
        ${f.attrs || ''} value="${esc(v ?? '')}" autocomplete="off">`;
}

// one extension window's switch for its phone Windows tile, app-wide; its desktop opener is the header's arrangement
function extWindowRowHtml(spec) {
    const phone = `<label class="cl-cwin-ext-scope">
            <span>Phone</span>
            <input type="checkbox" class="cl-switch-input" data-ext-scope="phone" data-ext-key="${esc(spec.key)}" ${isHidden(spec.key) ? '' : 'checked'}>
            <span class="cl-switch" aria-hidden="true"></span>
        </label>`;
    return `<div class="cl-cwin-block cl-cwin-ext-window">
        <div class="cl-cwin-field cl-cwin-ext-row">
            <span class="cl-cwin-field-label cl-cwin-ext-id" title="${esc(spec.label)} (${esc(spec.extName)})"><i class="fa-solid ${esc(spec.icon)}"></i><span class="cl-cwin-ext-name">${esc(spec.label)}</span><small class="cl-cwin-ext-owner">${esc(spec.extName)}</small></span>
            <span class="cl-cwin-ext-scopes">${phone}</span>
        </div>
    </div>`;
}

// Built from the registry at every render, never cached: an extension enabled after the
// window opened is on the list the next time it renders.
function extensionsGroupHtml() {
    const specs = liveSpecs();
    const title = 'Extensions';
    const shown = specs.filter(s => matches(title, s.label, s.extName));
    // under a query the group goes unless a window matched, or its title did with no window to show
    if (!shown.length && (specs.length || !matches(title))) return '';
    return `<section class="cl-cwin-group cl-cwin-extensions">
        <h4 class="cl-cwin-group-title"><i class="fa-solid fa-puzzle-piece"></i>${title}</h4>
        <p class="cl-cwin-group-note">Which extension windows keep a tile under Windows in the phone's chat options. Their buttons in the desktop header are under Conversation header.</p>
        <div class="cl-cwin-fields">
            ${shown.length ? shown.map(extWindowRowHtml).join('') : '<p class="cl-cwin-hint">No extension has added a chat window.</p>'}
        </div>
    </section>`;
}

// one header opener, group or divider: a group's members indented under it, dimmed while it is hidden
function headerRowHtml(r, { member = false, groupHidden = false } = {}) {
    if (r.kind === 'divider') {
        return `<div class="cl-cwin-block cl-cwin-head-divider${member ? ' is-member' : ''}">
            <span class="cl-cwin-field-label"><i class="fa-solid fa-grip-lines-vertical"></i><span>Divider</span></span>
            <button type="button" class="cl-cwin-btn-text" data-head-remove="${esc(r.id)}" title="Remove the divider" aria-label="Remove the divider"><i class="fa-solid fa-xmark"></i></button>
        </div>`;
    }
    const off = member && groupHidden;
    const tag = r.kind === 'group' ? 'Group' : r.owner;
    return `<div class="cl-cwin-block cl-cwin-head-row${member ? ' is-member' : ''}">
        <label class="cl-cwin-field cl-cwin-toggle${off ? ' is-off' : ''}"${off ? ' title="Its group is hidden"' : ''}>
            <span class="cl-cwin-field-label cl-cwin-ext-id"><i class="fa-solid ${esc(r.icon)}"></i><span class="cl-cwin-ext-name">${esc(r.label)}</span>${tag ? `<small class="cl-cwin-ext-owner">${esc(tag)}</small>` : ''}</span>
            <input type="checkbox" class="cl-switch-input" data-head-item="${esc(r.id)}" aria-label="Show ${esc(r.label)}" ${r.hidden ? '' : 'checked'}${off ? ' disabled' : ''}>
            <span class="cl-switch" aria-hidden="true"></span>
        </label>
    </div>`;
}

// the desktop header's openers in their order, each with a show switch; built from the header at every render
function headerGroupHtml() {
    if (document.documentElement.classList.contains('cl-mobile')) return '';
    const title = 'Conversation header';
    const rows = HeaderLayout.headerRows();
    // under a query: the openers it names, a group with its members when it or one of them is named
    const named = (r) => matches(title, r.label);
    const filtered = _filterTerms.length ? rows.flatMap((r) => {
        if (r.kind === 'divider') return [];
        if (r.kind === 'group') { const items = r.items.filter(m => m.kind === 'item' && named(m)); return named(r) || items.length ? [{ ...r, items: named(r) ? r.items : items }] : []; }
        return named(r) ? [r] : [];
    }) : rows;
    if (!filtered.length && (_filterTerms.length || !rows.length)) return '';
    const body = filtered.map(r => (r.kind === 'group'
        ? headerRowHtml(r) + r.items.map(m => headerRowHtml(m, { member: true, groupHidden: r.hidden })).join('')
        : headerRowHtml(r))).join('');
    return `<section class="cl-cwin-group cl-cwin-head-arrange">
        <h4 class="cl-cwin-group-title"><i class="fa-solid fa-window-maximize"></i>${title}</h4>
        <p class="cl-cwin-group-note">Drag buttons in the header to reorder them, drop one on a group to file it, and right-click the header for the rest. A switch turned off hides its button.</p>
        <div class="cl-cwin-fields">${body}</div>
        <div class="cl-cwin-head-foot"><button type="button" class="cl-cwin-btn-text" data-head-reset${HeaderLayout.isDefault() ? ' disabled' : ''}><i class="fa-solid fa-rotate-left"></i> Reset Header</button></div>
    </section>`;
}

function elsewhereGroupHtml() {
    const title = 'Lives in its own window';
    const rows = ELSEWHERE.filter(([where, what]) => matches(title, where, what));
    if (!rows.length) return '';
    return `<section class="cl-cwin-group cl-cwin-elsewhere">
        <h4 class="cl-cwin-group-title"><i class="fa-solid fa-window-restore"></i>${title}</h4>
        <ul class="cl-cwin-elsewhere-list">
            ${rows.map(([where, what]) => `<li><strong>${esc(where)}</strong><span>${esc(what)}</span></li>`).join('')}
        </ul>
    </section>`;
}

function fieldGroupHtml({ g, items }) {
    return `<section class="cl-cwin-group">
        <h4 class="cl-cwin-group-title"><i class="fa-solid ${esc(g.icon)}"></i>${esc(g.group)}</h4>
        ${g.note ? `<p class="cl-cwin-group-note">${esc(g.note)}</p>` : ''}
        <div class="cl-cwin-fields">
            ${items.map(f => `<div class="cl-cwin-block">${controlHtml(f)}<p class="cl-cwin-hint">${esc(f.hint)}</p></div>`).join('')}
        </div>
    </section>`;
}

/** Persist one window's switch: the key joins or leaves the phone's hidden list. */
function onExtToggle(el) {
    const key = el.dataset.extKey;
    if (!key) return;
    const next = phoneHidden();
    if (el.checked) next.delete(key); else next.add(key);
    CoreAPI.setSetting('chatExtHiddenPhone', [...next]);
    // the phone's tiles read the set when its options sheet next opens
    ExtensionWindows.syncWindows();
}

function render() {
    const content = document.getElementById('cstContent');
    if (!content) return;
    _owed = false;
    // a field that cant change the outcome isnt rendered; read at render so a viewport flip is honoured
    const mobile = document.documentElement.classList.contains('cl-mobile');
    const shown = (f) => !(f.desktopOnly && mobile);

    _doorsHtml = extensionsGroupHtml();
    _headerHtml = headerGroupHtml();
    const groups = [
        ...FIELDS.map(g => ({ g, items: g.items.filter(f => shown(f) && matches(g.group, f.label, f.hint)) }))
            .filter(x => x.items.length).map(fieldGroupHtml),
        _headerHtml,
        _doorsHtml,
        elsewhereGroupHtml(),
    ].filter(Boolean);
    content.innerHTML = groups.length ? groups.join('')
        : '<div class="cl-cwin-empty"><i class="fa-solid fa-magnifying-glass"></i><p>No setting matches that.</p></div>';
    document.getElementById('cstFilter')?.classList.toggle('is-empty', !groups.length);
    syncRangeFill(content);
    // Every select is the canonical custom control; the raw element stays hidden inside
    // as the value holder the delegated data-set listener still hears change from.
    content.querySelectorAll('select').forEach(s => CoreAPI.initCustomSelect(s));
    syncFieldNeeds(content);
}

// a field another switch decides is greyed, its reason in the hint and the tooltip, while that switch is off
function syncFieldNeeds(content = document.getElementById('cstContent')) {
    if (!content) return;
    for (const f of FIELDS.flatMap(g => g.items)) {
        if (!f.needs) continue;
        const v = CoreAPI.getSetting(f.needs);
        const on = CoreAPI.getDefaultSetting(f.needs) === true ? v !== false : v === true;
        syncFieldAvailability(content.querySelector(`[data-set="${f.key}"]`), { on, hint: f.hint, reason: f.reason });
    }
}

/** Persist one control. Everything here is app-wide, which the header says out loud. */
function onSettingInput(el) {
    const key = el.dataset.set;
    if (!key) return;
    if (el.type === 'checkbox') { CoreAPI.setSetting(key, el.checked); }
    else if (el.type === 'range') { CoreAPI.setSetting(key, Number(el.value)); }
    else if (el.type === 'number') {
        // blank or junk never stores 0 (that is the unlimited this model removes): the default goes back on screen
        const n = Number(el.value);
        const min = Number(el.min) || 0;
        const next = Number.isFinite(n) && n >= min ? Math.round(n) : Number(CoreAPI.getDefaultSetting(key));
        CoreAPI.setSetting(key, next);
        el.value = String(next);
    } else { CoreAPI.setSetting(key, el.value); }
    if (FIELDS.some(g => g.items.some(f => f.needs === key))) syncFieldNeeds();
    // The conversation decides what a change means; that knowledge lives beside the renderer.
    _onChange?.(key);
}

// the keys the window's fields show; the Extensions group follows the window host (paintDoors)
const SHOWN_KEYS = new Set(FIELDS.flatMap(g => g.items.map(f => f.key)));

// the reader's hands in the form: a focused control, or a converted select's list open
function held() {
    const content = document.getElementById('cstContent');
    const a = document.activeElement;
    return !!content && ((!!a && content.contains(a)) || !!content.querySelector('.custom-select-trigger[aria-expanded="true"]'));
}

// a setting written in another tab, after the shell adopted it: the open window paints it, never under the reader's hands
function patchSettingsFromFeed(records) {
    if (!panelOpen) return;
    if (records && !records.some(r => r.all || (r.ids || []).some(k => SHOWN_KEYS.has(k) || k === 'chatHeaderLayout'))) return;
    if (held()) { _owed = true; return; }
    render();
}

// the window host laid its doors out again: the open window paints its Extensions group when that moved, held the same way
function paintDoors() {
    if (!panelOpen || extensionsGroupHtml() === _doorsHtml) return;
    if (held()) { _owed = true; return; }
    render();
}

// the header arranged again (here, in another tab, an extension come or gone): the open window paints its group, held the same way
function paintHeader() {
    if (!panelOpen || headerGroupHtml() === _headerHtml) return;
    if (held()) { _owed = true; return; }
    render();
}

// what a held write owes the window, paid once the reader has left the form
function paintOwed() {
    if (_owed && panelOpen && !held()) render();
}

function injectPanel() {
    if (panelInjected) return;
    const host = document.getElementById('chatsConversation');
    if (!host) return;
    panelInjected = true;
    host.insertAdjacentHTML('beforeend', buildPanelHTML());

    const sheet = document.querySelector('#chatSettingsPanel .cl-cwin-sheet');
    mountChatWindow(sheet, { key: 'chatSettingsPanel', close: closePanel, min: { w: 22, h: 30 } });

    sheet?.addEventListener('click', (e) => {
        if (e.target.closest('[data-cset-act="close"]')) closePanel();
        const remove = e.target.closest('[data-head-remove]');
        if (remove) HeaderLayout.removeDivider(remove.dataset.headRemove);
        if (e.target.closest('[data-head-reset]')) void HeaderLayout.resetHeader();
    });

    // 'change' rather than 'input': a text field written on every keystroke would issue a
    // settings write per character, and a checkbox fires change immediately anyway.
    sheet?.addEventListener('change', (e) => {
        if (e.target?.dataset?.set) onSettingInput(e.target);
        else if (e.target?.dataset?.extScope) onExtToggle(e.target);
        else if (e.target?.dataset?.headItem) HeaderLayout.setHidden(e.target.dataset.headItem, !e.target.checked);
    });

    // after the focus has landed, so a move between two fields of the form still holds
    document.getElementById('cstContent')?.addEventListener('focusout', () => setTimeout(paintOwed, 0));

    // a range's readout tracks the thumb on input; the write still waits for change
    sheet?.addEventListener('input', (e) => {
        const el = e.target;
        if (el?.type !== 'range' || !el.dataset.set) return;
        const f = FIELDS.flatMap(g => g.items).find(x => x.key === el.dataset.set);
        const out = sheet.querySelector(`[data-readout="${el.dataset.set}"]`);
        if (f && out) out.textContent = rangeReadout(f, el.value);
    });

    // debounced, and read from the field so a fast typist cant land an older query last
    const field = document.getElementById('cstFilter');
    field?.addEventListener('input', CoreAPI.debounce(() => {
        const next = String(field.value || '').toLowerCase().split(/\s+/).filter(Boolean);
        if (next.join(' ') === _filterTerms.join(' ')) return;
        _filterTerms = next;
        render();
    }, FILTER_DEBOUNCE_MS));

    registerChatWindow('chatSettingsPanel', { close: closePanel });
    document.addEventListener('cl-header-arranged', paintHeader);
}

/** @param {{onChange?: (key: string) => void}} ctx the conversation's apply hook */
export function openPanel(ctx) {
    if (ctx && 'onChange' in ctx) _onChange = ctx.onChange;
    injectPanel();
    const panel = document.getElementById('chatSettingsPanel');
    if (!panel) return;
    openChatWindow(panel, { button: 'chatConvSettings' });
    panelOpen = true;
    render();
}

export function closePanel() {
    const panel = document.getElementById('chatSettingsPanel');
    panelOpen = false;
    closeChatWindow(panel, { button: 'chatConvSettings' });
}

export function togglePanel(ctx) {
    if (panelOpen) closePanel();
    else openPanel(ctx);
}

function init() {
    registerFeedPatcher('setting', patchSettingsFromFeed);
    onDoorsSynced(paintDoors);
}

export { FIELDS };
export default { init, openPanel, closePanel, togglePanel };
