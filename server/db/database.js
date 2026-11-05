import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, ensureUserDirs } from '../config.js';
import { promoteKnownNamespaces } from './characters-store.js';
import { loadPersistedNamespaces } from '../lib/provider-namespaces.js';
import { trackHandle } from './changes.js';
import { FTS_TABLES, scheduleFtsMerge, stopFtsMerge } from './fts-merge.js';

export const MIGRATIONS = [
    // 1: core library tables
    `
    CREATE TABLE characters (
        id TEXT PRIMARY KEY,
        card TEXT NOT NULL,
        name TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.name')) STORED,
        creator TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.creator')) STORED,
        nickname TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.nickname')) STORED,
        character_version TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.character_version')) STORED,
        creator_notes TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.creator_notes')) STORED,
        fav INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER,
        imported_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_characters_name ON characters(name);
    CREATE INDEX idx_characters_creator ON characters(creator);

    CREATE TABLE char_aliases (
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        char_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        PRIMARY KEY (kind, value)
    );
    CREATE INDEX idx_char_aliases_char ON char_aliases(char_id);

    CREATE TABLE provider_links (
        char_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        external_id TEXT,
        full_path TEXT,
        page_name TEXT,
        linked_at INTEGER,
        data TEXT,
        PRIMARY KEY (char_id, provider_id)
    );
    CREATE INDEX idx_provider_links_lookup ON provider_links(provider_id, external_id);

    CREATE TABLE tags (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE
    );
    CREATE TABLE char_tags (
        char_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        pos INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (char_id, tag_id)
    );
    CREATE INDEX idx_char_tags_tag ON char_tags(tag_id);

    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    `,
    // 2: worldinfo as rows (name-keyed to match how cards reference worlds)
    `
    CREATE TABLE worlds (
        name TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        entry_count INTEGER NOT NULL DEFAULT 0,
        imported_at INTEGER,
        updated_at INTEGER NOT NULL
    );
    `,
    // 3: generic JSON store (kills the Files-API _cl_*.json class) + gallery media index
    `
    CREATE TABLE app_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE media (
        id INTEGER PRIMARY KEY,
        char_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        file TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'image',
        source_url TEXT,
        url_hash TEXT,
        size INTEGER,
        added_at INTEGER NOT NULL,
        UNIQUE(char_id, display_name)
    );
    CREATE INDEX idx_media_char ON media(char_id);
    CREATE UNIQUE INDEX idx_media_char_urlhash ON media(char_id, url_hash) WHERE url_hash IS NOT NULL;
    `,
    // 4: shape hardening - playlists + versions become rows, settings become per-key
    // rows, cl_uid self-aliases drop (the char's own id resolves directly)
    (db) => {
        db.exec(`
            CREATE TABLE playlists (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                icon TEXT NOT NULL DEFAULT '',
                color TEXT NOT NULL DEFAULT '',
                pos INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER,
                modified_at INTEGER
            );
            CREATE TABLE playlist_chars (
                playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                char_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
                pos INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (playlist_id, char_id)
            );
            CREATE INDEX idx_playlist_chars_char ON playlist_chars(char_id);
            CREATE TABLE versions (
                char_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
                snap_id INTEGER NOT NULL,
                label TEXT,
                source TEXT,
                created_at INTEGER NOT NULL,
                char_name TEXT,
                data TEXT NOT NULL,
                PRIMARY KEY (char_id, snap_id)
            );
        `);

        // frozen copies of the decomposers: a migration calling a live store helper replays whatever it means on the day it runs
        const charExists = db.prepare('SELECT 1 FROM characters WHERE id = ?');
        const decomposePlaylists = (doc) => {
            const order = Array.isArray(doc?.order) ? doc.order : Object.keys(doc?.playlists || {});
            db.prepare('DELETE FROM playlists').run();
            const insertList = db.prepare(`
                INSERT INTO playlists (id, name, description, icon, color, pos, created_at, modified_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const insertChar = db.prepare('INSERT OR IGNORE INTO playlist_chars (playlist_id, char_id, pos) VALUES (?, ?, ?)');
            order.forEach((uid, pos) => {
                const p = doc.playlists?.[uid];
                if (!p || typeof p !== 'object') return;
                insertList.run(uid, String(p.name || 'Playlist'), String(p.description || ''),
                    String(p.icon || ''), String(p.color || ''), pos, p.created ?? null, p.modified ?? null);
                (Array.isArray(p.characters) ? p.characters : []).forEach((charId, cpos) => {
                    if (charExists.get(String(charId))) insertChar.run(uid, String(charId), cpos);
                });
            });
        };
        const BACKUP_SNAP_ID = -1;
        const decomposeVersions = (charId, doc) => {
            db.prepare('DELETE FROM versions WHERE char_id = ?').run(charId);
            const insert = db.prepare(`
                INSERT INTO versions (char_id, snap_id, label, source, created_at, char_name, data)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            for (const s of (Array.isArray(doc?.snapshots) ? doc.snapshots : [])) {
                insert.run(charId, s.id, s.label ?? null, s.source ?? null,
                    s.timestamp ?? Date.now(), s.charName ?? null, JSON.stringify(s.data ?? {}));
            }
            if (doc?.backup) {
                insert.run(charId, BACKUP_SNAP_ID, null, '__backup__',
                    doc.backup.timestamp ?? Date.now(), null, JSON.stringify(doc.backup));
            }
        };

        const getStore = db.prepare('SELECT value FROM app_store WHERE key = ?');
        const delStore = db.prepare('DELETE FROM app_store WHERE key = ?');

        // a torn document lifts nothing; a write that fails throws, so the step rolls back with every document kept
        const parsed = (text) => { try { return JSON.parse(text); } catch { return null; } };

        const plRow = getStore.get('playlists');
        if (plRow) {
            const doc = parsed(plRow.value);
            if (doc) decomposePlaylists(doc);
            delStore.run('playlists');
        }

        const clvRows = db.prepare("SELECT key, value FROM app_store WHERE key LIKE 'clv_%' AND key != 'clv_index'").all();
        for (const row of clvRows) {
            const charId = row.key.slice(4);
            const doc = parsed(row.value);
            if (doc && charExists.get(charId)) decomposeVersions(charId, doc);
            delStore.run(row.key);
        }
        delStore.run('clv_index');

        const appSettings = db.prepare("SELECT value FROM settings WHERE key = 'app'").get();
        if (appSettings) {
            const obj = parsed(appSettings.value);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                const insert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
                for (const [k, v] of Object.entries(obj)) insert.run(k, JSON.stringify(v));
            }
            db.prepare("DELETE FROM settings WHERE key = 'app'").run();
        }

        db.prepare("DELETE FROM char_aliases WHERE kind = 'cl_uid' AND value = char_id").run();
    },
    // 5: characters record layout: card moves LAST so list reads never walk its overflow, and data.tags leaves the stored card
    (db) => {
        db.exec(`
            CREATE TABLE characters_new (
                id TEXT PRIMARY KEY,
                name TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.name')) STORED,
                creator TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.creator')) STORED,
                nickname TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.nickname')) STORED,
                character_version TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.character_version')) STORED,
                creator_notes TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.creator_notes')) STORED,
                fav INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER,
                imported_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                card TEXT NOT NULL
            );
            INSERT INTO characters_new (id, fav, created_at, imported_at, updated_at, card)
                SELECT id, fav, created_at, imported_at, updated_at,
                       json_remove(card, '$.data.tags')
                FROM characters;
            DROP TABLE characters;
            ALTER TABLE characters_new RENAME TO characters;
            CREATE INDEX idx_characters_name ON characters(name);
            CREATE INDEX idx_characters_creator ON characters(creator);
        `);
    },
    // 6: token_estimate as a real column, server-maintained, backfilled in SQL
    `
    ALTER TABLE characters ADD COLUMN token_estimate INTEGER NOT NULL DEFAULT 0;
    UPDATE characters SET token_estimate = (
        COALESCE(length(json_extract(card, '$.data.description')), 0) +
        COALESCE(length(json_extract(card, '$.data.personality')), 0) +
        COALESCE(length(json_extract(card, '$.data.scenario')), 0) +
        COALESCE(length(json_extract(card, '$.data.first_mes')), 0) +
        COALESCE(length(json_extract(card, '$.data.system_prompt')), 0)
    ) / 4;
    `,
    // 7: update_locked becomes an op-state column stripped from cards; world gets a queryable virtual column
    `
    ALTER TABLE characters ADD COLUMN update_locked INTEGER NOT NULL DEFAULT 0;
    UPDATE characters SET update_locked = 1
        WHERE json_extract(card, '$.data.extensions.update_locked') = 1
           OR json_extract(card, '$.data.extensions.update_locked') = 'true';
    UPDATE characters SET card = json_remove(card, '$.data.extensions.update_locked')
        WHERE json_extract(card, '$.data.extensions.update_locked') IS NOT NULL;
    ALTER TABLE characters ADD COLUMN world TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.extensions.world')) VIRTUAL;
    CREATE INDEX idx_characters_world ON characters(world) WHERE world IS NOT NULL;
    `,
    // 8: worlds entries -> rows (a world IS a collection of entries; whole-doc PUT stops
    // being the only write shape) + the chat archive tables (browse/preview/edit, no runtime)
    (db) => {
        db.exec(`
            CREATE TABLE world_entries (
                world_name TEXT NOT NULL REFERENCES worlds(name) ON DELETE CASCADE ON UPDATE CASCADE,
                uid INTEGER NOT NULL,
                data TEXT NOT NULL,
                comment TEXT GENERATED ALWAYS AS (json_extract(data, '$.comment')) VIRTUAL,
                enabled INTEGER GENERATED ALWAYS AS (CASE WHEN json_extract(data, '$.disable') THEN 0 ELSE 1 END) VIRTUAL,
                PRIMARY KEY (world_name, uid)
            ) WITHOUT ROWID;

            CREATE TABLE chats (
                id TEXT PRIMARY KEY,
                char_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                user_name TEXT,
                character_name TEXT,
                chat_metadata TEXT NOT NULL DEFAULT '{}',
                create_date INTEGER,
                message_count INTEGER NOT NULL DEFAULT 0,
                last_mes_at INTEGER,
                last_mes TEXT,
                imported_at INTEGER,
                updated_at INTEGER NOT NULL,
                UNIQUE (char_id, name)
            );
            CREATE INDEX idx_chats_last ON chats(last_mes_at);

            CREATE TABLE chat_messages (
                chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                data TEXT NOT NULL,
                mes TEXT GENERATED ALWAYS AS (json_extract(data, '$.mes')) VIRTUAL,
                is_user INTEGER GENERATED ALWAYS AS (CASE WHEN json_extract(data, '$.is_user') THEN 1 ELSE 0 END) VIRTUAL,
                is_system INTEGER GENERATED ALWAYS AS (CASE WHEN json_extract(data, '$.is_system') THEN 1 ELSE 0 END) VIRTUAL,
                PRIMARY KEY (chat_id, seq)
            ) WITHOUT ROWID;
        `);

        const insertEntry = db.prepare('INSERT OR REPLACE INTO world_entries (world_name, uid, data) VALUES (?, ?, ?)');
        const updateWorld = db.prepare('UPDATE worlds SET data = ? WHERE name = ?');
        for (const row of db.prepare('SELECT name, data FROM worlds').all()) {
            let doc;
            try { doc = JSON.parse(row.data); } catch { continue; }
            const entries = doc?.entries && typeof doc.entries === 'object' ? doc.entries : {};
            for (const [key, entry] of Object.entries(entries)) {
                const uid = Number.isInteger(entry?.uid) ? entry.uid : Number(key);
                if (!Number.isFinite(uid)) continue;
                insertEntry.run(row.name, uid, JSON.stringify(entry));
            }
            delete doc.entries;
            updateWorld.run(JSON.stringify(doc), row.name);
        }
    },
    // 9: sort and filter indexes; ORDER BY name COLLATE NOCASE cant use the binary index, so name gets a NOCASE twin
    `
    CREATE INDEX idx_characters_name_nocase ON characters(name COLLATE NOCASE);
    CREATE INDEX idx_characters_imported ON characters(imported_at);
    CREATE INDEX idx_characters_created ON characters(created_at);
    CREATE INDEX idx_characters_updated ON characters(updated_at);
    CREATE INDEX idx_characters_tokens ON characters(token_estimate);
    CREATE INDEX idx_characters_fav ON characters(fav) WHERE fav = 1;
    `,
    // 10: full-text search, external-content FTS5 synced by triggers; external content keys on a rowid, so chat_messages loses WITHOUT ROWID
    (db) => {
        db.exec(`
            ALTER TABLE characters ADD COLUMN description TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.description')) VIRTUAL;
            ALTER TABLE characters ADD COLUMN personality TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.personality')) VIRTUAL;
            ALTER TABLE characters ADD COLUMN scenario TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.scenario')) VIRTUAL;
            ALTER TABLE characters ADD COLUMN first_mes TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.first_mes')) VIRTUAL;
            ALTER TABLE characters ADD COLUMN mes_example TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.mes_example')) VIRTUAL;
            ALTER TABLE characters ADD COLUMN system_prompt TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.system_prompt')) VIRTUAL;

            CREATE VIRTUAL TABLE characters_fts USING fts5(
                name, creator, nickname, creator_notes, description, personality,
                scenario, first_mes, mes_example, system_prompt,
                content='characters', content_rowid='rowid',
                tokenize='unicode61 remove_diacritics 2'
            );
            INSERT INTO characters_fts(characters_fts) VALUES ('rebuild');

            CREATE TABLE chat_messages_new (
                chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                data TEXT NOT NULL,
                mes TEXT GENERATED ALWAYS AS (json_extract(data, '$.mes')) VIRTUAL,
                is_user INTEGER GENERATED ALWAYS AS (CASE WHEN json_extract(data, '$.is_user') THEN 1 ELSE 0 END) VIRTUAL,
                is_system INTEGER GENERATED ALWAYS AS (CASE WHEN json_extract(data, '$.is_system') THEN 1 ELSE 0 END) VIRTUAL,
                PRIMARY KEY (chat_id, seq)
            );
            INSERT INTO chat_messages_new (chat_id, seq, data) SELECT chat_id, seq, data FROM chat_messages;
            DROP TABLE chat_messages;
            ALTER TABLE chat_messages_new RENAME TO chat_messages;

            CREATE VIRTUAL TABLE chat_messages_fts USING fts5(
                mes, content='chat_messages', content_rowid='rowid',
                tokenize='unicode61 remove_diacritics 2'
            );
            INSERT INTO chat_messages_fts(chat_messages_fts) VALUES ('rebuild');
        `);
        db.exec(FTS_TRIGGERS_SQL_10);
    },
    // 11: the binary name and creator indexes go (every consumer is NOCASE); creator gets its NOCASE index
    `
    DROP INDEX idx_characters_name;
    DROP INDEX idx_characters_creator;
    CREATE INDEX idx_characters_creator_nocase ON characters(creator COLLATE NOCASE);
    `,
    // 12: card-definition filters: VIRTUAL columns with FULL indexes, so both filter directions skip the blob; never in the list projection
    `
    ALTER TABLE characters ADD COLUMN alt_greetings INTEGER GENERATED ALWAYS AS (COALESCE(json_array_length(card, '$.data.alternate_greetings'), 0)) VIRTUAL;
    ALTER TABLE characters ADD COLUMN has_lorebook INTEGER GENERATED ALWAYS AS (json_extract(card, '$.data.character_book') IS NOT NULL) VIRTUAL;
    ALTER TABLE characters ADD COLUMN has_system_prompt INTEGER GENERATED ALWAYS AS (COALESCE(length(json_extract(card, '$.data.system_prompt')), 0) > 0) VIRTUAL;
    ALTER TABLE characters ADD COLUMN spec_version TEXT GENERATED ALWAYS AS (json_extract(card, '$.spec_version')) VIRTUAL;
    CREATE INDEX idx_characters_altg ON characters(alt_greetings);
    CREATE INDEX idx_characters_lorebook ON characters(has_lorebook);
    CREATE INDEX idx_characters_sysprompt ON characters(has_system_prompt);
    CREATE INDEX idx_characters_spec ON characters(spec_version);
    `,
    // 13: media content hashing at write time; the backfill hashes the existing files once
    (db, paths) => {
        db.exec(`
            ALTER TABLE media ADD COLUMN content_hash TEXT;
            CREATE INDEX idx_media_content ON media(char_id, content_hash) WHERE content_hash IS NOT NULL;
        `);
        const update = db.prepare('UPDATE media SET content_hash = ? WHERE id = ?');
        for (const row of db.prepare('SELECT id, char_id, file FROM media').all()) {
            try {
                const bytes = fs.readFileSync(path.join(paths.galleryRoot, row.char_id, row.file));
                update.run(crypto.createHash('sha256').update(bytes).digest('hex'), row.id);
            } catch { /* file missing: hash stays null, next write heals */ }
        }
    },
    // 14: additional lorebooks (charLore) as a relation
    `
    CREATE TABLE char_aux_worlds (
        char_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        world_name TEXT NOT NULL,
        pos INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (char_id, world_name)
    ) WITHOUT ROWID;
    CREATE INDEX idx_aux_worlds_world ON char_aux_worlds(world_name);
    `,
    // 15: world-link unification: one ordered list per character, no primary flag; extensions.world becomes interchange-only
    (db) => {
        db.exec('ALTER TABLE char_aux_worlds RENAME TO char_worlds;');
        const insertHead = db.prepare(`INSERT INTO char_worlds (char_id, world_name, pos)
            VALUES (?, ?, -1)
            ON CONFLICT(char_id, world_name) DO UPDATE SET pos = -1`);
        for (const row of db.prepare("SELECT id, world FROM characters WHERE world IS NOT NULL AND world != ''").all()) {
            insertHead.run(row.id, row.world);
        }
        db.exec(`
            DROP INDEX idx_characters_world;
            ALTER TABLE characters DROP COLUMN world;
            UPDATE characters SET card = json_remove(card, '$.data.extensions.world')
                WHERE json_extract(card, '$.data.extensions.world') IS NOT NULL;
        `);
    },
    // 16: LLM profiles as rows; keys live server-side only
    `
    CREATE TABLE llm_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'openai',
        base_url TEXT NOT NULL DEFAULT '',
        api_key TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        pos INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER
    );
    `,
    // 17: zero-use tag rows become impossible: a trigger reaps a tag with its last carrier, cascades included
    `
    CREATE TRIGGER trg_char_tags_prune AFTER DELETE ON char_tags BEGIN
        DELETE FROM tags WHERE id = old.tag_id
            AND NOT EXISTS (SELECT 1 FROM char_tags WHERE tag_id = old.tag_id);
    END;
    DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM char_tags);
    `,
    // 18: per-profile default generation params (neutral vocabulary JSON);
    // request params override per call. Part of the P4 design's profile model.
    `
    ALTER TABLE llm_profiles ADD COLUMN params TEXT NOT NULL DEFAULT '{}';
    `,
    // 19: the chat-bound world as a queryable column; NULLIF folds ''-valued bindings into unbound
    `
    ALTER TABLE chats ADD COLUMN world TEXT GENERATED ALWAYS AS (NULLIF(json_extract(chat_metadata, '$.world_info'), '')) VIRTUAL;
    CREATE INDEX idx_chats_world ON chats(world) WHERE world IS NOT NULL;
    `,
    // 20: media ids become non-reusable (AUTOINCREMENT), since the thumb cache is keyed on them; the possibly poisoned cache is dropped once
    (db, paths) => {
        db.exec(`
            CREATE TABLE media_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                char_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
                file TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'image',
                source_url TEXT,
                url_hash TEXT,
                size INTEGER,
                added_at INTEGER NOT NULL,
                content_hash TEXT,
                UNIQUE(char_id, display_name)
            );
            INSERT INTO media_new (id, char_id, file, display_name, kind, source_url, url_hash, size, added_at, content_hash)
                SELECT id, char_id, file, display_name, kind, source_url, url_hash, size, added_at, content_hash FROM media;
            DROP TABLE media;
            ALTER TABLE media_new RENAME TO media;
            CREATE INDEX idx_media_char ON media(char_id);
            CREATE UNIQUE INDEX idx_media_char_urlhash ON media(char_id, url_hash) WHERE url_hash IS NOT NULL;
            CREATE INDEX idx_media_content ON media(char_id, content_hash) WHERE content_hash IS NOT NULL;
        `);
        fs.rmSync(paths.mediaThumbsDir, { recursive: true, force: true });
    },
    // 21: personas become rows; the chatUserPersona string is carried over as the first, active persona
    (db) => {
        db.exec(`
            CREATE TABLE personas (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                avatar TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `);
        const read = key => {
            const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
            if (!row) return '';
            try { const v = JSON.parse(row.value); return typeof v === 'string' ? v : ''; } catch { return ''; }
        };
        const description = read('chatUserPersona').trim();
        if (!description) return;
        const now = Date.now();
        const id = crypto.randomUUID();
        const name = read('chatUserName').trim() || 'You';
        db.prepare('INSERT INTO personas (id, name, description, avatar, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)')
            .run(id, name, description, now, now);
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
            .run('activePersonaId', JSON.stringify(id));
        // a move, not a copy: the old key left behind would give the persona text two owners
        db.prepare('DELETE FROM settings WHERE key = ?').run('chatUserPersona');
    },
    // 22: prompt presets as rows; no row is seeded, the fallback is DEFAULT_BLOCKS in server/llm/preset.js
    `
    CREATE TABLE presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '{}',
        source TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE preset_blocks (
        id TEXT PRIMARY KEY,
        preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
        block_key TEXT,
        kind TEXT NOT NULL DEFAULT 'text',
        marker TEXT,
        content TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'system',
        position TEXT NOT NULL DEFAULT 'pre_history',
        depth INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        pos INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_preset_blocks_preset ON preset_blocks(preset_id, pos);
    `,

    // 23: preset blocks get a display name, backfilled (marker labels, title-cased keys)
    (db) => {
        db.exec('ALTER TABLE preset_blocks ADD COLUMN name TEXT');
        const LABEL = {
            charDescription: 'Character Description',
            charPersonality: 'Character Personality',
            scenario: 'Scenario',
            personaDescription: 'Persona Description',
            worldInfoBefore: 'Lore (before character)',
            worldInfoAfter: 'Lore (after character)',
            dialogueExamples: 'Dialogue Examples',
            chatHistory: 'Chat History',
        };
        const rows = db.prepare('SELECT id, block_key, marker FROM preset_blocks').all();
        const upd = db.prepare('UPDATE preset_blocks SET name = ? WHERE id = ?');
        const titleCase = (s) => String(s || '')
            .replace(/[_-]+/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase())
            .trim();
        for (const r of rows) {
            const name = LABEL[r.marker] || titleCase(r.block_key) || LABEL[r.marker] || 'Block';
            upd.run(name, r.id);
        }
    },

    // 24: the preset's params column goes: samplers belong to the connection (llm_profiles)
    (db) => {
        db.exec('ALTER TABLE presets DROP COLUMN params');
    },

    // 25: blocks anchored inside the history: injection_order (ST's default 100) and forbid_overrides
    (db) => {
        db.exec('ALTER TABLE preset_blocks ADD COLUMN injection_order INTEGER NOT NULL DEFAULT 100');
        db.exec('ALTER TABLE preset_blocks ADD COLUMN forbid_overrides INTEGER NOT NULL DEFAULT 0');
    },

    // 26: the last two card text fields as generated columns, VIRTUAL since SQLite cannot ADD a STORED one
    `
    ALTER TABLE characters ADD COLUMN post_history_instructions TEXT
        GENERATED ALWAYS AS (json_extract(card, '$.data.post_history_instructions')) VIRTUAL;
    ALTER TABLE characters ADD COLUMN depth_prompt TEXT
        GENERATED ALWAYS AS (json_extract(card, '$.data.extensions.depth_prompt.prompt')) VIRTUAL;
    `,

    // 27: the assistant's transcripts, a session a row and its messages a column (one writer, never queried across)
    `
    CREATE TABLE assistant_sessions (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        messages TEXT NOT NULL DEFAULT '[]',
        profile_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_assistant_sessions_chat ON assistant_sessions(chat_id, updated_at DESC);
    `,

    // 28: chat wallpapers: a flat library (AUTOINCREMENT ids) and bindings on two nullable FKs; a NULL background is a real "none"
    `
    CREATE TABLE backgrounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL UNIQUE,
        source_url TEXT,
        url_hash TEXT,
        content_hash TEXT,
        width INTEGER,
        height INTEGER,
        size INTEGER NOT NULL,
        added_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_backgrounds_url ON backgrounds(url_hash) WHERE url_hash IS NOT NULL;
    CREATE UNIQUE INDEX idx_backgrounds_hash ON backgrounds(content_hash) WHERE content_hash IS NOT NULL;

    CREATE TABLE background_bindings (
        id INTEGER PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('global', 'character', 'chat')),
        char_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
        chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
        background_id INTEGER REFERENCES backgrounds(id) ON DELETE CASCADE,
        fit TEXT NOT NULL DEFAULT 'cover'
            CHECK (fit IN ('cover', 'contain', 'stretch', 'center', 'tile')),
        opacity REAL NOT NULL DEFAULT 1 CHECK (opacity BETWEEN 0 AND 1),
        blur INTEGER NOT NULL DEFAULT 0 CHECK (blur BETWEEN 0 AND 40),
        brightness REAL NOT NULL DEFAULT 1 CHECK (brightness BETWEEN 0 AND 2),
        saturate REAL NOT NULL DEFAULT 1 CHECK (saturate BETWEEN 0 AND 2),
        render_width INTEGER CHECK (render_width IS NULL OR render_width IN (0, 768, 1280, 1920)),
        updated_at INTEGER NOT NULL,
        CHECK ((scope = 'global'    AND char_id IS NULL     AND chat_id IS NULL)
            OR (scope = 'character' AND char_id IS NOT NULL AND chat_id IS NULL)
            OR (scope = 'chat'      AND char_id IS NULL     AND chat_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX idx_bgbind_global ON background_bindings(scope) WHERE scope = 'global';
    CREATE UNIQUE INDEX idx_bgbind_char ON background_bindings(char_id) WHERE char_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_bgbind_chat ON background_bindings(chat_id) WHERE chat_id IS NOT NULL;
    CREATE INDEX idx_bgbind_background ON background_bindings(background_id) WHERE background_id IS NOT NULL;
    `,

    // 29: the prompt is bounded by tokens: chatHistoryLimit goes and a stored unlimited budget (0) becomes 8192
    (db) => {
        db.exec('ALTER TABLE llm_profiles ADD COLUMN context_size INTEGER;');
        db.prepare("DELETE FROM settings WHERE key = 'chatHistoryLimit'").run();

        const row = db.prepare("SELECT value FROM settings WHERE key = 'chatMaxContext'").get();
        if (row) {
            let n = null;
            try { n = Number(JSON.parse(row.value)); } catch { n = null; }
            if (!Number.isFinite(n) || n <= 0) {
                db.prepare("UPDATE settings SET value = ? WHERE key = 'chatMaxContext'").run(JSON.stringify(8192));
            }
        }
        // A stored reserve of 0 is left alone on purpose: holding nothing back for the
        // reply is a coherent choice, unlike an unlimited context.
    },

    // 30: a per-chat persona override as a nullable FK (ON DELETE SET NULL); ALTER may add it since its default is NULL
    `
    ALTER TABLE chats ADD COLUMN persona_id TEXT REFERENCES personas(id) ON DELETE SET NULL;
    CREATE INDEX idx_chats_persona ON chats(persona_id) WHERE persona_id IS NOT NULL;
    `,

    // 31: the fallback chatUserName goes: a name nobody chose is worse than an honest unresolved {{user}}
    `
    DELETE FROM settings WHERE key = 'chatUserName';
    `,

    // 32: content_hash, the H signal of the no-overwrite import triage; canonicalization cant be SQL, so a JS backfill
    (db) => {
        db.exec(`
            ALTER TABLE characters ADD COLUMN content_hash TEXT;
            CREATE INDEX idx_characters_content ON characters(content_hash);
        `);
        // the content hash as defined when this step landed (card-hash.js is the live one), frozen
        const canonical = (value) => {
            if (typeof value === 'object' && value !== null) {
                if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
                let body = '';
                for (const key of Object.keys(value).sort()) body += `${body ? ',' : ''}${JSON.stringify(key)}:${canonical(value[key])}`;
                return `{${body}}`;
            }
            const text = JSON.stringify(value);
            return text === undefined ? 'null' : text;
        };
        const contentHash = (card) => crypto.createHash('sha256').update(canonical(card)).digest('hex');
        const update = db.prepare('UPDATE characters SET content_hash = ? WHERE id = ?');
        for (const row of db.prepare('SELECT id, card FROM characters').all()) {
            try { update.run(contentHash(JSON.parse(row.card)), row.id); } catch { /* unparsable card: stays null, heals on next write */ }
        }
    },

    // 33: global and persona-bound lorebooks, both on the char_worlds shape
    `
    CREATE TABLE global_worlds (
        world_name TEXT PRIMARY KEY,
        pos INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;

    CREATE TABLE persona_worlds (
        persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        world_name TEXT NOT NULL,
        pos INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (persona_id, world_name)
    ) WITHOUT ROWID;
    CREATE INDEX idx_persona_worlds_world ON persona_worlds(world_name);
    `,

    // 34: a covering index for the grid's q-search, named by INDEXED BY so a planner regression is loud
    `
    CREATE INDEX idx_characters_q ON characters(name, nickname, creator, id);
    `,

    // 35: notes and tagline indexes; an expression index only matches its expression VERBATIM, bare of COALESCE
    `
    CREATE INDEX idx_characters_notes ON characters(creator_notes, id);
    CREATE INDEX idx_characters_tagline ON characters(json_extract(card, '$.data.extensions.cl.tagline'), id);
    CREATE INDEX idx_provider_links_tagline ON provider_links(json_extract(data, '$.tagline'), char_id);
    `,

    // 36: characters record layout restored (ALTER could only append, so columns had landed behind card), by the table rebuild recipe
    (db) => {
        // with FKs on, DROP TABLE cascades every child row away and every check still passes after: silent total loss, so refuse loudly
        if (db.pragma('foreign_keys', { simple: true })) {
            throw new Error('migration 36 refuses to rebuild characters: foreign_keys is ON, so DROP TABLE would cascade every child row away');
        }
        const columnsOf = (t) => db.pragma(`table_xinfo(${t})`).map(c => c.name).sort().join(',');
        // one number per stored column: a generated expression that came out even
        // slightly different would move its sum, which a row count alone would miss
        const fingerprint = (t) => db.prepare(`
            SELECT COUNT(*) AS rows, COALESCE(SUM(rowid), 0) AS rowids,
                   COALESCE(SUM(fav), 0) AS fav,
                   COALESCE(SUM(COALESCE(created_at, 0)), 0) AS created,
                   COALESCE(SUM(imported_at), 0) AS imported,
                   COALESCE(SUM(updated_at), 0) AS updated,
                   COALESCE(SUM(token_estimate), 0) AS tokens,
                   COALESCE(SUM(update_locked), 0) AS locked,
                   COUNT(content_hash) AS hashes,
                   COALESCE(SUM(LENGTH(card)), 0) AS card,
                   COALESCE(SUM(LENGTH(COALESCE(name, ''))), 0) AS gName,
                   COALESCE(SUM(LENGTH(COALESCE(creator, ''))), 0) AS gCreator,
                   COALESCE(SUM(LENGTH(COALESCE(nickname, ''))), 0) AS gNick,
                   COALESCE(SUM(LENGTH(COALESCE(character_version, ''))), 0) AS gVersion,
                   COALESCE(SUM(LENGTH(COALESCE(creator_notes, ''))), 0) AS gNotes
            FROM "${t}"`).get();

        const oldColumns = columnsOf('characters');
        const before = fingerprint('characters');
        const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'characters' AND sql IS NOT NULL").all();
        const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'characters'").all();

        db.exec(`
            CREATE TABLE characters_new (
                id TEXT PRIMARY KEY,
                name TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.name')) STORED,
                creator TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.creator')) STORED,
                nickname TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.nickname')) STORED,
                character_version TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.character_version')) STORED,
                fav INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER,
                imported_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                token_estimate INTEGER NOT NULL DEFAULT 0,
                update_locked INTEGER NOT NULL DEFAULT 0,
                content_hash TEXT,
                creator_notes TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.creator_notes')) STORED,
                card TEXT NOT NULL,
                description TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.description')) VIRTUAL,
                personality TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.personality')) VIRTUAL,
                scenario TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.scenario')) VIRTUAL,
                first_mes TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.first_mes')) VIRTUAL,
                mes_example TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.mes_example')) VIRTUAL,
                system_prompt TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.system_prompt')) VIRTUAL,
                alt_greetings INTEGER GENERATED ALWAYS AS (COALESCE(json_array_length(card, '$.data.alternate_greetings'), 0)) VIRTUAL,
                has_lorebook INTEGER GENERATED ALWAYS AS (json_extract(card, '$.data.character_book') IS NOT NULL) VIRTUAL,
                has_system_prompt INTEGER GENERATED ALWAYS AS (COALESCE(length(json_extract(card, '$.data.system_prompt')), 0) > 0) VIRTUAL,
                spec_version TEXT GENERATED ALWAYS AS (json_extract(card, '$.spec_version')) VIRTUAL,
                post_history_instructions TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.post_history_instructions')) VIRTUAL,
                depth_prompt TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.extensions.depth_prompt.prompt')) VIRTUAL
            );
        `);

        const newColumns = columnsOf('characters_new');
        if (newColumns !== oldColumns) {
            throw new Error(`migration 36 refuses to rebuild characters: column set drift.\n  stored: ${oldColumns}\n  rebuilt: ${newColumns}`);
        }

        db.exec(`
            INSERT INTO characters_new (rowid, id, fav, created_at, imported_at, updated_at,
                                        token_estimate, update_locked, content_hash, card)
                SELECT rowid, id, fav, created_at, imported_at, updated_at,
                       token_estimate, update_locked, content_hash, card
                FROM characters;
        `);

        const after = fingerprint('characters_new');
        for (const key of Object.keys(before)) {
            if (before[key] !== after[key]) {
                throw new Error(`migration 36 refuses to rebuild characters: ${key} changed in the copy (${before[key]} -> ${after[key]})`);
            }
        }

        // a wrong json path yields a column of nulls, not an error, and differs on nearly every row, so a sample settles it
        const generated = db.pragma('table_xinfo(characters)')
            .filter(c => c.hidden === 2 || c.hidden === 3).map(c => `"${c.name}"`);
        const sampleOf = (t) => JSON.stringify(db.prepare(
            `SELECT ${generated.join(', ')} FROM "${t}" ORDER BY id LIMIT 200`).all());
        if (sampleOf('characters') !== sampleOf('characters_new')) {
            throw new Error('migration 36 refuses to rebuild characters: a generated column resolves differently in the copy');
        }

        // explicit, so the rebuild never depends on whether DROP TABLE fires row triggers
        for (const t of triggers) db.exec(`DROP TRIGGER ${t.name};`);
        db.exec('DROP TABLE characters;');
        db.exec('ALTER TABLE characters_new RENAME TO characters;');
        for (const i of indexes) db.exec(`${i.sql};`);
        for (const t of triggers) db.exec(`${t.sql};`);
    },

    // 37: the creator studio's sessions, the assistant_sessions carve-out
    `
    CREATE TABLE studio_sessions (
        id TEXT PRIMARY KEY,
        char_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
        field_key TEXT NOT NULL,
        name TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'standard',
        content TEXT NOT NULL DEFAULT '',
        standard_messages TEXT NOT NULL DEFAULT '[]',
        brainstorm_messages TEXT NOT NULL DEFAULT '[]',
        profile_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_studio_sessions_char ON studio_sessions(char_id, updated_at DESC);
    `,

    // 38: one provider link per character as a schema rule; the index fails loudly on a home still holding two
    `
    CREATE UNIQUE INDEX idx_provider_links_one_per_char ON provider_links(char_id);
    `,

    // 39: created_at NOT NULL, media_localized and lore_dismissed as op-state columns, two CHECKs on card; a refused card stops the step by name
    (db) => {
        if (db.pragma('foreign_keys', { simple: true })) {
            throw new Error('migration 39 refuses to rebuild characters: foreign_keys is ON, so DROP TABLE would cascade every child row away');
        }
        const columnsOf = (t) => db.pragma(`table_xinfo(${t})`).map(c => c.name).sort().join(',');
        const fingerprint = (t) => db.prepare(`
            SELECT COUNT(*) AS rows, COALESCE(SUM(rowid), 0) AS rowids,
                   COALESCE(SUM(fav), 0) AS fav,
                   COALESCE(SUM(COALESCE(created_at, imported_at)), 0) AS created,
                   COALESCE(SUM(imported_at), 0) AS imported,
                   COALESCE(SUM(updated_at), 0) AS updated,
                   COALESCE(SUM(token_estimate), 0) AS tokens,
                   COALESCE(SUM(update_locked), 0) AS locked,
                   COUNT(content_hash) AS hashes,
                   COALESCE(SUM(LENGTH(card)), 0) AS card,
                   COALESCE(SUM(LENGTH(COALESCE(name, ''))), 0) AS gName,
                   COALESCE(SUM(LENGTH(COALESCE(creator, ''))), 0) AS gCreator,
                   COALESCE(SUM(LENGTH(COALESCE(nickname, ''))), 0) AS gNick,
                   COALESCE(SUM(LENGTH(COALESCE(character_version, ''))), 0) AS gVersion,
                   COALESCE(SUM(LENGTH(COALESCE(creator_notes, ''))), 0) AS gNotes
            FROM "${t}"`).get();

        const offenders = db.prepare(`
            SELECT id FROM characters
            WHERE json_valid(card) = 0 OR json_type(card, '$.data.name') IS NOT 'text' LIMIT 5`).all().map(r => r.id);
        if (offenders.length) {
            throw new Error(`migration 39 refuses to rebuild characters: card(s) would fail the new CHECKs (not valid JSON, or no text name): ${offenders.join(', ')}. Repair them first.`);
        }

        const oldColumns = columnsOf('characters');
        const before = fingerprint('characters');
        const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'characters' AND sql IS NOT NULL").all();
        const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'characters'").all();

        db.exec(`
            CREATE TABLE characters_new (
                id TEXT PRIMARY KEY,
                name TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.name')) STORED,
                creator TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.creator')) STORED,
                nickname TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.nickname')) STORED,
                character_version TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.character_version')) STORED,
                fav INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                imported_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                token_estimate INTEGER NOT NULL DEFAULT 0,
                update_locked INTEGER NOT NULL DEFAULT 0,
                media_localized INTEGER NOT NULL DEFAULT 0,
                lore_dismissed INTEGER NOT NULL DEFAULT 0,
                content_hash TEXT,
                creator_notes TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.creator_notes')) STORED,
                card TEXT NOT NULL
                    CHECK (json_valid(card))
                    CHECK (json_type(card, '$.data.name') IS 'text'),
                description TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.description')) VIRTUAL,
                personality TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.personality')) VIRTUAL,
                scenario TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.scenario')) VIRTUAL,
                first_mes TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.first_mes')) VIRTUAL,
                mes_example TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.mes_example')) VIRTUAL,
                system_prompt TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.system_prompt')) VIRTUAL,
                alt_greetings INTEGER GENERATED ALWAYS AS (COALESCE(json_array_length(card, '$.data.alternate_greetings'), 0)) VIRTUAL,
                has_lorebook INTEGER GENERATED ALWAYS AS (json_extract(card, '$.data.character_book') IS NOT NULL) VIRTUAL,
                has_system_prompt INTEGER GENERATED ALWAYS AS (COALESCE(length(json_extract(card, '$.data.system_prompt')), 0) > 0) VIRTUAL,
                spec_version TEXT GENERATED ALWAYS AS (json_extract(card, '$.spec_version')) VIRTUAL,
                post_history_instructions TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.post_history_instructions')) VIRTUAL,
                depth_prompt TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.extensions.depth_prompt.prompt')) VIRTUAL
            );
        `);

        const expectedColumns = [...oldColumns.split(','), 'media_localized', 'lore_dismissed'].sort().join(',');
        const newColumns = columnsOf('characters_new');
        if (newColumns !== expectedColumns) {
            throw new Error(`migration 39 refuses to rebuild characters: column set drift.\n  expected: ${expectedColumns}\n  rebuilt: ${newColumns}`);
        }

        db.exec(`
            INSERT INTO characters_new (rowid, id, fav, created_at, imported_at, updated_at,
                                        token_estimate, update_locked, content_hash, card)
                SELECT rowid, id, fav, COALESCE(created_at, imported_at), imported_at, updated_at,
                       token_estimate, update_locked, content_hash, card
                FROM characters;
        `);

        const after = fingerprint('characters_new');
        for (const key of Object.keys(before)) {
            if (before[key] !== after[key]) {
                throw new Error(`migration 39 refuses to rebuild characters: ${key} changed in the copy (${before[key]} -> ${after[key]})`);
            }
        }

        for (const t of triggers) db.exec(`DROP TRIGGER ${t.name};`);
        db.exec('DROP TABLE characters;');
        db.exec('ALTER TABLE characters_new RENAME TO characters;');
        for (const i of indexes) db.exec(`${i.sql};`);
        for (const t of triggers) db.exec(`${t.sql};`);
        db.exec(`
            CREATE INDEX idx_characters_media_localized ON characters(media_localized) WHERE media_localized = 1;
            CREATE INDEX idx_characters_lore_dismissed ON characters(lore_dismissed) WHERE lore_dismissed = 1;
        `);

        // both documents were {ids: [uuid]}; an id the library lost, or a torn document, lifts nothing
        const lift = (key, column) => {
            const row = db.prepare('SELECT value FROM app_store WHERE key = ?').get(key);
            if (!row) return;
            let ids = [];
            try {
                const doc = JSON.parse(row.value);
                if (Array.isArray(doc?.ids)) ids = doc.ids.filter(x => typeof x === 'string');
            } catch { /* a torn document lifts nothing */ }
            const set = db.prepare(`UPDATE characters SET ${column} = 1 WHERE id = ?`);
            for (const id of ids) set.run(id);
            db.prepare('DELETE FROM app_store WHERE key = ?').run(key);
        };
        lift('media-loc-completed', 'media_localized');
        lift('embedded-lore-dismissed', 'lore_dismissed');
    },

    // 40: the chat's lorebook binding leaves chat_metadata for chat_worlds; the head is composed back on read
    (db) => {
        db.exec(`
            CREATE TABLE chat_worlds (
                chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                world_name TEXT NOT NULL,
                pos INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (chat_id, world_name)
            ) WITHOUT ROWID;
            CREATE INDEX idx_chat_worlds_world ON chat_worlds(world_name);
            INSERT OR IGNORE INTO chat_worlds (chat_id, world_name, pos)
                SELECT id, trim(json_extract(chat_metadata, '$.world_info')), 0 FROM chats
                WHERE json_type(chat_metadata, '$.world_info') = 'text'
                  AND trim(json_extract(chat_metadata, '$.world_info')) != '';
            UPDATE chats SET chat_metadata = json_remove(chat_metadata, '$.world_info')
                WHERE json_type(chat_metadata, '$.world_info') IS NOT NULL;
            DROP INDEX IF EXISTS idx_chats_world;
            ALTER TABLE chats DROP COLUMN world;
        `);
    },

    // 41: the composer's unsent draft becomes a chat column, lifted from the chat-drafts document
    (db) => {
        db.exec('ALTER TABLE chats ADD COLUMN draft TEXT');
        const row = db.prepare("SELECT value FROM app_store WHERE key = 'chat-drafts'").get();
        if (row) {
            let drafts = null;
            try { drafts = JSON.parse(row.value)?.drafts; } catch { /* a torn document lifts nothing */ }
            if (drafts && typeof drafts === 'object' && !Array.isArray(drafts)) {
                const set = db.prepare('UPDATE chats SET draft = ? WHERE id = ?');
                for (const [id, text] of Object.entries(drafts)) {
                    if (typeof text === 'string' && text) set.run(text, id);
                }
            }
            db.prepare("DELETE FROM app_store WHERE key = 'chat-drafts'").run();
        }
    },

    // 42: no dangling anywhere: placeholder worlds, and every binding table rebuilt with its FK (SQLite cant add one in place)
    (db) => {
        if (db.pragma('foreign_keys', { simple: true })) {
            throw new Error('migration 42 refuses to rebuild the binding tables: foreign_keys is ON, so DROP TABLE would cascade rows away');
        }
        db.exec('ALTER TABLE worlds ADD COLUMN placeholder INTEGER NOT NULL DEFAULT 0');
        const now = Date.now();
        const tables = ['char_worlds', 'chat_worlds', 'persona_worlds', 'global_worlds'];
        for (const table of tables) {
            db.prepare(`INSERT OR IGNORE INTO worlds (name, data, entry_count, imported_at, updated_at, placeholder)
                SELECT DISTINCT b.world_name, '{}', 0, NULL, ?, 1 FROM ${table} b
                WHERE NOT EXISTS (SELECT 1 FROM worlds w WHERE w.name = b.world_name)`).run(now);
        }
        const FK = 'TEXT NOT NULL REFERENCES worlds(name) ON DELETE CASCADE ON UPDATE CASCADE';
        const rebuild = (table, columns, keyDdl, indexSql) => {
            db.exec(`
                CREATE TABLE ${table}_new (
                    ${keyDdl}
                    world_name ${FK},
                    pos INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (${columns.join(', ')})
                ) WITHOUT ROWID;
                INSERT INTO ${table}_new (${columns.join(', ')}, pos) SELECT ${columns.join(', ')}, pos FROM ${table};
                DROP TABLE ${table};
                ALTER TABLE ${table}_new RENAME TO ${table};
                ${indexSql}
            `);
        };
        rebuild('char_worlds', ['char_id', 'world_name'], 'char_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,', 'CREATE INDEX idx_aux_worlds_world ON char_worlds(world_name);');
        rebuild('chat_worlds', ['chat_id', 'world_name'], 'chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,', 'CREATE INDEX idx_chat_worlds_world ON chat_worlds(world_name);');
        rebuild('persona_worlds', ['persona_id', 'world_name'], 'persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,', 'CREATE INDEX idx_persona_worlds_world ON persona_worlds(world_name);');
        rebuild('global_worlds', ['world_name'], '', '');
        const bad = db.prepare('PRAGMA foreign_key_check').all().filter(r => tables.includes(r.table));
        if (bad.length) {
            throw new Error(`migration 42: ${bad.length} binding rows still violate their FK after the placeholder mint; nothing was committed`);
        }
    },

    // 43: every stored blob is JSON by CHECK (SQLite cant add one in place, so rebuilds); an offending blob stops the step by name
    (db) => {
        if (db.pragma('foreign_keys', { simple: true })) {
            throw new Error('migration 43 refuses to rebuild the blob tables: foreign_keys is ON, so DROP TABLE would cascade rows away');
        }
        const offenders = [
            ...db.prepare("SELECT 'world_entries ' || world_name || '#' || uid AS k FROM world_entries WHERE json_valid(data) = 0 LIMIT 3").all(),
            ...db.prepare("SELECT 'app_store ' || key AS k FROM app_store WHERE json_valid(value) = 0 LIMIT 3").all(),
            ...db.prepare("SELECT 'chat_messages ' || chat_id || '#' || seq AS k FROM chat_messages WHERE json_valid(data) = 0 LIMIT 3").all(),
        ].map(r => r.k);
        if (offenders.length) {
            throw new Error(`migration 43 refuses to rebuild the blob tables: stored blob(s) would fail the new CHECK (not valid JSON): ${offenders.join(', ')}`);
        }
        const snapshot = (table) => ({
            indexes: db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table),
            triggers: db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?").all(table),
        });
        const swap = (table, { indexes, triggers }) => {
            // explicit, so the rebuild never depends on whether DROP TABLE fires row triggers
            for (const t of triggers) db.exec(`DROP TRIGGER ${t.name};`);
            db.exec(`DROP TABLE ${table};`);
            db.exec(`ALTER TABLE ${table}_new RENAME TO ${table};`);
            for (const i of indexes) db.exec(`${i.sql};`);
            for (const t of triggers) db.exec(`${t.sql};`);
        };
        const same = (label, before, after) => {
            for (const key of Object.keys(before)) {
                if (before[key] !== after[key]) throw new Error(`migration 43 refuses to rebuild ${label}: ${key} changed in the copy (${before[key]} -> ${after[key]})`);
            }
        };

        // world_entries: WITHOUT ROWID, two generated columns the panels read
        const weFp = (t) => db.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(uid), 0) AS uids, COALESCE(SUM(LENGTH(data)), 0) AS bytes,
            COALESCE(SUM(LENGTH(COALESCE(comment, ''))), 0) AS gComment, COALESCE(SUM(enabled), 0) AS gEnabled FROM "${t}"`).get();
        const weBefore = weFp('world_entries');
        const weShape = snapshot('world_entries');
        db.exec(`
            CREATE TABLE world_entries_new (
                world_name TEXT NOT NULL REFERENCES worlds(name) ON DELETE CASCADE ON UPDATE CASCADE,
                uid INTEGER NOT NULL,
                data TEXT NOT NULL CHECK (json_valid(data)),
                comment TEXT GENERATED ALWAYS AS (json_extract(data, '$.comment')) VIRTUAL,
                enabled INTEGER GENERATED ALWAYS AS (CASE WHEN json_extract(data, '$.disable') THEN 0 ELSE 1 END) VIRTUAL,
                PRIMARY KEY (world_name, uid)
            ) WITHOUT ROWID;
            INSERT INTO world_entries_new (world_name, uid, data) SELECT world_name, uid, data FROM world_entries;
        `);
        same('world_entries', weBefore, weFp('world_entries_new'));
        swap('world_entries', weShape);

        // app_store: the generic document store
        const asFp = (t) => db.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(value)), 0) AS bytes, COALESCE(SUM(updated_at), 0) AS updated FROM "${t}"`).get();
        const asBefore = asFp('app_store');
        const asShape = snapshot('app_store');
        db.exec(`
            CREATE TABLE app_store_new (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL CHECK (json_valid(value)),
                updated_at INTEGER NOT NULL
            );
            INSERT INTO app_store_new (key, value, updated_at) SELECT key, value, updated_at FROM app_store;
        `);
        same('app_store', asBefore, asFp('app_store_new'));
        swap('app_store', asShape);

        // chat_messages is a rowid table the FTS external content keys on: rowids carried by hand, the index rebuilt behind it
        const cmFp = (t) => db.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(rowid), 0) AS rowids, COALESCE(SUM(seq), 0) AS seqs,
            COALESCE(SUM(LENGTH(data)), 0) AS bytes, COALESCE(SUM(LENGTH(COALESCE(mes, ''))), 0) AS gMes,
            COALESCE(SUM(is_user), 0) AS gUser, COALESCE(SUM(is_system), 0) AS gSystem FROM "${t}"`).get();
        const cmBefore = cmFp('chat_messages');
        const cmShape = snapshot('chat_messages');
        db.exec(`
            CREATE TABLE chat_messages_new (
                chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                data TEXT NOT NULL CHECK (json_valid(data)),
                mes TEXT GENERATED ALWAYS AS (json_extract(data, '$.mes')) VIRTUAL,
                is_user INTEGER GENERATED ALWAYS AS (CASE WHEN json_extract(data, '$.is_user') THEN 1 ELSE 0 END) VIRTUAL,
                is_system INTEGER GENERATED ALWAYS AS (CASE WHEN json_extract(data, '$.is_system') THEN 1 ELSE 0 END) VIRTUAL,
                PRIMARY KEY (chat_id, seq)
            );
            INSERT INTO chat_messages_new (rowid, chat_id, seq, data) SELECT rowid, chat_id, seq, data FROM chat_messages;
        `);
        same('chat_messages', cmBefore, cmFp('chat_messages_new'));
        swap('chat_messages', cmShape);
        db.exec("INSERT INTO chat_messages_fts(chat_messages_fts) VALUES ('rebuild');");
    },

    // 44: the bulk tag-run undo journal becomes rows, the newest three kept; pre-uuid entries lift nothing
    (db) => {
        db.exec(`
            CREATE TABLE tag_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                label TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('ops', 'carriers')),
                ops TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(ops))
            );
            CREATE TABLE tag_run_entries (
                run_id INTEGER NOT NULL REFERENCES tag_runs(id) ON DELETE CASCADE,
                char_id TEXT NOT NULL,
                before TEXT NOT NULL CHECK (json_valid(before)),
                PRIMARY KEY (run_id, char_id)
            ) WITHOUT ROWID;
        `);
        const row = db.prepare("SELECT value FROM app_store WHERE key = 'tag-run-journal'").get();
        if (row) {
            let runs = [];
            try { const doc = JSON.parse(row.value); if (Array.isArray(doc?.runs)) runs = doc.runs; } catch { /* a torn document lifts nothing */ }
            const insRun = db.prepare('INSERT INTO tag_runs (ts, label, kind, ops) VALUES (?, ?, ?, ?)');
            const insEntry = db.prepare('INSERT OR REPLACE INTO tag_run_entries (run_id, char_id, before) VALUES (?, ?, ?)');
            for (const run of runs.slice(-3)) {
                if (!run || typeof run !== 'object') continue;
                const ts = Date.parse(run.ts) || Date.now();
                const label = typeof run.label === 'string' && run.label ? run.label : 'bulk run';
                if (Array.isArray(run.ops)) {
                    insRun.run(ts, label, 'ops', JSON.stringify(run.ops));
                } else if (Array.isArray(run.entries)) {
                    const id = insRun.run(ts, label, 'carriers', '[]').lastInsertRowid;
                    let usable = 0;
                    for (const e of run.entries) {
                        if (typeof e?.charId !== 'string' || !e.charId) continue;
                        insEntry.run(id, e.charId, JSON.stringify(Array.isArray(e.before) ? e.before : []));
                        usable++;
                    }
                    // a run whose entries were all pre-uuid has nothing to restore: no row
                    if (!usable) db.prepare('DELETE FROM tag_runs WHERE id = ?').run(id);
                }
            }
            db.prepare("DELETE FROM app_store WHERE key = 'tag-run-journal'").run();
        }
    },

    // 45: the media download queue becomes rows, one job per character cascading with it
    (db) => {
        db.exec(`
            CREATE TABLE media_jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                char_id TEXT NOT NULL UNIQUE REFERENCES characters(id) ON DELETE CASCADE,
                name TEXT NOT NULL DEFAULT '',
                phases TEXT CHECK (phases IS NULL OR json_valid(phases)),
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
                added_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `);
        const row = db.prepare("SELECT value FROM app_store WHERE key = 'media-dl-queue'").get();
        if (row) {
            let jobs = [];
            try { const doc = JSON.parse(row.value); if (doc?.version === 2 && Array.isArray(doc.jobs)) jobs = doc.jobs; } catch { /* torn: nothing to resume */ }
            const exists = db.prepare('SELECT 1 FROM characters WHERE id = ?');
            const ins = db.prepare('INSERT OR IGNORE INTO media_jobs (char_id, name, phases, status, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
            const now = Date.now();
            for (const j of jobs) {
                const charId = typeof j?.charId === 'string' ? j.charId : '';
                if (!charId || /\.png$/i.test(charId) || !exists.get(charId)) continue;
                ins.run(charId, typeof j.name === 'string' ? j.name : charId, Array.isArray(j.phases) ? JSON.stringify(j.phases) : null, 'pending', now, now);
            }
            db.prepare("DELETE FROM app_store WHERE key = 'media-dl-queue'").run();
        }
    },
    // 46: message_count and last_mes become trigger-owned (last_mes_at stays the store's: send_date needs the JS parser), plus the chat sort indexes
    (db) => {
        db.exec(`
            CREATE INDEX idx_chats_char_last ON chats(char_id, last_mes_at);
            CREATE INDEX idx_chats_name ON chats(name COLLATE NOCASE);
            CREATE INDEX idx_chats_count ON chats(message_count);
            CREATE INDEX idx_chats_created ON chats(create_date);
            UPDATE chats SET
                message_count = (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = chats.id),
                last_mes = (${CHAT_LAST_MES_SQL('chats.id')});
            ${CHAT_COUNTER_TRIGGERS_SQL}
        `);
    },
    // 47: gallery_id alias rows purged; nothing reads them after an ST finalize
    `DELETE FROM char_aliases WHERE kind = 'gallery_id';`,
    // 48: the link probe's path arm, full_path case-insensitively
    `CREATE INDEX idx_provider_links_path ON provider_links(provider_id, full_path COLLATE NOCASE);`,
    // 49: the name probe's listing arm, page_name case-insensitively
    `CREATE INDEX idx_provider_links_page_name ON provider_links(page_name COLLATE NOCASE);`,
    // 50: the hosted browser's mode and endpoint leave the janitorai keys, a move per home
    (db) => {
        const move = db.prepare('INSERT OR IGNORE INTO settings (key, value) SELECT ?, value FROM settings WHERE key = ?');
        move.run('browserMode', 'janitoraiBrowserMode');
        move.run('browserEndpoint', 'janitoraiBrowserEndpoint');
        db.prepare("DELETE FROM settings WHERE key IN ('janitoraiBrowserMode', 'janitoraiBrowserEndpoint')").run();
    },
    // 51: chat sort keys as columns (sort_at, never NULL), and chat_count/last_chat_at on characters by a rebuild that keeps them ahead of card
    (db) => {
        if (db.pragma('foreign_keys', { simple: true })) {
            throw new Error('migration 51 refuses to rebuild characters: foreign_keys is ON, so DROP TABLE would cascade every child row away');
        }
        db.exec(`
            UPDATE chats SET create_date = updated_at WHERE create_date IS NULL;
            ALTER TABLE chats ADD COLUMN sort_at INTEGER GENERATED ALWAYS AS (COALESCE(last_mes_at, create_date, updated_at)) VIRTUAL;
            DROP INDEX idx_chats_char_last;
            CREATE INDEX idx_chats_sort ON chats(sort_at);
            CREATE INDEX idx_chats_char_sort ON chats(char_id, sort_at);
            CREATE INDEX idx_chats_char_name ON chats(char_id, name COLLATE NOCASE);
            CREATE INDEX idx_chats_char_count ON chats(char_id, message_count);
            CREATE INDEX idx_chats_char_created ON chats(char_id, create_date);
        `);

        const columnsOf = (t) => db.pragma(`table_xinfo(${t})`).map(c => c.name).sort().join(',');
        const fingerprint = (t) => db.prepare(`
            SELECT COUNT(*) AS rows, COALESCE(SUM(rowid), 0) AS rowids,
                   COALESCE(SUM(fav), 0) AS fav,
                   COALESCE(SUM(created_at), 0) AS created,
                   COALESCE(SUM(imported_at), 0) AS imported,
                   COALESCE(SUM(updated_at), 0) AS updated,
                   COALESCE(SUM(token_estimate), 0) AS tokens,
                   COALESCE(SUM(update_locked), 0) AS locked,
                   COALESCE(SUM(media_localized), 0) AS localized,
                   COALESCE(SUM(lore_dismissed), 0) AS dismissed,
                   COUNT(content_hash) AS hashes,
                   COALESCE(SUM(LENGTH(card)), 0) AS card,
                   COALESCE(SUM(LENGTH(COALESCE(name, ''))), 0) AS gName,
                   COALESCE(SUM(LENGTH(COALESCE(creator, ''))), 0) AS gCreator,
                   COALESCE(SUM(LENGTH(COALESCE(nickname, ''))), 0) AS gNick,
                   COALESCE(SUM(LENGTH(COALESCE(character_version, ''))), 0) AS gVersion,
                   COALESCE(SUM(LENGTH(COALESCE(creator_notes, ''))), 0) AS gNotes
            FROM "${t}"`).get();

        const oldColumns = columnsOf('characters');
        const before = fingerprint('characters');
        const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'characters' AND sql IS NOT NULL").all();
        const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'characters'").all();

        db.exec(`
            CREATE TABLE characters_new (
                id TEXT PRIMARY KEY,
                name TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.name')) STORED,
                creator TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.creator')) STORED,
                nickname TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.nickname')) STORED,
                character_version TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.character_version')) STORED,
                fav INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                imported_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                token_estimate INTEGER NOT NULL DEFAULT 0,
                update_locked INTEGER NOT NULL DEFAULT 0,
                media_localized INTEGER NOT NULL DEFAULT 0,
                lore_dismissed INTEGER NOT NULL DEFAULT 0,
                content_hash TEXT,
                chat_count INTEGER NOT NULL DEFAULT 0,
                last_chat_at INTEGER,
                creator_notes TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.creator_notes')) STORED,
                card TEXT NOT NULL
                    CHECK (json_valid(card))
                    CHECK (json_type(card, '$.data.name') IS 'text'),
                description TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.description')) VIRTUAL,
                personality TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.personality')) VIRTUAL,
                scenario TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.scenario')) VIRTUAL,
                first_mes TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.first_mes')) VIRTUAL,
                mes_example TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.mes_example')) VIRTUAL,
                system_prompt TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.system_prompt')) VIRTUAL,
                alt_greetings INTEGER GENERATED ALWAYS AS (COALESCE(json_array_length(card, '$.data.alternate_greetings'), 0)) VIRTUAL,
                has_lorebook INTEGER GENERATED ALWAYS AS (json_extract(card, '$.data.character_book') IS NOT NULL) VIRTUAL,
                has_system_prompt INTEGER GENERATED ALWAYS AS (COALESCE(length(json_extract(card, '$.data.system_prompt')), 0) > 0) VIRTUAL,
                spec_version TEXT GENERATED ALWAYS AS (json_extract(card, '$.spec_version')) VIRTUAL,
                post_history_instructions TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.post_history_instructions')) VIRTUAL,
                depth_prompt TEXT GENERATED ALWAYS AS (json_extract(card, '$.data.extensions.depth_prompt.prompt')) VIRTUAL
            );
        `);

        const expectedColumns = [...oldColumns.split(','), 'chat_count', 'last_chat_at'].sort().join(',');
        const newColumns = columnsOf('characters_new');
        if (newColumns !== expectedColumns) {
            throw new Error(`migration 51 refuses to rebuild characters: column set drift.\n  expected: ${expectedColumns}\n  rebuilt: ${newColumns}`);
        }

        db.exec(`
            INSERT INTO characters_new (rowid, id, fav, created_at, imported_at, updated_at,
                                        token_estimate, update_locked, media_localized, lore_dismissed,
                                        content_hash, chat_count, last_chat_at, card)
                SELECT rowid, id, fav, created_at, imported_at, updated_at,
                       token_estimate, update_locked, media_localized, lore_dismissed, content_hash,
                       (SELECT COUNT(*) FROM chats ch WHERE ch.char_id = characters.id),
                       (SELECT MAX(ch.sort_at) FROM chats ch WHERE ch.char_id = characters.id),
                       card
                FROM characters;
        `);

        const after = fingerprint('characters_new');
        for (const key of Object.keys(before)) {
            if (before[key] !== after[key]) {
                throw new Error(`migration 51 refuses to rebuild characters: ${key} changed in the copy (${before[key]} -> ${after[key]})`);
            }
        }

        for (const t of triggers) db.exec(`DROP TRIGGER ${t.name};`);
        db.exec('DROP TABLE characters;');
        db.exec('ALTER TABLE characters_new RENAME TO characters;');
        for (const i of indexes) db.exec(`${i.sql};`);
        for (const t of triggers) db.exec(`${t.sql};`);
        db.exec(`
            CREATE INDEX idx_characters_chat_count ON characters(chat_count, last_chat_at);
            CREATE INDEX idx_characters_last_chat ON characters(last_chat_at);
            CREATE INDEX idx_characters_name_recent ON characters(name COLLATE NOCASE, last_chat_at DESC);
            ${CHAR_CHAT_TRIGGERS_SQL}
        `);
    },
    // 52: worlds.created_at, the first write's stamp, backfilled from the import stamp else the write stamp
    `
    ALTER TABLE worlds ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
    UPDATE worlds SET created_at = COALESCE(imported_at, updated_at);
    `,
    // 53: mes is the active alternate on every stored message (mes wins, as in ST); the rule frozen here
    (db) => {
        const update = db.prepare('UPDATE chat_messages SET data = ? WHERE chat_id = ? AND seq = ?');
        for (const r of db.prepare("SELECT chat_id, seq, data FROM chat_messages WHERE json_type(data, '$.swipes') = 'array' AND json_array_length(data, '$.swipes') > 0").all()) {
            let m; try { m = JSON.parse(r.data); } catch { continue; }
            const i = Math.min(Math.max(Number.isInteger(m.swipe_id) ? m.swipe_id : 0, 0), m.swipes.length - 1);
            const mes = typeof m.mes === 'string' ? m.mes : '';
            if (m.swipes[i] === mes) continue;
            m.swipes[i] = mes;
            update.run(JSON.stringify(m), r.chat_id, r.seq);
        }
    },
    // 54: the studio is one conversation over the whole draft: the table dropped and recreated, messages with no JSON CHECK on purpose
    `
    DROP TABLE studio_sessions;
    CREATE TABLE studio_sessions (
        id TEXT PRIMARY KEY,
        char_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        draft TEXT NOT NULL DEFAULT '{}',
        messages TEXT NOT NULL DEFAULT '[]',
        profile_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_studio_sessions_char ON studio_sessions(char_id, updated_at DESC);
    `,
    // 55: every window's place and size in one windowGeometry row ({w, h, x, y} in percent), folded from the per-window keys
    (db) => {
        const read = (key) => {
            const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
            if (!row) return undefined;
            try { return JSON.parse(row.value); } catch { return undefined; }
        };
        const stored = read('windowGeometry');
        const map = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
        const panels = ['chatPromptPanel', 'chatConnPanel', 'chatLorePanel', 'chatGalleryPanel', 'chatCombinePanel', 'chatBgPanel',
            'chatPersonasPanel', 'chatExtensionsPanel', 'chatSettingsPanel', 'chatInspectPanel', 'chatAssistPanel'];
        const sources = [
            ...panels.map(p => [p, { w: `${p}W`, h: `${p}H`, x: `${p}X`, y: `${p}Y` }]),
            ['chatConversation', { w: 'chatColumnPct', h: 'chatWindowHeightPct', x: 'chatWindowXPct', y: 'chatWindowYPct' }],
            ['creatorStudio:seam', { w: 'creatorStudioPct' }],
        ];
        const gone = [];
        for (const [key, rows] of sources) {
            const g = {};
            for (const [axis, settingKey] of Object.entries(rows)) {
                gone.push(settingKey);
                const raw = read(settingKey);
                if (raw === undefined || raw === null || raw === '') continue;
                const v = Number(raw);
                if (Number.isFinite(v)) g[axis] = Math.round(v);
            }
            if (Object.keys(g).length && !(key in map)) map[key] = g;
        }
        if (Object.keys(map).length) {
            db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('windowGeometry', JSON.stringify(map));
        }
        db.prepare(`DELETE FROM settings WHERE key IN (${gone.map(() => '?').join(', ')})`).run(...gone);
    },
    // 56: the retired creator-prompts document goes
    (db) => {
        db.prepare("DELETE FROM app_store WHERE key = 'creator-prompts'").run();
    },
    // 57: a covering (id, name) index: name is STORED but shares the card's row, so id-to-name joins read the index
    `CREATE INDEX idx_characters_id_name ON characters(id, name);`,
    // 58: data.avatar out of stored cards, hashed by the definition of the day, frozen
    (db) => {
        const canonical = (value) => {
            if (typeof value === 'object' && value !== null) {
                if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
                let body = '';
                for (const key of Object.keys(value).sort()) body += `${body ? ',' : ''}${JSON.stringify(key)}:${canonical(value[key])}`;
                return `{${body}}`;
            }
            const text = JSON.stringify(value);
            return text === undefined ? 'null' : text;
        };
        const contentHash = (card) => crypto.createHash('sha256').update(canonical(card)).digest('hex');
        const update = db.prepare('UPDATE characters SET card = ?, content_hash = ? WHERE id = ?');
        for (const row of db.prepare("SELECT id, card FROM characters WHERE json_type(card, '$.data.avatar') IS NOT NULL").all()) {
            let card;
            try { card = JSON.parse(row.card); } catch { continue; }
            delete card.data.avatar;
            update.run(JSON.stringify(card), contentHash(card), row.id);
        }
    },
    // 59: world_sources, where a shelf book came from, its FK following a rename and a delete
    `
    CREATE TABLE world_sources (
        world_name TEXT PRIMARY KEY REFERENCES worlds(name) ON DELETE CASCADE ON UPDATE CASCADE,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        path TEXT,
        url TEXT,
        linked_at INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX idx_world_sources_key ON world_sources(provider, external_id);
    `,
    // 60: the world probe also matches a path case-insensitively
    `CREATE INDEX idx_world_sources_path ON world_sources(provider, path COLLATE NOCASE);`,
    // 61: ext_migrations records which extension entries ran here, and the source each ran with
    `
    CREATE TABLE ext_migrations (
        ext_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        sha TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        PRIMARY KEY (ext_id, idx)
    ) WITHOUT ROWID;
    `,
    // 62: a name is one line: stored names with breaks or tabs fold, hashed by the definition of the day
    (db) => {
        const canonical = (value) => {
            if (typeof value === 'object' && value !== null) {
                if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
                let body = '';
                for (const key of Object.keys(value).sort()) body += `${body ? ',' : ''}${JSON.stringify(key)}:${canonical(value[key])}`;
                return `{${body}}`;
            }
            const text = JSON.stringify(value);
            return text === undefined ? 'null' : text;
        };
        const contentHash = (card) => crypto.createHash('sha256').update(canonical(card)).digest('hex');
        const update = db.prepare('UPDATE characters SET card = ?, content_hash = ? WHERE id = ?');
        const broken = "name LIKE '%' || char(10) || '%' OR name LIKE '%' || char(13) || '%' OR name LIKE '%' || char(9) || '%'";
        for (const row of db.prepare(`SELECT id, card FROM characters WHERE ${broken}`).all()) {
            let card;
            try { card = JSON.parse(row.card); } catch { continue; }
            if (typeof card?.data?.name !== 'string') continue;
            card.data.name = card.data.name.replace(/\s*[\r\n\t\u2028\u2029]\s*/g, ' ').trim();
            update.run(JSON.stringify(card), contentHash(card), row.id);
        }
    },
    // 63: one placeholder setting: lorebookShowPlaceholders folds into loreShowPlaceholders
    (db) => {
        const read = (key) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key); if (!r) return undefined; try { return JSON.parse(r.value); } catch { return undefined; } };
        if (read('lorebookShowPlaceholders') === true && read('loreShowPlaceholders') !== true) {
            db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('loreShowPlaceholders', 'true')").run();
        }
        db.prepare("DELETE FROM settings WHERE key = 'lorebookShowPlaceholders'").run();
    },
    // 64: the funnels' full name fold (breaks and the spaces around them) over every stored name; one folding to nothing stays
    (db) => {
        const canonical = (value) => {
            if (typeof value === 'object' && value !== null) {
                if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
                let body = '';
                for (const key of Object.keys(value).sort()) body += `${body ? ',' : ''}${JSON.stringify(key)}:${canonical(value[key])}`;
                return `{${body}}`;
            }
            const text = JSON.stringify(value);
            return text === undefined ? 'null' : text;
        };
        const contentHash = (card) => crypto.createHash('sha256').update(canonical(card)).digest('hex');
        const fold = (name) => name.replace(/\s*[\r\n\t\u2028\u2029]\s*/g, ' ').trim();
        const read = db.prepare('SELECT card FROM characters WHERE id = ?');
        const update = db.prepare('UPDATE characters SET card = ?, content_hash = ? WHERE id = ?');
        // the names alone are read, so only the cards that change are parsed
        const changed = db.prepare('SELECT id, name FROM characters').all()
            .filter(r => typeof r.name === 'string' && fold(r.name) !== r.name && fold(r.name) !== '');
        for (const { id } of changed) {
            let card;
            try { card = JSON.parse(read.get(id).card); } catch { continue; }
            card.data.name = fold(card.data.name);
            update.run(JSON.stringify(card), contentHash(card), id);
        }
    },
    // 65: the notes answer from characters_fts, so the whole-text notes index goes
    'DROP INDEX IF EXISTS idx_characters_notes',
    // 66: a playlist's members page in order by a seek, never a sort
    'CREATE INDEX IF NOT EXISTS idx_playlist_chars_pos ON playlist_chars(playlist_id, pos)',
    // 67: a partial favourites index per core sort, so a favourites-only page walks its own order
    `CREATE INDEX IF NOT EXISTS idx_characters_fav_name ON characters(name COLLATE NOCASE) WHERE fav = 1;
     CREATE INDEX IF NOT EXISTS idx_characters_fav_created ON characters(created_at) WHERE fav = 1;
     CREATE INDEX IF NOT EXISTS idx_characters_fav_imported ON characters(imported_at) WHERE fav = 1;
     CREATE INDEX IF NOT EXISTS idx_characters_fav_updated ON characters(updated_at) WHERE fav = 1;
     CREATE INDEX IF NOT EXISTS idx_characters_fav_tokens ON characters(token_estimate) WHERE fav = 1;`,
    // 68: the page_name index carries char_id, so the listing arm's substring scan reads the index alone
    `DROP INDEX IF EXISTS idx_provider_links_page_name;
     CREATE INDEX idx_provider_links_page_name ON provider_links(page_name COLLATE NOCASE, char_id);`,
    // 69: (name, id) so an extension sort's unvalued walk reads no character row
    'CREATE INDEX IF NOT EXISTS idx_characters_name_id ON characters(name COLLATE NOCASE, id)',
    // 70: tag jobs journal links as rows (kind links, the tag kept by name); tag_runs rebuilt for the CHECK, its AUTOINCREMENT mark kept
    (db) => {
        if (db.pragma('foreign_keys', { simple: true })) {
            throw new Error('migration 70 refuses to rebuild tag_runs: foreign_keys is ON, so DROP TABLE would cascade the run entries away');
        }
        const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'tag_runs'").get()?.seq ?? null;
        db.exec(`
            CREATE TABLE tag_runs_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                label TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('ops', 'carriers', 'links')),
                ops TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(ops))
            );
            INSERT INTO tag_runs_new (id, ts, label, kind, ops) SELECT id, ts, label, kind, ops FROM tag_runs;
            DROP TABLE tag_runs;
            ALTER TABLE tag_runs_new RENAME TO tag_runs;
            CREATE TABLE tag_run_links (
                run_id INTEGER NOT NULL REFERENCES tag_runs(id) ON DELETE CASCADE,
                char_id TEXT NOT NULL,
                tag TEXT NOT NULL,
                added INTEGER NOT NULL CHECK (added IN (0, 1)),
                PRIMARY KEY (run_id, char_id, tag)
            ) WITHOUT ROWID;
        `);
        if (seq !== null) {
            db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('tag_runs', 'tag_runs_new')").run();
            db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('tag_runs', ?)").run(seq);
        }
    },
    // 71: a removed link keeps the place it held, so an undo puts it back there
    'ALTER TABLE tag_run_links ADD COLUMN pos INTEGER',
    // 72: namePreferences keyed by the character uuid alone: {uuid}.png keys fold to the bare uuid (a bare key already there wins)
    (db) => {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'namePreferences'").get();
        let prefs = null;
        try { prefs = row ? JSON.parse(row.value) : null; } catch { prefs = null; }
        if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return;
        const old = (k) => /\.png$/i.test(k);
        if (!Object.keys(prefs).some(old)) return;
        const folded = {};
        for (const [k, v] of Object.entries(prefs)) if (!old(k)) folded[k] = v;
        for (const [k, v] of Object.entries(prefs)) {
            const bare = k.replace(/\.png$/i, '');
            if (old(k) && !Object.hasOwn(folded, bare)) folded[bare] = v;
        }
        db.prepare("UPDATE settings SET value = ? WHERE key = 'namePreferences'").run(JSON.stringify(folded));
    },

    // 73: a snapshot id is handed out once per character (version_seq), seeded from the ids held
    (db) => {
        db.exec(`
            CREATE TABLE version_seq (
                char_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
                last INTEGER NOT NULL
            ) WITHOUT ROWID;
            INSERT INTO version_seq (char_id, last)
                SELECT char_id, MAX(snap_id) FROM versions WHERE snap_id >= 0 AND typeof(snap_id) = 'integer' GROUP BY char_id;
        `);
    },

    // 74: a message gets an id of its own, the rowid named and AUTOINCREMENT; (chat_id, seq) stays UNIQUE, rowids kept for FTS
    (db) => {
        if (db.pragma('foreign_keys', { simple: true })) {
            throw new Error('migration 74 refuses to rebuild chat_messages: foreign_keys is ON, so DROP TABLE would cascade rows away');
        }
        // octet_length reads a row's size off its header, never its text, so the fingerprint parses nothing
        const fp = (t) => db.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(rowid), 0) AS rowids, COALESCE(SUM(seq), 0) AS seqs,
            COALESCE(SUM(octet_length(data)), 0) AS bytes FROM "${t}"`).get();
        const before = fp('chat_messages');
        const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chat_messages' AND sql IS NOT NULL").all();
        const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'chat_messages'").all();
        db.exec(`
            CREATE TABLE chat_messages_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                data TEXT NOT NULL CHECK (json_valid(data)),
                mes TEXT GENERATED ALWAYS AS (json_extract(data, '$.mes')) VIRTUAL,
                is_user INTEGER GENERATED ALWAYS AS (CASE WHEN json_extract(data, '$.is_user') THEN 1 ELSE 0 END) VIRTUAL,
                is_system INTEGER GENERATED ALWAYS AS (CASE WHEN json_extract(data, '$.is_system') THEN 1 ELSE 0 END) VIRTUAL,
                UNIQUE (chat_id, seq)
            );
            INSERT INTO chat_messages_new (id, chat_id, seq, data) SELECT rowid, chat_id, seq, data FROM chat_messages;
        `);
        const after = fp('chat_messages_new');
        for (const key of Object.keys(before)) {
            if (before[key] !== after[key]) throw new Error(`migration 74 refuses to rebuild chat_messages: ${key} changed in the copy (${before[key]} -> ${after[key]})`);
        }
        // explicit, so the rebuild never depends on whether DROP TABLE fires row triggers
        for (const t of triggers) db.exec(`DROP TRIGGER ${t.name};`);
        db.exec('DROP TABLE chat_messages; ALTER TABLE chat_messages_new RENAME TO chat_messages;');
        for (const i of indexes) db.exec(`${i.sql};`);
        for (const t of triggers) db.exec(`${t.sql};`);
        // an extension's table keyed on a message must still find its parents; one that cant stops the step, nothing committed
        const children = db.prepare(`SELECT DISTINCT m.name FROM sqlite_master m, pragma_foreign_key_list(m.name) f
            WHERE m.type = 'table' AND f."table" = 'chat_messages'`).all().map(r => r.name);
        for (const child of children) {
            let bad;
            try { bad = db.prepare(`PRAGMA foreign_key_check("${child}")`).all().length; } catch (e) { bad = e.message; }
            if (bad) throw new Error(`migration 74 refuses to rebuild chat_messages: '${child}' would no longer find its messages (${bad}); nothing was committed`);
        }
    },
    // 75: a NOCASE index on worlds.name (a BINARY key), so the shelf walks its name order a page at a time
    `
    CREATE INDEX idx_worlds_name_nocase ON worlds(name COLLATE NOCASE);
    `,
    // 76: windowGeometry drops the places of two windows nothing mounts (the extension picker, the chub expand modal)
    (db) => {
        const row = db.prepare("SELECT value FROM settings WHERE key = 'windowGeometry'").get();
        let map = null;
        try { map = row ? JSON.parse(row.value) : null; } catch { map = null; }
        if (!map || typeof map !== 'object' || Array.isArray(map)) return;
        const gone = ['chatExtensionsPanel', 'chubExpandModal'].filter(k => Object.hasOwn(map, k));
        if (!gone.length) return;
        for (const k of gone) delete map[k];
        db.prepare("UPDATE settings SET value = ? WHERE key = 'windowGeometry'").run(JSON.stringify(map));
    },
    // 77: the funnels' whole name fold, the 128 code point cap included, over every stored name; one folding to nothing stays
    (db) => {
        const canonical = (value) => {
            if (typeof value === 'object' && value !== null) {
                if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
                let body = '';
                for (const key of Object.keys(value).sort()) body += `${body ? ',' : ''}${JSON.stringify(key)}:${canonical(value[key])}`;
                return `{${body}}`;
            }
            const text = JSON.stringify(value);
            return text === undefined ? 'null' : text;
        };
        const contentHash = (card) => crypto.createHash('sha256').update(canonical(card)).digest('hex');
        const fold = (name) => [...name.replace(/\s*[\r\n\t\u2028\u2029]\s*/g, ' ').trim()].slice(0, 128).join('').trimEnd();
        // only the changed ids are held, so a big library never holds every name at once
        const changed = [];
        for (const r of db.prepare('SELECT id, name FROM characters').iterate()) {
            if (typeof r.name !== 'string') continue;
            const folded = fold(r.name);
            if (folded !== r.name && folded !== '') changed.push(r.id);
        }
        const read = db.prepare('SELECT card FROM characters WHERE id = ?');
        const update = db.prepare('UPDATE characters SET card = ?, content_hash = ? WHERE id = ?');
        for (const id of changed) {
            let card;
            try { card = JSON.parse(read.get(id).card); } catch { continue; }
            card.data.name = fold(card.data.name);
            update.run(JSON.stringify(card), contentHash(card), id);
        }
    },
    // 78: a persona's five pronoun forms; an empty one answers its they/them word
    `
    ALTER TABLE personas ADD COLUMN pronoun_sub TEXT NOT NULL DEFAULT '';
    ALTER TABLE personas ADD COLUMN pronoun_obj TEXT NOT NULL DEFAULT '';
    ALTER TABLE personas ADD COLUMN pronoun_poss TEXT NOT NULL DEFAULT '';
    ALTER TABLE personas ADD COLUMN pronoun_poss_p TEXT NOT NULL DEFAULT '';
    ALTER TABLE personas ADD COLUMN pronoun_ref TEXT NOT NULL DEFAULT '';
    `,
    // 79: a tag's carrier count stored and trigger-owned, backfilled in one grouped pass, indexed for the most used order
    (db) => {
        db.exec(`
            ALTER TABLE tags ADD COLUMN char_count INTEGER NOT NULL DEFAULT 0;
            UPDATE tags SET char_count = c.n FROM (SELECT tag_id, COUNT(*) AS n FROM char_tags GROUP BY tag_id) AS c WHERE c.tag_id = tags.id;
            CREATE INDEX idx_tags_char_count ON tags(char_count DESC, name COLLATE NOCASE);
            ${TAG_COUNT_TRIGGERS_SQL}
        `);
    },
    // 80: the tag-run journal keeps its newest run alone, the one an undo reaches; foreign keys are off, so the children go by hand
    `
    DELETE FROM tag_run_entries WHERE run_id NOT IN (SELECT id FROM tag_runs ORDER BY id DESC LIMIT 1);
    DELETE FROM tag_run_links WHERE run_id NOT IN (SELECT id FROM tag_runs ORDER BY id DESC LIMIT 1);
    DELETE FROM tag_runs WHERE id NOT IN (SELECT id FROM tag_runs ORDER BY id DESC LIMIT 1);
    `,
    // 81: characters_fts adds the greetings, post-history instructions and depth prompt over a view; search_terms lists its words for substring search
    (db) => {
        for (const t of ['trg_characters_fts_ai', 'trg_characters_fts_ad', 'trg_characters_fts_au']) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
        db.exec(`
            DROP TABLE characters_fts;
            ${CHARACTER_FTS_SCHEMA_81}
            INSERT INTO characters_fts(characters_fts) VALUES ('rebuild');
            CREATE TABLE search_terms (term TEXT PRIMARY KEY) WITHOUT ROWID;
            CREATE TABLE search_terms_pending (rid INTEGER PRIMARY KEY);
            CREATE VIRTUAL TABLE temp.search_terms_vocab_81 USING fts5vocab(main, characters_fts, row);
            INSERT INTO search_terms (term) SELECT term FROM temp.search_terms_vocab_81;
            DROP TABLE temp.search_terms_vocab_81;
            ${CHARACTER_FTS_TRIGGERS_81}
        `);
    },
    // 82: a lore entry gets an id of its own, (world_name, uid) stays UNIQUE, and world_entries_fts indexes each entry's title and content
    (db) => {
        if (db.pragma('foreign_keys', { simple: true })) {
            throw new Error('migration 82 refuses to rebuild world_entries: foreign_keys is ON, so DROP TABLE would cascade rows away');
        }
        const fp = (t) => db.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(uid), 0) AS uids, COALESCE(SUM(octet_length(data)), 0) AS bytes,
            COUNT(DISTINCT world_name) AS books FROM "${t}"`).get();
        const before = fp('world_entries');
        const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'world_entries' AND sql IS NOT NULL").all();
        const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'world_entries'").all();
        db.exec(`
            CREATE TABLE world_entries_new (
                id INTEGER PRIMARY KEY,
                world_name TEXT NOT NULL REFERENCES worlds(name) ON DELETE CASCADE ON UPDATE CASCADE,
                uid INTEGER NOT NULL,
                data TEXT NOT NULL CHECK (json_valid(data)),
                comment TEXT GENERATED ALWAYS AS (json_extract(data, '$.comment')) VIRTUAL,
                enabled INTEGER GENERATED ALWAYS AS (CASE WHEN json_extract(data, '$.disable') THEN 0 ELSE 1 END) VIRTUAL,
                content TEXT GENERATED ALWAYS AS (json_extract(data, '$.content')) VIRTUAL,
                UNIQUE (world_name, uid)
            );
            INSERT INTO world_entries_new (world_name, uid, data) SELECT world_name, uid, data FROM world_entries ORDER BY world_name, uid;
        `);
        const after = fp('world_entries_new');
        for (const key of Object.keys(before)) {
            if (before[key] !== after[key]) throw new Error(`migration 82 refuses to rebuild world_entries: ${key} changed in the copy (${before[key]} -> ${after[key]})`);
        }
        for (const t of triggers) db.exec(`DROP TRIGGER ${t.name};`);
        db.exec('DROP TABLE world_entries; ALTER TABLE world_entries_new RENAME TO world_entries;');
        for (const i of indexes) db.exec(`${i.sql};`);
        for (const t of triggers) db.exec(`${t.sql};`);
        const children = db.prepare(`SELECT DISTINCT m.name FROM sqlite_master m, pragma_foreign_key_list(m.name) f
            WHERE m.type = 'table' AND f."table" = 'world_entries'`).all().map(r => r.name);
        for (const child of children) {
            let bad;
            try { bad = db.prepare(`PRAGMA foreign_key_check("${child}")`).all().length; } catch (e) { bad = e.message; }
            if (bad) throw new Error(`migration 82 refuses to rebuild world_entries: '${child}' would no longer find its entries (${bad}); nothing was committed`);
        }
        db.exec(`
            ${WORLD_ENTRY_FTS_SCHEMA_82}
            INSERT INTO world_entries_fts(world_entries_fts) VALUES ('rebuild');
            ${WORLD_ENTRY_FTS_TRIGGERS_82}
        `);
    },

    // 83: a chat's own connection and prompt preset, nullable FKs as the persona's; the partial indexes serve a delete's SET NULL
    `
    ALTER TABLE chats ADD COLUMN profile_id TEXT REFERENCES llm_profiles(id) ON DELETE SET NULL;
    ALTER TABLE chats ADD COLUMN preset_id TEXT REFERENCES presets(id) ON DELETE SET NULL;
    CREATE INDEX idx_chats_profile ON chats(profile_id) WHERE profile_id IS NOT NULL;
    CREATE INDEX idx_chats_preset ON chats(preset_id) WHERE preset_id IS NOT NULL;
    `,
    // 84: a tag's name folded past case, spaces and _ - . / so the spellings of one tag meet in the related query
    `
    ALTER TABLE tags ADD COLUMN fold TEXT GENERATED ALWAYS AS (lower(replace(replace(replace(replace(replace(name, ' ', ''), '_', ''), '-', ''), '.', ''), '/', ''))) VIRTUAL;
    CREATE INDEX idx_tags_fold ON tags(fold);
    `,
    // 85: the journal holds links runs alone: the client-journaled kinds and their entries go, tag_runs rebuilt for the CHECK, its AUTOINCREMENT mark kept
    (db) => {
        if (db.pragma('foreign_keys', { simple: true })) {
            throw new Error('migration 85 refuses to rebuild tag_runs: foreign_keys is ON, so DROP TABLE would cascade the run links away');
        }
        const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'tag_runs'").get()?.seq ?? null;
        db.exec(`
            DROP TABLE tag_run_entries;
            CREATE TABLE tag_runs_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                label TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind = 'links'),
                ops TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(ops))
            );
            INSERT INTO tag_runs_new (id, ts, label, kind, ops) SELECT id, ts, label, kind, ops FROM tag_runs WHERE kind = 'links';
            DELETE FROM tag_run_links WHERE run_id NOT IN (SELECT id FROM tag_runs_new);
            DROP TABLE tag_runs;
            ALTER TABLE tag_runs_new RENAME TO tag_runs;
        `);
        if (seq !== null) {
            db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('tag_runs', 'tag_runs_new')").run();
            db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('tag_runs', ?)").run(seq);
        }
    },
    // 86: whether a connection's model sees pictures: 1 it does, 0 it does not, NULL not known
    `
    ALTER TABLE llm_profiles ADD COLUMN vision INTEGER CHECK (vision IN (0, 1));
    `,
    // 87: a chat's own gallery and a studio session's pictures, one owner each; a message's pictures are link rows
    `
    CREATE TABLE attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
        studio_id TEXT REFERENCES studio_sessions(id) ON DELETE CASCADE,
        file TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
        size INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        content_hash TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        CHECK ((chat_id IS NULL) <> (studio_id IS NULL))
    );
    CREATE INDEX idx_attachments_chat ON attachments(chat_id, id) WHERE chat_id IS NOT NULL;
    CREATE INDEX idx_attachments_studio ON attachments(studio_id, id) WHERE studio_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_attachments_chat_name ON attachments(chat_id, display_name) WHERE chat_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_attachments_studio_name ON attachments(studio_id, display_name) WHERE studio_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_attachments_chat_hash ON attachments(chat_id, content_hash) WHERE chat_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_attachments_studio_hash ON attachments(studio_id, content_hash) WHERE studio_id IS NOT NULL;
    CREATE TABLE message_attachments (
        message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
        attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        pos INTEGER NOT NULL,
        PRIMARY KEY (message_id, attachment_id)
    ) WITHOUT ROWID;
    CREATE INDEX idx_message_attachments_attachment ON message_attachments(attachment_id);
    `,
    // 88: the most pictures a connection's host takes in one request; NULL is no limit
    `
    ALTER TABLE llm_profiles ADD COLUMN max_images INTEGER CHECK (max_images > 0);
    `,
    // 89: the server owns every full-text merge: a save never merges (automerge off), and an open merge always goes on (usermerge 2)
    `
    INSERT INTO characters_fts(characters_fts, rank) VALUES ('automerge', 0);
    INSERT INTO characters_fts(characters_fts, rank) VALUES ('usermerge', 2);
    INSERT INTO chat_messages_fts(chat_messages_fts, rank) VALUES ('automerge', 0);
    INSERT INTO chat_messages_fts(chat_messages_fts, rank) VALUES ('usermerge', 2);
    INSERT INTO world_entries_fts(world_entries_fts, rank) VALUES ('automerge', 0);
    INSERT INTO world_entries_fts(world_entries_fts, rank) VALUES ('usermerge', 2);
    `,
];

// the two per-character chat counters, one expression for the triggers, the backfill and the invariant; last_chat_at is the newest sort_at
export const CHAR_CHAT_COUNT_SQL = (charRef) => `SELECT COUNT(*) FROM chats ch WHERE ch.char_id = ${charRef}`;
export const CHAR_LAST_CHAT_SQL = (charRef) => `SELECT MAX(ch.sort_at) FROM chats ch WHERE ch.char_id = ${charRef}`;

// guarded: a character row carries its card, so its rewritten only when a counter moves
const CHAR_CHAT_RECOUNT_SQL = (charRef) => `UPDATE characters SET chat_count = (${CHAR_CHAT_COUNT_SQL(charRef)}), last_chat_at = (${CHAR_LAST_CHAT_SQL(charRef)})
        WHERE id = ${charRef} AND (chat_count IS NOT (${CHAR_CHAT_COUNT_SQL(charRef)}) OR last_chat_at IS NOT (${CHAR_LAST_CHAT_SQL(charRef)}))`;

export const CHAR_CHAT_TRIGGERS = ['trg_characters_chats_ai', 'trg_characters_chats_ad', 'trg_characters_chats_au'];
export const CHAR_CHAT_TRIGGERS_SQL = `
    CREATE TRIGGER trg_characters_chats_ai AFTER INSERT ON chats BEGIN
        ${CHAR_CHAT_RECOUNT_SQL('new.char_id')};
    END;
    CREATE TRIGGER trg_characters_chats_ad AFTER DELETE ON chats BEGIN
        ${CHAR_CHAT_RECOUNT_SQL('old.char_id')};
    END;
    CREATE TRIGGER trg_characters_chats_au AFTER UPDATE OF char_id, last_mes_at, create_date, updated_at ON chats BEGIN
        ${CHAR_CHAT_RECOUNT_SQL('old.char_id')};
        ${CHAR_CHAT_RECOUNT_SQL('new.char_id')};
    END;
