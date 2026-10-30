import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { httpError } from './lib/http-error.js';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(serverDir, '..');

const dataDir = path.resolve(process.env.CL_DATA_DIR || path.join(projectRoot, 'data'));
// admin installs; a throwaway server points it elsewhere like dataDir, so it never installs into the real tree
const extensionsDir = path.resolve(process.env.CL_EXTENSIONS_DIR || path.join(projectRoot, 'extensions', 'installed'));

// handles are folder names: no dots keeps them clear of server.yaml / server.db and of traversal
export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

export function assertHandle(handle) {
    if (!HANDLE_RE.test(String(handle))) {
        throw httpError(400, `invalid user handle: ${String(handle)}`);
    }
}

const SERVER_YAML_TEMPLATE = `# project-sigma server settings. Everything here is SERVER-level; per-user state
# lives in the sibling user folders (data/<handle>/). Env vars win over this file
# when set: CL_PORT, CL_HOST, CL_CORS, CL_MULTI_USER, CL_HOSTS.
#
# Set only in the environment, since this file lives in the folder the first one
# moves: CL_DATA_DIR (default data/ in the install), CL_EXTENSIONS_DIR (default
# extensions/installed/ in the install), CL_EXTENSIONS=off (boot with every
# extension dark, the way back in when one breaks the app) and CL_BROWSER (the
# browser the hosted-browser services launch). README.md lists them all.

# true = login required and per-user isolation enforced. First boot with no users
# defined promotes the existing single-user library: it creates the admin account
# 'default', which already owns data/default, and prints its password once.
multiUser: false

# signed-cookie session lifetime in days; -1 = no limit (a browser keeps the cookie at most 400 days)
sessionTimeoutDays: 30

# uncomment to override the defaults without env vars.
# host is the bind address and it DEFAULTS TO 0.0.0.0, meaning every interface: the
# server is reachable from other machines on your network out of the box, which is what
# makes reading on a phone work. Set 127.0.0.1 to restrict it to this machine only.
#port: 7788
#host: 0.0.0.0
#cors: []

# With multiUser off, the server answers only an IP address, localhost, and the names
# listed here: a page on another site that points its own name at this machine (DNS
# rebinding) is refused. List a machine name you reach the server by, eg. mypc or
# mypc.tailnet.ts.net.
#hosts: []
`;

