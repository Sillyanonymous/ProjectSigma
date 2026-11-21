import { emitChange } from './changes.js';
import { encodeCursor, decodeCursor } from './cursor.js';
import { httpError } from '../lib/http-error.js';
import { setCharacterFlags } from './characters-store.js';
// the media download queue: one job per character (cascades with it), pending or active only; the client is the worker

export const MEDIA_JOB_STATUS = ['pending', 'active'];

// an active job is its worker's while it keeps touching the row; one past the lease is a dead worker's
export const MEDIA_JOB_LEASE_MS = 10 * 60 * 1000;
const isStale = (r, now = Date.now()) => r.status === 'active' && now - r.updated_at > MEDIA_JOB_LEASE_MS;
// leaseLeftMs counts on this clock, so a tab waiting out another worker's lease needs no agreement with it
const mapRow = (r, now = Date.now()) => ({
    id: r.id, charId: r.char_id, name: r.name, phases: r.phases ? JSON.parse(r.phases) : null, status: r.status, addedAt: r.added_at, updatedAt: r.updated_at,
    stale: isStale(r, now), leaseLeftMs: r.status === 'active' ? Math.max(0, r.updated_at + MEDIA_JOB_LEASE_MS - now) : null,
});

// listMediaJobsPage's walk, exported so its plan can be read: the queue by id, its rowid
export const MEDIA_JOBS_PAGE_SQL = {
    first: 'SELECT * FROM media_jobs ORDER BY id LIMIT ?',
    after: 'SELECT * FROM media_jobs WHERE id > ? ORDER BY id LIMIT ?',
};

/**
 * A page of the queue in id order past a cursor; ids narrows it, count: false skips the total.
 * @returns {{ items: object[], total: number|null, limit: number, nextCursor: string|null }}
 */
export function listMediaJobsPage(db, { limit, after, ids, count = true }) {
    const now = Date.now();
    let past;
    if (after !== undefined) {
        const cur = decodeCursor(after, 1, { intLast: true });
        if (!cur) throw httpError(400, 'invalid after cursor');
        past = cur[0];
    }
    let rows, total = null;
    if (ids) {
        const named = JSON.stringify(ids);
        rows = db.prepare(`SELECT * FROM media_jobs WHERE id IN (SELECT value FROM json_each(?))${past === undefined ? '' : ' AND id > ?'} ORDER BY id LIMIT ?`)
            .all(...(past === undefined ? [named, limit] : [named, past, limit]));
        if (count !== false) total = db.prepare('SELECT COUNT(*) n FROM media_jobs WHERE id IN (SELECT value FROM json_each(?))').get(named).n;
    } else {
        rows = past === undefined ? db.prepare(MEDIA_JOBS_PAGE_SQL.first).all(limit) : db.prepare(MEDIA_JOBS_PAGE_SQL.after).all(past, limit);
        if (count !== false) total = db.prepare('SELECT COUNT(*) n FROM media_jobs').get().n;
    }
    return { items: rows.map(r => mapRow(r, now)), total, limit, nextCursor: rows.length === limit ? encodeCursor([rows[rows.length - 1].id]) : null };
}

/** Enqueue the one job a character can hold: a pending one is superseded, an active one left to its worker. */
export function enqueueMediaJob(db, { charId, name, phases } = {}) {
    return db.transaction(() => {
        if (typeof charId !== 'string' || !charId || /\.png$/i.test(charId)) throw httpError(400, 'charId must be a character uuid');
        if (!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(charId)) throw httpError(404, 'character not found');
        if (phases !== undefined && phases !== null && !(Array.isArray(phases) && phases.every(p => typeof p === 'string'))) throw httpError(400, 'phases must be an array of strings');
        const now = Date.now();
        const wrote = db.prepare(`INSERT INTO media_jobs (char_id, name, phases, status, added_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)
            ON CONFLICT(char_id) DO UPDATE SET name = excluded.name, phases = excluded.phases, updated_at = excluded.updated_at
            WHERE media_jobs.status != 'active'`)
            .run(charId, typeof name === 'string' && name ? name : charId, Array.isArray(phases) ? JSON.stringify(phases) : null, now, now).changes;
        const row = db.prepare('SELECT * FROM media_jobs WHERE char_id = ?').get(charId);
        // an active job the conflict left alone was not written
        if (wrote) emitChange(db, { entity: 'mediaJob', op: 'updated', ids: [row.id], charId });
        return mapRow(row);
    })();
}

