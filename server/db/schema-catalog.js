// The core schema as this build makes it, and who owns each object a real library holds
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, runMigrationSteps } from './database.js';
import { SERVER_MIGRATIONS, migrateServerDb } from './server-store.js';
import { extTablePrefix } from './ext-migrations.js';

// a library written on a CRLF checkout stores its statements with CRLF
const lf = (s) => String(s ?? '').replace(/\r\n/g, '\n');

/** Every schema object a database holds but SQLite's own: { type, name, table, sql }, an FTS5 index's own tables typed 'shadow'. */
export function schemaObjects(db) {
    const shadow = new Set(db.prepare("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'shadow'").pluck().all());
    return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all()
        .map(r => ({ type: shadow.has(r.name) ? 'shadow' : r.type, name: r.name, table: r.tbl_name, sql: lf(r.sql) }));
}

/**
 * The schema this build gives a fresh library and a fresh server.db, built in memory by the same steps:
 * { library: { version, objects }, server: { version, objects } }.
 */
export function freshSchema() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-schema-'));
    const library = new Database(':memory:');
    const server = new Database(':memory:');
    try {
        library.pragma('foreign_keys = OFF');
        // a fresh library holds no rows, so no step reads a file; any path a step names lands in tmp
        const paths = new Proxy({}, { get: (_, key) => path.join(tmp, String(key)) });
        runMigrationSteps(library, paths, 0, MIGRATIONS.length);
        migrateServerDb(server);
        return {
            library: { version: MIGRATIONS.length, objects: schemaObjects(library) },
            server: { version: SERVER_MIGRATIONS.length, objects: schemaObjects(server) },
        };
    } finally {
        library.close();
        server.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

const keyOf = (o) => `${o.type}:${o.name}`;

/**
 * Who owns each object a library holds (core, drift, an extension's by prefix, installed or leftover, or unknown), and the core it lacks.
 * @param {import('better-sqlite3').Database} db
 * @param {{ core: object[], extensionIds: string[] }} opts the fresh library's objects; the ids the server has
 * @returns {{ core: object[], drift: object[], missing: object[], extensions: { id: string, installed: boolean, objects: object[] }[], unknown: object[] }}
 */
export function schemaOwnership(db, { core, extensionIds }) {
    const held = schemaObjects(db);
    const want = new Map(core.map(o => [keyOf(o), o]));
    const ran = held.some(o => o.type === 'table' && o.name === 'ext_migrations')
        ? db.prepare('SELECT DISTINCT ext_id FROM ext_migrations').pluck().all() : [];
    // the longest prefix first: x_a_b_ is a-b's even where x_a_ begins it
    const owners = [...new Set([...extensionIds, ...ran])]
        .map(id => ({ id, prefix: extTablePrefix(id), installed: extensionIds.includes(id), objects: [] }))
        .sort((a, b) => b.prefix.length - a.prefix.length || a.id.localeCompare(b.id));
    const out = { core: [], drift: [], missing: [], extensions: [], unknown: [] };
    for (const o of held) {
        const mine = want.get(keyOf(o));
        if (mine) { (mine.sql === o.sql ? out.core : out.drift).push(o); continue; }
        const owner = owners.find(w => o.name.startsWith(w.prefix) && o.table.startsWith(w.prefix));
        if (owner) owner.objects.push(o);
        else out.unknown.push(o);
    }
    const heldKeys = new Set(held.map(keyOf));
    out.missing = core.filter(o => !heldKeys.has(keyOf(o)));
    out.extensions = owners.filter(w => w.objects.length).sort((a, b) => a.id.localeCompare(b.id))
        .map(({ id, installed, objects }) => ({ id, installed, objects }));
    return out;
}

/**
 * Drop a removed extension's objects and its migration record from one library, in one transaction with foreign keys off; answers what went.
 * @param {import('better-sqlite3').Database} db
 * @param {string} id the extension's id
 * @param {{ core: object[], extensionIds: string[] }} opts as schemaOwnership takes them
 */
export function dropLeftoverExtension(db, id, { core, extensionIds }) {
    if (extensionIds.includes(id)) throw new Error(`'${id}' is still installed; remove it first, then drop what it left`);
    const group = schemaOwnership(db, { core, extensionIds }).extensions.find(e => e.id === id);
    const recorded = db.prepare('SELECT COUNT(*) FROM ext_migrations WHERE ext_id = ?').pluck().get(id);
    if (!group && !recorded) return [];
    if (db.inTransaction) throw new Error('a drop cannot run inside a transaction, where the foreign key pragma is a no-op');
    const objects = group?.objects || [];
    const tables = new Set(objects.filter(o => o.type === 'table').map(o => o.name));
    // a table of anyone else's that references one of these would point at nothing once it went
    for (const t of schemaObjects(db).filter(o => o.type === 'table' && !tables.has(o.name))) {
        const ref = db.prepare('SELECT "table" FROM pragma_foreign_key_list(?)').pluck().all(t.name).find(p => tables.has(p));
        if (ref) throw new Error(`'${t.name}' references '${ref}', which '${id}' left; nothing was dropped`);
    }
    const keysOn = db.pragma('foreign_keys', { simple: true });
    if (keysOn) db.pragma('foreign_keys = OFF');
    try {
        db.transaction(() => {
            // a view first, then each table, which takes its indexes and triggers with it; a shadow goes with its FTS table
            for (const o of objects.filter(x => x.type === 'view')) db.exec(`DROP VIEW "${o.name}"`);
            for (const o of objects.filter(x => x.type === 'table')) db.exec(`DROP TABLE "${o.name}"`);
            const left = schemaObjects(db).filter(o => objects.some(x => x.name === o.name));
            for (const o of left.filter(x => x.type === 'index' || x.type === 'trigger')) db.exec(`DROP ${o.type.toUpperCase()} "${o.name}"`);
            db.prepare('DELETE FROM ext_migrations WHERE ext_id = ?').run(id);
        })();
    } finally {
        if (keysOn) db.pragma('foreign_keys = ON');
    }
    return objects;
}
