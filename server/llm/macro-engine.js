// The macro language (scanner, parser, evaluator), SillyTavern's grammar written from its behaviour. the vocabulary is macros.js's

// ================================================================ tokens

const PT = 'PT'; // plain text
const POB = 'POB'; // a lone { before {{
const S = 'S'; // {{
const E = 'E'; // }}
const DS = 'DS'; // // (the comment macro's name)
const LP = 'LP'; // . before a local variable
const GP = 'GP'; // $ before a global variable
const FLAG = 'FLAG'; // ! ? ~ # /
const FF = 'FF'; // > (the filter flag)
const MID = 'MID'; // a macro's name
const ID = 'ID'; // a word inside arguments or a variable's value
const EP = 'EP'; // \|
const PIPE = 'PIPE';
const FID = 'FID'; // the name after a pipe
const DC = 'DC'; // ::
const C = 'C'; // :
const EQ = 'EQ'; // =
const Q = 'Q'; // "
const U = 'U'; // any other single character
const VID = 'VID'; // a variable's name
const OP = 'OP'; // a variable operator
const EOF = 'EOF';

const IDENT_RE = /[a-zA-Z][\w-]*/y;
const VAR_IDENT_RE = /[a-zA-Z](?:[\w-]*\w)?/y;
const WS_RE = /\s+/y;
// in the order the scanner tries them: the longer of two that share a first character comes first
const VAR_OPS = ['++', '--', '??=', '??', '||=', '||', '-=', '==', '!=', '>=', '>', '<=', '<', '+=', '='];
const VALUE_OPS = new Set(VAR_OPS.slice(2));

/** Scan text into tokens {t, s, e, img} (e inclusive); whitespace inside a macro is not a token. */
export function tokenize(text) {
    const toks = [];
    const modes = ['plain'];
    const n = text.length;
    let p = 0;
    const emit = (t, len) => { toks.push({ t, s: p, e: p + len - 1, img: text.slice(p, p + len) }); p += len; };
    const sticky = (re) => { re.lastIndex = p; const m = re.exec(text); return m ? m[0] : null; };
    const replaceTop = (m) => { modes[modes.length - 1] = m; };
    const endOfIdent = () => {
        const ws = sticky(WS_RE);
        if (ws) { p += ws.length; return true; }
        return text[p] === ':' || text[p] === '|' || text[p] === '}';
    };
    while (p < n) {
        const mode = modes[modes.length - 1];
        const c = text[p];
        const two = text.slice(p, p + 2);
        switch (mode) {
            case 'plain': {
                let q = p;
                while (q < n && !(text[q] === '{' && text[q + 1] === '{')) q++;
                if (q > p) { emit(PT, q - p); break; }
                if (text[p + 2] === '{') { emit(POB, 1); break; }
                emit(S, 2);
                modes.push('def');
                break;
            }
            case 'def': {
                if (two === '}}') { emit(E, 2); modes.pop(); break; }
                if (two === '//') { emit(DS, 2); modes.push('args'); break; }
                if (c === '.') { emit(LP, 1); modes.push('varid'); break; }
                if (c === '$') { emit(GP, 1); modes.push('varid'); break; }
                if ('!?~#/'.includes(c)) { emit(FLAG, 1); break; }
                if (c === '>') { emit(FF, 1); break; }
                const ws = sticky(WS_RE);
                if (ws) { p += ws.length; break; }
                const id = sticky(IDENT_RE);
                if (id) { emit(MID, id.length); modes.push('idend'); break; }
                modes.pop();
                break;
            }
            case 'idend': {
                if (two === '}}') { modes.pop(); break; }
                if (endOfIdent()) { replaceTop('args'); break; }
                p++; // a character no token takes is dropped, and the scan goes on in the same mode
                break;
            }
            case 'args': {
                if (two === '{{') { emit(S, 2); modes.push('def'); break; }
                if (two === '\\|') { emit(EP, 2); break; }
                if (c === '|') { emit(PIPE, 1); modes.push('filter'); break; }
                if (two === '::') { emit(DC, 2); break; }
                if (c === ':') { emit(C, 1); break; }
                if (c === '=') { emit(EQ, 1); break; }
                if (c === '"') { emit(Q, 1); break; }
                const id = sticky(IDENT_RE);
                if (id) { emit(ID, id.length); break; }
                const ws = sticky(WS_RE);
                if (ws) { p += ws.length; break; }
                if (two !== '}}') { emit(U, 1); break; }
                modes.pop();
                break;
            }
            case 'filter': {
                const ws = sticky(WS_RE);
                if (ws) { p += ws.length; break; }
                const id = sticky(IDENT_RE);
                if (id) { emit(FID, id.length); replaceTop('filterend'); break; }
                p++;
                break;
            }
            case 'filterend': {
                if (two === '}}') { modes.pop(); break; }
                if (endOfIdent()) { modes.pop(); break; }
                p++;
                break;
            }
            case 'varid': {
                const ws = sticky(WS_RE);
                if (ws) { p += ws.length; break; }
                const id = sticky(VAR_IDENT_RE);
                if (id) { emit(VID, id.length); replaceTop('varafter'); break; }
                modes.pop();
                break;
            }
            case 'varafter': {
                const ws = sticky(WS_RE);
                if (ws) { p += ws.length; break; }
                const op = VAR_OPS.find(o => text.startsWith(o, p));
                if (op) {
                    emit(OP, op.length);
                    if (VALUE_OPS.has(op)) replaceTop('varval');
                    break;
                }
                modes.pop();
                break;
            }
            case 'varval': {
                if (two === '{{') { emit(S, 2); modes.push('def'); break; }
                const id = sticky(IDENT_RE);
                if (id) { emit(ID, id.length); break; }
                const ws = sticky(WS_RE);
                if (ws) { p += ws.length; break; }
                if (two !== '}}') { emit(U, 1); break; }
                modes.pop();
                break;
            }
            default:
                throw new Error(`macro scanner: no mode ${mode}`);
        }
    }
    return toks;
}

