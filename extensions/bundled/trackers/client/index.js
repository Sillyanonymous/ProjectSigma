// SPDX-License-Identifier: MIT

// Trackers, the client half: the conversation window (panel.js), Trackers at This Message, the editor
// and the settings.
import { mountTrackers } from './panel.js';
import { stateHtml, setEscaper } from './render.js';
import { createEditor } from './editor.js';
import { SETTING_LIMITS, settingNumber } from './model.js';

const ID = 'trackers';

export default {
    init(ctx) {
        const { CoreAPI } = ctx;
        const esc = (s) => CoreAPI.escapeHtml(s);
        setEscaper(esc);
        const read = ctx.server.call;

        // the definition editor, one dialog the window and the settings open
        const editor = createEditor(ctx);

        let view = null;
        ctx.ui.addChatWindow({
            id: 'trackers',
            label: 'Trackers',
            icon: 'fa-clipboard-list',
            min: { w: 26, h: 30 },
            size: { w: 32, h: 72 },
            // render runs once, then onOpen on every open (the first included), which reads
            render(bodyEl) { view = mountTrackers(bodyEl, ctx, { edit: (opts) => editor.open(opts) }); },
            onOpen: ({ chatId, character }) => view?.show(chatId, character),
            onClose: () => view?.rest(),
            // the chat's character written: its name and face are what a card matches
            follow: (detail, { character }) => { if (view?.isOpen() && character && detail?.charId === character.id) view.setCharacter(character); },
        });
        // the conversation switched chats under the open window; a re-announced chat only takes its character, the latest wins
        let following = 0;
        ctx.events.on('conversation.changed', async ({ chatId, charId }) => {
            if (!view?.isOpen() || !chatId) return;
            const mine = ++following;
            if (chatId !== view.chatId()) view.show(chatId, charId ? CoreAPI.getCharacterById(charId) || null : null);
            if (!charId) return;
            const character = CoreAPI.getCharacterById(charId) || await CoreAPI.ensureCharacterById(charId);
            if (mine === following && character && chatId === view.chatId()) view.setCharacter(character);
        });
        // the server's word on the shown chat's trackers, and the chat's messages moving under them
        ctx.events.on('chat.updated', ({ ids, fields }) => {
            if (view?.isOpen() && ids.includes(view.chatId()) && fields.some(f => f.startsWith(`${ID}.`))) view.reload();
        });
        for (const name of ['message.created', 'message.updated', 'message.deleted']) {
            ctx.events.on(name, ({ chatId }) => { if (view?.isOpen() && chatId === view.chatId()) view.reloadSoon(); });
        }
        // nothing itemized (a reconnect, an import elsewhere): what was written meanwhile is read again
        ctx.events.on('library.changed', () => { if (view?.isOpen()) view.reloadSoon(); });
        // the account's automatic runs, switched in Settings while the window is open, are what its switch says
        ctx.events.on('settings.changed', ({ keys, all }) => {
            if (view?.isOpen() && (all || keys.includes(`ext:${ID}:auto`))) view.reloadSoon();
        });

        // ---- Trackers at This Message: what each tracker held then, read only, in a dialog of the app's shell
        const atMessage = ctx.ui.dialog({ id: 'at-message', label: 'Trackers at This Message', icon: 'fa-clipboard-list', className: 'tkr-at-content', size: true });
        async function showAt(chatId, seq) {
            void atMessage.close({ force: true });
            let states;
            try { states = await read(`/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(seq)}`); } catch (e) {
                CoreAPI.showToast(`Could not read the trackers: ${e.message}`, 'error');
                return;
            }
            const list = states.trackers || [];
            const body = atMessage.open({ title: `Trackers at message #${seq}` });
            body.classList.add('tkr-at-body');
            body.innerHTML = list.length ? list.map(t => `
                <section class="tkr-at-one">
                    <h4 class="tkr-at-name"><i class="fa-solid ${esc(t.def.icon || 'fa-clipboard-list')}" aria-hidden="true"></i> ${esc(t.name)}
                        <span class="tkr-at-when">${t.at ? `as of message #${esc(t.at.seq)}` : 'nothing kept by then'}</span></h4>
                    ${t.state ? stateHtml(t.def, t.state) : ''}
                </section>`).join('') : '<p class="tkr-none">This chat keeps no trackers.</p>';
        }
        ctx.ui.addAction('message', {
            id: 'at-message',
            label: 'Trackers at This Message',
            icon: 'fa-clipboard-list',
            run: ({ chatId, seq }) => showAt(chatId, seq),
        });

        // ---- the settings
        ctx.ui.addSettingsSection((el) => {
            const num = (key) => settingNumber(key, ctx.settings.get(key), ctx.settings.defaults[key]);
            const range = (key) => `min="${SETTING_LIMITS[key][0]}" max="${SETTING_LIMITS[key][1]}"`;
            const place = ctx.settings.get('placement') || 'at_depth';
            el.innerHTML = `
                <div class="settings-row">
                    <label>Connection</label>
                    <select class="cl-select-fluid" data-tkr-profile><option value="">The one the chat uses</option></select>
                    <span class="settings-hint cl-hidden" data-tkr-profile-gone>The connection picked here was deleted, so the one the chat uses runs instead.</span>
                    <span class="settings-hint">Keeping a tracker is a small job: a fast, cheap model is usually the right one, and your chats keep their own.</span>
                </div>
                <div class="settings-row">
                    <label>
                        <input type="checkbox" class="cl-switch-input" data-tkr-auto-all><span class="cl-switch" aria-hidden="true"></span>
                        <span>Update after every reply</span>
                    </label>
                    <span class="settings-hint">Off, a tracker updates only when you press Update Now in its window. On, each reply costs one call per tracker the chat keeps.</span>
                </div>
                <div class="settings-row">
                    <label>Messages it reads</label>
                    <div class="settings-input-group u-row">
                        <input type="number" class="glass-input tkr-count" data-tkr-num="turns" ${range('turns')} step="1" value="${esc(num('turns'))}">
                        <span class="settings-hint u-m-0">The newest ones, up to the reply</span>
                    </div>
                </div>
                <div class="settings-row">
                    <label>Where it goes in the prompt</label>
                    <select class="cl-select-fluid" data-tkr-place>
                        <option value="at_depth">Inside the conversation</option>
                        <option value="pre_history">Before the conversation</option>
                        <option value="post_history">After the conversation</option>
                        <option value="none">Only where a preset writes {{trackers}}</option>
                    </select>
                </div>
                <div class="settings-row" data-tkr-depth-row>
                    <label>Messages back from the newest</label>
                    <input type="number" class="glass-input tkr-count" data-tkr-num="depth" ${range('depth')} step="1" value="${esc(num('depth'))}">
                </div>
                <div class="settings-row">
                    <label>Sent as</label>
                    <select class="cl-select-fluid" data-tkr-role>
                        <option value="system">System</option>
                        <option value="user">User</option>
                        <option value="assistant">Assistant</option>
                    </select>
                    <span class="settings-hint">Each chat's trackers open from the Trackers window in the conversation.</span>
                </div>
                <div class="settings-row">
                    <button type="button" class="settings-action-btn" data-tkr-edit><i class="fa-solid fa-pen-ruler" aria-hidden="true"></i> Edit Your Trackers</button>
                </div>`;
            el.querySelector('[data-tkr-edit]').addEventListener('click', () => editor.open({}));
            for (const input of el.querySelectorAll('[data-tkr-num]')) {
                input.addEventListener('change', () => {
                    const key = input.dataset.tkrNum;
                    const v = settingNumber(key, input.value, ctx.settings.defaults[key]);
                    input.value = String(v);
                    ctx.settings.set(key, v);
                });
            }
            const autoAll = el.querySelector('[data-tkr-auto-all]');
            autoAll.checked = ctx.settings.get('auto') !== false;
            autoAll.addEventListener('change', () => ctx.settings.set('auto', autoAll.checked));
            const placeSelect = el.querySelector('[data-tkr-place]');
            const depthRow = el.querySelector('[data-tkr-depth-row]');
            placeSelect.value = place;
            depthRow.hidden = place !== 'at_depth';
            placeSelect.addEventListener('change', () => {
                ctx.settings.set('placement', placeSelect.value);
                depthRow.hidden = placeSelect.value !== 'at_depth';
            });
            CoreAPI.initCustomSelect(placeSelect);
            const roleSelect = el.querySelector('[data-tkr-role]');
            roleSelect.value = ctx.settings.get('role') || 'system';
            roleSelect.addEventListener('change', () => ctx.settings.set('role', roleSelect.value));
            CoreAPI.initCustomSelect(roleSelect);
            // a pick deleted since shows the chats' own connection, which the server runs instead, and says why
            void ctx.ui.connectionSelect(el.querySelector('[data-tkr-profile]')).then(({ gone }) => el.querySelector('[data-tkr-profile-gone]').classList.toggle('cl-hidden', !gone));
        });
    },
};
