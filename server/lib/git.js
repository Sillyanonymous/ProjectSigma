// The one git runner: the extension installs and the app's own updates call git through here
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const GIT_TIMEOUT_MS = 120000;

/** Run git with prompts off: a repository asking for a sign-in fails at once, never a prompt on the server's desktop. */
export const runGit = (args) => execFileP('git', args, { timeout: GIT_TIMEOUT_MS, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });

/** git's own words for a failure, without the command line or its hints. */
export function gitWords(e) {
    const lines = String(e?.stderr || e?.message || e).split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^hint:/.test(l) && !/^Command failed:/.test(l));
    return lines.join(' ') || 'git failed';
}

/** A git call's output, trimmed. */
export const gitOut = async (args) => String((await runGit(args)).stdout).trim();

// one git call at a time per repository: a check and an update never touch one together
const _repoLocks = new Map();
/** Run fn once the last call queued for this repository has ended, whatever it answered. */
export function withRepo(key, fn) {
    const run = (_repoLocks.get(key) || Promise.resolve()).then(fn, fn);
    _repoLocks.set(key, run.catch(() => { /* the caller hears the failure; the next in line only waits for it */ }));
    return run;
}
