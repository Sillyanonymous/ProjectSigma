// The command palette: one field for the whole app. Its key (the one under Esc by default) or the menu's first item opens it.
import * as CoreAPI from './core-api.js';
import { runCommand, listCommands } from './ext-registry.js';
import { rankEntries, rankKind, countKinds, groupLabel, pushRecent, readRecent, matchScore, emptyText, partialText } from './command-palette-model.js';
import { setActivePersona } from './personas.js';

const SEARCH_MS = 60;
// a letter or two names most of a library's words, so the card and message searches wait for a third
const INSIDE_MIN = 3;
const PREVIEW_MIN_WIDTH = 900;
const RECENT_KEY = 'cl-palette-recent';
const OWN_MENU_ITEM = 'commandPaletteMenuBtn';
// a group opened from its heading asks its list a page of this many at a time
const GROUP_PAGE = 50;
// what the quick search asks of each list the server answers: an answer this long may hold more
const ASKED = { character: 6, chat: 4, message: 4, lorebook: 4, entry: 4, tag: 4 };

let el = null, box = null, input = null, list = null, previewEl = null, chipEl = null, footEl = null;
let shown = [];
let at = 0;
let seq = 0;
let timer = 0;
let served = {};
// the text the server's rows were asked for: rows from an older text count only where their own words match
let servedFor = '';
let moreSeq = 0;
// the text the shown rows were drawn for: an Enter after a newer text redraws before it picks
let shownFor = null;
let activePersona = null;
// null while searching, else the open mode: 'actions', 'arg' or 'group'; prev is the group an actions or arg mode came from
let mode = null;
let searchText = '';
// the kinds whose quick answer came back full, and the headings that offer more than they show
let servedFull = new Set();
let drillable = new Set();
// the row a step back highlights again
let pendingId = null;
// the requests still out for the current text, and whether one failed: an empty list says which
let waiting = 0;
let failed = false;
// the current text's search requests: a new text or a close aborts them, so the server skips what nobody waits for
let searchCtl = null;

const esc = (s) => CoreAPI.escapeHtml(s ?? '');
const thumb = (id) => (id ? CoreAPI.getCharacterAvatarSmallThumbUrl(id) || '' : '');

// ========================================
// THE RESULTS
// ========================================

async function getJson(path, signal) {
    try {
        const resp = await CoreAPI.apiRequest(path, 'GET', null, signal ? { signal } : undefined);
        return resp.ok ? await resp.json() : null;
    } catch {
        return null;
    }
}

function characterEntry(c) {
    return {
        kind: 'character', id: `char:${c.id}`, title: c.name || 'Unnamed', note: c.creator ? `by ${c.creator}` : '',
        pic: thumb(c.id), served: true, ref: { id: c.id }, data: c,
        run: () => runCommand('character.open', { id: c.id }),
        actions: () => characterActions(c),
    };
}

async function characterActions(c) {
    const char = await CoreAPI.ensureCharacterById(c.id);
    const fav = !!(char?.fav ?? c.fav);
    const linked = !!(CoreAPI.getProviderLinkInfo(char || c)?.fullPath);
    return [
        { title: 'Open', icon: 'fa-solid fa-id-card', run: () => runCommand('character.open', { id: c.id }) },
        { title: 'Chat', icon: 'fa-solid fa-comments', run: () => char && CoreAPI.openConversationForCharacter(char) },
        { title: fav ? 'Remove from favorites' : 'Add to favorites', icon: 'fa-solid fa-star', run: () => runCommand('character.favorite', { ids: [c.id], value: !fav }) },
        { title: 'Add a tag', icon: 'fa-solid fa-tag', arg: { kind: 'tag', title: `Add a tag to ${c.name || 'this character'}`, free: true, run: (tag) => runCommand('tags.apply', { ids: [c.id], add: [tag] }) } },
        { title: 'Add to a playlist', icon: 'fa-solid fa-list', run: () => CoreAPI.openPlaylistPicker([c.id]) },
        ...(linked ? [{ title: 'Check for updates', icon: 'fa-solid fa-arrows-rotate', run: () => char && CoreAPI.getModule('card-updates')?.checkSingleCharacter?.(char) }] : []),
        { title: 'Delete', icon: 'fa-solid fa-trash', danger: true, run: async () => {
            const ok = await CoreAPI.showConfirm({ title: 'Delete character', message: `Delete ${c.name || 'this character'}? This cannot be undone.`, confirmLabel: 'Delete', danger: true });
            if (ok) { await runCommand('character.delete', { ids: [c.id] }); forget(`char:${c.id}`); }
        } },
    ];
}

function chatEntry(ch) {
    return {
        kind: 'chat', id: `chat:${ch.id}`, title: ch.name || 'Untitled chat', note: ch.characterName || ch.charName || '',
        pic: thumb(ch.charId), served: true, ref: { id: ch.id, charId: ch.charId }, data: ch,
        run: () => CoreAPI.openChatById(ch.id),
        actions: () => [
            { title: 'Open the chat', icon: 'fa-solid fa-comments', run: () => CoreAPI.openChatById(ch.id) },
            ...(ch.charId ? [{ title: `Open ${ch.characterName || ch.charName || 'the character'}`, icon: 'fa-solid fa-id-card', run: () => runCommand('character.open', { id: ch.charId }) }] : []),
        ],
    };
}

// a matched line from the server: its text escaped, its <mark> runs kept as marks
function markedHtml(snippet) {
    let inside = false;
    return String(snippet || '').replace(/\s+/g, ' ').split(/(<mark>|<\/mark>)/).map(part => {
        if (part === '<mark>') { inside = true; return ''; }
        if (part === '</mark>') { inside = false; return ''; }
        return inside ? `<mark>${esc(part)}</mark>` : esc(part);
    }).join('');
}

