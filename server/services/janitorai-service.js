// janitorai provider service: the account, extraction and recovery routes, over janitorai-page.js and janitorai-recover.js
import { debugLog } from './shared.js';
import { CDP_NAV_TIMEOUT } from '../lib/cdp.js';
import { withPage, resolveBrowserEndpoint, registerBrowserConsumer, CF_CHALLENGE_RE } from './browser-service.js';
import { runOnLane, laneStatus } from './janitorai-jobs.js';
import { closeSignal } from '../lib/request-guard.js';
import {
    JANITORAI_ORIGIN, JANITORAI_UUID_RE, janitoraiCall, isJanitoraiSessionCookie, readJanitoraiToken, janitoraiNoSessionReason,
    injectJanitoraiSession, janitoraiSessionNeedsPush, extractHiddenDefinition,
} from './janitorai-page.js';
import {
    recoverLockedDefinition, setRecoverPhase, cancelRecoverJob, isRecoverCancelled, clearRecoverJob,
    sweepRecoverProgress, recoverProgress, recoverInFlight,
} from './janitorai-recover.js';

// ============================================================================================
// Routes: the account (login, session, logout of the site is the browser service's cookie
// clear), the extraction and the locked recovery. Browse transport rides /browser/fetch.

// a request's lane identity: the account, and whether the caller still waits (a closed socket left the queue)
const laneUser = (req) => req.userHandle || 'default';
function laneMeta(req, res, characterId, kind) {
    const gone = closeSignal(res);
    return { characterId, kind, user: laneUser(req), abandoned: () => gone.aborted };
}

