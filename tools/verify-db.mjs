// Consistency doctor for real libraries: server/db/invariants.js against every home; exit 1 on a finding.
//   node tools/verify-db.mjs [--user <handle>] [--db-only: skip the disk walk]   (npm run verify)

//   --repair <check>: a check's findings repaired after a backup; --drop-leftover <id> [--yes]: a removed
//   extension's tables dropped after a backup, asked first
import fs from 'node:fs';
import readline from 'node:readline/promises';
import Database from 'better-sqlite3';

const { MIGRATION_COUNT } = await import('../server/db/database.js');
const { bindInvariants, INVARIANTS } = await import('../server/db/invariants.js');
const { freshSchema, schemaOwnership, dropLeftoverExtension } = await import('../server/db/schema-catalog.js');
const { presentExtensionIds } = await import('../server/lib/extensions.js');
const { loadPersistedNamespaces } = await import('../server/lib/provider-namespaces.js');
const { takeBackup } = await import('../server/lib/backup-core.js');
const { config, userPaths, HANDLE_RE } = await import('../server/config.js');
// the divert list this data dir's server runs with: first-party plus every ratcheted
// extension namespace (server.db), the same list the promotion sweep clears blobs of
loadPersistedNamespaces();

const args = process.argv.slice(2);
const onlyUser = args.includes('--user') ? args[args.indexOf('--user') + 1] : null;
const dbOnly = args.includes('--db-only');
// --repair <check>: that check's findings repaired first, after a backup, on a home at this build's schema
const repairName = args.includes('--repair') ? args[args.indexOf('--repair') + 1] : null;
const repairable = INVARIANTS.filter(i => typeof i.repair === 'function');
const toRepair = repairName === null ? null : repairable.find(i => i.name === repairName);
if (repairName !== null && !toRepair) {
    console.log(`verify: no check named "${repairName}" has a repair; the ones that do: ${repairable.map(i => i.name).join(', ')}`);
    process.exit(2);
}

