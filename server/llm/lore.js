// The lore engine: which world-info entries a chat activates, and where each one is placed.
import { entryUid } from '../lib/world-entry.js';

// each name's code is its place in the list; books are imported with these codes, so the lists only ever grow at the end
const numbered = (names) => Object.freeze(Object.fromEntries(names.map((name, code) => [name, code])));

/** Secondary-key logic codes. */
export const LOGIC = numbered(['AND_ANY', 'NOT_ALL', 'NOT_ANY', 'AND_ALL']);

/** Placement codes. */
export const POSITION = numbered(['before', 'after', 'ANTop', 'ANBottom', 'atDepth', 'EMTop', 'EMBottom', 'outlet']);

// entry flag, then the scanSources key it reads, in the order they join the scan text
const SOURCES = [
    ['matchPersonaDescription', 'personaDescription'],
    ['matchCharacterDescription', 'characterDescription'],
    ['matchCharacterPersonality', 'characterPersonality'],
    ['matchCharacterDepthPrompt', 'characterDepthPrompt'],
    ['matchScenario', 'scenario'],
    ['matchCreatorNotes', 'creatorNotes'],
];
const ROLE_NAMES = Object.assign(Object.create(null), { 0: 'system', 1: 'user', 2: 'assistant' });
const TIMED_TYPES = ['sticky', 'cooldown'];

// ================================================================ key matching

const REGEX_KEY = /^\/([\s\S]+?)\/([gimsuy]*)$/;
const BARE_SLASH = /(?:^|[^\\])\//;
const WORD_ONLY = /^[\p{L}\p{N}_]+$/u;
const ASCII_WORD_ONLY = /^[A-Za-z0-9_]+$/;
const WORD_GAPS = /[^\p{L}\p{N}_]+/u;
const ASCII_WORD_GAPS = /[^A-Za-z0-9_]+/;
const HAS_SPACE = /\s/;
const WORD_POINT = /^[\p{L}\p{N}_]$/u;
// a text is split into a word set once it has answered this many direct searches
const INDEX_AFTER = 24;

function compileRegexKey(text) {
    const m = REGEX_KEY.exec(text);
    if (!m || BARE_SLASH.test(m[1])) return null;
    try {
        return new RegExp(m[1].replace('\\/', '/'), m[2]);
    } catch {
        return null;
    }
}

