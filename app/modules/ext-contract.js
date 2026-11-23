// The types of what flows through each door, as TypeScript strings: the registry reads them and
// tools/extension-types.mjs writes docs/extensions.d.ts.

const freeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v); return Object.freeze(o); };

export const COMMAND_TYPES = freeze({
    'chat.open': { args: '{ chatId: string; seq?: number; messageId?: number }', answers: 'boolean' },
    'chat.compose': { args: "{ text: string; mode?: 'replace' | 'append' }", answers: 'boolean' },
    'chat.send': { args: '{ text: string }', answers: 'boolean' },
    'character.open': { args: '{ id: string; elevated?: boolean; navList?: ReadonlyArray<Character | undefined>; char?: Readonly<Character> }', answers: 'boolean' },
    'character.delete': { args: '{ ids: string[] } | { filter: string; expect?: number }', answers: '{ deleted: string[]; missing: string[] } | { changed: number; missing: number; stopped?: true }' },
    'character.favorite': { args: '({ ids: string[] } | { filter: string }) & { value: boolean }', answers: '{ affected: string[]; skipped: string[] } | { changed: number; stopped?: true }' },
    'character.update': { args: '{ id: string; fields: CardFields; rootFields?: Readonly<CardFlags>; source?: string; char?: Readonly<Character> | null }', answers: '{ ok: boolean; error?: string; told?: boolean }' },
    'character.update-many': { args: '{ updates: Array<{ id: string; fields: CardFields }> }', answers: '{ affected: string[]; failed: Array<{ id: string; error: string }> }' },
    'character.export': { args: "({ ids: string[] } | { filter: string }) & { format?: 'png' | 'charx' | 'links' | 'bundle'; worlds?: boolean; signal?: AbortSignal; onProgress?: (done: number) => void }", answers: '{ exported: string[]; skipped: string[]; skippedCount?: number; bytes?: number } | { count: number; skippedCount: number; bytes?: number }' },
    'character.import': { args: "({ file: File | Blob } | { url: string } | { provider: string; id: string; data?: unknown } | { stage: { stageId: string; card: Record<string, unknown>; name?: string } }) & { onExisting?: 'copy' | { replace: string } | null; options?: Record<string, unknown> }", answers: 'ImportResult' },
    'character.create': { args: '{ card: CardInput | CardData; image?: ArrayBuffer | ArrayBufferView | Blob }', answers: '{ id: string; name: string }' },
    'creator.open': { args: '{ id?: string }', answers: 'boolean' },
    'character.snapshot': { args: '{ id: string; label?: string; char?: Readonly<Character> }', answers: '{ snapshot: number; label: string }' },
    'library.search': { args: '{ query: string }', answers: 'true' },
    'library.filter': { args: '{ tag: string } | { creator: string } | { playlist: string | null }', answers: 'true' },
    'library.select': { args: '{ ids: string[]; value?: boolean } | { all: true } | { clear: true }', answers: 'number' },
    'tags.apply': { args: '({ ids: string[] } | { filter: string }) & { add?: string[]; remove?: string[] }', answers: '{ affected: string[]; skipped: string[]; deltas: Array<{ charId: string; added: string[]; removed: string[] }> } | { changed: number; added: Array<{ name: string; count: number }>; removed: Array<{ name: string; count: number }>; stopped?: true }' },
    'settings.open': { args: '{ section?: string }', answers: 'boolean' },
    'view.switch': { args: '{ view: ViewName }', answers: 'true' },
    'lorebook.open': { args: '{ name?: string; uid?: number }', answers: 'boolean' },
});