`;

// the newest non-system text message, the list preview: one expression for the triggers, the backfill and the invariant
export const CHAT_LAST_MES_SQL = (chatRef) => `SELECT substr(json_extract(m.data, '$.mes'), 1, 300) FROM chat_messages m
                WHERE m.chat_id = ${chatRef} AND m.is_system = 0 AND json_type(m.data, '$.mes') = 'text' AND json_extract(m.data, '$.mes') != ''
                ORDER BY m.seq DESC LIMIT 1`;

export const CHAT_COUNTER_TRIGGERS = ['trg_chats_count_ai', 'trg_chats_count_ad', 'trg_chats_count_au'];
export const CHAT_COUNTER_TRIGGERS_SQL = `
    CREATE TRIGGER trg_chats_count_ai AFTER INSERT ON chat_messages BEGIN
        UPDATE chats SET message_count = message_count + 1, last_mes = (${CHAT_LAST_MES_SQL('new.chat_id')}) WHERE id = new.chat_id;
    END;
    CREATE TRIGGER trg_chats_count_ad AFTER DELETE ON chat_messages BEGIN
        UPDATE chats SET message_count = message_count - 1, last_mes = (${CHAT_LAST_MES_SQL('old.chat_id')}) WHERE id = old.chat_id;
    END;
    CREATE TRIGGER trg_chats_count_au AFTER UPDATE OF data ON chat_messages BEGIN
        UPDATE chats SET last_mes = (${CHAT_LAST_MES_SQL('new.chat_id')}) WHERE id = new.chat_id;
    END;
