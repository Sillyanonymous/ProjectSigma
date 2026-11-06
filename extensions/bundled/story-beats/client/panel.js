// SPDX-License-Identifier: MIT

// The Story Beats window's body: the open chat's beats as a timeline, the planner that drafts new ones, and the log.
import { WEIGHTS, TITLE_MAX, DIRECTIVE_MAX, NOTES_MAX, BEAT_LIMITS, beatCount } from './limits.js';

const POLL_MS = 2000;
const SOON_MS = 400;
const COMMIT_ASK = 'Looks good. Commit the current outline as beats now.';
// the filters, and the groups each one shows in the timeline
const FILTERS = [['all', 'All'], ['active', 'Active'], ['pending', 'Pending'], ['satisfied', 'Done'], ['skipped', 'Skipped']];
const GROUPS = [['suggested', 'Suggested'], ['active', 'Active'], ['pending', 'Pending'], ['satisfied', 'Done'], ['skipped', 'Skipped']];
const SHOWS = { all: ['suggested', 'active', 'pending', 'satisfied', 'skipped'], active: ['suggested', 'active'], pending: ['pending'], satisfied: ['satisfied'], skipped: ['skipped'] };
const NONE_WORDS = { active: 'No beat is active.', pending: 'No beat is pending.', satisfied: 'No beat is done yet.', skipped: 'No beat was skipped.' };
const WEIGHT_WORDS = { soft: 'Soft (consider)', firm: 'Firm (should)', hard: 'Hard (must)' };
const WEIGHT_SHORT = { soft: 'Soft', firm: 'Firm', hard: 'Hard' };
const STRATEGY_WORDS = { adaptive: 'adaptive', 'time-gated': 'time-gated', strict: 'strict' };
const ACTION_WORDS = { active: 'started', pending: 'back to pending', satisfied: 'satisfied', skipped: 'skipped', faded: 'softened' };
const REASON_WORDS = { next: 'with Next', forced: 'forced' };

const titleOf = (b) => (b?.title?.trim() ? b.title.trim() : '(untitled)');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const timeOf = (at) => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// a beat's verbs as its status allows, one list: the row draws it, the phone's sheet lists it
function verbsFor(b) {
    const out = [b.status === 'active' ? ['satisfy', 'fa-check', 'Mark satisfied']
        : b.waitsOn.length ? ['force', 'fa-play', 'Start anyway']
            : ['activate', 'fa-play', b.status === 'suggested' ? 'Accept' : 'Start']];
    if (b.status !== 'skipped') out.push(['skip', 'fa-forward', 'Skip']);
    if (b.status !== 'pending') out.push(['reset', 'fa-rotate-left', 'Back to pending']);
    out.push(['delete', 'fa-trash', 'Delete', true]);
    return out;
}

