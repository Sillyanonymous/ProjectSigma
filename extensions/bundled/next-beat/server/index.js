// SPDX-License-Identifier: MIT

// Next Beat, the server half: suggestions for where a chat goes next, surprises the narrator brings in
// later, and the reader's style library.
import crypto from 'node:crypto';
import {
    BUILT_IN, builtIn, ICONS, CUSTOM_KEY_RE, NAME_MAX, PROMPT_MAX, CUSTOM_MAX, DIRECTOR_MODES, DIRECTIONS_MAX,
    DIRECTION_MAX, settingNumber, lengthKey, surpriseRange,
} from '../client/catalog.js';
import { parseSuggestions, suggestionStream, noteFrom, unreadOf } from './parse.js';
import { storyText, suggestionPrompt, surprisePrompt, noteBlock, tokenBudget } from './prompts.js';

// the note's sixty words, with room for a model that runs a little long
const SURPRISE_TOKENS = 200;
const TABLE = 'x_next_beat_styles';
const NOTHING_YET = 'This chat has nothing to read yet: write its first message, then ask again.';

// append-only: an entry that ran is never edited, a change is a new entry
export const migrations = [
    `CREATE TABLE x_next_beat_styles (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('override', 'custom')),
        name TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL,
        created_at INTEGER NOT NULL);`,
];

