import CoreAPI from './core-api.js';
import { registerFeedPatcher } from './feed.js';

// ========================================
// MEDIA DOWNLOAD QUEUE
// Serial background runner for post-import media localization. Jobs wrap
// downloadCharacterMedia one character at a time; pending and active work is a
// media_jobs row per character and resumes in self-scan mode (the
// pipeline re-scans fields and re-discovers the provider link from the card, so only
// charId + phases need to persist). A row cascades with its character.
// ========================================

let jobs = [];              // rich in-memory jobs, FIFO by enqueue order
let working = false;
let abortController = null;

const listeners = new Set();
let _lastNotify = 0;
let _notifyTimer = 0;

// jobs key on the uuid; a filename is refused, not stripped, so the caller still holding one surfaces
function requireCharId(v) {
    const s = String(v || '');
    if (!s) return '';
    if (/\.png$/i.test(s)) {
        console.error('[MediaDLQueue] job identity is the character uuid, not a filename:', s);
        return '';
    }
    return s;
}

// ========================================
// PERSISTENCE (rows: one media_jobs row per character, pending or active only)
// A finished, failed or aborted job lives in this session's list alone, as it always
// did; the row goes the moment the worker is done with it.
// ========================================

// status and delete writes wait for this row id: the worker claims a job in the tick it is enqueued
function persistEnqueue(job) {
    job.persisting = (async () => {
        try {
            const resp = await CoreAPI.apiRequest('/media-jobs', 'POST', { charId: job.charId, name: job.name, phases: job.phases });
            if (!resp.ok) throw new Error(`server returned ${resp.status}`);
            const row = await resp.json();
            job.rowId = Number.isInteger(row?.id) ? row.id : null;
        } catch (e) {
            console.error('[MediaDLQueue] Could not persist the job:', e.message);
            CoreAPI.showToast('Failed to save the download queue', 'error');
        }
    })();
    return job.persisting;
}

// the claim: 'run' (ours, or never persisted), 'drop' (409 another worker's, 404 gone), 'later' (didnt land, recheck)
async function persistStatus(job, status) {
    await job.persisting;
    if (!job.rowId) return 'run';
    try {
        const resp = await CoreAPI.apiRequest(`/media-jobs/${job.rowId}`, 'PATCH', { status });
        if (resp.ok) return 'run';
        if (resp.status === 404) { job.rowId = null; return 'drop'; }
        if (resp.status === 409) return 'drop';
        console.warn('[MediaDLQueue] Status write failed:', resp.status);
    } catch (e) { console.warn('[MediaDLQueue] Status write failed:', e.message); }
    return 'later';
}

// the lease is renewed as files come in: a dead tab's row is taken once it runs out, a live one never
const LEASE_TOUCH_MS = 60 * 1000;
function touchLease(job) {
    const now = Date.now();
    if (!job.rowId || now - (job.leaseAt || 0) < LEASE_TOUCH_MS) return;
    job.leaseAt = now;
    CoreAPI.apiRequest(`/media-jobs/${job.rowId}`, 'PATCH', { touch: true }).catch(e => console.warn('[MediaDLQueue] Lease write failed:', e.message));
}

// leaving hands the active job back (a keepalive write survives unload), so the next session needn't wait out the lease
function handOffActiveJobs() {
    return Promise.all(jobs.filter(j => j.state === 'active' && j.rowId).map(j =>
        CoreAPI.apiRequest(`/media-jobs/${j.rowId}`, 'PATCH', { status: 'pending' }, { keepalive: true }).catch(() => { /* a hand-off lost to the unload waits out its lease */ })));
}

// skipped rows are rechecked when their lease can have run out (a crashed worker), one timer, those rows alone
const RESUME_RETRY_MS = 60 * 1000;
const LEASE_SLACK_MS = 1000;
const _skipped = new Set();
let _resumeRecheck = 0;
let _recheckAt = 0;
function scheduleResumeRecheck(delayMs) {
    const at = Date.now() + Math.max(0, delayMs || 0) + LEASE_SLACK_MS;
    if (_resumeRecheck && _recheckAt <= at) return;
    clearTimeout(_resumeRecheck);
    _recheckAt = at;
    _resumeRecheck = setTimeout(() => { _resumeRecheck = 0; resumePersistedJobs({ recheck: true }); }, at - Date.now());
}

async function persistRemove(job) {
    await job.persisting;
    if (!job.rowId) return;
    const id = job.rowId;
    job.rowId = null;
    try { await CoreAPI.apiRequest(`/media-jobs/${id}`, 'DELETE'); } catch (e) { console.warn('[MediaDLQueue] Row delete failed:', e.message); }
}

