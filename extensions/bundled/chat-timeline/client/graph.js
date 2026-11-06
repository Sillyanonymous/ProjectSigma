// SPDX-License-Identifier: MIT

// The timeline model, DOM-free: the server half builds and folds the tree with it, the client lays out its answer.

const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();
const speakerKey = (m) => (m?.is_user ? 'u' : m?.is_system ? 's' : 'a');

// the excerpts the answer carries: a run's line, the message a road left, a road not taken
const RUN_TEXT = 360;
const SAID_TEXT = 160;
const ALT_TEXT = 420;
const NAME_TEXT = 200;
const SNIPPET_TEXT = 160;

const speakerOf = (m) => (m?.is_user ? 'user' : m?.is_system ? 'system' : 'char');

/** The identity of a message for merging: who spoke and what was said. */
export function messageKey(m) {
    return `${speakerKey(m)}\u0000${norm(m?.mes)}`;
}

/** Whether a message's text holds the query: case-insensitive, CRLF folded; a blank query holds nothing. */
export function matchesQuery(text, query) {
    const q = norm(query).toLowerCase();
    return !!q && norm(text).toLowerCase().includes(q);
}

/** One line of a message around its first match, cut with an ellipsis on a side that goes on. */
export function snippetAround(text, query, max = SNIPPET_TEXT) {
    const t = norm(text).replace(/\s+/g, ' ');
    const q = norm(query).replace(/\s+/g, ' ').toLowerCase();
    const at = q ? t.toLowerCase().indexOf(q) : -1;
    if (at < 0 || t.length <= max) return excerpt(t, max);
    const room = max - 2;
    let start = Math.max(0, Math.min(at - Math.floor((room - q.length) / 3), t.length - room));
    const end = Math.min(t.length, start + room);
    if (end - start < room) start = Math.max(0, end - room);
    return `${start > 0 ? '…' : ''}${t.slice(start, end).trim()}${end < t.length ? '…' : ''}`;
}

/**
 * A trie of a character's chats, a node per distinct message by prefix, holding each chat's message id there.
 * @returns {{ add(chat: {id: string, messages: object[]}): void, finish(): { root: object, nodes: number } }}
 */
export function createTrie() {
    let nextId = 0;
    const mk = (parent, depth, seq, msg) => ({ id: nextId++, parent, depth, seq, msg, key: msg ? messageKey(msg) : '', children: new Map(), chats: new Set(), ends: [], ids: new Map(), swipes: false, alts: new Map() });
    const root = mk(null, -1, -1, null);
    return {
        add(chat) {
            let node = root;
            (chat.messages || []).forEach((m, i) => {
                const key = messageKey(m);
                const seq = Number.isInteger(m?.seq) ? m.seq : i;
                let next = node.children.get(key);
                if (!next) { next = mk(node, i, seq, m); node.children.set(key, next); }
                next.chats.add(chat.id);
                if (Number.isInteger(m?.id)) next.ids.set(chat.id, m.id);
                if (Array.isArray(m?.swipes) && m.swipes.length > 1) {
                    next.swipes = true;
                    const own = norm(m.mes);
                    m.swipes.forEach((sw, swipeIdx) => {
                        const text = norm(sw);
                        if (!text || text === own) return;
                        const alt = next.alts.get(text) || { text, from: [], node: next };
                        alt.from.push({ chatId: chat.id, index: i, seq, swipeIdx, id: Number.isInteger(m?.id) ? m.id : null });
                        next.alts.set(text, alt);
                    });
                }
                node = next;
            });
            node.ends.push(chat.id);
        },
        finish() {
            // an alternate a sibling continued is a real branch, and one two siblings carry is shown once
            const stack = [root];
            while (stack.length) {
                const node = stack.pop();
                const seen = new Set();
                for (const child of node.children.values()) {
                    const who = speakerKey(child.msg);
                    for (const text of [...child.alts.keys()]) {
                        const key = `${who}\u0000${text}`;
                        if (node.children.has(key) || seen.has(key)) child.alts.delete(text);
                        else seen.add(key);
                    }
                    stack.push(child);
                }
            }
            return { root, nodes: nextId - 1 };
        },
    };
}

