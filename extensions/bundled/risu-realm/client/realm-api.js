// The Realm's endpoints and shapes. The hub answers any origin, so the page reads it; the download is
// the server half's.
import { fetchWithProxy, readJsonClassified } from '/modules/providers/provider-utils.js';
import { realmIdOf } from './realm-id.js';

const REALM_SITE = 'https://realm.risuai.net';
const REALM_HUB = 'https://sv.risuai.xyz';

// a listing page, and the sorts as the hub honours them (it answers an unknown one newest first)
const REALM_PAGE = 30;
export const REALM_SORTS = Object.freeze([
    { value: '', label: 'Latest' },
    { value: 'recommended', label: 'Recommended' },
    { value: 'trending', label: 'Trending' },
    { value: 'downloads', label: 'Most Downloaded' },
    { value: 'random', label: 'Random' },
]);

export function realmCharacterUrl(id) {
    return `${REALM_SITE}/character/${id}`;
}

// a picture is addressed by its hash: one hash, one immutable JPEG
export function realmPictureUrl(hash) {
    return /^[0-9a-f]{64}$/.test(String(hash ?? '')) ? `${REALM_HUB}/resource/${hash}` : null;
}

// the Realm answers its counts written for reading ("24.6k", "855k", "532")
export function realmCount(text) {
    const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(String(text ?? '').trim());
    if (!m) return null;
    return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1));
}

/**
 * A Realm listing row (hub/info's, the search's), as the provider reads it; null without an id.
 * @param {Object} raw
 * @returns {{id: string, name: string, tags: string[], img: string|null, author: string, downloads: number|null, desc: string, date: number|null, license: string}|null}
 */
export function normalizeRealmRow(raw) {
    const id = realmIdOf(raw?.id);
    if (!id) return null;
    return {
        id,
        name: String(raw.name ?? '').trim(),
        tags: Array.isArray(raw.tags) ? [...new Set(raw.tags.map(t => String(t ?? '').trim()).filter(Boolean))] : [],
        img: typeof raw.img === 'string' && raw.img ? raw.img : null,
        author: String(raw.authorname ?? '').trim(),
        downloads: realmCount(raw.download),
        desc: typeof raw.desc === 'string' ? raw.desc : '',
        // the hub counts time in minutes since the epoch
        date: Number.isFinite(raw.date) && raw.date > 0 ? raw.date * 60000 : null,
        license: String(raw.license ?? '').trim(),
    };
}

// the hub reads its query as key==value pairs joined by &&, so a search can carry neither
function realmQuery({ search = '', page = 0, nsfw = false, sort = '' }) {
    const text = String(search ?? '').replace(/&&|==/g, ' ').replace(/\s+/g, ' ').trim();
    const known = REALM_SORTS.some(s => s.value === sort) ? sort : '';
    return `search==${text}&&page==${Math.max(0, Math.floor(Number(page) || 0))}&&nsfw==${nsfw ? 'true' : 'false'}&&sort==${known}&&web==web`;
}

export function realmSearchUrl(opts = {}) {
    return `${REALM_HUB}/realm/${encodeURIComponent(realmQuery(opts))}`;
}

/**
 * One page of the Realm's listing from page 0; Recommended is one page (the hub refuses a second).
 * @param {{search?: string, page?: number, nsfw?: boolean, sort?: string}} opts
 * @returns {Promise<{rows: Object[], hasMore: boolean}>}
 */
export async function searchRealm(opts = {}, { signal = null } = {}) {
    const resp = await fetchWithProxy(realmSearchUrl(opts), signal ? { signal } : {});
    const body = await readJsonClassified(resp);
    const cards = Array.isArray(body?.cards) ? body.cards : [];
    return { rows: cards.map(normalizeRealmRow).filter(Boolean), hasMore: opts.sort !== 'recommended' && cards.length >= REALM_PAGE };
}

// a search mixing words with tag: terms, which the hub answers with nothing
export function realmQueryMixes(search) {
    const terms = String(search ?? '').trim().split(/\s+/).filter(Boolean);
    return terms.some(t => /^tag:/i.test(t)) && terms.some(t => !/^tag:/i.test(t));
}

/**
 * A listing's description split by its "# `en`" language headings; text before any heading has none.
 * @param {string} desc
 * @returns {{lang: string|null, text: string}[]}
 */
export function realmDescSections(desc) {
    const text = String(desc ?? '');
    const head = /^#[ \t]*`([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)?)`[ \t]*$/gm;
    const sections = [];
    const add = (lang, body) => {
        const trimmed = body.trim();
        if (!trimmed) return;
        const same = sections.find(s => s.lang === lang);
        if (same) same.text += `\n\n${trimmed}`;
        else sections.push({ lang, text: trimmed });
    };
    let lang = null, from = 0, m;
    while ((m = head.exec(text))) {
        add(lang, text.slice(from, m.index));
        lang = m[1].toLowerCase();
        from = head.lastIndex;
    }
    add(lang, text.slice(from));
    return sections;
}

/** The section a reader of these languages reads first: theirs, else English, else the first. */
export function pickRealmSection(sections, languages = []) {
    for (const wanted of languages.map(l => String(l).toLowerCase().split('-')[0])) {
        const hit = sections.find(s => s.lang && s.lang.split('-')[0] === wanted);
        if (hit) return hit;
    }
    return sections.find(s => s.lang === 'en') || sections[0] || null;
}

/**
 * One character's listing. A character the Realm does not know throws with status 404 (the
 * remote-card vocabulary's miss); anything else it cannot answer throws classified.
 * @param {string} id - a Realm character id
 * @param {{signal?: AbortSignal}} [opts]
 */
export async function fetchRealmInfo(id, { signal = null } = {}) {
    const resp = await fetchWithProxy(`${REALM_HUB}/hub/info/${id}`, signal ? { signal } : {});
    return normalizeRealmRow(await readJsonClassified(resp));
}
