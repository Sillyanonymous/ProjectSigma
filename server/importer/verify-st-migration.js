import { alignActiveSwipe, parseStChatJsonl, parseStDate } from '../db/chats-store.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readCardChunks } from '../lib/png-card.js';
import { cardSourceOf } from '../lib/card-normalize.js';
import { entryUid } from '../lib/world-entry.js';
import { readJsonFile } from '../lib/json-file.js';
import { PROVIDER_NAMESPACES } from '../lib/provider-namespaces.js';
import { EXT_SETTINGS_KEY, STORE_DOC_MAP, CSS_SETTING_KEYS, stWorldInfo } from './st-layout.js';
import { expandSuppliedGreeting } from '../llm/prompt.js';
import { oneLineName } from '../db/characters-store.js';

// the ST personas whose library row kept its own picture, as the migration's run records them
export const PERSONA_PICTURES_KEY = 'st-migration-persona-pictures';

// source-vs-target parity for the ST migration, re-derived from the source apart from the importer, so its bugs surface as findings

const V1_FIELDS = [
    'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions', 'alternate_greetings',
    'character_book', 'tags', 'creator', 'character_version', 'extensions',
];
const OP_STATE = ['fav', 'chat', 'chat_size', 'date_last_chat', 'update_locked'];
const IDENTITY_EXT = ['version_uid', 'gallery_id'];

function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null || typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        if (a.length !== b.length) return false;
        return a.every((v, i) => deepEqual(v, b[i]));
    }
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEqual(a[k], b[k]));
}

// what the source wrapper's data must look like once stored: V1 mirrors folded in, tags
// and every relational/op-state key gone, cl kept minus its uid
function expectedFromSource(source) {
    let data;
    if (source.spec === 'chara_card_v3' || source.spec === 'chara_card_v2') {
        data = { ...(source.data || {}) };
        for (const f of V1_FIELDS) if (data[f] === undefined && source[f] !== undefined) data[f] = source[f];
    } else {
        data = {};
        for (const f of V1_FIELDS) if (source[f] !== undefined) data[f] = source[f];
    }
    if (!data.name || typeof data.name !== 'string') return null;

    const rawTags = Array.isArray(data.tags) ? data.tags : data.tags ? [String(data.tags)] : [];
    const tags = rawTags.map(t => String(t).trim()).filter(Boolean);
    const ext = data.extensions && typeof data.extensions === 'object' && !Array.isArray(data.extensions)
        ? { ...data.extensions } : {};

    const fav = ext.fav === true || ext.fav === 'true' || source.fav === true || source.fav === 'true';
    const updateLocked = ext.update_locked === true;
    const providerNs = {};
    for (const ns of PROVIDER_NAMESPACES) {
        if (ext[ns] === undefined) continue;
        // only an object namespace becomes a link row (a null is stripped, no row), and only the first in divert order
        if (ext[ns] && typeof ext[ns] === 'object' && Object.keys(providerNs).length === 0) providerNs[ns] = ext[ns];
        delete ext[ns];
    }
    const world = typeof ext.world === 'string' ? ext.world : null;
    delete ext.world;
    const versionUid = typeof ext.version_uid === 'string' && ext.version_uid ? ext.version_uid : null;
    const galleryId = typeof ext.gallery_id === 'string' && ext.gallery_id ? ext.gallery_id : null;
    for (const k of [...OP_STATE, ...IDENTITY_EXT]) delete ext[k];
    let clUid = null;
    if (ext.cl && typeof ext.cl === 'object') {
        ext.cl = { ...ext.cl };
        if (typeof ext.cl.uid === 'string') clUid = ext.cl.uid;
        delete ext.cl.uid;
        if (Object.keys(ext.cl).length === 0) delete ext.cl;
    }

    delete data.tags;
    data.extensions = ext;
    // the stored form drops a provider's data.avatar and puts the name on one line; the gallery folder is still found by the source's name
    const sourceName = data.name;
    delete data.avatar;
    oneLineName({ data });
    return { data, sourceName, tags, fav, updateLocked, providerNs, world, versionUid, galleryId, clUid };
}

