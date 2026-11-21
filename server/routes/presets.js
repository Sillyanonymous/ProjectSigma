import { Router } from 'express';
import {
    listPresetRows, getPreset, updatePreset, deletePreset,
    getActivePresetId, setActivePreset, resolveChatPreset,
} from '../db/presets-store.js';
import { createPresetWithScripts, listScripts, scriptError } from '../db/regex-store.js';
import { MARKERS, POSITIONS, DEFAULT_BLOCKS, promptSettingsOf, promptSettingsError } from '../llm/preset.js';
import { planStPresetImport, exportSillyTavernPreset } from '../lib/sillytavern-preset.js';

export const presetsRouter = Router();

const ROLES = ['system', 'user', 'assistant'];

// validated as a whole list, order is data; an unknown marker is refused, never stored inert
function validateBlocks(blocks) {
    if (!Array.isArray(blocks)) return 'blocks must be an array';
    for (const [i, b] of blocks.entries()) {
        if (!b || typeof b !== 'object') return `block ${i} is not an object`;
        if (b.kind !== undefined && b.kind !== 'text' && b.kind !== 'marker') return `block ${i} has invalid kind '${b.kind}'; valid: text, marker`;
        const kind = b.kind === 'marker' ? 'marker' : 'text';
        if (kind === 'marker' && !MARKERS.includes(b.marker)) {
            return `block ${i} names unknown marker '${b.marker}'; valid: ${MARKERS.join(', ')}`;
        }
        if (b.role !== undefined && !ROLES.includes(b.role)) return `block ${i} has invalid role '${b.role}'`;
        if (b.position !== undefined && !POSITIONS.includes(b.position)) return `block ${i} has invalid position '${b.position}'`;
        // a depth's lane is one text per role, which can carry no picture: the block would send its words alone
        if (kind === 'marker' && b.marker === 'characterPicture' && b.position === 'at_depth') return `block ${i}: the character's picture sits before or after the history, not at a depth`;
        if (b.content !== undefined && typeof b.content !== 'string') return `block ${i} content must be a string`;
    }
    return null;
}

// prompt settings arrive as one object; an unknown key, a wrong type or an overlong text is refused by name, never dropped
const settingsError = (v) => (v === undefined ? null : promptSettingsError(v));

// each preset by name alone, its blocks read by id; defaultBlocks and defaultSettings ride along so the client shows what runs
presetsRouter.get('/', (req, res) => {
    res.json({
        presets: listPresetRows(req.db),
        activeId: getActivePresetId(req.db),
        defaultBlocks: DEFAULT_BLOCKS.map(b => ({
            id: b.id, key: b.id, name: b.name ?? null, kind: b.kind, marker: b.marker,
            content: b.content, role: b.role, position: b.position,
            depth: b.depth ?? 0, enabled: !!b.enabled, pos: b.pos,
        })),
        defaultSettings: promptSettingsOf(null),
    });
});

presetsRouter.post('/', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name required' });
    if (req.body?.blocks !== undefined) {
        const err = validateBlocks(req.body.blocks);
        if (err) return res.status(400).json({ error: err });
    }
    const scripts = req.body?.regexScripts;
    if (scripts !== undefined && !Array.isArray(scripts)) return res.status(400).json({ error: 'regexScripts is a list of regex scripts' });
    for (const [i, s] of (scripts || []).entries()) {
        const err = scriptError(s, i);
        if (err) return res.status(400).json({ error: err });
    }
    const settingsErr = settingsError(req.body?.settings);
    if (settingsErr) return res.status(400).json({ error: settingsErr });
    // a preset file's own scripts come with it, off until the reader allows this preset; a list refused leaves no preset behind
    const preset = createPresetWithScripts(req.db, { name, blocks: req.body?.blocks, settings: req.body?.settings }, scripts || []);
    res.json(preset);
});

// import an ST chat-completion preset, its report answered beside what was stored
presetsRouter.post('/import', (req, res) => {
    const doc = req.body?.preset;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        return res.status(400).json({ error: 'preset object required' });
    }
    const fallback = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : 'Imported preset';
    const plan = planStPresetImport(doc, fallback);
    if (!plan.blocks.length) {
        return res.status(400).json({ error: 'this preset has no prompts we can express', report: plan.report });
    }
    const err = validateBlocks(plan.blocks);
    if (err) return res.status(400).json({ error: `import produced an invalid block: ${err}`, report: plan.report });

    // its regex scripts come with it, off until the reader allows this preset; a list refused leaves no preset behind
    const preset = createPresetWithScripts(req.db, { name: plan.name, source: 'sillytavern', blocks: plan.blocks, settings: plan.settings }, plan.regexScripts);
    res.json({ preset, report: plan.report });
});

// Ahead of '/:id' so the literal path is not swallowed by the param route.
presetsRouter.put('/active', (req, res) => {
    const id = req.body?.id;
    if (id === null) { setActivePreset(req.db, null); return res.json({ activeId: null }); }
    if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'id must be a string, or null to clear' });
    const active = setActivePreset(req.db, id);
    if (!active) return res.status(404).json({ error: 'preset not found' });
    res.json({ activeId: active });
});

// Ahead of '/:id' too. `override` is the chat's raw pointer and `defaultId` the active preset, so a client tells set-here from inherited
presetsRouter.get('/resolve', (req, res) => {
    const chatId = req.query.chatId ? String(req.query.chatId) : null;
    const wanted = req.query.with;
    if (wanted !== undefined && wanted !== 'preset') return res.status(400).json({ error: "with is 'preset'" });
    const resolved = resolveChatPreset(req.db, chatId);
    // the preset in force beside its id, so a client shows it in the one request
    if (wanted) resolved.preset = resolved.presetId ? getPreset(req.db, resolved.presetId) : null;
    res.json(resolved);
});

// the preset as a SillyTavern preset file, with what the file cannot say named beside it
presetsRouter.get('/:id/export', (req, res) => {
    const format = String(req.query.format || 'sillytavern');
    if (format !== 'sillytavern') return res.status(400).json({ error: "format is 'sillytavern'" });
    const preset = getPreset(req.db, req.params.id);
    if (!preset) return res.status(404).json({ error: 'preset not found' });
    const scripts = listScripts(req.db, preset.id).map(({ id, ...script }) => ({ id, ...script }));
    res.json(exportSillyTavernPreset(preset, scripts));
});

presetsRouter.get('/:id', (req, res) => {
    const preset = getPreset(req.db, req.params.id);
    if (!preset) return res.status(404).json({ error: 'preset not found' });
    res.json(preset);
});

presetsRouter.patch('/:id', (req, res) => {
    const patch = {};
    if (req.body?.name !== undefined) {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        if (!name) return res.status(400).json({ error: 'name cannot be blank' });
        patch.name = name;
    }
    if (req.body?.blocks !== undefined) {
        const err = validateBlocks(req.body.blocks);
        if (err) return res.status(400).json({ error: err });
        patch.blocks = req.body.blocks;
    }
    if (req.body?.settings !== undefined) {
        const settingsErr = settingsError(req.body.settings);
        if (settingsErr) return res.status(400).json({ error: settingsErr });
        patch.settings = req.body.settings;
    }
    const preset = updatePreset(req.db, req.params.id, patch);
    if (!preset) return res.status(404).json({ error: 'preset not found' });
    res.json(preset);
});

presetsRouter.delete('/:id', (req, res) => {
    if (!deletePreset(req.db, req.params.id)) return res.status(404).json({ error: 'preset not found' });
    res.json({ ok: true });
});