// a payload names what changed by id; every listener shares it, so its lists and objects are frozen
export const EVENT_TYPES = freeze({
    'character.created': { ids: 'readonly string[]', origin: 'Origin' },
    'character.updated': { ids: 'readonly string[]', fields: 'readonly string[]', all: 'boolean', origin: 'Origin' },
    'character.deleted': { ids: 'readonly string[]', origin: 'Origin' },
    'chat.created': { ids: 'readonly string[]', charId: 'string | null', branchOf: 'Readonly<{ chatId: string; seq: number; messageId: number }> | null', origin: 'Origin' },
    'chat.updated': { ids: 'readonly string[]', fields: 'readonly string[]', origin: 'Origin' },
    'chat.deleted': { ids: 'readonly string[]', charId: 'string | null', origin: 'Origin' },
    'message.created': { chatId: 'string | null', seqs: 'readonly number[]', messageIds: 'readonly number[]', origin: 'Origin' },
    'message.updated': { chatId: 'string | null', seqs: 'readonly number[]', messageIds: 'readonly number[]', all: 'boolean', origin: 'Origin' },
    'message.deleted': { chatId: 'string | null', seqs: 'readonly number[]', messageIds: 'readonly number[]', origin: 'Origin' },
    'settings.changed': { keys: 'readonly string[]', all: 'boolean', origin: 'Origin' },
    'tags.changed': { names: 'readonly string[]', origin: 'Origin' },
    'playlists.changed': { ids: 'readonly string[]', all: 'boolean', origin: 'Origin' },
    'media.changed': { ids: 'readonly number[]', charId: 'string | null', origin: 'Origin' },
    'library.changed': { reason: "'import' | 'resync'", origin: 'Origin' },
    'generation.started': { chatId: 'string', mode: 'GenerationMode', targetSeq: 'number | null' },
    'generation.ended': { chatId: 'string', mode: 'GenerationMode', seq: 'number | null', messageId: 'number | null' },
    'generation.failed': { chatId: 'string', mode: 'GenerationMode', cancelled: 'boolean', error: 'string | null' },
    'conversation.changed': { chatId: 'string | null', charId: 'string | null' },
    'lorebook.changed': { name: 'string | null', origin: 'Origin' },
    'persona.changed': { scope: "'global' | 'chat' | 'delete' | null", personaId: 'string | null', chatId: 'string | null', origin: 'Origin' },
    'library.ready': {},
    'extensions.ready': {},
    'ui.formFactorChanged': { mobile: 'boolean' },
    'notifications.changed': { level: "'warning' | 'activity' | 'none'", visible: 'boolean' },
});

// a filter has a value it hands on; an action is only told
export const HOOK_TYPES = freeze({
    'message.render': { value: 'string', context: '{ chatId: string; charId: string | null; seq: number; messageId: number | null; message: Readonly<Message>; format(text: string): string }', answer: 'string | undefined' },
    'message.enhance': { context: '{ chatId: string; seq: number; messageId: number; el: HTMLElement; message: Readonly<Message> }', answer: 'void' },
    'composer.send': { value: 'string', context: '{ chatId: string; charId: string | null }', answer: 'MaybePromise<string | undefined>' },
});

export const SLOT_TYPES = freeze({
    'chat.action': { context: { chatId: 'string', character: 'Readonly<Character> | null' }, spec: "ActionSpec<SlotContext<'chat.action'>>" },
    'message.action': { context: { chatId: 'string', character: 'Readonly<Character> | null', seq: 'number', messageId: 'number | null', message: 'Readonly<Message>' }, spec: "ActionSpec<SlotContext<'message.action'>>" },
    'character.action': { context: { character: 'Readonly<Character>' }, spec: "ActionSpec<SlotContext<'character.action'>>" },
    'character.bulk.action': { context: { characters: 'ReadonlyArray<Readonly<Character>> | null', selection: 'Readonly<{ count: number; filter: string | null }>' }, spec: "ActionSpec<SlotContext<'character.bulk.action'>>" },
    'app.action': { context: { view: 'ViewName' }, spec: "ActionSpec<SlotContext<'app.action'>>" },
    'chat.window': { context: { chatId: 'string | null', character: 'Readonly<Character> | null', panel: 'HTMLElement', body: 'HTMLElement', close: '() => void' }, spec: 'ChatWindowSpec' },
    'extension.settings': { context: {}, spec: 'SettingsSectionSpec' },
    'provider.settings': { context: { providerId: 'string' }, spec: 'ProviderSectionSpec' },
    'character.card.badge': { context: { row: 'Readonly<Character>' }, spec: 'BadgeSpec' },
    'character.details.tab': { context: { character: 'Readonly<Character>', isCurrent: '() => boolean' }, spec: 'DetailTabSpec' },
    'shell.view': { context: {}, spec: 'ViewSpec' },
    'lore.entry.action': { context: { world: 'string', uid: 'number | null', entry: 'Readonly<LoreEntryView>', chatId: 'string | null' }, spec: "ActionSpec<SlotContext<'lore.entry.action'>>" },
    'chat.card.action': { context: { chatId: 'string', charId: 'string | null', chat: 'Readonly<ChatCardView>' }, spec: "ActionSpec<SlotContext<'chat.card.action'>>" },
    'composer.action': { context: { chatId: 'string', character: 'Readonly<Character> | null', anchor: 'HTMLElement' }, spec: "ActionSpec<SlotContext<'composer.action'>>" },
});
