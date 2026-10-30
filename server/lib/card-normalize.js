// Normalizes any card shape (V1 flat, V2, V3) to { spec, spec_version, data }; root V1 mirrors are a fallback, then dropped

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
    for (const source of [parsed?.v3, parsed?.v2]) {
        const card = normalizeSource(source);
        if (card) return card;
    }
    return null;
}

/** The payload normalizeCard reads: V3 when it holds a named card, else V2 (a broken ccv3 can sit beside a good chara). */
export function cardSourceOf(parsed) {
    return [parsed?.v3, parsed?.v2].find(source => normalizeSource(source)) ?? null;
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
