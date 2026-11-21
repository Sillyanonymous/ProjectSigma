// The end every streamed model reply shares (chat, assistant, studio), and how a failure is answered

import { LlmError, LENGTH_FINISH_REASONS } from './errors.js';
import { sseOpen, sseWrite } from './sse.js';
import { settingValue } from '../db/settings-store.js';
import { profileParams } from '../db/llm-profiles-store.js';
import { closeSignal } from '../lib/request-guard.js';

/** The error a finished stream ends with instead of done (streamed text not stored, or no text), or null. */
export function replyFailure({ content, stored, finishReason, expectsRow = true }) {
    if (!expectsRow || stored) return null;
    if (content) return { kind: 'store', message: 'The reply could not be stored.' };
    return LENGTH_FINISH_REASONS.has(finishReason)
        ? { kind: 'length', message: 'The model spent its whole reply budget reasoning and returned no text. Lower its reasoning effort or raise the max reply tokens.' }
        : { kind: 'empty', message: 'The model returned an empty reply.' };
}

/** A reply's store that failed is said in the log: the stream itself reports it as kind 'store'. */
export function logStoreFailure(surface, err) {
    console.error(`[${surface}] the reply could not be stored:`, err);
}

/** Answer a streamed reply's failure: its last event once the stream is open, else the app's error handler. */
export function answerReplyFailure(res, err) {
    if (res.headersSent) {
        if (!(err instanceof LlmError)) console.error('[reply] a streamed reply failed:', err);
        sseWrite(res, 'error', err instanceof LlmError
            ? { kind: err.kind, message: err.message }
            : { kind: 'upstream', message: err?.message || 'generation failed' });
        res.end();
        return;
    }
    throw err;
}

// a reasoning model with no ceiling can spend a small provider default on thinking; the profile's own wins
const SESSION_MAX_REPLY = 8192;

/** A session reply's params: the request's own, with SESSION_MAX_REPLY when neither they nor the profile name maxTokens. */
export function withReplyCeiling(db, params, profileId) {
    const own = params && typeof params === 'object' ? params : undefined;
    if (own?.maxTokens !== undefined || profileParams(db, profileId || null).maxTokens != null) return own;
    return { ...(own || {}), maxTokens: SESSION_MAX_REPLY };
}

/**
 * One streamed model reply, shared by every generate route. store(text, interrupted, extra) runs at most once a round.
 * @returns {{ signal, pipe, next, write, end, fail }}
 */
export function openReply(db, res, store) {
    const controller = new AbortController();
    let content = '';
    // reasoning is stored with the reply, not just shown while it streams
    let reasoning = '';
    let opened = false;
    // what stops the clean path and a late close from both writing the same turn
    let settled = false;
    const open = () => { if (!opened) { sseOpen(res); opened = true; } };
    const commit = (interrupted = null, usage = null) => {
        if (settled || !content) return null;
        settled = true;
        return store(content, interrupted, { reasoning, usage });
    };
    // a hang-up lands here, never in the catch. it discards the fragment unless chatKeepInterrupted
    // (a stop and a dropped socket look the same)
    closeSignal(res).addEventListener('abort', () => {
        if (settingValue(db, 'chatKeepInterrupted', false) === true) commit('stopped');
        controller.abort();
    }, { once: true });
    return {
        signal: controller.signal,
        get content() { return content; },
        async pipe(events) {
            let finish = null;
            for await (const event of events) {
                open();
                if (event.done) { finish = event.done; continue; } // done is sent after the row lands
                if (typeof event.text === 'string') content += event.text;
                if (typeof event.reasoning === 'string') reasoning += event.reasoning;
                sseWrite(res, 'chunk', event);
            }
            open();
            return finish;
        },
        commit,
        next() { content = ''; reasoning = ''; settled = false; },
        write(event, data) { sseWrite(res, event, data); },
        // a reply that streamed and was not stored, or one with no text, says so; else done with the route's payload
        end(stored, finish, payload, { expectsRow = true } = {}) {
            const failure = replyFailure({ content, stored, finishReason: finish?.finishReason ?? null, expectsRow });
            sseWrite(res, failure ? 'error' : 'done', failure || payload);
            res.end();
        },
        // a failure keeps what streamed, the reader already saw it; a hang-up only unwinds here
        fail(err) {
            if (err?.name === 'AbortError') { res.end(); return; }
            commit(err instanceof LlmError ? (err.kind || 'error') : 'error');
            answerReplyFailure(res, err);
        },
    };
}