`;

// a tag's carriers as a stored count; a cascade fires these too, a REPLACE conflict doesnt (recursive_triggers is off)
export const TAG_COUNT_TRIGGERS = ['trg_tags_count_ai', 'trg_tags_count_ad', 'trg_tags_count_au'];
export const TAG_COUNT_TRIGGERS_SQL = `
    CREATE TRIGGER trg_tags_count_ai AFTER INSERT ON char_tags BEGIN
        UPDATE tags SET char_count = char_count + 1 WHERE id = new.tag_id;
    END;
    CREATE TRIGGER trg_tags_count_ad AFTER DELETE ON char_tags BEGIN
        UPDATE tags SET char_count = char_count - 1 WHERE id = old.tag_id;
    END;
    CREATE TRIGGER trg_tags_count_au AFTER UPDATE OF tag_id ON char_tags BEGIN
        UPDATE tags SET char_count = char_count - 1 WHERE id = old.tag_id;
        UPDATE tags SET char_count = char_count + 1 WHERE id = new.tag_id;
    END;
`;

// a fully migrated library's version: verify-db tells "desynced" from "not opened since the upgrade" by it
export const MIGRATION_COUNT = MIGRATIONS.length;

// step 10's triggers as it wrote them, frozen; the live set is FTS_TRIGGERS_SQL below
const FTS_TRIGGERS_SQL_10 = `
    CREATE TRIGGER trg_characters_fts_ai AFTER INSERT ON characters BEGIN
        INSERT INTO characters_fts(rowid, name, creator, nickname, creator_notes, description, personality, scenario, first_mes, mes_example, system_prompt)
        VALUES (new.rowid,
            json_extract(new.card, '$.data.name'), json_extract(new.card, '$.data.creator'),
            json_extract(new.card, '$.data.nickname'), json_extract(new.card, '$.data.creator_notes'),
            json_extract(new.card, '$.data.description'), json_extract(new.card, '$.data.personality'),
            json_extract(new.card, '$.data.scenario'), json_extract(new.card, '$.data.first_mes'),
            json_extract(new.card, '$.data.mes_example'), json_extract(new.card, '$.data.system_prompt'));
    END;
    CREATE TRIGGER trg_characters_fts_ad AFTER DELETE ON characters BEGIN
        INSERT INTO characters_fts(characters_fts, rowid, name, creator, nickname, creator_notes, description, personality, scenario, first_mes, mes_example, system_prompt)
        VALUES ('delete', old.rowid,
            json_extract(old.card, '$.data.name'), json_extract(old.card, '$.data.creator'),
            json_extract(old.card, '$.data.nickname'), json_extract(old.card, '$.data.creator_notes'),
            json_extract(old.card, '$.data.description'), json_extract(old.card, '$.data.personality'),
            json_extract(old.card, '$.data.scenario'), json_extract(old.card, '$.data.first_mes'),
            json_extract(old.card, '$.data.mes_example'), json_extract(old.card, '$.data.system_prompt'));
    END;
    CREATE TRIGGER trg_characters_fts_au AFTER UPDATE OF card ON characters BEGIN
        INSERT INTO characters_fts(characters_fts, rowid, name, creator, nickname, creator_notes, description, personality, scenario, first_mes, mes_example, system_prompt)
        VALUES ('delete', old.rowid,
            json_extract(old.card, '$.data.name'), json_extract(old.card, '$.data.creator'),
            json_extract(old.card, '$.data.nickname'), json_extract(old.card, '$.data.creator_notes'),
            json_extract(old.card, '$.data.description'), json_extract(old.card, '$.data.personality'),
            json_extract(old.card, '$.data.scenario'), json_extract(old.card, '$.data.first_mes'),
            json_extract(old.card, '$.data.mes_example'), json_extract(old.card, '$.data.system_prompt'));
        INSERT INTO characters_fts(rowid, name, creator, nickname, creator_notes, description, personality, scenario, first_mes, mes_example, system_prompt)
        VALUES (new.rowid,
            json_extract(new.card, '$.data.name'), json_extract(new.card, '$.data.creator'),
            json_extract(new.card, '$.data.nickname'), json_extract(new.card, '$.data.creator_notes'),
            json_extract(new.card, '$.data.description'), json_extract(new.card, '$.data.personality'),
            json_extract(new.card, '$.data.scenario'), json_extract(new.card, '$.data.first_mes'),
            json_extract(new.card, '$.data.mes_example'), json_extract(new.card, '$.data.system_prompt'));
    END;
    CREATE TRIGGER trg_chat_messages_fts_ai AFTER INSERT ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(rowid, mes) VALUES (new.rowid, json_extract(new.data, '$.mes'));
    END;
    CREATE TRIGGER trg_chat_messages_fts_ad AFTER DELETE ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(chat_messages_fts, rowid, mes) VALUES ('delete', old.rowid, json_extract(old.data, '$.mes'));
    END;
    CREATE TRIGGER trg_chat_messages_fts_au AFTER UPDATE OF data ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(chat_messages_fts, rowid, mes) VALUES ('delete', old.rowid, json_extract(old.data, '$.mes'));
        INSERT INTO chat_messages_fts(rowid, mes) VALUES (new.rowid, json_extract(new.data, '$.mes'));
    END;
