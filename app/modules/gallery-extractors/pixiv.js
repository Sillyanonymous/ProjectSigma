/**
 * Pixiv artwork extractor: needs the pixiv service routes (ajax via /pixiv-proxy, Referer-gated images via /pixiv-image).
 * Patterns: https://www.pixiv.net/[lang/]artworks/{id}, https://www.pixiv.net/member_illust.php?illust_id={id}
 */

import { registerExtractor } from './extractor-registry.js';
import CoreAPI from '../core-api.js';

const PIXIV_PATTERNS = [
    /pixiv\.net\/(?:[a-z]{2}\/)?artworks\/\d+/i,
    /pixiv\.net\/member_illust\.php\?(?:[^#]*&)?illust_id=\d+/i,
];

const ARTWORK_ID_RE = /\/(?:[a-z]{2}\/)?artworks\/(\d+)/i;
const LEGACY_ID_RE = /[?&]illust_id=(\d+)/i;

const CL_HELPER_BASE = '/provider-services';
const REQUEST_DELAY_MS = 400;
const PAGE_LIMIT = 200; // Pixiv's own per-artwork max; a safety belt, never drops in practice.

const _apiRequest = (...args) => CoreAPI.apiRequest(...args);

let _pixivHelperOk = null;
let _pixivCheckedAt = 0;
// the service refused the saved session, so an R-18 miss names it rather than asking for one
let _pixivCookieRefused = false;
const HELPER_CACHE_MS = 60000;

// false ONLY when the service route is absent (a Pixiv 404 isnt a missing route); primes the saved cookie
async function ensurePixivHelper() {
    const now = Date.now();
    if (_pixivHelperOk !== null && now - _pixivCheckedAt < HELPER_CACHE_MS) {
        return _pixivHelperOk;
    }
    let ok = false;
    try {
        const resp = await _apiRequest(`${CL_HELPER_BASE}/pixiv-session`);
        if (resp?.ok) {
            ok = true;
            const data = await resp.json().catch(() => null);
            _pixivCookieRefused = false;
            if (!data?.active) {
                const savedCookie = CoreAPI.getSetting('pixivCookie');
                if (savedCookie && typeof savedCookie === 'string') {
                    const primed = await _apiRequest(`${CL_HELPER_BASE}/pixiv-set-cookie`, 'POST', { cookie: savedCookie }).catch(() => null);
                    _pixivCookieRefused = !primed?.ok;
                    if (_pixivCookieRefused) console.warn(`[Pixiv] the saved session was not accepted (${primed ? `HTTP ${primed.status}` : 'no answer'}); R-18 artworks will not load`);
                }
            }
        }
    } catch { /* the service did not answer: unavailable until the next check */ }
    _pixivHelperOk = ok;
    _pixivCheckedAt = now;
    return ok;
}

export function invalidatePixivAuthCache() {
    _pixivHelperOk = null;
    _pixivCheckedAt = 0;
    _pixivCookieRefused = false;
}
window.invalidatePixivAuthCache = invalidatePixivAuthCache;

function parseIllustId(url) {
    return url.match(ARTWORK_ID_RE)?.[1] || url.match(LEGACY_ID_RE)?.[1] || null;
}

// i.pximg.net is Referer-gated, so bytes come via the image proxy, shaped like downloadMediaToMemory's answer
function makeDownloadFn(imgUrl) {
    return async (abortSignal) => {
        let path;
        try {
            const u = new URL(imgUrl);
            path = u.pathname + (u.search || '');
        } catch {
            return { success: false, error: 'Bad Pixiv image URL' };
        }
        try {
            const resp = await _apiRequest(`${CL_HELPER_BASE}/pixiv-image${path}`, 'GET', null, { signal: abortSignal });
            if (!resp?.ok) return { success: false, error: `Pixiv image download failed (HTTP ${resp?.status ?? '?'})` };
            const arrayBuffer = await resp.arrayBuffer();
            const contentType = resp.headers.get('content-type') || 'image/png';
            return { success: true, arrayBuffer, contentType };
        } catch (err) {
            if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err;
            return { success: false, error: err?.message || 'Pixiv image download failed' };
        }
    };
}

// pixiv ajax through the proxy; a non-ok answer throws with `pixivStatus` so the caller can word it
async function fetchAjax(path, signal) {
    const resp = await _apiRequest(`${CL_HELPER_BASE}/pixiv-proxy${path}`, 'GET', null, { signal });
    if (!resp) throw new Error('Could not reach the provider-services proxy');
    if (!resp.ok) {
        const e = new Error(`Pixiv responded HTTP ${resp.status}`);
        e.pixivStatus = resp.status;
        throw e;
    }
    const data = await resp.json();
    if (data?.error) throw new Error(data?.message || 'Pixiv API error');
    return data?.body;
}

async function extractImages(url, opts = {}) {
    const { signal } = opts;
    if (signal?.aborted) return { images: [], aborted: true };

    const illustId = parseIllustId(url);
    if (!illustId) return { images: [], error: 'Unsupported Pixiv URL' };

    if (!(await ensurePixivHelper())) {
        return { images: [], error: 'Pixiv extraction is unavailable: the server did not answer the proxy request.' };
    }
    if (signal?.aborted) return { images: [], aborted: true };

    // metadata is public even for R-18: page count, type and image access, before /pages (404s for R-18 logged out)
    let meta;
    try {
        meta = await fetchAjax(`/ajax/illust/${illustId}`, signal);
    } catch (err) {
        if (err?.name === 'AbortError') return { images: [], aborted: true };
        if (err?.pixivStatus === 404) return { images: [], error: 'Pixiv artwork not found (it may have been deleted or made private).' };
        return { images: [], error: `Could not load the Pixiv artwork: ${err?.message || String(err)}` };
    }
    if (signal?.aborted) return { images: [], aborted: true };
    if (!meta) return { images: [], error: 'Pixiv returned no artwork data.' };

    if (meta.illustType === 2) {
        return { images: [], error: "Pixiv animations (ugoira) aren't supported." };
    }

    const isR18 = Number(meta.xRestrict) > 0;
    const firstUrl = meta.urls?.original || meta.urls?.regular || null;

    // no image URL on public metadata means no access (for R-18 the login/toggle gate): say so before /pages can 404
    if (!firstUrl) {
        return {
            images: [],
            error: !isR18
                ? 'Pixiv returned no image URLs for this artwork (it may be restricted).'
                : _pixivCookieRefused
                    ? 'This R-18 Pixiv artwork needs a login, and your saved Pixiv session could not be used. Paste the PHPSESSID value again in Settings > Media.'
                    : 'This R-18 Pixiv artwork needs a login. Add your Pixiv session in Settings > Media, and make sure "View R-18 works" is ON in your Pixiv account.',
        };
    }

    const pageCount = Number(meta.pageCount) || 1;
    let pageUrls;
    if (pageCount > 1) {
        let pages = null;
        try {
            pages = await fetchAjax(`/ajax/illust/${illustId}/pages`, signal);
        } catch (err) {
            if (err?.name === 'AbortError') return { images: [], aborted: true };
            // We have access (firstUrl is set) but the page list failed; fall back
            // to the first image rather than failing the whole artwork.
            pages = null;
        }
        if (signal?.aborted) return { images: [], aborted: true };
        pageUrls = (Array.isArray(pages) ? pages : [])
            .map(p => p?.urls?.original || p?.urls?.regular)
            .filter(Boolean);
        if (pageUrls.length === 0) pageUrls = [firstUrl];
    } else {
        pageUrls = [firstUrl];
    }

    const images = pageUrls.slice(0, PAGE_LIMIT).map((imgUrl, i) => ({
        url: imgUrl,
        filename: filenameFor(illustId, imgUrl, i),
        downloadFn: makeDownloadFn(imgUrl),
    }));
    return { images };
}

function filenameFor(illustId, imgUrl, index) {
    let ext = 'png';
    try {
        const last = new URL(imgUrl).pathname.split('/').pop() || '';
        const m = last.match(/\.([a-z0-9]{2,5})$/i);
        if (m) ext = m[1].toLowerCase();
    } catch { /* keep default */ }
    return `pixiv_${illustId}_p${index}.${ext}`;
}

registerExtractor({
    id: 'pixiv',
    name: 'Pixiv',
    patterns: PIXIV_PATTERNS,
    extractImages,
    requestDelay: REQUEST_DELAY_MS,
});
