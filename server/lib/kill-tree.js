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
