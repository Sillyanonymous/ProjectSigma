import * as CoreAPI from './core-api.js';
import { runCommand } from './ext-registry.js';


let isInitialized = false;
let currentTagAnalysis = null;
// what the editor acts on: { ids } or { filter } (a /characters query the server resolves); null = the library's selection, read on use
let target = null;
// the tally's answer for the target on screen; a later open or a close outdates it
let tallySeq = 0;
let tallyTotal = null;
const TALLY_CHUNK = 10000;
let applyInProgress = false;
// the server's job for a by-filter apply while it runs: Cancel stops it between chunks
let applyJobId = null;

export function init(deps) {
    if (isInitialized) {
        console.warn('[BatchTagging] Already initialized');
        return;
    }

    injectModal();
    setupEventListeners();

    window.registerOverlay?.({ id: 'batchTagModal', tier: 7, close: () => closeModal(), visible: (el) => el.classList.contains('visible') });

    isInitialized = true;
    CoreAPI.debugLog('[BatchTagging] Module initialized');
}

// the library's selection as the editor's target: its ids, or a Select All's filter
function selectionTarget() {
    const selection = CoreAPI.getSelection();
    if (!selection.count) return null;
    return selection.filter !== undefined ? { filter: selection.filter } : { ids: selection.ids };
}

/**
 * Open the editor on { ids }, { filter } (eg. CoreAPI.currentViewFilter), or nothing for the library's selection.
 * @param {{ids?: string[], filter?: string}} [given]
 */
export function openModal(given) {
    if (!isInitialized) {
        console.error('[BatchTagging] Module not initialized');
        return;
    }

    target = typeof given?.filter === 'string' ? { filter: given.filter }
        : Array.isArray(given?.ids) && given.ids.length ? { ids: [...given.ids] }
            : null;
    if (!target && !selectionTarget()) {
        CoreAPI.showToast('No characters selected', 'warning');
        return;
    }

    document.getElementById('batchTagAddInput').value = '';
    document.getElementById('batchTagRemoveInput').value = '';
    document.getElementById('batchTagAddPills').innerHTML = '';
    document.getElementById('batchTagRemovePills').innerHTML = '';
    // a fresh dialog: an apply a wrapper never settled (promise still pending) must not hold Apply for the session
    applyInProgress = false;
    applyJobId = null;
    resetCancelButton();
    resetApplyButton();
    phoneWords();
    document.getElementById('batchTagModal').classList.add('visible');
    loadTally();
}

// a phone taps and its field is narrow, so it gets words of its own; the desktop's stay as written
const DESKTOP_WORDS = new Map();
function phoneWords() {
    const words = [
        ['#batchTagModal .bt-hint', 'textContent', 'Tap a tag above to add it to the removal list'],
        ['#batchTagAddInput', 'placeholder', 'Type a tag; commas add several'],
        ['#batchTagRemoveInput', 'placeholder', 'Type a tag, or tap one above'],
    ];
    for (const [sel, prop, phone] of words) {
        const el = document.querySelector(sel);
        if (!el) continue;
        if (!DESKTOP_WORDS.has(sel)) DESKTOP_WORDS.set(sel, el[prop]);
        el[prop] = CoreAPI.isMobileMode() ? phone : DESKTOP_WORDS.get(sel);
    }
}

// the target's tags counted by the server: which every one carries, which only some do, and how many
async function loadTally() {
    const seq = ++tallySeq;
    currentTagAnalysis = null;
    tallyTotal = null;
    const countEl = document.getElementById('batchTagCharCount');
    const container = document.getElementById('batchTagExisting');
    if (countEl) countEl.textContent = '...';
    if (container) container.innerHTML = '<div class="bt-empty"><i class="fa-solid fa-spinner fa-spin"></i> Reading their tags...</div>';
    const on = target || selectionTarget() || { ids: [] };
    let data = null;
    let error = null;
    try {
        data = await readTagTally(on);
        if (!data) error = 'the tally answered nothing';
    } catch (e) {
        error = e?.message || 'network error';
    }
    if (seq !== tallySeq) return;
    if (error) {
        if (countEl) countEl.textContent = '?';
        if (container) container.innerHTML = `<div class="bt-empty">Could not read their tags: ${CoreAPI.escapeHtml(error)}</div>`;
        return;
    }
    tallyTotal = data.total;
    currentTagAnalysis = analysisOf(data);
    if (countEl) countEl.textContent = data.total.toLocaleString();
    const noun = document.getElementById('batchTagCharNoun');
    if (noun) noun.textContent = data.total === 1 ? 'character' : 'characters';
    renderExistingTags(currentTagAnalysis);
}

