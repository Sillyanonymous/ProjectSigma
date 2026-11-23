// The persona writes for every surface that edits personas; each answers whether the server took it, and says so if not.
import CoreAPI from './core-api.js';
import { isOwnRecord } from './feed.js';

/** A persona surface's write: a request the network dropped answers like a refusal, so every caller sees one shape. */
export async function personaRequest(url, method, body, opts) {
    try { return await CoreAPI.apiRequest(url, method, body, opts); } catch { return { ok: false, json: async () => ({}) }; }
}

/** @returns {Promise<boolean>} whether the server took it */
export async function setActivePersona(id) {
    const r = await personaRequest('/personas/active', 'PUT', { id });
    if (!r.ok) { CoreAPI.showToast('Could not set the persona', 'error'); return false; }
    // The global name feeds {{user}} in every preview app-wide, so the one cached reader
    // has to be told rather than left to expire.
    await CoreAPI.syncActivePersonaName();
    return true;
}

/**
 * A new persona (no id) or an edit of one.
 * @param {object} [fields.pronouns] the forms to write ({ sub, obj, poss, possP, ref }); left out, they are left alone
 * @returns {Promise<boolean>} whether the server took it
 */
export async function writePersona(id, { name, description = '', pronouns = null } = {}) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) { CoreAPI.showToast('A persona needs a name', 'warning'); return false; }
    const body = { name: trimmed, description, ...(pronouns ? { pronouns } : {}) };
    const r = id
        ? await personaRequest(`/personas/${encodeURIComponent(id)}`, 'PATCH', body)
        : await personaRequest('/personas', 'POST', body);
    if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        CoreAPI.showToast(err.error ? `Could not save the persona: ${err.error}` : 'Could not save the persona', 'error');
        return false;
    }
    // Renaming the persona that is currently global changes {{user}} everywhere.
    await CoreAPI.syncActivePersonaName();
    return true;
}