// ================================================================ parser
//
// Recursive descent with SillyTavern's recovery: a rule that fails scans ahead for the first token any
// rule on the stack could continue at; the rule whose own follow set holds it resumes there and the
// ones inside it end as partial nodes. A partial macro is not a macro: its text stays as written, and
// the complete macros inside it still resolve. A failed `}}` whose next token is a `}}` drops the one
// token between, and the macro stands.

const MACRO_START = new Set([FLAG, FF, LP, GP, DS, MID]);
const ARG_TOKENS = new Set([ID, U, C, EQ, Q]);
const DOC_FOLLOW = new Set([PT, POB, S]);
const FOLLOW = {
    doc: new Set([EOF]),
    macroInDoc: DOC_FOLLOW,
    bodyInMacro: new Set([E]),
    varInMacro: new Set([E]),
    none: new Set(),
    argInArgs: new Set([DC]),
    macroInArg: new Set([S, ID, U, C, EQ, Q]),
    macroInColonArg: new Set([S, ID, U, C, EQ, Q, DC]),
    macroInValue: new Set([S, ID, U]),
};
// what may follow a macro's closing braces where it stands, through its caller's continuation
const END_FOLLOW = new Map([
    [FOLLOW.macroInDoc, FOLLOW.macroInDoc],
    [FOLLOW.macroInArg, new Set([...FOLLOW.macroInArg, DC])],
    [FOLLOW.macroInColonArg, FOLLOW.macroInColonArg],
    [FOLLOW.macroInValue, FOLLOW.macroInValue],
]);

class Recognition extends Error {}

const grow = (node, s, e) => {
    if (!Number.isFinite(s)) return;
    if (node.s === null || s < node.s) node.s = s;
    if (node.e === null || e > node.e) node.e = e;
};

