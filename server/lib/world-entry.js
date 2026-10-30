// A lorebook entry's identity: the entries key, unless the blob carries a uid of its own

/** An entry's uid: its own integer, else its key as a number, else the key itself. */
export function entryUid(key, entry) {
    if (Number.isInteger(entry?.uid)) return entry.uid;
    const n = Number(key);
    return Number.isFinite(n) ? n : key;
}