/**
 * The worker's claim and lease: { status } takes or hands back a job, { touch: true } renews; a live worker's job answers 'held'.
 * @returns {boolean|'held'} whether the row changed
 */
export function updateMediaJob(db, id, { status, touch } = {}) {
    return db.transaction(() => {
        const now = Date.now();
        if (touch === true) {
            const changed = db.prepare("UPDATE media_jobs SET updated_at = ? WHERE id = ? AND status = 'active'").run(now, id).changes > 0;
            if (changed) emitChange(db, { entity: 'mediaJob', op: 'updated', ids: [id], fields: ['updatedAt'] });
            return changed;
        }
        if (!MEDIA_JOB_STATUS.includes(status)) throw httpError(400, `status must be one of ${MEDIA_JOB_STATUS.join(', ')}`);
        const row = db.prepare('SELECT status, updated_at FROM media_jobs WHERE id = ?').get(id);
        if (!row) return false;
        if (status === 'active' && row.status === 'active' && !isStale(row, now)) return 'held';
        db.prepare('UPDATE media_jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
        emitChange(db, { entity: 'mediaJob', op: 'updated', ids: [id], fields: ['status'] });
        return true;
    })();
}

// a batch's chunk: the rows read past a rowid, then written in one transaction
const BATCH_CHUNK = 500;

/**
 * Queue a set's characters with a remote url or a provider link, one pending row each; rescan clears their processed mark.
 * @param {{ rowidSql?: string, params?: any[], whole?: boolean, less?: { base: object, gone: object } }} set a characterSetQuery set
 * @returns {Generator<undefined, { total: number, queued: number, noMedia: number, active: number }>}
 */
export function* enqueueMediaJobsSteps(db, set, { rescan = true } = {}) {
    let inSet = '1', params = [];
    if (set.less) {
        inSet = `(c.rowid IN (${set.less.base.rowidSql}) AND c.rowid NOT IN (${set.less.gone.rowidSql}))`;
        params = [...set.less.base.params, ...set.less.gone.params];
    } else if (!set.whole) {
        inSet = `c.rowid IN (${set.rowidSql})`;
        params = [...set.params];
    }
    const fresh = rescan ? '' : ' AND c.media_localized = 0';
    const total = db.prepare(`SELECT COUNT(*) n FROM characters c WHERE ${inSet}${fresh}`).get(...params).n;
    // the same rule the scan reads: a remote url anywhere in the card, or a provider page whose gallery it fetches
    const page = db.prepare(`SELECT c.rowid AS rid, c.id, c.name, j.status FROM characters c LEFT JOIN media_jobs j ON j.char_id = c.id
        WHERE ${inSet}${fresh} AND c.rowid > ? AND (c.card LIKE '%http%' OR EXISTS (SELECT 1 FROM provider_links pl WHERE pl.char_id = c.id))
        ORDER BY c.rowid LIMIT ?`);
    const insert = db.prepare(`INSERT INTO media_jobs (char_id, name, phases, status, added_at, updated_at) VALUES (?, ?, NULL, 'pending', ?, ?)
        ON CONFLICT(char_id) DO NOTHING RETURNING id`);
    let queued = 0, active = 0, candidates = 0, past = 0;
    for (;;) {
        const rows = page.all(...params, past, BATCH_CHUNK);
        if (!rows.length) break;
        past = rows[rows.length - 1].rid;
        candidates += rows.length;
        db.transaction(() => {
            const now = Date.now();
            const made = [], scan = [];
            for (const r of rows) {
                if (r.status === 'active') { active++; continue; }
                queued++;
                scan.push(r.id);
                if (r.status === 'pending') continue;
                const row = insert.get(r.id, r.name || r.id, now, now);
                if (row) made.push(row.id);
            }
            if (made.length) emitChange(db, { entity: 'mediaJob', op: 'updated', ids: made });
            // a fresh scan: the mark goes for the queued and comes back as each one finishes
            if (rescan && scan.length) setCharacterFlags(db, { ids: scan }, { mediaLocalized: false });
        })();
        yield;
    }
    return { total, queued, noMedia: total - candidates, active };
}

export function removeMediaJob(db, id) {
    return db.transaction(() => {
        const gone = db.prepare('DELETE FROM media_jobs WHERE id = ?').run(id).changes > 0;
        if (gone) emitChange(db, { entity: 'mediaJob', op: 'deleted', ids: [id] });
        return gone;
    })();
}
