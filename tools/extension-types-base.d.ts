// Types for Σ extensions: the client entry's ctx (api 2) and every command, event, conversation
// hook and slot the app opens to it, and the server half's ctx with its pipelines and store
// guards. The guide is docs/guide.html#extensions.
//
// From JavaScript, with JSDoc (an editor that reads TypeScript completes and checks it):
//
//     /** @type {import('./extensions').ClientExtension} */
//     export default {
//         async init(ctx) {
//             ctx.events.on('character.updated', ({ ids, fields }) => { /* ... */ });
//         },
//     };

// ======== the client entry ========

/** Your client entry's default export. */
export interface ClientExtension {
    /** Runs when the extension loads: at startup, or the moment a user switches it on. */
    init(ctx: ExtensionContext): void | Promise<void>;
    /** Runs when the user switches it off, after the host undid what you registered through ctx; also once an init that threw, or was switched off while it ran, has settled. A promise is waited for (up to five seconds) before the extension loads again. */
    dispose?(): void | Promise<void>;
}

/** What init is handed: api 2, the part promised not to break casually. */
export interface ExtensionContext {
    /** The host's extension api, '<major>.<minor>': the minor counts the batches of doors added within the major. */
    readonly apiVersion: '2.10';
    /** Your row in the server's inventory: its reading of your manifest.json. */
    readonly manifest: ManifestRow;
    /** The facade the app's own modules use, every function it exports; not typed here. What you register through onViewEnter, onViewExit, onCharactersDeleted, storeWatch or onJob answers its removal and is undone when you are switched off; a notifications section from registerNotificationSection answers its node and is taken out then too, or sooner by removeNotificationSection(id); its id is yours alone, held under your extension's name, so it never replaces the app's section or another extension's. */
    readonly CoreAPI: CoreApi;
    /** console.log prefixed with your id. */
    log(...args: unknown[]): void;
    readonly commands: ExtensionCommands;
    readonly keys: ExtensionKeys;
    readonly events: ExtensionEvents;
    readonly hooks: ExtensionHooks;
    readonly server: ExtensionServer;
    readonly messages: ExtensionMessages;
    readonly storage: ExtensionStorage;
    readonly settings: ExtensionSettings;
    readonly chats: ExtensionChats;
    readonly ui: ExtensionUi;
    readonly providers: ExtensionProviders;
    readonly browser: ExtensionBrowser;
}

export interface ExtensionCommands {
    /** Run a command by id and get its answer: the app's own verbs and every extension's. */
    run<K extends keyof Commands>(id: K, ...args: ArgsOf<K>): MaybePromise<Commands[K]['answers']>;
    run<I extends string>(id: Exclude<I, keyof Commands>, args?: unknown): unknown;
    /** Every command: its title, who wraps it and, for the app's own, its types. */
    list(): CommandInfo[];
    /** A command of your own, registered as <your id>.<name>; answers that full id. */
    register(name: string, fn: (args: any) => unknown, meta?: { title?: string }): string;
    /** Wrap any command; answers the unwrap. */
    wrap<K extends keyof Commands>(id: K, wrapper: CommandWrapper<Commands[K]['args'], Commands[K]['answers']>, opts?: WrapOptions): () => void;
    wrap<I extends string>(id: Exclude<I, keyof Commands>, wrapper: CommandWrapper<any, unknown>, opts?: WrapOptions): () => void;
}

export interface ExtensionKeys {
    /** A shortcut of your own, registered as <your id>.<id>: listed in Settings > Keyboard under your extension, rebound there, gone when you are switched off. A key the app or another extension uses where yours works throws, naming the clash. Answers the full id. */
    register(spec: KeySpec): string;
}

/** An action in the app's keymap. */
export interface KeySpec {
    /** Lowercase words joined by dots or dashes. */
    id: string;
    /** What Settings > Keyboard calls it. */
    label: string;
    /** As the app writes keys: 'Mod+Shift+H', 'H', '/', 'Shift+Escape'. Mod is Cmd on a Mac and Ctrl elsewhere. A key with no Mod, Ctrl or Alt never fires while the user types in a field. Leave it out to ship the action unbound. */
    key?: string;
    /** Where it runs: everywhere (the default), the library's grid or a conversation, while that is in front. */
    scope?: 'global' | 'library' | 'conversation';
    run(): void | Promise<void>;
}

/** A command's args as run's rest: optional when the command needs none of them. */
export type ArgsOf<K extends keyof Commands> = {} extends Commands[K]['args'] ? [args?: Commands[K]['args']] : [args: Commands[K]['args']];

/** wrapper(next, args): hand on with next() or next(newArgs), change the answer, or answer on your own. */
export type CommandWrapper<A, R> = (next: (args?: A) => MaybePromise<R>, args: A) => MaybePromise<R>;

export interface WrapOptions {
    /** Higher runs first (outermost); 0 by default. */
    priority?: number;
    /** Says up front that this wrapper answers without calling next. */
    override?: boolean;
}

export interface ExtensionEvents {
    /** A listed name hands fn its frozen payload; any other name adds a plain DOM listener. fn is a function or an object with a handleEvent method, as addEventListener takes. */
    on<K extends keyof Events>(name: K, fn: ((payload: Readonly<Events[K]>) => void) | { handleEvent(payload: Readonly<Events[K]>): void }): void;
    on<I extends string>(name: Exclude<I, keyof Events>, fn: ((event: Event) => void) | { handleEvent(event: Event): void }): void;
    off<K extends keyof Events>(name: K, fn: ((payload: Readonly<Events[K]>) => void) | { handleEvent(payload: Readonly<Events[K]>): void }): void;
    off<I extends string>(name: Exclude<I, keyof Events>, fn: ((event: Event) => void) | { handleEvent(event: Event): void }): void;
    /** Dispatches ext:<your id>:<name> on the document. */
    emit(name: string, detail?: unknown): void;
    /** The listed events, their payload keys and each key's type. */
    list(): EventInfo[];
}

export interface ExtensionHooks {
    /** Join one of the conversation's hooks, highest priority first; answers the removal. */
    add<K extends keyof ConversationHooks>(name: K, fn: HookFunction<ConversationHooks[K]>, opts?: { priority?: number }): () => void;
    /** The hooks, with their kind and types. */
    list(): HookInfo[];
}

/** A filter is handed the value and the context and answers the value to hand on; an action is told. */
export type HookFunction<H> = H extends { kind: 'filter'; value: infer V; context: infer C; answer: infer A }
    ? (value: V, context: C) => A
    : H extends { context: infer C; answer: infer A } ? (context: C) => A : never;

