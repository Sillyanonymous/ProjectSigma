// Inspired by kaldigo's Tracker for SillyTavern; thanks to its author.

// A tracker definition and everything derived from it, for both halves; a new field kind is one entry
// here.

export const KINDS = ['text', 'number', 'choice', 'boolean', 'list', 'group', 'rows', 'per-character'];

// how often the model writes a field: after every reply, once and then kept, or never (the reader's own)
export const UPDATES = ['always', 'once', 'never'];

// how loud a field is in a card: the line read first (headline), a chip beside the name (badge),
// or the rest (detail)
export const ROLES = ['headline', 'badge', 'detail'];

// which end of a bounded range is good, since the numbers cannot say (a Suspicion is bad high, a Condition bad low)
export const TONES = ['good-high', 'good-low', 'neutral'];

// what a tracker's model is told when its definition says nothing: the run's fallback and a blank draft's text
export const DEFAULT_PROMPT = Object.freeze({
    system: 'You take notes on the state of a story being written in this chat. You report the current state, never events, and you never write story.',
    instruction: 'Update the tracker from the messages above. Carry forward anything that has not changed.',
});

// where a state keeps the keys a model added that the definition does not list
export const UNLISTED = '_unlisted';
const unlistedOf = (node) => (isObj(node?.[UNLISTED]) ? node[UNLISTED] : {});

export const LIMITS = Object.freeze({
    name: 80, description: 300, heading: 200, prompt: 4000, icon: 40,
    label: 60, fieldPrompt: 1000, example: 200, option: 60, options: 30,
    fields: 80, depth: 3,
    // what a state may hold, whatever a model answers
    text: 2000, listItems: 50, listItem: 200, rows: 100, people: 40, extraKeys: 20, extraValue: 1000,
    state: 65536,
});

// the settings' numbers and ranges; the section and the server read them through the same clamp
export const SETTING_LIMITS = Object.freeze({
    turns: Object.freeze([1, 40]),
    depth: Object.freeze([0, 100]),
});

