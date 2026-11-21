// The lorebook panel, shown inside the conversation.

import CoreAPI from '../core-api.js';
import { ENTRY_NUMBER_BLANKS, TRIGGER_TYPES, MATCH_SOURCES } from '../lorebook-shelf.js';
import { mountChatWindow, openChatWindow, closeChatWindow, registerChatWindow } from './window.js';
import { EXT_ACTION_EVENT, actionsFor as extActionsFor, hasActions as extHasActions, runAction as extRunAction, loreEntryContext, extensionName } from '../extension-host.js';

const esc = (s) => CoreAPI.escapeHtml(s);

// Mirrors POSITION in server/llm/lore.js. A position the server grows later is offered by its
// number (editorHtml), so saving an entry never moves it.
const POSITION_LABELS = {
    0: 'Before the character',
    1: 'After the character',
    2: "Author's note (top)",
    3: "Author's note (bottom)",
    4: 'At depth',
    5: 'Before the examples',
    6: 'After the examples',
    7: 'Outlet',
};

let panelInjected = false;
let panelOpen = false;

let _state = null;          // the server's answer, or null when it has never loaded
let _loadError = null;      // an unknown state is never rendered as an empty one
let _filter = '';
let _firingOnly = false;
let _collapsed = new Set(); // book names, session-scoped: a panel that reopens shut is worse
let _expanded = new Set();  // 'world::uid' of entries showing their full content read-only
let _view = 'list';         // 'list' | 'settings' (the scan-settings view; editing outranks both)
let _editing = null;        // { world, uid } of the entry open in the editor, or null
let _advOpen = false;       // the one Advanced disclosure, remembered across re-renders
let _saving = false;
let _picking = false;       // the add-a-book picker is open over the list
let _pickFilter = '';
let _shelf = [];            // every world file on disk, for the picker; null when the read failed

// the conversation being read, passed in at open: the panel is a view of chat state, not its owner
let _chatId = null;
let _char = null;
let _chatMeta = null;
// the chat detail's verdict on the card's character_book: {name, entries, reachable}, or null
let _embedded = null;
let _embeddedHidden = false;    // dismissed or imported this session, without a re-read
let _embeddedOffer = false;     // the badge's verdict for the subject
// which chat _state was loaded for: writes build from it, so another chat's state is never writable
let _stateChatId = null;

// ========================================
// I/O
// ========================================

// lore_dismissed lives on the character row: a per-user preference, never card content, so it stays out of exports
async function dismissEmbedded(charId) {
    const result = await CoreAPI.writeCardFields(charId, {}, { rootFields: { loreDismissed: true } });
    if (!result?.ok) {
        if (!result?.told) CoreAPI.showToast('Could not save that preference', 'error');
        return false;
    }
    return true;
}

/**
 * Whether the conversation should flag this character's embedded lorebook. Exported because
 * the conversation header draws the same verdict as a badge.
 * @param {{reachable: boolean}|null} embedded the chat detail's embeddedLorebook
 */
export async function embeddedLoreNeedsAttention(charId, embedded) {
    if (!charId || !embedded || embedded.reachable) return false;
    // an unresolvable character reads as dont-flag: a wrong badge nags someone who already answered
    const char = await CoreAPI.ensureCharacterById(charId);
    return char ? !char.loreDismissed : false;
}

// the card offers its book while the verdict says so and no answer was given here since
function embeddedOffered() {
    return !!_embedded && _embeddedOffer && !_embeddedHidden;
}

// the verdict for the subject as it stands; a draw under an editor or in the scan settings waits for the next
async function syncEmbeddedOffer() {
    const chatId = _chatId, embedded = _embedded, charId = _char?.id;
    const offer = await embeddedLoreNeedsAttention(charId, embedded);
    if (chatId !== _chatId || embedded !== _embedded || charId !== _char?.id || offer === _embeddedOffer) return;
    _embeddedOffer = offer;
    if (panelOpen && !_editing && _view === 'list') renderAll();
}

async function loadState(chatId) {
    const resp = await CoreAPI.apiRequest(`/chats/${encodeURIComponent(chatId)}/lore`, 'GET');
    if (!resp.ok) throw new Error(`lore state failed (${resp.status})`);
    return resp.json();
}

function entryOf(world, uid) {
    return _state?.worlds.find(w => w.name === world)?.entries.find(e => e.uid === uid) || null;
}

// an entry to READ, incl. an extension's book; writes go through entryOf alone
function readableEntryOf(world, uid) {
    return entryOf(world, uid) || _state?.extensionBooks?.find(b => b.name === world)?.entries.find(e => e.uid === uid) || null;
}

// A uid as the markup carries it: the library's books key entries by number, an extension's
// book may use text
const uidOf = (raw) => (raw == null ? null : /^-?\d+$/.test(raw) ? Number(raw) : raw);

const expKey = (world, uid) => `${world}::${uid}`;

/** Is the state on screen this chat's? Writes address a world by name, so another chat's payload would land in its lorebook. */
function ownsState() {
    if (_chatId && _state && _stateChatId === _chatId) return true;
    console.warn('[LorePanel] refused a write against another chat\'s state', { chat: _chatId, state: _stateChatId });
    refresh();
    return false;
}

/** Write one entry back through the manager's world endpoints: a second VIEW of that data, never a second store. */
async function writeEntry(world, uid, patch) {
    if (!ownsState()) return false;
    const current = entryOf(world, uid);
    if (!current) return false;

    // Only what this panel actually knows. The entry endpoint MERGES, so the fields it
    // never shows (useProbability, vectorized, automationId) are left alone.
    const keysecondary = patch.secondaryKeys ?? current.secondaryKeys;
    const adv = current.advanced || {};
    const advFlags = patch.matchFlags ?? adv.matchFlags ?? {};
    const body = {
        uid,
        comment: patch.comment ?? current.comment,
        key: patch.keys ?? current.keys,
        keysecondary,
        content: patch.content ?? current.content,
        disable: patch.disable ?? current.disable,
        constant: patch.constant ?? current.constant,
        order: patch.order ?? current.order,
        position: patch.position ?? current.position,
        outletName: patch.outletName ?? adv.outletName ?? '',
        // our lore engine applies secondary keys only on a selective entry, so the flag follows whether there are any
        selective: keysecondary.length > 0,
        selectiveLogic: patch.selectiveLogic ?? current.selectiveLogic ?? 0,
        role: patch.role ?? current.role ?? 0,
        // the nullable family is written as null, not dropped: null inherits (or is off for the timed three) and clears an override
        scanDepth: patch.scanDepth !== undefined ? patch.scanDepth : (current.scanDepth ?? null),
        caseSensitive: patch.caseSensitive !== undefined ? patch.caseSensitive : (current.caseSensitive ?? null),
        matchWholeWords: patch.matchWholeWords !== undefined ? patch.matchWholeWords : (current.matchWholeWords ?? null),
        probability: patch.probability ?? adv.probability ?? 100,
        sticky: patch.sticky !== undefined ? patch.sticky : (adv.sticky ?? null),
        cooldown: patch.cooldown !== undefined ? patch.cooldown : (adv.cooldown ?? null),
        delay: patch.delay !== undefined ? patch.delay : (adv.delay ?? null),
        group: patch.group ?? adv.group ?? '',
        groupWeight: patch.groupWeight ?? adv.groupWeight ?? 100,
        groupOverride: patch.groupOverride ?? adv.groupOverride ?? false,
        useGroupScoring: patch.useGroupScoring !== undefined ? patch.useGroupScoring : (adv.useGroupScoring ?? null),
        excludeRecursion: patch.excludeRecursion ?? adv.excludeRecursion ?? false,
        preventRecursion: patch.preventRecursion ?? adv.preventRecursion ?? false,
        delayUntilRecursion: patch.delayUntilRecursion ?? adv.delayUntilRecursion ?? 0,
        ignoreBudget: patch.ignoreBudget ?? adv.ignoreBudget ?? false,
        triggers: patch.triggers ?? (Array.isArray(adv.triggers) ? adv.triggers : []),
        // null CLEARS over the merge, matching ST's delete-an-empty-filter rule
        characterFilter: patch.characterFilter !== undefined ? patch.characterFilter : (adv.characterFilter ?? null),
        matchPersonaDescription: !!advFlags.matchPersonaDescription,
        matchCharacterDescription: !!advFlags.matchCharacterDescription,
        matchCharacterPersonality: !!advFlags.matchCharacterPersonality,
        matchCharacterDepthPrompt: !!advFlags.matchCharacterDepthPrompt,
        matchScenario: !!advFlags.matchScenario,
        matchCreatorNotes: !!advFlags.matchCreatorNotes,
        ...(patch.depth ?? current.depth) === null ? {} : { depth: patch.depth ?? current.depth },
    };
    try {
        const resp = await CoreAPI.apiRequest(`/worlds/${encodeURIComponent(world)}/entries/${uid}`, 'PUT', body);
        if (!resp.ok) throw new Error(`(${resp.status})`);
        // These three endpoints never touch saveWorldInfoData, so nothing else hears about
        // them unless they say so themselves.
        CoreAPI.notifyWorldsChanged(world, 'lore-panel');
        return true;
    } catch (e) {
        console.error('[LorePanel] Entry save failed:', e.message);
        CoreAPI.showToast('Could not save the entry', 'error');
        return false;
    }
}

