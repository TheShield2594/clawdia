'use strict';

// The command list was hand-maintained and had drifted: 26 registered commands
// missing from it, and a documented `/buy` that has never been a command of its
// own (#712). The list is generated now, and this is what keeps it generated —
// adding a command file turns `npm test` red until `npm run docs:commands` has
// been run, instead of the drift being noticed by a reader some months later.
//
// It lives in docs/COMMANDS.md since #720; it was in README before that.

const fs = require('fs');

const {
    renderCommands,
    replaceBlock,
    buildDoc,
    BEGIN,
    END,
    DOC_PATH,
} = require('../scripts/docs-commands');

describe('generated command reference', () => {
    test('is in step with the commands the bot loads', () => {
        const { current, next } = buildDoc();

        // Not `toBe`: the diff on a 98-line block is unreadable, and the fix is
        // one command either way.
        expect(current === next).toBe(true);
    });

    test('keeps the markers the generator writes between', () => {
        const doc = fs.readFileSync(DOC_PATH, 'utf8');

        expect(doc).toContain(BEGIN);
        expect(doc).toContain(END);
        expect(doc.indexOf(BEGIN)).toBeLessThan(doc.indexOf(END));
    });

    // The prose after the block is hand-written and has to survive a
    // regeneration — the generator replaces the block, not the section.
    test('regenerating leaves the surrounding prose alone', () => {
        const doc = fs.readFileSync(DOC_PATH, 'utf8');
        const rewritten = replaceBlock(doc, 'placeholder');

        expect(rewritten).toContain('## Commands');
        expect(rewritten).toContain('is now in the web dashboard.');
        expect(rewritten).toContain(`${BEGIN}\n\nplaceholder\n\n${END}`);
    });

    test('refuses to write when the markers are gone', () => {
        expect(() => replaceBlock('# Clawdia\n\nNo markers here.\n', 'body'))
            .toThrow(/missing the/);
    });

    // `@Clawdia` is a catalog entry with no command file behind it, so it is the
    // one line that must not be rendered as a slash command.
    test('renders mention entries without a leading slash', () => {
        const body = renderCommands([
            {
                emoji: '🤖',
                label: 'AI',
                commands: [
                    { name: 'ai', description: 'Slash command' },
                    { name: '@Clawdia', description: 'Mention the bot', mention: true },
                ],
            },
        ]);

        expect(body).toContain('- `/ai` — Slash command');
        expect(body).toContain('- `@Clawdia` — Mention the bot');
        expect(body).not.toContain('`/@Clawdia`');
    });
});
