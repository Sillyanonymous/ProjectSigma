// The conversation window: one mount for every panel.

import CoreAPI from '../core-api.js';

// .cl-range fill: the filled track is a gradient stop read from --cl-range-fill, no engine links a value to CSS natively
function rangeFillOf(el) {
    const min = Number(el.min) || 0;
    const max = Number(el.max) || 100;
    const v = Number(el.value);
    const pct = ((v - min) / ((max - min) || 1)) * 100;
    el.style.setProperty('--cl-range-fill', `${Math.min(100, Math.max(0, pct))}%`);
}

document.addEventListener('input', (e) => {
    if (e.target?.classList?.contains('cl-range')) rangeFillOf(e.target);
});

/** Paint the fill on every .cl-range under scope; call after rendering one. */
export function syncRangeFill(scope = document) {
    scope.querySelectorAll?.('.cl-range').forEach(rangeFillOf);
}

// every .cl-cwin shares one z-index, so without this stacking falls back to DOM order
let topZ = 5; // matches the shared .cl-cwin z-index in chats.css

/**
 * Bring one conversation window to the front.
 * @param {HTMLElement} panel the .cl-cwin layer
 */
export function raiseChatWindow(panel) {
    if (!panel || panel.style.zIndex === String(topZ)) return;
    panel.style.zIndex = String(++topZ);
}

const WINDOWS = new Map(); // panel element -> that panel's own close function

/** Always exclusive on mobile (every sheet is pinned full screen); a desktop preference otherwise. */
function exclusiveMode() {
    if (document.documentElement.classList.contains('cl-mobile')) return true;
    return CoreAPI.getSetting('chatPanelsExclusive') === true;
}

/**
 * Take the front, and in exclusive mode the only slot. Run it before any await so two racing opens cant both survive.
 * @param {HTMLElement} panel the .cl-cwin being opened
 */
export function claimChatWindow(panel) {
    raiseChatWindow(panel);
    // one history guard per opened layer, or a back press spends the conversation's guard closing a panel
    window.pushOverlayGuard?.();
    if (!exclusiveMode()) return;
    for (const [other, close] of WINDOWS) {
        if (other === panel || !other.classList.contains('is-open')) continue;
        try { close(); } catch { /* one panel refusing to close never stops the one asked for */ }
    }
}

/**
 * Open one conversation window: the front, is-open, the aria state, the header button lit.
 * @param {HTMLElement} panel the .cl-cwin layer
 * @param {{button?: string}} [opts] the conversation-header button id to light
 * @returns {boolean} false when there is no panel to open
 */
export function openChatWindow(panel, { button } = {}) {
    if (!panel) return false;
    claimChatWindow(panel);
    panel.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    if (button) document.getElementById(button)?.classList.add('is-panel-open');
    return true;
}

/**
 * The exact reverse of openChatWindow; a panel's own state stays the panel's.
 * @param {HTMLElement|null} panel
 * @param {{button?: string}} [opts]
 */
export function closeChatWindow(panel, { button } = {}) {
    panel?.classList.remove('is-open');
    panel?.setAttribute('aria-hidden', 'true');
    if (button) document.getElementById(button)?.classList.remove('is-panel-open');
}

/**
 * Register a conversation window with the overlay stack at tier 0.5, under the conversation's 1 so back closes the panel first.
 * @param {string} id the .cl-cwin element id
 * @param {{close: Function, follow?: (detail: object) => void}} opts close is the panel's own; follow hears cl-character-changed
 * @returns {Function} the unregister
 */
export function registerChatWindow(id, { close, follow } = {}) {
    window.registerOverlay?.({
        id,
        tier: 0.5,
        close: () => close(),
        visible: (el) => el.classList.contains('is-open') && document.documentElement.classList.contains('cl-chat-open'),
    });
    const onChange = typeof follow === 'function' ? (e) => follow(e.detail || {}) : null;
    if (onChange) document.addEventListener('cl-character-changed', onChange);
    return () => {
        window.unregisterOverlay?.(id);
        if (onChange) document.removeEventListener('cl-character-changed', onChange);
    };
}

/**
 * Make one panel sheet a draggable, resizable, geometry-persisting window.
 * @param {HTMLElement} sheet the .cl-cwin-sheet element
 * @param {string} [opts.key] the window's key in the windowGeometry row (needs a WINDOW_DEFAULTS entry)
 * @param {{defaults: object, load: Function, save: Function}} [opts.geometry] accessors instead of a key, eg. an extension's scoped settings
 * @param {{w:number,h:number}} [opts.min]
 * @param {Function} [opts.close] this panel's close, so exclusive mode can close it
 * @returns {Function} the unmount
 */
export function mountChatWindow(sheet, { key, geometry, min = { w: 20, h: 25 }, close }) {
    if (!sheet) return () => {};
    if (!key && !geometry) throw new Error('mountChatWindow needs a window key or geometry accessors');
    const layer = sheet.closest('.cl-cwin') || sheet;
    if (typeof close === 'function') WINDOWS.set(layer, close);
    // Capture phase: a panel whose own handlers stop propagation would otherwise never raise.
    sheet.addEventListener('pointerdown', () => raiseChatWindow(sheet.closest('.cl-cwin')), true);
    const defaults = geometry ? geometry.defaults : CoreAPI.getDefaultWindowGeometry(key);
    CoreAPI.makeFloatingWindow(sheet, {
        // the shared grip class: a renamed per-panel class would silently lose every handle
        grips: '.fw-grip',
        moveHandle: sheet.querySelector('.cl-cwin-header'),
        bounds: document.getElementById('chatsConversation'),
        centered: false,
        // chats.css pins every panel full-screen under html.cl-mobile, so a drag there
        // moves nothing on screen and must not persist anything either
        pinned: () => document.documentElement.classList.contains('cl-mobile'),
        min,
        defaults,
        // a stored entry may be partial (a fold of a half-saved quartet), so the shipped
        // geometry fills whatever axis it lacks
        load: geometry ? () => geometry.load() : () => ({ ...defaults, ...(CoreAPI.getWindowGeometry(key) || {}) }),
        save: geometry ? (g) => geometry.save(g) : (g) => CoreAPI.setWindowGeometry(key, g),
    });
    return () => WINDOWS.delete(layer);
}

// a chat's text shows as stored everywhere it shows, so a raw {{user}} reads raw, never as the global persona
export const STORED_TEXT = Object.freeze({ macros: false });

/**
 * Auto-grow wiring for the .cl-cwin-input-row textarea; returns fit(), which callers also
 * run at panel open inside a requestAnimationFrame so the width is real.
 */
export function wireCwinInputGrow(ta, opts) {
    if (!ta) return () => {};
    const fit = () => CoreAPI.fitTextarea(ta, opts);
    ta.addEventListener('input', fit);
    return fit;
}