export interface ExtensionServer {
    /** A request to your own server half, under /api/ext/<your id> (a GET with no body by default). Answers the parsed body; a refused request throws an Error in the server's words, carrying its status and the parsed body as data. A signal stops it, the request aborting with an AbortError. */
    call<T = any>(path: string, method?: string, body?: unknown, opts?: { signal?: AbortSignal }): Promise<T>;
    /** The same request read as it arrives (a POST with no body by default): each line of an application/x-ndjson answer, parsed, as it lands; any other answer that is not a refusal, its parsed body once. A refusal throws as call's does, and a signal stops it; leaving the loop early lets the answer go. */
    stream<T = any>(path: string, method?: string, body?: unknown, opts?: { signal?: AbortSignal }): AsyncIterable<T>;
}

export interface ExtensionMessages {
    /** The text a message shows: its active alternate when it has several (swipe_id held to the list), else mes; '' for anything else. Your server half's ctx.messages.shown answers alike. */
    shown(msg: Readonly<Message> | null | undefined): string;
    /** FNV-1a over a text, as eight hex digits, the same as your server half's ctx.messages.digest. */
    digest(text: string): string;
}

export interface ExtensionStorage {
    /** Your per-user document, null when none was saved; a failed read throws. */
    load<T = any>(): Promise<T | null>;
    /** Replaces the document; a failed write throws. */
    save(doc: object): Promise<void>;
}

export interface ExtensionSettings {
    /** The stored value, or your manifest's default when nothing (or null, or '') is stored. */
    get<T = any>(key: string): T;
    /** In memory at once, saved within about half a second. */
    set(key: string, value: unknown): void;
    /** Your manifest's "settings" block. */
    readonly defaults: Readonly<Record<string, unknown>>;
}

export interface ExtensionChats {
    /** Open a chat from any view and bring a message into view: messageId names it wherever it sits now, seq names a place (messageId wins); true when it is the open conversation. Always a promise, a failure below it a rejection. */
    open(chatId: string, opts?: { seq?: number; messageId?: number }): Promise<boolean>;
    /** One chat's data read while it is shown: the newest read wins, a read that lands after its chat left the screen is dropped, and it is read again every pollMs while working says the server is at it. */
    follow<T = any>(spec: FollowSpec<T>): Follower;
}

export interface FollowSpec<T = any> {
    /** Reads the shown chat's data. */
    read(chatId: string): Promise<T>;
    /** Hands what the newest read of the shown chat answered; null, with null, when no chat is shown. */
    apply(data: T | null, chatId: string | null): void;
    /** A read of the shown chat failed. */
    fail?(error: Error, chatId: string): void;
    /** The shown chat changed, before its read. */
    moved?(chatId: string | null, was: string | null): void;
    /** Whether the server is still at it: while true (and shown), it is read again every pollMs. */
    working?(data: T): boolean;
    /** How long reloadSoon waits for the writes to settle; 400 ms by default. */
    soonMs?: number;
    /** The poll's interval while working; 2000 ms by default. */
    pollMs?: number;
}

export interface Follower {
    /** Shows a chat (null for none) and reads it. */
    show(chatId: string | null): Promise<void>;
    /** Reads the shown chat now. */
    reload(): Promise<void>;
    /** Reads it once the writes settle: calls within soonMs read once. */
    reloadSoon(): void;
    /** Stops the poll and a waiting reloadSoon, until the next show. */
    rest(): void;
    isOpen(): boolean;
    chatId(): string | null;
}

export interface ExtensionUi {
    /** Fill a slot; ctx.ui.slots() lists them. Throws on an unknown slot or a spec missing what it needs. */
    contribute<K extends keyof Slots>(slotId: K, spec: Slots[K]['spec']): void;
    /** Every slot: its kind, its context's keys and types, the spec it takes, how a phone gets it. */
    slots(): SlotInfo[];
    /** contribute('extension.settings', { render }): a body in your row in Settings > Extensions. Throws without render. */
    addSettingsSection(render: (el: HTMLElement) => void): void;
    /** contribute('provider.settings', ...): the body of your provider's section in Settings > Online. Throws without the provider id or render. */
    addProviderSettingsSection(providerId: string, render: (el: HTMLElement) => void | Promise<void>, opts?: { excludeTagsHint?: string }): void;
    /** contribute('chat.window', spec): a window in the conversation. */
    addChatWindow(spec: ChatWindowSpec): void;
    /** An overlay you build yourself, in the app's overlay stack; answers the element id to give it. */
    addOverlay(spec: OverlaySpec): string;
    /** A dialog in the app's own shell, on top of addOverlay: the host builds and closes it, you fill its body. */
    dialog(spec: DialogSpec): Dialog;
    /** The account's connections appended to a select (its first option stands for the default), the stored key chosen and each pick kept under it; key null keeps nothing. One read for every picker a pass draws. */
    connectionSelect(select: HTMLSelectElement, opts?: { key?: string | null }): Promise<{ gone: boolean }>;
    /** contribute('<slot>', spec) by the menu's word: a verb in one of the app's menus. */
    addAction<W extends keyof ActionSlots>(slot: W, spec: Slots[ActionSlots[W]]['spec']): void;
}

export interface ExtensionProviders {
    /** A character source: its ProviderBase instance and its provider row. Needs provider: true in manifest.json. */
    register(provider: ProviderLike, manifestRow?: ProviderRow): Promise<void>;
}

export interface ExtensionBrowser {
    /** A same-origin fetch inside the hosted browser through a consumer your server half registered by this name; throws an AbortError when signal aborts. */
    fetch(name: string, path: string, opts?: { headers?: Record<string, string>; method?: 'GET' | 'POST'; jsonBody?: object; timeoutMs?: number; signal?: AbortSignal | null }): Promise<{ status: number; body: string; retryAfter: string }>;
}

// ======== what the lists answer ========

export interface CommandInfo {
    readonly id: string;
    readonly title: string;
    /** 'core' for the app's own, else the extension's id. */
    readonly owner: string;
    readonly wrappedBy: readonly string[];
    /** The TypeScript type of its args (the app's own commands; null for an extension's). */
    readonly args: string | null;
    readonly answers: string | null;
}

export interface EventInfo {
    readonly name: keyof Events;
    readonly payload: readonly string[];
    /** Each payload key's TypeScript type. */
    readonly types: Readonly<Record<string, string>>;
}

export interface HookInfo {
    readonly name: keyof ConversationHooks;
    readonly kind: 'filter' | 'action';
    /** A filter that may answer a promise, which the site awaits. */
    readonly async: boolean;
    /** The value a filter is handed; null for an action. */
    readonly value: string | null;
    readonly context: string;
    readonly answer: string;
}

export interface SlotInfo {
    readonly id: keyof Slots;
    readonly kind: SlotKind;
    readonly context: readonly string[];
    readonly types: Readonly<Record<string, string>>;
    /** The TypeScript type of the spec contribute takes for it. */
    readonly spec: string;
    readonly phone: 'same' | 'mirror' | 'none';
    readonly reason: string;
    readonly title: string;
}

