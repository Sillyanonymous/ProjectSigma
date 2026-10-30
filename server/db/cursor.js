// the keyset cursor codec: the last row's sort-key tuple as opaque base64url JSON

export function encodeCursor(values) {
    return Buffer.from(JSON.stringify(values)).toString('base64url');
}

/** The cursor's tuple of width scalars (the last an integer under intLast), or null for anything else. */
export function decodeCursor(cursor, width, { intLast = false } = {}) {
    try {
        const vals = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
        if (!Array.isArray(vals) || vals.length !== width) return null;
        if (!vals.every(v => typeof v === 'string' || typeof v === 'number')) return null;
        if (intLast && !Number.isInteger(vals[width - 1])) return null;
        return vals;
    } catch { return null; }
}
