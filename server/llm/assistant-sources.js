// The assistant's switchable context sources: the built-ins and the extensions' share one registry and one setting
import { countMessages, chatMetadataOf } from '../db/chats-store.js';
import { getPreset, resolveChatPreset } from '../db/presets-store.js';
import { chatAuthorsNote, presetFor } from './prompt.js';
import { NOTE_POSITION, NOTE_ROLES } from './authors-note.js';
import { runRegistry } from '../db/hook-seat.js';

/** The setting that holds each source's switch: { [id]: boolean }, a missing id reading the source's default. */
export const SOURCES_SETTING = 'assistantContextSources';

/** Whether a source is on under the stored switches. */
export function sourceOn(switches, source) {
    const v = switches && typeof switches === 'object' ? switches[source.id] : undefined;
    return typeof v === 'boolean' ? v : source.defaultOn === true;
}

const pronounLine = (p) => {
    const forms = ['sub', 'obj', 'poss', 'ref'].map(k => String(p?.[k] ?? '').trim()).filter(Boolean);
    return forms.length ? forms.join('/') : '';
};

const POSITION_WORDS = {
    [NOTE_POSITION.before]: () => 'at the top of the prompt, before the card',
    [NOTE_POSITION.after]: () => 'after the card and scenario',
    [NOTE_POSITION.inChat]: (n) => `inside the conversation, ${n.depth} message${n.depth === 1 ? '' : 's'} from the newest, as a ${NOTE_ROLES[n.role] || 'system'} message`,
};

function noteCadence(state) {
    const { note } = state;
    if (!Number.isFinite(note.interval) || note.interval <= 0) return 'never sent (its frequency is 0)';
    if (note.interval === 1) return 'sent every turn';
    return `sent every ${note.interval} of the reader's turns, ${state.due ? 'due on the next reply' : `next in ${state.untilNext}`}`;
}

