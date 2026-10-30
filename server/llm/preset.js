// Prompt presets: an ordered list of TEXT and MARKER blocks that assembly walks. DEFAULT_BLOCKS is code so it cant be edited broken

import { picturesAsText } from './budget.js';

export const MARKERS = [
    'charDescription', 'charPersonality', 'scenario', 'personaDescription',
    'worldInfoBefore', 'worldInfoAfter', 'dialogueExamples', 'chatHistory', 'characterPicture',
];

// 'at_depth' anchors a block inside the history, N turns back from the newest (ST's absolute position)
export const POSITIONS = ['pre_history', 'post_history', 'at_depth'];

export const DEFAULT_INJECTION_ORDER = 100;

// `name` is display only, so the two text blocks dont render as their raw ids
export const DEFAULT_BLOCKS = [
    { kind: 'text', marker: null, content: '', role: 'system', position: 'pre_history', enabled: 1, pos: 0, id: 'main', name: 'Main prompt' },
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

// what an empty main block sends when the card has no system prompt, and what {{defaultSystemPrompt}} answers
export const DEFAULT_MAIN_PROMPT = 'You play {{char}} in an ongoing story with {{user}}. '
    + 'Stay in character and drive the scene forward; write only {{char}}\'s turn.';

// The card's own text for each card-backed block (see resolveText), by its field name.
const CARD_BACKED = { main: 'system_prompt', jailbreak: 'post_history_instructions' };

/**
 * Walk blocks into a messages array; consecutive single-string blocks of one role and position join into one message.
 * @param {Array} blocks ordered, already filtered to enabled
 * @param {Object} ctx { card, fields, history, macro, defaultMain, cache, authorsNote, and the lore groups }; cache is resolveBlocksInOrder's
 * @returns {Array<{role: string, content: string}>}
 */
export function assembleBlocks(blocks, ctx) {
    const out = [];
    let run = null; // { role, position, parts[] }

    const flush = () => {
        if (!run) return;
        const content = run.parts.filter(Boolean).join('\n\n');
        if (content) out.push({ role: run.role, content });
        run = null;
    };

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
    ctx = { ...ctx, anchoredBlocks: anchored };

    // merge on role AND position, or blocks either side of a missing history boundary would merge
    const emit = (text, role, position) => {
        if (!text) return;
        if (run && run.role === role && run.position === position) run.parts.push(text);
        else { flush(); run = { role, position, parts: [text] }; }
    };
    // the note before or after main goes beside it in its own role, as ST puts it into main's collection
    const note = ctx.authorsNote;
    const besideMain = note && (note.position === NOTE_BEFORE || note.position === NOTE_AFTER) ? note : null;

    for (const block of ordered) {
        const resolved = resolveBlock(block, ctx);
        const isMain = besideMain && block.id === 'main';
        if (isMain && besideMain.position === NOTE_BEFORE) emit(besideMain.content, besideMain.role, block.position);
        if (resolved !== null && resolved !== undefined) {
            if (Array.isArray(resolved)) {
                flush();
                out.push(...resolved);
            } else {
                emit(String(resolved), block.role, block.position);
            }
        }
        if (isMain && besideMain.position === NOTE_AFTER) emit(besideMain.content, besideMain.role, block.position);
    }
    flush();
    return out;
}

// ST's extension_prompt_types as the note keeps them: after the main prompt, in the chat, before it
const NOTE_AFTER = 0;
const NOTE_IN_CHAT = 1;
const NOTE_BEFORE = 2;

// Lore content arrives expanded: the scan expands each entry once when it activates, as ST does.
function renderLore(entries) {
    if (!entries || !entries.length) return null;
    return `World information:\n${entries.map(e => e.content.trim()).join('\n')}`;
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

/**
 * Splice everything anchored at a depth into the conversation; messages go as written, a turn's pictures with it.
 * @param {Array} history raw chat rows
 * @param {Array} items { depth, role, order, content }, in tie order, content already expanded
 * @param {object} [ctx] picturesOf (row to its pictures) and stoodIn (the rows whose pictures are text)
 */
function withDepthInjections(history, items, ctx = null) {
    const turns = history.map(row => turnOf(row, ctx));
    if (!items || !items.length) return userCarriesPictures(turns);

    // ties keep the caller's sequence (lore by its order, blocks by preset order)
    const byDepth = new Map();
    for (const item of items) {
        const role = DEPTH_ROLE_ORDER.includes(item.role) ? item.role : 'system';
        const order = Number.isFinite(item.order) ? item.order : DEFAULT_INJECTION_ORDER;
        const text = String(item.content ?? '').trim();
        if (!text) continue;
        if (!byDepth.has(item.depth)) byDepth.set(item.depth, new Map());
        const buckets = byDepth.get(item.depth);
        if (!buckets.has(order)) buckets.set(order, new Map());
        const roles = buckets.get(order);
        if (!roles.has(role)) roles.set(role, []);
        roles.get(role).push(text);
    }

    // Deepest first, so an earlier splice cannot shift the index a later one counts to.
    for (const depth of [...byDepth.keys()].sort((a, b) => b - a)) {
        const buckets = byDepth.get(depth);
        const group = [];
        for (const order of [...buckets.keys()].sort((a, b) => a - b)) {
            const roles = buckets.get(order);
            for (const role of DEPTH_ROLE_ORDER) {
                if (roles.has(role)) group.push({ role, content: roles.get(role).join('\n') });
            }
        }
        turns.splice(Math.max(0, turns.length - depth), 0, ...group);
    }
    return userCarriesPictures(turns);
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
        const beside = an && b.id === 'main' && (an.position === NOTE_BEFORE || an.position === NOTE_AFTER);
        if (beside && an.position === NOTE_BEFORE) items.push({ ...item, content: an.content });
        items.push({ ...item, content: anchoredText(b, ctx) });
        if (beside && an.position === NOTE_AFTER) items.push({ ...item, content: an.content });
    }
    // one text per depth and role in ST's key order: the note, the card's note, then the lore
    if (an && an.position === NOTE_IN_CHAT && Number.isInteger(an.depth) && an.depth >= 0 && DEPTH_ROLE_ORDER.includes(an.role)) {
        items.push({ depth: an.depth, role: an.role, order: DEFAULT_INJECTION_ORDER, content: an.content });
    }
    // the card's Character's Note, at ST's defaults (depth 4, system) when the card leaves them out
    const note = ctx.card?.extensions?.depth_prompt;
    if (note && ctx.fields?.depth_prompt) {
        items.push({
            depth: Number.isInteger(note.depth) ? Math.max(note.depth, 0) : 4,
            role: DEPTH_ROLE_ORDER.includes(note.role) ? note.role : 'system',
            order: DEFAULT_INJECTION_ORDER,
            content: ctx.fields.depth_prompt,
        });
    }
    for (const e of ctx.loreAtDepth || []) {
        items.push({ depth: e.depth, role: e.role, order: DEFAULT_INJECTION_ORDER, content: String(e.content ?? '').trim() });
    }
    return items;
}

/** The text a TEXT block contributes; the card wins over the preset for main and jailbreak unless forbidOverrides. */
function resolveText(block, ctx) {
    const { macro } = ctx;
    const preset = typeof block.content === 'string' ? block.content : '';
    const prepared = macro(preset);
    const backing = CARD_BACKED[block.id];
    const override = backing && !block.forbidOverrides ? ctx.fields?.[backing] || '' : '';
    if (override) return macro(override, { original: prepared });
    if (!preset.trim()) return block.id === 'main' ? macro(ctx.defaultMain) : '';
    return prepared;
}

// a block's text from the build's cache, expanding it the first time only
function cached(ctx, block, compute) {
    if (!ctx.cache) return compute();
    if (!ctx.cache.has(block)) ctx.cache.set(block, compute());
    return ctx.cache.get(block);
}

/** Expand every block's text once, in order, before placing any: a variable one block sets is what a later one reads. */
export function resolveBlocksInOrder(blocks, ctx) {
    for (const block of blocks) {
        if (!(block.kind === 'marker' && block.marker === 'chatHistory')) resolveBlock(block, ctx);
    }
}

// a string (mergeable), messages (standalone) or null; a card marker goes through its field's macro
function resolveBlock(block, ctx) {
    if (block.kind === 'text') return cached(ctx, block, () => resolveText(block, ctx)) || null;
    if (block.marker === 'chatHistory') return withDepthInjections(ctx.history, depthItems(ctx), ctx);
    return cached(ctx, block, () => resolveMarker(block, ctx));
}

const EXAMPLE_MARKER = '<START>';

/** The card's example dialogue as trimmed blocks, an empty one kept; text before the first marker is a block unless the card opens on it. */
export function exampleTexts(raw) {
    if (!raw || raw === EXAMPLE_MARKER) return [];
    const [lead, ...rest] = raw.split(/<START>/i).map(part => part.trim());
    return raw.startsWith(EXAMPLE_MARKER) ? rest : [lead, ...rest];
}

function resolveMarker(block, ctx) {
    const { macro } = ctx;
    switch (block.marker) {
        case 'charDescription':
            return macro('{{description}}') || null;
        case 'charPersonality':
            return macro('{{personality}}') ? macro("{{char}}'s personality: {{personality}}") : null;
        case 'scenario':
            return macro('{{scenario}}') ? macro('Scenario: {{scenario}}') : null;
        case 'personaDescription':
            return macro('{{persona}}') ? macro('About {{user}}: {{persona}}') : null;
        // two slots by the entries' own position; an empty group renders nothing
        case 'worldInfoBefore':
            return renderLore(ctx.loreBefore);
        case 'worldInfoAfter':
            return renderLore(ctx.loreAfter);
        case 'dialogueExamples': {
            // EM lore wraps the card's examples, as ST's example lane does, even when the card has none
            const emMsgs = list => (list || [])
                .map(e => String(e.content ?? '').trim())
                .filter(Boolean)
                .map(t => ({ role: block.role, content: `[Example chat]\n${t}` }));
            // finished, then split: ST parses the examples after substituting them
            const cardBlocks = exampleTexts(String(ctx.fields?.mes_example || '')).filter(Boolean)
                .map(b => ({ role: block.role, content: `[Example chat]\n${b}` }));
            const msgs = [...emMsgs(ctx.loreEmBefore), ...cardBlocks, ...emMsgs(ctx.loreEmAfter)];
            return msgs.length ? msgs : null;
        }
        // the character's own portrait, a user turn whatever the block's role (the hosts take pictures there only); none to a blind connection
        case 'characterPicture':
            return ctx.characterPicture ? [{ role: 'user', content: macro("[A picture of {{char}}]"), images: [ctx.characterPicture] }] : null;
        default:
            return null;
    }
}

// Rows -> the block shape assembleBlocks expects. Disabled blocks never reach it.
export function blocksFromRows(rows) {
    return rows
        .filter(r => r.enabled)
        .sort((a, b) => a.pos - b.pos)
        .map(r => ({
            id: r.block_key || r.id,
            kind: r.kind,
            marker: r.marker,
            content: r.content || '',
            role: r.role || 'system',
            position: r.position || 'pre_history',
            depth: r.depth ?? 0,
            injectionOrder: r.injection_order ?? DEFAULT_INJECTION_ORDER,
            forbidOverrides: !!r.forbid_overrides,
            enabled: 1,
            pos: r.pos,
        }));
}
