// The Author's Note, kept in chat metadata under ST's own keys so an imported chat carries its note

import { settingValue } from '../db/settings-store.js';
import { NOTE_POSITION } from './preset.js';

/** The chat_metadata key each part of the note is kept under, the keys SillyTavern's chats carry. */
export const NOTE_KEYS = Object.freeze({
    prompt: 'note_prompt', interval: 'note_interval', depth: 'note_depth', position: 'note_position', role: 'note_role',
});

// the placement codes live in the build's plain-data module, so a store loading presets never pulls in this one
export { NOTE_POSITION };

/** The voice it arrives in, by the code a chat stores. */
export const NOTE_ROLES = Object.freeze(['system', 'user', 'assistant']);

// the default note's settings (ST's values); these fallbacks must match the client's DEFAULT_SETTINGS
const NOTE_DEFAULT_SETTINGS = Object.freeze({
    prompt: ['chatAuthorsNoteDefault', ''],
    interval: ['chatAuthorsNoteDefaultInterval', 1],
    depth: ['chatAuthorsNoteDefaultDepth', 4],
    position: ['chatAuthorsNoteDefaultPosition', NOTE_POSITION.inChat],
    role: ['chatAuthorsNoteDefaultRole', 0],
});
const NOTE_SCAN_SETTING = 'chatAuthorsNoteScanLore';

/** The default note a chat without its own reads, and a new chat is given. */
export function noteDefaults(db) {
    const out = {};
    for (const [part, [key, fallback]] of Object.entries(NOTE_DEFAULT_SETTINGS)) {
        const v = settingValue(db, key, fallback);
        out[part] = part === 'prompt' ? (typeof v === 'string' ? v : '') : (Number.isFinite(Number(v)) ? Number(v) : fallback);
    }
    return out;
}

/** Whether the due note and the card's Character's Note are read by the lore scan (ST: off). */
function noteScansLore(db) {
    return settingValue(db, NOTE_SCAN_SETTING, false) === true;
}

/** The note in force: each part the chat's own, else the default's; only an absent part falls back, a stored empty stays empty. */
export function chatNoteOf(meta, defaults) {
    const own = {};
    const note = {};
    for (const [part, key] of Object.entries(NOTE_KEYS)) {
        const stored = meta?.[key];
        own[part] = stored !== undefined && stored !== null;
        const v = own[part] ? stored : defaults[part];
        note[part] = part === 'prompt' ? String(v ?? '') : Number(v);
    }
    return { ...note, own };
}

/** The keys a chat lacks, from the defaults: what a new chat stores, and what a chat without them keeps once a reply lands. */
export function noteSeed(meta, defaults) {
    const patch = {};
    for (const [part, key] of Object.entries(NOTE_KEYS)) {
        if (meta?.[key] === undefined || meta?.[key] === null) patch[key] = defaults[part];
    }
    return patch;
}

/**
 * When the note is sent, counted in the reader's messages over the whole chat.
 * @returns untilNext is the true count left, not ST's displayed counter
 */
function noteSchedule(userCount, interval) {
    if (!Number.isFinite(interval) || interval <= 0) return { due: false, untilNext: null };
    let count = userCount;
    if (interval === 1) count = 1;
    const due = count > 0 && count >= interval && count % interval === 0;
    return { due, untilNext: due ? 0 : interval - (count % interval) };
}

/** The reader's messages a chat holds, hidden ones included, as ST counts them. */
function readerTurns(messages) {
    let n = 0;
    for (const m of messages) if (m?.is_user) n++;
    return n;
}

/** The due note between the lore anchored above and below it, a line apart, one edge newline dropped each end; not due, nothing. */
export function wrapNote(text, due, top = [], bottom = []) {
    if (!due) return '';
    const joined = [top.join('\n'), text, bottom.join('\n')].join('\n');
    return joined.slice(joined.startsWith('\n') ? 1 : 0, joined.endsWith('\n') ? -1 : undefined);
}

/** Everything a chat's note is right now, for the window and the panel. */
export function chatNoteState(db, meta, messages) {
    const defaults = noteDefaults(db);
    const note = chatNoteOf(meta, defaults);
    const userTurns = readerTurns(messages);
    return { note, defaults, scanLore: noteScansLore(db), userTurns, ...noteSchedule(userTurns, note.interval) };
}
