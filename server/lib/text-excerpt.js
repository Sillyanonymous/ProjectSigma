// The plain-text excerpt of a rich-text field for a list row; a reader wanting the whole asks by name (fields=)

import { decodeHtmlEntities } from './html-entities.js';

// where the last of a token ends, -1 for none; a RegExp token is global and found by its matches
function endOfLast(text, token) {
    if (typeof token === 'string') {
        const at = text.lastIndexOf(token);
        return at < 0 ? -1 : at + token.length;
    }
    let end = -1;
    for (const m of text.matchAll(token)) end = m.index + m[0].length;
    return end;
}

// only up to the last token: past it no match can end, and the regex would rescan to the end from every start
function replaceUpTo(text, token, re, by) {
    const end = endOfLast(text, token);
    return end < 0 ? text : text.slice(0, end).replace(re, by) + text.slice(end);
}

/**
 * @param {string} html
 * @param {number} maxLength
 * @returns {string} plain text, cut at a word boundary past maxLength with an ellipsis
 */
export function excerptOf(html, maxLength = 200) {
    if (!html) return '';
    let stripped = String(html);
    stripped = replaceUpTo(stripped, /<\/style>/gi, /<style[^>]*>[\s\S]*?<\/style>/gi, '');
    stripped = replaceUpTo(stripped, /<\/script>/gi, /<script[^>]*>[\s\S]*?<\/script>/gi, '');
    // css blocks, inline or stray
    stripped = replaceUpTo(stripped, '}', /\{[^}]*\}/g, '');
    stripped = replaceUpTo(stripped, '-->', /<!--[\s\S]*?-->/g, '');
    stripped = replaceUpTo(stripped, '>', /<[^>]+>/g, ' ');
    // markdown images, then links kept as their text
    stripped = replaceUpTo(stripped, ')', /!\[[^\]]*\]\((?:(?:[^()]|\([^()]*\))*|[^)]*)\)/g, '');
    stripped = replaceUpTo(stripped, ']', /!\[[^\]]*\]/g, '');
    stripped = replaceUpTo(stripped, ')', /\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/[^\s<>"')\]]+/gi, '')
        .replace(/data:[^\s<>"')\]]+/gi, '');
    // what a css block left behind: selectors and property lines, a name taken whole so a long word is walked once
    let text = decodeHtmlEntities(stripped).replace(/[.#](?=([\w-]+))\1\s*\{/g, '');
    text = replaceUpTo(text, ';', /(?<![\w-])(?=([\w-]+))\1\s*:\s*[^;]+;/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (text.length > maxLength) {
        const cut = text.substring(0, maxLength);
        const lastSpace = cut.lastIndexOf(' ');
        text = (lastSpace > maxLength * 0.7 ? cut.substring(0, lastSpace) : cut) + '...';
    }
    return text;
}