// ======== what the slots take ========

/** A slot's context: what its callbacks are handed. */
export type SlotContext<K extends keyof Slots> = Slots[K]['context'];

/** The word addAction takes for each action slot. */
export interface ActionSlots {
    chat: 'chat.action';
    message: 'message.action';
    character: 'character.action';
    app: 'app.action';
    bulk: 'character.bulk.action';
    lore: 'lore.entry.action';
    chatCard: 'chat.card.action';
    composer: 'composer.action';
}

export interface ActionSpec<C> {
    /** [a-z][a-z0-9-]{0,31}, unique within the slot. */
    id: string;
    /** Up to 40 characters. */
    label: string;
    /** A Font Awesome solid name, like fa-hand. */
    icon: string;
    /** Asked each time its surface shows it (a menu opening, the composer's strip drawing), synchronously; false hides it. */
    when?(context: C): boolean;
    run(context: C): void | Promise<void>;
}

export interface ChatWindowSpec {
    /** [a-z][a-z0-9-]{0,31}, unique within your extension. */
    id: string;
    /** The title and the button's tooltip, up to 40 characters. */
    label: string;
    icon: string;
    /** Percent of the conversation area. */
    min?: { w: number; h: number };
    /** The first size, percent too (at least min). */
    size?: { w: number; h: number };
    /** Runs once, on the first open. */
    render(body: HTMLElement, context: SlotContext<'chat.window'>): void | Promise<void>;
    onOpen?(context: SlotContext<'chat.window'>): void | Promise<void>;
    onClose?(context: SlotContext<'chat.window'>): void | Promise<void>;
    /** A character this tab holds was written: detail names which one; re-read it. source is the app's own and may change. */
    follow?(detail: { charId: string; source: string }, context: SlotContext<'chat.window'>): void | Promise<void>;
    /** Asked whenever its doors are laid out (a window added or removed, a conversation opening or its character landing, an extension's setting written, the phone's options opening), synchronously; false takes its doors away and closes it. */
    when?(context: { chatId: string | null; character: Readonly<Character> | null }): boolean;
}

export interface SettingsSectionSpec {
    /** Runs every time the manager draws its list; keep it repeatable. */
    render(el: HTMLElement): void;
}

export interface ProviderSectionSpec {
    providerId: string;
    render(el: HTMLElement): void | Promise<void>;
    excludeTagsHint?: string;
}

export interface BadgeSpec {
    /** [a-z][a-z0-9-]{0,31}, unique within your extension. */
    id: string;
    /** Pure and synchronous: it runs while the grid builds its cards. */
    render(row: SlotContext<'character.card.badge'>['row']): Chip | null;
}

export interface Chip {
    icon?: string;
    /** Up to 24 characters; longer is cut. */
    label?: string;
    tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
}

export interface DetailTabSpec {
    id: string;
    /** Up to 24 characters. */
    label: string;
    icon?: string;
    /** Paints the pane the first time the tab shows for a character. */
    render(pane: HTMLElement, context: SlotContext<'character.details.tab'>): void | Promise<void>;
}

export interface ViewSpec {
    id: string;
    /** Up to 24 characters. */
    label: string;
    icon: string;
    /** Paints the view's container on its first entry; a promise it answers is waited for before the first enter. */
    render(el: HTMLElement): void | Promise<void>;
    /** Every entry, after render has settled on the first; not run when the view was left before. */
    enter?(el: HTMLElement): void | Promise<void>;
    leave?(): void | Promise<void>;
    /** A phone's pull-to-refresh re-reads the view through this; a view without it never arms the pull. */
    refresh?(): void | Promise<void>;
}

export interface DialogSpec {
    /** [a-z][a-z0-9-]{0,31}, unique among your overlays; the element is ext-<your id>-<id>. */
    id: string;
    /** Its name (the aria-label) and its title by default; up to 60 characters. */
    label: string;
    /** A Font Awesome solid name, before the title. */
    icon?: string;
    /** Classes for the dialog's box (.cl-modal-content). */
    className?: string;
    /** Resizable from its edges, its size kept; false by default. */
    size?: boolean;
    /** The floor it resizes to, in pixels. */
    min?: { w: number; h: number };
    /** Asked before a dismissal (Escape, a phone's back, the backdrop, its close control) closes it: false, or a promise of false, keeps it open. Never asked when forced, or when your extension is switched off. */
    canClose?(how: DialogClose): boolean | Promise<boolean>;
    /** Told it closed, by any road. */
    onClose?(how: DialogClose): void;
}

export interface DialogClose {
    force?: boolean;
    /** Your extension is being switched off. */
    leaving?: boolean;
}

export interface Dialog {
    /** Builds it afresh (an open one closes first, unasked), shows it on the next frame and answers its body. */
    open(opts?: { title?: string }): HTMLElement;
    /** Closes it, asking canClose unless forced; answers whether it closed. */
    close(how?: DialogClose): Promise<boolean>;
    isOpen(): boolean;
    /** The dialog's element while it is open, else null. */
    readonly el: HTMLElement | null;
}

export interface OverlaySpec {
    id: string;
    /** Closes it: Escape and a phone's back call this for the topmost overlay. Switching the extension off calls it with { leaving: true }: take the overlay off the page without asking (the host removes the element afterwards either way). */
    close(how?: { leaving?: boolean }): void;
    visible?(el: HTMLElement): boolean;
}

// ======== the app's things, as the doors hand them ========

/** 'self' when this tab made the change, 'remote' for anything else. */
export type Origin = 'self' | 'remote';

export type MaybePromise<T> = T | Promise<T>;

/** A view: the app's three, or an extension's (ext:<id>/<view id>). */
export type ViewName = 'characters' | 'chats' | 'online' | `ext:${string}/${string}`;

/** The app's own object for a character: read it, never write it. */
export interface Character {
    readonly id: string;
    readonly name: string;
    /** The card's data as the app holds it (a grid row holds only what the grid shows). */
    readonly data?: Readonly<CardData>;
    readonly tags?: readonly string[];
    /** The ids of the playlists that hold the character. */
    readonly playlists?: readonly string[];
    /** What server halves' projection fields put on the row: { <extension id>: { <key>: value } }. */
    readonly ext?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly [key: string]: unknown;
}

/** A character card: V2 or V3. */
export interface Card {
    spec: string;
    spec_version: string;
    data: CardData;
}

/** A card as character.create takes it: a spec left off makes a V2 card. */
export interface CardInput {
    spec?: string;
    spec_version?: string;
    data: CardData;
}

export interface CardData {
    name: string;
    description?: string;
    personality?: string;
    scenario?: string;
    first_mes?: string;
    mes_example?: string;
    creator_notes?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    alternate_greetings?: string[];
    tags?: string[];
    creator?: string;
    character_version?: string;
    extensions?: Record<string, unknown>;
    [key: string]: unknown;
}

