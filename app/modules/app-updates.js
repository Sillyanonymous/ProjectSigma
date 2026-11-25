// The bell's app update section: a newer Project Σ for an admin, the update itself, and Reload once the server runs another version
import { registerFeedPatcher } from './feed.js';
import { adminCheck } from './admin-check.js';
import { initProgress, openProgress, progressView, progressOpen, markBack, sentence } from './app-update-progress.js';

// the switch promises a check a day at most; a tab left open looks again every hour whether one is due
const LOOK_EVERY_MS = 60 * 60 * 1000;
const PHASE_WORDS = { backup: 'Backing up every library', updating: 'Updating', restarting: 'Restarting the server' };

let _shell = null;
let _node = null;
// only an admin can update, so only an admin's tab hears of one; the server answers anyone else 403
let _watch = null;
let _state = null;
// the version this page was loaded from, and the one a reload would bring
let _pageVersion = null;
let _serverVersion = null;
// set by this tab's own Update Now: the page reloads itself once the server answers on that version
let _awaiting = null;

const notifyOn = () => _shell?.getSetting('notifyAppUpdates') !== false;
const esc = (s) => _shell.escapeHtml(s ?? '');
// a reason line wraps, as every section's failure reason does
const reason = (text) => `<div class="notif-row-sub notif-row-error">${esc(text)}</div>`;
const isAdmin = () => !!_watch?.isAdmin();

/** Whether this tab's server now runs another version than the page was loaded from. */
export const reloadWanted = () => !!_pageVersion && !!_serverVersion && _serverVersion !== _pageVersion;

/** The update an admin should hear about: newer than the server, not skipped, the switch on. */
export function offered(state = _state) {
    if (!isAdmin() || !state?.available || !notifyOn()) return null;
    return state.latest?.version && state.latest.version !== state.skipped ? state.latest : null;
}

function adopt(answer) {
    _state = answer && typeof answer === 'object' ? answer : null;
    repaint();
}

function repaint() {
    renderSection(_node);
    _shell.refreshNotificationsUI();
    _shell.onChange?.({ state: _state, admin: isAdmin(), reloadWanted: reloadWanted(), serverVersion: _serverVersion });
}

// the section's two requests, handed to the shared check
const readCall = () => _shell.apiRequest('/app/update', 'GET');
const askAppCheck = (maxAge) => _shell.apiRequest('/app/update/check', 'POST', { maxAge });

/** Read the server's update state and repaint; a non-admin reads nothing. */
export const readState = () => _watch.read();

/**
 * Ask the server what is newer now, or answer a check younger than maxAge; it never updates.
 * @param {{ maxAge?: number }} [opts] milliseconds
 * @returns {Promise<object|null>} the state, null for an account that cannot update
 */
export const checkNow = (opts) => _watch.check(opts);

/** With the switch on, a check a day old or never made is made now; answers whether it asked. */
export const lookIfDue = (now) => _watch.lookIfDue(now);

// the asking tab's reload once the server answers on its version: the dialog says so for a beat first, when it is open
let _reloading = false;
function finishReload() {
    if (_reloading) return;
    _reloading = true;
    setTimeout(() => _shell.reload(), markBack());
}

// the server's version after a reconnect: this tab's own update reloads, any other tab is offered a Reload
async function readServerVersion() {
    try {
        const health = await (await _shell.apiRequest('/health', 'GET', null, { cache: 'no-cache' })).json();
        if (!health?.version) return;
        if (!_pageVersion) _pageVersion = health.version;
        _serverVersion = health.version;
        if (_awaiting && _serverVersion === _awaiting) { finishReload(); return; }
        repaint();
    } catch { /* the server is still away; the reconnect that follows reads again */ }
}

// ========================================
// THE VERBS
// ========================================

// past this many lines the panel ends with a pointer to GitHub, so a huge changelog never builds a huge dialog
const NOTES_MAX_LINES = 300;

/**
 * The releases' markdown as the confirm dialog's notes items, newest first: each version's name, its headings, lines and bullets.
 * @param {Array<{version: string, notes: string}>} releases
 */
