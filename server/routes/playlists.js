import { Router } from 'express';
import { composePlaylistsDoc, createPlaylist, updatePlaylist, deletePlaylist, applyPlaylistMembers, tallyPlaylists, listPlaylistMembers, getPlaylist } from '../db/playlists-store.js';
import { pageOf, IDS_MAX } from '../lib/query-params.js';
import { characterSetFrom } from '../lib/character-query.js';
import { startPlaylistJob } from '../lib/character-jobs.js';
import { clientIdOf } from '../lib/feed.js';

export const playlistsRouter = Router();

playlistsRouter.get('/', (req, res) => {
    res.json(composePlaylistsDoc(req.db));
});

// how many of a selection (ids or a filter) each playlist holds, for the picker's checkboxes
playlistsRouter.post('/tally', (req, res) => {
    const { charIds, filter } = req.body || {};
    if (filter === undefined) {
        if (!Array.isArray(charIds) || !charIds.every(x => typeof x === 'string')) return res.status(400).json({ error: 'charIds array of character ids, or a filter, required' });
        if (!charIds.length) return res.json({});
    }
    res.json(tallyPlaylists(req.db, characterSetFrom(req.db, { charIds, filter })));
});

playlistsRouter.post('/', (req, res) => {
    res.json(createPlaylist(req.db, req.body || {}));
});

playlistsRouter.patch('/:id', (req, res) => {
    const playlist = updatePlaylist(req.db, req.params.id, req.body || {});
    if (!playlist) return res.status(404).json({ error: 'playlist not found' });
    res.json(playlist);
});

const MEMBERS_DEFAULT_LIMIT = 1000;
const MEMBERS_MAX_LIMIT = 10000;

playlistsRouter.get('/:id/members', (req, res) => {
    const { limit, after: cursor } = pageOf(req.query, { def: MEMBERS_DEFAULT_LIMIT, max: MEMBERS_MAX_LIMIT });
    const after = cursor === undefined ? -1 : Number(cursor);
    if (!Number.isInteger(after)) return res.status(400).json({ error: 'after is the nextCursor of the page before' });
    const page = listPlaylistMembers(req.db, req.params.id, { after, limit });
    if (!page) return res.status(404).json({ error: 'playlist not found' });
    res.json(page);
});

playlistsRouter.delete('/:id', (req, res) => {
    if (!deletePlaylist(req.db, req.params.id)) return res.status(404).json({ error: 'playlist not found' });
    res.json({ ok: true });
});

// by ids in one transaction, or a filter's set as a job (202)
playlistsRouter.post('/:id/members/apply', (req, res) => {
    const { filter, op, add, remove } = req.body || {};
    if (filter !== undefined) {
        if (add !== undefined || remove !== undefined) return res.status(400).json({ error: 'add and remove, or a filter and its op, not both' });
        if (op !== 'add' && op !== 'remove') return res.status(400).json({ error: "op must be 'add' or 'remove'" });
        const set = characterSetFrom(req.db, { filter });
        if (!getPlaylist(req.db, req.params.id)) return res.status(404).json({ error: 'playlist not found' });
        const job = startPlaylistJob(req.db, req.params.id, set, { op, origin: clientIdOf(req.headers['x-cl-client']) });
        return res.status(202).json({ ok: true, job });
    }
    // one transaction holds the write lock for every id it inserts, so a request names at most IDS_MAX
    if ((Array.isArray(add) ? add.length : 0) + (Array.isArray(remove) ? remove.length : 0) > IDS_MAX) {
        return res.status(400).json({ error: `add and remove name at most ${IDS_MAX} characters a request; send the selection in chunks, or its filter` });
    }
    const delta = applyPlaylistMembers(req.db, req.params.id, req.body || {});
    if (!delta) return res.status(404).json({ error: 'playlist not found' });
    res.json(delta);
});