/** Parse tokens into a document: { items: [{ tok } | { macro }] } in source order. */
export function parse(toks) {
    let i = 0;
    const follows = [];
    const la = (k = 1) => toks[i + k - 1] || { t: EOF, s: NaN, e: NaN };
    const take = (node) => { const tok = toks[i++]; if (node) grow(node, tok.s, tok.e); return tok; };

    // run a rule on a node its parent already holds, so a partial one is kept as SillyTavern keeps it
    function invoke(follow, node, fn, parent) {
        follows.push(follow);
        try {
            fn(node);
        } catch (err) {
            if (!(err instanceof Recognition)) throw err;
            const all = new Set(follows.flatMap(f => [...f]));
            let k = i;
            while (k < toks.length && !all.has(toks[k].t)) k++;
            const at = k < toks.length ? toks[k].t : EOF;
            node.recovered = true;
            if (!follow.has(at)) {
                if (parent) grow(parent, node.s, node.e);
                throw err;
            }
            while (i < toks.length && toks[i].t !== at) i++;
        } finally {
            follows.pop();
        }
        if (parent) grow(parent, node.s, node.e);
        return node;
    }

    const newNode = (kind) => ({ kind, s: null, e: null, recovered: false });
    const sub = (parent, kind, attach, follow, fn) => {
        const node = newNode(kind);
        if (kind === 'macro') node.endFollow = END_FOLLOW.get(follow);
        attach(node);
        return invoke(follow, node, fn, parent);
    };

    // A token the recovery supplies: it has no place in the text, so a node ending in one ends nowhere.
    const inserted = (t) => ({ t, s: NaN, e: NaN, img: '', inserted: true });

    // a missing `}}` is supplied when the next token could follow here, else one stray token before `}}` is dropped
    function macro(node) {
        node.start = take(node);
        node.flags = [];
        while (la().t === FLAG || la().t === FF) node.flags.push(take(node));
        const t = la().t;
        if (t === LP || t === GP) sub(node, 'var', n => { node.varExpr = n; }, FOLLOW.varInMacro, variableExpr);
        else if (t === DS || t === MID) sub(node, 'body', n => { node.body = n; }, FOLLOW.bodyInMacro, macroBody);
        else throw new Recognition();
        if (la().t === E) { node.end = take(node); return; }
        if (node.endFollow.has(la().t)) { node.end = inserted(E); return; }
        if (la(2).t === E) { i++; node.end = take(node); return; }
        throw new Recognition();
    }

    function macroBody(node) {
        node.name = take(node);
        const t = la().t;
        if (t === DC || t === C || t === S || ARG_TOKENS.has(t)) sub(node, 'args', n => { node.args = n; }, FOLLOW.none, argumentsRule);
    }

    function argumentsRule(node) {
        node.list = [];
        const arg = (follow, fn) => sub(node, 'arg', n => { node.list.push(n); }, follow, fn);
        if (la().t === DC) {
            take(node);
            arg(FOLLOW.argInArgs, argument);
            while (la().t === DC) {
                take(node);
                arg(FOLLOW.argInArgs, argument);
            }
            return;
        }
        if (la().t === C) take(node);
        arg(FOLLOW.none, argumentAllowingColons);
    }

    function argPart(node, follow) {
        if (la().t === S) sub(node, 'macro', n => { node.parts.push(n); }, follow, macro);
        else node.parts.push(take(node));
    }

    function argument(node) {
        node.parts = [];
        while (la().t === S || ARG_TOKENS.has(la().t)) argPart(node, FOLLOW.macroInArg);
    }

    function argumentAllowingColons(node) {
        node.parts = [];
        const more = () => la().t === S || la().t === DC || ARG_TOKENS.has(la().t);
        if (!more()) throw new Recognition();
        while (more()) argPart(node, FOLLOW.macroInColonArg);
    }

    function variableExpr(node) {
        node.scope = take(node);
        if (la().t === VID) node.name = take(node);
        else if (la().t === OP || la().t === E) node.name = inserted(VID);
        else if (la(2).t === VID) { i++; node.name = take(node); }
        else throw new Recognition();
        if (la().t === OP) sub(node, 'op', n => { node.op = n; }, FOLLOW.none, variableOperator);
    }

    function variableOperator(node) {
        node.op = take(node);
        if (VALUE_OPS.has(node.op.img)) sub(node, 'value', n => { node.value = n; }, FOLLOW.none, variableValue);
    }

    function variableValue(node) {
        node.parts = [];
        while (la().t === S || la().t === ID || la().t === U) {
            if (la().t === S) sub(node, 'macro', n => { node.parts.push(n); }, FOLLOW.macroInValue, macro);
            else node.parts.push(take(node));
        }
    }

    const doc = { items: [] };
    follows.push(FOLLOW.doc);
    while (i < toks.length) {
        const t = la().t;
        if (t === PT || t === POB) { doc.items.push({ tok: take(null) }); continue; }
        if (t === S && MACRO_START.has(la(2).t)) {
            try {
                sub(null, 'macro', n => { doc.items.push({ macro: n }); }, FOLLOW.macroInDoc, macro);
            } catch (err) {
                if (!(err instanceof Recognition)) throw err;
                return doc; // only the end of the text was left to continue at
            }
            continue;
        }
        if (t === S) { doc.items.push({ tok: take(null) }); continue; }
        i++; // a token the document cannot hold is passed over; its text stays as written
    }
    return doc;
}

