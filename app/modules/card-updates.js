import * as CoreAPI from './core-api.js';
import { matchLorebookEntries, compareLorebookMeta, lorebookEntryName, hasLorebookMeta, lorebooksEqual, entryInWorld } from './lorebook-diff.js';
import { CARD_COMPARABLE_FIELDS, LONG_TEXT_KEYS, readCardField, cardValuesEqual } from './card-fields.js';
import { runCommand } from './ext-registry.js';

let isInitialized = false;
let currentUpdateChecks = new Map(); // fullPath -> { local, remote, diffs }
let abortController = null;
let pendingBatchCharacters = [];
let batchCheckPaused = false;
let batchCheckRunning = false;
let batchSelectedIds = new Set(); // char uuids checked for inclusion in Apply All
let batchStatusFilter = 'all'; // Active filter: 'all' | 'has-updates' | 'up-to-date' | 'errors' | 'unavailable' | 'applied'

// fields come from card-fields.js; listing_name is this checker's virtual one (see compareCards). Provider fields merge at init
const LISTING_NAME_FIELD = { key: 'listing_name', label: 'Listing Name', icon: 'fa-store' };
const BASE_COMPARABLE_FIELDS = Object.fromEntries([...CARD_COMPARABLE_FIELDS, LISTING_NAME_FIELD].map(f => [f.key, f.label]));

const BASE_FIELD_ICONS = Object.fromEntries([...CARD_COMPARABLE_FIELDS, LISTING_NAME_FIELD].map(f => [f.key, `fa-solid ${f.icon}`]));

// Effective fields - rebuilt after providers register
let COMPARABLE_FIELDS = { ...BASE_COMPARABLE_FIELDS };
let FIELD_ICONS = { ...BASE_FIELD_ICONS };

// Maps provider-specific field paths to their provider ID
// Base fields are NOT in this map - only provider-contributed fields.
let fieldProviderMap = {};

// Groups of provider fields that share a single filter checkbox.
// Maps group name → { label, icon, paths: string[] }
let fieldGroups = {};

// Fields relevant to the current batch (based on represented providers)
// Null = all fields (single-check mode). Set = filtered for batch.
let batchRelevantFields = null;

function fieldIcon(field) {
    const icon = FIELD_ICONS[field] || 'fa-solid fa-file-alt';
    const label = COMPARABLE_FIELDS[field] || field;
    return `<i class="${icon} batch-field-icon" title="${label}"></i>`;
}

let batchFieldSelection = new Set(
    Object.keys(COMPARABLE_FIELDS)
);

// the long-text fields, the one definition's
const BASE_LONG_TEXT_FIELDS = LONG_TEXT_KEYS;
let LONG_TEXT_FIELDS = new Set(BASE_LONG_TEXT_FIELDS);

function rebuildEffectiveFields() {
    COMPARABLE_FIELDS = { ...BASE_COMPARABLE_FIELDS };
    FIELD_ICONS = { ...BASE_FIELD_ICONS };
    LONG_TEXT_FIELDS = new Set(BASE_LONG_TEXT_FIELDS);
    fieldProviderMap = {};
    fieldGroups = {};

    const providers = CoreAPI.getAllProviders();
    for (const p of providers) {
        const fields = p.getComparableFields?.() || [];
        for (const f of fields) {
            COMPARABLE_FIELDS[f.path] = f.label;
            if (f.icon) FIELD_ICONS[f.path] = f.icon;
            fieldProviderMap[f.path] = p.id;

            if (f.group) {
                if (!fieldGroups[f.group]) {
                    fieldGroups[f.group] = {
                        label: f.groupLabel || f.group,
                        icon: f.icon || 'fa-solid fa-file-alt',
                        paths: []
                    };
                }
                fieldGroups[f.group].paths.push(f.path);
            }
        }
    }
    batchFieldSelection = new Set(Object.keys(COMPARABLE_FIELDS));
}

export function init(deps) {
    if (isInitialized) {
        console.warn('[CardUpdates] Already initialized');
        return;
    }
    
    injectModals();
    setupEventListeners();
    rebuildEffectiveFields();

    window.registerOverlay?.({ id: 'cardUpdateSingleModal', tier: 7, close: () => closeSingleModal(), visible: (el) => el.classList.contains('visible') });
    window.registerOverlay?.({ id: 'cardUpdateBatchModal', tier: 8, close: () => closeBatchModal(), visible: (el) => el.classList.contains('visible') });
    CoreAPI.onCharactersDeleted(onCharactersDeleted);

    isInitialized = true;
    CoreAPI.debugLog('[CardUpdates] Module initialized');
}

export async function checkSingleCharacter(char) {
    if (!isInitialized) {
        console.error('[CardUpdates] Module not initialized');
        return;
    }
    
    const linkInfo = getProviderLinkInfo(char);
    if (!linkInfo?.fullPath) {
        CoreAPI.showToast('Character is not linked to an online provider', 'warning');
        return;
    }
    
    showSingleCheckModal(char);

    if (CoreAPI.isUpdateLocked(char)) {
        const statusEl = document.getElementById('cardUpdateSingleStatus');
        if (statusEl) {
            setBand(statusEl, 'warn', 'fa-lock', 'Updates are locked for this character', 'Unlock it to compare it with its source.');
            statusEl.insertAdjacentHTML('beforeend', `<button type="button" id="cardUpdateSingleUnlockBtn" class="cl-btn cl-btn-secondary">
                <i class="fa-solid fa-lock-open"></i> Unlock and Check
            </button>`);
            document.getElementById('cardUpdateSingleUnlockBtn')?.addEventListener('click', async () => {
                try {
                    await CoreAPI.setUpdateLocked(char.id, false);
                    setBand(statusEl, '', 'fa-spinner fa-spin', 'Checking for updates...');
                    await performSingleCheck(char);
                } catch (err) {
                    console.error('[CardUpdates] Failed to unlock:', err);
                    setBand(statusEl, 'error', 'fa-triangle-exclamation', 'Could not unlock this character');
                }
            });
        }
        return;
    }

    await performSingleCheck(char);
}

export async function checkAllLinkedCharacters() {
    if (!isInitialized) {
        console.error('[CardUpdates] Module not initialized');
        return;
    }
    
    const linkedChars = await getLinkedCharacters();
    if (linkedChars.length === 0) {
        CoreAPI.showToast('No characters are linked to an online provider', 'info');
        return;
    }
    
    showBatchCheckModal(linkedChars);
}

export async function checkSelectedCharacters() {
    if (!isInitialized) {
        console.error('[CardUpdates] Module not initialized');
        return;
    }
    
    const selection = CoreAPI.getSelection();
    if (!selection.count) {
        CoreAPI.showToast('No characters selected', 'warning');
        return;
    }

    // a Select All reads its linked members as set rows; a picked selection, the page's rows or by-id reads
    let rows;
    if (selection.filter !== undefined) {
        rows = await CoreAPI.fetchCharacterSetWhere(CoreAPI.narrowFilter(selection.filter, { field: 'providerLink', op: 'is_linked' }), ['name', 'links']);
    } else {
        const held = selection.ids.map(id => CoreAPI.getCharacterById(id));
        rows = held.every(c => c?.data) ? held : await CoreAPI.fetchCharactersByIds(selection.ids);
    }
    const linkedSelected = rows.filter(c => getProviderLinkInfo(c)?.fullPath);
    if (linkedSelected.length === 0) {
        CoreAPI.showToast('None of the selected characters are linked to an online provider', 'warning');
        return;
    }
    
    showBatchCheckModal(linkedSelected);
}

// ========================================
// PROVIDER INTEGRATION
// ========================================

/**
 * @param {Object} char - Character object
 * @returns {Object|null} { providerId, id, fullPath, linkedAt } or null
 */
function getProviderLinkInfo(char) {
    return CoreAPI.getProviderLinkInfo(char);
}

/**
 * @returns {Promise<Array>} Characters with provider links (server-answered)
 */
async function getLinkedCharacters() {
    const all = await CoreAPI.getAllLinkedCharacters();
    return all.map(item => item.char);
}

function generateSideBySideDiff(localValue, remoteValue) {
    const localStr = formatValueForDisplay(localValue);
    const remoteStr = formatValueForDisplay(remoteValue);
    
    const localLines = localStr.split('\n');
    const remoteLines = remoteStr.split('\n');
    
    const lineDiff = CoreAPI.computeLineDiff(localLines, remoteLines);
    
    const localOutput = [];
    const remoteOutput = [];
    let changedLines = 0;
    let addedLines = 0;
    let removedLines = 0;
    
    let i = 0;
    while (i < lineDiff.length) {
        const item = lineDiff[i];
        
        if (item.type === 'context') {
            localOutput.push({ type: 'context', html: CoreAPI.escapeHtml(item.line) });
            remoteOutput.push({ type: 'context', html: CoreAPI.escapeHtml(item.line) });
            i++;
        } else if (item.type === 'removed' && i + 1 < lineDiff.length && lineDiff[i + 1].type === 'added') {
            const { oldHtml, newHtml } = wordDiffHtml(item.line, lineDiff[i + 1].line);
            localOutput.push({ type: 'changed', html: oldHtml });
            remoteOutput.push({ type: 'changed', html: newHtml });
            changedLines++;
            i += 2;
        } else if (item.type === 'removed') {
            localOutput.push({ type: 'removed', html: CoreAPI.escapeHtml(item.line) });
            remoteOutput.push({ type: 'empty', html: '' });
            removedLines++;
            i++;
        } else if (item.type === 'added') {
            localOutput.push({ type: 'empty', html: '' });
            remoteOutput.push({ type: 'added', html: CoreAPI.escapeHtml(item.line) });
            addedLines++;
            i++;
        } else {
            i++;
        }
    }
    
    const localHtml = localOutput.map(item => {
        if (item.type === 'empty') {
            return '<div class="diff-line empty"></div>';
        }
        const className = item.type === 'context' ? 'diff-line' : 
                         item.type === 'changed' ? 'diff-line changed' : 
                         'diff-line removed';
        return `<div class="${className}">${item.html || '&nbsp;'}</div>`;
    }).join('');
    
    const remoteHtml = remoteOutput.map(item => {
        if (item.type === 'empty') {
            return '<div class="diff-line empty"></div>';
        }
        const className = item.type === 'context' ? 'diff-line' : 
                         item.type === 'changed' ? 'diff-line changed' : 
                         'diff-line added';
        return `<div class="${className}">${item.html || '&nbsp;'}</div>`;
    }).join('');
    
    const statParts = [];
    if (changedLines > 0) statParts.push(`${changedLines} modified`);
    if (addedLines > 0) statParts.push(`${addedLines} added`);
    if (removedLines > 0) statParts.push(`${removedLines} removed`);
    const stats = statParts.length > 0 ? statParts.join(', ') : 'different';
    
    return { localHtml, remoteHtml, stats };
}

// Both LCS walks live in library.js now; only this panel's span markup stays here.
function wordDiffHtml(oldLine, newLine) {
    const d = CoreAPI.computeWordDiff(oldLine, newLine);
    const oldHtml = d.old.map(item => {
        const escaped = CoreAPI.escapeHtml(item.text);
        return item.type === 'removed'
            ? `<span class="word-removed">${escaped}</span>`
            : escaped;
    }).join('');
    const newHtml = d.new.map(item => {
        const escaped = CoreAPI.escapeHtml(item.text);
        return item.type === 'added'
            ? `<span class="word-added">${escaped}</span>`
            : escaped;
    }).join('');
    return { oldHtml, newHtml };
}

// a remote with nothing where the card has text empties the field on apply; the flag lets the UI say so
function clearsField(localValue, remoteValue, field) {
    return !cardValuesEqual(localValue, '', field) && cardValuesEqual(remoteValue, '', field);
}