function asciiWordCode(c) {
    return c === 95 || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function wordPoint(cp) {
    return cp < 128 ? asciiWordCode(cp) : WORD_POINT.test(String.fromCodePoint(cp));
}

function pointBefore(s, i) {
    const lo = s.charCodeAt(i - 1);
    if (lo >= 0xDC00 && lo <= 0xDFFF && i >= 2) {
        const hi = s.charCodeAt(i - 2);
        if (hi >= 0xD800 && hi <= 0xDBFF) return (hi - 0xD800) * 0x400 + (lo - 0xDC00) + 0x10000;
    }
    return lo;
}

// an occurrence of probe with no word character touching either end
function boundedHit(text, probe, unicode) {
    const n = probe.length;
    for (let i = text.indexOf(probe); i !== -1; i = text.indexOf(probe, i + 1)) {
        const j = i + n;
        if (unicode) {
            if (i > 0 && wordPoint(pointBefore(text, i))) continue;
            if (j < text.length && wordPoint(text.codePointAt(j))) continue;
        } else {
            if (i > 0 && asciiWordCode(text.charCodeAt(i - 1))) continue;
            if (j < text.length && asciiWordCode(text.charCodeAt(j))) continue;
        }
        return true;
    }
    return false;
}

/** One case variant of a plain key, classified once. */
class Probe {
    constructor(text) {
        this.text = text;
        this.word = WORD_ONLY.test(text);
        this.ascii = this.word && ASCII_WORD_ONLY.test(text);
        this.space = !this.word && HAS_SPACE.test(text);
    }
}

/** A trimmed, non-empty key: a compiled regex, or a plain probe per case variant. */
class Key {
    constructor(text) {
        this.text = text;
        this.regex = compileRegexKey(text);
        this.exact = null;
        this.folded = null;
        this.seeks = null;
    }

    probe(caseSensitive) {
        if (caseSensitive) return this.exact ??= new Probe(this.text);
        return this.folded ??= new Probe(this.text.toLowerCase());
    }
}

/** One case variant of a text, with word sets built once it is searched often. */
class View {
    constructor(text) {
        this.text = text;
        this.uses = 0;
        this.asciiUses = 0;
        this.words = null;
        this.wordList = null;
        this.asciiWords = null;
    }

    index() {
        this.words = new Set(this.text.split(WORD_GAPS));
        this.wordList = [...this.words].join('\n');
    }

    // a newline is no word character, so a later text extends the word sets as they stand
    append(more) {
        this.text = this.text + '\n' + more;
        if (this.words !== null) {
            const fresh = [];
            for (const w of more.split(WORD_GAPS)) {
                if (this.words.has(w)) continue;
                this.words.add(w);
                fresh.push(w);
            }
            if (fresh.length) this.wordList = this.wordList + '\n' + fresh.join('\n');
        }
        if (this.asciiWords !== null) for (const w of more.split(ASCII_WORD_GAPS)) this.asciiWords.add(w);
    }

    // probe is all word characters, so it can only ever sit inside one word
    contains(probe) {
        if (this.wordList === null) {
            if (++this.uses <= INDEX_AFTER) return this.text.includes(probe);
            this.index();
        }
        return this.wordList.includes(probe);
    }

    hasWord(probe) {
        if (this.words === null) {
            if (++this.uses <= INDEX_AFTER) return boundedHit(this.text, probe, true);
            this.index();
        }
        return this.words.has(probe);
    }

    hasAsciiWord(probe) {
        if (this.asciiWords === null) {
            if (++this.asciiUses <= INDEX_AFTER) return boundedHit(this.text, probe, false);
            this.asciiWords = new Set(this.text.split(ASCII_WORD_GAPS));
        }
        return this.asciiWords.has(probe);
    }
}

/** A text the scan text is joined from; lower-casing is per part, since a newline breaks every casing context. */
class Part {
    constructor(text, growing = false) {
        this.text = text;
        this.growing = growing;
        this.views = [null, null];
    }

    view(lower) {
        let v = this.views[lower];
        if (v === null) {
            if (lower) {
                const folded = this.text.toLowerCase();
                v = folded === this.text && !this.growing ? this.view(0) : new View(folded);
            } else {
                v = new View(this.text);
            }
            this.views[lower] = v;
        }
        return v;
    }

    // only a growing part takes more text, and only between passes
    append(more) {
        this.text = this.text + '\n' + more;
        this.views[0]?.append(more);
        this.views[1]?.append(more.toLowerCase());
    }
}

const MODE_SUB = 1;
const MODE_ASCII = 4;
const MODE_WORD = 16;

function modeOf(p, wholeWords, stMatching) {
    return !wholeWords || (stMatching && p.space) ? MODE_SUB : stMatching ? MODE_ASCII : MODE_WORD;
}

// a probe of word characters only can be answered text by text, from each text's word sets
function byWords(p, mode) {
    return mode === MODE_ASCII ? p.ascii : p.word;
}

function viewHit(view, p, mode) {
    if (mode === MODE_SUB) return view.contains(p.text);
    return mode === MODE_ASCII ? view.hasAsciiWord(p.text) : view.hasWord(p.text);
}

/** A haystack: parts joined with newlines, answering key tests with memoized results. */
class Hay {
    constructor(parts, memo = true) {
        this.parts = parts;
        this.joined = [null, null];
        this.memo = memo ? new Map() : null;
    }

    full(lower) {
        let t = this.joined[lower];
        if (t === null) {
            const parts = this.parts;
            if (parts.length === 1) t = parts[0].view(lower).text;
            else {
                const texts = new Array(parts.length);
                for (let i = 0; i < parts.length; i++) texts[i] = parts[i].view(lower).text;
                t = texts.join('\n');
            }
            this.joined[lower] = t;
        }
        return t;
    }

    test(key, caseSensitive, wholeWords, stMatching) {
        const memo = this.memo;
        if (key.regex) {
            let hit = memo?.get(key);
            if (hit === undefined) {
                key.regex.lastIndex = 0;
                hit = key.regex.test(this.full(0));
                memo?.set(key, hit);
            }
            return hit;
        }
        const lower = caseSensitive ? 0 : 1;
        const p = key.probe(caseSensitive);
        const mode = modeOf(p, wholeWords, stMatching);
        const bits = memo?.get(p) ?? 0;
        if (bits & mode) return (bits & (mode << 1)) !== 0;
        let hit = false;
        if (byWords(p, mode)) {
            const parts = this.parts;
            for (let i = 0; i < parts.length && !hit; i++) hit = viewHit(parts[i].view(lower), p, mode);
        } else if (mode === MODE_SUB) {
            hit = this.full(lower).includes(p.text);
        } else {
            hit = boundedHit(this.full(lower), p.text, mode === MODE_WORD);
        }
        memo?.set(p, bits | mode | (hit ? mode << 1 : 0));
        return hit;
    }
}

/** One pass's haystack: a base that outlives the pass, then the recursion text so far. */
class PassHay extends Hay {
    constructor(base, tail) {
        super([...base.parts, tail]);
        this.base = base;
        this.tail = tail;
    }

    full(lower) {
        return this.joined[lower] ??= this.base.full(lower) + '\n' + this.tail.view(lower).text;
    }

    test(key, caseSensitive, wholeWords, stMatching) {
        if (!key.regex) {
            const p = key.probe(caseSensitive);
            const mode = modeOf(p, wholeWords, stMatching);
            if (byWords(p, mode)) {
                return this.base.test(key, caseSensitive, wholeWords, stMatching) || viewHit(this.tail.view(caseSensitive ? 0 : 1), p, mode);
            }
        }
        return super.test(key, caseSensitive, wholeWords, stMatching);
    }
}

/** Per-scan caches: parsed keys and single-text haystacks. */
class Matcher {
    constructor() {
        this.raw = new Map();
        this.trimmed = new Map();
        this.single = new Map();
    }

    key(raw) {
        let k = this.raw.get(raw);
        if (k === undefined) {
            const t = raw ? String(raw).trim() : '';
            if (!t) k = null;
            else {
                k = this.trimmed.get(t);
                if (k === undefined) this.trimmed.set(t, k = new Key(t));
            }
            this.raw.set(raw, k);
        }
        return k;
    }

    test(raw, hay, caseSensitive, wholeWords, stMatching) {
        const k = this.key(raw);
        return k !== null && hay.test(k, caseSensitive, wholeWords, stMatching);
    }

    any(keys, hay, caseSensitive, wholeWords, stMatching) {
        for (let i = 0; i < keys.length; i++) if (this.test(keys[i], hay, caseSensitive, wholeWords, stMatching)) return true;
        return false;
    }

    count(keys, hay, caseSensitive, wholeWords, stMatching) {
        let n = 0;
        for (let i = 0; i < keys.length; i++) if (this.test(keys[i], hay, caseSensitive, wholeWords, stMatching)) n++;
        return n;
    }

    // the selective logic over the secondary keys, any unknown code reading as AND_ANY
    passes(logic, keys, hay, caseSensitive, wholeWords, stMatching) {
        switch (logic ?? 0) {
            case LOGIC.AND_ALL: return this.count(keys, hay, caseSensitive, wholeWords, stMatching) === keys.length;
            case LOGIC.NOT_ANY: return !this.any(keys, hay, caseSensitive, wholeWords, stMatching);
            case LOGIC.NOT_ALL: return this.count(keys, hay, caseSensitive, wholeWords, stMatching) !== keys.length;
            default: return this.any(keys, hay, caseSensitive, wholeWords, stMatching);
        }
    }

    hayOf(text) {
        let h = this.single.get(text);
        if (h === undefined) this.single.set(text, h = new Hay([new Part(text)]));
        return h;
    }
}

function expandKeys(list, expand) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const k of list) {
        const s = expand ? expand(String(k ?? '')) : String(k ?? '');
        if (typeof s === 'string' ? s.trim() !== '' : s != null && String(s).trim() !== '') out.push(s);
    }
    return out;
}

