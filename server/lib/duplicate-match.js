// The duplicate rule, one implementation for every consumer: the library scan, the pre-import check, the browse hint, Related's copies

// ============================================================================
// NAMES
// ============================================================================

const VERSION_SUFFIX = /\s*[\(\[\{]?\s*v(?:er(?:sion)?)?\.?\s*\d+[\)\]\}]?\s*$/i;
const VERSION_DASH = /\s*-?\s*v\d+(\.\d+)*$/i;
const COMMON_SUFFIX = /\s*[\(\[\{]?(?:updated?|fixed?|new|old|alt(?:ernate)?|edit(?:ed)?|copy|backup|nsfw)[\)\]\}]?\s*$/i;
const NAME_SEPARATOR = /[\s\-|:,.]/;
/** The shortest name that is a word of a longer one: under it, names relate only when equal. */
export const NAME_PREFIX_MIN = 4;
// a name's decoration at either end ("- Calamitas -", "Brannoch!", stars and brackets) is no part of it
const EDGE_DECORATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** A name without its version and edit suffixes or edge decoration, compatibility-folded, lowercased, single-spaced. */
function normalizeCharName(name) {
    if (!name) return '';
    return String(name).normalize('NFKC').toLowerCase().trim()
        .replace(VERSION_SUFFIX, '')
        .replace(VERSION_DASH, '')
        .replace(COMMON_SUFFIX, '')
        .replace(EDGE_DECORATION, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** The normalized name, and the part before a || when the name carries one. */
export function nameVariantsForDupe(rawName) {
    const raw = String(rawName || '');
    const variants = new Set();
    const full = normalizeCharName(raw);
    if (full) variants.add(full);
    if (raw.includes('||')) {
        const primary = normalizeCharName(raw.split('||')[0]);
        if (primary) variants.add(primary);
    }
    return [...variants];
}

/** The shorter name is a word of the longer (at least four characters, then a separator). */
function isNamePrefixMatch(a, b) {
    if (!a || !b || a.length === b.length) return false;
    const shorter = a.length < b.length ? a : b;
    const longer = a.length < b.length ? b : a;
    if (shorter.length < NAME_PREFIX_MIN) return false;
    return longer.startsWith(shorter) && NAME_SEPARATOR.test(longer[shorter.length]);
}

/** How two normalized names relate: 'exact' (at any length: 雪菜, Ai), 'prefix' (one a word of the other), or ''. */
export function nameRelation(a, b) {
    if (!a || !b) return '';
    if (a === b) return 'exact';
    return isNamePrefixMatch(a, b) ? 'prefix' : '';
}

/** The shorter names a normalized name is a prefix match of: each run up to a separator, four characters and more. */
export function namePrefixesOf(key) {
    const out = [];
    for (let i = NAME_PREFIX_MIN; i < key.length; i++) {
        if (!NAME_SEPARATOR.test(key[i])) continue;
        const stem = key.slice(0, i).trim();
        if (stem.length >= NAME_PREFIX_MIN) out.push(stem);
    }
    return [...new Set(out)];
}

/** The separators a longer name can carry right after a shorter one, for the index ranges that find it. */
export const NAME_SEPARATORS = [' ', '-', '|', ':', ',', '.'];

/**
 * A name probe's rows graded by the duplicate rule, so the browse hint and the import warning agree.
 * @param {string} rawName
 * @param {Array<{id: string, name: string, creator: string|null}>} rows
 * @returns {{variants: string[], matches: Array<{id: string, name: string, creator: string|null, relation: string, on: string, as: string}>}}
 */
export function gradeNameMatches(rawName, rows) {
    const variants = nameVariantsForDupe(rawName);
    const matches = [];
    for (const row of rows) {
        let best = null;
        for (const as of nameVariantsForDupe(row.name)) {
            for (const on of variants) {
                const relation = nameRelation(on, as);
                // a row found by its listing title relates exactly only, as the score reads a title
                if (row.viaListing && relation !== 'exact') continue;
                if (relation && (!best || (relation === 'exact' && best.relation !== 'exact'))) best = { relation, on, as };
            }
        }
        if (best) matches.push({ ...row, ...best });
    }
    return { variants, matches };
}

// ============================================================================
// TEXT SIMILARITY
// ============================================================================

/** Levenshtein similarity in [0, 1]; 0 when the lengths differ by more than half. */
function stringSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    const s1 = String(str1).toLowerCase().trim();
    const s2 = String(str2).toLowerCase().trim();
    if (s1 === s2) return 1;
    if (!s1 || !s2) return 0;
    const len1 = s1.length, len2 = s2.length;
    if (Math.abs(len1 - len2) > Math.max(len1, len2) * 0.5) return 0;
    let prev = new Array(len2 + 1);
    let cur = new Array(len2 + 1);
    for (let j = 0; j <= len2; j++) prev[j] = j;
    for (let i = 1; i <= len1; i++) {
        cur[0] = i;
        for (let j = 1; j <= len2; j++) {
            const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, cur] = [cur, prev];
    }
    return 1 - (prev[len2] / Math.max(len1, len2));
}

/** Jaccard over two word sets. */
function wordSetSimilarity(wordsA, wordsB) {
    if (!wordsA || !wordsB || wordsA.size === 0 || wordsB.size === 0) return 0;
    let intersection = 0;
    for (const word of wordsA) if (wordsB.has(word)) intersection++;
    const union = wordsA.size + wordsB.size - intersection;
    return union > 0 ? intersection / union : 0;
}

// scripts written without spaces between words: a run of them is read by its character pairs
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/** A folded text's tokens: each word of three characters and up in any script, an unspaced run by its character pairs. */
function textTokens(lower) {
    const out = [];
    for (const run of lower.match(/[\p{L}\p{N}_]+/gu) || []) {
        if (UNSPACED.test(run)) {
            const chars = Array.from(run);
            for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
        } else if (run.length >= 3) out.push(run);
    }
    return out;
}

const wordSet = (lower) => new Set(textTokens(lower));

// a field read once per card: its raw length (the arms' floors), its folded text, its words when first asked
function prepareText(raw) {
    const text = raw ? String(raw) : '';
    const lower = text.toLowerCase().trim();
    let words = null;
    return { raw: text, length: text.length, lower, get words() { return words ??= wordSet(lower); } };
}

function textSimilarity(a, b) {
    if (!a.lower || !b.lower) return 0;
    if (a.lower === b.lower) return 1;
    if (a.lower.length < 50 || b.lower.length < 50) return stringSimilarity(a.lower, b.lower);
    return wordSetSimilarity(a.words, b.words);
}

/** Two provider paths name the same card: equal, or one beginning the other (never bare numbers). */
export function providerPathsMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (/^\d+$/.test(a) || /^\d+$/.test(b)) return false;
    return a.startsWith(b) || b.startsWith(a);
}

