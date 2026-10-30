// The Trackers window's body: the open chat's trackers, a tab each, their state, verbs and picker; every
// verb is a request and a re-read.
import { stateHtml, setAvatarResolver } from './render.js';
import { EXAMPLES } from './examples.js';

const POLL_MS = 2000;
const SOON_MS = 400;

// an example as a definition of the reader's own: the picker's key is not the model's
const asDefinition = ({ template, ...def }) => def;
// a field's path as data-tkr-field carries it (JSON: a character's name may hold a dot)
const pathOf = (attr) => { try { const p = JSON.parse(attr); return Array.isArray(p) ? p.map(String) : []; } catch { return []; } };

export function mountTrackers(bodyEl, ctx, { edit = () => {} } = {}) {
    const { CoreAPI } = ctx;
    const esc = (v) => CoreAPI.escapeHtml(v);
    const call = ctx.server.call;

    bodyEl.innerHTML = `
        <div class="tkr">
            <div class="tkr-tabs cl-hidden" data-tkr-tabs role="tablist" aria-label="Trackers"></div>
            <div class="tkr-head" data-tkr-head>
                <span class="tkr-asof" data-tkr-asof></span>
                <span class="tkr-status" data-tkr-status></span>
            </div>
            <div class="tkr-note cl-hidden" data-tkr-note>
                <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
                <span class="tkr-note-text" data-tkr-note-text></span>
                <button type="button" class="cl-cwin-btn-text" data-tkr="retry">Try Again</button>
            </div>
            <div class="tkr-state" data-tkr-state></div>
            <div class="tkr-foot" data-tkr-foot>
                <label class="tkr-auto">
                    <input type="checkbox" class="cl-switch-input" data-tkr-auto><span class="cl-switch" aria-hidden="true"></span>
                    <span>Update automatically</span>
                </label>
                <div class="tkr-verbs">
                    <button type="button" class="cl-cwin-btn-text is-danger" data-tkr="remove" title="Stop keeping this tracker in this chat"><i class="fa-solid fa-xmark" aria-hidden="true"></i> Remove</button>
                    <button type="button" class="cl-cwin-btn-text" data-tkr="edit" title="Change what this tracker keeps, for every chat that keeps it"><i class="fa-solid fa-pen-ruler" aria-hidden="true"></i> Edit</button>
                    <button type="button" class="cl-cwin-btn-text" data-tkr="redo" title="Ask again for the newest message"><i class="fa-solid fa-arrow-rotate-left" aria-hidden="true"></i> Redo</button>
                    <button type="button" class="cl-cwin-btn-text is-primary" data-tkr="update"><i class="fa-solid fa-rotate" aria-hidden="true"></i> Update Now</button>
                </div>
                <span class="cl-cwin-dim tkr-auto-off cl-hidden" data-tkr-auto-off>Update after every reply is off in Settings, so a tracker updates only when you press Update Now.</span>
            </div>
            <div class="tkr-picker cl-hidden" data-tkr-picker></div>
            <div class="cl-cwin-empty cl-hidden" data-tkr-empty><i class="fa-solid fa-clipboard-list" aria-hidden="true"></i><p data-tkr-empty-text></p></div>
        </div>`;
    const $ = (sel) => bodyEl.querySelector(sel);
    const verb = (v) => bodyEl.querySelector(`[data-tkr="${v}"]`);
    const auto = $('[data-tkr-auto]');

    let chatId = null;
    let character = null;
    let data = null;
    let defs = null;
    let focused = null;
    let picking = false;
    let busy = false;
    // what each field held once painted: a text input drops a model's newline, so typing is measured against this
    const painted = new WeakMap();

    // a card's face: the chat's own character, matched by name; everyone else keeps their initials
    setAvatarResolver((who) => (character?.id && character.name && String(who).trim().toLowerCase() === String(character.name).trim().toLowerCase()
        ? CoreAPI.getCharacterAvatarSmallThumbUrl(character.id) || null : null));

    // the open chat's trackers, read while the window is open; a run on its way is polled
    const follow = ctx.chats.follow({
        read: async (id) => {
            const next = await call(`/chats/${encodeURIComponent(id)}`);
            if (picking || !next.trackers.length) defs = (await call('/defs')).defs;
            return next;
        },
        moved: (id) => {
            chatId = id;
            data = null;
            focused = null;
            picking = false;
            paint();
        },
        apply: (next) => {
            data = next;
            if (data && !data.trackers.some(t => t.defId === focused)) focused = data.trackers[0]?.defId ?? null;
            paint();
        },
        fail: (e) => { data = { error: e.message }; paint(); },
        working: (next) => !!next.working,
        soonMs: SOON_MS,
        pollMs: POLL_MS,
    });
    const { rest, reload, reloadSoon } = follow;
    const show = (id, char) => {
        if (char !== undefined) character = char;
        return follow.show(id);
    };

    // ---------------------------------------------------------------- painting

    function paint() {
        const blank = !chatId ? 'Open a chat to see its trackers.' : data?.error ? `The trackers could not be read: ${data.error}` : !data ? 'Reading the trackers...' : null;
        const choosing = !blank && (picking || !data.trackers.length);
        const empty = $('[data-tkr-empty]');
        empty.classList.toggle('cl-hidden', !blank);
        empty.classList.toggle('is-error', !!data?.error);
        $('[data-tkr-empty-text]').textContent = blank || '';
        $('[data-tkr-tabs]').classList.toggle('cl-hidden', !!blank || !data.trackers.length);
        for (const sel of ['[data-tkr-head]', '[data-tkr-state]', '[data-tkr-foot]']) $(sel).classList.toggle('cl-hidden', !!blank || choosing);
        $('[data-tkr-picker]').classList.toggle('cl-hidden', !choosing);
        if (blank) { $('[data-tkr-note]').classList.add('cl-hidden'); return; }
        paintTabs();
        if (choosing) { $('[data-tkr-note]').classList.add('cl-hidden'); paintPicker(); return; }
        paintTracker(data.trackers.find(t => t.defId === focused) || data.trackers[0]);
    }

    function paintTabs() {
        $('[data-tkr-tabs]').innerHTML = data.trackers.map(t => `
            <button type="button" class="tkr-tab${t.defId === focused && !picking ? ' is-on' : ''}" role="tab" aria-selected="${t.defId === focused && !picking}" data-tkr-tab="${esc(t.defId)}">
                <i class="fa-solid ${esc(t.def.icon || 'fa-clipboard-list')}" aria-hidden="true"></i><span>${esc(t.name)}</span>
                ${t.error ? '<i class="fa-solid fa-triangle-exclamation tkr-tab-warn" title="The last update failed" aria-hidden="true"></i>' : ''}
                ${t.paused ? '<i class="fa-solid fa-pause tkr-tab-paused" title="Paused" aria-hidden="true"></i>' : ''}
            </button>`).join('') + `
            <button type="button" class="tkr-tab tkr-tab-add${picking ? ' is-on' : ''}" data-tkr="add" title="Keep track of something else" aria-label="Keep track of something else"><i class="fa-solid fa-plus" aria-hidden="true"></i></button>`;
    }

    function paintTracker(t) {
        const working = data.working;
        // the reader's own turn is the newest: nothing is behind until the reply after it lands
        const behind = !!data.anchor && !data.anchor.byReader && !t.current;
        // a message by the number the conversation shows on it
        $('[data-tkr-asof]').textContent = t.at
            ? `As of message #${t.at.seq}${t.at.source === 'reader' ? ', as you set it' : ''}`
            : 'Nothing kept yet';
        const status = $('[data-tkr-status]');
        status.className = `tkr-status${working ? ' is-busy' : behind && !t.paused ? ' is-behind' : ''}`;
        status.innerHTML = working
            ? `<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ${working === 'running' ? 'Updating' : 'Queued'}`
            : esc(t.paused ? 'Paused' : behind ? 'Behind the chat' : t.at ? 'Up to date' : 'Waits for a reply');
        const note = $('[data-tkr-note]');
        note.classList.toggle('cl-hidden', !t.error || !!working);
        $('[data-tkr-note-text]').textContent = t.error ? `The last update failed: ${t.error}` : '';
        // a manual field with an unsaved value or the focus is never rebuilt under the reader
        const stateEl = $('[data-tkr-state]');
        const held = stateEl.dataset.tkrOf === t.defId && [...stateEl.querySelectorAll('[data-tkr-field]')].some(f =>
            f.value !== painted.get(f) || (typeof document !== 'undefined' && document.activeElement === f));
        if (!held) {
            stateEl.innerHTML = stateHtml(t.def, t.state || {}, { editable: true });
            stateEl.dataset.tkrOf = t.defId;
            for (const f of stateEl.querySelectorAll('[data-tkr-field]')) painted.set(f, f.value);
            for (const s of stateEl.querySelectorAll('select[data-tkr-field]')) CoreAPI.initCustomSelect(s);
        }
        // the account's switch off, no tracker runs by itself, whatever this chat's pause says
        const autoOn = ctx.settings.get('auto') !== false;
        auto.disabled = !autoOn;
        if (!busy) auto.checked = autoOn && !t.paused;
        $('[data-tkr-auto-off]').classList.toggle('cl-hidden', autoOn);
        verb('update').disabled = busy || !!working;
        verb('redo').disabled = busy || !!working || !t.current;
        verb('remove').disabled = busy;
        verb('retry').disabled = busy || !!working;
    }

    function paintPicker() {
        const bound = new Set(data.trackers.map(t => t.defId));
        const mine = (defs || []).filter(d => !bound.has(d.id));
        const names = new Set((defs || []).map(d => d.name.toLowerCase()));
        const examples = EXAMPLES.filter(e => !names.has(e.name.toLowerCase()));
        const row = (key, d) => `
            <button type="button" class="cl-cwin-row tkr-pick" data-tkr-pick="${esc(key)}">
                <i class="fa-solid ${esc(d.icon || 'fa-clipboard-list')} tkr-pick-icon" aria-hidden="true"></i>
                <span class="tkr-pick-body"><span class="tkr-pick-name">${esc(d.name)}</span>${d.description ? `<span class="tkr-pick-desc">${esc(d.description)}</span>` : ''}</span>
                <i class="fa-solid fa-plus tkr-pick-add" aria-hidden="true"></i>
            </button>`;
        $('[data-tkr-picker]').innerHTML = `
            <div class="tkr-pick-lead">
                <p class="tkr-pick-title">Keep track of something in this chat</p>
                <p class="tkr-pick-hint">After each reply your own model reads the chat, keeps what it finds, and the prompt carries it, so the story holds on to it.</p>
            </div>
            ${mine.length ? `<section class="tkr-section"><h5 class="tkr-section-title">Your trackers</h5><div class="tkr-picks">${mine.map(d => row(`def:${d.id}`, d)).join('')}</div></section>` : ''}
            ${examples.length ? `<section class="tkr-section"><h5 class="tkr-section-title">Start from an example</h5><div class="tkr-picks">${examples.map(e => row(`example:${e.template}`, e)).join('')}</div></section>` : ''}
            ${!mine.length && !examples.length ? '<p class="tkr-none">This chat keeps every tracker you have.</p>' : ''}
            <div class="tkr-pick-foot">
                <button type="button" class="cl-cwin-btn-text" data-tkr="make"><i class="fa-solid fa-pen-ruler" aria-hidden="true"></i> Make Your Own</button>
                ${data.trackers.length ? '<button type="button" class="cl-cwin-btn-text" data-tkr="back">Back</button>' : ''}
            </div>`;
        for (const b of bodyEl.querySelectorAll('[data-tkr-pick]')) b.disabled = busy;
    }

    // ---------------------------------------------------------------- verbs

    // one verb at a time, each ending in a re-read; each write spells its route where it calls it
    async function run(fn, failWord) {
        if (busy || !chatId) return;
        const id = encodeURIComponent(chatId);
        busy = true;
        paint();
        try { await fn(id); } catch (e) {
            CoreAPI.showToast(`${failWord}: ${e.message}`, 'error');
        } finally {
            busy = false;
        }
        await reload();
    }
    const focusedTracker = () => data?.trackers?.find(t => t.defId === focused) || null;
    const def = () => encodeURIComponent(focused);

    const verbs = {
        update: () => run(async (id) => {
            const out = await call(`/chats/${id}/update`, 'POST', { defId: focused });
            if (!out.queued) CoreAPI.showToast('It is up to date with the chat', 'info');
        }, 'Could not update it'),
        retry: () => verbs.update(),
        redo: () => run((id) => call(`/chats/${id}/update`, 'POST', { defId: focused, redo: true }), 'Could not ask again'),
        remove: () => run(async (id) => {
            const t = focusedTracker();
            const ok = await CoreAPI.showConfirm({
                title: `Stop keeping ${t?.name || 'this tracker'}?`,
                message: 'It leaves this chat and its prompt, and what it kept here goes with it. The tracker itself stays, for this chat or any other.',
                confirmLabel: 'Remove',
                danger: true,
                icon: 'fa-solid fa-xmark',
            });
            if (ok !== true) return;
            await call(`/chats/${id}/trackers/${def()}`, 'DELETE');
            focused = null;
        }, 'Could not remove it'),
        add: () => { picking = true; paint(); void reload(); },
        back: () => { picking = false; paint(); },
        // the editor is library-wide: whatever it saves or deletes, this window reads again after it
        make: () => edit({ from: 'blank', changed: () => { void reload(); } }),
        edit: () => edit({ defId: focused, changed: () => { void reload(); } }),
    };

    // a tracker switched on: one of the reader's own, or an example made theirs first
    const pick = (key) => run(async (id) => {
        let defId;
        if (key.startsWith('example:')) {
            const example = EXAMPLES.find(e => e.template === key.slice(8));
            if (!example) return;
            defId = (await call('/defs', 'POST', { def: asDefinition(example) })).id;
        } else {
            defId = key.slice(4);
        }
        await call(`/chats/${id}/trackers`, 'POST', { defId });
        focused = defId;
        picking = false;
    }, 'Could not switch it on');

    // the reader's own word on a field the model never writes, kept at the state the window shows
    const setField = (field, value) => run(async (id) => {
        const t = focusedTracker();
        if (!t) return;
        const keys = pathOf(field.dataset.tkrField);
        if (!keys.length) return;
        const state = JSON.parse(JSON.stringify(t.state || {}));
        let node = state;
        for (const k of keys.slice(0, -1)) {
            if (!node[k] || typeof node[k] !== 'object') node[k] = {};
            node = node[k];
        }
        node[keys.at(-1)] = value;
        try {
            await call(`/chats/${id}/trackers/${def()}/state`, 'PUT', { at: t.at, state });
            // kept: the field is done typing, so the re-read's paint shows the server's state
            painted.set(field, value);
        } catch (e) {
            // refused: the re-read's paint rebuilds the body from the server's state, the toast the only trace
            $('[data-tkr-state]').dataset.tkrOf = '';
            throw e;
        }
    }, 'Could not keep that');

    bodyEl.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-tkr-tab]');
        if (tab) { focused = tab.dataset.tkrTab; picking = false; paint(); return; }
        const choice = e.target.closest('[data-tkr-pick]');
        if (choice) { void pick(choice.dataset.tkrPick); return; }
        const v = e.target.closest('[data-tkr]')?.dataset.tkr;
        if (verbs[v]) void verbs[v]();
    });
    // the switch's new state is read before run paints, which puts back the state it knows
    auto.addEventListener('change', () => {
        const paused = !auto.checked;
        return run((id) => call(`/chats/${id}/trackers/${def()}`, 'PUT', { paused }), 'Could not change it');
    });
    bodyEl.addEventListener('change', (e) => {
        const field = e.target.closest('[data-tkr-field]');
        if (field) void setField(field, field.value);
    });

    return {
        show, rest, reload, reloadSoon,
        chatId: () => chatId,
        isOpen: follow.isOpen,
        setCharacter: (c) => { character = c; if (data && !data.error) paint(); },
    };
}
