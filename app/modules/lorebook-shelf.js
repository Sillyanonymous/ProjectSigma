// The shelf's import funnel: a book from anywhere lands on the shelf through ONE path. Entry defaults
// and both embedded-book converters live here too.
import CoreAPI from './core-api.js';
import { PROBE_PAGE } from './providers/provider-utils.js';

/** A new world entry with every field at its default, as world files store them. */
export function newWorldEntry(uid, displayIndex) {
    return {
        uid,
        key: [], keysecondary: [],
        comment: '', content: '',
        constant: false, vectorized: false,
        selective: true, selectiveLogic: 0,
        addMemo: false,
        order: 100, position: 0,
        disable: false, ignoreBudget: false,
        excludeRecursion: false, preventRecursion: false,
        matchPersonaDescription: false, matchCharacterDescription: false,
        matchCharacterPersonality: false, matchCharacterDepthPrompt: false,
        matchScenario: false, matchCreatorNotes: false,
        delayUntilRecursion: 0,
        probability: 100, useProbability: true,
        depth: 4, outletName: '',
        group: '', groupOverride: false, groupWeight: 100,
        scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
        automationId: '', role: 0,
        sticky: null, cooldown: null, delay: null,
        triggers: [],
        displayIndex,
    };
}

/** What a cleared number box stores per entry field: the shipped value, or null where blank means inherit. Never an unshown 0. */
export const ENTRY_NUMBER_BLANKS = Object.freeze({
    probability: 100, groupWeight: 100, delayUntilRecursion: 0, order: 0,
    depth: null, scanDepth: null, sticky: null, cooldown: null, delay: null,
});

const atIndex = (entry, index) => index;

// How a field is read from the other side; a list is copied so the two documents never share one.
const READ = {
    list: (v, d) => (Array.isArray(v) ? v : d).slice(),
    text: (v, d) => v || d,
    flag: (v, d) => (v == null ? d : !!v),
    flip: (v, d) => (v == null ? d : !v),
    value: (v, d) => v ?? d,
};

