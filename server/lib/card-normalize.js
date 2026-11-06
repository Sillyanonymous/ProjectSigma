// Normalizes any card shape (V1 flat, V2, V3) to { spec, spec_version, data }; root V1 mirrors are a fallback, then dropped
import { isDeepStrictEqual } from 'node:util';

const V1_FIELDS = [
    'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions', 'alternate_greetings',
    'character_book', 'tags', 'creator', 'character_version', 'extensions',
];

// ST library/op state that does not belong in a card; lifted into DB columns at import
export const OP_STATE_EXTENSIONS = ['fav', 'chat', 'chat_size', 'date_last_chat', 'update_locked'];

// identity keys an import reads as aliases and never stores (cl keeps its user content)
export const IDENTITY_EXTENSIONS = ['version_uid', 'gallery_id', 'cl'];

// keys card tools (ST, RisuAI) keep in data.extensions; a provider namespace on one would eat their data
export const CARD_FORMAT_EXTENSIONS = ['talkativeness', 'regex_scripts', 'sd_character_prompt', 'risuai'];

/** A card file's payloads ({ v3, v2 }, readCardChunks' shape) as one normalized card, the V3 one first; null when neither names a card. */
export function normalizeCard(parsed) {
    return undoCharxLift(normalizeSource(cardSourceOf(parsed)));
}

// what a CHARX's V3 card.json requires of data, with the value a card that never had a field reads as
const V3_REQUIRED = {
    name: '', description: '', tags: [], creator: '', character_version: '', mes_example: '', extensions: {}, system_prompt: '',
    post_history_instructions: '', first_mes: '', alternate_greetings: [], personality: '', scenario: '', creator_notes: '', group_only_greetings: [],
};

/**
 * An export card as a CHARX's V3 card.json, every change recorded in extensions.cl.charx for an import to undo.
 * @param {{ createdAt?: number, updatedAt?: number, assets: object[], readBack: object[] }} opts readBack: assets as an import keeps them
 */
export function liftForCharx(card, { createdAt, updatedAt, assets, readBack }) {
    const data = { ...card.data };
    const fields = {};
    const set = (key, value, wrote = value) => {
        fields[key] = data[key] === undefined ? { absent: true, wrote } : { was: data[key], wrote };
        data[key] = value;
    };
    for (const [key, value] of Object.entries(V3_REQUIRED)) if (data[key] === undefined) set(key, structuredClone(value));
    if (data.creation_date === undefined && Number.isFinite(createdAt)) set('creation_date', Math.floor(createdAt / 1000));
    if (data.modification_date === undefined && Number.isFinite(updatedAt)) set('modification_date', Math.floor(updatedAt / 1000));
    set('assets', assets, readBack);
    data.extensions = { ...data.extensions, cl: { ...(data.extensions.cl || {}), charx: { spec: card.spec, spec_version: card.spec_version, fields } } };
    return { spec: 'chara_card_v3', spec_version: '3.0', data };
}

// a CHARX export's card as it was stored, when every field the export set still reads as written; else the V3 card it became
function undoCharxLift(card) {
    const mark = card?.data?.extensions?.cl?.charx;
    if (mark === undefined) return card;
    const { charx: _, ...cl } = card.data.extensions.cl;
    const extensions = { ...card.data.extensions };
    if (Object.keys(cl).length) extensions.cl = cl; else delete extensions.cl;
    const data = { ...card.data, extensions };
    const spec = mark?.spec === 'chara_card_v2' || mark?.spec === 'chara_card_v3' ? mark.spec : null;
    const fields = isPlainObject(mark?.fields) ? Object.entries(mark.fields) : [];
    if (!spec || !fields.every(([key, f]) => isPlainObject(f) && isDeepStrictEqual(data[key], f.wrote))) return { ...card, data };
    for (const [key, f] of fields) {
        if (f.absent) delete data[key];
        else data[key] = f.was;
    }
    return { spec, spec_version: typeof mark.spec_version === 'string' ? mark.spec_version : (spec === 'chara_card_v3' ? '3.0' : '2.0'), data };
}

/** The payload normalizeCard reads: a named V3 card, any field only V2 holds kept beside it; else V2 as it came. Null for neither. */
export function cardSourceOf(parsed) {
    const v2 = normalizeSource(parsed?.v2) ? parsed.v2 : null;
    if (!normalizeSource(parsed?.v3)) return v2;
    return v2 ? withV2Fields(parsed.v3, normalizeSource(v2).data) : parsed.v3;
}

/** The roots op state is lifted from (fav, create_date): the chosen payload's, a V2 payload's filling what it lacks. */
export function opStateSourceOf(parsed) {
    const v2 = parsed?.v2 && typeof parsed.v2 === 'object' && !Array.isArray(parsed.v2) ? parsed.v2 : {};
    return { ...v2, ...(cardSourceOf(parsed) || {}) };
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// a V2 chunk's own fields beside the V3 chunk's, never over a V3 value (its root mirrors included)
function withV2Fields(v3, v2Data) {
    const own = isPlainObject(v3.data) ? v3.data : {};
    const data = { ...own };
    for (const [key, value] of Object.entries(v2Data)) {
        if (key !== 'extensions' && data[key] === undefined && v3[key] === undefined) data[key] = value;
    }
    const v2Ext = v2Data.extensions;
    const v3Ext = isPlainObject(own.extensions) ? own.extensions : isPlainObject(v3.extensions) ? v3.extensions : {};
    if (Object.keys(v2Ext).length) data.extensions = { ...v2Ext, ...v3Ext };
    return { ...v3, data };
}

function normalizeSource(source) {
    if (!source || typeof source !== 'object') return null;

    let spec = 'chara_card_v2';
    let specVersion = '2.0';
    let data;

    if (source.spec === 'chara_card_v3' || source.spec === 'chara_card_v2') {
        spec = source.spec;
        specVersion = typeof source.spec_version === 'string' ? source.spec_version
            : (spec === 'chara_card_v3' ? '3.0' : '2.0');
        data = { ...(source.data || {}) };
        // fill gaps from root V1 mirrors when the wrapper carries them (ST does)
        for (const field of V1_FIELDS) {
            if (data[field] === undefined && source[field] !== undefined) data[field] = source[field];
        }
    } else {
        // V1 flat card
        data = {};
        for (const field of V1_FIELDS) {
            if (source[field] !== undefined) data[field] = source[field];
        }
    }

    if (!data.name || typeof data.name !== 'string') return null;
    if (!Array.isArray(data.tags)) data.tags = data.tags ? [String(data.tags)] : [];
    data.tags = data.tags.map(t => String(t).trim()).filter(Boolean);
    data.extensions = (data.extensions && typeof data.extensions === 'object' && !Array.isArray(data.extensions))
        ? { ...data.extensions } : {};

    return { spec, spec_version: specVersion, data };
}

/**
 * Removes ST op-state from a normalized card, returning what was lifted.
 * Mutates card.data.extensions.
 */
export function liftOpState(card, rawSource) {
    const lifted = {
        fav: card.data.extensions.fav === true || card.data.extensions.fav === 'true'
            || rawSource?.fav === true || rawSource?.fav === 'true',
        updateLocked: card.data.extensions.update_locked === true,
        createDate: rawSource?.create_date ?? card.data.extensions.create_date ?? null,
    };
    for (const key of OP_STATE_EXTENSIONS) delete card.data.extensions[key];
    return lifted;
}
