'use strict';

// "How do I equip my rifle" — the question the chat could not answer.
//
// The knowledge base only knows what a guild wrote down by hand, so a server
// that never documented `/hunt equip` got a model that invented a command
// instead of saying it did not know. The bot's own command tree is the answer
// and was already in the process; these cover deriving it, matching a question
// against it, and what happens to a question that is not about a command at
// all — the half that decides whether every "hey" drags five commands into the
// prompt.

const {
    buildCommandIndex,
    retrieveCommands,
    commandSection,
    buildCommandContext
} = require('../src/services/ai/commandHelp');
const { STOPWORDS } = require('../src/services/ai/retrieval');

// A command module as the loader hands one over: `data.toJSON()` plus the
// category the folder walk stamps on.
function command(json, category = 'economy') {
    return { category, data: { toJSON: () => json } };
}

// Mirrors the real /hunt shape: top-level subcommands (start, inv, equip) beside
// a subcommand group (shop → weapon), so this exercises both the flat leaves and
// the group-flattening path a grouped command still takes.
const HUNT = command({
    name: 'hunt',
    description: 'Hunt animals, manage gear, quests and zones',
    options: [
        { type: 1, name: 'start', description: 'Go on a hunt. Uses 1 stamina.', options: [] },
        {
            type: 1,
            name: 'inv',
            description: 'View your whole hunt inventory, or one category in full',
            options: [{
                type: 3, name: 'category', required: false,
                description: 'Open one category in full (default: an overview of everything)',
                choices: [
                    { name: 'Weapons', value: 'weapons' },
                    { name: 'Ammo', value: 'ammo' },
                    { name: 'Consumables', value: 'consumables' },
                    { name: 'Materials', value: 'materials' }
                ]
            }]
        },
        {
            type: 1,
            name: 'equip',
            description: 'Equip a weapon by its inventory number',
            options: [{
                type: 4, name: 'number', required: true,
                description: 'Weapon number from /hunt inv category:weapons'
            }]
        },
        {
            type: 2,
            name: 'shop',
            description: 'Browse and purchase hunting gear',
            options: [{
                type: 1,
                name: 'weapon',
                description: 'Buy a new hunting weapon',
                options: [{
                    type: 3, name: 'type', required: true, description: 'Which weapon to purchase',
                    choices: [{ name: 'Wooden Rifle', value: 'wood' }, { name: 'Iron Rifle', value: 'iron' }]
                }]
            }]
        }
    ]
});

const PING = command({ name: 'ping', description: 'Check the bot latency', options: [] }, 'utility');

const SET = [HUNT, PING];

const usagesFor = (query, limit) => retrieveCommands(SET, query, limit).map(entry => entry.usage);

describe('the index', () => {
    test('is the leaves a user can type, not the commands they hang off', () => {
        const usages = buildCommandIndex(SET).map(entry => entry.usage);

        expect(usages).toEqual(expect.arrayContaining([
            '/hunt start', '/hunt inv', '/hunt equip', '/hunt shop weapon', '/ping'
        ]));
        // `/hunt` on its own is not a thing anybody runs, so it is not offered
        // as one. `/ping`, which has no subcommands, is.
        expect(usages).not.toContain('/hunt');
    });

    test('carries the description, category and options of the leaf', () => {
        const equip = buildCommandIndex(SET).find(entry => entry.usage === '/hunt equip');

        expect(equip.description).toBe('Equip a weapon by its inventory number');
        expect(equip.category).toBe('economy');
        expect(equip.options).toEqual([expect.objectContaining({
            name: 'number', required: true, description: 'Weapon number from /hunt inv category:weapons'
        })]);
    });

    test('a module whose builder throws is skipped, not fatal', () => {
        const broken = { category: 'fun', data: { toJSON: () => { throw new Error('bad builder'); } } };

        const usages = buildCommandIndex([broken, PING]).map(entry => entry.usage);

        expect(usages).toEqual(['/ping']);
    });

    test('is built once per collection rather than per question', () => {
        const collection = new Map([['hunt', HUNT], ['ping', PING]]);

        expect(buildCommandIndex(collection)).toBe(buildCommandIndex(collection));
    });

    // client.commands is a Collection, tests and scripts have an array, and
    // both have to walk the same way.
    test('takes a Map keyed by name as readily as a list', () => {
        const collection = new Map([['hunt', HUNT], ['ping', PING]]);

        expect(buildCommandIndex(collection).map(e => e.usage))
            .toEqual(buildCommandIndex(SET).map(e => e.usage));
    });

    test('nothing loaded is an empty index rather than a throw', () => {
        expect(buildCommandIndex(null)).toEqual([]);
        expect(buildCommandIndex(undefined)).toEqual([]);
    });
});

