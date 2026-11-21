// Prompt presets: an ordered list of TEXT and MARKER blocks that assembly walks. DEFAULT_BLOCKS is code so it cant be edited broken

import { picturesAsText } from './budget.js';

export const MARKERS = [
    'charDescription', 'charPersonality', 'scenario', 'personaDescription',
    'worldInfoBefore', 'worldInfoAfter', 'dialogueExamples', 'chatHistory', 'characterPicture',
];

// 'at_depth' anchors a block inside the history, N turns back from the newest (ST's absolute position)
export const POSITIONS = ['pre_history', 'post_history', 'at_depth'];

export const DEFAULT_INJECTION_ORDER = 100;

/** Where the Author's Note goes, by the code a chat stores: after the main prompt, in the chat, before it. */
export const NOTE_POSITION = Object.freeze({ after: 0, inChat: 1, before: 2 });

// ST's generation types, in its order; a block naming some fires only on those (Send is normal), none fires on every one
export const TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];

/** A block's trigger list as stored or sent: the known types in ST's order, then any other once; empty fires on every type. */
export function normalizeTriggers(value) {
    let list = value;
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
    if (!Array.isArray(list)) return [];
    // a type this app does not know (a newer ST's) is kept, so the block fires on none it makes, as ST would send it
    const other = [...new Set(list.filter(t => typeof t === 'string' && t && t.length <= 32 && !TRIGGERS.includes(t)))].slice(0, 16);
    return [...TRIGGERS.filter(t => list.includes(t)), ...other];
}

/** Whether a block fires on this generation type: one naming no type fires on every one. */
export function firesOn(triggers, type) {
    return !triggers.length || triggers.includes(type);
}

// the built-in Main block's text, what {{defaultSystemPrompt}} answers, and {{systemPrompt}} on a card without one
export const DEFAULT_MAIN_PROMPT = 'You play {{char}} in an ongoing story with {{user}}. '
    + 'Stay in character and drive the scene forward; write only {{char}}\'s turn.';

// The three instructions a turn that needs telling ends on, this app's own words
export const DEFAULT_IMPERSONATE_INSTRUCTION =
    "It is {{user}}'s turn. Give ONLY their next message, in their own voice, as their reply to {{char}}: "
    + 'no narration about {{char}}, no quotation marks around the whole of it, and nothing addressed to the assistant.';

// continue extends, it is not a new turn; the output is joined onto the message
export const DEFAULT_CONTINUE_INSTRUCTION =
    "Continue {{char}}'s final message from exactly where it stops. "
    + 'Do not repeat any of it, do not restart it, and do not begin a new message or a new paragraph '
    + 'unless the text clearly ended one. Your first character continues directly from its last character, '
    + 'so begin with a space if the sentence needs one.';

// a guided reply: the composer text is direction for the character's turn
export const DEFAULT_GUIDED_INSTRUCTION = "Continue the scene with {{char}}'s next reply, naturally and in the style already set. Stay in character.";

// where a lore group's entries go in its wrapper
export const LORE_SLOT = '{{lore}}';

// How a preset builds its prompt around its blocks, each a value the reader sees and changes; a missing one reads its default
export const PROMPT_SETTINGS = {
    personalityFormat: { type: 'string', default: '{{personality}}' },
    scenarioFormat: { type: 'string', default: '{{scenario}}' },
    loreFormat: { type: 'string', default: LORE_SLOT },
    chatStart: { type: 'string', default: '' },
    exampleSeparator: { type: 'string', default: '' },
    joinSystem: { type: 'boolean', default: false },
    impersonateInstruction: { type: 'string', default: DEFAULT_IMPERSONATE_INSTRUCTION },
    continueInstruction: { type: 'string', default: DEFAULT_CONTINUE_INSTRUCTION },
    guidedInstruction: { type: 'string', default: DEFAULT_GUIDED_INSTRUCTION },
    continueJoiner: { type: 'string', default: '' },
    continueAsOpening: { type: 'boolean', default: false },
};
const SETTING_TEXT_MAX = 20000;