// Every field an embedded book carries: our key, the book's (`ext` under its extensions), and the default each way when absent.
const BOOK_FIELDS = [
    { world: 'key', book: 'keys', as: 'list', toBook: [], toWorld: [] },
    { world: 'keysecondary', book: 'secondary_keys', as: 'list', toBook: [], toWorld: [] },
    { world: 'comment', book: 'comment', as: 'text', toBook: '', toWorld: '' },
    { world: 'content', book: 'content', as: 'text', toBook: '', toWorld: '' },
    { world: 'constant', book: 'constant', as: 'flag', toBook: false, toWorld: false },
    { world: 'vectorized', ext: 'vectorized', toBook: false, toWorld: false },
    { world: 'selective', book: 'selective', as: 'flag', toBook: false, toWorld: false },
    { world: 'selectiveLogic', ext: 'selectiveLogic', toBook: 0, toWorld: 0 },
    { world: 'order', book: 'insertion_order', toBook: 100, toWorld: 100 },
    { world: 'position', ext: 'position', toBook: 1, toWorld: (entry) => (entry.position === 'before_char' ? 0 : 1) },
    // a book entry that never says enabled arrives switched off
    { world: 'disable', book: 'enabled', as: 'flip', toBook: true, toWorld: true },
    { world: 'ignoreBudget', ext: 'ignore_budget', toBook: false, toWorld: false },
    { world: 'excludeRecursion', ext: 'exclude_recursion', toBook: false, toWorld: false },
    { world: 'preventRecursion', ext: 'prevent_recursion', toBook: false, toWorld: false },
    { world: 'matchPersonaDescription', ext: 'match_persona_description', toBook: false, toWorld: false },
    { world: 'matchCharacterDescription', ext: 'match_character_description', toBook: false, toWorld: false },
    { world: 'matchCharacterPersonality', ext: 'match_character_personality', toBook: false, toWorld: false },
    { world: 'matchCharacterDepthPrompt', ext: 'match_character_depth_prompt', toBook: false, toWorld: false },
    { world: 'matchScenario', ext: 'match_scenario', toBook: false, toWorld: false },
    { world: 'matchCreatorNotes', ext: 'match_creator_notes', toBook: false, toWorld: false },
    { world: 'delayUntilRecursion', ext: 'delay_until_recursion', toBook: false, toWorld: 0 },
    { world: 'probability', ext: 'probability', toBook: null, toWorld: 100 },
    { world: 'useProbability', ext: 'useProbability', toBook: false, toWorld: true },
    { world: 'depth', ext: 'depth', toBook: 4, toWorld: 4 },
    { world: 'outletName', ext: 'outlet_name', toBook: '', toWorld: '' },
    { world: 'group', ext: 'group', toBook: '', toWorld: '' },
    { world: 'groupOverride', ext: 'group_override', toBook: false, toWorld: false },
    { world: 'groupWeight', ext: 'group_weight', toBook: null, toWorld: 100 },
    { world: 'scanDepth', ext: 'scan_depth', toBook: null, toWorld: null },
    { world: 'caseSensitive', ext: 'case_sensitive', toBook: null, toWorld: null },
    { world: 'matchWholeWords', ext: 'match_whole_words', toBook: null, toWorld: null },
    { world: 'useGroupScoring', ext: 'use_group_scoring', toBook: false, toWorld: null },
    { world: 'automationId', ext: 'automation_id', toBook: '', toWorld: '' },
    { world: 'role', ext: 'role', toBook: 0, toWorld: 0 },
    { world: 'sticky', ext: 'sticky', toBook: null, toWorld: null },
    { world: 'cooldown', ext: 'cooldown', toBook: null, toWorld: null },
    { world: 'delay', ext: 'delay', toBook: null, toWorld: null },
    { world: 'triggers', ext: 'triggers', as: 'list', toBook: [], toWorld: [] },
    { world: 'displayIndex', ext: 'display_index', toBook: atIndex, toWorld: atIndex },
];

function carried(row, value, fallback, entry, index) {
    return READ[row.as || 'value'](value, typeof fallback === 'function' ? fallback(entry, index) : fallback);
}

/**
 * A world (entries keyed by uid) as an embedded character_book, through BOOK_FIELDS.
 * @param {Object} world - { entries: {uid: entry}, ...meta }
 * @param {string} name - the book name the world is known by
 * @returns {{name: string, entries: Object[]}}
 */
export function convertWorldToCharacterBook(world, name = '') {
    const source = world?.entries || {};
    const list = Array.isArray(source) ? source : Object.values(source);
    const entries = list.map((e, i) => {
        const out = { id: Number.isInteger(e.uid) ? e.uid : i };
        const extensions = { ...(e.extensions || {}) };
        for (const row of BOOK_FIELDS) {
            const value = carried(row, e[row.world], row.toBook, e, i);
            if (row.ext) extensions[row.ext] = value;
            else out[row.book] = value;
        }
        // the spec names two places; the number under extensions is what comes back
        out.position = Number(e.position) === 0 ? 'before_char' : 'after_char';
        out.use_regex = true;
        out.extensions = extensions;
        return out;
    });
    return { name: String(name || world?.name || ''), entries };
}

// An embedded character_book (entries as an array) as a world file (entries keyed by id), through BOOK_FIELDS,
// so a card's V2/V3 JSON imports directly.
export function convertCharacterBookToNative(book) {
    const result = { entries: {} };
    const list = Array.isArray(book?.entries) ? book.entries : [];
    list.forEach((entry, index) => {
        const id = entry.id ?? index;
        const extensions = entry.extensions || {};
        const out = newWorldEntry(id);
        for (const row of BOOK_FIELDS) {
            out[row.world] = carried(row, row.ext ? extensions[row.ext] : entry[row.book], row.toWorld, entry, index);
        }
        // chub's V2 books title an entry in `name`; a comment wins when both are set
        out.comment = entry.comment || entry.name || '';
        out.addMemo = !!out.comment;
        result.entries[id] = out;
    });
    return result;
}

