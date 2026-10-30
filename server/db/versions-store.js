import { emitChange } from './changes.js';
// Relational snapshot storage with the module's doc-shaped API composed on read.
// One row per snapshot; the single pre-restore backup slot is the snap_id -1 sentinel.

const BACKUP_ID = -1;
const AUTO_BACKUP = 'auto_backup';

// a snapshot id leaves the database, so its handed out once per character and never reused
function nextSnapId(db, charId) {
    const max = db.prepare("SELECT MAX(snap_id) AS m FROM versions WHERE char_id = ? AND snap_id >= 0 AND typeof(snap_id) = 'integer'").get(charId)?.m ?? 0;
    const last = db.prepare('SELECT last FROM version_seq WHERE char_id = ?').get(charId)?.last ?? 0;
    const next = Math.max(max, last) + 1;
    db.prepare('INSERT INTO version_seq (char_id, last) VALUES (?, ?) ON CONFLICT(char_id) DO UPDATE SET last = excluded.last').run(charId, next);
    return next;
}

export function composeCharVersionsDoc(db, charId) {
    const rows = db.prepare('SELECT * FROM versions WHERE char_id = ? ORDER BY snap_id').all(charId);
    if (!rows.length) return null;
    const char = db.prepare('SELECT name FROM characters WHERE id = ?').get(charId);
    const snapshots = [];
    let backup = null;
    for (const r of rows) {
        if (r.snap_id === BACKUP_ID) {
            backup = JSON.parse(r.data);
            continue;
        }
        snapshots.push({
            id: r.snap_id,
            label: r.label,
            source: r.source,
            timestamp: r.created_at,
            charName: r.char_name,
            data: JSON.parse(r.data),
        });
    }
    // no avatar field: a version's identity is the character's uuid
    return {
        name: char?.name || snapshots[snapshots.length - 1]?.charName || '',
        snapshots,
        backup,
    };
}

/** Append one snapshot under the next id; an auto snapshot identical to the newest isnt stored again, and autos past keepAutoBackups go. */
export function addCharSnapshot(db, charId, { label, source = 'local', charName = null, data }, { keepAutoBackups = 0 } = {}) {
    return db.transaction(() => {
        const json = JSON.stringify(data ?? {});
        if (source === AUTO_BACKUP) {
            const latest = db.prepare(`SELECT snap_id, data FROM versions WHERE char_id = ? AND snap_id >= 0 AND source = ? ORDER BY created_at DESC, snap_id DESC LIMIT 1`).get(charId, AUTO_BACKUP);
            if (latest && latest.data === json) return latest.snap_id;
        }
        const next = nextSnapId(db, charId);
        db.prepare(`
            INSERT INTO versions (char_id, snap_id, label, source, created_at, char_name, data)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(charId, next, label ?? null, source, Date.now(), charName, json);
        if (source === AUTO_BACKUP && keepAutoBackups > 0) {
            db.prepare(`
                DELETE FROM versions WHERE char_id = ? AND source = ? AND snap_id >= 0 AND snap_id NOT IN (
                    SELECT snap_id FROM versions WHERE char_id = ? AND source = ? AND snap_id >= 0 ORDER BY created_at DESC, snap_id DESC LIMIT ?)
            `).run(charId, AUTO_BACKUP, charId, AUTO_BACKUP, keepAutoBackups);
        }
        emitChange(db, { entity: 'version', op: 'updated', ids: [charId] });
        return next;
    })();
}

/** One snapshot's label changed. Answers whether the snapshot exists. */
export function renameCharSnapshot(db, charId, snapId, label) {
    return db.transaction(() => {
        const done = db.prepare('UPDATE versions SET label = ? WHERE char_id = ? AND snap_id = ? AND snap_id >= 0').run(label ?? null, charId, snapId).changes > 0;
        if (done) emitChange(db, { entity: 'version', op: 'updated', ids: [charId] });
        return done;
    })();
}

/** One snapshot gone. Answers whether it existed. */
export function deleteCharSnapshot(db, charId, snapId) {
    return db.transaction(() => {
        const done = db.prepare('DELETE FROM versions WHERE char_id = ? AND snap_id = ? AND snap_id >= 0').run(charId, snapId).changes > 0;
        if (done) emitChange(db, { entity: 'version', op: 'updated', ids: [charId] });
        return done;
    })();
}

/** The one pre-restore backup slot written ({ timestamp, data }), or cleared with null. */
export function setCharBackup(db, charId, backup) {
    db.transaction(() => {
        db.prepare('DELETE FROM versions WHERE char_id = ? AND snap_id = ?').run(charId, BACKUP_ID);
        if (backup) {
            db.prepare(`
                INSERT INTO versions (char_id, snap_id, label, source, created_at, char_name, data)
                VALUES (?, ?, NULL, '__backup__', ?, NULL, ?)
            `).run(charId, BACKUP_ID, backup.timestamp ?? Date.now(), JSON.stringify(backup));
        }
        emitChange(db, { entity: 'version', op: 'updated', ids: [charId] });
    })();
}

/** The ST migration's history merge: held snapshots stay, missing ones are added in file order, the backup slot filled only when empty. */
export function mergeCharVersionsDoc(db, charId, doc) {
    const out = { added: 0, held: 0, backup: false };
    db.transaction(() => {
        const timed = db.prepare('SELECT 1 FROM versions WHERE char_id = ? AND snap_id >= 0 AND created_at = ? AND data = ?');
        // a file snapshot with no time was stored at the first run's clock, so data and source find it
        const untimed = db.prepare('SELECT 1 FROM versions WHERE char_id = ? AND snap_id >= 0 AND source IS ? AND data = ?');
        const insert = db.prepare(`
            INSERT INTO versions (char_id, snap_id, label, source, created_at, char_name, data)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const s of (Array.isArray(doc?.snapshots) ? doc.snapshots : [])) {
            const json = JSON.stringify(s?.data ?? {});
            const at = Number.isFinite(s?.timestamp) ? s.timestamp : null;
            if (at !== null ? timed.get(charId, at, json) : untimed.get(charId, s?.source ?? null, json)) { out.held++; continue; }
            insert.run(charId, nextSnapId(db, charId), s?.label ?? null, s?.source ?? null, at ?? Date.now(), s?.charName ?? null, json);
            out.added++;
        }
        if (doc?.backup && !db.prepare('SELECT 1 FROM versions WHERE char_id = ? AND snap_id = ?').get(charId, BACKUP_ID)) {
            insert.run(charId, BACKUP_ID, null, '__backup__', doc.backup.timestamp ?? Date.now(), null, JSON.stringify(doc.backup));
            out.backup = true;
        }
        if (out.added || out.backup) emitChange(db, { entity: 'version', op: 'updated', ids: [charId] });
    })();
    return out;
}

export function deleteCharVersions(db, charId) {
    return db.transaction(() => {
        const gone = db.prepare('DELETE FROM versions WHERE char_id = ?').run(charId).changes > 0;
        if (gone) emitChange(db, { entity: 'version', op: 'deleted', ids: [charId] });
        return gone;
    })();
}
