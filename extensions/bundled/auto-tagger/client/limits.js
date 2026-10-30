// The numeric settings' ranges, loaded by both halves (the server imports ../client/limits.js), so
// one change moves both.

export const SETTING_LIMITS = Object.freeze({
    maxTags: Object.freeze([1, 20]),
});

/** A numeric setting held to its range; a value that reads as no number is the declared default. */
export function settingNumber(key, value, fallback) {
    const [lo, hi] = SETTING_LIMITS[key];
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}
