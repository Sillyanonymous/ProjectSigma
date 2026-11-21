import crypto from 'node:crypto';
import { resolvePersona, PRONOUN_COLUMNS } from './personas-store.js';
import { setHeadWorldFor } from './world-links-store.js';
import { buildChatRuleClauses, textMatch, ftsWordsQuery } from './rule-filters.js';
import { emitChange } from './changes.js';
import { runHook } from './hook-seat.js';
import { assertMatchQuery } from './characters-store.js';
import { encodeCursor, decodeCursor } from './cursor.js';
import { messageAttachmentIds, setMessageAttachments, attachmentsOfMessages, attachmentsHeldBy, removeAttachmentFiles } from './attachments-store.js';
import { httpError } from '../lib/http-error.js';
import { parseStDate } from '../lib/st-date.js';
import { readerContext } from '../lib/reader-context.js';

export { parseStDate };

// ST chat JSONL: line 0 is the header, every later line a message; rows are the storage, the JSONL lives only at import and export

/** The card texts a chat may replace with its own (ST's Chat Character Settings Override), by their chat_metadata keys, the card field names. */
export const CHAT_CARD_OVERRIDES = Object.freeze(['system_prompt', 'scenario', 'mes_example']);

/** ST's humanized stamp ("2023-6-19 @14h 33m 07s 123ms"), the one parseStDate reads back and ST accepts. */
export function formatStDate(d = new Date()) {
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} @${d.getHours()}h ${String(d.getMinutes()).padStart(2, '0')}m ${String(d.getSeconds()).padStart(2, '0')}s ${String(d.getMilliseconds()).padStart(3, '0')}ms`;
}

function messageStats(messages) {
    let lastAt = null;
    let lastMes = null;
    for (const m of messages) {
        const at = parseStDate(m?.send_date);
        if (at && (!lastAt || at > lastAt)) lastAt = at;
        if (!m?.is_system && typeof m?.mes === 'string' && m.mes) lastMes = m.mes;
    }
    return { lastAt, lastMes: lastMes ? lastMes.slice(0, 300) : null };
}

// mes IS the message and the active alternate shows it, so a stored row keeps them equal; on import mes wins. returns a copy
export function alignActiveSwipe(msg) {
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.swipes) || msg.swipes.length === 0) return msg;
    const i = Math.min(Math.max(Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0, 0), msg.swipes.length - 1);
    const mes = typeof msg.mes === 'string' ? msg.mes : '';
    if (msg.swipes[i] === mes) return msg;
    const swipes = msg.swipes.slice();
    swipes[i] = mes;
    return { ...msg, swipes };
}

// a message's pictures are link rows, composed into raw's extra.attachments on read and diverted from it on write
function divertAttachments(msg) {
    const extra = msg?.extra;
    if (!extra || typeof extra !== 'object' || Array.isArray(extra) || !('attachments' in extra)) return { msg, ids: undefined };
    const { attachments, ...rest } = extra;
    return { msg: { ...msg, extra: rest }, ids: attachments ?? [] };
}

/** A stored row as raw carries it: its pictures' ids composed into extra.attachments when it has any. */
function composeAttachments(msg, items) {
    if (!items?.length || !msg || typeof msg !== 'object') return msg;
    const extra = msg.extra && typeof msg.extra === 'object' && !Array.isArray(msg.extra) ? msg.extra : {};
    return { ...msg, extra: { ...extra, attachments: items.map(a => a.id) } };
}

function writeMessages(db, chatId, messages) {
    db.prepare('DELETE FROM chat_messages WHERE chat_id = ?').run(chatId);
    const insert = db.prepare('INSERT INTO chat_messages (chat_id, seq, data) VALUES (?, ?, ?)');
    messages.forEach((m, i) => {
        const { msg, ids } = divertAttachments(m);
        const id = Number(insert.run(chatId, i, JSON.stringify(alignActiveSwipe(msg))).lastInsertRowid);
        if (ids?.length) setMessageAttachments(db, chatId, id, messageAttachmentIds(db, chatId, ids));
    });
}

/**
 * Create or replace a chat from ST-shaped parts. Stable id across re-imports
 * via the (char_id, name) unique pair.
 * @param {object} [opts.facts] more for the created record to say (a branch names its parent)
 */
export function upsertChat(db, { charId, name, header = {}, messages = [], imported = false, facts = {}, personaId = null, profileId = null, presetId = null }) {
    const now = Date.now();
    const existing = chatIdNamed(db, charId, name);
    const id = existing || crypto.randomUUID();
    const { lastAt } = messageStats(messages);
    const createdAt = parseStDate(header.create_date);
    // the header's world_info lifts to the head of chat_worlds as a card's extensions.world does; a header silent on it leaves the binding
    const rawMeta = header.chat_metadata && typeof header.chat_metadata === 'object' ? { ...header.chat_metadata } : {};
    const hasWorldKey = 'world_info' in rawMeta;
    const headWorld = typeof rawMeta.world_info === 'string' ? rawMeta.world_info.trim() : '';
    delete rawMeta.world_info;

    // the row never exists without its rows; message_count and last_mes are trigger-owned, so the row starts at zero
    db.transaction(() => {
        db.prepare(`
            INSERT INTO chats (id, char_id, name, user_name, character_name, chat_metadata,
                               create_date, message_count, last_mes_at, last_mes, imported_at, updated_at, persona_id, profile_id, preset_id)
            VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, ?), 0, ?, NULL, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                user_name = excluded.user_name,
                character_name = excluded.character_name,
                chat_metadata = excluded.chat_metadata,
                create_date = COALESCE(?, chats.create_date),
                last_mes_at = excluded.last_mes_at,
                imported_at = COALESCE(excluded.imported_at, chats.imported_at),
                updated_at = excluded.updated_at,
                persona_id = COALESCE(excluded.persona_id, chats.persona_id),
                profile_id = COALESCE(excluded.profile_id, chats.profile_id),
                preset_id = COALESCE(excluded.preset_id, chats.preset_id)
        `).run(
            id, charId, name,
            header.user_name ?? null,
            header.character_name ?? null,
            JSON.stringify(rawMeta),
            // never NULL (the cursor bounds on it): the header's date, else now; a replace keeps the stored one unless the header names one
            createdAt, now,
            lastAt,
            imported ? now : null,
            now,
            personaId,
            profileId,
            presetId,
            createdAt,
        );
        writeMessages(db, id, messages);
        if (hasWorldKey) setHeadWorldFor(db, 'chat', id, headWorld);
        emitChange(db, { entity: 'chat', op: existing ? 'updated' : 'created', ids: [id], charId, ...facts });
    })();
    return { id, created: !existing };
}

// last_mes is cut to a preview: the client shows 150 chars, and 200 keeps its "is there more" test (length > 150) exact
const LIST_PREVIEW_CHARS = 200;
const LIST_COLUMNS = `
    SELECT ch.id, ch.rowid AS chat_rowid, ch.char_id, ch.name, ch.user_name, ch.character_name, ch.chat_metadata,
           ch.create_date, ch.message_count, ch.last_mes_at, ch.sort_at,
           substr(ch.last_mes, 1, ${LIST_PREVIEW_CHARS}) AS last_mes, ch.updated_at, ch.draft, p.name AS persona_name,
           ${Object.values(PRONOUN_COLUMNS).map(col => `p.${col} AS persona_${col}`).join(', ')},
           c.rowid AS char_rowid, c.name AS char_name, c.chat_count AS char_chat_count, c.last_chat_at AS char_last_chat_at,
           (SELECT json_group_array(cw.world_name ORDER BY cw.pos) FROM chat_worlds cw WHERE cw.chat_id = ch.id) AS worlds`;
// inner join (a chat always has its character); FROM_CHARS's CROSS JOIN is never reordered, so a character-led order walks its index
const FROM_CHATS = `
    FROM chats ch JOIN characters c ON c.id = ch.char_id LEFT JOIN personas p ON p.id = ch.persona_id`;
const FROM_CHARS = `
    FROM characters c CROSS JOIN chats ch ON ch.char_id = c.id LEFT JOIN personas p ON p.id = ch.persona_id`;
const LIST_SELECT = `${LIST_COLUMNS}${FROM_CHATS}
`;

// the list's head is composed into the metadata as world_info, as a card composes extensions.world
function composeChatMeta(raw, worldsJson) {
    const meta = chatMetadataOf(raw);
    const worlds = JSON.parse(worldsJson || '[]');
    if (worlds[0]) meta.world_info = worlds[0];
    else delete meta.world_info;
    return meta;
}

// grouped: the row carries its character's chat count, the grouped view's header number;
// the plain answer keeps the shape every older reader has
function mapListRow(r, grouped = false) {
    return {
        ...(grouped ? { charChatCount: r.char_chat_count ?? 0 } : {}),
        id: r.id,
        charId: r.char_id,
        name: r.name,
        userName: r.user_name,
        characterName: r.character_name,
        charName: r.char_name,
        worlds: JSON.parse(r.worlds || '[]'),
        chatMetadata: composeChatMeta(r.chat_metadata, r.worlds),
        createDate: r.create_date,
        messageCount: r.message_count,
        lastMesAt: r.last_mes_at,
        lastMes: r.last_mes,
        updatedAt: r.updated_at,
        draft: r.draft ?? null,
        personaName: r.persona_name ?? null,
        // the override's forms beside its name, so a preview of the greeting answers them as the transcript does
        personaPronouns: r.persona_name == null ? null : Object.fromEntries(Object.entries(PRONOUN_COLUMNS).map(([key, col]) => [key, r[`persona_${col}`] ?? ''])),
    };
}

/**
 * A stored message in the wire's native shape: id, place, when (send_date on the reader's clock), role, name, text, and the stored row as raw.
 * @param {{id: number, seq: number, msg: object}} row as listMessageRows answers one
 * @returns {{ id: number, seq: number, createdAt: number|null, role: 'user'|'assistant'|'system', name: string|null, content: string, raw: object }}
 */
export function projectMessage({ id, seq, msg, attachments = [] }) {
    return {
        id,
        seq,
        createdAt: parseStDate(msg?.send_date, readerContext()),
        role: msg?.is_system ? 'system' : msg?.is_user ? 'user' : 'assistant',
        name: typeof msg?.name === 'string' ? msg.name : null,
        content: typeof msg?.mes === 'string' ? msg.mes : '',
        attachments,
        raw: composeAttachments(msg, attachments),
    };
}

/** Stored rows ({ id, seq, msg }) as ChatMessages, their pictures read in one query. */
export function projectMessages(db, rows) {
    const pictures = attachmentsOfMessages(db, rows.map(r => r.id));
    return rows.map(r => projectMessage({ ...r, attachments: pictures.get(r.id) || [] }));
}

// the chats view's sorts, null-prototype (sort=constructor must never reach the ORDER BY); pick reads each key back for the cursor
export const CHAT_SORTS = Object.assign(Object.create(null), {
    recent: { expr: 'ch.sort_at', dir: 'DESC', pick: r => r.sort_at },
    oldest: { expr: 'ch.sort_at', dir: 'ASC', pick: r => r.sort_at },
    name: { expr: 'ch.name COLLATE NOCASE', dir: 'ASC', pick: r => r.name },
    messages: { expr: 'ch.message_count', dir: 'DESC', pick: r => r.message_count },
    created: { expr: 'ch.create_date', dir: 'DESC', pick: r => r.create_date },
    character: { expr: 'c.name COLLATE NOCASE', dir: 'ASC', pick: r => r.char_name, charLevel: true, tie: 'opposite' },
    chats: { expr: 'c.chat_count', dir: 'DESC', pick: r => r.char_chat_count, charLevel: true, tie: 'same' },
});

// the ORDER BY tuple, each key ending on the rowid in the walk's direction so the walk satisfies it; grouped leads with a per-character key
function orderKeys(sortName, order, grouped) {
    const s = CHAT_SORTS[sortName];
    const dir = order === 'asc' ? 'ASC' : order === 'desc' ? 'DESC' : s.dir;
    const flip = d => (d === 'ASC' ? 'DESC' : 'ASC');
    const own = { expr: s.expr, dir, pick: s.pick };
    const chatRowid = d => ({ expr: 'ch.rowid', dir: d, pick: r => r.chat_rowid });
    const charRecent = d => ({ expr: 'c.last_chat_at', dir: d, pick: r => r.char_last_chat_at });
    const charRowid = d => ({ expr: 'c.rowid', dir: d, pick: r => r.char_rowid });
    const withinNewest = [{ expr: 'ch.sort_at', dir: 'DESC', pick: r => r.sort_at }, chatRowid('DESC')];
    if (s.charLevel) return { fromChars: true, keys: [own, charRecent(s.tie === 'opposite' ? flip(dir) : dir), charRowid(dir), ...withinNewest] };
    if (!grouped) return { fromChars: false, keys: [own, chatRowid(dir)] };
    const groupDir = s.expr === 'ch.sort_at' ? dir : 'DESC';
    return { fromChars: true, keys: [charRecent(groupDir), charRowid(groupDir), own, chatRowid(dir)] };
}

// rows strictly after a cursor tuple: a bound on the leading key (the seek) plus the lexicographic residual; every key is NOT NULL
function keysetAfter(keys, values) {
    const params = [];
    const cmp = k => (k.dir === 'ASC' ? '>' : '<');
    const residual = (i) => {
        const k = keys[i];
        params.push(values[i]);
        if (i === keys.length - 1) return `${k.expr} ${cmp(k)} ?`;
        const strictly = `${k.expr} ${cmp(k)} ?`;
        params.push(values[i]);
        return `(${strictly} OR (${k.expr} = ? AND ${residual(i + 1)}))`;
    };
    params.push(values[0]);
    const bound = `${keys[0].expr} ${cmp(keys[0])}= ?`;
    return { sql: `${bound} AND ${residual(0)}`, params };
}

// the shared codec under the names this store's door has always offered
export { encodeCursor as encodeChatCursor, decodeCursor as decodeChatCursor };

/**
 * The page query behind listChats, exported so its plan can be read.
 * @returns {{ sql: string, params: any[], keys: object[], where: string, whereParams: any[] }}
 */
export function chatListQuery(db, { charId, world, q, rules, sort, order, limit, offset, after, grouped = false } = {}) {
    const conds = [];
    const params = [];
    if (charId) { conds.push('ch.char_id = ?'); params.push(charId); }
    // world: exact name, or 'any' = bound to anything
    if (world === 'any') conds.push('EXISTS (SELECT 1 FROM chat_worlds cw WHERE cw.chat_id = ch.id)');
    else if (world) { conds.push('EXISTS (SELECT 1 FROM chat_worlds cw WHERE cw.chat_id = ch.id AND cw.world_name = ?)'); params.push(world); }
    // q matches the chat's name or its character's; the character arm seeks the walked chat's character, costing the chats walked, not the library
    if (q) {
        const own = textMatch('ch.name', q);
        const its = textMatch('name', q);
        // INDEXED BY: name is generated, so the planner never rates (id, name) covering and would read the row
        conds.push(`(${own.sql} OR EXISTS (SELECT 1 FROM characters INDEXED BY idx_characters_id_name WHERE id = ch.char_id AND ${its.sql}))`);
        params.push(...own.params, ...its.params);
    }
    if (Array.isArray(rules) && rules.length) {
        const built = buildChatRuleClauses(db, rules);
        conds.push(...built.clauses);
        params.push(...built.params);
    }
    const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';

    const sortName = CHAT_SORTS[sort] ? sort : 'recent';
    const { fromChars, keys } = orderKeys(sortName, order, !!grouped);
    const lim = Number.isInteger(limit) && limit > 0 ? limit : null;
    let cursorSql = '';
    const cursorParams = [];
    if (after && lim) {
        const vals = decodeCursor(after, keys.length);
        if (!vals) throw httpError(400, 'invalid after cursor');
        const k = keysetAfter(keys, vals);
        cursorSql = `${where ? ' AND ' : ' WHERE '}${k.sql}`;
        cursorParams.push(...k.params);
    }
    const off = lim && !cursorSql && Number.isInteger(offset) && offset > 0 ? offset : 0;
    let sql = `${LIST_COLUMNS}${fromChars ? FROM_CHARS : FROM_CHATS}${where}${cursorSql} ORDER BY ${keys.map(k => `${k.expr} ${k.dir}`).join(', ')}`;
    const pageParams = [...params, ...cursorParams];
    if (lim) { sql += ' LIMIT ? OFFSET ?'; pageParams.push(lim, off); }
    return { sql, params: pageParams, keys, where, whereParams: params, limit: lim, offset: off };
}

/** The chats list windowed and ordered in SQL; after is a keyset cursor over the sort's full tuple, grouped keeps characters contiguous. */
export function listChats(db, opts = {}) {
    const { grouped = false, count = true } = opts;
    const { sql, params, keys, where, whereParams, limit, offset } = chatListQuery(db, opts);
    // COUNT sees the same join and clauses, because q and the rules reach through it to c
    const total = count === false ? null
        : db.prepare(`SELECT COUNT(*) n${FROM_CHATS}${where}`).get(...whereParams).n;
    const raws = db.prepare(sql).all(...params);
    const out = { items: raws.map(r => mapListRow(r, !!grouped)), total, limit, offset };
    // present only on a windowed answer: an unwindowed one has no next page to name
    if (limit) {
        const last = raws[raws.length - 1];
        out.nextCursor = raws.length === limit ? encodeCursor(keys.map(k => k.pick(last))) : null;
    }
    return out;
}

export function listChatsForChar(db, charId) {
    return listChats(db, { charId }).items;
}

// a card's own character_book is no lore source; this reports that it exists, on the read every conversation open already makes
function embeddedLorebookFor(db, charId, chatId) {
    if (!charId) return null;
    // Extract the count and the name, never the book itself: a 140 entry book is a big blob
    // to move for what is ultimately a boolean.
    const row = db.prepare(`
        SELECT json_array_length(json_extract(card, '$.data.character_book.entries')) AS entries,
               json_extract(card, '$.data.character_book.name') AS book_name,
               name AS char_name
        FROM characters WHERE id = ?`).get(charId);
    if (!row?.entries) return null;

    // the name a promotion would land under, kept identical to the client's promote path: a mismatch leaves a reminder that never clears
    const name = String(row.book_name || '').trim() || `${row.char_name || 'Character'}'s Lorebook`;

    // reachable through any of the four scopes to a real book; a placeholder of the name is no book (ph is MIN(placeholder) per scope)
    const scopes = [
        db.prepare(`SELECT MIN(w.placeholder) AS ph FROM char_worlds b JOIN worlds w ON w.name = b.world_name
            WHERE b.char_id = ? AND b.world_name = ? COLLATE NOCASE`).get(charId, name),
        chatId ? db.prepare(`SELECT MIN(w.placeholder) AS ph FROM chat_worlds b JOIN worlds w ON w.name = b.world_name
            WHERE b.chat_id = ? AND b.world_name = ? COLLATE NOCASE`).get(chatId, name) : null,
        db.prepare(`SELECT MIN(w.placeholder) AS ph FROM global_worlds b JOIN worlds w ON w.name = b.world_name
            WHERE b.world_name = ? COLLATE NOCASE`).get(name),
    ];
    const persona = resolvePersona(db, chatId || null).persona;
    if (persona) {
        scopes.push(db.prepare(`SELECT MIN(w.placeholder) AS ph FROM persona_worlds b JOIN worlds w ON w.name = b.world_name
            WHERE b.persona_id = ? AND b.world_name = ? COLLATE NOCASE`).get(persona.id, name));
    }
    const linked = scopes.filter(s => s && s.ph !== null);
    const reachable = linked.some(s => s.ph === 0);
    // linked by the name, but only to a placeholder: the import fills that slot
    return { name, entries: row.entries, reachable, placeholder: !reachable && linked.length > 0 };
}

