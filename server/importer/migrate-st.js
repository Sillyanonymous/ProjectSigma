import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { ensureUserDirs, userPaths } from '../config.js';
import { openDb, closeDb, isDbOpen } from '../db/database.js';
import { readCardChunks } from '../lib/png-card.js';
import { readJsonFile } from '../lib/json-file.js';
import { extractProviderLinks } from '../lib/provider-namespaces.js';
import { mergeCharVersionsDoc } from '../db/versions-store.js';
import { mergePlaylistsDoc } from '../db/playlists-store.js';
import { createPersona, setActivePersona } from '../db/personas-store.js';
import { importCharacterPng, importChatsDir, legacyGalleryFolders } from './import-st.js';
import { snapshotCardAsItStood } from './card-import.js';
import { upsertWorld } from '../db/worlds-store.js';
import { applyWorldsFor } from '../db/world-links-store.js';
import { verifyStMigration, PERSONA_PICTURES_KEY } from './verify-st-migration.js';
import { EXT_SETTINGS_KEY, STORE_DOC_MAP, CSS_SETTING_KEYS } from './st-layout.js';
import { warmAvatarThumbs, warmMediaThumbs } from '../lib/thumb-warm.js';

// the one-time ST-with-extension to standalone migration: filename-first identity, duplicates as copies, the whole estate, a run that verifies itself

const CLV_PREFIX = '_clv_';

function listPngs(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.png')).sort();
}

function dirBytes(dir) {
    let total = 0;
    try {
        for (const f of fs.readdirSync(dir)) {
            try { const st = fs.statSync(path.join(dir, f)); if (st.isFile()) total += st.size; } catch { /* unreadable file: not counted */ }
        }
    } catch { /* unreadable dir */ }
    return total;
}

// identity keys the resolver actually consults; gallery_id is deliberately absent
// (it names a folder, not a character)
function identityKeysOf(info) {
    const keys = [];
    if (info.clUid) keys.push(`cl_uid:${info.clUid}`);
    if (info.versionUid) keys.push(`version_uid:${info.versionUid}`);
    for (const l of info.providerLinks) {
        if (l?.providerId && l.externalId != null && l.externalId !== '') keys.push(`link:${l.providerId}:${l.externalId}`);
    }
    return keys;
}

/**
 * Read one PNG's identity surface without importing it. null when no card is embedded.
 */
function scanPng(fullPath) {
    let parsed;
    try { parsed = readCardChunks(fs.readFileSync(fullPath)); } catch { return null; }
    const data = parsed?.v3?.data ?? parsed?.v2?.data;
    if (!data || typeof data !== 'object') return null;
    const ext = data.extensions && typeof data.extensions === 'object' ? data.extensions : {};
    return {
        file: path.basename(fullPath),
        base: path.basename(fullPath, path.extname(fullPath)),
        name: typeof data.name === 'string' ? data.name : '',
        clUid: typeof ext.cl?.uid === 'string' && ext.cl.uid ? ext.cl.uid : null,
        versionUid: typeof ext.version_uid === 'string' && ext.version_uid ? ext.version_uid : null,
        galleryId: typeof ext.gallery_id === 'string' && ext.gallery_id ? ext.gallery_id : null,
        providerLinks: extractProviderLinks(ext),
        tags: Array.isArray(data.tags) ? data.tags.map(t => String(t).toLowerCase()) : [],
    };
}

function probeStatements(db) {
    if (!db) return null;
    return {
        byAvatar: db.prepare("SELECT char_id FROM char_aliases WHERE kind = 'avatar_file' AND value = ?"),
        byAlias: db.prepare('SELECT char_id FROM char_aliases WHERE kind = ? AND value = ?'),
        byId: db.prepare('SELECT id FROM characters WHERE id = ?'),
        byLink: db.prepare(`SELECT pl.char_id FROM provider_links pl JOIN characters c ON c.id = pl.char_id
            WHERE pl.provider_id = ? AND pl.external_id = ? ORDER BY c.imported_at ASC LIMIT 1`),
    };
}

