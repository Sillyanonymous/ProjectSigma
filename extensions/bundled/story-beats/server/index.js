// Story Beats, the server half: a chat's beats in its slot, their direction in its prompt, the director and the planner.
import {
    settingNumber, STRATEGIES, WEIGHTS, BEAT_LIMITS, within, TITLE_MAX, DIRECTIVE_MAX, BEATS_MAX, ADD_MAX, NOTES_MAX, TURNS_MAX, TURN_MAX, LOG_MAX,
} from '../client/limits.js';
import { normalizeSlot, newBeatId, transition, nextReady, directionText, waitsOn, makesCycle, countsOf, titleOf, setStatus, markOf, clip } from './beats.js';
import { directorPrompt, lineFor, parseDirector, applyPass } from './director.js';
import { listPrompt, parseDrafts, discussPrompt, parseDiscuss, storyFor, saidOf } from './planner.js';
import { wasCut, thoughtIn, cutWords } from './answer.js';

const TABLE = 'x_story_beats_log';
const ERROR_MAX = 300;
const LOG_PAGE = 200;
// the messages read back from a chat's end for each one the director wants, so hidden ones leave enough
const TAIL_SPAN = 4;
const FIELDS = ['title', 'directive', 'weight', 'dependsOn', 'fadeAfter', 'maxMessages'];

// append-only: an entry that ran is never edited, a change is a new entry
export const migrations = [
    `CREATE TABLE x_story_beats_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        entry TEXT NOT NULL);
     CREATE INDEX x_story_beats_log_chat ON x_story_beats_log(chat_id, id);`,
];

