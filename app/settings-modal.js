// Settings modal wiring. A classic script in library.js's global scope: library.js calls
// setupSettingsModal() at boot, and the body reads its globals at call time.

// The public repository. Empty until one exists; the About row and the release script both read it.
const PUBLIC_REPO_URL = 'https://github.com/Sillyanonymous/ProjectSigma';

// The SillyTavern migration wizard's verbs, one request each; a refused answer throws with the
// server's words.
async function migratePlan(opts) {
    return readAnswer(await apiRequest('/migrate/plan', 'POST', opts));
}

async function migrateStatus() {
    return readAnswer(await apiRequest('/migrate/status', 'GET'));
}

async function migrateCancel() {
    return readAnswer(await apiRequest('/migrate/cancel', 'POST', {}));
}

// Search Index's Tidy Now: whether a tidy-up started, or the one running; another library's refusal thrown in the server's words
async function tidySearchIndexNow() {
    return readAnswer(await apiRequest('/maintenance/search-index/tidy', 'POST'));
}

// the run and the finalize stream their log line by line and end with the done frame
async function migrateStream(resp, onLine) {
    if (!resp.ok) return readAnswer(resp);
    let done = null;
    await consumeLlmSse(resp, { onEvent: (ev) => {
        if (ev.started) onLine?.(`migrating into ${ev.started.target} from ${ev.started.source}`);
        if (ev.line) onLine?.(ev.line.line);
        if (ev.done) done = ev.done;
    } });
    if (!done) throw new Error('the migration stream ended without a result');
    return done;
}

async function migrateRun(opts, onLine) {
    return migrateStream(await apiRequest('/migrate/run', 'POST', opts), onLine);
}

async function migrateFinalize(opts, onLine) {
    return migrateStream(await apiRequest('/migrate/finalize', 'POST', opts), onLine);
}

// The keys a Save writes: the ones whose input moved since open and that the store doesnt
// already hold, so a value stored meanwhile stands.
function settingsSaveDiff(opened, now, stored) {
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const changed = {};
    for (const [key, value] of Object.entries(now)) {
        if (!same(value, opened?.[key]) && !same(value, stored(key))) changed[key] = value;
    }
    return changed;
}

// Settings holding what the reader wrote rather than picked; Restore Defaults names each one
// before it clears anything.
const AUTHORED_SETTINGS = {
    themeTokens: 'Theme colours',
    customCSS: 'Custom CSS',
    tagAliasRules: 'Tag alias rules',
    namePreferences: 'Display name choices',
    providerExcludeTags: 'Provider exclude tags',
    datacatFollowedCreators: 'Followed DataCat creators',
    assistantSystemPrompt: 'The assistant\'s system prompt',
    creatorStudioSystemPrompt: 'The creator studio\'s system prompt',
    chatEscapeStrings: 'Chat escape strings',
    chatAuthorsNoteDefault: 'The default author\'s note',
    chatHeaderLayout: 'The chat header\'s order, groups, dividers and hidden buttons',
    chatExtHiddenPhone: 'Extension windows hidden from the phone\'s chat options',
    windowGeometry: 'Window sizes and places',
};

// The authored settings a restore would clear: the ones holding something other than their default.
function authoredSettingsCleared(get, defaults) {
    return Object.entries(AUTHORED_SETTINGS)
        .filter(([key]) => JSON.stringify(get(key) ?? defaults[key]) !== JSON.stringify(defaults[key]))
        .map(([, label]) => label);
}

// A secret field's eye button. A textarea has no password type, so a .cl-masked-field one is revealed by class.
function wireSecretToggle(btn, input) {
    if (!btn || !input) return;
    btn.onclick = () => {
        const masked = input.classList.contains('cl-masked-field');
        const show = masked ? !input.classList.contains('revealed') : input.type === 'password';
        if (masked) input.classList.toggle('revealed', show);
        else input.type = show ? 'text' : 'password';
        btn.innerHTML = `<i class="fa-solid fa-eye${show ? '-slash' : ''}"></i>`;
    };
}

// The service's copy goes first (send answers the response, or a provider layer's boolean): a refused clear keeps the stored copy and the field.
async function clearServiceCredential(send, { settingKey, input, invalidate, what }) {
    let resp;
    try { resp = await send(); } catch (err) { showToast(`${what} not cleared: ${err.message}`, 'error'); return false; }
    if (typeof resp === 'boolean' ? !resp : !resp?.ok) {
        const body = await resp?.json?.().catch(() => null);
        showToast(`${what} not cleared: ${body?.error || (resp?.status ? `HTTP ${resp.status}` : 'the provider service did not take it')}`, 'error');
        return false;
    }
    setSetting(settingKey, null);
    if (input) input.value = '';
    invalidate?.();
    showToast(`${what} cleared`, 'info');
    return true;
}

// its Save: the service takes the credential first, so a value it refuses is said in its words and never stored
async function saveServiceCredential(send, { settingKey, value, what }) {
    try { await send(); } catch (err) { showToast(`${what} not saved: ${err.message}`, 'error'); return false; }
    setSetting(settingKey, value);
    showToast(`${what} saved`, 'success');
    return true;
}

// Settings > Media's credentials handed to the service, a refusal thrown in its words
async function sendCivitaiKey(key) {
    const resp = await apiRequest('/provider-services/civitai-set-key', 'POST', { key });
    window.invalidateCivitaiAuthCache?.();
    return readAnswer(resp);
}

async function sendPixivCookie(cookie) {
    const resp = await apiRequest('/provider-services/pixiv-set-cookie', 'POST', { cookie });
    window.invalidatePixivAuthCache?.();
    return readAnswer(resp);
}

function clearCivitaiKey() {
    return apiRequest('/provider-services/civitai-clear-key', 'POST', {});
}

function clearPixivLogin() {
    return apiRequest('/provider-services/pixiv-logout', 'POST', {});
}

// Settings > Extensions' Remove: the answer said, a refusal thrown in the server's words
async function removeExtensionNow(id) {
    const out = await readAnswer(await apiRequest(`/extensions/${encodeURIComponent(id)}`, 'DELETE'));
    // a folder that shadowed a bundled id went alone: the bundled extension stays loaded
    if (!out?.shadowed) window.ExtensionHost?.unload?.(id);
    if (out?.leftover?.length) showToast(`Removed, but its files could not be deleted for ${out.leftover.join(', ')}; the server log says why.`, 'warning', 10000);
    else showToast('Removed.', 'success');
    return out;
}

// ========================================
// Views: the start page and each view's defaults, drawn from the view registry
// ========================================

// choices as <option>s; an icon rides data-icon or data-icon-url, as the custom select reads them
function viewChoicesHtml(choices) {
    return choices.map(c => {
        const icon = c.iconUrl ? ` data-icon-url="${escapeHtml(c.iconUrl)}"` : c.icon ? ` data-icon="${escapeHtml(c.icon)}"` : '';
        return `<option value="${escapeHtml(c.value)}"${icon}>${escapeHtml(c.label)}</option>`;
    }).join('');
}

// one default's row: a select under its label, or a switch, each with its hint
function viewDefaultRowHtml(entry) {
    const hint = entry.hint ? `<span class="settings-hint">${escapeHtml(entry.hint)}</span>` : '';
    if (entry.control === 'switch') {
        const glyph = entry.icon ? ` <i class="${escapeHtml(entry.icon)}"></i>` : '';
        return `<div class="settings-row"><label><input type="checkbox" class="cl-switch-input" id="${escapeHtml(entry.id)}"><span class="cl-switch" aria-hidden="true"></span>${glyph} ${escapeHtml(entry.label)}</label>${hint}</div>`;
    }
    return `<div class="settings-row"><label for="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}:</label><select id="${escapeHtml(entry.id)}" class="glass-select"></select>${hint}</div>`;
}

/** View Defaults: a tab and a panel for each view that declares defaults, the panels' selects converted. */
function renderViewDefaults(tabsEl, panelsEl) {
    if (!tabsEl || !panelsEl) return;
    const views = VIEW_REGISTRY.filter(v => v.defaults.length);
    tabsEl.innerHTML = views.map(v => `<button type="button" role="tab" class="cl-cwin-tab" id="settingsViewTab-${escapeHtml(v.id)}" data-view="${escapeHtml(v.id)}" aria-selected="false" aria-controls="settingsViewPanel-${escapeHtml(v.id)}"><i class="${escapeHtml(v.icon)}"></i><span>${escapeHtml(v.label)}</span></button>`).join('');
    // a panel's title names its view during a search, when the tabs are put away
    panelsEl.innerHTML = views.map(v => `<div class="settings-view-panel" id="settingsViewPanel-${escapeHtml(v.id)}" role="tabpanel" aria-labelledby="settingsViewTab-${escapeHtml(v.id)}" data-view="${escapeHtml(v.id)}" hidden>`
        + `<div class="settings-view-panel-title"><i class="${escapeHtml(v.icon)}"></i> ${escapeHtml(v.label)}</div>${v.defaults.map(viewDefaultRowHtml).join('')}</div>`).join('');
    panelsEl.querySelectorAll('.glass-select').forEach(initCustomSelect);
}

/** The View Defaults tab shown: the named view's, else the one shown, else the first. */
function showViewDefaultsTab(id) {
    const tabs = [...document.querySelectorAll('#settingsViewTabs .cl-cwin-tab')];
    const pick = tabs.find(t => t.dataset.view === id) || tabs.find(t => t.classList.contains('is-on')) || tabs[0];
    if (!pick) return;
    for (const t of tabs) {
        const on = t === pick;
        t.classList.toggle('is-on', on);
        t.setAttribute('aria-selected', String(on));
    }
    for (const p of document.querySelectorAll('#settingsViewPanels .settings-view-panel')) p.hidden = p.dataset.view !== pick.dataset.view;
}

// a select whose options were rebuilt: the trigger shows them, and was locked to the widest one there was
function refreshConvertedSelect(select) {
    if (!select._customSelect) { initCustomSelect(select); return; }
    select._customSelect.refresh();
    select._customSelect.relockWidth?.();
}

/**
 * One view default's control from its stored value: a value its list lacks shows the shipped default;
 * an unreadable list keeps it, marked.
 * @returns {Promise<string|boolean>} what the control shows
 */
async function fillViewDefaultControl(entry, el, stored) {
    if (!el) return stored;
    if (entry.control === 'switch') {
        el.checked = !!stored;
        return el.checked;
    }
    const listed = entry.options();
    const choices = listed && typeof listed.then === 'function' ? await listed : listed;
    const fallback = DEFAULT_SETTINGS[entry.key] ?? '';
    const value = stored ?? fallback;
    if (!choices) {
        el.innerHTML = viewChoicesHtml([{ value, label: value ? 'Saved choice (the list could not be loaded)' : 'The list could not be loaded', icon: 'fa-solid fa-triangle-exclamation' }]);
        el.value = value;
    } else {
        el.innerHTML = viewChoicesHtml(choices);
        el.value = choices.some(c => c.value === value) ? value : fallback;
    }
    refreshConvertedSelect(el);
    return el.value;
}

/**
 * The start page's choices, an extension's views grouped; a saved extension view not registered now
 * stays chosen, marked, the note saying why.
 * @returns {string} the view the select shows
 */
function fillStartView(select, note, stored) {
    if (!select) return stored;
    const views = listViews();
    const choice = (v) => ({ value: v.id, label: v.label, icon: v.icon });
    const own = views.filter(v => !v.extension).map(choice);
    const theirs = views.filter(v => v.extension).map(choice);
    const value = stored || DEFAULT_SETTINGS.startView;
    const unavailable = !views.some(v => v.id === value) && String(value).startsWith('ext:');
    select.innerHTML = viewChoicesHtml(own)
        + (theirs.length ? `<optgroup label="Extensions">${viewChoicesHtml(theirs)}</optgroup>` : '')
        + (unavailable ? viewChoicesHtml([{ value, label: 'An extension view that is not available', icon: 'fa-solid fa-triangle-exclamation' }]) : '');
    select.value = views.some(v => v.id === value) || unavailable ? value : DEFAULT_SETTINGS.startView;
    if (note) note.hidden = !(unavailable && _extensionsSettled);
    refreshConvertedSelect(select);
    return select.value;
}

/** What the start page and the view defaults' controls say now, for the Save model. */
function readViewSettingsFromUI() {
    const out = { startView: document.getElementById('settingsStartView')?.value || DEFAULT_SETTINGS.startView };
    for (const entry of viewDefaultEntries()) {
        const el = document.getElementById(entry.id);
        if (el) out[entry.key] = entry.control === 'switch' ? el.checked : el.value;
    }
    return out;
}

/**
 * Setup the Gallery Settings Modal
 */
