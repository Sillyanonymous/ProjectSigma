// pixiv provider service, mounted by provider-services.js init() under /api/provider-services
import { sessionSlot, guardProxyTarget, debugLog, BROWSER_UA, fetchUpstream, relayUpstream, setRelayedType, validAnswer, invalidAnswer, rejectedStatus } from './shared.js';
import { readBodyCapped, readJsonCapped, PROVIDER_RELAY_MAX_BYTES } from '../lib/net-guard.js';


// =============================================================================
// Pixiv: cookie session + read-only ajax proxy + Referer-injecting image proxy.
// R-18 image URLs come back from /ajax/illust only when a logged-in PHPSESSID is
// sent AND the account's "View R-18 works" toggle is ON. i.pximg.net is
// Referer-gated (403 without Referer: https://www.pixiv.net/), so images are
// fetched server-side; that image fetch doesnt need the cookie, only the Referer.
// =============================================================================

const PIXIV_BASE = 'https://www.pixiv.net';
const PIXIV_IMG_HOSTNAME = 'i.pximg.net';
const PIXIV_REFERER = 'https://www.pixiv.net/';
// a known R-18 illust validates a session: urls.original is set only when logged in with R-18 on (swap it if removed)
const PIXIV_VALIDATE_ILLUST = '146636754';

// In-memory session PER USER, persists until logout or server restart. Primed from the
// persisted client setting on demand, like CT/civitai. Holds raw "PHPSESSID=VALUE".
const cookieOf = sessionSlot('pixiv-session');

// Read-only ajax paths the proxy is allowed to forward.
const PIXIV_ALLOWED_PATHS = [
    /^\/ajax\/illust\/\d+$/,
    /^\/ajax\/illust\/\d+\/pages$/,
];

export function registerPixivRoutes(router) {
    /**
     * POST /pixiv-set-cookie
     * Body: { cookie: "PHPSESSID=VALUE" } or { cookie: "VALUE" }
     * Accepts only the bare PHPSESSID value; rejects multi-cookie input.
     */
    router.post('/pixiv-set-cookie', (req, res) => {
        const { cookie } = req.body ?? {};
        if (!cookie || typeof cookie !== 'string' || !cookie.trim()) {
            return res.status(400).json({ error: 'cookie string is required' });
        }
        let value = cookie.trim();
        if (value.toUpperCase().startsWith('PHPSESSID=')) {
            value = value.slice('PHPSESSID='.length).trim();
        }
        if (value.includes(';') || value.length > 4096) {
            return res.status(400).json({ error: 'Invalid cookie value. Paste only the PHPSESSID value.' });
        }
        if (!value) return res.status(400).json({ error: 'Empty cookie value' });
        cookieOf.set(req, `PHPSESSID=${value}`);
        debugLog(req, 'Pixiv session cookie stored');
        res.json({ ok: true });
    });

    /**
     * GET /pixiv-validate: probes a known R-18 illust, since /ajax/user/me errors even on a valid session.
     */
    router.get('/pixiv-validate', async (req, res) => {
        const pixivSessionCookie = cookieOf.get(req);
        if (!pixivSessionCookie) return res.json(invalidAnswer('transient', 'no cookie stored'));
        try {
            const response = await fetch(`${PIXIV_BASE}/ajax/illust/${PIXIV_VALIDATE_ILLUST}`, {
                headers: {
                    'User-Agent': BROWSER_UA,
                    'Accept': 'application/json',
                    'Referer': PIXIV_REFERER,
                    'Cookie': pixivSessionCookie,
                },
            });
            if (!response.ok) return res.json(invalidAnswer(rejectedStatus(response.status) ? 'definitive' : 'transient', `HTTP ${response.status}`));
            const data = await readJsonCapped(response);
            const original = data?.body?.urls?.original || null;
            if (original) return res.json(validAnswer());
            // the account answered and the cookie buys no R-18 access: that is a judgement
            return res.json(invalidAnswer('definitive', 'No R-18 image URLs returned (login expired, or "View R-18 works" is off on the account).'));
        } catch (err) {
            console.error('[provider-services] Pixiv validate error:', err.message);
            res.json(invalidAnswer('transient', err.message));
        }
    });

    /** GET /pixiv-session , whether a session cookie is stored. */
    router.get('/pixiv-session', (req, res) => {
        res.json({ active: !!cookieOf.get(req) });
    });

    /** POST /pixiv-logout , clear the stored cookie. */
    router.post('/pixiv-logout', (req, res) => {
        cookieOf.clear(req);
        debugLog(req, 'Pixiv session cleared');
        res.json({ ok: true });
    });

    /**
     * GET /pixiv-proxy/* , read-only ajax proxy to www.pixiv.net with the stored
     * cookie + Referer injected. Path-allowlisted, hostname-pinned.
     */
    router.get('/pixiv-proxy/*splat', async (req, res) => {
        const targetUrl = guardProxyTarget(req, res, { base: PIXIV_BASE, allowedPaths: PIXIV_ALLOWED_PATHS, hosts: 'www.pixiv.net', label: 'Pixiv' });
        if (!targetUrl) return;
        const headers = {
            'User-Agent': BROWSER_UA,
            'Accept': 'application/json',
            'Referer': PIXIV_REFERER,
        };
        const pixivSessionCookie = cookieOf.get(req);
        if (pixivSessionCookie) headers['Cookie'] = pixivSessionCookie;
        try {
            // the cookie pins the host on the JSON leg; the image leg below carries none
            const response = await fetchUpstream(targetUrl, { method: 'GET', headers });
            await relayUpstream(res, response);
        } catch (err) {
            console.error('[provider-services] Pixiv proxy error:', err.message);
            res.status(err?.statusCode || 502).json({ error: 'Failed to reach Pixiv' });
        }
    });

    /**
     * GET /pixiv-image/*: streams i.pximg.net with the Referer it demands (no cookie), pinned so its no open relay.
     */
    router.get('/pixiv-image/*splat', async (req, res) => {
        const targetUrl = guardProxyTarget(req, res, { base: `https://${PIXIV_IMG_HOSTNAME}/`, allowedPaths: [/^\/(c|img-original|img-master)\//], hosts: PIXIV_IMG_HOSTNAME, label: 'Pixiv image' });
        if (!targetUrl) return;
        try {
            const response = await fetch(targetUrl.toString(), {
                headers: { 'User-Agent': BROWSER_UA, 'Referer': PIXIV_REFERER },
                redirect: 'follow',
            });
            const buf = await readBodyCapped(response, PROVIDER_RELAY_MAX_BYTES);
            if (!buf) return res.status(502).json({ error: 'response too large' });
            res.status(response.status);
            setRelayedType(res, response, 'application/octet-stream');
            res.send(buf);
        } catch (err) {
            console.error('[provider-services] Pixiv image proxy error:', err.message);
            res.status(502).json({ error: 'Failed to reach Pixiv image CDN' });
        }
    });
}