/** Why a settings object is refused, or null: an unknown key, a wrong type or an overlong text; null resets one. */
export function promptSettingsError(value) {
    if (value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) return 'settings is an object';
    for (const [key, v] of Object.entries(value)) {
        if (!Object.hasOwn(PROMPT_SETTINGS, key)) return `unknown setting '${key}'; valid: ${Object.keys(PROMPT_SETTINGS).join(', ')}`;
        if (v === null) continue;
        const { type } = PROMPT_SETTINGS[key];
        if (typeof v !== type) return `setting '${key}' must be a ${type}`;
        if (type === 'string' && v.length > SETTING_TEXT_MAX) return `setting '${key}' is at most ${SETTING_TEXT_MAX} characters`;
    }
    return null;
}

/** The settings a preset stores, read leniently (a stored row, a SillyTavern file): known ones of the right type; null drops one. */
export function storablePromptSettings(value) {
    const out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [name, { type }] of Object.entries(PROMPT_SETTINGS)) {
        const v = value[name];
        if (typeof v === type && (type !== 'string' || v.length <= SETTING_TEXT_MAX)) out[name] = v;
    }
    return out;
}

/** Every setting a build reads: the stored ones over the defaults. */
export function promptSettingsOf(stored) {
    const out = Object.fromEntries(Object.entries(PROMPT_SETTINGS).map(([name, { default: d }]) => [name, d]));
    return { ...out, ...storablePromptSettings(stored) };
}

// `name` is display only, so the two text blocks dont render as their raw ids
export const DEFAULT_BLOCKS = [
    { kind: 'text', marker: null, content: DEFAULT_MAIN_PROMPT, role: 'system', position: 'pre_history', enabled: 1, pos: 0, id: 'main', name: 'Main prompt' },
    { kind: 'marker', marker: 'charDescription', content: '', role: 'system', position: 'pre_history', enabled: 1, pos: 1, id: 'charDescription' },
    { kind: 'marker', marker: 'charPersonality', content: '', role: 'system', position: 'pre_history', enabled: 1, pos: 2, id: 'charPersonality' },
    { kind: 'marker', marker: 'scenario', content: '', role: 'system', position: 'pre_history', enabled: 1, pos: 3, id: 'scenario' },
    { kind: 'marker', marker: 'worldInfoBefore', content: '', role: 'system', position: 'pre_history', enabled: 1, pos: 4, id: 'worldInfoBefore' },
    { kind: 'marker', marker: 'personaDescription', content: '', role: 'system', position: 'pre_history', enabled: 1, pos: 5, id: 'personaDescription' },
    { kind: 'marker', marker: 'worldInfoAfter', content: '', role: 'system', position: 'pre_history', enabled: 1, pos: 6, id: 'worldInfoAfter' },
    { kind: 'marker', marker: 'dialogueExamples', content: '', role: 'system', position: 'pre_history', enabled: 1, pos: 7, id: 'dialogueExamples' },
    { kind: 'marker', marker: 'chatHistory', content: '', role: 'system', position: 'pre_history', enabled: 1, pos: 8, id: 'chatHistory' },
    { kind: 'text', marker: null, content: '', role: 'system', position: 'post_history', enabled: 1, pos: 9, id: 'jailbreak', name: 'Post-history instructions' },
];

// The card's own text for each card-backed block (see resolveText), by its field name.
const CARD_BACKED = { main: 'system_prompt', jailbreak: 'post_history_instructions' };

/**
 * Walk blocks into a messages array, one message per block (the preset's joinSystem merges after, joinSystemMessages).
 * @param {Array} blocks ordered, already filtered to enabled
 * @param {Object} ctx { card, fields, history, macro, settings, names, personaText, cache, authorsNote, and the lore groups }
 * @returns {Array<{role: string, content: string, name?: string}>}
 */