function messageEntry(h) {
    const line = String(h.snippet || '').replace(/<\/?mark>/g, '').replace(/\s+/g, ' ').trim();
    // the row id, never the seq: a message deleted above it renumbers the seqs
    const open = () => CoreAPI.openChatById(h.chatId, Number.isInteger(h.messageId) ? { messageId: h.messageId } : { seq: h.seq });
    return {
        kind: 'message', id: `message:${h.chatId}:${h.messageId ?? h.seq}`, title: line || 'A message', titleHtml: markedHtml(h.snippet),
        note: [h.chatName, h.charName].filter(Boolean).join(', '), pic: thumb(h.charId), served: true, score: 1.5,
        ref: { chatId: h.chatId, messageId: h.messageId, seq: h.seq, charId: h.charId, snippet: h.snippet }, data: h,
        run: open,
        actions: () => [
            { title: 'Open the chat at this message', icon: 'fa-solid fa-comments', run: open },
            ...(h.charId ? [{ title: `Open ${h.charName || 'the character'}`, icon: 'fa-solid fa-id-card', run: () => runCommand('character.open', { id: h.charId }) }] : []),
        ],
    };
}

function lorebookEntry(w) {
    const entries = Number(w.entryCount);
    return {
        kind: 'lorebook', id: `lorebook:${w.name}`, title: w.name, note: Number.isFinite(entries) ? `${entries} ${entries === 1 ? 'entry' : 'entries'}` : '',
        icon: 'fa-solid fa-book-atlas', served: true, ref: { name: w.name, entryCount: w.entryCount }, data: w, detail: 'Opens in the Lorebook Manager.',
        run: () => runCommand('lorebook.open', { name: w.name }),
        actions: () => [{ title: 'Open in the Lorebook Manager', icon: 'fa-solid fa-book-atlas', run: () => runCommand('lorebook.open', { name: w.name }) }],
    };
}

function loreEntry(h) {
    const name = h.title || h.firstKey || `Entry ${h.uid}`;
    const open = () => runCommand('lorebook.open', { name: h.world, uid: h.uid });
    const line = String(h.snippet || '').trim();
    return {
        kind: 'entry', id: `entry:${h.world}:${h.uid}`, title: name,
        titleHtml: `<span class="cl-palette-entry-name">${h.title && h.titleMarked ? markedHtml(h.titleMarked) : esc(name)}</span>${line ? ` <span class="cl-palette-entry-text">${markedHtml(line)}</span>` : ''}`,
        note: h.enabled === false ? `${h.world}, off` : h.world, icon: 'fa-solid fa-scroll', served: true, score: 1.5,
        ref: { world: h.world, uid: h.uid }, data: h,
        run: open,
        actions: () => [
            { title: 'Open the entry', icon: 'fa-solid fa-scroll', run: open },
            { title: `Open ${h.world}`, icon: 'fa-solid fa-book-atlas', run: () => runCommand('lorebook.open', { name: h.world }) },
        ],
    };
}

function tagEntry(t) {
    return {
        kind: 'tag', id: `tag:${t.name}`, title: t.name, note: Number.isFinite(Number(t.count)) ? `${t.count} ${Number(t.count) === 1 ? 'character' : 'characters'}` : '',
        icon: 'fa-solid fa-tag', served: true, ref: { name: t.name, count: t.count }, detail: 'Shows the characters that carry this tag.',
        run: () => runCommand('library.filter', { tag: t.name }),
        actions: () => [
            { title: 'Show its characters', icon: 'fa-solid fa-filter', run: () => runCommand('library.filter', { tag: t.name }) },
            ...(selectionCount() ? [{ title: 'Add it to the selected characters', icon: 'fa-solid fa-tag', run: () => tagSelection(t.name) }] : []),
        ],
    };
}

function playlistEntry(p) {
    return {
        kind: 'playlist', id: `playlist:${p.id}`, title: p.name || 'Untitled playlist', note: 'Playlist', keywords: 'playlist',
        icon: p.icon || 'fa-solid fa-list', ref: { id: p.id, name: p.name, icon: p.icon }, detail: 'Shows the characters in this playlist.',
        run: () => runCommand('library.filter', { playlist: p.id }),
    };
}

function personaEntry(p) {
    const name = p.name || 'Unnamed persona';
    const use = async () => { if (await setActivePersona(p.id)) CoreAPI.showToast(`You are ${name} now`, 'success'); };
    return {
        kind: 'persona', id: `persona:${p.id}`, title: name, note: p.id === activePersona ? 'Persona, in use' : 'Persona', keywords: `persona ${p.description || ''}`.slice(0, 200),
        icon: 'fa-solid fa-user', ref: { id: p.id, name: p.name }, data: p, detail: p.description || 'Makes this your persona in every chat.',
        run: use,
        actions: () => [
            { title: 'Use this persona', icon: 'fa-solid fa-user-check', run: use },
            { title: 'Edit it in Settings', icon: 'fa-solid fa-pen', run: () => editPersona(p.id) },
        ],
    };
}

async function editPersona(id) {
    await runCommand('settings.open', { section: 'chat' });
    document.querySelector(`#personaList .persona-row[data-id="${CSS.escape(id)}"] .persona-edit`)?.click();
}

// the bar's views, an extension's included, read off the bar itself
function viewEntries() {
    return [...document.querySelectorAll('.view-toggle-btn[data-view]')].map(b => {
        const label = b.textContent.trim() || b.dataset.view;
        return { kind: 'view', id: `view:${b.dataset.view}`, title: `Go to ${label}`, icon: b.querySelector('i')?.className || 'fa-solid fa-arrow-right', ref: { view: b.dataset.view }, detail: `Switches to the ${label} view.`, run: () => runCommand('view.switch', { view: b.dataset.view }) };
    });
}

// the menu's verbs, an extension's app actions included, read off the menu itself and run by pressing the item
function menuEntries() {
    return [...document.querySelectorAll('#moreOptionsMenu .dropdown-item')].filter(b => b.id !== OWN_MENU_ITEM && b.textContent.trim()).map(b => ({
        kind: 'action', id: `menu:${b.id || b.textContent.trim()}`, title: b.textContent.trim(), icon: b.querySelector('i')?.className || 'fa-solid fa-bolt',
        note: 'Menu', detail: 'From the More Options menu.', run: () => pressMenuItem(b),
    }));
}