// the char already holding this file's PORTABLE identity, oldest-import semantics
function probeIdentityOwner(stmts, info) {
    if (!stmts) return null;
    // adopted uuids ARE the id; there is no cl_uid alias kind anymore
    if (info.clUid && stmts.byId.get(info.clUid)) return info.clUid;
    if (info.versionUid) {
        const row = stmts.byAlias.get('version_uid', info.versionUid);
        if (row) return row.char_id;
    }
    for (const l of info.providerLinks) {
        if (!l?.providerId || l.externalId == null || l.externalId === '') continue;
        const row = stmts.byLink.get(l.providerId, String(l.externalId));
        if (row) return row.char_id;
    }
    return null;
}

/**
 * Build the migration plan, read-only over source and target: each PNG's action, the duplicate groups, the inventory, the sizes.
 * @param {object|null} db open target db for alias probes; null = probe nothing (fresh)
 */
export function scanStDir(userDir, { only = null, sample = null, excludeTags = [] } = {}, db = null) {
    const charactersDir = path.join(userDir, 'characters');
    if (!fs.existsSync(charactersDir)) {
        throw new Error(`no characters/ folder under ${userDir}; point at the ST user data dir (eg. data/default-user)`);
    }
    const stmts = probeStatements(db);
    const exclude = excludeTags.map(t => t.toLowerCase());

    const files = [];
    const noCard = [];
    const excluded = [];
    for (const file of listPngs(charactersDir)) {
        const info = scanPng(path.join(charactersDir, file));
        if (!info) { noCard.push(file); continue; }
        if (exclude.length && info.tags.some(t => exclude.includes(t))) { excluded.push(file); continue; }
        files.push(info);
    }

    // duplicate groups over the WHOLE source (report view): union files sharing any
    // identity key the resolver consults
    const keyOwner = new Map();
    const parent = new Map();
    const find = f => { while (parent.get(f) !== f) f = parent.get(f); return f; };
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(rb, ra); };
    for (const info of files) parent.set(info.file, info.file);
    for (const info of files) {
        for (const key of identityKeysOf(info)) {
            if (keyOwner.has(key)) union(keyOwner.get(key), info.file);
            else keyOwner.set(key, info.file);
        }
    }
    const groups = new Map();
    for (const info of files) {
        const root = find(info.file);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(info.file);
    }
    const duplicateGroups = [...groups.values()].filter(g => g.length > 1).map(g => g.sort());

    // selection: --only names/filenames (case-insensitive), then --sample N
    let selected = files;
    if (Array.isArray(only) && only.length) {
        const wanted = new Set(only.map(s => String(s).toLowerCase().replace(/\.png$/i, '')));
        selected = files.filter(f => wanted.has(f.base.toLowerCase()) || wanted.has(f.name.toLowerCase()));
    }
    if (Number.isInteger(sample) && sample > 0 && sample < selected.length) {
        const pool = [...selected];
        const picked = [];
        while (picked.length < sample && pool.length) {
            picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
        }
        selected = picked.sort((a, b) => a.file.localeCompare(b.file));
    }

    // filename first: an avatar_file hit heals this file in place; a portable-identity hit from another file imports as a copy
    const claimed = new Map(); // identity key -> file that owns it within this run
    const plan = [];
    for (const info of selected) {
        const healRow = stmts?.byAvatar.get(info.file);
        const keys = identityKeysOf(info);
        const dbOwner = probeIdentityOwner(stmts, info);
        const runOwner = keys.map(k => claimed.get(k)).find(Boolean) || null;
        let action;
        let targetId = null;
        let restrict = false;
        if (healRow) {
            action = 'heal';
            targetId = healRow.char_id;
            // a heal of a char not owning the portable identity keeps its restricted aliases, or re-runs steal ids back and forth
            restrict = !!(dbOwner && dbOwner !== healRow.char_id);
        } else if (dbOwner || runOwner) {
            action = 'copy';
            restrict = true;
        } else {
            action = 'create';
        }
        if (!restrict) for (const k of keys) if (!claimed.has(k)) claimed.set(k, info.file);
        plan.push({ ...info, action, targetId, aliasMode: restrict ? 'keep' : 'claim' });
    }
    const selectedFiles = new Set(selected.map(f => f.file));
    const selectedBases = new Set(selected.map(f => f.base));

    // chats inventory
    const chatsDir = path.join(userDir, 'chats');
    const chatDirs = fs.existsSync(chatsDir)
        ? fs.readdirSync(chatsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
        : [];
    const allBases = new Set(files.map(f => f.base));
    const matchedChatDirs = chatDirs.filter(d => selectedBases.has(d));
    const unmatchedChatDirs = chatDirs.filter(d => !allBases.has(d)
        && !stmts?.byAvatar.get(`${d}.png`));

    // group chats: explicitly out of scope, counted so the report is honest about it
    const groupChats = [];
    for (const dir of ['group chats', 'groups']) {
        const p = path.join(userDir, dir);
        if (fs.existsSync(p)) {
            for (const f of fs.readdirSync(p)) groupChats.push(`${dir}/${f}`);
        }
    }

    // worlds + estate inventory
    const worldsDir = path.join(userDir, 'worlds');
    const worlds = fs.existsSync(worldsDir)
        ? fs.readdirSync(worldsDir).filter(f => f.toLowerCase().endsWith('.json')).sort()
        : [];

    const filesDir = path.join(userDir, 'user', 'files');
    const settings = readJsonFile(path.join(userDir, 'settings.json'));
    const charLore = Array.isArray(settings?.world_info?.charLore) ? settings.world_info.charLore : [];
    const personas = settings?.power_user?.personas && typeof settings.power_user.personas === 'object'
        ? settings.power_user.personas : {};
    const versionDocs = selected.filter(f => f.versionUid
        && fs.existsSync(path.join(filesDir, `${CLV_PREFIX}${f.versionUid}.json`)));
    const storeDocs = STORE_DOC_MAP.filter(d => fs.existsSync(path.join(filesDir, d.file)));
    const playlistsDoc = fs.existsSync(path.join(filesDir, '_cl_playlists.json'));

    // media estimate: every (char, existing folder) pair imports, so a shared folder
    // counts once per same-name character that references it
    const imagesRoot = path.join(userDir, 'user', 'images');
    let mediaFiles = 0;
    let mediaBytes = 0;
    if (fs.existsSync(imagesRoot)) {
        for (const info of selected) {
            for (const folder of legacyGalleryFolders(info.name, info.galleryId)) {
                const dir = path.join(imagesRoot, folder);
                if (!fs.existsSync(dir)) continue;
                const bytes = dirBytes(dir);
                mediaBytes += bytes;
                try { mediaFiles += fs.readdirSync(dir).length; } catch { /* counted as 0 */ }
            }
        }
    }

    return {
        source: userDir,
        counts: {
            sourcePngs: files.length + noCard.length + excluded.length,
            cards: files.length,
            noCard: noCard.length,
            excluded: excluded.length,
            selected: selected.length,
            create: plan.filter(p => p.action === 'create').length,
            heal: plan.filter(p => p.action === 'heal').length,
            copy: plan.filter(p => p.action === 'copy').length,
            worlds: worlds.length,
            chatDirsMatched: matchedChatDirs.length,
            chatDirsUnmatched: unmatchedChatDirs.length,
            groupChatFiles: groupChats.length,
            versionDocs: versionDocs.length,
            charLoreEntries: charLore.length,
            globalWorlds: Array.isArray(settings?.world_info?.globalSelect) ? settings.world_info.globalSelect.length : 0,
            playlistsDoc,
            personas: Object.keys(personas).length,
            storeDocs: storeDocs.length,
            mediaFiles,
            mediaBytes,
        },
        plan,
        duplicateGroups,
        noCard,
        excluded,
        unmatchedChatDirs,
        groupChats,
        worlds,
        selectedFiles: [...selectedFiles],
        selectedBases: [...selectedBases],
    };
}