const asText = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

// ================================================================ entries

function splitHeadLines(content) {
    const text = typeof content === 'string' ? content : '';
    const decorators = [];
    if (!text.startsWith('@@')) return { decorators, body: text };
    let afterUnknown = false;
    let at = 0;
    for (;;) {
        if (!text.startsWith('@@', at)) return { decorators, body: text.slice(at) };
        const cut = text.indexOf('\n', at);
        const head = cut < 0 ? text.slice(at) : text.slice(at, cut);
        const fallback = head.startsWith('@@@');
        // an @@@ line only stands in for an unknown decorator just above it
        if (!fallback || afterUnknown) {
            const name = fallback ? head.slice(1) : head;
            const known = name.startsWith('@@activate') || name.startsWith('@@dont_activate');
            if (known) decorators.push(name);
            afterUnknown = !known;
        }
        if (cut < 0) return { decorators, body: text };
        at = cut + 1;
    }
}

/** One collected entry and everything the scan learns about it. */
class Rec {
    constructor(world, entry) {
        this.world = world;
        this.entry = entry;
        this.key = `${world}.${entry.uid}`;
        const { decorators, body } = splitHeadLines(entry.content);
        this.force = decorators.includes('@@activate') ? 1 : decorators.includes('@@dont_activate') ? -1 : 0;
        this.body = body;
        this.placed = undefined;
        this.pending = undefined;
        this.odds = 1;
        this.via = null;
        this.missed = false;
        this.hash = undefined;
        this.span = undefined;
        this.hayKey = undefined;
        this.groups = undefined;
        this.hay = null;
    }
}

const byOrderDesc = (a, b) => (b.entry.order ?? 0) - (a.entry.order ?? 0);
const ascending = (x, y) => x - y;

function scopeRank(scope) {
    switch (scope) {
        case 'chat': return 0;
        case 'persona': return 1;
        case 'global': return 3;
        default: return 2;
    }
}