function pressMenuItem(b) {
    const scope = b.dataset.viewScope;
    if (scope && (CoreAPI.getCurrentView() || 'characters') !== scope) CoreAPI.switchView(scope);
    b.click();
}

// every setting by its label, from the dialog's own rows; Settings opens on its section with the search set to it
function settingEntries() {
    const out = [];
    const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
    for (const panel of document.querySelectorAll('#gallerySettingsModal .settings-panel[data-section]')) {
        const section = panel.dataset.section;
        const sectionLabel = clean(document.querySelector(`#gallerySettingsModal .settings-nav-item[data-section="${CSS.escape(section)}"]`)?.textContent) || section;
        for (const row of panel.querySelectorAll('.settings-row')) {
            const label = clean(row.querySelector('label')?.textContent).replace(/:$/, '').slice(0, 70);
            if (label.length < 3) continue;
            const group = clean(row.closest('.settings-group')?.querySelector('.settings-group-title')?.textContent);
            const hint = clean(row.querySelector('.settings-hint')?.textContent).slice(0, 240);
            out.push({
                kind: 'setting', id: `setting:${section}:${label}`, title: label, note: [sectionLabel, group].filter(Boolean).join(', '),
                keywords: group, detail: hint || 'Opens Settings at this setting.', icon: 'fa-solid fa-gear',
                ref: { section, label }, run: () => openSettingsAt(section, label),
            });
        }
    }
    return out;
}

async function openSettingsAt(section, label) {
    await runCommand('settings.open', { section });
    const search = document.getElementById('settingsSearchInput');
    if (search && label) {
        search.value = label;
        search.dispatchEvent(new Event('input'));
    }
}

// an extension's own command that needs nothing to run
function commandEntries() {
    return listCommands().filter(c => c.owner && c.owner !== 'core' && c.title && !c.args).map(c => ({
        kind: 'command', id: `cmd:${c.id}`, title: c.title, note: c.owner, icon: 'fa-solid fa-terminal', ref: { command: c.id }, detail: `The ${c.owner} extension's ${c.id} command.`,
        run: () => runCommand(c.id),
    }));
}

function selectionCount() {
    return CoreAPI.getSelection()?.count || 0;
}

function tagSelection(tag) {
    const sel = CoreAPI.getSelection();
    return runCommand('tags.apply', sel.filter !== undefined ? { filter: sel.filter, add: [tag] } : { ids: sel.ids, add: [tag] });
}

// the verbs that ask for their input in the field itself
function argumentVerbs() {
    const verbs = [
        { title: 'Chat with', label: 'Chat with…', icon: 'fa-solid fa-comments', detail: 'Pick a character: their latest chat opens, or their first one starts.', arg: { kind: 'character', title: 'Chat with', run: async (c) => { const char = await CoreAPI.ensureCharacterById(c.id); if (char) await CoreAPI.openConversationForCharacter(char); } } },
        { title: 'Open a lorebook', label: 'Open a lorebook…', icon: 'fa-solid fa-book-atlas', detail: 'Pick a lorebook to open in the Lorebook Manager.', arg: { kind: 'lorebook', title: 'Open a lorebook', run: (w) => runCommand('lorebook.open', { name: w.name }) } },
        { title: 'Show characters tagged', label: 'Show characters tagged…', icon: 'fa-solid fa-filter', detail: 'Pick a tag: the library shows the characters that carry it.', arg: { kind: 'tag', title: 'Show characters tagged', run: (tag) => runCommand('library.filter', { tag }) } },
        { title: 'Search the library for', label: 'Search the library for…', icon: 'fa-solid fa-magnifying-glass', detail: 'Type a search: the library runs it in Characters.', arg: { kind: 'text', title: 'Search the library for', run: (query) => runCommand('library.search', { query }) } },
    ];
    if (selectionCount()) verbs.push({ title: 'Add a tag to the selection', label: 'Add a tag to the selection…', note: `${selectionCount()} selected`, icon: 'fa-solid fa-tags', detail: 'Pick a tag, or type a new one, for every selected character.', arg: { kind: 'tag', title: 'Add a tag to the selection', free: true, run: (tag) => tagSelection(tag) } });
    return verbs.map(v => ({ kind: 'action', id: `verb:${v.title}`, title: v.label, note: v.note, icon: v.icon, detail: v.detail, arg: v.arg }));
}

/** A recent entry rebuilt from what was stored. */
function fromRecent(r) {
    const ref = r.ref || {};
    let e = null;
    if (r.kind === 'character' && ref.id) e = characterEntry({ id: ref.id, name: r.title, creator: r.note.replace(/^by /, '') });
    else if (r.kind === 'chat' && ref.id) e = chatEntry({ id: ref.id, name: r.title, characterName: r.note, charId: ref.charId });
    else if (r.kind === 'message' && ref.chatId) e = messageEntry({ chatId: ref.chatId, messageId: ref.messageId, seq: ref.seq, charId: ref.charId, snippet: ref.snippet, chatName: r.note });
    else if (r.kind === 'lorebook' && ref.name) e = lorebookEntry({ name: ref.name, entryCount: ref.entryCount });
    else if (r.kind === 'entry' && ref.world && Number.isInteger(ref.uid)) e = loreEntry({ world: ref.world, uid: ref.uid, title: r.title });
    else if (r.kind === 'tag' && ref.name) e = tagEntry({ name: ref.name, count: ref.count });
    else if (r.kind === 'playlist' && ref.id) e = playlistEntry({ id: ref.id, name: ref.name, icon: ref.icon });
    else if (r.kind === 'persona' && ref.id) e = personaEntry({ id: ref.id, name: ref.name });
    else if (r.kind === 'view' && ref.view) e = viewEntries().find(v => v.ref.view === ref.view) || null;
    else if (r.kind === 'setting' && ref.section) e = { kind: 'setting', id: r.id, title: r.title, note: r.note, icon: 'fa-solid fa-gear', ref, run: () => openSettingsAt(ref.section, ref.label) };
    else if (r.kind === 'command' && ref.command) e = { kind: 'command', id: r.id, title: r.title, note: r.note, icon: 'fa-solid fa-terminal', ref, run: () => runCommand(ref.command) };
    return e && { ...e, group: 'recent' };
}

