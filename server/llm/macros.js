// The macro vocabulary and the environment a chat's text expands in; names and answers are SillyTavern's
import moment from 'moment';
import seedrandom from 'seedrandom';
import { BRANCH_MARK, createEngine, isFalseBoolean, mayHoldMacros, MacroError, normalize, topLevelMacros, trimScoped } from './macro-engine.js';
import { CHAT_CARD_OVERRIDES } from '../db/chats-store.js';
import { parseStDate } from '../lib/st-date.js';
import { DEFAULT_MAIN_PROMPT, exampleTexts } from './preset.js';

// ================================================================ the definitions table

const STRING = 'string';
const INTEGER = 'integer';
const NUMBER = 'number';

const DEFINITIONS = new Map(); // lower-case name or alias -> definition
const PRIMARY = [];

/**
 * One macro as the engine reads it, the app's and an extension's alike; a refused call stays as written.
 * @param {object} spec args [{ type, optional, max }], list (true or { min, max }), strict, delay (args arrive unexpanded)
 */
export function macroDefinition(name, { aliases = [], args = [], list = false, strict = true, delay = false, handler }) {
    const firstOptional = args.findIndex(a => a.optional);
    return {
        name, aliases, args, delay, strict, handler,
        minArgs: firstOptional === -1 ? args.length : firstOptional,
        maxArgs: args.length,
        list: list ? { min: list.min ?? 0, max: list.max ?? null } : null,
    };
}

// one of the app's own, into the table the vocabulary answers from
function define(name, spec) {
    const def = macroDefinition(name, spec);
    PRIMARY.push(def);
    for (const key of [name, ...def.aliases]) DEFINITIONS.set(key.toLowerCase(), def);
    return def;
}

const arg = (type = STRING, optional = false, bounds = {}) => ({ type, optional, ...bounds });

// a count past these stays as written: the server's one thread pays here, where ST's browser paid its own
const REPEAT_MAX = 1000;
const DICE_MAX = 1000;
const SIDES_MAX = 1000000;
// a variable's text: an add that appends doubles it, and 26 of them built 134M characters that every
// later build parses and clones
const VARIABLE_MAX = 1000000;

// ---------------------------------------------------------------- utility

define('//', { aliases: ['comment'], args: [arg()], list: true, strict: false, handler: () => '' });
define('space', { args: [arg(INTEGER, true, { max: REPEAT_MAX })], handler: ({ unnamedArgs: [count] }) => ' '.repeat(Number(count ?? 1)) });
define('newline', { args: [arg(INTEGER, true, { max: REPEAT_MAX })], handler: ({ unnamedArgs: [count] }) => '\n'.repeat(Number(count ?? 1)) });
define('noop', { handler: () => '' });
// Unscoped, it marks where the newlines around it are eaten once everything else has resolved.
define('trim', { args: [arg(STRING, true)], handler: ({ unnamedArgs: [content], isScoped }) => (isScoped ? content ?? '' : '{{trim}}') });
define('reverse', { args: [arg()], handler: ({ unnamedArgs: [value] }) => Array.from(value).reverse().join('') });
define('input', { handler: ({ env }) => env.input ?? '' });
define('banned', { args: [arg()], handler: () => '' }); // a text-completion ban list; a chat completion has none
// the build records the outlets it wrote, so the lore panel knows an entry was sent
define('outlet', {
    args: [arg()],
    handler: ({ unnamedArgs: [key], env }) => {
        if (!key) return '';
        env.outletsRead?.add(key);
        return env.outlets?.[key] || '';
    },
});

const VARIABLE_CONDITION = /^([.$])([a-zA-Z](?:[\w-]*\w)?)$/;

// CONTENT before and after its first {{else}} outside a nested {{if}}; no else part when it has none
function branchesOf(content) {
    if (!content.includes('else')) return [content, null];
    let depth = 0;
    for (const m of topLevelMacros(content)) {
        if (m.name === 'if') {
            if (m.closing) depth--;
            else if (m.argCount === 1) depth++;
        } else if (m.name === 'else' && depth === 0) {
            return [content.slice(0, m.s), content.slice(m.e + 1)];
        }
    }
    return [content, null];
}