// a filter is one read; ids past the server's bound are counted in parts, whose totals and per-tag counts add up
async function readTagTally(on) {
    if (on.filter !== undefined) return CoreAPI.readAnswer(await CoreAPI.apiRequest('/tags/tally', 'POST', { filter: on.filter }));
    const ids = [...new Set(on.ids || [])];
    if (ids.length <= TALLY_CHUNK) return CoreAPI.readAnswer(await CoreAPI.apiRequest('/tags/tally', 'POST', { charIds: ids }));
    let total = 0;
    const counts = new Map();
    const add = ({ total: n, tags }) => {
        total += n;
        for (const t of tags || []) counts.set(t.name, (counts.get(t.name) || 0) + t.count);
    };
    for (let at = 0; at < ids.length; at += TALLY_CHUNK) {
        const part = await CoreAPI.readAnswer(await CoreAPI.apiRequest('/tags/tally', 'POST', { charIds: ids.slice(at, at + TALLY_CHUNK) }));
        if (!part) return null;
        add(part);
    }
    return { total, tags: [...counts].map(([name, count]) => ({ name, count })) };
}

// a tag on every character of the target, or on some, with how many
function analysisOf({ total, tags }) {
    const all = [];
    const some = [];
    for (const t of tags || []) {
        if (t.count === total) all.push(t.name);
        else some.push({ name: t.name, count: t.count });
    }
    all.sort((a, b) => a.localeCompare(b));
    // most shared first: a whole-library target answers every distinct tag, and only the first page of pills shows
    some.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    // every name once, sorted, for the Remove field's suggestions (built once, not per keystroke)
    const names = [...new Set([...all, ...some.map(t => t.name)])].sort((a, b) => a.localeCompare(b));
    return { all, some, total, names };
}

// "on some" pills shown: a whole-library target carries every distinct tag, and a pill + listener per tag froze the dialog
const BT_PILL_CAP = 300;

function renderExistingTags(analysis) {
    const container = document.getElementById('batchTagExisting');
    if (!container) return;
    
    let html = '';
    
    if (analysis.all.length > 0) {
        html += `<div class="bt-group">
            <div class="bt-group-label">On all ${analysis.total.toLocaleString()}:</div>
            <div class="bt-group-pills">
                ${analysis.all.map(tag => `
                    <span class="cl-tag cl-tag-success" data-tag="${CoreAPI.escapeHtml(tag)}" title="Click to add to removal list">
                        ${CoreAPI.escapeHtml(tag)}
                    </span>
                `).join('')}
            </div>
        </div>`;
    }
    
    if (analysis.some.length > 0) {
        const shown = analysis.some.slice(0, BT_PILL_CAP);
        const rest = analysis.some.length - shown.length;
        html += `<div class="bt-group">
            <div class="bt-group-label">On some${rest > 0 ? ` (the ${BT_PILL_CAP} most shared)` : ''}:</div>
            <div class="bt-group-pills">
                ${shown.map(t => `
                    <span class="cl-tag cl-tag-warning" data-tag="${CoreAPI.escapeHtml(t.name)}" title="On ${t.count.toLocaleString()} of ${analysis.total.toLocaleString()}; click to add to the removal list">
                        ${CoreAPI.escapeHtml(t.name)} <span class="bt-count">(${t.count.toLocaleString()}/${analysis.total.toLocaleString()})</span>
                    </span>
                `).join('')}
            </div>
            ${rest > 0 ? `<div class="bt-group-more">and ${rest.toLocaleString()} more; type in Remove to find one</div>` : ''}
        </div>`;
    }
    
    if (analysis.all.length === 0 && analysis.some.length === 0) {
        html = '<div class="bt-empty">None of them carries a tag</div>';
    }
    
    container.innerHTML = html;
    
    // Click-to-remove shortcut: one listener for every pill
    container.onclick = (e) => {
        const pill = e.target.closest?.('.cl-tag[data-tag]');
        if (pill && container.contains(pill)) addTagToRemoveList(pill.dataset.tag);
    };
}

