'use strict';

// What the commands are about, as opposed to what they are called.
//
// tests/aiCommandHelp.test.js covers the command tree: the bot knowing that
// `/hunt shop weapon` exists. It does not cover the bot knowing what a Cobalt
// Rifle costs, where opossums live or what a Luck Charm does, because none of
// that is in a SlashCommandBuilder — it is in src/data/, in the tables the
// economy reads at runtime, and a model asked about it with nothing in front of
// it invents a number.
//
// These cover deriving that index from the real tables, the two hand-written
// lists that say what is content and what it is called, and the content the
// index must not carry.

const fs = require('fs');
const path = require('path');

const {
    buildGameIndex,
    retrieveGameData,
    gameDataSection,
    buildGameDataContext,
    COLLECTIONS,
    NOT_CONTENT
} = require('../src/services/ai/gameData');

const DATA_DIR = path.join(__dirname, '..', 'src', 'data');

const index = buildGameIndex();
const byName = name => index.find(entry => entry.name === name);
const namesFor = (query, limit) => retrieveGameData(query, limit).map(entry => entry.name);

describe('the index', () => {
    test('covers the real tables, not a sample of them', () => {
        expect(index.length).toBeGreaterThan(400);
    });

    test('a record carries its name, what it is, where it is used and its numbers', () => {
        const rifle = byName('Cobalt Rifle');

        expect(rifle).toMatchObject({
            kind: 'hunting rifle',
            system: 'hunting',
            command: '/hunt shop weapon'
        });
        expect(rifle.description).toBe('A cobalt-alloy rifle favored by veteran hunters.');
        // Straight off huntData.WEAPON_TIERS, with thousands separated so the
        // model does not have to render the number itself.
        expect(rifle.facts).toContain('cost: 30,000');
        expect(rifle.facts).toContain('tier: 5');
    });

    test('a table exported twice is one entry, not two', () => {
        // huntData exports the same twelve objects as WEAPON_TIERS,
        // WEAPON_BY_SLUG and WEAPON_BY_TIER.
        expect(index.filter(entry => entry.name === 'Cobalt Rifle')).toHaveLength(1);
    });

    test('takes a description from whichever word the table uses for one', () => {
        // The relic table calls it `lore`, and it is the only prose it has.
        expect(byName('Whisperwood Charm').description).toMatch(/murmurs when storms are coming/);
        // A region calls it `description` and has a `tagline` beside it.
        expect(byName('Crumbling Ruins').description).toMatch(/Toppled columns/);
    });

    test('renders a nested list short enough to read, and drops one that is not', () => {
        const recipe = byName('Luck Charm ×1');

        expect(recipe.facts).toContain('rabbits_foot');
        expect(recipe.facts).toContain('qty 3');
        // A region's encounter list is the same shape and thirty times the size.
        expect(byName('Crumbling Ruins').facts).not.toMatch(/Curator/);
    });

    // A nested object is the one place a name has to survive: nothing is
    // rendered above it, so skipping the name the way the record's own name is
    // skipped left `specialDrop: chance 0.03` with no idea what dropped.
    test('a nested object keeps its own name', () => {
        expect(byName('Opossum').facts).toContain('specialDrop: Opossum Pelt/chance 0.03');
        // And one with no name of its own still renders its fields.
        expect(byName('Luck Charm ×1').facts).toContain('material rabbits_foot/qty 3');
    });

    test('no entry is longer than a couple of paragraphs', () => {
        const longest = Math.max(...index.map(entry => gameDataSection([entry]).items[0].length));

        expect(longest).toBeLessThan(700);
    });

    // The reason the skip list is explicit rather than left to the length caps.
    test('does not carry what /explore hides until somebody finds it', () => {
        const { REGIONS } = require('../src/data/exploreData');
        const secrets = Object.values(REGIONS).flatMap(region => region.secrets || []);
        expect(secrets.length).toBeGreaterThan(0);

        const everything = index.map(entry => `${entry.description} ${entry.facts}`).join('\n');
        for (const secret of secrets) {
            expect(everything).not.toContain(secret.name);
            expect(everything).not.toContain(secret.reveal);
        }
    });
});