/** A numeric setting held to its range; a value that reads as no number is the declared default. */
export function settingNumber(key, value, fallback) {
    const [lo, hi] = SETTING_LIMITS[key];
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const ICON_RE = /^fa-[a-z0-9-]{1,36}$/;
const hasChildren = (f) => f.kind === 'group' || f.kind === 'rows' || f.kind === 'per-character';
/** How often the model writes a field. */
export const updateOf = (f) => (UPDATES.includes(f?.update) ? f.update : 'always');

// ---------------------------------------------------------------- the definition

/** Depth-first over every field, handing each one its label path. */
export function walkFields(fields, fn, path = []) {
    for (const f of Array.isArray(fields) ? fields : []) {
        if (!isObj(f)) continue;
        const here = [...path, f.label || f.key];
        fn(f, here);
        if (hasChildren(f)) walkFields(f.fields, fn, here);
    }
}

/**
 * Everything wrong with a definition as sentences to act on; empty when it may be saved (the id is the server's).
 * @returns {string[]}
 */
export function validateDefinition(def) {
    if (!isObj(def)) return ['A definition must be an object.'];
    const problems = [];
    const text = (v) => (typeof v === 'string' ? v : '');
    const name = text(def.name).trim();
    if (!name) problems.push('A definition needs a name.');
    else if (name.length > LIMITS.name) problems.push(`A name is at most ${LIMITS.name} characters.`);
    if (/\{\{/.test(name)) problems.push('A name is read by a person, so it holds no macro.');
    if (def.icon !== undefined && def.icon !== '' && !ICON_RE.test(text(def.icon))) problems.push('An icon is a Font Awesome name, like fa-clipboard-list.');
    if (text(def.description).length > LIMITS.description) problems.push(`A description is at most ${LIMITS.description} characters.`);
    if (text(def.heading).length > LIMITS.heading) problems.push(`A heading is at most ${LIMITS.heading} characters.`);
    for (const k of ['system', 'instruction']) {
        if (def.prompt?.[k] !== undefined && typeof def.prompt[k] !== 'string') problems.push(`The ${k} prompt is text.`);
        else if (text(def.prompt?.[k]).length > LIMITS.prompt) problems.push(`The ${k} prompt is at most ${LIMITS.prompt} characters.`);
    }
    if (!Array.isArray(def.fields) || !def.fields.length) problems.push('A definition needs at least one field.');
    let count = 0;
    const walk = (fields, path, depth) => {
        for (const f of Array.isArray(fields) ? fields : []) {
            count++;
            if (!isObj(f)) { problems.push(`${path.join(' > ') || 'The top level'}: a field must be an object.`); continue; }
            const where = [...path, f.label || f.key || '(unnamed)'].join(' > ');
            if (!KEY_RE.test(text(f.key))) problems.push(`"${where}": the key starts with a letter and holds only letters, digits and underscores.`);
            if (!KINDS.includes(f.kind)) problems.push(`"${where}": ${f.kind} is not a field kind (${KINDS.join(', ')}).`);
            if (f.update !== undefined && !UPDATES.includes(f.update)) problems.push(`"${where}": ${f.update} is not how often a field updates (${UPDATES.join(', ')}).`);
            if (f.role !== undefined && !ROLES.includes(f.role)) problems.push(`"${where}": ${f.role} is not a role (${ROLES.join(', ')}).`);
            if (f.tone !== undefined && !TONES.includes(f.tone)) problems.push(`"${where}": ${f.tone} is not a tone (${TONES.join(', ')}).`);
            if (text(f.label).length > LIMITS.label) problems.push(`"${where}": a label is at most ${LIMITS.label} characters.`);
            // a label is read by a person and the window has no macros: {{user}} would show its braces
            if (/\{\{/.test(text(f.label))) problems.push(`"${where}": a label holds no macro; say {{user}} in the field's instruction, which the model reads.`);
            if (f.prompt !== undefined && typeof f.prompt !== 'string') problems.push(`"${where}": the instruction is text.`);
            else if (text(f.prompt).length > LIMITS.fieldPrompt) problems.push(`"${where}": an instruction is at most ${LIMITS.fieldPrompt} characters.`);
            if (f.example !== undefined && !(typeof f.example === 'string' && f.example.length <= LIMITS.example) && !Number.isFinite(f.example)) {
                problems.push(`"${where}": an example is a short text or a number.`);
            }
            if (f.kind === 'choice') {
                const opts = Array.isArray(f.options) ? f.options : [];
                if (!opts.length) problems.push(`"${where}": a choice needs options.`);
                else if (opts.length > LIMITS.options) problems.push(`"${where}": a choice has at most ${LIMITS.options} options.`);
                if (opts.some(o => typeof o !== 'string' || !o.trim() || o.length > LIMITS.option)) problems.push(`"${where}": an option is a short text.`);
                if (new Set(opts).size !== opts.length) problems.push(`"${where}": two options are the same.`);
            }
            if (f.kind === 'number') {
                for (const k of ['min', 'max']) if (f[k] !== undefined && f[k] !== null && !Number.isFinite(f[k])) problems.push(`"${where}": ${k} is a number.`);
                if (Number.isFinite(f.min) && Number.isFinite(f.max) && f.min >= f.max) problems.push(`"${where}": min is below max.`);
            }
            if (hasChildren(f)) {
                if (!Array.isArray(f.fields) || !f.fields.length) problems.push(`"${where}": a ${f.kind} needs fields inside it.`);
                else if (depth >= LIMITS.depth) problems.push(`"${where}": fields nest at most ${LIMITS.depth} deep.`);
                else {
                    const keys = f.fields.map(c => c?.key);
                    const dupe = keys.find((k, i) => k && keys.indexOf(k) !== i);
                    if (dupe) problems.push(`Inside "${where}": two fields share the key "${dupe}".`);
                    walk(f.fields, [...path, f.label || f.key], depth + 1);
                }
            }
        }
    };
    walk(def.fields, [], 1);
    if (Array.isArray(def.fields)) {
        const keys = def.fields.map(f => f?.key);
        const dupe = keys.find((k, i) => k && keys.indexOf(k) !== i);
        if (dupe) problems.push(`At the top level: two fields share the key "${dupe}".`);
    }
    if (count > LIMITS.fields) problems.push(`A definition holds at most ${LIMITS.fields} fields.`);
    return problems;
}

/** A definition with only what the model knows of it, in its own order: what is stored and exported. */
export function normalizeDefinition(def) {
    const text = (v) => (typeof v === 'string' ? v : '');
    const field = (f) => {
        const out = { key: f.key, label: text(f.label) || f.key, kind: f.kind };
        if (updateOf(f) !== 'always') out.update = updateOf(f);
        if (f.role && f.role !== 'detail') out.role = f.role;
        if (f.tone && f.tone !== 'neutral') out.tone = f.tone;
        if (text(f.prompt)) out.prompt = f.prompt;
        if (f.example !== undefined && f.example !== '') out.example = f.example;
        if (f.kind === 'choice') out.options = f.options.slice();
        if (f.kind === 'number') {
            if (Number.isFinite(f.min)) out.min = f.min;
            if (Number.isFinite(f.max)) out.max = f.max;
        }
        if (hasChildren(f)) out.fields = f.fields.map(field);
        return out;
    };
    const out = { name: text(def.name).trim(), icon: text(def.icon) || 'fa-clipboard-list', description: text(def.description) };
    if (text(def.heading)) out.heading = def.heading;
    out.prompt = { system: text(def.prompt?.system), instruction: text(def.prompt?.instruction) };
    out.fields = def.fields.map(field);
    return out;
}

// ---------------------------------------------------------------- the model's brief

const writable = (fields) => (Array.isArray(fields) ? fields : []).filter(f => updateOf(f) !== 'never');

/** The per-field instructions, as an indented list: what teaches the model what each field is for. */
export function instructions(def, indent = 0) {
    const out = [];
    for (const f of writable(def.fields)) {
        const pad = '  '.repeat(indent);
        const bits = [`${pad}- ${f.label || f.key} (${describeKind(f)})`];
        if (String(f.prompt || '').trim()) bits.push(`: ${String(f.prompt).trim()}`);
        if (updateOf(f) === 'once') bits.push(' [set this once, then leave it as it is unless it genuinely changes]');
        out.push(bits.join(''));
        if (hasChildren(f)) out.push(instructions(f, indent + 1));
    }
    return out.filter(Boolean).join('\n');
}

function describeKind(f) {
    switch (f.kind) {
        case 'choice': return `one of: ${(f.options || []).join(', ')}`;
        case 'number': return numberRange(f);
        case 'boolean': return 'true or false';
        case 'list': return 'a list of short strings';
        case 'rows': return 'a list of entries';
        case 'per-character': return 'one entry per character present, keyed by their name';
        case 'group': return 'a group';
        default: return 'text';
    }
}

function numberRange(f) {
    const lo = Number.isFinite(f.min) ? f.min : null;
    const hi = Number.isFinite(f.max) ? f.max : null;
    if (lo !== null && hi !== null) return `a number from ${lo} to ${hi}`;
    if (lo !== null) return `a number, at least ${lo}`;
    if (hi !== null) return `a number, at most ${hi}`;
    return 'a number';
}

/** The shape the model fills: real JSON, each leaf a short description of what belongs there. */
export function skeleton(def) {
    const build = (fields) => {
        const out = {};
        for (const f of writable(fields)) out[f.key] = leaf(f);
        return out;
    };
    const leaf = (f) => {
        switch (f.kind) {
            case 'group': return build(f.fields);
            case 'rows': return [build(f.fields)];
            case 'per-character': return { '<character name>': build(f.fields) };
            case 'list': return [f.example ? String(f.example) : '<short entry>'];
            case 'boolean': return true;
            case 'number': return Number.isFinite(f.example) ? f.example : 0;
            case 'choice': return (f.options || [])[0] ?? '<one of the options>';
            default: return f.example ? String(f.example) : `<${(f.label || f.key).toLowerCase()}>`;
        }
    };
    return build(def.fields);
}

/** A state with nothing in it, which a chat starts on. */
export function blankState(def) {
    const out = {};
    for (const f of Array.isArray(def.fields) ? def.fields : []) out[f.key] = emptyFor(f);
    return out;
}

// UNSET, not zero or false: a tracker that never ran must not report "Heat: 0" as measured
function emptyFor(f) {
    switch (f.kind) {
        case 'group': return blankState({ fields: f.fields });
        case 'rows': case 'list': return [];
        case 'per-character': return {};
        case 'boolean': return null;
        case 'number': return null;
        default: return '';
    }
}

// ---------------------------------------------------------------- folding an answer back

/**
 * Fold an answer onto the state before it: maps merge by name, each field's update holds, unknown keys stay, answers are bounded.
 * @param {{ reader?: boolean }} [opts] reader: the reader's own correction, which writes every field
 * @returns {Object} the new state
 */
export function reconcile(def, answer, previous, { reader = false } = {}) {
    const fold = (fields, a, p) => {
        const out = {};
        const known = new Set();
        for (const f of Array.isArray(fields) ? fields : []) {
            known.add(f.key);
            const before = p?.[f.key];
            const given = a?.[f.key];
            const update = reader ? 'always' : updateOf(f);
            if (update === 'never') { out[f.key] = before ?? emptyFor(f); continue; }
            if (update === 'once' && filled(before)) { out[f.key] = before; continue; }
            if (given === undefined) { out[f.key] = before ?? emptyFor(f); continue; }
            out[f.key] = foldValue(f, given, before, fold);
        }
        const extra = { ...unlistedOf(p) };
        if (!reader) {
            for (const [k, v] of Object.entries(isObj(a) ? a : {})) {
                if (known.has(k) || k === UNLISTED || v === undefined) continue;
                if (v === null) delete extra[k];
                else extra[k] = boundExtra(v);
            }
        }
        const keys = Object.keys(extra).slice(0, LIMITS.extraKeys);
        if (keys.length) out[UNLISTED] = Object.fromEntries(keys.map(k => [k, extra[k]]));
        return out;
    };
    return fold(def.fields, isObj(answer) ? answer : {}, isObj(previous) ? previous : {});
}

function foldValue(f, given, before, fold) {
    switch (f.kind) {
        case 'group':
            return fold(f.fields, isObj(given) ? given : {}, isObj(before) ? before : {});
        case 'rows': {
            // a rows entry folds onto the previous entry of its name, so a field written once or kept by the reader survives
            const nameKey = (f.fields || []).find(c => c.kind === 'text')?.key;
            const was = Array.isArray(before) ? before : [];
            const nameOf = (row) => (nameKey && isObj(row) && typeof row[nameKey] === 'string' ? row[nameKey].trim().toLowerCase() : '');
            return (Array.isArray(given) ? given : []).slice(0, LIMITS.rows).map((row, i) => {
                const name = nameOf(row);
                const prev = name ? was.find(r => nameOf(r) === name) : was[i];
                return fold(f.fields, isObj(row) ? row : {}, isObj(prev) ? prev : {});
            });
        }
        case 'per-character': {
            const merged = isObj(before) ? { ...before } : {};
            // a name folds onto the stored spelling in any case, as a rows entry does: 'jim' after 'Jim' is Jim
            const keyOf = new Map();
            for (const k of Object.keys(merged)) if (!keyOf.has(k.toLowerCase())) keyOf.set(k.toLowerCase(), k);
            if (isObj(given)) {
                for (const [who, entry] of Object.entries(given)) {
                    const name = String(who).trim().slice(0, LIMITS.label);
                    if (!name) continue;
                    const key = keyOf.get(name.toLowerCase()) ?? name;
                    if (entry === null) { delete merged[key]; keyOf.delete(name.toLowerCase()); }
                    else {
                        merged[key] = fold(f.fields, isObj(entry) ? entry : {}, isObj(merged[key]) ? merged[key] : {});
                        keyOf.set(name.toLowerCase(), key);
                    }
                }
            }
            const names = Object.keys(merged);
            return names.length > LIMITS.people ? Object.fromEntries(names.slice(-LIMITS.people).map(n => [n, merged[n]])) : merged;
        }
        case 'list':
            // the newest kept, as the characters are: a list told to grow keeps growing at its end
            return (Array.isArray(given) ? given : [given]).filter(v => v != null && v !== '')
                .map(v => String(v).slice(0, LIMITS.listItem)).slice(-LIMITS.listItems);
        case 'boolean':
            return given === null ? null : given === true || given === 'true';
        case 'number': {
            if (given === null) return null;
            const n = typeof given === 'number' ? given : typeof given === 'string' && given.trim() ? Number(given) : NaN;
            return Number.isFinite(n) ? clamp(n, f) : (before ?? null);
        }
        case 'choice':
            if (given === null || given === '') return '';
            return (f.options || []).includes(given) ? given : (before ?? '');
        default:
            return given == null ? '' : String(typeof given === 'object' ? JSON.stringify(given) : given).slice(0, LIMITS.text);
    }
}

function boundExtra(v) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > LIMITS.extraValue ? `${s.slice(0, LIMITS.extraValue - 3)}...` : v;
}

const clamp = (n, f) => {
    let v = n;
    if (Number.isFinite(f.min)) v = Math.max(v, f.min);
    if (Number.isFinite(f.max)) v = Math.min(v, f.max);
    return v;
};

/** Whether a value counts as set: for a field written once, the prompt's skipping and the window's. */
export function filled(v) {
    if (v == null) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.length > 0;
    if (isObj(v)) return Object.keys(v).length > 0;
    return true;
}

/** A state without the keys the model added, as the model is shown it. */
export function definedPart(state) {
    if (!isObj(state)) return {};
    const strip = (node) => {
        if (Array.isArray(node)) return node.map(strip);
        if (!isObj(node)) return node;
        const out = {};
        for (const [k, v] of Object.entries(node)) if (k !== UNLISTED) out[k] = strip(v);
        return out;
    };
    return strip(state);
}

// ---------------------------------------------------------------- into the story prompt

/**
 * The state as text for the story model: labelled lines, nothing empty, no JSON; empty when nothing is set.
 */
export function renderForPrompt(def, state) {
    const lines = [];
    const emit = (fields, data, indent) => {
        for (const f of Array.isArray(fields) ? fields : []) {
            const v = data?.[f.key];
            if (!filled(v)) continue;
            const pad = '  '.repeat(indent);
            const label = f.label || f.key;
            switch (f.kind) {
                case 'group': {
                    const before = lines.length;
                    lines.push(`${pad}${label}:`);
                    emit(f.fields, v, indent + 1);
                    if (lines.length === before + 1) lines.pop();
                    break;
                }
                case 'rows':
                    lines.push(`${pad}${label}:`);
                    for (const row of v) {
                        const inline = inlineRow(f.fields, row);
                        if (inline) lines.push(`${pad}  - ${inline}`);
                    }
                    break;
                case 'per-character':
                    lines.push(`${pad}${label}:`);
                    for (const [who, entry] of Object.entries(v)) {
                        const inline = inlineRow(f.fields, entry);
                        lines.push(`${pad}  ${who}${inline ? `: ${inline}` : ''}`);
                    }
                    break;
                case 'list':
                    lines.push(`${pad}${label}: ${v.join(', ')}`);
                    break;
                case 'boolean':
                    lines.push(`${pad}${label}: ${v ? 'yes' : 'no'}`);
                    break;
                default:
                    lines.push(`${pad}${label}: ${v}`);
                    break;
            }
        }
    };
    emit(def.fields, state, 0);
    if (!lines.length) return '';
    const head = String(def.heading || def.name || '').trim();
    return head ? `${head}\n${lines.join('\n')}` : lines.join('\n');
}

function inlineRow(fields, data) {
    const parts = [];
    for (const f of Array.isArray(fields) ? fields : []) {
        const v = data?.[f.key];
        if (!filled(v)) continue;
        if (f.kind === 'boolean') parts.push(`${f.label || f.key}: ${v ? 'yes' : 'no'}`);
        else if (Array.isArray(v)) parts.push(`${f.label || f.key}: ${v.map(x => (isObj(x) ? inlineRow(f.fields, x) : x)).filter(Boolean).join(', ')}`);
        else if (isObj(v)) continue;
        else parts.push(`${f.label || f.key}: ${v}`);
    }
    return parts.join('; ');
}

// ---------------------------------------------------------------- reading an answer

/**
 * Pull an object out of a model's answer: a truncated one is closed, a trailing comma repaired, anything else refused whole.
 * @returns {{ok: true, value: Object} | {ok: false, reason: string}}
 */
export function parseAnswer(text) {
    const raw = String(text ?? '');
    if (!raw.trim()) return { ok: false, reason: 'the model answered nothing' };
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)(?:```|$)/);
    const body = fenced ? fenced[1] : raw;
    const start = body.indexOf('{');
    if (start === -1) return { ok: false, reason: 'the answer held no object' };
    const candidate = sliceBalanced(body.slice(start));
    if (!candidate) return { ok: false, reason: 'the answer was cut off before its object began' };
    for (const attempt of [candidate, repairTrailingCommas(candidate)]) {
        try {
            const value = JSON.parse(attempt);
            if (isObj(value)) return { ok: true, value };
        } catch { /* the repair next, then refused */ }
    }
    return { ok: false, reason: 'the answer was not valid JSON' };
}

// from an opening brace to its match, braces in strings ignored; an answer that stops has its containers closed
function sliceBalanced(s) {
    let depth = 0, inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') { depth--; if (depth === 0) return s.slice(0, i + 1); }
    }
    if (depth <= 0) return null;
    const stack = [];
    inStr = false; esc = false;
    for (const c of s) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') stack.push('}');
        else if (c === '[') stack.push(']');
        else if (c === '}' || c === ']') stack.pop();
    }
    return s.trimEnd().replace(/,$/, '') + (inStr ? '"' : '') + stack.reverse().join('');
}

function repairTrailingCommas(s) {
    let out = '', inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (esc) { out += c; esc = false; continue; }
        if (c === '\\') { out += c; esc = true; continue; }
        if (c === '"') { inStr = !inStr; out += c; continue; }
        if (!inStr && c === ',' && /^\s*[}\]]/.test(s.slice(i + 1))) continue;
        out += c;
    }
    return out;
}

// ---------------------------------------------------------------- what a state was read against

/** Every text a message holds (its alternates, else mes): a state read against none of them is gone. */
export function heldTexts(msg) {
    if (!isObj(msg)) return [];
    const swipes = Array.isArray(msg.swipes) && msg.swipes.length ? msg.swipes : [msg.mes];
    return swipes.filter(t => typeof t === 'string');
}

/** A deep copy of plain JSON. */
export const clone = (v) => JSON.parse(JSON.stringify(v));