async function createEntry(world, seed = {}) {
    if (!ownsState()) return null;
    try {
        const resp = await CoreAPI.apiRequest(`/worlds/${encodeURIComponent(world)}/entries`, 'POST', {
            comment: seed.comment || 'New entry',
            key: seed.keys || [],
            content: seed.content || '',
            // Off until it says something: an empty entry silently entering every prompt
            // from the moment it is created is a bad surprise.
            disable: true,
        });
        if (!resp.ok) throw new Error(`(${resp.status})`);
        CoreAPI.notifyWorldsChanged(world, 'lore-panel');
        return await resp.json();
    } catch (e) {
        console.error('[LorePanel] Entry create failed:', e.message);
        CoreAPI.showToast('Could not create the entry', 'error');
        return null;
    }
}

async function deleteEntry(world, uid) {
    if (!ownsState()) return;
    const ok = await CoreAPI.showConfirm({
        title: 'Delete entry',
        message: 'This removes it from the lorebook for every chat that uses it.',
        confirmLabel: 'Delete',
        danger: true,
    });
    if (!ok) return;
    try {
        const resp = await CoreAPI.apiRequest(`/worlds/${encodeURIComponent(world)}/entries/${uid}`, 'DELETE');
        if (!resp.ok) throw new Error(`(${resp.status})`);
        CoreAPI.notifyWorldsChanged(world, 'lore-panel');
        _editing = null;
        _staleWhileEditing = false;
        await refresh();
    } catch (e) {
        console.error('[LorePanel] Entry delete failed:', e.message);
        CoreAPI.showToast('Could not delete the entry', 'error');
    }
}

// ========================================
// RENDER
// ========================================

function matchesFilter(entry) {
    if (_firingOnly && !entry.fired) return false;
    if (!_filter) return true;
    const hay = `${entry.comment} ${entry.keys.join(' ')} ${entry.secondaryKeys.join(' ')} ${entry.content}`.toLowerCase();
    return hay.includes(_filter);
}

// the find field goes red when a typed query leaves no entry in any book the list shows
function syncFilterField() {
    const field = document.getElementById('clpFilter');
    if (!field) return;
    const books = _state && _view === 'list' ? [..._state.worlds, ...(_state.extensionBooks || [])] : null;
    field.classList.toggle('is-empty', !!(books && _filter && !books.some(b => b.entries.some(matchesFilter))));
}

function entryTitle(entry) {
    return entry.comment || entry.keys[0] || `Entry ${entry.uid}`;
}

// four states, four glyphs: colour alone fails a reader who cant split hues, and off isnt did-not-fire
const STATUS = {
    off:    { cls: 'off',    icon: 'fa-ban',        label: 'Turned off, so it is never sent' },
    always: { cls: 'always', icon: 'fa-thumbtack',  label: 'Always sent, no keys needed' },
    firing: { cls: 'firing', icon: 'fa-bolt',       label: 'In the prompt right now' },
    idle:   { cls: 'idle',   icon: 'fa-circle',     label: 'No key matched the messages in the scan window' },
};

function statusOf(entry) {
    if (entry.disable) return STATUS.off;
    if (entry.constant) return STATUS.always;
    if (entry.fired) return STATUS.firing;
    return STATUS.idle;
}

// Why the engine held an entry back this scan, in words a chip can carry.
const SUPPRESS_LABEL = {
    trigger: 'wrong generation type',
    characterFilter: 'character filter',
    delay: 'delayed',
    cooldown: 'cooling down',
    delayUntilRecursion: 'awaits recursion',
    excludeRecursion: 'recursion-excluded',
    decorator: '@@dont_activate',
    vectorized: 'vectorized',
    probability: 'lost its roll',
    budget: 'over the lore budget',
    group: 'lost its group',
};

function statusHtml(entry) {
    const s = statusOf(entry);
    const reason = !entry.fired && entry.suppressedReason ? (SUPPRESS_LABEL[entry.suppressedReason] || entry.suppressedReason) : '';
    // a quiet entry that was held says its reason alone: its keys may well have matched
    const label = !reason ? s.label : s === STATUS.idle ? `Held back this scan: ${reason}` : `${s.label} (held back: ${reason})`;
    return `<span class="clp-status is-${s.cls}" title="${esc(label)}" aria-label="${esc(label)}">
        <i class="fa-solid ${s.icon}"></i>
    </span>`;
}

// Dynamic engine state only (what is true THIS scan); static config lives in the editor.
function entryChipsHtml(entry) {
    const chips = [];
    // WHY it fired, from the engine: a chat match names the message, a recursion
    // activation names the feeder (constant/sticky already read off the status glyph).
    const via = entry.fired ? entry.firedVia : null;
    if (via?.kind === 'chat' && via.messageSeq != null) {
        chips.push({ cls: 'via', text: `#${via.messageSeq}`, title: `Matched chat message #${via.messageSeq}` });
    } else if (via?.kind === 'recursion') {
        const feeder = via.feederComment || `entry ${via.feederUid}`;
        chips.push({ cls: 'via-rec', text: `via ${feeder}`, title: `No chat match: fired by recursion off "${feeder}" (${via.feederWorld})` });
    } else if (via?.kind === 'source') {
        chips.push({ cls: 'via', text: 'via card', title: `Matched an extra scan source (${via.source}), not the chat` });
    }
    if (entry.outlet) {
        chips.push({ cls: 'via', text: `outlet ${entry.outlet}`, title: `Held for {{outlet::${entry.outlet}}}: it reaches the prompt where that is written` });
    }
    if (entry.probabilityPending != null) {
        chips.push({ cls: 'roll', text: `${entry.probabilityPending}%`, title: `Fires, then rolls ${entry.probabilityPending}% at send` });
    }
    if (entry.groupPending != null) {
        chips.push({ cls: 'roll', text: `group ${entry.groupPending}%`, title: `In inclusion group "${entry.advanced?.group || ''}": it reaches the prompt only if it wins the group's roll at send (${entry.groupPending}%)` });
    }
    if (entry.timed?.sticky) {
        chips.push({ cls: 'sticky', text: `sticky ${entry.timed.sticky}`, title: `Sticky: stays active ${entry.timed.sticky} more turn${entry.timed.sticky === 1 ? '' : 's'}` });
    }
    if (entry.timed?.cooldown) {
        chips.push({ cls: 'cooldown', text: `cooldown ${entry.timed.cooldown}`, title: `Cooling down: cannot fire for ${entry.timed.cooldown} more turn${entry.timed.cooldown === 1 ? '' : 's'}` });
    }
    if (!entry.fired && entry.suppressedReason) {
        const label = SUPPRESS_LABEL[entry.suppressedReason] || entry.suppressedReason;
        chips.push({ cls: 'held', text: label, title: `Held back this scan: ${label}` });
    }
    if (!chips.length) return '';
    return `<span class="clp-tags">${chips.map(c =>
        `<span class="clp-tag is-${c.cls}" title="${esc(c.title)}">${esc(c.text)}</span>`).join('')}</span>`;
}

// title, then engine tags, then keys, no prose preview (the row click reads); an extension's book is read-only
function entryRowHtml(world, entry, { readOnly = false } = {}) {
    const keys = entry.keys.slice(0, 4).map(k => `<span class="clp-key">${esc(k)}</span>`).join('');
    const more = entry.keys.length > 4 ? `<span class="clp-key clp-key-more">+${entry.keys.length - 4}</span>` : '';
    const expanded = _expanded.has(expKey(world, entry.uid));
    return `<div class="cl-cwin-row clp-entry${entry.fired ? ' is-firing' : ''}${entry.disable ? ' is-off' : ''}${expanded ? ' is-expanded' : ''}"
                 data-world="${esc(world)}" data-uid="${entry.uid}">
        ${statusHtml(entry)}
        <button type="button" class="clp-entry-main" data-lore-act="expand" data-world="${esc(world)}" data-uid="${entry.uid}"
            aria-expanded="${expanded ? 'true' : 'false'}" title="${expanded ? 'Collapse this entry' : 'Read this entry'}">
            <span class="clp-entry-line1">
                <span class="clp-entry-title">${esc(entryTitle(entry))}</span>
            </span>
            ${entryChipsHtml(entry)}
            <span class="clp-entry-keys">${entry.constant ? '<span class="clp-key clp-key-always">always on</span>' : (keys + more) || '<span class="clp-key clp-key-none">no keys</span>'}</span>
        </button>${readOnly ? '' : `
        <button type="button" class="clp-icon cl-cwin-act" data-lore-act="edit" data-world="${esc(world)}" data-uid="${entry.uid}"
                title="Edit this entry" aria-label="Edit this entry">
            <i class="fa-solid fa-pen"></i>
        </button>
        <button type="button" class="clp-icon cl-cwin-act" data-lore-act="toggle" data-world="${esc(world)}" data-uid="${entry.uid}"
                title="${entry.disable ? 'Turn on' : 'Turn off'}" aria-label="${entry.disable ? 'Turn on' : 'Turn off'}">
            <i class="fa-solid ${entry.disable ? 'fa-toggle-off' : 'fa-toggle-on'}"></i>
        </button>`}
    </div>${expanded ? readHtml(world, entry) : ''}`;
}

// The read view: the whole content, escaped, whitespace preserved, fused under its row, with the
// extensions' verbs about the entry at its foot.
function readHtml(world, entry) {
    return `<div class="clp-read" data-world="${esc(world)}" data-uid="${entry.uid}">${esc(entry.content || '') || '<span class="clp-dim">This entry has no content yet.</span>'}<div class="clp-read-acts" data-world="${esc(world)}" data-uid="${entry.uid}">${entryActsHtml(world, entry)}</div></div>`;
}

// the projection in the book format's names, which the lore slot's context speaks
const bookEntryOf = (entry) => ({ ...entry, key: entry.keys, keysecondary: entry.secondaryKeys });

