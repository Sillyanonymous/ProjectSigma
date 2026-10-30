// datacat provider service, mounted by provider-services.js init() under /api/provider-services
import { randomUUID } from 'node:crypto';
import { sessionSlot, guardProxyTarget, debugLog, BROWSER_UA, fetchUpstream, relayUpstream, validAnswer, invalidAnswer, rejectedStatus } from './shared.js';
import { readJsonCapped, readTextCapped } from '../lib/net-guard.js';


// =============================================================================
// DataCat: token session + extraction + read-only API proxy
// =============================================================================

const DATACAT_BASE = 'https://datacat.run';
const DATACAT_ORIGIN = 'https://datacat.run';

const tokenOf = sessionSlot('datacat-token');

function dcHeaders(token) {
    return {
        'User-Agent': BROWSER_UA,
        'Accept': 'application/json',
        'Origin': DATACAT_ORIGIN,
        'Referer': DATACAT_ORIGIN + '/',
        'X-Session-Token': token,
    };
}

async function testDcToken(token) {
    const response = await fetch(`${DATACAT_BASE}/api/characters/recent-public?limit=1&offset=0&summary=1&minTotalTokens=889`, {
        headers: dcHeaders(token),
    });
    return response;
}

// Read-only API paths forwarded by /dc-proxy.
const DC_ALLOWED_PATHS = [
    /^\/api\/characters\/fresh\b/,
    /^\/api\/characters\/recent-public\b/,
    /^\/api\/characters\/[a-f0-9-]+$/,
    /^\/api\/characters\/[a-f0-9-]+\/download\b/,
    /^\/api\/creators\/[a-f0-9-]+$/,
    /^\/api\/creators\/[a-f0-9-]+\/characters\b/,
    /^\/api\/tags\/faceted\b/,
    /^\/api\/extraction\/status-projection$/,
];

// Resolve a usable public session ID for the extraction endpoint.
async function getPublicSessionId(token) {
    try {
        const resp = await fetch(`${DATACAT_BASE}/api/users`, {
            headers: dcHeaders(token),
        });
        if (!resp.ok) return null;
        const data = await readJsonCapped(resp);
        const publicUser = (data.users || []).find(u => u.isPublic);
        if (!publicUser?.sessions) return null;
        const session = publicUser.sessions.find(
            s => s.purpose !== 'BACKGROUND_SCRAPER' && s.status === 'logged_in'
        );
        return session?.id || null;
    } catch {
        return null;
    }
}

