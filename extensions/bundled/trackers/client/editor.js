// SPDX-License-Identifier: MIT

// The Trackers definition editor, a dialog on the library's canon since it opens from Settings too.
// Every write spells its route here.
import { KINDS, UPDATES, ROLES, TONES, DEFAULT_PROMPT, validateDefinition, normalizeDefinition, clone, updateOf } from './model.js';
import { EXAMPLES } from './examples.js';

const NESTS = ['group', 'rows', 'per-character'];
const KIND_WORDS = { text: 'Text', number: 'Number', choice: 'Choice', boolean: 'Yes or no', list: 'List', group: 'Group', rows: 'Repeating rows', 'per-character': 'Per character' };
const UPDATE_WORDS = { always: 'Updated every reply', once: 'Filled once, then kept', never: 'Yours: never updated' };
const ROLE_WORDS = { detail: 'Detail', headline: 'Headline', badge: 'Badge' };
const TONE_WORDS = { neutral: 'Neutral', 'good-high': 'High is good', 'good-low': 'Low is good' };

const blank = () => ({
    name: 'My tracker',
    icon: 'fa-clipboard-list',
    description: '',
    prompt: { ...DEFAULT_PROMPT },
    fields: [{ key: 'note', label: 'Note', kind: 'text', prompt: '' }],
});
const fromExample = (template) => {
    const { template: _, ...def } = clone(EXAMPLES.find(e => e.template === template));
    return def;
};

