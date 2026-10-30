// AI CSS Assistant: chat interface for generating snippets via LLM.

import CoreAPI from './core-api.js';
import { createSnippet, updateSnippet, loadSnippets, renderSidebar as renderCustomCssSidebar, setSnippetsDirty, loadSnippetIntoEditor, getActiveSnippetId } from './custom-css.js';

// ========================================
// CSS CATALOGUE
// ========================================
// Hand-written, kept in sync with library.css. Add new @canonical components or themable tokens here.

const CATALOGUE_TOKENS = `
COLOR TOKENS (override on :root to retheme the whole app):
  --bg-primary           Main page background (#121212).
  --cl-app-glow-a / --cl-app-glow-b   The page's atmosphere, part 1: two accent-coloured corner glows, one radial-gradient each, following --accent-rgb / --accent-secondary-rgb (the Theme surface's Ambient glow knob sets both; 0 is a flat page).
  --cl-app-grain         Part 2: the opacity of the fine film-grain layer behind everything (0.045; 0 removes it).
  --cl-app-vignette      Part 3: the darkening toward the page edges (rgba(0, 0, 0, 0.35)).
  --bg-secondary         Card-level surfaces: sidebars, settings panels, code blocks (#1e1e1e).
  --text-primary         Default text color (#e0e0e0).
  --text-secondary       Subdued text: hints, metadata (#a0a0a0).
  --text-faint           De-emphasised markers between secondary and muted (#888).
  --text-muted           Faintest text: timestamps, placeholders (#707070).
  --accent               Primary brand color: links, buttons, focus rings (#4a9eff).
  --accent-rgb           Comma-separated RGB of --accent, for use in rgba() alpha tints (74, 158, 255).
  --accent-hover         Accent on hover (#6ab0ff).
  --accent-glow          Computed from --accent-rgb at 30% alpha. Overriding --accent-rgb updates this automatically.
  --accent-secondary     Secondary brand color, for gradients (#5550f0).
  --accent-secondary-rgb Comma-separated RGB of --accent-secondary (85, 80, 240).
  --accent-text          Text color shown on top of an accent background (#ffffff).
  --glass-border        Border for glass surfaces. An alias for --cl-veil-2, so retargeting the veil ladder moves every glass hairline with it.
  --card-bg              Background for character grid cards (rgba(40, 40, 40, 0.4)).
  --cl-favorite-gold     Gold accent for favorite indicators and the favorite-button hover treatment (#ffd700). Has a matching --cl-favorite-gold-rgb (255, 215, 0) for rgba() tints.
  --cl-in-library        Cyan "in your library" badge on Online browse cards (#00bcd4, companion --cl-in-library-rgb 0, 188, 212). Semantic category color, deliberately outside the status tiers so an accent retheme keeps its meaning.
  --cl-possible-match    Amber "possible match in library" badge on Online browse cards (#f0a500, companion --cl-possible-match-rgb 240, 165, 0). The icon alpha grades by confidence tier over this token (.possible-library.pl-high 1.0 / base .pl-med 0.72 / .pl-low 0.5). NOTE the dark badge background is var(--cl-shade-70), shared by all .browse-feature-badge, and does NOT follow this token; only the glyph color does.

--cl-* MODULE-DIALOG TOKEN FAMILY (surface + text only; the accent is the core --accent chain, and there is no --cl-accent token):
  --cl-border            General-purpose border token for module dialogs. Used for internal dividers, panel outlines, dashed borders across batch-tagging, character-versions, context-menu, playlists. NOT used by .cl-btn: the base button is borderless, and the DEFAULT glass button style draws its 1px border from var(--cl-elev-border) (the raised-surface edge, neither this token nor the accent) over a HARDCODED faint white gradient fill (rgba(255, 255, 255, 0.07) to 0.03); target :root[data-btn-style="glass"] .cl-btn to restyle either.
  --cl-text-primary      An alias of --text-primary (#e0e0e0); --cl-text-secondary aliases --text-secondary the same way.
  --font-stack-ui / --font-stack-prose   The interface face (body reads it; 'Noto Sans' then the system sans stack) and the transcript face (.chat-conv reads it; defaults to the UI stack). The Theme surface offers both as selects; set either here for a face the list lacks.
  --cl-text-secondary    Default value resolves to #a0a0a0. Same situation.
  Global accent retheme: override --accent / --accent-rgb only. Module dialogs (.cl-btn, card-updates, playlists, character-versions, context-menu, batch-tagging) read the core --accent / --accent-rgb / --accent-hover directly, so they follow automatically. --accent-rgb also drives --accent-glow. There is no separate --cl-accent chain to override.
  CAVEAT: --text-primary and --cl-text-primary are INDEPENDENT vars. Overriding --text-primary does NOT change text inside module dialogs. To re-color module-dialog text, override --cl-text-primary directly.

MODAL BACKGROUND VARS:
  --cl-sheet-bg          The sheet material: every .cl-modal-content dialog shell on DESKTOP, .modal-glass (character detail, creator, the online previews, the full-screen readers) and the sign-in wall read it, with backdrop blur (--cl-blur-panel), saturation (--cl-sheet-saturate), a hairline (--cl-elev-hairline) and a top highlight (--cl-sheet-highlight). Default rgba(34, 34, 38, 0.72).
  --cl-glass-bg          Near-opaque (alpha 0.95) inner surfaces inside dialogs (batch-tagging header/footer, playlist manage panels, custom-css editor panels, context-menu, the sign-in card, etc). Not the dialog shell: that is --cl-sheet-bg.
  --cl-topbar-bg         Used ONLY by the .topbar chrome strip. Default is rgba(20, 20, 20, 0.8) (darker + more see-through than --cl-glass-bg so it sits under content without competing). Override separately if you want the topbar tinted independently of modal chrome.
  --bg-secondary         The .confirm-modal-content shell on DESKTOP, and the default of --cl-sheet-bg-mobile, which .cl-modal-content and .confirm-modal-content read on MOBILE (full-viewport bottom-sheets need a solid bg or scrim-bleed reads as funhouse).
  For a complete dark-mode reskin, override all three together. They look similar by default but read from independent vars.
  --modal-scale (1)      The Modal Size setting's multiplier: every dialog's default width and height read calc(N * var(--modal-scale, 1)). The setting writes it inline on body, so a :root rule never reaches the dialogs; resize them through Settings > General > Modal Size, or one dialog through its own .cl-modal-content max-width.

RESTORE SIMPLE / FLAT CHROME (anti-funhouse, "make modals opaque" / "kill the blur" / "flat modals" / "old chrome" / "performance" requests):
  The desktop .cl-modal-content default is the sheet material: translucent var(--cl-sheet-bg), a var(--cl-blur-panel) backdrop blur with var(--cl-sheet-saturate) saturation, a var(--cl-elev-hairline) hairline, the var(--cl-elev-shadow) drop with an inset top highlight (var(--cl-sheet-highlight)), and the var(--cl-sheet-head) wash on the header; the title is weight 600. To revert to flatter chrome (solid bg, no GPU blur, flat header), apply this whole block globally:

    .cl-modal-content {
        background: var(--bg-secondary);
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        border: 1px solid var(--glass-border);
        box-shadow: var(--cl-shadow-lg);
    }
    .cl-modal-header {
        background: transparent;
    }

  Or scoped to one or more modal IDs (mirror the same blocks under #specificModalId .cl-modal-content / .cl-modal-header). Don't bias toward a preset of "heavy" modals - apply globally OR to exactly the IDs the user names.

  What each rule undoes:
    background + backdrop-filter:  kills the translucent sheet + the GPU blur (this is also the perf win - drops the compositor layer cost on desktop)
    border:                         swaps the --cl-elev-hairline hairline for the canonical --glass-border token
    box-shadow:                     swaps the elevation drop and its inset top highlight for the canonical modal-size single drop (--cl-shadow-lg)
    .cl-modal-header background:    kills the header wash (--cl-sheet-head)

  Do NOT also touch: .cl-modal-content overflow: hidden (clips header to corners), border-radius (visual continuity with the rest of the system), .cl-modal-header padding (back-arrow zone reservation on mobile).

  Modal IDs the user is most likely to ask about by feature name:
    "Custom CSS" / "CSS editor"           -> #customCssModal
    "Recommender" / "AI recommender"      -> #recommenderModal
    "Ask about character" / "card chat" / "recommender chat" -> #recommenderCharChatModal (settings panel .recommender-chat-settings; message cards .recommender-chat-msg.user / .assistant; user cards + gear-active follow the accent, neutral surfaces are theme-neutral by design)
    "CSS assistant" / "AI CSS assistant"  -> #cssAssistantModal
    "Add to playlist" / "playlist picker" -> #playlistPickerModal
    "Manage playlists"                    -> #playlistManageModal
    "Batch tagging" / "tag editor"        -> #batchTagModal
    "Card updates" / "update checker"     -> #cardUpdateSingleModal, #cardUpdateBatchModal
    "Settings"                            -> #gallerySettingsModal

  When user wants only the blur amount tuned (not full revert): set --cl-blur-panel (20px default; 12px subtle, 40px heavy frost), which every floating panel reads, or scope it to the dialogs with .cl-modal-content { backdrop-filter: blur(<n>px) saturate(var(--cl-sheet-saturate)); -webkit-backdrop-filter: blur(<n>px) saturate(var(--cl-sheet-saturate)); }. When user wants only the blur off (keep the translucent sheet + the header wash): drop just backdrop-filter / -webkit-backdrop-filter, leave the rest.

GRADIENT-CLIPPED TITLE ICON (default):
  The leading icon in a modal header (.cl-modal-header h3 > i:first-child) is accent-gradient clipped by DEFAULT (accent -> accent-secondary). The .cl-modal-header-icon class gives the same effect to an icon that is not the leading child.

  When the user asks to RECOLOR the title icon ("different gradient", "make it match X"): override the gradient stops. The icon is shipped markup, so scope via the modal ID (Custom CSS can't edit markup). Example:
        #recommenderModal .cl-modal-header h3 > i:first-child {
            background: linear-gradient(135deg, <color-a>, <color-b>);
            -webkit-background-clip: text;
            background-clip: text;
            -webkit-text-fill-color: transparent;
        }

  When the user wants the title icon FLAT (no gradient): reset the fill.
        #recommenderModal .cl-modal-header h3 > i:first-child {
            background: none;
            -webkit-text-fill-color: currentColor;
        }

  When NOT to use:
    - User asks for app-wide accent changes (override --accent / --accent-secondary tokens instead; the gradient follows them automatically).
    - User asks for chrome / shadow / shape changes (those are the default cl-modal look; no opt-in needed).

SHADE LADDER (black at the alphas the surfaces use, named by percent):
  --cl-shade-10 / -15 / -20 / -25 / -30 / -40 / -50 / -60 / -70 / -80   rgba(0, 0, 0, 0.NN). Every dark wash in the app reads a rung: plates behind chat text (--cl-chat-plate-bg is the 20 rung), pressed fills, image-corner gradients, the three scrim tiers below (60 / 70 / 80). Override a rung to lighten or tint every surface at that strength at once; tinting is supported (a rung is a full rgba, e.g. rgba(20, 0, 40, 0.6)).

MODAL SCRIM (the dimming overlay BEHIND a modal; separate from the modal's own background):
  --cl-modal-scrim-light  Full rgba; default rgba(0, 0, 0, 0.6). Nested overlays that open on top of an already-open surface: the showConfirm dialog overlay (.cl-confirm-overlay), the mobile tag-editor backdrop.
  --cl-modal-scrim        Full rgba; default rgba(0, 0, 0, 0.7). Standard module dialogs (.cl-modal: settings, batch tagging, playlists, card updates, theme customizer).
  --cl-modal-scrim-heavy  Full rgba; default rgba(0, 0, 0, 0.8). Full-screen primary modals (.modal-overlay: character detail, character creator) and destructive confirms (.confirm-modal).
  These are FULL rgba values, not alpha-only knobs. Tinting the scrim is supported (e.g. rgba(20, 0, 40, 0.7) for a purple-tinted dimming on a synthwave theme). Three tiers map to gesture, not aesthetic preference: pick by what the modal is asking the user to do.
  NOT on the token system: the gallery viewer (.gv-modal) HARDCODES its scrim at rgba(0, 0, 0, 0.95) and the full-screen image/avatar viewer (.browse-avatar-viewer) at rgba(0, 0, 0, 0.88); overriding the scrim tokens does nothing there, retinting those two needs their class targeted directly.

STATUS COLORS (semantic, four tiers; override on :root to retheme toasts/badges/banners):
  Muted Material tier: --cl-success (#4caf50), --cl-error (#f44336), --cl-warning (#ff9800), --cl-info (#29b6f6).
  Punchy Flat UI tier: --cl-success-bright (#2ecc71), --cl-error-bright (#e74c3c), --cl-warning-bright (#f39c12), --cl-info-bright (#3498db).
  Pale Material 300 tier: --cl-success-pale (#81c784), --cl-error-pale (#e57373), --cl-warning-pale (#ffd54f), --cl-info-pale (#64b5f6). Designed for legible text on translucent status backgrounds (tag pill labels, callout body text).
  Vivid Tailwind 400 tier: --cl-success-vivid (#4ade80), --cl-error-vivid (#f87171), --cl-warning-vivid (#f59e0b). Saturated state colour on dark chrome: the tag filter's include / exclude states, lock and warning badges, danger text inside panels, the sign-in wall's error line. No -info rung; info stays on --accent.
  Each muted and bright token has an *-rgb companion for rgba() tints: --cl-success-rgb, --cl-error-rgb, --cl-warning-rgb, --cl-info-rgb, --cl-success-bright-rgb, --cl-error-bright-rgb, --cl-warning-bright-rgb, --cl-info-bright-rgb. Retheme a colour and its companion together, or the tints keep the stock hue. In practice: muted tier powers toast chrome/icons and most status pills/badges; bright tier powers hero banners, big action buttons (danger/cancel gradients), and prominent status indicators; pale tier powers text on top of translucent status backgrounds.
  Gradient second stops: the danger/cancel and warning button gradients run from the -bright token to a darker companion, --cl-error-bright-darker (#c0392b) and --cl-warning-bright-darker (#e67e22), with --cl-error-bright-darker-rgb and --cl-warning-bright-darker-rgb. Retheming --cl-error-bright or --cl-warning-bright WITHOUT also overriding its -darker companion leaves the gradient's far stop on the stock color (half-rethemed buttons).
  --cl-danger-text (#ff6b7a): danger ACTION text on dark/translucent chrome, .cl-btn-danger text (both button styles), context-menu Delete rows (desktop + mobile sheet), playlist delete hover. Deliberately OUTSIDE the error tiers: retheming --cl-error-* does not move it, override --cl-danger-text directly.
  KNOWN COUPLING GAPS:
    1. .toast.info uses --accent (not --cl-info). Re-color info toasts by overriding --accent or by targeting .toast.info directly.
  PARTLY DECOUPLED (the tag pills):
    .cl-tag-success / -warning / -info / -danger are tag UI affordances (visually category-coloured pills like "NSFW", "Beta", "Featured"), not status surfaces. Their text reads the *-pale tokens. Their chrome is split: .cl-tag-success and .cl-tag-danger tint from --cl-success-rgb / --cl-error-rgb, so a status retheme moves them, while .cl-tag-warning and .cl-tag-info keep HARDCODED triples (rgba(255, 193, 7, *) and rgba(33, 150, 243, *)), so retinting --cl-warning (e.g. cyan warning toasts) does NOT recolor "Warning"-named pills. To re-theme cl-tag-* pill chrome, target the classes directly.

SHADOW SCALE (every plain black drop shadow in the app reads a step; only upward, layered and accent-tinted shadows stay literal):
  --cl-shadow-paper (0 1px 2px), --cl-shadow-sm (0 2px 8px), --cl-shadow-md (0 4px 16px), --cl-shadow-lg (0 8px 32px), --cl-shadow-xl (0 12px 48px). Paper shallowest, xl deepest. Override a step to redepth every surface on it.
  --cl-shadow-ambient (0 1px 15px at 0.5)   The soft halo under the conversation's floating controls: the jump-to-latest button, a message's overflow menu, the options menu, the lore picker.
  --cl-focus-glow        The keyboard focus ring, a 3px ring of the accent at 35%: chat cards under keyboard focus, the composer's send glyph while you type, the pulse on a message or lore entry you jumped to. Mixed from --accent at :root (see the SCOPED-RETHEME TRAP).

SPACING SCALE (px values):
  --space-2xs (2px), --space-xs (4px), --space-xs-sm (6px), --space-sm (8px),
  --space-sm-md (10px), --space-md (12px), --space-md-lg (14px), --space-lg (16px), --space-xl (20px), --space-2xl (24px).
  Use for padding/gap/margin instead of raw px.

BORDER RADIUS SCALE:
  --radius-2xs (2px), --radius-xs (3px), --radius-sm (4px), --radius-sm-alt (5px),
  --radius-md (6px), --radius-lg (8px), --radius-xl (10px), --radius-2xl (12px),
  --radius-2xl-alt (14px), --radius-3xl (16px), --radius-4xl (20px),
  --radius-circle (50%), --radius-pill (999px).
  Picks: --radius-sm for chips/tags, --radius-md for buttons/inputs, --radius-lg for panels/cards, --radius-2xl for major surfaces, --radius-pill for fully round.

TYPOGRAPHY SCALE (rem values; full set):
  --font-4xs (0.55rem), --font-3xs (0.65rem), --font-2xs (0.7rem), --font-xs (0.75rem),
  --font-sm (0.8rem), --font-md (0.85rem), --font-md-lg (0.9rem), --font-pre-base (0.95rem),
  --font-base (1rem), --font-lg (1.15rem), --font-xl (1.3rem), --font-2xl (1.5rem), --font-3xl (2rem), --font-4xl (3rem).
  Picks: --font-xs for tags/captions, --font-sm for hints/metadata, --font-md for body, --font-base for inputs/emphasis, --font-lg for headings, --font-4xl for empty-state ghost icons.

BUTTON SIZING:
  --btn-pad-v-lg/md/sm, --btn-pad-h-lg/md/sm, --btn-font-lg/md/sm.
  The dialog button (.cl-btn) sits on the lg tier. (Note: --btn-font-md and --btn-font-sm currently share the same 0.85rem value.)

TOUCH + MOBILE CHROME:
  --touch-target-min (44px)   WCAG/iOS/Android floor. Use for min-height/min-width on any interactive element on mobile: list rows, nav items, inputs, primary buttons.
  --touch-target-slim (34px)  The dense tier: icon buttons, chips, pagination, window controls. Every phone control reads one of the two; there is no third tier.
  --mobile-input-size         Every phone field's font size (var(--font-md)). Under html.cl-ios it is 16px, since iOS zooms the page into a focused field set smaller; keep it at 16px or more there.
  --avatar-xs / -sm / -md / -lg / -xl (32 / 36 / 40 / 48 / 60px)   Portrait squares in lists, rows and pickers (width and height together). Not touch targets; retarget a rung to resize every portrait of that size.
  --chrome-h-mobile (56px)    Mobile modal header height + bottom nav height. Apply as min-height on cl-modal-header / confirm-modal-header / mobile-bottom-nav-tab on mobile.
  --back-arrow-zone (56px)    Header padding-left reserved for the absolutely-positioned mobile back-arrow.
  --safe-bottom               env(safe-area-inset-bottom, 0px) alias. Use in padding-bottom + calc() expressions on bottom-stuck mobile elements (sticky footers, bottom sheets, FABs).
  --safe-top                  env(safe-area-inset-top, 0px) alias. The notch inset; the phone's topbar and the full-screen sheets pad by it.
  --ease-drawer               cubic-bezier(0.32, 0.72, 0, 1). The canonical bottom-sheet/drawer slide easing, shared by every mobile sheet/drawer (settings/menu/selector/context, cl-modal-drawer pickers, filter popups). Use as the timing-function in transition/animation on any bottom drawer so its motion matches; pair with an explicit duration (0.28s opens, 0.22s quick-dismiss). Retarget it to restyle all drawer motion at once.

DURATION LADDER (every transition and entrance animation reads from these; only looping animations keep a literal period):
  --dur-quick (0.1s)     Near-instant: a caret, a checkmark, a cursor swap.
  --dur-fast (0.15s)     Hover/press feedback: things that must feel instant.
  --dur-base (0.2s)      The default. Most state changes.
  --dur-slow (0.35s)     Panel and drawer moves, anything crossing a large distance.
  --dur-chat (0.5s)      Reading-surface constant, deliberately slower than everything else. Half a second reads as calm while reading and as lag while browsing a grid, so it is scoped to the chat view only.
  --dur-reveal (0.8s), --dur-expand (1s)   Staged reveals and height expansions.
  A prefers-reduced-motion block collapses this whole ladder to 0.01ms, so anything reading a --dur-* token honors reduced motion for free. A hardcoded duration does not. Overriding a rung retimes every surface that reads it at once.

UTILITY CLASSES (templates and markup carry no inline style; a one-property adjustment is one of these):
  .text-primary / -secondary / -faint / -muted / -accent / -success / -success-bright / -success-pale / -error-bright / -warning-pale / -warning-dark / -gold   Text colour on the token it names.
  .u-relative, .u-flex-1, .u-span-all, .u-ml-auto, .u-m-0, .u-mr-2xs, .u-mt-xs / -sm / -sm-md / -md, .u-mb-xs / -sm / -md, .u-gap-sm, .u-wrap, .u-row (flex, centred, --space-sm gap), .u-row-tight (--space-xs-sm gap), .u-center, .u-nowrap, .u-break-all, .u-bold, .u-pointer, .u-mono, .u-text-sm / -2xs / -3xs, .u-dim-30 / -50 / -70, .u-icon-lead (a leading glyph: small right margin, 0.7 opacity).
  A surface with three or more declarations is a named class in its feature's sheet, not a stack of utilities.

Z-INDEX SCALE (one scale by role; a value under 13 orders siblings inside a component and stays literal):
  --z-raised 10, --z-dropdown 30, --z-sticky 50, --z-chrome 100 (the topbar), --z-overlay 200 (the phone's modal overlay), --z-overlay-sheet 250, --z-nav 999 (the phone's bottom nav), --z-float 1000 (FAB and autocompletes), --z-popup 1100, --z-sheet 1200 (bottom sheets), --z-sheet-top 1300, --z-menu 2100, --z-modal 10000 (every dialog), --z-modal-above 10002, --z-confirm 10003 (the confirm tier), --z-modal-top 10004, --z-toast 10010, --z-viewer 10100 (the full-screen image viewer).
  A custom surface picks the rung for its role instead of a number; a scrim sits one below its popup with calc(var(--z-popup) - 1).

EASINGS:
  --ease-standard   cubic-bezier(0.4, 0, 0.2, 1). General-purpose.
  --ease-expand     cubic-bezier(0.22, 0.61, 0.36, 1). Growth and reveal.
  --ease-decel      cubic-bezier(0, 0, 0.2, 1). Entrances that should settle.

THE VEIL LADDER (five alpha steps over --text-primary, for hairlines and hovers):
  --cl-veil-1 (5%)   Faintest wash: resting hover surfaces.
  --cl-veil-2 (10%)  Default hairline. --glass-border aliases this.
  --cl-veil-3 (25%)  Active/hovered hairline. The canonical hover is veil-1 to veil-3, a 5x alpha jump.
  --cl-veil-4 (50%), --cl-veil-5 (75%)   Emphasis borders and dividers that need to read as deliberate.
  They derive from --text-primary via color-mix, so retheming the text color moves every hairline with it. That coupling is intentional; if you want borders that do NOT follow text, set a literal instead.

CHAT SURFACE (only affects the conversation view):
  --cl-chat-plate-char / --cl-chat-plate-user   The two message plates. They are told apart by ALPHA, not hue: 0.65 passes about 28% of the backdrop, 0.5 passes about 40%. If you retheme these, keep the alpha difference or the two speakers stop being distinguishable at a glance.
  --cl-chat-backdrop-blur (3px) / --cl-chat-plate-blur (5px) / --cl-chat-head-blur (0px) / --cl-blur-panel (20px)   The only four blur values on the surface. The conversation header is a strip over the wallpaper, not a sheet: --cl-chat-head-bg (rgba 34/34/38 at 0, transparent by default) is its fill and --cl-chat-head-blur its blur, the Theme surface's Conversation header knobs; on a phone the strip's blur reads --cl-blur-mobile. Backdrop-filter is expensive; adding a fourth value costs a compositor layer. --cl-blur-panel is the floating chat windows' blur; on mobile the windows are full-viewport and solid, so it never applies there.
  --cl-sheet-bg (rgba 34/34/38 at 0.72) / --cl-sheet-saturate (140%) / --cl-sheet-highlight / --cl-sheet-head   The floating chat window MATERIAL: the translucent body, the vibrancy boost beside the blur, the one-pixel light edge on top, the header wash (the accent duotone by default; the Theme surface's Header tint knob sets its strength, 0 is flat) over the colour pair --cl-header-a / --cl-header-b (rgb triplets that follow the accent chain until the Theme surface sets them). For opaque windows set --cl-sheet-bg to a solid colour and --cl-blur-panel to 0; never add a second backdrop-filter inside a window.
  --cl-chat-body (#cccccc) / --cl-chat-narration (#969696) / --cl-chat-speech (var(--accent-muted), #4f92de) / --cl-chat-emphasis (var(--accent-warm), #fac679)   Prose colors. NOTE the inversion: marked-up text is DIMMER than plain body text. Speech and narration sit at the same luminance and are told apart by hue alone, while unmarked body text is roughly twice as bright as both. Raising narration to match body text is the usual mistake; it flattens the distinction.
  --cl-text-halo         Text shadow behind chat prose. Load-bearing over a wallpaper: without it a mid-grey italic smears into the backdrop.
  --cl-chat-measure (68ch) / --cl-chat-avatar (40px) / --cl-avatar-ring-gap (3px) / --cl-chat-bar-h (34px)   Layout. The ring gap is the moat between a message portrait and its ring; the frame is the avatar plus twice the gap. --cl-chat-measure caps line length for readability and defaults to --measure-prose. --cl-chat-bar-h is ALSO the size of every control in the composer, so the field and the buttons beside it share a centre line: change it and they move together.
  --cl-chat-fade         Height of the transcript's top-edge fade under the header (the mask on .chat-conv-messages).
  NOT YOURS TO SET: --cl-chat-wallpaper-* (image, blur, filter, opacity, pos, repeat, size) and --fw-w/h/x/y are written by JS from the Background panel and the window driver; a rule here is overwritten on the next change. Theme the wallpaper through its panel; theme the veil AROUND it via the plate tokens.
SURFACE FAMILIES (the chat windows consume ONLY these; override them and every panel follows):
  --cl-ghost-faint / -soft / -mid / -strong / -heavy   The quiet-surface ladder (2/3/5/9/14% mixes of --text-primary), the recommender card DNA as tokens. faint = idle plates (rows, tiles, chips at rest), soft = standing card/editor plates, mid = idle borders + hover fills + chip fills, strong = hover borders + rings, heavy = emphasized edges (drop zones). Text-mix, so a retheme's text colour carries every quiet surface.
  --cl-elev-border / --cl-elev-hairline / --cl-elev-shadow   The raised-surface chrome: every .cl-modal, every chat window and the login card read the hairline and the shadow, so "what a dialog looks like" is one override. The shadow is the two drops only; a raised surface pairs it with inset 0 1px 0 var(--cl-sheet-highlight) for its top edge. Every dialog and window header reads --cl-sheet-head, the accent duotone wash, so one override retints every header at once.
  --cl-blur-panel (20px) / --cl-blur-popup (12px) / --cl-blur-chrome (10px) / --cl-blur-scrim (5px)   The four blur ROLES, app-wide: a surface floating over content (modals, chat windows, the context menu), the lighter float (the tag and recommender autocompletes, the tag filter, the gallery pager, the sign-in wall, the playlist icon picker, the gallery sync menu), the bands (topbar, toasts, the multi-select toolbar), the wash behind a modal. Every desktop backdrop-filter reads one of them (a phone surface reads --cl-blur-mobile below, the conversation its own three); to kill blur everywhere set all four to 0.
  --cl-sheet-bg-mobile (var(--bg-secondary)) / --cl-blur-mobile (none: a whole backdrop-filter value, blur(Npx) when set)   The phone material pair: what every sheet, popup, full-screen window and band over content is made of under html.cl-mobile. Solid and unblurred by default because a phone stutters on a blur over a whole transcript; raise the blur and lower the tone's alpha for glass on a phone that can pay for it.
  --cl-accent-tint / --cl-accent-tint-border   The two repeated accent strengths (0.1 fills, 0.15 borders): chips, active rows, icon chips, empty-state marks. Stronger per-surface accent alphas stay local and deliberate.
  SCOPED-RETHEME TRAP: custom properties freeze at their DEFINITION scope. The derived tokens (--cl-sheet-head, --cl-accent-tint, --cl-accent-tint-border, --accent-glow, --cl-focus-glow) are defined at :root in terms of var(--accent-rgb) or var(--accent), so a scoped override like ".cl-cwin { --accent-rgb: ... }" does NOT re-tint them: descendants inherit the already-substituted :root value. Direct rgba(var(--accent-rgb), x) use sites DO follow the scope. For a scoped accent retheme, re-declare those five derived tokens inside the same scope (their var() references then resolve against the scoped accent).

PROSE + MISC:
  --leading-prose        calc(1em + 0.5rem). ADDITIVE leading, not a ratio: a ratio grows the gap as type scales up, which is wrong for long reading text.
  --measure-prose (68ch), --tracking-ui (0.8px), --tracking-wide (1.5px).
  --font-stack-mono      The one monospace stack ('Noto Sans Mono', 'Consolas', 'Monaco', monospace). Every code/mono surface reads it.
  --op-disabled (0.3)    Disabled-state opacity. --cmn-disabled-opacity is an alias of it.
`.trim();

