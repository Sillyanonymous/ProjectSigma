// Custom CSS module: snippet manager + raw blob editor.

import CoreAPI from './core-api.js';

const MODE_RAW = 'raw';
const MODE_SNIPPETS = 'snippets';
const SNIPPETS_FILE = 'custom-css-snippets';
const STORAGE_VERSION = 1;

// ========================================
// SNIPPET STORE
// ========================================

function createEmptyData() {
    return { version: STORAGE_VERSION, snippets: [], order: [] };
}

// A served collection keeps its snippets with its order repaired against them; anything else is empty.
function coerceSnippets(data) {
    if (!(data && data.version && Array.isArray(data.snippets))) return createEmptyData();
    const model = { version: STORAGE_VERSION, snippets: data.snippets, order: Array.isArray(data.order) ? data.order : [] };
    const ids = new Set(model.snippets.map(s => s.id));
    const orderSet = new Set(model.order);
    for (const id of ids) {
        if (!orderSet.has(id)) model.order.push(id);
    }
    model.order = model.order.filter(id => ids.has(id));
    return model;
}

// { version, snippets, order }; every mutator loads first and refuses an unread collection (a failed read never saves as empty)
const snippetsDoc = CoreAPI.createStoreDocument(SNIPPETS_FILE, {
    coerce: coerceSnippets,
    unread: 'Snippets could not be read from the server; editing is disabled so the stored ones are not overwritten',
    saveFailed: 'Failed to save snippets',
});


function loadSnippets() {
    return snippetsDoc.load();
}

function getOrderedSnippets() {
    const data = snippetsDoc.get();
    if (!data) return [];
    const byId = new Map(data.snippets.map(s => [s.id, s]));
    const seen = new Set();
    const ordered = [];
    for (const id of data.order) {
        const s = byId.get(id);
        if (s) { ordered.push(s); seen.add(id); }
    }
    for (const s of data.snippets) {
        if (!seen.has(s.id)) ordered.push(s);
    }
    return ordered;
}

function findSnippet(id) {
    return snippetsDoc.get()?.snippets.find(s => s.id === id) || null;
}

function buildEnabledBundle() {
    return getOrderedSnippets()
        .filter(s => s.enabled && typeof s.css === 'string' && s.css.trim())
        .map(s => `/* === ${(s.name || 'Snippet').replace(/\*\//g, '* /')} === */\n${s.css}`)
        .join('\n\n');
}

// Each mutator answers null (or false) when the collection was unread or the write did not land.
async function updateSnippet(id, patch) {
    return snippetsDoc.mutate((data) => {
        const idx = data.snippets.findIndex(s => s.id === id);
        if (idx === -1) return null;
        data.snippets[idx] = { ...data.snippets[idx], ...patch, modified: Date.now() };
        return data.snippets[idx];
    });
}

async function createSnippet(nameOrOpts = 'New Snippet') {
    const opts = typeof nameOrOpts === 'string' ? { name: nameOrOpts } : (nameOrOpts || {});
    return snippetsDoc.mutate((data) => {
        const snippet = {
            id: CoreAPI.randomId(12),
            name: opts.name || 'New Snippet',
            notes: opts.notes || '',
            enabled: !!opts.enabled,
            css: typeof opts.css === 'string' ? opts.css : '',
            created: Date.now(),
            modified: Date.now(),
        };
        data.snippets.push(snippet);
        data.order.push(snippet.id);
        return snippet;
    });
}

async function deleteSnippetById(id) {
    return !!(await snippetsDoc.mutate((data) => {
        data.snippets = data.snippets.filter(s => s.id !== id);
        data.order = data.order.filter(x => x !== id);
        return true;
    }));
}

// Pause all enabled snippets in one load+save. Used by Apply Raw. Answers how many, once that landed.
async function disableAllEnabledSnippets() {
    const now = Date.now();
    const paused = await snippetsDoc.mutate((data) => {
        let count = 0;
        for (const s of data.snippets) {
            if (s.enabled) {
                s.enabled = false;
                s.modified = now;
                count++;
            }
        }
        return count || null;
    });
    return paused || 0;
}

async function reorderSnippets(newOrderIds) {
    return !!(await snippetsDoc.mutate((data) => {
        const ids = new Set(data.snippets.map(s => s.id));
        const seen = new Set();
        const next = [];
        for (const id of newOrderIds) {
            if (ids.has(id) && !seen.has(id)) {
                next.push(id);
                seen.add(id);
            }
        }
        for (const s of data.snippets) {
            if (!seen.has(s.id)) next.push(s.id);
        }
        data.order = next;
        return true;
    }));
}

// ========================================
// MODE
// ========================================

function getMode() {
    const m = CoreAPI.getSetting('customCSSMode');
    return m === MODE_SNIPPETS ? MODE_SNIPPETS : MODE_RAW;
}