function recentList() {
    try { return readRecent(localStorage.getItem(CoreAPI.userScopedKey(RECENT_KEY))); } catch { return []; }
}

function remember(entry) {
    if (!entry.ref || entry.kind === 'action') return;
    try { localStorage.setItem(CoreAPI.userScopedKey(RECENT_KEY), JSON.stringify(pushRecent(recentList(), entry))); } catch { /* a browser that keeps nothing keeps no recents */ }
}

function forget(id) {
    try { localStorage.setItem(CoreAPI.userScopedKey(RECENT_KEY), JSON.stringify(recentList().filter(r => r.id !== id))); } catch { /* nothing kept to forget */ }
}

async function playlists() {
    try {
        await CoreAPI.playlistsLoadPlaylists();
        return (CoreAPI.playlistsGetAll() || []).filter(p => p?.uid).map(p => ({ ...p, id: p.uid }));
    } catch {
        return [];
    }
}

// built once an opening: the menu, the views, the settings and the extensions can each change between two
let localCache = null;
function localEntries() {
    localCache ||= (async () => {
        const [got, lists] = await Promise.all([getJson('/personas'), playlists()]);
        activePersona = got?.activeId ?? null;
        return [...argumentVerbs(), ...menuEntries(), ...viewEntries(), ...lists.map(playlistEntry), ...(got?.personas || []).map(personaEntry), ...settingEntries(), ...commandEntries()];
    })();
    return localCache;
}

// ========================================
// THE FIELD
// ========================================

function searchNow() {
    clearTimeout(timer);
    const q = input.value.trim();
    const mine = ++seq;
    searchCtl?.abort();
    searchCtl = new AbortController();
    const signal = searchCtl.signal;
    waiting = 0;
    failed = false;
    if (mode?.kind === 'arg') return argumentSearch(q, mine, signal);
    if (mode?.kind === 'group') return groupSearch(q, mine, signal);
    if (mode?.kind === 'actions') return draw();
    moreSeq++;
    if (!q) { served = {}; servedFor = ''; draw(); return; }
    waiting = 1;
    draw();
    timer = setTimeout(async () => {
        const enc = encodeURIComponent(q);
        // asked first, so the server answers them first
        const fast = Promise.all([
            getJson(`/characters?q=${enc}&limit=6&count=false`, signal),
            getJson(`/chats?q=${enc}&limit=4&count=false`, signal),
            getJson(`/worlds?q=${enc}&limit=4&count=false`, signal),
            getJson(`/tags?q=${enc}&limit=4&count=false`, signal),
        ]);
        const inside = q.length >= INSIDE_MIN;
        // card text is its own request, so it never crowds a name out of the six
        const cards = inside && CoreAPI.getSetting('paletteSearchCards') !== false ? getJson(`/characters?words=${enc}&limit=6&count=false`, signal) : null;
        const messages = inside && CoreAPI.getSetting('paletteSearchMessages') !== false ? getJson(`/chats/search?q=${enc}&limit=4&count=false`, signal) : null;
        const entries = inside && CoreAPI.getSetting('paletteSearchLore') !== false ? getJson(`/world-entries?q=${enc}&limit=4&count=false`, signal) : null;
        waiting = 1 + [cards, messages, entries].filter(Boolean).length;
        const [chars, chats, worlds, tags] = await fast;
        if (mine !== seq || !el) return;
        waiting--;
        if ([chars, chats, worlds, tags].includes(null)) failed = true;
        served = { character: chars?.items || [], chat: chats?.items || [], lorebook: worlds?.items || [], tag: tags?.items || [] };
        servedFor = q;
        servedFull = new Set(Object.entries(served).filter(([kind, items]) => items.length >= ASKED[kind]).map(([kind]) => kind));
        draw();
        // the inside answers join as they land, never holding the rest
        cards?.then(found => {
            if (mine !== seq || !el) return;
            waiting--;
            if (found === null) failed = true;
            const named = served.character;
            served.character = [...named, ...(found?.items || []).filter(c => !named.some(n => n.id === c.id))];
            if ((found?.items || []).length >= ASKED.character) servedFull.add('character');
            draw(true);
        });
        messages?.then(found => {
            if (mine !== seq || !el) return;
            waiting--;
            if (found === null) failed = true;
            served.message = found?.items || [];
            if (served.message.length >= ASKED.message) servedFull.add('message');
            draw(true);
        });
        entries?.then(found => {
            if (mine !== seq || !el) return;
            waiting--;
            if (found === null) failed = true;
            served.entry = found?.items || [];
            if (served.entry.length >= ASKED.entry) servedFull.add('entry');
            draw(true);
        });
    }, SEARCH_MS);
}

function argumentSearch(q, mine, signal) {
    const spec = mode.spec;
    const answer = (items, miss = false) => { if (mine === seq && el && mode?.spec === spec) { waiting = 0; failed = miss; mode.items = items; mode.itemsFor = q; draw(); } };
    const lists = { character: ['/characters', characterEntry], lorebook: ['/worlds', lorebookEntry], tag: ['/tags', tagEntry] };
    const list = lists[spec.kind];
    if (!list) return answer([]);
    clearTimeout(timer);
    waiting = 1;
    timer = setTimeout(async () => {
        const got = await getJson(`${list[0]}?q=${encodeURIComponent(q)}&limit=8&count=false`, signal);
        answer((got?.items || []).map(list[1]), !got);
    }, q ? SEARCH_MS : 0);
    draw();
}

// each kind's whole answer past the quick search's few, a page at a time by the cursor or offset its list pages by
const cursorWalk = (path, build, signal) => async (st) => {
    const got = await getJson(`${path}&limit=${GROUP_PAGE}&count=false${st?.after ? `&after=${encodeURIComponent(st.after)}` : ''}`, signal);
    return got && { items: (got.items || []).map(build), next: got.nextCursor ? { after: got.nextCursor } : null };
};
const offsetWalk = (path, build, signal) => async (st) => {
    const offset = st?.offset || 0;
    const got = await getJson(`${path}&limit=${GROUP_PAGE}&count=false&offset=${offset}`, signal);
    const items = got?.items || [];
    return got && { items: items.map(build), next: items.length === GROUP_PAGE ? { offset: offset + items.length } : null };
};

