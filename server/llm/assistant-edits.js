import { anchorOf, loreKey, keyList, BLOCK_NAME, EDIT_FIELDS, editFieldKeys, CHAT_OWN_KEYS, changeLabel } from './assistant.js';
import { cardNotePlacement } from './preset.js';
import { finishFirstMessage, chatOwnTexts } from './prompt.js';
import { chatNoteOf, noteDefaults, NOTE_KEYS } from './authors-note.js';
import { cardText } from './macros.js';
import { getCharacter } from '../db/characters-store.js';
import { getPersona, updatePersona } from '../db/personas-store.js';
import { patchAfterSnapshot } from '../importer/card-import.js';
import { ASSISTANT_BACKUP } from '../db/versions-store.js';
import { getWorldEntry, upsertWorld, upsertWorldEntry, createWorldEntry, deleteWorldEntry } from '../db/worlds-store.js';
import { patchChatMessage, deleteChatMessage, readMessageRow, getChatRow, messageSeqOf, patchChat, chatMetadataOf } from '../db/chats-store.js';
import { applyWorldsFor, worldExists } from '../db/world-links-store.js';

// Proposed edits: parse, judge, apply in a safe order. server-side because the anchor can only be checked where the row is read

const FENCE = /^[ \t]*(?:```|~~~)([A-Za-z0-9-]*)[ \t]*$/;

const BLOCK_ENGINE = Object.fromEntries(Object.entries(BLOCK_NAME).map(([engine, fence]) => [fence, engine]));

const LORE_OPS = new Set(['create', 'update', 'delete']);
const CHAT_OPS = new Set(['edit', 'replace', 'hide', 'delete']);
// the card engine (the studio's draft): no delete op, an empty set clears and a delete would renumber greetings
const CARD_OPS = new Set(['set', 'replace', 'tags', 'greeting']);
export const CARD_FIELDS = ['name', 'tagline', 'description', 'personality', 'scenario', 'first_mes',
    'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes'];
// the field engines: card, this chat's notes, the persona; set and replace on a named field, the card adding tags and greetings
const FIELD_ENGINES = new Set(Object.keys(EDIT_FIELDS));
/** Whether an engine writes a named field (the card, this chat's notes, the persona) rather than lore or a message. */
export const isFieldEngine = (engine) => FIELD_ENGINES.has(engine);
const FIELD_OPS = new Set(['set', 'replace']);
/** What a reply may propose when its surface names nothing: the lore, the messages, and the studio's card. */
const DEFAULT_PROPOSALS = Object.freeze({ lore: true, chat: true, card: CARD_FIELDS });
const isInt = v => Number.isInteger(v);
const isStr = v => typeof v === 'string';
const isBool = v => typeof v === 'boolean';
const isStrList = v => Array.isArray(v) && v.every(isStr);
const isAnchor = v => isStr(v) && /^[0-9a-f]{8}$/i.test(v);
const entryTitle = e => String(e?.comment || '');

// what an update may touch, ONE table so the card's "after" and the written bytes normalize alike
const LORE_SET = {
    content: { field: 'content', check: v => (isStr(v) ? null : 'a string'), live: e => String(e.content || ''), next: v => String(v) },
    comment: { field: 'comment', check: v => (isStr(v) ? null : 'a string'), live: entryTitle, next: v => String(v) },
    keys: { field: 'key', check: v => (isStr(v) || isStrList(v) ? null : 'a list of strings'), live: e => keyList(e.key), next: v => keyList(v) },
    secondaryKeys: { field: 'keysecondary', check: v => (isStr(v) || isStrList(v) ? null : 'a list of strings'), live: e => keyList(e.keysecondary), next: v => keyList(v) },
    order: { field: 'order', check: v => (isInt(v) ? null : 'an integer'), live: e => (isInt(e.order) ? e.order : null), next: v => v },
    position: { field: 'position', check: v => (isInt(v) ? null : 'an integer'), live: e => (isInt(e.position) ? e.position : null), next: v => v },
    depth: { field: 'depth', check: v => (isInt(v) ? null : 'an integer'), live: e => (isInt(e.depth) ? e.depth : null), next: v => v },
    disable: { field: 'disable', check: v => (isBool(v) ? null : 'true or false'), live: e => e.disable === true, next: v => v },
    constant: { field: 'constant', check: v => (isBool(v) ? null : 'true or false'), live: e => e.constant === true, next: v => v },
};
const LORE_SETTABLE = new Set(Object.keys(LORE_SET));
/** The settable fields other than content, in the order the card lists them; the client's label table is checked against it. */
export const LORE_FIELDS = Object.keys(LORE_SET).filter(k => k !== 'content');

/** The entry patch an update's set becomes, in the entry's own field names. */
function lorePatchFrom(set) {
    const patch = {};
    for (const [k, spec] of Object.entries(LORE_SET)) if (set && k in set) patch[spec.field] = spec.next(set[k]);
    // ST gates secondary keys behind `selective`; setting them without it is a silent no-op
    // that reads as the logic option doing nothing.
    if ('keysecondary' in patch) patch.selective = patch.keysecondary.length > 0;
    return patch;
}

/** The non-content fields an update moves, live value and written value, through the write's own table. */
function fieldChanges(entry, set) {
    const patch = lorePatchFrom(set);
    const out = [];
    for (const [k, spec] of Object.entries(LORE_SET)) {
        if (k === 'content' || !(spec.field in patch)) continue;
        const before = spec.live(entry);
        const after = patch[spec.field];
        if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ key: k, before, after });
    }
    return out;
}

// a trailing comma is the one repair that cant change meaning; the error names unclosed braces, not a byte position
function unbalancedReport(text) {
    let inString = false;
    const n = { '{': 0, '}': 0, '[': 0, ']': 0 };
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (ch === '\\') i++;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch in n) n[ch]++;
    }
    const parts = [];
    if (inString) parts.push('a string is never closed (an unescaped quote inside a value?)');
    if (n['{'] !== n['}']) parts.push(`${n['{']} "{" against ${n['}']} "}"${n['{'] > n['}'] ? ', an object is not closed' : ', a "}" closes nothing'}`);
    if (n['['] !== n[']']) parts.push(`${n['[']} "[" against ${n[']']} "]"`);
    return parts.length ? `; ${parts.join('; ')}` : '';
}

// two unambiguous misplacements are read as meant; a value of the wrong shape is still refused
function normalizePlacement(engine, raw) {
    if (engine !== 'lore' || !raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const c = { ...raw };
    const set = c.set && typeof c.set === 'object' && !Array.isArray(c.set) ? { ...c.set } : null;
    if (set && 'why' in set) {
        if (!isStr(c.why)) c.why = set.why;
        delete set.why;
        c.set = set;
    }
    if (c.op === 'update') {
        const folded = set || {};
        for (const k of LORE_SETTABLE) {
            if (k in c && !(k in folded)) { folded[k] = c[k]; delete c[k]; }
        }
        if (set || Object.keys(folded).length) c.set = folded;
    }
    return c;
}

// a change object left unclosed: `{` after a comma in an object, or `]` with one open, can only mean that
function closeUnclosedObjects(text) {
    let out = '';
    let inString = false;
    const stack = [];
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            out += ch;
            if (ch === '\\') { out += text[i + 1] ?? ''; i++; }
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; out += ch; continue; }
        if (ch === '{' || ch === '[') { stack.push(ch); out += ch; continue; }
        if (ch === ']') {
            while (stack[stack.length - 1] === '{') { out += '}'; stack.pop(); }
            stack.pop(); out += ch; continue;
        }
        if (ch === '}') { stack.pop(); out += ch; continue; }
        if (ch === ',' && stack[stack.length - 1] === '{') {
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j])) j++;
            if (text[j] === '{') { while (stack[stack.length - 1] === '{') { out += '}'; stack.pop(); } }
        }
        out += ch;
    }
    return out;
}

function stripTrailingCommas(text) {
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            out += ch;
            if (ch === '\\') { out += text[i + 1] ?? ''; i++; }
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; out += ch; continue; }
        if (ch === ',') {
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j])) j++;
            if (text[j] === '}' || text[j] === ']') continue;
        }
        out += ch;
    }
    return out;
}

/**
 * Parse a reply's fenced edit blocks: an unclosed last fence parses, bad JSON refuses the block, an engine the surface lacks is skipped.
 * @param {object} [surface] engine -> its writable field keys (true for lore and chat)
 * @returns {{proposals: Array, errors: Array<{engine, message}>, blocks: Array<{engine, from: number, to: number, ids: string[]}>}} blocks: each parsed block's lines [from, to) and the ids it holds
 */
export function parseProposals(text, surface = DEFAULT_PROPOSALS) {
    const lines = String(text ?? '').split(/\r?\n/);
    const proposals = [];
    const errors = [];
    const blocks = [];
    // a twin's signature names the change it repeats, so its block still says which change it holds
    const seen = new Map();
    let i = 0;
    let n = 0;

    while (i < lines.length) {
        const open = lines[i].match(FENCE);
        const engine = open && BLOCK_ENGINE[open[1]];
        if (!engine || !surface[engine]) { i++; continue; }
        const from = i;
        const bodyLines = [];
        i++;
        while (i < lines.length && !FENCE.test(lines[i])) { bodyLines.push(lines[i]); i++; }
        i++; // step past the closing fence, or past the end when there was not one

        let parsed;
        const body = bodyLines.join('\n');
        try {
            parsed = JSON.parse(body);
        } catch (strictErr) {
            try {
                parsed = JSON.parse(stripTrailingCommas(body));
            } catch {
                try {
                    parsed = JSON.parse(stripTrailingCommas(closeUnclosedObjects(body)));
                } catch {
                    // The refused body is otherwise gone, and "position 3489" alone is
                    // undiagnosable after the fact.
                    console.warn(`[assistant] refused ${engine} block (${strictErr.message}):\n${body.slice(0, 2000)}`);
                    errors.push({ engine, message: `the ${engine} block was not valid JSON (${strictErr.message}${unbalancedReport(body)})` });
                    continue;
                }
            }
        }
        const changes = Array.isArray(parsed?.changes) ? parsed.changes : null;
        if (!changes) {
            errors.push({ engine, message: `the ${engine} block carried no changes array` });
            continue;
        }
        const blockStart = proposals.length;
        const twins = [];
        for (const rawChange of changes) {
            const raw = normalizePlacement(engine, rawChange);
            // Models emit byte-identical twins of one change often enough that the review
            // card was counting the same edit twice; one card is the honest count.
            const sig = `${engine}:${JSON.stringify(raw)}`;
            if (seen.has(sig)) { twins.push(seen.get(sig)); continue; }
            const id = `${engine}:${n++}`;
            seen.set(sig, id);
            const invalid = validate(engine, raw, surface[engine]);
            proposals.push({
                id,
                engine,
                op: isStr(raw?.op) ? raw.op : '(missing)',
                why: isStr(raw?.why) ? raw.why : '',
                change: raw && typeof raw === 'object' ? raw : {},
                ...(invalid ? { invalid } : {}),
            });
        }
        if (FIELD_ENGINES.has(engine)) coalesceCardSets(proposals, blockStart);
        blocks.push({ engine, from, to: Math.min(i, lines.length), ids: [...new Set([...proposals.slice(blockStart).map(p => p.id), ...twins])] });
    }
    return { proposals, errors, blocks };
}

/** Several sets on one field in one block fold into the first, in order, marked `merged`. */
function coalesceCardSets(proposals, from) {
    const firstByField = new Map();
    for (let i = from; i < proposals.length; i++) {
        const p = proposals[i];
        if (p.invalid || p.change?.op !== 'set' || !isStr(p.change?.field)) continue;
        const first = firstByField.get(p.change.field);
        if (!first) { firstByField.set(p.change.field, p); continue; }
        const piece = String(p.change.content ?? '').trim();
        if (piece) first.change.content = `${String(first.change.content ?? '').trim()}\n\n${piece}`;
        first.merged = (first.merged || 1) + 1;
        proposals.splice(i, 1);
        i--;
    }
}

/**
 * A reply as the model reads it back once a later reply exists: each block keeps its applied changes, the rest named in one line.
 * @param {object} extra the stored reply's extra (its proposals and applied records)
 * @param {object} [surface] the surface it was parsed under
 * @param {{who?: string, where?: string}} [words] who applies a change, and what it reaches
 * @returns {string} the text unchanged when nothing is unapplied, or when a reparse disagrees with the stored ids
 */
export function withheldContent(text, extra, surface = DEFAULT_PROPOSALS, { who = 'reader', where = 'the lorebook or the story' } = {}) {
    const stored = extra?.proposals || [];
    const landed = (id) => extra?.applied?.[id]?.status === 'applied';
    if (!stored.length || stored.every(p => landed(p.id))) return text;
    const { proposals, blocks } = parseProposals(text, surface);
    // the stored ids are what the cards and the app note name; a text that parses otherwise is left whole
    if (proposals.length !== stored.length || proposals.some((p, i) => p.id !== stored[i].id || p.op !== stored[i].op)) return text;
    const at = new Map(stored.map((p, i) => [p.id, i]));
    const lines = String(text).split(/\r?\n/);
    const out = [];
    let from = 0;
    for (const b of blocks) {
        if (b.ids.every(landed)) continue;
        out.push(...lines.slice(from, b.from));
        const kept = b.ids.filter(landed).map(id => stored[at.get(id)].change);
        if (kept.length) out.push(`\`\`\`${BLOCK_NAME[b.engine]}`, JSON.stringify({ changes: kept }), '```');
        const held = b.ids.filter(id => !landed(id)).map(id => changeLabel(stored[at.get(id)], at.get(id)));
        const one = held.length === 1;
        out.push(`[Left out here: ${held.join(', ')}. The ${who} has not applied ${one ? 'it' : 'them'}, so ${one ? 'it' : 'they'} never reached ${where}.]`);
        from = b.to;
    }
    out.push(...lines.slice(from));
    return out.join('\n');
}

