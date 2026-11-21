// Every library's fingerprint queue drained in the background once it opens (an upgrade queues every card, a write elsewhere queues its own)
import { onLibraryOpen, forEachOpenLibrary } from '../db/database.js';
import { fingerprintsPending, scheduleFingerprintRefresh } from '../db/fingerprint-index.js';

const drainIfQueued = (db) => { if (fingerprintsPending(db)) scheduleFingerprintRefresh(db); };

/** Drain every library open now and each one opened later (an upgrade's queue), started where the server listens; a character change drains anywhere. */
export function startFingerprintRefresh() {
    forEachOpenLibrary(drainIfQueued);
    return onLibraryOpen(drainIfQueued);
}
