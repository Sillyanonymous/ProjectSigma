// Lets go of what the process holds for a deleted account; an open library pins its folder on Windows

import { closeDb } from '../db/database.js';
import { forgetAccountPaths } from '../auth.js';
import { cancelAccountJobs, clearFinishedJobs } from './ext-jobs.js';
import { forgetAccountSetJobs } from './set-jobs.js';
import { forgetAccountBackups } from './backup-core.js';
import { forgetAccountStats } from './ext-hooks.js';
import { forgetAccountSlots } from '../services/shared.js';

/** Call after the account's row is gone, so no request can open its library again. */
export function forgetAccount(handle) {
    cancelAccountJobs(handle);
    // after the cancel, which files each cancelled job as finished
    clearFinishedJobs(handle);
    forgetAccountSetJobs(handle);
    forgetAccountBackups(handle);
    forgetAccountStats(handle);
    forgetAccountSlots(handle);
    forgetAccountPaths(handle);
    closeDb(handle);
}
