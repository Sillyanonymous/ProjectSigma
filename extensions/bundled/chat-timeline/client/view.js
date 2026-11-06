// SPDX-License-Identifier: MIT

// The timeline view for the window and the dialog: the server's folded tree as cards over SVG lines, a panel and a style.
import { fromWire, layout, pathOf, segmentsAt, excerpt } from './graph.js';
import { COLOURS, PATTERNS, CORNERS, FONTS, PRESETS, OWN, resolveStyle, applyStyle, normalizeOwn, exportOwn, parseImport, hexOf } from './style.js';

const CARD_W = 210;
const CARD_H = 58;
const COL_W = 262;
const LANE_H = 78;
const PAD = 36;
const TOP = 28;          // room above a card for the "You are here" pill
const ORIGIN_R = 36;
const X0 = PAD + ORIGIN_R * 2 + 52;
const END_W = 200;       // room for the chips written after a chat's last card
const K_MIN = 0.2, K_MAX = 2.2;
// the whole map is the first view down to this zoom; past it the view opens on your chat
const READABLE = 0.6;

// a write to the tree's chats reads it again once they settle, Memory's pause; a search waits out a typist
const SOON_MS = 400;
const SEARCH_MS = 250;

// ---- data: the server half's tree and search, through the host's door to it (ctx.server.call)
const fetchTree = (call, charId, { fold, roads }) => call(`/characters/${encodeURIComponent(charId)}/tree?fold=${fold ? 1 : 0}&roads=${roads ? 1 : 0}`);
const fetchHits = (call, charId, q) => call(`/characters/${encodeURIComponent(charId)}/search?q=${encodeURIComponent(q)}`);

const later = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 0));

// a default chat name: the character, then the app's stamp (YYYY-M-D @Hh Mm Ss MSms), then what a branch adds
const STAMP = /^(\d{4})-(\d{1,2})-(\d{1,2}) @(\d{1,2})h (\d{1,2})m(?: (\d{1,2})s)?(?: \d{1,3}ms)?(.*)$/;

/** A chat's name on the map: the reader's own as written; a default one without its character, its stamp a short date and time. */
export function chatLabel(name, charName = '', { seconds = false } = {}) {
    const raw = String(name || '').trim();
    if (!raw) return 'Untitled chat';
    const pre = charName ? `${charName} - ` : '';
    const rest = pre && raw.startsWith(pre) ? raw.slice(pre.length) : null;
    const m = rest !== null ? rest.match(STAMP) : null;
    if (!m) return raw;
    const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
    if (Number.isNaN(at.getTime())) return raw;
    const day = at.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(at.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) });
    const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
    const tail = m[7].replace(/^\s*-\s*/, '').trim();
    return `${day}, ${time}${tail ? ` · ${tail}` : ''}`;
}

/** One tree's labels told apart: a shared label says the second, and still shared is the stored name, unique per character. */
export function chatLabels(chats, charName = '') {
    const out = new Map();
    const clash = (map) => {
        const seen = new Map();
        for (const [id, label] of map) seen.set(label, [...(seen.get(label) || []), id]);
        return [...seen.values()].filter(ids => ids.length > 1).flat();
    };
    const byId = new Map(chats.map(c => [c.id, c]));
    for (const c of chats) out.set(c.id, chatLabel(c.name, charName));
    for (const id of clash(out)) out.set(id, chatLabel(byId.get(id).name, charName, { seconds: true }));
    for (const id of clash(out)) out.set(id, String(byId.get(id).name || '').trim() || 'Untitled chat');
    return out;
}

/** Labels side by side, less the parts they all open with ("Oct 18, 9:14 PM · Branch #1" beside "... · Branch #2"). */
export function tellApart(labels) {
    if (labels.length < 2) return labels.slice();
    const parts = labels.map(l => l.split(' · '));
    let k = 0;
    while (parts.every(p => p.length > k + 1 && p[k] === parts[0][k])) k++;
    return parts.map(p => p.slice(k).join(' · '));
}

/** How long ago a time was, the way a list of chats says it. */
export function ago(ms, now = Date.now()) {
    if (!Number.isFinite(ms)) return '';
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
    const d = Math.round(h / 24);
    if (d === 1) return 'yesterday';
    if (d < 30) return `${d} days ago`;
    return new Date(ms).toLocaleDateString();
}