// the branch a call takes, null for none; kept out of the handler's frame, which a deep nesting stacks
function chosenBranch(call) {
    const [written, content] = call.unnamedArgs;
    const bang = /^\s*!\s*/.exec(written);
    let condition = call.expand(bang ? written.slice(bang[0].length) : written);
    const variable = VARIABLE_CONDITION.exec(condition);
    if (variable) condition = call.expand(`{{${variable[1] === '.' ? 'getvar' : 'getglobalvar'}::${variable[2]}}}`);
    else if (primaryOf(condition, call.env)?.minArgs === 0) condition = call.expand(`{{${condition}}}`);
    const falsy = (condition === '' || isFalseBoolean(condition)) !== !!bang;
    const [then, otherwise] = branchesOf(content);
    return falsy ? otherwise : then;
}

define('if', {
    args: [arg(), arg()],
    delay: true,
    handler: (call) => {
        const branch = chosenBranch(call);
        if (branch === null) return '';
        const out = call.expand(branch);
        return call.preserve ? out : trimScoped(out);
    },
});
define('else', { handler: () => BRANCH_MARK });

// ---------------------------------------------------------------- dice and lists

const DICE_RE = /^([1-9]\d*)?d([1-9]\d*)([+-]\d+)?$/i;
define('roll', {
    args: [arg()],
    handler: ({ unnamedArgs: [formula], env }) => {
        const f = /^\d+$/.test(formula) ? `1d${formula}` : formula;
        const m = DICE_RE.exec(f);
        if (!m) return '';
        const dice = Number(m[1]) || 1;
        const sides = Number(m[2]);
        if (dice > DICE_MAX || sides > SIDES_MAX) throw new MacroError(`roll: at most ${DICE_MAX}d${SIDES_MAX}`);
        let total = Number(m[3]) || 0;
        for (let k = 0; k < dice; k++) total += 1 + Math.floor(env.random() * sides);
        return String(total);
    },
});

// one argument is split on :: or else on commas a backslash does not escape; several are the items
function listItems(list) {
    if (list.length !== 1) return list;
    const [only] = list;
    if (only.includes('::')) return only.split('::').map(s => s.trim());
    return only.split(/(?<!\\),/).map(s => s.trim().replace(/\\,/g, ','));
}

define('random', {
    list: true,
    handler: ({ list, env }) => {
        const items = listItems(list);
        return items.length ? items[Math.floor(env.random() * items.length)] : '';
    },
});

// stable per chat and position, seeded the way ST seeds it, so an imported chat picks what it picked there
define('pick', {
    list: true,
    handler: ({ list, env, globalOffset }) => {
        const items = listItems(list);
        if (!items.length) return '';
        const parts = [env.chat.idHash(), env.contentHash, globalOffset, env.chat.metadata?.pick_reroll_seed || null].filter(x => x !== null);
        const rng = seedrandom(String(stringHash(parts.join('-'))));
        return items[Math.floor(rng() * items.length)];
    },
});

// ---------------------------------------------------------------- names and the card

/** The persona pronoun macros (JanitorAI's, not ST's): the name, the persona's form, the word an empty form answers. */
export const PRONOUN_MACROS = Object.freeze([
    ['sub', 'sub', 'they'], ['obj', 'obj', 'them'], ['poss', 'poss', 'their'], ['poss_p', 'possP', 'theirs'], ['ref', 'ref', 'themselves'],
]);

/** A pronoun form in the case its call is written in: lower as stored, Capitalised, UPPER, any other mix as stored. */
export function pronounInCase(written, form, word) {
    const text = (typeof form === 'string' && form.trim()) || word;
    const name = String(written ?? '').trim();
    if (name === name.toLowerCase()) return text;
    if (name === name.toUpperCase()) return text.toUpperCase();
    if (name === name[0].toUpperCase() + name.slice(1).toLowerCase()) {
        const [first = '', ...rest] = text;
        return first.toUpperCase() + rest.join('');
    }
    return text;
}