// chat lore first, then persona, character and global, each by order descending
function collect(worlds, scopes) {
    const byScope = [[], [], [], []];
    const taken = new Set();
    for (const world of worlds) {
        if (!world || taken.has(world.name)) continue;
        taken.add(world.name);
        const bucket = byScope[scopeRank(scopes?.get?.(world.name) || 'character')];
        for (const [k, blob] of Object.entries(world.data?.entries || {})) {
            if (!blob) continue;
            const uid = entryUid(k, blob);
            bucket.push(new Rec(world.name, uid === blob.uid ? blob : { ...blob, uid }));
        }
    }
    const out = [];
    for (const bucket of byScope) {
        bucket.sort(byOrderDesc);
        for (const r of bucket) out.push(r);
    }
    return out;
}

// djb2 over the entry's JSON, as the hashes earlier scans stored in chat metadata
function stateHash(entry) {
    const s = JSON.stringify(entry);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0;
    return String(h);
}

function groupNames(entry) {
    return typeof entry.group === 'string' ? entry.group.split(/,\s*/).filter(Boolean) : [];
}

// ================================================================ the public surface

/** The last `depth` texts (a new array), or `texts` itself when depth is not a positive integer. */
export function scanWindow(texts, depth) {
    return Number.isInteger(depth) && depth > 0 ? texts.slice(-depth) : texts;
}

/**
 * Whether one entry's keys are satisfied by a text, with no lifecycle.
 * @param {object} entry a stored world entry: key, keysecondary, selective, selectiveLogic, the match flags
 * @param {string} scanText the text its keys are matched against
 * @param {object} [defaults] caseSensitive, matchWholeWords, stMatching, expandMacro
 * @returns {boolean}
 */
export function entryFires(entry, scanText, defaults = {}) {
    if (entry.constant) return true;
    const caseSensitive = entry.caseSensitive ?? defaults.caseSensitive ?? false;
    const wholeWords = entry.matchWholeWords ?? defaults.matchWholeWords ?? false;
    const stMatching = defaults.stMatching ?? false;
    const expand = typeof defaults.expandMacro === 'function' ? defaults.expandMacro : null;
    const matcher = new Matcher();
    const primary = expandKeys(entry.key, expand);
    if (!primary.length) return false;
    const hay = matcher.hayOf(asText(scanText));
    if (!matcher.any(primary, hay, caseSensitive, wholeWords, stMatching)) return false;
    const secondary = expandKeys(entry.keysecondary, expand);
    if (!entry.selective || !secondary.length) return true;
    return matcher.passes(entry.selectiveLogic, secondary, hay, caseSensitive, wholeWords, stMatching);
}

/**
 * Scans the worlds against the chat and places what activates.
 * @param {object[]} worlds world rows { name, data: { entries } }
 * @param {string[]} historyTexts the chat window's texts, oldest first
 * @param {object} [opts] scan settings and injected services
 * @returns {object} the placed groups, notes, timed state, activations and suppressions
 */
