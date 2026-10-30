import { emitChange, reportCharactersUpdated } from './changes.js';
import { createTagRun } from './tag-runs-store.js';
import { tagIds } from './tag-links.js';
import { restorePresetRules } from './documents-store.js';
import { httpError } from '../lib/http-error.js';
// a tag job's writes, a chunk at a time over its fixed set, each chunk its own transaction journaled in the job's links run

function ensureRun(db, state, label) {
    if (state.runId == null) state.runId = createTagRun(db, { label }).id;
    return state.runId;
}

/**
 * The journal a run's moves go through, the run made with the first move; a link moved back cancels out of it.
 * @returns {(charId: string, tag: string, added: 0|1, pos?: number|null) => void}
 */
export function linkJournal(db, state, label) {
    const prior = db.prepare('SELECT added FROM tag_run_links WHERE run_id = ? AND char_id = ? AND tag = ?');
    const drop = db.prepare('DELETE FROM tag_run_links WHERE run_id = ? AND char_id = ? AND tag = ?');
    const put = db.prepare('INSERT OR REPLACE INTO tag_run_links (run_id, char_id, tag, added, pos) VALUES (?, ?, ?, ?, ?)');
    return (charId, tag, added, pos = null) => {
        // the journal is written beside the move it records, in the caller's own transaction
        if (!db.inTransaction) throw new Error('a run journal writes inside its caller\'s transaction');
        const run = ensureRun(db, state, label);
        const was = prior.get(run, charId, tag);
        if (was && was.added !== added) drop.run(run, charId, tag);
        else put.run(run, charId, tag, added, pos);
    };
}

/**
 * The journal a run's ops go through, in order, the run made with the first: its preset rewrites and its tag ops.
 * @returns {(entry: object) => void} rewritePresetRules' journal, and a rename's or a remove's
 */
export function opsJournal(db, state, label) {
    const append = db.prepare("UPDATE tag_runs SET ops = json_insert(ops, '$[#]', json(?)) WHERE id = ?");
    return (entry) => {
        // written beside the write it records, in the caller's own transaction, as a link is
        if (!db.inTransaction) throw new Error('a run journal writes inside its caller\'s transaction');
        append.run(JSON.stringify(entry), ensureRun(db, state, label));
    };
}

// each tag op said the other way: a rename back, a merge's source split out, a deleted tag restored, and back again
const TAG_OP_INVERSE = Object.freeze({ rename: 'rename', merge: 'split', split: 'merge', delete: 'restore', restore: 'delete' });

/**
 * The run a rename or remove journals into: a new one under its label, or the newest links run when it names one.
 * @returns {{ runId: number|null, label: string }}
 */
export function opRunState(db, run) {
    if (!run || typeof run !== 'object') throw httpError(400, 'run required: { label } to open one, { id } to join the newest');
    if (run.id != null) {
        const newest = db.prepare('SELECT id, kind, label FROM tag_runs ORDER BY id DESC LIMIT 1').get();
        if (!newest || newest.id !== Number(run.id) || newest.kind !== 'links') {
            throw httpError(409, 'only the newest run can be joined');
        }
        return { runId: newest.id, label: newest.label };
    }
    const label = typeof run.label === 'string' ? run.label.trim().slice(0, 120) : '';
    if (!label) throw httpError(400, 'a run needs its label');
    return { runId: null, label };
}

/**
 * One chunk of a by-filter write: add names linked after each character's tags, then remove names unlinked, all journaled.
 * @returns {{ changed: string[], added: Object<string, number>, removed: Object<string, number> }}
 */
export function applyTagChunk(db, state, { label, charIds, add, remove }) {
    const added = {}, removed = {};
    const changed = new Set();
    db.transaction(() => {
        const ids = JSON.stringify(charIds);
        const tags = tagIds(db);
        // a character deleted since is passed over: its link fails the FK, which OR IGNORE doesnt cover, rolling back the chunk
        const link = db.prepare(`INSERT OR IGNORE INTO char_tags (char_id, tag_id, pos)
            SELECT s.value, ?, (SELECT COALESCE(MAX(ct.pos), -1) + 1 FROM char_tags ct WHERE ct.char_id = s.value)
            FROM json_each(?) s JOIN characters c ON c.id = s.value
            RETURNING char_id`);
        const unlink = db.prepare('DELETE FROM char_tags WHERE tag_id = ? AND char_id IN (SELECT value FROM json_each(?)) RETURNING char_id, pos');
        const journal = linkJournal(db, state, label);
        for (const name of add) {
            const tagId = tags.mint(name);
            const rows = link.all(tagId, ids);
            for (const r of rows) { journal(r.char_id, name, 1); changed.add(r.char_id); }
            added[name] = rows.length;
        }
        for (const name of remove) {
            const tagId = tags.find(name);
            const rows = tagId == null ? [] : unlink.all(tagId, ids);
            for (const r of rows) { journal(r.char_id, name, 0, r.pos); changed.add(r.char_id); }
            removed[name] = rows.length;
        }
        if (changed.size) reportCharactersUpdated(db, [...changed], ['tags']);
    })();
    return { changed: [...changed], added, removed };
}

