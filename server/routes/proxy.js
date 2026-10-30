import express, { Router } from 'express';
import { guardedFetch, readBodyCapped, RELAY_MAX_BYTES } from '../lib/net-guard.js';
import { setRelayedType } from '../services/shared.js';

// CORS pass-through, bytes verbatim, mounted before the json parser; every hop through guardedFetch
const TIMEOUT_MS = 60_000;
// the methods a provider API is ever asked with; anything else is refused with the list
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

export const proxyRouter = Router();

proxyRouter.use(express.raw({ type: () => true, limit: '100mb' }), async (req, res) => {
    if (!METHODS.includes(req.method)) {
        res.set('Allow', METHODS.join(', '));
        return res.status(405).json({ error: `method not proxied; allowed: ${METHODS.join(', ')}` });
    }
    const raw = req.originalUrl.replace(/^\/api\/proxy\//, '');
    let target;
    try {
        target = new URL(decodeURIComponent(raw));
    } catch {
        return res.status(400).json({ error: 'bad target url' });
    }
    if (!/^https?:$/.test(target.protocol)) return res.status(400).json({ error: 'http(s) targets only' });

    const headers = { 'User-Agent': 'Mozilla/5.0' };
    for (const h of ['accept', 'content-type', 'authorization', 'x-requested-with', 'referer', 'origin']) {
        if (req.headers[h]) headers[h] = req.headers[h];
    }
    // undici decompresses gzip/deflate/br; never advertise zstd (the ST /proxy/ lesson)
    headers['accept-encoding'] = 'gzip, deflate, br';

    // the upstream call ends when the client's does: a browser that navigated away must
    // not keep a 200MB download running on its behalf
    const gone = new AbortController();
    res.on('close', () => { if (!res.writableEnded) gone.abort(); });
    try {
        const init = {
            method: req.method,
            headers,
            signal: AbortSignal.any([gone.signal, AbortSignal.timeout(TIMEOUT_MS)]),
        };
        if (req.method !== 'GET' && req.method !== 'HEAD' && Buffer.isBuffer(req.body) && req.body.length) {
            init.body = req.body;
        }
        const upstream = await guardedFetch(target, init);
        const buf = await readBodyCapped(upstream, RELAY_MAX_BYTES);
        if (!buf) return res.status(502).json({ error: 'response too large' });

        res.status(upstream.status);
        setRelayedType(res, upstream);
        res.send(buf);
    } catch (err) {
        if (gone.signal.aborted) return;
        if (err?.statusCode === 403) return res.status(403).json({ error: err.message });
        res.status(502).json({ error: err.name === 'TimeoutError' ? 'upstream timed out' : err.message });
    }
});