function importVersions(db, filesDir, plan, fileToChar, summary) {
    for (const info of plan) {
        if (!info.versionUid) continue;
        const charId = fileToChar.get(info.file);
        if (!charId) continue;
        const doc = readJsonFile(path.join(filesDir, `${CLV_PREFIX}${info.versionUid}.json`));
        if (!doc || !Array.isArray(doc.snapshots)) continue;
        try {
            // merged, never replaced: a library in use keeps every snapshot it took since a first run
            const { added, held, backup } = mergeCharVersionsDoc(db, charId, doc);
            summary.versionChars++;
            summary.versionSnapshots += added + (backup ? 1 : 0);
            summary.versionSnapshotsHeld += held;
        } catch (err) {
            summary.errors.push({ file: `${CLV_PREFIX}${info.versionUid}.json`, error: err.message });
        }
    }
}

function importCharLore(db, settings, baseToChar, summary) {
    const entries = Array.isArray(settings?.world_info?.charLore) ? settings.world_info.charLore : [];
    for (const entry of entries) {
        if (!entry || typeof entry.name !== 'string') continue;
        const charId = baseToChar.get(entry.name);
        if (!charId) { summary.charLoreUnmatched++; continue; }
        const books = Array.isArray(entry.extraBooks) ? entry.extraBooks.filter(b => typeof b === 'string' && b) : [];
        summary.charLoreLinks += applyWorldsFor(db, 'char', charId, { add: books, ensure: true }).added.length;
    }
}

