// the advanced-filter rule model ({field, op, value}) compiled to param-bound SQL; only the card-text fields parse the card
import { extRuleOps } from './ext-query.js';
import { settingValue } from './settings-store.js';
import { httpError } from '../lib/http-error.js';
import { cardTextCandidates } from './card-text-search.js';

// a user's text as literal LIKE text (ESCAPE '\'): a % or _ in it is a character, never a wildcard
const likeLiteral = v => String(v).replace(/[\\%_]/g, ch => `\\${ch}`);
/** A user's text as a LIKE contains pattern (ESCAPE '\'), the one every store's text search binds. */
export const likeEsc = v => `%${likeLiteral(v)}%`;
const likeStart = v => `${likeLiteral(v)}%`;

// LIKE and NOCASE fold ASCII alone; past it a cased letter matches by GLOB, as a class of its cases
const casedPastAscii = (ch) => ch > '\x7f' && ch.toLowerCase() !== ch.toUpperCase();
const casesOf = (ch) => [...new Set([ch, ch.toLowerCase(), ch.toUpperCase()])].filter(f => [...f].length === 1);

/**
 * How a reader's text folds past ASCII: null when SQLite folds it whole, else its GLOB body and the starts an index seeks.
 * @returns {{ glob: string, starts: string[] } | null} starts: the lead NOCASE folds, else each case of the first letter
 */
export function caseFold(text) {
    const chars = [...String(text)];
    const at = chars.findIndex(casedPastAscii);
    if (at < 0) return null;
    const glob = chars.map((ch) => {
        const cases = casesOf(ch);
        if (cases.length > 1) return `[${cases.join('')}]`;
        return '*?['.includes(ch) ? `[${ch}]` : ch;
    }).join('');
    return { glob, starts: at > 0 ? [chars.slice(0, at).join('')] : casesOf(chars[0]) };
}

/**
 * A reader's text matched in an expression, capitals ignored past ASCII as within it; a text SQLite folds whole keeps its LIKE.
 * @param {'contains'|'starts'|'equals'} [how] a start or a whole value keeps its index seek, a prefix LIKE per start
 * @returns {{ sql: string, params: string[] }}
 */
export function textMatch(expr, text, how = 'contains') {
    const fold = caseFold(text);
    if (!fold) {
        if (how === 'equals') return { sql: `${expr} = ? COLLATE NOCASE`, params: [text] };
        return { sql: `${expr} LIKE ? ESCAPE '\\'`, params: [how === 'starts' ? likeStart(text) : likeEsc(text)] };
    }
    if (how === 'contains') return { sql: `${expr} GLOB ?`, params: [`*${fold.glob}*`] };
    // prefix LIKEs ORed plan as one index seek each; ORed ranges plan as a scan
    const seeks = fold.starts.map(() => `${expr} LIKE ? ESCAPE '\\'`).join(' OR ');
    return { sql: `(${seeks}) AND ${expr} GLOB ?`, params: [...fold.starts.map(likeStart), how === 'starts' ? `${fold.glob}*` : fold.glob] };
}

// the scripts written a word a character, and digits: one alone is a word, never a letter's prefix of every word
const ONE_CHAR_WORD = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{N}]$/u;

/** A typed text as an FTS5 query: every word required, each a prefix, a lone letter passed over; null for a text of none. */
export function ftsWordsQuery(text) {
    // a combining mark is part of its word, as the index's tokenizer reads it: a decomposed accent never splits one
    const words = String(text ?? '').match(/[\p{L}\p{N}\p{M}\p{Co}]+/gu) || [];
    // a lone letter's prefix expands to every word it starts, slow on a large library; a mark is never a letter of its own
    const kept = words.filter(w => { const c = [...w].filter(ch => !/\p{M}/u.test(ch)); return c.length > 1 || ONE_CHAR_WORD.test(c[0] || ''); });
    // composed, as stored text mostly is: a decomposed Hangul syllable is jamo the index never holds
    return kept.length ? kept.map(w => `"${w.normalize('NFC')}"*`).join(' ') : null;
}

// whether an op takes a value is derived from its builder's arity (a () => builder takes none), never a hand list