// ================================================================ evaluation

/** A complete macro's name and closing flag, for pairing scopes; null for a variable or a partial one. */
function macroInfo(m) {
    if (!m.start || !m.end || m.varExpr || !m.body?.name) return null;
    return {
        name: m.body.name.img,
        closing: m.flags.some(f => f.img === '/'),
        argCount: m.body.args?.list.length ?? 0,
    };
}

// every complete macro inside a partial one, which resolve where they stand
function collectInside(node, out) {
    for (const part of [node.body, node.varExpr, node.body?.args, ...(node.body?.args?.list || []), node.varExpr?.op, node.varExpr?.op?.value]) {
        if (!part) continue;
        for (const x of part.parts || []) {
            if (x.kind !== 'macro') continue;
            if (x.end && !x.end.inserted) out.push(x);
            else collectInside(x, out);
        }
    }
}

/** The complete macros at the top of text, in order: what {{if}} reads to find its own {{else}}. */
export function topLevelMacros(text) {
    return parse(tokenize(text)).items.filter(it => it.macro?.end).map(it => ({ ...macroInfo(it.macro), s: it.macro.start.s, e: it.macro.end.e }))
        .filter(m => m.name);
}

function documentItems(doc) {
    const items = [];
    for (const it of doc.items) {
        if (!it.macro) continue;
        if (it.macro.end && !it.macro.end.inserted) items.push({ node: it.macro, s: it.macro.start.s, e: it.macro.end.e });
        else {
            const inner = [];
            collectInside(it.macro, inner);
            for (const m of inner) items.push({ node: m, s: m.start.s, e: m.end.e });
        }
    }
    return items.sort((a, b) => a.s - b.s || a.e - b.e);
}

// ================================================================ the branch mark and the evaluator

/** What {{else}} answers: control characters no author types, removed when a full evaluation ends. */
export const BRANCH_MARK = '\u0001\u001d\u0002';

const NONE = Object.freeze([]);

const hasFlag = (node, img) => {
    for (const f of node.flags) if (f.img === img) return true;
    return false;
};

// one key's named items, each a scan step (+1 opens, -1 unpaired closer), summed per stretch so a scan skips stretches
class ScopeLane {
    constructor() {
        this.at = []; // item index of each member
        this.step = [];
        this.lastCloser = -1; // member index of the last unpaired closer
    }

    seal() {
        const m = this.at.length;
        this.size = m <= 32 ? 32 : Math.ceil(Math.sqrt(m));
        const count = Math.ceil(m / this.size);
        this.sum = new Int32Array(count);
        this.low = new Int32Array(count);
        for (let b = 0; b < count; b++) this.restretch(b);
    }

    restretch(b) {
        const from = b * this.size;
        const to = Math.min(this.at.length, from + this.size);
        let acc = 0;
        let low = 0;
        for (let k = from; k < to; k++) {
            acc += this.step[k];
            if (acc < low) low = acc;
        }
        this.sum[b] = acc;
        this.low[b] = low;
    }

