// Inspired by Pathweaver for SillyTavern by mattjaybe (MIT); thanks to its author.

// How Next Beat reads a model's answer: a JSON object a suggestion, whole or streamed, and plain text when a model wrote none.

const HEADLINE_MAX = 60;
// a headline a model left out is the beat's opening words
const HEADLINE_WORDS = 6;
const NOTE_MAX = 600;
const SAID_MAX = 600;

const THINK_TAGS = 'think|thinking|thought|reasoning|reflection|scratchpad';
const THOUGHT_BLOCK = new RegExp(`<(${THINK_TAGS})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`, 'gi');
const LONE_CLOSE = new RegExp(`</(?:${THINK_TAGS})\\s*>`, 'gi');
const STILL_OPEN = new RegExp(`<(?:${THINK_TAGS})\\b[^>]*>`, 'i');

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const EMOJI_LIKE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/** The answer without its thinking: each whole block, all before a closing tag whose opener a template ate, all after an open one. */
export function withoutThinking(raw) {
    let text = String(raw ?? '').replace(/\r\n?/g, '\n').replace(THOUGHT_BLOCK, '');
    let tail = -1;
    for (const m of text.matchAll(LONE_CLOSE)) tail = m.index + m[0].length;
    if (tail >= 0) text = text.slice(tail);
    const open = text.match(STILL_OPEN);
    return open ? text.slice(0, open.index) : text;
}

// ======================================== the JSON reading

// each closed top-level {...} in order; a line opening with { starts afresh, so a wrapper or a stray brace loses nothing
function closedObjects(text) {
    const found = [];
    let depth = 0, from = -1, inString = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') inString = false;
            else if (c === '\n' && /^\s*\{/.test(text.slice(i + 1, i + 200))) { inString = false; depth = 0; }
            continue;
        }
        if (c === '\n' && depth > 0 && /^\s*\{/.test(text.slice(i + 1, i + 200))) depth = 0;
        else if (c === '"' && depth > 0) inString = true;
        else if (c === '{') { if (depth === 0) from = i; depth++; }
        else if (c === '}' && depth > 0) { depth--; if (depth === 0) found.push(text.slice(from, i + 1)); }
    }
    return found;
}

