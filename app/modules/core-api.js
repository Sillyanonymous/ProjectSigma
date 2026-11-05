// Core API - proxy layer between modules and the library monolith

import ProviderRegistry from './providers/provider-registry.js';

// ========================================
// SHARED LLM CLIENT
// ========================================

// See library.js "SHARED LLM CLIENT". Each AI module passes its own
// resolved profile + the per-feature options; the body/proxy/parse logic is centralized.
export function getLlmSettings() {
    return window.getLlmSettings?.() ?? Promise.resolve({ profiles: [], activeSource: '', activeModel: '', hasProfiles: false, error: true });
}

export function mountAiConnectionBlock(...args) {
    return window.mountAiConnectionBlock?.(...args) ?? Promise.resolve(null);
}

/**
 * Whether a surface paints its reply as it arrives: on unless its connection's Stream the reply was switched off
 * @param {string} surface the connection block's surface ('creator', 'css', ...)
 * @returns {boolean}
 */
export function aiConnectionStreams(surface) {
    return !!window.aiConnectionStreams?.(surface);
}

export function callLLM(messages, opts) {
    return window.callLLM?.(messages, opts);
}

export function callLLMStream(...args) {
    return window.callLLMStream?.(...args);
}

export function consumeLlmSse(...args) {
    return window.consumeLlmSse?.(...args);
}

export function streamChatGeneration(...args) {
    return window.streamChatGeneration?.(...args);
}

export function streamAssistantGeneration(...args) {
    return window.streamAssistantGeneration?.(...args);
}
export function streamCreatorGeneration(...args) {
    return window.streamCreatorGeneration?.(...args);
}

/**
 * LCS line diff. Returns structure, not markup, so each caller renders it its own way.
 * @returns {Array<{type: 'context'|'added'|'removed', line: string}>}
 */
export function computeLineDiff(...args) {
    return window.computeLineDiff?.(...args) || [];
}

/**
 * LCS word diff for one changed line pair. Structure, not markup, like computeLineDiff.
 * @returns {{old: Array<{type: 'same'|'removed', text: string}>, new: Array<{type: 'same'|'added', text: string}>}}
 */
export function computeWordDiff(...args) {
    return window.computeWordDiff?.(...args) || { old: [], new: [] };
}

// ========================================
// STATE ACCESS
// ========================================

// View Management (proxies to library.js implementation)

/**
 * Switch between top-level views (characters, chats, online).
 * @param {string} view - 'characters' | 'chats' | 'online' | 'ext:<extId>/<id>'
 */
export function switchView(view) {
    window.switchView?.(view);
}

/**
 * A view change the reader asked for: the view.switch command, where an extension may wrap it.
 * @param {string} view - 'characters' | 'chats' | 'online' | 'ext:<extId>/<id>'
 * @returns {Promise<true>|true|undefined}
 */
export function goToView(view) {
    return window.goToView?.(view);
}

/**
 * Get current active view
 * @returns {string} 'characters' | 'chats' | 'online' | 'ext:<extId>/<id>'
 */
export function getCurrentView() {
    return window.getCurrentView?.();
}

/** Repaint the Online provider selector after a late (extension) provider registers. */
export function refreshProviderSelector(...args) {
    return window.refreshProviderSelector?.(...args);
}

/**
 * Register a callback to run each time a specific view becomes active.
 * Modules use this for lazy-loading (e.g. chats loads on first visit).
 * @param {string} view - View name ('characters', 'chats', 'online')
 * @param {function} callback - Function to call when view is entered
 * @returns {Function} the removal
 */
export function onViewEnter(view, callback) {
    return window.onViewEnter?.(view, callback) || (() => {});
}

/**
 * @param {string} view - View name ('characters', 'chats', 'online')
 * @param {function} callback - Function to call when view is exited
 * @returns {Function} the removal
 */
export function onViewExit(view, callback) {
    return window.onViewExit?.(view, callback) || (() => {});
}

/**
 * Get currently filtered/displayed characters
 * @returns {Array} Current character objects
 */
export function getCurrentCharacters() {
    return window.getCurrentCharacters?.() || [];
}

/**
 * Find a cached character by uuid
 * @param {string} charId - Character uuid
 * @returns {Object|undefined} Character object or undefined
 */
export function getCharacterById(charId) {
    return window.getCharacterById?.(charId);
}

/**
 * Be handed the ids of every character this tab lets go of, whoever deleted them; register once.
 * @param {(ids: string[], how: {elsewhere: boolean}) => void} fn elsewhere: another tab or process deleted them
 * @returns {Function} the removal
 */
export function onCharactersDeleted(fn) {
    return window.onCharactersDeleted?.(fn) || (() => {});
}

/**
 * Get a gallery setting
 * @param {string} key - Setting key
 * @returns {*} Setting value
 */
export function getSetting(...args) {
    return window.getSetting?.(...args);
}

/** Send any pending settings write now; resolves when the server has it (await before a server recompute). */
export function flushSettings(...args) {
    return window.flushSettings?.(...args) ?? Promise.resolve();
}

/** Resolves once the boot settings load has ANSWERED; pre-load, reads return defaults and a write ships them. */
export function settingsReady(...args) {
    return window.settingsReady?.(...args) ?? Promise.resolve();
}

/** The shipped default for a key, ignoring any saved value. For reset affordances. */
export function getDefaultSetting(...args) {
    return window.getDefaultSetting?.(...args);
}

/** Write a CSS custom property into the runtime-token layer, which user Custom CSS
 *  still outranks. Never set these as inline styles; inline beats everything. */
export function setRuntimeToken(...args) {
    return window.setRuntimeToken?.(...args);
}

export function removeRuntimeToken(...args) {
    return window.removeRuntimeToken?.(...args);
}

/**
 * Set a gallery setting
 * @param {string} key - Setting key
 * @param {*} value - Setting value
 */
export function setSetting(key, value) {
    window.setSetting?.(key, value);
}

/** Re-read the active persona after it changes. @returns {Promise<string|null>} */
export function syncActivePersonaName(...args) {
    return window.syncActivePersonaName?.(...args);
}

/** The active persona's pronoun forms, as last read; null (not read, or no persona) leaves the five raw. @returns {Object|null} */
export function getPersonaPronouns() {
    return window.getPersonaPronouns?.() ?? null;
}

/**
 * Batch-set multiple settings at once
 * @param {Object} settings - Key/value pairs
 */
export function setSettings(...args) {
    window.setSettings?.(...args);
}

/**
 * Namespace a browser-storage key to the signed-in account
 * @param {...*} args - the unscoped key name
 * @returns {string} the key to actually read or write
 */
export function userScopedKey(...args) {
    return window.userScopedKey?.(...args);
}

export function getProviderExcludeTags(providerId) {
    return window.getProviderExcludeTags?.(providerId) || [];
}

/**
 * Apply the current custom CSS (reads mode + content from settings, writes to live <style> tag)
 * @param {{sync?: boolean}} [opts]
 */
export function applyCustomCSS(...args) {
    window.applyCustomCSS?.(...args);
}

/**
 * Maximum byte size of the emitted custom CSS (raw blob or concatenated snippets)
 */
export function getCustomCSSMaxBytes() {
    return window.CUSTOM_CSS_MAX_BYTES;
}

// ========================================
// UI ACTIONS
// ========================================

/**
 * Open the character detail modal
 * @param {Object} char - Character object
 */
export function openCharacterModal(...args) {
    return window.openModal?.(...args);
}

/**
 * Open a character's details from its id alone (resolved through the cache or one read).
 * @param {string} id
 * @param {{elevated?: boolean, navList?: Object[]}} [opts] elevated keeps the open modal underneath
 * @returns {Promise<boolean>} whether the character was found
 */
export function openCharacterById(id, opts) {
    return window.openCharacterById?.(id, opts) || Promise.resolve(false);
}

/**
 * Open the provider link modal for a character
 * @param {Object} char - Character object
 */
export function openProviderLinkModal(char) {
    window.openProviderLinkModal?.(char);
}

