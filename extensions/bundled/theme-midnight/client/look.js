// Midnight's look: each choice, its values (the default first) and the root class each writes; pure, for node.

/**
 * @typedef {{ value: string, cls: string, label: string, icon: string }} LookValue
 * @typedef {{ key: string, group: 'layout' | 'type' | 'motion', label: string, hint: string, desktop?: boolean, values: LookValue[] }} LookOption
 */

/** @type {LookOption[]} */
export const LOOK = [
    {
        key: 'nav', group: 'layout', label: 'Navigation', desktop: true,
        hint: 'A slim rail down the left edge holds the brand and the views, or they sit in the top bar as they do without the theme. Phones keep their dock.',
        values: [
            { value: 'rail', cls: 'mn-nav-rail', label: 'Left rail', icon: 'fa-solid fa-table-columns' },
            { value: 'top', cls: 'mn-nav-top', label: 'Top bar', icon: 'fa-solid fa-window-maximize' },
        ],
    },
    {
        key: 'bar', group: 'layout', label: 'Top bar', desktop: true,
        hint: 'The search and filters float in a rounded capsule, or run as a bar docked to the top edge.',
        values: [
            { value: 'capsule', cls: 'mn-bar-capsule', label: 'Floating capsule', icon: 'fa-solid fa-capsules' },
            { value: 'docked', cls: 'mn-bar-docked', label: 'Docked', icon: 'fa-solid fa-grip-lines' },
        ],
    },
    {
        key: 'tiles', group: 'layout', label: 'Grid tiles',
        hint: 'Each portrait in a window with its name on a plate below, or the portrait filling the tile with the name over it.',
        values: [
            { value: 'window', cls: 'mn-tiles-window', label: 'Windows', icon: 'fa-solid fa-dungeon' },
            { value: 'bleed', cls: 'mn-tiles-bleed', label: 'Full-bleed', icon: 'fa-solid fa-image' },
        ],
    },
    {
        key: 'frame', group: 'layout', label: 'Window shape',
        hint: 'The top of each window: an arch, rounded corners, or square corners.',
        values: [
            { value: 'arch', cls: 'mn-frame-arch', label: 'Arch', icon: 'fa-solid fa-archway' },
            { value: 'round', cls: 'mn-frame-round', label: 'Rounded', icon: 'fa-solid fa-square' },
            { value: 'square', cls: 'mn-frame-square', label: 'Square', icon: 'fa-solid fa-vector-square' },
        ],
    },
    {
        key: 'names', group: 'layout', label: 'Names on tiles',
        hint: 'Always show each name, or follow the app\'s own setting, which can reveal names and tags on hover.',
        values: [
            { value: 'always', cls: 'mn-names-always', label: 'Always', icon: 'fa-solid fa-font' },
            { value: 'app', cls: 'mn-names-app', label: 'As the app shows them', icon: 'fa-solid fa-arrow-pointer' },
        ],
    },
    {
        key: 'chat', group: 'layout', label: 'Conversation',
        hint: 'Replies set on the night under their speaker\'s name with your turns in glass capsules, every message on a glass bubble, or the app\'s own message plates.',
        values: [
            { value: 'editorial', cls: 'mn-chat-editorial', label: 'Editorial', icon: 'fa-solid fa-feather' },
            { value: 'bubbles', cls: 'mn-chat-bubbles', label: 'Glass bubbles', icon: 'fa-solid fa-comment' },
            { value: 'app', cls: 'mn-chat-app', label: 'The app\'s own plates', icon: 'fa-solid fa-comments' },
        ],
    },
    {
        key: 'hero', group: 'layout', label: 'Character details',
        hint: 'A character\'s details open on a banner of their portrait\'s light with the name set large, or on a plain header.',
        values: [
            { value: 'on', cls: 'mn-hero-on', label: 'Hero banner', icon: 'fa-solid fa-panorama' },
            { value: 'off', cls: 'mn-hero-off', label: 'Plain header', icon: 'fa-solid fa-heading' },
        ],
    },
    {
        key: 'font', group: 'type', label: 'Display face',
        hint: 'The face for names and headings: Marcellus, a serif your system has, or the app\'s own face.',
        values: [
            { value: 'marcellus', cls: 'mn-font-marcellus', label: 'Marcellus', icon: 'fa-solid fa-feather-pointed' },
            { value: 'serif', cls: 'mn-font-serif', label: 'System serif', icon: 'fa-solid fa-font' },
            { value: 'app', cls: 'mn-font-app', label: 'The app\'s own', icon: 'fa-solid fa-text-height' },
        ],
    },
    {
        key: 'corners', group: 'type', label: 'Corners',
        hint: 'Soft, generous corners, or crisp, tight ones on every panel, button and field.',
        values: [
            { value: 'soft', cls: 'mn-corners-soft', label: 'Soft', icon: 'fa-solid fa-circle' },
            { value: 'crisp', cls: 'mn-corners-crisp', label: 'Crisp', icon: 'fa-solid fa-square' },
        ],
    },
    {
        key: 'motion', group: 'motion', label: 'Motion',
        hint: 'Full motion with shooting stars, a gentler sky at half speed, or everything still. When your system asks for less motion it stays still.',
        values: [
            { value: 'full', cls: 'mn-motion-full', label: 'Full', icon: 'fa-solid fa-wind' },
            { value: 'gentle', cls: 'mn-motion-gentle', label: 'Gentle', icon: 'fa-solid fa-feather' },
            { value: 'off', cls: 'mn-motion-off', label: 'Off', icon: 'fa-solid fa-pause' },
        ],
    },
    {
        key: 'lift', group: 'motion', label: 'Hover lift',
        hint: 'Tiles and cards rise under the pointer, or stay where they are.',
        values: [
            { value: 'on', cls: 'mn-lift-on', label: 'On', icon: 'fa-solid fa-arrow-up' },
            { value: 'off', cls: 'mn-lift-off', label: 'Off', icon: 'fa-solid fa-minus' },
        ],
    },
];

export const LOOK_KEYS = LOOK.map(o => o.key);
export const LOOK_DEFAULTS = Object.fromEntries(LOOK.map(o => [o.key, o.values[0].value]));

/** The look as set, an unknown or missing value read as its default. */
export function lookOf(get) {
    return Object.fromEntries(LOOK.map(o => {
        const v = String(get(o.key) ?? '');
        return [o.key, o.values.some(x => x.value === v) ? v : o.values[0].value];
    }));
}

/** The root classes a look writes, one a key; motion is still whenever the system asks for less of it. */
export function lookClasses(look, { reduced = false } = {}) {
    return LOOK.map(o => o.values.find(v => v.value === (o.key === 'motion' && reduced ? 'off' : look[o.key]))?.cls || o.values[0].cls);
}
