// The update's progress dialog: the steps, each library's backup as it copies, the restart's wait and the reload
import { progressBlockHtml, paintProgress, timeLeft } from './step-progress.js';

// the bell module's pieces: its shell, the state it holds, what it does once the server answers on another version
let _ctx = null;

const esc = (s) => _ctx.shell.escapeHtml(s ?? '');
/** A reason the server words as a clause, shown as a sentence. */
export const sentence = (s) => { const t = String(s ?? ''); return t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}` : ''; };

/** Hand over the bell module's pieces: shell, getState(), adopt(answer), onBack() (the asking tab's reload), onVersion(v). */
export function initProgress(ctx) {
    _ctx = ctx;
}

/** Whether the dialog is open, so the bell offers no second way to it. */
export const progressOpen = () => !!_progress;


const POLL_MS = 500;
const HEALTH_MS = 1000;
// a restart this long is the launcher installing the new version's packages, which the server cannot report
const INSTALL_HINT_MS = 15000;
const RELOAD_PAUSE_MS = 1200;

// the open dialog: its element, what it has seen (the server away, back), its rate samples and its timer
let _progress = null;

const fmtBytes = (n) => _ctx.shell.formatBytes(n);

/**
 * What the update's steps and bar say, from the server's state and what this tab saw: pure, so the bell row and the dialog agree.
 * @param {object} s the update state
 * @param {{ away?: boolean, back?: boolean, restartMs?: number, samples?: Array<{t: number, done: number}>, now?: number, lastPhase?: string }} seen
 */
export function progressView(s, seen = {}) {
    const up = s?.updating || null;
    const to = up?.toVersion || seen.toVersion || s?.restartNeeded?.version || s?.latest?.version || '';
    const phase = seen.back ? 'back' : (seen.away || up?.phase === 'restarting') ? 'restarting' : up?.phase || (s?.restartNeeded ? 'restartNeeded' : s?.failed ? 'failed' : seen.lastPhase || 'backup');
    const order = ['backup', 'updating', 'restarting', 'back'];
    const at = order.indexOf(phase === 'restartNeeded' ? 'restarting' : phase === 'failed' ? (seen.lastPhase || 'backup') : phase);
    const stateOf = (i) => (phase === 'failed' && i === at ? 'failed' : i < at ? 'done' : i === at ? 'active' : 'waiting');
    const skipped = up ? up.backup === false : seen.backup === false;
    const libs = up?.backups || [];
    const backedUp = up?.backedUp || seen.backedUp || [];
    const backupSub = libs.length
        ? libs.map(l => (l.status === 'done' ? `${l.handle} · ${fmtBytes(l.done)}` : l.status === 'running' ? (l.phase === 'verify' ? `${l.handle} · checking` : `${l.handle} · ${fmtBytes(l.done)}${l.total ? ` of ${fmtBytes(l.total)}` : ''}`) : `${l.handle} · waiting`)).join(', ')
        : backedUp.map(b => (b.bytes != null ? `${b.handle} · ${fmtBytes(b.bytes)}` : b.handle)).join(', ');
    const steps = [
        { key: 'backup', name: 'Back up every library', state: skipped ? 'skipped' : stateOf(0), sub: skipped ? 'Skipped: no backup was asked for' : backupSub, count: libs.length ? `${libs.filter(l => l.status === 'done').length} of ${libs.length}` : '' },
        { key: 'updating', name: `Bring in v${to}`, state: stateOf(1), sub: '' },
        { key: 'restarting', name: 'Restart the server', state: phase === 'restartNeeded' ? 'warn' : stateOf(2), sub: phase === 'restartNeeded' ? 'This server was not started by its launcher: restart it yourself to finish' : '' },
        { key: 'back', name: 'Reload', state: stateOf(3), sub: '' },
    ];
    if (phase === 'failed') steps[at].sub = sentence(s.failed);
    let bar = { kind: 'none', pct: 0, what: '', eta: '', hint: '' };
    if (phase === 'backup' && libs.length) {
        const total = libs.reduce((n, l) => n + (l.total || 0), 0);
        const done = libs.reduce((n, l) => n + Math.min(l.done || 0, l.total || l.done || 0), 0);
        const current = libs.find(l => l.status === 'running') || libs.find(l => l.status === 'queued');
        const what = current?.phase === 'verify' ? `Checking the backup of ${current.handle}` : `Backing up ${fmtBytes(done)}${total ? ` of ${fmtBytes(total)}` : ''}${current ? ` · ${current.handle}` : ''}`;
        const eta = timeLeft(seen.samples?.[0], done, total, seen.now ?? Date.now());
        bar = { kind: 'measured', pct: total ? Math.min(100, Math.round(done / total * 100)) : 0, what, eta, hint: '' };
    } else if (phase === 'backup' || phase === 'updating') {
        bar = { kind: 'busy', pct: 0, what: phase === 'updating' ? `Bringing in v${to}` : 'Starting the backup', eta: '', hint: '' };
    } else if (phase === 'restarting') {
        const secs = Math.round((seen.restartMs || 0) / 1000);
        bar = { kind: 'busy', pct: 0, what: `Waiting for the server${secs ? ` · ${secs} s` : ''}`, eta: '', hint: (seen.restartMs || 0) >= INSTALL_HINT_MS ? "Installing the new version's packages; this can take a minute or two." : '' };
    } else if (phase === 'back') {
        bar = { kind: 'measured', pct: 100, what: `Back on v${to}`, eta: '', hint: '' };
    } else if (phase === 'failed') {
        bar = { kind: 'none', pct: 0, what: backedUp.length || seen.lastPhase === 'updating' ? 'Nothing was changed; the backup was kept.' : 'Nothing was changed.', eta: '', hint: '' };
    } else if (phase === 'restartNeeded') {
        bar = { kind: 'none', pct: 0, what: `v${to} is in place.`, eta: '', hint: '' };
    }
    return { phase, to, steps, bar };
}

function renderProgress() {
    const p = _progress;
    if (!p) return;
    const v = progressView(_ctx.getState(), { ...p.seen, restartMs: p.seen.restartAt ? Date.now() - p.seen.restartAt : 0, now: Date.now() });
    const q = (sel) => p.el.querySelector(sel);
    q('[data-upd-title]').textContent = v.phase === 'back' ? `Updated to v${v.to}` : v.phase === 'failed' ? 'The update stopped' : `Updating to v${v.to}`;
    paintProgress(p.el, 'upd', { steps: v.steps, bar: v.bar, failed: v.phase === 'failed' }, esc);
    const ended = v.phase === 'failed' || (v.phase === 'back' && !p.mine);
    q('[data-upd-keep]').textContent = v.phase === 'failed' ? '' : v.phase === 'back' ? (p.mine ? 'Reloading the page' : 'Reload to use the new version') : p.mine ? 'Keep this tab open; it reloads by itself.' : '';
    q('[data-upd-hide]').textContent = ended ? 'Close' : 'Hide';
    // reloading on its own, there is nothing left to hide
    q('[data-upd-hide]').hidden = v.phase === 'back' && p.mine;
    q('[data-upd-reload]').hidden = !(v.phase === 'back' && !p.mine);
}

function closeProgress() {
    if (!_progress) return;
    clearTimeout(_progress.timer);
    _ctx.shell.unregisterOverlay?.('appUpdateProgress');
    _progress.el.remove();
    _progress = null;
}

/** The server answers on the version this tab asked for: the dialog says so for a beat; answers how long to wait before the reload. */
export function markBack() {
    if (!_progress) return 0;
    _progress.seen.back = true;
    renderProgress();
    return RELOAD_PAUSE_MS;
}

async function progressTick() {
    const p = _progress;
    if (!p) return;
    const phase = _ctx.getState()?.updating?.phase;
    if (!p.seen.away && phase !== 'restarting') {
        try {
            const resp = await _ctx.shell.apiRequest('/app/update', 'GET');
            if (!resp.ok) throw new Error(String(resp.status));
            _ctx.adopt(await resp.json());
        } catch { p.seen.away = true; }
    }
    if (_progress !== p) return;
    const state = _ctx.getState();
    const up = state?.updating;
    if (up?.phase) p.seen.lastPhase = up.phase;
    if (up?.backup === false) p.seen.backup = false;
    if (up?.backedUp) p.seen.backedUp = up.backedUp;
    if (up?.phase === 'backup' && up.backups?.length) {
        const done = up.backups.reduce((n, l) => n + (l.done || 0), 0);
        p.seen.samples.push({ t: Date.now(), done });
        if (p.seen.samples.length > 40) p.seen.samples.splice(1, 1);
    }
    const restarting = p.seen.away || up?.phase === 'restarting' || state?.restartNeeded;
    if (restarting && !p.seen.back) {
        p.seen.restartAt ??= Date.now();
        try {
            const health = await (await _ctx.shell.apiRequest('/health', 'GET', null, { cache: 'no-cache' })).json();
            const to = p.seen.toVersion;
            if (health?.version && health.version === to) {
                _ctx.onVersion(health.version);
                if (p.mine) _ctx.onBack();
                else p.seen.back = true;
            }
        } catch { /* still away */ }
    }
    renderProgress();
    const after = _ctx.getState();
    // an update seen running that ended with nothing left to say (its failure let go of in another tab) closes its dialog
    if (_progress === p && !p.seen.back && !restarting && p.seen.lastPhase && !after?.updating && !after?.failed && !after?.restartNeeded) { closeProgress(); return; }
    if (_progress !== p || p.seen.back || (!after?.updating && after?.failed)) return;
    p.timer = setTimeout(progressTick, restarting ? HEALTH_MS : POLL_MS);
}

/** Open the update's progress: the steps, each library's backup as it copies, the restart and the reload. */
export function openProgress({ mine = false } = {}) {
    if (_progress) { renderProgress(); return; }
    const doc = _ctx.shell.document ?? globalThis.document;
    const state = _ctx.getState();
    const to = state?.updating?.toVersion || state?.latest?.version || '';
    doc.body.insertAdjacentHTML('beforeend', `
        <div id="appUpdateProgress" class="cl-modal cl-modal-drawer cl-drawer-partial upd-progress-modal visible">
            <div class="cl-modal-content upd-progress" role="dialog" aria-modal="true" aria-labelledby="appUpdateProgressTitle">
                <div class="cl-modal-header">
                    <h3 id="appUpdateProgressTitle"><i class="fa-solid fa-circle-arrow-up" aria-hidden="true"></i> <span data-upd-title></span></h3>
                </div>
                <div class="cl-modal-body">${progressBlockHtml('upd')}
                </div>
                <div class="cl-modal-footer">
                    <span class="upd-keep" data-upd-keep></span>
                    <button type="button" class="cl-btn cl-btn-primary" data-upd-reload hidden>Reload</button>
                    <button type="button" class="cl-btn cl-btn-secondary" data-upd-hide>Hide</button>
                </div>
            </div>
        </div>`);
    const el = doc.getElementById('appUpdateProgress');
    _progress = { el, mine, timer: null, seen: { toVersion: to, samples: [], away: false, back: false, restartAt: null, lastPhase: state?.updating?.phase || null, backup: state?.updating?.backup, backedUp: null } };
    // Hide leaves the update running: the bell follows it, and this tab still reloads itself when it is done
    el.querySelector('[data-upd-hide]').addEventListener('click', () => closeProgress());
    el.querySelector('[data-upd-reload]').addEventListener('click', () => _ctx.shell.reload());
    _ctx.shell.mountDialogSizing('appUpdateProgress');
    _ctx.shell.registerOverlay?.({ id: 'appUpdateProgress', tier: 7, close: () => closeProgress(), visible: (node) => node.classList.contains('visible') });
    renderProgress();
    void progressTick();
}
