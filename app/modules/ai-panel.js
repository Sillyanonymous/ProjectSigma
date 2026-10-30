// What the two review panels share: the review helpers, saved prompts, and a turn's pictures (the chat composer's too)

import CoreAPI from './core-api.js';
import { seesPictures } from './connection-editor.js';
import { wireCwinInputGrow } from './chats/window.js';
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
 * @returns {{ mark: Function, flush: Function, stop: Function, dirty: () => boolean }}
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
// THE REVIEW SURFACE
// ========================================
//
// A proposal card, its act cluster, the block that holds a reply's cards and the surgical
// repaint: the chat assistant and the creator studio drew all of it twice, in two copies
// that had to be edited in lockstep.
// What differs between the panels is the CONTENT of a card (an entry's name and book, a
// field's label, the flags each engine can raise); the chrome, the vocabulary and the
// mechanics are one thing and live here.

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