/** @returns {Promise<boolean>} whether it was deleted (false on a cancel or a refusal) */
export async function deletePersona(persona) {
    if (!persona?.id) return false;
    const ok = await CoreAPI.showConfirm({
        title: 'Delete this persona?',
        content: [
            { type: 'text', text: `"${persona.name || 'This persona'}" will be removed.` },
            { type: 'note', text: 'Any chat using it goes back to your global persona. Nothing else is deleted.' },
        ],
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return false;
    const r = await personaRequest(`/personas/${encodeURIComponent(persona.id)}`, 'DELETE');
    if (!r.ok) { CoreAPI.showToast('Could not delete the persona', 'error'); return false; }
    await CoreAPI.syncActivePersonaName();
    // A deleted persona may have been some chat's override (the server SET NULLs it),
    // which the global funnel cannot see; say so ourselves.
    document.dispatchEvent(new CustomEvent('cl-persona-changed', { detail: { scope: 'delete', personaId: persona.id, chatId: null } }));
    return true;
}

// ========================================
// FACES: one stamp per persona, moved only when its picture does, read by every persona face
// ========================================

const _faceStamp = new Map();
// the feed hands each follower the same record objects: a picture record counts once, whichever sees it first
const _countedRecords = new WeakSet();

/** The persona's picture changed: its faces fetch again wherever they are drawn. */
export function bumpPersonaFace(id) {
    if (id) _faceStamp.set(id, Date.now());
}

/** A persona face's url, built from the id (never an authored column) and stamped by its picture; '' with no id. */
export function personaFaceUrl(id, size) {
    return id ? CoreAPI.thumbUrl('persona', id, size, _faceStamp.get(id)) : '';
}

// what the readers last read of each persona, and the ones a reconnect left unknown until a reader reads them again
const _seenAt = new Map();
const _owedRestamp = new Set();

/** Personas a reader got from the server: one that changed while the feed was down restamps its faces. */
export function notePersonaRead(personas) {
    for (const p of personas) {
        if (!p?.id) continue;
        if (_owedRestamp.delete(p.id) && _seenAt.has(p.id) && _seenAt.get(p.id) !== p.updatedAt) bumpPersonaFace(p.id);
        _seenAt.set(p.id, p.updatedAt);
    }
}

/** Feed records: a persona picture changed elsewhere restamps its faces; this tab's own picture verbs stamp as they write. */
export function followPersonaPictures(records) {
    // a reconnect says nothing of what moved: every persona read so far is checked by its next read
    if (!records) { _seenAt.forEach((at, id) => _owedRestamp.add(id)); return; }
    for (const r of records) {
        if (_countedRecords.has(r)) continue;
        _countedRecords.add(r);
        if (r.entity === 'persona' && !isOwnRecord(r) && (!r.fields || r.fields.includes('avatar'))) (r.ids || []).forEach(bumpPersonaFace);
    }
}

// ========================================
// PRONOUNS: the block both persona editors draw (the chat's Personas window, Settings > Chat)
// ========================================

const esc = (s) => CoreAPI.escapeHtml(s);

// the five pronoun forms as a sentence meets them: the persona's key, the label, the macro, the word an empty form answers
export const PRONOUN_FORMS = [
    ['sub', 'Subject', '{{sub}}', 'they'],
    ['obj', 'Object', '{{obj}}', 'them'],
    ['poss', 'Possessive', '{{poss}}', 'their'],
    ['possP', 'Possessive pronoun', '{{poss_p}}', 'theirs'],
    ['ref', 'Reflexive', '{{ref}}', 'themselves'],
];
// what each preset fills the five forms with, in PRONOUN_FORMS' order
export const PRONOUN_PRESETS = [
    ['she', 'She', ['she', 'her', 'her', 'hers', 'herself']],
    ['he', 'He', ['he', 'him', 'his', 'his', 'himself']],
    ['they', 'They', PRONOUN_FORMS.map(f => f[3])],
    ['it', 'It', ['it', 'it', 'its', 'its', 'itself']],
];

// the preset the forms answer as (an empty form answering its they/them word, so all empty reads They), else custom
export function pronounPresetOf(forms) {
    const answered = PRONOUN_FORMS.map(([key, , , word]) => String(forms?.[key] ?? '').trim() || word);
    return PRONOUN_PRESETS.find(([, , words]) => words.every((w, i) => w === answered[i]))?.[0] || 'custom';
}

// the closed fold's summary: subject and object as the five answer them, an empty form its they/them word
export function pronounHintOf(forms) {
    const [sub, obj] = PRONOUN_FORMS.slice(0, 2).map(([key, , , word]) => String(forms?.[key] ?? '').trim() || word);
    return `${sub}/${obj}`;
}

// a preset fills the five fields, each editable after, written at Save; scope keeps each editor's element ids its own
export function pronounsHtml(p, scope = 'cpp') {
    const sc = esc(scope);
    const id = esc(p.id);
    const preset = pronounPresetOf(p.pronouns);
    const choice = (key, label) => `<button type="button" role="radio" class="cl-cwin-tab${preset === key ? ' is-on' : ''}" aria-checked="${preset === key}"
            data-cpp-act="pronoun-preset" data-preset="${key}">${label}</button>`;
    const field = ([key, label, macro, word]) => `<div class="cl-cwin-field">
            <label class="cl-cwin-field-label" for="${sc}Pron_${id}_${key}">${label} <code class="cpp-pronoun-macro">${macro}</code></label>
            <input type="search" id="${sc}Pron_${id}_${key}" class="cl-cwin-input cl-cwin-field-control" data-cpp-pronoun="${key}"
                value="${esc(p.pronouns?.[key] || '')}" placeholder="${word}" maxlength="64"
                autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        </div>`;
    // closed by default: only cards written for a pronoun-aware site read these
    return `<details class="cl-cwin-fold cpp-pronouns">
        <summary class="cl-cwin-fold-summary">
            <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
            <span id="${sc}Pronouns_${id}">Pronouns</span>
            <span class="cl-cwin-fold-hint" data-cpp-pronoun-hint>${esc(pronounHintOf(p.pronouns))}</span>
        </summary>
        <div class="cl-cwin-fold-body">
            <div class="cpp-pronoun-presets" role="radiogroup" aria-labelledby="${sc}Pronouns_${id}">
                ${PRONOUN_PRESETS.map(([key, label]) => choice(key, label)).join('')}
                ${choice('custom', 'Custom')}
            </div>
            ${PRONOUN_FORMS.map(field).join('')}
            <p class="cl-cwin-hint">What <code>{{sub}}</code>, <code>{{obj}}</code>, <code>{{poss}}</code>, <code>{{poss_p}}</code>
                and <code>{{ref}}</code> answer. An empty form answers its they/them word; <code>{{Sub}}</code>
                capitalises the word and <code>{{SUB}}</code> writes it in capitals.</p>
        </div>
    </details>`;
}

export function markPronounPreset(box, key) {
    box?.querySelectorAll('[data-cpp-act="pronoun-preset"]').forEach(b => {
        const on = b.dataset.preset === key;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', String(on));
    });
    const hint = box?.querySelector('[data-cpp-pronoun-hint]');
    if (hint) hint.textContent = pronounHintOf(Object.fromEntries([...box.querySelectorAll('[data-cpp-pronoun]')].map(f => [f.dataset.cppPronoun, f.value])));
}

// a preset writes its words into the fields; Custom keeps them and hands over the first field
export function applyPronounPreset(btn) {
    const box = btn.closest('.cpp-pronouns');
    const preset = PRONOUN_PRESETS.find(([key]) => key === btn.dataset.preset);
    if (preset) {
        PRONOUN_FORMS.forEach(([key], i) => {
            const input = box?.querySelector(`[data-cpp-pronoun="${key}"]`);
            if (input) input.value = preset[2][i];
        });
    }
    markPronounPreset(box, btn.dataset.preset);
    if (!preset) box?.querySelector('[data-cpp-pronoun]')?.focus();
}

// an edited form moves the preset to what the five now answer, Custom unless they match one
export function syncPronounPreset(input) {
    const box = input.closest('.cpp-pronouns');
    const forms = Object.fromEntries([...box.querySelectorAll('[data-cpp-pronoun]')].map(f => [f.dataset.cppPronoun, f.value]));
    markPronounPreset(box, pronounPresetOf(forms));
}

// the forms the editor drew, trimmed: a field that is not there is no empty form
export function readPronouns(root) {
    const pronouns = {};
    for (const [key] of PRONOUN_FORMS) {
        const input = root?.querySelector(`[data-cpp-pronoun="${key}"]`);
        if (input) pronouns[key] = input.value.trim();
    }
    return pronouns;
}
