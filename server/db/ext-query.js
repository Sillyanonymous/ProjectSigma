// extensions' query doors over their own tables (projections, rule fields, sort keys): declared, never raw SQL, each proven on an index
import { runExtensionMigrations } from './ext-migrations.js';
import { subscribeChanges } from './changes.js';

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const KEY_RE = /^[a-z][a-zA-Z0-9_]{0,31}$/;
const FIELD_RE = /^ext\.([a-z0-9][a-z0-9-]*)\.([a-z][a-zA-Z0-9_]*)$/;

// a comparison per op, the operand bound; the value converted by type
const RULE_OPS = Object.freeze({
    number: { more_than: '> ?', less_than: '< ?', equals: '= ?' },
    date: { before: '< ?', after: '> ?', in_the_last: '>= ?' },
    // equality only: proveDoor plans an equality probe, and a prefix LIKE would need a NOCASE index with its own proof
    text: { equals: '= ?' },
    boolean: { is_true: '= 1', is_false: '= 0' },
});
const SET_OPS = ['is_set', 'is_not_set'];

// owner -> { enabled(db), prefix, onFail(err, db), projections, ruleFields, sortKeys: Map(key -> door) }
const _owners = new Map();
// db -> Set(owner) ready in that library
const _ready = new WeakMap();
// db -> Map(query shape -> how many rows have a sort key's value under its filters), forgotten
// on the library's next committed change
let _splits = new WeakMap();
const SPLITS_PER_LIBRARY = 64;
subscribeChanges((owner, records, db) => { _splits.delete(db); });

function entryOf(owner, { enabled, prefix, onFail }) {
    let e = _owners.get(owner);
    if (!e) _owners.set(owner, e = { enabled, prefix, onFail, projections: new Map(), ruleFields: new Map(), sortKeys: new Map() });
    return e;
}

function makeDoor(kind, owner, prefix, spec) {
    const { key, table, column, charColumn = 'char_id' } = spec || {};
    const where = `${kind} ${JSON.stringify(key)}`;
    if (!KEY_RE.test(String(key))) throw new Error(`query.${kind}: key must be a short identifier (letters, digits, underscore)`);
    if (!IDENT_RE.test(String(table)) || !table.startsWith(prefix)) throw new Error(`query.${kind} ${where}: table must be one of this extension's own (${prefix}...)`);
    for (const [name, v] of [['column', column], ['charColumn', charColumn]]) {
        if (!IDENT_RE.test(String(v))) throw new Error(`query.${kind} ${where}: ${name} must be a lowercase column name`);
    }
    return { kind, owner, key, table, column, charColumn, id: `${owner}:${kind}:${key}` };
}

/**
 * Declare a projection field: the list rows carry `ext.<owner>.<key>` for the accounts that
 * have the owner on, one lookup per row by the character's id.
 */
export function addProjection(owner, opts, spec) {
    const e = entryOf(owner, opts);
    const door = makeDoor('projection', owner, e.prefix, spec);
    if (e.projections.has(door.key)) throw new Error(`query.projection: '${door.key}' is declared twice`);
    door.probeSql = (by) => `SELECT ${door.column} FROM ${door.table}${by} WHERE ${door.charColumn} = ?`;
    e.projections.set(door.key, door);
}

/**
 * Declare a rule field: the advanced filter's `ext.<owner>.<key>`, its ops by type, compiled
 * to a set of character ids drawn from the owner's table.
 */
export function addRuleField(owner, opts, spec) {
    const e = entryOf(owner, opts);
    const door = makeDoor('ruleField', owner, e.prefix, spec);
    if (e.ruleFields.has(door.key)) throw new Error(`query.ruleField: '${door.key}' is declared twice`);
    if (!Object.hasOwn(RULE_OPS, spec.type)) throw new Error(`query.ruleField '${door.key}': type must be one of ${Object.keys(RULE_OPS).join(', ')}`);
    door.type = spec.type;
    door.label = typeof spec.label === 'string' && spec.label.trim() ? spec.label.trim() : door.key;
    door.probeSql = (by) => `SELECT ${door.charColumn} FROM ${door.table}${by} WHERE ${door.column} ${door.type === 'text' || door.type === 'boolean' ? '=' : '>'} ?`;
    e.ruleFields.set(door.key, door);
}

