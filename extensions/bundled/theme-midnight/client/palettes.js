// SPDX-License-Identifier: MIT

// Midnight's palettes: the four it ships, Auto's hours, and what a palette writes. Pure, no DOM.

export const SKIES = ['stars', 'aurora', 'embers', 'haze', 'none'];
export const SKY_LABELS = { stars: 'Drifting stars', aurora: 'Aurora', embers: 'Rising embers', haze: 'Moonlit haze', none: 'No sky' };
export const DENSITIES = { sparse: 0.55, balanced: 1, rich: 1.6 };

export const BUILT_IN = [
    { id: 'midnight', name: 'Midnight', note: 'Ice blue on navy', accent: '#8ccfff', accent2: '#8f9dff', hue: 224, glow: 60, sky: 'stars' },
    { id: 'aurora', name: 'Aurora', note: 'Teal into violet', accent: '#5fe8c9', accent2: '#ad8cff', hue: 240, glow: 72, sky: 'aurora' },
    { id: 'ember', name: 'Ember', note: 'Amber and rose', accent: '#ffb86e', accent2: '#ff7f9d', hue: 338, glow: 66, sky: 'embers' },
    { id: 'moonlit', name: 'Moonlit', note: 'Silver, high contrast', accent: '#e4eaf6', accent2: '#aebcd9', hue: 218, glow: 34, sky: 'haze', contrast: 'high' },
];

// the hour each phase starts, local time; the last one runs past midnight to the first
export const AUTO_PHASES = [
    { phase: 'dawn', label: 'Dawn', from: 5, palette: 'ember' },
    { phase: 'day', label: 'Day', from: 8, palette: 'moonlit' },
    { phase: 'dusk', label: 'Dusk', from: 17, palette: 'aurora' },
    { phase: 'night', label: 'Night', from: 20, palette: 'midnight' },
];

/** The phase a local time falls in. @param {Date} date */
export function phaseAt(date) {
    const h = date.getHours() + date.getMinutes() / 60;
    let at = AUTO_PHASES[AUTO_PHASES.length - 1];
    for (const p of AUTO_PHASES) if (h >= p.from) at = p;
    return at;
}

export const builtIn = (id) => BUILT_IN.find(p => p.id === id) || null;

/**
 * What a palette setting names: a built-in id, 'auto', or 'own:<id>'.
 * @returns {{ kind: 'built-in' | 'auto' | 'own', id: string } | null}
 */
export function parseChoice(value) {
    const v = String(value ?? '');
    if (builtIn(v)) return { kind: 'built-in', id: v };
    if (v === 'auto') return { kind: 'auto', id: 'auto' };
    const own = v.startsWith('own:') ? v.slice(4) : null;
    return own && PALETTE_ID.test(own) ? { kind: 'own', id: own } : null;
}

// ---- colour ------------------------------------------------------------------------------------

export function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const hex2 = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
export const rgbToHex = ({ r, g, b }) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
export const rgbList = ({ r, g, b }) => `${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}`;
const rgba = (c, a) => `rgba(${rgbList(c)}, ${+a.toFixed(3)})`;

export function rgbToHsl({ r, g, b }) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    return { h: h * 60, s, l };
}

export function hslToRgb({ h, s, l }) {
    const hue = (((h % 360) + 360) % 360) / 360;
    if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return { r: f(hue + 1 / 3) * 255, g: f(hue) * 255, b: f(hue - 1 / 3) * 255 };
}
const hsl = (h, s, l) => hslToRgb({ h, s, l });
// a colour as it is written: whole channels, so a contrast is judged on the hex that ships
const whole = (c) => ({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) });

/** WCAG relative luminance. */
export function luminance({ r, g, b }) {
    const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });

const apcaY = ({ r, g, b }) => {
    const y = 0.2126729 * (r / 255) ** 2.4 + 0.7151522 * (g / 255) ** 2.4 + 0.072175 * (b / 255) ** 2.4;
    return y < 0.022 ? y + (0.022 - y) ** 1.414 : y;
};
/** APCA lightness contrast (W3 0.1.9) of a text on a ground, unsigned: how the eye weighs one against the other. */
export function apca(text, ground) {
    const t = apcaY(text), g = apcaY(ground);
    if (Math.abs(g - t) < 0.0005) return 0;
    const s = g > t ? (g ** 0.56 - t ** 0.57) * 1.14 : (t ** 0.62 - g ** 0.65) * 1.14;
    return s < 0.1 ? 0 : (s - 0.027) * 100;
}

export const AA = 4.5;
/** The APCA floor an accent holds under its ink, beside AA: it is painted as a fill under that ink. */
export const LC = 60;
export const INK = { r: 8, g: 10, b: 20 };
const WHITE = { r: 255, g: 255, b: 255 };

/** The editorial conversation's layers over the sky, in the night's colour: its backdrop and its reading veil (the sheet holds the same). */
export const VEIL = { backdrop: 0.38, column: 0.85 };
/** The brightest ground a reply's text meets: a white sky seen through both layers. */
export const litNight = (night) => whole(mix(WHITE, night, 1 - (1 - VEIL.backdrop) * (1 - VEIL.column)));