function setMode(mode) {
    CoreAPI.setSetting('customCSSMode', mode === MODE_SNIPPETS ? MODE_SNIPPETS : MODE_RAW);
}

// ========================================
// UTILITIES
// ========================================

function byteSize(str) {
    return new Blob([typeof str === 'string' ? str : '']).size;
}

// ========================================
// MODAL STATE
// ========================================

let modalInjected = false;
let activeSnippetId = null;
let editorDirty = false;
// Mobile teleports scrim + sidebar to body so position:fixed escapes th emodal's
// transform containing block. Refs let us restore on close.
let drawerIsOpen = false;
let drawerScrimOriginalParent = null;
let drawerScrimOriginalNextSibling = null;
let drawerSidebarOriginalParent = null;
let drawerSidebarOriginalNextSibling = null;
let snippetsDirty = false;

// ========================================
// HTML
// ========================================

function buildModalHTML() {
    return `
    <div class="cl-modal custom-css-modal" id="customCssModal">
        <div class="cl-modal-content" data-fw-min="760x460">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-paintbrush"></i> Custom CSS</h3>
                <button class="cl-modal-close" id="ccssCloseBtn" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body ccss-body">
                <div class="ccss-toolbar">
                    <div class="ccss-mode-toggle cl-seg" role="tablist">
                        <button class="ccss-mode-btn cl-seg-btn" data-mode="snippets" role="tab"><i class="fa-solid fa-layer-group"></i> Snippets</button>
                        <button class="ccss-mode-btn cl-seg-btn" data-mode="raw" role="tab"><i class="fa-solid fa-code"></i> Raw</button>
                    </div>
                    <div class="ccss-toolbar-spacer"></div>
                    <span id="ccssDirtyIndicator" class="ccss-dirty-indicator" hidden><i class="fa-solid fa-circle"></i> Unapplied changes</span>
                </div>

                <details class="custom-css-guidelines">
                    <summary>Guidelines &amp; tips</summary>
                    <div class="custom-css-guidelines-body">
                        <p>The active CSS on the page is whatever you last <strong>Applied</strong>, regardless of which mode produced it. Switching modes does not change what's on the page until you click Apply.</p>

                        <p><strong>Recommended approach: token overrides on <code>:root</code>.</strong> Re-themes the whole app without targeting specific classes:</p>
<pre>:root {
    --accent: #ff6b9d;
    --accent-rgb: 255, 107, 157;
    --bg-primary: #1a1a2e;
    --space-md: 12px;
}</pre>
                        <p class="custom-css-tip-note">Setting <code>--accent</code> (with its <code>--accent-rgb</code>) rethemes the whole app, module dialogs included. <code>--accent-hover</code> is a separate hardcoded token; override it too if you want the hover state to match.</p>

                        <p><strong>Surface backgrounds.</strong> Four different tokens, each for a different layer:</p>
                        <ul class="custom-css-token-list">
                            <li><code>--bg-primary</code> / <code>--bg-secondary</code>: page chrome (body, sidebars, settings panels).</li>
                            <li><code>--cl-glass-bg</code>: near-opaque (alpha 0.95) for module dialog bodies (custom CSS editor, card updates, batch tagging, playlists, AI assistant). Reads as a solid surface.</li>
                            <li><code>--cl-sheet-bg</code>: the translucent sheet material behind every dialog, the detail modal, the creator, the online previews and the sign-in wall (blur and saturation ride <code>--cl-blur-panel</code> and <code>--cl-sheet-saturate</code>).</li>
                            <li><code>--card-bg</code>: character grid card background.</li>
                        </ul>
                        <p>Dark washes read the shade ladder, <code>--cl-shade-10</code> through <code>--cl-shade-80</code> (black at that percent); the three modal scrims are its 60, 70 and 80 rungs.</p>

                        <p><strong>Modal scrim.</strong> The dimming layer <em>behind</em> a modal (the dark sheet that covers the rest of the page while the modal is open). Separate from the modal&rsquo;s own background; three tiers picked by gesture:</p>
                        <ul class="custom-css-token-list">
                            <li><code>--cl-modal-scrim-light</code> (alpha 0.6): nested overlays (confirm dialogs, version-history dialogs, the mobile tag-editor backdrop).</li>
                            <li><code>--cl-modal-scrim</code> (alpha 0.7): standard module dialogs (settings, batch tagging, playlists).</li>
                            <li><code>--cl-modal-scrim-heavy</code> (alpha 0.8): full-screen modals (character detail, creator) and destructive confirms.</li>
                        </ul>
                        <p class="custom-css-tip-note">These are full <code>rgba()</code> values, not just an alpha knob, so you can tint the scrim too (e.g. <code>rgba(20, 0, 40, 0.7)</code> for a purple-tinted dimming on a synthwave theme).</p>

                        <p><strong>Other useful token families:</strong></p>
                        <ul class="custom-css-token-list">
                            <li><code>--text-primary</code> / <code>--text-secondary</code> / <code>--text-faint</code> / <code>--text-muted</code>: text colour tiers (lightest to faintest).</li>
                            <li><code>--cl-success</code> / <code>--cl-error</code> / <code>--cl-warning</code> / <code>--cl-info</code>: muted status colours; each has a <code>-bright</code> variant for hero alerts and a <code>-pale</code> variant for text on translucent backgrounds.</li>
                            <li><code>--cl-favorite-gold</code> (with <code>-rgb</code>): gold accent for favorite indicators and the favorite-button hover treatment.</li>
                            <li><code>--space-2xs</code> through <code>--space-2xl</code>: spacing scale (use for padding, gap, margin).</li>
                            <li><code>--radius-2xs</code> through <code>--radius-4xl</code>, plus <code>--radius-circle</code> and <code>--radius-pill</code>: border-radius scale.</li>
                            <li><code>--font-4xs</code> through <code>--font-3xl</code>: typography scale.</li>
                        </ul>

                        <p class="custom-css-tip-note"><strong>Accent override warning.</strong> If you set any <code>--accent*</code> token in your applied CSS, a yellow warning appears next to the Accent Color picker in Settings &gt; General &gt; Theme &amp; Layout. Your CSS always wins over the picker (later in the cascade), so the picker silently does nothing until you remove the override. Clear the override to re-enable the picker.</p>

                        <p><strong>What to avoid:</strong></p>
                        <ul>
                            <li><strong>Class selectors are not a stable API.</strong> Targeting specific classes (e.g. <code>.char-card</code>) may break between versions. Prefer <code>:root</code> token overrides.</li>
                            <li><strong>No JavaScript.</strong> CSS only. <code>&lt;script&gt;</code> and <code>&lt;style&gt;</code> tags are stripped.</li>
                            <li><strong>External resources.</strong> <code>url(...)</code> and <code>@import</code> hit the network from your browser. Only paste CSS from sources you trust.</li>
                            <li><strong>Size limit:</strong> 64&nbsp;KB on the applied CSS.</li>
                        </ul>

                        <p><strong>If something breaks:</strong> click Clear in the offending mode, or run <code>clResetCSS()</code> in the browser console (F12). Your snippets are preserved.</p>
                    </div>
                </details>

                <!-- SNIPPETS MODE -->
                <div class="ccss-pane ccss-pane-snippets">
                    <!-- Mobile-only: backdrop scrim sits behind the bottom sheet. Hidden by
                         default; mobile CSS positions it fixed when the drawer opens. -->
                    <div class="ccss-drawer-scrim" id="ccssDrawerScrim" hidden></div>
                    <div class="ccss-snippets-layout">
                        <div class="ccss-sidebar" id="ccssSidebar">
                            <div class="mobile-sheet-handle"></div>
                            <div class="ccss-sidebar-header">
                                <span class="ccss-drawer-title">Snippets</span>
                                <button class="cl-btn cl-btn-primary ccss-sidebar-new" id="ccssNewBtn"><i class="fa-solid fa-plus"></i> New</button>
                            </div>
                            <div class="ccss-snippet-list" id="ccssSnippetList"></div>
                            <div class="ccss-sidebar-empty" id="ccssSidebarEmpty">No snippets yet. Click <strong>New</strong> to create one.</div>
                        </div>
                        <div class="ccss-editor">
                            <!-- Mobile-only drawer trigger; shows the active snippet name -->
                            <button class="ccss-drawer-trigger" id="ccssDrawerTrigger" type="button">
                                <i class="fa-solid fa-layer-group"></i>
                                <span class="ccss-drawer-trigger-label" id="ccssDrawerTriggerLabel">Snippets</span>
                                <i class="fa-solid fa-chevron-down ccss-drawer-trigger-caret"></i>
                            </button>
                            <div class="ccss-editor-form" id="ccssEditorForm" hidden>
                                <div class="ccss-editor-meta">
                                    <input type="search" autocomplete="one-time-code" id="ccssSnippetName" class="glass-input ccss-snippet-name-input" placeholder="Snippet name" maxlength="80">
                                    <label class="ccss-editor-enabled">
                                        <input type="checkbox" id="ccssSnippetEnabled"> Enabled
                                    </label>
                                    <button class="cl-btn cl-btn-sm cl-btn-danger ccss-editor-delete" id="ccssDeleteBtn" title="Delete this snippet"><i class="fa-solid fa-trash"></i></button>
                                    <button class="cl-btn cl-btn-sm cl-btn-secondary ccss-revert-btn" id="ccssRevertBtn"><i class="fa-solid fa-rotate-left"></i> Revert</button>
                                    <button class="cl-btn cl-btn-sm cl-btn-primary ccss-save-snippet-btn" id="ccssSaveSnippetBtn"><i class="fa-solid fa-floppy-disk"></i> Save Snippet</button>
                                </div>
                                <textarea id="ccssSnippetCss" class="custom-css-textarea ccss-snippet-css" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" placeholder="/* Snippet CSS */"></textarea>
                                <div class="custom-css-meta">
                                    <span id="ccssSnippetSizeLabel" class="custom-css-size">0 KB</span>
                                    <span id="ccssSnippetStatusLabel" class="custom-css-status"></span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- RAW MODE -->
                <div class="ccss-pane ccss-pane-raw" hidden>
                    <textarea id="ccssRawTextarea" class="custom-css-textarea ccss-raw-textarea" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" placeholder="/* Your raw CSS */
:root {
    --accent: #ff6b9d;
}"></textarea>
                    <div class="custom-css-meta">
                        <span id="ccssRawSizeLabel" class="custom-css-size">0 KB</span>
                        <span id="ccssRawStatusLabel" class="custom-css-status"></span>
                    </div>
                </div>
            </div>
            <div class="cl-modal-footer ccss-footer">
                <span class="ccss-footer-hint" id="ccssFooterHint">Apply combines all enabled snippets and publishes them as the active CSS.</span>
                <div class="ccss-footer-actions">
                    <button class="cl-btn cl-btn-danger cl-hidden" id="ccssRawDisableBtn"><i class="fa-solid fa-eraser"></i> Clear</button>
                    <button class="cl-btn cl-btn-secondary" id="ccssCloseFooterBtn">Close</button>
                    <button class="cl-btn cl-btn-secondary cl-hidden" id="ccssRawSaveAsSnippetBtn"><i class="fa-solid fa-floppy-disk"></i> Save as Snippet</button>
                    <button class="cl-btn cl-btn-primary" id="ccssApplySnippetsBtn"><i class="fa-solid fa-check"></i> Apply Snippets</button>
                    <button class="cl-btn cl-btn-primary cl-hidden" id="ccssRawApplyBtn"><i class="fa-solid fa-check"></i> Apply Raw</button>
                </div>
            </div>
        </div>
    </div>`;
}