function compareCards(localData, remoteCard, allowedFields = null) {
    const diffs = [];
    const remoteData = remoteCard?.data || remoteCard;
    
    for (const [field, label] of Object.entries(COMPARABLE_FIELDS)) {
        if (allowedFields && !allowedFields.has(field)) {
            continue;
        }
        // unknown, not removed: a field the provider's remote shape cant carry never proposes blanking local
        if (remoteCard?._unavailableFields?.has(field)) {
            continue;
        }

        // listing_name is virtual: local extensions.{provider}.pageName vs remote _listingName; null = unknown, '' is an answer
        if (field === 'listing_name') {
            const remoteListingName = remoteCard?._listingName;
            if (remoteListingName == null) continue;
            const localListingName = CoreAPI.getListingNameFromExtensions({ data: localData }) || '';
            if (!cardValuesEqual(localListingName, remoteListingName)) {
                diffs.push({ field, label, local: localListingName, remote: remoteListingName, isLongText: false, clears: clearsField(localListingName, remoteListingName, field) });
            }
            continue;
        }

        const localValue = readCardField(localData, field);
        const remoteValue = readCardField(remoteData, field);

        // The embedded character_book and a linked world diverge independently after import:
        // the checker compares and rewrites only the embedded copy and never touches a world.
        if (field === 'character_book') {
            // Remote source knows a lorebook exists but couldnt include its content: unknown, not removed.
            if (remoteCard?._lorebookUnavailable) continue;
            const remoteEntries = remoteValue?.entries || [];
            const localEntries = localValue?.entries || [];

            // Remote has no lorebook but local does - lorebook was removed upstream
            if (remoteEntries.length === 0 && !hasLorebookMeta(remoteValue)) {
                if (localEntries.length > 0) {
                    diffs.push({ field, label, local: localValue, remote: remoteValue, isLongText: false, clears: true });
                }
                continue;
            }

            if (lorebooksEqual(localValue, remoteValue)) continue;

            const { matched, added, removed } = matchLorebookEntries(localEntries, remoteEntries);
            const modified = matched.filter(m => m.changedFields.length > 0);
            const metaDiffs = compareLorebookMeta(localValue, remoteValue);

            if (added.length === 0 && modified.length === 0 && metaDiffs.length === 0 && removed.length === 0) continue;

            diffs.push({
                field, label,
                local: localValue,
                remote: remoteValue,
                isLongText: false,
            });
            continue;
        }
        
        if (!cardValuesEqual(localValue, remoteValue, field)) {
            diffs.push({
                field,
                label,
                local: localValue,
                remote: remoteValue,
                isLongText: LONG_TEXT_FIELDS.has(field),
                clears: clearsField(localValue, remoteValue, field),
            });
        }
    }
    
    return diffs;
}

// remote tags ride the alias ruleset before compare AND apply, else aliased imports diff and apply resurrects raw tags
function aliasRemoteCardTags(remoteCard) {
    if (!remoteCard) return remoteCard;
    if (Array.isArray(remoteCard.data?.tags)) {
        remoteCard.data.tags = CoreAPI.applyTagAliases(remoteCard.data.tags);
    } else if (Array.isArray(remoteCard.tags)) {
        remoteCard.tags = CoreAPI.applyTagAliases(remoteCard.tags);
    }
    return remoteCard;
}


// ========================================
// SINGLE CHARACTER CHECK
// ========================================

// The uuid of the character currently shown in the single-check modal.
// Stored here instead of in HTML attributes to avoid special-character escaping issues.
let singleModalCharId = null;
// moved by every open and close of the single dialog: a check that outlived its dialog paints nothing
let singleCheckSeq = 0;
let singleModalClosedAt = 0;

function openCharModalAbove(charId) {
    if (charId) void CoreAPI.openCharacterById(charId, { elevated: true });
}

/**
 * Show single character update check modal
 * @param {Object} char - Character to check
 */
function showSingleCheckModal(char) {
    const modal = document.getElementById('cardUpdateSingleModal');
    const charName = CoreAPI.getCharacterName(char) || 'Unknown';
    singleModalCharId = char.id;
    singleCheckSeq++;

    const linkInfo = getProviderLinkInfo(char);
    const providerName = linkInfo?.providerId ? (CoreAPI.getProvider(linkInfo.providerId)?.name || linkInfo.providerId) : '';
    const source = [providerName, linkInfo?.fullPath].filter(Boolean).map(s => CoreAPI.escapeHtml(s)).join(', ');
    document.getElementById('cardUpdateSingleSub').innerHTML = `<span class="card-update-char-link" data-char-id="${CoreAPI.escapeHtml(char.id)}" title="Open ${CoreAPI.escapeHtml(charName)}">${CoreAPI.escapeHtml(charName)}</span>${source ? ` · from ${source}` : ''}`;

    setBand(document.getElementById('cardUpdateSingleStatus'), '', 'fa-spinner fa-spin', 'Checking for updates...');
    document.getElementById('cardUpdateSingleContent').innerHTML = '';
    updateSingleSelection();

    modal.classList.add('visible');
}

/**
 * Perform update check for a single character
 * @param {Object} char - Character to check
 */
async function performSingleCheck(char) {
    const statusEl = document.getElementById('cardUpdateSingleStatus');
    const contentEl = document.getElementById('cardUpdateSingleContent');
    const mine = singleCheckSeq;
    // closed, or another character opened: its answer belongs to no dialog, and Apply would write it to the wrong card
    const gone = () => mine !== singleCheckSeq || singleModalCharId !== char.id;

    const match = CoreAPI.getCharacterProvider(char);
    if (!match) {
        setBand(statusEl, 'error', 'fa-triangle-exclamation', 'This character has no provider link');
        return;
    }
    const { provider, linkInfo } = match;
    // a provider with no fetchRemoteCard answers null for every card, which reads as gone below
    if (!provider.supportsRemoteCard) {
        setBand(statusEl, '', 'fa-circle-info', `${CoreAPI.escapeHtml(provider.name)} offers no update check`);
        return;
    }

    try {
        // hydrate swallows failure, and a still-slim card diffs every remote value from '' (which batch-apply would write)
        await CoreAPI.hydrateCharacter(char);
        if (gone()) return;
        if (char._slim) {
            setBand(statusEl, 'error', 'fa-triangle-exclamation', 'Could not load the local card', 'Nothing was compared.');
            return;
        }

        await provider.refreshRemoteData(linkInfo, {
            onStatus: (msg) => { if (!gone()) setBand(statusEl, '', 'fa-spinner fa-spin', CoreAPI.escapeHtml(msg)); },
        });
        if (gone()) return;

        setBand(statusEl, '', 'fa-spinner fa-spin', 'Fetching the remote card...');
        const remoteCard = aliasRemoteCardTags(await provider.fetchRemoteCard(linkInfo));
        if (gone()) return;

        // null is the provider's definitive answer (gone or private); anything unaskable throws into the catch below
        if (!remoteCard) {
            setBand(statusEl, 'warn', 'fa-ghost', `No longer available on ${CoreAPI.escapeHtml(provider.name)}`, 'It was removed or made private. Your copy stays as it is.');
            return;
        }

        const localData = char.data || char;

        const diffs = compareCards(localData, remoteCard);

        if (diffs.length === 0) {
            setBand(statusEl, 'ok', 'fa-check', 'Up to date', `Matches the card on ${CoreAPI.escapeHtml(provider.name)}.`);
            return;
        }

        showChangesBand(statusEl, char, diffs.length);

        currentUpdateChecks.set(char.id, { char, localData, remoteCard, diffs });

        contentEl.innerHTML = renderDiffList(diffs);
        resolveWorldFileStatus(contentEl, char.id).catch(e => console.error('[CardUpdates] World status check failed:', e));
        updateSingleSelection();

    } catch (error) {
        if (gone()) return;
        console.error('[CardUpdates] Check failed:', error);
        setBand(statusEl, 'error', 'fa-xmark', 'Could not check for updates', CoreAPI.escapeHtml(String(error?.message || error).slice(0, 120)));
    }
}

function showChangesBand(statusEl, char, count) {
    const providerName = CoreAPI.getCharacterProvider(char)?.provider?.name;
    setBand(statusEl, '', 'fa-arrow-right-arrow-left', `${count} change${count === 1 ? '' : 's'}${providerName ? ` on ${CoreAPI.escapeHtml(providerName)}` : ''}`, 'The ticked changes are written to your card.');
}

/**
 * Render the diff list HTML
 * @param {Array} diffs - Array of diff objects
 * @returns {string} HTML string
 */
function renderDiffList(diffs) {
    return `
        <div class="card-update-diff-list">
            <label class="card-update-list-head">
                <input type="checkbox" checked class="card-update-select-all-cb" aria-label="Select every change">
                <span class="card-update-list-count"></span>
            </label>
            ${diffs.map((diff, idx) => renderDiffItem(diff, idx)).join('')}
        </div>
    `;
}

/**
 * Render a single diff item
 * @param {Object} diff - Diff object
 * @param {number} idx - Index for unique ID
 * @returns {string} HTML string
 */
function clearsBadge(diff) {
    return diff.clears ? '<span class="cl-tag cl-tag-warning card-update-diff-clears" title="The remote has nothing here: applying empties the field on your card">empties your field</span>' : '';
}

