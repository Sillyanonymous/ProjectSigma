// The duplicate matcher, one implementation for the library scan and the pre-import check. no name match, no score

const VERSION_SUFFIX = /\s*[\(\[\{]?\s*v(?:er(?:sion)?)?\.?\s*\d+[\)\]\}]?\s*$/i;
const VERSION_DASH = /\s*-?\s*v\d+(\.\d+)*$/i;
const COMMON_SUFFIX = /\s*[\(\[\{]?(?:updated?|fixed?|new|old|alt(?:ernate)?|edit(?:ed)?|copy|backup|nsfw)[\)\]\}]?\s*$/i;

/** A name without its version and edit suffixes, lowercased, single-spaced. */
export function normalizeCharName(name) {
    if (!name) return '';
    return String(name).toLowerCase().trim()
        .replace(VERSION_SUFFIX, '')
        .replace(VERSION_DASH, '')
        .replace(COMMON_SUFFIX, '')
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
export function isNamePrefixMatch(a, b) {
    if (!a || !b || a.length === b.length) return false;
    const shorter = a.length < b.length ? a : b;
    const longer = a.length < b.length ? b : a;
    if (shorter.length < 4) return false;
    return longer.startsWith(shorter) && /[\s\-|:,.]/.test(longer[shorter.length]);
}

/** How two normalized names relate: 'exact', 'prefix' (one a word of the other), or '' (a name under three characters relates to nothing). */
export function nameRelation(a, b) {
    if (a.length < 3 || b.length < 3) return '';
    if (a === b) return 'exact';
    return isNamePrefixMatch(a, b) ? 'prefix' : '';
}

/**
 * A name probe's rows graded by the duplicate rule, so the browse hint and the import warning agree.
 * @param {string} rawName
 * @param {Array<{id: string, name: string, creator: string|null}>} rows
 * @returns {{variants: string[], matches: Array<{id: string, name: string, creator: string|null, relation: string, on: string, as: string}>}}
 */
export function gradeNameMatches(rawName, rows) {
    const variants = nameVariantsForDupe(rawName).filter(v => v.length >= 3);
    const matches = [];
    for (const row of rows) {
        let best = null;
        for (const as of nameVariantsForDupe(row.name)) {
            for (const on of variants) {
                const relation = nameRelation(on, as);
                if (relation && (!best || (relation === 'exact' && best.relation !== 'exact'))) best = { relation, on, as };
            }
        }
        if (best) matches.push({ ...row, ...best });
    }
    return { variants, matches };
}

/** Levenshtein similarity in [0, 1]; 0 when the lengths differ by more than half. */
export function stringSimilarity(str1, str2) {
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

/** Word-set Jaccard for texts of 50 characters and more, Levenshtein below that. */
export function contentSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;
    const t1 = String(text1).toLowerCase().trim();
    const t2 = String(text2).toLowerCase().trim();
    if (t1 === t2) return 1;
    if (!t1 || !t2) return 0;
    if (t1.length < 50 || t2.length < 50) return stringSimilarity(t1, t2);
    const words = (text) => new Set((text.match(/\b\w{3,}\b/g) || []).map(w => w.toLowerCase()));
    return wordSetSimilarity(words(t1), words(t2));
}

/** Two provider paths name the same card: equal, or one beginning the other (never bare numbers). */
export function providerPathsMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (/^\d+$/.test(a) || /^\d+$/.test(b)) return false;
    return a.startsWith(b) || b.startsWith(a);
}

// the words of a text long enough to compare by words (three letters and more), else null
const wordsOf = (text) => {
    if (!text || text.length < 50) return null;
    return new Set(String(text).toLowerCase().match(/\b\w{3,}\b/g) || []);
};

// placeholder creators are no identity: two cards by 'Anonymous' share no creator. browse-view keeps the same list
export const PLACEHOLDER_CREATOR_RE = /^(anonymous|anon|unknown|deleted|n\/?a|none|user)$/;
const creatorSignal = (raw) => (PLACEHOLDER_CREATOR_RE.test(String(raw || '').toLowerCase().trim()) ? '' : String(raw || ''));