/** Declare a sort key: valued characters first in the column's order, then the rest by name; one row per character. */
export function addSortKey(owner, opts, spec) {
    const e = entryOf(owner, opts);
    const door = makeDoor('sortKey', owner, e.prefix, spec);
    if (e.sortKeys.has(door.key)) throw new Error(`query.sortKey: '${door.key}' is declared twice`);
    door.label = typeof spec.label === 'string' && spec.label.trim() ? spec.label.trim() : door.key;
    e.sortKeys.set(door.key, door);
}

/** Take every door an extension declared away (its removal, or a failed half). */
export function dropExtensionQuery(owner) {
    _owners.delete(owner);
    _splits = new WeakMap();
}

// an analyzed table of a few rows is scanned whatever its indexes, so a door also stands on a named index leading with its column
function plansOf(db, sqlFor, table, col, params) {
    const plans = [db.prepare(`EXPLAIN QUERY PLAN ${sqlFor('')}`).all(...params).map(r => r.detail)];
    const leading = db.prepare('SELECT name FROM pragma_index_list(?)').all(table)
        .filter(ix => db.prepare('SELECT name FROM pragma_index_info(?) WHERE seqno = 0').get(ix.name)?.name === col);
    for (const { name } of leading) {
        try {
            plans.push(db.prepare(`EXPLAIN QUERY PLAN ${sqlFor(` INDEXED BY "${name.replace(/"/g, '""')}"`)}`).all(...params).map(r => r.detail));
        } catch { /* that index cannot serve this shape */ }
    }
    return plans;
}

function proveDoor(db, door) {
    const col = door.kind === 'projection' ? door.charColumn : door.column;
    let plans;
    try {
        plans = plansOf(db, door.probeSql, door.table, col, [0]);
    } catch (e) {
        throw new Error(`${door.kind} '${door.key}' cannot read ${door.table} here: ${e.message}`);
    }
    if (!plans.some(plan => !plan.some(p => /^SCAN\b/.test(p)) && plan.some(p => /^SEARCH\b/.test(p)))) {
        throw new Error(`${door.kind} '${door.key}' reads ${door.table} without an index (${plans[0].join('; ')}); index ${door.table}(${col})`);
    }
}

// a sort key's walk must never sort, and a whole unique index on the character keeps one from listing twice (and serves the probe)
function proveSortKey(db, door) {
    const { key, table, column, charColumn } = door;
    const info = db.prepare('SELECT wr FROM pragma_table_list WHERE name = ?').get(table);
    if (!info) throw new Error(`sortKey '${key}' cannot read ${table} here: no such table`);
    const unique = db.prepare('SELECT name FROM pragma_index_list(?) WHERE "unique" = 1 AND partial = 0').all(table)
        .some(ix => JSON.stringify(db.prepare('SELECT name FROM pragma_index_info(?)').all(ix.name).map(c => c.name)) === JSON.stringify([charColumn]));
    if (!unique) throw new Error(`sortKey '${key}': ${table}.${charColumn} must hold one row per character (its PRIMARY KEY or a UNIQUE index)`);
    door.tiebreak = info.wr ? charColumn : 'rowid';
    let walk;
    try {
        walk = db.prepare(`EXPLAIN QUERY PLAN SELECT xs.${charColumn} FROM ${table} xs WHERE xs.${column} IS NOT NULL ORDER BY xs.${column}, xs.${door.tiebreak}`).all().map(r => r.detail);
    } catch (e) {
        throw new Error(`sortKey '${key}' cannot read ${table} here: ${e.message}`);
    }
    if (walk.some(p => /TEMP B-TREE/.test(p)) || !walk.some(p => /USING (?:COVERING )?INDEX/.test(p))) {
        throw new Error(`sortKey '${key}' sorts ${table} to walk it (${walk.join('; ')}); index ${table}(${column}${info.wr ? `, ${charColumn}` : ''})`);
    }
}

/** Make an extension ready in one library: pending migrations, then every door proven; throws naming what refused. */
export function readyLibrary(db, owner) {
    let ready = _ready.get(db);
    if (!ready) _ready.set(db, ready = new Set());
    if (ready.has(owner)) return;
    runExtensionMigrations(db, owner);
    const e = _owners.get(owner);
    if (e) {
        for (const door of [...e.projections.values(), ...e.ruleFields.values()]) proveDoor(db, door);
        for (const door of e.sortKeys.values()) proveSortKey(db, door);
    }
    // a migration may have written rows no report named
    _splits.delete(db);
    ready.add(owner);
}

