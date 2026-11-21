// A SillyTavern chat-completion preset file and this app's preset: its prompts become blocks, its settings the preset's

import { DEFAULT_INJECTION_ORDER, LORE_SLOT, normalizeTriggers, storablePromptSettings, promptSettingsOf } from '../llm/preset.js';

// the file's key -> the preset setting it fills; its lore format holds the lore at {0}
const SETTINGS_FROM_FILE = {
    squash_system_messages: 'joinSystem',
    personality_format: 'personalityFormat',
    scenario_format: 'scenarioFormat',
    wi_format: 'loreFormat',
    new_chat_prompt: 'chatStart',
    new_example_chat_prompt: 'exampleSeparator',
    impersonation_prompt: 'impersonateInstruction',
    continue_nudge_prompt: 'continueInstruction',
    continue_postfix: 'continueJoiner',
    continue_prefill: 'continueAsOpening',
};
const FILE_LORE_SLOT = '{0}';

/** The preset settings a file's keys carry, in the preset's own terms. */
export function settingsFromFile(doc) {
    const out = {};
    for (const [fileKey, name] of Object.entries(SETTINGS_FROM_FILE)) {
        if (!doc || !Object.hasOwn(doc, fileKey)) continue;
        const v = doc[fileKey];
        out[name] = name === 'loreFormat' && typeof v === 'string' ? v.split(FILE_LORE_SLOT).join(LORE_SLOT) : v;
    }
    return storablePromptSettings(out);
}

// ST identifier -> our marker. Everything not here becomes a TEXT block carrying its
// own content, which is how custom user prompts survive the trip.
const ST_MARKER_MAP = {
    charDescription: 'charDescription',
    charPersonality: 'charPersonality',
    scenario: 'scenario',
    personaDescription: 'personaDescription',
    dialogueExamples: 'dialogueExamples',
    chatHistory: 'chatHistory',
    worldInfoBefore: 'worldInfoBefore',
    worldInfoAfter: 'worldInfoAfter',
};