const unescaped = (s) => { try { return JSON.parse(`"${s}"`); } catch { return s.replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\'); } };

// an object JSON refuses (a quote left bare inside a beat, a trailing comma): each "key": "value" read up to the next key
function looseObject(src) {
    const body = src.replace(/,?\s*\}\s*$/, '');
    const keys = [...body.matchAll(/(?:^\{|,)\s*"(\w+)"\s*:\s*"/g)];
    const out = {};
    keys.forEach((m, i) => {
        const start = m.index + m[0].length;
        const span = body.slice(start, i + 1 < keys.length ? keys[i + 1].index : body.length);
        const end = span.lastIndexOf('"');
        if (end >= 0) out[m[1]] = unescaped(span.slice(0, end));
    });
    return out;
}

const textOf = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const firstText = (obj, keys) => keys.map(k => textOf(obj[k])).find(t => t.trim()) || '';

// braces as an object: JSON, else read loosely; null when they hold no keyed value (a macro in prose, say)
function objectOf(src) {
    try {
        const v = JSON.parse(src);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch { /* read loosely below */ }
    const loose = looseObject(src);
    return Object.keys(loose).length ? loose : null;
}

// what an object holds: one suggestion, or the suggestions a model wrapped in a list of its own
function suggestionsIn(obj) {
    const one = suggestionFrom({
        title: firstText(obj, ['title', 'headline', 'name']),
        beat: firstText(obj, ['beat', 'description', 'text', 'body', 'summary']),
        emoji: firstText(obj, ['emoji', 'icon']),
    });
    if (one) return [one];
    const list = Object.values(obj).find(v => Array.isArray(v) && v.some(x => x && typeof x === 'object'));
    return list ? list.filter(x => x && typeof x === 'object' && !Array.isArray(x)).flatMap(suggestionsIn) : [];
}

// ======================================== a suggestion's parts

const plainText = (s) => s.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim().replace(/^["'“‘]+(.*?)["'”’]+$/, '$1').trim();

const clip = (s, max) => {
    if (s.length <= max) return s;
    const room = s.slice(0, max - 3);
    const space = room.lastIndexOf(' ');
    return `${(space > max / 2 ? room.slice(0, space) : room).replace(/[\s,;:.]+$/, '')}...`;
};

// the beat's opening words, when the model gave no headline or a headline that was a whole beat
function headlineFrom(beat) {
    const words = beat.split(' ');
    const lead = words.slice(0, HEADLINE_WORDS).join(' ').replace(/[\s,;:.!?]+$/, '');
    return words.length > HEADLINE_WORDS ? `${lead}...` : lead;
}

/** A single emoji: the first grapheme of the text when it is one, else empty. */
export function emojiOf(text) {
    const first = graphemes.segment(String(text ?? '').trim())[Symbol.iterator]().next().value?.segment || '';
    return EMOJI_LIKE.test(first) ? first : '';
}

function suggestionFrom({ title, beat, emoji }) {
    let head = plainText(title).replace(/[\s:.]+$/, '');
    let body = plainText(beat);
    if (head.length > HEADLINE_MAX && !body) [body, head] = [plainText(title), ''];
    if (!head && body) head = headlineFrom(body);
    head = clip(head, HEADLINE_MAX);
    if (!/[\p{L}\p{N}]/u.test(head)) return null;
    return { emoji: emojiOf(emoji), title: head, description: body };
}

// ======================================== a model that wrote no JSON

// a line that opens an item of its own: a number, a bullet, a heading, a quote mark or an emoji
const MARKED = /^(?:\d{1,2}[.):]\s|[-*•]\s|#{1,6}\s|>\s)/;
const RULE_LINE = /^(?:([-*_=])\1{2,}|[\u2013\u2014]{2,})$/;

function leadOf(line) {
    let s = line.replace(/^>\s*/, '').replace(/^#{1,6}\s*/, '').replace(/^(?:\d{1,2}[.):]|[-*•])\s+/, '').replace(/\*\*|__/g, '').trim();
    const bare = s.replace(/^[[(]\s*/, '');
    const emoji = emojiOf(bare);
    if (emoji) s = bare.slice(emoji.length).replace(/^\s*[\])]?\s*/, '');
    return { emoji, text: s.replace(/^title\s*[:-]\s*/i, '').trim() };
}

// a lead that carries its own beat after a dash or a colon
function splitLead(text) {
    const at = [' - ', ' \u2013 ', ' \u2014 ', ': '].map(sep => [text.indexOf(sep), sep]).filter(([i]) => i > 1 && i <= 80).sort((a, b) => a[0] - b[0])[0];
    return at ? [text.slice(0, at[0]), text.slice(at[0] + at[1].length)] : [text, ''];
}

function readProse(text) {
    const items = [];
    let cur = null;
    const close = () => { if (cur?.lines.length) items.push(cur); cur = null; };
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (/^```/.test(line)) continue;
        if (!line || RULE_LINE.test(line)) { close(); continue; }
        const marked = MARKED.test(line) || !!emojiOf(line.replace(/^[[(]\s*/, ''));
        if (marked && cur?.lines.length) close();
        if (!cur) cur = { marked, lines: [] };
        cur.lines.push(line);
    }
    close();
    // a preamble or a sign-off carries no mark when the items around it do
    const kept = items.some(it => it.marked) ? items.filter(it => it.marked) : items;
    return kept.map(({ lines }) => {
        const lead = leadOf(lines[0]);
        const rest = lines.slice(1).map(l => l.replace(/\*\*|__/g, '').replace(/^description\s*[:-]\s*/i, '')).join(' ');
        const [title, inline] = rest ? [lead.text, ''] : splitLead(lead.text);
        const beat = rest || inline;
        return beat ? suggestionFrom({ title, beat, emoji: lead.emoji }) : null;
    }).filter(Boolean);
}

// ======================================== whole answers and streamed ones

// the JSON objects an answer holds, each read for its suggestions
const objectsIn = (text) => closedObjects(text).map(objectOf).filter(Boolean);

/** A whole answer's suggestions, at most max: its JSON objects, else, when it holds none, its plain text item by item. */
export function parseSuggestions(raw, { max = Infinity } = {}) {
    const text = withoutThinking(raw);
    const objects = objectsIn(text);
    return (objects.length ? objects.flatMap(suggestionsIn) : readProse(text)).slice(0, max);
}

/** A streamed answer read as it lands: push answers each object its brace just closed, end whatever the whole answer adds. */
export function suggestionStream({ max = Infinity } = {}) {
    let buf = '';
    let handed = 0;
    let ended = false;
    const handOn = (list) => {
        const fresh = list.slice(handed, max);
        handed += fresh.length;
        return fresh;
    };
    return {
        push(delta) {
            if (ended || handed >= max) return [];
            buf += String(delta ?? '');
            return handOn(objectsIn(withoutThinking(buf)).flatMap(suggestionsIn));
        },
        end() {
            if (ended) return [];
            ended = true;
            return handOn(parseSuggestions(buf, { max }));
        },
        get full() { return handed >= max; },
        get text() { return buf; },
    };
}

/** An answer no suggestion was read from: how it finished, what it wrote with its thinking out, whether it only thought. */
export function unreadOf({ content, thought, finishReason }) {
    const said = [...withoutThinking(content).trim()].slice(0, SAID_MAX).join('');
    return { finishReason: finishReason ?? null, said, thoughtOnly: !said && (!!thought || !!String(content ?? '').trim()) };
}

/** The surprise's note as the narrator is told it: thinking, a fence, a label and wrapping brackets taken off. */
export function noteFrom(raw) {
    let out = withoutThinking(raw).replace(/^\s*```[^\n]*\n/, '').replace(/\n```\s*$/, '').trim();
    out = out.replace(/^\[\s*(?:system\s+note|note|narrator'?s?\s+note)\s*:\s*([\s\S]*?)\s*\]$/i, '$1');
    out = out.replace(/^(?:system\s+note|note|instruction|surprise|event)\s*:\s*/i, '');
    return clip(plainText(out), NOTE_MAX);
}
