// Chat Timeline: every chat with a character as one branching tree, in a conversation window and in a
// dialog of the app's own.
import { mountTimeline } from './view.js';
import { PRESETS, OWN, normalizeOwn } from './style.js';

export default {
    async init(ctx) {
        const api = ctx.CoreAPI;
        const views = new Set();
        const restyleAll = () => { for (const v of views) v.restyle(); };

        // ctx.chats.open reads the chat by id, so it works whatever the Chats list shows; ids survive renumbering
        async function openChatAt(chat, seq, messageId = null) {
            await closeDialog();
            const opened = await ctx.chats.open(chat.id, Number.isInteger(messageId) ? { messageId } : Number.isInteger(seq) ? { seq } : {});
            if (!opened) api.showToast(`"${chat.name || 'That chat'}" could not be opened`, 'warning');
        }

        // ---- door 1: the conversation window, following the open chat while it is open
        let windowView = null;
        let windowOpen = false;
        ctx.ui.addChatWindow({
            id: 'timeline',
            label: 'Timeline',
            icon: 'fa-code-branch',
            min: { w: 30, h: 34 },
            // render mounts; onOpen, which the host calls after it on the first open too, reads
            render(bodyEl) {
                windowView = mountTimeline(bodyEl, { ctx, compact: true, onOpenChat: openChatAt, onStyleChanged: restyleAll });
                views.add(windowView);
            },
            onOpen: ({ chatId, character }) => { windowOpen = true; return windowView?.show({ character, chatId }); },
            onClose: () => { windowOpen = false; windowView?.rest(); },
            // a write to the character on show (its name, its portrait) repaints it; any other is not ours
            follow: (detail, { character }) => {
                if (windowOpen && detail?.charId && detail.charId === character?.id) windowView?.setCharacter(character);
            },
        });
        // the conversation switched chats under an open window: the path follows, the latest switch wins
        let following = 0;
        ctx.events.on('conversation.changed', async ({ chatId, charId }) => {
            if (!windowOpen || !windowView || !chatId || !charId) return;
            const mine = ++following;
            const character = api.getCharacterById(charId) || await api.ensureCharacterById(charId);
            if (mine === following && character) windowView.show({ character, chatId });
        });

        // ---- doors 2 and 3: the character and chat card menus open the app's dialog, resizable from its edges
        let dialogView = null;
        // a click on the backdrop or the close control means close; Escape and a phone's back step back first
        let pointerClose = false;
        const dialog = ctx.ui.dialog({
            id: 'timeline',
            label: 'Chat Timeline',
            icon: 'fa-code-branch',
            className: 'ctl-dialog',
            size: true,
            min: { w: 560, h: 420 },
            canClose: () => pointerClose || !dialogView?.stepBack(),
            onClose: () => {
                if (dialogView) { dialogView.rest(); views.delete(dialogView); }
                dialogView = null;
            },
        });
        async function closeDialog() {
            if (dialog.isOpen()) await dialog.close({ force: true });
        }
        function openDialog(character, chatId = null) {
            const body = dialog.open({ title: `${character.name || 'Character'}: chat timeline` });
            const node = dialog.el;
            node?.addEventListener('click', (e) => {
                pointerClose = e.target === node || !!e.target.closest?.('.cl-modal-close');
                setTimeout(() => { pointerClose = false; }, 0);
            }, true);
            dialogView = mountTimeline(body, { ctx, onOpenChat: openChatAt, onStyleChanged: restyleAll });
            views.add(dialogView);
            dialogView.show({ character, chatId });
        }
        ctx.ui.addAction('character', {
            id: 'timeline',
            label: 'Chat Timeline',
            icon: 'fa-code-branch',
            run: ({ character }) => { if (character?.id) openDialog(character); },
        });
        // the chats view lists a chat without its character, so it is fetched at the click; the
        // timeline opens on that chat's path
        ctx.ui.addAction('chatCard', {
            id: 'timeline',
            label: 'Chat Timeline',
            icon: 'fa-code-branch',
            when: ({ charId }) => !!charId,
            run: async ({ chatId, charId }) => {
                const character = api.getCharacterById(charId) || await api.ensureCharacterById(charId);
                if (character) openDialog(character, chatId);
            },
        });

        // ---- live: the tree on show grows with its character's chats, read again once they settle
        const shown = () => [windowOpen && windowView, dialogView].filter(Boolean);
        for (const name of ['message.created', 'message.updated', 'message.deleted']) {
            ctx.events.on(name, ({ chatId }) => { for (const v of shown()) if (v.holds(chatId)) v.reloadSoon(); });
        }
        ctx.events.on('chat.created', ({ charId }) => { for (const v of shown()) if (charId && charId === v.charId()) v.reloadSoon(); });
        ctx.events.on('chat.deleted', ({ ids }) => { for (const v of shown()) if (ids.some(id => v.holds(id))) v.reloadSoon(); });
        // a rename, or a chat replaced whole (a re-import names no field); a draft saved as the reader types is neither
        ctx.events.on('chat.updated', ({ ids, fields }) => {
            for (const v of shown()) if ((!fields.length || fields.includes('name')) && ids.some(id => v.holds(id))) v.reloadSoon();
        });
        // nothing itemized (a reconnect, an import elsewhere): what was written meanwhile is read again
        ctx.events.on('library.changed', () => { for (const v of shown()) v.reloadSoon(); });

        // ---- settings
        ctx.ui.addSettingsSection((el) => {
            const own = normalizeOwn(ctx.settings.get('ownStyle'));
            const picked = ctx.settings.get('mapStyle');
            const options = [...Object.entries(PRESETS).map(([id, p]) => [id, p.label]), ...(own ? [[OWN, 'Your Own']] : [])];
            el.innerHTML = `
                <div class="settings-row">
                    <label>
                        <input type="checkbox" class="cl-switch-input" data-ctl-collapse ${ctx.settings.get('collapseRuns') !== false ? 'checked' : ''}><span class="cl-switch" aria-hidden="true"></span>
                        <span>Fold runs of messages into one card (off shows every message)</span>
                    </label>
                </div>
                <div class="settings-row">
                    <label>
                        <input type="checkbox" class="cl-switch-input" data-ctl-roads ${ctx.settings.get('showRoads') === true ? 'checked' : ''}><span class="cl-switch" aria-hidden="true"></span>
                        <span>Show the swipes you passed over, each as a faded branch</span>
                    </label>
                </div>
                <div class="settings-row">
                    <label>Map style</label>
                    <select class="cl-select-fluid" data-ctl-style>${options.map(([id, label]) => `<option value="${id}"${id === picked ? ' selected' : ''}>${label}</option>`).join('')}</select>
                    <span class="settings-hint">Make your own from the Style button on the map. Open it from a chat's Timeline window, or right-click a character (long-press on a phone) and pick Chat Timeline.</span>
                </div>`;
            el.querySelector('[data-ctl-collapse]').addEventListener('change', (e) => ctx.settings.set('collapseRuns', e.target.checked));
            el.querySelector('[data-ctl-roads]').addEventListener('change', (e) => ctx.settings.set('showRoads', e.target.checked));
            const select = el.querySelector('[data-ctl-style]');
            select.addEventListener('change', () => { ctx.settings.set('mapStyle', select.value); restyleAll(); });
            api.initCustomSelect(select);
        });

        ctx.log(`ready v${ctx.manifest.version}`);
    },
};
