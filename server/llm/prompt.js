// Chat-completion prompt assembly: card + history + persona + lore -> a messages array, ordered by the chat's preset
import { getCharacter } from '../db/characters-store.js';
import { getWorld } from '../db/worlds-store.js';
import { listWorldsFor } from '../db/world-links-store.js';
import { resolvePersona } from '../db/personas-store.js';
import { resolveChatPreset, getPreset } from '../db/presets-store.js';
import seedrandom from 'seedrandom';
import { getChatRow, listMessageRows, readMessageRow, countMessages, chatMetadataOf, alignActiveSwipe, syncActiveSwipe, chatIdNamed, parseStDate } from '../db/chats-store.js';
import { GLOBAL_VARIABLES_KEY, appendMessageWithMacros, commitChatMacros, createChatWithMacros } from '../db/chat-macros.js';
import { profileContextSize, profileRow, resolveChatProfile, maxImagesOf } from '../db/llm-profiles-store.js';
import { DEFAULT_BLOCKS, assembleBlocks, blocksForBuild, resolveBlocksInOrder, joinSystemMessages, promptSettingsOf } from './preset.js';
import { buildMacroEnv, chatCardTexts, expandMacros, stringHash, unansweredMacros } from './macros.js';
import { mayHoldMacros } from './macro-engine.js';
import { selectLore, scanWindow } from './lore.js';
import { NOTE_POSITION, NOTE_ROLES, chatNoteOf, chatNoteState, noteDefaults, noteSeed, wrapNote } from './authors-note.js';
import { fitToBudget, estimateTextTokens, imagesIn, pictureFloor } from './budget.js';
import { attachmentsOfMessages } from '../db/attachments-store.js';
import { profileSees } from './service.js';
import { pictureCapOf } from './images.js';
import { LlmError, badRequest } from './errors.js';
import { settingValue } from '../db/settings-store.js';
import { runHook, runRegistry } from '../db/hook-seat.js';
import { extensionEnabledFor, listExtensions } from '../lib/extensions.js';
import { readerContext } from '../lib/reader-context.js';
import { scriptsForChat } from '../db/regex-store.js';
import { runPass, buildBudget } from '../lib/regex/run.js';
import { PLACE, screenPlace, systemLine, hiddenFromPrompt, namesMacros } from '../lib/regex/engine.js';

// tokens bound the prompt and nothing else, no "unlimited". 8192 is ST's text-completion default, not its stale 4095
export const DEFAULT_MAX_CONTEXT = 8192;
// ST reserves 300 (chat completion) / 350 (text completion) for the reply.
export const DEFAULT_REPLY_RESERVE = 350;

/** The token budget: the answering profile's context size, else the global setting, else the default. */
export function contextBudget(db, profileId) {
    const id = profileId || null;
    if (id) {
        const n = profileContextSize(db, id);
        if (n) return n;
    }
    const stored = Number(settingValue(db, 'chatMaxContext', DEFAULT_MAX_CONTEXT));
    return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_MAX_CONTEXT;
}

// the chat's preset as a build reads it, its blocks for this type and its settings; a missing or empty one is the built-in blocks
export function presetFor(db, chatId, { trigger = 'normal' } = {}) {
    const id = resolveChatPreset(db, chatId).presetId;
    if (!id) return { blocks: DEFAULT_BLOCKS, settings: promptSettingsOf(null) };
    const preset = getPreset(db, id);
    const blocks = blocksForBuild(preset?.blocks ?? [], { trigger });
    // an emptied Main alone is no preset to send
    return blocks.some(b => !b.held) ? { blocks, settings: promptSettingsOf(preset.settings) } : { blocks: DEFAULT_BLOCKS, settings: promptSettingsOf(null) };
}

/**
 * The rows that reach the model: no is_system (ST's hidden) and no extra.hidden (ours, per message).
 * @returns {Array<{seq: number, msg: object}>}
 */
export function visibleHistory(db, chatId, { excludeSeq = null } = {}) {
    // No count cap. Everything the filters leave goes to the budget, which is the only
    // thing allowed to decide how much history fits.
    return visibleOf(listMessageRows(db, chatId), excludeSeq);
}

const visibleOf = (rows, excludeSeq) => rows.filter(r => r.seq !== excludeSeq && promptVisible(r.msg));

/**
 * The rows a build reads for the connection that answers it, the reroll's target gone; the build and every lore scan read this one window.
 * @returns {{ visible: Array, seeing: Array, sending: boolean, pictures: Map }} seeing keeps the picture rows whatever the connection, for the withheld count
 */
function promptWindow(db, rows, { answering = null, excludeSeq = null } = {}) {
    // the messages' pictures, sent only when the answering connection is known to see them (else the inspector says so)
    const pictures = attachmentsOfMessages(db, rows.map(r => r.id));
    const sending = profileSees(db, answering) === true;
    // a build that sends pictures keeps a message of pictures with no text in its window (the text readers' rule is promptVisible's)
    const seeing = rows.filter(r => r.seq !== excludeSeq && (promptVisible(r.msg) || (pictures.get(r.id)?.length && !hiddenFromPrompt(r.msg))));
    return { visible: sending ? seeing : visibleOf(rows, excludeSeq), seeing, sending, pictures };
}

// each row's depth as the screen counts it (any row not hidden, text or not), the reroll's target gone; a continue's own row is -1
function promptDepths(rows, excludeSeq, continuing) {
    const depths = new Map();
    let depth = continuing ? -1 : 0;
    for (let i = rows.length - 1; i >= 0; i--) {
        const { seq, msg } = rows[i];
        if (seq === excludeSeq || hiddenFromPrompt(msg)) continue;
        depths.set(seq, depth++);
    }
    return depths;
}

/**
 * The prompt pass: the chat's active scripts over each turn at its depth, new copies so the stored rows keep their text.
 * @param {{ continuing: boolean, expand: Function, depths: Map, budget: Map }} at the build's: its macros, promptDepths, buildBudget
 */
