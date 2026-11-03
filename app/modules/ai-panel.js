// What the two review panels and the chat share: the review helpers, saved prompts, a turn's pictures, the live paint and the scroll pin

import CoreAPI from './core-api.js';
import { seesPictures } from './connection-editor.js';
import { wireCwinInputGrow, selectFieldHtml } from './chats/window.js';
import { registerFeedPatcher } from './feed.js';

const esc = (s) => CoreAPI.escapeHtml(s);

// A proposal id is only unique WITHIN its message (the parser restarts at lore:0 every
// reply), so everything per-card is keyed by seq + id.
export const propKey = (seq, id) => `${seq}:${id}`;

/** Drop the fenced proposal blocks (rendered as cards) from the prose by line walk; an unclosed block runs to the end. */
export function stripBlocks(text, fences = ['cl-lore-edits', 'cl-chat-edits', 'cl-card-edits', 'cl-read']) {
    const out = [];
    let inBlock = false;
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const fence = line.match(/^[ \t]*(?:```|~~~)([A-Za-z0-9-]*)[ \t]*$/);
        if (fence) {
            if (!inBlock && fences.includes(fence[1])) { inBlock = true; continue; }
            if (inBlock) { inBlock = false; continue; }
        }
        if (!inBlock) out.push(line);
    }
    return out.join('\n').trim();
}

/** Side-by-side diff for a review card: lines find hunks, each hunk is one word diff of removed vs added lines. */
export function diffSideBySideHtml(before, after) {
    // an empty side has no lines, not one empty line (which would pair with a blank line as context)
    const lines = (s) => { const t = String(s ?? ''); return t ? t.split('\n') : []; };
    const rows = CoreAPI.computeLineDiff(lines(before), lines(after));
    const groups = [];
    for (const r of rows) {
        const last = groups[groups.length - 1];
        if (r.type === 'context') groups.push({ ctx: r.line });
        else if (last && !('ctx' in last)) (r.type === 'removed' ? last.old : last.new).push(r.line);
        else groups.push({ old: r.type === 'removed' ? [r.line] : [], new: r.type === 'added' ? [r.line] : [] });
    }
    const hunkAt = (i) => i >= 0 && i < groups.length && !('ctx' in groups[i]);
    if (!groups.some((g, i) => hunkAt(i))) return '';
    // one side of a hunk, its tokens back into lines; a run of marked tokens is one span
    const linesOf = (tokens, mark, word) => {
        const lines = [[]];
        for (const t of tokens) {
            if (!t.text.includes('\n')) { lines[lines.length - 1].push(t); continue; }
            t.text.split('\n').forEach((part, k) => {
                if (k) lines.push([]);
                if (part) lines[lines.length - 1].push({ type: t.type, text: part });
            });
        }
        return lines.map(l => {
            const runs = [];
            for (const t of l) {
                const on = t.type === mark;
                if (runs.length && runs[runs.length - 1].on === on) runs[runs.length - 1].text += t.text;
                else runs.push({ on, text: t.text });
            }
            return { marked: runs.some(r => r.on), html: runs.map(r => r.on ? `<span class="${word}">${esc(r.text)}</span>` : esc(r.text)).join('') };
        });
    };
    const cell = (l, cls) => l ? `<div class="cas-diff-cell ${l.marked ? cls : 'is-ctx'}">${l.html}</div>` : '<div class="cas-diff-cell is-empty"></div>';
    const gap = '<div class="cas-diff-gap">…</div><div class="cas-diff-gap">…</div>';
    const out = [];
    let elided = false;
    groups.forEach((g, i) => {
        if ('ctx' in g) {
            if (!hunkAt(i - 1) && !hunkAt(i + 1)) { elided = true; return; }
            if (elided) { out.push(gap); elided = false; }
            out.push(`<div class="cas-diff-cell is-ctx">${esc(g.ctx)}</div><div class="cas-diff-cell is-ctx">${esc(g.ctx)}</div>`);
            return;
        }
        const d = CoreAPI.computeWordDiff(g.old.join('\n'), g.new.join('\n'));
        const left = g.old.length ? linesOf(d.old, 'removed', 'cas-diff-word-del') : [];
        const right = g.new.length ? linesOf(d.new, 'added', 'cas-diff-word-add') : [];
        for (let k = 0; k < Math.max(left.length, right.length); k++) out.push(cell(left[k], 'is-del') + cell(right[k], 'is-add'));
    });
    if (elided) out.push(gap);
    return `<div class="cas-diff cas-diff-split">
        <div class="cas-diff-col-head is-del">Now</div><div class="cas-diff-col-head is-add">Proposed</div>
        ${out.join('')}
    </div>`;
}

// ========================================
// THE LIVE PAINT
// ========================================

// the main thread's share a streaming paint may take: producer + gate + layout grow with the partial, so a costly one waits longer
const LIVE_PAINT_SHARE = 0.25;

/**
 * A streaming reply's painter: one paint a frame at most, spaced by its cost, none while `held()`; a later mark or flush lands it.
 * @param {{ paint: Function, held?: () => boolean, behind?: () => boolean }} opts `behind`: the paint left arrived text unshown
 * @returns {{ mark: Function, flush: Function, paintNow: Function, stop: Function, dirty: () => boolean }}
 */
export function createLivePainter({ paint, held = () => false, behind = () => false }) {
    let timer = 0;
    let raf = 0;
    let paintedAt = 0;
    let cost = 0;
    let dirty = false;
    let stopped = false;
    const run = () => {
        raf = 0;
        if (stopped) return;
        // a frame asked before the hold paints nothing out of sight; the flush at the return paints what waits
        if (held()) return;
        dirty = false;
        paintedAt = performance.now();
        paint();
        // the layout the paint left is forced here so its cost counts; the frame would run it anyway
        void document.documentElement.offsetHeight;
        cost = performance.now() - paintedAt;
        // a paced reveal with text still to show asks the next frame, spaced like any other paint
        if (behind()) mark();
    };
    const mark = () => {
        if (stopped) return;
        dirty = true;
        if (held() || timer || raf) return;
        const wait = cost / LIVE_PAINT_SHARE - (performance.now() - paintedAt);
        if (wait <= 0) { raf = requestAnimationFrame(run); return; }
        timer = setTimeout(() => {
            timer = 0;
            raf = requestAnimationFrame(run);
        }, wait);
    };
    return {
        mark,
        flush: () => { if (dirty) mark(); },
        // a placeholder drawn afresh shows what arrived in this frame, never one empty frame first
        paintNow: () => {
            if (stopped || held()) return;
            clearTimeout(timer);
            timer = 0;
            cancelAnimationFrame(raf);
            run();
        },
        stop: () => {
            stopped = true;
            dirty = false;
            clearTimeout(timer);
            timer = 0;
            cancelAnimationFrame(raf);
            raf = 0;
        },
        dirty: () => dirty,
    };
}

// a paced reveal trails what arrived by this at most, and shows what is left within END once the stream ends
const LIVE_REVEAL_LAG_MS = 1000;
const LIVE_REVEAL_END_MS = 300;
// how long a gap between arrivals keeps weighing on when the next is expected
const LIVE_REVEAL_MEMORY_MS = 2000;
// a cut ends on the word it falls in, unless that word runs longer than this (CJK, a link)
const LIVE_REVEAL_WORD = 24;

/**
 * What a streaming partial shows of what arrived. Paced, each arrival is spread across the gap the next one is expected in.
 * @param {{ paced?: () => boolean }} opts off, or under reduced motion, everything arrived shows at once
 * @returns {{ arrive: Function, seed: Function, cut: (text: string) => (string|null), behind: () => boolean, all: Function, finish: () => number, reset: Function, forget: Function }}
 */
export function createLiveReveal({ paced = () => false } = {}) {
    let received = 0;
    let cutAt = 0;
    // the reveal runs from `from` at fromAt to everything received by until
    let from = 0;
    let fromAt = 0;
    let until = 0;
    // the gaps between arrivals, decayed by time; sq / sum weighs each gap by its own length, so a burst's own few ms barely count
    let lastAt = null;
    let sq = 0;
    let sum = 0;
    // [time, length] of each arrival inside the lag bound, plus the newest one past it (the floor)
    let marks = [];
    // the reader's reduced-motion preference, read live as every scripted scroll reads it
    const on = () => paced() && CoreAPI.scrollBehavior() !== 'auto';
    const floor = (t) => {
        let f = 0;
        for (const [at, len] of marks) { if (at > t - LIVE_REVEAL_LAG_MS) break; f = len; }
        return f;
    };
    const position = (t) => {
        if (!on() || until <= fromAt) return received;
        return Math.max(from + (received - from) * Math.min(1, Math.max(0, (t - fromAt) / (until - fromAt))), floor(t));
    };
    return {
        /** The partial grew to `len`: everything received is due by when the next arrival is expected. */
        arrive(len) {
            if (len <= received) return;
            const t = performance.now();
            const gap = lastAt === null ? 0 : t - lastAt;
            lastAt = t;
            if (gap > 0) {
                const keep = Math.exp(-gap / LIVE_REVEAL_MEMORY_MS);
                sq = sq * keep + gap * gap;
                sum = sum * keep + gap;
            }
            from = Math.max(position(t), cutAt);
            fromAt = t;
            // no gap seen yet, nothing to pace by: the first burst of a fresh connection lands whole
            until = t + Math.min(LIVE_REVEAL_LAG_MS, sum > 0 ? sq / sum : 0);
            received = len;
            marks.push([t, len]);
            let past = 0;
            while (past + 1 < marks.length && marks[past + 1][0] <= t - LIVE_REVEAL_LAG_MS) past++;
            if (past) marks.splice(0, past);
        },
        /** The partial starts as `len` already shown (a continue extends what is there). */
        seed(len) {
            received = from = len;
            fromAt = until = performance.now();
        },
        /** The text to show now, ending on a word; null when it shows nothing more than the last cut did. */
        cut(text) {
            let n = Math.ceil(position(performance.now()));
            if (n < text.length) {
                const space = text.slice(n, n + LIVE_REVEAL_WORD).search(/\s/);
                if (space !== -1) n += space;
                // never half a surrogate pair
                else if (n > 0 && text.charCodeAt(n - 1) >= 0xD800 && text.charCodeAt(n - 1) <= 0xDBFF) n++;
            }
            n = Math.min(text.length, n);
            if (n <= cutAt) return null;
            cutAt = n;
            return n >= text.length ? text : text.slice(0, n);
        },
        behind: () => cutAt < received,
        /** Everything received shows at the next cut; later arrivals pace from there. */
        all() {
            from = received;
            fromAt = until = performance.now();
        },
        /** The stream ended: what is left shows within the catch-up. Answers the ms until it has, 0 when nothing is left. */
        finish() {
            if (!on() || cutAt >= received) return 0;
            const t = performance.now();
            from = Math.max(position(t), cutAt);
            fromAt = t;
            until = t + Math.min(LIVE_REVEAL_END_MS, Math.max(0, until - t));
            return until - t;
        },
        /** A new partial; the gaps learnt stay, since the next reply comes from the same connection. */
        reset() {
            received = cutAt = from = fromAt = until = 0;
            lastAt = null;
            marks = [];
        },
        forget() {
            sq = sum = 0;
        },
    };
}

// what repaintLive last wrote into an element: its markup, each top-level block's, and the nodes themselves
const liveWrites = new WeakMap();
const markOf = (n) => (n.nodeType === 1 ? n.outerHTML : n.textContent);

// a node the stream is still writing is updated in place, so a box under a finger is never swapped mid-drag
function morphLive(from, to) {
    if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) { from.replaceWith(to); return; }
    if (from.nodeType !== 1) {
        // text that only grew is appended, so a selection ending inside it keeps its end
        if (from.nodeValue === to.nodeValue) return;
        if (to.nodeValue.startsWith(from.nodeValue)) from.appendData(to.nodeValue.slice(from.nodeValue.length));
        else from.nodeValue = to.nodeValue;
        return;
    }
    // open is the reader's: the gate strips it from every write
    for (const { name } of Array.from(from.attributes)) if (name !== 'open' && !to.hasAttribute(name)) from.removeAttribute(name);
    for (const { name, value } of Array.from(to.attributes)) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
    const now = Array.from(from.childNodes);
    const next = Array.from(to.childNodes);
    next.forEach((n, i) => { if (i < now.length) morphLive(now[i], n); else from.appendChild(n); });
    for (const n of now.slice(next.length)) n.remove();
}

/**
 * Repaint a reply formatted as it streams from its first changed block, in place, keeping the reader's disclosures, selection and scroll.
 * @param {Element} el
 * @param {string} html the sanitized markup
 */
export function repaintLive(el, html) {
    const was = liveWrites.get(el);
    const ours = !!was && was.nodes.length === el.childNodes.length && was.nodes.every((n, i) => n === el.childNodes[i]);
    if (ours && was.html === html) return;
    let keep = 0;
    let from = 0;
    if (ours && was.exact) {
        // the last write was its blocks end to end, so whole blocks in the common prefix stand without a parse
        const n = Math.min(was.html.length, html.length);
        let same = 0;
        while (same < n && was.html.charCodeAt(same) === html.charCodeAt(same)) same++;
        while (keep < was.marks.length && from + was.marks[keep].length <= same) from += was.marks[keep++].length;
    }
    const tpl = document.createElement('template');
    tpl.innerHTML = html.slice(from);
    let added = Array.from(tpl.content.childNodes);
    const marks = [...(ours ? was.marks.slice(0, keep) : []), ...added.map(markOf)];
    if (ours && !was.exact) {
        while (keep < was.marks.length && keep < marks.length && was.marks[keep] === marks[keep]) keep++;
        added = added.slice(keep);
    }
    const tail = Array.from(el.childNodes).slice(keep);
    added.forEach((n, i) => { if (i < tail.length) morphLive(tail[i], n); else el.appendChild(n); });
    for (const n of tail.slice(added.length)) n.remove();
    liveWrites.set(el, { html, marks, exact: marks.join('') === html, nodes: Array.from(el.childNodes) });
}

/**
 * Paint a panel's streaming reply, formatted as it streams when the surface's setting says so.
 * @param {Element} el
 * @param {'assistant'|'creator'} surface
 * @param {(opts: object) => string} render the reply's sanitized markup for formatChatText's opts
 */
export function paintPanelReply(el, surface, render) {
    // markup is talked about in a panel rather than drawn, so an unclosed tag stays text until it closes
    if (CoreAPI.liveFormattingOn(surface)) repaintLive(el, render({ streaming: 'live', openIslands: false }));
    else el.innerHTML = render({});
}

// what a reader can focus in a reply, and what scrolls in one: a code box, a wide table, a board's own scroll box
const READER_FOCUS = 'summary, a[href]';
const READER_SCROLL = 'pre, table, .cl-table-scroll, [style*="overflow"]';

// a point in a reply as its offset into the reply's text, so it survives a rewrite of the same text
function textOffset(root, node, offset) {
    if (!node || !root.contains(node)) return -1;
    // a range from the reply's start reads an element's boundary too (a triple click ends at the next paragraph's start)
    const range = document.createRange();
    range.setStart(root, 0);
    range.setEnd(node, offset);
    return range.toString().length;
}

// forward, an offset at a text node's end is the next node's start: a selection opening a paragraph stays inside it
function textPoint(root, at, forward) {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let last = null;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (at < n.nodeValue.length || (at === n.nodeValue.length && !forward)) return [n, at];
        at -= n.nodeValue.length;
        last = n;
    }
    return last && at === 0 ? [last, last.nodeValue.length] : null;
}

/** What the reader did to a live reply (disclosures opened, boxes scrolled, the focus, a selection), for restoreReaderState. */
export function readerState(el) {
    if (!el) return null;
    const focusable = Array.from(el.querySelectorAll(READER_FOCUS));
    const sel = document.getSelection?.();
    let selection = null;
    if (sel?.rangeCount && !sel.isCollapsed) {
        const anchor = textOffset(el, sel.anchorNode, sel.anchorOffset);
        const focus = textOffset(el, sel.focusNode, sel.focusOffset);
        if (anchor >= 0 && focus >= 0) selection = { text: el.textContent, anchor, focus };
    }
    return {
        open: Array.from(el.querySelectorAll('details'), d => d.open),
        scroll: Array.from(el.querySelectorAll(READER_SCROLL), b => [b.scrollLeft, b.scrollTop]),
        focus: focusable.indexOf(document.activeElement),
        focusable: focusable.length,
        selection,
    };
}

/**
 * Close a panel's streaming reply: its pending tail painted, what the reader did read off it, its placeholder gone.
 * @param {string} rowId the placeholder's id
 * @param {{ paintNow: Function }|null} painter the reply's painter, null when it did not paint as it arrived
 * @returns {object|null} readerState's answer, for carryPanelReply
 */
export function closePanelStream(rowId, painter) {
    // the last tokens land before what the reader did is read, or the carry compares a reply short of its tail
    painter?.paintNow();
    const reader = readerState(document.querySelector(`#${rowId} .cas-msg-body`));
    document.getElementById(rowId)?.remove();
    return reader;
}

/**
 * Carry what the reader did onto a panel's settled reply; a view with no settled reply (settings, context) is left alone.
 * @param {string} hostId the panel body's id
 * @param {number} seq the settled reply's seq
 * @param {object|null} state readerState's answer
 */
export function carryPanelReply(hostId, seq, state) {
    const host = document.getElementById(hostId);
    const settled = host?.querySelector(`.cas-msg[data-seq="${seq}"] .cas-msg-body`);
    if (!settled) return;
    restoreReaderState(settled, state);
    // followed again as render followed it, the place given back: a reopened disclosure gave room to a place render could not reach
    const pin = scrollPin(hostId);
    pin.follow(pin.place());
}

// a stored turn's stamp names it alone: a delete renumbers the seqs after it, and words repeat
const TRANSCRIPT_ROW = '.cas-msg[data-at]';

/**
 * A transcript redrawn by `draw`, each older reply keeping what the reader opened in it: its Reasoning, its disclosures, their boxes' scroll.
 * @param {HTMLElement} body the panel body
 * @param {Function} draw the redraw
 */
export function redrawTranscript(body, draw) {
    const kept = new Map();
    for (const row of body.querySelectorAll(TRANSCRIPT_ROW)) {
        const think = row.querySelector('.cas-think');
        const text = row.querySelector('.cas-msg-body');
        const touched = !!text && (Array.from(text.querySelectorAll('details')).some(d => d.open)
            || Array.from(text.querySelectorAll(READER_SCROLL)).some(b => b.scrollLeft || b.scrollTop));
        if (!think?.open && !touched) continue;
        kept.set(row.getAttribute('data-at'), {
            think: think?.open ? (row.querySelector('.cas-think-body')?.scrollTop || 0) : null,
            state: touched ? readerState(text) : null,
        });
    }
    draw();
    if (!kept.size) return;
    const found = Array.from(body.querySelectorAll(TRANSCRIPT_ROW), row => [row, kept.get(row.getAttribute('data-at'))]).filter(([, k]) => k);
    // every box opened before any scroll is written, so layout settles once rather than once a reply
    for (const [row, k] of found) {
        const think = row.querySelector('.cas-think');
        if (think && k.think !== null) think.open = true;
        const text = row.querySelector('.cas-msg-body');
        if (text && k.state) openAsRead(text, k.state);
    }
    for (const [row, k] of found) {
        const box = row.querySelector('.cas-think-body');
        if (box && k.think) box.scrollTop = k.think;
        if (k.state) restoreReaderState(row.querySelector('.cas-msg-body'), k.state);
    }
}

// a reply's disclosures as the reader left them, written only where they differ
function openAsRead(el, state) {
    const details = el.querySelectorAll('details');
    if (details.length === state.open.length) details.forEach((d, i) => { if (d.open !== state.open[i]) d.open = state.open[i]; });
}

/** The settled message given the live reply's reader state by position, each part only where both hold as many. */
export function restoreReaderState(el, state) {
    if (!el || !state) return;
    // opened first: a box inside a shut disclosure has no layout to scroll
    openAsRead(el, state);
    const boxes = el.querySelectorAll(READER_SCROLL);
    if (boxes.length === state.scroll.length) {
        boxes.forEach((b, i) => {
            const [left, top] = state.scroll[i];
            if (left) b.scrollLeft = left;
            if (top) b.scrollTop = top;
        });
    }
    const focusable = el.querySelectorAll(READER_FOCUS);
    if (state.focus >= 0 && focusable.length === state.focusable) focusable[state.focus].focus({ preventScroll: true });
    // a selection rides only onto the same text, where its offsets still name the same words
    const s = state.selection;
    if (s && el.textContent === s.text) {
        const anchor = textPoint(el, s.anchor, s.anchor <= s.focus);
        const focus = textPoint(el, s.focus, s.focus < s.anchor);
        if (anchor && focus) document.getSelection()?.setBaseAndExtent(anchor[0], anchor[1], focus[0], focus[1]);
    }
}

// ========================================
// THE SCROLL PIN
// ========================================

// within 48px of the end is at it, a finger 8px toward older text is leaving, a fling settles in 150ms
const SCROLL_PIN_EPSILON = 48;
const SCROLL_TOUCH_INTENT_PX = 8;
const SCROLL_TOUCH_SETTLE_MS = 150;
// the very end, with room for a zoomed page's fractional scroll
const SCROLL_PIN_END_PX = 3;
const scrollPins = new Map();

/**
 * A transcript's pin to its end, for the chat and both panels: a scroll toward older text lets go, the end takes it back.
 * @param {string} hostId the scrolling body's id
 * @param {{ rows?: string }} [opts] rows: the transcript's rows; a view without them (Settings, Context) keeps its own scroll
 * @returns {{ follow: (kept?: number) => void, pin: () => void, keep: () => void, land: (top: number) => void, put: (top: number) => void, leave: () => (undone?: boolean) => void, reset: () => void, watch: (fn: (pinned: boolean) => void) => void, pinned: () => boolean, place: () => number }}
 */
export function scrollPin(hostId, { rows = '.cas-msg' } = {}) {
    if (scrollPins.has(hostId)) return scrollPins.get(hostId);
    let pinned = true;
    let watcher = null;
    let hold = false;
    let holdAtEnd = false;
    // where the held body was when the finger last said where it is; a move within the intent band says nothing
    let holdMark = 0;
    // the finger let go during this hold: only the very end takes it back, unless the finger is heading back toward newer text
    let leftInHold = false;
    let headingNewer = false;
    // the reader left without a scroll (an editor open): layout never takes the pin back until the leave is answered
    let leaving = false;
    // places the reader chose or was given since: a move of the body soon after they worked it, and the app's landings
    let placed = 0;
    // when the reader last worked the body (a wheel, a touch, a press, a key outside a field); a typed caret's scroll is none
    let worked = -Infinity;
    // a press held on the body (its scrollbar dragged): every move until its release is the reader's
    let pressing = false;
    let last = 0;
    // a place the body could not reach when given back (a re-read without the kept turn yet): the reader's, for the next redraw
    let want = null;
    // the body's size at its last scroll or write, so a move that layout made (a removed row, a turned phone) is told apart
    let seenHeight = 0;
    let seenClient = 0;
    let settle = 0;
    let bound = null;
    // the fingers on the body by identifier (where each is, last moved toward newer, went down across) and the elements they went down on
    const fingers = new Map();
    const watched = [];
    const fromEnd = (el) => el.scrollHeight - el.scrollTop - el.clientHeight;
    const setPinned = (on) => {
        if (pinned === on) return;
        pinned = on;
        watcher?.(on);
    };
    // its own writes move the place a scroll is read against, and the size, before their scroll event arrives
    const place = (el, top, kept = false) => {
        el.scrollTop = top;
        last = el.scrollTop;
        seenHeight = el.scrollHeight;
        seenClient = el.clientHeight;
        want = kept && last < top - SCROLL_PIN_END_PX ? top : null;
        // under a finger its own write is no move of the finger's
        if (hold) holdMark = last;
    };
    // a body that barely scrolls has nothing above to read: letting go there strands the next reply below the fold
    const letGo = () => {
        if (!bound || bound.scrollHeight - bound.clientHeight <= SCROLL_PIN_EPSILON) return;
        holdAtEnd = false;
        setPinned(false);
        if (hold) leftInHold = true;
    };
    // let go at the end, it follows again; the reply grew under the still finger, so the end its scroll reached counts
    const release = () => {
        hold = false;
        // a view that is not the transcript (Settings, Context) keeps its own scroll
        const el = bound.querySelector(rows) ? bound : null;
        if (holdAtEnd) {
            setPinned(true);
            if (el) place(el, el.scrollHeight);
        } else if (want !== null && el) place(el, want, true);
    };
    const settleSoon = () => {
        clearTimeout(settle);
        settle = setTimeout(release, SCROLL_TOUCH_SETTLE_MS);
    };
    const onScroll = () => {
        const prev = last;
        last = bound.scrollTop;
        const layout = bound.scrollHeight < seenHeight || bound.clientHeight !== seenClient;
        seenHeight = bound.scrollHeight;
        seenClient = bound.clientHeight;
        // a move layout made (a removed row, a turned phone) is no reader's: one clamped onto the very end, no place held, is at it
        if (layout) {
            if (!hold && want === null && !leaving && fromEnd(bound) <= SCROLL_PIN_END_PX) setPinned(true);
            return;
        }
        // the body itself moved by the reader's hand: a wheel or a drag inside an edit box moves only the box
        if (last !== prev && (pressing || Date.now() - worked < SCROLL_TOUCH_SETTLE_MS)) placed++;
        // off the body's own end, the reader is where they chose: a place held for a redraw is dropped
        if (want !== null && fromEnd(bound) > SCROLL_PIN_END_PX) want = null;
        if (hold) {
            // a fling after the lift keeps the hold until it goes quiet
            if (!fingers.size) settleSoon();
            // heading back toward newer text the band is the end, as the reply grows past the push; heading away, only the very end
            const atEnd = fromEnd(bound) <= (leftInHold && !headingNewer ? SCROLL_PIN_END_PX : SCROLL_PIN_EPSILON);
            const step = bound.scrollTop - holdMark;
            // a jitter says nothing, but a step that reaches the end counts however small (the pin's own writes moved the mark)
            if (Math.abs(step) <= SCROLL_TOUCH_INTENT_PX && !(atEnd && step > 0)) return;
            holdMark = bound.scrollTop;
            // a finger that moved is where it moved to: at the end, or short of it (dragged on past a clamped end)
            holdAtEnd = atEnd;
            // reaching the end takes the pin back at once, though its writes wait for the lift (a pill blinked as each line arrived)
            if (atEnd && step > 0) setPinned(true);
            else if (!atEnd && step < 0) letGo();
            return;
        }
        // any move toward older text lets go; nearness re-pins only on a move toward the end (an arrow's last 1px frame read as none)
        if (bound.scrollTop < prev - 0.5) letGo();
        else if (bound.scrollTop > prev && fromEnd(bound) <= SCROLL_PIN_EPSILON) setPinned(true);
    };
    // dragging the finger down scrolls toward older text, the leaving gesture, measured from where it last moved toward newer
    const move = (e) => {
        for (const t of e.touches || []) {
            const f = fingers.get(t.identifier);
            if (!f) continue;
            // back at the end after the touch slop the finger is still below where it went down: a move toward newer carries the mark
            if (t.clientY < f.at) { f.mark = t.clientY; headingNewer = true; } else if (t.clientY > f.at) headingNewer = false;
            f.at = t.clientY;
            // a drag mostly sideways (a wide code box scrolled) is no leaving, whatever it drifts down
            worked = Date.now();
            const older = t.clientY - f.mark;
            if (older > SCROLL_TOUCH_INTENT_PX && older > Math.abs((t.clientX || 0) - f.x)) letGo();
        }
    };
    const unwatch = () => {
        for (const el of watched.splice(0)) for (const [type, fn] of Object.entries(touch)) el.removeEventListener(type, fn);
    };
    const lift = (e) => {
        for (const t of e.changedTouches || []) fingers.delete(t.identifier);
        if (fingers.size) return;
        unwatch();
        settleSoon();
    };
    const touch = { touchmove: move, touchend: lift, touchcancel: lift };
    // a touch's events go to the element it went down on, which a paint can take out of the body: heard there too
    const watch = (el) => {
        if (!el?.addEventListener || el === bound || watched.includes(el)) return;
        for (const [type, fn] of Object.entries(touch)) el.addEventListener(type, fn, { passive: true });
        watched.push(el);
    };
    const down = (e) => {
        // a finger the browser stopped reporting lifted where nothing heard it
        const live = new Set([...(e.touches || [])].map(t => t.identifier));
        for (const id of [...fingers.keys()]) if (!live.has(id)) fingers.delete(id);
        for (const t of e.changedTouches || []) {
            fingers.set(t.identifier, { at: t.clientY, mark: t.clientY, x: t.clientX || 0 });
            watch(t.target);
        }
        if (!hold) {
            // only a follower is held at the end: a tap near it never pulls back one who left, nor one short of a held place
            holdAtEnd = pinned && want === null && fromEnd(bound) <= SCROLL_PIN_EPSILON;
            holdMark = bound.scrollTop;
            leftInHold = headingNewer = false;
        }
        hold = true;
        clearTimeout(settle);
    };
    // the body outlives its renders, so it is heard once
    const bind = () => {
        const el = document.getElementById(hostId);
        if (!el || el === bound) return el;
        bound = el;
        last = el.scrollTop;
        seenHeight = el.scrollHeight;
        seenClient = el.clientHeight;
        el.addEventListener('scroll', onScroll, { passive: true });
        // a tick up lets go before its scroll lands; a sideways swipe's slight drift (a wide code box) is no leaving
        el.addEventListener('wheel', (e) => {
            worked = Date.now();
            if (e.deltaY < 0 && -e.deltaY > Math.abs(e.deltaX || 0)) letGo();
        }, { passive: true });
        el.addEventListener('pointerdown', () => { worked = Date.now(); pressing = true; }, { passive: true });
        el.addEventListener('touchstart', down, { passive: true });
        for (const [type, fn] of Object.entries(touch)) el.addEventListener(type, fn, { passive: true });
        // a pinned body keeps its end through a resize of its own (the phone's keyboard, a growing composer, a turned phone)
        new ResizeObserver(() => { if (el === bound && pinned && !hold && el.querySelector(rows)) place(el, el.scrollHeight); }).observe(el);
        return el;
    };
    const pin = {
        /** A paint or a redraw: a pinned reader stays at the end, one who left keeps `kept`, the place read before a redraw. */
        follow(kept) {
            const el = bind();
            if (!el?.querySelector(rows)) return;
            // under a finger the end waits for the lift; the place a redraw displaced is given back at once, being layout
            if (pinned && !hold) place(el, el.scrollHeight);
            else if (Number.isFinite(kept)) place(el, kept, true);
        },
        /** The reader's own send, a transcript opened, the jump to the latest: back to the end, following again. */
        pin() {
            const el = bind();
            leaving = false;
            setPinned(true);
            // a finger still down catches up on its lift; a fling settling after one is ended by the jump
            if (hold && fingers.size) { holdAtEnd = true; return; }
            hold = false;
            clearTimeout(settle);
            if (el?.querySelector(rows)) place(el, el.scrollHeight);
        },
        /** Before the live row is taken out: a reader away keeps their place until a redraw can reach it again. */
        keep() {
            if (!pinned && want === null) want = last;
        },
        /** The app placing the reader away from the end (a reply opened at its top): written unless a finger holds the body. */
        land(top) {
            const el = bind();
            holdAtEnd = false;
            setPinned(false);
            placed++;
            // a finger still down keeps the body where held; the settle after a lift (the tap that asked for it) is ended
            if (hold && fingers.size) return;
            hold = false;
            clearTimeout(settle);
            if (el) place(el, top);
        },
        /** A write that leaves the pin as it is (a row swapped in place, held where it stood). */
        put(top) {
            const el = bind();
            if (el) place(el, top);
        },
        /** The reader's own leaving without a scroll (an editor opened); its answer re-pins a follower near the end, or, undone, one given no place since. */
        leave() {
            const el = bind();
            const was = pinned;
            const since = placed;
            letGo();
            leaving = true;
            return (undone = false) => {
                leaving = false;
                if (!was || pinned || !el || el !== bound || want !== null) return;
                if ((undone && placed === since) || fromEnd(el) <= SCROLL_PIN_EPSILON) pin.pin();
            };
        },
        /** A transcript opened or closed: no finger, nothing held, following. */
        reset() {
            const el = bind();
            unwatch();
            fingers.clear();
            clearTimeout(settle);
            hold = holdAtEnd = leftInHold = headingNewer = leaving = false;
            want = null;
            if (el) {
                last = el.scrollTop;
                seenHeight = el.scrollHeight;
                seenClient = el.clientHeight;
            }
            setPinned(true);
        },
        /** Told each time the pin is taken or let go (a jump-to-latest control). */
        watch(fn) {
            watcher = fn;
        },
        pinned: () => pinned,
        /** Where the reader is, or the place held for a redraw to give back. */
        place: () => want ?? last,
    };
    // a key aimed at the page still scrolls the body, and a held press ends wherever the pointer is let go
    document.addEventListener('keydown', (e) => { if (!e.target?.closest?.('textarea, input, select, [contenteditable]')) worked = Date.now(); }, { passive: true });
    document.addEventListener('pointerup', () => { if (pressing) { pressing = false; worked = Date.now(); } }, { passive: true });
    document.addEventListener('pointercancel', () => { pressing = false; }, { passive: true });
    scrollPins.set(hostId, pin);
    return pin;
}

// ========================================
// SAVED PROMPTS
// ========================================

// A saved prompt is {id, icon, label, text}; a chip fills the composer, never sends (review before send).

export const PROMPT_ICON_FALLBACK = '🔖';


function coercePrompt(p) {
    return {
        id: typeof p?.id === 'string' && p.id ? p.id : CoreAPI.randomId(12),
        icon: String(p?.icon ?? '').slice(0, 4),
        label: String(p?.label ?? ''),
        text: String(p?.text ?? ''),
    };
}

/**
 * One panel's saved prompts on the store-document contract; mutations refused while the model is null.
 * @param {{key: string, version?: number, starters?: Array<{icon,label,text}>}} opts
 */
export function createPromptStore({ key, version = 1, starters = [] }) {
    // null until a definitive read, [] is a real empty list; a drop re-reads at once since mutators dont load first
    const doc = CoreAPI.createStoreDocument(key, {
        // a served doc decides the list even when empty; only a clean 404 (never created) lets starters fill
        coerce: (served) => (Array.isArray(served?.prompts)
            ? served.prompts.map(coercePrompt)
            : (served ? [] : starters.map(coercePrompt))),
        toDoc: (prompts) => ({ version, prompts }),
        unread: 'Your saved prompts could not be read; nothing was changed',
        saveFailed: 'Could not save your prompts',
    });
    const { load, unavailable, save } = doc;

    return {
        load,
        get: doc.get,
        loaded: doc.loaded,
        find: (id) => doc.get()?.find(x => x.id === id) || null,
        unavailable,
        add() {
            if (unavailable()) return false;
            doc.get().push({ id: CoreAPI.randomId(12), icon: '', label: '', text: '' });
            save();
            return true;
        },
        remove(id) {
            if (unavailable()) return false;
            const prompts = doc.get();
            const i = prompts.findIndex(p => p.id === id);
            if (i === -1) return false;
            prompts.splice(i, 1);
            save();
            return true;
        },
        move(id, delta) {
            if (unavailable()) return false;
            const prompts = doc.get();
            const i = prompts.findIndex(p => p.id === id);
            const j = i + delta;
            if (i === -1 || j < 0 || j >= prompts.length) return false;
            [prompts[i], prompts[j]] = [prompts[j], prompts[i]];
            save();
            return true;
        },
        setField(id, field, value) {
            const p = doc.get()?.find(x => x.id === id);
            if (!p || !(field in p) || field === 'id') return false;
            p[field] = field === 'icon' ? String(value).slice(0, 4) : String(value);
            save();
            return true;
        },
    };
}

/** The chips row: each fills the composer on click (the panel's delegated `use-prompt` action). */
export function promptChipsHtml(prompts) {
    if (!prompts?.length) return '';
    return prompts.map(p => `
        <button type="button" class="cas-qp-chip" data-cas-act="use-prompt" data-prompt-id="${esc(p.id)}"
            title="${esc(p.text.length > 160 ? `${p.text.slice(0, 160)}…` : p.text)}">
            <span class="cas-qp-icon">${esc(p.icon || PROMPT_ICON_FALLBACK)}</span>
            <span class="cas-qp-label">${esc(p.label || p.text.slice(0, 24) || 'Prompt')}</span>
        </button>`).join('');
}

/** The prompts editor. An unread list renders a failure with a retry: an empty editor's Add would overwrite the stored list. */
export function promptsEditorHtml(prompts, { hint }) {
    if (!prompts) {
        return `
        <div class="cl-cwin-block">
            <p class="cl-cwin-hint">Your saved prompts could not be read.</p>
            <div class="cas-set-actions">
                <button type="button" class="cas-set-btn" data-cas-act="retry-prompts">
                    <i class="fa-solid fa-rotate-right"></i> Try Again
                </button>
            </div>
        </div>`;
    }
    const rows = prompts.map((p, i) => `
        <div class="cas-qp-edit cl-cwin-fieldrow" data-prompt-id="${esc(p.id)}">
            <input type="search" class="cl-cwin-input cas-qp-icon-in" data-prompt-field="icon" value="${esc(p.icon)}"
                maxlength="4" aria-label="Icon" title="An emoji, or blank for the bookmark" placeholder="${PROMPT_ICON_FALLBACK}">
            <input type="search" class="cl-cwin-input cas-qp-label-in" data-prompt-field="label" value="${esc(p.label)}"
                aria-label="Label" title="The chip's label" placeholder="Label">
            <div class="cas-qp-edit-acts">
                <button type="button" class="cas-prop-act" data-cas-act="prompt-up" data-prompt-id="${esc(p.id)}"
                    title="Move up" aria-label="Move up"${i === 0 ? ' disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
                <button type="button" class="cas-prop-act" data-cas-act="prompt-down" data-prompt-id="${esc(p.id)}"
                    title="Move down" aria-label="Move down"${i === prompts.length - 1 ? ' disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>
                <button type="button" class="cas-prop-act is-danger" data-cas-act="prompt-delete" data-prompt-id="${esc(p.id)}"
                    title="Delete this prompt" aria-label="Delete this prompt"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <textarea class="cl-cwin-input cl-cwin-textarea cas-qp-text-in" data-prompt-field="text" rows="3"
                aria-label="Prompt text" placeholder="What to put in the box when this chip is clicked">\n${esc(p.text)}</textarea>
        </div>`).join('');
    return `
        <div class="cl-cwin-block">
            <div class="cas-qp-list">${rows || '<p class="cl-cwin-hint">Nothing saved yet.</p>'}</div>
            <div class="cas-set-actions">
                <button type="button" class="cas-set-btn" data-cas-act="prompt-add">
                    <i class="fa-solid fa-plus"></i> Add a Prompt
                </button>
            </div>
            <p class="cl-cwin-hint">${hint}</p>
        </div>`;
}

// ========================================
// SETTINGS FIELDS
// ========================================

/**
 * A settings dropdown in the chat-window form, for either panel's settings view.
 * @param {{ id: string, key: string, label: string, options: Array<[string, string]>, value: string, hint: string }} f
 */
export function settingSelectHtml({ id, key, label, options, value, hint }) {
    return `<div class="cl-cwin-block">${selectFieldHtml({ id, key, label, options, value })}<p class="cl-cwin-hint">${esc(hint)}</p></div>`;
}

// Format as it streams, as both panels offer it: an override of the chat's switch
export const LIVE_FORMATTING_FIELD = Object.freeze({
    label: 'Format as it streams',
    options: [['chat', 'Same as Chat'], ['on', 'On'], ['off', 'Off']],
    hint: 'An unfinished code block shows as a box while the reply arrives, not as text until it closes. Same as Chat follows the switch in Chat settings.',
});

// ========================================
// THE REVIEW SURFACE
// ========================================
//
// A proposal card, its act cluster, the block that holds a reply's cards and the surgical
// repaint: the chat assistant and the creator studio drew all of it twice, in two copies
// that had to be edited in lockstep.
// What differs between the panels is the CONTENT of a card (an entry's name and book, a
// field's label, the flags each engine can raise); the chrome, the vocabulary and the
// mechanics are one thing and live here.

/** Mark a reply that carried no proposals known-empty, so it offers the nudge rather than nothing. */
export function markKnownEmpty(proposals, seq, message) {
    if (message?.role !== 'assistant' || message.extra?.proposals?.length) return;
    proposals.set(seq, { proposals: [], errors: message.extra?.proposalErrors || [] });
}

/** The reviewer's per-card state, keyed by propKey; session-local, never written to the server. */
export function createReviewState() {
    const state = {
        openDiffs: new Set(),   // the full diff is disclosed
        rejected: new Set(),    // the reviewer set it aside
        openEdits: new Set(),   // the touch-up editor is open
        edits: new Map(),       // the reviewer's replacement text, sent as an apply override
        clear() {
            state.openDiffs.clear();
            state.rejected.clear();
            state.openEdits.clear();
            state.edits.clear();
        },
    };
    return state;
}

/**
 * The per-card verbs; a stale card keeps its diff toggle, a set-aside one offers only restore.
 * @param {{ id: string, status: string, rejected: boolean, hasDiff: boolean, showDiff: boolean, editable: boolean, editOpen: boolean, applyTitle?: string, extra?: string }} o
 */
export function reviewActsHtml({ id, status, rejected, hasDiff, showDiff, editable, editOpen, applyTitle = 'Apply this change now', extra = '' }) {
    const diffBtn = hasDiff && !rejected
        ? `<button type="button" class="cas-prop-act${showDiff ? ' is-on' : ''}" data-cas-act="toggle-diff" data-prop-id="${esc(id)}"
               title="${showDiff ? 'Hide the changes' : 'Show the changes side by side'}"><i class="fa-solid fa-code-compare"></i></button>`
        : '';
    // the panel's own verb rides in front on every branch; a caller decides when it exists
    if (status !== 'ready') return `${extra}${diffBtn}`;
    if (rejected) {
        return `${extra}<button type="button" class="cas-prop-act" data-cas-act="restore-one" data-prop-id="${esc(id)}"
                   title="Bring this change back"><i class="fa-solid fa-rotate-left"></i></button>`;
    }
    return `${extra}${diffBtn}${editable ? `<button type="button" class="cas-prop-act${editOpen ? ' is-on' : ''}" data-cas-act="edit-prop" data-prop-id="${esc(id)}"
                   title="Touch up the text before applying"><i class="fa-solid fa-pen"></i></button>` : ''}
               <button type="button" class="cas-prop-act is-good" data-cas-act="apply-one" data-prop-id="${esc(id)}"
                   title="${esc(applyTitle)}"><i class="fa-solid fa-check"></i></button>
               <button type="button" class="cas-prop-act is-danger" data-cas-act="reject-one" data-prop-id="${esc(id)}"
                   title="Set this change aside"><i class="fa-solid fa-xmark"></i></button>`;
}

/** The touch-up editor, open only on a live card. */
export function reviewEditBoxHtml({ id, open, rejected, value }) {
    if (!open || rejected) return '';
    return `
        <textarea class="cl-cwin-input cas-prop-editbox" data-prop-edit="${esc(id)}" rows="6"
            aria-label="Touch up the proposed text">\n${esc(value)}</textarea>`;
}

/** The card; each panel-specific piece arrives as markup (`head`, `before`/`after` the editor, `tail`, `body` the diff). */
export function reviewCardHtml({ id, op, opLabel, name, status, statusText, rejected, head = '', acts = '', before = '', edit = '', after = '', why = '', reason = '', tail = '', body = '' }) {
    const live = status === 'ready' && !rejected;
    return `
    <div class="cas-prop${rejected ? ' is-rejected' : ''}" data-prop-id="${esc(id)}" data-status="${esc(status)}" data-op="${esc(op)}">
        <div class="cas-prop-head">
            <input type="checkbox" class="cas-prop-pick" ${live ? 'checked' : ''}
                ${live ? '' : 'disabled'} aria-label="Include this change">
            <span class="cas-prop-op">${esc(opLabel)}</span>
            <span class="cas-prop-name">${esc(name)}</span>
            ${head}
            <span class="cas-prop-acts">${acts}</span>
            <span class="cas-prop-status">${rejected ? 'set aside' : esc(statusText)}</span>
        </div>
        ${before}
        ${edit}
        ${after}
        ${why ? `<div class="cas-prop-why">${esc(why)}</div>` : ''}
        ${reason ? `<div class="cas-prop-reason">${esc(reason)}</div>` : ''}
        ${tail}
        ${body}
    </div>`;
}

/** The edited flag, raised by a touch-up on either panel. */
export const reviewEditedFlagHtml = () => '<span class="cas-prop-flag" title="You touched this up; your text is what applies">edited</span>';

/** The approximate flag: a replace the judge placed on a quote a little off the text (`where` names the message or field). */
export const reviewApproximateFlagHtml = (p, status, rejected, where) => (p.approximate && status === 'ready' && !rejected ? `<span class="cas-prop-flag" title="The quoted passage differs slightly from the ${where}; the diff shows the exact text that will be replaced.">matched approximately</span>` : '');

/** The footer verb: what is ticked and still live gets applied. */
const applyFooterHtml = (seq) => `<div class="cas-props-actions">
                <button type="button" class="cl-cwin-btn-text is-primary" data-cas-act="apply" data-seq="${seq}">
                    <i class="fa-solid fa-check"></i> Apply Selected
                </button>
            </div>`;

/** The reply carried proposals but its verdicts could not be read: an honest row with a retry, never silence. */
export const reviewFailedHtml = (seq) => `<div class="cas-props" data-seq="${seq}">
            <button type="button" class="cas-nudge" data-cas-act="retry-proposals" data-seq="${seq}">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span>Could not read this reply's proposed changes. Retry</span>
            </button>
        </div>`;

/** A reply that carried nothing, on the last turn only: the ask it sends says "that reply". */
export const reviewNudgeHtml = (seq, text) => `<div class="cas-props" data-seq="${seq}">
                 <button type="button" class="cas-nudge" data-cas-act="nudge" data-seq="${seq}">
                   <i class="fa-solid fa-wand-magic-sparkles"></i>
                   <span>${esc(text)}</span>
                 </button>
               </div>`;

/** The block that holds a reply's cards: the head with the live count, the parse errors, the cards, the footer. */
export function reviewBlockHtml({ seq, icon, title = 'Proposed changes', live, errors = [], canFix, units }) {
    return `
    <div class="cas-props" data-seq="${seq}">
        <div class="cas-props-card">
            <div class="cas-props-head">
                <i class="fa-solid ${icon}"></i>
                <span class="cas-props-title">${esc(title)}</span>
                ${live ? `<span class="cas-props-count">${live} pending</span>` : ''}
            </div>
            ${errors.map(e => `<div class="cas-prop-error"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(e.message)}</div>`).join('')}
            ${errors.length && canFix
        ? `<button type="button" class="cas-nudge" data-cas-act="fix-block" data-seq="${seq}">
                   <i class="fa-solid fa-rotate-right"></i>
                   <span>Fix and Re-issue the Block${errors.length > 1 ? 's' : ''}</span>
               </button>`
        : ''}
            ${units}
            ${live ? applyFooterHtml(seq) : ''}
        </div>
    </div>`;
}

/** Syncs the count and Apply footer surgically (a re-render re-ticks unticked boxes); node insert/remove since .cas-props-actions sets display. */
export function syncReviewChrome(seq, live, { scope = '' } = {}) {
    const card = document.querySelector(`${scope}.cas-props[data-seq="${seq}"] .cas-props-card`);
    if (!card) return;
    const count = card.querySelector('.cas-props-count');
    if (count && !live) count.remove();
    else if (count) count.textContent = `${live} pending`;
    else if (live) card.querySelector('.cas-props-title')?.insertAdjacentHTML('afterend', `<span class="cas-props-count">${live} pending</span>`);
    const foot = card.querySelector('.cas-props-actions');
    if (foot && !live) foot.remove();
    else if (!foot && live) card.insertAdjacentHTML('beforeend', applyFooterHtml(seq));
}

/** The id alone addresses nothing: its message's container scopes every card lookup. */
function reviewCardEl(seq, id, { scope = '' } = {}) {
    return document.querySelector(`${scope}.cas-props[data-seq="${seq}"] .cas-prop[data-prop-id="${CSS.escape(id)}"]`);
}

/** Swap ONE card (a full re-render scrolls the transcript away), carrying the checkbox unless `carryPick` is false. */
export function repaintReviewCard(seq, id, render, { scope = '', carryPick = true, after = null } = {}) {
    const card = reviewCardEl(seq, id, { scope });
    if (!card) return;
    const picked = card.querySelector('.cas-prop-pick')?.checked;
    const html = render(card);
    if (typeof html !== 'string') return;
    card.outerHTML = html;
    const fresh = reviewCardEl(seq, id, { scope });
    const pick = fresh?.querySelector('.cas-prop-pick');
    if (carryPick && pick && !pick.disabled && typeof picked === 'boolean') pick.checked = picked;
    if (fresh && after) after(fresh);
}

// ========================================
// A TURN'S PICTURES
// ========================================

/** Whether a panel's connection sees pictures, by the editor's rule over the kinds as read now; unread kinds leave it null (not checked). */
export async function connectionSight(profile) {
    if (!profile) return null;
    try {
        const resp = await CoreAPI.apiRequest('/llm/kinds', 'GET');
        const kinds = resp.ok ? await resp.json() : null;
        return Array.isArray(kinds) ? seesPictures(profile, kinds.find(k => k?.kind === profile.kind)) : null;
    } catch {
        return null;
    }
}

/** A stored picture's thumbnail on the ladder, by its reference ({ kind: avatar | media | attachment, id }). */
export function pictureThumbUrl(ref, size) {
    if (ref?.kind === 'attachment') return CoreAPI.thumbUrl('attachment', ref.id, size);
    if (ref?.kind === 'media') return CoreAPI.thumbUrl('media', ref.id, size);
    if (ref?.kind === 'avatar') return CoreAPI.getCharacterAvatarThumbUrl(ref.id, size);
    return '';
}

/**
 * Pictures waiting for the next send, painted as a strip of thumbnails each with a remove.
 * @param {{strip: () => HTMLElement|null, removeTitle?: string, onChange?: Function}} opts onChange: after every change, eg. a picker's marks
 */
export function createPictureTray({ strip, removeTitle = 'Not with this message', onChange = null }) {
    let items = [];
    const same = (a, b) => a.kind === b.kind && a.id === b.id;
    const paint = () => {
        onChange?.();
        const el = strip();
        if (!el) return;
        el.hidden = !items.length;
        el.innerHTML = items.map((p, i) => `
            <span class="cl-pic-tray-item" role="listitem" title="${esc(p.name)}">
                <img src="${esc(pictureThumbUrl(p, 192))}" alt="${esc(p.name)}" decoding="async">
                <button type="button" class="cl-pic-tray-remove" data-tray-remove="${i}" title="${esc(removeTitle)}" aria-label="${esc(removeTitle)}"><i class="fa-solid fa-xmark"></i></button>
            </span>`).join('');
    };
    const tray = {
        get items() { return items; },
        add(item) {
            if (!items.some(p => same(p, item))) items = [...items, item];
            paint();
        },
        /**
         * Upload the pictures among files one by one and hold each stored one; a host owning the route spells it.
         * @param {Function} post (file, name, options) -> the attachments route's Response, name already encoded
         * @param {Function} still () -> whether the owner the upload is for is still the screen's; false stops
         */
        async addFiles(files, post, still) {
            const pictures = files.filter(f => String(f.type || '').startsWith('image/') || CoreAPI.galleryKindOf(f.name) === 'image');
            if (!pictures.length) { if (files.length) CoreAPI.showToast('Only pictures go with a message', 'info'); return 0; }
            let failed = 0;
            let added = 0;
            for (const file of pictures) {
                let a;
                try {
                    const raw = { raw: true, headers: { 'Content-Type': file.type || 'application/octet-stream' } };
                    a = (await CoreAPI.readAnswer(await post(file, encodeURIComponent(file.name || 'picture.png'), raw)))?.attachment;
                } catch { failed++; continue; }
                if (!still()) return added;
                if (a) { tray.add({ kind: 'attachment', id: a.id, name: a.name }); added++; }
            }
            if (failed) CoreAPI.showToast(`${failed} picture${failed === 1 ? '' : 's'} could not be attached`, 'error');
            return added;
        },
        /** A feed's attachment records: a picture removed leaves the strip, so no send names it. */
        dropRemoved(records) {
            const gone = new Set(records.filter(r => r.op === 'deleted').flatMap(r => r.ids || []));
            if (gone.size) tray.drop(p => p.kind === 'attachment' && gone.has(p.id));
        },
        removeAt(i) { items = items.filter((_, k) => k !== i); paint(); },
        /** What the send takes, the tray left empty; giveBack restores them ahead of any added since. */
        take() { const out = items; items = []; paint(); return out; },
        giveBack(list) { items = [...list, ...items.filter(p => !list.some(q => same(p, q)))]; paint(); },
        drop(pred) { const next = items.filter(p => !pred(p)); if (next.length !== items.length) { items = next; paint(); } },
        clear() { items = []; paint(); },
        paint,
    };
    return tray;
}

/** The tray follows a removal from another tab and from this one (the gallery window's Remove): two patchers, one per origin. */
export function followPictureRemovals(tray) {
    registerFeedPatcher('attachment', (records) => tray.dropRemoved(records));
    registerFeedPatcher('attachment', (records) => tray.dropRemoved(records), { own: true });
}

/** A connection written in this tab or another may move a panel's sight: reread() reads it again. */
export function followConnectionWrites(reread) {
    registerFeedPatcher('llmProfile', () => reread());
    registerFeedPatcher('llmProfile', () => reread(), { own: true });
}

/** Pictures into a chat's gallery, held in the tray for the next send; still() false (the chat left mid-upload) holds nothing over. */
export function attachToChat(tray, chatId, files, still) {
    return tray.addFiles(files, (file, name, raw) => CoreAPI.apiRequest(`/chats/${encodeURIComponent(chatId)}/attachments?name=${name}`, 'POST', file, raw), still);
}

/**
 * A composer's ways in for pictures: a paste into its box, its file input's pick, a drop on its targets.
 * @param {{box, picker, drops: Array, attach: Function, blocked: Function}} opts blocked() refuses all three (a connection not known to see)
 */
export function wirePictureInputs({ box, picker, drops = [], attach, blocked }) {
    box?.addEventListener('paste', (e) => {
        const files = [...(e.clipboardData?.files || [])].filter(f => String(f.type || '').startsWith('image/'));
        if (!files.length || blocked()) return;
        e.preventDefault();
        void attach(files);
    });
    picker?.addEventListener('change', () => {
        const files = [...picker.files];
        picker.value = '';
        if (files.length) void attach(files);
    });
    for (const target of drops) {
        target?.addEventListener('dragover', (e) => { if (!blocked() && e.dataTransfer?.types?.includes?.('Files')) e.preventDefault(); });
        target?.addEventListener('drop', (e) => {
            if (blocked() || !e.dataTransfer?.files?.length) return;
            e.preventDefault();
            void attach([...e.dataTransfer.files]);
        });
    }
}

/**
 * A panel's composer box: Enter sends on a computer, it grows with its text, and pictures come in through wirePictureInputs.
 * @returns {Function} the box's fit, for a host that changes its text
 */
export function wirePanelComposer({ box, send, ...pictures }) {
    box?.addEventListener('keydown', (e) => {
        // a phone keeps Enter as newline, the send button is right there
        if (e.key !== 'Enter' || e.shiftKey || CoreAPI.isMobileMode()) return;
        e.preventDefault();
        void send();
    });
    wirePictureInputs({ box, ...pictures });
    return wireCwinInputGrow(box);
}

/** A turn's pictures full screen from the i-th, each by its stored file (url as the server answers it). */
export function openPictures(list, index, title) {
    const media = CoreAPI.buildGalleryViewerMedia((list || []).map(p => ({ name: p.name, url: CoreAPI.serverUrl(p.url), kind: 'image' })));
    if (media?.length) CoreAPI.openGalleryViewerWithImages(media, Math.max(0, Number(index) || 0), title);
}

/** A turn's pictures under its text, each a button the host opens full screen through attr; names are the reader's, escaped. */
export function picturesHtml(list, { attr = 'data-act="picture"', size = 384 } = {}) {
    if (!Array.isArray(list) || !list.length) return '';
    return `<div class="cl-pics">${list.map((p, i) => `
        <button type="button" class="cl-pic" ${attr} data-index="${i}" title="${esc(p.name)}" aria-label="Open ${esc(p.name)}">
            <img src="${esc(pictureThumbUrl(p, size))}" alt="${esc(p.name)}" loading="lazy" decoding="async">
        </button>`).join('')}</div>`;
}
