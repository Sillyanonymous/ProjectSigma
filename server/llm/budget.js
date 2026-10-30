// Prompt budgeting, the ONLY bound on a prompt and never switchable off. chars/4, the same estimate the library shows

import { badRequest } from './errors.js';

export const estimateTextTokens = text => Math.round(String(text || '').length / 4);

// the long edge an image is sent at (Anthropic's standard tier reads it natively)
export const IMAGE_MAX_EDGE = 1568;
// 28 px patches, the dearest of the published counts at that size
const IMAGE_PATCH = 28;

/** What an image costs, from the size it is sent at; an image whose size is unknown costs the cap's square. */
export function estimateImageTokens(width, height) {
    const known = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
    const scale = known ? Math.min(1, IMAGE_MAX_EDGE / Math.max(width, height)) : 1;
    const [w, h] = known ? [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))] : [IMAGE_MAX_EDGE, IMAGE_MAX_EDGE];
    return Math.ceil(w / IMAGE_PATCH) * Math.ceil(h / IMAGE_PATCH);
}

const imagesTokens = images => (Array.isArray(images) ? images.reduce((n, i) => n + estimateImageTokens(i?.width, i?.height), 0) : 0);

/** A turn's text with its pictures named in it, the line each sends when it stands in as text. */
export const picturesAsText = (content, pictures) => [content, ...pictures.map(p => `[picture: ${p.name}]`)].filter(Boolean).join('\n');

/** How many pictures a prompt's messages carry. */
export const imagesIn = (messages) => messages.reduce((n, m) => n + (Array.isArray(m.images) ? m.images.length : 0), 0);

/**
 * The fewest oldest pictured turns that stand in as text so a host's picture limit holds; a 400 when what must go is past it.
 * @param {number[]} counts each strippable turn's pictures, oldest first
 * @param {number} fixed the pictures that go whatever stands in (the newest turn's, a block's)
 * @param {number|null} cap the connection's limit, null for none
 */
export function pictureFloor(counts, fixed, cap) {
    if (!cap) return 0;
    if (fixed > cap) throw badRequest(`this connection takes at most ${cap} picture${cap === 1 ? '' : 's'} a request, and ${fixed} must go with this one (the newest turn's, and any the prompt always shows)`);
    let room = cap - fixed;
    let k = counts.length;
    while (k > 0 && counts[k - 1] <= room) room -= counts[--k];
    return k;
}

/**
 * Fit turns carrying pictures: the oldest stand in as text before any turn drops; a host's limit sets the floor.
 * @param {Function} assemble (turns) -> messages
 * @param {Array} turns oldest first, a turn's pictures in its images
 * @param {Object} opts fitToBudget's, plus cap (the connection's picture limit)
 * @returns fitToBudget's answer plus pictures: { sent, stoodIn }
 */
export function fitPicturedTurns(assemble, turns, { cap = null, ...opts } = {}) {
    const strippable = turns.slice(0, -1).filter(t => t.images?.length);
    const build = (kept, stoodIn = 0) => {
        const asText = new Set(strippable.slice(0, stoodIn));
        return assemble(kept.map(t => (asText.has(t) ? { role: t.role, content: picturesAsText(t.content, t.images) } : t)));
    };
    const held = turns.reduce((n, t) => n + (t.images?.length || 0), 0);
    const minStoodIn = cap && held > cap ? pictureFloor(strippable.map(t => t.images.length), imagesIn(build(turns, strippable.length)), cap) : 0;
    const fitted = fitToBudget(build, turns, { ...opts, strippable: strippable.length, minStoodIn });
    const kept = new Set(fitted.history);
    const stoodIn = strippable.slice(0, fitted.stoodIn).filter(t => kept.has(t)).reduce((n, t) => n + t.images.length, 0);
    return { ...fitted, pictures: { sent: imagesIn(fitted.messages), stoodIn } };
}

export function estimateMessagesTokens(messages) {
    // per-message envelope (role, delimiters), keeps the estimate on the conservative side
    const PER_MESSAGE_OVERHEAD = 4;
    return messages.reduce((sum, m) => sum + estimateTextTokens(m.content) + imagesTokens(m.images) + PER_MESSAGE_OVERHEAD, 0);
}

/**
 * Trim history, oldest first, until the prompt fits; only history is ever dropped, its oldest pictures standing in as text first.
 * @param {Function} assemble (history, stoodIn) -> messages, called per attempt; stoodIn is how many of the oldest pictured turns go as text
 * @param {Array} history the full windowed history, oldest first
 * @param {Object} opts maxContext, reserveForReply, minHistory, strippable (the pictured turns that may stand in), minStoodIn (how many must, for a host's picture limit)
 * @returns {{messages, history, trimmed: number, stoodIn: number, tokens: number, overBudget: boolean, fixedTokens?: number}} fixedTokens (over budget only) is the prompt with no history
 */
export function fitToBudget(assemble, history, { maxContext = 0, reserveForReply = 0, minHistory = 2, strippable = 0, minStoodIn = 0 } = {}) {
    const floor = Math.min(Math.max(minStoodIn, 0), strippable);
    let messages = assemble(history, floor);
    let tokens = estimateMessagesTokens(messages);

    // No budget configured means the old behaviour: send it and let the provider judge.
    if (!Number.isFinite(maxContext) || maxContext <= 0) {
        return { messages, history, trimmed: 0, stoodIn: floor, tokens, overBudget: false };
    }

    const ceiling = Math.max(maxContext - Math.max(reserveForReply, 0), 1);
    if (tokens <= ceiling) return { messages, history, trimmed: 0, stoodIn: floor, tokens, overBudget: false };

    // a picture weighs as much as pages of text: the fewest oldest pictures that let every turn stay go as text first
    if (strippable > floor) {
        let lo = floor + 1, hi = strippable, found = null;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const m = assemble(history, mid);
            const t = estimateMessagesTokens(m);
            if (t <= ceiling) { found = { messages: m, history, trimmed: 0, stoodIn: mid, tokens: t, overBudget: false }; hi = mid - 1; }
            else lo = mid + 1;
        }
        if (found) return found;
    }

    // each drop shrinks the prompt, so bisect for the smallest fitting drop; one assemble per row was quadratic
    const stoodIn = strippable;
    const maxDrop = Math.max(history.length - minHistory, 0);
    let lo = 1, hi = maxDrop, best = null;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const kept = history.slice(mid);
        const m = assemble(kept, stoodIn);
        const t = estimateMessagesTokens(m);
        if (t <= ceiling) { best = { messages: m, history: kept, trimmed: mid, stoodIn, tokens: t, overBudget: false }; hi = mid - 1; }
        else lo = mid + 1;
    }
    if (best) return best;

    // the fixed part alone doesnt fit: report it so the caller can say why, not relay a provider error
    const kept = history.slice(maxDrop);
    messages = assemble(kept, stoodIn);
    tokens = estimateMessagesTokens(messages);
    const fixedTokens = estimateMessagesTokens(assemble([], stoodIn));
    return { messages, history: kept, trimmed: maxDrop, stoodIn, tokens, overBudget: true, fixedTokens };
}
