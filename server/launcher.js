// Runs the server, starting it again when an update asks; it never loads the database driver, so an install can replace it
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import tty from 'node:tty';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The exit code a server uses to ask for a start on the new code. */
export const RESTART_EXIT_CODE = 75;
// a start that ends sooner than this after an update is read as the update's failure, unless the reader stopped it
const FAILED_START_MS = 60000;
const OPEN_TRIES = 240;
const OPEN_EVERY_MS = 500;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LTS_HINT = 'Install the LTS version from https://nodejs.org, then run this again.';
// each argument its own line, the way the launchers' echo lines read
const say = (...lines) => { for (const line of lines) console.log(line); };

// ========================================
// NODE
// ========================================

/** Why this Node cannot run the app, or null: too old, or a preview build no driver ships for. */
export function nodeProblem(full = process.version) {
    const [major, minor] = full.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    if (major < 22 || (major === 22 && minor < 15)) return `Project Sigma needs Node.js 22.15 or newer; this computer has ${full}.`;
    if (full.includes('-')) return `This computer has a preview build of Node.js (${full}); the database driver has no ready-made build for one.`;
    return null;
}

// ========================================
// INSTALL
// ========================================

const lockHash = (root) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'package-lock.json'))).digest('hex');
const markFile = (root) => path.join(root, 'node_modules', '.sigma-installed');

/** Whether the installed packages are not the ones package-lock.json names (a first run, or an update that changed it). */
export function installNeeded(root = ROOT) {
    let marked = '';
    try { marked = fs.readFileSync(markFile(root), 'utf8'); } catch { /* never installed */ }
    return marked !== lockHash(root);
}

/**
 * Install what package-lock.json names, check that the two native packages load, then mark the install done.
 * @returns {boolean} whether it landed; on a failure the lines above it say why
 */
export function install(root = ROOT, { run = spawnSync, log = say, platform = process.platform } = {}) {
    log('Installing what Project Sigma needs. The first time takes a minute or two.');
    const args = ['ci', '--no-audit', '--no-fund'];
    // sharp has no native build for Android, so there npm takes its WebAssembly build from the lockfile
    if (platform === 'android') args.push('--cpu=wasm32');
    const npm = run('npm', args, { cwd: root, stdio: 'inherit', shell: platform === 'win32', windowsHide: true });
    // off Windows npm runs without a shell, so a missing npm prints nothing of its own
    if (npm.error?.code === 'ENOENT') { log('', 'npm was not found. Install it with Node.js (the LTS version from https://nodejs.org) or through your package manager, then start Project Sigma again.'); return false; }
    // npm that could not start or was stopped (a signal, a phone's out-of-memory killer) printed no lines of its own either
    if (npm.error || npm.status === null) { log('', `npm did not finish${npm.signal ? ` (stopped by ${npm.signal})` : ''}${npm.error ? `: ${npm.error.message}` : ''}. Start Project Sigma again to retry the install.`); return false; }
    if (npm.status !== 0) {
        log('', 'The install failed; the lines above say why.');
        if (!process.release?.lts) log(`This computer runs Node.js ${process.version}, which is not an LTS release. ${LTS_HINT}`);
        return false;
    }
    const loads = (code) => run(process.execPath, ['-e', code], { cwd: root, stdio: 'ignore', windowsHide: true }).status === 0;
    if (!loads("new (require('better-sqlite3'))(':memory:').close()")) {
        log('', 'The install finished, but the database driver did not build.', 'Run "npm rebuild better-sqlite3" in this folder and read what it says.');
        return false;
    }
    if (!loads("require('sharp')")) {
        log('', 'The install finished, but the image library (sharp) did not load.', 'Run node -e "require(\'sharp\')" in this folder and read what it says.');
        return false;
    }
    fs.writeFileSync(markFile(root), lockHash(root));
    return true;
}

/**
 * Install when package-lock.json asks for it.
 * @param {object} deps what install takes
 * @returns {boolean} false when an install was needed and failed
 */