// ---- the mount
export function mountTimeline(host, { ctx, onOpenChat, onStyleChanged, compact = false }) {
    const api = ctx.CoreAPI;
    const call = ctx.server.call;
    const esc = (s) => api.escapeHtml(s);
    const phone = () => !!document.documentElement?.classList?.contains('cl-mobile');
    const state = {
        charId: null, charName: '', character: null, currentChatId: null, focusChatId: null, previewChatId: null,
        answer: null, chats: [], chatById: new Map(), labels: new Map(), stale: false,
        byId: new Map(), segments: [], all: [], ghosts: [], ghostById: new Map(), lanes: 0, cols: 0,
        searchHits: null, truncated: false, total: 0, hits: new Set(), hitList: [], hitAt: -1, snippets: new Map(), activeHit: null,
        selected: null, pick: null, panel: 'chats', panelOpen: !compact && !phone(),
        tx: 0, ty: 0, k: 1, loadGen: 0, searchGen: 0,
    };
    let soonTimer = null, searchTimer = null;

    const tool = (act, icon, label, { labelled = false } = {}) =>
        `<button type="button" class="ctl-tool${labelled ? ' is-labelled' : ''}" data-ctl="${act}" title="${label}" aria-label="${label}"><i class="fa-solid ${icon}" aria-hidden="true"></i><span class="ctl-tool-label">${label}</span></button>`;

    host.innerHTML = `
        <div class="ctl-root${compact ? ' is-compact' : ''}">
            <div class="ctl-layout">
                <div class="ctl-main">
                    <div class="ctl-stage" tabindex="0" aria-label="Chat map: drag to move, scroll to zoom">
                        <div class="ctl-viewport">
                            <svg class="ctl-svg" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g class="ctl-wires"></g></svg>
                            <div class="ctl-cards"></div>
                        </div>
                        <div class="ctl-state"></div>
                    </div>
                    <div class="ctl-bar">
                        <div class="ctl-find">
                            <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                            <input type="search" class="ctl-search" placeholder="Search these chats" aria-label="Search these chats" maxlength="200" autocomplete="off" spellcheck="false">
                            <span class="ctl-find-count" hidden></span>
                            <button type="button" class="ctl-find-step" data-ctl="hit-prev" title="Previous match" aria-label="Previous match" hidden><i class="fa-solid fa-chevron-up" aria-hidden="true"></i></button>
                            <button type="button" class="ctl-find-step" data-ctl="hit-next" title="Next match" aria-label="Next match" hidden><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button>
                        </div>
                        <span class="ctl-count"></span>
                        <div class="ctl-tools">
                            <div class="ctl-group">${tool('roads', 'fa-ghost', 'Swipes', { labelled: true })}${tool('collapse', 'fa-layer-group', 'Every message', { labelled: true })}</div>
                            <div class="ctl-group">${tool('fit', 'fa-expand', 'Fit')}${tool('current', 'fa-location-crosshairs', 'Your chat')}${tool('reload', 'fa-rotate', 'Reload')}</div>
                            <div class="ctl-group">${tool('style', 'fa-palette', 'Style', { labelled: true })}${tool('panel', 'fa-list-ul', 'Chats', { labelled: true })}</div>
                        </div>
                    </div>
                    <div class="ctl-legend" aria-hidden="true">
                        <span><i class="ctl-key is-char"></i><span class="ctl-key-char">Character</span></span>
                        <span><i class="ctl-key is-user"></i>You</span>
                        <span><i class="ctl-key is-path"></i><span class="ctl-key-path">Your chat</span></span>
                        <span class="ctl-key-roads"><i class="ctl-key is-ghost"></i>Unused swipes</span>
                    </div>
                    <div class="ctl-zoom ctl-group">
                        <button type="button" class="ctl-tool" data-ctl="zoom-out" title="Zoom out" aria-label="Zoom out"><i class="fa-solid fa-minus" aria-hidden="true"></i></button>
                        <button type="button" class="ctl-tool ctl-zoom-level" data-ctl="zoom-reset" title="Back to 100%" aria-label="Back to 100%">100%</button>
                        <button type="button" class="ctl-tool" data-ctl="zoom-in" title="Zoom in" aria-label="Zoom in"><i class="fa-solid fa-plus" aria-hidden="true"></i></button>
                    </div>
                    <div class="ctl-pop" role="dialog" aria-label="Map style" hidden></div>
                </div>
                <aside class="ctl-panel" aria-label="Chats and moments"></aside>
            </div>
            <input type="file" class="ctl-import" accept=".json,application/json" hidden>
        </div>`;
    const root = host.querySelector('.ctl-root');
    const stage = root.querySelector('.ctl-stage');
    const viewport = root.querySelector('.ctl-viewport');
    const svg = root.querySelector('.ctl-svg');
    const wires = root.querySelector('.ctl-wires');
    const cards = root.querySelector('.ctl-cards');
    const stateEl = root.querySelector('.ctl-state');
    const panel = root.querySelector('.ctl-panel');
    const pop = root.querySelector('.ctl-pop');
    const search = root.querySelector('.ctl-search');
    const findCount = root.querySelector('.ctl-find-count');
    const countEl = root.querySelector('.ctl-count');
    const zoomLevel = root.querySelector('.ctl-zoom-level');
    const importInput = root.querySelector('.ctl-import');

    const setState = (html) => { stateEl.innerHTML = html; stateEl.hidden = !html; };
    const collapse = () => ctx.settings.get('collapseRuns') !== false;
    const roads = () => ctx.settings.get('showRoads') === true;
    const syncToggles = () => {
        const r = root.querySelector('[data-ctl="roads"]');
        r.classList.toggle('is-on', roads());
        r.setAttribute('aria-pressed', String(roads()));
        r.title = roads() ? 'Hide the swipes you passed over' : 'Show the swipes you passed over';
        const c = root.querySelector('[data-ctl="collapse"]');
        c.classList.toggle('is-on', !collapse());
        c.setAttribute('aria-pressed', String(!collapse()));
        c.title = collapse() ? 'Show every message as its own card' : 'Fold runs of messages into one card';
        root.querySelector('.ctl-key-roads').hidden = !roads();
        root.querySelector('[data-ctl="panel"]').classList.toggle('is-on', state.panelOpen);
        root.classList.toggle('is-panel-open', state.panelOpen);
    };

    // ---- style
    function restyle() {
        applyStyle(root, resolveStyle(ctx.settings.get('mapStyle'), ctx.settings.get('ownStyle')));
        if (!pop.hidden) drawPop();
    }

    // ---- model: the server's runs, laid out; a search's addresses mapped onto them
    function adopt(answer) {
        state.answer = answer;
        state.chats = Array.isArray(answer?.chats) ? answer.chats : [];
        state.chatById = new Map(state.chats.map(c => [c.id, c]));
        state.labels = chatLabels(state.chats, state.charName);
    }

    function rebuild() {
        state.segments = fromWire(state.answer);
        const lay = layout(state.segments);
        state.all = lay.all; state.ghosts = lay.ghosts; state.lanes = lay.lanes; state.cols = lay.cols;
        state.ghostById = new Map(state.ghosts.map(g => [g.id, g]));
        for (const s of state.all) if (s.ghost && !state.ghostById.has(s.ghost.id)) state.ghostById.set(s.ghost.id, s.ghost);
        state.byId = new Map(state.all.map(s => [s.id, s]));
        state.hits = segmentsAt(state.segments, state.searchHits || []);
        if (state.selected != null && !state.byId.has(state.selected) && !state.ghostById.has(state.selected)) state.selected = null;
        // the path shown: the open chat, else the one picked here, else the newest
        if (!state.chatById.has(state.focusChatId)) state.focusChatId = state.chatById.has(state.currentChatId) ? state.currentChatId : (state.chats[0]?.id || null);
    }

    // ---- geometry
    const xOf = (s) => X0 + s.col * COL_W;
    const yOf = (s) => PAD + TOP + s.lane * LANE_H;
    const rootY = () => PAD + TOP + (Math.max(1, state.lanes) - 1) * LANE_H / 2 + CARD_H / 2;
    const who = (name, speaker) => name || (speaker === 'user' ? 'You' : speaker === 'system' ? 'System' : (state.charName || 'Character'));
    const chatName = (id) => state.chatById.get(id)?.name || 'Untitled chat';
    const labelOf = (id) => state.labels.get(id) || chatLabel(state.chatById.get(id)?.name, state.charName);
    const curve = (x1, y1, x2, y2) => { const mx = (x1 + x2) / 2; return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`; };
    const meta = (s) => (s.n > 1 ? `${s.n} messages` : `#${s.last}`);
    // a card says how its run starts: where it parts from its siblings
    const lineOf = (s) => (s.head ? s.head : { speaker: s.speaker, name: s.name, text: s.text });
    const avatarUrl = () => (state.character ? api.getCharacterAvatarSmallThumbUrl(state.character) || '' : '');

    function avatarHtml(speaker, extra = '') {
        if (speaker === 'char') {
            const url = avatarUrl();
            return url ? `<span class="ctl-av is-char${extra}"><img src="${esc(url)}" alt="" loading="lazy" decoding="async"></span>` : `<span class="ctl-av is-char${extra}"><i class="fa-solid fa-comment" aria-hidden="true"></i></span>`;
        }
        return `<span class="ctl-av is-${speaker}${extra}"><i class="fa-solid ${speaker === 'user' ? 'fa-user' : 'fa-gear'}" aria-hidden="true"></i></span>`;
    }

    function cardHtml(s, searching) {
        const l = lineOf(s);
        const cls = ['ctl-seg', `is-${l.speaker}`];
        if (state.selected === s.id) cls.push('is-selected');
        if (searching) cls.push(state.hits.has(s) ? 'is-hit' : 'is-dim');
        const swipes = s.swipes ? '<span class="ctl-swipes" title="Has swipes"><i class="fa-solid fa-shuffle" aria-hidden="true"></i></span>' : '';
        const shared = s.chats.size > 1 ? `<span class="ctl-shared" title="In ${s.chats.size} chats"><i class="fa-solid fa-code-branch" aria-hidden="true"></i>${s.chats.size}</span>` : '';
        return `<div class="${cls.join(' ')}" data-seg="${s.id}" style="left:${xOf(s)}px;top:${yOf(s)}px" title="${esc(excerpt(l.text, 300))}">
                ${avatarHtml(l.speaker)}
                <div class="ctl-card-main">
                    <div class="ctl-card-top"><span class="ctl-who">${esc(who(l.name, l.speaker))}</span><span class="ctl-meta">${esc(meta(s))}</span>${shared}${swipes}</div>
                    <div class="ctl-line">${esc(l.text)}</div>
                </div>
            </div>`;
    }

    function ghostHtml(g, searching) {
        const n = g.alts.length;
        const cls = ['ctl-ghost'];
        if (state.selected === g.id) cls.push('is-selected');
        if (searching) cls.push('is-dim');
        const x = X0 + g.col * COL_W, y = PAD + TOP + g.lane * LANE_H;
        return `<div class="${cls.join(' ')}" data-ghost="${g.id}" style="left:${x}px;top:${y}px" title="${esc(excerpt(g.alts[0].text, 300))}">
                <span class="ctl-av is-ghost"><i class="fa-solid fa-ghost" aria-hidden="true"></i></span>
                <div class="ctl-card-main">
                    <div class="ctl-card-top"><span class="ctl-who">${n === 1 ? 'An unused swipe' : `${n} unused swipes`}</span></div>
                    <div class="ctl-line">${esc(g.alts[0].text)}</div>
                </div>
            </div>`;
    }

    // the ends of chats: a chip after a chat's last card, or a tab under a card the chat stops at while others go on
    function endsHtml(s) {
        if (!s.ends.length) return '';
        const flag = (id, cls, style, label = labelOf(id)) => `<button type="button" class="ctl-flag${cls}" data-open-chat="${esc(id)}" data-end="${esc(id)}" style="${style}" title="Open ${esc(chatName(id))}"><i class="fa-solid fa-flag" aria-hidden="true"></i><span>${esc(label)}</span></button>`;
        if (s.children.length) {
            // the card's width is the room: two chats a half each, a third and more behind one tab that shows the moment
            const named = s.ends.length > 2 ? s.ends.slice(0, 1) : s.ends;
            const w = (CARD_W - 28 - (named.length + (s.ends.length > 2 ? 1 : 0) - 1) * 4) / (named.length + (s.ends.length > 2 ? 1 : 0));
            const top = yOf(s) + CARD_H - 3;
            const apart = tellApart(named.map(labelOf));
            const tabs = named.map((id, i) => flag(id, ' is-tab', `left:${xOf(s) + 14 + i * (w + 4)}px;top:${top}px;max-width:${w}px`, apart[i]));
            if (s.ends.length > 2) tabs.push(`<button type="button" class="ctl-flag is-tab is-more" data-seg-end="${s.id}" style="left:${xOf(s) + 14 + w + 4}px;top:${top}px;max-width:${w}px" title="${s.ends.length} chats end here: see them all"><span>+${s.ends.length - 1} More</span></button>`);
            return tabs.join('');
        }
        return s.ends.map((id, i) => flag(id, '', `left:${xOf(s) + CARD_W + 12}px;top:${yOf(s) + CARD_H / 2 - 13 + i * 30}px`)).join('');
    }

    function draw({ intro = false } = {}) {
        const searching = state.searchHits !== null;
        const ry = rootY(), rx = PAD + ORIGIN_R;
        const lines = [], html = [];
        for (const s of state.segments) lines.push(`<path class="ctl-wire" data-wire="${s.id}" d="${curve(rx + ORIGIN_R + 6, ry, xOf(s), yOf(s) + CARD_H / 2)}"/>`);
        for (const g of state.ghosts) {
            const p = g.of.parent;
            const x1 = p ? xOf(p) + CARD_W : rx + ORIGIN_R + 6, y1 = p ? yOf(p) + CARD_H / 2 : ry;
            lines.push(`<path class="ctl-wire is-ghost" data-wire="${g.id}" d="${curve(x1, y1, X0 + g.col * COL_W, PAD + TOP + g.lane * LANE_H + CARD_H / 2)}"/>`);
            html.push(ghostHtml(g, searching));
        }
        for (const s of state.all) {
            for (const c of s.children) lines.push(`<path class="ctl-wire" data-wire="${c.id}" d="${curve(xOf(s) + CARD_W, yOf(s) + CARD_H / 2, xOf(c), yOf(c) + CARD_H / 2)}"/>`);
            html.push(cardHtml(s, searching), endsHtml(s));
        }
        const url = avatarUrl();
        const total = state.chats.length;
        html.push(`<div class="ctl-origin" style="left:${PAD}px;top:${ry - ORIGIN_R}px">
                <span class="ctl-origin-pic">${url ? `<img src="${esc(url)}" alt="" decoding="async">` : '<i class="fa-solid fa-user" aria-hidden="true"></i>'}</span>
                <span class="ctl-origin-name">${esc(state.charName)}</span>
                <span class="ctl-origin-sub">${total} ${total === 1 ? 'chat' : 'chats'}</span>
            </div>`);
        const { cw, ch } = treeSize();
        svg.setAttribute('width', String(cw));
        svg.setAttribute('height', String(ch));
        wires.innerHTML = lines.join('');
        cards.innerHTML = html.join('');
        root.querySelector('.ctl-key-char').textContent = state.charName || 'Character';
        root.classList.toggle('is-intro', intro);
        if (intro) setTimeout(() => root.classList.remove('is-intro'), 700);
        paintPath();
        paintCount();
        applyTransform();
    }

    // the path lit: a chat hovered in the list, else the one in focus; flipped in place, never a redraw
    function paintPath() {
        const chatId = state.previewChatId || state.focusChatId;
        const path = chatId ? pathOf(state.segments, chatId) : [];
        const on = new Set(path.map(s => s.id));
        for (const el of cards.querySelectorAll('[data-seg]')) el.classList.toggle('is-current', on.has(Number(el.dataset.seg)));
        for (const el of wires.querySelectorAll('[data-wire]')) el.classList.toggle('is-current', on.has(Number(el.dataset.wire)));
        for (const el of cards.querySelectorAll('[data-end]')) el.classList.toggle('is-here', el.dataset.end === chatId);
        // the key names the lit path: your chat when it is the open one, else that chat by name
        root.querySelector('.ctl-key-path').textContent = !chatId || chatId === state.currentChatId ? 'Your chat' : labelOf(chatId);
        cards.querySelector('.ctl-here-pill')?.remove();
        const tip = path[path.length - 1];
        if (tip && chatId === state.currentChatId && !state.previewChatId) {
            cards.querySelector(`[data-seg="${tip.id}"]`)?.insertAdjacentHTML('beforeend', '<span class="ctl-here-pill">You are here</span>');
        }
    }

    function paintCount() {
        const total = state.chats.length;
        countEl.textContent = `${total} ${total === 1 ? 'chat' : 'chats'}`;
        const searching = state.searchHits !== null;
        const n = state.hitList.length;
        findCount.hidden = !searching;
        findCount.textContent = !searching ? '' : !n ? 'No matches' : state.hitAt >= 0 ? `${state.hitAt + 1} of ${n}${state.truncated ? '+' : ''}` : `${n}${state.truncated ? '+' : ''} ${n === 1 ? 'match' : 'matches'}`;
        for (const b of root.querySelectorAll('.ctl-find-step')) b.hidden = !n;
    }

    // a search's answer flips the drawn cards' classes in place: no redraw for a keystroke
    function paintHits() {
        const searching = state.searchHits !== null;
        for (const el of cards.querySelectorAll('[data-seg]')) {
            const hit = searching && state.hits.has(state.byId.get(Number(el.dataset.seg)));
            el.classList.toggle('is-hit', hit);
            el.classList.toggle('is-dim', searching && !hit);
        }
        for (const el of cards.querySelectorAll('[data-ghost]')) el.classList.toggle('is-dim', searching);
        paintCount();
    }

    function applyTransform() {
        viewport.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.k})`;
        zoomLevel.textContent = `${Math.round(state.k * 100)}%`;
    }

    const treeSize = () => ({ cw: X0 + Math.max(1, state.cols) * COL_W + END_W, ch: PAD * 2 + TOP + Math.max(1, state.lanes) * LANE_H });
    // the bar over the map's top (two rows on a phone) and the zoom under its bottom are not room to fit into
    const bar = root.querySelector('.ctl-bar');
    const room = () => ({ w: stage.clientWidth || 600, h: stage.clientHeight || 400, top: bar.offsetHeight ? bar.offsetTop + bar.offsetHeight + 8 : 56, bottom: 44 });
    const fitScale = () => {
        const { cw, ch } = treeSize();
        const r = room();
        return Math.min(1, r.w / cw, (r.h - r.top - r.bottom) / ch);
    };

    function fit() {
        const r = room();
        const { cw, ch } = treeSize();
        state.k = Math.max(K_MIN, fitScale());
        state.tx = (r.w - cw * state.k) / 2;
        state.ty = r.top + (r.h - r.top - r.bottom - ch * state.k) / 2;
        applyTransform();
    }

    // a card into the middle of what is visible, at a readable zoom
    function centerOn(x, y, k = Math.max(state.k, 0.85)) {
        const r = room();
        state.k = Math.min(K_MAX, k);
        const bottomCard = !root.classList.contains('is-docked') && state.panelOpen ? r.h * 0.5 : 0;
        state.tx = r.w / 2 - x * state.k;
        state.ty = r.top + (r.h - r.top - r.bottom - bottomCard) / 2 - y * state.k;
        applyTransform();
    }
    const centerSeg = (s) => s && centerOn(xOf(s) + CARD_W / 2, yOf(s) + CARD_H / 2);

    function focusTip() {
        const p = state.focusChatId ? pathOf(state.segments, state.focusChatId) : [];
        const tip = p[p.length - 1];
        if (!tip) { fit(); return; }
        centerSeg(tip);
    }

    function initialView() {
        if (fitScale() >= READABLE) { fit(); return; }
        state.k = 0.85;
        if (state.focusChatId && pathOf(state.segments, state.focusChatId).length) { focusTip(); return; }
        const r = room();
        state.k = READABLE;
        state.tx = 12;
        state.ty = r.top + (r.h - r.top) / 2 - rootY() * state.k;
        applyTransform();
    }

    // ---- the panel: the chats, a moment, a moment's unused swipes
    const preferredChat = (s) => (state.focusChatId && s.chats.has(state.focusChatId) ? state.focusChatId : [...s.chats][0]);

    function setPanelOpen(open) {
        state.panelOpen = open;
        syncToggles();
    }

    function chatRowHtml(c, { open = 'chat', shown = false, ends = false } = {}) {
        const here = c.id === state.currentChatId;
        const sub = [`${c.messages} ${c.messages === 1 ? 'message' : 'messages'}`, ends ? 'ends here' : '', ago(c.lastAt)].filter(Boolean).join(' · ');
        const focus = open === 'moment' ? shown : c.id === state.focusChatId;
        return `<div class="ctl-chat${here ? ' is-here' : ''}${focus ? ' is-focus' : ''}" data-chat-row="${esc(c.id)}">
                <button type="button" class="ctl-chat-main" ${open === 'moment' ? `data-moment-chat="${esc(c.id)}" title="Read this moment in ${esc(c.name || 'this chat')}"` : `data-focus-chat="${esc(c.id)}" title="${esc(c.name || 'Untitled chat')}: show its path on the map"`}>
                    <span class="ctl-chat-name">${esc(labelOf(c.id))}</span>
                    <span class="ctl-chat-sub">${here ? '<b>You are here</b> · ' : ''}${esc(sub)}</span>
                </button>
                <button type="button" class="ctl-chat-open" ${open === 'moment' ? 'data-open' : 'data-open-chat'}="${esc(c.id)}" title="${open === 'moment' ? 'Open this chat at this moment' : 'Open this chat'}" aria-label="Open ${esc(c.name || 'this chat')}"><i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
            </div>`;
    }

    const closeBtn = '<button type="button" class="ctl-x" data-ctl="close-info" title="Close" aria-label="Close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>';

    function showChats() {
        state.panel = 'chats';
        state.selected = null; state.pick = null; state.activeHit = null;
        for (const el of cards.querySelectorAll('.is-selected')) el.classList.remove('is-selected');
        const total = state.chats.length;
        panel.innerHTML = `
            <div class="ctl-panel-head"><h3 class="ctl-panel-title">Chats <span class="ctl-panel-count">${total}</span></h3>${closeBtn}</div>
            <div class="ctl-panel-body">
                ${total ? `<div class="ctl-chats">${state.chats.map(c => chatRowHtml(c)).join('')}</div>` : '<p class="ctl-hint">No chats yet.</p>'}
                <p class="ctl-hint">Click a card to read that moment, double-click to open it. Pick a chat to light its path.</p>
            </div>`;
    }

    function messageBlock(speaker, name, seq, text) {
        return `<div class="ctl-msg is-${speaker}">${avatarHtml(speaker, ' is-small')}<div class="ctl-msg-main"><span class="ctl-msg-who">${esc(who(name, speaker))} <span>#${seq}</span></span><p>${esc(text)}</p></div></div>`;
    }

    function markIn(text, q) {
        const needle = String(q || '').trim().replace(/\s+/g, ' ');
        const at = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
        return at < 0 ? esc(text) : `${esc(text.slice(0, at))}<mark>${esc(text.slice(at, at + needle.length))}</mark>${esc(text.slice(at + needle.length))}`;
    }

    function showInfo(s, { fromHit = null } = {}) {
        if (!s) { showChats(); return; }
        state.panel = 'moment';
        state.selected = s.id;
        state.activeHit = fromHit;
        // held as an address, which a re-read of the tree keeps true where an id does not
        state.pick = { chatId: preferredChat(s), seq: s.last, ghost: false };
        // a class flip, never a redraw: the element under a double click must survive its first click
        for (const el of cards.querySelectorAll('.is-selected')) el.classList.remove('is-selected');
        cards.querySelector(`[data-seg="${s.id}"]`)?.classList.add('is-selected');
        const reading = state.chatById.get(state.pick.chatId);
        const chats = [...s.chats].map(id => state.chatById.get(id)).filter(Boolean)
            .sort((a, b) => (b.id === reading?.id) - (a.id === reading?.id) || (b.id === state.currentChatId) - (a.id === state.currentChatId));
        const range = s.n > 1 ? `Messages #${s.first} to #${s.last}` : `Message #${s.last}`;
        const where = s.chats.size > 1 ? ` · in ${s.chats.size} chats` : '';
        const hit = fromHit ? state.snippets.get(`${fromHit.chatId}:${fromHit.seq}`) : null;
        const middle = s.n - 2;
        const readingHere = reading && reading.id === state.currentChatId ? ' · <b>You are here</b>' : '';
        panel.innerHTML = `
            <div class="ctl-panel-head"><button type="button" class="ctl-back" data-ctl="back" title="Back to the chats"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Chats</button>${closeBtn}</div>
            <div class="ctl-panel-body">
                <div class="ctl-moment-head"><span class="ctl-av is-user is-chat"><i class="fa-solid fa-comments" aria-hidden="true"></i></span><div><span class="ctl-moment-chat" title="${esc(reading?.name || '')}">${esc(reading ? labelOf(reading.id) : 'Untitled chat')}</span><span class="ctl-panel-range">${range}${where}${s.swipes ? ' · swipes' : ''}${readingHere}</span></div></div>
                ${fromHit ? `<div class="ctl-found"><span>Found in ${esc(labelOf(fromHit.chatId))}, message #${fromHit.seq}</span>${hit ? `<p>${markIn(hit, search.value)}</p>` : ''}</div>` : ''}
                ${chats.length > 1 ? `<h4 class="ctl-panel-sub">Also in ${chats.length - 1} more ${chats.length === 2 ? 'chat' : 'chats'}: pick one to read it there</h4>
                <div class="ctl-chats">${chats.map(c => chatRowHtml(c, { open: 'moment', shown: c.id === reading?.id, ends: s.ends.includes(c.id) })).join('')}</div>` : ''}
                ${s.head ? messageBlock(s.head.speaker, s.head.name, s.first, s.head.text) : ''}
                ${s.head && middle > 0 ? `<div class="ctl-gap">${middle} more ${middle === 1 ? 'message' : 'messages'}</div>` : ''}
                ${messageBlock(s.speaker, s.name, s.last, s.text)}
            </div>
            <div class="ctl-panel-foot">
                ${s.ghost ? `<button type="button" class="cl-btn cl-btn-secondary" data-show-ghost="${s.ghost.id}"><i class="fa-solid fa-ghost" aria-hidden="true"></i> ${s.ghost.alts.length === 1 ? '1 Unused Swipe' : `${s.ghost.alts.length} Unused Swipes`}</button>` : ''}
                <button type="button" class="cl-btn cl-btn-secondary" data-open="${esc(reading?.id || '')}" title="Open ${esc(reading?.name || 'this chat')} at message #${s.last}"><i class="fa-solid fa-arrow-right" aria-hidden="true"></i> Open</button>
                <button type="button" class="cl-btn cl-btn-primary" data-ctl="branch" title="Start a new chat from ${esc(reading?.name || 'this chat')} that ends at message #${s.last}, and open it"><i class="fa-solid fa-code-branch" aria-hidden="true"></i> Branch from Here</button>
            </div>`;
        if (!state.panelOpen) setPanelOpen(true);
    }

    // a moment's unused swipes: every alternate of its messages, each one a chat away
    function showGhost(g) {
        if (!g) { showChats(); return; }
        state.panel = 'roads';
        state.selected = g.id;
        state.pick = { chatId: preferredChat(g.of), seq: g.of.last, ghost: true };
        for (const el of cards.querySelectorAll('.is-selected')) el.classList.remove('is-selected');
        cards.querySelector(`[data-ghost="${g.id}"]`)?.classList.add('is-selected');
        // a hidden ghost may cover several swiped messages: one group each, alternates keeping their flat index
        let at = 0;
        const groups = g.groups.map(grp => ({ ...grp, items: grp.alts.map(a => ({ a, i: at++ })) }));
        const first = groups[0];
        const range = groups.length === 1 ? `Message #${first.seq}` : `${groups.length} messages`;
        panel.innerHTML = `
            <div class="ctl-panel-head"><button type="button" class="ctl-back" data-ctl="back-moment" title="Back to this moment"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> This Moment</button>${closeBtn}</div>
            <div class="ctl-panel-body">
                <div class="ctl-moment-head"><span class="ctl-av is-ghost"><i class="fa-solid fa-ghost" aria-hidden="true"></i></span><div><span class="ctl-moment-who">${g.alts.length === 1 ? 'An unused swipe' : `${g.alts.length} unused swipes`}</span><span class="ctl-panel-range">${range} · what ${esc(who(first.name, first.speaker))} could have said</span></div></div>
                ${groups.map(grp => `
                <div class="ctl-said"><span>${groups.length > 1 ? `Message #${grp.seq}: ` : ''}What was said</span><p>${esc(grp.said)}</p></div>
                <div class="ctl-alts">${grp.items.map(({ a, i }) => `
                    <div class="ctl-alt">
                        <p>${esc(a.text)}</p>
                        <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-alt="${i}" title="Start a new chat that takes this swipe, and open it"><i class="fa-solid fa-code-branch" aria-hidden="true"></i> Take This Road</button>
                    </div>`).join('')}</div>`).join('')}
            </div>`;
        if (!state.panelOpen) setPanelOpen(true);
    }

    function refreshPanel() {
        if (state.panel === 'moment' && state.selected != null && state.byId.has(state.selected)) showInfo(state.byId.get(state.selected), { fromHit: state.activeHit });
        else if (state.panel === 'roads' && state.ghostById.has(state.selected)) showGhost(state.ghostById.get(state.selected));
        else showChats();
    }

    function focusChat(chatId, { center = true } = {}) {
        if (!state.chatById.has(chatId)) return;
        state.focusChatId = chatId;
        state.previewChatId = null;
        paintPath();
        for (const row of panel.querySelectorAll('[data-chat-row]')) row.classList.toggle('is-focus', row.dataset.chatRow === chatId);
        if (center) focusTip();
    }

    // ---- the style popover: presets, the reader's own colours and shapes, a file in and out
    function currentStyle() { return resolveStyle(ctx.settings.get('mapStyle'), ctx.settings.get('ownStyle')); }

    // the colours on show as #rrggbb, read through the page so a preset's tokens resolve; a see-through one over the background
    function shownColours() {
        const probe = document.createElement('span');
        root.appendChild(probe);
        const read = (key) => {
            probe.style.color = `var(--ctl-${key})`;
            return typeof getComputedStyle === 'function' ? getComputedStyle(probe).color : '';
        };
        const bg = hexOf(read('bg')) || '#000000';
        const out = {};
        for (const { key } of COLOURS) out[key] = hexOf(read(key), bg) || '#888888';
        probe.remove();
        return out;
    }

    function drawPop() {
        const cur = currentStyle();
        const own = normalizeOwn(ctx.settings.get('ownStyle'));
        const swatch = (id, label, colours) => `<button type="button" class="ctl-swatch${cur.id === id ? ' is-on' : ''}" data-style-pick="${id}" aria-pressed="${cur.id === id}">
                <span class="ctl-swatch-pv" style="--sw-bg:${colours.bg};--sw-a:${colours.char};--sw-b:${colours.you};--sw-c:${colours.path}"><i></i><i></i><i></i></span>
                <span class="ctl-swatch-name">${label}</span></button>`;
        const seg = (name, list, value) => `<div class="ctl-seg-pick" role="group" aria-label="${name}">${list.map(x => `<button type="button" data-style-${name}="${x.key}" class="${x.key === value ? 'is-on' : ''}" aria-pressed="${x.key === value}">${x.label}</button>`).join('')}</div>`;
        const colours = shownColours();
        pop.innerHTML = `
            <div class="ctl-pop-head"><h4>Map style</h4><button type="button" class="ctl-x" data-ctl="style-close" title="Close" aria-label="Close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>
            <div class="ctl-swatches">${Object.entries(PRESETS).map(([id, p]) => swatch(id, p.label, p.colours)).join('')}${own ? swatch(OWN, 'Your Own', own.colours) : '<button type="button" class="ctl-swatch is-empty" data-ctl="style-own" title="Start your own from the style on show"><span class="ctl-swatch-pv"><i class="fa-solid fa-plus" aria-hidden="true"></i></span><span class="ctl-swatch-name">Your Own</span></button>'}</div>
            <p class="ctl-pop-note">${own ? 'Any change below saves to Your Own.' : 'Press Your Own, or change anything below, to make your own.'}</p>
            <div class="ctl-colours">${COLOURS.map(c => `<label class="ctl-colour"><input type="color" data-colour="${c.key}" value="${colours[c.key]}"><span>${c.label}</span></label>`).join('')}</div>
            <div class="ctl-pop-row"><span>Background</span>${seg('pattern', PATTERNS, cur.pattern)}</div>
            <div class="ctl-pop-row"><span>Corners</span>${seg('corners', CORNERS, cur.corners)}</div>
            <div class="ctl-pop-row"><span>Type</span>${seg('font', FONTS, cur.font)}</div>
            <div class="ctl-pop-foot">
                <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ctl="style-export"${own ? '' : ' disabled title="Make Your Own first"'}><i class="fa-solid fa-file-export" aria-hidden="true"></i> Export</button>
                <button type="button" class="cl-btn cl-btn-sm cl-btn-secondary" data-ctl="style-import"><i class="fa-solid fa-file-import" aria-hidden="true"></i> Import</button>
            </div>`;
    }

    function setStylePop(open) {
        pop.hidden = !open;
        const b = root.querySelector('[data-ctl="style"]');
        b.classList.toggle('is-on', open);
        b.setAttribute('aria-expanded', String(open));
        if (open) drawPop();
    }

    // a change to anything the editor holds makes the shown style the reader's own, saved at once
    function saveOwn(change, { live = false } = {}) {
        const cur = currentStyle();
        const base = cur.id === OWN ? cur.base : cur.id;
        const next = normalizeOwn({ base, colours: { ...shownColours(), ...(change.colours || {}) }, pattern: change.pattern || cur.pattern, corners: change.corners || cur.corners, font: change.font || cur.font });
        if (!next) return;
        if (live) { applyStyle(root, { id: OWN, ...next }); return; }
        ctx.settings.set('ownStyle', next);
        ctx.settings.set('mapStyle', OWN);
        onStyleChanged ? onStyleChanged() : restyle();
    }

    function pickStyle(id) {
        ctx.settings.set('mapStyle', id);
        onStyleChanged ? onStyleChanged() : restyle();
    }

    function exportStyle() {
        const own = normalizeOwn(ctx.settings.get('ownStyle'));
        if (!own) return;
        api.downloadBlobAsFile(new Blob([exportOwn(own)], { type: 'application/json' }), 'chat-timeline-style.json');
    }

    importInput.addEventListener('change', async () => {
        const file = importInput.files?.[0];
        importInput.value = '';
        if (!file) return;
        const got = parseImport(await file.text());
        if (got instanceof Error) { api.showToast(got.message, 'error'); return; }
        ctx.settings.set('ownStyle', got);
        ctx.settings.set('mapStyle', OWN);
        onStyleChanged ? onStyleChanged() : restyle();
        api.showToast('Style imported as Your Own', 'success');
    });

    pop.addEventListener('input', (e) => {
        const c = e.target.closest?.('[data-colour]');
        if (c) saveOwn({ colours: { [c.dataset.colour]: c.value } }, { live: true });
    });
    pop.addEventListener('change', (e) => {
        const c = e.target.closest?.('[data-colour]');
        if (c) saveOwn({ colours: { [c.dataset.colour]: c.value } });
    });

    // ---- verbs
    async function openAt(chatId, s) {
        const chat = state.chatById.get(chatId);
        if (!chat) return;
        await onOpenChat?.(chat, s.last, s.lastIdOf?.get(chatId) ?? null);
    }

    async function openChat(chatId) {
        const chat = state.chatById.get(chatId);
        if (chat) await onOpenChat?.(chat, null, null);
    }

    // the server branches the stored chat, so the branch keeps its state; a chat renumbered since answers 409
    async function branch(chatId, seq, swipeId = null, messageId = null) {
        const body = { seq, ...(swipeId === null ? {} : { swipeId }), ...(Number.isInteger(messageId) ? { messageId } : {}) };
        const resp = await api.apiRequest(`/chats/${encodeURIComponent(chatId)}/branch`, 'POST', body);
        if (!resp.ok) throw Object.assign(new Error((await resp.json().catch(() => ({}))).error || `the server answered ${resp.status}`), { status: resp.status });
        return resp.json();
    }

    // a refusal over a chat that moved since the tree was read: the tree is read again
    async function branchFailed(e) {
        api.showToast(`Could not branch: ${e.message}`, 'error');
        if (e?.status === 404 || e?.status === 409) await load({ keepView: true });
    }

    // a branch is made to be carried on: the new chat opens, and the tree here shows it
    async function goToMade(made, said) {
        api.showToast(said, 'success');
        if (made?.id) {
            state.focusChatId = made.id;
            await onOpenChat?.(made, null, null);
        }
        if (state.charId) await load({ keepView: true });
    }

    async function branchFrom(s) {
        const chat = state.chatById.get(preferredChat(s));
        if (!chat) return;
        try {
            const made = await branch(chat.id, s.last, null, s.lastIdOf?.get(chat.id) ?? null);
            await goToMade(made, `New chat from "${chat.name}" at message #${s.last}`);
        } catch (e) {
            await branchFailed(e);
        }
    }

    async function branchFromAlt(alt) {
        if (!alt?.from) return;
        const seq = alt.group.seq;
        try {
            // the road is chosen on the branch in the branch's own write, as a swipe pick chooses it
            const made = await branch(alt.from.chatId, seq, alt.from.swipeId, alt.from.messageId ?? null);
            await goToMade(made, `New chat taking that swipe at message #${seq}`);
        } catch (e) {
            await branchFailed(e);
        }
    }

    // ---- load
    async function load({ keepView = false, intro = false } = {}) {
        clearTimeout(soonTimer);
        if (!state.charId) { setState('<p>Open a chat or pick a character to see its timeline.</p>'); cards.innerHTML = ''; wires.innerHTML = ''; showChats(); return; }
        const gen = ++state.loadGen;
        if (!state.answer) setState('<div class="ctl-loader"><i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i></div><p>Reading the chats</p>');
        try {
            const answer = await fetchTree(call, state.charId, { fold: collapse(), roads: roads() });
            if (gen !== state.loadGen) return;
            const first = !state.answer;
            adopt(answer);
            state.stale = false;
            rebuild();
            setState(state.chats.length ? '' : '<p>No chats with this character yet.</p>');
            draw({ intro: first || intro });
            if (!keepView) initialView();
            reselect();
            // a re-read can renumber a chat, so the addresses a search answered are asked again
            if (search.value.trim()) void runSearch({ jump: false });
        } catch (e) {
            if (gen !== state.loadGen) return;
            setState(`<p class="ctl-error">Could not read the chats: ${esc(e.message)}</p>`);
        }
    }

    // the panel held open follows its message to whichever run holds it now
    function reselect() {
        const p = state.pick;
        if (!p) { refreshPanel(); return; }
        const s = [...segmentsAt(state.segments, [{ chatId: p.chatId, seqs: [p.seq] }])][0] || null;
        if (p.ghost) {
            if (s?.ghost) showGhost(s.ghost);
            else showChats();
        } else if (s) showInfo(s, { fromHit: state.activeHit });
        else showChats();
    }

    const reloadSoon = () => {
        clearTimeout(soonTimer);
        soonTimer = setTimeout(() => { void load({ keepView: true }); }, SOON_MS);
    };

    // ---- search: the server's addresses, mapped onto the cards on show; Enter steps through them
    async function runSearch({ jump = true } = {}) {
        clearTimeout(searchTimer);
        const q = search.value.trim();
        const gen = ++state.searchGen;
        if (!q || !state.charId) {
            state.searchHits = null;
            state.truncated = false;
            state.snippets = new Map();
        } else {
            let answer = null;
            try { answer = await fetchHits(call, state.charId, q); } catch { /* a failed search highlights nothing */ }
            if (gen !== state.searchGen) return;
            state.searchHits = Array.isArray(answer?.hits) ? answer.hits : [];
            state.truncated = answer?.truncated === true;
            state.snippets = new Map((Array.isArray(answer?.snippets) ? answer.snippets : []).map(x => [`${x.chatId}:${x.seq}`, x.text]));
        }
        state.hits = segmentsAt(state.segments, state.searchHits || []);
        state.hitList = (state.searchHits || []).flatMap(h => (h.seqs || []).map(seq => ({ chatId: h.chatId, seq })));
        state.hitAt = -1;
        paintHits();
        if (jump && state.hitList.length) stepHit(1);
    }

    function stepHit(dir) {
        const n = state.hitList.length;
        if (!n) return;
        state.hitAt = state.hitAt < 0 ? (dir > 0 ? 0 : n - 1) : (state.hitAt + dir + n) % n;
        const hit = state.hitList[state.hitAt];
        const s = [...segmentsAt(state.segments, [{ chatId: hit.chatId, seqs: [hit.seq] }])][0];
        paintCount();
        if (!s) return;
        showInfo(s, { fromHit: hit });
        centerSeg(s);
    }

    // ---- keys: arrows walk the cards, Enter opens, / finds, + and - zoom, 0 fits
    function neighbour(s, key) {
        if (key === 'ArrowLeft') return s.parent;
        if (key === 'ArrowRight') return s.children.find(c => c.chats.has(state.focusChatId)) || s.children[0] || null;
        const col = state.all.filter(x => x.col === s.col).sort((a, b) => a.lane - b.lane);
        const i = col.indexOf(s);
        return col[key === 'ArrowUp' ? i - 1 : i + 1] || null;
    }

    root.addEventListener('keydown', (e) => {
        if (e.target === search) {
            if (e.key === 'Enter') { e.preventDefault(); if (state.hitList.length) stepHit(e.shiftKey ? -1 : 1); else void runSearch(); }
            return;
        }
        if (e.target.closest?.('input, textarea, select, .ctl-pop')) return;
        const sel = state.selected != null ? state.byId.get(state.selected) : null;
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
            e.preventDefault();
            const tip = pathOf(state.segments, state.focusChatId).pop() || state.all[0];
            const next = sel ? neighbour(sel, e.key) : tip;
            if (next) { showInfo(next); centerSeg(next); }
        } else if (e.key === 'Enter' && sel) {
            e.preventDefault();
            void openAt(preferredChat(sel), sel);
        } else if (e.key === '/') {
            e.preventDefault();
            search.focus();
        } else if (e.key === '+' || e.key === '=') zoomBy(1.2);
        else if (e.key === '-') zoomBy(1 / 1.2);
        else if (e.key === '0') fit();
    });

    // ---- input: pan, pinch, zoom, pick. Capture waits for a drag: on press it retargets the click
    let drag = null, moved = false, pressed = null, pinch = null;
    const pointers = new Map();
    const zoomAt = (px, py, k) => {
        k = Math.min(K_MAX, Math.max(K_MIN, k));
        state.tx = px - (px - state.tx) * (k / state.k);
        state.ty = py - (py - state.ty) * (k / state.k);
        state.k = k;
        applyTransform();
    };
    const zoomBy = (f) => { const r = room(); zoomAt(r.w / 2, r.h / 2, state.k * f); };
    const onMap = (e) => !e.target.closest?.('.ctl-bar, .ctl-zoom, .ctl-pop, .ctl-legend');
    stage.addEventListener('pointerdown', (e) => {
        if (!onMap(e)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (!pop.hidden && !e.target.closest?.('.ctl-pop')) setStylePop(false);
        if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: state.k };
            drag = null; moved = true;
            return;
        }
        drag = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty, id: e.pointerId };
        moved = false;
        pressed = e.target.closest?.('[data-seg], [data-ghost], [data-open-chat], [data-seg-end]') || null;
    });
    stage.addEventListener('pointermove', (e) => {
        if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            const r = stage.getBoundingClientRect();
            zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, pinch.k * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
            return;
        }
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        if (!moved) { stage.setPointerCapture?.(drag.id); root.classList.add('is-panning'); }
        moved = true;
        state.tx = drag.tx + dx; state.ty = drag.ty + dy;
        applyTransform();
    });
    const endDrag = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; drag = null; root.classList.remove('is-panning'); };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('wheel', (e) => {
        if (!onMap(e)) return;
        e.preventDefault();
        const r = stage.getBoundingClientRect();
        // a sideways scroll (a trackpad's) moves the map; the wheel zooms where it points
        if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) { state.tx -= e.deltaX; applyTransform(); return; }
        zoomAt(e.clientX - r.left, e.clientY - r.top, state.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
    }, { passive: false });
    stage.addEventListener('click', (e) => {
        if (moved || !onMap(e)) return;
        const target = e.target.closest?.('[data-seg], [data-ghost], [data-open-chat], [data-seg-end]') || pressed;
        pressed = null;
        if (target?.dataset?.openChat) { void openChat(target.dataset.openChat); return; }
        if (target?.dataset?.segEnd) { const s = state.byId.get(Number(target.dataset.segEnd)); if (s) showInfo(s); return; }
        if (target?.dataset?.ghost) { showGhost(state.ghostById.get(target.dataset.ghost)); return; }
        if (target?.dataset?.seg) {
            const s = state.byId.get(Number(target.dataset.seg));
            showInfo(s);
            // over the map the panel would cover the card it opened for: the card moves above it, at the same zoom
            if (s && !root.classList.contains('is-docked')) centerOn(xOf(s) + CARD_W / 2, yOf(s) + CARD_H / 2, state.k);
            return;
        }
        // the empty map: a moment shown goes back to the chats, and a card over the map closes
        if (state.panel !== 'chats') showChats();
        if (!root.classList.contains('is-docked') && state.panelOpen) setPanelOpen(false);
    });
    stage.addEventListener('dblclick', (e) => {
        const g = e.target.closest?.('[data-seg]') || (pressed?.dataset?.seg ? pressed : null);
        const s = g && state.byId.get(Number(g.dataset.seg));
        if (s) void openAt(preferredChat(s), s);
    });

    // the list of chats lights the path it points at while the pointer is on it
    panel.addEventListener('pointerover', (e) => {
        const row = e.target.closest?.('[data-chat-row]');
        const id = row?.dataset?.chatRow || null;
        if (state.panel !== 'chats' || id === state.previewChatId) return;
        state.previewChatId = id && id !== state.focusChatId ? id : null;
        paintPath();
    });
    panel.addEventListener('pointerleave', () => {
        if (!state.previewChatId) return;
        state.previewChatId = null;
        paintPath();
    });

    root.addEventListener('click', (e) => {
        const t = e.target;
        if (t.closest?.('.ctl-stage') && onMap(e)) return;
        const pick = t.closest?.('[data-style-pick]');
        if (pick) { pickStyle(pick.dataset.stylePick); return; }
        for (const name of ['pattern', 'corners', 'font']) {
            const b = t.closest?.(`[data-style-${name}]`);
            if (b) { saveOwn({ [name]: b.getAttribute(`data-style-${name}`) }); return; }
        }
        const showG = t.closest?.('[data-show-ghost]');
        if (showG) { showGhost(state.ghostById.get(showG.dataset.showGhost)); return; }
        const altBtn = t.closest?.('[data-alt]');
        const ghost = state.selected != null ? state.ghostById.get(state.selected) : null;
        if (altBtn && ghost) { void branchFromAlt(ghost.alts[Number(altBtn.dataset.alt)]); return; }
        const seg = state.selected != null ? state.byId.get(state.selected) : null;
        const readIn = t.closest?.('[data-moment-chat]');
        if (readIn && seg) { focusChat(readIn.dataset.momentChat, { center: false }); showInfo(seg, { fromHit: state.activeHit }); return; }
        const open = t.closest?.('[data-open]');
        if (open && seg) { void openAt(open.dataset.open, seg); return; }
        const openChatBtn = t.closest?.('[data-open-chat]');
        if (openChatBtn) { void openChat(openChatBtn.dataset.openChat); return; }
        const focusBtn = t.closest?.('[data-focus-chat]');
        if (focusBtn) { focusChat(focusBtn.dataset.focusChat); return; }
        const act = t.closest?.('[data-ctl]')?.dataset.ctl;
        if (act === 'fit') fit();
        else if (act === 'current') focusTip();
        else if (act === 'reload') void load({ keepView: true });
        else if (act === 'zoom-in') zoomBy(1.2);
        else if (act === 'zoom-out') zoomBy(1 / 1.2);
        else if (act === 'zoom-reset') { const r = room(); zoomAt(r.w / 2, r.h / 2, 1); }
        else if (act === 'hit-next') stepHit(1);
        else if (act === 'hit-prev') stepHit(-1);
        else if (act === 'back') showChats();
        else if (act === 'back-moment') { const g = state.ghostById.get(state.selected); if (g) showInfo(g.of); else showChats(); }
        // beside the map a moment's close steps back to the chats and the chats' close hides the panel; over it, either hides it
        else if (act === 'close-info') { const wasChats = state.panel === 'chats'; showChats(); if (wasChats || !root.classList.contains('is-docked')) setPanelOpen(false); }
        else if (act === 'panel') { if (state.panelOpen) setPanelOpen(false); else { showChats(); setPanelOpen(true); } }
        else if (act === 'style') setStylePop(pop.hidden);
        else if (act === 'style-close') setStylePop(false);
        // the empty Your Own starts as a copy of the style on show, which the controls below then edit
        else if (act === 'style-own') saveOwn({});
        else if (act === 'style-export') exportStyle();
        else if (act === 'style-import') importInput.click();
        else if (act === 'branch' && seg) void branchFrom(seg);
        // the server folds, so a flag the reader turns is a read of the tree as it asks
        else if (act === 'roads' || act === 'collapse') {
            if (act === 'roads') ctx.settings.set('showRoads', !roads());
            else ctx.settings.set('collapseRuns', !collapse());
            syncToggles();
            showChats();
            void load({ intro: true });
        }
    });
    search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { void runSearch(); }, SEARCH_MS);
    });

    // wide enough, the panel sits beside the map; narrower, it is a card over the map's foot
    const docked = () => !compact && !phone() && (host.clientWidth || 0) >= 760;
    const syncDock = () => root.classList.toggle('is-docked', docked());
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => syncDock()).observe(host);
    syncDock();
    restyle();
    syncToggles();
    showChats();

    return {
        /**
         * Point the view at a character and chat; only another character, an unheld chat or a rested view reads.
         */
        show({ character, chatId }) {
            const charId = character?.id || null;
            const moved = charId !== state.charId;
            state.charName = character?.name || '';
            state.character = character || null;
            state.currentChatId = chatId || null;
            if (chatId) state.focusChatId = chatId;
            if (moved) {
                state.charId = charId;
                state.answer = null; state.chats = []; state.chatById = new Map();
                state.selected = null; state.pick = null; state.activeHit = null;
                state.searchHits = null; state.searchGen++; state.hitList = []; state.hitAt = -1;
                if (!chatId) state.focusChatId = null;
                search.value = '';
                showChats();
            }
            later(syncDock);
            if (!moved && state.answer && !state.stale && (!chatId || state.chatById.has(chatId))) {
                rebuild();
                draw();
                refreshPanel();
                return Promise.resolve();
            }
            return load({ keepView: !moved && !!state.answer });
        },
        /** The character on show was written (its name, its portrait): repainted, nothing read. */
        setCharacter(character) {
            if (!character || character.id !== state.charId) return;
            state.character = character;
            state.charName = character.name || '';
            state.labels = chatLabels(state.chats, state.charName);
            if (state.answer) { draw(); refreshPanel(); }
        },
        /** Whether the tree on show holds this chat. */
        holds: (chatId) => !!chatId && state.chatById.has(chatId),
        charId: () => state.charId,
        reloadSoon,
        restyle,
        /** One step back from what is open (the style editor, a search, a moment, the card): false when nothing was. */
        stepBack() {
            if (!pop.hidden) { setStylePop(false); return true; }
            if (search.value) { search.value = ''; void runSearch({ jump: false }); return true; }
            if (state.panel === 'roads') { const g = state.ghostById.get(state.selected); if (g) showInfo(g.of); else showChats(); return true; }
            if (state.panel === 'moment') { showChats(); return true; }
            if (state.panelOpen && !root.classList.contains('is-docked')) { setPanelOpen(false); return true; }
            return false;
        },
        /** Closed: nothing waits to run, and the next show reads, since nothing was followed meanwhile. */
        rest() {
            clearTimeout(soonTimer);
            clearTimeout(searchTimer);
            state.loadGen++;
            state.stale = true;
            setStylePop(false);
        },
    };
}