`;

// the alternate greetings as one text, a line apiece; no json_each, since fts5 reads its content with virtual tables barred
const greetingsText = (card) => `(WITH RECURSIVE g(i, s) AS (SELECT 0, NULL UNION ALL
    SELECT i + 1, concat_ws(char(10), s, json_extract(${card}, '$.data.alternate_greetings[' || i || ']')) FROM g
    WHERE i < json_array_length(${card}, '$.data.alternate_greetings')) SELECT s FROM g ORDER BY i DESC LIMIT 1)`;

// characters_fts as step 81 built it: each column and its expression over a card, spelled by both the view and the triggers
const CHARACTER_FTS_COLUMNS_81 = [
    ['name', c => `json_extract(${c}, '$.data.name')`],
    ['creator', c => `json_extract(${c}, '$.data.creator')`],
    ['nickname', c => `json_extract(${c}, '$.data.nickname')`],
    ['creator_notes', c => `json_extract(${c}, '$.data.creator_notes')`],
    ['description', c => `json_extract(${c}, '$.data.description')`],
    ['personality', c => `json_extract(${c}, '$.data.personality')`],
    ['scenario', c => `json_extract(${c}, '$.data.scenario')`],
    ['first_mes', c => `json_extract(${c}, '$.data.first_mes')`],
    ['mes_example', c => `json_extract(${c}, '$.data.mes_example')`],
    ['system_prompt', c => `json_extract(${c}, '$.data.system_prompt')`],
    ['alternate_greetings', greetingsText],
    ['post_history_instructions', c => `json_extract(${c}, '$.data.post_history_instructions')`],
    ['depth_prompt', c => `json_extract(${c}, '$.data.extensions.depth_prompt.prompt')`],
];
const ftsCols81 = CHARACTER_FTS_COLUMNS_81.map(([n]) => n).join(', ');
const ftsValues81 = (card) => CHARACTER_FTS_COLUMNS_81.map(([, expr]) => expr(card)).join(',\n            ');

// the view characters_fts reads its text from (rid is the character rowid), then the table
const CHARACTER_FTS_SCHEMA_81 = `
    CREATE VIEW characters_fts_source AS SELECT c.rowid AS rid,
        ${CHARACTER_FTS_COLUMNS_81.map(([n, expr]) => `${expr('c.card')} AS ${n}`).join(',\n        ')}
        FROM characters c;
    CREATE VIRTUAL TABLE characters_fts USING fts5(
        ${ftsCols81},
        content='characters_fts_source', content_rowid='rid',
        tokenize='unicode61 remove_diacritics 2'
    );