/** Card fields by dot path, as PATCH /api/characters/{id} takes them; null deletes one. */
export type CardFields = Record<string, unknown>;

/** The library's own flags on a character, kept beside the card rather than in it. */
export interface CardFlags {
    fav?: boolean;
    mediaLocalized?: boolean;
    loreDismissed?: boolean;
}

/** A stored chat message: the SillyTavern row, as the JSONL export writes it. */
export interface Message {
    name?: string;
    is_user?: boolean;
    is_system?: boolean;
    mes: string;
    swipes?: string[];
    swipe_id?: number;
    /** Where extensions keep data on a message, each under its own id. */
    extra?: Record<string, unknown>;
    [key: string]: unknown;
}

/** A message as the HTTP API answers it and ctx.stores.chats.projectMessage builds it. */
export interface ChatMessage {
    /** Its own id: never reused, kept when an earlier message's delete moves it a place. */
    id: number;
    /** Its place in the chat, 0 to n - 1. */
    seq: number;
    /** When it was written, unix ms: the stored send_date as the server reads it; null when unreadable. */
    createdAt: number | null;
    role: 'user' | 'assistant' | 'system';
    name: string | null;
    /** The text: the stored mes, the active alternate. */
    content: string;
    /** The pictures it shows from its chat's gallery, in order. */
    attachments: Attachment[];
    /** The stored row, verbatim, with extra.attachments naming its pictures' ids when it shows any. */
    raw: Message;
}

/** A picture or video a chat (or a studio session) holds of its own. */
export interface Attachment {
    id: number;
    chatId: string | null;
    studioId: string | null;
    /** The uid name it is stored under. */
    file: string;
    name: string;
    kind: 'image' | 'video';
    size: number;
    width: number | null;
    height: number | null;
    addedAt: number;
    /** /attachments/{ownerId}/{file} */
    url: string;
    /** How many messages show it (the gallery's list only). */
    uses?: number;
}

/** A lorebook entry as the surface showing it has it (in the manager, edits not saved yet included). */
export interface LoreEntryView {
    uid: number | null;
    comment: string;
    key: readonly string[];
    keysecondary: readonly string[];
    content: string;
    constant: boolean;
    disable: boolean;
    position: number | null;
    order: number | null;
}

/** A chat as the chats view lists it. */
export interface ChatCardView {
    id: string;
    name: string;
    /** Its character's id; null for a chat with none. */
    charId: string | null;
    charName: string;
    messageCount: number;
    /** When its newest message was sent; null when it holds none. */
    lastMesAt: number | null;
}

export interface ImportResult {
    success: boolean;
    /** The character's id; for a card already in the library, the one it matched. */
    id?: string;
    characterName?: string;
    alreadyPresent?: boolean;
    /** The card was written onto an existing character (onExisting: { replace: id }); id is that character. */
    replaced?: boolean;
    skippedReason?: 'identical' | 'diverged-uuid' | 'diverged-provenance' | null;
    /** How many of a charx's other images joined the gallery. */
    mediaCount?: number;
    /** What a card that came in arrived without, in the reader's words (eg. "its picture"); the shell says it once. */
    missing?: readonly string[];
    error?: string;
    /** What the Import Characters window's download phases read off a card that came in: a wrapper that builds its own answer carries them, or no download runs. */
    embeddedMediaUrls?: readonly string[];
    lorebookMediaUrls?: readonly string[];
    galleryPageUrls?: readonly string[];
    /** The provider the card came linked to, the character's id there and its page path. */
    linkedProvider?: string | null;
    providerCharId?: string | null;
    fullPath?: string | null;
    hasGallery?: boolean;
    /** The character as GET /characters?ids= answers it, for a card that came in: the shell takes it in from this, with no read. */
    row?: Readonly<Record<string, unknown>> | null;
}

/** Your inventory row: your manifest as the server read it (a server half's ctx.manifest). */
export interface InventoryRow {
    readonly id: string;
    readonly name: string;
    readonly version: string | null;
    readonly author: string | null;
    readonly description: string | null;
    readonly requires: Readonly<Record<string, unknown>> | null;
    readonly client: string | null;
    readonly style: string | null;
    readonly server: string | null;
    readonly provider: boolean;
    readonly extNamespace: string | null;
    readonly bundled: boolean;
    readonly git: boolean;
    readonly defaultOff: boolean;
    readonly settings: Readonly<Record<string, unknown>>;
    readonly contributes: readonly string[] | null;
    readonly lazy: LazyBlock | null;
    /** Set in place of the rest when the install is broken. */
    readonly error?: string;
}

/** Your inventory row as the page reads it (a client entry's ctx.manifest): whether it runs for this account, and its server half's state. */
export interface ManifestRow extends InventoryRow {
    readonly enabled: boolean;
    readonly serverState?: 'loaded' | 'failed' | 'restart' | 'removed';
    readonly serverError?: string;
    /** What your server half registered, as the inspector lists it. */
    readonly serverHooks?: ReadonlyArray<{ kind: string; id: string }>;
    /** The hosted-browser consumers its server half registered (ctx.browser.consumer), each <id>:<name>. */
    readonly browserConsumers?: ReadonlyArray<{ id: string; name: string; origin: string; fetchPrefix: string; warmPath: string }>;
    /** What its hooks cost this account, costliest first. */
    readonly serverCalls?: ReadonlyArray<{ name: string; count: number; errors: number; refused: number; lastError: string; totalMs: number; p50: number; p95: number }>;
    /** The query doors it declared: list projections, advanced-filter fields and sort keys. */
    readonly serverQuery?: {
        projections: readonly string[];
        ruleFields: ReadonlyArray<{ key: string; field: string; label: string; type: string; ops: readonly string[] }>;
        sortKeys: ReadonlyArray<{ key: string; sort: string; label: string }>;
    };
}

/** The entry points a lazy extension declares, registered before its code loads. */
export interface LazyBlock {
    readonly actions?: ReadonlyArray<{ slot: keyof ActionSlots; id: string; label: string; icon: string }>;
    readonly windows?: ReadonlyArray<{ id: string; label: string; icon: string; size?: { w: number; h: number }; min?: { w: number; h: number } }>;
    readonly views?: ReadonlyArray<{ id: string; label: string; icon: string }>;
}

/** The app's facade: its member names are kept (listed under the guide's "Deprecated doors" before one leaves); what each takes and answers is the app's own and is not typed here. */
export type CoreApi = Readonly<Record<string, any>>;

/** A ProviderBase instance; see "Provider extensions" in the guide. */
export interface ProviderLike {
    readonly id: string;
    readonly [key: string]: unknown;
}

/** The provider's row: searchPrefixes, extNamespace and the rest the guide lists. */
export type ProviderRow = Readonly<Record<string, unknown>>;