// an extension's verbs about the entry being read (the lore slot); the strip stays, empty, so a registration can fill it
function entryActsHtml(world, entry) {
    if (!extHasActions('lore')) return '';
    return extActionsFor('lore', loreEntryContext(world, bookEntryOf(entry), _chatId)).map(a =>
        `<button type="button" class="cl-cwin-btn-text" data-lore-act="ext" data-key="${esc(a.key)}" data-world="${esc(world)}" data-uid="${entry.uid}" title="${esc(a.label)}"><i class="fa-solid ${esc(a.icon)}"></i> ${esc(a.label)}</button>`).join('');
}

// a registration changed: the read views' strips are asked again, and nothing else is redrawn
function refreshEntryActs() {
    document.querySelectorAll('#clpBody .clp-read-acts').forEach(strip => {
        const e = readableEntryOf(strip.dataset.world, uidOf(strip.dataset.uid));
        if (e) strip.innerHTML = entryActsHtml(strip.dataset.world, e);
    });
}

function onEntryActsChanged(e) {
    if (e.detail?.slot === 'lore' && panelOpen) refreshEntryActs();
}

// the source chip is a control (it decides what unlinking does); an extension's book names its owner, read-only
function bookHtml(book, { byExtension = false } = {}) {
    const shown = book.entries.filter(matchesFilter);
    const firing = book.entries.filter(e => e.fired).length;
    const collapsed = _collapsed.has(book.name);
    const w = esc(book.name);
    if (byExtension) {
        const who = esc(extensionName(book.extension));
        return `<section class="clp-book is-ext${collapsed ? ' is-collapsed' : ''}" data-world="${w}">
        <header class="clp-book-head">
            <button type="button" class="clp-book-toggle" data-lore-act="collapse" data-world="${w}"
                    aria-expanded="${collapsed ? 'false' : 'true'}">
                <i class="clp-book-caret fa-solid fa-chevron-down"></i>
                <i class="clp-book-glyph fa-solid fa-puzzle-piece"></i>
                <span class="clp-book-name">${esc(book.label)}</span>
            </button>
            <span class="clp-book-srcs"><span class="clp-src clp-src-ext" title="Added to this scan by ${who}"><span class="clp-src-ext-name">${who}</span></span></span>
            <span class="clp-book-count" title="${firing} of ${book.entries.length} entries are in the prompt">
                ${firing ? `<b>${firing}</b>/` : ''}${book.entries.length}
            </span>
        </header>
        ${collapsed ? '' : `<div class="clp-entries">${shown.length
            ? shown.map(e => entryRowHtml(book.name, e, { readOnly: true })).join('')
            : '<p class="clp-none">Nothing matches the filter.</p>'}</div>`}
    </section>`;
    }
    const personaName = _state?.persona?.name || 'your persona';
    const SRC = {
        character: { icon: 'fa-user', label: 'Linked to the character', verb: 'Unlink from this character' },
        chat: { icon: 'fa-comment', label: 'Bound to this chat', verb: 'Unbind from this chat' },
        persona: { icon: 'fa-masks-theater', label: `Bound to ${personaName}, follows them into every chat`, verb: `Unbind from ${personaName}` },
        global: { icon: 'fa-globe', label: 'On the global list, active in every chat', verb: 'Remove from the global list' },
    };
    const sources = book.sources.map((s) => {
        const meta = SRC[s] || SRC.character;
        return `<button type="button" class="clp-src clp-src-${s}"
            data-lore-act="unlink" data-scope="${s}" data-world="${w}"
            title="${esc(meta.label)}. Click to ${esc(meta.verb.toLowerCase())}"
            aria-label="${esc(meta.verb)}">
            <i class="fa-solid ${meta.icon}"></i>
        </button>`;
    }).join('');
    // a placeholder is a name linked here with no book yet: said as such, never as an empty book
    const ph = !!book.placeholder;
    const fromCard = ph && embeddedOffered() && String(_embedded.name || '').toLowerCase() === book.name.toLowerCase();
    const empty = ph
        ? `No book of this name yet. ${fromCard ? 'The card carries one: import it above.' : 'Add an entry to start one, or import a book with this name.'}`
        : 'This book has no entries yet.';
    return `<section class="clp-book${collapsed ? ' is-collapsed' : ''}${ph ? ' is-placeholder' : ''}" data-world="${w}">
        <header class="clp-book-head">
            <button type="button" class="clp-book-toggle" data-lore-act="collapse" data-world="${w}"
                    aria-expanded="${collapsed ? 'false' : 'true'}">
                <i class="clp-book-caret fa-solid fa-chevron-down"></i>
                <i class="clp-book-glyph fa-solid ${ph ? 'fa-ghost' : 'fa-book'}"></i>
                <span class="clp-book-name">${w}</span>
            </button>
            <span class="clp-book-srcs">${sources || '<span class="clp-src clp-src-none">not linked</span>'}</span>
            ${ph
                ? '<span class="clp-book-count clp-book-ph" title="A name linked here with no book yet">placeholder</span>'
                : `<span class="clp-book-count" title="${firing} of ${book.entries.length} entries are in the prompt">
                ${firing ? `<b>${firing}</b>/` : ''}${book.entries.length}
            </span>`}
            <button type="button" class="clp-icon cl-cwin-act" data-lore-act="add" data-world="${w}" title="New entry in this book" aria-label="New entry in this book">
                <i class="fa-solid fa-plus"></i>
            </button>
        </header>
        ${collapsed ? '' : `<div class="clp-entries">${
            shown.length
                ? shown.map(e => entryRowHtml(book.name, e)).join('')
                : `<p class="clp-none">${book.entries.length ? 'Nothing matches the filter.' : empty}</p>`
        }</div>`}
    </section>`;
}

// The add picker: three different reaches, so the verbs are separate buttons rather than one "add".
function pickerHtml() {
    if (!_picking) return '';
    const inUse = new Map((_state?.worlds || []).map(w => [w.name, w.sources]));
    const rows = (_shelf || [])
        .filter(n => !_pickFilter || n.toLowerCase().includes(_pickFilter))
        .map(name => {
            const src = inUse.get(name) || [];
            return `<div class="clp-pick-row">
                <i class="clp-pick-glyph fa-solid fa-book"></i>
                <span class="clp-pick-name">${esc(name)}</span>
                <button type="button" class="clp-pick-btn${src.includes('character') ? ' is-on' : ''}"
                    data-lore-act="link" data-scope="character" data-world="${esc(name)}"
                    title="${src.includes('character') ? 'Already linked to this character' : 'Link to this character, for every chat'}"
                    ${src.includes('character') ? 'disabled' : ''}><i class="fa-solid fa-user"></i>Character</button>
                <button type="button" class="clp-pick-btn${src.includes('chat') ? ' is-on' : ''}"
                    data-lore-act="link" data-scope="chat" data-world="${esc(name)}"
                    title="${src.includes('chat') ? 'Already bound to this chat' : 'Bind to THIS chat only'}"
                    ${src.includes('chat') ? 'disabled' : ''}><i class="fa-solid fa-comment"></i>This Chat</button>
                <button type="button" class="clp-pick-btn${src.includes('global') ? ' is-on' : ''}"
                    data-lore-act="link" data-scope="global" data-world="${esc(name)}"
                    title="${src.includes('global') ? 'Already on the global list' : 'Add to the global list, active in EVERY chat'}"
                    ${src.includes('global') ? 'disabled' : ''}><i class="fa-solid fa-globe"></i>Everywhere</button>
            </div>`;
        }).join('');
    return `<div class="clp-picker" id="clpPicker">
        <div class="clp-pick-head">
            <span>Add a lorebook</span>
            <button type="button" class="clp-icon cl-cwin-act" data-lore-act="close-pick" title="Close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <input type="search" class="cl-cwin-input clp-input" id="clpPickFilter" placeholder="Search the shelf" autocomplete="off" value="${esc(_pickFilter)}">
        <div class="clp-pick-list">${_shelf === null
            ? '<p class="clp-none">Could not load your lorebooks. <button type="button" class="cl-cwin-btn-text" data-lore-act="retry-pick"><i class="fa-solid fa-rotate-right"></i> Retry</button></p>'
            : rows || '<p class="clp-none">No lorebooks on the shelf yet.</p>'}</div>
    </div>`;
}

// The four ways secondary keys combine with the primary ones. Mirrors LOGIC in server/llm/lore.js.
const LOGIC_LABELS = {
    0: 'AND any (a secondary key must also match)',
    3: 'AND all (every secondary key must match)',
    2: 'NOT any (no secondary key may match)',
    1: 'NOT all (they must not all match)',
};

// The voice an at-depth entry arrives in, by its stored code.
const ROLE_LABELS = { 0: 'System', 1: 'User', 2: 'Assistant' };

// a nullable override as three options: a checkbox cant say inherit
function inheritSelect(id, value, { onLabel, offLabel }) {
    const v = value === true ? 'yes' : value === false ? 'no' : '';
    const opt = (val, label) => `<option value="${val}"${v === val ? ' selected' : ''}>${label}</option>`;
    return `<select class="cl-select-fluid" id="${id}">
        ${opt('', 'Use the default')}
        ${opt('yes', onLabel)}
        ${opt('no', offLabel)}
    </select>`;
}