/**
 * Show a toast notification
 * @param {string} message - Message to display
 * @param {string} [type] - 'success' | 'error' | 'warning' | 'info'
 * @param {number} [duration] - Duration in ms
 * @param {{group?: string, item?: *, many?: Function}} [opts] - fold a burst into one toast
 */
export function showToast(...args) {
    window.showToast?.(...args);
}

/** The import pipeline's toast group summary (the many() every caller on the path passes). */
export function summarizeImportActivity(items) {
    return window.summarizeImportActivity?.(items) ?? '';
}

/**
 * Show a canonical confirmation dialog. Returns Promise<boolean>.
 * @param {Object} opts
 * @param {string} [opts.title]
 * @param {string} [opts.message] - Plain text message (escaped)
 * @param {Array<Object>} [opts.content] - Typed content blocks ({type:'text'|'stats'|'list'|'kv'|'note'}), rendered and escaped by the component
 * @param {string} [opts.icon] - FontAwesome class string for the title icon
 * @param {string} [opts.iconColor] - CSS color for the title icon
 * @param {string} [opts.confirmLabel]
 * @param {string} [opts.cancelLabel]
 * @param {boolean} [opts.danger] - Style confirm button as danger (red)
 * @param {Object} [opts.input] - Ask for text: {value, placeholder}. Resolves the trimmed
 *   string instead of true; an empty box cannot be confirmed, so '' is never returned.
 * @returns {Promise<boolean|string>}
 */
export function showConfirm(opts) {
    return window.showConfirm?.(opts) ?? Promise.resolve(false);
}

/**
 * The footer verb of a running operation, in one of its three states.
 * @param {HTMLButtonElement} btn a .cl-btn
 * @param {'running'|'stopping'|'done'} state Cancel (red on hover) / Stopping... (disabled) / Close (neutral)
 */
export function setRunVerb(btn, state) {
    window.setRunVerb?.(btn, state);
}

/** Open the Settings modal via its button (repopulates fields) and jump to a nav section. @returns {Promise<boolean>} */
export function openSettingsToSection(...args) {
    return window.openSettingsToSection?.(...args) ?? false;
}

/**
 * Shared "save preset" picker: type a name to create, or pick an existing preset to overwrite (confirmed).
 * @param {string} title - Dialog title
 * @param {Array<{name: string}>} presets - Existing presets (only `name` is read for the list)
 * @returns {Promise<{name: string, overwriteIndex: number} | null>} overwriteIndex -1 = new, null = cancel
 */
export function savePresetPicker(title, presets) {
    return window.savePresetPicker?.(title, presets) ?? Promise.resolve(null);
}

/**
 * Refresh the character list from server
 * @param {boolean} [forceRefresh] - with opts.held, re-read the held rows first
 * @param {{held?: boolean}} [opts] held: re-read the rows this tab holds too, after a set write it made (by filter, a tag rename, a migration)
 * @returns {Promise<void>} settles when the grid query (and the held re-read) are done
 */
export function refreshCharacters(...args) {
    return window.fetchCharacters?.(...args) ?? Promise.resolve();
}

// ========================================
// GALLERY FUNCTIONS
// ========================================

/**
 * Capped-concurrency thumbnail loader factory; each surface owns its instance
 * @param {Object} opts - { concurrency, onSettled }
 * @returns {{ enqueue: Function, reset: Function }|undefined}
 */
export function createThumbLoader(...args) {
    return window.createThumbLoader?.(...args);
}

export function isMediaLocalizationEnabled() {
    return window.isMediaLocalizationEnabled?.() ?? false;
}

export function buildMediaLocalizationMap(...args) {
    return window.buildMediaLocalizationMap?.(...args) ?? Promise.resolve({});
}

export function replaceMediaUrlsInText(text, urlMap) {
    return window.replaceMediaUrlsInText?.(text, urlMap) ?? text;
}

/**
 * Get gallery info for a character (files, count, items). A failed read rejects.
 * @param {Object} char - Character object
 * @returns {Promise<{files: string[], count: number, items: {name: string, url: string, mediaId: string, kind: string}[]}>}
 */
export function getCharacterGalleryInfo(char, opts) {
    return window.getCharacterGalleryInfo?.(char, opts) || Promise.resolve({ files: [], count: 0, items: [] });
}

/**
 * A character's media rows, every page; a failed read or a missing implementation rejects (unknown is not empty).
 * @param {string} charId
 * @returns {Promise<Object[]>}
 */
export function listCharacterMedia(...args) {
    return window.listCharacterMedia ? window.listCharacterMedia(...args) : Promise.reject(new Error('listCharacterMedia unavailable'));
}

// ========================================
// API REQUESTS
// ========================================

/**
 * Make an API request against the server
 * @param {string} endpoint - API endpoint (without /api prefix)
 * @param {string} [method] - HTTP method
 * @param {Object} [data] - Request body
 * @param {Object} [options] - Additional fetch options
 * @returns {Promise<Response>} Fetch response
 */
export function apiRequest(...args) {
    return window.apiRequest?.(...args);
}

/**
 * An answer's JSON, or the server's refusal thrown in its own words (status and kind ride the error)
 * @param {Response} resp
 * @returns {Promise<*>} the parsed body, null when an ok answer carries none
 */
export function readAnswer(...args) {
    return window.readAnswer ? window.readAnswer(...args) : Promise.reject(new Error('readAnswer unavailable'));
}

/**
 * Per-user store document read: the served document, null on a clean 404, a throw otherwise (missing impl too).
 * @param {string} key
 * @returns {Promise<Object|null>}
 */
export function storeRead(...args) {
    return window.storeRead ? window.storeRead(...args) : Promise.reject(new Error('storeRead unavailable'));
}

/**
 * Per-user store document write (PUT replaces the document); throws on any failure.
 * @param {string} key
 * @param {Object} doc
 * @returns {Promise<void>}
 */
export function storeWrite(...args) {
    return window.storeWrite ? window.storeWrite(...args) : Promise.reject(new Error('storeWrite unavailable'));
}

/**
 * Be told when a held store document was (or may have been) written elsewhere: drop the copy, re-read before writing.
 * @param {string} key
 * @param {Function} fn
 * @returns {Function} the unwatch
 */
export function storeWatch(...args) {
    return window.storeWatch ? window.storeWatch(...args) : () => {};
}

/**
 * A store document held on the one lifecycle (definitive read, drop on a write elsewhere, one
 * queued save that answers whether it landed).
 * @param {string} key
 * @param {Object} opts coerce, toDoc, onDrop, unread, saveFailed
 * @returns {{load, get, loaded, unavailable, save, mutate}}
 */
export function createStoreDocument(...args) {
    return window.createStoreDocument?.(...args);
}

/**
 * Server-served resource path (avatars, thumbs, gallery, raw /api fetches) made
 * absolute against the configured server (detached-frontend seam).
 * @param {string} path - root-relative server path
 * @returns {string}
 */
export function serverUrl(...args) {
    return window.serverUrl?.(...args) ?? (args[0] || '');
}

// ========================================
// MULTI-SELECT SYSTEM
// ========================================

/**
 * Whether multi-select mode is on
 * @returns {boolean}
 */
export function isMultiSelectEnabled() {
    return window.isMultiSelectEnabled?.() ?? false;
}

/**
 * Enable multi-select mode
 */
export function enableMultiSelect() {
    window.MultiSelect?.enable();
}

/**
 * The selected characters (page rows, else { id, fav }); throws under a Select All, read getSelection then.
 * @returns {Array} Selected character objects
 */
export function getSelectedCharacters() {
    return window.MultiSelect?.getSelected() || [];
}

/**
 * The selection as a bulk verb sends it: { count, ids } picked by hand, or { count, filter } for a Select All.
 * @returns {{count: number, ids?: string[], filter?: string}}
 */
export function getSelection() {
    return window.MultiSelect?.getSelection?.() ?? { count: 0, ids: [] };
}

/**
 * Get count of selected characters
 * @returns {number}
 */
export function getSelectionCount() {
    return window.MultiSelect?.getCount() || 0;
}

/**
 * Whether a character is selected
 * @param {string} charId - Character id
 * @returns {boolean}
 */
export function isCharacterSelected(charId) {
    return window.MultiSelect?.isSelected(charId) || false;
}