export function registerJanitoraiBrowserRoutes(router) {
    // The browse transport (/browser/fetch) and the connection test ride the shared browser under
    // this consumer: janitorai.com behind Cloudflare, in-page fetches under /hampter/ only.
    registerBrowserConsumer({ id: 'janitorai', origin: JANITORAI_ORIGIN, fetchPrefix: '/hampter/' });

    // drives the real login form (Turnstile is domain-locked); the session goes back, the browser profile keeps the cookies
    router.post('/janitorai-browser-login', async (req, res) => {
        const { email, password } = req.body ?? {};
        if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
            return res.status(400).json({ error: 'email and password are required' });
        }
        if (email.length > 256 || password.length > 256) {
            return res.status(400).json({ error: 'Invalid credentials format' });
        }

        try {
            const endpoint = await resolveBrowserEndpoint(req);
            const result = await withPage(endpoint, async (page) => {
                await page.goto(`${JANITORAI_ORIGIN}/login`, { timeout: CDP_NAV_TIMEOUT });
                await new Promise(r => setTimeout(r, 6000));

                // already signed in: janitorai serves no form, and re-driving one would only risk the session
                const before = await page.cookies([JANITORAI_ORIGIN]);
                const existing = readJanitoraiToken(before);
                if (existing.token) return { session: existing.cookie };

                // React reverts a plain el.value = x on the next render, so use the native setter and fire input
                const filled = await page.evaluate(`
                    (() => {
                        const set = (el, v) => {
                            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                        };
                        const em = document.querySelector('input[type="email"],input[name="email"]');
                        const pw = document.querySelector('input[type="password"]');
                        if (!em || !pw) return false;
                        set(em, ${JSON.stringify(email)});
                        set(pw, ${JSON.stringify(password)});
                        return true;
                    })()`);
                if (!filled) {
                    // the landing page's title is the diagnosis: a challenge, a block and the app all look like no form
                    const title = String(await page.evaluate('document.title').catch(() => '') || '').slice(0, 80);
                    throw new Error(CF_CHALLENGE_RE.test(title)
                        ? `janitorai.com answered the login page with "${title}" instead of the form. Cloudflare is challenging or blocking this browser; run the connection test, and if it passes, try again in a few minutes.`
                        : `Could not find the login form on janitorai.com (the page was "${title || 'untitled'}").`);
                }

                await new Promise(r => setTimeout(r, 2500));
                await page.evaluate(`
                    (() => {
                        const b = [...document.querySelectorAll('button')]
                            .find(x => /sign in|log in|login/i.test(x.textContent || ''));
                        if (b) b.click();
                        return !!b;
                    })()`);
                await new Promise(r => setTimeout(r, 13000));

                const after = await page.cookies([JANITORAI_ORIGIN]);
                const { token, cookie } = readJanitoraiToken(after);
                if (!token) {
                    // the session cookies we see split refused from unreadable; session-shaped names only, never the PKCE verifiers beside them
                    const seen = after.map(c => c.name).filter(isJanitoraiSessionCookie);
                    if (seen.length) {
                        throw new Error(`Signed in, but the session cookie could not be read (${seen.join(', ')}). Please report this.`);
                    }
                    // the page's own words split a refused password from a captcha from a passwordless account
                    const state = await page.evaluate(`
                        (() => {
                            const seen = new Set();
                            const text = [...document.querySelectorAll('[role="alert"], [class*="error" i], [class*="Error"]')]
                                .map(el => (el.textContent || '').trim())
                                .filter(t => t && t.length < 160 && !seen.has(t) && seen.add(t));
                            const human = document.querySelector('input[name="cf-turnstile-response"]');
                            return { path: location.pathname, title: document.title, message: text[0] || '', turnstile: human ? (human.value ? 'passed' : 'pending') : 'none' };
                        })()`).catch(() => null);
                    const had = new Set(before.map(c => c.name));
                    throw new Error(janitoraiNoSessionReason(state, after.map(c => c.name).filter(n => !had.has(n))));
                }
                return { session: cookie };
            });
            res.json({ ok: true, ...result });
        } catch (err) {
            console.warn('[provider-services] JanitorAI browser login failed:', err.message);
            res.status(err.statusCode || 502).json({ ok: false, error: err.message });
        }
    });

    // push a session we hold into the browser: the chat UI renders no composer for a signed-out browser
    router.post('/janitorai-browser-session', async (req, res) => {
        const { token, refreshToken } = req.body ?? {};
        if (typeof token !== 'string' || !token) {
            return res.status(400).json({ error: 'token is required' });
        }
        for (const t of [token, refreshToken]) {
            if (t !== undefined && (typeof t !== 'string' || t.length > 4096)) {
                return res.status(400).json({ error: 'Invalid token' });
            }
        }

        try {
            const endpoint = await resolveBrowserEndpoint(req);
            const applied = await withPage(endpoint, async (page) => {
                // Cookies are origin-scoped, so the page has to be on janitorai.com before one
                // can be written for it.
                await page.goto(`${JANITORAI_ORIGIN}/`, { timeout: CDP_NAV_TIMEOUT });
                return await injectJanitoraiSession(page, token, refreshToken);
            });
            if (!applied) throw new Error('The browser refused the session cookie.');
            res.json({ ok: true });
        } catch (err) {
            console.warn('[provider-services] JanitorAI browser session push failed:', err.message);
            res.status(err.statusCode || 502).json({ ok: false, error: err.message });
        }
    });

    // one character's definition: public off the detail, withheld ones captured off the prompt a chat assembles
    router.post('/janitorai-extract', async (req, res) => {
        const { characterId, token: clientToken, refreshToken } = req.body ?? {};
        if (typeof characterId !== 'string' || !JANITORAI_UUID_RE.test(characterId)) {
            return res.status(400).json({ error: 'characterId must be a JanitorAI character uuid' });
        }
        for (const t of [clientToken, refreshToken]) {
            if (t !== undefined && (typeof t !== 'string' || t.length > 4096)) {
                return res.status(400).json({ error: 'Invalid token' });
            }
        }

        const meta = laneMeta(req, res, characterId, 'extract');
        try {
            const endpoint = await resolveBrowserEndpoint(req);
            const result = await runOnLane(endpoint, meta, () => withPage(endpoint, async (page) => {
                await page.goto(`${JANITORAI_ORIGIN}/`, { timeout: CDP_NAV_TIMEOUT });
                await new Promise(r => setTimeout(r, 3500));

                // prefer our own self-refreshing token; a browser session is the fallback, never a requirement
                const browser = readJanitoraiToken(await page.cookies([JANITORAI_ORIGIN]));
                const token = clientToken || browser.token;
                // the chat page needs the session as a cookie with its user, the calls' own account, or it reads every chat as private
                if (janitoraiSessionNeedsPush(browser, clientToken)) {
                    await injectJanitoraiSession(page, token, clientToken ? refreshToken : browser.refreshToken);
                }

                const detailRes = await page.evaluate(janitoraiCall('GET', `/hampter/characters/${characterId}`, null, token));
                if (detailRes.status === 404) throw new Error('That character no longer exists on JanitorAI.');
                if (detailRes.status >= 400 || !detailRes.data) {
                    throw new Error(`JanitorAI returned HTTP ${detailRes.status} for that character.`);
                }
                const detail = detailRes.data;

                if (detail.personality) return { detail, definition: '', extracted: false };
                if (!token) throw new Error('This definition is hidden, so it needs a JanitorAI account. Sign in under Settings > Online > JanitorAI.');

                return await extractHiddenDefinition(page, token, detail);
            }));
            res.json({ ok: true, ...result });
        } catch (err) {
            if (err?.abandoned) return;   // the caller hung up while queued; nobody to answer
            console.warn('[provider-services] JanitorAI extract failed:', err.message);
            res.status(err.statusCode || 502).json({ ok: false, error: err.message });
        }
    });

    // this account's place on the extraction lane: the running job, then the queued ones with positions
    router.get('/janitorai-jobs', (req, res) => {
        res.json(laneStatus(laneUser(req)));
    });

    // best effort for a locked definition whose creator forbids proxies; the result is MODEL OUTPUT, never fed to an update check
    router.post('/janitorai-recover', async (req, res) => {
        const { characterId, token: clientToken, refreshToken, jobId } = req.body ?? {};
        if (typeof characterId !== 'string' || !JANITORAI_UUID_RE.test(characterId)) {
            return res.status(400).json({ error: 'characterId must be a JanitorAI character uuid' });
        }
        for (const t of [clientToken, refreshToken]) {
            if (t !== undefined && (typeof t !== 'string' || t.length > 4096)) {
                return res.status(400).json({ error: 'Invalid token' });
            }
        }
        if (jobId !== undefined && (typeof jobId !== 'string' || jobId.length > 64)) {
            return res.status(400).json({ error: 'Invalid jobId' });
        }
        const report = (phase, chars) => setRecoverPhase(jobId, phase, chars);
        const cancelled = () => isRecoverCancelled(jobId);
        const meta = laneMeta(req, res, characterId, 'recover');

        try {
            const endpoint = await resolveBrowserEndpoint(req);
            // one at a time per browser on the lane; a cancel while queued leaves it unrun
            const result = await runOnLane(endpoint, meta, () => {
                if (cancelled()) throw Object.assign(new Error('Recovery cancelled'), { cancelled: true });
                if (jobId) recoverInFlight.set(jobId, { characterId, at: Date.now() });
                report('setup');
                return withPage(endpoint, async (page) => {
                await page.goto(`${JANITORAI_ORIGIN}/`, { timeout: CDP_NAV_TIMEOUT });
                await new Promise(r => setTimeout(r, 3500));

                const browser = readJanitoraiToken(await page.cookies([JANITORAI_ORIGIN]));
                const token = clientToken || browser.token;
                // the chat page needs the session as a cookie with its user, the calls' own account, or it reads every chat as private
                if (janitoraiSessionNeedsPush(browser, clientToken)) {
                    await injectJanitoraiSession(page, token, clientToken ? refreshToken : browser.refreshToken);
                }
                if (!token) throw new Error('This needs a JanitorAI account. Sign in under Settings > Online > JanitorAI.');

                const detailRes = await page.evaluate(janitoraiCall('GET', `/hampter/characters/${characterId}`, null, token));
                if (detailRes.status === 404) throw new Error('That character no longer exists on JanitorAI.');
                if (detailRes.status >= 400 || !detailRes.data) {
                    throw new Error(`JanitorAI returned HTTP ${detailRes.status} for that character.`);
                }
                const detail = detailRes.data;
                // A readable definition needs none of this; the caller should not have asked.
                if (detail.personality) return { detail, personality: '', recovered: null };

                return await recoverLockedDefinition(page, token, detail, report, cancelled);
                });
            });
            setRecoverPhase(jobId, 'done', 0, result?.restoreWarning);
            res.json({ ok: true, ...result });
        } catch (err) {
            if (err?.abandoned) return;   // the caller hung up while queued; nobody to answer
            // a hung-up cancel reads the run's end and any failed restore here
            setRecoverPhase(jobId, err?.cancelled ? 'cancelled' : 'failed', 0, err?.restoreWarning);
            // a cancel is the reader's doing, not a failure; the run already cleaned up
            if (err?.cancelled) {
                debugLog(req, 'JanitorAI recover cancelled by the client');
                res.status(499).json({ ok: false, cancelled: true, error: 'Recovery cancelled' });
            } else {
                console.warn('[provider-services] JanitorAI recover failed:', err.message);
                res.status(err.statusCode || 502).json({ ok: false, error: err.message });
            }
        } finally {
            clearRecoverJob(jobId);
            // Keep the terminal phase briefly so a final poll can read it, then drop.
            if (jobId) setTimeout(() => recoverProgress.delete(jobId), 30000);
        }
    });

    // stop an in-flight recovery: the run cleans up as it unwinds, so this only raises the flag
    router.post('/janitorai-recover-cancel', (req, res) => {
        const job = req.body?.jobId;
        if (typeof job !== 'string' || !job || job.length > 64) {
            return res.status(400).json({ error: 'jobId is required' });
        }
        const running = recoverInFlight.has(job);
        cancelRecoverJob(job);
        debugLog(req, `JanitorAI recover cancel requested (running=${running})`);
        res.json({ ok: true, running });
    });

    // Coarse phase of an in-flight /janitorai-recover, polled by the browser for a progress hint.
    router.get('/janitorai-recover-progress', (req, res) => {
        sweepRecoverProgress();
        const job = req.query?.job;
        const entry = (typeof job === 'string') ? recoverProgress.get(job) : null;
        res.json({ phase: entry?.phase || null, chars: entry?.chars || 0, ...(entry?.restoreWarning ? { restoreWarning: entry.restoreWarning } : {}) });
    });
}
