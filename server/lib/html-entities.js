// HTML entity decoding for text a page served inside markup (an attribute's JSON, a rich-text
// field's plain excerpt). The client's twin is decodeHtmlEntities in provider-utils.js.

const HTML_ENTITY_NAMES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * @param {string} s
 * @returns {string} s with each entity decoded once
 */
export function decodeHtmlEntities(s) {
    if (!s || typeof s !== 'string') return s || '';
    if (s.indexOf('&') === -1) return s;
    // one pass, so an escaped entity (&amp;lt;) comes out as the text it spells (&lt;), never decoded twice
    return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (all, e) => {
        if (e[0] !== '#') return HTML_ENTITY_NAMES[e.toLowerCase()] ?? all;
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : all;
    });
}
