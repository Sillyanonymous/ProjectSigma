// SPDX-License-Identifier: MIT

// Inspired by kaldigo's Tracker for SillyTavern; thanks to its author.

// The four examples a reader starts a tracker from, complete on purpose: copied and switched on, one
// works unedited.

export const EXAMPLES = [
    {
        template: 'scene',
        name: 'Scene',
        icon: 'fa-clapperboard',
        description: 'Where and when this is happening, who is in the room, and what the air feels like. The one most stories want.',
        heading: 'Current scene:',
        prompt: {
            system: 'You take notes on the current scene of a story being written in this chat. You read the recent messages and report where the scene stands NOW, not what happened in it. You never write story, never speak to anyone, and never add events the messages do not contain.',
            instruction: 'Update the scene from the messages above. Whatever has not changed stays as it is; if nothing moved, return the scene unchanged.',
        },
        fields: [
            {
                key: 'time', label: 'Time', kind: 'text',
                prompt: 'The time of day, and the date if the story keeps one. Let it creep forward a little at a time; only a clear skip in the text (a night\'s sleep, a journey, "the next morning") moves it far.',
                example: 'Late morning, Tuesday',
            },
            {
                key: 'location', label: 'Location', kind: 'text', role: 'headline',
                prompt: 'Where this is taking place, precise enough to picture: name the room first, then the building or wider place around it.',
                example: 'The kitchen, Ada\'s flat above the bakery',
            },
            {
                key: 'weather', label: 'Weather', kind: 'text',
                prompt: 'The weather and the light in a few words, left blank when the scene is somewhere nobody would notice them.',
                example: 'Grey and raining hard',
            },
            {
                key: 'present', label: 'Present', kind: 'list',
                prompt: 'Everyone physically in the scene right now, by name. Remove anyone who has left.',
                example: 'Ada',
            },
            {
                key: 'mood', label: 'Mood', kind: 'choice', role: 'badge',
                options: ['calm', 'warm', 'tense', 'hostile', 'grieving', 'playful', 'frightened', 'exhausted'],
                prompt: 'How the room feels right now, picked from the listed words.',
            },
            {
                key: 'topics', label: 'On their minds', kind: 'list',
                prompt: 'What the scene is really about at this moment, as short keywords of a word or two each, never sentences.',
                example: 'the letter',
            },
            { key: 'notes', label: 'Your notes', kind: 'text', update: 'never' },
        ],
    },

    {
        template: 'cast',
        name: 'Cast state',
        icon: 'fa-users',
        description: 'What each person in the scene is wearing, holding and doing. The tracker that stops a character putting on a coat they never took off.',
        heading: 'Where each character stands:',
        prompt: {
            system: 'You take notes on the people of a story being written in this chat. For each character in the scene you report how they are right now: how they are dressed, where they are and what they are doing, what they carry, how they feel and how well they are. You report state, never events, and you never write story.',
            instruction: 'Update each present character from the messages above. Leave a character out entirely if nothing about them changed. Set a character to null ONLY when they have left the scene for good.',
        },
        fields: [
            {
                key: 'people', label: 'Characters', kind: 'per-character',
                prompt: 'One entry per character present, keyed by their name exactly as the story spells it.',
                fields: [
                    {
                        key: 'wearing', label: 'Wearing', kind: 'text',
                        prompt: 'Everything they have on, described whole each time rather than as what changed. It stays as it was until the text has something taken off, put on or ruined.',
                        example: 'Grey wool coat over a white shirt, boots',
                    },
                    {
                        key: 'state', label: 'State of dress', kind: 'text',
                        prompt: 'Whether they look neat or a mess, and where any piece of clothing that came off has been left.',
                        example: 'Soaked through; coat over the back of a chair',
                    },
                    {
                        key: 'doing', label: 'Doing', kind: 'text', role: 'headline',
                        prompt: 'How they are standing or sitting and what their body is busy with, and where they are relative to the others in the scene.',
                        example: 'Standing at the window with her back to the room',
                    },
                    {
                        key: 'holding', label: 'Holding', kind: 'text',
                        prompt: 'Anything in their hands or otherwise carried right now. Blank when their hands are empty.',
                        example: 'The unopened letter',
                    },
                    {
                        key: 'feeling', label: 'Feeling', kind: 'text',
                        prompt: 'Their current state of mind in a few words, as the scene would read it from the outside.',
                        example: 'Bracing for bad news',
                    },
                    {
                        key: 'condition', label: 'Condition', kind: 'number', min: 0, max: 100, tone: 'good-high',
                        prompt: 'How physically able they are right now, from 0 (unconscious or worse) to 100 (fresh and unhurt). Move it down for injury, cold, hunger or exhaustion, and back up slowly with rest and care. Most scenes do not move it at all.',
                        example: 85,
                    },
                    {
                        key: 'hurt', label: 'Hurt', kind: 'text', role: 'badge', tone: 'good-low',
                        prompt: 'What is actually wrong, when the condition is down: the injury, the illness, the exhaustion. Blank when they are fine.',
                    },
                ],
            },
        ],
    },

    {
        template: 'inventory',
        name: 'Inventory and resources',
        icon: 'fa-sack-dollar',
        description: 'What is being carried and what is running out. Money, supplies, ammunition, favours owed.',
        heading: 'Supplies and resources:',
        prompt: {
            system: 'You take notes on what the party owns in a story being written in this chat. You report what the party currently has, changing a quantity only when the story clearly spends, gains, loses or finds something. You never invent items and you never write story.',
            instruction: 'Update the inventory from the messages above. Only change what the text actually changed; leave everything else exactly as it is. Drop an item entirely when it is used up or gone.',
        },
        fields: [
            {
                key: 'carried', label: 'Carried', kind: 'rows',
                prompt: 'Every distinct item currently carried. One entry per item.',
                fields: [
                    { key: 'item', label: 'Item', kind: 'text', prompt: 'What it is, briefly.', example: 'Oil lantern' },
                    { key: 'qty', label: 'Qty', kind: 'number', min: 0, prompt: 'How many. Use 1 for a single thing.', example: 1 },
                    { key: 'note', label: 'Note', kind: 'text', prompt: 'Anything that matters about its condition or where it came from. Usually blank.', example: 'Half full' },
                ],
            },
            {
                key: 'resources', label: 'Resources', kind: 'rows',
                prompt: 'Quantities that go up and down and that the story cares about running out of: money, rations, fuel, ammunition, doses.',
                fields: [
                    { key: 'name', label: 'Resource', kind: 'text', prompt: 'What it is.', example: 'Coin' },
                    { key: 'amount', label: 'Amount', kind: 'number', min: 0, prompt: 'How much is left.', example: 40 },
                    { key: 'unit', label: 'Unit', kind: 'text', update: 'once', prompt: 'What the number counts, set once.', example: 'silver' },
                    { key: 'note', label: 'Note', kind: 'text', prompt: 'A short read on whether this is comfortable or getting tight.', example: 'Enough for about a week' },
                ],
            },
            {
                key: 'owed', label: 'Owed and promised', kind: 'list',
                prompt: 'Debts, favours and promises that are still outstanding, one short line each. Remove one when it is settled.',
                example: 'Owes the ferryman a crossing',
            },
            { key: 'notes', label: 'Your notes', kind: 'text', update: 'never' },
        ],
    },

    {
        template: 'relationships',
        name: 'Relationships',
        icon: 'fa-heart-pulse',
        description: 'How each character actually feels about you, and how that has been moving. Slow numbers, so a single scene does not swing them.',
        heading: 'How each character regards {{user}}:',
        prompt: {
            system: 'You take notes on the bonds in a story being written in this chat. You report how each character currently regards {{user}}, moving the numbers only when something in the text genuinely earns it. Relationships move SLOWLY: a warm conversation is a few points, not twenty. You never write story.',
            instruction: 'Update each character from the messages above. Leave a character out when nothing changed. Move a number only if the text justifies it, and say why in the note when you do.',
        },
        fields: [
            {
                key: 'people', label: 'Characters', kind: 'per-character',
                prompt: 'One entry per character who has an opinion of {{user}}, keyed by their name.',
                fields: [
                    {
                        key: 'regard', label: 'Regard', kind: 'number', min: -100, max: 100, tone: 'good-high',
                        prompt: 'How warmly they feel, from -100 (hatred) through 0 (indifference) to 100 (devotion). Move it by a few points at a time.',
                        example: 20,
                    },
                    {
                        key: 'trust', label: 'Trust', kind: 'number', min: 0, max: 100, tone: 'good-high',
                        prompt: 'How far they would rely on {{user}}, from 0 to 100. Trust is slower to gain than regard and faster to lose.',
                        example: 35,
                    },
                    {
                        key: 'standing', label: 'Where things stand', kind: 'text', role: 'headline',
                        prompt: 'One line on the state of the relationship as they would describe it.',
                        example: 'Grateful, but still keeping her distance',
                    },
                    {
                        key: 'lastShift', label: 'Last shift', kind: 'text',
                        prompt: 'What most recently moved the numbers, in a few words. Blank if nothing has.',
                        example: 'He came back for her when he did not have to',
                    },
                    {
                        key: 'knows', label: 'Has learned', kind: 'list',
                        prompt: 'Things this character has learned about {{user}} that they did not know before. Short lines, and never remove one.',
                    },
                ],
            },
        ],
    },
];