function renderDiffItem(diff, idx) {
    const checkboxId = `diff-item-${idx}`;
    const localDisplay = formatValueForDisplay(diff.local);
    const remoteDisplay = formatValueForDisplay(diff.remote);

    if (diff.field === 'character_book') {
        return renderLorebookDiff(diff, idx);
    }

    if (!diff.isLongText && (Array.isArray(diff.local) || Array.isArray(diff.remote))) {
        const localValues = Array.isArray(diff.local) ? diff.local : [];
        const remoteValues = Array.isArray(diff.remote) ? diff.remote : [];
        return `
            <div class="cl-cwin-row card-update-diff-item short array">
                <label>
                    <input type="checkbox" id="${checkboxId}" data-field="${diff.field}" checked>
                    <span class="card-update-diff-label">${CoreAPI.escapeHtml(diff.label)}</span>${clearsBadge(diff)}
                </label>
                <div class="card-update-array-diff">
                    <div class="card-update-array-column local">
                        <div class="card-update-array-header">
                            <span>Your version</span>
                            <span class="card-update-array-count">${localValues.length}</span>
                        </div>
                        ${renderArrayList(localValues, diff.field, remoteValues)}
                    </div>
                    <div class="card-update-array-column remote">
                        <div class="card-update-array-header">
                            <span>Remote version</span>
                            <span class="card-update-array-count">${remoteValues.length}</span>
                        </div>
                        ${renderArrayList(remoteValues, diff.field, localValues)}
                    </div>
                </div>
            </div>
        `;
    }
    
    if (diff.isLongText) {
        const { localHtml, remoteHtml, stats } = generateSideBySideDiff(diff.local, diff.remote);
        return `
            <div class="cl-cwin-row card-update-diff-item long-text">
                <div class="card-update-diff-header">
                    <label>
                        <input type="checkbox" id="${checkboxId}" data-field="${diff.field}" checked>
                        <span class="card-update-diff-label">${CoreAPI.escapeHtml(diff.label)}</span>${clearsBadge(diff)}
                    </label>
                    <span class="card-update-diff-stats">${stats}</span>
                    <button type="button" class="cl-cwin-btn card-update-diff-expand" aria-label="Show or hide the change" aria-expanded="false">
                        <i class="fa-solid fa-chevron-down"></i>
                    </button>
                </div>
                <div class="card-update-diff-content collapsed">
                    <div class="card-update-diff-sidebyside">
                        <div class="card-update-diff-panel local">
                            <div class="card-update-diff-panel-header">
                                <i class="fa-solid fa-house"></i> Your version
                            </div>
                            <div class="card-update-diff-panel-content">
                                ${localHtml}
                            </div>
                        </div>
                        <div class="card-update-diff-panel remote">
                            <div class="card-update-diff-panel-header">
                                <i class="fa-solid fa-cloud"></i> Remote version
                            </div>
                            <div class="card-update-diff-panel-content">
                                ${remoteHtml}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
    
    return `
        <div class="cl-cwin-row card-update-diff-item short">
            <label>
                <input type="checkbox" id="${checkboxId}" data-field="${diff.field}" checked>
                <span class="card-update-diff-label">${CoreAPI.escapeHtml(diff.label)}</span>${clearsBadge(diff)}
            </label>
            <div class="card-update-diff-values">
                <span class="local-value" title="${CoreAPI.escapeHtml(localDisplay)}">${CoreAPI.escapeHtml(CoreAPI.truncate(localDisplay, 50))}</span>
                <i class="fa-solid fa-arrow-right"></i>
                <span class="remote-value" title="${CoreAPI.escapeHtml(remoteDisplay)}">${CoreAPI.escapeHtml(CoreAPI.truncate(remoteDisplay, 50))}</span>
            </div>
        </div>
    `;
}

// ========================================
// LOREBOOK DIFF
// ========================================

function renderLorebookDiff(diff, idx) {
    const checkboxId = `diff-item-${idx}`;
    const localBook = diff.local;
    const remoteBook = diff.remote;
    const localEntries = localBook?.entries || [];
    const remoteEntries = remoteBook?.entries || [];

    const { matched, added, removed } = matchLorebookEntries(localEntries, remoteEntries);
    const modified = matched.filter(m => m.changedFields.length > 0);
    const metaDiffs = compareLorebookMeta(localBook, remoteBook);

    // "removed" = entries in embedded lorebook but not on remote
    const localOnly = removed;

    if (added.length === 0 && localOnly.length === 0 && modified.length === 0 && metaDiffs.length === 0) return '';

    // Stat pills for the collapsed header
    const statParts = [];
    if (added.length > 0) statParts.push(`${added.length} new from remote`);
    if (localOnly.length > 0) statParts.push(`${localOnly.length} local-only`);
    if (modified.length > 0) statParts.push(`${modified.length} modified`);
    if (metaDiffs.length > 0) statParts.push(`${metaDiffs.length} setting${metaDiffs.length > 1 ? 's' : ''} changed`);
    const stats = statParts.join(', ');

    const remoteRemoved = remoteEntries.length === 0 && !hasLorebookMeta(remoteBook);
    let entriesHtml = '';

    if (remoteRemoved) {
        entriesHtml += `<div class="lorebook-diff-info-box is-warning">
            <i class="fa-solid fa-triangle-exclamation text-warning-pale"></i>
            <div>
                <strong>Lorebook removed on remote</strong>
                <p class="u-mt-xs">The remote card no longer includes an embedded lorebook. Applying this change will clear the ${localEntries.length} embedded entr${localEntries.length === 1 ? 'y' : 'ies'} from your card. Your linked lorebook (if any) is never modified.</p>
            </div>
        </div>`;
    }

    // Help & tips - collapsible explainer
    entriesHtml += `<div class="lorebook-diff-info-box">
        <i class="fa-solid fa-circle-info"></i>
        <div>
            <strong>Embedded lorebook ↔ Remote version</strong>
            <details class="lorebook-diff-help-details">
                <summary>How lorebook updates work</summary>
                <div class="lorebook-diff-help-body">
                    <p>Lorebook data exists in <em>two</em> separate places:</p>
                    <ul>
                        <li><strong>Embedded lorebook</strong> (inside the card): the copy this update checker compares and updates. It was captured when you first imported the card, and editing the standalone lorebook does not change it.</li>
                        <li><strong>Standalone lorebook</strong> (a row in this library): the working copy the Lorebook Manager edits and that chats bind to. The update checker <em>never</em> modifies it.</li>
                    </ul>
                    <p>The diff below compares your card's embedded lorebook against the creator's latest remote version. Applying will replace the embedded lorebook with the remote version.</p>
                    <p><strong>What the badges mean:</strong></p>
                    <ul>
                        <li><span class="text-success-pale">+</span> <strong>New from remote</strong>: entry exists on the remote provider but not in your card. Will be added.</li>
                        <li><span class="text-warning-pale">~</span> <strong>Modified</strong>: entry exists in both but some fields differ. Will be updated to match the remote.</li>
                        <li><span class="text-secondary">★</span> <strong>Local-only</strong>: entry is in your card but not on the remote. Since applying replaces the full embedded lorebook, this entry will be removed from the card.</li>
                    </ul>
                    <p>For local-only entries that would be removed, Project Σ reads your linked lorebook to check whether each entry also exists there:</p>
                    <ul>
                        <li><i class="fa-solid fa-shield-halved text-success-pale"></i> <strong>Safe in the linked lorebook</strong>: a matching entry exists in your linked lorebook. Removing it from the card won't affect your chats since the live copy is untouched.</li>
                        <li><i class="fa-solid fa-triangle-exclamation text-warning-pale"></i> <strong>Not in the linked lorebook</strong>: no match found. This entry only exists in the card's embedded data and will be permanently lost after applying.</li>
                    </ul>
                </div>
            </details>
        </div>
    </div>`;

    if (metaDiffs.length > 0) {
        entriesHtml += `<div class="lorebook-diff-meta-section">
            <div class="lorebook-diff-meta-title">Lorebook settings</div>
            ${metaDiffs.map(m => `<div class="lorebook-diff-meta-row">
                <span class="lorebook-diff-meta-key">${CoreAPI.escapeHtml(m.label)}</span>
                <span class="lorebook-diff-meta-old">${CoreAPI.escapeHtml(m.localStr)}</span>
                <i class="fa-solid fa-arrow-right"></i>
                <span class="lorebook-diff-meta-new">${CoreAPI.escapeHtml(m.remoteStr)}</span>
            </div>`).join('')}
        </div>`;
    }

    for (const entry of added) {
        const name = lorebookEntryName(entry);
        const keys = (entry.keys || []).slice(0, 4).join(', ');
        entriesHtml += `<div class="lorebook-diff-entry added" title="New entry from the remote card - will be added on apply">
            <span class="lorebook-diff-badge added">+</span>
            <span class="lorebook-diff-entry-name">${CoreAPI.escapeHtml(name)}</span>
            ${keys ? `<span class="lorebook-diff-entry-keys">${CoreAPI.escapeHtml(keys)}</span>` : ''}
            <span class="lorebook-diff-entry-tag added">new from remote</span>
        </div>`;
    }

    // Entries in embedded lorebook but not on remote - will be lost from embedded on apply
    for (const entry of localOnly) {
        const name = lorebookEntryName(entry);
        const keys = (entry.keys || []).slice(0, 4).join(', ');
        const keysData = CoreAPI.escapeHtml(JSON.stringify(entry.keys || []));
        const nameData = CoreAPI.escapeHtml(entry.comment || entry.name || '');
        entriesHtml += `<div class="lorebook-diff-entry local-only" data-lb-keys="${keysData}" data-lb-name="${nameData}" title="This entry is in your embedded lorebook but not on the remote card. Applying will replace the embedded lorebook with the remote version, so this entry will be removed from the card.">
            <span class="lorebook-diff-badge local-only">&#9733;</span>
            <span class="lorebook-diff-entry-name">${CoreAPI.escapeHtml(name)}</span>
            ${keys ? `<span class="lorebook-diff-entry-keys">${CoreAPI.escapeHtml(keys)}</span>` : ''}
            <span class="lorebook-diff-entry-tag local-only">local-only</span>
            <span class="lorebook-world-check" title="Checking the linked lorebook…"><i class="fa-solid fa-spinner fa-spin u-text-3xs u-dim-50"></i></span>
        </div>`;
    }

    for (const m of modified) {
        const name = lorebookEntryName(m.remote);
        const changes = m.changedFields.join(', ');
        entriesHtml += `<div class="lorebook-diff-entry modified" title="Entry matched by key overlap - the following fields differ: ${CoreAPI.escapeHtml(changes)}">
            <span class="lorebook-diff-badge modified">~</span>
            <span class="lorebook-diff-entry-name">${CoreAPI.escapeHtml(name)}</span>
            <span class="lorebook-diff-entry-changes">${CoreAPI.escapeHtml(changes)}</span>
        </div>`;
    }

    const unchangedCount = matched.length - modified.length;
    if (unchangedCount > 0) {
        entriesHtml += `<div class="lorebook-diff-entry unchanged">
            <span class="lorebook-diff-unchanged-count">${unchangedCount} unchanged entr${unchangedCount === 1 ? 'y' : 'ies'}</span>
        </div>`;
    }



    return `
        <div class="cl-cwin-row card-update-diff-item long-text lorebook">
            <div class="card-update-diff-header">
                <label>
                    <input type="checkbox" id="${checkboxId}" data-field="${diff.field}" checked>
                    <span class="card-update-diff-label">${CoreAPI.escapeHtml(diff.label)}</span>${clearsBadge(diff)}
                    <span class="lorebook-entry-counts">
                        <span class="local-count">${localEntries.length}</span>
                        <i class="fa-solid fa-arrow-right"></i>
                        <span class="remote-count">${remoteEntries.length}</span>
                    </span>
                </label>
                <span class="card-update-diff-stats">${stats}</span>
                <button type="button" class="cl-cwin-btn card-update-diff-expand" aria-label="Show or hide the change" aria-expanded="false">
                    <i class="fa-solid fa-chevron-down"></i>
                </button>
            </div>
            <div class="card-update-diff-content collapsed">
                <div class="lorebook-diff-entries">
                    ${entriesHtml}
                </div>
            </div>
        </div>
    `;
}

/**
 * Post-render: fetch the linked world file and update each local-only entry
 * row with a per-entry "safe" or "not in the linked lorebook" badge.
 */
async function resolveWorldFileStatus(containerEl, charId) {
    if (!containerEl || !charId) return;
    const rows = containerEl.querySelectorAll('.lorebook-diff-entry.local-only[data-lb-keys]');
    if (rows.length === 0) return;

    const markAllNoWorld = (reason) => {
        for (const row of rows) {
            const check = row.querySelector('.lorebook-world-check');
            if (check) { check.innerHTML = ''; check.title = ''; }
            const tag = row.querySelector('.lorebook-diff-entry-tag');
            if (tag) tag.textContent = 'local-only · no linked lorebook';
            row.title = `This entry is in your embedded lorebook but not on the remote card. Applying will remove it from the card. ${reason}`;
        }
    };

    try {
        // the server answers the head of the char_worlds list; the old name-guess
        // fallback existed only because the cache read returned null for slim chars
        const worldName = await CoreAPI.getCharacterWorldName(charId);

        if (!worldName) {
            markAllNoWorld('No linked lorebook was found.');
            return;
        }

        let worldData;
        try {
            worldData = await CoreAPI.getWorldInfoData(worldName);
        } catch (_) { /* fetch failed */ }

        if (!worldData?.entries) {
            markAllNoWorld(`The linked lorebook "${worldName}" could not be read.`);
            return;
        }

        const worldEntries = Object.values(worldData.entries).filter(e => e && typeof e === 'object');

        for (const row of rows) {
            let entryKeys;
            try { entryKeys = JSON.parse(row.dataset.lbKeys || '[]'); } catch (_) { entryKeys = []; }
            const found = entryInWorld({ keys: entryKeys, name: row.dataset.lbName }, worldEntries);

            const check = row.querySelector('.lorebook-world-check');
            const tag = row.querySelector('.lorebook-diff-entry-tag');
            if (found) {
                if (check) {
                    check.innerHTML = '<i class="fa-solid fa-shield-halved text-success-pale u-text-2xs"></i>';
                    check.title = `Also in the linked lorebook "${worldName}": safe, applying leaves it alone`;
                }
                if (tag) tag.textContent = 'local-only · safe in the linked lorebook';
                row.title = `This entry is in your embedded lorebook but not on the remote. Applying removes it from the card, but it also exists in your linked lorebook "${worldName}", which is not affected.`;
            } else {
                if (check) {
                    check.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-warning-pale u-text-2xs"></i>';
                    check.title = `Not in the linked lorebook "${worldName}": this entry only exists in the embedded lorebook and is lost if you apply`;
                }
                if (tag) {
                    tag.textContent = 'local-only · not in the linked lorebook';
                    tag.classList.remove('local-only');
                    tag.classList.add('warning');
                }
                row.title = `This entry exists only in the embedded lorebook (not found in the linked lorebook "${worldName}"). Applying will remove it from the card with no backup elsewhere.`;
            }
        }
    } catch (err) {
        console.error('[CardUpdates] resolveWorldFileStatus error:', err);
        markAllNoWorld('The linked lorebook check failed.');
    }
}

function renderArrayList(values, field, otherSide = null) {
    if (!values || values.length === 0) {
        return '<div class="card-update-array-list"><span class="card-update-empty">(empty)</span></div>';
    }
    const otherSet = otherSide ? new Set(otherSide.map(v =>
        (typeof v === 'string' ? v : JSON.stringify(v)).toLowerCase().trim()
    )) : null;
    const items = values.map(value => {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        let classes = field === 'tags' ? 'card-update-pill tag' : 'card-update-pill';
        if (otherSet && !otherSet.has(text.toLowerCase().trim())) {
            classes += ' card-update-pill-unique';
        }
        return `<span class="${classes}">${CoreAPI.escapeHtml(text)}</span>`;
    }).join('');

    return `<div class="card-update-array-list">${items}</div>`;
}

function formatValueForDisplay(value) {
    if (value === null || value === undefined) return '(empty)';
    if (Array.isArray(value)) {
        if (value.length === 0) return '(empty array)';
        return value.map((v, i) => `[${i + 1}] ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
    }
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    if (typeof value === 'string' && value.trim() === '') return '(empty)';
    return String(value);
}

