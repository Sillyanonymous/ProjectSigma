// The connection editor: one LLM profile form for the in-chat manager and Settings > AI; probes ask the DRAFT.

import CoreAPI from './core-api.js';

const esc = (s) => CoreAPI.escapeHtml(s);

// the neutral vocabulary (server/llm/params.js); a blank field is not sent, never a default
export const PARAM_FIELDS = [
    { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.05, hint: 'Higher wanders further from the likeliest next word.' },
    { key: 'topP', label: 'Top P', min: 0, max: 1, step: 0.01, hint: 'Keeps the smallest set of words whose probability adds up to this.' },
    { key: 'topK', label: 'Top K', min: 0, max: 500, step: 1, hint: 'Keeps only this many candidate words. 0 leaves it unset.' },
    { key: 'maxTokens', label: 'Max reply tokens', min: 1, max: 128000, step: 16, hint: 'A ceiling on the reply, not a target.' },
    { key: 'presencePenalty', label: 'Presence penalty', min: -2, max: 2, step: 0.05, hint: 'Pushes away from words it has used at all.' },
    { key: 'frequencyPenalty', label: 'Frequency penalty', min: -2, max: 2, step: 0.05, hint: 'Pushes away from words it has used often.' },
    { key: 'seed', label: 'Seed', min: 0, max: 2147483647, step: 1, hint: 'Same seed and same prompt gives the same reply, where the provider honours it.' },
];

let seq = 0;

// ========================================
// THE WIRE
// ========================================
// Thin verbs over /api/llm, one per write, so a test can drive each against the real server
// and pair every endpoint with the verb that writes it.

async function apiPatch(id, patch) {
    return CoreAPI.readAnswer(await CoreAPI.apiRequest(`/llm/profiles/${encodeURIComponent(id)}`, 'PATCH', patch));
}

async function apiDuplicate(id, name) {
    return CoreAPI.readAnswer(await CoreAPI.apiRequest(`/llm/profiles/${encodeURIComponent(id)}/duplicate`, 'POST', { name }));
}

