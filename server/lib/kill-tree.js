// A child process stopped with everything it started: the managed browser, the migration's CLI.

import { spawnSync } from 'node:child_process';

/**
 * Stop a child with its tree. proc.kill() on Windows ends one pid, so taskkill /T there.
 * @param {import('node:child_process').ChildProcess} proc
 * @param {string} [signal] the signal off Windows (SIGTERM when absent)
 */
export function killTree(proc, signal) {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    try {
        if (process.platform === 'win32' && proc.pid) spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
        else proc.kill(signal);
    } catch { /* already gone */ }
}

/** Run stop when the server ends (exit, SIGTERM, SIGINT); a signal is raised again after it, so it still ends the process. */
export function onServerExit(stop) {
    process.once('exit', stop);
    for (const signal of ['SIGTERM', 'SIGINT']) {
        process.once(signal, () => {
            stop();
            if (!process.listenerCount(signal)) process.kill(process.pid, signal);
        });
    }
}
