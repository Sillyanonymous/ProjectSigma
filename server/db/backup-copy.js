// A backup's copy and its check, run as a child of the server so a long copy never holds its event loop
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/** A consistent copy of the library file into a new file (SQLite's VACUUM INTO), on a connection of its own. */
export function copyLibrary(dbFile, file) {
    const db = new Database(dbFile, { readonly: true, fileMustExist: true, timeout: 30000 });
    try {
        db.prepare('VACUUM INTO ?').run(file);
    } finally {
        db.close();
    }
}

/** About what a copy of this open library writes: its pages in use, the free ones being what VACUUM INTO leaves out. */
export function copyBytes(db) {
    const n = (name) => db.pragma(name, { simple: true });
    return (n('page_count') - n('freelist_count')) * n('page_size');
}

/** SQLite's integrity_check against a finished backup copy; throws rather than leave a bad file looking like protection. */
export function verifyBackupCopy(file) {
    const copy = new Database(file, { readonly: true });
    try {
        const r = copy.pragma('integrity_check', { simple: true });
        if (r !== 'ok') throw new Error(`backup failed verification: ${r}`);
    } finally {
        copy.close();
    }
}

// node backup-copy.js <library file> <copy>: a line names the phase, the exit code says how it ended
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
    const [dbFile, file] = process.argv.slice(2);
    try {
        process.stdout.write('copy\n');
        copyLibrary(dbFile, file);
        process.stdout.write('verify\n');
        verifyBackupCopy(file);
    } catch (e) {
        // exitCode, not exit(): a pipe off Windows writes async, and exit() would drop the reason
        process.stderr.write(`${e?.message || String(e)}\n`);
        process.exitCode = 1;
    }
}