export function selectLore(worlds, historyTexts, opts = {}) {
    const {
        defaultScanDepth = null, caseSensitive = false, matchWholeWords = false, stMatching = false,
        recursive = false, maxRecursionSteps = 0, budgetTokens = 0, estimateTokens = null,
        trigger = 'normal', chatLength = historyTexts.length, timedState = null, dryRun = false,
        provenance = true, scanSources = {}, injectTexts = [], character = null, scopes = null,
        expandMacro = null, rng = Math.random, useGroupScoring = false,
    } = opts;
    const expand = typeof expandMacro === 'function' ? expandMacro : null;
    const tracing = !!dryRun && provenance !== false;
    const budgetOn = budgetTokens > 0 && typeof estimateTokens === 'function';
    const history = historyTexts;
    const len = history.length;
    const matcher = new Matcher();
    const order = collect(worlds, scopes);

    // ---------------------------------------------------------- suppression

    const suppressed = [];
    const suppressedSeen = new Set();
    const suppress = (r, reason) => {
        const id = `${r.world}::${r.entry.uid}::${reason}`;
        if (suppressedSeen.has(id)) return;
        suppressedSeen.add(id);
        suppressed.push({ world: r.world, uid: r.entry.uid, reason });
    };

    // ---------------------------------------------------------- timed effects

    const rows = {
        sticky: { ...(timedState?.sticky || {}) },
        cooldown: { ...(timedState?.cooldown || {}) },
    };
    for (const type of TIMED_TYPES) {
        const map = rows[type];
        for (const k of Object.keys(map)) if (!map[k] || typeof map[k] !== 'object') delete map[k];
    }
    const hashOf = (r) => (r.hash ??= stateHash(r.entry));
    const firstByHash = new Map();
    let hashedUpTo = 0;
    const entryWithHash = (h) => {
        let found = firstByHash.get(h);
        while (found === undefined && hashedUpTo < order.length) {
            const r = order[hashedUpTo++];
            const rh = hashOf(r);
            if (!firstByHash.has(rh)) firstByHash.set(rh, r);
            if (rh === h) found = r;
        }
        return found;
    };
    const active = { sticky: new Set(), cooldown: new Set() };
    for (const type of TIMED_TYPES) {
        const map = rows[type];
        for (const [k, row] of Object.entries(map)) {
            if (chatLength <= Number(row.start) && !row.protected) {
                delete map[k];
                continue;
            }
            const match = entryWithHash(String(row.hash));
            if (!match) {
                if (chatLength >= Number(row.end)) delete map[k];
                continue;
            }
            const e = match.entry;
            if (!e[type]) {
                delete map[k];
                continue;
            }
            if (chatLength >= Number(row.end)) {
                delete map[k];
                if (type === 'sticky' && e.cooldown) {
                    rows.cooldown[k] = { hash: hashOf(match), start: chatLength, end: chatLength + Number(e.cooldown), protected: true };
                    active.cooldown.add(k);
                }
                continue;
            }
            active[type].add(k);
        }
    }
    // delay, like the timed effects, holds a state key, so a uid shared in one book shares the hold
    const delayed = new Set();
    for (const r of order) if (r.entry.delay && chatLength < Number(r.entry.delay)) delayed.add(r.key);
    const isSticky = (r) => active.sticky.has(r.key);
    const isCooling = (r) => active.cooldown.has(r.key);
    const isDelayed = (r) => delayed.has(r.key);

    // ---------------------------------------------------------- scan texts

    const sourceTexts = SOURCES.map(([, name]) => scanSources?.[name]);
    const sourceParts = new Array(SOURCES.length).fill(null);
    let injectPart = null;
    {
        const texts = [];
        for (const item of injectTexts) if (item?.text) texts.push(item.text);
        const joined = texts.join('\n');
        if (joined) injectPart = new Part(joined);
    }
    // every window goes through scanWindow, the same function the prompt's extension facts read
    const windows = new Map();
    const windowFor = (depth) => {
        let w = windows.get(depth);
        if (w === undefined) windows.set(depth, w = scanWindow(history, depth));
        return w;
    };
    // a window is the newest messages, so two windows of one length are the same text
    const windowParts = new Map();
    const windowPart = (texts) => {
        let p = windowParts.get(texts.length);
        if (!p) windowParts.set(texts.length, p = new Part(texts.join('\n')));
        return p;
    };
    let recursionPart = null;
    const emptyHay = new Hay([new Part('')]);
    const baseHays = new Map();
    let passHays = new Map();

    // the messages an entry reads, or null for none and no extras at all
    const entryWindow = (e) => {
        if (!Number.isInteger(e.scanDepth)) return windowFor(defaultScanDepth);
        return e.scanDepth <= 0 ? null : windowFor(Math.min(e.scanDepth, 1000));
    };
    const hayFor = (r) => {
        let texts = null;
        if (r.hayKey === undefined) {
            texts = entryWindow(r.entry);
            r.span = texts === null ? -1 : texts.length;
            if (texts === null) r.hayKey = -1;
            else {
                let mask = 0;
                for (let i = 0; i < SOURCES.length; i++) if (r.entry[SOURCES[i][0]] && sourceTexts[i]) mask |= 1 << i;
                r.hayKey = r.span * 64 + mask;
            }
        }
        if (r.hayKey < 0) return emptyHay;
        let base = baseHays.get(r.hayKey);
        if (!base) {
            const parts = [windowPart(texts ?? entryWindow(r.entry))];
            for (let i = 0; i < SOURCES.length; i++) {
                if (!(r.hayKey & (1 << i))) continue;
                parts.push(sourceParts[i] ??= new Part(asText(sourceTexts[i])));
            }
            if (injectPart) parts.push(injectPart);
            baseHays.set(r.hayKey, base = new Hay(parts));
        }
        if (recursionPart === null) return base;
        let hay = passHays.get(r.hayKey);
        if (!hay) passHays.set(r.hayKey, hay = new PassHay(base, recursionPart));
        return hay;
    };

    // ---------------------------------------------------------- provenance

    const feeders = [];
    const fed = new Set();
    const messageHays = new Array(len).fill(null);
    // a seek remembers, per key and test, how far a walk has looked and what it found; each text answers each test once
    const seekOf = (key, cs, ww, feeds) => {
        let slot = 0;
        if (!key.regex) {
            const p = key.probe(cs);
            slot = (cs ? 4 : 1) + (!ww || (stMatching && p.space) ? 0 : stMatching ? 1 : 2);
        }
        if (feeds) slot += 7;
        const seeks = key.seeks ??= [];
        return seeks[slot] ??= { hit: -1, edge: feeds ? 0 : len };
    };
    // the newest message at or above floor that one key matches
    const newestMessage = (key, floor, cs, ww) => {
        const s = seekOf(key, cs, ww, false);
        if (s.hit >= 0) return s.hit >= floor ? s.hit : -1;
        for (let i = s.edge - 1; i >= floor; i--) {
            const hay = messageHays[i] ??= new Hay([new Part(asText(history[i]))], false);
            if (hay.test(key, cs, ww, stMatching)) return s.hit = i;
            s.edge = i;
        }
        return -1;
    };
    // the first feeder below limit whose placed content one key matches; feeders only grow and never change
    const firstFeeder = (key, limit, cs, ww) => {
        const s = seekOf(key, cs, ww, true);
        if (s.hit >= 0) return s.hit < limit ? s.hit : -1;
        for (let i = s.edge; i < limit; i++) {
            const f = feeders[i];
            if (f.placed && (f.hay ??= new Hay([new Part(asText(f.placed))], false)).test(key, cs, ww, stMatching)) return s.hit = i;
            s.edge = i + 1;
        }
        return -1;
    };
    const traceKeys = (r, primary, cs, ww) => {
        const e = r.entry;
        const keys = [];
        for (const k of primary) {
            const key = matcher.key(k);
            if (key !== null) keys.push(key);
        }
        if (!r.missed) {
            // the newest message any key matches is the newest of each key's own newest match
            const lo = r.span < 0 ? len : len - r.span;
            let newest = -1;
            for (const key of keys) {
                const hit = newestMessage(key, newest < lo ? lo : newest + 1, cs, ww);
                if (hit > newest) newest = hit;
            }
            if (newest >= lo) return { kind: 'chat', messageIndex: newest };
            for (let i = 0; i < SOURCES.length; i++) {
                if (!e[SOURCES[i][0]] || !sourceTexts[i]) continue;
                if (matcher.any(primary, matcher.hayOf(asText(sourceTexts[i])), cs, ww, stMatching)) return { kind: 'source', source: SOURCES[i][1] };
            }
            for (const item of injectTexts) {
                if (item?.text && matcher.any(primary, matcher.hayOf(asText(item.text)), cs, ww, stMatching)) return { kind: 'source', source: item.source };
            }
        }
        let first = feeders.length;
        for (const key of keys) {
            const hit = firstFeeder(key, first, cs, ww);
            if (hit >= 0) first = hit;
        }
        if (first < feeders.length) return { kind: 'recursion', feederWorld: feeders[first].world, feederUid: feeders[first].entry.uid };
        return { kind: 'match' };
    };

    // ---------------------------------------------------------- inclusion groups

    const activated = new Map();

    const groupScore = (r) => {
        const e = r.entry;
        const primary = expandKeys(e.key, expand);
        const secondary = expandKeys(e.keysecondary, expand);
        if (!primary.length) return 0;
        const hay = hayFor(r);
        const cs = e.caseSensitive ?? caseSensitive;
        const ww = e.matchWholeWords ?? matchWholeWords;
        const p = matcher.count(primary, hay, cs, ww, stMatching);
        if (!secondary.length) return p;
        const s = matcher.count(secondary, hay, cs, ww, stMatching);
        const logic = e.selectiveLogic ?? LOGIC.AND_ANY;
        if (logic === LOGIC.AND_ANY) return p + s;
        if (logic === LOGIC.AND_ALL) return s === secondary.length ? p + s : p;
        return p;
    };

    const applyGroups = (cands) => {
        const groups = Object.create(null);
        let any = false;
        for (const r of cands) {
            const names = r.groups ??= groupNames(r.entry);
            for (const n of names) {
                (groups[n] ??= []).push(r);
                any = true;
            }
        }
        if (!any) return cands;
        const alive = new Set(cands);
        const remove = (r) => {
            if (alive.delete(r)) suppress(r, 'group');
        };
        const names = Object.keys(groups);
        const stickyWon = new Set();
        for (const n of names) {
            const members = groups[n];
            if (members.some(isSticky)) {
                for (const r of members) if (!isSticky(r)) remove(r);
                stickyWon.add(n);
            }
            for (const r of members) if (isCooling(r)) remove(r);
            for (const r of members) if (isDelayed(r)) remove(r);
        }
        for (const n of names) {
            const members = groups[n];
            if (stickyWon.has(n)) continue;
            if (!useGroupScoring && !members.some(r => r.entry.useGroupScoring)) continue;
            const scored = members.map(r => ({ r, score: groupScore(r) }));
            let max = -Infinity;
            for (const { score } of scored) if (score > max) max = score;
            const kept = [];
            for (const { r, score } of scored) {
                if ((r.entry.useGroupScoring ?? useGroupScoring) && score < max) remove(r);
                else kept.push(r);
            }
            groups[n] = kept;
        }
        const activeGroups = new Set();
        for (const r of activated.values()) activeGroups.add(r.entry.group);
        for (const n of names) {
            if (stickyWon.has(n)) continue;
            const members = groups[n];
            if (activeGroups.has(n)) {
                for (const r of members) remove(r);
                continue;
            }
            if (members.length <= 1) continue;
            const overrides = members.filter(r => r.entry.groupOverride);
            if (overrides.length) {
                const top = overrides.sort(byOrderDesc)[0];
                for (const r of members) if (r !== top) remove(r);
                continue;
            }
            let total = 0;
            for (const r of members) total = total + (r.entry.groupWeight ?? 100);
            if (dryRun && total > 0) {
                for (const r of members) {
                    const w = r.entry.groupWeight ?? 100;
                    if (w > 0) r.odds = r.odds * (w / total);
                    else remove(r);
                }
                continue;
            }
            const roll = rng() * total;
            let sum = 0;
            let drawn = null;
            for (const r of members) {
                sum = sum + (r.entry.groupWeight ?? 100);
                if (roll <= sum) {
                    drawn = r;
                    break;
                }
            }
            if (drawn) for (const r of members) if (r !== drawn) remove(r);
        }
        return cands.filter(r => alive.has(r));
    };

    // ---------------------------------------------------------- the passes

    const heldLevels = new Set();
    for (const r of order) {
        const d = r.entry.delayUntilRecursion;
        if (d) heldLevels.add(d === true ? 1 : d);
    }
    const stages = Array.from(heldLevels).sort(ascending);
    let stageAt = 0;
    // the lowest level is taken before the first pass, so it earns no pass of its own
    let level = stageAt < stages.length ? stages[stageAt++] : 0;

    const failed = new Set();
    let baseText = '';
    let overflowed = false;
    let dropped = 0;
    let passes = 0;

    while (!(maxRecursionSteps && passes >= maxRecursionSteps)) {
        passes++;
        const initial = passes === 1;
        passHays = new Map();
        const stickyCands = [];
        const otherCands = [];
        for (const r of order) {
            if (failed.has(r) || activated.has(r.key)) continue;
            const e = r.entry;
            if (e.disable) continue;
            if (Array.isArray(e.triggers) && e.triggers.length && !e.triggers.includes(trigger)) {
                suppress(r, 'trigger');
                continue;
            }
            if (character) {
                const f = e.characterFilter;
                if (f?.names?.length) {
                    const included = f.names.includes(character.name);
                    if (f.isExclude ? included : !included) {
                        suppress(r, 'characterFilter');
                        continue;
                    }
                }
                if (f?.tags?.length) {
                    const tags = Array.isArray(character.tags) ? character.tags : [];
                    const has = tags.some(t => f.tags.includes(t));
                    if (f.isExclude ? has : !has) {
                        suppress(r, 'characterFilter');
                        continue;
                    }
                }
            }
            if (isDelayed(r)) {
                suppress(r, 'delay');
                continue;
            }
            const sticky = isSticky(r);
            if (!sticky && isCooling(r)) {
                suppress(r, 'cooldown');
                continue;
            }
            if (e.delayUntilRecursion && !sticky) {
                const own = e.delayUntilRecursion === true ? 1 : e.delayUntilRecursion;
                if (initial || own > level) {
                    suppress(r, 'delayUntilRecursion');
                    continue;
                }
            }
            if (!initial && recursive && e.excludeRecursion && !sticky) {
                suppress(r, 'excludeRecursion');
                continue;
            }
            const list = sticky ? stickyCands : otherCands;
            if (r.force > 0) {
                list.push(r);
                if (tracing) r.via = { kind: 'decorator' };
                continue;
            }
            if (r.force < 0) {
                suppress(r, 'decorator');
                continue;
            }
            if (e.constant) {
                list.push(r);
                if (tracing) r.via = { kind: 'constant' };
                continue;
            }
            if (sticky) {
                list.push(r);
                if (tracing) r.via = { kind: 'sticky' };
                continue;
            }
            if (e.vectorized) {
                suppress(r, 'vectorized');
                continue;
            }
            const primary = expandKeys(e.key, expand);
            if (!primary.length) continue;
            const hay = hayFor(r);
            const cs = e.caseSensitive ?? caseSensitive;
            const ww = e.matchWholeWords ?? matchWholeWords;
            if (!matcher.any(primary, hay, cs, ww, stMatching)) {
                if (initial) r.missed = true;
                continue;
            }
            const secondary = expandKeys(e.keysecondary, expand);
            if (e.selective && secondary.length && !matcher.passes(e.selectiveLogic, secondary, hay, cs, ww, stMatching)) continue;
            list.push(r);
            if (tracing) r.via = traceKeys(r, primary, cs, ww);
        }

        for (const r of otherCands) stickyCands.push(r);
        const cands = applyGroups(stickyCands);

        // the budget walk
        const base = budgetOn ? estimateTokens(baseText) : 0;
        let accumulated = '';
        let exempt = 0;
        for (const r of cands) if (r.entry.ignoreBudget) exempt++;
        for (const r of cands) {
            const e = r.entry;
            if (e.ignoreBudget) exempt--;
            if (overflowed && !e.ignoreBudget) {
                dropped++;
                suppress(r, 'budget');
                if (exempt > 0) continue;
                break;
            }
            if (e.useProbability && typeof e.probability === 'number' && e.probability !== 100 && !isSticky(r)) {
                if (dryRun) {
                    r.pending = e.probability;
                } else if (!(rng() * 100 <= e.probability)) {
                    failed.add(r);
                    suppress(r, 'probability');
                    continue;
                }
            }
            r.placed = expand ? expand(r.body) : r.body;
            accumulated += r.placed + '\n';
            if (budgetOn && !e.ignoreBudget && base + estimateTokens(accumulated) >= budgetTokens) {
                overflowed = true;
                dropped++;
                suppress(r, 'budget');
                continue;
            }
            activated.set(r.key, r);
        }

        const forRecursion = [];
        for (const r of cands) if (activated.has(r.key) && !r.entry.preventRecursion) forRecursion.push(r);
        if (!recursive || overflowed || !forRecursion.length) {
            if (stageAt >= stages.length) break;
            level = stages[stageAt++];
        }
        const joined = forRecursion.map(r => r.placed).join('\n');
        if (joined) {
            if (recursionPart === null) recursionPart = new Part(joined, true);
            else recursionPart.append(joined);
            for (const r of forRecursion) {
                if (fed.has(r)) continue;
                fed.add(r);
                feeders.push(r);
            }
            baseText = joined + '\n' + baseText;
        }
    }

    // ---------------------------------------------------------- the result

    const notes = [];
    if (dropped !== 0) notes.push(`${dropped} entr${dropped === 1 ? 'y' : 'ies'} dropped by the lore budget (${budgetTokens} tokens)`);

    for (const r of activated.values()) {
        for (const type of TIMED_TYPES) {
            const map = rows[type];
            if (!r.entry[type] || map[r.key]) continue;
            map[r.key] = { hash: hashOf(r), start: chatLength, end: chatLength + Number(r.entry[type]), protected: false };
        }
    }

    const before = [], after = [], emBefore = [], emAfter = [], anTop = [], anBottom = [], outlets = [];
    const depthGroups = [];
    const depthIndex = new Map();
    const nameless = [];
    // a Map compares keys as the codes are written, so a string '1' finds no group and -0 finds the 0 one
    const fronts = new Map([
        [POSITION.before, before], [POSITION.after, after], [POSITION.ANTop, anTop],
        [POSITION.ANBottom, anBottom], [POSITION.EMTop, emBefore], [POSITION.EMBottom, emAfter],
    ]);
    for (const r of [...activated.values()].sort(byOrderDesc)) {
        const content = r.placed;
        if (!content || !asText(content).trim()) continue;
        const e = r.entry;
        const item = { world: r.world, entry: e, content, order: e.order ?? 0, position: e.position ?? 0 };
        if (r.pending != null) item.probabilityPending = r.pending;
        if (r.odds < 1) item.groupPending = Math.round(r.odds * 1000) / 10;
        if (r.via) item.firedVia = r.via;
        const front = fronts.get(item.position);
        if (front) {
            front.push(item);
        } else if (item.position === POSITION.atDepth) {
            const depth = Number.isInteger(e.depth) ? Math.max(e.depth, 0) : 4;
            const role = ROLE_NAMES[e.role ?? 0] ?? 'system';
            const id = `${depth}|${role}`;
            let g = depthIndex.get(id);
            if (!g) {
                depthIndex.set(id, g = { depth, role, items: [] });
                depthGroups.push(g);
            }
            g.items.push(item);
        } else if (item.position === POSITION.outlet) {
            if (typeof e.outletName === 'string' && e.outletName) outlets.push({ ...item, outlet: e.outletName });
            else nameless.push(e.comment || ('#' + e.uid));
        }
    }
    // each group took its items at the front, so the lowest order ends first
    for (const g of [before, after, emBefore, emAfter, anTop, anBottom]) g.reverse();
    const atDepth = [];
    for (const g of depthGroups) {
        for (let i = g.items.length - 1; i >= 0; i--) atDepth.push({ ...g.items[i], depth: g.depth, role: g.role });
    }
    if (nameless.length) {
        const n = nameless.length;
        notes.push(`${n} entr${n === 1 ? 'y names' : 'ies name'} no outlet at the outlet position, so nothing places ${n === 1 ? 'it' : 'them'}: ${nameless.join(', ')}`);
    }

    const activatedOut = [];
    for (const r of activated.values()) {
        const a = { world: r.world, uid: r.entry.uid };
        if (r.via) a.firedVia = r.via;
        activatedOut.push(a);
    }

    return {
        before, after, atDepth, emBefore, emAfter, anTop, anBottom, outlets, notes,
        timedState: { sticky: rows.sticky, cooldown: rows.cooldown },
        activated: activatedOut,
        suppressed,
    };
}
