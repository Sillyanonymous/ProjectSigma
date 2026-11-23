// SPDX-License-Identifier: MIT

// Send to Creator: one verb in a character's menu, loaded on its first use.
export default {
    init(ctx) {
        ctx.ui.addAction('character', {
            id: 'send',
            label: 'Send to Creator',
            icon: 'fa-plus-circle',
            run: ({ character }) => ctx.commands.run('creator.open', { id: character.id }),
        });
    },
};
