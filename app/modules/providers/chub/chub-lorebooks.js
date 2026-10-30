// Chub's lorebook adapter (data and fetch only)
import { CHUB_API_BASE, getChubHeaders, extractNodes, fetchChubLorebookBook } from './chub-api.js';
import { fetchWithProxy, readJsonClassified, finiteOrNull, pageHasMore } from '../provider-utils.js';

const CHUB_SITE_BASE = 'https://chub.ai';

/** One search node as the shared view reads it; key is the lowercased path, the link-row rule. */
export function normalizeChubLorebook(node) {
    const fullPath = String(node?.fullPath || '');
    const segments = fullPath.split('/');
    const creator = segments.length >= 3 ? segments[1] : (segments[0] || '');
    const book = node?.definition?.embedded_lorebook;
    return {
        id: String(node?.id ?? ''),
        key: fullPath.toLowerCase(),
        name: node?.name || 'Untitled',
        creator,
        description: node?.description || '',
        tagline: node?.tagline || '',
        cover: node?.avatar_url || '',
        entryCount: Array.isArray(book?.entries) ? book.entries.length : null,
        tokenEstimate: finiteOrNull(node?.nTokens),
        wordCount: null,
        tags: Array.isArray(node?.topics) ? node.topics : [],
        nsfw: !!node?.nsfw_image || String(node?.rating || '').toUpperCase() === 'NSFW',
        createdAt: node?.createdAt || null,
        stats: {
            favorites: finiteOrNull(node?.n_favorites),
            stars: finiteOrNull(node?.starCount),
        },
        url: fullPath ? `${CHUB_SITE_BASE}/${fullPath}` : null,
        path: fullPath || null,
        raw: node,
    };
}

export const chubLorebooks = {
    sortOptions: [
        { value: 'download_count', label: 'Most Downloads' },
        { value: 'star_count', label: 'Most Stars' },
        { value: 'last_activity_at', label: 'Recently Updated' },
    ],
    defaultSort: 'download_count',
    nsfw: { setting: 'chubNsfw' },

    async fetchPage({ query = '', sort = 'download_count', nsfw = false, page = 1, limit = 48, signal } = {}) {
        const qs = new URLSearchParams({ namespace: 'lorebooks', first: String(limit), page: String(page), sort, nsfw: nsfw ? 'true' : 'false', include_forks: 'true' });
        if (query) qs.set('search', query);
        const resp = await fetchWithProxy(`${CHUB_API_BASE}/search?${qs}`, { headers: getChubHeaders(true), signal });
        const data = await readJsonClassified(resp);
        const nodes = extractNodes(data);
        const total = finiteOrNull(data?.data?.count) ?? finiteOrNull(data?.count);
        return { hits: nodes.map(normalizeChubLorebook), hasMore: pageHasMore(total, page * limit, nodes.length, limit), total };
    },

    async fetchBook(hit) {
        let book = hit.raw?.definition?.embedded_lorebook;
        if (!Array.isArray(book?.entries)) book = await fetchChubLorebookBook(hit.path);
        if (!Array.isArray(book?.entries)) throw new Error('this lorebook carries no entries');
        return { book: { ...book, name: book.name || hit.name }, name: book.name || hit.name };
    },
};
