// SPDX-License-Identifier: MIT

// The Hello World tour, the client half: every page door once, small. The conversation hooks wait
// for the "hooks" setting; docs/guide.html#extensions is the guide.
const ID = 'hello-world';
const VIEW = 'ext:hello-world/tour';
const BATCH = 1000;
const POLL_MS = 1000;
const QUIET_MS = 800;
// the changes that move what the server half heard, and a resync, which names none of them
const MOVES = ['character.created', 'character.updated', 'character.deleted', 'chat.created', 'message.created', 'library.changed'];

// the published types, for an editor that reads them (docs/extensions.d.ts; copy it beside an extension of your own)
/** @typedef {import('../../../../docs/extensions').Character} Character */

/** @param {unknown} e */
const why = (e) => (e instanceof Error ? e.message : String(e));
/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** @type {import('../../../../docs/extensions').ClientExtension} */
export default {
    init(ctx) {
        const CoreAPI = ctx.CoreAPI;
        /** @param {unknown} s */
        const esc = (s) => CoreAPI.escapeHtml(s);
        ctx.log(`loaded v${ctx.manifest.version} (host api ${ctx.apiVersion})`);

        // the server half answers under /api/ext/<id>/: the host's door hands back the parsed body, and a
        // refusal throws in the server's words
        const call = ctx.server.call;
        // what this page heard since it loaded; the view shows it
        const heard = { favorites: 0, edits: 0, sends: 0 };

        // ---- a command of its own, "hello-world.greet": any extension, and the verbs below, run it by id
        ctx.commands.register('greet', ({ to } = {}) => {
            const line = `${ctx.settings.get('greeting')}, ${to || 'there'}!`;
            CoreAPI.showToast(line, 'info');
            return line;
        }, { title: 'Say hello' });
        /** @param {string} to */
        const greet = async (to) => { await ctx.commands.run('hello-world.greet', { to }); };
        // ---- a key in the app's keymap: Settings > Keyboard lists it under Hello World, and rebinds it there
        ctx.keys.register({ id: 'greet', label: 'Say hello', key: 'H', scope: 'library', run: () => greet() });
        // a message is named by its place (seq, what the reader sees) and its own id (what a write names)
        const messageName = (seq, messageId, digest = '') => {
            const about = [Number.isInteger(messageId) ? `id ${messageId}` : '', digest].filter(Boolean).join(', ');
            return about ? `message ${seq} (${about})` : `message ${seq}`;
        };

        // ---- a wrapper on one of the app's own verbs: it sees every favorite, from any surface, and hands on
        ctx.commands.wrap('character.favorite', async (next, args) => {
            const answer = await next();
            if (answer && args.value) heard.favorites += 'affected' in answer ? answer.affected.length : answer.changed;
            return answer;
        });

        // ---- a wave: the server half writes it, reports the change and answers the count
        /** @param {Readonly<Character>} character @param {string | null} [chatId] the chat it was waved from */
        const waveAt = async (character, chatId = null) => {
            try {
                const { waves } = await call(`/wave/${encodeURIComponent(character.id)}`, 'PUT', chatId ? { chatId } : null);
                // an event of its own, ext:hello-world:waved, for whoever listens (the window below does)
                ctx.events.emit('waved', { id: character.id, waves });
                CoreAPI.showToast(`Waved at ${character.name || 'them'}: ${plural(waves, 'wave', 'waves')} so far`, 'success');
                return /** @type {number} */ (waves);
            } catch (e) {
                CoreAPI.showToast(`Could not wave: ${why(e)}`, 'error');
                return null;
            }
        };

        // ---- a chip on a grid card: the row carries the count (the server half's projection), so it asks nothing
        ctx.ui.contribute('character.card.badge', {
            id: 'waves',
            render: (row) => {
                const waves = row.ext?.[ID]?.waves;
                return waves ? { icon: 'fa-hand', label: String(waves), tone: 'neutral' } : null;
            },
        });

        // ---- a tab in the character's details: the count as the server holds it, and a wave
        /** @typedef {{ pane: HTMLElement, character: Readonly<Character>, isCurrent: () => boolean, waves?: number }} TabState */
        /** @type {TabState | null} */
        let tab = null;
        /** @param {TabState} shown @param {number} waves */
        const paintTab = (shown, waves) => {
            if (!shown.isCurrent() || tab !== shown) return;
            shown.waves = waves;
            const name = esc(shown.character.name || 'this character');
            shown.pane.innerHTML = `
                <div class="hw-pane">
                    <p class="hw-line" data-hw-waves>${waves ? `You have waved at ${name} ${plural(waves, 'time', 'times')}.` : `You have not waved at ${name} yet.`}</p>
                    <div><button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-hw-wave><i class="fa-solid fa-hand" aria-hidden="true"></i> Wave</button></div>
                </div>`;
            shown.pane.querySelector('[data-hw-wave]')?.addEventListener('click', async () => {
                const n = await waveAt(shown.character);
                if (n !== null) paintTab(shown, n);
            });
        };
        /** @param {TabState} shown */
        const readTab = async (shown) => {
            try {
                const { waves } = await call(`/waves/${encodeURIComponent(shown.character.id)}`);
                if (waves !== shown.waves) paintTab(shown, waves);
            } catch (e) {
                if (shown.isCurrent() && tab === shown) shown.pane.innerHTML = `<div class="hw-pane"><p class="hw-line is-error">The waves could not be read: ${esc(why(e))}</p></div>`;
            }
        };
        ctx.ui.contribute('character.details.tab', {
            id: 'waves',
            label: 'Waves',
            icon: 'fa-hand',
            render: (pane, { character, isCurrent }) => {
                tab = { pane, character, isCurrent };
                pane.innerHTML = '<div class="hw-pane"><p class="hw-line">Reading...</p></div>';
                return readTab(tab);
            },
        });

        // ---- a window in the conversation: how the prompt reads this chat, and the character's waves
        /** @typedef {{ el: HTMLElement, chatId: string | null, charId: string | null, name: string, read: any, waves: number | null }} WindowState */
        /** @type {WindowState | null} */
        let win = null;
        const paintWindow = () => {
            if (!win) return;
            const { el, chatId, charId, name, read, waves } = win;
            const who = esc(read?.charName || name || 'nobody yet');
            el.innerHTML = `
                <div class="hw-win">
                    <p class="hw-line">${esc(ctx.settings.get('greeting'))}, ${who}.</p>
                    ${read ? `<p class="hw-line">Your prompt reads ${plural(read.read, 'message', 'messages')} of the ${read.stored} this chat stores; ${read.readable} pass the rule it reads them by.</p>
                    <p class="hw-line">Here {{hello::{{user}}}}, from {{char}} reads "${esc(read.expanded)}"</p>` : `<p class="hw-line">${chatId ? 'Reading the chat...' : 'No chat is open.'}</p>`}
                    ${charId ? `<div class="hw-row"><span class="hw-line" data-hw-win-waves>${plural(waves ?? 0, 'wave', 'waves')}</span>
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-hw-win-wave><i class="fa-solid fa-hand" aria-hidden="true"></i> Wave</button></div>` : ''}
                    <p class="hw-note">Character edits heard since this page loaded: ${heard.edits}. This body is the extension's; the window around it is the host's.</p>
                </div>`;
            el.querySelector('[data-hw-win-wave]')?.addEventListener('click', () => {
                if (win?.charId) void waveAt({ id: win.charId, name: win.read?.charName || win.name }, win.chatId);
            });
        };
        // the open chat, read while the window is open; a change reads it again once the writes settle
        const follower = ctx.chats.follow({
            read: async (chatId) => {
                const charId = win?.charId;
                const [read, waves] = await Promise.all([
                    call(`/read/${encodeURIComponent(chatId)}`).catch(() => null),
                    charId ? call(`/waves/${encodeURIComponent(charId)}`).then(r => r.waves).catch(() => null) : null,
                ]);
                return { read, waves };
            },
            /** @param {{ read: any, waves: number | null } | null} data */
            apply: (data) => {
                if (!win) return;
                win.read = data?.read ?? null;
                win.waves = data?.waves ?? null;
                paintWindow();
            },
        });
        ctx.ui.addChatWindow({
            id: 'hello',
            label: 'Hello',
            icon: 'fa-hand',
            min: { w: 22, h: 24 },
            render(el, { chatId, character }) {
                win = { el, chatId, charId: character?.id ?? null, name: character?.name ?? '', read: null, waves: null };
                paintWindow();
            },
            onOpen({ chatId, character }) {
                if (!win) return;
                Object.assign(win, { chatId, charId: character?.id ?? null, name: character?.name ?? '' });
                void follower.show(chatId);
            },
            onClose: () => follower.rest(),
            // the card can be edited from the conversation's header, so a rename reaches here
            follow(detail, { character }) {
                if (!win || !character || detail.charId !== win.charId) return;
                win.name = character.name;
                if (win.read) win.read.charName = character.name;
                paintWindow();
            },
        });
        // its own event is a plain DOM one, handed the Event: the new count, with nothing to read
        ctx.events.on(`ext:${ID}:waved`, (event) => {
            const { id, waves } = /** @type {CustomEvent} */ (event).detail || {};
            if (!win || win.charId !== id) return;
            win.waves = waves;
            paintWindow();
        });

        // ---- a listed event hands its payload, ids and never the thing: re-read what changed
        ctx.events.on('message.created', ({ chatId }) => { if (follower.isOpen() && chatId === follower.chatId()) follower.reloadSoon(); });
        ctx.events.on('character.updated', ({ ids, fields }) => {
            heard.edits += 1;
            paintWindow();
            if (tab?.isCurrent() && ids.includes(tab.character.id) && fields.includes(`${ID}.waves`)) void readTab(tab);
        });

        // ---- the conversation's hooks, joined only while "hooks" is on: a send hook makes every send wait
        /** @type {Array<() => void>} */
        let unhook = [];
        const syncHooks = () => {
            const on = !!ctx.settings.get('hooks');
            if (on === unhook.length > 0) return;
            if (!on) {
                for (const off of unhook) off();
                unhook = [];
                return;
            }
            unhook = [
                // a filter dresses the purified row; the chat purifies what it answers again
                ctx.hooks.add('message.render', (html, { message }) => {
                    const words = String(message.mes || '').split(/\s+/).filter(Boolean).length;
                    return `${html}<div class="hw-foot"><span class="hw-words">${plural(words, 'word', 'words')}</span></div>`;
                }),
                // what the sanitizer cant pass, added to the row it put in the DOM: a button, once a row
                ctx.hooks.add('message.enhance', ({ el, seq, messageId }) => {
                    const foot = el.querySelector('.hw-foot');
                    if (!foot || foot.querySelector('.hw-wave')) return;
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'hw-wave';
                    btn.title = 'Wave at This Message';
                    btn.setAttribute('aria-label', 'Wave at This Message');
                    btn.innerHTML = '<i class="fa-solid fa-hand" aria-hidden="true"></i>';
                    btn.addEventListener('click', () => { void greet(messageName(seq, messageId)); });
                    foot.appendChild(btn);
                }),
                // what the reader sends: /hello goes out as the greeting, anything else as typed
                ctx.hooks.add('composer.send', (text) => {
                    heard.sends += 1;
                    return text.trim() === '/hello' ? `${ctx.settings.get('greeting')}!` : undefined;
                }),
            ];
        };
        syncHooks();
        // the setting changed in another tab, or on another device
        ctx.events.on('settings.changed', ({ keys, all }) => {
            if (all || keys.includes(`ext:${ID}:hooks`)) syncHooks();
        });
        // a resync names nothing, a setting included: the open window, the tab and the hooks' switch are read again
        ctx.events.on('library.changed', () => {
            if (follower.isOpen()) follower.reloadSoon();
            if (tab?.isCurrent()) void readTab(tab);
            syncHooks();
        });

        // ---- the extension's row in Settings > Extensions: its settings, its store document, its server half
        ctx.ui.addSettingsSection(async (el) => {
            // load() throws on a failed read, and a save over that would reset the count, so it goes uncounted
            /** @type {number | null} */
            let opens = null;
            try {
                const doc = (await ctx.storage.load()) || { opens: 0 };
                opens = (Number(doc.opens) || 0) + 1;
                ctx.storage.save({ ...doc, opens }).catch((e) => ctx.log('storage save failed:', why(e)));
            } catch (e) {
                ctx.log('storage load failed, not counting this open:', why(e));
            }
            let server = 'The server half did not answer.';
            try { server = `The server half says hello to ${esc((await call('/hello')).hello)}.`; } catch { /* said above */ }
            /** @param {string} key */
            const on = (key) => (ctx.settings.get(key) ? ' checked' : '');
            el.innerHTML = `
                <div class="settings-row">
                    <label>Greeting</label>
                    <input type="search" autocomplete="one-time-code" class="glass-input" data-hw-set="greeting" maxlength="60" value="${esc(ctx.settings.get('greeting'))}" placeholder="${esc(ctx.settings.defaults.greeting)}">
                </div>
                <div class="settings-row">
                    <label><input type="checkbox" class="cl-switch-input" data-hw-set="hooks"${on('hooks')}><span class="cl-switch" aria-hidden="true"></span> Join the conversation</label>
                    <span class="settings-hint">A word count under each message with a wave beside it, and /hello sent as your greeting.</span>
                </div>
                <div class="settings-row">
                    <label><input type="checkbox" class="cl-switch-input" data-hw-set="loreBook"${on('loreBook')}><span class="cl-switch" aria-hidden="true"></span> Add the tour's lorebook to your chats</label>
                    <span class="settings-hint">One entry, keyed "hello", in every chat's lore scan.</span>
                </div>
                <div class="settings-row">
                    <label>A note for the prompt</label>
                    <textarea class="glass-input" rows="2" data-hw-set="promptNote" maxlength="500" placeholder="Blank adds nothing">\n${esc(ctx.settings.get('promptNote'))}</textarea>
                    <span class="settings-hint">A system line near the end of every chat's prompt.</span>
                </div>
                <p class="settings-hint">${opens === null ? 'The open count could not be read this time; see the console.'
                    : `You have opened this section ${plural(opens, 'time', 'times')}; the count lives in your own store document.`} ${server}</p>`;
            /** @type {NodeListOf<HTMLInputElement>} */
            const fields = el.querySelectorAll('[data-hw-set]');
            for (const input of fields) {
                input.addEventListener('change', () => {
                    const key = input.dataset.hwSet || '';
                    if (key === 'greeting') ctx.settings.set(key, input.value.trim() || ctx.settings.defaults.greeting);
                    else if (key === 'promptNote') ctx.settings.set(key, input.value.trim());
                    else ctx.settings.set(key, input.checked);
                    if (key === 'hooks') syncHooks();
                });
            }
        });

        // ---- a verb in every menu the app opens; the host builds each row, and its phone mirror
        ctx.ui.contribute('character.action', { id: 'wave', label: 'Wave', icon: 'fa-hand', run: async ({ character }) => { await waveAt(character); } });
        ctx.ui.contribute('chat.action', {
            id: 'wave', label: 'Wave at This Character', icon: 'fa-hand',
            when: ({ character }) => !!character,
            run: async ({ character, chatId }) => { if (character) await waveAt(character, chatId); },
        });
        // the text the message shows and its digest: what an extension stores beside what it made of a message
        ctx.ui.contribute('message.action', {
            id: 'wave', label: 'Wave at This Message', icon: 'fa-hand',
            run: async ({ seq, messageId, message }) => { await greet(messageName(seq, messageId, ctx.messages.digest(ctx.messages.shown(message)))); },
        });
        ctx.ui.contribute('lore.entry.action', {
            id: 'hello', label: 'Say Hello to This Entry', icon: 'fa-hand',
            run: async ({ world, entry }) => { await greet(entry.comment || `entry ${entry.uid} of ${world}`); },
        });
        // a chat as the chats view lists it: its row, not its character (fetch that only when a verb needs it)
        ctx.ui.contribute('chat.card.action', {
            id: 'hello', label: 'Say Hello to This Chat', icon: 'fa-hand',
            run: async ({ chat }) => { await greet(`${chat.name || 'a chat'} with ${chat.charName || 'no character'} (${chat.messageCount} messages)`); },
        });
        // a button above the composer: the greeting goes into the box as typing would put it (chat.send would send it)
        ctx.ui.contribute('composer.action', {
            id: 'hello', label: 'Write a Greeting into the Composer', icon: 'fa-hand',
            run: async () => {
                const written = await ctx.commands.run('chat.compose', { text: `${ctx.settings.get('greeting')}!`, mode: 'append' });
                if (!written) CoreAPI.showToast('The composer is busy sending; try again in a moment', 'info');
            },
        });
        // when() decides as the menu opens, against the view it opens on
        ctx.ui.contribute('app.action', {
            id: 'tour', label: 'Hello World Tour', icon: 'fa-hand',
            when: ({ view }) => view !== VIEW,
            run: async () => { await ctx.commands.run('view.switch', { view: VIEW }); },
        });
        // a selection is one request a thousand characters, never one a character
        ctx.ui.addAction('bulk', {
            id: 'wave', label: 'Wave at the Selection', icon: 'fa-hand',
            run: async ({ characters }) => {
                const ids = characters.map(c => c.id).filter(Boolean);
                if (!ids.length) return;
                let affected = 0, skipped = 0;
                for (let i = 0; i < ids.length; i += BATCH) {
                    try {
                        const out = await call('/waves', 'PUT', { ids: ids.slice(i, i + BATCH) });
                        affected += out.affected.length;
                        skipped += out.skipped.length;
                    } catch (e) {
                        // the requests before this one are written: say how many, then why the rest are not
                        CoreAPI.showToast(`${affected ? `Waved at ${plural(affected, 'character', 'characters')} before it stopped; the rest were not` : 'Waved at nobody'}: ${why(e)}`, 'error');
                        return;
                    }
                }
                const done = `Waved at ${plural(affected, 'character', 'characters')}`;
                CoreAPI.showToast(skipped ? `${done}; ${skipped} no longer in the library` : done, skipped ? 'warning' : 'success');
            },
        });

        // ---- a dialog in the app's own shell and overlay stack: the host builds the chrome and closes it
        const ask = ctx.ui.dialog({ id: 'ask', label: 'Ask your model', icon: 'fa-comment-dots', className: 'hw-content' });
        const openAsk = () => {
            const el = ask.open();
            el.classList.add('hw-ask');
            el.innerHTML = `
                <div class="settings-row">
                    <label>Connection</label>
                    <select class="cl-select-fluid" data-hw-ask="profile"><option value="">The one your chats use</option></select>
                </div>
                <div class="settings-row">
                    <label><input type="checkbox" class="cl-switch-input" data-hw-ask="stream"><span class="cl-switch" aria-hidden="true"></span> Read the answer as a stream (ctx.llm.stream, not ctx.llm.chat)</label>
                </div>
                <div class="hw-foot-row">
                    <span class="hw-status" data-hw-ask="status" role="status"></span>
                    <button type="button" class="cl-btn cl-btn-primary cl-btn-sm" data-hw-ask="go"><i class="fa-solid fa-paper-plane" aria-hidden="true"></i> Ask</button>
                </div>
                <p class="hw-heading" data-hw-ask="said" hidden></p>
                <blockquote class="hw-answer" data-hw-ask="answer" hidden></blockquote>`;
            // this open's dialog, while it is the one on the page
            const box = ask.el;
            const shown = () => ask.el === box;
            /** @param {string} name */
            const part = (name) => /** @type {HTMLInputElement} */ (el.querySelector(`[data-hw-ask="${name}"]`));
            /** @param {string} said @param {string} text */
            const answer = (said, text) => {
                part('said').textContent = said;
                part('answer').textContent = text;
                part('said').hidden = part('answer').hidden = false;
            };
            el.addEventListener('click', async (e) => {
                const act = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('[data-hw-ask]'))?.dataset.hwAsk;
                if (act !== 'go') return undefined;
                const go = part('go');
                go.disabled = true;
                part('status').textContent = 'Asking...';
                try {
                    const { content } = await call('/ask', 'POST', { profileId: part('profile').value || undefined, stream: part('stream').checked });
                    if (!shown()) return undefined;
                    part('status').textContent = '';
                    answer('The answer', content || '(an empty answer)');
                } catch (err) {
                    if (shown()) part('status').textContent = `No answer: ${why(err)}`;
                } finally {
                    go.disabled = false;
                }
                return undefined;
            });
            // the account's connections, read as the dialog opens (the pick rides the ask, so none is kept),
            // and the last answer this session kept
            void ctx.ui.connectionSelect(/** @type {HTMLSelectElement} */ (el.querySelector('[data-hw-ask="profile"]')), { key: null });
            call('/last-answer').then(({ content }) => { if (content && shown() && part('answer').hidden) answer('The last answer', content); }).catch(() => {});
        };

        // ---- a view of its own beside Characters, Chats and Online: what the tour heard, and the doors
        /** @type {{ enter(): void, leave(): void, refresh(): Promise<void> } | null} */
        let tour = null;
        ctx.ui.contribute('shell.view', {
            id: 'tour',
            label: 'Hello World',
            icon: 'fa-hand',
            render(el) { tour = mountTour(el); },
            enter: () => tour?.enter(),
            leave: () => tour?.leave(),
            // what a phone's pull runs: the view's reads again, its pull armed only because this is here
            refresh: () => tour?.refresh(),
        });

        /** @param {HTMLElement} el */
        function mountTour(el) {
            /** @param {string} act @param {string} icon @param {string} label */
            const verb = (act, icon, label) => `<button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-hw="${act}"><i class="fa-solid ${icon}" aria-hidden="true"></i> ${label}</button>`;
            el.innerHTML = `
                <div class="hw-tour">
                    <h2 class="hw-title">Hello World</h2>
                    <p class="hw-line" data-hw-lead></p>
                    <section class="hw-panel">
                        <h3 class="hw-heading">Try a door</h3>
                        <div class="hw-verbs">
                            ${verb('ask', 'fa-comment-dots', 'Ask your model')}
                            ${verb('count', 'fa-list-ol', 'Count your characters')}
                            ${verb('stage', 'fa-file-import', 'Import the sample card')}
                            ${verb('latest', 'fa-comments', 'Open your newest chat')}
                            ${verb('greet', 'fa-hand', 'Say hello')}
                        </div>
                        <p class="hw-status" data-hw-status role="status"></p>
                    </section>
                    <div class="hw-pair">
                        <section class="hw-panel">
                            <h3 class="hw-heading">What the server half heard</h3>
                            <div class="hw-tiles" data-hw-server></div>
                        </section>
                        <section class="hw-panel">
                            <h3 class="hw-heading">What this page heard</h3>
                            <div class="hw-tiles" data-hw-page></div>
                        </section>
                    </div>
                    <section class="hw-panel">
                        <h3 class="hw-heading">Your note, a file of your own on the server</h3>
                        <textarea class="glass-input" rows="3" maxlength="2000" data-hw-note placeholder="Anything; only you read it"></textarea>
                        <div class="hw-foot-row">
                            <span class="hw-status" data-hw-note-status role="status"></span>
                            <button type="button" class="cl-btn cl-btn-primary cl-btn-sm" data-hw="note">Save the Note</button>
                        </div>
                    </section>
                    <section class="hw-panel">
                        <h3 class="hw-heading">The doors, as the app lists them</h3>
                        <div data-hw-doors></div>
                    </section>
                </div>`;
            /** @param {string} sel */
            const $ = (sel) => /** @type {HTMLInputElement} */ (el.querySelector(sel));
            let shown = false;
            /** @type {ReturnType<typeof setTimeout> | undefined} */
            let poll;
            /** @type {ReturnType<typeof setTimeout> | undefined} */
            let soon;
            /** @param {string} text */
            const status = (text) => { $('[data-hw-status]').textContent = text; };
            /** @param {unknown} value @param {string} label */
            const tile = (value, label) => `<div class="hw-tile"><span class="hw-tile-value">${esc(value)}</span><span class="hw-tile-label">${esc(label)}</span></div>`;
            /** @param {number | null} ms */
            const at = (ms) => (ms ? new Date(ms).toLocaleString() : 'Not yet');

            const paintPage = () => {
                $('[data-hw-page]').innerHTML = [tile(heard.favorites, 'Favorites seen'), tile(heard.edits, 'Character edits'),
                    tile(unhook.length ? heard.sends : 'Off', 'Sends heard')].join('');
            };
            const readServer = async () => {
                try {
                    const t = await call('/tour');
                    if (!shown) return;
                    $('[data-hw-server]').innerHTML = [tile(t.batches, 'Write batches'), tile(t.records, 'Changes'), tile(t.refused, 'Writes refused'),
                        tile(at(t.lastWave), 'Last wave on this server'), tile(at(t.lastTick), 'Last daily tick')].join('');
                } catch (e) {
                    if (shown) $('[data-hw-server]').innerHTML = `<p class="hw-line is-error">The server half did not answer: ${esc(why(e))}</p>`;
                }
            };
            const readLead = async () => {
                try {
                    const { hello, greeting } = await call('/hello');
                    if (shown) $('[data-hw-lead]').textContent = `${greeting}, ${hello}! This view is the tour's own; the menus, the grid, the details and the conversation hold the rest.`;
                } catch { /* the tiles say the server half is away */ }
            };
            const readNote = async () => {
                const box = $('[data-hw-note]');
                try {
                    const { text } = await call('/note');
                    // never over a note being typed
                    if (shown && document.activeElement !== box) box.value = text;
                } catch (e) {
                    $('[data-hw-note-status]').textContent = `The note could not be read: ${why(e)}`;
                }
            };
            const paintDoors = () => {
                /** @param {string} title @param {string[]} rows */
                const list = (title, rows) => `<details class="hw-doors"><summary>${esc(title)} (${rows.length})</summary><ul class="hw-door-list">${rows.join('')}</ul></details>`;
                /** @param {string} name @param {string} type */
                const row = (name, type) => `<li><code>${esc(name)}</code> <span class="hw-type">${esc(type)}</span></li>`;
                /** @param {Readonly<Record<string, string>>} types */
                const shape = (types) => (Object.keys(types).length ? `{ ${Object.entries(types).map(([k, t]) => `${k}: ${t}`).join('; ')} }` : '{}');
                $('[data-hw-doors]').innerHTML = [
                    list('Commands', ctx.commands.list().map(c => row(c.id, c.args ? `(${c.args}) => ${c.answers}` : c.title))),
                    list('Events', ctx.events.list().map(e => row(e.name, shape(e.types)))),
                    list('Conversation hooks', ctx.hooks.list().map(h => row(h.name, h.kind === 'filter' ? `(${h.value}, ${h.context}) => ${h.answer}` : `(${h.context}) => ${h.answer}`))),
                    list('Slots', ctx.ui.slots().map(s => row(s.id, `${s.kind}: ${s.spec}`))),
                ].join('');
            };
            const onChange = () => {
                clearTimeout(soon);
                soon = setTimeout(() => { paintPage(); void readServer(); }, QUIET_MS);
            };

            // a job the server half runs, followed to its end while the view is on screen
            const count = async () => {
                /** @type {number} */
                let id;
                try {
                    ({ id } = await call('/count', 'POST'));
                } catch (e) {
                    status(`Could not count: ${why(e)}`);
                    return;
                }
                const follow = async () => {
                    if (!shown) return;
                    let job;
                    try { job = (await call('/jobs')).find((/** @type {any} */ j) => j.id === id); } catch (e) { status(`Could not follow the count: ${why(e)}`); return; }
                    if (!shown) return;
                    if (job?.status === 'done') status(`Counted ${plural(job.progress?.total ?? 0, 'character', 'characters')}.`);
                    else if (job && !['failed', 'cancelled'].includes(job.status)) {
                        status(`Counted ${job.progress?.done ?? 0} of ${job.progress?.total ?? '?'}...`);
                        poll = setTimeout(follow, POLL_MS);
                    } else status('The count did not finish; the notifications center says why.');
                };
                status('Counting...');
                await follow();
            };
            // a card the server half ships, staged as an upload is; the reader commits it or lets it go
            const stage = async () => {
                let staged;
                try { staged = await call('/stage', 'POST'); } catch (e) { status(`Could not stage the card: ${why(e)}`); return; }
                const stageId = encodeURIComponent(staged.stageId);
                // a stage nobody commits waits an hour on disk; one the reader let go goes at once
                const drop = () => CoreAPI.apiRequest(`/characters/import/stage/${stageId}`, 'DELETE').catch(() => {});
                const yes = await CoreAPI.showConfirm({
                    title: 'Import the sample card',
                    message: `Add ${staged.card?.data?.name || 'the card'} to your library? The tour ships it, and its server half staged it as an upload is staged.`,
                    icon: 'fa-solid fa-file-import',
                    confirmLabel: 'Import',
                });
                if (!yes) {
                    void drop();
                    status('Not imported.');
                    return;
                }
                // committed through the app's own import, so this tab takes it in and a wrapper hears it
                try {
                    const out = await ctx.commands.run('character.import', { stage: { stageId: staged.stageId, card: staged.card } });
                    if (!out?.success) throw new Error(out?.error || 'the import was held back');
                    status(out.alreadyPresent ? `${out.characterName} is already in your library.` : `Imported ${out.characterName}.`);
                } catch (e) {
                    void drop();
                    status(`Could not import it: ${why(e)}`);
                }
            };
            const latest = async () => {
                try {
                    const resp = await CoreAPI.apiRequest('/chats?limit=1&count=false', 'GET');
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const chat = (await resp.json())?.items?.[0];
                    if (!chat) return status('No chats yet.');
                    if (!(await ctx.chats.open(chat.id))) status(`Could not open ${chat.name || 'the chat'}.`);
                } catch (e) {
                    status(`Could not read your chats: ${why(e)}`);
                }
                return undefined;
            };
            const saveNote = async () => {
                const said = $('[data-hw-note-status]');
                try {
                    await call('/note', 'PUT', { text: $('[data-hw-note]').value });
                    said.textContent = 'Saved.';
                } catch (e) {
                    said.textContent = `Not saved: ${why(e)}`;
                }
            };

            el.addEventListener('click', (e) => {
                const act = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('[data-hw]'))?.dataset.hw;
                if (act === 'ask') openAsk();
                else if (act === 'count') void count();
                else if (act === 'stage') void stage();
                else if (act === 'latest') void latest();
                else if (act === 'greet') void greet('the tour');
                else if (act === 'note') void saveNote();
            });

            return {
                async refresh() { await Promise.all([readLead(), readServer(), readNote()]); },
                enter() {
                    shown = true;
                    for (const name of MOVES) ctx.events.on(name, onChange);
                    paintPage();
                    paintDoors();
                    void readLead();
                    void readServer();
                    void readNote();
                },
                leave() {
                    shown = false;
                    for (const name of MOVES) ctx.events.off(name, onChange);
                    clearTimeout(soon);
                    clearTimeout(poll);
                },
            };
        }
    },

    // Runs after the host has undone every registration above; nothing here lives outside ctx.
    dispose() {
        console.log('[ext:hello-world] switched off');
    },
};