function editorHtml() {
    if (!_editing) return '';
    const e = _editing.uid != null ? entryOf(_editing.world, _editing.uid) : null;
    if (!e) return '';
    const positions = Object.entries(POSITION_LABELS);
    if (!(Number(e.position) in POSITION_LABELS)) positions.push([String(Number(e.position) || 0), `Position ${Number(e.position) || 0}`]);
    const posOpts = positions
        .map(([v, label]) => `<option value="${v}"${Number(e.position) === Number(v) ? ' selected' : ''}>${label}</option>`).join('');
    const logicOpts = Object.entries(LOGIC_LABELS)
        .map(([v, label]) => `<option value="${v}"${Number(e.selectiveLogic) === Number(v) ? ' selected' : ''}>${label}</option>`).join('');
    const roleOpts = Object.entries(ROLE_LABELS)
        .map(([v, label]) => `<option value="${v}"${Number(e.role) === Number(v) ? ' selected' : ''}>${label}</option>`).join('');
    const atDepth = Number(e.position) === 4;
    return `<div class="clp-editor" id="clpEditor">
        <div class="clp-editor-crumb">
            <button type="button" class="clp-crumb-back" data-lore-act="cancel-edit" title="Back to the list" aria-label="Back to the list">
                <i class="fa-solid fa-chevron-left"></i> Back
            </button>
            <span class="clp-editor-book">${esc(_editing.world)}</span>
            <span class="clp-crumb-title">${esc(entryTitle(e))}</span>
            <button type="button" class="clp-icon cl-cwin-act" data-lore-act="delete" data-world="${esc(_editing.world)}" data-uid="${e.uid}" title="Delete entry" aria-label="Delete entry">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
        <div class="clp-editor-fields">
        <label class="clp-field">
            <span>Title</span>
            <input type="search" autocomplete="one-time-code" class="cl-cwin-input clp-input" id="clpTitle" value="${esc(e.comment)}" placeholder="What this entry is about">
        </label>
        <label class="clp-field">
            <span>Keys</span>
            <input type="search" autocomplete="one-time-code" class="cl-cwin-input clp-input" id="clpKeys" value="${esc(e.keys.join(', '))}" placeholder="comma, separated, triggers">
        </label>
        <label class="clp-field">
            <span>Also needs (optional)</span>
            <input type="search" autocomplete="one-time-code" class="cl-cwin-input clp-input" id="clpKeys2" value="${esc(e.secondaryKeys.join(', '))}" placeholder="secondary keys">
        </label>
        <div class="clp-ed-sep"></div>
        <label class="clp-field clp-field-grow">
            <span>Content</span>
            <textarea class="cl-cwin-input clp-input clp-textarea" id="clpContent" placeholder="What the model is told when this fires">\n${esc(e.content)}</textarea>
        </label>
        <div class="clp-ed-sep"></div>
        <div class="clp-field-row">
            <label class="cl-cwin-pick"><input type="checkbox" id="clpEnabled"${e.disable ? '' : ' checked'}> On</label>
            <label class="cl-cwin-pick"><input type="checkbox" id="clpConstant"${e.constant ? ' checked' : ''}> Always send</label>
            <label class="clp-field clp-field-narrow">
                <span>Order</span>
                <input type="number" class="cl-cwin-input clp-input" id="clpOrder" value="${Number(e.order) || 0}">
            </label>
        </div>
        <div class="clp-field-row">
            <label class="clp-field clp-field-grow2">
                <span>Placement</span>
                <select class="cl-select-fluid" id="clpPosition">${posOpts}</select>
            </label>
            <label class="clp-field clp-field-grow2 clp-outlet${Number(e.position) === 7 ? '' : ' is-dim'}">
                <span>Outlet</span>
                <input type="search" autocomplete="one-time-code" class="cl-cwin-input clp-input" id="clpOutlet" value="${esc(e.advanced?.outletName || '')}" placeholder="name">
            </label>
        </div>
        <span class="clp-hint">An outlet entry goes where the prompt writes {{outlet::name}}.</span>
        <div class="clp-ed-sep"></div>

        <!-- ONE disclosure for everything you set once and rarely revisit. Three stacked
             ones (Advanced / Engine fields / Not honoured) each cost a mental gear change,
             and together they were most of what made the editor read as a wall. -->
        <details class="cl-cwin-fold clp-adv"${_advOpen ? ' open' : ''}>
            <summary class="cl-cwin-fold-summary">
                <i class="fa-solid fa-chevron-right"></i>
                <span>Advanced</span>
                <span class="cl-cwin-fold-hint">matching, odds, timing, filters</span>
            </summary>
            <div class="cl-cwin-fold-body">
                <div class="clp-eng-sect">Matching</div>
                <label class="clp-field">
                    <span>When there are secondary keys</span>
                    <select class="cl-select-fluid" id="clpLogic">${logicOpts}</select>
                </label>
                <div class="clp-field-row">
                    <label class="clp-field clp-field-grow2">
                        <span>Capitalisation</span>
                        ${inheritSelect('clpCase', e.caseSensitive, { onLabel: 'Must match exactly', offLabel: 'Ignore capitalisation' })}
                    </label>
                    <label class="clp-field clp-field-grow2">
                        <span>Word boundaries</span>
                        ${inheritSelect('clpWhole', e.matchWholeWords, { onLabel: 'Whole words only', offLabel: 'Match inside words' })}
                    </label>
                </div>
                <label class="clp-field">
                    <span>Scan depth</span>
                    <input type="number" class="cl-cwin-input clp-input" id="clpScanDepth" min="0" placeholder="Use the default"
                           value="${Number.isInteger(e.scanDepth) ? e.scanDepth : ''}">
                    <span class="clp-hint">How many recent messages this entry looks at. Blank uses the panel default.</span>
                </label>
                <div class="clp-eng-sect">At depth</div>
                <div class="clp-field-row clp-atdepth${atDepth ? '' : ' is-dim'}">
                    <label class="clp-field clp-field-narrow">
                        <span>Depth</span>
                        <input type="number" class="cl-cwin-input clp-input" id="clpDepth" min="0"
                               value="${Number.isInteger(e.depth) ? e.depth : ''}" placeholder="4">
                    </label>
                    <label class="clp-field clp-field-grow2">
                        <span>Arrives as</span>
                        <select class="cl-select-fluid" id="clpRole">${roleOpts}</select>
                    </label>
                    <span class="clp-hint">${atDepthHint(atDepth)}</span>
                </div>
                ${engineSectionsHtml(e)}
                <div class="clp-eng-sect">Not honoured</div>
                <p class="clp-nh-note"><i class="fa-solid fa-circle-info"></i>
                    Not acted on at all: nothing here implements them. Shown so nothing looks lost.</p>
                <div class="clp-nh-grid">${NOT_HONOURED_FIELDS.map(f => advRow(f, (e.notHonoured || {})[f.key], NOT_YET)).join('')}</div>
            </div>
        </details>
        </div>

        <div class="clp-editor-actions">
            <button type="button" class="cl-cwin-btn-text" data-lore-act="cancel-edit">Cancel</button>
            <button type="button" class="cl-cwin-btn-text is-primary" data-lore-act="save-edit">Save Entry</button>
        </div>
    </div>`;
}

function atDepthHint(atDepth) {
    return atDepth ? 'Injected this many turns from the end.' : 'Only used when placement is At depth.';
}

// the rows a placement governs follow the select as the reader picks, not the stored entry
function followPlacement(sel) {
    const editor = sel?.closest?.('.clp-editor');
    if (!editor) return;
    const pos = Number(sel.value);
    editor.querySelector('.clp-outlet')?.classList.toggle('is-dim', pos !== 7);
    const depthRow = editor.querySelector('.clp-atdepth');
    depthRow?.classList.toggle('is-dim', pos !== 4);
    const hint = depthRow?.querySelector('.clp-hint');
    if (hint) hint.textContent = atDepthHint(pos === 4);
}