`;

// a written character's rowid waits in search_terms_pending until its words reach search_terms
const CHARACTER_FTS_TRIGGERS_81 = `
    CREATE TRIGGER trg_characters_fts_ai AFTER INSERT ON characters BEGIN
        INSERT INTO characters_fts(rowid, ${ftsCols81})
        VALUES (new.rowid, ${ftsValues81('new.card')});
        INSERT OR IGNORE INTO search_terms_pending(rid) VALUES (new.rowid);
    END;
    CREATE TRIGGER trg_characters_fts_ad AFTER DELETE ON characters BEGIN
        INSERT INTO characters_fts(characters_fts, rowid, ${ftsCols81})
        VALUES ('delete', old.rowid, ${ftsValues81('old.card')});
        DELETE FROM search_terms_pending WHERE rid = old.rowid;
    END;
    CREATE TRIGGER trg_characters_fts_au AFTER UPDATE OF card ON characters BEGIN
        INSERT INTO characters_fts(characters_fts, rowid, ${ftsCols81})
        VALUES ('delete', old.rowid, ${ftsValues81('old.card')});
        INSERT INTO characters_fts(rowid, ${ftsCols81})
        VALUES (new.rowid, ${ftsValues81('new.card')});
        INSERT OR IGNORE INTO search_terms_pending(rid) VALUES (new.rowid);
    END;