/**
 * Toggle selection of a character
 * @param {Object} char - Character object
 * @param {HTMLElement} cardElement - Card DOM element
 */
export function toggleCharacterSelection(char, cardElement) {
    window.MultiSelect?.toggle(char, cardElement);
}

/**
 * Clear all selections
 */
export function clearSelection() {
    window.MultiSelect?.clearSelection();
}

// ========================================
// MODULE SYSTEM
// ========================================

/**
 * Get a loaded module by name
 * @param {string} name - Module name
 * @returns {Object|null} Module instance or null
 */
export function getModule(name) {
    return window.ModuleLoader?.get(name) || null;
}

// ========================================
// UTILITIES
// ========================================

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
export function escapeHtml(text) {
    return window.escapeHtml?.(text) ?? '';
}

/**
 * Sanitize HTML safely. Falls back to escapeHtml if DOMPurify is unavailable
 * and forces rel="noopener noreferrer" on links with target attributes.
 * @param {string} html - HTML to sanitize
 * @param {object} [config] - DOMPurify config
 * @returns {string} Sanitized HTML
 */
export function safePurify(html, config) {
    return window.safePurify?.(html, config) ?? '';
}

/**
 * Sanitize a tagline HTML string (strips dangerous elements, keeps safe formatting)
 * @param {string} html - Raw tagline HTML from external data
 * @returns {string} Sanitized HTML
 */
export function sanitizeTaglineHtml(...args) {
    return window.sanitizeTaglineHtml?.(...args) || '';
}

/** Editable tag chips into a container; onRemove(tag) runs on a chip's remove button. */
export function renderEditableTagChips(...args) {
    return window.renderEditableTagChips?.(...args);
}

/** Clamp a container of tag pills to the rows that fit and keep it clamped through resizes; the look names its classes. */
export function clampTagRows(...args) {
    return window.clampTagRows?.(...args);
}

/** A tri-state tag toggle's look for a state: { state, icon, title }. */
export function tagStateLook(...args) {
    return window.tagStateLook?.(...args);
}

/** A random id of lower-case letters and digits, `length` long (12 by default). */
export function randomId(...args) {
    return window.randomId?.(...args) ?? '';
}

/** Drag to reorder a list's items (a touch drags from the handle); see library.js wireDragReorder. */
export function wireDragReorder(...args) {
    return window.wireDragReorder?.(...args);
}

/** How long ago a time was, the short form: just now, 5m ago, 3h ago, 2d ago, 4mo ago, 1y ago. */
export function formatRelativeAge(...args) {
    return window.formatRelativeAge?.(...args) ?? '';
}

/**
 * Create a debounced version of a function
 * @param {Function} func - Function to debounce
 * @param {number} wait - Delay in ms
 * @returns {Function} Debounced function
 */
export function debounce(...args) {
    return window.debounce?.(...args) ?? args[0];
}

/**
 * Truncate a string to a maximum length, appending '...' if truncated
 * @param {string} str - String to truncate
 * @param {number} max - Maximum length
 * @returns {string} Truncated string
 */
export function truncate(str, max) {
    return window.truncate?.(str, max) ?? '';
}

/**
 * A count as a stat line shows it: 1.2K, 3.4M, anything smaller as its string
 * @param {number} num
 * @returns {string}
 */
export function formatNumber(...args) {
    return window.formatNumber?.(...args) ?? String(args[0]);
}

/**
 * A byte count as the app shows one: 512 B, 1.5 KB, 3.2 MB, 1.25 GB ('-' for no number)
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(...args) {
    return window.formatBytes?.(...args);
}

/**
 * Live mobile-mode check (html.cl-mobile). Evaluate at event time; the mode can flip mid-session.
 * @returns {boolean} Whether mobile mode is active
 */
export function isMobileMode() {
    return window.isMobileMode?.() ?? false;
}

/**
 * The behavior a scripted scroll takes: 'auto' when the reader asked for reduced motion, 'smooth' otherwise
 * @returns {ScrollBehavior|undefined}
 */
export function scrollBehavior(...args) {
    return window.scrollBehavior?.(...args);
}

/**
 * The canonical mobile bottom sheet (drag-dismiss enrolled); null on desktop, so check at CALL time, not init.
 * @param {{label?: string}} [opts] the sheet's accessible name; without one, its title names it at open
 * @returns {{overlay: HTMLElement, sheet: HTMLElement, close: Function, open: Function}|null}
 */
export function createMobileSheet(...args) {
    return window.clCreateMobileSheet?.(...args) ?? null;
}

/**
 * Get tags for a character (normalized)
 * @param {Object} char - Character object
 * @returns {Array<string>} Tags array
 */
export function getCharacterTags(char) {
    return window.getTags?.(char) || [];
}

/**
 * Tag names containing q (case folded) in name order, at most limit (default 10); none when the read fails.
 * @param {string} q
 * @param {{limit?: number}} [opts]
 * @returns {Promise<string[]>}
 */
export function suggestTags(...args) {
    return window.suggestTags ? window.suggestTags(...args) : Promise.resolve([]);
}

/**
 * Run a tag array through the user's alias ruleset
 * @param {Array<string>} tags
 * @returns {Array<string>} Aliased tags (input returned untouched when no rules active)
 */
export function applyTagAliases(...args) {
    return window.applyTagAliases?.(...args) || args[0] || [];
}

/**
 * Strip emoji/decoration from one tag (the Import Rules toggle's normalizer)
 * @param {string} tag
 * @returns {string}
 */
export function stripTagDecoration(...args) {
    return window.stripTagDecoration?.(...args) ?? args[0] ?? '';
}

/**
 * Compile the alias ruleset (exact Map + ordered regex rules + per-rule errors)
 * @param {Array<{match: string, replace: string}>} rules
 * @returns {Object}
 */
export function compileTagAliasRules(...args) {
    return window.compileTagAliasRules?.(...args) || { list: [], exactIdx: new Map(), regexRules: [], hasUsable: false };
}

/**
 * First matching compiled rule for one trimmed tag, in rule order, or null
 * @param {Object} compiled
 * @param {string} tag
 * @returns {Object|null}
 */
export function matchTagAliasRule(...args) {
    return window.matchTagAliasRule?.(...args) ?? null;
}

/**
 * Filter the library grid to one included tag
 * @param {string} tag
 */
export function filterLibraryByTag(...args) {
    return window.filterLibraryByTag?.(...args);
}

/**
 * Remap (rename/merge) or drop (delete) an active grid tag filter after a bulk tag rewrite
 * @param {string} oldTag
 * @param {string|null} newTag
 */
export function renameActiveTagFilter(...args) {
    return window.renameActiveTagFilter?.(...args);
}

/**
 * Re-run every active grid tag filter through the alias ruleset (after Apply to Library)
 */
export function reconcileTagFiltersWithAliases(...args) {
    return window.reconcileTagFiltersWithAliases?.(...args);
}

// ========================================
// DOM HELPERS
// ========================================

/**
 * Show an element by removing 'hidden' class
 * @param {string} id - Element ID
 */
export function showElement(id) {
    window.showElement?.(id);
}

/**
 * Hide an element by adding 'hidden' class
 * @param {string} id - Element ID
 */
export function hideElement(id) {
    window.hideElement?.(id);
}

/**
 * Hide a modal (adds 'hidden' class, cleans up overlay)
 * @param {string} modalId - Modal element ID
 */
export function hideModal(modalId) {
    window.hideModal?.(modalId);
}

/**
 * Bind an event listener to an element by ID
 * @param {string} id - Element ID
 * @param {string} event - Event name
 * @param {Function} handler - Event handler
 * @returns {boolean} Whether the element was found
 */
export function onElement(id, event, handler) {
    return window.onElement?.(id, event, handler) ?? false;
}

export function fitTextarea(...args) {
    return window.fitTextarea?.(...args);
}

/**
 * Convert a native <select> into the styled custom dropdown.
 * @param {HTMLSelectElement} select - The <select> element to transform
 */
export function initCustomSelect(...args) {
    window.initCustomSelect?.(...args);
}

