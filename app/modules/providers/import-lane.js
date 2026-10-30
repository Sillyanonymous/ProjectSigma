/**
 * The background import lane every browse view shares: one import per provider at a time, its rows in one notifications section.
 */

import CoreAPI from '../core-api.js';
import { importThroughCommand, finishBrowseImport } from './provider-utils.js';

const IMPORTING_BADGE = '<span class="browse-feature-badge importing" title="Importing in the background"><i class="fa-solid fa-circle-notch fa-spin"></i></span>';

const lanes = new Map();   // provider id -> entries, the running one first
// finished entries still asking something (a failure, media waiting), newest first; never dropped for space
let finished = [];         // { seq, name, ok, error, media, retry, present }
let importedCount = 0;     // the ones that landed and ask nothing more
let presentCount = 0;      // the ones the server skipped as already in the library
const batchRuns = new Map();   // provider id -> { total, failed, present } of the batch entries since its lane last drained
let seq = 0;
let sectionEl = null;

// ========================================
// THE REGISTRY
// ========================================

/** The import in flight for this view's card with this link key, or null. */
export function findImport(view, linkKey) {
    if (linkKey == null || linkKey === '') return null;
    for (const queue of lanes.values()) {
        for (const entry of queue) if (entry.view === view && entry.linkKey === String(linkKey)) return entry;
    }
    return null;
}

/** Every import in flight that this view started, the running ones first. */
export function importsOf(view) {
    const out = [];
    for (const queue of lanes.values()) for (const entry of queue) if (entry.view === view) out.push(entry);
    return out;
}

/** How many imports wait ahead of this one in its provider's lane. */
export function positionOf(entry) {
    const queue = lanes.get(entry.provider) || [];
    return Math.max(0, queue.indexOf(entry));
}

/**
 * Put one import on its provider's lane; the entry carries the import's inputs, the view, its hit and the row's name.
 * @param {Object} spec
 * @param {Function} [spec.run] - the import itself, answering a ProviderImportResult, when it is more than the plain command
 * @param {boolean} [spec.batch] - one of a batch the reader confirmed whole: its media queues unasked
 * @returns {Object} the entry
 */
export function enqueueImport(spec) {
    ensureSection();
    const entry = {
        seq: ++seq,
        provider: spec.provider,
        source: spec.source,
        view: spec.view,
        hit: spec.hit,
        linkKey: spec.linkKey == null || spec.linkKey === '' ? null : String(spec.linkKey),
        id: spec.id,
        data: spec.data ?? null,
        options: spec.options || {},
        onExisting: spec.onExisting ?? null,
        name: spec.name || 'Character',
        verb: spec.verb || 'Importing',
        meta: spec.meta || null,
        label: spec.label || spec.provider,
        run: spec.run || null,
        batch: !!spec.batch,
        status: 'queued',
    };
    const queue = lanes.get(entry.provider) || [];
    lanes.set(entry.provider, queue);
    queue.push(entry);
    const ahead = queue.length - 1;
    CoreAPI.showToast(ahead
        ? `"${entry.name}" queued behind ${ahead} import${ahead === 1 ? '' : 's'}`
        : `${entry.verb} "${entry.name}" in the background`, 'info', 4000, {
        group: 'import-activity', item: { kind: 'queued', name: entry.name }, many: CoreAPI.summarizeImportActivity,
    });
    paintCards(entry, true);
    changed(entry.view);
    void runNext(entry.provider);
    return entry;
}

async function runNext(provider) {
    const queue = lanes.get(provider);
    const entry = queue?.[0];
    if (!entry || entry.status === 'running') return;
    entry.status = 'running';
    changed(entry.view);
    const outcome = { seq: entry.seq, name: entry.name, ok: false, error: '', media: null, retry: null, present: false };
    try {
        const result = await (entry.run ? entry.run() : importThroughCommand(entry.source, entry.id, entry.data, { ...entry.options, onExisting: entry.onExisting }));
        if (!result?.success) throw new Error(result?.error || 'Import failed');
        outcome.ok = true;
        outcome.present = !!result.alreadyPresent;
        outcome.name = result.characterName || entry.name;
        const summaryArgs = entry.view.importSummaryArgs(result, entry.source);
        const hasMedia = summaryArgs.galleryCharacters.length > 0 || summaryArgs.mediaCharacters.length > 0;
        const setting = CoreAPI.getSetting('importMediaAction');
        // a batch was confirmed whole, so no card of it asks; one the server skipped as present brings none
        const action = entry.batch ? (setting === 'none' || result.alreadyPresent ? 'none' : 'queue') : setting;
        // "background" queues the media quietly as it always has; "ask" opens no prompt over
        // whatever the reader is doing, the row offers it instead
        try {
            if (hasMedia && action === 'queue') CoreAPI.queueImportMediaJobs(summaryArgs);
            await finishBrowseImport({
                view: entry.view, summaryArgs, showSummary: hasMedia && action === 'background',
                closePreview: () => {}, importBtn: null,
                characterName: result.characterName, localCharId: result.id,
                alreadyPresent: result.alreadyPresent, replaced: result.replaced, skippedReason: result.skippedReason, batch: entry.batch, hit: entry.hit,
            });
        } catch (err) {
            // the server holds it: a tail that stumbled is no failed import to retry
            console.error(`[${entry.label}] Imported, but the post-import tail failed:`, err);
        }
        if (hasMedia && action === 'ask') {
            outcome.media = summaryArgs;
            CoreAPI.showToast(`"${outcome.name}" has media waiting in the notifications`, 'info', 4000, {
                group: 'import-activity', item: { kind: 'waiting', name: outcome.name }, many: CoreAPI.summarizeImportActivity,
            });
        }
    } catch (err) {
        console.error(`[${entry.label}] Background import failed:`, err);
        outcome.error = err?.message || 'Import failed';
        outcome.retry = entry;
        // a batch's failures are said once, when its lane drains; each keeps its row with Retry meanwhile
        if (!entry.batch) CoreAPI.showToast(`Could not import "${entry.name}": ${outcome.error}`, 'error', 8000);
    } finally {
        queue.shift();
        if (entry.batch) {
            const run = batchRuns.get(provider) || { total: 0, failed: 0, present: 0 };
            run.total++;
            if (!outcome.ok) run.failed++;
            else if (outcome.present) run.present++;
            batchRuns.set(provider, run);
        }
        if (!queue.length) {
            lanes.delete(provider);
            sayBatchSummary(provider, entry.source?.name || provider);
        }
        if (outcome.ok && !outcome.media) {
            if (outcome.present) presentCount++;
            else importedCount++;
        } else finished = [outcome, ...finished];
        paintCards(entry, false);
        changed(entry.view);
        void runNext(provider);
    }
}

