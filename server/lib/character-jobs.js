// Writes over a set of characters as set jobs: the set is fixed first, each chunk one transaction through the store's writer
import { startSetJob } from './set-jobs.js';
import { deleteCharacters, DELETE_MAX, setCharacterFlags, flagMoversSet } from '../db/characters-store.js';
import { applyPlaylistChunk, getPlaylist } from '../db/playlists-store.js';
import { httpError } from './http-error.js';

// a favourite or a membership is a column or a row a character, cheap enough for this many a turn
export const SET_WRITE_CHUNK = 1000;

/**
 * Delete every character of a set, DELETE_MAX a chunk; with expect, a size mismatch is a 409 before any delete.
 * @returns the job as the route answers it
 */
export function startDeleteJob(db, paths, set, { expect } = {}) {
    const state = { deleted: 0, missing: 0 };
    return startSetJob(db, {
        kind: 'delete', label: 'Delete characters', origin: null, set,
        admit(total) {
            if (expect !== undefined && total !== expect) throw httpError(409, 'the set changed since it was counted', { total });
        },
        step(job, next) {
            const ids = next(DELETE_MAX);
            if (!ids.length) return false;
            const out = deleteCharacters(db, paths, ids);
            state.deleted += out.deleted.length;
            state.missing += out.missing.length;
            job.done += ids.length;
            return true;
        },
        settle: () => ({ changed: state.deleted, missing: state.missing }),
    });
}

/**
 * Favourite or unfavourite every character of a set, writing only the rows whose value moves.
 * @returns the job as the route answers it
 */
export function startFavoriteJob(db, set, { value, origin }) {
    let changed = 0;
    return startSetJob(db, {
        // the write lands on each character's own row, so the set runs in storage order
        kind: 'favorite', label: value ? 'Favorite characters' : 'Unfavorite characters', origin, set, storageOrder: true,
        step(job, next) {
            const ids = next(SET_WRITE_CHUNK);
            if (!ids.length) return false;
            changed += setCharacterFlags(db, { ids }, { fav: value }).touched;
            job.done += ids.length;
            return true;
        },
        settle: () => ({ changed }),
    });
}

/**
 * Set op-state flags over the whole library: the characters whose value moves, fixed first, then written a chunk at a time.
 * @param {object} flags { mediaLocalized?: boolean, loreDismissed?: boolean }
 * @returns the job as the route answers it
 */
export function startFlagsJob(db, flags, { origin }) {
    let changed = 0;
    return startSetJob(db, {
        kind: 'flags', label: 'Set character flags', origin, set: flagMoversSet(flags), storageOrder: true,
        step(job, next) {
            const ids = next(SET_WRITE_CHUNK);
            if (!ids.length) return false;
            changed += setCharacterFlags(db, { ids }, flags).touched;
            job.done += ids.length;
            return true;
        },
        settle: () => ({ changed }),
    });
}

/**
 * Add a set to a playlist's end, in set order, or take it out; a playlist deleted mid-job fails it.
 * @param {'add'|'remove'} op
 * @returns the job as the route answers it
 */
export function startPlaylistJob(db, playlistId, set, { op, origin }) {
    let changed = 0;
    const name = getPlaylist(db, playlistId)?.name || playlistId;
    return startSetJob(db, {
        kind: 'playlist', label: `${op === 'add' ? 'Add to' : 'Remove from'} ${name}`.slice(0, 120), origin, set,
        step(job, next) {
            const ids = next(SET_WRITE_CHUNK);
            if (!ids.length) return false;
            changed += applyPlaylistChunk(db, playlistId, { ids, op });
            job.done += ids.length;
            return true;
        },
        settle: () => ({ changed, playlist: getPlaylist(db, playlistId) }),
    });
}
