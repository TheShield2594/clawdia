'use strict';

// Branch coverage for src/commands/economy/fish/location.js (#998).
//
// The file measured 20% of statements and 0 of 20 branches — what was counted
// was its imports evaluating at require time, not the command running. It is
// the smallest of the /fish handlers and it takes the usual shape for all of
// them: read the guild settings, refuse if the economy is off, upsert the
// player, then branch. Driving it end to end is what the embed suites cannot
// reach, and it is the pattern the rest of the directory will need.

const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/grindProfile', () => ({ attachGrind: jest.fn(async () => {}) }));

const Guild = require('../src/models/Guild');
const User = require('../src/models/User');
const { handleLocation } = require('../src/commands/economy/fish/location');
const { LOCATIONS, LOCATION_LIST } = require('../src/data/fishData');

/** A player document with the save surface `setLocation` writes through. */
function seedUser(fishing = {}) {
    const user = {
        userId: 'user-1',
        guildId: 'guild-1',
        fishing: {
            level: 30,
            unlockedLocations: ['pond', 'river'],
            activeLocation: 'pond',
            ...fishing,
        },
        markModified: jest.fn(),
        save: jest.fn().mockResolvedValue(undefined),
    };
    User.findOneAndUpdate.mockResolvedValue(user);
    return user;
}

beforeEach(() => {
    jest.clearAllMocks();
    Guild.findOne.mockResolvedValue({ economy: { enabled: true, currency: '🪙' } });
});

