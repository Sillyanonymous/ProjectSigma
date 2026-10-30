// SPDX-License-Identifier: 0BSD

// A small DOM for tests with no browser: markup parsed, the common selectors answered, events bubbling,
// form state kept as a browser keeps it.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['textarea', 'script', 'style']);
// the input types whose value the browser keeps to one line
const ONE_LINE = new Set(['text', 'search', 'tel', 'password', 'url', 'email']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·' };

const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? all;
});
const encode = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const encodeAttr = (s) => encode(s).replace(/"/g, '&quot;');
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

// an element's inline style: properties kept as written (no cascade), custom properties among them
function styleDeclaration() {
    const style = {};
    const keyOf = (name) => (String(name).startsWith('--') ? String(name) : camel(String(name)));
    Object.defineProperties(style, {
        setProperty: { value: (name, value) => { if (value == null || value === '') delete style[keyOf(name)]; else style[keyOf(name)] = String(value); } },
        getPropertyValue: { value: (name) => style[keyOf(name)] ?? '' },
        removeProperty: { value: (name) => { const was = style[keyOf(name)] ?? ''; delete style[keyOf(name)]; return was; } },
    });
    return style;
}

function textNode(text) {
    return { nodeType: 3, parent: null, text, get textContent() { return this.text; } };
}

export function createElement(tag) {
    const attrs = new Map();
    const listeners = new Map();
    const state = {};
    const el = {
        nodeType: 1,
        tagName: String(tag).toUpperCase(),
        parent: null,
        childNodes: [],
        style: styleDeclaration(),
        attrs,
        get children() { return el.childNodes.filter(n => n.nodeType === 1); },
        get parentElement() { return el.parent; },
        getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
        setAttribute: (n, v) => { attrs.set(n, String(v)); },
        removeAttribute: (n) => { attrs.delete(n); },
        toggleAttribute: (n, force) => { const on = force === undefined ? !attrs.has(n) : !!force; if (on) { if (!attrs.has(n)) attrs.set(n, ''); } else attrs.delete(n); return on; },
        hasAttribute: (n) => attrs.has(n),
        get id() { return attrs.get('id') || ''; },
        set id(v) { attrs.set('id', String(v)); },
        get className() { return attrs.get('class') || ''; },
        set className(v) { attrs.set('class', String(v)); },
        classList: {
            _list: () => (attrs.get('class') || '').split(/\s+/).filter(Boolean),
            _set(list) { attrs.set('class', [...new Set(list)].join(' ')); },
            contains(c) { return this._list().includes(c); },
            add(...cs) { this._set([...this._list(), ...cs]); },
            remove(...cs) { this._set(this._list().filter(x => !cs.includes(x))); },
            toggle(c, force) {
                const on = force === undefined ? !this.contains(c) : !!force;
                if (on) this.add(c); else this.remove(c);
                return on;
            },
        },
        dataset: null,
        // form state: the markup seeds it, a script's write wins
        get value() {
            if (el.tagName === 'INPUT' && ONE_LINE.has((attrs.get('type') || 'text').toLowerCase())) return String('value' in state ? state.value : attrs.get('value') ?? '').replace(/[\r\n]/g, '');
            if ('value' in state) return state.value;
            if (el.tagName === 'TEXTAREA') return el.textContent;
            if (el.tagName === 'SELECT') {
                const opts = el.options;
                const picked = opts.find(o => o.hasAttribute('selected')) || opts[0];
                return picked ? picked.value : '';
            }
            if (el.tagName === 'OPTION') return attrs.has('value') ? attrs.get('value') : el.textContent;
            return attrs.get('value') ?? '';
        },
        set value(v) { state.value = String(v); },
        get checked() { return 'checked' in state ? state.checked : attrs.has('checked'); },
        set checked(v) { state.checked = !!v; },
        get disabled() { return 'disabled' in state ? state.disabled : attrs.has('disabled'); },
        set disabled(v) { state.disabled = !!v; },
        get hidden() { return attrs.has('hidden'); },
        set hidden(v) { if (v) attrs.set('hidden', ''); else attrs.delete('hidden'); },
        get placeholder() { return attrs.get('placeholder') || ''; },
        set placeholder(v) { attrs.set('placeholder', String(v)); },
        get title() { return attrs.get('title') || ''; },
        set title(v) { attrs.set('title', String(v)); },
        get type() { return attrs.get('type') || ''; },
        set type(v) { attrs.set('type', String(v)); },
        get options() { return el.tagName === 'SELECT' ? el.querySelectorAll('option') : []; },
        get textContent() { return el.childNodes.map(n => n.textContent).join(''); },
        set textContent(v) { el.childNodes.forEach(n => { n.parent = null; }); el.childNodes = []; if (v !== '' && v != null) append(el, textNode(String(v))); },
        get innerHTML() { return el.childNodes.map(serialize).join(''); },
        set innerHTML(html) { el.childNodes.forEach(n => { n.parent = null; }); el.childNodes = []; parseInto(el, String(html)); },
        insertAdjacentHTML(where, html) {
            if (where === 'beforeend') { parseInto(el, String(html)); return; }
            const frag = createDocumentFragment();
            parseInto(frag, String(html));
            if (where === 'afterbegin') { place(el, frag, el.childNodes[0] || null); return; }
            if (where !== 'beforebegin' && where !== 'afterend') throw new Error(`mini-dom: insertAdjacentHTML ${where} is not a position`);
            const p = el.parent;
            if (!p) throw new Error(`mini-dom: insertAdjacentHTML ${where} on an element with no parent`);
            place(p, frag, where === 'beforebegin' ? el : (p.childNodes[p.childNodes.indexOf(el) + 1] || null));
        },
        appendChild: (c) => { place(el, c, null); return c; },
        append: (...nodes) => { for (const n of nodes) place(el, n, null); },
        insertBefore: (n, ref) => { place(el, n, ref || null); return n; },
        after: (...nodes) => {
            const p = el.parent;
            if (!p) return;
            const ref = p.childNodes[p.childNodes.indexOf(el) + 1] || null;
            for (const n of nodes) place(p, n, ref);
        },
        remove: () => { if (el.parent) { el.parent.childNodes = el.parent.childNodes.filter(n => n !== el); el.parent = null; } },
        // no layout is modelled: every box is empty, at the origin
        getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
        matches: (sel) => matchesList(el, sel),
        closest(sel) { for (let n = el; n; n = n.parent) if (matchesList(n, sel)) return n; return null; },
        // the node itself or a descendant, as the DOM answers it (null is no node)
        contains(node) { for (let n = node; n; n = n.parent) if (n === el) return true; return false; },
        querySelectorAll(sel) {
            const out = [];
            const walk = (n) => { for (const c of n.children) { if (matchesList(c, sel)) out.push(c); walk(c); } };
            walk(el);
            return out;
        },
        querySelector: (sel) => el.querySelectorAll(sel)[0] || null,
        addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
        removeEventListener(type, fn) { const l = listeners.get(type); if (l) listeners.set(type, l.filter(f => f !== fn)); },
        dispatchEvent(ev) {
            const event = ev;
            // a real Event's target is a getter on its prototype, so it is defined as an own property
            if (!event.target) Object.defineProperty(event, 'target', { value: el, configurable: true, enumerable: true, writable: true });
            // the path is fixed at dispatch as the DOM fixes it, so a node a listener detaches stays on it
            const path = [];
            for (let n = el; n; n = n.parent) path.push(n);
            Object.defineProperty(event, 'composedPath', { value: () => path.slice(), configurable: true, writable: true });
            // preventDefault and stopPropagation for any event; a real Event's own stop is heard through a flag
            let stopped = false;
            if (typeof event.preventDefault !== 'function') event.preventDefault = function () { this.defaultPrevented = true; };
            const stop = typeof event.stopPropagation === 'function' ? event.stopPropagation.bind(event) : null;
            Object.defineProperty(event, 'stopPropagation', { value: () => { stopped = true; if (stop) stop(); }, configurable: true, writable: true });
            for (let n = el; n; n = n.parent) {
                for (const fn of [...(n._listeners.get(event.type) || [])]) fn.call(n, event);
                if (stopped || event.bubbles === false) break;
            }
            return true;
        },
        click() {
            if (el.disabled) return;
            el.dispatchEvent({ type: 'click', bubbles: true });
        },
        // no layout: a scroll into view is recorded with its options, a focus as the element that took it
        scrollIntoView(opts) { el.scrolledInto = opts ?? true; },
        focus() { el.focused = true; },
        _listeners: listeners,
    };
    el.dataset = new Proxy({}, {
        get: (_, k) => (typeof k === 'string' ? attrs.get(`data-${kebab(k)}`) : undefined),
        set: (_, k, v) => { attrs.set(`data-${kebab(String(k))}`, String(v)); return true; },
        has: (_, k) => attrs.has(`data-${kebab(String(k))}`),
        ownKeys: () => [...attrs.keys()].filter(a => a.startsWith('data-')).map(a => camel(a.slice(5))),
        getOwnPropertyDescriptor: (_, k) => ({ enumerable: true, configurable: true, value: attrs.get(`data-${kebab(String(k))}`) }),
    });
    return el;
}

function append(parent, child) {
    if (child.parent) child.parent.childNodes = child.parent.childNodes.filter(n => n !== child);
    child.parent = parent;
    parent.childNodes.push(child);
    return child;
}

// a node placed in a parent before a reference node (null: at the end): a fragment places its
// children in order, a string is text
function place(parent, node, ref) {
    if (typeof node === 'string') node = textNode(node);
    if (node.nodeType === 11) {
        for (const c of [...node.childNodes]) place(parent, c, ref);
        return;
    }
    if (node.parent) node.parent.childNodes = node.parent.childNodes.filter(n => n !== node);
    node.parent = parent;
    const at = ref ? parent.childNodes.indexOf(ref) : -1;
    if (at === -1) parent.childNodes.push(node);
    else parent.childNodes.splice(at, 0, node);
}

/** A text node, as document.createTextNode makes one. */
export function createTextNode(text) {
    return textNode(String(text));
}

/** A fragment, as document.createDocumentFragment makes one: placing it places its children. */
export function createDocumentFragment() {
    const frag = createElement('#document-fragment');
    frag.nodeType = 11;
    return frag;
}

function serialize(n) {
    if (n.nodeType === 3) return encode(n.text);
    const tag = n.tagName.toLowerCase();
    const attrs = [...n.attrs].map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${encodeAttr(v)}"`)).join('');
    if (VOID.has(tag)) return `<${tag}${attrs}>`;
    return `<${tag}${attrs}>${n.childNodes.map(serialize).join('')}</${tag}>`;
}

const TOKEN = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+|<)/g;
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseInto(root, html) {
    const stack = [root];
    const top = () => stack[stack.length - 1];
    TOKEN.lastIndex = 0;
    let m;
    while ((m = TOKEN.exec(html))) {
        if (m[0].startsWith('<!--')) continue;
        if (m[1]) {
            const name = m[1].toUpperCase();
            const at = stack.map(n => n.tagName).lastIndexOf(name);
            if (at > 0) stack.length = at;
            continue;
        }
        if (m[2]) {
            const el = createElement(m[2]);
            for (const a of (m[3] || '').matchAll(ATTR)) el.attrs.set(a[1].toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ''));
            append(top(), el);
            const tag = m[2].toLowerCase();
            if (RAW.has(tag)) {
                const close = html.toLowerCase().indexOf(`</${tag}`, TOKEN.lastIndex);
                const end = close === -1 ? html.length : close;
                const raw = html.slice(TOKEN.lastIndex, end);
                if (raw) append(el, textNode(tag === 'textarea' ? decode(raw.replace(/^\n/, '')) : raw));
                TOKEN.lastIndex = close === -1 ? html.length : html.indexOf('>', close) + 1;
                continue;
            }
            if (!VOID.has(tag) && !m[4]) stack.push(el);
            continue;
        }
        if (m[5]) append(top(), textNode(decode(m[5])));
    }
}