// ========================================
// DIRTY INDICATOR
// ========================================

function setSnippetsDirty(value) {
    snippetsDirty = !!value;
    const ind = document.getElementById('ccssDirtyIndicator');
    if (ind) ind.hidden = !snippetsDirty;
}

// Empty bundle means Apply Snippets has nothing to do, so the indicator stays
// quiet even when Raw owns the customCSS slot.
function computeSnippetsDirty() {
    const bundle = buildEnabledBundle();
    if (!bundle) return false;
    const applied = CoreAPI.getSetting('customCSS') || '';
    return bundle !== applied;
}

// ========================================
// MODE SWITCHING
// ========================================

function setActiveMode(mode) {
    const modal = document.getElementById('customCssModal');
    if (!modal) return;
    setMode(mode);
    modal.querySelectorAll('.ccss-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
        btn.setAttribute('aria-selected', btn.dataset.mode === mode ? 'true' : 'false');
    });
    modal.querySelector('.ccss-pane-snippets').hidden = mode !== MODE_SNIPPETS;
    modal.querySelector('.ccss-pane-raw').hidden = mode !== MODE_RAW;
    modal.classList.toggle('ccss-mode-raw', mode === MODE_RAW);
    if (mode !== MODE_SNIPPETS) closeDrawer();

    const isSnippets = mode === MODE_SNIPPETS;
    document.getElementById('ccssApplySnippetsBtn')?.classList.toggle('cl-hidden', !isSnippets);
    document.getElementById('ccssRawApplyBtn')?.classList.toggle('cl-hidden', isSnippets);
    document.getElementById('ccssRawDisableBtn')?.classList.toggle('cl-hidden', isSnippets);
    document.getElementById('ccssRawSaveAsSnippetBtn')?.classList.toggle('cl-hidden', isSnippets);
    const hint = document.getElementById('ccssFooterHint');
    if (hint) {
        hint.textContent = isSnippets
            ? 'Apply combines all enabled snippets and publishes them as the active CSS.'
            : 'Apply publishes the raw CSS as the active stylesheet.';
    }
}