export function notesItems(releases, { maxLines = NOTES_MAX_LINES } = {}) {
    const plain = (t) => t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    const items = [];
    let lines = 0, cut = false;
    const many = (releases || []).length > 1;
    for (const r of releases || []) {
        if (lines >= maxLines) { cut = true; break; }
        if (many) items.push({ kind: 'version', text: `v${r.version}` });
        let list = null;
        for (const raw of String(r.notes || '').split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) { list = null; continue; }
            if (++lines > maxLines) { cut = true; break; }
            const bullet = line.match(/^[-*]\s+(.*)$/);
            if (bullet) {
                if (!list) { list = { kind: 'list', items: [] }; items.push(list); }
                list.items.push(plain(bullet[1]));
                continue;
            }
            list = null;
            const heading = line.match(/^#+\s*(.*)$/);
            items.push(heading ? { kind: 'heading', text: plain(heading[1]) } : { kind: 'text', text: plain(line) });
        }
    }
    // a release ending exactly on the cap with more after it is a cut too, or the rest would be dropped without a word
    if (cut) items.push({ kind: 'text', text: 'The notes go on: read them in full on GitHub.' });
    return items;
}

// what an update brings, as the dialogs say it: the notes and the page they link to
function whatsNew(s) {
    const items = notesItems(s?.releases);
    const url = s?.latest?.url || null;
    return { items, url, link: url ? { url, label: 'Full notes on GitHub' } : null };
}

/** What the update brings, in the dialog, with the release page a click away. */
export async function showNotes() {
    const s = _state;
    if (!s?.latest) return;
    const { items, url } = whatsNew(s);
    const answer = await _shell.showConfirm({
        title: (s.releases || []).length > 1 ? `What is new since v${s.version}` : `What is new in v${s.latest.version}`,
        icon: 'fa-solid fa-scroll',
        message: items.length ? '' : 'This release has no notes.',
        // its own button opens the release page, so the panel carries no link of its own
        content: items.length ? [{ type: 'notes', items }] : [],
        confirmLabel: url ? 'View on GitHub' : 'Close',
        cancelLabel: 'Close',
    });
    if (answer && url) _shell.openUrl(url);
}

/** Confirm (with the backup switch, which remembers the last choice), then ask the server to update; its phases arrive as feed records. */
export async function updateNow() {
    const s = _state;
    if (!s?.canUpdate) return false;
    const { items, link } = whatsNew(s);
    let backup = _shell.getSetting('appUpdateBackup') !== false;
    const ok = await _shell.showConfirm({
        title: 'Update Project Σ?',
        icon: 'fa-solid fa-circle-arrow-up',
        content: [
            { type: 'fromTo', from: `v${s.version}`, to: `v${s.latest.version}` },
            { type: 'text', text: s.launcher ? 'The server restarts when it is done, and open tabs are offered a reload.' : 'This server was not started by its launcher, so restart it yourself once the update is in place.' },
            ...(items.length ? [{ type: 'notes', title: 'What is new', items, link }] : []),
            {
                type: 'switch', key: 'backup', text: 'Back up every library first', checked: backup,
                hint: `Without it, going back to v${s.version} is not possible if the new version changes your library.`,
                onChange: (on) => { backup = on; },
            },
        ],
        confirmLabel: 'Update Now',
    });
    if (!ok) return false;
    if (backup !== (_shell.getSetting('appUpdateBackup') !== false)) _shell.setSetting('appUpdateBackup', backup);
    // saved now, not half a second on: from the merge to the restart the server refuses writes
    await _shell.flushSettings?.();
    try {
        const answer = await _shell.readAnswer(await _shell.apiRequest('/app/update', 'POST', { backup }));
        if (answer?.launcher) _awaiting = answer.updating?.toVersion || s.latest.version;
        adopt(answer);
        openProgress({ mine: true });
        return true;
    } catch (e) {
        _shell.showToast(`Could not update: ${e.message}`, 'error');
        void readState();
        return false;
    }
}

