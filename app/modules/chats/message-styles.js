// A message's own CSS, parsed by the browser, scoped to the message and adopted as its own sheet, never back into the HTML.

// ========================================
// THE SCOPE
// ========================================

const SHEET_CAP = 200;
const sheets = new Map();
const ID_PREFIX = 'user-content-';
// the app's own controls are found by data-* (data-act, data-set): a message's own are renamed out of their way
const DATA_PREFIX = 'data-user-';
// a request off the app's server would carry whatever a selector tested to someone else: only data: and same-origin paths
const FETCHER_RE = /(?:url|image-set|image|src)\(/i;
function fetchesOff(prop, value) {
    const bare = value.replace(/data:[^"')\s,]*/gi, '');
    const off = /\/\/|[a-z][a-z0-9+.-]*:/i.test(bare);
    if (prop.startsWith('--')) return off;
    return FETCHER_RE.test(value) && (off || /var\(/i.test(value));
}

// 53-bit string hash: the scope names the CSS it holds, so replies carrying the same styles share one sheet
function hashOf(text) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The <style> blocks of formatted message HTML, taken out: { html, css }. An unclosed one (a reply still arriving) runs to the end. */
export function takeStyles(html) {
    if (typeof html !== 'string' || !/<style\b/i.test(html)) return { html, css: '' };
    const css = [];
    const rest = html.replace(/<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi, (_m, body) => { css.push(body); return ''; });
    return { html: rest, css: css.join('\n') };
}

// each character of a selector outside parentheses, brackets and strings, with its index
function eachTopLevel(text, fn) {
    let depth = 0, quote = '';
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
        if (c === '"' || c === "'") quote = c;
        else if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') depth--;
        else if (depth === 0) fn(c, i);
    }
}

// top-level commas only: a comma inside :is(), an attribute or a string stays in its selector
export function splitSelectors(text) {
    const out = [];
    let start = 0;
    eachTopLevel(text, (c, i) => { if (c === ',') { out.push(text.slice(start, i)); start = i + 1; } });
    out.push(text.slice(start));
    return out.map(s => s.trim()).filter(Boolean);
}

// #id tokens outside attribute brackets and strings take the sanitizer's id prefix, as the ids themselves do
function prefixIds(selector) {
    let out = '', depth = 0, quote = '';
    for (let i = 0; i < selector.length; i++) {
        const c = selector[i];
        if (quote) { out += c; if (c === '\\') { out += selector[++i] ?? ''; } else if (c === quote) quote = ''; continue; }
        if (c === '"' || c === "'") quote = c;
        else if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '#' && depth === 0 && /[-_a-zA-Z\\]/.test(selector[i + 1] || '') && !selector.startsWith(ID_PREFIX, i + 1)) { out += '#' + ID_PREFIX; continue; }
        if (c === '[') {
            const ws = selector.slice(i + 1).match(/^\s*/)[0];
            if (/^data-/i.test(selector.slice(i + 1 + ws.length)) && !selector.slice(i + 1 + ws.length).toLowerCase().startsWith(DATA_PREFIX)) { out += '[' + ws + 'data-user-'; i += ws.length + 5; continue; }
        }
        out += c;
    }
    return out;
}

// where a selector's subject (its last compound) begins, and where a pseudo-element in it begins
function subjectOf(sel) {
    let start = 0;
    eachTopLevel(sel, (c, i) => { if (c === ' ' || c === '>' || c === '+' || c === '~') start = i + 1; });
    const subject = sel.slice(start);
    const pseudo = subject.search(/::|:(?:before|after|first-line|first-letter)(?![-\w])/i);
    return { start, pseudoAt: pseudo === -1 ? subject.length : pseudo };
}

/** One selector kept to the scope: its subject matches only inside the message; :root, html or body as the subject is the scope. */
export function scopeSelector(selector, scope) {
    const sel = prefixIds(selector.trim());
    if (!sel || /[>+~]\s*$/.test(sel)) return null;
    const { start, pseudoAt } = subjectOf(sel);
    const subject = sel.slice(start, start + pseudoAt), pseudo = sel.slice(start + pseudoAt), head = sel.slice(0, start);
    const rooted = subject.replace(/^(?::root|html|body)(?![-\w])/i, '');
    if (rooted !== subject) return `${head}${scope}${rooted}${pseudo}`;
    return `${head}${subject || '*'}:is(${scope}, ${scope} *)${pseudo}`;
}

// the rules a message's CSS may hold; any other kind is global or reaches outside (@font-face, @property, @scope, @import, @layer names, @page)
const KEPT = new Set(['CSSStyleRule', 'CSSMediaRule', 'CSSSupportsRule', 'CSSContainerRule', 'CSSKeyframesRule', 'CSSLayerBlockRule', 'CSSStartingStyleRule', 'CSSKeyframeRule', 'CSSNestedDeclarations']);
const kindOf = (rule) => rule?.constructor?.name || '';

function collectKeyframes(rules, scope, names) {
    for (const rule of [...rules]) {
        if (kindOf(rule) === 'CSSKeyframesRule') { const next = `${scope.slice(1)}-${rule.name}`; names.set(rule.name, next); rule.name = next; }
        else if (rule.cssRules) collectKeyframes(rule.cssRules, scope, names);
    }
}

function rewriteValues(style, names) {
    if (!style) return;
    for (const prop of [...style]) {
        const value = style.getPropertyValue(prop);
        if (fetchesOff(prop, value)) style.removeProperty(prop);
        else if (/attr\(\s*data-(?!user-)/i.test(value)) style.setProperty(prop, value.replace(/attr\(\s*data-(?!user-)/gi, 'attr(data-user-'), style.getPropertyPriority(prop));
    }
    if (/^fixed$/i.test(style.getPropertyValue('position').trim())) style.setProperty('position', 'absolute', style.getPropertyPriority('position'));
    if (names.size && style.animationName) {
        const mapped = style.animationName.split(',').map(n => names.get(n.trim()) || n.trim()).join(', ');
        if (mapped !== style.animationName) style.animationName = mapped;
    }
    for (let i = 0; i < style.length; i++) {
        const prop = style[i];
        const value = style.getPropertyValue(prop);
        if (/url\(\s*["']?#/i.test(value)) style.setProperty(prop, value.replace(/url\(\s*(["']?)#(?!user-content-)/gi, `url($1#${ID_PREFIX}`), style.getPropertyPriority(prop));
    }
}

// in place: every rule a message may hold is scoped, every other is deleted, so nothing unscoped is left to adopt
function scopeRules(list, scope, names, nested = false) {
    for (let i = list.cssRules.length - 1; i >= 0; i--) {
        const rule = list.cssRules[i];
        const kind = kindOf(rule);
        if (!KEPT.has(kind)) { list.deleteRule(i); continue; }
        if (kind === 'CSSStyleRule') {
            if (!nested) {
                const wanted = splitSelectors(rule.selectorText).map(s => scopeSelector(s, scope));
                if (wanted.some(w => !w)) { list.deleteRule(i); continue; }
                rule.selectorText = wanted.join(', ');
                // a selector the parser refused to take back stays unscoped: the rule goes
                if (!splitSelectors(rule.selectorText).every(s => s.includes(scope))) { list.deleteRule(i); continue; }
            }
            rewriteValues(rule.style, names);
            if (rule.cssRules?.length) scopeRules(rule, scope, names, true);
        } else if (kind === 'CSSKeyframesRule') {
            for (const frame of [...rule.cssRules]) rewriteValues(frame.style, names);
        } else if (kind === 'CSSNestedDeclarations') {
            rewriteValues(rule.style, names);
        } else if (rule.cssRules) {
            scopeRules(rule, scope, names, nested);
        }
    }
}

/** A message's CSS as a sheet kept to `scope` (a class selector), or null when nothing in it survives. */
export function scopedSheet(css, scope) {
    const sheet = new CSSStyleSheet();
    try { sheet.replaceSync(css); } catch { return null; }
    const names = new Map();
    collectKeyframes(sheet.cssRules, scope, names);
    scopeRules(sheet, scope, names);
    return sheet.cssRules.length ? sheet : null;
}

function adopt(key, sheet) {
    sheets.set(key, sheet);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    while (sheets.size > SHEET_CAP) {
        const [oldKey, old] = sheets.entries().next().value;
        sheets.delete(oldKey);
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== old);
    }
}

// ========================================
// THE MESSAGE
// ========================================

// references to an id the sanitizer prefixed (a gradient's url(#), a <use>, an aria link) follow it; a <use> reaching outside goes
const REF_ATTRS = ['fill', 'stroke', 'clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end'];
const ID_LIST_ATTRS = ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant'];
function shapeBody(html, scopeClass) {
    if (!scopeClass && !/\sid="user-content-|<use\b|\sdata-(?!user-)/i.test(html)) return html;
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    if (scopeClass) for (const el of tpl.content.children) el.classList.add(scopeClass);
    for (const el of tpl.content.querySelectorAll('*')) {
        for (const a of [...el.attributes]) {
            if (!/^data-/i.test(a.name) || a.name.toLowerCase().startsWith(DATA_PREFIX)) continue;
            el.removeAttribute(a.name);
            el.setAttribute(DATA_PREFIX + a.name.slice(5), a.value);
        }
    }
    const ids = new Set([...tpl.content.querySelectorAll('[id]')].map(el => el.id));
    const own = (id) => ids.has(ID_PREFIX + id);
    for (const el of tpl.content.querySelectorAll('*')) {
        for (const attr of REF_ATTRS) {
            const v = el.getAttribute(attr);
            if (v && /url\(\s*["']?#/i.test(v)) el.setAttribute(attr, v.replace(/url\(\s*(["']?)#([^)"']+)/gi, (m, q, id) => (own(id) ? `url(${q}#${ID_PREFIX}${id}` : m)));
        }
        for (const attr of ID_LIST_ATTRS) {
            const v = el.getAttribute(attr);
            if (v) el.setAttribute(attr, v.split(/\s+/).map(id => (own(id) ? ID_PREFIX + id : id)).join(' '));
        }
        const st = el.getAttribute('style');
        if (st && /url\(\s*["']?#/i.test(st)) el.setAttribute('style', st.replace(/url\(\s*(["']?)#([^)"']+)/gi, (m, q, id) => (own(id) ? `url(${q}#${ID_PREFIX}${id}` : m)));
        if (el.localName === 'use') {
            for (const attr of ['href', 'xlink:href']) {
                const v = el.getAttribute(attr);
                if (v == null) continue;
                if (v.startsWith('#') && own(v.slice(1))) el.setAttribute(attr, `#${ID_PREFIX}${v.slice(1)}`);
                else if (!v.startsWith(`#${ID_PREFIX}`)) el.removeAttribute(attr);
            }
        }
    }
    return tpl.innerHTML;
}

/**
 * A purified message body with its CSS kept to it; a reply still arriving stays unstyled until stored.
 * @param {string} purified the body, through the chat's sanitizer
 * @param {string} css what takeStyles took out of it
 * @param {{ live?: boolean }} [opts]
 */
export function scopeMessageHtml(purified, css, { live = false } = {}) {
    if (typeof document === 'undefined') return purified;
    if (!css || live || typeof CSSStyleSheet === 'undefined' || !('adoptedStyleSheets' in document)) return shapeBody(purified, null);
    const key = hashOf(css);
    const scopeClass = `cl-msg-scope-${key}`;
    if (!sheets.has(key)) {
        const sheet = scopedSheet(css, `.${scopeClass}`);
        if (!sheet) return shapeBody(purified, null);
        adopt(key, sheet);
    }
    return shapeBody(purified, scopeClass);
}