// ======== the server half ========
//
//     /** @type {import('./extensions').ServerExtension['register']} */
//     export function register(router, ctx) { /* ... */ }

/** Your server entry's exports. */
export interface ServerExtension {
    /** Runs once at server boot; your routes mount under /api/ext/<your id>/. */
    register(router: ExtensionRouter, ctx: ServerContext): void | Promise<void>;
    /** Your tables: each entry SQL or a function, run once per library in order, in a transaction of its own. Append only. */
    migrations?: ReadonlyArray<string | ((db: Database) => void)>;
}

/** What register is handed. */
export interface ServerContext {
    /** The extension api this server speaks, '<major>.<minor>' (your manifest's requires.api is checked against it). */
    readonly apiVersion: string;
    /** Your inventory row. */
    readonly manifest: InventoryRow;
    /** Route middleware: gates a route to admins. */
    readonly requireAdmin: RequestHandler;
    /** Route middleware for a route whose path names :chatId: 404 { error: 'no such chat' } unless that chat is in the account's library. */
    readonly requireChat: RequestHandler;
    /** Whether this server runs with accounts (false on a single-user install). */
    readonly multiUser: boolean;
    /** A user's setting (pass req.db); nothing stored, null or '' reads the fallback. */
    settingValue<T = any>(db: Database, key: string, fallback?: T): T;
    /** Your own per-user config: the scoped key, and your manifest's default for it. */
    setting<T = any>(db: Database, key: string): T;
    readonly chatSlot: ServerChatSlot;
    readonly messages: ServerMessages;
    readonly helpers: ServerHelpers;
    readonly browser: ServerBrowser;
    /** Routine logging behind that user's debug toggle, tagged with your id. */
    debugLog(req: ExtensionRequest, ...args: unknown[]): void;
    /** Your extension-global scratch directory, never served; made on first ask. */
    dataDir(): string;
    /** A directory of yours inside that user's own home; made on first ask. */
    userDataDir(req: ExtensionRequest): string;
    readonly files: ServerFiles;
    /** The app's own store modules, the functions its routes call; they follow the server's releases. */
    readonly stores: ServerStores;
    readonly imports: ServerImports;
    readonly hooks: ServerHooks;
    readonly macros: ServerMacros;
    readonly prompt: ServerPrompt;
    readonly assistant: ServerAssistant;
    readonly llm: ServerLlm;
    readonly jobs: ServerJobs;
    /** Refuses the write a store guard is looking at: it rolls back and its request answers 400 in these words. */
    refuse(message: string): never;
    readonly events: ServerEvents;
    /** Reports a write to your own tables as the change it is to the app's data; call it inside the write's transaction. */
    report(db: Database, record: ReportRecord): void;
    readonly query: ServerQuery;
}

export interface ServerHelpers {
    /** The proxy gate: answers 400 or 403 itself and null, else the vetted URL. */
    guardProxyTarget(req: ExtensionRequest, res: ExtensionResponse, opts: { base: string; allowedPaths: RegExp[]; hosts: string | Set<string>; label: string }): URL | null;
    /** A per-user in-memory slot for an upstream credential. */
    sessionSlot(name: string): SessionSlot;
    /** fetch that follows a redirect only while it stays on the same host; an off-host hop throws. */
    sameHostFetch(url: URL | string, init?: RequestInit, opts?: { maxRedirects?: number }): Promise<Response>;
    /** The path a wildcard route matched. */
    wildcardPath(req: ExtensionRequest): string;
}

export interface ServerBrowser {
    /** A hosted-browser consumer of your own: an https origin and the path prefix fetches stay under; answers its id, <your id>:<name>. */
    consumer(spec: { name: string; origin: string; fetchPrefix: string; warmPath?: string; ready?: ((page: unknown) => Promise<void>) | null }): string;
}

/** Your two folders as handles: synchronous, for small files; path(name) hands a large one or an engine's own file its path. */
export interface ServerFiles {
    /** Your folder inside the requesting account's home (the one userDataDir(req) answers). */
    user(req: ExtensionRequest): FileFolder;
    /** Your folder every account shares (the one dataDir() answers). */
    shared(): FileFolder;
}

/** A folder of yours. Every name is a path relative to it ('cache/index.json'); an absolute path, a drive, a name that leaves the folder or one not every disk can hold throws. */
export interface FileFolder {
    /** The file's text, or null when it is not there. */
    read(name: string): string | null;
    /** The file parsed as JSON, or the fallback (null when you pass none) when it is not there; a file that is not JSON throws, naming it. */
    readJson<T = any>(name: string, fallback?: T): T;
    /** Writes the file whole, its folders made first: a crash mid-write leaves the old file or the new one, never half of either. */
    write(name: string, data: string | Uint8Array): void;
    /** The value as pretty-printed JSON, written whole as write writes. */
    writeJson(name: string, value: unknown): void;
    /** Removes the file, or a folder and everything in it; nothing there is no error. */
    remove(name: string): void;
    /** The names in the folder, or in a folder inside it; [] when it is not there. */
    list(sub?: string): string[];
    /** The file's absolute path, its folders made, for something that opens a real file (a SQLite file of your own, a large file you stream). */
    path(name: string): string;
}

export interface SessionSlot {
    readonly name: string;
    get(req: ExtensionRequest): unknown;
    set(req: ExtensionRequest, value: unknown): void;
    clear(req: ExtensionRequest): void;
}

/** Each store module by name: its functions take the library (req.db) first. */
export interface ServerStores {
    readonly assistant: StoreModule;
    /** A chat's own gallery and a studio session's pictures, and the pictures each message shows. */
    readonly attachments: StoreModule;
    readonly backgrounds: StoreModule;
    readonly characters: StoreModule;
    readonly chats: StoreModule;
    readonly documents: StoreModule;
    readonly duplicates: StoreModule;
    readonly llmProfiles: StoreModule;
    readonly media: StoreModule;
    readonly mediaJobs: StoreModule;
    readonly personas: StoreModule;
    readonly playlists: StoreModule;
    readonly presets: StoreModule;
    /** Regex scripts: your own list, each preset's, and whether a preset's or a character's list may run. */
    readonly regex: StoreModule;
    readonly setJobs: StoreModule;
    readonly settings: StoreModule;
    readonly stats: StoreModule;
    readonly studio: StoreModule;
    readonly tagJobs: StoreModule;
    readonly tagRuns: StoreModule;
    readonly tags: StoreModule;
    readonly versions: StoreModule;
    readonly worldLinks: StoreModule;
    readonly worlds: StoreModule;
}

/** A store module's functions: not typed here, since they follow the server's own releases. */
export type StoreModule = Readonly<Record<string, (...args: any[]) => any>>;

export interface ServerImports {
    /** Stage a card file your half holds, as an upload to the stage route is: the client commits it. */
    stage(req: ExtensionRequest, body: Uint8Array | ReadableStream | NodeReadable, opts?: { name?: string }): Promise<StagedCard>;
}