`;

// a lore entry's title and content, read off its row's generated columns
const WORLD_ENTRY_FTS_SCHEMA_82 = `
    CREATE VIRTUAL TABLE world_entries_fts USING fts5(
        comment, content, content='world_entries', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
    );
`;

// an upsert keeps the row's id and fires the update trigger; a REPLACE conflict fires neither delete nor update
const WORLD_ENTRY_FTS_TRIGGERS_82 = `
    CREATE TRIGGER trg_world_entries_fts_ai AFTER INSERT ON world_entries BEGIN
        INSERT INTO world_entries_fts(rowid, comment, content) VALUES (new.id, new.comment, new.content);
    END;
    CREATE TRIGGER trg_world_entries_fts_ad AFTER DELETE ON world_entries BEGIN
        INSERT INTO world_entries_fts(world_entries_fts, rowid, comment, content) VALUES ('delete', old.id, old.comment, old.content);
    END;
    CREATE TRIGGER trg_world_entries_fts_au AFTER UPDATE OF data ON world_entries BEGIN
        INSERT INTO world_entries_fts(world_entries_fts, rowid, comment, content) VALUES ('delete', old.id, old.comment, old.content);
        INSERT INTO world_entries_fts(rowid, comment, content) VALUES (new.id, new.comment, new.content);
    END;