    // a closer paired with an opener that cannot open is passed over by every later scan
    retire(k) {
        this.step[k] = 0;
        this.restretch(Math.floor(k / this.size));
        if (k === this.lastCloser) {
            let j = k - 1;
            while (j >= 0 && this.step[j] !== -1) j--;
            this.lastCloser = j;
        }
    }

    // the member whose step first brings a depth of 1, opened at member k, to 0; -1 when none does
    match(k) {
        if (k >= this.lastCloser) return -1;
        const { step, size } = this;
        const m = this.at.length;
        let depth = 1;
        let j = k + 1;
        const firstEnd = Math.min(m, (Math.floor(j / size) + 1) * size);
        for (; j < firstEnd; j++) {
            depth += step[j];
            if (depth === 0) return j;
        }
        if (j >= m) return -1;
        for (let b = j / size; b < this.sum.length; b++) {
            if (depth + this.low[b] <= 0) {
                for (let u = b * size, end = Math.min(m, u + size); u < end; u++) {
                    depth += step[u];
                    if (depth === 0) return u;
                }
            }
            depth += this.sum[b];
        }
        return -1;
    }
}

// which items stand as written and which closer each block opener takes; null when no item closes
function pairScopes(items, canOpenOf) {
    const n = items.length;
    const keyOf = new Array(n);
    const shut = new Uint8Array(n);
    let lanes = null;
    for (let i = 0; i < n; i++) {
        const node = items[i].node;
        if (node.varExpr || !node.body?.name) continue;
        const key = keyOf[i] = node.body.name.img.toLowerCase();
        if (hasFlag(node, '/')) {
            shut[i] = 1;
            (lanes ||= new Map()).set(key, null);
        }
    }
    if (!lanes) return null;
    const canOpen = canOpenOf();
    const laneOf = new Array(n);
    const member = new Int32Array(n);
    for (let i = 0; i < n; i++) {
        let lane = keyOf[i] === undefined ? undefined : lanes.get(keyOf[i]);
        if (lane === undefined) continue;
        if (lane === null) lanes.set(keyOf[i], lane = new ScopeLane());
        member[i] = lane.at.length;
        lane.at.push(i);
        lane.step.push(shut[i] ? -1 : canOpen(items[i].node) ? 1 : 0);
        if (shut[i]) lane.lastCloser = member[i];
        laneOf[i] = lane;
    }
    for (const lane of lanes.values()) lane.seal();
    const asWritten = new Uint8Array(n);
    const paired = new Uint8Array(n);
    const closes = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
        const lane = laneOf[i];
        if (!lane || paired[i] || shut[i]) continue;
        const k = lane.match(member[i]);
        if (k === -1) continue;
        const c = lane.at[k];
        paired[i] = paired[c] = 1;
        if (canOpen(items[i].node)) {
            closes[i] = c;
            i = c;
        } else {
            asWritten[i] = asWritten[c] = 1;
            lane.retire(k);
        }
    }
    for (let i = 0; i < n; i++) if (shut[i] && !paired[i]) asWritten[i] = 1;
    return { asWritten, closes };
}

// what a text writes out: items as written (no node), values and blocks; a block's inner items are left out
function planOf(items, canOpenOf) {
    const scopes = pairScopes(items, canOpenOf);
    if (!scopes) return items;
    const plan = [];
    let i = 0;
    while (i < items.length) {
        const it = items[i];
        const close = scopes.closes[i];
        if (scopes.asWritten[i]) plan.push({ node: null, s: it.s, e: it.e, from: -1, to: -1 });
        else if (close === -1) plan.push(it);
        else plan.push({ node: it.node, s: it.s, e: items[close].e, from: it.e + 1, to: items[close].s });
        // a block resumes after its closer
        i = Math.max(i, close) + 1;
    }
    return plan;
}

/**
 * The evaluator over a vocabulary.
 * @param {{ getMacro: Function, getPrimary: Function }} registry name, env -> definition or undefined
 * @returns {{ evaluate: (input: string, env: object, opts?: { offset?: number }) => string }}
 */
