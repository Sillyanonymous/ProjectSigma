// the seat the extension pipelines take; while its empty a runHook call answers its value untouched

let _runner = null;

/** Fill the seat: fn(name, value, info) answers the value to use. null empties it. */
export function setHookRunner(fn) {
    _runner = typeof fn === 'function' ? fn : null;
}

/**
 * Pass a value through the filters registered for name, for the account whose library info.db is.
 * @param {string} name the hook, e.g. 'card.import'
 * @param {*} value what the site produced
 * @param {{ db: object }} info the handle, plus the site's facts
 * @returns {*} the value to use
 */
export function runHook(name, value, info) {
    return _runner ? _runner(name, value, info) : value;
}

let _registries = null;

/** Fill the registries' seat: fn(name, info) answers what they contribute. null empties it. */
export function setRegistryRunner(fn) {
    _registries = typeof fn === 'function' ? fn : null;
}

/**
 * What the extensions registered under name (e.g. 'macros') contribute for the account whose
 * library info.db is; null while nothing is registered at all.
 */
export function runRegistry(name, info) {
    return _registries ? _registries(name, info) : null;
}
