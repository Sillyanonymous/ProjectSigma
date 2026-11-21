// A chat's regex passes at the moments a message is written: a save, an edit, a draft for the composer.
import { scriptsForChat } from '../../db/regex-store.js';
import { readChatForPrompt } from '../../llm/prompt.js';
import { runPass } from './run.js';
import { PLACE, takesPass } from './engine.js';

/**
 * A text as a chat writes it: the save, edit or draft pass over its active scripts, macros from the chat.
 * @param {{ pass?: 'save'|'edit'|'draft', where?: number, charName?: string }} [opts]
 */
export function regexWrite(db, chatId, text, opts = {}) {
    return regexWriteAll(db, chatId, [text], opts)[0];
}

/** Several texts of one chat through one write pass, its scripts and macros read once (a greeting and its alternates). */
export function regexWriteAll(db, chatId, texts, { pass = 'save', where = PLACE.aiOutput, charName, edited = false } = {}) {
    if (!texts.some(t => typeof t === 'string' && t)) return texts;
    const scripts = scriptsForChat(db, chatId)?.active || [];
    if (!scripts.some(s => takesPass(s, pass, { edited }))) return texts;
    const macros = readChatForPrompt(db, chatId)?.expand;
    return texts.map(t => (typeof t === 'string' && t ? runPass(db, t, scripts, { pass, where, macros, charName, edited }) : t));
}