export function register(router, ctx) {
    const ID = ctx.manifest.id;
    const num = (db, key) => settingNumber(key, ctx.setting(db, key), ctx.manifest.settings[key]);
    const settingsOf = (db) => ({
        count: num(db, 'count'),
        length: lengthKey(ctx.setting(db, 'length')),
        depth: num(db, 'depth'),
        scenario: ctx.setting(db, 'scenario') !== false,
        description: ctx.setting(db, 'description') !== false,
        stream: ctx.setting(db, 'stream') === true,
        reasoning: ctx.setting(db, 'reasoning') === true,
        reasoningTokens: num(db, 'reasoningTokens'),
    });

    // ======================================== the style library
    // our styles as the reader rewrote them and their own, oldest first; a row breaking a rule is dropped
    const readLibrary = (db) => {
        const rows = db.prepare(`SELECT key, kind, name, icon, prompt FROM ${TABLE} ORDER BY created_at, rowid`).all();
        const overrides = {};
        for (const r of rows) {
            if (r.kind === 'override' && builtIn(r.key) && r.prompt.trim()) overrides[r.key] = { prompt: r.prompt.slice(0, PROMPT_MAX) };
        }
        const custom = rows
            .filter(r => r.kind === 'custom' && CUSTOM_KEY_RE.test(r.key) && r.name.trim() && r.prompt.trim())
            .map(r => ({ key: r.key, name: r.name.trim().slice(0, NAME_MAX), icon: ICONS.includes(r.icon) || SAVED_ICON.test(r.icon) ? r.icon : ICONS[0], prompt: r.prompt.slice(0, PROMPT_MAX) }));
        return { overrides, custom };
    };
    const dropStyle = (db, key) => db.prepare(`DELETE FROM ${TABLE} WHERE key = ?`).run(key);
    const putOverride = (db, key, prompt) => db.transaction(() => {
        dropStyle(db, key);
        db.prepare(`INSERT INTO ${TABLE} (key, kind, prompt, created_at) VALUES (?, 'override', ?, ?)`).run(key, prompt, Date.now());
    })();
    const stylesOf = (lib) => [
        ...BUILT_IN.map(s => ({ key: s.key, kind: s.kind, name: s.name, icon: s.icon, prompt: lib.overrides[s.key]?.prompt ?? s.prompt, edited: !!lib.overrides[s.key] })),
        ...lib.custom.map(c => ({ ...c, kind: 'custom', edited: false })),
    ];
    const styleOf = (db, key) => stylesOf(readLibrary(db)).find(s => s.key === key) || null;

    const promptIn = (v) => (typeof v === 'string' && v.trim() && v.length <= PROMPT_MAX ? v.trim() : null);
    const nameIn = (v) => (typeof v === 'string' && v.trim() && v.trim().length <= NAME_MAX ? v.trim() : null);
    const PROMPT_RULE = `prompt is text of at most ${PROMPT_MAX} characters`;
    const NAME_RULE = `name is text of at most ${NAME_MAX} characters`;
    const ICON_RULE = 'icon is one of the icons a style may wear';
    // an icon a style was saved with stays its own after the offered list changes
    const SAVED_ICON = /^fa-[a-z0-9-]+$/;

    router.get('/styles', (req, res) => res.json({ styles: stylesOf(readLibrary(req.db)) }));

    // a style of the reader's own
    router.post('/styles', (req, res) => {
        const { name, icon, prompt } = req.body || {};
        if (!nameIn(name)) return res.status(400).json({ error: NAME_RULE });
        if (!ICONS.includes(icon)) return res.status(400).json({ error: ICON_RULE });
        if (!promptIn(prompt)) return res.status(400).json({ error: PROMPT_RULE });
        const lib = readLibrary(req.db);
        if (lib.custom.length >= CUSTOM_MAX) return res.status(400).json({ error: `a library holds at most ${CUSTOM_MAX} styles of your own` });
        const key = `custom-${crypto.randomBytes(4).toString('hex')}`;
        req.db.prepare(`INSERT INTO ${TABLE} (key, kind, name, icon, prompt, created_at) VALUES (?, 'custom', ?, ?, ?, ?)`)
            .run(key, nameIn(name), icon, promptIn(prompt), Date.now());
        res.json({ key, styles: stylesOf(readLibrary(req.db)) });
    });

    // ours: its prompt, ours again when it matches; the reader's: any of its fields
    router.put('/styles/:key', (req, res) => {
        const key = req.params.key;
        const body = req.body || {};
        const lib = readLibrary(req.db);
        const ours = builtIn(key);
        if (ours) {
            if (!promptIn(body.prompt)) return res.status(400).json({ error: PROMPT_RULE });
            if (promptIn(body.prompt) === ours.prompt) dropStyle(req.db, key);
            else putOverride(req.db, key, promptIn(body.prompt));
        } else {
            const mine = lib.custom.find(c => c.key === key);
            if (!mine) return res.status(404).json({ error: 'no such style' });
            if (body.name !== undefined && !nameIn(body.name)) return res.status(400).json({ error: NAME_RULE });
            if (body.icon !== undefined && body.icon !== mine.icon && !ICONS.includes(body.icon)) return res.status(400).json({ error: ICON_RULE });
            if (body.prompt !== undefined && !promptIn(body.prompt)) return res.status(400).json({ error: PROMPT_RULE });
            const next = { name: body.name !== undefined ? nameIn(body.name) : mine.name, icon: body.icon ?? mine.icon, prompt: body.prompt !== undefined ? promptIn(body.prompt) : mine.prompt };
            req.db.prepare(`UPDATE ${TABLE} SET name = ?, icon = ?, prompt = ? WHERE key = ?`).run(next.name, next.icon, next.prompt, key);
        }
        res.json({ styles: stylesOf(readLibrary(req.db)) });
    });

    // ours goes back to our prompt; the reader's is deleted
    router.delete('/styles/:key', (req, res) => {
        const key = req.params.key;
        if (!builtIn(key) && !readLibrary(req.db).custom.some(c => c.key === key)) return res.status(404).json({ error: 'no such style' });
        dropStyle(req.db, key);
        res.json({ styles: stylesOf(readLibrary(req.db)) });
    });

    // ======================================== the story a request reads
    // the chat's names, stored history and macros, and the card's scenario and description when the settings ask for them
    const storyFor = (db, chatId, opts) => {
        const chat = ctx.prompt.read(db, chatId);
        if (!chat || !chat.history.length) return null;
        const row = ctx.stores.chats.getChatRow(db, chatId);
        const card = (row?.char_id && ctx.stores.characters.getCharacter(db, row.char_id)?.card?.data) || {};
        return { chat, story: storyText(chat, card, { ...opts, shown: ctx.messages.shown }) };
    };

    const directorOf = (body) => {
        const d = body?.director;
        if (!d || typeof d !== 'object') return { error: 'director names its mode and its directions' };
        if (!DIRECTOR_MODES.includes(d.mode)) return { error: `director.mode is one of ${DIRECTOR_MODES.join(', ')}` };
        const rule = `director.directions holds one to ${DIRECTIONS_MAX} directions of at most ${DIRECTION_MAX} characters`;
        if (!Array.isArray(d.directions) || d.directions.some(x => typeof x !== 'string')) return { error: rule };
        const directions = d.directions.map(x => x.trim()).filter(Boolean);
        if (!directions.length || directions.length > DIRECTIONS_MAX || directions.some(x => x.length > DIRECTION_MAX)) return { error: rule };
        return { mode: d.mode, directions };
    };

    // ======================================== suggestions
    // an empty set says why; the log holds the finish and the lengths, never what the model wrote
    const unreadFor = (req, { content, reasoningChars, finishReason }) => {
        ctx.debugLog(req, `no suggestion read: finish ${finishReason ?? 'none'}, answer ${content.length} characters, reasoning ${reasoningChars}`);
        return unreadOf({ content, thought: reasoningChars > 0, finishReason });
    };

    // one JSON line per suggestion as it completes, then a done line; or the whole set at once when streaming is off
    router.post('/chats/:chatId/suggest', ctx.requireChat, async (req, res) => {
        const { db } = req;
        const style = styleOf(db, req.body?.style);
        if (!style) return res.status(400).json({ error: 'style names one of the library\'s styles' });
        const director = style.kind === 'director' ? directorOf(req.body) : null;
        if (director?.error) return res.status(400).json({ error: director.error });
        const s = settingsOf(db);
        const read = storyFor(db, req.params.chatId, s);
        if (!read) return res.status(409).json({ error: NOTHING_YET });
        // steps are one suggestion a step, whatever the count
        const max = director?.mode === 'steps' ? director.directions.length : s.count;
        const request = {
            chatId: req.params.chatId,
            messages: suggestionPrompt({ style, story: read.story, count: s.count, length: s.length, director, fence: ctx.prompt.fence }),
            params: { maxTokens: tokenBudget({ count: max, length: s.length, reasoning: s.reasoning, reasoningTokens: s.reasoningTokens }) },
        };
        const gone = new AbortController();
        res.on('close', () => { if (!res.writableEnded) gone.abort(); });

        if (!s.stream) {
            let out;
            // the connection picked in the settings, while the account still has it; else the one this chat uses
            try { out = await ctx.llm.chat(db, { ...request, profileSetting: 'profileId' }, { signal: gone.signal }); } catch (e) {
                if (gone.signal.aborted) return undefined;
                throw e;
            }
            const suggestions = parseSuggestions(out.content, { max });
            if (suggestions.length) return res.json({ suggestions });
            const content = String(out.content ?? '');
            return res.json({ suggestions, unread: unreadFor(req, { content, reasoningChars: String(out.reasoning ?? '').length, finishReason: out.finishReason }) });
        }

        const feed = suggestionStream({ max });
        // the set is whole once the count is met, so the model is stopped there rather than read to its end
        const enough = new AbortController();
        const signal = AbortSignal.any([gone.signal, enough.signal]);
        let count = 0;
        let reasoningChars = 0;
        let finishReason = null;
        const line = (obj) => {
            if (!res.headersSent) {
                res.status(200).setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
                res.setHeader('Cache-Control', 'no-store');
            }
            res.write(`${JSON.stringify(obj)}\n`);
        };
        try {
            for await (const ev of ctx.llm.stream(db, { ...request, profileSetting: 'profileId' }, { signal })) {
                if (!res.headersSent) line({ started: true });
                if (ev.reasoning) reasoningChars += ev.reasoning.length;
                if (ev.done) finishReason = ev.done.finishReason ?? null;
                if (!ev.text) continue;
                for (const suggestion of feed.push(ev.text)) { line({ suggestion }); count++; }
                if (feed.full) { enough.abort(); break; }
            }
        } catch (e) {
            if (gone.signal.aborted) return undefined;
            if (!enough.signal.aborted) {
                if (!res.headersSent) throw e;
                line({ error: String(e?.message || e), kind: e?.kind || 'upstream' });
                return res.end();
            }
        }
        if (gone.signal.aborted) return undefined;
        for (const suggestion of feed.end()) { line({ suggestion }); count++; }
        line(count ? { done: true, count } : { done: true, count, unread: unreadFor(req, { content: feed.text, reasoningChars, finishReason }) });
        return res.end();
    });

    // ======================================== surprises
    // a chat's armed surprises ride its slot: what each note says, the newest message it was armed after, and how far ahead
    const queueOf = (slot) => (Array.isArray(slot?.surprises) ? slot.surprises : [])
        .filter(s => typeof s?.id === 'string' && typeof s.text === 'string' && s.text && Number.isInteger(s.armedAt) && Number.isInteger(s.distance));
    const writeQueue = (db, chatId, queue) => {
        const slot = ctx.chatSlot.get(db, chatId);
        const rest = { ...slot };
        delete rest.surprises;
        ctx.chatSlot.set(db, chatId, queue.length ? { ...rest, surprises: queue } : (Object.keys(rest).length ? rest : null));
        // the slot's write is reported as the chat's metadata, which every reply writes too: this field is the one a page follows
        ctx.report(db, { entity: 'chat', op: 'updated', ids: [chatId], fields: [`${ID}.surprises`] });
    };
    // the seq a build's lastSeq is held to: the newest message the prompt reads, walked back past hidden ones
    const newestSeq = (db, chatId) => {
        let row = ctx.stores.chats.messageRowAt(db, chatId);
        while (row) {
            if (ctx.prompt.visible(JSON.parse(row.data))) return row.seq;
            row = row.seq > 0 ? ctx.stores.chats.messageRowAt(db, chatId, row.seq - 1) : null;
        }
        return null;
    };
    const distanceOf = (db) => {
        const [lo, hi] = surpriseRange(num(db, 'surpriseMin'), num(db, 'surpriseMax'));
        return lo + crypto.randomInt(hi - lo + 1);
    };
    // the queue as the reader may see it: how many, and how far each is from firing, never what it says
    const viewOf = (db, chatId) => {
        const newest = newestSeq(db, chatId);
        const styles = stylesOf(readLibrary(db));
        return {
            surprises: queueOf(ctx.chatSlot.get(db, chatId)).map(s => {
                const style = styles.find(x => x.key === s.style);
                const moved = newest === null ? 0 : Math.max(0, newest - s.armedAt);
                return { id: s.id, style: s.style, name: style?.name || 'A style since removed', icon: style?.icon || 'fa-wand-magic-sparkles', distance: s.distance, left: Math.max(0, s.distance - moved) };
            }),
            endless: ctx.setting(db, 'endless') === true,
        };
    };

    // one hidden note in a style, armed after the chat's newest message
    const arm = async (db, chatId, styleKey, signal) => {
        const style = styleOf(db, styleKey);
        if (!style || style.kind === 'director') throw Object.assign(new Error('style names one of the library\'s styles (Director plans no surprise)'), { statusCode: 400 });
        const s = settingsOf(db);
        const read = storyFor(db, chatId, s);
        if (!read) throw Object.assign(new Error(NOTHING_YET), { statusCode: 409 });
        const out = await ctx.llm.chat(db, {
            messages: surprisePrompt({ style, story: read.story, fence: ctx.prompt.fence }),
            profileSetting: 'profileId',
            chatId,
            params: { maxTokens: s.reasoning ? Math.max(s.reasoningTokens, SURPRISE_TOKENS) : SURPRISE_TOKENS },
        }, { signal });
        const text = noteFrom(out?.content);
        if (!text) throw new ctx.llm.kit.LlmError('upstream', 'the model answered no surprise, so none was armed');
        const entry = { id: crypto.randomBytes(6).toString('hex'), style: style.key, text, armedAt: read.chat.history.at(-1).seq, distance: distanceOf(db), at: Date.now() };
        // a chat deleted while the model was asked keeps nothing
        const kept = db.transaction(() => {
            if (!ctx.stores.chats.chatExists(db, chatId)) return false;
            writeQueue(db, chatId, [...queueOf(ctx.chatSlot.get(db, chatId)), entry]);
            return true;
        })();
        return kept ? entry : null;
    };

    // Endless: the style that just fired is armed again, as a job the reader can follow and cancel
    const rearm = (db, chatId, style) => {
        const name = ctx.stores.chats.getChatRow(db, chatId)?.name || 'a chat';
        ctx.jobs.run(db, {
            key: `rearm:${chatId}:${crypto.randomBytes(4).toString('hex')}`,
            label: `Arming the next surprise in ${name}`,
            run: async ({ db: jobDb, signal }) => { await arm(jobDb, chatId, style, signal); },
        });
    };

    router.get('/chats/:chatId/surprises', ctx.requireChat, (req, res) => res.json(viewOf(req.db, req.params.chatId)));

    router.post('/chats/:chatId/surprises', ctx.requireChat, async (req, res) => {
        const { chatId } = req.params;
        const gone = new AbortController();
        res.on('close', () => { if (!res.writableEnded) gone.abort(); });
        let entry;
        try { entry = await arm(req.db, chatId, req.body?.style, gone.signal); } catch (e) {
            if (gone.signal.aborted) return undefined;
            throw e;
        }
        if (!entry) return res.status(404).json({ error: 'the chat was deleted while its surprise was planned' });
        return res.json({ armed: { id: entry.id, style: entry.style, distance: entry.distance }, ...viewOf(req.db, chatId) });
    });

    router.delete('/chats/:chatId/surprises', ctx.requireChat, (req, res) => {
        const { chatId } = req.params;
        req.db.transaction(() => { if (queueOf(ctx.chatSlot.get(req.db, chatId)).length) writeQueue(req.db, chatId, []); })();
        res.json(viewOf(req.db, chatId));
    });

    router.delete('/chats/:chatId/surprises/:id', ctx.requireChat, (req, res) => {
        const { chatId, id } = req.params;
        const found = req.db.transaction(() => {
            const queue = queueOf(ctx.chatSlot.get(req.db, chatId));
            if (!queue.some(s => s.id === id)) return false;
            writeQueue(req.db, chatId, queue.filter(s => s.id !== id));
            return true;
        })();
        if (!found) return res.status(404).json({ error: 'no such surprise' });
        res.json(viewOf(req.db, chatId));
    });

    // the note, once the chat moved its distance past where it was armed; a send, never a dry build,
    // notes which surprise its reply read
    const reads = new Map();
    const readKey = (user, chatId) => `${user}\u0000${chatId}`;
    ctx.prompt.addBlock({
        id: 'surprise',
        position: 'at_depth',
        depth: 1,
        role: 'system',
        text: ({ db, user, chatId, dryRun, lastSeq }) => {
            if (!chatId || !Number.isInteger(lastSeq)) return '';
            const due = queueOf(ctx.chatSlot.get(db, chatId)).find(s => lastSeq - s.armedAt >= s.distance);
            if (!due) return '';
            if (!dryRun) reads.set(readKey(user, chatId), { id: due.id, lastSeq });
            return noteBlock(due.text);
        },
    });

    // the reply a send wrote from the note is stored: the surprise has fired, and Endless arms its style again
    const isReply = (msg) => !!msg && !msg.is_user && !msg.is_system;
    ctx.events.on((records, { db, user }) => {
        for (const r of records) {
            if (r.entity !== 'message' || (r.op !== 'created' && r.op !== 'updated') || !r.chatId) continue;
            const key = readKey(user, r.chatId);
            const read = reads.get(key);
            if (!read) continue;
            // a continue rewrites the message the build ended on; every other reply lands after it
            const replied = (r.ids || []).some(seq => Number.isInteger(seq) && seq >= read.lastSeq && isReply(ctx.stores.chats.readMessageRow(db, r.chatId, seq)));
            if (!replied) continue;
            reads.delete(key);
            const fired = db.transaction(() => {
                if (!ctx.stores.chats.chatExists(db, r.chatId)) return null;
                const queue = queueOf(ctx.chatSlot.get(db, r.chatId));
                const hit = queue.find(s => s.id === read.id);
                if (hit) writeQueue(db, r.chatId, queue.filter(s => s !== hit));
                return hit || null;
            })();
            if (fired && ctx.setting(db, 'endless') === true) rearm(db, r.chatId, fired.style);
        }
    });
}