function textOps(colExpr) {
    const c = `COALESCE(${colExpr}, '')`;
    return {
        contains: v => textMatch(c, v),
        not_contains: v => { const m = textMatch(c, v); return { sql: `NOT (${m.sql})`, params: m.params }; },
        // no COALESCE on the seekable ops: wrapping the column defeats its index, and a
        // NULL never equals or starts with anything anyway
        equals: v => textMatch(colExpr, v, 'equals'),
        starts_with: v => textMatch(colExpr, v, 'starts'),
        is_empty: () => ({ sql: `${c} = ''`, params: [] }),
        is_not_empty: () => ({ sql: `${c} != ''`, params: [] }),
    };
}

// a substring or empty rule on name, nickname or creator reads idx_characters_q whole as an id set, never the rows
function qIndexOps(column) {
    const inIndex = textOps(`c2.${column}`);
    const set = (m, negate = false) => ({ sql: `c.id ${negate ? 'NOT IN' : 'IN'} (SELECT c2.id FROM characters c2 INDEXED BY idx_characters_q WHERE ${m.sql})`, params: m.params });
    return {
        ...textOps(`c.${column}`),
        contains: v => set(inIndex.contains(v)),
        not_contains: v => set(inIndex.contains(v), true),
        is_empty: () => set(inIndex.is_empty()),
        is_not_empty: () => set(inIndex.is_not_empty()),
    };
}

// a card-text field's contains asks characters_fts which cards may hold the text, then tests only those
function proseOps(column) {
    const plain = textOps(`c.${column}`);
    const narrowed = (v, db, negate) => {
        const ids = db && cardTextCandidates(db, v, column);
        if (!ids) return null;
        const m = textMatch(`COALESCE(c5.${column}, '')`, v);
        return { sql: `c.rowid ${negate ? 'NOT IN' : 'IN'} (SELECT c5.rowid FROM characters c5 WHERE c5.rowid IN (SELECT value FROM json_each(?)) AND ${m.sql})`, params: [JSON.stringify(ids), ...m.params] };
    };
    return {
        ...plain,
        contains: (v, db) => narrowed(v, db) || plain.contains(v),
        not_contains: (v, db) => narrowed(v, db, true) || plain.not_contains(v),
    };
}

// a character-scoped chat rule seeks the chat's character on the covering (id, name) index, never its row or a set of every match
function characterSetOps(ops) {
    const wrapped = {};
    for (const [name, build] of Object.entries(ops)) {
        // INDEXED BY: the planner never rates an index over the generated name as covering and would read the row
        wrapped[name] = (v) => { const r = build(v); return { sql: `EXISTS (SELECT 1 FROM characters INDEXED BY idx_characters_id_name WHERE id = ch.char_id AND ${r.sql})`, params: r.params }; };
    }
    return wrapped;
}

function numberOps(colExpr) {
    return {
        more_than: v => ({ sql: `${colExpr} > ?`, params: [Number(v)] }),
        less_than: v => ({ sql: `${colExpr} < ?`, params: [Number(v)] }),
        equals: v => ({ sql: `${colExpr} = ?`, params: [Number(v)] }),
    };
}

// client parity: a missing timestamp never matches a date comparison
function dateOps(colExpr) {
    const guard = sql => ({ sql: `(${colExpr} IS NOT NULL AND ${sql})` });
    return {
        before: v => ({ ...guard(`${colExpr} < ?`), params: [Date.parse(v)] }),
        after: v => ({ ...guard(`${colExpr} > ?`), params: [Date.parse(v)] }),
        in_the_last: v => ({ ...guard(`${colExpr} >= ?`), params: [Date.now() - Number(v) * 86400000] }),
    };
}

function boolOps(colExpr) {
    return {
        is_true: () => ({ sql: `${colExpr} = 1`, params: [] }),
        is_false: () => ({ sql: `${colExpr} = 0`, params: [] }),
    };
}

const TAG_SUBQUERY = `c.id IN (SELECT ct.char_id FROM char_tags ct JOIN tags t ON t.id = ct.tag_id
    WHERE t.name = ? COLLATE NOCASE)`;