function addTagToAddList(tag) {
    const normalized = tag.trim();
    if (!normalized) return;
    
    const container = document.getElementById('batchTagAddPills');
    if (container.querySelector(`[data-tag="${CSS.escape(normalized)}"]`)) {
        return;
    }
    
    const pill = document.createElement('span');
    pill.className = 'cl-tag cl-tag-info';
    pill.dataset.tag = normalized;
    pill.innerHTML = `${CoreAPI.escapeHtml(normalized)} <i class="fa-solid fa-xmark bt-pill-close"></i>`;
    pill.querySelector('.bt-pill-close').addEventListener('click', (e) => {
        e.stopPropagation();
        pill.remove();
    });
    
    container.appendChild(pill);
}

function addTagToRemoveList(tag) {
    const normalized = tag.trim();
    if (!normalized) return;
    
    const container = document.getElementById('batchTagRemovePills');
    if (container.querySelector(`[data-tag="${CSS.escape(normalized)}"]`)) {
        return;
    }
    
    const pill = document.createElement('span');
    pill.className = 'cl-tag cl-tag-danger';
    pill.dataset.tag = normalized;
    pill.innerHTML = `${CoreAPI.escapeHtml(normalized)} <i class="fa-solid fa-xmark bt-pill-close"></i>`;
    pill.querySelector('.bt-pill-close').addEventListener('click', (e) => {
        e.stopPropagation();
        pill.remove();
    });
    
    container.appendChild(pill);
}

function getTagsToAdd() {
    const pills = document.querySelectorAll('#batchTagAddPills .cl-tag');
    return Array.from(pills).map(p => p.dataset.tag);
}

function getTagsToRemove() {
    const pills = document.querySelectorAll('#batchTagRemovePills .cl-tag');
    return Array.from(pills).map(p => p.dataset.tag);
}