/** The steps for an install that updates by hand (a download or a container). */
export async function showHowTo() {
    const s = _state;
    if (!s?.latest) return;
    const steps = s.installType === 'docker'
        ? [{ type: 'text', text: 'In the folder the image was built from:' }, { type: 'list', items: [{ text: 'git pull', mono: true }, { text: 'docker compose -f docker/compose.yaml up -d --build', mono: true }] }, { type: 'text', text: 'Your libraries stay in the data volume.' }]
        : [{ type: 'text', text: 'Download the new version, unpack it beside the old one, and move the data folder (and extensions/installed, if you have one) across. Then start it as before.' }];
    const answer = await _shell.showConfirm({
        title: `Update to v${s.latest.version}`,
        icon: 'fa-solid fa-circle-arrow-up',
        content: steps,
        confirmLabel: s.latest.url ? 'Open the Release' : 'Close',
        cancelLabel: 'Close',
    });
    if (answer && s.latest.url) _shell.openUrl(s.latest.url);
}

/** Not hear about this version again, on this server. */
export async function skipThis() {
    const version = _state?.latest?.version;
    if (!version) return;
    try { adopt(await _shell.readAnswer(await _shell.apiRequest('/app/update/skip', 'PUT', { version }))); } catch (e) { _shell.showToast(`Could not skip it: ${e.message}`, 'error'); }
}

/** OK on a failed update: the server lets go of it, so no reload or other tab shows it again. */
export async function dismissFailure() {
    try { adopt(await _shell.readAnswer(await _shell.apiRequest('/app/update/failure', 'DELETE'))); } catch (e) { _shell.showToast(`Could not clear it: ${e.message}`, 'error'); }
}

// ========================================
// THE BELL
// ========================================

/** The section's state for the shell's button: a notice, never an alarm. */
function sectionStatus() {
    const s = _state;
    if (reloadWanted()) return { visible: true, level: 'notice', title: `Project Σ was updated to v${_serverVersion}` };
    if (isAdmin() && s?.updating) return { visible: true, level: 'notice', title: 'Updating Project Σ' };
    if (isAdmin() && (s?.failed || s?.restartNeeded)) return { visible: true, level: 'notice', title: s.failed ? 'The update stopped' : 'Restart to finish the update' };
    const latest = offered();
    if (latest) return { visible: true, level: 'notice', title: `Project Σ v${latest.version} is available` };
    return { visible: false, level: 'none', title: 'Project Σ updates' };
}

const row = (icon, name, sub, extra = '') => `
    <div class="notif-row">
        <span class="notif-row-icon"><i class="fa-solid ${icon}"></i></span>
        <div class="notif-row-body">
            <div class="notif-row-line"><span class="notif-row-name">${name}</span></div>
            ${sub ? `<div class="notif-row-sub">${sub}</div>` : ''}${extra}
        </div>
    </div>`;
const choice = (verb, label, primary = false) => `<button class="notif-choice${primary ? ' is-primary' : ''}" data-app-update="${verb}">${label}</button>`;

/** Paint the section in the shell's row vocabulary. */
function renderSection(el) {
    if (!el) return;
    const s = _state;
    let body = '';
    let choices = '';
    if (reloadWanted()) {
        body = row('fa-rotate', `Updated to v${esc(_serverVersion)}`, 'This page is still the old version until it reloads.');
        choices = choice('reload', 'Reload', true);
    } else if (isAdmin() && s?.updating) {
        // the same words and bar as the progress dialog, which the link opens
        const v = progressView(s);
        const bar = v.bar.kind === 'measured' ? `<div class="notif-progress"><div class="notif-progress-fill" style="width:${v.bar.pct}%"></div></div>` : '';
        body = row('fa-circle-notch fa-spin', `Updating to v${esc(s.updating.toVersion)}`, esc([v.bar.what, v.bar.eta].filter(Boolean).join(' · ') || PHASE_WORDS[s.updating.phase] || 'Updating'),
            `${bar}${progressOpen() ? '' : '<button class="notif-row-link" data-app-update="progress">Show Progress <i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>'}`);
    } else if (isAdmin() && s?.failed) {
        body = row('fa-triangle-exclamation', 'The update stopped', 'Nothing was changed.', reason(sentence(s.failed)));
        choices = choice('dismiss', 'OK');
    } else if (isAdmin() && s?.restartNeeded) {
        body = row('fa-power-off', `v${esc(s.restartNeeded.version)} is in place`, 'Restart the server to finish the update.');
    } else {
        const latest = offered();
        if (latest) {
            // the notes are something to read, not an answer, so they sit in the row and the strip keeps the answers
            const notes = (s.releases || []).some(r => r.notes) || latest.url
                ? `<button class="notif-row-link" data-app-update="notes">${(s.releases || []).length > 1 ? `What is new since v${esc(s.version)}` : `What is new in v${esc(latest.version)}`} <i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>`
                : '';
            const refused = s.installType === 'git' && s.refusal ? reason(sentence(s.refusal)) : '';
            body = row('fa-circle-arrow-up', `v${esc(latest.version)} is available`, `You have v${esc(s.version)}.`, refused + notes);
            // the lead answer last, as a dialog's buttons sit
            choices = [
                choice('skip', 'Skip This Version'),
                s.installType === 'git' ? (s.canUpdate ? choice('now', 'Update Now', true) : '') : choice('how', 'How to Update', true),
            ].join('');
        }
    }
    el.innerHTML = body
        ? `<div class="notif-list">
            <div class="notif-header"><i class="fa-solid fa-circle-arrow-up"></i><span>Project Σ update</span></div>
            ${body}
            ${choices ? `<div class="notif-row-choices">${choices}</div>` : ''}
        </div>`
        : '';
}

