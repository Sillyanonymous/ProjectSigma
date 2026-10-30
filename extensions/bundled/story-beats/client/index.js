// Story Beats, the client half: the conversation's Story Beats window, commands any extension may run, and the settings.
import { SETTING_LIMITS, settingNumber, STRATEGIES } from './limits.js';
import { mountBeats } from './panel.js';

const ID = 'story-beats';
const NEXT_SHOWN = 3;

const titleOf = (b) => (b?.title?.trim() ? b.title.trim() : '(untitled)');

export default {
    init(ctx) {
        const { CoreAPI } = ctx;
        const esc = (s) => CoreAPI.escapeHtml(s);
        const call = ctx.server.call;
        const at = (id) => encodeURIComponent(id);
        // the open conversation, as this page last heard it
        let openChat = null;

        // ======================================== every write to the server half, a verb each
        async function addBeats(chatId, beats) {
            return call(`/chats/${at(chatId)}/beats`, 'POST', { beats });
        }
        async function editBeat(chatId, beatId, fields) {
            return call(`/chats/${at(chatId)}/beats/${at(beatId)}`, 'PUT', fields);
        }
        async function deleteBeat(chatId, beat) {
            const ok = await CoreAPI.showConfirm({
                title: `Delete ${titleOf(beat)}?`,
                message: 'The beat leaves this chat, and no other beat waits on it any more.',
                confirmLabel: 'Delete',
                danger: true,
                icon: 'fa-solid fa-trash',
            });
            if (ok !== true) return null;
            return call(`/chats/${at(chatId)}/beats/${at(beat.id)}`, 'DELETE');
        }
        async function reorderBeats(chatId, ids) {
            return call(`/chats/${at(chatId)}/order`, 'PUT', { ids });
        }
        async function changeStatus(chatId, beatId, status, { force = false, source = 'reader' } = {}) {
            return call(`/chats/${at(chatId)}/beats/${at(beatId)}/status`, 'PUT', { status, force, source });
        }
        async function activateNext(chatId, source = 'reader') {
            return call(`/chats/${at(chatId)}/next`, 'POST', { source });
        }
        async function runDirector(chatId) {
            return call(`/chats/${at(chatId)}/direct`, 'POST', {});
        }
        async function clearLog(chatId) {
            const ok = await CoreAPI.showConfirm({
                title: 'Clear the director\'s log?',
                message: 'Every entry of this chat\'s log goes. The beats stay as they are.',
                confirmLabel: 'Clear',
                danger: true,
                icon: 'fa-solid fa-eraser',
            });
            if (ok !== true) return null;
            return call(`/chats/${at(chatId)}/log`, 'DELETE');
        }
        async function draftFromNotes(chatId, notes, signal) {
            return call(`/chats/${at(chatId)}/draft`, 'POST', { notes }, { signal });
        }
        async function discussStep(chatId, history, context, signal) {
            return call(`/chats/${at(chatId)}/discuss`, 'POST', { history, context }, { signal });
        }
        const api = {
            addBeats, editBeat, deleteBeat, reorderBeats, changeStatus, activateNext, runDirector, clearLog, draftFromNotes, discussStep,
            read: (chatId) => call(`/chats/${at(chatId)}`),
            readLog: (chatId) => call(`/chats/${at(chatId)}/log`),
        };

        // ======================================== the window
        let view = null;
        ctx.ui.addChatWindow({
            id: 'beats',
            label: 'Story Beats',
            icon: 'fa-list-check',
            min: { w: 28, h: 40 },
            size: { w: 36, h: 72 },
            // render runs once, then onOpen on every open (the first included), which reads
            render(bodyEl) { view = mountBeats(bodyEl, ctx, api); },
            onOpen: ({ chatId }) => view?.show(chatId),
            onClose: () => view?.rest(),
        });
        ctx.events.on('conversation.changed', ({ chatId }) => {
            openChat = chatId || null;
            if (view?.isOpen() && chatId && chatId !== view.chatId()) view.show(chatId);
        });
        // the server's word on the shown chat's beats or log, and the messages that move their counters
        ctx.events.on('chat.updated', ({ ids, fields }) => {
            if (view?.isOpen() && ids.includes(view.chatId()) && fields.some(f => f.startsWith(`${ID}.`))) view.reload();
        });
        for (const name of ['message.created', 'message.updated', 'message.deleted']) {
            ctx.events.on(name, ({ chatId }) => { if (view?.isOpen() && chatId === view.chatId()) view.reloadSoon(); });
        }
        ctx.events.on('library.changed', () => { if (view?.isOpen()) view.reloadSoon(); });
        ctx.events.on('settings.changed', ({ keys, all }) => {
            if (view?.isOpen() && (all || keys.some(k => k.startsWith(`ext:${ID}:`)))) view.reloadSoon();
        });

        // ======================================== commands: the chat named, else the one on show
        const chatFor = (args) => (typeof args?.chatId === 'string' && args.chatId) || view?.chatId() || openChat;
        const quiet = (e) => { if (e?.status === 404 || e?.status === 409) return null; throw e; };
        ctx.commands.register('next', async (args) => {
            const chatId = chatFor(args);
            if (!chatId) return null;
            return activateNext(chatId, 'command').then(out => out.beat, quiet);
        }, { title: 'Story Beats: start the next pending beat' });
        ctx.commands.register('status', async (args) => {
            const chatId = chatFor(args);
            if (!chatId) return null;
            const v = await api.read(chatId);
            const pick = (status) => v.beats.filter(b => b.status === status).map(b => ({ id: b.id, title: titleOf(b), weight: b.weight }));
            const active = pick('active');
            const next = v.beats.filter(b => b.status === 'pending').slice(0, NEXT_SHOWN).map(b => ({ id: b.id, title: titleOf(b), waiting: b.waitsOn.length > 0 }));
            const text = [
                active.length ? `Active:\n${active.map(b => `- [${b.weight}] ${b.title}`).join('\n')}` : 'Active: none',
                next.length ? `Next:\n${next.map(b => `- ${b.title}${b.waiting ? ' (waiting)' : ''}`).join('\n')}` : 'Next: none',
            ].join('\n');
            return { chatId, active, suggested: pick('suggested'), next, text };
        }, { title: 'Story Beats: the active beats and the next pending ones' });
        ctx.commands.register('skip', async (args) => {
            const chatId = chatFor(args);
            if (!chatId) return null;
            let beatId = typeof args?.id === 'string' ? args.id : null;
            if (!beatId) {
                const { beats } = await api.read(chatId);
                beatId = (beats.find(b => b.status === 'active') || beats.find(b => b.status === 'pending' && !b.waitsOn.length))?.id;
            }
            if (!beatId) return null;
            return changeStatus(chatId, beatId, 'skipped', { source: 'command' }).then(out => out.beat, quiet);
        }, { title: 'Story Beats: skip a beat (the active one when none is named)' });
        ctx.commands.register('force', async (args) => {
            if (typeof args?.id !== 'string' || !args.id) throw new Error('force names a beat by its id');
            const chatId = chatFor(args);
            if (!chatId) return null;
            return changeStatus(chatId, args.id, 'active', { force: true, source: 'command' }).then(out => out.beat, quiet);
        }, { title: 'Story Beats: start a beat now, whatever it waits on' });

        // ======================================== the settings
        ctx.ui.addSettingsSection((el) => {
            const on = (key) => (ctx.settings.get(key) === true ? ' checked' : '');
            const range = (key) => `min="${SETTING_LIMITS[key][0]}" max="${SETTING_LIMITS[key][1]}"`;
            const num = (key) => settingNumber(key, ctx.settings.get(key), ctx.settings.defaults[key]);
            el.innerHTML = `
                <div class="settings-row">
                    <label>Connection</label>
                    <select class="cl-select-fluid" data-sb-profile><option value="">The one the chat uses</option></select>
                    <span class="settings-hint cl-hidden" data-sb-profile-gone>The connection picked here was deleted, so the one the chat uses runs instead.</span>
                    <span class="settings-hint">The director and the planner ask this model. A small, quick one does well.</span>
                </div>
                <div class="settings-row">
                    <label>Most output tokens</label>
                    <input type="number" class="glass-input sb-count-wide" data-sb-num="maxTokens" ${range('maxTokens')} step="1024" value="${esc(num('maxTokens'))}">
                    <span class="settings-hint">The longest answer the director or the planner may write. A full plan of 50 beats takes up to about 6000.</span>
                </div>
                <div class="settings-row">
                    <label><input type="checkbox" class="cl-switch-input" data-sb-flag="reasoning"${on('reasoning')}><span class="cl-switch" aria-hidden="true"></span> A reasoning model: give it room to think</label>
                    <span class="settings-hint">A model that thinks before it answers spends its output on the thinking first, so it is given this much more.</span>
                </div>
                <div class="settings-row" data-sb-reasoning-row>
                    <label>Room to think</label>
                    <input type="number" class="glass-input sb-count-wide" data-sb-num="reasoningTokens" ${range('reasoningTokens')} step="1024" value="${esc(num('reasoningTokens'))}">
                </div>
                <div class="settings-group-title sb-set-title"><i class="fa-solid fa-clapperboard" aria-hidden="true"></i> The director</div>
                <div class="settings-row">
                    <label><input type="checkbox" class="cl-switch-input" data-sb-flag="director"${on('director')}><span class="cl-switch" aria-hidden="true"></span> Read the chat every few replies</label>
                    <span class="settings-hint">Off, beats start and finish only when you say so, or when you press Run Director Now.</span>
                </div>
                <div class="settings-row">
                    <label>How it paces the story</label>
                    <select class="cl-select-fluid" data-sb-choice="strategy">
                        <option value="adaptive">Adaptive: your model starts and finishes beats</option>
                        <option value="time-gated">Time-gated: a beat starts on the clock, your model finishes them</option>
                        <option value="strict">Strict: one beat at a time, in order, no model</option>
                    </select>
                </div>
                <div class="settings-row">
                    <label>Every this many replies</label>
                    <input type="number" class="glass-input sb-count" data-sb-num="every" ${range('every')} step="1" value="${esc(num('every'))}">
                </div>
                <div class="settings-row">
                    <label>Messages it reads</label>
                    <input type="number" class="glass-input sb-count" data-sb-num="messages" ${range('messages')} step="1" value="${esc(num('messages'))}">
                    <span class="settings-hint">The newest messages of the chat, for the director and for a planning talk that shares the story.</span>
                </div>
                <div class="settings-row">
                    <label><input type="checkbox" class="cl-switch-input" data-sb-flag="confirm"${on('confirm')}><span class="cl-switch" aria-hidden="true"></span> Ask before a firm or hard beat starts</label>
                    <span class="settings-hint">The director suggests it instead, and the window offers Accept and Dismiss.</span>
                </div>
                <div class="settings-group-title sb-set-title"><i class="fa-solid fa-scroll" aria-hidden="true"></i> In the prompt</div>
                <div class="settings-row">
                    <label>Sent as</label>
                    <select class="cl-select-fluid" data-sb-choice="role">
                        <option value="system">A system note</option>
                        <option value="user">A user note</option>
                    </select>
                </div>
                <div class="settings-row">
                    <label>Messages back from the newest</label>
                    <input type="number" class="glass-input sb-count" data-sb-num="depth" ${range('depth')} step="1" value="${esc(num('depth'))}">
                </div>
                <div class="settings-row">
                    <label>At most this many characters</label>
                    <input type="number" class="glass-input sb-count-wide" data-sb-num="budget" ${range('budget')} step="100" value="${esc(num('budget'))}">
                    <span class="settings-hint">Past it, the beats active longest leave the prompt first. Commands for other extensions: story-beats.next, .status, .skip and .force.</span>
                </div>`;
            const reasoningRow = el.querySelector('[data-sb-reasoning-row]');
            reasoningRow.hidden = ctx.settings.get('reasoning') !== true;
            for (const input of el.querySelectorAll('[data-sb-flag]')) {
                input.addEventListener('change', () => {
                    ctx.settings.set(input.dataset.sbFlag, input.checked);
                    if (input.dataset.sbFlag === 'reasoning') reasoningRow.hidden = !input.checked;
                });
            }
            for (const input of el.querySelectorAll('[data-sb-num]')) {
                input.addEventListener('change', () => {
                    const key = input.dataset.sbNum;
                    const v = settingNumber(key, input.value, ctx.settings.defaults[key]);
                    input.value = String(v);
                    ctx.settings.set(key, v);
                });
            }
            for (const select of el.querySelectorAll('[data-sb-choice]')) {
                const key = select.dataset.sbChoice;
                const stored = ctx.settings.get(key);
                select.value = key === 'strategy' ? (STRATEGIES.includes(stored) ? stored : 'adaptive') : (stored === 'user' ? 'user' : 'system');
                select.addEventListener('change', () => ctx.settings.set(key, select.value));
                CoreAPI.initCustomSelect(select);
            }
            // a pick deleted since shows the chats' own connection, which the server runs instead, and says why
            void ctx.ui.connectionSelect(el.querySelector('[data-sb-profile]')).then(({ gone }) => el.querySelector('[data-sb-profile-gone]').classList.toggle('cl-hidden', !gone));
        });
    },
};