// trigger-owned on the row (the newest sort_at across its chats), so the rule is an indexed compare
const LAST_CHAT = 'c.last_chat_at';
const PAGE_NAME_MATCH = op => v => {
    const inner = textOps('pl.page_name')[op](v);
    return {
        sql: `EXISTS (SELECT 1 FROM provider_links pl WHERE pl.char_id = c.id AND ${inner.sql})`,
        params: inner.params,
    };
};

function namePreferenceIds(db, want) {
    const prefs = settingValue(db, 'namePreferences', {});
    // a stored string or list is no map: walked as one it would name its indexes as ids
    if (typeof prefs !== 'object' || Array.isArray(prefs)) return [];
    // keys are character uuids
    return Object.entries(prefs)
        .filter(([, v]) => want === null ? !!v : v === want)
        .map(([charId]) => charId);
}

function idListClause(ids, negate) {
    if (!ids.length) return { sql: negate ? '1 = 1' : '1 = 0', params: [] };
    // one bound JSON array, so the list length never meets SQLite's variable limit
    return { sql: `c.id ${negate ? 'NOT IN' : 'IN'} (SELECT value FROM json_each(?))`, params: [JSON.stringify(ids.map(String))] };
}

// null-prototype like CHAT_SORTS/CHAR_SORTS: the `in` guard below walks the prototype
// chain on a plain literal, so field=constructor passed it and 500'd downstream.
const RULE_BUILDERS = Object.assign(Object.create(null), {
    name: qIndexOps('name'),
    creator: qIndexOps('creator'),
    creatorNotes: proseOps('creator_notes'),
    version: textOps('c.character_version'),
    nickname: qIndexOps('nickname'),
    // the card's prose: a contains narrows through characters_fts, an empty test reads every card
    description: proseOps('description'),
    personality: proseOps('personality'),
    scenario: proseOps('scenario'),
    firstMessage: proseOps('first_mes'),
    exampleDialogue: proseOps('mes_example'),
    // the text search, a different question from systemPrompt's boolean "has one", so its own field
    systemPromptText: proseOps('system_prompt'),
    postHistoryInstructions: proseOps('post_history_instructions'),
    depthPrompt: proseOps('depth_prompt'),
    listingName: {
        contains: PAGE_NAME_MATCH('contains'),
        not_contains: v => { const m = PAGE_NAME_MATCH('contains')(v); return { sql: `NOT ${m.sql}`, params: m.params }; },
        equals: PAGE_NAME_MATCH('equals'),
        starts_with: PAGE_NAME_MATCH('starts_with'),
        is_empty: () => ({ sql: `NOT EXISTS (SELECT 1 FROM provider_links pl WHERE pl.char_id = c.id AND COALESCE(pl.page_name, '') != '')`, params: [] }),
        is_not_empty: () => ({ sql: `EXISTS (SELECT 1 FROM provider_links pl WHERE pl.char_id = c.id AND COALESCE(pl.page_name, '') != '')`, params: [] }),
    },
    tags: {
        includes: v => ({ sql: TAG_SUBQUERY, params: [v] }),
        excludes: v => ({ sql: `NOT (${TAG_SUBQUERY})`, params: [v] }),
    },
    favorite: boolOps('c.fav'),
    providerLink: {
        is_linked: () => ({ sql: 'EXISTS (SELECT 1 FROM provider_links pl WHERE pl.char_id = c.id)', params: [] }),
        is_not_linked: () => ({ sql: 'NOT EXISTS (SELECT 1 FROM provider_links pl WHERE pl.char_id = c.id)', params: [] }),
        linked_to: v => ({ sql: 'EXISTS (SELECT 1 FROM provider_links pl WHERE pl.char_id = c.id AND pl.provider_id = ?)', params: [v] }),
        not_linked_to: v => ({ sql: 'NOT EXISTS (SELECT 1 FROM provider_links pl WHERE pl.char_id = c.id AND pl.provider_id = ?)', params: [v] }),
    },
    dateAdded: dateOps('c.imported_at'),
    dateCreated: dateOps('c.created_at'),
    dateModified: dateOps('c.updated_at'),
    // linked lorebooks are char_worlds rows, the shape tags have, not a text match on the card
    linkedLorebook: {
        is_linked: () => ({ sql: 'EXISTS (SELECT 1 FROM char_worlds cw WHERE cw.char_id = c.id)', params: [] }),
        is_not_linked: () => ({ sql: 'NOT EXISTS (SELECT 1 FROM char_worlds cw WHERE cw.char_id = c.id)', params: [] }),
        equals: v => { const m = textMatch('cw.world_name', v, 'equals'); return { sql: `EXISTS (SELECT 1 FROM char_worlds cw WHERE cw.char_id = c.id AND ${m.sql})`, params: m.params }; },
        contains: v => { const m = textMatch('cw.world_name', v); return { sql: `EXISTS (SELECT 1 FROM char_worlds cw WHERE cw.char_id = c.id AND ${m.sql})`, params: m.params }; },
        not_contains: v => { const m = textMatch('cw.world_name', v); return { sql: `NOT EXISTS (SELECT 1 FROM char_worlds cw WHERE cw.char_id = c.id AND ${m.sql})`, params: m.params }; },
    },
    lastChat: {
        ...dateOps(LAST_CHAT),
        never: () => ({ sql: `${LAST_CHAT} IS NULL`, params: [] }),
        ever: () => ({ sql: `${LAST_CHAT} IS NOT NULL`, params: [] }),
    },
    tokens: numberOps('c.token_estimate'),
    playlist: {
        in: v => ({ sql: 'c.id IN (SELECT pc.char_id FROM playlist_chars pc WHERE pc.playlist_id = ?)', params: [v] }),
        not_in: v => ({ sql: 'c.id NOT IN (SELECT pc.char_id FROM playlist_chars pc WHERE pc.playlist_id = ?)', params: [v] }),
        in_any: () => ({ sql: 'EXISTS (SELECT 1 FROM playlist_chars pc WHERE pc.char_id = c.id)', params: [] }),
        not_in_any: () => ({ sql: 'NOT EXISTS (SELECT 1 FROM playlist_chars pc WHERE pc.char_id = c.id)', params: [] }),
    },
    embeddedLorebook: boolOps('c.has_lorebook'),
    systemPrompt: boolOps('c.has_system_prompt'),
    altGreetings: numberOps('c.alt_greetings'),
    cardSpec: {
        equals: v => ({ sql: 'c.spec_version = ?', params: [v] }),
    },
    // the character's own id (what its export carries), never an alias row; every character has one, so none is empty
    uid: {
        contains: v => ({ sql: `c.id LIKE ? ESCAPE '\\'`, params: [likeEsc(v)] }),
        equals: v => ({ sql: 'c.id = ?', params: [String(v).trim().toLowerCase()] }),
        is_empty: () => ({ sql: '0', params: [] }),
        is_not_empty: () => ({ sql: '1', params: [] }),
    },
    playlistName: {
        contains: v => {
            const m = textMatch('p.name', v);
            return { sql: `EXISTS (SELECT 1 FROM playlist_chars pc JOIN playlists p ON p.id = pc.playlist_id
                WHERE pc.char_id = c.id AND ${m.sql})`, params: m.params };
        },
    },
    // needs the settings map, resolved at build time via ctx.db
    nameOverride: null,
});

