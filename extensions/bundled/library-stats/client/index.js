// SPDX-License-Identifier: MIT

// Library Stats, the client half: the library by the numbers, read on entry and again after a change
// that can move a part.
import { PARTS } from './parts.js';

// each change and the parts it can move; the tag ranking counts links, so no message moves it
const MOVES = {
    'character.created': PARTS,
    'character.updated': PARTS,
    'character.deleted': PARTS,
    'chat.created': ['counts', 'characters'],
    'chat.deleted': ['counts', 'characters'],
    'message.created': ['counts', 'characters'],
    'message.deleted': ['counts', 'characters'],
    'tags.changed': ['counts', 'tags'],
    'playlists.changed': ['counts'],
    'lorebook.changed': ['counts'],
    'persona.changed': ['counts'],
    'library.changed': PARTS,
};
const QUIET_MS = 800;
const POLL_MS = 2000;
const MONTHS_SHOWN = 24;
// Monday first; the server counts Sunday first, as Date does
const WEEKDAYS = [['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6], ['Sun', 0]];

// the backup panel's staleness phrasing (how long has it been), local because no shared helper
// reaches an extension
function ago(ms) {
    const age = Date.now() - ms;
    if (age < 120_000) return 'just now';
    if (age < 3_600_000) return `${Math.floor(age / 60_000)} minutes ago`;
    if (age < 172_800_000) {
        const h = Math.floor(age / 3_600_000);
        return h <= 1 ? 'an hour ago' : `${h} hours ago`;
    }
    return `${Math.floor(age / 86_400_000)} days ago`;
}

const num = (n) => (Number.isFinite(n) ? n.toLocaleString() : '-');
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
const monthKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const monthName = (key, withYear) => {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1, 1));
    return d.toLocaleString(undefined, { month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
};
const dayName = (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

// this month in the zone the read was made in, or at its one offset when it names none
function monthNow(activity, now) {
    if (activity.zone) {
        try {
            const f = {};
            for (const p of new Intl.DateTimeFormat('en-US', { timeZone: activity.zone, year: 'numeric', month: 'numeric' }).formatToParts(now)) f[p.type] = Number(p.value);
            return [f.year, f.month];
        } catch { /* a zone this browser does not know: the offset */ }
    }
    const shifted = new Date(now.getTime() + (activity.offset || 0) * 60000);
    return [shifted.getUTCFullYear(), shifted.getUTCMonth() + 1];
}

// the last MONTHS_SHOWN months, ending at the newest message's month when that is older
function monthsToDraw(activity, now = new Date()) {
    let [y, m] = monthNow(activity, now);
    const keys = Object.keys(activity.months || {}).sort();
    const last = keys.at(-1);
    if (last && last < monthKey(...lastYm(y, m, MONTHS_SHOWN - 1))) [y, m] = last.split('-').map(Number);
    const out = [];
    for (let i = MONTHS_SHOWN - 1; i >= 0; i--) out.push(monthKey(...lastYm(y, m, i)));
    return out;
}
function lastYm(y, m, back) {
    const idx = y * 12 + (m - 1) - back;
    return [Math.floor(idx / 12), (idx % 12) + 1];
}

function barsHtml(values, titles) {
    const max = Math.max(1, ...values);
    return values.map((v, i) => `<span class="lst-bar${v ? '' : ' is-empty'}" style="--lst-h: ${Math.round((v / max) * 100)}%" title="${titles[i]}"></span>`).join('');
}

export default {
    init(ctx) {
        const { CoreAPI } = ctx;
        const esc = (s) => CoreAPI.escapeHtml(s);
        const call = ctx.server.call;
        const run = async (command, args) => {
            try { await ctx.commands.run(command, args); } catch (e) { CoreAPI.showToast(`Could not open it: ${e.message}`, 'error'); }
        };

        let view = null;
        ctx.ui.contribute('shell.view', {
            id: 'stats',
            label: 'Stats',
            icon: 'fa-chart-simple',
            render(el) { view = mountStats(el); },
            enter: () => view?.enter(),
            leave: () => view?.leave(),
            refresh: () => view?.refresh(),
        });

        function mountStats(el) {
            el.innerHTML = `
                <div class="lst">
                    <h2 class="lst-title">Your library</h2>
                    <div class="lst-tiles" data-lst-tiles><p class="lst-note lst-tiles-note">Counting your library...</p></div>
                    <div class="lst-pair">
                        <section class="lst-panel">
                            <h3 class="lst-heading">Most chatted</h3>
                            <ol class="lst-rank" data-lst-chars><li class="lst-none">Reading...</li></ol>
                        </section>
                        <section class="lst-panel">
                            <h3 class="lst-heading">Most used tags</h3>
                            <ol class="lst-rank" data-lst-tags><li class="lst-none">Reading...</li></ol>
                        </section>
                    </div>
                    <section class="lst-panel">
                        <div class="lst-panel-head">
                            <h3 class="lst-heading">Activity</h3>
                            <span class="lst-when" data-lst-when></span>
                            <button type="button" class="cl-btn cl-btn-secondary cl-btn-sm" data-lst-refresh><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i> Refresh</button>
                        </div>
                        <div data-lst-activity><p class="lst-note">Reading...</p></div>
                    </section>
                </div>`;
            const $ = (sel) => el.querySelector(sel);
            let shown = false;
            let soon = null;
            let poll = null;
            let asked = false;
            let summaryGen = 0;
            let activityGen = 0;
            // the summary as last answered, each part kept until a read answers it again
            let held = null;
            // the parts heard during the quiet moment, and those a read on its way asks for
            const owed = new Set();
            let inFlight = null;
            let activityShown = false;

            const onChange = (parts) => {
                if (!shown) return;
                for (const p of parts) owed.add(p);
                clearTimeout(soon);
                soon = setTimeout(() => {
                    const ask = [...owed];
                    owed.clear();
                    void readSummary(ask);
                }, QUIET_MS);
            };
            const listeners = Object.entries(MOVES).map(([name, parts]) => [name, () => onChange(parts)]);

            function paintSummary({ counts: c, topCharacters, topTags }) {
                const tile = (value, label, sub) => `<div class="lst-tile"><span class="lst-tile-value">${num(value)}</span><span class="lst-tile-label">${label}</span>${sub ? `<span class="lst-tile-sub">${sub}</span>` : ''}</div>`;
                $('[data-lst-tiles]').innerHTML = [
                    tile(c.characters, 'Characters', c.favorites ? plural(c.favorites, 'favorite', 'favorites') : ''),
                    tile(c.chats, 'Chats'),
                    tile(c.messages, 'Messages'),
                    tile(c.lorebooks, 'Lorebooks', c.loreEntries ? plural(c.loreEntries, 'entry', 'entries') : ''),
                    tile(c.tags, 'Tags'),
                    tile(c.personas, 'Personas'),
                    tile(c.playlists, 'Playlists'),
                ].join('');
                const most = Math.max(1, ...topCharacters.map(t => t.messages));
                $('[data-lst-chars]').innerHTML = topCharacters.length
                    ? topCharacters.map(t => `<li><button type="button" class="lst-row" data-lst-char="${esc(t.id)}">`
                        + `<span class="lst-row-name">${esc(t.name || 'Unnamed')}</span><span class="lst-row-meta">${plural(t.messages, 'message', 'messages')} in ${plural(t.chats, 'chat', 'chats')}</span>`
                        + `<span class="lst-row-bar" style="--lst-share: ${Math.round((t.messages / most) * 100)}%"></span></button></li>`).join('')
                    : '<li class="lst-none">No chats yet.</li>';
                const most2 = Math.max(1, ...topTags.map(t => t.count));
                $('[data-lst-tags]').innerHTML = topTags.length
                    ? topTags.map(t => `<li><button type="button" class="lst-row" data-lst-tag="${esc(t.name)}">`
                        + `<span class="lst-row-name">${esc(t.name)}</span><span class="lst-row-meta">${plural(t.count, 'character', 'characters')}</span>`
                        + `<span class="lst-row-bar" style="--lst-share: ${Math.round((t.count / most2) * 100)}%"></span></button></li>`).join('')
                    : '<li class="lst-none">No tags yet.</li>';
            }

            // the parts named plus a superseded read's; every part until one summary is held
            async function readSummary(parts = PARTS) {
                const gen = ++summaryGen;
                const want = held ? new Set([...parts, ...(inFlight || [])]) : new Set(PARTS);
                inFlight = want;
                const named = PARTS.filter(p => want.has(p));
                try {
                    const summary = await call(`/summary${named.length < PARTS.length ? `?parts=${named.join(',')}` : ''}`);
                    if (gen !== summaryGen) return;
                    inFlight = null;
                    held = { ...held, ...summary };
                    if (shown) paintSummary(held);
                } catch (e) {
                    if (gen !== summaryGen) return;
                    inFlight = null;
                    if (held) {
                        CoreAPI.showToast(`Could not read the library's numbers: ${e.message}`, 'error');
                        return;
                    }
                    // nothing read yet: the tiles say why in place of the numbers
                    $('[data-lst-tiles]').innerHTML = '<p class="lst-note lst-tiles-note is-error"></p>';
                    $('[data-lst-tiles] .lst-note').textContent = `The library's numbers could not be read: ${e.message}`;
                    for (const sel of ['[data-lst-chars]', '[data-lst-tags]']) $(sel).innerHTML = '<li class="lst-none">Not read.</li>';
                }
            }

            // a read that failed before anything was shown says so in place of the activity, else in a toast
            function activityFailed(e) {
                if (activityShown) {
                    CoreAPI.showToast(`Could not read the library's activity: ${e.message}`, 'error');
                    return;
                }
                $('[data-lst-activity]').innerHTML = '<p class="lst-note is-error"></p>';
                $('[data-lst-activity] .lst-note').textContent = `The library's activity could not be read: ${e.message}`;
            }

            function paintActivity({ activity: a, takenAt, working, failed }) {
                activityShown = true;
                const box = $('[data-lst-activity]');
                const refresh = $('[data-lst-refresh]');
                refresh.disabled = !!working;
                $('[data-lst-when]').textContent = working ? (working === 'running' ? 'Reading every message...' : 'Waiting to read...')
                    : takenAt ? `Read ${ago(takenAt)}` : '';
                if (failed) {
                    box.innerHTML = '<p class="lst-note is-error"></p>';
                    box.querySelector('.lst-note').textContent = `The last read failed: ${failed}`;
                    return;
                }
                if (!a) {
                    box.innerHTML = `<p class="lst-note">${working
                        ? 'Reading every message for the first time; the notifications center shows how far it has come.'
                        : 'Not read yet: Refresh reads every message once.'}</p>`;
                    return;
                }
                const said = a.you.messages + a.characters.messages;
                if (!said) {
                    box.innerHTML = '<p class="lst-note">No messages yet.</p>';
                    return;
                }
                const months = monthsToDraw(a);
                const fact = (value, label, sub) => `<div class="lst-fact"><span class="lst-fact-value">${value}</span><span class="lst-fact-label">${label}</span>${sub ? `<span class="lst-fact-sub">${sub}</span>` : ''}</div>`;
                box.innerHTML = `
                    <div class="lst-facts">
                        ${fact(num(a.you.messages), 'From you', plural(a.you.words, 'word', 'words'))}
                        ${fact(num(a.characters.messages), 'From characters', plural(a.characters.words, 'word', 'words'))}
                        ${a.busiest ? fact(num(a.busiest.count), 'Busiest day', esc(dayName(a.busiest.day))) : ''}
                        ${a.first ? fact(esc(new Date(a.first).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })), 'First message', a.undated ? `${plural(a.undated, 'message', 'messages')} undated` : '') : ''}
                    </div>
                    ${a.zone ? '' : '<p class="lst-note lst-zone-note">Your time zone was not known to the server, so these times are read at one offset from UTC: summer time is not applied.</p>'}
                    <h4 class="lst-subheading">By month</h4>
                    <div class="lst-chart">
                        <div class="lst-bars is-months">${barsHtml(months.map(k => a.months[k] || 0), months.map(k => esc(`${monthName(k, true)}: ${plural(a.months[k] || 0, 'message', 'messages')}`)))}</div>
                        <div class="lst-axis is-months">${months.map((k, i) => `<span>${i % 3 === 0 ? esc(monthName(k, k.endsWith('-01') || i === 0)) : ''}</span>`).join('')}</div>
                        <div class="lst-caption" data-lst-caption aria-live="polite"></div>
                    </div>
                    <div class="lst-pair">
                        <div>
                            <h4 class="lst-subheading">By weekday</h4>
                            <div class="lst-chart">
                                <div class="lst-bars">${barsHtml(WEEKDAYS.map(([, d]) => a.weekdays[d]), WEEKDAYS.map(([n, d]) => `${n}: ${plural(a.weekdays[d], 'message', 'messages')}`))}</div>
                                <div class="lst-axis">${WEEKDAYS.map(([n]) => `<span>${n}</span>`).join('')}</div>
                                <div class="lst-caption" data-lst-caption aria-live="polite"></div>
                            </div>
                        </div>
                        <div>
                            <h4 class="lst-subheading">By hour</h4>
                            <div class="lst-chart">
                                <div class="lst-bars">${barsHtml(a.hours, a.hours.map((n, h) => `${String(h).padStart(2, '0')}:00: ${plural(n, 'message', 'messages')}`))}</div>
                                <div class="lst-axis">${a.hours.map((_, h) => `<span>${h % 6 === 0 ? `${String(h).padStart(2, '0')}:00` : ''}</span>`).join('')}</div>
                                <div class="lst-caption" data-lst-caption aria-live="polite"></div>
                            </div>
                        </div>
                    </div>`;
            }

            async function readActivity() {
                const gen = ++activityGen;
                clearTimeout(poll);
                let state;
                try {
                    state = await call('/activity');
                } catch (e) {
                    if (gen === activityGen) activityFailed(e);
                    return;
                }
                if (gen !== activityGen || !shown) return;
                // the first visit reads it, once a page; afterwards only the reader's word does
                if (!state.activity && !state.working && !state.failed && !asked) {
                    asked = true;
                    await askAgain();
                    return;
                }
                paintActivity(state);
                if (state.working) poll = setTimeout(() => { void readActivity(); }, POLL_MS);
            }

            async function askAgain() {
                // the zone, so a message from the other half of a summer-time year reads in its own offset
                const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
                const offset = -new Date().getTimezoneOffset();
                try {
                    await call('/activity', 'POST', { zone, offset });
                } catch (e) {
                    // a zone newer than the server's time zone data is refused: asked once more at the offset alone
                    if (e.status !== 400 || !zone) { activityFailed(e); return; }
                    try {
                        await call('/activity', 'POST', { offset });
                    } catch (again) {
                        activityFailed(again);
                        return;
                    }
                }
                if (shown) await readActivity();
            }

            // a bar's count is its title, which a finger never sees: a tap or drag prints the bar in the caption
            function scrub(e) {
                const bars = e.target?.closest?.('.lst-bars');
                if (!bars) return;
                const kids = [...bars.children];
                let bar = e.target.closest('.lst-bar');
                if (!bar && kids.length) {
                    const r = bars.getBoundingClientRect();
                    if (r.width > 0) bar = kids[Math.min(kids.length - 1, Math.max(0, Math.floor((e.clientX - r.left) / r.width * kids.length)))];
                }
                if (!bar) return;
                for (const k of kids) k.classList.toggle('is-picked', k === bar);
                const caption = bars.parentElement?.querySelector('[data-lst-caption]');
                if (caption) caption.textContent = bar.title;
            }
            el.addEventListener('pointerdown', scrub);
            el.addEventListener('pointermove', (e) => { if (e.buttons & 1) scrub(e); });
            el.addEventListener('click', (e) => {
                const char = e.target.closest('[data-lst-char]');
                if (char) return void run('character.open', { id: char.dataset.lstChar });
                const tag = e.target.closest('[data-lst-tag]');
                if (tag) return void run('library.filter', { tag: tag.dataset.lstTag });
                if (e.target.closest('[data-lst-refresh]')) {
                    asked = true;
                    void askAgain();
                }
                return undefined;
            });

            return {
                // a phone's pull: the two reads the view shows, never the job Refresh asks for
                refresh() { return Promise.all([readSummary(), readActivity()]); },
                enter() {
                    shown = true;
                    for (const [name, fn] of listeners) ctx.events.on(name, fn);
                    void readSummary();
                    void readActivity();
                },
                leave() {
                    shown = false;
                    for (const [name, fn] of listeners) ctx.events.off(name, fn);
                    clearTimeout(soon);
                    owed.clear();
                    clearTimeout(poll);
                },
            };
        }
    },
};