export function register(router, ctx) {
    const ID = ctx.manifest.id;
    const num = (db, key) => settingNumber(key, ctx.setting(db, key), ctx.manifest.settings[key]);
    const strategyOf = (db) => (STRATEGIES.includes(ctx.setting(db, 'strategy')) ? ctx.setting(db, 'strategy') : 'adaptive');
    const roleOf = (db) => (ctx.setting(db, 'role') === 'user' ? 'user' : 'system');
    const directorOn = (db) => ctx.setting(db, 'director') === true;
    const confirmOn = (db) => ctx.setting(db, 'confirm') === true;
    const reasoningOn = (db) => ctx.setting(db, 'reasoning') === true;
    // a model call's output: the answer's room, and a reasoning model's room to think on top of it
    const tokenBudget = (db) => num(db, 'maxTokens') + (reasoningOn(db) ? num(db, 'reasoningTokens') : 0);
    // an answer cut off at its ceiling, in words naming the setting that gives it more room
    const cutOf = (db, out, tokens) => cutWords({ tokens, reasoning: reasoningOn(db), thought: thoughtIn(out) });

    const slotOf = (db, chatId) => normalizeSlot(ctx.chatSlot.get(db, chatId));
    const hasWork = (beats) => beats.some(b => b.status === 'active' || b.status === 'pending');
    const isReply = (msg) => !!msg && !msg.is_user && ctx.prompt.visible(msg);
    // the newest message of a chat, where a pass or a beat starts counting from
    const newestOf = (db, chatId) => markOf(ctx.stores.chats.messageRowAt(db, chatId));
    // a counted-from message's place now, found by its id; one deleted since counts from where it stood
    const seqOf = (db, chatId, mark, newest) => {
        if (!mark) return -1;
        return ctx.stores.chats.messageSeqOf(db, chatId, mark.id) ?? Math.min(mark.seq, newest?.seq ?? -1);
    };

    // ======================================== the log, newest LOG_MAX a chat
    const addLog = (db, chatId, entry) => {
        db.prepare(`INSERT INTO ${TABLE} (chat_id, at, kind, entry) VALUES (?, ?, ?, ?)`).run(chatId, Date.now(), entry.kind, JSON.stringify(entry));
        db.prepare(`DELETE FROM ${TABLE} WHERE chat_id = ? AND id <= (SELECT id FROM ${TABLE} WHERE chat_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(chatId, chatId, LOG_MAX);
    };
    const readLog = (db, chatId, limit) => db.prepare(`SELECT id, at, entry FROM ${TABLE} WHERE chat_id = ? ORDER BY id DESC LIMIT ?`).all(chatId, limit)
        .map(r => { try { return { id: r.id, at: r.at, ...JSON.parse(r.entry) }; } catch { return null; } }).filter(Boolean);
    const report = (db, chatId, fields) => ctx.report(db, { entity: 'chat', op: 'updated', ids: [chatId], fields: fields.map(f => `${ID}.${f}`) });

    // one write of a chat's beats: read as they stand, changed, stored with what it logs, in one transaction
    const commit = (db, chatId, change) => db.transaction(() => {
        if (!ctx.stores.chats.chatExists(db, chatId)) return null;
        const slot = slotOf(db, chatId);
        const out = change(slot) || {};
        if (out.error || !out.changed) return out;
        ctx.chatSlot.set(db, chatId, slot.beats.length ? { beats: slot.beats, director: slot.director } : null);
        const entries = out.entries || [];
        for (const e of entries) addLog(db, chatId, e);
        report(db, chatId, entries.length ? ['beats', 'log'] : ['beats']);
        return out;
    })();
    const beatEntry = (b, action, from, source, reason = '') => ({ kind: 'beat', beat: { id: b.id, title: titleOf(b) }, action, from, source, reason });

    // ======================================== the director, one pass at a time a chat
    const keyOf = (chatId) => `direct:${chatId}`;
    const passesFor = (db, chatId) => ctx.jobs.list(db).filter(j => j.key === keyOf(chatId));
    const onTheWay = (jobs) => jobs.filter(j => j.status === 'queued' || j.status === 'running');

    // a failed pass is logged, and its job ends failed in the same words
    const failure = (db, chatId, strategy, error, said = '') => {
        const words = clip(error, ERROR_MAX);
        db.transaction(() => {
            if (!ctx.stores.chats.chatExists(db, chatId)) return;
            addLog(db, chatId, { kind: 'error', strategy, error: words, ...(said ? { said } : {}) });
            report(db, chatId, ['log']);
        })();
        throw new Error(words);
    };

    // the newest visible messages, read back from the chat's end rather than through all of it
    const tailOf = (db, chatId, count, newest) => {
        if (!newest) return [];
        const span = count * TAIL_SPAN;
        return ctx.stores.chats.listMessageRows(db, chatId, { after: Math.max(-1, newest.seq - span), limit: span + 1 })
            .filter(r => ctx.prompt.visible(r.msg)).slice(-count);
    };

    // one pass: the model asked (but under strict), its answer judged against the beats as they stand when it lands
    const direct = async (db, chatId, { clock = false, signal = null } = {}) => {
        const strategy = strategyOf(db);
        const seen = slotOf(db, chatId);
        if (!hasWork(seen.beats)) return;
        const mark = newestOf(db, chatId);
        let answer = null;
        if (strategy !== 'strict') {
            const names = ctx.prompt.names(db, chatId);
            if (!names) return;
            const lines = tailOf(db, chatId, num(db, 'messages'), mark).map(r => lineFor(r.msg, names));
            const tokens = tokenBudget(db);
            let out;
            try {
                // the connection picked in the settings, while the account still has it; else the one this chat uses
                out = await ctx.llm.chat(db, { messages: directorPrompt({ strategy, beats: seen.beats, lines, fence: ctx.prompt.fence }), profileSetting: 'profileId', chatId, params: { maxTokens: tokens } }, { signal });
            } catch (e) {
                if (signal?.aborted) return;
                failure(db, chatId, strategy, e?.message || String(e));
            }
            // an object the cut left whole applies; half of one is a judgement the model never finished, so it fails
            answer = parseDirector(out?.content);
            if (!answer) failure(db, chatId, strategy, wasCut(out) ? cutOf(db, out, tokens) : 'the director answered no JSON object', saidOf(out?.content));
        }
        if (signal?.aborted) return;
        commit(db, chatId, (slot) => {
            const { changed, entry } = applyPass(slot, { strategy, answer, confirm: confirmOn(db), clock, mark });
            return { changed, entries: entry ? [{ ...entry, forced: !clock }] : [] };
        });
    };
    const queuePass = (db, chatId, { clock }) => {
        const name = ctx.stores.chats.getChatRow(db, chatId)?.name || 'a chat';
        return ctx.jobs.run(db, { key: keyOf(chatId), label: `Directing the story in ${name}`, run: ({ db: jobDb, signal }) => direct(jobDb, chatId, { clock, signal }) });
    };

    // a beat active past its counters fades to soft guidance, or is skipped
    const applyLimits = (db, chatId, rows, newest) => commit(db, chatId, (slot) => {
        const entries = [];
        for (const b of slot.beats.filter(x => x.status === 'active')) {
            const since = seqOf(db, chatId, b.activatedAt, newest);
            const count = rows.filter(r => r.seq > since && ctx.prompt.visible(r.msg)).length;
            if (b.maxMessages && count >= b.maxMessages) {
                setStatus(b, 'skipped');
                entries.push(beatEntry(b, 'skipped', 'active', 'limit', `active for ${count} messages`));
            } else if (b.fadeAfter && !b.faded && count >= b.fadeAfter) {
                b.faded = true;
                entries.push(beatEntry(b, 'faded', 'active', 'limit', `active for ${count} messages`));
            }
        }
        return { changed: entries.length > 0, entries };
    });

    // a chat's new messages move its beats' counters, and every few replies the director reads the chat
    const heard = (db, chatId, seqs) => {
        const slot = slotOf(db, chatId);
        if (!hasWork(slot.beats)) return;
        const newest = newestOf(db, chatId);
        const limited = slot.beats.filter(b => b.status === 'active' && (b.maxMessages || (b.fadeAfter && !b.faded)));
        const passFrom = directorOn(db) ? seqOf(db, chatId, slot.director.mark, newest) : null;
        const from = Math.min(...limited.map(b => seqOf(db, chatId, b.activatedAt, newest)), passFrom ?? Infinity);
        if (!Number.isFinite(from)) return;
        const rows = ctx.stores.chats.listMessageRows(db, chatId, { after: from });
        if (limited.length) applyLimits(db, chatId, rows, newest);
        if (passFrom === null) return;
        // a pass each time the replies since the last change cross a multiple of the cadence, so a quiet pass writes nothing
        const replies = rows.filter(r => r.seq > passFrom && isReply(r.msg));
        const fresh = replies.filter(r => seqs.includes(r.seq)).length;
        const every = num(db, 'every');
        if (!fresh || Math.floor(replies.length / every) === Math.floor((replies.length - fresh) / every)) return;
        if (onTheWay(passesFor(db, chatId)).length) return;
        queuePass(db, chatId, { clock: true });
    };
    ctx.events.on((records, { db }) => {
        const created = new Map();
        for (const r of records) {
            if (r.entity !== 'message' || r.op !== 'created' || !r.chatId) continue;
            created.set(r.chatId, [...(created.get(r.chatId) || []), ...(r.ids || []).filter(Number.isInteger)]);
        }
        for (const [chatId, seqs] of created) heard(db, chatId, seqs);
    });

    // ======================================== the direction in the prompt
    // placed in the chat where the settings say; nothing while no beat is active
    ctx.prompt.addBlock({
        id: 'direction',
        position: 'at_depth',
        role: 'system',
        text: ({ db, chatId }) => {
            if (!chatId) return '';
            const text = directionText(slotOf(db, chatId).beats, num(db, 'budget'));
            return text ? { text, position: 'at_depth', depth: num(db, 'depth'), role: roleOf(db) } : '';
        },
    });

    // ======================================== the window's routes
    const viewOf = (db, chatId) => {
        const slot = slotOf(db, chatId);
        const passes = passesFor(db, chatId);
        const busy = onTheWay(passes);
        const ended = passes.filter(j => j.endedAt).sort((a, b) => b.endedAt - a.endedAt)[0];
        return {
            chatId,
            beats: slot.beats.map(b => ({ ...b, waitsOn: waitsOn(b, slot.beats) })),
            counts: countsOf(slot.beats),
            director: {
                on: directorOn(db), strategy: strategyOf(db), every: num(db, 'every'),
                tension: slot.director.tension, summary: slot.director.summary, at: slot.director.at,
                working: busy.some(j => j.status === 'running') ? 'running' : busy.length ? 'queued' : null,
                // the last pass failed while no pass ran since
                failed: !busy.length && ended?.status === 'failed' ? ended.error : null,
            },
            direction: directionText(slot.beats, num(db, 'budget')),
        };
    };
    const respond = (res, out, db, chatId, extra = {}) => {
        if (out === null) return res.status(404).json({ error: 'the chat was deleted' });
        if (out.error) return res.status(out.status || 400).json({ error: out.error });
        return res.json({ ...extra, ...viewOf(db, chatId) });
    };

    // the fields a request names, each held to its rule against the chat's beats; id is the beat edited, null for a new one
    const fieldsOf = (body, beats, id) => {
        const b = body && typeof body === 'object' ? body : {};
        const fields = {};
        if (b.title !== undefined) {
            if (typeof b.title !== 'string' || b.title.trim().length > TITLE_MAX) return { error: `title is text of at most ${TITLE_MAX} characters` };
            fields.title = b.title.trim();
        }
        if (b.directive !== undefined) {
            if (typeof b.directive !== 'string' || b.directive.trim().length > DIRECTIVE_MAX) return { error: `directive is text of at most ${DIRECTIVE_MAX} characters` };
            fields.directive = b.directive.trim();
        }
        if (b.weight !== undefined) {
            if (!WEIGHTS.includes(b.weight)) return { error: 'weight is soft, firm or hard' };
            fields.weight = b.weight;
        }
        for (const key of ['fadeAfter', 'maxMessages']) {
            if (b[key] === undefined) continue;
            if (!Number.isInteger(b[key]) || within(b[key], BEAT_LIMITS[key]) !== b[key]) return { error: `${key} is a whole number from ${BEAT_LIMITS[key].join(' to ')}` };
            fields[key] = b[key];
        }
        if (b.dependsOn !== undefined) {
            const others = new Set(beats.filter(x => x.id !== id).map(x => x.id));
            if (!Array.isArray(b.dependsOn) || b.dependsOn.some(d => typeof d !== 'string' || !others.has(d))) return { error: 'dependsOn lists other beats of this chat' };
            const deps = [...new Set(b.dependsOn)];
            if (id && makesCycle(beats, id, deps)) return { error: 'that would have the beats wait on each other' };
            fields.dependsOn = deps;
        }
        return { fields };
    };

    router.get('/chats/:chatId', ctx.requireChat, (req, res) => res.json(viewOf(req.db, req.params.chatId)));

    // new beats, pending, after the chat's others
    router.post('/chats/:chatId/beats', ctx.requireChat, (req, res) => {
        const { chatId } = req.params;
        const list = req.body?.beats;
        if (!Array.isArray(list) || !list.length || list.length > ADD_MAX) return res.status(400).json({ error: `beats is a list of 1 to ${ADD_MAX} beats` });
        const out = commit(req.db, chatId, (slot) => {
            if (slot.beats.length + list.length > BEATS_MAX) return { error: `a chat holds at most ${BEATS_MAX} beats`, status: 409 };
            const made = [];
            for (const raw of list) {
                const f = fieldsOf(raw, slot.beats, null);
                if (f.error) return f;
                made.push({ id: newBeatId(), title: '', directive: '', weight: 'soft', status: 'pending', dependsOn: [], fadeAfter: 0, maxMessages: 0, activatedAt: null, faded: false, suggestion: null, ...f.fields });
            }
            // the director counts from where the chat stood when its first beat was planned
            if (!slot.beats.length && !slot.director.mark) slot.director.mark = newestOf(req.db, chatId);
            slot.beats.push(...made);
            return { changed: true, added: made.map(b => b.id) };
        });
        return respond(res, out, req.db, chatId, out?.added ? { added: out.added } : {});
    });

    router.put('/chats/:chatId/beats/:beatId', ctx.requireChat, (req, res) => {
        const { chatId, beatId } = req.params;
        if (!FIELDS.some(k => req.body?.[k] !== undefined)) return res.status(400).json({ error: `name a field to change: ${FIELDS.join(', ')}` });
        const out = commit(req.db, chatId, (slot) => {
            const beat = slot.beats.find(b => b.id === beatId);
            if (!beat) return { error: 'no such beat', status: 404 };
            const f = fieldsOf(req.body, slot.beats, beatId);
            if (f.error) return f;
            const changed = Object.entries(f.fields).some(([k, v]) => JSON.stringify(beat[k]) !== JSON.stringify(v));
            Object.assign(beat, f.fields);
            return { changed };
        });
        return respond(res, out, req.db, chatId);
    });

    // gone, and no beat waits on it any more
    router.delete('/chats/:chatId/beats/:beatId', ctx.requireChat, (req, res) => {
        const { chatId, beatId } = req.params;
        const out = commit(req.db, chatId, (slot) => {
            if (!slot.beats.some(b => b.id === beatId)) return { error: 'no such beat', status: 404 };
            slot.beats = slot.beats.filter(b => b.id !== beatId);
            for (const b of slot.beats) b.dependsOn = b.dependsOn.filter(d => d !== beatId);
            return { changed: true };
        });
        return respond(res, out, req.db, chatId);
    });

    // the authoring order, every beat of the chat named once
    router.put('/chats/:chatId/order', ctx.requireChat, (req, res) => {
        const { chatId } = req.params;
        const ids = req.body?.ids;
        if (!Array.isArray(ids) || ids.some(x => typeof x !== 'string')) return res.status(400).json({ error: 'ids lists the chat\'s beats in their new order' });
        const out = commit(req.db, chatId, (slot) => {
            const now = slot.beats.map(b => b.id);
            if (ids.length !== now.length || new Set(ids).size !== ids.length || ids.some(x => !now.includes(x))) return { error: 'the beats changed since they were read; read them again', status: 409 };
            const changed = ids.some((x, i) => x !== now[i]);
            slot.beats = ids.map(x => slot.beats.find(b => b.id === x));
            return { changed };
        });
        return respond(res, out, req.db, chatId);
    });

    // the reader's change of a status, held to the lifecycle; force starts a beat whatever it waits on
    router.put('/chats/:chatId/beats/:beatId/status', ctx.requireChat, (req, res) => {
        const { chatId, beatId } = req.params;
        const { status, force = false } = req.body || {};
        if (typeof force !== 'boolean') return res.status(400).json({ error: 'force is true or false' });
        const source = req.body?.source === 'command' ? 'command' : 'reader';
        const out = commit(req.db, chatId, (slot) => {
            const beat = slot.beats.find(b => b.id === beatId);
            if (!beat) return { error: 'no such beat', status: 404 };
            const done = transition(slot.beats, beat, status, { force, mark: newestOf(req.db, chatId) });
            if (done.error) return done;
            return { changed: true, entries: [beatEntry(beat, status, done.from, source, force ? 'forced' : '')], beat: { id: beat.id, title: titleOf(beat) } };
        });
        return respond(res, out, req.db, chatId, out?.beat ? { beat: out.beat } : {});
    });

    // the first pending beat whose dependencies are satisfied, active now
    router.post('/chats/:chatId/next', ctx.requireChat, (req, res) => {
        const { chatId } = req.params;
        const source = req.body?.source === 'command' ? 'command' : 'reader';
        const out = commit(req.db, chatId, (slot) => {
            const beat = nextReady(slot.beats);
            if (!beat) return { error: slot.beats.some(b => b.status === 'pending') ? 'every pending beat waits on another' : 'no beat is pending', status: 409 };
            setStatus(beat, 'active', { mark: newestOf(req.db, chatId) });
            return { changed: true, entries: [beatEntry(beat, 'active', 'pending', source, 'next')], beat: { id: beat.id, title: titleOf(beat) } };
        });
        return respond(res, out, req.db, chatId, out?.beat ? { beat: out.beat } : {});
    });

    // a pass now, whatever the cadence and the switch say
    router.post('/chats/:chatId/direct', ctx.requireChat, (req, res) => {
        const { chatId } = req.params;
        if (onTheWay(passesFor(req.db, chatId)).length) return res.status(409).json({ error: 'the director is reading this chat already' });
        if (!hasWork(slotOf(req.db, chatId).beats)) return res.status(409).json({ error: 'nothing to direct: no beat is active or pending' });
        res.json({ queued: true, id: queuePass(req.db, chatId, { clock: false }).id });
    });

    router.get('/chats/:chatId/log', ctx.requireChat, (req, res) => {
        const limit = Number(req.query.limit ?? LOG_PAGE);
        if (!Number.isInteger(limit) || within(limit, [1, LOG_MAX]) !== limit) return res.status(400).json({ error: `limit is a whole number from 1 to ${LOG_MAX}` });
        res.json({ entries: readLog(req.db, req.params.chatId, limit) });
    });

    router.delete('/chats/:chatId/log', ctx.requireChat, (req, res) => {
        const { chatId } = req.params;
        req.db.transaction(() => {
            if (req.db.prepare(`DELETE FROM ${TABLE} WHERE chat_id = ?`).run(chatId).changes) report(req.db, chatId, ['log']);
        })();
        res.json({ entries: [] });
    });

    // ======================================== the planner: drafts answered, never stored until added
    // a model call the reader can hang up on, its failure answered by the app in its kind's words
    const ask = async (req, res, messages) => {
        const gone = new AbortController();
        res.on('close', () => { if (!res.writableEnded) gone.abort(); });
        const tokens = tokenBudget(req.db);
        try {
            return { out: await ctx.llm.chat(req.db, { messages, profileSetting: 'profileId', chatId: req.params.chatId, params: { maxTokens: tokens } }, { signal: gone.signal }), tokens };
        } catch (e) {
            if (gone.signal.aborted) return null;
            throw e;
        }
    };
    // what a planner answer says beside its drafts: the beat it left half-written, and a cut at the ceiling
    const notesOf = (db, { out, tokens }, dropped) => ({
        ...(dropped !== null && dropped !== undefined ? { dropped } : {}),
        ...(wasCut(out) ? { cut: { tokens, words: cutOf(db, out, tokens) } } : {}),
    });

    router.post('/chats/:chatId/draft', ctx.requireChat, async (req, res) => {
        const notes = req.body?.notes;
        if (typeof notes !== 'string' || !notes.trim() || notes.length > NOTES_MAX) return res.status(400).json({ error: `notes is text of 1 to ${NOTES_MAX} characters` });
        const asked = await ask(req, res, listPrompt(notes.trim(), ctx.prompt.fence));
        if (!asked) return undefined;
        const { drafts, dropped } = parseDrafts(asked.out.content);
        return res.json({ drafts, ...(drafts.length ? {} : { said: saidOf(asked.out.content) }), ...notesOf(req.db, asked, dropped) });
    });

    router.post('/chats/:chatId/discuss', ctx.requireChat, async (req, res) => {
        const { chatId } = req.params;
        const { history, context = false } = req.body || {};
        const turn = (t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim() && t.content.length <= TURN_MAX;
        if (!Array.isArray(history) || !history.length || history.length > TURNS_MAX || !history.every(turn) || history.at(-1).role !== 'user') {
            return res.status(400).json({ error: `history is 1 to ${TURNS_MAX} turns of user or assistant text, at most ${TURN_MAX} characters each, ending on the reader's` });
        }
        if (typeof context !== 'boolean') return res.status(400).json({ error: 'context is true or false' });
        let story = '';
        if (context) {
            const chat = ctx.prompt.read(req.db, chatId);
            if (chat) story = storyFor(chat, slotOf(req.db, chatId).beats, num(req.db, 'messages'));
        }
        const asked = await ask(req, res, discussPrompt(history, story, ctx.prompt.fence));
        if (!asked) return undefined;
        const { dropped, ...answered } = parseDiscuss(asked.out.content);
        return res.json({ ...answered, ...notesOf(req.db, asked, dropped) });
    });
}
