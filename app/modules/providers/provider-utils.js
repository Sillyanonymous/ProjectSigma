// Provider Utilities - shared helpers used across all providers
//
// Contains network helpers, text utilities, image processing,
// and the import pipeline shared by all provider implementations.

import CoreAPI from '../core-api.js';
import { runCommand } from '../ext-registry.js';

// ========================================
// CONSTANTS
// ========================================

export const IMG_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/%3E";

export const PROVIDER_SERVICES_BASE = '/provider-services';

// the keys one probe POST names (the name, link and shelf probes): the server refuses a longer page
export const PROBE_PAGE = 500;

// read at event time, never at attach: the modal listener guards never reset, so a snapshot goes stale
export function isMobileMode() {
    return CoreAPI.isMobileMode();
}

// Jump the browse list to the top so a new result set doesnt strand the user mid-list; mobile only.
export function scrollBrowseListTop() {
    if (!isMobileMode()) return;
    const sc = document.querySelector('.gallery-content');
    if (sc) sc.scrollTop = 0;
}

// XSS gate for any third-party browse content rendered via innerHTML.
// Never bypass; never duplicate this config per-provider.
export const BROWSE_PURIFY_CONFIG = {
    // no style tag: an inline <style> is document-global; authored CSS goes through the sandboxed iframe
    ALLOWED_TAGS: [
        'p', 'br', 'hr', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'code', 'pre',
        'ul', 'ol', 'li', 'a', 'img', 'center', 'font',
        'table', 'thead', 'tbody', 'tr', 'th', 'td', 'details', 'summary'
    ],
    ALLOWED_ATTR: [
        'href', 'src', 'alt', 'title', 'class', 'style', 'target', 'rel',
        'width', 'height', 'loading', 'color', 'size', 'align'
    ],
    ALLOW_DATA_ATTR: false
};

// a preset's cards: inline SVG without script, foreignObject, image or animation; their CSS is scoped in the chats module
const CHAT_SVG_TAGS = [
    'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'defs', 'lineargradient', 'radialgradient',
    'stop', 'clippath', 'mask', 'pattern', 'symbol', 'use', 'marker', 'text', 'tspan', 'filter', 'fegaussianblur', 'feoffset',
    'femerge', 'femergenode', 'fecolormatrix', 'feblend', 'feflood', 'fecomposite', 'fedropshadow',
];
const CHAT_SVG_ATTRS = [
    'viewbox', 'xmlns', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity', 'd', 'cx', 'cy', 'r', 'rx', 'ry',
    'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points', 'transform', 'offset', 'stop-color', 'stop-opacity', 'gradientunits',
    'gradienttransform', 'spreadmethod', 'fx', 'fy', 'fr', 'clip-path', 'clippathunits', 'clip-rule', 'mask', 'maskunits',
    'maskcontentunits', 'filter', 'filterunits', 'primitiveunits', 'stddeviation', 'dx', 'dy', 'in', 'in2', 'result', 'mode',
    'operator', 'values', 'flood-color', 'flood-opacity', 'k1', 'k2', 'k3', 'k4', 'patternunits', 'patterncontentunits',
    'patterntransform', 'preserveaspectratio', 'marker-start', 'marker-mid', 'marker-end', 'markerwidth', 'markerheight',
    'markerunits', 'refx', 'refy', 'orient', 'text-anchor', 'dominant-baseline', 'font-family', 'font-size', 'font-weight',
    'letter-spacing', 'pathlength', 'vector-effect', 'xlink:href',
];
// the gate for chat message bodies (first_mes and replies are untrusted); never widen it without re-reading formatChatText
export const CHAT_PURIFY_CONFIG = {
    ALLOWED_TAGS: [
        ...BROWSE_PURIFY_CONFIG.ALLOWED_TAGS,
        'q', 'mark', 'sub', 'sup', 'kbd', 'abbr', 'dl', 'dt', 'dd', 'small',
        'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'figure', 'figcaption', 'time', 'caption', 'tfoot',
        ...CHAT_SVG_TAGS,
    ],
    ALLOWED_ATTR: [...BROWSE_PURIFY_CONFIG.ALLOWED_ATTR, 'id', 'role', ...CHAT_SVG_ATTRS],
    // the app's own controls are found by their data-* attributes, so a body never carries one as written
    ALLOW_DATA_ATTR: false,
    // every id becomes user-content-<id>, so none can shadow a page global (window.<id>)
    SANITIZE_NAMED_PROPS: true,
};
// the chat transcript's: data-* kept for a preset's cards, renamed data-user-* by the chats module before the page sees it
export const CHAT_MESSAGE_PURIFY_CONFIG = { ...CHAT_PURIFY_CONFIG, ALLOW_DATA_ATTR: true };
// frozen with their lists, so safePurify reads each once
for (const config of [BROWSE_PURIFY_CONFIG, CHAT_PURIFY_CONFIG, CHAT_MESSAGE_PURIFY_CONFIG]) {
    for (const list of Object.values(config)) if (Array.isArray(list)) Object.freeze(list);
    Object.freeze(config);
}

// n shimmer rows, last two tapered so it reads as a paragraph not a bar block.
export function skeletonLines(n = 3) {
    if (n <= 0) return '';
    const out = [];
    for (let i = 0; i < n; i++) {
        const cls = i === n - 1 ? 'cl-skeleton-line shorter'
                  : i === n - 2 ? 'cl-skeleton-line short'
                  : 'cl-skeleton-line';
        out.push(`<div class="${cls}"></div>`);
    }
    return out.join('');
}

/** Hide the sections a detail view painted as skeletons when the detail never arrived. */
export function hideSections(ids) {
    for (const id of ids) {
        const el = document.getElementById(id);
        if (el) el.hidden = true;
    }
}

