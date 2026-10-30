// Scheduled library backups. A background job, not a route: it has no req.db and opens libraries itself.
import { forEachAccountLibrary } from '../db/server-store.js';
import { openDb } from '../db/database.js';
import { settingValue } from '../db/settings-store.js';
import { startBackup, tickBackupSchedule } from './backup-core.js';

let timer = null;
let serverDbHandle = null;   // only needed to enumerate users in multi-user mode
const TICK_MS = 15 * 60 * 1000;

/**
 * One tick for every user, each by their own settings and window; one library failing never stops the rest.
 *
 * @returns {Array<{handle: string, id: number}>} the backups it queued (whenBackupsIdle waits for them)
 */
export function runDueBackups({ now = Date.now(), log = () => {}, serverDb = serverDbHandle } = {}) {
    const queued = [];
    forEachAccountLibrary({ serverDb, enabledOnly: false, onError: (handle, e) => log(`[backup] scheduled backup failed for ${handle}: ${e.message}`) }, ({ handle, paths }) => {
        const db = openDb(handle);
        const schedule = tickBackupSchedule(db, paths.backupsDir, { now });
        if (!schedule?.runNow) return;
        // routine success is debug-gated on the backed-up user's own toggle; a failure stays loud
        const onEnd = (job) => {
            if (job.status === 'failed') log(`[backup] scheduled backup failed for ${handle}: ${job.error}`);
            else if (job.status === 'done' && settingValue(db, 'debugMode', false)) log(`[backup] scheduled backup for ${handle}: ${job.file} (${job.bytes} bytes)`);
        };
        const job = startBackup(db, paths, { scheduled: true, windowEnd: schedule.windowEnd, onEnd });
        queued.push({ handle, id: job.id });
    });
    return queued;
}

export function startBackupScheduler({ serverDb = null, log = console.log } = {}) {
    if (timer) return timer;
    serverDbHandle = serverDb;
    // no tick on boot: the first look waits a tick, so a restart in the window never races its own startup
    timer = setInterval(() => runDueBackups({ log }), TICK_MS);
    timer.unref?.();
    return timer;
}
