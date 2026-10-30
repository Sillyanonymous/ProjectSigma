// Each server pipeline's value and facts as TypeScript strings, and the short-id grammar. Pure data,
// so the type generator can import it.

const freeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v); return Object.freeze(o); };

// the lore scan's facts, the same object for both of its pipelines
const LORE_FACTS = 'PipelineFacts & { chatId: string; charId: string; trigger: PromptTrigger; dryRun: boolean; books: readonly string[]; texts: readonly string[] }';

export const PIPELINE_TYPES = freeze({
    'card.import': { value: 'Card', context: 'PipelineFacts & { sourceName: string | null; provider: string | null }' },
    'card.export': { value: 'Card', context: 'PipelineFacts & { id: string }' },
    'chat.export': { value: 'Array<Record<string, unknown>>', context: 'PipelineFacts & { chatId: string; charId: string }' },
    'lore.candidates': { value: 'ExtensionBook[]', context: LORE_FACTS },
    'lore.activate': { value: 'PlacedLore', context: LORE_FACTS },
    'prompt.final': { value: 'PromptMessage[]', context: 'PipelineFacts & { chatId: string; charId: string; trigger: PromptTrigger; dryRun: boolean }' },
    'llm.request': { value: 'LlmRequest', context: 'PipelineFacts & { purpose: LlmPurpose; profileKind: string; profileId: string | null; extension?: string }' },
    'reply.final': {
        value: 'string',
        context: "PipelineFacts & ({ surface: 'chat'; chatId: string; mode: 'append' | 'regenerate' | 'swipe' | 'continue'; interrupted: string | null }"
            + " | { surface: 'assistant'; chatId: string; sessionId: string; interrupted: string | null }"
            + " | { surface: 'creator'; chatId: null; charId: string | null; sessionId: string; interrupted: string | null })",
    },
});

// a prompt block's, a schedule's, a lazy declaration's and a browser consumer's id; the page's
// registrars hold theirs to the same pattern (WINDOW_ID_RE)
export const SLUG_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Throws, naming where, unless id is a short slug (SLUG_ID_RE), read as the page's registrars read one. */
export function assertSlugId(where, id) {
    if (!SLUG_ID_RE.test(String(id || ''))) throw new Error(`${where}: id '${id}' must be lowercase letters, digits and dashes, starting with a letter, at most 32`);
}