const CATALOGUE_COMPONENTS = `
COMPONENT SELECTORS (verified against source; class names are exact):

Layout / Chrome (defined in library.css):
  .topbar                Sticky top bar with logo, search, sort, view toggles.
  .view-toggle           Topbar Characters/Chats segmented switcher.
  .view-toggle-btn       One button inside .view-toggle.
  .view-toggle-more      The switcher's More: the views that do not fit (an extension's first) wait behind it, listed in the context menu. .is-current while the view showing is one of them.
  .cl-overflowed         An entry a bar collapsed behind its More (display: none, important). The bar owns it; a snippet that shows it again puts the entry on the bar twice.
  .cl-overflow-lifted    A collapsed entry pressed from its More, standing unseen (visibility: hidden) in the More's place while the list or dropdown it opened is up. The bar owns it and places it inline.
  .filters-wrapper       The topbar's filter row: every view's sort and filters, and the Online view's provider selector and toolbar. What does not fit waits behind .topbar-filters-more.
  .topbar-filters-more   The filter row's More, a .glass-btn icon button between the row and the notifications bell; hidden while everything fits.
  [hidden]               An element the app hides (display: none, important). A snippet that sets display does not show it.
  .character-grid        Character grid wrapper (also has id="characterGrid").
  .char-card             One character tile in the main grid.
  .char-card.is-favorite Modifier for favorited cards. (Not ".favorite"; must be ".is-favorite".)
  .card-overlay          Bottom overlay strip on a card holding name + tags. Nested under .char-card.
  .card-name             Character name overlay on a card. Nested as .char-card > .card-overlay > .card-name.
  .card-tag              Tag pill rendered on grid cards. Inside .card-tags container.
  .card-tags             Container for tags on a card.
  .favorite-indicator    Star/heart icon shown on .char-card.is-favorite.
  .card-badges           Column of extension chips on a card, right side under the favorite slot (pointer-events: none). Only present when an extension contributes a badge.
  .card-badge            One chip in .card-badges: an <i> icon + a <span> label on var(--cl-shade-60) with a var(--glass-border) hairline. Tones .is-accent / .is-success / .is-warning / .is-danger colour the text and the hairline from var(--accent) and the -pale status tier.
  .modal-glass           Full-viewport detail panel (character detail, character creator, the online previews, the full-screen readers). NOT gallery viewer (that's .gv-modal).
  .modal-sidebar         Right-side info pane inside the character detail modal. Hidden on mobile (display:none), so styling it under html.cl-mobile is a no-op.
  .tab-nav               The character detail modal's tab bar (container of the .tab-btn buttons). Desktop background is var(--cl-shade-20); on mobile it is sticky on the phone sheet colour, var(--cl-sheet-bg-mobile) (the html.cl-mobile .char-modal .tab-nav rule), the same token the full-screen detail sheet behind it reads, so a token retheme reaches both; to give the bar a colour of its own, target "html.cl-mobile #charModal .tab-nav": the id outranks that rule, no !important needed.
  .tab-more              The strip's More, after the last tab: the tabs that do not fit (an extension's first) wait behind it, listed in the context menu. .is-current while the open tab is one of them. Shares every .tab-btn look rule.
  .ext-tab-btn           An extension's tab in the detail modal's strip, after the app's own; it also carries .tab-btn (and .active when shown), so every .tab-btn rule reaches it. Its pane is .ext-tab-pane (also .tab-pane).
  .tab-btn               The detail modal's tab buttons (Details/Edit/Chats/Gallery/Related/...). Already follow var(--accent) (active text + bottom border, plus rgba(var(--accent-rgb),0.05) active background) and var(--text-secondary), so they retheme automatically; no per-button rules needed for a token retheme.
  .tab-pane              Tab content panes inside the character detail modal. Use .tab-pane.active for the visible one.
  .section-h3            A section heading in the character detail (Description, First Message): var(--accent) text, a var(--glass-border) underline, weight 600, a leading icon. Follows the accent.
  .linked-lorebook-card  Edit tab's lorebook-links card: one ordered pills row (.linked-lorebook-aux). Card bg rgba(var(--accent-rgb),0.05) follows accent.
  .aux-lorebook-pill     Linked-lorebook pill in the card's .linked-lorebook-aux row. Accent-alpha bg rgba(var(--accent-rgb),0.08) follows accent; the book icon and the row label icon ride var(--cl-info-pale); the X hover rides var(--cl-error-rgb).
  .char-modal-nav        Prev/Next chevron buttons on the sides of the character detail modal (desktop only; mobile uses swipe). Mirrors the gallery viewer's .gv-nav: a plain dark capsule (rgba(0,0,0,0.5)) with a white chevron, flush to the modal edge and half-rounded toward center, background lightens on hover. Not accent-coupled. Variants: .char-modal-nav-prev, .char-modal-nav-next. Icon glyph is a ::before pseudo using Font Awesome 6 Free. Component-scoped vars for per-component theming (override on .char-modal-nav itself): --cmn-bg (rgba(0,0,0,0.5)), --cmn-bg-hover (rgba(255,255,255,0.1)), --cmn-border (1px solid rgba(255,255,255,0.1)), --cmn-color (#fff), --cmn-width (50px), --cmn-height (80px), --cmn-icon-size (var(--font-2xl)), --cmn-icon-prev ('\\f053' = fa-chevron-left, override with any FA6 unicode), --cmn-icon-next ('\\f054' = fa-chevron-right), --cmn-disabled-opacity (0.3). Hidden on mobile via library-mobile.css; gated on the enableCharDetailNav setting.
  .toast / .toast-container  Toast notifications. Variants: .toast.success, .toast.error, .toast.warning, .toast.info.
  .toast-icon            Icon inside a toast.
  .close-btn             Generic X-close button on modals.
  .cl-modal-close        X-close button inside .cl-modal-content modals.
  .tag-filter-item       Pills used in the tag filter dropdown (search/filter UI).

Browse view (defined in modules/providers/browse-shared.css):
  .browse-card           Character card in provider browse view (Chub, JanitorAI, etc).
  .browse-tag            Tag pill inside browse cards.
  .browse-search-bar     Search input row in the browse view header.
  .browse-timeline-header  The head of a provider's following timeline: a var(--cl-ghost-soft) card with a var(--glass-border) edge, an h3 whose icon is var(--accent) (.browse-timeline-header-left / -right). .browse-timeline-empty is its centered empty or sign-in state.
  .browse-author-banner  The strip over the grid while browsing one creator's cards: an accent to accent-secondary tint with an accent border (.browse-author-banner-content, its icon and name in var(--accent); .browse-author-banner-hint; .browse-author-banner-actions). Its .browse-author-follow-btn is heart red on the --cl-error-bright tokens; .following turns its text a HARDCODED #fff.
  .browse-error-banner   The grid's load-error state: a centered var(--cl-error-bright) icon, a title, the message, and its buttons in .browse-error-actions.
  .browse-notice         The in-modal preview notice every provider uses (locked, hidden, auth-required and extraction-unavailable definitions): a strip on the --cl-info tint by default, .browse-notice-warning / -hidden / -locked on the warning tint, .browse-notice-error on the error tint; .browse-notice-icon, .browse-notice-title (the pale tier), .browse-notice-message, .browse-notice-hint, .browse-notice-actions. .browse-notice-cta is the boxless centered empty-state layout with a 56px icon circle. No provider hand-rolls this banner.

Settings UI (defined in library.css):
  .settings-nav / .settings-nav-item / .settings-nav-item.active   Settings modal left rail.
  .settings-panel / .settings-panel.active                        Right content panel.
  .settings-group / .settings-group-title                         Grouped settings card with title.
  .settings-row                                                   One labelled control row inside a group.
  .settings-action-btn                                            Inline action button (Open Editor, Migrate, etc). Variants: .primary, .danger, .danger-hover (red on hover only).
  .settings-band                                                  Status notice with its verb beside it (icon, the line that answers, its sub, a .cl-btn). Accent edge at rest; .is-ok green, .is-warn --cl-warning, .is-error --cl-error, .is-danger --cl-error-pale. The backup notice and the migration wizard's run and finalize.
  .mig-steps / .mig-step / .mig-step-num                          The migration wizard's rail: a chip per step (--cl-accent-tint) that turns into a green check under .is-done; the rail between chips is --cl-ghost-mid.
  .settings-hint                                                  Subdued help text under a control. .settings-hint-warn tints one that says a saved value does not apply now.
  .settings-view-tabs / .settings-view-panel / .settings-view-panel-title   General > View Defaults: the tab strip (a .cl-cwin-tabs), a panel of rows per view, and the view's name over its panel while a search lists them all.
  .settings-row[data-platform]                                    A row one platform shows: data-platform="mobile" rows are hidden on desktop and "desktop" rows on a phone (display: none, important). .settings-platform-badge is the faded glyph (0.45 opacity) after such a label, e.g. the desktop icon on UI Scale.
  .settings-verify-btn                                            The 38px square check button beside a key or URL field: var(--cl-ghost-mid) with a var(--glass-border) edge at rest; .success and .error tint it from --cl-success-rgb / --cl-error-rgb (important rules).
  .settings-status-badge                                          A pill stating a state: .active on a --cl-success tint, .inactive muted on var(--cl-ghost-mid).
  .settings-provider-badge / .ext-chip                            The tiny uppercase chip: on a provider section an accent tint with var(--accent) text (.is-deprecated in the error-darker tone); in Settings > Extensions a neutral var(--cl-ghost-mid) chip, .ext-chip-ok / .ext-chip-error on the success and error tints.
  .provider-order-item / .provider-toggle-btn / .provider-beta-badge   Settings > Online's provider list: a row per provider (.provider-disabled dims and strikes it), its eye toggle (.disabled turns it var(--cl-error-bright)), and the Beta chip on the --cl-warning-bright-darker tone (.is-deprecated on the error-darker tone).
  .provider-exclude-tags-container                                A provider's excluded-tags field: a var(--cl-shade-15) well wrapping .provider-exclude-tag-pill chips and the borderless .provider-exclude-tags-input. The pills' fill and border tint from --cl-error-bright-rgb, but their text is a HARDCODED #e78c7c NOT bound to the error tier; retarget .provider-exclude-tag-pill color with the rest.

Multi-select mode (defined in modules/multi-select.css). Bespoke toolbar treatment that doesn't reuse .glass-btn / .cl-btn so it can carry its own personality; flag the coupling gaps below when retheming:
  body.multi-select-mode .char-card           Body flag set when multi-select is active; gives every card a pointer cursor + reveals the per-card checkbox.
  .char-card-checkbox                         24x24 checkbox overlay top-left on every card (display:none normally, display:flex inside body.multi-select-mode). Selected paint: ".char-card.selected .char-card-checkbox" (accent bg + accent border + the inner <i> fades in). Hover preview: ".char-card:hover .char-card-checkbox" tints border to accent.
  .multi-select-toolbar                       Persistent action bar inserted before .gallery-content when mode is on. Bg is a HARDCODED dark blue/purple gradient (rgba(26,26,46,0.95) -> rgba(30,30,50,0.95)) NOT bound to the accent token, so a global accent retheme leaves the bar visually disconnected; retarget .multi-select-toolbar background explicitly to follow accent. Border-bottom DOES use var(--accent-rgb) and follows the accent automatically.
  .multi-select-toolbar.hidden                Hidden state (display:none).
  .multi-select-badge                         Count chip on the left ("3"). Accent gradient via --accent + --accent-secondary; themes automatically.
  .multi-select-label                         "characters selected" text next to the badge. Hidden in mobile mode (html.cl-mobile).
  .multi-select-left / .multi-select-actions / .multi-select-right    Three flex sections of the toolbar.
  .ms-divider                                 Vertical 1px divider before Delete, in .multi-select-right. Hidden on mobile.
  .ms-ext-actions                             The extensions' verbs for the selection, a display: contents group after Playlist, so its buttons are plain .ms-btn in the row (their data-ext-action names the verb).
  .ms-btn                                     Bespoke toolbar action button (Select All, Tags, Favorite, Export, Updates, Playlist, an extension's verbs, Delete, Exit). NOT .glass-btn. Translucent white bg (rgba(255,255,255,0.08)), #eee text, hover adds 1px lift + brighter bg. On mobile collapses to an icon-only square of var(--touch-target-slim) (span hidden). Variants:
                                                 .ms-btn.ms-btn-ghost     Transparent bg. Used by the Favorite button when ALL selected are already favorited, signaling "click to unfavorite" with reduced emphasis. The button toggles between .ms-btn (favorite) and .ms-btn.ms-btn-ghost (unfavorite) via JS.
                                                 .ms-btn.ms-btn-danger    Red tint for Delete. HARDCODED #f87171 text (the value --cl-error-vivid holds, as a literal) + rgba(239,68,68,*) bg/border, NOT linked to any status token; retarget the .ms-btn-danger rule explicitly if you want it to follow the status token family.
                                                 .ms-btn.ms-btn-more      The bar's More: the verbs that do not fit, and on a phone every verb but Tags and Favorite, listed (labelled) in the context menu or its sheet. Hidden while everything fits.
                                                 .ms-btn.ms-btn-exit      Slightly different bg tint (rgba(100,100,120,*)) and tighter padding for the rightmost exit-mode icon button.

Context menu (defined in modules/context-menu.css):
  .cl-context-menu / .cl-context-menu-item   Right-click context menu and rows. .is-current on a row of a More's list whose control the bar shows lit (accent text).

Search everything, the command palette (defined in modules/command-palette.css; the key under Esc, or the first More Options item #commandPaletteMenuBtn):
  .cl-palette            The fixed layer over the page (scrim --cl-modal-scrim-light); [hidden] while closed, .is-open once shown. A phone gets the whole screen and no scrim.
  .cl-palette-box        The panel: --cl-sheet-bg with the panel blur, --cl-elev-border, --cl-elev-shadow, radius-3xl. .has-preview widens it for the preview pane (a desktop 900px or wider).
  .cl-palette-head / .cl-palette-input / .cl-palette-mark / .cl-palette-chip   The field row; the chip names the result or action the field is asking about (accent tint).
  .cl-palette-list / .cl-palette-group / .cl-palette-item   The results, grouped; .cl-palette-item.is-on is the highlighted row (--cl-veil-2), .is-danger a destructive action (--cl-error-vivid when highlighted), .is-message a matched message (its line over two lines, its chat under it; the matched words in <mark>).
  .cl-palette-icon / .cl-palette-pic / .cl-palette-title / .cl-palette-note / .cl-palette-hint / .cl-palette-more   A row's parts: icon tile or portrait, title, muted note, the Tab hint (desktop, highlighted row) and the phone's actions button.
  .cl-palette-preview / .cl-palette-portrait / .cl-palette-pv-title / .cl-palette-pv-note / .cl-palette-pv-text / .cl-palette-tags / .cl-palette-tag   The preview pane beside the list.
  .cl-palette-foot / .cl-kbd / .cl-palette-close        The keys row and the kbd chips; the close button reads Esc on a desktop, Cancel or Back on a phone.

Gallery viewer (defined in modules/gallery-viewer.css):
  .gv-modal              Gallery viewer modal overlay.
  .gv-modal.visible      Visible state.

Version history (defined in modules/character-versions.css; its dialogs are the showConfirm dialog):
  .vt-stat / .vt-badge / .vt-lb-*   Diff stats, badges, lorebook-diff rows.
  COUPLING GAP: the entire diff/status palette here is a deliberate VS Code-style carve-out, HARDCODED hexes (#89d185 added, #f48771 removed, #ffb450 modified, #bdbdbd local-only, about 20 hex and 30 rgba sites) bound to NO token. Retheming the --cl-* status tiers moves nothing in this surface; recoloring it means targeting .vt-* classes directly.

Lorebooks (defined in modules/lorebook-manager.css). A self-contained World-Info editor plus AI-generation suite. It reuses the canonical shells (.modal-glass, .cl-modal-content) and the token system, but carries its own cohesive entry/button chrome (the way character-creator does). Accent-active states follow var(--accent-rgb) and retheme automatically EXCEPT where flagged:
  .lb-modal-glass        The manager's full-screen panel (reuses the .modal-glass shell at largest size).
  .lb-header             The manager's top bar (title + close).
  .lb-world-row          One lorebook row in the left sidebar list, on the shared .lorebook-link-row row. ".lb-world-row.active" tints bg/border via var(--accent-rgb) (themes automatically).
  .lb-meta-pill          Small neutral metadata pill (entry count, etc.). Neutral var(--cl-ghost-mid) bg (the quiet ladder follows the text colour); intentionally does NOT follow accent.
  .lb-linked-chip        Avatar+name chip for a character linked to the open lorebook (editor header). One uniform variant; the X unlinks.
  .lb-entry              One collapsible World-Info entry card in the editor. ".lb-entry.expanded" adds an accent border. Neutral rgba(255,255,255,*) surface by design.
  .lb-entry-head         An entry's clickable header (switch + title + badges + actions + chevron). .lb-entry-title is the title text.
  .lb-badge              Status badge on an entry header. Variants: .lb-badge.constant (accent tier, follows accent), .lb-badge.vector (warning tier, var(--cl-warning-rgb) bg + var(--cl-warning-pale) text, follows a warning retheme), .lb-badge.selective (neutral var(--cl-ghost-strong), intentionally does not follow accent).
  .lb-switch             The enable/include toggle (also reused by the AI review tray as the per-entry include switch). Checked state uses var(--cl-success-rgb) green; follows the SUCCESS status token, not accent.
  .lb-save-btn           Editor Save button. ".lb-save-btn.dirty" (unsaved) uses var(--cl-success-rgb) green; follows the success token, not accent.
  .lb-link-btn           Link/Bind button in the editor header. Accent-tinted (follows accent).
  .lb-icon-btn           Bespoke 34px square icon-action button (rename, duplicate, export, delete, overflow kebab). Modifiers: .small (28px), .danger (red hover via var(--cl-error-rgb)). Neutral translucent bg; this is NOT the topbar .glass-btn.
  .lb-ai-entry-btn       The accent-tinted "AI" button in the entries toolbar (.lb-add-entry-btn is the "Add Entry" button beside it).
  .lb-ai-modal-content   The "Generate with AI" modal panel (reuses .cl-modal-content chrome).
  .lb-ai-section         A numbered step card (Source / Instructions / Output) inside the AI modal. Neutral card surface.
  .lb-ai-step            The round step-number badge (1/2/3). accent -> accent-secondary gradient (themes automatically).
  .lb-ai-src-opt         A source-type tab (Paste text / Web-Wiki / From library). ".lb-ai-src-opt.active" is an accent tint.
  .lb-stage-card         One generated-entry card in the AI review tray (reuses .lb-entry chrome). .lb-stage-keypill is the compact neutral key pill on it.
  .lb-ai-src-mode        The Characters | Chats sub-toggle in the From-library picker (active segment = accent tint). .lb-ai-src-chatpick is a selected character's or chat's card (a --cl-ghost-soft plate; .lb-ai-src-chip-x removes it); .lb-ai-src-scope-opt is a per-chat All/Last/Range segment (active = accent).
  .lb-facet              Sidebar facet chips narrowing the book list by binding kind (All / characters / chats / global / personas / unbound). Pills; .active FILLS with the accent tint (a mode, not a hover).
  .lb-reach-chip         Per-kind reach chip on a sidebar book row (glyph + tabular count over --cl-ghost-mid); .is-global is the accent-tinted globe.
  .lb-bindings           The editor's bindings strip: one .lb-bind-group per kind (.lb-bind-label uppercase eyebrow, .lb-bind-chips wrap of .lb-linked-chip pills). .lb-bind-add is the dashed add circle (accent on hover); .lb-bind-global is the Global on/off pill (.is-on = accent fill); the persona add menu rides .lb-split-menu inside .lb-persona-add-wrap.

Buttons (the buttonStyle setting toggles glass vs solid chrome; theming applies to both):
  .glass-btn             Topbar/filter chrome buttons. Defined as a combined selector with .glass-select.
  .cl-btn                THE dialog button, every modal footer and module dialog (the one dialog button family: there is no .action-btn, so a snippet written for it targets .cl-btn). Color variants: .cl-btn-primary, .cl-btn-secondary, .cl-btn-danger, .cl-btn-danger-hover (neutral at rest, red on hover: the verb that stops a running operation), .cl-btn-warning. Size: .cl-btn-sm (compound with .cl-btn). Solid and glass looks both defined once per variant.
  .creator-ai-btn        The character creator's per-field AI button (modules/character-creator.css): a quiet ghost at 0.6 opacity, var(--accent) text, border and tint on hover, accent while .generating.

Inputs / Modals / Dropdowns:
  .glass-input             Text inputs and textareas across the app (topbar search, settings, character detail editor, etc.).
  .cl-input                Text inputs inside module dialogs (batch-tagging, playlists). Peer to .glass-input but scoped to .cl-modal-content surfaces; uses --cl-text-primary and --cl-border.
  .cl-ai-composer          The AI chat composer pill (AI Studio, the CSS Assistant chat, the recommender's Ask About chat): a rounded plate (--glass-border, focuses to the accent) holding the borderless .cl-ai-composer-input textarea and the circular ghost .cl-ai-send (arrow icon, accent on hover), whose .is-stop face is the error-tinted stop shown while generating. THE COMPOSER FAMILY BOUNDARY: this pill is for inline AI-chat turns (growth capped ~4 lines, one subordinate ghost send); the panel family's .cl-cwin-input-row is the work composer (tool buttons, tall growth, a toolbar row under the text); the in-conversation .chat-conv-composer is the bespoke flagship (verbs row, impersonate chip). A new composer joins one of these three, never a fourth shape.
  .cl-ai-empty             The same two AI chats' empty state: muted centred hint text (--text-muted, an icon in --text-secondary, an example list) that takes the chat's room until the first message.
  .cl-confirm-overlay      The generic confirm dialog built by window.showConfirm({title, message, danger, icon, content}). Left intent-badge layout: .cl-confirm-main (badge + text row), .cl-confirm-badge (42px circle, accent-tinted by default; add-class .cl-confirm-danger on the overlay switches it to red via rgba(var(--cl-error-rgb)) bg + var(--cl-error-bright) icon), .cl-confirm-text (the column: an h3 title + #clConfirmMessage), and .confirm-modal-footer (Cancel + Confirm .cl-btn buttons; the confirm button is .cl-btn-primary, or .cl-btn-danger when danger:true). Structured bodies (the showConfirm content block array) render inside #clConfirmMessage as: .cl-confirm-p (paragraphs), .cl-confirm-stats > .cl-confirm-stat (pill chips with accent icon, .cl-confirm-stat-label faint + .cl-confirm-stat-value bold), .cl-confirm-list (bullets), .cl-confirm-kv > .cl-confirm-kv-row (.cl-confirm-kv-key faint label + value, mono values as <code>), and .cl-confirm-note with tone variants -info (accent-tinted) / -warning (--cl-warning) / -danger (--cl-error). All tones ride status tokens so they follow a retheme. Badge and title colors come from --accent / --cl-error / --text-primary tokens. Toggled via the .hidden class on #clConfirmOverlay.
  .confirm-modal-content   The SHARED confirm-dialog shell, used by two surfaces, so a bare ".confirm-modal-content {}" rule hits BOTH. (1) Standalone dialogs that keep the full chrome: .confirm-modal-header (accent-gradient strip + title + .close-confirm-btn X) over a custom .confirm-modal-body, toggled via .hidden on the .confirm-modal parent. These are confirmSaveModal (changes diff) and the two delete confirms, deleteConfirmModal and deleteDuplicateModal. (2) The showConfirm dialog above (.cl-confirm-overlay wraps this same shell and overrides the chrome into the badge layout). To target only one: ".cl-confirm-overlay .confirm-modal-content" for showConfirm, or those ids / the .confirm-modal parent for the others. (cl-modal toggles .visible; confirm-modal toggles .hidden, dual class system.)
  .cl-modal-content        Every utility + feature dialog: Settings, Provider Link, Import, Import Summary, Localize, Bulk Localize / Summary / Auto-Link, Character Duplicates, Pre-Import Duplicate, Save-As Diff, AI Recommender, CSS Assistant, Custom CSS, Card Update, Playlists, Batch Tagging, Save-Preset Picker. (Character creator uses .modal-glass instead.) Shared chrome (all cl-modal-content modals look identical by default):
                             - Background: var(--cl-sheet-bg) + backdrop-filter: blur(var(--cl-blur-panel)) saturate(var(--cl-sheet-saturate)) on desktop; var(--cl-sheet-bg-mobile) on mobile (full-viewport bottom-sheets).
                             - Border: 1px solid var(--cl-elev-hairline).
                             - Border-radius: var(--radius-3xl) (16px).
                             - overflow: hidden (clips the gradient header to rounded corners).
                             - Box-shadow: var(--cl-elev-shadow) (two drops, 0 24px 64px and 0 2px 8px) + an inset top highlight (var(--cl-sheet-highlight)).
                             - Header: var(--space-md) var(--space-xl) padding, the var(--cl-sheet-head) accent duotone wash (10%/8% stops), a var(--cl-elev-hairline) border-bottom.
                             - Title h3: weight 600, letter-spacing -0.01em.
                           Toggled open/closed via the .visible class on the .cl-modal parent (dual class system - cl-modal uses .visible, confirm-modal uses .hidden).
  .cl-modal-drawer         OPT-IN MARKER on a .cl-modal OR .confirm-modal element. Marks the modal as a tap-away bottom-sheet drawer on mobile: hides the back-arrow (.cl-modal-close / .close-btn / .close-confirm-btn) since the scrim + Android back already close it, and reduces header padding-left from --back-arrow-zone back to --space-md across all three header types (cl-modal-header, confirm-modal-header, modal-header). Add to drawer-shaped modals so the chrome doesn't carry redundant affordances. Consumers: the cl-modal pickers playlistPickerModal, savePresetPickerOverlay, linkLorebookModal, chatLoreModal and batchTransferModal (plus the browse view's dynamic picker), and the dynamic confirm-modals deleteConfirmModal / deleteDuplicateModal.
  .dropdown-menu / .dropdown-item   Popover menus (sort, view, more-options).
  .custom-select-container / .custom-select-trigger / .custom-select-menu / .custom-select-item   Every <select> in the app is converted to this. The container carries the select's layout classes; the trigger is a .glass-btn (.trigger-text, .trigger-arrow, .trigger-icon; .small); the menu is a .dropdown-menu.custom-select-menu fixed above every dialog; a row is .custom-select-item (.selected = var(--accent) text on an accent tint, .is-active = the row the arrow keys are on, on var(--cl-veil-2)), group titles .dropdown-section-title. On a phone the trigger opens a .mobile-sheet instead of the menu. Follows the accent.
  .cl-ai-conn              The connection chooser on the AI surfaces (CSS Assistant, recommender, creator, lorebook AI): a converted select (.cl-ai-conn-row lays it beside its label) and the overrides toggle .cl-ai-conn-ov-btn (var(--cl-ghost-mid) at rest, .active = accent text and border), which opens .cl-ai-conn-ov-panel, one .cl-ai-conn-ov-row per parameter on a var(--cl-shade-15) band (.cl-ai-conn-ov-band).
  #savePresetPickerOverlay The save-to-preset picker (a .cl-modal drawer above the other dialogs; the recommender's prompt presets): a .preset-picker-search field, a .preset-picker-list of .preset-picker-row rows (var(--cl-ghost-mid) on hover, a .preset-picker-row-hint fading in), and the .preset-picker-create-row in var(--accent) text with an accent tint on hover.
  .theme-customizer-modal  The Theme surface (#themeCustomizerModal, a .cl-modal): knobs on the left (.theme-knob rows: .theme-knob-label, the control, a .theme-knob-out readout, a .theme-knob-clear reset; .theme-preset pills on var(--cl-ghost-faint)), a live .preview-sheet on the right painted with the sheet tokens, and .theme-dirty in var(--cl-warning) for an unsaved draft. A snippet that declares a token a knob sets takes that knob over: the row turns .is-overridden (dimmed, with a .theme-knob-css link in var(--cl-warning)), since custom CSS outranks the Theme surface's values.
  .fw-grip / .fw-sized / .fw-seam   Every window's resize furniture. .fw-grip is an edge or corner grip (.n, .s, .e, .w, .ne, .nw, .se, .sw), unpainted at rest, its mark var(--accent) on hover or keyboard focus; .fw-sized marks a dialog or pane the user sized, its size written as --fw-w / --fw-h with important rules (a size the user set outranks every stylesheet); .fw-seam is a sidebar's pull edge. Style the mark, never the geometry.

Tag pill families (FOUR distinct classes for different contexts; pick by surface):
  .card-tag              Pills on grid cards (library.css).
  .modal-tag             Pills inside the character detail modal (library.css). Use .modal-tag.editable when in edit mode.
  .browse-tag            Pills inside browse-view cards (lives in modules/providers/browse-shared.css).
  .cl-kbd                A key cap: the command palette's keys row and hints, and the keys in Settings > Keyboard (--cl-veil-1 fill, --cl-veil-2 edge, --font-2xs). Two in a row sit a hair apart.
  .cl-tag                Pills inside module dialogs. Variants: .cl-tag-success, .cl-tag-warning, .cl-tag-info, .cl-tag-danger. See STATUS COLORS coupling gaps before retheming.
  .tag-filter-item       Pills in the tag filter dropdown (different from above: a filter UI control, not a content tag).

Loaders & progress (CL does NOT use native <progress> elements):
  .cl-loading            Flex column CONTAINER for the hero loader. Children:
                           .cl-loading .cl-loading-icon          Wrapper for the rotating icon (sized 48x48).
                           .cl-loading .cl-loading-icon svg      The brand mark, an inline svg painted with currentColor. Has color: var(--accent) and a drop-shadow filter derived from --accent. Recolor: ".cl-loading .cl-loading-icon svg { color: <color>; filter: drop-shadow(0 0 10px ...); }".
                           .cl-loading .cl-loading-label         Main status text.
                           .cl-loading .cl-loading-bar > span    Animated indeterminate progress bar inside the loader.
                         CSS border-rotation tricks (border-top-color on .cl-loading) do NOT produce a spinner: the animation is on the svg, not the container.
  .cl-lazy-overlay       The full-viewport loader shown while a feature opens for the first time: a var(--cl-modal-scrim) wash above every dialog holding a .cl-loading hero loader.
  .cl-spinner-inline > i   Inline spinner used in grid/list slots. The <i> child is the rotating FontAwesome icon (uses fa-spin). To recolor: ".cl-spinner-inline i { color: <color>; }".
  Real progress bars (custom div pairs, NOT <progress> elements):
    .import-progress-bar > .import-progress-fill                       Character import, import-media, and media-localize progress.
    .import-summary-progress-bar > .import-summary-progress-fill       Bulk import summary.

Notifications center (the topbar bell dropdown; the shell AND its rows in modules/gallery-sync.css):
  .gallery-sync-dropdown   The dropdown panel itself. Despite its "gallery-sync" name it is the SHARED shell for every notification section. HARDCODED dark surface (rgba(30,30,35,0.98) bg + a heavy rgba(0,0,0,0.6) drop shadow), bound to NO token; retarget .gallery-sync-dropdown background directly to recolor the panel. Its border is var(--cl-ghost-heavy) and follows the quiet ladder. On a phone the panel sits in a sheet and its own surface is transparent.
  .notif-section           One section card inside the dropdown (media downloads, JanitorAI extractions; the shell makes one per registered section). Neutral inset surface rgba(0,0,0,0.2) + var(--glass-border) + var(--radius-lg). The bg is HARDCODED (the app's recurring inset-panel value) and does NOT follow accent; retarget .notif-section background to recolor the cards.
  Section rows (.notif-* selectors, one vocabulary every section draws):
    .notif-header          Section eyebrow title ("MEDIA DOWNLOADS", "JANITORAI EXTRACTIONS"); its <i> icon is var(--accent) (follows accent).
    .notif-row             One row (.is-active / .is-failed mark the state). Children: .notif-row-icon (leading status glyph: var(--accent) for active; .is-error adds var(--cl-error-bright) for failed), .notif-row-body, .notif-row-name, .notif-row-sub (with faint .notif-row-meta count/percent), .notif-row-actions / .notif-row-btn (icon buttons; hover bg rgba(var(--accent-rgb),0.15), follows accent).
    .notif-progress > .notif-progress-fill   Active-job bar. The FILL is var(--accent) (follows accent); the TRACK (.notif-progress bg) is var(--cl-ghost-strong) (a neutral ghost tier).
    .notif-row-choices     A row's answers as small .cl-btn buttons under its line (the library backup's missed-window question), wrapping on a narrow sheet; the buttons follow the .cl-btn variants.
    .notif-pending         "N more queued" line. .notif-row-error is a failed-row message in var(--cl-error-pale) (follows error tier). .notif-done-row is the "N completed" / "N imported" footer; its check <i> is var(--cl-success) (follows success tier).

Mobile chrome (defined in library-mobile.css and modules/chats/chats.css; scoped under html.cl-mobile). Rules using these selectors typically need !important to beat the mobile stylesheet's existing rules:
  .mobile-bottom-nav            Persistent bottom navigation bar (mobile only; replaces topbar). On the phone material: var(--cl-sheet-bg-mobile) under var(--cl-blur-mobile) (solid and unblurred by default), a var(--glass-border) top hairline.
  .mobile-bottom-nav-tab        One of the three view tabs inside .mobile-bottom-nav (Characters / Chats / Online). Takes flex: 1 to share space evenly. Active state: .mobile-bottom-nav-tab.active (gets --accent color + a 3px top stripe).
  .mobile-bottom-nav-action     Small (40px) icon-only utility button (Filters, More). Renders as a floating --radius-circle with --text-faint color; active/press state tints to accent. Labels are hidden.
  .mobile-bottom-nav-actions    Wrapper grouping the action buttons; visually offset from the view tabs with var(--space-md) margin-left.
  .mobile-fab                   Floating action button: search on the Characters, Chats and Online views, hidden elsewhere. Follows the buttonStyle setting: the default glass style is a translucent accent tint with an accent hairline (:root[data-btn-style="glass"].cl-mobile .mobile-fab); the solid style is the accent to accent-secondary gradient.
  .mobile-search-overlay        Mobile search overlay shown on Characters / Chats views (FAB-triggered, full-viewport).
  .mobile-online-search-overlay Mobile online-provider search overlay (FAB-triggered on Online view, full-viewport sheet).
  .mobile-more-actions-btn      Kebab popover trigger inside .browse-char-modal .modal-controls (mobile only). Visible when the "Quick-import button on browse previews" setting is OFF.
  .mobile-more-actions-menu     Popover menu spawned by .mobile-more-actions-btn. Contains .mobile-more-actions-item rows mirroring the provider's action buttons.
  .mobile-quick-import-btn      Icon-only Download/Import/Extract square that mirrors the provider's primary action button state. Color-coded via the data-state attribute: data-state="primary" (accent), data-state="warning" (--cl-warning-bright, possible-match), data-state="secondary" (muted, in-library).
  .mobile-provider-quick-switch Topbar provider-switch icon button on the Online view (small icon next to the view tabs).
  .mobile-sheet-overlay / .mobile-sheet   THE canonical mobile bottom-sheet shell (slide-up, drag handle, scrim). Used by Settings/Filters, More menu, provider-switch, the <select> picker, confirm sheets AND the card context menu (long-press). Open state: .mobile-sheet.open. Rows: .mobile-sheet-item; cloned context-menu rows use .cl-context-menu-item inside it.
  .mobile-settings-select       Full-width button chip inside the mobile settings sheet's Sort By section; opens the selector drawer for the real <select> it mirrors. Children: .mobile-settings-select-text (current value, ellipsised) + .mobile-settings-select-arrow (chevron). COUPLING GAP: its background is var(--cl-ghost-strong), the quiet ladder that follows the text colour, NOT bound to the accent, so an accent retheme leaves it neutral (only its :active border turns accent); retarget .mobile-settings-select background explicitly to follow accent.
  .mobile-avatar-viewer         Tap-on-avatar quick fullscreen image viewer.
  .mobile-pull-refresh-indicator Pull-to-refresh affordance attached to .gallery-content; modifiers: .ready, .refreshing.
  .char-card-swipe-chip         Swipe-action chip rendered on a card during left/right swipe. .char-card-swipe-chip.right is the favorite (gold) chip; .char-card-swipe-chip.left is the destructive (red) chip. .armed state activates on threshold crossing.

Skeleton & empty states (mobile-first but used on both platforms):
  .cl-skeleton-card             Skeleton placeholder matching the .char-card layout. Children: .cl-skeleton-img (image area), .cl-skeleton-line (text rows). All use --glass-border as the base + an animated shimmer overlay.
  .cl-skeleton-line             Single shimmering line; use modifier widths via inline style or extra classes.
  .cl-empty-state               Rich empty-state container with icon + title + hint + optional action button. Children: .cl-empty-state-icon, .cl-empty-state-title, .cl-empty-state-hint, .cl-empty-state-action.

Scrollbars (webkit pseudo-elements; safe to theme globally):
  ::-webkit-scrollbar / ::-webkit-scrollbar-track / ::-webkit-scrollbar-thumb / ::-webkit-scrollbar-thumb:hover

Icons: CL uses FontAwesome 6 (Free) for icons throughout, rendered as <i class="fa-solid fa-NAME"></i>. Common names include fa-check, fa-check-circle, fa-times, fa-xmark, fa-triangle-exclamation, fa-info-circle, fa-lightbulb, fa-star, fa-heart, fa-spinner (with fa-spin class for rotation), fa-paper-plane, fa-floppy-disk. Standard FontAwesome theming techniques apply.

Native form controls: CL has ~97 native <input type="checkbox"> elements (across settings, filters, dialogs) and several <input type="radio">. The global accent-color rule routes them through --accent, so token overrides handle simple tinting. Beyond color, standard browser-form theming patterns apply.

The list above documents stable, recommended theming surfaces. CL is built on standard HTML, CSS, and FontAwesome 6; for requests outside this catalogue (icon swaps, native form-control customization, animations, niche selectors), reach for general web-CSS knowledge. The catalogue is a guide, not a fence.

Chat conversation (modules/chats/chats.css; the whole surface lives under .chat-conv):
  .chat-conv             The conversation root. Carries the display options as data attributes, and they are the cheapest hooks you have: [data-mode="banner"|"column"], [data-avatars], [data-timestamps], [data-meta], [data-expand-actions], [data-msg-fill="false"] (the bare look: plates/outlines/lift removed from whichever layout is active), [data-body-layout="auto"|"beside"|"full"] (beside keeps the prose beside the avatar, full puts it full width under the name; auto is full on a phone and beside elsewhere). Also [data-generating] while a reply streams.
  .chat-conv-window      The floating conversation itself. Width/height/position come from --fw-* set by JS when the user drags it, so do not set them here.
  .chat-conv-header      Its top bar: back arrow, avatar, .chat-conv-heading (title + sub), then .chat-conv-header-right which is THE home for header controls. A narrow window keeps the openers that fit beside the title; the rest wait behind .chat-conv-more (which wears .is-marked when a marked opener is among them).
  .chat-conv-messages    The scroller holding the rows.
  .chat-conv-msg         ONE message row, always with .user or .assistant, plus .system, .last-message, .is-hidden, .streaming, .editing, .gen-error as they apply. Both speakers keep the avatar on the LEFT and nothing mirrors: that is deliberate, and mirroring the user side is the most common thing a snippet gets wrong here.
  .chat-conv-msg-head    The name/chip/actions band at the top of a row. Children: .chat-conv-msg-name (the band's one shrink absorber: it ellipsizes, chips and buttons keep their size), .chat-conv-msg-chip (meta chips: .is-time is the timestamp one, .is-meta the number and the tokens; state variants .is-interrupted and .is-hidden-flag ride the warning-pale tier), .chat-conv-msg-actions.
  .chat-conv-msg-body    Wraps the reasoning disclosure and the prose.
  .chat-conv-msg-text    The prose itself. Max line length is --cl-chat-measure; the plate is on the ROW, not here.
  .chat-conv-msg-avatar-frame / -avatar / -avatar-glyph   The portrait box, its image, and the glyph the user side falls back to.
  .chat-conv-msg-actions Per-row buttons (.chat-conv-msg-act), with the overflow group .chat-conv-msg-overflow behind .chat-conv-msg-more.
  .chat-conv-swipes      The alternates pill at a row's bottom right (.chat-conv-swipe-btn, .chat-conv-swipe-count). .will-generate marks the state where pressing next calls the model. The prose's last line ends in an unseen copy as wide as the pill (a ::after on the last paragraph or list item), so text wraps before it rather than running under it. Its size reads --swipe-btn and --swipe-gap on .chat-conv-msg: resize the pill there, since a width set on the buttons alone leaves the copy at the old size and text runs under the pill again. Do not give that last paragraph an ::after of your own. On a phone each button's ::before is its tap area, so leave it unstyled.
  .chat-conv-composer    The input bar. Children: .chat-conv-opt-btn, .chat-conv-input, .chat-conv-composer-right holding .chat-conv-quick, .chat-conv-send, .chat-conv-stop. Every control is one --cl-chat-bar-h square so they share the field's centre line; resizing one alone breaks that row.
  .chat-conv-ext-strip   Extensions' buttons just above the composer (role toolbar): each a .chat-conv-ext-btn, the composer controls' own ghost square, one extension's set from the next parted by a .chat-conv-ext-sep hairline; what does not fit waits behind .chat-conv-ext-more. Carries the hidden attribute while no button shows.
  .chat-conv-divider     Day/session rule between rows; with .chat-conv-context-divider it is the accent context boundary (messages above it no longer fit the budget and are not sent). .chat-conv-skeleton is the loading placeholder.
  The streaming caret is a PSEUDO-ELEMENT (you cannot pick it in DevTools): ".chat-conv-msg.streaming .chat-conv-msg-text > :last-child::after" (and the ":empty::after" twin), a 1ch block in var(--accent-muted) breathing via the chatCaretBreathe keyframes. Retint via background, resize via width/height, retime via animation. html.cl-no-ambient (the user's ambient-motion switch) freezes it to solid; leave that override alone.
  The transcript's top edge fades under the header via a mask-image on .chat-conv-messages whose height is --cl-chat-fade; the BOTTOM edge deliberately has no fade (one would dim the newest message).

Chat prose registers (emitted by the chat producer, NOT by markdown alone):
  .cl-quote              Speech. Coloured by --cl-chat-speech.
  em.cl-narration        Narration. --cl-chat-narration. NOTE the inversion: marked-up text is DIMMER than plain body text; raising narration to match the body flattens the whole dialect.
  .cl-code-block         Fenced code, with the accent edge and a copy button. .cl-table-scroll wraps tables so a wide one pans instead of stealing the page scroll.
  .cl-reasoning          The thinking disclosure (<details>), .cl-reasoning-body its content. Marginalia: keep it quieter than the reply.
  A card's own font[color] or inline color beats the registers by design. Do not add rules that would win that back.

Chat panels (every one shares ONE shell, eleven today; restyle it once and they all follow):
  .cl-cwin / .cl-cwin-sheet / -header / -title / -name / -sep / -meta / -controls / -btn / -body   The window shell for every panel that opens inside a chat: prompt manager, connections, lorebooks, prompt inspector, gallery, background, personas, this chat's card, chat settings, assistant, the swipe combiner. The sheet carries the .cl-modal chrome (same border, triple shadow, scale settle) and its own font-family; the header carries the same soft accent duotone every .cl-modal-header has, with a gradient-clipped title glyph. .is-open on the layer is the open state, .cl-cwin-btn.is-close is the only control that goes red, .cl-cwin-btn.is-on is the accent-filled toggled state, and .fw-grip children are the resize edges. Restyle this shell, never ONE panel, or the panels drift apart. Geometry is per-panel (--fw-w/h/x/y written by JS) and is not yours to set: a width here is overridden the moment the user drags the window.
  .cl-cwin-row           The shared list-row surface (ghost-idle: faint plate, hover lift, .is-active is a flat accent tint + inset left rail). Panels add it beside their layout class (persona and connection rows carry it).
  .cl-cwin-tag (+ .is-accent)   The small uppercase tag a row or a field wears to say whose it is: neutral veil at rest, accent-tinted for the one that is this chat's (the persona set for this chat, a chat's own card text).
  .cl-cwin-inforce (+ .is-none)   The banner first in a window that holds a per-chat choice (personas, connections, the prompt manager): what is in force in this chat and whose choice it is, a flat accent tint held by a soft accent edge (> i its glyph, > div > strong the name, > div > span the why); .is-none mutes it when nothing is chosen.
  .cl-cwin-tabs / .cl-cwin-tab (+ .is-on)   A window's views: quiet buttons in a row under the header, the one shown accent-tinted (the background panel's Library / Gallery / Add, the chat card's Card texts / Author's note, Settings > General's View Defaults; defined in library.css).
  .cl-cwin-fold (.cl-cwin-fold-summary, .cl-cwin-fold-hint, .cl-cwin-fold-body)   A <details> fold in a window's form: the summary row (a chevron, the label, the hint naming what is inside) over the body. The lore editor's Advanced and the persona editors' Pronouns (the chat's Personas window and Settings > Chat; defined in library.css).
  .cl-cwin-tiles / .cl-cwin-tile (+ .is-active)   A window's grid of picture tiles: a 16:10 thumbnail cropped to fill, a ghost plate under it, a hairline border that lifts on hover and turns the accent on the chosen one (the background panel's wallpapers and gallery, the assistant's gallery shelf).
  .cl-cwin-empty / .cl-cwin-dim   The shared empty/loading/error state: glyph in a tinted chip (.is-error swaps it to the error tint), copy under it. Used by personas, connections, inspector, gallery, background.
  .cl-switch / .cl-switch-input   The sliding boolean switch (hidden checkbox + span; chat settings, prompt manager, lore panel, assistant settings). iOS proportions: a recessed 36x22 groove (--cl-veil-2 fill, --cl-veil-3 inset ring) that fills accent when on, with a knob (::after) that fills the height minus a 2px inset and stays BRIGHT in both states (--text-primary off, #fff on) over its own drop shadow; it stretches toward its destination while the row is held (label:active). Retheme via the track fill/checked background; keep the knob bright and near-full-height, or the control collapses back into the elongated-pill-with-a-pea look.
  .cl-range              The styled slider every panel range rides (background knobs, line length, assistant turns). The filled track reads --cl-range-fill (written by JS per input; do not set it), so retheme via the accent and --cl-ghost-mid rather than the gradient.
  .cl-cwin-btn-text (+ .is-primary / .is-danger)   The window family's text button: ghost at rest, ONE solid accent .is-primary per surface, .is-danger for destructive verbs.
  .cl-cwin-input-row + .cl-cwin-send (+ .is-stop)   The composer strip: a rounded field plate (radius-2xl) holding a borderless textarea between ghost circular controls that warm to the accent on hover. COUPLING GAP: both stop faces (.cl-cwin-send.is-stop and .cl-ai-send.is-stop) read var(--cl-error-pale) for the glyph but HARDCODE their soft red fill and border at rgba(229,115,115,*) (the pale tier's colour as a literal); retheming the error tier recolors the glyph and leaves the plate red, so retarget the .is-stop rules directly. The assistant and the swipe combiner both ride the strip; the plate's border takes --glass-border and its focus ring is a soft accent.
  .custom-select-container / .custom-select-trigger inside .cl-cwin   Every panel select is the app's custom select; the container carries the select's layout classes and the trigger stretches to fill it (scoped under .cl-cwin, so topbar selects stay content-sized). The trigger wears the .cl-cwin-input field's own inset, corner, type and height (the --cl-cwin-btn floor, the touch floor on a phone), so a box and a select in one form are one control: resize them together through .cl-cwin-input and the trigger rule beside it in chats.css, never one panel's.
  .cl-cwin-fieldrow      A row holding a field (the connection editor's key and model rows, the lore search row, the session toolbars): every button in it stands at the field's height and stretches to the row. Resize a row's buttons through the field, never on their own.
  Panel bodies keep their own prefixes; the load-bearing interior surfaces per panel:
    .cas-* assistant       .cas-msg one turn (.is-user / .is-assistant, .is-streaming while painting), children .cas-msg-head/-who/-time/-body and hover .cas-msg-btn actions. .cas-props is a reply's proposal tray (.cas-props-head, .cas-props-card), .cas-prop ONE proposed change (.cas-prop-head/-name/-op/-why, .cas-prop-preview, .cas-prop-act buttons, .cas-prop-pick checkbox); .cas-diff / .cas-diff-split is the side-by-side diff with .cas-diff-word-add/-del word marks. .cas-qp-chip saved-prompt chips over the composer, .cas-pick the character's gallery shelf over it (.cas-pick-head with .cas-pick-title and .cas-pick-count, .cas-pick-body scrolling the .cl-cwin-tiles, .cas-pick-check the mark on a picked tile), .cas-starter the empty-state suggestion buttons, .cas-nudge the "ask for proposals" chip.
    .cpm-* prompt manager  .cpm-list preset block rows (.cpm-head grip+name+.cpm-badge, .cpm-acts), .cpm-drawer the block editor drawer, .cpm-l1/.cpm-l2 the two-line row text.
    .clp-* lorebooks       .clp-book a bound book card (.clp-book-head/-name/-count), .clp-entry rows inside (.clp-status the state glyph, .clp-key key pills, .clp-tag engine-state tags), .clp-editor the entry editor, .clp-adv the Advanced fold (a .cl-cwin-fold).
    .cpi-* prompt inspector .cpi-msg one prompt part (.cpi-role-system/-user/-assistant tint its role rail), .cpi-find the search bar, .cpi-hit a search mark.
    .cgp-* gallery         .cgp-main the hero area (.cgp-main-media), .cgp-strip the film strip, .cgp-tile one thumb (.cgp-tile-video variant), .cgp-nav the prev/next arrows, .cgp-notes the caption drawer.
    .cbg-* background      the wallpaper cards ride .cl-cwin-tile (.cbg-tile-wrap holds one with its .cbg-tile-acts rail and .cbg-tile-badge use count), .cbg-knobs the fit/blur/dim control grid, .cbg-scope the this-chat/every-chat toggle, .cbg-drop the drop zone.
    .cpp-* personas        .cpp-row one persona (.cl-cwin-row underneath; .cpp-face avatar, .cpp-row-name/-desc), .cpp-editor the edit form, .cpp-book-pill linked-lorebook pills, .cpp-pronouns the pronouns fold, a .cl-cwin-fold drawn by Settings > Chat's persona editor too (.cpp-pronoun-presets the She/He/They/It/Custom plate over .cl-cwin-tab buttons, .cpp-pronoun-macro the macro beside each field's label).
    .cct-* this chat's card  .cct-tabs its two views (Card texts, Author's note), each a .cct-view of .cl-cwin-group cards; .cct-field-head label + .cl-cwin-tag over a card text, .cct-input the textareas, .cct-schedule the note's status line, .cct-foot each view's Cancel / Save bar under the scrolling body (.cct-foot-host).
    .ccm-* connections     rows also ride .cl-cwin-row; .ccm-editor hosts the shared connection editor (.ce-* in modules/connection-editor.css), whose fields ride .cl-cwin-input.
    .cl-cwin-group/-field  THE settings form family, every chat window's form (chat settings, the assistant's settings view and the rest): .cl-cwin-group card + .cl-cwin-group-title, .cl-cwin-field label-left/control-right, .cl-cwin-block control+.cl-cwin-hint, .cl-cwin-toggle whole-row switch rows, .cl-cwin-range sliders. An extension window's row (.cl-cwin-ext-row) is .cl-cwin-ext-id (.cl-cwin-ext-name + .cl-cwin-ext-owner, both ellipsizing) and .cl-cwin-ext-scopes (the Header and Phone switches); a phone stacks the two.
    .csw-* swipe combiner  .csw-chips the include/preview number chips (.csw-chip, .is-on state), .csw-preview the draft pane (.is-result once generated), .csw-foot the Back/Retry/Add row.
`.trim();

