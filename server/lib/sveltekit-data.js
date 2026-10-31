// A SvelteKit page's data answer (its __data.json) read as plain values: flat index-linked arrays, promises as chunk lines.

// the indices that stand for a value no array slot can hold
const SPECIAL = new Map([[-1, undefined], [-2, undefined], [-3, NaN], [-4, Infinity], [-5, -Infinity], [-6, -0]]);

/**
 * Every node rebuilt, each promise's value in its marker's place (null when it failed); a failed page's error node is error.
 * @param {string} text the answer's body: the head line, then one line per resolved promise
 * @returns {{ nodes: Array<any>, error: {status: number|null, message: string}|null }} a node that sent no data is null
 */
export function decodeSvelteKitData(text) {
    const lines = String(text ?? '').split('\n').filter(l => l.trim());
    if (!lines.length) throw new Error('empty page data');
    const head = JSON.parse(lines[0]);
    if (head?.type === 'redirect') throw new Error(`page data redirects to ${head.location}`);
    if (head?.type === 'error') throw new Error(`page data error: ${head.error?.message || 'unknown'}`);
    if (head?.type !== 'data' || !Array.isArray(head.nodes)) throw new Error('not page data');
    const chunks = new Map();
    for (const line of lines.slice(1)) {
        const chunk = JSON.parse(line);
        if (chunk?.type === 'chunk') chunks.set(chunk.id, chunk);
    }
    const failed = head.nodes.find(n => n?.type === 'error');
    const status = [failed?.status, failed?.error?.status].find(Number.isInteger) ?? null;
    const error = failed ? { status, message: String(failed.error?.message || 'the page failed to load') } : null;
    return { nodes: head.nodes.map(n => (n?.type === 'data' && Array.isArray(n.data) ? rebuild(n.data, chunks) : null)), error };
}

function rebuild(flat, chunks) {
    const memo = new Map();
    const at = (i) => {
        if (SPECIAL.has(i)) return SPECIAL.get(i);
        if (!Number.isInteger(i) || i < 0 || i >= flat.length) throw new Error(`page data names a missing entry: ${i}`);
        if (memo.has(i)) return memo.get(i);
        const v = flat[i];
        if (v === null || typeof v !== 'object') return v;
        if (Array.isArray(v)) {
            // an array of indices is a plain array; one led by a name is a tagged value
            if (typeof v[0] === 'string') return tagged(i, v);
            const arr = [];
            memo.set(i, arr);
            for (const j of v) arr.push(at(j));
            return arr;
        }
        const obj = {};
        memo.set(i, obj);
        for (const [k, j] of Object.entries(v)) obj[k] = at(j);
        return obj;
    };
    const tagged = (i, v) => {
        switch (v[0]) {
            case 'Promise': {
                const chunk = chunks.get(at(v[1]));
                const out = chunk && Array.isArray(chunk.data) ? rebuild(chunk.data, chunks) : null;
                memo.set(i, out);
                return out;
            }
            case 'Date': { const d = new Date(v[1]); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
            case 'BigInt': return String(v[1]);
            case 'RegExp': return String(v[1]);
            case 'Set': { const out = []; memo.set(i, out); for (const j of v.slice(1)) out.push(at(j)); return out; }
            case 'Map': { const out = []; memo.set(i, out); for (let k = 1; k < v.length; k += 2) out.push([at(v[k]), at(v[k + 1])]); return out; }
            case 'null': { const out = {}; memo.set(i, out); for (let k = 1; k < v.length; k += 2) out[v[k]] = at(v[k + 1]); return out; }
            default: throw new Error(`page data holds a value of an unknown kind: ${v[0]}`);
        }
    };
    return at(0);
}