function importGlobalWorlds(db, settings, summary) {
    const names = Array.isArray(settings?.world_info?.globalSelect) ? settings.world_info.globalSelect : [];
    // worlds import under their ST filename base so globalSelect matches verbatim; appended after existing rows, so re-runs are idempotent
    summary.globalWorlds += applyWorldsFor(db, 'global', null, { add: names.filter(n => typeof n === 'string'), ensure: true }).added.length;
}

function importPlaylists(db, doc, fileToChar, summary) {
    if (!doc || typeof doc !== 'object' || !doc.playlists) return;
    const byAvatar = db.prepare("SELECT char_id FROM char_aliases WHERE kind = 'avatar_file' AND value = ?");
    const translated = { version: 1, playlists: {}, order: Array.isArray(doc.order) ? doc.order : Object.keys(doc.playlists) };
    for (const [uid, p] of Object.entries(doc.playlists)) {
        if (!p || typeof p !== 'object') continue;
        const members = [];
        for (const avatar of Array.isArray(p.characters) ? p.characters : []) {
            const charId = fileToChar.get(avatar) || byAvatar.get(avatar)?.char_id;
            if (charId) members.push(charId);
            else summary.playlistMembersDropped++;
        }
        translated.playlists[uid] = { ...p, characters: members };
        summary.playlistMembers += members.length;
    }
    // merged, never replaced: a library in use keeps every playlist it made
    summary.playlistsRenamed += mergePlaylistsDoc(db, translated).renamed;
    summary.playlists = Object.keys(translated.playlists).length;
}