export function registerDataCatRoutes(router) {
    router.post('/dc-init', async (req, res) => {
        const { force } = req.body ?? {};

        const cached = tokenOf.get(req);
        if (cached && !force) {
            try {
                const check = await testDcToken(cached);
                if (check.ok) {
                    return res.json({ ok: true, cached: true, token: cached });
                }
            } catch { /* fall through to create new */ }
            tokenOf.clear(req);
        }

        // Create anonymous session via the Liberator identify endpoint
        const deviceToken = randomUUID();
        try {
            const response = await fetch(`${DATACAT_BASE}/api/liberator/identify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': BROWSER_UA,
                    'Origin': DATACAT_ORIGIN,
                    'Referer': DATACAT_ORIGIN + '/',
                },
                body: JSON.stringify({ deviceToken }),
            });

            if (!response.ok) {
                const text = await readTextCapped(response);
                console.warn(`[provider-services] DC identify failed: HTTP ${response.status}`);
                return res.json({ ok: false, reason: `identify returned ${response.status}: ${text.slice(0, 200)}` });
            }

            const data = await readJsonCapped(response);
            if (data?.success && data?.sessionToken) {
                tokenOf.set(req, data.sessionToken);
                debugLog(req, 'DC anonymous session initialized');
                return res.json({ ok: true, token: data.sessionToken });
            }

            console.warn('[provider-services] DC identify returned unexpected shape:', JSON.stringify(data).slice(0, 300));
            res.json({ ok: false, reason: 'identify response missing sessionToken' });
        } catch (err) {
            console.error('[provider-services] DC auto-init error:', err.message);
            res.json({ ok: false, reason: err.message });
        }
    });

    router.post('/dc-set-token', async (req, res) => {
        const { token } = req.body ?? {};

        if (!token || typeof token !== 'string' || !token.trim()) {
            return res.status(400).json({ error: 'token string is required' });
        }

        const value = token.trim();
        if (value.length > 256) {
            return res.status(400).json({ error: 'Token too long' });
        }

        tokenOf.set(req, value);
        debugLog(req, 'DC session token stored');
        res.json({ ok: true });
    });

    router.post('/dc-clear-token', (req, res) => {
        tokenOf.clear(req);
        debugLog(req, 'DC session token cleared');
        res.json({ ok: true });
    });

    router.get('/dc-session', (req, res) => {
        res.json({ active: !!tokenOf.get(req) });
    });

    router.get('/dc-validate', async (req, res) => {
        const dcSessionToken = tokenOf.get(req);
        if (!dcSessionToken) {
            return res.json(invalidAnswer('transient', 'no token stored'));
        }

        try {
            const response = await testDcToken(dcSessionToken);

            if (response.ok) {
                const data = await readJsonCapped(response);
                const count = data?.totalCount || 0;
                debugLog(req, `DC validate: ${count} total chars available`);
                res.json(validAnswer({ totalCount: count }));
            } else {
                const text = await readTextCapped(response);
                console.warn(`[provider-services] DC validate failed: HTTP ${response.status}`);
                // only a refusal is definitive; an outage or a rate limit never judged the token
                res.json(invalidAnswer(rejectedStatus(response.status) ? 'definitive' : 'transient', `HTTP ${response.status}: ${text.slice(0, 200)}`));
            }
        } catch (err) {
            console.error('[provider-services] DC validate error:', err.message);
            res.json(invalidAnswer('transient', err.message));
        }
    });

    // POST-only: submit extraction request to DataCat
    router.post('/dc-extract', async (req, res) => {
        const dcSessionToken = tokenOf.get(req);
        if (!dcSessionToken) {
            return res.status(401).json({ error: 'No DataCat session token configured' });
        }

        const { url } = req.body ?? {};
        if (!url || typeof url !== 'string') {
            return res.status(400).json({ error: 'url string is required' });
        }
        if (url.length > 512) {
            return res.status(400).json({ error: 'URL too long' });
        }

        try {
            const parsed = new URL(url);
            const isJanitor = /^(www\.)?janitorai\.com$/i.test(parsed.hostname) || /^(www\.)?jannyai\.com$/i.test(parsed.hostname);
            if (!isJanitor) {
                return res.status(400).json({ error: 'Only JanitorAI character URLs are supported' });
            }
            if (!/^\/characters\/[a-f0-9-]{8,64}(_[\w-]+)?\/?$/i.test(parsed.pathname)) {
                return res.status(400).json({ error: 'Invalid character URL path' });
            }
        } catch {
            return res.status(400).json({ error: 'Invalid URL' });
        }

        const requestId = randomUUID();
        const wantPublicFeed = req.body.publicFeed !== false;
        const alwaysReextract = req.body.alwaysReextract === true;

        let sessionId = null;
        if (wantPublicFeed) {
            sessionId = await getPublicSessionId(dcSessionToken);
        }

        try {
            const endpoint = `${DATACAT_BASE}/api/character/smart-extract-v2`;
            const body = {
                url,
                openLoginIfNoSession: true,
                sessionId,
                appearOnPublicFeed: wantPublicFeed && !!sessionId,
                useSeparateWorkerServer: true,
                inlinePostExtractCreatorProfile: true,
                idempotencyKey: requestId,
                extractSourceMode: 'core_plus_janny',
                alwaysReextract,
            };

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    ...dcHeaders(dcSessionToken),
                    'Content-Type': 'application/json',
                    'X-Request-Id': requestId,
                },
                body: JSON.stringify(body),
            });

            const data = await readJsonCapped(response);
            res.status(response.status).json(data);
        } catch (err) {
            console.error('[provider-services] DC extract error:', err.message);
            res.status(502).json({ error: 'Failed to reach DataCat' });
        }
    });

    router.get('/dc-proxy/*splat', async (req, res) => {
        const dcSessionToken = tokenOf.get(req);
        if (!dcSessionToken) {
            return res.status(401).json({ error: 'No DataCat session token configured' });
        }

        const targetUrl = guardProxyTarget(req, res, { base: DATACAT_BASE, allowedPaths: DC_ALLOWED_PATHS, hosts: 'datacat.run', label: 'DC' });
        if (!targetUrl) return;

        try {
            // the session token pins the host: undici strips Cookie and Authorization across an off-host redirect, never a custom header
            const response = await fetchUpstream(targetUrl, { method: 'GET', headers: dcHeaders(dcSessionToken) });
            await relayUpstream(res, response);
        } catch (err) {
            console.error('[provider-services] DC proxy error:', err.message);
            res.status(err?.statusCode || 502).json({ error: 'Failed to reach DataCat' });
        }
    });
}