/**
 * @param {Array<{id: string, name: string, messages: object[]}>} chats
 * @returns {{ root: object, nodes: number, chats: Map<string, object> }}
 */
export function buildTrie(chats) {
    const trie = createTrie();
    const byId = new Map();
    for (const chat of chats) {
        byId.set(chat.id, chat);
        trie.add(chat);
    }
    return { ...trie.finish(), chats: byId };
}

/**
 * Fold the trie into runs ending where it branches, a chat ends or roads split; unused alternates are a run's ghost.
 */
export function buildSegments(root, { collapse = true, roads = true } = {}) {
    let nextId = 0;
    // tasks taken first child first, so the ids fall in reading order with no call stack as deep as a chat
    const out = [];
    const tasks = [];
    const queue = (kids, parent, into) => { for (let i = kids.length - 1; i >= 0; i--) tasks.push({ start: kids[i], parent, into, at: i }); };
    queue([...root.children.values()], null, out);
    while (tasks.length) {
        const { start, parent, into, at } = tasks.pop();
        const seg = { id: nextId++, parent, nodes: [], children: [], chats: start.chats, ends: [], ghost: null };
        let node = start;
        let kids;
        for (;;) {
            seg.nodes.push(node);
            kids = [...node.children.values()];
            const alone = roads && (node.alts.size || kids[0]?.alts.size);
            if (!collapse || kids.length !== 1 || node.ends.length || alone) {
                seg.ends = node.ends.slice();
                break;
            }
            node = kids[0];
        }
        seg.children = new Array(kids.length);
        queue(kids, seg, seg.children);
        seg.first = seg.nodes[0];
        seg.last = seg.nodes[seg.nodes.length - 1];
        seg.swipes = seg.nodes.some(n => n.swipes);
        const alts = seg.nodes.flatMap(n => [...n.alts.values()]);
        if (alts.length) seg.ghost = { ghost: true, id: `g${seg.id}`, of: seg, alts, hidden: !roads };
        into[at] = seg;
    }
    return out;
}

/** Left-to-right tidy layout: col is the depth, a leaf (a shown ghost too) takes the next lane, a parent the mean of its children's. */
export function layout(segments) {
    let lane = 0;
    const all = [];
    const ghosts = [];
    const placeGhost = (seg) => {
        if (!seg.ghost || seg.ghost.hidden) return;
        seg.ghost.col = seg.col;
        seg.ghost.lane = lane++;
        ghosts.push(seg.ghost);
    };
    // a stack of its own in the recursion's order, since an unfolded chat is a segment a message deep
    const stack = [];
    const enter = (seg, col) => stack.push({ seg, ghost: true }, { seg, col, enter: true });
    for (let i = segments.length - 1; i >= 0; i--) enter(segments[i], 0);
    while (stack.length) {
        const t = stack.pop();
        const seg = t.seg;
        if (t.ghost) { placeGhost(seg); continue; }
        if (t.enter) {
            seg.col = t.col;
            all.push(seg);
            if (!seg.children.length) { seg.lane = lane++; continue; }
            stack.push({ seg, leave: true });
            for (let i = seg.children.length - 1; i >= 0; i--) enter(seg.children[i], t.col + 1);
            continue;
        }
        const ys = [];
        for (const c of seg.children) {
            ys.push(c.lane);
            if (c.ghost && !c.ghost.hidden) ys.push(c.ghost.lane);
        }
        seg.lane = (Math.min(...ys) + Math.max(...ys)) / 2;
    }
    const cols = all.reduce((m, s) => Math.max(m, s.col + 1), 0);
    return { all, ghosts, lanes: lane, cols };
}

/** The segments a chat's path runs through, root first. */
export function pathOf(segments, chatId) {
    const out = [];
    let level = segments;
    for (;;) {
        const seg = level.find(s => s.chats.has(chatId));
        if (!seg) break;
        out.push(seg);
        level = seg.children;
    }
    return out;
}

