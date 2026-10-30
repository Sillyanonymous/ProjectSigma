// imgchest provider service, mounted by provider-services.js init() under /api/provider-services
import { debugLog, BROWSER_UA } from './shared.js';
import { decodeHtmlEntities } from '../lib/html-entities.js';
import { readTextCapped } from '../lib/net-guard.js';

// =============================================================================
// Imgchest: password-protected gallery unlock
// =============================================================================


function extractImgchestCookies(headers) {
    const result = { xsrfToken: null, session: null };
    const setCookies = typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : (headers.get('set-cookie') || '').split(/,\s*(?=[A-Z])/);
    for (const sc of setCookies) {
        const xsrf = sc.match(/XSRF-TOKEN=([^;]+)/);
        if (xsrf) result.xsrfToken = xsrf[1];
        const sess = sc.match(/image_chest_session=([^;]+)/);
        if (sess) result.session = sess[1];
    }
    return result;
}

function parseImgchestImages(html) {
    const match = html.match(/data-page="([^"]+)"/);
    if (!match) return [];
    try {
        const data = JSON.parse(decodeHtmlEntities(match[1]));
        const files = data?.props?.post?.files;
        if (!Array.isArray(files)) return [];
        return files
            .filter(f => f.link && typeof f.link === 'string')
            .map(f => ({ url: f.link, filename: f.link.split('/').pop() }));
    } catch {
        return [];
    }
}

export function registerImgchestRoutes(router) {
    /**
     * POST /imgchest-unlock { url, password } -> { images: [{url, filename}] } or { error }.
     * Three steps: GET validate (XSRF + session cookies), POST the password, GET the unlocked page's data-page.
     */
    router.post('/imgchest-unlock', async (req, res) => {
        const { url, password } = req.body ?? {};

        if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
        if (!password || typeof password !== 'string') return res.status(400).json({ error: 'password is required' });
        if (url.length > 512) return res.status(400).json({ error: 'URL too long' });
        if (password.length > 256) return res.status(400).json({ error: 'Password too long' });

        let postId;
        try {
            const parsed = new URL(url);
            if (parsed.hostname !== 'imgchest.com') {
                return res.status(400).json({ error: 'Only imgchest.com URLs are supported' });
            }
            const m = parsed.pathname.match(/^\/p\/([a-zA-Z0-9]+)/);
            if (!m) return res.status(400).json({ error: 'Invalid imgchest post URL' });
            postId = m[1];
        } catch {
            return res.status(400).json({ error: 'Invalid URL' });
        }

        const validateUrl = `https://imgchest.com/p/${postId}/validate`;
        const postUrl = `https://imgchest.com/p/${postId}`;

        try {
            const step1 = await fetch(validateUrl, {
                headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html' },
            });
            if (!step1.ok) {
                return res.json({ error: `Validate page returned HTTP ${step1.status}` });
            }

            const cookies1 = extractImgchestCookies(step1.headers);
            if (!cookies1.xsrfToken || !cookies1.session) {
                return res.json({ error: 'Failed to obtain session from imgchest' });
            }

            const html1 = await readTextCapped(step1);
            let inertiaVersion = '';
            const dataPageMatch = html1.match(/data-page="([^"]+)"/);
            if (dataPageMatch) {
                const decoded = decodeHtmlEntities(dataPageMatch[1]);
                const vm = decoded.match(/"version":"([^"]+)"/);
                if (vm) inertiaVersion = vm[1];
            }

            // POST the password, expecting a 302 redirect on success.
            const step2 = await fetch(validateUrl, {
                method: 'POST',
                headers: {
                    'User-Agent': BROWSER_UA,
                    'Content-Type': 'application/json',
                    'Accept': 'text/html, application/xhtml+xml',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-Inertia': 'true',
                    ...(inertiaVersion ? { 'X-Inertia-Version': inertiaVersion } : {}),
                    'X-XSRF-TOKEN': decodeURIComponent(cookies1.xsrfToken),
                    'Cookie': `XSRF-TOKEN=${cookies1.xsrfToken}; image_chest_session=${cookies1.session}`,
                    'Origin': 'https://imgchest.com',
                    'Referer': validateUrl,
                },
                body: JSON.stringify({ password }),
                redirect: 'manual',
            });

            if (step2.status === 422) {
                return res.json({ error: 'Wrong password' });
            }
            if (step2.status !== 302) {
                await step2.body?.cancel().catch(() => { /* the status is the answer; the body is only released */ });
                return res.json({ error: `Password validation failed (HTTP ${step2.status})` });
            }

            const cookies2 = extractImgchestCookies(step2.headers);
            const finalXsrf = cookies2.xsrfToken || cookies1.xsrfToken;
            const finalSession = cookies2.session || cookies1.session;

            const step3 = await fetch(postUrl, {
                headers: {
                    'User-Agent': BROWSER_UA,
                    'Accept': 'text/html',
                    'Cookie': `XSRF-TOKEN=${finalXsrf}; image_chest_session=${finalSession}`,
                },
            });

            if (!step3.ok) {
                return res.json({ error: `Failed to fetch unlocked post (HTTP ${step3.status})` });
            }

            const images = parseImgchestImages(await readTextCapped(step3));
            if (images.length === 0) {
                return res.json({ error: 'No images found after password validation' });
            }

            debugLog(req, `Imgchest unlocked ${postId}: ${images.length} images`);
            res.json({ images });
        } catch (err) {
            console.error('[provider-services] Imgchest unlock error:', err.message);
            res.status(502).json({ error: 'Failed to reach imgchest' });
        }
    });
}