function importPersonas(db, paths, userDir, settings, summary) {
    const personas = settings?.power_user?.personas;
    if (!personas || typeof personas !== 'object') return;
    const descriptions = settings.power_user?.persona_descriptions || {};
    // a persona held under the same name and description is given what it lacks, never made again; rows match one for one in order
    const byKey = new Map();
    for (const p of db.prepare('SELECT id, name, description, avatar FROM personas ORDER BY created_at, rowid').all()) {
        const key = `${p.name}\u0000${p.description}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(p);
    }
    const avatarsDir = path.join(userDir, 'User Avatars');
    // the ST personas whose library row kept a picture of its own: the verify asks the ST bytes
    // only of a picture this run copied
    const keptPictures = [];
    for (const [avatarId, name] of Object.entries(personas)) {
        const description = String(descriptions[avatarId]?.description || '');
        const dedupKey = `${String(name)}\u0000${description}`;
        try {
            let row = byKey.get(dedupKey)?.shift();
            if (row) summary.personasSkipped++;
            else {
                row = createPersona(db, { name: String(name || 'Persona'), description });
                summary.personas++;
            }
            const source = path.join(avatarsDir, avatarId);
            if (row.avatar && fs.existsSync(source)) keptPictures.push(avatarId);
            else if (fs.existsSync(source)) {
                fs.mkdirSync(paths.personaAvatarsDir, { recursive: true });
                const dest = path.join(paths.personaAvatarsDir, `${row.id}.png`);
                try { fs.copyFileSync(source, dest); } catch (e) {
                    try { fs.unlinkSync(dest); } catch { /* never written */ }
                    throw e;
                }
                db.prepare('UPDATE personas SET avatar = ? WHERE id = ?').run(`${row.id}.png`, row.id);
                row.avatar = `${row.id}.png`;
            }
            // ST binds at most one lorebook per persona; it joins the end of the native ordered list
            const book = typeof descriptions[avatarId]?.lorebook === 'string' ? descriptions[avatarId].lorebook.trim() : '';
            if (book && applyWorldsFor(db, 'persona', row.id, { add: [book], ensure: true }).added.length) summary.personaWorlds++;
            if (settings.power_user?.default_persona === avatarId) setActivePersona(db, row.id);
        } catch (err) {
            summary.errors.push({ file: `persona ${avatarId}`, error: err.message });
        }
    }
    db.prepare('INSERT OR REPLACE INTO app_store (key, value, updated_at) VALUES (?, ?, ?)')
        .run(PERSONA_PICTURES_KEY, JSON.stringify({ at: Date.now(), kept: keptPictures }), Date.now());
}

function importStoreDocs(db, filesDir, summary) {
    const upsert = db.prepare('INSERT OR REPLACE INTO app_store (key, value, updated_at) VALUES (?, ?, ?)');
    const exists = db.prepare('SELECT 1 FROM app_store WHERE key = ?');
    for (const { file, key } of STORE_DOC_MAP) {
        const doc = readJsonFile(path.join(filesDir, file));
        if (!doc) continue;
        if (exists.get(key)) summary.storeDocsOverwritten.push(key);
        upsert.run(key, JSON.stringify({ version: 1, ...doc }), Date.now());
        summary.storeDocs++;
    }
}

// the ONE exception to "extension settings are superseded": raw custom CSS is
// user-authored styling, not configuration
function importCssSettings(db, settings, summary) {
    const ext = settings?.extension_settings?.[EXT_SETTINGS_KEY];
    if (!ext || typeof ext !== 'object') return;
    const write = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    const exists = db.prepare('SELECT 1 FROM settings WHERE key = ?');
    for (const key of CSS_SETTING_KEYS) {
        const v = ext[key];
        if (typeof v !== 'string' || !v) continue;
        if (exists.get(key)) continue; // never clobber a value the target already chose
        write.run(key, JSON.stringify(v));
        summary.cssSettings++;
    }
}

/**
 * Run the migration (or just plan it with dryRun). Returns { plan, summary, verify }.
 */
export function migrateStDir(userDir, opts = {}) {
    const {
        handle = null, only = null, sample = null, excludeTags = [],
        dryRun = false, verify = true, verifyMode = null, reportPath = null, force = false,
    } = opts;
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    if (!handle) throw new Error('a target user handle is required (--user <handle>)');
    userDir = path.resolve(userDir);

    // dry-run must not create or migrate the target home; probe read-only when it exists
    const dbFile = userPaths(handle).dbFile;
    let db = null;
    let probeDb = null;
    // a library someone in this process already holds stays open for them when the run ends
    const heldBefore = isDbOpen(handle);
    if (!dryRun) {
        db = openDb(handle);
    } else if (fs.existsSync(dbFile)) {
        probeDb = new Database(dbFile, { readonly: true });
    }

    try {
        // a finalized library has no identity scaffolding left, so a re-run cannot heal
        // and would duplicate every character; refusing is the only safe default
        let finalized = null;
        try { finalized = (db || probeDb)?.prepare("SELECT value FROM app_store WHERE key = 'st-migration-finalized'").get(); }
        catch { /* pre-migration home probed read-only: no app_store, so not finalized */ }
        if (finalized && !force) {
            throw new Error(`target "${handle}" was finalized after a migration (${finalized.value}); `
                + 'its ST-era aliases were purged, so a re-run would DUPLICATE every character. Pass --force only if that is really what you want.');
        }
        const scan = scanStDir(userDir, { only, sample, excludeTags }, db || probeDb);
        log(`plan: ${scan.counts.selected}/${scan.counts.cards} cards selected `
            + `(${scan.counts.create} create, ${scan.counts.heal} heal, ${scan.counts.copy} copy), `
            + `${scan.counts.worlds} worlds, ${scan.counts.chatDirsMatched} chat folders, `
            + `${scan.counts.mediaFiles} media files (${(scan.counts.mediaBytes / 1048576).toFixed(1)} MB), `
            + `${scan.counts.versionDocs} version docs, ${scan.counts.personas} personas, `
            + `${scan.counts.globalWorlds} global worlds`);
        if (scan.duplicateGroups.length) {
            log(`duplicate groups (import as independent copies): ${scan.duplicateGroups.map(g => g.join(' + ')).join('; ')}`);
        }
        if (scan.counts.groupChatFiles) log(`group chats are OUT OF SCOPE; ${scan.counts.groupChatFiles} file(s) stay at the source`);
        if (dryRun) {
            const report = { mode: 'dry-run', at: Date.now(), handle, ...scan };
            if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
            return { plan: scan, summary: null, verify: null };
        }

        const paths = ensureUserDirs(handle);
        const summary = {
            imported: 0, healed: 0, copies: 0, skipped: [], errors: [],
            worlds: 0, chats: 0, chatsUnmatched: 0, chatLinesDropped: 0,
            mediaImported: 0, mediaSkipped: 0,
            versionChars: 0, versionSnapshots: 0, versionSnapshotsHeld: 0,
            charLoreLinks: 0, charLoreUnmatched: 0, globalWorlds: 0,
            playlists: 0, playlistsRenamed: 0, playlistMembers: 0, playlistMembersDropped: 0,
            personas: 0, personasSkipped: 0, personaWorlds: 0,
            storeDocs: 0, storeDocsOverwritten: [], cssSettings: 0,
        };

        // worlds first: cheap, and chat metadata may name them
        const worldsDir = path.join(userDir, 'worlds');
        for (const file of scan.worlds) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(worldsDir, file), 'utf8'));
                upsertWorld(db, path.basename(file, path.extname(file)), data, { imported: true });
                summary.worlds++;
            } catch (err) {
                summary.errors.push({ file, error: err.message });
            }
        }

        const charactersDir = path.join(userDir, 'characters');
        const imagesRoot = path.join(userDir, 'user', 'images');
        const galleryOpts = fs.existsSync(imagesRoot) ? { imagesRoot, counters: summary } : {};
        const fileToChar = new Map();
        const baseToChar = new Map();
        let done = 0;
        for (const info of scan.plan) {
            try {
                const result = importCharacterPng(db, paths, path.join(charactersDir, info.file), {
                    ...galleryOpts,
                    resolved: {
                        action: info.action === 'heal' ? 'heal' : info.action === 'copy' ? 'copy' : 'create',
                        id: info.targetId,
                        aliasMode: info.aliasMode,
                        // a heal overwrites a card the reader may have edited since: a changed one is snapshotted first, as a Replace does
                        before: info.action === 'heal' ? (dbIn, charId, { contentHash, storedHash }) => {
                            if (storedHash !== contentHash) snapshotCardAsItStood(dbIn, paths, charId, 'Before SillyTavern migration');
                        } : undefined,
                    },
                });
                if (!result) { summary.skipped.push(info.file); continue; }
                fileToChar.set(info.file, result.id);
                baseToChar.set(info.base, result.id);
                if (info.action === 'heal') summary.healed++;
                else if (info.action === 'copy') summary.copies++;
                else summary.imported++;
            } catch (err) {
                summary.errors.push({ file: info.file, error: err.message });
            }
            if (++done % 100 === 0 || done === scan.plan.length) {
                log(`characters ${done}/${scan.plan.length} (media ${summary.mediaImported}, errors ${summary.errors.length})`);
            }
        }

        importChatsDir(db, path.join(userDir, 'chats'), summary, { allowDirs: new Set(scan.selectedBases) });
        log(`chats ${summary.chats} imported, ${summary.chatsUnmatched} unmatched${summary.chatLinesDropped ? `, ${summary.chatLinesDropped} lines dropped (torn, or not a message)` : ''}`);

        const filesDir = path.join(userDir, 'user', 'files');
        const settings = readJsonFile(path.join(userDir, 'settings.json'));
        importVersions(db, filesDir, scan.plan, fileToChar, summary);
        importCharLore(db, settings, baseToChar, summary);
        importGlobalWorlds(db, settings, summary);
        importPlaylists(db, readJsonFile(path.join(filesDir, '_cl_playlists.json')), fileToChar, summary);
        importPersonas(db, paths, userDir, settings, summary);
        importStoreDocs(db, filesDir, summary);
        importCssSettings(db, settings, summary);

        // the cards this run brought over, so the finalize verifies the same set, not every card in the folder
        db.prepare('INSERT OR REPLACE INTO app_store (key, value, updated_at) VALUES (?, ?, ?)')
            .run('st-migration-selection', JSON.stringify({ at: Date.now(), files: scan.selectedFiles }), Date.now());

        let verifyOut = null;
        if (verify) {
            // deep once, quick after: the byte re-hash proves read-equals-written on the first clean pass; re-runs never rewrite media
            const mode = resolveVerifyMode(db, verifyMode);
            log(`verifying source against target (${mode})...`);
            verifyOut = verifyStMigration(userDir, db, paths, { files: scan.selectedFiles, mediaBytes: mode === 'full' });
            verifyOut.mode = mode;
            log(verifyOut.findings.length
                ? `VERIFY FAILED: ${verifyOut.findings.length} finding(s)`
                : `verify clean (${verifyOut.checked} checks, ${mode})`);
            // a clean FULL pass over the WHOLE selection is what downgrades the future
            if (!verifyOut.findings.length && mode === 'full' && !only && !sample) {
                db.prepare('INSERT OR REPLACE INTO app_store (key, value, updated_at) VALUES (?, ?, ?)')
                    .run('st-migration-verified', JSON.stringify({ at: Date.now(), mode: 'full' }), Date.now());
            }
        }

        // fold the bulk-import's write-ahead log back into the main file: an
        // unfolded multi-hundred-MB WAL taxes every read until someone checkpoints
        try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* busy: the server folds it on its next write */ }

        const report = { mode: 'run', at: Date.now(), handle, counts: scan.counts, duplicateGroups: scan.duplicateGroups, unmatchedChatDirs: scan.unmatchedChatDirs, groupChats: scan.groupChats, summary, verify: verifyOut };
        const outPath = reportPath || path.join(paths.root, `migration-report-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
        fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
        log(`report written: ${outPath}`);
        return { plan: scan, summary, verify: verifyOut, reportFile: outPath };
    } finally {
        probeDb?.close();
        if (db && !heldBefore) closeDb(handle);
    }
}

