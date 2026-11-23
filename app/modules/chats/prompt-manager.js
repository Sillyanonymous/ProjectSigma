// Prompt manager: the block list of the active preset, shown inside the conversation.

import CoreAPI from '../core-api.js';
import { registerFeedPatcher, movesChatPick } from '../feed.js';
import { mountChatWindow, openChatWindow, closeChatWindow, registerChatWindow } from './window.js';

const esc = (s) => CoreAPI.escapeHtml(s);

const COLLAPSE_VERSION = 1;
const FILTER_DEBOUNCE_MS = 180;
// Above this many blocks a preset reads as a wall of rows, so sections start shut.
const COLLAPSE_DEFAULT_THRESHOLD = 20;

// Mirrors MARKERS in server/llm/preset.js; a marker the server adds later falls back
// to its own key rather than rendering blank.
const MARKER_LABELS = {
    charDescription: 'Character description',
    charPersonality: 'Character personality',
    scenario: 'Scenario',
    personaDescription: 'Persona description',
    worldInfoBefore: 'Lore (before character)',
    worldInfoAfter: 'Lore (after character)',
    dialogueExamples: 'Dialogue examples',
    chatHistory: 'Chat history',
    characterPicture: "Character's picture",
};

const ROLE_GLYPH = { user: 'fa-user', assistant: 'fa-robot' };

// what each marker expands to at send: a marker has no body, so it says what it becomes
const MARKER_HELP = {
    charDescription: "Filled with the character's description field.",
    charPersonality: "Filled with the character's personality field.",
    scenario: "Filled with the character's scenario field.",
    personaDescription: 'Filled with your active persona.',
    worldInfoBefore: 'Filled with lore placed before the character block.',
    worldInfoAfter: 'Filled with lore placed after the character block.',
    dialogueExamples: "Filled with the card's example dialogue.",
    chatHistory: 'Filled with the conversation so far.',
    characterPicture: "Shows the model the character's avatar, as a picture in your turn; left out when the connection is not known to see pictures.",
};

const ROLE_OPTIONS = ['system', 'user', 'assistant'];
const POSITION_OPTIONS = ['pre_history', 'post_history', 'at_depth'];
// the generation types a block can be held to, as SillyTavern names them; its quiet one this app never makes
const FIRE_OPTIONS = [
    { key: 'normal', label: 'Normal reply' },
    { key: 'continue', label: 'Continue' },
    { key: 'impersonate', label: 'Impersonate' },
    { key: 'swipe', label: 'Swipe' },
    { key: 'regenerate', label: 'Regenerate' },
];

// ========================================
// STATE
// ========================================

let panelInjected = false;
let panelOpen = false;

let _presets = [];           // every preset by name, for the picker: rows without blocks
let _chatId = null;          // the conversation's chat, followed off cl-chat-changed
let _resolved = null;        // { presetId, source, override, defaultId } for that chat as the server answers it
let _activeId = null;        // the preset in force in this chat: its own, else the default
let _preset = null;          // that preset whole, read with the resolve; null when the built-in defaults run
let _defaultBlocks = [];     // the built-in fallback, shown read-only when _preset is null
let _loadError = null;       // an unknown list is never rendered as an empty one
let _filterTerms = [];
let _dragEnabled = true;

let savingPreset = false;
let pendingParts = new Set(); // what the next save sends beside a Save's settings: 'blocks'
let pendingSettings = null;   // a Save's settings until the server takes them, kept off _preset so it holds only what the server stored
let saveSeq = 0; // counts saves begun, so a read can tell one started while it was out
let presetSaveQueued = false;
let _staleFromFeed = false;  // a write elsewhere the open panel has yet to read

let _editingId = null;       // the block open in the drawer, or null
let _draft = null;           // that block as the editor holds it between redraws, unsaved; null until a redraw needs one
let _settingsOpen = false;   // the preset's settings hold the drawer
let _refusedSettings = null; // { id, values }: a Save the server refused, shown again as typed until the settings close
let _defaultSettings = {};   // every setting's default, as the server sends it (never mirrored here)

// ========================================
// STORE I/O (collapse state)
// ========================================

function coerceCollapse(doc) {
    const collapsed = doc && doc.version && doc.collapsed && typeof doc.collapsed === 'object'
        ? doc.collapsed
        : {};
    return { version: COLLAPSE_VERSION, collapsed: collapsed };
}

// { version, collapsed: { [blockId]: boolean } }. Written elsewhere: the open panel reads again
// the way it does for a preset written elsewhere.
const collapseDoc = CoreAPI.createStoreDocument('chat-prompt-collapse', {
    coerce: coerceCollapse,
    onDrop: () => patchPresetsFromFeed(),
    unread: 'The section state could not be read from the server; nothing was changed',
    saveFailed: 'Failed to save the section state',
});

function loadCollapse() {
    return collapseDoc.load();
}

// ========================================
// PRESET I/O
// ========================================

// adopts the server's answer unless outrun says a save went out meanwhile; answers whether it adopted
async function loadPresets(outrun = () => false) {
    const [resp, resResp] = await Promise.all([
        CoreAPI.apiRequest('/presets', 'GET'),
        // the one preset this chat uses comes with the answer naming it; the list is names alone
        CoreAPI.apiRequest(`/presets/resolve?with=preset${_chatId ? `&chatId=${encodeURIComponent(_chatId)}` : ''}`, 'GET'),
    ]);
    if (!resp.ok) throw new Error(`preset list failed (${resp.status})`);
    // an unread answer is never guessed: editing the wrong preset is worse than showing none
    if (!resResp.ok) throw new Error(`which preset answers this chat could not be read (${resResp.status})`);
    const data = await resp.json();
    const { preset = null, ...resolved } = await resResp.json();
    // named but not sent is unread too: the built-in blocks are never shown in a preset's place
    if (typeof resolved.presetId === 'string' && !(preset?.id === resolved.presetId && Array.isArray(preset.blocks))) throw new Error('the preset this chat uses could not be read');
    if (outrun()) return false;
    _resolved = resolved;
    _presets = Array.isArray(data?.presets) ? data.presets : [];
    _activeId = typeof _resolved?.presetId === 'string' ? _resolved.presetId : null;
    _preset = _activeId ? preset : null;
    // a failed save's parts were the old copy's; the server's copy owes nothing
    pendingParts = new Set();
    pendingSettings = null;
    // what runs with nothing selected, held to SHOW it; never edited, so never merged into _preset
    _defaultBlocks = Array.isArray(data?.defaultBlocks) ? data.defaultBlocks : [];
    _defaultSettings = data?.defaultSettings && typeof data.defaultSettings === 'object' ? data.defaultSettings : {};
    return true;
}

// Block ids are sent back so the server reuses them; a fresh uuid per save would
// orphan every collapse entry keyed on the divider block.
function toWire(b) {
    const kind = b.kind === 'marker' ? 'marker' : 'text';
    return {
        id: b.id,
        key: b.key ?? null,
        name: b.name ?? null,
        kind: kind,
        marker: kind === 'marker' ? b.marker : null,
        content: typeof b.content === 'string' ? b.content : '',
        role: b.role || 'system',
        position: b.position || 'pre_history',
        depth: Number.isInteger(b.depth) ? b.depth : 0,
        // both ride every save: the list is written wholesale, so a field left out here resets on the next save
        injectionOrder: Number.isInteger(b.injectionOrder) ? b.injectionOrder : 100,
        forbidOverrides: !!b.forbidOverrides,
        triggers: Array.isArray(b.triggers) ? b.triggers.filter(t => typeof t === 'string') : [],
        enabled: !!b.enabled,
    };
}

// each save sends only the parts it changed, so a held view never writes back what another tab changed meanwhile
async function savePreset(parts = ['blocks']) {
    if (!_preset) return;
    for (const part of parts) pendingParts.add(part);
    if (savingPreset) {
        presetSaveQueued = true;
        return;
    }
    savingPreset = true;
    saveSeq++;
    const id = _preset.id;
    const send = pendingParts;
    const settings = pendingSettings;
    pendingParts = new Set();
    let retry = false;
    try {
        const resp = await CoreAPI.apiRequest(`/presets/${encodeURIComponent(id)}`, 'PATCH', {
            ...(send.has('blocks') ? { blocks: (_preset.blocks || []).map(toWire) } : {}),
            ...(settings ? { settings } : {}),
        });
        const saved = await CoreAPI.readAnswer(resp);
        if (settings) {
            if (pendingSettings === settings) pendingSettings = null;
            // a newer Save waits in pendingSettings, so the stored settings are taken even when a queued save holds the blocks
            if (_preset?.id === id && saved?.settings) _preset.settings = saved.settings;
        }
        // A queued save means local state is already ahead of this response.
        if (!presetSaveQueued && saved?.id === id && Array.isArray(saved.blocks)) {
            // the list's row follows the write it describes
            const row = _presets.find(p => p.id === id);
            if (row) Object.assign(row, { name: saved.name, updatedAt: saved.updatedAt, blockCount: saved.blocks.length });
            // the reader may have switched presets meanwhile; repainting the panel as this one made screen and server disagree
            if (_preset?.id === id) {
                // a client-minted block comes back under a fresh uuid, so the open drawer follows it by position
                if (_editingId && !saved.blocks.some(b => b.id === _editingId)) {
                    const at = (_preset.blocks || []).findIndex(b => b.id === _editingId);
                    if (at !== -1 && saved.blocks[at]) {
                        if (_draft?.id === _editingId) _draft.id = saved.blocks[at].id;
                        _editingId = saved.blocks[at].id;
                    }
                }
                _preset = saved;
                renderAll();
            }
        }
    } catch (e) {
        console.error('[PromptManager] Save failed:', e.message);
        CoreAPI.showToast(`Could not save the prompt preset: ${e.message}`, 'error');
        if (_preset?.id === id) for (const part of send) pendingParts.add(part);
        // refused settings never ride another save: the form opens on them again, and the blocks sent beside them go now
        if (e.status === 400 && settings && pendingSettings === settings) {
            pendingSettings = null;
            if (_preset?.id === id) {
                retry = send.size > 0;
                reopenRefusedSettings(id, settings);
            }
        }
    } finally {
        savingPreset = false;
        if (presetSaveQueued || retry) {
            presetSaveQueued = false;
            savePreset([]);
        } else if (_staleFromFeed) {
            patchPresetsFromFeed();
        }
    }
}

// ========================================
// THE FEED
// ========================================

// a preset written elsewhere, another made the default (a setting naming activePresetId) or this chat's own picked: re-read unless a save or drawer holds it
function patchPresetsFromFeed(records) {
    const moves = (r) => movesChatPick(r, { entity: 'preset', setting: 'activePresetId', chatId: _chatId, chatField: 'presetId' });
    if (records && !records.some(moves)) return;
    if (!panelOpen) return;
    if (savingPreset || presetSaveQueued || _editingId || _settingsOpen) { _staleFromFeed = true; return; }
    return refreshPanel();
}

