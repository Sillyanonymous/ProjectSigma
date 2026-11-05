// The notifications center's maintenance section: the library's background upkeep while it runs; it imports only the feed, so node runs it as is.
import { registerFeedPatcher } from './feed.js';

const INDEX_LABELS = Object.freeze({ cards: 'card text', chats: 'chat messages', lorebooks: 'lorebook entries' });

let _shell = null;
let _node = null;
// the reader's own input says the library is in use, so an automatic tidy-up waits until they step away; one word a gap at most
const ACTIVITY_GAP_MS = 15_000;
let _toldAt = -Infinity;
let _state = { searchIndex: null };
// the last read sent wins, so an answer overtaken by a later read is dropped
let _readSeq = 0;

/** Read the library's upkeep and repaint. */
export async function readMaintenance() {
    const seq = ++_readSeq;
    try {
        const resp = await _shell.apiRequest('/maintenance', 'GET');
        if (!resp.ok) return;
        const answer = await resp.json();
        if (seq !== _readSeq) return;
        _state = { searchIndex: answer?.searchIndex || null };
    } catch { /* the next maintenance record or a resync reads again */ }
    renderSection(_node);
    _shell.refreshNotificationsUI();
    _shell.onChange?.(_state);
}

/** The section's state for the shell's button: activity while the search index is tidied, else hidden. */
function sectionStatus() {
    if (_state.searchIndex) return { visible: true, level: 'activity', icon: 'fa-solid fa-broom', title: 'Tidying the search index' };
    return { visible: false, level: 'none', title: 'Maintenance' };
}

function searchIndexRow(s) {
    const what = INDEX_LABELS[s.index] || 'the index';
    return `
        <div class="notif-row is-active">
            <span class="notif-row-icon"><i class="fa-solid fa-broom"></i></span>
            <div class="notif-row-body">
                <div class="notif-row-line">
                    <span class="notif-row-name">Tidying the search index</span>
                </div>
                <div class="notif-row-sub">Search may be slower, the disk busy</div>
                <div class="notif-row-sub notif-row-meta">Working on ${what}</div>
            </div>
        </div>`;
}

/** Paint the section in the shell's row vocabulary. */
function renderSection(el) {
    if (!el) return;
    el.innerHTML = _state.searchIndex
        ? `<div class="notif-list"><div class="notif-header"><i class="fa-solid fa-screwdriver-wrench"></i><span>Maintenance</span></div>${searchIndexRow(_state.searchIndex)}</div>`
        : '';
}

/** Tell the server the reader is using the library: the first input at once, then at most once a gap; answers whether it told. */
export function noteActivity(now = Date.now()) {
    if (now - _toldAt < ACTIVITY_GAP_MS) return false;
    _toldAt = now;
    Promise.resolve(_shell?.apiRequest('/maintenance/activity', 'POST')).catch(() => { _toldAt = -Infinity; });
    return true;
}

// reading the notifications is not using the library: the bell, its list and the phone's doors to them carry data-notif-chrome
const onNotifications = (e) => (e.composedPath?.() || []).some(n => n?.dataset?.notifChrome !== undefined);

/** Contribute the section and read the library's upkeep: shell carries apiRequest, registerNotificationSection, refreshNotificationsUI, onChange and document. */
export function startMaintenance(shell) {
    _shell = shell;
    const doc = shell.document ?? globalThis.document;
    // input only: coming back to the tab is not using the library yet, so the bell can still be read
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) doc?.addEventListener(type, (e) => { if (!onNotifications(e)) noteActivity(); }, { capture: true, passive: true });
    _node = shell.registerNotificationSection({ id: 'maintenance', getStatus: sectionStatus, onOpen: (node) => renderSection(node) });
    registerFeedPatcher('maintenance', () => readMaintenance());
    return readMaintenance();
}