/** The built-in sources, in the order the material lists them. */
export const BUILTIN_SOURCES = Object.freeze([
    {
        id: 'persona',
        label: 'Persona',
        defaultOn: true,
        read({ names }) {
            const p = names.persona;
            const description = String(p?.description ?? '');
            if (!p) return { empty: 'No persona is set for this chat' };
            const pronouns = pronounLine(p.pronouns);
            const head = `THE READER'S CHARACTER: ${JSON.stringify(names.userName)}, the persona the reader plays as${pronouns ? ` (pronouns ${pronouns})` : ''}`;
            const lines = [head];
            if (description.trim()) lines.push('', 'Description:', description.trim());
            else lines.push('', 'Description: (empty)');
            return {
                text: lines.join('\n'),
                chars: description.trim().length,
                detail: p.name,
                record: { id: p.id, fields: { description } },
            };
        },
    },
    {
        id: 'authorsNote',
        label: "Author's Note",
        defaultOn: true,
        read({ db, chatRow, note }) {
            // the build's own scan read it already; a reader without one reads it here
            const state = note || chatAuthorsNote(db, chatRow);
            const text = state.note.prompt;
            const own = state.note.own.prompt;
            const record = { fields: { authors_note: text } };
            if (!text.trim()) return { empty: "No Author's Note is set", record };
            const where = (POSITION_WORDS[state.note.position] || POSITION_WORDS[NOTE_POSITION.after])(state.note);
            return {
                text: [
                    `AUTHOR'S NOTE (${own ? "this chat's own" : 'the default, used by every chat without a note of its own'}): ${noteCadence(state)}, placed ${where}`,
                    text.trim(),
                ].join('\n'),
                chars: text.trim().length,
                detail: own ? "This chat's own" : 'The default note',
                record,
            };
        },
    },
    {
        id: 'chatFacts',
        label: 'Chat facts',
        defaultOn: true,
        read({ db, chatRow }) {
            const meta = chatMetadataOf(chatRow.chat_metadata);
            const branch = typeof meta.main_chat === 'string' && meta.main_chat.trim() ? meta.main_chat.trim() : '';
            const count = countMessages(db, chatRow.id);
            const line = `THIS CHAT: ${JSON.stringify(String(chatRow.name || ''))}, ${count} message${count === 1 ? '' : 's'} stored${branch ? `, a branch of ${JSON.stringify(branch)}` : ''}`;
            return { text: line, detail: branch ? `A branch of ${JSON.stringify(branch)}, ${count} messages` : `${count} messages` };
        },
    },
    {
        id: 'preset',
        label: 'Preset text blocks',
        defaultOn: false,
        read({ db, chatRow }) {
            const { presetId, source } = resolveChatPreset(db, chatRow.id);
            const preset = presetId ? getPreset(db, presetId) : null;
            const name = preset?.name || 'the built-in preset';
            // the blocks a normal reply's build sends, as the build itself picks them; names from the stored rows
            const named = new Map((preset?.blocks || []).map(b => [b.key || b.id, b.name]));
            const blocks = presetFor(db, chatRow.id).blocks
                .filter(b => b.kind === 'text' && !b.held && String(b.content || '').trim())
                .map(b => ({ ...b, name: named.get(b.id) || b.name }));
            if (!blocks.length) return { empty: `${preset ? `"${preset.name}"` : 'The built-in preset'} sends no text blocks of its own` };
            const whose = source === 'chat' ? "this chat's own" : source === 'default' ? 'the default' : 'built in';
            const lines = [`PRESET ${JSON.stringify(name)} (${whose}): the text blocks it sends the story's model, in order, with macros unexpanded`];
            let chars = 0;
            for (const b of blocks) {
                const body = String(b.content).trim();
                chars += body.length;
                const where = b.position === 'at_depth' ? `${b.depth ?? 0} messages from the newest` : b.position === 'post_history' ? 'after the conversation' : 'before the conversation';
                lines.push('', `[${b.name || b.key || b.id}] (${b.role || 'system'}, ${where})`, body);
            }
            return { text: lines.join('\n'), chars, detail: `${blocks.length} block${blocks.length === 1 ? '' : 's'} of ${name}` };
        },
    },
]);

/**
 * Every source this chat's assistant can be given, read where it is on, in the material's order.
 * @param {{db, chatRow, names, note?}} env the chat, its resolved names (chatNames) and the lore scan's note state
 * @param {object} switches the stored assistantContextSources
 * @returns {{sections: string[], summary: Array<object>, records: object}} records: what each on source showed, for the edit judge
 */
export function readSources(env, switches) {
    const sections = [];
    const summary = [];
    const records = {};
    for (const src of BUILTIN_SOURCES) {
        const on = sourceOn(switches, src);
        const row = { id: src.id, label: src.label, on, defaultOn: src.defaultOn };
        if (on) {
            const r = src.read(env) || {};
            if (r.record) records[src.id] = r.record;
            if (r.text) { sections.push(r.text); if (Number.isFinite(r.chars)) row.chars = r.chars; }
            if (r.detail) row.detail = r.detail;
            if (r.empty) row.empty = r.empty;
        }
        summary.push(row);
    }
    // an extension's source is read only when on, so one switched off costs nothing
    for (const src of runRegistry('assistant.sources', { db: env.db, chatId: env.chatRow.id, charId: env.chatRow.char_id }) || []) {
        const on = sourceOn(switches, src);
        const row = { id: src.id, label: src.label, on, defaultOn: src.defaultOn, owner: src.owner, ownerName: src.ownerName };
        if (on) {
            const r = src.read();
            if (r.failed) row.failed = true;
            else if (r.text.trim()) {
                const body = r.text.trim();
                sections.push(`${src.label.toUpperCase()} (shared by the extension ${JSON.stringify(src.ownerName)})\n${body}`);
                row.chars = body.length;
            } else row.empty = 'Nothing to share for this chat';
        }
        summary.push(row);
    }
    return { sections, summary, records };
}
