// The app's own updates: which kind of install this is, what GitHub holds beyond it, and the update of a git clone
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { runGit, gitOut, gitWords, withRepo } from './git.js';
import { writeFileAtomic } from './atomic-write.js';
import { readJsonFile } from './json-file.js';
import { readJsonCapped } from './net-guard.js';
import { httpError } from './http-error.js';
import { emitChange } from '../db/changes.js';
import { forEachOpenLibrary, openDb } from '../db/database.js';
import { openServerDb, accountHandles, forEachAccountLibrary } from '../db/server-store.js';
import { takeBackup, backupsBusy, backupJobView } from './backup-core.js';
import { setJobsBusy } from './set-jobs.js';
import { listJobs } from './ext-jobs.js';
import { RESTART_EXIT_CODE } from '../launcher.js';
const REPO_KEY = 'app';
const RELEASE_TIMEOUT_MS = 15000;
// enough for an install a year behind; older releases' notes are a click away on GitHub
const RELEASES_PAGE = 30;
// long enough for the feed to carry "restarting" to the open tabs before the socket drops
const RESTART_DELAY_MS = 500;

const readPackage = (root) => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// the version this process runs, which a merge without a restart leaves behind the files on disk
const RUNNING_VERSION = readPackage(config.projectRoot).version;

// ========================================
// SOURCES
// ========================================

/** The repository's owner/name on GitHub, from package.json's repository url. */
export function repoSlug(root = config.projectRoot) {
    const url = String(readPackage(root).repository?.url || '');
    const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    return m ? `${m[1]}/${m[2]}` : null;
}

/** The repository's published releases, newest first (drafts and prereleases left out). */
async function githubReleases(slug) {
    const url = `https://api.github.com/repos/${slug}/releases?per_page=${RELEASES_PAGE}`;
    const resp = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'project-sigma' }, signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS) });
    if (resp.status === 404) return [];
    if (!resp.ok) throw new Error(`GitHub answered ${resp.status}`);
    const list = await readJsonCapped(resp);
    return (Array.isArray(list) ? list : []).filter(r => r && !r.draft && !r.prerelease)
        .map(r => ({ version: String(r.tag_name || '').replace(/^v/i, ''), notes: String(r.body || ''), url: r.html_url || null, publishedAt: r.published_at || null }));
}

const container = () => fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');

const DEFAULT_SOURCES = Object.freeze({
    root: () => config.projectRoot,
    releases: githubReleases,
    container,
    launcher: () => process.env.SIGMA_LAUNCHER === '1',
    exit: (code) => process.exit(code),
});
let _sources = DEFAULT_SOURCES;

/** Stand in any of root, releases, container, launcher and exit; returns the call that puts them back. */
export function useUpdateSources(over = {}) {
    const before = _sources;
    _sources = { ...DEFAULT_SOURCES, ...over };
    resetAppUpdate();
    return () => { _sources = before; resetAppUpdate(); };
}

/** git (a clone), docker (a container) or zip (anything else). */
export function installType() {
    if (fs.existsSync(path.join(_sources.root(), '.git'))) return 'git';
    return _sources.container() ? 'docker' : 'zip';
}

