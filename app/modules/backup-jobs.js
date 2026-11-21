// The notifications center's library backup section and the job it follows; it imports only the feed, so node runs it as is.
import { registerFeedPatcher } from './feed.js';

const POLL_MS = 1000;
const LIVE = new Set(['queued', 'running']);
// the settings a missed window is read from: a save of one asks the server again
const SCHEDULE_SETTINGS = new Set(['backupFrequency', 'backupWindowStart', 'backupWindowEnd']);
// a window's end is read on the server's clock; a floor keeps a skewed clock from spinning reads, a ceiling from a far timer
const RECHECK_MIN_MS = 60000;
const RECHECK_MAX_MS = 6 * 3600000;

let _shell = null;
let _job = null;
let _missed = null;
let _reading = null;
let _again = false;
let _pollTimer = 0;
let _recheckTimer = 0;
// the backup this tab started, whose end it says in a toast
let _startedHere = null;
let _verbBusy = false;

/** The account's backup as the server last answered: the job (live, else the last that ended) and a missed window. */
export function backupNow() {
    return { job: _job, missed: _missed };
}

/** Whether a backup is queued or running. */
export function backupLive() {
    return !!_job && LIVE.has(_job.status);
}

function adopt(answer) {
    const job = answer?.job || null;
    if (job && job.id === _startedHere && !LIVE.has(job.status)) {
        _startedHere = null;
        if (job.status === 'done') _shell.showToast(`Backed up ${_shell.formatBytes(job.bytes)}`, 'success');
        else if (job.status === 'failed') _shell.showToast(`Backup failed: ${job.error}`, 'error');
    }
    _job = job;
    _missed = answer?.missed || null;
    recheckAt(answer?.recheckAt);
}

// a missed window can appear when a window ends with no backup to say so: read again then
function recheckAt(at) {
    clearTimeout(_recheckTimer);
    _recheckTimer = 0;
    if (!Number.isFinite(at)) return;
    _recheckTimer = setTimeout(() => { _recheckTimer = 0; void readBackup(); }, Math.min(Math.max(at - Date.now() + 5000, RECHECK_MIN_MS), RECHECK_MAX_MS));
    _recheckTimer.unref?.();
}

function changed() {
    _shell.refreshNotificationsUI();
    _shell.onChange?.(backupNow());
}

/** Read the account's backup and repaint; a change landing mid-read reads once more after it. */
export function readBackup() {
    if (_reading) { _again = true; return _reading; }
    _reading = (async () => {
        do {
            _again = false;
            try {
                const resp = await _shell.apiRequest('/backup/job', 'GET');
                if (resp.ok) adopt(await resp.json());
            } catch { /* the next change or poll reads again */ }
        } while (_again);
        _reading = null;
        changed();
        watch();
    })();
    return _reading;
}

// once a second while one is live, so the copy's progress moves; its end arrives by the feed or this
function watch() {
    if (_pollTimer || !backupLive()) return;
    _pollTimer = setTimeout(() => { _pollTimer = 0; void readBackup(); }, POLL_MS);
}

/**
 * Back Up Now: start a backup and follow it; a refusal throws in the server's words.
 * @returns {Promise<object>} the job as the server answered it
 */
export async function startBackupNow() {
    const job = await _shell.readAnswer(await _shell.apiRequest('/backup', 'POST', {}));
    _startedHere = job.id;
    adopt({ job, missed: null });
    changed();
    void readBackup();
    return job;
}

/** Cancel the queued or running backup, then show the server's answer. */
export async function cancelBackupJob(id) {
    try {
        await _shell.readAnswer(await _shell.apiRequest(`/backup/job/${encodeURIComponent(id)}`, 'DELETE'));
    } catch (e) {
        // one that ended or went meanwhile is what the re-read shows; any other refusal is said
        if (e.status !== 404 && e.status !== 409) _shell.showToast(`Could not stop the backup: ${e.message}`, 'error');
    }
    await readBackup();
}

/** Dismiss a backup that ended, so it leaves the notifications, then show the server's answer. */
export async function dismissBackupJob(id) {
    try {
        await _shell.readAnswer(await _shell.apiRequest(`/backup/job/${encodeURIComponent(id)}?dismiss=true`, 'DELETE'));
    } catch (e) {
        if (e.status !== 404 && e.status !== 409) _shell.showToast(`Could not dismiss the backup: ${e.message}`, 'error');
    }
    await readBackup();
}

/**
 * Answer a missed window: tonight waits for the next one, skip counts this one as taken.
 * @param {'tonight'|'skip'} answer
 */
export async function answerMissedBackup(answer) {
    try {
        await _shell.readAnswer(await _shell.apiRequest('/backup/missed', 'POST', { answer }));
    } catch (e) {
        if (e.status !== 409) _shell.showToast(`Could not save that answer: ${e.message}`, 'error');
    }
    await readBackup();
}

// one verb at a time from the section, so a double tap never sends a second start
async function oneVerbAtATime(fn) {
    if (_verbBusy) return;
    _verbBusy = true;
    try { await fn(); } finally { _verbBusy = false; }
}

/** The section's state for the shell's button: activity while one is live, a warning for a failure or a missed window. */
function sectionStatus() {
    if (backupLive()) return { visible: true, level: 'activity', icon: 'fa-solid fa-database', title: 'Backing up the library' };
    const failed = _job?.status === 'failed';
    const issues = (failed ? 1 : 0) + (_missed ? 1 : 0);
    if (issues) return { visible: true, level: 'warning', badge: issues, title: failed ? 'The library backup failed' : 'A scheduled backup did not run' };
    return { visible: false, level: 'none', title: 'Library backup' };
}