async function apiDelete(id) {
    await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/llm/profiles/${encodeURIComponent(id)}`, 'DELETE'));
    return true;
}

/** The test verdict for the draft on screen: { ok } or { ok: false, kind, error }. */
async function apiTest(id, draft) {
    const data = await CoreAPI.readAnswer(await CoreAPI.apiRequest('/llm/test', 'POST', { profileId: id, overrides: draftOverrides(draft) }))
        .catch((e) => ({ ok: false, kind: 'network', error: e.message }));
    return data || { ok: false, kind: 'network', error: 'no answer' };
}

/** Whether the draft's model sees pictures: { sees: true }, { sees: false, reason, error?, said? } or { sees: null, kind, error }. */
async function apiTestVision(id, draft) {
    const data = await CoreAPI.readAnswer(await CoreAPI.apiRequest('/llm/test-vision', 'POST', { profileId: id, overrides: draftOverrides(draft) }))
        .catch((e) => ({ sees: null, kind: 'network', error: e.message }));
    return data || { sees: null, kind: 'network', error: 'no answer' };
}

/** The model ids the draft's endpoint offers, or null when the list could not be read. */
async function apiModels(id, draft) {
    const resp = await CoreAPI.apiRequest('/llm/models', 'POST', { profileId: id, overrides: draftOverrides(draft) });
    if (!resp.ok) return null;
    const data = await resp.json();
    const list = Array.isArray(data) ? data : (data?.models || []);
    return list.map(m => (typeof m === 'string' ? { id: m } : m)).filter(m => m?.id);
}

// a probe carries the draft's endpoint, kind, model, params and typed key; blank (or a pending removal) lets the stored key answer
function draftOverrides(draft) {
    return { kind: draft.kind, baseUrl: draft.baseUrl, model: draft.model, params: draft.params, ...(draft.apiKey ? { apiKey: draft.apiKey } : {}) };
}

// ========================================
// THE DRAFT
// ========================================

// the profile's vision as the sight field's option: not checked is the empty one
const visionField = (v) => (v === true ? 'yes' : v === false ? 'no' : '');

// a blank numeric field is ABSENT, not zero (a zero temperature is a real, very different setting)
function readNumber(el) {
    const raw = el?.value;
    if (raw === undefined || String(raw).trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}

/** The form as a PATCH. Stored params spread first since the server replaces params whole; the key rides only on Replace/Remove. */
function collectDraft(root, stored, keyMode) {
    const q = (name) => root.querySelector(`[data-ce="${name}"]`);
    const params = { ...(stored?.params || {}) };
    for (const f of PARAM_FIELDS) {
        const v = readNumber(q(`p:${f.key}`));
        if (v !== undefined) params[f.key] = v; else delete params[f.key];
    }
    const effort = q('p:reasoning')?.value;
    if (effort) params.reasoning = { effort }; else delete params.reasoning;
    const patch = {
        name: q('name')?.value?.trim() || 'Untitled',
        kind: q('kind')?.value,
        baseUrl: q('baseUrl')?.value?.trim() ?? '',
        model: q('model')?.value?.trim() ?? '',
        // the whole field is rendered, so blank is the explicit "inherit the app budget"
        contextSize: readNumber(q('contextSize')) ?? null,
        // not checked is null, never false
        vision: ({ yes: true, no: false })[q('vision')?.value] ?? null,
        // a whole count or no limit; the server refuses a zero
        maxImages: Number.isFinite(readNumber(q('maxImages'))) ? Math.round(readNumber(q('maxImages'))) : null,
        params,
    };
    const typed = q('apiKey')?.value || '';
    if (keyMode === 'replace' && typed) patch.apiKey = typed;
    else if (keyMode === 'remove') patch.apiKey = '';
    return patch;
}

/** Endpoint, key and model from the draft, each set or missing; a missing key never blocks (a local endpoint needs none). */
export function readinessOf(draft, { kindMeta = null, hasKey = false, keyMode = 'keep' } = {}) {
    const needsUrl = kindMeta ? !!kindMeta.requiresBaseUrl : true;
    const endpoint = draft.baseUrl ? 'set' : (needsUrl ? 'missing' : 'optional');
    const key = keyMode === 'remove' ? 'missing'
        : keyMode === 'replace' ? (draft.apiKey ? 'typed' : 'missing')
            : (hasKey ? 'set' : 'missing');
    const model = draft.model ? 'set' : 'missing';
    return { endpoint, key, model, ready: endpoint !== 'missing' && model === 'set' };
}

/** Whether a saved connection sees pictures, by the server's rule: a kind that cannot carry them is no, else the profile's own (null not checked). */
export function seesPictures(profile, kindMeta) {
    if (!profile || !kindMeta?.capabilities?.vision) return false;
    return typeof profile.vision === 'boolean' ? profile.vision : null;
}

/** The endpoint example: the kind's own default where it has one (the Messages API's base has no /v1), else the OpenAI shape. */
export function endpointPlaceholder(kindMeta) {
    return kindMeta?.defaultBaseUrl || 'https://api.example.com/v1';
}

const READY_WORDS = {
    endpoint: { set: 'Endpoint set', missing: 'No endpoint', optional: 'Endpoint optional' },
    key: { set: 'Key stored', typed: 'Key typed', missing: 'No key' },
    model: { set: 'Model set', missing: 'No model' },
};
const READY_ICON = { set: 'fa-circle-check', typed: 'fa-circle-check', missing: 'fa-circle-exclamation', optional: 'fa-circle-minus' };

// ========================================
// MARKUP
// ========================================

function fieldHtml(uid, label, name, value, { type = 'text', placeholder = '', hint = '', attrs = '' } = {}) {
    const id = `${uid}-${name.replace(/[^a-z0-9]/gi, '')}`;
    return `<div class="cl-cwin-block">
        <div class="cl-cwin-field">
            <label class="cl-cwin-field-label" for="${id}">${esc(label)}</label>
            <input class="cl-cwin-input cl-cwin-field-control" id="${id}" data-ce="${esc(name)}" type="${type}" value="${esc(value ?? '')}" placeholder="${esc(placeholder)}"
                autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"${attrs}>
        </div>
        ${hint ? `<p class="cl-cwin-hint">${esc(hint)}</p>` : ''}
    </div>`;
}

/**
 * The reasoning-effort field in the chat-window form, for the connection editor and the assistant's settings; mount it with CoreAPI.mountEffortPicker.
 * @param {{ id: string, carrier: [string, string], value: string, hint: string }} f carrier is the hidden value's data attribute and its value
 */
export function effortFieldHtml({ id, carrier: [attr, key], value, hint }) {
    return `<div class="cl-cwin-block" data-effort>
        <div class="cl-cwin-field">
            <label class="cl-cwin-field-label" for="${id}">Reasoning effort</label>
            <select class="cl-select-fluid cl-cwin-field-control" id="${id}" data-effort-select></select>
        </div>
        <div class="cl-cwin-field" data-effort-row hidden>
            <label class="cl-cwin-field-label" for="${id}-word">Custom level</label>
            <input class="cl-cwin-input cl-cwin-field-control" id="${id}-word" type="search" data-effort-word data-escape-keeps maxlength="32"
                autocomplete="one-time-code" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="done">
        </div>
        <input type="hidden" ${attr}="${esc(key)}" data-effort-value value="${esc(value ?? '')}">
        <p class="cl-cwin-hint">${esc(hint)}</p>
    </div>`;
}

// a custom level goes to the host as typed, so the hint says what a refusal means
export const EFFORT_HINT_TAIL = 'A custom level is letters, digits, _ and -, sent exactly as typed; a model that does not take it refuses the request.';

function keyRowHtml(state) {
    const { p, keyMode } = state;
    if (keyMode === 'replace') {
        return `<input class="cl-cwin-input" data-ce="apiKey" type="password" value="" placeholder="Paste the new key"
                autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="New API key">
            <button type="button" class="cl-cwin-btn-text" data-ce-act="key-keep" title="Keep the stored key">Cancel</button>`;
    }
    if (keyMode === 'remove') {
        return `<span class="ce-key-state is-removing"><i class="fa-solid fa-key"></i> Removed on Save</span>
            <button type="button" class="cl-cwin-btn-text" data-ce-act="key-keep">Undo</button>`;
    }
    if (p.hasKey) {
        return `<span class="ce-key-state is-stored"><i class="fa-solid fa-key"></i> Key stored${p.keyHint ? `, ends in <code>${esc(p.keyHint)}</code>` : ''}</span>
            <button type="button" class="cl-cwin-btn-text" data-ce-act="key-replace">Replace</button>
            <button type="button" class="cl-cwin-btn-text" data-ce-act="key-remove">Remove</button>`;
    }
    return `<span class="ce-key-state is-missing"><i class="fa-solid fa-key"></i> No key stored</span>
        <button type="button" class="cl-cwin-btn-text" data-ce-act="key-replace">Add Key</button>`;
}

function modelControlHtml(state) {
    const { p, models } = state;
    const current = state.modelDraft ?? p.model ?? '';
    if (Array.isArray(models) && models.length) {
        const ids = models.map(m => m.id);
        // the eye marks a model the endpoint's own list says sees pictures
        return `<select class="cl-select-fluid" data-ce="model" aria-label="Model">
            ${models.map(m => `<option value="${esc(m.id)}"${current === m.id ? ' selected' : ''}${m.vision === true ? ' data-icon="fa-solid fa-eye" title="Sees pictures"' : ''}>${esc(m.id)}${m.contextLength ? ` (${Math.round(m.contextLength / 1024)}k)` : ''}</option>`).join('')}
            ${ids.includes(current) ? '' : `<option value="${esc(current)}" selected>${esc(current || '(unset)')}</option>`}
        </select>`;
    }
    return `<input class="cl-cwin-input" data-ce="model" type="search" value="${esc(current)}" placeholder="gpt-4o, claude-..., or your own"
        autocomplete="one-time-code" autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Model">`;
}