/**
 * Hold an element at the widest state measure() lays out, its border and rounding counted.
 * @param {HTMLElement} el
 * @param {() => number} measure lays out each state and returns the widest scrollWidth
 */
export function lockMinWidth(...args) {
    window.lockMinWidth?.(...args);
}

/**
 * Keep a bar's entries to what fits, the rest behind its More (listed, labelled, on press).
 * @param {HTMLElement} row - The box the entries share, sized by its container
 * @param {{ entries: () => HTMLElement[], more: HTMLElement, always?: Function, current?: string, marked?: string, working?: string, separators?: string, watch?: boolean, label?: Function }} spec
 */
export function fitRow(row, spec) {
    window.fitRow?.(row, spec);
}

/** Refit a bar after its entries changed. */
export function refitRow(row) {
    window.refitRow?.(row);
}

// ========================================
// RENDERING HELPERS
// ========================================

/**
 * Render a loading spinner inside a container
 * @param {HTMLElement} container - Container element
 * @param {string} message - Loading message
 * @param {string} [className] - CSS class name
 */
export function renderLoadingState(...args) {
    window.renderLoadingState?.(...args);
}

export function renderSkeletonGrid(...args) {
    window.renderSkeletonGrid?.(...args);
}

export function openUserGuide(...args) {
    window.openUserGuide?.(...args);
}

export function renderEmptyState(container, opts) {
    window.renderEmptyState?.(container, opts);
}

export function getCharacterAvatarSmallThumbUrl(...args) {
    return window.getCharacterAvatarSmallThumbUrl?.(...args) ?? '';
}

export function getCharacterAvatarThumbUrl(...args) {
    return window.getCharacterAvatarThumbUrl?.(...args) ?? '';
}

export function thumbUrl(...args) {
    return window.thumbUrl?.(...args) ?? '';
}

export function makeFloatingWindow(...args) {
    return window.makeFloatingWindow?.(...args);
}

/** The grips a window carries; the first one is focusable. */
export function windowGripsHtml(...args) {
    return window.windowGripsHtml?.(...args) ?? '';
}

/** One window's stored geometry, null when nothing was stored. */
export function getWindowGeometry(...args) {
    return window.getWindowGeometry?.(...args) ?? null;
}

/** One window's shipped geometry, null for a surface its stylesheet sizes. */
export function getDefaultWindowGeometry(...args) {
    return window.getDefaultWindowGeometry?.(...args) ?? null;
}

/** Store one window's geometry, or clear it with null. */
export function setWindowGeometry(...args) {
    return window.setWindowGeometry?.(...args);
}

/** Give a dialog (an overlay id, the overlay, or its content) the resize grips; idempotent. */
export function mountDialogSizing(...args) {
    return window.mountDialogSizing?.(...args);
}

/** Mount every dialog under a root that is not mounted yet. */
export function mountDialogs(...args) {
    return window.mountDialogs?.(...args);
}

/** Give a pane a pull seam whose width persists under `<overlayId>:sidebar`. */
export function mountSeam(...args) {
    return window.mountSeam?.(...args);
}

export function buildGalleryViewerMedia(...args) {
    return window.buildGalleryViewerMedia?.(...args) ?? [];
}

/** A media item's or file name's kind, 'image', 'video' or 'audio' (the server's kind first), else null. */
export function galleryKindOf(...args) {
    return window.galleryKindOf?.(...args) ?? null;
}

/**
 * @param {Object} char
 * @returns {string|null}
 */
export function getListingNameFromExtensions(char) {
    return window.getListingNameFromExtensions?.(char) ?? null;
}

export function bumpAvatarCacheBust(...args) {
    return window.bumpAvatarCacheBust?.(...args);
}

/**
 * Replace a character's picture; throws the server's refusal.
 * @param {string} charId
 * @param {Blob|ArrayBuffer|Uint8Array} bytes
 * @returns {Promise<void>}
 */
export function editAvatar(...args) {
    return window.editAvatar?.(...args) || Promise.reject(new Error('the picture could not be saved'));
}

export function getCharacterAvatarUrl(...args) {
    return window.getCharacterAvatarUrl?.(...args) ?? '';
}

export function copyTextToClipboard(...args) {
    return window.copyTextToClipboard?.(...args) ?? Promise.resolve(false);
}

export function getDisplayTagline(...args) {
    return window.getDisplayTagline?.(...args) ?? '';
}

export function getCharacterName(...args) {
    return window.getCharacterName?.(...args) ?? args[0]?.name ?? '';
}

export function renderLorebookEntriesHtml(...args) {
    return window.renderLorebookEntriesHtml?.(...args) ?? '';
}

/**
 * Format rich text (markdown-like formatting for chat messages)
 * @param {string} text - Raw text
 * @param {string} charName - Character name for substitution
 * @param {boolean} preserveHtml - Whether to preserve existing HTML
 * @param {object} [opts] - macros (false shows the text as stored), pronouns (with macros false, the five pronoun macros alone answered from these forms)
 * @returns {string} Formatted HTML
 */
export function formatRichText(...args) {
    return window.formatRichText?.(...args) ?? '';
}

/**
 * Format a chat message body (markdown plus the speech/narration registers)
 * @param {string} text - Raw message text
 * @param {string} charName - Character name for substitution
 * @param {object} [opts] - macros (false shows the text as stored), userName, pronouns (with macros false, the five pronoun macros alone answered from these forms), macroSpans, quoteFamilies, repairEmphasis, escapeStrings, streaming (true, or 'live' to shape blocks as they arrive), openIslands (false keeps an unclosed html block text)
 * @returns {string} Unsanitised HTML; pair it with safePurify(..., CHAT_PURIFY_CONFIG)
 */
export function formatChatText(...args) {
    return window.formatChatText?.(...args) ?? '';
}

/**
 * Whether Format as it streams applies to a surface's partial reply: its override, else the chat's switch
 * @param {'chat'|'assistant'|'creator'} surface
 * @returns {boolean} true to paint the partial with formatChatText's streaming: 'live'
 */
export function liveFormattingOn(surface) {
    return window.liveFormattingOn?.(surface) ?? false;
}

/**
 * The five pronoun macros in plain text answered from a persona's forms
 * @param {string} text
 * @param {Object|null} forms - { sub, obj, poss, possP, ref }; null leaves them raw, an empty form answers its they/them word
 * @returns {string}
 */
export function answerPronounMacros(text, forms) {
    return window.answerPronounMacros?.(text, forms) ?? text;
}

// ========================================
// CHARACTER ACTIONS
// ========================================

/**
 * Delete a character from the local library (chats and media cascade server-side)
 * @param {Object} char - Character object
 * @returns {Promise<boolean>} Success
 */
export function deleteCharacter(...args) {
    return window.deleteCharacter?.(...args) || Promise.resolve(false);
}

/**
 * Open the single-character delete confirmation dialog (gallery info + chat-cascade notice).
 * @param {Object} char
 */
export function showDeleteConfirmation(char) {
    return window.showDeleteConfirmation?.(char);
}

/**
 * @param {...*} args - charId, options
 * @returns {Promise<Object|null>}
 */
export function fetchAndAddCharacter(...args) {
    return window.fetchAndAddCharacter?.(...args) ?? Promise.resolve(null);
}

/**
 * @param {string} charId - a character this tab just created
 * @param {Object} [row] - its row as the list answers it, when the write answered one (no read then)
 * @returns {Promise<Object|null>} the cached row
 */
export function adoptCreatedCharacter(...args) {
    return window.adoptCreatedCharacter?.(...args) ?? Promise.resolve(null);
}

/**
 * Fetch heavy fields for a slim character object (no-op if already hydrated).
 * @param {Object} char - Character object (may be slim)
 * @returns {Promise<Object>} The same char with heavy fields populated
 */
export function hydrateCharacter(char) {
    return window.hydrateCharacter?.(char) || Promise.resolve(char);
}

/**
 * Hydrate the slim rows among `chars` in chunks; progress before each chunk, AbortError
 * between chunks on an aborted signal.
 * @param {Object[]} chars
 * @param {{chunk?: number, signal?: AbortSignal, onProgress?: Function}} [opts]
 * @returns {Promise<number>} how many rows were slim
 */