/**
 * A chat with its messages, windowed, each message as projectMessage shapes it.
 */
export function getChatDetail(db, id, { msgOffset, msgLimit, msgTail } = {}) {
    const row = db.prepare(`${LIST_SELECT} WHERE ch.id = ?`).get(id);
    if (!row) return null;
    // msgTail wins: the newest n by offset needs a count first, and msgLimit=1 is the greeting, the opposite end
    const tail = Number.isInteger(msgTail) && msgTail > 0 ? msgTail : null;
    let rows;
    let lim = null;
    let off = 0;
    if (tail) {
        // reversed back to ascending so every consumer downstream sees the order it always did
        rows = db.prepare('SELECT id, seq, data FROM chat_messages WHERE chat_id = ? ORDER BY seq DESC LIMIT ?')
            .all(id, tail).reverse();
    } else {
        let sql = 'SELECT id, seq, data FROM chat_messages WHERE chat_id = ? ORDER BY seq';
        const params = [id];
        lim = Number.isInteger(msgLimit) && msgLimit > 0 ? msgLimit : null;
        off = Number.isInteger(msgOffset) && msgOffset > 0 ? msgOffset : 0;
        if (lim || off) { sql += ' LIMIT ? OFFSET ?'; params.push(lim ?? -1, off); }
        rows = db.prepare(sql).all(...params);
    }
    const page = { msgOffset: off, msgLimit: lim, msgTail: tail, embeddedLorebook: embeddedLorebookFor(db, row.char_id, id) };
    return { ...mapListRow(row), messages: projectMessages(db, rows.map(r => ({ id: r.id, seq: r.seq, msg: JSON.parse(r.data) }))), ...page };
}

