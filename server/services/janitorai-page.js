// The janitorai page, driven: in-page fetch, session cookie, composer, and the generateAlpha capture; no route or recovery policy here
import { randomUUID } from 'node:crypto';
import { CDP_NAV_TIMEOUT, PAGE_TEXT_CAPPED } from '../lib/cdp.js';
import { PARSE_MAX_BYTES } from '../lib/net-guard.js';

// one second per try, generous: the composer is disabled while janitorai generates, and a follow-up turn can land mid-answer
const COMPOSER_WAIT_TRIES = 120;
export const JANITORAI_ORIGIN = 'https://janitorai.com';
export const JANITORAI_UUID_RE = /^[a-f0-9-]{36}$/i;

/** Build an in-page fetch against janitorai, as an expression string for Runtime.evaluate. */
export function janitoraiCall(method, path, body, token) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const init = {
        method,
        credentials: 'include',
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
    };
    return `(async () => {
        const r = await fetch(${JSON.stringify(path)}, ${JSON.stringify(init)});
        const t = await ${PAGE_TEXT_CAPPED}(r, ${PARSE_MAX_BYTES});
        if (t === null) return { status: r.status, data: null, text: 'the answer passed ${PARSE_MAX_BYTES} bytes' };
        let d = null; try { d = JSON.parse(t); } catch { /* not JSON: the text rides instead */ }
        return { status: r.status, data: d, text: d ? null : t.slice(0, 400) };
    })()`;
}

export const JANITORAI_COOKIE = 'sb-auth-auth-token';
// supabase splits a session past ~4KB into .0, .1 ... and drops the unsuffixed name; whether it splits depends on the JWT
const JANITORAI_COOKIE_CHUNK_LIMIT = 3180;

/** Join the session cookie back together, chunked or not. '' when absent. */
function readJanitoraiCookie(cookies) {
    const whole = cookies.find(c => c.name === JANITORAI_COOKIE)?.value;
    if (whole) return whole;
    const chunks = cookies
        .map(c => ({ n: Number(new RegExp(`^${JANITORAI_COOKIE}\\.(\\d+)$`).exec(c.name)?.[1]), value: c.value }))
        .filter(c => Number.isInteger(c.n))
        .sort((a, b) => a.n - b.n);
    // a gap means a chunk expired; a partial join decodes to garbage, so the session reads as absent
    if (!chunks.length || chunks.some((c, i) => c.n !== i)) return '';
    return chunks.map(c => c.value).join('');
}

/** Pull the access token out of janitorai's supabase session cookie. '' when absent. */
export function readJanitoraiToken(cookies) {
    const raw = readJanitoraiCookie(cookies);
    if (!raw) return { token: '', cookie: '' };
    try {
        const dec = decodeURIComponent(raw);
        const json = dec.startsWith('base64-') ? Buffer.from(dec.slice(7), 'base64').toString('utf8') : dec;
        return { token: JSON.parse(json).access_token || '', cookie: raw };
    } catch {
        return { token: '', cookie: raw };
    }
}

/**
 * Put the session into the hosted browser: the chat page renders no composer for a signed-out browser.
 */