export function assembleBlocks(blocks, ctx) {
    const out = [];

    // position is a placement: pre_history before the conversation, post_history after, each in pos order
    const isHistory = (b) => b.kind === 'marker' && b.marker === 'chatHistory';
    const isAtDepth = (b) => !isHistory(b) && b.position === 'at_depth';
    // at_depth blocks splice into the history; with no history marker they emit in place, never dropped
    const hasHistory = blocks.some(isHistory);
    const anchored = hasHistory ? blocks.filter(isAtDepth) : [];
    const inWalk = b => !anchored.includes(b);
    const ordered = [
        ...blocks.filter(b => inWalk(b) && !isHistory(b) && b.position !== 'post_history'),
        ...blocks.filter(isHistory),
        ...blocks.filter(b => inWalk(b) && !isHistory(b) && b.position === 'post_history'),
    ];
    ctx = { ...ctx, settings: ctx.settings || promptSettingsOf(null), anchoredBlocks: anchored };

    const emit = (text, role) => { if (text) out.push({ role, content: text }); };
    // the note before or after main goes beside it in its own role, as ST puts it into main's collection
    const note = ctx.authorsNote;
    const besideMain = note && (note.position === NOTE_POSITION.before || note.position === NOTE_POSITION.after) ? note : null;
    const breaks = new Set();
    JOIN_BREAKS.set(out, breaks);

    for (const block of ordered) {
        const resolved = resolveBlock(block, ctx);
        const isMain = besideMain && block.id === 'main';
        if (isMain && besideMain.position === NOTE_POSITION.before) emit(besideMain.content, besideMain.role);
        if (resolved !== null && resolved !== undefined) {
            if (Array.isArray(resolved)) out.push(...resolved);
            else emit(String(resolved), block.role);
        } else if (breaksJoin(block)) breaks.add(out.length);
        if (isMain && besideMain.position === NOTE_POSITION.after) emit(besideMain.content, besideMain.role);
    }
    out.push(...continuedTurns(ctx));
    return out;
}

// the blocks ST adds as one message each, an empty one included, so an empty one of another role ends its squash's run
const ONE_MESSAGE_MARKERS = new Set(['charDescription', 'charPersonality', 'scenario', 'personaDescription', 'worldInfoBefore', 'worldInfoAfter']);
// a depth block placed in the walk (no history marker) is one ST never adds, so it ends nothing
const breaksJoin = (block) => block.role !== 'system' && block.position !== 'at_depth' && (block.kind === 'text' || ONE_MESSAGE_MARKERS.has(block.marker));

// Entries arrive expanded; the group joins as written into the wrapper and the whole expands again, wrapper included, as ST does
function renderLore(entries, settings, macro) {
    if (!entries || !entries.length) return null;
    const text = entries.map(e => e.content).join('\n');
    // a blank wrapper sends the entries as they are
    return macro(settings.loreFormat.trim() ? settings.loreFormat.split(LORE_SLOT).join(text) : text) || null;
}

// the messages never joined with a neighbour: the chat start line, the example separators and the example turns
const KEPT_APART = new WeakSet();
const apart = (msg) => { KEPT_APART.add(msg); return msg; };
// assembleBlocks' output to the places an empty block of another role stood, each the index of the message after it
const JOIN_BREAKS = new WeakMap();

/** joinSystem: adjacent unnamed system messages join on a newline, never across a kept-apart one or an empty other-role block; new objects, cached ones untouched. */
export function joinSystemMessages(messages) {
    const joins = (m) => m.role === 'system' && !m.name && !KEPT_APART.has(m) && !m.images;
    const breaks = JOIN_BREAKS.get(messages);
    const out = [];
    let broken = false;
    for (const [i, m] of messages.entries()) {
        if (breaks?.has(i)) broken = true;
        if (m.role === 'system' && !m.content && !m.images) continue;
        const last = out.at(-1);
        if (last && !broken && joins(m) && joins(last)) out[out.length - 1] = { ...last, content: `${last.content}\n${m.content}` };
        else out.push(m);
        broken = false;
    }
    return out;
}

// an example block as turns: "<name>:" opens one, earlier lines join the first; the speaker stays in the text, so any host reads it
function exampleTurns(block, userName, charName) {
    const turns = [];
    let lines = [];
    let who = null;
    const close = () => {
        const text = lines.join('\n');
        // a turn of its speaker's name alone says nothing and is not sent
        const said = text.replace(`${who === 'user' ? userName : charName}:`, '').trim();
        turns.push(apart({ role: 'system', content: said ? text.trim() : '' }));
        lines = [];
    };
    for (const line of block.replace(/\r/g, '').split('\n')) {
        const opens = line.startsWith(`${userName}:`) ? 'user' : line.startsWith(`${charName}:`) ? 'char' : null;
        if (opens && who && opens !== who) close();
        if (opens) who = opens;
        lines.push(line);
    }
    if (who) close();
    // no line opens a turn (its speakers are written another way, or it is prose): the block goes whole, as one turn of text
    else turns.push(apart({ role: 'system', content: lines.join('\n') }));
    return turns.filter(t => t.content);
}

// one message per depth, order bucket and role, in ST's order; three depth-0 entries are not three system turns
const DEPTH_ROLE_ORDER = ['assistant', 'user', 'system'];

