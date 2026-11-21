// A library's file read once after the server starts serving, so the operating system keeps it cached and a first search reads memory
import fs from 'node:fs';
import os from 'node:os';
import { onLibraryOpen, forEachOpenLibrary } from '../db/database.js';
import { settingValue } from '../db/settings-store.js';
import { scheduleLibraryJob } from './steps.js';

// the first page the reader asks for gets the disk to itself
export const PRELOAD_WAIT_MS = 8000;
// past this share of free memory the read would push out what the machine is using
export const PRELOAD_MEMORY_SHARE = 0.25;
const CHUNK = 4 << 20;

/**
 * Read a library's file through once, unless the setting is off or the file is past the share of free memory.
 * @param {object} [opts] { free: free memory in bytes, defaults to the machine's }
 * @returns {Promise<{ status: 'read'|'off'|'too-large'|'closed', bytes: number, size: number, ms: number }>}
 */
export async function preloadLibrary(db, { free = os.freemem() } = {}) {
    const t0 = performance.now();
    const answer = (status, bytes = 0, size = 0) => ({ status, bytes, size, ms: Math.round(performance.now() - t0) });
    if (!db.open) return answer('closed');
    if (settingValue(db, 'preloadLibrary', true) === false) return answer('off');
    const file = db.name;
    const size = fs.statSync(file).size;
    if (size > free * PRELOAD_MEMORY_SHARE) return answer('too-large', 0, size);
    const fh = await fs.promises.open(file, 'r');
    const buf = Buffer.allocUnsafe(CHUNK);
    let bytes = 0;
    try {
        // a library closed mid-read stops at the next chunk, so the read holds its file for one chunk at most
        while (db.open) {
            const { bytesRead } = await fh.read(buf, 0, CHUNK, bytes);
            if (!bytesRead) break;
            bytes += bytesRead;
        }
    } finally { await fh.close(); }
    return answer(db.open ? 'read' : 'closed', bytes, size);
}

const MB = (n) => `${Math.round(n / 1e6)} MB`;

function schedulePreload(db, handle, { log, wait }) {
    scheduleLibraryJob(db, 'preload', async () => {
        try {
            const r = await preloadLibrary(db);
            if (r.status === 'read') log(`[preload] ${handle}: ${MB(r.bytes)} read into the file cache in ${(r.ms / 1000).toFixed(1)} s`);
            else if (r.status === 'too-large') log(`[preload] ${handle}: skipped, ${MB(r.size)} is past a quarter of the free memory`);
        } catch (e) { console.error(`[preload] ${handle}: the read failed:`, e.message); }
    }, { wait });
}

/** Preload every library open now and each one opened later; started where the server listens, so a test's app reads nothing. */
export function startLibraryPreload({ log = console.log, wait = PRELOAD_WAIT_MS } = {}) {
    forEachOpenLibrary((db, handle) => schedulePreload(db, handle, { log, wait }));
    return onLibraryOpen((db, handle) => schedulePreload(db, handle, { log, wait }));
}
