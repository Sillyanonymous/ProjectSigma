// SPDX-License-Identifier: MIT

// Library Stats, the server half: counts and rankings answer at once; the activity is read in a job
// into a snapshot.
import { PARTS } from '../client/parts.js';

const TABLE = 'x_library_stats_activity';
const KEY = 'activity';
const PAGE = 200;
// the messages read between two yields of the shared loop, and the rows one read of a chat takes
const MESSAGES_PER_YIELD = 2000;
const TOP_CHARACTERS = 10;
const TOP_TAGS = 10;
// the reader's minutes east of UTC, from the furthest zone west to the furthest east
const OFFSET_MAX = 14 * 60;
// every offset a zone has used since standard time is whole quarter hours, and changes on one
const QUARTER_MS = 15 * 60000;

// append-only: an entry that ran is never edited, a change is a new entry
export const migrations = [
    `CREATE TABLE x_library_stats_activity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL CHECK (json_valid(data)),
        taken_at INTEGER NOT NULL);`,
];

const wordsIn = (text) => (String(text || '').match(/\S+/g) || []).length;
const pad = (n) => String(n).padStart(2, '0');

// a moment's offset from UTC in a named zone, summer time included: Intl asked once per quarter hour that holds a message
function zoneOffsets(zone) {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    const memo = new Map();
    return (at) => {
        const quarter = Math.floor(at / QUARTER_MS) * QUARTER_MS;
        let off = memo.get(quarter);
        if (off === undefined) {
            const f = {};
            for (const p of fmt.formatToParts(quarter)) f[p.type] = Number(p.value);
            off = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - quarter;
            memo.set(quarter, off);
        }
        return off;
    };
}

// a zone Intl knows, under its own spelling, or null
function knownZone(zone) {
    if (typeof zone !== 'string' || !zone || zone.length > 64) return null;
    try { return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone; } catch { return null; }
}

