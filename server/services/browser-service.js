// The hosted browser (a managed Chrome or a user's DevTools endpoint) over raw CDP; providers register as consumers of its routes
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { config } from '../config.js';
import { CdpClient, CdpPage, CDP_NAV_TIMEOUT, cdpHttpBase, PAGE_TEXT_CAPPED } from '../lib/cdp.js';
import { resolvesToLoopback, readJsonCapped, PROVIDER_RELAY_MAX_BYTES } from '../lib/net-guard.js';
import { killTree } from '../lib/kill-tree.js';
import { assertSlugId } from '../lib/ext-contract.js';
import { httpError } from '../lib/http-error.js';
import { closeSignal } from '../lib/request-guard.js';

export const CF_CHALLENGE_RE = /just a moment|checking your browser|attention required|access restricted|verifying you are human/i;

const CF_MAX_WAIT_MS = 30000;
const CF_RELOAD_ATTEMPTS = 3;
const CF_RELOAD_GAP_MS = 5000;

/**
 * Poll until the page stops being a challenge, reloading a few times; never clear cookies around it (the challenge issues its own).
 */
export async function waitForCloudflare(page) {
    const started = Date.now();
    let title = '';
    let blocked = true;
    for (let attempt = 0; attempt < CF_RELOAD_ATTEMPTS && blocked; attempt++) {
        if (attempt > 0) {
            await new Promise(r => setTimeout(r, CF_RELOAD_GAP_MS));
            try { await page.send('Page.reload', { ignoreCache: false }); } catch { /* keep polling */ }
        }
        const deadline = Date.now() + CF_MAX_WAIT_MS;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 1500));
            try {
                title = String(await page.evaluate('document.title') || '');
            } catch { /* mid-reload; the next poll picks it up */ }
            blocked = !title || CF_CHALLENGE_RE.test(title);
            if (!blocked) break;
        }
    }

    let hint = '';
    if (blocked) {
        let signals = {};
        try {
            // No WebGL at all fingerprints as a bot louder than a headless UA does. The
            // UA-vs-Client-Hints check catches --user-agent naming a different Chrome release.
            signals = await page.evaluate(`(function () {
                var gl = null;
                try {
                    var cv = document.createElement('canvas');
                    gl = cv.getContext('webgl') || cv.getContext('experimental-webgl');
                } catch (e) { gl = null; }
                var renderer = '';
                if (gl) {
                    try {
                        var dbg = gl.getExtension('WEBGL_debug_renderer_info');
                        renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'available';
                    } catch (e) { renderer = 'available'; }
                }
                var uaM = navigator.userAgent.match(/Chrome\\/(\\d+)/);
                var brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
                var chV = '';
                for (var i = 0; i < brands.length; i++) {
                    if (/chrom/i.test(brands[i].brand)) { chV = String(brands[i].version); break; }
                }
                return {
                    webdriver: navigator.webdriver === true,
                    headlessUa: /headless/i.test(navigator.userAgent),
                    languages: (navigator.languages || []).length,
                    webgl: !!gl,
                    renderer: renderer,
                    uaVersion: uaM ? uaM[1] : '',
                    hintsVersion: chV
                };
            })()`) || {};
        } catch { /* diagnostics are best effort */ }

        const flags = [];
        if (signals.webgl === false) {
            flags.push('WebGL is unavailable entirely, which is worse than software rendering and worth fixing before anything else');
        }
        if (signals.uaVersion && signals.hintsVersion && signals.uaVersion !== signals.hintsVersion) {
            flags.push(`the user-agent claims Chrome ${signals.uaVersion} but this browser is really Chrome ${signals.hintsVersion} (drop --user-agent; it does not rewrite Client Hints)`);
        }
        if (signals.webdriver) flags.push('navigator.webdriver is true (add --disable-blink-features=AutomationControlled)');
        if (signals.headlessUa) flags.push('the user-agent still says Headless, so this browser is running headless');
        if (signals.languages === 0) flags.push('navigator.languages is empty (set --lang)');

        hint = flags.length
            ? `Fix these first: ${flags.join('; ')}.`
            : 'No fingerprint problem to fix. Cloudflare hands some hosts an interactive challenge that never completes without a person, and no launch flag changes that. Running the browser on a different machine (an ordinary x64 desktop works) is the reliable way through. Solving it by hand is not an option here: the widget is never rendered, so there is nothing to click.';
    }
    return { blocked, title, waitedMs: Date.now() - started, hint };
}

/** Open a page on the browser at `endpoint`, run `fn(page, client)`, always tear the page down. */
export async function withPage(endpoint, fn) {
    const client = await CdpClient.connect(endpoint);
    let page = null;
    try {
        page = await CdpPage.create(client);
        return await fn(page, client);
    } finally {
        if (page) await page.close();
        client.close();
    }
}

