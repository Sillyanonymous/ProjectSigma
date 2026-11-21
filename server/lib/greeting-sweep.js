// Expands the macros in stored greetings (row 0) once per library, as a reader's PATCH would; a store document marks it done
import { forEachAccountLibrary } from '../db/server-store.js';
import { openDb } from '../db/database.js';
import { readDocument, readDocumentFromFile, writeDocument } from '../db/documents-store.js';
import { greetingCandidatePage } from '../db/chats-store.js';
import { expandStoredGreeting } from '../llm/prompt.js';
import { nextTurn } from './steps.js';

export const GREETINGS_SWEPT_KEY = 'greetings-expanded';
// the chats one turn of the event loop reads row 0 of, and expands where it holds a macro
export const GREETING_PAGE = 25;

/** One library, a page of chats a turn; the done document lands after the last page so a cut sweep reruns. */
export async function sweepGreetings(db, { now = Date.now(), pause = nextTurn } = {}) {
    if (readDocument(db, GREETINGS_SWEPT_KEY)) return 0;
    let changed = 0;
    for (let after = ''; after !== null;) {
        await pause();
        const page = greetingCandidatePage(db, after, GREETING_PAGE);
        for (const chatId of page.ids) if (expandStoredGreeting(db, chatId)) changed++;
        after = page.last;
    }
    writeDocument(db, GREETINGS_SWEPT_KEY, { at: now, changed });
    return changed;
}

/** Every account's library, each on its own; one already swept is never opened (its marker is read from the file). */
export async function sweepAllGreetings({ serverDb = null, log = () => {}, pause = nextTurn } = {}) {
    const failed = (handle, e) => log(`[greetings] sweep failed for ${handle}: ${e.message}`);
    await pause();
    const due = [];
    forEachAccountLibrary({ serverDb, enabledOnly: false, onError: failed }, ({ handle, paths }) => {
        if (!readDocumentFromFile(paths.dbFile, GREETINGS_SWEPT_KEY)) due.push(handle);
    });
    for (const handle of due) {
        try {
            const changed = await sweepGreetings(openDb(handle), { pause });
            if (changed) log(`[greetings] ${handle}: ${changed} stored greeting(s) expanded`);
        } catch (e) { failed(handle, e); }
    }
}