function walkFor(kind, q, signal) {
    const enc = encodeURIComponent(q);
    const inside = q.length >= INSIDE_MIN;
    if (kind === 'character') {
        // the names first, then the card text's, as the quick search lists them
        const names = cursorWalk(`/characters?q=${enc}`, characterEntry, signal);
        const words = inside && CoreAPI.getSetting('paletteSearchCards') !== false ? cursorWalk(`/characters?words=${enc}`, characterEntry, signal) : null;
        return async (st) => {
            if (!st?.words) {
                const page = await names(st);
                return page && { items: page.items, next: page.next || (words ? { words: true } : null) };
            }
            const page = await words(st.after ? { after: st.after } : null);
            return page && { items: page.items, next: page.next ? { words: true, after: page.next.after } : null };
        };
    }
    if (kind === 'chat') return cursorWalk(`/chats?q=${enc}`, chatEntry, signal);
    if (kind === 'message') return offsetWalk(`/chats/search?q=${enc}`, messageEntry, signal);
    if (kind === 'lorebook') return cursorWalk(`/worlds?q=${enc}`, lorebookEntry, signal);
    if (kind === 'entry') return offsetWalk(`/world-entries?q=${enc}`, loreEntry, signal);
    if (kind === 'tag') return cursorWalk(`/tags?q=${enc}`, tagEntry, signal);
    return null;
}

// a group of the page's own entries filters what it holds; a server's group asks for its first page
function groupSearch(q, mine, signal) {
    const m = mode;
    if (!ASKED[m.group]) return draw();
    // the same text answered: its next pages go under this search's signal, since the new search aborted the last one's
    if (m.itemsFor === q) { if (m.walk) m.walk = walkFor(m.group, q, signal); return draw(); }
    if (!q) { m.items = []; m.itemsFor = q; m.next = null; m.walk = null; return draw(); }
    waiting = 1;
    draw();
    timer = setTimeout(async () => {
        const walk = walkFor(m.group, q, signal);
        const page = await walk(null);
        if (mine !== seq || mode !== m) return;
        waiting = 0;
        failed = !page;
        // a failed page answers nothing, so the same text asks again rather than showing an empty answer
        Object.assign(m, { walk, items: page?.items || [], itemsFor: page ? q : null, next: page?.next || null, loading: false });
        draw(true);
    }, SEARCH_MS);
}

// the next page, when the list nears its end; one page in flight at a time
async function loadMore() {
    const m = mode;
    if (m?.kind !== 'group' || !m.next || m.loading || !m.walk) return;
    m.loading = true;
    const mine = seq;
    let page = null;
    // a pager that throws (its setting changed under it) answers no page, and the next scroll asks again
    try { page = await m.walk(m.next); } catch { page = null; }
    m.loading = false;
    if (mine !== seq || mode !== m || !page) return;
    const have = new Set(m.items.map(e => e.id));
    m.items.push(...page.items.filter(e => !have.has(e.id)));
    m.next = page.next;
    draw(true);
}

function openGroup(group) {
    if (mode || !input.value.trim()) return;
    searchText = input.value;
    // what the heading showed paints at once, the first page replacing it as it lands
    const items = shown.filter(e => e.kind === group).map(e => ({ ...e }));
    setMode({ kind: 'group', group, items, itemsFor: null, next: null }, `Search ${groupLabel(group).toLowerCase()}`, { text: input.value });
}

// whether a row's own words hold what is typed: the test a row from an older answer has to pass
const ownWords = (e, q) => matchScore(e.title, q) > 0 || matchScore(e.note, q) > 0;

// keep: a repaint that only adds rows keeps the highlighted one highlighted
async function draw(keep = false) {
    const keptId = pendingId ?? (keep ? shown[at]?.id : null);
    pendingId = null;
    // an empty field lists the page's own verbs and views, drawn at once: an opening never shows the last search's rows
    const local = !mode && !input.value.trim() ? [...argumentVerbs(), ...viewEntries()] : await localEntries();
    if (!el || el.hidden) return;
    const q = input.value.trim();
    shownFor = q;
    if (mode?.kind === 'actions') {
        const kept = q ? mode.actions.filter(a => a.title.toLowerCase().includes(q.toLowerCase())) : mode.actions;
        shown = kept.map(a => ({ ...a, kind: 'action', group: 'action', id: `act:${a.title}` }));
    } else if (mode?.kind === 'arg') {
        const spec = mode.spec;
        const items = (mode.items || []).filter(e => mode.itemsFor === q || ownWords(e, q)).map(e => ({ ...e, group: e.kind }));
        const free = q && (spec.kind === 'text' || (spec.free && !items.some(e => e.title.toLowerCase() === q.toLowerCase())));
        shown = [
            ...(free ? [{ kind: 'action', group: 'action', id: `free:${q}`, title: spec.kind === 'text' ? `${spec.title} "${q.slice(0, 60)}"` : `${spec.title}: "${q.slice(0, 40)}"`, icon: 'fa-solid fa-arrow-turn-down', free: q }] : []),
            ...items,
        ];
    } else if (mode?.kind === 'group') {
        const g = mode.group;
        // a server's group in the order it answered, pages appended; the page's own entries ranked, uncapped
        shown = ASKED[g] ? (mode.items || []).filter(e => mode.itemsFor === q || ownWords(e, q)).map(e => ({ ...e, group: g })) : rankKind(local, q, g);
    } else if (!q) {
        drillable = new Set();
        shown = [...recentList().map(fromRecent).filter(Boolean), ...local.filter(e => e.kind === 'view' || e.id.startsWith('verb:')).map(e => ({ ...e, group: e.kind }))];
    } else {
        const remote = [...(served.character || []).map(characterEntry), ...(served.chat || []).map(chatEntry), ...(served.message || []).map(messageEntry), ...(served.lorebook || []).map(lorebookEntry), ...(served.entry || []).map(loreEntry), ...(served.tag || []).map(tagEntry)]
            .map(e => (servedFor === q ? e : { ...e, served: false, score: ownWords(e, q) ? 1 : 0 }));
        shown = rankEntries([...remote, ...local], q);
        // a heading offers its kind whole when the kind holds more than is listed, or its server's answer came back full
        const counts = countKinds([...remote, ...local], q);
        drillable = new Set([...counts].filter(([kind, n]) => n > shown.filter(e => e.kind === kind).length || (servedFor === q && servedFull.has(kind))).map(([kind]) => kind));
    }
    const kept = keptId ? shown.findIndex(e => e.id === keptId) : -1;
    at = kept >= 0 ? kept : Math.min(at, Math.max(0, shown.length - 1));
    paintList();
}