// ========================================
// BATCH CHECK
// ========================================

function showBatchCheckModal(characters) {
    const modal = document.getElementById('cardUpdateBatchModal');
    const listEl = document.getElementById('cardUpdateBatchList');
    const progressEl = document.getElementById('cardUpdateBatchProgress');
    const fieldSelectEl = document.getElementById('cardUpdateBatchFieldSelect');
    const fieldGridEl = document.getElementById('cardUpdateBatchFieldGrid');
    const fieldCountEl = document.getElementById('cardUpdateBatchFieldCount');

    setBatchSubtitle(characters);
    progressEl.innerHTML = '';
    currentUpdateChecks.clear();
    pendingBatchCharacters = characters;
    batchSelectedIds.clear();
    batchStatusFilter = 'all';

    const filterBar = document.getElementById('cardUpdateBatchFilterBar');
    if (filterBar) filterBar.classList.add('hidden');
    resetBatchFilterTabs();

    const summaryEl = document.getElementById('cardUpdateBatchSummary');
    if (summaryEl) summaryEl.classList.add('hidden');

    const representedProviders = new Set();
    for (const char of characters) {
        const linkInfo = getProviderLinkInfo(char);
        if (linkInfo?.providerId) representedProviders.add(linkInfo.providerId);
    }

    batchRelevantFields = new Set();
    for (const field of Object.keys(COMPARABLE_FIELDS)) {
        const ownerProvider = fieldProviderMap[field];
        if (!ownerProvider || representedProviders.has(ownerProvider)) {
            batchRelevantFields.add(field);
        }
    }

    // Reset selection to all relevant fields so previous-run pruning doesn't carry over
    batchFieldSelection = new Set(batchRelevantFields);

    // Grouped fields (e.g. provider taglines) share a single checkbox.
    if (fieldGridEl) {
        const groupedPaths = new Set();
        for (const g of Object.values(fieldGroups)) {
            for (const p of g.paths) groupedPaths.add(p);
        }

        const items = [];

        for (const field of batchRelevantFields) {
            if (groupedPaths.has(field)) continue;
            const label = COMPARABLE_FIELDS[field];
            const isChecked = batchFieldSelection.has(field);
            items.push(`
                <label class="card-update-field-option">
                    <input type="checkbox" data-field="${field}" ${isChecked ? 'checked' : ''}>
                    <span class="card-update-field-label">${CoreAPI.escapeHtml(label)}</span>
                </label>
            `);
        }

        for (const [groupName, group] of Object.entries(fieldGroups)) {
            const relevantPaths = group.paths.filter(p => batchRelevantFields.has(p));
            if (relevantPaths.length === 0) continue;
            const allChecked = relevantPaths.every(p => batchFieldSelection.has(p));
            items.push(`
                <label class="card-update-field-option">
                    <input type="checkbox" data-group="${groupName}" ${allChecked ? 'checked' : ''}>
                    <span class="card-update-field-label">${CoreAPI.escapeHtml(group.label)}</span>
                </label>
            `);
        }

        fieldGridEl.innerHTML = items.join('');
    }

    if (fieldCountEl) {
        updateBatchFieldCount();
    }

    if (fieldSelectEl) fieldSelectEl.classList.remove('hidden');
    listEl.classList.add('hidden');
    progressEl.classList.add('hidden');
    
    batchCheckPaused = false;
    batchCheckRunning = false;
    updateBatchFooter('idle');

    modal.classList.add('visible');
}

// the header's second line: how many, and from where (a selection can mix providers)
function setBatchSubtitle(characters) {
    const countEl = document.getElementById('cardUpdateBatchCount');
    if (countEl) countEl.textContent = characters.length;
    const nounEl = document.getElementById('cardUpdateBatchNoun');
    if (nounEl) nounEl.textContent = characters.length === 1 ? 'character' : 'characters';
    const names = [...new Set(characters.map(c => getProviderLinkInfo(c)?.providerId).filter(Boolean))]
        .map(id => CoreAPI.getProvider(id)?.name || id);
    const sourcesEl = document.getElementById('cardUpdateBatchSources');
    if (!sourcesEl) return;
    const listed = names.length <= 3 ? names : [...names.slice(0, 2), `${names.length - 2} more`];
    sourcesEl.textContent = listed.length ? ` · from ${listed.length > 1 ? `${listed.slice(0, -1).join(', ')} and ${listed.at(-1)}` : listed[0]}` : '';
}

/**
 * Perform batch update check
 * @param {Array} characters - Characters to check
 */
