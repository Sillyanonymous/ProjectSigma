import crypto from 'node:crypto';
import { POSITIONS, DEFAULT_BLOCKS, DEFAULT_INJECTION_ORDER } from '../llm/preset.js';
import { emitChange } from './changes.js';

// presets are uuid rows holding an ordered block list, prompt structure only: samplers and connection belong to llm_profiles

const mapPreset = (r, blocks) => ({
    id: r.id,
    name: r.name,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    blocks,
});

const mapBlock = r => ({
    id: r.id,
    key: r.block_key,
    name: r.name,
    kind: r.kind,
    marker: r.marker,
    content: r.content,
    role: r.role,
    position: r.position,
    depth: r.depth,
    injectionOrder: r.injection_order ?? DEFAULT_INJECTION_ORDER,
    forbidOverrides: !!r.forbid_overrides,
    enabled: !!r.enabled,
    pos: r.pos,
});

/** The stored block rows of a preset in order, unmapped (the assembly reads the columns). */
export function presetBlockRows(db, presetId) {
    return db.prepare('SELECT * FROM preset_blocks WHERE preset_id = ? ORDER BY pos').all(presetId);
}

function blocksOf(db, presetId) {
    return presetBlockRows(db, presetId).map(mapBlock);
}

export function listPresets(db) {
    return db.prepare('SELECT * FROM presets ORDER BY name COLLATE NOCASE').all()
        .map(r => mapPreset(r, blocksOf(db, r.id)));
}

export function getPreset(db, id) {
    const row = db.prepare('SELECT * FROM presets WHERE id = ?').get(id);
    return row ? mapPreset(row, blocksOf(db, id)) : null;
}