// two listing keys name one listing: equal, or two paths one beginning the other
const listingKeysRelate = (a, b) => a === b || (a.includes('/') && b.includes('/') && providerPathsMatch(a, b));

/** A provider link as the listing rule reads it: its provider and its keys, trimmed and lowercased. */
export const listingOf = (providerId, ...keys) => ({ providerId: String(providerId || ''), keys: keys.map(k => String(k ?? '').trim().toLowerCase()).filter(Boolean) });

/**
 * The site two cards are different listings on: linked on one provider, no key of one naming the other's.
 * @param {Array<{ providerId: string, keys: string[] }>} a listingOf rows
 * @param {Array<{ providerId: string, keys: string[] }>} b
 * @returns {string} the provider, '' when they are one listing or share no site
 */
export function differentListings(a, b) {
    let shared = '';
    for (const la of a || []) {
        for (const lb of b || []) {
            if (!la.providerId || la.providerId !== lb.providerId || !la.keys.length || !lb.keys.length) continue;
            if (la.keys.some(x => lb.keys.some(y => listingKeysRelate(x, y)))) return '';
            shared = la.providerId;
        }
    }
    return shared;
}

// ============================================================================
// ONE SITE, TWO LISTINGS: an author's other card, or one card uploaded twice
// ============================================================================

// word overlap bands measured on one author's same-site pairs: their own text is two-humped, a public description looser
export const LISTING_TEXT = Object.freeze({ same: 0.6, apart: 0.3 });
export const LISTING_PUBLIC = Object.freeze({ same: 0.4, apart: 0.3 });
const band = (x, t) => (x >= t.same ? 'same' : x < t.apart ? 'different' : 'maybe');

/** Two cards listed apart on one site: 'same', 'different' or 'maybe', by their own text, else their creator notes. */
export function listingVerdict(a, b) {
    const own = [['description', 50], ['first_mes', 30]].filter(([k, min]) => a[k].length > min && b[k].length > min).map(([k]) => wordSetSimilarity(a[k].words, b[k].words));
    if (own.length) return band(Math.max(...own), LISTING_TEXT);
    if (a.creator_notes.length > 50 && b.creator_notes.length > 50) return band(wordSetSimilarity(a.creator_notes.words, b.creator_notes.words), LISTING_PUBLIC);
    return 'maybe';
}

