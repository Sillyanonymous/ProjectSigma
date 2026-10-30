import Database from 'better-sqlite3';
import { emitChange, runWithRequest } from './changes.js';
// app_store: one key, one JSON document under CHECK (json_valid); read back as the stored text, no re-stringify

export const DOCUMENT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function isDocumentKey(key) {
    return typeof key === 'string' && DOCUMENT_KEY_RE.test(key);
}

/** The stored JSON text, or null when the key has no document. */
export function readDocumentText(db, key) {
    return db.prepare('SELECT value FROM app_store WHERE key = ?').get(key)?.value ?? null;
}

/** The parsed document, or the fallback when absent. */
export function readDocument(db, key, fallback = null) {
    const text = readDocumentText(db, key);
    if (text === null) return fallback;
    try { return JSON.parse(text); } catch { return fallback; }
}

/** A document read straight off a library file (no migrations, no handle kept); null when anything is absent or unreadable. */
export function readDocumentFromFile(dbFile, key) {
    let db = null;
    try {
        db = new Database(dbFile, { readonly: true, fileMustExist: true });
        return readDocument(db, key);
    } catch {
        return null;
    } finally {
        db?.close();
    }
}

/** Replace the whole document (any JSON value). */
export function writeDocument(db, key, value) {
    return db.transaction(() => {
        db.prepare(`
            INSERT INTO app_store (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(key, JSON.stringify(value), Date.now());
        emitChange(db, { entity: 'document', op: 'updated', ids: [key] });
    })();
}

/** @returns {boolean} whether a document was there to delete */
export function deleteDocument(db, key) {
    return db.transaction(() => {
        const gone = db.prepare('DELETE FROM app_store WHERE key = ?').run(key).changes > 0;
        if (gone) emitChange(db, { entity: 'document', op: 'deleted', ids: [key] });
        return gone;
    })();
}

// ========================================
// THE SAVED FILTER PRESETS
// ========================================

// the one document the server reads: its rules name tags and lorebooks, so their renames and deletes follow it
export const FILTER_PRESETS_KEY = 'filter-presets';
export const PRESET_TAG_FIELDS = Object.freeze(['tags', 'charTags']);
export const PRESET_LOREBOOK_FIELDS = Object.freeze(['linkedLorebook', 'chatLorebook']);
// SQLite's NOCASE, the rule the engine compares those names by: ASCII letters fold, nothing else
const nocase = (s) => String(s).replace(/[A-Z]/g, c => c.toLowerCase());
const PRESET_LISTS = Object.freeze(['char', 'chat']);

function noteRemoved(preset, field, operator, value) {
    preset.removed = [...(Array.isArray(preset.removed) ? preset.removed : []), { field, operator, value }];
}

/**
 * Rewrite every saved preset rule naming name: renamed to `to`, or moved to its preset's removed list on null.
 * @param {string[]} fields PRESET_TAG_FIELDS or PRESET_LOREBOOK_FIELDS
 * @param {string|null} to
 * @param {((change: {list: string, uid: string, field: string, operator: string, at: number, from: string|null, to: string|null}) => void)|null} [journal] hears each rule rewritten, `at` its place after the rewrite
 * @returns {number} the rules rewritten
 */
export function rewritePresetRules(db, fields, name, to, journal = null) {
    if (!db.inTransaction) throw new Error('rewritePresetRules runs inside the transaction of the write it follows');
    const doc = readDocument(db, FILTER_PRESETS_KEY);
    if (!doc || typeof doc !== 'object') return 0;
    const old = nocase(name);
    let rewritten = 0;
    for (const list of PRESET_LISTS) {
        for (const preset of Array.isArray(doc[list]) ? doc[list] : []) {
            if (!preset || !Array.isArray(preset.rules)) continue;
            const kept = [];
            for (const rule of preset.rules) {
                if (!rule || !fields.includes(rule.field) || typeof rule.value !== 'string' || nocase(rule.value) !== old) { kept.push(rule); continue; }
                rewritten++;
                // a preset with no uid cant be found again, so its rewrite has no undo to journal
                if (journal && typeof preset.uid === 'string' && preset.uid) {
                    journal({ list, uid: preset.uid, field: rule.field, operator: rule.operator, at: kept.length, from: rule.value, to });
                }
                if (to !== null) { rule.value = to; kept.push(rule); } else noteRemoved(preset, rule.field, rule.operator, rule.value);
            }
            preset.rules = kept;
        }
    }
    if (rewritten) runWithRequest({ clientId: null }, () => writeDocument(db, FILTER_PRESETS_KEY, doc));
    return rewritten;
}

// one rule from `was` to `now` (null: absent), only where the preset still holds `was`, its own place first
function changePresetRule(preset, { field, operator, at, was, now }) {
    const rules = preset.rules;
    const alike = (r) => r && r.field === field && r.operator === operator && typeof r.value === 'string';
    if (was === null) {
        // a rule coming back never doubles one the preset holds naming the same thing
        if (rules.some(r => alike(r) && nocase(r.value) === nocase(now))) return -1;
        const place = Math.min(Math.max(0, Number.isInteger(at) ? at : rules.length), rules.length);
        rules.splice(place, 0, { field, operator, value: now });
        if (Array.isArray(preset.removed)) {
            const noted = preset.removed.findIndex(r => r && r.field === field && r.operator === operator && r.value === now);
            if (noted >= 0) preset.removed.splice(noted, 1);
            if (!preset.removed.length) delete preset.removed;
        }
        return place;
    }
    const holds = (r) => alike(r) && r.value === was;
    const place = Number.isInteger(at) && holds(rules[at]) ? at : rules.findIndex(holds);
    if (place < 0) return -1;
    if (now === null) {
        rules.splice(place, 1);
        noteRemoved(preset, field, operator, was);
    } else rules[place].value = now;
    return place;
}

/**
 * Put back what a run's rewrites changed, newest first, each only where its preset still holds what the rewrite left.
 * @param {Array<{list: string, uid: string, field: string, operator: string, at: number, from: string|null, to: string|null}>} changes as rewritePresetRules journaled them, oldest first
 * @param {Function|null} [journal] hears each change put back, in rewritePresetRules' shape
 * @returns {number} the rules put back
 */
export function restorePresetRules(db, changes, journal = null) {
    if (!db.inTransaction) throw new Error('restorePresetRules runs inside the transaction of the undo it ends');
    if (!Array.isArray(changes) || !changes.length) return 0;
    const doc = readDocument(db, FILTER_PRESETS_KEY);
    if (!doc || typeof doc !== 'object') return 0;
    let restored = 0;
    for (const c of [...changes].reverse()) {
        if (!c || !PRESET_LISTS.includes(c.list) || typeof c.uid !== 'string' || !c.uid) continue;
        const preset = (Array.isArray(doc[c.list]) ? doc[c.list] : []).find(p => p && p.uid === c.uid && Array.isArray(p.rules));
        if (!preset) continue;
        const at = changePresetRule(preset, { field: c.field, operator: c.operator, at: c.at, was: c.to, now: c.from });
        if (at < 0) continue;
        restored++;
        journal?.({ list: c.list, uid: c.uid, field: c.field, operator: c.operator, at, from: c.to, to: c.from });
    }
    if (restored) runWithRequest({ clientId: null }, () => writeDocument(db, FILTER_PRESETS_KEY, doc));
    return restored;
}
