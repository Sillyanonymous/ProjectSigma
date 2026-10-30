// The command palette's model: matching, ranking and the recent list. Pure, no DOM.

/** The groups a result lands in, in the order the list shows them. */
export const GROUPS = [
    ['top', 'Top hit'],
    ['recent', 'Recent'],
    ['action', 'Actions'],
    ['character', 'Characters'],
    ['chat', 'Chats'],
    ['message', 'Messages'],
    ['lorebook', 'Lorebooks'],
    ['entry', 'Lorebook entries'],
    ['tag', 'Tags'],
    ['playlist', 'Playlists'],
    ['persona', 'Personas'],
    ['view', 'Go to'],
    ['setting', 'Settings'],
    ['command', 'Commands'],
];
const GROUP_AT = new Map(GROUPS.map(([kind], i) => [kind, i]));
const GROUP_CAP = { character: 6, chat: 4, message: 4, lorebook: 4, entry: 4, tag: 4, playlist: 3, persona: 3, setting: 5, command: 5, action: 6, view: 6, recent: 6 };
export const RECENT_MAX = 8;

/** How well a text answers a query: 3 a prefix, 2 a word's start, 1 anywhere, 0 not at all. */
export function matchScore(text, query) {
    const t = String(text || '').toLowerCase();
    const q = String(query || '').trim().toLowerCase();
    if (!q) return 1;
    if (t.startsWith(q)) return 3;
    if (new RegExp(`(^|[\\s._:/>(-])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t)) return 2;
    return t.includes(q) ? 1 : 0;
}

/** An entry's score: its own when it carries one, its title, a quarter less through its note or keywords; a server answer matches. */
export function scoreOf(entry, query) {
    if (typeof entry.score === 'number') return entry.score;
    if (entry.served) return Math.max(1.5, matchScore(entry.title, query));
    const own = matchScore(entry.title, query);
    const side = Math.max(matchScore(entry.note, query), matchScore(entry.keywords, query));
    return Math.max(own, side ? side - 0.75 : 0);
}

/**
 * The list a query shows: each kind best first and capped, kinds in order, the best of all first as the top hit.
 * @param {Array<{kind: string, title: string, note?: string, keywords?: string, served?: boolean}>} entries
 * @returns {Array<object & {group: string}>}
 */
export function rankEntries(entries, query) {
    const q = String(query || '').trim();
    const scored = entries.map((e, i) => ({ e, i, s: q ? scoreOf(e, q) : 1 })).filter(x => x.s > 0);
    const byKind = new Map();
    for (const x of scored) {
        if (!byKind.has(x.e.kind)) byKind.set(x.e.kind, []);
        byKind.get(x.e.kind).push(x);
    }
    const out = [];
    let top = null;
    if (q) {
        top = scored.reduce((best, x) => (!best || x.s > best.s || (x.s === best.s && (GROUP_AT.get(x.e.kind) ?? 99) < (GROUP_AT.get(best.e.kind) ?? 99)) ? x : best), null);
        if (top && top.s >= 2) out.push({ ...top.e, group: 'top' });
        else top = null;
    }
    const kinds = [...byKind.keys()].sort((a, b) => (GROUP_AT.get(a) ?? 99) - (GROUP_AT.get(b) ?? 99));
    for (const kind of kinds) {
        const list = byKind.get(kind).filter(x => x !== top).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, GROUP_CAP[kind] ?? 5);
        for (const x of list) out.push({ ...x.e, group: kind });
    }
    return out;
}

/** Every entry of one kind that matches, best first and uncapped: the list a picked heading shows. */
export function rankKind(entries, query, kind) {
    const q = String(query || '').trim();
    return entries.map((e, i) => ({ e, i, s: q ? scoreOf(e, q) : 1 })).filter(x => x.e.kind === kind && x.s > 0)
        .sort((a, b) => b.s - a.s || a.i - b.i).map(x => ({ ...x.e, group: kind }));
}

/** How many entries of each kind match, before the caps: a heading whose kind holds more than it shows offers them all. */
export function countKinds(entries, query) {
    const q = String(query || '').trim();
    const counts = new Map();
    for (const e of entries) if (!q || scoreOf(e, q) > 0) counts.set(e.kind, (counts.get(e.kind) || 0) + 1);
    return counts;
}

/** The label a group shows. */
export const groupLabel = (group) => GROUPS.find(([kind]) => kind === group)?.[1] ?? group;

/** What an empty list says: a search still out is never "nothing", and a failed one never reads as an empty answer. */
export function emptyText({ waiting = 0, failed = false, prompt = false } = {}) {
    if (waiting > 0) return 'Searching';
    if (failed) return 'Could not search. Try again.';
    return prompt ? 'Type to search' : 'Nothing matches';
}

/** The line under a list some of whose searches failed: a group missing reads as no match without it. */
export function partialText({ waiting = 0, failed = false } = {}) {
    return waiting === 0 && failed ? 'Some of the search could not run. Try again.' : '';
}

/** A recent list with one entry put first: the same id once, at most RECENT_MAX. */
export function pushRecent(list, entry) {
    const kept = (Array.isArray(list) ? list : []).filter(r => r && r.id !== entry.id);
    return [{ id: entry.id, kind: entry.kind, title: entry.title, note: entry.note || '', ref: entry.ref ?? null }, ...kept].slice(0, RECENT_MAX);
}

/** A stored recent list read back: only well-formed entries survive. */
export function readRecent(raw) {
    let list;
    try { list = JSON.parse(raw || '[]'); } catch { return []; }
    return Array.isArray(list) ? list.filter(r => r && typeof r.id === 'string' && typeof r.kind === 'string' && typeof r.title === 'string').slice(0, RECENT_MAX) : [];
}
