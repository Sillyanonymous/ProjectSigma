import { Router } from 'express';
import {
    listScripts, getScript, addScripts, updateScript, deleteScript, reorderScripts,
    characterScripts, setCharacterScripts, setConsent, scriptsForChat, scriptError,
} from '../db/regex-store.js';
import { getCharacter } from '../db/characters-store.js';
import { getPreset } from '../db/presets-store.js';
import { getChatDetail } from '../db/chats-store.js';
import { readChatForPrompt, readChatNames } from '../llm/prompt.js';
import { isStopped, clearStopped, testScript, tryOnScreen } from '../lib/regex/run.js';
import { PLACE, takesPass, screenPlace, systemLine } from '../lib/regex/engine.js';

export const regexRouter = Router();

const PLACES = Object.values(PLACE);
// an id, or null: a list is the reader's own when no preset is named
const idOf = (v) => (typeof v === 'string' && v ? v : null);
const flagged = (db, list) => list.map(s => (isStopped(db, s) ? { ...s, stopped: true } : s));

// a save tests the script over a sample first: one that runs out of time there is refused, never stored
function refuseRunaway(script, sample) {
    if (typeof sample !== 'string' || !sample) return null;
    return testScript(script, sample).error === 'timeout' ? 'this pattern took too long on the sample text, so it was not saved' : null;
}

// ---------------------------------------------------------------- what a chat runs

// the newest rows a chat opens on, which the page's own pass meets first
const SCREEN_TRIED = 50;

// a shown row's texts with the placement each takes on screen (mes is the active alternate)
function shownTexts(db, chatId) {
    const out = [];
    for (const { raw: m } of getChatDetail(db, chatId, { msgTail: SCREEN_TRIED })?.messages || []) {
        // the page passes hidden rows too; only SillyTavern's own system lines take no script
        if (!m || systemLine(m)) continue;
        out.push({ text: m.mes, where: screenPlace(m) });
        if (typeof m.extra?.reasoning === 'string') out.push({ text: m.extra.reasoning, where: PLACE.reasoning });
    }
    return out;
}

regexRouter.get('/chat/:chatId', (req, res) => {
    const found = scriptsForChat(req.db, req.params.chatId);
    if (!found) return res.status(404).json({ error: 'no such chat' });
    const read = readChatNames(req.db, req.params.chatId);
    const names = { user: read?.userName ?? 'User', char: read?.charName ?? 'Character' };
    // the page runs the display scripts itself: tried here first on the rows it opens on, a runaway reaches it stopped
    if (found.active.some(s => takesPass(s, 'screen'))) tryOnScreen(req.db, found.active, shownTexts(req.db, req.params.chatId), names);
    res.json({
        yours: flagged(req.db, found.yours),
        preset: found.preset ? { ...found.preset, scripts: flagged(req.db, found.preset.scripts) } : null,
        character: found.character ? { ...found.character, scripts: flagged(req.db, found.character.scripts) } : null,
        active: flagged(req.db, found.active),
        // the names the screen's pass fills {{user}} and {{char}} with
        names,
    });
});

// ---------------------------------------------------------------- the reader's and a preset's lists

regexRouter.get('/scripts', (req, res) => {
    const presetId = idOf(req.query.presetId);
    if (presetId && !getPreset(req.db, presetId)) return res.status(404).json({ error: 'no such preset' });
    res.json({ presetId, scripts: flagged(req.db, listScripts(req.db, presetId)) });
});

regexRouter.post('/scripts', (req, res) => {
    const presetId = idOf(req.body?.presetId);
    const scripts = Array.isArray(req.body?.scripts) ? req.body.scripts : req.body?.script ? [req.body.script] : null;
    if (!scripts || !scripts.length) return res.status(400).json({ error: 'send script, or scripts as a list' });
    for (const [i, s] of scripts.entries()) {
        const err = scriptError(s, scripts.length > 1 ? i : null);
        if (err) return res.status(400).json({ error: err });
    }
    const runaway = scripts.length === 1 ? refuseRunaway(scripts[0], req.body?.sample) : null;
    if (runaway) return res.status(422).json({ error: runaway, kind: 'timeout' });
    res.json({ scripts: addScripts(req.db, { presetId, scripts, after: typeof req.body?.after === 'string' ? req.body.after : null }) });
});

