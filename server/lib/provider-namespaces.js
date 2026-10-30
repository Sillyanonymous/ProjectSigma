import { openServerDb, metaGet, metaSet } from '../db/server-store.js';

// the built-in providers' namespaces in the client manifest's order, a source ahead of its mirror
export const FIRST_PARTY_NAMESPACES = Object.freeze([
    'chub', 'janitorai', 'jannyai', 'chartavern', 'pygmalion',
    'wyvern', 'datacat', 'botbooru',
]);

// providers the app does not ship, whose links still divert to rows so a library or an import of one keeps them
export const RETIRED_NAMESPACES = Object.freeze(['saucepan']);

// namespaces stored as provider_links rows, never in the card: the built-in and retired ones, then
// each one ever registered (the ratchet below)
export const PROVIDER_NAMESPACES = [...FIRST_PARTY_NAMESPACES, ...RETIRED_NAMESPACES];

// one charset for the validator, this guard and the divert matcher, or a legal namespace writes into the blob
export const NS_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const NS_SEGMENT = '[a-z0-9][a-z0-9_-]{0,31}';
const META_KEY = 'extension_namespaces';

// a namespace once registered diverts forever, or removing its extension sends link edits into the blob
export function loadPersistedNamespaces() {
    let saved;
    try { saved = JSON.parse(metaGet(openServerDb(), META_KEY) || '[]'); } catch { saved = []; }
    if (!Array.isArray(saved)) saved = [];
    for (const ns of saved) {
        if (NS_RE.test(String(ns)) && !PROVIDER_NAMESPACES.includes(ns)) PROVIDER_NAMESPACES.push(ns);
    }
}

// one link per character: the named source provider wins, else the first namespace in divert order
export function extractProviderLinks(extensions, source = null) {
    const links = [];
    for (const ns of PROVIDER_NAMESPACES) {
        const raw = extensions?.[ns];
        if (!raw || typeof raw !== 'object') continue;
        links.push(buildLinkRow(ns, raw));
    }
    if (links.length <= 1) return links;
    const winner = (source && links.find(l => l.providerId === source)) || links[0];
    return [winner];
}

export function buildLinkRow(ns, raw) {
    const linkedAtMs = raw.linkedAt ? Date.parse(raw.linkedAt) : NaN;
    return {
        providerId: ns,
        externalId: raw.id != null ? String(raw.id) : (raw.fullPath ?? raw.full_path ?? null),
        fullPath: raw.fullPath ?? raw.full_path ?? null,
        pageName: raw.pageName ?? null,
        linkedAt: Number.isFinite(linkedAtMs) ? linkedAtMs : null,
        data: raw,
    };
}

/**
 * A provider extension's namespace joins the divert list at boot; mutated in place since consumers read it at call time.
 * @param {string} ns
 */
export function registerProviderNamespace(ns) {
    if (!NS_RE.test(String(ns))) return false;
    if (!PROVIDER_NAMESPACES.includes(ns)) {
        PROVIDER_NAMESPACES.push(ns);
        try {
            const db = openServerDb();
            const saved = new Set(JSON.parse(metaGet(db, META_KEY) || '[]'));
            saved.add(ns);
            metaSet(db, META_KEY, JSON.stringify([...saved]));
        } catch { /* fs trouble: the in-memory list still diverts this session */ }
    }
    return true;
}