/** A listing's public description against a card's creator notes: the same verdict, the notes cut to the text's length. */
export function publicTextVerdict(text, notes) {
    const t = String(text || ''), n = String(notes || '');
    if (t.length <= 50 || n.length <= 50) return 'maybe';
    const a = prepareText(t), b = prepareText(n.length > t.length ? n.slice(0, t.length) : n);
    return band(wordSetSimilarity(a.words, b.words), LISTING_PUBLIC);
}

// ============================================================================
// CREATORS
// ============================================================================

// platform placeholders and blanks are no identity: two cards by 'Anonymous' share no creator
const PLACEHOLDER_CREATORS = new Set(['anonymous', 'anon', 'unknown', 'deleted', 'n/a', 'na', 'none', 'user', 'admin', 'test', 'guest', 'character', 'null', 'undefined', '-', '?']);

/** The creator as the rule compares it: folded, lowercased, a leading @ and spacing and separators dropped; '' for a placeholder or none. */
export function creatorKey(raw) {
    const folded = String(raw ?? '').normalize('NFKC').toLowerCase().trim().replace(/^@+/, '').trim();
    if (!folded || PLACEHOLDER_CREATORS.has(folded)) return '';
    return folded.replace(/[\s_-]/g, '');
}

// how alike two creator keys are, 0 to 1: the same, one holding the other (four characters and more), or an edit distance from 0.75
function creatorSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const shorter = a.length < b.length ? a : b;
    if (shorter.length >= 4 && (a.includes(b) || b.includes(a))) return 0.95;
    return similarityAtLeast(a, b, 0.75);
}

const creatorsRelate = (a, b) => creatorSimilarity(a, b) > 0;

// Levenshtein similarity when it reaches min, else 0, stopping as soon as no path can reach it (a creator pair in a large bucket)
function similarityAtLeast(a, b, min) {
    const max = Math.max(a.length, b.length);
    const budget = Math.floor((1 - min) * max);
    if (Math.abs(a.length - b.length) > budget) return 0;
    let prev = new Array(b.length + 1), cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        cur[0] = i;
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (cur[j] < rowMin) rowMin = cur[j];
        }
        if (rowMin > budget) return 0;
        [prev, cur] = [cur, prev];
    }
    const sim = 1 - prev[b.length] / max;
    return sim >= min ? sim : 0;
}

// ============================================================================
// CONTENT SIGNATURES (candidates and pruning only; the verdict is always the score below)
// ============================================================================

// the words every text shares carry no identity
const STOP_WORDS = new Set(('the and you your with for that this are was her his she him they their them have has had not but from what when who '
    + 'will would can could into out about there been were just like its one all any our more some than then very also only over such even '
    + 'most other each which while where how why yes').split(' '));

/** The card fields a signature is kept for, in their stored order. */
const SIGNATURE_FIELDS = Object.freeze(['description', 'first_mes', 'personality', 'creator_notes']);
const FIELD = Object.freeze({ description: 0, first_mes: 1, personality: 2, creator_notes: 3 });
// fewer distinct words than this and a field has no signature; a description needs more before it is banded
const SIGNATURE_MIN_WORDS = 8;
const BAND_MIN_WORDS = 30;
/** Past this many differing bits on every field two authors' cards are not worth scoring. */
const PRUNE_BITS = 20;
/** Within this many bits two descriptions are the same text; the bands find every such pair (four 16-bit blocks). */
export const TWIN_BITS = 3;
/** Within this many bits one author's two descriptions may be one reworded. */
export const RENAMED_BITS = 12;

// a word's 32 bits: a multiply-xorshift over its characters, then the murmur3 finalizer to spread them
function hash32(s, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 0x5bd1e995); h ^= h >>> 15; }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
}

// a 64-bit simhash of a text's distinct words (two 32-bit halves), or null under the floor; also its word count
function textSimhash(text) {
    const words = new Set();
    for (const w of textTokens(String(text || '').toLowerCase())) if (!STOP_WORDS.has(w)) words.add(w);
    if (words.size < SIGNATURE_MIN_WORDS) return null;
    const v = new Int32Array(64);
    for (const word of words) {
        const lo = hash32(word, 0x2f6b9a1d), hi = hash32(word, 0x9747b28c);
        for (let i = 0; i < 32; i++) {
            v[i] += (lo >>> i) & 1 ? 1 : -1;
            v[32 + i] += (hi >>> i) & 1 ? 1 : -1;
        }
    }
    let lo = 0, hi = 0;
    for (let i = 0; i < 32; i++) {
        if (v[i] > 0) lo |= 1 << i;
        if (v[32 + i] > 0) hi |= 1 << i;
    }
    return { lo: lo >>> 0, hi: hi >>> 0, words: words.size };
}

