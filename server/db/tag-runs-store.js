import { emitChange } from './changes.js';
import { httpError } from '../lib/http-error.js';
// the bulk tag-run undo journal: the links a tag op or job moved, the newest TAG_RUN_KEEP kept

// an undo reaches the newest run alone, so an older one would be kept for nothing
export const TAG_RUN_KEEP = 1;

// per library, the runs an undo is still reading: a prune passes over them until it ends
const _held = new WeakMap();

// the runs past the keep are siblings of the run that pushed them out, so their leaving is its own record
function pruneTagRuns(db) {
    const held = JSON.stringify([..._held.get(db) || []]);
    const pruned = db.prepare(`DELETE FROM tag_runs WHERE id NOT IN (SELECT id FROM tag_runs ORDER BY id DESC LIMIT ?)
        AND id NOT IN (SELECT value FROM json_each(?)) RETURNING id`).all(TAG_RUN_KEEP, held).map(r => r.id);
    if (pruned.length) emitChange(db, { entity: 'tagRun', op: 'deleted', ids: pruned });
}

/**
 * Keep a run through the undo that reads it, though the undo's own run pushes it past the keep.
 * @returns {() => void} the release, run when the undo ends: the run then goes with the keep
 */
export function holdTagRun(db, id) {
    if (!_held.has(db)) _held.set(db, new Set());
    _held.get(db).add(id);
    return () => {
        _held.get(db)?.delete(id);
        db.transaction(() => pruneTagRuns(db))();
    };
}

const SUMMARY_SQL = `
    SELECT r.id, r.ts, r.label, r.kind,
           (SELECT COUNT(*) FROM json_each(r.ops) o WHERE json_extract(o.value, '$.list') IS NOT NULL) AS op_count,
           (SELECT COUNT(*) FROM tag_run_links l WHERE l.run_id = r.id) AS link_count
    FROM tag_runs r`;
const summary = (r) => ({ id: r.id, ts: r.ts, label: r.label, kind: r.kind, opCount: r.op_count, linkCount: r.link_count });

/** Newest first; a run's opCount is its preset rewrites alone. */
export function listTagRuns(db) {
    return db.prepare(`${SUMMARY_SQL} ORDER BY r.id DESC`).all().map(summary);
}

/** One run's summary: its links can be a million rows, and the server undoes them, so they are never listed. */
export function getTagRun(db, id) {
    const r = db.prepare(`${SUMMARY_SQL} WHERE r.id = ?`).get(id);
    return r ? summary(r) : null;
}

/**
 * Open a links run, keeping the newest TAG_RUN_KEEP.
 * @returns {{ id: number }}
 */
export function createTagRun(db, { label } = {}) {
    if (typeof label !== 'string' || !label.trim()) throw httpError(400, 'label required');
    return db.transaction(() => {
        const id = Number(db.prepare("INSERT INTO tag_runs (ts, label, kind) VALUES (?, ?, 'links')").run(Date.now(), label.trim()).lastInsertRowid);
        emitChange(db, { entity: 'tagRun', op: 'created', ids: [id] });
        pruneTagRuns(db);
        return { id };
    })();
}

export function deleteTagRun(db, id) {
    return db.transaction(() => {
        const gone = db.prepare('DELETE FROM tag_runs WHERE id = ?').run(id).changes > 0;
        if (gone) emitChange(db, { entity: 'tagRun', op: 'deleted', ids: [id] });
        return gone;
    })();
}
