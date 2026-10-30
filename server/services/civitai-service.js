// civitai provider service, mounted by provider-services.js init() under /api/provider-services
import { sessionSlot, guardProxyTarget, debugLog, BROWSER_UA, fetchUpstream, relayUpstream, validAnswer, invalidAnswer, rejectedStatus } from './shared.js';


// =============================================================================
// Civitai: gallery extractor auth + read-only API proxy
// =============================================================================

const CIVITAI_HOSTS = new Set(['civitai.com', 'civitai.red']);
const CIVITAI_ALLOWED_PATHS = [
    /^\/api\/v1\/images\/?$/,
    /^\/api\/v1\/images\/[a-zA-Z0-9_-]+\/?$/,
    /^\/posts\/[0-9]+\/?$/,
    /^\/images\/[0-9]+\/?$/,
];

const apiKeyOf = sessionSlot('civitai-key');

export function registerCivitaiRoutes(router) {
    router.post('/civitai-set-key', (req, res) => {
        const { key } = req.body ?? {};
        if (!key || typeof key !== 'string') return res.status(400).json({ error: 'key is required' });
        if (key.length > 256) return res.status(400).json({ error: 'key too long' });
        apiKeyOf.set(req, key.trim());
        debugLog(req, 'Civitai API key stored');
        res.json({ ok: true });
    });

    router.post('/civitai-clear-key', (req, res) => {
        apiKeyOf.clear(req);
        res.json({ ok: true });
    });

    router.get('/civitai-session', (req, res) => {
        res.json({ active: !!apiKeyOf.get(req) });
    });

    router.get('/civitai-validate', async (req, res) => {
        const civitaiApiKey = apiKeyOf.get(req);
        if (!civitaiApiKey) return res.json(invalidAnswer('transient', 'No API key configured'));
        try {
            const response = await fetch('https://civitai.com/api/v1/models?limit=1', {
                headers: {
                    'Authorization': `Bearer ${civitaiApiKey}`,
                    'User-Agent': BROWSER_UA,
                    'Accept': 'application/json',
                },
            });
            res.json(response.ok
                ? validAnswer({ status: response.status })
                : invalidAnswer(rejectedStatus(response.status) ? 'definitive' : 'transient', `HTTP ${response.status}`, { status: response.status }));
        } catch (err) {
            console.error('[provider-services] Civitai validate error:', err.message);
            res.json(invalidAnswer('transient', 'Failed to reach Civitai'));
        }
    });

    router.get('/civitai-proxy/:host/*splat', async (req, res) => {
        const host = req.params.host;
        if (!CIVITAI_HOSTS.has(host)) {
            return res.status(400).json({ error: 'host must be civitai.com or civitai.red' });
        }

        const targetUrl = guardProxyTarget(req, res, { base: `https://${host}`, allowedPaths: CIVITAI_ALLOWED_PATHS, hosts: CIVITAI_HOSTS, label: 'Civitai' });
        if (!targetUrl) return;

        const headers = {
            'User-Agent': BROWSER_UA,
            'Accept': targetUrl.pathname.startsWith('/api/') ? 'application/json' : 'text/html',
        };
        const civitaiApiKey = apiKeyOf.get(req);
        if (civitaiApiKey) headers['Authorization'] = `Bearer ${civitaiApiKey}`;

        try {
            // a key on the request pins the host: an off-host redirect must never see it
            const response = await fetchUpstream(targetUrl, { method: 'GET', headers }, { pinHost: !!civitaiApiKey });
            await relayUpstream(res, response);
        } catch (err) {
            console.error('[provider-services] Civitai proxy error:', err.message);
            res.status(502).json({ error: 'Failed to reach Civitai' });
        }
    });
}
