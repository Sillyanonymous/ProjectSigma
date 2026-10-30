// Wyvern's lorebook adapter (data and fetch only): the anonymous explore listing, every row carrying its entries inline
import { WYVERN_API_BASE, WYVERN_SITE_BASE, getWyvernHeaders, getAvatarUrl, convertWyvernLorebook } from './wyvern-api.js';
import { fetchWithProxy, readJsonClassified, finiteOrNull } from '../provider-utils.js';
import { browseCardImageWidth } from '../browse-view.js';


/** One explore row as the shared view reads it. */
export function normalizeWyvernLorebook(row) {
    const id = String(row?.id || row?._id || '');
    const entries = Array.isArray(row?.entries) ? row.entries : (row?.entries && typeof row.entries === 'object' ? Object.values(row.entries) : []);
    const creator = row?.creator || {};
    return {
        id,
        key: id,
        name: row?.name || 'Untitled',
        creator: creator.displayName || creator.username || '',
        description: row?.description || '',
        tagline: '',
        cover: row?.photoURL ? getAvatarUrl({ avatar_url: row.photoURL }, { width: browseCardImageWidth() }) : '',
        entryCount: entries.length,
        tokenEstimate: null,
        wordCount: null,
        tags: Array.isArray(row?.tags) ? row.tags : [],
        nsfw: !!row?.rating && row.rating !== 'none',
        createdAt: row?.created_at || null,
        stats: { favorites: Number(row?.entity_statistics?.likes ?? row?.entity_statistics?.votes) || null },
        url: id ? `${WYVERN_SITE_BASE}/lorebooks/${id}` : null,
        path: null,
        raw: row,
    };
}

export const wyvernLorebooks = {
    sortOptions: [
        { value: 'votes', label: 'Most Likes' },
        { value: 'created_at', label: 'Newest' },
        { value: 'name', label: 'Name' },
    ],
    defaultSort: 'votes',
    nsfw: null,

    async fetchPage({ query = '', sort = 'votes', page = 1, limit = 48, signal } = {}) {
        const qs = new URLSearchParams({ page: String(page), limit: String(limit), sort, order: sort === 'name' ? 'asc' : 'desc' });
        if (query) qs.set('q', query);
        const resp = await fetchWithProxy(`${WYVERN_API_BASE}/exploreSearch/lorebooks?${qs}`, { headers: getWyvernHeaders(false), signal });
        const data = await readJsonClassified(resp);
        const rows = Array.isArray(data?.results) ? data.results : [];
        return { hits: rows.map(normalizeWyvernLorebook), hasMore: !!data?.hasMore, total: finiteOrNull(data?.total) };
    },

    // the entries ride the listing row: the converter that already builds a character's book
    // from wyvern's lorebook objects takes this one
    async fetchBook(hit) {
        const book = convertWyvernLorebook([hit.raw]);
        if (!book) throw new Error('this lorebook carries no entries');
        return { book, name: hit.name };
    },
};