export function replaceChatMessages(db, id, messages) {
    const row = db.prepare('SELECT id FROM chats WHERE id = ?').get(id);
    if (!row) return false;
    const { lastAt } = messageStats(messages);
    db.transaction(() => {
        writeMessages(db, id, messages);
        db.prepare('UPDATE chats SET last_mes_at = ?, updated_at = ? WHERE id = ?').run(lastAt, Date.now(), id);
        emitChange(db, { entity: 'message', op: 'updated', chatId: id, all: true });
    })();
    return true;
}

// last_mes_at is the one derived column the store keeps (ST send_dates need the JS parser): raised on append, recomputed otherwise
function syncLastMesAt(db, id) {
    const { lastAt } = messageStats(db.prepare('SELECT data FROM chat_messages WHERE chat_id = ? ORDER BY seq').all(id).map(r => JSON.parse(r.data)));
    db.prepare('UPDATE chats SET last_mes_at = ?, updated_at = ? WHERE id = ?').run(lastAt, Date.now(), id);
}
function raiseLastMesAt(db, id, message) {
    const at = parseStDate(message?.send_date);
    db.prepare('UPDATE chats SET last_mes_at = CASE WHEN ? IS NULL THEN last_mes_at WHEN last_mes_at IS NULL OR last_mes_at < ? THEN ? ELSE last_mes_at END, updated_at = ? WHERE id = ?')
        .run(at, at, at, Date.now(), id);
}

