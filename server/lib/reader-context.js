// The reader's clock and device for the macros and a message's time; work with no request behind it reads the server's clock
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();
const MOBILE_UA = /Mobi|Android|iPhone|iPad|iPod|Tablet|Silk|Kindle|Opera Mini|IEMobile/i;
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

/** The reader of a request: X-UTC-Offset (minutes east of UTC, as the client's clock reads), X-Time-Zone (its IANA zone) and its User-Agent. */
export function readerOf(req) {
    const raw = req.headers['x-utc-offset'];
    const offset = typeof raw === 'string' && /^-?\d{1,4}$/.test(raw.trim()) ? Number(raw) : NaN;
    const zone = typeof req.headers['x-time-zone'] === 'string' ? req.headers['x-time-zone'].trim() : '';
    return {
        utcOffset: Number.isFinite(offset) && Math.abs(offset) <= 18 * 60 ? offset : null,
        zone: ZONE_NAME.test(zone) ? zone : null,
        mobile: MOBILE_UA.test(String(req.headers['user-agent'] || '')),
    };
}

export function runWithReader(reader, fn) {
    return store.run(reader, fn);
}

/** The reader of the request being served, or none: { utcOffset: null, zone: null (the server's clock), mobile: false }. */
export function readerContext() {
    return store.getStore() || { utcOffset: null, zone: null, mobile: false };
}