/** The fast pass's record, normalized once so the pair loop never lowercases or splits. */
export function normalizeRow(fields) {
    const name = fields.name || '';
    const creator = creatorSignal(fields.creator).toLowerCase().trim();
    const description = fields.description || '';
    const firstMes = fields.first_mes || '';
    const personality = fields.personality || '';
    const scenario = fields.scenario || '';
    const creatorNotes = fields.creator_notes || '';
    const mesExample = fields.mes_example || '';
    const systemPrompt = fields.system_prompt || '';
    return {
        name,
        nameLower: name.toLowerCase().trim(),
        nameVariants: nameVariantsForDupe(name),
        creator,
        creatorCompact: creator.replace(/[\s_-]/g, ''),
        description, firstMes, personality, scenario, creatorNotes, mesExample, systemPrompt,
        descWords: wordsOf(description),
        firstMesWords: wordsOf(firstMes),
        persWords: wordsOf(personality),
        scenWords: wordsOf(scenario),
        creatorNotesWords: wordsOf(creatorNotes),
        mesExWords: wordsOf(mesExample),
        sysPromptWords: wordsOf(systemPrompt),
    };
}

// the name arm both passes share: the best of exact (15), prefix (13) and similarity (7 to 10)
function nameArm(variantsA, variantsB) {
    let best = 0, reason = '';
    for (const va of variantsA) {
        if (va.length < 3) continue;
        for (const vb of variantsB) {
            if (vb.length < 3) continue;
            const relation = nameRelation(va, vb);
            if (relation === 'exact') {
                if (15 > best) { best = 15; reason = 'Exact name match'; }
            } else if (relation === 'prefix') {
                if (13 > best) { best = 13; reason = 'Name prefix match'; }
            } else {
                const sim = stringSimilarity(va, vb);
                if (sim >= 0.7) {
                    const s = Math.round(sim * 10);
                    if (s > best) { best = s; reason = sim >= 0.85 ? `${Math.round(sim * 100)}% name similarity` : ''; }
                }
            }
        }
    }
    return { best, reason };
}

function creatorArm(creatorA, creatorB, compactA, compactB, breakdown, matchReasons) {
    if (!creatorA || !creatorB) return 0;
    if (compactA && compactA === compactB) {
        breakdown.creator = 15;
        matchReasons.push('Same creator');
        return 15;
    }
    const sim = stringSimilarity(creatorA, creatorB);
    if (sim < 0.75) return 0;
    const s = Math.round(sim * 15);
    breakdown.creator = s;
    matchReasons.push(sim >= 0.95 ? 'Same creator' : 'Similar creator');
    return s;
}

function confidenceOf(score) {
    if (score >= 60) return 'high';
    if (score >= 40) return 'medium';
    if (score >= 25) return 'low';
    return null;
}

function reasonOf(matchReasons, confidence, score) {
    if (matchReasons.length > 0) return matchReasons.slice(0, 3).join(', ');
    return confidence ? `${score} point similarity score` : '';
}

/**
 * The fast pass over two normalized records (name, creator, notes and whatever content the
 * records carry): the scan's candidate filter. No name match, no score.
 */