/** How many links a run journaled. */
export function countRunLinks(db, runId) {
    return db.prepare('SELECT COUNT(*) n FROM tag_run_links WHERE run_id = ?').get(runId).n;
}

/** A page of a run's links of one direction (added 1 or 0) after a (char_id, tag) position, in key order. */
export function runLinksChunk(db, runId, after, limit, { added } = {}) {
    const dir = added ? 1 : 0;
    const rows = after
        ? db.prepare('SELECT char_id, tag, added, pos FROM tag_run_links WHERE run_id = ? AND added = ? AND (char_id, tag) > (?, ?) ORDER BY char_id, tag LIMIT ?').all(runId, dir, after.charId, after.tag, limit)
        : db.prepare('SELECT char_id, tag, added, pos FROM tag_run_links WHERE run_id = ? AND added = ? ORDER BY char_id, tag LIMIT ?').all(runId, dir, limit);
    const last = rows[rows.length - 1];
    return { rows, last: last ? { charId: last.char_id, tag: last.tag } : null };
}

/**
 * One chunk of an undo, journaled in its own run: added links come off, removed ones go back where they stood.
 * @returns {{ changed: string[], restored: number, removed: number }}
 */
export function undoLinksChunk(db, state, { label, rows }) {
    const changed = new Set();
    let restored = 0, removed = 0;
    db.transaction(() => {
        const tags = tagIds(db);
        const held = db.prepare('SELECT 1 FROM characters WHERE id = ?');
        const link = db.prepare(`INSERT OR IGNORE INTO char_tags (char_id, tag_id, pos)
            VALUES (?, ?, COALESCE(?, (SELECT COALESCE(MAX(pos), -1) + 1 FROM char_tags WHERE char_id = ?)))`);
        const unlink = db.prepare('DELETE FROM char_tags WHERE char_id = ? AND tag_id = ? RETURNING pos');
        const journal = linkJournal(db, state, label);
        for (const r of rows) {
            if (r.added) {
                const tagId = tags.find(r.tag);
                const gone = tagId == null ? null : unlink.get(r.char_id, tagId);
                if (!gone) continue;
                journal(r.char_id, r.tag, 0, gone.pos);
                removed++;
            } else {
                if (!held.get(r.char_id)) continue;
                const tagId = tags.mint(r.tag);
                if (!link.run(r.char_id, tagId, r.pos ?? null, r.char_id).changes) continue;
                journal(r.char_id, r.tag, 1);
                restored++;
            }
            changed.add(r.char_id);
        }
        if (changed.size) reportCharactersUpdated(db, [...changed], ['tags']);
    })();
    return { changed: [...changed], restored, removed };
}

/**
 * An undo's last step, once every link is back: the preset rules its run rewrote are put back, journaled in the undo's run.
 * @returns {number} the rules put back
 */
export function undoPresetChunk(db, state, { label, runId }) {
    return db.transaction(() => {
        const ops = db.prepare("SELECT ops FROM tag_runs WHERE id = ? AND kind = 'links'").get(runId)?.ops;
        return restorePresetRules(db, ops ? JSON.parse(ops) : [], opsJournal(db, state, label));
    })();
}

/**
 * An undo's last step: its run's tag ops said back newest first, each moved name reported as the op reported it.
 * @returns {Array<{from: string, to: string|null}>} the names moved, a null to a name that went
 */
export function undoTagOps(db, state, { label, runId }) {
    return db.transaction(() => {
        const ops = db.prepare("SELECT ops FROM tag_runs WHERE id = ? AND kind = 'links'").get(runId)?.ops;
        const journal = opsJournal(db, state, label);
        const moved = [];
        for (const op of (ops ? JSON.parse(ops) : []).filter(o => Object.hasOwn(TAG_OP_INVERSE, o?.tag) && typeof o.from === 'string').reverse()) {
            const back = op.tag === 'rename' ? { tag: 'rename', from: op.to, to: op.from } : { tag: TAG_OP_INVERSE[op.tag], from: op.from, to: op.to ?? null };
            journal(back);
            // a split or a restore brings a name back beside the rest: its characters' records carry it, no rule moves
            if (back.tag === 'rename') emitChange(db, { entity: 'tag', op: 'updated', ids: [back.from], to: back.to });
            else if (back.tag === 'merge') emitChange(db, { entity: 'tag', op: 'deleted', ids: [back.from], to: back.to });
            else if (back.tag === 'delete') emitChange(db, { entity: 'tag', op: 'deleted', ids: [back.from] });
            else continue;
            moved.push({ from: back.from, to: back.tag === 'delete' ? null : back.to });
        }
        return moved;
    })();
}