const insertBlockSql = `INSERT INTO preset_blocks
    (id, preset_id, block_key, name, kind, marker, content, role, position, depth,
     injection_order, forbid_overrides, enabled, pos)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Replace the block list whole (order is the data), reusing a block id the caller sends back so UI state keyed on it survives. */
function writeBlocks(db, presetId, blocks) {
    const known = new Set(
        db.prepare('SELECT id FROM preset_blocks WHERE preset_id = ?').all(presetId).map(r => r.id),
    );
    db.prepare('DELETE FROM preset_blocks WHERE preset_id = ?').run(presetId);
    const stmt = db.prepare(insertBlockSql);
    const used = new Set();
    blocks.forEach((b, i) => {
        let id = typeof b.id === 'string' && known.has(b.id) && !used.has(b.id) ? b.id : crypto.randomUUID();
        used.add(id);
        stmt.run(
        id, presetId, b.key ?? null,
        typeof b.name === 'string' && b.name.trim() ? b.name.trim() : null,
        b.kind === 'marker' ? 'marker' : 'text',
        b.kind === 'marker' ? b.marker : null,
        typeof b.content === 'string' ? b.content : '',
        b.role || 'system',
        POSITIONS.includes(b.position) ? b.position : 'pre_history',
        Number.isInteger(b.depth) ? Math.max(b.depth, 0) : 0,
        Number.isInteger(b.injectionOrder) ? b.injectionOrder : DEFAULT_INJECTION_ORDER,
        b.forbidOverrides ? 1 : 0,
        b.enabled === false || b.enabled === 0 ? 0 : 1,
        i,
        );
    });
}

// no blocks means the defaults: an empty preset assembles nothing
export function createPreset(db, { name, source = null, blocks = null }) {
    const now = Date.now();
    const id = crypto.randomUUID();
    db.transaction(() => {
        db.prepare('INSERT INTO presets (id, name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run(id, name, source, now, now);
        writeBlocks(db, id, Array.isArray(blocks) && blocks.length ? blocks : DEFAULT_BLOCKS);
        emitChange(db, { entity: 'preset', op: 'created', ids: [id] });
    })();
    return getPreset(db, id);
}

export function updatePreset(db, id, patch) {
    const existing = getPreset(db, id);
    if (!existing) return null;
    db.transaction(() => {
        const sets = [];
        const args = [];
        if (patch.name !== undefined) { sets.push('name = ?'); args.push(patch.name); }
        if (sets.length) {
            sets.push('updated_at = ?');
            args.push(Date.now(), id);
            db.prepare(`UPDATE presets SET ${sets.join(', ')} WHERE id = ?`).run(...args);
        }
        // Blocks replace wholesale when supplied, because order IS the data: a
        // per-block patch would need an ordering protocol nobody asked for.
        if (Array.isArray(patch.blocks)) writeBlocks(db, id, patch.blocks);
        emitChange(db, { entity: 'preset', op: 'updated', ids: [id], fields: Object.keys(patch) });
    })();
    return getPreset(db, id);
}

export function deletePreset(db, id) {
    const existing = getPreset(db, id);
    if (!existing) return false;
    db.transaction(() => {
        db.prepare('DELETE FROM presets WHERE id = ?').run(id);
        if (readActiveId(db) === id) {
            db.prepare('DELETE FROM settings WHERE key = ?').run('activePresetId');
            emitChange(db, { entity: 'setting', op: 'updated', ids: ['activePresetId'] });
        }
        emitChange(db, { entity: 'preset', op: 'deleted', ids: [id] });
    })();
    return true;
}

function readActiveId(db) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('activePresetId');
    try { const v = JSON.parse(row?.value ?? 'null'); return typeof v === 'string' ? v : null; } catch { return null; }
}

export function getActivePresetId(db) {
    const id = readActiveId(db);
    if (!id) return null;
    return db.prepare('SELECT 1 FROM presets WHERE id = ?').get(id) ? id : null;
}

/**
 * Which preset builds a chat's prompt: its own, else the active one, else none (the built-in blocks).
 * @param {string|null} chatId null resolves the default
 * @returns {{ presetId: string|null, source: 'chat'|'default'|'builtin', override: string|null, defaultId: string|null }}
 */
export function resolveChatPreset(db, chatId) {
    const override = chatId ? (db.prepare('SELECT preset_id FROM chats WHERE id = ?').get(chatId)?.preset_id ?? null) : null;
    const defaultId = getActivePresetId(db);
    if (override && db.prepare('SELECT 1 FROM presets WHERE id = ?').get(override)) {
        return { presetId: override, source: 'chat', override, defaultId };
    }
    return { presetId: defaultId, source: defaultId ? 'default' : 'builtin', override, defaultId };
}

export function setActivePreset(db, id) {
    return db.transaction(() => {
        if (id === null) {
            db.prepare('DELETE FROM settings WHERE key = ?').run('activePresetId');
            emitChange(db, { entity: 'setting', op: 'updated', ids: ['activePresetId'] });
            return null;
        }
        if (!db.prepare('SELECT 1 FROM presets WHERE id = ?').get(id)) return null;
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('activePresetId', JSON.stringify(id));
        emitChange(db, { entity: 'setting', op: 'updated', ids: ['activePresetId'] });
        return id;
    })();
}

// ---------------------------------------------------------------------------
// SillyTavern chat-completion preset import
// ---------------------------------------------------------------------------

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
 * @returns {{name, blocks, report: {droppedConnection: string[], droppedSamplers: string[], droppedUnknown: string[], unknownBlocks: string[], notes: string[]}}}
 */
export function planStPresetImport(doc, fallbackName = 'Imported preset') {
    const report = { droppedConnection: [], droppedSamplers: [], droppedUnknown: [], unknownBlocks: [], notes: [] };

    for (const [key, value] of Object.entries(doc || {})) {
        if (key === 'prompts' || key === 'prompt_order') continue;
        if (isConnectionKey(key)) { report.droppedConnection.push(key); continue; }
        if (ST_SAMPLER_KEYS.has(key)) { report.droppedSamplers.push(key); continue; }
        report.droppedUnknown.push(key);
        void value;
    }
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

    const blocks = [];
    for (const entry of order) {
        const id = entry?.identifier;
        if (!id) continue;
        const prompt = byIdentifier.get(id);
        if (!prompt) { report.unknownBlocks.push(id); continue; }
        const enabled = entry.enabled !== false;
        const marker = ST_MARKER_MAP[id];

        if (marker) {
            blocks.push({ key: id, name: prompt.name || null, kind: 'marker', marker, content: '', role: prompt.role || 'system', position: 'pre_history', enabled });
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
            position: absolute ? 'at_depth' : (id === 'jailbreak' ? 'post_history' : 'pre_history'),
            depth: absolute && Number.isInteger(prompt.injection_depth) ? Math.max(prompt.injection_depth, 0) : 0,
            injectionOrder: Number.isInteger(prompt.injection_order) ? prompt.injection_order : DEFAULT_INJECTION_ORDER,
            forbidOverrides: prompt.forbid_overrides === true,
            enabled,
        });
    }

    const name = typeof doc?.name === 'string' && doc.name.trim() ? doc.name.trim() : fallbackName;
    return { name, blocks, report };
}