export function mountBeats(bodyEl, ctx, api) {
    const { CoreAPI } = ctx;
    const esc = (v) => CoreAPI.escapeHtml(v);

    bodyEl.innerHTML = `
        <div class="sb">
            <div class="cl-cwin-tabs sb-views" data-sb-views role="tablist" aria-label="Story Beats">
                <button type="button" class="cl-cwin-tab is-on" role="tab" aria-selected="true" data-sb-view="beats"><i class="fa-solid fa-list-check" aria-hidden="true"></i><span>Beats</span></button>
                <button type="button" class="cl-cwin-tab" role="tab" aria-selected="false" data-sb-view="plan"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>Plan</span></button>
                <button type="button" class="cl-cwin-tab" role="tab" aria-selected="false" data-sb-view="log"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i><span>Log</span></button>
            </div>
            <section class="sb-pane" data-sb-pane="beats">
                <div class="sb-seg" data-sb-filters role="tablist" aria-label="Show"></div>
                <div class="sb-director" data-sb-director></div>
                <div class="sb-list" data-sb-list></div>
                <div class="sb-foot">
                    <div class="sb-foot-group">
                        <label class="sb-switch">
                            <input type="checkbox" class="cl-switch-input" data-sb-director-on><span class="cl-switch" aria-hidden="true"></span>
                            <span>Director</span>
                        </label>
                        <button type="button" class="cl-cwin-btn-text sb-btn" data-sb="direct" title="Have the director read the chat now"><i class="fa-solid fa-bolt" aria-hidden="true"></i><span>Run Director Now</span></button>
                    </div>
                    <div class="sb-foot-group is-end">
                        <button type="button" class="cl-cwin-btn-text sb-btn" data-sb="next" title="Start the next pending beat"><i class="fa-solid fa-forward-step" aria-hidden="true"></i><span>Next</span></button>
                        <button type="button" class="cl-cwin-btn-text is-primary sb-btn" data-sb="add"><i class="fa-solid fa-plus" aria-hidden="true"></i><span>Add Beat</span></button>
                    </div>
                </div>
            </section>
            <section class="sb-pane" data-sb-pane="plan" hidden>
                <div class="sb-seg" role="tablist" aria-label="How to plan">
                    <button type="button" class="sb-seg-btn is-on" role="tab" aria-selected="true" data-sb-mode="list"><i class="fa-solid fa-list-ul" aria-hidden="true"></i><span>Quick List</span></button>
                    <button type="button" class="sb-seg-btn" role="tab" aria-selected="false" data-sb-mode="discuss"><i class="fa-solid fa-comments" aria-hidden="true"></i><span>Discuss</span></button>
                </div>
                <div class="sb-plan" data-sb-mode-pane="list">
                    <p class="cl-cwin-dim">Your notes for what comes next, a moment a line or as they come: your model turns them into beats you can change before adding.</p>
                    <textarea class="cl-cwin-input sb-notes" data-sb-notes rows="6" maxlength="${NOTES_MAX}" aria-label="Notes" placeholder="They meet at the station, awkward&#10;A misunderstanding about the letter&#10;He apologizes during the storm"></textarea>
                    <div class="sb-row-verbs">
                        <span class="sb-plan-status" data-sb-list-status role="status" aria-live="polite"></span>
                        <button type="button" class="cl-cwin-btn-text sb-btn" data-sb="stop-draft" hidden>Cancel</button>
                        <button type="button" class="cl-cwin-btn-text is-primary sb-btn" data-sb="draft"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>Draft Beats</span></button>
                    </div>
                </div>
                <div class="sb-plan" data-sb-mode-pane="discuss" hidden>
                    <label class="sb-switch">
                        <input type="checkbox" class="cl-switch-input" data-sb-context><span class="cl-switch" aria-hidden="true"></span>
                        <span>Share the story so far and the beats</span>
                    </label>
                    <div class="sb-talk" data-sb-talk></div>
                    <div class="cl-cwin-input-row sb-say-row">
                        <textarea rows="1" data-sb-say maxlength="${NOTES_MAX}" aria-label="Your message" placeholder="Where should the story go?"></textarea>
                        <button type="button" class="cl-cwin-send" data-sb="say" title="Send" aria-label="Send"><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button>
                        <button type="button" class="cl-cwin-send is-stop" data-sb="stop-talk" title="Stop" aria-label="Stop" hidden><i class="fa-solid fa-stop" aria-hidden="true"></i></button>
                    </div>
                    <div class="sb-row-verbs">
                        <button type="button" class="cl-cwin-btn-text sb-btn" data-sb="restart" title="Start the conversation over"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i><span>Start Over</span></button>
                        <button type="button" class="cl-cwin-btn-text sb-btn" data-sb="commit" title="Ask the planner for the outline as beats"><i class="fa-solid fa-check-double" aria-hidden="true"></i><span>Commit the Outline</span></button>
                    </div>
                </div>
                <div class="sb-drafts" data-sb-drafts hidden></div>
            </section>
            <section class="sb-pane" data-sb-pane="log" hidden>
                <div class="sb-log-head">
                    <span class="sb-log-state" data-sb-log-state></span>
                    <button type="button" class="cl-cwin-btn-text sb-btn" data-sb="clear-log" title="Empty this chat's log; the beats stay"><i class="fa-solid fa-eraser" aria-hidden="true"></i><span>Clear</span></button>
                </div>
                <ol class="sb-log" data-sb-log></ol>
            </section>
            <div class="cl-cwin-empty" data-sb-empty hidden><i class="fa-solid fa-list-check" aria-hidden="true"></i><p data-sb-empty-text></p></div>
        </div>`;
    const $ = (sel) => bodyEl.querySelector(sel);
    const list = $('[data-sb-list]');

    let chatId = null;
    let data = null;
    let pane = 'beats';
    let filter = 'all';
    let open = null;
    let owed = false;
    let log = null;
    // the planner's state per chat: an answer that lands after the chat moved on lands in its own chat
    const plans = new Map();
    const planOf = (id) => plans.get(id) || plans.set(id, { mode: 'list', notes: '', history: [], context: false, drafts: [], said: '', cut: null, dropped: null, note: '', running: null }).get(id);
    // what the last answer did not deliver: the cut, the beat it left half-written, what it said when no beat was read
    const unsay = (p) => Object.assign(p, { said: '', cut: null, dropped: null });
    const told = (p, out) => Object.assign(p, { cut: out.cut || null, dropped: typeof out.dropped === 'string' ? out.dropped : null });

    const follow = ctx.chats.follow({
        read: (id) => api.read(id),
        moved: (id) => {
            chatId = id;
            data = null;
            log = null;
            open = null;
            owed = false;
            paint();
        },
        apply: (next) => {
            data = next;
            paint();
            if (pane === 'log' && next) void readLog();
        },
        fail: (e) => { data = { error: e.message }; paint(); },
        working: (next) => !!next?.director?.working,
        soonMs: SOON_MS,
        pollMs: POLL_MS,
    });

    // ---------------------------------------------------------------- painting

    // the reader's hands in an open editor: the timeline waits until they leave it
    const held = () => {
        const a = typeof document !== 'undefined' ? document.activeElement : null;
        return !!(a && a.closest?.('.sb-edit') && list.contains(a));
    };

    function paint() {
        const blank = !chatId ? 'Open a chat to plan its story beats.' : data?.error ? `The beats could not be read: ${data.error}` : !data ? 'Reading the beats...' : null;
        const empty = $('[data-sb-empty]');
        empty.hidden = !blank;
        empty.classList.toggle('is-error', !!data?.error);
        $('[data-sb-empty-text]').textContent = blank || '';
        $('[data-sb-views]').hidden = !!blank;
        for (const p of bodyEl.querySelectorAll('[data-sb-pane]')) p.hidden = !!blank || p.dataset.sbPane !== pane;
        for (const t of bodyEl.querySelectorAll('[data-sb-view]')) {
            t.classList.toggle('is-on', t.dataset.sbView === pane);
            t.setAttribute('aria-selected', String(t.dataset.sbView === pane));
        }
        if (blank) return;
        if (pane === 'beats') paintBeats();
        else if (pane === 'plan') paintPlan();
        else paintLog();
    }

    function paintBeats() {
        const { beats, counts, director } = data;
        const shown = (f) => SHOWS[f].reduce((n, s) => n + counts[s], 0);
        $('[data-sb-filters]').innerHTML = FILTERS.map(([key, word]) => `
            <button type="button" class="sb-seg-btn${key === filter ? ' is-on' : ''}" role="tab" aria-selected="${key === filter}" data-sb-filter="${key}"><span>${word}</span><span class="sb-seg-count">${shown(key)}</span></button>`).join('');
        const on = ctx.settings.get('director') === true;
        const [glyph, words] = director.working
            ? ['fa-spinner fa-spin', director.working === 'running' ? 'The director is reading the chat' : 'The director will read the chat next']
            : on ? ['fa-clapperboard', `Director on: ${esc(STRATEGY_WORDS[director.strategy] || 'adaptive')}, every ${esc(plural(director.every, 'reply', 'replies'))}`]
                : ['fa-clapperboard', 'Director off: the beats start and finish when you say so'];
        const tension = typeof director.tension === 'number' ? `<span class="sb-tension" title="How tense the director read the story at its last change">Tension ${Math.round(director.tension * 100)}%</span>` : '';
        $('[data-sb-director]').innerHTML = `
            <div class="sb-director-line${director.working ? ' is-busy' : on ? ' is-on' : ''}">
                <i class="fa-solid ${glyph}" aria-hidden="true"></i><span class="sb-director-state">${words}</span>${tension}
            </div>
            ${director.failed ? `<p class="sb-note is-error"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><span>The last pass failed: ${esc(director.failed)}</span></p>` : ''}
            ${director.summary && !director.failed ? `<p class="sb-summary">${esc(director.summary)}</p>` : ''}`;
        $('[data-sb-director-on]').checked = on;
        bodyEl.querySelector('[data-sb="direct"]').disabled = !!director.working || !(counts.active + counts.pending);
        bodyEl.querySelector('[data-sb="next"]').disabled = !counts.pending;
        if (held()) { owed = true; return; }
        owed = false;
        const groups = GROUPS.filter(([status]) => SHOWS[filter].includes(status)).map(([status, word]) => [status, word, beats.filter(b => b.status === status)]).filter(([, , items]) => items.length);
        // a groups name says something only beside another group, or under All
        const titled = filter === 'all' || groups.length > 1;
        list.innerHTML = groups.length
            ? groups.map(([status, word, items]) => `
                <section class="sb-group" data-sb-group="${status}">
                    ${titled ? `<h5 class="sb-group-title">${word}</h5>` : ''}
                    <ol class="sb-beats">${items.map(b => rowHtml(b, items.length > 1)).join('')}</ol>
                </section>`).join('')
            : beats.length
                ? `<div class="cl-cwin-empty"><i class="fa-solid fa-list-check" aria-hidden="true"></i><p>${NONE_WORDS[filter] || 'No beat here.'}</p></div>`
                : `<div class="cl-cwin-empty">
                    <i class="fa-solid fa-list-check" aria-hidden="true"></i>
                    <p class="sb-empty-lead">No beats yet</p>
                    <p class="cl-cwin-dim">A beat is a moment the story should reach. Add one, or let the planner draft them from your notes.</p>
                    <button type="button" class="cl-cwin-btn-text sb-btn" data-sb-view="plan"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>Open the Planner</span></button>
                </div>`;
        for (const s of list.querySelectorAll('select[data-sb-field]')) CoreAPI.initCustomSelect(s);
    }

    // one beat: the grip, its title, its weight and its verbs on a line, what it says under them
    function rowHtml(b, movable) {
        const editing = open === b.id;
        const waits = b.waitsOn.map(id => titleOf(data.beats.find(x => x.id === id)));
        const weight = `${b.weight}${b.faded ? ', fading' : ''}`;
        const drags = movable && !editing;
        return `
            <li class="cl-cwin-row sb-beat${b.status === 'active' ? ' is-active' : ''}${editing ? ' is-editing' : ''}" data-sb-beat="${esc(b.id)}" draggable="${drags}">
                <div class="sb-beat-head">
                    <span class="sb-grip${drags ? '' : ' is-still'}" title="Drag to reorder" aria-hidden="true"><i class="fa-solid fa-grip-vertical"></i></span>
                    <button type="button" class="sb-beat-open" data-sb="toggle" aria-expanded="${editing}" title="${editing ? 'Close the editor' : 'Edit this beat'}">
                        <i class="fa-solid fa-chevron-right sb-chevron" aria-hidden="true"></i>
                        <span class="sb-beat-title">${esc(titleOf(b))}</span>
                    </button>
                    <span class="cl-cwin-tag${b.weight === 'soft' ? '' : ' is-accent'}">${esc(weight)}</span>
                    <span class="sb-acts">${verbsFor(b).map(([act, icon, word, danger]) => `
                        <button type="button" class="sb-act${danger ? ' is-danger' : ''}" data-sb="${act}" title="${word}" aria-label="${word}"><i class="fa-solid ${icon}" aria-hidden="true"></i></button>`).join('')}
                    </span>
                    <button type="button" class="sb-act sb-kebab" data-sb="acts" title="Actions" aria-label="Actions for ${esc(titleOf(b))}" aria-haspopup="true"><i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i></button>
                </div>
                ${b.directive.trim() && !editing ? `<p class="sb-directive">${esc(b.directive)}</p>` : ''}
                ${b.status === 'suggested' ? `
                    <div class="sb-suggest">
                        <p class="sb-note"><i class="fa-solid fa-clapperboard" aria-hidden="true"></i><span>The director suggests starting it${b.suggestion ? `: ${esc(b.suggestion)}` : '.'}</span></p>
                        <div class="sb-row-verbs">
                            <button type="button" class="cl-cwin-btn-text sb-btn" data-sb="dismiss"><i class="fa-solid fa-xmark" aria-hidden="true"></i><span>Dismiss</span></button>
                            <button type="button" class="cl-cwin-btn-text sb-btn" data-sb="accept"><i class="fa-solid fa-check" aria-hidden="true"></i><span>Accept</span></button>
                        </div>
                    </div>` : ''}
                ${waits.length && (b.status === 'pending' || editing) ? `<p class="sb-waits"><i class="fa-solid fa-link" aria-hidden="true"></i><span>Waits for ${esc(waits.join(', '))}</span></p>` : ''}
                ${editing ? editorHtml(b) : ''}
            </li>`;
    }

    // the open beat's fields, on the window family's form rows; a field is kept once the reader leaves it
    function editorHtml(b) {
        const others = data.beats.filter(x => x.id !== b.id);
        const id = (key) => `sb-${esc(b.id)}-${key}`;
        const counter = (key, word) => `
            <div class="cl-cwin-field">
                <label class="cl-cwin-field-label" for="${id(key)}">${word}</label>
                <input type="number" id="${id(key)}" class="cl-cwin-input cl-cwin-field-control cl-cwin-num" data-sb-field="${key}" min="${BEAT_LIMITS[key][0]}" max="${BEAT_LIMITS[key][1]}" step="1" value="${esc(b[key])}">
            </div>`;
        return `
            <div class="sb-edit">
                <div class="sb-field">
                    <label class="cl-cwin-label" for="${id('title')}">Title</label>
                    <input type="search" autocomplete="one-time-code" id="${id('title')}" class="cl-cwin-input" data-sb-field="title" maxlength="${TITLE_MAX}" value="${esc(b.title)}" placeholder="A short name for the moment">
                </div>
                <div class="sb-field">
                    <label class="cl-cwin-label" for="${id('directive')}">Directive</label>
                    <textarea id="${id('directive')}" class="cl-cwin-input cl-cwin-textarea" data-sb-field="directive" rows="3" maxlength="${DIRECTIVE_MAX}" placeholder="What should happen, as guidance for the storyteller">\n${esc(b.directive)}</textarea>
                </div>
                <div class="cl-cwin-field">
                    <label class="cl-cwin-field-label" for="${id('weight')}">Weight</label>
                    <select id="${id('weight')}" class="cl-select-fluid cl-cwin-field-control" data-sb-field="weight">${WEIGHTS.map(w => `<option value="${w}"${w === b.weight ? ' selected' : ''}>${WEIGHT_WORDS[w]}</option>`).join('')}</select>
                </div>
                ${counter('fadeAfter', 'Softens after')}
                ${counter('maxMessages', 'Skipped after')}
                <p class="cl-cwin-hint">Both count the messages while the beat is active; 0 is never.</p>
                ${others.length ? `
                    <div class="sb-field">
                        <span class="cl-cwin-label">Waits for</span>
                        <div class="sb-deps">${others.map(o => `
                            <label class="cl-cwin-field cl-cwin-toggle sb-dep">
                                <span class="cl-cwin-field-label">${esc(titleOf(o))}</span>
                                <input type="checkbox" class="cl-switch-input" data-sb-dep="${esc(o.id)}"${b.dependsOn.includes(o.id) ? ' checked' : ''}><span class="cl-switch" aria-hidden="true"></span>
                            </label>`).join('')}
                        </div>
                    </div>` : ''}
                <div class="sb-row-verbs">
                    <button type="button" class="cl-cwin-btn-text sb-btn" data-sb="toggle"><i class="fa-solid fa-check" aria-hidden="true"></i><span>Done</span></button>
                </div>
            </div>`;
    }

    // ---------------------------------------------------------------- the planner

    function paintPlan() {
        const p = planOf(chatId);
        for (const t of bodyEl.querySelectorAll('[data-sb-mode]')) {
            t.classList.toggle('is-on', t.dataset.sbMode === p.mode);
            t.setAttribute('aria-selected', String(t.dataset.sbMode === p.mode));
        }
        for (const el of bodyEl.querySelectorAll('[data-sb-mode-pane]')) el.hidden = el.dataset.sbModePane !== p.mode;
        const notes = $('[data-sb-notes]');
        if (notes.value !== p.notes) notes.value = p.notes;
        const running = p.running?.mode;
        $('[data-sb-list-status]').textContent = running === 'list' ? 'Drafting...' : p.note;
        bodyEl.querySelector('[data-sb="draft"]').disabled = !!p.running;
        // one solid verb a surface: with drafts waiting, Add to the Chat is it
        bodyEl.querySelector('[data-sb="draft"]').classList.toggle('is-primary', !p.drafts.length);
        bodyEl.querySelector('[data-sb="stop-draft"]').hidden = running !== 'list';
        $('[data-sb-context]').checked = p.context;
        $('[data-sb-talk]').innerHTML = (p.history.length ? p.history.map(t => `
            <div class="sb-turn ${t.role === 'user' ? 'is-user' : 'is-assistant'}">
                <span class="sb-turn-who">${t.role === 'user' ? 'You' : 'Planner'}</span>
                <p class="sb-turn-text">${esc(t.content)}</p>
            </div>`).join('') : '<p class="cl-cwin-dim">Tell the planner where the story should go. It asks what it needs, proposes an outline, and when you commit it hands the outline over as beats to change before adding.</p>')
            + (running === 'discuss' ? '<p class="sb-turn-wait"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i><span>The planner is writing...</span></p>' : '');
        bodyEl.querySelector('[data-sb="say"]').hidden = running === 'discuss';
        bodyEl.querySelector('[data-sb="stop-talk"]').hidden = running !== 'discuss';
        bodyEl.querySelector('[data-sb="commit"]').disabled = !!p.running || !p.history.length;
        bodyEl.querySelector('[data-sb="restart"]').disabled = !!p.running || !p.history.length;
        paintDrafts(p);
    }

    // what the answer did not deliver, said above the drafts it did: a cut at the ceiling first, else no beat read
    function shortfall(p) {
        const words = [p.cut?.words, p.dropped === null ? '' : `The beat it was writing${p.dropped ? ` ("${p.dropped}")` : ''} is left out.`].filter(Boolean);
        if (!words.length && p.said) words.push('The model answered, but no beat could be read from it.');
        if (!words.length) return '';
        if (p.said) words.push('What it said:');
        return `<div class="sb-said-box"${p.cut ? ' data-sb-cut' : ''}>
            <p class="sb-note is-error"><i class="fa-solid ${p.cut ? 'fa-scissors' : 'fa-circle-question'}" aria-hidden="true"></i><span>${esc(words.join(' '))}</span></p>
            ${p.said ? `<div class="sb-said" tabindex="0">${esc(p.said)}</div>` : ''}
        </div>`;
    }

    function paintDrafts(p) {
        const host = $('[data-sb-drafts]');
        const short = shortfall(p);
        host.hidden = !p.drafts.length && !short;
        host.innerHTML = `
            ${short}
            ${p.drafts.length ? `
                <div class="sb-drafts-head">
                    <span>${plural(p.drafts.length, 'draft', 'drafts')}: change them, then add them to the chat</span>
                </div>
                <ol class="sb-draft-list">${p.drafts.map((d, i) => `
                    <li class="cl-cwin-row sb-draft" data-sb-draft="${i}">
                        <div class="sb-draft-top cl-cwin-fieldrow">
                            <input type="search" autocomplete="one-time-code" class="cl-cwin-input sb-draft-title" data-sb-draft-field="title" maxlength="${TITLE_MAX}" value="${esc(d.title)}" aria-label="Title" placeholder="Title">
                            <select class="cl-select-fluid sb-draft-weight" data-sb-draft-field="weight" aria-label="Weight">${WEIGHTS.map(w => `<option value="${w}"${w === d.weight ? ' selected' : ''}>${WEIGHT_SHORT[w]}</option>`).join('')}</select>
                            <button type="button" class="sb-act is-danger" data-sb="leave-draft" title="Leave this draft out" aria-label="Leave this draft out"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
                        </div>
                        <textarea class="cl-cwin-input cl-cwin-textarea" data-sb-draft-field="directive" rows="2" maxlength="${DIRECTIVE_MAX}" aria-label="Directive" placeholder="Directive">\n${esc(d.directive)}</textarea>
                    </li>`).join('')}</ol>
                <div class="sb-row-verbs">
                    <button type="button" class="cl-cwin-btn-text sb-btn" data-sb="discard"><i class="fa-solid fa-xmark" aria-hidden="true"></i><span>Discard</span></button>
                    <button type="button" class="cl-cwin-btn-text is-primary sb-btn" data-sb="add-drafts"><i class="fa-solid fa-plus" aria-hidden="true"></i><span>Add to the Chat</span></button>
                </div>` : ''}`;
        for (const s of host.querySelectorAll('select')) CoreAPI.initCustomSelect(s);
    }

    // one planner request a chat at a time, stopped by Cancel, by Stop, or by the window closing
    async function plan(kind, ask) {
        const id = chatId;
        const p = planOf(id);
        if (p.running) return;
        const stop = new AbortController();
        p.running = { mode: kind, stop };
        unsay(p);
        p.note = '';
        paint();
        try {
            await ask(p, stop.signal, id);
        } catch (e) {
            if (!stop.signal.aborted) {
                p.note = `The planner failed: ${e.message}`;
                CoreAPI.showToast(`The planner failed: ${e.message}`, 'error');
            }
        } finally {
            if (p.running?.stop === stop) p.running = null;
        }
        if (chatId === id && pane === 'plan') paint();
    }
    const draftNotes = () => plan('list', async (p, signal, id) => {
        const out = await api.draftFromNotes(id, p.notes.trim(), signal);
        if (signal.aborted) return;
        p.drafts.push(...out.drafts);
        p.said = out.drafts.length ? '' : (out.said || '');
        told(p, out);
        p.note = out.drafts.length ? `${plural(out.drafts.length, 'beat', 'beats')} drafted` : '';
    });
    const talk = (text) => plan('discuss', async (p, signal, id) => {
        p.history.push({ role: 'user', content: text });
        paint();
        try {
            const out = await api.discussStep(id, p.history, p.context, signal);
            if (signal.aborted) return;
            told(p, out);
            if (Array.isArray(out.drafts)) {
                p.drafts.push(...out.drafts);
                const n = plural(out.drafts.length, 'beat', 'beats');
                const drafted = !out.cut ? `Drafted ${n}${out.summary ? `: ${out.summary}` : ''}. Change them below, then add them to the chat.`
                    : out.drafts.length ? `${n} drafted before the answer was cut off. Change them below, then add them to the chat.` : 'The answer was cut off before a beat was whole.';
                p.history.push({ role: 'assistant', content: `(${drafted})` });
            } else {
                p.history.push({ role: 'assistant', content: out.reply || '(no answer)' });
            }
        } finally {
            // a turn nobody answered goes back to the box it came from
            if (signal.aborted && p.history.at(-1)?.role === 'user') {
                const back = p.history.pop();
                if (back.content !== COMMIT_ASK) $('[data-sb-say]').value = back.content;
            }
        }
    });

    // ---------------------------------------------------------------- the log

    async function readLog() {
        const id = chatId;
        try {
            const out = await api.readLog(id);
            if (chatId !== id) return;
            log = out.entries;
        } catch (e) {
            if (chatId !== id) return;
            log = { error: e.message };
        }
        if (pane === 'log') paintLog();
    }

    function entryHtml(e) {
        const names = (list) => list.map(x => `${esc(x.title)}${x.reason ? ` <span class="sb-why">(${esc(x.reason)})</span>` : ''}`).join(', ');
        let body = '';
        let head = '';
        if (e.kind === 'director') {
            head = `Director, ${esc(e.strategy)}${e.forced ? ', run by hand' : ''}`;
            body = [
                e.promoted?.length ? `<p><span class="sb-log-key">Started</span> ${names(e.promoted)}</p>` : '',
                e.suggested?.length ? `<p><span class="sb-log-key">Suggested</span> ${names(e.suggested)}</p>` : '',
                e.satisfied?.length ? `<p><span class="sb-log-key">Satisfied</span> ${names(e.satisfied)}</p>` : '',
                e.rejected?.length ? `<p><span class="sb-log-key">Set aside</span> ${plural(e.rejected.length, 'answer it could not apply', 'answers it could not apply')}</p>` : '',
                typeof e.tension === 'number' ? `<p><span class="sb-log-key">Tension</span> ${Math.round(e.tension * 100)}%</p>` : '',
                e.summary ? `<p class="sb-summary">${esc(e.summary)}</p>` : '',
            ].join('');
        } else if (e.kind === 'error') {
            head = `The director failed (${esc(e.strategy)})`;
            body = `<p>${esc(e.error)}</p>${e.said ? `<div class="sb-said" tabindex="0">${esc(e.said)}</div>` : ''}`;
        } else {
            const by = { reader: 'by you', command: 'by a command', limit: 'by its counter' }[e.source] || '';
            head = `${esc(e.beat?.title || '(untitled)')}: ${esc(ACTION_WORDS[e.action] || e.action)}`;
            body = `<p class="sb-why">${esc([by, REASON_WORDS[e.reason] || e.reason].filter(Boolean).join(', '))}</p>`;
        }
        return `<li class="cl-cwin-row sb-entry${e.kind === 'error' ? ' is-error' : ''}"><div class="sb-entry-head"><span class="sb-entry-what">${head}</span><time class="sb-entry-when">${esc(timeOf(e.at))}</time></div>${body}</li>`;
    }

    function paintLog() {
        const t = data.director.tension;
        $('[data-sb-log-state]').textContent = typeof t === 'number' ? `Tension ${Math.round(t * 100)}% at the last change` : 'Every change to the beats of this chat, newest first';
        const host = $('[data-sb-log]');
        bodyEl.querySelector('[data-sb="clear-log"]').disabled = !Array.isArray(log) || !log.length;
        if (!log) { host.innerHTML = '<li class="cl-cwin-dim">Reading the log...</li>'; return; }
        if (log.error) { host.innerHTML = `<li class="cl-cwin-dim">The log could not be read: ${esc(log.error)}</li>`; return; }
        host.innerHTML = log.length ? log.map(entryHtml).join('') : '<li class="cl-cwin-empty"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i><p>Nothing yet. Start a beat, or switch the director on and let it pace the story.</p></li>';
    }

    // ---------------------------------------------------------------- verbs

    // one verb at a time, in the order they were asked, each ending in a re-read
    let chain = Promise.resolve();
    const run = (fn, failWord) => {
        const id = chatId;
        chain = chain.then(async () => {
            if (!id) return;
            try { await fn(id); } catch (e) {
                CoreAPI.showToast(`${failWord}: ${e.message}`, 'error');
            }
            if (chatId === id) await follow.reload();
        });
        return chain;
    };
    const beatOf = (el) => data?.beats?.find(b => b.id === el.closest('[data-sb-beat]')?.dataset.sbBeat) || null;

    // a beat placed before or after another, shown there at once, then written and read back
    const moveTo = (beat, onto, after) => {
        const was = data.beats.map(b => b.id);
        const ids = was.filter(id => id !== beat.id);
        const at = ids.indexOf(onto);
        if (at === -1) return null;
        ids.splice(at + (after ? 1 : 0), 0, beat.id);
        if (ids.join() === was.join()) return null;
        data = { ...data, beats: ids.map(id => data.beats.find(b => b.id === id)) };
        paint();
        return run((id) => api.reorderBeats(id, ids), 'Could not move it');
    };
    // past its neighbour in the group it shows in, so the timeline moves where the reader looks
    const moveBy = (beat, step) => {
        const group = data.beats.filter(b => b.status === beat.status).map(b => b.id);
        const past = group[group.indexOf(beat.id) + step];
        return past ? moveTo(beat, past, step > 0) : null;
    };

    // the phone's face of a row's verbs: the row's own buttons listed in the canonical sheet, with the moves touch has no drag for
    function openRowSheet(row, beat) {
        const acts = [...row.querySelectorAll('.sb-acts [data-sb]')].map(a => [a.dataset.sb, a.querySelector('i')?.className || '', a.getAttribute('aria-label') || a.title]);
        const sheet = CoreAPI.createMobileSheet?.({ label: titleOf(beat) });
        if (!sheet || !acts.length) return;
        const group = data.beats.filter(b => b.status === beat.status);
        const at = group.findIndex(b => b.id === beat.id);
        const moves = [at > 0 && ['up', 'fa-arrow-up', 'Move up'], at < group.length - 1 && ['down', 'fa-arrow-down', 'Move down']].filter(Boolean);
        const item = (key, value, icon, word) => `<button type="button" class="mobile-sheet-item" data-sb-sheet-${key}="${value}"><i class="${esc(icon)}" aria-hidden="true"></i><span>${esc(word)}</span></button>`;
        // insertAdjacentHTML, never innerHTML: the builder already appended the drag handle
        sheet.sheet.insertAdjacentHTML('beforeend', `<div class="mobile-sheet-group-title">${esc(titleOf(beat))}</div>`
            + acts.map(([act, icon, word]) => item('act', act, icon, word)).join('')
            + moves.map(([dir, icon, word]) => item('move', dir, `fa-solid ${icon}`, word)).join(''));
        sheet.sheet.addEventListener('click', (e) => {
            const it = e.target.closest('[data-sb-sheet-act], [data-sb-sheet-move]');
            if (!it) return;
            sheet.close();
            // the beat as it stands now: the timeline may have repainted while the sheet was open
            const now = data?.beats?.find(b => b.id === beat.id);
            if (!now) return;
            if (it.dataset.sbSheetMove) void moveBy(now, it.dataset.sbSheetMove === 'up' ? -1 : 1);
            else if (beatVerbs[it.dataset.sbSheetAct]) void beatVerbs[it.dataset.sbSheetAct](now);
        });
        sheet.open();
    }

    // HTML5 drag on the desktop: a row dropped before or after another of the group it shows in
    let dragged = null;
    const clearOver = () => list.querySelectorAll('.is-drop-before, .is-drop-after').forEach(el => el.classList.remove('is-drop-before', 'is-drop-after'));
    const groupOf = (row) => row?.closest('[data-sb-group]')?.dataset.sbGroup;
    const dropOnto = (e) => {
        const row = e.target.closest?.('[data-sb-beat]');
        return row && dragged && row.dataset.sbBeat !== dragged.dataset.sbBeat && groupOf(row) === groupOf(dragged) ? row : null;
    };
    const below = (row, e) => { const r = row.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
    list.addEventListener('dragstart', (e) => {
        const row = e.target.closest?.('[data-sb-beat]');
        if (!row || row.getAttribute('draggable') !== 'true') return;
        dragged = row;
        row.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', row.dataset.sbBeat);
    });
    list.addEventListener('dragend', () => {
        dragged?.classList.remove('is-dragging');
        dragged = null;
        clearOver();
    });
    list.addEventListener('dragover', (e) => {
        const row = dropOnto(e);
        if (!row) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearOver();
        row.classList.add(below(row, e) ? 'is-drop-after' : 'is-drop-before');
    });
    list.addEventListener('dragleave', (e) => {
        if (!e.relatedTarget || !list.contains(e.relatedTarget)) clearOver();
    });
    list.addEventListener('drop', (e) => {
        const row = dropOnto(e);
        if (!row) return;
        e.preventDefault();
        const beat = data?.beats?.find(b => b.id === dragged.dataset.sbBeat);
        const after = below(row, e);
        dragged.classList.remove('is-dragging');
        dragged = null;
        clearOver();
        if (beat) void moveTo(beat, row.dataset.sbBeat, after);
    });

    const verbs = {
        add: () => run(async (id) => {
            const out = await api.addBeats(id, [{ title: '', directive: '' }]);
            open = out.added?.[0] || null;
            filter = 'all';
        }, 'Could not add a beat'),
        next: () => run(async (id) => {
            const out = await api.activateNext(id);
            CoreAPI.showToast(`Started: ${titleOf(out.beat)}`, 'success');
        }, 'No beat started'),
        direct: () => run(async (id) => {
            await api.runDirector(id);
            CoreAPI.showToast('The director is reading the chat', 'info');
        }, 'The director did not run'),
        'clear-log': () => run(async (id) => {
            if (await api.clearLog(id)) log = [];
        }, 'Could not clear the log'),
        'add-drafts': () => run(async (id) => {
            const p = planOf(id);
            const beats = p.drafts.map(d => ({ title: d.title.trim(), directive: d.directive.trim(), weight: d.weight })).filter(d => d.title || d.directive);
            if (!beats.length) return;
            await api.addBeats(id, beats);
            p.drafts = [];
            unsay(p);
            p.note = '';
            pane = 'beats';
            filter = 'all';
            CoreAPI.showToast(`Added ${plural(beats.length, 'beat', 'beats')}`, 'success');
        }, 'Could not add the drafts'),
        discard: () => { const p = planOf(chatId); p.drafts = []; unsay(p); paint(); },
        draft: () => { if (planOf(chatId).notes.trim()) void draftNotes(); else CoreAPI.showToast('Write some notes first', 'info'); },
        'stop-draft': () => planOf(chatId).running?.stop.abort(),
        'stop-talk': () => planOf(chatId).running?.stop.abort(),
        say: () => {
            const box = $('[data-sb-say]');
            const text = box.value.trim();
            if (!text) return;
            box.value = '';
            CoreAPI.fitTextarea?.(box);
            void talk(text);
        },
        commit: () => { if (planOf(chatId).history.length) void talk(COMMIT_ASK); },
        restart: () => { const p = planOf(chatId); p.history = []; paint(); },
    };
    const beatVerbs = {
        toggle: (b) => {
            open = open === b.id ? null : b.id;
            owed = false;
            // closed from inside the editor (its Done), the focus there would hold the repaint
            if (held()) document.activeElement.blur();
            paint();
        },
        accept: (b) => run((id) => api.changeStatus(id, b.id, 'active'), 'Could not start it'),
        dismiss: (b) => run((id) => api.changeStatus(id, b.id, 'pending'), 'Could not dismiss it'),
        activate: (b) => run((id) => api.changeStatus(id, b.id, 'active'), 'Could not start it'),
        force: (b) => run((id) => api.changeStatus(id, b.id, 'active', { force: true }), 'Could not start it'),
        satisfy: (b) => run((id) => api.changeStatus(id, b.id, 'satisfied'), 'Could not mark it satisfied'),
        skip: (b) => run((id) => api.changeStatus(id, b.id, 'skipped'), 'Could not skip it'),
        reset: (b) => run((id) => api.changeStatus(id, b.id, 'pending'), 'Could not put it back'),
        delete: (b) => run(async (id) => {
            if (await api.deleteBeat(id, b) && open === b.id) open = null;
        }, 'Could not delete it'),
    };

    // a field of the open editor, kept once the reader leaves it
    const keep = (b, fields) => run((id) => api.editBeat(id, b.id, fields), 'Could not keep that');

    bodyEl.addEventListener('click', (e) => {
        const view = e.target.closest('[data-sb-view]');
        if (view) {
            pane = view.dataset.sbView;
            paint();
            if (pane === 'log') void readLog();
            return;
        }
        const f = e.target.closest('[data-sb-filter]');
        if (f) { filter = f.dataset.sbFilter; paint(); return; }
        const mode = e.target.closest('[data-sb-mode]');
        if (mode) { planOf(chatId).mode = mode.dataset.sbMode; paint(); return; }
        const btn = e.target.closest('[data-sb]');
        const act = btn?.dataset.sb;
        if (!act || btn.disabled) return;
        if (act === 'leave-draft') {
            planOf(chatId).drafts.splice(Number(btn.closest('[data-sb-draft]').dataset.sbDraft), 1);
            paint();
            return;
        }
        if (act === 'acts') {
            const b = beatOf(btn);
            if (b) openRowSheet(btn.closest('[data-sb-beat]'), b);
            return;
        }
        if (beatVerbs[act]) {
            const b = beatOf(btn);
            if (b) void beatVerbs[act](b);
            return;
        }
        if (verbs[act]) void verbs[act]();
    });
    bodyEl.addEventListener('input', (e) => {
        const t = e.target;
        if (t.matches?.('[data-sb-notes]')) { planOf(chatId).notes = t.value; return; }
        if (t.matches?.('[data-sb-say]')) { CoreAPI.fitTextarea?.(t); return; }
        const d = t.closest?.('[data-sb-draft]');
        if (d && t.dataset.sbDraftField) {
            const draft = planOf(chatId).drafts[Number(d.dataset.sbDraft)];
            if (draft) draft[t.dataset.sbDraftField] = t.value;
        }
    });
    bodyEl.addEventListener('change', (e) => {
        const t = e.target;
        if (t.matches?.('[data-sb-director-on]')) { ctx.settings.set('director', t.checked); paint(); return; }
        if (t.matches?.('[data-sb-context]')) { planOf(chatId).context = t.checked; return; }
        const d = t.closest?.('[data-sb-draft]');
        if (d && t.dataset.sbDraftField) {
            const draft = planOf(chatId).drafts[Number(d.dataset.sbDraft)];
            if (draft) draft[t.dataset.sbDraftField] = t.value;
            return;
        }
        const b = beatOf(t);
        if (!b) return;
        if (t.dataset.sbDep !== undefined) {
            const deps = [...t.closest('.sb-deps').querySelectorAll('[data-sb-dep]')].filter(x => x.checked).map(x => x.dataset.sbDep);
            void keep(b, { dependsOn: deps });
            return;
        }
        const field = t.dataset.sbField;
        if (!field) return;
        const value = field === 'fadeAfter' || field === 'maxMessages' ? beatCount(field, t.value) : t.value;
        if (typeof value === 'number') t.value = String(value);
        void keep(b, { [field]: value });
    });
    bodyEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && e.target.matches?.('[data-sb-say]')) { e.preventDefault(); verbs.say(); }
    });
    // the timeline owed a repaint while the reader typed paints once they leave the editor
    bodyEl.addEventListener('focusout', () => {
        setTimeout(() => { if (owed && !held() && data && !data.error && pane === 'beats') paint(); }, 0);
    });

    return {
        show: (id) => follow.show(id),
        reload: () => follow.reload(),
        reloadSoon: () => follow.reloadSoon(),
        // a closed window stops what its planner was asking
        rest: () => {
            follow.rest();
            for (const p of plans.values()) p.running?.stop.abort();
        },
        chatId: () => chatId,
        isOpen: () => follow.isOpen(),
    };
}
