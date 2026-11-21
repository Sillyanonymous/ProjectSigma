// Regex scripts: the reader's and each preset's as rows, a character's on its card, and consent for the last two.
import crypto from 'node:crypto';
import { emitChange } from './changes.js';
import { getCharacter, patchCharacter } from './characters-store.js';
import { createPreset, getPreset, resolveChatPreset } from './presets-store.js';
import { httpError } from '../lib/http-error.js';
import { PLACE } from '../lib/regex/engine.js';

const MAX_SCRIPTS = 1000;

// ---------------------------------------------------------------- a script's shape

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const flag = (v) => v === true || v === 1 || v === 'true';
// a depth bound: a number, or null for none; numbers written as text read as numbers, blank as none
function depthOf(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
}
// SillyTavern wrote this field as a boolean before its three modes, which number 0 none, 1 raw, 2 escaped
function findMacrosOf(v) {
    if (v === true) return 1;
    const n = Number(v);
    return n === 1 || n === 2 ? n : 0;
}

/** A script in SillyTavern's shape with every field present and typed; fields it does not know are kept, so a file round-trips. */
export function normalizeScript(raw, id) {
    // stopped is the server's own flag on what it answers, never a script's field
    const { stopped, ...s } = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        ...s,
        id,
        scriptName: str(s.scriptName).slice(0, 200),
        findRegex: str(s.findRegex),
        replaceString: str(s.replaceString),
        trimStrings: Array.isArray(s.trimStrings) ? s.trimStrings.filter(t => typeof t === 'string') : [],
        placement: Array.isArray(s.placement) ? [...new Set(s.placement.map(Number).filter(Number.isInteger))] : [],
        disabled: flag(s.disabled),
        markdownOnly: flag(s.markdownOnly),
        promptOnly: flag(s.promptOnly),
        runOnEdit: flag(s.runOnEdit),
        substituteRegex: findMacrosOf(s.substituteRegex),
        minDepth: depthOf(s.minDepth),
        maxDepth: depthOf(s.maxDepth),
        alterSaved: flag(s.alterSaved),
    };
}

/** Why a script as a write sends it is refused (an object, its placements numbers SillyTavern knows), or null. */
export function scriptError(s, i = null) {
    const at = i === null ? 'the script' : `script ${i}`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return `${at} is not an object`;
    if (s.placement !== undefined && (!Array.isArray(s.placement) || s.placement.some(p => !Number.isInteger(Number(p))))) return `${at}'s placement is a list of numbers (${Object.values(PLACE).join(', ')})`;
    for (const k of ['scriptName', 'findRegex', 'replaceString']) if (s[k] !== undefined && typeof s[k] !== 'string') return `${at}'s ${k} must be text`;
    if (s.trimStrings !== undefined && !Array.isArray(s.trimStrings)) return `${at}'s trimStrings is a list of text`;
    return null;
}

const fromRow = (r) => ({ ...JSON.parse(r.data), id: r.id });

// ---------------------------------------------------------------- the reader's and a preset's

function assertPreset(db, presetId) {
    if (presetId !== null && !db.prepare('SELECT 1 FROM presets WHERE id = ?').get(presetId)) throw httpError(404, 'no such preset');
}

/** A list's scripts in run order: the reader's own (presetId null) or a preset's. */
export function listScripts(db, presetId = null) {
    const rows = presetId === null
        ? db.prepare('SELECT id, data FROM regexes WHERE preset_id IS NULL ORDER BY pos, id').all()
        : db.prepare('SELECT id, data FROM regexes WHERE preset_id = ? ORDER BY pos, id').all(presetId);
    return rows.map(fromRow);
}

/** One script with the list it is in, or null. */
export function getScript(db, id) {
    const r = db.prepare('SELECT id, preset_id, data FROM regexes WHERE id = ?').get(id);
    return r ? { presetId: r.preset_id, script: fromRow(r) } : null;
}

function writeOrder(db, ids, now) {
    const set = db.prepare('UPDATE regexes SET pos = ?, updated_at = ? WHERE id = ?');
    ids.forEach((id, pos) => set.run(pos, now, id));
}

