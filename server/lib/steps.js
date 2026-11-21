// Work that runs long, written as steps: the event loop handed back between them, and stopped once no one waits
import { closeSignal } from './request-guard.js';

// how much of a step generator runs before the loop is handed back
export const STEP_SLICE_MS = 10;

/** One turn of the event loop: whatever waits (a request, a hang-up) runs before the caller goes on. */
export const nextTurn = () => new Promise(resolve => setImmediate(resolve));

/** Run a step generator to its end at once, for a caller that wants the whole answer now. */
export function finishSteps(steps) {
    let step;
    do step = steps.next(); while (!step.done);
    return step.value;
}

/**
 * Run a step generator, the loop handed back each slice; an aborted signal or a false alive() stops it at its next step.
 * @param {{ signal?: AbortSignal|null, sliceMs?: number, alive?: (() => boolean)|null }} [how]
 * @returns {Promise<*>} the generator's answer, or null when it was stopped (the caller tells the two apart by its signal)
 */
export async function runSteps(steps, { signal = null, sliceMs = STEP_SLICE_MS, alive = null } = {}) {
    let mark = performance.now();
    for (;;) {
        if (signal?.aborted || (alive && !alive())) {
            steps.return();
            return null;
        }
        const step = steps.next();
        if (step.done) return step.value;
        if (performance.now() - mark >= sliceMs) {
            await nextTurn();
            mark = performance.now();
        }
    }
}

/**
 * A route's steps, a slice at a time, stopped when its caller hangs up or its library closes.
 * @returns {Promise<{ gone: boolean, value: * }>} gone: nobody waits for an answer; value: the steps' answer, null if stopped
 */
export async function runRequestSteps(req, res, steps) {
    const signal = closeSignal(res);
    const value = await runSteps(steps, { signal, alive: () => req.db.open });
    return { gone: signal.aborted, value };
}

const _jobs = new WeakMap();

// a job failing again and again waits twice as long each time, up to this
const RETRY_MAX_MS = 600000;

/**
 * A library's background job after a wait, one per library and name: a call while it waits joins it, one while it runs reruns it.
 * @param {() => any} run its promise is awaited; a failure is logged and tried again after retryMs, doubling to ten minutes
 */
export function scheduleLibraryJob(db, name, run, { wait = 1500, retryMs = 30000 } = {}) {
    let jobs = _jobs.get(db);
    if (!jobs) _jobs.set(db, jobs = new Map());
    let job = jobs.get(name);
    if (!job) jobs.set(name, job = { timer: null, running: false, again: false, failures: 0 });
    if (job.running) { job.again = true; return; }
    if (job.timer || !db.open) return;
    const fire = (delay) => {
        job.timer = setTimeout(async () => {
            job.timer = null;
            if (!db.open) return;
            job.running = true;
            let failed = false;
            try { await run(); job.failures = 0; } catch (e) { failed = true; job.failures++; console.error(`[${name}] the background job failed:`, e.message); }
            job.running = false;
            if (failed) fire(Math.min(RETRY_MAX_MS, retryMs * 2 ** (job.failures - 1)));
            else if (job.again) { job.again = false; fire(wait); }
        }, delay);
        job.timer.unref?.();
    };
    fire(wait);
}