const EXAMPLE_OUTPUTS = `
EXAMPLE 1 (GLOBAL, request: "synthwave pink theme"):
\`\`\`css
/* Title: Synthwave Pink Theme */
:root {
    --accent: #ff2e93;
    --accent-rgb: 255, 46, 147;
    --accent-hover: #ff5cab;
    --accent-secondary: #00f0ff;
    --accent-secondary-rgb: 0, 240, 255;
    --bg-primary: #0a0014;
    --bg-secondary: #1a0a2e;
    --cl-sheet-bg: rgba(15, 0, 25, 0.9);
    --cl-glass-bg: rgba(20, 5, 35, 0.95);
    --text-primary: #fff5fb;
    --glass-border: rgba(255, 46, 147, 0.35);
}
body {
    background: radial-gradient(ellipse at top, #2a0a4e 0%, #0a0014 70%) fixed;
}
\`\`\`
Pink accent on deep purple, cyan secondary. --accent-hover is hardcoded (not derived from --accent-rgb), so it needs its own override alongside --accent / --accent-rgb. All three modal-background vars overridden so card-update + settings + module dialogs match. Text in module dialogs reads from --cl-text-primary (independent of --text-primary); override that var explicitly if a non-default text color is wanted there too.

EXAMPLE 2 (request: "make character cards more rounded and bigger"):
\`\`\`css
/* Title: Rounded Bigger Cards */
.char-card {
    border-radius: var(--radius-4xl);
    transform: scale(1.05);
    transition: transform 0.2s ease;
}
.char-card:hover {
    transform: scale(1.08) translateY(-3px);
    box-shadow: 0 12px 32px rgba(var(--accent-rgb), 0.25);
}
\`\`\`
Rounder corners and a subtle scale-up on hover.

EXAMPLE 3 (SCOPED, request: "make progress bars bright orange, plus some other elements too, without changing my accent color"):
\`\`\`css
/* Title: Orange Progress Accents */
.import-progress-fill,
.import-summary-progress-fill {
    background: linear-gradient(90deg, #ff6b00, #ffa726);
}
.cl-loading .cl-loading-icon svg,
.cl-spinner-inline i {
    color: #ff9500;
}
.cl-loading .cl-loading-bar span {
    background: linear-gradient(90deg, transparent 0%, #ff9500 50%, transparent 100%);
}
::-webkit-scrollbar-thumb {
    background: linear-gradient(180deg, #ff6b00 0%, var(--accent) 100%);
}
\`\`\`
Orange progress bar fills, spinner icons, indeterminate loader bar, and scrollbar. Direct selectors with direct colors, no :root overrides, so accent and status semantics are untouched.

WHY THE OBVIOUS APPROACH IS WRONG: a tempting answer would be "override --cl-warning to mean orange" (warnings look progress-shaped, after all). Resist this. --cl-warning drives every warning toast, gallery-fills callout, extraction-status banner, and tip lightbulb across the entire app. Hijacking it for orange progress bars repaints hundreds of unrelated surfaces. Similarly, "progress { ... }" matches nothing in CL: there are no native &lt;progress&gt; elements; all progress bars are custom div pairs (see CATALOGUE_COMPONENTS).
`.trim();

