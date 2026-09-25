'use strict';

// Branch coverage for src/commands/economy/mine/map.js (#998).
//
// The file measured 31% of statements and 1 of 20 branches. It is the /mine
// counterpart to tests/fishLocationCommand.test.js: the smallest handler in the
// directory, taking the same shape the rest of them take — guild settings, the
// economy gate, the player read, then render.

const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn() }));
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/grindProfile', () => ({ attachGrind: jest.fn(async () => {}) }));

const Guild = require('../src/models/Guild');
const User = require('../src/models/User');
const { handleMap } = require('../src/commands/economy/mine/map');
const { DEPTHS, INTENSITY_LEVELS, MATERIAL_NAMES } = require('../src/data/mineData');
const { RAID_MAX_PER_MATERIAL } = require('../src/services/mineService');

/**
 * A player document whose `mining` starts empty, so the real `ensureMineData`
 * fills the defaults the handler then renders — which is what makes the map,
 * the depth and the 100-cell grid the service's answer rather than the test's.
 */
function seedUser(mining = {}) {
    const user = {
        userId: 'user-1',
        guildId: 'guild-1',
        // One dig on record: the map is gated on having mined at all (#873,
        // pass 16), and these tests are about what it renders once it opens.
        mining: { totalMines: 1, ...mining },
        markModified: jest.fn(),
        save: jest.fn().mockResolvedValue(undefined),
    };
    User.findOne.mockResolvedValue(user);
    return user;
}

beforeEach(() => {
    jest.clearAllMocks();
    Guild.findOne.mockResolvedValue({ economy: { enabled: true, currency: '🪙' } });
});

describe('the gates before the map', () => {
    test('a server with the economy switched off gets a refusal and no read', async () => {
        Guild.findOne.mockResolvedValue({ economy: { enabled: false } });
        const interaction = makeInteraction();
        await handleMap(interaction);
        expect(repliedText(interaction)).toContain('economy is disabled');
        expect(User.findOne).not.toHaveBeenCalled();
    });

    test('a server with no economy settings at all is treated as enabled', async () => {
        Guild.findOne.mockResolvedValue(null);
        seedUser();
        const interaction = makeInteraction();
        await handleMap(interaction);
        expect(repliedText(interaction)).toContain('Mine Map');
    });

    test('a player who has never mined is pointed at /mine dig', async () => {
        User.findOne.mockResolvedValue(null);
        const interaction = makeInteraction();
        await handleMap(interaction);
        expect(repliedText(interaction)).toContain("haven't started mining yet");
    });

    test('a member with a user document but no digs is pointed at /mine dig, not shown a blank grid', async () => {
        // Anyone who has chatted has a user document, so this is the common
        // case the old `!user` gate missed.
        seedUser({ totalMines: 0 });
        const interaction = makeInteraction();
        await handleMap(interaction);
        expect(repliedText(interaction)).toContain("haven't started mining yet");
        expect(repliedText(interaction)).not.toContain('cells explored');
    });
});

describe('the map body', () => {
    test('a fresh map reports nothing explored and names the starting depth', async () => {
        seedUser();
        const interaction = makeInteraction();
        await handleMap(interaction);

        const text = repliedText(interaction);
        expect(text).toContain('0/100 cells explored');
        expect(text).toContain(DEPTHS.surface_quarry.name);
        expect(text).toContain('Yield range');
    });

    test('the yield range is read off the intensity ladder', async () => {
        // It said 0.7× for a long while after Careful moved to 0.8×.
        const mults = INTENSITY_LEVELS.map(l => l.multiplier);
        seedUser();
        const interaction = makeInteraction();
        await handleMap(interaction);
        expect(repliedText(interaction)).toContain(`${Math.min(...mults).toFixed(1)}×–${Math.max(...mults).toFixed(1)}×`);
    });

    test('excavated cells are counted and unexplored ones are not', async () => {
        const mineMap = Array(100).fill(0);
        for (let i = 0; i < 7; i++) mineMap[i] = 1;
        seedUser({ mineMap });
        const interaction = makeInteraction();
        await handleMap(interaction);
        expect(repliedText(interaction)).toContain('7/100 cells explored');
    });

    // `ensureMineData` fills in a map for a player who has none, so the `?? []`
    // on the explored count is a guard rather than a state the read produces.
    test('a player with no map array at all still renders a count', async () => {
        seedUser({ mineMap: null });
        const interaction = makeInteraction();
        await handleMap(interaction);
        expect(repliedText(interaction)).toMatch(/\d+\/100 cells explored/);
    });

    test('a depth the table does not know drops the depth label rather than rendering undefined', async () => {
        seedUser({ activeDepth: 'the_mantle' });
        const interaction = makeInteraction();
        await handleMap(interaction);

        const text = repliedText(interaction);
        expect(text).toContain('Yield range');
        expect(text).not.toContain('undefined');
    });
});

describe('what raiders can reach', () => {
    test('a player holding nothing in bulk has nothing exposed', async () => {
        seedUser();
        const interaction = makeInteraction();
        await handleMap(interaction);
        expect(repliedText(interaction)).toContain('Nothing exposed');
    });

    test('a stockpile is listed by name with the per-raid ceiling', async () => {
        seedUser({ materials: { rock_fragment: 5 } });
        const interaction = makeInteraction();
        await handleMap(interaction);

        const text = repliedText(interaction);
        expect(text).toContain(`${MATERIAL_NAMES.rock_fragment}: **5**`);
        expect(text).toContain(`takes up to ${RAID_MAX_PER_MATERIAL} of each`);
    });

    test('a material with no display name falls back to its id', async () => {
        seedUser({ materials: { unnamed_lump: 4 } });
        const interaction = makeInteraction();
        await handleMap(interaction);
        expect(repliedText(interaction)).toContain('unnamed_lump: **4**');
    });
});

describe('the mine lock', () => {
    test('no lock held and none armed says nothing about locks', async () => {
        seedUser();
        const interaction = makeInteraction();
        await handleMap(interaction);
        expect(repliedText(interaction)).not.toContain('Mine Lock');
    });

    test('a spare lock with none armed points at the command that arms it', async () => {
        seedUser({ consumables: { mine_lock: 2 } });
        const interaction = makeInteraction();
        await handleMap(interaction);

        const text = repliedText(interaction);
        expect(text).toContain('🔓 Mine Lock');
        expect(text).toContain('2 in your bag, none armed');
    });

    test('an armed lock says so, and counts the spares behind it', async () => {
        seedUser({ mineLockActive: true, consumables: { mine_lock: 3 } });
        const interaction = makeInteraction();
        await handleMap(interaction);

        const text = repliedText(interaction);
        expect(text).toContain('🔒 Mine Lock');
        expect(text).toContain('3 spare in your bag');
    });

    test('an armed lock with no spare behind it omits the spare count', async () => {
        seedUser({ mineLockActive: true });
        const interaction = makeInteraction();
        await handleMap(interaction);

        const text = repliedText(interaction);
        expect(text).toContain('🔒 Mine Lock');
        expect(text).not.toContain('spare in your bag');
    });
});
