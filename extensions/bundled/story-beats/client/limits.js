// Story Beats' ranges and words, loaded by both halves (the server imports ../client/limits.js), so one change moves both.

export const SETTING_LIMITS = Object.freeze({
    maxTokens: Object.freeze([1024, 65536]),
    reasoningTokens: Object.freeze([1024, 65536]),
    every: Object.freeze([1, 50]),
    messages: Object.freeze([2, 40]),
    depth: Object.freeze([0, 100]),
    budget: Object.freeze([200, 20000]),
});

/** A numeric setting held to its range; a value that reads as no number is the declared default. */
export function settingNumber(key, value, fallback) {
    const [lo, hi] = SETTING_LIMITS[key];
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

// a beat's own counters: the messages it stays active before it fades, and before it is skipped (0 is never)
export const BEAT_LIMITS = Object.freeze({
    fadeAfter: Object.freeze([0, 500]),
    maxMessages: Object.freeze([0, 500]),
});

/** A number held to a range, unrounded; anything that is no number is null. */
export function within(value, [lo, hi]) {
    const n = Number(value);
    return value !== null && value !== '' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
}

/** A beat counter as the server keeps it: a whole number in its range, 0 for anything else. */
export function beatCount(key, value) {
    const n = within(value, BEAT_LIMITS[key]);
    return n === null ? 0 : Math.round(n);
}

export const WEIGHTS = Object.freeze(['soft', 'firm', 'hard']);
export const STATUSES = Object.freeze(['pending', 'active', 'suggested', 'satisfied', 'skipped']);
export const STRATEGIES = Object.freeze(['adaptive', 'time-gated', 'strict']);
export const ROLES = Object.freeze(['system', 'user']);

export const TITLE_MAX = 120;
export const DIRECTIVE_MAX = 1000;
export const BEATS_MAX = 200;
export const ADD_MAX = 50;
export const NOTES_MAX = 8000;
export const TURNS_MAX = 40;
export const TURN_MAX = 8000;
export const REASON_MAX = 200;
export const LOG_MAX = 500;