/** Declare the migration done: a final verify, then the ST-era aliases purged; one-way, a later run is refused by the marker. */
export function finalizeStMigration(userDir, opts = {}) {
    const { handle = null, force = false, verifyMode = null } = opts;
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    if (!handle) throw new Error('a target user handle is required (--user <handle>)');
    const db = openDb(handle);
    try {
        const paths = ensureUserDirs(handle);
        if (!force) {
            const mode = resolveVerifyMode(db, verifyMode);
            log(`final parity verify before the point of no return (${mode})...`);
            // the set the last run brought over: cards it left out on purpose would each read as a card with no character
            let files = null;
            try { files = JSON.parse(db.prepare("SELECT value FROM app_store WHERE key = 'st-migration-selection'").get()?.value || 'null')?.files || null; } catch { files = null; }
            const out = verifyStMigration(path.resolve(userDir), db, paths, { files, mediaBytes: mode === 'full' });
            if (out.findings.length) return { ok: false, findings: out.findings };
            log(`verify clean (${out.checked} checks, ${mode})`);
        }
        const purged = db.prepare(
            "DELETE FROM char_aliases WHERE kind IN ('avatar_file', 'version_uid', 'gallery_id')").run().changes;
        db.prepare('INSERT OR REPLACE INTO app_store (key, value, updated_at) VALUES (?, ?, ?)')
            .run('st-migration-finalized', JSON.stringify({ at: Date.now(), source: path.resolve(userDir), purged }), Date.now());
        log(`purged ${purged} ST-era alias row(s); the library is native-pure`);
        return { ok: true, purged, findings: [] };
    } finally {
        closeDb(handle);
    }
}

