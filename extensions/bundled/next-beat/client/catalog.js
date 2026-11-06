// SPDX-License-Identifier: MIT

// Inspired by Pathweaver for SillyTavern by mattjaybe (MIT); thanks to its author.

// Next Beat's built-in directions and genres, a reader's style icons and the settings' ranges, loaded by both halves.

// each is a kind of move the story can make; the answer's shape is the server's own and no style can change it
export const STORY = Object.freeze([
    {
        key: 'crossroads', name: 'Crossroads', icon: 'fa-signs-post',
        prompt: 'Give the reader a real choice of road: make every suggestion a different kind of move. One presses the story forward, one slows it down for the characters, one brings something hidden to light, one lets the outside world in, one moves the clock on. No two should read as versions of each other.',
    },
    {
        key: 'stakes', name: 'Raise the Stakes', icon: 'fa-arrow-trend-up',
        prompt: 'Make the cost of failing bigger or nearer: a deadline closes in, a threat finds the characters, a choice suddenly costs something, a small problem turns serious. Build each one out of what is already in play rather than out of nowhere.',
    },
    {
        key: 'breather', name: 'Quiet Beat', icon: 'fa-mug-hot',
        prompt: 'Slow down for a moment that belongs to the characters themselves: a conversation they have been putting off, a shared meal, a memory surfacing, a small kindness or a joke between them. Nothing needs solving; something should be felt.',
    },
    {
        key: 'reveal', name: 'Reveal', icon: 'fa-key',
        prompt: 'Bring something hidden into the open: what someone truly wants, a lie coming apart, a piece of the past, an object that is not what it seemed. Each reveal should change how the reader sees what has already happened.',
    },
    {
        key: 'arrival', name: 'Knock at the Door', icon: 'fa-door-open',
        prompt: 'Let the world beyond the scene break in: someone arrives, a message lands, the weather or the crowd turns, news from elsewhere catches up. Whoever or whatever intrudes wants something from the people already there.',
    },
    {
        key: 'onward', name: 'Jump Ahead', icon: 'fa-forward-fast',
        prompt: 'Carry the story on to the next moment worth playing: that evening, the morning after, the end of the road, the day everything was building toward. Say in a line what passed in between, then open on the new scene.',
    },
    {
        key: 'afterdark', name: 'After Dark', icon: 'fa-moon', adult: true,
        prompt: 'The story is adult fiction between consenting adults. Offer directions where desire and intimacy come forward between the characters in the scene, written frankly and true to what each of them has shown they want. Let it be about their nerve and their closeness more than a list of acts.',
    },
].map(s => Object.freeze({ ...s, kind: 'story' })));

export const DIRECTOR = Object.freeze({
    key: 'director', name: 'Director', icon: 'fa-clapperboard', kind: 'director',
    prompt: 'The reader is directing this one. Keep to what they asked for, and fill in what they left open: the words, the feelings, the place and the timing.',
});
// takes: one sketched scene played several ways; steps: a suggestion for each step, in order
export const DIRECTOR_MODES = Object.freeze(['takes', 'steps']);

export const GENRES = Object.freeze([
    { key: 'genre-slice', name: 'Slice of Life', icon: 'fa-sun', prompt: 'Find the story in ordinary life: errands, chores, neighbours, small rituals, the warmth and friction of people simply living side by side.' },
    { key: 'genre-slowburn', name: 'Slow Burn', icon: 'fa-heart-pulse', prompt: 'Let attraction grow by inches: a look held a beat too long, a hand almost taken, a feeling noticed and not yet admitted.' },
    { key: 'genre-farce', name: 'Farce', icon: 'fa-face-grin-tears', prompt: 'Play it for laughs: doors opening at the worst moment, mistaken identities, a plan collapsing into chaos one ridiculous step at a time.' },
    { key: 'genre-intrigue', name: 'Intrigue', icon: 'fa-chess-knight', prompt: 'Turn it toward intrigue: whispered alliances, favours traded, a rival\'s quiet move, everyone smiling and everyone keeping score.' },
    { key: 'genre-heist', name: 'Heist', icon: 'fa-vault', prompt: 'Make it a job: a prize behind locks and guards, a crew with a plan, and the moment the plan meets something nobody planned for.' },
    { key: 'genre-survival', name: 'Survival', icon: 'fa-campground', prompt: 'Strip the world down to survival: shelter, water, the cold, an injury that will not wait, and hard choices about who and what to carry.' },
    { key: 'genre-western', name: 'Western', icon: 'fa-hat-cowboy', prompt: 'Give it the frontier: dust and distance, a stranger in town, a debt settled at noon, law that reaches only as far as one rider.' },
    { key: 'genre-gothic', name: 'Gothic', icon: 'fa-crow', prompt: 'Go gothic: an old house with a will of its own, a family secret in the walls, candlelight and storms, a past that will not stay buried.' },
    { key: 'genre-eldritch', name: 'Eldritch', icon: 'fa-eye', prompt: 'Let something vast and wrong press in at the edges: angles that do not add up, dreams shared by strangers, knowledge that costs the mind holding it.' },
    { key: 'genre-fairytale', name: 'Fairy Tale', icon: 'fa-crown', prompt: 'Tell it as a fairy tale: bargains with strange folk, rules that come in threes, a forest path not to be left, kindness repaid and cruelty answered.' },
    { key: 'genre-spaceopera', name: 'Space Opera', icon: 'fa-user-astronaut', prompt: 'Widen the sky to space opera: fleets and old empires, a ship with a crew and a past, worlds with strange customs, stakes counted in star systems.' },
    { key: 'genre-cyberpunk', name: 'Cyberpunk', icon: 'fa-microchip', prompt: 'Plug it into cyberpunk: neon over wet streets, corporate power, bodies upgraded on credit, a leak of data someone would kill to stop.' },
].map(s => Object.freeze({ ...s, kind: 'genre' })));