function setupSettingsModal() {
    const settingsBtn = document.getElementById('gallerySettingsBtn');
    const settingsModal = document.getElementById('gallerySettingsModal');
    const closeSettingsModal = document.getElementById('closeSettingsModal');
    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    const resetSettingsBtn = document.getElementById('resetSettingsBtn');
    
    // Input elements
    const chubTokenInput = document.getElementById('settingsChubToken');
    const toggleTokenVisibility = document.getElementById('toggleChubTokenVisibility');
    const pygmalionEmailInput = document.getElementById('settingsPygmalionEmail');
    const pygmalionPasswordInput = document.getElementById('settingsPygmalionPassword');
    const pygmalionRememberCredsCheckbox = document.getElementById('settingsPygmalionRememberCredentials');
    const togglePygmalionPasswordVisibility = document.getElementById('togglePygmalionPasswordVisibility');
    const botbooruUsernameInput = document.getElementById('settingsBotbooruUsername');
    const botbooruPasswordInput = document.getElementById('settingsBotbooruPassword');
    const ctCookieInput = document.getElementById('settingsCtCookie');
    const ctAutoKeepAliveCheckbox = document.getElementById('settingsCtAutoKeepAlive');
    const wyvernEmailInput = document.getElementById('settingsWyvernEmail');
    const wyvernPasswordInput = document.getElementById('settingsWyvernPassword');
    const toggleWyvernPasswordVisibility = document.getElementById('toggleWyvernPasswordVisibility');
    const datacatTokenInput = document.getElementById('settingsDatacatToken');
    const toggleDatacatTokenVisibility = document.getElementById('toggleDatacatTokenVisibility');
    const datacatSessionStatus = document.getElementById('datacatSessionStatus');
    const minScoreSlider = document.getElementById('settingsMinScore');
    const minScoreValue = document.getElementById('minScoreValue');
    const possibleMatchScoreSlider = document.getElementById('settingsPossibleMatchScore');
    const possibleMatchScoreValue = document.getElementById('possibleMatchScoreValue');
    const importDirectDownloadsCheckbox = document.getElementById('settingsImportDirectDownloads');
    
    // Search defaults
    const searchNameCheckbox = document.getElementById('settingsSearchName');
    const searchListingNameCheckbox = document.getElementById('settingsSearchListingName');
    const searchTagsCheckbox = document.getElementById('settingsSearchTags');
    const searchAuthorCheckbox = document.getElementById('settingsSearchAuthor');
    const searchNotesCheckbox = document.getElementById('settingsSearchNotes');
    const searchTaglineCheckbox = document.getElementById('settingsSearchTagline');
    const searchDescriptionCheckbox = document.getElementById('settingsSearchDescription');
    const searchFirstMessageCheckbox = document.getElementById('settingsSearchFirstMessage');
    const searchAltGreetingsCheckbox = document.getElementById('settingsSearchAltGreetings');
    const paletteSearchCardsCheckbox = document.getElementById('settingsPaletteSearchCards');
    const paletteSearchMessagesCheckbox = document.getElementById('settingsPaletteSearchMessages');
    const paletteSearchLoreCheckbox = document.getElementById('settingsPaletteSearchLore');

    // Start page and View Defaults: the tabs open on the start page's view and follow its select
    const startViewSelect = document.getElementById('settingsStartView');
    const startViewNote = document.getElementById('settingsStartViewNote');
    const viewTabs = document.getElementById('settingsViewTabs');
    renderViewDefaults(viewTabs, document.getElementById('settingsViewPanels'));
    viewTabs?.addEventListener('click', (e) => {
        const tab = e.target.closest('.cl-cwin-tab');
        if (tab) showViewDefaultsTab(tab.dataset.view);
    });
    startViewSelect?.addEventListener('change', () => showViewDefaultsTab(startViewSelect.value));

    // Character details
    const richCreatorNotesCheckbox = document.getElementById('settingsRichCreatorNotes');
    const expandCreatorNotesCheckbox = document.getElementById('settingsExpandCreatorNotes');
    const displayNamePreferenceSelect = document.getElementById('settingsDisplayNamePreference');
    const showNameToggleCheckbox = document.getElementById('settingsShowNameToggle');
    
    // Media Localization
    const mediaLocalizationCheckbox = document.getElementById('settingsMediaLocalization');
    const includeProviderGalleryCheckbox = document.getElementById('settingsIncludeProviderGallery');
    const includeLorebookCheckbox = document.getElementById('settingsIncludeLorebook');
    const fastFilenameSkipCheckbox = document.getElementById('settingsFastFilenameSkip');
    const importMediaActionSelect = document.getElementById('settingsImportMediaAction');
    const backgroundImportsCheckbox = document.getElementById('settingsBackgroundImports');
    const includeExternalGalleriesCheckbox = document.getElementById('settingsIncludeExternalGalleries');

    // Developer
    const debugModeCheckbox = document.getElementById('settingsDebugMode');
    const showInfoTabCheckbox = document.getElementById('settingsShowInfoTab');
    const exportAsLinksCheckbox = document.getElementById('settingsExportAsLinks');
    const exportFormatSelect = document.getElementById('settingsExportFormat');
    const showProviderTaglineCheckbox = document.getElementById('settingsShowProviderTagline');
    const allowRichTaglineCheckbox = document.getElementById('settingsAllowRichTagline');
    const browseSnapSectionsCheckbox = document.getElementById('settingsBrowseSnapSections');
    const collapseAllBrowseSectionsCheckbox = document.getElementById('settingsCollapseAllBrowseSections');
    const mobileProviderQuickSwitchCheckbox = document.getElementById('settingsMobileProviderQuickSwitch');
    const mobileHideBackArrowsCheckbox = document.getElementById('settingsMobileHideBackArrows');
    const mobileBrowseQuickImportCheckbox = document.getElementById('settingsMobileBrowseQuickImport');
    const mobileSwipeGesturesCheckbox = document.getElementById('settingsMobileSwipeGestures');
    const mobileHapticsCheckbox = document.getElementById('settingsMobileHaptics');
    
    // Appearance
    const mobileModeSelect = document.getElementById('settingsMobileMode');
    const uiScaleSelect = document.getElementById('settingsUiScale');
    const modalSizeSelect = document.getElementById('settingsModalSize');
    const resetWindowLayoutsBtn = document.getElementById('settingsResetWindowLayouts');
    const buttonStyleSelect = document.getElementById('settingsButtonStyle');
    const animateTagPillsCheckbox = document.getElementById('settingsAnimateTagPills');
    const animateKeepNameCheckbox = document.getElementById('settingsAnimateKeepName');
    const animateKeepNameRow = document.getElementById('animateKeepNameRow');
    const hidePlaylistBadgesCheckbox = document.getElementById('settingsHidePlaylistBadges');
    const enableCharDetailNavCheckbox = document.getElementById('settingsEnableCharDetailNav');
    const highlightColorInput = document.getElementById('settingsHighlightColor');
    
    // Card Updates
    const chubUseV4ApiCheckbox = document.getElementById('settingsChubUseV4Api');
    const chubTimelineJoinedCheckbox = document.getElementById('settingsChubTimelineJoined');

    // Version History
    const autoSnapshotOnEditCheckbox = document.getElementById('settingsAutoSnapshotOnEdit');
    const maxAutoBackupsInput = document.getElementById('settingsMaxAutoBackups');
    const backupFrequencySelect = document.getElementById('settingsBackupFrequency');
    const backupKeepInput = document.getElementById('settingsBackupKeep');
    const backupWindowStartSelect = document.getElementById('settingsBackupWindowStart');
    const backupWindowEndSelect = document.getElementById('settingsBackupWindowEnd');
    const autoTidySearchIndexCheckbox = document.getElementById('settingsSearchIndexAutoTidy');
    const preloadLibraryCheckbox = document.getElementById('settingsPreloadLibrary');
    const extNotifyUpdatesCheckbox = document.getElementById('settingsExtNotifyUpdates');

    if (!settingsBtn || !settingsModal) return;

    // Provider Order & Defaults UI

    function applyProviderToggle(btn, isNowDisabled) {
        btn.classList.toggle('disabled', isNowDisabled);
        const icon = btn.querySelector('i');
        if (icon) icon.className = isNowDisabled ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
        btn.title = `${isNowDisabled ? 'Enable' : 'Disable'} in Online tab`;
        const orderItem = btn.closest('.provider-order-item');
        if (orderItem) orderItem.classList.toggle('provider-disabled', isNowDisabled);
    }

    function wireProviderToggleListeners(container, viewProviders) {
        container.querySelectorAll('.provider-toggle-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const isCurrentlyDisabled = btn.classList.contains('disabled');
                const pid = btn.dataset.provider;
                const prov = viewProviders.find(p => p.id === pid);

                // a deprecated source's notice supersedes its experimental warning
                if (isCurrentlyDisabled && prov?.deprecated) {
                    showConfirm({
                        title: `${prov.name} is deprecated`,
                        message: `${prov.name} is no longer maintained and may be removed in a later release. Browsing and importing from it can fail, and a failure will not be fixed. You can still switch it on.`,
                        icon: 'fa-solid fa-circle-exclamation',
                        confirmLabel: 'Enable anyway',
                    }).then(ok => { if (ok) applyProviderToggle(btn, false); });
                    return;
                }

                if (isCurrentlyDisabled && prov?.enableWarning) {
                    // Canonical confirm: stacks above the settings cl-modal (a raw .confirm-modal sits
                    // below it) and gets Escape / Android back handling from the overlay registry.
                    showConfirm({
                        title: `Enable ${prov.name}?`,
                        message: prov.enableWarning,
                        icon: 'fa-solid fa-triangle-exclamation',
                        confirmLabel: 'Enable',
                    }).then(ok => { if (ok) applyProviderToggle(btn, false); });
                    return;
                }

                applyProviderToggle(btn, !isCurrentlyDisabled);
            });
        });
    }

    // ========================================
    // LIBRARY BACKUP
    // ========================================

    // Staleness phrasing ("how long has it been"), not clock phrasing; chats' relative time is
    // module scope and turns into a weekday past a week.
    function bkAgo(ms) {
        const age = Date.now() - ms;
        if (age < 120_000) return 'just now';
        if (age < 3_600_000) return `${Math.floor(age / 60_000)} minutes ago`;
        if (age < 172_800_000) {
            const h = Math.floor(age / 3_600_000);
            return h <= 1 ? 'an hour ago' : `${h} hours ago`;
        }
        return `${Math.floor(age / 86_400_000)} days ago`;
    }

    const bkNum = n => (Number.isFinite(n) ? n.toLocaleString() : '-');
    const bkSet = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    const bkIsLive = (job) => !!job && (job.status === 'queued' || job.status === 'running');
    // the status as last read: a backup's progress repaints the band without asking for it again
    let bkStatus = null;

    // The band: the backup while one is live, else the newest backup and whether the schedule fell behind.
    function paintBackupBand() {
        const last = document.getElementById('bkLast');
        const btn = document.getElementById('bkRunBtn');
        const job = window.BackupJobs?.now().job;
        last?.classList.remove('is-warn', 'is-error');
        if (bkIsLive(job)) {
            const pct = job.total > 0 ? Math.min(99, Math.floor(((job.done || 0) / job.total) * 100)) : 0;
            bkSet('bkLastWhen', job.status === 'queued' ? 'Waiting for another backup to finish' : job.phase === 'verify' ? 'Checking the copy' : 'Backing up');
            bkSet('bkLastSub', job.status === 'running' && job.phase === 'copy' ? `${formatBytes(job.done || 0)} of ${formatBytes(job.total || 0)} · ${pct}%` : '');
            setRunVerb(btn, job.stopping ? 'stopping' : 'running');
            return;
        }
        if (btn?.dataset.runState) {
            btn.classList.remove('cl-btn-secondary', 'cl-btn-danger-hover');
            btn.classList.add('cl-btn-primary');
            btn.disabled = false;
            delete btn.dataset.runState;
            btn.innerHTML = '<i class="fa-solid fa-download"></i> Back Up Now';
        }
        const status = bkStatus;
        const next = document.getElementById('bkNextRun');
        if (!status) {
            // UNKNOWN is not the same as "never backed up", so it does not borrow that
            // wording or its red edge.
            bkSet('bkLastWhen', 'Could not read backup status');
            bkSet('bkLastSub', 'The server did not answer. Nothing has been changed.');
            if (next) next.hidden = true;
            return;
        }
        if (!status.latest) {
            bkSet('bkLastWhen', 'No backup yet');
            bkSet('bkLastSub', 'Nothing has been copied out of this library.');
            last?.classList.add('is-error');
        } else {
            const age = Date.now() - status.latest.mtime;
            bkSet('bkLastWhen', `Last backup ${bkAgo(status.latest.mtime)}`);
            bkSet('bkLastSub', `${formatBytes(status.latest.bytes)} · ${new Date(status.latest.mtime).toLocaleString()}`);
            // A week is the line only when nothing is scheduled; with a schedule, a missed window is what
            // counts as stale.
            const overdue = status.nextRun !== null ? !!status.missed : age > 7 * 86_400_000;
            if (overdue) last?.classList.add('is-warn');
        }
        if (next) {
            next.hidden = status.nextRun === null;
            next.textContent = status.missed
                ? 'A scheduled backup missed its quiet hours; the notifications ask what to do.'
                : status.nextRun !== null ? `Next automatic backup: ${new Date(status.nextRun).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : '';
        }
    }

    async function refreshBackupPanel() {
        const group = document.getElementById('settingsBackupGroup');
        if (!group) return;
        let status = null;
        try {
            const resp = await apiRequest('/backup/status', 'GET');
            if (resp.ok) status = await resp.json();
        } catch { /* handled by the unknown state in the band */ }
        bkStatus = status;
        paintBackupBand();
        if (!status) return;

        bkSet('bkStatSize', formatBytes(status.db?.bytes ?? NaN));
        bkSet('bkStatChars', bkNum(status.db?.characters));
        bkSet('bkStatChats', bkNum(status.db?.chats));
        bkSet('bkStatMessages', bkNum(status.db?.messages));
        bkSet('bkStatLorebooks', bkNum(status.db?.lorebooks));

        const listEl = document.getElementById('bkList');
        const countEl = document.getElementById('bkCount');
        if (countEl) countEl.textContent = status.count ? `${status.count} · ${formatBytes(status.totalBytes)}` : '0';
        if (listEl) {
            // unread stays null: an unanswered list is not an empty one beside a count that says otherwise
            let rows = null;
            try {
                const r = await apiRequest('/backup', 'GET');
                if (r.ok) rows = await r.json();
            } catch { /* the list is a detail; the summary above already landed */ }
            listEl.innerHTML = !Array.isArray(rows) ? '<div class="bk-empty">Could not read the backup list</div>'
                : rows.length
                    ? rows.map(b => `<div class="bk-row">
                        <span class="bk-row-when">${escapeHtml(new Date(b.mtime).toLocaleString())}</span>
                        <span class="bk-row-size">${escapeHtml(formatBytes(b.bytes))}</span>
                    </div>`).join('')
                    : '<div class="bk-empty">No backups on disk yet.</div>';
        }
    }

    // Search Index: each index's drift as the server reads it, the last tidy-up and the one running
    const SIX_INDEXES = Object.freeze([['cards', 'sixStatCards', 'card text'], ['chats', 'sixStatChats', 'chat messages'], ['lorebooks', 'sixStatLorebooks', 'lorebook entries']]);
    const sixName = (index) => SIX_INDEXES.find(([key]) => key === index)?.[2] || 'search';
    // down, as the server rounds it: a figure never shows the limit before the rule has reached it
    const sixTimes = (drift) => `${(Math.floor(drift * 10) / 10).toFixed(1)}×`;
    // a number and its unit never part at a line's end
    function sixDuration(ms) {
        const s = Math.round((ms || 0) / 1000);
        if (s < 1) return 'under a second';
        return s < 60 ? `${s}\u00a0s` : `${Math.floor(s / 60)}\u00a0min ${s % 60}\u00a0s`;
    }
    let sixStatus = null;
    // the last read sent wins, so a progress read overtaken by a later one is dropped
    let sixReadSeq = 0;
    // when the reader pressed Tidy Now, so a tidy-up they asked for that stops is told them once
    let sixAskedAt = 0;

    // The band: a tidy-up running or waiting, else one that stopped, the index furthest past the limit, an unread one, else in shape.
    function paintSearchIndexBand() {
        const band = document.getElementById('sixBand');
        const btn = document.getElementById('sixTidyBtn');
        band?.classList.remove('is-warn');
        const st = sixStatus;
        const whole = !!st && st.indexes.every(ix => Number.isFinite(ix.segments) && ix.segments <= 1);
        // an automatic tidy-up gives way to Tidy Now, so the button rests only for an asked one
        const asked = st?.running?.reason === 'asked';
        const waits = st?.queued === 'backup' ? 'Waiting for the backup to finish' : st?.queued ? 'Waiting for another library\'s tidy-up' : '';
        if (btn) {
            btn.disabled = !!st && (asked || !!st.queued || whole);
            btn.title = asked ? 'A tidy-up is running' : waits || (whole ? 'Every index is in one piece' : '');
        }
        if (!st) {
            bkSet('sixWhen', 'Could not read the search index');
            bkSet('sixSub', 'The server did not answer. Nothing has been changed.');
            return;
        }
        if (st.running) {
            const pct = st.running.total > 0 ? Math.min(99, Math.floor((st.running.done / st.running.total) * 100)) : 0;
            bkSet('sixWhen', `Tidying the ${sixName(st.running.index)} index`);
            bkSet('sixSub', `${pct}% · searches may be slower until it ends`);
            return;
        }
        if (st.queued) {
            bkSet('sixWhen', waits);
            bkSet('sixSub', st.queued === 'backup' ? 'The tidy-up starts as soon as it ends.' : 'Yours starts as soon as that one ends.');
            return;
        }
        const last = st.last ? `Last tidied ${bkAgo(st.last.at)}, took ${sixDuration(st.last.ms)}` : 'Not tidied yet';
        const later = st.auto ? 'It is tidied the next time the app sits idle.' : 'Tidying on its own is off.';
        if (st.failure && (!st.last || st.failure.at > st.last.at)) {
            band?.classList.add('is-warn');
            bkSet('sixWhen', 'The last tidy-up stopped before finishing');
            bkSet('sixSub', `${st.failure.error}. ${st.auto ? 'It is tried again the next time the app sits idle.' : 'Tidy Now tries again.'}`);
            return;
        }
        const worst = st.indexes.filter(ix => Number.isFinite(ix.drift)).sort((a, b) => b.drift - a.drift)[0];
        if (worst && worst.drift >= st.driftLimit) {
            band?.classList.add('is-warn');
            bkSet('sixWhen', `The ${sixName(worst.index)} index is in pieces`);
            bkSet('sixSub', `Searches that read from the disk can be ${sixTimes(worst.drift)} slower. ${later} ${last}.`);
            return;
        }
        // an index the server could not read is unknown, never a tidy one
        const unread = st.indexes.find(ix => !Number.isFinite(ix.drift));
        if (unread) {
            bkSet('sixWhen', `The ${sixName(unread.index)} index could not be read`);
            bkSet('sixSub', `Its figures are unknown; Tidy Now still tidies it. ${last}.`);
            return;
        }
        bkSet('sixWhen', 'Search index in shape');
        bkSet('sixSub', last);
    }

    async function refreshSearchIndexPanel() {
        if (!document.getElementById('settingsSearchIndexGroup')) return;
        const seq = ++sixReadSeq;
        let st = null;
        try {
            const resp = await apiRequest('/maintenance/search-index', 'GET');
            if (resp.ok) st = await resp.json();
        } catch { /* handled by the unknown state in the band */ }
        if (seq !== sixReadSeq) return;
        sixStatus = st;
        paintSearchIndexBand();
        // a tidy-up the reader asked for that stopped is told once, where they asked for it
        if (sixAskedAt && st && !st.running && !st.queued) {
            const failed = st.failure && st.failure.at >= sixAskedAt && (!st.last || st.failure.at > st.last.at);
            if (failed) showToast(`The tidy-up stopped: ${st.failure.error}`, 'warning');
            if (failed || (st.last?.at ?? 0) >= sixAskedAt) sixAskedAt = 0;
        }
        const of = (key) => st?.indexes?.find(ix => ix.index === key);
        for (const [key, id] of SIX_INDEXES) bkSet(id, Number.isFinite(of(key)?.drift) ? sixTimes(of(key).drift) : '-');
        const listEl = document.getElementById('sixList');
        if (listEl) {
            listEl.innerHTML = !st ? '<div class="bk-empty">Could not read the search index</div>'
                : SIX_INDEXES.map(([key, , name]) => {
                    const ix = of(key);
                    const pieces = Number.isFinite(ix?.segments) ? `${ix.segments} ${ix.segments === 1 ? 'piece' : 'pieces'}` : 'unreadable';
                    return `<div class="bk-row">
                        <span class="bk-row-when">${escapeHtml(name.charAt(0).toUpperCase() + name.slice(1))} · ${escapeHtml(pieces)}</span>
                        <span class="bk-row-size">${escapeHtml(Number.isFinite(ix?.bytes) ? formatBytes(ix.bytes) : '-')}</span>
                    </div>`;
                }).join('');
        }
    }

    function buildProviderOrderUI() {
        const container = document.getElementById('providerOrderList');
        if (!container) return;

        const registry = window.ProviderRegistry;
        if (!registry) return;

        const viewProviders = registry.getAllProviders().filter(p => p.hasView);
        if (viewProviders.length === 0) {
            container.innerHTML = '<p class="settings-hint is-center">No providers available</p>';
            return;
        }

        const savedOrder = getSetting('providerOrder');
        const savedDefaults = getSetting('providerDefaults') || {};
        const disabledProviders = new Set(getSetting('disabledProviders') || []);

        let ordered;
        if (Array.isArray(savedOrder) && savedOrder.length > 0) {
            const idSet = new Set(viewProviders.map(p => p.id));
            const sorted = savedOrder.filter(id => idSet.has(id));
            const rest = viewProviders.filter(p => !sorted.includes(p.id));
            ordered = [...sorted.map(id => viewProviders.find(p => p.id === id)), ...rest];
        } else {
            ordered = viewProviders;
        }

        container.innerHTML = '';
        for (const provider of ordered) {
            const config = provider.browseView?.getSettingsConfig?.() || { browseSortOptions: [], followingSortOptions: [], viewModes: [] };
            const defaults = savedDefaults[provider.id] || {};
            const item = document.createElement('div');
            item.className = 'provider-order-item';
            item.dataset.providerId = provider.id;
            item.draggable = true;

            let viewSelect = '';
            if (config.viewModes.length > 0) {
                const viewOpts = config.viewModes.map(m =>
                    `<option value="${m.value}"${defaults.view === m.value ? ' selected' : ''}>${m.label}</option>`
                ).join('');
                viewSelect = `<select class="provider-default-view" data-provider="${provider.id}" title="Default view mode">
                    <option value="">View: Auto</option>${viewOpts}
                </select>`;
            }

            const browseSorts = config.browseSortOptions || [];
            const followSorts = config.followingSortOptions || [];
            let sortOpts = '';
            if (browseSorts.length > 0 || followSorts.length > 0) {
                const currentView = defaults.view || '';
                const isFollowView = currentView === 'following' || currentView === 'timeline';
                const activeList = (isFollowView && followSorts.length > 0) ? followSorts : browseSorts;
                sortOpts = activeList.map(s =>
                    `<option value="${s.value}"${defaults.sort === s.value ? ' selected' : ''}>${s.label}</option>`
                ).join('');
            }
            let sortSelect = '';
            if (sortOpts) {
                sortSelect = `<select class="provider-default-sort" data-provider="${provider.id}" title="Default sort order">
                    <option value="">Sort: Auto</option>${sortOpts}
                </select>`;
            }

            const isDisabled = disabledProviders.has(provider.id);
            if (isDisabled) item.classList.add('provider-disabled');

            const hideToggles = `
                <label class="provider-default-hide" title="Hide cards already in your library by default"><input type="checkbox" class="provider-default-hide-owned"${defaults.hideOwned ? ' checked' : ''}>Hide Owned</label>
                <label class="provider-default-hide" title="Hide possible-match cards by default"><input type="checkbox" class="provider-default-hide-possible"${defaults.hidePossible ? ' checked' : ''}>Hide Possible</label>`;

            item.innerHTML = `
                <i class="fa-solid fa-grip-vertical drag-handle"></i>
                <button type="button" class="provider-toggle-btn${isDisabled ? ' disabled' : ''}" data-provider="${provider.id}" title="${isDisabled ? 'Enable' : 'Disable'} in Online tab">
                    <i class="fa-solid ${isDisabled ? 'fa-eye-slash' : 'fa-eye'}"></i>
                </button>
                <i class="fa-solid ${provider.icon || 'fa-globe'} provider-order-icon"></i>
                <span class="provider-order-name">${provider.name}</span>
                ${providerStatusBadgeHtml(provider)}
                <span class="provider-order-badge">Default</span>
                <div class="provider-order-defaults">
                    ${viewSelect}${sortSelect}${hideToggles}
                </div>
            `;

            container.appendChild(item);
        }

        wireProviderToggleListeners(container, viewProviders);
        container.querySelectorAll('.provider-default-view').forEach(viewSel => {
            viewSel.addEventListener('change', () => {
                const pid = viewSel.dataset.provider;
                const prov = viewProviders.find(p => p.id === pid);
                if (!prov) return;
                const cfg = prov.browseView?.getSettingsConfig?.() || {};
                const sortSel = container.querySelector(`.provider-default-sort[data-provider="${pid}"]`);
                if (!sortSel) return;
                const isFollow = viewSel.value === 'following' || viewSel.value === 'timeline';
                const list = (isFollow && cfg.followingSortOptions?.length > 0) ? cfg.followingSortOptions : (cfg.browseSortOptions || []);
                const prevVal = sortSel.value;
                sortSel.innerHTML = '<option value="">Sort: Auto</option>' + list.map(s =>
                    `<option value="${s.value}">${s.label}</option>`
                ).join('');
                if ([...sortSel.options].some(o => o.value === prevVal)) sortSel.value = prevVal;
                else sortSel.value = '';
            });
        });

        // the list element persists across builds; the helper wires it once
        wireDragReorder(container, { item: '.provider-order-item', handle: '.drag-handle', key: 'providerId' });
    }

    function readProviderOrderFromUI() {
        const container = document.getElementById('providerOrderList');
        if (!container) return { providerOrder: null, providerDefaults: {}, disabledProviders: [] };

        const items = container.querySelectorAll('.provider-order-item');
        const order = [];
        const defaults = {};
        const disabled = [];

        items.forEach(item => {
            const pid = item.dataset.providerId;
            if (!pid) return;
            order.push(pid);

            const toggleBtn = item.querySelector('.provider-toggle-btn');
            if (toggleBtn?.classList.contains('disabled')) {
                disabled.push(pid);
            }

            const viewSel = item.querySelector('.provider-default-view');
            const sortSel = item.querySelector('.provider-default-sort');
            const viewVal = viewSel?.value || '';
            const sortVal = sortSel?.value || '';
            const hideOwned = !!item.querySelector('.provider-default-hide-owned')?.checked;
            const hidePossible = !!item.querySelector('.provider-default-hide-possible')?.checked;

            if (viewVal || sortVal || hideOwned || hidePossible) {
                defaults[pid] = {};
                if (viewVal) defaults[pid].view = viewVal;
                if (sortVal) defaults[pid].sort = sortVal;
                if (hideOwned) defaults[pid].hideOwned = true;
                if (hidePossible) defaults[pid].hidePossible = true;
            }
        });

        // a provider the list did not render (an extension's, off in this tab) keeps its stored
        // place, defaults and switch
        const rendered = new Set(order);
        const savedOrder = getSetting('providerOrder');
        (Array.isArray(savedOrder) ? savedOrder : []).forEach((pid, i) => {
            if (!rendered.has(pid)) order.splice(Math.min(i, order.length), 0, pid);
        });
        for (const [pid, d] of Object.entries(getSetting('providerDefaults') || {})) if (!rendered.has(pid)) defaults[pid] = d;
        for (const pid of getSetting('disabledProviders') || []) if (!rendered.has(pid) && !disabled.includes(pid)) disabled.push(pid);

        return { providerOrder: order.length > 0 ? order : null, providerDefaults: defaults, disabledProviders: disabled };
    }

    // Infinite Scroll Toggles UI

    function buildInfiniteScrollUI() {
        const container = document.getElementById('infiniteScrollToggles');
        if (!container) return;

        const registry = window.ProviderRegistry;
        if (!registry) return;

        const viewProviders = registry.getViewProviders();
        if (viewProviders.length === 0) {
            container.innerHTML = '<p class="settings-hint is-center">No providers available</p>';
            return;
        }

        const saved = getSetting('infiniteScroll') || {};

        container.innerHTML = viewProviders.map(p => {
            const checked = (p.id in saved) ? saved[p.id] : true;
            return `<div class="settings-row">
                <label>
                    <input type="checkbox" class="infinite-scroll-toggle" data-provider="${escapeHtml(p.id)}" ${checked ? 'checked' : ''}>
                    ${escapeHtml(p.name)}
                </label>
            </div>`;
        }).join('');
    }

    function readInfiniteScrollFromUI() {
        // a provider the list did not render keeps its stored switch: a missing key reads as on
        const stored = getSetting('infiniteScroll') || {};
        const container = document.getElementById('infiniteScrollToggles');
        if (!container) return { ...stored };
        const result = {};
        container.querySelectorAll('.infinite-scroll-toggle').forEach(cb => {
            const pid = cb.dataset.provider;
            if (pid) result[pid] = cb.checked;
        });
        for (const [pid, on] of Object.entries(stored)) if (!(pid in result)) result[pid] = on;
        return result;
    }

    // The two count fields, clamped to the markup's range: 0 is unlimited for Version History, never
    // a backup keep (it would prune every backup).
    function readHistoryCountsFromUI() {
        const count = (id, min, max, key) => {
            const n = parseInt(document.getElementById(id)?.value, 10);
            return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : getDefaultSetting(key);
        };
        return {
            maxAutoBackups: count('settingsMaxAutoBackups', 0, 100, 'maxAutoBackups'),
            backupKeep: count('settingsBackupKeep', 1, 50, 'backupKeep'),
        };
    }

    // Provider Exclude Tags

    // id is the PERSISTED providerExcludeTags key (jannyai stores under 'janny'); the input/pills
    // ids are static for first-party rows, built for extension rows.
    const EXCLUDE_TAG_PROVIDERS = Object.values(PROVIDER_MANIFEST).map(p => {
        const prefix = p.excludeInputPrefix || p.excludeTagKey;
        return { id: p.excludeTagKey, inputId: `${prefix}ExcludeTagsInput`, pillsId: `${prefix}ExcludeTagsPills` };
    });

    function renderExcludeTagPills(providerId, pillsId) {
        const container = document.getElementById(pillsId);
        if (!container) return;
        const tags = getProviderExcludeTags(providerId);
        container.innerHTML = tags.map(tag =>
            `<span class="provider-exclude-tag-pill" data-tag="${tag.replace(/"/g, '&quot;')}">${escapeHtml(tag)}<button class="provider-exclude-tag-remove" title="Remove">&times;</button></span>`
        ).join('');
    }

    function populateAllExcludeTagPills() {
        for (const { id, pillsId } of EXCLUDE_TAG_PROVIDERS) {
            renderExcludeTagPills(id, pillsId);
        }
    }

    function addExcludeTag(providerId, pillsId, tag) {
        const trimmed = tag.trim().toLowerCase();
        if (!trimmed) return;
        const existing = getProviderExcludeTags(providerId);
        if (existing.includes(trimmed)) return;
        setProviderExcludeTags(providerId, [...existing, trimmed]);
        renderExcludeTagPills(providerId, pillsId);
    }

    function removeExcludeTag(providerId, pillsId, tag) {
        const existing = getProviderExcludeTags(providerId);
        setProviderExcludeTags(providerId, existing.filter(t => t !== tag));
        renderExcludeTagPills(providerId, pillsId);
    }

    // Per-row so an extension-injected provider section, which arrives after this setup
    // pass, gets wired the same way the static ones do.
    function wireExcludeTagRow({ id, inputId, pillsId }) {
        const input = document.getElementById(inputId);
        const pills = document.getElementById(pillsId);
        if (!input || !pills) return;

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addExcludeTag(id, pillsId, input.value);
                input.value = '';
            }
        });

        pills.addEventListener('click', (e) => {
            const removeBtn = e.target.closest('.provider-exclude-tag-remove');
            if (!removeBtn) return;
            const pill = removeBtn.closest('.provider-exclude-tag-pill');
            if (pill) removeExcludeTag(id, pillsId, pill.dataset.tag);
        });
    }

    for (const row of EXCLUDE_TAG_PROVIDERS) {
        wireExcludeTagRow(row);
    }

    // Extension provider settings sections
    // The host hands over a body renderer and the chrome is built here; true only once landed
    // (else it stays pending).
    function injectProviderSettingsSection(providerId, render, opts = {}) {
        const row = PROVIDER_MANIFEST[providerId];
        const panel = settingsModal.querySelector('.settings-panel[data-section="online"]');
        if (!row || !panel) return false;
        if (panel.querySelector(`details.settings-provider-section[data-provider="${CSS.escape(providerId)}"]`)) return true;

        const provider = window.ProviderRegistry?.getProvider?.(providerId);
        const section = document.createElement('details');
        section.className = 'settings-provider-section';
        section.dataset.provider = providerId;
        section.dataset.injected = '1';
        section.innerHTML = `
            <summary>
                <i class="${escapeHtml(provider?.icon || 'fa-solid fa-globe')} provider-icon"></i> ${escapeHtml(row.name || providerId)}
                ${providerStatusBadgeHtml(row, 'settings-provider-badge')}
                <i class="fa-solid fa-chevron-right provider-chevron"></i>
            </summary>
            <div class="settings-provider-body"></div>`;

        // Canon slot: before the first section whose manifest key comes later, so an
        // extension provider sits where the manifest says, not wherever it loaded.
        const order = Object.keys(PROVIDER_MANIFEST);
        const myIdx = order.indexOf(providerId);
        const siblings = [...panel.querySelectorAll('details.settings-provider-section[data-provider]')];
        const next = siblings.find(el => {
            const i = order.indexOf(el.dataset.provider);
            return i !== -1 && i > myIdx;
        });
        if (next) next.before(section);
        else if (siblings.length) siblings[siblings.length - 1].after(section);
        else panel.appendChild(section);

        // Render into the LIVE tree: extension wiring looks its elements up by id.
        render(section.querySelector('.settings-provider-body'));

        if (row.excludeTagKey) {
            const prefix = row.excludeInputPrefix || row.excludeTagKey;
            const spec = { id: row.excludeTagKey, inputId: `${prefix}ExcludeTagsInput`, pillsId: `${prefix}ExcludeTagsPills` };
            const group = document.createElement('div');
            group.className = 'settings-group';
            group.innerHTML = `
                <div class="settings-group-title"><i class="fa-solid fa-ban"></i> Exclude Tags</div>
                <div class="settings-row">
                    <div class="provider-exclude-tags-container">
                        <div class="provider-exclude-tags-pills" id="${spec.pillsId}"></div>
                        <input type="search" class="glass-input provider-exclude-tags-input" id="${spec.inputId}" placeholder="Type a tag and press Enter" autocomplete="one-time-code">
                    </div>
                    <span class="settings-hint">${escapeHtml(opts.excludeTagsHint || `Tags entered here are always excluded from ${row.name || providerId} browse results.`)}</span>
                </div>`;
            section.querySelector('.settings-provider-body').appendChild(group);
            wireExcludeTagRow(spec);
            renderExcludeTagPills(spec.id, spec.pillsId);
        }
        return true;
    }
    window.injectProviderSettingsSection = injectProviderSettingsSection;
    // The reverse, for an extension switched off: only an injected section leaves, never a static one.
    window.removeProviderSettingsSection = (providerId) => {
        const el = settingsModal.querySelector(`details.settings-provider-section[data-injected][data-provider="${CSS.escape(String(providerId))}"]`);
        el?.remove();
        return !!el;
    };
    // Drain sections registered before this setup ran (extensions can load first).
    window.ExtensionHost?.injectPendingProviderSections?.();

    // Taking a backup is an action, not a pending change, so it doesnt wait for Save; while one runs this cancels it.
    document.getElementById('bkRunBtn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (btn.disabled) return;
        if (!window.BackupJobs) { showToast('The backup controls did not load; reload the page', 'error'); return; }
        const job = window.BackupJobs.now().job;
        if (bkIsLive(job)) {
            setRunVerb(btn, 'stopping');
            await window.BackupJobs.cancel(job.id);
            return;
        }
        btn.disabled = true;
        try {
            await window.BackupJobs.start();
        } catch (err) {
            showToast(`Could not start the backup: ${err.message}`, 'error');
        } finally {
            btn.disabled = false;
            paintBackupBand();
        }
    });

    // progress repaints the band; an end or an answer re-reads the panel, since only the server knows what it pruned
    document.addEventListener('cl-backup-changed', (e) => {
        if (!settingsModal.classList.contains('visible')) return;
        if (bkIsLive(e.detail?.job)) paintBackupBand();
        else refreshBackupPanel();
    });

    // Tidying the search index is an action, not a pending change; the tidy-up is followed through the maintenance records
    document.getElementById('sixTidyBtn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (btn.disabled) return;
        btn.disabled = true;
        sixAskedAt = Date.now();
        try {
            const answer = await tidySearchIndexNow();
            if (!answer?.started) { sixAskedAt = 0; showToast('The search index is already in one piece', 'info'); }
        } catch (err) {
            sixAskedAt = 0;
            showToast(`Could not start the tidy-up: ${err.message}`, 'error');
        } finally {
            await refreshSearchIndexPanel();
        }
    });

    // each maintenance record re-reads the panel: its progress while a tidy-up runs, its figures once it ends
    document.addEventListener('cl-maintenance-changed', () => {
        if (settingsModal.classList.contains('visible')) refreshSearchIndexPanel();
    });

    // The SillyTavern migration wizard: the plan on Check, the run and finalize over the streamed log,
    // the log ring re-read on open.
    const migPath = document.getElementById('migPath');
    const migLog = document.getElementById('migLog');
    const migResult = document.getElementById('migResult');
    const migRunBtn = document.getElementById('migRunBtn');
    const migFinBtn = document.getElementById('migFinalizeBtn');
    const migLine = (text) => {
        if (!migLog) return;
        const d = document.createElement('div');
        d.className = 'mig-log-line';
        d.textContent = text;
        migLog.appendChild(d);
        migLog.hidden = false;
        migLog.scrollTop = migLog.scrollHeight;
    };
    const migList = (id) => (document.getElementById(id)?.value || '').split(',').map(s => s.trim()).filter(Boolean);
    const migOpts = () => ({
        path: migPath?.value.trim() || '',
        excludeTags: migList('migExclude'),
        only: migList('migOnly'),
        sample: Number(document.getElementById('migSample')?.value) || undefined,
        warmThumbs: document.getElementById('migWarmThumbs')?.checked === true,
    });
    const migShowResult = (text, kind) => {
        if (!migResult) return;
        migResult.textContent = text;
        migResult.className = `mig-result${kind ? ` is-${kind}` : ''}`;
    };
    // the run band says where the library stands, and the steps behind it turn into checks
    const migStepDone = (id, on) => document.getElementById(id)?.classList.toggle('is-done', !!on);
    const migPaintState = (state, lastReport) => {
        const el = document.getElementById('migState');
        if (!el) return;
        let when, detail = '', tone = '';
        if (state?.finalized) {
            when = `Finalized ${new Date(state.finalized.at).toLocaleString()}`;
            detail = 'Done; a re-run would duplicate every character.';
            tone = 'is-ok';
        } else if (lastReport?.summary) {
            const v = lastReport.verify;
            when = `Last run ${new Date(lastReport.at).toLocaleString()}`;
            detail = `${lastReport.summary.imported} imported, ${lastReport.summary.healed} healed, ${lastReport.summary.copies} copies; verify ${v ? (v.findings ? `${v.findings} finding(s)` : 'clean') : 'skipped'}.`;
            tone = v?.findings ? 'is-warn' : 'is-ok';
        } else {
            when = migRunBtn?.disabled ? 'Check a folder first.' : 'Nothing has been migrated into this library yet.';
        }
        el.textContent = when;
        const sub = document.getElementById('migStateSub');
        if (sub) sub.textContent = detail;
        const band = document.getElementById('migRunBand');
        if (band) { band.classList.remove('is-ok', 'is-warn'); if (tone) band.classList.add(tone); }
        migStepDone('migStepRun', lastReport?.summary || state?.finalized);
        migStepDone('migStepFinalize', state?.finalized);
        if (migFinBtn) migFinBtn.disabled = !!state?.finalized || !lastReport?.summary;
    };
    async function refreshMigratePanel() {
        if (!document.getElementById('settingsMigrateGroup')) return;
        try {
            const s = await migrateStatus();
            migPaintState(s.state, s.lastReport);
            if (s.running) {
                migShowResult(`A migration ${s.running.mode} is running (since ${new Date(s.running.startedAt).toLocaleTimeString()}); the log below is its tail.`, 'busy');
                if (migLog) migLog.innerHTML = '';
                for (const l of s.running.lines) migLine(l);
            } else if (s.busy) {
                migShowResult('Another migration is running on this server; Check and Run wait until it finishes.', 'busy');
            }
        } catch (err) {
            migShowResult(`Could not read the migration state: ${err.message}`, 'bad');
        }
    }
    document.getElementById('migCheckBtn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (btn.disabled) return;
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Checking';
        const planEl = document.getElementById('migPlan');
        try {
            const p = await migratePlan(migOpts());
            const c = p.counts || {};
            const groups = p.duplicateGroups || [];
            planEl.innerHTML = `
                <div class="bk-stats">
                    <div class="bk-stat"><span class="bk-stat-value">${bkNum(c.selected)}</span><span class="bk-stat-label">Cards${c.selected !== c.cards ? ` of ${bkNum(c.cards)}` : ''}</span></div>
                    <div class="bk-stat"><span class="bk-stat-value">${bkNum(c.chatDirsMatched)}</span><span class="bk-stat-label">Chat folders</span></div>
                    <div class="bk-stat"><span class="bk-stat-value">${bkNum(c.worlds)}</span><span class="bk-stat-label">Lorebooks</span></div>
                    <div class="bk-stat"><span class="bk-stat-value">${escapeHtml(formatBytes(c.mediaBytes || 0))}</span><span class="bk-stat-label">${bkNum(c.mediaFiles)} media files</span></div>
                    <div class="bk-stat"><span class="bk-stat-value">${bkNum(c.personas)}</span><span class="bk-stat-label">Personas</span></div>
                </div>
                <p class="settings-hint">${bkNum(c.create)} new, ${bkNum(c.heal)} already in your library (healed in place), ${bkNum(c.copy)} as copies${c.groupChatFiles ? `; ${bkNum(c.groupChatFiles)} group chat file(s) stay at the source` : ''}${p.unmatchedChatDirs?.length ? `; ${p.unmatchedChatDirs.length} chat folder(s) match no card` : ''}.</p>
                ${groups.length ? `<details class="bk-list-wrap"><summary class="bk-list-summary">${groups.length} duplicate group(s), imported as independent copies</summary><div class="mig-groups">${groups.map(g => `<div class="bk-row">${escapeHtml(g.join(' + '))}</div>`).join('')}</div></details>` : ''}`;
            planEl.hidden = false;
            migShowResult('', null);
            if (migRunBtn) migRunBtn.disabled = false;
            migStepDone('migStepSource', true);
            const meta = document.getElementById('migSourceMeta');
            const plural = (n, word) => `${bkNum(n)} ${word}${n === 1 ? '' : 's'}`;
            if (meta) meta.textContent = `${plural(c.cards, 'card')}, ${plural(c.chatDirsMatched, 'chat folder')}, ${plural(c.worlds, 'lorebook')}`;
            // the run band re-reads what the home already knows; a check never forgets a last run
            await refreshMigratePanel();
        } catch (err) {
            planEl.hidden = true;
            migShowResult(err.message, 'bad');
            if (migRunBtn) migRunBtn.disabled = true;
            migStepDone('migStepSource', false);
            const meta = document.getElementById('migSourceMeta');
            if (meta) meta.textContent = '';
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    });
    // one button is the run verb: Run, then Cancel while it runs, then Close, then Run again
    const migResetVerb = () => {
        if (!migRunBtn) return;
        migRunBtn.onclick = null;
        delete migRunBtn.dataset.runState;
        migRunBtn.classList.remove('cl-btn-secondary', 'cl-btn-danger-hover');
        migRunBtn.classList.add('cl-btn-primary');
        migRunBtn.innerHTML = '<i class="fa-solid fa-play"></i> Run the Migration';
    };
    const migStream = async (verb, label) => {
        if (!migRunBtn) return;
        // Close is a finished run on display, not a busy verb: the next verb clears it
        if (migRunBtn.dataset.runState === 'done') migResetVerb();
        if (migRunBtn.dataset.runState) return;
        if (migLog) { migLog.innerHTML = ''; migLog.hidden = true; }
        setRunVerb(migRunBtn, 'running');
        migRunBtn.onclick = async () => {
            setRunVerb(migRunBtn, 'stopping');
            try { await migrateCancel(); } catch (err) { showToast(err.message, 'error'); }
        };
        if (migFinBtn) migFinBtn.disabled = true;
        const runIcon = document.getElementById('migRunIcon');
        if (runIcon) runIcon.className = 'fa-solid fa-circle-notch fa-spin settings-band-icon';
        try {
            migShowResult(`${label} running...`, 'busy');
            const done = await verb(migOpts(), migLine);
            const ok = done.code === 0 && !done.cancelled;
            const v = done.report?.verify;
            migShowResult(done.cancelled ? 'Cancelled. Run it again any time: every character heals in place, nothing duplicates.'
                : ok ? `${label} finished${v ? (v.findings ? ` with ${v.findings} verify finding(s); the report in the library folder says where` : ', verified clean') : ''}.`
                    : `${label} failed (exit code ${done.code}); the log says where.`, done.cancelled ? null : ok ? 'ok' : 'bad');
            migPaintState(done.state, done.report || null);
            // every surface re-reads what the child wrote through the feed's library record, which has no tab
            // as its origin: this tab included
        } catch (err) {
            migShowResult(err.message, 'bad');
        } finally {
            setRunVerb(migRunBtn, 'done');
            migRunBtn.onclick = migResetVerb;
            if (runIcon) runIcon.className = 'fa-solid fa-circle-play settings-band-icon';
            refreshMigratePanel();
        }
    };
    migRunBtn?.addEventListener('click', () => { if (!migRunBtn.dataset.runState) migStream(migrateRun, 'Migration'); });
    migFinBtn?.addEventListener('click', async () => {
        const go = await showConfirm({
            title: 'Finalize the migration?',
            message: 'One last verify, then the SillyTavern-era identity records are purged so migrated characters are indistinguishable from native ones. This is one-way: afterwards the migration cannot be re-run into this library without duplicating everything.',
            icon: 'fa-solid fa-flag-checkered', confirmLabel: 'Finalize', danger: true,
        });
        if (go) migStream(migrateFinalize, 'Finalize');
    });

    settingsBtn.onclick = () => {
        chubTokenInput.value = getSetting('chubToken') || '';
        if (pygmalionEmailInput) pygmalionEmailInput.value = getSetting('pygmalionEmail') || '';
        if (botbooruUsernameInput) botbooruUsernameInput.value = getSetting('botbooruUsername') || '';
        if (botbooruPasswordInput) botbooruPasswordInput.value = getSetting('botbooruPassword') || '';
        if (pygmalionPasswordInput) pygmalionPasswordInput.value = getSetting('pygmalionPassword') || '';
        if (pygmalionRememberCredsCheckbox) pygmalionRememberCredsCheckbox.checked = getSetting('pygmalionRememberCredentials') || false;
        if (ctCookieInput) ctCookieInput.value = getSetting('ctCookie') || '';
        if (ctAutoKeepAliveCheckbox) ctAutoKeepAliveCheckbox.checked = getSetting('ctAutoKeepAlive') !== false;
        renderCtSessionTimer();
        if (wyvernEmailInput) wyvernEmailInput.value = getSetting('wyvernEmail') || '';
        if (wyvernPasswordInput) wyvernPasswordInput.value = getSetting('wyvernPassword') || '';
        if (datacatTokenInput) datacatTokenInput.value = getSetting('datacatToken') || '';
        // Not just field repopulation: this also re-reads the managed browser's live state, which
        // can have started or idle-stopped since the panel was last built.
        refreshBrowserSettingsUi();
        refreshJanitoraiSettingsUi();
        const civitaiApiKeyInput = document.getElementById('settingsCivitaiApiKey');
        if (civitaiApiKeyInput) civitaiApiKeyInput.value = getSetting('civitaiApiKey') || '';
        const pixivCookieInput = document.getElementById('settingsPixivCookie');
        if (pixivCookieInput) pixivCookieInput.value = getSetting('pixivCookie') || '';
        // onchange, not addEventListener: this runs on every settings open, so a listener would
        // stack and one click would fire N writes.
        const datacatPublicFeedCheckbox = document.getElementById('datacatPublicFeedCheckbox');
        if (datacatPublicFeedCheckbox) {
            datacatPublicFeedCheckbox.checked = getSetting('datacatPublicFeed') === true;
            datacatPublicFeedCheckbox.onchange = () => {
                setSetting('datacatPublicFeed', datacatPublicFeedCheckbox.checked);
            };
        }
        const datacatReextractCheckbox = document.getElementById('datacatReextractOnUpdateCheckbox');
        if (datacatReextractCheckbox) {
            datacatReextractCheckbox.checked = getSetting('datacatReextractOnUpdate') === true;
            datacatReextractCheckbox.onchange = () => {
                setSetting('datacatReextractOnUpdate', datacatReextractCheckbox.checked);
            };
        }
        // The stored token itself stays invisible; this row just answers "am I logged in"
        const botbooruLoginState = document.getElementById('botbooruLoginState');
        const refreshBotbooruLoginState = () => {
            if (!botbooruLoginState) return;
            botbooruLoginState.innerHTML = getSetting('botbooruToken')
                ? '<i class="fa-solid fa-circle-check text-success-bright"></i> Logged in, token stored'
                : '<i class="fa-solid fa-circle-xmark text-faint"></i> Not logged in';
        };
        refreshBotbooruLoginState();
        wireSecretToggle(document.getElementById('toggleBotbooruPasswordVisibility'), botbooruPasswordInput);
        const validateBotbooruBtn = document.getElementById('validateBotbooruBtn');
        if (validateBotbooruBtn && botbooruUsernameInput && botbooruPasswordInput) {
            validateBotbooruBtn.onclick = async (e) => {
                e.preventDefault();
                const username = botbooruUsernameInput.value.trim();
                const password = botbooruPasswordInput.value;
                if (!username || !password) {
                    showToast('Enter Botbooru username and password', 'warning');
                    return;
                }
                const originalHtml = validateBotbooruBtn.innerHTML;
                validateBotbooruBtn.classList.remove('success', 'error');
                validateBotbooruBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
                validateBotbooruBtn.disabled = true;
                try {
                    const resp = await apiRequest('/provider-services/botbooru-login', 'POST', { username, password });
                    const data = await resp.json().catch(() => ({}));
                    if (resp.ok && data.access_token) {
                        setSettings({
                            botbooruToken: data.access_token,
                            botbooruUsername: username,
                            botbooruPassword: password,
                            botbooruNsfwAccountSynced: false,
                            botbooruUseTagWeights: false,
                        });
                        refreshBotbooruLoginState();
                        window.renderBotbooruFavTagPills?.();
                        validateBotbooruBtn.classList.add('success');
                        showToast('Logged in to Botbooru, token stored', 'success');
                    } else {
                        validateBotbooruBtn.classList.add('error');
                        const detail = typeof data.detail === 'string' ? data.detail : data.error;
                        showToast(resp.status === 404
                            ? 'Login route unavailable; the server may be out of date'
                            : (detail || `Botbooru login failed (${resp.status})`), 'error');
                    }
                } catch (err) {
                    validateBotbooruBtn.classList.add('error');
                    showToast(`Botbooru login failed: ${err.message}`, 'error');
                } finally {
                    validateBotbooruBtn.disabled = false;
                    const ok = validateBotbooruBtn.classList.contains('success');
                    validateBotbooruBtn.innerHTML = ok ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-times"></i>';
                    setTimeout(() => {
                        validateBotbooruBtn.classList.remove('success', 'error');
                        validateBotbooruBtn.innerHTML = originalHtml;
                    }, 2500);
                }
            };
        }
        // Favorite tags (curated boosters): server-side on the Botbooru account
        const botbooruFavTagsPills = document.getElementById('botbooruFavTagsPills');
        const botbooruFavTagsInput = document.getElementById('botbooruFavTagsInput');
        window.renderBotbooruFavTagPills = async function () {
            if (!botbooruFavTagsPills) return;
            const favAddBtn = document.getElementById('botbooruFavTagsAddBtn');
            const setFavInputEnabled = (on, placeholder) => {
                if (botbooruFavTagsInput) {
                    botbooruFavTagsInput.disabled = !on;
                    botbooruFavTagsInput.placeholder = placeholder;
                }
                if (favAddBtn) favAddBtn.disabled = !on;
            };
            const prov = window.ProviderRegistry?.getProvider('botbooru');
            if (!getSetting('botbooruToken') || !prov?.listFollowedTags) {
                botbooruFavTagsPills.innerHTML = '';
                setFavInputEnabled(false, 'Log in to use favorite tags');
                return;
            }
            // Weighted mode sidelines the basic list entirely (cached flag here;
            // the status refresh below re-applies once the account answers)
            const weightedOn = getSetting('botbooruUseTagWeights') === true;
            setFavInputEnabled(!weightedOn, weightedOn ? 'Weighted tag mode is on' : 'Type a tag');
            // Weighted-mode status drives the whole group; refresh it alongside
            window.renderBotbooruWeightedTagsUI?.();
            botbooruFavTagsPills.innerHTML = '<span class="settings-hint"><i class="fa-solid fa-spinner fa-spin"></i></span>';
            const entries = await prov.listFollowedTags();
            if (!entries) {
                botbooruFavTagsPills.innerHTML = '<span class="settings-hint">Could not load favorite tags</span>';
                return;
            }
            // An empty list renders as an empty (collapsed) container, no placeholder
            botbooruFavTagsPills.innerHTML = entries.map(en =>
                `<span class="provider-exclude-tag-pill" data-entry-id="${en.id}">${escapeHtml(en.tag_name)}<button class="provider-exclude-tag-remove" title="Remove">&times;</button></span>`
            ).join('');
        };
        if (botbooruFavTagsPills) {
            botbooruFavTagsPills.onclick = async (e) => {
                const removeBtn = e.target.closest('.provider-exclude-tag-remove');
                if (!removeBtn) return;
                const pill = removeBtn.closest('[data-entry-id]');
                const prov = window.ProviderRegistry?.getProvider('botbooru');
                if (!pill || !prov?.unfollowTag) return;
                const ok = await prov.unfollowTag(pill.dataset.entryId);
                if (!ok) { showToast('Failed to remove favorite tag', 'error'); return; }
                prov.browseView?.invalidateFollowedTags?.();
                window.renderBotbooruFavTagPills();
            };
        }
        // Count-sorted tag autocomplete with a "category:term" prefix override; attached BEFORE the
        // Enter-add handlers so a pick intercepts the keydown.
        function attachBotbooruTagSuggest(input) {
            if (!input || input._suggestAttached) return;
            input._suggestAttached = true;
            const group = input.closest('.settings-input-group') || input.parentElement;
            group.classList.add('botbooru-suggest-anchor');
            const list = document.createElement('div');
            list.className = 'dropdown-menu botbooru-tag-suggest hidden';
            group.appendChild(list);
            let items = [];
            let active = -1;
            let seq = 0;
            const close = () => { list.classList.add('hidden'); list.innerHTML = ''; items = []; active = -1; };
            const render = () => {
                if (!items.length) { close(); return; }
                list.innerHTML = items.map((t, i) => `
                    <button type="button" class="dropdown-item botbooru-tag-suggest-item${i === active ? ' active' : ''}" data-idx="${i}">
                        <span class="bts-name">${escapeHtml(t.name)}</span>
                        <span class="bts-meta">${escapeHtml(t.category || 'General')} · ${(t.count || 0).toLocaleString()}</span>
                    </button>`).join('');
                list.classList.remove('hidden');
            };
            const pick = (item) => {
                if (!item) return;
                input.value = item.name;
                input._pickedTag = { name: item.name, category: item.category || 'General' };
                close();
                input.focus();
            };
            input.addEventListener('input', debounce(async () => {
                input._pickedTag = null;
                const q = input.value.trim();
                if (q.length < 2) { close(); return; }
                const mySeq = ++seq;
                const prov = window.ProviderRegistry?.getProvider('botbooru');
                const res = await prov?.searchTags?.(q, 8);
                if (mySeq !== seq || !document.contains(input)) return;
                items = res || [];
                active = -1;
                render();
            }, 150));
            input.addEventListener('keydown', (e) => {
                if (list.classList.contains('hidden')) return;
                if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); render(); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
                else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); e.stopImmediatePropagation(); pick(items[active]); }
                else if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); }
            });
            // mousedown beats the input's blur, so the click lands before close
            list.addEventListener('mousedown', (e) => {
                const btn = e.target.closest('[data-idx]');
                if (btn) { e.preventDefault(); pick(items[+btn.dataset.idx]); }
            });
            input.addEventListener('blur', () => setTimeout(close, 150));
        }

        // Picked suggestions carry an explicit category (the follow endpoint
        // 422s without one and same-name tags exist across categories)
        function pickedCategoryFor(input, value) {
            const picked = input?._pickedTag;
            return picked && picked.name.toLowerCase() === String(value).toLowerCase() ? picked.category : null;
        }

        attachBotbooruTagSuggest(botbooruFavTagsInput);

        async function addBotbooruFavTag(value) {
            const prov = window.ProviderRegistry?.getProvider('botbooru');
            if (!getSetting('botbooruToken')) { showToast('Login to Botbooru first', 'warning'); return; }
            // followTag resolves the required category from the tag DB; the first
            // call downloads it (seconds on mobile), so show a busy state
            const prevPlaceholder = botbooruFavTagsInput.placeholder;
            botbooruFavTagsInput.disabled = true;
            botbooruFavTagsInput.placeholder = 'Adding...';
            try {
                const entry = await prov?.followTag?.(value, pickedCategoryFor(botbooruFavTagsInput, value));
                if (!entry) { showToast(`Tag "${value}" not found on Botbooru (or the request failed)`, 'error'); return; }
                botbooruFavTagsInput.value = '';
                prov.browseView?.invalidateFollowedTags?.();
                window.renderBotbooruFavTagPills();
            } finally {
                botbooruFavTagsInput.disabled = false;
                botbooruFavTagsInput.placeholder = prevPlaceholder;
            }
        }
        if (botbooruFavTagsInput) {
            botbooruFavTagsInput.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const value = botbooruFavTagsInput.value.trim();
                    if (value) addBotbooruFavTag(value);
                }
            };
            // Tap target for mobile keyboards whose Enter doesnt reach the input
            const botbooruFavTagsAddBtn = document.getElementById('botbooruFavTagsAddBtn');
            if (botbooruFavTagsAddBtn) botbooruFavTagsAddBtn.onclick = () => {
                const value = botbooruFavTagsInput.value.trim();
                if (value) addBotbooruFavTag(value);
            };
        }

        // Weighted tag mode (account-side experimental switch + weights editor)
        const botbooruWeightedModeCheckbox = document.getElementById('botbooruWeightedModeCheckbox');
        const botbooruWeightsEditorRow = document.getElementById('botbooruWeightsEditorRow');
        const botbooruTagWeightsList = document.getElementById('botbooruTagWeightsList');
        let bbWeightEntriesById = {};

        function renderBotbooruWeightRows(entries) {
            if (!botbooruTagWeightsList) return;
            bbWeightEntriesById = {};
            for (const en of entries) bbWeightEntriesById[en.id] = en;
            botbooruTagWeightsList.innerHTML = entries.length === 0
                ? '<span class="settings-hint">No weighted tags yet</span>'
                : entries.map(en => `
                    <div class="botbooru-weight-row" data-entry-id="${en.id}">
                        <span class="bw-name" title="${escapeHtml(en.category || '')}">${escapeHtml(en.tag_name)}</span>
                        <input type="number" class="glass-input bw-weight" min="-1000" max="1000" step="10" value="${Number(en.weight) || 0}" title="Weight">
                        <button class="glass-btn icon-only bw-flag${en.always_follow ? ' active' : ''}" data-flag="always_follow" title="Always follow"><i class="fa-solid fa-star"></i></button>
                        <button class="glass-btn icon-only bw-flag${en.always_block ? ' active' : ''}" data-flag="always_block" title="Always block"><i class="fa-solid fa-ban"></i></button>
                        <button class="glass-btn icon-only bw-remove" title="Remove"><i class="fa-solid fa-xmark"></i></button>
                    </div>`).join('');
        }

        async function loadBotbooruWeightRows() {
            if (!botbooruTagWeightsList) return;
            const prov = window.ProviderRegistry?.getProvider('botbooru');
            botbooruTagWeightsList.innerHTML = '<span class="settings-hint"><i class="fa-solid fa-spinner fa-spin"></i></span>';
            const entries = await prov?.listTagWeights?.();
            if (!entries) {
                botbooruTagWeightsList.innerHTML = '<span class="settings-hint">Could not load tag weights</span>';
                return;
            }
            renderBotbooruWeightRows(entries);
        }

        window.renderBotbooruWeightedTagsUI = async function () {
            if (!botbooruWeightedModeCheckbox) return;
            const inertWarn = document.getElementById('botbooruFavTagsInertWarn');
            const prov = window.ProviderRegistry?.getProvider('botbooru');
            if (!getSetting('botbooruToken')) {
                botbooruWeightedModeCheckbox.checked = false;
                botbooruWeightedModeCheckbox.disabled = true;
                botbooruWeightsEditorRow?.classList.add('hidden');
                inertWarn?.classList.add('hidden');
                document.getElementById('botbooruBasicFavTagsRow')?.classList.remove('botbooru-fav-tags-inert');
                return;
            }
            botbooruWeightedModeCheckbox.disabled = false;
            // Account status first; the cached setting is only the fallback
            const status = await prov?.refreshWeightedModeStatus?.();
            const on = status != null ? status : getSetting('botbooruUseTagWeights') === true;
            botbooruWeightedModeCheckbox.checked = on;
            botbooruWeightsEditorRow?.classList.toggle('hidden', !on);
            inertWarn?.classList.toggle('hidden', !on);
            document.getElementById('botbooruBasicFavTagsRow')?.classList.toggle('botbooru-fav-tags-inert', on);
            const favInput = document.getElementById('botbooruFavTagsInput');
            const favAddBtn = document.getElementById('botbooruFavTagsAddBtn');
            if (favInput) {
                favInput.disabled = on;
                favInput.placeholder = on ? 'Weighted tag mode is on' : 'Type a tag';
            }
            if (favAddBtn) favAddBtn.disabled = on;
            prov?.browseView?.refreshCuratedSortVisibility?.();
            if (on) loadBotbooruWeightRows();
        };

        if (botbooruWeightedModeCheckbox) {
            botbooruWeightedModeCheckbox.onchange = async () => {
                const prov = window.ProviderRegistry?.getProvider('botbooru');
                const wanted = botbooruWeightedModeCheckbox.checked;
                botbooruWeightedModeCheckbox.disabled = true;
                const result = await prov?.setWeightedMode?.(wanted);
                botbooruWeightedModeCheckbox.disabled = false;
                if (result == null) {
                    botbooruWeightedModeCheckbox.checked = !wanted;
                    showToast('Could not update weighted tag mode', 'error');
                    return;
                }
                window.renderBotbooruWeightedTagsUI();
            };
        }

        if (botbooruTagWeightsList) {
            botbooruTagWeightsList.onchange = async (e) => {
                const input = e.target.closest('.bw-weight');
                const row = e.target.closest('[data-entry-id]');
                if (!input || !row) return;
                const prov = window.ProviderRegistry?.getProvider('botbooru');
                const entry = bbWeightEntriesById[row.dataset.entryId];
                if (!entry) return;
                const updated = await prov?.updateTagWeightEntry?.(entry, { weight: input.value });
                if (!updated) {
                    input.value = Number(entry.weight) || 0;
                    showToast('Failed to update tag weight', 'error');
                    return;
                }
                bbWeightEntriesById[updated.id] = updated;
                input.value = Number(updated.weight) || 0;
                prov?.browseView?.invalidateFollowedTags?.();
            };
            botbooruTagWeightsList.onclick = async (e) => {
                const row = e.target.closest('[data-entry-id]');
                if (!row) return;
                const prov = window.ProviderRegistry?.getProvider('botbooru');
                const entry = bbWeightEntriesById[row.dataset.entryId];
                if (!entry) return;
                const flagBtn = e.target.closest('.bw-flag');
                if (flagBtn) {
                    const flag = flagBtn.dataset.flag;
                    const updated = await prov?.updateTagWeightEntry?.(entry, { [flag]: !entry[flag] });
                    if (!updated) { showToast('Failed to update tag weight', 'error'); return; }
                    bbWeightEntriesById[updated.id] = updated;
                    flagBtn.classList.toggle('active', !!updated[flag]);
                    prov?.browseView?.invalidateFollowedTags?.();
                    return;
                }
                if (e.target.closest('.bw-remove')) {
                    const ok = await prov?.removeTagWeight?.(entry.id);
                    if (!ok) { showToast('Failed to remove tag weight', 'error'); return; }
                    delete bbWeightEntriesById[entry.id];
                    row.remove();
                    if (Object.keys(bbWeightEntriesById).length === 0) renderBotbooruWeightRows([]);
                    prov?.browseView?.invalidateFollowedTags?.();
                }
            };
        }

        attachBotbooruTagSuggest(document.getElementById('botbooruTagWeightsInput'));

        async function addBotbooruTagWeight() {
            const nameInput = document.getElementById('botbooruTagWeightsInput');
            const value = nameInput?.value.trim();
            if (!value) return;
            const prov = window.ProviderRegistry?.getProvider('botbooru');
            const prevPlaceholder = nameInput.placeholder;
            nameInput.disabled = true;
            nameInput.placeholder = 'Adding...';
            try {
                const entry = await prov?.setTagWeight?.(value, { weight: 100, category: pickedCategoryFor(nameInput, value) });
                if (!entry) { showToast(`Tag "${value}" not found on Botbooru (or the request failed)`, 'error'); return; }
                nameInput.value = '';
                prov?.browseView?.invalidateFollowedTags?.();
                loadBotbooruWeightRows();
            } finally {
                nameInput.disabled = false;
                nameInput.placeholder = prevPlaceholder;
            }
        }
        const botbooruTagWeightsInput = document.getElementById('botbooruTagWeightsInput');
        if (botbooruTagWeightsInput) botbooruTagWeightsInput.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); addBotbooruTagWeight(); }
        };
        const botbooruTagWeightsAddBtn = document.getElementById('botbooruTagWeightsAddBtn');
        if (botbooruTagWeightsAddBtn) botbooruTagWeightsAddBtn.onclick = addBotbooruTagWeight;

        const botbooruTrackDownloadsCheckbox = document.getElementById('botbooruTrackDownloadsCheckbox');
        if (botbooruTrackDownloadsCheckbox) {
            botbooruTrackDownloadsCheckbox.checked = getSetting('botbooruTrackDownloads') !== false;
            botbooruTrackDownloadsCheckbox.onchange = () => {
                setSetting('botbooruTrackDownloads', botbooruTrackDownloadsCheckbox.checked);
            };
        }
        const botbooruShowNsflCheckbox = document.getElementById('botbooruShowNsflCheckbox');
        if (botbooruShowNsflCheckbox) {
            botbooruShowNsflCheckbox.checked = getSetting('botbooruShowNsfl') === true;
            botbooruShowNsflCheckbox.onchange = () => {
                // An account past the first NSFW-enable consent gets the switch pushed at once; otherwise the
                // first NSFW enable sends both flags
                const wasSynced = getSetting('botbooruNsfwAccountSynced') === true;
                setSetting('botbooruShowNsfl', botbooruShowNsflCheckbox.checked);
                setSetting('botbooruNsfwAccountSynced', false);
                window.ProviderRegistry?.getProvider('botbooru')?.browseView?.refreshAfterContentFlagsChange?.(wasSynced);
            };
        }

        const minScore = numberSetting('duplicateMinScore');
        minScoreSlider.value = minScore;
        minScoreValue.textContent = parseInt(minScore) >= 120 ? 'Exact' : minScore;

        if (possibleMatchScoreSlider) {
            const pmVal = numberSetting('possibleMatchMinScore');
            possibleMatchScoreSlider.value = pmVal;
            if (possibleMatchScoreValue) possibleMatchScoreValue.textContent = String(pmVal);
        }
        if (importDirectDownloadsCheckbox) {
            importDirectDownloadsCheckbox.checked = getSetting('importDirectDownloads') === true;
        }
        
        // Search defaults
        searchNameCheckbox.checked = getSetting('searchInName') !== false;
        if (searchListingNameCheckbox) searchListingNameCheckbox.checked = getSetting('searchInListingName') !== false;
        searchTagsCheckbox.checked = getSetting('searchInTags') !== false;
        searchAuthorCheckbox.checked = getSetting('searchInAuthor') || false;
        searchNotesCheckbox.checked = getSetting('searchInNotes') || false;
        if (searchTaglineCheckbox) searchTaglineCheckbox.checked = getSetting('searchInTagline') || false;
        if (searchDescriptionCheckbox) searchDescriptionCheckbox.checked = getSetting('searchInDescription') || false;
        if (searchFirstMessageCheckbox) searchFirstMessageCheckbox.checked = getSetting('searchInFirstMessage') || false;
        if (searchAltGreetingsCheckbox) searchAltGreetingsCheckbox.checked = getSetting('searchInAltGreetings') || false;
        if (paletteSearchCardsCheckbox) paletteSearchCardsCheckbox.checked = getSetting('paletteSearchCards') !== false;
        if (paletteSearchMessagesCheckbox) paletteSearchMessagesCheckbox.checked = getSetting('paletteSearchMessages') !== false;
        if (paletteSearchLoreCheckbox) paletteSearchLoreCheckbox.checked = getSetting('paletteSearchLore') !== false;
        void fillViewSettings();

        // Character details
        richCreatorNotesCheckbox.checked = getSetting('richCreatorNotes') || false;
        if (expandCreatorNotesCheckbox) expandCreatorNotesCheckbox.checked = getSetting('expandCreatorNotes') || false;
        if (displayNamePreferenceSelect) displayNamePreferenceSelect.value = getSetting('displayNamePreference') || 'card';
        if (showNameToggleCheckbox) showNameToggleCheckbox.checked = getSetting('showNameToggle') !== false;
        
        // Media Localization
        if (mediaLocalizationCheckbox) {
            mediaLocalizationCheckbox.checked = getSetting('mediaLocalizationEnabled') !== false; // Default true
        }
        if (includeProviderGalleryCheckbox) {
            includeProviderGalleryCheckbox.checked = getSetting('includeProviderGallery') !== false;
        }
        if (includeLorebookCheckbox) {
            includeLorebookCheckbox.checked = getSetting('includeLorebook') || false;
        }
        if (fastFilenameSkipCheckbox) {
            fastFilenameSkipCheckbox.checked = getSetting('fastFilenameSkip') || false;
        }
        if (backgroundImportsCheckbox) backgroundImportsCheckbox.checked = getSetting('backgroundImports') !== false;
        if (importMediaActionSelect) {
            importMediaActionSelect.value = getSetting('importMediaAction') || 'background';
        }
        if (includeExternalGalleriesCheckbox) {
            includeExternalGalleriesCheckbox.checked = getSetting('includeExternalGalleries') !== false;
        }

        // Developer
        if (debugModeCheckbox) {
            debugModeCheckbox.checked = getSetting('debugMode') || false;
        }
        if (showInfoTabCheckbox) {
            showInfoTabCheckbox.checked = getSetting('showInfoTab') || false;
        }
        if (exportAsLinksCheckbox) {
            exportAsLinksCheckbox.checked = getSetting('exportAsLinks') || false;
        }
        if (exportFormatSelect) {
            exportFormatSelect.value = getSetting('exportFormat') === 'charx' ? 'charx' : 'png';
        }
        if (showProviderTaglineCheckbox) {
            showProviderTaglineCheckbox.checked = getSetting('showProviderTagline') !== false;
        }
        if (allowRichTaglineCheckbox) {
            allowRichTaglineCheckbox.checked = getSetting('allowRichTagline') === true;
        }
        if (browseSnapSectionsCheckbox) {
            browseSnapSectionsCheckbox.checked = getSetting('browseSnapSections') === true;
        }
        if (collapseAllBrowseSectionsCheckbox) {
            collapseAllBrowseSectionsCheckbox.checked = getSetting('collapseAllBrowseSections') === true;
        }
        if (mobileProviderQuickSwitchCheckbox) {
            mobileProviderQuickSwitchCheckbox.checked = getSetting('mobileProviderQuickSwitch') !== false;
        }
        if (mobileHideBackArrowsCheckbox) {
            mobileHideBackArrowsCheckbox.checked = getSetting('mobileHideBackArrows') === true;
        }
        if (mobileBrowseQuickImportCheckbox) {
            mobileBrowseQuickImportCheckbox.checked = getSetting('mobileBrowseQuickImport') !== false;
        }
        if (mobileSwipeGesturesCheckbox) {
            mobileSwipeGesturesCheckbox.checked = getSetting('mobileSwipeGestures') !== false;
        }
        if (mobileHapticsCheckbox) {
            mobileHapticsCheckbox.checked = getSetting('mobileHaptics') !== false;
        }
        // Appearance
        if (mobileModeSelect) {
            mobileModeSelect.value = window.getMobileModeOverride?.() || 'auto';
            if (mobileModeSelect._customSelect) mobileModeSelect._customSelect.refresh();
        }
        if (uiScaleSelect) {
            uiScaleSelect.value = String(getSetting('uiScale') ?? 3);
            if (uiScaleSelect._customSelect) uiScaleSelect._customSelect.refresh();
        }
        if (modalSizeSelect) {
            modalSizeSelect.value = String(getSetting('modalSize') ?? 2);
            if (modalSizeSelect._customSelect) modalSizeSelect._customSelect.refresh();
        }
        syncXlModalSizeAvailability();
        if (buttonStyleSelect) {
            buttonStyleSelect.value = getSetting('buttonStyle') || 'glass';
            if (buttonStyleSelect._customSelect) buttonStyleSelect._customSelect.refresh();
        }
        if (animateTagPillsCheckbox) {
            animateTagPillsCheckbox.checked = getSetting('animateTagPills') || false;
            if (animateKeepNameRow) animateKeepNameRow.hidden = !animateTagPillsCheckbox.checked;
        }
        if (animateKeepNameCheckbox) {
            animateKeepNameCheckbox.checked = getSetting('animateKeepName') || false;
        }
        if (hidePlaylistBadgesCheckbox) {
            hidePlaylistBadgesCheckbox.checked = getSetting('hidePlaylistBadges') || false;
        }
        if (enableCharDetailNavCheckbox) {
            enableCharDetailNavCheckbox.checked = getSetting('enableCharDetailNav') !== false;
        }
        if (highlightColorInput) {
            highlightColorInput.value = getSetting('highlightColor') || DEFAULT_SETTINGS.highlightColor;
        }
        
        // Card Updates
        if (chubUseV4ApiCheckbox) {
            chubUseV4ApiCheckbox.checked = getSetting('chubUseV4Api') || false;
        }
        if (chubTimelineJoinedCheckbox) {
            chubTimelineJoinedCheckbox.checked = getSetting('chubTimelineJoined') === true;
        }

        // Version History
        if (autoSnapshotOnEditCheckbox) {
            autoSnapshotOnEditCheckbox.checked = getSetting('autoSnapshotOnEdit') || false;
        }
        if (maxAutoBackupsInput) {
            maxAutoBackupsInput.value = getSetting('maxAutoBackups') ?? 10;
        }

        // Library Backup: controls from settings, the STATUS asked fresh, since sizes and counts age the
        // moment anything imports.
        if (backupFrequencySelect) backupFrequencySelect.value = getSetting('backupFrequency') || 'off';
        if (backupKeepInput) backupKeepInput.value = getSetting('backupKeep') ?? 5;
        if (backupWindowStartSelect) backupWindowStartSelect.value = String(getSetting('backupWindowStart') ?? 3);
        if (backupWindowEndSelect) backupWindowEndSelect.value = String(getSetting('backupWindowEnd') ?? 6);
        refreshBackupPanel();
        if (autoTidySearchIndexCheckbox) autoTidySearchIndexCheckbox.checked = getSetting('autoTidySearchIndex') !== false;
        if (preloadLibraryCheckbox) preloadLibraryCheckbox.checked = getSetting('preloadLibrary') !== false;
        refreshSearchIndexPanel();
        if (extNotifyUpdatesCheckbox) extNotifyUpdatesCheckbox.checked = getSetting('notifyExtensionUpdates') === true;
        refreshMigratePanel();

        // Provider Order & Defaults
        buildProviderOrderUI();
        buildInfiniteScrollUI();
        populateAllExcludeTagPills();
        window.renderBotbooruFavTagPills?.();

        switchSettingsSection('general');
        setPhonePage('list');
        // drawn before the search, which reads the rows
        syncKeyboardSection();
        renderKeymap();
        if (settingsSearchInput) {
            settingsSearchInput.value = '';
            settingsSearchInput.dispatchEvent(new Event('input'));
        }

        openedSaveModel = readSaveModel();
        settingsModal.classList.add('visible');
    };
    
    // Settings sidebar navigation
    function switchSettingsSection(sectionName) {
        settingsModal.querySelectorAll('.settings-nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.section === sectionName);
        });
        settingsModal.querySelectorAll('.settings-panel').forEach(panel => {
            panel.classList.toggle('active', panel.dataset.section === sectionName);
        });
    }
    
    // on a phone Settings is a list of sections, then a section's page: the dialog's class names the page, the header its title
    const settingsDialogEl = settingsModal.querySelector('.settings-modal-content');
    // the title's own text node is written, never wrapped: a span shifts the desktop's title by a subpixel
    const settingsTitle = settingsModal.querySelector('.cl-modal-header h3');
    const settingsTitleText = [...(settingsTitle?.childNodes || [])].find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    const settingsTitleIcon = settingsTitle?.querySelector('i');
    function setPhonePage(page) {
        const onSection = page === 'section' && !!window.isMobileMode?.();
        const active = settingsModal.querySelector('.settings-nav-item.active');
        const was = !!settingsDialogEl?.classList.contains('settings-phone-section');
        settingsDialogEl?.classList.toggle('settings-phone-section', onSection);
        // a section's page is a layer with a guard of its own, so back pops it to the list and never re-arms mid-traversal
        if (onSection && !was) window.pushOverlayGuard?.();
        if (settingsTitleText) settingsTitleText.textContent = ` ${onSection ? (active?.querySelector('span')?.textContent || 'Settings') : 'Settings'}`;
        if (settingsTitleIcon) settingsTitleIcon.className = onSection && active?.querySelector('i') ? active.querySelector('i').className : 'fa-solid fa-gear';
    }
    const onPhoneSection = () => !!window.isMobileMode?.() && !!settingsDialogEl?.classList.contains('settings-phone-section');
    // the search heads the list on a phone, the header elsewhere
    const settingsSearchBar = settingsModal.querySelector('.settings-search-bar');
    function placeSettingsSearch() {
        if (!settingsSearchBar) return;
        const phone = !!window.isMobileMode?.();
        const home = phone ? settingsModal.querySelector('.settings-sidebar') : settingsModal.querySelector('.cl-modal-header');
        if (phone && settingsSearchBar.parentElement !== home) home?.prepend(settingsSearchBar);
        else if (!phone && settingsSearchBar.parentElement !== home) home?.insertBefore(settingsSearchBar, document.getElementById('closeSettingsModal'));
    }
    placeSettingsSearch();
    document.addEventListener('cl-mobile-mode-change', () => { placeSettingsSearch(); if (!window.isMobileMode?.()) setPhonePage('list'); });
    // each phone list row carries its section's line under its name and a chevron; a narrow window's More lists the name alone
    settingsModal.querySelectorAll('.settings-nav-item').forEach(item => {
        if (item.querySelector('.settings-nav-chevron')) return;
        item.dataset.overflowLabel = item.querySelector('span')?.textContent.trim() || '';
        const desc = settingsModal.querySelector(`.settings-panel[data-section="${item.dataset.section}"] .settings-panel-desc`)?.textContent.trim();
        if (desc) {
            const line = document.createElement('small');
            line.className = 'settings-nav-desc';
            line.textContent = desc;
            item.appendChild(line);
        }
        const chevron = document.createElement('i');
        chevron.className = 'fa-solid fa-chevron-right settings-nav-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        item.appendChild(chevron);
    });

    settingsModal.querySelectorAll('.settings-nav-item').forEach(item => {
        item.addEventListener('click', () => {
            switchSettingsSection(item.dataset.section);
            setPhonePage('section');
            if (item.dataset.section === 'ai') initLlmProfilesPanel();
            if (item.dataset.section === 'chat') initChatPanel();
            if (item.dataset.section === 'extensions') initExtensionsPanel();
            if (item.dataset.section === 'keyboard') renderKeymap();
        });
    });

    // Keyboard (Settings > Keyboard): every shortcut the keymap holds, by where it works
    const KEYMAP_ICONS = { global: 'fa-globe', library: 'fa-table-cells-large', conversation: 'fa-comments', chatGallery: 'fa-images', viewer: 'fa-expand' };
    // the row listening for its new key: { id }
    let keymapListening = null;
    // the key released after a capture: its keyup would click the focused key cap again
    let keymapSwallowUp = null;
    const keymapCaps = (combo) => (combo ? window.Keymap.capsOf(combo).map(c => `<kbd class="cl-kbd">${escapeHtml(c)}</kbd>`).join('') : '<span class="keymap-none">None</span>');
    const keymapSpoken = (combo) => (combo ? window.Keymap.capsOf(combo).join('+') : 'no key');

    // a phone shows the section once a real keyboard pressed a key in this tab
    function syncKeyboardSection() {
        const nav = document.getElementById('settingsNavKeyboard');
        if (nav) nav.hidden = !!window.isMobileMode?.() && !window.Keymap?.keyboardSeen();
    }

    function renderKeymap() {
        const host = document.getElementById('keymapGroups');
        const K = window.Keymap;
        if (!host || !K) return;
        if (document.getElementById('settingsNavKeyboard')?.hidden) { host.innerHTML = ''; return; }
        const actions = K.list();
        const groups = K.SCOPES.map(s => ({ title: s.label, icon: KEYMAP_ICONS[s.id], rows: actions.filter(a => !a.owner && a.scope === s.id) }));
        for (const owner of [...new Set(actions.filter(a => a.owner).map(a => a.owner))]) {
            const rows = actions.filter(a => a.owner === owner);
            groups.push({ title: rows[0].ownerName || owner, icon: 'fa-puzzle-piece', rows, extension: true });
        }
        host.innerHTML = groups.filter(g => g.rows.length).map(g => `
            <div class="settings-group">
                <div class="settings-group-title"><i class="fa-solid ${g.icon}"></i> ${escapeHtml(g.title)}</div>
                <div class="keymap-list">${g.rows.map(a => keymapRowHtml(a, g.extension)).join('')}</div>
            </div>`).join('');
        const resetAll = document.getElementById('keymapResetAll');
        if (resetAll) resetAll.disabled = !actions.some(a => a.key !== a.defaultKey);
    }

    function keymapRowHtml(a, extension) {
        const changed = a.key !== a.defaultKey;
        const where = extension ? `<span class="keymap-where">${escapeHtml(window.Keymap.SCOPE_LABEL[a.scope] || '')}</span>` : '';
        return `<div class="keymap-row${changed ? ' is-changed' : ''}" data-key-id="${escapeHtml(a.id)}">
            <span class="keymap-label">${escapeHtml(a.label)}${where}</span>
            <button type="button" class="settings-action-btn keymap-cap" aria-label="${escapeHtml(a.label)}: ${escapeHtml(keymapSpoken(a.key))}. Change its key">${keymapCaps(a.key)}</button>
            <button type="button" class="settings-action-btn keymap-reset" title="Back to ${escapeHtml(keymapSpoken(a.defaultKey))}" aria-label="${escapeHtml(a.label)} back to ${escapeHtml(keymapSpoken(a.defaultKey))}"${changed ? '' : ' hidden'}><i class="fa-solid fa-rotate-left"></i></button>
        </div>`;
    }

    function keymapListen(row) {
        keymapStop(false);
        const cap = row.querySelector('.keymap-cap');
        keymapListening = { id: row.dataset.keyId };
        cap.classList.add('is-listening');
        cap.innerHTML = '<span class="keymap-none">Press a key</span>';
        // on the window in the capture phase, ahead of the layers' Escape and every shortcut on the page
        window.addEventListener('keydown', keymapOnKey, true);
        window.addEventListener('keyup', keymapOnKeyUp, true);
    }

    function keymapStop(render = true) {
        keymapListening = null;
        window.removeEventListener('keydown', keymapOnKey, true);
        if (render) renderKeymap();
    }

    function keymapOnKeyUp(e) {
        if (keymapListening || keymapSwallowUp === null) return;
        if (e.key === keymapSwallowUp) { e.preventDefault(); e.stopImmediatePropagation(); }
        keymapSwallowUp = null;
        window.removeEventListener('keyup', keymapOnKeyUp, true);
    }

    async function keymapOnKey(e) {
        if (!keymapListening) return;
        // Settings closed while a key was asked for: this key is the page's, and the listening ends
        if (!settingsModal.classList.contains('visible')) { keymapStop(false); return; }
        e.preventDefault();
        e.stopImmediatePropagation();
        const K = window.Keymap;
        const { id } = keymapListening;
        const bare = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
        // the key under Esc records as its place, so it reads the same on any layout
        const combo = K.positionComboOf(e) || K.comboOf(e);
        // a modifier on its own: still listening
        if (!combo && !(bare && (e.key === 'Escape' || e.key === 'Backspace'))) return;
        // Enter, Tab and the arrows keep their jobs: still listening, and the cap says why
        if (combo && !(bare && (e.key === 'Escape' || e.key === 'Backspace')) && K.isReserved(combo)) {
            const cap = document.querySelector(`#keymapGroups .keymap-row[data-key-id="${CSS.escape(id)}"] .keymap-cap`);
            if (cap) cap.innerHTML = '<span class="keymap-none">That key keeps its own job</span>';
            return;
        }
        keymapSwallowUp = e.key;
        keymapStop(false);
        if (bare && e.key === 'Escape') return renderKeymap();
        if (bare && e.key === 'Backspace') { K.setBinding(id, ''); return renderKeymap(); }
        const clashes = K.clashesOf(id, combo);
        if (clashes.length) {
            const byId = new Map(K.list().map(a => [a.id, a]));
            const mine = byId.get(id);
            const names = clashes.map(c => `"${byId.get(c)?.label || c}"`).join(' and ');
            const ok = await showConfirm({
                title: 'That key is taken',
                message: `${keymapSpoken(combo)} is the key of ${names}. Give it to "${mine?.label || id}", and ${names} ${clashes.length > 1 ? 'take' : 'takes'} ${mine?.key ? keymapSpoken(mine.key) : 'no key'}?`,
                confirmLabel: 'Swap',
                cancelLabel: 'Keep both as they are',
            });
            if (ok) K.takeKey(id, combo);
        } else {
            K.setBinding(id, combo);
        }
        renderKeymap();
    }

    document.getElementById('keymapGroups')?.addEventListener('click', (e) => {
        const row = e.target.closest('.keymap-row');
        if (!row) return;
        if (e.target.closest('.keymap-reset')) { window.Keymap.setBinding(row.dataset.keyId, null); renderKeymap(); return; }
        if (e.target.closest('.keymap-cap')) keymapListen(row);
    });
    on('keymapResetAll', 'click', async () => {
        const ok = await showConfirm({ title: 'Reset every key?', message: 'Every shortcut goes back to its own key, the extensions\' too.', confirmLabel: 'Reset', cancelLabel: 'Cancel' });
        if (!ok) return;
        window.Keymap.resetAll();
        renderKeymap();
    });
    // another tab's write, or an extension's key arriving or leaving
    window.Keymap?.onChange(() => { if (!keymapListening) renderKeymap(); });
    // laid out as a row (the phone, a narrow window), the strip keeps the sections that fit and the rest wait behind its More
    const settingsNav = settingsModal.querySelector('.settings-nav');
    if (settingsNav) fitRow(settingsNav, {
        entries: () => [...settingsNav.querySelectorAll('.settings-nav-item')],
        more: settingsNav.querySelector('.settings-nav-more'),
        current: '.active',
    });

    // AI Profiles panel (Settings > AI)
    // Server-owned rows; the editor is the shared ConnectionEditor, the same form the chat panel uses.
    let llmKinds = [];
    let llmEditor = null;
    const llmEl = id => document.getElementById(id);

    // Extensions panel (Settings > Extensions): the inventory and the per-user switch; install,
    // update and remove are admin verbs over /api/extensions
    async function initExtensionsPanel() {
        const adminGroup = document.getElementById('extAdminGroup');
        if (adminGroup) adminGroup.hidden = !currentUser?.admin;
        // hearing about updates and asking for them are an admin's, as updating is
        const updatesGroup = document.getElementById('extUpdatesGroup');
        if (updatesGroup) updatesGroup.hidden = !currentUser?.admin;
        paintExtUpdatesBand();
        await renderExtensionList();
    }

    // the last update check as the notifications module read it, so the rows, the band and the bell say the same
    let extUpdates = null;
    const extUpdateOf = (id) => extUpdates?.extensions?.find(x => x.id === id) || null;
    const extNames = (list) => list.map(x => x.name || x.id).join(', ');
    // The Updates band: a check running, else what the last one found, and Check Now while none runs.
    function paintExtUpdatesBand() {
        const band = document.getElementById('extUpdatesBand');
        const icon = document.getElementById('extUpdatesIcon');
        const btn = document.getElementById('extCheckUpdatesBtn');
        if (!band || !icon || !btn) return;
        const busy = !!extUpdates?.checking;
        btn.disabled = busy;
        btn.innerHTML = busy ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Checking' : '<i class="fa-solid fa-arrows-rotate"></i> Check Now';
        band.classList.remove('is-ok', 'is-warn');
        const paint = (glyph, when, sub, state = null) => {
            icon.className = `fa-solid ${glyph} settings-band-icon`;
            bkSet('extUpdatesWhen', when);
            bkSet('extUpdatesSub', sub);
            if (state) band.classList.add(state);
        };
        if (busy) return paint('fa-circle-notch fa-spin', 'Checking for updates', 'Asking each installed extension\'s repository');
        if (!extUpdates?.checkedAt) return paint('fa-cloud-arrow-down', 'Not checked yet', 'Check Now asks each installed extension\'s repository whether it has a newer version');
        const list = extUpdates.extensions || [];
        const waiting = list.filter(x => x.available);
        const failed = list.filter(x => x.error);
        const when = `Checked ${bkAgo(extUpdates.checkedAt)}`;
        const failedWords = failed.length ? `${failed.length} could not be checked: ${extNames(failed)}` : '';
        if (waiting.length) return paint('fa-circle-arrow-up', when, [`${waiting.length} update${waiting.length === 1 ? '' : 's'} waiting: ${extNames(waiting)}`, failedWords].filter(Boolean).join(' · '));
        if (failed.length) return paint('fa-triangle-exclamation', when, failedWords, 'is-warn');
        if (!list.length) return paint('fa-circle-check', when, 'Nothing to check: no installed extension came from a repository', 'is-ok');
        paint('fa-circle-check', when, 'Every installed extension is up to date', 'is-ok');
    }
    // the notifications' Open Extensions: the first row with an update is brought into view once the list is drawn
    let extFocusUpdate = false;
    document.addEventListener('cl-extension-updates-focus', () => { extFocusUpdate = true; });
    document.addEventListener('cl-extension-updates-changed', (e) => {
        extUpdates = e.detail || null;
        paintExtUpdatesBand();
        // a list on screen repaints once the answer is in; a hidden one reads it when it shows
        if (!extUpdates?.checking && document.getElementById('extListBody')?.offsetParent) void renderExtensionList();
    });
    document.getElementById('extCheckUpdatesBtn')?.addEventListener('click', () => document.dispatchEvent(new CustomEvent('cl-extension-updates-check')));
    // the Extensions page's switches take effect at once, so this one does too
    extNotifyUpdatesCheckbox?.addEventListener('change', () => setSetting('notifyExtensionUpdates', extNotifyUpdatesCheckbox.checked));