describe('retrieval', () => {
    test('the question this exists for finds the subcommand that answers it', () => {
        expect(usagesFor('How do I equip my rifle')).toContain('/hunt equip');
    });

    test('a word in the command path outranks the same word in a description', () => {
        // "hunt" names the command; `/ping` says nothing about hunting.
        expect(usagesFor('how does hunt work')[0]).toMatch(/^\/hunt/);
    });

    test('an option choice is searchable, so an item name finds where to buy it', () => {
        // "Wooden Rifle" appears nowhere but in the choice list of /hunt shop weapon.
        expect(usagesFor('where do I get a wooden rifle')).toContain('/hunt shop weapon');
    });

    test('a plural or a tense still matches the singular in the tree', () => {
        expect(usagesFor('equipping rifles')).toContain('/hunt equip');
    });

    test('honours the limit, best match first', () => {
        const usages = usagesFor('hunt', 2);

        expect(usages).toHaveLength(2);
        expect(usages.every(usage => usage.startsWith('/hunt'))).toBe(true);
    });

    // The half that keeps the prompt from filling up with commands nobody
    // asked about.
    describe('a question that is not about a command', () => {
        test.each([
            ['hey what is up'],
            ['lol ok'],
            ['thanks!'],
            ['who was the first president'],
            ['']
        ])('retrieves nothing: %s', query => {
            expect(retrieveCommands(SET, query)).toEqual([]);
        });

        // One word landing in an option description is not enough on its own:
        // "purchase" is only in /hunt shop weapon's option here, and in a real
        // tree the equivalents ("number", "amount", "user") are in dozens of them.
        test('a single hit outside the command path does not qualify an entry', () => {
            expect(usagesFor('can I get a refund on my purchase')).toEqual([]);
            // Two of them do, which is what makes it a question about that
            // command rather than a word that happens to appear in it.
            expect(usagesFor('purchase a rifle')).toContain('/hunt shop weapon');
        });
    });
});

describe('the prompt section', () => {
    const section = () => commandSection(retrieveCommands(SET, 'how do I equip my rifle'));

    test('renders the usage, the category, the description and the options', () => {
        const text = buildCommandContext(retrieveCommands(SET, 'how do I equip my rifle'));

        expect(text).toContain('`/hunt equip` (economy) — Equip a weapon by its inventory number');
        expect(text).toContain('`number` (whole number, required)');
        expect(text).toContain('Weapon number from /hunt inv category:weapons');
    });

    test('tells the model these are exact and that there are more of them', () => {
        expect(section().header).toMatch(/never invent a command/i);
        expect(section().header).toMatch(/\/help/);
    });

    test('is one item per command, so the budget can drop the worst match alone', () => {
        const { items } = section();

        expect(items.length).toBeGreaterThan(1);
        expect(items[0]).toContain('/hunt equip');
    });

    test('nothing retrieved renders nothing at all', () => {
        expect(buildCommandContext([])).toBe('');
    });
});

// The index is derived from the commands this process loads, so the assertion
// worth having is against the ones it actually ships. This is the question in
// the feature request, asked of the real tree: if `/hunt equip` is ever
// renamed, the rename is what this catches.
describe('against the real command set', () => {
    const { loadCommandModules } = require('../src/utils/commandLoader');
    const modules = loadCommandModules().commands.map(entry => entry.command);

    test('the tree flattens to a substantial index', () => {
        expect(buildCommandIndex(modules).length).toBeGreaterThan(100);
    });

    test.each([
        ['how do I equip my rifle', '/hunt equip'],
        ['how do I go hunting', '/hunt start'],
        ['how do I check my balance', '/balance'],
        ['how does mining work', '/mine dig'],
        // #1022 folded three top-level commands into subcommands; the reference
        // is derived from the tree, so a question resolves to the new path.
        ['how do I set a trap', '/rob trap set'],
        ['how do I scout a target before robbing', '/rob status'],
        ['which channels are excluded from xp', '/rank info'],
    ])('%s → %s', (query, expected) => {
        expect(retrieveCommands(modules, query).map(e => e.usage)).toContain(expected);
    });

    test('small talk still retrieves nothing from a hundred commands', () => {
        expect(retrieveCommands(modules, 'hey there, how are you today')).toEqual([]);
    });

    // The stopword list is the one hand-written thing here, and the way it goes
    // wrong is silent: a command named after an ordinary English word becomes
    // unfindable, and nothing says so. `/help`, `/use`, `/work`, `/mine` and
    // `/shop` are all already in that position.
    test('no word of any command path is a stopword', () => {
        const pathWords = new Set(
            buildCommandIndex(modules).flatMap(entry => entry.usage.slice(1).split(' '))
        );
        const eaten = [...pathWords].filter(word => STOPWORDS.has(word));

        expect(eaten).toEqual([]);
    });
});