export async function injectJanitoraiSession(page, accessToken, refreshToken) {
    if (!accessToken) return false;
    let expiresAt = Math.floor(Date.now() / 1000) + 3600;
    try {
        const claims = JSON.parse(Buffer.from(String(accessToken).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        if (claims?.exp) expiresAt = claims.exp;
    } catch { /* keep the default */ }

    const session = {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: Math.max(60, expiresAt - Math.floor(Date.now() / 1000)),
        expires_at: expiresAt,
        refresh_token: refreshToken || '',
        user: {},
    };
    const value = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64');

    // supabase's own shape: one cookie when it fits, else numbered chunks; an oversized cookie is dropped (reads signed out)
    const parts = [];
    if (value.length <= JANITORAI_COOKIE_CHUNK_LIMIT) {
        parts.push([JANITORAI_COOKIE, value]);
    } else {
        for (let i = 0, n = 0; i < value.length; i += JANITORAI_COOKIE_CHUNK_LIMIT, n++) {
            parts.push([`${JANITORAI_COOKIE}.${n}`, value.slice(i, i + JANITORAI_COOKIE_CHUNK_LIMIT)]);
        }
    }

    try {
        // Stale cookies from the other shape would otherwise win the read and pin a dead session.
        for (const name of [JANITORAI_COOKIE, ...Array.from({ length: 8 }, (_, i) => `${JANITORAI_COOKIE}.${i}`)]) {
            try { await page.send('Network.deleteCookies', { name, domain: 'janitorai.com', path: '/' }); } catch { /* a dead page fails the setCookie below */ }
        }
        for (const [name, chunk] of parts) {
            await page.send('Network.setCookie', {
                name,
                value: chunk,
                domain: 'janitorai.com',
                path: '/',
                secure: false,
                httpOnly: false,
                sameSite: 'Lax',
                expires: expiresAt,
            });
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Swap the names janitorai baked in back to {{user}} (our sentinel persona) and {{char}}; names under 3 chars would match everywhere.
 */
export function restoreJanitoraiMacros(text, { userSentinel, detail }) {
    let out = String(text || '');
    const swap = (needle, macro) => {
        const n = String(needle || '').trim();
        if (n.length < 3) return;
        out = out.split(n).join(macro);
    };
    swap(userSentinel, '{{user}}');
    // chat_name is the in-chat display name, name is the full listing title; both appear.
    swap(detail?.chat_name, '{{char}}');
    if (detail?.name !== detail?.chat_name) swap(detail?.name, '{{char}}');
    return out;
}

/** Hex token of `bytes` bytes, for values that only have to be unique and opaque. */
export function randomHex(bytes) {
    let out = '';
    while (out.length < bytes * 2) out += randomUUID().replace(/-/g, '');
    return out.slice(0, bytes * 2);
}

/**
 * Put back a profile name a run seeded with its sentinel; answers the reader's warning when it could not, else ''.
 * @param {{name: string, profile: string}} profileRestore - the PATCH body that undoes the seed
 */
export async function undoProfileSeed(page, profileRestore, token, sentinel, step) {
    const undone = await page.evaluate(janitoraiCall('PATCH', '/hampter/profiles/mine', profileRestore, token)).catch(() => null);
    step(`profile restore HTTP ${undone?.status ?? 'failed'}`);
    if (undone && undone.status < 400) return '';
    console.warn(`[provider-services] COULD NOT RESTORE the profile name (HTTP ${undone?.status ?? 'failed'}); the account is left named with the run's sentinel`);
    return `Your JanitorAI profile name could not be put back, so it may still read ${sentinel}. Clear it in your profile on janitorai.com.`;
}

/**
 * Delete what a run made on the account, in order; answers the reader's warning naming what stayed, else ''.
 * @param {Array<[string, string]>} made - [noun, path] pairs, eg. ['chat', '/hampter/chats/{id}']
 */
export async function removeRunLeftovers(page, made, token, step) {
    const stayed = [];
    for (const [noun, path] of made) {
        const r = await page.evaluate(janitoraiCall('DELETE', path, null, token)).catch(() => null);
        step(`delete ${noun} HTTP ${r?.status ?? 'failed'}`);
        // already gone is removed
        if (!r || (r.status >= 400 && r.status !== 404)) stayed.push(noun);
    }
    if (!stayed.length) return '';
    const list = stayed.length === 1 ? stayed[0] : `${stayed.slice(0, -1).join(', ')} and ${stayed.at(-1)}`;
    return `The temporary ${list} made on your JanitorAI account could not be removed. Delete ${stayed.length === 1 ? 'it' : 'them'} on janitorai.com.`;
}

/** A restore that failed rides back to the reader: on the result, or on the error the run ends with (its message too, unless cancelled). */
export function carryRestoreWarnings(warnings, result, failure) {
    if (!warnings.length) return;
    const warning = warnings.join(' ');
    if (result) result.restoreWarning = warning;
    else if (failure) {
        // held apart too: a cancel's answer goes to a caller that hung up, which reads it off the run's last state
        failure.restoreWarning = warning;
        if (!failure.cancelled) failure.message = `${failure.message} ${warning}`;
    }
}

// Detected per response, never assumed: patching a name this deployment doesnt use would leave
// the selection pointing at the preset we then delete.
const SELECTED_PRESET_KEYS = ['selected_proxy_config_id', 'selected_proxy_id'];

function resolveSelectedPresetKey(data) {
    for (const scope of [data?.settings, data?.legacy_config, data]) {
        if (!scope || typeof scope !== 'object') continue;
        for (const key of SELECTED_PRESET_KEYS) {
            if (key in scope) return { key, value: scope[key] ?? null };
        }
    }
    return { key: null, value: null };
}

// An empty legacy_config is truthy, so a first-truthy pick hides the scope that really holds it.
export function resolveSettingsSource(data) {
    for (const scope of [data?.settings, data?.legacy_config, data]) {
        if (!scope || typeof scope !== 'object') continue;
        const value = scope.api || scope.source;
        if (value) return String(value);
    }
    return '';
}

/** The generation block, walked like the source above rather than off a first-truthy scope. */
function resolveGenerationSettings(data) {
    for (const scope of [data?.settings, data?.legacy_config, data]) {
        if (!scope || typeof scope !== 'object') continue;
        const gen = scope.generation_settings;
        if (gen && typeof gen === 'object') return gen;
    }
    return null;
}

/**
 * The shape only our own switch writes (proxy source, unbounded context): a run that died mid-switch left it.
 */
function looksLikeLeftoverSwitch(data) {
    return resolveSettingsSource(data) === 'proxy' && resolveGenerationSettings(data)?.context_length === 0;
}

/**
 * Why janitorai wont let this account send a message, or '': proxy with nothing selected disables the composer.
 */
export function unusableSourceReason(data) {
    if (resolveSettingsSource(data) !== 'proxy') return '';
    if (resolveSelectedPresetKey(data).value) return '';
    return looksLikeLeftoverSwitch(data)
        ? 'This JanitorAI account is set to a proxy that is no longer selected, which is what an interrupted definition extraction leaves behind, so janitorai will not let a chat send. Open your API settings on janitorai.com, pick the JanitorAI model, then try again.'
        : 'This JanitorAI account is set to use a proxy but has none selected, so janitorai will not let a chat send. Open your API settings on janitorai.com, pick the JanitorAI model (or select your proxy), then try again.';
}

/** Flatten an unexpected prompt-request body into one short line for the error toast. */
function promptErrorSnippet(body) {
    const flat = String(body || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return flat ? flat.slice(0, 200) : 'the response was empty';
}

/**
 * Type text into the chat composer and send it; the capture and the recovery share it so they cant drift.
 * @param {Function} step - progress logger from the caller
 */
export async function sendChatMessage(page, text, step) {
    // several textareas exist (notes, drawers), so the composer is found by placeholder, then the Send control's scope, never by order
    const findComposer = `
        (() => {
            const shown = (el) => !!el && el.getClientRects().length > 0 && !el.disabled && !el.readOnly;
            const buttons = [...document.querySelectorAll('button')].filter(b => !b.disabled);
            // janitorai puts the label in the text, not the aria-label.
            const named = (b) => ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim();
            const send = buttons.find(b => /^send$/i.test(named(b)))
                || buttons.reverse().find(b => /send/i.test(named(b)));
            const scope = send && (send.closest('form') || send.parentElement?.parentElement);
            // The placeholder identifies the composer; document order does not, since
            // other visible textareas exist and their order isnt stable.
            const areas = [...document.querySelectorAll('textarea')].filter(shown);
            const ta = areas.find(t => /enter to send|type a message/i.test(t.placeholder || ''))
                || (scope ? [...scope.querySelectorAll('textarea')].find(shown) : null)
                || areas[0] || null;
            return { ta, send };
        })()`;

    // a cold page outlasts any fixed sleep; the long wait covers the turn after a cut, while janitorai is still generating
    let hasComposer = false;
    for (let i = 0; i < COMPOSER_WAIT_TRIES && !hasComposer; i++) {
        await new Promise(r => setTimeout(r, 1000));
        hasComposer = await page.evaluate(`(() => !!${findComposer}.ta)()`).catch(() => false);
    }
    step(`composer ${hasComposer ? 'ready' : 'MISSING'}`);
    if (!hasComposer) {
        // Which page we ended on, and what message boxes it offered.
        const shape = await page.evaluate(`
            (() => JSON.stringify({
                url: location.pathname,
                title: document.title.slice(0, 40),
                textareas: [...document.querySelectorAll('textarea')].map(t => ({
                    ph: (t.placeholder || '').slice(0, 20),
                    shown: t.getClientRects().length > 0,
                    disabled: t.disabled, ro: t.readOnly,
                })),
            }))()`).catch(() => 'unreadable');
        throw new Error(`The chat page never rendered a message box (${shape}).`);
    }

    // in "press button to send" mode Enter only inserts a linebreak, so click Send and keep Enter as the fallback
    const fill = await page.evaluate(`
        (() => {
            const found = ${findComposer};
            const ta = found.ta;
            if (!ta) return { ok: false, why: 'no composer' };
            // Tagged so later checks read THIS box, not whichever textarea comes first.
            ta.setAttribute('data-cl-composer', '1');
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
            setter.call(ta, ${JSON.stringify(text)});
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.focus();
            const btn = found.send;
            if (btn) btn.click();
            return {
                ok: true, clicked: !!btn,
                placeholder: (ta.placeholder || '').slice(0, 24),
                label: btn ? (btn.getAttribute('aria-label') || btn.textContent || '').trim().slice(0, 24) : '',
            };
        })()`);
    step(`fill ok=${!!fill?.ok} composer="${fill?.placeholder ?? ''}" `
        + `clicked=${fill?.clicked ? fill.label || 'unlabelled' : 'no button'}`);
    if (!fill?.ok) throw new Error(`Could not send the chat message (${fill?.why || 'unknown'})`);

    // The box clears on send, so text still sitting there means it didnt go out.
    const composerEmpty = async () => {
        for (let i = 0; i < 3; i++) {
            await new Promise(r => setTimeout(r, 700));
            const still = await page.evaluate(
                '(() => { const t = document.querySelector("textarea[data-cl-composer]"); return !t || !t.value.trim(); })()'
            ).catch(() => false);
            if (still) return true;
        }
        return false;
    };

    let cleared = await composerEmpty();
    step(`after click composerEmpty=${cleared}`);
    if (!cleared) {
        step('falling back to a real Enter keypress');
        for (const type of ['keyDown', 'keyUp']) {
            await page.send('Input.dispatchKeyEvent', {
                type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
                nativeVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}),
            }).catch(() => { /* the composer check below says whether it went */ });
        }
        cleared = await composerEmpty();
        step(`after Enter composerEmpty=${cleared}`);
        if (!cleared) {
            // Otherwise a swallowed send looks exactly like a model that never answered.
            const shape = await page.evaluate(`
                (() => {
                    const ta = document.querySelector('textarea[data-cl-composer]');
                    const form = ta && (ta.closest('form') || ta.parentElement?.parentElement) || document.body;
                    return JSON.stringify({
                        textareas: [...document.querySelectorAll('textarea')].map(t => ({
                            ph: (t.placeholder || '').slice(0, 20),
                            shown: t.getClientRects().length > 0,
                            chosen: t.hasAttribute('data-cl-composer'),
                            value: (t.value || '').slice(0, 12),
                            disabled: t.disabled, ro: t.readOnly,
                        })),
                        clicked: ${fill.clicked ? 'true' : 'false'},
                        buttons: [...form.querySelectorAll('button')].slice(0, 8).map(b => ({
                            label: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 24),
                            disabled: b.disabled, svg: !!b.querySelector('svg'),
                        })),
                    });
                })()`).catch(() => 'unreadable');
            throw new Error(`The chat message would not send (${shape}).`);
        }
    }
}

// the generateAlpha reply comes over HTTP SSE or a websocket; the capture and the recovery both parse it
export function isAlphaDoneFrame(payload) {
    try { return JSON.parse(payload)?.type === 'done'; } catch { return false; }
}

// Two live transports: SSE `data:` lines, or ws frames wrapping the same JSON as a STRING in .data.
export function parseGenerateAlpha(stream) {
    let out = '';
    for (const line of String(stream || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const sse = /^data:\s*(.+)$/.exec(trimmed);
        let payload = sse ? sse[1] : null;
        if (payload === '[DONE]') continue;
        if (!payload) {
            try {
                const env = JSON.parse(trimmed);
                if (env?.type !== 'chunk' || typeof env.data !== 'string') continue;
                payload = env.data;
            } catch { continue; /* keep-alive or partial line */ }
        }
        try { out += JSON.parse(payload)?.choices?.[0]?.delta?.content || ''; } catch { /* partial line */ }
    }
    return out;
}

/**
 * The generateAlpha capture; every account mutation is undone in the finally. The persona is a random sentinel that round-trips to {{user}}.
 */
export async function extractHiddenDefinition(page, token, detail) {
    // Rare and user-driven, so it narrates itself. Shapes only, never the token or the definition.
    const started = Date.now();
    const step = (msg) => console.log(`[provider-services] extract +${((Date.now() - started) / 1000).toFixed(1)}s ${msg}`);
    step(`begin character=${detail?.id || 'unknown'} token=${token ? 'yes' : 'no'}`);

    const snapshot = await page.evaluate(janitoraiCall('GET', '/hampter/api-settings', null, token));
    step(`settings HTTP ${snapshot.status} materialized=${snapshot.data?.materialized ?? 'absent'} `
        + `source=${resolveSettingsSource(snapshot.data) || 'none'} `
        + `scopes=${JSON.stringify({ settings: snapshot.data?.settings === null ? null : Object.keys(snapshot.data?.settings || {}).length, legacy: Object.keys(snapshot.data?.legacy_config || {}).length, presets: (snapshot.data?.proxy_configs || []).length })}`);
    // walked, not the first truthy scope: an empty legacy_config is truthy and hid the real settings
    const prevGeneration = resolveGenerationSettings(snapshot.data);
    // Never hand a leftover switch back to the account as though the reader had chosen it.
    const leftover = looksLikeLeftoverSwitch(snapshot.data);
    if (leftover) step('snapshot is a leftover switch (proxy + context_length 0); restoring to janitor instead of replaying it');
    const prevSource = leftover ? 'janitor' : (resolveSettingsSource(snapshot.data) || 'janitor');
    const selected = resolveSelectedPresetKey(snapshot.data);
    // The set falls back to the canonical key, so restore must clear that one or our selection
    // outlives the preset we delete.
    const presetKey = selected.key || SELECTED_PRESET_KEYS[0];

    // never override a context length we cant put back, unless the account was never configured (materialized:false)
    const neverConfigured = snapshot.data?.materialized === false;
    const restoreGeneration = leftover
        ? { ...(prevGeneration || {}), context_length: 4096 }
        : (typeof prevGeneration?.context_length === 'number'
            ? prevGeneration
            : (neverConfigured ? { ...(prevGeneration || {}), context_length: 4096 } : null));
    if (!restoreGeneration) {
        step('abort: no readable context_length and the account is not flagged never-configured');
        throw new Error('Could not read your JanitorAI generation settings, so nothing was changed. Open your API settings on janitorai.com in any browser signed in to this account, save them once, then try again.');
    }
    step(`plan neverConfigured=${neverConfigured} prevSource=${prevSource} presetKey=${presetKey} `
        + `restoreCtx=${restoreGeneration.context_length}`);

    // No fixed affix, so a persona left behind by a failed run reads as noise rather than a marker.
    const userSentinel = randomHex(12).toUpperCase();
    let proxyId = null;
    let personaId = null;
    let chatId = null;
    let profileRestore = null;
    let result = null;
    let failure = null;
    try {
        // a fresh account's first chat raises a profile modal that eats the message; seeding the name (a sentinel) stops it
        const profile = await page.evaluate(janitoraiCall('GET', '/hampter/profiles/mine', null, token));
        const priorName = typeof profile.data?.name === 'string' ? profile.data.name : '';
        const priorAppearance = typeof profile.data?.profile === 'string' ? profile.data.profile : '';
        step(`profile HTTP ${profile.status} defaultPersona=${priorName ? 'set' : 'EMPTY'}`);
        if (profile.status < 400 && !priorName.trim()) {
            const set = await page.evaluate(janitoraiCall('PATCH', '/hampter/profiles/mine', {
                name: userSentinel, profile: priorAppearance || '',
            }, token));
            step(`profile seed HTTP ${set.status}`);
            if (set.status < 400) profileRestore = { name: priorName, profile: priorAppearance };
        }
        const persona = await page.evaluate(janitoraiCall('POST', '/hampter/personas', {
            appearance: '', avatar: '', groupId: null, name: userSentinel, pronouns: null,
        }, token));
        personaId = persona.data?.id || null;
        step(`persona HTTP ${persona.status} id=${personaId || 'none'}`);

        // Ephemeral range: nothing listens there by convention, so this cant reach a local
        // model server the user is running on a well-known port.
        const deadPort = 49152 + Math.floor(Math.random() * 16384);
        const created = await page.evaluate(janitoraiCall('POST', '/hampter/api-settings/proxy-configs', {
            // Rejected server-side once used, so it cannot be a constant.
            client_id: randomUUID(),
            name: randomHex(8),
            model: 'gpt-4-turbo',
            api_url: `http://127.0.0.1:${deadPort}/v1/chat/completions`,
            // Only has to be non-blank; the request is never meant to arrive anywhere.
            api_key: `sk-${randomHex(20)}`,
            prompt_id: null,
        }, token));
        const cfgs = created.data?.proxy_configs || [];
        proxyId = cfgs.length ? cfgs[cfgs.length - 1].id : null;
        step(`preset HTTP ${created.status} id=${proxyId || 'none'} port=${deadPort}`);
        if (!proxyId) throw new Error(`JanitorAI rejected the temporary preset (HTTP ${created.status})`);

        const switched = await page.evaluate(janitoraiCall('PATCH', '/hampter/api-settings', {
            source: 'proxy',
            [presetKey]: proxyId,
            // A bounded context makes the server rewrite the prompt, losing the section
            // boundaries the definition is read from.
            generation_settings: { context_length: 0 },
        }, token));
        if (switched.status >= 400) {
            throw new Error(`JanitorAI refused the temporary settings change (HTTP ${switched.status}).`);
        }
        // only the proxy source assembles the prompt in-browser; an ignored switch would read like a rate limit 45s later
        const confirm = await page.evaluate(janitoraiCall('GET', '/hampter/api-settings', null, token));
        const appliedSource = resolveSettingsSource(confirm.data);
        step(`switch PATCH ${switched.status} -> readback source=${appliedSource || 'none'} `
            + `materialized=${confirm.data?.materialized ?? 'absent'}`);
        if (appliedSource !== 'proxy') {
            // Carry the shape it reported: without it this is indistinguishable from a switch
            // that worked but hid the value somewhere this walk does not look.
            const shape = JSON.stringify({
                source: appliedSource || null,
                materialized: confirm.data?.materialized ?? null,
                settings: confirm.data?.settings === null ? null : Object.keys(confirm.data?.settings || {}),
                legacy: Object.keys(confirm.data?.legacy_config || {}),
                presets: (confirm.data?.proxy_configs || []).length,
            });
            throw new Error(`JanitorAI did not switch to the temporary preset, so the definition cannot be read (HTTP ${switched.status}, it reported ${shape}). Open your API settings on janitorai.com once, then try again.`);
        }

        const chat = await page.evaluate(janitoraiCall('POST', '/hampter/chats',
            personaId ? { character_id: detail.id, persona_id: personaId } : { character_id: detail.id }, token));
        chatId = chat.data?.id;
        step(`chat HTTP ${chat.status} id=${chatId || 'none'}`);
        if (!chatId) throw new Error(`Could not open a chat with that character (HTTP ${chat.status})`);

        const capture = page.captureResponse(/generateAlpha/, { timeout: 45000, frameDone: isAlphaDoneFrame });
        try {
            await page.goto(`${JANITORAI_ORIGIN}/chats/${chatId}`, { timeout: CDP_NAV_TIMEOUT });
            // a CDP target is a background tab, and a throttled renderer can sit on the request this send triggers
            await page.send('Page.bringToFront').catch(() => { /* a background tab is slower, not broken */ });

            await sendChatMessage(page, 'hi', step);

            const body = (await capture.wait())?.text || null;
            step(`generateAlpha ${body ? `captured ${String(body).length} bytes` : 'NOT SEEN (45s)'}`);
            if (!body) throw new Error('JanitorAI never assembled the prompt. It may be rate limiting; try again shortly.');

            // system = the definition, assistant = the first message (a withheld definition withholds first_message from the API too)
            let system = '';
            let firstMessage = '';
            try {
                const msgs = JSON.parse(body).messages || [];
                system = msgs.find(m => m.role === 'system')?.content || '';
                firstMessage = msgs.find(m => m.role === 'assistant')?.content || '';
            } catch {
                // proxy mode alone hands the prompt back, so a creator who forbids it closed the only way in
                if (/proxies are forbidden/i.test(body)) {
                    throw new Error('The creator has turned off proxy access for this character, so its definition cannot be recovered.');
                }
                // Anything else: keep what janitorai said, or an opaque parse error reads like a CL bug.
                throw new Error(`JanitorAI did not return a prompt for this character: ${promptErrorSnippet(body)}`);
            }
            if (!system) throw new Error('Captured prompt carried no system message.');
            // held, not just returned: the outer finally stamps a restore failure onto it for the reader
            result = {
                detail,
                definition: restoreJanitoraiMacros(system, { userSentinel, detail }),
                firstMessage: firstMessage ? restoreJanitoraiMacros(firstMessage, { userSentinel, detail }) : '',
                extracted: true,
            };
            return result;
        } finally {
            capture.cancel();
        }
    } catch (e) {
        failure = e;
        throw e;
    } finally {
        // chat before its persona; the preset's DELETE must carry no Content-Type, and a bodiless janitoraiCall sends none
        const made = [];
        if (chatId) made.push(['chat', `/hampter/chats/${chatId}`]);
        if (personaId) made.push([`persona named ${userSentinel}`, `/hampter/personas/${personaId}`]);
        if (proxyId) made.push(['API preset', `/hampter/api-settings/proxy-configs/${proxyId}`]);
        const leftover = await removeRunLeftovers(page, made, token, step);
        const restored = await page.evaluate(janitoraiCall('PATCH', '/hampter/api-settings', {
            source: prevSource,
            // null means nothing selected, the right value for an account that had no selection before ours
            [presetKey]: selected.value,
            // Replayed wholesale; rebuilding it would swap tuning values we dont model for defaults.
            generation_settings: restoreGeneration,
        }, token)).catch(() => null);
        // a silent restore failure leaves the account on our proxy, so its said out loud and carried to the reader
        step(`restore source=${prevSource} ctx=${restoreGeneration.context_length} HTTP ${restored?.status ?? 'failed'}`);
        const warnings = [];
        if (!restored || restored.status >= 400) {
            warnings.push('Your JanitorAI model settings could not be put back, so the account may still be pointed at a temporary proxy. Open your API settings on janitorai.com and pick your model again.');
            console.warn(`[provider-services] extract COULD NOT RESTORE api-settings (HTTP ${restored?.status ?? 'failed'}); the account is left on source=proxy`);
        }

        // Leave the account as found; their own first-run prompt still belongs to them.
        if (profileRestore) {
            const warning = await undoProfileSeed(page, profileRestore, token, userSentinel, step);
            if (warning) warnings.push(warning);
        }
        if (leftover) warnings.push(leftover);
        carryRestoreWarnings(warnings, result, failure);
    }
}