// ========================================
// CHANGE NOTIFICATION (throttled; progress ticks fire per file)
// ========================================

function notify(immediate = false) {
    const fire = () => {
        _lastNotify = Date.now();
        for (const cb of listeners) {
            try { cb(); } catch (e) { console.error('[MediaDLQueue] listener failed:', e); }
        }
    };
    if (immediate || Date.now() - _lastNotify > 150) {
        clearTimeout(_notifyTimer);
        _notifyTimer = 0;
        fire();
    } else if (!_notifyTimer) {
        _notifyTimer = setTimeout(() => { _notifyTimer = 0; fire(); }, 150);
    }
}

function onQueueChange(cb) {
    if (typeof cb === 'function') listeners.add(cb);
    return () => listeners.delete(cb);
}

// ========================================
// QUEUE OPERATIONS
// ========================================

/**
 * Add a background download job; a minimal payload (no URL lists) runs in self-scan mode.
 * @param {{charId: string, name: string, phases: object, embeddedUrls?: string[], lorebookUrls?: string[], galleryPageUrls?: string[], providerOverride?: object}} payload
 */
export function enqueueJob(payload) {
    if (!payload?.charId) return false;
    const charId = requireCharId(payload.charId);
    // Re-import of the same character supersedes its queued/failed job
    const existing = jobs.findIndex(j => j.charId === charId && j.state !== 'active' && j.state !== 'done');
    if (existing !== -1) jobs.splice(existing, 1);
    const job = {
        charId,
        name: payload.name || charId,
        phases: payload.phases || undefined,
        embeddedUrls: payload.embeddedUrls,
        lorebookUrls: payload.lorebookUrls,
        galleryPageUrls: payload.galleryPageUrls,
        providerOverride: payload.providerOverride,
        state: 'pending',
        progress: { phase: '', done: 0, total: 0 },
        totals: null,
        error: '',
        enqueuedAt: Date.now(),
        rowId: null,
    };
    jobs.push(job);
    persistEnqueue(job);
    notify(true);
    runNext();
    return true;
}

function retryJob(charId) {
    const job = jobs.find(j => j.charId === charId && (j.state === 'failed' || j.state === 'aborted'));
    if (!job) return false;
    // retry self-scans: the original URL lists may be stale and the card is in the library by now
    job.embeddedUrls = undefined;
    job.lorebookUrls = undefined;
    job.galleryPageUrls = undefined;
    job.providerOverride = undefined;
    job.state = 'pending';
    job.error = '';
    job.progress = { phase: '', done: 0, total: 0 };
    persistEnqueue(job);
    notify(true);
    runNext();
    return true;
}

function removeJob(charId) {
    const job = jobs.find(j => j.charId === charId);
    if (!job) return false;
    if (job.state === 'active') {
        abortController?.abort();
        return true; // worker finalizes it as aborted; caller can remove after
    }
    jobs = jobs.filter(j => j !== job);
    persistRemove(job);
    notify(true);
    return true;
}

function abortCurrentJob() {
    abortController?.abort();
}

function clearFinishedJobs() {
    jobs = jobs.filter(j => j.state === 'pending' || j.state === 'active');
    notify(true);
}

function onCharacterDeleted(charId) {
    const job = jobs.find(j => j.charId === charId);
    if (!job) return;
    if (job.state === 'active') abortController?.abort();
    jobs = jobs.filter(j => j !== job);
    job.rowId = null;   // the row cascaded with the character
    notify(true);
}

function getQueueState() {
    return {
        active: jobs.find(j => j.state === 'active') || null,
        pending: jobs.filter(j => j.state === 'pending'),
        failed: jobs.filter(j => j.state === 'failed' || j.state === 'aborted'),
        done: jobs.filter(j => j.state === 'done'),
    };
}

// ========================================
// WORKER (strictly serial; the pipeline mutates per-folder dedup state)
// ========================================

