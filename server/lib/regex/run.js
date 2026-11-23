// The server's regex passes, each under a time budget: a pattern that runs away is stopped, skipped from then on, and named.
import vm from 'node:vm';
import { applyPass, countMatches, runScript, takesPass, namesMacros, PLACE } from './engine.js';

// a text's whole chain gets one budget; a sane chain takes well under a millisecond
const BUDGET_MS = 250;
// what one script may spend over every text of one build, so one slow on each of many texts is stopped too
const BUILD_SCRIPT_MS = 1000;
const realm = vm.createContext({});

// a script stopped for running out of time, per library, by what decides how it runs, until it is saved again
const stoppedBy = new WeakMap();
const keyOf = (s) => `${s.findRegex}\u0000${s.substituteRegex ?? 0}`;
function stoppedIn(db) {
    if (!stoppedBy.has(db)) stoppedBy.set(db, new Map());
    return stoppedBy.get(db);
}
function stop(db, script) {
    stoppedIn(db).set(keyOf(script), { name: script.scriptName || '', at: Date.now() });
    console.warn(`[regex] "${script.scriptName || 'a script'}" ran out of time and is skipped until it is saved again`);
}

// one script over one text under the whole budget: one that runs out alone is stopped and leaves the text as it was
function guarded(db, script, text, ctx, charge) {
    realm.job = () => runScript(script, text, ctx);
    const t = performance.now();
    try {
        return vm.runInContext('job()', realm, { timeout: BUDGET_MS });
    } catch (e) {
        if (e?.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw e;
        stop(db, script);
        return text;
    } finally {
        realm.job = null;
        charge(script, performance.now() - t);
    }
}

/** Whether a script was stopped in this library for taking too long (the window flags it). */
export function isStopped(db, script) {
    return stoppedIn(db).has(keyOf(script));
}

/** Forget a script's stop in this library, as saving it does. */
export function clearStopped(db, script) {
    stoppedIn(db).delete(keyOf(script));
}

/** One build's account of the time each script took, every pass of the build drawing on it. */
export function buildBudget() {
    return new Map();
}

/**
 * A text through one pass, guarded: a script that runs out of time alone is stopped, and the text answers through the rest.
 * @param {object} db the library, whose stopped scripts are skipped
 * @param {{ budget?: Map }} opts the pass's context; budget, a build's account, stops a script slow over the whole build
 * @returns {string}
 */
export function runPass(db, text, scripts, opts) {
    if (typeof text !== 'string' || !text || !Array.isArray(scripts) || !scripts.length) return typeof text === 'string' ? text : '';
    const stopped = stoppedIn(db);
    const live = scripts.filter(s => !stopped.has(keyOf(s)));
    if (!live.length) return text;
    const spent = opts?.budget || null;
    const charge = (s, ms) => { if (spent) spent.set(keyOf(s), (spent.get(keyOf(s)) || 0) + ms); };
    // this chain's own times, charged to the build only when it finishes: a chain that runs out is timed again script by script
    const took = new Map();
    let current = null;
    let mark = 0;
    // the time since a script began is its own, charged when the next one begins or the chain ends
    const begin = (s) => {
        const now = performance.now();
        if (current) took.set(current, (took.get(current) || 0) + now - mark);
        current = s;
        mark = now;
    };
    realm.job = () => {
        const out = applyPass(text, live, { ...opts, onScript: begin });
        begin(null);
        return out;
    };
    let out;
    try {
        out = vm.runInContext('job()', realm, { timeout: BUDGET_MS });
        for (const [s, ms] of took) charge(s, ms);
    } catch (e) {
        if (e?.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT' || !current) throw e;
        // a whole chain past the budget names no culprit (many sane scripts on a slow machine): only a script that runs out alone is stopped
        out = applyPass(text, live, { ...opts, run: (s, input, ctx) => guarded(db, s, input, ctx, charge) });
    } finally {
        realm.job = null;
    }
    const slow = spent && live.find(s => (spent.get(keyOf(s)) || 0) > BUILD_SCRIPT_MS);
    if (!slow) return out;
    stop(db, slow);
    return runPass(db, text, scripts, opts);
}

/**
 * The scripts the page runs itself, tried first on texts it will show, so one that runs away is stopped before it gets there.
 * @param {object} db the library
 * @param {object[]} scripts a chat's active scripts
 * @param {{ text: string, where: number }[]} texts
 * @param {{ user?: string, char?: string }} names the chat's, so a find with macros compiles as the page compiles it
 */
export function tryOnScreen(db, scripts, texts, names) {
    const screen = scripts.filter(s => takesPass(s, 'screen') && !isStopped(db, s));
    if (!screen.length) return;
    const macros = namesMacros(names);
    const budget = buildBudget();
    for (const { text, where } of texts) runPass(db, text, screen, { pass: 'screen', where, macros, budget });
}

/**
 * One script alone over a sample, for the window's tester: both read passes and what a save would leave, each guarded.
 * @returns {{ screen: string, prompt: string, saved: string, matches: number, error: string|null }}
 */
export function testScript(script, text, { where = PLACE.aiOutput, depth, macros, charName } = {}) {
    const one = [{ ...script, disabled: false }];
    const out = { screen: text, prompt: text, saved: text, matches: 0, error: null };
    realm.job = () => {
        const matches = countMatches(one[0], text, { macros });
        // a find that does not compile is named, never answered as a count of -1
        out.matches = Math.max(matches, 0);
        if (matches < 0) out.error = 'invalid';
        out.screen = applyPass(text, one, { pass: 'screen', where, depth, macros, charName });
        out.prompt = applyPass(text, one, { pass: 'prompt', where, depth, macros });
        out.saved = applyPass(text, [{ ...one[0], alterSaved: true }], { pass: 'save', where, macros });
    };
    try {
        vm.runInContext('job()', realm, { timeout: BUDGET_MS });
    } catch (e) {
        out.error = e?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'timeout' : String(e?.message || e);
    } finally {
        realm.job = null;
    }
    return out;
}
