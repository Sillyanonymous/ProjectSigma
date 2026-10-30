// Midnight's client half: the palette on the page's root, the sky, the tint, its settings section,
// commands and menu verb.
import { BUILT_IN, AUTO_PHASES, SKIES, SKY_LABELS, DENSITIES, NAME_MAX, builtIn, parseChoice, phaseAt, tokensOf, tintTokens, dominantColor, hexToRgb, cleanPalette } from './palettes.js';
import { createSky } from './sky.js';
import { LOOK, LOOK_KEYS, lookOf, lookClasses } from './look.js';

const ID = 'theme-midnight';
const KEYS = ['palette', 'sky', 'density', 'tint'].map(k => `ext:${ID}:${k}`);
const LOOK_SETTING_KEYS = LOOK_KEYS.map(k => `ext:${ID}:${k}`);
const AUTO_EVERY_MS = 60 * 1000;
const NEW_PALETTE = { name: 'My palette', accent: '#9ad0ff', hue: 230, glow: 60, sky: 'stars' };
const TINT_KEYS = Object.keys(tintTokens({ r: 0, g: 0, b: 0 }, BUILT_IN[0]));
const SKY_COALESCE_MS = 150;

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
        const state = { def: builtIn('midnight'), choice: 'midnight', phase: null, missing: false, draft: null, own: null, written: [], looks: [] };
        let applying = 0;
        let sky = null;
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
        const ownDef = (p) => ({ id: `own:${p.id}`, name: p.name, accent: p.accent, hue: p.hue, glow: p.glow, sky: p.sky });

        // the user's own accent wins: a highlight colour picked in the theme, or --accent in their custom CSS
        const accentIsTheirs = () => {
            const mine = String(CoreAPI.getSetting('highlightColor') || '').toLowerCase();
            const stock = String(CoreAPI.getDefaultSetting?.('highlightColor') || '').toLowerCase();
            return (!!mine && !!stock && mine !== stock) || /--accent[\w-]*\s*:/.test(String(CoreAPI.getSetting('customCSS') || ''));
        };
        const syncAccent = () => root.classList.toggle('mn-accent', !accentIsTheirs());

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
        const railOn = () => look().nav !== 'top' && !CoreAPI.isMobileMode?.() && !!wideEnough?.matches;
        function syncRail(force = false) {
            const on = force ? false : railOn();
            if (on === railWas || (railWas === null && !on)) { railWas = on; return; }
            railWas = on;
            CoreAPI.refreshCharacters?.();
        }
        const skyColors = (t) => ({ accent: hexToRgb(t['--mn-accent']), accent2: hexToRgb(t['--mn-accent-2']), text: hexToRgb(t['--mn-text']) });
        // the sky is rebuilt only when what it shows changes, and a colour dragged in the editor rebuilds it at most every 150 ms
        let skyKey = '', skyColorKey = '', skyTimer = 0;
        const syncSky = (def, tokens) => {
            const kind = ctx.settings.get('sky') === false ? 'none' : def.sky;
            root.dataset.mnSky = kind;
            if (kind === 'none' || !SKIES.includes(kind)) {
                clearTimeout(skyTimer);
                sky?.destroy();
                sky = null;
                skyKey = '';
                return;
            }
            const motion = reduced?.matches ? 'off' : look().motion;
            const next = { kind, colors: skyColors(tokens), density: DENSITIES[ctx.settings.get('density')] || 1, phone: !!CoreAPI.isMobileMode?.(), still: motion === 'off', speed: motion === 'gentle' ? 0.5 : 1, calm: motion !== 'full' };
            const key = [kind, next.density, next.phone, next.still, next.speed, next.calm].join('|');
            const colorKey = [tokens['--mn-accent'], tokens['--mn-accent-2'], tokens['--mn-text']].join('|');
            // a sky that cannot draw leaves the palette standing
            try {
                if (!sky) sky = createSky(next);
                else if (key !== skyKey) { clearTimeout(skyTimer); sky.update(next); }
                else if (colorKey !== skyColorKey) {
                    clearTimeout(skyTimer);
                    skyTimer = setTimeout(() => { try { sky?.update(next); } catch (e) { ctx.log('the sky could not be drawn:', why(e)); } }, SKY_COALESCE_MS);
                }
            } catch (e) {
                ctx.log('the sky could not be drawn:', why(e));
                sky?.destroy();
                sky = null;
            }
            skyKey = key;
            skyColorKey = colorKey;
        };

        const writeTokens = (tokens) => {
            for (const k of state.written) if (!(k in tokens)) root.style.removeProperty(k);
            for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
            state.written = Object.keys(tokens);
        };

        /** Resolve the setting and write it to the page; a later call wins over one still reading. */
        async function apply() {
            const mine = ++applying;
            const picked = parseChoice(ctx.settings.get('palette')) || { kind: 'built-in', id: 'midnight' };
            let def = null, missing = false, phase = null;
            if (picked.kind === 'built-in') def = builtIn(picked.id);
            else if (picked.kind === 'auto') {
                phase = phaseAt(new Date());
                def = builtIn(phase.palette);
            } else {
                try {
                    const { palette } = await call(`/palettes/${encodeURIComponent(picked.id)}`);
                    def = ownDef(palette);
                } catch {
                    missing = true;
                }
                if (mine !== applying) return;
            }
            Object.assign(state, { def: def || builtIn('midnight'), choice: ctx.settings.get('palette'), phase, missing });
            paint();
        }

        // what is shown, written: the draft while the editor previews it, else the resolved palette
        function paint() {
            const def = state.draft || state.def;
            const tokens = tokensOf(def);
            writeTokens(tokens);
            root.dataset.mnPalette = state.draft ? 'draft' : (builtIn(def.id) ? def.id : 'own');
            root.dataset.mnContrast = def.contrast === 'high' ? 'high' : 'normal';
            syncLook();
            syncAccent();
            syncSky(def, tokens);
            void retint();
            section?.refresh();
        }

        /** Make a choice the account's palette; the page shows it at once. */
        const choose = async (value) => {
            ctx.settings.set('palette', value);
            await apply();
        };
        const describe = () => {
            const def = state.def;
            return {
                palette: state.choice || 'midnight', name: def.name, shows: def.id, phase: state.phase?.phase || null, missing: state.missing,
                accent: root.classList.contains('mn-accent') ? 'palette' : 'yours',
                sky: sky ? sky.status() : { kind: 'none', running: false, still: false, frames: 0 },
                tint: convEl()?.classList.contains('mn-tinted') ? convEl().style.getPropertyValue('--mn-tint-accent') : null,
            };
        };
        const choices = async () => {
            let own = [];
            try { own = await ownPalettes(); } catch { /* the built-ins still cycle */ }
            return [...BUILT_IN.map(p => p.id), ...own.map(p => `own:${p.id}`), 'auto'];
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
            if (!ctx.settings.get('tint') || !conv.chatId || !charId) { el.classList.remove('mn-tinted'); return; }
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
            if (!rgb) { el.classList.remove('mn-tinted'); return; }
            for (const [k, v] of Object.entries(tintTokens(rgb, state.draft || state.def))) el.style.setProperty(k, v);
            el.classList.add('mn-tinted');
        }
        ctx.events.on('conversation.changed', ({ chatId, charId }) => {
            conv = { chatId, charId };
            void retint();
        });
        // a new portrait gives a new tint
        ctx.events.on('character.updated', ({ ids, fields, all }) => {
            if (!all && !fields.includes('avatar')) return;
            for (const id of all ? [...tintCache.keys()] : ids) tintCache.delete(id);
            if (all || ids.includes(conv.charId)) void retint();
            if (heroId && (all || ids.includes(heroId))) setHero(heroId);
        });

        // ---- the details' hero: the opened character's small portrait as a root property; a declined open puts
        // the last back
        let heroRun = 0, heroId = null;
        const heroUrl = (id) => {
            const u = String(CoreAPI.getCharacterAvatarThumbUrl?.(id, 96) || '');
            let abs = u;
            try { abs = new URL(u, globalThis.location?.href).href; } catch { /* a page with no address keeps the path as given */ }
            return u ? `url("${abs.replace(/["\\\n]/g, '')}")` : '';
        };
        const setHero = (id) => {
            heroId = id || null;
            const url = heroId ? heroUrl(heroId) : '';
            if (url) root.style.setProperty('--mn-hero', url);
            else root.style.removeProperty('--mn-hero');
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
        // the sidebar's used width on the dialog, so the hero's header stands at its edge at any seam or scale
        const sideEl = () => document.querySelector?.('#charModal .modal-sidebar') || null;
        const glassEl = () => document.querySelector?.('#charModal .modal-glass') || null;
        let sideWatch = null;
        if (typeof ResizeObserver === 'function' && sideEl() && glassEl()) {
            sideWatch = new ResizeObserver(() => {
                const side = sideEl(), glass = glassEl();
                const w = side && side.offsetWidth ? getComputedStyle(side).width : '';
                if (!glass || !w.endsWith('px')) return;
                glass.style.setProperty('--mn-side-w', w);
                glass.classList.add('mn-side');
            });
            sideWatch.observe(sideEl());
        }

        // ---- Auto follows the clock, and a tab coming back checks it at once
        const autoCheck = () => {
            if (parseChoice(ctx.settings.get('palette'))?.kind === 'auto' && phaseAt(new Date()).phase !== state.phase?.phase) void apply();
        };
        const autoTimer = setInterval(autoCheck, AUTO_EVERY_MS);
        const onVisible = () => { if (document.visibilityState === 'visible') autoCheck(); };
        document.addEventListener('visibilitychange', onVisible);
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

        // ---- commands, and the menu's verb
        ctx.commands.register('next', async () => {
            const list = await choices();
            const at = list.indexOf(String(ctx.settings.get('palette')));
            await choose(list[(at + 1) % list.length]);
            return describe();
        }, { title: 'Switch Midnight to its next palette' });
        ctx.commands.register('palette', async ({ id } = {}) => {
            if (id === undefined) return describe();
            const picked = parseChoice(id);
            if (!picked) throw new Error(`no palette "${String(id).slice(0, 60)}": name ${BUILT_IN.map(p => p.id).join(', ')}, auto or own:<id>`);
            if (picked.kind === 'own' && !(await ownPalettes(true)).some(p => p.id === picked.id)) throw new Error(`no palette of your own has the id ${picked.id}`);
            await choose(id);
            return describe();
        }, { title: 'Pick a Midnight palette, or read the one in use' });
        ctx.ui.addAction('app', {
            id: 'next-palette', label: 'Next Palette', icon: 'fa-palette',
            run: async () => {
                const now = await ctx.commands.run(`${ID}.next`);
                if (now) CoreAPI.showToast(`Midnight: ${now.phase ? `Auto (${now.name})` : now.name}`, 'info');
            },
        });

        // ---- the settings section: swatches, the palette editor, the sky and the tint

        /** Save the editor's palette: a new one, or the one it opened. Answers the saved palette. */
        async function savePalette(draft, id) {
            const body = cleanPalette(draft);
            if (!body) throw new Error('a palette needs a name, an accent, a hue, a glow and a sky');
            const out = id ? await call(`/palettes/${encodeURIComponent(id)}`, 'PUT', body) : await call('/palettes', 'POST', body);
            state.own = out.palettes;
            return out.palette;
        }
        /** Delete one of the account's palettes; a deleted palette in use gives way to Midnight. */
        async function deletePalette(id) {
            const out = await call(`/palettes/${encodeURIComponent(id)}`, 'DELETE');
            state.own = out.palettes;
            if (ctx.settings.get('palette') === `own:${id}`) await choose('midnight');
        }

        // a palette's colours as the --sw-* properties its swatch and the preview tile paint from
        const swatchVars = (def) => {
            const t = tokensOf(def);
            return { '--sw-void': t['--mn-void'], '--sw-deep': t['--mn-deep'], '--sw-accent': t['--mn-accent'], '--sw-accent-2': t['--mn-accent-2'], '--sw-text': t['--mn-text'] };
        };
        const paintVars = (el, def) => { for (const [k, v] of Object.entries(swatchVars(def))) el.style.setProperty(k, v); };
        const swatch = (value, name, note, extra = '') => {
            const on = String(ctx.settings.get('palette')) === value;
            return `<button type="button" class="mn-swatch${on ? ' is-on' : ''}" role="radio" aria-checked="${on}" data-mn-pick="${esc(value)}" data-mn-paint="${esc(value)}" title="${esc(note)}">
                <span class="mn-swatch-sky" aria-hidden="true">${extra}<span class="mn-swatch-orb"></span></span>
                <span class="mn-swatch-name">${esc(name)}</span>
                <span class="mn-swatch-note">${esc(note)}</span>
            </button>`;
        };
        const autoStripes = AUTO_PHASES.map(p => `<span class="mn-swatch-band" data-mn-paint="${p.palette}"></span>`).join('');
        const DESKTOP_BADGE = ' <i class="fa-solid fa-desktop settings-platform-badge" title="Desktop only"></i>';
        const groupTitle = (icon, text) => `<div class="settings-group-title"><i class="${icon}" aria-hidden="true"></i> ${esc(text)}</div>`;
        const selectRow = (key, label, options, current, hint, desktop = false) => `
            <div class="settings-row"${desktop ? ' data-platform="desktop"' : ''}>
                <label for="mnPref-${key}">${esc(label)}:${desktop ? DESKTOP_BADGE : ''}</label>
                <select id="mnPref-${key}" class="glass-select" data-mn-pref="${key}">${options.map((o, i) => `<option value="${esc(o.value)}"${o.icon ? ` data-icon="${esc(o.icon)}"` : ''}${o.value === current ? ' selected' : ''}>${esc(o.label)}${i === 0 ? ' (Default)' : ''}</option>`).join('')}</select>
                <span class="settings-hint">${esc(hint)}</span>
            </div>`;
        const lookRows = (group, now) => LOOK.filter(o => o.group === group).map(o => selectRow(o.key, o.label, o.values, now[o.key], o.hint, !!o.desktop)).join('');
        const DENSITY_OPTIONS = [
            { value: 'balanced', label: 'Balanced', icon: 'fa-solid fa-star-half-stroke' },
            { value: 'sparse', label: 'Sparse', icon: 'fa-solid fa-star' },
            { value: 'rich', label: 'Rich', icon: 'fa-solid fa-star-of-life' },
        ];

        ctx.ui.addSettingsSection((el) => {
            let editing = null;
            let errorText = '';
            let busy = false;
            el.innerHTML = '<div class="mn-set" data-mn-set></div>';
            const host = el.querySelector('[data-mn-set]');

            const draw = () => {
                const own = state.own || [];
                const picked = parseChoice(ctx.settings.get('palette'));
                const ownPicked = picked?.kind === 'own' ? own.find(p => p.id === picked.id) : null;
                const phaseNow = phaseAt(new Date());
                const density = DENSITIES[String(ctx.settings.get('density'))] ? String(ctx.settings.get('density')) : 'balanced';
                const skyOn = ctx.settings.get('sky') !== false;
                const now = look();
                host.innerHTML = `
                    <div class="settings-group mn-set-group" data-mn-group="palette">
                        ${groupTitle('fa-solid fa-palette', 'Palette')}
                        <div class="mn-set-head">
                            <span class="mn-set-sub">${esc(state.missing ? 'The palette picked here is gone, so Midnight shows.' : picked?.kind === 'auto' ? `Auto: ${phaseNow.label.toLowerCase()}, so ${builtIn(phaseNow.palette).name}` : `${state.def.name} is in use`)}</span>
                        </div>
                        <div class="mn-swatches" role="radiogroup" aria-label="Palette">
                            ${BUILT_IN.map(p => swatch(p.id, p.name, p.note)).join('')}
                            ${swatch('auto', 'Auto', 'By the hour', `<span class="mn-swatch-bands">${autoStripes}</span>`)}
                            ${own.map(p => swatch(`own:${p.id}`, p.name, 'Your own')).join('')}
                        </div>
                        ${picked?.kind === 'auto' ? `<div class="mn-auto-row">${AUTO_PHASES.map(p => `<span class="mn-auto-step${p.phase === phaseNow.phase ? ' is-now' : ''}"><b class="mn-auto-label">${esc(p.label)}</b> ${esc(builtIn(p.palette).name)}</span>`).join('')}</div>` : ''}
                        <div class="mn-set-verbs">
                            <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-mn-act="new"${own.length >= 24 ? ' disabled' : ''}><i class="fa-solid fa-plus" aria-hidden="true"></i> New Palette</button>
                            ${ownPicked ? `<button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-mn-act="edit"><i class="fa-solid fa-pen" aria-hidden="true"></i> Edit ${esc(ownPicked.name)}</button>` : ''}
                        </div>
                        <p class="settings-hint mn-accent-note"${root.classList.contains('mn-accent') ? ' hidden' : ''}>Your own accent colour is in use (picked in the theme, or set in your custom CSS), so the palettes colour everything else. Reset it there to let a palette choose the accent.</p>
                    </div>
                    <div class="mn-editor" data-mn-editor${editing ? '' : ' hidden'}></div>
                    <div class="settings-group mn-set-group" data-mn-group="layout">
                        ${groupTitle('fa-solid fa-table-columns', 'Layout')}
                        ${lookRows('layout', now)}
                    </div>
                    <div class="settings-group mn-set-group" data-mn-group="type">
                        ${groupTitle('fa-solid fa-font', 'Type and shape')}
                        ${lookRows('type', now)}
                    </div>
                    <div class="settings-group mn-set-group" data-mn-group="motion">
                        ${groupTitle('fa-solid fa-wand-magic-sparkles', 'Motion and sky')}
                        ${lookRows('motion', now)}
                        <div class="settings-row">
                            <label><input type="checkbox" class="cl-switch-input" data-mn-switch="sky"${skyOn ? ' checked' : ''}><span class="cl-switch" aria-hidden="true"></span> Draw the sky</label>
                            <span class="settings-hint">Stars, aurora, embers or a moonlit haze behind the app, as the palette says. It holds still when Motion is off or your system asks for less motion, and rests while the tab is hidden.</span>
                        </div>
                        <div class="mn-density-row"${skyOn ? '' : ' hidden'}>
                            ${selectRow('density', 'How much sky', DENSITY_OPTIONS, density, 'How many stars, embers and drifts of haze the sky draws.')}
                        </div>
                        <div class="settings-row">
                            <label><input type="checkbox" class="cl-switch-input" data-mn-switch="tint"${ctx.settings.get('tint') ? ' checked' : ''}><span class="cl-switch" aria-hidden="true"></span> Tint a conversation with its character's colours</label>
                            <span class="settings-hint">The conversation's glow and accent lean toward the colour of the character's portrait, and fade back when you leave.</span>
                        </div>
                    </div>`;
                for (const el of host.querySelectorAll('[data-mn-paint]')) {
                    const key = el.dataset.mnPaint;
                    const mine = own.find(p => `own:${p.id}` === key);
                    paintVars(el, mine ? ownDef(mine) : builtIn(key === 'auto' ? phaseNow.palette : key) || builtIn('midnight'));
                }
                for (const sel of host.querySelectorAll('select[data-mn-pref]')) CoreAPI.initCustomSelect?.(sel);
                if (editing) drawEditor();
            };

            const drawEditor = () => {
                const box = host.querySelector('[data-mn-editor]');
                const d = editing.draft;
                box.hidden = false;
                box.innerHTML = `
                    <div class="mn-editor-head">
                        <span class="mn-set-title">${editing.id ? 'Edit palette' : 'New palette'}</span>
                        <span class="mn-set-sub">The app shows your changes as you make them; Cancel puts it back.</span>
                    </div>
                    <div class="mn-editor-body">
                        <div class="mn-preview" data-mn-preview aria-hidden="true">
                            <span class="mn-preview-sky"></span>
                            <span class="mn-preview-card"><span class="mn-preview-name">${esc(d.name || 'Palette')}</span><span class="mn-preview-line"></span><span class="mn-preview-line is-short"></span><span class="mn-preview-btn">Chat</span></span>
                        </div>
                        <div class="mn-editor-fields">
                            <div class="settings-row">
                                <label for="mnEdName">Name</label>
                                <input id="mnEdName" type="search" autocomplete="one-time-code" class="glass-input" maxlength="${NAME_MAX}" value="${esc(d.name)}" data-mn-ed="name">
                            </div>
                            <div class="settings-row">
                                <label for="mnEdAccent">Accent</label>
                                <div class="mn-color-row"><input id="mnEdAccent" type="color" class="mn-color" value="${esc(d.accent)}" data-mn-ed="accent"><span class="mn-color-hex" data-mn-hex>${esc(d.accent)}</span></div>
                            </div>
                            <div class="settings-row">
                                <label for="mnEdHue">Base hue <span class="mn-value" data-mn-val="hue">${d.hue}</span></label>
                                <input id="mnEdHue" type="range" class="mn-range mn-range-hue" min="0" max="359" step="1" value="${d.hue}" data-mn-ed="hue">
                            </div>
                            <div class="settings-row">
                                <label for="mnEdGlow">Glow <span class="mn-value" data-mn-val="glow">${d.glow}%</span></label>
                                <input id="mnEdGlow" type="range" class="mn-range" min="0" max="100" step="1" value="${d.glow}" data-mn-ed="glow">
                            </div>
                            <div class="settings-row">
                                <label for="mnEdSky">Sky</label>
                                <select id="mnEdSky" class="glass-select" data-mn-ed="sky">${SKIES.map(k => `<option value="${k}"${k === d.sky ? ' selected' : ''}>${esc(SKY_LABELS[k])}</option>`).join('')}</select>
                            </div>
                        </div>
                    </div>
                    <p class="settings-hint mn-editor-error" role="status" data-mn-ed-error${errorText ? '' : ' hidden'}>${esc(errorText)}</p>
                    <div class="mn-editor-foot">
                        ${editing.id ? '<button type="button" class="cl-btn cl-btn-sm cl-btn-danger-hover" data-mn-act="delete"><i class="fa-solid fa-trash" aria-hidden="true"></i> Delete</button>' : ''}
                        <span class="mn-editor-gap"></span>
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-mn-act="cancel">Cancel</button>
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-primary" data-mn-act="save"${busy ? ' disabled' : ''}><i class="fa-solid fa-check" aria-hidden="true"></i> Save Palette</button>
                    </div>`;
                const sel = box.querySelector('[data-mn-ed="sky"]');
                CoreAPI.initCustomSelect?.(sel);
                previewDraft();
            };

            // the preview tile and the app itself show the draft
            const previewDraft = () => {
                const d = editing.draft;
                const tile = host.querySelector('[data-mn-preview]');
                if (tile) paintVars(tile, d);
                const name = host.querySelector('.mn-preview-name');
                if (name) name.textContent = d.name || 'Palette';
                for (const [k, v] of [['hue', `${d.hue}`], ['glow', `${d.glow}%`]]) {
                    const out = host.querySelector(`[data-mn-val="${k}"]`);
                    if (out) out.textContent = v;
                }
                const hex = host.querySelector('[data-mn-hex]');
                if (hex) hex.textContent = d.accent;
                const glow = host.querySelector('[data-mn-ed="glow"]');
                glow?.style.setProperty('--mn-fill', `${d.glow}%`);
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
                const pick = e.target.closest('[data-mn-pick]')?.dataset.mnPick;
                if (pick) {
                    if (editing) { editing = null; state.draft = null; }
                    await choose(pick);
                    draw();
                    return;
                }
                const act = e.target.closest('[data-mn-act]')?.dataset.mnAct;
                if (!act || busy) return;
                if (act === 'new') {
                    editing = { id: null, draft: { ...NEW_PALETTE, hue: state.def.hue, accent: state.def.accent } };
                    draw();
                } else if (act === 'edit') {
                    const p = (state.own || []).find(x => `own:${x.id}` === ctx.settings.get('palette'));
                    if (!p) return;
                    editing = { id: p.id, draft: { name: p.name, accent: p.accent, hue: p.hue, glow: p.glow, sky: p.sky } };
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
                    const yes = await CoreAPI.showConfirm({ title: 'Delete this palette?', message: `${p.draft.name} is deleted from your palettes. A palette in use gives way to Midnight.`, confirmLabel: 'Delete', danger: true, icon: 'fa-solid fa-trash' });
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
                const key = e.target.dataset?.mnEd;
                if (!key || !editing) return;
                const v = e.target.value;
                editing.draft[key] = key === 'hue' || key === 'glow' ? Number.parseInt(v, 10) : v;
                previewDraft();
            });
            host.addEventListener('change', (e) => {
                const ed = e.target.dataset?.mnEd;
                if (ed === 'sky' && editing) { editing.draft.sky = e.target.value; previewDraft(); return; }
                const pref = e.target.dataset?.mnPref;
                if (pref === 'density' || LOOK_KEYS.includes(pref)) {
                    ctx.settings.set(pref, e.target.value);
                    paint();
                    return;
                }
                const key = e.target.dataset?.mnSwitch;
                if (key === 'sky' || key === 'tint') {
                    ctx.settings.set(key, e.target.checked);
                    paint();
                    draw();
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
            clearInterval(autoTimer);
            clearTimeout(skyTimer);
            document.removeEventListener('visibilitychange', onVisible);
            reduced?.removeEventListener?.('change', onMotion);
            sky?.destroy();
            sky = null;
            if (railWas) syncRail(true);
            for (const k of state.written) root.style.removeProperty(k);
            root.style.removeProperty('--mn-hero');
            sideWatch?.disconnect();
            const glass = glassEl();
            if (glass) {
                glass.classList.remove('mn-side');
                glass.style.removeProperty('--mn-side-w');
            }
            root.classList.remove('mn-accent', ...state.looks);
            for (const k of ['data-mn-palette', 'data-mn-sky', 'data-mn-contrast']) root.removeAttribute(k);
            const el = convEl();
            if (el) {
                el.classList.remove('mn-tinted');
                for (const k of TINT_KEYS) el.style.removeProperty(k);
            }
        };
    },

    dispose() {
        teardown?.();
        teardown = null;
    },
};