async function runNext() {
    if (working) return;
    const job = jobs.find(j => j.state === 'pending');
    if (!job) {
        // the jobs drained: the queue's next page, when resume has not read to its end
        if (_resumeCursor) resumeNextPage();
        return;
    }
    working = true;
    job.state = 'active';
    // taken elsewhere, gone, or not landed: the job leaves this list (the recheck resumes an unlanded one)
    const claim = await persistStatus(job, 'active');
    if (claim !== 'run') {
        jobs = jobs.filter(j => j !== job);
        if (claim === 'later') { _skipped.add(job.rowId); scheduleResumeRecheck(RESUME_RETRY_MS); }
        working = false;
        notify(true);
        runNext();
        return;
    }
    job.leaseAt = Date.now();
    abortController = new AbortController();
    notify(true);

    try {
        // the row is committed before the import answers, so a miss is a real error
        const char = await CoreAPI.ensureCharacterById(job.charId);
        if (!char) throw new Error('Character not found in library');

        const result = await CoreAPI.downloadCharacterMedia(char, {
            embeddedUrls: job.embeddedUrls,
            lorebookUrls: job.lorebookUrls,
            galleryPageUrls: job.galleryPageUrls,
            providerOverride: job.providerOverride,
            phases: job.phases,
            signal: abortController.signal,
            onPhaseStart: (phase, ctx) => {
                job.progress.phase = phase;
                job.progress.done = 0;
                job.progress.total = ctx?.count || 0;
                notify();
            },
            onProgress: (phase, current, total) => {
                job.progress.phase = phase;
                job.progress.done = current;
                job.progress.total = total;
                touchLease(job);
                notify();
            },
        });

        job.totals = result?.totals || null;
        if (result?.aborted) {
            job.state = 'aborted';
            job.error = 'Cancelled';
        } else if (result?.incomplete || (result?.totals?.errors || 0) > 0) {
            job.state = 'failed';
            job.error = `${result?.totals?.errors || 0} download error(s)`;
        } else {
            job.state = 'done';
            CoreAPI.markMediaLocalizationComplete(job.charId);
        }
    } catch (e) {
        job.state = 'failed';
        job.error = e?.message || 'Download failed';
        console.error('[MediaDLQueue] Job failed:', job.charId, e);
    } finally {
        working = false;
        abortController = null;
        if (job.state !== 'pending' && job.state !== 'active') persistRemove(job);
        notify(true);
        runNext();
    }
}

// ========================================
// RESUME
// ========================================

// resume reads a page, the next once this tab's jobs drain; the row-id cursor reaches jobs enqueued later
const RESUME_PAGE = 100;
const JOB_IDS_PAGE = 1000;
let _resumeCursor = null;
let _resumeReading = null;