// heavy preview fields build one per frame and only on screen; hidden or below-fold jobs park until revealed
let _deferQueue = [];
let _deferRaf = 0;
const _deferParked = new WeakMap(); // el -> job, waiting for first reveal
let _deferIO = null;

// 200px lookahead so a slow scroll meets built content instead of a skeleton.
const DEFER_REVEAL_MARGIN = 200;

// In-layout + within (margin-padded) viewport. getClientRects() is empty for display:none but not
// for zero-height boxes, so still-empty containers (eg. alt-greeting bodies) count as visible.
function _deferOnScreen(el) {
    if (!el.getClientRects().length) return false;
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight + DEFER_REVEAL_MARGIN && r.bottom > -DEFER_REVEAL_MARGIN;
}

function _deferReveal() {
    if (_deferIO) return _deferIO;
    _deferIO = new IntersectionObserver((entries) => {
        for (const en of entries) {
            if (!en.isIntersecting) continue;
            _deferIO.unobserve(en.target);
            const job = _deferParked.get(en.target);
            if (job) { _deferParked.delete(en.target); _enqueueDeferJob(job); }
        }
    }, { rootMargin: `${DEFER_REVEAL_MARGIN}px` });
    return _deferIO;
}

function _pumpDefer() {
    _deferRaf = 0;
    const job = _deferQueue.shift();
    if (job && job.el && job.el.isConnected) {
        if (_deferOnScreen(job.el)) {
            const t0 = performance.now();
            // build jobs assign innerHTML; call jobs run a side effect (eg. append a sanitized iframe).
            try { if (job.run) job.run(); else job.el.innerHTML = job.build(); } catch { /* skip a field that fails */ }
            CoreAPI.debugLog(`[defer] ${(performance.now() - t0).toFixed(1)}ms`, job.el.id || job.el.className);
        } else {
            _deferParked.set(job.el, job);
            _deferReveal().observe(job.el);
        }
    }
    if (_deferQueue.length) _deferRaf = requestAnimationFrame(_pumpDefer);
}

// re-using an element replaces its pending job, so a reopened preview never paints the prior card
function _enqueueDeferJob(job) {
    _deferParked.delete(job.el);
    const i = _deferQueue.findIndex(j => j.el === job.el);
    if (i !== -1) _deferQueue.splice(i, 1);
    _deferQueue.push(job);
    if (!_deferRaf) _deferRaf = requestAnimationFrame(_pumpDefer);
}

// build() returns HTML assigned via `el.innerHTML` in the pump (a text field's sanitize pipeline).
export function deferRender(el, build) {
    if (!el || typeof build !== 'function') return;
    _enqueueDeferJob({ el, build });
}

// run() runs a side-effecting callback in the pump instead of assigning innerHTML, for renders that
// append nodes themselves (eg. renderCreatorNotesSecure's sanitized iframe). Same pacing + parking.
export function deferCall(el, run) {
    if (!el || typeof run !== 'function') return;
    _enqueueDeferJob({ el, run });
}

// ========================================
// NETWORK
// ========================================

const _proxyOrigins = new Set();