export function fastSimilarity(normA, normB) {
    let score = 0;
    const breakdown = {};
    const matchReasons = [];
    const name = nameArm(normA.nameVariants, normB.nameVariants);
    if (name.best > 0) {
        score += name.best;
        breakdown.name = name.best;
        if (name.reason) matchReasons.push(name.reason);
    }
    if (!breakdown.name) return { score: 0, breakdown: {}, confidence: null, contentIdentical: false, strictIdentical: false, matchReason: '', matchReasons: [] };
    score += creatorArm(normA.creator, normB.creator, normA.creatorCompact, normB.creatorCompact, breakdown, matchReasons);

    if (normA.creatorNotesWords && normB.creatorNotesWords) {
        const sim = wordSetSimilarity(normA.creatorNotesWords, normB.creatorNotesWords);
        if (sim >= 0.25) {
            const s = Math.round(sim * 25);
            score += s; breakdown.creator_notes = s;
            if (sim >= 0.6) matchReasons.push(`${Math.round(sim * 100)}% creator notes match`);
        }
    } else if (normA.creatorNotes && normB.creatorNotes && normA.creatorNotes.length > 10 && normB.creatorNotes.length > 10) {
        const sim = stringSimilarity(normA.creatorNotes, normB.creatorNotes);
        if (sim >= 0.25) { const s = Math.round(sim * 25); score += s; breakdown.creator_notes = s; }
    }
    if (normA.descWords && normB.descWords) {
        const sim = wordSetSimilarity(normA.descWords, normB.descWords);
        if (sim >= 0.3) {
            const s = Math.round(sim * 20);
            score += s; breakdown.description = s;
            if (sim >= 0.7) matchReasons.push(`${Math.round(sim * 100)}% description match`);
        }
    } else if (normA.description && normB.description) {
        const sim = stringSimilarity(normA.description, normB.description);
        if (sim >= 0.3) { const s = Math.round(sim * 20); score += s; breakdown.description = s; }
    }
    if (normA.firstMesWords && normB.firstMesWords) {
        const sim = wordSetSimilarity(normA.firstMesWords, normB.firstMesWords);
        if (sim >= 0.3) {
            const s = Math.round(sim * 15);
            score += s; breakdown.first_mes = s;
            if (sim >= 0.7) matchReasons.push(`${Math.round(sim * 100)}% first message match`);
        }
    } else if (normA.firstMes && normB.firstMes) {
        const sim = stringSimilarity(normA.firstMes, normB.firstMes);
        if (sim >= 0.3) { const s = Math.round(sim * 15); score += s; breakdown.first_mes = s; }
    }
    if (normA.persWords && normB.persWords) {
        const sim = wordSetSimilarity(normA.persWords, normB.persWords);
        if (sim >= 0.3) { const s = Math.round(sim * 10); score += s; breakdown.personality = s; }
    }
    if (normA.scenWords && normB.scenWords) {
        const sim = wordSetSimilarity(normA.scenWords, normB.scenWords);
        if (sim >= 0.3) { const s = Math.round(sim * 5); score += s; breakdown.scenario = s; }
    }

    const contentScore = (breakdown.description || 0) + (breakdown.first_mes || 0) + (breakdown.personality || 0) + (breakdown.scenario || 0) + (breakdown.creator_notes || 0);
    let substantialPairs = 0;
    if (normA.descWords && normB.descWords) substantialPairs++;
    if (normA.firstMesWords && normB.firstMesWords) substantialPairs++;
    if (normA.persWords && normB.persWords) substantialPairs++;
    if (normA.creatorNotesWords && normB.creatorNotesWords) substantialPairs++;
    if (score >= 25 && substantialPairs >= 1 && contentScore < 10) {
        const penalty = Math.min(score - 20, 15);
        if (penalty > 0) { score -= penalty; breakdown.divergence = -penalty; }
    }

    let contentIdentical = false, strictIdentical = false;
    if (breakdown.name && breakdown.creator && substantialPairs >= 1) {
        const has = (t) => !!(t && t.length > 0);
        const asymmetric = (a, b) => has(a) !== has(b);
        const wordsMismatch = (wA, wB, tA, tB) => has(tA) && has(tB) && wA && wB && wordSetSimilarity(wA, wB) < 1.0;
        contentIdentical = true;
        const pairs = [
            [normA.description, normB.description, normA.descWords, normB.descWords],
            [normA.firstMes, normB.firstMes, normA.firstMesWords, normB.firstMesWords],
            [normA.personality, normB.personality, normA.persWords, normB.persWords],
            [normA.scenario, normB.scenario, normA.scenWords, normB.scenWords],
            [normA.creatorNotes, normB.creatorNotes, normA.creatorNotesWords, normB.creatorNotesWords],
            [normA.mesExample, normB.mesExample, normA.mesExWords, normB.mesExWords],
            [normA.systemPrompt, normB.systemPrompt, normA.sysPromptWords, normB.sysPromptWords],
        ];
        for (const [tA, tB, wA, wB] of pairs) if (asymmetric(tA, tB) || wordsMismatch(wA, wB, tA, tB)) contentIdentical = false;
        if (contentIdentical) {
            strictIdentical = pairs.every(([tA, tB]) => (tA || '') === (tB || ''));
        }
    }
    const confidence = confidenceOf(score);
    return { score, breakdown, confidence, contentIdentical, strictIdentical, matchReason: reasonOf(matchReasons, confidence, score), matchReasons };
}