// a lorebook's entries as the importer resolves their uids: numeric ones pass, foreign keys remap onto free uids in key order
function expectedEntriesOf(doc) {
    const srcEntries = doc.entries && typeof doc.entries === 'object' ? doc.entries : {};
    const numeric = [];
    const foreign = [];
    for (const [key, entry] of Object.entries(srcEntries)) {
        const uid = entryUid(key, entry);
        if (Number.isFinite(uid)) numeric.push([uid, entry]);
        else foreign.push(entry);
    }
    let nextUid = numeric.reduce((m, [u]) => Math.max(m, u), -1) + 1;
    return [...numeric, ...foreign.map(e => [nextUid, { ...e, uid: nextUid++ }])];
}

/**
 * Source-vs-target parity over an ST home and the library it migrated into.
 * @param {boolean} opts.mediaBytes the full tier re-hashes every source gallery file; the fast tier matches row presence and size
 * @param {(p: {done: number, total: number}) => void} [opts.onProgress] the characters and lorebooks compared so far
 * @returns {{checked: number, findings: string[], groups: Array<{kind: string, count: number}>}} groups counts the findings by kind, in first-seen order
 */
export function verifyStMigration(userDir, db, paths, { files = null, mediaBytes = true, onProgress = null } = {}) {
    const findings = [];
    const kinds = new Map();
    let checked = 0;
    const flag = (msg, kind) => { findings.push(msg); kinds.set(kind, (kinds.get(kind) || 0) + 1); };
    const check = (ok, msg, kind) => { checked++; if (!ok) flag(msg, kind); };

    const byAvatar = db.prepare("SELECT char_id FROM char_aliases WHERE kind = 'avatar_file' AND value = ?");
    const aliasByKindValue = db.prepare('SELECT char_id FROM char_aliases WHERE kind = ? AND value = ?');
    const charRow = db.prepare('SELECT * FROM characters WHERE id = ?');
    const charTags = db.prepare(`SELECT t.name FROM char_tags ct JOIN tags t ON t.id = ct.tag_id
        WHERE ct.char_id = ? ORDER BY ct.pos`);
    const links = db.prepare('SELECT provider_id, data FROM provider_links WHERE char_id = ?');
    const headWorld = db.prepare('SELECT world_name FROM char_worlds WHERE char_id = ? ORDER BY pos LIMIT 1');
    const chatHeadWorld = db.prepare('SELECT world_name FROM chat_worlds WHERE chat_id = ? ORDER BY pos LIMIT 1');
    const charWorlds = db.prepare('SELECT world_name FROM char_worlds WHERE char_id = ? ORDER BY pos');
    const chatByName = db.prepare('SELECT * FROM chats WHERE char_id = ? AND name = ?');
    const chatMessages = db.prepare('SELECT seq, data FROM chat_messages WHERE chat_id = ? ORDER BY seq');
    const versionRows = db.prepare('SELECT * FROM versions WHERE char_id = ? ORDER BY snap_id');

    const charactersDir = path.join(userDir, 'characters');
    const selectedSet = Array.isArray(files) ? new Set(files) : null;
    const pngs = fs.readdirSync(charactersDir).filter(f => f.toLowerCase().endsWith('.png'))
        .filter(f => !selectedSet || selectedSet.has(f)).sort();

    const filesDir = path.join(userDir, 'user', 'files');
    const imagesRoot = path.join(userDir, 'user', 'images');
    const settings = readJsonFile(path.join(userDir, 'settings.json'));
    const baseToChar = new Map();

    const worldsDir = path.join(userDir, 'worlds');
    const worldFiles = fs.existsSync(worldsDir) ? fs.readdirSync(worldsDir).filter(f => f.toLowerCase().endsWith('.json')).sort() : [];
    let done = 0;
    const total = worldFiles.length + pngs.length;
    const tick = () => { done++; onProgress?.({ done, total }); };
    onProgress?.({ done, total });

    // worlds first: entries verbatim, and each ST book's stored name re-derived (trimmed, an already-trimmed file first, a later namesake under a numbered copy)
    const worldRow = db.prepare('SELECT data FROM worlds WHERE name = ?');
    const entryRows = db.prepare('SELECT uid, data FROM world_entries WHERE world_name = ?');
    const storedEntries = (name) => new Map(entryRows.all(name).map(r => [String(r.uid), JSON.parse(r.data)]));
    const baseOf = (wf) => path.basename(wf, path.extname(wf));
    const spaced = (wf) => baseOf(wf) !== baseOf(wf).trim();
    const storedOf = new Map();
    const claimed = new Set();
    for (const wf of [...worldFiles.filter(f => !spaced(f)), ...worldFiles.filter(spaced)]) {
        const doc = readJsonFile(path.join(worldsDir, wf));
        tick();
        if (!doc || typeof doc !== 'object') continue;
        const base = baseOf(wf);
        const name = base.trim() || base;
        const expectedEntries = expectedEntriesOf(doc);
        if (claimed.has(name)) {
            const holds = (candidate) => {
                const stored = storedEntries(candidate);
                return stored.size === new Set(expectedEntries.map(([u]) => u)).size && expectedEntries.every(([uid, entry]) => deepEqual(stored.get(String(uid)), entry));
            };
            let found = null;
            for (let n = 1; !found; n++) {
                const candidate = n === 1 ? name : `${name} (${n})`;
                if (!worldRow.get(candidate)) break;
                if (holds(candidate)) found = candidate;
            }
            check(!!found, `world "${base}": no book under "${name}" or a numbered copy of it holds its entries`, 'world');
            if (found) { storedOf.set(base, found); claimed.add(found); }
            continue;
        }
        claimed.add(name);
        storedOf.set(base, name);
        const row = worldRow.get(name);
        if (!row) { flag(`world "${name}": missing`, 'world'); continue; }
        const meta = { ...doc };
        delete meta.entries;
        check(deepEqual(JSON.parse(row.data), meta), `world "${name}": meta diverges`, 'world');
        const stored = storedEntries(name);
        for (const [uid, entry] of expectedEntries) {
            if (!deepEqual(stored.get(String(uid)), entry)) flag(`world "${name}": entry ${uid} diverges`, 'world');
            checked++;
        }
        check(stored.size === new Set(expectedEntries.map(([u]) => u)).size,
            `world "${name}": ${stored.size} rows for ${expectedEntries.length} source entries`, 'world');
    }
    // a link names its book as ST did; it is stored under the book's own name, else trimmed as every link writer trims
    const storedWorldName = (raw) => (typeof raw === 'string' ? (storedOf.get(raw) ?? raw.trim()) : '');

    for (const file of pngs) {
        tick();
        let parsed;
        try { parsed = readCardChunks(fs.readFileSync(path.join(charactersDir, file))); } catch { parsed = null; }
        const source = cardSourceOf(parsed);
        if (!source) continue; // no embedded card: the importer skips these too
        const expected = expectedFromSource(source);
        if (!expected) continue; // nameless card: importer skips

        const row = byAvatar.get(file);
        if (!row) { flag(`${file}: no character behind this filename (avatar_file alias missing)`, 'card'); continue; }
        const charId = row.char_id;
        const base = file.replace(/\.png$/i, '');
        baseToChar.set(base, charId);
        const char = charRow.get(charId);
        if (!char) { flag(`${file}: alias points at a missing character row`, 'card'); continue; }

        const stored = JSON.parse(char.card);
        check(deepEqual(stored.data, expected.data),
            `${file}: stored card data diverges from source (beyond the documented transforms)`, 'card-data');
        check(deepEqual(Object.keys(stored).sort(), ['data', 'spec', 'spec_version']),
            `${file}: stored card carries keys beyond {spec, spec_version, data}`, 'card-data');

        const tagRows = charTags.all(charId).map(r => r.name.toLowerCase());
        for (const t of expected.tags) {
            check(tagRows.includes(t.toLowerCase()), `${file}: tag "${t}" missing from char_tags`, 'card-data');
        }
        check(!!char.fav === expected.fav, `${file}: fav column ${char.fav} != source ${expected.fav}`, 'card-data');
        check(!!char.update_locked === expected.updateLocked, `${file}: update_locked column diverges`, 'card-data');

        const linkRows = new Map(links.all(charId).map(l => [l.provider_id, JSON.parse(l.data || 'null')]));
        check(linkRows.size <= 1, `${file}: ${linkRows.size} provider_links rows; one link per character`, 'card-data');
        for (const [ns, val] of Object.entries(expected.providerNs)) {
            check(linkRows.has(ns) && deepEqual(linkRows.get(ns), val),
                `${file}: provider namespace ${ns} did not survive into provider_links verbatim`, 'card-data');
        }
        const headBook = storedWorldName(expected.world);
        if (headBook) {
            check(headWorld.get(charId)?.world_name === headBook,
                `${file}: extensions.world "${expected.world}" is not the head char_worlds link`, 'lore');
        }
        // portable ids land as alias rows; on duplicate groups they live on the group's
        // first import, so presence is asserted globally rather than per char
        if (expected.versionUid) {
            check(!!aliasByKindValue.get('version_uid', expected.versionUid),
                `${file}: version_uid ${expected.versionUid} has no alias row`, 'version');
        }

        // chats: every source line must be a row, byte-faithful
        const chatDir = path.join(userDir, 'chats', base);
        if (fs.existsSync(chatDir)) {
            for (const chatFile of fs.readdirSync(chatDir).filter(f => f.toLowerCase().endsWith('.jsonl'))) {
                const parsed = parseStChatJsonl(fs.readFileSync(path.join(chatDir, chatFile), 'utf8'));
                if (!parsed) continue;
                const { header, messages } = parsed;
                const chatName = chatFile.replace(/\.jsonl$/i, '');
                const chat = chatByName.get(charId, chatName);
                if (!chat) { flag(`${file}: chat "${chatName}" missing`, 'chat'); continue; }
                const rows = chatMessages.all(chat.id);
                check(rows.length === messages.length,
                    `${file}: chat "${chatName}" has ${rows.length} rows for ${messages.length} source messages`, 'chat');
                // the import stores a greeting ST never expanded (a chat nobody replied in) expanded, and what its macros set
                const greeted = expandSuppliedGreeting(db, { charId, name: chatName, header, chatId: chat.id }, messages);
                const n = Math.min(rows.length, messages.length);
                for (let i = 0; i < n; i++) {
                    // the store aligns the active alternate to mes on import, so the source is compared in that shape
                    if (!deepEqual(JSON.parse(rows[i].data), alignActiveSwipe(greeted.messages[i]))) {
                        flag(`${file}: chat "${chatName}" message ${i} diverges from source`, 'chat');
                        break;
                    }
                }
                checked++;
                // the header's world_info lifts to the head chat_worlds row, so the blob is compared without it and the row checked
                const expectedMeta = { ...(header.chat_metadata && typeof header.chat_metadata === 'object' ? header.chat_metadata : {}), ...greeted.changes?.metadata };
                const boundWorld = storedWorldName(expectedMeta.world_info);
                delete expectedMeta.world_info;
                check(deepEqual(JSON.parse(chat.chat_metadata || '{}'), expectedMeta),
                    `${file}: chat "${chatName}" metadata diverges`, 'chat');
                check(!('world_info' in JSON.parse(chat.chat_metadata || '{}')),
                    `${file}: chat "${chatName}" stores world_info in its blob instead of a chat_worlds row`, 'purity');
                if (boundWorld) {
                    check(chatHeadWorld.get(chat.id)?.world_name === boundWorld,
                        `${file}: chat "${chatName}" world_info "${boundWorld}" is not the head chat_worlds row`, 'lore');
                }
                const stamp = parseStDate(header.create_date);
                if (stamp) check(chat.create_date === stamp, `${file}: chat "${chatName}" create_date diverges`, 'chat');
            }
        }

        // gallery: every source file under this char, by content hash in the full tier, by size in the fast one
        if (fs.existsSync(imagesRoot)) {
            const rows = db.prepare('SELECT content_hash, size FROM media WHERE char_id = ?').all(charId);
            const hashes = new Set(rows.map(r => r.content_hash).filter(Boolean));
            const sizes = new Set(rows.map(r => r.size));
            const name = expected.sourceName;
            const candidates = [];
            if (expected.galleryId) {
                const cl = String(name || '').replace(/[<>:"/\\|?*]/g, '_').trim();
                candidates.push(cl ? `${cl}_${expected.galleryId}` : `_${expected.galleryId}`);
            }
            const shared = String(name || '').replace(/[<>:"/\\|?*]/g, '').trim();
            // a name of dots alone is the images root itself (or its parent), never a character's folder
            if (shared && !/^[.\s]+$/.test(shared)) candidates.push(shared);
            for (const folder of candidates) {
                const dir = path.join(imagesRoot, folder);
                if (!fs.existsSync(dir)) continue;
                for (const mediaFile of fs.readdirSync(dir)) {
                    const full = path.join(dir, mediaFile);
                    const st = fs.statSync(full);
                    if (!st.isFile()) continue;
                    if (mediaBytes) {
                        const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
                        check(hashes.has(hash), `${file}: gallery bytes ${folder}/${mediaFile} missing from media (by content hash)`, 'gallery');
                    } else {
                        check(sizes.has(st.size), `${file}: gallery file ${folder}/${mediaFile} unaccounted (by size)`, 'gallery');
                    }
                }
            }
        }

        // versions: every snapshot of the _clv_ doc held, by time and content; the slot holds the file's backup or a newer one
        if (expected.versionUid) {
            const doc = readJsonFile(path.join(filesDir, `_clv_${expected.versionUid}.json`));
            if (doc && Array.isArray(doc.snapshots)) {
                const rows = versionRows.all(charId);
                const held = rows.filter(r => r.snap_id >= 0).map(r => ({ r, data: JSON.parse(r.data) }));
                for (const s of doc.snapshots) {
                    const found = held.find(({ r, data }) => (typeof s.timestamp !== 'number' || r.created_at === s.timestamp)
                        && (s.source ?? null) === r.source && deepEqual(data, s.data ?? {}));
                    if (!found) { flag(`${file}: version snapshot ${s.id} missing`, 'version'); continue; }
                    if ((s.charName ?? null) !== found.r.char_name) flag(`${file}: version snapshot ${s.id} metadata diverges`, 'version');
                    checked++;
                }
                const backupRow = rows.find(r => r.snap_id === -1);
                if (doc.backup) {
                    check(!!backupRow, `${file}: version backup slot missing`, 'version');
                    if (backupRow) {
                        check(deepEqual(JSON.parse(backupRow.data), doc.backup) || backupRow.created_at > (doc.backup.timestamp ?? 0),
                            `${file}: version backup data diverges`, 'version');
                    }
                }
            }
        }
    }

    // charLore links: every source ref whose character migrated must be a char_worlds row
    const lore = stWorldInfo(settings);
    const charLore = Array.isArray(lore.charLore) ? lore.charLore : [];
    for (const entry of charLore) {
        if (!entry || typeof entry.name !== 'string') continue;
        const charId = baseToChar.get(entry.name) ?? byAvatar.get(`${entry.name}.png`)?.char_id;
        if (!charId) continue; // char not migrated (unmatched or unselected): reported by the run, not a parity failure
        if (selectedSet && !selectedSet.has(`${entry.name}.png`)) continue;
        const linked = new Set(charWorlds.all(charId).map(r => r.world_name));
        for (const book of Array.isArray(entry.extraBooks) ? entry.extraBooks : []) {
            const want = storedWorldName(book);
            if (!want) continue;
            check(linked.has(want), `charLore: "${entry.name}" link to "${book}" missing from char_worlds`, 'lore');
        }
    }

    // playlists by id with their resolvable members; the name isnt checked, since the merge keeps a held one's name
    const playlistsDoc = readJsonFile(path.join(filesDir, '_cl_playlists.json'));
    if (playlistsDoc?.playlists && typeof playlistsDoc.playlists === 'object') {
        const listRow = db.prepare('SELECT id FROM playlists WHERE id = ?');
        const memberRows = db.prepare('SELECT char_id FROM playlist_chars WHERE playlist_id = ?');
        for (const [uid, p] of Object.entries(playlistsDoc.playlists)) {
            if (!p || typeof p !== 'object') continue;
            if (!listRow.get(uid)) { flag(`playlist "${p.name || uid}": missing`, 'other'); continue; }
            const resolvable = (Array.isArray(p.characters) ? p.characters : [])
                .map(av => byAvatar.get(av)?.char_id).filter(Boolean);
            const members = new Set(memberRows.all(uid).map(r => r.char_id));
            for (const cid of resolvable) {
                check(members.has(cid), `playlist "${p.name || uid}": migrated member missing`, 'other');
            }
        }
    }

    // global lorebooks: every selected name is a global_worlds row (a dangling one as a placeholder)
    const globalSelect = Array.isArray(lore.globalSelect) ? lore.globalSelect : [];
    const globalRows = new Set(db.prepare('SELECT world_name FROM global_worlds').all().map(r => r.world_name));
    for (const name of new Set(globalSelect.map(storedWorldName).filter(Boolean))) {
        check(globalRows.has(name), `global lorebook "${name}": missing from global_worlds`, 'lore');
    }

    // personas: presence, the active pointer, the book and the picture, asked of any row matching name and description
    const personas = settings?.power_user?.personas;
    if (personas && typeof personas === 'object') {
        const personaRows = db.prepare('SELECT id, name, description, avatar FROM personas').all();
        const personaBooks = db.prepare('SELECT 1 FROM persona_worlds WHERE persona_id = ? AND world_name = ?');
        const descriptions = settings.power_user?.persona_descriptions || {};
        // a row that kept its own picture is asked to have one, never to hold ST's bytes
        let kept = new Set();
        try { kept = new Set(JSON.parse(db.prepare('SELECT value FROM app_store WHERE key = ?').get(PERSONA_PICTURES_KEY)?.value || 'null')?.kept || []); } catch { /* no record: every picture is asked of its bytes */ }
        for (const [avatarId, name] of Object.entries(personas)) {
            const description = String(descriptions[avatarId]?.description || '');
            const matches = personaRows.filter(r => r.name === String(name) && r.description === description);
            const match = matches[0];
            check(!!match, `persona "${name}": missing`, 'persona');
            const book = storedWorldName(descriptions[avatarId]?.lorebook);
            if (match && book) {
                check(matches.some(r => personaBooks.get(r.id, book)), `persona "${name}": its lorebook "${book}" is missing from persona_worlds`, 'lore');
            }
            const sourceAvatar = path.join(userDir, 'User Avatars', avatarId);
            if (match && fs.existsSync(sourceAvatar)) {
                const want = mediaBytes ? fs.readFileSync(sourceAvatar) : fs.statSync(sourceAvatar).size;
                const landed = (r) => {
                    if (!r.avatar) return false;
                    const file = path.join(paths.personaAvatarsDir, r.avatar);
                    if (!fs.existsSync(file)) return false;
                    if (kept.has(avatarId)) return true;
                    return mediaBytes ? fs.readFileSync(file).equals(want) : fs.statSync(file).size === want;
                };
                check(matches.some(landed), `persona "${name}": its picture did not land`, 'persona');
            }
            if (match && settings.power_user?.default_persona === avatarId) {
                const activeRaw = db.prepare("SELECT value FROM settings WHERE key = 'activePersonaId'").get()?.value;
                let active = null;
                try { active = JSON.parse(activeRaw ?? 'null'); } catch { active = null; }
                const activeRow = personaRows.find(r => r.id === active);
                check(!!activeRow && activeRow.name === String(name) && activeRow.description === description,
                    `persona "${name}": is the ST default but not the active persona`, 'persona');
            }
        }
    }

    // the extension's store docs: each one present replaced its app_store home
    const storeDoc = db.prepare('SELECT value FROM app_store WHERE key = ?');
    for (const { file, key } of STORE_DOC_MAP) {
        const doc = readJsonFile(path.join(filesDir, file));
        if (!doc) continue;
        const row = storeDoc.get(key);
        let stored = null;
        try { stored = row ? JSON.parse(row.value) : null; } catch { stored = null; }
        check(deepEqual(stored, { version: 1, ...doc }), `store doc ${file}: ${row ? 'diverges from' : 'missing from'} app_store "${key}"`, 'other');
    }

    // custom CSS: a value the source set is a setting here (the library's own, when it had one, is kept)
    const extSettings = settings?.extension_settings?.[EXT_SETTINGS_KEY];
    if (extSettings && typeof extSettings === 'object') {
        const setting = db.prepare('SELECT 1 FROM settings WHERE key = ?');
        for (const key of CSS_SETTING_KEYS) {
            if (typeof extSettings[key] === 'string' && extSettings[key]) check(!!setting.get(key), `setting ${key}: missing`, 'other');
        }
    }

    // purity: a migrated character is indistinguishable from a standalone-born one
    const forbiddenExt = new Set([...OP_STATE, ...IDENTITY_EXT, 'world', ...PROVIDER_NAMESPACES]);
    for (const r of db.prepare('SELECT id, name, card FROM characters').all()) {
        const card = JSON.parse(r.card);
        const label = `char ${r.name || r.id}`;
        check(Object.keys(card).every(k => ['spec', 'spec_version', 'data'].includes(k)),
            `${label}: stored card has root keys beyond the wrapper`, 'purity');
        check(card.data?.tags === undefined, `${label}: stored card carries data.tags`, 'purity');
        const ext = card.data?.extensions || {};
        for (const k of Object.keys(ext)) {
            check(!forbiddenExt.has(k), `${label}: stored card carries extensions.${k}`, 'purity');
        }
        check(ext.cl?.uid === undefined, `${label}: stored card carries extensions.cl.uid`, 'purity');
    }

    // cheap structural invariants, the classes the integrity check enforces
    for (const r of db.pragma('foreign_key_check')) {
        flag(`FK violation: ${r.table} rowid ${r.rowid} -> ${r.parent}`, 'structure');
    }
    for (const r of db.prepare(`SELECT ch.id FROM chats ch WHERE ch.message_count !=
        (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = ch.id)`).all()) {
        flag(`chat ${r.id}: message_count drifted`, 'structure');
    }
    for (const r of db.prepare(`SELECT w.name FROM worlds w WHERE w.entry_count !=
        (SELECT COUNT(*) FROM world_entries e WHERE e.world_name = w.name)`).all()) {
        flag(`world ${r.name}: entry_count drifted`, 'structure');
    }
    for (const r of db.prepare(`SELECT t.name FROM tags t WHERE t.char_count !=
        (SELECT COUNT(*) FROM char_tags ct WHERE ct.tag_id = t.id)`).all()) {
        flag(`tag ${r.name}: char_count drifted`, 'structure');
    }

    return { checked, findings, groups: [...kinds].map(([kind, count]) => ({ kind, count })) };
}