function paintList() {
    let group = '';
    list.innerHTML = shown.length ? shown.map((e, i) => {
        const head = e.group !== group && !mode?.kind?.match(/^(actions|group)$/) ? headingHtml((group = e.group)) : '';
        const pic = e.pic
            ? `<span class="cl-palette-pic"><img src="${esc(e.pic)}" alt="" loading="lazy" decoding="async"></span>`
            : `<span class="cl-palette-icon"><i class="${esc(e.icon || 'fa-solid fa-circle')}" aria-hidden="true"></i></span>`;
        const more = (!mode || mode.kind === 'group') && e.actions ? `<span class="cl-palette-hint"><kbd class="cl-kbd">Tab</kbd> actions</span><button type="button" class="cl-palette-more" data-more="${i}" aria-label="Actions for ${esc(e.title)}"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></button>`
            : !mode && e.arg ? '<span class="cl-palette-hint"><kbd class="cl-kbd">Enter</kbd> continue</span>' : '';
        const hint = more.replace(/<button[\s\S]*<\/button>/, '');
        const button = more.match(/<button[\s\S]*<\/button>/)?.[0] || '';
        return `${head}<li class="cl-palette-item${e.danger ? ' is-danger' : ''}${e.kind === 'message' ? ' is-message' : ''}${e.kind === 'entry' ? ' is-entry' : ''}" role="presentation" data-at="${i}"><div class="cl-palette-option" role="option" id="cl-palette-opt-${i}" aria-selected="false">${pic}<span class="cl-palette-text"><span class="cl-palette-title">${e.titleHtml ?? esc(e.title)}</span>${e.note ? `<span class="cl-palette-note">${esc(e.note)}</span>` : ''}</span>${hint}</div>${button}</li>`;
    }).join('') + (mode?.kind === 'group' && mode.next ? '<li class="cl-palette-empty" role="presentation">Loading more</li>' : '')
        + (partialText({ waiting, failed }) ? `<li class="cl-palette-empty" role="presentation">${partialText({ waiting, failed })}</li>` : '')
        : `<li class="cl-palette-empty" role="presentation">${emptyText({ waiting, failed, prompt: !!mode && mode.kind !== 'actions' && !input.value.trim() })}</li>`;
    moveTo(at);
}

// a heading that offers its whole kind is a button, picked by a click, a tap or the keys
function headingHtml(group) {
    const label = esc(groupLabel(group));
    if (mode || !drillable.has(group)) return `<li class="cl-palette-group" role="presentation"><span class="cl-palette-group-label">${label}</span></li>`;
    return `<li class="cl-palette-group" role="presentation"><button type="button" class="cl-palette-group-all" data-group="${esc(group)}" aria-label="Show all ${label}"><span class="cl-palette-group-label">${label}</span><span class="cl-palette-group-more">Show all<i class="fa-solid fa-chevron-right" aria-hidden="true"></i></span></button></li>`;
}

// the cursor moves without a repaint, so a row's picture never reloads under the pointer
function moveTo(i) {
    at = i;
    for (const li of list.querySelectorAll('.cl-palette-item')) {
        const on = Number(li.dataset.at) === i;
        li.classList.toggle('is-on', on);
        li.querySelector('[role="option"]')?.setAttribute('aria-selected', String(on));
    }
    if (shown.length) input.setAttribute('aria-activedescendant', `cl-palette-opt-${i}`);
    else input.removeAttribute('aria-activedescendant');
    list.querySelector('.is-on')?.scrollIntoView?.({ block: 'nearest' });
    if (mode?.kind === 'group' && i >= shown.length - 5) void loadMore();
    paintPreview();
}

// a character's notes excerpt, read for the row the preview shows: the searches answer without the notes
const excerpts = new Map();
let excerptCtl = null;
function previewExcerpt(id) {
    if (!id || excerpts.has(id)) return excerpts.get(id) || '';
    excerpts.set(id, '');
    // the row the preview moved past is aborted, as a search the reader moved past is
    excerptCtl?.abort();
    excerptCtl = new AbortController();
    const signal = excerptCtl.signal;
    void getJson(`/characters?${new URLSearchParams({ ids: id, fields: 'creatorNotesExcerpt', count: 'false' })}`, signal).then((got) => {
        if (!got) { excerpts.delete(id); return; }
        const text = got.items?.[0]?.creatorNotesExcerpt || '';
        excerpts.set(id, text);
        const e = mode?.kind === 'actions' ? mode.entry : shown[at];
        if (text && el && !el.hidden && e?.kind === 'character' && e.data?.id === id) paintPreview();
    });
    return '';
}

