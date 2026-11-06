// SPDX-License-Identifier: MIT

// Lore Search, the server half: every book's entries in an FTS5 index of its own, kept by the books' stamps.

const ROWS = 'x_lore_search_rows';
const FTS = 'x_lore_search_fts';
const BOOKS = 'x_lore_search_books';
const KEY = 'index';
// reading more than this many entries at once is a job, never a request's wait
const INLINE_ENTRIES = 2000;
const SEARCH_LIMIT = 50;
const LIKE_LIMIT = 20;
// the words of the scan window asked for, newest first, and the entries a chat can reach
const REACH_TERMS = 200;
const REACH_HITS = 200;
const REACH_ENTRIES = 40;
const QUERY_WORDS = 12;
const SNIPPET_WORDS = 14;
// words too common in a key to point anywhere
const STOP = new Set(['the', 'and', 'you', 'your', 'with', 'that', 'this', 'for', 'are', 'was', 'but', 'not', 'have',
    'his', 'her', 'she', 'him', 'they', 'them', 'what', 'from', 'can', 'all', 'will', 'just', 'its', 'our', 'out']);

// append-only: an entry that ran is never edited, a change is a new entry
export const migrations = [
    `CREATE TABLE x_lore_search_rows (
        id INTEGER PRIMARY KEY,
        world TEXT NOT NULL,
        uid INTEGER NOT NULL,
        off INTEGER NOT NULL,
        constant INTEGER NOT NULL,
        keys TEXT NOT NULL CHECK (json_valid(keys)),
        UNIQUE (world, uid));
    CREATE VIRTUAL TABLE x_lore_search_fts USING fts5(title, keys, content, tokenize = 'unicode61 remove_diacritics 2');
    CREATE TABLE x_lore_search_books (
        world TEXT PRIMARY KEY,
        read_at INTEGER NOT NULL);`,
    // an entry whose blob held no uid was never indexed: the index emptied, so the next sync reads every book again
    `DELETE FROM x_lore_search_fts;
    DELETE FROM x_lore_search_rows;
    DELETE FROM x_lore_search_books;`,
];

// the words of a text as the index splits them: letters and digits, case and accents folded
const WORD = /[\p{L}\p{N}]+/gu;
const wordsOf = (text) => String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(WORD) || [];
// one word as a query term: quoted, so nothing a reader types is read as query syntax
const term = (w) => `"${w}"`;
// a key written as a regex (/.../flags) is matched by the engine alone
const isRegexKey = (k) => /^\/.+\/[a-z]*$/i.test(String(k).trim());
const keysOf = (e) => (Array.isArray(e?.key) ? e.key : []).map(String).filter(k => k.trim());

/**
 * A reader's words as a search, each required, the last a prefix; null when there is nothing to look for.
 */
function searchQuery(q) {
    const words = wordsOf(q).slice(0, QUERY_WORDS);
    // a one-letter last word is a word just begun: as a prefix it would read every term starting with it
    if (words.length > 1 && words[words.length - 1].length < 2) words.pop();
    if (!words.some(w => w.length >= 2)) return null;
    return words.map((w, i) => (i === words.length - 1 ? `${term(w)}*` : term(w))).join(' ');
}

/**
 * The index entries that could fire in a window: its words against the keys, kept when a key's every word is there.
 */
function reachQuery(texts) {
    const all = new Set();
    const asked = [];
    for (const text of [...texts].reverse()) {
        for (const w of wordsOf(text)) {
            if (all.has(w)) continue;
            all.add(w);
            if (w.length >= 3 && !STOP.has(w) && asked.length < REACH_TERMS) asked.push(w);
        }
    }
    return { match: asked.length ? `keys : (${asked.map(term).join(' OR ')})` : null, words: all };
}

// a key whose every word is in the window: the others cannot fire there
const keyCanFire = (key, words) => {
    if (isRegexKey(key)) return false;
    const ws = wordsOf(key);
    return ws.length > 0 && ws.every(w => words.has(w));
};