/** A home's migration markers (finalized, verified) read without holding the library open; nulls for a home with no library. */
export function migrationState(handle) {
    const dbFile = userPaths(handle).dbFile;
    if (!fs.existsSync(dbFile)) return { finalized: null, verified: null };
    let db = null;
    try {
        db = new Database(dbFile, { readonly: true });
        const read = (key) => {
            try { const row = db.prepare('SELECT value FROM app_store WHERE key = ?').get(key); return row ? JSON.parse(row.value) : null; } catch { return null; }
        };
        return { finalized: read('st-migration-finalized'), verified: read('st-migration-verified') };
    } catch {
        return { finalized: null, verified: null };
    } finally {
        db?.close();
    }
}

// 'full' until one clean whole-selection full pass is on record, 'fast' after; an
// explicit --verify choice always wins
function resolveVerifyMode(db, requested) {
    if (requested === 'full' || requested === 'fast') return requested;
    try {
        const row = db.prepare("SELECT value FROM app_store WHERE key = 'st-migration-verified'").get();
        if (row && JSON.parse(row.value)?.mode === 'full') return 'fast';
    } catch { /* unreadable marker: verify deep */ }
    return 'full';
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
    const args = process.argv.slice(2);
    const opts = { only: [], excludeTags: [], dryRun: false, verify: true, handle: null, sample: null, reportPath: null, force: false };
    let finalize = false;
    let userDir = null;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--user') opts.handle = args[++i];
        else if (a === '--only') opts.only.push(args[++i]);
        else if (a === '--sample') opts.sample = Number(args[++i]);
        else if (a === '--exclude-tag') opts.excludeTags.push(args[++i]);
        else if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--no-verify') opts.verify = false;
        else if (a === '--verify') {
            const v = args[++i];
            if (v === 'off') opts.verify = false;
            else if (v === 'full' || v === 'fast') opts.verifyMode = v;
            else { console.error("--verify takes full, fast or off"); process.exit(1); }
        }
        else if (a === '--finalize') finalize = true;
        else if (a === '--force') opts.force = true;
        else if (a === '--warm-thumbs') opts.warmThumbs = true;
        else if (a === '--report') opts.reportPath = args[++i];
        else userDir = a;
    }
    if (!userDir || !opts.handle) {
        console.error('usage: node server/importer/migrate-st.js <st-user-data-dir> --user <handle> [--dry-run] [--only <name|file>]... [--sample N] [--exclude-tag <tag>]... [--warm-thumbs] [--finalize] [--force] [--verify full|fast|off] [--report <path>]');
        process.exit(1);
    }
    if (!opts.only.length) opts.only = null;
    if (finalize) {
        try {
            const out = finalizeStMigration(userDir, { handle: opts.handle, force: opts.force, verifyMode: opts.verifyMode, log: m => console.log(m) });
            if (!out.ok) {
                for (const f of out.findings.slice(0, 50)) console.error(`VERIFY ${f}`);
                console.error('finalize REFUSED: fix the findings (or re-run the migration to heal), then retry');
                process.exit(3);
            }
            process.exit(0);
        } catch (err) {
            console.error(err.message);
            process.exit(1);
        }
    }
    try {
        const { summary, verify } = migrateStDir(path.resolve(userDir), { ...opts, log: m => console.log(m) });
        if (summary) {
            console.log(`imported ${summary.imported} (+${summary.copies} copies, ${summary.healed} healed), `
                + `chats ${summary.chats}, media ${summary.mediaImported} (+${summary.mediaSkipped} skipped), `
                + `worlds ${summary.worlds}, versions ${summary.versionChars} chars/${summary.versionSnapshots} snaps (${summary.versionSnapshotsHeld} already held), `
                + `lore links ${summary.charLoreLinks} (+${summary.globalWorlds} global), playlists ${summary.playlists}${summary.playlistsRenamed ? ` (${summary.playlistsRenamed} renamed: the library held their names)` : ''}, `
                + `personas ${summary.personas} (${summary.personaWorlds} with books), `
                + `errors ${summary.errors.length}`);
            for (const e of summary.errors) console.error(`ERROR ${e.file}: ${e.error}`);
            if (opts.warmThumbs) {
                console.log('warming avatar thumbnails...');
                const progress = (done, total) => { if (done % 2000 === 0) console.log(`thumbs ${done}/${total}`); };
                const a = await warmAvatarThumbs(userPaths(opts.handle), { onProgress: progress });
                console.log(`avatar thumbs: ${a.generated} generated, ${a.failed} failed; warming gallery thumbnails...`);
                const wdb = openDb(opts.handle);
                const m = await warmMediaThumbs(wdb, userPaths(opts.handle), { onProgress: progress });
                closeDb(opts.handle);
                console.log(`gallery thumbs: ${m.generated} generated, ${m.failed} failed`);
            } else {
                console.log('note: thumbnails generate on first view, so the first browse of a large library');
                console.log('feels slow. Pre-generate them with --warm-thumbs, or from Settings inside the app.');
            }
        }
        if (verify?.findings.length) {
            for (const f of verify.findings.slice(0, 50)) console.error(`VERIFY ${f}`);
            if (verify.findings.length > 50) console.error(`... +${verify.findings.length - 50} more`);
            process.exit(3);
        }
        process.exit(summary && summary.errors.length ? 2 : 0);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}