function paintPreview() {
    if (!previewEl) return;
    const e = mode?.kind === 'actions' ? mode.entry : shown[at];
    const wide = !CoreAPI.isMobileMode() && window.innerWidth >= PREVIEW_MIN_WIDTH;
    box.classList.toggle('has-preview', wide);
    if (!wide) return;
    if (!e) { previewEl.innerHTML = ''; return; }
    const d = e.data || {};
    let body = '';
    if (e.kind === 'character') {
        const tags = (d.tags || []).slice(0, 8).map(t => `<span class="cl-palette-tag">${esc(t)}</span>`).join('');
        const excerpt = previewExcerpt(d.id);
        body = `<img class="cl-palette-portrait" src="${esc(CoreAPI.getCharacterAvatarThumbUrl(d.id) || '')}" alt="" decoding="async">
            <div class="cl-palette-pv-title">${esc(e.title)}</div>${e.note ? `<div class="cl-palette-pv-note">${esc(e.note)}</div>` : ''}
            ${tags ? `<div class="cl-palette-tags">${tags}</div>` : ''}
            ${excerpt ? `<p class="cl-palette-pv-text">${esc(String(excerpt).slice(0, 260))}</p>` : ''}`;
    } else if (e.kind === 'message') {
        body = `${e.pic ? `<img class="cl-palette-avatar" src="${esc(e.pic)}" alt="" decoding="async">` : ''}
            <div class="cl-palette-pv-title">${esc(d.chatName || 'A chat')}</div><div class="cl-palette-pv-note">${esc([d.charName, d.isUser ? 'your message' : ''].filter(Boolean).join(', '))}</div>
            <p class="cl-palette-pv-text">${markedHtml(d.snippet)}</p>`;
    } else if (e.kind === 'entry') {
        body = `<span class="cl-palette-pv-icon"><i class="fa-solid fa-scroll" aria-hidden="true"></i></span>
            <div class="cl-palette-pv-title">${esc(e.title)}</div><div class="cl-palette-pv-note">${esc([d.world, d.enabled === false ? 'off' : '', d.firstKey && d.title ? `keys: ${d.firstKey}` : ''].filter(Boolean).join(', '))}</div>
            ${d.snippet ? `<p class="cl-palette-pv-text">${markedHtml(d.snippet)}</p>` : ''}`;
    } else if (e.kind === 'chat') {
        const when = d.lastMesAt ? new Date(d.lastMesAt).toLocaleDateString() : '';
        body = `${e.pic ? `<img class="cl-palette-avatar" src="${esc(e.pic)}" alt="" decoding="async">` : ''}
            <div class="cl-palette-pv-title">${esc(e.title)}</div><div class="cl-palette-pv-note">${esc([e.note, d.messageCount ? `${d.messageCount} messages` : '', when].filter(Boolean).join(', '))}</div>
            ${d.lastMes ? `<p class="cl-palette-pv-text">${esc(String(d.lastMes).slice(0, 300))}</p>` : ''}`;
    } else {
        body = `<span class="cl-palette-pv-icon"><i class="${esc(e.icon || 'fa-solid fa-circle')}" aria-hidden="true"></i></span>
            <div class="cl-palette-pv-title">${esc(e.title)}</div>${e.note ? `<div class="cl-palette-pv-note">${esc(e.note)}</div>` : ''}
            ${e.detail ? `<p class="cl-palette-pv-text">${esc(String(e.detail).slice(0, 300))}</p>` : ''}`;
    }
    previewEl.innerHTML = body;
}

const FOOT = {
    search: [['↑ ↓', 'move'], ['Enter', 'open'], ['Tab', 'actions'], ['Esc', 'close']],
    actions: [['↑ ↓', 'move'], ['Enter', 'run'], ['Esc', 'back']],
    arg: [['↑ ↓', 'move'], ['Enter', 'pick'], ['Esc', 'back']],
    group: [['↑ ↓', 'move'], ['Enter', 'open'], ['Tab', 'actions'], ['Esc', 'back']],
};

function paintFoot() {
    footEl.innerHTML = FOOT[mode?.kind || 'search'].map(([keys, what]) => `<span>${keys.split(' ').map(k => `<kbd class="cl-kbd">${k}</kbd>`).join('')} ${what}</span>`).join('');
}

function setMode(next, placeholder, { text = '' } = {}) {
    mode = next;
    paintFoot();
    el.querySelector('.cl-palette-close-label').textContent = next ? 'Back' : 'Cancel';
    chipEl.hidden = !next;
    chipEl.textContent = !next ? '' : next.kind === 'arg' ? next.spec.title : next.kind === 'group' ? groupLabel(next.group) : next.entry.title;
    input.value = text;
    input.placeholder = placeholder;
    at = 0;
    searchNow();
    if (!CoreAPI.isMobileMode()) input.focus();
}

const SEARCH_PLACEHOLDER = 'Search characters, chats, lorebooks, settings and actions';

function back() {
    if (!mode) return false;
    const from = mode;
    if (from.prev) {
        pendingId = from.kind === 'actions' ? from.entry.id : null;
        setMode(from.prev, `Search ${groupLabel(from.prev.group).toLowerCase()}`, { text: from.prevText });
        return true;
    }
    setMode(null, SEARCH_PLACEHOLDER, { text: from.kind === 'group' ? input.value : searchText });
    return true;
}

// Tab on a result: its actions, or a verb's argument
async function openMore(entry) {
    if (entry?.arg) { openArg(entry.arg); return; }
    if (!entry?.actions) return;
    const mine = ++moreSeq;
    const from = mode?.kind === 'group' ? mode : null;
    const text = input.value;
    const actions = await entry.actions();
    if (mine !== moreSeq || !el || el.hidden || mode !== from) return;
    if (!from) searchText = text;
    setMode({ kind: 'actions', entry, actions, prev: from, prevText: text }, `Actions for ${entry.title}`);
}

function openArg(spec) {
    const from = mode?.kind === 'group' ? mode : null;
    if (!mode) searchText = input.value;
    setMode({ kind: 'arg', spec, items: [], prev: from, prevText: input.value }, spec.kind === 'text' ? 'Type what to search for' : `Pick a ${spec.kind}${spec.free ? ', or type a new one' : ''}`);
}

async function runAt(i) {
    if (shownFor !== input.value.trim()) await draw();
    const e = shown[i];
    if (!e) return;
    if (e.arg && !e.free) { openArg(e.arg); return; }
    if (mode?.kind === 'arg') {
        const spec = mode.spec;
        const value = e.free !== undefined ? e.free : (spec.kind === 'tag' ? e.title : spec.kind === 'lorebook' ? e.data || { name: e.title } : e.data || { id: e.ref?.id });
        close();
        if (e.free === undefined) remember(e);
        await guarded(spec.title, () => spec.run(value));
        return;
    }
    const from = mode;
    close();
    if (!e.danger) remember(from?.kind === 'actions' ? from.entry : e);
    const opened = await guarded(e.title, () => e.run());
    // an open answers false for what is gone: a recent of it leaves
    if (opened === false) {
        CoreAPI.showToast(`${e.title} is no longer there`, 'warning');
        forget((from?.kind === 'actions' ? from.entry : e).id);
    }
}