function regexHistory(db, scripts, visible, { continuing, expand, depths, budget }) {
    if (!scripts.length) return visible;
    return visible.map((r, i) => {
        const msg = r.msg;
        const at = { pass: 'prompt', depth: depths.get(r.seq) ?? 0, macros: expand, edited: !!msg.extra?.edited, budget };
        // a narrator's line takes its text scripts at Narrator, as ST writes them, and its prompt scripts as an AI reply
        const mes = typeof msg.mes === 'string' && msg.mes
            ? runPass(db, msg.mes, scripts, { ...at, where: msg.is_user ? PLACE.userInput : PLACE.aiOutput, textWhere: screenPlace(msg) })
            : msg.mes;
        // a continue sends the continued message's reasoning back, through the reasoning scripts at its depth
        const thought = msg.extra?.reasoning;
        const reasoning = continuing && i === visible.length - 1 && typeof thought === 'string' && thought
            ? runPass(db, thought, scripts, { ...at, where: PLACE.reasoning })
            : thought;
        if (mes === msg.mes && reasoning === thought) return r;
        return { ...r, msg: { ...msg, mes, ...(reasoning === thought ? {} : { extra: { ...msg.extra, reasoning } }) } };
    });
}

// the groups selectLore places, in its return's order: the lore pass and lore.activate both read them
const LORE_GROUPS = ['before', 'after', 'atDepth', 'emBefore', 'emAfter', 'anTop', 'anBottom', 'outlets'];
// the lore pass: each placed entry's content, at its depth when it has one; an entry the scripts empty is not sent
function regexLore(db, scripts, lore, expand, budget) {
    if (!scripts.length) return lore;
    const out = { ...lore };
    for (const group of LORE_GROUPS) {
        if (!Array.isArray(lore[group])) continue;
        out[group] = lore[group].map((item) => {
            const content = runPass(db, String(item.content ?? ''), scripts, { pass: 'lore', where: PLACE.lore, depth: group === 'atDepth' ? item.depth : undefined, macros: expand, budget });
            return content === item.content ? item : { ...item, content };
        }).filter(item => item.content);
    }
    return out;
}

/** Whether the prompt reads a stored message: not a system note, not hidden, not empty. */
export function promptVisible(msg) {
    return !!msg && !hiddenFromPrompt(msg) && typeof msg.mes === 'string' && !!msg.mes;
}

/**
 * Who a chat is between; {{user}} is the resolved persona's name ahead of the stored one.
 * @returns {{ char: object|null, card: object, persona: object|null, charName: string, userName: string }}
 */
export function chatNames(db, chatRow) {
    const char = getCharacter(db, chatRow.char_id);
    const card = char?.card?.data || {};
    const persona = resolvePersona(db, chatRow.id).persona;
    // an ST header's 'unused' is no name, or a greeting expanded through it keeps "unused's room"
    const real = (v) => (typeof v === 'string' && v.trim() && v.trim() !== 'unused') ? v.trim() : null;
    return {
        char, card, persona,
        charName: card.name || chatRow.character_name || char?.name || 'Character',
        userName: real(persona?.name) || real(chatRow.user_name) || 'User',
    };
}

/**
 * A chat's names, its prompt's messages as stored, and its macros, for an extension's own model call; null for no such chat.
 * @returns {{ charName: string, userName: string, history: Array<{id: number, seq: number, msg: object}>, expand: (text: string, opts?: object) => string }|null}
 */
export function readChatForPrompt(db, chatId) {
    const chatRow = getChatRow(db, chatId);
    if (!chatRow) return null;
    const { card, persona, charName, userName } = chatNames(db, chatRow);
    const rows = listMessageRows(db, chatRow.id);
    const visible = visibleOf(rows, null);
    let macros = null;
    return {
        charName,
        userName,
        history: visible.map(r => ({ id: r.id, seq: r.seq, msg: r.msg })),
        // an extension's own model call reads the chat's variables and never writes them
        expand(text, opts) {
            macros ||= chatMacroEnv(db, chatRow, {
                card, charName, userName, persona,
                chat: rows.map(r => r.msg), lastSeq: visible.at(-1)?.seq ?? null,
            });
            return macros.expand(String(text ?? ''), opts);
        },
    };
}

/**
 * readChatForPrompt's two names alone, for a caller that reads the messages itself.
 * @returns {{ charName: string, userName: string }|null}
 */
export function readChatNames(db, chatId) {
    const chatRow = getChatRow(db, chatId);
    if (!chatRow) return null;
    const { charName, userName } = chatNames(db, chatRow);
    return { charName, userName };
}

/**
 * Where each lorebook in force comes from, by name; one reader for the gather and the panel's source chips.
 * @returns {{character: string[], chat: string|null, persona: object|null, personaWorlds: string[], global: string[]}}
 */
export function activeWorldSources(db, chatRow) {
    const character = listWorldsFor(db, 'char', chatRow.char_id);
    const chat = listWorldsFor(db, 'chat', chatRow.id);
    const persona = resolvePersona(db, chatRow.id).persona;
    const personaWorlds = persona ? listWorldsFor(db, 'persona', persona.id) : [];
    const global = listWorldsFor(db, 'global');
    return { character, chat, persona, personaWorlds, global };
}

/** The routes by which a book in force reaches a chat, in the panel's order; a book bound several ways names each. */
export function worldSourcesOf(src, name) {
    return [['character', src.character], ['chat', src.chat], ['persona', src.personaWorlds], ['global', src.global]]
        .filter(([, names]) => (names || []).includes(name)).map(([kind]) => kind);
}

/**
 * The lorebooks in force for a chat, in injection order and name-deduped; the panel shows this same set.
 * @param {object} [src] the sources a caller already read (activeWorldSources)
 * @returns {Array<object>} world rows, missing names dropped
 */
