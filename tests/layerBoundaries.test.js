'use strict';

const { RuleTester } = require('eslint');
const path = require('path');

// #614: `services/giveawayService` required `commands/utility/giveaway`,
// `services/scheduler` required a command to pick up unclosed polls,
// `utils/logger` required `services/caseService`, `utils/applyXpGain` required
// `services/petService`. Every one is a lower layer reaching up into a higher
// one — the direction a require cycle arrives from, and in CommonJS a cycle is
// a half-empty module object at require time, not a warning.
//
// The moves fixed the four. This pins the rule that stops the fifth.

const plugin = require('../eslint-rules/layer-boundaries');
const config = require('../eslint.config.js');

const ROOT = path.join(__dirname, '..');

// The block that lints src/ — the layer rule's options are read from it, so the
// rule is exercised against the real layer table rather than a copy of it.
const botBlock = config.find(block => block.rules?.['layers/no-upward-require']);
const [, ruleOptions] = botBlock.rules['layers/no-upward-require'];

const ruleTester = new RuleTester({
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs' },
});

const at = rel => path.join(ROOT, 'src', rel);
const withOptions = code => ({ code, options: [ruleOptions] });

describe('the layer rule', () => {
    test('the config wires it up over src/', () => {
        expect(botBlock.files).toContain('src/**/*.js');
        expect(botBlock.rules['layers/no-upward-require'][0]).toBe('error');
        expect(ruleOptions.root).toBe('src');
    });

    test('the layer table runs models → utils → views → services → commands → entry points', () => {
        expect(ruleOptions.layers).toEqual([
            ['models', 'config', 'data', 'migrations'],
            ['utils'],
            ['views'],
            ['services', 'games'],
            ['commands', 'bot'],
            ['dashboard', 'events'],
        ]);
    });

    test('the only standing exception is the Guild cache hook', () => {
        // Mongoose only honours middleware registered before model() compiles
        // the schema, so this one has to be attached in the model file. Anything
        // else added here needs the same kind of reason.
        expect(ruleOptions.allow).toEqual(['models/Guild -> utils/guildSettingsCache']);
    });

    // RuleTester drives Jest's own describe/it, so it is called here rather than
    // from inside a test().
    ruleTester.run('no-upward-require', plugin.rules['no-upward-require'], {
        valid: [
                // Downward: a command reaching into a service.
                { filename: at('commands/utility/giveaway.js'), ...withOptions("require('../../services/giveawayService');") },
                // Sideways, within one layer.
                { filename: at('services/giveawayService.js'), ...withOptions("require('./caseService');") },
                // All the way down.
                { filename: at('events/messageCreate.js'), ...withOptions("require('../models/User');") },
                // Packages and builtins are not the rule's business.
                { filename: at('utils/logTransaction.js'), ...withOptions("require('discord.js'); require('path');") },
                // The listed exception.
                { filename: at('models/Guild.js'), ...withOptions("require('../utils/guildSettingsCache');") },
                // Files outside src are not layered.
                { filename: path.join(ROOT, 'scripts', 'docs-commands.js'), ...withOptions("require('../src/utils/helpCatalog');") },
            ],
            invalid: [
                {
                    filename: at('services/giveawayService.js'),
                    ...withOptions("require('../commands/utility/giveaway');"),
                    errors: [{ messageId: 'upward' }],
                },
                {
                    filename: at('utils/logger.js'),
                    ...withOptions("require('../services/caseService');"),
                    errors: [{ messageId: 'upward' }],
                },
                {
                    filename: at('views/pollView.js'),
                    ...withOptions("require('../services/pollService');"),
                    errors: [{ messageId: 'upward' }],
                },
                {
                    // A model reaching into a service, which nothing exempts.
                    filename: at('models/User.js'),
                    ...withOptions("require('../services/petService');"),
                    errors: [{ messageId: 'upward' }],
                },
            ],
    });
});

describe('the moves that made the rule pass', () => {
    const modules = {
        'views/pollView': ['buildPollEmbed', 'buildPollRows', 'tallyVotes'],
        'services/pollService': ['handlePollVote', 'scheduleActivePollExpirations'],
        'services/giveawayService': ['endGiveaway', 'pickWinners', 'getEntrants'],
        'services/heistService': ['handleHeistButton', 'resolveHeist', 'startLobbyCountdown'],
        'views/heistView': ['buildLobbyEmbed', 'buildLobbyRows', 'makeSkillRow'],
        'services/moderationLogService': ['logModeration'],
        'services/levelingService': ['applyXpGain', 'announceLevelUp'],
    };

    test.each(Object.entries(modules))('%s exports what moved into it', (rel, exported) => {
        const mod = require(`../src/${rel}`);
        for (const name of exported) expect(typeof mod[name]).toBe('function');
    });

    test('the commands they came out of no longer export them', () => {
        const poll = require('../src/commands/utility/poll');
        const giveaway = require('../src/commands/utility/giveaway');
        const heist = require('../src/commands/economy/heist');

        for (const command of [poll, giveaway, heist]) {
            // A command is its definition and its handler, nothing else. Anything
            // another layer needs is what gets moved out.
            expect(Object.keys(command).filter(k => !['data', 'execute', 'autocomplete',
                'cooldownKey', 'cooldownAmount', 'requiredPermissions'].includes(k))).toEqual([]);
        }
    });
});