export function register(router, ctx) {
    const jobsOf = (db) => ctx.jobs.list(db).filter(j => j.key === KEY);
    const onTheWay = (jobs) => jobs.filter(j => j.status === 'queued' || j.status === 'running');
    const snapshotOf = (db) => db.prepare(`SELECT data, taken_at FROM ${TABLE} WHERE id = 1`).get() || null;

    // every message's date, speaker and length, each date at the reader's offset then, so months and hours are theirs
    async function readActivity(db, { offset, zone }, signal, progress) {
        const offsetAt = zone ? zoneOffsets(zone) : () => offset * 60000;
        const out = {
            offset, zone, months: {}, weekdays: Array(7).fill(0), hours: Array(24).fill(0),
            you: { messages: 0, words: 0 }, characters: { messages: 0, words: 0 },
            first: null, last: null, busiest: null, undated: 0,
        };
        const days = new Map();
        const total = ctx.stores.stats.libraryCounts(db).chats;
        const tally = (msg) => {
            if (!msg || msg.is_system) return;
            const who = msg.is_user ? out.you : out.characters;
            who.messages++;
            who.words += wordsIn(msg.mes);
            // a stamp without a zone is on the reader's clock, as the conversation shows it
            const at = ctx.stores.chats.parseStDate(msg.send_date, { zone, utcOffset: offset });
            if (!at) { out.undated++; return; }
            // shifted into the reader's zone, then read as UTC fields
            const local = new Date(at + offsetAt(at));
            const month = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}`;
            out.months[month] = (out.months[month] || 0) + 1;
            out.weekdays[local.getUTCDay()]++;
            out.hours[local.getUTCHours()]++;
            const day = `${month}-${pad(local.getUTCDate())}`;
            days.set(day, (days.get(day) || 0) + 1);
            if (out.first === null || at < out.first) out.first = at;
            if (out.last === null || at > out.last) out.last = at;
        };
        // the shared loop is let go by rows read, never by page: a page of long chats can be millions of rows
        let sinceYield = 0;
        let done = 0;
        let after;
        do {
            // by creation: a message written mid-read moves a chat in the default order, past the cursor
            const page = ctx.stores.chats.listChats(db, { limit: PAGE, after, count: false, sort: 'created' });
            for (const chat of page.items) {
                let from = null;
                for (;;) {
                    const rows = ctx.stores.chats.listMessageRows(db, chat.id, { after: from, limit: MESSAGES_PER_YIELD });
                    for (const { msg } of rows) tally(msg);
                    sinceYield += rows.length;
                    if (sinceYield >= MESSAGES_PER_YIELD) {
                        sinceYield = 0;
                        await new Promise(r => setImmediate(r));
                    }
                    if (signal.aborted) return null;
                    if (rows.length < MESSAGES_PER_YIELD) break;
                    from = rows.at(-1).seq;
                }
                done++;
            }
            progress({ done, total, note: `${done} of ${total} chats read` });
            after = page.nextCursor;
        } while (after && !signal.aborted);
        if (signal.aborted) return null;
        for (const [day, count] of days) if (!out.busiest || count > out.busiest.count) out.busiest = { day, count };
        return out;
    }

    // the counts, the most chatted and the tag ranking (a count over every tag's links); ?parts= names those to answer
    router.get('/summary', (req, res) => {
        const parts = req.query.parts == null ? PARTS : String(req.query.parts).split(',');
        if (!parts.every(p => PARTS.includes(p))) return res.status(400).json({ error: `parts is a list of ${PARTS.join(', ')}` });
        const out = {};
        if (parts.includes('counts')) out.counts = ctx.stores.stats.libraryCounts(req.db, { more: true });
        if (parts.includes('characters')) out.topCharacters = ctx.stores.stats.mostChattedCharacters(req.db, TOP_CHARACTERS);
        if (parts.includes('tags')) out.topTags = ctx.stores.tags.listTagCounts(req.db).slice(0, TOP_TAGS);
        res.json(out);
    });

    // the activity as last read, when it was read, a read on its way and the last one's failure
    router.get('/activity', (req, res) => {
        const row = snapshotOf(req.db);
        const jobs = jobsOf(req.db);
        const busy = onTheWay(jobs);
        const ended = jobs.filter(j => j.endedAt).sort((a, b) => b.endedAt - a.endedAt)[0];
        res.json({
            activity: row ? JSON.parse(row.data) : null,
            takenAt: row?.taken_at ?? null,
            working: busy.some(j => j.status === 'running') ? 'running' : busy.length ? 'queued' : null,
            // a failure says so until a read lands after it
            failed: !busy.length && ended?.status === 'failed' && ended.endedAt >= (row?.taken_at || 0) ? ended.error : null,
        });
    });

    // read the activity again in the reader's zone (Europe/Paris), or at their one offset (minutes east of UTC) without it
    router.post('/activity', (req, res) => {
        const offset = req.body?.offset ?? 0;
        if (!Number.isInteger(offset) || Math.abs(offset) > OFFSET_MAX) return res.status(400).json({ error: `offset is whole minutes east of UTC, at most ${OFFSET_MAX} either way` });
        const zone = req.body?.zone == null ? null : knownZone(req.body.zone);
        if (req.body?.zone != null && !zone) return res.status(400).json({ error: 'zone is a time zone name, such as Europe/Paris' });
        // a read already on its way answers for this one: another tab's Refresh would queue a second whole-library read
        const busy = onTheWay(jobsOf(req.db));
        if (busy.length) return res.json({ id: busy[0].id });
        const { id } = ctx.jobs.run(req.db, {
            key: KEY,
            label: "Reading the library's activity",
            run: async ({ db, signal, progress }) => {
                const activity = await readActivity(db, { offset, zone }, signal, progress);
                if (!activity) return;
                db.prepare(`INSERT INTO ${TABLE} (id, data, taken_at) VALUES (1, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET data = excluded.data, taken_at = excluded.taken_at`).run(JSON.stringify(activity), Date.now());
            },
        });
        res.json({ id });
    });
}