// what the user turn carrying a character's pictures says, since the hosts take pictures in the user's turns only
export const PICTURES_BEFORE_REPLY = '[Shown with the next message]';

// a turn's pictures as the layer takes them (by reference, with the size the budget reads), or as text when the budget stood them in
function turnOf(row, ctx) {
    // carriage returns dropped, as ST sends a message
    const turn = { role: row.is_user ? 'user' : 'assistant', content: String(row.mes ?? '').replace(/\r/g, '') };
    const shown = ctx?.picturesOf?.(row);
    if (!shown?.length) return turn;
    if (ctx.stoodIn?.has(row)) return { ...turn, content: picturesAsText(turn.content, shown) };
    return { ...turn, images: shown.map(a => ({ ref: { kind: 'attachment', id: a.id }, width: a.width, height: a.height, name: a.name })) };
}

// after the depth splice, so a depth still counts the chat's messages: a character's pictures go just before its turn
const userCarriesPictures = (turns) => turns.flatMap(t => (t.images && t.role !== 'user'
    ? [{ role: 'user', content: PICTURES_BEFORE_REPLY, images: t.images }, ...(t.content ? [{ role: t.role, content: t.content }] : [])]
    : [t]));

// a continue's message goes after everything, built as every turn is: its reasoning in think tags, its pictures on the note before it
function continuedTurns(ctx) {
    const row = ctx.continuing ? ctx.history?.at(-1) : null;
    if (!row) return [];
    const turn = turnOf(row, ctx);
    const content = `${row.extra?.reasoning ? `<think>${row.extra.reasoning}</think>\n` : ''}${turn.content}`;
    return userCarriesPictures([{ ...turn, content }]);
}

/**
 * Splice everything anchored at a depth into the conversation; messages go as written, a turn's pictures with it.
 * @param {Array} history raw chat rows
 * @param {Array} items { depth, role, order, content }, in tie order, content already expanded
 * @param {object} [ctx] picturesOf (row to its pictures) and stoodIn (the rows whose pictures are text)
 */
function withDepthInjections(history, items, ctx = null) {
    const turns = history.map(row => turnOf(row, ctx));
    // a continue's message leaves, as assembleBlocks sends it after everything: nudged, it counts for the depths first; an opening never does
    const continued = ctx?.continuing ? turns.at(-1) : null;
    if (continued && ctx.continuing === 'opening') turns.pop();
    // a turn a prompt script emptied still counts for the depths, then is not sent
    const settled = () => userCarriesPictures(turns.filter(t => t !== continued && (t.content || t.images)));
    if (!items || !items.length) return settled();

    // ties keep the caller's sequence (lore by its order, blocks by preset order)
    const byDepth = new Map();
    for (const item of items) {
        const role = DEPTH_ROLE_ORDER.includes(item.role) ? item.role : 'system';
        const order = Number.isFinite(item.order) ? item.order : DEFAULT_INJECTION_ORDER;
        // a depth's blocks join as written, whitespace-only ones too, as do its lore entries; the notes trimmed one by one
        const raw = String(item.content ?? '');
        const text = item.block || item.lore ? raw : raw.trim();
        if (item.block ? !text : !text.trim()) continue;
        if (!byDepth.has(item.depth)) byDepth.set(item.depth, new Map());
        const buckets = byDepth.get(item.depth);
        if (!buckets.has(order)) buckets.set(order, new Map());
        const roles = buckets.get(order);
        if (!roles.has(role)) roles.set(role, []);
        roles.get(role).push({ text, block: !!item.block, lore: !!item.lore });
    }
    // each run kept while it holds any text, then trimmed, so a whitespace-only block run beside the notes leaves an empty line
    const joined = (list) => [list.filter(x => x.block), list.filter(x => !x.block && !x.lore), list.filter(x => x.lore)]
        .map(part => part.map(x => x.text).join('\n')).filter(Boolean).map(run => run.trim()).join('\n');

    // Shallowest first from the newest turn, past the groups already placed: a depth past the oldest lands above it, as ST places them
    turns.reverse();
    let placed = 0;
    for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
        const buckets = byDepth.get(depth);
        const group = [];
        for (const order of [...buckets.keys()].sort((a, b) => a - b)) {
            const roles = buckets.get(order);
            for (const role of DEPTH_ROLE_ORDER) {
                if (roles.has(role)) group.push({ role, content: joined(roles.get(role)) });
            }
        }
        turns.splice(depth + placed, 0, ...group.reverse());
        placed += group.length;
    }
    turns.reverse();
    return settled();
}

