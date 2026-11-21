// SPDX-License-Identifier: MIT

// Next Beat, the client half: its verbs above the composer or in a window, the suggestions, Director, Surprise Me,
// the styles manager and the settings.
import {
    STORY, DIRECTOR, GENRES, BUILT_IN, ICONS, NAME_MAX, PROMPT_MAX, CUSTOM_MAX, DIRECTIONS_MAX, DIRECTION_MAX, LENGTHS,
    SETTING_LIMITS, settingNumber, lengthKey, surpriseRange, WRAPS, wrapKey, wrapText,
} from './catalog.js';

const ID = 'next-beat';
const FIRST_DIRECTIONS = 2;
const PLACEHOLDERS = ['The ferry runs aground in the fog', 'Someone recognises her from the old days', 'The letter turns out to be forged', 'They split up to cover more ground',
    'A bargain is struck, and regretted', 'The fire spreads to the stables', 'An old debt is called in', 'The truth comes out over dinner'];
const SURPRISE_FIELD = `${ID}.surprises`;
// a host names a reply that reached its ceiling in one of these
const CUT = new Set(['length', 'max_tokens', 'stop_limit']);
// the chrome a host dresses the same markup in: a dialog's buttons and fields, or the chat window family's
const LOOKS = Object.freeze({
    dialog: Object.freeze({ btn: 'cl-btn cl-btn-secondary', sm: 'cl-btn cl-btn-sm cl-btn-secondary', primary: 'cl-btn cl-btn-primary', danger: 'cl-btn cl-btn-danger', input: 'cl-input', row: '' }),
    window: Object.freeze({ btn: 'cl-cwin-btn-text', sm: 'cl-cwin-btn-text', primary: 'cl-cwin-btn-text is-primary', danger: 'cl-cwin-btn-text is-danger', input: 'cl-cwin-input', row: 'cl-cwin-fieldrow' }),
});

/** @param {unknown} e */
const why = (e) => (e instanceof Error ? e.message : String(e));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const fileNameOf = (name) => `${String(name).trim() || 'style'}.md`;
// a labelled button: the label and the attributes are markup the caller wrote, never a reader's text
const buttonHtml = (cls, attrs, icon, label) => `<button type="button" class="${cls}" ${attrs}>${icon ? `<i class="fa-solid ${icon}" aria-hidden="true"></i>` : ''}<span>${label}</span></button>`;