// the markers SillyTavern lets a preset place in the chat at a depth
const IN_CHAT_MARKERS = new Set(['charDescription', 'charPersonality', 'scenario', 'personaDescription', 'worldInfoBefore', 'worldInfoAfter']);
// the same six in the order SillyTavern adds the ones a preset leaves out
const ST_APPENDED_MARKERS = ['worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'personaDescription'];

// recognised so the report can say they were dropped on purpose (they're the connection's), not unknown
const ST_SAMPLER_KEYS = new Set([
    'temperature', 'top_p', 'top_k', 'top_a', 'min_p', 'typical_p', 'repetition_penalty',
    'openai_max_tokens', 'openai_max_context', 'presence_penalty', 'frequency_penalty', 'seed',
]);

// Connection identity: recognised specifically so it can be reported as INTENTIONALLY
// dropped rather than lumped in with "unrecognised".
const ST_CONNECTION_KEYS = new Set([
    'chat_completion_source', 'custom_url', 'custom_include_body', 'custom_exclude_body',
    'custom_include_headers', 'reverse_proxy', 'proxy_password', 'bypass_status_check',
    'show_external_models', 'api_url_scale',
]);
const isConnectionKey = k => ST_CONNECTION_KEYS.has(k) || /_model$/.test(k) || /_sort_models$/.test(k) || /_group_models$/.test(k);

/**
 * Plan an ST chat-completion preset import, pure: prompt structure only, samplers and connection keys dropped and named in the report.
 * @returns {{name, blocks, regexScripts: object[], settings: object, report: {droppedConnection: string[], droppedSamplers: string[], droppedUnknown: string[], unknownBlocks: string[], notes: string[], regexScripts: {count: number, enabled: number}}}}
 */
export function planStPresetImport(doc, fallbackName = 'Imported preset') {
    const report = { droppedConnection: [], droppedSamplers: [], droppedUnknown: [], unknownBlocks: [], notes: [], regexScripts: null };

    // a preset's regex scripts ride its extensions; any other key there has no equivalent here
    let regexScripts = [];
    for (const [key, value] of Object.entries(doc || {})) {
        if (key === 'prompts' || key === 'prompt_order' || Object.hasOwn(SETTINGS_FROM_FILE, key)) continue;
        if (isConnectionKey(key)) { report.droppedConnection.push(key); continue; }
        if (ST_SAMPLER_KEYS.has(key)) { report.droppedSamplers.push(key); continue; }
        if (key === 'extensions' && value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [k, v] of Object.entries(value)) {
                if (k === 'regex_scripts' && Array.isArray(v)) regexScripts = v.filter(s => s && typeof s === 'object' && !Array.isArray(s));
                else report.droppedUnknown.push(`extensions.${k}`);
            }
            continue;
        }
        report.droppedUnknown.push(key);
    }
    report.regexScripts = { count: regexScripts.length, enabled: regexScripts.filter(s => !s.disabled).length };
    if (report.droppedSamplers.length) {
        report.notes.push(`${report.droppedSamplers.length} sampler setting(s) were not imported: `
            + 'temperature and its neighbours belong to the connection, so this preset changes the prompt only');
    }

    const prompts = Array.isArray(doc?.prompts) ? doc.prompts : [];
    const byIdentifier = new Map(prompts.filter(p => p?.identifier).map(p => [p.identifier, p]));

    // the global prompt_order is 100001; 100000 is vestigial and shorter (ST's own Default) so it only comes second. ids compare as strings
    const orders = Array.isArray(doc?.prompt_order) ? doc.prompt_order : [];
    const byId = id => orders.find(o => String(o?.character_id) === id);
    const chosen = byId('100001') || byId('100000') || orders[0] || null;
    const order = Array.isArray(chosen?.order) && chosen.order.length
        ? chosen.order
        : prompts.filter(p => p?.identifier).map(p => ({ identifier: p.identifier, enabled: true }));
    if (!chosen) report.notes.push('no prompt_order found; imported in the order the prompts were listed');

    // a relative block after the history goes after it, as the file orders it
    const historyAt = order.findIndex(e => e?.identifier === 'chatHistory');
    const blocks = [];
    for (const [at, entry] of order.entries()) {
        const id = entry?.identifier;
        if (!id) continue;
        const prompt = byIdentifier.get(id);
        if (!prompt) { report.unknownBlocks.push(id); continue; }
        const enabled = entry.enabled !== false;
        const marker = ST_MARKER_MAP[id];

        if (marker) {
            // the six a file may place in the chat keep its depth and order there, as a text block does
            const inChat = IN_CHAT_MARKERS.has(id) && prompt.injection_position === 1;
            blocks.push({
                key: id, name: prompt.name || null, kind: 'marker', marker, content: '', role: prompt.role || 'system',
                position: inChat ? 'at_depth' : historyAt >= 0 && at > historyAt ? 'post_history' : 'pre_history',
                depth: inChat && Number.isInteger(prompt.injection_depth) ? Math.max(prompt.injection_depth, 0) : 0,
                injectionOrder: inChat && Number.isInteger(prompt.injection_order) ? prompt.injection_order : DEFAULT_INJECTION_ORDER,
                triggers: normalizeTriggers(prompt.injection_trigger), enabled,
            });
            continue;
        }

        if (prompt.marker) { report.unknownBlocks.push(id); continue; } // a marker we cannot express

        // ABSOLUTE (injection_position 1) anchors the block at injection_depth; injection_order picks which sits nearest the reply
        const absolute = prompt.injection_position === 1;
        blocks.push({
            key: id,
            name: prompt.name || null,
            kind: 'text',
            marker: null,
            content: typeof prompt.content === 'string' ? prompt.content : '',
            role: prompt.role || 'system',
            position: absolute ? 'at_depth' : (historyAt >= 0 ? at > historyAt : id === 'jailbreak') ? 'post_history' : 'pre_history',
            depth: absolute && Number.isInteger(prompt.injection_depth) ? Math.max(prompt.injection_depth, 0) : 0,
            injectionOrder: Number.isInteger(prompt.injection_order) ? prompt.injection_order : DEFAULT_INJECTION_ORDER,
            forbidOverrides: prompt.forbid_overrides === true,
            triggers: normalizeTriggers(prompt.injection_trigger),
            enabled,
        });
    }

    // SillyTavern sends a card, persona or lore marker its order never names after everything else, relative and as system
    const named = new Set(order.map(e => e?.identifier));
    const appended = blocks.length ? ST_APPENDED_MARKERS.filter(id => !named.has(id)) : [];
    for (const id of appended) {
        blocks.push({
            key: id, name: byIdentifier.get(id)?.name || id, kind: 'marker', marker: ST_MARKER_MAP[id], content: '', role: 'system',
            position: historyAt >= 0 ? 'post_history' : 'pre_history', depth: 0, injectionOrder: DEFAULT_INJECTION_ORDER, triggers: [], enabled: true,
        });
    }
    if (appended.length) report.notes.push(`the file's order leaves out ${appended.join(', ')}; added at the end, where SillyTavern sends them`);

    const name = typeof doc?.name === 'string' && doc.name.trim() ? doc.name.trim() : fallbackName;
    return { name, blocks, regexScripts, settings: settingsFromFile(doc), report };
}

