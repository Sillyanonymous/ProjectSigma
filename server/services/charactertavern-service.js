// charactertavern provider service, mounted by provider-services.js init() under /api/provider-services
import { sessionSlot, guardProxyTarget, debugLog, BROWSER_UA, fetchUpstream, relayUpstream, validAnswer, invalidAnswer } from './shared.js';
import { readTextCapped } from '../lib/net-guard.js';
import { decodeSvelteKitData } from '../lib/sveltekit-data.js';


// =============================================================================
// CharacterTavern: cookie session + read-only API proxy
// =============================================================================

// per user, in memory: { cookies, expires }, the rolling expiry snapshotted off each authed response for the timer
const sessionOf = sessionSlot('ct-session');
const ctCookies = (req) => sessionOf.get(req)?.cookies ?? null;
const ctExpires = (req) => sessionOf.get(req)?.expires ?? null;

// snapshot the rolling Expires off an authed Set-Cookie; a deletion cookie is no future expiry
function captureCtExpiry(req, setCookieHeader) {
    if (!setCookieHeader || !/session=/.test(setCookieHeader)) return;
    if (setCookieHeader.includes('session=;') || /max-age=0/i.test(setCookieHeader)) return;
    const m = setCookieHeader.match(/expires=([^;]+)/i);
    if (!m) return;
    const t = Date.parse(m[1]);
    if (!Number.isNaN(t) && sessionOf.get(req)) sessionOf.set(req, { cookies: ctCookies(req), expires: t });
}

// the CT pages whose data the proxy may read: the catalog's search (tags too) and one character's page
const CT_ALLOWED_PATHS = [
    /^\/search\/cards\/__data\.json$/,
    /^\/character\/[^/]+\/[^/]+\/__data\.json$/,
];

// a page's data answer, decoded; null when CT answered something else (a page, an error)
async function readCtPageData(response) {
    const text = await readTextCapped(response);
    try { return decodeSvelteKitData(text); } catch { return null; }
}

export function registerCharacterTavernRoutes(router) {
    /**
     * POST /ct-set-cookie { cookie: "session=VALUE" | "VALUE" }: stores the session cookie alone (several cookies are refused).
     */
    router.post('/ct-set-cookie', async (req, res) => {
        const { cookie } = req.body ?? {};

        if (!cookie || typeof cookie !== 'string' || !cookie.trim()) {
            return res.status(400).json({ error: 'cookie string is required' });
        }

        let value = cookie.trim();

        if (value.startsWith('session=')) {
            value = value.slice('session='.length).trim();
        }

        if (value.includes(';') || value.length > 4096) {
            return res.status(400).json({ error: 'Invalid cookie value. Paste only the session cookie value.' });
        }

        if (!value) {
            return res.status(400).json({ error: 'Empty cookie value' });
        }

        // opaque value carries no expiry; learned on the next authed response
        sessionOf.set(req, { cookies: `session=${value}`, expires: null });
        debugLog(req, 'CT session cookie stored');
        res.json({ ok: true });
    });

    /**
     * GET /ct-validate: a test request with the stored cookie, answered in the shared validate vocabulary.
     */
    router.get('/ct-validate', async (req, res) => {
        // transient = never judged (none pushed, CT unreachable or unhealthy), definitive = refused; only definitive costs the cookie
        const ctSessionCookies = ctCookies(req);
        if (!ctSessionCookies) {
            return res.json(invalidAnswer('transient', 'no cookies stored'));
        }

        try {
            const response = await fetch('https://character-tavern.com/search/cards/__data.json?query=sara+lane&x-sveltekit-invalidated=001', {
                headers: {
                    'User-Agent': BROWSER_UA,
                    'Accept': '*/*',
                    'Cookie': ctSessionCookies,
                },
            });

            if (response.ok) {
                const data = await readCtPageData(response);
                const results = data?.nodes.find(n => n?.searchResults)?.searchResults;
                if (!results) return res.json(invalidAnswer('transient', 'CharacterTavern answered no search results'));
                const hits = results.hits || [];
                // a hit carrying a content warning shows the session sees flagged cards; none read proves nothing either way
                const hasNsfw = hits.some(h => Array.isArray(h.contentWarnings) && h.contentWarnings.length > 0) ? true : null;

                const setCookie = response.headers.get('set-cookie');
                const isRejected = setCookie && (setCookie.includes('session=;') || setCookie.includes('Max-Age=0'));
                
                if (isRejected) {
                    console.warn('[provider-services] CT session rejected (Set-Cookie deletion detected)');
                    sessionOf.clear(req);
                    res.json(invalidAnswer('definitive', 'Session rejected/expired by server'));
                    return;
                }

                captureCtExpiry(req, setCookie); // this authed request slid the window; snapshot the new expiry
                debugLog(req, `CT validate: ${hits.length} hits, totalHits=${results.totalHits}, hasNSFW=${hasNsfw}`);
                res.json(validAnswer({ hasNsfw, expires: ctExpires(req) }));
            } else if (response.status === 403) {
                sessionOf.clear(req);
                res.json(invalidAnswer('definitive', 'rejected (cookies expired or invalid)'));
            } else {
                res.json(invalidAnswer('transient', `HTTP ${response.status}`));
            }
        } catch (err) {
            console.error('[provider-services] CT validate error:', err.message);
            res.json(invalidAnswer('transient', err.message));
        }
    });

    /**
     * POST /ct-logout
     * Clears stored session cookies.
     */
    router.post('/ct-logout', (req, res) => {
        sessionOf.clear(req);
        debugLog(req, 'CT session cleared');
        res.json({ ok: true });
    });

    /**
     * GET /ct-session
     * Returns whether a CT session is active.
     */
    router.get('/ct-session', (req, res) => {
        res.json({ active: !!ctCookies(req), expires: ctExpires(req) });
    });


    /**
     * GET /ct-proxy/*
     * Read-only proxy to character-tavern.com's page data, with the stored session cookie, answered as plain JSON.
     * Path-allowlisted to prevent abuse as an open relay.
     */
    router.get('/ct-proxy/*splat', async (req, res) => {
        const targetUrl = guardProxyTarget(req, res, { base: 'https://character-tavern.com/', allowedPaths: CT_ALLOWED_PATHS, hosts: 'character-tavern.com', label: 'CT' });
        if (!targetUrl) return;

        const headers = { 'User-Agent': BROWSER_UA, 'Accept': '*/*' };
        const ctSessionCookies = ctCookies(req);
        if (ctSessionCookies) {
            headers['Cookie'] = ctSessionCookies;
        }

        try {
            // the cookie pins the host: an off-host redirect is refused, never left to undici's stripping
            const response = await fetchUpstream(targetUrl, { method: 'GET', headers });
            captureCtExpiry(req, response.headers.get('set-cookie')); // browse calls slide the window too
            if (!response.ok) return relayUpstream(res, response);
            const data = await readCtPageData(response);
            if (!data) return res.status(502).json({ error: 'CharacterTavern answered something other than page data' });
            // a page that failed (a card that does not exist) answers with its own status, as CT's API once did
            if (data.error) return res.status(data.error.status >= 400 && data.error.status < 600 ? data.error.status : 502).json({ error: data.error.message });
            res.json({ nodes: data.nodes });
        } catch (err) {
            console.error('[provider-services] CT proxy error:', err.message);
            res.status(502).json({ error: 'Failed to reach CharacterTavern' });
        }
    });
}