// what an anchored block says at its depth; a marker's cached messages join as one text
function anchoredText(block, ctx) {
    if (block.kind === 'marker' && block.marker === 'chatHistory') return '';
    const v = block.kind === 'marker' ? cached(ctx, block, () => resolveMarker(block, ctx)) : cached(ctx, block, () => resolveText(block, ctx));
    if (Array.isArray(v)) return v.map(m => String(m?.content ?? '')).filter(Boolean).join('\n');
    return typeof v === 'string' ? v : '';
}

// blocks and ST's extension prompts share one lane per depth, the extension prompts after the blocks
function depthItems(ctx) {
    const items = [];
    const an = ctx.authorsNote;
    for (const b of ctx.anchoredBlocks || []) {
        const item = {
            depth: Number.isInteger(b.depth) ? Math.max(b.depth, 0) : 0,
            role: b.role || 'system',
            order: Number.isFinite(b.injectionOrder) ? b.injectionOrder : DEFAULT_INJECTION_ORDER,
        };
        // a note beside an anchored main takes main's depth, role and order
        const beside = an && b.id === 'main' && (an.position === NOTE_POSITION.before || an.position === NOTE_POSITION.after);
        if (beside && an.position === NOTE_POSITION.before) items.push({ ...item, content: an.content, block: true });
        items.push({ ...item, content: anchoredText(b, ctx), block: true });
        if (beside && an.position === NOTE_POSITION.after) items.push({ ...item, content: an.content, block: true });
    }
    // one text per depth and role in ST's key order: the note, the card's note, then the lore
    if (an && an.position === NOTE_POSITION.inChat && Number.isInteger(an.depth) && an.depth >= 0 && DEPTH_ROLE_ORDER.includes(an.role)) {
        items.push({ depth: an.depth, role: an.role, order: DEFAULT_INJECTION_ORDER, content: an.content });
    }
    // the card's Character's Note, at ST's defaults (depth 4, system) when the card leaves them out; ST's walk places no negative depth
    const note = ctx.card?.extensions?.depth_prompt;
    if (note && ctx.fields?.depth_prompt && !(Number.isInteger(note.depth) && note.depth < 0)) {
        items.push({
            depth: Number.isInteger(note.depth) ? note.depth : 4,
            role: DEPTH_ROLE_ORDER.includes(note.role) ? note.role : 'system',
            order: DEFAULT_INJECTION_ORDER,
            content: ctx.fields.depth_prompt,
        });
    }
    for (const e of ctx.loreAtDepth || []) {
        items.push({ depth: e.depth, role: e.role, order: DEFAULT_INJECTION_ORDER, content: String(e.content ?? ''), lore: true });
    }
    return items;
}

/** The text a TEXT block contributes; the card wins over the preset for main and jailbreak unless forbidOverrides. */
function resolveText(block, ctx) {
    const { macro } = ctx;
    const preset = typeof block.content === 'string' ? block.content : '';
    const prepared = macro(preset);
    const backing = CARD_BACKED[block.id];
    const override = backing && !block.forbidOverrides && !block.off ? ctx.fields?.[backing] || '' : '';
    if (override) return macro(override, { original: prepared });
    // a block of only whitespace is sent as written
    return prepared;
}

// a block's text from the build's cache, expanding it the first time only
function cached(ctx, block, compute) {
    if (!ctx.cache) return compute();
    if (!ctx.cache.has(block)) ctx.cache.set(block, compute());
    return ctx.cache.get(block);
}

/** Expand every block's text once before placing any: the scenario then personality wrappers, the rest in order, the persona last. */
export function resolveBlocksInOrder(blocks, ctx) {
    const isMarker = (block, name) => block.kind === 'marker' && block.marker === name;
    const first = ['scenario', 'charPersonality'].flatMap(name => blocks.filter(b => isMarker(b, name)));
    const last = blocks.filter(b => isMarker(b, 'personaDescription'));
    const middle = blocks.filter(b => !first.includes(b) && !last.includes(b) && !isMarker(b, 'chatHistory'));
    for (const block of [...first, ...middle, ...last]) resolveBlock(block, ctx);
}