export function createEngine(registry) {
    // what a handler is handed; the four names extensions read are fixed
    class Call {
        constructor(args, unnamedArgs, list, isScoped, env, calledAs, preserve, globalOffset) {
            this.args = args;
            this.unnamedArgs = unnamedArgs;
            this.list = list;
            this.isScoped = isScoped;
            this.env = env;
            this.calledAs = calledAs;
            this.preserve = preserve;
            this.globalOffset = globalOffset;
        }

        expand(text) {
            return evaluate(text, this.env, { offset: this.globalOffset });
        }
    }

    function canOpenFor(env) {
        const seen = new Map();
        return (node) => {
            const name = node.body.name.img;
            let def = seen.get(name);
            if (def === undefined && !seen.has(name)) seen.set(name, def = registry.getPrimary(name, env));
            if (!def) return true;
            if (def.list) return false;
            const count = (node.body.args?.list.length ?? 0) + 1;
            return def.minArgs <= count && count <= def.maxArgs;
        };
    }

    function accepts(def, args) {
        const n = args.length;
        if (def.list) {
            if (!(n >= def.minArgs + def.list.min && (def.list.max === null || Math.max(0, n - def.maxArgs) <= def.list.max))) return !def.strict;
        } else if (!(def.minArgs <= n && n <= def.maxArgs)) return !def.strict;
        return true;
    }

    function typesHold(def, unnamed) {
        for (let k = 0; k < unnamed.length; k++) {
            const spec = def.args[k];
            if (!spec) continue;
            if (def.strict) {
                const types = Array.isArray(spec.type) ? spec.type : [spec.type];
                if (!types.some(t => ofType(unnamed[k], t))) return false;
            }
            if (spec.max !== undefined && Number(unnamed[k]) > spec.max) return false;
        }
        return true;
    }

    // a macro as written: its text between the braces, each argument and a block's content replaced by its value
    function asWritten(node, text, args, contentFrom, contentTo) {
        const from = node.start.e + 1;
        const to = node.end ? node.end.s - 1 : node.e;
        if (!(from <= to)) return '{{}}';
        let out = '';
        let cursor = from;
        const list = node.body?.args?.list;
        const count = list ? list.length : 0;
        for (let k = 0; k < count; k++) {
            const a = list[k];
            if (a.s === null) continue;
            if (a.s > cursor) out += text.slice(cursor, a.s);
            out += args[k];
            cursor = a.e + 1;
        }
        if (contentFrom >= 0 && contentFrom < contentTo) {
            if (contentFrom > cursor) out += text.slice(cursor, contentFrom);
            out += args[count];
            cursor = contentTo;
        }
        if (cursor <= to) out += text.slice(cursor, to + 1);
        return `{{${out}}}`;
    }

    // the arguments in order, a block's content last; delayed ones as written
    function argumentsOf(node, text, offset, env, delayed, preserve, contentFrom, contentTo) {
        const args = [];
        // an argument that took no token is empty, and nothing in it expands
        for (const a of node.body?.args?.list ?? NONE) {
            const raw = a.s === null ? '' : text.slice(a.s, a.e + 1);
            args.push(delayed || a.s === null ? raw : nestedValue(raw, offset + a.s, env));
        }
        if (contentFrom >= 0) {
            if (contentFrom >= contentTo) args.push('');
            else if (delayed) args.push(text.slice(contentFrom, contentTo));
            else {
                const value = nestedValue(text.slice(contentFrom, contentTo), offset + contentFrom, env);
                args.push(preserve ? value : trimScoped(value));
            }
        }
        return args;
    }

    // contentFrom..contentTo is a block's content (exclusive end), contentFrom -1 for no block
    function macroValue(node, text, offset, env, contentFrom, contentTo) {
        if (node.varExpr) return variableValue(node.varExpr, text, offset, env);
        const name = node.body?.name?.img ?? '';
        const preserve = hasFlag(node, '#');
        const def = registry.getMacro(name, env);
        const args = argumentsOf(node, text, offset, env, def?.delay === true, preserve, contentFrom, contentTo);
        if (!name || !def || !accepts(def, args)) return asWritten(node, text, args, contentFrom, contentTo);
        const unnamed = args.slice(0, Math.min(args.length, def.maxArgs));
        if (!typesHold(def, unnamed)) return asWritten(node, text, args, contentFrom, contentTo);
        const call = new Call(args, unnamed, def.list ? args.slice(def.maxArgs) : null, contentFrom >= 0, env, name, preserve, offset + node.start.s);
        let result;
        try {
            result = def.handler(call);
        } catch {
            return asWritten(node, text, args, contentFrom, contentTo);
        }
        return normalize(result);
    }

    // where a part of a variable's value starts and ends; an inserted end has no place
    const partStart = (p) => (p.kind === 'macro' && p.start && p.end ? p.start.s : p.s);
    const partEnd = (p) => (p.kind === 'macro' && p.start && p.end ? p.end.e : p.e);

    function operandOf(valueNode, text, offset, env) {
        const parts = valueNode?.parts;
        if (!parts || !parts.length) return '';
        let from = Infinity;
        let to = -Infinity;
        let macros = false;
        for (const p of parts) {
            if (p.kind === 'macro') macros = true;
            from = Math.min(from, partStart(p));
            to = Math.max(to, partEnd(p));
        }
        if (!macros) return text.slice(from, to + 1).trim();
        let out = '';
        let cursor = from;
        for (const p of parts) {
            if (p.kind !== 'macro') continue;
            const s = partStart(p);
            if (s > cursor) out += text.slice(cursor, s);
            out += macroValue(p, text, offset, env, -1, -1);
            cursor = partEnd(p) + 1;
        }
        if (cursor <= to) out += text.slice(cursor, to + 1);
        return out.trim();
    }

    const truthy = (x) => !!x && !isFalseBoolean(normalize(x));

    // a store's throw is not caught here: the full evaluation around it answers its own input
    function variableValue(vx, text, offset, env) {
        const store = vx.scope.img === '$' ? env.vars.global : env.vars.local;
        const name = vx.name ? vx.name.img : '';
        const op = vx.op?.op?.img;
        let operand;
        const value = () => (operand ??= operandOf(vx.op.value, text, offset, env));
        switch (op) {
            case undefined: return normalize(store.get(name));
            case '=': store.set(name, value()); return '';
            case '++': return normalize(store.add(name, 1));
            case '--': return normalize(store.add(name, -1));
            case '+=': store.add(name, value()); return '';
            case '-=': {
                const by = Number(value());
                if (!Number.isNaN(by)) store.add(name, -by);
                return '';
            }
            case '||': {
                const v = store.get(name);
                return truthy(v) ? normalize(v) : value();
            }
            case '??': return store.has(name) ? normalize(store.get(name)) : value();
            case '||=': {
                const v = store.get(name);
                if (truthy(v)) return normalize(v);
                store.set(name, value());
                return value();
            }
            case '??=': {
                if (store.has(name)) return normalize(store.get(name));
                store.set(name, value());
                return value();
            }
            case '==': case '!=': {
                const same = normalize(store.get(name)) === value();
                return String(op === '==' ? same : !same);
            }
            case '>': case '>=': case '<': case '<=': {
                const left = Number(store.get(name));
                const right = Number(value());
                if (Number.isNaN(left) || Number.isNaN(right)) return 'false';
                if (op === '>') return String(left > right);
                if (op === '>=') return String(left >= right);
                if (op === '<') return String(left < right);
                return String(left <= right);
            }
            default: return '';
        }
    }

    // in a frame of its own: a frame keeps its temporaries alive, and the parse must not outlive this
    function planText(text, env) {
        return planOf(documentItems(parse(tokenize(text))), () => canOpenFor(env));
    }

    // a text's macros, paired into scopes and replaced; the text itself when it holds none
    function renderText(text, offset, env) {
        if (!text.includes('{{')) return text;
        const plan = planText(text, env);
        if (!plan.length) return text;
        // each step appends the text since the previous one (empty when they touch), then its own
        let out = '';
        let end = 0;
        for (let k = 0, step = plan[0]; step !== undefined; step = plan[++k]) {
            out += text.slice(end, step.s);
            if (step.node === null) out += text.slice(step.s, step.e + 1);
            else out += step.from >= 0 ? macroValue(step.node, text, offset, env, step.from, step.to) : macroValue(step.node, text, offset, env, -1, -1);
            end = step.e + 1;
        }
        return out + text.slice(end);
    }

    // an argument or a block's content: no pre-step, no post-step
    function nestedValue(text, offset, env) {
        return text ? renderText(text, offset, env) : '';
    }

    function evaluate(input, env, { offset = 0 } = {}) {
        if (!input) return '';
        try {
            return postProcess(renderText(preProcess(input), offset, env));
        } catch {
            return input;
        }
    }

    return { evaluate };
}