define('user', { handler: ({ env }) => env.userName });
define('char', { handler: ({ env }) => env.charName });
// every chat here has one character, so the group names answer as a solo chat does
for (const [name, aliases] of [['group', ['charIfNotGroup']], ['groupNotMuted', []]]) {
    define(name, { aliases, handler: ({ env }) => env.charName ?? '' });
}
define('notChar', { handler: ({ env }) => env.userName ?? '' });

// macro name, the env.texts key it answers (the card spec's field name), aliases
const TEXT_MACROS = [
    ['charPrompt', 'system_prompt'],
    ['charInstruction', 'post_history_instructions'],
    ['charDescription', 'description', ['description']],
    ['charPersonality', 'personality', ['personality']],
    ['charScenario', 'scenario', ['scenario']],
    ['persona', 'persona'],
    ['mesExamplesRaw', 'mes_example'],
    ['charDepthPrompt', 'depth_prompt'],
    ['charCreatorNotes', 'creator_notes', ['creatorNotes']],
    ['charVersion', 'character_version', ['version', 'char_version']],
];
for (const [name, key, aliases = []] of TEXT_MACROS) {
    define(name, { aliases, handler: ({ env }) => env.texts[key] ?? '' });
}
for (const [name, key, word] of PRONOUN_MACROS) {
    define(name, { handler: ({ env, calledAs }) => pronounInCase(calledAs, env.pronouns?.[key], word) });
}
define('mesExamples', { handler: ({ env }) => exampleBlocks(env.texts.mes_example ?? '').join('') });

// greeting 0 is the first message, greeting n the nth alternate; only the one asked for is read
function greetingOf(texts, n) {
    if (!n) return texts.first_mes;
    const alternates = texts.alternate_greetings;
    return Array.isArray(alternates) ? alternates[n - 1] : undefined;
}
define('charFirstMessage', {
    aliases: ['greeting'],
    args: [arg(INTEGER, true)],
    handler: ({ env, unnamedArgs: [n] }) => greetingOf(env.texts, Number(n ?? 0)) ?? '',
});
define('original', {
    handler: ({ env }) => {
        if (typeof env.original !== 'function') throw new MacroError('no original here');
        return env.original();
    },
});
// a character's own note isnt kept here, so it answers empty as ST's does for a character with none
define('authorsNote', { handler: ({ env }) => env.notes.chat });
define('charAuthorsNote', { handler: () => '' });
define('defaultAuthorsNote', { handler: ({ env }) => env.notes.default });

/** The card's example dialogue split into <START> blocks as ST's chat completion splits it. */
export function exampleBlocks(raw) {
    return exampleTexts(raw).map(block => `<START>\n${block}\n`);
}

// ---------------------------------------------------------------- the generation

define('model', { handler: ({ env }) => env.model ?? '' });
define('maxContext', { aliases: ['maxContextTokens'], handler: ({ env }) => String(env.budget.maxContext) });
define('maxResponse', { aliases: ['maxResponseTokens'], handler: ({ env }) => String(env.budget.maxResponse) });
define('maxPrompt', { aliases: ['maxPromptTokens'], handler: ({ env }) => String(env.budget.maxContext - env.budget.maxResponse) });
define('isMobile', { handler: ({ env }) => String(!!env.reader.mobile) });
define('lastGenerationType', { handler: ({ env }) => env.generationType ?? '' });
define('hasExtension', { args: [arg()], handler: ({ unnamedArgs: [id], env }) => String(!!env.extensionOn?.(id)) });

// ---------------------------------------------------------------- the chat

// a reply still being written: its swipe points past the swipes it holds
const inProgress = (m) => !!m.swipes && m.swipe_id >= m.swipes.length;
const hidden = (m) => !!(m.is_system || m.extra?.hidden);

// where the newest finished message ACCEPT takes sits in the chat, null for none
function newestAt(env, accept = () => true) {
    const k = env.chat.messages.findLastIndex(m => !inProgress(m) && accept(m));
    return k < 0 ? null : k;
}
const mesAt = (env, k) => (k === null ? '' : env.chat.messages[k]?.mes ?? '');