/** Shape check only. Whether it is SAFE is a separate question, answered by checkProposal. */
function validate(engine, c, fields) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return 'not an object';
    const op = c.op;
    if (!isStr(op)) return 'no op';

    if (engine === 'lore') {
        if (!LORE_OPS.has(op)) return `unknown lore op "${op}"`;
        if (!isStr(c.world) || !c.world.trim()) return 'no world named';
        if (op === 'create') return isStr(c.content) && c.content.trim() ? null : 'create needs content';
        if (!isInt(c.uid) && !(isStr(c.entry) && c.entry.trim())) return `${op} needs the entry's title (or its number)`;
        if (op === 'delete') return null;
        const set = c.set;
        if (!set || typeof set !== 'object' || Array.isArray(set)) return 'update needs a set object';
        const keys = Object.keys(set);
        if (!keys.length) return 'update sets nothing';
        const bad = keys.filter(k => !LORE_SETTABLE.has(k));
        if (bad.length) return `update cannot set ${bad.join(', ')}`;
        // wrong shape is refused, never coerced: String(null) would title an entry "null"
        for (const k of keys) {
            const why = LORE_SET[k].check(set[k]);
            if (why) return `${k} must be ${why}`;
        }
        return null;
    }

    if (FIELD_ENGINES.has(engine)) {
        if (!(engine === 'card' ? CARD_OPS : FIELD_OPS).has(op)) return `unknown ${engine} op "${op}"`;
        if (op === 'tags') {
            const add = c.add ?? [];
            const remove = c.remove ?? [];
            if (!isStrList(add) || !isStrList(remove)) return 'tags needs add and remove as lists of strings';
            if (!add.some(t => t.trim()) && !remove.some(t => t.trim())) return 'tags names nothing to add or remove';
            return null;
        }
        if (op === 'greeting') {
            if (!(isInt(c.index) && c.index >= 1) && c.index !== 'new') return 'greeting needs its number (from 1) or "new"';
            return isStr(c.content) ? null : 'greeting needs content';
        }
        if (!isStr(c.field) || !fields.includes(c.field)) return `${op} needs a field, one of ${fields.join(', ')}`;
        if (op === 'set') return isStr(c.content) ? null : 'set needs content';
        if (!isStr(c.find) || !c.find) return 'replace needs find text';
        if (!isStr(c.with)) return 'replace needs replacement text';
        return null;
    }

    if (!CHAT_OPS.has(op)) return `unknown chat op "${op}"`;
    if (!isInt(c.seq) || c.seq < 0) return `${op} needs a message number`;
    if (op === 'edit') return isStr(c.text) ? null : 'edit needs text';
    if (op === 'replace') {
        if (!isStr(c.find) || !c.find) return 'replace needs find text';
        if (!isStr(c.with)) return 'replace needs replacement text';
        return null;
    }
    if (op === 'hide') return typeof c.hidden === 'boolean' ? null : 'hide needs hidden true or false';
    return null;
}