export default {
    init(ctx) {
        const { CoreAPI } = ctx;
        const esc = (s) => CoreAPI.escapeHtml(s);
        const call = ctx.server.call;
        const toast = (text, kind = 'info') => CoreAPI.showToast(text, kind);
        const setting = (key) => ctx.settings.get(key);
        const mobile = () => !!CoreAPI.isMobileMode?.();
        const chatPath = (chatId) => encodeURIComponent(chatId);
        // anything stored but 'window' reads as the strip, the default
        const inWindow = () => setting('placement') === 'window';

        // ======================================== what the page holds
        // the library as the server last answered it; ours stands in until it is read
        let styles = null;
        // the conversation on screen, as the composer's buttons and the conversation tell it
        let openChat = null;
        // the last set per chat and style, kept until the chat gets a new message or the conversation moves
        const results = new Map();
        // a chat's moves, so a set asked for before one is never kept as the chat's
        const moves = new Map();
        // what the reader planned for each chat in Director
        const plans = new Map();

        const resultKey = (chatId, key) => `${chatId}\u0000${key}`;
        const forget = (chatId) => {
            moves.set(chatId, (moves.get(chatId) || 0) + 1);
            for (const k of [...results.keys()]) if (k.startsWith(`${chatId}\u0000`)) results.delete(k);
        };
        const allStyles = () => styles || BUILT_IN.map(s => ({ ...s, edited: false }));
        const styleByKey = (key) => allStyles().find(s => s.key === key) || null;
        const customStyles = () => allStyles().filter(s => s.kind === 'custom');
        const adopt = (out) => { if (Array.isArray(out?.styles)) styles = out.styles; return out; };
        const readStyles = async () => {
            try { adopt(await call('/styles')); } catch (e) { ctx.log('the style library could not be read:', why(e)); }
            return allStyles();
        };
        void readStyles();

        // the conversation moving on drops every kept set but its new chat's
        ctx.events.on('conversation.changed', ({ chatId }) => {
            for (const k of [...results.keys()]) if (!chatId || !k.startsWith(`${chatId}\u0000`)) results.delete(k);
            openChat = chatId || null;
            if (win?.open && chatId && chatId !== win.chatId) showWindow(chatId);
        });
        for (const name of ['message.created', 'message.updated', 'message.deleted']) {
            ctx.events.on(name, ({ chatId }) => { if (chatId) forget(chatId); });
        }
        // nothing itemized (a reconnect, an import elsewhere): every kept set and the library are read again
        ctx.events.on('library.changed', () => {
            results.clear();
            void readStyles();
        });

        // ======================================== where a surface draws: a dialog's body, or a pane of the window
        // a renderer draws into a fresh root of its own, so the listeners of what it replaced leave with it
        function rootIn(host, cls) {
            const root = document.createElement('div');
            root.className = cls;
            host.el.innerHTML = '';
            host.el.appendChild(root);
            return root;
        }
        // the strip's verbs open dialogs; each closes as a verb moves on, and the next surface is a dialog of its own
        const toDialogs = { toSuggestions: (chatId, key, director) => openSuggestions(chatId, key, director), toDirector: (chatId) => openDirector(chatId), toLibrary: (key) => openLibrary(key) };
        const dialogHost = (dialog, el) => ({ kind: 'dialog', el, look: LOOKS.dialog, close: () => { void dialog.close({ force: true }); }, ...toDialogs });

        // ======================================== a button's menu: a dropdown beside it, a sheet on a phone
        let menu = null;
        let outside = null;
        const closeMenu = () => {
            if (outside) document.removeEventListener('pointerdown', outside, true);
            outside = null;
            menu?.remove();
            menu = null;
        };
        const menuId = ctx.ui.addOverlay({ id: 'menu', close: closeMenu });

        /**
         * @param {HTMLElement | null} anchor the button pressed
         * @param {string} label the menu's name
         * @param {Array<{ title: string, note?: string, items: Array<{ act: string, icon: string, label: string, danger?: boolean }> }>} groups
         * @param {(act: string) => void} onPick
         */
        function showMenu(anchor, label, groups, onPick) {
            closeMenu();
            const row = (it, cls) => `<button type="button" class="${cls}${it.danger ? ' danger' : ''}" data-nb-act="${esc(it.act)}"><i class="fa-solid ${esc(it.icon)}" aria-hidden="true"></i><span>${esc(it.label)}</span></button>`;
            const sheet = mobile() ? CoreAPI.createMobileSheet?.({ label }) : null;
            if (sheet) {
                sheet.sheet.insertAdjacentHTML('beforeend', groups.map(g => `<div class="mobile-sheet-group-title">${esc(g.title)}</div>${g.note ? `<p class="nb-sheet-note">${esc(g.note)}</p>` : ''}${g.items.map(it => row(it, 'mobile-sheet-item')).join('')}`).join(''));
                sheet.sheet.addEventListener('click', (e) => {
                    const act = e.target.closest('[data-nb-act]')?.dataset.nbAct;
                    if (!act) return;
                    sheet.close();
                    onPick(act);
                });
                sheet.open();
                return;
            }
            menu = document.createElement('div');
            menu.id = menuId;
            menu.className = 'dropdown-menu nb-menu';
            menu.setAttribute('role', 'menu');
            menu.setAttribute('aria-label', label);
            menu.innerHTML = groups.map(g => `<div class="dropdown-section-title">${esc(g.title)}</div>${g.note ? `<p class="nb-menu-note">${esc(g.note)}</p>` : ''}${g.items.map(it => row(it, 'dropdown-item')).join('')}`).join('');
            // toward the larger room: upward from the strip above the composer, downward from a button high in the window
            const r = anchor?.getBoundingClientRect?.();
            if (r && (r.width || r.height)) {
                const above = r.top - 16, below = window.innerHeight - r.bottom - 16;
                menu.style.left = `${Math.max(8, Math.round(r.left))}px`;
                if (below > above) menu.style.top = `${Math.round(r.bottom + 6)}px`;
                else menu.style.bottom = `${Math.max(8, Math.round(window.innerHeight - r.top + 6))}px`;
                menu.style.maxHeight = `${Math.max(160, Math.round(Math.max(above, below)))}px`;
            }
            menu.addEventListener('click', (e) => {
                const act = e.target.closest('[data-nb-act]')?.dataset.nbAct;
                if (!act) return;
                closeMenu();
                onPick(act);
            });
            document.body.appendChild(menu);
            const box = menu;
            outside = (e) => { if (!box.contains(e.target) && !anchor?.contains?.(e.target)) closeMenu(); };
            document.addEventListener('pointerdown', outside, true);
        }
        const styleItem = (s) => ({ act: s.key, icon: s.icon, label: s.name });
        const adultOn = () => setting('explicit') === true;
        const storyStyles = () => STORY.filter(s => !s.adult || adultOn()).map(s => styleByKey(s.key) || s);

        // ======================================== the suggestions
        let view = null;     // the set on show: { chatId, key, director, items, unread, state, error, handed, root, host }
        let run = null;      // the request on its way, to stop it
        const suggestDialog = ctx.ui.dialog({
            id: 'suggest', label: 'Next Beat', icon: 'fa-route', className: 'nb-content', size: true,
            onClose: () => {
                if (view?.host.kind !== 'dialog') return;
                run?.abort();
                run = null;
                view = null;
            },
        });

        function openSuggestions(chatId, key, director = null) {
            const style = styleByKey(key);
            if (!chatId || !style) return;
            const body = suggestDialog.open({ title: director ? `Director: ${director.mode === 'steps' ? 'steps in order' : 'takes on a scene'}` : style.name });
            mountSuggestions(dialogHost(suggestDialog, body), chatId, key, director);
        }

        // one renderer for both hosts: the dialog the strip opens and the window's own pane
        function mountSuggestions(host, chatId, key, director = null) {
            const style = styleByKey(key);
            if (!chatId || !style) return;
            // one set at a time: a request still on its way for the set this one replaces stops
            run?.abort();
            run = null;
            const L = host.look;
            const root = rootIn(host, 'nb-body');
            root.innerHTML = `
                <div class="nb-head">
                    <span class="nb-style"><i class="fa-solid ${esc(style.icon)}" aria-hidden="true"></i><span>${esc(style.name)}</span></span>
                    <span class="nb-status" data-nb="status" role="status" aria-live="polite"></span>
                    ${director ? buttonHtml(L.sm, 'data-nb="plan"', 'fa-clapperboard', 'Change the plan') : ''}
                </div>
                <div class="nb-list" data-nb="list"></div>
                <div class="nb-foot">
                    ${buttonHtml(L.btn, 'data-nb="refresh"', 'fa-arrows-rotate', 'New suggestions')}
                    <button type="button" class="${L.btn}" data-nb="run"></button>
                </div>`;
            const v = { chatId, key, director, items: [], unread: null, state: 'done', error: null, handed: null, root, host };
            view = v;
            root.addEventListener('click', (e) => onSuggestClick(v, e));
            const kept = director ? null : results.get(resultKey(chatId, key));
            if (kept) {
                Object.assign(v, { items: kept.items.slice(), unread: kept.unread });
                paintSuggestions(v);
            } else void askSuggestions(v);
        }

        // one set at a time: a new ask stops the one before it
        async function askSuggestions(v) {
            if (!v || view !== v) return;
            run?.abort();
            const stop = new AbortController();
            run = stop;
            const startedAt = moves.get(v.chatId) || 0;
            Object.assign(v, { items: [], unread: null, state: 'running', error: null, handed: null });
            paintSuggestions(v);
            try {
                const body = { style: v.key, ...(v.director ? { director: { mode: v.director.mode, directions: v.director.directions } } : {}) };
                // a line a suggestion as each is written, then a done line; the whole set at once when streaming is off
                let whole = false;
                for await (const line of ctx.server.stream(`/chats/${chatPath(v.chatId)}/suggest`, 'POST', body, { signal: stop.signal })) {
                    if (view !== v || run !== stop) return;
                    if (line.error) throw Object.assign(new Error(line.error), { kind: line.kind });
                    const landed = line.suggestions || (line.suggestion ? [line.suggestion] : []);
                    v.items.push(...landed);
                    if (landed.length) paintSuggestions(v);
                    whole ||= !!(line.done || line.suggestions);
                    if (line.unread) v.unread = line.unread;
                }
                if (view !== v || run !== stop) return;
                if (!whole) throw new Error('the answer stopped before it was done');
                v.state = 'done';
                if (!v.director && (moves.get(v.chatId) || 0) === startedAt) results.set(resultKey(v.chatId, v.key), { items: v.items.slice(), unread: v.unread });
            } catch (e) {
                if (view !== v || run !== stop) return;
                v.state = stop.signal.aborted ? 'stopped' : 'failed';
                v.error = stop.signal.aborted ? null : why(e);
            } finally {
                if (run === stop) run = null;
            }
            paintSuggestions(v);
        }

        // the dialog's run verb reads Cancel then Close; the window has nothing to close, so it shows only while a set is written
        function paintRunVerb(v, btn, state) {
            if (v.host.close) { CoreAPI.setRunVerb(btn, state); return; }
            btn.hidden = state === 'done';
            btn.disabled = state === 'stopping';
            btn.dataset.runState = state;
            btn.innerHTML = state === 'stopping' ? '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i><span>Stopping...</span>' : '<i class="fa-solid fa-xmark" aria-hidden="true"></i><span>Cancel</span>';
        }

        function paintSuggestions(v) {
            if (!v || view !== v) return;
            const $ = (sel) => v.root.querySelector(sel);
            const sm = v.host.look.sm;
            const running = v.state === 'running';
            const mark = `<i class="fa-solid ${esc(styleByKey(v.key)?.icon || 'fa-route')}"></i>`;
            const cards = v.items.map((s, i) => `
                <article class="nb-card">
                    <div class="nb-card-head">
                        <span class="nb-emoji" aria-hidden="true">${s.emoji ? esc(s.emoji) : mark}</span>
                        <h4 class="nb-title">${esc(s.title)}</h4>
                    </div>
                    ${s.description ? `<p class="nb-desc">${esc(s.description)}</p>` : ''}
                    <div class="nb-card-verbs">
                        ${buttonHtml(sm, `data-nb-card="copy" data-i="${i}"`, 'fa-copy', 'Copy')}
                        ${buttonHtml(sm, `data-nb-card="insert" data-i="${i}"`, 'fa-pen-to-square', 'Insert')}
                        ${buttonHtml(sm, `data-nb-card="send" data-i="${i}"`, 'fa-paper-plane', 'Send')}
                    </div>
                </article>`).join('');
            const pending = running ? `<div class="nb-card is-pending"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i><span>${v.items.length ? 'Writing the next one...' : 'Reading the chat and writing suggestions...'}</span></div>` : '';
            const unread = v.state === 'done' && !v.items.length ? unreadNote(v.unread) : '';
            const note = v.state === 'failed' ? `<div class="nb-empty is-error"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><p>No suggestions: ${esc(v.error)}</p></div>`
                : unread ? `<div class="nb-empty nb-unread"><i class="fa-solid fa-circle-question" aria-hidden="true"></i>${unread}</div>`
                    : !running && !v.items.length ? `<div class="nb-empty"><i class="fa-solid fa-route" aria-hidden="true"></i><p>${v.state === 'stopped' ? 'Stopped before any suggestion came back.' : 'No suggestions came back. Ask again, or try another style.'}</p></div>` : '';
            $('[data-nb="list"]').innerHTML = cards + pending + note;
            $('[data-nb="status"]').textContent = running ? 'Writing...'
                : v.handed ? (v.handed === 'send' ? 'Sent' : 'Put in the composer')
                    : v.state === 'stopped' ? (v.items.length ? `Stopped after ${plural(v.items.length, 'suggestion', 'suggestions')}` : 'Stopped')
                        : v.state === 'failed' ? 'Not written' : v.items.length ? plural(v.items.length, 'suggestion', 'suggestions') : '';
            $('[data-nb="refresh"]').disabled = running;
            paintRunVerb(v, $('[data-nb="run"]'), running ? 'running' : 'done');
        }

        // an empty set the model did answer: why nothing could be read from it; '' when it answered nothing at all
        function unreadNote(u) {
            if (!u) return '';
            const lead = '<p>The model answered, but no suggestion could be read from it.</p>';
            if (CUT.has(u.finishReason)) {
                const hint = setting('reasoning') === true
                    ? 'If it thinks first, raise its Most output tokens in Next Beat\'s settings.'
                    : 'If the connection is a reasoning model, switch on "A reasoning model: give it room to think" in Next Beat\'s settings.';
                return `${lead}<p>It ran out of room before it finished: it reached the reply limit.</p><p class="nb-hint">${hint}</p>`;
            }
            if (u.thoughtOnly) return `${lead}<p>It only thought, and wrote no answer.</p>`;
            if (!u.said) return '';
            return `${lead}<p>What it said:</p><div class="nb-said" tabindex="0">${esc(u.said)}</div>`;
        }

        // what Copy, Insert and Send hand on: the description, wrapped the way the reader chose
        const textOf = (s) => wrapText(s.description || s.title, setting('wrap'));
        // a dialog closes to show the composer; the window says where the text went, and closes on a phone, where it covers the composer
        const handOff = (v, how) => {
            if (v.host.close) { v.host.close(); return; }
            v.handed = how;
            paintSuggestions(v);
            if (mobile()) win?.close?.();
        };
        async function insertSuggestion(v, s) {
            const mode = setting('insert') === 'append' ? 'append' : 'replace';
            handOff(v, 'insert');
            const written = await ctx.commands.run('chat.compose', { text: textOf(s), mode });
            if (!written) toast('The composer is busy sending; try again in a moment');
        }
        async function sendSuggestion(v, s) {
            handOff(v, 'send');
            const sent = await ctx.commands.run('chat.send', { text: textOf(s) });
            if (sent === false) toast('That suggestion was not sent: a reply may still be on its way');
        }
        async function copySuggestion(s) {
            toast(await CoreAPI.copyTextToClipboard(textOf(s)) ? 'Copied' : 'Could not copy it', 'info');
        }

        function onSuggestClick(v, e) {
            if (view !== v) return;
            const card = e.target.closest('[data-nb-card]');
            if (card) {
                const s = v.items[Number(card.dataset.i)];
                if (!s) return;
                const verb = card.dataset.nbCard;
                if (verb === 'copy') void copySuggestion(s);
                else if (verb === 'insert') void insertSuggestion(v, s);
                else if (verb === 'send') void sendSuggestion(v, s);
                return;
            }
            const act = e.target.closest('[data-nb]')?.dataset.nb;
            if (act === 'refresh') void askSuggestions(v);
            else if (act === 'plan') v.host.toDirector(v.chatId);
            else if (act === 'run') {
                if (v.state !== 'running') { v.host.close?.(); return; }
                paintRunVerb(v, e.target.closest('[data-nb]'), 'stopping');
                run?.abort();
            }
        }

        // ======================================== Director
        const directorDialog = ctx.ui.dialog({ id: 'director', label: 'Director', icon: 'fa-clapperboard', className: 'nb-content nb-director' });
        const HINTS = {
            takes: 'Sketch one scene in your own words; each suggestion plays it a different way.',
            steps: 'List what happens next, step by step; each step gets a suggestion of its own, in order.',
        };

        function openDirector(chatId) {
            if (!chatId) return;
            mountDirector(dialogHost(directorDialog, directorDialog.open()), chatId);
        }

        // one renderer for both hosts; its Suggest hands the plan to the host's suggestions
        function mountDirector(host, chatId) {
            if (!chatId) return;
            const L = host.look;
            const plan = plans.get(chatId) || { mode: 'takes', directions: Array(FIRST_DIRECTIONS).fill('') };
            const root = rootIn(host, 'nb-body');
            root.innerHTML = `
                <div class="settings-row">
                    <label for="nb-director-mode-${host.kind}">What to plan</label>
                    <select id="nb-director-mode-${host.kind}" class="cl-select-fluid" data-nb-dir="mode">
                        <option value="takes">Takes on one scene</option>
                        <option value="steps">Steps in order</option>
                    </select>
                    <span class="settings-hint" data-nb-dir="hint"></span>
                </div>
                <ol class="nb-directions" data-nb-dir="list"></ol>
                <div class="nb-foot">
                    ${buttonHtml(L.sm, 'data-nb-dir="add"', 'fa-plus', 'Add a direction')}
                    <span class="nb-foot-gap"></span>
                    ${buttonHtml(L.btn, 'data-nb-dir="clear"', '', 'Clear')}
                    ${buttonHtml(L.primary, 'data-nb-dir="go"', 'fa-route', 'Suggest')}
                </div>`;
            const $ = (sel) => root.querySelector(sel);
            const mode = $('[data-nb-dir="mode"]');
            const read = () => [...root.querySelectorAll('[data-nb-dir="text"]')].map(i => i.value);
            const paint = (list) => {
                $('[data-nb-dir="list"]').innerHTML = list.map((d, i) => `
                    <li class="nb-direction${L.row ? ` ${L.row}` : ''}">
                        <input type="search" autocomplete="one-time-code" class="${L.input}" data-nb-dir="text" maxlength="${DIRECTION_MAX}" value="${esc(d)}" placeholder="${esc(PLACEHOLDERS[i] || '')}" aria-label="Direction ${i + 1}">
                        <button type="button" class="${L.sm} nb-icon-btn" data-nb-dir="remove" data-i="${i}" title="Remove this direction" aria-label="Remove direction ${i + 1}"${list.length < 2 ? ' disabled' : ''}><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
                    </li>`).join('');
                $('[data-nb-dir="add"]').disabled = list.length >= DIRECTIONS_MAX;
                $('[data-nb-dir="hint"]').textContent = HINTS[mode.value];
            };
            mode.value = plan.mode;
            CoreAPI.initCustomSelect(mode);
            paint(plan.directions);
            const keep = () => plans.set(chatId, { mode: mode.value, directions: read() });
            mode.addEventListener('change', () => { keep(); $('[data-nb-dir="hint"]').textContent = HINTS[mode.value]; });
            root.addEventListener('input', keep);
            root.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-nb-dir]');
                const act = btn?.dataset.nbDir;
                if (act === 'add') { paint([...read(), '']); keep(); } else if (act === 'remove') {
                    const list = read();
                    list.splice(Number(btn.dataset.i), 1);
                    paint(list);
                    keep();
                } else if (act === 'clear') {
                    paint(Array(FIRST_DIRECTIONS).fill(''));
                    keep();
                } else if (act === 'go') {
                    const directions = read().map(d => d.trim()).filter(Boolean);
                    if (!directions.length) { toast('Write at least one direction first'); return; }
                    keep();
                    host.close?.();
                    host.toSuggestions(chatId, DIRECTOR.key, { mode: mode.value, directions });
                }
            });
        }

        // ======================================== Surprise Me
        async function readSurprises(chatId) {
            return call(`/chats/${chatPath(chatId)}/surprises`);
        }
        async function armSurprise(chatId, key) {
            const style = styleByKey(key);
            toast(`Arming a surprise${style ? ` in the ${style.name} style` : ''}...`);
            try {
                const out = await call(`/chats/${chatPath(chatId)}/surprises`, 'POST', { style: key });
                const others = out.surprises.length - 1;
                toast(`Surprise armed: it lands in about ${plural(out.armed.distance, 'message', 'messages')}${others > 0 ? ` (${others + 1} armed in this chat)` : ''}`, 'success');
                return out;
            } catch (e) {
                toast(`No surprise armed: ${why(e)}`, 'error');
                return null;
            }
        }
        async function clearSurprises(chatId, id = null) {
            if (!id) {
                const ok = await CoreAPI.showConfirm({
                    title: 'Clear every armed surprise?',
                    message: 'The surprises armed in this chat are dropped before they land. Nothing in the chat changes.',
                    confirmLabel: 'Clear',
                    danger: true,
                    icon: 'fa-solid fa-eraser',
                });
                if (ok !== true) return null;
            }
            try {
                return await call(id ? `/chats/${chatPath(chatId)}/surprises/${encodeURIComponent(id)}` : `/chats/${chatPath(chatId)}/surprises`, 'DELETE');
            } catch (e) {
                toast(`Could not clear it: ${why(e)}`, 'error');
                return null;
            }
        }
        const whenLands = (s) => (s.left ? `in about ${plural(s.left, 'message', 'messages')}` : 'with the next reply');

        async function openSurpriseMenu(chatId, anchor) {
            const [, armed] = await Promise.all([readStyles(), readSurprises(chatId).catch(() => null)]);
            const custom = customStyles();
            const groups = [
                { title: 'Arm a surprise', items: storyStyles().map(styleItem) },
                { title: 'Genres', items: GENRES.map(g => styleItem(styleByKey(g.key) || g)) },
                ...(custom.length ? [{ title: 'Your styles', items: custom.map(styleItem) }] : []),
            ];
            const n = armed?.surprises?.length || 0;
            groups.push({
                title: n ? `${n} armed in this chat` : 'None armed in this chat',
                note: [n ? `The next lands ${whenLands(armed.surprises.reduce((a, b) => (b.left < a.left ? b : a)))}.` : '', armed?.endless ? 'Endless is on: each one arms its style again when it lands.' : ''].filter(Boolean).join(' '),
                items: n ? [{ act: '-clear', icon: 'fa-eraser', label: 'Clear All', danger: true }] : [],
            });
            showMenu(anchor, 'Surprise me', groups, (act) => {
                if (act === '-clear') void clearSurprises(chatId);
                else void armSurprise(chatId, act);
            });
        }

        // a pick goes where the menu was opened from: the strip's dialogs, or the window's own panes
        async function openListMenu(chatId, anchor, which, to = toDialogs) {
            await readStyles();
            const list = which === 'genres' ? GENRES.map(g => styleByKey(g.key) || g) : customStyles();
            // with none of the reader's own yet, the menu is the way to make the first
            const first = which !== 'genres' && !list.length;
            showMenu(anchor, which === 'genres' ? 'Genres' : 'Your styles', [
                first ? { title: 'Your styles', note: 'None of your own yet.', items: [{ act: '-create', icon: 'fa-plus', label: 'Create a style' }] }
                    : { title: which === 'genres' ? 'Genres' : 'Your styles', items: list.map(styleItem) },
                { title: 'Styles', items: [{ act: '-manage', icon: 'fa-sliders', label: 'Edit the Styles...' }] },
            ], (act) => {
                if (act === '-create') to.toLibrary('-new');
                else if (act === '-manage') to.toLibrary();
                else to.toSuggestions(chatId, act);
            });
        }

        // ======================================== the styles manager
        let dialogLib = null;    // the dialog's manager while it is open, for its dismissal
        const libDialog = ctx.ui.dialog({
            id: 'styles', label: 'Next Beat styles', icon: 'fa-sliders', className: 'nb-content nb-lib', size: true,
            canClose: () => (dialogLib?.dirty ? discardEdits(dialogLib) : true),
            onClose: () => { dialogLib = null; },
        });
        async function discardEdits(lib) {
            const ok = await CoreAPI.showConfirm({ title: 'Discard your changes?', message: 'This style has edits that are not saved.', confirmLabel: 'Discard', danger: true });
            if (ok === true && lib) lib.dirty = false;
            return ok === true;
        }

        function openLibrary(key = null) {
            dialogLib = mountLibrary(dialogHost(libDialog, libDialog.open()), key);
        }

        // one renderer for both hosts; each manager keeps its own pick and draft
        function mountLibrary(host, key = null) {
            const el = rootIn(host, 'nb-lib-body');
            const lib = { el, look: host.look, chosen: null, draft: null, dirty: false, busy: false };
            el.innerHTML = '<aside class="nb-lib-list" data-nb-lib="list"></aside><div class="nb-lib-main" data-nb-lib="main"></div>';
            el.addEventListener('click', (e) => { void onLibClick(lib, e); });
            el.addEventListener('input', (e) => onLibInput(lib, e));
            void readStyles().then(() => choose(lib, key || STORY[0].key));
            return lib;
        }

        function choose(lib, key) {
            const s = key === '-new' ? { key: '-new', kind: 'custom', name: '', icon: ICONS[0], prompt: '' } : styleByKey(key);
            if (!s) return;
            lib.chosen = s.key;
            lib.draft = { name: s.name, icon: s.icon, prompt: s.prompt };
            lib.dirty = false;
            paintLibrary(lib);
        }

        function paintLibrary(lib) {
            const all = allStyles();
            const section = (title, list) => `<div class="nb-lib-title">${esc(title)}</div>${list.map(s => `
                <button type="button" class="nb-lib-item${s.key === lib.chosen ? ' is-on' : ''}" data-nb-lib="pick" data-key="${esc(s.key)}">
                    <i class="fa-solid ${esc(s.icon)}" aria-hidden="true"></i><span class="nb-lib-name">${esc(s.name)}</span>${s.edited ? '<span class="nb-lib-meta">edited</span>' : ''}
                </button>`).join('')}`;
            lib.el.querySelector('[data-nb-lib="list"]').innerHTML = [
                section('Story', all.filter(s => s.kind === 'story' || s.kind === 'director')),
                section('Genres', all.filter(s => s.kind === 'genre')),
                section('Your styles', all.filter(s => s.kind === 'custom')),
                `<button type="button" class="${lib.look.sm} nb-lib-new" data-nb-lib="pick" data-key="-new"${customStyles().length >= CUSTOM_MAX ? ' disabled' : ''}><i class="fa-solid fa-plus" aria-hidden="true"></i><span>New Style</span></button>`,
            ].join('');
            paintForm(lib);
        }

        function paintForm(lib) {
            const s = lib.chosen === '-new' ? { key: '-new', kind: 'custom', edited: false } : styleByKey(lib.chosen);
            const main = lib.el.querySelector('[data-nb-lib="main"]');
            if (!s) { main.innerHTML = '<p class="nb-hint">Pick a style.</p>'; return; }
            const L = lib.look;
            const d = lib.draft;
            const mine = s.kind === 'custom';
            const fresh = s.key === '-new';
            main.innerHTML = `
                ${mine ? `
                    <label class="nb-field"><span>Name</span><input type="search" autocomplete="one-time-code" class="${L.input}" data-nb-lib="name" maxlength="${NAME_MAX}" value="${esc(d.name)}" placeholder="A name for the style"></label>
                    <div class="nb-field"><span>Icon</span><div class="nb-icons" role="radiogroup" aria-label="Icon">${ICONS.map(ic => `<button type="button" class="nb-icon${ic === d.icon ? ' is-on' : ''}" role="radio" aria-checked="${ic === d.icon}" data-nb-lib="icon" data-icon="${esc(ic)}" title="${esc(ic.slice(3))}"><i class="fa-solid ${esc(ic)}" aria-hidden="true"></i></button>`).join('')}</div></div>`
        : `<h4 class="nb-lib-head"><i class="fa-solid ${esc(s.icon)}" aria-hidden="true"></i> ${esc(s.name)}${s.edited ? ' <span class="nb-lib-meta">edited</span>' : ''}</h4>`}
                <label class="nb-field nb-grow"><span>What the style asks of the model</span>
                    <textarea class="${L.input} nb-prompt" data-nb-lib="prompt" maxlength="${PROMPT_MAX}" rows="8" placeholder="The angle the suggestions take: what kind of turn, what to lean into">\n${esc(d.prompt)}</textarea></label>
                <p class="nb-hint">The answer's shape (an emoji, a title, a description) is always asked for, so a style only names its angle.</p>
                <div class="nb-foot">
                    ${fresh ? '' : buttonHtml(L.btn, 'data-nb-lib="export"', 'fa-file-export', 'Export')}
                    ${!mine && s.edited ? buttonHtml(L.btn, 'data-nb-lib="reset"', 'fa-rotate-left', 'Use ours again') : ''}
                    ${mine && !fresh ? buttonHtml(L.danger, 'data-nb-lib="delete"', 'fa-trash', 'Delete') : ''}
                    <span class="nb-foot-gap"></span>
                    ${buttonHtml(L.primary, `data-nb-lib="save"${lib.busy || !lib.dirty ? ' disabled' : ''}`, 'fa-check', fresh ? 'Create' : 'Save')}
                </div>`;
        }

        function onLibInput(lib, e) {
            const field = e.target?.dataset?.nbLib;
            if (field !== 'name' && field !== 'prompt') return;
            lib.draft[field] = e.target.value;
            lib.dirty = true;
            const save = lib.el.querySelector('[data-nb-lib="save"]');
            if (save) save.disabled = lib.busy;
        }

        // each write answers the whole library, which the page adopts
        async function saveStyle(lib) {
            const d = lib.draft;
            const fresh = lib.chosen === '-new';
            const out = fresh
                ? await call('/styles', 'POST', { name: d.name, icon: d.icon, prompt: d.prompt })
                : await call(`/styles/${encodeURIComponent(lib.chosen)}`, 'PUT', styleByKey(lib.chosen)?.kind === 'custom' ? { name: d.name, icon: d.icon, prompt: d.prompt } : { prompt: d.prompt });
            adopt(out);
            return fresh ? out.key : lib.chosen;
        }
        async function resetStyle(lib) {
            adopt(await call(`/styles/${encodeURIComponent(lib.chosen)}`, 'DELETE'));
            return lib.chosen;
        }
        async function deleteStyle(lib) {
            const s = styleByKey(lib.chosen);
            const ok = await CoreAPI.showConfirm({ title: `Delete ${s?.name || 'this style'}?`, message: 'The style leaves your library. A surprise already armed in it still lands.', confirmLabel: 'Delete', danger: true, icon: 'fa-solid fa-trash' });
            if (ok !== true) return null;
            adopt(await call(`/styles/${encodeURIComponent(lib.chosen)}`, 'DELETE'));
            return STORY[0].key;
        }
        function exportStyle(lib) {
            const s = lib.chosen === '-new' ? null : styleByKey(lib.chosen);
            if (!s) return;
            const text = `# ${lib.draft.name || s.name}\n\nIcon: ${lib.draft.icon || s.icon}\n\n${lib.draft.prompt || s.prompt}\n`;
            CoreAPI.downloadBlobAsFile(new Blob([text], { type: 'text/markdown' }), fileNameOf(lib.draft.name || s.name));
        }

        async function onLibClick(lib, e) {
            const btn = e.target.closest('[data-nb-lib]');
            if (!btn) return;
            const act = btn.dataset.nbLib;
            if (act === 'pick') {
                if (btn.dataset.key === lib.chosen || (lib.dirty && !(await discardEdits(lib)))) return;
                choose(lib, btn.dataset.key);
            } else if (act === 'icon') {
                lib.draft.icon = btn.dataset.icon;
                lib.dirty = true;
                paintForm(lib);
            } else if (act === 'export') exportStyle(lib);
            else if (act === 'save' || act === 'reset' || act === 'delete') {
                if (lib.busy) return;
                lib.busy = true;
                paintForm(lib);
                let next = null;
                try {
                    next = act === 'save' ? await saveStyle(lib) : act === 'reset' ? await resetStyle(lib) : await deleteStyle(lib);
                } catch (err) {
                    toast(`Not saved: ${why(err)}`, 'error');
                } finally {
                    lib.busy = false;
                }
                if (next) choose(lib, next);
                else paintForm(lib);
            }
        }

        // ======================================== the buttons above the composer
        // when() runs as the strip draws, which is where this page learns the open chat on a first load
        const inChat = ({ chatId }) => {
            if (chatId) openChat = chatId;
            return !!chatId;
        };
        // in window mode the strip carries none of them; inChat still runs first, so the open chat is learned either way
        const onStrip = (c) => inChat(c) && !inWindow();
        ctx.ui.addAction('composer', { id: 'director', label: 'Director: Plan the Next Scene', icon: DIRECTOR.icon, when: onStrip, run: ({ chatId }) => openDirector(chatId) });
        ctx.ui.addAction('composer', { id: 'surprise', label: 'Surprise Me', icon: 'fa-wand-magic-sparkles', when: onStrip, run: ({ chatId, anchor }) => openSurpriseMenu(chatId, anchor) });
        for (const s of STORY) {
            ctx.ui.addAction('composer', {
                id: s.key,
                label: `${s.name} suggestions`,
                icon: s.icon,
                when: s.adult ? (c) => onStrip(c) && adultOn() : onStrip,
                run: ({ chatId }) => openSuggestions(chatId, s.key),
            });
        }
        ctx.ui.addAction('composer', { id: 'styles', label: 'Your Styles', icon: 'fa-layer-group', when: onStrip, run: ({ chatId, anchor }) => openListMenu(chatId, anchor, 'custom') });
        ctx.ui.addAction('composer', { id: 'genres', label: 'Genres', icon: 'fa-masks-theater', when: onStrip, run: ({ chatId, anchor }) => openListMenu(chatId, anchor, 'genres') });

        // ======================================== the window: the same verbs, their results shown in it
        let win = null;      // { el, open, close, chatId, pane, lib, director, hosts } once rendered; close is the one its open was handed
        const toWindow = {
            toSuggestions: async (chatId, key, director) => {
                if (!(await showPane('suggest'))) return;
                mountSuggestions(win.hosts.suggest, chatId, key, director);
                paintStyles();
            },
            toDirector: () => { void showPane('director'); },
            toLibrary: (key) => { void showPane('styles', key); },
        };
        const windowHost = (el) => ({ kind: 'window', el, look: LOOKS.window, close: null, ...toWindow });

        ctx.ui.addChatWindow({
            id: 'suggestions',
            label: 'Next Beat',
            icon: 'fa-route',
            min: { w: 28, h: 40 },
            size: { w: 40, h: 72 },
            when: () => inWindow(),
            // render runs once, then onOpen on every open (the first included), which shows the open chat
            render(bodyEl) { mountWindow(bodyEl); },
            onOpen: ({ chatId, close }) => { win.open = true; win.close = close || null; showWindow(chatId); armQuickReturn(); },
            onClose: () => {
                win.open = false;
                if (view?.host.kind === 'window') run?.abort();
            },
        });

        // quick return on a phone: the controls scroll away with the cards, float back pinned on a scroll up
        const armedScrollers = new WeakSet();
        function armQuickReturn() {
            const controls = win?.el.querySelector('.nb-controls');
            // the body the window hands render is what scrolls
            const scroller = win?.el;
            if (!controls || !scroller || armedScrollers.has(scroller)) return;
            armedScrollers.add(scroller);
            let lastY = null, downRun = 0, upRun = 0, hideTimer = 0;
            const pin = () => { clearTimeout(hideTimer); hideTimer = 0; controls.classList.remove('nb-controls-away'); controls.classList.add('nb-pinned'); };
            const unpin = (instant) => {
                if (!controls.classList.contains('nb-pinned')) return;
                if (instant) { clearTimeout(hideTimer); hideTimer = 0; controls.classList.remove('nb-pinned', 'nb-controls-away'); return; }
                if (hideTimer) return;
                controls.classList.add('nb-controls-away');
                hideTimer = setTimeout(() => { hideTimer = 0; controls.classList.remove('nb-pinned', 'nb-controls-away'); }, 220);
            };
            scroller.addEventListener('scroll', () => {
                const y = scroller.scrollTop;
                const dy = lastY === null ? 0 : y - lastY;
                lastY = y;
                if (dy > 0) { downRun += dy; upRun = 0; } else if (dy < 0) { upRun -= dy; downRun = 0; }
                if (!mobile() || y <= 0) { unpin(true); return; }
                const pinned = controls.classList.contains('nb-pinned');
                // still partly in view in its own place: it moves with the page
                if (!pinned && y < controls.offsetHeight) return;
                if (!pinned && upRun > 8) pin();
                else if (pinned && downRun > 16) unpin(false);
            }, { passive: true });
        }

        function mountWindow(bodyEl) {
            const L = LOOKS.window;
            bodyEl.innerHTML = `
                <div class="nb-win">
                    <div class="nb-controls">
                        <div class="cl-cwin-tabs nb-views" role="tablist" aria-label="Next Beat">
                            <button type="button" class="cl-cwin-tab is-on" role="tab" aria-selected="true" data-nb-view="suggest"><i class="fa-solid fa-route" aria-hidden="true"></i><span>Suggest</span></button>
                            <button type="button" class="cl-cwin-tab" role="tab" aria-selected="false" data-nb-view="director"><i class="fa-solid ${DIRECTOR.icon}" aria-hidden="true"></i><span>Director</span></button>
                            <button type="button" class="cl-cwin-tab" role="tab" aria-selected="false" data-nb-view="styles"><i class="fa-solid fa-sliders" aria-hidden="true"></i><span>Styles</span></button>
                        </div>
                        <div class="nb-seg" data-nb-win="styles" data-nb-suggest-only role="group" aria-label="Suggestions in a style"></div>
                        <div class="nb-win-verbs" data-nb-suggest-only>
                            ${buttonHtml(`${L.btn} nb-win-btn`, 'data-nb-win="genres" aria-haspopup="menu"', 'fa-masks-theater', 'Genres')}
                            ${buttonHtml(`${L.btn} nb-win-btn`, 'data-nb-win="custom" aria-haspopup="menu"', 'fa-layer-group', 'Your Styles')}
                            <span class="nb-foot-gap"></span>
                            ${buttonHtml(`${L.btn} nb-win-btn`, 'data-nb-win="surprise" aria-haspopup="menu"', 'fa-wand-magic-sparkles', 'Surprise Me')}
                        </div>
                    </div>
                    <section class="nb-pane" data-nb-pane="suggest">
                        <div class="nb-win-host" data-nb-host="suggest"></div>
                    </section>
                    <section class="nb-pane" data-nb-pane="director" hidden><div class="nb-win-host" data-nb-host="director"></div></section>
                    <section class="nb-pane" data-nb-pane="styles" hidden><div class="nb-win-host" data-nb-host="styles"></div></section>
                </div>`;
            const hostOf = (name) => windowHost(bodyEl.querySelector(`[data-nb-host="${name}"]`));
            win = { el: bodyEl, open: false, close: null, chatId: null, pane: 'suggest', lib: null, director: null, hosts: { suggest: hostOf('suggest'), director: hostOf('director'), styles: hostOf('styles') } };
            bodyEl.addEventListener('click', (e) => {
                const tab = e.target.closest('[data-nb-view]')?.dataset.nbView;
                if (tab) { void showPane(tab); return; }
                const pick = e.target.closest('[data-nb-style]')?.dataset.nbStyle;
                if (pick) { toWindow.toSuggestions(win.chatId, pick); return; }
                const btn = e.target.closest('[data-nb-win]');
                const verb = btn?.dataset.nbWin;
                if (!win.chatId || !verb) return;
                if (verb === 'surprise') void openSurpriseMenu(win.chatId, btn);
                else if (verb === 'genres' || verb === 'custom') void openListMenu(win.chatId, btn, verb, toWindow);
            });
        }

        // the story styles as one track, the style on show raised; After Dark waits on its setting as on the strip
        function paintStyles() {
            const track = win?.el.querySelector('[data-nb-win="styles"]');
            if (!track) return;
            const on = view?.host.kind === 'window' && view.chatId === win.chatId && !view.director ? view.key : null;
            track.innerHTML = storyStyles().map(s => `<button type="button" class="nb-seg-btn${s.key === on ? ' is-on' : ''}" aria-pressed="${s.key === on}" data-nb-style="${esc(s.key)}"><i class="fa-solid ${esc(s.icon)}" aria-hidden="true"></i><span>${esc(s.name)}</span></button>`).join('');
        }

        // the pane on show, true once it is; leaving the styles with edits not saved asks first, and a discard puts the form back
        async function showPane(name, libKey = null) {
            if (!win) return false;
            if (win.pane === 'styles' && name !== 'styles' && win.lib?.dirty) {
                if (!(await discardEdits(win.lib))) return false;
                choose(win.lib, win.lib.chosen);
            }
            win.pane = name;
            for (const t of win.el.querySelectorAll('[data-nb-view]')) {
                const on = t.dataset.nbView === name;
                t.classList.toggle('is-on', on);
                t.setAttribute('aria-selected', String(on));
            }
            for (const p of win.el.querySelectorAll('[data-nb-pane]')) p.hidden = p.dataset.nbPane !== name;
            for (const c of win.el.querySelectorAll('[data-nb-suggest-only]')) c.hidden = name !== 'suggest';
            if (name === 'director' && win.chatId && win.director !== win.chatId) {
                mountDirector(win.hosts.director, win.chatId);
                win.director = win.chatId;
            }
            // a library written since (the settings' own manager, another tab) shows as it stands, unless edits wait in it
            if (name === 'styles' && (!win.lib || libKey)) win.lib = mountLibrary(win.hosts.styles, libKey);
            else if (name === 'styles' && !win.lib.dirty) {
                const lib = win.lib;
                void readStyles().then(() => { if (!lib.dirty) choose(lib, lib.chosen === '-new' || styleByKey(lib.chosen) ? lib.chosen : STORY[0].key); });
            }
            return true;
        }

        // the window shows the open chat: a set kept for it in the style on show, else the way to ask for one
        function showWindow(chatId) {
            if (!win) return;
            const moved = chatId !== win.chatId;
            win.chatId = chatId || null;
            if (moved || view?.host.kind !== 'window') {
                const was = view?.host.kind === 'window' ? view : null;
                if (was) { run?.abort(); view = null; }
                if (was && !was.director && chatId && results.has(resultKey(chatId, was.key))) mountSuggestions(win.hosts.suggest, chatId, was.key);
                else if (!was || moved) paintStart();
                win.director = null;
                if (win.pane === 'director' && chatId) { mountDirector(win.hosts.director, chatId); win.director = chatId; }
            }
            paintStyles();
        }
        function paintStart() {
            const root = rootIn(win.hosts.suggest, 'cl-cwin-empty nb-start');
            root.innerHTML = '<i class="fa-solid fa-route" aria-hidden="true"></i><p>Pick a style for ideas on where the story goes next, written by your model from this chat.</p>';
        }
        // After Dark's switch moves the track, here or in another tab
        ctx.events.on('settings.changed', ({ keys, all }) => {
            if (win && (all || keys.includes(`ext:${ID}:explicit`))) paintStyles();
        });

        // ======================================== the settings
        let armedList = null;     // the open chat's surprises in the settings section, while it is drawn
        const paintArmed = async () => {
            const host = armedList;
            if (!host) return;
            if (!openChat) { host.innerHTML = '<span class="settings-hint">Open a chat to see the surprises armed in it.</span>'; return; }
            let out;
            try { out = await readSurprises(openChat); } catch (e) {
                if (armedList === host) host.innerHTML = `<span class="settings-hint">The surprises could not be read: ${esc(why(e))}</span>`;
                return;
            }
            if (armedList !== host) return;
            host.innerHTML = out.surprises.length ? `
                <ul class="nb-armed">${out.surprises.map(s => `
                    <li class="nb-armed-row"><i class="fa-solid ${esc(s.icon)}" aria-hidden="true"></i><span class="nb-armed-name">${esc(s.name)}</span><span class="nb-armed-when">lands ${esc(whenLands(s))}</span>
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-nb-armed="${esc(s.id)}">Clear</button></li>`).join('')}</ul>
                <button type="button" class="cl-btn cl-btn-sm cl-btn-danger-hover" data-nb-armed="-all"><i class="fa-solid fa-eraser" aria-hidden="true"></i> Clear All</button>`
                : '<span class="settings-hint">None armed in the open chat.</span>';
        };
        ctx.events.on('chat.updated', ({ ids, fields }) => {
            if (armedList && openChat && ids.includes(openChat) && fields.includes(SURPRISE_FIELD)) void paintArmed();
        });

        ctx.ui.addSettingsSection((el) => {
            const on = (key) => (setting(key) === true ? ' checked' : '');
            const range = (key) => `min="${SETTING_LIMITS[key][0]}" max="${SETTING_LIMITS[key][1]}"`;
            const num = (key) => settingNumber(key, setting(key), ctx.settings.defaults[key]);
            const shownRange = surpriseRange(num('surpriseMin'), num('surpriseMax'));
            el.innerHTML = `
                <div class="settings-row">
                    <label>Where it lives</label>
                    <select class="cl-select-fluid" data-nb-choice="placement"><option value="strip">Buttons above the composer</option><option value="window">A window of its own</option></select>
                    <span class="settings-hint">A window opens from its own button in the conversation header, or its tile under Windows in a phone's chat options.</span>
                </div>
                <div class="settings-row">
                    <label>Connection</label>
                    <select class="cl-select-fluid" data-nb-profile><option value="">The one the chat uses</option></select>
                    <span class="settings-hint cl-hidden" data-nb-profile-gone>The connection picked here was deleted, so the one the chat uses runs instead.</span>
                </div>
                <div class="settings-group-title nb-set-title"><i class="fa-solid fa-route" aria-hidden="true"></i> Suggestions</div>
                <div class="settings-row">
                    <label>How many</label>
                    <input type="number" class="glass-input nb-count" data-nb-num="count" ${range('count')} step="1" value="${esc(num('count'))}">
                    <span class="settings-hint">Suggestions in each set. Director's steps get one each, however many there are.</span>
                </div>
                <div class="settings-row">
                    <label>Length</label>
                    <select class="cl-select-fluid" data-nb-choice="length">${Object.entries(LENGTHS).map(([k, l]) => `<option value="${k}">${esc(l.label)}</option>`).join('')}</select>
                </div>
                <div class="settings-row">
                    <label>Messages read</label>
                    <input type="number" class="glass-input nb-count" data-nb-num="depth" ${range('depth')} step="1" value="${esc(num('depth'))}">
                    <span class="settings-hint">The newest messages of the chat each request reads.</span>
                </div>
                <div class="settings-row"><label><input type="checkbox" class="cl-switch-input" data-nb-flag="scenario"${on('scenario')}><span class="cl-switch" aria-hidden="true"></span> Include the card's scenario</label></div>
                <div class="settings-row"><label><input type="checkbox" class="cl-switch-input" data-nb-flag="description"${on('description')}><span class="cl-switch" aria-hidden="true"></span> Include the card's description</label></div>
                <div class="settings-row">
                    <label><input type="checkbox" class="cl-switch-input" data-nb-flag="stream"${on('stream')}><span class="cl-switch" aria-hidden="true"></span> Show each suggestion as it is written</label>
                </div>
                <div class="settings-row">
                    <label><input type="checkbox" class="cl-switch-input" data-nb-flag="reasoning"${on('reasoning')}><span class="cl-switch" aria-hidden="true"></span> A reasoning model: give it room to think</label>
                    <span class="settings-hint">A model that thinks before it answers spends its output on the thinking first.</span>
                </div>
                <div class="settings-row" data-nb-reasoning-row>
                    <label>Most output tokens</label>
                    <input type="number" class="glass-input nb-count-wide" data-nb-num="reasoningTokens" ${range('reasoningTokens')} step="1000" value="${esc(num('reasoningTokens'))}">
                </div>
                <div class="settings-row">
                    <label><input type="checkbox" class="cl-switch-input" data-nb-flag="explicit"${on('explicit')}><span class="cl-switch" aria-hidden="true"></span> Offer After Dark suggestions</label>
                    <span class="settings-hint">For adult fiction: directions that turn toward desire and intimacy.</span>
                </div>
                <div class="settings-group-title nb-set-title"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i> Insert and Send</div>
                <div class="settings-row">
                    <label>Insert</label>
                    <select class="cl-select-fluid" data-nb-choice="insert"><option value="replace">Replaces what the composer holds</option><option value="append">Adds a line under what it holds</option></select>
                </div>
                <div class="settings-row">
                    <label>Wrap the text as</label>
                    <select class="cl-select-fluid" data-nb-choice="wrap">${Object.entries(WRAPS).map(([k, w]) => `<option value="${k}">${esc(w.label)}</option>`).join('')}</select>
                </div>
                <div class="settings-group-title nb-set-title"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Surprise me</div>
                <div class="settings-row">
                    <label>Lands after this many messages</label>
                    <div class="settings-input-group u-row">
                        <input type="number" class="glass-input nb-count" data-nb-num="surpriseMin" ${range('surpriseMin')} step="1" value="${esc(shownRange[0])}" aria-label="At the fewest">
                        <span class="settings-hint u-m-0">to</span>
                        <input type="number" class="glass-input nb-count" data-nb-num="surpriseMax" ${range('surpriseMax')} step="1" value="${esc(shownRange[1])}" aria-label="At the most">
                    </div>
                    <span class="settings-hint">A surprise lands at a random point in this range; the same number twice lands it at exactly that distance.</span>
                </div>
                <div class="settings-row">
                    <label><input type="checkbox" class="cl-switch-input" data-nb-flag="endless"${on('endless')}><span class="cl-switch" aria-hidden="true"></span> Endless: a surprise that lands arms its style again</label>
                </div>
                <div class="settings-row">
                    <label>In the open chat</label>
                    <div class="nb-armed-host" data-nb-armed-host></div>
                </div>
                <div class="settings-row">
                    <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-nb-manage><i class="fa-solid fa-sliders" aria-hidden="true"></i> Edit the Styles</button>
                    <span class="settings-hint">Every style's prompt, and styles of your own.</span>
                </div>`;
            const reasoningRow = el.querySelector('[data-nb-reasoning-row]');
            reasoningRow.hidden = setting('reasoning') !== true;
            for (const input of el.querySelectorAll('[data-nb-flag]')) {
                input.addEventListener('change', () => {
                    ctx.settings.set(input.dataset.nbFlag, input.checked);
                    if (input.dataset.nbFlag === 'reasoning') reasoningRow.hidden = !input.checked;
                });
            }
            for (const input of el.querySelectorAll('[data-nb-num]')) {
                input.addEventListener('change', () => {
                    const key = input.dataset.nbNum;
                    const v = settingNumber(key, input.value, ctx.settings.defaults[key]);
                    input.value = String(v);
                    ctx.settings.set(key, v);
                    if (key !== 'surpriseMin' && key !== 'surpriseMax') return;
                    const other = key === 'surpriseMin' ? 'surpriseMax' : 'surpriseMin';
                    const pair = el.querySelector(`[data-nb-num="${other}"]`);
                    ctx.settings.set(other, settingNumber(other, pair.value, ctx.settings.defaults[other]));
                });
            }
            // what each select shows for its stored value: a placement reads as the strip unless it says window
            const shownChoice = { length: () => lengthKey(setting('length')), wrap: () => wrapKey(setting('wrap')), placement: () => (inWindow() ? 'window' : 'strip') };
            for (const select of el.querySelectorAll('[data-nb-choice]')) {
                const key = select.dataset.nbChoice;
                select.value = shownChoice[key] ? shownChoice[key]() : String(setting(key));
                select.addEventListener('change', () => ctx.settings.set(key, select.value));
                CoreAPI.initCustomSelect(select);
            }
            el.querySelector('[data-nb-manage]').addEventListener('click', () => openLibrary());
            armedList = el.querySelector('[data-nb-armed-host]');
            armedList.addEventListener('click', async (e) => {
                const id = e.target.closest('[data-nb-armed]')?.dataset.nbArmed;
                if (!id || !openChat) return;
                if (await clearSurprises(openChat, id === '-all' ? null : id)) void paintArmed();
            });
            void paintArmed();
            // a pick deleted since shows the chats' own connection, which the server runs instead, and says why
            void ctx.ui.connectionSelect(el.querySelector('[data-nb-profile]')).then(({ gone }) => el.querySelector('[data-nb-profile-gone]').classList.toggle('cl-hidden', !gone));
        });
    },
};