function readinessHtml(r) {
    return ['endpoint', 'key', 'model'].map(k => `<span class="ce-ready-item" data-state="${r[k]}"><i class="fa-solid ${READY_ICON[r[k]]}"></i>${READY_WORDS[k][r[k]]}</span>`).join('');
}

// feedback, not a record: nothing is stored, and the note blanks once the draft moves on
function testNoteHtml(t) {
    if (!t) return '';
    if (t.running) return '<i class="fa-solid fa-circle-notch fa-spin"></i> Testing...';
    if (t.ok) return '<i class="fa-solid fa-circle-check"></i> Reachable';
    return `<i class="fa-solid fa-circle-exclamation"></i> ${esc(t.kind || 'failed')}: ${esc(t.error || 'failed')}`;
}

// what Check found, in the words a reader acts on; the field above already holds a yes or a no
function visionNoteHtml(v) {
    if (!v) return '';
    if (v.running) return '<i class="fa-solid fa-circle-notch fa-spin"></i> Showing the model two pictures...';
    if (v.sees === true) return '<i class="fa-solid fa-circle-check"></i> It named both pictures: it sees them.';
    if (v.sees === false && v.reason === 'answer') return `<i class="fa-solid fa-circle-xmark"></i> It could not name the pictures${v.said ? ` (it said "${esc(v.said)}")` : ''}.`;
    if (v.sees === false) return `<i class="fa-solid fa-circle-xmark"></i> The endpoint refused the pictures: ${esc(v.error || 'no reason given')}`;
    return `<i class="fa-solid fa-circle-exclamation"></i> Could not tell (${esc(v.kind || 'failed')}): ${esc(v.error || 'failed')}`;
}
const visionTone = (v) => (!v || v.running ? '' : v.sees === true ? 'ok' : v.sees === false ? 'error' : 'warn');

