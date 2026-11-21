// A row's arrangement: its items' order, groups and dividers, and the ones hidden. Pure, so any row can use it.

const DIVIDER = 'sep:';
export const GROUP = 'group:';
const ICON = /^fa-[a-z0-9-]{1,40}$/;
const NAME_MAX = 80;
const ID_MAX = 200;

export const isDivider = (id) => typeof id === 'string' && id.startsWith(DIVIDER);
export const isGroup = (node) => !!node && typeof node === 'object' && typeof node.id === 'string' && node.id.startsWith(GROUP);
const idOf = (node) => (isGroup(node) ? node.id : node);

/**
 * A stored arrangement read safely: an unknown shape reads as the default, a repeated id keeps its first place, groups never nest.
 * @returns {{ order: Array<string|{id: string, icon: string, name: string, items: string[]}>|null, hidden: string[] }}
 */
export function normalizeArrangement(raw) {
    const out = { order: null, hidden: [] };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const seen = new Set();
    const take = (id) => {
        if (typeof id !== 'string' || !id || id.length > ID_MAX || seen.has(id)) return null;
        seen.add(id);
        return id;
    };
    if (Array.isArray(raw.order)) {
        out.order = [];
        for (const node of raw.order) {
            if (typeof node === 'string') { const id = take(node); if (id) out.order.push(id); continue; }
            if (!isGroup(node)) continue;
            const id = take(node.id);
            if (!id) continue;
            const items = (Array.isArray(node.items) ? node.items : []).map(x => (typeof x === 'string' && !x.startsWith(GROUP) ? take(x) : null)).filter(Boolean);
            out.order.push({ id, icon: typeof node.icon === 'string' && ICON.test(node.icon) ? node.icon : '', name: typeof node.name === 'string' ? node.name.slice(0, NAME_MAX) : '', items });
        }
    }
    if (Array.isArray(raw.hidden)) out.hidden = [...new Set(raw.hidden.filter(id => typeof id === 'string' && id && id.length <= ID_MAX))];
    return out;
}

/** Where an id sits: its container (the top level or a group's items) and its index there; null when absent. */
function locate(order, id) {
    for (let i = 0; i < order.length; i++) {
        if (idOf(order[i]) === id) return { group: null, index: i };
        if (isGroup(order[i])) {
            const at = order[i].items.indexOf(id);
            if (at !== -1) return { group: order[i], index: at };
        }
    }
    return null;
}

const ids = (order) => order.flatMap(n => (isGroup(n) ? [n.id, ...n.items] : [n]));

// an item's kind is its id's prefix ('ext' for 'ext:...'); an id without one is the row's own
const kindOf = (id) => (id.includes(':') ? id.slice(0, id.indexOf(':')) : '');

/**
 * The order with every live item it never met placed after the nearest one of its kind before it in the row's own order.
 * @param {{ order: Array|null }} arrangement
 * @param {string[]} defaults the row's own order of ids and dividers
 * @param {Set<string>|string[]} live the items present now
 */
export function placeAll(arrangement, defaults, live) {
    const liveSet = live instanceof Set ? live : new Set(live);
    const order = arrangement.order ? structuredClone(arrangement.order) : defaults.filter(id => isDivider(id) || liveSet.has(id));
    if (!arrangement.order) return order;
    const held = new Set(ids(order));
    for (let d = 0; d < defaults.length; d++) {
        const id = defaults[d];
        if (isDivider(id) || held.has(id) || !liveSet.has(id)) continue;
        const kind = kindOf(id);
        let at = kind ? order.length : 0;
        for (let k = d - 1; k >= 0; k--) {
            if (isDivider(defaults[k]) || kindOf(defaults[k]) !== kind) continue;
            const where = locate(order, defaults[k]);
            if (!where) continue;
            at = (where.group ? order.indexOf(where.group) : where.index) + 1;
            break;
        }
        order.splice(at, 0, id);
        held.add(id);
    }
    return order;
}

// dividers never lead, trail or double up
function tidyDividers(list) {
    const out = [];
    for (const node of list) {
        if (node.kind === 'divider' && (!out.length || out.at(-1).kind === 'divider')) continue;
        out.push(node);
    }
    while (out.length && out.at(-1).kind === 'divider') out.pop();
    return out;
}

/**
 * What the row draws: missing and hidden items skipped, empty groups dropped, no divider at an edge or beside another.
 * @returns {Array<{kind: 'item'|'divider', id: string}|{kind: 'group', id: string, icon: string, name: string, items: Array<{kind: 'item'|'divider', id: string}>}>}
 */
export function resolveArrangement(arrangement, { defaults, live }) {
    const liveSet = live instanceof Set ? live : new Set(live);
    const hidden = new Set(arrangement.hidden || []);
    const shows = (id) => liveSet.has(id) && !hidden.has(id);
    const leaf = (id) => (isDivider(id) ? { kind: 'divider', id } : shows(id) ? { kind: 'item', id } : null);
    const out = [];
    for (const node of placeAll(arrangement, defaults, liveSet)) {
        if (!isGroup(node)) { const n = leaf(node); if (n) out.push(n); continue; }
        if (hidden.has(node.id)) continue;
        const items = tidyDividers(node.items.map(leaf).filter(Boolean));
        if (items.some(n => n.kind === 'item')) out.push({ kind: 'group', id: node.id, icon: node.icon, name: node.name, items });
    }
    return tidyDividers(out);
}