/**
 * An accent readable as text on a ground and under text of its own, at AA: lightened along its hue
 * until both hold.
 */
export function readableAccent(rgb, ground, { minSat = 0, maxSat = 1 } = {}) {
    const c = rgbToHsl(rgb);
    const s = clamp(c.s, minSat, maxSat);
    let l = c.l;
    let out = whole(hsl(c.h, s, l));
    for (let i = 0; i < 100 && (contrast(out, ground) < AA || contrast(out, INK) < AA); i++) {
        l = Math.min(0.98, l + 0.01);
        out = whole(hsl(c.h, s, l));
    }
    return out;
}

/** An accent the fills can wear under the ink: readable as text, then lightened until the ink clears the APCA floor on it too. */
export function fillableAccent(rgb, ground, opts) {
    const c = rgbToHsl(readableAccent(rgb, ground, opts));
    let l = c.l;
    let out = whole(hsl(c.h, c.s, l));
    for (let i = 0; i < 100 && apca(INK, out) < LC; i++) {
        l = Math.min(0.98, l + 0.01);
        out = whole(hsl(c.h, c.s, l));
    }
    return out;
}

/** The text a colour carries: white or ink, whichever the eye reads better (APCA; the WCAG ratio picks muddy ink on mid tones). */
export const textOn = (rgb) => (apca(WHITE, rgb) >= apca(INK, rgb) ? WHITE : INK);

// the secondary accent when a palette names none: a twelfth of the wheel on, a touch quieter
function secondOf(rgb) {
    const c = rgbToHsl(rgb);
    return hsl(c.h + 30, Math.min(1, c.s * 0.9), Math.max(0, c.l * 0.95));
}

/**
 * Everything a palette writes as --mn-* properties: the night along its base hue, the accent pair,
 * the glow, the conversation's plates and voices.
 * @param {{ accent: string, accent2?: string, hue: number, glow: number, contrast?: string }} def
 */
export function tokensOf(def) {
    const H = Number(def.hue) || 0;
    const high = def.contrast === 'high';
    const S = high ? 0.16 : 0.5;
    const g = clamp(Number(def.glow) / 100, 0, 1);
    const night = whole(hsl(H, S, 0.045));
    const ground = litNight(night);
    const accent = fillableAccent(hexToRgb(def.accent) || hexToRgb('#8ccfff'), ground);
    const accent2 = fillableAccent(hexToRgb(def.accent2 || '') || secondOf(accent), ground);
    const text = hsl(H, high ? 0.3 : 0.42, high ? 0.97 : 0.93);
    const light = hsl(H, 0.6, 0.82);
    const shadow = hsl(H, 0.6, 0.02);
    const out = {
        '--mn-hue': String(H),
        '--mn-glow': String(+g.toFixed(2)),
        '--mn-void': rgbToHex(night),
        '--mn-void-rgb': rgbList(night),
        '--mn-deep': rgbToHex(hsl(H, S * 0.85, 0.085)),
        '--mn-deep-rgb': rgbList(hsl(H, S * 0.85, 0.085)),
        '--mn-card': rgba(hsl(H, S * 0.6, 0.13), 0.55),
        '--mn-glass': rgba(hsl(H, S * 0.7, 0.1), high ? 0.9 : 0.76),
        '--mn-glass-strong': rgba(hsl(H, S * 0.7, 0.085), 0.97),
        '--mn-glass-solid': rgbToHex(hsl(H, S * 0.7, 0.09)),
        '--mn-raise': rgba(light, high ? 0.075 : 0.045),
        '--mn-raise-2': rgba(light, high ? 0.12 : 0.08),
        '--mn-line': rgba(light, high ? 0.2 : 0.1),
        '--mn-line-strong': rgba(light, high ? 0.3 : 0.17),
        '--mn-text': rgbToHex(text),
        '--mn-text-rgb': rgbList(text),
        '--mn-text-2': rgbToHex(hsl(H, 0.22, high ? 0.83 : 0.75)),
        '--mn-text-3': rgbToHex(hsl(H, 0.16, high ? 0.7 : 0.62)),
        '--mn-text-4': rgbToHex(hsl(H, 0.14, high ? 0.6 : 0.53)),
        '--mn-shadow-rgb': rgbList(shadow),
        '--mn-nebula-a': rgba(hsl(H + 38, 0.72, 0.42), 0.08 + 0.2 * g),
        '--mn-nebula-b': rgba(accent, 0.04 + 0.11 * g),
        '--mn-plate-char': rgba(hsl(H, S * 0.65, 0.12), high ? 0.86 : 0.66),
        '--mn-plate-user': rgba(hsl(H, S * 0.5, 0.17), high ? 0.72 : 0.44),
        '--mn-body': rgbToHex(hsl(H, 0.24, high ? 0.92 : 0.87)),
        '--mn-narration': rgbToHex(hsl(H, 0.17, high ? 0.76 : 0.68)),
        ...accentTokens('--mn-', accent, accent2, text, ground),
    };
    return out;
}