// one warm page per browser AND consumer, reused across requests (a cold one costs seconds); extraction never shares them
const _warmPages = new Map();     // endpoint + consumer id -> { endpoint, consumer, client, page, lastUsed }
const _warmPending = new Map();   // endpoint + consumer id -> the warm-up in flight
const WARM_IDLE_MS = 5 * 60 * 1000;
let _warmReaper = null;
const warmKey = (endpoint, consumer) => `${endpoint}\n${consumer.id}`;

/** @param {{id: string}} consumer the registered consumer, or any object carrying its id */
export async function closeWarmPage(endpoint, consumer) {
    const key = warmKey(endpoint, consumer);
    const w = _warmPages.get(key);
    _warmPages.delete(key);
    if (!w) return;
    await w.page.close();
    w.client.close();
}

function armWarmReaper() {
    if (_warmReaper) return;
    _warmReaper = setInterval(() => {
        for (const w of _warmPages.values()) {
            if (Date.now() - w.lastUsed > WARM_IDLE_MS) closeWarmPage(w.endpoint, w.consumer);
        }
        if (!_warmPages.size) { clearInterval(_warmReaper); _warmReaper = null; }
    }, 60000);
    // Never hold the process open just to reap an idle browser tab.
    _warmReaper.unref?.();
}

/**
 * The parked page for consumer on the browser at endpoint, warmed once (its origin, warm path and ready hook).
 * @param {string} endpoint
 * @param {{id: string, origin: string, warmPath?: string, ready?: Function|null}} consumer
 * @returns {Promise<{endpoint: string, consumer: Object, client: CdpClient, page: CdpPage, lastUsed: number}>}
 */
export async function getWarmPage(endpoint, consumer) {
    const key = warmKey(endpoint, consumer);
    const have = _warmPages.get(key);
    if (have && !have.client._closed) { have.lastUsed = Date.now(); return have; }
    // concurrent requests share one warm-up; the key carries the endpoint, so a joiner never gets another browser's cookies
    if (_warmPending.has(key)) return _warmPending.get(key);

    const promise = (async () => {
        await closeWarmPage(endpoint, consumer);
        const client = await CdpClient.connect(endpoint);
        let page;
        try {
            page = await CdpPage.create(client);
            await page.goto(`${consumer.origin}${consumer.warmPath || '/'}`, { timeout: CDP_NAV_TIMEOUT });
            // Park only once the challenge is done, so the first real request is not spent on it.
            if (consumer.ready) await consumer.ready(page);
        } catch (e) {
            await page?.close();
            client.close();
            throw e;
        }
        const w = { endpoint, consumer, client, page, lastUsed: Date.now() };
        _warmPages.set(key, w);
        armWarmReaper();
        return w;
    })().finally(() => {
        // Only clear a slot this warm-up still owns; a newer one may hold it by settle time.
        if (_warmPending.get(key) === promise) _warmPending.delete(key);
    });
    _warmPending.set(key, promise);
    return promise;
}

// ============================================================================================
// Managed browser
//
// Spawns and owns a headless browser on loopback, so a normal user never pastes a CDP URL.
// Headless does not force software rendering: on a host with a GPU it reports the real adapter.
// Loopback only, since Chrome always binds CDP to 127.0.0.1 and nothing off-box needs it here.

const MANAGED_IDLE_MS = 10 * 60 * 1000;
const MANAGED_START_TIMEOUT_MS = 45000;

// after a failed start, back off: browse asks for a browser per request and each would pay the start timeout
const MANAGED_FAIL_COOLDOWN_MS = 60000;

let _managed = null;          // { proc, endpoint, binary, browser, ua, profile, lastUsed }
let _managedStarting = null;  // the spawned proc before _managed is assigned, so Stop can reach it
let _managedKiller = null;    // removed on teardown so restarts don't leak process signal listeners
let _managedPending = null;
let _managedReaper = null;
let _managedLastError = null;
let _managedFailedAt = 0;

/**
 * Spawn the browser; a JS file (CL_BROWSER=launcher.mjs) runs under this node with the same flags.
 */
function spawnBrowser(binary, args, opts) {
    if (/\.(?:mjs|cjs|js)$/i.test(binary)) return spawn(process.execPath, [binary, ...args], { ...opts, windowsHide: true });
    return spawn(binary, args, opts);
}