export function createEditor(ctx) {
    const { CoreAPI } = ctx;
    const esc = (v) => CoreAPI.escapeHtml(v);
    const call = ctx.server.call;

    let el = null;       // the dialog's body while it is open
    let defs = [];
    let chosen = null;   // a definition's id, or null for a draft not yet saved
    let draft = null;
    let dirty = false;
    let refused = null;  // the server's own problems with the last save
    let busy = false;
    let onChanged = () => {};

    // ---------------------------------------------------------------- open and close

    // the dialog, in the app's own shell and resizable; a dismissal asks first over unsaved edits, a switch-off never
    const dialog = ctx.ui.dialog({
        id: 'editor', label: 'Trackers', icon: 'fa-pen-ruler', className: 'tkr-ed', size: true, min: { w: 720, h: 480 },
        canClose: () => (dirty ? leave() : true),
        onClose: () => {
            el = null;
            dirty = false;
            onChanged();
        },
    });

    async function open({ defId = null, from = null, changed = null } = {}) {
        if (el) close(true);
        onChanged = typeof changed === 'function' ? changed : () => {};
        el = dialog.open();
        el.classList.add('tkr-ed-body');
        el.innerHTML = `
            <aside class="tkr-ed-list" data-ed-list></aside>
            <div class="tkr-ed-main" data-ed-main></div>`;
        el.addEventListener('click', onClick);
        el.addEventListener('input', onInput);
        el.addEventListener('change', onChange);
        await readDefs();
        if (from) startDraft(from === 'blank' ? blank() : fromExample(from));
        else choose(defId && defs.some(d => d.id === defId) ? defId : defs[0]?.id || null);
        paint();
    }

    // a draft with unsaved edits asks first, unless forced
    const close = (force = false) => dialog.close({ force });

    async function leave() {
        if (!dirty) return true;
        const ok = await CoreAPI.showConfirm({
            title: 'Discard your changes?',
            message: `${draft?.name || 'This tracker'} has edits that are not saved.`,
            confirmLabel: 'Discard',
            danger: true,
        });
        if (ok === true) dirty = false;
        return ok === true;
    }

    async function readDefs() {
        try { defs = (await call('/defs')).defs || []; } catch (e) {
            defs = [];
            CoreAPI.showToast(`Could not read your trackers: ${e.message}`, 'error');
        }
    }

    function choose(id) {
        const found = defs.find(d => d.id === id) || null;
        chosen = found ? found.id : null;
        draft = found ? stored(found) : null;
        dirty = false;
        refused = null;
    }

    // a new draft is the reader's to lose only once they change it; one read from a file is theirs at once
    function startDraft(def, { imported = false } = {}) {
        chosen = null;
        draft = def;
        dirty = imported;
        refused = null;
    }

    // a listed definition as the editor works on it: what the model knows of it, and no row fields
    const stored = (d) => {
        const { id: _id, chats: _chats, createdAt: _c, updatedAt: _u, ...def } = d;
        return clone(def);
    };

    // ---------------------------------------------------------------- painting

    function paint() {
        if (!el) return;
        paintList();
        const main = el.querySelector('[data-ed-main]');
        main.innerHTML = draft ? draftHtml(draft) : `<div class="tkr-ed-empty"><p>Pick a tracker, or start one.</p></div>`;
        for (const s of main.querySelectorAll('select')) CoreAPI.initCustomSelect(s);
    }

    function paintList() {
        const row = (key, icon, name, meta, on) => `
            <button type="button" class="tkr-ed-item${on ? ' is-on' : ''}" data-ed-choose="${esc(key)}">
                <i class="fa-solid ${esc(icon || 'fa-clipboard-list')}" aria-hidden="true"></i>
                <span class="tkr-ed-item-name">${esc(name)}</span>
                ${meta ? `<span class="tkr-ed-item-meta">${esc(meta)}</span>` : ''}
            </button>`;
        el.querySelector('[data-ed-list]').innerHTML = `
            <h5 class="tkr-ed-list-title">Your trackers</h5>
            ${defs.length ? defs.map(d => row(`def:${d.id}`, d.icon, d.name, d.chats ? `${d.chats} chat${d.chats === 1 ? '' : 's'}` : '', d.id === chosen && draft)).join('')
                : '<p class="tkr-ed-none">None yet.</p>'}
            ${!chosen && draft ? row('draft', draft.icon, draft.name || 'New tracker', 'not saved', true) : ''}
            <h5 class="tkr-ed-list-title">Start one</h5>
            ${row('new:blank', 'fa-file', 'Blank', '', false)}
            ${EXAMPLES.map(e => row(`new:${e.template}`, e.icon, e.name, 'example', false)).join('')}
            <label class="tkr-ed-item"><i class="fa-solid fa-file-import" aria-hidden="true"></i>
                <span class="tkr-ed-item-name">From a file</span><span class="tkr-ed-item-meta">json</span>
                <input type="file" accept=".json,application/json" data-ed-import hidden></label>`;
    }

    function draftHtml(def) {
        const problems = refused || validateDefinition(def);
        const listed = defs.find(d => d.id === chosen);
        return `
            <div class="tkr-ed-row">
                <label class="tkr-ed-field"><span>Name</span><input type="search" autocomplete="one-time-code" class="cl-input" data-ed-def="name" value="${esc(def.name)}" maxlength="80"></label>
                <label class="tkr-ed-field tkr-ed-narrow"><span>Icon</span><input type="search" autocomplete="one-time-code" class="cl-input" data-ed-def="icon" value="${esc(def.icon || '')}" placeholder="fa-clipboard-list"></label>
            </div>
            <label class="tkr-ed-field"><span>What it is for</span><input type="search" autocomplete="one-time-code" class="cl-input" data-ed-def="description" value="${esc(def.description || '')}" maxlength="300"></label>
            <label class="tkr-ed-field"><span>How its model should behave</span>
                <textarea class="cl-input tkr-ed-area" data-ed-def="prompt.system" rows="3">\n${esc(def.prompt?.system || '')}</textarea></label>
            <label class="tkr-ed-field"><span>What to do each turn</span>
                <textarea class="cl-input tkr-ed-area" data-ed-def="prompt.instruction" rows="2">\n${esc(def.prompt?.instruction || '')}</textarea></label>
            <label class="tkr-ed-field"><span>Heading in the prompt</span>
                <input type="search" autocomplete="one-time-code" class="cl-input" data-ed-def="heading" value="${esc(def.heading || '')}" placeholder="${esc(def.name)}"></label>
            <h4 class="tkr-ed-sub">Fields</h4>
            <p class="tkr-ed-hint">What the tracker keeps. A field's instruction is what teaches its model to fill it in; a field with none usually comes back empty or wrong. {{user}} and {{char}} work in the instructions and the prompts, never in a label.</p>
            <div class="tkr-ed-fields">${(def.fields || []).map((f, i) => fieldHtml(f, [i], def.fields.length)).join('')}</div>
            <button type="button" class="cl-btn cl-btn-secondary tkr-ed-add" data-ed="add" data-ed-path=""><i class="fa-solid fa-plus" aria-hidden="true"></i> Add a Field</button>
            ${problems.length ? `<div class="tkr-ed-problems" role="alert"><strong>${refused ? 'Not saved:' : 'Not ready to save:'}</strong><ul>${problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
            <div class="tkr-ed-foot">
                <button type="button" class="cl-btn cl-btn-primary" data-ed="save"${busy || validateDefinition(def).length ? ' disabled' : ''}><i class="fa-solid fa-check" aria-hidden="true"></i> Save</button>
                ${listed ? `<button type="button" class="cl-btn cl-btn-secondary" data-ed="duplicate"${busy ? ' disabled' : ''}><i class="fa-solid fa-clone" aria-hidden="true"></i> Duplicate</button>` : ''}
                <button type="button" class="cl-btn cl-btn-secondary" data-ed="export"><i class="fa-solid fa-file-export" aria-hidden="true"></i> Export</button>
                ${listed ? `<button type="button" class="cl-btn cl-btn-danger" data-ed="delete"${busy ? ' disabled' : ''}><i class="fa-solid fa-trash" aria-hidden="true"></i> Delete</button>` : ''}
            </div>`;
    }

    const options = (list, words, value) => list.map(v => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(words[v] || v)}</option>`).join('');

    // one field: key, label, kind and how often it updates on the head line, its settings and instruction under it, then its children
    function fieldHtml(f, path, siblings) {
        const p = path.join('.');
        const at = path.at(-1);
        const kids = NESTS.includes(f.kind);
        return `
            <div class="tkr-ed-fieldrow" data-ed-row="${esc(p)}">
                <div class="tkr-ed-fieldhead">
                    <input type="search" autocomplete="one-time-code" class="cl-input tkr-ed-key" data-ed-field="${esc(p)}.key" value="${esc(f.key || '')}" placeholder="key" aria-label="Key">
                    <input type="search" autocomplete="one-time-code" class="cl-input tkr-ed-label" data-ed-field="${esc(p)}.label" value="${esc(f.label || '')}" placeholder="Label" aria-label="Label">
                    <select class="cl-select-fluid tkr-ed-select" data-ed-field="${esc(p)}.kind" aria-label="Kind">${options(KINDS, KIND_WORDS, f.kind)}</select>
                    <select class="cl-select-fluid tkr-ed-select" data-ed-field="${esc(p)}.update" aria-label="Updates">${options(UPDATES, UPDATE_WORDS, updateOf(f))}</select>
                    <span class="tkr-ed-moves">
                        <button type="button" class="cl-btn cl-btn-secondary tkr-ed-icon" data-ed="up" data-ed-path="${esc(p)}" title="Move up" aria-label="Move up"${at === 0 ? ' disabled' : ''}><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button>
                        <button type="button" class="cl-btn cl-btn-secondary tkr-ed-icon" data-ed="down" data-ed-path="${esc(p)}" title="Move down" aria-label="Move down"${at === siblings - 1 ? ' disabled' : ''}><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></button>
                        <button type="button" class="cl-btn cl-btn-secondary tkr-ed-icon" data-ed="remove" data-ed-path="${esc(p)}" title="Remove" aria-label="Remove"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
                    </span>
                </div>
                <div class="tkr-ed-fieldopts">
                    <select class="cl-select-fluid tkr-ed-select" data-ed-field="${esc(p)}.role" aria-label="Role">${options(ROLES.slice().sort((a, b) => (a === 'detail' ? -1 : b === 'detail' ? 1 : 0)), ROLE_WORDS, f.role || 'detail')}</select>
                    ${f.kind === 'number' || f.kind === 'text' || f.kind === 'choice' || f.kind === 'boolean'
                        ? `<select class="cl-select-fluid tkr-ed-select" data-ed-field="${esc(p)}.tone" aria-label="Tone">${options(TONES.slice().sort((a, b) => (a === 'neutral' ? -1 : b === 'neutral' ? 1 : 0)), TONE_WORDS, f.tone || 'neutral')}</select>` : ''}
                    ${f.kind === 'number' ? `
                        <input type="number" class="cl-input tkr-ed-num" data-ed-field="${esc(p)}.min" value="${esc(Number.isFinite(f.min) ? f.min : '')}" placeholder="min" aria-label="Lowest">
                        <input type="number" class="cl-input tkr-ed-num" data-ed-field="${esc(p)}.max" value="${esc(Number.isFinite(f.max) ? f.max : '')}" placeholder="max" aria-label="Highest">` : ''}
                    ${f.kind === 'choice' ? `<input type="search" autocomplete="one-time-code" class="cl-input tkr-ed-grow" data-ed-field="${esc(p)}.options" value="${esc((f.options || []).join(', '))}" placeholder="the options, comma separated" aria-label="Options">` : ''}
                    ${kids ? '' : `<input type="search" autocomplete="one-time-code" class="cl-input tkr-ed-grow" data-ed-field="${esc(p)}.example" value="${esc(f.example ?? '')}" placeholder="an example value" aria-label="Example">`}
                </div>
                <textarea class="cl-input tkr-ed-area" data-ed-field="${esc(p)}.prompt" rows="2" placeholder="What its model should put here" aria-label="Instruction">\n${esc(f.prompt || '')}</textarea>
                ${kids ? `<div class="tkr-ed-kids">
                    ${(f.fields || []).map((c, i) => fieldHtml(c, [...path, 'fields', i], f.fields.length)).join('')}
                    <button type="button" class="cl-btn cl-btn-secondary tkr-ed-add" data-ed="add" data-ed-path="${esc(p)}"><i class="fa-solid fa-plus" aria-hidden="true"></i> Add Inside</button>
                </div>` : ''}
            </div>`;
    }

    // ---------------------------------------------------------------- editing the draft

    // a field's path from the top list: "1" is its second field, "0.fields.2" the third inside the first
    const keysOf = (dotted) => dotted.split('.').map(k => (/^\d+$/.test(k) ? Number(k) : k));
    const nodeAt = (keys) => keys.reduce((n, k) => (n == null ? n : n[k]), draft.fields);
    // a field's list and its place in it
    const slot = (dotted) => {
        const keys = keysOf(dotted);
        const index = keys.pop();
        const list = keys.length ? nodeAt(keys) : draft.fields;
        return { list, index };
    };
    const changed = (repaint = false) => {
        dirty = true;
        refused = null;
        if (repaint) paint();
        else refreshChecks();
    };
    // the problems and the save button follow the typing without repainting the form under the caret
    function refreshChecks() {
        const main = el.querySelector('[data-ed-main]');
        const problems = validateDefinition(draft);
        const box = main.querySelector('.tkr-ed-problems');
        const html = problems.length ? `<strong>Not ready to save:</strong><ul>${problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : '';
        if (box && html) box.innerHTML = html;
        else if (box) box.remove();
        else if (html) main.querySelector('.tkr-ed-foot').insertAdjacentHTML('beforebegin', `<div class="tkr-ed-problems" role="alert">${html}</div>`);
        main.querySelector('[data-ed="save"]').disabled = busy || problems.length > 0;
        paintList();
    }

    function setField(dotted, raw, repaint) {
        const keys = keysOf(dotted);
        const prop = keys.pop();
        const field = nodeAt(keys);
        if (!field) return;
        let value = raw;
        if (prop === 'options') value = raw.split(',').map(s => s.trim()).filter(Boolean);
        if (prop === 'min' || prop === 'max') value = raw === '' ? undefined : Number(raw);
        if (prop === 'example') value = raw === '' ? undefined : (field.kind === 'number' && raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw);
        if ((prop === 'role' && raw === 'detail') || (prop === 'tone' && raw === 'neutral') || (prop === 'update' && raw === 'always')) value = undefined;
        if (value === undefined) delete field[prop];
        else field[prop] = value;
        // a kind that holds fields starts with one inside, and one that does not drops what it held
        if (prop === 'kind') {
            if (NESTS.includes(value) && !Array.isArray(field.fields)) field.fields = [{ key: 'item', label: 'Item', kind: 'text' }];
            if (!NESTS.includes(value)) delete field.fields;
            if (value !== 'choice') delete field.options;
            if (value === 'choice' && !Array.isArray(field.options)) field.options = [];
            if (value !== 'number') { delete field.min; delete field.max; }
        }
        changed(repaint);
    }

    function setDef(dotted, raw) {
        if (dotted.startsWith('prompt.')) {
            draft.prompt = { ...(draft.prompt || {}), [dotted.slice(7)]: raw };
        } else if (raw === '' && (dotted === 'heading' || dotted === 'icon')) {
            delete draft[dotted];
        } else {
            draft[dotted] = raw;
        }
        changed(false);
    }

    function onInput(e) {
        const d = e.target.closest('[data-ed-def]');
        if (d && draft) { setDef(d.dataset.edDef, d.value); return; }
        const f = e.target.closest('[data-ed-field]');
        if (f && draft && f.tagName !== 'SELECT') setField(f.dataset.edField, f.value, false);
    }

    function onChange(e) {
        const imp = e.target.closest('[data-ed-import]');
        if (imp) { void importFile(imp.files?.[0]); imp.value = ''; return; }
        const f = e.target.closest('[data-ed-field]');
        // a select changes what the row offers, so the form is drawn again
        if (f && draft && f.tagName === 'SELECT') setField(f.dataset.edField, f.value, true);
    }

    async function onClick(e) {
        const pick = e.target.closest('[data-ed-choose]');
        if (pick) {
            const key = pick.dataset.edChoose;
            if (key === 'draft') return;
            if (!(await leave())) return;
            if (key.startsWith('def:')) choose(key.slice(4));
            else startDraft(key === 'new:blank' ? blank() : fromExample(key.slice(4)));
            paint();
            return;
        }
        const v = e.target.closest('[data-ed]');
        if (!v || v.disabled) return;
        const path = v.dataset.edPath;
        switch (v.dataset.ed) {
            case 'add': {
                const list = path ? nodeAt(keysOf(path)).fields : draft.fields;
                list.push({ key: `field${list.length + 1}`, label: '', kind: 'text' });
                changed(true);
                break;
            }
            case 'remove': { const { list, index } = slot(path); list.splice(index, 1); changed(true); break; }
            case 'up': case 'down': {
                const { list, index } = slot(path);
                const to = v.dataset.ed === 'up' ? index - 1 : index + 1;
                if (to < 0 || to >= list.length) break;
                [list[index], list[to]] = [list[to], list[index]];
                changed(true);
                break;
            }
            case 'save': await save(); break;
            case 'duplicate': {
                // a copy of what is stored: edits not saved are the reader's to keep or let go first
                if (!(await leave())) break;
                choose(chosen);
                const copy = clone(draft);
                copy.name = `${copy.name} (copy)`.slice(0, 80);
                startDraft(copy);
                paint();
                break;
            }
            case 'export': exportDraft(); break;
            case 'delete': await remove(); break;
            default: break;
        }
    }

    // ---------------------------------------------------------------- the writes

    async function save() {
        if (busy || !draft || validateDefinition(draft).length) return;
        busy = true;
        paint();
        const def = normalizeDefinition(draft);
        try {
            if (chosen) await call(`/defs/${encodeURIComponent(chosen)}`, 'PUT', { def });
            else chosen = (await call('/defs', 'POST', { def })).id;
            dirty = false;
            refused = null;
            CoreAPI.showToast(`${def.name} saved`, 'success');
            await readDefs();
            choose(chosen);
        } catch (e) {
            refused = e.data?.problems || [e.message];
        } finally {
            busy = false;
        }
        paint();
    }

    async function remove() {
        const listed = defs.find(d => d.id === chosen);
        if (!listed || busy) return;
        const ok = await CoreAPI.showConfirm({
            title: `Delete ${listed.name}?`,
            message: listed.chats
                ? `${listed.chats} chat${listed.chats === 1 ? ' keeps' : 's keep'} it: it leaves ${listed.chats === 1 ? 'that chat' : 'them'}, with everything it kept there.`
                : 'No chat keeps it.',
            confirmLabel: 'Delete',
            danger: true,
            icon: 'fa-solid fa-trash',
        });
        if (ok !== true) return;
        busy = true;
        try {
            await call(`/defs/${encodeURIComponent(listed.id)}`, 'DELETE');
            CoreAPI.showToast(`${listed.name} deleted`, 'success');
        } catch (e) {
            CoreAPI.showToast(`Could not delete it: ${e.message}`, 'error');
        } finally {
            busy = false;
        }
        await readDefs();
        choose(defs[0]?.id || null);
        paint();
    }

    function exportDraft() {
        const def = normalizeDefinition(draft);
        const name = String(def.name || 'tracker').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tracker';
        CoreAPI.downloadBlobAsFile(new Blob([JSON.stringify(def, null, 2)], { type: 'application/json' }), `tracker-${name}.json`);
    }

    // a file of someone's becomes a draft of the reader's, shown with its problems until it is saved
    async function importFile(file) {
        if (!file) return;
        let def;
        try { def = JSON.parse(await file.text()); } catch {
            CoreAPI.showToast('That file is not JSON', 'error');
            return;
        }
        if (!def || typeof def !== 'object' || Array.isArray(def)) { CoreAPI.showToast('That file holds no tracker', 'error'); return; }
        if (!(await leave())) return;
        const { id: _id, chats: _c, template: _t, ...rest } = def;
        startDraft(editable(rest), { imported: true });
        paint();
    }

    // a file's definition in the form's editable shape, the lists arrays; validateDefinition says what is still wrong
    function editable(def) {
        const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
        const fields = (list) => (Array.isArray(list) ? list : []).map((f) => {
            const out = obj(f) ? { ...f } : {};
            if (NESTS.includes(out.kind)) out.fields = fields(out.fields);
            if (out.kind === 'choice') {
                const raw = Array.isArray(out.options) ? out.options : typeof out.options === 'string' ? out.options.split(',') : [];
                out.options = raw.map(o => String(o).trim()).filter(Boolean);
            }
            return out;
        });
        return { ...def, prompt: obj(def.prompt) ? def.prompt : {}, fields: fields(def.fields) };
    }

    return { open, close, isOpen: () => !!el };
}