// ========================================
// IS THIS STILL SAFE TO APPLY?
// ========================================

// one row, never the composed book: the judge reads one per proposal on every proposals GET
const loreEntry = (db, world, uid) => getWorldEntry(db, world, uid);

const chatRow = readMessageRow;

// where a shown message sits now, by the id the snapshot recorded, since a delete renumbers seqs
function liveSeqOf(db, chatId, snapshot, shown) {
    const id = snapshot?.ids?.[shown];
    return Number.isInteger(id) ? messageSeqOf(db, chatId, id) : null;
}

const UNRECORDED = 'what the assistant read here is not on record; ask it again';

const selfKeyChat = (seq) => `chat:${seq}`;
const selfKeyLore = (world, uid) => `lore:${world}::${uid}`;
/** A field engine's self key; the card's keeps its plain `card:` form, which stored studio records carry. */
export const selfKeyCard = (target, engine = 'card') => `${engine}:${target}`;

/** The self map from a stored applied record, so every judge sees the same history. */
export function selfAnchorsFromApplied(applied) {
    const self = {};
    for (const rec of Object.values(applied || {})) {
        const r = rec?.result;
        if (!r?.newAnchor) continue;
        const key = 'seq' in r ? selfKeyChat(r.seq) : 'target' in r ? selfKeyCard(r.target, r.engine) : selfKeyLore(r.world, r.uid);
        (self[key] = self[key] || []).push(r.newAnchor);
    }
    return self;
}

/** The self map over LATER replies' applied records, so an earlier proposal on that key is superseded. */
function laterAnchorsFromApplied(appliedMaps) {
    const later = {};
    for (const applied of appliedMaps || []) {
        for (const [key, anchors] of Object.entries(selfAnchorsFromApplied(applied))) {
            later[key] = [...(later[key] || []), ...anchors];
        }
    }
    return later;
}

/** The later map for the reply at `seq` of a session transcript: every assistant reply after it. */
export function laterAnchorsForReply(messages, seq) {
    return laterAnchorsFromApplied((messages || []).slice(seq + 1).filter(m => m?.role === 'assistant').map(m => m.extra?.applied || {}));
}

// split on the LAST `::<digits>`, since a world name may itself contain "::"
function splitLoreKey(key) {
    const m = /^(.*)::(\d+)$/.exec(String(key));
    return m ? { world: m[1], uid: Number(m[2]) } : null;
}

/**
 * Resolve an entry named by TITLE off the snapshot's title map, so a rename since cant move the target.
 * @returns {{uid: number}|{error: string}}
 */
function resolveLoreTitle(snapshot, world, title) {
    const titles = snapshot?.loreTitles || {};
    const want = String(title).trim().toLowerCase();
    const inBook = [];
    const elsewhere = [];
    const shownHere = [];
    for (const [key, t] of Object.entries(titles)) {
        const k = splitLoreKey(key);
        if (!k) continue;
        if (k.world === world && t) shownHere.push(t);
        if (String(t || '').trim().toLowerCase() !== want) continue;
        if (k.world === world) inBook.push(k.uid); else elsewhere.push(`"${k.world}" #${k.uid}`);
    }
    if (inBook.length === 1) return { uid: inBook[0] };
    if (inBook.length > 1) return { error: `"${title}" names ${inBook.length} entries in "${world}" (#${inBook.join(', #')}); use the number` };
    if (elsewhere.length) return { error: `no entry titled "${title}" was shown in "${world}"; that title was shown in ${elsewhere.join(', ')}` };
    return { error: `no entry titled "${title}" was shown in "${world}"${shownHere.length ? `; the titles shown there: ${shownHere.map(t => `"${t}"`).join(', ')}` : ''}` };
}

// models re-quote loosely, so the find matches a folded copy but the exact live span is replaced
const FOLD = {
    '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'", '\u2032': "'",
    '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u2033': '"',
    '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
    '\u2026': '...', '\u00A0': ' ',
};
// with `tags`, markup reads as a space: a model quoting a `<font>` line drops the tags
const TAG_AT = /^<\/?[A-Za-z][^<>]*>/;
function normalizedText(text, { tags = false } = {}) {
    const norm = [];
    const map = [];
    let inSpace = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        let tag = 0;
        if (tags && ch === '<') tag = (TAG_AT.exec(text.slice(i, i + 200)) || [''])[0].length;
        if (tag || /\s/.test(ch) || ch === '\u00A0') {
            if (!inSpace) { norm.push(' '); map.push(i); inSpace = true; }
            if (tag) i += tag - 1;
            continue;
        }
        inSpace = false;
        for (const fc of (FOLD[ch] ?? ch)) { norm.push(fc); map.push(i); }
    }
    return { norm: norm.join(''), map };
}

/** Occurrences of the normalised `F` in `L`: { hits, start, end } as live offsets on one hit. */
function foldedSpan(L, F) {
    if (!F) return { hits: 0 };
    let hits = 0;
    let at = -1;
    for (let i = L.norm.indexOf(F); i !== -1; i = L.norm.indexOf(F, i + F.length)) { hits++; if (at < 0) at = i; }
    if (hits !== 1) return { hits };
    return { hits: 1, start: L.map[at], end: L.map[at + F.length - 1] + 1 };
}

// a quote from memory is a word or two off: placed by word-level LCS, both sides keeping this share, one window only
const FUZZY_BAR = 0.8;

/** The words of a normalised text with their offsets in `norm`. */
function wordsOf(norm) {
    const out = [];
    const re = /\S+/g;
    for (let m = re.exec(norm); m; m = re.exec(norm)) out.push({ w: m[0], start: m.index, end: m.index + m[0].length });
    return out;
}

/** LCS of two word lists with the matched positions in `b`, so the span can be bounded. */
function lcsMatch(a, b) {
    const m = a.length, n = b.length;
    const dp = new Uint16Array((m + 1) * (n + 1));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i * (n + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (n + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
        }
    }
    let i = 0, j = 0, first = -1, last = -1, count = 0, headHit = false, tailHit = false;
    while (i < m && j < n) {
        if (a[i] === b[j]) {
            if (first < 0) first = j;
            last = j; count++;
            if (i === 0) headHit = true;
            if (i === m - 1) tailHit = true;
            i++; j++;
        } else if (dp[(i + 1) * (n + 1) + j] >= dp[i * (n + 1) + j + 1]) i++;
        else j++;
    }
    // the find's first and last words are the span's edges, or a wrong edge word gets re-added
    return { count, first, last, ends: headHit && tailHit };
}