/**
 * Whether a parsed file is a native world doc (entries OBJECT, native key names), not a V2 character_book (ARRAY).
 * @param {any} doc
 * @returns {boolean}
 */
function isNativeWorldDoc(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
    const entries = doc.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return false;
    const first = Object.values(entries)[0];
    return !first || typeof first !== 'object' || ('key' in first || 'keysecondary' in first || 'disable' in first);
}

// the highlight, count cache and collision guard all key on this normalized form, never the typed one
export function sanitizeWorldName(name) {
    let s = `${(name ?? '').trim()}.json`
        .replace(/[\/\?<>\\:\*\|"]/g, '')   // illegal
        .replace(/[\x00-\x1f\x80-\x9f]/g, '') // control
        .replace(/^\.+$/, '')                // reserved dot-only
        .replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, '') // windows reserved
        .replace(/[\. ]+$/, '');             // trailing dots/spaces
    // ST truncates to 255 UTF-8 bytes; world names never approach that, so a char cap is fine.
    if (s.length > 255) s = s.slice(0, 255);
    return s.replace(/\.json$/, '');
}

// who besides the importing character links a placeholder; null (unreadable) refuses the fill rather than guess
async function placeholderSharers(name, ownerCharId) {
    const resp = await CoreAPI.apiRequest(`/worlds/${encodeURIComponent(name)}/usage`, 'GET');
    if (!resp.ok) return null;
    const usage = await resp.json();
    const chars = (usage.chars || []).filter(c => c.id !== ownerCharId).map(c => c.name || 'a character');
    const out = chars.length > 3 ? [...chars.slice(0, 3), `${chars.length - 3} more character${chars.length - 3 === 1 ? '' : 's'}`] : chars;
    const chats = (usage.chats || []).length;
    if (chats) out.push(`${chats} chat${chats === 1 ? '' : 's'}`);
    for (const p of usage.personas || []) out.push(`the persona ${p.name}`);
    if (usage.global) out.push('the global list');
    return out;
}

const listed = (parts) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || '');

/**
 * Put a book on the shelf: a taken name offers the existing book first, a placeholder of it is filled.
 * @param {{ name: string, book?: object, world?: object, source?: {provider: string, externalId: string, path?: string|null, url?: string|null}|null, existingLabel?: string, eventSource?: string, ownerCharId?: string|null }} opts
 * @param opts.book a V2 character_book (entries ARRAY), or opts.world a native document (entries OBJECT)
 * @param opts.ownerCharId the character a promotion imports for (its own placeholder link isnt someone waiting)
 * @returns {Promise<{ world: string, entries: number, usedExisting: boolean, filledPlaceholder: boolean }|null>} null when cancelled or failed (the failure is toasted)
 */