async function applyBatchTags() {
    if (applyInProgress) return;
    // typed text joins the pills first: the blur's commit waits 200 ms for a suggestion click
    commitTypedTags(document.getElementById('batchTagAddInput'), 'add');
    commitTypedTags(document.getElementById('batchTagRemoveInput'), 'remove');
    const tagsToAdd = getTagsToAdd();
    const tagsToRemove = getTagsToRemove();

    if (tagsToAdd.length === 0 && tagsToRemove.length === 0) {
        CoreAPI.showToast('No tag changes specified', 'warning');
        return;
    }

    const onSelection = !target;
    const on = target || selectionTarget();
    if (!on) {
        CoreAPI.showToast('No characters selected', 'error');
        return;
    }
    const byFilter = on.filter !== undefined;
    const ids = byFilter ? null : on.ids;
    const size = byFilter ? tallyTotal : ids.length;

    const applyBtn = document.getElementById('batchTagApplyBtn');
    const originalHtml = applyBtn.innerHTML;
    // a close or a reopen moves tallySeq: the answer then belongs to no dialog on screen
    const openedAs = tallySeq;
    applyBtn.disabled = true;
    applyInProgress = true;
    applyBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Applying to ${size == null ? 'them' : size.toLocaleString()}...`;

    // the one tag write (relation rows only): by ids one transaction, by filter a chunked server job Cancel stops between chunks
    const cancelBtn = document.getElementById('batchTagCancelBtn');
    const offJob = byFilter ? CoreAPI.onJob((job) => {
        if (job.kind !== 'apply' || (applyJobId !== null && job.id !== applyJobId)) return;
        if (applyJobId === null) {
            applyJobId = job.id;
            CoreAPI.setRunVerb(cancelBtn, 'running');
        }
        applyBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${job.done.toLocaleString()} of ${job.total.toLocaleString()}`;
    }) : null;
    let result = null;
    let error = null;
    try {
        result = await runCommand('tags.apply', byFilter
            ? { filter: on.filter, add: tagsToAdd, remove: tagsToRemove }
            : { ids, add: tagsToAdd, remove: tagsToRemove });
        // a refusal throws in the server's words; nothing answered is an override holding it back
        if (!result) error = 'the change was held back';
    } catch (e) {
        error = e?.message || 'network error';
    }

    offJob?.();
    // a dialog closed or reopened meanwhile still hears the answer, but its Apply, its pills and the selection are not this apply's
    const stillOpen = openedAs === tallySeq;
    if (stillOpen) {
        applyInProgress = false;
        applyJobId = null;
        resetCancelButton();
        applyBtn.disabled = false;
        applyBtn.innerHTML = originalHtml;
    }

    if (error) {
        CoreAPI.showToast(`Batch tagging failed: ${error}`, 'error');
    } else if (result.stopped) {
        CoreAPI.showToast(`Stopped: tags updated for ${(result.changed || 0).toLocaleString()} character(s); Undo last run in the Tags Manager reverts them`, 'warning', 6000);
    } else {
        const changed = byFilter ? (result.changed || 0) : (result.deltas || []).length;
        CoreAPI.showToast(`Updated tags for ${changed.toLocaleString()} character(s)`, 'success');
    }

    // a failed apply keeps the dialog, its pills and its target for a retry
    if (stillOpen && !error) closeModal();
    // a filter write refreshed inside the command; an id write re-read only its characters, so tags + grid are asked again
    if (!byFilter) await CoreAPI.refreshCharacters(true);
    if (stillOpen && onSelection && !error) CoreAPI.clearSelection();
}

function closeModal() {
    target = null;
    tallySeq++;
    document.getElementById('batchTagModal')?.classList.remove('visible');
}

// the footer's Cancel as the dialog opens it; a running job turns it into the run's stop verb
function resetCancelButton() {
    const btn = document.getElementById('batchTagCancelBtn');
    if (!btn) return;
    btn.className = 'cl-btn cl-btn-secondary';
    btn.disabled = false;
    delete btn.dataset.runState;
    btn.textContent = 'Cancel';
}

// the footer's Apply as the dialog opens it; an apply in flight holds it
const APPLY_LABEL = '<i class="fa-solid fa-check"></i> Apply Changes';
function resetApplyButton() {
    const btn = document.getElementById('batchTagApplyBtn');
    if (!btn) return;
    btn.disabled = false;
    btn.innerHTML = APPLY_LABEL;
}

// Cancel stops a running job (between chunks) and leaves the dialog to report it; otherwise it closes
function onCancel() {
    if (applyInProgress && applyJobId !== null) {
        CoreAPI.setRunVerb(document.getElementById('batchTagCancelBtn'), 'stopping');
        void CoreAPI.stopJob(applyJobId);
        return;
    }
    closeModal();
}

function setupEventListeners() {
    document.getElementById('batchTagCloseBtn')?.addEventListener('click', closeModal);
    document.getElementById('batchTagCancelBtn')?.addEventListener('click', onCancel);
    document.getElementById('batchTagApplyBtn')?.addEventListener('click', applyBatchTags);
    document.getElementById('batchTagModal')?.addEventListener('click', (e) => {
        // Backdrop taps dont close while an apply is in flight
        if (e.target.id === 'batchTagModal' && !applyInProgress) {
            closeModal();
        }
    });
    
    setupAutocomplete('batchTagAddInput', 'batchTagAddSuggestions', 'add');
    setupAutocomplete('batchTagRemoveInput', 'batchTagRemoveSuggestions', 'remove');
}