define('lastMessage', { handler: ({ env }) => mesAt(env, newestAt(env)) });
define('lastMessageId', { handler: ({ env }) => String(newestAt(env) ?? '') });
define('lastUserMessage', { handler: ({ env }) => mesAt(env, newestAt(env, m => m.is_user && !hidden(m))) });
define('lastCharMessage', { handler: ({ env }) => mesAt(env, newestAt(env, m => !m.is_user && !hidden(m))) });
define('firstIncludedMessageId', {
    handler: ({ env }) => {
        const v = env.chat.metadata?.lastInContextMessageId;
        return typeof v === 'number' ? String(v) : '';
    },
});
define('firstDisplayedMessageId', { handler: ({ env }) => (Number.isInteger(env.firstDisplayed) && env.firstDisplayed >= 0 ? String(env.firstDisplayed) : '') });
// the swipe counters read the chat's last message, one still being written included
define('lastSwipeId', {
    handler: ({ env }) => {
        const swipes = env.chat.messages.at(-1)?.swipes;
        return Array.isArray(swipes) ? String(swipes.length) : '';
    },
});
define('currentSwipeId', {
    handler: ({ env }) => {
        const shown = env.chat.messages.at(-1)?.swipe_id;
        return typeof shown === 'number' ? String(shown + 1) : '';
    },
});
define('allChatRange', { handler: ({ env }) => (env.chat.messages.length ? `0-${env.chat.messages.length - 1}` : '') });

// ---------------------------------------------------------------- time
//
// The reader's clock: env.clock.now in the reader's UTC offset, formatted by moment in English, as
// ST's browser formats it.

// a date a user wrote that moment cannot read is theirs to fix, not the server log's
moment.suppressDeprecationWarnings = true;
const readerTime = (env) => moment(env.clock.now).utcOffset(env.clock.utcOffset);

define('time', {
    args: [arg(STRING, true)],
    handler: ({ unnamedArgs: [spec], env }) => {
        const m = spec ? /^UTC([+-]\d+)$/.exec(spec) : null;
        const hours = m ? Number.parseInt(m[1], 10) : NaN;
        if (Number.isNaN(hours)) return readerTime(env).format('LT');
        return moment(env.clock.now).utc().utcOffset(hours).format('LT');
    },
});
define('date', { handler: ({ env }) => readerTime(env).format('LL') });
define('weekday', { handler: ({ env }) => readerTime(env).format('dddd') });
define('isotime', { handler: ({ env }) => readerTime(env).format('HH:mm') });
define('isodate', { handler: ({ env }) => readerTime(env).format('YYYY-MM-DD') });
define('datetimeformat', { args: [arg()], handler: ({ unnamedArgs: [format], env }) => readerTime(env).format(format) });
define('timeDiff', {
    args: [arg(), arg()],
    handler: ({ unnamedArgs: [left, right], env }) => moment.duration(readerMoment(left, env).diff(readerMoment(right, env))).humanize(true),
});
define('idleDuration', {
    aliases: ['idle_duration'],
    handler: ({ env }) => {
        // the user's turn before the newest shown message, hidden ones passed over
        const messages = env.chat.messages;
        const newest = messages.findLastIndex(m => !hidden(m));
        const turn = messages.findLast((m, k) => k < newest && m.is_user && !hidden(m));
        if (!turn?.send_date) return 'just now';
        const sent = messageMoment(turn.send_date, env) ?? moment.invalid();
        return moment.duration(readerTime(env).diff(sent)).humanize();
    },
});

// a date written without a zone is the reader's local time, as a browser reads it
function readerMoment(text, env) {
    const m = moment.utc(text, moment.ISO_8601);
    if (m.isValid() && !/(?:Z|[+-]\d\d:?\d\d)$/i.test(String(text).trim())) return m.utcOffset(env.clock.utcOffset, true);
    if (m.isValid()) return m;
    const loose = moment.utc(text);
    return loose.isValid() ? loose.utcOffset(env.clock.utcOffset, true) : loose;
}