export function installIfNeeded(root = ROOT, deps = {}) {
    return !installNeeded(root) || install(root, deps);
}

// ========================================
// THE HOSTED BROWSER ON ANDROID
// ========================================

// the Termux packages that bring Chromium, the browser JanitorAI and JannyAI go through, in install order
const TERMUX_BROWSER_STEPS = Object.freeze([
    { pkg: 'x11-repo', says: 'adding the package list that has Chromium' },
    { pkg: 'chromium', says: 'installing Chromium (the big download)' },
]);
/** The two Termux lines that install Chromium, as a reader types them. */
export const TERMUX_BROWSER_INSTALL = Object.freeze(TERMUX_BROWSER_STEPS.map(s => `pkg install ${s.pkg}`));
const BY_HAND = TERMUX_BROWSER_INSTALL.map(line => `  ${line}`);
// spelled as the browser service spells it, since the launcher loads no server module before its install
const TERMUX_PREFIX = '/data/data/com.termux/files/usr';

/** On Android with no browser the server would find, the lines naming how to install one; empty otherwise. */
export function termuxBrowserHint(platform = process.platform, env = process.env, exists = fs.existsSync) {
    if (platform !== 'android') return [];
    const chromium = path.join(env.PREFIX || TERMUX_PREFIX, 'bin', 'chromium-browser');
    if ([env.CL_BROWSER, chromium].some(p => p && exists(p))) return [];
    return ['', 'JanitorAI and JannyAI need Chromium, a browser Project Sigma runs hidden inside Termux (about 1 GB);',
        'everything else works without it. To add it, run these two lines in Termux:', ...BY_HAND];
}

// in the data folder: the reader answered no, so the start never asks again
const TERMUX_BROWSER_DECLINED = '.termux-browser-declined';

// y or yes, n or no, any case; anything else, an empty line included, is "not now"
const isYes = (answer) => /^\s*y(es)?\s*$/i.test(String(answer ?? ''));
const isNo = (answer) => /^\s*no?\s*$/i.test(String(answer ?? ''));

// one line from the terminal; Ctrl+C answers null (stop), Ctrl+D or a closed input an empty line ("not now")
function askLine(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        let settled = false;
        const end = (answer) => { if (!settled) { settled = true; rl.close(); resolve(answer); } };
        rl.on('SIGINT', () => { process.stdout.write('\n'); end(null); });
        // the input ended (Ctrl+D) with the question line still open
        rl.on('close', () => { if (!settled) process.stdout.write('\n'); end(''); });
        rl.question(question, (answer) => end(answer));
    });
}

// a kept answer: an empty file, its folder made if missing
function keepFile(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
}

// asked by file descriptor, so a start off Android never opens process.stdin before the server inherits it
const atTerminal = () => tty.isatty(0) && tty.isatty(1);

/**
 * Before the server starts, on Android with no browser: asks at a terminal to install one (y yes, n never again, else next start).
 * @param {string} dataDir where a no is kept
 * @param {object} deps platform, env, exists, terminal, ask, run, log and write stood in by the tests
 * @returns {Promise<'none'|'declined'|'skipped'|'printed'|'installed'|'failed'|'stop'>} 'stop' when Ctrl+C answered or ended the install
 */