// ---- selectors ----
function splitTop(sel, sep) {
    const out = [];
    let depth = 0, quote = null, cur = '';
    for (const ch of sel) {
        if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
        if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
        if (ch === '(' || ch === '[') depth++;
        if (ch === ')' || ch === ']') depth--;
        if (depth === 0 && sep(ch)) { out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    out.push(cur);
    return out;
}

// a quoted attribute value's escapes resolved as CSS reads them: a hex code point (one optional space after), else the character
const cssUnescape = (v) => v.replace(/\\([0-9a-fA-F]{1,6})[ \t\n]?|\\([\s\S])/g, (m, hex, ch) => {
    if (ch !== undefined) return ch;
    const cp = parseInt(hex, 16);
    return cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF) ? '\uFFFD' : String.fromCodePoint(cp);
});

/** CSS.escape's serialisation of an identifier (CSSOM), for a page that builds selectors from ids. */
export function cssEscape(value) {
    const s = String(value);
    const first = s.charCodeAt(0);
    if (s.length === 1 && first === 0x2D) return '\\' + s;
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 0) { out += '\uFFFD'; continue; }
        if ((c >= 0x01 && c <= 0x1F) || c === 0x7F || (i === 0 && c >= 0x30 && c <= 0x39) || (i === 1 && c >= 0x30 && c <= 0x39 && first === 0x2D)) { out += '\\' + c.toString(16) + ' '; continue; }
        if (c >= 0x80 || c === 0x2D || c === 0x5F || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)) { out += s.charAt(i); continue; }
        out += '\\' + s.charAt(i);
    }
    return out;
}

