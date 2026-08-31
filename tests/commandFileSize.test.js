'use strict';

const fs = require('fs');
const path = require('path');
const { RuleTester } = require('eslint');

// #917. /fish, /hunt and /mine were split into folders by #721, and their shop
// groups into folders of their own here — but nothing stopped any of it growing
// back except reviewer memory and a joke in utils/embedColors about "a
// nine-hundred-line command file". The rule is that joke, enforced.
//
// What is pinned: the rule is wired over src/commands, the grandfathered list
// is only the files that were genuinely already over the cap, and the rule
// fails in all three directions — a new file over the cap, a frozen file that
// grew, and an exemption that has gone stale.

const plugin = require('../eslint-rules/command-file-size');
const config = require('../eslint.config.js');
const { listCommandFiles } = require('../src/utils/commandLoader');

const ROOT = path.join(__dirname, '..');

const block = config.find(b => b.rules?.['command/command-file-size']);
const [, ruleOptions] = block.rules['command/command-file-size'];
const { max, grandfathered } = ruleOptions;

const lineCount = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').length - 1;

const ruleTester = new RuleTester({
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs' },
});

const lines = n => Array.from({ length: n }, () => '// x').join('\n') + '\n';
const at = rel => path.join(ROOT, rel);
const withOptions = code => ({ code, options: [ruleOptions] });

describe('the command file size rule', () => {
    test('the config wires it up over src/commands', () => {
        expect(block.files).toContain('src/commands/**/*.js');
        expect(block.rules['command/command-file-size'][0]).toBe('error');
        expect(max).toBe(900);
    });

    test('every grandfathered entry is a real file that is really over the cap', () => {
        // An entry for a file that no longer exists, or one that was never over
        // the cap, is an exemption nobody would notice going unused.
        for (const [rel, ceiling] of Object.entries(grandfathered)) {
            expect([rel, fs.existsSync(path.join(ROOT, rel))]).toEqual([rel, true]);
            expect([rel, ceiling > max]).toEqual([rel, true]);
        }
    });

    test('each frozen ceiling is exactly the file’s current length', () => {
        // Slack in a ceiling is room to grow that nothing is tracking, which is
        // the thing the ratchet exists to remove.
        for (const [rel, ceiling] of Object.entries(grandfathered)) {
            expect([rel, ceiling]).toEqual([rel, lineCount(rel)]);
        }
    });

    test('the list is short, and every entry is a single-file command', () => {
        // A command that has been split into a folder has no business being on
        // it: the whole point of the folder is that no one file is this long.
        for (const rel of Object.keys(grandfathered)) {
            expect([rel, rel.endsWith('/index.js')]).toEqual([rel, false]);
        }
        expect(Object.keys(grandfathered).length).toBeLessThanOrEqual(4);
    });

    test('nothing else under src/commands is over the cap', () => {
        // The rule reports this too; asserting it here says what the tree looks
        // like today rather than only that a guard exists.
        const over = listCommandFiles()
            .flatMap(({ rel }) => {
                const dir = path.join('src', 'commands', path.dirname(rel));
                return fs.readdirSync(path.join(ROOT, dir), { recursive: true })
                    .filter(f => String(f).endsWith('.js'))
                    .map(f => path.join(dir, String(f)).split(path.sep).join('/'));
            })
            .filter((rel, i, all) => all.indexOf(rel) === i)
            .filter(rel => !(rel in grandfathered) && lineCount(rel) > max);

        expect(over).toEqual([]);
    });

    ruleTester.run('command-file-size', plugin.rules['command-file-size'], {
        valid: [
            { filename: at('src/commands/fun/roll.js'), ...withOptions(lines(max)) },
            { filename: at('src/commands/economy/hunt/shop/buy.js'), ...withOptions(lines(200)) },
            // A frozen file that has shrunk but is still over the cap.
            { filename: at('src/commands/economy/pet.js'), ...withOptions(lines(1200)) },
            // Scoping to src/commands is the config's `files` glob, asserted
            // above — the rule itself caps whatever it is pointed at, so there
            // is no "not a command file" case to write here.
        ],
        invalid: [
            {
                filename: at('src/commands/fun/roll.js'),
                ...withOptions(lines(max + 1)),
                errors: [{ messageId: 'tooLong' }],
            },
            {
                // A frozen file that grew by one line.
                filename: at('src/commands/economy/pet.js'),
                ...withOptions(lines(grandfathered['src/commands/economy/pet.js'] + 1)),
                errors: [{ messageId: 'grewPastCeiling' }],
            },
            {
                // A frozen file that has come down under the cap: the exemption
                // is stale, and a stale exemption is permission to grow back.
                filename: at('src/commands/economy/pet.js'),
                ...withOptions(lines(500)),
                errors: [{ messageId: 'staleExemption' }],
            },
        ],
    });
});