// the accent pair and what derives from it, under a prefix: the palette's, or the tint's; readable on the lit night
function accentTokens(prefix, accent, accent2, text, ground) {
    const speech = readableAccent(mix(accent, text, 0.22), ground);
    return {
        [`${prefix}accent`]: rgbToHex(accent),
        [`${prefix}accent-rgb`]: rgbList(accent),
        [`${prefix}accent-2`]: rgbToHex(accent2),
        [`${prefix}accent-2-rgb`]: rgbList(accent2),
        [`${prefix}accent-hover`]: rgbToHex(mix(accent, WHITE, 0.2)),
        [`${prefix}accent-text`]: rgbToHex(textOn(accent)),
        [`${prefix}speech`]: rgbToHex(speech),
        [`${prefix}emphasis`]: rgbToHex(readableAccent(mix(accent2, text, 0.3), ground)),
    };
}

// ---- the character tint --------------------------------------------------------------------------

/**
 * A portrait's colour: the strongest hue among its vivid, mid-light pixels, averaged; null for a
 * portrait with no colour to speak of.
 * @param {ArrayLike<number>} data RGBA bytes
 */
export function dominantColor(data) {
    const BINS = 24;
    const weight = new Float64Array(BINS), sr = new Float64Array(BINS), sg = new Float64Array(BINS), sb = new Float64Array(BINS);
    let total = 0;
    for (let i = 0; i + 3 < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        const px = { r: data[i], g: data[i + 1], b: data[i + 2] };
        const { h, s, l } = rgbToHsl(px);
        const w = s * s * Math.max(0, 1 - Math.abs(l - 0.5) * 2);
        total += 1;
        if (w < 0.02) continue;
        const bin = Math.floor(h / (360 / BINS)) % BINS;
        weight[bin] += w;
        sr[bin] += px.r * w;
        sg[bin] += px.g * w;
        sb[bin] += px.b * w;
    }
    let best = null;
    for (let k = 0; k < BINS; k++) {
        const near = weight[k] + 0.5 * (weight[(k + 1) % BINS] + weight[(k + BINS - 1) % BINS]);
        if (!best || near > best.near) best = { k, near };
    }
    if (!total || best.near / total < 0.04 || !weight[best.k]) return null;
    const w = weight[best.k];
    return { r: sr[best.k] / w, g: sg[best.k] / w, b: sb[best.k] / w };
}

/**
 * The conversation's tint from a portrait colour: a vivid accent at AA on the lit night and under its
 * own text, with its partner.
 */
export function tintTokens(rgb, def) {
    const H = Number(def.hue) || 0;
    const high = def.contrast === 'high';
    const ground = litNight(whole(hsl(H, high ? 0.16 : 0.5, 0.045)));
    const accent = fillableAccent(rgb, ground, { minSat: 0.45, maxSat: 0.85 });
    const accent2 = fillableAccent(secondOf(accent), ground, { minSat: 0.4, maxSat: 0.85 });
    const text = hsl(H, high ? 0.3 : 0.42, high ? 0.97 : 0.93);
    return accentTokens('--mn-tint-', accent, accent2, text, ground);
}

// ---- the editor's draft ----------------------------------------------------------------------------

export const NAME_MAX = 40;
/** A palette's id as the server makes it. */
export const PALETTE_ID = /^p-[0-9a-f]{8}$/;
export const PALETTE_FIELDS = ['name', 'accent', 'hue', 'glow', 'sky'];
/** Each field's reader (the value kept, or null) and the rule a refusal names; the editor and the server both read these. */
export const FIELD_RULES = {
    name: {
        read: (v) => (typeof v === 'string' && v.trim() && v.trim().length <= NAME_MAX && !/[\u0000-\u001f\u007f]/.test(v) ? v.trim() : null),
        rule: `name is text of 1 to ${NAME_MAX} characters`,
    },
    accent: { read: (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null), rule: 'accent is a colour written #rrggbb' },
    hue: { read: (v) => (Number.isInteger(v) && v >= 0 && v <= 359 ? v : null), rule: 'hue is a whole number from 0 to 359' },
    glow: { read: (v) => (Number.isInteger(v) && v >= 0 && v <= 100 ? v : null), rule: 'glow is a whole number from 0 to 100' },
    sky: { read: (v) => (SKIES.includes(v) ? v : null), rule: `sky is one of ${SKIES.join(', ')}` },
};
/** A palette read field by field; null when a field breaks its rule. */
export function cleanPalette(p) {
    if (!p || typeof p !== 'object') return null;
    const out = {};
    for (const key of PALETTE_FIELDS) {
        const v = FIELD_RULES[key].read(p[key]);
        if (v === null) return null;
        out[key] = v;
    }
    return out;
}