function parseCompound(s) {
    const c = { tag: null, id: null, classes: [], attrs: [], nots: [], checked: false };
    const re = /^(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:(\^|\$|\*)?="((?:[^"\\]|\\[\s\S])*)")?\]|:not\(((?:[^()]|\([^()]*\))*)\)|(:checked)/y;
    let i = 0;
    while (i < s.length) {
        re.lastIndex = i;
        const m = re.exec(s);
        if (!m || !m[0]) throw new Error(`mini-dom: selector "${s}" is not modelled`);
        if (m[1]) c.tag = m[1] === '*' ? null : m[1].toUpperCase();
        else if (m[2]) c.id = m[2];
        else if (m[3]) c.classes.push(m[3]);
        else if (m[4]) c.attrs.push({ name: m[4].toLowerCase(), op: m[5] || (m[6] !== undefined ? '=' : null), value: m[6] === undefined ? undefined : cssUnescape(m[6]) });
        else if (m[7] !== undefined) c.nots.push(parseCompound(m[7].trim()));
        else if (m[8]) c.checked = true;
        i = re.lastIndex;
    }
    return c;
}

function matchesCompound(el, c) {
    if (!el || el.nodeType !== 1) return false;
    if (c.tag && el.tagName !== c.tag) return false;
    if (c.id && el.id !== c.id) return false;
    for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
    for (const a of c.attrs) {
        if (!el.attrs.has(a.name)) return false;
        const v = el.attrs.get(a.name);
        if (a.op === '=' && v !== a.value) return false;
        if (a.op === '^' && !v.startsWith(a.value)) return false;
        if (a.op === '$' && !v.endsWith(a.value)) return false;
        if (a.op === '*' && !v.includes(a.value)) return false;
    }
    for (const n of c.nots) if (matchesCompound(el, n)) return false;
    if (c.checked && el.checked !== true) return false;
    return true;
}

// a complex selector as compounds and combinators, matched from its last compound leftwards
function matchesComplex(el, sel) {
    const parts = [];
    for (const piece of splitTop(sel.trim().replace(/\s*>\s*/g, ' > '), (ch) => ch === ' ').filter(Boolean)) parts.push(piece);
    const steps = [];
    for (let i = 0; i < parts.length; i++) {
        if (parts[i] === '>') continue;
        steps.push({ compound: parseCompound(parts[i]), child: parts[i - 1] === '>' });
    }
    const walk = (node, k) => {
        if (!matchesCompound(node, steps[k].compound)) return false;
        if (k === 0) return true;
        if (steps[k].child) return walk(node.parent, k - 1);
        for (let a = node.parent; a; a = a.parent) if (walk(a, k - 1)) return true;
        return false;
    };
    return walk(el, steps.length - 1);
}

function matchesList(el, sel) {
    return splitTop(sel, (ch) => ch === ',').some(s => s.trim() && matchesComplex(el, s));
}

/** An element to render into, standing where a host would hand one over. */
export function mountPoint(tag = 'div') {
    return createElement(tag);
}