/** One line of a message for a label or a tooltip. */
export function excerpt(msg, max = 80) {
    const t = norm(typeof msg === 'string' ? msg : msg?.mes).replace(/\s+/g, ' ');
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const nameOf = (m) => (m?.name == null ? null : String(m.name).slice(0, NAME_TEXT));

/**
 * The folded runs as the server answers them, in reading order: seqs, chats with lastIds, excerpts, never a transcript.
 */
export function toWire(segments) {
    const all = [];
    const stack = [...segments].reverse();
    while (stack.length) {
        const s = stack.pop();
        all.push(s);
        for (let i = s.children.length - 1; i >= 0; i--) stack.push(s.children[i]);
    }
    all.sort((a, b) => a.id - b.id);
    return all.map(s => {
        const m = s.last.msg;
        let ghost = null;
        if (s.ghost) {
            const groups = new Map();
            for (const a of s.ghost.alts) {
                if (!groups.has(a.node)) groups.set(a.node, []);
                groups.get(a.node).push(a);
            }
            ghost = {
                hidden: s.ghost.hidden,
                groups: [...groups].map(([node, alts]) => ({
                    seq: node.seq, speaker: speakerOf(node.msg), name: nameOf(node.msg), said: excerpt(node.msg, SAID_TEXT),
                    // one chat holding the road is all taking it needs: every holder's id ran to megabytes on a heavy character
                    alts: alts.map(a => ({ text: excerpt(a.text, ALT_TEXT), from: { chatId: a.from[0].chatId, swipeId: a.from[0].swipeIdx, messageId: a.from[0].id ?? null } })),
                })),
            };
        }
        // a run of several messages names its first too: where it parts from its siblings
        const h = s.first.msg;
        const head = s.nodes.length > 1 ? { speaker: speakerOf(h), name: nameOf(h), text: excerpt(h, RUN_TEXT) } : null;
        return {
            id: s.id, parent: s.parent ? s.parent.id : null, first: s.first.seq, last: s.last.seq, n: s.nodes.length,
            speaker: speakerOf(m), name: nameOf(m), text: excerpt(m, RUN_TEXT), head,
            chats: [...s.chats], lastIds: [...s.chats].map(c => s.last.ids.get(c) ?? null), ends: s.ends.slice(), swipes: s.swipes, ghost,
        };
    });
}

/**
 * The answer as layout and pathOf take it: linked runs, `chats` a Set, `first` and `last` seqs, `lastIdOf` per chat.
 * @returns {object[]} the top-level runs
 */
export function fromWire(answer) {
    const byId = new Map();
    const top = [];
    for (const w of answer?.segments || []) {
        const seg = { ...w, parent: null, children: [], chats: new Set(w.chats || []), lastIdOf: new Map((w.chats || []).map((c, i) => [c, w.lastIds?.[i] ?? null])), ends: (w.ends || []).slice(), ghost: null };
        const parent = w.parent === null || w.parent === undefined ? null : byId.get(w.parent) || null;
        seg.parent = parent;
        (parent ? parent.children : top).push(seg);
        if (w.ghost) {
            const groups = w.ghost.groups || [];
            const alts = groups.flatMap(group => (group.alts || []).map(a => ({ ...a, group })));
            seg.ghost = { ghost: true, id: `g${seg.id}`, of: seg, hidden: !!w.ghost.hidden, groups, alts };
        }
        byId.set(seg.id, seg);
    }
    return top;
}

/**
 * The runs holding the messages a search answered ({ chatId, seqs } each), found on each chat's path.
 * @returns {Set<object>}
 */
export function segmentsAt(segments, hits) {
    const out = new Set();
    for (const { chatId, seqs } of hits || []) {
        const path = pathOf(segments, chatId);
        for (const seq of seqs || []) {
            let lo = 0, hi = path.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (seq < path[mid].first) hi = mid - 1;
                else if (seq > path[mid].last) lo = mid + 1;
                else { out.add(path[mid]); break; }
            }
        }
    }
    return out;
}