/**
 * Append one message row; returns { id, seq, message } or null when the chat is gone.
 * @param {object} [opts.chatMetadata] keys merged into the chat's metadata in the same write (what
 *   a sent turn's macros set), as patchChat merges them
 */
export function appendChatMessage(db, id, message, { chatMetadata = null } = {}) {
    const diverted = divertAttachments(message);
    message = alignActiveSwipe(diverted.msg);
    const row = db.prepare('SELECT id FROM chats WHERE id = ?').get(id);
    if (!row) return null;
    let seq;
    let messageId;
    db.transaction(() => {
        if (chatMetadata && Object.keys(chatMetadata).length) patchChat(db, id, { chatMetadata });
        seq = (db.prepare('SELECT MAX(seq) s FROM chat_messages WHERE chat_id = ?').get(id).s ?? -1) + 1;
        messageId = Number(db.prepare('INSERT INTO chat_messages (chat_id, seq, data) VALUES (?, ?, ?)')
            .run(id, seq, JSON.stringify(message)).lastInsertRowid);
        if (diverted.ids?.length) setMessageAttachments(db, id, messageId, messageAttachmentIds(db, id, diverted.ids));
        raiseLastMesAt(db, id, message);
        emitChange(db, { entity: 'message', op: 'created', chatId: id, ids: [seq], messageIds: [messageId] });
    })();
    return { id: messageId, seq, message };
}

// the wire's keys never land on a stored row, which exports verbatim as JSONL; raw first: carrying both means a native message posted back
const RESERVED_MESSAGE_KEYS = new Set(['raw', 'seq']);

/** The first key of a supplied message the store keeps off stored rows (raw, seq), or null. */
export function reservedMessageKey(message) {
    if (!message || typeof message !== 'object') return null;
    return [...RESERVED_MESSAGE_KEYS].find(k => Object.hasOwn(message, k)) ?? null;
}

// a seq is a place a delete renumbers: a caller naming the id it was shown is refused when another message holds that place
const SHOWN_CHANGED = 'that message changed since it was shown';
/** Throw the 409 when the caller named a message id (not null) and the row at its seq is another. */
export function refuseUnlessShown(row, messageId) {
    if (messageId !== null && messageId !== undefined && row?.id !== messageId) {
        throw httpError(409, SHOWN_CHANGED);
    }
}

// a verb on one alternate names what the reader was shown, so a stale page never drops or buries one it never saw
const ALTERNATES_CHANGED = 'that message\'s alternates changed since they were shown; nothing was written';
// the alternates a message shows: a message with none shows its one text
const shownCount = (msg) => (Array.isArray(msg.swipes) && msg.swipes.length ? msg.swipes.length : 1);

// an edit or a generate names the active alternate it was shown, so a stale page never rewrites or grows one it never saw
const ACTIVE_CHANGED = 'that message changed since it was shown (an alternate added, dropped, picked or rewritten elsewhere); nothing was written';

/** What a caller says it was shown of a message, checked: { index, count, text } of its active alternate; null when absent. */
export function shownActiveOf(v, name = 'shown') {
    if (v === undefined || v === null) return null;
    const ok = typeof v === 'object' && !Array.isArray(v) && Number.isInteger(v.count) && v.count >= 1
        && Number.isInteger(v.index) && v.index >= 0 && v.index < v.count && typeof v.text === 'string';
    if (!ok) throw httpError(400, `${name} must be what the reader was shown of the message: { index, count, text }, its active alternate's place (0 to count - 1), the alternates counted (1 for a message with none) and that alternate's text`);
    return { index: v.index, count: v.count, text: v.text };
}

/** Throw the 409 when the caller named what it was shown (not null) and the stored message's active alternate, count or text is another. */
export function refuseUnlessActiveShown(msg, shown) {
    if (!shown) return;
    const m = msg && typeof msg === 'object' ? msg : {};
    const at = activeAt(m);
    const text = at !== null ? m.swipes[at] : m.mes;
    if (shownCount(m) !== shown.count || (at ?? 0) !== shown.index || (typeof text === 'string' ? text : '') !== shown.text) {
        throw httpError(409, ACTIVE_CHANGED);
    }
}

// extra is a shared bag (server and client leaves), so it merges key by key and null deletes a leaf; a non-object bag is replaced
const EXTRA_TYPED = { hidden: v => v === true || v === false };
// a JSON body can carry these as own keys, and writing them onto a plain object rewires it
const UNSAFE_LEAVES = new Set(['__proto__', 'constructor', 'prototype']);

function mergeExtra(msg, patch) {
    if (patch === null) { delete msg.extra; return; }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw httpError(400, 'extra must be an object of leaves (a null leaf deletes it), or null to drop the bag');
    for (const [leaf, v] of Object.entries(patch)) {
        if (UNSAFE_LEAVES.has(leaf)) throw httpError(400, `extra.${leaf} is not a leaf`);
        if (v !== null && Object.hasOwn(EXTRA_TYPED, leaf) && !EXTRA_TYPED[leaf](v)) throw httpError(400, `extra.${leaf} must be true, false or null`);
    }
    const next = msg.extra && typeof msg.extra === 'object' && !Array.isArray(msg.extra) ? { ...msg.extra } : {};
    for (const [leaf, v] of Object.entries(patch)) {
        if (v === null) delete next[leaf];
        else next[leaf] = v;
    }
    msg.extra = next;
}

// mes is the generated column FTS indexes and prompts read, so it IS the active alternate: moving the selection moves mes
export function syncActiveSwipe(msg, mesIsAuthoritative) {
    if (!Array.isArray(msg.swipes) || msg.swipes.length === 0) return;
    const i = Math.min(Math.max(Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0, 0), msg.swipes.length - 1);
    msg.swipe_id = i;
    if (mesIsAuthoritative) msg.swipes[i] = msg.mes ?? '';
    else msg.mes = msg.swipes[i];
    if (!Array.isArray(msg.swipe_info)) msg.swipe_info = msg.swipes.map(() => ({}));
    while (msg.swipe_info.length < msg.swipes.length) msg.swipe_info.push({});
    // a dropped draft takes its info entry with it, or the export describes a swipe under anothers index
    if (msg.swipe_info.length > msg.swipes.length) msg.swipe_info.length = msg.swipes.length;
}

// a generation's record (thinking, usage, cut short, hand edited, its direction) is its alternate's: swipe_info[i].extra keeps it, the bag holds the active one's
const GENERATION_KEYS = ['reasoning', 'usage', 'interrupted', 'edited', 'guidance'];
const bagOf = (o) => (o?.extra && typeof o.extra === 'object' && !Array.isArray(o.extra) ? o.extra : null);
const activeAt = (msg) => (Array.isArray(msg.swipes) && msg.swipes.length
    ? Math.min(Math.max(Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0, 0), msg.swipes.length - 1) : null);

function clearGeneration(msg) {
    const bag = bagOf(msg);
    if (bag) for (const k of GENERATION_KEYS) delete bag[k];
}

