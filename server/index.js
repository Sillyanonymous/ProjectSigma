import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config, ensureServerScaffold } from './config.js';
import { openDb } from './db/database.js';
import { openServerDb, createUser, countUsers } from './db/server-store.js';
import { attachUser, requireUser, requireAdmin, requirePasswordChanged } from './auth.js';
import { hostGuard, originGuard } from './lib/request-guard.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { migrateRouter } from './routes/migrate.js';
import { charactersRouter } from './routes/characters.js';
import { worldsRouter, worldCarriersRouter, worldEntriesRouter } from './routes/worlds.js';
import { settingsRouter } from './routes/settings.js';
import { thumbsRouter } from './routes/thumbs.js';
import { storeRouter } from './routes/store.js';
import { characterMediaRouter, mediaRouter } from './routes/media.js';
import { backgroundsRouter } from './routes/backgrounds.js';
import { proxyRouter } from './routes/proxy.js';
import { playlistsRouter } from './routes/playlists.js';
import { versionsRouter } from './routes/versions.js';
import { chatsRouter, characterChatsRouter } from './routes/chats.js';
import { chatAttachmentsRouter, studioAttachmentsRouter, attachmentsRouter } from './routes/attachments.js';
import { assistantRouter } from './routes/assistant.js';
import { creatorRouter } from './routes/creator.js';
import { personasRouter } from './routes/personas.js';
import { presetsRouter } from './routes/presets.js';
import { bundleRouter, sweepStalePacks } from './routes/bundle.js';
import { tagsRouter } from './routes/tags.js';
import { charWorldsRouter, characterWorldsRouter } from './routes/char-worlds.js';
import { globalWorldsRouter, personaWorldsRouter } from './routes/world-links.js';
import { providerLinksRouter } from './routes/provider-links.js';
import { backupRouter } from './routes/backup.js';
import { tagRunsRouter } from './routes/tag-runs.js';
import { jobsRouter } from './routes/jobs.js';
import { mediaJobsRouter } from './routes/media-jobs.js';
import { startBackupScheduler } from './lib/backup-scheduler.js';
import { startStageSweeper } from './importer/card-file.js';
import { sweepAllGreetings } from './lib/greeting-sweep.js';
import { LlmError, httpStatusFor } from './llm/errors.js';
import { startJobSchedules } from './lib/ext-jobs.js';
import { llmRouter } from './routes/llm.js';
import { buildOpenApiSpec, API_VERSION } from './openapi.js';
import { init as initProviderServices } from './services/provider-services.js';
import { extensionsRouter } from './routes/extensions.js';
import { listExtensions, resolveServedFile } from './lib/extensions.js';
import { mountServerExtensions } from './lib/extensions-server.js';
import { registerProviderNamespace } from './lib/provider-namespaces.js';
import { promoteKnownNamespaces } from './db/characters-store.js';
import { runWithRequest } from './db/changes.js';
import { kindForFile } from './db/media-store.js';
import { isUuid, UUID_SOURCE } from './lib/uuid.js';
import { readerOf, runWithReader } from './lib/reader-context.js';
import { attachFeed, clientIdOf } from './lib/feed.js';

const pkg = JSON.parse(fs.readFileSync(path.join(config.projectRoot, 'package.json'), 'utf8'));

// a character's or persona's picture is named for its owner's uuid and nothing else
const UUID_PNG_RE = new RegExp(`^${UUID_SOURCE}\\.png$`, 'i');