// ========================================
// SIDEBAR
// ========================================

function renderSidebar() {
    const list = document.getElementById('ccssSnippetList');
    const empty = document.getElementById('ccssSidebarEmpty');
    if (!list || !empty) return;
    const snippets = getOrderedSnippets();
    if (snippets.length === 0) {
        list.innerHTML = '';
        empty.hidden = false;
        return;
    }
    empty.hidden = true;
    list.innerHTML = snippets.map(s => `
        <div class="ccss-snippet-item${s.id === activeSnippetId ? ' active' : ''}" data-id="${s.id}" draggable="true">
            <span class="ccss-snippet-drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
            <label class="ccss-snippet-toggle" title="Enable/disable this snippet">
                <input type="checkbox" class="ccss-snippet-enable" data-id="${s.id}" ${s.enabled ? 'checked' : ''}>
            </label>
            <button class="ccss-snippet-name" data-id="${s.id}">${CoreAPI.escapeHtml(s.name || 'Untitled')}</button>
            <button class="ccss-snippet-wand" data-id="${s.id}" title="Open AI assistant"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
        </div>
    `).join('');
}

// ========================================
// EDITOR
// ========================================

function refreshSnippetsView() {
    const ordered = getOrderedSnippets();
    if (ordered.length === 0) {
        activeSnippetId = null;
        loadSnippetIntoEditor(null);
        return;
    }
    const existing = ordered.find(s => s.id === activeSnippetId);
    loadSnippetIntoEditor(existing ? existing.id : ordered[0].id);
}