/** A call the vocabulary refuses: the macro stays as written. */
export class MacroError extends Error {}

function preProcess(text) {
    return text
        .replace(/{{time_(UTC[+-]\d+)}}/gi, (_m, offset) => `{{time::${offset}}}`)
        .replace(/<USER>/gi, '{{user}}')
        .replace(/<BOT>/gi, '{{char}}')
        .replace(/<CHAR>/gi, '{{char}}')
        .replace(/<GROUP>/gi, '{{group}}')
        .replace(/<CHARIFNOTGROUP>/gi, '{{charIfNotGroup}}');
}

function postProcess(text) {
    return dropTrimMarks(text.replace(/\\([{}])/g, '$1')).replaceAll(BRANCH_MARK, '');
}

// each {{trim}} takes the newline runs beside it, in one pass (a regex re-read every run once per newline)
function dropTrimMarks(text) {
    let out = '';
    let cursor = 0;
    for (const m of text.matchAll(/\{\{trim\}\}/gi)) {
        if (m.index < cursor) continue;
        let s = m.index;
        while (s > cursor && text[s - 1] === '\n') {
            s--;
            if (s > cursor && text[s - 1] === '\r') s--;
        }
        let e = m.index + m[0].length;
        while (e < text.length) {
            if (text[e] === '\n') e++;
            else if (text[e] === '\r' && text[e + 1] === '\n') e += 2;
            else break;
        }
        out += text.slice(cursor, s);
        cursor = e;
    }
    return cursor ? out + text.slice(cursor) : text;
}

