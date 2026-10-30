// tag links with no report, in the caller's transaction; not a *-store.js, so no extension gets a write that skips the report

/** The tag-name resolver: find answers a tag's id by NOCASE name (undefined when none), mint finds or makes the row. */
export function tagIds(db) {
    const find = db.prepare('SELECT id FROM tags WHERE name = ?');
    const insert = db.prepare('INSERT INTO tags (name) VALUES (?)');
    return {
        find: (name) => find.get(name)?.id,
        mint: (name) => find.get(name)?.id ?? insert.run(name).lastInsertRowid,
    };
}

/** Replace the links verbatim, in the given order. @returns {boolean} whether the character's tag names, in order, changed */
export function replaceTagLinks(db, charId, tags) {
    const namesOf = db.prepare('SELECT t.name FROM char_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.char_id = ? ORDER BY ct.pos').pluck();
    const before = JSON.stringify(namesOf.all(charId));
    if (JSON.stringify(tags) === before) return false;
    db.prepare('DELETE FROM char_tags WHERE char_id = ?').run(charId);
    const ids = tagIds(db);
    const link = db.prepare('INSERT OR IGNORE INTO char_tags (char_id, tag_id, pos) VALUES (?, ?, ?)');
    tags.forEach((name, pos) => link.run(charId, ids.mint(name), pos));
    // a recase of a tag another character holds resolves onto that row, so the names can come out as they were
    return JSON.stringify(namesOf.all(charId)) !== before;
}

/** Link the given tags after the current highest pos, keeping the ones already there (NOCASE names). */
export function appendTagLinks(db, charId, tags) {
    const ids = tagIds(db);
    const link = db.prepare('INSERT OR IGNORE INTO char_tags (char_id, tag_id, pos) VALUES (?, ?, ?)');
    let pos = db.prepare('SELECT COALESCE(MAX(pos), -1) AS p FROM char_tags WHERE char_id = ?').get(charId).p;
    let linked = 0;
    for (const name of tags) linked += link.run(charId, ids.mint(name), ++pos).changes;
    return linked;
}