// Every control here is HONOURED by the engine at scan time; nothing the engine ignores is
// offered. These render INSIDE the editor's single Advanced disclosure.
function engineSectionsHtml(e) {
    const adv = e.advanced || {};
    const cf = adv.characterFilter || null;
    const flags = adv.matchFlags || {};
    const trig = Array.isArray(adv.triggers) ? adv.triggers : [];
    // ST imports can carry a bare true here; it means level 1
    const delayRec = adv.delayUntilRecursion === true ? 1 : adv.delayUntilRecursion;
    // the route stores these as sent, so an imported book's value is escaped like any other field
    const num = (v) => (v === null || v === undefined ? '' : esc(v));
    const checkGrid = (cls, attr, items, isOn) => `<div class="clp-check-grid ${cls}">${items.map(([k, label]) =>
        `<label class="cl-cwin-pick"><input type="checkbox" ${attr}="${k}"${isOn(k) ? ' checked' : ''}> ${label}</label>`).join('')}</div>`;
    return `<div class="clp-eng-sect">Odds and timing</div>
            <div class="clp-field-row">
                <label class="clp-field clp-field-narrow">
                    <span>Fires (%)</span>
                    <input type="number" class="cl-cwin-input clp-input" id="clpProbability" min="0" max="100" placeholder="100" value="${num(adv.probability)}">
                </label>
                <label class="clp-field clp-field-narrow">
                    <span>Sticky</span>
                    <input type="number" class="cl-cwin-input clp-input" id="clpSticky" min="0" placeholder="off" value="${num(adv.sticky)}">
                </label>
                <label class="clp-field clp-field-narrow">
                    <span>Cooldown</span>
                    <input type="number" class="cl-cwin-input clp-input" id="clpCooldown" min="0" placeholder="off" value="${num(adv.cooldown)}">
                </label>
                <label class="clp-field clp-field-narrow">
                    <span>Delay</span>
                    <input type="number" class="cl-cwin-input clp-input" id="clpDelayTurns" min="0" placeholder="off" value="${num(adv.delay)}">
                </label>
            </div>
            <span class="clp-hint">Odds roll at send. Sticky and cooldown count turns; delay waits until the chat is this many messages long. Blank switches each off.</span>
            <div class="clp-eng-sect">Inclusion group <span class="clp-eng-sub">one member fires per scan</span></div>
            <div class="clp-field-row">
                <label class="clp-field clp-field-grow2">
                    <span>Group name(s)</span>
                    <input type="search" autocomplete="one-time-code" class="cl-cwin-input clp-input" id="clpGroup" placeholder="comma,separated" value="${esc(adv.group || '')}">
                </label>
                <label class="clp-field clp-field-narrow">
                    <span>Weight</span>
                    <input type="number" class="cl-cwin-input clp-input" id="clpGroupWeight" min="0" placeholder="100" value="${num(adv.groupWeight)}">
                </label>
            </div>
            <label class="clp-field">
                <span>Group scoring</span>
                ${inheritSelect('clpGroupScoring', adv.useGroupScoring, { onLabel: 'Most matched keys wins', offLabel: 'Weighted roll' })}
            </label>
            <div class="clp-field-row">
                <label class="cl-cwin-pick"><input type="checkbox" id="clpGroupOverride"${adv.groupOverride ? ' checked' : ''}> Beats its group outright</label>
            </div>
            <div class="clp-eng-sect">Recursion and budget</div>
            <div class="clp-field-row">
                <label class="cl-cwin-pick"><input type="checkbox" id="clpExcludeRec"${adv.excludeRecursion ? ' checked' : ''}> Not triggered by others</label>
                <label class="cl-cwin-pick"><input type="checkbox" id="clpPreventRec"${adv.preventRecursion ? ' checked' : ''}> Does not trigger others</label>
            </div>
            <div class="clp-field-row">
                <label class="clp-field clp-field-narrow">
                    <span>Only on recursion</span>
                    <input type="number" class="cl-cwin-input clp-input" id="clpDelayRec" min="0" placeholder="0" value="${delayRec ? num(delayRec) : ''}">
                </label>
                <label class="cl-cwin-pick"><input type="checkbox" id="clpIgnoreBudget"${adv.ignoreBudget ? ' checked' : ''}> Ignore the budget</label>
            </div>
            <div class="clp-eng-sect">Fires for <span class="clp-eng-sub">none checked = every kind</span></div>
            ${checkGrid('clp-trig-grid', 'data-trigger', TRIGGER_TYPES, k => trig.includes(k))}
            <div class="clp-eng-sect">Character filter <span class="clp-eng-sub">blank = everyone</span></div>
            <div class="clp-field-row">
                <label class="clp-field clp-field-narrow">
                    <span>Mode</span>
                    <select class="cl-select-fluid" id="clpCfMode">
                        <option value=""${cf?.isExclude ? '' : ' selected'}>Only for</option>
                        <option value="exclude"${cf?.isExclude ? ' selected' : ''}>Never for</option>
                    </select>
                </label>
                <label class="clp-field clp-field-grow2">
                    <span>Characters</span>
                    <input type="search" class="cl-cwin-input clp-input" id="clpCfNames" placeholder="names, comma separated" value="${esc((cf?.names || []).join(', '))}">
                </label>
            </div>
            <label class="clp-field">
                <span>Tags</span>
                <input type="search" autocomplete="one-time-code" class="cl-cwin-input clp-input" id="clpCfTags" placeholder="tags, comma separated" value="${esc((cf?.tags || []).join(', '))}">
            </label>
            <div class="clp-eng-sect">Also scans</div>
            ${checkGrid('clp-ms-grid', 'data-flag', MATCH_SOURCES, k => !!flags[k])}`;
}

// Fields with genuinely no home here: no vector store, no Quick Reply automation. Stored,
// preserved on every write, shown so nothing looks lost.
const NOT_HONOURED_FIELDS = [
    { key: 'vectorized', label: 'Vector storage', kind: 'bool', hint: 'Meant to be retrieved by similarity; never fires on keys here' },
    { key: 'automationId', label: 'Automation id', kind: 'text', hint: 'Fires a Quick Reply by id in ST' },
];

const NOT_YET = 'Stored and preserved, but this build\'s lore engine does not act on it yet';

function advRow(f, v, extraTitle) {
    const isSet = !(v === null || v === undefined || v === '' || v === false
        || (Array.isArray(v) && !v.length) || (f.unset && f.unset(v)));
    const kind = f.kind === 'auto' ? (typeof v === 'number' ? 'number' : 'bool') : f.kind;
    const control = kind === 'bool'
        ? `<input type="checkbox" disabled${v ? ' checked' : ''}>`
        : kind === 'list'
            ? `<input type="search" autocomplete="one-time-code" class="cl-cwin-input clp-input" disabled value="${esc(Array.isArray(v) ? v.join(', ') : (v ?? ''))}" placeholder="unset">`
            : `<input type="${kind === 'number' ? 'number' : 'text'}" class="cl-cwin-input clp-input" disabled value="${esc(v ?? '')}" placeholder="unset">`;
    return `<label class="clp-nh-row${isSet ? ' is-set' : ''}" title="${esc(f.hint)}${extraTitle ? `. ${esc(extraTitle)}` : ''}.">
        <span class="clp-nh-name">${esc(f.label)}</span>
        ${control}
    </label>`;
}

// books reached ONLY by standing scopes (global, persona) go below the divider; others render on top with all chips
function isStandingBook(b) {
    return b.sources.length > 0 && b.sources.every(s => s === 'global' || s === 'persona');
}

function standingDividerHtml() {
    const n = _state?.persona?.name;
    return `<div class="clp-scope-divide"
        title="Books that arrive with you rather than with this character: the global list, and books bound to ${esc(n || 'your persona')}">
        <i class="fa-solid fa-globe"></i><span>Global &amp; persona</span>
    </div>`;
}

function extensionDividerHtml() {
    return `<div class="clp-scope-divide"
        title="Entries an extension added to this scan: in the prompt like the chat's own books, and changed only by the extension">
        <i class="fa-solid fa-puzzle-piece"></i><span>Added by extensions</span>
    </div>`;
}

// Embedded-only is inert by design, so this is an offer rather than a complaint.
function embeddedHtml() {
    if (!embeddedOffered()) return '';
    const n = _embedded.entries;
    return `<section class="cl-cwin-offer">
        <i class="cl-cwin-offer-glyph fa-solid fa-book-bookmark"></i>
        <div class="cl-cwin-offer-text">
            <p class="cl-cwin-offer-title">This card carries its own lorebook</p>
            <p class="cl-cwin-offer-body">${_embedded.placeholder
                ? `"${esc(_embedded.name)}" is linked here with no book yet. Import the card's ${n} entr${n === 1 ? 'y' : 'ies'} into it,
                or leave them on the card.`
                : `${n} entr${n === 1 ? 'y' : 'ies'}, not imported yet.
                Import "${esc(_embedded.name)}" to put it on the shelf and link it here, or leave it on the card.`}</p>
            <div class="cl-cwin-offer-acts">
                <button type="button" class="cl-cwin-btn-text" data-lore-act="import-embedded">
                    <i class="fa-solid fa-file-import"></i> Import
                </button>
                <button type="button" class="cl-cwin-offer-dismiss" data-lore-act="dismiss-embedded"
                    title="Leave the lorebook on the card and stop mentioning it">Leave It Embedded</button>
            </div>
        </div>
    </section>`;
}

function scrollToEntry(world, uid) {
    if (world == null || uid == null) return;
    document.querySelector(`.clp-entry[data-world="${CSS.escape(String(world))}"][data-uid="${uid}"]`)
        ?.scrollIntoView({ block: 'nearest' });
}