/**
 * Add scripts to a list, each with a new id: appended, or placed right after `after` (a duplicate lands below its original).
 * @returns {object[]} the scripts as stored
 */
export function addScripts(db, { presetId = null, scripts, after = null }) {
    assertPreset(db, presetId);
    const list = Array.isArray(scripts) ? scripts : [];
    const existing = listScripts(db, presetId).map(s => s.id);
    if (existing.length + list.length > MAX_SCRIPTS) throw httpError(400, `a list holds at most ${MAX_SCRIPTS} scripts`);
    const now = Date.now();
    const made = list.map(raw => normalizeScript(raw, crypto.randomUUID()));
    db.transaction(() => {
        const insert = db.prepare('INSERT INTO regexes (id, preset_id, pos, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
        for (const s of made) insert.run(s.id, presetId, 0, JSON.stringify(s), now, now);
        const at = after && existing.includes(after) ? existing.indexOf(after) + 1 : existing.length;
        writeOrder(db, [...existing.slice(0, at), ...made.map(s => s.id), ...existing.slice(at)], now);
        if (made.length) emitChange(db, { entity: 'regexScript', op: 'created', ids: made.map(s => s.id) });
    })();
    return made;
}

/** Replace one script's fields; null for an unknown id. */
export function updateScript(db, id, script) {
    const held = getScript(db, id);
    if (!held) return null;
    const next = normalizeScript(script, id);
    db.transaction(() => {
        db.prepare('UPDATE regexes SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), Date.now(), id);
        emitChange(db, { entity: 'regexScript', op: 'updated', ids: [id] });
    })();
    return next;
}

/** Remove one script; whether it was there. */
export function deleteScript(db, id) {
    const held = getScript(db, id);
    if (!held) return false;
    db.transaction(() => {
        db.prepare('DELETE FROM regexes WHERE id = ?').run(id);
        writeOrder(db, listScripts(db, held.presetId).map(s => s.id), Date.now());
        emitChange(db, { entity: 'regexScript', op: 'deleted', ids: [id] });
    })();
    return true;
}

/** Put a list in a new order: ids must name exactly the scripts it holds. */
export function reorderScripts(db, presetId, ids) {
    assertPreset(db, presetId);
    const held = listScripts(db, presetId).map(s => s.id);
    const wanted = Array.isArray(ids) ? ids.map(String) : [];
    if (wanted.length !== held.length || new Set(wanted).size !== wanted.length || wanted.some(id => !held.includes(id))) {
        throw httpError(400, 'ids must name every script in the list, each once');
    }
    db.transaction(() => {
        writeOrder(db, wanted, Date.now());
        emitChange(db, { entity: 'regexScript', op: 'updated', ids: wanted, fields: ['order'] });
    })();
    return listScripts(db, presetId);
}

/** A preset made with its own scripts in one write: a list refused leaves no preset behind. */
export function createPresetWithScripts(db, preset, scripts) {
    return db.transaction(() => {
        const made = createPreset(db, preset);
        if (scripts.length) addScripts(db, { presetId: made.id, scripts });
        return made;
    })();
}

// ---------------------------------------------------------------- a character's, on its card

/** A character's scripts as its card carries them, typed; the card itself is not rewritten. */
export function characterScripts(character) {
    const list = character?.card?.data?.extensions?.regex_scripts;
    // an id the card repeats would send one script's write to another: each repeat reads under its place instead
    const seen = new Set();
    return Array.isArray(list) ? list.map((s, i) => {
        const own = typeof s?.id === 'string' && s.id && !seen.has(s.id) ? s.id : `card-${i}`;
        seen.add(own);
        return normalizeScript(s, own);
    }) : [];
}

/** A character's whole list written onto its card, through the card's own write. */
export function setCharacterScripts(db, charId, scripts) {
    const list = (Array.isArray(scripts) ? scripts : []).map(s => normalizeScript(s, typeof s?.id === 'string' && s.id ? s.id : crypto.randomUUID()));
    if (list.length > MAX_SCRIPTS) throw httpError(400, `a list holds at most ${MAX_SCRIPTS} scripts`);
    const done = patchCharacter(db, charId, { fields: { 'extensions.regex_scripts': list.length ? list : null } }, { answer: false });
    if (!done) throw httpError(404, 'no such character');
    return list;
}

// ---------------------------------------------------------------- consent

const consentRow = (db, { presetId, charId }) => (presetId
    ? db.prepare('SELECT allowed FROM regex_consent WHERE preset_id = ?').get(presetId)
    : db.prepare('SELECT allowed FROM regex_consent WHERE char_id = ?').get(charId));

/** A preset's or a character's answer: 'allowed', 'declined', or null while unanswered. */
export function getConsent(db, owner) {
    const r = consentRow(db, owner);
    return r ? (r.allowed ? 'allowed' : 'declined') : null;
}

/** Answer for a preset or a character: 'allowed', 'declined', or null to forget the answer. */
export function setConsent(db, { presetId = null, charId = null }, answer) {
    if (!presetId === !charId) throw httpError(400, 'name a preset or a character');
    if (presetId) assertPreset(db, presetId);
    else if (!db.prepare('SELECT 1 FROM characters WHERE id = ?').get(charId)) throw httpError(404, 'no such character');
    if (answer !== null && answer !== 'allowed' && answer !== 'declined') throw httpError(400, "answer is 'allowed', 'declined' or null");
    db.transaction(() => {
        if (presetId) db.prepare('DELETE FROM regex_consent WHERE preset_id = ?').run(presetId);
        else db.prepare('DELETE FROM regex_consent WHERE char_id = ?').run(charId);
        if (answer) {
            db.prepare('INSERT INTO regex_consent (preset_id, char_id, allowed, answered_at) VALUES (?, ?, ?, ?)')
                .run(presetId, charId, answer === 'allowed' ? 1 : 0, Date.now());
        }
        emitChange(db, { entity: 'regexConsent', op: 'updated', ids: [presetId || charId], fields: [presetId ? 'preset' : 'character'] });
    })();
    return getConsent(db, { presetId, charId });
}

// what a character's list does, apart from the ids its scripts go by
const listMark = (db, charId) => JSON.stringify(characterScripts(getCharacter(db, charId)).map(({ id, ...s }) => s));

/** The scripts a character's answer of allowed stands for, as a mark; null when it has no such answer. */
export function allowedScriptsMark(db, charId) {
    return getConsent(db, { charId }) === 'allowed' ? listMark(db, charId) : null;
}

/** After a card was written over a character: its answer is forgotten when its scripts are other than the ones allowed. */
export function forgetConsentIfMoved(db, charId, mark) {
    if (mark === null || listMark(db, charId) === mark) return false;
    setConsent(db, { charId }, null);
    return true;
}

// ---------------------------------------------------------------- a chat's scripts

/** A chat's scripts: yours, then its preset's and its character's while allowed; each source whole, with its answer. */
export function scriptsForChat(db, chatId) {
    const yours = listScripts(db, null);
    const chat = chatId ? db.prepare('SELECT char_id FROM chats WHERE id = ?').get(chatId) : null;
    if (chatId && !chat) return null;
    const { presetId, source } = resolveChatPreset(db, chatId || null);
    const preset = presetId ? getPreset(db, presetId) : null;
    const presetPart = preset
        ? { id: preset.id, name: preset.name, source, consent: getConsent(db, { presetId: preset.id }), scripts: listScripts(db, preset.id) }
        : null;
    const character = chat?.char_id ? getCharacter(db, chat.char_id) : null;
    const characterPart = character
        ? { id: character.id, name: character.card?.data?.name || '', consent: getConsent(db, { charId: character.id }), scripts: characterScripts(character) }
        : null;
    const active = [
        ...yours,
        ...(presetPart?.consent === 'allowed' ? presetPart.scripts : []),
        ...(characterPart?.consent === 'allowed' ? characterPart.scripts : []),
    ];
    return { yours, preset: presetPart, character: characterPart, active };
}