/** The full pass over two cards' fields: the scan's group re-score and the pre-import check's score. */
export function fullSimilarity(fieldsA, fieldsB) {
    const f = (o, k) => (o && o[k]) || '';
    let score = 0;
    const breakdown = {};
    const matchReasons = [];
    const name = nameArm(nameVariantsForDupe(f(fieldsA, 'name')), nameVariantsForDupe(f(fieldsB, 'name')));
    if (name.best > 0) {
        score += name.best;
        breakdown.name = name.best;
        if (name.reason) matchReasons.push(name.reason);
    }
    const creatorA = creatorSignal(f(fieldsA, 'creator')), creatorB = creatorSignal(f(fieldsB, 'creator'));
    const compact = (c) => String(c).toLowerCase().trim().replace(/[\s_-]/g, '');
    score += creatorArm(creatorA, creatorB, compact(creatorA), compact(creatorB), breakdown, matchReasons);

    const notesA = f(fieldsA, 'creator_notes'), notesB = f(fieldsB, 'creator_notes');
    const descA = f(fieldsA, 'description'), descB = f(fieldsB, 'description');
    const firstMesA = f(fieldsA, 'first_mes'), firstMesB = f(fieldsB, 'first_mes');
    const persA = f(fieldsA, 'personality'), persB = f(fieldsB, 'personality');
    const scenA = f(fieldsA, 'scenario'), scenB = f(fieldsB, 'scenario');
    const arm = (a, b, floor, threshold, weight, key, reasonAt, label) => {
        if (!(a && b && a.length > floor && b.length > floor)) return;
        const sim = contentSimilarity(a, b);
        if (sim < threshold) return;
        const s = Math.round(sim * weight);
        score += s; breakdown[key] = s;
        if (label && sim >= reasonAt) matchReasons.push(`${Math.round(sim * 100)}% ${label} match`);
    };
    arm(notesA, notesB, 50, 0.25, 25, 'creator_notes', 0.6, 'creator notes');
    arm(descA, descB, 50, 0.25, 25, 'description', 0.6, 'description');
    arm(firstMesA, firstMesB, 30, 0.25, 15, 'first_mes', 0.6, 'first message');
    arm(persA, persB, 20, 0.3, 10, 'personality', 0.7, 'personality');
    arm(scenA, scenB, 20, 0.3, 5, 'scenario', 2, null);

    const contentScore = (breakdown.description || 0) + (breakdown.first_mes || 0) + (breakdown.personality || 0) + (breakdown.scenario || 0) + (breakdown.creator_notes || 0);
    let substantialPairs = 0;
    if (descA && descB && descA.length > 50 && descB.length > 50) substantialPairs++;
    if (firstMesA && firstMesB && firstMesA.length > 30 && firstMesB.length > 30) substantialPairs++;
    if (persA && persB && persA.length > 20 && persB.length > 20) substantialPairs++;
    if (notesA && notesB && notesA.length > 50 && notesB.length > 50) substantialPairs++;
    if (score >= 25 && substantialPairs >= 1 && contentScore < 10) {
        const penalty = Math.min(score - 20, 15);
        if (penalty > 0) { score -= penalty; breakdown.divergence = -penalty; }
    }

    let contentIdentical = false, strictIdentical = false;
    if (breakdown.name && breakdown.creator && substantialPairs >= 1) {
        const has = (t) => !!(t && t.length > 0);
        const asymmetric = (a, b) => has(a) !== has(b);
        const textMismatch = (a, b) => has(a) && has(b) && contentSimilarity(a, b) < 1.0;
        const pairs = [
            [descA, descB], [firstMesA, firstMesB], [persA, persB], [scenA, scenB], [notesA, notesB],
            [f(fieldsA, 'mes_example'), f(fieldsB, 'mes_example')], [f(fieldsA, 'system_prompt'), f(fieldsB, 'system_prompt')],
        ];
        contentIdentical = pairs.every(([a, b]) => !asymmetric(a, b) && !textMismatch(a, b));
        if (contentIdentical) strictIdentical = pairs.every(([a, b]) => (a || '') === (b || ''));
    }
    const confidence = confidenceOf(score);
    return { score, breakdown, confidence, contentIdentical, strictIdentical, matchReason: reasonOf(matchReasons, confidence, score), matchReasons };
}

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

export const CONFIDENCE_ORDER = { high: 3, medium: 2, low: 1 };