export function hydrateMany(...args) {
    return window.hydrateMany?.(...args) ?? Promise.resolve(0);
}

/**
 * The current view's filter in GET /characters' grammar, or null when the view can match nothing.
 * @returns {string|null}
 */
export function currentViewFilter() {
    return window.currentViewFilter?.() ?? null;
}

/**
 * A filter narrowed by one more advanced rule (the rules AND, so no parameter is overridden).
 * @param {string} filter a GET /characters query string
 * @param {{field: string, op: string, value?: *}} rule
 * @returns {string}
 */
export function narrowFilter(...args) {
    return window.narrowFilter?.(...args);
}

/**
 * Whether two filters name the same set (order, paging and counting aside).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameSet(...args) {
    return !!window.sameSet?.(...args);
}

/**
 * Whether a filter names no subset, so its set is the whole library.
 * @param {string} filter
 * @returns {boolean}
 */
export function filterNamesNothing(...args) {
    return !!window.filterNamesNothing?.(...args);
}

/**
 * A filter's set a page at a time as set rows ({ id, fav } + the named fields), never held whole.
 * @param {string} filter a GET /characters query string
 * @param {{fields?: string[], signal?: AbortSignal}} [opts]
 * @returns {AsyncGenerator<Object[]>}
 */
export function walkCharacterSetWhere(...args) {
    return window.walkCharacterSetWhere(...args);
}

/**
 * Bulk resolve characters by uuid. Missing ids are absent from the result (existence-check
 * semantics); {strict: true} throws when a chunk fails instead.
 * @param {string[]} ids
 * @param {{strict?: boolean}} [opts]
 * @returns {Promise<Array>}
 */
export function fetchCharactersByIds(...args) {
    return window.fetchCharactersByIds?.(...args) || Promise.resolve([]);
}

/**
 * Scoped character list query; keys map onto GET /api/characters params.
 * @param {Object} params
 * @returns {Promise<Array>}
 */
export function fetchCharactersPage(...args) {
    return window.fetchCharactersPage?.(...args);
}

export function fetchCharacterIdsWhere(...args) {
    return window.fetchCharacterIdsWhere?.(...args);
}

/**
 * Every character a filter matches as a set row ({ id, fav } + the named fields), in one request.
 * @param {Object} params GET /characters filter params
 * @param {string[]} fields
 * @returns {Promise<Array>}
 */
export function fetchCharacterSetWhere(...args) {
    return window.fetchCharacterSetWhere?.(...args) || Promise.resolve([]);
}

/**
 * A whole list walked by its cursor; a failed page, a cursorless full page or a missing impl throws (never a short set).
 * @param {string} path a list endpoint, without /api
 * @param {Object|URLSearchParams} [params] its query, kept on every page
 * @param {{pageSize?: number, key?: string}} [opts] the rows a page asks for, and the answer's list key
 * @returns {Promise<Array>}
 */
export function fetchAllPages(...args) {
    return window.fetchAllPages ? window.fetchAllPages(...args) : Promise.reject(new Error('fetchAllPages unavailable'));
}

export function fetchCharactersWhere(...args) {
    return window.fetchCharactersWhere?.(...args) || Promise.resolve([]);
}

/**
 * Cache-or-fetch one character by uuid; {force: true} re-reads the server.
 * @param {string} id
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<Object|null>}
 */
export function ensureCharacterById(...args) {
    return window.ensureCharacterById?.(...args) || Promise.resolve(null);
}

/**
 * The library-wide character count as the server last answered it; null while unknown (whenLibraryTotal waits for it).
 * @returns {number|null}
 */
export function getLibraryTotal(...args) {
    return window.getLibraryTotal?.(...args);
}

/**
 * The library-wide character count once known: at once when held, else after one read; null when the read failed.
 * @returns {Promise<number|null>}
 */
export function whenLibraryTotal(...args) {
    return window.whenLibraryTotal?.(...args) ?? Promise.resolve(null);
}

/**
 * Run the current search/filter/sort pipeline and re-render the grid
 */
export function performSearch() {
    window.performSearch?.();
}

/**
 * Toggle a character's favorite status (write + grid badge + toasts)
 * @param {Object} char - Character object
 */
export function toggleCharacterFavorite(...args) {
    return window.toggleCharacterFavorite?.(...args);
}

/**
 * Whether a character is a favorite, read off its row (the fav column) or its card's extensions mirror
 * @param {Object} char - a character, or a selection's { id, fav } row
 * @returns {boolean}
 */
export function isCharacterFavorite(...args) {
    return window.isCharacterFavorite?.(...args) ?? false;
}

/**
 * Download a Blob as a file via anchor click
 * @param {Blob} blob - Content to download
 * @param {string} filename - Suggested filename
 */
export function downloadBlobAsFile(...args) {
    return window.downloadBlobAsFile?.(...args);
}

/**
 * Search-filter a row list with an inline "Create <query>" row on no exact match
 * @param {Object} cfg - { searchId, listId, rowSel, nameOf, createRowClass, createRowHtml, onCreate, emptyId? }
 */
export function filterListWithInlineCreate(...args) {
    return window.filterListWithInlineCreate?.(...args);
}

export function getAdvFilterRulesForChats() {
    return window.getAdvFilterRulesForChats?.() ?? [];
}


// ========================================
// LOGGING
// ========================================

/**
 * Debug log (only outputs when debug mode is enabled)
 * @param {...*} args - Arguments to log
 */
export function debugLog(...args) {
    window.debugLog?.(...args);
}

// ========================================
// CREATOR NOTES
// ========================================

/**
 * Render creator notes into a container with safe HTML handling
 * @param {string} content - Raw creator notes content
 * @param {string} charName - Character name
 * @param {HTMLElement} container - Target container
 */
export function renderCreatorNotesSecure(content, charName, container) {
    window.renderCreatorNotesSecure?.(content, charName, container);
}

/**
 * Render any third-party card field (description etc.) via the sandboxed iframe pipeline
 * @param {...*} args - content, charName, container
 */
export function renderCardHtmlSecure(...args) {
    return window.renderCardHtmlSecure?.(...args);
}

/**
 * Clean up a creator notes container (remove event listeners, observers, etc.)
 * @param {HTMLElement} container - Container to clean up
 */
export function cleanupCreatorNotesContainer(container) {
    window.cleanupCreatorNotesContainer?.(container);
}

export async function autoSnapshotBeforeChange(char, reason, opts) {
    return window.autoSnapshotBeforeChange?.(char, reason, opts);
}

// ========================================
// IMPORT / DOWNLOAD PIPELINE
// ========================================

/**
 * Async duplicate check with hydration for cross-provider matching
 * @param {Object} newChar - Character card to check
 * @returns {Promise<Array>} Duplicate matches sorted by score
 */
export function checkCharacterForDuplicatesAsync(...args) {
    return window.checkCharacterForDuplicatesAsync?.(...args) || Promise.resolve([]);
}

/**
 * Show a pre-import duplicate warning modal
 * @param {Object} newCharInfo - Info about the character being imported
 * @param {Array} matches - Duplicate matches from checkCharacterForDuplicates
 * @returns {Promise<{choice: string}>} User's choice ('import' | 'replace' | 'skip')
 */
export function showPreImportDuplicateWarning(newCharInfo, matches) {
    return window.showPreImportDuplicateWarning?.(newCharInfo, matches) || Promise.resolve({ choice: 'skip' });
}

/**
 * Find all referenced media URLs in a character card's fields
 * @param {Object} card - Character card
 * @returns {Array<string>} Media URLs found
 */
export function findCharacterMediaUrls(...args) {
    return window.findCharacterMediaUrls?.(...args) || [];
}

/**
 * All scannable text chunks of a hydrated card, lorebook separate
 * @param {Object} character
 * @returns {{ main: string[], lorebook: string[] }}
 */
export function collectCardTextChunks(...args) {
    return window.collectCardTextChunks?.(...args) ?? { main: [], lorebook: [] };
}

/**
 * Lazy-load the gallery extractors (no-op once loaded)
 * @returns {Promise<void>}
 */
