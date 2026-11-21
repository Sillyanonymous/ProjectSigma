// Regex scripts in SillyTavern's file format, applied with its results. Pure, so the page imports this same file.

/** Where a script acts, by the numbers SillyTavern's script files carry in `placement`. */
export const PLACE = Object.freeze({ userInput: 1, aiOutput: 2, narrator: 3, lore: 5, reasoning: 6 });

// ---------------------------------------------------------------- a script's own fields

const textOnly = (s) => !s.markdownOnly && !s.promptOnly;

function joins(script, pass) {
    switch (pass) {
        case 'screen': return !!script.markdownOnly;
        case 'prompt':
        case 'lore': return !!script.promptOnly;
        default: return false;
    }
}

// a bound of -1 or more for the floor, 0 or more for the ceiling; null, absent or not a number is no bound
function bound(value, least) {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isNaN(n) || n < least ? null : n;
}

/**
 * Whether a pass takes a script, before its placement and its depth: the one rule applyPass and every other reader use.
 * @param {{ edited?: boolean }} [opts] edited: the message was edited by hand, so text scripts need run on edit
 */
export function takesPass(s, pass, { edited = false } = {}) {
    if (!s || s.disabled) return false;
    switch (pass) {
        case 'screen':
        case 'prompt': return textOnly(s) ? !s.alterSaved && (!edited || !!s.runOnEdit) : joins(s, pass);
        case 'lore': return joins(s, 'lore');
        case 'save': return textOnly(s) && !!s.alterSaved;
        case 'edit': return textOnly(s) && !!s.alterSaved && !!s.runOnEdit;
        case 'draft': return textOnly(s);
        // the text as its text scripts write it, what SillyTavern stored: the message editor opens on it
        case 'written': return textOnly(s) && !s.alterSaved && (!edited || !!s.runOnEdit);
        default: return false;
    }
}

/** The deepest depth bound any display script sets, or null: past it every row takes the same scripts. */
export function depthBand(scripts) {
    let band = null;
    for (const s of scripts || []) {
        if (!s?.markdownOnly) continue;
        for (const d of [bound(s.minDepth, -1), bound(s.maxDepth, 0)]) if (d !== null) band = Math.max(band ?? d, d);
    }
    return band;
}

/** Where a message stands on screen: your input, a narrator's line (SillyTavern's extra.type) or the AI's output. */
export function screenPlace(msg) {
    if (msg?.is_user) return PLACE.userInput;
    return msg?.extra?.type === 'narrator' ? PLACE.narrator : PLACE.aiOutput;
}

/** A SillyTavern system line (a slash command's answer): shown and stored with no script, though an edit still runs its scripts. */
export function systemLine(msg) {
    return !!msg?.is_system && msg.name === 'SillyTavern System';
}

/** Whether the prompt passes a message over, so no depth counts it: a system line, or one the reader hid. */
export function hiddenFromPrompt(msg) {
    return !!(msg?.is_system || msg?.extra?.hidden);
}

/** Macros from a chat's two names alone, for a pass with no chat behind it (the page's): any other macro stays as written. */
export function namesMacros(names = {}) {
    return (text, { escape, charName } = {}) => String(text).replace(/\{\{(user|char)\}\}|<(USER|BOT|CHAR)>/gi, (m, a, b) => {
        const v = (a || b).toLowerCase() === 'user' ? names.user : (charName || names.char);
        return escape ? escape(v ?? '') : (v ?? '');
    });
}

function inDepth(script, depth) {
    if (typeof depth !== 'number') return true;
    const floor = bound(script.minDepth, -1);
    if (floor !== null && depth < floor) return false;
    const ceiling = bound(script.maxDepth, 0);
    return !(ceiling !== null && depth > ceiling);
}

// ---------------------------------------------------------------- the find

// the letters a /pattern/flags may end on, each at most once; any other ending makes the whole text the pattern
const FLAG_LETTERS = new Set('gmixXsuUAJ');
const flagsAccepted = (flags) => [...flags].every((c, i) => FLAG_LETTERS.has(c) && flags.indexOf(c) === i);

/** A find's pattern and flags, read from its first non-empty line: `/pattern/flags`, else the line itself. */
export function readFind(source) {
    const text = String(source);
    const line = text.split(/[\n\r\u2028\u2029]/).find(l => l.length) ?? '';
    if (line.startsWith('/')) {
        const close = line.lastIndexOf('/');
        if (close >= 2) {
            const flags = /^[a-z]*/i.exec(line.slice(close + 1))[0];
            if (flags && !flagsAccepted(flags)) return { pattern: text, flags: '' };
            return { pattern: line.slice(1, close), flags };
        }
    }
    return { pattern: line, flags: '' };
}

const compiled = new Map();
const COMPILED_MAX = 1000;