// a text too short for a simhash (under SIGNATURE_MIN_WORDS tokens): 64 bits of its folded text
function textExactHash(text) {
    const folded = String(text || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    return folded ? { lo: hash32(folded, 0x2f6b9a1d), hi: hash32(folded, 0x9747b28c) } : null;
}

// a field's mask bit: its simhash at k, or at EXACT_BIT + k its exact hash
const EXACT_BIT = SIGNATURE_FIELDS.length;

/**
 * A card's content signature: 64 bits per SIGNATURE_FIELDS field, and the description's four bands when long enough.
 * @returns {{ sig: Buffer, mask: number, bands: number[]|null }} mask: the fields with a simhash (bit k) or an exact hash (bit EXACT_BIT + k)
 */
export function cardSignature(fields) {
    const sig = Buffer.alloc(8 * SIGNATURE_FIELDS.length);
    let mask = 0;
    let bands = null;
    SIGNATURE_FIELDS.forEach((field, k) => {
        const h = textSimhash(fields?.[field]);
        const e = h ? null : textExactHash(fields?.[field]);
        if (!h && !e) return;
        mask |= 1 << (h ? k : EXACT_BIT + k);
        sig.writeUInt32LE((h || e).lo, 8 * k);
        sig.writeUInt32LE((h || e).hi, 8 * k + 4);
        if (h && k === 0 && h.words >= BAND_MIN_WORDS) bands = [h.lo & 0xffff, h.lo >>> 16, h.hi & 0xffff, h.hi >>> 16];
    });
    return { sig, mask, bands };
}

const popcount = (x) => {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

// a field's kind in a signature: 1 a simhash, 2 an exact hash, 0 none
const kindOf = (p, k) => (!p?.sig ? 0 : p.mask & (1 << k) ? 1 : p.mask & (1 << (EXACT_BIT + k)) ? 2 : 0);

// bits apart between field ka of one and kb of another; null without both or across kinds; two exact hashes are 0 or 64 apart
function fieldDistance(a, ka, b, kb, { simhashOnly = false } = {}) {
    const kind = kindOf(a, ka);
    if (!kind || kind !== kindOf(b, kb) || (simhashOnly && kind !== 1)) return null;
    const bits = popcount(a.sig.readUInt32LE(8 * ka) ^ b.sig.readUInt32LE(8 * kb)) + popcount(a.sig.readUInt32LE(8 * ka + 4) ^ b.sig.readUInt32LE(8 * kb + 4));
    return kind === 1 || bits === 0 ? bits : 64;
}

/** The fewest differing bits over the fields both signatures have; null when they share none (or one is unknown). */
function signatureDistance(a, b) {
    let best = null;
    for (let k = 0; k < SIGNATURE_FIELDS.length; k++) {
        const d = fieldDistance(a, k, b, k);
        if (d !== null && (best === null || d < best)) best = d;
    }
    return best;
}

/** The description bits apart, simhashes only (null when either lacks one): the twin test the bands answer. */
export const descriptionDistance = (a, b) => fieldDistance(a, FIELD.description, b, FIELD.description, { simhashOnly: true });

// whether a fingerprint has a description simhash (a short template text, "WIP", is no text of the card's own)
const hasDescriptionText = (p) => kindOf(p, FIELD.description) === 1;

/**
 * Whether two cards are worth the full score: names that relate or one description, then related creators or near content.
 * @param {{ nameKey?: string, nameKey2?: string|null, listingKeys?: string[], creatorKey: string, sig: Buffer|null, mask: number, unknown?: boolean }} a a fingerprint
 */
export function worthScoring(a, b) {
    // the score's own gate, on the keys it would read: a fingerprint missing its keys cannot tell, so it passes
    if (a.nameKey !== undefined && b.nameKey !== undefined && !nameScore(namesOf(a), namesOf(b)) && !mayBeRenamed(a, b)) return false;
    if (creatorsRelate(a.creatorKey, b.creatorKey)) return true;
    // a signature still waiting on the queue cannot tell; two known ones sharing no field share no content to score
    if (a.unknown || b.unknown) return true;
    const d = signatureDistance(a, b);
    return d !== null && d <= PRUNE_BITS;
}

/** Whether two cards whose names do not relate could be one card renamed: one description, or the same author's near one. */
export function mayBeRenamed(a, b) {
    const d = descriptionDistance(a, b);
    if (d === null) return false;
    return d <= TWIN_BITS || (d <= RENAMED_BITS && creatorsRelate(a.creatorKey, b.creatorKey));
}

/** A fingerprint's own name keys: its name, and the part before a || (the keys the near-spelling arm reads). */
export const ownKeysOf = (p) => [...new Set([p.nameKey, p.nameKey2].filter(Boolean))];

// a fingerprint's names as the name arm reads them: its own in full, its listing titles exactly or as a word only
const namesOf = (p) => ({ nameVariants: ownKeysOf(p), listingVariants: p.listingKeys || [] });

/** The name keys of a card's listing titles (the names its provider pages carry), as the rule reads a name. */
export const listingKeysOf = (titles) => [...new Set((titles || []).flatMap(t => nameVariantsForDupe(t)))];

/** A card's name and creator keys: what the index finds it by (the name before a || is a key of its own). */
function fingerprintKeys(data) {
    const [nameKey = '', ...rest] = nameVariantsForDupe(data?.name);
    return { nameKey, nameKey2: rest[0] ?? null, creatorKey: creatorKey(data?.creator) };
}

/** A card's whole fingerprint: its keys and its content signature. */
export const cardFingerprint = (data) => ({ ...fingerprintKeys(data), ...cardSignature(data) });

// ============================================================================
// THE SCORE
// ============================================================================

const SCORED_TEXTS = ['description', 'first_mes', 'personality', 'scenario', 'creator_notes', 'mes_example', 'system_prompt'];

/**
 * A card's fields read once for scoring against many others: name variants, creator key, each text folded with its words on demand.
 * @param {{ listingTitles?: string[] }} [opts] the titles its provider pages carry, names of the card too
 */
export function prepareCard(fields, { listingTitles = [] } = {}) {
    const f = fields || {};
    // nameKey: the name as written, case and width folded but its suffixes kept, so "Ann" and "Ann (v2)" stay apart where it matters
    const prepared = { nameVariants: nameVariantsForDupe(f.name || ''), nameKey: String(f.name || '').normalize('NFKC').trim().toLowerCase(), listingVariants: listingKeysOf(listingTitles), creator: creatorKey(f.creator) };
    for (const k of SCORED_TEXTS) prepared[k] = prepareText(f[k]);
    return prepared;
}

// what an exact name earns; the link ranking reads it as "the name is this card's"
const NAME_EXACT_POINTS = 15;

// the name arm: exact (15), prefix (13), similarity (7 to 10) between own names; a listing title relates to an own name exactly only
function nameArm(a, b) {
    let best = 0, reason = '';
    let ownBest = 0;
    const weigh = (va, vb, own) => {
        const relation = nameRelation(va, vb);
        let points = 0, why = '';
        if (relation === 'exact') { points = NAME_EXACT_POINTS; why = own ? 'Exact name match' : 'Exact listing name match'; }
        else if (!own) return;
        else if (relation === 'prefix') { points = 13; why = 'Name prefix match'; }
        else if (va.length >= 3 && vb.length >= 3) {
            const sim = similarityAtLeast(va, vb, 0.7);
            points = Math.round(sim * 10);
            why = sim >= 0.85 ? `${Math.round(sim * 100)}% name similarity` : '';
        }
        if (own && points > ownBest) ownBest = points;
        if (points > best) { best = points; reason = why; }
    };
    const listA = a.listingVariants || [], listB = b.listingVariants || [];
    for (const va of a.nameVariants) {
        for (const vb of b.nameVariants) weigh(va, vb, true);
        for (const vb of listB) weigh(va, vb, false);
    }
    for (const va of listA) for (const vb of b.nameVariants) weigh(va, vb, false);
    // own: the cards' own names relate, which identity asks for (a card known by another's title is that card renamed)
    return { best, reason, own: ownBest > 0 };
}

// a description and a first message the same under another name: one card renamed, never two characters sharing a template
const TWIN_DESCRIPTION = 0.9;
const TWIN_FIRST_MESSAGE = 0.6;
const TWIN_MIN_WORDS = 30;
function isRenamedTwin(a, b) {
    const da = a.description.words, db = b.description.words;
    if (da.size < TWIN_MIN_WORDS || db.size < TWIN_MIN_WORDS || wordSetSimilarity(da, db) < TWIN_DESCRIPTION) return false;
    const fa = a.first_mes.words, fb = b.first_mes.words;
    return fa.size >= SIGNATURE_MIN_WORDS && fb.size >= SIGNATURE_MIN_WORDS && wordSetSimilarity(fa, fb) >= TWIN_FIRST_MESSAGE;
}

function confidenceOf(score) {
    if (score >= 60) return 'high';
    if (score >= 40) return 'medium';
    if (score >= 25) return 'low';
    return null;
}

const NO_MATCH = Object.freeze({ score: 0, breakdown: Object.freeze({}), confidence: null, contentIdentical: false, strictIdentical: false, matchReason: '', matchReasons: Object.freeze([]) });

/**
 * Two prepared cards scored: a related name (or the same card renamed) gates everything, then the creator and content arms.
 * @returns {{ score: number, breakdown: object, confidence: 'high'|'medium'|'low'|null, contentIdentical: boolean, strictIdentical: boolean, matchReason: string, matchReasons: string[], textCompared: boolean }}
 */
export function scorePrepared(a, b) {
    let score = 0;
    const breakdown = {};
    const matchReasons = [];
    const name = nameArm(a, b);
    if (name.best > 0) {
        score += name.best;
        breakdown.name = name.best;
        if (name.reason) matchReasons.push(name.reason);
    } else if (isRenamedTwin(a, b)) {
        score += 15;
        breakdown.renamed = 15;
        matchReasons.push('Same description and first message under another name');
    } else {
        return { ...NO_MATCH, breakdown: {}, matchReasons: [] };
    }

    const creatorSim = creatorSimilarity(a.creator, b.creator);
    if (creatorSim) {
        const s = Math.round(creatorSim * 15);
        score += s;
        breakdown.creator = s;
        matchReasons.push(creatorSim >= 0.95 ? 'Same creator' : 'Similar creator');
    }

    const arm = (key, floor, threshold, weight, reasonAt, label) => {
        const x = a[key], y = b[key];
        if (!(x.length > floor && y.length > floor)) return;
        const sim = textSimilarity(x, y);
        if (sim < threshold) return;
        const s = Math.round(sim * weight);
        score += s; breakdown[key] = s;
        if (label && sim >= reasonAt) matchReasons.push(`${Math.round(sim * 100)}% ${label} match`);
    };
    arm('creator_notes', 50, 0.25, 25, 0.6, 'creator notes');
    arm('description', 50, 0.25, 25, 0.6, 'description');
    arm('first_mes', 30, 0.25, 15, 0.6, 'first message');
    arm('personality', 20, 0.3, 10, 0.7, 'personality');
    arm('scenario', 20, 0.3, 5, 2, null);

    const contentScore = (breakdown.description || 0) + (breakdown.first_mes || 0) + (breakdown.personality || 0) + (breakdown.scenario || 0) + (breakdown.creator_notes || 0);
    let substantialPairs = 0;
    if (a.description.length > 50 && b.description.length > 50) substantialPairs++;
    if (a.first_mes.length > 30 && b.first_mes.length > 30) substantialPairs++;
    if (a.personality.length > 20 && b.personality.length > 20) substantialPairs++;
    if (a.creator_notes.length > 50 && b.creator_notes.length > 50) substantialPairs++;
    // the card's own text was there on both sides to compare (creator notes, a site's public blurb, say too little)
    const textCompared = (a.description.length > 50 && b.description.length > 50) || (a.first_mes.length > 30 && b.first_mes.length > 30) || (a.personality.length > 20 && b.personality.length > 20);
    // only the card's own text disagreeing costs points: two sites' public blurbs differ for the same card
    if (score >= 25 && textCompared && contentScore < 10) {
        const penalty = Math.min(score - 20, 15);
        if (penalty > 0) { score -= penalty; breakdown.divergence = -penalty; }
    }

    let contentIdentical = false, strictIdentical = false;
    // identical means the same card: its own name related (a renamed card never is) and one author, or no author on either
    if (breakdown.name && name.own && (breakdown.creator || (!a.creator && !b.creator)) && substantialPairs >= 1) {
        const has = (t) => t.length > 0;
        contentIdentical = SCORED_TEXTS.every(k => has(a[k]) === has(b[k]) && (!has(a[k]) || textSimilarity(a[k], b[k]) >= 1.0));
        if (contentIdentical) strictIdentical = SCORED_TEXTS.every(k => a[k].raw === b[k].raw);
    }
    const confidence = confidenceOf(score);
    const matchReason = matchReasons.length ? matchReasons.slice(0, 3).join(', ') : (confidence ? `${score} point similarity score` : '');
    return { score, breakdown, confidence, contentIdentical, strictIdentical, matchReason, matchReasons, ownName: name.own, textCompared };
}

// the name arm alone over two sets of name variants: 0 when the names do not relate, 7 to 15 when they do
const nameScore = (a, b) => nameArm(a, b).best;

/** Whether a score makes two cards duplicates (Find Duplicates and the import warning list them; the reader's cutoff filters). */
export const isDuplicate = (result) => !!result?.confidence;

/** Whether a score says the same character, surely enough to fold one row under another (Related's copies): medium and up, or one text. */
export const isSameCharacter = (result) => !!result && (result.contentIdentical || result.confidence === 'high' || result.confidence === 'medium');

export const CONFIDENCE_ORDER = { high: 3, medium: 2, low: 1 };

// ============================================================================
// THE PROVIDER LINK: a site's search hit against the one library card it may link to
// ============================================================================

// the card's own texts a site's public description may repeat word for word
const LINK_TEXT_FIELDS = ['creator_notes', 'description', 'first_mes'];

/**
 * A search hit against one library card: the rule's score, and whether it is surely the card, to link unasked.
 * @param {object} local the library card, prepareCard
 * @param {{ name: string, creator?: string, text?: string, listingName?: string }} hit text: the site's public description, read as its creator notes
 * @returns {{ score: number, confidence: 'high'|'medium'|'low'|null, confident: boolean, matchReason: string }}
 */
export function linkVerdict(local, hit) {
    const remote = prepareCard({ name: hit?.name, creator: hit?.creator, creator_notes: hit?.text }, { listingTitles: hit?.listingName ? [hit.listingName] : [] });
    const v = scorePrepared(local, remote);
    const exactName = v.breakdown.name === NAME_EXACT_POINTS;
    const sameAuthor = !!local.creator && local.creator === remote.creator;
    // with no real author on one side, only the site's text being the card's own says it is this card
    const confident = exactName && (sameAuthor || ((!local.creator || !remote.creator) && LINK_TEXT_FIELDS.some(k => publicTextVerdict(remote.creator_notes.raw, local[k].raw) === 'same')));
    return { score: v.score, confidence: v.confidence, confident, sameAuthor: confident && sameAuthor, literalName: exactName && !!local.nameKey && local.nameKey === remote.nameKey, matchReason: v.matchReason };
}

// ============================================================================
// THE BROWSE HINT: a remote card's name, creator and (when the site gives one) text, against the library's namesakes
// ============================================================================

// a remote card has no definition yet: an author, a text, the name's rarity; otherListing caps an unplaced same-site namesake
const HINT = Object.freeze({ sameAuthor: 95, sameText: 90, prefixAuthor: 70, prefixText: 70, renamedText: 70, base: 40, prefixBase: 25, otherAuthor: 10, textBits: 10, otherListing: 65 });

// up to 30 for a long, many-worded name: a long name is evidence on its own
function distinctiveness(key) {
    const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
    let words = 0;
    for (const w of key.split(' ')) if (w.length >= 2) words++;
    return clamp01((key.length - 12) / 20) * 20 + clamp01((words - 1) / 4) * 10;
}

// up to 25 for a name one author holds here, nothing once five do: the library says which names are common
const rarity = (authors) => 25 * Math.max(0, 1 - Math.max(0, authors - 1) / 4);

/**
 * How likely a remote card is already here, 0 to 100 (the slider's scale; the tiers sit at 65 and 85), and on what basis.
 * @param {{ name: string, creator?: string, text?: string }} hit
 * @param {Array<{ id: string, relation: 'exact'|'prefix', creatorKey: string, sig: Buffer|null, mask: number }>} holders the namesakes, graded
 * @param {{ renamedText?: boolean, textPrint?: object, heads?: Map<string, object>, listings?: Map<string, 'same'|'maybe'|'different'> }} [also] renamedText: the text is a card's description under another name; textPrint: its signature; heads: per holder, its long fields cut as the text was; listings: per holder on another listing of the hit's site, the verdict (publicTextVerdict)
 * @returns {{ score: number, basis: ''|'otherListing' }} otherListing: the score is an unplaced namesake on the hit's own site
 */
export function hintScore(hit, holders, { renamedText = false, textPrint = null, heads = null, listings = null } = {}) {
    // the site's text alone, without the first message the import warning also reads, makes a renamed card likely, never very likely
    const floor = renamedText ? HINT.renamedText : 0;
    if (!holders.length) return { score: floor, basis: '' };
    const exactHolders = holders.filter(h => h.relation === 'exact');
    // a card with no real author is an author of its own, its copies (one description) one author: twenty authorless namesakes are a common name
    const authorOf = (h) => h.creatorKey || (hasDescriptionText(h) ? `text:${h.sig.toString('hex', 0, 8)}` : `card:${h.id}`);
    const authors = new Set(exactHolders.map(authorOf)).size;
    const variants = nameVariantsForDupe(hit.name);
    if (!variants.length) return { score: 0, basis: '' };
    const author = creatorKey(hit.creator);
    // a site's text is a blurb or a description: near the holder's description, its first message or its creator notes
    const text = textPrint || (hit.text ? cardSignature({ description: hit.text }) : null);
    // simhashes only: a short text two cards share ("OC", "Enjoy!") is boilerplate, never the same text
    const nearIn = (p) => !!p && [FIELD.description, FIELD.first_mes, FIELD.creator_notes].some(k => { const d = fieldDistance(text, FIELD.description, p, k, { simhashOnly: true }); return d !== null && d <= HINT.textBits; });
    const textNear = (h) => nearIn(h) || nearIn(heads?.get(h.id));
    const scoreOf = (list) => {
        let best = 0;
        for (const relation of ['exact', 'prefix']) {
            const these = list.filter(h => h.relation === relation);
            if (!these.length) continue;
            const isExact = relation === 'exact';
            if (author && these.some(h => creatorsRelate(author, h.creatorKey))) best = Math.max(best, isExact ? HINT.sameAuthor : HINT.prefixAuthor);
            else if (these.some(textNear)) best = Math.max(best, isExact ? HINT.sameText : HINT.prefixText);
            else {
                const key = variants.reduce((x, y) => (y.length > x.length ? y : x));
                const known = these.filter(h => h.creatorKey);
                const otherAuthor = author && known.length && known.every(h => !creatorsRelate(author, h.creatorKey)) ? HINT.otherAuthor : 0;
                const evidence = distinctiveness(key) + rarity(authors) - otherAuthor;
                best = Math.max(best, Math.round(isExact ? HINT.base + evidence : HINT.prefixBase + evidence * 0.5));
            }
        }
        return best;
    };
    // the hit's own site: the author's other card counts for nothing, an unplaced one for a possible match at most
    const said = (h) => listings?.get(h.id);
    const placed = holders.filter(h => !said(h) || said(h) === 'same');
    const unplaced = holders.filter(h => said(h) === 'maybe');
    const sure = scoreOf(placed);
    const unsure = unplaced.length ? Math.min(HINT.otherListing, scoreOf([...placed, ...unplaced])) : 0;
    const score = Math.min(100, Math.max(floor, sure, unsure));
    return { score, basis: unsure > sure && unsure > floor ? 'otherListing' : '' };
}


// ============================================================================
// THE SCAN'S NAME BLOCKING (lossless for the name arm's 0.7)
// ============================================================================

/** The [lo, hi] name lengths that can reach the name arm's 0.7 against this length. */
export function similarNameLengths(len) {
    let lo = len, hi = len;
    while (lo > 3 && len - (lo - 1) <= Math.floor(0.3 * len)) lo--;
    while (hi + 1 - len <= Math.floor(0.3 * (hi + 1))) hi++;
    return [lo, hi];
}

/** Shared bigrams two names need before Levenshtein can reach 0.7 (an edit changes at most two). */
export function bigramFloor(lenA, lenB) {
    const max = Math.max(lenA, lenB);
    return Math.max(1, (max - 1) - 2 * Math.floor(0.3 * max));
}

/** A name's bigrams numbered by repeat ("la#0", "la#1"), as the q-gram lemma counts them. */
export function bigramOccurrences(s) {
    const seen = new Map();
    const out = [];
    for (let i = 0; i + 1 < s.length; i++) {
        const g = s.slice(i, i + 2);
        const k = seen.get(g) || 0;
        seen.set(g, k + 1);
        out.push(`${g}#${k}`);
    }
    return out;
}

/** The lowest bigramFloor any partner at least this long can ask; the floor is not monotonic. */
export function lowestBigramFloor(len) {
    let min = Infinity;
    for (let m = len; m < len + 10; m++) min = Math.min(min, bigramFloor(m, m));
    return min;
}
