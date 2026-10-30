// Lore Search, the client half: one dialog over the server's index, from the topbar, a chat's options
// and a lore entry.
const ID = 'lore-search';
// the books this extension adds to a chat's scan carry this prefix before the real book's name
const OWN_BOOK = `ext:${ID}:`;
const TYPE_MS = 200;
const POLL_MS = 1500;

// the snippet's marks (U+0001 and U+0002 around each match) as <mark>, once the text is escaped
const markOf = (esc, s) => esc(s).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');

export default {
    init(ctx) {
        const { CoreAPI } = ctx;
        const esc = (s) => CoreAPI.escapeHtml(s);
        const call = ctx.server.call;

        let el = null;            // the dialog's body while it is open
        let state = null;         // { chatId, like, q, items, indexing, error, reach }
        let seq = 0;              // the newest read wins
        let poll = null;
        let typing = null;

        // ---- the dialog, in the app's own shell; whatever closes it ends its reads
        const dialog = ctx.ui.dialog({
            id: 'search', label: 'Lore Search', icon: 'fa-magnifying-glass', className: 'lsr-content',
            onClose: () => {
                clearTimeout(poll);
                clearTimeout(typing);
                poll = typing = null;
                seq++;
                el = null;
                state = null;
            },
        });
        const closeDialog = () => { void dialog.close({ force: true }); };

        function openDialog({ chatId = null, like = null } = {}) {
            closeDialog();
            state = { chatId, like, q: '', items: [], indexing: false, error: null, reach: null, loaded: false };
            el = dialog.open();
            el.classList.add('lsr-body');
            el.innerHTML = `
                <div class="lsr-reach" hidden>
                    <label class="lsr-reach-row">
                        <span class="lsr-reach-text">
                            <span class="lsr-reach-title">Reach other books in this chat</span>
                            <span class="lsr-hint">Adds the entries of books this chat does not use when it mentions their keys. The chat's Lorebooks window lists them under Added by extensions.</span>
                        </span>
                        <input type="checkbox" class="cl-switch-input" data-lsr="reach">
                        <span class="cl-switch" aria-hidden="true"></span>
                    </label>
                </div>
                <div class="lsr-search-wrap">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input type="search" class="cl-input lsr-search" data-lsr="q" placeholder="Search every lorebook" autocomplete="off" spellcheck="false">
                </div>
                <div class="lsr-like" hidden></div>
                <div class="lsr-status" aria-live="polite"></div>
                <div class="lsr-list"></div>`;
            el.addEventListener('click', onClick);
            el.addEventListener('input', onInput);
            el.addEventListener('change', onChange);
            // focus once the dialog shows (a hidden element cannot take it), never on a phone, where the keyboard would rise
            requestAnimationFrame(() => {
                if (!CoreAPI.isMobileMode?.()) el?.querySelector('[data-lsr="q"]')?.focus();
            });
            if (chatId) void readReach(chatId);
            if (like) void readLike();
            else paint();
        }

        function onClick(e) {
            const btn = e.target.closest('[data-lsr]');
            if (!btn) return;
            const act = btn.dataset.lsr;
            if (act === 'unlike') { state.like = null; state.items = []; state.loaded = false; return void readSearch(); }
            const item = state?.items?.[Number(btn.dataset.i)];
            if (!item) return;
            if (act === 'open') return void openEntry(item);
            if (act === 'like') { state.like = { world: item.world, uid: item.uid, title: item.title }; return void readLike(); }
        }

        function onInput(e) {
            if (e.target?.dataset?.lsr !== 'q') return;
            state.q = e.target.value;
            clearTimeout(typing);
            typing = setTimeout(() => {
                if (state?.like) state.like = null;
                void readSearch();
            }, TYPE_MS);
        }

        function onChange(e) {
            if (e.target?.dataset?.lsr === 'reach') void writeReach(e.target.checked);
        }

        // ---- reads, the newest winning
        async function readSearch() {
            const mine = ++seq;
            if (!state.q.trim()) {
                state.items = [];
                state.error = null;
                state.loaded = false;
                return paint();
            }
            try {
                const out = await call(`/search?q=${encodeURIComponent(state.q)}`);
                if (mine !== seq || !state) return;
                Object.assign(state, { items: out.items || [], indexing: !!out.indexing, error: null, loaded: true });
            } catch (e) {
                if (mine !== seq || !state) return;
                Object.assign(state, { items: [], error: e.message, loaded: true });
            }
            paint();
            follow();
        }

        async function readLike() {
            const mine = ++seq;
            const { world, uid } = state.like;
            try {
                const out = await call(`/like?world=${encodeURIComponent(world)}&uid=${encodeURIComponent(uid)}`);
                if (mine !== seq || !state) return;
                Object.assign(state, { items: out.items || [], indexing: !!out.indexing, error: null, loaded: true });
            } catch (e) {
                if (mine !== seq || !state) return;
                Object.assign(state, { items: [], error: e.message, loaded: true });
            }
            paint();
            follow();
        }

        // while the index is being read, the same question is asked again until it is done
        function follow() {
            clearTimeout(poll);
            if (!state?.indexing) return;
            poll = setTimeout(() => {
                if (!state) return;
                if (state.like) void readLike(); else void readSearch();
            }, POLL_MS);
        }

        async function readReach(chatId) {
            try {
                const out = await call(`/chats/${encodeURIComponent(chatId)}`);
                if (!state || state.chatId !== chatId) return;
                state.reach = out.reach === true;
            } catch { if (state) state.reach = null; }
            paintReach();
        }

        async function writeReach(on) {
            const chatId = state?.chatId;
            if (!chatId) return;
            try {
                const out = await call(`/chats/${encodeURIComponent(chatId)}`, 'PUT', { reach: on });
                if (state?.chatId === chatId) state.reach = out.reach === true;
                // the lore in force for the chat changed: its Lorebooks window reads it again
                CoreAPI.notifyWorldsChanged(null, ID);
                CoreAPI.showToast(on ? 'This chat now reaches other books' : 'This chat reads its own books only', 'success');
            } catch (e) {
                CoreAPI.showToast(`Could not change it: ${e.message}`, 'error');
            }
            paintReach();
        }

        async function openEntry(item) {
            closeDialog();
            try {
                await ctx.commands.run('lorebook.open', { name: item.world, uid: item.uid });
            } catch (e) {
                CoreAPI.showToast(`Could not open it: ${e.message}`, 'error');
            }
        }

        // ---- paint
        function paintReach() {
            const box = el?.querySelector('.lsr-reach');
            if (!box) return;
            box.hidden = !state.chatId || state.reach === null;
            const input = box.querySelector('[data-lsr="reach"]');
            if (input) input.checked = state.reach === true;
        }

        function itemHtml(it, i) {
            const keys = (it.keys || []).slice(0, 5).map(k => `<span class="lsr-key">${esc(k)}</span>`).join('');
            const more = (it.keys || []).length > 5 ? `<span class="lsr-key is-more">+${it.keys.length - 5}</span>` : '';
            const flags = [it.off ? '<span class="lsr-flag">off</span>' : '', it.constant ? '<span class="lsr-flag">always on</span>' : ''].join('');
            return `<div class="lsr-item">
                <div class="lsr-item-head">
                    <span class="lsr-book" title="${esc(it.world)}"><i class="fa-solid fa-book"></i><span>${esc(it.world)}</span></span>
                    <span class="lsr-title">${esc(it.title || (it.keys || [])[0] || `Entry ${it.uid}`)}</span>
                    ${flags}
                </div>
                ${keys || more ? `<div class="lsr-keys">${keys}${more}</div>` : ''}
                ${it.snippet ? `<p class="lsr-snippet">${markOf(esc, it.snippet)}</p>` : ''}
                <div class="lsr-item-acts">
                    <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-lsr="open" data-i="${i}"><i class="fa-solid fa-book-open"></i> Open</button>
                    <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-lsr="like" data-i="${i}"><i class="fa-solid fa-magnifying-glass-plus"></i> More Like This</button>
                </div>
            </div>`;
        }

        function paint() {
            if (!el || !state) return;
            paintReach();
            const like = el.querySelector('.lsr-like');
            like.hidden = !state.like;
            like.innerHTML = state.like
                ? `<span>Entries like <b>${esc(state.like.title || `entry ${state.like.uid}`)}</b> in ${esc(state.like.world)}</span>
                   <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-lsr="unlike"><i class="fa-solid fa-xmark"></i> Back to Search</button>`
                : '';
            const status = el.querySelector('.lsr-status');
            const list = el.querySelector('.lsr-list');
            const indexing = state.indexing ? '<p class="lsr-note"><i class="fa-solid fa-circle-notch fa-spin"></i> Reading your lorebooks into the index. The results fill in as it goes.</p>' : '';
            if (state.error) {
                status.innerHTML = '';
                list.innerHTML = `<p class="lsr-note is-error"></p>`;
                list.querySelector('.lsr-note').textContent = `The search failed: ${state.error}`;
                return;
            }
            if (!state.like && !state.q.trim()) {
                status.innerHTML = indexing;
                list.innerHTML = '<p class="lsr-empty">Search the titles, keys and text of every lorebook in your library.</p>';
                return;
            }
            if (!state.loaded) {
                status.innerHTML = '';
                list.innerHTML = '<p class="lsr-empty"><i class="fa-solid fa-circle-notch fa-spin"></i></p>';
                return;
            }
            const n = state.items.length;
            status.innerHTML = indexing || `<p class="lsr-count">${n ? `${n} ${n === 1 ? 'entry' : 'entries'}` : ''}</p>`;
            list.innerHTML = n
                ? state.items.map(itemHtml).join('')
                : `<p class="lsr-empty">${state.like ? 'No other entry shares its keys or its title.' : 'Nothing matches that.'}</p>`;
        }

        // ---- the three doors
        ctx.ui.addAction('app', { id: 'search', label: 'Search Lore', icon: 'fa-magnifying-glass', run: () => openDialog() });
        ctx.ui.addAction('chat', { id: 'search', label: 'Search Lore', icon: 'fa-magnifying-glass', run: ({ chatId }) => openDialog({ chatId }) });
        ctx.ui.addAction('lore', {
            id: 'like',
            label: 'More Like This',
            icon: 'fa-magnifying-glass-plus',
            // the library's own books, and the books this extension added; another extension's are its own
            when: ({ world }) => !world.startsWith('ext:') || world.startsWith(OWN_BOOK),
            run: ({ world, uid, entry, chatId }) => openDialog({
                chatId,
                like: { world: world.startsWith(OWN_BOOK) ? world.slice(OWN_BOOK.length) : world, uid, title: entry?.comment || entry?.key?.[0] || '' },
            }),
        });

        // ---- the settings section: what the index holds, and a rebuild
        ctx.ui.addSettingsSection((box) => {
            box.innerHTML = `<p class="lsr-setting" data-lsr-status>Reading the index...</p>
                <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-lsr-rebuild><i class="fa-solid fa-rotate"></i> Read Every Lorebook Again</button>`;
            const line = box.querySelector('[data-lsr-status]');
            const say = (s) => {
                line.textContent = s.indexing ? 'Reading your lorebooks into the index...'
                    : s.failed ? `The last read failed: ${s.failed}`
                        : `${s.entries} ${s.entries === 1 ? 'entry' : 'entries'} from ${s.books} ${s.books === 1 ? 'lorebook' : 'lorebooks'} in the index.`;
            };
            // while the index is being read, ask again until it is not, so a rebuild ends in counts or a failure
            let poll = null;
            const follow = (s) => {
                say(s);
                clearTimeout(poll);
                if (s.indexing && box.isConnected !== false) poll = setTimeout(() => { void status(); }, POLL_MS);
            };
            const status = () => call('/status').then(follow).catch((e) => { line.textContent = `The index could not be read: ${e.message}`; });
            void status();
            box.querySelector('[data-lsr-rebuild]').addEventListener('click', async () => {
                try { follow(await call('/rebuild', 'POST')); } catch (e) { CoreAPI.showToast(`Could not start it: ${e.message}`, 'error'); }
            });
        });

        ctx.log(`ready v${ctx.manifest.version}`);
    },
    dispose() {},
};
