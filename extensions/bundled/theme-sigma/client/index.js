// Σ's client half: the palette, the look, the field, the tint, the details' hero and its settings.
import { BUILT_IN, NAME_MAX, builtIn, parseChoice, tokensOf, tintTokens, dominantColor, hexToRgb, cleanPalette } from './palettes.js';
import { createField } from './field.js';
import { LOOK, LOOK_KEYS, lookOf, lookClasses } from './look.js';

const ID = 'theme-sigma';
const KEYS = ['palette', 'field', 'tint'].map(k => `ext:${ID}:${k}`);
const LOOK_SETTING_KEYS = LOOK_KEYS.map(k => `ext:${ID}:${k}`);
const NEW_PALETTE = { name: 'My palette', accent: '#4a9eff', accent2: '#5550f0', hue: 222, glow: 40 };
const TINT_KEYS = Object.keys(tintTokens({ r: 0, g: 0, b: 0 }, BUILT_IN[0]));
const FIELD_COALESCE_MS = 150;

let teardown = null;

/** @type {import('../../../../docs/extensions').ClientExtension} */
export default {
    init(ctx) {
        const { CoreAPI } = ctx;
        const esc = (s) => CoreAPI.escapeHtml(s);
        const call = ctx.server.call;
        const root = document.documentElement || document.createElement('html');
        const why = (e) => (e instanceof Error ? e.message : String(e));

        // ---- what is shown: the chosen palette resolved, or the editor's draft over it
        const state = { def: builtIn('sigma'), choice: 'sigma', missing: false, draft: null, own: null, written: [], looks: [] };
        let applying = 0;
        let field = null;
        // the rendered settings section, repainted when the palette changes under it
        let section = null;

        /** The account's own palettes, read once and kept until a write answers the new list. */
        const ownPalettes = async (fresh = false) => {
            if (!state.own || fresh) {
                const { palettes } = await call('/palettes');
                state.own = palettes;
            }
            return state.own;
        };
        const ownDef = (p) => ({ id: `own:${p.id}`, name: p.name, accent: p.accent, accent2: p.accent2, hue: p.hue, glow: p.glow });

        // the user's own accent wins: a highlight colour picked in the theme, or --accent in their custom CSS
        const accentIsTheirs = () => {
            const mine = String(CoreAPI.getSetting('highlightColor') || '').toLowerCase();
            const stock = String(CoreAPI.getDefaultSetting?.('highlightColor') || '').toLowerCase();
            return (!!mine && !!stock && mine !== stock) || /--accent[\w-]*\s*:/.test(String(CoreAPI.getSetting('customCSS') || ''));
        };
        const syncAccent = () => root.classList.toggle('sx-accent', !accentIsTheirs());

        const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') || null;
        const look = () => lookOf(k => ctx.settings.get(k));
        const syncLook = () => {
            const next = lookClasses(look(), { reduced: !!reduced?.matches });
            for (const c of state.looks) if (!next.includes(c)) root.classList.remove(c);
            for (const c of next) root.classList.add(c);
            state.looks = next;
            syncRail();
        };
        // the rail moves the page's edge, and the grid's scroller measures its width again only on a resize or a new query
        const wideEnough = globalThis.matchMedia?.('(min-width: 1000px)') || null;
        let railWas = null;
        const railOn = () => look().nav === 'rail' && !CoreAPI.isMobileMode?.() && !!wideEnough?.matches;
        function syncRail(force = false) {
            const on = force ? false : railOn();
            if (on === railWas || (railWas === null && !on)) { railWas = on; return; }
            railWas = on;
            CoreAPI.refreshCharacters?.();
        }

        // the field is rebuilt only when what it shows changes, and a colour dragged in the editor rebuilds it at most every 150 ms
        let fieldKey = '', fieldColorKey = '', fieldTimer = 0;
        const fieldColors = (t) => ({ g1: hexToRgb(t['--sx-g1']), g2: hexToRgb(t['--sx-g2']), g3: hexToRgb(t['--sx-g3']) });
        const syncField = (tokens) => {
            const on = ctx.settings.get('field') !== false;
            root.dataset.sxField = on ? 'on' : 'off';
            if (!on) {
                clearTimeout(fieldTimer);
                field?.destroy();
                field = null;
                fieldKey = '';
                return;
            }
            const motion = reduced?.matches ? 'off' : look().motion;
            const next = { colors: fieldColors(tokens), glow: Number(tokens['--sx-glow']) || 0, phone: !!CoreAPI.isMobileMode?.(), still: motion === 'off', speed: motion === 'gentle' ? 0.5 : 1 };
            const key = [next.phone, next.still, next.speed].join('|');
            const colorKey = [tokens['--sx-g1'], tokens['--sx-g2'], tokens['--sx-g3'], tokens['--sx-glow']].join('|');
            // a field that cannot draw leaves the palette standing
            try {
                if (!field) field = createField(next);
                else if (key !== fieldKey) { clearTimeout(fieldTimer); field.update(next); }
                else if (colorKey !== fieldColorKey) {
                    clearTimeout(fieldTimer);
                    fieldTimer = setTimeout(() => { try { field?.update(next); } catch (e) { ctx.log('the field could not be drawn:', why(e)); } }, FIELD_COALESCE_MS);
                }
            } catch (e) {
                ctx.log('the field could not be drawn:', why(e));
                field?.destroy();
                field = null;
            }
            fieldKey = key;
            fieldColorKey = colorKey;
        };

        const writeTokens = (tokens) => {
            for (const k of state.written) if (!(k in tokens)) root.style.removeProperty(k);
            for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
            state.written = Object.keys(tokens);
        };

        /** Resolve the setting and write it to the page; a later call wins over one still reading. */
        async function apply() {
            const mine = ++applying;
            const picked = parseChoice(ctx.settings.get('palette')) || { kind: 'built-in', id: 'sigma' };
            let def = null, missing = false;
            if (picked.kind === 'built-in') def = builtIn(picked.id);
            else {
                try {
                    const { palette } = await call(`/palettes/${encodeURIComponent(picked.id)}`);
                    def = ownDef(palette);
                } catch {
                    missing = true;
                }
                if (mine !== applying) return;
            }
            Object.assign(state, { def: def || builtIn('sigma'), choice: ctx.settings.get('palette'), missing });
            paint();
        }

        // what is shown, written: the draft while the editor previews it, else the resolved palette
        function paint() {
            const def = state.draft || state.def;
            const tokens = tokensOf(def);
            writeTokens(tokens);
            root.dataset.sxPalette = state.draft ? 'draft' : (builtIn(def.id) ? def.id : 'own');
            root.dataset.sxContrast = def.contrast === 'high' ? 'high' : 'normal';
            syncLook();
            syncAccent();
            syncField(tokens);
            void retint();
            section?.refresh();
        }

        /** Make a choice the account's palette; the page shows it at once. */
        const choose = async (value) => {
            ctx.settings.set('palette', value);
            await apply();
        };
        const describe = () => ({
            palette: state.choice || 'sigma', name: state.def.name, shows: state.def.id, missing: state.missing,
            accent: root.classList.contains('sx-accent') ? 'palette' : 'yours',
            field: field ? field.status() : { running: false, still: false, frames: 0 },
            tint: convEl()?.classList.contains('sx-tinted') ? convEl().style.getPropertyValue('--sx-tint-accent') : null,
        });
        const choices = async () => {
            let own = [];
            try { own = await ownPalettes(); } catch { /* the built-ins still cycle */ }
            return [...BUILT_IN.map(p => p.id), ...own.map(p => `own:${p.id}`)];
        };

        // ---- the conversation's tint: its character's portrait, sampled small, off the paint path
        const convEl = () => document.getElementById?.('chatsConversation') || null;
        const tintCache = new Map();
        let conv = { chatId: null, charId: null };
        let tintRun = 0;
        const sample = async (url) => {
            const img = new Image();
            img.decoding = 'async';
            img.src = url;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = 24;
            c.height = 36;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(img, 0, 0, 24, 36);
            return dominantColor(g.getImageData(0, 0, 24, 36).data);
        };
        async function retint() {
            const el = convEl();
            if (!el) return;
            const run = ++tintRun;
            const { charId } = conv;
            if (!ctx.settings.get('tint') || !conv.chatId || !charId) { el.classList.remove('sx-tinted'); return; }
            if (!tintCache.has(charId)) {
                let rgb = null;
                try {
                    await new Promise(r => setTimeout(r, 0));
                    rgb = await sample(CoreAPI.getCharacterAvatarSmallThumbUrl(charId));
                } catch { /* no picture to read, or a page that cannot read it: no tint */ }
                tintCache.set(charId, rgb);
            }
            if (run !== tintRun) return;
            const rgb = tintCache.get(charId);
            if (!rgb) { el.classList.remove('sx-tinted'); return; }
            for (const [k, v] of Object.entries(tintTokens(rgb, state.draft || state.def))) el.style.setProperty(k, v);
            el.classList.add('sx-tinted');
        }
        ctx.events.on('conversation.changed', ({ chatId, charId }) => {
            conv = { chatId, charId };
            void retint();
        });
        // a new portrait gives a new tint and a new hero
        ctx.events.on('character.updated', ({ ids, fields, all }) => {
            if (!all && !fields.includes('avatar')) return;
            for (const id of all ? [...tintCache.keys()] : ids) tintCache.delete(id);
            if (all || ids.includes(conv.charId)) void retint();
            if (heroId && (all || ids.includes(heroId))) setHero(heroId);
        });

        // ---- the details' hero: the opened character's portrait as a root property; a declined open puts the last back
        let heroRun = 0, heroId = null;
        // the grid's own tier: a card opened from the grid already holds it decoded, so the band costs no request
        const heroUrl = (id) => {
            const u = String(CoreAPI.getCharacterAvatarThumbUrl?.(id) || '');
            let abs = u;
            try { abs = new URL(u, globalThis.location?.href).href; } catch { /* a page with no address keeps the path as given */ }
            return u ? `url("${abs.replace(/["\\\n]/g, '')}")` : '';
        };
        const setHero = (id) => {
            heroId = id || null;
            const url = heroId ? heroUrl(heroId) : '';
            if (url) root.style.setProperty('--sx-hero', url);
            else root.style.removeProperty('--sx-hero');
        };
        try {
            ctx.commands.wrap('character.open', async (next, args) => {
                const mine = ++heroRun, before = heroId;
                const id = args?.id || args?.char?.id || null;
                if (id) setHero(id);
                const answer = await next();
                if (answer === false && mine === heroRun) setHero(before);
                return answer;
            });
        } catch (e) {
            // a page without the details has no open to follow; the hero alone goes
            ctx.log('the details\' hero is off:', why(e));
        }

        const onMotion = () => paint();
        reduced?.addEventListener?.('change', onMotion);
        ctx.events.on('settings.changed', ({ keys, all }) => {
            if (all || keys.some(k => KEYS.includes(k))) void apply();
            else if (keys.some(k => LOOK_SETTING_KEYS.includes(k))) paint();
            else if (keys.includes('highlightColor') || keys.includes('customCSS')) syncAccent();
        });
        // a resync names nothing: the palette and the own list are read again
        ctx.events.on('library.changed', () => { state.own = null; void apply(); });
        ctx.events.on('ui.formFactorChanged', () => paint());

        // ---- commands, and the menu's verbs
        ctx.commands.register('next', async () => {
            const list = await choices();
            const at = list.indexOf(String(ctx.settings.get('palette')));
            await choose(list[(at + 1) % list.length]);
            return describe();
        }, { title: 'Switch Σ to its next palette' });
        ctx.commands.register('palette', async ({ id } = {}) => {
            if (id === undefined) return describe();
            const picked = parseChoice(id);
            if (!picked) throw new Error(`no palette "${String(id).slice(0, 60)}": name ${BUILT_IN.map(p => p.id).join(', ')} or own:<id>`);
            if (picked.kind === 'own' && !(await ownPalettes(true)).some(p => p.id === picked.id)) throw new Error(`no palette of your own has the id ${picked.id}`);
            await choose(id);
            return describe();
        }, { title: 'Pick a Σ palette, or read the one in use' });
        ctx.ui.addAction('app', {
            id: 'next-palette', label: 'Next Σ Palette', icon: 'fa-palette',
            run: async () => {
                const now = await ctx.commands.run(`${ID}.next`);
                if (now) CoreAPI.showToast(`Σ: ${now.name}`, 'info');
            },
        });

        // ---- the settings section: swatches, the palette editor, the look, the field and the tint

        /** Save the editor's palette: a new one, or the one it opened. Answers the saved palette. */
        async function savePalette(draft, id) {
            const body = cleanPalette(draft);
            if (!body) throw new Error('a palette needs a name, two colours, a hue and a glow');
            const out = id ? await call(`/palettes/${encodeURIComponent(id)}`, 'PUT', body) : await call('/palettes', 'POST', body);
            state.own = out.palettes;
            return out.palette;
        }
        /** Delete one of the account's palettes; a deleted palette in use gives way to Σ. */
        async function deletePalette(id) {
            const out = await call(`/palettes/${encodeURIComponent(id)}`, 'DELETE');
            state.own = out.palettes;
            if (ctx.settings.get('palette') === `own:${id}`) await choose('sigma');
        }

        // a palette's colours as the --sw-* properties its swatch and the preview tile paint from
        const swatchVars = (def) => {
            const t = tokensOf(def);
            return { '--sw-ink': t['--sx-ink'], '--sw-deep': t['--sx-deep'], '--sw-g1': t['--sx-g1'], '--sw-g2': t['--sx-g2'], '--sw-g3': t['--sx-g3'], '--sw-text': t['--sx-text'], '--sw-fill-text': t['--sx-fill-text'], '--sw-fill-1': t['--sx-fill-1'], '--sw-fill-2': t['--sx-fill-2'] };
        };
        const paintVars = (el, def) => { for (const [k, v] of Object.entries(swatchVars(def))) el.style.setProperty(k, v); };
        const swatch = (value, name, note) => {
            const on = String(ctx.settings.get('palette')) === value;
            return `<button type="button" class="sx-swatch${on ? ' is-on' : ''}" role="radio" aria-checked="${on}" data-sx-pick="${esc(value)}" data-sx-paint="${esc(value)}" title="${esc(note)}">
                <span class="sx-swatch-field" aria-hidden="true"><span class="sx-swatch-dots"></span></span>
                <span class="sx-swatch-name">${esc(name)}</span>
                <span class="sx-swatch-note">${esc(note)}</span>
            </button>`;
        };
        const DESKTOP_BADGE = ' <i class="fa-solid fa-desktop settings-platform-badge" title="Desktop only"></i>';
        const groupTitle = (icon, text) => `<div class="settings-group-title"><i class="${icon}" aria-hidden="true"></i> ${esc(text)}</div>`;
        const selectRow = (key, label, options, current, hint, desktop = false) => `
            <div class="settings-row"${desktop ? ' data-platform="desktop"' : ''}>
                <label for="sxPref-${key}">${esc(label)}:${desktop ? DESKTOP_BADGE : ''}</label>
                <select id="sxPref-${key}" class="glass-select" data-sx-pref="${key}">${options.map((o, i) => `<option value="${esc(o.value)}"${o.icon ? ` data-icon="${esc(o.icon)}"` : ''}${o.value === current ? ' selected' : ''}>${esc(o.label)}${i === 0 ? ' (Default)' : ''}</option>`).join('')}</select>
                <span class="settings-hint">${esc(hint)}</span>
            </div>`;
        const lookRows = (group, now) => LOOK.filter(o => o.group === group).map(o => selectRow(o.key, o.label, o.values, now[o.key], o.hint, !!o.desktop)).join('');
        const switchRow = (key, label, hint) => `
            <div class="settings-row">
                <label><input type="checkbox" class="cl-switch-input" data-sx-switch="${key}"${ctx.settings.get(key) !== false ? ' checked' : ''}><span class="cl-switch" aria-hidden="true"></span> ${esc(label)}</label>
                <span class="settings-hint">${esc(hint)}</span>
            </div>`;

        ctx.ui.addSettingsSection((el) => {
            let editing = null;
            let errorText = '';
            let busy = false;
            el.innerHTML = '<div class="sx-set" data-sx-set></div>';
            const host = el.querySelector('[data-sx-set]');

            const draw = () => {
                const own = state.own || [];
                const picked = parseChoice(ctx.settings.get('palette'));
                const ownPicked = picked?.kind === 'own' ? own.find(p => p.id === picked.id) : null;
                const now = look();
                host.innerHTML = `
                    <div class="settings-group sx-set-group" data-sx-group="palette">
                        ${groupTitle('fa-solid fa-palette', 'Palette')}
                        <span class="sx-set-sub">${esc(state.missing ? 'The palette picked here is gone, so Σ shows.' : `${state.def.name} is in use`)}</span>
                        <div class="sx-swatches" role="radiogroup" aria-label="Palette">
                            ${BUILT_IN.map(p => swatch(p.id, p.name, p.note)).join('')}
                            ${own.map(p => swatch(`own:${p.id}`, p.name, 'Your own')).join('')}
                        </div>
                        <div class="sx-set-verbs">
                            <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-sx-act="new"${own.length >= 24 ? ' disabled' : ''}><i class="fa-solid fa-plus" aria-hidden="true"></i> New Palette</button>
                            ${ownPicked ? `<button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-sx-act="edit"><i class="fa-solid fa-pen" aria-hidden="true"></i> Edit ${esc(ownPicked.name)}</button>` : ''}
                        </div>
                        <p class="settings-hint sx-accent-note"${root.classList.contains('sx-accent') ? ' hidden' : ''}>Your own accent colour is in use (picked in the theme, or set in your custom CSS), so the palettes colour everything else. Reset it there to let a palette choose the accent.</p>
                    </div>
                    <div class="sx-editor" data-sx-editor${editing ? '' : ' hidden'}></div>
                    <div class="settings-group sx-set-group" data-sx-group="layout">
                        ${groupTitle('fa-solid fa-table-columns', 'Layout')}
                        ${lookRows('layout', now)}
                    </div>
                    <div class="settings-group sx-set-group" data-sx-group="type">
                        ${groupTitle('fa-solid fa-font', 'Type and shape')}
                        ${lookRows('type', now)}
                    </div>
                    <div class="settings-group sx-set-group" data-sx-group="motion">
                        ${groupTitle('fa-solid fa-wand-magic-sparkles', 'Motion and field')}
                        ${lookRows('motion', now)}
                        ${switchRow('field', 'Draw the field', 'Soft pools of the palette\'s light drifting slowly behind the app. It holds still when Motion is off or your system asks for less motion, and rests while the tab is hidden.')}
                        ${switchRow('tint', 'Tint a conversation with its character\'s colours', 'The conversation\'s accent and glow lean toward the colour of the character\'s portrait, and fade back when you leave.')}
                    </div>`;
                for (const node of host.querySelectorAll('[data-sx-paint]')) {
                    const key = node.dataset.sxPaint;
                    const mine = own.find(p => `own:${p.id}` === key);
                    paintVars(node, mine ? ownDef(mine) : builtIn(key) || builtIn('sigma'));
                }
                for (const sel of host.querySelectorAll('select[data-sx-pref]')) CoreAPI.initCustomSelect?.(sel);
                if (editing) drawEditor();
            };

            const drawEditor = () => {
                const box = host.querySelector('[data-sx-editor]');
                const d = editing.draft;
                box.hidden = false;
                box.innerHTML = `
                    <div class="sx-editor-head">
                        <span class="sx-set-title">${editing.id ? 'Edit palette' : 'New palette'}</span>
                        <span class="sx-set-sub">The app shows your changes as you make them; Cancel puts it back.</span>
                    </div>
                    <div class="sx-editor-body">
                        <div class="sx-preview" data-sx-preview aria-hidden="true">
                            <span class="sx-preview-card"><span class="sx-preview-name">${esc(d.name || 'Palette')}</span><span class="sx-preview-line"></span><span class="sx-preview-line is-short"></span><span class="sx-preview-btn">Chat</span></span>
                        </div>
                        <div class="sx-editor-fields">
                            <div class="settings-row">
                                <label for="sxEdName">Name</label>
                                <input id="sxEdName" type="search" autocomplete="one-time-code" class="glass-input" maxlength="${NAME_MAX}" value="${esc(d.name)}" data-sx-ed="name">
                            </div>
                            <div class="settings-row">
                                <label for="sxEdAccent">Colours</label>
                                <div class="sx-color-row">
                                    <input id="sxEdAccent" type="color" class="sx-color" value="${esc(d.accent)}" data-sx-ed="accent" aria-label="The first colour">
                                    <input id="sxEdAccent2" type="color" class="sx-color" value="${esc(d.accent2)}" data-sx-ed="accent2" aria-label="The second colour">
                                    <span class="sx-color-hex" data-sx-hex>${esc(d.accent)} to ${esc(d.accent2)}</span>
                                </div>
                            </div>
                            <div class="settings-row">
                                <label for="sxEdHue">Background hue <span class="sx-value" data-sx-val="hue">${d.hue}</span></label>
                                <input id="sxEdHue" type="range" class="sx-range sx-range-hue" min="0" max="359" step="1" value="${d.hue}" data-sx-ed="hue">
                            </div>
                            <div class="settings-row">
                                <label for="sxEdGlow">Glow <span class="sx-value" data-sx-val="glow">${d.glow}%</span></label>
                                <input id="sxEdGlow" type="range" class="sx-range" min="0" max="100" step="1" value="${d.glow}" data-sx-ed="glow">
                            </div>
                        </div>
                    </div>
                    <p class="settings-hint sx-editor-error" role="status" data-sx-ed-error${errorText ? '' : ' hidden'}>${esc(errorText)}</p>
                    <div class="sx-editor-foot">
                        ${editing.id ? '<button type="button" class="cl-btn cl-btn-sm cl-btn-danger-hover" data-sx-act="delete"><i class="fa-solid fa-trash" aria-hidden="true"></i> Delete</button>' : ''}
                        <span class="sx-editor-gap"></span>
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-sx-act="cancel">Cancel</button>
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-sx-act="save"${busy ? ' disabled' : ''}><i class="fa-solid fa-check" aria-hidden="true"></i> Save Palette</button>
                    </div>`;
                previewDraft();
            };

            // the preview tile and the app itself show the draft
            const previewDraft = () => {
                const d = editing.draft;
                const tile = host.querySelector('[data-sx-preview]');
                if (tile) paintVars(tile, d);
                const name = host.querySelector('.sx-preview-name');
                if (name) name.textContent = d.name || 'Palette';
                for (const [k, v] of [['hue', `${d.hue}`], ['glow', `${d.glow}%`]]) {
                    const out = host.querySelector(`[data-sx-val="${k}"]`);
                    if (out) out.textContent = v;
                }
                const hex = host.querySelector('[data-sx-hex]');
                if (hex) hex.textContent = `${d.accent} to ${d.accent2}`;
                host.querySelector('[data-sx-ed="glow"]')?.style.setProperty('--sx-range-at', `${d.glow}%`);
                state.draft = { id: 'draft', ...d };
                paint();
            };
            const endEditing = () => {
                editing = null;
                errorText = '';
                state.draft = null;
                paint();
                draw();
            };

            host.addEventListener('click', async (e) => {
                const pick = e.target.closest('[data-sx-pick]')?.dataset.sxPick;
                if (pick) {
                    if (editing) { editing = null; state.draft = null; }
                    await choose(pick);
                    draw();
                    return;
                }
                const act = e.target.closest('[data-sx-act]')?.dataset.sxAct;
                if (!act || busy) return;
                if (act === 'new') {
                    const d = state.def;
                    editing = { id: null, draft: { ...NEW_PALETTE, hue: d.hue, accent: d.accent, accent2: d.accent2 || NEW_PALETTE.accent2 } };
                    draw();
                } else if (act === 'edit') {
                    const p = (state.own || []).find(x => `own:${x.id}` === ctx.settings.get('palette'));
                    if (!p) return;
                    editing = { id: p.id, draft: { name: p.name, accent: p.accent, accent2: p.accent2, hue: p.hue, glow: p.glow } };
                    draw();
                } else if (act === 'cancel') {
                    endEditing();
                } else if (act === 'save') {
                    busy = true;
                    try {
                        const saved = await savePalette(editing.draft, editing.id);
                        editing = null;
                        errorText = '';
                        state.draft = null;
                        await choose(`own:${saved.id}`);
                        CoreAPI.showToast(`Saved ${saved.name}`, 'success');
                    } catch (err) {
                        errorText = `Not saved: ${why(err)}`;
                    } finally {
                        busy = false;
                    }
                    draw();
                } else if (act === 'delete') {
                    const p = editing;
                    const yes = await CoreAPI.showConfirm({ title: 'Delete this palette?', message: `${p.draft.name} is deleted from your palettes. A palette in use gives way to Σ.`, confirmLabel: 'Delete', danger: true, icon: 'fa-solid fa-trash' });
                    if (yes !== true) return;
                    busy = true;
                    try {
                        await deletePalette(p.id);
                        editing = null;
                        errorText = '';
                        state.draft = null;
                        await apply();
                    } catch (err) {
                        errorText = `Not deleted: ${why(err)}`;
                    } finally {
                        busy = false;
                    }
                    draw();
                }
            });
            host.addEventListener('input', (e) => {
                const key = e.target.dataset?.sxEd;
                if (!key || !editing) return;
                const v = e.target.value;
                editing.draft[key] = key === 'hue' || key === 'glow' ? Number.parseInt(v, 10) : v;
                previewDraft();
            });
            host.addEventListener('change', (e) => {
                const pref = e.target.dataset?.sxPref;
                if (LOOK_KEYS.includes(pref)) {
                    ctx.settings.set(pref, e.target.value);
                    paint();
                    return;
                }
                const key = e.target.dataset?.sxSwitch;
                if (key === 'field' || key === 'tint') {
                    ctx.settings.set(key, e.target.checked);
                    paint();
                }
            });

            section = { refresh: () => { if ((host.isConnected ?? true) && !editing) draw(); } };
            draw();
            ownPalettes(true).then(() => { if (!editing) draw(); }).catch((err) => ctx.log('the palettes could not be read:', why(err)));
        });

        void apply();

        // what dispose undoes: everything init did outside ctx
        teardown = () => {
            // a palette read or a tint still in flight finds itself overtaken, and paints nothing back
            applying++;
            tintRun++;
            clearTimeout(fieldTimer);
            reduced?.removeEventListener?.('change', onMotion);
            field?.destroy();
            field = null;
            if (railWas) syncRail(true);
            for (const k of state.written) root.style.removeProperty(k);
            root.style.removeProperty('--sx-hero');
            root.classList.remove('sx-accent', ...state.looks);
            for (const k of ['data-sx-palette', 'data-sx-field', 'data-sx-contrast']) root.removeAttribute(k);
            const el = convEl();
            if (el) {
                el.classList.remove('sx-tinted');
                for (const k of TINT_KEYS) el.style.removeProperty(k);
            }
        };
    },

    dispose() {
        teardown?.();
        teardown = null;
    },
};