// the bag's record, into alternate i's swipe_info entry (its other keys, an import's, kept)
function stashGeneration(msg, i) {
    if (i === null || !Array.isArray(msg.swipe_info)) return;
    while (msg.swipe_info.length <= i) msg.swipe_info.push({});
    const info = msg.swipe_info[i] && typeof msg.swipe_info[i] === 'object' ? msg.swipe_info[i] : (msg.swipe_info[i] = {});
    const bag = bagOf(msg) || {};
    const kept = { ...(bagOf(info) || {}) };
    for (const k of GENERATION_KEYS) {
        if (k in bag) kept[k] = bag[k];
        else delete kept[k];
    }
    if (Object.keys(kept).length) info.extra = kept;
    else delete info.extra;
}

// alternate i's record, into the bag, and none it never had
function loadGeneration(msg, i) {
    if (i === null) return;
    const from = bagOf(msg.swipe_info?.[i]) || {};
    clearGeneration(msg);
    const keys = GENERATION_KEYS.filter(k => k in from);
    if (!keys.length) return;
    if (!bagOf(msg)) msg.extra = {};
    for (const k of keys) msg.extra[k] = from[k];
}

function writeMessageRow(db, chatId, seq, msg, messageId) {
    db.transaction(() => {
        const before = db.prepare("SELECT json_extract(data, '$.send_date') AS at FROM chat_messages WHERE chat_id = ? AND seq = ?").get(chatId, seq);
        db.prepare('UPDATE chat_messages SET data = ? WHERE chat_id = ? AND seq = ?')
            .run(JSON.stringify(msg), chatId, seq);
        // an edit that moves send_date can move the chat's newest stamp; anything else
        // only touches the row (last_mes follows through the trigger)
        if (String(before?.at ?? '') !== String(msg?.send_date ?? '')) syncLastMesAt(db, chatId);
        else db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Date.now(), chatId);
        emitChange(db, { entity: 'message', op: 'updated', chatId, ids: [seq], messageIds: [messageId] });
    })();
}

// a verb's last step on one message: the greeting's finish (a changed text becomes the active alternate's), the write, the answer
function commitMessage(db, chatId, seq, messageId, msg, finish) {
    if (finish) {
        const shown = finish(msg);
        if (typeof shown === 'string' && shown !== msg.mes) {
            msg.mes = shown;
            syncActiveSwipe(msg, true);
        }
    }
    writeMessageRow(db, chatId, seq, msg, messageId);
    return { id: messageId, seq, message: msg, swipeId: Number.isInteger(msg.swipe_id) ? msg.swipe_id : null };
}

/** Where a message sits in its chat now, by its id: its seq, or null when the chat holds no such message. */
export function messageSeqOf(db, chatId, messageId) {
    return db.prepare('SELECT seq FROM chat_messages WHERE id = ? AND chat_id = ?').get(messageId, chatId)?.seq ?? null;
}

/** One stored message, parsed; null when the row is absent. */
export function readMessageRow(db, chatId, seq) {
    const row = db.prepare('SELECT data FROM chat_messages WHERE chat_id = ? AND seq = ?').get(chatId, seq);
    if (!row) return null;
    return JSON.parse(row.data);
}

/**
 * One stored message as the TEXT the row holds, with id and seq (the newest row when no seq): what a verify-then-write compares.
 * @returns {{id: number, seq: number, data: string}|null}
 */
export function messageRowAt(db, chatId, seq = null) {
    return (seq === null
        ? db.prepare('SELECT id, seq, data FROM chat_messages WHERE chat_id = ? ORDER BY seq DESC LIMIT 1').get(chatId)
        : db.prepare('SELECT id, seq, data FROM chat_messages WHERE chat_id = ? AND seq = ?').get(chatId, seq)) || null;
}

// one stored row parsed, with its id: what a verb on one message reads before it writes
function storedAt(db, chatId, seq) {
    const row = messageRowAt(db, chatId, seq);
    return row ? { id: row.id, msg: JSON.parse(row.data) } : null;
}

