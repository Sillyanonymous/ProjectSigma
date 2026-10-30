// botbooru provider service, mounted by provider-services.js init() under /api/provider-services
import { guardProxyTarget, fetchUpstream, relayUpstream, formLoginRelay } from './shared.js';


// =============================================================================
// Botbooru: login proxy
// =============================================================================

const BOTBOORU_AUTH_URL = 'https://botbooru.com/auth/token';
const BOTBOORU_BASE = 'https://botbooru.com';

// Allow-list for the botbooru proxy; hostname is pinned to botbooru.com separately.
const BOTBOORU_ALLOWED_PATHS = [
    /^\/posts(\/|$)/,
    /^\/post\/\d+/,
    /^\/tags\//,
    /^\/api\/users\//,
    /^\/auth\/me(\/|$)/,
    /^\/interactions\//,
    /^\/download\/(png|json)\//,
    /^\/images\//,
    /^\/mini-gallery\//,
];

async function handleBotbooruProxy(req, res) {
    const bearer = req.headers['x-cl-botbooru-auth'];
    if (bearer !== undefined && (typeof bearer !== 'string' || bearer.length > 4096)) {
        return res.status(400).json({ error: 'Invalid auth header' });
    }

    const targetUrl = guardProxyTarget(req, res, { base: BOTBOORU_BASE, allowedPaths: BOTBOORU_ALLOWED_PATHS, hosts: 'botbooru.com', label: 'Botbooru' });
    if (!targetUrl) return;

    const headers = { Accept: 'application/json' };
    if (bearer) headers['Authorization'] = bearer;
    // Only forward a body when the client actually sent one, so bodyless POSTs
    // (favorite toggle, follow) match the direct path exactly.
    const hasBody = ['POST', 'PATCH'].includes(req.method)
        && req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0;
    if (hasBody) headers['Content-Type'] = 'application/json';

    try {
        // a bearer on the request pins the host: an off-host redirect must never see it
        const response = await fetchUpstream(targetUrl, {
            method: req.method,
            headers,
            body: hasBody ? JSON.stringify(req.body) : undefined,
        }, { pinHost: !!bearer });
        await relayUpstream(res, response);
    } catch (err) {
        console.error('[provider-services] Botbooru proxy error:', err.message);
        res.status(502).json({ error: 'Failed to reach Botbooru' });
    }
}

export function registerBotbooruRoutes(router) {
    /**
     * POST /botbooru-login { username, password }: the form-encoded token login through the shared relay; stateless.
     */
    formLoginRelay(router, '/botbooru-login', { url: BOTBOORU_AUTH_URL, label: 'Botbooru' });

    // Authed botbooru proxy: injects the user's Bearer server-side so the token never rides a browser request.
    router.get('/botbooru-proxy/*splat', handleBotbooruProxy);
    router.post('/botbooru-proxy/*splat', handleBotbooruProxy);
    router.patch('/botbooru-proxy/*splat', handleBotbooruProxy);
    router.delete('/botbooru-proxy/*splat', handleBotbooruProxy);
}