// a stored send date read as the message's time is: one parser, on the reader's clock
function messageMoment(value, env) {
    const at = parseStDate(value, env.clock.reader);
    return at === null ? null : moment(at);
}

// ---------------------------------------------------------------- variables

for (const [scope, local] of [['', true], ['global', false]]) {
    const vars = (env) => (local ? env.vars.local : env.vars.global);
    const v = (name) => name.replace(/var$/, `${scope}var`);
    define(v('setvar'), { args: [arg(), arg([STRING, NUMBER])], handler: ({ unnamedArgs: [name, value], env }) => { vars(env).set(name, value); return ''; } });
    define(v('addvar'), { args: [arg(), arg([STRING, NUMBER])], handler: ({ unnamedArgs: [name, value], env }) => { vars(env).add(name, value); return ''; } });
    define(v('incvar'), { args: [arg()], handler: ({ unnamedArgs: [name], env }) => normalize(vars(env).add(name, 1)) });
    define(v('decvar'), { args: [arg()], handler: ({ unnamedArgs: [name], env }) => normalize(vars(env).add(name, -1)) });
    define(v('getvar'), { args: [arg()], handler: ({ unnamedArgs: [name], env }) => normalize(vars(env).get(name)) });
    define(v('hasvar'), { aliases: [local ? 'varexists' : 'globalvarexists'], args: [arg()], handler: ({ unnamedArgs: [name], env }) => (vars(env).has(name) ? 'true' : 'false') });
    define(v('deletevar'), { aliases: [local ? 'flushvar' : 'flushglobalvar'], args: [arg()], handler: ({ unnamedArgs: [name], env }) => { vars(env).del(name); return ''; } });
}

// a stored value as a macro reads it: a number when it reads as one, a blank text as is, otherwise the text or ''
function readStored(v) {
    if (typeof v === 'string' && !v.trim()) return v;
    const n = Number(v);
    return Number.isNaN(n) ? v || '' : n;
}

// the array a stored JSON list holds, null when it holds none
function listIn(value) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/** A scope of variables over a plain object: a list gains an added value, two numbers sum, anything else joins as text. */
export function variableScope(store) {
    const scope = {
        get(name) {
            return readStored(store[name]);
        },
        set(name, value) {
            if (!name) throw new MacroError('a variable needs a name');
            if (String(value).length > VARIABLE_MAX) throw new MacroError(`a variable holds at most ${VARIABLE_MAX} characters`);
            store[name] = value;
            return value;
        },
        has: (name) => store[name] !== undefined,
        add(name, value) {
            const held = scope.get(name) || 0;
            const list = listIn(held);
            if (list) {
                list.push(value);
                scope.set(name, JSON.stringify(list));
                return list;
            }
            const [a, b] = [Number(held), Number(value)];
            if (Number.isNaN(a) || Number.isNaN(b)) return scope.set(name, String(held || '') + value);
            const sum = a + b;
            return Number.isNaN(sum) ? '' : scope.set(name, sum);
        },
        del(name) {
            if (scope.has(name)) delete store[name];
            return '';
        },
    };
    return scope;
}

// ---------------------------------------------------------------- features this app does not have
//
// ST's text-completion formatting (instruct sequences, its system prompt and context template) is not
// part of a chat completion here: instruct is off, the system prompt is this app's default main prompt
// (the card's own when it has one), the separators ST's stock ones.

for (const [name, aliases = []] of [
    ['instructStoryStringPrefix'], ['instructStoryStringSuffix'], ['instructUserPrefix', ['instructInput']], ['instructUserSuffix'],
    ['instructAssistantPrefix', ['instructOutput']], ['instructAssistantSuffix', ['instructSeparator']], ['instructSystemPrefix'],
    ['instructSystemSuffix'], ['instructFirstAssistantPrefix', ['instructFirstOutputPrefix']],
    ['instructLastAssistantPrefix', ['instructLastOutputPrefix']], ['instructStop'], ['instructUserFiller'],
    ['instructSystemInstructionPrefix'], ['instructFirstUserPrefix', ['instructFirstInput']], ['instructLastUserPrefix', ['instructLastInput']],
]) define(name, { aliases, handler: () => '' });
define('defaultSystemPrompt', { aliases: ['instructSystem', 'instructSystemPrompt'], handler: () => DEFAULT_MAIN_PROMPT });
define('systemPrompt', { handler: ({ env }) => env.texts.system_prompt || DEFAULT_MAIN_PROMPT });
define('exampleSeparator', { aliases: ['chatSeparator'], handler: () => '***' });
define('chatStart', { handler: () => '***' });