/** The one window of `L` that the find's words fit, or how many did: { hits, start, end }. */
function fuzzySpan(L, F) {
    const fw = wordsOf(F).map(x => x.w);
    const lw = wordsOf(L.norm);
    if (fw.length < 2 || !lw.length) return { hits: 0 };
    const W = fw.length + Math.ceil(fw.length / 4);
    const need = Math.ceil(fw.length * FUZZY_BAR);
    const freq = new Map();
    for (const w of fw) freq.set(w, (freq.get(w) || 0) + 1);
    const spans = new Map();
    for (let i = 0; i < lw.length; i++) {
        // the multiset overlap bounds the LCS, so a window short of it is skipped unscored
        const seen = new Map();
        let overlap = 0;
        for (let j = i; j < Math.min(i + W, lw.length); j++) {
            const w = lw[j].w;
            const c = (seen.get(w) || 0) + 1;
            seen.set(w, c);
            if (c <= (freq.get(w) || 0)) overlap++;
        }
        if (overlap < need) continue;
        const win = lw.slice(i, i + W);
        const r = lcsMatch(fw, win.map(x => x.w));
        if (r.count < need || !r.ends) continue;
        const first = i + r.first, last = i + r.last;
        const score = r.count / Math.max(fw.length, last - first + 1);
        if (score < FUZZY_BAR) continue;
        const key = `${first}:${last}`;
        if (!spans.has(key) || spans.get(key).score < score) spans.set(key, { score, first, last });
    }
    const ranked = [...spans.values()].sort((a, b) => b.score - a.score);
    if (!ranked.length) return { hits: 0 };
    const best = ranked[0];
    const others = ranked.filter(s => s.last < best.first || s.first > best.last);
    if (others.length) return { hits: 1 + others.length };
    return { hits: 1, start: L.map[lw[best.first].start], end: L.map[lw[best.last].end - 1] + 1 };
}

// a passage cut from inside a spoken line, closed with a mark the text lacks there: models balance quotes from habit
const EDGE_MARKS = '"“”';

/** Where `find` sits in `live`; failing that, without a quotation mark at an edge where the text has none (`marks`). */
function findSpan(live, find) {
    const span = placeQuote(live, find);
    if (span.hits || !find) return span;
    const head = EDGE_MARKS.includes(find[0]) ? find[0] : '';
    const tail = find.length > 1 && EDGE_MARKS.includes(find[find.length - 1]) ? find[find.length - 1] : '';
    const tries = [['', tail], [head, ''], [head, tail]].filter(([h, t], i, all) => (h || t) && all.findIndex(([h2, t2]) => h2 === h && t2 === t) === i);
    for (const [h, t] of tries) {
        const inner = find.slice(h.length, find.length - t.length);
        if (!inner.trim()) continue;
        const at = placeQuote(live, inner);
        if (at.hits) return at.hits === 1 ? { ...at, marks: { head: h, tail: t } } : at;
    }
    return span;
}

/** `text` with a placed span swapped for `withText`, which loses a mark at any edge where the find's was dropped. */
function spliceAt(text, span, withText) {
    let w = String(withText);
    if (span.marks?.head && EDGE_MARKS.includes(w[0])) w = w.slice(1);
    if (span.marks?.tail && w.length && EDGE_MARKS.includes(w[w.length - 1])) w = w.slice(0, -1);
    return text.slice(0, span.start) + w + text.slice(span.end);
}

/** Where `find` sits in `live`: exact, then folded, then an `approximate` word window; two places refuse. */
function placeQuote(live, find) {
    if (!find) return { hits: 0 };
    const exact = live.split(find).length - 1;
    if (exact === 1) { const start = live.indexOf(find); return { hits: 1, start, end: start + find.length }; }
    if (exact > 1) return { hits: exact };
    const folded = foldedSpan(normalizedText(live), normalizedText(find).norm.trim());
    if (folded.hits) return folded;
    const fuzzy = fuzzySpan(normalizedText(live, { tags: true }), normalizedText(find, { tags: true }).norm.trim());
    return fuzzy.hits ? { ...fuzzy, approximate: true } : { hits: 0 };
}

/** The anchor the snapshot recorded for `key`, or null when it recorded none. */
function shownAnchorOf(snapshot, key) {
    const map = snapshot?.loreAnchors;
    if (!map) return null;
    return Object.entries(map).find(([, keys]) => Array.isArray(keys) && keys.includes(key))?.[0] || null;
}

/**
 * Resolve a mislabeled lore edit on its anchor, snapshot-only; a unique match is the entry it read.
 * @returns {{world, uid}|null} null with no proof of read or more than one match
 */
function resolveLoreByAnchor(snapshot, anchor) {
    const map = snapshot?.loreAnchors;
    if (!map || !anchor) return null;
    // distinct keys: a cl-read re-serve is one entry twice, not an ambiguity
    const raw = map[String(anchor).toLowerCase()];
    const distinct = [...new Set(Array.isArray(raw) ? raw : [])].filter(k => (snapshot.loreFull || []).includes(k));
    return distinct.length === 1 ? splitLoreKey(distinct[0]) : null;
}

/**
 * An applied lore proposal's card name: the entry now, else the name the write recorded.
 * @returns {string|undefined} undefined when the result names no lore entry at all
 */
export function appliedTitle(db, result) {
    if (!result || !isStr(result.world) || !isInt(result.uid)) return undefined;
    const live = loreEntry(db, result.world, result.uid);
    if (live) return entryTitle(live);
    return isStr(result.title) ? result.title : undefined;
}

/** A refusal that names what of the book the model WAS shown, so it can aim or ask instead of giving up. */
function blindLoreReason(snapshot, world, uid) {
    const shown = (snapshot?.loreFull || []).map(splitLoreKey).filter(Boolean);
    const books = [...new Set(shown.filter(k => k.uid === uid).map(k => k.world))];
    if (books.length === 1) {
        return `you named a book with no entry #${uid} shown here; entry #${uid} was shown in "${books[0]}", aim the change at that book`;
    }
    const inBook = shown.filter(k => k.world === world).map(k => k.uid).sort((a, b) => a - b);
    if (inBook.length) {
        return `you named #${uid} in "${world}"; the entries of that book shown to you in full were ${inBook.map(u => `#${u}`).join(', ')}. Aim at one of those, or request #${uid} with a cl-read block if it exists`;
    }
    return 'this entry was never opened in the material the assistant was given';
}

/**
 * Decide one proposal's status NOW, against the stored snapshot; anchor resolution is lore-only.
 * @param {object|null} [self] target key -> anchors this reply's own applies produced
 * @returns {{status: string, changed?: boolean, resolved?: object, title?: string, fields?: Array<{key: string, before: *, after: *}>, reason?: string, before?: string, after?: string}} ready | superseded | blind | gone | ambiguous | invalid
 */