// who owns what: the schema this build gives a fresh library, and the extensions with a folder in the tree
const core = freshSchema().library.objects;
const extensionIds = presentExtensionIds();
const dropId = args.includes('--drop-leftover') ? args[args.indexOf('--drop-leftover') + 1] ?? '' : null;
const yes = args.includes('--yes');
if (dropId !== null) {
    if (!dropId || dropId.startsWith('--')) {
        console.log('verify: --drop-leftover names the id of the extension whose tables go');
        process.exit(2);
    }
    if (extensionIds.includes(dropId)) {
        console.log(`verify: '${dropId}' is still installed, so its tables are not left over; remove it first`);
        process.exit(2);
    }
    if (!yes && !process.stdin.isTTY) {
        console.log('verify: --drop-leftover asks before it drops anything; run it in a terminal, or pass --yes');
        process.exit(2);
    }
}
const ask = async (question) => {
    if (yes) return true;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return /^y(es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
};

const handles = onlyUser ? [onlyUser]
    : fs.readdirSync(config.dataDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && HANDLE_RE.test(e.name) && fs.existsSync(userPaths(e.name).dbFile))
        .map(e => e.name);

let failed = 0;
const titleOf = Object.fromEntries(INVARIANTS.map(i => [i.name, i.title]));
const report = (name, findings) => {
    if (!findings.length) { console.log(`  PASS ${titleOf[name]}`); return; }
    failed++;
    console.log(`  FAIL ${titleOf[name]} (${findings.length})`);
    for (const f of findings.slice(0, 10)) console.log(`    ${f}`);
    if (findings.length > 10) console.log(`    ... +${findings.length - 10} more`);
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const KINDS = [['table', 'table', 'tables'], ['index', 'index', 'indexes'], ['trigger', 'trigger', 'triggers'], ['view', 'view', 'views'], ['shadow', 'FTS shadow table', 'FTS shadow tables']];
const countOf = (objects) => KINDS.map(([type, one, many]) => [objects.filter(o => o.type === type).length, one, many])
    .filter(([k]) => k).map(([k, one, many]) => plural(k, one, many)).join(', ') || 'nothing';
const named = (objects) => objects.map(o => `${o.type} ${o.name}${o.type === 'index' || o.type === 'trigger' ? ` on ${o.table}` : ''}`);
const listed = (lines) => { for (const l of lines.slice(0, 10)) console.log(`    ${l}`); if (lines.length > 10) console.log(`    ... +${lines.length - 10} more`); };

// what each object of the library is: core as this build makes it, each extension's, a leftover's, nobody's
function reportOwnership(db) {
    const own = schemaOwnership(db, { core, extensionIds });
    console.log(`  OWNERSHIP core: ${countOf(own.core)}${own.drift.length ? `, and ${own.drift.length} in another form` : ''}`);
    for (const e of own.extensions) {
        if (e.installed) console.log(`  OWNERSHIP ${e.id} (installed): ${countOf(e.objects)}`);
        else {
            console.log(`  OWNERSHIP ${e.id} (LEFTOVER: no longer installed): ${countOf(e.objects)}; npm run verify -- --drop-leftover ${e.id} drops them after a backup`);
            listed(named(e.objects));
        }
    }
    if (own.drift.length) {
        failed++;
        console.log(`  FAIL core objects in another form than this build makes them (${own.drift.length})`);
        listed(named(own.drift));
    }
    if (own.missing.length) {
        failed++;
        console.log(`  FAIL core objects this build makes that the library lacks (${own.missing.length})`);
        listed(named(own.missing));
    }
    if (own.unknown.length) {
        failed++;
        console.log(`  FAIL objects neither this build's nor an extension's (${own.unknown.length})`);
        listed(named(own.unknown));
    }
}

for (const user of handles) {
    const paths = userPaths(user);
    console.log(`\n=== ${user} (${paths.dbFile})`);
    // a running server may hold a write: wait for it as the server waits for an outside writer
    const db = new Database(paths.dbFile, { timeout: 30000 });
    // a home nobody opened since an upgrade is legitimately behind, so checks needing the new shape skip by name
    const schemaVersion = db.pragma('user_version', { simple: true });
    // a newer build wrote this home: the server refuses to open it, and these checks know only this build's shape
    if (schemaVersion > MIGRATION_COUNT) {
        failed++;
        console.log(`  FAIL schema is at ${schemaVersion}, ahead of this build's ${MIGRATION_COUNT}; a newer server wrote this home, so no check ran`);
        db.close();
        continue;
    }
    const schemaCurrent = schemaVersion === MIGRATION_COUNT;
    if (!schemaCurrent) console.log(`  NOTE schema is at ${schemaVersion} of ${MIGRATION_COUNT}; it migrates when the server next opens this home`);
    if (toRepair && !schemaCurrent) {
        console.log(`  SKIP repair of ${toRepair.title}: the schema is behind; open the server once so it migrates, then repair`);
    } else if (toRepair) {
        const found = toRepair.run(db, { paths, schemaCurrent }).length;
        if (!found) console.log(`  REPAIR ${toRepair.title}: nothing to repair`);
        else {
            // the backup the Backup button takes, before a row moves; the deletes cascade to what is keyed on them
            const backup = await takeBackup(db, paths);
            db.pragma('foreign_keys = ON');
            console.log(`  REPAIRED ${toRepair.title}: ${toRepair.repair(db)} of ${found}, after a backup to ${backup.file}`);
        }
    }
    if (dropId !== null && !schemaCurrent) {
        console.log(`  SKIP drop of ${dropId}: the schema is behind; open the server once so it migrates, then drop`);
    } else if (dropId !== null) {
        const group = schemaOwnership(db, { core, extensionIds }).extensions.find(e => e.id === dropId);
        const recorded = db.prepare('SELECT COUNT(*) FROM ext_migrations WHERE ext_id = ?').pluck().get(dropId);
        if (!group && !recorded) console.log(`  DROP ${dropId}: nothing of it in this library`);
        else {
            console.log(`  DROP ${dropId}: ${group ? countOf(group.objects) : 'no tables'}, and its record of ${plural(recorded, 'migration', 'migrations')}`);
            if (group) listed(named(group.objects));
            if (!(await ask(`  Drop them from ${user}'s library? A backup is taken first. [y/N] `))) console.log(`  DROP ${dropId}: left as it is`);
            else {
                const backup = await takeBackup(db, paths);
                const dropped = dropLeftoverExtension(db, dropId, { core, extensionIds });
                console.log(`  DROPPED ${dropId}: ${plural(dropped.length, 'object', 'objects')} and its migration record, after a backup to ${backup.file}`);
            }
        }
    }
    const { checks, skipped } = bindInvariants(db, { paths, dbOnly, schemaCurrent });
    for (const [name, fn] of Object.entries(checks)) report(name, fn());
    for (const s of skipped) console.log(`  SKIP ${titleOf[s.name]} (${s.why})`);
    // ownership is against this build's schema, which a home behind it does not have yet
    if (schemaCurrent) reportOwnership(db);
    else console.log('  SKIP schema ownership (the schema is behind this build\'s)');
    db.close();
}

console.log(failed ? `\nverify: ${failed} check(s) FAILED` : '\nverify: every check passed');
process.exit(failed ? 1 : 0);