// ================================================================ the registry

function primaryOf(name, env) {
    const key = String(name ?? '').trim().toLowerCase();
    if (!key) return undefined;
    const def = DEFINITIONS.get(key);
    if (def) return def;
    const ext = env?.extensionMacros;
    return ext && Object.prototype.hasOwnProperty.call(ext, key) ? ext[key] : undefined;
}

const engine = createEngine({ getMacro: primaryOf, getPrimary: primaryOf });

/** The macro names a finished text still holds that nothing answered (unknown, or an extension's that failed), once each. */
export function unansweredMacros(text, env) {
    const out = [];
    for (const m of topLevelMacros(String(text ?? ''))) {
        const name = String(m.name).trim().toLowerCase();
        const def = primaryOf(name, env);
        if ((!def || def.failed?.()) && !out.includes(name)) out.push(name);
    }
    return out;
}

/** Every name and alias the vocabulary answers, lower-case; an extension's macro may take none of them. */
export const BUILTIN_MACROS = Object.freeze([...DEFINITIONS.keys()]);

/** The definitions, primary names only, for the vocabulary check against ST's registry. */
export const MACRO_DEFINITIONS = Object.freeze(PRIMARY.map(d => Object.freeze({
    name: d.name, aliases: d.aliases, minArgs: d.minArgs, maxArgs: d.maxArgs, list: d.list,
    strict: d.strict, delay: d.delay, args: d.args,
})));

// ================================================================ the environment

