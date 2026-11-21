// the library's invariants as ONE list the verify tool and the tests run; each check answers [] or one string per violation
import fs from 'node:fs';
import path from 'node:path';
import { computeTokenEstimate, oneLineName } from './characters-store.js';
import { parseStDate, deleteChatMessage } from './chats-store.js';
import { TAG_RUN_KEEP } from './tag-runs-store.js';
import { PROFILE_POINTERS } from './llm-profiles-store.js';
import { cardContentHash } from '../lib/card-hash.js';
import { cardFingerprint } from '../lib/duplicate-match.js';
import { missingSearchTerms } from './card-text-search.js';
import { PROVIDER_NAMESPACES } from '../lib/provider-namespaces.js';
import { CHAT_COUNTER_TRIGGERS, CHAT_LAST_MES_SQL, CHAR_CHAT_TRIGGERS, CHAR_CHAT_COUNT_SQL, CHAR_LAST_CHAT_SQL, TAG_COUNT_TRIGGERS, FINGERPRINT_TRIGGERS } from './database.js';

// every ordered relation: (table, carrier column); the global list has no carrier
const BINDING_TABLES = [
    ['char_tags', 'char_id'], ['char_worlds', 'char_id'], ['chat_worlds', 'chat_id'],
    ['persona_worlds', 'persona_id'], ['global_worlds', null],
];
const WORLD_BINDING_TABLES = ['char_worlds', 'chat_worlds', 'persona_worlds', 'global_worlds'];
// settings pointers into other tables: one at a gone row resolves to nothing and silently changes what a chat is sent
const SETTINGS_POINTERS = [
    ['activePersonaId', 'personas'], ['activePresetId', 'presets'], ...PROFILE_POINTERS.map(key => [key, 'llm_profiles']),
];
const SCHEMA_TRIGGERS = [
    'trg_characters_fts_ai', 'trg_characters_fts_ad', 'trg_characters_fts_au',
    'trg_chat_messages_fts_ai', 'trg_chat_messages_fts_ad', 'trg_chat_messages_fts_au',
    'trg_world_entries_fts_ai', 'trg_world_entries_fts_ad', 'trg_world_entries_fts_au',
    ...CHAT_COUNTER_TRIGGERS,
    ...CHAR_CHAT_TRIGGERS,
    ...TAG_COUNT_TRIGGERS,
    ...FINGERPRINT_TRIGGERS,
];

const tableSql = (db, name) => db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name)?.sql || '';

/**
 * name: what both consumers report under; currentSchema: skipped on a home not yet migrated; files: stats the disk (--db-only skips it).
 */