// a batch's failures and its skips (already in the library) in one toast once its lane has drained, never one a card
function sayBatchSummary(provider, from) {
    const run = batchRuns.get(provider);
    batchRuns.delete(provider);
    if (!run?.failed && !run?.present) return;
    const were = run.present === 1 ? 'was' : 'were';
    if (run.failed) CoreAPI.showToast(`${run.failed} of ${run.total} imports from ${from} failed; each waits in the notifications with Retry${run.present ? `. ${run.present} ${were} already in your library` : ''}`, 'error', 8000);
    else CoreAPI.showToast(`${run.present} of ${run.total} imports from ${from} ${were} already in your library; nothing was changed for ${run.present === 1 ? 'it' : 'them'}`, 'info', 5000);
}

// The view's open preview, its rows and its own lane state follow every move
function changed(view) {
    CoreAPI.refreshNotificationsUI();
    view?._previewRestamp?.();
    view?.importLaneChanged?.();
}

// ========================================
// THE CARDS
// ========================================

/** The badge a card in flight wears, for a view's card template; '' for any other card. */
export function importingBadge(view, linkKey) {
    return findImport(view, linkKey) ? IMPORTING_BADGE : '';
}

// the cards already painted with this key, in every grid the view keeps (a re-render draws the badge itself)
function paintCards(entry, on) {
    if (!entry.linkKey || typeof document === 'undefined') return;
    for (const gridId of entry.view.libraryBadgeGridIds || []) {
        for (const card of document.getElementById(gridId)?.querySelectorAll('.browse-card') || []) {
            if (card.dataset.linkKey !== entry.linkKey) continue;
            card.querySelector('.browse-feature-badge.importing')?.remove();
            if (on) entry.view._badgesOf(card, true)?.insertAdjacentHTML('afterbegin', IMPORTING_BADGE);
        }
    }
}

// ========================================
// THE NOTIFICATIONS SECTION
// ========================================

function inFlight() {
    const out = [];
    for (const queue of lanes.values()) out.push(...queue);
    return out;
}

export function laneStatus() {
    const flying = inFlight().length;
    const failed = finished.filter(r => !r.ok).length;
    if (flying) {
        return { visible: true, level: 'activity', icon: 'fa-solid fa-file-import', title: `Importing ${flying} character${flying === 1 ? '' : 's'} in the background` };
    }
    if (failed) {
        return { visible: true, level: 'warning', badge: failed, title: `${failed} background import${failed === 1 ? '' : 's'} failed` };
    }
    return { visible: finished.length > 0 || importedCount > 0 || presentCount > 0, level: 'none', title: 'Background imports' };
}

/** What a row in flight says: the view's own words when it has them (janitorai's server lane). */
export function rowStatus(entry) {
    const own = entry.view.importRowStatus?.(entry);
    if (own) return own;
    const from = entry.source?.name || entry.provider;
    if (entry.status === 'running') return `${entry.verb} from ${from}`;
    const ahead = positionOf(entry);
    return `Waiting for ${ahead} import${ahead === 1 ? '' : 's'} from ${from}`;
}

