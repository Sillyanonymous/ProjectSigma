// SPDX-License-Identifier: 0BSD

// The Hello World tour, the server half: every server door once. What would change an account's data
// waits for a setting, off at first.
import fs from 'node:fs';

const TABLE = 'x_hello_world_waves';

// the published types, for an editor that reads them (docs/extensions.d.ts; copy it beside an extension of your own)
/** @typedef {import('../../../../docs/extensions').Database} Database */
/** @typedef {import('../../../../docs/extensions').LlmCall} LlmCall */
/** @typedef {import('../../../../docs/extensions').Message} Message */
// what a throw carries: its words, a refusal's status
/** @typedef {{ message?: string, statusCode?: number }} Failure */

// Tables of its own: each entry SQL (or a function), run once per library in order. Append only.
export const migrations = [
    `CREATE TABLE x_hello_world_waves (
        char_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
        waves INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL);
     CREATE INDEX x_hello_world_waves_waves ON x_hello_world_waves(waves);`,
];

/** @type {import('../../../../docs/extensions').ServerExtension['register']} */
export function register(router, ctx) {
    /** @param {Database} db */
    const greeting = (db) => ctx.setting(db, 'greeting');
    // what this half heard for each account since the server started; the client's tour view shows it
    const heard = new Map();
    /** @param {string} user */
    const tally = (user) => {
        if (!heard.has(user)) heard.set(user, { batches: 0, records: 0, refused: 0, lastTick: null });
        return heard.get(user);
    };

    router.get('/hello', (req, res) => {
        ctx.debugLog(req, 'hello route hit');
        res.json({ hello: req.userHandle, from: ctx.manifest.id, greeting: greeting(req.db) });
    });
    // gated to admins exactly as the app's own admin routes are
    router.get('/admin-check', ctx.requireAdmin, (req, res) => res.json({ ok: true, admin: req.userHandle }));

    // ---- the data loop: a table of its own, a report inside the write, the three query doors
    ctx.query.projection({ key: 'waves', table: TABLE, column: 'waves' });
    ctx.query.ruleField({ key: 'waves', label: 'Waves', type: 'number', table: TABLE, column: 'waves' });
    ctx.query.sortKey({ key: 'waves', label: 'Waves', table: TABLE, column: 'waves' });
    /** @param {Database} db @param {string} id */
    const wavesOf = (db, id) => db.prepare(`SELECT waves FROM ${TABLE} WHERE char_id = ?`).get(id)?.waves ?? 0;
    // one wave each at the characters the library holds, inside one write: the others are answered as skipped
    /** @param {Database} db @param {string[]} ids */
    const wave = (db, ids) => {
        /** @type {{ affected: string[], skipped: string[] }} */
        const out = { affected: [], skipped: [] };
        db.transaction(() => {
            const up = db.prepare(`INSERT INTO ${TABLE} (char_id, waves, updated_at) VALUES (?, 1, ?)
                ON CONFLICT(char_id) DO UPDATE SET waves = waves + 1, updated_at = excluded.updated_at`);
            // which of them the library holds, in one query for the whole selection
            const held = ctx.stores.characters.existingCharacterIds(db, ids);
            for (const id of ids) {
                if (!held.has(id)) { out.skipped.push(id); continue; }
                up.run(id, Date.now());
                out.affected.push(id);
            }
            // a write to its own table reaches no guard or tab until it is reported
            if (out.affected.length) ctx.report(db, { entity: 'character', op: 'updated', ids: out.affected, fields: ['hello-world.waves'] });
        })();
        // a file in the folder every account shares, never served: the last wave anywhere
        if (out.affected.length) ctx.files.shared().writeJson('last-wave.json', { at: Date.now() });
        return out;
    };

    router.put('/wave/:id', (req, res) => {
        const id = req.params.id;
        if (!wave(req.db, [id]).affected.length) return res.status(404).json({ error: 'character not found' });
        const waves = wavesOf(req.db, id);
        // a wave from a chat is noted on the chat too, in this extension's own slot of its metadata
        const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId : '';
        if (chatId && ctx.stores.chats.chatExists(req.db, chatId)) ctx.chatSlot.set(req.db, chatId, { ...ctx.chatSlot.get(req.db, chatId), lastWave: Date.now() });
        res.json({ waves });
    });
    // a selection is one request and one write, never a request per character
    router.put('/waves', (req, res) => {
        /** @type {string[]} */
        const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.filter((/** @type {unknown} */ id) => typeof id === 'string' && id))] : [];
        if (!ids.length || ids.length > 1000) return res.status(400).json({ error: 'ids: one to a thousand character ids' });
        res.json(wave(req.db, ids));
    });
    router.get('/waves/:id', (req, res) => res.json({ waves: wavesOf(req.db, req.params.id) }));

    // ---- a store guard may refuse a write before it commits; check the fields first, so a card
    // is read only when a name was set
    ctx.hooks.add('store.before.character.updated', (record, { db, user }) => {
        if (Array.isArray(record.fields) && !record.fields.includes('name')) return;
        for (const id of record.ids || []) {
            if (ctx.stores.characters.getCharacter(db, id)?.card?.data?.name !== 'Refused by Hello World') continue;
            tally(user).refused++;
            ctx.refuse('Hello World refuses that name (the tour\'s store guard)');
        }
    });

    // ---- a pipeline filter: a book of its own in every lore scan, while the account's loreBook is on
    ctx.hooks.add('lore.candidates', (books, { db }) => {
        if (!ctx.setting(db, 'loreBook')) return undefined;
        const entry = { uid: 0, key: ['hello'], keysecondary: [], comment: 'Greeting', content: `${greeting(db)}, from the Hello World tour's own book.`, constant: false, selective: false, order: 100, position: 0, disable: false };
        return [...books, { name: 'ext:hello-world:greetings', data: { entries: { 0: entry } } }];
    });

    // ---- {{hello}}, {{hello::Nova}}, {{hello::Nova::Orion}} anywhere a prompt is built from, and a
    // block of its own that waits for promptNote
    ctx.macros.add('hello', {
        args: [{ name: 'who', optional: true }],
        list: true,
        handler: ({ db, unnamedArgs: [who], list }) => {
            const names = [who, ...(list || [])].filter(n => typeof n === 'string' && n.trim()).map(n => n.trim());
            if (!names.length) return greeting(db);
            return `${greeting(db)}, ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}`;
        },
    });
    ctx.prompt.addBlock({ id: 'note', position: 'at_depth', depth: 0, role: 'system', text: ({ db }) => ctx.setting(db, 'promptNote') || '' });

    // ---- a chat as its prompt reads it; ctx.requireChat answers 404 for a chat the account lacks
    router.get('/read/:chatId', ctx.requireChat, (req, res) => {
        const { chatId } = req.params;
        const chat = ctx.prompt.read(req.db, chatId);
        if (!chat) return res.status(404).json({ error: 'chat not found' });
        /** @type {Array<{ id: number, seq: number, msg: Message }>} */
        const rows = ctx.stores.chats.listMessageRows(req.db, chatId);
        // the newest message's text and digest: stored beside what you made of it, it tells a change
        const newest = rows.at(-1)?.msg;
        res.json({
            charName: chat.charName, userName: chat.userName, read: chat.history.length,
            // the two names alone, for a half that reads the rows itself as this route does just above
            names: ctx.prompt.names(req.db, chatId),
            stored: rows.length, readable: rows.filter(({ msg }) => ctx.prompt.visible(msg)).length,
            expanded: chat.expand('{{hello::{{user}}}}, from {{char}}.'),
            newest: newest ? { text: ctx.messages.shown(newest), digest: ctx.messages.digest(ctx.messages.shown(newest)) } : null,
            lastWave: ctx.chatSlot.get(req.db, chatId).lastWave ?? null,
        });
    });

    // ---- a model call, or a stream, on the account's own connections; the last answer in a per-user slot
    const lastAnswer = ctx.helpers.sessionSlot('hello-world-answer');
    router.post('/ask', async (req, res) => {
        // a display name is text the reader typed: quoted between fences it cannot close, as any text
        // a prompt carries from outside should be
        /** @type {LlmCall['messages']} */
        const messages = [
            { role: 'system', content: 'Answer in one short, friendly sentence.' },
            { role: 'user', content: `Say "${greeting(req.db)}" to the person named between the fences.\n\n${ctx.prompt.fence(req.user?.displayName || req.userHandle)}` },
        ];
        // a connection the reader picked, else the one the account's chats use, else its first
        /** @type {LlmCall} */
        const call = { messages, params: { maxTokens: 60 }, profileId: req.body?.profileId || undefined };
        // a model's failure is let go: the app answers its kind's status (504, 502 or 400) and { error, kind }
        let content = '';
        if (req.body?.stream) {
            for await (const ev of ctx.llm.stream(req.db, call)) if (ev.text) content += ev.text;
        } else {
            content = (await ctx.llm.chat(req.db, call)).content;
        }
        lastAnswer.set(req, content);
        // whether that connection would take pictures too (images on a user message): true, false, or null when unchecked
        res.json({ content, seesPictures: ctx.llm.canSee(req.db, { profileId: call.profileId }) });
    });
    router.get('/last-answer', (req, res) => res.json({ content: lastAnswer.get(req) }));

    // ---- a job with its progress, the account's jobs as they stand, and a daily schedule that only notes its tick
    router.post('/count', (req, res) => {
        // a count already on its way answers for this one, never a second walk queued behind it
        const busy = ctx.jobs.list(req.db).find(j => j.key === 'count' && (j.status === 'queued' || j.status === 'running'));
        if (busy) return res.json({ id: busy.id });
        const { id } = ctx.jobs.run(req.db, {
            key: 'count',
            label: 'Counting your characters (Hello World)',
            // the library a page at a time through the characters store, never every id at once
            run: async ({ db, signal, progress }) => {
                const total = ctx.stores.stats.libraryCounts(db).characters;
                let done = 0;
                let after;
                do {
                    // by creation, a key no write moves: a rename mid-count would move a name-sorted character past the cursor
                    const page = ctx.stores.characters.queryCharacters(db, { idsOnly: true, sort: 'created', limit: 200, after, count: false });
                    done += page.items.length;
                    progress({ done, total, note: 'counting' });
                    after = page.nextCursor;
                    await new Promise(r => setImmediate(r));
                } while (after && !signal.aborted);
            },
        });
        res.json({ id });
    });
    router.get('/jobs', (req, res) => res.json(ctx.jobs.list(req.db)));
    ctx.jobs.schedule({ id: 'tick', every: 24 * 60 * 60 * 1000, label: 'Hello World daily tick', run: async ({ user }) => { tally(user).lastTick = Date.now(); } });

    // ---- every committed change to an account's library, once the write returned
    ctx.events.on((records, { user }) => {
        const t = tally(user);
        t.batches++;
        t.records += records.length;
    });

    // ---- a card file the half holds, staged as an upload is: the client commits the stage
    const cardFile = new URL('../assets/hello-card.png', import.meta.url);
    router.post('/stage', async (req, res) => {
        try {
            res.json(await ctx.imports.stage(req, fs.readFileSync(cardFile), { name: 'Hello.png' }));
        } catch (e) {
            const failure = /** @type {Failure} */ (e);
            res.status(failure.statusCode || 500).json({ error: failure.message });
        }
    });

    // ---- a per-user file, in the tour's own folder inside that user's home
    router.put('/note', (req, res) => {
        ctx.files.user(req).write('note.txt', String(req.body?.text ?? '').slice(0, 2000));
        res.json({ ok: true });
    });
    router.get('/note', (req, res) => res.json({ text: ctx.files.user(req).read('note.txt') ?? '' }));

    // ---- a wildcard route, and the path it matched
    router.get('/echo/*splat', (req, res) => res.json({ path: ctx.helpers.wildcardPath(req) }));

    // ---- what this half heard for the asking account, and a first-party setting read as the app reads it
    router.get('/tour', (req, res) => {
        const lastWave = ctx.files.shared().readJson('last-wave.json', { at: null }).at;
        res.json({ ...tally(req.userHandle), lastWave, multiUser: ctx.multiUser, apiVersion: ctx.apiVersion, debugMode: ctx.settingValue(req.db, 'debugMode', false) });
    });
}