// What the panel shows: the preset list, the active one and the collapse map, read together.
async function refreshPanel() {
    _staleFromFeed = false;
    // a save out at any point of this read answers newer than it: the read is dropped and made again after the save
    const seq = saveSeq;
    const busy = savingPreset;
    let adopted = true;
    try {
        [adopted] = await Promise.all([loadPresets(() => busy || seq !== saveSeq), loadCollapse()]);
        _loadError = null;
    } catch (e) {
        _loadError = e.message;
        console.error('[PromptManager] Load failed:', e.message);
    }
    if (!adopted) {
        if (savingPreset || presetSaveQueued) { _staleFromFeed = true; return; }
        return refreshPanel();
    }
    renderAll();
}

// ========================================
// PRESET ACTIONS
// ========================================

// each puts its result in force as this chat's own, as the picker does; the panel shows only the one in force
async function createAndActivate(body, { toast }) {
    let created;
    try {
        created = await CoreAPI.readAnswer(await CoreAPI.apiRequest('/presets', 'POST', body));
    } catch (e) {
        console.error('[PromptManager] Create failed:', e.message);
        CoreAPI.showToast(`Could not create the preset: ${e.message}`, 'error');
        return;
    }
    // it exists whatever the pick answers: a refused pick says why, and the list still shows it
    const set = await applyPreset(created.id);
    if (set && toast) CoreAPI.showToast(toast, 'success');
    return { created, set };
}

async function newPreset() {
    const name = await CoreAPI.showConfirm({
        title: 'New preset',
        message: 'It starts from the built-in blocks, which you can then edit.',
        confirmLabel: 'Create',
        input: { placeholder: 'Preset name' },
    });
    if (typeof name !== 'string') return;
    await createAndActivate({ name }, { toast: 'Preset created' });
}

async function duplicatePreset() {
    if (!_preset) {
        CoreAPI.showToast('The built-in defaults are already the starting point for a new preset', 'info');
        return;
    }
    const name = await CoreAPI.showConfirm({
        title: 'Duplicate preset',
        message: `Copies every block and setting of "${_preset.name || 'this preset'}".`,
        confirmLabel: 'Duplicate',
        input: { value: `${_preset.name || 'Preset'} copy`, placeholder: 'Preset name' },
    });
    if (typeof name !== 'string') return;
    // ids stripped: writeBlocks only reuses an id it knows for THAT preset
    const blocks = (_preset.blocks || []).map(b => ({ ...toWire(b), id: undefined }));
    // its regex scripts come along, off until the copy is allowed as any new preset's are
    const regexScripts = await presetRegexScripts(_preset, 'the copy');
    const n = regexScripts.length;
    // an imported preset's SillyTavern settings come along, so the copy assembles as the original does
    const made = await createAndActivate({ name, blocks, settings: _preset.settings || {}, ...(n ? { regexScripts } : {}) }, { toast: n ? null : 'Preset duplicated' });
    if (made && n) CoreAPI.showToast(`Preset duplicated, with its ${n} regex script${n === 1 ? '' : 's'}, off until you allow them in Regex Scripts`, 'success');
}

async function renamePreset() {
    if (!_preset) {
        CoreAPI.showToast('The built-in defaults cannot be renamed', 'info');
        return;
    }
    const name = await CoreAPI.showConfirm({
        title: 'Rename preset',
        confirmLabel: 'Rename',
        input: { value: _preset.name || '', placeholder: 'Preset name' },
    });
    if (typeof name !== 'string' || name === _preset.name) return;
    try {
        await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/presets/${encodeURIComponent(_preset.id)}`, 'PATCH', { name }));
    } catch (e) {
        console.error('[PromptManager] Rename failed:', e.message);
        CoreAPI.showToast(`Could not rename the preset: ${e.message}`, 'error');
    }
    // a rename taken and a read that failed after it is no failed rename: the panel says what it could not read
    await refreshPanel();
}

async function deletePreset() {
    if (!_preset) {
        CoreAPI.showToast('The built-in defaults cannot be deleted', 'info');
        return;
    }
    const ok = await CoreAPI.showConfirm({
        title: 'Delete this preset?',
        message: `"${_preset.name || 'This preset'}" and its blocks are removed. A chat that picked it as its own follows the default again; as the default, the built-in blocks take its place.`,
        confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try {
        const resp = await CoreAPI.apiRequest(`/presets/${encodeURIComponent(_preset.id)}`, 'DELETE');
        if (!resp.ok) throw new Error(`(${resp.status})`);
        _editingId = null;
        // the server hands its chats back to the default and clears the default if it was one; the answer is read again, never set
        await refreshPanel();
        window.chatsModule?.syncConversationPreset?.();
        renderDrawer();
        CoreAPI.showToast('Preset deleted', 'success');
    } catch (e) {
        console.error('[PromptManager] Delete failed:', e.message);
        CoreAPI.showToast('Could not delete the preset', 'error');
    }
}

/** One Import for two shapes: our own `blocks` document is created directly, anything else goes to the ST importer. */
async function importPresetFile(file) {
    if (!file) return;
    let doc = null;
    try {
        doc = JSON.parse(await file.text());
    } catch {
        CoreAPI.showToast('That file is not valid JSON', 'error');
        return;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        CoreAPI.showToast('That file does not look like a preset', 'error');
        return;
    }
    const named = String(doc.name || file.name.replace(/\.json$/i, '') || 'Imported preset').trim();

    if (Array.isArray(doc.blocks) && doc.blocks.length) {
        const blocks = doc.blocks.map(b => ({ ...toWire(b), id: undefined }));
        // sent as the file holds them: the server refuses a script out of shape by its place in the file
        const regexScripts = Array.isArray(doc.regexScripts) ? doc.regexScripts : [];
        const written = doc.settings && typeof doc.settings === 'object' && !Array.isArray(doc.settings) ? doc.settings : {};
        // a setting the server lists no default for (a file from another version) stays out and is named; a known one goes as written
        const known = Object.keys(_defaultSettings);
        const unknown = known.length ? Object.keys(written).filter(key => !known.includes(key)) : [];
        const settings = Object.fromEntries(Object.entries(written).filter(([key]) => !unknown.includes(key)));
        const reported = regexScripts.length || unknown.length;
        const made = await createAndActivate({ name: named, blocks, settings, ...(regexScripts.length ? { regexScripts } : {}) }, { toast: reported ? null : 'Preset imported' });
        if (made && reported) {
            await showImportReport(made.created, {
                ...(unknown.length ? { droppedUnknown: unknown } : {}),
                ...(regexScripts.length ? { regexScripts: { count: regexScripts.length, enabled: regexScripts.filter(s => !s.disabled).length } } : {}),
            }, made.set);
        }
        return;
    }

    try {
        const data = await CoreAPI.readAnswer(await CoreAPI.apiRequest('/presets/import', 'POST', { preset: doc, name: named }));
        const set = data?.preset?.id ? await applyPreset(data.preset.id) : false;
        await showImportReport(data?.preset, data?.report, set);
    } catch (e) {
        console.error('[PromptManager] Import failed:', e.message);
        CoreAPI.showToast(`Could not import that preset: ${e.message}`, 'error');
    }
}

/** The report is the point of an ST import: the only place the reader learns the endpoint half was not kept. */
async function showImportReport(preset, report, set) {
    const name = preset?.name || 'the preset';
    const blocks = [];
    // a 'list' block renders items only, so the heading is its own 'text' block; the renderer escapes both
    const add = (title, items) => {
        if (!items || !items.length) return;
        blocks.push({ type: 'text', text: title });
        blocks.push({ type: 'list', items });
    };
    add('Endpoint settings not kept (your AI profile owns those):', report?.droppedConnection);
    add('Sampler settings not kept (your AI profile owns those too):', report?.droppedSamplers);
    add('Settings with no equivalent here:', report?.droppedUnknown);
    add('Prompt sections that could not be mapped:', report?.unknownBlocks);
    add('Notes:', report?.notes);
    const lost = blocks.length;
    // its regex scripts stay off until allowed; the report offers that, never assumes it
    const scripts = report?.regexScripts;
    let allowing = false;
    if (scripts?.count && preset?.id) {
        const n = scripts.count;
        blocks.push({ type: 'text', text: `It carries ${n} regex script${n === 1 ? '' : 's'}, ${scripts.enabled} switched on. They stay off until you allow them; Regex Scripts in the chat lists them.` });
        blocks.push({ type: 'switch', key: 'regex', text: `Allow its ${n} regex script${n === 1 ? '' : 's'}`, onChange: (on) => { allowing = on; } });
    }

    if (!blocks.length) {
        if (set) CoreAPI.showToast(`Imported "${name}"`, 'success');
        return;
    }
    await CoreAPI.showConfirm({
        title: `Imported "${name}"`,
        message: [set ? "It now builds this chat's prompt." : '', lost ? 'These parts did not come across:' : ''].filter(Boolean).join(' '),
        content: blocks,
        icon: 'fa-solid fa-circle-check',
        confirmLabel: 'Got it',
        cancelLabel: 'Close',
    });
    if (allowing) await allowPresetScripts(preset);
}

// the import report's switch: this preset's regex scripts allowed, as the Regex window's Allow does
async function allowPresetScripts(preset) {
    try {
        await CoreAPI.readAnswer(await CoreAPI.apiRequest('/regex/consent', 'PUT', { presetId: preset.id, answer: 'allowed' }));
    } catch (e) {
        CoreAPI.showToast(`The preset's scripts could not be allowed: ${e.message}`, 'error');
    }
}

// a preset's regex scripts as its file holds them; a failed read says so and the copy or file goes without them
async function presetRegexScripts(preset, what) {
    try {
        const scripts = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/regex/export?presetId=${encodeURIComponent(preset.id)}`, 'GET'));
        return Array.isArray(scripts) ? scripts : [];
    } catch (e) {
        CoreAPI.showToast(`The preset's regex scripts could not be read, so ${what} leaves them out: ${e.message}`, 'warning');
        return [];
    }
}

// exports what this app stores so Import round-trips exactly, its regex scripts too; deliberately not ST's shape
async function exportPreset() {
    if (!_preset) {
        CoreAPI.showToast('The built-in defaults are not a file', 'info');
        return;
    }
    const regexScripts = await presetRegexScripts(_preset, 'the file');
    const doc = {
        name: _preset.name || 'Preset',
        blocks: (_preset.blocks || []).map(b => {
            const w = toWire(b);
            delete w.id;
            return w;
        }),
        ...(regexScripts.length ? { regexScripts } : {}),
        ...(_preset.settings && Object.keys(_preset.settings).length ? { settings: _preset.settings } : {}),
    };
    CoreAPI.downloadBlobAsFile(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), `${doc.name || 'preset'}.json`);
}

