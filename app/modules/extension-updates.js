// The notifications center's extension updates section: installed extensions whose repository holds a newer version, for an admin who asked to hear.
import { registerFeedPatcher } from './feed.js';

// the switch promises a check a day at most; a tab left open looks again every hour whether one is due
const DAY_MS = 24 * 60 * 60 * 1000;
const LOOK_EVERY_MS = 60 * 60 * 1000;

let _shell = null;
let _node = null;
// only an admin can update, so only an admin's tab hears; the server answers anyone else 403
let _admin = false;
let _state = { checkedAt: null, checking: false, extensions: [] };
// the last read or check sent wins, so an answer overtaken by a later one is dropped
let _readSeq = 0;

const notifyOn = () => _shell?.getSetting('notifyExtensionUpdates') === true;

/** The installs with a newer version waiting, as the last check found them. */
export const updatesAvailable = () => _state.extensions.filter(e => e.available);

function adopt(answer) {
    _state = {
        checkedAt: answer?.checkedAt ?? null,
        checking: !!answer?.checking,
        extensions: Array.isArray(answer?.extensions) ? answer.extensions : [],
    };
    renderSection(_node);
    _shell.refreshNotificationsUI();
    _shell.onChange?.(_state);
}

/** Read the last check and repaint. */
export async function readUpdates() {
    const seq = ++_readSeq;
    try {
        const resp = await _shell.apiRequest('/extensions/updates', 'GET');
        if (resp.status === 403) { _admin = false; return; }
        if (!resp.ok) return;
        const answer = await resp.json();
        if (seq !== _readSeq) return;
        _admin = true;
        adopt(answer);
    } catch { /* the next extension record or a resync reads again */ }
}

/**
 * Ask the server to check every install's repository now, or answer a check younger than maxAge; it never updates.
 * @param {{ maxAge?: number }} [opts] milliseconds
 * @returns {Promise<object|null>} the server's answer, null for an account that cannot update
 */
export async function checkUpdates({ maxAge = 0 } = {}) {
    if (!_admin) return null;
    const seq = ++_readSeq;
    _state = { ..._state, checking: true };
    _shell.onChange?.(_state);
    try {
        const answer = await _shell.readAnswer(await _shell.apiRequest('/extensions/updates/check', 'POST', { maxAge }));
        if (seq === _readSeq) adopt(answer);
        return answer;
    } catch (e) {
        if (seq === _readSeq) { _state = { ..._state, checking: false }; _shell.onChange?.(_state); }
        throw e;
    }
}

/** With the switch on, a check a day old or never made is made now; answers whether it asked. */
export async function lookIfDue(now = Date.now()) {
    if (!_admin || !notifyOn() || _state.checking) return false;
    if (_state.checkedAt && now - _state.checkedAt < DAY_MS) return false;
    try { await checkUpdates({ maxAge: DAY_MS }); } catch { /* the next look asks again */ }
    return true;
}

/** The section's state for the shell's button: a notice while the switch is on and an update waits, never an alarm. */
function sectionStatus() {
    const n = notifyOn() ? updatesAvailable().length : 0;
    if (n) return { visible: true, level: 'notice', title: `${n} extension update${n === 1 ? '' : 's'}` };
    return { visible: false, level: 'none', title: 'Extension updates' };
}

function updateRow(e) {
    const esc = _shell.escapeHtml;
    const from = e.version ? `v${esc(e.version)}` : esc(e.commit || '');
    const to = e.nextVersion ? `v${esc(e.nextVersion)}` : esc(e.nextCommit || 'a newer version');
    return `
        <div class="notif-row">
            <span class="notif-row-icon"><i class="fa-solid fa-puzzle-piece"></i></span>
            <div class="notif-row-body">
                <div class="notif-row-line">
                    <span class="notif-row-name">${esc(e.name || e.id)}</span>
                </div>
                <div class="notif-row-sub">${from} &rarr; ${to}</div>
            </div>
        </div>`;
}

/** Paint the section in the shell's row vocabulary. */
function renderSection(el) {
    if (!el) return;
    const list = notifyOn() ? updatesAvailable() : [];
    el.innerHTML = list.length
        ? `<div class="notif-list">
            <div class="notif-header"><i class="fa-solid fa-puzzle-piece"></i><span>Extension updates</span></div>
            ${list.map(updateRow).join('')}
            <div class="notif-row-choices">
                <button class="notif-choice is-primary" data-ext-updates-open title="Update them in Settings, Extensions">Open Extensions</button>
            </div>
        </div>`
        : '';
}

/** Contribute the section and read the last check: shell carries apiRequest, readAnswer, getSetting, escapeHtml, showToast, openExtensions, the notification calls, onChange and document. */
export async function startExtensionUpdates(shell) {
    _shell = shell;
    const doc = shell.document ?? globalThis.document;
    _node = shell.registerNotificationSection({ id: 'extension-updates', getStatus: sectionStatus, onOpen: (node) => renderSection(node) });
    _node?.addEventListener('click', (e) => { if (e.target.closest('[data-ext-updates-open]')) shell.openExtensions(); });
    // an update or a check announces the installs it touched, this tab's own update included
    registerFeedPatcher('extension', () => readUpdates(), { own: 'both' });
    // the switch saved here or in another tab: the bell follows it, and a check that is due runs
    const switched = (records) => !records || records.some(r => r.all || (r.ids || []).includes('notifyExtensionUpdates'));
    const onSwitch = (records) => {
        if (!switched(records)) return;
        renderSection(_node);
        shell.refreshNotificationsUI();
        void lookIfDue();
    };
    registerFeedPatcher('setting', onSwitch, { own: 'both' });
    // Settings' Check for Updates: the reader asked, so the answer is said either way
    doc?.addEventListener('cl-extension-updates-check', async () => {
        try {
            const answer = await checkUpdates();
            const n = (answer?.extensions || []).filter(e => e.available).length;
            const failed = (answer?.extensions || []).filter(e => e.error).length;
            // the band beside it words the empty answer the same way
            const said = n ? `${n} extension${n === 1 ? ' has' : 's have'} an update`
                : (answer?.extensions || []).length ? 'Every extension is up to date' : 'Nothing to check: no installed extension came from a repository';
            shell.showToast(failed ? `${said}; ${failed} could not be checked` : said, n || !failed ? 'success' : 'warning');
        } catch (e) {
            shell.showToast(`Could not check for updates: ${e.message}`, 'error');
        }
    });
    await readUpdates();
    if (!_admin) return;
    void lookIfDue();
    const timer = setInterval(() => void lookIfDue(), LOOK_EVERY_MS);
    timer.unref?.();
}
