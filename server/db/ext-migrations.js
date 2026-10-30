// Extensions' own tables: a server half's migrations, frozen like the core list and confined to x_<id>_... names
import crypto from 'node:crypto';

// ext id -> { id, prefix, entries: [{ run, sha }] }
const _registered = new Map();

/** The name prefix of an extension's own tables, indexes and triggers. */
export function extTablePrefix(id) {
    return `x_${String(id).replace(/-/g, '_')}_`;
}

/**
 * Take a server half's `migrations` export: an array of SQL strings or (db) => void, in order.
 * Throws on a malformed list; running them is runExtensionMigrations.
 */
export function registerExtensionMigrations(id, migrations) {
    if (migrations === undefined) return;
    if (!Array.isArray(migrations)) throw new Error('migrations must be an array of SQL strings or functions');
    const entries = migrations.map((m, i) => {
        if (typeof m !== 'string' && typeof m !== 'function') throw new Error(`migration ${i} must be an SQL string or a function`);
        // hashed with CRLF folded to LF so a re-checkout changes nothing
        const text = typeof m === 'string' ? m : m.toString();
        return { run: m, sha: crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex') };
    });
    _registered.set(id, { id, prefix: extTablePrefix(id), entries });
}

export function dropExtensionMigrations(id) {
    _registered.delete(id);
}

function schemaOf(db) {
    return new Map(db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all().map(r => [`${r.type}:${r.name}`, r]));
}

// its own table's objects, or SQLite's (an autoindex follows its table; the sequence and stats are shared)
const ownName = (row, prefix) => row.name === 'sqlite_sequence' || row.name.startsWith('sqlite_stat')
    || (row.tbl_name.startsWith(prefix) && (row.name.startsWith(prefix) || row.name.startsWith('sqlite_autoindex_')));

/** Run an extension's pending migrations in one library, one transaction each with foreign keys off; a bad entry throws and rolls back. */
export function runExtensionMigrations(db, id) {
    const reg = _registered.get(id);
    if (!reg || !reg.entries.length) return;
    const applied = db.prepare('SELECT idx, sha FROM ext_migrations WHERE ext_id = ? ORDER BY idx').all(id);
    for (const a of applied) {
        const e = reg.entries[a.idx];
        if (!e) throw new Error(`migration ${a.idx} ran in this library but the extension no longer carries it`);
        if (e.sha !== a.sha) throw new Error(`migration ${a.idx} changed after it ran in this library; a landed migration is never edited, add a new one`);
    }
    if (applied.length === reg.entries.length) return;
    // the pragma is a no-op inside a transaction, so an entry there would run with keys on
    if (db.inTransaction) throw new Error('its migrations cannot run inside a transaction');
    const keysOn = db.pragma('foreign_keys', { simple: true });
    if (keysOn) db.pragma('foreign_keys = OFF');
    try {
        for (let i = applied.length; i < reg.entries.length; i++) runEntry(db, reg, i);
    } finally {
        if (keysOn) db.pragma('foreign_keys = ON');
    }
}

function runEntry(db, reg, i) {
    const entry = reg.entries[i];
    db.transaction(() => {
        const before = schemaOf(db);
        const version = db.pragma('user_version', { simple: true });
        if (typeof entry.run === 'function') entry.run(db);
        else db.exec(entry.run);
        if (db.pragma('user_version', { simple: true }) !== version) throw new Error(`migration ${i} changed the library's schema version`);
        const after = schemaOf(db);
        for (const [key, row] of after) {
            const was = before.get(key);
            if ((!was || was.sql !== row.sql) && !ownName(row, reg.prefix)) {
                throw new Error(`migration ${i} made or changed ${row.type} '${row.name}' on '${row.tbl_name}'; an extension's objects are named ${reg.prefix}...`);
            }
        }
        for (const [key, row] of before) {
            if (!after.has(key) && !ownName(row, reg.prefix)) throw new Error(`migration ${i} dropped ${row.type} '${row.name}', which is not this extension's`);
        }
        // its own tables only: the whole library's check walks every relation table of the app's
        const dangling = [...after.values()].filter(r => r.type === 'table' && r.name.startsWith(reg.prefix))
            .flatMap(r => db.prepare(`PRAGMA foreign_key_check("${r.name}")`).all());
        if (dangling.length) throw new Error(`migration ${i} left ${dangling.length} row(s) of '${dangling[0].table}' pointing at no row of '${dangling[0].parent}'`);
        // a message's seq moves on an earlier delete, so a key on the place must cascade on update
        for (const r of after.values()) {
            if (r.type !== 'table' || !r.name.startsWith(reg.prefix)) continue;
            const keys = new Map();
            for (const fk of db.prepare(`PRAGMA foreign_key_list("${r.name}")`).all()) {
                if (fk.table !== 'chat_messages') continue;
                if (!keys.has(fk.id)) keys.set(fk.id, { to: [], onUpdate: String(fk.on_update).toUpperCase() });
                keys.get(fk.id).to.push(fk.to);
            }
            if ([...keys.values()].some(k => k.to.includes('seq') && k.onUpdate !== 'CASCADE')) {
                throw new Error(`migration ${i}: '${r.name}' keys on chat_messages(chat_id, seq) without ON UPDATE CASCADE; a message's seq moves when an earlier message is deleted (key on chat_messages(id) to follow the message wherever it sits)`);
            }
        }
        db.prepare('INSERT INTO ext_migrations (ext_id, idx, sha, applied_at) VALUES (?, ?, ?, ?)').run(reg.id, i, entry.sha, Date.now());
    })();
}
