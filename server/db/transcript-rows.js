// the rules of a session transcript kept as a column; not a *-store.js, so ctx.stores never hands out an unreported edit

export const MAX_SESSION_NAME = 120;

/** The stored transcript, or null when it does not parse. */
export function parseMessages(text) {
    try {
        const v = JSON.parse(text);
        return Array.isArray(v) ? v : [];
    } catch {
        // reporting it empty would let the next append write [one message] over whats really there, so null and refuse
        return null;
    }
}

// a seq is a position, and the turn at it is proven by its stamp when the caller names one
const turnAt = (messages, seq, at) => (at !== null && messages[seq].at !== at ? { answer: { conflict: true } } : null);

/** Append one message: its stamp strictly after the last turn's, so a stamp names that turn alone. */
export function appendTurn(messages, message) {
    const stored = { ...message, at: Math.max(message.at ?? Date.now(), (messages.at(-1)?.at ?? 0) + 1) };
    return { write: [...messages, stored], answer: { seq: messages.length, message: stored } };
}

/** Merge a patch into one message; extra merges too, keeping the context snapshot every later apply is checked against. */
export function patchTurn(messages, seq, patch, at) {
    if (!messages[seq]) return { answer: null };
    const refused = turnAt(messages, seq, at);
    if (refused) return refused;
    const next = { ...messages[seq], ...patch };
    if (patch.extra) next.extra = { ...(messages[seq].extra || {}), ...patch.extra };
    const write = [...messages];
    write[seq] = next;
    return { write, answer: { seq, message: next } };
}

/** Remove ONE message, leaving the rest alone: tidying a stray turn is not re-asking. */
export function deleteTurn(messages, seq, at) {
    if (seq < 0 || seq >= messages.length) return { answer: null };
    const refused = turnAt(messages, seq, at);
    if (refused) return refused;
    const write = [...messages];
    write.splice(seq, 1);
    return { write, answer: { remaining: write.length } };
}

/** Drop one message and everything after: removing a reply means asking again, and later turns would read as a non sequitur. */
export function truncateTurns(messages, seq, at) {
    if (seq < 0 || seq >= messages.length) return { answer: null };
    const refused = turnAt(messages, seq, at);
    if (refused) return refused;
    const write = messages.slice(0, seq);
    return { write, answer: { kept: write.length } };
}