// the chats list's rule model over its aliases (ch the chat, c its character): character fields ARE the character builders
const CHAT_WORLD_EXISTS = cond => `EXISTS (SELECT 1 FROM chat_worlds cw WHERE cw.chat_id = ch.id${cond})`;
// off the full-text index: a LIKE over every message would read all chat text
const CHAT_MESSAGE_MATCH = (v) => {
    const match = ftsWordsQuery(v);
    if (!match) return { sql: '0', params: [] };
    return { sql: `ch.id IN (SELECT cm.chat_id FROM chat_messages cm WHERE cm.rowid IN (SELECT f.rowid FROM chat_messages_fts f WHERE f.chat_messages_fts MATCH ?))`, params: [match] };
};
const CHAT_RULE_BUILDERS = Object.assign(Object.create(null), {
    chatName: textOps('ch.name'),
    charName: characterSetOps(textOps('name')),
    messageCount: numberOps('ch.message_count'),
    messageText: {
        contains: CHAT_MESSAGE_MATCH,
        not_contains: v => { const m = CHAT_MESSAGE_MATCH(v); return { sql: `NOT (${m.sql})`, params: m.params }; },
    },
    lastMessage: dateOps('ch.last_mes_at'),
    chatLorebook: {
        contains: v => { const m = textMatch('cw.world_name', v); return { sql: CHAT_WORLD_EXISTS(` AND ${m.sql}`), params: m.params }; },
        not_contains: v => { const m = textMatch('cw.world_name', v); return { sql: `NOT ${CHAT_WORLD_EXISTS(` AND ${m.sql}`)}`, params: m.params }; },
        equals: v => { const m = textMatch('cw.world_name', v, 'equals'); return { sql: CHAT_WORLD_EXISTS(` AND ${m.sql}`), params: m.params }; },
        is_empty: () => ({ sql: `NOT ${CHAT_WORLD_EXISTS('')}`, params: [] }),
        is_not_empty: () => ({ sql: CHAT_WORLD_EXISTS(''), params: [] }),
    },
    charFavorite: RULE_BUILDERS.favorite,
    charTags: RULE_BUILDERS.tags,
    charProviderLink: RULE_BUILDERS.providerLink,
    charPlaylist: RULE_BUILDERS.playlist,
});