function loadServerYaml() {
    const file = path.join(dataDir, 'server.yaml');
    if (!fs.existsSync(file)) return {};
    let doc;
    try {
        doc = parseYaml(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        // a mangled settings file must never silently boot a differently-configured server
        throw new Error(`${file} is not valid yaml: ${err.message}`);
    }
    if (doc === null || doc === undefined) return {};
    if (typeof doc !== 'object' || Array.isArray(doc)) {
        throw new Error(`${file} must be a yaml mapping of settings`);
    }
    return doc;
}

// a bad value or unknown key refuses the boot by name, or "multiUser: yes" boots silently with no login
const isList = (v) => Array.isArray(v) && v.every(x => typeof x === 'string');
const YAML_SETTINGS = {
    multiUser: [(v) => typeof v === 'boolean', 'true or false'],
    sessionTimeoutDays: [(v) => typeof v === 'number' && Number.isFinite(v) && (v > 0 || v === -1), 'a number of days above 0, or -1 for never'],
    port: [(v) => Number.isInteger(v) && v > 0 && v < 65536, 'a whole number from 1 to 65535'],
    host: [(v) => typeof v === 'string' && v.trim() !== '', 'an address'],
    cors: [isList, 'a list of origins'],
    hosts: [isList, 'a list of names'],
};
const ENV_SETTINGS = {
    CL_MULTI_USER: [(v) => v === 'true' || v === 'false', 'true or false'],
    CL_PORT: [(v) => /^\d{1,5}$/.test(v) && Number(v) > 0 && Number(v) < 65536, 'a whole number from 1 to 65535'],
    CL_ALLOW_PRIVATE_FETCH: [(v) => v === 'true' || v === 'false', 'true or false'],
    CL_EXTENSIONS: [(v) => v === 'on' || v === 'off', 'on or off'],
};

function validateSettings(yaml, env) {
    const file = path.join(dataDir, 'server.yaml');
    for (const [key, value] of Object.entries(yaml)) {
        // a key written with no value is a setting left unset
        if (value === null) continue;
        const rule = YAML_SETTINGS[key];
        if (!rule) throw new Error(`${file}: "${key}" is not a setting (the settings are ${Object.keys(YAML_SETTINGS).join(', ')})`);
        if (!rule[0](value)) throw new Error(`${file}: ${key} must be ${rule[1]}, not ${JSON.stringify(value)}`);
    }
    for (const [key, [ok, what]] of Object.entries(ENV_SETTINGS)) {
        const value = env[key];
        if (value !== undefined && value !== '' && !ok(value)) throw new Error(`the environment's ${key} must be ${what}, not ${JSON.stringify(value)}`);
    }
}

const yamlSettings = loadServerYaml();
validateSettings(yamlSettings, process.env);

// the names a server with accounts off answers besides IP literals and localhost
function hostsFromEnvOrYaml() {
    const list = process.env.CL_HOSTS !== undefined ? process.env.CL_HOSTS.split(',')
        : Array.isArray(yamlSettings.hosts) ? yamlSettings.hosts : [];
    return list.map(s => String(s).trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
}

function corsFromEnvOrYaml() {
    if (process.env.CL_CORS !== undefined) {
        return process.env.CL_CORS.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (Array.isArray(yamlSettings.cors)) return yamlSettings.cors.map(s => String(s).trim()).filter(Boolean);
    return [];
}

export const config = {
    port: Number(process.env.CL_PORT || yamlSettings.port || 7788),
    host: process.env.CL_HOST || yamlSettings.host || '0.0.0.0',
    corsOrigins: corsFromEnvOrYaml(),
    hosts: hostsFromEnvOrYaml(),
    multiUser: process.env.CL_MULTI_USER !== undefined
        ? process.env.CL_MULTI_USER === 'true'
        : yamlSettings.multiUser === true,
    sessionTimeoutDays: Number(yamlSettings.sessionTimeoutDays ?? 30),
    // test-only: lets a test fetch media from its own loopback. never set in a real deployment
    allowPrivateFetch: process.env.CL_ALLOW_PRIVATE_FETCH === 'true',
    // Kill switch: CL_EXTENSIONS=off boots with the extension system fully dark (no
    // static serving, empty inventory), so a broken extension can never brick the app.
    extensionsEnabled: process.env.CL_EXTENSIONS !== 'off',
    projectRoot,
    dataDir,
    extensionsDir,
    serverYamlFile: path.join(dataDir, 'server.yaml'),
    serverDbFile: path.join(dataDir, 'server.db'),
};

/** Per-user filesystem layout under data/<handle>/. */
export function userPaths(handle) {
    assertHandle(handle);
    const root = path.join(dataDir, handle);
    return {
        handle,
        root,
        dbFile: path.join(root, 'library.db'),
        avatarsDir: path.join(root, 'avatars'),
        galleryRoot: path.join(root, 'gallery'),
        backgroundsDir: path.join(root, 'backgrounds'),
        personaAvatarsDir: path.join(root, 'personas'),
        // a chat's gallery and a studio session's pictures, a folder per owner
        attachmentsRoot: path.join(root, 'attachments'),
        avatarThumbsDir: path.join(root, 'thumbs', 'avatars'),
        mediaThumbsDir: path.join(root, 'thumbs', 'media'),
        backgroundThumbsDir: path.join(root, 'thumbs', 'backgrounds'),
        personaThumbsDir: path.join(root, 'thumbs', 'personas'),
        attachmentThumbsDir: path.join(root, 'thumbs', 'attachments'),
        backupsDir: path.join(root, 'backups'),
        // card files a client sent to be read before they import; each kept an hour at most
        stagingDir: path.join(root, 'staging'),
    };
}

export function ensureUserDirs(handle) {
    const paths = userPaths(handle);
    for (const dir of [paths.root, paths.avatarsDir, paths.galleryRoot, paths.backgroundsDir, paths.personaAvatarsDir]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return paths;
}

/** Data root + a commented server.yaml on first boot; user dirs are made per handle. */
export function ensureServerScaffold() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    if (!fs.existsSync(config.serverYamlFile)) {
        fs.writeFileSync(config.serverYamlFile, SERVER_YAML_TEMPLATE);
    }
}
