// SPDX-License-Identifier: MIT

// Translator, the client half: a message's stored translation, the verbs that ask for one, and each
// chat's choices in a window.

const ID = 'translator';
// the root class the display mode rides on, so switching it rebuilds no row
const REPLACE_CLASS = 'xtr-mode-replace';

// what a toggle offers follows the display mode and whether its row is flipped
function paintToggle(btn) {
    const replace = document.documentElement.classList.contains(REPLACE_CLASS);
    const flipped = !!btn.closest('.xtr-wrap')?.classList.contains('xtr-flipped');
    btn.textContent = replace ? (flipped ? 'Show the translation' : 'Show the original') : (flipped ? 'Show' : 'Hide');
}

export default {
    init(ctx) {
        const { CoreAPI } = ctx;
        const esc = (s) => CoreAPI.escapeHtml(s);
        const call = ctx.server.call;
        // the stored translation, only when it is of the text shown now: the server keeps a digest of what it translated
        const { shown, digest } = ctx.messages;
        const currentTranslation = (msg) => {
            const t = msg?.extra?.translator;
            if (!t || typeof t.text !== 'string' || !t.text || typeof t.source !== 'string') return null;
            return t.source === digest(shown(msg)) ? t : null;
        };

        // each chat's choices as the server last answered; a report drops the entry, so the next read asks again
        const choices = new Map();
        // joined only while the open chat names a sending language: any composer.send filter makes every send wait
        let openChatId = null;
        let leaveSend = null;
        const syncSend = (outgoing) => {
            if (outgoing && !leaveSend) leaveSend = ctx.hooks.add('composer.send', sendFilter);
            else if (!outgoing && leaveSend) { leaveSend(); leaveSend = null; }
        };
        // every answer the server gives lands here, so the open chat is followed wherever it was read
        const remember = (chatId, c) => {
            choices.set(chatId, c);
            if (chatId === openChatId) syncSend(c?.outgoing);
            return c;
        };
        // one read however many ask; a report on the chat meanwhile drops it, and its late answer is not kept
        const reading = new Map();
        const choiceOf = (chatId) => {
            if (choices.has(chatId)) return Promise.resolve(choices.get(chatId));
            if (!reading.has(chatId)) {
                const p = call(`/chats/${chatId}`)
                    .then(c => (reading.get(chatId) === p ? remember(chatId, c) : c))
                    .finally(() => { if (reading.get(chatId) === p) reading.delete(chatId); });
                reading.set(chatId, p);
            }
            return reading.get(chatId);
        };
        // the server reports its own field beside the chat's metadata, which every reply's commit writes too
        ctx.events.on('chat.updated', ({ ids, fields }) => {
            if (!fields.some(f => f.startsWith(`${ID}.`))) return;
            for (const id of ids) { choices.delete(id); reading.delete(id); }
            if (openChatId && ids.includes(openChatId)) void followSend(openChatId);
        });
        // a resync itemizes nothing: no read is trusted, so the choices, the open window and the mode are read again
        ctx.events.on('library.changed', () => {
            choices.clear();
            reading.clear();
            if (openChatId) void followSend(openChatId);
            if (view?.isOpen() && view.chatId()) void view.show(view.chatId());
            applyMode();
        });

        const verbs = {
            // the message by its place and its own id: one renumbered since is refused, never another translated
            translateMessage: (chatId, seq, messageId = null) => call(`/chats/${chatId}/messages/${seq}`, 'POST', Number.isInteger(messageId) ? { messageId } : {}),
            translateText: async (text, lang, chatId = null) => (await call('/text', 'POST', { text, lang, ...(chatId ? { chatId } : {}) })).text,
            setChoices: async (chatId, patch) => remember(chatId, await call(`/chats/${chatId}`, 'PUT', patch)),
        };
        // a message asked for once at a time; the stored translation reaches the row through the feed
        const working = new Set();
        const translateRow = async (chatId, seq, messageId, { quiet = false } = {}) => {
            const key = `${chatId}:${Number.isInteger(messageId) ? `id${messageId}` : seq}`;
            if (working.has(key)) return;
            working.add(key);
            if (!quiet) CoreAPI.showToast('Translating...', 'info');
            try {
                await verbs.translateMessage(chatId, seq, messageId);
            } catch (e) {
                CoreAPI.showToast(`Could not translate: ${e.message}`, 'error');
            } finally {
                working.delete(key);
            }
        };

        // the stored translation, while it is of the text the message shows, rendered as the row
        // renders its own
        ctx.hooks.add('message.render', (html, { message, format }) => {
            const t = currentTranslation(message);
            if (!t) return undefined;
            return `<div class="xtr-wrap"><div class="xtr-original">${html}</div>`
                + `<div class="xtr-translation"><div class="xtr-head"><i class="fa-solid fa-language" aria-hidden="true"></i>`
                + `<span class="xtr-lang">${esc(t.lang)}</span></div>`
                + `<div class="xtr-text">${format(t.text)}</div></div></div>`;
        });
        // the toggle between the translation and the original; a button cannot pass the gate
        ctx.hooks.add('message.enhance', ({ el }) => {
            const head = el.querySelector('.xtr-head');
            const wrap = el.querySelector('.xtr-wrap');
            if (!head || !wrap || head.querySelector('.xtr-toggle')) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'xtr-toggle';
            btn.addEventListener('click', () => {
                wrap.classList.toggle('xtr-flipped');
                paintToggle(btn);
            });
            head.appendChild(btn);
            paintToggle(btn);
        });

        ctx.ui.addAction('message', {
            id: 'translate', label: 'Translate', icon: 'fa-language',
            when: ({ message }) => !!shown(message).trim() && !currentTranslation(message),
            run: ({ chatId, seq, messageId }) => translateRow(chatId, seq, messageId),
        });
        ctx.ui.addAction('message', {
            id: 'retranslate', label: 'Translate Again', icon: 'fa-language',
            when: ({ message }) => !!currentTranslation(message),
            run: ({ chatId, seq, messageId }) => translateRow(chatId, seq, messageId),
        });

        // each new reply, when the chat asks for it
        ctx.events.on('generation.ended', async ({ chatId, seq, messageId }) => {
            if (!Number.isInteger(seq)) return;
            let auto = false;
            try { auto = (await choiceOf(chatId)).auto; } catch { return; }
            if (auto) await translateRow(chatId, seq, messageId, { quiet: true });
        });
        // what the reader sends, when the chat names a language for it; a failure sends it as typed
        async function sendFilter(text, { chatId }) {
            const { outgoing } = await choiceOf(chatId);
            if (!outgoing) return undefined;
            try {
                return await verbs.translateText(text, outgoing, chatId);
            } catch (e) {
                CoreAPI.showToast(`Sent as you wrote it: ${e.message}`, 'warning');
                return undefined;
            }
        }
        // the open chat's choices, read or already held, decide the filter; a read that lands after
        // another chat opened decides nothing
        async function followSend(chatId) {
            if (!chatId) return syncSend('');
            let c = null;
            try { c = await choiceOf(chatId); } catch { c = null; }
            if (chatId === openChatId) syncSend(c?.outgoing || '');
        }

        let view = null;
        ctx.ui.addChatWindow({
            id: 'translator',
            label: 'Translator',
            icon: 'fa-language',
            min: { w: 22, h: 24 },
            size: { w: 30, h: 40 },
            render(bodyEl) { view = mountWindow(bodyEl); },
            onOpen: ({ chatId }) => view?.show(chatId),
            onClose: () => view?.rest(),
        });
        ctx.events.on('conversation.changed', ({ chatId }) => {
            openChatId = chatId || null;
            void followSend(openChatId);
            if (view?.isOpen() && chatId) void view.show(chatId);
        });

        function mountWindow(bodyEl) {
            bodyEl.innerHTML = `
                <div class="xtr-win">
                    <label class="xtr-field">
                        <span class="xtr-label">Translate replies into</span>
                        <input type="search" autocomplete="one-time-code" class="cl-cwin-input" data-xtr-lang maxlength="40" spellcheck="false">
                    </label>
                    <label class="xtr-switch">
                        <input type="checkbox" class="cl-switch-input" data-xtr-auto><span class="cl-switch" aria-hidden="true"></span>
                        <span>Translate each new reply</span>
                    </label>
                    <label class="xtr-field">
                        <span class="xtr-label">Translate what I send into</span>
                        <input type="search" autocomplete="one-time-code" class="cl-cwin-input" data-xtr-out maxlength="40" spellcheck="false" placeholder="Nothing: send as I write">
                    </label>
                    <p class="xtr-hint">A message's own menu translates it once, and the settings choose the connection and where a translation shows.</p>
                    <div class="cl-cwin-empty cl-hidden" data-xtr-empty><i class="fa-solid fa-language" aria-hidden="true"></i><p data-xtr-empty-text></p></div>
                </div>`;
            const lang = bodyEl.querySelector('[data-xtr-lang]');
            const auto = bodyEl.querySelector('[data-xtr-auto]');
            const out = bodyEl.querySelector('[data-xtr-out]');
            const empty = bodyEl.querySelector('[data-xtr-empty]');
            let chatId = null;
            let open = false;
            // whether the fields hold chatId's choices: not while a read is on its way, nor after one failed
            let held = false;
            let seq = 0;
            // the chat's choices, or in their place why there are none yet, so no field shows another chats
            const paint = (c, error = null) => {
                held = !!c;
                const blank = c ? null : error ? `This chat's translation choices could not be read: ${error}` : 'Reading this chat\'s translation choices...';
                for (const el of bodyEl.querySelectorAll('.xtr-win > :not([data-xtr-empty])')) el.classList.toggle('cl-hidden', !!blank);
                empty.classList.toggle('cl-hidden', !blank);
                empty.classList.toggle('is-error', !!error);
                bodyEl.querySelector('[data-xtr-empty-text]').textContent = blank || '';
                lang.value = c?.lang ?? '';
                auto.checked = !!c?.auto;
                out.value = c?.outgoing ?? '';
            };
            async function show(id) {
                open = true;
                const mine = ++seq;
                if (id !== chatId) {
                    chatId = id;
                    paint(null);
                }
                try {
                    const c = await choiceOf(id);
                    if (mine === seq) paint(c);
                } catch (e) {
                    if (mine === seq) paint(null, e.message);
                }
            }
            const save = async (patch) => {
                const target = chatId;
                if (!target || !held) return;
                try {
                    const next = await verbs.setChoices(target, patch);
                    if (chatId === target) paint(next);
                } catch (e) {
                    CoreAPI.showToast(`Could not save: ${e.message}`, 'error');
                    choices.delete(target);
                    if (chatId === target) await show(target);
                }
            };
            lang.addEventListener('change', () => save({ lang: lang.value.trim() || null }));
            auto.addEventListener('change', () => save({ auto: auto.checked }));
            out.addEventListener('change', () => save({ outgoing: out.value.trim() || null }));
            return { show, rest: () => { open = false; }, isOpen: () => open, chatId: () => chatId };
        }

        const applyMode = () => {
            document.documentElement.classList.toggle(REPLACE_CLASS, ctx.settings.get('mode') === 'replace');
            for (const btn of document.querySelectorAll('.xtr-toggle')) paintToggle(btn);
        };
        applyMode();
        // the mode switched in another tab, or on another device
        ctx.events.on('settings.changed', ({ keys, all }) => {
            if (all || keys.includes(`ext:${ID}:mode`)) applyMode();
        });
        ctx.ui.addSettingsSection((el) => {
            el.innerHTML = `
                <div class="settings-row">
                    <label>Connection</label>
                    <select class="cl-select-fluid" data-xtr-profile><option value="">The one the chat uses</option></select>
                    <span class="settings-hint cl-hidden" data-xtr-profile-gone>The connection picked here was deleted, so the one the chat uses runs instead.</span>
                </div>
                <div class="settings-row">
                    <label>Translate into</label>
                    <input type="search" autocomplete="one-time-code" class="glass-input xtr-lang-input" data-xtr-default maxlength="40" spellcheck="false" value="${esc(ctx.settings.get('lang') || 'English')}">
                    <span class="settings-hint">A chat can choose its own in its Translator window.</span>
                </div>
                <div class="settings-row">
                    <label>Show a translation</label>
                    <select class="cl-select-fluid" data-xtr-mode>
                        <option value="beneath">Beneath the message</option>
                        <option value="replace">In place of the message</option>
                    </select>
                </div>`;
            const def = el.querySelector('[data-xtr-default]');
            def.addEventListener('change', () => {
                const v = def.value.trim().slice(0, 40);
                def.value = v || 'English';
                ctx.settings.set('lang', v || 'English');
            });
            const mode = el.querySelector('[data-xtr-mode]');
            mode.value = ctx.settings.get('mode') === 'replace' ? 'replace' : 'beneath';
            mode.addEventListener('change', () => {
                ctx.settings.set('mode', mode.value);
                applyMode();
            });
            CoreAPI.initCustomSelect(mode);
            // a pick deleted since shows the chats' own connection, which the server runs instead, and says why
            void ctx.ui.connectionSelect(el.querySelector('[data-xtr-profile]')).then(({ gone }) => el.querySelector('[data-xtr-profile-gone]').classList.toggle('cl-hidden', !gone));
        });
    },
    // switched off: the display mode's class goes with it
    dispose() {
        document.documentElement.classList.remove(REPLACE_CLASS);
    },
};