function loadSnippetIntoEditor(id) {
    activeSnippetId = id;
    const form = document.getElementById('ccssEditorForm');
    const nameInput = document.getElementById('ccssSnippetName');
    const enabledInput = document.getElementById('ccssSnippetEnabled');
    const cssTextarea = document.getElementById('ccssSnippetCss');
    const statusLabel = document.getElementById('ccssSnippetStatusLabel');

    if (!id) {
        form.hidden = true;
        editorDirty = false;
        updateDrawerTriggerLabel(null);
        renderSidebar();
        return;
    }
    const snippet = findSnippet(id);
    if (!snippet) {
        activeSnippetId = null;
        form.hidden = true;
        updateDrawerTriggerLabel(null);
        renderSidebar();
        return;
    }
    form.hidden = false;
    nameInput.value = snippet.name || '';
    enabledInput.checked = !!snippet.enabled;
    cssTextarea.value = snippet.css || '';
    statusLabel.textContent = '';
    editorDirty = false;
    updateEditorSizeLabel();
    updateDrawerTriggerLabel(snippet.name);
    renderSidebar();
}

function updateDrawerTriggerLabel(name) {
    const label = document.getElementById('ccssDrawerTriggerLabel');
    if (!label) return;
    label.textContent = name && name.trim() ? name : 'Snippets';
}

// ========================================
// MOBILE DRAWER
// ========================================

function teleportDrawerToBody() {
    const sidebar = document.getElementById('ccssSidebar');
    const scrim = document.getElementById('ccssDrawerScrim');
    if (!sidebar || !scrim) return;
    drawerScrimOriginalParent = scrim.parentElement;
    drawerScrimOriginalNextSibling = scrim.nextSibling;
    drawerSidebarOriginalParent = sidebar.parentElement;
    drawerSidebarOriginalNextSibling = sidebar.nextSibling;
    document.body.appendChild(scrim);
    document.body.appendChild(sidebar);
}

function restoreDrawerToOriginal() {
    const sidebar = document.getElementById('ccssSidebar');
    const scrim = document.getElementById('ccssDrawerScrim');
    if (drawerScrimOriginalParent && scrim) {
        drawerScrimOriginalParent.insertBefore(scrim, drawerScrimOriginalNextSibling);
    }
    if (drawerSidebarOriginalParent && sidebar) {
        drawerSidebarOriginalParent.insertBefore(sidebar, drawerSidebarOriginalNextSibling);
    }
    drawerScrimOriginalParent = null;
    drawerScrimOriginalNextSibling = null;
    drawerSidebarOriginalParent = null;
    drawerSidebarOriginalNextSibling = null;
}

function openDrawer() {
    const sidebar = document.getElementById('ccssSidebar');
    const scrim = document.getElementById('ccssDrawerScrim');
    if (!sidebar || !scrim) return;
    if (!drawerIsOpen) {
        teleportDrawerToBody();
        drawerIsOpen = true;
    }
    scrim.hidden = false;
    requestAnimationFrame(() => sidebar.classList.add('drawer-open'));
}

function closeDrawer({ immediate = false } = {}) {
    const sidebar = document.getElementById('ccssSidebar');
    const scrim = document.getElementById('ccssDrawerScrim');
    if (!sidebar || !scrim) return;
    sidebar.classList.remove('drawer-open');
    const finalize = () => {
        // If openDrawer was called again between this close and the deferred finalize,
        // the sidebar will have the open class back; abandon cleanup.
        if (sidebar.classList.contains('drawer-open')) return;
        scrim.hidden = true;
        if (drawerIsOpen) {
            restoreDrawerToOriginal();
            drawerIsOpen = false;
        }
    };
    if (immediate) {
        finalize();
    } else {
        // Wait for the slide-down so the backdrop fade tracks the sheet.
        setTimeout(finalize, 300);
    }
}