function editorHtml(state, kinds, uid, { back }) {
    const { p } = state;
    const params = p.params || {};
    // a kind no adapter offers now (extension off) stays selected and named, never silently swapped for the first kind
    const known = kinds.some(k => k.kind === p.kind);
    const kindOpts = (known || !p.kind ? '' : `<option value="${esc(p.kind)}" selected>${esc(p.kind)} (Unavailable)</option>`)
        + kinds.map(k => `<option value="${esc(k.kind)}"${p.kind === k.kind ? ' selected' : ''}>${esc(k.displayName || k.kind)}</option>`).join('');
    return `
    <div class="ce-editor">
        <div class="ce-head">
            ${back ? `<button type="button" class="ce-back" data-ce-act="close" aria-label="Back to connections"><i class="fa-solid fa-chevron-left"></i><span>Connections</span></button>` : ''}
            <span class="ce-title">${esc(p.name || 'Connection')}</span>
            <button type="button" class="cl-cwin-btn-text ce-more" data-ce-act="more" aria-haspopup="true" aria-label="Connection actions"><i class="fa-solid fa-ellipsis"></i></button>
        </div>
        <div class="settings-band is-warn ce-band" data-ce="band" role="status" hidden>
            <i class="fa-solid fa-arrows-rotate settings-band-icon"></i>
            <div class="settings-band-text">
                <span class="settings-band-when">Changed elsewhere</span>
                <span class="settings-band-sub">Another tab or device saved this connection. Reload it before saving over it.</span>
            </div>
            <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-ce-act="reload">Reload</button>
        </div>
        <div class="ce-status">
            <div class="ce-ready" data-ce="ready"></div>
        </div>
        <div class="ce-body">
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-plug"></i>Connection</h4>
            <div class="cl-cwin-fields">
                ${fieldHtml(uid, 'Name', 'name', p.name, { placeholder: 'What you call it' })}
                <div class="cl-cwin-block">
                    <div class="cl-cwin-field">
                        <label class="cl-cwin-field-label" for="${uid}-kind">Kind</label>
                        <select class="cl-select-fluid cl-cwin-field-control" id="${uid}-kind" data-ce="kind">${kindOpts}</select>
                    </div>
                </div>
                ${fieldHtml(uid, 'Endpoint', 'baseUrl', p.baseUrl, { placeholder: endpointPlaceholder(kinds.find(k => k.kind === p.kind)) })}
                <div class="cl-cwin-block">
                    <div class="cl-cwin-field">
                        <span class="cl-cwin-field-label">API key</span>
                        <div class="ce-key-row cl-cwin-fieldrow cl-cwin-field-control" data-ce="keyRow"></div>
                    </div>
                    <p class="cl-cwin-hint">Stored on the server and never sent back here. Replace or Remove take effect on Save.</p>
                </div>
                <div class="cl-cwin-block">
                    <div class="cl-cwin-field">
                        <span class="cl-cwin-field-label">Model</span>
                        <div class="ce-key-row cl-cwin-fieldrow cl-cwin-field-control">
                            <span class="ce-model-slot" data-ce="modelSlot"></span>
                            <button type="button" class="cl-cwin-btn-text" data-ce-act="models" title="List the models this endpoint offers"><i class="fa-solid fa-rotate"></i></button>
                        </div>
                    </div>
                    <p class="cl-cwin-hint" data-ce="modelsNote"></p>
                </div>
                ${fieldHtml(uid, 'Context size', 'contextSize', p.contextSize, {
                    type: 'number', placeholder: 'app default',
                    hint: 'The token budget for prompts sent through this connection, overriding the app-wide budget in Chat settings. Blank inherits it.',
                    attrs: ' min="1" step="256"',
                })}
                <div class="cl-cwin-block">
                    <div class="cl-cwin-field">
                        <label class="cl-cwin-field-label" for="${uid}-vision">Sees pictures</label>
                        <div class="ce-key-row cl-cwin-fieldrow cl-cwin-field-control">
                            <span class="ce-model-slot">
                                <select class="cl-select-fluid" id="${uid}-vision" data-ce="vision">
                                    ${[['', 'Not checked'], ['yes', 'Yes'], ['no', 'No']].map(([v, l]) => `<option value="${v}"${visionField(p.vision) === v ? ' selected' : ''}>${l}</option>`).join('')}
                                </select>
                            </span>
                            <button type="button" class="cl-cwin-btn-text" data-ce-act="vision-check" title="Show the model two small pictures and see whether it names their colours"><i class="fa-solid fa-eye"></i> Check</button>
                        </div>
                    </div>
                    <p class="cl-cwin-hint ce-vision-note" data-ce="visionNote" data-tone="" aria-live="polite"></p>
                    <p class="cl-cwin-hint" data-ce="visionHint"></p>
                </div>
                ${fieldHtml(uid, 'Most pictures a request', 'maxImages', p.maxImages, {
                    type: 'number', placeholder: 'no limit',
                    hint: 'For a host that takes only so many pictures at once: past it, a chat sends its oldest pictures as text. Blank is no limit.',
                    attrs: ' min="1" step="1"',
                })}
            </div>
        </section>

        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-sliders"></i>Sampling</h4>
            <p class="cl-cwin-group-note">Blank means the app sends nothing for that setting and the provider's own default applies. That is not the same as sending a zero.</p>
            <div class="cl-cwin-fields">
                ${PARAM_FIELDS.map(f => fieldHtml(uid, f.label, `p:${f.key}`, params[f.key], {
                    type: 'number', placeholder: 'provider default', hint: f.hint,
                    attrs: ` min="${f.min}" max="${f.max}" step="${f.step}"`,
                })).join('')}
                ${effortFieldHtml({
                    id: `${uid}-reasoning`, carrier: ['data-ce', 'p:reasoning'], value: params.reasoning?.effort || '',
                    hint: `Only reasoning models read this; it is dropped for the rest. ${EFFORT_HINT_TAIL}`,
                })}
            </div>
        </section>
        </div>
        <div class="ce-actions">
            <button type="button" class="cl-cwin-btn-text" data-ce-act="test" title="Send a one-token request through the connection as it stands here"><i class="fa-solid fa-plug-circle-check"></i> Test</button>
            <span class="ce-test-note" data-ce="test" data-tone="" aria-live="polite"></span>
            <span class="ce-actions-gap"></span>
            <button type="button" class="cl-cwin-btn-text" data-ce-act="close">Cancel</button>
            <button type="button" class="cl-cwin-btn-text is-primary" data-ce-act="save"><i class="fa-solid fa-check"></i> Save</button>
        </div>
    </div>`;
}

