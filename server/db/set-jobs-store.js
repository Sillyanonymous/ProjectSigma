// a set job's characters, fixed once in a temp table on the library's connection and read a chunk at a time

const setTable = (key) => `temp."set_job_${Number(key)}"`;

/** Materialize the characters a set query answers, in its order; the count. */
export function materializeSet(db, key, set) {
    return db.transaction(() => {
        db.exec(`DROP TABLE IF EXISTS ${setTable(key)}; CREATE TABLE ${setTable(key)} (char_id TEXT NOT NULL)`);
        return db.prepare(`INSERT INTO ${setTable(key)} (char_id) SELECT id FROM (${set.sql})`).run(...set.params).changes;
    })();
}

export function dropSet(db, key) {
    db.transaction(() => db.exec(`DROP TABLE IF EXISTS ${setTable(key)}`))();
}

/** The next chunk of a materialized set after a position: { ids, last } (last null at the end). */
export function setChunk(db, key, after, limit) {
    const rows = db.prepare(`SELECT rowid AS rid, char_id FROM ${setTable(key)} WHERE rowid > ? ORDER BY rowid LIMIT ?`).all(after, limit);
    return { ids: rows.map(r => r.char_id), last: rows.length ? rows[rows.length - 1].rid : null };
}