// the gear view reads the SERVER's resolved settings, the same truth the scan ran with
function settingsViewHtml() {
    const s = _state?.settings || {};
    const depth = Number(s.defaultScanDepth) || 0;
    const depthOpts = [[0, 'The whole window'], [2, 'Last 2 messages'], [4, 'Last 4 messages'],
        [8, 'Last 8 messages'], [16, 'Last 16 messages'], [32, 'Last 32 messages']];
    const toggle = (key, label, on) => `<label class="cl-cwin-field cl-cwin-toggle">
        <span class="cl-cwin-field-label">${esc(label)}</span>
        <input type="checkbox" class="cl-switch-input" data-lore-set="${key}"${on ? ' checked' : ''}>
        <span class="cl-switch" aria-hidden="true"></span>
    </label>`;
    const num = (key, label, value, attrs) => `<div class="cl-cwin-field">
        <label class="cl-cwin-field-label" for="clpSet_${key}">${esc(label)}</label>
        <input type="number" id="clpSet_${key}" class="cl-cwin-input cl-cwin-field-control cl-cwin-num"
            data-lore-set="${key}" ${attrs} value="${esc(value ?? 0)}">
    </div>`;
    const block = (control, hint) => `<div class="cl-cwin-block">${control}<p class="cl-cwin-hint">${esc(hint)}</p></div>`;
    const n = _state?.scannedMessages;
    const depthSel = `<div class="cl-cwin-field">
        <label class="cl-cwin-field-label" for="clpSet_loreScanDepth">Scan depth</label>
        <select id="clpSet_loreScanDepth" class="cl-select-fluid cl-cwin-field-control" data-lore-set="loreScanDepth">
            ${depthOpts.map(([v, lab]) => `<option value="${v}"${depth === v ? ' selected' : ''}>${lab}</option>`).join('')}
            ${depthOpts.some(([v]) => v === depth) ? '' : `<option value="${depth}" selected>Last ${depth} Messages</option>`}
        </select>
    </div>`;
    return `<div class="clp-settings">
        <p class="clp-settings-note"><i class="fa-solid fa-circle-info"></i>
            These govern lore scanning in every chat, not just this one.</p>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-magnifying-glass"></i>Scanning</h4>
            <div class="cl-cwin-fields">
                ${block(depthSel, `How many recent messages keys are looked for in. Currently scanning ${n ?? '?'} message${n === 1 ? '' : 's'}.`)}
                ${block(toggle('loreMatchWholeWords', 'Whole words only', !!s.matchWholeWords), 'Stops "bat" firing inside "bathroom". An entry can still override this for itself.')}
                ${block(toggle('loreCaseSensitive', 'Case-sensitive', !!s.caseSensitive), 'A key has to match capitalisation exactly.')}
                ${block(toggle('loreIncludeNames', 'Scan speaker names', s.includeNames !== false), 'Messages scan as "Name: text", so a key naming a character fires whenever they speak.')}
                ${block(toggle('loreStMatching', 'Match like SillyTavern', !!s.stMatching), 'Reproduces SillyTavern exactly: multi-word keys match as plain substrings and word boundaries are ASCII-only. Off is the stricter unicode-aware matching this app defaults to.')}
            </div>
        </section>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-book"></i>Books</h4>
            <div class="cl-cwin-fields">
                ${block(toggle('loreShowPlaceholders', 'Show placeholder books', CoreAPI.getSetting('loreShowPlaceholders') === true), 'A placeholder is a name a card or chat is bound to with no book behind it yet. Hidden from every picker unless this is on; the ghost chip in the lorebook manager is the same switch.')}
            </div>
        </section>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-rotate"></i>Recursion</h4>
            <div class="cl-cwin-fields">
                ${block(toggle('loreRecursive', 'Recursive scan', !!s.recursive), "Fired entries' text is itself scanned for more triggers.")}
                ${block(num('loreMaxRecursionSteps', 'Max recursion steps', s.maxRecursionSteps ?? 0, 'min="0" max="10"'), 'How many rescan passes may chain. 0 lets recursion run until nothing new fires.')}
            </div>
        </section>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-scale-balanced"></i>Budget</h4>
            <div class="cl-cwin-fields">
                ${block(num('loreBudgetPercent', 'Budget (% of context)', s.budgetPercent ?? 0, 'min="0" max="100"'), 'Lore may take this share of the context before the lowest-priority entries drop. 0 switches the budget off.')}
                ${block(num('loreBudgetCap', 'Budget cap (tokens)', s.budgetCap ?? 0, 'min="0"'), 'A fixed ceiling on top of the percentage. 0 means no cap.')}
            </div>
        </section>
        <section class="cl-cwin-group">
            <h4 class="cl-cwin-group-title"><i class="fa-solid fa-route"></i>Diagnostics</h4>
            <div class="cl-cwin-fields">
                ${block(toggle('loreFiredVia', 'Show why entries fired', s.provenance !== false), 'Chips naming the trigger: the chat message #, the recursion feeder, or the card. Only affects this panel, and skipping it saves a little scan work on very long whole-window chats.')}
            </div>
        </section>
    </div>`;
}

function renderAll() {
    const body = document.getElementById('clpBody');
    const sub = document.getElementById('clpSubhead');
    if (!body) return;
    syncFilterField();

    // Focus mode: editing swaps the body to JUST the editor; the toolbar and scan footer hide with it.
    const sheet = document.querySelector('.clp-sheet');
    const editingEntry = _editing ? entryOf(_editing.world, _editing.uid) : null;
    if (_editing && !editingEntry) _editing = null;    // deleted, or gone under a refresh
    sheet?.classList.toggle('clp-mode-edit', !!editingEntry);
    if (editingEntry) {
        body.innerHTML = editorHtml();
        if (sub) sub.textContent = 'editing';
        body.querySelectorAll('select').forEach(s => CoreAPI.initCustomSelect(s));
        return;
    }

    if (_loadError) {
        body.innerHTML = `<div class="clp-empty"><i class="fa-solid fa-triangle-exclamation"></i>
            <p>Could not read the lore state.</p><p class="clp-dim">${esc(_loadError)}</p></div>`;
        if (sub) sub.textContent = '';
        return;
    }
    if (!_state) {
        body.innerHTML = '<div class="clp-empty"><i class="fa-solid fa-circle-notch fa-spin"></i><p>Reading the lore state</p></div>';
        return;
    }

    const settingsBtn = document.getElementById('clpSettingsBtn');
    settingsBtn?.classList.toggle('is-on', _view === 'settings');
    settingsBtn?.setAttribute('aria-pressed', String(_view === 'settings'));
    // The toolbar is static, so the expand toggle's face is synced here: it shows the
    // ACTION it would take, not the state it left behind.
    const expToggle = document.getElementById('clpExpandToggle');
    if (expToggle) {
        const anyOpen = _expanded.size > 0;
        expToggle.title = anyOpen ? 'Collapse every entry and every book' : 'Expand every entry the filter shows';
        const icon = expToggle.querySelector('i');
        if (icon) icon.className = `fa-solid ${anyOpen ? 'fa-angles-up' : 'fa-angles-down'}`;
    }
    if (_view === 'settings') {
        if (sub) sub.textContent = 'scan settings';
        body.innerHTML = settingsViewHtml();
        body.querySelectorAll('select').forEach(s => CoreAPI.initCustomSelect(s));
        return;
    }

    const books = _state.worlds;
    // the books extensions added to the scan are in the prompt too, so they are counted and listed
    const extBooks = _state.extensionBooks || [];
    const shownBooks = [...books, ...extBooks];
    const entries = shownBooks.reduce((n, b) => n + b.entries.length, 0);
    const firing = shownBooks.reduce((n, b) => n + b.entries.filter(e => e.fired).length, 0);
    if (sub) {
        // terse: it rides the title line; a placeholder is a name with no book, so it isnt counted
        const realBooks = shownBooks.filter(b => !b.placeholder).length;
        sub.innerHTML = realBooks
            ? `<b>${firing}</b>/${entries} live in ${realBooks} ${realBooks === 1 ? 'book' : 'books'}`
            : shownBooks.length ? 'no book yet' : 'nothing linked';
    }

    // engine notes (eg. a placement with no marker block) go ABOVE the books: they say why something isnt sent
    const notesBand = (_state.notes || []).length
        ? `<div class="clp-notes">${_state.notes.map(n =>
            `<div class="clp-note"><i class="fa-solid fa-triangle-exclamation"></i><span>${esc(n)}</span></div>`).join('')}</div>`
        : '';

    // No trailing editor: it renders under the row it belongs to (see bookHtml). Appending
    // it here as well rendered it twice, duplicating its element ids.
    const local = books.filter(b => !isStandingBook(b));
    const standing = books.filter(isStandingBook);
    body.innerHTML = notesBand + embeddedHtml() + (books.length
        ? local.map(b => bookHtml(b)).join('')
            + (standing.length ? standingDividerHtml() + standing.map(b => bookHtml(b)).join('') : '')
        : `<div class="clp-empty"><i class="fa-solid fa-book-atlas"></i>
             <p>${extBooks.length ? 'None of this chat\'s own lorebooks reach it yet.' : 'No lorebook reaches this chat yet.'}</p>
             <p class="clp-dim">Link one to the character, bind one to this chat alone, or put one on the global list for every chat.</p>
             <button type="button" class="cl-cwin-btn-text" data-lore-act="pick">Add a Lorebook</button>
           </div>`)
        + (extBooks.length ? extensionDividerHtml() + extBooks.map(b => bookHtml(b, { byExtension: true })).join('') : '')
        + pickerHtml();

    body.querySelectorAll('select').forEach(s => CoreAPI.initCustomSelect(s));
}

// ========================================
// ACTIONS
// ========================================

async function refresh() {
    if (!_chatId) return;
    // the chat this load is FOR: a switch mid-load must not land the old answer as the new chat's state
    const forChat = _chatId;
    try {
        const next = await loadState(forChat);
        if (forChat !== _chatId) return;   // the subject moved while we were asking
        _state = next;
        _stateChatId = forChat;
        _loadError = null;
    } catch (e) {
        if (forChat !== _chatId) return;
        _loadError = e.message;
        console.error('[LorePanel] Load failed:', e.message);
    }
    renderAll();
}

/** Re-point at another conversation, or none: every write addresses a world BY NAME, so a stale subject writes the wrong book. */
function setSubject(ctx) {
    const nextId = ctx?.chatId || null;
    if (nextId === _chatId) {
        // Same chat, but its metadata may have moved (a lorebook bound or unbound).
        if (ctx) {
            _char = ctx.char ?? _char;
            _chatMeta = ctx.chatMeta ?? _chatMeta;
            if (ctx.embeddedLorebook !== undefined) _embedded = ctx.embeddedLorebook;
            void syncEmbeddedOffer();
        }
        return;
    }
    _chatId = nextId;
    _char = ctx?.char ?? null;
    _chatMeta = ctx?.chatMeta ?? null;
    _embedded = ctx?.embeddedLorebook ?? null;
    _embeddedHidden = false;    // a session hide belonged to the character we just left
    _embeddedOffer = false;
    void syncEmbeddedOffer();
    // the rest is UNKNOWN, not empty: empty would say this character has no lorebooks
    _state = null;
    _stateChatId = null;
    _loadError = null;
    _editing = null;
    _staleWhileEditing = false;
    _expanded = new Set();
    _view = 'list';
    _picking = false;
    _filter = '';
    const field = document.getElementById('clpFilter');
    if (field) field.value = '';
    if (!panelOpen) return;
    if (!_chatId) { closePanel(); return; }
    renderAll();
    refresh();
}

