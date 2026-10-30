// RisuAI Realm, the server half: a download fetched into a stage, so the page never carries a charx
// (some pass 150 MB).
import { realmIdOf } from '../client/realm-id.js';

const DOWNLOAD = 'https://realm.risuai.net/api/v1/download/dynamic/';

// a refusal is a line of JSON: what came instead is read no further than its first few KB
const REFUSAL_TEXT_CAP = 16 * 1024;

async function refusalText(upstream) {
    const reader = upstream.body?.getReader();
    if (!reader) return '';
    const decoder = new TextDecoder();
    let text = '';
    while (text.length < REFUSAL_TEXT_CAP) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    return text.slice(0, REFUSAL_TEXT_CAP);
}

// the Realm refuses in JSON ({ error, message }), a 404 for an id it does not know; what else it
// answers is the file
async function refusalOf(upstream) {
    const text = await refusalText(upstream).catch(() => '');
    let said = '';
    try { said = JSON.parse(text)?.message || ''; } catch { /* not JSON */ }
    return said ? `the Realm says: ${String(said).slice(0, 200)}` : `the Realm answered ${upstream.status}`;
}

export function register(router, ctx) {
    router.post('/stage', async (req, res) => {
        const id = realmIdOf(req.body?.id);
        if (!id) return res.status(400).json({ error: 'a Realm character id is a uuid' });
        // a page that leaves mid-download stops it, and the stage it was filling goes with it
        const hangUp = new AbortController();
        res.once('close', () => { if (!res.writableEnded) hangUp.abort(); });
        try {
            const upstream = await ctx.helpers.sameHostFetch(`${DOWNLOAD}${id}?cors=true`, {
                headers: { 'x-risu-api-version': '4' },
                signal: hangUp.signal,
            });
            if (!upstream.ok || /json/i.test(upstream.headers.get('content-type') || '')) {
                return res.status(upstream.status === 404 ? 404 : 502).json({ error: await refusalOf(upstream) });
            }
            res.json(await ctx.imports.stage(req, upstream.body, { name: `${id}.charx` }));
        } catch (e) {
            if (hangUp.signal.aborted) return;
            // a stage refusal carries its status; anything else is the way to the Realm failing
            if (e?.statusCode) return res.status(e.statusCode).json({ error: e.message });
            res.status(502).json({ error: `the Realm could not be reached: ${e?.message || e}` });
        }
    });
}
