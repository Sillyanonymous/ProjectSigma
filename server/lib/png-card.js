import zlib from 'node:zlib';

// PNG tEXt/zTXt codec for embedded character cards ('chara' = V2, 'ccv3' = V3).
// Implemented from the PNG 1.2 spec; payloads are base64 JSON per the public card specs.

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CARD_KEYWORDS = new Set(['chara', 'ccv3']);
// a zTXt chunk is deflate and a few bytes can inflate without end, so the read is bounded
const CARD_TEXT_MAX_BYTES = 50 * 1024 * 1024;

// crc32 (IEEE), node's own; the running form sums a zip member chunk by chunk: crc32Update(CRC32_INIT, ...) then crc32Final
export const CRC32_INIT = 0;
export function crc32Update(c, buf) {
    return zlib.crc32(buf, c);
}
export function crc32Final(c) {
    return c >>> 0;
}
export function crc32(...buffers) {
    let c = CRC32_INIT;
    for (const buf of buffers) c = crc32Update(c, buf);
    return crc32Final(c);
}

export function isPng(buffer) {
    return buffer.length > 8 && buffer.subarray(0, 8).equals(PNG_SIG);
}

function* chunks(buffer) {
    let offset = 8;
    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        yield { type, data, start: offset, end: offset + 12 + length };
        if (type === 'IEND') break;
        offset += 12 + length;
    }
}

// A text chunk's card keyword, read without touching its payload, or null
function cardKeywordOf(data) {
    const nul = data.indexOf(0);
    if (nul < 0) return null;
    const keyword = data.toString('latin1', 0, nul);
    return CARD_KEYWORDS.has(keyword) ? keyword : null;
}

function textChunkPayload(type, data, maxOutputLength = CARD_TEXT_MAX_BYTES) {
    const keyword = cardKeywordOf(data);
    if (!keyword) return null;
    const nul = keyword.length;
    try {
        if (type === 'tEXt') {
            return { keyword, text: data.toString('latin1', nul + 1) };
        }
        // zTXt: keyword \0 compressionMethod(0=deflate) compressed
        if (data[nul + 1] !== 0) return null;
        return { keyword, text: zlib.inflateSync(data.subarray(nul + 2), { maxOutputLength }).toString('latin1') };
    } catch {
        return null;
    }
}

/**
 * Extract embedded card JSON from a PNG buffer.
 * Returns { v3, v2, raw } where v3/v2 are the parsed ccv3/chara payloads (null when absent).
 */
export function readCardChunks(buffer) {
    if (!isPng(buffer)) return null;
    const found = {};
    // one inflate budget a file, so a repeated bomb pays once; a failed zTXt spends its whole allowance
    let budget = CARD_TEXT_MAX_BYTES;
    for (const chunk of chunks(buffer)) {
        if (chunk.type !== 'tEXt' && chunk.type !== 'zTXt') continue;
        // the keyword first: a keyword already read never inflates again
        const keyword = cardKeywordOf(chunk.data);
        if (!keyword || found[keyword] !== undefined) continue;
        if (chunk.type === 'zTXt' && budget <= 0) continue;
        const payload = textChunkPayload(chunk.type, chunk.data, budget);
        if (chunk.type === 'zTXt') budget -= payload ? payload.text.length : budget;
        if (!payload) continue;
        try {
            const card = JSON.parse(Buffer.from(payload.text, 'base64').toString('utf8'));
            // a payload that is no object (a null, a string) is no card, and takes no keyword's slot
            if (card && typeof card === 'object' && !Array.isArray(card)) found[payload.keyword] = card;
        } catch {
            // corrupt payload, keep scanning; a later duplicate chunk may be intact
        }
    }
    if (found.chara === undefined && found.ccv3 === undefined) return null;
    return { v3: found.ccv3 ?? null, v2: found.chara ?? null };
}

function buildTextChunk(keyword, json) {
    const payload = Buffer.from(JSON.stringify(json), 'utf8').toString('base64');
    const data = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(payload, 'latin1')]);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write('tEXt', 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(head.subarray(4, 8), data), 0);
    return Buffer.concat([head, data, crc]);
}

/**
 * Return a copy of the PNG with all card chunks removed. Avatars are pure images;
 * the DB is the card truth and export re-embeds fresh.
 */
export function stripCardChunks(buffer) {
    if (!isPng(buffer)) return buffer;
    const parts = [PNG_SIG];
    for (const chunk of chunks(buffer)) {
        // a card chunk by its keyword alone: the strip never inflates a payload it drops
        if ((chunk.type === 'tEXt' || chunk.type === 'zTXt') && cardKeywordOf(chunk.data)) continue;
        parts.push(buffer.subarray(chunk.start, chunk.end));
        if (chunk.type === 'IEND') break;
    }
    return Buffer.concat(parts);
}

/**
 * Return a copy of the PNG with card chunks replaced.
 * Writes 'chara' (V2 projection) always and 'ccv3' when the card is V3, before IEND.
 */
export function writeCardChunks(buffer, card) {
    if (!isPng(buffer)) throw new Error('not a PNG');
    const kept = [];
    let iendStart = -1;
    for (const chunk of chunks(buffer)) {
        if (chunk.type === 'IEND') { iendStart = chunk.start; break; }
        // a card chunk by its keyword alone: the strip never inflates a payload it drops
        if ((chunk.type === 'tEXt' || chunk.type === 'zTXt') && cardKeywordOf(chunk.data)) continue;
        kept.push(buffer.subarray(chunk.start, chunk.end));
    }
    if (iendStart < 0) throw new Error('PNG has no IEND chunk');

    const parts = [PNG_SIG, ...kept];
    const isV3 = card?.spec === 'chara_card_v3';
    const v2 = isV3 ? { spec: 'chara_card_v2', spec_version: '2.0', data: card.data } : card;
    parts.push(buildTextChunk('chara', v2));
    if (isV3) parts.push(buildTextChunk('ccv3', card));
    parts.push(buffer.subarray(iendStart));
    return Buffer.concat(parts);
}
