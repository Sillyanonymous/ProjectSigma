/**
 * Civitai gallery extractor: posts and images, asked of civitai.com AND civitai.red and merged (each hides some).
 * Pattern: https://civitai.{com,red}/{posts,images}/{id}
 */

import { registerExtractor } from './extractor-registry.js';
import CoreAPI from '../core-api.js';
import { fetchWithProxy } from '../providers/provider-utils.js';

const CIVITAI_PATTERNS = [
    /civitai\.(?:com|red)\/posts\/\d+/i,
    /civitai\.(?:com|red)\/images\/\d+/i,
];

const POST_URL_RE = /^\/posts\/(\d+)/i;
const IMAGE_URL_RE = /^\/images\/(\d+)/i;
const CDN_URL_RE = /https:\/\/image\.civitai\.com\/[^\s"'<>)]+/gi;

const REQUEST_DELAY_MS = 300;
const PER_POST_LIMIT = 200;
const CL_HELPER_BASE = '/provider-services';

const _apiRequest = (...args) => CoreAPI.apiRequest(...args);

let _civitaiAuthActive = null;
let _civitaiAuthCheckedAt = 0;
const AUTH_CACHE_MS = 60000;

async function isCivitaiAuthActive() {
    const now = Date.now();
    if (_civitaiAuthActive !== null && now - _civitaiAuthCheckedAt < AUTH_CACHE_MS) {
        return _civitaiAuthActive;
    }
    try {
        const resp = await _apiRequest(`${CL_HELPER_BASE}/civitai-session`);
        if (!resp?.ok) {
            _civitaiAuthActive = false;
        } else {
            const data = await resp.json();
            if (data?.active) {
                _civitaiAuthActive = true;
            } else {
                // the service is up but has no key in memory. If the user has
                // a saved key (e.g. the server restarted), push it now.
                const savedKey = CoreAPI.getSetting('civitaiApiKey');
                if (savedKey && typeof savedKey === 'string') {
                    try {
                        const setResp = await _apiRequest(`${CL_HELPER_BASE}/civitai-set-key`, 'POST', { key: savedKey });
                        _civitaiAuthActive = !!setResp?.ok;
                    } catch {
                        _civitaiAuthActive = false;
                    }
                } else {
                    _civitaiAuthActive = false;
                }
            }
        }
    } catch {
        _civitaiAuthActive = false;
    }
    _civitaiAuthCheckedAt = now;
    return _civitaiAuthActive;
}

export function invalidateCivitaiAuthCache() {
    _civitaiAuthActive = null;
    _civitaiAuthCheckedAt = 0;
}

window.invalidateCivitaiAuthCache = invalidateCivitaiAuthCache;

/**
 * @param {string} url - Civitai post or image URL
 * @param {Object} opts
 * @param {AbortSignal} [opts.signal]
 */
async function extractImages(url, opts = {}) {
    const { signal } = opts;
    if (signal?.aborted) return { images: [], aborted: true };

    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return { images: [], error: 'Invalid Civitai URL' };
    }

    const postMatch = parsed.pathname.match(POST_URL_RE);
    const imageMatch = parsed.pathname.match(IMAGE_URL_RE);
    if (!postMatch && !imageMatch) {
        return { images: [], error: 'Unsupported Civitai URL' };
    }

    const authActive = await isCivitaiAuthActive();

    try {
        const results = postMatch
            ? await extractFromPost(postMatch[1], { signal, authActive })
            : await extractFromImage(imageMatch[1], { signal, authActive });

        if (signal?.aborted) return { images: [], aborted: true };
        if (results.length === 0) {
            return { images: [], error: 'No images found' };
        }
        return { images: results };
    } catch (err) {
        if (err?.name === 'AbortError') return { images: [], aborted: true };
        return { images: [], error: err?.message || 'Civitai extraction failed' };
    }
}

