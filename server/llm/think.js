// Splits inline <think> blocks out of the text into the reasoning channel. unconditional on purpose

const OPEN_RE = /<think(?:ing)?\s*>/i;
const CLOSE_RE = /<\/think(?:ing)?\s*>/i;
// a chunk's tail that could still grow into a tag, since a tag split across chunks is the common case
const PARTIAL_RE = /<\/?[a-z]*\s*$/i;

/**
 * A stateful splitter for ONE stream; flush() at its end so a held partial tag isnt swallowed.
 * @returns {{push: (text: string) => Array<{text?: string, reasoning?: string}>, flush: () => Array<object>, inThink: () => boolean}}
 */
export function createThinkSplitter() {
    let inThink = false;
    let hold = '';

    return {
        push(text) {
            const out = [];
            let buf = hold + (typeof text === 'string' ? text : '');
            hold = '';
            while (buf) {
                const m = buf.match(inThink ? CLOSE_RE : OPEN_RE);
                if (m) {
                    const before = buf.slice(0, m.index);
                    if (before) out.push(inThink ? { reasoning: before } : { text: before });
                    buf = buf.slice(m.index + m[0].length);
                    inThink = !inThink;
                    continue;
                }
                // no complete tag: hold back a fragment that could become one, the rest goes out
                const p = buf.match(PARTIAL_RE);
                if (p) {
                    hold = p[0];
                    buf = buf.slice(0, p.index);
                }
                if (buf) out.push(inThink ? { reasoning: buf } : { text: buf });
                buf = '';
            }
            return out;
        },
        flush() {
            if (!hold) return [];
            const out = [inThink ? { reasoning: hold } : { text: hold }];
            hold = '';
            return out;
        },
        inThink() { return inThink; },
    };
}

/**
 * The same split for a whole, already-complete string.
 * @returns {{text: string, reasoning: string}} reasoning is '' when there was none
 */
export function splitThink(content) {
    const s = createThinkSplitter();
    let text = '';
    let reasoning = '';
    for (const ev of [...s.push(content), ...s.flush()]) {
        if (typeof ev.text === 'string') text += ev.text;
        if (typeof ev.reasoning === 'string') reasoning += ev.reasoning;
    }
    return { text, reasoning };
}