export function ensureExtractorsLoaded(...args) {
    return window.ensureExtractorsLoaded?.(...args) ?? Promise.resolve();
}

/**
 * Gallery page URLs found in a card's text (empty until extractors are loaded)
 * @param {Object} character
 * @returns {Array<string>}
 */
export function findCharacterGalleryUrls(...args) {
    return window.findCharacterGalleryUrls?.(...args) ?? [];
}

/**
 * Show the import summary modal after downloading a character
 * @param {Object} summaryData - Import summary details
 */
export function showImportSummaryModal(summaryData) {
    window.showImportSummaryModal?.(summaryData);
}

/**
 * Queue background media-download jobs for freshly imported characters
 * @param {Object} summaryData - Same {galleryCharacters, mediaCharacters} shape as the summary modal
 * @returns {number} count of queued jobs
 */
export function queueImportMediaJobs(...args) {
    return window.queueImportMediaJobs?.(...args) ?? 0;
}

/**
 * Collapse all sections of a browse preview modal (fresh-open state)
 * @param {HTMLElement} modal
 */
export function resetBrowseSectionCollapseState(...args) {
    return window.resetBrowseSectionCollapseState?.(...args);
}

/**
 * Publish the open browse preview's alt greetings for the fullscreen expander
 * @param {Array<string>|null} greetings
 */
export function setBrowseAltGreetings(...args) {
    return window.setBrowseAltGreetings?.(...args);
}

/**
 * Convert an image (any format) to PNG
 * @param {Blob|ArrayBuffer} imageBuffer - Source image
 * @returns {Promise<Blob>} PNG blob
 */
export function convertImageToPng(...args) {
    return window.convertImageToPng?.(...args) || Promise.resolve(null);
}

/**
 * Embed character JSON data into a PNG file's tEXt chunk
 * @param {Blob|ArrayBuffer} pngBuffer - PNG image data
 * @param {Object} characterJson - Character data to embed
 * @returns {Promise<Blob>} PNG with embedded data
 */
export function embedCharacterDataInPng(...args) {
    return window.embedCharacterDataInPng?.(...args) || Promise.resolve(null);
}

// ========================================
// GALLERY MEDIA PIPELINE
// ========================================

/**
 * @param {string} charId - Character id
 * @returns {Promise<Map<string, {fileName: string, localPath: string}>>}
 */
export function getExistingFileIndex(...args) {
    return window.getExistingFileIndex?.(...args) || Promise.resolve(new Map());
}

/**
 * @param {string} url
 * @returns {string}
 */
export function extractSanitizedUrlName(url) {
    return window.extractSanitizedUrlName?.(url) || '';
}

/**
 * @param {string} filename
 * @returns {string}
 */
export function sanitizeMediaFilename(...args) {
    return window.sanitizeMediaFilename?.(...args) || '';
}

/**
 * Build shared dedup state for a character's gallery. Call once, pass to all download phases.
 * @param {string} charId - Character id
 * @returns {Promise<Object>}
 */
export function buildDedupState(...args) {
    return window.buildDedupState?.(...args);
}

/**
 * Unified media download pipeline. Downloads all applicable media for a character.
 * @param {Object|string} charOrId - Character object or id
 * @param {Object} [options]
 * @returns {Promise<Object>} PipelineResult
 */
export function downloadCharacterMedia(...args) {
    return window.downloadCharacterMedia?.(...args);
}

/** Mark a character's media localization as complete (Files-API set). */
export function markMediaLocalizationComplete(...args) {
    return window.markMediaLocalizationComplete?.(...args);
}

/** Contribute a section to the topbar notifications dropdown. */
export function registerNotificationSection(...args) {
    return window.registerNotificationSection?.(...args);
}

/** Take a notifications section out by id; with its cfg, only while that cfg is the one registered. */
export function removeNotificationSection(...args) {
    return window.removeNotificationSection?.(...args);
}

/** Recompute the notifications button icon/badge/visibility from all sections. */
export function refreshNotificationsUI(...args) {
    return window.refreshNotificationsUI?.(...args);
}

/** Rebuild the topbar menu's extension section from the app slot, for the current view. */
function renderExtensionAppActions(...args) {
    return window.renderExtensionAppActions?.(...args);
}

/** Inject a provider settings section; false while the settings modal is not set up yet. */
function injectProviderSettingsSection(...args) {
    return window.injectProviderSettingsSection?.(...args) ?? false;
}

/** Take an injected provider settings section back out; a static section is never touched. */
function removeProviderSettingsSection(...args) {
    return window.removeProviderSettingsSection?.(...args) ?? false;
}

/** Put an overlay in the app's stack (the phone's back and Escape close the topmost). */
function registerOverlay(cfg) { return window.registerOverlay?.(cfg); }
/** Take an overlay out of the stack, for one that leaves before the page does. */
function unregisterOverlay(id) { return window.unregisterOverlay?.(id); }

/** The shell plumbing the extension host runs on, kept off the facade an extension is handed (it uses ctx doors). */
export const hostBridge = Object.freeze({ renderExtensionAppActions, injectProviderSettingsSection, removeProviderSettingsSection, registerOverlay, unregisterOverlay });
/** Whether a registered overlay is open, the ids in except aside. */
export function hasOpenOverlay(...args) { return window.hasOpenOverlay?.(...args) ?? false; }

/**
 * Download a remote media file into memory
 * @param {string} url - Media URL
 * @param {number} [timeoutMs] - Timeout in ms
 * @param {AbortSignal} [abortSignal] - Optional abort signal
 * @returns {Promise<Object>} { arrayBuffer, contentType, filename }
 */
export function downloadMediaToMemory(...args) {
    return window.downloadMediaToMemory?.(...args) || Promise.resolve(null);
}

/**
 * Whether a URL is safe to download from (refuses private IPs, internal hostnames, non-http schemes).
 * @param {string} url
 * @returns {{ ok: boolean, reason?: string }}
 */
export function isUrlSafeForDownload(url) {
    return window.isUrlSafeForDownload?.(url) || { ok: false, reason: 'safety check unavailable' };
}

/**
 * Calculate a SHA-256 hash of an ArrayBuffer
 * @param {ArrayBuffer} arrayBuffer - Data to hash
 * @returns {Promise<string>} Hex hash string
 */
export function calculateHash(arrayBuffer) {
    return window.calculateHash?.(arrayBuffer) || Promise.resolve('');
}

// ========================================
// PROVIDER LINK UI
// ========================================

// ========================================
// CARD DATA
// ========================================

/**
 * Extract character data from PNG buffer
 * @param {ArrayBuffer} pngBuffer - PNG file data
 * @returns {Promise<Object|null>|null} Parsed character card or null (await it)
 */
export function extractCharacterDataFromPng(pngBuffer) {
    return window.extractCharacterDataFromPng?.(pngBuffer) || null;
}

/**
 * THE card-write primitive: one PATCH of only the changed fields, then in-memory sync. null (or FIELD_DELETE_MARKER) deletes.
 * @param {Object|string} charOrId - character object (live ref, mutated in place) or id string
 * @param {Object} fieldUpdates - Object with dot-path keys to values
 * @param {Object} [opts] - rootFields: payload-root key/values (fav)
 * @returns {Promise<{ok: boolean, error?: string, told?: boolean}>} error is the server's words; told: the reader saw them (no extra toast)
 */
export function writeCardFields(...args) {
    return window.writeCardFields?.(...args) || Promise.resolve({ ok: false });
}

/**
 * The value meaning "delete this extension key" (the write path maps it to null).
 * @returns {Promise<string|null>}
 */
export function getExtensionDeleteValue() {
    return window.getExtensionDeleteValue?.() ?? Promise.resolve(null);
}

/**
 * Get the linked world info name for a character (async: the server holds the list)
 * @param {string} charId - Character id
 * @returns {Promise<string|null>} The world info name or null
 */
export function getCharacterWorldName(charId) {
    return window.getCharacterWorldName?.(charId) || null;
}

/** A native world document as an embedded character_book, SillyTavern's own export mapping. */
export function convertWorldToCharacterBook(world, name) {
    return window.convertWorldToCharacterBook?.(world, name) || { name: '', entries: [] };
}

