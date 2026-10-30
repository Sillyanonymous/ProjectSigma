// Memory, the client half: the open chat's memory in a conversation window, and the settings.
import { SETTING_LIMITS, settingNumber } from './limits.js';

const ID = 'memory';
const POLL_MS = 2000;
const SOON_MS = 400;

export default {
    init(ctx) {
        const { CoreAPI } = ctx;
        const esc = (s) => CoreAPI.escapeHtml(s);
        const call = ctx.server.call;
        const setting = (key) => settingNumber(key, ctx.settings.get(key), ctx.settings.defaults[key]);

        let view = null;
        ctx.ui.addChatWindow({
            id: 'memory',
            label: 'Memory',
            icon: 'fa-brain',
            min: { w: 26, h: 30 },
            // render runs once, then onOpen on every open (the first included), which reads
            render(bodyEl) { view = mountMemory(bodyEl); },
            onOpen: ({ chatId }) => view?.show(chatId),
            onClose: () => view?.rest(),
        });
        // the conversation switching chats under the open window; the chat on show announced again
        // (its character landing after it) reads nothing new
        ctx.events.on('conversation.changed', ({ chatId }) => {
            if (view?.isOpen() && chatId && chatId !== view.chatId()) view.show(chatId);
        });
        // the server's word on the shown chat's memory, and the chat's messages moving under it
        ctx.events.on('chat.updated', ({ ids, fields }) => {
            if (view?.isOpen() && ids.includes(view.chatId()) && fields.some(f => f.startsWith(`${ID}.`))) view.reload();
        });
        for (const name of ['message.created', 'message.updated', 'message.deleted']) {
            ctx.events.on(name, ({ chatId }) => { if (view?.isOpen() && chatId === view.chatId()) view.reloadSoon(); });
        }
        // nothing itemized (a reconnect, an import elsewhere): what was written meanwhile is read again
        ctx.events.on('library.changed', () => { if (view?.isOpen()) view.reloadSoon(); });
        // the account's update count, changed in Settings while the window is open, is what its switch says
        ctx.events.on('settings.changed', ({ keys, all }) => {
            if (view?.isOpen() && (all || keys.includes(`ext:${ID}:every`))) view.reloadSoon();
        });

        function mountMemory(bodyEl) {
            bodyEl.innerHTML = `
                <div class="mem">
                    <div class="mem-head">
                        <span class="mem-covers" data-mem-covers></span>
                        <span class="mem-chip" data-mem-chip></span>
                    </div>
                    <div class="mem-note cl-hidden" data-mem-note>
                        <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
                        <span class="mem-note-text" data-mem-note-text></span>
                        <span class="mem-note-verbs">
                            <button type="button" class="cl-cwin-btn-text" data-mem="keep">Keep as It Is</button>
                        </span>
                    </div>
                    <textarea class="cl-cwin-input mem-text" data-mem-text spellcheck="true"></textarea>
                    <div class="mem-foot">
                        <label class="mem-auto">
                            <input type="checkbox" class="cl-switch-input" data-mem-auto><span class="cl-switch" aria-hidden="true"></span>
                            <span>Update automatically</span>
                        </label>
                        <div class="mem-verbs">
                            <button type="button" class="cl-cwin-btn-text" data-mem="undo" title="Put back the memory before the last change"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i> Undo</button>
                            <button type="button" class="cl-cwin-btn-text" data-mem="rebuild" title="Write the memory again from the whole chat"><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i> Rebuild</button>
                            <button type="button" class="cl-cwin-btn-text is-danger" data-mem="clear" title="Empty the memory; it starts over from the first message"><i class="fa-solid fa-eraser" aria-hidden="true"></i> Clear</button>
                            <button type="button" class="cl-cwin-btn-text cl-hidden" data-mem="discard">Discard</button>
                            <button type="button" class="cl-cwin-btn-text is-primary cl-hidden" data-mem="save">Save</button>
                            <button type="button" class="cl-cwin-btn-text is-primary" data-mem="update"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Update Now</button>
                        </div>
                        <span class="cl-cwin-dim mem-auto-off cl-hidden" data-mem-auto-off>Updates are set to 0 in Settings, so the memory is written only when you press Update Now.</span>
                    </div>
                    <div class="cl-cwin-empty cl-hidden" data-mem-empty><i class="fa-solid fa-brain" aria-hidden="true"></i><p data-mem-empty-text></p></div>
                </div>`;
            const $ = (sel) => bodyEl.querySelector(sel);
            const btn = (verb) => bodyEl.querySelector(`[data-mem="${verb}"]`);
            const text = $('[data-mem-text]');
            const auto = $('[data-mem-auto]');
            let chatId = null;
            let state = null;
            // the stored text, the text an edit began from, whether it differs, and unsaved edits of chats left behind
            let base = '';
            let editBase = '';
            let dirty = false;
            const drafts = new Map();
            let busy = false;

            // the open chat's memory, read while the window is open; a fold on its way is polled
            const follow = ctx.chats.follow({
                read: (id) => call(`/chats/${encodeURIComponent(id)}`),
                moved: (id, was) => {
                    if (dirty && was) drafts.set(was, { text: text.value, editBase });
                    chatId = id;
                    state = null;
                    const draft = chatId ? drafts.get(chatId) : null;
                    drafts.delete(chatId);
                    dirty = !!draft;
                    text.value = draft ? draft.text : '';
                    editBase = draft ? draft.editBase : '';
                    paint();
                },
                apply: (next) => {
                    state = next;
                    if (next) {
                        base = next.summary;
                        if (!dirty) text.value = next.summary;
                    }
                    paint();
                },
                fail: (e) => { state = { error: e.message }; paint(); },
                working: (next) => !!next.working,
                soonMs: SOON_MS,
                pollMs: POLL_MS,
            });
            const { show, rest, reload, reloadSoon } = follow;

            function paint() {
                const empty = $('[data-mem-empty]');
                const body = [...bodyEl.querySelectorAll('.mem > :not([data-mem-empty])')];
                const blank = !chatId ? 'Open a chat to see its memory.' : state?.error ? `The memory could not be read: ${state.error}` : !state ? 'Reading the memory...' : null;
                empty.classList.toggle('cl-hidden', !blank);
                empty.classList.toggle('is-error', !!state?.error);
                for (const el of body) el.classList.toggle('cl-hidden', !!blank);
                if (blank) { $('[data-mem-empty-text]').textContent = blank; return; }
                const s = state;
                const working = !!s.working;
                $('[data-mem-covers]').textContent = s.covered
                    ? `Covers messages #0 to #${s.covered - 1} of ${s.total}`
                    : s.summary ? `Written by hand; messages fold in from the first` : `Empty for now`;
                const chip = $('[data-mem-chip]');
                chip.className = `mem-chip${working ? ' is-busy' : ''}`;
                chip.innerHTML = working
                    ? `<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ${s.working === 'running' ? (s.rebuilding ? 'Rebuilding' : 'Updating') : 'Queued'}`
                    : esc(s.paused ? 'Paused' : s.waiting ? `${s.waiting} waiting` : 'Up to date');
                const note = $('[data-mem-note]');
                // an edit whose stored text moved under it: Save replaces the new text with the edit
                const drifted = dirty && s.summary !== editBase;
                const noteText = s.stale ? 'The chat changed under this memory (a message it read was edited or removed). Rebuild it from the chat, or keep it as it is.'
                    : drifted ? 'The memory changed while you were editing. Save replaces it with your text; Discard shows the new one.'
                        : s.failed ? `The last update failed: ${s.failed}` : '';
                note.classList.toggle('cl-hidden', !noteText || (working && !drifted));
                note.classList.toggle('is-error', !s.stale && !drifted && !!s.failed);
                $('[data-mem-note-text]').textContent = noteText;
                btn('keep').classList.toggle('cl-hidden', !s.stale);
                const every = setting('every');
                const keep = setting('keep');
                text.placeholder = every
                    ? `Nothing yet. The memory is written once ${every} messages wait past the newest ${keep}, or when you press Update Now. You can also write it yourself.`
                    : 'Nothing yet. Press Update Now to have your model write it, or write it yourself.';
                // at 0 the server never folds by itself, whatever this chat's pause says
                auto.disabled = !every;
                if (!busy) auto.checked = !!every && !s.paused;
                $('[data-mem-auto-off]').classList.toggle('cl-hidden', !!every);
                btn('save').classList.toggle('cl-hidden', !dirty);
                btn('discard').classList.toggle('cl-hidden', !dirty);
                btn('update').classList.toggle('cl-hidden', dirty);
                btn('update').disabled = busy || working || s.stale || !s.waiting;
                btn('rebuild').disabled = busy || working || dirty || s.total <= keep;
                btn('undo').disabled = busy || working || dirty || !s.canUndo;
                btn('clear').disabled = busy || working || dirty || (!s.summary && !s.covered);
                btn('save').disabled = busy;
                btn('keep').disabled = busy || working;
            }

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

            text.addEventListener('input', () => {
                if (!dirty) editBase = base;
                dirty = text.value !== editBase;
                if (state && !state.error) paint();
            });
            // the switch's new state is read before run paints, which puts back the state it knows
            auto.addEventListener('change', () => {
                const paused = !auto.checked;
                return run((id) => call(`/chats/${id}`, 'PUT', { paused }), 'Could not change it');
            });
            const verbs = {
                save: () => run(async (id) => {
                    await call(`/chats/${id}`, 'PUT', { summary: text.value });
                    dirty = false;
                }, 'Could not save the memory'),
                discard: () => {
                    dirty = false;
                    text.value = base;
                    return reload();
                },
                // the chat changed under it: the text as it is (or as edited) vouched for as the chat now stands
                keep: () => run(async (id) => {
                    await call(`/chats/${id}`, 'PUT', { summary: dirty ? text.value : state.summary });
                    dirty = false;
                }, 'Could not keep the memory'),
                update: () => run(async (id) => {
                    const out = await call(`/chats/${id}/update`, 'POST', {});
                    if (!out.queued) CoreAPI.showToast('Nothing waits to be folded in', 'info');
                }, 'Could not update the memory'),
                rebuild: () => run(async (id) => {
                    const ok = await CoreAPI.showConfirm({
                        title: 'Rebuild this memory?',
                        message: 'Your model reads the whole chat again and writes the memory from the start, a call for every stretch of the chat. Undo puts back the memory you have now.',
                        confirmLabel: 'Rebuild',
                        icon: 'fa-solid fa-arrows-rotate',
                    });
                    if (ok === true) await call(`/chats/${id}/update`, 'POST', { rebuild: true });
                }, 'Could not rebuild the memory'),
                undo: () => run((id) => call(`/chats/${id}/undo`, 'POST', {}), 'Could not undo'),
                clear: () => run(async (id) => {
                    const ok = await CoreAPI.showConfirm({
                        title: 'Clear this memory?',
                        message: 'The memory is emptied and starts over from the chat\'s first message. Undo cannot bring it back.',
                        confirmLabel: 'Clear',
                        danger: true,
                        icon: 'fa-solid fa-eraser',
                    });
                    if (ok === true) await call(`/chats/${id}`, 'DELETE');
                }, 'Could not clear the memory'),
            };
            bodyEl.addEventListener('click', (e) => {
                const verb = e.target.closest('[data-mem]')?.dataset.mem;
                if (verbs[verb]) void verbs[verb]();
            });

            return { show, rest, reload, reloadSoon, chatId: () => chatId, isOpen: follow.isOpen };
        }

        ctx.ui.addSettingsSection((el) => {
            const place = ctx.settings.get('placement') || 'pre_history';
            const range = (key) => `min="${SETTING_LIMITS[key][0]}" max="${SETTING_LIMITS[key][1]}"`;
            el.innerHTML = `
                <div class="settings-row">
                    <label>Connection</label>
                    <select class="cl-select-fluid" data-mem-profile><option value="">The one the chat uses</option></select>
                    <span class="settings-hint cl-hidden" data-mem-profile-gone>The connection picked here was deleted, so the one the chat uses runs instead.</span>
                </div>
                <div class="settings-row">
                    <label>Update after this many new messages</label>
                    <div class="settings-input-group u-row">
                        <input type="number" class="glass-input mem-count" data-mem-num="every" ${range('every')} step="1" value="${esc(setting('every'))}">
                        <span class="settings-hint u-m-0">0 = only when you ask, in the chat's Memory window</span>
                    </div>
                </div>
                <div class="settings-row">
                    <label>Leave out the newest messages</label>
                    <div class="settings-input-group u-row">
                        <input type="number" class="glass-input mem-count" data-mem-num="keep" ${range('keep')} step="1" value="${esc(setting('keep'))}">
                        <span class="settings-hint u-m-0">The prompt holds them already</span>
                    </div>
                </div>
                <div class="settings-row">
                    <label>Length, in words</label>
                    <input type="number" class="glass-input mem-count" data-mem-num="words" ${range('words')} step="10" value="${esc(setting('words'))}">
                </div>
                <div class="settings-row">
                    <label>Where it goes in the prompt</label>
                    <select class="cl-select-fluid" data-mem-place>
                        <option value="pre_history">Before the conversation</option>
                        <option value="post_history">After the conversation</option>
                        <option value="at_depth">Inside the conversation</option>
                        <option value="none">Only where a preset writes {{memory}}</option>
                    </select>
                </div>
                <div class="settings-row" data-mem-depth-row>
                    <label>Messages back from the newest</label>
                    <input type="number" class="glass-input mem-count" data-mem-num="depth" ${range('depth')} step="1" value="${esc(setting('depth'))}">
                </div>
                <div class="settings-row">
                    <label>Template</label>
                    <textarea class="glass-input mem-template" rows="2" data-mem-template>\n${esc(ctx.settings.get('template') ?? '')}</textarea>
                    <span class="settings-hint">{{memory}} is the memory's text, and the other macros work here too. Each chat's memory opens from the Memory window in the conversation.</span>
                </div>`;
            for (const input of el.querySelectorAll('[data-mem-num]')) {
                input.addEventListener('change', () => {
                    const key = input.dataset.memNum;
                    const v = settingNumber(key, input.value, ctx.settings.defaults[key]);
                    input.value = String(v);
                    ctx.settings.set(key, v);
                });
            }
            const placeSelect = el.querySelector('[data-mem-place]');
            const depthRow = el.querySelector('[data-mem-depth-row]');
            placeSelect.value = place;
            depthRow.hidden = place !== 'at_depth';
            placeSelect.addEventListener('change', () => {
                ctx.settings.set('placement', placeSelect.value);
                depthRow.hidden = placeSelect.value !== 'at_depth';
            });
            CoreAPI.initCustomSelect(placeSelect);
            el.querySelector('[data-mem-template]').addEventListener('change', (e) => ctx.settings.set('template', e.target.value));
            // a pick deleted since shows the chats' own connection, which the server runs instead, and says why
            void ctx.ui.connectionSelect(el.querySelector('[data-mem-profile]')).then(({ gone }) => el.querySelector('[data-mem-profile-gone]').classList.toggle('cl-hidden', !gone));
        });
    },
};
