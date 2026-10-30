// Kind -> adapter registry; nothing else learns provider names. an extension's kinds are the account's

import { openaiAdapter } from './adapters/openai.js';
import { runRegistry } from '../db/hook-seat.js';

const adapters = new Map();

export function registerAdapter(adapter) {
    adapters.set(adapter.kind, adapter);
}

// the kinds the account whose library db is has from its extensions
const accountAdapters = (db) => (db ? runRegistry('llm.adapters', { db }) || [] : []);

/** The adapter for a kind: the app's own, else one an extension serves the account (db). */
export function getAdapter(kind, db = null) {
    return adapters.get(kind) || accountAdapters(db).find(a => a.kind === kind) || null;
}

export function listKinds(db = null) {
    return [...adapters.values(), ...accountAdapters(db)].map(a => ({
        kind: a.kind,
        displayName: a.displayName,
        defaultBaseUrl: a.defaultBaseUrl,
        requiresBaseUrl: !!a.requiresBaseUrl,
        capabilities: a.capabilities,
        ...(a.extension ? { extension: a.extension } : {}),
    }));
}

export function validKinds(db = null) {
    return listKinds(db).map(k => k.kind);
}

registerAdapter(openaiAdapter);
