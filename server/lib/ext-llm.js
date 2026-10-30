// ctx.llm: an extension's calls to an account's own models through the one generation service, and
// the connection kinds it adds.
import { performance } from 'node:perf_hooks';
import { chat, chatStream, profileSees } from '../llm/service.js';
import { LlmError, classifyUpstream, boundedErrorText, networkError, readJsonBody, badRequest } from '../llm/errors.js';
import { parseSse } from '../llm/sse.js';
import { translateParams } from '../llm/params.js';
import { profileRow, resolveChatProfile } from '../db/llm-profiles-store.js';
import { doorAccount } from './extensions.js';
import { recordCall, addAdapter } from './ext-hooks.js';

// what the openai adapter is built from, handed on for an extension's own adapters
const KIT = Object.freeze({ LlmError, classifyUpstream, boundedErrorText, networkError, readJsonBody, parseSse, translateParams });

// a call's account and request: the named connection, the setting's while it exists, else the chat's own or the default
function requestFor(row, db, spec, setting) {
    const user = doorAccount(row, db, 'llm');
    const s = spec && typeof spec === 'object' ? spec : {};
    if (s.profileSetting != null && (typeof s.profileSetting !== 'string' || !s.profileSetting)) throw badRequest('profileSetting is the name of one of your settings');
    if (s.profileSetting && s.profileId) throw badRequest('a call names its connection by profileId or by profileSetting, not both');
    if (s.chatId != null && (typeof s.chatId !== 'string' || !s.chatId)) throw badRequest('chatId is the id of one of your chats');
    if (s.profileId != null && (typeof s.profileId !== 'string' || !profileRow(db, s.profileId))) throw badRequest('profileId is the id of one of your connections');
    const picked = s.profileSetting ? setting(db, s.profileSetting) : null;
    const kept = picked && profileRow(db, String(picked)) ? String(picked) : null;
    const profileId = s.profileId || kept || resolveChatProfile(db, s.chatId || null).row?.id || undefined;
    return {
        user,
        body: { messages: s.messages, model: s.model, params: s.params, profileId, purpose: 'extension', extension: row.id },
    };
}

/** The ctx.llm a server half is handed; setting is its own ctx.setting, which profileSetting reads through. */
export function llmDoor(row, setting) {
    return Object.freeze({
        async chat(db, spec, { signal } = {}) {
            const { user, body } = requestFor(row, db, spec, setting);
            const t0 = performance.now();
            try {
                const out = await chat(db, body, signal);
                recordCall(row.id, user, 'llm.chat', performance.now() - t0);
                return out;
            } catch (e) {
                recordCall(row.id, user, 'llm.chat', performance.now() - t0, { error: e });
                throw e;
            }
        },
        // checked when called, not at the first next(), so a refusal lands where the call is made
        stream(db, spec, { signal } = {}) {
            const { user, body } = requestFor(row, db, spec, setting);
            return (async function* events() {
                const t0 = performance.now();
                let failed = false;
                let error;
                try {
                    yield* chatStream(db, body, signal);
                } catch (e) {
                    failed = true;
                    error = e;
                    throw e;
                } finally {
                    recordCall(row.id, user, 'llm.stream', performance.now() - t0, failed ? { error } : {});
                }
            })();
        },
        // the connection a call with this spec would use: whether it sends pictures (null: its model's sight is not known)
        canSee(db, spec = {}) {
            const { body } = requestFor(row, db, spec, setting);
            return profileSees(db, profileRow(db, body.profileId || null));
        },
        // a kind of connection for the accounts that switched this extension on; answers the removal
        registerAdapter: (adapter) => addAdapter(row, adapter),
        kit: KIT,
    });
}