function updateEditorSizeLabel() {
    const cssTextarea = document.getElementById('ccssSnippetCss');
    const sizeLabel = document.getElementById('ccssSnippetSizeLabel');
    if (!cssTextarea || !sizeLabel) return;
    const size = byteSize(cssTextarea.value);
    sizeLabel.textContent = CoreAPI.formatBytes(size);
    sizeLabel.classList.toggle('over-limit', size > CoreAPI.getCustomCSSMaxBytes());
}

async function saveActiveSnippet() {
    if (!activeSnippetId) return;
    const nameInput = document.getElementById('ccssSnippetName');
    const enabledInput = document.getElementById('ccssSnippetEnabled');
    const cssTextarea = document.getElementById('ccssSnippetCss');
    const statusLabel = document.getElementById('ccssSnippetStatusLabel');
    const max = CoreAPI.getCustomCSSMaxBytes();
    if (byteSize(cssTextarea.value) > max) {
        CoreAPI.showToast(`Snippet exceeds ${CoreAPI.formatBytes(max)} limit`, 'error');
        return;
    }
    const saved = await updateSnippet(activeSnippetId, {
        name: nameInput.value.trim() || 'Untitled',
        enabled: enabledInput.checked,
        css: cssTextarea.value,
    });
    // not saved: the edits stay in the editor, still marked unsaved
    if (!saved) return;
    editorDirty = false;
    setSnippetsDirty(true);
    statusLabel.textContent = 'Saved (click Apply to publish)';
    renderSidebar();
    CoreAPI.showToast('Snippet saved', 'success', 1500);
}

async function confirmDiscardIfDirty() {
    if (!editorDirty) return true;
    if (!(await CoreAPI.showConfirm({ title: 'Discard changes', message: 'Discard unsaved changes to this snippet?', confirmLabel: 'Discard', danger: true }))) return false;
    // Actually discard: reload textarea from disk so stale edits don't linger.
    if (activeSnippetId) loadSnippetIntoEditor(activeSnippetId);
    editorDirty = false;
    return true;
}

// ========================================
// RAW MODE
// ========================================

function loadRawIntoEditor() {
    const textarea = document.getElementById('ccssRawTextarea');
    const statusLabel = document.getElementById('ccssRawStatusLabel');
    if (!textarea) return;
    textarea.value = CoreAPI.getSetting('customCSS') || '';
    statusLabel.textContent = '';
    updateRawSizeLabel();
}

function updateRawSizeLabel() {
    const textarea = document.getElementById('ccssRawTextarea');
    const sizeLabel = document.getElementById('ccssRawSizeLabel');
    if (!textarea || !sizeLabel) return;
    const size = byteSize(textarea.value);
    sizeLabel.textContent = CoreAPI.formatBytes(size);
    sizeLabel.classList.toggle('over-limit', size > CoreAPI.getCustomCSSMaxBytes());
}

// ========================================
// MODAL LIFECYCLE
// ========================================