function liveRow(j) {
    const fmt = _shell.formatBytes;
    let sub;
    let bar = '';
    if (j.status === 'queued') sub = 'Waiting for another backup to finish';
    else if (j.stopping) sub = 'Stopping';
    else if (j.phase === 'verify') sub = 'Checking the copy';
    else {
        const pct = j.total > 0 ? Math.min(99, Math.floor(((j.done || 0) / j.total) * 100)) : 0;
        sub = `Copying <span class="notif-row-meta">${fmt(j.done || 0)} of ${fmt(j.total || 0)} &middot; ${pct}%</span>`;
        bar = `<div class="notif-progress"><div class="notif-progress-fill" style="width:${pct}%"></div></div>`;
    }
    return `
        <div class="notif-row is-active">
            <span class="notif-row-icon"><i class="fa-solid fa-database"></i></span>
            <div class="notif-row-body">
                <div class="notif-row-line">
                    <span class="notif-row-name">${j.scheduled ? 'Scheduled backup' : 'Backing up the library'}</span>
                    <button class="notif-row-btn" data-backup-cancel="${j.id}" title="Cancel the backup" aria-label="Cancel the backup"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="notif-row-sub">${sub}</div>
                ${bar}
            </div>
        </div>`;
}

function failedRow(j) {
    const esc = _shell.escapeHtml;
    return `
        <div class="notif-row is-failed">
            <span class="notif-row-icon is-error"><i class="fa-solid fa-triangle-exclamation"></i></span>
            <div class="notif-row-body">
                <div class="notif-row-line">
                    <span class="notif-row-name">Backup failed</span>
                    <button class="notif-row-btn" data-backup-dismiss="${j.id}" title="Dismiss" aria-label="Dismiss"><i class="fa-solid fa-xmark"></i></button>
                </div>
                ${j.error ? `<div class="notif-row-sub notif-row-error">${esc(j.error)}</div>` : ''}
            </div>
        </div>`;
}

function missedRow(m) {
    const day = new Date(m.windowEnd).toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `
        <div class="notif-row">
            <span class="notif-row-icon"><i class="fa-solid fa-clock-rotate-left"></i></span>
            <div class="notif-row-body">
                <div class="notif-row-line">
                    <span class="notif-row-name">Scheduled backup did not run</span>
                </div>
                <div class="notif-row-sub">Missed the quiet hours of ${_shell.escapeHtml(day)}</div>
            </div>
        </div>
        <div class="notif-row-choices">
            <button class="notif-choice is-primary" data-backup-answer="now" title="Back up the library now">Back Up Now</button>
            <button class="notif-choice" data-backup-answer="tonight" title="Wait for the next quiet hours">Tonight</button>
            <button class="notif-choice" data-backup-answer="skip" title="Skip this backup; the next one comes on its usual day">Skip</button>
        </div>`;
}

/** Paint the section in the shell's row vocabulary. */
function renderSection(el) {
    if (!el) return;
    const rows = [];
    if (backupLive()) rows.push(liveRow(_job));
    else if (_job?.status === 'failed') rows.push(failedRow(_job));
    if (_missed && !backupLive()) rows.push(missedRow(_missed));
    el.innerHTML = rows.length
        ? `<div class="notif-list"><div class="notif-header"><i class="fa-solid fa-database"></i><span>Library Backup</span></div>${rows.join('')}</div>`
        : '';
}

function answerFromSection(answer) {
    return oneVerbAtATime(async () => {
        if (answer !== 'now') return answerMissedBackup(answer);
        try {
            await startBackupNow();
        } catch (e) {
            _shell.showToast(`Could not start the backup: ${e.message}`, 'error');
        }
    });
}

/**
 * Contribute the section and read the backup: shell carries apiRequest, readAnswer, registerNotificationSection,
 * refreshNotificationsUI, escapeHtml, formatBytes, showToast and onChange (handed the state on every change).
 */
export function startBackupJobs(shell) {
    _shell = shell;
    const el = shell.registerNotificationSection({ id: 'library-backup', getStatus: sectionStatus, onOpen: (node) => renderSection(node) });
    // one delegated listener on the node the shell keeps
    el?.addEventListener('click', (e) => {
        const cancel = e.target.closest('[data-backup-cancel]');
        if (cancel) { void oneVerbAtATime(() => cancelBackupJob(Number(cancel.dataset.backupCancel))); return; }
        const dismiss = e.target.closest('[data-backup-dismiss]');
        if (dismiss) { void oneVerbAtATime(() => dismissBackupJob(Number(dismiss.dataset.backupDismiss))); return; }
        const answer = e.target.closest('[data-backup-answer]');
        if (answer) void answerFromSection(answer.dataset.backupAnswer);
    });
    registerFeedPatcher('backup', () => readBackup());
    // a schedule's settings saved here or in another tab change what is missed
    const scheduleTouched = (records) => !records || records.some(r => r.all || (r.ids || []).some(k => SCHEDULE_SETTINGS.has(k)));
    registerFeedPatcher('setting', (records) => { if (scheduleTouched(records)) void readBackup(); }, { own: 'both' });
    return readBackup();
}
