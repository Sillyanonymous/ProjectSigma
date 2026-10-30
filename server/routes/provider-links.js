import { Router } from 'express';
import { probeProviderLinks, probeProviderLinkOwners } from '../db/characters-store.js';
import { PROBE_MAX_KEYS } from '../lib/query-params.js';

// "which of my characters is this remote card?", probed per page by a browse view
export const providerLinksRouter = Router();

// the badge probe: a capped list of keys in, the linked subset out
const PROBE_MAX_PROVIDERS = 20;
providerLinksRouter.post('/probe', (req, res) => {
    const body = req.body || {};
    const providers = Array.isArray(body.providers) ? body.providers : (typeof body.provider === 'string' ? [body.provider] : null);
    if (!providers || !providers.length || !providers.every(p => typeof p === 'string' && p.trim())) {
        return res.status(400).json({ error: 'providers: a non-empty array of provider ids (or provider: one id)' });
    }
    if (providers.length > PROBE_MAX_PROVIDERS) return res.status(400).json({ error: `max ${PROBE_MAX_PROVIDERS} providers per probe` });
    const keys = body.keys;
    if (!Array.isArray(keys) || !keys.length || !keys.every(k => typeof k === 'string' || typeof k === 'number')) {
        return res.status(400).json({ error: 'keys: a non-empty array of strings' });
    }
    if (keys.length > PROBE_MAX_KEYS) return res.status(400).json({ error: `max ${PROBE_MAX_KEYS} keys per probe` });
    for (const flag of ['owners', 'loose']) {
        if (body[flag] !== undefined && typeof body[flag] !== 'boolean') return res.status(400).json({ error: `${flag}: a boolean` });
    }
    if (body.loose === true && body.owners !== true) return res.status(400).json({ error: 'loose needs owners: true' });
    const found = probeProviderLinks(req.db, { providers, keys });
    if (body.owners !== true) return res.json({ found });
    // the import duplicate check: the rows behind the keys, resolved to characters client-side
    res.json({ found, owners: probeProviderLinkOwners(req.db, { providers, keys, loose: body.loose === true }) });
});