export async function offerTermuxBrowser(dataDir, { platform = process.platform, env = process.env, exists = fs.existsSync, terminal = null, ask = askLine, run = spawnSync, log = say, write = keepFile } = {}) {
    const hint = termuxBrowserHint(platform, env, exists);
    if (!hint.length) return 'none';
    const declined = path.join(dataDir, TERMUX_BROWSER_DECLINED);
    if (exists(declined)) return 'declined';
    if (!(terminal ?? atTerminal())) { log(...hint); return 'printed'; }
    log('', 'JanitorAI and JannyAI need Chromium, a browser Project Sigma runs hidden inside Termux',
        '(the browser app you already use cannot do this). Everything else works without it.',
        'It downloads about 230 MB (Wi-Fi is best), takes about 1 GB of space and a few minutes.');
    const answer = await ask('Install it now? Type y and press Enter to install, n to never be asked again, or just press Enter to skip for now: ');
    if (answer === null) return 'stop';
    if (isNo(answer)) {
        let kept = true;
        try { write(declined); } catch { kept = false; }
        log(kept ? 'Skipped, and Project Sigma will not ask again.' : 'Skipped. Project Sigma could not save that answer, so it asks again the next time it starts.',
            'To add it later, stop Project Sigma (Ctrl+C), run these two lines, then start it again:',
            ...BY_HAND, 'The user guide has the steps under "JanitorAI and JannyAI on an Android phone".');
        return kept ? 'declined' : 'skipped';
    }
    if (!isYes(answer)) {
        log('Skipped for now; Project Sigma asks again the next time it starts.');
        return 'skipped';
    }
    log('', 'Installing Chromium. Termux prints a lot of lines for a few minutes; keep it open.');
    for (const [i, step] of TERMUX_BROWSER_STEPS.entries()) {
        log(`Step ${i + 1} of ${TERMUX_BROWSER_STEPS.length}: ${step.says}`);
        const done = run('pkg', ['install', '-y', step.pkg], { stdio: 'inherit' });
        // Ctrl+C during the install stops the start too, as it would at the question (a script may exit 130 on it)
        if (done.signal === 'SIGINT' || done.status === 130) return 'stop';
        if (done.status !== 0) {
            log('', 'Chromium did not install; the lines above say why (most often no internet, or not enough free space).',
                'Project Sigma starts now without it. To try again, stop it (Ctrl+C) and run:', ...BY_HAND, 'It also offers again the next time it starts.');
            return 'failed';
        }
    }
    log('', 'Chromium is installed. Starting Project Sigma.');
    return 'installed';
}

// ========================================
// BROWSER
// ========================================

/** The command that opens a url where there is a desktop to open it on, or null. */
export function browserOpener(platform = process.platform, env = process.env) {
    if (platform === 'win32') return { cmd: 'rundll32', args: (url) => ['url.dll,FileProtocolHandler', url] };
    if (platform === 'darwin') return { cmd: 'open', args: (url) => [url] };
    if (platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY)) return { cmd: 'xdg-open', args: (url) => [url] };
    return null;
}

/** Open the app once the server answers, unless openBrowser in server.yaml or CL_OPEN_BROWSER says not to. */
export async function openWhenServing({ config, opener, open = (cmd, args) => execFile(cmd, args, { windowsHide: true }), fetchFn = fetch, tries = OPEN_TRIES, everyMs = OPEN_EVERY_MS, signal = null } = {}) {
    if (!config?.openBrowser || !opener) return false;
    const url = `http://localhost:${config.port}/`;
    for (let i = 0; i < tries && !signal?.aborted; i++) {
        try {
            if ((await fetchFn(`${url}api/health`, { signal })).ok && !signal?.aborted) { open(opener.cmd, opener.args(url)); return true; }
        } catch { /* not up yet, or told to stop */ }
        if (signal?.aborted) break;
        await new Promise((resolve) => {
            const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
            const timer = setTimeout(done, everyMs);
            signal?.addEventListener('abort', done, { once: true });
        });
    }
    return false;
}

// ========================================
// AFTER A FAILED UPDATE
// ========================================