// a row's word on its install's entry in the last update check: the version coming, the chip, the verb's title, a phone's button
function extUpdateParts(next, id) {
    const nextLabel = next?.available ? (next.nextVersion ? `v${next.nextVersion}` : 'a newer version') : '';
    const chip = next?.available ? '<span class="ext-chip ext-chip-update">update available</span>'
        : next?.error ? `<span class="ext-chip" title="${escapeHtml(next.error)}">update check failed</span>` : '';
    const verbTitle = next?.available ? `Update to ${nextLabel}` : 'Update to the latest version';
    const button = nextLabel ? `<div class="ext-row-update"><button type="button" class="cl-btn cl-btn-primary cl-btn-sm" data-ext-update="${escapeHtml(id)}">${escapeHtml(verbTitle)}</button></div>` : '';
    return { nextLabel, chip, verbTitle, button };
}

// what a manifest's contributes entries read as in the manager row
const EXT_CONTRIBUTION_LABELS = { 'chat.window': 'a chat window', 'chat.action': 'chat actions', 'message.action': 'message actions', 'character.action': 'character actions', 'app.action': 'menu actions', 'character.card.badge': 'grid card badges', 'character.details.tab': 'a character details tab', 'character.bulk.action': 'actions on a selection', 'shell.view': 'a view of its own', 'lore.entry.action': 'lorebook entry actions', 'chat.card.action': 'chat card actions', 'composer.action': 'composer buttons' };

    // The inspector: what one extension registered and what its calls cost, in this tab and on the
    // server. Open rows stay open across redraws.
    const extInspectOpen = new Set();
    // the rows a phone holds open (their additions, verbs and settings shown); kept across redraws
    const extRowsOpen = new Set();
    // a folder shadowing a bundled id is listed as a second row under that id, so a row is keyed by its group too
    const extRowKey = (e) => `${e.bundled ? 'bundled' : 'installed'}:${e.id}`;
    let extRows = new Map();
    function extInspectorHtml(id) {
        // the row from the last list read carries the server half's hooks and their cost
        const data = window.ExtensionHost?.inspect?.(id, extRows.get(id));
        if (!data) return '';
        const ms = (v) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));
        const regs = data.registrations.length
            ? `<div class="ext-inspect-regs">${data.registrations.map(r => `<span class="ext-inspect-reg"><span class="ext-inspect-kind">${escapeHtml(r.kind)}</span>${escapeHtml(r.id)}</span>`).join('')}</div>`
            : '<div class="ext-inspect-empty">Nothing registered.</div>';
        const calls = data.calls.length
            ? `<div class="ext-inspect-scroll"><div class="ext-inspect-calls">
                <span class="ext-inspect-th">Call</span><span class="ext-inspect-th">Runs</span><span class="ext-inspect-th">p50</span><span class="ext-inspect-th">p95</span><span class="ext-inspect-th">Total</span>
                ${data.calls.map(c => `
                    <span class="ext-inspect-name">${escapeHtml(c.name)}${c.server ? ' <span class="ext-chip" title="Runs on the server, for your account">server</span>' : ''}${c.refused ? ` <span class="ext-chip">${c.refused} refused</span>` : ''}${c.errors ? ` <span class="ext-chip ext-chip-error">${c.errors} failed</span>` : ''}</span>
                    <span class="ext-inspect-num">${c.count}</span><span class="ext-inspect-num">${ms(c.p50)}</span><span class="ext-inspect-num">${ms(c.p95)}</span><span class="ext-inspect-num">${ms(c.totalMs)}</span>
                    ${c.errors ? `<span class="ext-inspect-err">${escapeHtml(c.lastError)}</span>` : ''}`).join('')}
            </div></div>`
            : '<div class="ext-inspect-empty">No calls yet.</div>';
        const conflicts = data.conflicts.length
            ? `<div class="ext-inspect-group"><div class="ext-inspect-title">Conflicts</div>${data.conflicts.map(c => `<div class="ext-inspect-conflict"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(c.id)} is overridden by ${escapeHtml(c.owners.join(', '))}</div>`).join('')}</div>`
            : '';
        return `<div class="ext-row-inspect" data-ext-inspector="${escapeHtml(id)}">
            <div class="ext-inspect-group"><div class="ext-inspect-title">Registered</div>${regs}</div>
            <div class="ext-inspect-group"><div class="ext-inspect-title">Calls <span class="ext-inspect-unit">milliseconds</span></div>${calls}</div>
            ${conflicts}
        </div>`;
    }

    async function renderExtensionList() {
        const body = document.getElementById('extListBody');
        const bundledBody = document.getElementById('extBundledBody');
        if (!body || !bundledBody) return;
        let data = null;
        try {
            const resp = await apiRequest('/extensions', 'GET');
            if (resp.ok) data = await resp.json();
        } catch { /* the unread state below */ }
        const emptyState = (icon, lead, sub) => `
            <div class="ext-empty">
                <div class="ext-empty-glyph"><i class="fa-solid ${icon}"></i></div>
                <div class="ext-empty-lead">${lead}</div>
                <div class="ext-empty-sub">${sub}</div>
            </div>`;
        // the two groups are the split the server's flag makes, never worked out from the row
        const installed = data?.extensions?.filter(e => !e.bundled) || [];
        const bundled = data?.extensions?.filter(e => e.bundled) || [];
        const pill = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n ? String(n) : ''; };
        pill('extCountPill', installed.length);
        pill('extBundledCountPill', bundled.length);
        // a server that did not answer, or booted dark, is said once, in the first group
        const dark = !data ? emptyState('fa-triangle-exclamation', 'Could not read the extension list', 'The server did not answer; refresh to retry.')
            : data.enabled === false ? emptyState('fa-power-off', 'Extensions are switched off', 'This server booted with CL_EXTENSIONS=off.') : '';
        const bundledGroup = document.getElementById('extBundledGroup');
        if (bundledGroup) bundledGroup.hidden = !!dark;
        if (dark) { body.innerHTML = dark; bundledBody.innerHTML = ''; return; }
        // the inspector's rows are the ones that loaded: a broken row under the same id never replaces one
        extRows = new Map(data.extensions.filter(e => !e.error).map(e => [e.id, e]));
        const isAdmin = !!currentUser?.admin;
        const rowHtml = (e) => {
            // whether it runs for this account is the server's answer, never worked out here
            const on = e.enabled === true;
            // a broken row loaded nothing: what the host holds under its id belongs to another row
            const status = e.error ? null : window.ExtensionHost?.getExtensionStatus?.(e.id);
            const loaded = status?.state === 'loaded';
            // a lazy extension's entry points are in place; its code loads at their first use
            const waiting = status?.state === 'declared';
            const inspectable = !e.error && (loaded || waiting || !!e.serverHooks?.length);
            // a server-only extension has nothing to load in a tab; its server chip says it all
            const tabPart = !!(e.client || e.style);
            const chip = e.error ? `<span class="ext-chip ext-chip-error" title="${escapeHtml(e.error)}">broken</span>`
                : status?.state === 'failed' ? `<span class="ext-chip ext-chip-error" title="${escapeHtml(status.error || '')}">failed</span>`
                : on && loaded ? '<span class="ext-chip ext-chip-ok">loaded</span>'
                : on && waiting ? '<span class="ext-chip ext-chip-ok" title="Its menu verbs, windows and views are in place; its code loads the first time one is used">on first use</span>'
                : on && tabPart ? '<span class="ext-chip">loads on reload</span>'
                : !on && (loaded || waiting) ? '<span class="ext-chip" title="Switched off from another tab or device; it stops here on a reload, or switch it on and off">on in this tab</span>' : '';
            const inspecting = inspectable && extInspectOpen.has(e.id);
            const opened = extRowsOpen.has(extRowKey(e));
            // a desktop row folds only its settings section, so the chevron shows where there is one
            const hasSettings = !e.error && !!window.ExtensionHost?.hasSettingsSection?.(e.id);
            // the reason a row is not running, said on the row: a chip's title never shows on a phone
            const why = e.error || (status?.state === 'failed' ? status.error : '') || (e.serverState === 'failed' ? e.serverError : '');
            // the dev loop's verb: this tab's copy of its code, fetched fresh; nothing on the server moves
            const reloadable = tabPart && !e.error && (on || !!status);
            // what the last update check found for an install; only an admin can act on it
            const updatable = isAdmin && e.git && !e.reserved;
            const { nextLabel, chip: updateChip, verbTitle, button: updateButton } = extUpdateParts(isAdmin && !e.bundled ? extUpdateOf(e.id) : null, e.id);
            const serverChip = !e.server ? ''
                : e.serverState === 'loaded' ? '<span class="ext-chip ext-chip-ok">server on</span>'
                : e.serverState === 'failed' ? `<span class="ext-chip ext-chip-error" title="${escapeHtml(e.serverError || '')}">server failed</span>`
                : '<span class="ext-chip" title="Server halves mount at boot">server: restart to apply</span>';
            // the verbs are a group of their own, so a phone can give them a line beside no name
            const verbs = [
                inspectable ? `<button class="glass-btn icon-only ext-row-verb${inspecting ? ' is-active' : ''}" data-ext-inspect="${escapeHtml(e.id)}" title="Inspect: what it registered and what its calls cost" aria-expanded="${inspecting}"><i class="fa-solid fa-gauge-high"></i></button>` : '',
                reloadable ? `<button class="glass-btn icon-only ext-row-verb" data-ext-reload="${escapeHtml(e.id)}" title="Reload its code in this tab, as its folder now holds it" aria-label="Reload ${escapeHtml(e.name || e.id)}"><i class="fa-solid fa-rotate-right"></i></button>` : '',
                updatable ? `<button class="glass-btn icon-only ext-row-verb" data-ext-update="${escapeHtml(e.id)}" title="${escapeHtml(verbTitle)}"><i class="fa-solid fa-arrows-rotate"></i></button>` : '',
                isAdmin && !e.bundled && !e.reserved ? `<button class="glass-btn icon-only ext-row-verb" data-ext-remove="${escapeHtml(e.id)}" title="Remove from the server"><i class="fa-solid fa-trash"></i></button>` : '',
            ].join('');
            const meta = [chip, serverChip, updateChip, e.author ? `<span class="ext-row-author">${escapeHtml(e.author)}</span>` : ''].filter(Boolean).join('');
            return `
            <div class="ext-row${e.error ? ' ext-row-broken' : ''}${hasSettings ? ' has-settings' : ''}${opened ? ' is-open' : ''}${nextLabel ? ' has-update' : ''}" data-ext="${escapeHtml(e.id)}" data-ext-key="${escapeHtml(extRowKey(e))}">
                <div class="ext-row-head">
                    <div class="ext-row-tile"><i class="fa-solid ${e.provider ? 'fa-plug' : 'fa-puzzle-piece'}"></i></div>
                    <div class="ext-row-id">
                        <div class="ext-row-title">
                            <span class="ext-row-name">${escapeHtml(e.name || e.id)}</span>
                            ${e.version ? `<span class="ext-row-version">v${escapeHtml(e.version)}${nextLabel ? ` &rarr; ${escapeHtml(nextLabel)}` : ''}</span>` : ''}
                        </div>
                        ${meta ? `<div class="ext-row-meta">${meta}</div>` : ''}
                        ${e.description ? `<p class="ext-row-desc">${escapeHtml(e.description)}</p>` : ''}
                        ${why ? `<p class="ext-row-err">${escapeHtml(why)}</p>` : ''}
                        ${updatable ? updateButton : ''}
                        ${Array.isArray(e.contributes) && e.contributes.length ? `<div class="ext-row-adds"><i class="fa-solid fa-puzzle-piece"></i><span>Adds ${escapeHtml(e.contributes.map(c => EXT_CONTRIBUTION_LABELS[c] || c).join(', '))}</span></div>` : ''}
                    </div>
                    <div class="ext-row-actions">
                        ${verbs ? `<div class="ext-row-verbs">${verbs}</div>` : ''}
                        <div class="ext-row-side">
                            <label class="ext-row-toggle" title="Runs for your account">
                                <input type="checkbox" class="cl-switch-input" data-ext-enable="${escapeHtml(e.id)}" ${on ? 'checked' : ''} ${e.error ? 'disabled' : ''}>
                                <span class="cl-switch" aria-hidden="true"></span>
                            </label>
                            <button type="button" class="glass-btn icon-only ext-row-more" data-ext-more="${escapeHtml(e.id)}" aria-expanded="${opened}" aria-label="More about ${escapeHtml(e.name || e.id)}"><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button>
                        </div>
                    </div>
                </div>
                <div class="ext-row-section" data-ext-section="${escapeHtml(e.id)}"></div>
                ${inspecting ? extInspectorHtml(e.id) : ''}
            </div>`;
        };
        body.innerHTML = installed.length ? installed.map(rowHtml).join('')
            : emptyState('fa-puzzle-piece', 'No extensions installed', isAdmin
                ? 'Install one above, or drop a folder into extensions/installed on the server and refresh.'
                : 'An admin installs them on the server; the bundled set below is always here.');
        bundledBody.innerHTML = bundled.length ? bundled.map(rowHtml).join('')
            : emptyState('fa-box-open', 'No bundled extensions', 'This build ships without any.');
        for (const e of data.extensions) {
            // a broken row's section would be the one its id's loaded row registered, drawn twice
            if (e.error || !window.ExtensionHost?.hasSettingsSection?.(e.id)) continue;
            const el = (e.bundled ? bundledBody : body).querySelector(`[data-ext-section="${CSS.escape(e.id)}"]`);
            if (el) window.ExtensionHost.renderSettingsSection(e.id, el);
        }
        if (extFocusUpdate) {
            extFocusUpdate = false;
            body.querySelector('.ext-row.has-update')?.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
        }
        // a switch, an update or a removal changes which sites the Hosted Browser lists
        if (document.getElementById('settingsBrowserSection')?.open) void renderBrowserExtSites(data.extensions);
    }

    document.getElementById('extRefreshBtn')?.addEventListener('click', renderExtensionList);
    // an install (a git url or a zip): the PSA first, since with no permission system the install
    // is the boundary, then the host's verb
    async function installExtension(btn, source, installed = () => {}) {
        const sure = await showConfirm({
            title: 'Install a third-party extension?',
            message: 'Project Σ does not review, check or vouch for extensions. Whatever an extension does is on its author and on whoever installs it, not on Project Σ.',
            content: [
                { type: 'note', tone: 'danger', text: 'An extension is code that runs inside Project Σ with no limits. There is no permission system and no sandbox.' },
                { type: 'text', text: 'Once installed, it can:' },
                { type: 'list', items: [
                    'read, change or delete every character, chat, lorebook and file on this server, for every account',
                    'see the API keys, passwords and logins saved here, and act on the sites the Hosted Browser is signed in to',
                    'reach anything the computer running the server can reach, on its network and on the internet',
                ] },
                { type: 'note', tone: 'warning', text: 'If it has a server part, that part starts at the next server restart, whether or not anyone switches it on, and runs on the server with access to every account.' },
                { type: 'text', text: 'Read its code before installing, even when you trust the author: accounts get taken over and projects change hands.' },
                { type: 'ack', text: 'I understand the risk, and I have checked this extension or accept it on its author\'s word.' },
            ],
            icon: 'fa-solid fa-triangle-exclamation',
            confirmLabel: 'Install', danger: true,
        });
        if (!sure) return;
        // a clone can take minutes: the pressed button says so, and neither source can start a second install meanwhile
        const controls = ['extInstallBtn', 'extInstallFileBtn', 'extGitUrlInput'].map(id => document.getElementById(id)).filter(Boolean);
        const original = btn.innerHTML;
        controls.forEach(el => { el.disabled = true; });
        btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Installing';
        try {
            const out = window.ExtensionHost?.install
                ? await window.ExtensionHost.install(source)
                : { ok: false, error: 'the extension host did not start; reload the page' };
            if (out.ok) {
                installed();
                showToast(`Installed "${out.id}". Enable it below.`, 'success');
                renderExtensionList();
            } else {
                showToast(out.error, 'error');
            }
        } finally {
            controls.forEach(el => { el.disabled = false; });
            btn.innerHTML = original;
        }
    }
    document.getElementById('extInstallBtn')?.addEventListener('click', () => {
        const input = document.getElementById('extGitUrlInput');
        const url = (input?.value || '').trim();
        if (!url) { showToast('Paste a repository url first', 'warning'); return; }
        void installExtension(document.getElementById('extInstallBtn'), url, () => { if (input) input.value = ''; });
    });
    const extFileInput = document.getElementById('extInstallFileInput');
    document.getElementById('extInstallFileBtn')?.addEventListener('click', () => extFileInput?.click());
    extFileInput?.addEventListener('change', () => {
        const file = extFileInput.files?.[0];
        extFileInput.value = '';
        if (file) void installExtension(document.getElementById('extInstallFileBtn'), file);
    });
    // both groups' rows share the panel's two listeners; the install controls carry none of the data attributes they read
    const extPanel = document.querySelector('.settings-panel[data-section="extensions"]');
    extPanel?.addEventListener('change', async (ev) => {
        const id = ev.target?.dataset?.extEnable;
        if (!id) return;
        // the checkbox means "runs for me"; the server keeps the rule and answers the row
        const wantOn = ev.target.checked;
        const toggle = ev.target;
        // an installed extension is someone else's code running as you: switching it on is said plainly first
        if (wantOn && toggle.closest('#extListBody')) {
            const row = extRows.get(id);
            // where its code runs is what the row declares: a page part, a server part, or both
            const where = row?.client || row?.style ? (row?.server ? ' in your browser and on the server, where its server part already runs' : ' in your browser') : row?.server ? ' on the server, where its server part already runs' : '';
            const sure = await showConfirm({
                title: 'Switch on a third-party extension?',
                message: `Switching "${row?.name || id}" on lets it act as you${where}, with everything your account can do: read and change your characters, chats and settings, and use your saved keys and logins. Project Σ does not review extensions and is not responsible for what they do.`,
                icon: 'fa-solid fa-triangle-exclamation',
                confirmLabel: 'Switch On', danger: true,
            });
            if (!sure) { toggle.checked = false; return; }
        }
        toggle.disabled = true;
        const out = window.ExtensionHost?.setEnabled
            ? await window.ExtensionHost.setEnabled(id, wantOn)
            : { ok: false, error: 'the extension host did not start; reload the page' };
        toggle.disabled = false;
        if (!out.ok) {
            toggle.checked = !wantOn;
            showToast(`Could not switch it ${wantOn ? 'on' : 'off'}: ${out.error}`, 'error');
            return;
        }
        if (!wantOn) extInspectOpen.delete(id);
        // its server half follows the switch at once: routes, store hooks and listeners
        const hasTabPart = !!(out.row.client || out.row.style);
        showToast(!wantOn ? 'Extension switched off.'
            : out.loaded || !hasTabPart ? 'Extension switched on.'
                : 'Switched on; it loads on the next reload.', wantOn && (out.loaded || !hasTabPart) ? 'success' : 'info');
        renderExtensionList();
    });
    extPanel?.addEventListener('click', async (ev) => {
        const upd = ev.target.closest?.('[data-ext-update]')?.dataset.extUpdate;
        const rem = ev.target.closest?.('[data-ext-remove]')?.dataset.extRemove;
        const rel = ev.target.closest?.('[data-ext-reload]');
        const insp = ev.target.closest?.('[data-ext-inspect]');
        // a phone's row opens on its chevron, or on a tap on its words (never on a control)
        const more = ev.target.closest?.('[data-ext-more]') || (window.isMobileMode?.() && !ev.target.closest?.('a, button, input, label') ? ev.target.closest?.('.ext-row-id') : null);
        if (more) {
            const row = more.closest('.ext-row');
            const key = row?.dataset.extKey;
            if (!row || !key) return;
            const open = !row.classList.contains('is-open');
            if (open) extRowsOpen.add(key); else extRowsOpen.delete(key);
            row.classList.toggle('is-open', open);
            row.querySelector('[data-ext-more]')?.setAttribute('aria-expanded', String(open));
            return;
        }
        if (rel) {
            rel.disabled = true;
            const out = window.ExtensionHost?.reload
                ? await window.ExtensionHost.reload(rel.dataset.extReload)
                : { ok: false, error: 'the extension host did not start; reload the page' };
            rel.disabled = false;
            const server = out.server ? ' Its server part keeps the code the server started with: restart the server for changes to it.' : '';
            showToast(!out.ok ? `Could not reload it: ${out.error}`
                : out.error ? `Reloaded, and it failed to load: ${out.error}`
                    : `${out.loaded ? 'Reloaded.' : 'Reloaded; it loads when switched on.'}${server}`,
            !out.ok || out.error ? 'error' : 'success');
            renderExtensionList();
            return;
        }
        if (insp) {
            // toggled in place: the list redraw would re-read the inventory for nothing
            const id = insp.dataset.extInspect;
            const row = insp.closest('.ext-row');
            const open = !extInspectOpen.has(id);
            if (open) extInspectOpen.add(id); else extInspectOpen.delete(id);
            row?.querySelector('.ext-row-inspect')?.remove();
            if (open) row?.insertAdjacentHTML('beforeend', extInspectorHtml(id));
            insp.classList.toggle('is-active', open);
            insp.setAttribute('aria-expanded', String(open));
            return;
        }
        if (upd) {
            // an update is new code from the repository, said before it lands
            const row = extRows.get(upd);
            const next = extUpdateOf(upd);
            const at = (version, commit) => [version ? `v${version}` : '', commit ? `commit ${commit}` : ''].filter(Boolean).join(', ');
            const versions = [{ key: 'Installed', value: at(row?.version, next?.commit) }, { key: 'Update', value: at(next?.nextVersion, next?.nextCommit) || 'the latest in its repository' }].filter(v => v.value);
            const sure = await showConfirm({
                title: `Update "${row?.name || upd}"?`,
                message: 'An update replaces this extension\'s code with whatever its author published, and new code can do things the old code never did.',
                content: [
                    { type: 'kv', items: versions },
                    { type: 'note', tone: 'warning', text: 'Check what changed in its repository between these two before updating if you can, even for an author you trust: an account taken over or a project handed on can ship harmful code in an update.' },
                ],
                icon: 'fa-solid fa-triangle-exclamation',
                confirmLabel: 'Update', danger: true,
            });
            if (!sure) return;
            // an update reaches the repository and can take a while: the button holds until it answers
            const btn = ev.target.closest('[data-ext-update]');
            const original = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>';
            try {
                const out = await readAnswer(await apiRequest(`/extensions/${encodeURIComponent(upd)}/update`, 'POST'));
                const to = out?.to?.version ? ` to v${out.to.version}` : '';
                // the row claims nothing about its update until the check is read again on the update's record
                if (out?.updated && extUpdates) extUpdates = { ...extUpdates, extensions: extUpdates.extensions.filter(x => x.id !== upd) };
                if (out?.updated === false) showToast('Already on the latest version', 'info');
                else {
                    // this tab runs the new code at once, the reload verb's way; another tab picks it up on its next load
                    const ran = window.ExtensionHost?.reload ? await window.ExtensionHost.reload(upd) : null;
                    const server = out?.restart ? ' Its server part runs the new code after a server restart.' : '';
                    if (ran?.ok && ran.error) showToast(`Updated${to}, and it failed to load: ${ran.error}`, 'error');
                    else showToast(`Updated${to}.${ran?.ok ? '' : ' Reload the page to use it.'}${server}`, 'success');
                }
                renderExtensionList();
            } catch (e) {
                showToast(`Update failed: ${e.message}`, 'error');
            } finally {
                btn.disabled = false;
                btn.innerHTML = original;
            }
        } else if (rem) {
            const sure = await showConfirm({
                title: 'Remove extension?',
                message: `"${extRows.get(rem)?.name || rem}" is deleted from the server for every account.`,
                confirmLabel: 'Remove', danger: true,
            });
            if (!sure) return;
            const btn = ev.target.closest('[data-ext-remove]');
            btn.disabled = true;
            try {
                await removeExtensionNow(rem);
                extInspectOpen.delete(rem);
                renderExtensionList();
            } catch (e) {
                showToast(`Remove failed: ${e.message}`, 'error');
            } finally {
                btn.disabled = false;
            }
        }
    });

    // Chat panel (Settings > Chat): personas; the chat's other settings live in the conversation,
    // where a change shows while you make it
    let personaEditingId = null;
    // the open editor: a refresh of the list keeps a touched one and opens an untouched one again on the fresh row
    let personaEditor = null;
    let personaRenderSeq = 0;
    let personaRenderShown = 0;
    const personaEditorState = (editor) => JSON.stringify([editor.querySelector('.persona-edit-name').value,
        editor.querySelector('.persona-edit-desc').value, window.Personas.readPronouns(editor)]);

    function restorePersonaEditor(list, personas) {
        if (!personaEditor) return;
        const fresh = personas && personaEditingId ? personas.find(p => p.id === personaEditingId) : null;
        if (personas && personaEditingId && !fresh) { personaEditor = null; return; }
        if (fresh && personaEditorState(personaEditor) === personaEditor.dataset.opened) { openPersonaEditor(fresh, { focus: false }); return; }
        const row = fresh ? list.querySelector(`.persona-row[data-id="${CSS.escape(fresh.id)}"]`) : null;
        if (row) row.insertAdjacentElement('afterend', personaEditor);
        else list.appendChild(personaEditor);
    }

    async function initChatPanel() {
        await renderPersonaList();
    }

    async function renderPersonaList() {
        const list = document.getElementById('personaList');
        if (!list) return;
        const seq = ++personaRenderSeq;
        let data = null;
        try {
            const resp = await apiRequest('/personas', 'GET');
            if (resp.ok) data = await resp.json();
        } catch { /* falls through to the unread state */ }
        // a read older than the one on screen is dropped, never drawn over it
        if (seq < personaRenderShown) return;
        personaRenderShown = seq;
        // Unread is not empty: the "no personas yet" copy after a failed fetch would invite a duplicate.
        if (!data) {
            list.innerHTML = '<div class="persona-empty">Could not load personas. Check the server and reopen this panel.</div>';
            restorePersonaEditor(list);
            return;
        }
        const { personas, activeId } = data;
        if (!personas.length) {
            list.innerHTML = '<div class="persona-empty">No personas yet. Without one the character sees a plain name and no description.</div>';
            restorePersonaEditor(list, []);
            return;
        }
        list.innerHTML = personas.map(p => `
            <div class="persona-row${p.id === activeId ? ' active' : ''}" data-id="${escapeHtml(p.id)}">
                <button class="persona-select" title="${p.id === activeId ? 'Active persona' : 'Make active'}" aria-label="${p.id === activeId ? 'Active persona' : 'Make active'}">
                    <i class="fa-${p.id === activeId ? 'solid' : 'regular'} ${p.id === activeId ? 'fa-circle-check' : 'fa-circle'}"></i>
                </button>
                <div class="persona-main">
                    <div class="persona-name">${escapeHtml(p.name)}</div>
                    <div class="persona-desc">${p.description ? escapeHtml(p.description.slice(0, 120)) : 'No description'}</div>
                </div>
                <button class="settings-action-btn persona-edit" aria-label="Edit persona"><i class="fa-solid fa-pen"></i></button>
            </div>`).join('');

        list.querySelectorAll('.persona-select').forEach(btn => btn.addEventListener('click', async () => {
            const id = btn.closest('.persona-row')?.dataset.id;
            if (!id || id === activeId) return;
            if (await window.Personas.setActive(id)) await renderPersonaList();
        }));
        list.querySelectorAll('.persona-edit').forEach(btn => btn.addEventListener('click', () => {
            const id = btn.closest('.persona-row')?.dataset.id;
            openPersonaEditor(personas.find(p => p.id === id) || null);
        }));
        restorePersonaEditor(list, personas);
    }

    function openPersonaEditor(persona, { focus = true } = {}) {
        personaEditingId = persona?.id || null;
        const list = document.getElementById('personaList');
        if (!list) return;
        list.querySelector('.persona-editor')?.remove();
        const editor = document.createElement('div');
        editor.className = 'persona-editor';
        editor.innerHTML = `
            <input type="search" class="glass-input persona-edit-name" placeholder="Name" autocomplete="off">
            <textarea class="glass-input persona-edit-desc" rows="3" placeholder="How the character should see you"></textarea>
            ${window.Personas.pronounsHtml(persona || { id: 'new' }, 'settingsPersona')}
            <div class="persona-editor-actions">
                <button class="settings-action-btn persona-save"><i class="fa-solid fa-check"></i> Save</button>
                <button class="settings-action-btn persona-cancel">Cancel</button>
                ${persona ? '<button class="settings-action-btn danger-hover persona-delete" aria-label="Delete persona"><i class="fa-solid fa-trash"></i></button>' : ''}
            </div>`;
        // value is assigned, never interpolated: a persona description is free text, not markup.
        editor.querySelector('.persona-edit-name').value = persona?.name || '';
        editor.querySelector('.persona-edit-desc').value = persona?.description || '';
        const row = persona ? list.querySelector(`.persona-row[data-id="${CSS.escape(persona.id)}"]`) : null;
        if (row) row.insertAdjacentElement('afterend', editor);
        else list.appendChild(editor);
        personaEditor = editor;
        editor.dataset.opened = personaEditorState(editor);
        if (focus) editor.querySelector('.persona-edit-name').focus();

        editor.querySelector('.persona-cancel').addEventListener('click', () => { personaEditingId = null; personaEditor = null; editor.remove(); });
        // the pronouns block answers its own presses and typing, as in the Personas window
        editor.addEventListener('click', (e) => { const btn = e.target.closest('[data-cpp-act="pronoun-preset"]'); if (btn) window.Personas.applyPronounPreset(btn); });
        editor.addEventListener('input', (e) => { if (e.target.matches?.('[data-cpp-pronoun]')) window.Personas.syncPronounPreset(e.target); });
        // the personas panel's own verbs (modules/personas.js): one set of writes for both surfaces
        editor.querySelector('.persona-save').addEventListener('click', async () => {
            const name = editor.querySelector('.persona-edit-name').value;
            const description = editor.querySelector('.persona-edit-desc').value;
            const pronouns = window.Personas.readPronouns(editor);
            if (!(await window.Personas.write(personaEditingId, { name, description, pronouns }))) return;
            personaEditingId = null;
            personaEditor = null;
            await renderPersonaList();
        });
        editor.querySelector('.persona-delete')?.addEventListener('click', async () => {
            if (!personaEditingId || !(await window.Personas.remove(persona))) return;
            personaEditingId = null;
            personaEditor = null;
            await renderPersonaList();
        });
    }

    // read on every open: an extension switched on since adds a kind
    async function initLlmProfilesPanel() {
        try {
            const resp = await apiRequest('/llm/kinds', 'GET');
            if (resp.ok) llmKinds = await resp.json();
        } catch { /* the kinds read last stand */ }
        await renderLlmProfilesList();
    }

    // One glyph per row, from the same derivation the editor's readiness line shows.
    function llmStateGlyph(p) {
        const r = window.ConnectionEditor?.readinessOf?.({ baseUrl: p.baseUrl, model: p.model }, { kindMeta: llmKinds.find(k => k.kind === p.kind) || null, hasKey: p.hasKey });
        if (!r) return '';
        const missing = [r.endpoint === 'missing' && 'endpoint', r.key === 'missing' && 'key', r.model === 'missing' && 'model'].filter(Boolean);
        if (!missing.length) return '<span class="llm-profile-state is-ready" title="Endpoint, key and model set"><i class="fa-solid fa-circle-check"></i></span>';
        return `<span class="llm-profile-state is-partial" title="No ${escapeHtml(missing.join(', no '))}"><i class="fa-solid fa-circle-exclamation"></i></span>`;
    }

    async function renderLlmProfilesList() {
        const list = llmEl('llmProfilesList');
        if (!list) return;
        let profiles = null;
        try {
            const resp = await apiRequest('/llm/profiles', 'GET');
            const body = resp.ok ? await resp.json() : null;
            if (Array.isArray(body)) profiles = body;
        } catch { /* falls through to the unread state */ }
        // Unread is not empty: the empty copy would invite a duplicate of a profile the server has.
        if (!profiles) {
            list.innerHTML = '<div class="llm-profiles-empty">Could not load the profiles. Check the server and reopen this panel.</div>';
            return;
        }
        if (!profiles.length) {
            list.innerHTML = '<div class="llm-profiles-empty">No profiles yet. The AI features need at least one endpoint.</div>';
            return;
        }
        const kindName = (k) => llmKinds.find(x => x.kind === k)?.displayName || k;
        list.innerHTML = profiles.map(p => `
            <div class="llm-profile-row${p.id === llmEditor?.profile?.id ? ' is-editing' : ''}" data-id="${escapeHtml(p.id)}">
                ${llmStateGlyph(p)}
                <span class="llm-profile-name">${escapeHtml(p.name)}</span>
                <span class="llm-profile-meta">${escapeHtml(kindName(p.kind))}${p.model ? ` · ${escapeHtml(p.model)}` : ''}</span>
                <button class="settings-action-btn llm-profile-edit"><i class="fa-solid fa-pen"></i> Edit</button>
            </div>`).join('');
        list.querySelectorAll('.llm-profile-edit').forEach(btn => btn.addEventListener('click', () => {
            const id = btn.closest('.llm-profile-row')?.dataset.id;
            const profile = profiles.find(p => p.id === id);
            if (profile) openLlmEditor(profile);
        }));
    }

    function openLlmEditor(profile) {
        const host = llmEl('llmProfileEditorHost');
        const mount = window.ConnectionEditor?.mount;
        if (!host || !mount) { showToast('The connection editor is not loaded yet', 'error'); return; }
        llmEditor?.destroy();
        llmEditor = mount(host, {
            profile, kinds: llmKinds,
            onSaved: () => renderLlmProfilesList(),
            onClosed: () => { llmEditor = null; renderLlmProfilesList(); },
            onDeleted: () => { llmEditor = null; renderLlmProfilesList(); },
            onDuplicated: async (made) => { await renderLlmProfilesList(); openLlmEditor(made); },
        });
        renderLlmProfilesList();
        host.scrollIntoView({ block: 'nearest' });
    }

    // straight to the editor: its name field is where the name goes
    on('llmProfileAddBtn', 'click', async () => {
        try {
            const resp = await apiRequest('/llm/profiles', 'POST', { name: 'New profile', kind: llmKinds[0]?.kind || 'openai' });
            const made = await resp.json().catch(() => null);
            if (!resp.ok) { showToast(made?.error || 'Could not create the profile', 'error'); return; }
            await renderLlmProfilesList();
            openLlmEditor(made);
        } catch { showToast('Could not create the profile', 'error'); }
    });

    on('personaAddBtn', 'click', () => openPersonaEditor(null));

    // Settings search/filter
    const settingsSearchInput = document.getElementById('settingsSearchInput');
    if (settingsSearchInput) {
        const layout = settingsModal.querySelector('.settings-layout');
        settingsSearchInput.addEventListener('input', () => {
            const q = settingsSearchInput.value.trim().toLowerCase();
            if (!q) {
                layout.classList.remove('settings-search-active');
                clearHighlights(settingsModal);
                const activeNav = settingsModal.querySelector('.settings-nav-item.active');
                if (activeNav) switchSettingsSection(activeNav.dataset.section);
                settingsModal.querySelectorAll('.settings-search-hidden').forEach(el => el.classList.remove('settings-search-hidden'));
                settingsModal.querySelectorAll('.settings-search-force-show').forEach(el => {
                    el.classList.remove('settings-search-force-show');
                    el.hidden = true;
                });
                return;
            }
            layout.classList.add('settings-search-active');
            // every view's defaults take part in a search, the tabs aside; the clear above hides them again
            settingsModal.querySelectorAll('.settings-view-panel[hidden]').forEach(p => {
                p.hidden = false;
                p.classList.add('settings-search-force-show');
            });

            settingsModal.querySelectorAll('.settings-group, details.settings-provider-section').forEach(group => {
                const titleEl = group.querySelector('.settings-group-title, summary');
                const titleText = titleEl ? titleEl.textContent.toLowerCase() : '';
                const titleMatch = titleText.includes(q);

                const rows = group.querySelectorAll('.settings-row');
                let anyRowVisible = false;
                rows.forEach(row => {
                    const text = row.textContent.toLowerCase();
                    const match = text.includes(q) || titleMatch;
                    row.classList.toggle('settings-search-hidden', !match);
                    // Force-show sub-option rows their setting hides
                    if (match && row.hidden) {
                        row.hidden = false;
                        row.classList.add('settings-search-force-show');
                    } else if (!match && row.classList.contains('settings-search-force-show')) {
                        row.classList.remove('settings-search-force-show');
                        row.hidden = true;
                    }
                    if (match) anyRowVisible = true;
                });

                // a list's items (personas, profiles, extension rows, the migration steps) are no .settings-row
                const bodyMatch = !anyRowVisible && !titleMatch && group.textContent.toLowerCase().includes(q);
                group.classList.toggle('settings-search-hidden', !anyRowVisible && !titleMatch && !bodyMatch);
            });
            settingsModal.querySelectorAll('.settings-view-panel').forEach(p => p.classList.toggle('settings-search-hidden', !p.querySelector('.settings-row:not(.settings-search-hidden)')));

            highlightText(settingsModal.querySelector('.settings-content'), q);
        });
    }
    
    const closeModal = () => settingsModal.classList.remove('visible');

    // Resolves true once closed; pending edits ask first and Keep Editing leaves it open. A discard
    // puts the page back on the stored values.
    async function closeSettingsDialog() {
        if (!settingsModal.classList.contains('visible')) return true;
        const unsaved = unsavedSettings();
        if (Object.keys(unsaved).length) {
            const ok = await showConfirm({
                title: 'Discard unsaved edits?',
                message: 'Some settings changed here have not been saved. Discard them?',
                confirmLabel: 'Discard',
                cancelLabel: 'Keep Editing',
                danger: true,
            });
            if (!ok) return false;
            applySettingsToPage(new Set(Object.keys(unsaved)));
        }
        closeModal();
        return true;
    }
    window.closeSettingsDialog = closeSettingsDialog;
    // back, Escape and the header's arrow leave a phone's section page for the list first
    const backOrClose = () => {
        if (onPhoneSection()) { setPhonePage('list'); return Promise.resolve(false); }
        return closeSettingsDialog();
    };
    window.registerOverlay?.({ id: 'gallerySettingsModal', tier: 7, close: backOrClose });
    closeSettingsModal.onclick = () => backOrClose();
    settingsModal.onclick = (e) => {
        if (e.target === settingsModal) closeSettingsDialog();
    };

    wireSecretToggle(toggleTokenVisibility, chubTokenInput);
    wireSecretToggle(togglePygmalionPasswordVisibility, pygmalionPasswordInput);
    wireSecretToggle(toggleWyvernPasswordVisibility, wyvernPasswordInput);
    wireSecretToggle(toggleDatacatTokenVisibility, datacatTokenInput);

    const formatMinScore = (val) => parseInt(val) >= 120 ? 'Exact' : val;
    minScoreSlider.oninput = () => {
        minScoreValue.textContent = formatMinScore(minScoreSlider.value);
    };
    if (possibleMatchScoreSlider) {
        possibleMatchScoreSlider.oninput = () => {
            if (possibleMatchScoreValue) possibleMatchScoreValue.textContent = possibleMatchScoreSlider.value;
        };
    }
    
    if (highlightColorInput) {
        highlightColorInput.oninput = () => {
            applyHighlightColor(highlightColorInput.value);
        };
    }

    const resetAccentBtn = document.getElementById('resetAccentColor');
    if (resetAccentBtn) {
        resetAccentBtn.addEventListener('click', () => {
            const def = DEFAULT_SETTINGS.highlightColor;
            if (highlightColorInput) highlightColorInput.value = def;
            applyHighlightColor(def);
        });
    }


    // Mobile layout override: per-device (localStorage, not settings, so a desktop and an iPad on one
    // account can differ), applied live.
    if (mobileModeSelect) {
        mobileModeSelect.addEventListener('change', () => {
            const v = mobileModeSelect.value;
            // Session copy applies even when persistence fails (private mode), so the select never lies.
            window.clMobileModeOverrideMem = (v === 'mobile' || v === 'desktop') ? v : null;
            try {
                if (v === 'mobile' || v === 'desktop') localStorage.setItem('clMobileModeOverride', v);
                else localStorage.removeItem('clMobileModeOverride');
            } catch { /* storage blocked: the session copy above still applies */ }
            document.dispatchEvent(new CustomEvent('cl-mobile-override-changed'));
        });
    }

    if (uiScaleSelect) {
        uiScaleSelect.addEventListener('change', () => {
            const level = parseInt(uiScaleSelect.value) || 3;
            setSetting('uiScale', level);
            applyUiScale(level);
            syncXlModalSizeAvailability();
        });
    }

    if (modalSizeSelect) {
        modalSizeSelect.addEventListener('change', () => {
            const level = parseInt(modalSizeSelect.value) || 2;
            setSetting('modalSize', level);
            applyModalSize(level);
        });
    }

    if (resetWindowLayoutsBtn) {
        resetWindowLayoutsBtn.addEventListener('click', () => {
            resetWindowGeometry();
            showToast('Every window is back to its default size and place', 'success');
        });
    }

    if (buttonStyleSelect) {
        buttonStyleSelect.addEventListener('change', () => {
            const style = buttonStyleSelect.value || 'glass';
            setSetting('buttonStyle', style);
            applyButtonStyle(style);
        });
    }

    if (collapseAllBrowseSectionsCheckbox) {
        collapseAllBrowseSectionsCheckbox.addEventListener('change', () => {
            applyCollapseAllBrowseSections(collapseAllBrowseSectionsCheckbox.checked);
        });
    }

    if (animateTagPillsCheckbox && animateKeepNameRow) {
        animateTagPillsCheckbox.addEventListener('change', () => {
            animateKeepNameRow.hidden = !animateTagPillsCheckbox.checked;
        });
    }

    const openThemeCustomizerBtnEl = document.getElementById('openThemeCustomizerBtn');
    if (openThemeCustomizerBtnEl) {
        openThemeCustomizerBtnEl.addEventListener('click', () => openThemeCustomizer());
    }
    // the customizer saves its own accent; an accent input left untouched here follows it
    document.addEventListener('cl-theme-customizer-closed', () => {
        if (!highlightColorInput || !openedSaveModel || highlightColorInput.value !== openedSaveModel.highlightColor) return;
        highlightColorInput.value = getSetting('highlightColor') || DEFAULT_SETTINGS.highlightColor;
        openedSaveModel.highlightColor = highlightColorInput.value;
    });

    const openCustomCssBtnEl = document.getElementById('openCustomCssBtn');
    if (openCustomCssBtnEl) {
        openCustomCssBtnEl.addEventListener('click', () => {
            if (typeof window.openCustomCssModal === 'function') {
                window.openCustomCssModal();
            } else {
                showToast('Custom CSS module not loaded yet, try again in a moment', 'warning');
            }
        });
    }

    // The topbar's session search boxes and every view's session controls start from the saved
    // defaults, so a save or restore puts them back in line.
    function syncTopbarSearchToSettings() {
        for (const [id, key] of [
            ['searchName', 'searchInName'], ['searchListingName', 'searchInListingName'], ['searchTags', 'searchInTags'],
            ['searchAuthor', 'searchInAuthor'], ['searchNotes', 'searchInNotes'], ['searchTagline', 'searchInTagline'],
            ['searchDesc', 'searchInDescription'], ['searchFirstMessage', 'searchInFirstMessage'], ['searchAltGreetings', 'searchInAltGreetings'],
        ]) {
            const el = document.getElementById(id);
            if (el) el.checked = !!getSetting(key);
        }
        applyViewDefaults();
    }

    // What the Save-model inputs say now. UI Scale, modal size and button style are not in it: they
    // write the moment they change.
    function readSaveModel() {
        return {
            chubToken: chubTokenInput.value || null,
            pygmalionEmail: pygmalionEmailInput ? (pygmalionEmailInput.value || null) : null,
            pygmalionPassword: pygmalionPasswordInput ? (pygmalionPasswordInput.value || null) : null,
            pygmalionRememberCredentials: pygmalionRememberCredsCheckbox ? pygmalionRememberCredsCheckbox.checked : false,
            botbooruUsername: botbooruUsernameInput ? (botbooruUsernameInput.value || null) : null,
            botbooruPassword: botbooruPasswordInput ? (botbooruPasswordInput.value || null) : null,
            ctCookie: ctCookieInput ? (ctCookieInput.value?.trim() || null) : null,
            ctAutoKeepAlive: ctAutoKeepAliveCheckbox ? ctAutoKeepAliveCheckbox.checked : true,
            wyvernEmail: wyvernEmailInput ? (wyvernEmailInput.value || null) : null,
            wyvernPassword: wyvernPasswordInput ? (wyvernPasswordInput.value || null) : null,
            duplicateMinScore: parseInt(minScoreSlider.value),
            possibleMatchMinScore: possibleMatchScoreSlider ? parseInt(possibleMatchScoreSlider.value) : getDefaultSetting('possibleMatchMinScore'),
            importDirectDownloads: importDirectDownloadsCheckbox ? importDirectDownloadsCheckbox.checked : false,
            searchInName: searchNameCheckbox.checked,
            searchInListingName: searchListingNameCheckbox ? searchListingNameCheckbox.checked : true,
            searchInTags: searchTagsCheckbox.checked,
            searchInAuthor: searchAuthorCheckbox.checked,
            searchInNotes: searchNotesCheckbox.checked,
            searchInTagline: searchTaglineCheckbox ? searchTaglineCheckbox.checked : false,
            searchInDescription: searchDescriptionCheckbox ? searchDescriptionCheckbox.checked : false,
            searchInFirstMessage: searchFirstMessageCheckbox ? searchFirstMessageCheckbox.checked : false,
            searchInAltGreetings: searchAltGreetingsCheckbox ? searchAltGreetingsCheckbox.checked : false,
            paletteSearchCards: paletteSearchCardsCheckbox ? paletteSearchCardsCheckbox.checked : true,
            paletteSearchMessages: paletteSearchMessagesCheckbox ? paletteSearchMessagesCheckbox.checked : true,
            paletteSearchLore: paletteSearchLoreCheckbox ? paletteSearchLoreCheckbox.checked : true,
            ...readViewSettingsFromUI(),
            richCreatorNotes: richCreatorNotesCheckbox.checked,
            expandCreatorNotes: expandCreatorNotesCheckbox ? expandCreatorNotesCheckbox.checked : false,
            displayNamePreference: displayNamePreferenceSelect ? displayNamePreferenceSelect.value : 'card',
            showNameToggle: showNameToggleCheckbox ? showNameToggleCheckbox.checked : true,
            highlightColor: highlightColorInput ? highlightColorInput.value : DEFAULT_SETTINGS.highlightColor,
            mediaLocalizationEnabled: mediaLocalizationCheckbox ? mediaLocalizationCheckbox.checked : false,
            includeProviderGallery: includeProviderGalleryCheckbox ? includeProviderGalleryCheckbox.checked : false,
            includeLorebook: includeLorebookCheckbox ? includeLorebookCheckbox.checked : false,
            fastFilenameSkip: fastFilenameSkipCheckbox ? fastFilenameSkipCheckbox.checked : false,
            backgroundImports: backgroundImportsCheckbox ? backgroundImportsCheckbox.checked : true,
            importMediaAction: importMediaActionSelect ? (importMediaActionSelect.value || 'background') : 'background',
            includeExternalGalleries: includeExternalGalleriesCheckbox ? includeExternalGalleriesCheckbox.checked : true,
            debugMode: debugModeCheckbox ? debugModeCheckbox.checked : false,
            showInfoTab: showInfoTabCheckbox ? showInfoTabCheckbox.checked : false,
            exportAsLinks: exportAsLinksCheckbox ? exportAsLinksCheckbox.checked : false,
            exportFormat: exportFormatSelect ? (exportFormatSelect.value || 'png') : 'png',
            showProviderTagline: showProviderTaglineCheckbox ? showProviderTaglineCheckbox.checked : true,
            allowRichTagline: allowRichTaglineCheckbox ? allowRichTaglineCheckbox.checked : false,
            browseSnapSections: browseSnapSectionsCheckbox ? browseSnapSectionsCheckbox.checked : false,
            collapseAllBrowseSections: collapseAllBrowseSectionsCheckbox ? collapseAllBrowseSectionsCheckbox.checked : false,
            mobileProviderQuickSwitch: mobileProviderQuickSwitchCheckbox ? mobileProviderQuickSwitchCheckbox.checked : true,
            mobileHideBackArrows: mobileHideBackArrowsCheckbox ? mobileHideBackArrowsCheckbox.checked : false,
            mobileBrowseQuickImport: mobileBrowseQuickImportCheckbox ? mobileBrowseQuickImportCheckbox.checked : true,
            mobileSwipeGestures: mobileSwipeGesturesCheckbox ? mobileSwipeGesturesCheckbox.checked : true,
            mobileHaptics: mobileHapticsCheckbox ? mobileHapticsCheckbox.checked : true,
            animateTagPills: animateTagPillsCheckbox ? animateTagPillsCheckbox.checked : false,
            animateKeepName: animateKeepNameCheckbox ? animateKeepNameCheckbox.checked : false,
            hidePlaylistBadges: hidePlaylistBadgesCheckbox ? hidePlaylistBadgesCheckbox.checked : false,
            enableCharDetailNav: enableCharDetailNavCheckbox ? enableCharDetailNavCheckbox.checked : true,
            chubUseV4Api: chubUseV4ApiCheckbox ? chubUseV4ApiCheckbox.checked : false,
            chubTimelineJoined: chubTimelineJoinedCheckbox ? chubTimelineJoinedCheckbox.checked : false,
            autoSnapshotOnEdit: autoSnapshotOnEditCheckbox ? autoSnapshotOnEditCheckbox.checked : false,
            backupFrequency: backupFrequencySelect ? backupFrequencySelect.value : 'off',
            backupWindowStart: backupWindowStartSelect ? Number(backupWindowStartSelect.value) : getDefaultSetting('backupWindowStart'),
            backupWindowEnd: backupWindowEndSelect ? Number(backupWindowEndSelect.value) : getDefaultSetting('backupWindowEnd'),
            autoTidySearchIndex: autoTidySearchIndexCheckbox ? autoTidySearchIndexCheckbox.checked : true,
            preloadLibrary: preloadLibraryCheckbox ? preloadLibraryCheckbox.checked : true,
            notifyExtensionUpdates: extNotifyUpdatesCheckbox ? extNotifyUpdatesCheckbox.checked : false,
            ...readHistoryCountsFromUI(),
            ...readProviderOrderFromUI(),
            infiniteScroll: readInfiniteScrollFromUI(),
        };
    }
    // the Save model as the dialog opened, the baseline for a dirty-only save and for the close's ask
    let openedSaveModel = null;
    const unsavedSettings = () => (openedSaveModel ? settingsSaveDiff(openedSaveModel, readSaveModel(), getSetting) : {});

    // a list filled after the baseline was taken folds what it shows into it, so picking (None) then is a move
    function fillViewDefault(entry) {
        return fillViewDefaultControl(entry, document.getElementById(entry.id), getSetting(entry.key)).then((shown) => {
            if (openedSaveModel) openedSaveModel[entry.key] = shown;
        });
    }

    function fillViewSettings() {
        showViewDefaultsTab(fillStartView(startViewSelect, startViewNote, getSetting('startView')));
        return Promise.all(viewDefaultEntries().map(fillViewDefault));
    }

    const doSaveSettings = async () => {
        const changed = unsavedSettings();
        if (Object.keys(changed).length) {
            setSettings(changed);
            // a refused save is said by settingsSaveFailed, and the dialog stays open on the edits
            if (!(await flushSettings())) return;
        }

        clearAllMediaLocalizationCache();

        // the page follows what moved, from the stored values
        applySettingsToPage(new Set(Object.keys(changed)));

        updateCharModalNavState();

        syncImportAutoDownloadGallery();
        syncImportAutoDownloadMedia();
        
        syncTopbarSearchToSettings();
        
        showToast('Settings saved', 'success');
        closeModal();
        
        performSearch();

        // Rebuild provider selector to reflect new order
        providerSelectorInitialized = false;
        const selectorArea = document.getElementById('providerSelectorArea');
        if (selectorArea) {
            selectorArea.querySelector('select')?._customSelect?.destroy();
            selectorArea.innerHTML = '';
        }
        if (currentView === 'online') {
            activateOnlineProvider(null);
        }
        // Re-grade possible-match badges so a changed sensitivity threshold shows immediately.
        window.ProviderRegistry?.refreshActiveBrowseBadges?.();
    };
    
    // a second press while a save is out would find nothing unsaved and say saved before the server answered
    let saveInFlight = null;
    saveSettingsBtn.onclick = () => {
        if (saveInFlight) return;
        saveSettingsBtn.disabled = true;
        saveInFlight = doSaveSettings().finally(() => {
            saveInFlight = null;
            saveSettingsBtn.disabled = false;
        });
    };
    
    // Restore defaults - resets to default values AND saves them
    resetSettingsBtn.onclick = async () => {
        // authored data rides the defaults too, most of it written outside this dialog, so the
        // confirm names every piece it would clear
        const cleared = authoredSettingsCleared(getSetting, DEFAULT_SETTINGS);
        const sure = await showConfirm({
            title: 'Restore default settings?',
            content: [
                { type: 'text', text: cleared.length ? 'Every setting goes back to its default. This also clears:' : 'Every setting goes back to its default. Nothing you wrote is cleared.' },
                ...(cleared.length ? [{ type: 'list', items: cleared }] : []),
                { type: 'note', text: 'Saved logins and tokens are kept (Pygmalion\'s while its Remember switch is on), and which extensions are on stays as it is.' },
            ],
            icon: 'fa-solid fa-triangle-exclamation',
            confirmLabel: 'Restore defaults',
            danger: true,
        });
        if (!sure) return;

        clearAllMediaLocalizationCache();

        const preservePyg = getSetting('pygmalionRememberCredentials');
        setSettings({
            ...DEFAULT_SETTINGS,
            chubToken: getSetting('chubToken') || null,
            pygmalionEmail: preservePyg ? getSetting('pygmalionEmail') : null,
            pygmalionPassword: preservePyg ? getSetting('pygmalionPassword') : null,
            pygmalionToken: preservePyg ? getSetting('pygmalionToken') : null,
            wyvernEmail: getSetting('wyvernEmail') || null,
            wyvernPassword: getSetting('wyvernPassword') || null,
            wyvernToken: getSetting('wyvernToken') || null,
            wyvernRefreshToken: getSetting('wyvernRefreshToken') || null,
            wyvernUid: getSetting('wyvernUid') || null,
            datacatToken: getSetting('datacatToken') || null,
            datacatJanitoraiToken: getSetting('datacatJanitoraiToken') || null,
            datacatJanitoraiRefreshToken: getSetting('datacatJanitoraiRefreshToken') || null,
            ctCookie: getSetting('ctCookie') || null,
            janitoraiToken: getSetting('janitoraiToken') || null,
            janitoraiRefreshToken: getSetting('janitoraiRefreshToken') || null,
            janitoraiEmail: getSetting('janitoraiEmail') || null,
            janitoraiPassword: getSetting('janitoraiPassword') || null,
            botbooruToken: getSetting('botbooruToken') || null,
            botbooruUsername: getSetting('botbooruUsername') || null,
            botbooruPassword: getSetting('botbooruPassword') || null,
            civitaiApiKey: getSetting('civitaiApiKey') || null,
            pixivCookie: getSetting('pixivCookie') || null,
        });
        // re-running the open handler resets every input from settings; a hand-written reset list forgot
        // the ones added later
        settingsBtn.onclick();
        // the feed skips this tab's own records, so the page is put in line here, every open window back
        // to its shipped place
        applySettingsToPage();
        resetWindowGeometry();
        
        syncTopbarSearchToSettings();
        performSearch();
        
        showToast('Settings restored to defaults', 'success');
    };

    // Session Validation - CharacterTavern
    wireSecretToggle(document.getElementById('toggleCtCookieVisibility'), ctCookieInput);

    // Passive expiry timer for CT's sliding session: window.ctSessionInfo makes no CT request, so
    // showing the timer never slides the window.
    async function renderCtSessionTimer() {
        const el = document.getElementById('ctSessionTimer');
        if (!el) return;
        if (!getSetting('ctCookie') || !window.ctSessionInfo) { el.hidden = true; return; }
        let info = null;
        try { info = await window.ctSessionInfo(); } catch { /* leave hidden */ }
        if (!info?.active) { el.hidden = true; return; }
        el.hidden = false;
        if (!info.expires) {
            el.innerHTML = '<i class="fa-solid fa-circle-check text-success-bright"></i> Session active - expiry known after the first request';
            return;
        }
        const msLeft = info.expires - Date.now();
        if (msLeft <= 0) {
            el.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-error-bright"></i> Session expired - open CharacterTavern or re-paste your cookie';
            return;
        }
        const days = Math.floor(msLeft / 86400000);
        const hours = Math.floor((msLeft % 86400000) / 3600000);
        const left = days >= 1 ? `${days}d ${hours}h` : `${hours}h`;
        const date = new Date(info.expires).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        el.innerHTML = `<i class="fa-solid fa-circle-check text-success-bright"></i> Session active - expires ${date} (${left} left)`;
    }

    const validateCtCookieBtn = document.getElementById('validateCtCookieBtn');
    if (validateCtCookieBtn && ctCookieInput) {
        validateCtCookieBtn.onclick = async (e) => {
            e.preventDefault();
            validateCtCookieBtn.classList.remove('success', 'error');
            const originalHtml = '<i class="fa-solid fa-check"></i>';
            validateCtCookieBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            validateCtCookieBtn.disabled = true;

            try {
                if (!window.ctValidateSession) {
                    showToast('Validation module not ready', 'error');
                    throw new Error('Module not ready');
                }
                const result = await window.ctValidateSession(ctCookieInput.value || null);
                validateCtCookieBtn.classList.remove('success', 'error');

                renderCtSessionTimer(); // validate slid the window and refreshed the stored expiry

                if (result.valid) {
                    if (result.hasNsfw === true) {
                        showToast('Session valid, NSFW access confirmed', 'success');
                        validateCtCookieBtn.classList.add('success');
                        validateCtCookieBtn.innerHTML = '<i class="fa-solid fa-check-double"></i>';
                    } else if (result.hasNsfw == null) {
                        showToast('Session valid', 'success');
                        validateCtCookieBtn.classList.add('success');
                        validateCtCookieBtn.innerHTML = '<i class="fa-solid fa-check-double"></i>';
                    } else {
                        showToast('Warning: Session accepted, but NO NSFW access detected.', 'warning');
                        validateCtCookieBtn.classList.add('error');
                        validateCtCookieBtn.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>';
                    }
                } else {
                    showToast(`Session invalid: ${result.reason}`, 'error');
                    validateCtCookieBtn.classList.add('error');
                    validateCtCookieBtn.innerHTML = '<i class="fa-solid fa-times"></i>';
                }
            } catch (err) {
                if (!validateCtCookieBtn.classList.contains('error')) {
                    showToast(`Validation error: ${err.message}`, 'error');
                    validateCtCookieBtn.classList.add('error');
                    validateCtCookieBtn.innerHTML = '<i class="fa-solid fa-exclamation"></i>';
                }
            } finally {
                validateCtCookieBtn.disabled = false;
                if (validateCtCookieBtn.classList.contains('success')) {
                    validateCtCookieBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
                }
                setTimeout(() => {
                    validateCtCookieBtn.classList.remove('success', 'error');
                    validateCtCookieBtn.innerHTML = originalHtml;
                }, 3000);
            }
        };
    }

    // Session Validation - Pygmalion
    const validatePygmalionBtn = document.getElementById('validatePygmalionBtn');
    if (validatePygmalionBtn && pygmalionEmailInput && pygmalionPasswordInput) {
        validatePygmalionBtn.onclick = async (e) => {
            e.preventDefault();
            validatePygmalionBtn.classList.remove('success', 'error');
            const originalHtml = '<i class="fa-solid fa-check"></i>';
            validatePygmalionBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            validatePygmalionBtn.disabled = true;

            try {
                if (!window.pygmalionLoginCheck) {
                    showToast('Login module not ready', 'error');
                    throw new Error('Module not ready');
                }
                
                const email = pygmalionEmailInput.value;
                const password = pygmalionPasswordInput.value;
                if (!email || !password) {
                    showToast('Email and password required', 'warning');
                    validatePygmalionBtn.classList.add('error');
                    return;
                }

                const result = await window.pygmalionLoginCheck(email, password);
                if (result.ok) {
                    showToast('Logged in to Pygmalion', 'success');
                    validatePygmalionBtn.classList.add('success');
                } else {
                    showToast(`Login failed: ${result.error}`, 'error');
                    validatePygmalionBtn.classList.add('error');
                    validatePygmalionBtn.innerHTML = '<i class="fa-solid fa-times"></i>';
                }
            } catch (err) {
                if (!validatePygmalionBtn.classList.contains('error')) {
                    showToast(`Login error: ${err.message}`, 'error');
                    validatePygmalionBtn.classList.add('error');
                    validatePygmalionBtn.innerHTML = '<i class="fa-solid fa-exclamation"></i>';
                }
            } finally {
                validatePygmalionBtn.disabled = false;
                if (validatePygmalionBtn.classList.contains('success')) {
                    validatePygmalionBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
                }
                setTimeout(() => {
                    validatePygmalionBtn.classList.remove('success', 'error');
                    validatePygmalionBtn.innerHTML = originalHtml;
                }, 3000);
            }
        };
    }

    // Session Validation - ChubAI: the token in the field, before or after it is saved
    const validateChubBtn = document.getElementById('validateChubBtn');
    if (validateChubBtn && chubTokenInput) {
        validateChubBtn.onclick = async (e) => {
            e.preventDefault();
            validateChubBtn.classList.remove('success', 'error');
            const originalHtml = '<i class="fa-solid fa-check"></i>';
            validateChubBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            validateChubBtn.disabled = true;
            try {
                if (!window.chubTokenCheck) throw new Error('ChubAI is not loaded yet');
                const result = await window.chubTokenCheck(chubTokenInput.value);
                if (result.ok) {
                    showToast(`Logged in to ChubAI as ${result.name}`, 'success');
                    validateChubBtn.classList.add('success');
                } else {
                    showToast(result.error, 'error');
                    validateChubBtn.classList.add('error');
                    validateChubBtn.innerHTML = '<i class="fa-solid fa-times"></i>';
                }
            } catch (err) {
                showToast(`Could not check the token: ${err.message}`, 'error');
                validateChubBtn.classList.add('error');
                validateChubBtn.innerHTML = '<i class="fa-solid fa-exclamation"></i>';
            } finally {
                validateChubBtn.disabled = false;
                if (validateChubBtn.classList.contains('success')) validateChubBtn.innerHTML = originalHtml;
                setTimeout(() => {
                    validateChubBtn.classList.remove('success', 'error');
                    validateChubBtn.innerHTML = originalHtml;
                }, 3000);
            }
        };
    }

    // Session Validation - Wyvern
    const validateWyvernBtn = document.getElementById('validateWyvernBtn');
    if (validateWyvernBtn && wyvernEmailInput && wyvernPasswordInput) {
        validateWyvernBtn.onclick = async (e) => {
            e.preventDefault();
            validateWyvernBtn.classList.remove('success', 'error');
            const originalHtml = '<i class="fa-solid fa-check"></i>';
            validateWyvernBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            validateWyvernBtn.disabled = true;

            try {
                if (!window.wyvernLoginCheck) {
                    showToast('Login module not ready', 'error');
                    throw new Error('Module not ready');
                }
                
                const email = wyvernEmailInput.value;
                const password = wyvernPasswordInput.value;
                if (!email || !password) {
                    showToast('Email and password required', 'warning');
                    validateWyvernBtn.classList.add('error');
                    return;
                }

                const result = await window.wyvernLoginCheck(email, password);
                if (result.ok) {
                    showToast('Logged in to Wyvern', 'success');
                    validateWyvernBtn.classList.add('success');
                } else {
                    showToast(`Login failed: ${result.error}`, 'error');
                    validateWyvernBtn.classList.add('error');
                    validateWyvernBtn.innerHTML = '<i class="fa-solid fa-times"></i>';
                }
            } catch (err) {
                if (!validateWyvernBtn.classList.contains('error')) {
                    showToast(`Login error: ${err.message}`, 'error');
                    validateWyvernBtn.classList.add('error');
                    validateWyvernBtn.innerHTML = '<i class="fa-solid fa-exclamation"></i>';
                }
            } finally {
                validateWyvernBtn.disabled = false;
                if (validateWyvernBtn.classList.contains('success')) {
                    validateWyvernBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
                }
                setTimeout(() => {
                    validateWyvernBtn.classList.remove('success', 'error');
                    validateWyvernBtn.innerHTML = originalHtml;
                }, 3000);
            }
        };
    }

    // DataCat session management
    function updateDatacatSessionStatus() {
        if (!datacatSessionStatus) return;
        if (!window.datacatValidateSession) {
            datacatSessionStatus.className = 'settings-status-badge inactive';
            datacatSessionStatus.innerHTML = '<i class="fa-solid fa-circle"></i> Module not loaded';
            return;
        }
        window.datacatValidateSession().then(result => {
            if (result.valid) {
                datacatSessionStatus.className = 'settings-status-badge active';
                datacatSessionStatus.innerHTML = '<i class="fa-solid fa-circle"></i> Active';
            } else {
                datacatSessionStatus.className = 'settings-status-badge inactive';
                datacatSessionStatus.innerHTML = `<i class="fa-solid fa-circle"></i> Inactive`;
            }
        });
    }

    // Version display reads the server (the single version source) so it cant drift
    apiRequest('/health', 'GET', null, { cache: 'no-cache' })
        .then(r => r.json())
        .then(health => {
            const el = document.getElementById('clAppVersion');
            if (el && health?.version) el.textContent = `v${health.version}`;
        })
        .catch(() => { /* html fallback text stays */ });
    // The repository row: a link once a public repo exists, the pending hint until then.
    const repoHint = document.getElementById('clRepoHint');
    if (repoHint && PUBLIC_REPO_URL) {
        repoHint.insertAdjacentHTML('beforebegin', `<a href="${escapeHtml(PUBLIC_REPO_URL)}" target="_blank" rel="noopener noreferrer" class="settings-action-btn primary"><i class="fa-brands fa-github"></i> View on GitHub</a>`);
        repoHint.innerHTML = 'If you find Project Σ useful, consider starring the repo <i class="fa-solid fa-star"></i>';
    }

    document.getElementById('datacatRestoreAvatarsBtn')?.addEventListener('click', async () => {
        // Closes settings first: the restore modal opens its own review surface on top.
        if (!window.datacatRestoreAvatars) {
            showToast('DataCat module not ready', 'error');
            return;
        }
        if (!(await closeSettingsDialog())) return;
        window.datacatRestoreAvatars();
    });

    const validateDatacatBtn = document.getElementById('validateDatacatBtn');
    if (validateDatacatBtn) {
        validateDatacatBtn.onclick = async (e) => {
            e.preventDefault();
            validateDatacatBtn.classList.remove('success', 'error');
            const originalHtml = '<i class="fa-solid fa-check"></i>';
            validateDatacatBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            validateDatacatBtn.disabled = true;

            try {
                if (!window.datacatValidateSession) {
                    showToast('DataCat module not ready', 'error');
                    throw new Error('Module not ready');
                }
                const result = await window.datacatValidateSession();
                if (result.valid) {
                    showToast('DataCat session is valid', 'success');
                    validateDatacatBtn.classList.add('success');
                    updateDatacatSessionStatus();
                } else {
                    showToast(`Session invalid: ${result.reason || 'Unknown'}`, 'error');
                    validateDatacatBtn.classList.add('error');
                    validateDatacatBtn.innerHTML = '<i class="fa-solid fa-times"></i>';
                    updateDatacatSessionStatus();
                }
            } catch (err) {
                if (!validateDatacatBtn.classList.contains('error')) {
                    showToast(`Validation error: ${err.message}`, 'error');
                    validateDatacatBtn.classList.add('error');
                    validateDatacatBtn.innerHTML = '<i class="fa-solid fa-exclamation"></i>';
                }
            } finally {
                validateDatacatBtn.disabled = false;
                if (validateDatacatBtn.classList.contains('success')) {
                    validateDatacatBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
                }
                setTimeout(() => {
                    validateDatacatBtn.classList.remove('success', 'error');
                    validateDatacatBtn.innerHTML = originalHtml;
                }, 3000);
            }
        };
    }

    const datacatRefreshTokenBtn = document.getElementById('datacatRefreshTokenBtn');
    if (datacatRefreshTokenBtn) {
        datacatRefreshTokenBtn.onclick = async () => {
            datacatRefreshTokenBtn.disabled = true;
            datacatRefreshTokenBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Requesting...';
            try {
                if (!window.datacatRefreshToken) {
                    showToast('DataCat module not ready', 'error');
                    return;
                }
                const newToken = await window.datacatRefreshToken();
                if (newToken) {
                    setSetting('datacatToken', newToken);
                    if (datacatTokenInput) datacatTokenInput.value = newToken;
                    showToast('New DataCat token obtained', 'success');
                    updateDatacatSessionStatus();
                } else {
                    showToast('Failed to obtain new token', 'error');
                }
            } catch (err) {
                showToast(`Refresh error: ${err.message}`, 'error');
            } finally {
                datacatRefreshTokenBtn.disabled = false;
                datacatRefreshTokenBtn.innerHTML = '<i class="fa-solid fa-rotate"></i> New Token';
            }
        };
    }

    const datacatClearTokenBtn = document.getElementById('datacatClearTokenBtn');
    if (datacatClearTokenBtn) {
        datacatClearTokenBtn.onclick = () => clearServiceCredential(async () => (window.datacatClearSession ? window.datacatClearSession() : true),
            { settingKey: 'datacatToken', input: datacatTokenInput, invalidate: updateDatacatSessionStatus, what: 'DataCat session' });
    }

    // Civitai API Key
    const civitaiApiKeyInputEl = document.getElementById('settingsCivitaiApiKey');
    const toggleCivitaiKeyVisibilityBtn = document.getElementById('toggleCivitaiKeyVisibility');
    const saveCivitaiKeyBtn = document.getElementById('saveCivitaiKeyBtn');
    const clearCivitaiKeyBtn = document.getElementById('clearCivitaiKeyBtn');
    const validateCivitaiKeyBtn = document.getElementById('validateCivitaiKeyBtn');

    wireSecretToggle(toggleCivitaiKeyVisibilityBtn, civitaiApiKeyInputEl);

    if (saveCivitaiKeyBtn && civitaiApiKeyInputEl) {
        saveCivitaiKeyBtn.onclick = async () => {
            const key = (civitaiApiKeyInputEl.value || '').trim();
            if (!key) {
                showToast('Enter a key first', 'warning');
                return;
            }
            await saveServiceCredential(() => sendCivitaiKey(key), { settingKey: 'civitaiApiKey', value: key, what: 'Civitai key' });
        };
    }

    if (clearCivitaiKeyBtn) {
        clearCivitaiKeyBtn.onclick = () => clearServiceCredential(clearCivitaiKey,
            { settingKey: 'civitaiApiKey', input: civitaiApiKeyInputEl, invalidate: () => window.invalidateCivitaiAuthCache?.(), what: 'Civitai key' });
    }

    if (validateCivitaiKeyBtn) {
        validateCivitaiKeyBtn.onclick = async () => {
            const originalHtml = validateCivitaiKeyBtn.innerHTML;
            validateCivitaiKeyBtn.classList.remove('success', 'error');
            validateCivitaiKeyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            validateCivitaiKeyBtn.disabled = true;
            try {
                // Resync the stored key to the service before validating: a server restart
                // can have dropped the RAM copy.
                const inputKey = (civitaiApiKeyInputEl?.value || '').trim();
                const savedKey = getSetting('civitaiApiKey') || '';
                const key = inputKey || savedKey;
                if (key) {
                    // a refused key is said in the server's words, never validated as the copy the service held before
                    await sendCivitaiKey(key);
                }
                const resp = await apiRequest('/provider-services/civitai-validate');
                const data = resp ? await resp.json() : null;
                if (data?.valid) {
                    // Persist on a successful test so the key isnt left only in the service's memory.
                    if (key) setSetting('civitaiApiKey', key);
                    validateCivitaiKeyBtn.classList.add('success');
                    validateCivitaiKeyBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
                    showToast('Civitai key is valid and saved', 'success');
                } else {
                    validateCivitaiKeyBtn.classList.add('error');
                    validateCivitaiKeyBtn.innerHTML = '<i class="fa-solid fa-times"></i>';
                    showToast(data?.reason || `Key invalid (status ${data?.status ?? '?'})`, 'error');
                }
            } catch (err) {
                validateCivitaiKeyBtn.classList.add('error');
                validateCivitaiKeyBtn.innerHTML = '<i class="fa-solid fa-exclamation"></i>';
                showToast(`Validation error: ${err.message}`, 'error');
            } finally {
                validateCivitaiKeyBtn.disabled = false;
                setTimeout(() => {
                    validateCivitaiKeyBtn.classList.remove('success', 'error');
                    validateCivitaiKeyBtn.innerHTML = originalHtml;
                }, 3000);
            }
        };
    }

    // Pixiv Login (PHPSESSID)
    const pixivCookieInputEl = document.getElementById('settingsPixivCookie');
    const togglePixivCookieVisibilityBtn = document.getElementById('togglePixivCookieVisibility');
    const savePixivCookieBtn = document.getElementById('savePixivCookieBtn');
    const clearPixivCookieBtn = document.getElementById('clearPixivCookieBtn');
    const validatePixivCookieBtn = document.getElementById('validatePixivCookieBtn');

    wireSecretToggle(togglePixivCookieVisibilityBtn, pixivCookieInputEl);

    if (savePixivCookieBtn && pixivCookieInputEl) {
        savePixivCookieBtn.onclick = async () => {
            const cookie = (pixivCookieInputEl.value || '').trim();
            if (!cookie) {
                showToast('Paste your PHPSESSID first', 'warning');
                return;
            }
            await saveServiceCredential(() => sendPixivCookie(cookie), { settingKey: 'pixivCookie', value: cookie, what: 'Pixiv login' });
        };
    }

    if (clearPixivCookieBtn) {
        clearPixivCookieBtn.onclick = () => clearServiceCredential(clearPixivLogin,
            { settingKey: 'pixivCookie', input: pixivCookieInputEl, invalidate: () => window.invalidatePixivAuthCache?.(), what: 'Pixiv login' });
    }

    if (validatePixivCookieBtn) {
        validatePixivCookieBtn.onclick = async () => {
            const originalHtml = validatePixivCookieBtn.innerHTML;
            validatePixivCookieBtn.classList.remove('success', 'error');
            validatePixivCookieBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            validatePixivCookieBtn.disabled = true;
            try {
                // Resync the stored cookie to the service before validating: a server restart
                // can have dropped the RAM copy.
                const inputCookie = (pixivCookieInputEl?.value || '').trim();
                const savedCookie = getSetting('pixivCookie') || '';
                const cookie = inputCookie || savedCookie;
                if (cookie) {
                    // a refused cookie is said in the server's words, never validated as the copy the service held before
                    await sendPixivCookie(cookie);
                }
                const resp = await apiRequest('/provider-services/pixiv-validate');
                const data = resp ? await resp.json() : null;
                if (data?.valid) {
                    // Persist on a successful test so the cookie isnt left only in the service's memory.
                    if (cookie) setSetting('pixivCookie', cookie);
                    validatePixivCookieBtn.classList.add('success');
                    validatePixivCookieBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
                    showToast('Pixiv login is valid and saved (R-18 access confirmed)', 'success');
                } else {
                    validatePixivCookieBtn.classList.add('error');
                    validatePixivCookieBtn.innerHTML = '<i class="fa-solid fa-times"></i>';
                    showToast(data?.reason || 'Pixiv login invalid', 'error');
                }
            } catch (err) {
                validatePixivCookieBtn.classList.add('error');
                validatePixivCookieBtn.innerHTML = '<i class="fa-solid fa-exclamation"></i>';
                showToast(`Validation error: ${err.message}`, 'error');
            } finally {
                validatePixivCookieBtn.disabled = false;
                setTimeout(() => {
                    validatePixivCookieBtn.classList.remove('success', 'error');
                    validatePixivCookieBtn.innerHTML = originalHtml;
                }, 3000);
            }
        };
    }

    // DataCat's JanitorAI Login (session cookie; unlocks Hampter pagination)
    // Its own session, not the provider's; refresh lives in datacat-provider (window.datacatJanitorai*).
    const datacatJanitoraiTokenInputEl = document.getElementById('settingsDatacatJanitoraiToken');
    const toggleDatacatJanitoraiTokenBtn = document.getElementById('toggleDatacatJanitoraiTokenVisibility');
    const saveDatacatJanitoraiTokenBtn = document.getElementById('saveDatacatJanitoraiTokenBtn');
    const clearDatacatJanitoraiTokenBtn = document.getElementById('clearDatacatJanitoraiTokenBtn');
    const datacatJanitoraiTokenStatusEl = document.getElementById('datacatJanitoraiTokenStatus');

    function updateDatacatJanitoraiStatus() {
        if (!datacatJanitoraiTokenStatusEl) return;
        const set = (cls, icon, text) => { datacatJanitoraiTokenStatusEl.className = `settings-status-badge ${cls}`; datacatJanitoraiTokenStatusEl.innerHTML = `<i class="fa-solid ${icon}"></i> ${text}`; };
        const status = window.datacatJanitoraiSessionStatus?.() || { loggedIn: !!getSetting('datacatJanitoraiToken') };
        if (!status.loggedIn) return set('inactive', 'fa-circle', 'Not logged in');
        // A refresh token keeps the session alive; without one it lapses in ~3h (bare-JWT paste).
        if (status.hasRefresh === false) return set('active', 'fa-triangle-exclamation', `Logged in${status.email ? ' as ' + status.email : ''} (expires in ~3h; paste the full cookie for a lasting session)`);
        set('active', 'fa-circle-check', `Logged in${status.email ? ' as ' + status.email : ''}`);
    }
    updateDatacatJanitoraiStatus();

    wireSecretToggle(toggleDatacatJanitoraiTokenBtn, datacatJanitoraiTokenInputEl);
    if (saveDatacatJanitoraiTokenBtn && datacatJanitoraiTokenInputEl) {
        saveDatacatJanitoraiTokenBtn.onclick = async () => {
            const raw = (datacatJanitoraiTokenInputEl.value || '').trim();
            if (!raw) { showToast('Paste your sb-...-auth-token cookie value first', 'warning'); return; }
            const original = saveDatacatJanitoraiTokenBtn.innerHTML;
            saveDatacatJanitoraiTokenBtn.disabled = true;
            saveDatacatJanitoraiTokenBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
            try {
                const res = await window.datacatJanitoraiSetSession?.(raw);
                if (res?.ok) {
                    datacatJanitoraiTokenInputEl.value = '';
                    updateDatacatJanitoraiStatus();
                    if (res.hasRefresh) showToast(`DataCat is now signed in to JanitorAI${res.email ? ' as ' + res.email : ''}`, 'success');
                    else showToast('Logged in, but no refresh token was in that value; this session expires in ~3h. Copy the whole sb-...-auth-token cookie for a lasting login.', 'warning', 9000);
                } else {
                    showToast(res?.error || 'Could not save the session', 'error');
                }
            } catch (err) {
                showToast(`Login error: ${err.message}`, 'error');
            } finally {
                saveDatacatJanitoraiTokenBtn.disabled = false;
                saveDatacatJanitoraiTokenBtn.innerHTML = original;
            }
        };
    }
    if (clearDatacatJanitoraiTokenBtn) {
        clearDatacatJanitoraiTokenBtn.onclick = () => {
            window.datacatJanitoraiLogout?.();
            if (datacatJanitoraiTokenInputEl) datacatJanitoraiTokenInputEl.value = '';
            updateDatacatJanitoraiStatus();
            showToast('DataCat signed out of JanitorAI', 'info');
        };
    }

    // JanitorAI provider login (driven through the hosted browser; Turnstile is domain-locked)
    // Parse / verify / refresh live in janitor-session.js (window.janitorai*).
    const clearJanitoraiTokenBtn = document.getElementById('clearJanitoraiTokenBtn');
    const janitoraiTokenStatusEl = document.getElementById('janitoraiTokenStatus');

    function updateJanitoraiStatus() {
        if (!janitoraiTokenStatusEl) return;
        const set = (cls, icon, text) => { janitoraiTokenStatusEl.className = `settings-status-badge ${cls}`; janitoraiTokenStatusEl.innerHTML = `<i class="fa-solid ${icon}"></i> ${text}`; };
        const status = window.janitoraiSessionStatus?.() || { loggedIn: !!getSetting('janitoraiToken') };
        if (!status.loggedIn) return set('inactive', 'fa-circle', 'Not logged in');
        // Without a refresh token the session lapses in ~3h; browser sign-in always returns one.
        if (status.hasRefresh === false) return set('active', 'fa-triangle-exclamation', `Logged in${status.email ? ' as ' + status.email : ''} (expires in ~3h, sign in again for a lasting session)`);
        set('active', 'fa-circle-check', `Logged in${status.email ? ' as ' + status.email : ''}`);
    }
    updateJanitoraiStatus();

    // Token paste: the alternative to the browser sign-in, and the only way in for social-login
    // accounts (no password).
    const janitoraiTokenInputEl = document.getElementById('settingsJanitoraiToken');
    const toggleJanitoraiTokenBtn = document.getElementById('toggleJanitoraiTokenVisibility');
    const saveJanitoraiTokenBtn = document.getElementById('saveJanitoraiTokenBtn');

    wireSecretToggle(toggleJanitoraiTokenBtn, janitoraiTokenInputEl);
    if (saveJanitoraiTokenBtn && janitoraiTokenInputEl) {
        saveJanitoraiTokenBtn.onclick = async () => {
            const raw = (janitoraiTokenInputEl.value || '').trim();
            if (!raw) { showToast('Paste your sb-...-auth-token cookie value first', 'warning'); return; }
            const original = saveJanitoraiTokenBtn.innerHTML;
            saveJanitoraiTokenBtn.disabled = true;
            saveJanitoraiTokenBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
            try {
                const res = await window.janitoraiSetSession?.(raw);
                if (res?.ok) {
                    janitoraiTokenInputEl.value = '';
                    updateJanitoraiStatus();
                    // The browser needs the session as a cookie of its own, or extraction opens a signed-out chat
                    // page. Best effort.
                    let inBrowser = false;
                    try {
                        const push = await window.janitoraiBrowserSetSession?.('');
                        inBrowser = !!push?.ok;
                    } catch { /* reported through the toast below */ }
                    const who = res.email ? ' as ' + res.email : '';
                    if (!res.hasRefresh) showToast('Logged in, but no refresh token was in that value; this session expires in ~3h. Copy the whole sb-...-auth-token cookie for a lasting login.', 'warning', 9000);
                    else if (inBrowser) showToast(`Signed in to JanitorAI${who}; the browser is signed in too`, 'success');
                    else showToast(`Signed in to JanitorAI${who}. Browsing works, but the browser could not be signed in, so character extraction may not. Check that the browser is running and the service is up to date.`, 'warning', 12000);
                } else {
                    showToast(res?.error || 'Could not save the session', 'error');
                }
            } catch (err) {
                showToast(`Login error: ${err.message}`, 'error');
            } finally {
                saveJanitoraiTokenBtn.disabled = false;
                saveJanitoraiTokenBtn.innerHTML = original;
            }
        };
    }

    if (clearJanitoraiTokenBtn) {
        clearJanitoraiTokenBtn.onclick = async () => {
            // Also clears the stored credentials: janitoraiLogout() only drops the tokens, and a
            // button labelled Log Out leaving the password saved would surprise.
            window.janitoraiLogout?.();
            if (janitoraiTokenInputEl) janitoraiTokenInputEl.value = '';
            setSettings({ janitoraiEmail: null, janitoraiPassword: null });
            const emailEl = document.getElementById('settingsJanitoraiEmail');
            const pwEl = document.getElementById('settingsJanitoraiPassword');
            if (emailEl) emailEl.value = '';
            if (pwEl) pwEl.value = '';
            updateJanitoraiStatus();

            // The browser keeps its own cookies, so without this a sign-in straight afterwards
            // silently adopts the session the user just asked us to forget.
            const original = clearJanitoraiTokenBtn.innerHTML;
            clearJanitoraiTokenBtn.disabled = true;
            clearJanitoraiTokenBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Logging out...';
            let browserCleared = false;
            try {
                const res = await window.janitoraiBrowserLogout?.('');
                browserCleared = !!res?.ok;
            } catch { /* an unreachable browser still leaves the local session cleared */ }
            clearJanitoraiTokenBtn.disabled = false;
            clearJanitoraiTokenBtn.innerHTML = original;
            updateJanitoraiStatus();
            showToast(browserCleared
                ? 'Logged out of JanitorAI, and the browser session was cleared'
                : 'Logged out of JanitorAI, but the browser session could not be cleared, so it may still hold the account. Check that the browser is running and the service is up to date.', browserCleared ? 'info' : 'warning', browserCleared ? 5000 : 9000);
        };
    }

    const janitoraiExtractOnUpdateCheckbox = document.getElementById('janitoraiExtractOnUpdateCheckbox');
    if (janitoraiExtractOnUpdateCheckbox) {
        janitoraiExtractOnUpdateCheckbox.checked = getSetting('janitoraiExtractOnUpdate') === true;
        janitoraiExtractOnUpdateCheckbox.onchange = () => {
            setSetting('janitoraiExtractOnUpdate', janitoraiExtractOnUpdateCheckbox.checked);
        };
    }

    // The hosted browser: Settings > Online > Hosted Browser, shared by every provider that needs a real one
    const browserModeSelect = document.getElementById('settingsBrowserMode');
    const browserEndpointInput = document.getElementById('settingsBrowserEndpoint');
    const browserChecksEl = document.getElementById('browserChecks');
    const browserManagedRow = document.getElementById('browserManagedRow');
    const browserManagedStatusRow = document.getElementById('browserManagedStatusRow');
    const browserEndpointHintRow = document.getElementById('browserEndpointHintRow');
    const browserManagedStatusEl = document.getElementById('browserManagedStatus');
    const browserManagedStartBtn = document.getElementById('browserManagedStartBtn');
    const browserManagedStopBtn = document.getElementById('browserManagedStopBtn');
    const testBrowserBtn = document.getElementById('testBrowserBtn');

    const browserMode = () => getSetting('browserMode') || 'managed';
    const browserEndpoint = () => (getSetting('browserEndpoint') || '').trim();
    // Whether a browser is configurable, not whether one is up: managed mode starts it lazily.
    const browserReady = () => browserMode() === 'managed' || !!browserEndpoint();

    async function runBrowserProbe(btn, el, { consumer = null, okMsg, failMsg, onRefusal = null }) {
        const managed = browserMode() === 'managed';
        const endpoint = browserEndpoint();
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking...';
        renderBrowserChecks(el, [], null);
        let data = null;
        try {
            // The abort bound is the only bound: apiRequest has none, and a wedged browser
            // would spin here forever.
            const resp = await apiRequest('/provider-services/browser/test', 'POST',
                { ...(managed ? { managed: true } : { endpoint }), ...(consumer ? { consumer } : {}) },
                { signal: AbortSignal.timeout(120000) });
            data = await resp.json().catch(() => null);
            renderBrowserChecks(el, data?.checks, data?.checks?.length ? null : (data?.error || 'The service did not answer'));
            // a refusal ran no check at all, so the toast says the refusal rather than blaming the browser
            const refused = !data?.ok && !data?.checks?.length && !!data?.error;
            showToast(data?.ok ? okMsg : refused ? (await onRefusal?.(data)) || data.error : failMsg, data?.ok ? 'success' : 'warning');
        } catch (err) {
            renderBrowserChecks(el, [], err?.name === 'TimeoutError' ? 'The browser did not answer in time.' : err.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
            // a managed probe may have started the browser; the block above has to say so
            if (managed) refreshManagedBrowserStatus();
        }
        return data;
    }

    function renderBrowserChecks(el, checks, fatalError) {
        if (!el) return;
        if (!checks?.length && !fatalError) {
            el.classList.add('hidden');
            el.innerHTML = '';
            return;
        }
        el.classList.remove('hidden');
        const rows = (checks || []).map(c => `
            <div class="browser-check ${c.ok ? 'ok' : (c.optional ? 'warn' : 'fail')}">
                <i class="fa-solid ${c.ok ? 'fa-circle-check' : (c.optional ? 'fa-circle-info' : 'fa-circle-xmark')}"></i>
                <span class="browser-check-label">${escapeHtml(c.label || c.key || '')}</span>
                ${c.detail ? `<span class="browser-check-detail">${escapeHtml(c.detail)}</span>` : ''}
            </div>`).join('');
        el.innerHTML = rows + (fatalError
            ? `<div class="browser-check fail"><i class="fa-solid fa-circle-xmark"></i><span class="browser-check-label">${escapeHtml(fatalError)}</span></div>`
            : '');
    }

    async function refreshManagedBrowserStatus() {
        if (!browserManagedStatusEl) return;
        if (browserMode() !== 'managed') return;
        // the managed browser is admin-only on a shared server (the route 403s everyone else)
        if (currentUser?.multiUser && !currentUser?.admin) {
            browserManagedStatusEl.className = 'settings-status-badge inactive';
            browserManagedStatusEl.textContent = 'Admins only on a shared server';
            if (browserManagedStartBtn) browserManagedStartBtn.disabled = true;
            if (browserManagedStopBtn) browserManagedStopBtn.disabled = true;
            return;
        }
        try {
            const resp = await apiRequest('/provider-services/browser/managed/status', 'GET');
            const d = await resp.json().catch(() => null);
            if (!d) throw new Error('no answer');
            const running = !!d.running;
            browserManagedStatusEl.className = `settings-status-badge ${running ? 'active' : 'inactive'}`;
            const label = running
                ? `Running (${d.browser || 'browser'}), stops after ${d.idleStopMinutes || 10} min idle`
                : (d.binary
                    ? 'Not started. It starts by itself when something needs it.'
                    : 'No Chrome, Chromium or Edge found on this machine.');
            browserManagedStatusEl.innerHTML = `<i class="fa-solid fa-circle"></i> ${escapeHtml(label)}`;
            if (browserManagedStopBtn) browserManagedStopBtn.disabled = !running;
        } catch {
            browserManagedStatusEl.className = 'settings-status-badge inactive';
            browserManagedStatusEl.innerHTML = '<i class="fa-solid fa-circle"></i> The service did not answer';
        }
    }

    /**
     * Re-read everything this section shows, on each open and expand: the managed browser starts
     * lazily and idle-stops just as invisibly.
     */
    function refreshBrowserSettingsUi() {
        if (browserEndpointInput) browserEndpointInput.value = browserEndpoint();
        if (browserModeSelect) {
            browserModeSelect.value = browserMode();
            browserModeSelect._customSelect?.update?.();
        }
        applyBrowserMode();
        if (document.getElementById('settingsBrowserSection')?.open) void renderBrowserExtSites();
    }

    // Expanding the <details> is when the user looks at the status, so re-read it then.
    document.getElementById('settingsBrowserSection')?.addEventListener('toggle', (e) => {
        if (e.target.open) refreshBrowserSettingsUi();
    });

    // the hosted-browser consumers of the extensions this account runs, each with a Check; redrawn by every extension list read
    async function renderBrowserExtSites(rows = null) {
        const group = document.getElementById('browserExtSites');
        const list = document.getElementById('browserExtSiteList');
        if (!group || !list) return [];
        if (!rows) {
            try { rows = (await readAnswer(await apiRequest('/extensions', 'GET')))?.extensions || []; } catch { rows = []; }
        }
        // an updated half keeps serving its old code until the restart, consumers included
        const sites = rows.filter(r => r.enabled && ['loaded', 'restart'].includes(r.serverState))
            .flatMap(r => (r.browserConsumers || []).map(c => ({ ...c, extName: r.name || r.id, host: new URL(c.origin).host })));
        group.classList.toggle('hidden', !sites.length);
        // the same sites keep their rows, so a Check still running, or its answer, survives a reread
        const drawn = JSON.stringify(sites.map(c => [c.id, c.origin, c.fetchPrefix, c.extName]));
        if (list.dataset.drawn === drawn) return sites;
        list.dataset.drawn = drawn;
        list.innerHTML = sites.map((c, i) => `
            <div class="settings-row u-gap-sm">
                <button class="settings-action-btn browser-ext-site-btn" data-ext-site="${i}"><i class="fa-solid fa-plug-circle-check"></i> Check ${escapeHtml(c.host)}</button>
                <span class="settings-hint browser-ext-site-hint">Used by ${escapeHtml(c.extName)} for ${escapeHtml(c.host + c.fetchPrefix)}</span>
            </div>
            <div class="settings-row"><div class="browser-check-list hidden" data-ext-site-checks="${i}"></div></div>`).join('');
        for (const btn of list.querySelectorAll('[data-ext-site]')) {
            const site = sites[Number(btn.dataset.extSite)];
            btn.onclick = async () => {
                if (!browserReady()) { showToast('Set up the hosted browser above first', 'warning'); return; }
                await runBrowserProbe(btn, list.querySelector(`[data-ext-site-checks="${btn.dataset.extSite}"]`), {
                    consumer: site.id, okMsg: `The browser gets through to ${site.host}`, failMsg: `The browser cannot reach ${site.host} yet`,
                    // switched off or removed since the list was drawn (another tab or device): the list is read again
                    onRefusal: async () => ((await renderBrowserExtSites()).some(s => s.id === site.id) ? null
                        : `${site.extName} no longer runs for your account, so its site is off the list`),
                });
            };
        }
        return sites;
    }

    function applyBrowserMode() {
        const managed = browserMode() === 'managed';
        // Managed mode has no endpoint to type, but Test applies to both, so hide only the input,
        // never the row; the label says which.
        const endpointRow = browserEndpointInput?.closest('.settings-row');
        const endpointLabel = endpointRow?.querySelector('label');
        if (endpointLabel) endpointLabel.textContent = managed ? 'Test:' : 'Endpoint:';
        browserEndpointInput?.classList.toggle('cl-hidden', managed);
        browserManagedRow?.classList.toggle('cl-hidden', !managed);
        browserManagedStatusRow?.classList.toggle('cl-hidden', !managed);
        browserEndpointHintRow?.classList.toggle('cl-hidden', managed);
        if (managed) refreshManagedBrowserStatus();
        // the providers that ride the browser gate their own controls on it
        document.dispatchEvent(new CustomEvent('cl:browser-settings-changed'));
    }

    if (browserModeSelect) {
        browserModeSelect.value = browserMode();
        // Classes transfer to the custom-select container at build time only, so a programmatic
        // value write needs the trigger re-synced by hand.
        browserModeSelect._customSelect?.update?.();
        browserModeSelect.addEventListener('change', () => {
            setSetting('browserMode', browserModeSelect.value === 'endpoint' ? 'endpoint' : 'managed');
            renderBrowserChecks(browserChecksEl, [], null);
            applyBrowserMode();
        });
    }

    if (browserManagedStartBtn) {
        browserManagedStartBtn.onclick = async () => {
            const original = browserManagedStartBtn.innerHTML;
            browserManagedStartBtn.disabled = true;
            browserManagedStartBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Starting...';
            try {
                await readAnswer(await apiRequest('/provider-services/browser/managed/start', 'POST', {}));
                showToast('Browser started', 'success');
            } catch (err) {
                showToast(err.message || 'Could not start a browser', 'error');
            } finally {
                browserManagedStartBtn.disabled = false;
                browserManagedStartBtn.innerHTML = original;
                refreshManagedBrowserStatus();
            }
        };
    }

    if (browserManagedStopBtn) {
        browserManagedStopBtn.onclick = async () => {
            try {
                await apiRequest('/provider-services/browser/managed/stop', 'POST', {});
            } catch { /* status refresh below reports the truth either way */ }
            refreshManagedBrowserStatus();
        };
    }

    if (browserEndpointInput) {
        browserEndpointInput.value = browserEndpoint();
        // Saved on change, not on Save: Test reads it back at once, and a tested-but-unsaved endpoint
        // wouldnt be the one used.
        browserEndpointInput.addEventListener('change', () => {
            const v = browserEndpointInput.value.trim();
            setSetting('browserEndpoint', v || null);
            applyBrowserMode();
        });
    }

    if (testBrowserBtn) {
        testBrowserBtn.onclick = async () => {
            const managed = browserMode() === 'managed';
            const endpoint = (browserEndpointInput?.value || '').trim();
            if (!managed && !endpoint) { showToast('Enter a browser endpoint first', 'warning'); return; }
            if (!managed) setSetting('browserEndpoint', endpoint);
            // No consumer: the browser's own rows; a site's rows are its provider section's Check.
            await runBrowserProbe(testBrowserBtn, browserChecksEl, { okMsg: 'Browser is ready', failMsg: 'Browser is not usable yet' });
        };
    }

    // Single init paint, after every field and listener above exists.
    refreshBrowserSettingsUi();

    // JanitorAI: the account, on the hosted browser above
    const janitoraiChecksEl = document.getElementById('janitoraiBrowserChecks');
    const janitoraiBrowserLoginBtn = document.getElementById('janitoraiBrowserLoginBtn');
    const janitoraiBrowserLoginHint = document.getElementById('janitoraiBrowserLoginHint');
    const janitoraiEmailInput = document.getElementById('settingsJanitoraiEmail');
    const janitoraiPasswordInput = document.getElementById('settingsJanitoraiPassword');
    const togglePwBtn = document.getElementById('toggleJanitoraiPasswordVisibility');

    function refreshJanitoraiSettingsUi() {
        if (janitoraiEmailInput) janitoraiEmailInput.value = getSetting('janitoraiEmail') || '';
        if (janitoraiPasswordInput) janitoraiPasswordInput.value = getSetting('janitoraiPassword') || '';
        updateJanitoraiStatus();
        applyJanitoraiBrowserGate();
    }

    document.getElementById('settingsJanitoraiSection')?.addEventListener('toggle', (e) => {
        if (e.target.open) refreshJanitoraiSettingsUi();
    });
    // the hosted browser's mode or endpoint changed: the login gate follows
    document.addEventListener('cl:browser-settings-changed', applyJanitoraiBrowserGate);

    function applyJanitoraiBrowserGate() {
        // Managed mode needs nothing before login (the browser starts on demand), so the button is never
        // gated on a URL.
        const ready = browserReady();
        setJanitoraiLoginEnabled(ready, ready
            ? ''
            : "Needs a browser endpoint under Hosted Browser above (JanitorAI's login captcha only runs on their own page).");
    }

    wireSecretToggle(togglePwBtn, janitoraiPasswordInput);

    // Show what is configured: blank boxes beside "Logged in" hide which credentials are stored.
    // Saved on change, as there is no Save here.
    janitoraiEmailInput?.addEventListener('change', () => {
        setSetting('janitoraiEmail', janitoraiEmailInput.value.trim() || null);
    });
    janitoraiPasswordInput?.addEventListener('change', () => {
        setSetting('janitoraiPassword', janitoraiPasswordInput.value || null);
    });

    // Single init paint, after every field and listener exists. A configured browser enables Sign In;
    // nothing re-runs a green check.
    refreshJanitoraiSettingsUi();

    function setJanitoraiLoginEnabled(enabled, hint) {
        if (janitoraiBrowserLoginBtn) janitoraiBrowserLoginBtn.disabled = !enabled;
        if (janitoraiBrowserLoginHint) janitoraiBrowserLoginHint.textContent = hint || '';
    }

    const checkJanitoraiBrowserBtn = document.getElementById('checkJanitoraiBrowserBtn');
    if (checkJanitoraiBrowserBtn) {
        checkJanitoraiBrowserBtn.onclick = async () => {
            if (!browserReady()) { showToast('Set up the hosted browser above first', 'warning'); return; }
            // the consumer adds janitorai.com's Cloudflare and clearance rows to the browser's own
            const data = await runBrowserProbe(checkJanitoraiBrowserBtn, janitoraiChecksEl, {
                consumer: 'janitorai',
                okMsg: 'The browser gets through to janitorai.com', failMsg: 'The browser cannot reach janitorai.com yet',
            });
            setJanitoraiLoginEnabled(!!data?.ok, data?.ok ? 'Browser ready.' : 'Fix the failing checks above.');
        };
    }

    if (janitoraiBrowserLoginBtn) {
        janitoraiBrowserLoginBtn.onclick = async () => {
            const email = (janitoraiEmailInput?.value || '').trim();
            const password = janitoraiPasswordInput?.value || '';
            if (!browserReady() || !email || !password) {
                showToast(browserReady() ? 'Email and password are both required' : 'Set up the hosted browser above, then enter email and password', 'warning');
                return;
            }
            const original = janitoraiBrowserLoginBtn.innerHTML;
            janitoraiBrowserLoginBtn.disabled = true;
            janitoraiBrowserLoginBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Signing in...';
            try {
                const data = await window.janitoraiBrowserLogin?.(email, password, '');
                if (!data?.ok) throw new Error(data?.error || 'Sign-in failed');
                // The browser is signed in either way; adopting the session locally is what
                // unlocks paging past page 1 in the browse view.
                const res = data.session ? await window.janitoraiSetSession?.(data.session) : null;
                // Keep the credentials that just worked, so a lapsed session can sign in again without hunting
                // for the password.
                setSettings({ janitoraiEmail: email, janitoraiPassword: password });
                updateJanitoraiStatus();
                showToast(res?.ok
                    ? `Signed in${res.email ? ' as ' + res.email : ''}; session adopted for browsing too`
                    : 'Browser signed in to JanitorAI', 'success');
            } catch (err) {
                // Social-login accounts can never sign in here, so point at the token either way.
                showToast(`Sign-in failed: ${err.message} If you use Google, Discord, X or Apple to sign in, or this keeps failing, paste a session token below instead.`, 'error', 14000);
            } finally {
                janitoraiBrowserLoginBtn.disabled = false;
                janitoraiBrowserLoginBtn.innerHTML = original;
            }
        };
    }

    // JannyAI: card pages on the hosted browser above
    const checkJannyBrowserBtn = document.getElementById('checkJannyBrowserBtn');
    if (checkJannyBrowserBtn) {
        checkJannyBrowserBtn.onclick = async () => {
            if (!browserReady()) { showToast('Set up the hosted browser above first', 'warning'); return; }
            await runBrowserProbe(checkJannyBrowserBtn, document.getElementById('jannyBrowserChecks'), {
                consumer: 'jannyai',
                okMsg: 'The browser gets through to jannyai.com', failMsg: 'The browser cannot reach jannyai.com yet',
            });
        };
    }

    // DataCat -> JanitorAI batch re-link
    const migrateDatacatLinksBtn = document.getElementById('migrateDatacatLinksBtn');
    const dcRelinkModal = document.getElementById('dcRelinkModal');
    if (migrateDatacatLinksBtn && dcRelinkModal) {
        const dcListEl = document.getElementById('dcRelinkList');
        const dcSummaryEl = document.getElementById('dcRelinkSummary');
        const dcProgressEl = document.getElementById('dcRelinkProgress');
        const dcRunBtn = document.getElementById('dcRelinkRunBtn');
        const dcVerifyCb = document.getElementById('dcRelinkVerify');
        let dcRelinkRows = [];
        let dcRelinkRunning = false;
        let dcRelinkAbort = false;

        const DC_JA_UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
        const DC_BUCKET_LABELS = {
            already: 'Already linked - cleanup only',
            conflict: 'Conflict: different JanitorAI link',
            otherSource: 'From another source',
            unresolvable: 'No JanitorAI id found',
        };

        function scanDcRelink(chars) {
            const ja = window.ProviderRegistry?.getProvider?.('janitorai');
            const rows = [];
            for (const char of chars) {
                const dc = char.data?.extensions?.datacat;
                if (!dc || !dc.id) continue;
                const existing = char.data?.extensions?.janitorai?.id || null;
                // Old datacat downloads shipped the source JanitorAI URL in character_version;
                // for janitor-sourced cards datacat's own id IS the JanitorAI uuid.
                const version = char.data?.character_version || char.character_version || '';
                const verUuid = ja?.parseUrl?.(String(version)) || null;
                let resolved = verUuid;
                let source = 'version URL';
                // a link stamped with another source keys datacat by that source's id, never a JanitorAI uuid
                const otherSource = !!dc.sourceKind && dc.sourceKind !== 'janitor';
                if (!resolved && !otherSource && DC_JA_UUID_RE.test(String(dc.id))) {
                    resolved = String(dc.id);
                    source = 'DataCat id';
                }
                let bucket;
                if (existing) bucket = (resolved && String(existing) !== resolved) ? 'conflict' : 'already';
                else if (resolved) bucket = 'ready';
                else bucket = otherSource ? 'otherSource' : 'unresolvable';
                rows.push({
                    id: char.id,
                    name: getCharacterName(char) || char.name || char.id,
                    bucket, resolved, source, existing,
                    locked: !!char.data?.extensions?.update_locked,
                    pageName: dc.pageName || null,
                    tagline: dc.tagline || null,
                    // the janitorai link's own display fields, off the set row the links composed
                    jaPageName: char.data?.extensions?.janitorai?.pageName || null,
                    jaTagline: char.data?.extensions?.janitorai?.tagline || null,
                });
            }
            return { rows };
        }

        // Dual-linked cleanup: datacat's display fields fill only what the janitorai link lacks, read off
        // the scan row
        function dcCleanupUpdates(r) {
            const updates = {};
            if (!r.jaPageName && r.pageName) updates['extensions.janitorai.pageName'] = r.pageName;
            if (!r.jaTagline && r.tagline) updates['extensions.janitorai.tagline'] = r.tagline;
            return updates;
        }

        function dcRowActionable(r, removeOld) {
            return !r.done && r.selected !== false
                && (r.bucket === 'ready' || (r.bucket === 'already' && removeOld));
        }

        function updateDcSelCount() {
            const n = dcRelinkRows.filter(r => dcRowActionable(r, true)).length;
            const sel = document.getElementById('dcRelinkSelCount');
            if (sel) sel.textContent = `${n} selected`;
            dcRunBtn.innerHTML = `<i class="fa-solid fa-play"></i> Migrate Selected (${n})`;
            dcRunBtn.disabled = n === 0 || dcRelinkRunning;
        }

        function renderDcRelink() {
            const removeOld = true; // one link per character: relinking always replaces
            const counts = {};
            for (const r of dcRelinkRows) counts[r.bucket] = (counts[r.bucket] || 0) + 1;
            const pill = (n, label, cls) => `<span class="dc-relink-pill ${cls}">${n} ${escapeHtml(label)}</span>`;
            const pills = [];
            if (counts.ready) pills.push(pill(counts.ready, 'ready', 'ready'));
            if (counts.already) pills.push(pill(counts.already, removeOld ? 'cleanup only' : 'already linked (hidden)', ''));
            if (counts.conflict) pills.push(pill(counts.conflict, 'conflicting', 'conflict'));
            if (counts.otherSource) pills.push(pill(counts.otherSource, 'from another source', ''));
            if (counts.unresolvable) pills.push(pill(counts.unresolvable, 'unresolvable', ''));
            dcSummaryEl.innerHTML = pills.length
                ? pills.join('')
                : '<span class="dc-relink-pill">No DataCat-linked characters found</span>';

            const order = { ready: 0, conflict: 1, already: 2, unresolvable: 3, otherSource: 4 };
            // Cleanup-only rows have nothing to offer while removal is off, so they hide with it.
            const visible = dcRelinkRows.filter(r => removeOld || r.bucket !== 'already');
            const sorted = visible.sort((a, b) =>
                (order[a.bucket] - order[b.bucket]) || a.name.localeCompare(b.name));
            dcListEl.innerHTML = sorted.map(r => {
                const selectable = (r.bucket === 'ready' || r.bucket === 'already') && !r.done;
                const cb = selectable
                    ? `<input type="checkbox" class="dc-relink-cb" data-char-id="${escapeHtml(r.id)}"${r.selected === false ? '' : ' checked'}>`
                    : '<span class="dc-relink-cb-spacer"></span>';
                const lock = r.locked
                    ? '<i class="fa-solid fa-lock dc-relink-lock" title="Update-locked. The lock governs update checks; the link can still change."></i>'
                    : '';
                let badge;
                if (r.bucket === 'ready') {
                    badge = `<span class="dc-relink-badge ready" title="JanitorAI id resolved from ${escapeHtml(r.source)}">${escapeHtml(r.source)}</span>`;
                } else if (r.bucket === 'already') {
                    badge = `<span class="dc-relink-badge" title="Already linked to JanitorAI. Running removes the leftover DataCat namespace; its display fields are kept when the JanitorAI side lacks them.">${escapeHtml(DC_BUCKET_LABELS.already)}</span>`;
                } else if (r.bucket === 'conflict') {
                    badge = `<span class="dc-relink-badge conflict" title="Linked to ${escapeHtml(r.existing)} but resolved ${escapeHtml(r.resolved)}. This tool never touches conflicting cards.">${escapeHtml(DC_BUCKET_LABELS.conflict)}</span>`;
                } else {
                    badge = `<span class="dc-relink-badge">${escapeHtml(DC_BUCKET_LABELS[r.bucket] || r.bucket)}</span>`;
                }
                return `<div class="dc-relink-row" data-char-id="${escapeHtml(r.id)}">${cb}<img class="dc-relink-avatar" src="${escapeHtml(getCharacterAvatarSmallThumbUrl(r.id))}" loading="lazy" alt=""><span class="dc-relink-row-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>${lock}${badge}</div>`;
            }).join('');
            updateDcSelCount();
        }

        function markDcRow(charId, ok, msg) {
            if (ok) {
                const data = dcRelinkRows.find(x => x.id === charId);
                if (data) data.done = true;
            }
            const row = dcListEl.querySelector(`.dc-relink-row[data-char-id="${CSS.escape(charId)}"]`);
            if (!row) return;
            const b = document.createElement('span');
            b.className = `dc-relink-badge ${ok ? 'ready' : 'fail'}`;
            b.textContent = msg;
            row.appendChild(b);
            const cb = row.querySelector('.dc-relink-cb');
            if (cb) { cb.checked = false; cb.disabled = true; }
        }

        async function openDcRelinkModal() {
            // only datacat carriers matter, as set rows: the link data and the version the scan reads
            const dcChars = await fetchCharacterSetWhere({ provider: 'datacat' }, ['characterVersion', 'links']);
            const scan = scanDcRelink(dcChars);
            dcRelinkRows = scan.rows;
            renderDcRelink();
            dcProgressEl.textContent = '';
            dcRelinkModal.classList.add('visible');
        }

        function closeDcRelinkModal() {
            dcRelinkAbort = true;
            dcRelinkModal.classList.remove('visible');
        }

        async function runDcRelink() {
            if (dcRelinkRunning) return;
            const removeOld = true; // one link per character: relinking always replaces
            const verify = dcVerifyCb.checked;
            const targets = dcRelinkRows.filter(r => dcRowActionable(r, removeOld));
            if (targets.length === 0) { showToast('Nothing selected.', 'info'); return; }

            dcRelinkRunning = true;
            dcRelinkAbort = false;
            dcRunBtn.disabled = true;
            let linked = 0, cleaned = 0, skipped = 0, failed = 0, unverified = 0;
            const pendingWrites = [];

            for (let i = 0; i < targets.length; i++) {
                if (dcRelinkAbort) break;
                const r = targets[i];
                dcProgressEl.textContent = `${i + 1}/${targets.length} - ${r.name}`;

                if (activeChar?.id === r.id && isCharModalDirty()) {
                    skipped++;
                    markDcRow(r.id, false, 'Skipped: open with unsaved edits');
                    continue;
                }

                const updates = {};
                if (r.bucket === 'ready') {
                    let pageName = r.pageName;
                    if (verify) {
                        let detail;
                        let verifyThrew = false;
                        try {
                            detail = await window.janitoraiFetchCharacter?.(r.resolved);
                        } catch { verifyThrew = true; }
                        // hampter rate-limits bursts hard (429s), pace the pass
                        await new Promise(res => setTimeout(res, 900));
                        if (dcRelinkAbort) break;
                        // null = definitive 404 (the fetcher throws on transport/auth); linking a gone target would be wrong
                        if (!verifyThrew && detail === null) {
                            skipped++;
                            markDcRow(r.id, false, 'Not found on JanitorAI');
                            continue;
                        }
                        if (detail?.name) pageName = detail.name;
                        else unverified++;
                    }
                    const jaNs = { id: r.resolved, linkedAt: new Date().toISOString() };
                    if (pageName) jaNs.pageName = pageName;
                    if (r.tagline) jaNs.tagline = r.tagline;
                    updates['extensions.janitorai'] = jaNs;
                }
                if (r.bucket === 'already' && removeOld) Object.assign(updates, dcCleanupUpdates(r));
                // a provider namespace set to null unlinks it server-side
                if (removeOld) updates['extensions.datacat'] = null;
                if (Object.keys(updates).length === 0) { skipped++; continue; }
                pendingWrites.push({ id: r.id, bucket: r.bucket, updates });
            }

            // the one batch write for everything verified above (an aborted pass still
            // flushes its verified rows)
            if (pendingWrites.length) {
                dcProgressEl.textContent = `Writing ${pendingWrites.length} link${pendingWrites.length === 1 ? '' : 's'}...`;
                let result = null;
                try {
                    // the one batch write, which re-reads what it changed
                    result = await runShellCommand('character.update-many', { updates: pendingWrites.map(w => ({ id: w.id, fields: w.updates })) }, a => applyCardFieldsNow(a.updates));
                } catch (e) {
                    console.error('[dcRelink] bulk write failed:', e);
                    result = e?.landed || null;
                }
                const okSet = new Set(result?.affected || []);
                for (const w of pendingWrites) {
                    if (okSet.has(w.id)) {
                        if (w.bucket === 'ready') { linked++; markDcRow(w.id, true, 'Migrated'); }
                        else { cleaned++; markDcRow(w.id, true, 'Cleaned'); }
                    } else {
                        failed++;
                        markDcRow(w.id, false, 'Write failed');
                    }
                }
            }

            dcRelinkRunning = false;
            updateDcSelCount();
            const bits = [`${linked} migrated`];
            if (cleaned) bits.push(`${cleaned} cleaned`);
            if (skipped) bits.push(`${skipped} skipped`);
            if (failed) bits.push(`${failed} failed`);
            if (unverified) bits.push(`${unverified} unverified`);
            dcProgressEl.textContent = (dcRelinkAbort ? 'Stopped. ' : 'Done. ') + bits.join(', ');

            window.ProviderRegistry?.rebuildAllBrowseLookups?.();
            performSearch();
        }

        migrateDatacatLinksBtn.onclick = openDcRelinkModal;
        dcRunBtn.onclick = runDcRelink;
        document.getElementById('dcRelinkCloseBtn').onclick = closeDcRelinkModal;
        document.getElementById('dcRelinkCancelBtn').onclick = () => {
            if (dcRelinkRunning) { dcRelinkAbort = true; return; }
            closeDcRelinkModal();
        };
        dcListEl.addEventListener('change', (e) => {
            const cb = e.target?.classList?.contains('dc-relink-cb') ? e.target : null;
            if (!cb) return;
            const row = dcRelinkRows.find(x => x.id === cb.dataset.charId);
            if (row) row.selected = cb.checked;
            updateDcSelCount();
        });
        document.getElementById('dcRelinkSelAllBtn').onclick = () => {
            for (const r of dcRelinkRows) {
                if (r.bucket === 'ready' || r.bucket === 'already') r.selected = true;
            }
            renderDcRelink();
        };
        document.getElementById('dcRelinkSelNoneBtn').onclick = () => {
            for (const r of dcRelinkRows) {
                if (r.bucket === 'ready' || r.bucket === 'already') r.selected = false;
            }
            renderDcRelink();
        };
        window.registerOverlay?.({ id: 'dcRelinkModal', tier: 4, close: () => closeDcRelinkModal(), visible: (el) => el.classList.contains('visible') });
    }

    
    
    const batchCheckUpdatesBtn = document.getElementById('batchCheckUpdatesBtn');
    if (batchCheckUpdatesBtn) {
        batchCheckUpdatesBtn.onclick = async () => {
            if (typeof window.checkAllCardUpdates === 'function') {
                if (!(await closeSettingsDialog())) return;
                window.checkAllCardUpdates();
            } else {
                showToast('Card updates module not loaded', 'error');
            }
        };
    }
}