const SYSTEM_PROMPT = `You produce CSS snippets for Project Σ (CL below and in its cl- class prefixes), a self-hosted character manager. The user pastes your output into a custom CSS field that injects into a <style> tag at end of <head>.

${CATALOGUE_TOKENS}

${CATALOGUE_COMPONENTS}

${EXAMPLE_OUTPUTS}

SCOPE FRAMEWORK (apply BEFORE writing CSS):

Step 1, classify the request:
  GLOBAL retheme  → the user wants the whole app to look different ("synthwave theme", "make everything purple", "neon mode", "darker dark mode"). Override :root tokens.
  SCOPED change   → the user wants a specific element or feature to change ("orange progress bars", "round the avatar", "bigger character names", "glow on hover", "hide the badges"). Use direct selectors with direct values. Do NOT override :root tokens.
  MIXED iteration → a scoped change inside an existing themed snippet. Add direct rules; do NOT restate or modify the existing :root block.

Step 2, check for hard fences:
  Phrases like "without changing X", "keep my Y", "don't touch Z" are not preferences; they are constraints. Anything tied to X is off-limits, including INDIRECT couplings (e.g. if the user says "don't change the accent color" and you override --accent-rgb, you've broken the fence because --accent-glow is computed from --accent-rgb).

Step 3, note how semantic tokens propagate:
  --cl-success / --cl-error / --cl-warning / --cl-info (and their *-bright + *-rgb companions) drive every toast, banner, status icon, badge, and callout across the app. Overriding them rethemes status semantics globally, useful when that's what the user asked for ("make all my warnings cyan"). For a scoped color change ("make MY progress bars orange"), direct selectors are the cleaner tool (see Example 3).

OUTPUT FORMAT (strict):
1. Open with a single fenced \`\`\`css ... \`\`\` code block. No prose, no preamble before the code block.
2. The FIRST line inside the code block must be a title comment: /* Title: <2-5 words describing the snippet> */
   Examples: /* Title: Synthwave Pink Theme */ , /* Title: Rounded Bigger Cards */ , /* Title: Neon Hover Glow */
   The title is used as the snippet name when saved. Pick something descriptive of the visual effect, not the user's literal words.
3. After the code block, optionally one short sentence (max 20 words) summarizing the change. No more.
4. If the user's request is ambiguous AND you cannot make a reasonable default choice, ask ONE clarifying question instead of generating code. Otherwise pick sensible defaults and ship.

CSS RULES:

1. For a GLOBAL retheme, override :root tokens; they propagate coherently. For a SCOPED change, use direct selectors. See SCOPE FRAMEWORK above.

2. When changing the modal background (global theme only), override --cl-sheet-bg AND --bg-secondary AND --cl-glass-bg together. Three flavors of modal read from these three independent vars.

3. For a global accent retheme, override --accent / --accent-rgb (and --accent-hover, which is hardcoded). The module-dialog button family and all module CSS read the core --accent chain directly, so it carries through automatically. The --cl-* module-dialog family is surface/text only (see CATALOGUE_TOKENS).

4. Use rgba() and the *-rgb tokens (e.g. rgba(var(--accent-rgb), 0.3)) for translucent effects tied to the active theme. For one-off scoped colors that aren't theme-tied, raw rgba is fine.

5. Keep snippets under 2 KB. If the user wants more, ask whether to split into multiple snippets.

6. CSS only. No <script>, no <style> tags. @import and external url() are allowed but warn the user that they hit the network.

KNOWN GOTCHAS (avoid these failure modes):

1. Global accent retheme is a single chain. Override --accent + --accent-rgb (and --accent-hover, which is hardcoded, not derived):
     :root {
         --accent: #ff2e93;
         --accent-rgb: 255, 46, 147;
         --accent-hover: #ff5cab;
     }
   Module dialogs (.cl-btn, .cl-modal-content chrome, card-updates / batch-tagging / playlists / character-versions / context-menu) all read the core --accent / --accent-rgb / --accent-hover directly, so this carries through the whole app. There is no second accent chain to override.

2. Buttons get their visual identity from --accent (background, focus ring, glow). The --accent-glow token is computed from --accent-rgb at 30% alpha, so changing --accent-rgb automatically updates glows. Don't add direct rules like ".glass-btn { border: 1px solid ... }" for a global retheme; they stack messily with the built-in hover/focus styles. Direct rules are fine when you want a behavior tokens can't produce (e.g. a neon outer glow only on hover).

3. --accent-text is the text color shown ON a solid accent-colored background. If your --accent is pale, set --accent-text to a dark color for contrast. If --accent is dark, --accent-text should be light.

4. Catch-all substring attribute selectors are the trap to watch. ".cl-tag:not([class*='-success'])" looks like a clever way to target "info tags only" but actually matches every neutral .cl-tag in the app (character tags, lorebook tags, playlist labels, status pills). Use the actual class name (.cl-tag.cl-tag-info) or restrict by context (.recommender-result-card .cl-tag). This is specifically about substring matchers like [class*='X']; exact-attribute selectors like input[type='checkbox'] are fine and routinely needed.

5. Your CSS is the LAST stylesheet in the document, module sheets included: the loader inserts every module sheet ahead of the custom-CSS tag on purpose. So at equal specificity you win everywhere, in library.css and in modules/ alike, and !important is not needed just because a rule lives in a module. What still beats you is higher specificity: a module rule like ".chat-conv[data-mode='column'] .chat-conv-msg-body" outranks a bare ".chat-conv-msg-body" no matter who is later. Match or exceed the selector you are overriding and plain rules work; reach for !important when the existing rule already uses it (mobile chrome does, a lot) or when the property is set inline by JS. Module CSS files (20): custom-css, recommender, playlists, card-updates, command-palette, batch-tagging, tags-manager, batch-transfer, character-creator, creator-studio, character-versions, chats, connection-editor, personas, css-assistant, gallery-sync, gallery-viewer, multi-select, context-menu, lorebook-manager. Provider browse CSS files (7 with class prefixes): browse-shared, chub-browse, chartavern-browse, pygmalion-browse, datacat-browse, botbooru-browse, janitorai-browse. (Wyvern's CSS file holds a single [data-select-id] rule and otherwise inherits .browse-*. Janny has no CSS file; inherits from browse-shared. janitorai-browse holds only the lorebook head; everything else inherits .browse-*. The hosted browser's capability report in Settings > Online is core: .browser-check-list / .browser-check / .browser-check-label / .browser-check-detail in library.css.) Class-prefix map for the modules: .ccss-* (custom-css), .recommender-*, .pl-* (playlists), .card-update-*, .bt-* (batch-tagging), .tgm-* (tags-manager: the Tags Manager modal - windowed tag list rows .tgm-row, import-rule rows .tgm-rule-row, case-dupe pills .tgm-dupe-pill; accent-alpha hovers follow var(--accent-rgb)), .btx-* (batch-transfer: the bundle export/import modal), .creator-* (character-creator), .ccs-* (creator-studio), .vt-* (character-versions), .chat-*, .ce-* (connection-editor), .cpp-pronoun-* (personas: the pronouns block both persona editors draw), .css-assistant-*, .gallery-sync-* and .notif-* (gallery-sync: the notifications center, whose rows the media download queue draws too), .gv-* (gallery-viewer), .multi-select-* and .ms-*, .cl-context-menu-*, .cl-palette-* (command-palette: Search everything), .lb-* (lorebook-manager), .browse-*, .chub-*, .ct-* (chartavern), .pyg-* (pygmalion), .datacat-*, .botbooru-*, .janitorai-*. For library.css selectors (.char-card, .topbar, .glass-btn, .toast, .settings-*, .view-toggle, .tab-pane, .modal-glass, .modal-sidebar, .favorite-indicator, etc.), source order favors custom CSS so no !important is needed.

6. .toast.info reads from --accent, not --cl-info. Overriding --cl-info for a "blue info" semantic does NOT recolor info toasts. If a global theme needs info toasts to follow a non-accent color, target ".toast.info" directly with a !important rule on its border-color and ".toast.info .toast-icon" on the icon color.

7. Mobile mode (html.cl-mobile) disables hover transforms and backdrop-filter via "!important" rules in library-mobile.css. Hover-only styling silently no-ops on touch devices. If a theme effect needs to be visible on mobile, don't tie it to :hover alone. Desktop-only themes are fine; acknowledge the limitation if it matters.

8. Custom CSS applies on all viewports. Scope rules under "html.cl-mobile" for mobile-specific behavior (the app's mobile-mode class: set on small screens, touch-first devices like tablets, or by the user's Mobile Layout setting), or "html:not(.cl-mobile)" for desktop-only. Prefer the class over width-based @media queries: width queries miss tablets and users who force mobile mode. Layout-heavy themes (changing card sizes, repositioning the topbar) often need explicit mobile handling.

9. Theme coherence on mobile. Mobile chrome is a fully separate surface (the topbar disappears; the persistent UI is .mobile-bottom-nav at the bottom plus .mobile-fab, bottom sheets, and overlays). A global retheme that only paints desktop chrome leaves these mobile-only surfaces looking off-brand. Most .mobile-* selectors (CATALOGUE_COMPONENTS → Mobile chrome) pick up token overrides automatically, but a few want explicit rules scoped under "html.cl-mobile" to feel coherent in mobile mode: .mobile-fab (a translucent accent tint in the default glass buttonStyle, the accent gradient in solid), the .mobile-bottom-nav surface (the phone material) and its .mobile-bottom-nav-tab.active accent stripe, and the .mobile-quick-import-btn[data-state] color states. For any non-trivial global theme, include a small mobile block that re-applies the same visual identity to these elements.

CONVERSATION:
- The user can iterate: "make it more red", "add a glow on hover", etc. Modify the previous code block rather than restarting.
- If something cannot be done with CSS alone (logic, conditional content), say so plainly in one sentence.`;

