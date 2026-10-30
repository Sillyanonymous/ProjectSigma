// whole-library counts, read from the tables each time: a stored summary is a second thing to keep true

/**
 * @param {object} [opts]
 * @param {boolean} [opts.more] also the favorites, the lore entries, the tags, the personas and the playlists
 * @returns {{characters: number, chats: number, messages: number, lorebooks: number, favorites?: number, loreEntries?: number, tags?: number, personas?: number, playlists?: number}}
 */
export function libraryCounts(db, { more = false } = {}) {
    const n = (sql) => db.prepare(sql).get().n;
    const out = {
        characters: n('SELECT COUNT(*) n FROM characters'),
        chats: n('SELECT COUNT(*) n FROM chats'),
        messages: n('SELECT COALESCE(SUM(message_count), 0) n FROM chats'),
        // a placeholder is a name something binds with no book behind it, which no picker shows as a book
        lorebooks: n('SELECT COUNT(*) n FROM worlds WHERE placeholder = 0'),
    };
    if (!more) return out;
    return {
        ...out,
        favorites: n('SELECT COUNT(*) n FROM characters WHERE fav = 1'),
        loreEntries: n('SELECT COALESCE(SUM(entry_count), 0) n FROM worlds'),
        tags: n('SELECT COUNT(*) n FROM tags'),
        personas: n('SELECT COUNT(*) n FROM personas'),
        playlists: n('SELECT COUNT(*) n FROM playlists'),
    };
}

/**
 * The characters with the most messages across their chats, most first, off the chats' own counts.
 * @returns {Array<{id: string, name: string, chats: number, messages: number}>}
 */
export function mostChattedCharacters(db, limit = 5) {
    return db.prepare(`
        SELECT ch.char_id AS id, c.name AS name, COUNT(*) AS chats, COALESCE(SUM(ch.message_count), 0) AS messages
        FROM chats ch JOIN characters c ON c.id = ch.char_id
        GROUP BY ch.char_id
        ORDER BY messages DESC, chats DESC, c.name COLLATE NOCASE
        LIMIT ?`).all(limit);
}