/** Every stored row of a chat in order, parsed with its id; or one keyset page after seq `after`, at most `limit`. */
export function listMessageRows(db, chatId, { after = null, limit = null } = {}) {
    const rows = Number.isInteger(limit) && limit > 0
        ? db.prepare('SELECT id, seq, data FROM chat_messages WHERE chat_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(chatId, Number.isInteger(after) ? after : -1, limit)
        : db.prepare('SELECT id, seq, data FROM chat_messages WHERE chat_id = ? ORDER BY seq').all(chatId);
    return rows.map(r => ({ id: r.id, seq: r.seq, msg: JSON.parse(r.data) }));
}

/** A chat's messages as an outline (id, speaker flags, name, text, alternates when several) without parsing the blob; pages like listMessageRows. */
export function listMessageOutline(db, chatId, { after = null, limit = null } = {}) {
    const cols = `id, seq, is_user, is_system, mes, json_extract(data, '$.name') AS name,
        CASE WHEN json_array_length(data, '$.swipes') > 1 THEN json_extract(data, '$.swipes') END AS swipes`;
    const rows = Number.isInteger(limit) && limit > 0
        ? db.prepare(`SELECT ${cols} FROM chat_messages WHERE chat_id = ? AND seq > ? ORDER BY seq LIMIT ?`).all(chatId, Number.isInteger(after) ? after : -1, limit)
        : db.prepare(`SELECT ${cols} FROM chat_messages WHERE chat_id = ? ORDER BY seq`).all(chatId);
    return rows.map(r => ({ id: r.id, seq: r.seq, is_user: !!r.is_user, is_system: !!r.is_system, name: r.name ?? null, mes: r.mes ?? '', swipes: r.swipes ? JSON.parse(r.swipes) : null }));
}

export function countMessages(db, chatId) {
    return db.prepare('SELECT COUNT(*) n FROM chat_messages WHERE chat_id = ?').get(chatId)?.n ?? 0;
}

/**
 * One keyset page of chats in id order, and those whose greeting may still hold a macro (a coarse net; the engine decides per row).
 * @returns {{ids: string[], last: string|null}}
 */
export function greetingCandidatePage(db, after, limit) {
    const rows = db.prepare(`SELECT c.id, m.chat_id AS hit FROM chats c
        LEFT JOIN chat_messages m ON m.chat_id = c.id AND m.seq = 0 AND m.is_user = 0 AND m.is_system = 0 AND (m.mes LIKE '%{{%' OR m.mes LIKE '%<%')
        WHERE c.id > ? ORDER BY c.id LIMIT ?`).all(after, limit);
    return { ids: rows.filter(r => r.hit !== null).map(r => r.id), last: rows.length === limit ? rows[rows.length - 1].id : null };
}

export function chatExists(db, id) {
    return !!db.prepare('SELECT 1 FROM chats WHERE id = ?').get(id);
}

/** The raw chats row (the prompt and lore scans read its columns directly); null when absent. */
export function getChatRow(db, id) {
    return db.prepare('SELECT * FROM chats WHERE id = ?').get(id) || null;
}

/** A chats row's chat_metadata column as an object: {} for none, and for a blob that is not one or does not parse. */
export function chatMetadataOf(raw) {
    try {
        const v = JSON.parse(raw || '{}');
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch { return {}; }
}

/** A character's chat names are unique; this is the check a create or an attach makes. */
export function chatNameTaken(db, charId, name) {
    return chatIdNamed(db, charId, name) !== null;
}

/** The id of a character's chat by its name, or null: the chat upsertChat replaces under that name. */
export function chatIdNamed(db, charId, name) {
    return db.prepare('SELECT id FROM chats WHERE char_id = ? AND name = ?').get(charId, name)?.id ?? null;
}

/**
 * Shallow-merge a patch onto ONE stored message (null deletes a key).
 * @param {Function} [opts.finish] (message) => its shown text, run just before the write; a changed text becomes the active alternate's
 * @param {number} [opts.messageId] the id of the message shown at that seq; another one there now refuses the write (409)
 * @param {{index: number, count: number, text: string}} [opts.shown] the active alternate the reader was shown; another stored refuses (409)
 * @returns {{id: number, seq: number, message: object, swipeId: number|null}|null} null when the chat or the row is gone
 */
export function patchChatMessage(db, chatId, seq, patch, opts = {}) {
    const shown = shownActiveOf(opts.shown);
    // one transaction: the finish commits what the first message's macros set, and a refused write takes it back
    return db.transaction(() => patchChatMessageNow(db, chatId, seq, patch, { ...opts, shown }))();
}

function patchChatMessageNow(db, chatId, seq, patch, { finish = null, messageId = null, shown = null } = {}) {
    const row = storedAt(db, chatId, seq);
    if (!row) return null;
    refuseUnlessShown(row, messageId);
    refuseUnlessActiveShown(row.msg, shown);
    const msg = row.msg;
    // the alternate active before the patch, by place and text (a message with none is its own first)
    const was = activeAt(msg) ?? 0;
    const wasText = activeAt(msg) !== null ? msg.swipes[activeAt(msg)] : msg.mes;
    const wasCount = Array.isArray(msg.swipes) ? msg.swipes.length : 0;
    let touchedMes = false;
    // the message's pictures are its links, set (null clears) when the patch names them and kept when it does not
    const pictures = patch.extra && typeof patch.extra === 'object' && 'attachments' in patch.extra
        ? messageAttachmentIds(db, chatId, patch.extra.attachments ?? []) : undefined;
    if (pictures) { const { attachments, ...extra } = patch.extra; patch = { ...patch, extra }; }
    for (const [k, v] of Object.entries(patch)) {
        if (RESERVED_MESSAGE_KEYS.has(k)) continue;
        // message fields arent dot-paths: one extra leaf goes through the merging extra object
        if (k.includes('.')) throw httpError(400, `message fields are not dot-paths (got '${k}'); to change one leaf of extra send { extra: { <leaf>: value } }, null to delete it`);
        if (k === 'extra') { mergeExtra(msg, v); continue; }
        if (k === 'mes') touchedMes = true;
        if (v === null) delete msg[k];
        else msg[k] = v;
    }
    // a supplied mes wins the active slot, else the selection wins mes; the reverse silently reverts an edit to a swiped message
    syncActiveSwipe(msg, touchedMes);
    // the generation record follows the selection when another alternate became active (a pick, or one added or dropped); an edit moves nothing
    const now = activeAt(msg);
    const moved = now !== null && (msg.swipes.length === wasCount ? now !== was : msg.swipes[now] !== wasText);
    if (moved) {
        if (now !== was && msg.swipes[was] === wasText) stashGeneration(msg, was);
        loadGeneration(msg, now);
    }
    if (pictures) setMessageAttachments(db, chatId, row.id, pictures);
    return commitMessage(db, chatId, seq, row.id, msg, finish);
}

/**
 * Push a new alternate and make it active (the swipe write, the combiner's), seeding swipes[0] from mes when the row has none.
 * @param {number} [opts.count] the alternates the reader was shown (a message with none shows one); another count refuses (409)
 * @param {number} [opts.messageId] the id of the message shown at that seq; another one there refuses (409)
 * @param {Function} [opts.finish] as patchChatMessage's
 */
export function appendSwipe(db, chatId, seq, text, { interrupted = null, reasoning = '', usage = null, guidance = '', count = null, messageId = null, finish = null } = {}) {
    return db.transaction(() => {
        const row = storedAt(db, chatId, seq);
        if (!row) return null;
        refuseUnlessShown(row, messageId);
        const msg = row.msg;
        if (count !== null && shownCount(msg) !== count) throw httpError(409, ALTERNATES_CHANGED);
        if (!Array.isArray(msg.swipes) || msg.swipes.length === 0) {
            msg.swipes = [msg.mes ?? ''];
            msg.swipe_info = [Array.isArray(msg.swipe_info) ? (msg.swipe_info[0] ?? {}) : {}];
        }
        if (!Array.isArray(msg.swipe_info)) msg.swipe_info = msg.swipes.map(() => ({}));
        while (msg.swipe_info.length < msg.swipes.length) msg.swipe_info.push({});
        // the alternate left keeps its generation's record; the new one starts with only its own
        stashGeneration(msg, activeAt(msg));
        msg.swipes.push(text);
        msg.swipe_info.push({ send_date: Date.now() });
        msg.swipe_id = msg.swipes.length - 1;
        msg.mes = text;
        clearGeneration(msg);
        markInterrupted(msg, interrupted);
        setReasoning(msg, reasoning);
        setUsage(msg, usage);
        setGuidance(msg, guidance);
        stashGeneration(msg, msg.swipe_id);
        return commitMessage(db, chatId, seq, row.id, msg, finish);
    })();
}

/**
 * Drop one alternate named as shown (index, text, count); the selection keeps its alternate, the next replacing a dropped active one.
 * @param {object} opts
 * @param {number} opts.index the alternate dropped
 * @param {string} opts.text the text it held as shown; another refuses (409)
 * @param {number} opts.count the alternates the reader was shown, 2 or more; another count refuses (409)
 * @param {number} [opts.messageId] the id of the message shown at that seq; another one there refuses (409)
 * @param {Function} [opts.finish] as patchChatMessage's
 * @returns {{id: number, seq: number, message: object, swipeId: number}|null} null when the chat or the row is gone
 */
export function removeSwipe(db, chatId, seq, { index, text, count, messageId = null, finish = null } = {}) {
    if (!Number.isInteger(count) || count < 2) throw httpError(400, 'count must be 2 or more: a message keeps one alternate, which goes only with the message');
    if (!Number.isInteger(index) || index < 0 || index >= count) throw httpError(400, 'index must name one of the alternates counted (0 to count - 1)');
    if (typeof text !== 'string') throw httpError(400, 'text must be the alternate\'s text as shown');
    return db.transaction(() => {
        const row = storedAt(db, chatId, seq);
        if (!row) return null;
        refuseUnlessShown(row, messageId);
        const msg = row.msg;
        if (shownCount(msg) !== count || msg.swipes[index] !== text) throw httpError(409, ALTERNATES_CHANGED);
        const active = activeAt(msg);
        msg.swipes = msg.swipes.filter((_, i) => i !== index);
        if (Array.isArray(msg.swipe_info)) msg.swipe_info = msg.swipe_info.filter((_, i) => i !== index);
        msg.swipe_id = index < active ? active - 1 : Math.min(active, msg.swipes.length - 1);
        syncActiveSwipe(msg, false);
        // the dropped alternate's record leaves with it, and the one shown now wears its own
        if (index === active) loadGeneration(msg, msg.swipe_id);
        return commitMessage(db, chatId, seq, row.id, msg, finish);
    })();
}

/** Overwrite the active alternate's text in place (the reroll write); nothing is written until there is text to write. */
export function replaceMessageText(db, chatId, seq, text, { interrupted = null, reasoning = '', usage = null, guidance = '' } = {}) {
    const row = storedAt(db, chatId, seq);
    if (!row) return null;
    const msg = row.msg;
    msg.mes = text;
    msg.send_date = Date.now();
    syncActiveSwipe(msg, true);
    // the new reply's record replaces the old one's, thinking and usage it did not have included
    clearGeneration(msg);
    markInterrupted(msg, interrupted);
    setReasoning(msg, reasoning);
    setUsage(msg, usage);
    setGuidance(msg, guidance);
    stashGeneration(msg, activeAt(msg));
    writeMessageRow(db, chatId, seq, msg, row.id);
    return { id: row.id, seq, message: msg, swipeId: Number.isInteger(msg.swipe_id) ? msg.swipe_id : null };
}

/** Append text to a message in place (the continue write); a null interrupted clears the marker, retiring the promoted Continue. */
export function appendToMessage(db, chatId, seq, text, { interrupted = null, reasoning = '', usage = null, base = null } = {}) {
    const row = storedAt(db, chatId, seq);
    if (!row) return null;
    const msg = row.msg;
    // base: the text so far as the caller stores it (a continue under text scripts), else as it stands
    msg.mes = (typeof base === 'string' ? base : typeof msg.mes === 'string' ? msg.mes : '') + text;
    syncActiveSwipe(msg, true);
    markInterrupted(msg, interrupted);
    setReasoning(msg, reasoning);
    setUsage(msg, usage);
    stashGeneration(msg, activeAt(msg));
    writeMessageRow(db, chatId, seq, msg, row.id);
    return { id: row.id, seq, message: msg, swipeId: Number.isInteger(msg.swipe_id) ? msg.swipe_id : null };
}

function markInterrupted(msg, reason) {
    if (reason) {
        if (!msg.extra || typeof msg.extra !== 'object' || Array.isArray(msg.extra)) msg.extra = {};
        msg.extra.interrupted = reason;
    } else if (msg.extra && typeof msg.extra === 'object') {
        delete msg.extra.interrupted;
    }
}

// reasoning is stored, not just streamed, so a reload still shows how the turn got there; empty writes no key
function setReasoning(msg, reasoning) {
    if (typeof reasoning !== 'string' || !reasoning.trim()) return;
    if (!msg.extra || typeof msg.extra !== 'object' || Array.isArray(msg.extra)) msg.extra = {};
    msg.extra.reasoning = reasoning;
}

// the reader's direction a reply was written to, so a swipe or a reroll of it can follow the same one
function setGuidance(msg, guidance) {
    if (typeof guidance !== 'string' || !guidance.trim()) return;
    if (!msg.extra || typeof msg.extra !== 'object' || Array.isArray(msg.extra)) msg.extra = {};
    msg.extra.guidance = guidance.trim();
}

// the usage upstream reported for THIS reply, so the meta chip shows a real figure, not chars over four
function setUsage(msg, usage) {
    if (!usage || typeof usage !== 'object') return;
    if (!msg.extra || typeof msg.extra !== 'object' || Array.isArray(msg.extra)) msg.extra = {};
    msg.extra.usage = usage;
}

/**
 * Delete one message and close the gap so seqs stay 0..n-1.
 * @param {number} [opts.messageId] the id of the message the caller was shown at that seq: another
 *   one there now refuses the delete (409), nothing deleted
 * @returns {number[]|null} the NEW seq list, so a client can re-key without a refetch
 */
export function deleteChatMessage(db, chatId, seq, { messageId = null } = {}) {
    if (!db.prepare('SELECT 1 FROM chat_messages WHERE chat_id = ? AND seq = ?').get(chatId, seq)) return null;
    db.transaction(() => {
        const gone = db.prepare('SELECT id FROM chat_messages WHERE chat_id = ? AND seq = ?').get(chatId, seq);
        refuseUnlessShown(gone, messageId);
        db.prepare('DELETE FROM chat_messages WHERE chat_id = ? AND seq = ?').run(chatId, seq);
        // shifted one row at a time, ascending: a set-based UPDATE has no row order and can collide with UNIQUE (chat_id, seq)
        const trailing = db.prepare('SELECT seq FROM chat_messages WHERE chat_id = ? AND seq > ? ORDER BY seq')
            .all(chatId, seq);
        const shift = db.prepare('UPDATE chat_messages SET seq = ? WHERE chat_id = ? AND seq = ?');
        for (const t of trailing) shift.run(t.seq - 1, chatId, t.seq);
        syncLastMesAt(db, chatId);
        emitChange(db, { entity: 'message', op: 'deleted', chatId, ids: [seq], messageIds: gone ? [gone.id] : [] });
    })();
    return db.prepare('SELECT seq FROM chat_messages WHERE chat_id = ? ORDER BY seq').all(chatId).map(r => r.seq);
}

/**
 * Rename and/or merge chat_metadata keys (null deletes); extensions merges by extension id. Refusals carry a statusCode (404, 400, 409).
 * @returns {{ ok: true }}
 */
export function patchChat(db, id, { name, chatMetadata, personaId, profileId, presetId, draft } = {}) {
    const row = db.prepare('SELECT char_id, name, chat_metadata FROM chats WHERE id = ?').get(id);
    if (!row) throw httpError(404, 'chat not found');

    // undefined leaves the override, null clears it. validations run before any write, and the writes share one transaction
    for (const [field, value, table, missing] of [
        ['personaId', personaId, 'personas', 'persona not found'],
        ['profileId', profileId, 'llm_profiles', 'connection not found'],
        ['presetId', presetId, 'presets', 'preset not found'],
    ]) {
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string') throw httpError(400, `${field} must be a string or null`);
        if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(value)) throw httpError(400, missing);
    }
    if (draft !== undefined && draft !== null && typeof draft !== 'string') {
        throw httpError(400, 'draft must be a string or null');
    }
    // the chat's own card texts are read as text (buildMacroEnv), so nothing else is stored
    for (const key of CHAT_CARD_OVERRIDES) {
        const v = chatMetadata && typeof chatMetadata === 'object' ? chatMetadata[key] : undefined;
        if (v !== undefined && v !== null && typeof v !== 'string') {
            throw httpError(400, `chatMetadata.${key} must be text, or null to use the card's`);
        }
    }
    const newName = typeof name === 'string' && name.trim() && name !== row.name ? name.trim() : null;
    if (newName) {
        const clash = db.prepare('SELECT 1 FROM chats WHERE char_id = ? AND name = ? AND id != ?')
            .get(row.char_id, newName, id);
        if (clash) throw httpError(409, 'a chat with that name already exists for this character');
    }

    db.transaction(() => {
        if (personaId !== undefined) {
            db.prepare('UPDATE chats SET persona_id = ?, updated_at = ? WHERE id = ?')
                .run(personaId, Date.now(), id);
        }
        // op-state, not an edit: updated_at stays put, so a keystroke can never reorder the
        // list or read as a change to the chat
        if (draft !== undefined) {
            db.prepare('UPDATE chats SET draft = ? WHERE id = ?').run(typeof draft === 'string' && draft ? draft : null, id);
        }
        // the same: which connection or preset answers is op-state, so a switch never reorders the list
        if (profileId !== undefined) db.prepare('UPDATE chats SET profile_id = ? WHERE id = ?').run(profileId, id);
        if (presetId !== undefined) db.prepare('UPDATE chats SET preset_id = ? WHERE id = ?').run(presetId, id);
        if (newName) {
            db.prepare('UPDATE chats SET name = ?, updated_at = ? WHERE id = ?').run(newName, Date.now(), id);
        }
        if (chatMetadata && typeof chatMetadata === 'object') {
            // world_info diverts to chat_worlds' head slot (null or '' unlinks it) and never lands in the blob
            if ('world_info' in chatMetadata) {
                setHeadWorldFor(db, 'chat', id, typeof chatMetadata.world_info === 'string' ? chatMetadata.world_info : '');
            }
            const merged = JSON.parse(row.chat_metadata || '{}');
            delete merged.world_info;
            for (const [k, v] of Object.entries(chatMetadata)) {
                if (k === 'world_info') continue;
                if (k === 'extensions' && v && typeof v === 'object' && !Array.isArray(v)) {
                    const own = merged.extensions && typeof merged.extensions === 'object' ? { ...merged.extensions } : {};
                    for (const [extId, value] of Object.entries(v)) {
                        if (value === null) delete own[extId];
                        else own[extId] = value;
                    }
                    if (Object.keys(own).length) merged.extensions = own;
                    else delete merged.extensions;
                    continue;
                }
                if (v === null) delete merged[k];
                else merged[k] = v;
            }
            db.prepare('UPDATE chats SET chat_metadata = ?, updated_at = ? WHERE id = ?')
                .run(JSON.stringify(merged), Date.now(), id);
        }
        const fields = [['personaId', personaId], ['profileId', profileId], ['presetId', presetId], ['draft', draft], ['name', newName || undefined], ['chatMetadata', chatMetadata]].filter(([, v]) => v !== undefined).map(([k]) => k);
        if (fields.length) emitChange(db, { entity: 'chat', op: 'updated', ids: [id], charId: row.char_id, fields });
    })();
    return { ok: true };
}

/** Delete a chat, its rows cascading; its gallery's files go once the rows are gone for good. */
export function deleteChat(db, paths, id) {
    const out = db.transaction(() => {
        const charId = db.prepare('SELECT char_id FROM chats WHERE id = ?').get(id)?.char_id ?? null;
        const held = attachmentsHeldBy(db, { chatIds: [id] });
        const gone = db.prepare('DELETE FROM chats WHERE id = ?').run(id).changes > 0;
        if (gone) emitChange(db, { entity: 'chat', op: 'deleted', ids: [id], charId });
        return { gone, held };
    })();
    if (out.gone) removeAttachmentFiles(paths, out.held);
    return out.gone;
}

// bm25 runs once per ranked message, so a common word ranks this many of the newest, not every message
export const CHAT_SEARCH_RANKED = 10000;
// hits a search page holds unless asked, and the most it holds
export const SEARCH_PAGE_DEFAULT = 50;
export const SEARCH_PAGE_MAX = 500;

/** Full-text search over chat messages, best first among the newest CHAT_SEARCH_RANKED; q is typed text in place of match. */
export function searchChatMessages(db, { match, q, charId, limit = SEARCH_PAGE_DEFAULT, offset = 0, count = true } = {}) {
    if (q !== undefined) {
        match = ftsWordsQuery(q);
        // a text of no words matches nothing, rather than every message
        if (!match) return { items: [], total: count === false ? null : 0, limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, SEARCH_PAGE_MAX) : SEARCH_PAGE_DEFAULT, offset: Number.isInteger(offset) && offset > 0 ? offset : 0, capped: false };
    }
    assertMatchQuery(db, match, 'chat_messages_fts');
    const args = charId ? { match, charId } : { match };
    // the messages the match holds, in the character's chats alone when one is named
    const matched = (cols) => (charId
        ? `SELECT ${cols} FROM chat_messages_fts fts JOIN chat_messages cm ON cm.rowid = fts.rowid JOIN chats c ON c.id = cm.chat_id
            WHERE fts.chat_messages_fts MATCH @match AND c.char_id = @charId`
        : `SELECT ${cols} FROM chat_messages_fts fts WHERE fts.chat_messages_fts MATCH @match`);
    const total = count === false ? null : db.prepare(matched('COUNT(*) n')).get(args).n;
    const capped = total !== null ? total > CHAT_SEARCH_RANKED
        : db.prepare(`SELECT COUNT(*) n FROM (${matched('1')} LIMIT @more)`).get({ ...args, more: CHAT_SEARCH_RANKED + 1 }).n > CHAT_SEARCH_RANKED;
    const lim = Number.isInteger(limit) && limit > 0 ? Math.min(limit, SEARCH_PAGE_MAX) : SEARCH_PAGE_DEFAULT;
    const off = Number.isInteger(offset) && offset > 0 ? offset : 0;
    // the rank is read for the newest hits alone and the snippet for the page's
    const items = db.prepare(`
        WITH hit AS (${matched('fts.rowid AS rid, fts.rank AS rk')} ORDER BY fts.rowid DESC LIMIT @ranked),
             page AS (SELECT rid, rk FROM hit ORDER BY rk, rid LIMIT @lim OFFSET @off)
        SELECT c.id AS chat_id, c.char_id, c.name AS chat_name, cm.id AS message_id, cm.seq, cm.is_user,
               ch.name AS char_name,
               (SELECT snippet(chat_messages_fts, 0, '<mark>', '</mark>', '…', 16) FROM chat_messages_fts
                WHERE chat_messages_fts MATCH @match AND rowid = page.rid) AS snip
        FROM page
        JOIN chat_messages cm ON cm.rowid = page.rid
        JOIN chats c ON c.id = cm.chat_id
        LEFT JOIN characters ch ON ch.id = c.char_id
        ORDER BY page.rk, page.rid
    `).all({ ...args, ranked: CHAT_SEARCH_RANKED, lim, off }).map(r => ({
        chatId: r.chat_id,
        charId: r.char_id,
        chatName: r.chat_name,
        charName: r.char_name,
        messageId: r.message_id,
        seq: r.seq,
        isUser: !!r.is_user,
        snippet: r.snip,
    }));
    return { items, total, limit: lim, offset: off, capped };
}