// the query path's form: a library that cant be made ready fails the extension, and the query goes on without it
function readyForQuery(db, owner, e) {
    try {
        readyLibrary(db, owner);
        return true;
    } catch (err) {
        e.onFail?.(err, db);
        return false;
    }
}

/** The select-list fragment for the on extensions' projection fields, and the aliases it adds (x:<owner>:<key>). */
export function projectionSelect(db) {
    let sql = '';
    const aliases = [];
    for (const [owner, e] of [..._owners]) {
        if (!e.projections.size || !e.enabled(db) || !readyForQuery(db, owner, e)) continue;
        for (const door of e.projections.values()) {
            const alias = `x:${owner}:${door.key}`;
            sql += `, (SELECT ${door.column} FROM ${door.table} WHERE ${door.charColumn} = c.id) AS "${alias}"`;
            aliases.push(alias);
        }
    }
    return { sql, aliases };
}

function operand(type, op, v) {
    if (type === 'number') return Number(v);
    if (type === 'date') return op === 'in_the_last' ? Date.now() - Number(v) * 86400000 : Date.parse(v);
    return String(v);
}

/** An extension rule field's ops in the core builders' shape; undefined when unknown or its owner is off for this account. */
export function extRuleOps(db, field) {
    const m = FIELD_RE.exec(String(field));
    const e = m && _owners.get(m[1]);
    const door = e?.ruleFields.get(m[2]);
    if (!door || !e.enabled(db) || !readyForQuery(db, m[1], e)) return undefined;
    // a NULL in a NOT IN set matches nothing, and the author's table may let the key column hold one
    const set = (cond, negate = false) => `c.id ${negate ? 'NOT IN' : 'IN'} (SELECT ${door.charColumn} FROM ${door.table} WHERE ${door.charColumn} IS NOT NULL AND ${door.column} ${cond})`;
    const ops = Object.create(null);
    for (const [op, cmp] of Object.entries(RULE_OPS[door.type])) {
        ops[op] = cmp.includes('?')
            ? (v) => ({ sql: set(cmp), params: [operand(door.type, op, v)] })
            : () => ({ sql: set(cmp), params: [] });
    }
    ops.is_set = () => ({ sql: set('IS NOT NULL'), params: [] });
    ops.is_not_set = () => ({ sql: set('IS NOT NULL', true), params: [] });
    return ops;
}

/**
 * The sort key behind `ext.<owner>.<key>` ({ table, column, charColumn, tiebreak }), or
 * undefined when the key is unknown or its owner is off for this account.
 */
export function extSortKey(db, sort) {
    const m = FIELD_RE.exec(String(sort));
    const e = m && _owners.get(m[1]);
    const door = e?.sortKeys.get(m[2]);
    if (!door || !e.enabled(db) || !readyForQuery(db, m[1], e)) return undefined;
    return door;
}

/** The split a query shape was last found to have in this library, or undefined. */
export function knownSplit(db, shape) {
    return _splits.get(db)?.get(shape);
}

export function rememberSplit(db, shape, n) {
    let m = _splits.get(db);
    if (!m) _splits.set(db, m = new Map());
    m.delete(shape);
    m.set(shape, n);
    if (m.size > SPLITS_PER_LIBRARY) m.delete(m.keys().next().value);
}

/** What an extension declared, as its inventory row names it; null when it declared nothing. */
export function queryDoorsOf(owner) {
    const e = _owners.get(owner);
    if (!e || (!e.projections.size && !e.ruleFields.size && !e.sortKeys.size)) return null;
    return {
        projections: [...e.projections.keys()],
        ruleFields: [...e.ruleFields.values()].map(d => ({
            key: d.key, field: `ext.${owner}.${d.key}`, label: d.label, type: d.type,
            ops: [...Object.keys(RULE_OPS[d.type]), ...SET_OPS],
        })),
        sortKeys: [...e.sortKeys.values()].map(d => ({ key: d.key, sort: `ext.${owner}.${d.key}`, label: d.label })),
    };
}