// the identifiers ST gives its own text prompts that it marks as system prompts
const ST_SYSTEM_PROMPTS = new Set(['main', 'jailbreak', 'nsfw', 'enhanceDefinitions']);

/**
 * A preset as a SillyTavern preset file, blocks to prompts and settings to keys; what the file cannot hold is reported.
 * @param {{name: string, blocks: object[], settings: object}} preset as the store answers it
 * @param {object[]} [regexScripts] the preset's own scripts, in order
 * @returns {{doc: object, report: {droppedBlocks: string[], droppedSettings: string[]}}}
 */
export function exportSillyTavernPreset(preset, regexScripts = []) {
    const report = { droppedBlocks: [], droppedSettings: [] };
    const blocks = [...(preset.blocks || [])].sort((a, b) => a.pos - b.pos);
    const isHistory = (b) => b.kind === 'marker' && b.marker === 'chatHistory';
    // the file places by order: a block keeps its place, save one on the wrong side of the history, which crosses it
    const at = blocks.findIndex(isHistory);
    const ordered = at < 0 ? blocks : [
        ...blocks.slice(0, at).filter(b => b.position !== 'post_history'),
        ...blocks.slice(at + 1).filter(b => b.position === 'pre_history'),
        blocks[at],
        ...blocks.slice(0, at).filter(b => b.position === 'post_history'),
        ...blocks.slice(at + 1).filter(b => b.position !== 'pre_history'),
    ];
    const prompts = [];
    const order = [];
    const used = new Set();
    for (const b of ordered) {
        const triggers = normalizeTriggers(b.triggers);
        if (b.kind === 'marker') {
            if (!Object.hasOwn(ST_MARKER_MAP, b.marker)) { report.droppedBlocks.push(b.id); continue; }
            const identifier = b.marker;
            used.add(identifier);
            // a marker placed in the chat that the file cannot place there goes back relative, and is named
            const inChat = b.position === 'at_depth' && IN_CHAT_MARKERS.has(identifier);
            if (b.position === 'at_depth' && !inChat) report.droppedBlocks.push(b.id);
            prompts.push({
                identifier, name: b.name || identifier, system_prompt: true, marker: true, role: b.role || 'system',
                injection_position: inChat ? 1 : 0,
                injection_depth: inChat && Number.isInteger(b.depth) ? b.depth : 4,
                injection_order: Number.isInteger(b.injectionOrder) ? b.injectionOrder : DEFAULT_INJECTION_ORDER,
                ...(triggers.length ? { injection_trigger: triggers } : {}),
            });
            order.push({ identifier, enabled: !!b.enabled });
            continue;
        }
        // a text block keeps the identifier it came with; one made here takes its id, never a marker's name or one already used
        let identifier = typeof b.key === 'string' && b.key && !Object.hasOwn(ST_MARKER_MAP, b.key) ? b.key : String(b.id);
        if (used.has(identifier)) identifier = String(b.id);
        used.add(identifier);
        const absolute = b.position === 'at_depth';
        prompts.push({
            identifier,
            name: b.name || identifier,
            role: b.role || 'system',
            content: typeof b.content === 'string' ? b.content : '',
            system_prompt: ST_SYSTEM_PROMPTS.has(identifier),
            injection_position: absolute ? 1 : 0,
            injection_depth: absolute && Number.isInteger(b.depth) ? b.depth : 4,
            injection_order: Number.isInteger(b.injectionOrder) ? b.injectionOrder : DEFAULT_INJECTION_ORDER,
            forbid_overrides: !!b.forbidOverrides,
            injection_trigger: triggers,
        });
        order.push({ identifier, enabled: !!b.enabled });
    }
    const doc = { prompts, prompt_order: [{ character_id: 100001, order }] };
    // every setting under its file key, defaults included, since SillyTavern keeps its current value for a missing key; one with no key is named
    const stored = storablePromptSettings(preset.settings);
    const values = promptSettingsOf(stored);
    for (const [fileKey, name] of Object.entries(SETTINGS_FROM_FILE)) {
        doc[fileKey] = name === 'loreFormat' ? values[name].split(LORE_SLOT).join(FILE_LORE_SLOT) : values[name];
    }
    const filed = new Set(Object.values(SETTINGS_FROM_FILE));
    for (const name of Object.keys(stored)) if (!filed.has(name)) report.droppedSettings.push(name);
    if (regexScripts.length) doc.extensions = { regex_scripts: regexScripts };
    return { doc, report };
}