// Short human snippet from an error body: JSON detail/message/error fields
// when present, else the tag-stripped raw start. Capped at 200 chars.
function errorSnippetFromText(text) {
    const t = (text || '').trim();
    if (!t) return '';
    try {
        const j = JSON.parse(t);
        const msg = j?.detail || j?.message || j?.error;
        if (typeof msg === 'string' && msg) return `: ${msg.slice(0, 200)}`;
        if (msg) return `: ${JSON.stringify(msg).slice(0, 200)}`;
    } catch { /* not JSON; fall through to raw */ }
    return `: ${t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}

// Cloudflare interstitial signatures (block page, JS challenge, managed challenge)
export function isCloudflareBlockPage(text) {
    return /Attention Required! \| Cloudflare|cf-error-details|Just a moment|__cf_chl/i.test((text || '').slice(0, 2000));
}

// an error-page signature to an actionable message, else null; exported for transports with no Response (janitorai's hampter chain)
export function classifyErrorPage(text, status, transport = null) {
    const head = (text || '').slice(0, 2000);
    // zstd frame magic 28 B5 2F FD reads as '(' U+FFFD '/' U+FFFD; /api/proxy pins accept-encoding, so a hit came another way
    if (head.charCodeAt(0) === 0x28 && head.charCodeAt(1) === 0xFFFD
        && head.charCodeAt(2) === 0x2F && head.charCodeAt(3) === 0xFFFD) {
        return `The response arrived zstd-compressed and could not be decoded (HTTP ${status})`;
    }
    // Served as HTTP 200 HTML during upstream maintenance / load shedding.
    if (/JanitorAI\s*-\s*Waiting Room/i.test(head)) {
        return 'JanitorAI is in its waiting room (high load or maintenance). This clears on their side; retry in a minute';
    }
    if (isCloudflareBlockPage(head)) {
        return `Cloudflare blocked this request${transport ? ` from ${transport}` : ''} (HTTP ${status})`;
    }
    return null;
}

// The status/bodySnippet fields feed the copy-diagnostics report on browse error banners
function classifiedError(message, status, text) {
    const err = new Error(message);
    err.classified = true;
    err.status = status;
    err.bodySnippet = (text || '').slice(0, 300);
    return err;
}

export function httpFailureError(status, text, transport = null) {
    const pageMsg = classifyErrorPage(text, status, transport);
    const err = classifiedError(pageMsg || `HTTP ${status}${errorSnippetFromText(text)}`, status, text);
    // real auth statuses only: a Cloudflare 403 challenge must not read as an expired token
    if (!pageMsg && (status === 401 || status === 403)) err.authFailed = true;
    return err;
}

/**
 * A pasted or typed link as a URL, its scheme defaulted to https; null when it is not one.
 * @param {string} text
 * @returns {URL|null}
 */
export function parseProviderUrl(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    // case-blind: a phone keyboard's "Https://" must not gain a second scheme
    try { return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
}

/**
 * Encode a URL for /api/proxy/, escaping !'()* too: some WAFs 403 literal parens (postimg "(1)" filenames).
 * @param {string} url
 * @returns {string}
 */
export function proxyEncode(url) {
    return encodeURIComponent(url).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * The server's pass-through for a URL, against the configured server: a detached client
 * must never ask its static host for /api/proxy.
 * @param {string} url
 * @returns {string}
 */
export function proxiedUrl(url) {
    return CoreAPI.serverUrl(`/api/proxy/${proxyEncode(url)}`);
}

/**
 * Fetch with automatic CORS proxy fallback.
 * Remembers origins that need proxying to avoid redundant direct attempts.
 * @param {string} url
 * @param {Object} [opts] - fetch options
 * @returns {Promise<Response>}
 */
export async function fetchWithProxy(url, opts = {}) {
    const origin = new URL(url).origin;
    if (!_proxyOrigins.has(origin)) {
        let directResponse;
        try {
            directResponse = await fetch(url, opts);
        } catch (e) {
            if (e?.name === 'AbortError' || opts.signal?.aborted) throw e; // the reader's cancel or timeout, never a CORS signal: not cached
            // fetch() rejects on CORS/network errors - fall through to proxy
            _proxyOrigins.add(origin);
        }
        if (directResponse) {
            if (!directResponse.ok) throw httpFailureError(directResponse.status, await directResponse.text().catch(() => ''), 'a direct request');
            return directResponse;
        }
    }
    let r;
    try {
        r = await fetch(proxiedUrl(url), opts);
    } catch (e) {
        if (e?.name === 'AbortError' || opts.signal?.aborted) throw e;
        // Same-origin reject means our own server is unreachable, not a provider problem
        throw classifiedError('Could not reach the Project Σ server (connection dropped or the server is not running)', null, '');
    }
    if (!r.ok) {
        const t = await r.text().catch(() => '');
        // our proxy answers 502 + {"error"} when its own fetch failed (DNS, VPN); an upstream's 502 has a real body
        if (r.status === 502 && /^\s*\{\s*"error"/.test(t)) {
            throw classifiedError(`The server could not reach ${origin} (network, DNS, or VPN problem)`, 502, t);
        }
        // A Cloudflare-blocked proxy leg is unrecoverable server-side; evict the origin so
        // the next call retries the browser-direct leg, which can pass where the server cannot.
        if (isCloudflareBlockPage(t)) _proxyOrigins.delete(origin);
        throw httpFailureError(r.status, t, 'the server');
    }
    return r;
}

// ========================================
// BROWSE ERROR BANNER
// ========================================

let _envInfoPromise = null;
let _browseErrorDelegateWired = false;

// Gathered once per session, and only when someone actually clicks the report button
function gatherEnvInfo() {
    if (!_envInfoPromise) {
        _envInfoPromise = (async () => {
            const [server, services] = await Promise.all([
                CoreAPI.apiRequest('/health').then(r => r.json()).catch(() => null),
                (async () => {
                    try { return await (await CoreAPI.apiRequest(`${PROVIDER_SERVICES_BASE}/health`)).json(); } catch { return null; }
                })(),
            ]);
            return {
                cl: server?.version || 'unknown',
                services: services?.ok ? 'ok' : 'unreachable',
                basicAuth: services?.ok ? !!services.basicAuth : null,
            };
        })();
    }
    return _envInfoPromise;
}

const onOff = (v) => (v === null || v === undefined ? 'unknown' : (v ? 'on' : 'off'));

async function buildBrowseErrorReport(c) {
    const env = await gatherEnvInfo();
    const err = c.error || {};
    const flags = Object.entries(c.flags || {}).map(([k, v]) => `${k}=${v}`).join(' | ');
    const lines = [
        `Project Σ v${env.cl} browse error report (${c.time})`,
        `provider: ${c.provider} | view: ${c.view}`,
        `error: ${err.message || String(err)}`,
    ];
    if (err.status != null) lines.push(`http: ${err.status}`);
    if (err.bodySnippet) lines.push(`body: ${err.bodySnippet}`);
    if (flags) lines.push(`settings: ${flags}`);
    lines.push(`provider services: ${env.services}`);
    lines.push(`env: basicAuth=${onOff(env.basicAuth)} | mode=${isMobileMode() ? 'mobile' : 'desktop'} | online=${onOff(navigator.onLine)}`);
    lines.push(`ua: ${navigator.userAgent}`);
    return lines.join('\n');
}

function wireBrowseErrorDelegate() {
    if (_browseErrorDelegateWired) return;
    _browseErrorDelegateWired = true;
    document.addEventListener('click', async (e) => {
        // ctx rides the clicked banner, so a stale one in a hidden section cant fire another view's retry
        const ctx = e.target.closest('.browse-error-banner')?._browseErrorCtx;
        if (!ctx) return;
        if (e.target.closest('.browse-banner-retry')) {
            ctx.retry?.();
            return;
        }
        if (e.target.closest('.browse-banner-report')) {
            const ok = await CoreAPI.copyTextToClipboard(await buildBrowseErrorReport(ctx));
            CoreAPI.showToast(ok ? 'Error report copied to clipboard' : 'Could not copy to clipboard', ok ? 'success' : 'error');
        }
    });
}

/**
 * Render the canonical browse error banner; flags stay set/unset booleans, never token or cookie values.
 * @param {HTMLElement} grid
 * @param {Object} opts
 * @param {string} opts.provider - provider id for the report
 * @param {Error|Object} opts.error - ideally a readJsonClassified error (status/bodySnippet ride into the report)
 * @param {string} [opts.message] - display line, defaults to error.message
 * @param {string} [opts.title] - optional heading line
 * @param {string} [opts.view] - browse | timeline | favorites | creator, may carry a sort suffix
 * @param {Object} [opts.flags] - eg. { token: true, nsfw: false }
 * @param {Function} [opts.retry] - omit to render without a Retry button
 * @param {{label: string, section: string}} [opts.guide] - a button opening the user guide at that section
 */
export function renderBrowseError(grid, { provider, error, message, title, view = 'browse', flags = {}, retry, guide } = {}) {
    if (!grid) return;
    wireBrowseErrorDelegate();
    const esc = CoreAPI.escapeHtml;
    grid.innerHTML = `
        <div class="browse-error-banner">
            <i class="fa-solid fa-exclamation-triangle"></i>
            ${title ? `<h3>${esc(title)}</h3>` : ''}
            ${message || error?.message ? `<p>${esc(message || error.message)}</p>` : ''}
            <div class="browse-error-actions">
                ${retry ? '<button class="glass-btn browse-banner-retry"><i class="fa-solid fa-redo"></i> Retry</button>' : ''}
                ${guide ? `<button class="glass-btn browse-banner-guide" data-guide-link="${esc(guide.section)}"><i class="fa-solid fa-book-open"></i> ${esc(guide.label)}</button>` : ''}
                <button class="glass-btn browse-banner-report"><i class="fa-solid fa-copy"></i> Copy Error Report</button>
            </div>
        </div>
    `;
    const banner = grid.querySelector('.browse-error-banner');
    if (banner) banner._browseErrorCtx = { provider, error, view, flags, retry, time: new Date().toISOString() };
}

/**
 * The in-modal provider notice (channel 4) as an HTML string to compose; the caller wires each data-notice-action key.
 * @param {Object} opts
 * @param {'locked'|'hidden'|'info'|'warning'|'error'} [opts.kind='info'] - colour + default icon
 * @param {'banner'|'cta'} [opts.layout='banner'] - inline strip vs centered empty-state call-to-action
 * @param {string} [opts.icon] - FA class override
 * @param {string} [opts.title] - bold headline
 * @param {string} [opts.message] - body line
 * @param {string} [opts.hint] - muted secondary line (cta layout)
 * @param {Array<{key:string,label:string,icon?:string,variant?:string}>} [opts.actions] - buttons
 * @param {{label: string, section: string}} [opts.guide] - a button opening the user guide at that section
 * @returns {string}
 */
export function buildProviderNotice({ kind = 'info', layout = 'banner', icon, title, message, hint, actions = [], guide } = {}) {
    const esc = CoreAPI.escapeHtml;
    const DEFAULT_ICON = { locked: 'fa-lock', hidden: 'fa-eye-slash', warning: 'fa-triangle-exclamation', error: 'fa-triangle-exclamation', info: 'fa-circle-info' };
    const iconClass = icon || `fa-solid ${DEFAULT_ICON[kind] || DEFAULT_ICON.info}`;
    const btnBase = layout === 'cta' ? 'cl-btn' : 'glass-btn';
    const btns = actions.map(a => {
        // a cta rides the dialog family, whose colour variants carry the family prefix
        const variant = layout === 'cta' ? `cl-btn-${a.variant || 'primary'}` : (a.variant || '');
        const ico = a.icon ? `<i class="${a.icon}"></i> ` : '';
        return `<button type="button" class="${btnBase}${variant ? ' ' + variant : ''} browse-notice-action" data-notice-action="${esc(a.key)}">${ico}${esc(a.label)}</button>`;
    }).join('')
        // the app's data-guide-link handler opens it, so no caller wires the guide button
        + (guide ? `<button type="button" class="${btnBase}${layout === 'cta' ? ' cl-btn-secondary' : ''} browse-notice-action" data-guide-link="${esc(guide.section)}"><i class="fa-solid fa-book-open"></i> ${esc(guide.label)}</button>` : '');
    const actionsHtml = btns ? `<div class="browse-notice-actions">${btns}</div>` : '';
    // banner actions are a flex sibling of the body so margin-left:auto trails them on the text row
    return `
        <div class="browse-notice browse-notice-${esc(kind)}${layout === 'cta' ? ' browse-notice-cta' : ''}">
            <div class="browse-notice-icon"><i class="${iconClass}"></i></div>
            <div class="browse-notice-body">
                ${title ? `<strong class="browse-notice-title">${esc(title)}</strong>` : ''}
                ${message ? `<p class="browse-notice-message">${esc(message)}</p>` : ''}
                ${hint ? `<p class="browse-notice-hint">${esc(hint)}</p>` : ''}
                ${layout === 'cta' ? actionsHtml : ''}
            </div>
            ${layout === 'cta' ? '' : actionsHtml}
        </div>
    `;
}

/**
 * The preview's fetch-failed state: the definition did not load, and the hint says what an
 * import gets now.
 * @param {string} [consequence] - what importing now does, in the provider's words
 * @param {string} [reason] - the headline, when the provider knows why it failed
 * @param {{label: string, section: string}} [guide] - a button opening the user guide at that section
 * @returns {string}
 */
export function definitionFailedNotice(consequence, reason = "Could not load this character's definition.", guide) {
    return buildProviderNotice({ kind: 'warning', layout: 'cta', message: reason, hint: consequence, guide });
}

/**
 * Read a JSON-expected Response, classifying failures (ISP/Cloudflare error
 * pages, the disabled CORS proxy) into actionable errors instead of parser noise.
 * @param {Response} resp
 * @returns {Promise<any>}
 */
export async function readJsonClassified(resp) {
    const text = await resp.text().catch(() => '');
    if (resp.ok) {
        try { return JSON.parse(text); } catch { /* classified below */ }
    }
    throw !resp.ok
        ? httpFailureError(resp.status, text)
        : classifiedError(classifyErrorPage(text, resp.status)
            || `The provider returned an error page instead of data (HTTP ${resp.status})`, resp.status, text);
}

/**
 * A definitive miss (404, 410): the one case a remote-card fetcher answers null; everything else throws.
 */
export function isRemoteMiss(err) {
    return err?.status === 404 || err?.status === 410;
}
export async function nullOnMiss(fn) {
    try { return await fn(); } catch (e) { if (isRemoteMiss(e)) return null; throw e; }
}

// ========================================
// TEXT UTILITIES
// ========================================

/**
 * Slugify a string for use in filenames and URL paths.
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
    return (name || 'character')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 60);
}

const HTML_ENTITY_NAMES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * Decode HTML entities without stripping tags (janitorai's listings send creator notes escaped).
 * @param {string} s
 * @returns {string}
 */
export function decodeHtmlEntities(s) {
    if (!s || typeof s !== 'string') return s || '';
    if (s.indexOf('&') === -1) return s;
    // one pass, so an escaped entity (&amp;lt;) comes out as the text it spells (&lt;), never decoded twice
    return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (all, e) => {
        if (e[0] !== '#') return HTML_ENTITY_NAMES[e.toLowerCase()] ?? all;
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : all;
    });
}

/**
 * Strip HTML tags and decode common entities.
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
    if (!html) return '';
    // only what parses as a tag or a comment: a bare "<" in prose ("I <3 you") is text, and ate up to the next ">"
    return decodeHtmlEntities(html.replace(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>/g, '')).trim();
}

/**
 * Point root-relative media (markdown images, <img src>) at the provider's site; //host and absolute URLs pass.
 * @param {string} text
 * @param {string} base - provider site origin, eg 'https://botbooru.com'
 * @returns {string}
 */
export function absolutizeMediaPaths(text, base) {
    if (!text || !base) return text || '';
    const root = String(base).replace(/\/+$/, '');
    return String(text)
        .replace(/(!\[[^\]]*\]\()\/(?!\/)/g, (m, p1) => `${p1}${root}/`)
        .replace(/(<img\s[^>]*?src=["'])\/(?!\/)/gi, (m, p1) => `${p1}${root}/`);
}

/** A finite number as itself, anything else as null (the listing adapters' stat coercion). */
export function finiteOrNull(v) {
    return Number.isFinite(v) ? v : null;
}

/**
 * Whether a listing has another page: by the site's total when it gives one, else a short page is the last.
 * @param {number|null} total @param {number} seen rows consumed through this page @param {number} pageCount rows on this page @param {number} limit
 */
export function pageHasMore(total, seen, pageCount, limit) {
    return total != null ? seen < total : pageCount === limit;
}

/**
 * Format a number with K/M suffixes.
 * @param {number} num
 * @returns {string}
 */
export function formatNumber(num) {
    return CoreAPI.formatNumber(num);
}

// ========================================
// IMAGE PROCESSING
// ========================================

// budget by area, not long edge (which punishes tall cards hardest); the edge clamp backstops panoramas
const MAX_AVATAR_PIXELS = 8_000_000;
const MAX_AVATAR_EDGE = 8192;

// PNG keeps its size in the first chunk, so an oversized one is spotted without a decode; null = unreadable
function pngDimensions(buffer) {
    if (buffer.byteLength < 24) return null;
    const view = new DataView(buffer);
    if (view.getUint32(12) !== 0x49484452) return null;
    return { width: view.getUint32(16), height: view.getUint32(20) };
}

// One policy shared by the passthrough check and the resize, so the two cannot drift apart.
function avatarScale(width, height) {
    if (!width || !height) return 1;
    return Math.min(
        1,
        Math.sqrt(MAX_AVATAR_PIXELS / (width * height)),
        MAX_AVATAR_EDGE / Math.max(width, height),
    );
}

/**
 * Ensure a buffer is PNG within the avatar budget: an in-budget PNG returns as-is, else OffscreenCanvas or api.convertImageToPng.
 * @param {ArrayBuffer} imageBuffer
 * @param {Object} [api] - CoreAPI reference for convertImageToPng fallback
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function ensurePng(imageBuffer, api) {
    // An empty or truncated body still resolves as a buffer, and the header read throws on it.
    if (!imageBuffer || imageBuffer.byteLength < 4) return null;

    const header = new Uint8Array(imageBuffer, 0, 4);
    const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47;
    if (isPng) {
        const dims = pngDimensions(imageBuffer);
        if (!dims || avatarScale(dims.width, dims.height) === 1) return imageBuffer;
    }

    try {
        const blob = new Blob([imageBuffer]);
        const bitmap = await createImageBitmap(blob);
        const scale = avatarScale(bitmap.width, bitmap.height);
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        if (scale < 1) {
            CoreAPI.debugLog(`[ProviderUtils] avatar ${bitmap.width}x${bitmap.height} scaled to ${width}x${height}`);
        }
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
        return await pngBlob.arrayBuffer();
    } catch (e1) {
        try {
            if (api?.convertImageToPng) return await api.convertImageToPng(imageBuffer);
        } catch (e2) {
            console.warn('[ProviderUtils] PNG conversion failed:', e2.message);
        }
    }
    return null;
}

/**
 * Generate a 256x256 dark gray placeholder PNG with a "?" character.
 * @returns {Promise<ArrayBuffer>}
 */
export async function generatePlaceholder() {
    const canvas = new OffscreenCanvas(256, 256);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#333';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#666';
    ctx.font = '100px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', 128, 128);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return await blob.arrayBuffer();
}

// the shared post-import tail; the timings are deliberate (a phone opens the summary over the preview first)
export async function finishBrowseImport({ view, summaryArgs, showSummary, closePreview, importBtn, characterName, localCharId, hit, alreadyPresent = false, replaced = false, skippedReason = null, batch = false }) {
    if (showSummary) {
        if (isMobileMode()) {
            CoreAPI.showImportSummaryModal(summaryArgs);
            await new Promise(r => setTimeout(r, 220));
            closePreview();
        } else {
            closePreview();
            await new Promise(r => requestAnimationFrame(r));
            CoreAPI.showImportSummaryModal(summaryArgs);
        }
    } else {
        if (importBtn) importBtn.innerHTML = '<i class="fa-solid fa-check"></i> Imported';
        await new Promise(r => setTimeout(r, 350));
        closePreview();
    }

    // a server-skipped import answers with the existing character: said here for one import, and once
    // in its lane's summary for one of a batch
    if (alreadyPresent) {
        if (!batch) {
            CoreAPI.showToast(skippedReason === 'identical'
                ? `"${characterName}" is already in your library (identical)`
                : `"${characterName}" differs from a character already in your library; nothing was changed`, 'info');
        }
    } else {
        CoreAPI.showToast(replaced ? `Replaced with "${characterName}"` : `Imported "${characterName}"`, 'success', 3000, {
            group: 'import-activity', item: { kind: 'imported', name: characterName }, many: CoreAPI.summarizeImportActivity,
        });
    }

    await new Promise(r => setTimeout(r, 200));
    // character.import adopted a made or replaced one; a skipped one it never took in
    if (alreadyPresent) {
        const added = CoreAPI.getCharacterById(localCharId) || await CoreAPI.fetchAndAddCharacter(localCharId);
        if (added) {
            view.addCharToLookup(added);
        } else {
            await new Promise(r => setTimeout(r, 500));
            await CoreAPI.refreshCharacters(true);
        }
    }
    // light the source card from the server's answer for its stamped key; the heal covers every painted grid
    const key = view.hitLinkKey(hit);
    if (key != null && key !== '') await view.probeLinkKeys([key]);
    view.refreshInLibraryBadges();
}

// ========================================
// IMPORT PIPELINE
// ========================================

// The card a provider hands over, fitted the same way whichever route it takes to the server
function fitProviderCard(characterCard) {
    // Import Rules ruleset fires here so every provider path gets it (browse, URL paste, CD)
    if (Array.isArray(characterCard?.data?.tags)) {
        characterCard.data.tags = CoreAPI.applyTagAliases(characterCard.data.tags);
    }
}

// The character an import is written onto: onExisting { replace: id } (the duplicate dialog's
// Replace), carried through every provider untouched beside the other choices
const replaceTargetOf = (onExisting) => (onExisting && typeof onExisting === 'object' && onExisting.replace ? String(onExisting.replace) : null);

// The server's answer as a ProviderImportResult, whichever route the card took
async function providerImportResult(result, { characterCard, characterName, hasGallery, providerCharId, fullPath, avatarUrl, api, missing = [] }) {
    // a server-side skip is said by the surface that ran the import, which knows if it was one of a batch
    const mediaUrls = api.findCharacterMediaUrls(characterCard) || [];
    await CoreAPI.ensureExtractorsLoaded();
    const galleryPageUrls = CoreAPI.findCharacterGalleryUrls(characterCard);
    // identity is the server row, never the filename: a name-derived fallback let an import overwrite a character
    if (!result?.id) throw new Error('Import failed: server returned no character id');

    return {
        success: true,
        id: result.id,
        alreadyPresent: !!result.skipped,
        // written onto an existing character (the duplicate dialog's Replace): the id is that character's
        replaced: !!result.replaced,
        skippedReason: result.skipped ? result.reason : null,
        // the name as stored (the server caps it), for what it wrote; a skip names the incoming card
        characterName: (!result.skipped && result.name) || characterCard.data?.name || characterName,
        hasGallery,
        providerCharId,
        fullPath,
        avatarUrl,
        embeddedMediaUrls: mediaUrls,
        galleryPageUrls,
        cardData: characterCard.data,
        // gallery rows the card file brought itself (a charx's assets); a PNG brings none
        mediaCount: result.media || 0,
        // the row as the list answers it, taken in without a second read; a skip adopts nothing
        row: result.skipped ? null : (result.row || null),
        // what the card came in without, in the reader's words; character.import says it
        missing: result.skipped ? [] : [...new Set(missing)],
    };
}

/**
 * Shared import pipeline: PNG conversion, card embedding, the import POST, result normalization.
 * @param {Object} params
 * @param {Object} params.characterCard - V2 character card to embed
 * @param {ArrayBuffer|null} params.imageBuffer - avatar image (any format)
 * @param {string} params.characterName - display name for toasts/results
 * @param {boolean} [params.hasGallery=false] - whether gallery images exist
 * @param {string|number|null} [params.providerCharId] - provider-side ID
 * @param {string|null} [params.fullPath] - canonical path on provider
 * @param {string|null} [params.avatarUrl] - remote avatar URL for display
 * @param {'copy'|{replace: string}|null} [params.onExisting=null] - 'copy' forces a new character (Import Anyway); without it the server skips a duplicate (alreadyPresent)
 * @param {string[]} [params.missing=[]] - what the provider could not fetch, eg. 'its picture'; a partial import still imports
 * @param {Object} params.api - CoreAPI reference
 * @returns {Promise<Object>} ProviderImportResult
 */
export async function importFromPng({
    characterCard,
    imageBuffer,
    characterName,
    hasGallery = false,
    providerCharId = null,
    fullPath = null,
    avatarUrl = null,
    onExisting = null,
    source = null,
    missing = [],
    api
}) {
    fitProviderCard(characterCard);

    const handedBytes = !!imageBuffer?.byteLength;
    let pngBuffer = await ensurePng(imageBuffer, api);
    imageBuffer = null;

    if (!pngBuffer) {
        // bytes that would not decode are a lost picture too, not just bytes never fetched
        if (handedBytes) missing = [...missing, 'its picture'];
        pngBuffer = await generatePlaceholder();
    }

    let embeddedPng = api.embedCharacterDataInPng(pngBuffer, characterCard);
    pngBuffer = null;

    // no ?name=: a display-name identity alias overwrote whoever held that name; identity rides the card's provider link
    const qs = new URLSearchParams();
    if (onExisting === 'copy') qs.set('onExisting', 'copy');
    // one link per character: the importing provider wins over foreign namespaces
    // embedded in the card (a botbooru repost still wearing its chub origin)
    if (source) qs.set('source', source);
    const importQs = qs.toString() ? `?${qs}` : '';
    const endpoint = replaceTargetOf(onExisting)
        ? `/characters/${encodeURIComponent(replaceTargetOf(onExisting))}/replace${importQs}`
        : `/characters/import${importQs}`;
    const importResponse = await CoreAPI.apiRequest(endpoint, 'POST', embeddedPng, {
        raw: true, headers: { 'Content-Type': 'image/png' },
    });
    embeddedPng = null;

    const result = await CoreAPI.readAnswer(importResponse);
    return providerImportResult(result, { characterCard, characterName, hasGallery, providerCharId, fullPath, avatarUrl, api, missing });
}

/**
 * Import a staged card file (a charx via ctx.imports.stage): fitted like importFromPng, committed with the staged files; a failed commit drops the stage.
 * @param {Object} params
 * @param {string} params.stageId - the stage the server half answered
 * @param {Object} params.characterCard - the staged card, amended by the provider
 * @param {string} params.characterName - display name for toasts/results
 * @param {'copy'|null} [params.onExisting=null] - as importFromPng's
 * @param {string|null} [params.source=null] - the provider namespace the import came through
 * @param {Object} params.api - CoreAPI reference
 * @returns {Promise<Object>} ProviderImportResult, with mediaCount
 */
export async function importFromStage({
    stageId,
    characterCard,
    characterName,
    hasGallery = false,
    providerCharId = null,
    fullPath = null,
    avatarUrl = null,
    onExisting = null,
    source = null,
    api
}) {
    fitProviderCard(characterCard);
    let result;
    try {
        const target = replaceTargetOf(onExisting);
        result = await CoreAPI.readAnswer(target
            ? await CoreAPI.apiRequest(`/characters/${encodeURIComponent(target)}/replace`, 'POST', { stage: stageId, card: characterCard, source: source || undefined })
            : await CoreAPI.apiRequest(`/characters/import/stage/${encodeURIComponent(stageId)}`, 'POST', {
                card: characterCard, source: source || undefined, onExisting: onExisting === 'copy' ? 'copy' : undefined,
            }));
    } catch (e) {
        // a refusal hands the stage back and nothing will retry it: the hour would keep the file
        CoreAPI.apiRequest(`/characters/import/stage/${encodeURIComponent(stageId)}`, 'DELETE').catch(() => { /* the server's hour sweep takes a stage this could not hand back */ });
        throw e;
    }
    return providerImportResult(result, { characterCard, characterName, hasGallery, providerCharId, fullPath, avatarUrl, api });
}

/**
 * A browse view's import of one of its provider's characters, run as character.import so a
 * wrapper sees it; the command takes the new character in.
 * @param {Object} provider - the provider the view browses
 * @param {string|number} identifier - the character's id there
 * @param {Object|null} data - what the view already fetched
 * @param {Object} [options] - onExisting, and the provider's own options
 * @returns {Promise<Object>} ProviderImportResult
 */
export async function importThroughCommand(provider, identifier, data, { onExisting = null, ...options } = {}) {
    const result = await runCommand('character.import', { provider: provider.id, id: identifier, data, onExisting, options });
    // nothing answered is a wrapper holding the import back; the sites read success and error
    return result || { success: false, error: 'the import was held back' };
}

// ========================================
// GALLERY SAVE
// ========================================

/**
 * The stable filename for one gallery image: the provider's name first, the URL only as fallback; every consumer of the identity calls this.
 * @param {Object} imageInfo - { url, name? }
 * @param {Object} api - CoreAPI reference
 * @returns {string}
 */
export function resolveGalleryMediaName(imageInfo, api) {
    if (imageInfo?.name) return api.sanitizeMediaFilename(String(imageInfo.name)) || '';
    return api.extractSanitizedUrlName(imageInfo?.url) || '';
}

/**
 * Save a downloaded media file to a character's gallery folder.
 * Uses the naming convention: {prefix}_{hash8}_{sanitizedName}.{ext}
 *
 * @param {Object} downloadResult - { arrayBuffer, contentType }
 * @param {Object} imageInfo - { url, id?, name?, nsfw? }
 * @param {string} contentHash - SHA-256 hash of the file content
 * @param {string} filePrefix - naming prefix (e.g. 'chubgallery')
 * @param {Object} api - CoreAPI reference
 * @returns {Promise<{success: boolean, localPath?: string, filename?: string, error?: string}>}
 */
export async function saveGalleryImage(downloadResult, imageInfo, contentHash, filePrefix, api, options = {}) {
    try {
        const { arrayBuffer, contentType } = downloadResult;
        let extension = 'webp';
        if (contentType) {
            const mimeMap = {
                'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
                'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/avif': 'avif',
                'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav',
                'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/mp4': 'm4a',
                'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
            };
            if (mimeMap[contentType]) extension = mimeMap[contentType];
            else if (/^(?:audio|video)\//.test(contentType)) extension = contentType.split('/')[1].split(';')[0].replace('x-', '') || 'media';
        } else {
            const urlMatch = imageInfo.url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
            if (urlMatch) extension = urlMatch[1].toLowerCase();
        }

        const sanitizedName = resolveGalleryMediaName(imageInfo, api) || 'gallery_image';
        const shortHash = (contentHash?.length >= 8) ? contentHash.substring(0, 8) : 'nohash00';
        const fileName = `${filePrefix}_${shortHash}_${sanitizedName}.${extension}`;

        const charId = options?.charId;
        if (!charId) throw new Error('saveGalleryImage needs options.charId');
        const params = new URLSearchParams({ name: fileName });
        if (imageInfo?.url) params.set('sourceUrl', imageInfo.url);
        const resp = await CoreAPI.apiRequest(`/characters/${encodeURIComponent(charId)}/media?${params}`, 'POST', arrayBuffer, {
            raw: true, headers: { 'Content-Type': contentType || 'application/octet-stream' },
        });
        downloadResult.arrayBuffer = null;

        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`Upload failed: ${errText}`);
        }

        const saveResult = await resp.json();
        if (saveResult.skipped) return { success: true, skipped: true, filename: fileName };
        return { success: true, localPath: saveResult.url, filename: saveResult.displayName || fileName };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
}

// ========================================
// THE HOSTED BROWSER (server/services/browser-service.js)
// ========================================
// One browser for every provider that needs a real one: the managed Chrome the server runs, or
// a DevTools endpoint the user points at (Settings > Online > Hosted Browser, browserMode and
// browserEndpoint). A provider registers itself as a CONSUMER on the server (an origin and a
// fetch prefix) and rides these helpers under its id.

export function getBrowserMode() {
    return CoreAPI.getSetting('browserMode') || 'managed';
}

export function getBrowserEndpoint() {
    return (CoreAPI.getSetting('browserEndpoint') || '').trim();
}

/** The guide's Hosted Browser section, for every notice that sends a reader there to add or set up a browser. */
export const HOSTED_BROWSER_GUIDE = Object.freeze({ label: 'Hosted Browser in the guide', section: 'online/the-hosted-browser' });

/** Whether a browser is configurable, not whether one is up: managed mode starts it lazily. */
export function hasBrowserEndpoint() {
    return getBrowserMode() === 'managed' ? true : !!getBrowserEndpoint();
}

/** The body shape every browser-backed route reads: managed:true lets the service own the lazy start. */
export function browserTarget(endpoint) {
    if (endpoint) return { endpoint };
    if (getBrowserMode() === 'managed') return { managed: true };
    return { endpoint: getBrowserEndpoint() };
}

/**
 * A POST to a provider-services route with an abort bound (apiRequest has none); a caller's signal rides alongside.
 * @param {string} route - under PROVIDER_SERVICES_BASE
 * @param {Object} body
 * @param {{timeoutMs?: number, signal?: AbortSignal|null, label?: string}} [opts] - label names the service in errors
 * @returns {Promise<Object>} the JSON answer; throws on a refused or failed call
 */
export async function serviceCall(route, body, { timeoutMs = 180000, signal = null, label = 'browser' } = {}) {
    // the reader's own cancel is no service failure: the same AbortError every abort reader tests for
    const cancelled = () => new DOMException('Cancelled', 'AbortError');
    let resp;
    try {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        resp = await CoreAPI.apiRequest(`${PROVIDER_SERVICES_BASE}${route}`, 'POST', body, {
            signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
        });
    } catch (e) {
        if (signal?.aborted) throw cancelled();
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
            throw new Error('The browser did not answer in time.');
        }
        throw new Error(`Could not reach the ${label} service.`);
    }
    if (!resp) throw new Error(`The ${label} service did not respond.`);
    let data = null;
    try { data = await resp.json(); } catch { /* non-JSON body */ }
    // an answer that landed after the reader left is nobody's, and a refusal in it is no failure
    if (signal?.aborted) throw cancelled();
    // spelled here, not readAnswer: a service refuses with ok: false too, and the words name the service
    if (!resp.ok || data?.ok === false) {
        const err = new Error(data?.error || `The ${label} service returned HTTP ${resp.status}`);
        // the service's own code, when it names one (NO_BROWSER: no browser installed for it to start)
        if (typeof data?.code === 'string') err.code = data.code;
        throw err;
    }
    // a 2xx with no JSON is something in front of the server answering for it
    if (!data) throw new Error(`The ${label} service answered without a body (HTTP ${resp.status})`);
    return data;
}

/**
 * A same-origin fetch inside the hosted browser under `consumer`, the only place a Cloudflare
 * clearance exists. The consumer's headers (a Bearer, typically) ride the request.
 * @param {string} consumer
 * @param {string} path - origin-relative, under the consumer's registered prefix
 * @param {{headers?: Object, method?: string, jsonBody?: Object, endpoint?: string, timeoutMs?: number, signal?: AbortSignal|null}} [opts]
 * @returns {Promise<{status: number, body: string, retryAfter: string}>} throws an AbortError when `signal` aborts
 */
export async function browserFetch(consumer, path, { headers, method, jsonBody, endpoint, timeoutMs = 90000, signal = null } = {}) {
    const data = await serviceCall('/browser/fetch', {
        ...browserTarget(endpoint),
        consumer,
        path,
        headers: headers || undefined,
        method: method || undefined,
        jsonBody,
    }, { timeoutMs, signal });
    return { status: data.status || 0, body: data.body || '', retryAfter: data.retryAfter || '' };
}

/** Drops the consumer's account cookies from the browser, keeping its Cloudflare pass. */
export async function browserClearCookies(consumer, endpoint) {
    return serviceCall('/browser/cookies/clear', { ...browserTarget(endpoint), consumer }, { timeoutMs: 60000 });
}