// global settings: write, flush (saves are debounced), then re-ask what fires; unflushed, the re-read predated the write
async function applyScanSetting(el) {
    const key = el.dataset.loreSet;
    if (!key) return;
    let v;
    if (el.type === 'checkbox') {
        v = el.checked;
    } else {
        v = Math.floor(Number(el.value));
        if (!Number.isFinite(v) || v < 0) v = 0;
        if (key === 'loreBudgetPercent') v = Math.min(100, v);
        if (key === 'loreScanDepth') v = Math.min(1000, v);
        // clamp AND reflect: silently storing a clamped value while the box shows the
        // typed one is a lie the next scan acts on
        el.value = String(v);
    }
    CoreAPI.setSetting(key, v);
    await CoreAPI.flushSettings();
    await refresh();
}

async function toggleEntry(world, uid) {
    const entry = entryOf(world, uid);
    if (!entry) return;
    if (await writeEntry(world, uid, { disable: !entry.disable })) await refresh();
}

/** Link or bind a book: character (follows it everywhere), chat (this one), global (every chat); persona binds live in the persona editor. */
async function linkBook(world, scope) {
    if (!world) return;
    if (scope === 'chat') {
        // Server-side append onto the chat's own list, the shape the other scopes use.
        const ok = await CoreAPI.applyChatWorlds(_chatId, { add: [world], source: 'lore-panel' });
        if (!ok) { CoreAPI.showToast('Could not bind the lorebook', 'error'); return; }
    } else if (scope === 'global') {
        // Server-side append: no list read, so a failed read can never become an empty
        // overwrite, and adding an already-listed book is a clean no-op.
        const ok = await CoreAPI.applyGlobalWorlds({ add: [world] });
        if (!ok) { CoreAPI.showToast('Could not add the lorebook to the global list', 'error'); return; }
    } else {
        if (!_char?.id) { CoreAPI.showToast('This chat has no character to link to', 'warning'); return; }
        const ok = await CoreAPI.applyCharWorlds(_char.id, { add: [world] });
        if (!ok) { CoreAPI.showToast('Could not link the lorebook', 'error'); return; }
    }
    _picking = false;
    await refresh();
}

async function unlinkBook(world, scope) {
    if (!world) return;
    if (scope === 'chat') {
        const ok = await CoreAPI.applyChatWorlds(_chatId, { remove: [world], source: 'lore-panel' });
        if (!ok) { CoreAPI.showToast('Could not unbind the lorebook', 'error'); return; }
    } else if (scope === 'global') {
        const ok = await CoreAPI.applyGlobalWorlds({ remove: [world] });
        if (!ok) { CoreAPI.showToast('Could not update the global list', 'error'); return; }
    } else if (scope === 'persona') {
        // unlink from the persona the server resolved for THIS chat, never a guess at the global one
        const pid = _state?.persona?.id;
        if (!pid) return;
        const ok = await CoreAPI.applyPersonaWorlds(pid, { remove: [world] });
        if (!ok) { CoreAPI.showToast('Could not unbind the lorebook from the persona', 'error'); return; }
    } else {
        if (!_char?.id) return;
        const ok = await CoreAPI.applyCharWorlds(_char.id, { remove: [world] });
        if (!ok) { CoreAPI.showToast('Could not unlink the lorebook', 'error'); return; }
    }
    await refresh();
}

/**
 * Promote the card's embedded book. The character is captured up front: the confirm inside
 * the promote path is an await the conversation can change under.
 */
async function importEmbedded() {
    const charId = _char?.id;
    if (!charId || _saving) return;
    _saving = true;
    try {
        // pass the server's name through (the reachable check looks for it); the promote announces itself
        const done = await CoreAPI.promoteEmbeddedLorebook(charId, _embedded?.name || '');
        if (!done) return;                       // cancelled, or it said why itself
        if (_char?.id !== charId) return;        // the conversation moved while we asked
        _embeddedHidden = true;
        await refresh();
    } finally {
        _saving = false;
    }
}

// "Leave it" is an answer, not a snooze: the book stays on the card and the reminders stop
async function leaveEmbedded() {
    const charId = _char?.id;
    if (!charId) return;
    if (!(await dismissEmbedded(charId))) return;
    _embeddedHidden = true;
    notifyEmbeddedResolved(charId);
    renderAll();
}

// the header's badge is told, not polled, so it clears in the same frame as the reminder
function notifyEmbeddedResolved(charId) {
    document.dispatchEvent(new CustomEvent('cl-embedded-lore-resolved', { detail: { charId } }));
}

/** The conversation's verdict on the card's own book, handed over when its read of the chat lands. */
function followEmbedded(chatId, embedded) {
    if (!chatId || chatId !== _chatId) return;
    _embedded = embedded ?? null;
    void syncEmbeddedOffer();
}

// the card's book answered at another door (the details Edit tab's Send to library): no offer, as the badge
function onEmbeddedResolved(e) {
    if (!e.detail?.charId || e.detail.charId !== _char?.id || _embeddedHidden) return;
    _embeddedHidden = true;
    if (panelOpen) renderAll();
}

// the shelf (every world file) is read when the picker opens; a failed read is null, never an empty shelf
async function openPicker() {
    _picking = true;
    renderAll();
    let files = null;
    try { files = await CoreAPI.listWorldInfoFiles(); } catch { files = null; }
    _shelf = Array.isArray(files)
        ? files.map(f => (typeof f === 'string' ? f : f?.name)).filter(Boolean).sort((a, b) => a.localeCompare(b))
        : null;
    renderAll();
}

async function saveEditor() {
    if (!_editing || _saving) return;
    const { world, uid } = _editing;
    const splitKeys = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
    _saving = true;
    try {
        // a blank number or inherit-select is null (ST's use-the-global), never false or 0
        const numOrNull = (id) => {
            const raw = document.getElementById(id)?.value;
            if (raw === undefined || String(raw).trim() === '') return null;
            const n = Number(raw);
            return Number.isFinite(n) ? n : null;
        };
        const triState = (id) => {
            const v = document.getElementById(id)?.value;
            return v === 'yes' ? true : v === 'no' ? false : null;
        };
        // Blank means the field's own value here (ENTRY_NUMBER_BLANKS), not null: these are not
        // the inherit-nullable family.
        const numOr = (id, dflt) => {
            const n = numOrNull(id);
            return n === null ? dflt : n;
        };
        const cfNames = splitKeys(document.getElementById('clpCfNames')?.value);
        const cfTags = splitKeys(document.getElementById('clpCfTags')?.value);
        const cfExclude = document.getElementById('clpCfMode')?.value === 'exclude';
        const flags = {};
        document.querySelectorAll('.clp-ms-grid input[data-flag]').forEach(i => { flags[i.dataset.flag] = i.checked; });
        const ok = await writeEntry(world, uid, {
            comment: document.getElementById('clpTitle')?.value.trim() || '',
            keys: splitKeys(document.getElementById('clpKeys')?.value),
            secondaryKeys: splitKeys(document.getElementById('clpKeys2')?.value),
            content: document.getElementById('clpContent')?.value ?? '',
            disable: !document.getElementById('clpEnabled')?.checked,
            constant: !!document.getElementById('clpConstant')?.checked,
            order: numOr('clpOrder', ENTRY_NUMBER_BLANKS.order),
            position: Number(document.getElementById('clpPosition')?.value) || 0,
            outletName: document.getElementById('clpOutlet')?.value.trim() || '',
            selectiveLogic: Number(document.getElementById('clpLogic')?.value) || 0,
            caseSensitive: triState('clpCase'),
            matchWholeWords: triState('clpWhole'),
            scanDepth: numOrNull('clpScanDepth'),
            depth: numOrNull('clpDepth'),
            role: Number(document.getElementById('clpRole')?.value) || 0,
            probability: Math.min(100, Math.max(0, numOr('clpProbability', ENTRY_NUMBER_BLANKS.probability))),
            sticky: numOrNull('clpSticky'),
            cooldown: numOrNull('clpCooldown'),
            delay: numOrNull('clpDelayTurns'),
            group: document.getElementById('clpGroup')?.value.trim() || '',
            groupWeight: numOr('clpGroupWeight', ENTRY_NUMBER_BLANKS.groupWeight),
            groupOverride: !!document.getElementById('clpGroupOverride')?.checked,
            useGroupScoring: triState('clpGroupScoring'),
            excludeRecursion: !!document.getElementById('clpExcludeRec')?.checked,
            preventRecursion: !!document.getElementById('clpPreventRec')?.checked,
            delayUntilRecursion: numOr('clpDelayRec', ENTRY_NUMBER_BLANKS.delayUntilRecursion),
            ignoreBudget: !!document.getElementById('clpIgnoreBudget')?.checked,
            triggers: [...document.querySelectorAll('.clp-trig-grid input[data-trigger]:checked')].map(i => i.dataset.trigger),
            // ST deletes an empty non-exclude filter rather than storing it; null is that
            // same answer over the merge endpoint
            characterFilter: (cfNames.length || cfTags.length || cfExclude)
                ? { isExclude: cfExclude, names: cfNames, tags: cfTags }
                : null,
            matchFlags: flags,
        });
        if (!ok) return;
        _editing = null;
        _staleWhileEditing = false;   // this re-read covers what arrived while the editor was open
        await refresh();
        scrollToEntry(world, uid);
    } finally {
        _saving = false;
    }
}

async function addEntry(world, seed) {
    const created = await createEntry(world, seed);
    if (!created) return;
    await refresh();
    const uid = created.uid ?? created.entry?.uid;
    if (uid != null) { _editing = { world, uid }; renderAll(); }
}

// ========================================
// PANEL
// ========================================