`;

// Trigger DDL lives apart from the migrations so tooling (the benchmark's bulk loader)
// can drop and re-create the same triggers around a mass insert + 'rebuild'.
export const FTS_TRIGGERS_SQL = `${CHARACTER_FTS_TRIGGERS_81}${WORLD_ENTRY_FTS_TRIGGERS_82}
    CREATE TRIGGER trg_chat_messages_fts_ai AFTER INSERT ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(rowid, mes) VALUES (new.rowid, json_extract(new.data, '$.mes'));
    END;
    CREATE TRIGGER trg_chat_messages_fts_ad AFTER DELETE ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(chat_messages_fts, rowid, mes) VALUES ('delete', old.rowid, json_extract(old.data, '$.mes'));
    END;
    CREATE TRIGGER trg_chat_messages_fts_au AFTER UPDATE OF data ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(chat_messages_fts, rowid, mes) VALUES ('delete', old.rowid, json_extract(old.data, '$.mes'));
        INSERT INTO chat_messages_fts(rowid, mes) VALUES (new.rowid, json_extract(new.data, '$.mes'));
    END;
`;

// One handle per user; each library.db migrates independently on first open.
const handles = new Map();

// What runs on every library as it opens, after its own migrations and before its writes
// reach the change feed (the extensions' migrations): fn(db, handle)
const _openers = new Set();

/** @returns {Function} the removal */
export function onLibraryOpen(fn) {
    _openers.add(fn);
    return () => _openers.delete(fn);
}

/** Run fn over every library open now, for code that arrives after they opened. */
export function forEachOpenLibrary(fn) {
    for (const [handle, db] of handles) fn(db, handle);
}

export function openDb(handle) {
    if (handle === undefined) {
        // routes always pass req.db; a bare call is only legal while auth is off,
        // otherwise it would silently read the default user's library
        if (config.multiUser) throw new Error('openDb() needs a user handle in multi-user mode');
        handle = 'default';
    }
    let db = handles.get(handle);
    if (db) return db;
    const paths = ensureUserDirs(handle);
    // 30s busy wait: an external writer (verify, a backup, a DB browser) stalls requests instead of failing them
    db = new Database(paths.dbFile, { timeout: 30000 });
    try {
        db.pragma('journal_mode = WAL');
        // migrations run with FKs off so table-recreate migrations (the standard SQLite
        // recipe) dont trip child references mid-copy; enforcement turns on right after
        db.pragma('foreign_keys = OFF');
        migrate(db, paths);
        db.pragma('foreign_keys = ON');
        // the namespace ratchet loads wherever a library opens, before the sweep, so a fresh home promotes ratcheted namespaces too
        loadPersistedNamespaces();
        promoteKnownNamespaces(db);
        for (const fn of _openers) {
            try { fn(db, handle); } catch (e) { console.error(`[db] a library opener failed on ${handle}:`, e); }
        }
        // without sqlite_stat1 every indexed range filter plans as a scan; optimize analyzes what lacks stats, bounded by analysis_limit
        db.pragma('analysis_limit = 1000');
        db.pragma('optimize');
    } catch (e) {
        // close a library that cant open, or the handle holds the file for the life of the process
        db.close();
        throw e;
    }
    // from here on every committed store write reaches the change feed, routed to this user
    trackHandle(db, handle);
    handles.set(handle, db);
    scheduleFtsMerge(db);
    return db;
}

/** A library a newer build wrote (a rollback, a newer home copied back): refused rather than read under a schema it doesnt know. */
class LibraryAheadError extends Error {
    constructor(version) {
        super(`This library was written by a newer version of the server (schema ${version}, this one knows ${MIGRATIONS.length}). Update the server to open it.`);
        this.name = 'LibraryAheadError';
        this.statusCode = 503;
    }
}

/** Apply steps from..to-1, one transaction each, user_version bumped inside it; the caller owns the FK toggle. */
export function runMigrationSteps(db, paths, from, to) {
    for (let v = from; v < to; v++) {
        db.transaction(() => {
            const m = MIGRATIONS[v];
            if (typeof m === 'function') m(db, paths);
            else db.exec(m);
            db.pragma(`user_version = ${v + 1}`);
        })();
    }
}

function migrate(db, paths) {
    const current = db.pragma('user_version', { simple: true });
    if (current > MIGRATIONS.length) throw new LibraryAheadError(current);
    runMigrationSteps(db, paths, current, MIGRATIONS.length);
}

export function closeDb(handle) {
    if (handle !== undefined) {
        const db = handles.get(handle);
        if (db) { stopFtsMerge(db); db.close(); }
        handles.delete(handle);
        return;
    }
    for (const db of handles.values()) { stopFtsMerge(db); db.close(); }
    handles.clear();
}

/** Whether this process holds a library open: a one-shot tool closes only the handle it opened. */
export function isDbOpen(handle) {
    return handles.has(handle);
}

/** Reload the FTS5 structure of an open library another process wrote (the migration tool); answers whether a handle was refreshed. */
export function refreshFtsIfOpen(handle) {
    const db = handles.get(handle);
    if (!db) return false;
    for (const t of FTS_TABLES) db.prepare(`INSERT INTO ${t}(${t}) VALUES ('integrity-check')`).run();
    // a migration run writes in bulk, as a rebuild does, so its segments are looked at
    scheduleFtsMerge(db);
    return true;
}