/** The ST JSONL for interchange, the stored rows verbatim; create_date goes out as ST's humanized stamp so a reimport round-trips. */
export function composeChatJsonl(db, id) {
    const row = db.prepare(`${LIST_SELECT} WHERE ch.id = ?`).get(id);
    if (!row) return null;
    const chat = mapListRow(row);
    const header = {
        user_name: chat.userName || 'User',
        character_name: chat.characterName || '',
        create_date: formatStDate(chat.createDate ? new Date(chat.createDate) : new Date()),
        chat_metadata: chat.chatMetadata || {},
    };
    const messages = listMessageRows(db, id).map(r => r.msg);
    const entries = runHook('chat.export', [header, ...messages], { db, chatId: id, charId: chat.charId });
    return entries.map(l => JSON.stringify(l)).join('\n') + '\n';
}

/**
 * Read an ST chat JSONL: blanks skipped, torn or non-object lines dropped and counted, line 0 the header when it has chat_metadata and no mes.
 * @param {string} text
 * @returns {{ header: object, messages: object[], dropped: number } | null}
 */
export function parseStChatJsonl(text) {
    const lines = [];
    let dropped = 0;
    for (const line of String(text).split('\n')) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { dropped++; continue; }
        // null, a number, a string or an array parses fine but is no message row
        if (row && typeof row === 'object' && !Array.isArray(row)) lines.push(row);
        else dropped++;
    }
    if (!lines.length) return null;
    const hasHeader = lines[0].chat_metadata !== undefined && lines[0].mes === undefined;
    return { header: hasHeader ? lines[0] : {}, messages: hasHeader ? lines.slice(1) : lines, dropped };
}