export interface StagedCard {
    stageId: string;
    format: 'png' | 'charx';
    /** The card as the import would store it. */
    card: Card;
    /** Whether the file carries a picture. */
    picture: boolean;
    /** A charx's other embedded files, the gallery rows the commit adds. */
    media: Array<{ name: string; size: number }>;
}

/** A node stream (a Readable): anything with pipe. */
export interface NodeReadable {
    pipe(destination: any, options?: { end?: boolean }): any;
}

export interface ServerHooks {
    /** A pipeline filter: answers the value to hand on, or undefined to hand on its input. Synchronous. Answers the removal. */
    add<K extends keyof Pipelines>(name: K, fn: (value: Pipelines[K]['value'], context: Pipelines[K]['context']) => Pipelines[K]['value'] | undefined, opts?: { priority?: number }): () => void;
    /** A store guard: runs after a library write and before its commit, and may refuse it through ctx.refuse. Synchronous. */
    add(name: StoreGuardName, fn: (record: ChangeRecord, context: GuardContext) => void, opts?: { priority?: number }): () => void;
}

/** What every pipeline filter is handed beside its value: the account's library and its handle. Read it, never write through it. */
export interface PipelineFacts {
    readonly db: Database;
    readonly user: string;
}

export interface GuardContext {
    /** The account's library, holding the write that has not committed yet: read it, never write. */
    readonly db: Database;
    readonly user: string;
}

export interface ServerChatSlot {
    /** Your own slot in a chat's metadata (chat_metadata.extensions.<your id>); {} when there is none. */
    get<T extends object = Record<string, any>>(db: Database, chatId: string): T;
    /** Replaces your slot (null removes it), the chat's other keys and every other extension's slot left as they are; a chat that is not there throws (statusCode 404). */
    set(db: Database, chatId: string, value: object | null): void;
}

export interface ServerMessages {
    /** The text a stored message shows: its active alternate when it has several, else mes; the page's ctx.messages.shown answers alike. */
    shown(msg: Readonly<Message> | null | undefined): string;
    /** FNV-1a over a text, as eight hex digits, the same as the page's. */
    digest(text: string): string;
}

export interface ServerMacros {
    /** {{name}} in the prompt: a function (no arguments) or a definition, called each time a text names it. Answers the removal. */
    add(name: string, macro: MacroHandler | MacroDefinition): () => void;
}

export type MacroArgType = 'string' | 'integer' | 'number' | 'boolean';

export interface MacroArg {
    readonly name?: string;
    /** Default 'string'; a call whose argument does not read as its type stays as written (strict). */
    readonly type?: MacroArgType | readonly MacroArgType[];
    /** An optional argument comes after every required one. */
    readonly optional?: boolean;
}

export interface MacroDefinition {
    /** The arguments, in order. */
    readonly args?: readonly MacroArg[];
    /** Any number more after the arguments, handed as call.list; a macro with a list is never a block. */
    readonly list?: boolean | { readonly min?: number; readonly max?: number };
    /** Default true: a call with the wrong count or a mistyped argument stays as written, its handler not called. */
    readonly strict?: boolean;
    readonly handler: MacroHandler;
}

/** The build's facts and the call. */
export interface MacroCall extends MacroFacts {
    readonly name: string;
    /** Every argument, each resolved; a block's content is the last. */
    readonly args: readonly string[];
    /** The declared arguments. */
    readonly unnamedArgs: readonly string[];
    /** The arguments after the declared ones; null for a macro without a list. */
    readonly list: readonly string[] | null;
    /** Whether it was written as a block ({{name}}...{{/name}}). */
    readonly isScoped: boolean;
}

export type MacroHandler = (call: MacroCall) => string | number;

export interface MacroFacts {
    readonly db: Database;
    readonly user: string;
    readonly chatId: string | null;
    readonly charId: string | null;
    /** The seq of the newest message the build reads. */
    readonly lastSeq: number | null;
    readonly [key: string]: unknown;
}

export interface ServerPrompt {
    /** A block of your own text in every chat prompt. Answers the removal. */
    addBlock(spec: PromptBlockSpec): () => void;
    /** A chat's names, the messages its prompt is written from as stored, and its macros; null for a chat that does not exist. */
    read(db: Database, chatId: string): ChatForPrompt | null;
    /** The two names alone, for a caller that reads the messages itself; null for a chat that does not exist. */
    names(db: Database, chatId: string): ChatNames | null;
    /** Whether the prompt reads a stored message: not hidden, not a system note, not empty. */
    visible(msg: Message): boolean;
    /** The text between two fences longer than any run of the fence character inside it, so it cannot close its quotation: '~~~\n' + text + '\n~~~' at the least. char is the fence character, '~' (the app's own) by default or '`'; any other throws. */
    fence(text: string, opts?: { char?: '~' | '`' }): string;
}

export interface PromptBlockPlacement {
    /** pre_history by default. */
    position?: 'pre_history' | 'post_history' | 'at_depth';
    /** Turns back from the newest, for at_depth; 0 by default. */
    depth?: number;
    role?: 'system' | 'user' | 'assistant';
    /** Among blocks sharing a depth, the higher sits nearer the reply; 100 by default. */
    order?: number;
}

export interface PromptBlockSpec extends PromptBlockPlacement {
    /** [a-z][a-z0-9-]{0,31}, unique among your blocks. */
    id: string;
    /** Answers the block's text once per chat prompt, or the text with a placement of that build's own. */
    text(facts: BlockFacts): string | number | (PromptBlockPlacement & { text: string | number });
}

export interface ServerAssistant {
    /** A context source the chat assistant can be given, with its own switch in the assistant's context view. Answers the removal. */
    addSource(spec: AssistantSourceSpec): () => void;
}

export interface AssistantSourceSpec {
    /** [a-z][a-z0-9-]{0,31}, unique among your sources. */
    id: string;
    /** What its switch is called: one line, at most 60 characters. */
    label: string;
    /** Whether it is shared until the reader switches it; false by default. */
    defaultOn?: boolean;
    /** Answers the text to share, once per assistant build, only while its switch is on. */
    read(facts: AssistantSourceFacts): string | number;
}

export interface AssistantSourceFacts {
    readonly db: Database;
    readonly user: string;
    readonly chatId: string;
    readonly charId: string;
    readonly [key: string]: unknown;
}

export interface BlockFacts {
    readonly db: Database;
    readonly user: string;
    readonly chatId: string;
    readonly charId: string;
    /** True for the prompt inspector, false for a send. */
    readonly dryRun: boolean;
    /** The seq of the newest message of the history the reply is written from; null when it holds none. */
    readonly lastSeq: number | null;
    readonly [key: string]: unknown;
}