export function register(router, ctx) {
    const busy = (db) => ctx.jobs.list(db).some(j => j.key === KEY && (j.status === 'queued' || j.status === 'running'));

    // the books read again (never read, or written at or after their last read) and the books gone
    function stale(db) {
        const shelf = ctx.stores.worlds.listWorlds(db);
        const read = new Map(db.prepare(`SELECT world, read_at FROM ${BOOKS}`).all().map(r => [r.world, r.read_at]));
        const toRead = shelf.filter(w => !read.has(w.name) || w.updatedAt >= read.get(w.name));
        const names = new Set(shelf.map(w => w.name));
        const gone = [...read.keys()].filter(n => !names.has(n));
        return { toRead, gone, entries: toRead.reduce((n, w) => n + (Number(w.entryCount) || 0), 0) };
    }

    function drop(db, world) {
        db.prepare(`DELETE FROM ${FTS} WHERE rowid IN (SELECT id FROM ${ROWS} WHERE world = ?)`).run(world);
        db.prepare(`DELETE FROM ${ROWS} WHERE world = ?`).run(world);
        db.prepare(`DELETE FROM ${BOOKS} WHERE world = ?`).run(world);
    }

    // one book into the index, its stamp taken before the read, so a write during it is read next time
    function indexBook(db, world) {
        const at = Date.now();
        db.transaction(() => {
            drop(db, world);
            const book = ctx.stores.worlds.getWorld(db, world);
            if (!book) return;
            const row = db.prepare(`INSERT INTO ${ROWS} (world, uid, off, constant, keys) VALUES (?, ?, ?, ?, ?)`);
            const text = db.prepare(`INSERT INTO ${FTS} (rowid, title, keys, content) VALUES (?, ?, ?, ?)`);
            // keyed by the row's uid, as getWorld composes the book: a blob holds a uid only when its writer put one in
            for (const [key, e] of Object.entries(book.data?.entries || {})) {
                const uid = Number(key);
                if (!e || !Number.isInteger(uid)) continue;
                const keys = keysOf(e);
                const id = row.run(world, uid, e.disable ? 1 : 0, e.constant ? 1 : 0, JSON.stringify(keys)).lastInsertRowid;
                text.run(id, String(e.comment || ''), keys.join('\n'), String(e.content || ''));
            }
            db.prepare(`INSERT INTO ${BOOKS} (world, read_at) VALUES (?, ?) ON CONFLICT(world) DO UPDATE SET read_at = excluded.read_at`).run(world, at);
        })();
    }

    function startIndexing(db) {
        if (busy(db)) return;
        ctx.jobs.run(db, {
            key: KEY,
            label: 'Indexing your lorebooks',
            run: async ({ db, signal, progress }) => {
                const { toRead, gone } = stale(db);
                for (const world of gone) db.transaction(() => drop(db, world))();
                let done = 0;
                for (const w of toRead) {
                    if (signal.aborted) return;
                    indexBook(db, w.name);
                    done++;
                    progress({ done, total: toRead.length, note: `${done} of ${toRead.length} lorebooks read` });
                    // the next book after the server has answered what waits
                    await new Promise(r => setImmediate(r));
                }
            },
        });
    }

    /**
     * Bring the index up to date before a read, a large read as a job; answers whether it is still reading.
     */
    function sync(db) {
        if (busy(db)) return true;
        const { toRead, gone, entries } = stale(db);
        if (!toRead.length && !gone.length) return false;
        if (entries > INLINE_ENTRIES) { startIndexing(db); return true; }
        for (const world of gone) db.transaction(() => drop(db, world))();
        for (const w of toRead) indexBook(db, w.name);
        return false;
    }

    const failedOf = (db) => {
        const ended = ctx.jobs.list(db).filter(j => j.key === KEY && j.endedAt).sort((a, b) => b.endedAt - a.endedAt)[0];
        return ended?.status === 'failed' ? ended.error : null;
    };
    const hitOf = (r) => ({
        world: r.world, uid: r.uid, title: r.title, keys: JSON.parse(r.keys), snippet: r.snippet,
        off: !!r.off, constant: !!r.constant,
    });
    const limitOf = (v, max) => {
        const n = Number(v);
        return Number.isInteger(n) && n > 0 ? Math.min(n, max) : max;
    };

    // what the index holds (the books with an entry in it; a placeholder holds none), and whether
    // it is being read
    router.get('/status', (req, res) => {
        const indexing = sync(req.db);
        const counts = req.db.prepare(`SELECT (SELECT COUNT(DISTINCT world) FROM ${ROWS}) AS books, (SELECT COUNT(*) FROM ${ROWS}) AS entries`).get();
        res.json({ ...counts, indexing, failed: indexing ? null : failedOf(req.db) });
    });

    // the library's entries matching a reader's words, the best first
    router.get('/search', (req, res) => {
        const match = searchQuery(req.query.q);
        const indexing = sync(req.db);
        if (!match) return res.json({ items: [], indexing });
        const items = req.db.prepare(`SELECT r.world, r.uid, r.off, r.constant, r.keys, f.title,
                snippet(${FTS}, 2, char(1), char(2), '...', ${SNIPPET_WORDS}) AS snippet
            FROM ${FTS} f JOIN ${ROWS} r ON r.id = f.rowid
            WHERE ${FTS} MATCH ? ORDER BY bm25(${FTS}, 4.0, 2.0, 1.0) LIMIT ?`).all(match, limitOf(req.query.limit, SEARCH_LIMIT));
        res.json({ items: items.map(hitOf), indexing });
    });

    // the entries sharing the most with one: its keys as phrases and its title's words, any of them
    router.get('/like', (req, res) => {
        const world = String(req.query.world || '');
        const uid = Number(req.query.uid);
        if (!world || !Number.isInteger(uid)) return res.status(400).json({ error: 'world is a lorebook\'s name and uid an entry\'s number' });
        const indexing = sync(req.db);
        const row = req.db.prepare(`SELECT r.id, r.keys, f.title, f.content FROM ${ROWS} r JOIN ${FTS} f ON f.rowid = r.id WHERE r.world = ? AND r.uid = ?`).get(world, uid);
        // while the index is being read the entry may not be in it yet: answered as /search answers then
        if (!row) return indexing ? res.json({ items: [], indexing }) : res.status(404).json({ error: 'no such entry in the index' });
        const phrases = JSON.parse(row.keys).filter(k => !isRegexKey(k)).map(k => wordsOf(k)).filter(ws => ws.length).map(ws => `"${ws.join(' ')}"`);
        const titleWords = wordsOf(row.title).filter(w => w.length >= 3 && !STOP.has(w)).map(term);
        let terms = [...new Set([...phrases, ...titleWords])];
        if (!terms.length) terms = [...new Set(wordsOf(row.content).filter(w => w.length >= 4 && !STOP.has(w)))].slice(0, QUERY_WORDS).map(term);
        if (!terms.length) return res.json({ items: [], indexing });
        const items = req.db.prepare(`SELECT r.world, r.uid, r.off, r.constant, r.keys, f.title,
                snippet(${FTS}, 2, char(1), char(2), '...', ${SNIPPET_WORDS}) AS snippet
            FROM ${FTS} f JOIN ${ROWS} r ON r.id = f.rowid
            WHERE ${FTS} MATCH ? AND r.id != ? ORDER BY bm25(${FTS}, 4.0, 2.0, 1.0) LIMIT ?`).all(terms.join(' OR '), row.id, limitOf(req.query.limit, LIKE_LIMIT));
        res.json({ items: items.map(hitOf), indexing });
    });

    // read every book again (the settings section's Rebuild)
    router.post('/rebuild', (req, res) => {
        if (!busy(req.db)) {
            req.db.transaction(() => {
                req.db.prepare(`DELETE FROM ${FTS}`).run();
                req.db.prepare(`DELETE FROM ${ROWS}`).run();
                req.db.prepare(`DELETE FROM ${BOOKS}`).run();
            })();
            startIndexing(req.db);
        }
        res.json({ indexing: true });
    });

    // ---- a chat's choice: reach into the books it does not use
    const reachOf = (db, chatId) => ctx.chatSlot.get(db, chatId).reach === true;

    router.get('/chats/:chatId', ctx.requireChat, (req, res) => {
        const { chatId } = req.params;
        res.json({ chatId, reach: reachOf(req.db, chatId) });
    });

    router.put('/chats/:chatId', ctx.requireChat, (req, res) => {
        const { chatId } = req.params;
        const { reach } = req.body || {};
        if (typeof reach !== 'boolean') return res.status(400).json({ error: 'reach is true or false' });
        // this extension's slot alone is written
        ctx.chatSlot.set(req.db, chatId, { ...ctx.chatSlot.get(req.db, chatId), reach });
        res.json({ chatId, reach: reachOf(req.db, chatId) });
    });

    // ---- reach: entries of books the chat does not use whose keys its window holds, under a book named for theirs
    ctx.hooks.add('lore.candidates', (worlds, { db, chatId, books, texts }) => {
        if (!chatId || !reachOf(db, chatId)) return undefined;
        if (sync(db)) return undefined;
        const { match, words } = reachQuery(texts);
        if (!match) return undefined;
        // the books in force are left out in the query, or their hits would crowd out what the chat can reach
        const hits = db.prepare(`SELECT r.world, r.uid, r.keys FROM ${FTS} f JOIN ${ROWS} r ON r.id = f.rowid
            WHERE ${FTS} MATCH ? AND r.off = 0 AND r.constant = 0 AND r.world NOT IN (SELECT value FROM json_each(?))
            ORDER BY bm25(${FTS}, 0.0, 1.0, 0.0) LIMIT ${REACH_HITS}`).all(match, JSON.stringify([...new Set(books)]));
        const byBook = new Map();
        let taken = 0;
        for (const h of hits) {
            if (taken >= REACH_ENTRIES) break;
            if (!JSON.parse(h.keys).some(k => keyCanFire(k, words))) continue;
            const entry = ctx.stores.worlds.getWorldEntry(db, h.world, h.uid);
            if (!entry) continue;
            if (!byBook.has(h.world)) byBook.set(h.world, {});
            byBook.get(h.world)[String(h.uid)] = { ...entry, uid: h.uid };
            taken++;
        }
        if (!byBook.size) return undefined;
        return [...worlds, ...[...byBook].map(([world, entries]) => ({ name: `ext:lore-search:${world}`, data: { entries } }))];
    });
}