// the preset as a SillyTavern preset file, built by the server; what the file has no place for is named
async function exportStPreset() {
    if (!_preset) return;
    let data;
    try {
        data = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/presets/${encodeURIComponent(_preset.id)}/export?format=sillytavern`, 'GET'));
    } catch (e) {
        CoreAPI.showToast(`Could not export the preset: ${e.message}`, 'error');
        return;
    }
    CoreAPI.downloadBlobAsFile(new Blob([JSON.stringify(data.doc, null, 2)], { type: 'application/json' }), `${_preset.name || 'preset'}.json`);
    const labelOf = (key) => SETTING_GROUPS.flatMap(g => g.fields).find(x => x.key === key)?.label || key;
    const blockOf = (id) => { const b = (_preset.blocks || []).find(x => x.id === id); return b ? displayName(b) : id; };
    const left = data.report || {};
    const dropped = [...(left.droppedBlocks || []).map(blockOf), ...(left.droppedSettings || []).map(labelOf)];
    if (dropped.length) CoreAPI.showToast(`Exported. SillyTavern has no place for: ${dropped.join(', ')}`, 'info');
}

// the picker: this chat's own preset, or ('') the default again; the default moves only through setDefaultPreset
async function applyPreset(id) {
    if (!_chatId) { CoreAPI.showToast('Open a chat first', 'info'); return false; }
    return writeChoice(() => CoreAPI.apiRequest(`/chats/${encodeURIComponent(_chatId)}`, 'PATCH', { presetId: id || null }),
        id ? 'Could not set the preset for this chat' : 'Could not return this chat to the default preset');
}

// the banner's Make Default and Clear Default: every chat without its own; this chat keeps what it holds
async function setDefaultPreset(id) {
    return writeChoice(() => CoreAPI.apiRequest('/presets/active', 'PUT', { id: id || null }),
        id ? 'Could not make this preset the default' : 'Could not clear the default preset');
}

// every choice re-reads the server's answer, refused or not: the default and the chat's own interact, so it is never guessed
async function writeChoice(write, failed) {
    let ok = true;
    try {
        await CoreAPI.readAnswer(await write());
    } catch (e) {
        ok = false;
        console.error('[PromptManager] Preset choice failed:', e.message);
        CoreAPI.showToast(`${failed}: ${e.message}`, 'error');
    }
    // a read that fails after a write taken is the panel's unknown state, never a failed write
    await refreshPanel();
    window.chatsModule?.syncConversationPreset?.();
    return ok;
}

// ========================================
// GROUPING
// ========================================

// two INDEPENDENT prefixes: a sub-group is '<Name', never '<===Name'
const GROUP_MARKER = '===';
const SUB_MARKER = '<';

function stripRuns(text, ch) {
    let a = 0;
    let b = text.length;
    while (a < b && text[a] === ch) a++;
    while (b > a && text[b - 1] === ch) b--;
    return text.slice(a, b);
}

function markerLabel(rawName, prefix) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!prefix || !name.startsWith(prefix)) return null;
    const fill = prefix[prefix.length - 1];
    return stripRuns(name.slice(prefix.length).trim(), fill).trim();
}

// Group is tested first, so a name opening with the group marker can never be read as a
// sub-group even when the two prefixes overlap.
function parseDivider(rawName) {
    const g = markerLabel(rawName, GROUP_MARKER);
    if (g !== null) return { level: 0, label: g || 'Group' };
    const sub = markerLabel(rawName, SUB_MARKER);
    if (sub !== null) return { level: 1, label: sub || 'Sub-group' };
    return null;
}

// the write side of parseDivider: users type the label, the glyphs are minted here so a prefix never half-matches
function dividerName(level, label) {
    const clean = String(label || '').trim();
    return level === 0 ? `=== ${clean || 'Group'} ===` : `< ${clean || 'Sub-group'}`;
}

/**
 * Flatten the block list into render items; two heading levels, never more.
 * @returns {Array} items with { type, id, block, level, parents, members, label }
 */
function buildModel(blocks) {
    const items = [];
    let top = null;
    let sub = null;
    for (const b of blocks) {
        const div = parseDivider(b.name);
        if (div && div.level === 0) {
            sub = null;
            top = { type: 'head', id: b.id, block: b, level: 0, parents: [], members: [], subs: [], label: div.label };
            items.push(top);
            continue;
        }
        // A sub-divider only opens a section INSIDE a group. Loose ones stay ordinary
        // rows rather than silently becoming top-level sections.
        if (div && div.level === 1 && top) {
            sub = { type: 'head', id: b.id, block: b, level: 1, parents: [top.id], members: [], subs: [], label: div.label };
            top.subs.push(sub);
            items.push(sub);
            continue;
        }
        const parents = [];
        if (top) parents.push(top.id);
        if (sub) parents.push(sub.id);
        // A block belongs to its NEAREST container only; the group's badge adds its
        // sub-sections back in when it counts.
        if (sub) sub.members.push(b);
        else if (top) top.members.push(b);
        // A loose sub-divider is rendered as a FLAGGED row (never promoted, never raw
        // marker text): visible enough to drag back under a group.
        const stray = !!(div && div.level === 1 && !top);
        items.push({ type: 'row', id: b.id, block: b, level: parents.length, parents: parents, members: [], subs: [], label: stray ? div.label : '', stray });
    }
    return items;
}

// A dragged heading carries its whole section; leaving the members behind would
// silently re-parent them into the section above.
function runFor(blocks, id) {
    const i = blocks.findIndex(b => b.id === id);
    if (i === -1) return null;
    const div = parseDivider(blocks[i].name);
    if (!div) return [i, i + 1];
    let j = i + 1;
    while (j < blocks.length) {
        const d = parseDivider(blocks[j].name);
        if (d && d.level <= div.level) break;
        j++;
    }
    return [i, j];
}

function isCollapsed(id, blockCount) {
    const stored = collapseDoc.get()?.collapsed?.[id];
    if (typeof stored === 'boolean') return stored;
    return blockCount > COLLAPSE_DEFAULT_THRESHOLD;
}

// ========================================
// TOKENS, NAMES, MATCHING
// ========================================

// Same chars-over-four heuristic the library and the server budget already use, so the
// figures cannot disagree with each other.
function estTokens(text) {
    return Math.round(String(text || '').length / 4);
}

// a block with no real name (ST's uuid identifier) is labelled from its own first line instead
const looksLikeId = (s) => /^[0-9a-f]{6,}(?:[\s-][0-9a-f]{2,}){2,}$/i.test(String(s || '').trim());

function labelFromContent(b) {
    const first = String(b.content || '')
        .split(/\r?\n/)
        .map(l => l.replace(/^[\s>#*_-]+/, '').trim())
        .find(Boolean);
    if (!first) return null;
    return first.length > 48 ? `${first.slice(0, 48).trimEnd()}...` : first;
}

function displayName(b) {
    const named = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : null;
    if (named && !looksLikeId(named)) return named;
    if (b.kind === 'marker' && MARKER_LABELS[b.marker]) return MARKER_LABELS[b.marker];
    const derived = labelFromContent(b);
    if (derived) return derived;
    if (named) return named;
    if (typeof b.key === 'string' && b.key.trim()) return b.key.trim();
    return b.marker || 'Untitled block';
}

function blockText(b) {
    return `${b.name || ''} ${b.marker || ''} ${b.key || ''} ${b.content || ''}`.toLowerCase();
}

function matchesTerms(text, terms) {
    return terms.every(t => text.includes(t));
}

function computeMatches(items, terms) {
    const keep = new Set();
    const headMatched = new Set();
    for (const it of items) {
        if (it.type !== 'head') continue;
        if (matchesTerms(blockText(it.block), terms)) {
            headMatched.add(it.id);
            keep.add(it.id);
        }
    }
    for (const it of items) {
        if (it.type !== 'row') continue;
        const inheritsMatch = it.parents.some(p => headMatched.has(p));
        if (!inheritsMatch && !matchesTerms(blockText(it.block), terms)) continue;
        keep.add(it.id);
        for (const p of it.parents) keep.add(p);
    }
    return keep;
}

// ========================================
// MARKUP
// ========================================

function buildPanelHTML() {
    return `
    <div id="chatPromptPanel" class="cl-cwin cpm-panel" aria-hidden="true">
        <aside class="cl-cwin-sheet cpm-sheet" role="dialog" aria-label="Prompt manager">
            ${CoreAPI.windowGripsHtml('the prompt manager')}
            <div class="cl-cwin-header">
                <div class="cl-cwin-title">
                    <i class="fa-solid fa-sliders"></i>
                    <span class="cl-cwin-name">Prompt manager</span>
                </div>
                <button type="button" class="cl-cwin-btn is-close" id="cpmClose" title="Close" aria-label="Close prompt manager">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div class="cpm-subhead cl-cwin-fieldrow">
                <select class="cl-select-fluid cpm-preset-select" id="cpmPresetSelect" title="Which preset builds this chat's prompt"></select>
                <span class="cpm-tokens" id="cpmTokens" title="What this preset's own written blocks add to every prompt. Markers are filled at build time; the full assembled size lives in the prompt inspector.">+0 tok</span>
                <button type="button" class="cl-cwin-btn-text cpm-more" id="cpmPresetMore" aria-haspopup="true" aria-label="Preset actions"><i class="fa-solid fa-ellipsis"></i></button>
            </div>
            <div class="cpm-inforce" id="cpmInForce"></div>
            <div class="cpm-warn" id="cpmWarn" hidden>
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span>Chat history is off, so every reply is written without the conversation so far.</span>
            </div>
            <input type="file" id="cpmImportFile" accept="application/json,.json" class="cl-hidden">
            <div class="cl-cwin-filterbar">
                <i class="fa-solid fa-magnifying-glass cl-cwin-filter-icon"></i>
                <input type="search" id="cpmFilter" class="cl-cwin-filter" placeholder="Filter blocks and contents"
                    autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
            </div>
            <div class="cpm-drawer" id="cpmDrawer" hidden></div>
            <div class="cpm-list" id="cpmList"></div>
            <div class="cpm-footer">
                <button type="button" class="cl-cwin-btn-text" data-block-act="add-text"><i class="fa-solid fa-plus"></i> Text Block</button>
                <button type="button" class="cl-cwin-btn-text" data-block-act="add-marker"><i class="fa-solid fa-cube"></i> Marker</button>
                <button type="button" class="cl-cwin-btn-text" data-block-act="add-group"><i class="fa-solid fa-layer-group"></i> Group</button>
                <button type="button" class="cl-cwin-btn-text" data-block-act="add-subgroup"><i class="fa-solid fa-diagram-successor"></i> Sub-group</button>
            </div>
        </aside>
    </div>`;
}

// a new block arrives DISABLED: an empty section entering every prompt from creation is a bad surprise
function newTextBlock(name) {
    return {
        id: `new-${Date.now()}-${Math.round(performance.now() * 1000)}`,
        key: null, name: name || 'New block', kind: 'text', marker: null,
        content: '', role: 'system', position: 'pre_history', depth: 0, enabled: false,
    };
}

function newMarkerBlock(marker) {
    return { ...newTextBlock(MARKER_LABELS[marker] || marker), kind: 'marker', marker };
}

function headHTML(it, filtering, blockCount) {
    const collapsed = !filtering && isCollapsed(it.id, blockCount);
    // A group reports its own rows PLUS everything in its sub-sections, so the badge
    // answers "how much of this section is on" without expanding anything.
    const all = it.members.concat(...(it.subs || []).map(x => x.members));
    const total = all.length;
    const on = all.filter(b => b.enabled).length;
    return `<div class="cpm-head cpm-l${it.level}${collapsed ? ' cpm-collapsed' : ''}" data-id="${esc(it.id)}" draggable="${_dragEnabled}">
        <span class="cpm-grip" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
        <button type="button" class="cpm-caret" aria-expanded="${collapsed ? 'false' : 'true'}" title="${collapsed ? 'Expand section' : 'Collapse section'}">
            <i class="fa-solid fa-chevron-down"></i>
        </button>
        <span class="cpm-head-name">${esc(it.label || 'Section')}</span>
        <span class="cpm-acts">
            <button type="button" class="cpm-act cl-cwin-act" data-block-act="edit" data-id="${esc(it.id)}" title="Rename this ${it.level ? 'sub-group' : 'group'}" aria-label="Rename"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="cpm-act cl-cwin-act cpm-act-danger" data-block-act="delete" data-id="${esc(it.id)}" title="Delete the heading; its blocks stay and join the section above" aria-label="Delete heading"><i class="fa-solid fa-trash"></i></button>
        </span>
        <button type="button" class="cpm-act cl-cwin-act cpm-kebab" data-block-act="acts" data-id="${esc(it.id)}" title="Actions" aria-label="Actions"><i class="fa-solid fa-ellipsis-vertical"></i></button>
        <span class="cpm-badge" title="Enabled blocks in this section">${on}/${total}</span>
    </div>`;
}

// the ticks a block's editor shows: the five the app makes, then any other its list holds (ST's quiet, a newer type)
function fireOptionsFor(b) {
    const offered = new Set(FIRE_OPTIONS.map(o => o.key));
    return [...FIRE_OPTIONS, ...(b.triggers || []).filter(t => !offered.has(t)).map(t => ({ key: t, label: `${t.charAt(0).toUpperCase()}${t.slice(1)} (never made here)` }))];
}

// whether a normal reply sends the block, as the build reads its list
function firesOnNormal(b) {
    return !(b.triggers || []).length || b.triggers.includes('normal');
}

// a block sent on some generation types only says so on its row, or a disabled-looking absence would puzzle
function firesBadge(b) {
    const only = FIRE_OPTIONS.filter(o => (b.triggers || []).includes(o.key)).map(o => o.label);
    if (!(b.triggers || []).length) return '';
    const words = only.length ? `Sent only on: ${only.join(', ')}` : 'Sent on no reply this app makes';
    return `<span class="cpm-role cpm-fires" title="${esc(words)}" aria-label="${esc(words)}"><i class="fa-solid fa-filter"></i></span>`;
}

// an anchored block's whole difference is where it lands, so the depth is on the row
function depthBadge(b) {
    if (b.position !== 'at_depth') return '';
    const depth = Number.isInteger(b.depth) ? b.depth : 0;
    const where = depth === 0 ? 'after the last message' : `${depth} turn${depth === 1 ? '' : 's'} back from the newest`;
    return `<span class="cpm-depth" title="Sits inside the chat history, ${esc(where)}">@${depth}</span>`;
}

function rowHTML(it, { readOnly = false } = {}) {
    const b = it.block;
    if (it.stray) {
        return `<div class="cl-cwin-row cpm-row cpm-l${it.level} cpm-stray" data-id="${esc(b.id)}" draggable="${_dragEnabled}"
            title="A sub-group only means something inside a group: drag it under one, or delete it">
            <span class="cpm-grip" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
            <span class="cpm-glyph"><i class="fa-solid fa-layer-group"></i></span>
            <span class="cpm-name">${esc(it.label)}</span>
            <span class="cpm-stray-note">sub-group without a group</span>
            <span class="cpm-acts">
                <button type="button" class="cpm-act cl-cwin-act" data-block-act="edit" data-id="${esc(b.id)}" title="Rename this sub-group" aria-label="Rename"><i class="fa-solid fa-pen"></i></button>
                <button type="button" class="cpm-act cl-cwin-act cpm-act-danger" data-block-act="delete" data-id="${esc(b.id)}" title="Delete this heading" aria-label="Delete heading"><i class="fa-solid fa-trash"></i></button>
            </span>
            <button type="button" class="cpm-act cl-cwin-act cpm-kebab" data-block-act="acts" data-id="${esc(b.id)}" title="Actions" aria-label="Actions"><i class="fa-solid fa-ellipsis-vertical"></i></button>
        </div>`;
    }
    const isMarker = b.kind === 'marker';
    const roleGlyph = ROLE_GLYPH[b.role];
    const typeTitle = isMarker ? 'Marker: filled in when the prompt is built' : 'Written text block';
    const tokLabel = isMarker ? '-' : `~${estTokens(b.content)}`;
    const tokTitle = isMarker
        ? 'Comes from the card, persona, lore or chat, so its size is only known at send time'
        : 'Rough estimate: characters over four';
    // a read-only row keeps glyph, name, role and size and drops every control (no dead buttons)
    if (readOnly) {
        return `<div class="cl-cwin-row cpm-row cpm-l${it.level} cpm-row-readonly" data-id="${esc(b.id)}">
            <span class="cpm-glyph" title="${esc(typeTitle)}"><i class="fa-solid ${isMarker ? 'fa-cube' : 'fa-align-left'}"></i></span>
            <span class="cpm-name">${esc(displayName(b))}</span>
            ${roleGlyph ? `<span class="cpm-role" title="Sent as ${esc(b.role)}"><i class="fa-solid ${roleGlyph}"></i></span>` : ''}
            <span class="cpm-tok" title="${esc(tokTitle)}">${esc(tokLabel)}</span>
        </div>`;
    }

    return `<div class="cl-cwin-row cpm-row cpm-l${it.level}${b.enabled ? '' : ' cpm-off'}${_editingId === b.id ? ' is-active cpm-editing' : ''}" data-id="${esc(b.id)}" draggable="${_dragEnabled}">
        <span class="cpm-grip" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
        <span class="cpm-glyph" title="${esc(typeTitle)}"><i class="fa-solid ${isMarker ? 'fa-cube' : 'fa-align-left'}"></i></span>
        <span class="cpm-name">${esc(displayName(b))}</span>
        ${depthBadge(b)}
        ${firesBadge(b)}
        ${roleGlyph ? `<span class="cpm-role" title="Sent as ${esc(b.role)}"><i class="fa-solid ${roleGlyph}"></i></span>` : ''}
        <span class="cpm-tok" title="${esc(tokTitle)}">${esc(tokLabel)}</span>
        <span class="cpm-acts">
            <button type="button" class="cpm-act cl-cwin-act" data-block-act="edit" data-id="${esc(b.id)}" title="Edit this block" aria-label="Edit this block"><i class="fa-solid fa-pen"></i></button>
            <button type="button" class="cpm-act cl-cwin-act" data-block-act="duplicate" data-id="${esc(b.id)}" title="Duplicate this block" aria-label="Duplicate this block"><i class="fa-solid fa-clone"></i></button>
            <button type="button" class="cpm-act cl-cwin-act cpm-act-danger" data-block-act="delete" data-id="${esc(b.id)}" title="Delete this block" aria-label="Delete this block"><i class="fa-solid fa-trash"></i></button>
        </span>
        <button type="button" class="cpm-act cl-cwin-act cpm-kebab" data-block-act="acts" data-id="${esc(b.id)}" title="Actions" aria-label="Actions"><i class="fa-solid fa-ellipsis-vertical"></i></button>
        <label class="cpm-toggle" title="${b.enabled ? 'Disable this block' : 'Enable this block'}">
            <input type="checkbox" class="cl-switch-input cpm-toggle-input" data-id="${esc(b.id)}"${b.enabled ? ' checked' : ''} aria-label="${esc(displayName(b))} on">
            <span class="cl-switch is-sm" aria-hidden="true"></span>
        </label>
    </div>`;
}

// ========================================
// EDIT DRAWER
// ========================================

/** One block, edited under the top bar; the history marker is the boundary, so its placement isnt its own to choose. */
function drawerHTML(b) {
    // a divider edits as a SECTION: one label field, the glyphs stay in the stored name
    const div = parseDivider(b.name);
    if (div) {
        return `
        <div class="cpm-drawer-head">
            <span class="cpm-drawer-title">${div.level === 0 ? 'Group' : 'Sub-group'}</span>
            <button type="button" class="cpm-drawer-close" data-block-act="cancel-edit" title="Close" aria-label="Close editor"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="cpm-drawer-body">
            <div class="cl-cwin-field">
                <label class="cl-cwin-field-label" for="cpmEditSectionLabel">Name</label>
                <input type="search" class="cl-cwin-input cl-cwin-field-control" id="cpmEditSectionLabel" value="${esc(div.label)}" placeholder="${div.level === 0 ? 'Group name' : 'Sub-group name'}"
                    autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
            </div>
            <p class="cl-cwin-hint">${div.level === 0
                ? 'Organizes the list; nothing from a group heading is sent to the model. Blocks below it belong to it, until the next group.'
                : 'A smaller section inside the group above it. Nothing from the heading is sent to the model.'}</p>
        </div>
        <div class="cpm-drawer-actions">
            <button type="button" class="cl-cwin-btn-text" data-block-act="cancel-edit">Cancel</button>
            <button type="button" class="cl-cwin-btn-text is-primary" data-block-act="save-edit"><i class="fa-solid fa-check"></i> Save</button>
        </div>`;
    }
    const isMarker = b.kind === 'marker';
    const isHistory = isMarker && b.marker === 'chatHistory';
    // a picture rides a user turn and sits outside the history, as the server holds it
    const isPicture = isMarker && b.marker === 'characterPicture';
    const roleOpts = ROLE_OPTIONS
        .map(r => `<option value="${r}"${(b.role || 'system') === r ? ' selected' : ''}>${r.charAt(0).toUpperCase()}${r.slice(1)}</option>`)
        .join('');
    const posOpts = [
        ['pre_history', 'Before the Chat History'],
        ['post_history', 'After the Chat History'],
        ['at_depth', 'Inside the Chat History, at a Depth'],
    ]
        .filter(([v]) => !(isPicture && v === 'at_depth'))
        .map(([v, label]) => `<option value="${v}"${(b.position || 'pre_history') === v ? ' selected' : ''}>${label}</option>`)
        .join('');
    const atDepth = b.position === 'at_depth';
    const isOverridable = !isMarker && (b.key === 'main' || b.key === 'jailbreak');
    return `
    <div class="cpm-drawer-head">
        <span class="cpm-drawer-title">${isMarker ? 'Marker' : 'Text block'}</span>
        <button type="button" class="cpm-drawer-close" data-block-act="cancel-edit" title="Close" aria-label="Close editor"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="cpm-drawer-body">
    <div class="cl-cwin-field">
        <label class="cl-cwin-field-label" for="cpmEditName">Name</label>
        <input type="search" class="cl-cwin-input cl-cwin-field-control" id="cpmEditName" value="${esc(b.name || '')}" placeholder="Shown in the list"
            autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
    </div>
    ${isPicture
        ? `<div class="cl-cwin-field">
               <span class="cl-cwin-field-label">Sent as</span>
               <span class="cpm-field-static">User: a picture always goes in your turn.</span>
           </div>`
        : `<div class="cl-cwin-field">
               <label class="cl-cwin-field-label" for="cpmEditRole">Sent as</label>
               <select class="cl-select-fluid cl-cwin-field-control" id="cpmEditRole">${roleOpts}</select>
           </div>`}
    ${isHistory
        ? `<div class="cl-cwin-field">
               <span class="cl-cwin-field-label">Placement</span>
               <span class="cpm-field-static">This block IS the boundary that before and after are measured from.</span>
           </div>`
        : `<div class="cl-cwin-field">
               <label class="cl-cwin-field-label" for="cpmEditPosition">Placement</label>
               <select class="cl-select-fluid cl-cwin-field-control" id="cpmEditPosition">${posOpts}</select>
           </div>`}
    ${atDepth && !isHistory
        ? `<div class="cpm-field-row">
               <div class="cl-cwin-block">
                   <div class="cl-cwin-field">
                       <label class="cl-cwin-field-label" for="cpmEditDepth">Depth</label>
                       <input type="number" min="0" class="cl-cwin-input cl-cwin-field-control" id="cpmEditDepth" value="${Number.isInteger(b.depth) ? b.depth : 0}">
                   </div>
                   <p class="cl-cwin-hint">Turns back from the newest. 0 sits after the last message.</p>
               </div>
               <div class="cl-cwin-block">
                   <div class="cl-cwin-field">
                       <label class="cl-cwin-field-label" for="cpmEditOrder">Order</label>
                       <input type="number" class="cl-cwin-input cl-cwin-field-control" id="cpmEditOrder" value="${Number.isInteger(b.injectionOrder) ? b.injectionOrder : 100}">
                   </div>
                   <p class="cl-cwin-hint">Of several at one depth, higher sits nearer the reply.</p>
               </div>
           </div>`
        : ''}
    <div class="cl-cwin-block">
        <span class="cl-cwin-label" id="cpmFiresLabel">Fires on</span>
        <div class="cl-cwin-picks" role="group" aria-labelledby="cpmFiresLabel">${fireOptionsFor(b).map(o => `<label class="cl-cwin-pick"><input type="checkbox" data-cpm-trigger="${esc(o.key)}"${(b.triggers || []).includes(o.key) ? ' checked' : ''}><span>${esc(o.label)}</span></label>`).join('')}</div>
        <p class="cl-cwin-hint">None ticked: sent on every reply. Ticked: only on those.</p>
    </div>
    ${isOverridable
        ? `<label class="cl-cwin-field cl-cwin-toggle">
               <span class="cl-cwin-field-label">Ignore the character's own version of this block</span>
               <input type="checkbox" class="cl-switch-input" id="cpmEditForbid"${b.forbidOverrides ? ' checked' : ''}>
               <span class="cl-switch" aria-hidden="true"></span>
           </label>`
        : ''}
    ${isMarker
        ? `<p class="cl-cwin-hint">${esc(MARKER_HELP[b.marker] || 'Filled in when the prompt is built.')}</p>`
        : `<div class="cl-cwin-block cpm-field-grow">
               <label class="cl-cwin-label" for="cpmEditContent">Content</label>
               <textarea class="cl-cwin-input cl-cwin-textarea cpm-textarea" id="cpmEditContent" placeholder="${isOverridable ? "The card's own text is sent instead, when it has one" : 'Empty sends nothing'}">\n${esc(b.content || '')}</textarea>
           </div>`}
    </div>
    <div class="cpm-drawer-actions">
        <button type="button" class="cl-cwin-btn-text" data-block-act="cancel-edit">Cancel</button>
        <button type="button" class="cl-cwin-btn-text is-primary" data-block-act="save-edit"><i class="fa-solid fa-check"></i> Save</button>
    </div>`;
}

function renderDrawer() {
    const el = document.getElementById('cpmDrawer');
    if (!el) return;
    const b = _editingId ? (_preset?.blocks || []).find(x => x.id === _editingId) : null;
    // Focus mode, the lore panel's shape: editing swaps the sheet to JUST the editor, and
    // the subhead, filter and footer hide with it.
    document.querySelector('.cpm-sheet')?.classList.toggle('cpm-mode-edit', !!b || _settingsOpen);
    if (_settingsOpen && !b) {
        el.hidden = false;
        el.innerHTML = settingsHTML();
        el.querySelectorAll('.cpm-set-text').forEach(fitSettingBox);
        if (!CoreAPI.isMobileMode()) el.querySelector('[data-cpm-setting], [data-block-act="cancel-settings"]')?.focus({ preventScroll: true });
        return;
    }
    if (!b) {
        el.hidden = true;
        el.innerHTML = '';
        return;
    }
    el.hidden = false;
    el.innerHTML = drawerHTML(_draft?.id === b.id ? _draft : b);
    el.querySelectorAll('select').forEach(s => CoreAPI.initCustomSelect(s));
    // Desktop nicety only: on a phone this pops the keyboard over the editor you have
    // not read yet.
    if (!CoreAPI.isMobileMode()) el.querySelector('#cpmEditName')?.focus();
}

function openDrawer(id) {
    _settingsOpen = false;
    _draft = null;
    _editingId = _editingId === id ? null : id;
    renderList();
    renderDrawer();
    // the row's pen closing the drawer is a close too: a write held for it is read now
    if (!_editingId && _staleFromFeed) patchPresetsFromFeed();
}

function closeDrawer() {
    _editingId = null;
    _draft = null;
    renderList();
    renderDrawer();
    if (_staleFromFeed) patchPresetsFromFeed();
}

// every field the block editor shows, into a block or its draft: Save and the placement's redraw read the same way
function readDrawerInto(b) {
    const name = document.getElementById('cpmEditName')?.value ?? b.name;
    const role = document.getElementById('cpmEditRole')?.value || b.role;
    const position = document.getElementById('cpmEditPosition')?.value;
    const depthEl = document.getElementById('cpmEditDepth');
    const orderEl = document.getElementById('cpmEditOrder');
    const forbidEl = document.getElementById('cpmEditForbid');
    const contentEl = document.getElementById('cpmEditContent');
    b.name = String(name ?? '').trim() || null;
    // only an offered value is accepted: a control not on screen leaves its field alone
    if (ROLE_OPTIONS.includes(role)) b.role = role;
    else if (!b.role) b.role = 'system';
    if (POSITION_OPTIONS.includes(position)) b.position = position;
    if (depthEl) b.depth = Math.max(0, parseInt(depthEl.value, 10) || 0);
    if (orderEl) b.injectionOrder = parseInt(orderEl.value, 10) || 0;
    if (forbidEl) b.forbidOverrides = forbidEl.checked;
    const fireEls = [...document.querySelectorAll('#cpmDrawer [data-cpm-trigger]')];
    if (fireEls.length) b.triggers = fireEls.filter(x => x.checked).map(x => x.dataset.cpmTrigger);
    if (contentEl) b.content = contentEl.value;
}

// at-depth shows depth and order at once (else it saves a depth never shown); what was typed rides the redraw in the draft
function redrawForPlacement() {
    const b = _editingId ? (_preset?.blocks || []).find(x => x.id === _editingId) : null;
    if (!b || parseDivider(b.name)) return;
    if (_draft?.id !== b.id) _draft = { ...b, triggers: [...(b.triggers || [])] };
    readDrawerInto(_draft);
    renderDrawer();
}

// Read the fields back BEFORE the list re-renders, or the values are gone with the nodes.
function saveDrawer() {
    const b = _editingId ? (_preset?.blocks || []).find(x => x.id === _editingId) : null;
    if (!b) return closeDrawer();
    // The section editor carries only a label; writing through dividerName keeps the
    // stored name a valid divider whatever the label says. Level is preserved.
    const sectionEl = document.getElementById('cpmEditSectionLabel');
    if (sectionEl) {
        const level = parseDivider(b.name)?.level ?? 0;
        b.name = dividerName(level, sectionEl.value);
        savePreset();
        closeDrawer();
        renderHeader();
        return;
    }
    // a field a redraw took off screen (the depth, once the placement left it) is the draft's
    if (_draft?.id === b.id) Object.assign(b, _draft);
    readDrawerInto(b);
    // the write goes first, so the close's held re-read waits for its answer rather than racing it
    savePreset();
    closeDrawer();
    renderHeader();
}

// ========================================
// PRESET SETTINGS
// ========================================

// how the preset builds its prompt around the blocks, by group; a code field takes no spelling help, prose keeps it
const SETTING_GROUPS = [
    {
        title: 'Wrapping', icon: 'fa-quote-left',
        note: 'Text sent around three parts of the prompt; each part goes where its marker is. Empty sends the part as it is.',
        fields: [
            { key: 'personalityFormat', label: 'Personality', code: true, rows: 2, hint: "Sent for the character's personality, which goes where {{personality}} is. Without the marker only your text is sent." },
            { key: 'scenarioFormat', label: 'Scenario', code: true, rows: 2, hint: 'Sent for the scenario, which goes where {{scenario}} is. Without the marker only your text is sent.' },
            { key: 'loreFormat', label: 'Lore', code: true, rows: 2, hint: 'Sent for each lore group placed before or after the character; its entries go where {{lore}} is. Without the marker only your text is sent. Macros here are filled in with the entries, and lore inside the chat is not wrapped.' },
        ],
    },
    {
        title: 'Messages', icon: 'fa-comments',
        note: 'What this preset adds between messages, and how they go to the model.',
        fields: [
            { key: 'chatStart', label: 'Conversation opener', rows: 2, placeholder: 'Nothing is sent', hint: 'A system message sent just before the oldest message in the prompt. Empty sends none.' },
            { key: 'exampleSeparator', label: 'Before each example', rows: 2, placeholder: 'Nothing is sent', hint: 'A system message sent ahead of each example conversation, from the card or from lore. Empty sends none.' },
            { key: 'joinSystem', label: 'Join neighbouring system blocks', toggle: true, hint: 'On, system blocks next to each other go as one message, a line apart, with an instruction a button sends after them. Off, every block is its own message. The opener and the example lines always stay apart.' },
        ],
    },
    {
        title: 'Requests', icon: 'fa-wand-magic-sparkles',
        note: 'Sent at the end of the prompt when you use these buttons; {{char}}, {{user}} and the other macros are filled in. An empty box sends nothing.',
        fields: [
            { key: 'impersonateInstruction', label: 'Write my next message', rows: 4, prose: true, hint: 'Many presets carry a standing rule never to write as you, and a model obeying it refuses however the request is worded: rewording this is the fix. What you type in the message box follows it as direction.' },
            { key: 'guidedInstruction', label: "Direct the character's next reply", rows: 4, prose: true, hint: 'Sent when you use the wand. It frames the task; what you typed follows it as direction.' },
            { key: 'continueInstruction', label: 'Continue last reply', rows: 4, prose: true, hint: 'Sent after the reply when you continue it. It has to say the text is being extended, not replaced, or the model writes a fresh reply that is joined onto the old one.' },
            { key: 'continueJoiner', label: 'Join the new words with', joiner: true, hint: 'Goes between the reply so far and what the model adds, in the saved reply. Skipped when the reply already ends on a space.' },
            { key: 'continueAsOpening', label: 'End on the reply itself', toggle: true, hint: "On, the prompt ends on the reply so far as the model's own turn and the instruction above is not sent. Some connections add a line of their own after it." },
        ],
    },
];

// the joiners a reply is continued with, in words; any other text a preset file holds is offered as it is
const JOINERS = [
    ['', 'Nothing'],
    [' ', 'A Space'],
    ['\n', 'A New Line'],
    ['\n\n', 'A Blank Line'],
];

// a joiner no choice names, its characters written out so a tab or a space shows
function spelled(v) {
    return JSON.stringify(v).slice(1, -1);
}

/** The settings this preset sends, its own over the defaults; a Save on its way counts. */
function settingValues() {
    return { ..._defaultSettings, ...(pendingSettings ?? _preset?.settings ?? {}) };
}

// what the form shows: a refused Save as it was typed, still unsaved, so closing asks
function formValues() {
    return _refusedSettings && _refusedSettings.id === _preset?.id ? { ..._defaultSettings, ..._refusedSettings.values } : settingValues();
}

function settingFieldHtml(f, values, editable) {
    const v = values[f.key];
    const id = `cpmSet_${f.key}`;
    if (!editable) {
        const shown = f.toggle ? (v ? 'On' : 'Off')
            : f.joiner ? (JOINERS.find(([j]) => j === v)?.[1] || `"${spelled(v)}"`)
                : (v || 'Nothing is sent');
        return `<div class="cl-cwin-block"><span class="cl-cwin-label">${esc(f.label)}</span><span class="cpm-field-static cpm-set-static">${esc(shown)}</span><p class="cl-cwin-hint">${esc(f.hint)}</p></div>`;
    }
    if (f.toggle) {
        return `<div class="cl-cwin-block">
            <label class="cl-cwin-field cl-cwin-toggle">
                <span class="cl-cwin-field-label">${esc(f.label)}</span>
                <input type="checkbox" class="cl-switch-input" id="${id}" data-cpm-setting="${f.key}"${v ? ' checked' : ''}>
                <span class="cl-switch" aria-hidden="true"></span>
            </label>
            <p class="cl-cwin-hint">${esc(f.hint)}</p>
        </div>`;
    }
    if (f.joiner) {
        const choices = JOINERS.some(([j]) => j === v) ? JOINERS : [...JOINERS, [v, `As the file has it: "${spelled(v)}"`]];
        return `<div class="cl-cwin-block">
            <span class="cl-cwin-label" id="${id}Label">${esc(f.label)}</span>
            <div class="cl-cwin-picks" role="radiogroup" aria-labelledby="${id}Label">${choices.map(([j, label], i) => `<label class="cl-cwin-pick"><input type="radio" name="${id}" data-cpm-joiner="${i}"${j === v ? ' checked' : ''}><span>${esc(label)}</span></label>`).join('')}</div>
            <p class="cl-cwin-hint">${esc(f.hint)}</p>
        </div>`;
    }
    const plain = f.prose ? '' : ' autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"';
    const off = f.key === 'continueInstruction' && values.continueAsOpening;
    return `<div class="cl-cwin-block">
        <label class="cl-cwin-label" for="${id}">${esc(f.label)}</label>
        <textarea class="cl-cwin-input cl-cwin-textarea cpm-set-text${f.code ? ' is-code' : ''}" id="${id}" rows="${f.rows}" data-cpm-setting="${f.key}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''}${plain}${off ? ' disabled' : ''}>\n${esc(v)}</textarea>
        <button type="button" class="cl-cwin-btn-text cpm-set-reset" data-cpm-reset="${f.key}"${v === _defaultSettings[f.key] ? ' hidden' : ''}><i class="fa-solid fa-rotate-left"></i> Back to Default</button>
        <p class="cl-cwin-hint">${esc(f.hint)}</p>
        ${f.key === 'continueInstruction' ? `<p class="cl-cwin-hint" data-cpm-off-note${off ? '' : ' hidden'}>Not sent while End on the reply itself is on.</p>` : ''}
    </div>`;
}

/** The preset's settings in the drawer: editable on a preset, read only for the built-in blocks. */
function settingsHTML() {
    const head = `
    <div class="cpm-drawer-head">
        <span class="cpm-drawer-title">Preset Settings</span>
        <button type="button" class="cpm-drawer-close" data-block-act="leave-settings" title="Close" aria-label="Close the preset settings"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
    // unread is never drawn as a form: its boxes would show nothing where the server holds something
    if (_loadError) {
        return `${head}
    <div class="cpm-drawer-body">
        <div class="cl-cwin-empty is-error">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <p>The prompt presets could not be loaded, so these settings are unknown rather than empty.</p>
            <p class="cl-cwin-dim">${esc(_loadError)}</p>
        </div>
    </div>
    <div class="cpm-drawer-actions">
        <button type="button" class="cl-cwin-btn-text" data-block-act="cancel-settings">Close</button>
    </div>`;
    }
    const editable = !!_preset;
    const values = formValues();
    const groups = SETTING_GROUPS.map(g => `<section class="cl-cwin-group">
        <h4 class="cl-cwin-group-title"><i class="fa-solid ${g.icon}"></i>${esc(g.title)}</h4>
        <p class="cl-cwin-group-note">${esc(g.note)}</p>
        <div class="cl-cwin-fields">${g.fields.map(f => settingFieldHtml(f, values, editable)).join('')}</div>
    </section>`).join('');
    const intro = editable
        ? `<p class="cl-cwin-hint cpm-set-intro">${esc(_preset.name || 'Untitled preset')}: every chat using this preset sends these.</p>`
        : `<div class="cpm-builtin-note"><i class="fa-solid fa-lock"></i><span>Built in, so these cannot be edited. Make a new preset to change them.</span></div>`;
    const origin = editable && _preset.source === 'sillytavern'
        ? `<div class="cpm-builtin-note"><i class="fa-solid fa-file-import"></i><span>Started from a SillyTavern preset file.</span></div>`
        : '';
    return `${head}
    <div class="cpm-drawer-body">
        ${intro}${origin}
        ${groups}
    </div>
    <div class="cpm-drawer-actions">
        ${editable
            ? `<button type="button" class="cl-cwin-btn-text" data-block-act="cancel-settings">Cancel</button>
               <button type="button" class="cl-cwin-btn-text is-primary" data-block-act="save-settings"><i class="fa-solid fa-check"></i> Save</button>`
            : '<button type="button" class="cl-cwin-btn-text" data-block-act="cancel-settings">Close</button>'}
    </div>`;
}

// the form as typed: every field's value, read before anything re-renders
function readSettingsForm() {
    const el = document.getElementById('cpmDrawer');
    const values = formValues();
    const out = {};
    for (const f of SETTING_GROUPS.flatMap(g => g.fields)) {
        if (f.joiner) {
            const at = el?.querySelector(`[name="cpmSet_${f.key}"]:checked`)?.dataset.cpmJoiner;
            const choices = JOINERS.some(([j]) => j === values[f.key]) ? JOINERS : [...JOINERS, [values[f.key]]];
            out[f.key] = at !== undefined ? choices[Number(at)]?.[0] ?? '' : values[f.key];
            continue;
        }
        const input = el?.querySelector(`[data-cpm-setting="${f.key}"]`);
        out[f.key] = !input ? values[f.key] : f.toggle ? input.checked : input.value;
    }
    return out;
}

// what the preset stores: only what differs from a default, so a default it never changed follows the app's
function storedSettings(values) {
    return Object.fromEntries(Object.entries(values).filter(([key, v]) => v !== _defaultSettings[key]));
}

function openSettings() {
    _editingId = null;
    _settingsOpen = true;
    renderList();
    renderDrawer();
}

function closeSettings() {
    _settingsOpen = false;
    _refusedSettings = null;
    renderList();
    renderDrawer();
    if (_staleFromFeed) patchPresetsFromFeed();
}

function saveSettings() {
    if (!_preset || !settingsChanged()) return closeSettings();
    pendingSettings = storedSettings(readSettingsForm());
    savePreset([]);
    closeSettings();
    renderHeader();
}

// a refused Save opens again as typed, its reason in the save's toast; another editor in the drawer keeps it for the next open
function reopenRefusedSettings(id, values) {
    _refusedSettings = { id, values };
    if (panelOpen && !_editingId && !_settingsOpen) openSettings();
}

// whether the form holds a value the preset does not, setting by setting (an object's key order says nothing)
function settingsChanged() {
    if (!_preset || !_settingsOpen) return false;
    const typed = readSettingsForm();
    const held = settingValues();
    const plain = (v) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n') : v);
    return Object.keys(held).some(key => plain(typed[key]) !== plain(held[key]));
}

// settings changed and not saved are asked about, never dropped unseen; true when nothing is held or the reader lets it go
async function confirmDropSettings() {
    if (!settingsChanged()) return true;
    try {
        return (await CoreAPI.showConfirm({ title: 'Discard your changes?', message: 'The preset settings you changed are not saved.', confirmLabel: 'Discard', cancelLabel: 'Keep Editing', danger: true })) === true;
    } catch {
        return false;
    }
}

// leaving the settings any way but Cancel; answers whether it left
async function leaveSettings() {
    if (!(await confirmDropSettings())) return false;
    closeSettings();
    return true;
}

// a reset shows only beside a value that differs from its default; End on the reply itself takes the instruction out
function syncSettingsForm(target) {
    const el = document.getElementById('cpmDrawer');
    if (!el || !_settingsOpen) return;
    const key = target?.dataset?.cpmSetting;
    if (key && target.tagName === 'TEXTAREA') {
        const btn = el.querySelector(`[data-cpm-reset="${key}"]`);
        if (btn) btn.hidden = target.value === _defaultSettings[key];
        fitSettingBox(target);
    }
    if (key === 'continueAsOpening') {
        const instruction = el.querySelector('[data-cpm-setting="continueInstruction"]');
        if (instruction) instruction.disabled = target.checked;
        const note = el.querySelector('[data-cpm-off-note]');
        if (note) note.hidden = !target.checked;
    }
}

function resetSetting(key) {
    const input = document.querySelector(`#cpmDrawer [data-cpm-setting="${key}"]`);
    if (!input || typeof _defaultSettings[key] !== 'string') return;
    input.value = _defaultSettings[key];
    syncSettingsForm(input);
}

// a settings box sized to its text with the creator's breathing room, so a swipe on it moves the view, not the box
function fitSettingBox(el) {
    CoreAPI.fitTextarea(el, { pad: 4 });
}

// a turned or narrowed screen rewraps the settings' text: their boxes are fitted again, the reader's place kept
function refitSettingBoxes() {
    const el = document.querySelector('#cpmDrawer .cpm-drawer-body');
    if (!_settingsOpen || !el) return;
    const top = el.scrollTop;
    el.querySelectorAll('.cpm-set-text').forEach(fitSettingBox);
    el.scrollTop = top;
}

// back and Escape step out of an editor before they close the window
function closeOrBack() {
    if (_settingsOpen) return void leaveSettings();
    if (_editingId) return closeDrawer();
    return closePanel();
}

// the header's close: on a phone it is the back arrow; on a desktop it closes the window, asking first over unsaved settings
function closeFromHeader() {
    if (CoreAPI.isMobileMode()) return closeOrBack();
    return closePanel();
}

// ========================================
// BLOCK ACTIONS
// ========================================

function addBlock(block) {
    if (!_preset) {
        CoreAPI.showToast('Pick a preset first: the built-in defaults are not editable', 'info');
        return;
    }
    _preset.blocks = [...(_preset.blocks || []), block];
    _editingId = block.id;
    renderAll();
    renderDrawer();
    savePreset();
}

function addGroup() {
    // Disabled with empty content, so the divider itself never reaches assembly; only
    // its NAME means anything, and only to this panel.
    addBlock(newTextBlock(dividerName(0)));
}

function addSubgroup() {
    const hasGroup = (_preset?.blocks || []).some(b => parseDivider(b.name)?.level === 0);
    if (_preset && !hasGroup) {
        CoreAPI.showToast('A sub-group lives inside a group: add a group first', 'info');
        return;
    }
    // Appended at the end, which by construction nests under the last group. The
    // no-preset case falls through to addBlock's own guard toast.
    addBlock(newTextBlock(dividerName(1)));
}

function addMarkerBlock() {
    const present = new Set((_preset?.blocks || []).filter(b => b.kind === 'marker').map(b => b.marker));
    // A second chatHistory (or a second description) is meaningless, so only the markers
    // this preset does not already carry are offered.
    const free = Object.keys(MARKER_LABELS).filter(m => !present.has(m));
    if (!free.length) {
        CoreAPI.showToast('Every marker is already in this preset', 'info');
        return;
    }
    addBlock(newMarkerBlock(free[0]));
}

function duplicateBlock(id) {
    if (!_preset) return;
    const blocks = _preset.blocks || [];
    const i = blocks.findIndex(b => b.id === id);
    if (i === -1) return;
    const copy = { ...blocks[i], id: newTextBlock().id, name: `${displayName(blocks[i])} copy` };
    _preset.blocks = [...blocks.slice(0, i + 1), copy, ...blocks.slice(i + 1)];
    renderAll();
    savePreset();
}

async function deleteBlock(id) {
    if (!_preset) return;
    const blocks = _preset.blocks || [];
    const b = blocks.find(x => x.id === id);
    if (!b) return;
    const div = parseDivider(b.name);
    const ok = await CoreAPI.showConfirm({
        title: div ? 'Delete this heading?' : 'Delete this block?',
        message: div
            ? `"${div.label}" is removed. The blocks under it stay and join the section above.`
            : `"${displayName(b)}" is removed from this preset. Other presets are untouched.`,
        confirmLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    _preset.blocks = blocks.filter(x => x.id !== id);
    if (_editingId === id) _editingId = null;
    renderAll();
    renderDrawer();
    savePreset();
}

// ========================================
// RENDER
// ========================================

function renderAll() {
    renderHeader();
    renderInForce();
    renderList();
    syncPresetActions();
}

// whose choice the preset above is, and the only place the default moves; the picker names the preset, so this line never repeats it
function renderInForce() {
    const host = document.getElementById('cpmInForce');
    if (!host) return;
    if (_loadError || !_resolved) { host.innerHTML = ''; return; }
    const btn = (act, label, title) => `<button type="button" class="cl-cwin-btn-text" data-cpm-act="${act}" title="${title}">${label}</button>`;
    if (_resolved.source === 'chat') {
        const isDefault = _resolved.override === _resolved.defaultId;
        host.innerHTML = `<div class="cl-cwin-inforce">
            <i class="fa-solid fa-comment"></i>
            <div><strong>This chat's own</strong><span>${isDefault ? 'Set for this chat only, and also the default.' : 'Set for this chat only.'}</span></div>
            ${isDefault ? '' : btn('make-default', 'Make Default', 'Make this preset the default for every chat without its own')}
            ${btn('use-default', 'Use Default', 'Follow the default preset again')}
        </div>`;
        return;
    }
    host.innerHTML = _activeId
        ? `<div class="cl-cwin-inforce">
            <i class="fa-solid fa-globe"></i>
            <div><strong>The default</strong><span>Used by every chat without its own.</span></div>
            ${btn('clear-default', 'Clear Default', 'Every chat without its own preset goes back to the built-in blocks')}
        </div>`
        : `<div class="cl-cwin-inforce is-none">
            <i class="fa-solid fa-globe"></i>
            <div><strong>The default</strong><span>The built-in blocks answer every chat without a preset of its own.</span></div>
        </div>`;
}

// the one inventory of preset verbs, listed under the More when it opens; runPresetAction runs them
const PRESET_ACTIONS = [
    { act: 'settings', icon: 'fa-gear', label: 'Preset Settings', needsPreset: false },
    { act: 'new', icon: 'fa-plus', label: 'New Preset', needsPreset: false },
    { act: 'duplicate', icon: 'fa-clone', label: 'Duplicate Preset', needsPreset: true },
    { act: 'rename', icon: 'fa-i-cursor', label: 'Rename Preset', needsPreset: true },
    { act: 'import', icon: 'fa-file-import', label: 'Import a Preset File', needsPreset: false },
    { act: 'export', icon: 'fa-file-export', label: 'Export This Preset', needsPreset: true },
    { act: 'export-st', icon: 'fa-share-from-square', label: 'Export as a SillyTavern Preset', needsPreset: true },
    { act: 'delete', icon: 'fa-trash', label: 'Delete Preset', needsPreset: true, danger: true },
];

function runPresetAction(act) {
    switch (act) {
        case 'new': return newPreset();
        case 'duplicate': return duplicatePreset();
        case 'rename': return renamePreset();
        case 'delete': return deletePreset();
        case 'export': return exportPreset();
        case 'export-st': return exportStPreset();
        case 'settings': return openSettings();
        case 'import': return document.getElementById('cpmImportFile')?.click();
        default: return undefined;
    }
}

// the shared menu under the More, so a menu opened from the keyboard stands where the button is; a phone gets its sheet
function openPresetActions(e) {
    const r = e.currentTarget.getBoundingClientRect();
    CoreAPI.getModule('context-menu')?.showItems?.(e, [
        { type: 'header', label: 'Preset' },
        ...PRESET_ACTIONS
            .filter(a => !(a.needsPreset && !_preset))
            .map(a => ({ icon: `fa-solid ${a.icon}`, label: a.label, className: a.danger ? 'danger' : '', action: () => runPresetAction(a.act) })),
    ], { x: r.left, y: r.bottom + 4 });
}

// the one inventory of picks the select lists: following the default first, then each preset as this chat's own
function pickRows() {
    const own = _resolved?.source === 'chat' ? _resolved.override : null;
    const defaultName = _resolved?.defaultId ? (_presets.find(p => p.id === _resolved.defaultId)?.name || 'Untitled preset') : 'Built-In Defaults';
    return [
        { id: '', name: `Same as the Default (${defaultName})`, on: !own },
        ..._presets.map(p => ({ id: p.id, name: p.name || 'Untitled preset', on: p.id === own })),
    ];
}

// the built-in defaults arent editable: the add verbs disable rather than hide, so nobody hunts for them
function syncPresetActions() {
    const has = !!_preset;
    document.querySelectorAll('[data-block-act="add-text"], [data-block-act="add-marker"], [data-block-act="add-group"], [data-block-act="add-subgroup"]')
        .forEach(btn => { btn.disabled = !has; });
}

function renderHeader() {
    const select = document.getElementById('cpmPresetSelect');
    const tokens = document.getElementById('cpmTokens');
    const warn = document.getElementById('cpmWarn');
    if (!select || !tokens || !warn) return;

    select.innerHTML = pickRows().map(r => `<option value="${esc(r.id)}"${r.on ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
    // The custom control reads the options at build time; a rebuilt list needs telling.
    if (select._customSelect) { select._customSelect.refresh?.(); select._customSelect.update?.(); }
    else CoreAPI.initCustomSelect(select);

    const blocks = _preset?.blocks || [];
    let total = 0;
    for (const b of blocks) {
        if (!b.enabled || parseDivider(b.name) || !firesOnNormal(b)) continue;
        total += estTokens(b.content);
    }
    // "+", not "~": the preset's own overhead over card and history; the inspector has the full count
    tokens.textContent = `+${total.toLocaleString()} tok`;

    // No enabled chatHistory marker means the model never sees the conversation.
    const hasHistory = blocks.some(b => b.kind === 'marker' && b.marker === 'chatHistory' && b.enabled && firesOnNormal(b));
    warn.hidden = !_preset || hasHistory;
}

function renderList() {
    const list = document.getElementById('cpmList');
    const filter = document.getElementById('cpmFilter');
    if (!list) return;

    if (_loadError) {
        list.innerHTML = `<div class="cl-cwin-empty is-error">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <p>The prompt presets could not be loaded, so this list is unknown rather than empty.</p>
            <p class="cl-cwin-dim">${esc(_loadError)}</p>
        </div>`;
        filter?.classList.remove('is-empty');
        return;
    }

    // No preset selected still means something is building the prompt, so SHOW it. The rows
    // are read-only because the defaults live in code.
    if (!_preset) {
        const rows = _defaultBlocks.length
            ? buildModel(_defaultBlocks).map(it => (it.type === 'head' ? '' : rowHTML(it, { readOnly: true }))).join('')
            : '';
        list.innerHTML = `<div class="cpm-builtin-note">
                <i class="fa-solid fa-lock"></i>
                <span>Built in, so these cannot be edited. Make a new preset to change the prompt.</span>
            </div>${rows}`;
        filter?.classList.remove('is-empty');
        return;
    }

    const blocks = _preset.blocks || [];
    const items = buildModel(blocks);
    const filtering = _filterTerms.length > 0;
    // Reordering against a filtered list moves blocks to positions the reader cannot see.
    _dragEnabled = !filtering;
    const keep = filtering ? computeMatches(items, _filterTerms) : null;

    const html = [];
    for (const it of items) {
        if (filtering) {
            if (!keep.has(it.id)) continue;
        } else if (it.parents.some(p => isCollapsed(p, blocks.length))) {
            continue;
        }
        html.push(it.type === 'head' ? headHTML(it, filtering, blocks.length) : rowHTML(it));
    }

    if (!html.length) {
        list.innerHTML = `<div class="cl-cwin-empty">
            <i class="fa-solid fa-magnifying-glass"></i>
            <p>${filtering ? 'No block matches that filter.' : 'This preset has no blocks.'}</p>
        </div>`;
    } else {
        list.innerHTML = html.join('');
    }
    filter?.classList.toggle('is-empty', filtering && !html.length);
}

// ========================================
// ACTIONS
// ========================================

function toggleCollapse(id) {
    const collapse = collapseDoc.get();
    if (!collapse || !_preset) return;
    const count = (_preset.blocks || []).length;
    collapse.collapsed[id] = !isCollapsed(id, count);
    renderList();
    collapseDoc.save();
}

function toggleBlockEnabled(id, enabled) {
    if (!_preset) return;
    const block = (_preset.blocks || []).find(b => b.id === id);
    if (!block) return;
    block.enabled = !!enabled;
    renderAll();
    savePreset();
}

/** Mobile only: the row's actions behind one kebab on the shared menu, rows DERIVED from the hidden buttons; Move up/down since touch has no drag. */
function openRowActsSheet(kebab, e) {
    const menu = CoreAPI.getModule('context-menu');
    const row = kebab.closest('.cpm-row, .cpm-head');
    const acts = [...(row?.querySelectorAll('.cpm-acts .cpm-act') || [])];
    if (!menu?.showItems || !row || !acts.length) return;
    menu.showItems(e, [
        { type: 'header', label: row.querySelector('.cpm-name, .cpm-head-name')?.textContent || 'Block' },
        ...acts.map(a => ({
            icon: a.querySelector('i')?.className || '',
            label: a.getAttribute('aria-label') || a.title || 'Action',
            className: a.classList.contains('cpm-act-danger') ? 'danger' : '',
            action: () => a.click(),
        })),
        { type: 'separator' },
        { icon: 'fa-solid fa-arrow-up', label: 'Move Up', action: () => nudgeRun(row.dataset.id, -1) },
        { icon: 'fa-solid fa-arrow-down', label: 'Move Down', action: () => nudgeRun(row.dataset.id, 1) },
    ]);
}

/** Move a row's whole run one slot among its neighbours; the sheet's touch reorder. */
function nudgeRun(id, dir) {
    const blocks = _preset?.blocks || [];
    const run = runFor(blocks, id);
    if (!run) return;
    if (dir < 0) {
        if (run[0] === 0) return;
        const prev = runFor(blocks, blocks[run[0] - 1].id);
        if (!prev || !moveBlock(id, blocks[prev[0]].id)) return;
    } else {
        if (run[1] >= blocks.length) return;
        const next = runFor(blocks, blocks[run[1]].id);
        if (!next) return;
        const afterId = next[1] < blocks.length ? blocks[next[1]].id : undefined;
        if (!moveBlock(id, afterId)) return;
    }
    renderAll();
    savePreset();
}

function moveBlock(dragId, targetId) {
    if (!_preset || dragId === targetId) return false;
    const blocks = _preset.blocks || [];
    const run = runFor(blocks, dragId);
    if (!run) return false;
    const moving = blocks.slice(run[0], run[1]);
    if (moving.some(b => b.id === targetId)) return false;   // dropped inside its own section
    const rest = blocks.slice(0, run[0]).concat(blocks.slice(run[1]));
    let at = rest.findIndex(b => b.id === targetId);
    if (at === -1) at = rest.length;
    rest.splice(at, 0, ...moving);
    // a drop that leaves the order as it was writes nothing
    if (rest.every((b, i) => b === blocks[i])) return false;
    _preset.blocks = rest;
    return true;
}

function applyFilter(raw) {
    _filterTerms = String(raw || '').toLowerCase().split(/\s+/).filter(Boolean);
    renderList();
}

// ========================================
// PANEL LIFECYCLE
// ========================================

// The panel lives INSIDE the conversation window: Escape resolves the topmost overlay
// by containment, so a nested panel closes before the conversation does.
function injectPanel() {
    if (panelInjected) return;
    const host = document.getElementById('chatsConversation');
    if (!host) return;
    panelInjected = true;
    host.insertAdjacentHTML('beforeend', buildPanelHTML());

    document.getElementById('cpmClose')?.addEventListener('click', closeFromHeader);
    window.addEventListener('resize', CoreAPI.debounce(refitSettingBoxes, 120));


    const sheet = document.querySelector('.cpm-sheet');
    mountChatWindow(sheet, {
        key: 'chatPromptPanel',
        close: closePanel,
        min: { w: 18, h: 25 },
    });

    document.getElementById('cpmPresetSelect')?.addEventListener('change', (e) => {
        applyPreset(e.target.value);
    });

    const filter = document.getElementById('cpmFilter');
    const onFilter = CoreAPI.debounce(() => applyFilter(filter.value), FILTER_DEBOUNCE_MS);
    filter?.addEventListener('input', onFilter);

    document.getElementById('cpmPresetMore')?.addEventListener('click', openPresetActions);

    document.getElementById('cpmInForce')?.addEventListener('click', (e) => {
        const act = e.target.closest('[data-cpm-act]')?.dataset.cpmAct;
        if (act === 'make-default') void setDefaultPreset(_activeId);
        else if (act === 'clear-default') void setDefaultPreset(null);
        else if (act === 'use-default') void applyPreset('');
    });

    sheet?.addEventListener('click', (e) => {
        const reset = e.target.closest('[data-cpm-reset]');
        if (reset) return resetSetting(reset.dataset.cpmReset);
        const bbtn = e.target.closest('[data-block-act]');
        if (!bbtn) return;
        switch (bbtn.dataset.blockAct) {
            case 'add-text': return addBlock(newTextBlock());
            case 'add-marker': return addMarkerBlock();
            case 'add-group': return addGroup();
            case 'add-subgroup': return addSubgroup();
            case 'edit': return openDrawer(bbtn.dataset.id);
            case 'duplicate': return duplicateBlock(bbtn.dataset.id);
            case 'delete': return deleteBlock(bbtn.dataset.id);
            case 'acts': return openRowActsSheet(bbtn, e);
            case 'save-edit': return saveDrawer();
            case 'cancel-edit': return closeDrawer();
            case 'save-settings': return saveSettings();
            case 'cancel-settings': return closeSettings();
            case 'leave-settings': return void leaveSettings();
            default: return undefined;
        }
    });

    sheet?.addEventListener('input', (e) => syncSettingsForm(e.target));
    sheet?.addEventListener('change', (e) => {
        syncSettingsForm(e.target);
        if (e.target.id === 'cpmEditPosition') redrawForPlacement();
    });

    const importFile = document.getElementById('cpmImportFile');
    importFile?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';   // so re-picking the same file fires again
        await importPresetFile(file);
    });

    const list = document.getElementById('cpmList');
    list?.addEventListener('click', (e) => {
        const head = e.target.closest('.cpm-head');
        // The rename/delete buttons on a head are the sheet delegate's; letting them
        // ALSO toggle the collapse makes every rename flip the section shut.
        if (!head || e.target.closest('.cpm-grip') || e.target.closest('[data-block-act]')) return;
        toggleCollapse(head.dataset.id);
    });
    list?.addEventListener('change', (e) => {
        const input = e.target.closest('.cpm-toggle-input');
        if (!input) return;
        toggleBlockEnabled(input.dataset.id, input.checked);
    });

    attachDragReorder(list);

    registerChatWindow('chatPromptPanel', { close: () => closeOrBack() });
}

// HTML5 drag, resolved against the block array since collapsed rows arent rendered; the row's half says above or below
function attachDragReorder(list) {
    if (!list) return;
    let dragItem = null;
    let carried = null;   // the ids the dragged row moves: a heading carries its section
    const rows = () => [...list.querySelectorAll('.cpm-row, .cpm-head')];
    const clearOver = () => rows().forEach(el => el.classList.remove('is-drop-before', 'is-drop-after'));
    // a row the drag can land beside: never one it carries
    const dropOnto = (e) => {
        const row = e.target.closest?.('.cpm-row, .cpm-head');
        return row && dragItem && !carried.has(row.dataset.id) ? row : null;
    };
    const below = (row, e) => { const r = row.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
    // below a row is before the row drawn under it, which a collapsed section's blocks are not; none at the end
    const landsBefore = (row, after) => {
        if (!after) return row.dataset.id;
        const all = rows();
        return all[all.indexOf(row) + 1]?.dataset.id;
    };

    list.addEventListener('dragstart', (e) => {
        const item = e.target.closest('.cpm-row, .cpm-head');
        if (!item || !_dragEnabled) return;
        const blocks = _preset?.blocks || [];
        const run = runFor(blocks, item.dataset.id);
        dragItem = item;
        carried = new Set(run ? blocks.slice(run[0], run[1]).map(b => b.id) : [item.dataset.id]);
        item.classList.add('cpm-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.dataset.id);
    });
    list.addEventListener('dragend', () => {
        if (dragItem) dragItem.classList.remove('cpm-dragging');
        dragItem = null;
        clearOver();
    });
    list.addEventListener('dragover', (e) => {
        const row = dropOnto(e);
        if (!row) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearOver();
        row.classList.add(below(row, e) ? 'is-drop-after' : 'is-drop-before');
    });
    list.addEventListener('dragleave', (e) => {
        if (!e.relatedTarget || !list.contains(e.relatedTarget)) clearOver();
    });
    list.addEventListener('drop', (e) => {
        const row = dropOnto(e);
        if (!row) return;
        e.preventDefault();
        const id = dragItem.dataset.id;
        const before = landsBefore(row, below(row, e));
        dragItem.classList.remove('cpm-dragging');
        dragItem = null;
        clearOver();
        if (!moveBlock(id, before)) return;
        renderAll();
        savePreset();
    });
}

async function openPanel() {
    injectPanel();
    const panel = document.getElementById('chatPromptPanel');
    if (!panel) return;
    openChatWindow(panel, { button: 'chatConvPrompts' });
    panelOpen = true;

    const list = document.getElementById('cpmList');
    if (list && !list.childElementCount) {
        list.innerHTML = '<div class="cl-cwin-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><p>Reading the preset</p></div>';
    }
    // the last open's rows stay painted but may be stale (the feed skips a closed panel): nothing on them acts until the read lands
    const body = [...panel.querySelectorAll('.cpm-subhead, .cpm-inforce, .cl-cwin-filterbar, .cpm-list, .cpm-footer')];
    body.forEach(el => { el.inert = true; });
    try { await refreshPanel(); } finally { body.forEach(el => { el.inert = false; }); }
}

// resolves whether it closed (unsaved settings ask first); exclusive mode calls it bare, a chat that went away forces it
async function closePanel({ force = false } = {}) {
    if (panelOpen && !force && !(await confirmDropSettings())) return false;
    const panel = document.getElementById('chatPromptPanel');
    panelOpen = false;
    closeChatWindow(panel, { button: 'chatConvPrompts' });
    // a refused Save on screen goes with the form; one not yet seen waits for the next open
    if (_settingsOpen) _refusedSettings = null;
    // focus mode never survives the panel: a reopen over a changed preset would be an editor over a hidden list
    _editingId = null;
    _draft = null;
    _settingsOpen = false;
    renderDrawer();
    return true;
}

function togglePanel() {
    if (panelOpen) closePanel();
    else openPanel();
}

function init() {
    document.getElementById('chatConvPrompts')?.addEventListener('click', togglePanel);
    registerFeedPatcher(['preset', 'setting', 'chat'], patchPresetsFromFeed);
    // follow the chat, or a pick lands on the one left; an open window reads the new chat's answer as a feed write would
    document.addEventListener('cl-chat-changed', (e) => {
        const chatId = e.detail?.chatId || null;
        if (chatId === _chatId) return;
        _chatId = chatId;
        // the last chat's answer says nothing about this one: the banner goes until the re-read lands
        _resolved = null;
        if (!panelOpen) return;
        if (!chatId) { closePanel({ force: true }); return; }
        renderInForce();
        void patchPresetsFromFeed(null);
    });
}

export { openPanel, closePanel, togglePanel };
export default { init, openPanel, closePanel, togglePanel };
