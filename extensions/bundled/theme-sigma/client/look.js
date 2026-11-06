// SPDX-License-Identifier: MIT

// Σ's look: each choice, its values (the default first) and the root class each writes; pure, for node.

/**
 * @typedef {{ value: string, cls: string, label: string, icon: string }} LookValue
 * @typedef {{ key: string, group: 'layout' | 'type' | 'motion', label: string, hint: string, desktop?: boolean, values: LookValue[] }} LookOption
 */

/** @type {LookOption[]} */
export const LOOK = [
    {
        key: 'nav', group: 'layout', label: 'Navigation', desktop: true,
        hint: 'The views sit in the bar along the top, or run down a slim rail at the left edge. Phones keep their dock.',
        values: [
            { value: 'bar', cls: 'sx-nav-bar', label: 'Top bar', icon: 'fa-solid fa-window-maximize' },
            { value: 'rail', cls: 'sx-nav-rail', label: 'Left rail', icon: 'fa-solid fa-table-columns' },
        ],
    },
    {
        key: 'tiles', group: 'layout', label: 'Grid tiles',
        hint: 'Each portrait with its name and tags set on its lower edge, or the app\'s own tiles.',
        values: [
            { value: 'sigma', cls: 'sx-tiles-sigma', label: 'Σ tiles', icon: 'fa-solid fa-id-badge' },
            { value: 'app', cls: 'sx-tiles-app', label: 'The app\'s own', icon: 'fa-solid fa-image' },
        ],
    },
    {
        key: 'names', group: 'layout', label: 'Names on tiles',
        hint: 'Always show each name and its tags, or follow the app\'s own setting, which can reveal them on hover.',
        values: [
            { value: 'always', cls: 'sx-names-always', label: 'Always', icon: 'fa-solid fa-font' },
            { value: 'app', cls: 'sx-names-app', label: 'As the app shows them', icon: 'fa-solid fa-arrow-pointer' },
        ],
    },
    {
        key: 'chat', group: 'layout', label: 'Conversation',
        hint: 'Every message on a card of its own, replies set open on the page with your turns in bubbles at the right, or the app\'s own plates.',
        values: [
            { value: 'cards', cls: 'sx-chat-cards', label: 'Cards', icon: 'fa-solid fa-table-list' },
            { value: 'open', cls: 'sx-chat-open', label: 'Open', icon: 'fa-solid fa-align-left' },
            { value: 'app', cls: 'sx-chat-app', label: 'The app\'s own plates', icon: 'fa-solid fa-comments' },
        ],
    },
    {
        key: 'hero', group: 'layout', label: 'Character details',
        hint: 'A character\'s details open under a banner lit by their portrait with the name set large, or on a plain header.',
        values: [
            { value: 'on', cls: 'sx-hero-on', label: 'Hero banner', icon: 'fa-solid fa-panorama' },
            { value: 'off', cls: 'sx-hero-off', label: 'Plain header', icon: 'fa-solid fa-heading' },
        ],
    },
    {
        key: 'font', group: 'type', label: 'Typeface',
        hint: 'Inter throughout, the face the app\'s chat windows already use, or the app\'s own face everywhere.',
        values: [
            { value: 'inter', cls: 'sx-font-inter', label: 'Inter', icon: 'fa-solid fa-font' },
            { value: 'app', cls: 'sx-font-app', label: 'The app\'s own', icon: 'fa-solid fa-text-height' },
        ],
    },
    {
        key: 'corners', group: 'type', label: 'Corners',
        hint: 'Rounded corners on tiles, dialogs and windows, or tighter ones.',
        values: [
            { value: 'round', cls: 'sx-corners-round', label: 'Rounded', icon: 'fa-solid fa-circle' },
            { value: 'tight', cls: 'sx-corners-tight', label: 'Tight', icon: 'fa-solid fa-square' },
        ],
    },
    {
        key: 'motion', group: 'motion', label: 'Motion',
        hint: 'The field\'s light drifts slowly, drifts at half speed, or holds still. When your system asks for less motion it stays still.',
        values: [
            { value: 'full', cls: 'sx-motion-full', label: 'Full', icon: 'fa-solid fa-wind' },
            { value: 'gentle', cls: 'sx-motion-gentle', label: 'Gentle', icon: 'fa-solid fa-feather' },
            { value: 'off', cls: 'sx-motion-off', label: 'Off', icon: 'fa-solid fa-pause' },
        ],
    },
    {
        key: 'lift', group: 'motion', label: 'Hover lift',
        hint: 'Tiles and cards rise a little under the pointer, or stay where they are.',
        values: [
            { value: 'on', cls: 'sx-lift-on', label: 'On', icon: 'fa-solid fa-arrow-up' },
            { value: 'off', cls: 'sx-lift-off', label: 'Off', icon: 'fa-solid fa-minus' },
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