/** The way back after an update whose server would not start, from the record the update wrote. */
export function goBackSteps(dataDir) {
    let record = null;
    try { record = JSON.parse(fs.readFileSync(path.join(dataDir, 'update.json'), 'utf8')).lastUpdate; } catch { /* no record */ }
    if (!record?.from) return ['Project Sigma stopped soon after an update; the lines above say why.'];
    const lines = [
        `Project Sigma stopped soon after updating from v${record.fromVersion} to v${record.toVersion}; the lines above say why.`,
        `To go back to v${record.fromVersion}:`,
        `  1. In this folder run: git reset --hard ${record.from}`,
    ];
    const backups = Array.isArray(record.backups) ? record.backups : [];
    if (backups.length) {
        lines.push('  2. Put back the backup taken before the update, for each account (the guide\'s "Restoring a backup" has the steps):');
        for (const b of backups) lines.push(`       ${path.join(dataDir, b.handle, 'backups', b.file)}`);
    } else {
        lines.push('     No backup was taken before this update, so a library the new version changed cannot be put back as it was.');
    }
    lines.push(`  ${backups.length ? 3 : 2}. Start Project Sigma again.`);
    return lines;
}

// ========================================
// THE LOOP
// ========================================

/**
 * Start the server, and again each time it exits asking for a restart; any other exit ends the loop with its code.
 * @param {object} deps runServer() resolves the exit code; installIfNeeded() answers false when an install failed; stopped() answers true once the reader stopped it
 * @returns {Promise<number>} the code to exit with
 */
export async function supervise({ runServer, installIfNeeded = () => true, onFailedStart = () => {}, log = say, now = Date.now, stopped = () => false }) {
    let afterUpdate = false;
    for (;;) {
        const started = now();
        const code = await runServer({ afterUpdate });
        if (code === RESTART_EXIT_CODE) {
            log('', 'Restarting Project Sigma on the new version.');
            if (!installIfNeeded()) { onFailedStart(); return 1; }
            afterUpdate = true;
            continue;
        }
        if (afterUpdate && code !== 0 && !stopped() && now() - started < FAILED_START_MS) onFailedStart();
        return code;
    }
}

// the reader stopping it (Ctrl+C, a closed terminal, a kill passed on) is never a failed update
let stopAsked = false;

// a child per start, the console shared; Ctrl+C reaches both, so the launcher only waits for the server's own exit
function runServerChild(root) {
    // a stop belongs to the run it ended: one an earlier run swallowed never hides this run's failure
    stopAsked = false;
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], { cwd: root, stdio: 'inherit', env: { ...process.env, SIGMA_LAUNCHER: '1' } });
        const forward = (sig) => () => { stopAsked = true; try { child.kill(sig); } catch { /* gone */ } };
        const onTerm = forward('SIGTERM');
        const onHup = forward('SIGHUP');
        process.on('SIGTERM', onTerm);
        process.on('SIGHUP', onHup);
        child.on('exit', (code, signal) => {
            process.off('SIGTERM', onTerm);
            process.off('SIGHUP', onHup);
            resolve(code ?? (signal ? 1 : 0));
        });
    });
}

async function main() {
    const problem = nodeProblem();
    if (problem) { say(problem, LTS_HINT); return 1; }
    if (!installIfNeeded()) return 1;
    // read after the install, which brings the yaml reader; a settings file the server refuses is the server's to name
    let config = null;
    try { ({ config } = await import(pathToFileURL(path.join(ROOT, 'server', 'config.js')).href)); } catch { /* the server says why */ }
    const opening = new AbortController();
    void openWhenServing({ config, opener: browserOpener(), signal: opening.signal });
    process.on('SIGINT', () => { stopAsked = true; /* the server hears Ctrl+C too; its exit ends the loop */ });
    try {
        const dataDir = config?.dataDir ?? path.resolve(process.env.CL_DATA_DIR || path.join(ROOT, 'data'));
        if ((await offerTermuxBrowser(dataDir)) === 'stop') return 130;
        return await supervise({
            runServer: () => runServerChild(ROOT),
            installIfNeeded: () => installIfNeeded(),
            onFailedStart: () => say('', ...goBackSteps(dataDir)),
            stopped: () => stopAsked,
        });
    } finally {
        // an opener still waiting on a server that is gone would hold the launcher open
        opening.abort();
    }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) process.exitCode = await main();