/** The script's find as a RegExp, or null when it does not compile; compiled once and reused. */
export function compileFind(source) {
    const key = String(source);
    if (compiled.has(key)) {
        const re = compiled.get(key);
        compiled.delete(key);
        compiled.set(key, re);
        if (re) re.lastIndex = 0;
        return re;
    }
    let re = null;
    try {
        const { pattern, flags } = readFind(key);
        re = new RegExp(pattern, flags);
    } catch {
        re = null;
    }
    if (compiled.size >= COMPILED_MAX) compiled.delete(compiled.keys().next().value);
    compiled.set(key, re);
    return re;
}

// a macro value made literal inside a pattern: control characters spelled out, pattern punctuation escaped
const SPELLED = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v', '\f': '\\f', '\0': '\\0' };
/** One macro's value escaped for a pattern, as a find whose macros are "escaped" takes it. */
export function escapeForPattern(value) {
    if (typeof value !== 'string' || !value) return value;
    let out = '';
    for (const c of value) out += SPELLED[c] ?? ('.^$*+?{}[]\\/|()'.includes(c) ? `\\${c}` : c);
    return out;
}

function findSource(script, macros) {
    const mode = Number(script.substituteRegex);
    if (mode === 1) return macros(script.findRegex);
    if (mode === 2) return macros(script.findRegex, { escape: escapeForPattern });
    return script.findRegex;
}

// ---------------------------------------------------------------- the replace

function cutTrims(value, trims, macros, charName) {
    let out = value;
    for (const trim of Array.isArray(trims) ? trims : []) out = out.split(macros(String(trim), { charName })).join('');
    return out;
}

/**
 * One script over a text: each match becomes the replacement, its groups filled and trimmed, then macros expanded.
 * @param {object} script the script, in SillyTavern's shape
 * @param {string} text
 * @param {{ macros?: (text: string, opts?: { escape?: Function, charName?: string }) => string, charName?: string }} [ctx]
 */
export function runScript(script, text, { macros = (t) => t, charName } = {}) {
    if (!text || !script || script.disabled || !script.findRegex) return text;
    const re = compileFind(findSource(script, macros));
    if (!re) return text;
    const template = String(script.replaceString ?? '').replace(/\{\{match\}\}/gi, '$0');
    return text.replace(re, (...hit) => {
        const named = hit[hit.length - 1] !== null && typeof hit[hit.length - 1] === 'object' ? hit[hit.length - 1] : null;
        const captures = hit.length - (named ? 3 : 2);
        const filled = template.replace(/\$(\d+)|\$<([^>]+)>/g, (_tok, index, name) => {
            const value = index !== undefined
                ? (Number(index) < captures ? hit[Number(index)] : undefined)
                : named?.[name];
            return value ? cutTrims(value, script.trimStrings, macros, charName) : '';
        });
        return macros(filled);
    });
}

/** How many places a script's find matches in a text (every match, g flag or not), or -1 when it does not compile. */
export function countMatches(script, text, { macros = (t) => t } = {}) {
    if (!script?.findRegex) return 0;
    const re = compileFind(findSource(script, macros));
    if (!re) return -1;
    if (!text) return 0;
    return [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))].length;
}

// ---------------------------------------------------------------- a pass over a text

/**
 * A text through one pass: each script the pass takes whose placements name `where`, over the last one's result.
 * @param {string} text
 * @param {object[]} scripts in order, each in SillyTavern's shape (`alterSaved` is Σ's: a text script that changes what is saved)
 * @param {{ pass: string, where: number, textWhere?: number, depth?: number, macros?: Function, charName?: string, onScript?: Function, edited?: boolean }} ctx textWhere: where a read pass's text scripts act when not where (a narrator's line in the prompt)
 */
export function applyPass(text, scripts, { pass, where, textWhere = where, depth, macros, charName, onScript, edited = false } = {}) {
    if (typeof text !== 'string' || !text || !Array.isArray(scripts) || !scripts.length) return typeof text === 'string' ? text : '';
    const named = (s, at) => Array.isArray(s?.placement) && s.placement.includes(at);
    let out = text;
    // the sender's name stands for the character in trim strings only on screen's display scripts and on an edit
    const each = (s, withDepth, sender, at = where) => {
        if (!named(s, at) || (withDepth && !inDepth(s, depth))) return;
        if (onScript) onScript(s);
        out = runScript(s, out, { macros, charName: sender ? charName : undefined });
    };
    const takes = (s) => takesPass(s, pass, { edited });
    switch (pass) {
        case 'screen':
        case 'prompt':
            // text scripts first, with no depth window, then the pass's own; a hand-edited message keeps its words from text scripts not run on edit
            for (const s of scripts) if (textOnly(s) && takes(s)) each(s, false, false, textWhere);
            for (const s of scripts) if (!textOnly(s) && takes(s)) each(s, true, pass === 'screen');
            return out;
        case 'lore':
            for (const s of scripts) if (takes(s)) each(s, true, false);
            return out;
        case 'save':
        case 'draft':
        case 'written':
            for (const s of scripts) if (takes(s)) each(s, false, false);
            return out;
        case 'edit':
            for (const s of scripts) if (takes(s)) each(s, false, true);
            return out;
        default:
            return out;
    }
}
