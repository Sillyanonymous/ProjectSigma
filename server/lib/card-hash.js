import crypto from 'node:crypto';

// Content identity for a stored card. key order is canonicalized, array order is meaning and stays
function canonical(value) {
    if (typeof value === 'object' && value !== null) {
        if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
        let body = '';
        for (const key of Object.keys(value).sort()) body += `${body ? ',' : ''}${JSON.stringify(key)}:${canonical(value[key])}`;
        return `{${body}}`;
    }
    const text = JSON.stringify(value);
    return text === undefined ? 'null' : text;
}

export function cardContentHash(card) {
    return crypto.createHash('sha256').update(canonical(card)).digest('hex');
}