export function checkProposal(db, chatId, snapshot, p, self = null, later = null) {
    if (p.invalid) return { status: 'invalid', reason: p.invalid };
    if (FIELD_ENGINES.has(p.engine)) return checkFieldProposal(db, chatId, snapshot, p, self, later);
    const c = p.change;

    if (p.engine === 'lore') {
        if (c.op === 'create') {
            // a book that doesnt exist yet is the normal case for "write me a lorebook"; the card says it will be made
            const exists = worldExists(db, c.world);
            return {
                status: 'ready',
                before: '',
                after: String(c.content || ''),
                ...(exists ? {} : { createsBook: c.world }),
            };
        }
        let world = c.world;
        let uid = c.uid;
        let res = {};
        // title first, the number a fallback; a title and number that disagree refuse
        if (isStr(c.entry) && c.entry.trim()) {
            const t = resolveLoreTitle(snapshot, world, c.entry);
            if (t.error) return { status: 'blind', reason: t.error };
            if (isInt(uid) && uid !== t.uid) {
                return { status: 'ambiguous', reason: `the title "${c.entry.trim()}" is #${t.uid} in "${world}" but the change says #${uid}; say which you mean` };
            }
            uid = t.uid;
            if (!isInt(c.uid)) res = { resolved: { world, uid } };
        }
        // the label is the target and the shown set the proof of read; a sent anchor is optional evidence only
        const typedShown = (snapshot?.loreFull || []).includes(loreKey(world, uid));
        const hit = resolveLoreByAnchor(snapshot, c.anchor);
        if (!typedShown) {
            if (!hit) return { status: 'blind', reason: blindLoreReason(snapshot, world, uid), ...res };
            world = hit.world; uid = hit.uid; res = { resolved: { world, uid } };
        } else if (hit && loreKey(hit.world, hit.uid) !== loreKey(world, uid)) {
            return {
                status: 'ambiguous',
                reason: `the change names "${world}" #${uid} but carries the anchor of "${hit.world}" #${hit.uid}; say which entry you mean`,
            };
        }
        // drift is judged against what was read, so an entry with no recorded anchor cannot be judged at all
        const readAnchor = shownAnchorOf(snapshot, loreKey(world, uid));
        if (!readAnchor) return { status: 'blind', reason: UNRECORDED, ...res };
        const entry = loreEntry(db, world, uid);
        if (!entry) return { status: 'gone', reason: 'that entry no longer exists', ...res };
        const live = String(entry.content || '');
        const liveAnchor = anchorOf(live);
        // where it goes, what it is called, and which fields other than content the set moves
        const found = { ...res, title: entryTitle(entry), ...(c.op === 'delete' ? {} : { fields: fieldChanges(entry, c.set) }) };
        // a later reply's applied change outranks this one, the reviewer already chose the newer text
        if (later?.[selfKeyLore(world, uid)]) {
            return { status: 'superseded', reason: "rewritten since by a later reply's change", before: live, ...found };
        }
        // an outside change stays applicable, flagged `changed`, the diff decides; rewriting this reply's own apply refuses
        let changed = false;
        if (liveAnchor !== readAnchor) {
            const selfMade = (self?.[selfKeyLore(world, uid)] || []).includes(liveAnchor);
            if (!selfMade) {
                changed = true;
            } else if (c.op !== 'delete' && 'content' in (c.set || {})) {
                return { status: 'superseded', reason: 'an applied change from this reply already rewrote this entry', before: live, ...found };
            }
        }
        const note = { ...(changed ? { changed: true } : {}), ...found };
        if (c.op === 'delete') return { status: 'ready', ...note, before: live, after: '' };
        return {
            status: 'ready',
            ...note,
            before: live,
            after: 'content' in c.set ? String(c.set.content) : live,
        };
    }

    // a chat seq is the shown place, never mapped from an anchor; outside the shown set it refuses
    if (!(snapshot?.seqs || []).includes(c.seq)) {
        return { status: 'blind', reason: 'that message was not in the excerpt the assistant was given' };
    }
    return judgeChatAt(db, chatId, snapshot, c, c.seq, self, later, {});
}

/** The chat verdict on a shown message where it sits now; a find in exactly one other shown message is judged there. */
function judgeChatAt(db, chatId, snapshot, c, shown, self, later, given) {
    // what the model READ is the snapshot's anchor for this row, and the row is found by its recorded id
    const readAnchor = snapshot?.anchors?.[shown];
    if (!isAnchor(readAnchor) || !Number.isInteger(snapshot?.ids?.[shown])) return { status: 'blind', reason: UNRECORDED, ...given };
    const seq = liveSeqOf(db, chatId, snapshot, shown);
    const msg = seq === null ? null : chatRow(db, chatId, seq);
    if (!msg) return { status: 'gone', reason: 'that message no longer exists', ...given };
    // relocated: placed in another shown message by its text; a delete-moved one keeps every rule
    const relocated = !!given.resolved;
    const res = seq === shown ? given : { ...given, resolved: { ...given.resolved, seq } };
    const live = String(msg.mes || '');
    // relocation runs before the self-made shortcut, or a rewritten typed message reads the relocated one as consumed
    if (c.op === 'replace' && !relocated && findSpan(live, String(c.find)).hits === 0) {
        const elsewhere = (snapshot?.seqs || []).filter(s => s !== shown).map(s => [s, liveSeqOf(db, chatId, snapshot, s)])
            .filter(([, at]) => at !== null && findSpan(String(chatRow(db, chatId, at)?.mes || ''), String(c.find)).hits === 1);
        if (elsewhere.length === 1) return judgeChatAt(db, chatId, snapshot, c, elsewhere[0][0], self, later, { resolved: { seq: elsewhere[0][1] } });
    }
    const liveAnchor = anchorOf(live);
    // outranked by a later reply's apply, checked by anchor since a bare position could name a stranger
    if ((later?.[selfKeyChat(seq)] || []).includes(liveAnchor)) {
        return { status: 'superseded', reason: "reshaped since by a later reply's change", before: live, ...res };
    }
    const mismatch = liveAnchor !== readAnchor;
    const selfMade = mismatch && (self?.[selfKeyChat(seq)] || []).includes(liveAnchor);
    // Same rule as the lore side: an outside change flags `changed` and the diff decides;
    // only this reply overwriting its own applied work refuses.
    const changed = mismatch && !selfMade;
    const note = { ...(changed ? { changed: true } : {}), ...res };
    if (selfMade && c.op === 'edit') {
        return { status: 'superseded', reason: 'an applied change from this reply already reshaped this message', before: live, ...res };
    }
    if (c.op === 'replace') {
        // a find gone from the moved text is mechanically unappliable, an honest refusal
        const span = findSpan(live, String(c.find));
        if (span.hits !== 1) {
            if (span.hits === 0 && selfMade) {
                return { status: 'superseded', reason: 'this text was already changed by an applied proposal from this reply', before: live, ...res };
            }
            if (span.hits === 0 && !relocated) {
                // quoted from a draft the reader is not on: say which, or the model re-quotes it
                const swipes = Array.isArray(msg.swipes) ? msg.swipes : [];
                const active = Math.min(Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0, Math.max(swipes.length - 1, 0));
                const draft = swipes.findIndex((s, i) => i !== active && findSpan(String(s || ''), String(c.find)).hits === 1);
                if (draft >= 0) {
                    return { status: 'ambiguous', reason: `that text is in draft ${draft + 1} of the message, not the active draft ${active + 1}; quote the active draft as the excerpt shows it`, before: live, ...res };
                }
            }
            return {
                status: 'ambiguous',
                reason: span.hits === 0 ? 'that text is not in the message; quote it as the excerpt shows it' : `that text appears ${span.hits} times in the message`,
                before: live, ...res,
            };
        }
        return { status: 'ready', ...note, ...(span.approximate ? { approximate: true } : {}), before: live, after: spliceAt(live, span, c.with) };
    }
    if (c.op === 'edit') return { status: 'ready', ...note, before: live, after: String(c.text) };
    if (c.op === 'hide') return { status: 'ready', ...note, before: live, after: live };
    return { status: 'ready', ...note, before: live, after: '' };
}

// ========================================
// THE CARD ENGINE: the creator's draft
// ========================================

// A tag list compared and edited by name, case-insensitively, whitespace trimmed: the
// draft's own tag input dedupes the same way.
const tagKey = (t) => String(t).trim().toLowerCase();
function applyTagOps(tags, add, remove) {
    const out = [];
    const seen = new Set();
    const drop = new Set((remove || []).map(tagKey).filter(Boolean));
    for (const t of tags || []) {
        const k = tagKey(t);
        if (!k || seen.has(k) || drop.has(k)) continue;
        seen.add(k); out.push(t);
    }
    for (const t of add || []) {
        const k = tagKey(t);
        if (!k || seen.has(k) || drop.has(k)) continue;
        seen.add(k); out.push(String(t).trim());
    }
    return out;
}

/** The target a card change addresses, the key its self anchor is recorded under. */
export function cardTarget(c) {
    if (c.op === 'tags') return 'tags';
    if (c.op === 'greeting') return c.index === 'new' ? 'greeting:new' : `greeting:${c.index}`;
    return `field:${c.field}`;
}

/** What the field or greeting a change targets holds now, for a verdict that shows no diff. */
function cardBefore(draft, c) {
    if (c.op === 'greeting') return String((Array.isArray(draft?.alternate_greetings) ? draft.alternate_greetings : [])[c.index - 1] ?? '');
    return String(draft?.[c.field] ?? '');
}

