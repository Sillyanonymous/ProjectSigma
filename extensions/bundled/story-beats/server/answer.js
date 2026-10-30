// How Story Beats reads a model's answer: its reasoning taken out, and what to say of one cut off at its token ceiling.

const TAGS = 'think|thinking|thought|reasoning|reflection|scratchpad';
const WHOLE_BLOCK = new RegExp(`<(${TAGS})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`, 'gi');
const CLOSER = new RegExp(`</(?:${TAGS})\\s*>`, 'gi');
const OPENER = new RegExp(`<(?:${TAGS})\\b[^>]*>`, 'i');
const ANY_TAG = new RegExp(`</?(?:${TAGS})\\b[^>]*>`, 'i');
// a host names a reply that reached its ceiling in one of these
const CUT = new Set(['length', 'max_tokens', 'stop_limit']);

/** The answer with its reasoning out: whole blocks, then all before a closer whose opener a template ate, then all after an opener still thinking. */
export function stripReasoning(text) {
    let out = String(text ?? '').replace(/\r\n?/g, '\n').replace(WHOLE_BLOCK, '');
    let last = -1;
    for (const m of out.matchAll(CLOSER)) last = m.index + m[0].length;
    if (last >= 0) out = out.slice(last);
    const open = out.match(OPENER);
    if (open) out = out.slice(0, open.index);
    return out;
}

/** Whether a model call's answer stopped at its token ceiling. */
export const wasCut = (out) => CUT.has(out?.finishReason);

/** Whether the model thought before or instead of answering: on the reasoning channel, or in its text. */
export const thoughtIn = (out) => !!String(out?.reasoning ?? '').trim() || ANY_TAG.test(String(out?.content ?? ''));

/** What the reader is told of an answer cut off at its ceiling: where, and the setting that gives it more room. */
export function cutWords({ tokens, reasoning, thought }) {
    const raise = reasoning ? 'raise Most output tokens or Room to think in Story Beats\' settings'
        : thought ? 'it thinks before it answers, so switch on "A reasoning model: give it room to think" in Story Beats\' settings'
            : 'raise Most output tokens in Story Beats\' settings';
    return `The answer was cut off at ${tokens} tokens; ${raise}.`;
}
