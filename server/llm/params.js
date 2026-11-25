// The neutral parameter vocabulary. only what the caller set is sent, so an absent param never trips a picky upstream

import { badRequest } from './errors.js';

const NEUTRAL_PARAMS = ['temperature', 'topP', 'topK', 'maxTokens', 'stop',
    'presencePenalty', 'frequencyPenalty', 'seed', 'reasoning', 'json'];

// an effort is the host's own word, sent as-is: hosts name levels differently (none, minimal, xhigh, max), so only the shape is checked
const EFFORT_WORD = /^[a-z0-9_-]{1,32}$/;

const NUMERIC = new Set(['temperature', 'topP', 'topK', 'maxTokens', 'presencePenalty', 'frequencyPenalty', 'seed']);

// body params + the flat fields -> one neutral params object; an unknown key is a 400, typos never vanish
export function normalizeParams(body) {
    const params = {};
    const src = body?.params && typeof body.params === 'object' ? body.params : {};
    for (const [key, value] of Object.entries(src)) {
        if (!NEUTRAL_PARAMS.includes(key)) throw badRequest(`unknown param '${key}'; valid: ${NEUTRAL_PARAMS.join(', ')}`);
        if (value === undefined || value === null) continue;
        params[key] = value;
    }
    // the flat temperature and maxTokens the spec accepts beside params, a caller's shorthand; params win
    if (body?.temperature !== undefined && params.temperature === undefined) params.temperature = body.temperature;
    if (body?.maxTokens !== undefined && params.maxTokens === undefined) params.maxTokens = body.maxTokens;

    for (const key of Object.keys(params)) {
        if (NUMERIC.has(key) && typeof params[key] !== 'number') {
            throw badRequest(`param '${key}' must be a number`);
        }
    }
    if (params.stop !== undefined && !(Array.isArray(params.stop) && params.stop.every(s => typeof s === 'string'))) throw badRequest("param 'stop' must be an array of strings");
    if (params.json !== undefined && typeof params.json !== 'boolean') throw badRequest("param 'json' must be a boolean");
    if (params.reasoning !== undefined) {
        const effort = params.reasoning?.effort;
        if (typeof effort !== 'string' || !EFFORT_WORD.test(effort)) throw badRequest("param 'reasoning.effort' must be one word of 1 to 32 lowercase letters, digits, _ or -");
    }
    return params;
}

// Profile defaults under request params; both already neutral-shaped.
export function mergeParams(profileDefaults, requestParams) {
    const merged = {};
    for (const src of [profileDefaults, requestParams]) {
        for (const [k, v] of Object.entries(src || {})) {
            if (NEUTRAL_PARAMS.includes(k) && v !== undefined && v !== null) merged[k] = v;
        }
    }
    return merged;
}

/** Apply an adapter's table (name -> wire name, or (value, wireBody) => void); a missing entry is dropped. */
export function translateParams(params, table, wireBody, { debug = null } = {}) {
    for (const [key, value] of Object.entries(params)) {
        const rule = table[key];
        if (rule === undefined) {
            debug?.(`[llm] param '${key}' unsupported on this kind; dropped`);
            continue;
        }
        if (typeof rule === 'function') rule(value, wireBody);
        else wireBody[rule] = value;
    }
    return wireBody;
}
