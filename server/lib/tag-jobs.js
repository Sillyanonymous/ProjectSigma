// A by-filter tag write and its undo as set jobs, journaling every link moved for the undo
import { startSetJob } from './set-jobs.js';
import { applyTagChunk, countRunLinks, runLinksChunk, undoLinksChunk, undoPresetChunk, undoTagOps } from '../db/tag-jobs-store.js';
import { holdTagRun } from '../db/tag-runs-store.js';

export const TAG_JOB_CHUNK = 1000;
// the kinds a tag job runs as: an undo waits for neither to end, a delete or a favourite does not hold it
export const TAG_JOB_KINDS = Object.freeze(['apply', 'undo']);

/**
 * Add and remove tag names on every character a set query answers, a chunk at a time.
 * @returns the job as the route answers it
 */
export function startApplyJob(db, set, { add, remove, origin }) {
    const label = `Batch tags: ${[...add.map(n => `+${n}`), ...remove.map(n => `-${n}`)].join(' ')}`.slice(0, 120);
    const state = { runId: null, changed: 0, added: Object.fromEntries(add.map(n => [n, 0])), removed: Object.fromEntries(remove.map(n => [n, 0])) };
    // the set is fixed before any name is written: a filter that reads the tags would move under the job
    return startSetJob(db, {
        kind: 'apply', label, origin, set,
        step(job, next) {
            const ids = next(TAG_JOB_CHUNK);
            if (!ids.length) return false;
            const moved = applyTagChunk(db, state, { label, charIds: ids, add, remove });
            state.changed += moved.changed.length;
            for (const [n, c] of Object.entries(moved.added)) state.added[n] += c;
            for (const [n, c] of Object.entries(moved.removed)) state.removed[n] += c;
            job.done += ids.length;
            return true;
        },
        // an empty set answers no names, as nothing was asked of any character
        settle: (job) => ({
            changed: state.changed, runId: state.runId,
            added: job.total ? Object.entries(state.added).map(([name, count]) => ({ name, count })) : [],
            removed: job.total ? Object.entries(state.removed).map(([name, count]) => ({ name, count })) : [],
        }),
    });
}

/** Revert a links run: the links it added come off, the ones it removed go back, then its preset rules and tag ops, journaled again. */
export function startUndoJob(db, run, { origin }) {
    const label = `Undo: ${run.label}`.slice(0, 120);
    // every link the run added comes off first, then every link it removed goes back (undoLinksChunk)
    const state = { runId: null, after: null, added: true, changed: 0, restored: 0, removed: 0, presets: 0, renamed: [] };
    // the undo's own run would push the one it reads past the keep at its first chunk
    const release = holdTagRun(db, run.id);
    return startSetJob(db, {
        kind: 'undo', label, origin, total: countRunLinks(db, run.id), cleanup: release,
        step(job) {
            const { rows, last } = runLinksChunk(db, run.id, state.after, TAG_JOB_CHUNK, { added: state.added });
            if (!rows.length) {
                if (state.added) {
                    state.added = false;
                    state.after = null;
                    return true;
                }
                // the last step: a preset rule goes back once the tag it names is back on every carrier
                state.presets = undoPresetChunk(db, state, { label, runId: run.id });
                // and its tag ops said back, so every tab's live rules follow the names as they did the op
                state.renamed = undoTagOps(db, state, { label, runId: run.id });
                return false;
            }
            const moved = undoLinksChunk(db, state, { label, rows });
            state.changed += moved.changed.length;
            state.restored += moved.restored;
            state.removed += moved.removed;
            state.after = last;
            job.done += rows.length;
            return true;
        },
        settle: () => ({ changed: state.changed, restored: state.restored, removed: state.removed, presets: state.presets, renamed: state.renamed, runId: state.runId }),
    });
}
