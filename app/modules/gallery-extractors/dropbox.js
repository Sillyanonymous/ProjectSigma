/**
 * Dropbox gallery extractor: image URLs grepped from the page's base64 protobuf blob, dl=0 flipped to dl=1.
 * Patterns: https://www.dropbox.com/scl/fo/{id}/{rkey}?rlkey=... (folder), /scl/fi/{id}/{filename}?rlkey=... (file)
 */

import CoreAPI from '../core-api.js';
import { registerExtractor } from './extractor-registry.js';

const DROPBOX_PATTERNS = [
    /dropbox\.com\/scl\/(?:fo|fi)\/[A-Za-z0-9_-]+\//
];

const IMAGE_EXT = '(?:png|jpe?g|gif|webp|heic|jfif)';
const SCL_FILE_URL_RE = new RegExp(
    `https://www\\.dropbox\\.com/scl/(?:fo|fi)/[A-Za-z0-9_\\-/%~.]+?\\.${IMAGE_EXT}\\?[A-Za-z0-9=&_-]+`,
    'gi'
);
const B64_BLOB_RE = /"([A-Za-z0-9+/]{5000,}={0,2})"/g;

const REQUEST_DELAY_MS = 300;

/**
 * @param {string} url - Dropbox folder or single-file share URL
 * @param {Object} opts
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<import('./extractor-registry.js').ExtractorResult>}
 */
async function extractImages(url, opts = {}) {
    const { signal } = opts;
    if (signal?.aborted) return { images: [], aborted: true };

    // Decode &amp; (card-HTML residue) and drop st= (viewer-session token tied to the original requester); rlkey alone authorizes.
    const cleanUrl = url
        .replace(/&amp;/g, '&')
        .replace(/([?&])st=[^&]*(&|$)/, (_, lead, tail) => tail ? lead : '');

    try {
        if (/\/scl\/fi\//.test(cleanUrl)) {
            return { images: [toDownloadEntry(cleanUrl)] };
        }

        const html = await fetchPage(cleanUrl, signal);
        const images = parseFolderBlob(html);
        if (images.length === 0) {
            return { images: [], error: 'No image files found in folder' };
        }
        return { images };
    } catch (err) {
        if (err.name === 'AbortError') return { images: [], aborted: true };
        return { images: [], error: err.message };
    }
}

function parseFolderBlob(html) {
    const seen = new Set();
    const images = [];
    B64_BLOB_RE.lastIndex = 0;
    let m;
    while ((m = B64_BLOB_RE.exec(html)) !== null) {
        let decoded;
        try { decoded = atob(m[1]); } catch { continue; }
        SCL_FILE_URL_RE.lastIndex = 0;
        let f;
        while ((f = SCL_FILE_URL_RE.exec(decoded)) !== null) {
            const entry = toDownloadEntry(f[0]);
            if (!seen.has(entry.url)) {
                seen.add(entry.url);
                images.push(entry);
            }
        }
        if (images.length > 0) break;
    }
    return images;
}

function toDownloadEntry(rawUrl) {
    let url = rawUrl.replace(/([?&])dl=0(?=$|&)/, '$1dl=1');
    if (!/[?&]dl=1(?=$|&)/.test(url)) {
        url += url.includes('?') ? '&dl=1' : '?dl=1';
    }
    const pathPart = url.split('?')[0];
    const filename = decodeURIComponent(pathPart.split('/').pop() || 'image');
    return { url, filename };
}

// The dedicated route is the only working path: a direct fetch is CORS-blocked, and the
// generic proxy 400s on Dropbox's UA defaults.
async function fetchPage(url, signal) {
    const helperUrl = toHelperProxyUrl(url);
    if (!helperUrl) throw new Error('Invalid Dropbox URL');
    let response;
    try {
        response = await fetch(helperUrl, { signal });
    } catch (err) {
        if (err.name === 'AbortError') throw err;
        throw new Error(`Dropbox service unreachable: ${err.message}`);
    }
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} from the Dropbox service`);
    }
    return response.text();
}

function toHelperProxyUrl(url) {
    try {
        const u = new URL(url);
        if (u.hostname !== 'www.dropbox.com') return null;
        return CoreAPI.serverUrl(`/api/provider-services/dropbox-proxy${u.pathname}${u.search}`);
    } catch { return null; }
}

registerExtractor({
    id: 'dropbox',
    name: 'Dropbox',
    patterns: DROPBOX_PATTERNS,
    extractImages,
    requestDelay: REQUEST_DELAY_MS
});