export async function createApp() {
    ensureServerScaffold();
    openServerDb();
    if (config.multiUser && countUsers(openServerDb()) === 0) {
        const password = crypto.randomBytes(9).toString('base64url');
        // must be 'default': single-user data lives in data/default, any other handle strands that library
        createUser(openServerDb(), { handle: 'default', displayName: 'Default', password, admin: true, mustChangePassword: true });
        console.log(`[boot] multi-user is on with no accounts. Created admin user 'default' with password: ${password}`);
        console.log("[boot] this password is shown once; a change is forced on first login. 'default' owns the existing single-user library.");
    }
    if (!config.multiUser) openDb('default');

    const app = express();

    // one hop (the TLS proxy) so X-Forwarded-Proto sets req.secure, without trusting a client's own chain
    app.set('trust proxy', 1);

    // baseline headers on every route, static included. no page CSP: inline boot scripts would need unsafe-inline
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
        next();
    });

    // with accounts off these two are all that stand between another site's page and the API
    app.use(hostGuard);
    app.use('/api', originGuard);

    // detached frontends: CL_CORS unset is same-origin only; cookies are SameSite=Strict so they need multiUser off
    if (config.corsOrigins.length) {
        const allowAll = config.corsOrigins.includes('*');
        app.use((req, res, next) => {
            const origin = req.headers.origin;
            if (origin && (allowAll || config.corsOrigins.includes(origin))) {
                res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin);
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CL-Client, X-UTC-Offset, X-Time-Zone');
                // the answer headers a client reads: what a bundle export left out
                res.setHeader('Access-Control-Expose-Headers', 'X-Bundle-Count, X-Bundle-Skipped, X-Bundle-Skipped-Count');
                if (!allowAll) res.setHeader('Vary', 'Origin');
            }
            if (req.method === 'OPTIONS') return res.sendStatus(204);
            next();
        });
    }

    // every request resolves its user (or 'default' when multi-user is off) before
    // any route runs; routes read req.db / req.paths and never touch globals
    app.use(attachUser);
    // the asking tab rides its change records so it can skip its own echo; ext routes carry none
    app.use((req, res, next) => runWithRequest({
        clientId: req.path.startsWith('/api/ext/') ? null : clientIdOf(req.headers['x-cl-client']),
    }, next));
    // whose clock and device the macros answer for ({{time}}, {{isMobile}})
    app.use((req, res, next) => runWithReader(readerOf(req), next));
    app.use('/api/auth', express.json(), authRouter);

    // before the json parser: proxied bodies must pass through byte-exact
    app.use('/api/proxy', requireUser, requirePasswordChanged, proxyRouter);
    app.use(express.json({ limit: '50mb' }));

    app.get('/api/health', (req, res) => res.json({
        ok: true,
        name: 'project-sigma',
        version: pkg.version,
        apiVersion: API_VERSION,
        multiUser: config.multiUser,
        spec: '/api/openapi.json',
    }));
    const spec = buildOpenApiSpec(pkg.version);
    app.get('/api/openapi.json', (req, res) => res.json(spec));

    // everything below is closed until a forced password change lands; /api/auth sits above
    app.use('/api', requirePasswordChanged);
    app.use('/api/admin', requireAdmin, adminRouter);
    // the gate: every /api surface registered below this line requires a user
    app.use('/api', requireUser);

    // the SillyTavern migration wizard: any signed-in user, into their own library only
    app.use('/api/migrate', migrateRouter);

    app.use('/api/characters', charactersRouter);
    app.use('/api/worlds', worldsRouter);
    app.use('/api/world-carriers', worldCarriersRouter);
    app.use('/api/world-entries', worldEntriesRouter);
    app.use('/api/settings', settingsRouter);
    app.use('/api/store', storeRouter);
    app.use('/api/playlists', playlistsRouter);
    app.use('/api/versions', versionsRouter);
    app.use('/api/extensions', extensionsRouter);
    // the change feed answers on the server's upgrade event (attachFeed); a plain GET says so
    app.get('/api/feed', (req, res) => res.status(426).json({ error: 'the change feed is a WebSocket: connect with an upgrade' }));

    // provider services: sessions,
    // per-provider proxies, the janitorai managed-browser family
    const servicesRouter = express.Router();
    await initProviderServices(servicesRouter);
    app.use('/api/provider-services', servicesRouter);
    app.use('/api/characters/:id/media', characterMediaRouter);
    app.use('/api/characters/:id/chats', characterChatsRouter);
    app.use('/api/characters/:id/worlds', characterWorldsRouter);
    app.use('/api/char-worlds', charWorldsRouter);
    app.use('/api/global-worlds', globalWorldsRouter);
    app.use('/api/personas/:id/worlds', personaWorldsRouter);
    app.use('/api/provider-links', providerLinksRouter);
    app.use('/api/backup', backupRouter);
    app.use('/api/llm', llmRouter);
    app.use('/api/media', mediaRouter);
    app.use('/api/chats/:id/attachments', chatAttachmentsRouter);
    app.use('/api/creator/sessions/:id/attachments', studioAttachmentsRouter);
    app.use('/api/attachments', attachmentsRouter);
    app.use('/api/backgrounds', backgroundsRouter);
    app.use('/api/chats', chatsRouter);
    app.use('/api/assistant', assistantRouter);
    app.use('/api/creator', creatorRouter);
    app.use('/api/personas', personasRouter);
    app.use('/api/presets', presetsRouter);
    app.use('/api/bundle', bundleRouter);
    app.use('/api/tags', tagsRouter);
    app.use('/api/tag-runs', tagRunsRouter);
    app.use('/api/jobs', jobsRouter);
    app.use('/api/media-jobs', mediaJobsRouter);

    // extension server halves mount under /api/ext/<id>, behind the same requireUser
    // gate as everything above; a failing half disables itself loudly, never the boot
    if (config.extensionsEnabled) {
        const extApiRouter = express.Router();
        await mountServerExtensions(extApiRouter);
        app.use('/api/ext', extApiRouter);
        // provider extensions' namespaces join the provider_links divert list, so their
        // link blobs become rows exactly like first-party ones
        for (const row of listExtensions()) {
            if (row.provider && row.extNamespace && !row.error) registerProviderNamespace(row.extNamespace);
        }
        // single-user opened its db before this mount; a namespace registering for the
        // first time this boot still gets its blob-to-row promotion sweep
        if (!config.multiUser) promoteKnownNamespaces(openDb('default'));
    }

    // unknown /api paths answer JSON, never the static handler's HTML
    app.use('/api', (req, res) => {
        res.status(404).json({ error: `no such endpoint: ${req.method} ${req.originalUrl}` });
    });

    // browsers probe this on every load; 204 keeps the console clean
    app.get('/favicon.ico', (req, res) => res.status(204).end());

    // user-scoped files behind the API's gates. gallery files are never rewritten so they cache forever,
    // avatars are rewritten in place so they revalidate
    const fileGate = [requireUser, requirePasswordChanged];
    // express 5 sendFile wants root + relative (absolute Windows paths fail its resolver)
    const sendUserFile = (res, rel, root, opts = {}) => res.sendFile(rel, { root, ...opts }, (err) => {
        if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
    });
    app.use('/thumbs', originGuard, ...fileGate, thumbsRouter);
    app.get('/gallery/:charId/:file', ...fileGate, (req, res) => {
        const { charId, file } = req.params;
        if (!isUuid(charId) || file !== path.basename(file) || file.startsWith('.')) {
            return res.status(400).json({ error: 'bad path' });
        }
        // never live content on this origin; a non-media file (html, svg) downloads instead
        const headers = { 'Content-Security-Policy': 'sandbox', ...(kindForFile(file) === 'file' ? { 'Content-Disposition': 'attachment' } : {}) };
        sendUserFile(res, `${charId}/${file}`, req.paths.galleryRoot, { immutable: true, maxAge: '365d', headers });
    });
    // a chat's or a studio session's pictures: uid-named, never rewritten, under the owner's own folder
    app.get('/attachments/:ownerId/:file', ...fileGate, (req, res) => {
        const { ownerId, file } = req.params;
        if (!isUuid(ownerId) || file !== path.basename(file) || file.startsWith('.')) {
            return res.status(400).json({ error: 'bad path' });
        }
        sendUserFile(res, `${ownerId}/${file}`, req.paths.attachmentsRoot, { immutable: true, maxAge: '365d', headers: { 'Content-Security-Policy': 'sandbox' } });
    });
    // backgrounds are uid-named and never rewritten, same immutable deal as the gallery
    app.get('/backgrounds/:file', ...fileGate, (req, res) => {
        const { file } = req.params;
        if (file !== path.basename(file) || file.startsWith('.')) {
            return res.status(400).json({ error: 'bad path' });
        }
        sendUserFile(res, file, req.paths.backgroundsDir, { immutable: true, maxAge: '365d' });
    });
    // Rewritten in place like character avatars, so ETag revalidation rather than the
    // immutable cache the uid-named gallery and background files get.
    app.get('/persona-avatars/:file', ...fileGate, (req, res) => {
        if (!UUID_PNG_RE.test(req.params.file)) return res.status(400).json({ error: 'bad path' });
        sendUserFile(res, req.params.file, req.paths.personaAvatarsDir);
    });
    app.get('/avatars/:file', ...fileGate, (req, res) => {
        if (!UUID_PNG_RE.test(req.params.file)) return res.status(400).json({ error: 'bad path' });
        sendUserFile(res, req.params.file, req.paths.avatarsDir);
    });

    // the public docs (the user guide, the API reference, the extension types): open like the app's own files, top level only
    const docsDir = path.join(config.projectRoot, 'docs');
    app.get('/docs/:file', (req, res) => {
        const { file } = req.params;
        if (file !== path.basename(file) || file.startsWith('.') || !/\.(?:html|d\.ts)$/i.test(file)) {
            return res.status(400).json({ error: 'bad path' });
        }
        // a .ts name would otherwise go out as an MPEG stream
        const headers = /\.ts$/i.test(file) ? { 'Content-Type': 'text/plain; charset=utf-8' } : {};
        res.sendFile(file, { root: docsDir, dotfiles: 'deny', headers }, (err) => {
            if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
        });
    });
    // the guide's screenshots, at the path the project site serves them from
    const shotsDir = path.join(docsDir, 'assets', 'screenshots');
    app.get('/docs/assets/screenshots/:file', (req, res) => {
        if (!/^[a-z0-9-]+\.webp$/.test(req.params.file)) return res.status(400).json({ error: 'bad path' });
        res.sendFile(req.params.file, { root: shotsDir, dotfiles: 'deny' }, (err) => {
            if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
        });
    });

    // only the client and style folders resolve. `<id>@<n>` is a fresh generation so a reload refetches the graph
    if (config.extensionsEnabled) {
        app.get('/ext/:id/*rest', (req, res) => {
            const id = /^([^@]+)(?:@\d{1,16})?$/.exec(req.params.id)?.[1];
            const served = id ? resolveServedFile(id, req.params.rest) : null;
            if (!served) return res.status(404).json({ error: 'not found' });
            res.sendFile(served.rel, { root: served.root, dotfiles: 'ignore' }, (err) => {
                if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
            });
        });
    }

    const appDir = path.join(config.projectRoot, 'app');
    if (fs.existsSync(appDir)) {
        app.get('/', (req, res) => res.redirect('/library.html'));
        app.use(express.static(appDir));
    }

    // JSON error envelope for anything thrown or rejected in a route
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (res.headersSent) return;
        // a model's failure answers its kind's status and names the kind; its own status is the provider's
        if (err instanceof LlmError) return res.status(httpStatusFor(err)).json({ error: err.message, kind: err.kind });
        const status = err?.type === 'entity.too.large' ? 413
            : Number.isInteger(err?.statusCode) ? err.statusCode
                : Number.isInteger(err?.status) ? err.status : 500;
        if (status >= 500) console.error(`[api] ${req.method} ${req.originalUrl}:`, err);
        res.status(status).json({ error: err?.message || 'internal error' });
    });

    return app;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
    const app = await createApp();
    const server = app.listen(config.port, config.host, () => {
        console.log(`project-sigma ${pkg.version} listening on http://${config.host}:${config.port} (data: ${config.dataDir}, multiUser: ${config.multiUser})`);
        // only when serving, never in createApp: every app a test builds would get its own timer
        const serverDb = config.multiUser ? openServerDb() : null;
        startBackupScheduler({ serverDb });
        startStageSweeper({ serverDb });
        sweepStalePacks();
        sweepAllGreetings({ serverDb, log: console.log });
        startJobSchedules();
    });
    attachFeed(server);
}