function setupAutocomplete(inputId, suggestionsId, mode) {
    const input = document.getElementById(inputId);
    const suggestions = document.getElementById(suggestionsId);
    if (!input || !suggestions) return;
    
    let selectedIndex = -1;
    // the add list asks the server, so a typing burst asks once and a late answer is dropped
    let suggestSeq = 0;
    let suggestTimer = 0;

    input.addEventListener('input', () => {
        clearTimeout(suggestTimer);
        const parts = input.value.split(',');
        const currentPart = parts[parts.length - 1].trim().toLowerCase();

        if (currentPart.length === 0) {
            ++suggestSeq;
            hideSuggestions(suggestions);
            return;
        }

        suggestTimer = setTimeout(async () => {
            const mine = ++suggestSeq;
            const availableTags = await getAvailableTags(mode, currentPart);
            if (mine !== suggestSeq) return;

            const matches = availableTags.filter(tag =>
                tag.toLowerCase().includes(currentPart) &&
                !isTagAlreadyAdded(tag, mode)
            ).slice(0, 10);

            if (matches.length === 0) {
                hideSuggestions(suggestions);
                return;
            }

            renderSuggestions(suggestions, matches, currentPart, mode);
            selectedIndex = -1;
        }, mode === 'add' ? 150 : 0);
    });
    
    // Keyboard navigation
    input.addEventListener('keydown', (e) => {
        const items = suggestions.querySelectorAll('.bt-suggestion-item');
        
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            updateSelectedSuggestion(items, selectedIndex);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, -1);
            updateSelectedSuggestion(items, selectedIndex);
        } else if (e.key === 'Enter') {
            if (selectedIndex >= 0 && items[selectedIndex]) {
                e.preventDefault();
                selectSuggestion(input, suggestions, items[selectedIndex].dataset.tag, mode);
                selectedIndex = -1;
            } else {
                const value = input.value.trim().replace(/,+$/, '');
                if (value) {
                    e.preventDefault();
                    value.split(',').forEach(tag => {
                        if (mode === 'add') {
                            addTagToAddList(tag.trim());
                        } else {
                            addTagToRemoveList(tag.trim());
                        }
                    });
                    input.value = '';
                    hideSuggestions(suggestions);
                }
            }
        } else if (e.key === ',') {
            if (selectedIndex >= 0 && items[selectedIndex]) {
                e.preventDefault();
                selectSuggestion(input, suggestions, items[selectedIndex].dataset.tag, mode);
                selectedIndex = -1;
            }
        } else if (e.key === 'Escape') {
            hideSuggestions(suggestions);
            selectedIndex = -1;
        } else if (e.key === 'Tab' && !suggestions.classList.contains('hidden')) {
            if (items.length > 0) {
                e.preventDefault();
                selectSuggestion(input, suggestions, items[0].dataset.tag, mode);
                selectedIndex = -1;
            }
        }
    });
    
    // Delayed so a click on a suggestion still lands
    input.addEventListener('blur', () => {
        setTimeout(() => {
            hideSuggestions(suggestions);
            commitTypedTags(input, mode);
        }, 200);
    });
}

// What an input still holds becomes pills, comma-separated, and the input empties.
function commitTypedTags(input, mode) {
    const value = input?.value.trim();
    if (!value) return;
    value.split(',').forEach(tag => {
        if (mode === 'add') addTagToAddList(tag.trim());
        else addTagToRemoveList(tag.trim());
    });
    input.value = '';
}

// add: the library's tags containing the text (server-side); remove: the target's own tags, sorted once with the tally
async function getAvailableTags(mode, text) {
    if (mode === 'add') return CoreAPI.suggestTags(text, { limit: 20 });
    return currentTagAnalysis?.names || [];
}

function isTagAlreadyAdded(tag, mode) {
    const containerId = mode === 'add' ? 'batchTagAddPills' : 'batchTagRemovePills';
    const container = document.getElementById(containerId);
    return container?.querySelector(`[data-tag="${CSS.escape(tag)}"]`) !== null;
}

