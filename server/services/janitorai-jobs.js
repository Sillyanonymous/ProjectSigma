// The extraction lane: one job per browser endpoint, since every run drives the same browser and account. In memory only.

const lanes = new Map(); // endpoint -> { running: job | null, queue: job[] }
let seq = 0;

class LaneAbandoned extends Error {
    constructor() { super('The request left the queue before its turn'); this.abandoned = true; }
}

function laneOf(key) {
    let lane = lanes.get(key);
    if (!lane) { lane = { running: null, queue: [] }; lanes.set(key, lane); }
    return lane;
}

const isAbandoned = (job) => { try { return !!job.abandoned?.(); } catch { return false; } };

const view = (job, status, position) => ({
    id: job.id, characterId: job.characterId, kind: job.kind, status, position,
    queuedAt: job.queuedAt, startedAt: job.startedAt,
});

/**
 * Run fn once the lane is free; a caller that hung up while waiting never runs (the account is not touched for nobody).
 * @param {string} key the resolved browser endpoint
 * @param {{characterId: string, kind: 'extract'|'recover', user: string, abandoned?: () => boolean}} meta
 * @param {() => Promise<any>} fn
 */
export function runOnLane(key, meta, fn) {
    const lane = laneOf(key);
    return new Promise((resolve, reject) => {
        lane.queue.push({ ...meta, id: ++seq, queuedAt: Date.now(), startedAt: null, fn, resolve, reject });
        pump(key);
    });
}

function pump(key) {
    const lane = lanes.get(key);
    if (!lane || lane.running) return;
    while (lane.queue.length) {
        const job = lane.queue.shift();
        if (isAbandoned(job)) { job.reject(new LaneAbandoned()); continue; }
        lane.running = job;
        job.startedAt = Date.now();
        Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => {
            lane.running = null;
            if (!lane.queue.length) lanes.delete(key);
            pump(key);
        });
        return;
    }
    lanes.delete(key);
}

/**
 * One account's jobs on any lane: running first, then queued with positions (1 = next); an abandoned one is not listed.
 */
export function laneStatus(user) {
    const out = [];
    for (const lane of lanes.values()) {
        if (lane.running && lane.running.user === user) out.push(view(lane.running, 'running', 0));
        let position = 0;
        for (const job of lane.queue) {
            if (isAbandoned(job)) continue;
            position++;
            if (job.user === user) out.push(view(job, 'queued', position));
        }
    }
    return out;
}

/** Test seam: forget every lane. */
export function resetLanes() {
    lanes.clear();
}