describe('the economy gate', () => {
    test('a server with the economy switched off gets a refusal and no read', async () => {
        Guild.findOne.mockResolvedValue({ economy: { enabled: false } });
        const interaction = makeInteraction();
        await handleLocation(interaction, 'list');
        expect(repliedText(interaction)).toContain('economy is disabled');
        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('a server with no economy settings at all is treated as enabled', async () => {
        Guild.findOne.mockResolvedValue(null);
        seedUser();
        const interaction = makeInteraction();
        await handleLocation(interaction, 'list');
        expect(repliedText(interaction)).toContain('Fishing Locations');
    });

    test('an unknown subcommand renders nothing rather than throwing', async () => {
        seedUser();
        const interaction = makeInteraction();
        await expect(handleLocation(interaction, 'nonsense')).resolves.toBeUndefined();
        expect(interaction.replies).toHaveLength(0);
    });
});

describe('location list', () => {
    test('the active spot, the unlocked ones and the locked ones each read differently', async () => {
        seedUser({ unlockedLocations: ['pond', 'river'], activeLocation: 'pond' });
        const interaction = makeInteraction();
        await handleLocation(interaction, 'list');

        const text = repliedText(interaction);
        expect(text).toContain(`**${LOCATIONS.pond.name}** **[ACTIVE]**`);
        expect(text).toContain(`**${LOCATIONS.river.name}** ✅`);
        expect(text).toContain(`**${LOCATIONS.ocean.name}** 🔒 Lv.${LOCATIONS.ocean.unlockLevel}`);
    });

    // Only the starter pond is free, so the unlock line has two shapes: a bare
    // level for a spot that costs nothing and a level plus a price for the rest.
    test('a locked spot that also costs coins names the price in the guild currency', async () => {
        seedUser({ unlockedLocations: ['pond'] });
        const paid = LOCATION_LIST.find(l => l.unlockCost > 0 && l.id !== 'pond');
        const interaction = makeInteraction();
        await handleLocation(interaction, 'list');
        expect(repliedText(interaction))
            .toContain(`🔒 Lv.${paid.unlockLevel} / 🪙${paid.unlockCost.toLocaleString()}`);
    });

    // The locked line has a `unlockCost > 0` arm for a spot that is locked and
    // free, and nothing can reach it: the pond is the only free location and
    // `ensureFishingData` puts it back in `unlockedLocations` on every read, so
    // a locked pond does not survive to be rendered. Assert the invariant that
    // makes it unreachable rather than the branch.
    test('the only free location is one the player always already has', async () => {
        const free = LOCATION_LIST.filter(l => !(l.unlockCost > 0));
        expect(free.map(l => l.id)).toEqual(['pond']);

        seedUser({ unlockedLocations: [], activeLocation: null });
        const interaction = makeInteraction();
        await handleLocation(interaction, 'list');
        expect(repliedText(interaction)).toContain(`**${LOCATIONS.pond.name}** **[ACTIVE]**`);
    });

    test('a spot with a payout bonus advertises it and one without stays quiet', async () => {
        seedUser();
        const interaction = makeInteraction();
        await handleLocation(interaction, 'list');

        const text = repliedText(interaction);
        const bonus = LOCATION_LIST.find(l => l.payoutBonus > 0);
        const plain = LOCATION_LIST.find(l => !(l.payoutBonus > 0));
        expect(text).toContain(`Payout +${Math.round(bonus.payoutBonus * 100)}%`);
        expect(text).toContain(plain.description);
    });

    test('the currency falls back when the guild has not set one', async () => {
        Guild.findOne.mockResolvedValue({ economy: { enabled: true } });
        seedUser({ unlockedLocations: ['pond'] });
        const interaction = makeInteraction();
        await handleLocation(interaction, 'list');
        const paid = LOCATION_LIST.find(l => l.unlockCost > 0 && l.id !== 'pond');
        expect(repliedText(interaction)).toContain(`💰${paid.unlockCost.toLocaleString()}`);
    });
});

describe('location set', () => {
    test('switching to an unlocked spot saves it and confirms', async () => {
        const user = seedUser();
        const interaction = makeInteraction({ options: { location: 'river' } });
        await handleLocation(interaction, 'set');

        expect(user.fishing.activeLocation).toBe('river');
        expect(user.markModified).toHaveBeenCalledWith('fishing');
        expect(user.save).toHaveBeenCalled();
        expect(repliedText(interaction)).toContain('Location Changed');
    });

    test('a location the game has never heard of is refused', async () => {
        const user = seedUser();
        const interaction = makeInteraction({ options: { location: 'the_moon' } });
        await handleLocation(interaction, 'set');

        expect(repliedText(interaction)).toContain('Unknown location.');
        expect(user.save).not.toHaveBeenCalled();
    });

    test('a real but un-unlocked location points at the shop', async () => {
        const user = seedUser({ unlockedLocations: ['pond'] });
        const interaction = makeInteraction({ options: { location: 'river' } });
        await handleLocation(interaction, 'set');

        expect(repliedText(interaction)).toContain('/fish shop unlock');
        expect(user.save).not.toHaveBeenCalled();
    });

    // Unlocking and the level requirement are separate gates: a prestige resets
    // the level while the unlock list survives, which leaves a player holding a
    // spot they can no longer fish.
    test('an unlocked location below the required level is refused on level', async () => {
        const deep = LOCATION_LIST.find(l => l.unlockLevel > 1);
        const user = seedUser({ unlockedLocations: ['pond', deep.id], level: deep.unlockLevel - 1 });
        const interaction = makeInteraction({ options: { location: deep.id } });
        await handleLocation(interaction, 'set');

        expect(repliedText(interaction)).toContain(`You need Fisher Level **${deep.unlockLevel}**`);
        expect(repliedText(interaction)).toContain(`You are Level **${deep.unlockLevel - 1}**`);
        expect(user.save).not.toHaveBeenCalled();
    });

    test('a save that fails reports it instead of claiming the switch happened', async () => {
        const user = seedUser();
        user.save.mockRejectedValue(new Error('write concern'));
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const interaction = makeInteraction({ options: { location: 'river' } });

        await handleLocation(interaction, 'set');

        expect(repliedText(interaction)).toContain('Something went wrong');
        expect(repliedText(interaction)).not.toContain('Location Changed');
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });
});