describe('retrieval', () => {
    test('a named item comes back first, ahead of its neighbours', () => {
        expect(namesFor('what does the cobalt rifle cost')[0]).toBe('Cobalt Rifle');
        expect(namesFor('how much is a steel pickaxe')[0]).toBe('Steel Pickaxe');
        expect(namesFor('what is the whisperwood charm')[0]).toBe('Whisperwood Charm');
    });

    test('a creature question finds the creature', () => {
        expect(namesFor('where do opossums live')).toContain('Opossum');
    });

    // The whole reason `kind` is searchable: no ore is called "ore" on its own.
    test('a question about a category finds the table', () => {
        expect(namesFor('what ores are there').length).toBeGreaterThan(0);
        expect(retrieveGameData('what ores are there').some(e => e.kind === 'ore')).toBe(true);
    });

    // The rule that splits "opossums" from "first": a name qualifies on one
    // word only when the word is the whole name, because four hundred content
    // names contain an ordinary English word and three of them contain "first".
    test('an ordinary word inside a name is not on its own a question about it', () => {
        expect(retrieveGameData('who was the first president')).toEqual([]);
        // The same word with something else beside it is.
        expect(namesFor('how do I get the first blood achievement')).toContain('First Blood');
    });

    test('honours the limit', () => {
        expect(namesFor('rifle', 2)).toHaveLength(2);
    });

    test.each([
        ['hey there, how are you today'],
        ['lol ok'],
        ['who was the first president'],
        ['']
    ])('a question about nothing here retrieves nothing: %s', query => {
        expect(retrieveGameData(query)).toEqual([]);
    });
});

describe('the prompt section', () => {
    test('renders the name, the kind, the command, the prose and the numbers', () => {
        const text = buildGameDataContext(retrieveGameData('what does the cobalt rifle cost'));

        expect(text).toContain('**Cobalt Rifle** — hunting rifle (`/hunt shop weapon`)');
        expect(text).toContain('cost: 30,000');
    });

    test('tells the model the numbers are exact and not all of them', () => {
        const { header } = gameDataSection([]);

        expect(header).toMatch(/never round or estimate/i);
        expect(header).toMatch(/never invent an item, price, drop or stat/i);
    });

    test('is one item per record, so the budget can drop the worst match alone', () => {
        const { items } = gameDataSection(retrieveGameData('what does the cobalt rifle cost'));

        expect(items.length).toBeGreaterThan(1);
        expect(items[0]).toContain('Cobalt Rifle');
    });

    test('nothing retrieved renders nothing at all', () => {
        expect(buildGameDataContext([])).toBe('');
    });
});

// The registry is the hand-written half, and the way a hand-written half fails
// is by being quietly left behind. These hold it to the code on both sides.
describe('the registry', () => {
    const registered = new Set(COLLECTIONS.map(source => source.module));

    test('every table in src/data is either content or explicitly not', () => {
        const modules = fs.readdirSync(DATA_DIR)
            .filter(file => file.endsWith('.js'))
            .map(file => file.replace(/\.js$/, ''));

        const unclassified = modules.filter(name => !registered.has(name) && !NOT_CONTENT.has(name));

        expect(unclassified).toEqual([]);
    });

    test('nothing is classified twice, and nothing excluded without a reason', () => {
        for (const [name, reason] of NOT_CONTENT) {
            expect(registered.has(name)).toBe(false);
            expect(reason.length).toBeGreaterThan(20);
        }
    });

    test('every registered export still exists and still has records', () => {
        for (const source of COLLECTIONS) {
            const module = require(path.join(DATA_DIR, source.module));
            const table = source.export ? module[source.export] : module;

            expect(table).toBeDefined();
            const records = Array.isArray(table) ? table : Object.values(table);
            expect(records.length).toBeGreaterThan(0);
        }
    });

    // A new table inside a module already on the list is the drift this misses
    // otherwise: the file is registered, so the check above passes, and the new
    // content is simply unanswerable with nothing to say so.
    test('every collection inside a registered module is indexed or an alias of one', () => {
        const indexed = new Set();
        for (const source of COLLECTIONS) {
            const module = require(path.join(DATA_DIR, source.module));
            const table = source.export ? module[source.export] : module;
            for (const record of Array.isArray(table) ? table : Object.values(table)) indexed.add(record);
        }

        const named = value => value && typeof value === 'object'
            && ['name', 'label', 'itemId'].some(key => typeof value[key] === 'string');

        const missed = [];
        for (const name of registered) {
            const module = require(path.join(DATA_DIR, name));
            for (const [key, value] of Object.entries(module)) {
                const records = Array.isArray(value) ? value
                    : (value && typeof value === 'object' ? Object.values(value) : []);
                if (!records.length || !records.every(named)) continue;
                if (records.every(record => indexed.has(record))) continue;
                missed.push(`${name}.${key}`);
            }
        }

        expect(missed).toEqual([]);
    });

    // The cross-reference is the one thing here that can be wrong rather than
    // merely missing: a command that has been renamed sends people to type
    // something Discord will reject.
    test('every command it points at is a command that exists', () => {
        const { loadCommandModules } = require('../src/utils/commandLoader');
        const { buildCommandIndex } = require('../src/services/ai/commandHelp');
        const usages = new Set(
            buildCommandIndex(loadCommandModules().commands.map(entry => entry.command))
                .map(entry => entry.usage)
        );

        const broken = [...new Set(COLLECTIONS.map(source => source.command))]
            .filter(command => !usages.has(command));

        expect(broken).toEqual([]);
    });
});
