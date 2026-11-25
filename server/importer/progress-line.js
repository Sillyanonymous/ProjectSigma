// The migration tool's progress as data: one marked line per record on its output, which the wizard's route reads

const PROGRESS_MARK = '@@progress ';

/** @param {{ step: string, label: string, done: number, total: number, unit: string }} record */
export function progressLine(record) {
    return `${PROGRESS_MARK}${JSON.stringify(record)}`;
}

/** The record a marked line carries, or null for a human line. */
export function parseProgressLine(line) {
    if (typeof line !== 'string' || !line.startsWith(PROGRESS_MARK)) return null;
    try {
        const r = JSON.parse(line.slice(PROGRESS_MARK.length));
        return r && typeof r === 'object' && typeof r.step === 'string' && Number.isFinite(r.done) && Number.isFinite(r.total) ? r : null;
    } catch { return null; }
}

/** A step's first and last records pass, and between them at most one per interval, so a bar moves without flooding the pipe. */
export function progressReporter(write, { interval = 250, now = Date.now } = {}) {
    const last = new Map();
    return (record) => {
        const t = now();
        const prev = last.get(record.step);
        if (prev !== undefined && record.done > 0 && record.done < record.total && t - prev < interval) return;
        last.set(record.step, t);
        write(record);
    };
}
