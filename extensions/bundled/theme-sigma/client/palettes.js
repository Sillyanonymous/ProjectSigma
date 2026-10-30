// Σ's palettes: the five it ships and what a palette writes. Pure, no DOM.

export const BUILT_IN = [
    { id: 'sigma', name: 'Σ', note: 'Blue and indigo', accent: '#4a9eff', accent2: '#5550f0', hue: 222, glow: 40 },
    { id: 'iris', name: 'Iris', note: 'Violet and rose', accent: '#9d8cf2', accent2: '#d77fb6', hue: 258, glow: 40 },
    { id: 'lagoon', name: 'Lagoon', note: 'Teal and blue', accent: '#45c4b0', accent2: '#4b8fe0', hue: 196, glow: 35 },
    { id: 'amber', name: 'Amber', note: 'Amber and coral', accent: '#f0b057', accent2: '#e2735f', hue: 24, glow: 35 },
    { id: 'graphite', name: 'Graphite', note: 'High contrast', accent: '#d6dae2', accent2: '#8d95a3', hue: 220, glow: 12, contrast: 'high' },
];

export const builtIn = (id) => BUILT_IN.find(p => p.id === id) || null;

/**
 * What a palette setting names: a built-in id, or 'own:<id>'.
 * @returns {{ kind: 'built-in' | 'own', id: string } | null}
 */
