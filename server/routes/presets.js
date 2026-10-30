import { Router } from 'express';
import {
    listPresets, getPreset, createPreset, updatePreset, deletePreset,
    getActivePresetId, setActivePreset, planStPresetImport, resolveChatPreset,
} from '../db/presets-store.js';
import { MARKERS, POSITIONS, DEFAULT_BLOCKS } from '../llm/preset.js';

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

// defaultBlocks rides along, sent rather than mirrored, so the client shows what actually runs
presetsRouter.get('/', (req, res) => {
    res.json({
        presets: listPresets(req.db),
        activeId: getActivePresetId(req.db),
        defaultBlocks: DEFAULT_BLOCKS.map(b => ({
            id: b.id, key: b.id, name: b.name ?? null, kind: b.kind, marker: b.marker,
            content: b.content, role: b.role, position: b.position,
            depth: b.depth ?? 0, enabled: !!b.enabled, pos: b.pos,
        })),
    });
});

presetsRouter.post('/', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name required' });
    if (req.body?.blocks !== undefined) {
        const err = validateBlocks(req.body.blocks);
        if (err) return res.status(400).json({ error: err });
    }
    res.json(createPreset(req.db, {
        name,
        blocks: req.body?.blocks,
    }));
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

    const preset = createPreset(req.db, {
        name: plan.name, source: 'sillytavern', blocks: plan.blocks,
    });
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
    res.json(resolveChatPreset(req.db, chatId));
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
    const preset = updatePreset(req.db, req.params.id, patch);
    if (!preset) return res.status(404).json({ error: 'preset not found' });
    res.json(preset);
});

presetsRouter.delete('/:id', (req, res) => {
    if (!deletePreset(req.db, req.params.id)) return res.status(404).json({ error: 'preset not found' });
    res.json({ ok: true });
});