export function activeWorldsFor(db, chatRow, src = activeWorldSources(db, chatRow)) {
    return [...new Set([...src.character, ...src.chat, ...src.personaWorlds, ...src.global].filter(Boolean))]
        .map(name => getWorld(db, name))
        .filter(Boolean);
}

/** The lore engine's settings, read from one place. */
export function loreSettings(db) {
    const num = (key, fallback) => {
        const n = Number(settingValue(db, key, fallback));
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    return {
        // these fallbacks must match the client's DEFAULT_SETTINGS, or a toggle shows what the engine isnt doing
        defaultScanDepth: Number(settingValue(db, 'loreScanDepth', 4)) || null,
        caseSensitive: !!settingValue(db, 'loreCaseSensitive', false),
        matchWholeWords: !!settingValue(db, 'loreMatchWholeWords', true),
        // opts a library into ST's exact (looser) key matching
        stMatching: !!settingValue(db, 'loreStMatching', false),
        recursive: settingValue(db, 'loreRecursive', true) !== false,
        maxRecursionSteps: num('loreMaxRecursionSteps', 0),
        // ST's lore budget: this % of the context window, optionally hard-capped.
        // 0 disables the budget entirely.
        budgetPercent: num('loreBudgetPercent', 25),
        budgetCap: num('loreBudgetCap', 0),
        // "Name: message" lines, as SillyTavern scans them by default, so a key on a name fires when that character speaks
        includeNames: settingValue(db, 'loreIncludeNames', true) !== false,
        // Panel-only diagnostics: dry runs stamp WHY each entry fired. Off saves the
        // provenance re-match on huge whole-window chats; the send path never pays either way.
        provenance: settingValue(db, 'loreFiredVia', true) !== false,
    };
}

const plainObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const parsedMeta = (chatRow) => chatMetadataOf(chatRow.chat_metadata);

/** The chat's own card texts in force, by their chat_metadata keys (chatCardTexts). */
export function chatOwnTexts(chatRow) {
    return chatCardTexts(parsedMeta(chatRow));
}

/** The chat's Author's Note as the next build reads it, over every stored message (chatNoteState). */
export function chatAuthorsNote(db, chatRow) {
    return chatNoteState(db, parsedMeta(chatRow), listMessageRows(db, chatRow.id).map(r => r.msg));
}

/**
 * The one macro environment of a chat, for every reader of its text; variables are copies only a real build commits.
 * @param {object|null} opts.persona the resolved persona row (chatNames), its description and pronouns read here
 * @param {Array<object>} opts.chat every stored message, oldest first, as the chat macros read them
 * @param {number|null} [opts.lastSeq] the newest row the text is written after, told to extension macros
 * @param {object} [opts.build] model, maxContext, maxResponse, generationType, input, firstDisplayed, now, random
 * @returns {{ env: object, fields: object, expand: (text: string, opts?: object) => string, changes: () => object }}
 */
function chatMacroEnv(db, chatRow, { card, charName, userName, persona, chat, lastSeq = null, build = {} }) {
    const meta = parsedMeta(chatRow);
    const storedLocal = plainObject(meta.variables) || {};
    const storedGlobal = plainObject(settingValue(db, GLOBAL_VARIABLES_KEY, {})) || {};
    const local = structuredClone(storedLocal);
    const global = structuredClone(storedGlobal);
    const storedHash = meta.chat_id_hash;
    const noteDefs = noteDefaults(db);
    // the connection answering this chat, read only when the caller named no model or budget (a build names both)
    let answered;
    const answering = () => (answered ??= resolveChatProfile(db, chatRow.id ?? null));
    const reader = readerContext();
    let inventory = null; // the extensions on disk, read once for every {{hasExtension}} of one build

    // a message as its text scripts write it, what ST stored and its {{lastMessage}} reads; the scripts read once a macro asks
    let scripts = null;
    const written = (msg) => {
        scripts ??= scriptsForChat(db, chatRow.id)?.active || [];
        const text = msg?.mes ?? '';
        if (!scripts.length || typeof text !== 'string' || !text || systemLine(msg)) return text;
        return runPass(db, text, scripts, { pass: 'written', where: screenPlace(msg), macros: namesMacros({ user: userName, char: charName }), edited: !!msg.extra?.edited });
    };
    const env = buildMacroEnv({
        charName, userName, persona: persona?.description || '', pronouns: persona?.pronouns || null, card, chat,
        chatId: chatRow.id, chatName: chatRow.name, chatMetadata: meta,
        vars: { local, global },
        extensionMacros: runRegistry('macros', { db, chatId: chatRow.id, charId: chatRow.char_id, lastSeq }) || null,
        now: build.now || null,
        utcOffset: reader.utcOffset,
        zone: reader.zone,
        more: {
            model: build.model ?? answering().row?.model ?? '',
            maxContext: build.maxContext ?? contextBudget(db, answering().row?.id),
            maxResponse: build.maxResponse ?? replyReserve(db),
            mobile: reader.mobile,
            input: build.input ?? '',
            generationType: build.generationType ?? '',
            firstDisplayed: build.firstDisplayed ?? null,
            random: build.random ?? null,
            authorsNote: chatNoteOf(meta, noteDefs).prompt,
            defaultAuthorsNote: noteDefs.prompt,
            written,
            extensionOn: (id) => {
                inventory ??= listExtensions();
                const row = inventory.find(r => r.id === id && !r.error);
                return !!row && extensionEnabledFor(db, row);
            },
        },
    });
    return {
        env,
        fields: env.texts,
        expand: (text, opts) => expandMacros(String(text ?? ''), env, opts),
        // what the expansions changed, for a real build to commit: metadata keys and the global variables
        changes() {
            const metadata = {};
            if (JSON.stringify(local) !== JSON.stringify(storedLocal)) metadata.variables = local;
            if (meta.chat_id_hash !== storedHash) metadata.chat_id_hash = meta.chat_id_hash;
            return { metadata, globals: JSON.stringify(global) !== JSON.stringify(storedGlobal) ? global : null };
        },
    };
}

/** A chat's macro environment outside a build; chatRow may not be stored yet (no id). */
export function macrosForChat(db, chatRow, { chat = null, build = {} } = {}) {
    const { card, persona, charName, userName } = chatNames(db, chatRow);
    const msgs = chat || (chatRow.id ? listMessageRows(db, chatRow.id).map(r => r.msg) : []);
    // seqs are contiguous from 0, so the newest visible row's index is its seq, as a build tells it
    const newest = msgs.findLastIndex(promptVisible);
    return chatMacroEnv(db, chatRow, {
        card, charName, userName, persona, chat: msgs, lastSeq: newest >= 0 ? newest : null, build,
    });
}

/** Store one sent turn expanded once, in one write with what its macros set, under the prompt's reader name. */
export function storeSentTurn(db, chatRow, mes, { firstDisplayed = null, attachments = [] } = {}) {
    let text = String(mes ?? '');
    let changes = { metadata: {}, globals: null };
    // a turn with nothing to expand is stored as typed, without the chat read the macros would need
    if (mayHoldMacros(text)) {
        const macros = macrosForChat(db, chatRow, { build: { firstDisplayed } });
        text = macros.expand(text);
        changes = macros.changes();
    }
    return appendMessageWithMacros(db, chatRow.id, {
        name: chatNames(db, chatRow).userName,
        is_user: true,
        is_system: false,
        send_date: Date.now(),
        mes: text,
        // the append diverts these into the message's links, checked against the chat's own gallery
        extra: attachments.length ? { attachments } : {},
    }, changes);
}

// the first message's shown text and what its macros set, written nowhere; changes null when nothing expanded
function expandFirstMessage(db, chatRow, msg, chat = null, build = {}) {
    if (msg.is_user || !promptVisible(msg) || !mayHoldMacros(msg.mes)) return { shown: msg.mes, changes: null };
    const rows = chat ? chat.slice() : listMessageRows(db, chatRow.id).map(r => r.msg);
    rows[0] = msg;
    const macros = macrosForChat(db, chatRow, { chat: rows, build });
    return { shown: macros.expand(msg.mes), changes: macros.changes() };
}

/** The first message as the reader writes it, expanded as ST expands a shown greeting; a patchChatMessage finish. */
export function finishFirstMessage(db, chatRow) {
    return (msg) => {
        const { shown, changes } = expandFirstMessage(db, chatRow, msg);
        if (changes) commitChatMacros(db, chatRow.id, changes);
        return shown;
    };
}

/** A stored greeting expanded as a reader's PATCH would, for the greeting sweep; answers whether it changed. */
export function expandStoredGreeting(db, chatId) {
    // row 0 alone: only a greeting that holds a macro needs the whole chat, to expand it against
    const first = readMessageRow(db, chatId, 0);
    if (!first || first.is_user || first.is_system || !mayHoldMacros(first.mes)) return false;
    const chatRow = getChatRow(db, chatId);
    if (!chatRow) return false;
    // a greeting the engine leaves as written isnt rewritten, so its chat keeps its stamp
    const { shown, changes } = expandFirstMessage(db, chatRow, first);
    const changed = typeof shown === 'string' && shown !== first.mes;
    commitChatMacros(db, chatId, { ...changes, firstMessage: changed ? shown : null });
    return changed;
}

/**
 * A supplied chat's greeting expanded before the write; chatId is a chat the write replaces, whose persona it keeps.
 * @returns {{ messages: object[], changes: { metadata: object, globals: object|null }|null }}
 */
export function expandSuppliedGreeting(db, { charId, name, header, chatId = null }, messages) {
    const first = messages.length ? alignActiveSwipe(messages[0]) : null;
    if (!first || first.is_user || first.is_system || !mayHoldMacros(first.mes)) return { messages, changes: null };
    // the chats row upsertChat will write, as the macros read a stored chat's
    const meta = header.chat_metadata && typeof header.chat_metadata === 'object' ? { ...header.chat_metadata } : {};
    delete meta.world_info;
    const chatRow = { id: chatId, name, char_id: charId, user_name: header.user_name ?? null, character_name: header.character_name ?? null, chat_metadata: JSON.stringify(meta) };
    // the clock is the greeting's own send date and the dice are seeded by the chat, never the moment of the write
    const sent = parseStDate(first.send_date);
    const build = { now: sent ? new Date(sent) : null, random: seedrandom(String(stringHash(`${name}\n${first.mes}`))) };
    const { shown, changes } = expandFirstMessage(db, chatRow, first, messages.map(m => alignActiveSwipe(m)), build);
    if (typeof shown !== 'string' || shown === first.mes) return { messages, changes };
    const greeting = structuredClone(first);
    greeting.mes = shown;
    syncActiveSwipe(greeting, true);
    const out = messages.slice();
    out[0] = greeting;
    return { messages: out, changes };
}

/**
 * Store a chat from a supplied list, its greeting expanded, in one write; a same-named chat is replaced, its persona kept.
 * @param {{ charId: string, name: string, header: object, messages: object[], imported?: boolean }} chat
 * @returns {{ id: string, created: boolean }}
 */
export function storeSuppliedChat(db, chat) {
    const { charId, name, header, messages } = chat;
    const greeted = expandSuppliedGreeting(db, { charId, name, header, chatId: chatIdNamed(db, charId, name) }, messages);
    const meta = header.chat_metadata && typeof header.chat_metadata === 'object' ? header.chat_metadata : {};
    const stored = greeted.changes ? { ...header, chat_metadata: { ...meta, ...greeted.changes.metadata } } : header;
    return createChatWithMacros(db, { ...chat, header: stored, messages: greeted.messages }, { globals: greeted.changes?.globals ?? null });
}

// the chat, the assistant and the studio reserve the same reply: a junk or negative stored value is the default for all three
export function replyReserve(db) {
    const n = Number(settingValue(db, 'chatReserveForReply', DEFAULT_REPLY_RESERVE));
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_REPLY_RESERVE;
}

/**
 * THE lore scan for the prompt, the panel and the assistant, so they cant disagree. dryRun (default) consumes no state.
 * @param {Array} [opts.visible] the build's window; absent, the window the chat's own connection builds from
 * @returns {object} picturesAlone: seqs of that window's messages of pictures alone, null when the window was handed in
 */
export function runLoreScan(db, chatRow, {
    visible = null, excludeSeq = null, trigger = 'normal', dryRun = true,
    rng = Math.random, macros = null, maxContext = null, note = null, names = null, regex = null,
} = {}) {
    // the chat's scripts and the build's budget, or this read's own: the window it reads and the lore it places go through them
    const scripts = regex?.scripts || scriptsForChat(db, chatRow.id)?.active || [];
    const budget = regex?.budget || buildBudget();
    // the prompt builder's window, or one read here once for the environment too
    let vis = visible;
    let rows = null;
    let picturesAlone = null;
    // the chat's own connection, read once for both the window and the budget it sizes
    let ownResolved;
    const ownConnection = () => (ownResolved ??= resolveChatProfile(db, chatRow.id)).row ?? null;
    if (!vis) {
        rows = listMessageRows(db, chatRow.id).map(r => ({ id: r.id, seq: r.seq, msg: { ...r.msg } }));
        const own = promptWindow(db, rows, { answering: ownConnection(), excludeSeq });
        vis = own.visible;
        // what the text readers' rule leaves out of that window, for a reader of text alone
        picturesAlone = new Set(own.sending ? vis.filter(r => !promptVisible(r.msg)).map(r => r.seq) : []);
    }
    const settings = loreSettings(db);
    const src = activeWorldSources(db, chatRow);
    // a book reachable twice scans once at its earliest ST position, where ST's first occurrence wins anyway
    const scopes = new Map();
    for (const n of src.character) if (n) scopes.set(n, 'character');
    for (const n of src.global) if (n) scopes.set(n, 'global');
    for (const n of src.personaWorlds) if (n) scopes.set(n, 'persona');
    for (const n of src.chat) if (n) scopes.set(n, 'chat');
    const worlds = activeWorldsFor(db, chatRow, src);

    // the names the prompt builder already resolved, or this read's own
    const { card, persona, charName, userName } = names || chatNames(db, chatRow);
    const env = macros || chatMacroEnv(db, chatRow, {
        card, charName, userName, persona,
        chat: (rows || listMessageRows(db, chatRow.id)).map(r => r.msg), lastSeq: vis.at(-1)?.seq ?? null,
    });
    // row 0 expanded into a copy and the prompt pass over the window, so the panel and assistant scan what the prompt scans
    if (!visible) {
        const first = vis.find(r => r.seq === 0);
        if (first && typeof first.msg.mes === 'string' && mayHoldMacros(first.msg.mes)) {
            const copy = { ...first, msg: { ...first.msg, mes: env.expand(first.msg.mes) } };
            vis = vis.map(r => (r === first ? copy : r));
        }
        const continuing = trigger === 'continue';
        vis = regexHistory(db, scripts, vis, { continuing, expand: env.expand, depths: promptDepths(rows, excludeSeq, continuing), budget });
    }
    const noteState = note || chatNoteState(db, parsedMeta(chatRow), (rows || listMessageRows(db, chatRow.id)).map(r => r.msg));
    // with the scan switch on, the due note and the card's note join every scan's text
    const injectTexts = noteState.scanLore ? [
        ...(noteState.due && noteState.note.prompt ? [{ source: 'authorsNote', text: env.expand(noteState.note.prompt) }] : []),
        ...(env.fields.depth_prompt ? [{ source: 'characterDepthPrompt', text: env.fields.depth_prompt }] : []),
    ] : [];
    const historyTexts = vis.map(r => settings.includeNames
        ? `${r.msg.name || (r.msg.is_user ? userName : charName)}: ${r.msg.mes}`
        : r.msg.mes);

    // an extension's own books (ext:<id>:...) scan in the global scope; the answer's worlds leave them out
    const hookFacts = {
        db, chatId: chatRow.id, charId: chatRow.char_id, trigger, dryRun,
        get books() { return Object.freeze(worlds.map(w => w.name)); },
        get texts() { return Object.freeze([...scanWindow(historyTexts, settings.defaultScanDepth)]); },
    };
    const candidates = runHook('lore.candidates', [], hookFacts);
    for (const w of candidates) scopes.set(w.name, 'global');

    const budgetBase = Number(maxContext) > 0 ? Number(maxContext) : contextBudget(db, ownConnection()?.id);
    // the budget as SillyTavern sizes it: a share of the context, floored to 1, then the cap
    let budgetTokens = settings.budgetPercent > 0 ? (Math.round(settings.budgetPercent * budgetBase / 100) || 1) : 0;
    if (budgetTokens && settings.budgetCap > 0 && budgetTokens > settings.budgetCap) budgetTokens = settings.budgetCap;

    const timedState = chatMetadataOf(chatRow.chat_metadata).timedWorldInfo || null;

    const lore = selectLore(candidates.length ? [...worlds, ...candidates] : worlds, historyTexts, {
        ...settings,
        budgetTokens,
        estimateTokens: estimateTextTokens,
        trigger,
        chatLength: vis.length,
        timedState,
        dryRun,
        // the finished texts, as the prompt places them: the scan reads the card fields after their macros
        scanSources: {
            personaDescription: env.fields.persona,
            characterDescription: env.fields.description,
            characterPersonality: env.fields.personality,
            characterDepthPrompt: env.fields.depth_prompt,
            scenario: env.fields.scenario,
            creatorNotes: env.fields.creator_notes,
        },
        injectTexts,
        character: { name: charName, tags: Array.isArray(card.tags) ? card.tags : [] },
        scopes,
        expandMacro: env.expand,
        rng,
    });
    // and may drop or rewrite what was placed; the engine's activated list stays what it decided
    const placed = Object.fromEntries(LORE_GROUPS.map(g => [g, lore[g]]));
    const kept = runHook('lore.activate', placed, hookFacts);
    if (kept !== placed) Object.assign(lore, kept);
    // what the anchored groups wait on, for every reader of this scan's placement
    lore.authorsNote = noteState;
    return { lore: regexLore(db, scripts, lore, env.expand, budget), worlds, candidates, src, settings, visible: vis, note: noteState, picturesAlone };
}

// the block each placed group reaches the model through
const GROUP_MARKER = { before: 'worldInfoBefore', after: 'worldInfoAfter', atDepth: 'chatHistory', em: 'dialogueExamples' };

// whether a due note reaches the model under these blocks
function noteHasHome(blocks, note) {
    if (note.position === NOTE_POSITION.inChat) {
        return blocks.some(b => b.kind === 'marker' && b.marker === 'chatHistory')
            && Number.isInteger(note.depth) && note.depth >= 0 && NOTE_ROLES[note.role] !== undefined;
    }
    if (note.position === NOTE_POSITION.before || note.position === NOTE_POSITION.after) return blocks.some(b => b.id === 'main');
    return false;
}

/** What a build sends of the note, wrapped and expanded where placed, or null. */
function placedNote(state, lore, expand) {
    const { note, due } = state;
    const raw = wrapNote(note.prompt, due, (lore.anTop || []).map(c => c.content), (lore.anBottom || []).map(c => c.content));
    const inChat = note.position === NOTE_POSITION.inChat;
    const content = raw ? expand(inChat ? raw.trim() : raw) : '';
    if (!content) return null;
    const role = NOTE_ROLES[note.role] ?? null;
    return { content, position: note.position, depth: note.depth, role: inChat ? role : (role || 'system') };
}

/**
 * Which of a scan's placed lore reaches the model, the one answer the panel and assistant read.
 * @param {object} lore a runLoreScan's placed groups
 * @returns {{ inPrompt: Map<string, { group: string, placed: object, outlet: string|null }>, notes: string[] }} keyed world::uid
 */
export function loreInPrompt(db, chatId, lore) {
    const { blocks } = presetFor(db, chatId);
    const markers = new Set(blocks.filter(b => b.kind === 'marker').map(b => b.marker));
    const inPrompt = new Map();
    const notes = [];
    const keyOf = (c) => `${c.world}::${c.entry.uid}`;
    const held = lore.outlets || [];
    if (held.length) {
        let written = null;
        try {
            written = new Set(buildChatPrompt(db, chatId).lore.outletsWritten);
        } catch (err) {
            if (!(err instanceof LlmError)) throw err;
            notes.push(`whether the matched outlet entries are sent is unknown: the prompt does not build (${err.message})`);
        }
        const unwritten = new Set();
        for (const c of held) {
            if (!written?.has(c.outlet)) { unwritten.add(c.outlet); continue; }
            inPrompt.set(keyOf(c), { group: 'outlet', placed: c, outlet: c.outlet });
        }
        if (written && unwritten.size) {
            notes.push(`matched outlet entries not sent: nothing in the prompt writes ${[...unwritten].map(n => `{{outlet::${n}}}`).join(', ')}`);
        }
    }
    const anchored = [...(lore.anTop || []), ...(lore.anBottom || [])];
    if (anchored.length) {
        const n = `${anchored.length} matched entr${anchored.length === 1 ? 'y' : 'ies'} at the author's note not sent`;
        const state = lore.authorsNote;
        if (!state?.due) notes.push(`${n}: the note is not due this turn`);
        else if (!noteHasHome(blocks, state.note)) notes.push(`${n}: the note has nowhere to go in this chat's preset`);
        else for (const c of anchored) inPrompt.set(keyOf(c), { group: 'authorsNote', placed: c, outlet: null });
    }
    const groups = { before: lore.before, after: lore.after, atDepth: lore.atDepth, em: [...lore.emBefore, ...lore.emAfter] };
    for (const [group, list] of Object.entries(groups)) {
        if (!markers.has(GROUP_MARKER[group])) {
            if (list.length) {
                notes.push(`${list.length} matched entr${list.length === 1 ? 'y' : 'ies'} with '${group}' placement not sent: this chat's preset has no ${GROUP_MARKER[group]} block`);
            }
            continue;
        }
        for (const c of list) inPrompt.set(keyOf(c), { group, placed: c, outlet: null });
    }
    return { inPrompt, notes };
}

// what a build with nothing to send is refused with: the reader's words, and the way out
const EMPTY_BUILD ='this preset sends nothing for this kind of reply: every block in force for it is switched off, empty, or kept for another kind. '
    + 'Switch a block on in the Prompt Manager, or pick another preset.';

// the card's texts in the order SillyTavern finishes them as a generation starts
const CARD_TEXTS_AT_START =['system_prompt', 'mes_example', 'description', 'personality', 'persona', 'scenario', 'post_history_instructions', 'depth_prompt', 'creator_notes'];

/**
 * Build the completion prompt for a chat; turns go as stored through its prompt regex scripts at their depths, row 0 expanded every build.
 * @param {number|null} [opts.excludeSeq] a reroll's target, which the model must not see or it continues it
 * @param {string} [opts.trigger] ST's generation type: normal, swipe, regenerate, continue, impersonate; it picks the trailing instruction
 * @param {string} [opts.input] the composer's text: {{input}}, and the direction after the trailing instruction on impersonate or a normal reply
 * @param {number|null} [opts.firstDisplayed] the first message the reader's screen shows
 * @param {number|null} [opts.continueSeq] a continue's target, sent as the continued turn only when the history ends on it
 * @returns {{ messages, charName, userName, lore, budget, commit }} commit is what a real build writes through commitBuild
 */
export function buildChatPrompt(db, chatId, {
    excludeSeq = null, profileId = null,
    trigger = 'normal', loreDryRun = true, rng = Math.random,
    input = '', firstDisplayed = null, continueSeq = null,
} = {}) {
    const chatRow = getChatRow(db, chatId);
    if (!chatRow) throw badRequest(`no such chat: ${chatId}`);
    const names = chatNames(db, chatRow);
    const { char, card, persona, charName, userName } = names;
    if (!char) throw badRequest('chat has no character (orphan chat)');

    // copies: the first message is expanded into them, and nothing here writes a stored row
    const rows = listMessageRows(db, chatId).map(r => ({ id: r.id, seq: r.seq, msg: { ...r.msg } }));
    // the chat as ST's stands mid-generation: a reroll's target gone, a swipe's marked in progress
    const macroChat = rows
        .filter(r => !(trigger === 'regenerate' && r.seq === excludeSeq))
        .map(r => (trigger === 'swipe' && r.seq === excludeSeq
            ? { ...r.msg, swipes: Array.isArray(r.msg.swipes) && r.msg.swipes.length ? r.msg.swipes : [r.msg.mes], swipe_id: Array.isArray(r.msg.swipes) && r.msg.swipes.length ? r.msg.swipes.length : 1 }
            : r.msg));

    // the connection that answers (the request's, else the chat's own, else the default) sizes the budget and is {{model}}
    const answering = profileId ? profileRow(db, profileId) : resolveChatProfile(db, chatId).row;
    // The budget is computed before the scan because the lore budget is a % of it.
    const maxContext = contextBudget(db, answering?.id);
    const reserve = replyReserve(db);

    const { pictures, sending, seeing, visible: windowRows } = promptWindow(db, rows, { answering, excludeSeq });
    let visible = windowRows;
    // The seqs ride ALONGSIDE, never on the message objects: these flow into assembleBlocks
    // and a seq field there would follow the turn into stored output.
    const historySeqs = visible.map(r => r.seq);
    const lastSeq = historySeqs.at(-1) ?? null;
    // a target this connection cant read (pictures alone, unseen) is not in the history, so nothing is pulled out as the continued turn
    const continuing = trigger === 'continue' && lastSeq !== null && (continueSeq == null || continueSeq === lastSeq);

    // one environment per build, built before the scan so a {{char}} key resolves at match time
    const macros = chatMacroEnv(db, chatRow, {
        card, charName, userName, persona, chat: macroChat, lastSeq,
        build: {
            model: answering?.model ?? '',
            maxContext, maxResponse: reserve, generationType: trigger, input, firstDisplayed,
        },
    });
    const m = macros.expand;
    // SillyTavern finishes the card's texts as a generation starts, so their macros run before the lore's and the preset's
    for (const key of CARD_TEXTS_AT_START) void macros.fields[key];

    // ST expands row 0 before every generation; the copies mean every later reader sees it expanded
    const first = rows.find(r => r.seq === 0 && r.seq !== excludeSeq);
    const firstBefore = first?.msg.mes;
    if (first && typeof first.msg.mes === 'string' && first.msg.mes) first.msg.mes = m(first.msg.mes);

    // regex scripts read each turn at its depth before the lore scan and the budget do; one budget for every pass of the build
    const regexScripts = scriptsForChat(db, chatId)?.active || [];
    const regexBudget = buildBudget();
    const depths = promptDepths(rows, excludeSeq, continuing);
    visible = regexHistory(db, regexScripts, visible, { continuing, expand: m, depths, budget: regexBudget });
    const history = visible.map(r => r.msg);
    const { blocks: presetBlocks, settings } = presetFor(db, chatId, { trigger });
    // a message copy to its pictures, by identity, so no field rides the turn into stored output
    const picturesOf = new WeakMap();
    if (sending) for (const r of visible) if (pictures.get(r.id)?.length) picturesOf.set(r.msg, pictures.get(r.id));
    // the newest turn's pictures are why it was sent: only older ones may stand in as text, oldest first
    const strippable = history.slice(0, -1).filter(msg => picturesOf.has(msg));

    // the note as the chat stands while it generates (ST counts the reader's turns of the whole chat)
    const meta = parsedMeta(chatRow);
    const noteState = chatNoteState(db, meta, macroChat);

    // lore scan window = the visible history window (the just-sent user turn is
    // already a row by the time generate runs)
    const scan = runLoreScan(db, chatRow, {
        visible, trigger, dryRun: loreDryRun, rng, macros, maxContext, note: noteState, names,
        regex: { scripts: regexScripts, budget: regexBudget },
    });
    const lore = scan.lore;
    // what {{outlet::name}} answers: the outlet entries of each name, one per line
    const outletTexts = {};
    for (const c of lore.outlets || []) (outletTexts[c.outlet] ||= []).push(c.content);
    macros.env.outlets = Object.fromEntries(Object.entries(outletTexts).map(([name, list]) => [name, list.join('\n')]));
    macros.env.outletsRead = new Set();

    // extension blocks follow the preset's, their text computed once so the budget only measures it
    const extensionBlocks = runRegistry('prompt.blocks', { db, chatId, charId: chatRow.char_id, dryRun: loreDryRun, lastSeq });
    const blocks = extensionBlocks?.length ? [...presetBlocks, ...extensionBlocks] : presetBlocks;
    // how the continued message is sent: as the reply's opening, or nudged by the instruction; null when none is continued
    const continuedAs = continuing ? (settings.continueAsOpening ? 'opening' : 'nudged') : null;
    const ctx = {
        card, fields: macros.fields,
        picturesOf: (msg) => picturesOf.get(msg),
        // the character's own portrait for its marker block, by reference (its size unread, so the budget counts the cap's square)
        characterPicture: sending ? { ref: { kind: 'avatar', id: char.id }, name: `${charName}.png` } : null,
        loreBefore: lore.before, loreAfter: lore.after, loreAtDepth: lore.atDepth,
        loreEmBefore: lore.emBefore, loreEmAfter: lore.emAfter,
        macro: m, settings, names: { user: userName, char: charName }, personaText: persona?.description || '', continuing: continuedAs,
        // every block expanded once in preset order, so {{incvar}} or a roll runs once however often the budget refits
        cache: new Map(),
    };
    // a reply written to the reader's direction: a new one, or a swipe or a reroll of one
    const directed = !!input && (trigger === 'normal' || trigger === 'swipe' || trigger === 'regenerate');
    // the preset's instruction for a turn that needs telling; an emptied one sends nothing, a message sent as the opening has none
    const instruction = trigger === 'impersonate' ? settings.impersonateInstruction
        : trigger === 'continue' ? (continuedAs === 'opening' ? '' : settings.continueInstruction)
            : directed ? settings.guidedInstruction : '';
    // the direction steers impersonate and a directed reply, after the instruction, marked as direction
    const direction = input && (trigger === 'impersonate' || directed) ? `Follow this direction for what to write, without quoting it back: ${input}` : '';
    // expanded before the blocks are; it goes inside assemble so every refit measures it
    const trailing = [instruction ? m(instruction) : '', direction].filter(Boolean).join('\n\n') || null;
    resolveBlocksInOrder(blocks, ctx);
    ctx.authorsNote = placedNote(noteState, lore, m);
    const assemble = (turns, stoodIn = 0) => {
        const msgs = assembleBlocks(blocks, { ...ctx, history: turns, stoodIn: new Set(strippable.slice(0, stoodIn)) });
        if (trailing) msgs.push({ role: 'system', content: trailing });
        return settings.joinSystem ? joinSystemMessages(msgs) : msgs;
    };

    // a host's picture limit: the pictures that must go (the newest turn's, the character's) count first, then the newest older ones that fit
    const cap = sending ? pictureCapOf(maxImagesOf(answering)) : null;
    // past the limit only when the window and the character's block could be: a chat under it assembles nothing more
    const held = history.reduce((n, msg) => n + (picturesOf.get(msg)?.length || 0), 0) + (ctx.characterPicture ? 1 : 0);
    const minStoodIn = cap && held > cap ? pictureFloor(strippable.map(msg => picturesOf.get(msg).length), imagesIn(assemble(history, strippable.length)), cap) : 0;

    // the budget re-assembles as turns drop, so it measures the real prompt
    const fitted = fitToBudget(assemble, history, { maxContext, reserveForReply: reserve, strippable: strippable.length, minStoodIn });

    if (fitted.overBudget) {
        // name the cause with each share (fixed part vs kept turns), so a pasted wall isnt blamed on the card
        const kept = fitted.history.length;
        const turns = Math.max(fitted.tokens - fitted.fixedTokens, 0);
        throw badRequest(
            `this chat does not fit the ${maxContext} token budget even with history trimmed to `
            + `${kept} message(s): the character definition, lore and examples come to about `
            + `${fitted.fixedTokens} tokens and the ${kept} newest message(s) to about ${turns} tokens. `
            + `Raise the budget or shorten ${turns > fitted.fixedTokens ? 'those messages' : 'the card'}.`,
        );
    }

    // the last word on what is sent (and what the prompt inspector shows), after the budget: what
    // an extension adds here is not measured
    const messages = runHook('prompt.final', fitted.messages, { db, chatId, charId: chatRow.char_id, trigger, dryRun: loreDryRun });
    // nothing to send is refused here, as a build that does not fit is, so the caller writes none of this build's state
    if (!messages.length) throw badRequest(EMPTY_BUILD);
    const firstSeq = historySeqs[historySeqs.length - fitted.history.length] ?? null;
    // what became of the pictures in the window, for the inspector: sent, stood in as text by the budget, or withheld from a blind connection
    const inWindow = (list) => list.reduce((n, msg) => n + (picturesOf.get(msg)?.length || 0), 0);
    const kept = new Set(fitted.history);
    const stoodIn = inWindow(strippable.slice(0, fitted.stoodIn).filter(msg => kept.has(msg)));
    // a blind connection's count includes the turns of pictures alone it is not sent at all
    const windowPictures = seeing.reduce((n, r) => n + (pictures.get(r.id)?.length || 0), 0);

    return {
        messages,
        charName,
        userName,
        // the preset's settings as this build read them (generate joins a continue on the joiner)
        settings,
        // what nothing in this build's vocabulary answers, for a reader of the prompt (the inspector)
        unanswered: (text) => unansweredMacros(text, macros.env),
        lore: { timedState: lore.timedState, notes: lore.notes, dryRun: loreDryRun, outletsWritten: [...macros.env.outletsRead] },
        // sent counts what goes, the character's picture and an extension's included
        pictures: { sent: imagesIn(messages), stoodIn, withheld: sending ? 0 : windowPictures },
        budget: {
            tokens: fitted.tokens,
            trimmed: fitted.trimmed,
            maxContext,
            reserve,
            // where the context starts, as a row: a raw trimmed count would need the client to redo the filters
            firstSeq,
            // every stored row, so this counts what the window and filters left out
            windowed: countMessages(db, chatId) - visible.length,
        },
        // the build's side effects, for generate alone to write through commitBuild
        commit: {
            timedState: lore.timedState,
            macros: macros.changes(),
            firstInContext: firstSeq,
            firstMessage: first && first.msg.mes !== firstBefore ? first.msg.mes : null,
            // the default note, stored into a chat without one once a reply lands, as ST keeps it
            noteSeed: noteSeed(meta, noteState.defaults),
        },
    };
}

/** Write a real build's side effects (buildChatPrompt's commit), in one write. */
export function commitBuild(db, chatId, commit) {
    const { metadata = {}, globals = null } = commit.macros || {};
    commitChatMacros(db, chatId, {
        metadata: {
            ...metadata,
            ...(commit.noteSeed || {}),
            timedWorldInfo: commit.timedState,
            ...(Number.isInteger(commit.firstInContext) ? { lastInContextMessageId: commit.firstInContext } : {}),
        },
        globals,
        firstMessage: commit.firstMessage ?? null,
    });
}
