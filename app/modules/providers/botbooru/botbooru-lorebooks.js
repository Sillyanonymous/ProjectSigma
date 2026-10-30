// Botbooru's lorebook adapter (data and fetch only): the proxy every botbooru request rides, the detail fetched by NUMBER
import { BOTBOORU_BASE, fetchWithProxy, getBotbooruHeaders, getBotbooruPreviewUrl } from './botbooru-api.js';
import { ensureNsfwAccountFlags } from './botbooru-browse.js';
import { readJsonClassified, finiteOrNull, pageHasMore } from '../provider-utils.js';
import { browseCardImageWidth } from '../browse-view.js';


/** One listing row as the shared view reads it. */
export function normalizeBotbooruLorebook(row) {
    const id = String(row?.id ?? '');
    const number = row?.number ?? null;
    return {
        id,
        key: id,
        number,
        name: row?.title || 'Untitled',
        creator: row?.uploader_username || '',
        description: row?.first_entry_snippet || '',
        tagline: row?.tagline || '',
        cover: row?.cover_image_filename ? getBotbooruPreviewUrl(row.cover_image_filename, 1, browseCardImageWidth() < 480 ? 320 : 480) : '',
        entryCount: finiteOrNull(row?.entry_count),
        tokenEstimate: finiteOrNull(row?.token_estimate),
        wordCount: null,
        tags: Array.isArray(row?.top_keys) ? row.top_keys : [],
        nsfw: !!row?.content_rating && String(row.content_rating).toLowerCase() !== 'sfw',
        createdAt: row?.created_at || null,
        stats: { favorites: finiteOrNull(row?.favorite_count), downloads: finiteOrNull(row?.downloads) },
        url: id ? `${BOTBOORU_BASE}/lorebook/${id}` : null,
        path: null,
        raw: row,
    };
}

/** The detail's normalized entries as a V2 character_book (the fallback when the original file is not a book). */
export function bookFromBotbooruEntries(detail) {
    const entries = Array.isArray(detail?.entries) ? detail.entries : [];
    return {
        name: detail?.title || '',
        description: detail?.description || '',
        scan_depth: Number(detail?.scan_depth) || undefined,
        token_budget: Number(detail?.token_budget) || undefined,
        recursive_scanning: !!detail?.recursive_scanning,
        entries: entries.map((e, i) => ({
            id: i,
            keys: Array.isArray(e?.keys) ? e.keys : [],
            secondary_keys: Array.isArray(e?.secondary_keys) ? e.secondary_keys : [],
            content: e?.content || '',
            comment: e?.name || '',
            enabled: e?.enabled !== false,
            constant: !!e?.constant,
            insertion_order: finiteOrNull(e?.order) ?? 100,
            position: 'before_char',
            extensions: {},
        })),
    };
}

export const botbooruLorebooks = {
    sortOptions: [
        { value: 'latest', label: 'Latest' },
        { value: 'downloads', label: 'Most Downloads' },
        { value: 'favorites', label: 'Most Favorites' },
    ],
    defaultSort: 'latest',
    // the character view's rule: the token first, the account's NSFW flags synced once, then the setting
    nsfw: { setting: 'botbooruNsfw', requires: 'botbooruToken', requiresMessage: 'NSFW browsing requires a Botbooru login', beforeEnable: ensureNsfwAccountFlags },

    async fetchPage({ query = '', sort = 'latest', nsfw = false, page = 1, limit = 48, signal } = {}) {
        const qs = new URLSearchParams({ sort, limit: String(limit), offset: String(Math.max(0, (page - 1) * limit)) });
        if (query) qs.set('q', query);
        if (!nsfw) qs.set('sfw_only', 'true');
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/api/lorebooks?${qs}`, { headers: getBotbooruHeaders(true), signal });
        const data = await readJsonClassified(resp);
        const rows = Array.isArray(data?.items) ? data.items : [];
        const total = finiteOrNull(data?.total);
        const offset = finiteOrNull(data?.offset) ?? (page - 1) * limit;
        return { hits: rows.map(normalizeBotbooruLorebook), hasMore: pageHasMore(total, offset + rows.length, rows.length, limit), total };
    },

    // the original file when it parses as a book (it keeps every advanced field), the
    // normalized entries otherwise
    async fetchBook(hit) {
        if (hit.number == null) throw new Error('this lorebook has no detail number');
        const resp = await fetchWithProxy(`${BOTBOORU_BASE}/api/lorebooks/${encodeURIComponent(hit.number)}`, { headers: getBotbooruHeaders(true) });
        const detail = await readJsonClassified(resp);
        const original = parseOriginal(detail?.lorebook_json);
        if (original?.world) return { world: original.world, name: detail?.title || hit.name };
        if (original?.book) return { book: original.book, name: detail?.title || hit.name };
        return { book: bookFromBotbooruEntries(detail), name: detail?.title || hit.name };
    },
};

// the uploader's own file: a native world (entries object) or a V2 book (entries array), else not a book
function parseOriginal(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    let doc;
    try { doc = JSON.parse(text); } catch { return null; }
    if (!doc || typeof doc !== 'object') return null;
    const book = doc.character_book || doc.data?.character_book || doc;
    if (Array.isArray(book?.entries) && book.entries.length) return { book };
    if (doc.entries && typeof doc.entries === 'object' && !Array.isArray(doc.entries) && Object.keys(doc.entries).length) return { world: doc };
    return null;
}