export function renderLaneSection(el) {
    if (!el) return;
    const esc = CoreAPI.escapeHtml;
    const rows = inFlight();
    if (!rows.length && !finished.length && !importedCount && !presentCount) { el.innerHTML = ''; return; }
    const parts = ['<div class="notif-list">'];
    parts.push('<div class="notif-header"><i class="fa-solid fa-file-import"></i><span>Imports</span></div>');
    for (const entry of [...rows.filter(e => e.status === 'running'), ...rows.filter(e => e.status !== 'running')]) {
        const running = entry.status === 'running';
        parts.push(`
            <div class="notif-row${running ? ' is-active' : ''}">
                <span class="notif-row-icon"><i class="fa-solid ${running ? 'fa-circle-notch fa-spin' : 'fa-hourglass-half'}"></i></span>
                <div class="notif-row-body">
                    <div class="notif-row-line"><span class="notif-row-name">${esc(entry.name)}</span></div>
                    <div class="notif-row-sub">${esc(rowStatus(entry))}</div>
                </div>
            </div>`);
    }
    for (const r of finished.filter(r => !r.ok)) {
        parts.push(`
            <div class="notif-row is-failed">
                <span class="notif-row-icon is-error"><i class="fa-solid fa-triangle-exclamation"></i></span>
                <div class="notif-row-body">
                    <div class="notif-row-line">
                        <span class="notif-row-name">${esc(r.name)}</span>
                        <span class="notif-row-actions">
                            <button class="notif-row-btn" data-lane-retry="${r.seq}" title="Retry"><i class="fa-solid fa-rotate-right"></i></button>
                            <button class="notif-row-btn" data-lane-dismiss="${r.seq}" title="Dismiss"><i class="fa-solid fa-xmark"></i></button>
                        </span>
                    </div>
                    <div class="notif-row-sub notif-row-error">${esc(r.error || 'Failed')}</div>
                </div>
            </div>`);
    }
    for (const r of finished.filter(r => r.ok && r.media)) {
        parts.push(`
            <div class="notif-row">
                <span class="notif-row-icon"><i class="fa-solid fa-images"></i></span>
                <div class="notif-row-body">
                    <div class="notif-row-line">
                        <span class="notif-row-name">${esc(r.name)}</span>
                        <span class="notif-row-actions">
                            <button class="notif-row-btn" data-lane-media="${r.seq}" title="Download media"><i class="fa-solid fa-cloud-arrow-down"></i></button>
                            <button class="notif-row-btn" data-lane-dismiss="${r.seq}" title="Dismiss"><i class="fa-solid fa-xmark"></i></button>
                        </span>
                    </div>
                    <div class="notif-row-sub">Imported; its media is waiting</div>
                </div>
            </div>`);
    }
    if (importedCount || presentCount) {
        // imported and already there apart: the server skipped the second kind, writing nothing
        const said = [importedCount ? `${importedCount} imported` : '', presentCount ? `${presentCount} already in your library` : ''].filter(Boolean).join(', ');
        parts.push(`
            <div class="notif-done-row">
                <span><i class="fa-solid fa-circle-check"></i> ${said}</span>
                <button class="notif-row-btn" data-lane-clear title="Clear finished"><i class="fa-solid fa-broom"></i></button>
            </div>`);
    }
    parts.push('</div>');
    el.innerHTML = parts.join('');
}

/** The same import again, with the same choice the dialog took. */
export function retryImport(rowSeq) {
    const row = finished.find(r => r.seq === Number(rowSeq));
    if (!row?.retry) return null;
    finished = finished.filter(r => r !== row);
    const e = row.retry;
    if (findImport(e.view, e.linkKey)) { CoreAPI.refreshNotificationsUI(); return null; }
    return enqueueImport(e);
}

/** The prompt an "ask" reader would have had, opened when they ask for it. */
export function openWaitingMedia(rowSeq) {
    const row = finished.find(r => r.seq === Number(rowSeq));
    if (!row?.media) return;
    const summaryArgs = row.media;
    // asked once, the row is an imported one like the rest
    finished = finished.filter(r => r !== row);
    if (row.present) presentCount++;
    else importedCount++;
    CoreAPI.refreshNotificationsUI();
    CoreAPI.showImportSummaryModal(summaryArgs);
}

export function dismissRow(rowSeq) {
    finished = finished.filter(r => r.seq !== Number(rowSeq));
    CoreAPI.refreshNotificationsUI();
}

// the media queue's rule: clear takes everything finished, failed rows included
export function clearFinished() {
    finished = [];
    importedCount = 0;
    presentCount = 0;
    CoreAPI.refreshNotificationsUI();
}

// The shell makes the slot on the first import, and repaints it on every change while open
function ensureSection() {
    if (sectionEl) return;
    sectionEl = CoreAPI.registerNotificationSection({
        id: 'browse-imports',
        getStatus: laneStatus,
        onOpen: (el) => renderLaneSection(el),
    });
    sectionEl?.addEventListener('click', (e) => {
        const retry = e.target.closest('[data-lane-retry]');
        if (retry) { retryImport(retry.dataset.laneRetry); return; }
        const media = e.target.closest('[data-lane-media]');
        if (media) { openWaitingMedia(media.dataset.laneMedia); return; }
        const dismiss = e.target.closest('[data-lane-dismiss]');
        if (dismiss) { dismissRow(dismiss.dataset.laneDismiss); return; }
        if (e.target.closest('[data-lane-clear]')) clearFinished();
    });
}