// a string (mergeable), messages (standalone) or null; a card marker goes through its field's macro
function resolveBlock(block, ctx) {
    if (block.kind === 'text') return cached(ctx, block, () => resolveText(block, ctx)) || null;
    if (block.marker === 'chatHistory') {
        const turns = withDepthInjections(ctx.history, depthItems(ctx), ctx);
        // the preset's chat start line opens the history, expanded once per build
        const opener = ctx.settings.chatStart ? cached(ctx, CHAT_START, () => ctx.macro(ctx.settings.chatStart)) : '';
        return opener ? [apart({ role: 'system', content: opener }), ...turns] : turns;
    }
    return cached(ctx, block, () => resolveMarker(block, ctx));
}

// the chat start line's key in the build's cache
const CHAT_START = { marker: 'chatStart' };

const EXAMPLE_MARKER = '<START>';

/** The card's example dialogue as trimmed blocks, an empty one kept; text before the first marker is a block unless the card opens on it. */
export function exampleTexts(raw) {
    if (!raw || raw === EXAMPLE_MARKER) return [];
    const [lead, ...rest] = raw.split(/<START>/i).map(part => part.trim());
    return raw.startsWith(EXAMPLE_MARKER) ? rest : [lead, ...rest];
}

function resolveMarker(block, ctx) {
    const { macro, settings } = ctx;
    // a card field through the preset's wrapper, an empty wrapper sending the field as it is; an empty field sends nothing
    const wrapped = (field, format) => {
        const value = macro(field);
        return value ? (format ? macro(format) || null : value) : null;
    };
    switch (block.marker) {
        case 'charDescription':
            return macro('{{description}}') || null;
        case 'charPersonality':
            return wrapped('{{personality}}', settings.personalityFormat);
        case 'scenario':
            return wrapped('{{scenario}}', settings.scenarioFormat);
        // the description as the persona holds it, untrimmed, its macros expanded
        case 'personaDescription':
            return ctx.personaText ? macro(ctx.personaText) || null : null;
        // two slots by the entries' own position; an empty group renders nothing
        case 'worldInfoBefore':
            return renderLore(ctx.loreBefore, settings, macro);
        case 'worldInfoAfter':
            return renderLore(ctx.loreAfter, settings, macro);
        case 'dialogueExamples': {
            const separator = settings.exampleSeparator ? macro(settings.exampleSeparator) : '';
            // finished, then split: ST parses the examples after substituting them
            const blocksOf = (text) => exampleTexts(String(text ?? ''));
            // each example lore entry's blocks as ST folds them in: the before ones each go ahead of the last
            const before = (ctx.loreEmBefore || []).reduce((acc, e) => [...blocksOf(e.content), ...acc], []);
            const after = (ctx.loreEmAfter || []).flatMap(e => blocksOf(e.content));
            const { user, char } = ctx.names || {};
            const msgs = [...before, ...blocksOf(ctx.fields?.mes_example), ...after].flatMap(b => [
                ...(separator ? [apart({ role: 'system', content: separator })] : []),
                ...exampleTurns(b, user ?? '', char ?? ''),
            ]);
            return msgs.length ? msgs : null;
        }
        // the character's own portrait, a user turn whatever the block's role (the hosts take pictures there only); none to a blind connection
        case 'characterPicture':
            return ctx.characterPicture ? [{ role: 'user', content: macro("[A picture of {{char}}]"), images: [ctx.characterPicture] }] : null;
        default:
            return null;
    }
}

// A stored preset's blocks (getPreset's) -> what assembleBlocks expects: disabled or held ones drop out, save Main, kept empty as an anchor
export function blocksForBuild(blocks, { trigger = 'normal' } = {}) {
    const held = (b) => !firesOn(b.triggers, trigger);
    const isMain = (b) => (b.key || b.id) === 'main';
    return blocks
        .filter(b => (b.enabled && !held(b)) || isMain(b))
        .map(b => ({
            id: b.key || b.id,
            kind: b.kind,
            marker: b.marker,
            content: b.content || '',
            role: b.role || 'system',
            position: b.position || 'pre_history',
            depth: b.depth ?? 0,
            injectionOrder: b.injectionOrder,
            forbidOverrides: b.forbidOverrides,
            ...(!b.enabled ? { content: '', held: true, off: true } : held(b) ? { content: '', held: true } : {}),
            enabled: 1,
            pos: b.pos,
        }));
}
