// dropbox provider service, mounted by provider-services.js init() under /api/provider-services
import { guardProxyTarget, BROWSER_UA, fetchUpstream, setRelayedType } from './shared.js';
import { readBodyCapped } from '../lib/net-guard.js';


// =============================================================================
// Dropbox: GET-only proxy for public folder/file share page HTML
// =============================================================================
//
// The generic /api/proxy sends Dropbox a request shape (UA, accept) that
// returns HTTP 400. The folder share page is needed to extract the embedded
// file-list blob; image bytes themselves come from per-file URLs handled by
// the regular media downloader. Browser-shaped headers fix the 400.

const DROPBOX_HOSTNAME = 'www.dropbox.com';
const DROPBOX_BASE = 'https://www.dropbox.com';
const DROPBOX_MAX_BYTES = 5 * 1024 * 1024;
const DROPBOX_ALLOWED_PATHS = [
    /^\/scl\/fo\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/?$/,
    /^\/scl\/fi\/[A-Za-z0-9_-]+\/[^/]+$/,
];

export function registerDropboxRoutes(router) {
    router.get('/dropbox-proxy/*splat', async (req, res) => {
        const targetUrl = guardProxyTarget(req, res, { base: DROPBOX_BASE, allowedPaths: DROPBOX_ALLOWED_PATHS, hosts: DROPBOX_HOSTNAME, label: 'Dropbox' });
        if (!targetUrl) return;

        try {
            // no credential rides this relay, so redirects are followed
            const response = await fetchUpstream(targetUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': BROWSER_UA,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                },
            }, { pinHost: false });
            const buf = await readBodyCapped(response, DROPBOX_MAX_BYTES);
            const text = buf ? new TextDecoder().decode(buf) : '';
            if (!response.ok) {
                console.warn(`[provider-services] Dropbox returned HTTP ${response.status} for ${targetUrl.toString()}`);
                console.warn(`[provider-services] Dropbox response body (first 500 chars): ${text.slice(0, 500)}`);
            }
            if (!buf) {
                return res.status(502).json({ error: `Dropbox response exceeded ${DROPBOX_MAX_BYTES} bytes` });
            }
            res.status(response.status);
            setRelayedType(res, response, 'text/html; charset=utf-8');
            res.send(text);
        } catch (err) {
            console.error('[provider-services] Dropbox proxy error:', err.message);
            res.status(502).json({ error: `Failed to reach Dropbox: ${err.message}` });
        }
    });
}