async function extractFromPost(postId, { signal, authActive }) {
    const hosts = ['civitai.com', 'civitai.red'];
    const path = `/api/v1/images?postId=${encodeURIComponent(postId)}&limit=${PER_POST_LIMIT}&nsfw=X`;

    const perHost = await Promise.all(hosts.map(host =>
        fetchJson(host, path, { signal, authActive }).then(data => ({ data }), err => ({ err }))
    ));

    const byId = new Map();
    for (const { data } of perHost) {
        const items = Array.isArray(data?.items) ? data.items : [];
        for (const item of items) {
            if (!item?.url || typeof item.url !== 'string') continue;
            const id = item.id ?? item.url;
            if (byId.has(id)) continue;
            byId.set(id, {
                url: item.url,
                filename: filenameFromCdnUrl(item.url, id),
            });
        }
    }
    // One reachable host answering empty is a content answer; every host FAILING is not.
    // Swallowing that difference reported a broken proxy as "No images found".
    if (byId.size === 0 && perHost.every(r => r.err)) throw perHost[0].err;
    return [...byId.values()];
}

async function extractFromImage(imageId, { signal, authActive }) {
    const hosts = ['civitai.com', 'civitai.red'];
    const path = `/images/${encodeURIComponent(imageId)}`;

    const htmls = await Promise.all(hosts.map(host =>
        fetchHtml(host, path, { signal, authActive }).then(html => ({ html }), err => ({ err }))
    ));

    const byUuid = new Map();
    for (const { html } of htmls) {
        if (!html) continue;
        CDN_URL_RE.lastIndex = 0;
        let m;
        while ((m = CDN_URL_RE.exec(html)) !== null) {
            const clean = m[0].replace(/[.,;:!?)}\]]+$/, '');
            const uuid = extractCdnUuid(clean);
            if (!uuid) continue;
            const existing = byUuid.get(uuid);
            if (!existing || preferLarger(clean, existing.url)) {
                byUuid.set(uuid, {
                    url: clean,
                    filename: filenameFromCdnUrl(clean, uuid),
                });
            }
        }
    }
    // Same rule as the post leg: all hosts failing is an error, not an empty page.
    if (byUuid.size === 0 && htmls.every(r => r.err)) throw htmls[0].err;
    return [...byUuid.values()];
}

function extractCdnUuid(cdnUrl) {
    // https://image.civitai.com/{identityPrefix}/{uuid}/width=.../filename.jpeg
    const m = cdnUrl.match(/image\.civitai\.com\/[^/]+\/([a-f0-9-]{8,})\//i);
    return m ? m[1] : null;
}

function preferLarger(candidate, current) {
    // "original=true" beats anything else, then higher "width=N" wins.
    const candOrig = /original=true/i.test(candidate);
    const currOrig = /original=true/i.test(current);
    if (candOrig !== currOrig) return candOrig;
    const candWidth = parseInt(candidate.match(/width=(\d+)/i)?.[1] || '0', 10);
    const currWidth = parseInt(current.match(/width=(\d+)/i)?.[1] || '0', 10);
    return candWidth > currWidth;
}

function filenameFromCdnUrl(cdnUrl, fallbackKey) {
    let last = null;
    // one item's url that is not absolute names no file, and must not cost the post its other images
    try { last = new URL(cdnUrl).pathname.split('/').filter(Boolean).pop(); } catch { /* not absolute: the fallback names it */ }
    if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last;
    return `civitai_${fallbackKey}.jpeg`;
}

async function fetchJson(host, path, { signal, authActive }) {
    const resp = await fetchRaw(host, path, { signal, authActive, accept: 'application/json' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
}

async function fetchHtml(host, path, { signal, authActive }) {
    const resp = await fetchRaw(host, path, { signal, authActive, accept: 'text/html' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.text();
}

async function fetchRaw(host, path, { signal, authActive, accept }) {
    if (authActive) {
        const proxyPath = `${CL_HELPER_BASE}/civitai-proxy/${host}${path.startsWith('/') ? path : '/' + path}`;
        const resp = await _apiRequest(proxyPath, 'GET', null, { signal });
        if (resp) return resp;
    }

    return fetchWithProxy(`https://${host}${path}`, { signal, headers: { Accept: accept } });
}

registerExtractor({
    id: 'civitai',
    name: 'Civitai',
    patterns: CIVITAI_PATTERNS,
    extractImages,
    requestDelay: REQUEST_DELAY_MS,
});
