// A chat's stamps to unix ms: a wall clock written without a zone is on its reader's clock, else the server's

const HUMANIZED = /^(\d{4})-(\d{1,2})-(\d{1,2})\s*@\s*(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s(?:\s*(\d{1,3})ms)?/;
const MERIDIEM = /^([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)\s*$/i;
const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const QUARTER_MS = 15 * 60000;
const ZONES_MAX = 64;
const MEMO_MAX = 100000;

// a zone's formatter and its offsets by quarter hour (every offset in use is whole quarters); null for a zone Intl does not know
const zones = new Map();

function zoneOf(name) {
    if (zones.has(name)) return zones.get(name);
    let zone = null;
    try {
        const fmt = new Intl.DateTimeFormat('en-US', { timeZone: name, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
        zone = { fmt, memo: new Map() };
    } catch { /* a zone newer than this servers time zone data */ }
    if (zones.size >= ZONES_MAX) zones.clear();
    zones.set(name, zone);
    return zone;
}

function offsetAt(zone, at) {
    const quarter = Math.floor(at / QUARTER_MS) * QUARTER_MS;
    let off = zone.memo.get(quarter);
    if (off === undefined) {
        const f = {};
        for (const p of zone.fmt.formatToParts(quarter)) f[p.type] = Number(p.value);
        off = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - quarter;
        if (zone.memo.size >= MEMO_MAX) zone.memo.clear();
        zone.memo.set(quarter, off);
    }
    return off;
}

// fields on the reader's clock; the second pass takes the offset a date across a summer-time change has
function wallClock(f, reader) {
    const asUtc = Date.UTC(...f);
    const zone = typeof reader?.zone === 'string' && reader.zone ? zoneOf(reader.zone) : null;
    if (zone) return asUtc - offsetAt(zone, asUtc - offsetAt(zone, asUtc));
    if (Number.isFinite(reader?.utcOffset)) return asUtc - reader.utcOffset * 60000;
    return new Date(...f).getTime();
}

/**
 * A stored stamp as unix ms, or null when it is not one.
 * @param {*} value epoch ms (or seconds), ISO 8601, ST's "June 19, 2023 4:13pm" or its humanized stamp; any other string as Date.parse reads it
 * @param {{ zone?: string|null, utcOffset?: number|null }|null} [reader] whose clock a stamp without a zone is on (an IANA zone, minutes east of UTC); none is the server's
 * @returns {number|null}
 */
export function parseStDate(value, reader = null) {
    if (value == null) return null;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0) return null;
        return value > 1e12 ? value : value > 1e9 ? value * 1000 : value;
    }
    const s = String(value).trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return parseStDate(Number(s));
    let m = HUMANIZED.exec(s);
    if (m) return wallClock([+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || 0)], reader);
    m = MERIDIEM.exec(s);
    if (m) {
        const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
        if (month === -1) return null;
        const hour = (+m[4] % 12) + (m[7].toLowerCase() === 'pm' ? 12 : 0);
        return wallClock([+m[3], month, +m[2], hour, +m[5], +(m[6] || 0), 0], reader);
    }
    m = ISO_LOCAL.exec(s);
    if (m) {
        const f = [+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), +(m[7] || '0').slice(0, 3).padEnd(3, '0')];
        if (f[1] > 11 || f[2] < 1 || f[2] > 31 || f[3] > 24 || f[4] > 59 || f[5] > 59) return null;
        return wallClock(f, reader);
    }
    // the engine wants a space before a meridiem
    const t = Date.parse(s.replace(/(\d)(am|pm)$/i, '$1 $2'));
    return Number.isFinite(t) ? t : null;
}