export const INVARIANTS = [
    { name: 'foreignKeys', title: 'foreign keys: no orphaned rows anywhere',
      run: (db) => db.pragma('foreign_key_check').map(r => `fk violation: ${JSON.stringify(r)}`) },
    { name: 'sqliteIntegrity', title: 'sqlite integrity_check',
      run: (db) => { const rows = db.pragma('integrity_check'); return rows.length === 1 && rows[0].integrity_check === 'ok' ? [] : rows.map(r => `integrity: ${JSON.stringify(r)}`); } },
    // the rank argument is the whole check: without it fts5 only proves the index well-formed and passes a stale one
    { name: 'ftsCharactersSync', title: 'characters_fts index matches its rows',
      run: (db) => { try { db.prepare("INSERT INTO characters_fts(characters_fts, rank) VALUES ('integrity-check', 1)").run(); return []; } catch (e) { return [`characters_fts out of sync: ${e.message}`]; } } },
    { name: 'ftsChatsSync', title: 'chat_messages_fts index matches its rows',
      run: (db) => { try { db.prepare("INSERT INTO chat_messages_fts(chat_messages_fts, rank) VALUES ('integrity-check', 1)").run(); return []; } catch (e) { return [`chat_messages_fts out of sync: ${e.message}`]; } } },
    { name: 'ftsWorldEntriesSync', title: 'world_entries_fts index matches its rows', currentSchema: true,
      run: (db) => { try { db.prepare("INSERT INTO world_entries_fts(world_entries_fts, rank) VALUES ('integrity-check', 1)").run(); return []; } catch (e) { return [`world_entries_fts out of sync: ${e.message}`]; } } },
    // a piece of a word finds its words through search_terms, so an indexed word it lacks (no pending row aside) is a missed search
    { name: 'searchTermsCover', title: 'search_terms holds every word characters_fts indexes, but those of a pending row', currentSchema: true,
      run: (db) => (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'search_terms'").get() ? ['search_terms is missing (the library is behind migration 81)']
          : missingSearchTerms(db).slice(0, 20).map(t => `search_terms lacks the indexed word '${t}', and no pending row holds it`)) },
    { name: 'triggersExist', title: 'every schema trigger is present (FTS, the chat counters, the character chat counters, the tag carrier counts)', currentSchema: true,
      run: (db) => { const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map(r => r.name)); return SCHEMA_TRIGGERS.filter(n => !have.has(n)).map(n => `missing trigger: ${n}`); } },
    // the FK makes this structurally true; checking it by name fails a rebuild that drops the FK text
    { name: 'worldBindings', title: 'every binding names an existing world through the FK', currentSchema: true,
      run: (db) => {
          const out = [];
          for (const t of WORLD_BINDING_TABLES) {
              if (!/REFERENCES worlds\(name\) ON DELETE CASCADE ON UPDATE CASCADE/.test(tableSql(db, t))) out.push(`${t}: no FK to worlds`);
              const n = db.prepare(`SELECT COUNT(*) n FROM ${t} b WHERE NOT EXISTS (SELECT 1 FROM worlds w WHERE w.name = b.world_name)`).get().n;
              if (n) out.push(`${t}: ${n} binding(s) name a world that does not exist`);
          }
          return out;
      } },
    { name: 'worldSources', title: 'every world source names an existing world through the FK', currentSchema: true,
      run: (db) => {
          const out = [];
          if (!/REFERENCES worlds\(name\) ON DELETE CASCADE ON UPDATE CASCADE/.test(tableSql(db, 'world_sources'))) out.push('world_sources: no FK to worlds');
          const n = db.prepare('SELECT COUNT(*) n FROM world_sources s WHERE NOT EXISTS (SELECT 1 FROM worlds w WHERE w.name = s.world_name)').get().n;
          if (n) out.push(`world_sources: ${n} source(s) name a world that does not exist`);
          return out;
      } },
    // an ordered list is one pos per row: two rows on one pos have no order, and the
    // head-slot rule reads "the row at pos 0"
    { name: 'bindingPositions', title: 'ordered relations carry one row per position', currentSchema: true,
      run: (db) => {
          const out = [];
          for (const [t, key] of BINDING_TABLES) {
              const rows = key
                  ? db.prepare(`SELECT ${key} AS carrier, pos, COUNT(*) n FROM ${t} GROUP BY ${key}, pos HAVING n > 1`).all()
                  : db.prepare(`SELECT NULL AS carrier, pos, COUNT(*) n FROM ${t} GROUP BY pos HAVING n > 1`).all();
              for (const r of rows) out.push(`${t}: ${r.n} rows on pos ${r.pos}${r.carrier ? ` of ${r.carrier}` : ''}`);
          }
          return out;
      } },
    // any stored column behind the card walks its overflow chain on every read; no allow-list, a new column means a rebuild
    { name: 'recordLayout', title: 'characters: nothing stored behind the card blob', currentSchema: true,
      run: (db) => {
          const cols = db.prepare('SELECT cid, name, hidden FROM pragma_table_xinfo(?)').all('characters');
          const card = cols.find(c => c.name === 'card');
          if (!card) return ['characters has no card column'];
          return cols.filter(c => c.cid > card.cid && c.hidden !== 2)
              .map(c => `characters.${c.name} is stored after card (cid ${c.cid} > ${card.cid}): every read of it walks the card overflow chain. Add the column in a table rebuild, not an ALTER TABLE.`);
      } },
    // the derived chat columns recompute from the rows by the trigger's own expression, so a missed firing shows
    { name: 'chatCounters', title: 'chats: message_count, last_mes and last_mes_at match their rows',
      run: (db, { schemaCurrent = true } = {}) => {
          const out = [];
          const expected = db.prepare(`SELECT id, name, message_count, last_mes, last_mes_at,
              (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = chats.id) AS real_count,
              (${CHAT_LAST_MES_SQL('chats.id')}) AS real_last FROM chats`).all();
          for (const ch of expected) {
              if (ch.message_count !== ch.real_count) out.push(`chat "${ch.name}": message_count ${ch.message_count} != ${ch.real_count} rows`);
              // a home not yet migrated still holds the JS-sliced preview and isnt wrong
              if (schemaCurrent && (ch.last_mes ?? null) !== (ch.real_last ?? null)) out.push(`chat "${ch.name}": last_mes drifted`);
              let lastAt = null;
              for (const r of db.prepare('SELECT data FROM chat_messages WHERE chat_id = ?').all(ch.id)) {
                  const at = parseStDate(JSON.parse(r.data)?.send_date);
                  if (at && (!lastAt || at > lastAt)) lastAt = at;
              }
              if ((ch.last_mes_at ?? null) !== lastAt) out.push(`chat "${ch.name}": last_mes_at ${ch.last_mes_at} != ${lastAt}`);
          }
          return out;
      } },
    // create_date is a sort key the cursor bounds on: a NULL is a writer that forgot, and a row the cursor would skip
    { name: 'chatCreateDate', title: 'chats: every row carries a create_date', currentSchema: true,
      run: (db) => db.prepare('SELECT name FROM chats WHERE create_date IS NULL').all().map(r => `chat "${r.name}": create_date is NULL`) },
    // the DEFAULT 0 exists only so the ALTER could add the column NOT NULL; a 0 is a writer that forgot the stamp
    { name: 'worldCreatedAt', title: 'worlds: every row carries a created_at', currentSchema: true,
      run: (db) => db.prepare('SELECT name FROM worlds WHERE created_at IS NULL OR created_at <= 0').all().map(r => `world "${r.name}": created_at is missing`) },
    // recomputed by the trigger's own expressions, filtered in SQL so a big home pays index probes, not a JS walk
    { name: 'charChatCounters', title: 'characters: chat_count and last_chat_at match their chat rows', currentSchema: true,
      run: (db) => db.prepare(`SELECT c.name, c.chat_count, c.last_chat_at,
              (${CHAR_CHAT_COUNT_SQL('c.id')}) AS real_count, (${CHAR_LAST_CHAT_SQL('c.id')}) AS real_last
          FROM characters c
          WHERE c.chat_count != (${CHAR_CHAT_COUNT_SQL('c.id')}) OR c.last_chat_at IS NOT (${CHAR_LAST_CHAT_SQL('c.id')})`).all()
          .map(r => r.chat_count !== r.real_count
              ? `char "${r.name}": chat_count ${r.chat_count} != ${r.real_count} rows`
              : `char "${r.name}": last_chat_at ${r.last_chat_at} != ${r.real_last}`) },
    // a seq is a position and a delete renumbers what follows, so a gap names nothing
    { name: 'chatSeqsContiguous', title: 'chat_messages: seqs run 0..n-1 with no gaps',
      run: (db) => db.prepare('SELECT chat_id, MIN(seq) lo, MAX(seq) hi, COUNT(*) n FROM chat_messages GROUP BY chat_id HAVING lo != 0 OR hi + 1 != n').all()
          .map(r => `chat ${r.chat_id}: seqs ${r.lo}..${r.hi} over ${r.n} rows`) },
    // a row holding null, a number, a string or an array is no message; the repair deletes each, newest seq first per chat
    { name: 'chatMessageObjects', title: 'chat_messages: every row holds a message object', currentSchema: true,
      run: (db) => db.prepare("SELECT chat_id, seq, json_type(data) AS t FROM chat_messages WHERE json_type(data) != 'object'").all()
          .map(r => `chat ${r.chat_id} seq ${r.seq}: the row holds ${r.t === 'null' ? 'null' : `a JSON ${r.t}`}, not a message`),
      repair: (db) => {
          const rows = db.prepare("SELECT chat_id, seq FROM chat_messages WHERE json_type(data) != 'object' ORDER BY chat_id, seq DESC").all();
          db.transaction(() => { for (const r of rows) deleteChatMessage(db, r.chat_id, r.seq); })();
          return rows.length;
      } },
    // prompt assembly reads mes and the transcript shows swipes[swipe_id]: a row where they differ sends one text and shows another
    { name: 'swipeActiveAligned', title: 'chat_messages: mes is the active alternate on every row with alternates', currentSchema: true,
      run: (db) => {
          const out = [];
          for (const r of db.prepare("SELECT chat_id, seq, data FROM chat_messages WHERE json_type(data, '$.swipes') = 'array' AND json_array_length(data, '$.swipes') > 0").iterate()) {
              let m; try { m = JSON.parse(r.data); } catch { out.push(`chat ${r.chat_id} seq ${r.seq}: data is not JSON`); continue; }
              const i = Math.min(Math.max(Number.isInteger(m.swipe_id) ? m.swipe_id : 0, 0), m.swipes.length - 1);
              if (m.swipes[i] !== (typeof m.mes === 'string' ? m.mes : '')) out.push(`chat ${r.chat_id} seq ${r.seq}: mes is not alternate ${i} of ${m.swipes.length}`);
          }
          return out;
      } },
    // a message's pictures are its chat's: a link to another owner's picture would show it in a chat that does not hold it
    { name: 'messagePicturesInChat', title: 'message_attachments: every picture a message shows belongs to its own chat', currentSchema: true,
      run: (db) => db.prepare(`
          SELECT m.chat_id, m.seq, a.id FROM message_attachments ma JOIN chat_messages m ON m.id = ma.message_id JOIN attachments a ON a.id = ma.attachment_id
          WHERE a.chat_id IS NOT m.chat_id
      `).all().map(r => `chat ${r.chat_id} seq ${r.seq}: shows attachment #${r.id}, which is not this chat's`) },
    // the links are the record: a stored row holding the composed key would be read beside them and drift from them
    { name: 'messagePicturesDiverted', title: 'chat_messages: no stored row holds extra.attachments', currentSchema: true,
      run: (db) => db.prepare("SELECT chat_id, seq FROM chat_messages WHERE json_type(data, '$.extra.attachments') IS NOT NULL").all()
          .map(r => `chat ${r.chat_id} seq ${r.seq}: extra.attachments stored on the row instead of its links`) },
    { name: 'worldCounters', title: 'worlds: entry_count matches entry rows',
      run: (db) => db.prepare('SELECT w.name, w.entry_count, (SELECT COUNT(*) FROM world_entries e WHERE e.world_name = w.name) AS real FROM worlds w').all()
          .filter(r => r.entry_count !== r.real).map(r => `world "${r.name}": entry_count ${r.entry_count} != ${r.real} rows`) },
    // a placeholder holding an entry is a book, and the flag would hide it from every picker
    { name: 'placeholders', title: 'worlds: a placeholder holds no entries', currentSchema: true,
      run: (db) => db.prepare('SELECT name, entry_count, (SELECT COUNT(*) FROM world_entries e WHERE e.world_name = w.name) AS real FROM worlds w WHERE placeholder = 1 AND (entry_count != 0 OR real != 0)').all()
          .map(r => `world "${r.name}": flagged placeholder with ${r.real} entries`) },
    { name: 'tokenEstimates', title: 'characters: token estimates match their cards',
      run: (db) => {
          const out = [];
          for (const r of db.prepare('SELECT id, name, token_estimate, card FROM characters').iterate()) {
              const expect = computeTokenEstimate(JSON.parse(r.card).data || {});
              if (r.token_estimate !== expect) out.push(`char "${r.name}": token_estimate ${r.token_estimate} != ${expect}`);
          }
          return out;
      } },
    // the H leg of the no-overwrite import triage answers off this column; a drifted
    // hash silently turns identical-skip into a duplicate (or worse, vice versa)
    { name: 'contentHashes', title: 'characters: content hashes match their cards', currentSchema: true,
      run: (db) => {
          const out = [];
          for (const r of db.prepare('SELECT id, name, content_hash, card FROM characters').iterate()) {
              if (r.content_hash !== cardContentHash(JSON.parse(r.card))) out.push(`char "${r.name}": content_hash drifted from its card`);
          }
          return out;
      } },
    // the duplicate rule finds a card by its fingerprint alone: one missing hides it from every duplicate check, a stale one misjudges it
    { name: 'fingerprints', title: 'characters: every card has its fingerprint, or waits on the queue for it', currentSchema: true,
      run: (db) => {
          const out = [];
          const same = (a, b) => (a ?? null) === (b ?? null);
          for (const r of db.prepare(`SELECT c.id, c.name, c.card, f.char_id AS fid, f.name_key, f.name_key2, f.creator_key, f.sig, f.sig_mask, f.band0, f.band1, f.band2, f.band3,
                  EXISTS (SELECT 1 FROM fingerprints_pending p WHERE p.rid = c.rowid) AS queued
                  FROM characters c LEFT JOIN character_fingerprints f ON f.char_id = c.id`).iterate()) {
              if (r.queued) continue;
              if (!r.fid) { out.push(`char "${r.name}": no fingerprint, and not waiting for one`); continue; }
              const f = cardFingerprint(JSON.parse(r.card).data || {});
              const sig = f.mask ? f.sig : null;
              const bands = f.bands || [null, null, null, null];
              if (r.name_key !== f.nameKey || !same(r.name_key2, f.nameKey2) || !same(r.creator_key, f.creatorKey || null) || r.sig_mask !== f.mask
                  || !(sig ? r.sig && Buffer.compare(r.sig, sig) === 0 : r.sig == null) || [r.band0, r.band1, r.band2, r.band3].some((b, k) => !same(b, bands[k]))) {
                  out.push(`char "${r.name}": fingerprint drifted from its card`);
              }
          }
          return out;
      } },
    { name: 'noZeroUseTags', title: 'tags: no row without a carrier',
      run: (db) => db.prepare('SELECT name FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM char_tags)').all().map(r => `zero-use tag row: "${r.name}"`) },
    // the most used order walks this count, so a missed firing reorders the list; one probe of the tag index a tag
    { name: 'tagCounts', title: 'tags: char_count matches the links', currentSchema: true,
      run: (db) => db.prepare(`SELECT t.name, t.char_count, (SELECT COUNT(*) FROM char_tags ct WHERE ct.tag_id = t.id) AS real FROM tags t
          WHERE t.char_count != (SELECT COUNT(*) FROM char_tags ct WHERE ct.tag_id = t.id)`).all()
          .map(r => `tag "${r.name}": char_count ${r.char_count} != ${r.real} links`) },
    // lifted state never sits in a stored card (a row would shadow it), nor what the import strips; unmigrated homes skip the last two
    { name: 'storedCardHygiene', title: 'characters: nothing lifted is stored behind the card blob',
      run: (db, { schemaCurrent = true } = {}) => {
          const out = [];
          for (const r of db.prepare('SELECT id, name, card FROM characters').iterate()) {
              let card;
              try { card = JSON.parse(r.card); } catch { out.push(`char "${r.name}": stored card is not json`); continue; }
              if (card.data?.tags !== undefined) out.push(`char "${r.name}": data.tags in stored card`);
              if (card.name !== undefined) out.push(`char "${r.name}": root V1 mirror in stored card`);
              const ext = card.data?.extensions || {};
              for (const bad of ['world', 'update_locked', 'fav', ...PROVIDER_NAMESPACES]) {
                  if (ext[bad] !== undefined) out.push(`char "${r.name}": extensions.${bad} in stored card`);
              }
              if (ext.cl?.uid !== undefined) out.push(`char "${r.name}": extensions.cl.uid in stored card`);
              if (!schemaCurrent) continue;
              if (card.data && 'avatar' in card.data) out.push(`char "${r.name}": data.avatar in stored card`);
              const folded = { data: { name: card.data?.name } };
              oneLineName(folded);
              if (folded.data.name !== card.data?.name) out.push(`char "${r.name}": the name is not in its stored form (one line, at most the cap)`);
          }
          return out;
      } },
    { name: 'noSelfAliases', title: 'char_aliases: no cl_uid self-alias',
      run: (db) => db.prepare("SELECT char_id FROM char_aliases WHERE kind = 'cl_uid' AND value = char_id").all().map(r => `cl_uid self-alias on ${r.char_id}`) },
    // gallery_id rows are never minted; one coming back means a lift crept back into an import path
    { name: 'noGalleryAliases', title: 'char_aliases: no gallery_id rows', currentSchema: true,
      run: (db) => { const n = db.prepare("SELECT COUNT(*) n FROM char_aliases WHERE kind = 'gallery_id'").get().n; return n ? [`${n} gallery_id alias row(s)`] : []; } },
    // one provider link per character, enforced twice: the rows, and the unique index that makes a second row impossible
    { name: 'oneLinkPerCharacter', title: 'provider_links: one row per character, and the index that keeps it so', currentSchema: true,
      run: (db) => {
          const out = db.prepare('SELECT char_id, COUNT(*) n FROM provider_links GROUP BY char_id HAVING n > 1').all().map(r => `char ${r.char_id}: ${r.n} provider_links rows`);
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_provider_links_one_per_char'").get()) out.push('unique index idx_provider_links_one_per_char is missing');
          return out;
      } },
    // ids that leave the database (thumb cache files, a message id a reader holds) are never reused, or a recycled rowid inherits them
    { name: 'externallyKeyedIdsAreMonotonic', title: 'externally-keyed ids are AUTOINCREMENT', currentSchema: true,
      run: (db) => ['media', 'backgrounds', 'chat_messages', 'attachments'].filter(t => !/AUTOINCREMENT/.test(tableSql(db, t))).map(t => `${t}.id is a reusable rowid but leaks outside the db`) },
    // a snapshot id leaks the same way and its composite key cant be AUTOINCREMENT, so a per-character mark stays above it
    { name: 'snapshotIdsNeverReused', title: 'versions: each character\'s id mark is at or above its highest snapshot id', currentSchema: true,
      run: (db) => db.prepare(`
          SELECT v.char_id, MAX(v.snap_id) AS top, s.last FROM versions v LEFT JOIN version_seq s ON s.char_id = v.char_id
          WHERE v.snap_id >= 0 AND typeof(v.snap_id) = 'integer' GROUP BY v.char_id HAVING s.last IS NULL OR s.last < MAX(v.snap_id)
      `).all().map(r => `char ${r.char_id}: snapshot id ${r.top} above its mark ${r.last ?? 'none'}`) },
    { name: 'settingsParse', title: 'settings: every value is JSON',
      run: (db) => db.prepare('SELECT key, value FROM settings').all().filter(r => { try { JSON.parse(r.value); return false; } catch { return true; } }).map(r => `settings "${r.key}": value is not json`) },
    { name: 'settingsPointers', title: 'settings: every pointer names a row that exists', currentSchema: true,
      run: (db) => {
          const out = [];
          for (const [key, table] of SETTINGS_POINTERS) {
              const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
              if (!row) continue;
              let id;
              try { id = JSON.parse(row.value); } catch { continue; }
              if (typeof id !== 'string' || !id) continue;
              if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) out.push(`settings ${key} names ${table} ${id}, which does not exist`);
          }
          return out;
      } },
    { name: 'tagRunsCap', title: `tag_runs: at most ${TAG_RUN_KEEP} row${TAG_RUN_KEEP === 1 ? '' : 's'}`, currentSchema: true,
      run: (db) => { const n = db.prepare('SELECT COUNT(*) n FROM tag_runs').get().n; return n > TAG_RUN_KEEP ? [`tag_runs holds ${n} rows, keep is ${TAG_RUN_KEEP}`] : []; } },
    // rows never point at missing files (orphan FILES are tolerated by the crash-ordering
    // policy; a missing file under a live row is data loss)
    { name: 'filesBackRows', title: 'files back every row', files: true,
      run: (db, { paths }) => {
          const out = [];
          for (const r of db.prepare('SELECT id FROM characters').iterate()) {
              if (!fs.existsSync(path.join(paths.avatarsDir, `${r.id}.png`))) out.push(`char ${r.id}: avatar file missing`);
          }
          for (const m of db.prepare('SELECT id, char_id, file FROM media').iterate()) {
              if (!fs.existsSync(path.join(paths.galleryRoot, m.char_id, m.file))) out.push(`media #${m.id}: file missing`);
          }
          for (const b of db.prepare('SELECT id, file FROM backgrounds').iterate()) {
              if (!fs.existsSync(path.join(paths.backgroundsDir, b.file))) out.push(`background #${b.id}: file missing`);
          }
          // a persona's avatar column is a presence marker: set, it says personas/<id>.png exists
          for (const p of db.prepare('SELECT id FROM personas WHERE avatar IS NOT NULL').iterate()) {
              if (!fs.existsSync(path.join(paths.personaAvatarsDir, `${p.id}.png`))) out.push(`persona ${p.id}: avatar file missing`);
          }
          for (const a of db.prepare('SELECT id, chat_id, studio_id, file FROM attachments').iterate()) {
              if (!fs.existsSync(path.join(paths.attachmentsRoot, a.chat_id ?? a.studio_id, a.file))) out.push(`attachment #${a.id}: file missing`);
          }
          return out;
      } },
];

/**
 * The checks bound to one library: { checks: { name: () => string[] }, skipped: [{name, why}] }.
 * @param {{ paths?: object, dbOnly?: boolean, schemaCurrent?: boolean }} [opts] paths (userPaths') is required unless dbOnly; schemaCurrent false skips the newer-shape checks
 */
export function bindInvariants(db, { paths = null, dbOnly = false, schemaCurrent = true } = {}) {
    const checks = {};
    const skipped = [];
    for (const inv of INVARIANTS) {
        if (inv.currentSchema && !schemaCurrent) { skipped.push({ name: inv.name, why: 'schema is behind; it migrates when the server next opens this home' }); continue; }
        if (inv.files && (dbOnly || !paths)) { skipped.push({ name: inv.name, why: dbOnly ? '--db-only' : 'no paths' }); continue; }
        checks[inv.name] = () => inv.run(db, { paths, schemaCurrent });
    }
    return { checks, skipped };
}

/** Every finding across every bound check, prefixed by check name; [] means clean. */
export function sweepInvariants(db, opts) {
    const { checks } = bindInvariants(db, opts);
    const out = [];
    for (const [name, fn] of Object.entries(checks)) for (const v of fn()) out.push(`[${name}] ${v}`);
    return out;
}
