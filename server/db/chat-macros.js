// what a chat's macros set lands with the write that caused it, one transaction, so a guard refusing any part leaves none

import { upsertChat, appendChatMessage, patchChat, patchChatMessage } from './chats-store.js';
import { patchSettings } from './settings-store.js';

// the account's global macro variables ({{setglobalvar}}, {{$name}}), one settings row
export const GLOBAL_VARIABLES_KEY = 'macroGlobalVariables';

/** A new chat, with the global variables its greeting set. */
export function createChatWithMacros(db, chat, { globals = null } = {}) {
    return db.transaction(() => {
        if (globals) patchSettings(db, { [GLOBAL_VARIABLES_KEY]: globals });
        return upsertChat(db, chat);
    })();
}

/**
 * A turn appended with what its macros set.
 * @returns {{seq: number, message: object}|null} null when the chat is gone, nothing written
 */
export function appendMessageWithMacros(db, chatId, message, { metadata = {}, globals = null } = {}) {
    return db.transaction(() => {
        const stored = appendChatMessage(db, chatId, message, { chatMetadata: metadata });
        if (stored && globals) patchSettings(db, { [GLOBAL_VARIABLES_KEY]: globals });
        return stored;
    })();
}

/** What an expansion over a stored chat set: metadata keys, the globals, and message 0's shown text (null leaves it). */
export function commitChatMacros(db, chatId, { metadata = {}, globals = null, firstMessage = null } = {}) {
    db.transaction(() => {
        if (Object.keys(metadata).length) patchChat(db, chatId, { chatMetadata: metadata });
        if (globals) patchSettings(db, { [GLOBAL_VARIABLES_KEY]: globals });
        if (firstMessage !== null) patchChatMessage(db, chatId, 0, { mes: firstMessage });
    })();
}