// ========================================
// MODULE STATE
// ========================================

let modalInjected = false;
// Conversation messages: { role, content }. First entry is the system prompt.
let conversation = [];
// Wand snapshot attached to the next user message; consumed once.
let pendingContext = null;
// Sticky reference to the snippet being iterated on. Enables the "Update X" button.
let iterationSnippetId = null;
let iterationSnippetName = '';
let aiConn = null;
let activeSource = '';
let activeModel = '';
let abortController = null;

// ========================================
// LLM CALL
// ========================================

function getSelectedProfile() {
    return aiConn?.getProfile?.() || null;
}

async function loadProfiles() {
    const host = document.getElementById('cssAssistantAiConn');
    if (!host) return;

    try {
        if (!aiConn) {
            aiConn = await CoreAPI.mountAiConnectionBlock(host, {
                surface: 'cssAssistant',
                layout: 'row',
                panelHost: document.getElementById('cssAssistantAiConnPanel'),
            });
        } else {
            await aiConn.refresh();
        }
        const s = aiConn?.getSettings?.();
        if (!s || s.error) throw new Error('Settings fetch failed');
        activeSource = s.activeSource;
        activeModel = s.activeModel || '';
    } catch (err) {
        console.error('[CSSAssistant] loadProfiles failed:', err);
    }
}