async function performBatchCheck(characters, allowedFields, startFrom = 0) {
    const progressEl = document.getElementById('cardUpdateBatchProgress');

    // this run's own controller: a closed or replaced run ends at its next step and never writes into the next run's rows
    const run = new AbortController();
    abortController = run;
    const replaced = () => abortController !== run;
    batchCheckRunning = true;
    batchCheckPaused = false;
    updateBatchFooter('checking');
    showBatchProgress();

    for (let i = startFrom; i < characters.length; i++) {
        if (run.signal.aborted || batchCheckPaused) break;

        const char = characters[i];
        const itemEl = document.querySelector(`.card-update-batch-item[data-char-id="${CSS.escape(char.id)}"]`);
        const statusEl = itemEl?.querySelector('.card-update-batch-item-status');

        const deleted = () => itemEl?.dataset.status === 'deleted';
        // a stop that cut this row's refresh off: the row asks again on Resume
        const waitAgain = () => {
            if (deleted()) return;
            if (itemEl) itemEl.dataset.status = 'pending';
            if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-clock"></i> Waiting';
        };
        // only an unasked row is asked: a resume or an unlock skips every row that has its answer, a lock or a deletion
        if (itemEl?.dataset.status && itemEl.dataset.status !== 'pending') continue;

        if (statusEl) {
            statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
        }

        try {
            const match = CoreAPI.getCharacterProvider(char);
            if (!match) {
                if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> No provider';
                if (itemEl) itemEl.dataset.status = 'errors';
                continue;
            }

            if (!match.provider.supportsRemoteCard) {
                if (statusEl) statusEl.innerHTML = `<i class="fa-solid fa-circle-info"></i> ${CoreAPI.escapeHtml(match.provider.name)} offers no update check`;
                if (itemEl) itemEl.dataset.status = 'unavailable';
                batchSelectedIds.delete(char.id);
                const cb = itemEl?.querySelector('.card-update-batch-checkbox');
                if (cb) { cb.checked = false; cb.disabled = true; }
                continue;
            }

            await match.provider.refreshRemoteData(match.linkInfo, {
                signal: run.signal,
                onStatus: statusEl ? (msg) => {
                    if (!deleted()) statusEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${CoreAPI.escapeHtml(msg)}`;
                } : undefined,
            });

            if (replaced()) return;
            if (run.signal.aborted || batchCheckPaused) { waitAgain(); break; }
            const remoteCard = aliasRemoteCardTags(await match.provider.fetchRemoteCard(match.linkInfo));
            if (replaced()) return;
            // deleted while it was being asked about: its row already says so
            if (deleted()) continue;

            if (!remoteCard) {
                if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-ghost"></i> Removed or private';
                if (itemEl) itemEl.dataset.status = 'unavailable';
                // Auto-uncheck -- nothing to apply
                batchSelectedIds.delete(char.id);
                const cb = itemEl?.querySelector('.card-update-batch-checkbox');
                if (cb) { cb.checked = false; cb.disabled = true; }
            } else {
                await CoreAPI.hydrateCharacter(char);
                if (replaced()) return;
                if (char._slim) {
                    // A hollow local reads every remote value as a change from '', and the
                    // batch apply writes every diff unseen; refuse the row instead.
                    if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Could not load the local card';
                    if (itemEl) itemEl.dataset.status = 'unavailable';
                    batchSelectedIds.delete(char.id);
                    const cb = itemEl?.querySelector('.card-update-batch-checkbox');
                    if (cb) { cb.checked = false; cb.disabled = true; }
                    continue;
                }
                const localData = char.data || char;

                const diffs = compareCards(localData, remoteCard, allowedFields);

                if (diffs.length === 0) {
                    if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-check"></i> Up to date';
                    if (itemEl) itemEl.dataset.status = 'up-to-date';
                } else {
                    const names = diffs.map(d => COMPARABLE_FIELDS[d.field] || d.label || d.field).join(', ');
                    if (statusEl) {
                        statusEl.innerHTML = `
                            <span class="card-update-count" title="${CoreAPI.escapeHtml(names)}">${diffs.length} change${diffs.length > 1 ? 's' : ''}</span>
                            <button type="button" class="cl-cwin-btn-text card-update-batch-view-btn" data-view-char-id="${CoreAPI.escapeHtml(char.id)}">View</button>
                        `;
                    }
                    const fieldsEl = itemEl?.querySelector('.card-update-batch-item-fields');
                    if (fieldsEl) { fieldsEl.textContent = names; fieldsEl.title = names; }
                    if (itemEl) itemEl.dataset.status = 'has-updates';
                    currentUpdateChecks.set(char.id, { char, localData, remoteCard, diffs });
                }
            }
        } catch (error) {
            if (replaced()) return;
            if (deleted()) continue;
            if (run.signal.aborted && batchCheckPaused) { waitAgain(); break; }
            // could not ask (rate limit, block, network): the row keeps its checkbox; only a definitive null reads as removed
            console.error('[CardUpdates] Batch check error for:', char.id, error);
            if (statusEl) statusEl.innerHTML = `<i class="fa-solid fa-xmark"></i> Error: ${CoreAPI.escapeHtml(String(error?.message || 'could not fetch').slice(0, 80))}`;
            if (itemEl) itemEl.dataset.status = 'error';
        }

        showBatchProgress();
        updateBatchFooter(batchFooterState());
        updateBatchFilterCounts();
    }

    if (replaced()) return;
    batchCheckRunning = false;

    const { done, left } = batchProgressCounts();
    if (batchCheckPaused && left > 0) {
        setBand(progressEl, 'warn', 'fa-pause', 'Stopped', `${done} of ${done + left} checked. Resume checks the rest.`);
        updateBatchFooter('paused');
    } else if (!batchCheckPaused && !run.signal.aborted && left > 0) {
        // a row unlocked behind the loop: one more pass asks it, every answered row skipped
        return performBatchCheck(characters, allowedFields, 0);
    } else {
        batchCheckPaused = false;
        showBatchDone();
        updateBatchFooter('done');
    }
    updateBatchFilterCounts();
}

// how far the run got, off its rows: a locked or deleted row is neither asked nor waiting
function batchProgressCounts() {
    const rows = [...document.querySelectorAll('#cardUpdateBatchList .card-update-batch-item')];
    const left = rows.filter(r => !r.dataset.status || r.dataset.status === 'pending').length;
    const done = rows.filter(r => ['up-to-date', 'has-updates', 'unavailable', 'error', 'errors', 'applied'].includes(r.dataset.status)).length;
    return { done, left };
}

function showBatchProgress() {
    const { done, left } = batchProgressCounts();
    setBand(document.getElementById('cardUpdateBatchProgress'), '', 'fa-spinner fa-spin', 'Checking for updates', `${done} of ${done + left} checked`);
}

// what the run found, counted off the rows so a resume and a deletion count right
function showBatchDone() {
    const count = (status) => document.querySelectorAll(`#cardUpdateBatchList .card-update-batch-item[data-status="${status}"]`).length;
    const changes = count('has-updates'), upToDate = count('up-to-date'), unavailable = count('unavailable');
    const failed = count('error') + count('errors');
    const checked = changes + upToDate + unavailable + failed + count('applied');
    const parts = [`${changes} with changes`, upToDate && `${upToDate} up to date`, unavailable && `${unavailable} unavailable`, failed && `${failed} failed`].filter(Boolean);
    setBand(document.getElementById('cardUpdateBatchProgress'), failed ? 'warn' : 'ok', failed ? 'fa-triangle-exclamation' : 'fa-check',
        `Checked ${checked}: ${parts.join(', ')}`, changes ? 'View opens a character\'s changes. The ticked characters are updated together.' : '');
}

/**
 * View diffs for a character from batch view
 * @param {string} charId - character uuid
 */
function viewBatchItemDiffs(charId) {
    const checkData = currentUpdateChecks.get(charId);
    if (!checkData) return;
    
    const { char, diffs } = checkData;
    showSingleCheckModal(char);

    const contentEl = document.getElementById('cardUpdateSingleContent');
    showChangesBand(document.getElementById('cardUpdateSingleStatus'), char, diffs.length);
    contentEl.innerHTML = renderDiffList(diffs);
    resolveWorldFileStatus(contentEl, checkData.char?.id).catch(e => console.error('[CardUpdates] World status check failed:', e));
    updateSingleSelection();
}

// ========================================
// APPLY UPDATES
// ========================================

async function applyListingName(char, remoteCard) {
    const listingName = remoteCard?._listingName;
    if (!listingName) return;
    const match = CoreAPI.getCharacterProvider(char);
    if (!match) return;
    const { provider } = match;
    const extKey = provider.id;
    // writeCardFields is the single card writer; it also syncs in-memory state on both refs.
    await CoreAPI.writeCardFields(char, {
        [`extensions.${extKey}.pageName`]: listingName,
    });
}

/**
 * Apply selected updates for a single character
 */
async function applySingleUpdates() {
    const modal = document.getElementById('cardUpdateSingleModal');
    const checkboxes = modal.querySelectorAll('.card-update-diff-item input[type="checkbox"]:checked');
    
    if (checkboxes.length === 0) {
        CoreAPI.showToast('No updates selected', 'warning');
        return;
    }
    
    // Read identity from the JS handle, never re-parsed out of the DOM
    const charId = singleModalCharId;
    const checkData = charId ? currentUpdateChecks.get(charId) : null;
    if (!checkData) return;
    
    const { char, diffs, remoteCard } = checkData;
    const remoteData = remoteCard?.data || remoteCard;
    
    const updatedFields = {};
    let hasListingName = false;
    checkboxes.forEach(cb => {
        const field = cb.dataset.field;
        if (field === 'listing_name') { hasListingName = true; return; }
        const remoteValue = readCardField(remoteData, field);
        // null means "clear this field" - undefined would be silently dropped by JSON
        updatedFields[field] = remoteValue ?? null;
    });
    
    try {
        const versionsModule = CoreAPI.getModule('character-versions');
        if (versionsModule?.autoSnapshotBeforeChange) {
            await versionsModule.autoSnapshotBeforeChange(char, 'update');
        }
        if (hasListingName) await applyListingName(char, remoteCard);
        const hasCardFields = Object.keys(updatedFields).length > 0;
        const written = hasCardFields ? await CoreAPI.writeCardFields(char, updatedFields) : { ok: true };
        const success = written.ok;

        if (success) {
            CoreAPI.showToast(`Updated ${checkboxes.length} field${checkboxes.length > 1 ? 's' : ''}`, 'success');
            closeSingleModal();
            
            const batchItem = document.querySelector(`.card-update-batch-item[data-char-id="${CSS.escape(charId)}"]`);
            if (batchItem) {
                const statusEl = batchItem.querySelector('.card-update-batch-item-status');
                if (statusEl) {
                    statusEl.innerHTML = '<i class="fa-solid fa-check"></i> Updated';
                }
                const fieldsEl = batchItem.querySelector('.card-update-batch-item-fields');
                if (fieldsEl) fieldsEl.textContent = '';
                batchItem.dataset.status = 'applied';
                updateBatchFilterCounts();
            }

            currentUpdateChecks.delete(charId);
            if (batchItem) updateBatchFooter(batchFooterState());
            // forced: an applied update can carry tags (relation rows the sidebar counts),
            // and the forced refresh re-reads the tag filter and the grid
            await CoreAPI.refreshCharacters(true);
        } else if (!written.told) {
            CoreAPI.showToast('Failed to apply updates', 'error');
        }
    } catch (error) {
        console.error('[CardUpdates] Apply failed:', error);
        CoreAPI.showToast('Error applying updates', 'error');
    }
}

/** The changes that empty a filled field, by character and field (Apply All is where nobody inspects each); '' when none. */
function renderClearingSummary(entries) {
    const clearing = [];
    for (const [charId, checkData] of entries) {
        const charName = CoreAPI.getCharacterName(checkData.char) || 'Unknown';
        for (const diff of checkData.diffs) if (diff.clears) clearing.push({ charId, charName, label: COMPARABLE_FIELDS[diff.field] || diff.field });
    }
    if (!clearing.length) return '';
    return `
        <div class="settings-band is-warn batch-summary-clears">
            <i class="fa-solid fa-eraser settings-band-icon"></i>
            <div class="settings-band-text">
                <span class="settings-band-when">${clearing.length} change${clearing.length !== 1 ? 's' : ''} empt${clearing.length !== 1 ? 'y' : 'ies'} a field you filled</span>
                <span class="settings-band-sub">The remote has nothing there. Untick the character below to keep yours.</span>
                <ul class="batch-summary-clears-list">
                    ${clearing.map(c => `<li><strong class="card-update-char-link" data-char-id="${CoreAPI.escapeHtml(c.charId)}">${CoreAPI.escapeHtml(c.charName)}</strong> ${CoreAPI.escapeHtml(c.label)}</li>`).join('')}
                </ul>
            </div>
        </div>
    `;
}

/**
 * Show pre-apply summary before applying batch updates.
 * Groups changes by field across selected characters so the user can review.
 */
function showPreApplySummary() {
    const entries = Array.from(currentUpdateChecks.entries())
        .filter(([charId]) => batchSelectedIds.has(charId));
    
    if (entries.length === 0) {
        CoreAPI.showToast('No characters selected for update', 'info');
        return;
    }
    
    const fieldMap = new Map(); // field -> [{ charId, charName, diff }]
    let totalFieldChanges = 0;
    for (const [charId, checkData] of entries) {
        const charName = CoreAPI.getCharacterName(checkData.char) || 'Unknown';
        for (const diff of checkData.diffs) {
            if (!fieldMap.has(diff.field)) fieldMap.set(diff.field, []);
            fieldMap.get(diff.field).push({ charId, charName, diff });
            totalFieldChanges++;
        }
    }
    
    let summaryHtml = `
        <div class="settings-band batch-summary-header">
            <i class="fa-solid fa-clipboard-check settings-band-icon"></i>
            <div class="settings-band-text">
                <span class="settings-band-when">${entries.length} character${entries.length !== 1 ? 's' : ''} with ${totalFieldChanges} field change${totalFieldChanges !== 1 ? 's' : ''}</span>
                <span class="settings-band-sub">Untick a character to leave it as it is.</span>
            </div>
        </div>
    `;
    summaryHtml += renderClearingSummary(entries);
    summaryHtml += '<div class="batch-summary-fields">';

    for (const [field, items] of fieldMap) {
        const label = COMPARABLE_FIELDS[field] || field;
        summaryHtml += `
            <span class="batch-summary-field-group" title="${CoreAPI.escapeHtml(label)} changes for ${items.length} character${items.length !== 1 ? 's' : ''}">
                ${fieldIcon(field)}
                <span>${CoreAPI.escapeHtml(label)}</span>
                <span class="batch-summary-field-count">${items.length}</span>
            </span>
        `;
    }

    summaryHtml += `</div>`;

    // Per-character deselection (last-chance)
    summaryHtml += `
        <label class="card-update-list-head">
            <input type="checkbox" id="batchSummaryToggleAll" checked aria-label="Select every character">
            <span class="card-update-list-count" id="batchSummaryCount"></span>
        </label>
        <div class="batch-summary-char-list">
    `;

    for (const [charId, checkData] of entries) {
        const charName = CoreAPI.getCharacterName(checkData.char) || 'Unknown';
        const names = checkData.diffs.map(d => COMPARABLE_FIELDS[d.field] || d.label || d.field).join(', ');
        summaryHtml += `
            <label class="cl-cwin-row batch-summary-char-item" data-char-id="${CoreAPI.escapeHtml(charId)}">
                <input type="checkbox" class="batch-summary-char-cb" data-char-id="${CoreAPI.escapeHtml(charId)}" checked>
                <span class="batch-summary-char-info">
                    <span class="batch-summary-char-name card-update-char-link" data-char-id="${CoreAPI.escapeHtml(charId)}" title="Open ${CoreAPI.escapeHtml(charName)}">${CoreAPI.escapeHtml(charName)}</span>
                    <span class="batch-summary-char-fields" title="${CoreAPI.escapeHtml(names)}">${CoreAPI.escapeHtml(names)}</span>
                </span>
            </label>
        `;
    }

    summaryHtml += `</div>`;
    
    const summaryEl = document.getElementById('cardUpdateBatchSummary');
    const listEl = document.getElementById('cardUpdateBatchList');
    const filterBar = document.getElementById('cardUpdateBatchFilterBar');
    const progressEl = document.getElementById('cardUpdateBatchProgress');

    if (summaryEl) {
        summaryEl.innerHTML = summaryHtml;
        summaryEl.classList.remove('hidden');
    }
    if (listEl) listEl.classList.add('hidden');
    if (filterBar) filterBar.classList.add('hidden');
    if (progressEl) progressEl.classList.add('hidden');

    updateBatchFooter('summary');
}

/**
 * Go back from pre-apply summary to the batch list
 */
function hidePreApplySummary() {
    const summaryEl = document.getElementById('cardUpdateBatchSummary');
    const listEl = document.getElementById('cardUpdateBatchList');
    const filterBar = document.getElementById('cardUpdateBatchFilterBar');
    const progressEl = document.getElementById('cardUpdateBatchProgress');
    
    if (summaryEl) summaryEl.classList.add('hidden');
    if (listEl) listEl.classList.remove('hidden');
    if (filterBar) filterBar.classList.remove('hidden');
    if (progressEl) progressEl.classList.remove('hidden');

    updateBatchFooter(batchFooterState());
}

/**
 * Apply updates for characters selected in the pre-apply summary
 */
async function applyAllBatchUpdates() {
    const summaryEl = document.getElementById('cardUpdateBatchSummary');
    let selectedIds;

    if (summaryEl && !summaryEl.classList.contains('hidden')) {
        const checkboxes = summaryEl.querySelectorAll('.batch-summary-char-cb:checked');
        selectedIds = new Set(Array.from(checkboxes).map(cb => cb.dataset.charId));
    } else {
        // the summary's Confirm is the one caller; without the summary the batch's own picks apply
        selectedIds = new Set(batchSelectedIds);
    }
    
    const entries = Array.from(currentUpdateChecks.entries())
        .filter(([charId]) => selectedIds.has(charId));
    
    if (entries.length === 0) {
        CoreAPI.showToast('No updates to apply', 'info');
        return;
    }
    const progressWrap = document.getElementById('cardUpdateBatchApplyProgress');
    const progressText = document.getElementById('cardUpdateBatchApplyText');
    const progressFill = document.getElementById('cardUpdateBatchApplyFill');
    // the summary's two verbs hold while the write runs; the footer redraw after it frees them
    for (const id of ['cardUpdateBatchSummaryBackBtn', 'cardUpdateBatchSummaryConfirmBtn']) {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = true;
    }
    if (progressWrap) progressWrap.hidden = false;
    if (progressFill) progressFill.style.width = '0%';

    const total = entries.length;

    // One update entry per character; the listing-name diff folds into the same
    // entry (extensions.{provider}.pageName), so linked chars cost no extra write
    const updates = [];
    for (const [charId, checkData] of entries) {
        const { char, diffs, remoteCard } = checkData;
        const remoteData = remoteCard?.data || remoteCard;
        const fields = {};
        for (const diff of diffs) {
            if (diff.field === 'listing_name') {
                const ln = remoteCard?._listingName;
                const match = CoreAPI.getCharacterProvider(char);
                if (ln && match) fields[`extensions.${match.provider.id}.pageName`] = ln;
                continue;
            }
            const remoteValue = readCardField(remoteData, diff.field);
            fields[diff.field] = remoteValue ?? null;
        }
        updates.push({ id: charId, char, fields });
    }

    // Per-char auto-snapshots stay per-char: each captures that card pre-write
    const versionsModule = CoreAPI.getModule('character-versions');
    if (versionsModule?.autoSnapshotBeforeChange) {
        let snapped = 0;
        for (const u of updates) {
            if (progressText) progressText.textContent = `Snapshotting... ${++snapped}/${total}`;
            await versionsModule.autoSnapshotBeforeChange(u.char, 'update');
        }
    }

    if (progressText) progressText.textContent = `Applying ${total} update${total === 1 ? '' : 's'}...`;
    if (progressFill) progressFill.style.width = '60%';

    // the one batch write: the server applying each entry through the PATCH path, then the rows
    // it changed re-read into the cache
    let result = null;
    let failure = null;
    try {
        result = await runCommand('character.update-many', { updates: updates.map(u => ({ id: u.id, fields: u.fields })) });
        // a refusal throws in the server's words; nothing answered is an override holding it back
        if (!result) failure = 'the change was held back';
    } catch (err) {
        console.error('[CardUpdates] Batch apply failed:', err);
        failure = err?.message || 'network error';
        // a chunk refused after others landed: those count as applied
        result = err?.landed || null;
    }

    const okSet = new Set(result?.affected || []);
    let successCount = 0;
    let errorCount = 0;
    for (const u of updates) {
        if (!okSet.has(u.id)) { errorCount++; continue; }
        successCount++;
        const batchItem = document.querySelector(`.card-update-batch-item[data-char-id="${CSS.escape(u.id)}"]`);
        if (batchItem) {
            const statusEl = batchItem.querySelector('.card-update-batch-item-status');
            if (statusEl) {
                statusEl.innerHTML = '<i class="fa-solid fa-check"></i> Updated';
            }
            const fieldsEl = batchItem.querySelector('.card-update-batch-item-fields');
            if (fieldsEl) fieldsEl.textContent = '';
            batchItem.dataset.status = 'applied';
        }
    }
    if (progressFill) progressFill.style.width = '100%';

    // only what landed leaves: an unticked or refused row keeps its check, so View and a second
    // Apply All still reach it
    for (const id of okSet) currentUpdateChecks.delete(id);

    if (failure) CoreAPI.showToast(`Not saved: ${failure}`, 'error', 8000);
    else CoreAPI.showToast(`Updated ${successCount} character${successCount !== 1 ? 's' : ''}${errorCount > 0 ? `, ${errorCount} failed` : ''}`,
        errorCount > 0 ? 'warning' : 'success');

    if (progressWrap) progressWrap.hidden = true;
    if (progressFill) progressFill.style.width = '0%';
    
    hidePreApplySummary();
    updateBatchFilterCounts();
    updateBatchFooter(batchFooterState());
}

// ========================================
// MODAL MANAGEMENT
// ========================================

function closeSingleModal() {
    singleModalCharId = null;
    singleCheckSeq++;
    singleModalClosedAt = Date.now();
    document.getElementById('cardUpdateSingleModal')?.classList.remove('visible');
}

// a deleted character ends its single check; a started batch keeps a terminal Deleted row so the loop's indexes hold
function onCharactersDeleted(charIds) {
    if (singleModalCharId && charIds.includes(singleModalCharId)) closeSingleModal();
    const gone = new Set(charIds);
    if (!pendingBatchCharacters.some(c => gone.has(c.id))) return;
    for (const id of charIds) {
        batchSelectedIds.delete(id);
        currentUpdateChecks.delete(id);
    }
    if (!document.getElementById('cardUpdateBatchFieldSelect')?.classList.contains('hidden')) {
        pendingBatchCharacters = pendingBatchCharacters.filter(c => !gone.has(c.id));
        setBatchSubtitle(pendingBatchCharacters);
        return;
    }
    for (const id of charIds) {
        const itemEl = document.querySelector(`.card-update-batch-item[data-char-id="${CSS.escape(id)}"]`);
        if (!itemEl) continue;
        itemEl.dataset.status = 'deleted';
        const statusEl = itemEl.querySelector('.card-update-batch-item-status');
        if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-trash"></i> Deleted';
        const cb = itemEl.querySelector('.card-update-batch-checkbox');
        if (cb) { cb.checked = false; cb.disabled = true; }
    }
    updateBatchFilterCounts();
    applyBatchStatusFilter(batchStatusFilter);
    const summaryEl = document.getElementById('cardUpdateBatchSummary');
    if (summaryEl && !summaryEl.classList.contains('hidden')) {
        if (![...currentUpdateChecks.keys()].some(id => batchSelectedIds.has(id))) { hidePreApplySummary(); return; }
        // rebuilt from what is still picked, keeping the reader's last-chance unticks
        const unticked = [...summaryEl.querySelectorAll('.batch-summary-char-cb:not(:checked)')].map(cb => cb.dataset.charId);
        showPreApplySummary();
        for (const id of unticked) {
            const cb = summaryEl.querySelector(`.batch-summary-char-cb[data-char-id="${CSS.escape(id)}"]`);
            if (cb) cb.checked = false;
        }
        syncSummarySelection();
        return;
    }
    updateBatchFooter(batchFooterState());
}

function closeBatchModal() {
    abortController?.abort();
    abortController = null;
    batchCheckPaused = false;
    batchCheckRunning = false;
    batchSelectedIds.clear();
    batchStatusFilter = 'all';
    batchRelevantFields = null;
    document.getElementById('cardUpdateBatchModal')?.classList.remove('visible');
    currentUpdateChecks.clear();
    pendingBatchCharacters = [];
}

/**
 * Stop the running batch check: the loop stops before its next row, and a row whose refresh the stop cut off waits for Resume
 */
function pauseBatchCheck() {
    if (!batchCheckRunning) return;
    batchCheckPaused = true;
    abortController?.abort();
    updateBatchFooter('stopping');
}

/**
 * Resume a stopped batch check
 */
function resumeBatchCheck() {
    if (batchFooterState() !== 'paused') return;
    performBatchCheck(pendingBatchCharacters, new Set(batchFieldSelection), 0);
}

// the footer's one run verb: Close before a run, Cancel while it runs, Resume once stopped, Close after
function batchFooterState() {
    if (batchCheckRunning) return batchCheckPaused ? 'stopping' : 'checking';
    // stopped with nothing left waiting is finished: its verb closes, never an empty resume
    return batchCheckPaused && batchProgressCounts().left > 0 ? 'paused' : 'done';
}

// the verb does what its label says: both read batchFooterState
function onBatchRunVerb() {
    const state = batchFooterState();
    if (state === 'checking') pauseBatchCheck();
    else if (state === 'paused') resumeBatchCheck();
    else if (state === 'done') closeBatchModal();
}

/**
 * Update the batch modal footer buttons based on state
 * @param {'idle'|'checking'|'stopping'|'paused'|'done'|'summary'} state
 */
function updateBatchFooter(state) {
    const startBtn = document.getElementById('cardUpdateBatchStartBtn');
    const runBtn = document.getElementById('cardUpdateBatchRunBtn');
    const applyBtn = document.getElementById('cardUpdateBatchApplyAllBtn');
    const summaryBackBtn = document.getElementById('cardUpdateBatchSummaryBackBtn');
    const summaryConfirmBtn = document.getElementById('cardUpdateBatchSummaryConfirmBtn');

    const withChanges = currentUpdateChecks.size;
    const selectedUpdateCount = Array.from(currentUpdateChecks.keys())
        .filter(charId => batchSelectedIds.has(charId)).length;

    if (startBtn) startBtn.hidden = state !== 'idle';
    if (runBtn) {
        runBtn.hidden = state === 'summary';
        if (state === 'checking') CoreAPI.setRunVerb(runBtn, 'running');
        else if (state === 'stopping') CoreAPI.setRunVerb(runBtn, 'stopping');
        else if (state === 'paused') {
            // neutral for the resume offer, as the bulk auto-link's verb (a stop left it disabled)
            const left = document.querySelectorAll('#cardUpdateBatchList .card-update-batch-item[data-status="pending"]').length;
            runBtn.classList.remove('cl-btn-danger-hover', 'cl-btn-primary');
            runBtn.classList.add('cl-btn-secondary');
            runBtn.disabled = false;
            runBtn.dataset.runState = 'paused';
            runBtn.innerHTML = `<i class="fa-solid fa-play"></i> Resume (${left} left)`;
        } else CoreAPI.setRunVerb(runBtn, 'done');
    }
    if (applyBtn) {
        applyBtn.hidden = !(state === 'paused' || state === 'done') || withChanges === 0;
        applyBtn.disabled = selectedUpdateCount === 0;
        applyBtn.innerHTML = `<i class="fa-solid fa-clipboard-check"></i> Review ${selectedUpdateCount} character${selectedUpdateCount === 1 ? '' : 's'}`;
    }
    if (summaryBackBtn) {
        summaryBackBtn.hidden = state !== 'summary';
        summaryBackBtn.disabled = false;
    }
    if (summaryConfirmBtn) summaryConfirmBtn.hidden = state !== 'summary';
    if (state === 'summary') syncSummarySelection();
    else syncBatchSelection();
}

// the list head's box and count follow the ticks of the rows the list shows, which are what it toggles
function syncBatchSelection() {
    const boxes = [...document.querySelectorAll('#cardUpdateBatchList .card-update-batch-item')]
        .filter(item => !item.hidden).map(item => item.querySelector('.card-update-batch-checkbox')).filter(cb => cb && !cb.disabled);
    const on = boxes.filter(cb => cb.checked).length;
    const all = document.getElementById('cardUpdateBatchSelectAll');
    if (all) {
        all.checked = boxes.length > 0 && on === boxes.length;
        all.indeterminate = on > 0 && on < boxes.length;
        all.disabled = boxes.length === 0;
    }
    const count = document.getElementById('cardUpdateBatchSelectedCount');
    if (count) count.textContent = `${on} of ${boxes.length} selected`;
}

// the summary's head and its Apply follow the summary's own ticks, which are what Apply reads
function syncSummarySelection() {
    const summaryEl = document.getElementById('cardUpdateBatchSummary');
    const boxes = summaryEl ? [...summaryEl.querySelectorAll('.batch-summary-char-cb')] : [];
    const on = boxes.filter(cb => cb.checked).length;
    const all = document.getElementById('batchSummaryToggleAll');
    if (all) {
        all.checked = boxes.length > 0 && on === boxes.length;
        all.indeterminate = on > 0 && on < boxes.length;
    }
    const count = document.getElementById('batchSummaryCount');
    if (count) count.textContent = `${on} of ${boxes.length} selected`;
    const confirmBtn = document.getElementById('cardUpdateBatchSummaryConfirmBtn');
    if (confirmBtn) {
        confirmBtn.disabled = on === 0;
        confirmBtn.innerHTML = `<i class="fa-solid fa-check-double"></i> Apply to ${on} Character${on === 1 ? '' : 's'}`;
    }
}

function updateBatchFieldCount() {
    const fieldCountEl = document.getElementById('cardUpdateBatchFieldCount');
    if (!fieldCountEl) return;

    // Count visible items (groups count as 1, ungrouped fields count as 1 each)
    const grid = document.getElementById('cardUpdateBatchFieldGrid');
    if (!grid) return;
    const allCheckboxes = grid.querySelectorAll('input[type="checkbox"]');
    let checked = 0;
    allCheckboxes.forEach(cb => { if (cb.checked) checked++; });
    fieldCountEl.textContent = `${checked} of ${allCheckboxes.length}`;
    const startBtn = document.getElementById('cardUpdateBatchStartBtn');
    if (startBtn) startBtn.disabled = checked === 0;
}

function handleBatchFieldSelectionChange(e) {
    const groupCheckbox = e.target.closest('input[type="checkbox"][data-group]');
    if (groupCheckbox) {
        const group = fieldGroups[groupCheckbox.dataset.group];
        if (group) {
            for (const path of group.paths) {
                if (groupCheckbox.checked) batchFieldSelection.add(path);
                else batchFieldSelection.delete(path);
            }
        }
        updateBatchFieldCount();
        return;
    }

    const checkbox = e.target.closest('input[type="checkbox"][data-field]');
    if (!checkbox) return;
    const field = checkbox.dataset.field;
    if (!field) return;
    if (checkbox.checked) {
        batchFieldSelection.add(field);
    } else {
        batchFieldSelection.delete(field);
    }
    updateBatchFieldCount();
}

function setBatchFieldsChecked(checked) {
    const grid = document.getElementById('cardUpdateBatchFieldGrid');
    if (!grid) return;

    const fieldCBs = grid.querySelectorAll('input[type="checkbox"][data-field]');
    fieldCBs.forEach(cb => { cb.checked = checked; });

    const groupCBs = grid.querySelectorAll('input[type="checkbox"][data-group]');
    groupCBs.forEach(cb => { cb.checked = checked; });

    batchFieldSelection.clear();
    if (checked && batchRelevantFields) {
        for (const f of batchRelevantFields) batchFieldSelection.add(f);
    }
    updateBatchFieldCount();
}

function startBatchCheck() {
    if (!pendingBatchCharacters || pendingBatchCharacters.length === 0) return;
    if (batchFieldSelection.size === 0) {
        CoreAPI.showToast('Select at least one field to compare', 'warning');
        return;
    }

    const listEl = document.getElementById('cardUpdateBatchList');
    const progressEl = document.getElementById('cardUpdateBatchProgress');
    const fieldSelectEl = document.getElementById('cardUpdateBatchFieldSelect');

    currentUpdateChecks.clear();
    batchSelectedIds.clear();

    listEl.innerHTML = pendingBatchCharacters.map(char => {
        const providerLink = getProviderLinkInfo(char);
        const name = CoreAPI.getCharacterName(char) || 'Unknown';
        const locked = CoreAPI.isUpdateLocked(char);
        if (!locked) batchSelectedIds.add(char.id);
        return `
            <div class="cl-cwin-row card-update-batch-item" data-char-id="${CoreAPI.escapeHtml(char.id)}" data-status="${locked ? 'locked' : 'pending'}">
                <label class="card-update-batch-item-check">
                    <input type="checkbox" class="card-update-batch-checkbox" data-char-id="${CoreAPI.escapeHtml(char.id)}" aria-label="Include ${CoreAPI.escapeHtml(name)}" ${locked ? 'disabled' : 'checked'}>
                </label>
                <div class="card-update-batch-item-info">
                    <span class="card-update-batch-item-name card-update-char-link" data-char-id="${CoreAPI.escapeHtml(char.id)}" title="Open ${CoreAPI.escapeHtml(name)}">${CoreAPI.escapeHtml(name)}</span>
                    <span class="card-update-batch-item-meta"><span class="card-update-batch-item-path">${CoreAPI.escapeHtml(providerLink?.fullPath || '')}</span><span class="card-update-batch-item-fields"></span></span>
                </div>
                <div class="card-update-batch-item-status">
                    ${locked
                        ? '<i class="fa-solid fa-lock"></i> Locked'
                        : '<i class="fa-solid fa-clock"></i> Waiting'}
                </div>
                <button type="button" class="cl-cwin-btn card-update-lock-toggle" data-char-id="${CoreAPI.escapeHtml(char.id)}" title="${locked ? 'Unlock and check' : 'Lock updates'}" aria-label="${locked ? 'Unlock and check' : 'Lock updates'}">
                    <i class="fa-solid ${locked ? 'fa-lock' : 'fa-unlock'}"></i>
                </button>
            </div>
        `;
    }).join('');

    if (fieldSelectEl) fieldSelectEl.classList.add('hidden');
    listEl.classList.remove('hidden');
    progressEl.classList.remove('hidden');

    const filterBar = document.getElementById('cardUpdateBatchFilterBar');
    if (filterBar) filterBar.classList.remove('hidden');
    updateBatchFilterCounts();

    performBatchCheck(pendingBatchCharacters, new Set(batchFieldSelection), 0);
}

// ========================================
// BATCH FILTERING & SELECTION
// ========================================

async function toggleBatchItemLock(charId) {
    const char = await CoreAPI.ensureCharacterById(charId);
    if (!char) return;

    const itemEl = document.querySelector(`.card-update-batch-item[data-char-id="${CSS.escape(charId)}"]`);
    const statusEl = itemEl?.querySelector('.card-update-batch-item-status');
    const toggleBtn = itemEl?.querySelector('.card-update-lock-toggle');
    if (!itemEl) return;

    const wasLocked = CoreAPI.isUpdateLocked(char);

    try {
        await CoreAPI.setUpdateLocked(charId, !wasLocked);
    } catch (err) {
        console.error('[CardUpdates] Failed to toggle lock:', err);
        if (!err.told) CoreAPI.showToast('Failed to toggle update lock', 'error');
        return;
    }

    if (wasLocked) {
        itemEl.dataset.status = 'pending';
        if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-clock"></i> Waiting';
        const cb = itemEl.querySelector('.card-update-batch-checkbox');
        if (cb) { cb.disabled = false; cb.checked = true; }
        batchSelectedIds.add(charId);
        if (toggleBtn) {
            toggleBtn.title = 'Lock updates';
            toggleBtn.setAttribute('aria-label', 'Lock updates');
            toggleBtn.innerHTML = '<i class="fa-solid fa-unlock"></i>';
        }
        updateBatchFilterCounts();
        updateBatchFooter(batchFooterState());

        if (!batchCheckRunning && !batchCheckPaused) {
            performBatchCheck(pendingBatchCharacters, new Set(batchFieldSelection), 0);
        }
    } else {
        itemEl.dataset.status = 'locked';
        if (statusEl) statusEl.innerHTML = '<i class="fa-solid fa-lock"></i> Locked';
        const cb = itemEl.querySelector('.card-update-batch-checkbox');
        if (cb) { cb.checked = false; cb.disabled = true; }
        batchSelectedIds.delete(charId);
        currentUpdateChecks.delete(charId);
        if (toggleBtn) {
            toggleBtn.title = 'Unlock and check';
            toggleBtn.setAttribute('aria-label', 'Unlock and check');
            toggleBtn.innerHTML = '<i class="fa-solid fa-lock"></i>';
        }
        updateBatchFilterCounts();
        updateBatchFooter(batchFooterState());
    }
}

/**
 * Count batch items by status into the tabs; a status with no rows leaves the strip (All stays)
 */
function updateBatchFilterCounts() {
    const items = document.querySelectorAll('#cardUpdateBatchList .card-update-batch-item');
    const counts = { all: 0, 'has-updates': 0, 'up-to-date': 0, errors: 0, unavailable: 0, locked: 0, applied: 0 };
    
    for (const item of items) {
        counts.all++;
        const status = item.dataset.status || 'pending';
        if (status === 'has-updates') counts['has-updates']++;
        else if (status === 'up-to-date') counts['up-to-date']++;
        else if (status === 'error' || status === 'errors') counts.errors++;
        else if (status === 'unavailable') counts.unavailable++;
        else if (status === 'locked') counts.locked++;
        else if (status === 'applied') counts.applied++;
    }
    
    const ids = {
        all: 'batchFilterCountAll',
        'has-updates': 'batchFilterCountUpdates',
        'up-to-date': 'batchFilterCountUpToDate',
        errors: 'batchFilterCountErrors',
        unavailable: 'batchFilterCountUnavailable',
        locked: 'batchFilterCountLocked',
        applied: 'batchFilterCountApplied'
    };
    
    for (const [key, id] of Object.entries(ids)) {
        const el = document.getElementById(id);
        if (el) el.textContent = counts[key];
    }
    for (const tab of document.querySelectorAll('#cardUpdateBatchFilterBar .cl-cwin-tab')) {
        tab.hidden = tab.dataset.filter !== 'all' && !counts[tab.dataset.filter];
    }

    // Re-apply active filter so newly checked items show/hide during scan; an emptied one falls back to All
    if (batchStatusFilter !== 'all') {
        applyBatchStatusFilter(counts[batchStatusFilter] ? batchStatusFilter : 'all');
    }
}

/**
 * Filter batch list items by status category
 */
function applyBatchStatusFilter(filter) {
    batchStatusFilter = filter;
    
    for (const tab of document.querySelectorAll('#cardUpdateBatchFilterBar .cl-cwin-tab')) {
        const on = tab.dataset.filter === filter;
        tab.classList.toggle('is-on', on);
        tab.setAttribute('aria-selected', String(on));
    }

    const items = document.querySelectorAll('#cardUpdateBatchList .card-update-batch-item');
    for (const item of items) {
        if (filter === 'all') {
            item.hidden = false;
        } else {
            const status = item.dataset.status || 'pending';
            const matches = (filter === 'errors' && status === 'error')
                || (filter === 'unavailable' && status === 'unavailable')
                || (filter === 'locked' && status === 'locked')
                || (filter === status);
            item.hidden = !matches;
        }
    }
    syncBatchSelection();
}

/**
 * Reset the status tabs to All with nothing counted
 */
function resetBatchFilterTabs() {
    for (const tab of document.querySelectorAll('#cardUpdateBatchFilterBar .cl-cwin-tab')) {
        const on = tab.dataset.filter === 'all';
        tab.classList.toggle('is-on', on);
        tab.setAttribute('aria-selected', String(on));
        tab.hidden = !on;
    }
    const ids = ['batchFilterCountAll', 'batchFilterCountUpdates', 'batchFilterCountUpToDate', 'batchFilterCountErrors', 'batchFilterCountUnavailable', 'batchFilterCountLocked', 'batchFilterCountApplied'];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (el) el.textContent = '0';
    }
}

/**
 * Handle batch item checkbox toggle
 */
function handleBatchCheckboxChange(e) {
    const cb = e.target.closest('.card-update-batch-checkbox');
    if (!cb) return;
    const charId = cb.dataset.charId;
    if (!charId) return;

    if (cb.checked) {
        batchSelectedIds.add(charId);
    } else {
        batchSelectedIds.delete(charId);
    }
    
    updateBatchFooter(batchFooterState());
}

/**
 * Select or deselect all visible batch item checkboxes
 */
function setBatchItemsChecked(checked) {
    const items = document.querySelectorAll('#cardUpdateBatchList .card-update-batch-item');
    for (const item of items) {
        if (item.hidden) continue; // skip filtered-out
        const cb = item.querySelector('.card-update-batch-checkbox');
        if (!cb || cb.disabled) continue; // skip unavailable cards
        cb.checked = checked;
        const charId = cb.dataset.charId;
        if (checked) batchSelectedIds.add(charId);
        else batchSelectedIds.delete(charId);
    }
    updateBatchFooter(batchFooterState());
}

// ========================================
// UI HELPERS
// ========================================

/**
 * Write a status band: the line that answers, its sub, the tone of its edge
 * @param {HTMLElement} el a .settings-band
 * @param {''|'ok'|'warn'|'error'} tone
 * @param {string} icon Font Awesome classes after fa-solid
 * @param {string} when HTML, escaped by the caller
 * @param {string} [sub] HTML, escaped by the caller
 */
function setBand(el, tone, icon, when, sub = '') {
    if (!el) return;
    el.classList.remove('is-ok', 'is-warn', 'is-error');
    if (tone) el.classList.add(`is-${tone}`);
    el.innerHTML = `<i class="fa-solid ${icon} settings-band-icon"></i>
        <div class="settings-band-text">
            <span class="settings-band-when">${when}</span>
            <span class="settings-band-sub">${sub}</span>
        </div>`;
}

// the single check's list head and its Apply follow the ticks
function updateSingleSelection() {
    const modal = document.getElementById('cardUpdateSingleModal');
    if (!modal) return;
    const boxes = [...modal.querySelectorAll('.card-update-diff-item input[type="checkbox"]')];
    const on = boxes.filter(cb => cb.checked).length;
    const all = modal.querySelector('.card-update-select-all-cb');
    if (all) {
        all.checked = boxes.length > 0 && on === boxes.length;
        all.indeterminate = on > 0 && on < boxes.length;
    }
    const count = modal.querySelector('.card-update-list-count');
    if (count) count.textContent = `${on} of ${boxes.length} selected`;
    const applyBtn = document.getElementById('cardUpdateSingleApplyBtn');
    if (applyBtn) {
        applyBtn.disabled = on === 0;
        applyBtn.innerHTML = `<i class="fa-solid fa-check"></i> ${on ? `Apply ${on} change${on === 1 ? '' : 's'}` : 'Apply'}`;
    }
}

/**
 * Toggle all checkboxes for a character's diffs
 */
function toggleAllCheckboxes(checked) {
    const modal = document.getElementById('cardUpdateSingleModal');
    modal.querySelectorAll(`.card-update-diff-item input[type="checkbox"]`).forEach(cb => {
        cb.checked = checked;
    });
    updateSingleSelection();
}

/**
 * Toggle expand/collapse of a diff item
 */
function toggleExpand(button) {
    const item = button.closest('.card-update-diff-item');
    const content = item.querySelector('.card-update-diff-content');
    const icon = item.querySelector('.card-update-diff-expand i');
    const open = content.classList.contains('collapsed');
    content.classList.toggle('collapsed', !open);
    item.classList.toggle('is-open', open);
    item.querySelector('.card-update-diff-expand')?.setAttribute('aria-expanded', String(open));
    icon?.classList.toggle('fa-chevron-down', !open);
    icon?.classList.toggle('fa-chevron-up', open);
}

// ========================================
// EVENT LISTENERS
// ========================================

function setupEventListeners() {
    const singleModal = document.getElementById('cardUpdateSingleModal');
    const batchModal = document.getElementById('cardUpdateBatchModal');

    document.getElementById('cardUpdateSingleCloseBtn')?.addEventListener('click', closeSingleModal);
    document.getElementById('cardUpdateSingleCancelBtn')?.addEventListener('click', closeSingleModal);
    document.getElementById('cardUpdateBatchCloseBtn')?.addEventListener('click', closeBatchModal);

    document.getElementById('cardUpdateSingleApplyBtn')?.addEventListener('click', applySingleUpdates);
    document.getElementById('cardUpdateBatchApplyAllBtn')?.addEventListener('click', showPreApplySummary);
    document.getElementById('cardUpdateBatchStartBtn')?.addEventListener('click', startBatchCheck);
    document.getElementById('cardUpdateBatchRunBtn')?.addEventListener('click', onBatchRunVerb);

    document.getElementById('cardUpdateBatchSummaryBackBtn')?.addEventListener('click', hidePreApplySummary);
    document.getElementById('cardUpdateBatchSummaryConfirmBtn')?.addEventListener('click', applyAllBatchUpdates);

    singleModal?.addEventListener('click', (e) => {
        if (e.target === singleModal) { closeSingleModal(); return; }
        const nameLink = e.target.closest('.card-update-char-link[data-char-id]');
        if (nameLink) { openCharModalAbove(nameLink.dataset.charId); return; }
        // the whole header row opens a change, bar its tick
        const header = e.target.closest('.card-update-diff-header');
        if (header && !e.target.closest('label')) toggleExpand(header);
    });
    singleModal?.addEventListener('change', (e) => {
        if (e.target.classList.contains('card-update-select-all-cb')) toggleAllCheckboxes(e.target.checked);
        else if (e.target.closest('.card-update-diff-item')) updateSingleSelection();
    });
    batchModal?.addEventListener('click', (e) => {
        if (e.target === batchModal) {
            // Guard against ghost taps that pass through when the single modal just closed
            if (Date.now() - singleModalClosedAt < 400) return;
            closeBatchModal();
        }
    });

    const batchListEl = document.getElementById('cardUpdateBatchList');
    batchListEl?.addEventListener('click', (e) => {
        const viewBtn = e.target.closest('.card-update-batch-view-btn');
        if (viewBtn) {
            const charId = viewBtn.dataset.viewCharId;
            if (charId) viewBatchItemDiffs(charId);
            return;
        }
        const lockToggle = e.target.closest('.card-update-lock-toggle');
        if (lockToggle) {
            const charId = lockToggle.dataset.charId;
            if (charId) toggleBatchItemLock(charId);
            return;
        }
        const nameLink = e.target.closest('.card-update-char-link[data-char-id]');
        if (nameLink) openCharModalAbove(nameLink.dataset.charId);
    });
    batchListEl?.addEventListener('change', handleBatchCheckboxChange);

    document.getElementById('cardUpdateBatchFilterBar')?.addEventListener('click', (e) => {
        const tab = e.target.closest('.cl-cwin-tab');
        if (tab?.dataset.filter) applyBatchStatusFilter(tab.dataset.filter);
    });
    document.getElementById('cardUpdateBatchSelectAll')?.addEventListener('change', (e) => setBatchItemsChecked(e.target.checked));

    document.getElementById('cardUpdateBatchSummary')?.addEventListener('click', (e) => {
        const nameLink = e.target.closest('.card-update-char-link[data-char-id]');
        if (!nameLink) return;
        // the name sits in its row's label; opening it must not tick the row
        e.preventDefault();
        openCharModalAbove(nameLink.dataset.charId);
    });

    document.getElementById('cardUpdateBatchSummary')?.addEventListener('change', (e) => {
        if (e.target.id === 'batchSummaryToggleAll') {
            const checked = e.target.checked;
            const cbs = document.querySelectorAll('.batch-summary-char-cb');
            cbs.forEach(cb => cb.checked = checked);
        }
        syncSummarySelection();
    });

    document.getElementById('cardUpdateBatchFieldGrid')?.addEventListener('change', handleBatchFieldSelectionChange);
    document.getElementById('cardUpdateBatchFieldSelectAll')?.addEventListener('click', () => setBatchFieldsChecked(true));
    document.getElementById('cardUpdateBatchFieldSelectNone')?.addEventListener('click', () => setBatchFieldsChecked(false));
}


// ========================================
// MODALS HTML
// ========================================

function injectModals() {
    if (document.getElementById('cardUpdateSingleModal')) return;

    const tab = (filter, label, countId, shown = false) => `<button type="button" class="cl-cwin-tab" role="tab" aria-selected="false" data-filter="${filter}"${shown ? '' : ' hidden'}>${label} <span class="card-update-tab-count" id="${countId}">0</span></button>`;

    const modalsHtml = `
        <!-- Single Character Update Check Modal -->
        <div id="cardUpdateSingleModal" class="cl-modal card-update-modal">
            <div class="cl-modal-content">
                <div class="cl-modal-header">
                    <div class="card-update-head">
                        <h3><i class="fa-solid fa-arrows-rotate"></i> Check for updates</h3>
                        <div class="card-update-sub" id="cardUpdateSingleSub"></div>
                    </div>
                    <button class="cl-modal-close" id="cardUpdateSingleCloseBtn" aria-label="Close">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div class="cl-modal-body">
                    <div class="settings-band card-update-band" id="cardUpdateSingleStatus"></div>
                    <div id="cardUpdateSingleContent" class="card-update-scroll"></div>
                </div>
                <div class="cl-modal-footer">
                    <button class="cl-btn cl-btn-secondary" id="cardUpdateSingleCancelBtn">Cancel</button>
                    <button class="cl-btn cl-btn-primary" id="cardUpdateSingleApplyBtn" disabled>
                        <i class="fa-solid fa-check"></i> Apply
                    </button>
                </div>
            </div>
        </div>

        <!-- Batch Update Check Modal -->
        <div id="cardUpdateBatchModal" class="cl-modal card-update-modal">
            <div class="cl-modal-content" data-fw-min="600x400">
                <div class="cl-modal-header">
                    <div class="card-update-head">
                        <h3><i class="fa-solid fa-arrows-rotate"></i> Check for updates</h3>
                        <div class="card-update-sub"><span id="cardUpdateBatchCount">0</span> <span id="cardUpdateBatchNoun">characters</span><span id="cardUpdateBatchSources"></span></div>
                    </div>
                    <button class="cl-modal-close" id="cardUpdateBatchCloseBtn" aria-label="Close">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div class="cl-modal-body">
                    <div id="cardUpdateBatchFieldSelect" class="card-update-fields">
                        <div class="card-update-list-head">
                            <span class="card-update-fields-title">Fields to compare</span>
                            <span class="card-update-list-count" id="cardUpdateBatchFieldCount">0 of 0</span>
                            <button type="button" class="cl-cwin-btn-text" id="cardUpdateBatchFieldSelectAll">All</button>
                            <button type="button" class="cl-cwin-btn-text" id="cardUpdateBatchFieldSelectNone">None</button>
                        </div>
                        <p class="card-update-hint">A field left out is neither compared nor applied. Tags often differ in ways that do not matter.</p>
                        <div id="cardUpdateBatchFieldGrid" class="card-update-field-grid card-update-scroll"></div>
                    </div>
                    <div id="cardUpdateBatchProgress" class="settings-band card-update-band hidden"></div>
                    <div id="cardUpdateBatchFilterBar" class="card-update-batch-bar hidden">
                        <div class="cl-cwin-tabs card-update-tabs" role="tablist" aria-label="Show">
                            ${tab('all', 'All', 'batchFilterCountAll', true)}
                            ${tab('has-updates', 'Changes', 'batchFilterCountUpdates')}
                            ${tab('up-to-date', 'Up to date', 'batchFilterCountUpToDate')}
                            ${tab('errors', 'Failed', 'batchFilterCountErrors')}
                            ${tab('unavailable', 'Unavailable', 'batchFilterCountUnavailable')}
                            ${tab('locked', 'Locked', 'batchFilterCountLocked')}
                            ${tab('applied', 'Updated', 'batchFilterCountApplied')}
                        </div>
                        <label class="card-update-list-head">
                            <input type="checkbox" id="cardUpdateBatchSelectAll" aria-label="Select every character shown">
                            <span class="card-update-list-count" id="cardUpdateBatchSelectedCount"></span>
                        </label>
                    </div>
                    <div id="cardUpdateBatchList" class="card-update-batch-list card-update-scroll"></div>
                    <div id="cardUpdateBatchSummary" class="card-update-batch-summary card-update-scroll hidden"></div>
                </div>
                <div class="cl-modal-footer">
                    <div id="cardUpdateBatchApplyProgress" class="card-update-apply-progress" hidden>
                        <div class="card-update-apply-text" id="cardUpdateBatchApplyText">Applying updates...</div>
                        <div class="card-update-apply-bar">
                            <div class="card-update-apply-fill" id="cardUpdateBatchApplyFill"></div>
                        </div>
                    </div>
                    <button class="cl-btn cl-btn-secondary" id="cardUpdateBatchSummaryBackBtn" hidden>
                        <i class="fa-solid fa-arrow-left"></i> Back
                    </button>
                    <button class="cl-btn cl-btn-secondary" id="cardUpdateBatchRunBtn">
                        <i class="fa-solid fa-xmark"></i> Close
                    </button>
                    <button class="cl-btn cl-btn-primary" id="cardUpdateBatchStartBtn">
                        <i class="fa-solid fa-magnifying-glass"></i> Start Check
                    </button>
                    <button class="cl-btn cl-btn-primary" id="cardUpdateBatchApplyAllBtn" hidden>
                        <i class="fa-solid fa-clipboard-check"></i> Review
                    </button>
                    <button class="cl-btn cl-btn-primary" id="cardUpdateBatchSummaryConfirmBtn" hidden>
                        <i class="fa-solid fa-check-double"></i> Apply
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalsHtml);
    CoreAPI.mountDialogSizing('cardUpdateSingleModal');
    CoreAPI.mountDialogSizing('cardUpdateBatchModal');
}

// ========================================
// EXPORTS
// ========================================

export default {
    init,
    checkSingleCharacter,
    checkAllLinkedCharacters,
    checkSelectedCharacters
};