/** Newest playwright build first, then the system browsers. Mirrors run-browser.mjs. */
function managedBrowserCandidates() {
    const out = [];
    if (process.env.CL_BROWSER) out.push(process.env.CL_BROWSER);
    // Several playwright chromiums often coexist and readdir order is not version order, so a
    // plain "first hit" picks a stale build.
    const glob = (dir, re, tail) => {
        try {
            readdirSync(dir)
                .filter(d => re.test(d))
                .sort((a, b) => (parseInt(b.match(/\d+/)[0], 10) - parseInt(a.match(/\d+/)[0], 10)))
                .forEach(d => out.push(join(dir, d, ...tail)));
        } catch { /* not present */ }
    };
    if (process.platform === 'win32') {
        glob(join(homedir(), 'AppData/Local/ms-playwright'), /^chromium-\d+$/, ['chrome-win64', 'chrome.exe']);
        out.push('C:/Program Files/Google/Chrome/Application/chrome.exe',
                 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
                 join(homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
                 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
                 'C:/Program Files/Microsoft/Edge/Application/msedge.exe');
    } else if (process.platform === 'darwin') {
        glob(join(homedir(), 'Library/Caches/ms-playwright'), /^chromium-\d+$/, ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']);
        out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                 '/Applications/Chromium.app/Contents/MacOS/Chromium');
    } else {
        glob('/ms-playwright', /^chromium-\d+$/, ['chrome-linux', 'chrome']);
        glob(join(homedir(), '.cache/ms-playwright'), /^chromium-\d+$/, ['chrome-linux', 'chrome']);
        out.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
                 '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
    }
    return out;
}

export function findManagedBrowser() {
    return managedBrowserCandidates().find(p => { try { return existsSync(p); } catch { return false; } }) || null;
}

function freeLoopbackPort() {
    return new Promise((res, rej) => {
        const s = createServer();
        s.once('error', rej);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
    });
}

// headless says HeadlessChrome, which Cloudflare refuses; the override names the REAL version (Sec-CH-UA), probed on an ephemeral port
async function probeManagedUserAgent(binary) {
    let probePort;
    try { probePort = await freeLoopbackPort(); } catch { return null; }
    const probeProfile = join(tmpdir(), `cl-ua-probe-${process.pid}-${probePort}`);
    let proc;
    try {
        proc = spawnBrowser(binary, ['--headless=new', `--remote-debugging-port=${probePort}`,
            `--user-data-dir=${probeProfile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
    } catch { return null; }

    let exited = false;
    proc.once('exit', () => { exited = true; });
    proc.once('error', () => { exited = true; });

    try {
        for (let i = 0; i < 24; i++) {
            await new Promise(r => setTimeout(r, 500));
            if (exited) return null;          // it died; anything on that port is not ours
            try {
                const info = await readJsonCapped(await fetch(`http://127.0.0.1:${probePort}/json/version`));
                const ua = String(info['User-Agent'] || '');
                if (!ua) continue;
                // Cross-check: the UA must name the same Chrome as the browser that produced it.
                const uaMajor = (ua.match(/Chrome\/(\d+)/) || [])[1];
                const realMajor = (String(info.Browser || '').match(/(\d+)/) || [])[1];
                if (uaMajor && realMajor && uaMajor !== realMajor) return null;
                return ua.replace(/Headless/g, '');
            } catch { /* not up yet */ }
        }
    } finally {
        killTree(proc);
        // the profile goes once the browser lets go of it; rmSync's retries do not wait between tries
        if (!exited) await new Promise((r) => { proc.once('exit', r); setTimeout(r, 5000).unref(); });
        try { await rm(probeProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
        catch (e) { console.warn(`[provider-services] the user-agent probe's profile stayed at ${probeProfile}: ${e.message}`); }
    }
    return null;
}

function managedProfileDir() {
    return join(tmpdir(), 'cl_browser');
}

async function stopManagedBrowser() {
    if (_managedKiller) {
        process.removeListener('exit', _managedKiller);
        process.removeListener('SIGTERM', _managedKiller);
        process.removeListener('SIGINT', _managedKiller);
        _managedKiller = null;
    }
    // a start still in its wait loop holds the proc only here; a Stop then would orphan it
    if (_managedStarting) {
        killTree(_managedStarting);
        _managedStarting = null;
    }
    const m = _managed;
    _managed = null;
    if (!m) return;
    killTree(m.proc);
}

// like armWarmReaper: an unref()d sweep so an idle browser never holds the process open, stopping when empty
function armManagedReaper() {
    if (_managedReaper) return;
    _managedReaper = setInterval(() => {
        if (_managed && Date.now() - _managed.lastUsed > MANAGED_IDLE_MS) {
            stopManagedBrowser();
        }
        if (!_managed) { clearInterval(_managedReaper); _managedReaper = null; }
    }, 60000);
    _managedReaper.unref?.();
}

const MANAGED_ADMIN_ONLY = 'The managed browser is for admins only on a shared server. Use endpoint mode with a browser you run.';

/**
 * Lazily start (or reuse) the managed browser and return its CDP endpoint.
 * @param {Object} req
 * @param {boolean} [force] - bypass the failure cooldown; a button press means try again
 */
export async function getManagedEndpoint(req, force = false) {
    // one process and cookie jar for the whole server, so admin-only when shared; endpoint mode is per user
    if (config.multiUser && !req?.user?.admin) throw httpError(403, MANAGED_ADMIN_ONLY);
    // signalCode too: an OOM-killed or crashed browser keeps exitCode null and would be
    // reported alive forever, wedging every request on a dead endpoint.
    if (_managed && _managed.proc.exitCode === null && _managed.proc.signalCode === null) {
        _managed.lastUsed = Date.now();
        return _managed.endpoint;
    }
    // Concurrent callers must share one spawn, not race a dozen browsers onto the box.
    if (_managedPending) return _managedPending;
    if (force) _managedFailedAt = 0;
    if (_managedFailedAt && Date.now() - _managedFailedAt < MANAGED_FAIL_COOLDOWN_MS) {
        throw new Error(_managedLastError || 'Managed browser failed to start');
    }

    _managedPending = (async () => {
        await stopManagedBrowser();
        const binary = findManagedBrowser();
        if (!binary) {
            throw new Error('No Chrome, Chromium or Edge found on this machine. Install one, set CL_BROWSER to its path, or switch to endpoint mode and point Project Σ at a browser elsewhere.');
        }

        const port = await freeLoopbackPort();
        const profile = managedProfileDir();
        // drop the janitorai-era profile dir, it holds only a stale challenge
        try { rmSync(join(tmpdir(), 'cl_janitorai_browser'), { recursive: true, force: true }); } catch { /* a leftover only costs disk */ }
        try { mkdirSync(profile, { recursive: true }); } catch { /* an unusable profile fails the launch, answered below */ }
        // A profile left locked by an unclean shutdown makes Chrome exit 21 in a loop.
        for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
            try { rmSync(join(profile, f), { force: true }); } catch { /* a lock that stays is answered below as a locked profile */ }
        }

        const ua = await probeManagedUserAgent(binary);
        const flags = [
            '--headless=new',
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${profile}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-blink-features=AutomationControlled',
            '--disable-background-networking',
            '--password-store=basic',
            '--use-mock-keychain',
            '--window-size=1280,900',
        ];
        if (ua) flags.push(`--user-agent=${ua}`);
        // no gpu flags: Chrome picks its own backend (usually SwiftShader on Linux), which clears fine

        const proc = spawnBrowser(binary, [...flags, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] });
        _managedStarting = proc;
        // a failed spawn emits 'error' and never sets exitCode; uncaught, the wait loop sits out its whole timeout
        let spawnError = null;
        proc.once('error', (e) => { spawnError = e; });
        // The browser must not outlive the server.
        const killer = () => killTree(proc);
        _managedKiller = killer;
        process.once('exit', killer);
        process.once('SIGTERM', killer);
        process.once('SIGINT', killer);

        const endpoint = `http://127.0.0.1:${port}`;
        const deadline = Date.now() + MANAGED_START_TIMEOUT_MS;
        let info = null;
        while (Date.now() < deadline) {
            if (spawnError) throw new Error(`Could not launch ${binary}: ${spawnError.message}`);
            if (proc.signalCode !== null) throw new Error(`Browser was killed during startup (${proc.signalCode}).`);
            if (proc.exitCode !== null) throw new Error(`Browser exited immediately (code ${proc.exitCode}). Profile may be locked by another instance.`);
            try {
                info = await readJsonCapped(await fetch(`${endpoint}/json/version`));
                if (info?.Browser) break;
            } catch { /* not up yet */ }
            await new Promise(r => setTimeout(r, 400));
        }
        if (!info?.Browser) {
            killTree(proc);
            throw new Error('Browser did not open its debugging port in time.');
        }

        _managed = { proc, endpoint, binary, browser: String(info.Browser), ua: ua || null, profile, lastUsed: Date.now() };
        _managedLastError = null;
        _managedFailedAt = 0;
        armManagedReaper();
        console.log(`[provider-services] managed browser up: ${info.Browser} (${binary})`);
        return endpoint;
    })().catch((e) => { _managedLastError = e.message; _managedFailedAt = Date.now(); throw e; })
        .finally(() => { _managedPending = null; _managedStarting = null; });

    return _managedPending;
}

/**
 * Every browser route resolves its endpoint here, so the lazy-start decision lives in one place.
 */
const _endpointUseLogged = new Set();
export async function resolveBrowserEndpoint(req, force = false) {
    const { endpoint, managed } = req.body ?? {};
    if (managed) return getManagedEndpoint(req, force);
    if (config.multiUser && !req?.user?.admin) {
        // the managed browser listens on this loopback with the admins' sessions; anyone else naming it skips the gate
        let host = '';
        try { host = new URL(cdpHttpBase(endpoint)).hostname; } catch { /* the connect reports a bad endpoint */ }
        if (host && await resolvesToLoopback(host)) {
            throw httpError(403, 'A browser on this server\'s own machine is for admins only. Use a browser you run, at an address this server reaches on your network.');
        }
        // endpoint mode is the one browser surface a non-admin drives on a shared server; say so once
        if (req?.userHandle && !_endpointUseLogged.has(req.userHandle)) {
            _endpointUseLogged.add(req.userHandle);
            console.warn(`[provider-services][${req.userHandle}] drives a browser endpoint of their own`);
        }
    }
    return endpoint;
}

/**
 * A hint, not the verdict: software rendering clears the challenge, so the Cloudflare row decides fitness.
 */
async function probeRenderStack(page) {
    const raw = await page.evaluate(`(() => {
        try {
            // Codecs are probed before the WebGL bail so a GL-less browser still gets an
            // honest codec verdict instead of a fabricated "no proprietary codecs".
            const v = document.createElement('video');
            const video = v.canPlayType('video/mp4; codecs="avc1.42E01E"') || '';
            const audio = v.canPlayType('audio/mp4; codecs="mp4a.40.2"') || '';
            const c = document.createElement('canvas');
            const gl = c.getContext('webgl2') || c.getContext('webgl');
            if (!gl) return JSON.stringify({ renderer: '', exts: 0, video, audio });
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            return JSON.stringify({
                renderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '',
                exts: (gl.getSupportedExtensions() || []).length,
                video,
                audio,
            });
        } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
    })()`);
    try { return JSON.parse(String(raw || '{}')); } catch { return {}; }
}

function isSoftwareRenderer(renderer) {
    return /swiftshader|llvmpipe|softpipe|software/i.test(String(renderer || ''));
}

// ============================================================================================
// Consumers
//
// A provider (or a server-half extension, later) registers the ORIGIN it drives and the path
// prefix its in-page fetches may use. The generic fetch route serves registered origins only,
// under their prefix, with the consumer's own headers riding the request: a browser that fetches
// anything for anyone would be a request forwarder, and a browser that drops the consumer's
// Bearer is the FlareSolverr defect this design replaced.

const _consumers = new Map();

/**
 * @param {{id?: string, name?: string, origin: string, fetchPrefix: string, warmPath?: string, ready?: Function|null, owner?: string|null, refuses?: Function|null}} spec
 *   a core one names its id, an extension's its owner and name (id <owner>:<name>); warmPath defaults to /; refuses(req): why not
 * @returns {{id: string, name: string, origin: string, fetchPrefix: string, warmPath: string, ready: Function|null, owner: string|null, refuses: Function|null}}
 */
export function registerBrowserConsumer({ id, name, origin, fetchPrefix, warmPath = '/', ready = waitForCloudflare, owner = null, refuses = null } = {}) {
    if (owner === null) {
        assertSlugId('browser consumer', id);
        name = id;
    } else {
        // the extension loader checked the owner's grammar; a colon is no slug's, so this id never takes a core one
        if (typeof owner !== 'string' || !owner || owner.includes(':')) throw new Error(`browser consumer: owner '${owner}' is not an extension id`);
        if (id !== undefined) throw new Error(`extension '${owner}': a browser consumer is given a name, never an id`);
        assertSlugId(`extension '${owner}' browser consumer name`, name);
        id = `${owner}:${name}`;
    }
    if (refuses !== null && typeof refuses !== 'function') throw new Error(`browser consumer '${id}': refuses must be a function or null`);
    // the registry outlives an app instance (routes mounted twice in one process): the same spec is the same consumer
    const existing = _consumers.get(id);
    if (existing) {
        if (existing.origin === origin && existing.fetchPrefix === fetchPrefix && existing.warmPath === warmPath && existing.ready === ready && existing.owner === owner) return existing;
        throw new Error(`browser consumer '${id}' is already registered with another origin, prefix, warm path or ready hook`);
    }
    let parsed = null;
    try { parsed = new URL(origin); } catch { /* refused below */ }
    if (!parsed || parsed.origin !== origin || parsed.protocol !== 'https:') throw new Error(`browser consumer '${id}': origin must be a bare https origin`);
    if (typeof fetchPrefix !== 'string' || !fetchPrefix.startsWith('/') || !fetchPrefix.endsWith('/')) throw new Error(`browser consumer '${id}': fetchPrefix must start and end with /`);
    if (typeof warmPath !== 'string' || !warmPath.startsWith('/')) throw new Error(`browser consumer '${id}': warmPath must start with /`);
    if (ready !== null && typeof ready !== 'function') throw new Error(`browser consumer '${id}': ready must be a function or null`);
    const consumer = Object.freeze({ id, name, origin, fetchPrefix, warmPath, ready, owner, refuses });
    _consumers.set(id, consumer);
    return consumer;
}

export function browserConsumer(id) { return _consumers.get(id) || null; }
export function browserConsumerIds() { return [..._consumers.keys()]; }

/** The consumers an extension registered, in registration order. */
export function browserConsumersOf(owner) { return [..._consumers.values()].filter(c => c.owner === owner); }

/** Drop an extension's consumers with its half, their parked pages closed, and a page still warming closed once it parks. */
export function dropBrowserConsumers(owner) {
    const gone = () => { /* a dead tab is gone already */ };
    for (const c of browserConsumersOf(owner)) {
        _consumers.delete(c.id);
        for (const w of [..._warmPages.values()]) if (w.consumer.id === c.id) closeWarmPage(w.endpoint, w.consumer).catch(gone);
        for (const [key, pending] of _warmPending) if (key.endsWith(`\n${c.id}`)) pending.then(w => closeWarmPage(w.endpoint, w.consumer), gone).catch(gone);
    }
}

// ============================================================================================
// Routes

function managedRunning() {
    return !!(_managed && _managed.proc.exitCode === null && _managed.proc.signalCode === null);
}

function refuseNonAdmin(req, res) {
    if (!config.multiUser || req.user?.admin) return false;
    res.status(403).json({ ok: false, error: MANAGED_ADMIN_ONLY });
    return true;
}

/** The consumer a request names, or a 400 already sent. */
function consumerOf(req, res) {
    const id = req.body?.consumer;
    const consumer = typeof id === 'string' ? browserConsumer(id) : null;
    if (!consumer) {
        res.status(400).json({ ok: false, error: 'consumer must name a registered browser consumer' });
        return null;
    }
    // an extension's consumer answers as its own routes do: only while it runs, for an account that switched it on
    const refusal = consumer.refuses?.(req) ?? null;
    if (refusal) {
        res.status(404).json({ ok: false, error: refusal });
        return null;
    }
    return consumer;
}

const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const MAX_FETCH_HEADERS = 8;

export function registerBrowserRoutes(router) {
    // Managed-browser lifecycle. Start is idempotent and lazy everywhere else; this route exists
    // so the settings panel can start one on demand and report what happened.
    router.post('/browser/managed/start', async (req, res) => {
        try {
            const endpoint = await getManagedEndpoint(req, true);
            res.json({ ok: true, endpoint, browser: _managed?.browser || null, binary: _managed?.binary || null });
        } catch (err) {
            res.status(err.statusCode || 503).json({ ok: false, error: err.message, binary: findManagedBrowser() });
        }
    });

    router.post('/browser/managed/stop', async (req, res) => {
        if (refuseNonAdmin(req, res)) return;
        await stopManagedBrowser();
        res.json({ ok: true });
    });

    router.get('/browser/managed/status', (req, res) => {
        if (refuseNonAdmin(req, res)) return;
        const running = managedRunning();
        res.json({
            running,
            endpoint: running ? _managed.endpoint : null,
            browser: running ? _managed.browser : null,
            binary: running ? _managed.binary : findManagedBrowser(),
            userAgentOverridden: running ? !!_managed.ua : null,
            idleStopMinutes: MANAGED_IDLE_MS / 60000,
            lastError: _managedLastError,
            consumers: browserConsumerIds(),
        });
    });

    // capability probe: each check reported on its own, since the fix differs per check; a consumer adds its Cloudflare rows
    router.post('/browser/test', async (req, res) => {
        const checks = [];
        // optional = a warning, not a failure: for signals that correlate with trouble without deciding it
        const add = (key, label, ok, detail, optional = false) =>
            checks.push({ key, label, ok: !!ok, detail: detail || '', ...(optional ? { optional: true } : {}) });
        const consumer = req.body?.consumer !== undefined ? consumerOf(req, res) : null;
        if (req.body?.consumer !== undefined && !consumer) return;

        let client = null;
        let page = null;
        try {
            // force: pressing Test is an explicit "try again", so it skips the failure cooldown.
            const endpoint = await resolveBrowserEndpoint(req, true);
            client = await CdpClient.connect(endpoint);
            add('connect', 'Endpoint reachable', true, client.info.Browser || 'connected');
            add('browser', 'Browser version', true, client.info.Browser || 'unknown');

            page = await CdpPage.create(client);
            const ua = await page.evaluate('navigator.userAgent');
            const headless = /headless/i.test(String(ua || ''));
            add('useragent', 'User-Agent is not headless', !headless,
                headless
                    ? 'Reports HeadlessChrome, which Cloudflare-fronted sites refuse outright. Launch the browser with a real Chrome user-agent.'
                    : String(ua || '').slice(0, 120));

            add('script', 'Can run injected script', (await page.evaluate('1 + 1')) === 2);

            // reported before Cloudflare to explain a stall, never part of the verdict: a software-rendered browser clears fine
            const stack = await probeRenderStack(page);
            const software = isSoftwareRenderer(stack.renderer);
            add('gpu', 'Hardware accelerated', stack.renderer && !software,
                !stack.renderer
                    ? 'Could not read the WebGL renderer, so this browser may have WebGL disabled entirely. Only a problem if the Cloudflare check below also fails.'
                    : (software
                        ? `Rendering with ${String(stack.renderer).slice(0, 60)}, which is software. That has historically stalled the challenge, but it is not fatal by itself: what matters is the Cloudflare result below.`
                        : String(stack.renderer).slice(0, 90)),
                true);
            add('gl-extensions', 'WebGL extension count looks desktop-class', !stack.renderer || stack.exts >= 25,
                !stack.renderer
                    ? 'Skipped: no WebGL renderer to inspect.'
                    : (stack.exts < 25
                        ? `Only ${stack.exts} WebGL extensions; desktop GPUs report 30+ and mobile-class GPUs sit under 20. A weaker signal than it looks: judge by the Cloudflare result below.`
                        : `${stack.exts} extensions.`),
                true);
            add('codecs', 'H.264 and AAC available', !!stack.video && !!stack.audio,
                (!stack.video || !stack.audio)
                    ? 'This build has no proprietary codecs, which is a browser Chrome-branded builds always have. Playwright\'s Linux arm64 Chromium is the usual culprit; install real Chrome or a distro Chromium instead.'
                    : 'Present.');

            if (consumer) {
                // the path the fetches ride, so the verdict is about the gate they meet
                await page.goto(`${consumer.origin}${consumer.warmPath}`, { timeout: CDP_NAV_TIMEOUT });
                const cf = await waitForCloudflare(page);
                add('cloudflare', 'Cloudflare cleared', !cf.blocked, cf.blocked
                    ? `Still on the challenge after ${Math.round(cf.waitedMs / 1000)}s (page title: "${cf.title}"). ${cf.hint}`
                    : `Cleared in ${Math.round(cf.waitedMs / 1000)}s (page title: "${cf.title}").`);

                const cookies = await page.cookies([consumer.origin]);
                const hasClearance = cookies.some(c => c.name === 'cf_clearance');
                // clearance is bound to the UA that earned it, so report the cookie AND a passed challenge, not the cookie
                add('clearance', 'Holds a valid cf_clearance cookie', hasClearance && !cf.blocked,
                    !hasClearance
                        ? `Absent. Every request to ${new URL(consumer.origin).host} is challenged without it.`
                        : (cf.blocked
                            ? 'A cf_clearance cookie exists but the challenge still failed, so it is stale. These are tied to the user-agent that earned them, so changing launch flags invalidates them. It will be replaced once a challenge completes.'
                            : 'Present and working.'));
            }

            const required = checks.filter(c => !c.optional);
            res.json({ ok: required.every(c => c.ok), checks, browser: client.info.Browser || null });
        } catch (err) {
            // a post-connect failure must not contradict the already-recorded connect row
            if (!client) {
                add('connect', 'Endpoint reachable', false, err.message);
            } else {
                add('error', 'Test failed', false, err.message);
            }
            res.status(err.statusCode || 200).json({ ok: false, checks, error: err.message });
        } finally {
            if (page) await page.close();
            if (client) client.close();
        }
    });

    // browse transport: a same-origin fetch inside the browser (the only home of cf_clearance), the consumer's headers riding
    router.post('/browser/fetch', async (req, res) => {
        const consumer = consumerOf(req, res);
        if (!consumer) return;
        const { path: reqPath, headers, jsonBody } = req.body ?? {};
        if (typeof reqPath !== 'string' || !reqPath.startsWith(consumer.fetchPrefix) || reqPath.length > 2048) {
            return res.status(400).json({ ok: false, error: `path must be a ${consumer.fetchPrefix} path` });
        }
        // Normalize before trusting the prefix so ../ cannot climb out of it.
        let safePath;
        try {
            const u = new URL(reqPath, consumer.origin);
            if (u.origin !== consumer.origin || !u.pathname.startsWith(consumer.fetchPrefix)) {
                return res.status(403).json({ ok: false, error: `path escapes ${consumer.fetchPrefix}` });
            }
            safePath = u.pathname + u.search;
        } catch {
            return res.status(400).json({ ok: false, error: 'Malformed path' });
        }

        // GET or POST only: any other method would make this a general-purpose request forwarder
        const method = String(req.body?.method || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'POST') {
            return res.status(400).json({ ok: false, error: 'method must be GET or POST' });
        }
        if (headers !== undefined) {
            const entries = headers && typeof headers === 'object' && !Array.isArray(headers) ? Object.entries(headers) : null;
            if (!entries || entries.length > MAX_FETCH_HEADERS
                || entries.some(([k, v]) => !HEADER_NAME_RE.test(k) || typeof v !== 'string' || v.length > 4096)) {
                return res.status(400).json({ ok: false, error: `headers must be at most ${MAX_FETCH_HEADERS} string values under plain header names` });
            }
        }
        if (jsonBody !== undefined && (typeof jsonBody !== 'object' || jsonBody === null)) {
            return res.status(400).json({ ok: false, error: 'jsonBody must be an object' });
        }
        // real bodies are a single {userId} uuid; the cap matches the other generous input bounds
        if (jsonBody !== undefined && JSON.stringify(jsonBody).length > 4096) {
            return res.status(400).json({ ok: false, error: 'jsonBody too large' });
        }

        // a reader who leaves during the warm-up is not answered; the warm-up itself completes,
        // since the next request will ride the parked page
        const gone = closeSignal(res);
        let endpoint = null;
        try {
            endpoint = await resolveBrowserEndpoint(req);
            const warm = await getWarmPage(endpoint, consumer);
            if (gone.aborted) return;
            const out = await warm.page.evaluate(`(async () => {
                const h = ${JSON.stringify({ Accept: 'application/json', ...(headers || {}) })};
                const init = { credentials: 'include', headers: h, method: ${JSON.stringify(method)} };
                ${jsonBody !== undefined ? `h['Content-Type'] = 'application/json'; init.body = ${JSON.stringify(JSON.stringify(jsonBody))};` : ''}
                const r = await fetch(${JSON.stringify(safePath)}, init);
                const body = await ${PAGE_TEXT_CAPPED}(r, ${PROVIDER_RELAY_MAX_BYTES});
                return body === null ? { status: r.status, tooLarge: true } : { status: r.status, body, retryAfter: r.headers.get('retry-after') || '' };
            })()`);
            // the provider relays' answer past their cap, as relayUpstream gives it
            if (out?.tooLarge) return res.status(502).json({ ok: false, error: 'response too large' });
            res.json({ ok: true, status: out?.status ?? 0, body: out?.body ?? '', retryAfter: out?.retryAfter || '' });
        } catch (err) {
            // A dead or navigated-away page must not poison every later request.
            if (endpoint) await closeWarmPage(endpoint, consumer);
            console.warn(`[provider-services] browser fetch for ${consumer.id} failed:`, err.message);
            res.status(err.statusCode || 502).json({ ok: false, error: err.message });
        }
    });

    // sign the browser out of a consumer's origin; Cloudflare's own cookies stay (not account state, a fresh challenge costs)
    router.post('/browser/cookies/clear', async (req, res) => {
        const consumer = consumerOf(req, res);
        if (!consumer) return;
        try {
            const endpoint = await resolveBrowserEndpoint(req);
            const host = new URL(consumer.origin).hostname;
            const cleared = await withPage(endpoint, async (page) => {
                const cookies = await page.cookies([consumer.origin]);
                const names = [];
                for (const c of cookies) {
                    if (c.name === 'cf_clearance' || c.name === '__cf_bm') continue;
                    try {
                        await page.send('Network.deleteCookies', {
                            name: c.name,
                            domain: c.domain || host,
                            path: c.path || '/',
                        });
                        names.push(c.name);
                    } catch { /* one stubborn cookie must not abandon the rest */ }
                }
                return names;
            });
            res.json({ ok: true, cleared });
        } catch (err) {
            console.warn(`[provider-services] browser cookie clear for ${consumer.id} failed:`, err.message);
            res.status(err.statusCode || 502).json({ ok: false, error: err.message });
        }
    });
}