/** Whether version a is newer than b, by their first three numbers. */
export function newerVersion(a, b) {
    const parts = (v) => String(v ?? '').split(/[.+-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
}

// ========================================
// STATE
// ========================================

const stateFile = () => path.join(config.dataDir, 'update.json');
const readState = () => { const s = readJsonFile(stateFile()); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; };
const writeState = (patch) => writeFileAtomic(stateFile(), JSON.stringify({ ...readState(), ...patch }, null, 2));

let _check = { checkedAt: null, latest: null, releases: [], git: null, error: null };
let _checking = null;
let _updating = null;
let _starting = false;
let _failed = null;
let _restartNeeded = null;
let _announced = '';
// the accounts the running update backs up, so a tab can follow each copy
let _backingUp = [];

function resetAppUpdate() {
    _check = { checkedAt: null, latest: null, releases: [], git: null, error: null };
    _checking = null; _updating = null; _starting = false; _failed = null; _restartNeeded = null; _announced = ''; _backingUp = [];
}

/** Why a git clone cannot update itself from here, or null. */
function gitRefusal(git) {
    if (!git) return null;
    if (git.blocked) return git.blocked;
    if (git.dirty) return 'the install has local edits to its files (git status lists them); set them aside or update by hand';
    if (git.ahead > 0) return 'the install holds commits its branch on GitHub does not, so it cannot move forward on its own; update by hand';
    return null;
}

/** The last check and what can be done about it, as an admin's tab reads it. */
export function appUpdateState() {
    const type = installType();
    const saved = readState();
    const latest = _check.latest;
    const available = !!latest?.version && newerVersion(latest.version, RUNNING_VERSION);
    return {
        installType: type,
        version: RUNNING_VERSION,
        checkedAt: _check.checkedAt,
        checking: !!_checking,
        error: _check.error,
        latest: latest ? { ...latest } : null,
        releases: (_check.releases || []).map(r => ({ ...r })),
        available,
        skipped: typeof saved.skipped === 'string' ? saved.skipped : null,
        canUpdate: type === 'git' && available && !gitRefusal(_check.git) && !_restartNeeded,
        refusal: type === 'git' ? gitRefusal(_check.git) : null,
        launcher: _sources.launcher(),
        updating: _updating ? { ..._updating, ...(_updating.phase === 'backup' ? { backups: backupProgress() } : {}) } : null,
        failed: _failed,
        restartNeeded: _restartNeeded ? { ..._restartNeeded } : null,
        lastUpdate: saved.lastUpdate && typeof saved.lastUpdate === 'object' ? { ...saved.lastUpdate } : null,
    };
}

// every admin tab re-reads on a change it can see; a check that found the same answer stays quiet
function announce(force = false) {
    const s = appUpdateState();
    const key = JSON.stringify([s.checkedAt, s.checking, s.available, s.latest?.version, s.skipped, s.error, s.refusal, s.updating?.phase, s.failed, s.restartNeeded]);
    if (!force && key === _announced) return;
    _announced = key;
    forEachOpenLibrary((db) => emitChange(db, { entity: 'appUpdate', op: 'updated', ids: ['app'] }));
}

// ========================================
// CHECK
// ========================================

// what the clone's branch holds on its remote, fetched; never changes the working tree
function gitCheck(root) {
    return withRepo(REPO_KEY, async () => {
        const g = (args) => gitOut(['-C', root, ...args]);
        let branch;
        try { branch = await g(['symbolic-ref', '--short', 'HEAD']); } catch { return { blocked: 'the install is not on a branch (a detached HEAD); check out main to update from here' }; }
        let remote, merge;
        try { remote = await g(['config', `branch.${branch}.remote`]); merge = await g(['config', `branch.${branch}.merge`]); } catch { return { blocked: `the branch ${branch} follows no branch on a remote` }; }
        await runGit(['-C', root, 'fetch', '--quiet', '--no-tags', remote, merge]);
        const head = await g(['rev-parse', 'HEAD']);
        const tip = await g(['rev-parse', 'FETCH_HEAD']);
        let nextVersion = null;
        try { nextVersion = JSON.parse(await g(['show', 'FETCH_HEAD:package.json'])).version || null; } catch { /* the tip names no version: nothing to offer */ }
        const behind = Number(await g(['rev-list', '--count', 'HEAD..FETCH_HEAD']));
        const ahead = Number(await g(['rev-list', '--count', 'FETCH_HEAD..HEAD']));
        const dirty = (await g(['status', '--porcelain', '--untracked-files=no'])) !== '';
        return { branch, remote, head, tip, behind, ahead, dirty, nextVersion };
    });
}

async function releaseList() {
    const slug = repoSlug(_sources.root());
    if (!slug) throw new Error('package.json names no GitHub repository');
    return _sources.releases(slug);
}

// the releases a reader moving from the running version up to this one meets, newest first
const between = (list, upTo) => list.filter(r => newerVersion(r.version, RUNNING_VERSION) && !newerVersion(r.version, upTo))
    .sort((a, b) => (newerVersion(a.version, b.version) ? -1 : newerVersion(b.version, a.version) ? 1 : 0));

/**
 * Ask what is newer now, or answer a check younger than maxAge; it never changes the install.
 * @param {{ maxAge?: number }} [opts] milliseconds
 */
export async function checkAppUpdate({ maxAge = 0 } = {}) {
    if (maxAge > 0 && _check.checkedAt && Date.now() - _check.checkedAt < maxAge) return appUpdateState();
    if (!_checking) {
        _checking = (async () => {
            try {
                if (installType() === 'git') {
                    const git = await gitCheck(_sources.root());
                    let latest = git.nextVersion ? { version: git.nextVersion, url: null, publishedAt: null } : null;
                    let releases = [];
                    // the notes are a courtesy: a clone that reaches its remote is answered without them
                    if (latest && newerVersion(latest.version, RUNNING_VERSION)) {
                        try {
                            releases = between(await releaseList(), latest.version);
                            const own = releases.find(r => r.version === latest.version);
                            if (own) latest = { ...latest, url: own.url, publishedAt: own.publishedAt };
                        } catch { /* no notes */ }
                    }
                    _check = { checkedAt: Date.now(), git, latest, releases, error: null };
                } else {
                    const list = await releaseList();
                    const newest = list.reduce((best, r) => (!best || newerVersion(r.version, best.version) ? r : best), null);
                    const latest = newest ? { version: newest.version, url: newest.url, publishedAt: newest.publishedAt } : null;
                    _check = { checkedAt: Date.now(), git: null, latest, releases: latest ? between(list, latest.version) : [], error: null };
                }
            } catch (e) {
                _check = { ..._check, checkedAt: Date.now(), error: gitWords(e) };
            }
        })().finally(() => { _checking = null; });
        announce();
    }
    await _checking;
    announce();
    return appUpdateState();
}

/** Remember a version the admin does not want to hear about again (null forgets it); kept for the whole server. */
export function skipAppVersion(version) {
    if (version !== null && !(typeof version === 'string' && /^\d+\.\d+\.\d+[\w.+-]*$/.test(version))) throw httpError(400, 'version must be a version like 1.4.0, or null');
    writeState({ skipped: version });
    announce();
    return appUpdateState();
}

/** Let go of a failed update for every tab; a running update is untouched. */
export function dismissAppUpdateFailure() {
    if (_failed) { _failed = null; announce(); }
    return appUpdateState();
}

// ========================================
// WHAT A RESTART WOULD CUT
// ========================================

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
let _inFlight = 0;

/** Counts the writes in flight (a reply being written, an import, an upload), the update's own aside; mounted on /api. */
export function trackWork(req, res, next) {
    if (SAFE_METHODS.has(req.method) || req.path.startsWith('/app/update')) return next();
    // from the merge to the restart a write would be cut by the exit, so it waits for the reload instead
    if (_updating && _updating.phase !== 'backup') return res.status(503).json({ error: 'Project Σ is updating and reloads in a moment; try again after it' });
    _inFlight++;
    let ended = false;
    const end = () => { if (!ended) { ended = true; _inFlight--; } };
    res.on('finish', end);
    res.on('close', end);
    next();
}

/** What a restart now would cut, in words; empty when nothing would. */
export function busyWork() {
    const out = [];
    if (backupsBusy()) out.push('a backup is running');
    const handles = accountHandles(config.multiUser ? openServerDb() : null);
    if (handles.some(h => setJobsBusy(h))) out.push('a job over many characters is running (tags, favourites or a delete)');
    if (handles.some(h => listJobs(h).some(j => j.status === 'running' || j.status === 'queued'))) out.push('an extension job is running');
    if (_inFlight > 0) out.push(`${_inFlight === 1 ? 'a request is' : `${_inFlight} requests are`} still running (a reply being written, an import or an upload)`);
    return out;
}

// ========================================
// UPDATE
// ========================================

async function backupEveryLibrary() {
    const runs = [];
    const unopened = [];
    _backingUp = [];
    // a library written by a newer server opens after an update made without a backup; this server cannot back it up
    const why = (e) => (e?.name === 'LibraryAheadError' ? 'written by a newer version: update with the backup switch off to go ahead' : e?.message);
    forEachAccountLibrary({ serverDb: config.multiUser ? openServerDb() : null, enabledOnly: false, onError: (handle, e) => unopened.push(`${handle} (${why(e)})`) }, ({ handle, paths }) => {
        const db = openDb(handle);
        _backingUp.push(handle);
        runs.push(takeBackup(db, paths).then(job => ({ handle, file: job.file, bytes: job.bytes ?? null })));
    });
    const done = await Promise.all(runs);
    // a library that cannot be opened has no backup, and the switch promises none is updated without one
    if (unopened.length) throw new Error(`a library could not be opened to back it up: ${unopened.join(', ')}; nothing was updated`);
    return done;
}

// each account's copy as it goes: queued, copying (bytes so far of the library's size), checking, done
function backupProgress() {
    return _backingUp.map((handle) => {
        let view = null;
        try { view = backupJobView(openDb(handle)); } catch { /* an account gone meanwhile reads as queued */ }
        const status = view?.status || 'queued';
        return { handle, status, phase: view?.phase ?? null, done: status === 'done' ? (view.bytes ?? view.total ?? 0) : (view?.done ?? 0), total: view?.total ?? null };
    });
}

async function runUpdate(git, { backup }) {
    const root = _sources.root();
    try {
        const backups = backup ? await backupEveryLibrary() : [];
        const busy = busyWork();
        if (busy.length) throw new Error(`${busy.join('; ')}, started while the backup ran; nothing was updated`);
        _updating = { ..._updating, phase: 'updating', backedUp: backups.map(b => ({ handle: b.handle, bytes: b.bytes })) };
        announce();
        await withRepo(REPO_KEY, () => runGit(['-C', root, 'merge', '--ff-only', '--quiet', git.tip]));
        writeState({ lastUpdate: { from: git.head, to: git.tip, fromVersion: RUNNING_VERSION, toVersion: git.nextVersion, at: Date.now(), backups } });
        if (_sources.launcher()) {
            _updating = { ..._updating, phase: 'restarting' };
            announce();
            setTimeout(() => _sources.exit(RESTART_EXIT_CODE), RESTART_DELAY_MS).unref?.();
            return;
        }
        _updating = null;
        _restartNeeded = { version: git.nextVersion };
        announce();
    } catch (e) {
        _updating = null;
        _failed = gitWords(e);
        announce();
    }
}

/**
 * Update a git clone to its branch's newest commit, refused with the reason unless it moves forward cleanly with nothing to cut.
 * @param {{ backup?: boolean }} [opts] back up every library first (the default)
 * @returns {Promise<object>} the state, updating; the run goes on after the answer
 */
export async function startAppUpdate({ backup = true } = {}) {
    if (installType() !== 'git') throw httpError(400, `a ${installType()} install updates by hand; the steps are in the README`);
    if (_updating) throw httpError(409, 'an update is already running');
    if (_starting) throw httpError(409, 'an update is already starting');
    if (_restartNeeded) throw httpError(409, `the update to v${_restartNeeded.version} is in place; restart the server to finish it`);
    const busyBefore = busyWork();
    if (busyBefore.length) throw httpError(409, `wait until it ends: ${busyBefore.join('; ')}`);
    // held across the repository check, so a second request in that wait is refused rather than started beside this one
    _starting = true;
    try {
        let git;
        try { git = await gitCheck(_sources.root()); } catch (e) { throw httpError(502, `could not reach the repository: ${gitWords(e)}`); }
        const kept = _check.latest?.version === git.nextVersion ? _check.latest : { version: git.nextVersion, url: null, publishedAt: null };
        _check = { ..._check, git, checkedAt: Date.now(), latest: git.nextVersion ? kept : null };
        const refusal = gitRefusal(git);
        if (refusal) { announce(); throw httpError(409, refusal); }
        if (!newerVersion(git.nextVersion, RUNNING_VERSION)) { announce(); throw httpError(409, 'there is nothing newer to update to'); }
        _failed = null;
        _updating = { phase: backup ? 'backup' : 'updating', toVersion: git.nextVersion, startedAt: Date.now(), backup };
        announce();
        void runUpdate(git, { backup });
        return appUpdateState();
    } finally {
        _starting = false;
    }
}