/** Whether text could hold anything the engine changes; the rest is returned untouched. */
export function mayHoldMacros(text) {
    return typeof text === 'string' && /\{\{|\\[{}]|<(?:user|bot|char|group|charifnotgroup)>/i.test(text);
}

export function normalize(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
        try { return JSON.stringify(value); } catch { return String(value); }
    }
    return String(value);
}

export function isTrueBoolean(x) {
    return ['on', 'true', '1'].includes(String(x ?? '').trim().toLowerCase());
}

export function isFalseBoolean(x) {
    return ['off', 'false', '0'].includes(String(x ?? '').trim().toLowerCase());
}

function ofType(value, type) {
    const v = String(value).trim();
    if (type === 'string') return true;
    if (type === 'integer') return /^-?\d+$/.test(v);
    if (type === 'number') return Number.isFinite(Number(v));
    if (type === 'boolean') return isTrueBoolean(v) || isFalseBoolean(v);
    return false;
}

// the spaces and tabs a line opens with
const indentOf = (line) => line.length - line.replace(/^[ \t]+/, '').length;

/** A scoped block's content, dedented by its first written line's indentation (a shallower line loses all of its own), then trimmed. */
export function trimScoped(content) {
    if (!content) return '';
    const lines = content.split('\n');
    const first = lines.find(line => line.trim());
    const base = first ? indentOf(first) : 0;
    if (!base) return content.trim();
    return lines.map(line => (indentOf(line) < base ? line.trimStart() : line.slice(base))).join('\n').trim();
}