// these job rows as the server holds them now (a row gone is absent), a page of ids at a time
async function readJobRows(ids) {
    const rows = [];
    for (let i = 0; i < ids.length; i += JOB_IDS_PAGE) {
        const page = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/media-jobs?ids=${ids.slice(i, i + JOB_IDS_PAGE).join(',')}&count=false`, 'GET'));
        rows.push(...page.items);
    }
    return rows;
}

// the queue's next page, read once at a time: the boot's first, then each when the jobs drain
function resumeNextPage() {
    if (!_resumeReading) _resumeReading = resumePersistedJobs().finally(() => { _resumeReading = null; });
    return _resumeReading;
}

async function resumePersistedJobs({ recheck = false } = {}) {
    // a recheck reads again only the rows it skipped, and resolves only their characters
    const wanted = recheck ? new Set(_skipped) : null;
    if (wanted && !wanted.size) return;
    let persisted;
    try {
        if (wanted) persisted = await readJobRows([...wanted]);
        else {
            const q = new URLSearchParams({ limit: String(RESUME_PAGE), count: 'false' });
            if (_resumeCursor) q.set('after', _resumeCursor);
            const page = await CoreAPI.readAnswer(await CoreAPI.apiRequest(`/media-jobs?${q}`, 'GET'));
            persisted = page.items;
            _resumeCursor = page.nextCursor ?? null;
        }
    } catch (e) {
        if (wanted) { scheduleResumeRecheck(RESUME_RETRY_MS); return; }
        console.warn('[MediaDLQueue] Resume read failed; nothing more resumed this session:', e.message);
        return;
    }
    if (wanted) {
        // a row gone since, or taken here, leaves the set; one still held elsewhere joins it again below
        for (const id of wanted) _skipped.delete(id);
    }
    CoreAPI.debugLog(`[MediaDLQueue] Resume check: ${persisted.length} persisted entr${persisted.length === 1 ? 'y' : 'ies'}`);
    if (!persisted.length) return;
    // one scoped read for the persisted ids; the row's completion flag skips a finished job
    const existing = new Map(
        (await CoreAPI.fetchCharactersByIds(persisted.map(e => requireCharId(e?.charId)).filter(Boolean)))
            .map(c => [c.id, c]),
    );
    const queued = new Set(jobs.map(j => j.charId));
    let resumed = 0;
    for (const entry of persisted) {
        const charId = requireCharId(entry?.charId);
        if (!charId) {
            CoreAPI.debugLog('[MediaDLQueue] Resume skip (malformed entry):', JSON.stringify(entry));
            continue;
        }
        if (existing.get(charId)?.mediaLocalized) {
            CoreAPI.debugLog('[MediaDLQueue] Resume skip (already completed):', charId);
            persistRemove({ rowId: entry.id });
            continue;
        }
        if (!existing.has(charId)) {
            CoreAPI.debugLog('[MediaDLQueue] Resume skip (character not found):', charId);
            continue;
        }
        // an active row is another tab's worker's, unless that worker stopped renewing its lease
        if (entry.status === 'active' && !entry.stale) {
            CoreAPI.debugLog('[MediaDLQueue] Resume skip (another tab is working on it):', charId);
            _skipped.add(entry.id);
            scheduleResumeRecheck(entry.leaseLeftMs);
            continue;
        }
        if (queued.has(charId)) continue;
        queued.add(charId);
        jobs.push({
            charId,
            name: entry.name || charId,
            phases: entry.phases || undefined,
            state: 'pending',
            progress: { phase: '', done: 0, total: 0 },
            totals: null,
            error: '',
            enqueuedAt: Date.now(),
            rowId: Number.isInteger(entry.id) ? entry.id : null,
        });
        resumed++;
    }
    if (resumed > 0) {
        CoreAPI.debugLog(`[MediaDLQueue] Resumed ${resumed} persisted job(s)`);
        notify(true);
        runNext();
    } else if (!wanted && _resumeCursor) {
        // a page that resumed nothing (done, gone, or another tab's) asks for the next one now
        await resumePersistedJobs();
    }
}

// another tab's word on the rows: re-read (records name ids, not state) only for our pending jobs; a lease touch reads nothing
async function patchMediaJobsFromFeed(records) {
    const moved = records ? records.filter(r => !(r.op === 'updated' && r.fields?.length === 1 && r.fields[0] === 'updatedAt')) : null;
    if (moved && !moved.length) return;
    if (!moved && _skipped.size) scheduleResumeRecheck(0);
    for (const r of moved || []) {
        if (!(r.ids || []).some(id => _skipped.has(id))) continue;
        if (r.op === 'deleted') r.ids.forEach(id => _skipped.delete(id));
        else scheduleResumeRecheck(0);
    }
    const pending = jobs.filter(j => j.state === 'pending' && j.rowId);
    if (!pending.length) return;
    const gone = new Set(moved ? moved.filter(r => r.op === 'deleted').flatMap(r => r.ids || []) : []);
    const held = new Set(pending.map(j => j.rowId));
    let rows = null;
    if (!moved || moved.some(r => r.op !== 'deleted' && (r.ids || []).some(id => held.has(id)))) {
        try {
            rows = new Map((await readJobRows([...held])).map(r => [r.id, r]));
        } catch (e) { console.warn('[MediaDLQueue] Row re-read failed:', e.message); }
    }
    const before = jobs.length;
    jobs = jobs.filter(j => {
        if (j.state !== 'pending' || !j.rowId) return true;
        if (gone.has(j.rowId)) return false;
        if (!rows) return true;
        const row = rows.get(j.rowId);
        return !!row && (row.status !== 'active' || row.stale);
    });
    if (jobs.length !== before) notify(true);
}

// ========================================
// NOTIFICATIONS SECTION
// ========================================

const PHASE_LABELS = {
    embedded: 'Embedded media',
    lorebook: 'Lorebook media',
    providerGallery: 'Provider gallery',
    extGallery: 'External galleries',
};

function sectionStatus() {
    const s = getQueueState();
    const activeCount = (s.active ? 1 : 0) + s.pending.length;
    if (activeCount > 0) {
        return {
            visible: true,
            level: 'activity',
            icon: 'fa-solid fa-download',
            title: `Downloading media in background (${activeCount} job${activeCount === 1 ? '' : 's'})`,
        };
    }
    if (s.failed.length > 0) {
        return {
            visible: true,
            level: 'warning',
            badge: s.failed.length,
            title: `${s.failed.length} background media download${s.failed.length === 1 ? '' : 's'} failed`,
        };
    }
    // Recently finished jobs stay reviewable until cleared
    return { visible: s.done.length > 0, level: 'none', title: 'Background media downloads' };
}

function renderSection(el) {
    if (!el) return;
    const esc = CoreAPI.escapeHtml;
    const s = getQueueState();
    if (!s.active && !s.pending.length && !s.failed.length && !s.done.length) {
        el.innerHTML = '';
        return;
    }
    const parts = ['<div class="notif-list">'];
    parts.push('<div class="notif-header"><i class="fa-solid fa-download"></i><span>Media Downloads</span></div>');

    if (s.active) {
        const p = s.active.progress;
        const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
        const phaseLabel = PHASE_LABELS[p.phase] || 'Preparing';
        const sub = p.total ? `${esc(phaseLabel)} <span class="notif-row-meta">${p.done}/${p.total} &middot; ${pct}%</span>` : `${esc(phaseLabel)}&hellip;`;
        parts.push(`
            <div class="notif-row is-active">
                <span class="notif-row-icon"><i class="fa-solid fa-cloud-arrow-down"></i></span>
                <div class="notif-row-body">
                    <div class="notif-row-line">
                        <span class="notif-row-name">${esc(s.active.name)}</span>
                        <button class="notif-row-btn" data-mdq-abort title="Cancel this download"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                    <div class="notif-row-sub">${sub}</div>
                    <div class="notif-progress"><div class="notif-progress-fill" style="width:${pct}%"></div></div>
                </div>
            </div>`);
    }
    if (s.pending.length > 0) {
        parts.push(`<div class="notif-pending"><i class="fa-solid fa-hourglass-half"></i> ${s.pending.length} more queued</div>`);
    }
    for (const job of s.failed) {
        parts.push(`
            <div class="notif-row is-failed">
                <span class="notif-row-icon is-error"><i class="fa-solid fa-triangle-exclamation"></i></span>
                <div class="notif-row-body">
                    <div class="notif-row-line">
                        <span class="notif-row-name">${esc(job.name)}</span>
                        <span class="notif-row-actions">
                            <button class="notif-row-btn" data-mdq-retry="${esc(job.charId)}" title="Retry"><i class="fa-solid fa-rotate-right"></i></button>
                            <button class="notif-row-btn" data-mdq-remove="${esc(job.charId)}" title="Dismiss"><i class="fa-solid fa-xmark"></i></button>
                        </span>
                    </div>
                    <div class="notif-row-sub notif-row-error">${esc(job.error || 'Failed')}</div>
                </div>
            </div>`);
    }
    if (s.done.length > 0) {
        parts.push(`
            <div class="notif-done-row">
                <span><i class="fa-solid fa-circle-check"></i> ${s.done.length} completed</span>
                <button class="notif-row-btn" data-mdq-clear title="Clear finished"><i class="fa-solid fa-broom"></i></button>
            </div>`);
    }
    parts.push('</div>');
    el.innerHTML = parts.join('');
}

function wireSectionEvents(el) {
    // One delegated listener on the persistent section node
    el.addEventListener('click', (e) => {
        const abortBtn = e.target.closest('[data-mdq-abort]');
        if (abortBtn) { abortCurrentJob(); return; }
        const retryBtn = e.target.closest('[data-mdq-retry]');
        if (retryBtn) { retryJob(retryBtn.dataset.mdqRetry); return; }
        const removeBtn = e.target.closest('[data-mdq-remove]');
        if (removeBtn) { removeJob(removeBtn.dataset.mdqRemove); return; }
        if (e.target.closest('[data-mdq-clear]')) clearFinishedJobs();
    });
}

// ========================================
// INIT
// ========================================

function init() {
    // the shell makes the slot and repaints it while the dropdown is open
    const sectionEl = CoreAPI.registerNotificationSection({
        id: 'media-downloads',
        getStatus: sectionStatus,
        onOpen: (el) => renderSection(el),
    });
    if (sectionEl) wireSectionEvents(sectionEl);
    onQueueChange(() => CoreAPI.refreshNotificationsUI());
    CoreAPI.onCharactersDeleted((ids) => ids.forEach(onCharacterDeleted));
    registerFeedPatcher('mediaJob', patchMediaJobsFromFeed);
    window.addEventListener('pagehide', handOffActiveJobs);

    // a resumed job finds its provider at run time, and provider extensions register late: wait (with a timeout)
    const extensionsSettled = new Promise(resolve => {
        document.addEventListener('cl-extensions-settled', resolve, { once: true });
        setTimeout(resolve, 10000);
    });
    extensionsSettled.then(() => resumeNextPage());
}

export default {
    init,
    enqueueJob,
};