export interface ChatNames {
    /** The card's name. */
    charName: string;
    /** The chat's persona, else the account's, else the name the chat was stored with. */
    userName: string;
}

export interface ChatForPrompt extends ChatNames {
    /** The messages a reply is written from, oldest first, each with its id and place; each msg as stored, without the prompt or screen regex passes. */
    history: Array<{ id: number; seq: number; msg: Message }>;
    /** Expands the chat's macros in text of yours. */
    expand(text: string): string;
}

export interface ServerLlm {
    /** A call to one of the account's own models; answers the reply. */
    chat(db: Database, request: LlmCall, opts?: { signal?: AbortSignal }): Promise<LlmAnswer>;
    /** The same call, streamed. */
    stream(db: Database, request: LlmCall, opts?: { signal?: AbortSignal }): AsyncIterable<LlmStreamEvent>;
    /** Whether the connection a call naming these would use sends pictures; null when its model's sight is not checked, which sends none until it is. */
    canSee(db: Database, request?: { profileId?: string; profileSetting?: string; chatId?: string }): boolean | null;
    /** A kind of connection of your own. Answers the removal. */
    registerAdapter(adapter: LlmAdapter): () => void;
    /** What the app's own adapters are built from. */
    readonly kit: ServerLlmKit;
}

export interface ServerLlmKit {
    readonly LlmError: LlmErrorConstructor;
    /** An upstream answer that is not ok, as an LlmError of the matching kind. */
    classifyUpstream(resp: { status: number; headers?: unknown }, bodyText: string): LlmError;
    /** An error answer's text, read within bounds. */
    boundedErrorText(resp: Response): Promise<string>;
    /** A fetch that failed, as a retryable network LlmError. */
    networkError(error: unknown): LlmError;
    /** An answer's body as JSON, or null when it is not JSON; a body past 8 MB is an upstream LlmError, a read the signal stopped throws an AbortError, any other failure a network LlmError. */
    readJsonBody(resp: Response, signal?: AbortSignal): Promise<unknown>;
    /** A stream's server-sent frames. */
    parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event: string | null; data: string }>;
    /** Writes the params your table names onto your request body; answers the body. */
    translateParams(params: LlmParams, table: LlmParamTable, body: Record<string, unknown>): Record<string, unknown>;
}

export interface LlmError extends Error {
    readonly kind: LlmErrorKind;
    readonly status: number | null;
    readonly retryAfterMs: number | null;
    readonly retryable: boolean;
}

export interface LlmErrorConstructor {
    new (kind: LlmErrorKind, message: string, opts?: { status?: number | null; retryAfterMs?: number | null; retryable?: boolean }): LlmError;
}

/** A call through ctx.llm: without profileId or profileSetting, the connection chatId's chat uses (its own, else the default), else the default, else the account's first. */
export interface LlmCall {
    messages: PromptMessage[];
    /** A connection by its id; one the account does not have is refused (bad_request). */
    profileId?: string;
    /** The name of one of your settings holding a connection's id (the key ctx.ui.connectionSelect keeps): that connection while the account has it, else the fallback above. Not with profileId. */
    profileSetting?: string;
    /** The chat the call is made for: with no connection named or kept, the one that chat uses answers. */
    chatId?: string;
    model?: string;
    params?: LlmParams;
}

/** What a call answers. */
export interface LlmAnswer extends LlmReply {
    /** The connection that answered. */
    profileId: string;
}

export interface LlmReply {
    content: string;
    reasoning?: string;
    finishReason?: string | null;
    usage?: LlmUsage | null;
}

export interface LlmUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    [key: string]: unknown;
}

/** A stream's event: text as it arrives, or the reasoning, or the end (done, last). */
export interface LlmStreamEvent {
    text?: string;
    reasoning?: string;
    done?: { finishReason?: string | null; usage?: LlmUsage | null };
}

/** The app's neutral params. */
export interface LlmParams {
    temperature?: number;
    topP?: number;
    topK?: number;
    maxTokens?: number;
    stop?: string[];
    presencePenalty?: number;
    frequencyPenalty?: number;
    seed?: number;
    reasoning?: { effort: 'low' | 'medium' | 'high' };
    json?: boolean;
}

/** Each neutral param to your wire name, or to a function writing it onto the body. */
export type LlmParamTable = Record<string, string | ((value: unknown, body: Record<string, unknown>) => void)>;

/** A request as an adapter is handed it and llm.request filters it. */
export interface LlmRequest {
    messages: PromptMessage[];
    /** Set only when the call chose a model over its connection's. */
    model?: string;
    params: LlmParams;
}

/** A connection, as an adapter is handed it. */
export interface LlmProfile {
    readonly kind: string;
    readonly base_url: string | null;
    readonly api_key: string | null;
    readonly model: string | null;
    readonly [key: string]: unknown;
}