/** Run a section or Settings verb by name. */
export function runAppUpdateVerb(verb) {
    if (verb === 'notes') return showNotes();
    if (verb === 'now') return updateNow();
    if (verb === 'how') return showHowTo();
    if (verb === 'skip') return skipThis();
    if (verb === 'reload') return _shell.reload();
    if (verb === 'progress') return openProgress({ mine: !!_awaiting });
    if (verb === 'dismiss') return dismissFailure();
    return null;
}

/** Contribute the section and read the state: shell carries apiRequest, readAnswer, get/setSetting, flushSettings, escapeHtml, showToast, showConfirm, openUrl, reload, the notification calls, onChange, document. */
export async function startAppUpdates(shell) {
    _shell = shell;
    initProgress({ shell, getState: () => _state, adopt, onBack: () => finishReload(), onVersion: (v) => { _serverVersion = v; } });
    _watch = adminCheck({
        readAnswer: shell.readAnswer, read: readCall, ask: askAppCheck, adopt,
        onChecking: (checking) => { _state = { ...(_state || {}), checking }; repaint(); },
        isOn: notifyOn, checkedAt: () => _state?.checkedAt ?? null,
    });
    const doc = shell.document ?? globalThis.document;
    _node = shell.registerNotificationSection({ id: 'app-update', getStatus: sectionStatus, onOpen: (node) => renderSection(node) });
    _node?.addEventListener('click', (e) => {
        const verb = e.target.closest?.('[data-app-update]')?.dataset.appUpdate;
        if (verb) void runAppUpdateVerb(verb);
    });
    // a check, a skip or an update's phase announces the state; a resync (null) is a reconnect, the server maybe restarted
    registerFeedPatcher('appUpdate', (records) => {
        void readState();
        if (!records) void readServerVersion();
    }, { own: 'both' });
    const switched = (records) => !records || records.some(r => r.all || (r.ids || []).includes('notifyAppUpdates'));
    registerFeedPatcher('setting', (records) => {
        if (!switched(records)) return;
        repaint();
        void lookIfDue();
    }, { own: 'both' });
    // Settings' buttons: the reader asked, so a check's answer is said either way
    doc?.addEventListener('cl-app-update-verb', (e) => void runAppUpdateVerb(e.detail));
    doc?.addEventListener('cl-app-update-check', async () => {
        try {
            const answer = await checkNow();
            if (!answer) return;
            if (answer.error) shell.showToast(`Could not check for updates: ${answer.error}`, 'warning');
            else shell.showToast(answer.available ? `Project Σ v${answer.latest.version} is available` : 'Project Σ is up to date', 'success');
        } catch (e) {
            shell.showToast(`Could not check for updates: ${e.message}`, 'error');
        }
    });
    await readServerVersion();
    await readState();
    if (!isAdmin()) return;
    void lookIfDue();
    const timer = setInterval(() => void lookIfDue(), LOOK_EVERY_MS);
    timer.unref?.();
}