/** Compile a rule list into {clauses, params}; 400 on unknown fields, ops or bad rules. A rule missing its value is skipped. */
export function buildRuleClauses(db, rules) {
    // an extension's rule field (ext.<id>.<key>) for an account that has it on
    return compileRules(RULE_BUILDERS, db, rules, extRuleOps);
}

/** The chats list's form of buildRuleClauses, same contract over CHAT_RULE_BUILDERS. */
export function buildChatRuleClauses(db, rules) {
    return compileRules(CHAT_RULE_BUILDERS, db, rules);
}

function compileRules(builders, db, rules, extraOps = null) {
    if (!Array.isArray(rules)) throw httpError(400, 'rules must be an array');
    if (rules.length > 50) throw httpError(400, 'too many rules (max 50)');
    const clauses = [];
    const params = [];
    for (const rule of rules) {
        if (!rule || typeof rule !== 'object') throw httpError(400, 'each rule must be an object');
        const { field, op } = rule;
        const value = rule.value === undefined || rule.value === null ? '' : String(rule.value);
        // a core field by presence (nameOverride's builder is null, resolved below); an
        // extension's only when the core has no such field
        const core = field in builders;
        const fieldOps = core ? builders[field] : extraOps?.(db, field);
        if (!core && !fieldOps) throw httpError(400, `unknown rule field '${field}'; valid: ${Object.keys(builders).join(', ')}`);

        if (field === 'nameOverride') {
            if (!['has_override', 'no_override', 'set_to_card', 'set_to_listing'].includes(op)) {
                throw httpError(400, `unknown op '${op}' for nameOverride`);
            }
            const want = op === 'set_to_card' ? 'card' : op === 'set_to_listing' ? 'listing' : null;
            const ids = namePreferenceIds(db, want);
            const built = idListClause(ids, op === 'no_override');
            clauses.push(built.sql);
            params.push(...built.params);
            continue;
        }

        // own-key only: the op groups are plain literals, so op=constructor would
        // otherwise resolve to an inherited function and pass the truthy check
        const builder = Object.hasOwn(fieldOps, op) ? fieldOps[op] : undefined;
        if (!builder) throw httpError(400, `unknown op '${op}' for field '${field}'; valid: ${Object.keys(fieldOps).join(', ')}`);
        if (builder.length > 0 && !value) continue;
        const built = builder(value, db);
        if (built.params.some(p => typeof p === 'number' && Number.isNaN(p))) {
            throw httpError(400, `rule '${field} ${op}' needs a valid ${field.includes('date') || op === 'in_the_last' ? 'date/number' : 'number'} value`);
        }
        clauses.push(built.sql);
        params.push(...(built.params || []));
    }
    return { clauses, params };
}
