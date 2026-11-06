// SPDX-License-Identifier: MIT

// Ratings and Notes, the server half: one row per rated character, a projection, a filter field and a sort.
import { NOTE_MAX, BATCH_MAX } from '../client/limits.js';

const TABLE = 'x_ratings_notes_ratings';

// append-only: an entry that ran is never edited, a change is a new entry
export const migrations = [
    `CREATE TABLE x_ratings_notes_ratings (
        char_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
        rating INTEGER CHECK (rating BETWEEN 1 AND 5),
        note TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL);
     CREATE INDEX x_ratings_notes_ratings_rating ON x_ratings_notes_ratings(rating);`,
];

// null clears the rating; anything else must be a whole number of stars
function ratingFrom(value) {
    if (value === null) return null;
    return Number.isInteger(value) && value >= 1 && value <= 5 ? value : undefined;
}

export function register(router, ctx) {
    ctx.query.projection({ key: 'rating', table: TABLE, column: 'rating' });
    ctx.query.ruleField({ key: 'rating', label: 'Rating', type: 'number', table: TABLE, column: 'rating' });
    ctx.query.sortKey({ key: 'rating', label: 'Rating', table: TABLE, column: 'rating' });

    const exists = (db, id) => ctx.stores.characters.characterExists(db, id);
    // an entry's read and its two writes, on a statement each: a route writing many prepares them once
    const statements = (db) => ({
        read: db.prepare(`SELECT rating, note, updated_at AS updatedAt FROM ${TABLE} WHERE char_id = ?`),
        drop: db.prepare(`DELETE FROM ${TABLE} WHERE char_id = ?`),
        put: db.prepare(`INSERT INTO ${TABLE} (char_id, rating, note, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(char_id) DO UPDATE SET rating = excluded.rating, note = excluded.note, updated_at = excluded.updated_at`),
    });
    const entryOf = (st, id) => st.read.get(id) || { rating: null, note: '', updatedAt: null };
    // a character left with neither a rating nor a note keeps no row
    const store = (st, id, rating, note, now) => {
        if (rating === null && !note) st.drop.run(id);
        else st.put.run(id, rating, note, now);
    };

    router.get('/entry/:id', (req, res) => {
        if (!exists(req.db, req.params.id)) return res.status(404).json({ error: 'character not found' });
        res.json(entryOf(statements(req.db), req.params.id));
    });

    // only the keys sent change
    router.put('/entry/:id', (req, res) => {
        const id = req.params.id;
        const body = req.body || {};
        const changes = {};
        if ('rating' in body) {
            changes.rating = ratingFrom(body.rating);
            if (changes.rating === undefined) return res.status(400).json({ error: 'rating is a whole number from 1 to 5, or null' });
        }
        if ('note' in body) {
            if (typeof body.note !== 'string' || body.note.length > NOTE_MAX) return res.status(400).json({ error: `note is text of at most ${NOTE_MAX} characters` });
            changes.note = body.note;
        }
        if (!('rating' in changes) && !('note' in changes)) return res.status(400).json({ error: 'send a rating, a note, or both' });
        if (!exists(req.db, id)) return res.status(404).json({ error: 'character not found' });
        const entry = req.db.transaction(() => {
            const st = statements(req.db);
            const was = entryOf(st, id);
            const next = { rating: 'rating' in changes ? changes.rating : was.rating, note: 'note' in changes ? changes.note : was.note };
            const fields = ['rating', 'note'].filter(k => k in changes && next[k] !== was[k]).map(k => `ratings-notes.${k}`);
            if (fields.length) {
                store(st, id, next.rating, next.note, Date.now());
                ctx.report(req.db, { entity: 'character', op: 'updated', ids: [id], fields });
            }
            return entryOf(st, id);
        })();
        res.json(entry);
    });

    // one rating, or null, for many characters; their notes stay
    router.put('/ratings', (req, res) => {
        const { ids } = req.body || {};
        const rating = ratingFrom(req.body?.rating);
        if (!Array.isArray(ids) || !ids.length || ids.length > BATCH_MAX) return res.status(400).json({ error: `ids is a list of 1 to ${BATCH_MAX} character ids` });
        if (rating === undefined) return res.status(400).json({ error: 'rating is a whole number from 1 to 5, or null' });
        const answer = req.db.transaction(() => {
            const affected = [], skipped = [], changed = [];
            const now = Date.now();
            const unique = [...new Set(ids.map(String))];
            // one probe for the whole list, and each statement prepared once, never per id
            const held = ctx.stores.characters.existingCharacterIds(req.db, unique);
            const st = statements(req.db);
            for (const id of unique) {
                if (!held.has(id)) { skipped.push(id); continue; }
                const was = entryOf(st, id);
                if (was.rating !== rating) {
                    store(st, id, rating, was.note, now);
                    changed.push(id);
                }
                affected.push(id);
            }
            if (changed.length) ctx.report(req.db, { entity: 'character', op: 'updated', ids: changed, fields: ['ratings-notes.rating'] });
            return { affected, skipped };
        })();
        res.json(answer);
    });
}
