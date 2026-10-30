import { emitChange } from './changes.js';
// one row per key, JSON text; PATCH upserts only its keys, PUT is the one wholesale replace. single values read via settingValue

function upsertKeys(db, obj) {
    const stmt = db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    for (const [k, v] of Object.entries(obj)) stmt.run(k, JSON.stringify(v));
}

/** Every stored setting, parsed; a row that does not parse is skipped rather than answered as junk. */
export function getSettings(db) {
    const out = {};
    for (const row of db.prepare('SELECT key, value FROM settings').all()) {
        try { out[row.key] = JSON.parse(row.value); } catch { /* skipped */ }
    }
    return out;
}

/** Upsert the given keys only, in one transaction. */
export function patchSettings(db, obj) {
    db.transaction(() => {
        upsertKeys(db, obj);
        emitChange(db, { entity: 'setting', op: 'updated', ids: Object.keys(obj || {}) });
    })();
}

/** Replace the whole settings table with the given object, in one transaction. */
export function replaceSettings(db, obj) {
    db.transaction(() => {
        db.prepare('DELETE FROM settings').run();
        upsertKeys(db, obj);
        emitChange(db, { entity: 'setting', op: 'updated', all: true });
    })();
}

export function settingValue(db, key, fallback) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return fallback;
    try {
        const v = JSON.parse(row.value);
        return v === undefined || v === null || v === '' ? fallback : v;
    } catch { return fallback; }
}
