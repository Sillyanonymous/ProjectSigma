// The endpoint contract, served at /api/openapi.json. Hand-kept: it changes in the same change as any route
import { CHANGE_VOCABULARY } from './db/changes.js';
import { ERROR_KINDS } from './llm/errors.js';
import { GENERATE_MODES } from './llm/vocabulary.js';
import { BOOL_TRUE, BOOL_FALSE, PROBE_MAX_KEYS, HINT_TEXT_MAX, PAGE_DEFAULT, PAGE_MAX, IDS_MAX, FIELDS_APPLY_MAX } from './lib/query-params.js';
import { SEARCH_PAGE_DEFAULT, SEARCH_PAGE_MAX } from './db/chats-store.js';
import { CARRIERS_DEFAULT, CARRIERS_MAX, ENTRY_SEARCH_DEFAULT, ENTRY_SEARCH_MAX, ENTRY_SEARCH_RANKED } from './db/worlds-store.js';
import { DELETE_MAX } from './db/characters-store.js';

const err = desc => ({
    description: desc,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});
const throttled = desc => ({ ...err(`${desc} (Retry-After: the seconds until the lock lifts)`), headers: { 'Retry-After': { description: 'seconds until the lock lifts', schema: { type: 'integer' } } } });
const json = (schema, description = 'OK') => ({
    description,
    content: { 'application/json': { schema } },
});
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const body = (schema, required = true) => ({
    required,
    content: { 'application/json': { schema } },
});
const p = (name, schema, description, where = 'query') => ({ name, in: where, schema, description });
const pathId = (name = 'id', description = 'character uuid') => ({ ...p(name, { type: 'string' }, description, 'path'), required: true });
// a query-string flag, in the words boolOf reads; a JSON body or answer carries { type: 'boolean' }
const BOOL = { type: 'string', enum: [...BOOL_TRUE, ...BOOL_FALSE] };
const INT = { type: 'integer' };
const STR = { type: 'string' };
const CSV = { type: 'string', description: 'single value, comma-separated list, or repeated parameter' };

// the admin router's own gate, ahead of every account route
const MULTI_USER_OFF = 'multi-user is disabled on this server';
// the net guard's refusal, which a server-side download answers as it is
const NET_GUARD_REFUSAL = 'the net guard refuses the url: an empty host, or one resolving to a private or local address';
// what the proxy answers itself before or instead of the upstream's own status, on every method it proxies
const PROXY_REFUSALS = {
    400: err('a target that is not a url, or not http(s)'),
    403: err(NET_GUARD_REFUSAL),
    502: err('the upstream failed, timed out, or answered past the size cap'),
};
// sessionLookup's second answer, on every route that reads a session's transcript
const TRANSCRIPT_UNREADABLE = 'this session\'s transcript could not be read';
// the check a write by seq carries: the id of the message the reader was shown there
const SHOWN_CHANGED = 'another message than the one named holds that seq now (a delete renumbered the chat since it was read): that message changed since it was shown; nothing was written';
// the check an edit and a generate carry beside it: the active alternate the reader was shown, which the body names
const ACTIVE_CHANGED = 'the message holds another active alternate, count of alternates or active text than the one named as shown (an alternate added, dropped, picked or rewritten since it was read): that message changed since it was shown; nothing was written';
const SHOWN_ACTIVE = (what) => ({
    type: 'object', required: ['index', 'count', 'text'],
    description: `optional: what the reader was shown of ${what}: its active alternate's place, the alternates counted and that alternate's text. When the stored message differs in any of them the request is refused with 409 and nothing is written; left out, it acts on whatever alternate is active`,
    properties: {
        index: { ...INT, description: 'the active alternate\'s place, 0 to count - 1 (0 for a message with none)' },
        count: { ...INT, description: 'the alternates shown: swipes.length, 1 for a message with none' },
        text: { ...STR, description: 'the active alternate\'s text as shown (mes for a message with none)' },
    },
});
const MESSAGE_ID = p('messageId', INT, 'the id of the message the reader was shown at this seq: another message there now refuses the write (409). Left out, the write goes to whichever message holds the seq');
// a persona's pronoun forms, what {{sub}} {{obj}} {{poss}} {{poss_p}} {{ref}} answer
const PRONOUNS = {
    type: 'object',
    description: 'the persona\'s pronoun forms, answered by {{sub}}, {{obj}}, {{poss}}, {{poss_p}} and {{ref}}. An empty form answers its they/them word (they, them, their, theirs, themselves). The case follows how the macro is written: {{sub}} as stored, {{Sub}} with its first letter capitalised, {{SUB}} in upper case, any other mix as stored',
    properties: {
        sub: { ...STR, description: 'subject, {{sub}} (she)' },
        obj: { ...STR, description: 'object, {{obj}} (her)' },
        poss: { ...STR, description: 'possessive determiner, {{poss}} (her)' },
        possP: { ...STR, description: 'possessive pronoun, {{poss_p}} (hers)' },
        ref: { ...STR, description: 'reflexive, {{ref}} (herself)' },
    },
};
// what a write may send of them: any of the five, each trimmed and held to 64 characters
const PRONOUNS_WRITE = { ...PRONOUNS, description: 'any of the five forms, each a string of at most 64 characters once trimmed; a form left out is left alone (empty on a create), and an empty string clears one back to its they/them word' };
// a git install at one commit, and what an update check found for each
const EXT_AT = { type: 'object', properties: { commit: { ...STR, description: 'short commit id' }, version: { ...STR, nullable: true, description: "the manifest's version there" } } };
const EXT_UPDATES = { type: 'object', properties: {
    checkedAt: { type: 'number', nullable: true, description: 'when the last check ended, epoch ms; null before the first' },
    checking: { type: 'boolean', description: 'a check is running now' },
    extensions: { type: 'array', items: { type: 'object', properties: {
        id: STR, name: STR, version: { ...STR, nullable: true, description: 'the installed version' },
        available: { type: 'boolean', description: 'the repository holds a commit the install is not on' },
        commit: { ...STR, description: 'the installed commit, short' },
        nextCommit: { ...STR, description: "the repository's latest commit, short, when available" },
        nextVersion: { ...STR, nullable: true, description: 'the version that commit names, when available' },
        error: { ...STR, description: 'why the repository could not be asked' },
    } } },
} };
// the keys the native shape gives a message, refused on a stored row (they would be exported as JSONL)
const RESERVED_KEYS_REFUSED = 'an element carrying seq or raw (the native shape\'s keys: send each message\'s raw)';

// the contract's own version: moves only when a route goes or a shape a client reads changes
export const API_VERSION = 1;

// x-collection: a page (default, cap, walk, key) or the whole set and its bound; a deprecated form lasts until `until`
const asPage = (def, max, { walk = 'cursor', key, deprecated, until } = {}) => ({ kind: 'page', default: def, max, walk, ...(key ? { key } : {}), ...(deprecated ? { deprecated, until } : {}) });
const asWhole = (bound, { deprecated, until } = {}) => ({ kind: 'whole', bound, ...(deprecated ? { deprecated, until } : {}) });
// a page of a keyset list
const pageSchema = (item) => ({
    type: 'object',
    properties: {
        items: { type: 'array', items: item },
        total: { ...INT, nullable: true, description: 'rows in the whole list; null when count=false' },
        limit: INT,
        nextCursor: { ...STR, nullable: true, description: 'pass as after= for the next page; null when this page was not full' },
    },
});
const PAGE_PARAMS = (what) => [
    p('limit', INT, `rows a page: default ${PAGE_DEFAULT}, at most ${PAGE_MAX}; past it, walk nextCursor with after`),
    p('after', STR, `the nextCursor of the page before: the ${what} after it, O(page) at any depth`),
    p('count', BOOL, 'count=false skips the total (null in the answer); a walk reads nextCursor for has-more'),
];

// one builder for both path forms (global carries no id), so each declares only the parameters its own path holds
function bindingOps(withId) {
    const parameters = [pathId('scope', 'global | character | chat'), ...(withId ? [pathId('id', 'character or chat uuid (the global scope takes the path without it)')] : [])];
    const badScope = withId ? 'bad scope, or an id on the global scope' : 'bad scope, or a character or chat scope without its id';
    return {
        get: {
            tags: ['backgrounds'],
            summary: 'The binding at exactly ONE scope, unresolved. A null binding means this scope INHERITS, which is a different answer from a binding whose background is null (a deliberate "nothing here" that stops inheritance)',
            parameters,
            responses: {
                200: json({
                    type: 'object',
                    properties: {
                        scope: STR,
                        id: { ...STR, nullable: true },
                        binding: { ...ref('BackgroundBinding'), nullable: true, description: 'null means this scope inherits' },
                    },
                }),
                400: err(badScope),
            },
        },
        put: {
            tags: ['backgrounds'],
            summary: 'Write one binding. Omitted fields KEEP their stored value; an explicit null backgroundId means "no wallpaper here", which stops inheritance rather than falling through',
            parameters,
            requestBody: body({
                type: 'object',
                properties: {
                    backgroundId: { type: 'integer', nullable: true, description: 'null means explicitly none' },
                    fit: { ...STR, enum: ['cover', 'contain', 'stretch', 'center', 'tile'] },
                    opacity: { type: 'number', description: '0 to 1' },
                    blur: { type: 'integer', description: '0 to 40 px' },
                    brightness: { type: 'number', description: '0 to 2' },
                    saturate: { type: 'number', description: '0 to 2' },
                    renderWidth: { type: 'integer', nullable: true, enum: [null, 0, 768, 1280, 1920], description: 'which tier the client should request; null is auto, 0 is the original' },
                },
            }),
            responses: { 200: json(ref('BackgroundBinding')), 400: err(`${badScope}; or an unknown enum value or out-of-range knob (the message names the valid set)`), 404: err('scope target or background not found') },
        },
        delete: {
            tags: ['backgrounds'], summary: 'Clear the binding at this scope, returning it to inherited',
            parameters,
            responses: { 200: json(ref('Ok')), 400: err(badScope), 404: err('no binding at this scope') },
        },
    };
}