/** A replace built on the model's own earlier unapplied change composes with it into one edit (`via`). */
function resolveThroughPrior(live, change, prior, depth = 0) {
    if (depth > 3 || !Array.isArray(prior)) return null;
    for (let i = 0; i < prior.length; i++) {
        const q = prior[i];
        const qc = q?.change;
        if (!qc || qc.field !== change.field) continue;
        const text = qc.op === 'replace' ? String(qc.with ?? '') : qc.op === 'set' ? String(qc.content ?? '') : '';
        if (!text) continue;
        const span = findSpan(text, String(change.find));
        if (span.hits !== 1) continue;
        const edited = spliceAt(text, span, change.with);
        const via = { seq: q.seq, id: q.id };
        if (qc.op === 'set') return { change: { op: 'set', field: change.field, content: edited }, via };
        const composed = { op: 'replace', field: change.field, find: String(qc.find), with: edited };
        const inLive = findSpan(live, composed.find);
        if (inLive.hits === 1) return { change: composed, via };
        if (inLive.hits === 0) {
            const deeper = resolveThroughPrior(live, composed, prior.slice(i + 1), depth + 1);
            if (deeper) return { change: deeper.change, via };
        }
    }
    return null;
}

/**
 * Judge one card proposal against the posted draft; drift is flagged, never refused. no db, no gate.
 * @param {{subject?: string}} [words] what a reason calls the text judged: the studio's draft, the assistant's card
 * @returns {{status, changed?, before, after, reason?, target}}
 */
export function checkCardProposal(snapshot, draft, p, self = null, prior = [], later = null, { subject = 'draft' } = {}) {
    if (p.invalid) return { status: 'invalid', reason: p.invalid };
    const c = p.change;
    const target = cardTarget(c);
    const selfHas = (liveAnchor) => (self?.[selfKeyCard(target, p.engine)] || []).includes(liveAnchor);
    // a later reply's applied change outranks this one; tags and new greetings compose, never outranked
    if (later?.[selfKeyCard(target, p.engine)] && c.op !== 'tags' && !(c.op === 'greeting' && c.index === 'new')) {
        return { status: 'superseded', reason: "rewritten since by a later reply's change", before: cardBefore(draft, c), target };
    }
    if (c.op === 'tags') {
        const before = Array.isArray(draft?.tags) ? draft.tags.slice() : [];
        const after = applyTagOps(before, c.add, c.remove);
        const liveAnchor = anchorOf(JSON.stringify(before));
        const readAnchor = snapshot?.tags || null;
        const changed = !!readAnchor && liveAnchor !== readAnchor && !selfHas(liveAnchor);
        if (JSON.stringify(before) === JSON.stringify(after)) {
            return { status: 'ambiguous', reason: 'these tags are already as proposed', before, after, target };
        }
        return { status: 'ready', ...(changed ? { changed: true } : {}), before, after, target };
    }
    if (c.op === 'greeting') {
        const list = Array.isArray(draft?.alternate_greetings) ? draft.alternate_greetings : [];
        if (c.index === 'new') return { status: 'ready', before: '', after: String(c.content), target };
        const i = c.index - 1;
        if (i >= list.length) return { status: 'gone', reason: `there is no alternate greeting ${c.index}; the ${subject} has ${list.length}`, target };
        const live = String(list[i] ?? '');
        const liveAnchor = anchorOf(live);
        const readAnchor = snapshot?.greetings?.[i] || null;
        const mismatch = !!readAnchor && liveAnchor !== readAnchor;
        if (mismatch && selfHas(liveAnchor)) {
            return { status: 'superseded', reason: 'an applied change from this reply already rewrote this greeting', before: live, target };
        }
        return { status: 'ready', ...(mismatch ? { changed: true } : {}), before: live, after: String(c.content), target };
    }
    const live = String(draft?.[c.field] ?? '');
    const liveAnchor = anchorOf(live);
    const readAnchor = snapshot?.anchors?.[c.field] || null;
    const mismatch = !!readAnchor && liveAnchor !== readAnchor;
    const selfMade = mismatch && selfHas(liveAnchor);
    const changed = mismatch && !selfMade;
    const note = changed ? { changed: true } : {};
    if (c.op === 'set') {
        if (selfMade) return { status: 'superseded', reason: 'an applied change from this reply already rewrote this field', before: live, target };
        return { status: 'ready', ...note, before: live, after: String(c.content), target };
    }
    // replace: the find must sit in the CURRENT text exactly once (the chat rule, same folds)
    const span = findSpan(live, String(c.find));
    if (span.hits !== 1) {
        if (span.hits === 0 && selfMade) {
            return { status: 'superseded', reason: 'this passage was already changed by an applied proposal from this reply', before: live, target };
        }
        if (span.hits === 0) {
            const r = resolveThroughPrior(live, c, prior);
            if (r) {
                if (r.change.op === 'set') return { status: 'ready', ...note, before: live, after: r.change.content, target, via: r.via };
                const at = findSpan(live, r.change.find);
                return { status: 'ready', ...note, before: live, after: spliceAt(live, at, r.change.with), target, via: r.via };
            }
        }
        return {
            status: 'ambiguous',
            reason: span.hits === 0 ? `that passage is not in the field; quote it as the ${subject} shows it` : `that passage appears ${span.hits} times in the field`,
            before: live, target,
        };
    }
    return { status: 'ready', ...note, ...(span.approximate ? { approximate: true } : {}), before: live, after: spliceAt(live, span, c.with), target };
}

/**
 * Apply card proposals onto a copy of the draft, each re-judged; new greetings run last. touches no row.
 * @returns {{results: Array<{id, status, reason?, result?}>, draft: object}}
 */
export function applyCardProposals(snapshot, draft, proposals, selfAnchors = null, prior = [], later = null, words = {}) {
    const work = {
        ...draft,
        tags: Array.isArray(draft?.tags) ? draft.tags.slice() : [],
        alternate_greetings: Array.isArray(draft?.alternate_greetings) ? draft.alternate_greetings.slice() : [],
    };
    const self = { ...(selfAnchors || {}) };
    const note = (key, anchor) => { if (anchor) self[key] = [...(self[key] || []), anchor]; };
    const isNewGreeting = (p) => p.change.op === 'greeting' && p.change.index === 'new';
    const ordered = [...proposals.filter(p => !isNewGreeting(p)), ...proposals.filter(isNewGreeting)];
    const results = [];
    for (const p of ordered) {
        const v = checkCardProposal(snapshot, work, p, self, prior, later, words);
        if (v.status !== 'ready') { results.push({ id: p.id, status: v.status, reason: v.reason }); continue; }
        const c = p.change;
        let result;
        if (c.op === 'tags') {
            work.tags = v.after;
            result = { target: v.target, tags: v.after, newAnchor: anchorOf(JSON.stringify(v.after)) };
        } else if (c.op === 'greeting') {
            if (c.index === 'new') {
                work.alternate_greetings.push(v.after);
                const n = work.alternate_greetings.length;
                result = { target: `greeting:${n}`, greeting: n, newAnchor: anchorOf(v.after) };
            } else {
                work.alternate_greetings[c.index - 1] = v.after;
                result = { target: v.target, greeting: c.index, newAnchor: anchorOf(v.after) };
            }
        } else {
            work[c.field] = v.after;
            result = { target: v.target, field: c.field, newAnchor: anchorOf(v.after) };
        }
        if (v.via) result.via = v.via;
        // a card result keeps its engine implicit, the form stored studio records already have
        if (p.engine && p.engine !== 'card') result.engine = p.engine;
        note(selfKeyCard(result.target, p.engine), result.newAnchor);
        results.push({ id: p.id, status: 'applied', result });
    }
    return { results, draft: work };
}

// ========================================
// THE FIELD ENGINES OVER LIVE ROWS: the card, this chat's notes, the persona
// ========================================

const ENGINE_WORDS = { card: 'card', notes: "this chat's notes", persona: 'persona' };
export const fieldLabelOf = (engine, key) => (EDIT_FIELDS[engine] || []).find(([k]) => k === key)?.[1] || key;

