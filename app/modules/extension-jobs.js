// The notifications center's extension jobs section; it imports only the feed, so node runs it as is.
import { registerFeedPatcher } from './feed.js';

const POLL_MS = 2000;
const IN_FLIGHT = new Set(['running', 'queued']);
const ENDED = new Set(['done', 'failed', 'cancelled']);

let _shell = null;
let _jobs = [];
let _reading = null;
let _again = false;
let _pollTimer = 0;

/** The jobs as the server last answered them, in its order. */
export function jobsNow() {
    return _jobs;
}

/** Read the account's jobs and repaint; a change landing mid-read reads once more after it. */
export function readJobs() {
    if (_reading) { _again = true; return _reading; }
    _reading = (async () => {
        do {
            _again = false;
            try {
                const resp = await _shell.apiRequest('/extensions/jobs', 'GET');
                if (resp.ok) {
                    const list = await resp.json();
                    _jobs = Array.isArray(list) ? list : [];
                }
            } catch { /* the next change or poll reads again */ }
        } while (_again);
        _reading = null;
        _shell.refreshNotificationsUI();
        watch();
    })();
    return _reading;
}

// every 2s while one is in flight (the JanitorAI lane's cadence), so a running job's progress moves
function watch() {
    if (_pollTimer || !_jobs.some(j => IN_FLIGHT.has(j.status))) return;
    _pollTimer = setTimeout(() => { _pollTimer = 0; void readJobs(); }, POLL_MS);
}

/**
 * Cancel a queued or running job, or dismiss a finished one, then show the server's answer.
 * @returns {Promise<boolean>} whether the server did it
 */
async function cancelJob(id) {
    let ok = false;
    try {
        const resp = await _shell.apiRequest(`/extensions/jobs/${encodeURIComponent(id)}`, 'DELETE');
        ok = resp.ok;
        // a job thats already gone is what the re-read shows; any other refusal is said
        if (!ok && resp.status !== 404) _shell.showToast('Could not stop that job', 'error');
    } catch {
        _shell.showToast('Could not stop that job', 'error');
    }
    await readJobs();
    return ok;
}

/** Dismiss every finished job, then show the server's answer. */
async function clearFinishedJobs() {
    let ok = false;
    try {
        ok = (await _shell.apiRequest('/extensions/jobs', 'DELETE')).ok;
        if (!ok) _shell.showToast('Could not clear the finished jobs', 'error');
    } catch {
        _shell.showToast('Could not clear the finished jobs', 'error');
    }
    await readJobs();
    return ok;
}

/** The section's state for the shell's button: activity while one is in flight, a warning for a failure. */
function jobsStatus() {
    const inFlight = _jobs.filter(j => IN_FLIGHT.has(j.status)).length;
    const failed = _jobs.filter(j => j.status === 'failed').length;
    if (inFlight) return { visible: true, level: 'activity', icon: 'fa-solid fa-gears', title: `${inFlight} extension job${inFlight === 1 ? '' : 's'} in progress` };
    if (failed) return { visible: true, level: 'warning', badge: failed, title: `${failed} extension job${failed === 1 ? '' : 's'} failed` };
    return { visible: _jobs.length > 0, level: 'none', title: 'Extension jobs' };
}

/** Paint the section in the shell's row vocabulary (the media queue's). */
function renderJobs(el) {
    if (!el) return;
    if (!_jobs.length) { el.innerHTML = ''; return; }
    const esc = _shell.escapeHtml;
    const parts = ['<div class="notif-list">', '<div class="notif-header"><i class="fa-solid fa-gears"></i><span>Extension Jobs</span></div>'];
    for (const j of _jobs.filter(x => x.status === 'running')) {
        const p = j.progress || {};
        const counted = Number.isFinite(p.done) && Number.isFinite(p.total) && p.total > 0;
        const pct = counted ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
        const meta = counted ? ` <span class="notif-row-meta">${p.done}/${p.total} &middot; ${pct}%</span>` : '';
        parts.push(`
            <div class="notif-row is-active">
                <span class="notif-row-icon"><i class="fa-solid fa-gear"></i></span>
                <div class="notif-row-body">
                    <div class="notif-row-line">
                        <span class="notif-row-name">${esc(j.label)}</span>
                        <button class="notif-row-btn" data-ext-job-cancel="${esc(String(j.id))}" title="Cancel this job"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div class="notif-row-sub">${[j.extensionName || j.extension, p.note].filter(Boolean).map(esc).join(' &middot; ')}${meta}</div>
                    ${counted ? `<div class="notif-progress"><div class="notif-progress-fill" style="width:${pct}%"></div></div>` : ''}
                </div>
            </div>`);
    }
    const queued = _jobs.filter(j => j.status === 'queued').length;
    if (queued) parts.push(`<div class="notif-pending"><i class="fa-solid fa-hourglass-half"></i> ${queued} more queued</div>`);
    for (const j of _jobs.filter(x => x.status === 'failed')) {
        parts.push(`
            <div class="notif-row is-failed">
                <span class="notif-row-icon is-error"><i class="fa-solid fa-triangle-exclamation"></i></span>
                <div class="notif-row-body">
                    <div class="notif-row-line">
                        <span class="notif-row-name">${esc(j.label)}</span>
                        <button class="notif-row-btn" data-ext-job-cancel="${esc(String(j.id))}" title="Dismiss"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div class="notif-row-sub notif-row-error">${esc(j.error || 'Failed')}</div>
                </div>
            </div>`);
    }
    const finished = _jobs.filter(j => ENDED.has(j.status) && j.status !== 'failed').length;
    if (finished) {
        parts.push(`
            <div class="notif-done-row">
                <span><i class="fa-solid fa-circle-check"></i> ${finished} finished</span>
                <button class="notif-row-btn" data-ext-job-clear title="Clear finished"><i class="fa-solid fa-broom"></i></button>
            </div>`);
    }
    parts.push('</div>');
    el.innerHTML = parts.join('');
}

/**
 * Contribute the section and read the jobs: shell carries apiRequest, registerNotificationSection,
 * refreshNotificationsUI, escapeHtml and showToast.
 */
export function startExtensionJobs(shell) {
    _shell = shell;
    const el = shell.registerNotificationSection({ id: 'extension-jobs', getStatus: jobsStatus, onOpen: (node) => renderJobs(node) });
    // one delegated listener on the node the shell keeps
    el?.addEventListener('click', (e) => {
        const cancel = e.target.closest('[data-ext-job-cancel]');
        if (cancel) { void cancelJob(Number(cancel.dataset.extJobCancel)); return; }
        if (e.target.closest('[data-ext-job-clear]')) void clearFinishedJobs();
    });
    registerFeedPatcher('extensionJob', () => readJobs());
    return readJobs();
}