export function buildOpenApiSpec(version) {
    const spec = {
        openapi: '3.0.3',
        info: {
            title: 'Project Σ API',
            version: String(API_VERSION),
            'x-package-version': version,
            description: 'DB-native character library server. Clients do zero heavy lifting: '
                + 'querying, filtering, sorting, and windowing all happen server-side. '
                + 'All timestamps are unix milliseconds. Every collection GET says what it answers in its '
                + 'x-collection: a page ({items, total, limit, nextCursor}: ' + PAGE_DEFAULT + ' rows unless limit asks, at most '
                + PAGE_MAX + ' unless the operation names its own numbers, a limit outside them refused by name; a reader '
                + 'that needs the whole set walks nextCursor with after, and count=false skips the total), the whole '
                + 'set as a plain array or document with what bounds it. '
                + 'info.version is the API\'s own version (apiVersion on /api/health): it moves only '
                + 'when a route is removed or a shape a client reads changes. From the first public release on, an '
                + 'operation marked deprecated here leaves in a later release, and a form a list still answers until a '
                + 'later API version is named in its x-collection deprecated, with that version in until. '
                + 'Multi-user mode (server.yaml multiUser: true) gates every user surface behind '
                + 'an HttpOnly SameSite=Strict session cookie from /api/auth/login; single-user '
                + 'mode needs no auth and everything resolves to the default user. A 401 that means "sign in" '
                + 'carries X-CL-Auth: required. A 401 without it is no request to sign in: a refused login or password '
                + 'change under /api/auth, or a site\'s refusal a provider route passes through (a wrong password at a '
                + 'site\'s login, an expired site token). '
                + 'A request may send X-UTC-Offset, the reader\'s clock in minutes east of UTC, and X-Time-Zone, '
                + 'its IANA zone (Europe/Paris): the time macros a prompt or a sent message holds ({{time}}, '
                + '{{date}}) answer in the offset, and a stored date written without a zone (a message\'s '
                + 'createdAt, {{idle_duration}}) is read in the zone, else at the offset, else in the server\'s own.',
        },
        tags: [
            { name: 'characters', description: 'Cards, avatars, import/export' },
            { name: 'media', description: 'Per-character gallery media (uid-keyed files), chat attachments and media download jobs' },
            { name: 'backgrounds', description: 'Chat wallpapers: a flat image library plus the bindings that decide which chat wears which' },
            { name: 'chats', description: 'Chats and their messages: browse, search, edit, branch and export, the prompt a chat would send, and generation on the server, streamed as SSE' },
            { name: 'assistant', description: 'Out-of-character assistant sessions bound to a chat' },
            { name: 'creator', description: 'The creator studio: sessions over a character draft, their messages and generation, the edits it proposes and applies, and tag suggestions' },
            { name: 'worlds', description: 'Lorebooks: the whole-book document plus entry-by-entry writes' },
            { name: 'library', description: 'Playlists, versions, personas, settings, KV store, backups, bundles, migration, maintenance and background jobs' },
            { name: 'tags', description: 'Library-wide tag edits and the undo journal of their runs' },
            { name: 'llm', description: 'LLM profiles + server-side chat calls (keys stay server-side), prompt presets and regex scripts' },
            { name: 'extensions', description: 'Installed extensions: list, switch on or off, install, update and remove; their background jobs and their own routes' },
            { name: 'auth', description: 'Sessions + accounts (multi-user mode)' },
            { name: 'admin', description: 'User management (admin accounts only)' },
            { name: 'infra', description: 'Health, thumbnails, proxy, provider services' },
        ],
        paths: {
            '/api/health': {
                get: { tags: ['infra'], summary: 'Liveness + the package version + apiVersion (the HTTP contract\'s own, info.version here) + multiUser flag + spec pointer', responses: { 200: json({ type: 'object' }) } },
            },
            '/api/openapi.json': {
                get: { tags: ['infra'], summary: 'This document', responses: { 200: json({ type: 'object' }) } },
            },
            '/api/feed': {
                get: {
                    tags: ['infra'],
                    summary: 'The change feed: a WebSocket (a plain GET answers 426)',
                    description: 'Upgrade to a WebSocket and every committed write to your library arrives as it lands, whichever client or server code made it. '
                        + 'The server speaks JSON messages and ignores anything sent to it: {type: "hello", clientId, handle} once; '
                        + '{type: "changes", records} per batch, each record {entity, op, ids?, all?, fields?, origin, ...} naming what changed by id '
                        + `(entity and op are one of ${Object.entries(CHANGE_VOCABULARY).map(([e, ops]) => `${e} ${ops.join('/')}`).join(', ')}; all: true, with no ids, when the write spanned more rows than a record names (a whole set, or characters past a thousand); `
                        + 'origin is the client id the writing request sent as X-CL-Client, so a tab can skip its own, and null for what an extension wrote through its own routes or listeners; '
                        + 'extension, on a record an extension reported for a write to its own tables, is that extension\'s id, its fields named <id>.<name>: the entity\'s own data did not change; '
                        + 'to, on a tag or lorebook rename, is the name it has now, the old one in ids: a tag merge is the merged tag\'s deleted record with to the surviving tag\'s spelling, a tag delete carries no to, '
                        + 'and a binding sweep that re-pointed a lorebook is a worldLink record naming the old name as world beside to); '
                        + 'and {type: "resync"} when a slow connection fell behind, after which a client re-reads what it shows. '
                        + 'The feed carries no history: after a reconnect, re-read. user records reach admins only. '
                        + 'The connection closes with 4001 when the session ends (a password change, a disabled account).',
                    parameters: [{ name: 'client', in: 'query', schema: STR, description: 'the id of this tab: the value its API requests send as X-CL-Client (8 to 64 of [A-Za-z0-9-])' }],
                    responses: { 101: { description: 'switching protocols' }, 401: err('signed out'), 403: err('an Origin the API would not answer (same origin, or one CL_CORS names)'), 426: err('not a WebSocket upgrade') },
                },
            },

            '/api/auth/login': {
                post: {
                    tags: ['auth'], summary: 'Exchange handle + password for a session cookie',
                    requestBody: body({ type: 'object', properties: { handle: STR, password: STR }, required: ['handle', 'password'] }),
                    responses: { 200: json({ type: 'object' }, '{handle, displayName, admin, mustChangePassword}; sets the cl_session cookie'), 400: err('multi-user disabled'), 401: err('invalid credentials (one generic error, no account enumeration)'), 429: throttled('too many failed attempts on this handle or from this address') },
                },
            },
            '/api/auth/logout': {
                post: { tags: ['auth'], summary: 'Clear the session cookie', responses: { 200: json(ref('Ok')) } },
            },
            '/api/auth/me': {
                get: { tags: ['auth'], summary: 'Who am I ({multiUser, handle, displayName, admin, mustChangePassword}); in single-user mode always the default user', responses: { 200: json({ type: 'object' }), 401: err('signed out (multi-user mode)') } },
            },
            '/api/auth/password': {
                post: {
                    tags: ['auth'], summary: 'Self-service password change; clears mustChangePassword and re-issues the session (the version bump kills all older cookies)',
                    requestBody: body({ type: 'object', properties: { currentPassword: STR, newPassword: STR }, required: ['currentPassword', 'newPassword'] }),
                    responses: { 200: json(ref('Ok')), 400: err('multi-user disabled, or a new password under 4 characters'), 401: err('wrong current password'), 429: throttled('too many failed attempts on this account (the login\'s lock)') },
                },
            },
            '/api/admin/users': {
                get: { tags: ['admin'], summary: 'List accounts (no secret material)', 'x-collection': asWhole('every account on the server'), responses: { 200: json({ type: 'array', items: { type: 'object' } }), 400: err(MULTI_USER_OFF), 403: err('admin required') } },
                post: {
                    tags: ['admin'], summary: 'Create an account (lands on mustChangePassword)',
                    requestBody: body({ type: 'object', properties: { handle: { ...STR, description: 'lowercase [a-z0-9-], 2-32 chars; becomes the data/<handle>/ folder' }, displayName: STR, password: STR, admin: { type: 'boolean', description: 'true makes an admin; anything else a plain account' } }, required: ['handle', 'password'] }),
                    responses: { 201: json({ type: 'object' }), 400: err(`bad handle/password, or ${MULTI_USER_OFF}`), 403: err('admin required'), 409: err('handle taken') },
                },
            },
            '/api/admin/users/{handle}': {
                patch: {
                    tags: ['admin'], summary: 'Update display name / admin / enabled, or reset the password (forces a change on next login). Self-demotion, self-disable, and last-admin removal are refused',
                    parameters: [{ name: 'handle', in: 'path', required: true, schema: STR }],
                    requestBody: body({ type: 'object', properties: { displayName: STR, admin: { type: 'boolean' }, enabled: { type: 'boolean' }, password: STR } }),
                    responses: { 200: json({ type: 'object' }), 400: err(`a field not of its type (admin and enabled are booleans, displayName a string, password at least 4 characters), refused before anything is written; a guard-rail refusal (yourself, the last admin); or ${MULTI_USER_OFF}`), 403: err('admin required'), 404: err('no such user') },
                },
                delete: {
                    tags: ['admin'], summary: 'Delete the account; the data/<handle>/ folder is deliberately KEPT and its path returned',
                    parameters: [{ name: 'handle', in: 'path', required: true, schema: STR }],
                    responses: { 200: json({ type: 'object' }, '{ok, keptData}'), 400: err(`self-delete or last admin, or ${MULTI_USER_OFF}`), 403: err('admin required'), 404: err('no such user') },
                },
            },

            '/api/extensions': {
                get: { tags: ['extensions'], summary: 'Installed-extension inventory ({enabled, extensions[], namespaces[]}), as the asking account sees it: each row carries enabled (whether it runs for this account); a broken install reports an error row instead of vanishing, and namespaces lists every card extensions namespace the server reads as a provider link rather than card content, in this order: the built-in providers\', then every one an extension has registered, kept after that extension is removed. Extensions are trusted code: installing one grants it full client and server privileges', 'x-collection': asWhole('every installed extension'), responses: { 200: json({ type: 'object', properties: { enabled: { type: 'boolean', description: 'false when the server booted with CL_EXTENSIONS=off' }, extensions: { type: 'array', items: ref('ExtensionRow') }, namespaces: { type: 'array', items: { type: 'string' } } } }) } },
            },
            '/api/extensions/{id}/enabled': {
                put: {
                    tags: ['extensions'], summary: 'Switch an extension on or off for your own account. The server keeps the rule: a bundled extension runs until an account switches it off (unless it ships defaultOff), any other runs once switched on. Answers the row as it now stands; a server half answers, guards and listens for the accounts it is on for',
                    parameters: [{ name: 'id', in: 'path', required: true, schema: STR }],
                    requestBody: body({ type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] }),
                    responses: { 200: json(ref('ExtensionRow')), 400: err('enabled is not a boolean'), 404: err('no such extension') },
                },
            },
            '/api/extensions/jobs': {
                get: { tags: ['extensions'], summary: "This account's extension jobs (an extension's ctx.jobs work), every extension's: the running, then the queued by their place in their extension's lane, then the last finished, newest first. Held in memory, so a restart forgets them. A job's start and end reach the account's feed as an extensionJob record with a null origin; its progress is read here", 'x-collection': asWhole('the account\'s jobs running and queued, and its 20 newest finished'), responses: { 200: json({ type: 'array', items: ref('ExtensionJob') }) } },
                delete: { tags: ['extensions'], summary: 'Dismiss every finished job of this account', responses: { 200: json({ type: 'object', properties: { cleared: INT } }, '{cleared}') } },
            },
            '/api/extensions/jobs/{id}': {
                delete: {
                    tags: ['extensions'], summary: "Cancel a queued or running job of this account (a running one settles at once as cancelled, its signal aborted, and its lane moves on), or dismiss a finished one",
                    parameters: [{ name: 'id', in: 'path', required: true, schema: INT }],
                    responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' } } }, '{ok}'), 400: err('numeric id required'), 404: err('this account holds no such job') },
                },
            },
            '/api/extensions/install': {
                post: {
                    tags: ['extensions'], summary: "Install an extension into extensions/installed/<id> (admin), from one of two sources: an https git repo (a JSON body; cloned) or the extension's folder as a zip archive (an application/zip body, streamed to disk; the manifest at its root or inside its one wrapping folder, as a repository's Download ZIP makes it; a .git folder inside is left out). Either lands in a temp dir first and its manifest is validated before it occupies the tree. An archive is refused whole, nothing written, when an entry names a path outside the folder or one the server cannot hold (absolute, dotted, a drive, a device name), when a name repeats, or past its limits (100 MB uploaded, 10000 entries, 50 MB an entry, 200 MB unpacked); each entry's bytes must match the archive's directory (size and crc)",
                    requestBody: { required: true, content: {
                        'application/json': { schema: { type: 'object', properties: { git: { ...STR, description: 'plain https git url' } }, required: ['git'] } },
                        'application/zip': { schema: { type: 'string', format: 'binary' } },
                    } },
                    responses: { 200: json({ type: 'object' }, '{id}'), 400: err('bad url / clone, archive or manifest failure / a manifest needing a newer extension api than the server speaks (the error names both versions) / extensions disabled'), 403: err('admin required'), 409: err('already installed'), 413: err('the archive is larger than the upload limit') },
                },
            },
            '/api/extensions/updates': {
                get: {
                    tags: ['extensions'], summary: "The last update check (admin): for each git-installed extension, whether its repository holds a newer commit, the version that commit's manifest names, or why the repository could not be asked. Held in memory, so checkedAt is null until a check runs after a restart",
                    responses: { 200: json(EXT_UPDATES, '{checkedAt, checking, extensions}'), 403: err('admin required') },
                },
            },
            '/api/extensions/updates/check': {
                post: {
                    tags: ['extensions'], summary: "Ask every git-installed extension's repository for its latest commit now (admin), or answer a check younger than maxAge milliseconds as it is; a second ask joins the one running. It never updates anything. What changed since the last check is announced as extension records",
                    requestBody: body({ type: 'object', properties: { maxAge: { type: 'number', description: 'answer the last check as it is when it is younger than this many milliseconds; 0 or absent always asks' } } }),
                    responses: { 200: json(EXT_UPDATES, '{checkedAt, checking, extensions}'), 400: err('maxAge not a number of 0 or more / extensions disabled'), 403: err('admin required') },
                },
            },
            '/api/extensions/{id}/update': {
                post: {
                    tags: ['extensions'], summary: "Bring a git-installed extension to its repository's latest commit (admin): the install is reset to that commit, so a rewritten history or an edit inside its folder never blocks an update. A new version that would not load is refused and the install stays as it was. updated is false when it was on that commit already. A server half keeps running the code it booted with, so restart is true when an update reached an extension that has one (its inventory serverState reads restart until the server restarts)",
                    parameters: [{ name: 'id', in: 'path', required: true, schema: STR }],
                    responses: { 200: json({ type: 'object', properties: { id: STR, updated: { type: 'boolean' }, from: EXT_AT, to: EXT_AT, restart: { type: 'boolean' } } }, '{id, updated, from, to, restart}'), 400: err('not a git install / the repository could not be reached / the new version would not load / extensions disabled'), 403: err('admin required'), 404: err('no such extension') },
                },
            },
            '/api/extensions/{id}': {
                delete: {
                    tags: ['extensions'], summary: 'Remove an installed extension from disk, its extensions/installed/.data/<id> scratch and its ext/<id> folder in every account\'s home included (admin). A mounted server half stops answering at once (its routes 404), without a restart, and every account forgets its switch (the id leaves enabledExtensions and disabledExtensions in every library, a closed one included), so an install under the same id later starts off. A folder shadowing a bundled id goes alone: the bundled extension keeps its scratch, every account\'s folder of it, its running half and every account\'s switch, and the answer says shadowed',
                    parameters: [{ name: 'id', in: 'path', required: true, schema: STR }],
                    responses: { 200: json({ type: 'object' }, '{id}, or {id, shadowed: true} for a folder that shadowed a bundled id; {id, leftover: [handle]} names the accounts whose ext/<id> folder could not be deleted, the removal standing'), 400: err('invalid extension id'), 403: err('admin required'), 404: err('no such extension') },
                },
            },
            '/api/ext/{id}': {
                description: 'Extension-defined API surface. Each installed extension with a server half mounts its own routes under /api/ext/<id>/ at boot, behind the standard sign-in gate; the routes themselves are whatever the extension registered and are not part of this contract. They answer only the accounts the extension is switched on for (404 otherwise). A half whose manifest requires a newer extension api than the server speaks is not mounted (its inventory row reports serverState failed), and a removed extension answers 404 until the server restarts. What these routes write reaches the change feed with a null origin, so every tab patches it, the calling one included.',
            },
            '/ext/{id}/{path}': {
                get: { tags: ['extensions'], summary: "An extension's published client files: only paths under the folders holding its manifest client and style entries resolve (the server entry, manifest.json, package.json and the .data scratch never do); a broken or unknown extension, a dotfile, or a traversal segment answers 404. Nothing is served with CL_EXTENSIONS=off", parameters: [{ name: 'id', in: 'path', required: true, schema: STR, description: 'the extension id, or <id>@<digits>: a generation, which serves exactly what the id does (a page reloading an extension asks a new one, so the relative imports of its entry resolve inside it and the module graph is fetched fresh); any other suffix answers 404' }, { name: 'path', in: 'path', required: true, schema: STR, description: 'path below the extension root' }], responses: { 200: { description: 'file' }, 404: err('not published by this extension') } },
            },

            '/api/characters': {
                get: {
                    tags: ['characters'],
                    summary: 'Query the library (windowed, sorted, filtered server-side)',
                    'x-collection': asPage(PAGE_DEFAULT, PAGE_MAX),
                    parameters: [
                        p('q', STR, 'search over the fields qIn names. name, nickname, creator, tags, listingName and tagline match q as one substring. The card-text fields (notes, description, firstMessage, altGreetings) match it word by word: every word must appear inside some word of those fields ("agon" finds "dragon"), capitals and accents ignored ("cafe" finds "café"), and a "quoted run" must appear as those whole words in that order. Punctuation separates words, so a q of punctuation alone matches no card text. The fields qIn names are ORed'),
                        p('qIn', CSV, 'fields q searches: name, nickname, creator, notes, tags, listingName, tagline, description, firstMessage, altGreetings (default: name,nickname,creator). The card-text fields answer from the full-text index, except a word found inside too many indexed words (most words of one or two letters), which reads the text of every card instead and is slower'),
                        p('match', STR, 'full-text search in FTS5 query syntax over name/creator/nickname/creator_notes/description/personality/scenario/first_mes/mes_example/system_prompt/alternate_greetings/post_history_instructions/depth_prompt: words AND by default, OR/NOT, "phrases", prefix*, column filters like description:dragon. Composable with every other filter'),
                        p('words', STR, 'plain text in place of match, over the same full-text columns: every word of two letters or more required, each matching as a prefix ("drag" finds "dragon"; a lone letter is passed over); a text with no such words matches no character. A filter takes it too'),
                        p('ids', CSV, 'restrict to these character uuids (bulk resolve/existence check)'),
                        p('notIds', CSV, 'leave out these character uuids (a selection over a filter that the reader deselected some of)'),
                        p('creator', STR, 'exact creator (case-insensitive)'),
                        p('tag', CSV, 'must carry EVERY listed tag (AND, case-insensitive)'),
                        p('anyTag', CSV, 'must carry at least one listed tag (OR)'),
                        p('excludeTag', CSV, 'must carry none of the listed tags'),
                        p('excludeTagAll', CSV, 'rejected only when carrying EVERY listed tag (the exclude-all mode)'),
                        p('provider', STR, 'linked to this provider id (chub, wyvern, ...)'),
                        p('linked', BOOL, 'linked to any provider (true) / to none (false)'),
                        p('hasUrl', BOOL, "the card holds an http substring anywhere: a cheap SUPERSET of every card with remote media, in any field (the media-localization prefilter)"),
                        p('fav', BOOL, 'favorites only / non-favorites only'),
                        p('locked', BOOL, 'update-locked only / unlocked only'),
                        p('mediaLocalized', BOOL, 'media localization completed (the bulk sweep skips these) / not yet'),
                        p('loreDismissed', BOOL, 'the embedded-lorebook hint was dismissed for this character / not'),
                        p('world', STR, 'exact primary lorebook name'),
                        p('hasWorld', BOOL, 'has a primary lorebook REFERENCE (extensions.world)'),
                        p('hasLorebook', BOOL, 'has an EMBEDDED character_book in the card'),
                        p('hasSystemPrompt', BOOL, 'card carries a non-empty system_prompt'),
                        p('altGreetingsMin', INT, 'at least this many alternate greetings; also altGreetingsMax'),
                        p('specVersion', STR, "exact card spec version, eg. '3.0' or '2.0'"),
                        p('tokensMin', INT, 'token estimate lower bound'),
                        p('tokensMax', INT, 'token estimate upper bound'),
                        p('createdAfter', INT, 'createdAt >= (ms); also createdBefore'),
                        p('importedAfter', INT, 'importedAt >= (ms); also importedBefore'),
                        p('updatedAfter', INT, 'updatedAt >= (ms); also updatedBefore'),
                        p('sort', { anyOf: [{ type: 'string', enum: ['name', 'created', 'imported', 'updated', 'tokens', 'relevance', 'random'] }, { type: 'string', pattern: '^ext\\.[a-z0-9][a-z0-9-]*\\.[a-z][a-zA-Z0-9_]*$' }] }, 'an unknown value is refused 400 naming the set; default name; relevance (bm25, best first) requires match or words and ranks at most 10000 characters: a match the filter leaves broader is refused 400 (narrow it, or sort by another key); random = uniform sample (offset-only, no cursor). An extension the account has on adds its declared sort keys as ext.<id>.<key> (listed in its inventory row\'s serverQuery): the characters with a value first, in its order, then the rest by name ascending whichever the order; offset-only, no cursor'),
                        p('order', { type: 'string', enum: ['asc', 'desc'] }, 'default asc'),
                        p('limit', INT, 'page size: default 100 (an ids request: its id count), at most 1000, or 10000 with idsOnly; past it, walk nextCursor with after. A whole library is never one answer'),
                        p('offset', INT, 'page start (with limit); cost grows with depth - prefer after for scrolling'),
                        p('after', STR, 'keyset cursor from a prior response nextCursor: O(page) at any depth. Not available with sort=relevance, sort=random or an extension\'s sort key'),
                        p('count', BOOL, 'count=false skips the total (null in the envelope): the count leg dominates broad queries on huge libraries; scroll clients use nextCursor for has-more'),
                        p('rules', STR, 'URL-encoded JSON array of structured filter rules [{field, op, value}] - the advanced-filter model evaluated server-side. Identity and library: name, nickname, creator, creatorNotes, version, listingName, tags, favorite, providerLink, playlist, playlistName, nameOverride, uid (the id of the character itself: contains or equals), tokens, cardSpec. Card text (unindexed: a rule reads the card of each character it tests, so it costs more the broader the set): description, personality, scenario, firstMessage, exampleDialogue, systemPromptText, postHistoryInstructions, depthPrompt. Presence: embeddedLorebook, systemPrompt, altGreetings, linkedLorebook. Dates: dateAdded, dateCreated, dateModified, lastChat. An extension the account has on adds its declared fields as ext.<id>.<key> (their ops are in its inventory row\'s serverQuery). Unknown field/op fails 400 naming the valid set'),
                        p('idsOnly', BOOL, 'project only {id, fav} per item (no tags or links) - select-all-matching, whose toolbar star reads fav, and cheap id enumeration; fields= adds more of each character to it'),
                        p('fields', CSV, 'a projection the verb names: with idsOnly, the fields to carry beside id and fav (name, creator, characterVersion, mediaLocalized, links); on a list, creatorNotes to carry the notes whole and creatorNotesExcerpt their plain-text excerpt, neither of which a row carries unless named. An unknown name is 400'),
                    ],
                    responses: { 200: json(ref('CharacterEnvelope')), 400: err('invalid parameter, match and words both, or sort=relevance over more than 10000 matching characters') },
                },
            },
            '/api/characters/match': {
                post: {
                    tags: ['characters'],
                    summary: `In-library match probe (max ${PROBE_MAX_KEYS} candidates): per remote card, the library's namesakes and how likely the card is already here. The name is read as the duplicate check reads it (version and edit suffixes and edge decoration stripped, compatibility-folded, lowercased, the part before a || as a name of its own) and matched against the exact name, names starting with it as a word (a space, dash, pipe, colon, comma or period after it) and names that are a word of it, the same over the page names provider links carry (answered with the page name as the row name); each row graded exact or prefix, a row the rule does not relate left out, a name under three characters relating to nothing. One row per (id, name). The score, 0 to 100: a namesake by the same creator 95 (a word prefix 70); a text within reach of a namesake's description, first message or creator notes 90 (70); otherwise the name alone, worth more the longer it is and the fewer authors hold it here, less when the card's creator is a known other one. Placeholder creators (anonymous, unknown and the like) are no author`,
                    requestBody: body({ type: 'object', required: ['candidates'], properties: { candidates: { type: 'array', items: { type: 'object', properties: { name: STR, creator: { ...STR, description: 'the remote card\'s creator, as the site shows it' }, text: { ...STR, description: `the site's own text for the card (a tagline, a blurb, a description); the first ${HINT_TEXT_MAX} characters are read` }, providers: { type: 'array', items: STR, maxItems: 8, description: 'the providers the site links its cards under' }, key: { ...STR, maxLength: 512, description: 'the card\'s key on that site (its id or path): a namesake linked to another listing there is weighed by the card\'s public description against its creator notes (the same card, the author\'s other card, or unplaced)' } } } } } }),
                    responses: { 200: json({ type: 'array', items: { type: 'object', properties: { variants: { type: 'array', items: STR, description: 'the candidate name as the rule reads it: its normalized variants of three characters or more' }, matches: { type: 'array', items: { type: 'object', properties: { id: STR, name: STR, creator: { ...STR, nullable: true }, relation: { type: 'string', enum: ['exact', 'prefix'] }, on: { ...STR, description: 'the candidate variant the row relates on' }, as: { ...STR, description: 'the variant of the row name it relates by' } } } }, total: { ...INT, description: 'how many namesakes relate; matches lists the first 16' }, score: { ...INT, description: 'how likely the card is already here, 0 to 100, over every namesake; 0 when none relates' }, basis: { type: 'string', enum: ['otherListing'], description: 'present when the score rests on a namesake linked to another listing of the card\'s own site that its public description neither confirms nor rules out (the score is then at most 65)' } } } }, 'aligned by candidate index'), 400: err('bad candidates'), 503: err('the library closed while the probe ran') },
                },
            },
            '/api/characters/duplicates': {
                get: {
                    tags: ['characters'],
                    summary: 'The duplicate scan over the library, on the server: every pair whose names relate (exactly, as a word of the other, or within a few letters) or whose description and first message are one text under two names, scored on both full cards. A pair by two different authors whose texts are far apart is never scored: a shared name alone is no duplicate. Two cards linked to different listings on one site are weighed by their own text (description or first message: at 0.6 word overlap the same card, under 0.3 another), else their creator notes (0.4 and 0.3); another card is never listed, one the text cannot place is listed with that reason. Characters linked to one provider path group at 100. Answers groups of ids with their scores, never the characters; a client reads the members it shows by id. One scan per library at a time, a second request joins it',
                    'x-collection': asWhole('a scan: groups of ids and scores, never rows'),
                    responses: { 200: json({ type: 'object', properties: { scanned: INT, ms: INT, groups: { type: 'array', items: { type: 'object', properties: { reference: STR, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, duplicates: { type: 'array', items: { type: 'object', properties: { id: STR, score: INT, confidence: STR, matchReason: STR, matchReasons: { type: 'array', items: STR }, breakdown: { type: 'object' }, contentIdentical: { type: 'boolean' }, strictIdentical: { type: 'boolean' } } } } } } } } }, 'groups best first: by confidence, then by the best score in the group') },
                },
            },
            '/api/characters/duplicates/match': {
                post: {
                    tags: ['characters'],
                    summary: 'One incoming card against the library (the pre-import check): the link arm (its provider path or id already linked here: inside providerId, exact or a path prefix either way; under the other providers, exact and only for a uuid key, which names one card wherever it is linked; with no providerId, exact under every provider), the name arm (every namesake, matched as POST /api/characters/match matches them), the creator arm (a creator the probe begins, its characters whose names relate loosely) and the text arm (a description that is the same text under another name), every candidate scored as the scan scores it (a candidate linked to another listing on the site the probe names, providerId with fullPath or externalId, is weighed as the scan weighs two listings: another card is left out, one its text cannot place is answered with that reason; textCompared says whether the two cards had their own text to compare). Answers matches by id with their scores, best first; a link hit scores 100',
                    requestBody: body({ type: 'object', description: 'a name, a fullPath or an externalId is required', properties: { name: STR, creator: STR, fullPath: STR, externalId: STR, providerId: STR, definition: { type: 'object', properties: { description: STR, first_mes: STR, personality: STR, scenario: STR, creator_notes: STR } } } }),
                    responses: { 200: json({ type: 'object', properties: { matches: { type: 'array', items: { type: 'object', properties: { id: STR, name: STR, score: INT, confidence: STR, matchReason: STR, breakdown: { type: 'object' }, contentIdentical: { type: 'boolean' }, strictIdentical: { type: 'boolean' }, textCompared: { type: 'boolean', description: 'both cards had their own description, first message or personality to compare; a reader cutoff reads only such a score' } } } } } }), 400: err('no name, fullPath or externalId'), 503: err('the library closed while the match ran') },
                },
            },
            '/api/characters/import': {
                post: {
                    tags: ['characters'],
                    summary: 'Import a card PNG (raw body). Never overwrites: triages to new (adopting a free embedded cl.uid as the id), identical-skip (content hash), or diverged-skip (uuid taken / provider link matched), with onExisting=copy as the force-new override',
                    parameters: [
                        p('name', STR, 'source filename hint, used for logging and the import summary. NOT an identity: two unrelated cards sharing a filename import as two characters. Identity heals through the embedded cl.uid / version_uid aliases and the provider link'),
                        p('onExisting', STR, "only 'copy' is accepted: force a new character that claims nothing. Absent runs the no-overwrite triage (new / identical-skip / diverged-skip); anything else is 400"),
                        p('source', STR, "the provider namespace this import came through. One link per character: a card embedding several provider namespaces keeps only one link, the source's, else the first in the namespaces order GET /api/extensions answers"),
                    ],
                    requestBody: { required: true, content: { 'image/png': { schema: { type: 'string', format: 'binary' } }, 'application/octet-stream': { schema: { type: 'string', format: 'binary', description: 'the bytes must still be a card PNG' } } } },
                    responses: { 200: json({ type: 'object' }, '{id, created, name, row}; created:false means it resolved onto an existing character; row is the character as GET /characters?ids= answers it, so the importer takes it in without a second read; the picture is /avatars/{id}.png'), 400: err('empty body, a bad onExisting, or a source that is not a provider namespace'), 415: err('not a PNG (other card files go through /import/stage)'), 422: err('no embedded card') },
                },
            },
            '/api/characters/import/stage': {
                post: {
                    tags: ['characters'],
                    summary: "Stage any card file for import: a card PNG, or a charx (Character Card V3's container: a zip with card.json at its root, or one written after a JPEG, as RisuAI downloads can be). The raw body streams to the account's staging folder and the card is read, not imported; a client may amend it (tags, a provider link) and commit with POST /import/stage/{stageId}. A stage keeps an hour. For a charx the card is answered as the import will store it: data.assets keeps the main icon as ccdefault: and drops the other embedded files, which become gallery rows",
                    parameters: [p('name', STR, 'source filename hint, as on /import: carried to the import as its sourceName, never an identity')],
                    requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
                    responses: {
                        200: json({ type: 'object', properties: {
                            stageId: STR,
                            format: { ...STR, enum: ['png', 'charx'] },
                            card: { type: 'object', description: 'the card normalized ({spec, spec_version, data}), as the import would store it: a PNG carrying both a V3 and a V2 copy answers the V3 one, with any field only the V2 copy holds kept beside it' },
                            picture: { type: 'boolean', description: 'whether the file carries a picture; a charx without one imports with a plain placeholder' },
                            media: { type: 'array', items: { type: 'object', properties: { name: STR, size: INT } }, description: "a charx's other embedded files, or the files a card PNG points at with __asset:N (RisuAI's chara-ext-asset_ chunks, which stay in the picture too): the gallery rows the commit adds (a name the character already holds is skipped)" },
                        } }),
                        400: err('empty body; or a charx the archive reader refuses: a member past the import cap, members unpacking past the archive budget, or a corrupt member (its local header, its checksum, or inflating past its declared size)'), 413: err('a card PNG past 100 MB'), 415: err('a Content-Type other than application/octet-stream, image/png, image/webp or image/jpeg (a form or JSON post is refused before it is read); or a body that is neither a card PNG nor a charx'), 422: err('no card in the file, or a card.json that is not JSON'),
                    },
                },
            },
            '/api/characters/import/stage/{stageId}': {
                post: {
                    tags: ['characters'],
                    summary: 'Import a staged card file, once: the card as staged, or the amended card from the body, with the file\'s picture as the avatar (a PNG minus its card chunks, any other image converted, a placeholder when a charx has none) and a charx\'s other embedded files as gallery rows. Triages exactly as /import does (new / identical-skip / diverged-skip; an identical skip still gains the gallery rows it lacks, a diverged one gains nothing). The stage is claimed first and gone once the import ran; a refusal (a bad amended card, or an extension\'s store guard) leaves it for another try',
                    parameters: [pathId('stageId', 'the id the stage call answered')],
                    requestBody: body({ type: 'object', properties: {
                        card: { type: 'object', description: 'the amended card (V1, V2 or V3 shape); omitted, the staged card imports. A charx card\'s embedded data.assets entries are folded again, so the stored card never points into the container' },
                        onExisting: { ...STR, enum: ['copy'], description: 'as on /import' },
                        source: { ...STR, description: 'as on /import: the provider namespace this import came through' },
                    } }, false),
                    responses: {
                        200: json({ type: 'object' }, '{id, created, name, media, row} (media: the gallery rows added; mediaFailed, when any: the files that could not be written, the import standing; row: the character as GET /characters?ids= answers it; the picture is /avatars/{id}.png), or {skipped, reason, id, created:false, name, media}'),
                        400: err('a stage id outside the uuid grammar, bad onExisting or source, or an amended card that is not a card'),
                        404: err('no such stage: committed, dropped, or kept past its hour'),
                        422: err('no card in the file'),
                    },
                },
                delete: {
                    tags: ['characters'], summary: 'Drop a stage without importing it',
                    parameters: [pathId('stageId', 'the id the stage call answered')],
                    responses: { 200: json(ref('Ok')), 400: err('a stage id outside the uuid grammar'), 404: err('no such stage') },
                },
            },
            '/api/characters/{id}/replace': {
                post: {
                    tags: ['characters'],
                    summary: 'Write an incoming card onto an existing character (the browse import\'s Replace): the import lands on this id, so the character keeps its id, favourite, update lock, chats, linked lorebooks, gallery, versions and every extension\'s data about it, its tags gain the card\'s (the Import Rules applied), the importing provider\'s link replaces its link, and the card (its embedded book included) and the picture are the incoming ones. The card as it stood, with its picture, is snapshotted first when either changes, the snapshot and the replace landing together or not at all ("Before Replace from <source>", a regular snapshot). The import routes never overwrite; this one names its target. Its aliases are recorded without taking one another character holds, and when the card changes its mediaLocalized flag is cleared (the incoming card brings its own remote media). A character whose regex scripts were allowed goes back to unanswered when the incoming card\'s scripts are not the ones allowed, so they wait for a new answer. An incoming card and picture equal to the ones held write nothing: no snapshot, no stamp, no report; a picture alone is written and reported without moving updatedAt. A card PNG body (image/png, ?source=), or JSON { stage, card?, source? } for a staged card file (the stage is claimed and gone once the replace ran; a refusal before the write hands it back; a charx\'s embedded files join the gallery under names it lacks, and a file that cannot be written is counted in mediaFailed, never a failed replace)',
                    parameters: [pathId(), p('source', STR, 'with a PNG body: the provider namespace the card came through, as on /import')],
                    requestBody: { required: true, content: {
                        'image/png': { schema: { type: 'string', format: 'binary' } },
                        'application/octet-stream': { schema: { type: 'string', format: 'binary', description: 'the bytes must still be a card PNG' } },
                        'application/json': { schema: { type: 'object', properties: {
                            stage: { ...STR, description: 'a stage id from /import/stage' },
                            card: { type: 'object', description: 'the amended card, as on the stage commit' },
                            source: { ...STR, description: 'as on /import' },
                        }, required: ['stage'] } },
                    } },
                    responses: {
                        200: json({ type: 'object' }, '{id, created:false, replaced:true, name, snapshot, row} (row: the character as GET /characters?ids= answers it; snapshot: the version id of the card as it stood, null when the card and the picture were the ones held; media with a staged charx: the gallery rows added; mediaFailed, when any: its files that could not be written)'),
                        400: err('no PNG and no stage, a stage id outside the uuid grammar, a bad source, or an amended card that is not a card'),
                        404: err('no such character, or no such stage'),
                        415: err('an image or octet-stream body that is not a card PNG (a charx is staged and sent as { stage }); any other body without a stage is a 400'),
                        422: err('no card in the file'),
                    },
                },
            },
            '/api/characters/{id}': {
                get: {
                    tags: ['characters'], summary: 'Full card (tags, links and the per-character flags composed in)',
                    parameters: [pathId()], responses: { 200: json(ref('Character')), 404: err('not found') },
                },
                patch: {
                    tags: ['characters'], summary: 'Dot-path card field updates and/or the per-character flags. Only what changes is written and reported: a patch that changes nothing writes nothing and reports nothing, and a change to the flags alone (fav, update lock, mediaLocalized, loreDismissed) leaves updatedAt where it was. updatedAt moves only when the content of the card itself changes: a change to its tags, its provider link or its lorebooks is written and reported but never moves it',
                    parameters: [pathId()],
                    requestBody: body({
                        type: 'object',
                        properties: {
                            fields: { type: 'object', description: "dot-path updates, eg. {'name': 'X', 'extensions.chub.tagline': 'Y'}; the root key must be a V2 or V3 card field or extensions (anything else is refused 400 naming the path, so a mistyped path never mints a junk key; custom data belongs under extensions); extensions.fav and extensions.update_locked set the favourite and update-lock flags (never stored in the card); an extensions.{provider} write sets the character's provider link (one link per character: a whole-namespace object REPLACES any existing link, null unlinks, and a nested write requires that namespace's link to exist), and tags sets its tags" },
                            fav: { type: 'boolean' },
                            mediaLocalized: { type: 'boolean', description: 'a per-character flag, like fav; never card content' },
                            loreDismissed: { type: 'boolean', description: 'a per-character flag, like fav; never card content' },
                        },
                    }),
                    responses: { 200: json(ref('Character')), 400: err('bad update, incl. a card that would lose its name'), 404: err('not found') },
                },
                delete: {
                    tags: ['characters'], summary: 'Delete a character with everything that is its own: chats, gallery, snapshots, its tag, lorebook, playlist and provider links, avatar and thumbnails',
                    parameters: [pathId()], responses: { 200: json(ref('Ok')), 404: err('not found') },
                },
            },
            '/api/characters/{id}/related': {
                get: {
                    tags: ['characters'], summary: 'Related characters, scored on the server: the rare words both cards use and the tags they share (spellings folded) on one scale, a small lift for the same creator; one item per character, the copies the duplicate check calls the same character listed under it (a shared name alone is no copy)',
                    'x-collection': asPage(20, 100, { walk: 'none' }),
                    parameters: [
                        pathId(),
                        p('limit', INT, 'the top N to answer: default 20, at most 100 (a ranked top N has no next page)'),
                        p('tags', BOOL, 'a false word (0, false, no) disables the shared-tags signal (default on)'),
                        p('creator', BOOL, 'a false word drops the same-creator lift (default on); at most five items are ever the creator\'s own either way'),
                        p('content', BOOL, 'a false word disables the shared-words signal (default on)'),
                    ],
                    responses: { 200: json({ type: 'object', properties: { items: { type: 'array', items: { type: 'object' } } } }, 'items strongest first: [{score (0 to 100), strength (strong, moderate or possible), breakdown: {content, tags, creator, sharedTagCount, topTags[{tag, weight, count}], terms[]}, matchReasons[], character: <list projection row>, copies: [<list projection row>] (at most ten copies of this character), copyCount (every copy found, the listed ones and any past ten)}]'), 400: err('a limit outside 1 to 100, or a bad flag'), 404: err('not found') },
                },
            },
            '/api/characters/{id}/link-match': {
                post: {
                    tags: ['characters'],
                    summary: `A provider site's search hits (max ${PROBE_MAX_KEYS}) ranked against this character by the duplicate check's rule, for linking it to a listing: each hit is read as a card with its name, its creator and its public text as creator notes, its listing title a name of it too, and scored as Find Duplicates scores a pair. A hit is confident, sure enough to link without asking, when its name or listing title is the character's exact name (version and edit suffixes folded) and either both carry the same real creator, or one side has no real creator (none, or a placeholder such as anonymous) and the hit's text is word for word the character's creator notes, description or first message over its length. Ranked confident first, then by score, then in the order sent`,
                    parameters: [pathId()],
                    requestBody: body({ type: 'object', required: ['hits'], properties: { hits: { type: 'array', minItems: 1, maxItems: PROBE_MAX_KEYS, items: { type: 'object', properties: { name: STR, creator: { ...STR, description: 'the creator the site shows for the hit' }, text: { ...STR, description: `the site's public description of the hit; the first ${HINT_TEXT_MAX} characters are read` }, listingName: { ...STR, description: 'the listing title, when the site names the card apart from its title' } } } } } }),
                    responses: { 200: json({ type: 'object', properties: { ranked: { type: 'array', items: { type: 'object', properties: { index: { ...INT, description: 'the hit\'s position in the request' }, score: INT, confidence: { type: 'string', enum: ['high', 'medium', 'low'], nullable: true }, confident: { type: 'boolean' }, matchReason: STR } } }, best: { ...INT, nullable: true, description: 'the index of the hit to link without asking, null when no hit is confident' } } }, 'every hit once, best first'), 400: err('no hits, more than the maximum, or not an array'), 404: err('not found'), 503: err('the library closed while the ranking ran') },
                },
            },
            '/api/characters/{id}/avatar': {
                put: {
                    tags: ['characters'], summary: 'Replace the avatar image (PNG bodies get card chunks stripped; other formats are converted to PNG server-side - avatars are pure images)',
                    parameters: [pathId()],
                    requestBody: { required: true, content: { 'image/*': { schema: { type: 'string', format: 'binary' } }, 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
                    responses: { 200: json(ref('Ok')), 400: err('empty body'), 404: err('not found'), 415: err('not a decodable image') },
                },
            },
            '/api/characters/{id}/export': {
                get: {
                    tags: ['characters'], summary: 'The character as a card file freshly built from the library (tags/links/identity re-emitted): a card PNG, or a CHARX holding the card as V3 with its picture and every gallery file',
                    parameters: [pathId(), p('format', { ...STR, enum: ['png', 'charx'] }, "png (the default) or charx. A charx of a V2 card says V3 in its card.json and records what the export added in extensions.cl.charx, so importing that file back gives the card as stored (identical); a file another app has changed since comes in as the V3 card it became")],
                    responses: { 200: { description: 'the file as an attachment', content: { 'image/png': { schema: { type: 'string', format: 'binary' } }, 'application/zip': { schema: { type: 'string', format: 'binary', description: 'a charx: card.json, assets/icon/image/main.png and one assets/other/... member per gallery file' } } } }, 400: err("a format other than png or charx"), 404: err('not found') },
                },
            },
            '/api/characters/{id}/media': {
                get: {
                    tags: ['media'], summary: 'A page of a character\'s gallery, in the order its rows were added (by id); a reader that needs the whole gallery walks nextCursor',
                    'x-collection': asPage(PAGE_DEFAULT, PAGE_MAX),
                    parameters: [pathId(), ...PAGE_PARAMS('rows')],
                    responses: { 200: json(pageSchema(ref('Media'))), 400: err('a limit outside 1 to 1000, an after that is not a cursor, or a count that is not a boolean word'), 404: err('character not found') },
                },
                post: {
                    tags: ['media'], summary: 'Upload media (raw body). A content-hash duplicate is not stored again ({skipped:true, reason: "content", duplicateOf}), and when that item has no sourceUrl the supplied one is recorded on it ({adopted:true}), so a later lookup by that url finds it',
                    parameters: [pathId(), p('name', STR, "display name; when the bytes are another kind of file than its extension says (a video named .png), the stored name takes the bytes' extension"), p('sourceUrl', STR, 'origin url; dedupes by url hash')],
                    requestBody: { required: true, content: { '*/*': { schema: { type: 'string', format: 'binary' } } } },
                    responses: { 200: json(ref('Media'), 'row, or {skipped:true} when already present'), 400: err('empty body, or a name with nothing usable as a filename'), 404: err('character not found') },
                },
            },
            '/api/characters/{id}/media/copy': {
                post: {
                    tags: ['media'], summary: 'Copy another character\'s whole gallery into this one, on the server: each file gets a new row and a new stored file, a file whose bytes or source url this character already holds is skipped, and a row whose file is gone is counted as missing. Display names are kept unless this character holds one already, and source urls ride along, so a later download of the same url is a skip',
                    parameters: [pathId()],
                    requestBody: body({ type: 'object', required: ['from'], properties: { from: { ...STR, description: 'the character whose gallery is copied' } } }),
                    responses: { 200: json({ type: 'object', properties: { copied: INT, skipped: INT, missing: INT } }, '{copied, skipped, missing}'), 400: err('from missing, or the same character'), 404: err('character not found (either one)') },
                },
            },
            '/api/characters/{id}/media/from-url': {
                post: {
                    tags: ['media'], summary: 'Server-side media download (no CORS, no proxy chain); dedupes by url hash, then by content hash. A content duplicate with no sourceUrl takes this url ({adopted:true} in the skip), so the next download of it is a url-hash skip; one already naming a different url keeps it',
                    parameters: [pathId()],
                    requestBody: body({ type: 'object', required: ['url'], properties: { url: STR, name: STR } }),
                    responses: { 200: json(ref('Media'), 'row, or {skipped:true} when already present'), 400: err('http(s) url required'), 403: err(NET_GUARD_REFUSAL), 404: err('character not found'), 413: err('file too large'), 415: err('not media'), 502: err('upstream failed, answered empty, or timed out') },
                },
            },
            '/api/characters/{id}/chats': {
                post: {
                    tags: ['chats'], summary: 'Create a chat. Bare: header from card + settings, message 0 = first_mes with macros applied, it and its alternate greetings then passing the chat\'s regex scripts that rewrite a message as it is written (alterSaved), chat_metadata holding the default Author\'s Note (note_prompt, note_interval, note_depth, note_position, note_role). With messages/header: stored as given (import/restore)',
                    parameters: [pathId()],
                    requestBody: body({
                        type: 'object',
                        properties: {
                            name: { ...STR, description: 'optional; default "{charName} - {timestamp}"' },
                            header: { type: 'object', description: 'optional; merged over the card/settings defaults (user_name, character_name, chat_metadata)' },
                            messages: { type: 'array', items: { type: 'object' }, description: 'optional; SillyTavern rows, stored verbatim when present (the greeting is NOT seeded). A ChatMessage is not a row: send its raw. seq and raw are refused on a row, since a stored row is exported as JSONL' },
                        },
                    }),
                    responses: { 200: json(ref('ChatDetail')), 400: err(`messages must be an array of objects, or ${RESERVED_KEYS_REFUSED}`), 404: err('character not found'), 409: err('name clash') },
                },
            },
            '/api/media/{mediaId}': {
                delete: { tags: ['media'], summary: 'Delete a media row + file', parameters: [pathId('mediaId', 'media row id')], responses: { 200: json(ref('Ok')), 404: err('not found') } },
            },
            '/api/chats/{id}/attachments': {
                get: {
                    tags: ['media'], summary: 'A chat\'s own gallery: the pictures and video it holds beside its character\'s, in the order they were added, each with how many of its messages show it',
                    'x-collection': asWhole('one chat\'s gallery'),
                    parameters: [pathId()],
                    responses: { 200: json({ type: 'object', properties: { items: { type: 'array', items: ref('Attachment') } } }), 404: err('chat not found') },
                },
                post: {
                    tags: ['media'], summary: 'Add a picture or video to the chat\'s gallery (raw body). Bytes the chat holds already answer that attachment, created false, and nothing is stored again. An image\'s size is read and kept',
                    parameters: [pathId(), p('name', STR, "display name; when the bytes are another kind of file than its extension says (a video named .png), the stored name takes the bytes' extension")],
                    requestBody: { required: true, content: { '*/*': { schema: { type: 'string', format: 'binary' } } } },
                    responses: { 200: json({ type: 'object', properties: { attachment: ref('Attachment'), created: { type: 'boolean' } } }), 400: err('empty body, or a name with nothing usable as a filename'), 404: err('chat not found'), 415: err('neither a picture nor video') },
                },
            },
            '/api/creator/sessions/{id}/attachments': {
                get: {
                    tags: ['creator'], summary: 'A studio session\'s own pictures, the references its author shows the partner, in the order they were added',
                    'x-collection': asWhole('one session\'s pictures'),
                    parameters: [pathId('id', 'session uuid')],
                    responses: { 200: json({ type: 'object', properties: { items: { type: 'array', items: ref('Attachment') } } }), 404: err('no such session') },
                },
                post: {
                    tags: ['creator'], summary: 'Add a picture to the session (raw body), for a turn to name. Bytes the session holds already answer that attachment, created false. An image\'s size is read and kept; the pictures go with the session when it is deleted',
                    parameters: [pathId('id', 'session uuid'), p('name', STR, "display name; when the bytes are another kind of file than its extension says (a video named .png), the stored name takes the bytes' extension")],
                    requestBody: { required: true, content: { '*/*': { schema: { type: 'string', format: 'binary' } } } },
                    responses: { 200: json({ type: 'object', properties: { attachment: ref('Attachment'), created: { type: 'boolean' } } }), 400: err('empty body, or a name with nothing usable as a filename'), 404: err('no such session'), 415: err('neither a picture nor video') },
                },
            },
            '/api/attachments/{attachmentId}': {
                delete: { tags: ['media'], summary: 'Remove an attachment and its file. Every message that showed it stops showing it; their ids are answered', parameters: [pathId('attachmentId', 'attachment id')], responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, messages: { type: 'array', items: INT, description: 'the ids of the messages that showed it' } } }), 400: err('an id that is not a positive integer'), 404: err('not found') } },
            },

            '/api/backgrounds': {
                get: {
                    tags: ['backgrounds'],
                    summary: 'The wallpaper library, newest first. Flat and NOT character-scoped: a background outlives the gallery it was promoted from. usedBy counts the bindings pointing at each row',
                    'x-collection': asWhole('the reader\'s wallpaper library'),
                    responses: { 200: json({ type: 'array', items: ref('Background') }) },
                },
                post: {
                    tags: ['backgrounds'],
                    summary: 'Upload image bytes (raw body). Deduped library-wide by content hash, and by url hash when ?sourceUrl= is given',
                    parameters: [p('name', STR, "display name; the bytes decide what the file is (a video named .png is refused), and the stored name takes their extension"), p('sourceUrl', STR, 'provenance, and makes a re-run idempotent')],
                    requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
                    responses: { 200: json(ref('Background'), 'row, or {skipped:true, reason:"url"|"content", duplicateOf} when the bytes are already held'), 400: err('empty body'), 415: err('not an image') },
                },
            },
            '/api/backgrounds/from-url': {
                post: {
                    tags: ['backgrounds'],
                    summary: 'Server-side download into the library. Images only; same dedup ladder as the upload',
                    requestBody: body({ type: 'object', required: ['url'], properties: { url: STR } }),
                    responses: { 200: json(ref('Background'), 'row, or {skipped:true}'), 400: err('http(s) url required'), 403: err(NET_GUARD_REFUSAL), 413: err('file too large'), 415: err('not an image'), 502: err('upstream failed or timed out') },
                },
            },
            '/api/backgrounds/from-media/{mediaId}': {
                post: {
                    tags: ['backgrounds'],
                    summary: 'Promote a gallery image into the library. The bytes are COPIED server-side, never shared with the media row, because media cascades away with its character',
                    parameters: [pathId('mediaId', 'media row id')],
                    responses: { 200: json(ref('Background'), 'row, or {skipped:true} when those bytes are already held'), 404: err('media or file not found'), 415: err('not an image') },
                },
            },
            '/api/backgrounds/{id}': {
                patch: {
                    tags: ['backgrounds'], summary: 'Rename: the display name alone changes; the file, its url and its format stay as they are',
                    parameters: [pathId('id', 'background row id')],
                    requestBody: body({ type: 'object', required: ['displayName'], properties: { displayName: STR } }),
                    responses: { 200: json(ref('Background')), 400: err('bad name'), 404: err('not found') },
                },
                delete: {
                    tags: ['backgrounds'],
                    summary: 'Delete the row + file. Refused while any binding points at it unless ?force=true, which deletes it and returns those scopes to inherited',
                    parameters: [pathId('id', 'background row id'), p('force', BOOL, 'delete even though it is in use')],
                    responses: { 200: json({ type: 'object' }, '{ok, unbound}'), 404: err('not found'), 409: err('in use; body carries usedBy') },
                },
            },
            '/api/backgrounds/resolve': {
                get: {
                    tags: ['backgrounds'],
                    summary: 'What this chat actually wears. Walks chat > character > global and stops at the FIRST binding, including one whose background is null (an explicit "nothing here" is an answer, not an absence)',
                    parameters: [p('chatId', STR, 'chat uuid (required)')],
                    responses: { 200: json(ref('ResolvedBackground')), 400: err('chatId is required') },
                },
            },
            '/api/backgrounds/bindings/{scope}': bindingOps(false),
            '/api/backgrounds/bindings/{scope}/{id}': bindingOps(true),

            '/api/chats/search': {
                get: {
                    tags: ['chats'],
                    summary: 'Full-text search across all chat messages, by an FTS5 match or by q, plain text (every word of two letters or more required, each a prefix); best match first with <mark> snippets, paged by offset (a rank order has no key to seek). The hits are ranked among the newest 10000 matching messages: a broader match is ranked there, and the envelope says capped: true',
                    'x-collection': asPage(SEARCH_PAGE_DEFAULT, SEARCH_PAGE_MAX, { walk: 'offset' }),
                    'x-requires-one-of': ['match', 'q'],
                    parameters: [
                        p('match', STR, 'FTS5 query; this or q'),
                        p('q', STR, 'plain text in place of match: every word of two letters or more required, each matching as a prefix (a lone letter is passed over); a text with no such words answers no hits'),
                        p('charId', STR, 'restrict to one character'),
                        p('limit', INT, `hits a page: default ${SEARCH_PAGE_DEFAULT}, at most ${SEARCH_PAGE_MAX}; past it, walk offset`),
                        p('offset', INT, 'page start'),
                        p('count', BOOL, 'count=false skips the total (null in the envelope), the expensive leg of a broad match'),
                    ],
                    responses: { 200: json(ref('ChatSearchEnvelope')), 400: err(`neither match nor q, or both, invalid FTS syntax, a limit outside 1 to ${SEARCH_PAGE_MAX}, an offset that is not a number, or a count that is not a boolean word`) },
                },
            },
            '/api/chats': {
                get: {
                    tags: ['chats'], summary: 'All chats (newest first by default), windowed on the server: search, rules, sort, grouping and keyset paging all run here. lastMes is truncated to a 200-char preview',
                    'x-collection': asPage(PAGE_DEFAULT, PAGE_MAX),
                    parameters: [
                        p('charId', STR, 'filter to one character'),
                        p('world', STR, "bound-world filter: exact name, or 'any' for bound-to-anything"),
                        p('q', STR, 'substring match on the chat name or its character name'),
                        p('rules', STR, 'URL-encoded JSON array of structured filter rules [{field, op, value}], the chats view\'s advanced-filter model evaluated server-side. Chat fields: chatName, charName, messageCount, messageText (contains / not_contains: a message\'s shown text holds every word of the value of two letters or more, each word a prefix; a value of no such words matches no message), lastMessage, chatLorebook. Character-scoped, read off the chat\'s character as the character list\'s rules read them: charFavorite, charTags, charProviderLink, charPlaylist. Unknown field/op fails 400 naming the valid set'),
                        p('sort', STR, 'recent | oldest | name | messages | created | character | chats (default recent). recent is the newest message, else the creation. character and chats order the characters (by name, by chat count; ties by their newest chat) and list each character\'s chats newest first'),
                        p('order', { type: 'string', enum: ['asc', 'desc'] }, 'flips the sort\'s own key (oldest is recent with order=asc); default is the sort\'s natural direction'),
                        p('grouped', BOOL, 'rows contiguous per character, ordered by a per-character key for the sort (its name for character, its chat count for chats, its newest chat for every other sort, flipped with recent/oldest), then the sort within the character; every row carries charChatCount'),
                        p('limit', INT, `rows a page: default ${PAGE_DEFAULT}, at most ${PAGE_MAX}; past it, walk nextCursor with after`),
                        p('offset', INT, 'ignored when after is given'),
                        p('after', STR, 'keyset cursor from a prior response nextCursor, over the sort\'s whole key (ties included): O(page) at any depth'),
                        p('count', BOOL, 'count=false skips the total (null in the envelope); scroll clients use nextCursor for has-more'),
                    ],
                    responses: { 200: json(ref('ChatEnvelope')), 400: err(`invalid parameter, a limit outside 1 to ${PAGE_MAX}, unknown sort, order, rule field or op, or a junk cursor`) },
                },
            },
            '/api/chats/active': {
                get: {
                    tags: ['chats'], summary: 'The chat the client currently has open (the activeChatId setting) resolved to its character, for an external integration (the ComfyUI gallery send). 404 when no chat is open or it is gone',
                    responses: {
                        200: json({ type: 'object', properties: { chatId: STR, chatName: STR, charId: STR, charName: STR } }),
                        404: err('no chat open, or the chat is gone'),
                    },
                },
            },
            '/api/chats/{id}': {
                get: {
                    tags: ['chats'], summary: 'Chat detail with messages (windowable), each a ChatMessage (its id, its seq, its time, who said it, its text, and the stored row as raw)',
                    parameters: [
                        pathId('id', 'chat uuid'),
                        p('msgLimit', INT, 'message page size'),
                        p('msgOffset', INT, 'message page start'),
                        p('msgTail', INT, 'the LAST n messages, returned in ascending seq order; wins over msgLimit/msgOffset (msgLimit=1 answers with the greeting, which is the other end)'),
                    ],
                    responses: { 200: json(ref('ChatDetail')), 400: err('msgLimit, msgOffset or msgTail is not a number'), 404: err('not found') },
                },
                patch: {
                    tags: ['chats'], summary: 'Rename and/or merge chatMetadata (null value deletes a key; chatMetadata.extensions merges one level deeper, by extension id, so a writer names only its own key and null removes it). chatMetadata.world_info is the chat lore binding: it sets the head of the chat worlds list (null or empty unlinks the head) and is never kept in chatMetadata itself, exactly like extensions.world on a card PATCH. chatMetadata.scenario, mes_example and system_prompt are the chat\'s own card texts (SillyTavern\'s Chat Character Settings Override, under its keys): each is read before the card\'s wherever the card\'s is (the prompt, every macro, the lore scan), an empty one is none, null removes it, and anything but text is refused',
                    parameters: [pathId('id', 'chat uuid')],
                    requestBody: body({ type: 'object', properties: { name: STR, draft: { ...STR, nullable: true, description: 'the composer text not yet sent; null or empty clears it. Never exported, never moves updatedAt' }, chatMetadata: { type: 'object', properties: { scenario: { ...STR, nullable: true, description: 'this chat\'s scenario, read instead of the card\'s' }, mes_example: { ...STR, nullable: true, description: 'this chat\'s example dialogue, read instead of the card\'s' }, system_prompt: { ...STR, nullable: true, description: 'this chat\'s main prompt, read instead of the card\'s own system prompt' } } }, personaId: { ...STR, nullable: true, description: 'per-chat persona override; null CLEARS it so the chat follows the global persona again, omitted leaves it alone' }, profileId: { ...STR, nullable: true, description: 'this chat\'s own connection; null CLEARS it so the chat follows the default for chats again, omitted leaves it alone. Never moves updatedAt' }, presetId: { ...STR, nullable: true, description: 'this chat\'s own prompt preset; null CLEARS it so the chat follows the active preset again, omitted leaves it alone. Never moves updatedAt' } } }),
                    responses: { 200: json(ref('Ok')), 400: err('a persona, a connection or a preset that does not exist or is named by something other than a string, a chat card text that is not text, or a draft that is not'), 404: err('not found'), 409: err('name clash') },
                },
                delete: { tags: ['chats'], summary: 'Delete a chat + its messages', parameters: [pathId('id', 'chat uuid')], responses: { 200: json(ref('Ok')), 404: err('not found') } },
            },
            '/api/chats/{id}/prompt': {
                get: {
                    tags: ['chats'],
                    summary: 'The prompt this chat would send right now: the real assembled messages with macros expanded and lore injected, plus the budget figures. Built on demand and stored nowhere (a dry build: nothing its macros set is kept); a debug surface for seeing what the model is actually given. A build error carries the {error, kind} envelope the generate and llm routes use; a bad firstShown is a plain {error} 400',
                    parameters: [pathId('id', 'chat uuid'), p('firstShown', INT, 'the first message the reader\'s screen shows, which {{firstDisplayedMessageId}} answers')],
                    responses: {
                        200: json({
                            type: 'object',
                            properties: {
                                charName: STR, userName: STR,
                                budget: { type: 'object' },
                                messages: { type: 'array', items: { type: 'object', properties: { role: STR, content: STR, unanswered: { type: 'array', items: STR, description: 'present when the message holds macros no vocabulary of this build answers: their names, lower-case; the text is sent as it is' }, images: { type: 'array', description: 'the pictures this turn sends, by reference (a chat picture or the character\'s portrait) with their name; a character\'s pictures ride a user turn just before its reply', items: { type: 'object' } } } } },
                                pictures: { type: 'object', description: 'the pictures of this build: sent (the character\'s picture included), the window\'s stood in as text to fit the budget or the connection\'s picture limit (the oldest first, the newest message\'s never), or withheld because the connection does not see pictures', properties: { sent: INT, stoodIn: INT, withheld: INT } },
                            },
                        }),
                        400: err('a firstShown that is not a message seq ({error}); or a build the server refuses ({error, kind: bad_request}), eg. the over-budget refusal'),
                        404: err('not found'),
                    },
                },
            },
            '/api/chats/{id}/authors-note': {
                get: {
                    tags: ['chats'],
                    summary: "The chat's Author's Note as the next build reads it. The note lives in chatMetadata under ST's keys (note_prompt, note_interval, note_depth, note_position, note_role) and is written through PATCH /chats/{id} chatMetadata; a part the chat does not hold reads the default's (settings chatAuthorsNoteDefault*), until a reply's commit stores them. position: 0 after the main prompt, 1 in the chat at depth, 2 before the main prompt; role: 0 system, 1 user, 2 assistant. due and untilNext count the reader's messages over the whole chat (interval 1 every one, 0 never; untilNext the true count left, null at a frequency of 0)",
                    parameters: [pathId('id', 'chat uuid')],
                    responses: {
                        200: json({
                            type: 'object',
                            properties: {
                                note: {
                                    type: 'object',
                                    description: 'the note in force; own says which parts are the chat\'s rather than the default\'s',
                                    properties: {
                                        prompt: STR, interval: { type: 'number' }, depth: { type: 'number' }, position: { type: 'number' }, role: { type: 'number' },
                                        own: { type: 'object', properties: { prompt: { type: 'boolean' }, interval: { type: 'boolean' }, depth: { type: 'boolean' }, position: { type: 'boolean' }, role: { type: 'boolean' } } },
                                    },
                                },
                                defaults: { type: 'object', properties: { prompt: STR, interval: { type: 'number' }, depth: { type: 'number' }, position: { type: 'number' }, role: { type: 'number' } } },
                                scanLore: { type: 'boolean', description: 'whether the due note and the card\'s Character\'s Note are read by every lore entry\'s scan' },
                                userTurns: { ...INT, description: 'the reader\'s messages in the chat, hidden ones included' },
                                due: { type: 'boolean', description: 'whether a build now sends the note' },
                                untilNext: { ...INT, nullable: true, description: 'the reader\'s messages until a reply carries it, 0 when one now does, null at a frequency of 0 (the true count, not ST\'s counter)' },
                            },
                        }),
                        404: err('chat not found'),
                    },
                },
            },
            '/api/chats/{id}/lore': {
                get: {
                    tags: ['chats'],
                    summary: 'The lore state for a chat: every book in force (character links, the chat binding, the resolved persona\'s books, then the global list), all of their entries, and which entries FIRE against the current history as the next build on the chat\'s own connection reads it (a message of pictures alone counts only when that connection sees pictures). Evaluated as a DRY RUN of the same scan the prompt uses (probability counts as pass and is reported as probabilityPending; a weighted inclusion group keeps every member that can win, each reported with its odds as groupPending; sticky/cooldown state is read, never advanced), so it cannot disagree with what gets sent. Per entry: fired, probabilityPending, groupPending, suppressedReason (why the engine held it back this scan), timed (remaining sticky/cooldown turns), advanced (the honoured ST fields: probability, sticky/cooldown/delay, groups, recursion flags, triggers, character filter, extra match sources) outlet (the outlet a fired outlet entry is held for, placed where {{outlet::name}} is written) and notHonoured (vectorized, automationId, which nothing here implements). sources says how a book is reached; an entry is addressed by world + uid, never uid alone',
                    parameters: [pathId('id', 'chat uuid')],
                    responses: { 200: json(ref('ChatLoreState')), 404: err('not found') },
                },
            },
            '/api/chats/{id}/worlds': {
                get: { tags: ['worlds'], summary: "The chat's own lorebooks, ordered (head = world_info in the exported JSONL header)", 'x-collection': asWhole('the chat\'s ordered book list, written whole by its PUT'), parameters: [pathId('id', 'chat uuid')], responses: { 200: json({ type: 'array', items: STR }), 404: err('chat not found') } },
                put: {
                    tags: ['worlds'], summary: 'Replace the whole list (a name with no book is refused with 400)',
                    parameters: [pathId('id', 'chat uuid')],
                    requestBody: body({ type: 'object', required: ['worlds'], properties: { worlds: { type: 'array', items: STR } } }),
                    responses: { 200: json({ type: 'object' }, '{ok, worlds}'), 400: err('bad list'), 404: err('chat not found') },
                },
            },
            '/api/chats/{id}/worlds/apply': {
                post: {
                    tags: ['worlds'], summary: 'Atomic add/remove on the chat list (appends after the tail; reports only actual changes, plus the resulting list)',
                    parameters: [pathId('id', 'chat uuid')],
                    requestBody: body({ type: 'object', properties: { add: { type: 'array', items: STR }, remove: { type: 'array', items: STR } } }),
                    responses: { 200: json({ type: 'object' }, '{ok, added, removed, worlds}'), 400: err('nothing to add or remove'), 404: err('chat not found') },
                },
            },
            '/api/chats/worlds/apply': {
                post: {
                    tags: ['worlds'],
                    summary: 'Add/remove books on a set of chats, all or nothing (the /api/char-worlds/apply sibling, at most 1000 chatIds a request). Appends land after each chat\'s tail; unknown chatIds are skipped and reported; deltas count only actual changes, each with the chat\'s resulting list; a name with no book is refused with 400 before anything is written',
                    requestBody: body({ type: 'object', properties: { chatIds: { type: 'array', items: STR, maxItems: 1000 }, add: { type: 'array', items: STR }, remove: { type: 'array', items: STR } }, required: ['chatIds'] }),
                    responses: { 200: json({ type: 'object' }, '{ok, touched, affected, skipped, deltas: [{chatId, added, removed, worlds}]}'), 400: err('no chatIds, more than 1000, nothing to add or remove, or a name with no book') },
                },
            },
            '/api/chats/{id}/branch': {
                post: {
                    tags: ['chats'], summary: 'Branch the chat at one message, as SillyTavern branches: a new chat for the same character holding every message up to it as stored, the chat metadata whole with main_chat naming this chat (its own card texts, variables, timed lore and pick hash with it), its lorebook list, persona and wallpaper, never its draft nor its assistant sessions (conversations about this chat as it stood). Named "<this chat> - Branch #n", the first free n. Its created record carries branchOf { chatId, seq }',
                    parameters: [pathId('id', 'chat uuid')],
                    requestBody: body({ type: 'object', required: ['seq'], properties: {
                        seq: { ...INT, description: 'the message the branch ends on' },
                        swipeId: { ...INT, description: 'optional: the alternate the branch\'s last message shows, selected as a swipe pick selects it (its generation record with it), in the same write' },
                        messageId: { ...INT, description: 'optional: the id of the message the reader branched from; another message at that seq now refuses the branch (409), no chat made' },
                    } }),
                    responses: { 200: json(ref('ChatDetail')), 400: err('seq is not a message seq, swipeId is not an alternate of that message, or a messageId that is not a message id'), 404: err('chat or message not found'), 409: err(SHOWN_CHANGED) },
                },
            },
            '/api/chats/{id}/messages': {
                put: {
                    tags: ['chats'], summary: 'Replace the full message array; the chat\'s message count and preview follow. The messages are NEW: each gets a new id, and what was keyed on the old ids (an extension\'s records about a message) goes with them',
                    parameters: [pathId('id', 'chat uuid')],
                    requestBody: body({ type: 'object', required: ['messages'], properties: { messages: { type: 'array', items: { type: 'object' }, description: 'SillyTavern rows; a ChatMessage is not a row: send its raw' } } }),
                    responses: { 200: json(ref('Ok')), 400: err(`messages is not an array of objects, ${RESERVED_KEYS_REFUSED}, or a message whose extra.attachments names a picture that is not this chat\'s or is not a picture`), 404: err('not found') },
                },
                post: {
                    tags: ['chats'], summary: 'Append one user turn (server stamps name/date/seq). The chat\'s regex scripts that rewrite a message as it is written (alterSaved) apply to the text first, at the reader\'s placement; then its macros are expanded once, now, and it is stored as expanded, as SillyTavern stores a sent message: a roll is rolled and a variable set once, and a prompt sends the stored text',
                    parameters: [pathId('id', 'chat uuid')],
                    requestBody: body({ type: 'object', properties: { mes: { ...STR, description: 'the text; empty is allowed when attachments name pictures' }, attachments: { type: 'array', items: INT, description: 'pictures from the chat\'s own gallery this turn shows, in order' }, firstShown: { ...INT, description: 'the first message the reader\'s screen shows, which {{firstDisplayedMessageId}} answers' } } }),
                    responses: { 200: json({ type: 'object', properties: { id: { ...INT, description: 'the stored message\'s id' }, seq: INT, message: ref('ChatMessage') } }), 400: err('neither mes nor attachments, an attachment that is not this chat\'s picture, or firstShown is not a message seq'), 404: err('not found') },
                },
            },
            '/api/chats/{id}/messages/{seq}': {
                patch: {
                    tags: ['chats'],
                    summary: 'Patch ONE message by row seq (shallow merge; null value deletes a key). extra MERGES key by key, a null leaf deleting it, because the bag is shared with the server\'s own generation record (reasoning, usage, interrupted, edited, guidance) and a whole-object write would put back whatever the caller\'s copy predates; extra.hidden is boolean or null, extra: null drops the bag, and a dotted key is refused (message fields are not dot-paths). mes always tracks the active alternate: a supplied mes is written into swipes[swipe_id], otherwise mes is re-read from it. A supplied mes that differs from the stored text first passes the chat\'s regex scripts that rewrite a message as it is written and run on edit (alterSaved with runOnEdit), and the active alternate is stamped extra.edited (ms epoch): from then on a regex script changing the text itself (neither markdownOnly nor promptOnly) and not set to runOnEdit leaves that message as written, on screen and in the prompt. So does the generation record of each alternate (extra.reasoning, usage, interrupted, edited and guidance): when another alternate becomes the active one (a swipe_id picked, one added, the active draft dropped), the one left keeps its record in the extra of its swipe_info entry and the record of the chosen one comes into extra, none when it has none; an edit of the active text moves nothing. The body is SillyTavern row fields: a seq or raw key is refused (the native shape\'s keys; a stored row is exported verbatim as JSONL). shown is not a field: it names the active alternate the reader was shown, and a message holding another refuses the patch with 409, so an edit from a screen that is behind the server never rewrites an alternate it did not show. Message 0, when it is the character\'s and not hidden, is stored with its macros expanded (SillyTavern expands a chat\'s first message as it shows), whatever the patch changed',
                    parameters: [pathId('id', 'chat uuid'), pathId('seq', 'message row seq'), MESSAGE_ID],
                    requestBody: body({
                        type: 'object',
                        properties: {
                            mes: STR,
                            swipes: { type: 'array', items: STR, description: 'alternates; index swipe_id is the active one' },
                            swipe_id: INT,
                            swipe_info: { type: 'array', items: { type: 'object' }, description: 'one entry per alternate, as SillyTavern keeps them; the extra of an entry holds the generation record of its alternate (reasoning, usage, interrupted, edited, guidance)' },
                            extra: { type: 'object', nullable: true, description: 'per-message flags, MERGED key by key: { hidden: true } hides the row from the prompt, { hidden: null } deletes that leaf and touches nothing else; hidden must be boolean or null; null for the whole field drops the bag' },
                            name: STR,
                            is_system: { type: 'boolean' },
                            shown: SHOWN_ACTIVE('this message, never written as a field of it'),
                        },
                    }),
                    responses: {
                        200: json({ type: 'object', properties: { id: { ...INT, description: 'the message\'s id' }, seq: INT, message: ref('ChatMessage'), swipeId: { ...INT, nullable: true } } }),
                        400: err('bad seq / empty patch / seq or raw in body / a dotted key / extra not an object / extra.hidden not boolean / extra.attachments naming a picture that is not this chat\'s or is not a picture / a messageId that is not a message id / a shown that is not { index, count, text } (an index outside the count, a count under 1, a text that is not a string)'),
                        404: err('chat or message not found'),
                        409: err(`${SHOWN_CHANGED}; or ${ACTIVE_CHANGED}`),
                    },
                },
                delete: {
                    tags: ['chats'],
                    summary: 'Delete ONE message and close the gap so seqs stay 0..n-1 (every later message moves down one, its id kept); returns the NEW seq list so a client can re-key without a refetch',
                    parameters: [pathId('id', 'chat uuid'), pathId('seq', 'message row seq'), MESSAGE_ID],
                    responses: {
                        200: json({ type: 'object', properties: { ok: { type: 'boolean' }, seqs: { type: 'array', items: INT } } }),
                        400: err('bad seq, or a messageId that is not a message id'),
                        404: err('chat or message not found'),
                        409: err(SHOWN_CHANGED),
                    },
                },
            },
            '/api/chats/{id}/messages/{seq}/swipes': {
                post: {
                    tags: ['chats'],
                    summary: 'Add ONE alternate to a message and make it the active one (mes is its text), as a swipe adds one; a message with none first takes its text as its first alternate. The alternate left keeps its generation record (extra.reasoning, usage, interrupted, edited and guidance) in its swipe_info entry, and the new one starts with none. count names the alternates the reader was shown: when the message holds another count now (an alternate added or dropped elsewhere since it was read), the write is refused with 409 and nothing is written. Message 0, when it is the character\'s and not hidden, is stored with its macros expanded, as a patch stores it',
                    parameters: [pathId('id', 'chat uuid'), pathId('seq', 'message row seq')],
                    requestBody: body({ type: 'object', required: ['text', 'count'], properties: {
                        text: { ...STR, description: 'the alternate added, not blank' },
                        count: { ...INT, description: 'the alternates the reader was shown: swipes.length, 1 for a message with none' },
                        messageId: { ...INT, description: 'optional: the id of the message the reader was shown at this seq; another message there now refuses the write (409)' },
                    } }),
                    responses: {
                        200: json({ type: 'object', properties: { id: { ...INT, description: 'the message\'s id' }, seq: INT, message: ref('ChatMessage'), swipeId: INT } }),
                        400: err('bad seq, a blank or missing text, a count that is not a positive integer, or a messageId that is not a message id'),
                        404: err('chat or message not found'),
                        409: err(`${SHOWN_CHANGED}; or the message holds another count of alternates than the one named: that message's alternates changed since they were shown; nothing was written`),
                    },
                },
            },
            '/api/chats/{id}/messages/{seq}/swipes/delete': {
                post: {
                    tags: ['chats'],
                    summary: 'Drop ONE alternate of a message, named by its index AND the text it holds, beside the alternates count the reader was shown: when any of the three differs from the stored message (an alternate added, dropped or rewritten elsewhere since it was read) the write is refused with 409 and nothing is removed, so a reader is never made to drop an alternate it did not see. The selection stays on its alternate; dropping the active one makes the next the active one (the new last when it was last), mes follows it, and its generation record (extra.reasoning, usage, interrupted, edited and guidance) comes into extra while the dropped one\'s goes with it. A message keeps one alternate: the last goes only with the message (DELETE /api/chats/{id}/messages/{seq}). Message 0, when it is the character\'s and not hidden, is stored with its macros expanded, as a patch stores it',
                    parameters: [pathId('id', 'chat uuid'), pathId('seq', 'message row seq')],
                    requestBody: body({ type: 'object', required: ['index', 'text', 'count'], properties: {
                        index: { ...INT, description: 'the alternate dropped, 0 to count - 1' },
                        text: { ...STR, description: 'the text that alternate held as shown' },
                        count: { ...INT, description: 'the alternates the reader was shown, 2 or more' },
                        messageId: { ...INT, description: 'optional: the id of the message the reader was shown at this seq; another message there now refuses the write (409)' },
                    } }),
                    responses: {
                        200: json({ type: 'object', properties: { id: { ...INT, description: 'the message\'s id' }, seq: INT, message: ref('ChatMessage'), swipeId: INT } }),
                        400: err('bad seq, a count under 2, an index outside the count, a text that is not a string, or a messageId that is not a message id'),
                        404: err('chat or message not found'),
                        409: err(`${SHOWN_CHANGED}; or the message holds another count of alternates, or another text at that index: that message's alternates changed since they were shown; nothing was written`),
                    },
                },
            },
            '/api/chats/{id}/generate': {
                post: {
                    tags: ['chats'],
                    summary: 'Generate the next assistant turn: server-side prompt assembly (card + history + persona + lore) streamed as normalized SSE (chunk/done/error). '
                        + 'The reply and its reasoning pass the chat\'s regex scripts that rewrite a message as it is written (alterSaved) before they are stored; a continue stores the text so far and the new part as the message\'s text scripts write them. '
                        + 'The row is stored server-side before the done event, which carries {message, id, seq, swipeId, budget} on top of the usual finishReason/usage (message a ChatMessage; firstMessage, when the build expanded and stored the greeting, the same). An impersonation stores nothing; its done carries draft, the text with the chat\'s regex scripts for user input applied. '
                        + 'budget is {tokens, trimmed, maxContext, reserve, firstSeq, windowed}; firstSeq is the seq of the oldest message that still fit, which is the only value a client can draw a context marker from. '
                        + 'A timed-out or mid-stream-failed generation stores what streamed, marked extra.interrupted with the error kind (timeout | upstream | network | rate_limit | auth | context | quota | bad_request | error). '
                        + 'A client hang-up (the stop button, or a dropped socket: the server cannot tell them apart) DISCARDS the fragment by default, because stopping usually means the reply was going wrong; '
                        + 'set the chatKeepInterrupted setting to keep it instead, stored with reason "stopped". '
                        + 'Sampling params are the profile defaults under this request body; a preset never contributes them, because samplers belong to the connection. '
                        + 'Chat messages go to the model as stored, through the chat\'s regex scripts for the prompt; the chat\'s first message is expanded again and the expansion stored. What the prompt\'s macros set (variables, the pick hash) is kept, with the lore\'s timed state and the first message in context, before the stream. A build that would send nothing (a preset whose blocks in force all send nothing for the mode) is refused with a 400 before any of that is kept, as a chat that does not fit its budget is',
                    parameters: [pathId('id', 'chat uuid')],
                    requestBody: body({
                        type: 'object',
                        properties: {
                            profileId: { ...STR, description: 'the connection that answers this one request; omitted, the chat\'s own connection answers, else the default for chats, else the first' },
                            params: { type: 'object' },
                            mode: {
                                type: 'string', enum: GENERATE_MODES,
                                description: 'append (default) adds a message; regenerate rewrites targetSeq in place (without a targetSeq, the trailing message when it is a reply; a chat ending on the user\'s turn gains a new reply); '
                                    + 'swipe pushes an alternate onto targetSeq and excludes it from the prompt; continue appends into targetSeq and clears its interrupted marker; '
                                    + "impersonate writes the USER's next line as a draft: it streams back and stores NOTHING",
                            },
                            targetSeq: { ...INT, description: 'regenerate/swipe/continue; defaults to the trailing row. Must be a non-user, non-system message' },
                            targetId: { ...INT, description: 'optional, beside targetSeq: the id of the message the reader was shown there (without targetSeq, of the trailing message). Another message there now refuses the generation with a 409 before the model is asked; left out, the target is whichever message holds the seq at the resolve' },
                            targetShown: SHOWN_ACTIVE('the target message (regenerate/swipe/continue), checked before the model is asked, so a reroll, a swipe or a continue from a screen that is behind the server never rewrites or grows an alternate it did not show'),
                            firstShown: { ...INT, description: 'the first message the reader\'s screen shows, which {{firstDisplayedMessageId}} answers' },
                            guidance: { ...STR, description: "steering text that rides as a trailing budget-measured system instruction, never as transcript content. On impersonate it directs the user-side draft; on append it makes a GUIDED REPLY: the character's next turn follows the direction (template: the preset's guidedInstruction setting), and the reply stores it as extra.guidance. A swipe or a regenerate that sends none follows its target's own (the shown alternate's extra.guidance), so another take on a directed reply is directed the same way; one that sends its own uses that. Ignored by continue" },
                        },
                    }),
                    responses: { 200: { description: 'text/event-stream' }, 400: err('bad chat/profile/mode/target, firstShown is not a message seq, a targetId that is not a message id, or a targetShown that is not { index, count, text }'), 404: err('chat or target message not found'), 409: err(`${SHOWN_CHANGED}; or ${ACTIVE_CHANGED}`), 502: err('upstream failure') },
                },
            },
            '/api/chats/{id}/export': {
                get: { tags: ['chats'], summary: 'ST-shaped JSONL (header line + messages)', parameters: [pathId('id', 'chat uuid')], responses: { 200: { description: 'JSONL attachment' }, 404: err('not found') } },
            },

            '/api/assistant/defaults': {
                get: {
                    tags: ['assistant'],
                    summary: 'The built-in assistant role text, as the server sends it, so a settings panel can offer it as the starting point for a custom prompt',
                    responses: { 200: json({ type: 'object', properties: { systemPrompt: STR } }) },
                },
            },
            '/api/assistant/sessions': {
                get: {
                    tags: ['assistant'],
                    summary: 'The assistant sessions bound to one chat, newest first, WITHOUT their transcripts (messageCount only)',
                    'x-collection': asWhole('one chat\'s sessions, without transcripts'),
                    parameters: [p('chatId', STR, 'chat uuid')],
                    responses: { 200: json({ type: 'array', items: ref('AssistantSession') }), 400: err('chatId required') },
                },
                post: {
                    tags: ['assistant'], summary: 'Start a session on a chat; the name defaults to a numbered one',
                    requestBody: body({ type: 'object', required: ['chatId'], properties: { chatId: STR, name: STR } }),
                    responses: { 201: json(ref('AssistantSession')), 400: err('chatId required'), 404: err('chat not found') },
                },
            },
            '/api/assistant/sessions/{sid}': {
                get: {
                    tags: ['assistant'], summary: 'One session WITH its transcript',
                    parameters: [pathId('sid', 'session uuid')],
                    responses: { 200: json(ref('AssistantSession')), 404: err('not found'), 500: err(TRANSCRIPT_UNREADABLE) },
                },
                patch: {
                    tags: ['assistant'],
                    summary: 'Rename a session or bind it to an LLM profile. A rename deliberately does NOT move updatedAt, because the session list is ordered by it and renaming something should not reshuffle the list',
                    parameters: [pathId('sid', 'session uuid')],
                    requestBody: body({ type: 'object', properties: { name: STR, profileId: { ...STR, nullable: true } } }),
                    responses: { 200: json(ref('AssistantSession')), 400: err('blank name / nothing to change'), 404: err('not found') },
                },
                delete: { tags: ['assistant'], summary: 'Delete a session', parameters: [pathId('sid', 'session uuid')], responses: { 200: json(ref('Ok')), 404: err('not found') } },
            },
            '/api/assistant/sessions/{sid}/messages': {
                post: {
                    tags: ['assistant'],
                    summary: 'Append ONE message. There is deliberately no whole-transcript write: the server does the read-modify-write, so a client holding stale state can never overwrite real history with its own copy of it',
                    parameters: [pathId('sid', 'session uuid')],
                    requestBody: body({ type: 'object', properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { ...STR, description: 'the text; empty is allowed when pictures are named' }, pictures: { type: 'array', description: 'a reader turn\'s pictures, in order: { kind, id } of the chat\'s character (its portrait or a gallery image) or the chat\'s own pictures, each held to it; stored on the turn with its name and size', items: { type: 'object', required: ['kind', 'id'], properties: { kind: { type: 'string', enum: ['avatar', 'media', 'attachment'] }, id: { description: 'a character id for avatar, a media or attachment id for the others' } } } }, retry: { type: 'object', description: 'a Try again on a reader turn: the reply by its stamp (at) and the changes of it to try again (ids). While it is the last reader turn, the model is sent each change as written and where it stands now', required: ['at', 'ids'], properties: { at: INT, ids: { type: 'array', items: STR }, shown: { type: 'array', description: 'optional: each change as the client showed it, aligned with ids; one the reply now holds otherwise under its id answers 409', items: { type: 'object' } } } } } }),
                    responses: { 200: json({ type: 'object', properties: { seq: INT, message: { type: 'object' } } }), 400: err('a bad role, neither content nor pictures, pictures on a reply, a picture the session may not show, or a retry on a reply'), 404: err('not found'), 409: err('session changed underneath the write, or a retry naming a reply, or a change of it, that changed since it was shown'), 500: err(TRANSCRIPT_UNREADABLE) },
                },
            },
            '/api/assistant/sessions/{sid}/messages/{seq}': {
                patch: {
                    tags: ['assistant'],
                    summary: 'Patch one transcript message. extra MERGES rather than replacing, so recording that one proposal was applied cannot drop the context snapshot stored beside it',
                    parameters: [pathId('sid', 'session uuid'), pathId('seq', 'transcript index'), p('at', INT, 'the stamp (at) of the turn the reader was shown; when given and the turn now at seq carries another, the write is refused with 409')],
                    requestBody: body({ type: 'object', properties: { content: STR, extra: { type: 'object' } } }),
                    responses: { 200: json({ type: 'object', properties: { seq: INT, message: { type: 'object' } } }), 400: err('bad seq / bad at / nothing to change'), 404: err('not found'), 409: err('the turn at seq is not the one the reader was shown (the transcript changed since)'), 500: err(TRANSCRIPT_UNREADABLE) },
                },
                delete: {
                    tags: ['assistant'],
                    summary: 'Remove a turn: mode=one splices just that message, for tidying a stray turn; the default TRUNCATES from there, since the only reason to remove an assistant turn is to ask for a different one and the turns that answered it would otherwise be left behind as non sequiturs',
                    parameters: [pathId('sid', 'session uuid'), pathId('seq', 'transcript index'), p('mode', { type: 'string', enum: ['one', 'truncate'] }, 'default truncate'), p('at', INT, 'the stamp (at) of the turn the reader was shown; when given and the turn now at seq carries another, the write is refused with 409')],
                    responses: { 200: json({ type: 'object', properties: { kept: INT, remaining: INT } }), 400: err('bad seq / bad mode / bad at'), 404: err('not found'), 409: err('the turn at seq is not the one the reader was shown (the transcript changed since)'), 500: err(TRANSCRIPT_UNREADABLE) },
                },
            },
            '/api/assistant/sessions/{sid}/generate': {
                post: {
                    tags: ['assistant'],
                    summary: 'Stream the assistant\'s next reply as normalized SSE (chunk/row/done/error), storing it server-side before the done event. '
                        + 'When a shown roleplay message carries alternate drafts (swipes), the excerpt marks it and a cl-read directive is taught; a reply may then end with a cl-read block naming message seqs, and the route answers it once (depth cap 1): the request turn and a quarantined data turn carrying those drafts are stored and emitted as row events, then the model is called again and the follow-up is the reply the done event carries. Only seqs inside the shown excerpt are served; others get an honest refusal line. '
                        + 'The prompt is assembled here: an out-of-character system prompt, then the story material (card, the context sources switched on in assistantContextSources, lorebooks, recent messages) as user-role DATA inside a fence sized past any fence run in the content, then the session transcript. '
                        + 'Story text is never system text, because a card is a stranger\'s file. '
                        + 'Editable things carry an ANCHOR (8 hex of sha256 over the exact content shown) and the reply is stored with a context snapshot naming what was shown in full; the apply path validates against that snapshot and never against a fresh build, or a model naming its own target would authorise a blind rewrite. '
                        + 'Capability directives are only present for engines the assistantLoreEdits / assistantChatEdits / assistantCardEdits / assistantNotesEdits / assistantPersonaEdits settings turn on, and the assistantSystemPrompt setting replaces the ROLE description only: the quarantine note, the rule that the reader\'s character is theirs alone and the directives are always appended, so a custom prompt cannot switch any of them off. '
                        + 'Interrupt semantics match /chats/{id}/generate, including chatKeepInterrupted',
                    parameters: [pathId('sid', 'session uuid')],
                    requestBody: body({ type: 'object', properties: { profileId: STR, params: { type: 'object' } } }, false),
                    responses: { 200: { description: 'text/event-stream' }, 404: err('not found'), 500: err(TRANSCRIPT_UNREADABLE), 502: err('upstream failure') },
                },
            },
            '/api/assistant/sessions/{sid}/proposals/{seq}': {
                get: {
                    tags: ['assistant'],
                    summary: 'The proposed edits in one reply, each judged against the world as it is NOW and carrying the before/after text a review card diffs. '
                        + 'status is ready | applied | superseded (an applied proposal from this reply already made or overrode this change; judged via the anchors our own applies produced, so a batch never reads its own writes as the target drifting) | blind (it was never shown that content in full) | gone | ambiguous (the find text is not unique) | invalid | off (a card, notes or persona change from a reply written while that kind of edit was switched off). '
                        + 'A card, notes or persona verdict carries label (the field as the material named it), reach ({ kind: card | persona, name }: the write reaches every chat with the character, or every chat using the persona) and makesOwn (a notes field this chat does not yet hold of its own). '
                        + 'A target changed by anything OUTSIDE the reply stays READY with changed: true: the diff renders against the current text and the reviewer decides. '
                        + 'Recomputed per request, never stored: a card reporting "ready" because it was ready when it was written is exactly what the anchors exist to prevent. An already-applied proposal is not re-judged, since applying it is what changed the content. '
                        + 'A lore verdict that read its entry carries title (the entry name as it is NOW; a blind verdict reads nothing and carries none) and, on an update, fields (each non-content key the set moves, with before and after as the write will land them); an applied lore proposal carries title too, read live, else as the write recorded it. '
                        + 'A lore edit whose world/uid was not shown resolves on its anchor (resolved on the verdict), because the anchor is proof-of-read; one whose world/uid WAS shown but whose anchor belongs to a different shown entry is ambiguous, refused naming both, since nothing can tell which half the model got wrong. '
                        + 'A chat replace is placed exact, then with quotes, dashes and whitespace folded, then (approximate: true on the verdict) with markup tags read as spaces and on the best word window (at least 80% of the words on both sides, the find\'s first and last words at the edges, one window only); the after is always the exact live span replaced. A find nowhere in the named message but in exactly one other message of the shown excerpt is judged and applied there (resolved: {seq}); one that sits in a non-active draft says which',
                    parameters: [pathId('sid', 'session uuid'), pathId('seq', 'transcript index of the assistant turn')],
                    responses: {
                        200: json({ type: 'object', properties: { seq: INT, proposals: { type: 'array', items: { type: 'object' } }, errors: { type: 'array', items: { type: 'object' } } } }),
                        400: err('bad seq'), 404: err('session or message not found'), 500: err(TRANSCRIPT_UNREADABLE),
                    },
                },
            },
            '/api/assistant/sessions/{sid}/apply': {
                post: {
                    tags: ['assistant'],
                    summary: 'Apply chosen proposals from one reply. The ONLY write in this feature, and always explicit. '
                        + 'Every proposal is re-checked immediately before its own write, so a batch where two of five went stale reports exactly that instead of failing whole or succeeding as a lie. '
                        + 'Order is fixed and load-bearing: in-place changes first, then deletes, and message deletes DESCENDING, because a message address is its position and deleting one renumbers everything after it. '
                        + 'Card, notes and persona changes land as one write each: the card with a version snapshot of it as it stood taken first, in the same transaction; the persona that was shown, whichever one the chat points at now. '
                        + 'Results are recorded on the message, and touched says what the client must refresh (world names, whether the messages moved, the character whose card moved, the persona that moved, whether the chat\'s note or own texts moved)',
                    parameters: [pathId('sid', 'session uuid')],
                    requestBody: body({ type: 'object', required: ['seq', 'ids'], properties: { seq: INT, ids: { type: 'array', items: STR, description: 'proposal ids from the proposals route' }, overrides: { type: 'object', description: 'reviewer touch-ups keyed by proposal id, merged before apply and never stored: a key is accepted only where the change already carries it with the same shape (amend, never widen), plus world on a CREATE to redirect the entry to another book' } } }),
                    responses: {
                        200: json({
                            type: 'object',
                            properties: {
                                results: { type: 'array', items: { type: 'object', properties: { id: STR, status: STR, reason: STR, result: { type: 'object' } } } },
                                touched: { type: 'object', properties: { worlds: { type: 'array', items: STR }, chat: { type: 'boolean' }, card: { ...STR, nullable: true }, persona: { ...STR, nullable: true }, chatNotes: { type: 'boolean' } } },
                            },
                        }),
                        400: err('bad seq / no ids / nothing left to apply'), 404: err('session or message not found'), 500: err(TRANSCRIPT_UNREADABLE),
                    },
                },
            },
            '/api/assistant/sessions/{sid}/prompt': {
                get: {
                    tags: ['assistant'],
                    summary: 'What the assistant would be sent right now, plus the context snapshot and budget. Built on demand, stored nowhere: the reader can inspect the quarantined document and the anchors before trusting a proposal built from them',
                    parameters: [pathId('sid', 'session uuid')],
                    responses: { 200: json({ type: 'object', properties: { messages: { type: 'array', items: { type: 'object' } }, budget: { type: 'object' }, context: { type: 'object' }, pictures: { type: 'object', description: 'the reader turns\' pictures: sent, stood in as text to fit the budget or the connection\'s picture limit (the oldest first, the newest turn\'s never), or withheld from a connection that does not see (sent as text instead)', properties: { sent: INT, stoodIn: INT, withheld: INT } } } }), 404: err('not found'), 500: err(TRANSCRIPT_UNREADABLE) },
                },
            },
            '/api/assistant/context': {
                get: {
                    tags: ['assistant'],
                    summary: 'The context summary the assistant panel shows before any session exists: what a session over this chat would see, plus engine availability and the budget. Built on demand, stored nowhere',
                    parameters: [{ name: 'chatId', in: 'query', required: true, schema: STR }],
                    responses: { 200: json({ type: 'object', properties: {
                        charName: STR,
                        card: { type: 'array', items: { type: 'object' }, description: 'the card fields the material carries, whole: { key, label, chars } each' },
                        chatCard: { type: 'array', items: { type: 'object' }, description: 'the texts this chat holds of its own (scenario, mes_example, system_prompt), which its story reads instead of the card\'s: { key, label, chars } each' },
                        turnsShown: INT, turnsTotal: INT,
                        books: { type: 'array', items: { type: 'object' }, description: 'the lorebooks in force, each entry open or listed by title' },
                        sources: { type: 'array', items: { type: 'object', properties: { id: STR, label: STR, on: { type: 'boolean' }, defaultOn: { type: 'boolean' }, chars: INT, detail: STR, empty: STR, failed: { type: 'boolean' }, owner: STR } }, description: 'each context source (the persona, the Author\'s Note, the chat facts, the preset\'s text blocks, an extension\'s, owner naming it): on as the assistantContextSources setting or its default says, chars only when it carried text, empty the reason when it is on with nothing to share, failed when an extension\'s source could not answer' },
                        engines: { type: 'array', items: { type: 'object' } }, budget: { type: 'object' },
                    } }), 400: err('chatId query required') },
                },
            },
            '/api/creator/defaults': {
                get: {
                    tags: ['creator'],
                    summary: 'The built-in studio role text, as the server sends it, so the panel\'s settings view can offer it as a starting point',
                    responses: { 200: json({ type: 'object', properties: { systemPrompt: STR } }) },
                },
            },
            '/api/creator/context': {
                post: {
                    tags: ['creator'],
                    summary: 'What the studio partner would SEE over the posted draft, for the panel\'s context view: every filled field with its length, the empty ones, the tags and greetings counts, the references size, the budget. Built by the real assembler, stored nowhere. A POST because the draft is unsaved and only the form holds it',
                    requestBody: body({ type: 'object', required: ['draft'], properties: { draft: { type: 'object', description: 'the unsaved card as the form holds it: name, tagline, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes as strings; tags and alternate_greetings as lists of strings', properties: { name: STR, tagline: STR, description: STR, personality: STR, scenario: STR, first_mes: STR, mes_example: STR, system_prompt: STR, post_history_instructions: STR, creator_notes: STR, tags: { type: 'array', items: STR }, alternate_greetings: { type: 'array', items: STR } } }, references: { ...STR, description: 'the reference cards block the panel built from a playlist (the inspiration pool)' }, scope: { type: 'array', items: STR, description: 'the fields the author is working on; the rest of the draft is context' }, selection: { type: 'object', description: 'a passage the author selected to revise: { field, text }', properties: { field: STR, text: STR } } } }),
                    responses: { 200: json({ type: 'object', properties: { name: STR, fields: { type: 'array', items: { type: 'object', properties: { key: STR, label: STR, chars: INT } } }, empty: { type: 'array', items: STR }, tags: INT, greetings: INT, references: INT, engines: { type: 'array', items: STR }, budget: { type: 'object' } } }), 400: err('a draft field of the wrong shape') },
                },
            },
            '/api/creator/tags': {
                post: {
                    tags: ['creator'],
                    summary: 'The tag wand beside the tag field of the form: one non-streaming call over the posted draft (the draft as fenced data with the head of the library vocabulary by usage, the tags craft as the role), the answer the names the model gave, cleaned: trimmed, deduped case-insensitively, minus the tags the draft already carries, at most twenty, casing as the model wrote it. The client runs the author import rules over them and asks POST /api/tags/resolve for the library spellings and counts. No session, no transcript. An unparseable answer is an empty list, never an error',
                    requestBody: body({ type: 'object', required: ['draft'], properties: { draft: { type: 'object', description: 'the unsaved card as the form holds it: name, tagline, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes as strings; tags and alternate_greetings as lists of strings', properties: { name: STR, tagline: STR, description: STR, personality: STR, scenario: STR, first_mes: STR, mes_example: STR, system_prompt: STR, post_history_instructions: STR, creator_notes: STR, tags: { type: 'array', items: STR }, alternate_greetings: { type: 'array', items: STR } } }, profileId: { ...STR, description: 'the LLM profile to ask; the default profile when omitted' }, params: { type: 'object', description: 'per-call sampler overrides in the neutral vocabulary (temperature, maxTokens, reasoning)' } } }),
                    responses: { 200: json({ type: 'object', properties: { tags: { type: 'array', items: STR } } }), 400: err('a draft field of the wrong shape, or no LLM profile configured'), 502: err('the model call failed') },
                },
            },
            '/api/creator/sessions': {
                get: {
                    tags: ['creator'],
                    summary: 'The studio sessions bound to one character (charId omitted = the drafts bucket, sessions bound to no character), newest first, WITHOUT transcripts (messageCount only)',
                    'x-collection': asWhole('one character\'s studio sessions (or the drafts), without transcripts'),
                    parameters: [p('charId', STR, 'character uuid; omit for drafts')],
                    responses: { 200: json({ type: 'array', items: ref('StudioSession') }) },
                },
                post: {
                    tags: ['creator'], summary: 'Start a studio session over a draft, bound to the character the form was filled from or to the drafts bucket; the name defaults to a numbered one',
                    requestBody: body({ type: 'object', properties: { charId: { ...STR, nullable: true }, name: STR, draft: { type: 'object', description: 'the unsaved card as the form holds it: name, tagline, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes as strings; tags and alternate_greetings as lists of strings', properties: { name: STR, tagline: STR, description: STR, personality: STR, scenario: STR, first_mes: STR, mes_example: STR, system_prompt: STR, post_history_instructions: STR, creator_notes: STR, tags: { type: 'array', items: STR }, alternate_greetings: { type: 'array', items: STR } } }, profileId: STR } }, false),
                    responses: { 201: json(ref('StudioSession')), 400: err('a draft field of the wrong shape'), 404: err('character not found') },
                },
            },
            '/api/creator/sessions/{sid}': {
                get: { tags: ['creator'], summary: 'One session WITH its transcript and the draft it is about', parameters: [pathId('sid', 'session uuid')], responses: { 200: json(ref('StudioSession')), 404: err('not found'), 500: err(TRANSCRIPT_UNREADABLE) } },
                patch: {
                    tags: ['creator'],
                    summary: 'Rename, bind to an LLM profile, rebind to a character (charId; null = the drafts bucket; the creator does this when a draft becomes a saved character), or store the draft the conversation is about. A draft write moves updatedAt (a working event); a rename deliberately does not, because the list is recency-ordered. Transcripts are never writable here',
                    parameters: [pathId('sid', 'session uuid')],
                    requestBody: body({ type: 'object', properties: { name: STR, profileId: { ...STR, nullable: true }, charId: { ...STR, nullable: true, description: 'the character to bind the session to; null moves it back to the drafts bucket' }, draft: { type: 'object', description: 'the unsaved card as the form holds it: name, tagline, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes as strings; tags and alternate_greetings as lists of strings', properties: { name: STR, tagline: STR, description: STR, personality: STR, scenario: STR, first_mes: STR, mes_example: STR, system_prompt: STR, post_history_instructions: STR, creator_notes: STR, tags: { type: 'array', items: STR }, alternate_greetings: { type: 'array', items: STR } } } } }),
                    responses: { 200: json(ref('StudioSession')), 400: err('blank name / nothing to change / a draft field of the wrong shape'), 404: err('not found'), 500: err(TRANSCRIPT_UNREADABLE) },
                },
                delete: { tags: ['creator'], summary: 'Delete a session', parameters: [pathId('sid', 'session uuid')], responses: { 200: json(ref('Ok')), 404: err('not found') } },
            },
            '/api/creator/sessions/{sid}/messages': {
                post: {
                    tags: ['creator'],
                    summary: 'Append ONE message. No whole-transcript write exists; the server does the read-modify-write. An assistant turn is parsed for cl-card-edits blocks here as well as on generate, so a reply arriving any other way carries its proposals',
                    parameters: [pathId('sid', 'session uuid')],
                    requestBody: body({ type: 'object', properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { ...STR, description: 'the text; empty is allowed when pictures are named' }, pictures: { type: 'array', description: 'a reader turn\'s pictures, in order: { kind, id } of the session\'s character, when it has one (its portrait or a gallery image), or the session\'s own pictures, each held to it; stored on the turn with its name and size', items: { type: 'object', required: ['kind', 'id'], properties: { kind: { type: 'string', enum: ['avatar', 'media', 'attachment'] }, id: { description: 'a character id for avatar, a media or attachment id for the others' } } } }, retry: { type: 'object', description: 'a Try again on a reader turn: the reply by its stamp (at) and the changes of it to try again (ids). While it is the last reader turn, the model is sent each change as written and where it stands now', required: ['at', 'ids'], properties: { at: INT, ids: { type: 'array', items: STR }, shown: { type: 'array', description: 'optional: each change as the client showed it, aligned with ids; one the reply now holds otherwise under its id answers 409', items: { type: 'object' } } } } } }),
                    responses: { 200: json({ type: 'object', properties: { seq: INT, message: { type: 'object' } } }), 400: err('a bad role, neither content nor pictures, pictures on a reply, a picture the session may not show, or a retry on a reply'), 404: err('not found'), 409: err('session changed underneath the write, or a retry naming a reply, or a change of it, that changed since it was shown'), 500: err(TRANSCRIPT_UNREADABLE) },
                },
            },
            '/api/creator/sessions/{sid}/messages/{seq}': {
                patch: {
                    tags: ['creator'],
                    summary: 'Patch one transcript message. extra MERGES rather than replacing, so recording an applied proposal cannot drop the snapshot stored beside it; an edited reply re-parses and drops its previous verdicts',
                    parameters: [pathId('sid', 'session uuid'), pathId('seq', 'transcript index'), p('at', INT, 'the stamp (at) of the turn the reader was shown; when given and the turn now at seq carries another, the write is refused with 409')],
                    requestBody: body({ type: 'object', properties: { content: STR, extra: { type: 'object' } } }),
                    responses: { 200: json({ type: 'object', properties: { seq: INT, message: { type: 'object' } } }), 400: err('bad seq / bad at / nothing to change'), 404: err('not found'), 409: err('the turn at seq is not the one the reader was shown (the transcript changed since)'), 500: err(TRANSCRIPT_UNREADABLE) },
                },
                delete: {
                    tags: ['creator'],
                    summary: 'Remove a turn: mode=one splices just that message, the default TRUNCATES from there (re-asking leaves no non sequiturs behind)',
                    parameters: [pathId('sid', 'session uuid'), pathId('seq', 'transcript index'), p('mode', { type: 'string', enum: ['one', 'truncate'] }, 'default truncate'), p('at', INT, 'the stamp (at) of the turn the reader was shown; when given and the turn now at seq carries another, the write is refused with 409')],
                    responses: { 200: json({ type: 'object', properties: { kept: INT, remaining: INT } }), 400: err('bad seq / bad mode / bad at'), 404: err('not found'), 409: err('the turn at seq is not the one the reader was shown (the transcript changed since)'), 500: err(TRANSCRIPT_UNREADABLE) },
                },
            },
            '/api/creator/sessions/{sid}/generate': {
                post: {
                    tags: ['creator'],
                    summary: 'Stream the studio partner\'s next reply as normalized SSE (chunk/done/error), storing it server-side before the done event with the SNAPSHOT of the draft it was shown (an anchor per field, over the tags and per greeting). '
                        + 'The draft rides the request because it is unsaved: the server builds the prompt from it (the design-partner role, the cast note, the quarantine note, the craft, the cl-card-edits grammar; then the whole draft as fenced user-role DATA with the references; then the transcript with the app note on each reply), and writes it to the session as the draft the conversation is about. '
                        + 'scope and selection steer this turn only. profileId falls back to the session\'s own; params override the profile per the normal request-params merge and never write the profile; when neither names maxTokens a roomy ceiling is asked for. Interrupt semantics match /chats/{id}/generate, including chatKeepInterrupted',
                    parameters: [pathId('sid', 'session uuid')],
                    requestBody: body({ type: 'object', required: ['draft'], properties: { draft: { type: 'object', description: 'the unsaved card as the form holds it: name, tagline, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes as strings; tags and alternate_greetings as lists of strings', properties: { name: STR, tagline: STR, description: STR, personality: STR, scenario: STR, first_mes: STR, mes_example: STR, system_prompt: STR, post_history_instructions: STR, creator_notes: STR, tags: { type: 'array', items: STR }, alternate_greetings: { type: 'array', items: STR } } }, references: { ...STR, description: 'the reference cards block the panel built from a playlist (the inspiration pool)' }, scope: { type: 'array', items: STR, description: 'the fields the author is working on; the rest of the draft is context' }, selection: { type: 'object', description: 'a passage the author selected to revise: { field, text }', properties: { field: STR, text: STR } }, profileId: STR, params: { type: 'object' } } }),
                    responses: { 200: { description: 'text/event-stream' }, 400: err('a draft field of the wrong shape, or a typed pre-stream LLM refusal'), 404: err('not found'), 500: err(TRANSCRIPT_UNREADABLE), 502: err('upstream failure before the stream opened') },
                },
            },
            '/api/creator/sessions/{sid}/judge': {
                post: {
                    tags: ['creator'],
                    summary: 'The proposals in one reply, each judged against the draft the client posts NOW and carrying the before/after text a review card diffs. A POST because what the judge reads is the posted draft. '
                        + 'status is ready | applied | superseded (an applied proposal from this reply already rewrote this target) | gone (a greeting number the draft does not have) | ambiguous (a replace whose passage is not in the field exactly once, or tags already as proposed) | invalid. '
                        + 'A target changed OUTSIDE the reply stays READY with changed: true: the diff renders against the current text and the author decides. Recomputed per request, never stored',
                    parameters: [pathId('sid', 'session uuid')],
                    requestBody: body({ type: 'object', required: ['seq', 'draft'], properties: { seq: INT, draft: { type: 'object', description: 'the unsaved card as the form holds it: name, tagline, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes as strings; tags and alternate_greetings as lists of strings', properties: { name: STR, tagline: STR, description: STR, personality: STR, scenario: STR, first_mes: STR, mes_example: STR, system_prompt: STR, post_history_instructions: STR, creator_notes: STR, tags: { type: 'array', items: STR }, alternate_greetings: { type: 'array', items: STR } } } } }),
                    responses: { 200: json({ type: 'object', properties: { seq: INT, proposals: { type: 'array', items: { type: 'object' } }, errors: { type: 'array', items: { type: 'object' } } } }), 400: err('bad seq / a draft field of the wrong shape'), 404: err('session or message not found'), 500: err(TRANSCRIPT_UNREADABLE) },
                },
            },
            '/api/creator/sessions/{sid}/apply': {
                post: {
                    tags: ['creator'],
                    summary: 'Apply chosen proposals from one reply over the posted draft and answer the draft that results, for the client to write into the form. Nothing here writes a character: the draft is unsaved. '
                        + 'Every proposal is re-judged against the draft as the earlier ones in the batch left it; new greetings run LAST so a numbered greeting keeps its number. Results are recorded on the message, the session keeps the resulting draft, and touched says which fields, the tags and the greetings moved. '
                        + 'overrides are reviewer touch-ups keyed by proposal id, merged before apply and never stored: a key is accepted only where the change already carries it with the same shape',
                    parameters: [pathId('sid', 'session uuid')],
                    requestBody: body({ type: 'object', required: ['seq', 'ids', 'draft'], properties: { seq: INT, ids: { type: 'array', items: STR }, draft: { type: 'object', description: 'the unsaved card as the form holds it: name, tagline, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes as strings; tags and alternate_greetings as lists of strings', properties: { name: STR, tagline: STR, description: STR, personality: STR, scenario: STR, first_mes: STR, mes_example: STR, system_prompt: STR, post_history_instructions: STR, creator_notes: STR, tags: { type: 'array', items: STR }, alternate_greetings: { type: 'array', items: STR } } }, overrides: { type: 'object' } } }),
                    responses: {
                        200: json({ type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: { id: STR, status: STR, reason: STR, result: { type: 'object' } } } }, draft: { type: 'object', description: 'the unsaved card as the form holds it: name, tagline, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes as strings; tags and alternate_greetings as lists of strings', properties: { name: STR, tagline: STR, description: STR, personality: STR, scenario: STR, first_mes: STR, mes_example: STR, system_prompt: STR, post_history_instructions: STR, creator_notes: STR, tags: { type: 'array', items: STR }, alternate_greetings: { type: 'array', items: STR } } }, touched: { type: 'object', properties: { fields: { type: 'array', items: STR }, tags: { type: 'boolean' }, greetings: { type: 'boolean' } } } } }),
                        400: err('bad seq / no ids / nothing left to apply / a draft field of the wrong shape'), 404: err('session or message not found'), 500: err(TRANSCRIPT_UNREADABLE),
                    },
                },
            },
            '/api/creator/sessions/{sid}/prompt': {
                post: {
                    tags: ['creator'],
                    summary: 'What the studio partner would be sent right now over the posted draft: the same builder, nothing stored, so the author can read the quarantined draft and the snapshot before trusting anything built from them',
                    parameters: [pathId('sid', 'session uuid')],
                    requestBody: body({ type: 'object', required: ['draft'], properties: { draft: { type: 'object', description: 'the unsaved card as the form holds it: name, tagline, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, creator_notes as strings; tags and alternate_greetings as lists of strings', properties: { name: STR, tagline: STR, description: STR, personality: STR, scenario: STR, first_mes: STR, mes_example: STR, system_prompt: STR, post_history_instructions: STR, creator_notes: STR, tags: { type: 'array', items: STR }, alternate_greetings: { type: 'array', items: STR } } }, references: { ...STR, description: 'the reference cards block the panel built from a playlist (the inspiration pool)' }, scope: { type: 'array', items: STR, description: 'the fields the author is working on; the rest of the draft is context' }, selection: { type: 'object', description: 'a passage the author selected to revise: { field, text }', properties: { field: STR, text: STR } } } }),
                    responses: { 200: json({ type: 'object', properties: { messages: { type: 'array', items: { type: 'object' } }, budget: { type: 'object' }, context: { type: 'object' }, pictures: { type: 'object', description: 'the reader turns\' pictures: sent, stood in as text to fit the budget or the connection\'s picture limit (the oldest first, the newest turn\'s never), or withheld from a connection that does not see (sent as text instead)', properties: { sent: INT, stoodIn: INT, withheld: INT } } } }), 400: err('a draft field of the wrong shape'), 404: err('not found'), 500: err(TRANSCRIPT_UNREADABLE) },
                },
            },

            '/api/characters/{id}/worlds': {
                get: { tags: ['worlds'], summary: "A character's linked lorebook names, ordered (head = extensions.world in exported cards)", 'x-collection': asWhole('the character\'s ordered book list, written whole by its PUT'), parameters: [pathId()], responses: { 200: json({ type: 'array', items: STR }), 404: err('character not found') } },
                put: {
                    tags: ['worlds'], summary: 'Replace the whole linked-lorebook list (a name with no book is refused with 400)',
                    parameters: [pathId()],
                    requestBody: body({ type: 'object', required: ['worlds'], properties: { worlds: { type: 'array', items: STR } } }),
                    responses: { 200: json(ref('Ok')), 400: err('worlds is not an array of names, or a name with no book'), 404: err('character not found') },
                },
            },
            '/api/global-worlds': {
                get: { tags: ['worlds'], summary: 'Lorebooks active in EVERY chat, ordered (every name is a book on the shelf; the list follows a book\'s rename and loses it on its delete)', 'x-collection': asWhole('the global ordered book list, written whole by its PUT'), responses: { 200: json({ type: 'object', properties: { worlds: { type: 'array', items: STR } } }) } },
                put: {
                    tags: ['worlds'], summary: 'Replace the whole global list, order preserved',
                    requestBody: body({ type: 'object', required: ['worlds'], properties: { worlds: { type: 'array', items: STR } } }),
                    responses: { 200: json(ref('Ok')), 400: err('bad body') },
                },
            },
            '/api/global-worlds/apply': {
                post: {
                    tags: ['worlds'],
                    summary: 'Atomic add/remove on the global list (the /char-worlds/apply sibling): appends land after the tail, no client read needed, so a failed read can never turn into an empty overwrite',
                    requestBody: body({ type: 'object', properties: { add: { type: 'array', items: STR }, remove: { type: 'array', items: STR } } }),
                    responses: { 200: json({ type: 'object' }, '{ok, added, removed} (actual changes only)'), 400: err('nothing to do') },
                },
            },
            '/api/personas/{id}/worlds': {
                get: { tags: ['worlds'], summary: "A persona's bound lorebook names, ordered. They reach whichever chat resolves that persona (its override, else the global active one)", 'x-collection': asWhole('the persona\'s ordered book list, written whole by its PUT'), parameters: [pathId('id', 'persona uuid')], responses: { 200: json({ type: 'array', items: STR }), 404: err('persona not found') } },
                put: {
                    tags: ['worlds'], summary: 'Replace the whole bound-lorebook list (a name with no book is refused with 400)',
                    parameters: [pathId('id', 'persona uuid')],
                    requestBody: body({ type: 'object', required: ['worlds'], properties: { worlds: { type: 'array', items: STR } } }),
                    responses: { 200: json(ref('Ok')), 400: err('worlds is not an array of names, or a name with no book'), 404: err('persona not found') },
                },
            },
            '/api/personas/{id}/worlds/apply': {
                post: {
                    tags: ['worlds'],
                    summary: "Atomic add/remove on a persona's bound list; same contract as /api/global-worlds/apply",
                    parameters: [pathId('id', 'persona uuid')],
                    requestBody: body({ type: 'object', properties: { add: { type: 'array', items: STR }, remove: { type: 'array', items: STR } } }),
                    responses: { 200: json({ type: 'object' }, '{ok, added, removed} (actual changes only)'), 400: err('nothing to do'), 404: err('persona not found') },
                },
            },
            '/api/provider-links/probe': {
                post: {
                    tags: ['library'],
                    summary: 'Which of these remote keys are linked here (the browse-view badge probe): a key matches a link\'s externalId, or its fullPath case-insensitively, on one of the named providers; answers the matching input keys in input order',
                    requestBody: body({ type: 'object', required: ['keys'], properties: { providers: { type: 'array', items: STR, description: 'provider ids to match against (max 20); or provider: one id' }, provider: STR, keys: { type: 'array', items: STR, description: `remote ids or paths, max ${PROBE_MAX_KEYS}` }, owners: { type: 'boolean', description: 'also answer the links behind the keys (the import duplicate check), each resolved to its character id' }, loose: { type: 'boolean', description: 'with owners: links whose path begins with the key or that the key begins with, exact links first; a purely numeric or uuid key, and a purely numeric path, only match exactly' } } }),
                    responses: { 200: json({ type: 'object', properties: { found: { type: 'array', items: STR }, owners: { type: 'array', description: 'only when owners: true; per key in input order, exact links before loose ones', items: { type: 'object', properties: { key: STR, charId: STR, providerId: STR, externalId: { ...STR, nullable: true }, fullPath: { ...STR, nullable: true }, exact: { type: 'boolean' } } } } } }), 400: err('providers missing, keys missing, a cap exceeded, owners or loose not boolean, or loose without owners') },
                },
            },
            '/api/migrate/plan': {
                post: {
                    tags: ['library'],
                    summary: 'The SillyTavern migration plan: the migration tool\'s dry-run over a user folder on the server, nothing written. Any signed-in user, into their own library only; the path is read on the server\'s filesystem',
                    requestBody: body({
                        type: 'object',
                        required: ['path'],
                        properties: {
                            path: { ...STR, description: 'the SillyTavern user data folder (holding characters/, chats/, worlds/), a path on the machine running the server' },
                            only: { type: 'array', items: STR, description: 'a test pool by character name or file' },
                            sample: { ...INT, description: 'a random test pool of this size' },
                            excludeTags: { type: 'array', items: STR },
                        },
                    }),
                    responses: {
                        200: json({ type: 'object', properties: { target: STR, source: STR, counts: { type: 'object' }, duplicateGroups: { type: 'array', items: { type: 'array', items: STR } }, unmatchedChatDirs: { type: 'array', items: STR }, groupChats: INT, worlds: INT, state: { type: 'object' }, lines: { type: 'array', items: STR } } }),
                        400: err('no characters/ under the path, a targetHandle naming another account, or the tool refused (its lines say why)'),
                        409: err('a migration or a plan is already running: the caller\'s own run with its tail, anything else without details'),
                        500: err('the migration tool could not be started'),
                    },
                },
            },
            '/api/migrate/run': {
                post: {
                    tags: ['library'],
                    summary: 'Run the SillyTavern migration as a child of the server, the log streamed. One run at a time; a dropped stream never stops it (GET /migrate/status keeps the tail). Options: excludeTags, only, sample, warmThumbs, verify (full | fast | off)',
                    requestBody: body({ type: 'object', required: ['path'], properties: { path: STR, only: { type: 'array', items: STR }, sample: INT, excludeTags: { type: 'array', items: STR }, warmThumbs: { type: 'boolean' }, verify: { type: 'string', enum: ['full', 'fast', 'off'] } } }),
                    responses: { 200: { description: 'text/event-stream: started {mode, target, source, startedAt}, line {line}, done {mode, target, code, cancelled, report, state}, error {message, kind}' }, 400: err('no characters/ under the path, or a targetHandle naming another account'), 409: err('a migration or a plan is already running: the caller\'s own run with its tail, anything else without details') },
                },
            },
            '/api/migrate/finalize': {
                post: {
                    tags: ['library'],
                    summary: 'Finalize the migration: one last verify, then the SillyTavern-era identity records are purged (one-way; a later run into the same library is refused). Streamed like a run',
                    requestBody: body({ type: 'object', required: ['path'], properties: { path: STR, verify: { type: 'string', enum: ['full', 'fast', 'off'] }, force: { type: 'boolean' } } }),
                    responses: { 200: { description: 'text/event-stream: started, line, done, error' }, 400: err('no characters/ under the path, or a targetHandle naming another account'), 409: err('a migration or a plan is already running: the caller\'s own run with its tail, anything else without details') },
                },
            },
            '/api/migrate/cancel': {
                post: {
                    tags: ['library'],
                    summary: 'Stop the running migration (the whole process tree); a cancelled run heals on the next run',
                    responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, mode: STR } }), 404: err('no migration is running') },
                },
            },
            '/api/migrate/status': {
                get: {
                    tags: ['library'],
                    summary: 'The run in flight with the tail of its log, the newest report, and what the caller\'s home already knows (finalized, verified)',
                    responses: { 200: json({ type: 'object', properties: { target: STR, busy: { type: 'boolean', description: 'a migration is running on this server, any account; running carries its details only when it is the caller\'s own' }, running: { type: 'object', nullable: true, properties: { mode: STR, target: STR, source: STR, startedAt: { type: 'number' }, lines: { type: 'array', items: STR } } }, lastReport: { type: 'object', nullable: true }, state: { type: 'object', properties: { finalized: { type: 'object', nullable: true }, verified: { type: 'object', nullable: true } } } } }) },
                },
            },
            '/api/backup': {
                post: {
                    tags: ['library'],
                    summary: 'Start a consistent backup of the library database into data/backups/ (the database only; media and avatars are plain files). It is queued and answered at once, and the copy runs beside the server, which keeps answering: the copy holds the library as it was when the copy began, and writes made during it are in the next backup. One backup runs at a time across the server, so another account\'s may run first. A search index tidy-up of the library pauses while it is queued or runs, and one asked for carries on once it ends. Follow it through GET /api/backup/job',
                    responses: { 202: json(ref('BackupJob'), 'the job, queued or running'), 409: err('this account already has a backup queued or running') },
                },
                get: {
                    tags: ['library'],
                    summary: 'List existing backups (newest first)',
                    'x-collection': asWhole('the backups on disk, pruned to the keep (at most 50)'),
                    responses: { 200: json({ type: 'array', items: { type: 'object', properties: { file: STR, bytes: INT, mtime: { type: 'number' } } } }) },
                },
            },
            '/api/backup/status': {
                get: {
                    tags: ['library'],
                    summary: 'Library size and contents, the newest backup, and the schedule, in one round trip. db.bytes counts the database\'s write-ahead log too, which holds writes not yet folded into the main file',
                    responses: {
                        200: json({
                            type: 'object',
                            properties: {
                                db: {
                                    type: 'object',
                                    properties: { bytes: INT, characters: INT, chats: INT, messages: INT, lorebooks: INT },
                                },
                                latest: { type: 'object', nullable: true, properties: { file: STR, bytes: INT, mtime: { type: 'number' } } },
                                count: INT,
                                totalBytes: INT,
                                frequency: { type: 'string', enum: ['off', 'daily', 'weekly'] },
                                keep: { ...INT, description: 'how many backups are retained; older ones are pruned AFTER a new one lands' },
                                nextRun: { type: 'number', nullable: true, description: 'when the next automatic backup starts: the start of the first backup window that opens once it is due (a day short of its period, so daily is every night), now when such a window is open, or with no window the moment it is due; null when scheduling is off' },
                                missed: { ...ref('BackupMissed'), nullable: true },
                            },
                        }),
                    },
                },
            },
            '/api/backup/job': {
                get: {
                    tags: ['library'],
                    summary: 'This account\'s backup: the one queued or running, else the last that ended (kept in memory until dismissed, another starts, or the server restarts), and the window a scheduled backup missed while none runs. Read it while a backup runs for its progress; every change to it is also a backup record on the change feed',
                    responses: { 200: json({ type: 'object', properties: { job: { ...ref('BackupJob'), nullable: true }, missed: { ...ref('BackupMissed'), nullable: true }, recheckAt: { type: 'number', nullable: true, description: 'the end of the next backup window, when a missed window can appear with no backup record to say so; read again then' } } }) },
                },
            },
            '/api/backup/job/{id}': {
                delete: {
                    tags: ['library'],
                    summary: 'Cancel a queued or running backup, or with dismiss=true let go of one that ended; neither stands in for the other, so a cancel that arrives after the backup ended leaves its result. A running copy is stopped and its partial file removed; it answers with stopping true and ends cancelled moments later. A scheduled backup that is cancelled or fails is not retried in its window (with no window, for a day)',
                    parameters: [pathId('id', 'job id'), p('dismiss', { type: 'boolean' }, 'true lets go of a backup that ended, so it leaves the notifications')],
                    responses: { 200: json(ref('BackupJob')), 400: err('numeric id required'), 404: err('job not found'), 409: err('a cancel of a backup that already ended, or a dismiss of one still running') },
                },
            },
            '/api/backup/missed': {
                post: {
                    tags: ['library'],
                    summary: 'Answer a missed backup window: tonight waits for the next window and asks again only if that one is missed too; skip counts the missed backup as taken at the end of its window, so the next comes on its usual day. Back Up Now is POST /api/backup',
                    requestBody: body({ type: 'object', required: ['answer'], properties: { answer: { ...STR, enum: ['tonight', 'skip'] } } }),
                    responses: { 200: json({ type: 'object', properties: { answer: STR, windowEnd: { type: 'number' } } }), 400: err("answer is 'tonight' or 'skip'"), 409: err('no missed backup to answer') },
                },
            },
            '/api/maintenance': {
                get: {
                    tags: ['library'],
                    summary: 'What this library\'s background upkeep is doing now. searchIndex names the search index being tidied and when the tidy-up began, null while none is: it runs beside the server once the library sits idle and an index is in pieces, or when asked, and searches may be slower and the disk busy until it ends. Every change to it is also a maintenance record on the change feed',
                    responses: { 200: json({ type: 'object', properties: { searchIndex: { type: 'object', nullable: true, properties: { index: { ...STR, enum: ['cards', 'chats', 'lorebooks'] }, since: { type: 'number', description: 'when the tidy-up began, in ms since the epoch' }, done: { ...INT, description: 'pages of this index rewritten so far' }, total: { ...INT, description: 'pages this index holds' }, reason: { ...STR, enum: ['auto', 'asked'], description: 'auto: started once the library sat idle, and paused by activity; asked: Tidy Now' } } } } }) },
                },
            },
            '/api/maintenance/activity': {
                post: {
                    tags: ['library'],
                    summary: 'The reader is using this library: a client sends it on its user\'s own input (a click, a key, a scroll, a touch), at most once every few seconds, never from a background poll. Background upkeep holds off: an automatic search index tidy-up running for this library pauses, its work kept, and the next one waits until the library has had neither this nor a write for two minutes. A script that wants the upkeep to hold off while it works can send it too',
                    responses: { 204: { description: 'noted' } },
                },
            },
            '/api/maintenance/search-index': {
                get: {
                    tags: ['library'],
                    summary: 'The library\'s search indexes for a settings panel: for each, how many segments it holds, its size, and its drift, how many times the disk pages a word lookup reads against the same index tidied into one segment, rounded down to hundredths (null where it cannot be read). Also the drift at which an index is tidied on its own (once the library sits idle), the last tidy-up (when it ended, how long it took, the indexes it tidied and whether it was asked for), the last failure since (when, the index, why, whether asked; null once a later tidy-up ends well), the one running as GET /api/maintenance answers it, what this library\'s asked tidy-up waits for (its backup, or another library\'s asked tidy-up; null when none waits), and whether automatic tidy-ups are on (the autoTidySearchIndex setting). A tidy-up that stopped is tried again in full the next time the library sits idle while automatic tidy-ups are on',
                    responses: { 200: json({ type: 'object', properties: {
                        indexes: { type: 'array', items: { type: 'object', properties: { index: { ...STR, enum: ['cards', 'chats', 'lorebooks'] }, segments: { ...INT, nullable: true }, bytes: { ...INT, nullable: true }, drift: { type: 'number', nullable: true } } } },
                        driftLimit: { type: 'number' },
                        last: { type: 'object', nullable: true, properties: { at: { type: 'number' }, ms: INT, indexes: { type: 'array', items: { type: 'object', properties: { index: STR, ms: INT } } }, reason: { ...STR, enum: ['auto', 'asked'] } } },
                        failure: { type: 'object', nullable: true, properties: { at: { type: 'number' }, index: { ...STR, nullable: true }, error: STR, reason: { ...STR, enum: ['auto', 'asked'] } } },
                        running: { type: 'object', nullable: true },
                        queued: { ...STR, nullable: true, enum: ['backup', 'library', null] },
                        auto: { type: 'boolean' },
                    } }) },
                },
            },
            '/api/maintenance/search-index/tidy': {
                post: {
                    tags: ['library'],
                    summary: 'Tidy every search index holding more than one segment into one, now, while the reader keeps working (it is never paused by activity). Answered at once: 202 with started true and the tidy-up running, named from the first answer (followed through GET /api/maintenance and its maintenance records), or with queued true while this library is backed up or another library\'s asked tidy-up runs (this one starts when that ends); 200 with started false when every index is already one segment. It takes the lane from an automatic tidy-up of any library, which pauses and resumes later; asked again while it runs, it answers the one running. A backup goes first: one starting while it runs pauses it, and it carries on once the backup ends. It ends with every index in one segment, apart from what writes made while it ran add',
                    responses: { 200: json({ type: 'object', properties: { started: { type: 'boolean' } } }, 'already tidy'), 202: json({ type: 'object', properties: { started: { type: 'boolean' }, queued: { type: 'boolean' }, running: { type: 'object', nullable: true } } }, 'the tidy-up running or waiting') },
                },
            },
            '/api/tags': {
                get: {
                    tags: ['tags'],
                    summary: 'A page of the library\'s tags, each with how many characters carry it, in name order (case folded) or most used first; q asks for the names that contain it, in the same order',
                    'x-collection': asPage(PAGE_DEFAULT, PAGE_MAX),
                    parameters: [...PAGE_PARAMS('tags'), p('q', STR, 'the names that contain this text, case folded; a % or _ is a character'),
                        p('sort', { type: 'string', enum: ['name', 'count'] }, 'default name (case folded, ASCII); count is most carried first, then by name. A cursor walks only the sort that answered it; an unknown value is refused 400 naming the set')],
                    responses: {
                        200: json(pageSchema({ type: 'object', properties: { name: STR, count: INT } })),
                        400: err(`a limit outside 1 to ${PAGE_MAX}, an after that is not a cursor of this sort, an unknown sort, or a count that is not a boolean word`),
                    },
                },
            },
            '/api/characters/tally': {
                post: {
                    tags: ['characters'],
                    summary: `How many characters a set holds and how many of them are favourites: a selection's count and its star in one read. The set is charIds (at most ${IDS_MAX} a request, so a larger selection is counted in parts, which add up, or by its filter) or filter (a GET /api/characters query string, read the list's way; sort, order, paging and count ignored; notIds leaves out the ids a reader deselected), never both. A POST so the filter rides the body`,
                    requestBody: body({ type: 'object', properties: { charIds: { type: 'array', items: STR, description: `at most ${IDS_MAX}` }, filter: { ...STR, description: 'a GET /api/characters query string' } } }),
                    responses: { 200: json({ type: 'object', properties: { total: INT, favorites: INT } }), 400: err(`neither charIds nor a filter, both, more than ${IDS_MAX} charIds, a filter parameter refused in the list's words, or a filter parameter the list does not take`) },
                },
            },
            '/api/characters/fav': {
                post: {
                    tags: ['characters'],
                    summary: `Bulk favourite flip, the set named by charIds or by filter, never both. A favourite never moves a character's updatedAt. By charIds, all or nothing, touching only the characters whose favourite moves: those are counted (touched) and listed in affected in the order named, an unknown id in skipped, and a named character that already held the value in neither, answered {ok, touched, affected, skipped}; at most ${IDS_MAX} ids a request, so a larger selection is sent as several requests, each landing whole, or as its filter. By filter (a GET /api/characters query string, read the list's way; notIds leaves out the ids a reader deselected): the set is fixed, then a job writes it in batches of a thousand characters, each batch landing whole, touching only the characters whose favourite moves and reporting them by id; answered at once (202) with the job, whose answer {changed} (GET /api/jobs/{id}) counts the characters that moved, the rest of its total already were`,
                    requestBody: body({ type: 'object', properties: { charIds: { type: 'array', items: STR, description: `at most ${IDS_MAX}` }, filter: { ...STR, description: 'a GET /api/characters query string' }, fav: { type: 'boolean' } }, required: ['fav'] }),
                    responses: { 200: json({ type: 'object' }, 'by charIds {ok, touched, affected, skipped}'), 202: json({ type: 'object', properties: { ok: { type: 'boolean' }, job: ref('SetJob') } }, 'by filter: the job'), 400: err(`no charIds, more than ${IDS_MAX} of them, charIds and a filter both, fav not a boolean, a filter parameter refused in the list's words, or one the list does not take`) },
                },
            },
            '/api/characters/flags': {
                post: {
                    tags: ['characters'],
                    summary: `Bulk per-character flags (mediaLocalized, loreDismissed), touching only the characters whose value changes; a flag never moves a character's updatedAt. charIds names the characters, all or nothing, at most ${IDS_MAX} a request, so a larger selection is sent as several requests, each landing whole (answered like /fav: the ids that moved in affected, an unknown id in skipped). all: true sets the flags across the whole library: the characters whose value moves are fixed, then a job writes them in batches of a thousand, each batch landing whole and reporting its characters by id; answered at once (202) with the job, whose answer {changed} (GET /api/jobs/{id}) counts the characters that moved`,
                    requestBody: body({ type: 'object', properties: { charIds: { type: 'array', items: STR, description: `at most ${IDS_MAX}` }, all: { type: 'boolean' }, mediaLocalized: { type: 'boolean' }, loreDismissed: { type: 'boolean' } } }),
                    responses: { 200: json({ type: 'object' }, 'by charIds {ok, touched, affected, skipped}'), 202: json({ type: 'object', properties: { ok: { type: 'boolean' }, job: ref('SetJob') } }, 'all: true: the job'), 400: err(`bad body: exactly one of charIds or all, at least one flag, at most ${IDS_MAX} charIds`) },
                },
            },
            '/api/characters/delete': {
                post: {
                    tags: ['characters'],
                    summary: `Bulk delete: each character with everything that is its own (as DELETE /api/characters/{id}), the set named by charIds or by filter, never both. By charIds, all or nothing, so an extension's store guard refusing any id deletes none; missing ids reported, the rest proceed; at most ${DELETE_MAX} ids a request, so a larger selection is sent as several requests, each landing whole. By filter (a GET /api/characters query string, read the list's way; notIds leaves out the ids a reader deselected): the set is fixed, then a job deletes it in batches of ${DELETE_MAX} characters, each landing whole and reporting its ids deleted with no origin (every tab lets go of them, the starting one included); answered at once (202) with the job, whose answer {changed, missing} (GET /api/jobs/{id}) counts the characters deleted and the ones gone before their batch. A store guard refusing a batch fails the job in its words, the batches before it deleted. expect, the count the reader confirmed, refuses a set whose size moved since (409 with its total; nothing deleted)`,
                    requestBody: body({ type: 'object', properties: { charIds: { type: 'array', items: STR }, filter: { ...STR, description: 'a GET /api/characters query string' }, expect: { type: 'integer', description: 'with filter: the count of characters the reader confirmed' } } }),
                    responses: { 200: json({ type: 'object' }, 'by charIds {ok, touched, deleted, missing}'), 202: json({ type: 'object', properties: { ok: { type: 'boolean' }, job: ref('SetJob') } }, 'by filter: the job'), 400: err(`bad body, more than ${DELETE_MAX} ids, charIds and a filter both, expect not a count, a filter parameter the list refuses or does not take, or an extension's store guard refused an id: nothing was deleted, the error is the guard's words`), 409: json({ type: 'object', properties: { error: STR, total: INT } }, 'by filter with expect: the set holds another count of characters now (total); nothing was deleted') },
                },
            },
            '/api/characters/fields-apply': {
                post: {
                    tags: ['characters'],
                    summary: `Bulk dot-path field writes: each entry applies as PATCH /api/characters/{id} applies it (provider links, lorebooks and tags included) and lands whole on its own; failures are reported per item, never fatal. At most ${FIELDS_APPLY_MAX} entries a request, so a longer list is sent as several requests`,
                    requestBody: body({ type: 'object', properties: { updates: { type: 'array', description: `at most ${FIELDS_APPLY_MAX}`, items: { type: 'object', properties: { id: STR, fields: { type: 'object' }, fav: { type: 'boolean' }, mediaLocalized: { type: 'boolean' }, loreDismissed: { type: 'boolean' } } } } }, required: ['updates'] }),
                    responses: { 200: json({ type: 'object' }, '{ok, touched, affected, failed: [{id, error}]}'), 400: err(`bad body, or more than ${FIELDS_APPLY_MAX} entries: nothing was written`) },
                },
            },
            '/api/char-worlds/apply': {
                post: {
                    tags: ['worlds'],
                    summary: `Add/remove world links on a set of characters, all or nothing (the /tags/apply sibling), at most ${IDS_MAX} charIds a request, so a larger selection is sent as several requests, each landing whole. Appends keep per-char order; unknown charIds skipped; deltas are undo-grade; a name with no book is refused with 400 before anything is written`,
                    requestBody: body({ type: 'object', properties: { charIds: { type: 'array', items: STR, description: `at most ${IDS_MAX}` }, add: { type: 'array', items: STR }, remove: { type: 'array', items: STR } }, required: ['charIds'] }),
                    responses: { 200: json({ type: 'object' }, '{ok, touched, affected, skipped, deltas}'), 400: err(`nothing to do, no charIds or more than ${IDS_MAX}, or a name with no book`) },
                },
            },
            '/api/tags/rename': {
                post: {
                    tags: ['tags'],
                    summary: "Rename a tag everywhere; if the target name exists (compared case-insensitively in ASCII) this merges carriers onto it. With run, the undo is journaled with the rename, landing together, as a links run (each carrier's source link with the place it held, the target link it gained): { label } opens a run, { id } joins the newest run so a bulk run's ops are one undo (POST /api/tag-runs/{id}/undo). A saved filter preset (the filter-presets store document) naming the tag, as the filter engine matches it (case-insensitively in ASCII), takes the new name (on a merge, the surviving tag's) in the same write, the document's change record naming no tab; with run, each rule rewritten is journaled in the run, so the undo puts it back, and so is the rename or merge itself, so the undo reports the name moving back. Answers counts, never carrier ids",
                    requestBody: body({ type: 'object', properties: { from: STR, to: STR, run: { type: 'object', properties: { label: STR, id: INT }, description: '{ label } opens a run, { id } joins the newest' } }, required: ['from', 'to'] }),
                    responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, touched: INT, merged: { type: 'boolean' }, runId: { ...INT, nullable: true } } }), 400: err('{from, to} required, or a run with no label'), 404: err('no such tag'), 409: err('the run named is not the newest') },
                },
            },
            '/api/tags/remove': {
                post: {
                    tags: ['tags'],
                    summary: "Remove a tag from every carrier and delete the tag. With run (as rename), each carrier's link is journaled with the place it held, so the undo puts the tag back there. A saved filter preset's rule naming the tag (case-insensitively in ASCII) goes in the same write and the preset lists it under removed, for the client to say once; with run, each rule taken is journaled in the run with its place, so the undo puts it back there, and so is the remove itself. Answers counts, never carrier ids",
                    requestBody: body({ type: 'object', properties: { name: STR, run: { type: 'object', properties: { label: STR, id: INT }, description: '{ label } opens a run, { id } joins the newest' } }, required: ['name'] }),
                    responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, touched: INT, runId: { ...INT, nullable: true } } }), 400: err('{name} required, or a run with no label'), 404: err('no such tag'), 409: err('the run named is not the newest') },
                },
            },
            '/api/tags/apply': {
                post: {
                    tags: ['tags'],
                    summary: 'Add/remove tag names on a set of characters (batch tagging), named by charIds or by filter, never both. Appends keep per-char order; zero-use tags are pruned; no character\'s updatedAt moves. By charIds, all or nothing: unknown ids are skipped and reported, deltas lists per-char ACTUAL changes (undo-grade), and only a character with one is listed in affected, answered {ok, touched, affected, skipped, deltas}; at most ' + IDS_MAX + ' ids a request, so a larger selection is sent as several requests, each landing whole, or as its filter. By filter (a GET /api/characters query string: every filter parameter it takes, read the list\'s way; sort, order, paging and count ignored): the set is fixed, then a job writes it in batches of a thousand characters, each landing whole, journaling every link it moves as a links run (Undo: POST /api/tag-runs/{id}/undo) and reporting the characters it changed; answered at once (202) with the job, whose progress and answer GET /api/jobs/{id} reads (the answer counts per name, never a list of characters, since a filter can be the whole library)',
                    requestBody: body({ type: 'object', properties: { charIds: { type: 'array', items: STR, description: `at most ${IDS_MAX}` }, filter: { ...STR, description: 'a GET /api/characters query string' }, add: { type: 'array', items: STR }, remove: { type: 'array', items: STR } } }),
                    responses: { 200: json({ type: 'object' }, 'by charIds {ok, touched, affected, skipped, deltas: [{charId, added, removed}]}'), 202: json({ type: 'object', properties: { ok: { type: 'boolean' }, job: ref('SetJob') } }, 'by filter: the job'), 400: err('nothing to do, add or remove not an array, a name both added and removed, more than ' + IDS_MAX + ' charIds, charIds and a filter both, a filter parameter refused in the list\'s words, or a filter parameter the list does not take (a misspelled one would name the whole library)') },
                },
            },
            '/api/jobs/{id}': {
                get: { tags: ['library'], summary: 'A set job of this account (a by-filter write over characters: a tag write or the undo of one, a delete, a favourite, a playlist\'s membership): its status and progress (done of total characters, or links for an undo), and its answer in result once it ends. The account\'s jobs run one at a time on one lane, every kind together, so a job may wait queued behind another. Finished jobs are kept a while in memory, not across a restart, where a running job stops with what landed kept', parameters: [pathId('id', 'job id')], responses: { 200: json(ref('SetJob')), 400: err('numeric id required'), 404: err('no such job for this account') } },
                delete: { tags: ['library'], summary: 'Stop a set job: a queued one never starts, a running one halts before its next batch; what landed stays (a tag write\'s journaled in its run). Answers the job (a finished one as it ended)', parameters: [pathId('id', 'job id')], responses: { 200: json(ref('SetJob')), 400: err('numeric id required'), 404: err('no such job for this account') } },
            },
            '/api/tags/tally': {
                post: {
                    tags: ['tags'],
                    summary: `The tags a set of characters carries and how many of the set carry each, most carried first, with the size of the set: what the batch tag editor shows as the tags on every character and on some. The set is charIds (an unknown id is not counted; at most ${IDS_MAX} a request, so a larger selection is counted in parts, which add up, or by its filter) or filter (a GET /api/characters query string, read the list's way; sort, order, paging and count ignored), never both. An empty filter is the whole library and answers from the tag list itself`,
                    requestBody: body({ type: 'object', properties: { charIds: { type: 'array', items: STR, description: `at most ${IDS_MAX}` }, filter: { ...STR, description: 'a GET /api/characters query string' } } }),
                    responses: { 200: json({ type: 'object', properties: { total: INT, tags: { type: 'array', items: { type: 'object', properties: { name: STR, count: INT } } } } }), 400: err(`neither charIds nor a filter, both, more than ${IDS_MAX} charIds, a filter parameter refused in the list's words, or a filter parameter the list does not take`) },
                },
            },
            '/api/tags/resolve': {
                post: {
                    tags: ['tags'],
                    summary: 'Names snapped to the spellings the library already uses: each matched by name case-insensitively in ASCII, then by loose key (case, spacing and punctuation folded, so post-apocalyptic finds Post Apocalyptic), answered with the stored spelling and the carrier count of that tag; an unknown name comes back as given with known false. Input order, deduped by resolved key, blanks dropped, at most 200 names. A read for anything that offers tags (the tag wand of the creator), never a mint',
                    requestBody: body({ type: 'object', required: ['names'], properties: { names: { type: 'array', items: STR, description: 'at most 200 are read' }, each: { type: 'boolean', description: 'true: one answer per name in its place, duplicates and blanks included (a blank tag for what is no name), so many names map back; default: deduped by resolved key, blanks dropped' } } }),
                    responses: { 200: json({ type: 'object', properties: { tags: { type: 'array', items: { type: 'object', properties: { tag: STR, known: { type: 'boolean' }, count: { ...INT, nullable: true } } } } } }), 400: err('names array required') },
                },
            },
            '/api/llm/kinds': {
                get: { tags: ['llm'], summary: "The connection kinds this account can use, with capabilities + base-url requirements (drives the settings UI): the app's own, then the ones this account's switched-on extensions add (ctx.llm.registerAdapter), each naming its extension. A kind whose extension is off for the account is absent, and the profile routes refuse it as a kind", 'x-collection': asWhole('the app\'s kinds and the ones the account\'s extensions add'), responses: { 200: json({ type: 'array', items: { type: 'object', properties: { kind: STR, displayName: STR, defaultBaseUrl: STR, requiresBaseUrl: { type: 'boolean' }, capabilities: { type: 'object', description: 'streaming, json, reasoning, and vision (the kind sends pictures a message carries)' }, extension: { ...STR, description: 'the extension that adds this kind; absent for the app\'s own' } } } }) } },
            },
            '/api/presets': {
                get: {
                    tags: ['llm'], summary: 'Every prompt preset by name, plus the active one. A row carries no blocks: one preset is read whole by its id, or beside the resolve that names it. activeId null means assembly uses the built-in default block list, which is returned as defaultBlocks so a client can show it instead of rendering a blank panel',
                    'x-collection': asWhole('the reader\'s own presets'),
                    responses: {
                        200: json({
                            type: 'object',
                            properties: {
                                presets: { type: 'array', items: ref('PresetRow') },
                                activeId: { type: 'string', nullable: true },
                                defaultBlocks: {
                                    type: 'array', items: ref('PresetBlock'),
                                    description: 'the built-in fallback, read-only: no preset holds it',
                                },
                                defaultSettings: { ...ref('PresetSettings'), description: 'every setting\'s default: what the built-in blocks use, and what a preset reads for one it does not set' },
                            },
                        }),
                    },
                },
                post: {
                    tags: ['llm'], summary: 'Create a preset. Omitting blocks seeds the default block list, never an empty one (an empty preset assembles no character at all). regexScripts, a preset file\'s own, are stored as the preset\'s scripts, which run once the preset is allowed',
                    requestBody: body({ type: 'object', properties: { name: STR, blocks: { type: 'array', items: ref('PresetBlock') }, regexScripts: { type: 'array', items: ref('RegexScript') }, settings: { ...ref('PresetSettings'), description: 'the settings it starts with (a copy sends the original\'s); one left out reads its default' } }, required: ['name'] }),
                    responses: { 200: json(ref('Preset')), 400: err('name missing / unknown marker / bad role or position / a setting not listed, of another type, or a text past 20000 characters / a regex script out of shape (refused as /api/regex/scripts refuses it, nothing made) / more than 1000 scripts') },
                },
            },
            '/api/presets/import': {
                post: {
                    tags: ['llm'], summary: 'Import a SillyTavern chat-completion preset. Connection identity (chat_completion_source, *_model, custom_url, reverse_proxy, proxy_password) is DROPPED because the LLM profile holds it, and everything dropped is named in the report. The settings that shape its prompt (its formats, its new-chat and example lines, its impersonation and continue instructions, squash) become the preset\'s own settings, and a block after Chat History in its order goes after the history',
                    requestBody: body({ type: 'object', properties: { preset: { type: 'object' }, name: STR }, required: ['preset'] }),
                    responses: {
                        200: json({ type: 'object', properties: { preset: ref('Preset'), report: ref('PresetImportReport') } }),
                        400: err('not an object / nothing expressible in it'),
                    },
                },
            },
            '/api/presets/active': {
                put: {
                    tags: ['llm'], summary: 'Select the active preset, or pass id null to fall back to the built-in default',
                    requestBody: body({ type: 'object', properties: { id: { type: 'string', nullable: true } } }),
                    responses: { 200: json({ type: 'object', properties: { activeId: { type: 'string', nullable: true } } }), 400: err('id must be a string or null'), 404: err('no such preset') },
                },
            },
            '/api/presets/resolve': {
                get: {
                    tags: ['llm'],
                    summary: 'Which preset builds one chat\'s prompt: the chat\'s own when set, else the active preset, else none (the built-in blocks). Omit chatId to resolve the default. with=preset answers that preset whole beside its id',
                    parameters: [p('chatId', STR, 'chat uuid; omit for the default answer'), p('with', { ...STR, enum: ['preset'] }, 'preset: the answer also carries the preset in force, with its blocks')],
                    responses: {
                        400: err('with is not preset'),
                        200: json({
                            type: 'object',
                            properties: {
                                preset: { ...ref('Preset'), nullable: true, description: 'with=preset only: the preset in force, null under the built-in blocks' },
                                presetId: { ...STR, nullable: true, description: 'the preset in force; null means the built-in blocks' },
                                source: { ...STR, enum: ['chat', 'default', 'builtin'] },
                                override: { ...STR, nullable: true, description: "the chat's RAW pointer, so a client can tell set-here from inherited" },
                                defaultId: { ...STR, nullable: true, description: 'the active preset, which a chat with none of its own follows' },
                            },
                        }),
                    },
                },
            },
            '/api/presets/{id}/export': {
                get: {
                    tags: ['llm'], summary: 'The preset as a SillyTavern chat-completion preset file: its blocks as prompts in their order, its settings under the file\'s keys, its regex scripts in the file\'s extensions. What the file has no place for (the character picture block, the directed-reply instruction) is named in the report',
                    parameters: [pathId('id', 'preset uuid'), p('format', { ...STR, enum: ['sillytavern'] }, 'the file format; sillytavern is the one there is')],
                    responses: {
                        200: json({ type: 'object', properties: { doc: { type: 'object', description: 'the file, as SillyTavern reads it' }, report: { type: 'object', properties: { droppedBlocks: { type: 'array', items: STR, description: 'the ids of the blocks the file has no place for' }, droppedSettings: { type: 'array', items: STR, description: 'the settings the file has no key for' } } } } }),
                        400: err('an unknown format'), 404: err('no such preset'),
                    },
                },
            },
            '/api/presets/{id}': {
                get: { tags: ['llm'], summary: 'One preset with its blocks', parameters: [pathId('id', 'preset uuid')], responses: { 200: json(ref('Preset')), 404: err('no such preset') } },
                patch: {
                    tags: ['llm'], summary: 'Update a preset. Supplying blocks REPLACES the list wholesale, because order is part of the data; supplying settings replaces them whole too, a setting left out reading its default again',
                    parameters: [pathId('id', 'preset uuid')],
                    requestBody: body({ type: 'object', properties: { name: STR, blocks: { type: 'array', items: ref('PresetBlock') }, settings: ref('PresetSettings') } }),
                    responses: { 200: json(ref('Preset')), 400: err('blank name / invalid block / a setting not listed, of another type, or a text past 20000 characters'), 404: err('no such preset') },
                },
                delete: {
                    tags: ['llm'], summary: 'Delete a preset; deleting the active one clears the selection so assembly falls back to the default',
                    parameters: [pathId('id', 'preset uuid')],
                    responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' } } }), 404: err('no such preset') },
                },
            },
            '/regex/engine.js': {
                get: {
                    tags: ['llm'], summary: 'The regex engine the server runs, as a JavaScript module served without signing in, so a client\'s screen pass gives the same results',
                    responses: { 200: { description: 'the module', content: { 'application/javascript': { schema: { type: 'string' } } } } },
                },
            },
            '/api/regex/chat/{chatId}': {
                get: {
                    tags: ['llm'],
                    summary: 'The regex scripts a chat runs: the reader\'s own, then its preset\'s, then its character\'s, each source whole with its answer (allowed, declined, or null while unanswered); active is the run order, a preset\'s or a character\'s scripts only while allowed; names fills {{user}} and {{char}} for the screen\'s pass. The read first tries the scripts that change what is shown on the chat\'s newest 50 shown texts under the same time budget, so a pattern that runs out of time there is stopped (flagged stopped here, and skipped by every pass until saved again)',
                    parameters: [pathId('chatId', 'chat uuid')],
                    responses: {
                        200: json({
                            type: 'object',
                            properties: {
                                yours: { type: 'array', items: ref('RegexScript') },
                                preset: { type: 'object', nullable: true, properties: { id: STR, name: STR, source: { ...STR, enum: ['chat', 'default'] }, consent: { ...STR, nullable: true, enum: ['allowed', 'declined', null] }, scripts: { type: 'array', items: ref('RegexScript') } } },
                                character: { type: 'object', nullable: true, properties: { id: STR, name: STR, consent: { ...STR, nullable: true, enum: ['allowed', 'declined', null] }, scripts: { type: 'array', items: ref('RegexScript') } } },
                                active: { type: 'array', items: ref('RegexScript') },
                                names: { type: 'object', properties: { user: STR, char: STR } },
                            },
                        }),
                        404: err('no such chat'),
                    },
                },
            },
            '/api/regex/scripts': {
                get: {
                    tags: ['llm'], summary: 'One list of regex scripts in run order: the reader\'s own, or a preset\'s when presetId names one',
                    parameters: [p('presetId', STR, 'preset uuid; omit for the reader\'s own')],
                    'x-collection': asWhole('one list of regex scripts'),
                    responses: { 200: json({ type: 'object', properties: { presetId: { ...STR, nullable: true }, scripts: { type: 'array', items: ref('RegexScript') } } }), 404: err('no such preset') },
                },
                post: {
                    tags: ['llm'], summary: 'Add regex scripts to the reader\'s list or a preset\'s: one as script, or several as scripts (an import); each gets a new id. after places them right below that script. A single script is first run over sample when sent, and one that runs out of time there is refused',
                    requestBody: body({ type: 'object', properties: { presetId: { ...STR, nullable: true }, script: ref('RegexScript'), scripts: { type: 'array', items: ref('RegexScript') }, after: STR, sample: STR } }),
                    responses: { 200: json({ type: 'object', properties: { scripts: { type: 'array', items: ref('RegexScript') } } }), 400: err('no script / a script not an object / a list past its limit'), 404: err('no such preset'), 422: err('the pattern ran out of time on the sample (kind timeout)') },
                },
            },
            '/api/regex/scripts/{id}': {
                patch: {
                    tags: ['llm'], summary: 'Replace one regex script\'s fields; run over sample first when sent, and refused when it runs out of time there. Saving clears a stop for running out of time',
                    parameters: [pathId('id', 'script uuid')],
                    requestBody: body({ type: 'object', properties: { script: ref('RegexScript'), sample: STR }, required: ['script'] }),
                    responses: { 200: json({ type: 'object', properties: { script: ref('RegexScript') } }), 400: err('not an object / bad field'), 404: err('no such script'), 422: err('the pattern ran out of time on the sample (kind timeout)') },
                },
                delete: {
                    tags: ['llm'], summary: 'Remove one regex script from its list',
                    parameters: [pathId('id', 'script uuid')],
                    responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' } } }), 404: err('no such script') },
                },
            },
            '/api/regex/order': {
                put: {
                    tags: ['llm'], summary: 'Put the reader\'s list or a preset\'s in a new order; ids names every script in it, each once',
                    requestBody: body({ type: 'object', properties: { presetId: { ...STR, nullable: true }, ids: { type: 'array', items: STR } }, required: ['ids'] }),
                    responses: { 200: json({ type: 'object', properties: { scripts: { type: 'array', items: ref('RegexScript') } } }), 400: err('ids not exactly the list'), 404: err('no such preset') },
                },
            },
            '/api/regex/characters/{charId}': {
                get: {
                    tags: ['llm'], summary: 'A character\'s regex scripts, as its card carries them',
                    parameters: [pathId('charId', 'character uuid')],
                    responses: { 200: json({ type: 'object', properties: { scripts: { type: 'array', items: ref('RegexScript') } } }), 404: err('no such character') },
                },
                put: {
                    tags: ['llm'], summary: 'Replace a character\'s regex scripts on its card (an empty list removes them); it reaches open tabs as the character\'s update. With sample, each script is tried on it first and a list holding one that runs out of time is refused (422, kind timeout), nothing written',
                    parameters: [pathId('charId', 'character uuid')],
                    requestBody: body({ type: 'object', properties: { scripts: { type: 'array', items: ref('RegexScript') }, sample: STR }, required: ['scripts'] }),
                    responses: { 200: json({ type: 'object', properties: { scripts: { type: 'array', items: ref('RegexScript') } } }), 400: err('scripts not a list / a script not an object'), 404: err('no such character'), 422: err('a script ran out of time on the sample') },
                },
            },
            '/api/regex/consent': {
                put: {
                    tags: ['llm'], summary: 'Answer whether a preset\'s or a character\'s regex scripts may run: allowed, declined, or null to leave it unanswered. Name presetId or charId, not both. A character\'s allowed stands for the scripts its card held then: a card written over the character with other scripts (a Replace, a SillyTavern migration run again) leaves it unanswered',
                    requestBody: body({ type: 'object', properties: { presetId: STR, charId: STR, answer: { ...STR, nullable: true, enum: ['allowed', 'declined', null] } }, required: ['answer'] }),
                    responses: { 200: json({ type: 'object', properties: { answer: { ...STR, nullable: true } } }), 400: err('neither or both named / an unknown answer'), 404: err('no such preset or character') },
                },
            },
            '/api/regex/test': {
                post: {
                    tags: ['llm'], summary: 'Run one regex script alone over a sample, under the same time limit a chat has: what the screen shows, what the model is sent, what a save would keep, and how many places it matches. error is timeout when it ran out of time, invalid when the find does not compile (matches is then 0). chatId fills macros from that chat',
                    requestBody: body({ type: 'object', properties: { script: ref('RegexScript'), text: STR, where: { type: 'integer', enum: [1, 2, 3, 5, 6] }, depth: { type: 'integer' }, chatId: STR }, required: ['script'] }),
                    responses: { 200: json({ type: 'object', properties: { screen: STR, prompt: STR, saved: STR, matches: { type: 'integer' }, error: { ...STR, nullable: true } } }), 400: err('not an object / bad field') },
                },
            },
            '/api/regex/export': {
                get: {
                    tags: ['llm'], summary: 'A list of regex scripts as a SillyTavern script file holds them: the reader\'s own, a preset\'s (presetId) or a character\'s (charId)',
                    'x-collection': asWhole('one list of regex scripts'),
                    parameters: [p('presetId', STR, 'preset uuid'), p('charId', STR, 'character uuid')],
                    responses: { 200: json({ type: 'array', items: ref('RegexScript') }), 404: err('no such preset or character') },
                },
            },
            '/api/personas/{id}/avatar': {
                put: {
                    tags: ['library'],
                    summary: 'Replace this persona picture (raw image body, converted to PNG server-side). Rewritten in place, so the file is served on ETag revalidation rather than an immutable cache',
                    parameters: [pathId('id', 'persona uuid')],
                    requestBody: { required: true, content: { 'image/*': { schema: { type: 'string', format: 'binary' } } } },
                    responses: { 200: json(ref('Persona')), 400: err('empty body'), 404: err('persona not found'), 415: err('not a decodable image') },
                },
                delete: {
                    tags: ['library'], summary: 'Remove the picture; the persona keeps its name and description',
                    parameters: [pathId('id', 'persona uuid')],
                    responses: { 200: json(ref('Persona')), 404: err('persona not found') },
                },
            },
            '/persona-avatars/{file}': {
                get: { tags: ['infra'], summary: 'Persona picture ({persona-uuid}.png, ETag revalidation)', parameters: [pathId('file', 'persona uuid plus .png')], responses: { 200: { description: 'image/png' }, 400: err('bad path'), 404: err('not found') } },
            },
            '/thumbs/persona/{id}': {
                get: { tags: ['infra'], summary: 'Persona picture thumbnail (same size ladder)', parameters: [pathId('id', 'persona uuid'), p('s', INT, 'target size, px')], responses: { 200: { description: 'image/webp' }, 400: err('bad id'), 404: err('persona avatar not found') } },
            },
            '/api/personas/resolve': {
                get: {
                    tags: ['library'],
                    summary: "Who the user is in one chat: the per-chat override when set, else the global persona. Omit chatId to resolve the global, which is what every preview outside a conversation uses",
                    parameters: [p('chatId', STR, 'chat uuid; omit for the global answer')],
                    responses: {
                        200: json({
                            type: 'object',
                            properties: {
                                persona: { ...ref('Persona'), nullable: true },
                                source: { ...STR, enum: ['chat', 'global', 'none'] },
                                override: { ...STR, nullable: true, description: "the chat's RAW pointer, so a client can tell set-here from inherited" },
                            },
                        }),
                    },
                },
            },
            '/api/personas': {
                get: {
                    tags: ['library'], summary: 'All personas plus the active one (activeId is null when none is selected). Each row carries its bound lorebook names so an editor renders without a per-persona read',
                    'x-collection': asWhole('the reader\'s own personas'),
                    responses: { 200: json({ type: 'object', properties: { personas: { type: 'array', items: { allOf: [ref('Persona'), { type: 'object', properties: { worlds: { type: 'array', items: STR } } }] } }, activeId: { type: 'string', nullable: true } } }) },
                },
                post: {
                    tags: ['library'], summary: 'Create a persona. The first one created becomes active; later ones do not steal the selection',
                    requestBody: body({ type: 'object', properties: { name: STR, description: STR, pronouns: PRONOUNS_WRITE }, required: ['name'] }),
                    responses: { 200: json(ref('Persona')), 400: err('name missing or blank, or pronouns not an object of the five forms as strings of at most 64 characters') },
                },
            },
            '/api/personas/active': {
                put: {
                    tags: ['library'], summary: 'Select the active persona, or pass id null to clear it',
                    requestBody: body({ type: 'object', properties: { id: { type: 'string', nullable: true } } }),
                    responses: { 200: json({ type: 'object', properties: { activeId: { type: 'string', nullable: true }, persona: { ...ref('Persona'), nullable: true, description: 'the persona now active; null once cleared' } } }), 400: err('id must be a string or null'), 404: err('no such persona') },
                },
            },
            '/api/personas/{id}': {
                get: { tags: ['library'], summary: 'One persona', parameters: [pathId('id', 'persona uuid')], responses: { 200: json(ref('Persona')), 404: err('no such persona') } },
                patch: {
                    tags: ['library'], summary: 'Update a persona; omitted fields are left alone (a one-field patch never blanks the rest)',
                    parameters: [pathId('id', 'persona uuid')],
                    requestBody: body({ type: 'object', properties: { name: STR, description: STR, pronouns: PRONOUNS_WRITE } }),
                    responses: { 200: json(ref('Persona')), 400: err('blank name / wrong type, or pronouns not an object of the five forms as strings of at most 64 characters'), 404: err('no such persona') },
                },
                delete: {
                    tags: ['library'], summary: 'Delete a persona. Deleting the active one clears the selection in the same write',
                    parameters: [pathId('id', 'persona uuid')],
                    responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' } } }), 404: err('no such persona') },
                },
            },
            '/api/llm/profiles': {
                get: { tags: ['llm'], summary: 'LLM profiles (api keys never returned; hasKey and keyHint only)', 'x-collection': asWhole('the reader\'s own connection profiles'), responses: { 200: json({ type: 'array', items: ref('LlmProfile') }) } },
                post: {
                    tags: ['llm'], summary: 'Create a profile (kind must be a registered adapter; params = neutral default generation params)',
                    requestBody: body({ type: 'object', properties: { name: STR, kind: STR, baseUrl: STR, apiKey: STR, model: STR, params: { type: 'object' }, contextSize: { type: 'integer', nullable: true, description: 'token window this connection declares; overrides the global chat budget, null uses it' }, vision: { type: 'boolean', nullable: true, description: 'whether the model sees pictures: true, false, or null when not checked; a call carrying pictures to a connection set false is refused' }, maxImages: { type: 'integer', nullable: true, description: 'the most pictures the host takes in one request; a chat prompt over it sends the oldest as text, null is no limit' } }, required: ['name'] }),
                    responses: { 200: json(ref('LlmProfile')), 400: err('a bad kind, a blank or missing name, a contextSize that is not a positive number, a vision that is not true, false or null, a maxImages that is not a whole number above zero or null, or params that are not an object or that the neutral vocabulary refuses (an unknown key, a sampler that is not a number, a bad stop, json or reasoning.effort)') },
                },
            },
            '/api/llm/profiles/resolve': {
                get: {
                    tags: ['llm'],
                    summary: 'Which connection answers one chat: the chat\'s own when set, else the default for chats, else the first. Omit chatId to resolve the default',
                    parameters: [p('chatId', STR, 'chat uuid; omit for the default answer')],
                    responses: {
                        200: json({
                            type: 'object',
                            properties: {
                                profile: { ...ref('LlmProfile'), nullable: true },
                                source: { ...STR, enum: ['chat', 'default', 'none'] },
                                override: { ...STR, nullable: true, description: "the chat's RAW pointer, so a client can tell set-here from inherited" },
                                defaultId: { ...STR, nullable: true, description: 'the default for chats, which a chat with none of its own follows' },
                            },
                        }),
                    },
                },
            },
            '/api/llm/profiles/{id}': {
                patch: {
                    tags: ['llm'], summary: 'Update a profile; apiKey is write-only (absent = keep, empty = clear)',
                    parameters: [pathId('id', 'profile uuid')],
                    requestBody: body({ type: 'object', properties: { name: STR, kind: STR, baseUrl: STR, apiKey: STR, model: STR, params: { type: 'object' }, contextSize: { type: 'integer', nullable: true, description: 'token window this connection declares; overrides the global chat budget, null uses it' }, vision: { type: 'boolean', nullable: true, description: 'whether the model sees pictures: true, false, or null when not checked; a call carrying pictures to a connection set false is refused' }, maxImages: { type: 'integer', nullable: true, description: 'the most pictures the host takes in one request; a chat prompt over it sends the oldest as text, null is no limit' } } }),
                    responses: { 200: json(ref('LlmProfile')), 400: err('a bad kind, a blank name, a contextSize that is not a positive number, a vision that is not true, false or null, a maxImages that is not a whole number above zero or null, or params that are not an object or that the neutral vocabulary refuses (an unknown key, a sampler that is not a number, a bad stop, json or reasoning.effort)'), 404: err('not found') },
                },
                delete: { tags: ['llm'], summary: 'Delete a profile', parameters: [pathId('id', 'profile uuid')], responses: { 200: json(ref('Ok')), 404: err('not found') } },
            },
            '/api/llm/profiles/{id}/duplicate': {
                post: {
                    tags: ['llm'], summary: 'Copy a profile at the end of the order, the stored API key included (the client can never read a key back, so the copy is made here); name defaults to "<name> copy"',
                    parameters: [pathId('id', 'profile uuid')],
                    requestBody: body({ type: 'object', properties: { name: STR } }, false),
                    responses: { 200: json(ref('LlmProfile')), 404: err('not found') },
                },
            },
            '/api/llm/models': {
                get: {
                    tags: ['llm'], summary: "Model list from the profile's upstream (contextLength only when upstream reports it; no hardcoded tables)",
                    'x-collection': asWhole('the upstream\'s model list'),
                    parameters: [p('profileId', STR, 'omit = first profile')],
                    responses: { 200: json({ type: 'array', items: { type: 'object', properties: { id: STR, contextLength: INT, vision: { type: 'boolean', description: 'whether the model sees pictures, present only when the endpoint\'s list says' } } } }), 502: err('upstream/list failure with kind') },
                },
                post: {
                    tags: ['llm'], summary: 'Same list, probing an editor DRAFT: overrides (kind, baseUrl, apiKey, model) overlay the stored profile for this call only, nothing is saved, and the stored key stands in when the draft key is blank. Overrides ride the body so a key never lands in a query string',
                    requestBody: body({ type: 'object', properties: { profileId: { ...STR, description: 'omit = first profile' }, overrides: { type: 'object', properties: { kind: STR, baseUrl: STR, apiKey: STR, model: STR } } } }, false),
                    responses: { 200: json({ type: 'array', items: { type: 'object', properties: { id: STR, contextLength: INT, vision: { type: 'boolean', description: 'whether the model sees pictures, present only when the endpoint\'s list says' } } } }), 400: err('unknown kind / draft without a base URL'), 502: err('upstream/list failure with kind') },
                },
            },
            '/api/llm/test': {
                post: {
                    tags: ['llm'], summary: 'Connection probe: a 1-token real chat under a 15s ceiling. Always 200; the body carries the verdict. overrides (kind, baseUrl, apiKey, model) overlay the stored profile for this call only, the way the model probe takes a draft, so what is on screen is what gets tested and a key is checked before it is saved; the stored key stands in when the draft key is blank',
                    requestBody: body({ type: 'object', properties: { profileId: STR, overrides: { type: 'object', properties: { kind: STR, baseUrl: STR, apiKey: STR, model: STR } } } }, false),
                    responses: { 200: json({ type: 'object' }, '{ok} | {ok: false, kind, error, timedOut}') },
                },
            },
            '/api/llm/test-vision': {
                post: {
                    tags: ['llm'], summary: 'Sight probe: shows the model two small pictures of one colour each and asks it to name both, under a 60s ceiling, through the draft as the connection probe takes one. Always 200; the body carries the verdict: sees true when it names both in order; false with a reason when the kind cannot carry pictures, the endpoint refused them (its words) or the answer missed them (what it said); null when the call could not be made or came back empty. Nothing is stored: a saved answer is the profile\'s vision',
                    requestBody: body({ type: 'object', properties: { profileId: STR, overrides: { type: 'object', properties: { kind: STR, baseUrl: STR, apiKey: STR, model: STR } } } }, false),
                    responses: { 200: json({ type: 'object' }, '{sees: true} | {sees: false, reason: kind|refused|answer, error?, said?} | {sees: null, kind, error}') },
                },
            },
            '/api/llm/chat': {
                post: {
                    tags: ['llm'],
                    summary: "Server-side LLM call via a profile (keys never reach clients). Neutral params (temperature, topP, topK, maxTokens, stop, presencePenalty, frequencyPenalty, seed, reasoning{effort}, json) are translated per adapter; profile defaults merge under request params; flat temperature/maxTokens stay accepted. stream=false: normalized {content, reasoning?, finishReason, usage?, profileId}. stream=true: SSE with events chunk({text}|{reasoning}) / done({finishReason, usage?}) / error({kind, message}) - typed even mid-stream. Retries are bounded and pre-first-token only; streams are reaped on token INACTIVITY, not request age; aborting the request observably disconnects the upstream",
                    requestBody: body({ type: 'object', properties: { profileId: { ...STR, description: 'omit = first profile' }, messages: { type: 'array', items: { type: 'object', properties: { role: STR, content: STR, images: { type: 'array', description: "pictures the model reads with this message, on the user's messages only and on a kind whose capabilities include vision; each is shrunk to a long edge of at most 1568 px, turned upright and stripped of metadata before it is sent. At most 100 a call", items: { type: 'object', properties: { data: { ...STR, description: 'the picture\'s bytes, base64 or a data URL (at most 20 MB)' }, ref: { type: 'object', description: 'a picture of this account instead: avatar (a character\'s portrait by its id), media (a gallery image by its id), persona (a persona\'s picture by its id) or attachment (a chat\'s or a studio session\'s own picture by its id)', properties: { kind: { type: 'string', enum: ['avatar', 'media', 'persona', 'attachment'] }, id: STR } } } } } } } }, model: STR, params: { type: 'object' }, stream: { type: 'boolean' }, temperature: { type: 'number' }, maxTokens: INT }, required: ['messages'] }),
                    responses: { 200: json({ type: 'object' }, 'normalized result, or text/event-stream when stream=true'), 400: err('no profile / bad body / unknown param / an image the call cannot carry'), 502: err('upstream error with kind'), 504: err('timeout') },
                },
            },
            '/api/bundle/export': {
                post: {
                    tags: ['library'],
                    summary: 'Build and stream a transfer bundle (.zip): card PNGs (chunks embedded fresh), chats as JSONL, gallery media, worlds, plus a manifest carrying each character\'s flags (favourite, update lock, media localized, lore dismissed) and lorebook lists. v2 layout: zip paths key on the character uuid, card file names are derived cosmetics. X-Bundle-Count holds how many characters the archive carries. A character it cannot carry (its picture or its card gone) is left out and named: X-Bundle-Skipped-Count holds how many, X-Bundle-Skipped their ids (up to 1000, comma-separated); the three are exposed to a detached client',
                    requestBody: body({
                        type: 'object',
                        properties: {
                            ids: { type: 'array', items: STR, description: 'character uuids, exported in this order, a repeated one once; omit (with no filter) for the whole library (in creation order; a character renamed mid-export goes out once)' },
                            filter: { ...STR, description: 'a GET /api/characters query string (read the list\'s way; sort, order, paging and count ignored): its set, walked in creation order as it stands, so one created mid-walk that matches goes out and one deleted mid-walk is skipped and named. Never with ids' },
                            include: { type: 'object', properties: { chats: { type: 'boolean' }, media: { type: 'boolean' }, worlds: { type: 'boolean' } }, description: 'all default true' },
                        },
                    }, false),
                    responses: { 200: { description: 'application/zip attachment' }, 400: err('nothing to export (the library is empty, or the filter names no character), ids and a filter both, a filter parameter refused in the list\'s words, or one the list does not take'), 404: err('unknown id') },
                },
            },
            '/api/bundle/import': {
                post: {
                    tags: ['library'],
                    summary: 'Import a v2 transfer bundle (raw zip body, streamed to disk: the body is as large as the disk holds, while what it unpacks is capped per member and by the archive budget). Imports NEVER overwrite: each entry triages to new (adopting its free uuid), identical-skip (content hash match; its new chats/media still attach additively), or diverged-skip (uuid taken or provider link matched; reported, nothing written). Each entry (its card, chats, gallery and links) lands whole or not at all: an entry refused part way through, by an extension\'s store guard included, is named in errors with nothing of it kept, and the restore goes on with the next. A client that hangs up mid-upload leaves nothing (the half-received pack is discarded); one that hangs up during the restore stops it before its next entry, the entries already restored staying. v1/extension packs are rejected with a pointer at the migration tool',
                    parameters: [
                        p('worlds', BOOL, 'false (or 0, no) skips the bundled lorebooks AND each character\'s and chat\'s lorebook list past its first book (the first rides the card and the chat header); a value outside the boolean words is 400'),
                        p('only', CSV, 'restrict to these manifest uids, and the bundled lorebooks to the ones those entries name (a pack from before the per-entry lists brings all of its lorebooks)'),
                        p('copy', CSV, 'manifest uids to import as forced NEW copies (the per-entry override for diverged duplicates)'),
                    ],
                    requestBody: { required: true, content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } },
                    responses: { 200: json({ type: 'object' }, '{imported, identical, diverged[], chats, chatLinesDropped (chat file lines left out: torn, or not a JSON object), media, worlds, worldsRenamed, errors}'), 400: err('not a zip / no manifest / pre-v2 pack; or refused by the archive reader: a member past the import cap, members unpacking past the archive budget, or a corrupt member (its local header, its checksum, or inflating past its declared size)'), 415: err('a Content-Type other than application/zip, application/x-zip-compressed or application/octet-stream') },
                },
            },
            '/api/tag-runs': {
                get: { tags: ['tags'], summary: 'The bulk tag-run undo journal, newest first: {id, ts, label, kind, opCount, linkCount} per run (kind links: the links a tag op or job moved, and its opCount the saved filter preset rules its renames and removes rewrote; the server keeps the newest run alone, the one an undo reaches)', 'x-collection': asWhole('the newest run'), responses: { 200: json({ type: 'array', items: { type: 'object' } }) } },
            },
            '/api/tag-runs/{id}/undo': {
                post: {
                    tags: ['tags'], summary: 'Undo the newest run when it is a tag job\'s (kind links): a job of its own takes off the links the run added and puts back the ones it removed (a tag the removal pruned is minted again; a character deleted since is passed over), then, as its last step, puts back each saved filter preset rule the run rewrote, newest first, only where the preset still holds what the run left (a preset deleted or a rule changed since is left as it stands, and a rule coming back never doubles one the preset holds), and says each rename, merge or remove the run journaled the other way, newest first: a rename back is reported as a tag rename (a tag change record, the name and its to), so every client\'s filters naming the tag follow it, while a merge\'s or a remove\'s undo brings the name back and reports no rename; all of it journaled as a links run of its own so the undo can be undone, and undoing that undo reports a rename, merge or remove as the op did. Answered at once (202) with the job (GET /api/jobs/{id}). A tag job queued or running holds it; a job of another kind does not, and the undo waits behind it on the lane',
                    parameters: [pathId('id', 'run id')],
                    responses: { 202: json({ type: 'object', properties: { ok: { type: 'boolean' }, job: ref('SetJob') } }), 400: err('numeric id required'), 404: err('run not found'), 409: err('not the newest run, or a tag job queued or running') },
                },
            },
            '/api/tag-runs/{id}': {
                get: { tags: ['tags'], summary: 'One run\'s summary, as the journal lists it (its links are the server\'s to undo, never listed)', parameters: [pathId('id', 'run id')], responses: { 200: json({ type: 'object' }), 400: err('numeric id required'), 404: err('run not found') } },
                delete: { tags: ['tags'], summary: 'Drop a run, and the undo it held with it', parameters: [pathId('id', 'run id')], responses: { 200: json(ref('Ok')), 400: err('numeric id required'), 404: err('run not found') } },
            },
            '/api/media-jobs': {
                get: {
                    tags: ['media'], summary: 'A page of the media download queue: pending and active jobs, one per character, oldest first by id, so a job enqueued later lands past any cursor held (a job goes with its character). An active job carries stale: true once its worker stopped renewing the lease, so a resuming tab may take it, and leaseLeftMs, the milliseconds until its lease runs out as the server counts them (0 once stale; null on a pending job), so a tab that skipped it looks again then',
                    'x-collection': asPage(PAGE_DEFAULT, PAGE_MAX),
                    parameters: [...PAGE_PARAMS('jobs'), p('ids', CSV, `job ids, at most ${PAGE_MAX}: those jobs alone, a page at their own count (limit defaults to it)`)],
                    responses: { 200: json(pageSchema({ type: 'object' })), 400: err(`a limit outside 1 to ${PAGE_MAX}, an after that is not a cursor, ids that are not job ids or more than ${PAGE_MAX} of them, or a count that is not a boolean word`) },
                },
                post: {
                    tags: ['media'],
                    summary: 'Enqueue (or re-enqueue) the one job a character can hold: a pending job takes the new name and phases, an active job is left to the worker',
                    requestBody: body({ type: 'object', required: ['charId'], properties: { charId: STR, name: STR, phases: { type: 'array', items: STR } } }),
                    responses: { 200: json({ type: 'object' }, 'the job'), 400: err('charId must be a character uuid; phases must be an array of strings'), 404: err('character not found') },
                },
            },
            '/api/media-jobs/batch': {
                post: {
                    tags: ['media'],
                    summary: "Queue a set's characters for a media download: those with a remote url in the card or a provider link get one pending job each (a pending job is kept, an active one left to its worker). The set is charIds, a selection's filter, or all: true for the library. rescan (default true, false with all) scans the set again: the processed mark of each character queued is cleared and comes back as its job finishes; false leaves the characters processed before out. Runs to its end once begun",
                    requestBody: body({ type: 'object', properties: { charIds: { type: 'array', items: STR }, filter: STR, all: { type: 'boolean', enum: [true] }, rescan: { type: 'boolean' } } }),
                    responses: {
                        200: json({ type: 'object', properties: { total: INT, queued: INT, noMedia: INT, active: INT } }, 'total: the set (less the processed when rescan is false); queued: the characters with a pending job now; noMedia: those with no remote url and no provider link; active: those whose job a worker is running'),
                        400: err(`charIds, filter or all, one of them; at most ${IDS_MAX} charIds a request; a filter the list cannot read; rescan or all of the wrong kind`),
                        503: err('the library closed while the set was queued'),
                    },
                },
            },
            '/api/media-jobs/{id}': {
                patch: { tags: ['media'], summary: "The worker's claim and its lease: { status: 'active' } takes a pending job, or an active one whose worker stopped renewing the lease; { touch: true } renews the lease of an active job; { status: 'pending' } hands a job back", parameters: [pathId('id', 'job id')], requestBody: body({ type: 'object', properties: { status: { ...STR, enum: ['pending', 'active'] }, touch: { type: 'boolean' } } }), responses: { 200: json(ref('Ok')), 400: err('bad status'), 404: err('job not found, or no active job to touch'), 409: err('another worker holds this job') } },
                delete: { tags: ['media'], summary: 'Drop a job (finished, failed, aborted or removed by the user)', parameters: [pathId('id', 'job id')], responses: { 200: json(ref('Ok')), 400: err('numeric id required'), 404: err('job not found') } },
            },
            '/api/worlds': {
                get: {
                    tags: ['worlds'], summary: 'A page of the shelf: world summaries in name order, case folded (a reader that needs the whole shelf walks nextCursor); q asks for the names that contain it, in the same order. counts=true carries each book\'s reach counted per kind, the shelf\'s chips',
                    'x-collection': asPage(PAGE_DEFAULT, PAGE_MAX),
                    parameters: [...PAGE_PARAMS('books'), p('q', STR, 'the names that contain this text, case folded; a % or _ is a character'),
                        p('counts', BOOL, 'each book also carries chars, chats and personas (how many of each bind it) and global (whether the global list holds it)'),
                        p('placeholders', BOOL, 'a false word leaves out the placeholder books (names something binds with no book yet); default they are listed')],
                    responses: {
                        200: json(pageSchema({ allOf: [ref('WorldSummary'), { type: 'object', properties: { chars: INT, chats: INT, global: { type: 'boolean' }, personas: INT } }] })),
                        400: err(`a limit outside 1 to ${PAGE_MAX}, an after that is not a cursor, or a flag that is not a boolean word`),
                    },
                },
            },
            '/api/worlds/probe': {
                post: {
                    tags: ['worlds'],
                    summary: `The shelf probe: which of these keys (a provider's external ids or paths) name a book already on the shelf, by the source recorded for it (PUT /api/worlds/{name}/source). The /provider-links/probe sibling for lorebooks; at most ${PROBE_MAX_KEYS} keys`,
                    requestBody: body({ type: 'object', required: ['provider', 'keys'], properties: { provider: STR, keys: { type: 'array', items: STR } } }),
                    responses: { 200: json({ type: 'object', properties: { found: { type: 'array', items: STR } } }), 400: err(`provider or keys missing, or more than ${PROBE_MAX_KEYS} keys`) },
                },
            },
            '/api/worlds/{name}/usage': {
                get: {
                    tags: ['worlds'],
                    summary: 'One world\'s whole reach (linked characters, bound chats, global membership, persona bindings), read by its name alone: what the shelf asks before it fills a placeholder others link',
                    parameters: [pathId('name', 'world name')],
                    responses: { 200: json({ type: 'object' }), 404: err('world not found') },
                },
            },
            '/api/worlds/sweep': {
                post: {
                    tags: ['worlds'],
                    summary: 'Binding-only reference sweep: re-points (rename, the carrier-collision rule applied) or drops (remove) every binding naming the world across character links, chat bindings, the global list and persona bindings, all or nothing. Renaming the world itself is POST /api/worlds/{name}/rename, which runs this leg for you',
                    requestBody: body({ type: 'object', properties: { rename: { type: 'object', properties: { from: STR, to: STR } }, remove: STR } }),
                    responses: { 200: json({ type: 'object' }, '{touched}'), 400: err('bad sweep') },
                },
            },
            '/api/world-carriers': {
                get: { tags: ['worlds'], summary: "The books bound to a character, a chat (by its name or its character's) or a persona whose name BEGINS with the prefix, each with the names that matched, at most limit rows per arm. Names compare case-insensitively, in any alphabet. Served beside /api/worlds, never under it: a book name is free, so a path under /api/worlds would be a book no one could open", 'x-collection': asWhole('at most limit rows per arm and prefix form'), parameters: [p('prefix', STR, 'the start of a carrier name'), p('limit', INT, `rows per arm: default ${CARRIERS_DEFAULT}, at most ${CARRIERS_MAX}`)], responses: { 200: json({ type: 'array', items: { type: 'object', properties: { name: STR, matches: { type: 'array', items: STR } } } }), 400: err(`no prefix, or a limit outside 1 to ${CARRIERS_MAX}`) } },
            },
            '/api/world-entries': {
                get: {
                    tags: ['worlds'],
                    summary: `Every lorebook's entries whose title or content hold each word of q of two letters or more, each matching as a prefix; best match first, a title match weighing above a content match, with <mark> highlighting, paged by offset (a rank order has no key to seek). The hits are ranked among the newest ${ENTRY_SEARCH_RANKED} matching entries: a broader match is ranked there, and the envelope says capped: true. Served beside /api/worlds, never under it, as /api/world-carriers is`,
                    'x-collection': asPage(ENTRY_SEARCH_DEFAULT, ENTRY_SEARCH_MAX, { walk: 'offset' }),
                    parameters: [
                        { ...p('q', STR, 'plain text: every word of two letters or more required, each matching as a prefix (a lone letter is passed over); a text with no such words answers no hits'), required: true },
                        p('limit', INT, `hits a page: default ${ENTRY_SEARCH_DEFAULT}, at most ${ENTRY_SEARCH_MAX}; past it, walk offset`),
                        p('offset', INT, 'page start'),
                        p('count', BOOL, 'count=false skips the total (null in the envelope), the expensive leg of a broad match'),
                    ],
                    responses: { 200: json(ref('WorldEntrySearchEnvelope')), 400: err(`no q, a limit outside 1 to ${ENTRY_SEARCH_MAX}, an offset that is not a number, or a count that is not a boolean word`) },
                },
            },
            '/api/worlds/{name}': {
                get: { tags: ['worlds'], summary: 'Composed world doc ({entries: {uid: entry}, ...meta})', parameters: [pathId('name', 'world name')], responses: { 200: json({ type: 'object', properties: { name: STR, data: { type: 'object', description: '{entries: {uid: entry}, ...meta}' }, entryCount: INT, updatedAt: INT, placeholder: { type: 'boolean' }, source: { ...ref('WorldSource'), nullable: true } } }), 404: err('not found') } },
                put: { tags: ['worlds'], summary: "Create/replace whole world. expect=absent only creates (a book of that name in any case answers 409); expect=placeholder only fills a placeholder (409 when the book is not one)", parameters: [pathId('name', 'world name'), p('expect', { type: 'string', enum: ['absent', 'placeholder'] }, 'make the write a create or a placeholder fill')], requestBody: body({ type: 'object' }), responses: { 200: json(ref('Ok')), 400: err("no world name or data object, or an expect that is not 'absent' or 'placeholder'"), 409: err('the expectation failed: the name is taken, or the book is not a placeholder') } },
                delete: { tags: ['worlds'], summary: 'Delete a world; its entries and every binding go with it', parameters: [pathId('name', 'world name')], responses: { 200: json({ type: 'object' }, '{ok, unbound}'), 404: err('not found') } },
            },
            '/api/worlds/{name}/source': {
                put: {
                    tags: ['worlds'],
                    summary: 'Record where a book came from (one source per book; it follows a rename and goes with a delete). onlyIfMissing keeps a source the world already has, the "use the existing book" answer of the shelf import',
                    parameters: [pathId('name', 'world name')],
                    requestBody: body({ type: 'object', required: ['provider', 'externalId'], properties: { provider: STR, externalId: STR, path: { ...STR, nullable: true }, url: { ...STR, nullable: true }, onlyIfMissing: { type: 'boolean' } } }),
                    responses: { 200: json({ type: 'object', properties: { ok: { type: 'boolean' }, written: { type: 'boolean', description: 'false when onlyIfMissing kept the source the world had' } } }), 400: err('provider or externalId missing'), 404: err('world not found') },
                },
            },
            '/api/worlds/{name}/rename': {
                post: {
                    tags: ['worlds'],
                    summary: 'Rename a world, all or nothing: its entries and every binding (char, chat, persona, global) follow it, and a saved filter preset\'s lorebook rule naming it (case-insensitively in ASCII) takes the new name',
                    parameters: [pathId('name', 'current world name')],
                    requestBody: body({ type: 'object', required: ['to'], properties: { to: STR } }),
                    responses: { 200: json({ type: 'object' }, '{ok, touched}'), 400: err('new name required'), 404: err('world not found'), 409: err('a world with that name already exists') },
                },
            },
            '/api/worlds/{name}/entries': {
                post: { tags: ['worlds'], summary: 'Create one entry (uid allocated server-side)', parameters: [pathId('name', 'world name')], requestBody: body({ type: 'object' }), responses: { 200: json({ type: 'object' }, '{ok, uid}'), 400: err('entry object required'), 404: err('world not found') } },
            },
            '/api/worlds/{name}/entries/{uid}': {
                put: { tags: ['worlds'], summary: 'Merge onto one entry: absent fields keep their stored value, an explicit null or empty array clears (an entry carries ~40 fields while most editors show a dozen, so a replacing write would silently delete the difference)', parameters: [pathId('name', 'world name'), pathId('uid', 'entry uid')], requestBody: body({ type: 'object' }), responses: { 200: json(ref('Ok')), 400: err('a uid that is not a whole number, or no entry object'), 404: err('world not found') } },
                delete: { tags: ['worlds'], summary: 'Delete one entry', parameters: [pathId('name', 'world name'), pathId('uid', 'entry uid')], responses: { 200: json(ref('Ok')), 400: err('a uid that is not a whole number'), 404: err('entry not found') } },
            },

            '/api/playlists': {
                get: { tags: ['library'], summary: 'Every playlist with how many characters it holds: { version, playlists: { <id>: entry }, order: [<id>] }, each entry { name, description, icon, color, created, modified, count }. Who is in a playlist is read off the character list (each row carries the ids of its playlists, and a playlist rule filters by one) or asked of a selection (POST /api/playlists/tally), never mirrored whole', 'x-collection': asWhole('the reader\'s own playlists, without their members'), responses: { 200: json({ type: 'object' }) } },
                post: {
                    tags: ['library'], summary: 'Create a playlist at the end of the order; the id is minted by the server',
                    requestBody: body({ type: 'object', properties: { name: STR, description: STR, icon: STR, color: STR }, required: ['name'] }),
                    responses: { 200: json(ref('Playlist')), 400: err('name missing, blank or over 100 characters, or a field not a string'), 409: err('another playlist has this name (regardless of case)') },
                },
            },
            '/api/playlists/tally': {
                post: {
                    tags: ['library'], summary: 'How many of a selection of characters each playlist holds, for a picker over the selection: { <playlist id>: n }, the playlists none of them is in absent. The selection is charIds or filter (a GET /api/characters query string, read the list\'s way), never both',
                    requestBody: body({ type: 'object', properties: { charIds: { type: 'array', items: STR, description: `at most ${IDS_MAX}` }, filter: { ...STR, description: 'a GET /api/characters query string' } } }),
                    responses: { 200: json({ type: 'object' }), 400: err(`neither charIds nor a filter, both, charIds not character ids or more than ${IDS_MAX}, or a filter parameter the list refuses or does not take`) },
                },
            },
            '/api/playlists/{id}': {
                patch: {
                    tags: ['library'], summary: 'Update a playlist; omitted fields keep their value',
                    parameters: [pathId('id', 'playlist id')],
                    requestBody: body({ type: 'object', properties: { name: STR, description: STR, icon: STR, color: STR } }),
                    responses: { 200: json(ref('Playlist')), 400: err('a blank name or a field not a string'), 404: err('no such playlist'), 409: err('another playlist has this name (regardless of case)') },
                },
                delete: { tags: ['library'], summary: 'Delete a playlist and its memberships (the characters stay)', parameters: [pathId('id', 'playlist id')], responses: { 200: json(ref('Ok')), 404: err('no such playlist') } },
            },
            '/api/playlists/{id}/members': {
                get: {
                    tags: ['library'], summary: "A playlist's members in its order, a page at a time: walk nextCursor (after) until it is null",
                    'x-collection': asPage(1000, 10000, { key: 'ids' }),
                    parameters: [pathId('id', 'playlist id'),
                        { name: 'after', in: 'query', schema: STR, description: 'the nextCursor of the page before' },
                        { name: 'limit', in: 'query', schema: INT, description: 'ids a page: default 1000, at most 10000' }],
                    responses: {
                        200: json({ type: 'object', properties: { ids: { type: 'array', items: STR }, nextCursor: { type: 'string', nullable: true } } }),
                        400: err('a limit outside 1 to 10000, or an after that is not a cursor'), 404: err('no such playlist'),
                    },
                },
            },
            '/api/playlists/{id}/members/apply': {
                post: {
                    tags: ['library'], summary: 'Add and remove members, by ids or by filter. By add and remove (at most ' + IDS_MAX + ' ids between them a request; a larger selection goes in several requests, or by its filter), in one write: added characters join at the end in the order given; an id the library does not hold joins nothing and comes back in skipped. The answer carries the playlist with its new count, and the characters added or removed are reported changed (their rows carry their playlists). By filter and op (a GET /api/characters query string, read the list\'s way; op add or remove): the set is fixed, then a job adds or removes it in batches of a thousand characters, each landing whole; answered at once (202) with the job, whose answer {changed, playlist} (GET /api/jobs/{id}) counts the memberships that moved (the rest of its total already were members, or were not) and carries the playlist with its new count. A playlist deleted while the job runs fails it',
                    parameters: [pathId('id', 'playlist id')],
                    requestBody: body({ type: 'object', properties: { add: { type: 'array', items: STR }, remove: { type: 'array', items: STR }, filter: { ...STR, description: 'a GET /api/characters query string' }, op: { ...STR, enum: ['add', 'remove'], description: 'with filter' } } }),
                    responses: {
                        200: json({ type: 'object', properties: { added: { type: 'array', items: STR }, removed: { type: 'array', items: STR }, skipped: { type: 'array', items: STR }, playlist: ref('Playlist') } }),
                        202: json({ type: 'object', properties: { ok: { type: 'boolean' }, job: ref('SetJob') } }, 'by filter: the job'),
                        400: err('nothing to add or remove, a list that is not character ids, more than ' + IDS_MAX + ' ids between add and remove, a filter beside add or remove, an op other than add or remove, or a filter parameter the list refuses or does not take'), 404: err('no such playlist'),
                    },
                },
            },
            '/api/versions/char/{charId}': {
                get: { tags: ['library'], summary: "A character's snapshot history", parameters: [pathId('charId')], responses: { 200: json({ type: 'object', properties: {
                    name: STR,
                    snapshots: { type: 'array', items: { type: 'object', properties: { id: INT, label: { type: 'string', nullable: true }, source: { type: 'string', nullable: true }, timestamp: INT, charName: { type: 'string', nullable: true }, data: { type: 'object' } } } },
                    backup: { type: 'object', nullable: true, properties: { timestamp: INT, data: { type: 'object' } } },
                } }), 404: err('no versions for this character') } },
                delete: { tags: ['library'], summary: 'Delete all snapshots for a character', parameters: [pathId('charId')], responses: { 200: json(ref('Ok')) } },
            },
            '/api/versions/char/{charId}/snapshots': {
                post: { tags: ['library'], summary: "Add one snapshot under the next id, never one a deleted snapshot of the character held. An automatic snapshot (auto_backup, or assistant: the Chat Assistant's own before it writes a card) identical to the newest of its source is not stored again (its id answers), and past its source's cap (maxAutoBackups for auto_backup, maxAssistantBackups for assistant; 0 keeps all) that source's oldest go in the same write", parameters: [pathId('charId')], requestBody: body({ type: 'object', required: ['data'], properties: { label: STR, source: { type: 'string', description: "'local' (default), 'auto_backup', 'assistant', 'remote' or another source name" }, charName: STR, data: { type: 'object', description: "the composed card's data" } } }), responses: { 200: json({ type: 'object', properties: { id: INT } }), 400: err('no data object, or a source that is not a string'), 404: err('character not found') } },
            },
            '/api/versions/char/{charId}/snapshots/{snapId}': {
                patch: { tags: ['library'], summary: "Rename one snapshot", parameters: [pathId('charId'), pathId('snapId', 'snapshot id')], requestBody: body({ type: 'object', required: ['label'], properties: { label: STR } }), responses: { 200: json(ref('Ok')), 400: err('a snapshot id that is not a whole number, or no label'), 404: err('no such snapshot') } },
                delete: { tags: ['library'], summary: 'Delete one snapshot', parameters: [pathId('charId'), pathId('snapId', 'snapshot id')], responses: { 200: json(ref('Ok')), 400: err('a snapshot id that is not a whole number'), 404: err('no such snapshot') } },
            },
            '/api/versions/char/{charId}/backup': {
                put: { tags: ['library'], summary: 'Write the one pre-restore backup slot', parameters: [pathId('charId')], requestBody: body({ type: 'object', required: ['data'], properties: { timestamp: INT, data: { type: 'object' } } }), responses: { 200: json(ref('Ok')), 400: err('no data object'), 404: err('character not found') } },
                delete: { tags: ['library'], summary: 'Clear the backup slot', parameters: [pathId('charId')], responses: { 200: json(ref('Ok')) } },
            },
            '/api/settings': {
                get: { tags: ['library'], summary: 'All settings as one object', responses: { 200: json({ type: 'object' }) } },
                put: { tags: ['library'], summary: 'Replace all settings', requestBody: body({ type: 'object' }), responses: { 200: json(ref('Ok')), 400: err('settings body must be an object') } },
                patch: { tags: ['library'], summary: 'Upsert a subset of keys', requestBody: body({ type: 'object' }), responses: { 200: json(ref('Ok')), 400: err('settings body must be an object') } },
            },
            '/api/store/{key}': {
                get: { tags: ['library'], summary: 'Generic KV read (module state documents)', parameters: [pathId('key', 'store key')], responses: { 200: json({ type: 'object' }), 400: err('bad key: must match ^[a-z0-9][a-z0-9_-]{0,63}$'), 404: err('no such key') } },
                put: { tags: ['library'], summary: 'KV write', parameters: [pathId('key', 'store key')], requestBody: body({ type: 'object' }), responses: { 200: json(ref('Ok')), 400: err('bad key (as on the read), or no JSON body') } },
                delete: { tags: ['library'], summary: 'KV delete', parameters: [pathId('key', 'store key')], responses: { 200: json(ref('Ok')), 400: err('bad key (as on the read)') } },
            },

            '/thumbs/warm': {
                post: { tags: ['infra'], summary: 'Start a background pre-warm of the avatar thumbnail tiers the client renders (192/512), so a freshly migrated library does not pay every resize on first scroll. One run per user; 409 while one is running', responses: { 200: json({ type: 'object' }, '{ok, started}'), 409: err('already running') } },
                get: { tags: ['infra'], summary: 'Progress of the thumbnail pre-warm', responses: { 200: json({ type: 'object', properties: { running: { type: 'boolean' }, done: INT, total: INT, failed: INT } }) } },
            },
            '/thumbs/avatar/{id}': {
                get: { tags: ['infra'], summary: 'Avatar thumbnail (webp, on-demand, disk-cached; s clamps to the nearest of 96/192/384/512/768/1280/1920)', parameters: [pathId(), p('s', INT, 'target size, px')], responses: { 200: { description: 'image/webp' }, 400: err('bad id'), 404: err('avatar not found') } },
            },
            '/thumbs/media/{mediaId}': {
                get: { tags: ['infra'], summary: 'Media thumbnail (same ladder)', parameters: [pathId('mediaId', 'media row id'), p('s', INT, 'target size, px')], responses: { 200: { description: 'image/webp' }, 404: err('media or its file not found'), 415: err('thumbnails are image-only') } },
            },
            '/thumbs/attachment/{id}': {
                get: { tags: ['infra'], summary: 'A chat\'s or a studio session\'s picture as a thumbnail (same ladder)', parameters: [pathId('id', 'attachment id'), p('s', INT, 'target size, px')], responses: { 200: { description: 'image/webp' }, 404: err('attachment or its file not found'), 415: err('thumbnails are image-only') } },
            },
            '/thumbs/background/{id}': {
                get: { tags: ['infra'], summary: 'Background thumbnail (same ladder; the 1280/1920 rungs exist because a wallpaper covers the whole conversation pane, not a card)', parameters: [pathId('id', 'background row id'), p('s', INT, 'target size, px')], responses: { 200: { description: 'image/webp' }, 404: err('background or its file not found') } },
            },
            '/avatars/{id}.png': {
                get: { tags: ['infra'], summary: 'Full avatar image (pure image, no card chunks; ETag revalidation)', parameters: [pathId()], responses: { 200: { description: 'image/png' }, 400: err('bad path'), 404: err('not found') } },
            },
            '/gallery/{charId}/{file}': {
                get: { tags: ['infra'], summary: 'Media file (uid-named, immutable cache)', parameters: [pathId('charId'), pathId('file', 'physical media filename')], responses: { 200: { description: 'file' }, 400: err('bad path'), 404: err('not found') } },
            },
            '/attachments/{ownerId}/{file}': {
                get: { tags: ['infra'], summary: 'A chat\'s or a studio session\'s picture or video (uid-named, immutable cache), under its owner\'s id', parameters: [pathId('ownerId', 'the chat\'s or the studio session\'s id'), pathId('file', 'physical attachment filename')], responses: { 200: { description: 'file' }, 400: err('bad path'), 404: err('not found') } },
            },
            '/backgrounds/{file}': {
                get: { tags: ['infra'], summary: 'Background image at its original resolution (uid-named, immutable cache)', parameters: [pathId('file', 'physical background filename')], responses: { 200: { description: 'image' }, 400: err('bad path'), 404: err('not found') } },
            },
            '/docs/{file}': {
                get: { tags: ['infra'], summary: 'A public doc: the user guide (guide.html), the API reference (api-docs.html) or the extension types (extensions.d.ts, as text/plain). Open without signing in, like the app\'s own files; only an .html or .d.ts name at the top of the docs folder resolves', parameters: [pathId('file', 'a file name in the docs folder, such as guide.html or extensions.d.ts')], responses: { 200: { description: 'the file' }, 400: err('a name with a path, a dotfile, or another kind of file'), 404: err('not found') } },
            },
            '/docs/assets/screenshots/{file}': {
                get: { tags: ['infra'], summary: 'A screenshot the user guide shows (image/webp). Open without signing in, like the guide; only a lowercase name of letters, digits and hyphens ending .webp resolves', parameters: [pathId('file', 'a screenshot\'s file name, such as details-window.webp')], responses: { 200: { description: 'the image' }, 400: err('a name with a path, capitals or another kind of file'), 404: err('not found') } },
            },
            '/api/proxy/{url}': {
                description: 'Byte-verbatim CORS pass-through: body untouched, headers forwarded, accept-encoding pinned to gzip/deflate/br. The request body is passed on unparsed. GET, HEAD, POST, PUT, PATCH and DELETE are proxied; any other method is 405 with an Allow header. The upstream call is aborted when the client disconnects.',
                get: { tags: ['infra'], summary: 'Proxy a GET', parameters: [pathId('url', 'encoded absolute URL')], responses: { 200: { description: 'upstream response' }, ...PROXY_REFUSALS } },
                head: { tags: ['infra'], summary: 'Proxy a HEAD', parameters: [pathId('url', 'encoded absolute URL')], responses: { 200: { description: 'upstream headers' }, ...PROXY_REFUSALS } },
                post: { tags: ['infra'], summary: 'Proxy a POST (any content type, verbatim)', parameters: [pathId('url', 'encoded absolute URL')], responses: { 200: { description: 'upstream response' }, ...PROXY_REFUSALS } },
                put: { tags: ['infra'], summary: 'Proxy a PUT (verbatim body)', parameters: [pathId('url', 'encoded absolute URL')], responses: { 200: { description: 'upstream response' }, ...PROXY_REFUSALS } },
                patch: { tags: ['infra'], summary: 'Proxy a PATCH (verbatim body)', parameters: [pathId('url', 'encoded absolute URL')], responses: { 200: { description: 'upstream response' }, ...PROXY_REFUSALS } },
                delete: { tags: ['infra'], summary: 'Proxy a DELETE', parameters: [pathId('url', 'encoded absolute URL')], responses: { 200: { description: 'upstream response' }, ...PROXY_REFUSALS } },
            },
            '/api/provider-services/{route}': {
                description: 'Provider session + proxy namespace: '
                    + 'per-provider login handshakes, RAM sessions, GET proxies, the JanitorAI managed-browser family. '
                    + 'Each provider service registers its own routes under this namespace; they are not part of this contract. /health under this namespace reports {ok, basicAuth}.',
                get: { tags: ['infra'], summary: 'Provider services namespace (see description)', parameters: [pathId('route', 'service route')], responses: { 200: { description: 'route-specific' } } },
            },
        },
        components: {
            schemas: {
                Error: { type: 'object', required: ['error'], properties: { error: STR, kind: { ...STR, enum: ERROR_KINDS, description: 'a model\'s failure: its kind, which decides the status (bad_request 400, timeout 504, the rest 502)' } } },
                Ok: { type: 'object', properties: { ok: { type: 'boolean' } } },
                CharacterEnvelope: {
                    type: 'object',
                    properties: {
                        items: { type: 'array', items: ref('CharacterListItem') },
                        total: { ...INT, nullable: true, description: 'rows matching the filters, ignoring the window; null when count=false' },
                        limit: { ...INT, nullable: true }, offset: INT,
                        sort: STR, order: STR,
                        nextCursor: { ...STR, nullable: true, description: 'pass as after= to continue past the last item; null when the page was not full or sort=relevance' },
                    },
                },
                CharacterListItem: {
                    type: 'object',
                    description: 'Projection row: never carries heavy card text',
                    properties: {
                        id: STR, name: STR, creator: STR, nickname: STR,
                        characterVersion: STR,
                        creatorNotesExcerpt: { ...STR, description: 'only with fields=creatorNotesExcerpt: the first 200 characters of the creator notes as plain text (the grid tooltip)' },
                        creatorNotes: { ...STR, description: 'only with fields=creatorNotes' },
                        fav: { type: 'boolean' }, updateLocked: { type: 'boolean' },
                        mediaLocalized: { type: 'boolean' }, loreDismissed: { type: 'boolean' },
                        tokenEstimate: INT,
                        tags: { type: 'array', items: STR },
                        playlists: { type: 'array', items: STR, description: 'the ids of the playlists that hold it' },
                        links: { type: 'array', items: { type: 'object', properties: { providerId: STR, data: { type: 'object' } } } },
                        providers: { type: 'array', items: STR },
                        createdAt: { ...INT, nullable: true }, importedAt: INT, updatedAt: { ...INT, description: 'when the content of the card itself last changed. Its tags, its provider link, its lorebooks and the per-character flags never move it, by any route' },
                        avatarUrl: STR,
                        ext: { type: 'object', description: "present when an extension the account has on declares projection fields: { <extension id>: { <key>: value } }, a character with no value reading null" },
                    },
                },
                Character: {
                    type: 'object',
                    description: 'Full V2/V3 card ({spec, spec_version, data}) plus library fields; tags, provider links and the per-character flags are composed in',
                    properties: {
                        id: STR, card: { type: 'object' },
                        lastChatAt: { ...INT, nullable: true, description: "newest chat recency across the character's chats (epoch ms): the newest dated message, else a chat's creation; kept current by the server on every chat and message write; null when it has no chats" },
                        chatCount: { ...INT, description: 'number of chats for this character' },
                        mediaCount: { ...INT, description: 'number of gallery items for this character' },
                        playlists: { type: 'array', items: STR, description: 'the ids of the playlists that hold it' },
                    },
                    additionalProperties: true,
                },
                Chat: {
                    type: 'object',
                    properties: {
                        id: STR, charId: STR, name: STR, userName: STR,
                        characterName: { ...STR, description: "the ST header's frozen name at chat time" },
                        charName: { ...STR, description: 'the LIVE card name (a chat always has its character, and goes with it)' },
                        draft: { ...STR, nullable: true, description: 'the composer text not yet sent; never in the JSONL export' }, chatMetadata: { type: 'object', description: 'world_info is composed from the head of worlds, never stored; scenario, mes_example and system_prompt, when present, are the chat\'s own card texts' }, worlds: { type: 'array', items: STR, description: 'the chat lore list, ordered' }, createDate: { ...INT, nullable: true },
                        messageCount: INT, lastMesAt: { ...INT, nullable: true, description: 'the newest dated message, unix ms, a date without a zone read in the server\'s zone: it orders the list, so it is the same for every reader' }, personaName: { ...STR, nullable: true, description: 'the persona this chat is played as when it overrides the active one; null while it follows the active persona' }, personaPronouns: { ...PRONOUNS, nullable: true, description: 'the pronoun forms of the persona this chat overrides to, beside personaName; null while it follows the active persona' },
                        lastMes: { ...STR, nullable: true, description: 'last non-system message. Stored cut to 300 chars; the LIST projection cuts to a 200-char preview, the detail route returns messages whole' },
                        updatedAt: INT,
                        charChatCount: { ...INT, description: "the character's chat count; present only on grouped=true list answers" },
                    },
                },
                ChatSearchEnvelope: {
                    type: 'object',
                    properties: {
                        items: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    chatId: STR, charId: STR, chatName: STR,
                                    charName: { ...STR, nullable: true, description: 'live card name (null for orphan chats)' },
                                    messageId: { ...INT, description: 'the hit message\'s id' },
                                    seq: INT,
                                    isUser: { type: 'boolean' },
                                    snippet: { ...STR, description: 'hit context with <mark> highlighting' },
                                },
                            },
                        },
                        total: { ...INT, nullable: true, description: 'null when count=false' }, limit: INT, offset: INT,
                        capped: { type: 'boolean', description: 'true when the match holds more messages than the newest 10000 the hits are ranked among' },
                    },
                },
                WorldEntrySearchEnvelope: {
                    type: 'object',
                    properties: {
                        items: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    world: { ...STR, description: "the lorebook's name" },
                                    uid: { ...INT, description: "the entry's number in its book" },
                                    title: { ...STR, description: "the entry's title (its comment), empty when it has none" },
                                    titleMarked: { ...STR, description: 'the title with <mark> highlighting' },
                                    firstKey: { ...STR, nullable: true, description: "the entry's first key, a name for an entry with no title" },
                                    snippet: { ...STR, description: "content context with <mark> highlighting; the content's start when only the title matched" },
                                    enabled: { type: 'boolean' },
                                },
                            },
                        },
                        total: { ...INT, nullable: true, description: 'null when count=false' }, limit: INT, offset: INT,
                        capped: { type: 'boolean', description: `true when the match holds more entries than the newest ${ENTRY_SEARCH_RANKED} the hits are ranked among` },
                    },
                },
                ChatEnvelope: {
                    type: 'object',
                    properties: {
                        items: { type: 'array', items: ref('Chat') }, total: { ...INT, nullable: true, description: 'null when count=false' }, limit: INT, offset: INT,
                        nextCursor: { ...STR, nullable: true, description: 'pass as after= to continue past the last item; null when the page was not full' },
                    },
                },
                Attachment: {
                    type: 'object',
                    description: 'A picture or video a chat (or a studio session) holds of its own',
                    properties: {
                        id: INT, chatId: { ...STR, nullable: true }, studioId: { ...STR, nullable: true }, file: { ...STR, description: 'the uid name it is stored under' },
                        name: { ...STR, description: 'its display name' }, kind: { type: 'string', enum: ['image', 'video'] }, size: INT,
                        width: { ...INT, nullable: true }, height: { ...INT, nullable: true }, addedAt: INT, url: { ...STR, description: '/attachments/{ownerId}/{file}' },
                        uses: { ...INT, description: 'how many messages show it (the gallery\'s list only)' },
                    },
                },
                ChatMessage: {
                    type: 'object',
                    description: 'A message as every chat route answers it. The stored message is the interchange shape (the JSONL export writes it verbatim) and rides as raw; the fields beside it are read off it',
                    properties: {
                        id: { ...INT, description: 'the message\'s own id: never reused, kept through a renumber. A whole-transcript replace or an import makes new messages with new ids' },
                        seq: { ...INT, description: 'its place in the chat, 0 to n-1; every later message moves down one when an earlier one is deleted' },
                        createdAt: { ...INT, nullable: true, description: 'when it was written, unix ms: the stored send_date (a number, an ISO string, SillyTavern\'s "June 19, 2023 4:13pm" and "2023-6-19 @14h 33m 07s 123ms"), a date without a zone read on the reader\'s clock (X-Time-Zone, else X-UTC-Offset, else the server\'s zone); null when unreadable' },
                        role: { type: 'string', enum: ['user', 'assistant', 'system'], description: 'system when the message is a system note, else user when it is the reader\'s, else assistant' },
                        name: { ...STR, nullable: true, description: 'the stored speaker name' },
                        content: { ...STR, description: 'the text: the stored mes, which every write keeps equal to the active alternate' },
                        attachments: { type: 'array', items: ref('Attachment'), description: 'the pictures the message shows, in order, from its chat\'s gallery' },
                        raw: { type: 'object', description: 'the stored SillyTavern row, verbatim (mes, swipes, swipe_id, swipe_info, extra, send_date, ...), with extra.attachments naming its pictures\' ids when it shows any. A write sends row fields, never this object; a row written back with extra.attachments keeps its pictures, and a patch\'s extra.attachments sets them (null clears)' },
                    },
                },
                ChatDetail: {
                    allOf: [ref('Chat'), {
                        type: 'object',
                        properties: {
                            messages: { type: 'array', items: ref('ChatMessage'), description: 'the window\'s messages, in seq order. No header line' },
                            msgOffset: INT,
                            msgLimit: { ...INT, nullable: true },
                            msgTail: { ...INT, nullable: true },
                            embeddedLorebook: {
                                type: 'object',
                                nullable: true,
                                description: 'the card\'s own character_book, when it has entries. Not a lore source by design: a book goes live once promoted to a world and linked, so this reports that one exists and whether that has happened. null when the card has none',
                                properties: {
                                    name: { ...STR, description: 'the world name a promotion lands under: character_book.name, else "<CharName>\'s Lorebook"' },
                                    entries: INT,
                                    reachable: { type: 'boolean', description: 'a real book of that name reaches this chat (linked to the character, bound to the chat or the resolved persona, or on the global list); a placeholder of the name does not count' },
                                    placeholder: { type: 'boolean', description: 'the name is linked, but only to a placeholder (no book yet): the import fills that slot' },
                                },
                            },
                        },
                    }],
                },
                AssistantSession: {
                    type: 'object',
                    description: 'An assistant session with its transcript, which only the session\'s message routes write, a message at a time (there is no whole-transcript write). The list view omits messages and reports messageCount instead',
                    properties: {
                        id: STR,
                        chatId: STR,
                        name: STR,
                        profileId: { ...STR, nullable: true, description: 'which LLM profile answers; null follows the app default' },
                        createdAt: INT,
                        updatedAt: INT,
                        messageCount: { ...INT, description: 'list view only' },
                        messages: {
                            type: 'array',
                            description: 'detail view only. extra.context on an assistant turn is the snapshot of what the model was shown, and is what every apply is validated against',
                            items: {
                                type: 'object',
                                properties: {
                                    role: { type: 'string', enum: ['user', 'assistant'] },
                                    content: STR,
                                    at: INT,
                                    extra: { type: 'object', description: 'interrupted, reasoning, context (loreFull / loreAnchors / seqs / anchors / engines), and per-proposal applied state' },
                                },
                            },
                        },
                        damaged: { type: 'boolean', description: 'the stored transcript would not parse; reads refuse rather than reporting it empty, because an empty read invites the next append to overwrite it' },
                    },
                },
                StudioSession: {
                    type: 'object',
                    description: 'The creator studio\'s session: one conversation over ONE draft, its transcript written as an AssistantSession\'s is (by the server, a message at a time), with the draft the conversation is about stored beside the transcript so picking a session can restore the form. charId null is the drafts bucket for forms not filled from a library character; a session goes with its character, as chats do',
                    properties: {
                        id: STR,
                        charId: { ...STR, nullable: true },
                        name: STR,
                        profileId: { ...STR, nullable: true, description: 'which LLM profile answers; null follows the surface default' },
                        createdAt: INT,
                        updatedAt: INT,
                        messageCount: { ...INT, description: 'list view only' },
                        draft: { type: 'object', description: 'detail view only: the draft as the last generate or apply saw it, or as the panel PATCHed it on close' },
                        messages: {
                            type: 'array',
                            description: 'detail view only. extra.context on an assistant turn is the snapshot of the draft the model was shown (anchors per field, tags, greetings; the scope), and is what every judge and apply reads',
                            items: { type: 'object', properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: STR, at: INT, extra: { type: 'object' } } },
                        },
                        damaged: { type: 'boolean', description: 'the stored transcript would not parse; reads refuse rather than reporting it empty' },
                    },
                },
                ChatLoreState: {
                    type: 'object',
                    properties: {
                        chatId: STR,
                        charId: STR,
                        persona: {
                            type: 'object', nullable: true,
                            description: "whose books the 'persona' source means: the persona resolved for THIS chat (its override, else the global active one); null when none",
                            properties: { id: STR, name: STR },
                        },
                        settings: {
                            type: 'object',
                            description: 'the scan settings in force, so the panel can explain a miss instead of just showing one',
                            properties: { defaultScanDepth: { ...INT, nullable: true }, caseSensitive: { type: 'boolean' }, matchWholeWords: { type: 'boolean' } },
                        },
                        scannedMessages: { ...INT, description: 'how many messages the scan window actually covered' },
                        notes: { type: 'array', items: STR, description: 'anything matched that is not sent, and why: eg. an entry at the author\'s note while the note is not due, an outlet nothing writes' },
                        worlds: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    name: STR,
                                    sources: { type: 'array', items: STR, description: "any of 'character', 'chat', 'persona', 'global'; a book reachable several ways appears once carrying all of them" },
                                    placeholder: { type: 'boolean', description: 'a name linked here with no book yet (no entries until one is imported or written)' },
                                    entries: { type: 'array', items: ref('ChatLoreEntry') },
                                },
                            },
                        },
                        extensionBooks: {
                            type: 'array',
                            description: 'the books an extension added to this scan through lore.candidates, in the prompt like the chat\'s own: the panel lists them read-only. Each is named ext:<extension id>:<label>, which the runner holds to the extension that added it',
                            items: {
                                type: 'object',
                                properties: {
                                    name: STR,
                                    extension: { ...STR, description: 'the id of the extension that added it' },
                                    label: { ...STR, description: 'the book\'s name after the extension\'s prefix' },
                                    entries: { type: 'array', items: ref('ChatLoreEntry') },
                                },
                            },
                        },
                    },
                },
                ChatLoreEntry: {
                    type: 'object',
                    properties: {
                        uid: { description: "the entry's key in its book: a whole number in the library's books; an extension's book may use text" }, comment: STR, keys: { type: 'array', items: STR },
                        secondaryKeys: { type: 'array', items: STR },
                        content: STR, disable: { type: 'boolean' }, constant: { type: 'boolean' },
                        position: INT, order: INT, depth: { ...INT, nullable: true },
                        selective: { type: 'boolean' }, selectiveLogic: INT, role: INT,
                        scanDepth: { ...INT, nullable: true, description: 'the entry\'s own scan depth; null inherits the global' },
                        caseSensitive: { type: 'boolean', nullable: true, description: 'null inherits the global' },
                        matchWholeWords: { type: 'boolean', nullable: true, description: 'null inherits the global' },
                        fired: { type: 'boolean', description: 'true when this entry is IN THE PROMPT as of the current history: it both matched the scan AND the preset this chat uses (its own, else the active one) has the marker block that places its group (worldInfoBefore / worldInfoAfter / chatHistory for at-depth; for an outlet entry, the prompt writes {{outlet::name}}, which a dry build of the prompt answers). A match with no slot to render into reports false and is explained in notes' },
                        firedVia: { type: 'object', nullable: true, description: "why it fired: { kind: 'chat', messageSeq }, { kind: 'recursion', feederWorld, feederUid, feederComment }, { kind: 'source', source }, or constant / sticky / decorator" },
                        probabilityPending: { ...INT, nullable: true, description: 'a fired entry that still rolls its probability at send, in percent' },
                        groupPending: { type: 'number', nullable: true, description: 'a fired member of a weighted inclusion group: the dry run names no winner, so each member that can win is kept with its odds of winning at send, in percent (one decimal)' },
                        timed: { type: 'object', description: 'the turns left of an active sticky and cooldown, each null when not running', properties: { sticky: { ...INT, nullable: true }, cooldown: { ...INT, nullable: true } } },
                        suppressedReason: { ...STR, nullable: true, description: "why a matching entry was held back, eg. 'trigger', 'probability', 'characterFilter', 'cooldown', 'budget' (every matched entry the lore budget left out says budget)" },
                        advanced: { type: 'object', description: "the engine fields under ST's own names (probability, sticky, cooldown, delay, the group cluster, the recursion flags, ignoreBudget, outletName, triggers, characterFilter, and matchFlags: the six match-source booleans). The bundled panel edits these, so values are raw config, never display labels" },
                        outlet: { ...STR, nullable: true, description: 'for a fired entry placed at an outlet: the outlet name, which the prompt writes as {{outlet::name}}' },
                        notHonoured: { type: 'object', description: 'stored and preserved but not acted on: vectorized, automationId' },
                    },
                },
                WorldSummary: { type: 'object', properties: { name: STR, entryCount: INT, importedAt: { ...INT, nullable: true }, createdAt: { ...INT, description: 'ms epoch of the first write (an import, a manager create or a placeholder mint); never moves after' }, updatedAt: INT, placeholder: { type: 'boolean', description: 'minted by an import path for a name with no book yet; filled in place when one arrives' }, source: { ...ref('WorldSource'), nullable: true } } },
                WorldSource: { type: 'object', description: 'where a book came from: one source per book, following a rename and going with a delete; null for an authored book', properties: { provider: STR, externalId: { ...STR, description: 'the provider id or lowercased path the listing keys on' }, path: { ...STR, nullable: true }, url: { ...STR, nullable: true }, linkedAt: { ...INT, description: 'ms epoch of the link' } } },
                PresetBlock: {
                type: 'object',
                description: 'One piece of the prompt. kind=text carries its own content; kind=marker names something the engine expands from the character, chat, persona or lore. Each block goes as its own message, save at_depth blocks sharing a depth, injectionOrder and role, which go as one with any lore or note placed there; PresetSettings.joinSystem joins system neighbours',
                properties: {
                    id: STR, key: STR,
                    name: { ...STR, nullable: true, description: 'the label the block is listed under, stored trimmed and null when empty; an import brings the SillyTavern prompt\'s name and an export writes it back' },
                    kind: { type: 'string', enum: ['text', 'marker'] },
                    marker: { type: 'string', nullable: true, enum: ['charDescription', 'charPersonality', 'scenario', 'personaDescription', 'worldInfoBefore', 'worldInfoAfter', 'dialogueExamples', 'chatHistory', 'characterPicture', null], description: 'what a marker block is filled with; characterPicture shows the model the character\'s portrait in a user turn, before or after the history, never at a depth' },
                    content: STR,
                    role: { type: 'string', enum: ['system', 'user', 'assistant'] },
                    position: {
                        type: 'string',
                        enum: ['pre_history', 'post_history', 'at_depth'],
                        description: "at_depth anchors the block INSIDE the chat history, `depth` turns back from the newest, which is SillyTavern's absolute injection position",
                    },
                    depth: { ...INT, description: 'turns back from the newest message, at_depth only. 0 sits after the last turn' },
                    injectionOrder: { ...INT, description: 'at_depth only: of several blocks at one depth, a higher order sits nearer the reply. Default 100' },
                    forbidOverrides: { type: 'boolean', description: "main and jailbreak only: the card's system_prompt / post_history_instructions normally replaces the block, and this refuses that" },
                    triggers: {
                        type: 'array',
                        items: { type: 'string', maxLength: 32 },
                        description: "the generation types the block is sent on, SillyTavern's injection_trigger: normal (a sent turn), continue, impersonate, swipe, regenerate, quiet. Empty or absent: every type. A type the app does not make (quiet, or one it does not know) is kept, so the block is never sent for it",
                    },
                    enabled: { type: 'boolean' }, pos: INT,
                },
            },
            Preset: {
                type: 'object',
                description: 'An ordered block list: PROMPT STRUCTURE only. Neither connection nor samplers are here, both belong to the LLM profile, which is what keeps a preset portable across endpoints and stops opening one from retuning an endpoint',
                properties: {
                    id: STR, name: STR,
                    source: { type: 'string', nullable: true, description: "'sillytavern' for imports" },
                    settings: { ...ref('PresetSettings'), description: 'the settings this preset sets; one absent reads its default (defaultSettings)' },
                    createdAt: INT, updatedAt: INT,
                    blocks: { type: 'array', items: ref('PresetBlock') },
                },
            },
            PresetRow: {
                type: 'object',
                description: 'A preset as the list answers it: its name and how many blocks it holds, never the blocks',
                properties: {
                    id: STR, name: STR,
                    source: { type: 'string', nullable: true, description: "'sillytavern' for imports" },
                    createdAt: INT, updatedAt: INT,
                    blockCount: { ...INT, description: 'how many blocks the preset holds' },
                },
            },
            PresetSettings: {
                type: 'object',
                description: 'How a preset builds its prompt around its blocks. Every prompt is built one way: each block its own message, the persona as written, the card\'s examples as system turns that keep each speaker\'s name in their text, an empty block sending nothing; these settings are what a preset changes within that. A write naming a setting not listed here, a value of another type or a text past 20000 characters is refused 400 by name, never dropped; null puts a setting back to its default',
                properties: {
                    personalityFormat: { ...STR, description: 'sent for the personality, which goes where {{personality}} is; empty sends the personality as it is' },
                    scenarioFormat: { ...STR, description: 'sent for the scenario, which goes where {{scenario}} is; empty sends it as it is' },
                    loreFormat: { ...STR, description: 'sent for each lore group placed before or after the character, its entries where {{lore}} is; empty sends them as they are' },
                    chatStart: { ...STR, description: 'a system message right before the history; empty sends none' },
                    exampleSeparator: { ...STR, description: 'a system message before each example block; empty sends none' },
                    joinSystem: { type: 'boolean', description: 'adjacent system messages join on a newline, save the chat start line, the example separators and the example turns; an empty text block, or a card or lore marker with nothing to place, in another role ends the run where it stands when it is on for the generation type (Main even when off) and not at a depth' },
                    impersonateInstruction: { ...STR, description: 'the last message of a Write My Next Message; empty sends none' },
                    continueInstruction: { ...STR, description: 'the last message of a continue; empty sends none' },
                    guidedInstruction: { ...STR, description: 'the last message of a directed reply; empty sends none' },
                    continueJoiner: { ...STR, description: 'joins a continuation onto the message it continues, unless that ends on a space' },
                    continueAsOpening: { type: 'boolean', description: 'a continue ends the prompt on the message as the reply\'s opening, with no instruction after it; a continue with no message to open on (its target is not in the prompt) is sent the continue instruction' },
                },
            },
            PresetImportReport: {
                type: 'object',
                description: 'What the importer did NOT carry over, so a preset never silently changes meaning',
                properties: {
                    droppedConnection: { type: 'array', items: STR, description: 'connection keys, dropped on purpose' },
                    droppedSamplers: { type: 'array', items: STR, description: 'sampler settings, dropped on purpose: they belong to the connection' },
                    droppedUnknown: { type: 'array', items: STR, description: 'keys with no equivalent here' },
                    unknownBlocks: { type: 'array', items: STR, description: 'prompt identifiers with no expressible equivalent' },
                    regexScripts: { type: 'object', properties: { count: { type: 'integer' }, enabled: { type: 'integer' } }, description: 'the regex scripts the preset carries, stored as its own and off until the reader allows them' },
                    notes: { type: 'array', items: STR },
                },
            },
            RegexScript: {
                type: 'object',
                description: 'A regex script in SillyTavern\'s file format. Fields it does not name are kept as sent',
                properties: {
                    id: STR,
                    scriptName: STR,
                    findRegex: { ...STR, description: 'a pattern written /pattern/flags, or bare' },
                    replaceString: { ...STR, description: '{{match}} is the whole match, $1 a numbered group, $<name> a named one; macros expand after' },
                    trimStrings: { type: 'array', items: STR, description: 'cut from every group before it fills the replacement' },
                    placement: { type: 'array', items: { type: 'integer' }, description: '1 the reader\'s messages, 2 the character\'s, 3 narrator rows, 5 lore, 6 reasoning' },
                    disabled: { type: 'boolean' },
                    markdownOnly: { type: 'boolean', description: 'changes only what the screen shows' },
                    promptOnly: { type: 'boolean', description: 'changes only what the model is sent' },
                    runOnEdit: { type: 'boolean', description: 'for a script changing the text itself: it still applies to a message edited by hand (extra.edited), and with alterSaved it rewrites the edit as it is saved' },
                    substituteRegex: { type: 'integer', enum: [0, 1, 2], description: 'macros in the find: 0 none, 1 expanded, 2 expanded with each value escaped' },
                    minDepth: { type: 'integer', nullable: true },
                    maxDepth: { type: 'integer', nullable: true },
                    alterSaved: { type: 'boolean', description: 'for a script changing the text itself: rewrite the message when it is written instead of each time it is read' },
                    stopped: { type: 'boolean', description: 'answers only: skipped since it ran out of time, until it is saved again' },
                },
            },
            Playlist: {
                type: 'object',
                description: 'A named, ordered group of characters by uuid, with how many it holds; the entry shape of the playlists document plus its id',
                properties: {
                    id: STR, name: STR, description: STR, icon: STR, color: STR,
                    created: { type: 'integer', nullable: true }, modified: { type: 'integer', nullable: true },
                    count: { type: 'integer', description: 'how many characters it holds' },
                },
            },
            ExtensionRow: {
                type: 'object',
                description: "One installed extension as the asking account sees it: the server's reading of its manifest, whether it runs for this account, and its server half's state. error replaces the manifest fields on a broken install",
                properties: {
                    id: STR, name: STR, version: { type: 'string', nullable: true }, author: { type: 'string', nullable: true },
                    description: { type: 'string', nullable: true }, requires: { type: 'object', nullable: true },
                    client: { type: 'string', nullable: true }, style: { type: 'string', nullable: true }, server: { type: 'string', nullable: true },
                    provider: { type: 'boolean' }, extNamespace: { type: 'string', nullable: true },
                    bundled: { type: 'boolean', description: 'ships with the app and cannot be removed' },
                    defaultOff: { type: 'boolean', description: 'a bundled extension that is off until an account switches it on' },
                    git: { type: 'boolean', description: 'a git install, which update can pull' },
                    settings: { type: 'object', description: 'the manifest-declared setting defaults' },
                    contributes: { type: 'array', items: STR, nullable: true },
                    lazy: { type: 'object', nullable: true, description: "the entry points a lazy extension declares ({ actions: [{ slot, id, label, icon }], windows: [{ id, label, icon, size?, min? }], views: [{ id, label, icon }] }): the page registers these and imports the code at their first use. A declaration outside the grammar the page's registrars hold, one not named in a declared contributes, or a lazy block with no entry point or no client makes the row broken" },
                    enabled: { type: 'boolean', description: 'whether it runs for this account' },
                    error: STR,
                    serverState: { type: 'string', enum: ['loaded', 'failed', 'restart', 'removed'], description: 'present when it has a server half' },
                    serverError: STR,
                    serverHooks: { type: 'array', items: { type: 'object', properties: { kind: STR, id: STR } }, description: 'what the server half registered: its store guards, pipeline filters, macros, prompt blocks, job schedules and change listener, each group in the order the half registered it' },
                    browserConsumers: { type: 'array', items: { type: 'object', properties: { id: STR, name: STR, origin: STR, fetchPrefix: STR, warmPath: STR } }, description: 'the hosted-browser consumers the server half registered, each id <extension>:<name>, served by /api/provider-services/browser/* only for accounts that switched the extension on' },
                    serverQuery: {
                        type: 'object',
                        description: 'the query doors the server half declared over its own tables',
                        properties: {
                            projections: { type: 'array', items: STR, description: 'keys the list rows carry under ext.<id>, for accounts that have it on' },
                            ruleFields: { type: 'array', items: { type: 'object', properties: { key: STR, field: STR, label: STR, type: { type: 'string', enum: ['number', 'text', 'boolean', 'date'] }, ops: { type: 'array', items: STR } } }, description: 'advanced-filter fields (field is the rules name, ext.<id>.<key>)' },
                            sortKeys: { type: 'array', items: { type: 'object', properties: { key: STR, sort: STR, label: STR } }, description: 'list sorts (sort is the sort value, ext.<id>.<key>)' },
                        },
                    },
                    serverCalls: { type: 'array', items: { type: 'object', properties: { name: STR, count: INT, errors: INT, refused: INT, lastError: STR, totalMs: { type: 'number' }, p50: { type: 'number' }, p95: { type: 'number' } } }, description: "what the server half's hooks, model calls (llm.chat, llm.stream) and jobs (jobs.run) cost this account since the server started, costliest first" },
                },
            },
            ExtensionJob: {
                type: 'object',
                description: "One extension job of the asking account. status: queued (position is its place in its extension's lane, 1 next), running, then done, failed (error says why), or cancelled",
                properties: {
                    id: INT, extension: STR, extensionName: { ...STR, description: 'its manifest name, for display' }, key: { type: 'string', nullable: true }, label: STR,
                    status: { type: 'string', enum: ['queued', 'running', 'done', 'failed', 'cancelled'] },
                    progress: { type: 'object', nullable: true, properties: { done: { type: 'number', nullable: true }, total: { type: 'number', nullable: true }, note: { type: 'string', nullable: true } } },
                    queuedAt: INT, startedAt: { type: 'integer', nullable: true }, endedAt: { type: 'integer', nullable: true },
                    error: { type: 'string', nullable: true }, position: INT,
                },
            },
            Persona: {
                type: 'object',
                description: 'The user side of a chat: uuid identity, never keyed by display name. The active persona supplies {{user}}, {{persona}} and the pronoun macros during prompt assembly',
                properties: {
                    id: STR, name: STR, description: STR,
                    avatar: { type: 'string', nullable: true },
                    pronouns: PRONOUNS,
                    createdAt: INT, updatedAt: INT,
                },
            },
            LlmProfile: {
                    type: 'object',
                    properties: {
                        id: STR, name: STR, kind: { ...STR, description: 'a registered adapter kind (see /api/llm/kinds)' },
                        baseUrl: STR, model: STR, hasKey: { type: 'boolean' },
                        keyHint: { ...STR, nullable: true, description: 'the last four characters of the stored key when it is twelve or longer, so two keys can be told apart on screen; null otherwise' },
                        contextSize: { type: 'integer', nullable: true, description: 'token window this connection declares; overrides the global chat budget, null uses it' }, vision: { type: 'boolean', nullable: true, description: 'whether the model sees pictures: true, false, or null when not checked; a call carrying pictures to a connection set false is refused' }, maxImages: { type: 'integer', nullable: true, description: 'the most pictures the host takes in one request; a chat prompt over it sends the oldest as text, null is no limit' },
                        params: { type: 'object', description: 'neutral default generation params; request params override per call' },
                        pos: INT,
                    },
                },
                SetJob: { description: 'A set job: a write over a set of characters, fixed when the job starts and written in batches, each landing whole', type: 'object', properties: { id: INT, kind: { ...STR, enum: ['apply', 'undo', 'delete', 'favorite', 'flags', 'playlist'] }, label: STR, status: { ...STR, enum: ['queued', 'running', 'done', 'stopped', 'failed'] }, done: INT, total: INT, queuedAt: INT, startedAt: { ...INT, nullable: true }, endedAt: { ...INT, nullable: true }, error: { ...STR, nullable: true, description: 'a failed job\'s words (an extension\'s store guard refusing a batch); the batches before it landed' }, result: { type: 'object', nullable: true, description: 'once the job ends, per kind: an apply {changed, added: [{name, count}], removed: [{name, count}], runId}; an undo {changed, restored, removed, presets, renamed, runId} (presets: the saved filter preset rules put back; renamed: [{from, to}] the tag names it reported moving, to null for a name that went, which the asking client\'s own filters follow); a delete {changed, missing} (characters deleted, and characters of the set gone before their batch); a favorite {changed} (characters whose favourite moved; the rest already were); a flags {changed} (characters whose flags moved); a playlist {changed, playlist} (memberships added or removed, and the playlist with its new count)' } } },
                BackupJob: { description: 'A library backup: queued behind any other account\'s, then running (the copy, then its integrity check), then done, failed or cancelled', type: 'object', properties: { id: INT, status: { ...STR, enum: ['queued', 'running', 'done', 'failed', 'cancelled'] }, phase: { ...STR, nullable: true, enum: ['copy', 'verify', null], description: 'while running: copy, then verify (the integrity check of the copy)' }, done: { ...INT, nullable: true, description: 'while copying: bytes of the copy written so far' }, total: { ...INT, nullable: true, description: 'about what the copy writes: the library\'s pages in use when the copy began' }, stopping: { type: 'boolean', description: 'a cancel was asked and the copy is being stopped' }, scheduled: { type: 'boolean' }, queuedAt: INT, startedAt: { ...INT, nullable: true }, endedAt: { ...INT, nullable: true }, error: { ...STR, nullable: true }, file: { ...STR, nullable: true, description: 'once done: the backup file' }, bytes: { ...INT, nullable: true, description: 'once done: its size' } } },
                BackupMissed: { description: 'A backup window that opened once a scheduled backup was due and ended without it (the server was not running, or the backup failed or was cancelled), not yet answered', type: 'object', properties: { windowEnd: { type: 'number', description: 'the end of the window it missed' } } },
                Media: {
                    type: 'object',
                    properties: {
                        id: INT, file: { ...STR, description: 'physical uid-named file' }, displayName: STR,
                        kind: STR, sourceUrl: { ...STR, nullable: true }, size: INT, addedAt: INT, url: STR,
                    },
                },
                Background: {
                    type: 'object',
                    properties: {
                        id: INT, file: { ...STR, description: 'physical uid-named file' }, displayName: STR,
                        sourceUrl: { ...STR, nullable: true },
                        width: { ...INT, nullable: true, description: 'source pixels; the picker quotes the memory cost from these' },
                        height: { ...INT, nullable: true },
                        size: INT, addedAt: INT,
                        url: { ...STR, description: 'the original, immutably cached' },
                        thumb: { ...STR, description: '192px picker tile' },
                        usedBy: { ...INT, description: 'bindings pointing here (list endpoint only)' },
                    },
                },
                BackgroundBinding: {
                    type: 'object',
                    properties: {
                        scope: { ...STR, enum: ['global', 'character', 'chat'] },
                        id: { ...STR, nullable: true, description: 'character or chat uuid; null for global' },
                        background: { ...ref('Background'), nullable: true, description: 'null means explicitly none, which STOPS inheritance' },
                        fit: { ...STR, enum: ['cover', 'contain', 'stretch', 'center', 'tile'] },
                        opacity: { type: 'number' }, blur: INT,
                        brightness: { type: 'number' }, saturate: { type: 'number' },
                        renderWidth: { ...INT, nullable: true, description: 'null is auto, 0 is the original' },
                        updatedAt: INT,
                    },
                },
                ResolvedBackground: {
                    type: 'object',
                    properties: {
                        source: { ...STR, enum: ['chat', 'character', 'global', 'none'], description: 'which scope answered' },
                        binding: { ...ref('BackgroundBinding'), nullable: true },
                    },
                },
            },
        },
    };
    return spec;
}