function buildPanelHTML() {
    return `
    <div class="cl-cwin clp-panel" id="chatLorePanel" aria-hidden="true">
        <aside class="cl-cwin-sheet clp-sheet" role="dialog" aria-label="Lorebooks">
            ${CoreAPI.windowGripsHtml('the lorebook panel')}
            <div class="cl-cwin-header">
                <div class="cl-cwin-title">
                    <i class="fa-solid fa-book-atlas"></i>
                    <span class="cl-cwin-name">Lorebooks</span>
                    <span class="cl-cwin-sep">·</span>
                    <span class="cl-cwin-meta" id="clpSubhead"></span>
                </div>
                <button type="button" class="cl-cwin-btn is-close" id="clpClose" title="Close" aria-label="Close lorebooks">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
            <div class="cl-cwin-filterbar cl-cwin-fieldrow clp-toolbar">
                <i class="fa-solid fa-magnifying-glass cl-cwin-filter-icon"></i>
                <input type="search" id="clpFilter" class="cl-cwin-filter" placeholder="Filter entries" aria-label="Filter entries"
                    autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
                <button type="button" class="clp-chip" id="clpFiringOnly" data-lore-act="firing-only" aria-pressed="false"
                    title="Show only the entries in the prompt right now">
                    <i class="fa-solid fa-bolt"></i> In Prompt
                </button>
                <button type="button" class="clp-chip clp-chip-icon" id="clpExpandToggle" data-lore-act="expand-toggle"
                    title="Expand every entry the filter shows" aria-label="Expand or collapse all">
                    <i class="fa-solid fa-angles-down"></i>
                </button>
                <button type="button" class="clp-chip" data-lore-act="pick" title="Link or bind a lorebook">
                    <i class="fa-solid fa-plus"></i> Add
                </button>
                <button type="button" class="clp-chip clp-chip-icon" id="clpSettingsBtn" data-lore-act="settings"
                    aria-pressed="false" title="Scan settings (they govern every chat)" aria-label="Scan settings">
                    <i class="fa-solid fa-gear"></i>
                </button>
            </div>
            <div class="clp-body" id="clpBody"></div>
        </aside>
    </div>`;
}

// One delegated listener for every control in the sheet, since every render rebuilds them.
function onPanelClick(e) {
    const btn = e.target.closest('[data-lore-act]');
    if (!btn) return;
    const world = btn.dataset.world;
    const uid = uidOf(btn.dataset.uid);
    switch (btn.dataset.loreAct) {
        // the row body READS (expands in place); the pencil opens the focus-mode editor
        case 'expand': {
            const k = expKey(world, uid);
            if (_expanded.has(k)) _expanded.delete(k); else _expanded.add(k);
            return renderAll();
        }
        case 'expand-toggle':
            if (_expanded.size) {
                _expanded.clear();
                for (const b of [...(_state?.worlds || []), ...(_state?.extensionBooks || [])]) _collapsed.add(b.name);
            } else {
                for (const b of [...(_state?.worlds || []), ...(_state?.extensionBooks || [])]) {
                    for (const en of b.entries) {
                        if (matchesFilter(en)) { _expanded.add(expKey(b.name, en.uid)); _collapsed.delete(b.name); }
                    }
                }
            }
            return renderAll();
        case 'edit':
            _editing = { world, uid };
            return renderAll();
        case 'cancel-edit': {
            const was = _editing;
            _editing = null;
            renderAll();
            if (was) scrollToEntry(was.world, was.uid);
            editorClosed();
            return undefined;
        }
        case 'save-edit': return saveEditor();
        case 'ext': {
            const en = readableEntryOf(world, uid);
            if (en) extRunAction(btn.dataset.key, loreEntryContext(world, bookEntryOf(en), _chatId));
            return undefined;
        }
        case 'toggle': return toggleEntry(world, uid);
        case 'add': return addEntry(world, {});
        case 'delete': return deleteEntry(world, uid);
        case 'collapse':
            if (_collapsed.has(world)) _collapsed.delete(world); else _collapsed.add(world);
            return renderAll();
        case 'firing-only':
            _firingOnly = !_firingOnly;
            btn.setAttribute('aria-pressed', String(_firingOnly));
            btn.classList.toggle('is-on', _firingOnly);
            return renderAll();
        case 'settings':
            _view = _view === 'settings' ? 'list' : 'settings';
            return renderAll();
        case 'pick': return void openPicker();
        case 'close-pick': _picking = false; _pickFilter = ''; return renderAll();
        case 'retry-pick': return void openPicker();
        case 'link': return void linkBook(world, btn.dataset.scope);
        case 'unlink': return void unlinkBook(world, btn.dataset.scope);
        case 'import-embedded': return void importEmbedded();
        case 'dismiss-embedded': return void leaveEmbedded();
        default: return undefined;
    }
}

function injectPanel() {
    if (panelInjected) return;
    const host = document.getElementById('chatsConversation');
    if (!host) return;
    panelInjected = true;
    host.insertAdjacentHTML('beforeend', buildPanelHTML());

    document.getElementById('clpClose')?.addEventListener('click', closePanel);

    const sheet = document.querySelector('.clp-sheet');
    mountChatWindow(sheet, {
        key: 'chatLorePanel',
        close: closePanel,
        min: { w: 18, h: 25 },
    });

    const filter = document.getElementById('clpFilter');
    filter?.addEventListener('input', CoreAPI.debounce(() => {
        _filter = filter.value.trim().toLowerCase();
        renderAll();
    }, 150));

    // The custom select dispatches input then change (the full native contract), so one
    // delegated change listener hears every control kind through the same funnel.
    sheet?.addEventListener('change', (e) => {
        if (e.target?.dataset?.loreSet) void applyScanSetting(e.target);
        else if (e.target?.id === 'clpPosition') followPlacement(e.target);
    });

    // delegated: the picker's field is rebuilt every render, so an element listener dies on the first redraw
    sheet?.addEventListener('input', (e) => {
        if (e.target?.id !== 'clpPickFilter') return;
        _pickFilter = e.target.value.trim().toLowerCase();
        const list = document.querySelector('.clp-pick-list');
        if (!list) return;
        // Only the list is redrawn, so the field keeps focus and the caret.
        const tmp = document.createElement('div');
        tmp.innerHTML = pickerHtml();
        list.innerHTML = tmp.querySelector('.clp-pick-list')?.innerHTML || '';
    });

    // <details> state is remembered here, since every re-render rebuilds it
    sheet?.addEventListener('toggle', (e) => {
        const d = e.target;
        if (!(d instanceof HTMLDetailsElement)) return;
        if (d.classList.contains('clp-adv')) _advOpen = d.open;
    }, true);

    sheet?.addEventListener('click', onPanelClick);

    registerChatWindow('chatLorePanel', { close: closePanel });
}

/**
 * @param {{chatId: string, char: object, chatMeta: object, embeddedLorebook: object}} ctx the
 *   conversation this panel is reading, passed in rather than reached for.
 * @param {{world?: string, content?: string}} [draft] seed a new entry, which is how
 *   "add this message to a lorebook" arrives here.
 */
async function openPanel(ctx, draft = null) {
    if (ctx?.chatId) setSubject(ctx);
    injectPanel();
    const panel = document.getElementById('chatLorePanel');
    if (!panel) return;
    openChatWindow(panel, { button: 'chatConvLore' });
    panelOpen = true;
    renderAll();
    await refresh();
    if (draft?.content) {
        const world = draft.world || _state?.worlds?.[0]?.name;
        if (!world) { CoreAPI.showToast('Bind a lorebook to this chat first', 'info'); return; }
        await addEntry(world, { content: draft.content, comment: draft.content.slice(0, 40) });
    }
}

function closePanel() {
    const panel = document.getElementById('chatLorePanel');
    panelOpen = false;
    closeChatWindow(panel, { button: 'chatConvLore' });
}

function togglePanel(ctx) {
    if (panelOpen) closePanel();
    else openPanel(ctx);
}

// a change elsewhere waits for an open editor (the re-read would paint over the typing); its close runs it
let _staleWhileEditing = false;

function refreshOrHold() {
    if (_editing) { _staleWhileEditing = true; return; }
    refresh();
}

function editorClosed() {
    if (!_staleWhileEditing) return;
    _staleWhileEditing = false;
    if (panelOpen && _chatId) refresh();
}

// a lorebook changed elsewhere: re-read, since what FIRES comes from the engine, not from the edit
function onWorldsChangedElsewhere(e) {
    if (!panelOpen || !_chatId) return;
    if (e.detail?.source === 'lore-panel') return;   // our own write already re-read
    refreshOrHold();
}

// Which persona is in force decides whose books are, so a persona switch re-asks the server
// what fires now.
function onPersonaChangedElsewhere() {
    if (!panelOpen || !_chatId) return;
    refreshOrHold();
}

// the panel outlives its chat and any one edit, so it subscribes to what can invalidate it
function init() {
    document.addEventListener('cl-worlds-changed', onWorldsChangedElsewhere);
    // Listening rather than being called is what makes this hold for every route into a conversation.
    document.addEventListener('cl-chat-changed', (e) => {
        setSubject(e.detail?.chatId ? e.detail : null);
    });
    document.addEventListener('cl-persona-changed', onPersonaChangedElsewhere);
    document.addEventListener('cl-embedded-lore-resolved', onEmbeddedResolved);
    // An entry verb registered or removed while entries are being read lands in their strips at once.
    document.addEventListener(EXT_ACTION_EVENT, onEntryActsChanged);
}

export { openPanel, closePanel, togglePanel, followEmbedded };
export default { init, openPanel, closePanel, togglePanel, followEmbedded, embeddedLoreNeedsAttention };
