import path from 'node:path';
import { readZipIndex, readZipEntryAsync, checkArchive, ZIP_IMPORT_LIMITS } from './zip.js';
import { httpError } from './http-error.js';

// Character Card V3's zip container. embeded:// is the spec's spelling; a RisuAI download may put a JPEG ahead of the zip

const EMBEDDED = 'embeded://';

/**
 * Open a charx on disk: null when no zip or no root card.json, 422 when card.json is not JSON.
 * @param {string} file
 * @returns {Promise<{ file: string, entries: Map<string, object>, card: object } | null>}
 */
export async function openCharx(file) {
    let index;
    try { index = readZipIndex(file); } catch { return null; }
    const entries = new Map(index.map(e => [e.name, e]));
    const cardEntry = entries.get('card.json');
    if (!cardEntry) return null;
    // the card is text, every other member a file the import would keep
    checkArchive(file, index, (name) => (name === 'card.json' ? ZIP_IMPORT_LIMITS.json : ZIP_IMPORT_LIMITS.media));
    const bytes = await readZipEntryAsync(file, cardEntry, { max: ZIP_IMPORT_LIMITS.json });
    let card;
    try { card = JSON.parse(bytes.toString('utf8')); }
    catch (e) { throw httpError(422, `card.json is not readable JSON: ${e.message}`); }
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
        throw httpError(422, 'card.json holds no card object');
    }
    return { file, entries, card };
}

/**
 * The files the card names inside the container, in card order; a path the zip lacks is left out.
 * @returns {{ type: string, name: string, ext: string, entry: object }[]}
 */
export function charxAssets(charx) {
    const list = Array.isArray(charx.card?.data?.assets) ? charx.card.data.assets : [];
    const out = [];
    for (const a of list) {
        if (typeof a?.uri !== 'string' || !a.uri.startsWith(EMBEDDED)) continue;
        const entry = charx.entries.get(a.uri.slice(EMBEDDED.length));
        if (!entry) continue;
        out.push({ type: String(a.type ?? ''), name: String(a.name ?? ''), ext: String(a.ext ?? ''), entry });
    }
    return out;
}

/** The container's picture: the icon named main, else its first icon; null when it has none. */
export function charxIcon(assets) {
    return assets.find(a => a.type === 'icon' && a.name === 'main') || assets.find(a => a.type === 'icon') || null;
}

/** An asset's gallery name: its name with its ext, the ext never doubled (RisuAI's names carry it). */
export function charxMediaName(asset) {
    const fileName = path.posix.basename(asset.entry.name);
    const ext = (asset.ext || path.posix.extname(fileName).slice(1)).replace(/^\./, '').toLowerCase();
    const name = asset.name || fileName.slice(0, fileName.length - path.posix.extname(fileName).length);
    if (!ext || name.toLowerCase().endsWith(`.${ext}`)) return name || fileName;
    return `${name}.${ext}`;
}

/**
 * data.assets as the library keeps it: the main icon becomes ccdefault:, other embedded entries go (they are gallery rows).
 */
export function storedAssets(assets) {
    if (!Array.isArray(assets)) return assets;
    const out = [];
    for (const a of assets) {
        if (typeof a?.uri === 'string' && a.uri.startsWith(EMBEDDED)) {
            if (a.type === 'icon' && a.name === 'main') out.push({ ...a, uri: 'ccdefault:', ext: 'png' });
            continue;
        }
        out.push(a);
    }
    return out;
}