function injectModal() {
    if (modalInjected) return;
    modalInjected = true;
    document.body.insertAdjacentHTML('beforeend', buildModalHTML());

    const modal = document.getElementById('customCssModal');
    CoreAPI.mountDialogSizing(modal);
    CoreAPI.mountSeam(modal.querySelector('.ccss-sidebar'), { key: 'customCssModal:sidebar', minPx: 200, max: 50 });

    document.getElementById('ccssCloseBtn')?.addEventListener('click', closeModal);
    document.getElementById('ccssCloseFooterBtn')?.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    modal.querySelectorAll('.ccss-mode-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const target = btn.dataset.mode;
            if (target === getMode()) return;
            if (!(await confirmDiscardIfDirty())) return;
            setActiveMode(target);
            if (target === MODE_RAW) loadRawIntoEditor();
            else refreshSnippetsView();
        });
    });

    const list = document.getElementById('ccssSnippetList');
    list.addEventListener('click', async (e) => {
        const wandBtn = e.target.closest('.ccss-snippet-wand');
        if (wandBtn) {
            e.stopPropagation();
            const id = wandBtn.dataset.id;
            // Accepting an AI Update would silently overwrite unsaved edits on this snippet.
            if (editorDirty && activeSnippetId === id) {
                if (!(await CoreAPI.showConfirm({ title: 'Unsaved edits', message: 'You have unsaved edits to this snippet. The AI assistant may overwrite them if you accept an Update.', confirmLabel: 'Continue anyway' }))) return;
            }
            // Close the mobile snippets drawer if open so the assistant modal isn't buried under it
            closeDrawer({ immediate: true });
            const cssAssistant = CoreAPI.getModule('css-assistant');
            if (cssAssistant?.openModal) {
                cssAssistant.openModal({ snippetId: id });
            } else {
                CoreAPI.showToast('AI assistant not loaded yet, try again in a moment', 'warning');
            }
            return;
        }
        const nameBtn = e.target.closest('.ccss-snippet-name');
        if (nameBtn) {
            const id = nameBtn.dataset.id;
            if (id === activeSnippetId) {
                closeDrawer();
                return;
            }
            if (!(await confirmDiscardIfDirty())) return;
            loadSnippetIntoEditor(id);
            closeDrawer();
        }
    });
    list.addEventListener('change', async (e) => {
        const checkbox = e.target.closest('.ccss-snippet-enable');
        if (checkbox) {
            const id = checkbox.dataset.id;
            if (!(await updateSnippet(id, { enabled: checkbox.checked }))) {
                checkbox.checked = !checkbox.checked;
                return;
            }
            setSnippetsDirty(true);
            if (id === activeSnippetId) {
                const enabledInput = document.getElementById('ccssSnippetEnabled');
                if (enabledInput) enabledInput.checked = checkbox.checked;
            }
        }
    });

    // drag to reorder; the new order saves at once
    const persistOrderFromDOM = async () => {
        const ids = [...list.querySelectorAll('.ccss-snippet-item')].map(el => el.dataset.id);
        if (await reorderSnippets(ids)) {
            setSnippetsDirty(true);
            return;
        }
        // not saved: the list goes back to the order the server holds
        if (await loadSnippets()) renderSidebar();
    };
    CoreAPI.wireDragReorder(list, { item: '.ccss-snippet-item', handle: '.ccss-snippet-drag-handle', onReorder: persistOrderFromDOM });

    document.getElementById('ccssNewBtn')?.addEventListener('click', async () => {
        if (!(await confirmDiscardIfDirty())) return;
        const snippet = await createSnippet('New Snippet');
        if (!snippet) return;
        setSnippetsDirty(true);
        loadSnippetIntoEditor(snippet.id);
        closeDrawer();
    });

    document.getElementById('ccssDrawerTrigger')?.addEventListener('click', openDrawer);
    document.getElementById('ccssDrawerScrim')?.addEventListener('click', () => closeDrawer());

    // Flipping back to desktop while the drawer is open at body level needs a force-restore.
    document.addEventListener('cl-mobile-mode-change', (e) => {
        if (!e.detail?.mobile && drawerIsOpen) closeDrawer({ immediate: true });
    });

    const nameInput = document.getElementById('ccssSnippetName');
    const enabledInput = document.getElementById('ccssSnippetEnabled');
    const cssTextarea = document.getElementById('ccssSnippetCss');
    const onDirty = () => {
        editorDirty = true;
        const status = document.getElementById('ccssSnippetStatusLabel');
        if (status) status.textContent = 'Unsaved';
    };
    nameInput.addEventListener('input', onDirty);
    enabledInput.addEventListener('change', onDirty);
    cssTextarea.addEventListener('input', () => {
        onDirty();
        updateEditorSizeLabel();
    });

    document.getElementById('ccssSaveSnippetBtn')?.addEventListener('click', saveActiveSnippet);
    document.getElementById('ccssRevertBtn')?.addEventListener('click', () => {
        if (!activeSnippetId) return;
        loadSnippetIntoEditor(activeSnippetId);
    });
    document.getElementById('ccssDeleteBtn')?.addEventListener('click', async () => {
        if (!activeSnippetId) return;
        const snippet = findSnippet(activeSnippetId);
        if (!snippet) return;
        if (!(await CoreAPI.showConfirm({ title: 'Delete snippet', message: `Delete "${snippet.name || 'Untitled'}"? This cannot be undone.`, confirmLabel: 'Delete', danger: true }))) return;
        const id = activeSnippetId;
        const wasEnabled = snippet.enabled;
        // not deleted: the snippet stays open in the editor as it was
        if (!(await deleteSnippetById(id))) return;
        activeSnippetId = null;
        editorDirty = false;
        if (wasEnabled) setSnippetsDirty(true);
        loadSnippetIntoEditor(null);
        CoreAPI.showToast('Snippet deleted', 'info', 1500);
    });

    document.getElementById('ccssApplySnippetsBtn')?.addEventListener('click', async () => {
        if (!(await confirmDiscardIfDirty())) return;
        // an unread or dropped collection bundles to nothing, ie. it would apply as no CSS at all
        await loadSnippets();
        if (snippetsDoc.unavailable()) return;
        const bundle = buildEnabledBundle();
        const max = CoreAPI.getCustomCSSMaxBytes();
        if (byteSize(bundle) > max) {
            CoreAPI.showToast(`Combined snippets exceed ${CoreAPI.formatBytes(max)} limit`, 'error');
            return;
        }
        CoreAPI.setSetting('customCSS', bundle);
        CoreAPI.applyCustomCSS();
        setSnippetsDirty(false);
        CoreAPI.showToast('Snippets applied', 'success', 1500);
    });

    const rawTextarea = document.getElementById('ccssRawTextarea');
    rawTextarea.addEventListener('input', () => {
        updateRawSizeLabel();
        const status = document.getElementById('ccssRawStatusLabel');
        if (status) status.textContent = '';
    });
    document.getElementById('ccssRawApplyBtn')?.addEventListener('click', async () => {
        const max = CoreAPI.getCustomCSSMaxBytes();
        if (byteSize(rawTextarea.value) > max) {
            CoreAPI.showToast(`Raw CSS exceeds ${CoreAPI.formatBytes(max)} limit`, 'error');
            return;
        }
        const enabledCount = getOrderedSnippets().filter(s => s.enabled).length;
        if (enabledCount > 0) {
            const noun = enabledCount === 1 ? 'snippet' : 'snippets';
            if (!(await CoreAPI.showConfirm({ title: 'Apply raw CSS', message: `Applying Raw will pause ${enabledCount} enabled ${noun}.`, confirmLabel: 'Apply' }))) return;
        }
        CoreAPI.setSetting('customCSS', rawTextarea.value);
        CoreAPI.applyCustomCSS();
        const paused = await disableAllEnabledSnippets();
        // a pause that did not land dropped the copy: the list shows what the server holds
        if (await loadSnippets()) renderSidebar();
        setSnippetsDirty(computeSnippetsDirty());
        document.getElementById('ccssRawStatusLabel').textContent = 'Applied';
        const msg = paused > 0
            ? `Raw CSS applied. ${paused} ${paused === 1 ? 'snippet' : 'snippets'} paused.`
            : 'Raw CSS applied';
        CoreAPI.showToast(msg, 'success', 2000);
    });
    document.getElementById('ccssRawSaveAsSnippetBtn')?.addEventListener('click', async () => {
        if (!rawTextarea.value.trim()) {
            CoreAPI.showToast('Raw CSS is empty', 'warning', 1500);
            return;
        }
        const max = CoreAPI.getCustomCSSMaxBytes();
        if (byteSize(rawTextarea.value) > max) {
            CoreAPI.showToast(`Raw CSS exceeds ${CoreAPI.formatBytes(max)} limit`, 'error');
            return;
        }
        const input = await CoreAPI.showConfirm({ title: 'Save as snippet', message: 'Name for the new snippet:', confirmLabel: 'Save', input: { value: 'Raw Snippet' } });
        if (!input) return;
        const name = String(input).trim() || 'Raw Snippet';
        const created = await createSnippet({ name, css: rawTextarea.value, enabled: false });
        if (!created) return;
        renderSidebar();
        CoreAPI.showToast(`Snippet "${name}" saved (disabled)`, 'success', 2000);
    });
    document.getElementById('ccssRawDisableBtn')?.addEventListener('click', async () => {
        if (!(await CoreAPI.showConfirm({ title: 'Clear raw CSS', message: 'Clear the raw CSS blob?', confirmLabel: 'Clear', danger: true }))) return;
        rawTextarea.value = '';
        updateRawSizeLabel();
        CoreAPI.setSetting('customCSS', '');
        CoreAPI.applyCustomCSS();
        document.getElementById('ccssRawStatusLabel').textContent = 'Cleared';
        CoreAPI.showToast('Raw CSS cleared', 'info', 1500);
    });

    window.registerOverlay?.({
        id: 'customCssModal',
        tier: 5,
        close: () => closeModal(),
        visible: (el) => el.classList.contains('visible'),
    });

    // Mobile drawer as sub-overlay so back/Escape pops it before the parent modal.
    window.registerOverlay?.({
        id: 'ccssSidebar',
        tier: 3,
        close: () => closeDrawer(),
        visible: () => drawerIsOpen,
    });
}

async function openModal() {
    injectModal();
    await loadSnippets();
    setSnippetsDirty(computeSnippetsDirty());
    const mode = getMode();
    setActiveMode(mode);
    // Render sidebar even if booting in Raw so the Snippets tab isn't phantom-empty.
    refreshSnippetsView();
    if (mode === MODE_RAW) {
        loadRawIntoEditor();
    }
    document.getElementById('customCssModal').classList.add('visible');
}

async function closeModal() {
    if (!(await confirmDiscardIfDirty())) return;
    if (drawerIsOpen) closeDrawer({ immediate: true });
    document.getElementById('customCssModal')?.classList.remove('visible');
}

function init() {}

function getActiveSnippetId() {
    return activeSnippetId;
}

export { openModal, closeModal, loadSnippets, createSnippet, updateSnippet, renderSidebar, setSnippetsDirty, loadSnippetIntoEditor, getActiveSnippetId };
export default { init, openModal, closeModal };