async function guarded(label, fn) {
    try {
        return await fn();
    } catch (err) {
        CoreAPI.showToast(`${label}: ${err instanceof Error ? err.message : String(err)}`, 'error');
        return undefined;
    }
}

// ========================================
// OPEN AND CLOSE
// ========================================

function build() {
    el = document.getElementById('commandPalette');
    if (el) return;
    el = document.createElement('div');
    el.id = 'commandPalette';
    el.className = 'cl-palette';
    el.hidden = true;
    el.innerHTML = `
        <div class="cl-palette-box" role="dialog" aria-modal="true" aria-label="Search everything">
            <div class="cl-palette-head">
                <i class="fa-solid fa-magnifying-glass cl-palette-mark" aria-hidden="true"></i>
                <span class="cl-palette-chip" hidden></span>
                <input type="search" class="cl-palette-input" role="combobox" aria-expanded="true" aria-controls="commandPaletteList" aria-autocomplete="list" autocomplete="one-time-code" spellcheck="false" maxlength="120">
                <button type="button" class="cl-palette-close" aria-label="Close"><kbd class="cl-kbd">Esc</kbd><span class="cl-palette-close-label">Cancel</span></button>
            </div>
            <div class="cl-palette-body">
                <ul class="cl-palette-list" id="commandPaletteList" role="listbox" aria-label="Results"></ul>
                <div class="cl-palette-preview" aria-hidden="true"></div>
            </div>
            <div class="cl-palette-foot"></div>
        </div>`;
    document.body.appendChild(el);
    box = el.querySelector('.cl-palette-box');
    input = el.querySelector('.cl-palette-input');
    list = el.querySelector('.cl-palette-list');
    previewEl = el.querySelector('.cl-palette-preview');
    chipEl = el.querySelector('.cl-palette-chip');
    footEl = el.querySelector('.cl-palette-foot');

    el.addEventListener('pointerdown', (e) => { if (e.target === el) close(); });
    el.querySelector('.cl-palette-close').addEventListener('click', () => { if (!back()) close(); });
    input.addEventListener('input', () => { at = 0; searchNow(); });
    // on the palette, not the field: a click or a right-click inside it never leaves the keys dead
    el.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!shown.length) return;
            moveTo((at + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            void runAt(at);
        } else if (e.key === 'Tab') {
            e.preventDefault();
            if (!mode || mode.kind === 'group') void openMore(shown[at]);
        } else if (e.key === 'Backspace' && !input.value && mode) {
            e.preventDefault();
            back();
        }
    });
    // a group's next page as its list nears the end
    list.addEventListener('scroll', () => {
        if (mode?.kind === 'group' && list.scrollTop + list.clientHeight >= list.scrollHeight - 160) void loadMore();
    }, { passive: true });
    list.addEventListener('pointermove', (e) => {
        const i = Number(e.target.closest?.('[data-at]')?.dataset.at);
        if (Number.isInteger(i) && i !== at) moveTo(i);
    });
    list.addEventListener('click', (e) => {
        const all = e.target.closest?.('[data-group]');
        if (all) { openGroup(all.dataset.group); return; }
        const more = e.target.closest?.('[data-more]');
        if (more) { moveTo(Number(more.dataset.more)); void openMore(shown[at]); return; }
        const i = Number(e.target.closest?.('[data-at]')?.dataset.at);
        if (Number.isInteger(i)) void runAt(i);
    });
    list.addEventListener('contextmenu', (e) => {
        const i = Number(e.target.closest?.('[data-at]')?.dataset.at);
        if (!Number.isInteger(i) || !(shown[i]?.actions || shown[i]?.arg) || (mode && mode.kind !== 'group')) return;
        e.preventDefault();
        moveTo(i);
        void openMore(shown[i]);
    });
}

export function open() {
    build();
    if (!el.hidden) { input.focus(); return; }
    served = {};
    servedFull = new Set();
    drillable = new Set();
    localCache = null;
    excerpts.clear();
    shown = [];
    at = 0;
    mode = null;
    chipEl.hidden = true;
    paintFoot();
    el.querySelector('.cl-palette-close-label').textContent = 'Cancel';
    input.value = '';
    input.placeholder = SEARCH_PLACEHOLDER;
    el.hidden = false;
    // a phone's keyboard comes up with it: focused inside the opening tap, the one moment every phone browser raises it
    if (CoreAPI.isMobileMode()) input.focus({ preventScroll: true });
    void draw();
    // the server's entries are read meanwhile for the first key; a listed persona switched elsewhere redraws its mark
    const persona = activePersona;
    void localEntries().then(() => {
        if (el && !el.hidden && !mode && !input.value.trim() && activePersona !== persona && shown.some(e => e.kind === 'persona')) void draw(true);
    });
    // shown on the next frame, so its fade runs
    requestAnimationFrame(() => {
        el?.classList.add('is-open');
        if (!CoreAPI.isMobileMode()) input?.focus();
        // a guard of its own: a phone's back closes the palette, never the page
        else window.pushOverlayGuard?.();
    });
}

export function close() {
    if (!el || el.hidden) return;
    clearTimeout(timer);
    seq++;
    waiting = 0;
    searchCtl?.abort();
    searchCtl = null;
    excerptCtl?.abort();
    el.classList.remove('is-open');
    el.hidden = true;
    mode = null;
}

export function toggle() {
    if (el && !el.hidden) close();
    else open();
}

export function isOpen() {
    return !!el && !el.hidden;
}

export function init() {
    // the topmost layer, so a phone's back reaches it first; Escape and back step out of a result's actions before closing
    window.registerOverlay?.({ id: 'commandPalette', tier: 0, close: () => { if (!back()) close(); }, visible: (node) => !node.hidden });
}

export default { init, open, close, toggle, isOpen };