export async function importBookToShelf({ name, book = null, world = null, source = null, existingLabel = 'Use the existing one', eventSource = 'shelf-import', ownerCharId = null } = {}) {
    const doc = world && isNativeWorldDoc(world) ? world : convertCharacterBookToNative(book);
    const entryCount = Object.keys(doc.entries || {}).length;
    if (!entryCount) {
        CoreAPI.showToast('This lorebook has no entries to import', 'warning');
        return null;
    }
    const wanted = sanitizeWorldName(String(name || '').trim() || String(book?.name || world?.name || '').trim()) || 'Imported Lorebook';
    const shelf = await CoreAPI.listWorldInfoFiles({ placeholders: 'all' }) || [];
    const clash = shelf.find(w => w.file_id.toLowerCase() === wanted.toLowerCase());

    let target = wanted;
    let usedExisting = false;
    let filledPlaceholder = false;
    const copyName = () => {
        let n = 2;
        let next;
        do { next = sanitizeWorldName(`${wanted} (${n++})`); }
        while (shelf.some(w => w.file_id.toLowerCase() === next.toLowerCase()));
        return next;
    };
    if (clash?.placeholder) {
        const sharers = await placeholderSharers(clash.file_id, ownerCharId);
        if (sharers === null) {
            CoreAPI.showToast(`Could not read who links "${clash.file_id}"`, 'error');
            return null;
        }
        let answer = true;
        if (sharers.length) {
            answer = await CoreAPI.showConfirm({
                title: `Fill the placeholder "${clash.file_id}"?`,
                message: `"${clash.file_id}" has no book yet, and it is also linked to ${listed(sharers)}. Importing fills it for all of them.`,
                icon: 'fa-solid fa-book-atlas',
                confirmLabel: 'Fill it for all',
                extraLabel: 'Import a separate copy',
                cancelLabel: 'Cancel',
            });
            if (!answer) return null;
        }
        if (answer === 'extra') target = copyName();
        else { target = clash.file_id; filledPlaceholder = true; }
    } else if (clash) {
        const answer = await CoreAPI.showConfirm({
            title: 'That lorebook already exists',
            message: `A lorebook called "${clash.file_id}" is already on the shelf. Use it, or import this one as a separate book?`,
            icon: 'fa-solid fa-book-atlas',
            confirmLabel: existingLabel,
            extraLabel: 'Import a separate copy',
            cancelLabel: 'Cancel',
        });
        if (!answer) return null;
        if (answer === 'extra') {
            target = copyName();
        } else {
            target = clash.file_id;
            usedExisting = true;
        }
    }

    if (!usedExisting) {
        // a create or a placeholder fill: the server refuses either if the shelf moved since read, so no book is overwritten
        const made = await CoreAPI.createWorldInfoData(target, doc, { expect: filledPlaceholder ? 'placeholder' : 'absent' });
        if (made === 'exists') {
            CoreAPI.showToast(`"${target}" changed on the shelf since it was read; import again`, 'warning');
            return null;
        }
        if (made !== 'created') {
            CoreAPI.showToast('Could not create the lorebook', 'error');
            return null;
        }
    }
    if (source?.provider && source.externalId != null && source.externalId !== '') {
        // the book just written takes its source; a kept book takes it only when it has none
        const resp = await CoreAPI.apiRequest(`/worlds/${encodeURIComponent(target)}/source`, 'PUT', {
            provider: String(source.provider),
            externalId: String(source.externalId),
            path: source.path ?? null,
            url: source.url ?? null,
            onlyIfMissing: usedExisting,
        });
        if (!resp.ok) CoreAPI.showToast(`"${target}" is on the shelf, but where it came from could not be recorded`, 'warning');
    }
    CoreAPI.notifyWorldsChanged(target, eventSource);
    return { world: target, entries: entryCount, usedExisting, filledPlaceholder };
}

/**
 * Which of these keys (a provider's ids or paths) name a book on the shelf; one POST per PROBE_PAGE, a failed chunk throws.
 * @param {string} providerId
 * @param {string[]} keys
 * @returns {Promise<Set<string>>} the keys found
 */
export async function probeShelf(providerId, keys) {
    const found = new Set();
    const wanted = [...new Set((keys || []).filter(k => k != null && k !== '').map(String))];
    for (let i = 0; i < wanted.length; i += PROBE_PAGE) {
        const chunk = wanted.slice(i, i + PROBE_PAGE);
        const resp = await CoreAPI.apiRequest('/worlds/probe', 'POST', { provider: providerId, keys: chunk });
        if (!resp.ok) throw new Error(`worlds/probe ${resp.status}`);
        const body = await resp.json();
        for (const k of body?.found || []) found.add(k);
    }
    return found;
}