regexRouter.patch('/scripts/:id', (req, res) => {
    const held = getScript(req.db, req.params.id);
    if (!held) return res.status(404).json({ error: 'no such script' });
    const err = scriptError(req.body?.script);
    if (err) return res.status(400).json({ error: err });
    const runaway = refuseRunaway(req.body.script, req.body?.sample);
    if (runaway) return res.status(422).json({ error: runaway, kind: 'timeout' });
    clearStopped(req.db, held.script);
    const script = updateScript(req.db, req.params.id, req.body.script);
    clearStopped(req.db, script);
    res.json({ script });
});

regexRouter.delete('/scripts/:id', (req, res) => {
    if (!deleteScript(req.db, req.params.id)) return res.status(404).json({ error: 'no such script' });
    res.json({ ok: true });
});

regexRouter.put('/order', (req, res) => {
    res.json({ scripts: flagged(req.db, reorderScripts(req.db, idOf(req.body?.presetId), req.body?.ids)) });
});

// ---------------------------------------------------------------- a character's list, on its card

regexRouter.get('/characters/:charId', (req, res) => {
    const character = getCharacter(req.db, req.params.charId);
    if (!character) return res.status(404).json({ error: 'no such character' });
    res.json({ scripts: flagged(req.db, characterScripts(character)) });
});

regexRouter.put('/characters/:charId', (req, res) => {
    const scripts = req.body?.scripts;
    if (!Array.isArray(scripts)) return res.status(400).json({ error: 'scripts must be a list' });
    for (const [i, s] of scripts.entries()) {
        const err = scriptError(s, i);
        if (err) return res.status(400).json({ error: err });
    }
    // the window's save tries the list on the editor's sample first, as a save of one of your scripts does
    for (const s of scripts.filter(x => !x?.disabled)) {
        const runaway = refuseRunaway(s, req.body?.sample);
        if (runaway) return res.status(422).json({ error: runaway, kind: 'timeout' });
    }
    // cleared by the scripts as stored, so an older file's spelling of a field still finds its stop
    const saved = setCharacterScripts(req.db, req.params.charId, scripts);
    for (const s of saved) clearStopped(req.db, s);
    res.json({ scripts: saved });
});

// ---------------------------------------------------------------- consent

regexRouter.put('/consent', (req, res) => {
    const { presetId = null, charId = null } = req.body || {};
    const answer = req.body?.answer;
    if (answer === undefined) return res.status(400).json({ error: "answer is 'allowed', 'declined' or null" });
    res.json({ answer: setConsent(req.db, { presetId: idOf(presetId), charId: idOf(charId) }, answer) });
});

// ---------------------------------------------------------------- the tester and export

regexRouter.post('/test', (req, res) => {
    const err = scriptError(req.body?.script);
    if (err) return res.status(400).json({ error: err });
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    const where = PLACES.includes(Number(req.body?.where)) ? Number(req.body.where) : PLACE.aiOutput;
    const depth = Number.isInteger(req.body?.depth) ? req.body.depth : undefined;
    const chatId = typeof req.body?.chatId === 'string' ? req.body.chatId : null;
    const read = chatId ? readChatForPrompt(req.db, chatId) : null;
    // the macros the chat's prompt expands with, or none without a chat
    const macros = read ? read.expand : (t) => String(t);
    res.json(testScript(req.body.script, text, { where, depth, macros, charName: read?.charName }));
});

regexRouter.get('/export', (req, res) => {
    const charId = typeof req.query.charId === 'string' ? req.query.charId : null;
    if (charId) {
        const character = getCharacter(req.db, charId);
        if (!character) return res.status(404).json({ error: 'no such character' });
        return res.json(characterScripts(character));
    }
    const presetId = idOf(req.query.presetId);
    if (presetId && !getPreset(req.db, presetId)) return res.status(404).json({ error: 'no such preset' });
    res.json(listScripts(req.db, presetId));
});