export const BUILT_IN = Object.freeze([...STORY, DIRECTOR, ...GENRES]);

export const builtIn = (key) => BUILT_IN.find(s => s.key === key) || null;

// a reader's style icons: Font Awesome solid names, never markup; the first is a new style's, the rest in name order
export const ICONS = Object.freeze([
    'fa-wand-magic-sparkles', 'fa-anchor', 'fa-arrow-trend-up', 'fa-atom', 'fa-bolt', 'fa-bomb', 'fa-book-open',
    'fa-brain', 'fa-campground', 'fa-champagne-glasses', 'fa-chess-knight', 'fa-city', 'fa-cloud-rain', 'fa-crow',
    'fa-crown', 'fa-dice', 'fa-door-open', 'fa-dragon', 'fa-dungeon', 'fa-eye', 'fa-face-grin-tears',
    'fa-feather-pointed', 'fa-flask', 'fa-forward-fast', 'fa-gem', 'fa-guitar', 'fa-hand-fist', 'fa-hat-cowboy',
    'fa-heart-crack', 'fa-heart-pulse', 'fa-hourglass-half', 'fa-key', 'fa-leaf', 'fa-map', 'fa-mask', 'fa-microchip',
    'fa-moon', 'fa-mountain-sun', 'fa-mug-hot', 'fa-music', 'fa-paw', 'fa-robot', 'fa-scroll', 'fa-shield-halved',
    'fa-ship', 'fa-signs-post', 'fa-skull', 'fa-skull-crossbones', 'fa-spider', 'fa-star', 'fa-sun', 'fa-tree',
    'fa-user-astronaut', 'fa-user-ninja', 'fa-vault', 'fa-water', 'fa-wind',
]);

// a style of the reader's: its key, and what each of its fields may hold
export const CUSTOM_KEY_RE = /^custom-[a-z0-9]{8}$/;
export const NAME_MAX = 40;
export const PROMPT_MAX = 4000;
export const CUSTOM_MAX = 50;

// Director: a step for each suggestion the count allows, a sentence or two each
export const DIRECTIONS_MAX = 8;
export const DIRECTION_MAX = 280;

// how long a suggestion's beat runs: the select's words, the model's words, and the output each one needs
export const LENGTHS = Object.freeze({
    brief: Object.freeze({ label: 'Brief: a sentence or two', words: 'one or two sentences, under 40 words', tokens: 110 }),
    paragraph: Object.freeze({ label: 'A paragraph: about 50 to 90 words', words: 'one paragraph of 50 to 90 words', tokens: 200 }),
    detailed: Object.freeze({ label: 'Detailed: about 100 to 160 words', words: '100 to 160 words', tokens: 330 }),
});
/** A stored length as one of LENGTHS; anything else reads as a paragraph. */
export const lengthKey = (v) => (typeof v === 'string' && Object.hasOwn(LENGTHS, v) ? v : 'paragraph');

export const SETTING_LIMITS = Object.freeze({
    count: Object.freeze([1, 8]),
    depth: Object.freeze([1, 40]),
    reasoningTokens: Object.freeze([2000, 64000]),
    surpriseMin: Object.freeze([1, 30]),
    surpriseMax: Object.freeze([1, 30]),
});

/** A numeric setting held to its range; a value that reads as no number is the declared default. */
export function settingNumber(key, value, fallback) {
    const [lo, hi] = SETTING_LIMITS[key];
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** The messages a surprise may land after, fewest and most; the same number at both ends is a fixed distance. */
export function surpriseRange(min, max) {
    return [min, Math.max(min, max)];
}

// how Insert, Copy and Send hand a suggestion on: as it is, as an out-of-character aside, or as a direction for the story
export const WRAPS = Object.freeze({
    none: Object.freeze({ label: 'The text alone', wrap: (text) => text }),
    ooc: Object.freeze({ label: '[OOC: the text]', wrap: (text) => `[OOC: ${text}]` }),
    direction: Object.freeze({ label: '[Story direction: the text]', wrap: (text) => `[Story direction: ${text}]` }),
});
/** A stored wrap as one of WRAPS; anything else hands the text on alone. */
export const wrapKey = (v) => (typeof v === 'string' && Object.hasOwn(WRAPS, v) ? v : 'none');

/** What Insert, Copy and Send hand on: the text, wrapped the way the reader chose. */
export const wrapText = (text, wrap) => WRAPS[wrapKey(wrap)].wrap(text);
