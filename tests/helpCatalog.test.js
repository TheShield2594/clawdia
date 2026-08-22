'use strict';

// #665: /help was a hand-maintained list that had drifted from src/commands —
// 37 of 98 commands were missing from it, and it named four casino games that
// no longer existed. These tests hold the catalog to the loaded command set, so
// the two cannot come apart again without a red build.

const fs = require('fs');
const path = require('path');
const { buildCategories, CATEGORY_META, SELECT_DESCRIPTION_LIMIT } = require('../src/utils/helpCatalog');
const { loadCommandModules, listCommandFiles } = require('../src/utils/commandLoader');

const fake = (name, category, description = `${name} description`) => ({
    data: { name, description },
    category,
});

describe('buildCategories', () => {
    test('groups commands by the folder they were loaded from', () => {
        const categories = buildCategories([
            fake('ban', 'moderation'),
            fake('daily', 'economy'),
            fake('work', 'economy'),
        ]);

        expect(categories.map(c => c.id)).toEqual(['economy', 'moderation']);
        expect(categories[0].commands.map(c => c.name)).toEqual(['daily', 'work']);
        expect(categories[1].commands.map(c => c.name)).toEqual(['ban']);
    });

    test('orders categories as CATEGORY_META does, whatever order commands arrive in', () => {
        const shuffled = [...CATEGORY_META.keys()].reverse().map(id => fake(`cmd-${id}`, id));

        expect(buildCategories(shuffled).map(c => c.id)).toEqual([...CATEGORY_META.keys()]);
    });

    test('takes the description from the command, not from a second copy of it', () => {
        const [category] = buildCategories([fake('work', 'economy', 'Earn coins by working a shift')]);

        expect(category.commands[0].description).toBe('Earn coins by working a shift');
    });

    // The whole point of deriving the catalog: a category nobody thought to add
    // display metadata for still lists its commands, rather than hiding them.
    test('surfaces a folder that has no metadata rather than dropping it', () => {
        const categories = buildCategories([fake('ban', 'moderation'), fake('brew', 'alchemy')]);

        expect(categories.map(c => c.id)).toEqual(['moderation', 'alchemy']);
        expect(categories[1].label).toBe('Alchemy');
        expect(categories[1].commands.map(c => c.name)).toEqual(['brew']);
    });

    test('skips anything without a command name, and returns nothing for an empty set', () => {
        expect(buildCategories([])).toEqual([]);
        expect(buildCategories(null)).toEqual([]);
        expect(buildCategories([{ data: {} }, null])).toEqual([]);
    });

    // Discord rejects the whole select menu if one option's description is over
    // the limit, so a category with many long command names must elide.
    test('keeps every select description inside the Discord limit', () => {
        const many = Array.from({ length: 40 }, (_, i) => fake(`economy-command-number-${i}`, 'economy'));
        const [category] = buildCategories(many);

        expect(category.summary.length).toBeLessThanOrEqual(SELECT_DESCRIPTION_LIMIT);
        expect(category.summary).toContain('40 commands:');
    });

    test('lists the AI mention alongside the AI commands', () => {
        const [category] = buildCategories([fake('remind', 'ai')]);

        expect(category.commands.find(c => c.name === '@Clawdia')).toMatchObject({ mention: true });
    });

    test('does not invent an AI category when no AI command loaded', () => {
        expect(buildCategories([fake('ban', 'moderation')]).map(c => c.id)).toEqual(['moderation']);
    });
});

describe('the catalog against the real command tree', () => {
    const { commands, failures } = loadCommandModules();
    const categories = buildCategories(commands.map(c => c.command));

    test('every command file loaded', () => {
        expect(failures).toEqual([]);
        expect(commands.length).toBe(listCommandFiles().length);
    });

    // This is the guard the hand-maintained list never had.
    test('lists every registered command exactly once', () => {
        const listed = categories.flatMap(c => c.commands.map(cmd => cmd.name));
        const registered = commands.map(c => c.command.data.name).sort();

        expect(listed.filter(name => !name.startsWith('@')).sort()).toEqual(registered);
        expect(new Set(listed).size).toBe(listed.length);
    });

    test('every listed command carries the description Discord was given', () => {
        const byName = new Map(commands.map(c => [c.command.data.name, c.command.data.description]));

        for (const category of categories) {
            for (const cmd of category.commands) {
                if (cmd.mention) continue;
                expect([cmd.name, cmd.description]).toEqual([cmd.name, byName.get(cmd.name)]);
            }
        }
    });

    test('every select description fits, for the real command set', () => {
        for (const category of categories) {
            expect([category.id, category.summary.length <= SELECT_DESCRIPTION_LIMIT]).toEqual([category.id, true]);
        }
    });
});

describe('/casino advertises the games it actually has', () => {
    const casino = require('../src/commands/economy/casino');
    const gamesDir = path.join(__dirname, '..', 'src', 'games', 'casino');
    const gameNames = fs.readdirSync(gamesDir)
        .filter(file => file.endsWith('.js'))
        .map(file => require(path.join(gamesDir, file)).name)
        .sort();

    test('registers one subcommand per game module', () => {
        const subcommands = casino.data.toJSON().options.map(opt => opt.name);

        expect(gameNames.every(name => subcommands.includes(name))).toBe(true);
    });

    test('names every game in the description, and nothing else', () => {
        const named = casino.data.description
            .replace(/^Play casino games: /, '')
            .replace(/\.$/, '')
            .split(', ')
            .sort();

        expect(named).toEqual(gameNames);
    });

    test('fits inside the Discord description limit', () => {
        expect(casino.data.description.length).toBeLessThanOrEqual(100);
    });
});