/**
 * Fetch a world document
 * @param {string} worldName - The world name to fetch
 * @param {{ throwUnread?: boolean }} [opts] - throwUnread: a failure other than a missing book throws
 * @returns {Promise<Object|null>} World info data or null
 */
export function getWorldInfoData(worldName, opts) {
    return window.getWorldInfoData?.(worldName, opts) || Promise.resolve(null);
}

/**
 * Save a world document
 * @param {string} worldName - The world name to save
 * @param {Object} data - World info data object
 * @returns {Promise<boolean>} Success
 */
export function saveWorldInfoData(...args) {
    return window.saveWorldInfoData?.(...args) || Promise.resolve(false);
}

/**
 * List all world info files available on the server.
 * @returns {Promise<Array<{file_id: string, name: string, extensions: Object}>|null>} null when the shelf could not be read
 */
export function listWorldInfoFiles(...args) {
    return window.listWorldInfoFiles ? window.listWorldInfoFiles(...args) : Promise.reject(new Error('listWorldInfoFiles unavailable'));
}

/**
 * A lorebook created, never written over one.
 * @returns {Promise<'created'|'exists'|null>}
 */
export function createWorldInfoData(...args) {
    return window.createWorldInfoData?.(...args) ?? Promise.resolve(null);
}

/**
 * Create a new (empty) world info file.
 * @param {string} worldName
 * @returns {Promise<boolean>} Success
 */
export function createWorldInfo(worldName) {
    return window.createWorldInfo?.(worldName) || Promise.resolve(false);
}

/**
 * Delete a world; the server cascades its entries and every binding.
 * @param {string} worldName
 * @returns {Promise<{unbound: number}|false>} how many bindings went, or false
 */
export function deleteWorldInfo(...args) {
    return window.deleteWorldInfo?.(...args) || Promise.resolve(false);
}

/**
 * Announce a world change for writers outside saveWorldInfoData (eg. the granular entry endpoints).
 * @param {string|null} worldName null when several changed or the writer cannot say
 */
export function notifyWorldsChanged(...args) {
    return window.notifyWorldsChanged?.(...args);
}

/**
 * Announce that one character changed, for writers outside writeCardFields.
 * @param {string} charId
 * @param {string} [source] so the writing surface can ignore its own echo
 */
export function notifyCharacterChanged(...args) {
    return window.notifyCharacterChanged?.(...args);
}

/**
 * Rename a world in one server transaction (row, entries, every binding).
 * @param {string} oldName
 * @param {string} newName
 * @param {string} [source] the announcing surface, so it can ignore its own echo
 * @returns {Promise<{touched: number}|false>} the re-pointed binding count, or false
 */
export function renameWorldInfo(...args) {
    return window.renameWorldInfo?.(...args) || Promise.resolve(false);
}

/**
 * Import a native ST world JSON object under a destination name.
 * @param {string} worldName
 * @param {Object} worldData - must contain an `entries` object
 * @returns {Promise<boolean>} Success
 */
export function importWorldInfoData(worldName, worldData) {
    return window.importWorldInfoData?.(worldName, worldData) || Promise.resolve(false);
}

/**
 * Add/remove lorebook links on one character (server-side atomic; no list read).
 * @param {string} charId
 * @param {{add?: string[], remove?: string[]}} delta
 * @returns {Promise<boolean>} Success
 */
export function applyCharWorlds(...args) {
    return window.applyCharWorlds?.(...args) || Promise.resolve(false);
}

/**
 * Add/remove books on the global lorebook list (server-side atomic; no list read).
 * @param {{add?: string[], remove?: string[]}} delta
 * @returns {Promise<boolean>} Success
 */
export function applyGlobalWorlds(...args) {
    return window.applyGlobalWorlds?.(...args) || Promise.resolve(false);
}

/**
 * Add/remove books on one persona's bound list (server-side atomic; no list read).
 * @param {string} personaId
 * @param {{add?: string[], remove?: string[]}} delta
 * @returns {Promise<boolean>} Success
 */
export function applyPersonaWorlds(...args) {
    return window.applyPersonaWorlds?.(...args) || Promise.resolve(false);
}

/**
 * Atomic add/remove on a chat's lorebook list (chats module owned); never a whole-list PUT a failed read could empty.
 * @param {string} chatId - the chat row id; a chat is never addressed by its name
 * @param {{add?: string[], remove?: string[]}} delta
 * @returns {Promise<boolean>} Success
 */
export function applyChatWorlds(...args) {
    return window.chatsModule?.applyChatWorlds?.(...args) || Promise.resolve(false);
}

/**
 * Add/remove books on a set of chats, one transaction a request (the Lorebook Manager's bulk bind).
 * @param {string[]} chatIds
 * @param {{add?: string[], remove?: string[], source?: string}} delta
 * @returns {Promise<{ok: boolean, deltas: Array, error: string|null}>}
 */
export function applyChatWorldsBatch(...args) {
    return window.chatsModule?.applyChatWorldsBatch?.(...args) || Promise.reject(new Error('the chats module is not loaded'));
}

// ========================================
// PROVIDER REGISTRY
// Generic provider-agnostic functions for linking, updates, etc.
// ========================================

/**
 * Get all registered providers.
 * @returns {import('./providers/provider-interface.js').ProviderBase[]}
 */
export function getAllProviders() {
    return ProviderRegistry.getAllProviders();
}

/**
 * Get a specific provider by ID.
 * @param {string} id
 * @returns {import('./providers/provider-interface.js').ProviderBase|undefined}
 */
export function getProvider(providerId) {
    return ProviderRegistry.getProvider(providerId);
}

/**
 * Find which provider owns a character (checks all registered providers).
 * @param {Object} char - Character object
 * @returns {{ provider: Object, linkInfo: Object }|null}
 */
export function getCharacterProvider(char) {
    return ProviderRegistry.getCharacterProvider(char);
}

/**
 * Get link info for a character from any provider.
 * Generic replacement for getChubLinkInfo().
 * @param {Object} char
 * @returns {Object|null} ProviderLinkInfo
 */
export function getProviderLinkInfo(char) {
    return ProviderRegistry.getLinkInfo(char);
}

/**
 * The linked set from the server, each paired with its provider and link.
 * @returns {Promise<Array<{char: Object, provider: Object, linkInfo: Object}>>}
 */
export function getAllLinkedCharacters(...args) {
    return window.getAllLinkedCharacters?.(...args) ?? Promise.resolve([]);
}

/**
 * Which extensions namespace carries the display tagline: provider id when linked, 'cl' otherwise.
 * @param {Object} char
 * @returns {string}
 */
export function getActiveTaglineNamespace(char) {
    return ProviderRegistry.getActiveTaglineNamespace(char);
}

// ========================================
// UPDATE LOCK
// ========================================

export function isUpdateLocked(char) { return window.isUpdateLocked?.(char) ?? false; }
export function setUpdateLocked(...args) { return window.setUpdateLocked?.(...args); }

// ========================================
// PLAYLISTS
// ========================================