// ========================================
// MOUNT
// ========================================

/**
 * Render the editor for one stored profile into host; the host owns the list, the editor the draft, probes and writes.
 * @param {HTMLElement} host
 * @param {{ profile: object, kinds?: object[], back?: boolean, onSaved?: Function, onClosed?: Function, onDeleted?: Function, onDuplicated?: Function }} opts
 * @returns {{ collect: Function, isDirty: Function, save: Function, destroy: Function, close: Function, profile: object }}
 */
export function mountConnectionEditor(host, { profile, kinds = [], back = false, onSaved = null, onClosed = null, onDeleted = null, onDuplicated = null, onReload = null } = {}) {
    const uid = `ce${++seq}`;
    const state = { p: profile, keyMode: 'keep', models: null, modelDraft: null, lastTest: null, busy: false, closed: false, stale: false, contextAuto: null, visionAuto: null, lastVision: null };
    host.innerHTML = editorHtml(state, kinds, uid, { back });
    const root = host.querySelector('.ce-editor');
    const q = (name) => root.querySelector(`[data-ce="${name}"]`);
    const kindMeta = () => kinds.find(k => k.kind === q('kind')?.value) || null;

    const collect = () => collectDraft(root, state.p, state.keyMode);
    const isDirty = () => {
        if (state.keyMode !== 'keep') return true;
        const d = collect();
        const s = state.p;
        return d.name !== (s.name || 'Untitled') || d.kind !== s.kind || d.baseUrl !== (s.baseUrl || '') || d.model !== (s.model || '')
            || (d.contextSize ?? null) !== (s.contextSize ?? null) || (d.vision ?? null) !== (s.vision ?? null)
            || (d.maxImages ?? null) !== (s.maxImages ?? null)
            || JSON.stringify(d.params) !== JSON.stringify(s.params || {});
    };

    const syncReadiness = () => {
        const d = collect();
        const typed = q('apiKey')?.value || '';
        q('ready').innerHTML = readinessHtml(readinessOf({ ...d, apiKey: typed }, { kindMeta: kindMeta(), hasKey: state.p.hasKey, keyMode: state.keyMode }));
        q('baseUrl').placeholder = endpointPlaceholder(kindMeta());
        syncVisionKind();
    };
    // a kind that cannot carry pictures says so where the reader would set them, and its field and Check wait
    const syncVisionKind = () => {
        const carries = !!kindMeta()?.capabilities?.vision;
        const field = q('vision');
        if (field) field.disabled = !carries;
        field?.closest('.cl-cwin-field')?.querySelector('.custom-select-trigger')?.toggleAttribute('disabled', !carries);
        const check = root.querySelector('[data-ce-act="vision-check"]');
        if (check) check.disabled = !carries || state.busy;
        const most = q('maxImages');
        if (most) most.disabled = !carries;
        q('visionHint').textContent = carries
            ? 'Whether the model sees pictures; attaching is offered only on Yes. Picking a model from the list fills it in when the endpoint says; Check asks the model itself.'
            : 'This kind of connection cannot send pictures.';
    };
    const syncVision = () => {
        const el = q('visionNote');
        el.innerHTML = visionNoteHtml(state.lastVision);
        el.dataset.tone = visionTone(state.lastVision);
    };
    const syncTest = () => {
        const el = q('test');
        el.innerHTML = testNoteHtml(state.lastTest);
        el.dataset.tone = state.lastTest && !state.lastTest.running ? (state.lastTest.ok ? 'ok' : 'error') : '';
    };
    // an answer is for the draft it was asked about; a changed draft blanks it
    const staleTest = () => { if (state.lastTest && !state.lastTest.running) { state.lastTest = null; syncTest(); } };
    const staleVision = () => { if (state.lastVision && !state.lastVision.running) { state.lastVision = null; syncVision(); } };
    const renderKeyRow = () => {
        q('keyRow').innerHTML = keyRowHtml(state);
        if (state.keyMode === 'replace') q('apiKey')?.focus();
        syncReadiness();
    };
    const renderModelControl = () => {
        state.modelDraft = q('model')?.value ?? state.modelDraft;
        const slot = q('modelSlot');
        slot.innerHTML = modelControlHtml(state);
        slot.querySelectorAll('select').forEach(s => CoreAPI.initCustomSelect(s));
        syncReadiness();
    };
    // a model picked from the list fills the context size unless the field holds a typed or stored value
    const followModelContext = () => {
        const field = q('contextSize');
        const held = String(field?.value ?? '').trim();
        if (!field || (held && held !== state.contextAuto)) return;
        const length = (state.models || []).find(m => m.id === q('model')?.value)?.contextLength;
        const next = Number.isFinite(length) && length > 0 ? String(length) : '';
        field.value = next;
        state.contextAuto = next || null;
    };
    // the same rule for sight: a pick fills it from the list's word, never over the reader's own choice or a stored one
    const followModelVision = () => {
        const field = q('vision');
        const held = field?.value ?? '';
        if (!field || (held && held !== state.visionAuto)) return;
        const listed = (state.models || []).find(m => m.id === q('model')?.value)?.vision;
        const next = visionField(listed);
        field.value = next;
        state.visionAuto = next || null;
    };

    const setBusy = (on) => {
        state.busy = on;
        root.querySelectorAll('[data-ce-act="test"], [data-ce-act="save"], [data-ce-act="models"]').forEach(b => { b.disabled = on; });
        syncVisionKind();
    };

    const close = async ({ force = false } = {}) => {
        if (state.closed) return false;
        if (!force && isDirty()) {
            const ok = await CoreAPI.showConfirm({
                title: 'Discard the changes?',
                message: 'The connection stays as it was saved.',
                confirmLabel: 'Discard', cancelLabel: 'Keep editing', danger: true,
            });
            if (!ok) return false;
        }
        state.closed = true;
        host.innerHTML = '';
        onClosed?.();
        return true;
    };

    // the profile was written elsewhere while this draft is open: said, and Save waits for a reload
    const markChangedElsewhere = () => {
        if (state.closed) return;
        state.stale = true;
        const band = q('band');
        if (band) band.hidden = false;
    };

    const save = async () => {
        if (state.busy) { CoreAPI.showToast('The connection is still checking; save again once it answers', 'warning'); return false; }
        if (state.stale) { CoreAPI.showToast('This connection changed elsewhere; reload it first', 'warning'); return false; }
        const patch = collect();
        // kind rides only when changed: the route checks a sent kind against loaded adapters, so an off one would fail
        if (patch.kind === state.p.kind) delete patch.kind;
        setBusy(true);
        try {
            const saved = await apiPatch(state.p.id, patch);
            state.p = saved;
            state.keyMode = 'keep';
            CoreAPI.showToast('Connection saved', 'success');
            onSaved?.(saved);
            await close({ force: true });
            return true;
        } catch (e) {
            console.error('[ConnectionEditor] Save failed:', e.message);
            CoreAPI.showToast(`Not saved: ${e.message}`, 'error', 8000);
            setBusy(false);
            return false;
        }
    };

    const test = async () => {
        if (state.busy) return;
        const draft = { ...collect(), apiKey: q('apiKey')?.value || '' };
        state.lastTest = { running: true };
        syncTest();
        setBusy(true);
        try {
            const verdict = await apiTest(state.p.id, draft);
            state.lastTest = verdict;
        } catch (e) {
            state.lastTest = { ok: false, kind: 'network', error: e.message };
        } finally {
            setBusy(false);
            if (!state.closed) syncTest();
        }
    };

    // the answer fills the field like a pick does, so the next model picked replaces a check of this one
    const checkVision = async () => {
        if (state.busy) return;
        const draft = { ...collect(), apiKey: q('apiKey')?.value || '' };
        state.lastVision = { running: true };
        syncVision();
        setBusy(true);
        try {
            state.lastVision = await apiTestVision(state.p.id, draft);
        } catch (e) {
            state.lastVision = { sees: null, kind: 'network', error: e.message };
        } finally {
            setBusy(false);
        }
        if (state.closed) return;
        if (typeof state.lastVision.sees === 'boolean') {
            const next = visionField(state.lastVision.sees);
            q('vision').value = next;
            state.visionAuto = next;
        }
        syncVision();
    };

    const listModels = async () => {
        if (state.busy) return;
        const draft = { ...collect(), apiKey: q('apiKey')?.value || '' };
        const note = q('modelsNote');
        note.textContent = 'Listing models...';
        setBusy(true);
        let models = null;
        try { models = await apiModels(state.p.id, draft); } catch { models = null; }
        setBusy(false);
        if (state.closed) return;
        state.models = models;
        note.textContent = models ? (models.length ? `${models.length} models offered` : 'The endpoint offers no models') : 'Could not list models';
        renderModelControl();
    };

    const duplicate = async () => {
        const name = await CoreAPI.showConfirm({
            title: 'Duplicate connection',
            message: 'A copy with the same endpoint, key and settings.',
            confirmLabel: 'Duplicate',
            input: { value: `${state.p.name || 'Connection'} copy`, placeholder: 'What you call it' },
        });
        if (typeof name !== 'string') return;
        try {
            const made = await apiDuplicate(state.p.id, name);
            CoreAPI.showToast('Connection duplicated', 'success');
            onDuplicated?.(made);
        } catch (e) {
            console.error('[ConnectionEditor] Duplicate failed:', e.message);
            CoreAPI.showToast(`Not duplicated: ${e.message}`, 'error', 8000);
        }
    };

    const remove = async () => {
        const ok = await CoreAPI.showConfirm({
            title: 'Delete this connection?',
            message: `"${state.p.name || 'It'}" and its stored API key are removed. Chats pointing at it fall back to the first one left.`,
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        try {
            await apiDelete(state.p.id);
            CoreAPI.showToast('Connection deleted', 'success');
            state.closed = true;
            host.innerHTML = '';
            onDeleted?.(state.p.id);
        } catch (e) {
            console.error('[ConnectionEditor] Delete failed:', e.message);
            CoreAPI.showToast(`Not deleted: ${e.message}`, 'error', 8000);
        }
    };

    // the shared menu under the More, so a menu opened from the keyboard stands where the button is; a phone gets its sheet
    const openActions = (e, btn) => {
        const r = btn.getBoundingClientRect();
        CoreAPI.getModule('context-menu')?.showItems?.(e, [
            { type: 'header', label: 'Connection' },
            { icon: 'fa-solid fa-clone', label: 'Duplicate (key included)', action: duplicate },
            { icon: 'fa-solid fa-trash', label: 'Delete', className: 'danger', action: remove },
        ], { x: r.left, y: r.bottom + 4 });
    };

    root.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-ce-act]');
        if (!btn || !root.contains(btn)) return;
        switch (btn.dataset.ceAct) {
            case 'save': return save();
            case 'test': return test();
            case 'vision-check': return checkVision();
            case 'models': return listModels();
            case 'close': return close();
            case 'reload': return onReload?.();
            case 'more': return openActions(e, btn);
            case 'key-replace': state.keyMode = 'replace'; return renderKeyRow();
            case 'key-remove': state.keyMode = 'remove'; return renderKeyRow();
            case 'key-keep': state.keyMode = 'keep'; return renderKeyRow();
            default: return undefined;
        }
    });
    // the sight field's own change is not the draft moving on, so it leaves Check's answer standing
    const movesDraft = (e) => e.target !== q('vision');
    root.addEventListener('input', (e) => { syncReadiness(); staleTest(); if (movesDraft(e)) staleVision(); });
    root.addEventListener('change', (e) => { syncReadiness(); staleTest(); if (movesDraft(e)) staleVision(); });
    // typing in the field makes its value the reader's; only a pick from the list is followed, never a typed model name
    root.addEventListener('input', (e) => { if (e.target === q('contextSize')) state.contextAuto = null; });
    root.addEventListener('change', (e) => {
        if (e.target.matches?.('select[data-ce="model"]')) { followModelContext(); followModelVision(); }
        if (e.target === q('vision')) state.visionAuto = null;
    });

    CoreAPI.mountEffortPicker(root.querySelector('[data-effort]'), { inheritLabel: 'provider default', rememberAs: `connection:${state.p.id}` });
    root.querySelectorAll('select').forEach(s => CoreAPI.initCustomSelect(s));
    renderKeyRow();
    renderModelControl();
    syncTest();
    syncVision();

    return {
        collect,
        isDirty,
        save,
        close,
        markChangedElsewhere,
        get profile() { return state.p; },
        get stale() { return state.stale; },
        destroy() { state.closed = true; host.innerHTML = ''; },
    };
}

export default { mountConnectionEditor, readinessOf, endpointPlaceholder, PARAM_FIELDS, effortFieldHtml };
