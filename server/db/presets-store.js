import crypto from 'node:crypto';
import { POSITIONS, DEFAULT_BLOCKS, DEFAULT_INJECTION_ORDER, normalizeTriggers, storablePromptSettings, promptSettingsOf } from '../llm/preset.js';
import { emitChange } from './changes.js';

// presets are uuid rows holding an ordered block list, prompt structure only: samplers and connection belong to llm_profiles

// the settings a preset stores, only the ones set (a build fills the rest from their defaults)
const settingsOf = (raw) => { try { return storablePromptSettings(JSON.parse(raw ?? 'null')); } catch { return {}; } };
// only what differs from a default is kept, so a default never set follows the app's
const settingsColumn = (value) => {
    const defaults = promptSettingsOf(null);
    const stored = Object.fromEntries(Object.entries(storablePromptSettings(value)).filter(([key, v]) => v !== defaults[key]));
    return Object.keys(stored).length ? JSON.stringify(stored) : null;
};

const mapPreset = (r, blocks) => ({
    id: r.id,
    name: r.name,
    source: r.source,
    settings: settingsOf(r.prompt_settings),
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
    triggers: normalizeTriggers(r.injection_trigger),
    enabled: !!r.enabled,
    pos: r.pos,
});

function blocksOf(db, presetId) {
    return db.prepare('SELECT * FROM preset_blocks WHERE preset_id = ? ORDER BY pos').all(presetId).map(mapBlock);
}

export function listPresets(db) {
    return db.prepare('SELECT * FROM presets ORDER BY name COLLATE NOCASE').all()
        .map(r => mapPreset(r, blocksOf(db, r.id)));
}

/** The presets as a picker lists them: a name and a block count each, no block text (getPreset reads one whole). */
export function listPresetRows(db) {
    return db.prepare(`SELECT p.id, p.name, p.source, p.created_at, p.updated_at,
            (SELECT COUNT(*) FROM preset_blocks b WHERE b.preset_id = p.id) AS block_count
        FROM presets p ORDER BY p.name COLLATE NOCASE`).all()
        .map(r => ({ id: r.id, name: r.name, source: r.source, createdAt: r.created_at, updatedAt: r.updated_at, blockCount: r.block_count }));
}

export function getPreset(db, id) {
    const row = db.prepare('SELECT * FROM presets WHERE id = ?').get(id);
    return row ? mapPreset(row, blocksOf(db, id)) : null;
}

const insertBlockSql = `INSERT INTO preset_blocks
    (id, preset_id, block_key, name, kind, marker, content, role, position, depth,
     injection_order, forbid_overrides, injection_trigger, enabled, pos)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// a block's triggers as stored: NULL for every type, so a list emptied in the editor stores nothing
const triggersColumn = (value) => {
    const list = normalizeTriggers(value);
    return list.length ? JSON.stringify(list) : null;
};

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
        triggersColumn(b.triggers),
        b.enabled === false || b.enabled === 0 ? 0 : 1,
        i,
        );
    });
}

// no blocks means the defaults: an empty preset assembles nothing
export function createPreset(db, { name, source = null, blocks = null, settings = null }) {
    const now = Date.now();
    const id = crypto.randomUUID();
    db.transaction(() => {
        db.prepare('INSERT INTO presets (id, name, source, prompt_settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(id, name, source, settingsColumn(settings), now, now);
        // the built-in blocks keep their keys, so a new preset's Main and Post-history still take the card's own texts
        writeBlocks(db, id, Array.isArray(blocks) && blocks.length ? blocks : DEFAULT_BLOCKS.map(b => ({ ...b, key: b.id })));
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
        // the settings replace whole, as the blocks do; one left out reads its default again
        if (patch.settings !== undefined) { sets.push('prompt_settings = ?'); args.push(settingsColumn(patch.settings)); }
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