/** The live fields of the card a chat's assistant edits, tags and greetings as the studio's draft holds them. */
function liveCardFields(char) {
    const data = char.card?.data || {};
    return {
        ...Object.fromEntries(editFieldKeys('card').map(k => [k, String(cardText(data, k) ?? '')])),
        tags: Array.isArray(char.tags) ? char.tags.slice() : [],
        alternate_greetings: Array.isArray(data.alternate_greetings) ? data.alternate_greetings.map(g => String(g ?? '')) : [],
    };
}

/**
 * One field engine's target: what it holds now, what the reply was shown, and who else it reaches; or why it cant be judged.
 * @returns {{live: object, read: object, reach?: object, own?: object}|{status: string, reason: string}}
 */
function fieldTarget(db, chatId, snapshot, engine) {
    if (!snapshot) return { status: 'blind', reason: UNRECORDED };
    // a capability the reader had off when the reply was written was never offered, so nothing it wrote is honoured
    if (!snapshot.engines?.includes(engine)) return { status: 'off', reason: `${ENGINE_WORDS[engine]} edits were switched off when this reply was written` };
    if (engine === 'card') {
        const read = snapshot.card;
        if (!read?.anchors) return { status: 'blind', reason: UNRECORDED };
        const char = getCharacter(db, read.charId);
        if (!char) return { status: 'gone', reason: 'the character no longer exists' };
        return { live: liveCardFields(char), read, reach: { kind: 'card', name: char.card?.data?.name || '' }, charId: read.charId };
    }
    if (engine === 'notes') {
        const read = snapshot.notes;
        if (!read?.anchors) return { status: 'blind', reason: UNRECORDED };
        const row = getChatRow(db, chatId);
        if (!row) return { status: 'gone', reason: 'the chat no longer exists' };
        const note = chatNoteOf(chatMetadataOf(row.chat_metadata), noteDefaults(db));
        const own = chatOwnTexts(row);
        return {
            live: { authors_note: note.prompt, ...Object.fromEntries(CHAT_OWN_KEYS.map(k => [k, own[k] ?? ''])) },
            read,
            own: { authors_note: note.own.prompt, ...Object.fromEntries(Object.keys(own).map(k => [k, true])) },
        };
    }
    const read = snapshot.persona;
    if (!read?.id) return { status: 'blind', reason: 'the persona was not shared with the assistant when this reply was written' };
    const persona = getPersona(db, read.id);
    if (!persona) return { status: 'gone', reason: 'that persona no longer exists' };
    return { live: { description: String(persona.description ?? '') }, read, reach: { kind: 'persona', name: persona.name || '' }, personaId: read.id };
}

// what the judge's reasons call the text: the card the assistant read, the material the notes and the persona came in
const WORDS = { card: { subject: 'card' }, notes: { subject: 'material' }, persona: { subject: 'material' } };

// the scope a change's self anchors are keyed under: a persona's are that persona's, so another persona's later edit never supersedes it
const scopedTo = (t, p) => (p.engine === 'persona' ? { ...p, engine: `persona@${t.personaId}` } : p);

// what the reply was never shown is never its to change: a field without a recorded anchor, the tags unprinted, a greeting added since
function fieldGate(t, p) {
    const c = p.change;
    if (c.op === 'tags') return t.read.tags ? null : { status: 'blind', reason: 'the tags were not shown to the assistant' };
    if (c.op === 'greeting') {
        if (c.index === 'new') return null;
        // past the end of the live list, the judge says it is gone; one added since the read was never shown
        if (c.index - 1 >= (t.live.alternate_greetings || []).length) return null;
        return c.index - 1 < (t.read.greetings || []).length ? null : { status: 'blind', reason: `alternate greeting ${c.index} was not shown to the assistant` };
    }
    if (!(c.field in (t.read.anchors || {}))) {
        const why = p.engine === 'notes' && c.field === 'authors_note' ? ': its source was switched off when this reply was written' : '';
        return { status: 'blind', reason: `${fieldLabelOf(p.engine, c.field)} was not shown to the assistant${why}` };
    }
    return null;
}

// what the review card says beyond the diff: who else a write reaches, and a chat note made its own
function fieldExtras(t, p) {
    const c = p.change;
    return {
        ...(c.field ? { label: fieldLabelOf(p.engine, c.field) } : {}),
        ...(t.reach ? { reach: t.reach } : {}),
        ...(p.engine === 'notes' && c.field && !t.own?.[c.field] ? { makesOwn: true } : {}),
    };
}

/** Judge one field-engine proposal against its live row; the studio's judge, behind the blind gate. */
function checkFieldProposal(db, chatId, snapshot, p, self, later) {
    const t = fieldTarget(db, chatId, snapshot, p.engine);
    if (t.status) return { ...t, ...(p.change.field ? { label: fieldLabelOf(p.engine, p.change.field) } : {}) };
    const refused = fieldGate(t, p);
    if (refused) return { ...refused, ...fieldExtras(t, p) };
    return { ...checkCardProposal(t.read, t.live, scopedTo(t, p), self, [], later, WORDS[p.engine]), ...fieldExtras(t, p) };
}

// the card patch for the fields a batch moved; a Character's Note new to the card takes ST's placement
function cardPatch(char, before, after) {
    const fields = {};
    for (const k of editFieldKeys('card')) {
        if (after[k] === before[k]) continue;
        if (k !== 'depth_prompt') { fields[k] = after[k]; continue; }
        const dp = char.card?.data?.extensions?.depth_prompt;
        if (dp && typeof dp === 'object') fields['extensions.depth_prompt.prompt'] = after[k];
        else fields['extensions.depth_prompt'] = { prompt: after[k], ...cardNotePlacement({}) };
    }
    if (JSON.stringify(after.tags) !== JSON.stringify(before.tags)) fields.tags = after.tags;
    if (JSON.stringify(after.alternate_greetings) !== JSON.stringify(before.alternate_greetings)) fields.alternate_greetings = after.alternate_greetings;
    return fields;
}

// one write per engine per apply: the card with its snapshot first, the chat's metadata, the persona
function writeFields(db, chatId, engine, t, after, paths) {
    if (engine === 'card') {
        const char = getCharacter(db, t.charId);
        const fields = cardPatch(char, t.live, after);
        if (!Object.keys(fields).length) return;
        // automatic, under its own cap: a long session's applies never push out the editor's backups, or the card as it was
        patchAfterSnapshot(db, paths, t.charId, "Before the assistant's edits", fields, {
            source: ASSISTANT_BACKUP, embedAvatar: false,
        });
        return;
    }
    if (engine === 'notes') {
        const meta = {};
        for (const k of editFieldKeys('notes')) {
            if (after[k] === t.live[k]) continue;
            // a stored empty note stays empty; an emptied text of the chat's own goes back to the card's
            if (k === 'authors_note') meta[NOTE_KEYS.prompt] = after[k];
            else meta[k] = after[k] ? after[k] : null;
        }
        if (Object.keys(meta).length) patchChat(db, chatId, { chatMetadata: meta });
        return;
    }
    if (after.description !== t.live.description) updatePersona(db, t.personaId, { description: after.description });
}

/**
 * Apply one engine's chosen field proposals: gated, re-judged in order on a working copy, then written once.
 * @returns {Array<{id, status, reason?, result?}>}
 */
function applyFieldEngine(db, chatId, snapshot, engine, proposals, self, later, paths) {
    const t = fieldTarget(db, chatId, snapshot, engine);
    if (t.status) return proposals.map(p => ({ id: p.id, status: t.status, reason: t.reason }));
    const refused = [];
    const open = [];
    for (const p of proposals) {
        if (p.invalid) { refused.push({ id: p.id, status: 'invalid', reason: p.invalid }); continue; }
        const r = fieldGate(t, p);
        if (r) refused.push({ id: p.id, status: r.status, reason: r.reason });
        else open.push(p);
    }
    const { results, draft } = applyCardProposals(t.read, t.live, open.map(p => scopedTo(t, p)), self, [], later, WORDS[engine]);
    if (results.some(r => r.status === 'applied')) {
        try {
            writeFields(db, chatId, engine, t, draft, paths);
        } catch (e) {
            return [...refused, ...results.map(r => (r.status === 'applied' ? { id: r.id, status: 'failed', reason: e.message } : r))];
        }
        const where = engine === 'card' ? { charId: t.charId } : engine === 'persona' ? { personaId: t.personaId } : { chatNotes: true };
        for (const r of results) if (r.status === 'applied') Object.assign(r.result, where);
    }
    return [...refused, ...results];
}