/** SillyTavern's string hash (cyrb53), which its {{pick}} seeds with. */
export function stringHash(str, seed = 0) {
    if (typeof str !== 'string') return 0;
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let k = 0; k < str.length; k++) {
        const ch = str.charCodeAt(k);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// the card texts the macros read, by the card spec's field names; the Character's Note sits in an extension
const CARD_TEXT_KEYS = ['system_prompt', 'post_history_instructions', 'description', 'personality', 'scenario', 'mes_example', 'depth_prompt', 'creator_notes', 'first_mes'];
const cardText = (card, key) => (key === 'depth_prompt' ? card.extensions?.depth_prompt?.prompt : card[key]);

/** The chat's own card texts in force: its chat_metadata key -> text, for each it holds as text. */
export function chatCardTexts(chatMetadata) {
    const out = {};
    for (const key of CHAT_CARD_OVERRIDES) {
        const text = chatMetadata?.[key];
        if (typeof text === 'string' && text) out[key] = text;
    }
    return out;
}

/**
 * The environment a chat's text expands in, every value a snapshot taken now so one build agrees with itself.
 * @param {object} o
 * @param {string} o.charName
 * @param {string} o.userName
 * @param {string} [o.persona] the persona's description
 * @param {object} [o.pronouns] the persona's pronoun forms { sub, obj, poss, possP, ref }; a missing one answers its they/them word
 * @param {object} [o.card] the card's data
 * @param {Array<object>} [o.chat] every stored message, oldest first (a swipe's target marked, a reroll's left out)
 * @param {string} [o.chatId]
 * @param {string} [o.chatName] seeds {{pick}} when ST's hash is absent
 * @param {object} [o.chatMetadata] the pick hash, the first message in context, the chat's own card texts
 * @param {object} [o.vars] { local, global } variable stores, written in place
 * @param {object} [o.extensionMacros] lower-case name -> macroDefinition, the enabled extensions'
 * @param {Date} [o.now]
 * @param {number} [o.utcOffset] the reader's, in minutes east of UTC
 * @param {string} [o.zone] the reader's IANA zone, which a stored send date without a zone is read in
 * @param {object} [o.more] model, maxContext, maxResponse, mobile, input, generationType, firstDisplayed, outlets, extensionOn, random, authorsNote, defaultAuthorsNote
 */
export function buildMacroEnv({
    charName = '', userName = '', persona = '', pronouns = null, card = {}, chat = [], chatId = '', chatName = '',
    chatMetadata = {}, vars = null, extensionMacros = null, now = null, utcOffset = null, zone = null, more = {},
}) {
    const stores = vars || { local: {}, global: {} };
    const metadata = chatMetadata || {};
    const env = {
        userName,
        charName,
        pronouns: { ...pronouns },
        texts: {},
        model: more.model ?? '',
        budget: { maxContext: more.maxContext ?? 0, maxResponse: more.maxResponse ?? 0 },
        reader: { mobile: !!more.mobile },
        clock: {
            now: now instanceof Date ? now : new Date(),
            utcOffset: Number.isFinite(utcOffset) ? utcOffset : -new Date().getTimezoneOffset(),
            // stored stamps read as a message's time does: with neither a zone nor an offset, in the server's zone
            reader: { zone: zone || null, utcOffset: Number.isFinite(utcOffset) ? utcOffset : null },
        },
        input: more.input ?? '',
        notes: { chat: more.authorsNote ?? '', default: more.defaultAuthorsNote ?? '' },
        generationType: more.generationType ?? '',
        firstDisplayed: more.firstDisplayed ?? null,
        outlets: more.outlets || {},
        outletsRead: null,
        extensionOn: more.extensionOn || (() => false),
        random: more.random || Math.random,
        chat: {
            messages: chat,
            metadata,
            // ST's chat hash, computed once from the chat's name and kept in the metadata for a real
            // build to commit, as ST caches it
            idHash() {
                if (typeof metadata.chat_id_hash === 'number') return metadata.chat_id_hash;
                metadata.chat_id_hash = stringHash(metadata.main_chat ?? (chatName || chatId || undefined));
                return metadata.chat_id_hash;
            },
        },
        vars: { local: variableScope(stores.local), global: variableScope(stores.global) },
        extensionMacros: extensionMacros || null,
        contentHash: 0,
    };

    // the card's texts, the chat's own first; a text read inside another skips card macros, so none loop
    const own = chatCardTexts(metadata);
    const written = Object.fromEntries(CARD_TEXT_KEYS.map(key => [key, own[key] ?? cardText(card, key)]));
    written.persona = persona;
    const alternates = Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [];
    const version = card.character_version ?? '';
    const bare = { ...env, texts: { character_version: version } };
    const inner = { ...env, texts: lazyTexts(written, alternates, version, (text) => finishText(text, bare)) };
    env.texts = lazyTexts(written, alternates, version, (text) => finishText(text, inner));
    return env;
}

// a card text trimmed, its macros expanded in ENV, carriage returns dropped
function finishText(text, env) {
    const body = typeof text === 'string' ? text.trim() : '';
    return body ? expandMacros(body, env).replace(/\r/g, '') : '';
}

// the texts as getters, each finished once when first read; the version reads as written
function lazyTexts(written, alternates, version, finish) {
    const texts = {};
    const done = {};
    for (const key of Object.keys(written)) {
        Object.defineProperty(texts, key, { enumerable: true, get: () => (done[key] ??= finish(written[key])) });
    }
    Object.defineProperty(texts, 'alternate_greetings', { enumerable: true, get: () => (done.alternate_greetings ??= alternates.map(text => finish(text))) });
    texts.character_version = version;
    return texts;
}

/** Expand every macro in text with env; original answers the first {{original}} only. */
export function expandMacros(text, env, { original } = {}) {
    if (typeof text !== 'string' || !text) return '';
    if (!mayHoldMacros(text)) return text;
    let originalLeft = original;
    const call = {
        ...env,
        contentHash: stringHash(text),
        original: original === undefined ? undefined : () => { const once = originalLeft ?? ''; originalLeft = ''; return once; },
    };
    return engine.evaluate(text, call);
}
