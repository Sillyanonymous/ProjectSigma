// Map styles: the presets, the reader's own style over one of them, and the checks an imported style passes.

export const FORMAT = 'sigma-chat-timeline-style';

/** The colours a style sets, in the order the editor lists them. */
export const COLOURS = [
    { key: 'char', label: 'Character' },
    { key: 'you', label: 'You' },
    { key: 'path', label: 'Your chat' },
    { key: 'line', label: 'Lines' },
    { key: 'bg', label: 'Background' },
    { key: 'card', label: 'Cards' },
    { key: 'ink', label: 'Text' },
];

export const PATTERNS = [
    { key: 'dots', label: 'Dots' },
    { key: 'grid', label: 'Grid' },
    { key: 'paper', label: 'Paper' },
    { key: 'stars', label: 'Stars' },
    { key: 'none', label: 'Plain' },
];

export const CORNERS = [
    { key: 'square', label: 'Square', px: 3 },
    { key: 'soft', label: 'Soft', px: 10 },
    { key: 'round', label: 'Round', px: 16 },
];

// the app's three font stacks; the sheet maps each key to its token
export const FONTS = [
    { key: 'ui', label: 'Sans' },
    { key: 'prose', label: 'Reading' },
    { key: 'mono', label: 'Mono' },
];

// App reads the app's own tokens, so every theme of the app gets a map that belongs to it
export const PRESETS = {
    app: {
        label: 'App',
        colours: {
            char: 'var(--accent)', you: '#5cc8a8', path: 'var(--accent)', line: 'color-mix(in srgb, var(--text-primary) 20%, transparent)',
            bg: 'var(--bg-primary)', card: 'color-mix(in srgb, var(--bg-secondary) 90%, var(--text-primary))', ink: 'var(--text-primary)',
        },
        pattern: 'dots', corners: 'soft', font: 'ui',
    },
    parchment: {
        label: 'Parchment',
        colours: { char: '#8a3b2a', you: '#2f5d50', path: '#b0422b', line: '#a68b68', bg: '#efe4cb', card: '#f8f1e0', ink: '#3b2a18' },
        pattern: 'paper', corners: 'square', font: 'prose',
    },
    blueprint: {
        label: 'Blueprint',
        colours: { char: '#8fd0ff', you: '#ffd58a', path: '#ffffff', line: '#5d86b0', bg: '#0f2f52', card: '#0c2642', ink: '#e6f2ff' },
        pattern: 'grid', corners: 'square', font: 'mono',
    },
    nebula: {
        label: 'Nebula',
        colours: { char: '#7c9cff', you: '#6af2c0', path: '#ffcf5c', line: '#3a4060', bg: '#07080f', card: '#121626', ink: '#e9ecf6' },
        pattern: 'stars', corners: 'round', font: 'ui',
    },
    daylight: {
        label: 'Daylight',
        colours: { char: '#4f6bed', you: '#1f9d7a', path: '#4f6bed', line: '#b4bac8', bg: '#f4f5f8', card: '#ffffff', ink: '#1d2433' },
        pattern: 'dots', corners: 'soft', font: 'ui',
    },
};

export const DEFAULT_PRESET = 'app';
export const OWN = 'own';

const HEX = /^#[0-9a-f]{6}$/i;
const keysOf = (list) => list.map(x => x.key);

/**
 * The reader's own style as stored or imported, every value checked; null when it is not one.
 * @returns {{ base: string, colours: Record<string, string>, pattern: string, corners: string, font: string } | null}
 */
export function normalizeOwn(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const base = Object.hasOwn(PRESETS, raw.base) ? raw.base : DEFAULT_PRESET;
    const colours = {};
    for (const { key } of COLOURS) {
        const v = raw.colours?.[key];
        if (typeof v !== 'string' || !HEX.test(v)) return null;
        colours[key] = v.toLowerCase();
    }
    const pick = (value, list) => (keysOf(list).includes(value) ? value : null);
    const pattern = pick(raw.pattern, PATTERNS), corners = pick(raw.corners, CORNERS), font = pick(raw.font, FONTS);
    if (!pattern || !corners || !font) return null;
    return { base, colours, pattern, corners, font };
}

/** The style a reader's choice resolves to: a preset by id, or their own; anything unknown is the default. */
export function resolveStyle(choice, own) {
    if (choice === OWN) {
        const mine = normalizeOwn(own);
        if (mine) return { id: OWN, label: 'Your Own', ...mine };
    }
    const id = Object.hasOwn(PRESETS, choice) ? choice : DEFAULT_PRESET;
    const p = PRESETS[id];
    return { id, label: p.label, colours: { ...p.colours }, pattern: p.pattern, corners: p.corners, font: p.font };
}

/** A style's custom properties on the map's root, its pattern and type as attributes the sheet reads. */
export function applyStyle(root, style) {
    for (const { key } of COLOURS) root.style.setProperty(`--ctl-${key}`, style.colours[key]);
    root.style.setProperty('--ctl-radius', `${CORNERS.find(c => c.key === style.corners).px}px`);
    root.setAttribute('data-pattern', style.pattern);
    root.setAttribute('data-font', style.font);
    root.setAttribute('data-style', style.id);
}

/** The file an export writes. */
export function exportOwn(own, name = 'My map style') {
    return JSON.stringify({ format: FORMAT, version: 1, name: String(name).slice(0, 60), style: normalizeOwn(own) }, null, 2);
}

/** An imported file read back to a style, or an Error naming why it is not one. */
export function parseImport(text) {
    let doc;
    try { doc = JSON.parse(String(text)); } catch { return new Error('That file is not JSON.'); }
    if (doc?.format !== FORMAT) return new Error('That file is not a chat timeline style.');
    const own = normalizeOwn(doc.style);
    return own || new Error('That style has a value this version cannot use.');
}

/** A colour as the browser computes it (#hex, rgb(), rgba(), color(srgb ...)) as channels 0-255 and alpha 0-1; null when it is none. */
export function parseColour(computed) {
    const s = String(computed || '').trim();
    if (HEX.test(s)) return { r: parseInt(s.slice(1, 3), 16), g: parseInt(s.slice(3, 5), 16), b: parseInt(s.slice(5, 7), 16), a: 1 };
    let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(s);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: alphaOf(m[4]) };
    m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i.exec(s);
    if (m) return { r: m[1] * 255, g: m[2] * 255, b: m[3] * 255, a: alphaOf(m[4]) };
    return null;
}

const alphaOf = (raw) => (raw === undefined ? 1 : raw.endsWith('%') ? parseFloat(raw) / 100 : +raw);

/** A computed colour as #rrggbb, a see-through one laid over the colour under it, as the eye sees it; null when it is none. */
export function hexOf(computed, under = null) {
    const c = parseColour(computed);
    if (!c) return null;
    const u = parseColour(under) || { r: 0, g: 0, b: 0 };
    const mix = (k) => Math.round(Math.max(0, Math.min(255, c[k] * c.a + u[k] * (1 - c.a))));
    return `#${['r', 'g', 'b'].map(k => mix(k).toString(16).padStart(2, '0')).join('')}`;
}