// ========================================
// APPLYING A BATCH
// ========================================

/** The order a batch runs in: deletes last, message deletes descending, so nothing addresses a moved target. */
export function orderProposals(proposals) {
    const inPlace = proposals.filter(p => p.change.op !== 'delete');
    const loreDeletes = proposals.filter(p => p.engine === 'lore' && p.change.op === 'delete');
    const chatDeletes = proposals.filter(p => p.engine === 'chat' && p.change.op === 'delete')
        .sort((a, b) => b.change.seq - a.change.seq);
    return [...inPlace, ...loreDeletes, ...chatDeletes];
}

/**
 * Merge a reviewer's touch-ups into a proposal: amend, never widen (`world` only on a create).
 * @param {Object} p the stored proposal
 * @param {Object|null|undefined} o the reviewer's override for this id
 * @returns {Object} the proposal to apply (the original object when nothing merges)
 */
export function mergeOverrides(p, o) {
    if (!o || typeof o !== 'object') return p;
    const change = { ...p.change };
    let touched = false;
    for (const [k, v] of Object.entries(o)) {
        if (k === 'world') {
            if (change.op === 'create' && typeof v === 'string' && v.trim()) { change.world = v.trim(); touched = true; }
            continue;
        }
        if (!(k in change)) continue;
        if (typeof change[k] === 'string' && typeof v === 'string') { change[k] = v; touched = true; }
        else if (Array.isArray(change[k]) && Array.isArray(v) && v.every(x => typeof x === 'string')) { change[k] = v; touched = true; }
    }
    return touched ? { ...p, change } : p;
}

function applyLore(db, p, chatId, verdict) {
    const c = p.change;
    if (c.op === 'create') {
        // upsertWorld REPLACES a world wholesale, so only when the name is truly absent
        let linked = null;
        if (!worldExists(db, c.world)) {
            upsertWorld(db, c.world, { entries: {} });
            // link it to the character, or a new book no card uses never reaches a prompt
            const row = getChatRow(db, chatId);
            if (row?.char_id) {
                applyWorldsFor(db, 'char', row.char_id, { add: [c.world] });
                linked = row.char_id;
            }
        }
        // createWorldEntry answers with the new uid ITSELF, not a row wrapping it.
        const created = createWorldEntry(db, c.world, {
            comment: isStr(c.comment) ? c.comment : 'New entry',
            key: Array.isArray(c.keys) ? c.keys.map(String) : [],
            keysecondary: Array.isArray(c.secondaryKeys) ? c.secondaryKeys.map(String) : [],
            content: String(c.content || ''),
            selective: Array.isArray(c.secondaryKeys) && c.secondaryKeys.length > 0,
            constant: c.constant === true,
            // enabled unless said otherwise: the reader just read and approved it, unlike the panel's blank create
            disable: c.disable === true,
            ...(isInt(c.order) ? { order: c.order } : {}),
            ...(isInt(c.position) ? { position: c.position } : {}),
            ...(isInt(c.depth) ? { depth: c.depth } : {}),
        });
        return {
            world: c.world,
            uid: Number.isInteger(created) ? created : null,
            title: isStr(c.comment) ? c.comment : 'New entry',
            ...(linked ? { createdBook: c.world, linkedTo: linked } : {}),
        };
    }
    // The write lands on the RESOLVED target (an anchor-resolved mislabel), or the typed one.
    const world = verdict?.resolved?.world ?? c.world;
    const uid = verdict?.resolved?.uid ?? c.uid;
    // The name the card keeps once the row is gone or renamed: the verdict read it live.
    const known = isStr(verdict?.title) ? { title: verdict.title } : {};
    if (c.op === 'delete') {
        deleteWorldEntry(db, world, uid);
        return { world, uid, ...known };
    }
    // upsertWorldEntry MERGES, so naming only what changes leaves every field this path
    // never sees (probability, sticky, cooldown, the recursion flags) exactly as it was.
    const patch = lorePatchFrom(p.change.set);
    upsertWorldEntry(db, world, uid, patch);
    // The anchor this write produced, recorded so later judges can tell OUR change from
    // a stranger's when the same target comes up again.
    return {
        world, uid,
        ...('comment' in patch ? { title: patch.comment } : known),
        ...('content' in patch ? { newAnchor: anchorOf(patch.content) } : {}),
    };
}

function applyChat(db, chatId, p, computed) {
    const c = p.change;
    // every write lands where the judge found the message, and the result says so
    const seq = computed.resolved?.seq ?? c.seq;
    if (c.op === 'delete') {
        deleteChatMessage(db, chatId, seq);
        return { seq, deleted: true };
    }
    if (c.op === 'hide') {
        // hide via extra.hidden (visibleHistory honours it), the transcript's own leaf; an unhide deletes the flag
        patchChatMessage(db, chatId, seq, { extra: { hidden: c.hidden ? true : null } });
        return { seq, hidden: c.hidden };
    }
    const msg = chatRow(db, chatId, seq);
    const next = { mes: computed.after };
    // mes IS the active alternate; write both or the server puts the old text back
    if (Array.isArray(msg?.swipes) && msg.swipes.length > 1) {
        const active = Math.min(msg.swipe_id ?? 0, msg.swipes.length - 1);
        const swipes = msg.swipes.slice();
        swipes[active] = computed.after;
        next.swipes = swipes;
    }
    // the greeting is stored expanded whoever writes it: the same finish the transcript's PATCH runs
    const written = patchChatMessage(db, chatId, seq, next, seq === 0 ? { finish: finishFirstMessage(db, getChatRow(db, chatId)) } : {});
    // the anchor of what was stored, which a finish may have expanded past what the model wrote
    return { seq, newAnchor: anchorOf(written?.message?.mes ?? computed.after) };
}

/**
 * Apply the chosen proposals, each re-checked just before its write, each result saying what happened.
 * @returns {Array<{id, status, reason?, result?}>}
 */
export function applyProposals(db, chatId, snapshot, proposals, selfAnchors = null, later = null, { paths = null } = {}) {
    const out = [];
    // seeded from earlier applies and grown as the batch writes, so two edits to one message both land
    const self = { ...(selfAnchors || {}) };
    const note = (key, anchor) => { if (anchor) self[key] = [...(self[key] || []), anchor]; };
    // each field engine lands as one write: its proposals judged together on a working copy, then stored once
    for (const engine of FIELD_ENGINES) {
        const mine = proposals.filter(p => p.engine === engine);
        if (!mine.length) continue;
        for (const r of applyFieldEngine(db, chatId, snapshot, engine, mine, self, later, paths)) {
            if (r.result?.newAnchor) note(selfKeyCard(r.result.target, r.result.engine || engine), r.result.newAnchor);
            out.push(r);
        }
    }
    for (const p of orderProposals(proposals.filter(p => !FIELD_ENGINES.has(p.engine)))) {
        const verdict = checkProposal(db, chatId, snapshot, p, self, later);
        if (verdict.status !== 'ready') {
            out.push({ id: p.id, status: verdict.status, reason: verdict.reason });
            continue;
        }
        try {
            const result = p.engine === 'lore' ? applyLore(db, p, chatId, verdict) : applyChat(db, chatId, p, verdict);
            // keyed by the resolved target the write landed on, not the typed label
            if (result?.newAnchor) {
                note(p.engine === 'chat' ? selfKeyChat(result.seq) : selfKeyLore(result.world, result.uid), result.newAnchor);
            }
            out.push({ id: p.id, status: 'applied', result });
        } catch (e) {
            out.push({ id: p.id, status: 'failed', reason: e.message });
        }
    }
    return out;
}
