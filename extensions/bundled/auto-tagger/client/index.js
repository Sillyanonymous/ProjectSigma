// Auto-tagger, the client half: applies the server's suggestions through the import rules and the
// tag command, then clears them.
import { SETTING_LIMITS, settingNumber } from './limits.js';

const ID = 'auto-tagger';
const BATCH = 1000;
// what one spelling read takes (the route's own cap)
const RESOLVE_BATCH = 200;

export default {
    init(ctx) {
        const { CoreAPI } = ctx;
        const esc = (s) => CoreAPI.escapeHtml(s);
        const call = ctx.server.call;

        // the library's spelling of each kept name, read in batches; a read, never a mint, and a failed read leaves them
        const spellingsOf = async (names) => {
            const map = new Map();
            const unique = [...new Set(names)];
            for (let i = 0; i < unique.length; i += RESOLVE_BATCH) {
                const batch = unique.slice(i, i + RESOLVE_BATCH);
                try {
                    const resp = await CoreAPI.apiRequest('/tags/resolve', 'POST', { names: batch, each: true });
                    if (resp.ok) {
                        const tags = (await resp.json()).tags || [];
                        batch.forEach((n, j) => map.set(n, tags[j]?.tag || n));
                        continue;
                    }
                } catch { /* the names as the rules left them */ }
                for (const n of batch) map.set(n, n);
            }
            return map;
        };

        // one pass at a time; a suggestion that lands mid-pass is read on one more
        let pass = null;
        let again = false;
        const applyWaiting = () => {
            if (pass) { again = true; return pass; }
            pass = (async () => {
                do {
                    again = false;
                    let waiting = [];
                    try { waiting = await call('/suggestions'); } catch { break; }
                    const keptOf = waiting.map(({ tags }) => CoreAPI.applyTagAliases(Array.isArray(tags) ? tags : []));
                    const spelling = await spellingsOf(keptOf.flat());
                    for (const [i, { charId }] of waiting.entries()) {
                        const kept = keptOf[i];
                        if (kept.length) {
                            let written = null;
                            try { written = await ctx.commands.run('tags.apply', { ids: [charId], add: [...new Set(kept.map(n => spelling.get(n) || n))] }); } catch { /* waits */ }
                            // not written: it waits for the next pass
                            if (!written) continue;
                        }
                        try { await call(`/suggestions/${encodeURIComponent(charId)}`, 'DELETE'); } catch { /* another tab took it */ }
                    }
                } while (again);
                pass = null;
            })();
            return pass;
        };

        ctx.events.on('character.updated', ({ fields }) => {
            if (fields.includes(`${ID}.suggestion`)) void applyWaiting();
        });
        // a resync (the feed was away) itemizes nothing: what waited meanwhile is read and applied now
        ctx.events.on('library.changed', () => { void applyWaiting(); });
        void applyWaiting();

        ctx.ui.addAction('bulk', {
            id: 'suggest',
            label: 'Suggest Tags with AI',
            icon: 'fa-wand-magic-sparkles',
            run: async ({ characters }) => {
                const ids = characters.map(c => c.id).filter(Boolean);
                if (!ids.length) return;
                // a Select All over a large view is thousands of calls from one menu row: said first
                const n = ids.length;
                const ok = await CoreAPI.showConfirm({
                    title: 'Suggest tags with AI?',
                    message: `Your model is asked about ${n} character${n === 1 ? '' : 's'}, one call each to the connection in the Auto-tagger's settings. The notifications center shows how far it is, and can stop it.`,
                    confirmLabel: `Ask for ${n}`,
                    icon: 'fa-solid fa-wand-magic-sparkles',
                });
                if (ok !== true) return;
                let queued = 0, skipped = 0;
                try {
                    for (let i = 0; i < ids.length; i += BATCH) {
                        const out = await call('/suggest', 'POST', { ids: ids.slice(i, i + BATCH) });
                        queued += out.queued.length;
                        skipped += out.skipped.length;
                    }
                } catch (e) {
                    // the requests before this one are queued: say how many, then why the rest are not
                    CoreAPI.showToast(queued ? `Asking your model for tags for ${queued} character${queued === 1 ? '' : 's'}; the rest could not be asked for: ${e.message}`
                        : `Could not ask for tags: ${e.message}`, 'error');
                    return;
                }
                const asked = `Asking your model for tags for ${queued} character${queued === 1 ? '' : 's'}; the notifications center shows how far it is`;
                CoreAPI.showToast(skipped ? `${asked} (${skipped} no longer in the library)` : asked, skipped ? 'warning' : 'success');
            },
        });

        ctx.ui.addSettingsSection((el) => {
            const on = (key) => ctx.settings.get(key) !== false;
            const num = (key) => settingNumber(key, ctx.settings.get(key), ctx.settings.defaults[key]);
            const range = (key) => `min="${SETTING_LIMITS[key][0]}" max="${SETTING_LIMITS[key][1]}"`;
            el.innerHTML = `
                <div class="settings-row">
                    <label>Connection</label>
                    <select class="cl-select-fluid" data-at-profile><option value="">The one your chats use</option></select>
                    <span class="settings-hint cl-hidden" data-at-profile-gone>The connection picked here was deleted, so the one your chats use runs instead.</span>
                </div>
                <div class="settings-row">
                    <label>Tags per character</label>
                    <input type="number" class="glass-input at-count" data-at-max ${range('maxTags')} step="1" value="${esc(num('maxTags'))}">
                </div>
                <div class="settings-row">
                    <label>
                        <input type="checkbox" class="cl-switch-input" data-at-import${on('onImport') ? ' checked' : ''}><span class="cl-switch" aria-hidden="true"></span>
                        <span>Tag characters as they arrive</span>
                    </label>
                </div>
                <div class="settings-row">
                    <label>
                        <input type="checkbox" class="cl-switch-input" data-at-untagged${on('untaggedOnly') ? ' checked' : ''}><span class="cl-switch" aria-hidden="true"></span>
                        <span>Only the ones that arrive without tags</span>
                    </label>
                    <span class="settings-hint">Each character is one call to your model. The tags pass your import rules and take your library's spellings. To tag some now, select them and pick Suggest Tags with AI.</span>
                </div>`;
            el.querySelector('[data-at-max]').addEventListener('change', (e) => {
                const count = settingNumber('maxTags', e.target.value, ctx.settings.defaults.maxTags);
                e.target.value = String(count);
                ctx.settings.set('maxTags', count);
            });
            el.querySelector('[data-at-import]').addEventListener('change', (e) => ctx.settings.set('onImport', e.target.checked));
            el.querySelector('[data-at-untagged]').addEventListener('change', (e) => ctx.settings.set('untaggedOnly', e.target.checked));
            // a pick deleted since shows the chats' own connection, which the server runs instead, and says why
            void ctx.ui.connectionSelect(el.querySelector('[data-at-profile]')).then(({ gone }) => el.querySelector('[data-at-profile-gone]').classList.toggle('cl-hidden', !gone));
        });
    },
};