// Delegates the request/proxy/parse to the shared client. checkFinishReason preserves the
// explicit token-truncation error; a non-JSON answer throws.
function callLlmApi(messages, signal) {
    return CoreAPI.callLLM(messages, {
        profile: getSelectedProfile(),
        activeSource, activeModel,
        // null = omit: the connection decides, tuned per surface via the block overrides
        // (the old forced 0.7/6000 overrode whatever the user set on the profile)
        temperature: null, maxTokens: null, params: aiConn?.getParams?.(), signal,
        checkFinishReason: true, debugTag: 'CSSAssistant',
    });
}

// ========================================
// CSS BLOCK EXTRACTION
// ========================================

// Tolerant fenced-block extractor: ```css or ```, closed or truncated, leading whitespace.
function extractCssBlock(text) {
    if (typeof text !== 'string') return null;

    const closedCss = text.match(/```css\s*\n([\s\S]*?)```/i);
    if (closedCss) return closedCss[1].trim();

    const closedAny = text.match(/```[a-z]*\s*\n([\s\S]*?)```/i);
    if (closedAny) {
        const body = closedAny[1].trim();
        if (/[.#:@][\w-]*\s*\{/.test(body) || /^[\w-]+\s*:/.test(body)) return body;
    }

    // Unclosed fence: truncated response, grab from open to end.
    const openCss = text.match(/```css\s*\n([\s\S]*)$/i);
    if (openCss) return openCss[1].trim();

    const openAny = text.match(/```[a-z]*\s*\n([\s\S]*)$/i);
    if (openAny) {
        const body = openAny[1].trim();
        if (/[.#:@][\w-]*\s*\{/.test(body) || /^[\w-]+\s*:/.test(body)) return body;
    }

    return null;
}

function extractSnippetTitle(css) {
    if (typeof css !== 'string') return null;
    const m = css.match(/\/\*\s*Title\s*:\s*(.+?)\s*\*\//i);
    if (m) {
        const title = m[1].trim().slice(0, 60);
        if (title) return title;
    }
    return null;
}

function heuristicSnippetTitle(css) {
    if (typeof css !== 'string' || !css.trim()) return 'AI Snippet';
    const lower = css.toLowerCase();
    const hasRoot = /:root\s*\{/.test(lower);
    const hasBg = /--bg-primary|--bg-secondary|--cl-sheet-bg|background\s*:/.test(lower);
    const hasAccent = /--accent\s*:|--accent-rgb/.test(lower);
    const hasCard = /\.char-card/.test(lower);
    const hasButton = /\.glass-btn|\.cl-btn/.test(lower);
    const hasHover = /:hover/.test(lower);
    if (hasRoot && hasBg && hasAccent) return 'Custom Theme';
    if (hasRoot && hasAccent) return 'Accent Override';
    if (hasCard && hasHover) return 'Card Hover Effect';
    if (hasCard) return 'Card Style';
    if (hasButton) return 'Button Style';
    return 'AI Snippet';
}

function snippetNameFromCss(css) {
    return extractSnippetTitle(css) || heuristicSnippetTitle(css);
}

// ========================================
// MODAL HTML
// ========================================

function buildModalHTML() {
    return `
    <div class="cl-modal css-assistant-modal" id="cssAssistantModal">
        <div class="cl-modal-content">
            <div class="cl-modal-header">
                <h3><i class="fa-solid fa-wand-magic-sparkles"></i> CSS Assistant</h3>
                <button class="cl-modal-close" id="cssAssistantCloseBtn" title="Close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cl-modal-body css-assistant-body">
                <div class="css-assistant-toolbar">
                    <div class="css-assistant-profile-row">
                        <label>Connection</label>
                        <div id="cssAssistantAiConn"></div>
                    </div>
                    <button class="cl-btn cl-btn-sm cl-btn-secondary css-assistant-reset-btn" id="cssAssistantResetBtn" title="Start a new conversation"><i class="fa-solid fa-rotate-left"></i> Reset</button>
                </div>
                <div id="cssAssistantAiConnPanel"></div>
                <div class="css-assistant-context-banner" id="cssAssistantContextBanner" hidden>
                    <i class="fa-solid fa-link"></i>
                    <span class="css-assistant-context-text">Iterating on snippet <strong id="cssAssistantContextName"></strong>. Its current CSS will be attached to your next message.</span>
                    <button class="css-assistant-context-dismiss" id="cssAssistantContextDismiss" title="Discard context (fresh chat)"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="css-assistant-chat" id="cssAssistantChat"></div>
                <div class="cl-ai-empty css-assistant-empty" id="cssAssistantEmpty">
                    <i class="fa-solid fa-comments"></i>
                    <p>Describe the look you want. Examples:</p>
                    <ul>
                        <li>"Pink synthwave theme with glowing accents"</li>
                        <li>"Make character cards round and bigger"</li>
                        <li>"Replace every checkmark with a star emoji on every checkbox"</li>
                    </ul>
                </div>
            </div>
            <div class="cl-modal-footer css-assistant-footer">
                <div class="cl-ai-composer">
                    <textarea id="cssAssistantInput" class="cl-ai-composer-input" placeholder="Describe a UI tweak (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
                    <button type="button" class="cl-ai-send" id="cssAssistantSendBtn" title="Send">
                        <i class="fa-solid fa-arrow-up"></i>
                    </button>
                    <button type="button" class="cl-ai-send is-stop cl-hidden" id="cssAssistantCancelBtn" title="Stop">
                        <i class="fa-solid fa-stop"></i>
                    </button>
                </div>
            </div>
        </div>
    </div>`;
}

// ========================================
// CHAT RENDERING
// ========================================

function renderAssistantMessage(content, messageIndex) {
    const cssBlock = extractCssBlock(content);
    if (!cssBlock) {
        return `<div class="css-assistant-msg-text">${renderMarkdownLite(content)}</div>`;
    }
    const prose = content.replace(/```css\s*\n[\s\S]*?```/i, '').replace(/```\s*\n[\s\S]*?```/i, '').trim();
    const updateBtn = iterationSnippetId
        ? `<button class="cl-btn cl-btn-sm cl-btn-primary css-assistant-update-snippet" data-msg-index="${messageIndex}" title="Replace the current snippet with this CSS"><i class="fa-solid fa-floppy-disk"></i> Update &ldquo;${CoreAPI.escapeHtml(iterationSnippetName)}&rdquo;</button>`
        : '';
    const addBtnVariant = iterationSnippetId ? 'cl-btn-secondary' : 'cl-btn-primary';
    return `
        ${prose ? `<div class="css-assistant-msg-text">${renderMarkdownLite(prose)}</div>` : ''}
        <div class="css-assistant-code-wrap">
            <pre class="css-assistant-code"><code>${CoreAPI.escapeHtml(cssBlock)}</code></pre>
            <div class="css-assistant-code-actions">
                <button class="cl-btn cl-btn-sm cl-btn-secondary css-assistant-copy" data-msg-index="${messageIndex}" title="Copy CSS"><i class="fa-solid fa-copy"></i> Copy</button>
                <button class="cl-btn cl-btn-sm ${addBtnVariant} css-assistant-add-snippet" data-msg-index="${messageIndex}"><i class="fa-solid fa-plus"></i> Save as New</button>
                ${updateBtn}
            </div>
        </div>
    `;
}

function renderMarkdownLite(text) {
    let html = CoreAPI.escapeHtml(text);
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
    return html;
}

function renderChat() {
    const chatEl = document.getElementById('cssAssistantChat');
    const emptyEl = document.getElementById('cssAssistantEmpty');
    if (!chatEl || !emptyEl) return;
    const userMessages = conversation.filter(m => m.role === 'user');
    emptyEl.hidden = userMessages.length > 0;

    const visible = conversation.filter(m => m.role !== 'system');
    chatEl.innerHTML = visible.map((msg, idx) => {
        const conversationIndex = conversation.indexOf(msg);
        if (msg.role === 'user') {
            return `
                <div class="css-assistant-msg user">
                    <div class="css-assistant-msg-role"><i class="fa-solid fa-user"></i> You</div>
                    <div class="css-assistant-msg-text">${renderMarkdownLite(msg.content)}</div>
                </div>
            `;
        }
        return `
            <div class="css-assistant-msg assistant">
                <div class="css-assistant-msg-role"><i class="fa-solid fa-wand-magic-sparkles"></i> Assistant</div>
                ${renderAssistantMessage(msg.content, conversationIndex)}
            </div>
        `;
    }).join('');

    chatEl.scrollTop = chatEl.scrollHeight;
}

function renderThinking() {
    const chatEl = document.getElementById('cssAssistantChat');
    if (!chatEl) return;
    const ind = document.createElement('div');
    ind.className = 'css-assistant-msg assistant thinking';
    ind.id = 'cssAssistantThinking';
    ind.innerHTML = `
        <div class="css-assistant-msg-role"><i class="fa-solid fa-wand-magic-sparkles"></i> Assistant</div>
        <div class="css-assistant-thinking-dots"><span></span><span></span><span></span></div>
    `;
    chatEl.appendChild(ind);
    chatEl.scrollTop = chatEl.scrollHeight;
}

function removeThinking() {
    document.getElementById('cssAssistantThinking')?.remove();
}

// ========================================
// SEND FLOW
// ========================================

function ensureSystemPrompt() {
    if (conversation.length === 0 || conversation[0].role !== 'system') {
        conversation.unshift({ role: 'system', content: SYSTEM_PROMPT });
    }
}

function setPendingContext(ctx) {
    pendingContext = ctx;
    const banner = document.getElementById('cssAssistantContextBanner');
    const nameEl = document.getElementById('cssAssistantContextName');
    if (!banner || !nameEl) return;
    if (ctx) {
        nameEl.textContent = ctx.name || 'Untitled';
        banner.hidden = false;
    } else {
        banner.hidden = true;
    }
}

function setBusy(busy) {
    const sendBtn = document.getElementById('cssAssistantSendBtn');
    const cancelBtn = document.getElementById('cssAssistantCancelBtn');
    const input = document.getElementById('cssAssistantInput');
    if (input) input.disabled = busy;
    // Use class not [hidden] because .cl-btn sets display:inline-flex.
    if (sendBtn) sendBtn.classList.toggle('cl-hidden', busy);
    if (cancelBtn) cancelBtn.classList.toggle('cl-hidden', !busy);
}

async function sendMessage() {
    const input = document.getElementById('cssAssistantInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input._autoGrow?.();

    ensureSystemPrompt();

    // Attach snippet snapshot to the first user message after a wand-open, then clearit.
    let userContent = text;
    if (pendingContext) {
        const ctxBlock = `Current snippet "${pendingContext.name || 'Untitled'}":\n\n\`\`\`css\n${pendingContext.css || '(empty)'}\n\`\`\`\n\nUser request:\n${text}`;
        userContent = ctxBlock;
        setPendingContext(null);
    }

    conversation.push({ role: 'user', content: userContent });
    renderChat();

    setBusy(true);
    renderThinking();
    abortController = new AbortController();

    try {
        const reply = await callLlmApi(conversation, abortController.signal);
        removeThinking();
        CoreAPI.debugLog('[CSSAssistant] Reply:', reply);
        if (!reply || !reply.trim()) {
            CoreAPI.showToast('Model returned empty response. It may be overloaded or the request too large. Try again.', 'warning', 4000);
            conversation.pop();
        } else {
            conversation.push({ role: 'assistant', content: reply });
        }
        renderChat();
    } catch (err) {
        removeThinking();
        conversation.pop();
        if (!err.isCancelled) {
            console.error('[CSSAssistant] send failed:', err);
            CoreAPI.showToast(err.message || 'Generation failed', 'error');
            if (input) input.value = text;
        }
        renderChat();
    } finally {
        abortController = null;
        setBusy(false);
    }
}

function cancelSend() {
    abortController?.abort();
}

async function resetConversation() {
    if (conversation.filter(m => m.role !== 'system').length === 0) {
        CoreAPI.showToast('Conversation is already empty', 'info', 1500);
        return;
    }
    if (!(await CoreAPI.showConfirm({ title: 'Reset conversation', message: 'This clears all messages in this session.', confirmLabel: 'Reset', danger: true }))) return;
    conversation = [];
    iterationSnippetId = null;
    iterationSnippetName = '';
    setPendingContext(null);
    renderChat();
}

// ========================================
// ADD AS SNIPPET
// ========================================

async function addAsSnippet(messageIndex) {
    const msg = conversation[messageIndex];
    if (!msg || msg.role !== 'assistant') return;
    const css = extractCssBlock(msg.content);
    if (!css) {
        CoreAPI.showToast('No CSS block found in this message', 'warning');
        return;
    }
    const name = snippetNameFromCss(css);
    const body = stripTitleComment(css);
    // null: unread or not saved, and the snippet store has said which
    if (!(await createSnippet({ name, css: body, enabled: false }))) return;
    renderCustomCssSidebar();
    setSnippetsDirty(true);
    CoreAPI.showToast(`Snippet "${name}" added`, 'success', 2000);
}

function stripTitleComment(css) {
    if (typeof css !== 'string') return '';
    return css.replace(/^\s*\/\*\s*Title\s*:.*?\*\/\s*\n?/i, '');
}

async function updateIterationSnippet(messageIndex) {
    if (!iterationSnippetId) return;
    const msg = conversation[messageIndex];
    if (!msg || msg.role !== 'assistant') return;
    const css = extractCssBlock(msg.content);
    if (!css) {
        CoreAPI.showToast('No CSS block found in this message', 'warning');
        return;
    }
    // Could have been deleted in another modal; an unread collection is not a deleted snippet.
    const data = await loadSnippets();
    if (!data) {
        CoreAPI.showToast('Snippets could not be read from the server; the snippet was not updated', 'error');
        return;
    }
    const snippet = data.snippets.find(s => s.id === iterationSnippetId);
    if (!snippet) {
        if (!(await createSnippet({ name: iterationSnippetName || snippetNameFromCss(css), css: stripTitleComment(css), enabled: false }))) return;
        CoreAPI.showToast(`Snippet "${iterationSnippetName}" no longer exists. Saved as new instead.`, 'warning', 3000);
        iterationSnippetId = null;
        iterationSnippetName = '';
        renderChat();
        renderCustomCssSidebar();
        setSnippetsDirty(true);
        return;
    }
    if (!(await CoreAPI.showConfirm({ title: 'Replace snippet CSS', message: `Replace the CSS in "${snippet.name || 'Untitled'}" with this new version? The previous CSS will be overwritten.`, confirmLabel: 'Replace', danger: true }))) return;
    if (!(await updateSnippet(iterationSnippetId, { css: stripTitleComment(css) }))) return;
    renderCustomCssSidebar();
    setSnippetsDirty(true);
    try {
        if (getActiveSnippetId() === iterationSnippetId) loadSnippetIntoEditor(iterationSnippetId);
    } catch { /* custom-css editor not open, nothing to refresh */ }
    CoreAPI.showToast(`Snippet "${snippet.name}" updated`, 'success', 2000);
}

// ========================================
// MODAL LIFECYCLE
// ========================================

function injectModal() {
    if (modalInjected) return;
    modalInjected = true;
    document.body.insertAdjacentHTML('beforeend', buildModalHTML());

    const modal = document.getElementById('cssAssistantModal');
    CoreAPI.mountDialogSizing(modal);
    document.getElementById('cssAssistantCloseBtn').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    const input = document.getElementById('cssAssistantInput');
    // Shorter hint on mobile, re-synced on live mode flips since injectModal only runs once.
    const desktopPlaceholder = input.placeholder;
    const syncPlaceholder = () => {
        input.placeholder = CoreAPI.isMobileMode() ? 'Describe a UI tweak' : desktopPlaceholder;
    };
    syncPlaceholder();
    document.addEventListener('cl-mobile-mode-change', syncPlaceholder);
    const autoGrowInput = () => CoreAPI.fitTextarea(input);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    input.addEventListener('input', autoGrowInput);
    input._autoGrow = autoGrowInput;
    document.getElementById('cssAssistantSendBtn').addEventListener('click', sendMessage);
    document.getElementById('cssAssistantCancelBtn').addEventListener('click', cancelSend);
    document.getElementById('cssAssistantResetBtn').addEventListener('click', resetConversation);
    document.getElementById('cssAssistantContextDismiss').addEventListener('click', () => setPendingContext(null));

    const chatEl = document.getElementById('cssAssistantChat');
    chatEl.addEventListener('click', async (e) => {
        const copyBtn = e.target.closest('.css-assistant-copy');
        if (copyBtn) {
            const idx = parseInt(copyBtn.dataset.msgIndex, 10);
            const msg = conversation[idx];
            const css = msg ? extractCssBlock(msg.content) : null;
            if (css) {
                if (await CoreAPI.copyTextToClipboard(css)) CoreAPI.showToast('CSS copied to clipboard', 'success', 1500);
                else CoreAPI.showToast('Clipboard write blocked by browser', 'warning');
            }
            return;
        }
        const addBtn = e.target.closest('.css-assistant-add-snippet');
        if (addBtn) {
            const idx = parseInt(addBtn.dataset.msgIndex, 10);
            await addAsSnippet(idx);
            return;
        }
        const updateBtn = e.target.closest('.css-assistant-update-snippet');
        if (updateBtn) {
            const idx = parseInt(updateBtn.dataset.msgIndex, 10);
            await updateIterationSnippet(idx);
            return;
        }
    });

    window.registerOverlay?.({
        id: 'cssAssistantModal',
        tier: 4,
        close: () => closeModal(),
        visible: (el) => el.classList.contains('visible'),
    });
}

async function openModal(opts = {}) {
    injectModal();
    await loadProfiles();

    if (opts && opts.snippetId) {
        // Wand on a different snippet starts a fresh chat; same snippet preserves history.
        if (iterationSnippetId && iterationSnippetId !== opts.snippetId) {
            conversation = [];
        }
        try {
            const data = await loadSnippets();
            const snippet = data?.snippets?.find(s => s.id === opts.snippetId);
            if (snippet) {
                setPendingContext({
                    snippetId: snippet.id,
                    name: snippet.name,
                    css: snippet.css || '',
                });
                iterationSnippetId = snippet.id;
                iterationSnippetName = snippet.name || 'Untitled';
            } else {
                setPendingContext(null);
                iterationSnippetId = null;
                iterationSnippetName = '';
            }
        } catch (err) {
            console.warn('[CSSAssistant] Failed to load snippet for context:', err);
            setPendingContext(null);
            iterationSnippetId = null;
            iterationSnippetName = '';
        }
    } else {
        setPendingContext(null);
        iterationSnippetId = null;
        iterationSnippetName = '';
    }

    renderChat();
    document.getElementById('cssAssistantModal').classList.add('visible');
    setTimeout(() => document.getElementById('cssAssistantInput')?.focus(), 50);
}

function closeModal() {
    document.getElementById('cssAssistantModal')?.classList.remove('visible');
}

function init() {}

export { openModal, closeModal };
export default { init, openModal, closeModal };