export function parseChoice(value) {
    const v = String(value ?? '');
    if (builtIn(v)) return { kind: 'built-in', id: v };
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
/** The APCA floor a fill holds for its text, beside AA. */
export const LC = 60;
export const INK = { r: 6, g: 8, b: 12 };
export const WHITE = { r: 255, g: 255, b: 255 };

/** The text a colour carries: white or ink, whichever the eye reads better (APCA; the WCAG ratio picks muddy ink on mid tones). */
export const textOn = (rgb) => (apca(WHITE, rgb) >= apca(INK, rgb) ? WHITE : INK);

/** The conversation's layers over the field, in the ink's colour: backdrop, open column veil, panels veil (as the sheet paints them). */
export const VEIL = { backdrop: 0.42, column: 0.86, panels: 0.3 };
const over = (ground, c, a) => mix(ground, c, a);

/** The plates a message sits on, the character's and yours: a colour and its alpha. */
export function platesOf(hue, high = false) {
    const S = inkSat(high);
    return {
        char: { rgb: hsl(hue, S, step(high, 'plate')), a: high ? 0.97 : 0.94 },
        user: { rgb: hsl(hue, S, step(high, 'plateUser')), a: high ? 0.95 : 0.92 },
    };
}

// graphite with a trace of the palette's hue: the colour is the accent's to carry, never the surfaces'
const inkSat = (high) => (high ? 0.015 : 0.03);

/** The ladder's lightness, each step far enough above the last to read at a glance: [normal, high contrast]. */
export const LADDER = {
    ink: [0.11, 0.095],
    deep: [0.15, 0.135],
    slab: [0.155, 0.14],
    card: [0.165, 0.15],
    plate: [0.15, 0.135],
    field: [0.175, 0.16],
    plateUser: [0.175, 0.16],
    control: [0.225, 0.21],
    controlHover: [0.265, 0.25],
    thumb: [0.3, 0.29],
};
const step = (high, name) => LADDER[name][high ? 1 : 0];
/** A palette's ground. */
export const inkOf = (hue, high = false) => whole(hsl(hue, inkSat(high), step(high, 'ink')));

/** The brightest ground a reply's text meets: a white field through the backdrop, then the open column's veil or a plate. */
export function litInk(ink, plates = null) {
    const seen = over(WHITE, ink, VEIL.backdrop);
    const grounds = [over(seen, ink, VEIL.column), ...(plates ? [plates.char, plates.user] : []).map(p => over(over(seen, ink, VEIL.panels), p.rgb, p.a))];
    return whole(grounds.reduce((a, b) => (luminance(b) > luminance(a) ? b : a)));
}

/** An accent readable as text on a ground and light enough to carry ink, at AA: lightened along its hue until both hold. */
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

// a fill moved along its hue until its text clears AA and the APCA floor: deeper under white, lighter under ink
function settle(rgb, text) {
    const c = rgbToHsl(rgb);
    const step = text === WHITE ? -0.01 : 0.01;
    let l = c.l;
    let out = whole(rgb);
    for (let i = 0; i < 100 && (contrast(out, text) < AA || apca(text, out) < LC); i++) {
        l = clamp(l + step, 0.02, 0.98);
        out = whole(hsl(c.h, c.s, l));
    }
    return out;
}

/** The primary verb's fill and its text: the text the eye prefers on the painted stop, both stops settled under it. */
export function fillOf(a, b) {
    const text = textOn(whole(a));
    return { a: settle(a, text), b: settle(b, text), text };
}

/**
 * Everything a palette writes as --sx-* properties: the ink, its two colours, readable accents, fill, pools, plates and voices.
 * @param {{ accent: string, accent2?: string, hue: number, glow: number, contrast?: string }} def
 */
export function tokensOf(def) {
    const H = Number(def.hue) || 0;
    const high = def.contrast === 'high';
    const S = inkSat(high);
    const g = clamp(Number(def.glow) / 100, 0, 1);
    const ink = inkOf(H, high);
    const plates = platesOf(H, high);
    const ground = litInk(ink, plates);
    const raw1 = hexToRgb(def.accent) || hexToRgb('#4a9eff');
    const raw2 = hexToRgb(def.accent2 || '') || secondOf(raw1);
    const raw3 = glintOf(raw2);
    const text = hsl(H, 0.04, high ? 0.97 : 0.94);
    const light = hsl(H, 0.04, 0.92);
    const shadow = hsl(H, 0.1, 0.02);
    const fill = fillOf(raw1, raw2);
    const layer = (name) => hsl(H, S, step(high, name));
    return {
        '--sx-hue': String(H),
        '--sx-glow': String(+g.toFixed(2)),
        '--sx-ink': rgbToHex(ink),
        '--sx-ink-rgb': rgbList(ink),
        '--sx-deep': rgbToHex(layer('deep')),
        '--sx-deep-rgb': rgbList(layer('deep')),
        '--sx-card': rgba(layer('card'), high ? 0.96 : 0.92),
        '--sx-slab': rgba(layer('slab'), high ? 0.98 : 0.95),
        '--sx-slab-strong': rgba(layer('slab'), 0.985),
        '--sx-slab-solid': rgbToHex(layer('slab')),
        '--sx-field-bg': rgbToHex(layer('field')),
        '--sx-control': rgbToHex(layer('control')),
        '--sx-control-hover': rgbToHex(layer('controlHover')),
        '--sx-thumb': rgbToHex(layer('thumb')),
        '--sx-raise': rgba(light, high ? 0.08 : 0.055),
        '--sx-raise-2': rgba(light, high ? 0.13 : 0.095),
        '--sx-line': rgba(light, high ? 0.15 : 0.1),
        '--sx-line-strong': rgba(light, high ? 0.22 : 0.16),
        '--sx-text': rgbToHex(text),
        '--sx-text-rgb': rgbList(text),
        '--sx-text-2': rgbToHex(hsl(H, 0.03, high ? 0.8 : 0.72)),
        '--sx-text-3': rgbToHex(hsl(H, 0.03, high ? 0.7 : 0.62)),
        '--sx-text-4': rgbToHex(hsl(H, 0.03, high ? 0.64 : 0.56)),
        '--sx-shadow-rgb': rgbList(shadow),
        '--sx-g1': rgbToHex(raw1),
        '--sx-g1-rgb': rgbList(raw1),
        '--sx-g2': rgbToHex(raw2),
        '--sx-g2-rgb': rgbList(raw2),
        '--sx-g3': rgbToHex(raw3),
        '--sx-g3-rgb': rgbList(raw3),
        '--sx-fill-1': rgbToHex(fill.a),
        '--sx-fill-2': rgbToHex(fill.b),
        '--sx-fill-text': rgbToHex(fill.text),
        '--sx-pool-a': rgba(raw1, 0.025 + 0.06 * g),
        '--sx-pool-b': rgba(raw2, 0.025 + 0.06 * g),
        '--sx-pool-c': rgba(raw3, 0.01 + 0.03 * g),
        '--sx-plate-char': rgba(plates.char.rgb, plates.char.a),
        '--sx-plate-user': rgba(plates.user.rgb, plates.user.a),
        '--sx-body': rgbToHex(hsl(H, 0.03, high ? 0.93 : 0.88)),
        '--sx-narration': rgbToHex(hsl(H, 0.03, high ? 0.8 : 0.72)),
        ...accentTokens('--sx-', raw1, raw2, text, ground),
    };
}

// the second stop when a palette names none: a twelfth of the wheel on, a touch deeper
function secondOf(rgb) {
    const c = rgbToHsl(rgb);
    return hsl(c.h + 30, Math.min(1, c.s * 0.95), Math.max(0, c.l * 0.85));
}

// the glint the gradient ends on: the second stop turned on toward violet, bright
function glintOf(rgb) {
    const c = rgbToHsl(rgb);
    return hsl(c.h + 24, Math.min(1, Math.max(0.6, c.s)), clamp(c.l + 0.08, 0.55, 0.75));
}

// the readable accent pair and what derives from it, under a prefix: the palette's, or the tint's
function accentTokens(prefix, raw1, raw2, text, ground) {
    const accent = readableAccent(raw1, ground);
    const accent2 = readableAccent(raw2, ground);
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
 * The conversation's tint from a portrait colour: a vivid pair readable on the lit ink, and the raw
 * stops its edges and glow draw with.
 */
export function tintTokens(rgb, def) {
    const H = Number(def.hue) || 0;
    const high = def.contrast === 'high';
    const ground = litInk(inkOf(H, high), platesOf(H, high));
    const c = rgbToHsl(rgb);
    const raw1 = whole(hsl(c.h, clamp(c.s, 0.5, 0.9), clamp(c.l, 0.5, 0.66)));
    const raw2 = whole(hsl(c.h + 28, clamp(c.s, 0.5, 0.9), clamp(c.l - 0.06, 0.42, 0.6)));
    const text = hsl(H, 0.04, high ? 0.97 : 0.94);
    return {
        '--sx-tint-g1': rgbToHex(raw1),
        '--sx-tint-g1-rgb': rgbList(raw1),
        '--sx-tint-g2': rgbToHex(raw2),
        '--sx-tint-g2-rgb': rgbList(raw2),
        ...accentTokens('--sx-tint-', raw1, raw2, text, ground),
    };
}

// ---- the editor's draft ----------------------------------------------------------------------------

export const NAME_MAX = 40;
/** A palette's id as the server makes it. */
export const PALETTE_ID = /^p-[0-9a-f]{8}$/;
export const PALETTE_FIELDS = ['name', 'accent', 'accent2', 'hue', 'glow'];
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;
/** Each field's reader (the value kept, or null) and the rule a refusal names; the editor and the server both read these. */
export const FIELD_RULES = {
    name: {
        read: (v) => (typeof v === 'string' && v.trim() && v.trim().length <= NAME_MAX && !/[\u0000-\u001f\u007f]/.test(v) ? v.trim() : null),
        rule: `name is text of 1 to ${NAME_MAX} characters`,
    },
    accent: { read: (v) => (typeof v === 'string' && HEX_COLOUR.test(v) ? v.toLowerCase() : null), rule: 'accent is a colour written #rrggbb' },
    accent2: { read: (v) => (typeof v === 'string' && HEX_COLOUR.test(v) ? v.toLowerCase() : null), rule: 'accent2 is a colour written #rrggbb' },
    hue: { read: (v) => (Number.isInteger(v) && v >= 0 && v <= 359 ? v : null), rule: 'hue is a whole number from 0 to 359' },
    glow: { read: (v) => (Number.isInteger(v) && v >= 0 && v <= 100 ? v : null), rule: 'glow is a whole number from 0 to 100' },
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