function renderSuggestions(container, tags, highlight, mode) {
    const html = tags.map(tag => {
        const lowerTag = tag.toLowerCase();
        const idx = lowerTag.indexOf(highlight.toLowerCase());
        let displayTag;
        if (idx >= 0) {
            displayTag = CoreAPI.escapeHtml(tag.substring(0, idx)) +
                '<strong>' + CoreAPI.escapeHtml(tag.substring(idx, idx + highlight.length)) + '</strong>' +
                CoreAPI.escapeHtml(tag.substring(idx + highlight.length));
        } else {
            displayTag = CoreAPI.escapeHtml(tag);
        }
        return `<div class="bt-suggestion-item" data-tag="${CoreAPI.escapeHtml(tag)}">${displayTag}</div>`;
    }).join('');
    
    container.innerHTML = html;
    container.classList.remove('hidden');
    
    container.querySelectorAll('.bt-suggestion-item').forEach(item => {
        item.addEventListener('mousedown', (e) => {
            e.preventDefault(); // Prevent blur
            const input = document.getElementById(mode === 'add' ? 'batchTagAddInput' : 'batchTagRemoveInput');
            selectSuggestion(input, container, item.dataset.tag, mode);
        });
    });
}

function hideSuggestions(container) {
    container.classList.add('hidden');
    container.innerHTML = '';
}

function updateSelectedSuggestion(items, index) {
    items.forEach((item, i) => {
        item.classList.toggle('selected', i === index);
    });
}

function selectSuggestion(input, suggestions, tag, mode) {
    const parts = input.value.split(',');
    parts.pop();
    
    if (mode === 'add') {
        addTagToAddList(tag);
    } else {
        addTagToRemoveList(tag);
    }
    
    input.value = parts.length > 0 ? parts.join(',') + ', ' : '';
    hideSuggestions(suggestions);
    input.focus();
}

function injectModal() {
    const modalHtml = `
    <div id="batchTagModal" class="cl-modal batch-tag-modal">
        <div class="cl-modal-content batch-tag-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-tags"></i> Batch Tag Editor</h3>
                <span class="bt-char-count"><span id="batchTagCharCount">0</span> <span id="batchTagCharNoun">characters</span></span>
                <button id="batchTagCloseBtn" class="cl-modal-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            
            <div class="cl-modal-body">
                <!-- Existing tags section -->
                <div class="bt-section">
                    <div class="bt-section-title">Current Tags</div>
                    <div id="batchTagExisting" class="bt-existing">
                        <!-- Populated dynamically -->
                    </div>
                    <div class="bt-hint">Click a tag above to add it to the removal list</div>
                </div>
                
                <!-- Add tags section -->
                <div class="bt-section">
                    <div class="bt-section-title"><i class="fa-solid fa-plus"></i> Add Tags</div>
                    <div class="bt-input-wrapper">
                        <input type="search" id="batchTagAddInput" class="cl-input" placeholder="Type tag and press Enter (comma-separated for multiple)" autocomplete="one-time-code">
                        <div id="batchTagAddSuggestions" class="bt-suggestions hidden"></div>
                    </div>
                    <div id="batchTagAddPills" class="bt-pills"></div>
                </div>
                
                <!-- Remove tags section -->
                <div class="bt-section">
                    <div class="bt-section-title"><i class="fa-solid fa-minus"></i> Remove Tags</div>
                    <div class="bt-input-wrapper">
                        <input type="search" id="batchTagRemoveInput" class="cl-input" placeholder="Type tag and press Enter, or click tags above" autocomplete="one-time-code">
                        <div id="batchTagRemoveSuggestions" class="bt-suggestions hidden"></div>
                    </div>
                    <div id="batchTagRemovePills" class="bt-pills"></div>
                </div>
            </div>
            
            <div class="cl-modal-footer">
                <button id="batchTagCancelBtn" class="cl-btn cl-btn-secondary">Cancel</button>
                <button id="batchTagApplyBtn" class="cl-btn cl-btn-primary">${APPLY_LABEL}</button>
            </div>
        </div>
    </div>`;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    CoreAPI.mountDialogSizing('batchTagModal');
}

export default {
    init,
    openModal
};