// ========================================
// EDITS: each returns a new arrangement, the order placed first so nothing live is lost
// ========================================

const fresh = (order, prefix) => {
    let n = 0;
    for (const id of ids(order)) if (id.startsWith(prefix)) n = Math.max(n, Number(id.slice(prefix.length)) || 0);
    return `${prefix}${n + 1}`;
};

// the reader's edits delete, the world's keep: a group the reader emptied goes, one an extension emptied stays
function edit(arrangement, defaults, live, fn) {
    const next = { order: placeAll(arrangement, defaults, live), hidden: [...(arrangement.hidden || [])] };
    fn(next);
    next.order = next.order.filter(n => !isGroup(n) || n.items.length);
    return next;
}

function take(order, id) {
    const where = locate(order, id);
    if (!where) return null;
    const list = where.group ? where.group.items : order;
    return list.splice(where.index, 1)[0];
}

/**
 * Move a node before an id, into a group's end, or to the row's end; a group aimed at a group lands before it.
 */
export function moveNode(arrangement, defaults, live, id, { before = null, into = null } = {}) {
    return edit(arrangement, defaults, live, (next) => {
        if (id === before || id === into || !locate(next.order, id)) return;
        const moving = next.order.find(n => isGroup(n) && n.id === id);
        if (moving) {
            const aim = into || (before && locate(next.order, before)?.group?.id) || before;
            take(next.order, id);
            const at = aim ? next.order.findIndex(n => idOf(n) === aim) : -1;
            if (at === -1) next.order.push(moving); else next.order.splice(at, 0, moving);
            return;
        }
        const target = into ? next.order.find(n => isGroup(n) && n.id === into) : null;
        if (into && !target) return;
        take(next.order, id);
        if (target) { target.items.push(id); return; }
        const where = before ? locate(next.order, before) : null;
        if (!where) { next.order.push(id); return; }
        (where.group ? where.group.items : next.order).splice(where.index, 0, id);
    });
}

export function setHidden(arrangement, defaults, live, id, hide) {
    return edit(arrangement, defaults, live, (next) => {
        next.hidden = next.hidden.filter(x => x !== id);
        if (hide) next.hidden.push(id);
    });
}

/** A divider after an id, in that id's container; at the end of the row when the id is not held. */
export function addDivider(arrangement, defaults, live, afterId) {
    return edit(arrangement, defaults, live, (next) => {
        const id = fresh(next.order, DIVIDER);
        const where = afterId ? locate(next.order, afterId) : null;
        if (!where) { next.order.push(id); return; }
        const list = where.group ? where.group.items : next.order;
        list.splice(where.index + 1, 0, id);
    });
}

export function removeDivider(arrangement, defaults, live, id) {
    return edit(arrangement, defaults, live, (next) => { if (isDivider(id)) take(next.order, id); });
}

/** A new group in an item's place, holding it (beside its old group when it was filed); answers it and the group's id. */
export function newGroup(arrangement, defaults, live, id, { icon = '', name = '' } = {}) {
    let groupId = null;
    const next = edit(arrangement, defaults, live, (n) => {
        const where = locate(n.order, id);
        if (!where || isDivider(id) || (!where.group && isGroup(n.order[where.index]))) return;
        groupId = fresh(n.order, GROUP);
        const at = where.group ? n.order.indexOf(where.group) + 1 : where.index;
        take(n.order, id);
        n.order.splice(at, 0, { id: groupId, icon: ICON.test(icon) ? icon : '', name: String(name).slice(0, NAME_MAX), items: [id] });
    });
    return { arrangement: next, groupId };
}

/** A group's items back in the row where it stood, the group gone. */
export function ungroup(arrangement, defaults, live, groupId) {
    return edit(arrangement, defaults, live, (next) => {
        const at = next.order.findIndex(n => isGroup(n) && n.id === groupId);
        if (at === -1) return;
        next.order.splice(at, 1, ...next.order[at].items);
        next.hidden = next.hidden.filter(x => x !== groupId);
    });
}

/** An item out of its group, placed just after the group. */
export function ungroupItem(arrangement, defaults, live, id) {
    return edit(arrangement, defaults, live, (next) => {
        const where = locate(next.order, id);
        if (!where?.group) return;
        where.group.items.splice(where.index, 1);
        next.order.splice(next.order.indexOf(where.group) + 1, 0, id);
    });
}

export function setGroupLook(arrangement, defaults, live, groupId, { icon, name } = {}) {
    return edit(arrangement, defaults, live, (next) => {
        const group = next.order.find(n => isGroup(n) && n.id === groupId);
        if (!group) return;
        if (icon !== undefined && ICON.test(icon)) group.icon = icon;
        if (name !== undefined) group.name = String(name).slice(0, NAME_MAX);
    });
}