export function playlistsLoadPlaylists() { return window.playlistsLoadPlaylists?.(); }
export function playlistsGetAll() { return window.playlistsGetAll?.(); }
export function playlistsGetCharacters(...args) { return window.playlistsGetCharacters?.(...args); }
/** Open a chat by id, optionally revealing one message ({ seq }); resolves whether it opened. */
export function openChatById(...args) { return window.chatsModule?.openChatById?.(...args) ?? Promise.resolve(false); }
/** Resume a character's most recent chat, or start their first; resolves whether one opened. */
export function openConversationForCharacter(char) { return window.chatsModule?.openConversationForCharacter?.(char) ?? Promise.resolve(false); }
export function openPlaylistPicker(...args) { return window.openPlaylistPicker?.(...args); }
export function refreshPlaylistFilterIfActive(...args) { return window.refreshPlaylistFilterIfActive?.(...args); }
export function refreshPlaylistBadges() { return window.refreshPlaylistBadges?.(); }
/** The ids of the playlists that hold a character, off its row. */
export function playlistIdsOf(charId) { return window.playlistIdsOf?.(charId) || []; }
/** Adopt a membership write's answer onto the rows this tab holds. */
export function adoptPlaylistMembership(...args) { return window.adoptPlaylistMembership?.(...args); }
/** A deleted playlist leaves every row this tab holds. */
export function forgetPlaylistOnRows(uid) { return window.forgetPlaylistOnRows?.(uid); }
/** Be handed every view of a set job (a by-filter write) this tab follows; returns the unsubscribe. */
export function onJob(fn) { return window.onJob?.(fn) || (() => {}); }
/** Follow a set job the server answered to its end; resolves with the job as it ended. */
export function followJob(...args) { return window.followJob?.(...args); }
/** Stop a set job between chunks; resolves with the job, or null. */
export function stopJob(...args) { return window.stopJob?.(...args); }
export function closeAllTopbarDropdowns(...args) { return window.closeAllTopbarDropdowns?.(...args); }
export function openGalleryViewerWithImages(...args) { return window.openGalleryViewerWithImages?.(...args); }
export function promoteEmbeddedLorebook(...args) { return window.promoteEmbeddedLorebook?.(...args); }

// ========================================
// DEFAULT EXPORT - Convenience object
// ========================================

export default {
    // State
    getCurrentCharacters,
    getCharacterById,
    onCharactersDeleted,
    getSetting,
    getDefaultSetting,
    setRuntimeToken,
    removeRuntimeToken,
    flushSettings,
    settingsReady,
    setSetting,
    syncActivePersonaName,
    getPersonaPronouns,
    setSettings,
    userScopedKey,
    getProviderExcludeTags,
    applyCustomCSS,
    getCustomCSSMaxBytes,

    // View management
    switchView,
    goToView,
    getCurrentView,
    refreshProviderSelector,
    onViewEnter,
    onViewExit,
    
    // UI
    openCharacterModal,
    openCharacterById,
    showToast,
    summarizeImportActivity,
    showConfirm,
    setRunVerb,
    openSettingsToSection,
    savePresetPicker,
    refreshCharacters,
    
    // API
    apiRequest,
    readAnswer,
    storeRead,
    storeWrite,
    storeWatch,
    createStoreDocument,
    serverUrl,
    
    // Gallery
    openGalleryViewerWithImages,
    isMediaLocalizationEnabled,
    buildMediaLocalizationMap,
    replaceMediaUrlsInText,
    createThumbLoader,
    getCharacterGalleryInfo,
    listCharacterMedia,

    // Multi-select
    isMultiSelectEnabled,
    enableMultiSelect,
    getSelectedCharacters,
    getSelection,
    getSelectionCount,
    isCharacterSelected,
    toggleCharacterSelection,
    clearSelection,
    
    // Modules
    getModule,
    
    // Utils
    escapeHtml,
    safePurify,
    sanitizeTaglineHtml,
    debounce,
    renderEditableTagChips,
    clampTagRows,
    tagStateLook,
    randomId,
    wireDragReorder,
    formatRelativeAge,
    truncate,
    formatNumber,
    formatBytes,
    isMobileMode,
    scrollBehavior,
    createMobileSheet,
    getCharacterTags,
    suggestTags,
    applyTagAliases,
    stripTagDecoration,
    compileTagAliasRules,
    matchTagAliasRule,
    filterLibraryByTag,
    renameActiveTagFilter,
    reconcileTagFiltersWithAliases,
    
    // DOM helpers
    showElement,
    hideElement,
    hideModal,
    onElement,
    fitTextarea,
    initCustomSelect,
    lockMinWidth,
    fitRow,
    refitRow,

    // Rendering
    renderLoadingState,
    renderSkeletonGrid,
    openUserGuide,
    renderEmptyState,
    getCharacterAvatarSmallThumbUrl,
    getCharacterAvatarThumbUrl,
    thumbUrl,
    buildGalleryViewerMedia,
    galleryKindOf,
    makeFloatingWindow,
    windowGripsHtml,
    getWindowGeometry,
    getDefaultWindowGeometry,
    setWindowGeometry,
    mountDialogSizing,
    mountDialogs,
    mountSeam,
    getListingNameFromExtensions,
    bumpAvatarCacheBust,
    editAvatar,
    getCharacterAvatarUrl,
    copyTextToClipboard,
    getDisplayTagline,
    getCharacterName,
    formatRichText,
    formatChatText,
    liveFormattingOn,
    answerPronounMacros,
    renderLorebookEntriesHtml,
    
    // Character actions
    deleteCharacter,
    showDeleteConfirmation,
    fetchAndAddCharacter,
    adoptCreatedCharacter,
    hydrateCharacter,
    hydrateMany,
    currentViewFilter,
    narrowFilter,
    sameSet,
    filterNamesNothing,
    walkCharacterSetWhere,
    fetchCharactersByIds,
    fetchCharactersWhere,
    fetchCharactersPage,
    fetchCharacterIdsWhere,
    fetchCharacterSetWhere,
    fetchAllPages,
    ensureCharacterById,
    getLibraryTotal,
    whenLibraryTotal,
    performSearch,
    toggleCharacterFavorite,
    isCharacterFavorite,
    downloadBlobAsFile,
    filterListWithInlineCreate,
    getAdvFilterRulesForChats,
    
    // Creator Notes
    renderCreatorNotesSecure,
    renderCardHtmlSecure,
    cleanupCreatorNotesContainer,
    autoSnapshotBeforeChange,
    
    // Import / Download Pipeline
    checkCharacterForDuplicatesAsync,
    showPreImportDuplicateWarning,
    findCharacterMediaUrls,
    collectCardTextChunks,
    ensureExtractorsLoaded,
    findCharacterGalleryUrls,
    showImportSummaryModal,
    queueImportMediaJobs,
    resetBrowseSectionCollapseState,
    setBrowseAltGreetings,
    convertImageToPng,
    embedCharacterDataInPng,
    
    // Gallery Media Pipeline
    getExistingFileIndex,
    extractSanitizedUrlName,
    sanitizeMediaFilename,
    buildDedupState,
    downloadCharacterMedia,
    markMediaLocalizationComplete,
    registerNotificationSection,
    removeNotificationSection,
    refreshNotificationsUI,
    hasOpenOverlay,
    downloadMediaToMemory,
    isUrlSafeForDownload,
    calculateHash,
    
    // Provider Link UI
    openProviderLinkModal,
    
    // Logging
    debugLog,
    
    // Card data
    extractCharacterDataFromPng,
    writeCardFields,
    getExtensionDeleteValue,
    getCharacterWorldName,
    convertWorldToCharacterBook,
    getWorldInfoData,
    saveWorldInfoData,
    listWorldInfoFiles,
    createWorldInfo,
    createWorldInfoData,
    deleteWorldInfo,
    notifyWorldsChanged,
    notifyCharacterChanged,
    renameWorldInfo,
    importWorldInfoData,
    applyCharWorlds,
    applyGlobalWorlds,
    applyPersonaWorlds,
    promoteEmbeddedLorebook,
    applyChatWorlds,
    applyChatWorldsBatch,

    // Provider Registry (generic)
    getAllProviders,
    getProvider,
    getCharacterProvider,
    getProviderLinkInfo,
    getAllLinkedCharacters,
    getActiveTaglineNamespace,
    // Update Lock
    isUpdateLocked,
    setUpdateLocked,
    // Playlists
    playlistsLoadPlaylists,
    playlistsGetAll,
    playlistsGetCharacters,
    openChatById,
    openConversationForCharacter,
    openPlaylistPicker,
    refreshPlaylistFilterIfActive,
    refreshPlaylistBadges,
    playlistIdsOf,
    adoptPlaylistMembership,
    forgetPlaylistOnRows,
    onJob,
    followJob,
    stopJob,
    closeAllTopbarDropdowns,

    getLlmSettings,
    mountAiConnectionBlock,
    aiConnectionStreams,
    callLLM,
    callLLMStream,
    consumeLlmSse,
    streamChatGeneration,
    streamAssistantGeneration,
    streamCreatorGeneration,
    computeLineDiff,
    computeWordDiff,
};