/** A kind of connection: the app's neutral request in, the service's answer back in the app's shapes. */
export interface LlmAdapter {
    /** Lowercase, 2 to 32 characters. */
    kind: string;
    displayName: string;
    defaultBaseUrl?: string;
    /** True when every connection must name its own endpoint. */
    requiresBaseUrl?: boolean;
    /** A kind that cannot stream is refused for chat generation; one without vision is refused a message's images. */
    capabilities?: { streaming?: boolean; json?: boolean; reasoning?: boolean; vision?: boolean; [key: string]: unknown };
    paramTable?: LlmParamTable;
    chat(profile: LlmProfile, req: LlmRequest, signal: AbortSignal): Promise<LlmReply>;
    chatStream(profile: LlmProfile, req: LlmRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent>;
    /** vision only where your service's own list says whether the model sees pictures. */
    listModels(profile: LlmProfile, signal: AbortSignal): Promise<Array<{ id: string; contextLength?: number | null; vision?: boolean }>>;
}

export interface ServerJobs {
    /** Queue work for the account whose library db is; answers its id at once. */
    run(db: Database, job: JobSpec): { id: number };
    /** Queue a job for every account that has you on, every `every` ms. Answers the removal. */
    schedule(schedule: ScheduleSpec): () => void;
    /** Your own jobs for that account, as they stand. */
    list(db: Database): ExtensionJob[];
}

export interface JobSpec {
    /** A key already queued and not yet started takes this label and run in its place. */
    key?: string;
    /** Names the job in the notifications center. */
    label: string;
    run(job: JobContext): void | Promise<void>;
}

export interface ScheduleSpec {
    /** [a-z][a-z0-9-]{0,31}, unique among your schedules. */
    id: string;
    /** In milliseconds: at least one minute, at most 2147483647 (about 24 days, the timer's limit). */
    every: number;
    /** The id when none is given. */
    label?: string;
    run(job: JobContext): void | Promise<void>;
}

export interface JobContext {
    readonly db: Database;
    readonly user: string;
    /** Aborts when the account cancels the job or switches you off, when your extension is removed or its server half fails, or when an admin disables or deletes the account. */
    readonly signal: AbortSignal;
    progress(progress: { done?: number; total?: number; note?: string }): void;
}

export interface ExtensionJob {
    readonly id: number;
    readonly extension: string;
    readonly extensionName: string;
    readonly key: string | null;
    readonly label: string;
    readonly status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
    readonly progress: { done: number | null; total: number | null; note: string | null } | null;
    readonly queuedAt: number;
    readonly startedAt: number | null;
    readonly endedAt: number | null;
    readonly error: string | null;
    /** Its place in its lane, 1 next: carried by a queued job only. */
    readonly position?: number;
}

export interface ServerEvents {
    /** Every committed batch of changes to the library of an account that has you on, once the write returned. Answers the removal. */
    on(fn: (records: readonly ChangeRecord[], context: GuardContext) => void | Promise<void>): () => void;
}

export interface ServerQuery {
    /** A value every character list row carries as ext.<your id>.<key>. */
    projection(spec: QueryDoorSpec): void;
    /** An advanced-filter field named ext.<your id>.<key>. */
    ruleField(spec: QueryDoorSpec & { label?: string; type: 'number' | 'text' | 'boolean' | 'date' }): void;
    /** A list sort named ext.<your id>.<key>. */
    sortKey(spec: QueryDoorSpec & { label?: string }): void;
}

export interface QueryDoorSpec {
    /** Letters, digits and underscores. */
    key: string;
    /** One of your own tables. */
    table: string;
    column: string;
    /** The column holding the character's id: char_id by default. */
    charColumn?: string;
}

/** A change to an account's library, as the change feed carries it. */
export interface ChangeRecord<E extends ChangeEntity = ChangeEntity> {
    readonly entity: E;
    readonly op: ChangeVocabulary[E];
    /** On a message record, the messages' seqs (their places). */
    readonly ids?: ReadonlyArray<string | number>;
    /** On a message record, the messages' own ids, one beside each seq in ids. */
    readonly messageIds?: readonly number[];
    readonly all?: true;
    readonly fields?: readonly string[];
    readonly chatId?: string;
    readonly charId?: string;
    /** On a chat's created record: the chat it was branched from and the message it ends on (its seq and its id). */
    readonly branchOf?: { readonly chatId: string; readonly seq: number; readonly messageId: number };
    /** On a tag or lorebook rename, and a tag merge's deleted record: the name it has now (the old one is in ids, or in world on a binding sweep). */
    readonly to?: string;
    /** The extension that reported it. */
    readonly extension?: string;
    /** The tab that made it, or null. */
    readonly origin?: string | null;
    readonly [key: string]: unknown;
}

/** A write to your own tables, reported as a library entity's change; fields are yours (<your id>.<name>). */
export interface ReportRecord {
    entity: LibraryWriteEntity;
    op: string;
    ids?: Array<string | number>;
    /** On a message report: the messages' own ids, one beside each seq in ids. */
    messageIds?: number[];
    all?: true;
    fields?: string[];
    chatId?: string;
    charId?: string;
    world?: string;
    scope?: string;
}

/** A chat message as the prompt sends it. */
export interface PromptMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
    /** A speaker name sent with the message. The app sets none (an example turn keeps its speaker in its text); one you set is sent as it is. */
    name?: string;
    /** Pictures the model reads with a user's message. */
    images?: PromptImage[];
}

/**
 * A picture on a message. A caller sends { data } (base64 or a data URL) or { ref } (a portrait or a gallery
 * image of the account); an adapter is handed { mediaType, data, width, height }, already shrunk to a long
 * edge of at most 1568 px.
 */
export interface PromptImage {
    data?: string;
    ref?: { kind: 'avatar' | 'media'; id: string | number };
    mediaType?: 'image/jpeg' | 'image/png';
    width?: number;
    height?: number;
}

/** A book of your own for the lore scan, named ext:<your id>:<label>. */
export interface ExtensionBook {
    name: string;
    data: { entries: Record<string, LoreEntry> };
}

/** A lorebook entry in the book format. */
export interface LoreEntry {
    uid: number | string;
    content: string;
    key?: string[];
    keysecondary?: string[];
    comment?: string;
    constant?: boolean;
    disable?: boolean;
    [key: string]: unknown;
}

/** What the lore engine placed, in its five groups, the entries at the author's note, and the outlet entries. */
export interface PlacedLore {
    before: PlacedEntry[];
    after: PlacedEntry[];
    atDepth: Array<PlacedEntry & { depth: number; role: string }>;
    emBefore: PlacedEntry[];
    emAfter: PlacedEntry[];
    /** above the author's note, sent with it only when it is sent; optional in an answer */
    anTop?: PlacedEntry[];
    /** below the author's note, likewise; optional in an answer */
    anBottom?: PlacedEntry[];
    /** placed where {{outlet::name}} is written for their `outlet`, highest order first; optional in an answer */
    outlets?: Array<PlacedEntry & { outlet: string }>;
}

export interface PlacedEntry {
    world: string;
    content: string;
    [key: string]: unknown;
}

/** An account's library: a better-sqlite3 database. */
export interface Database {
    prepare(sql: string): Statement;
    transaction<F extends (...args: any[]) => any>(fn: F): F;
    exec(sql: string): Database;
    readonly inTransaction: boolean;
    [key: string]: any;
}

export interface Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): any;
    all(...params: unknown[]): any[];
    [key: string]: any;
}

/** The request a route of yours is handed, scoped to the requesting account. */
export interface ExtensionRequest {
    /** That account's library. */
    readonly db: Database;
    readonly userHandle: string;
    readonly user: { readonly handle: string; readonly displayName: string; readonly admin: boolean; readonly mustChangePassword: boolean };
    /** The account's folders: root and the rest. */
    readonly paths: Readonly<Record<string, string>>;
    readonly params: Record<string, string>;
    readonly query: Record<string, unknown>;
    readonly body: any;
    [key: string]: any;
}

export interface ExtensionResponse {
    status(code: number): ExtensionResponse;
    json(body: unknown): void;
    send(body?: unknown): void;
    [key: string]: any;
}

export type RequestHandler = (req: ExtensionRequest, res: ExtensionResponse, next: (error?: unknown) => void) => unknown;

/** An express Router, mounted under /api/ext/<your id>/. */
export interface ExtensionRouter {
    get(path: string, ...handlers: RequestHandler[]): ExtensionRouter;
    post(path: string, ...handlers: RequestHandler[]): ExtensionRouter;
    put(path: string, ...handlers: RequestHandler[]): ExtensionRouter;
    patch(path: string, ...handlers: RequestHandler[]): ExtensionRouter;
    delete(path: string, ...handlers: RequestHandler[]): ExtensionRouter;
    use(...handlers: Array<string | RequestHandler>): ExtensionRouter;
    [key: string]: any;
}
