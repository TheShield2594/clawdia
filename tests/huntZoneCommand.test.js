'use strict';

// Branch coverage for src/commands/economy/hunt/zone.js (#998's follow-on).
//
// The /hunt counterpart to tests/fishLocationCommand.test.js and
// tests/mineMapCommand.test.js: the smallest handler in the folder, and the
// same shape all of them take — read the guild settings, refuse if the economy
// is off, upsert the player, then branch. It measured 18% of statements and 0
// of 32 branches, which is its imports evaluating at require time and nothing
// else.
//
// It carries one gate `fish location` does not: switching to the zone you are
// already in is refused rather than written.

const { makeInteraction, repliedText } = require('./helpers/fakeInteraction');

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/User', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());
jest.mock('../src/utils/grindProfile', () => ({ attachGrind: jest.fn(async () => {}) }));

const Guild = require('../src/models/Guild');
const User = require('../src/models/User');
const { executeZone } = require('../src/commands/economy/hunt/zone');
const { ZONES, ZONE_LIST } = require('../src/data/huntData');

/** A player document with the save surface the `set` branch writes through. */
function seedUser(hunt = {}) {
    const user = {
        userId: 'user-1',
        guildId: 'guild-1',
        hunt: {
            level: 60,
            unlockedZones: ['beginner_forest', 'desert_wastes'],
            activeZone: 'beginner_forest',
            ...hunt,
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
        await executeZone(interaction, 'list');
        expect(repliedText(interaction)).toContain('economy is disabled');
        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('a server with no economy settings at all is treated as enabled', async () => {
        Guild.findOne.mockResolvedValue(null);
        seedUser();
        const interaction = makeInteraction();
        await executeZone(interaction, 'list');
        expect(repliedText(interaction)).toContain('Hunting Zones');
    });

    test('an unknown subcommand renders nothing rather than throwing', async () => {
        seedUser();
        const interaction = makeInteraction();
        await expect(executeZone(interaction, 'nonsense')).resolves.toBeUndefined();
        expect(interaction.replies).toHaveLength(0);
    });
});

describe('zone list', () => {
    test('the active zone, the unlocked ones and the locked ones each read differently', async () => {
        seedUser({ unlockedZones: ['beginner_forest', 'desert_wastes'], activeZone: 'beginner_forest' });
        const interaction = makeInteraction();
        await executeZone(interaction, 'list');

        const text = repliedText(interaction);
        expect(text).toContain(`**${ZONES.beginner_forest.name}** — ✅ **ACTIVE**`);
        expect(text).toContain(`**${ZONES.desert_wastes.name}** — ✅ Unlocked`);
        expect(text).toContain(`**${ZONES.legendary_peaks.name}** — 🔒 Level ${ZONES.legendary_peaks.unlockLevel}`);
    });

    test('a locked zone that costs coins names the price in the guild currency', async () => {
        seedUser({ unlockedZones: ['beginner_forest'] });
        const paid = ZONE_LIST.find(z => z.unlockCost > 0);
        const interaction = makeInteraction();
        await executeZone(interaction, 'list');
        expect(repliedText(interaction))
            .toContain(`🔒 Level ${paid.unlockLevel} · 🪙${paid.unlockCost.toLocaleString()}`);
    });

    // The starter forest is the only free zone, and it is unlocked by default,
    // so the "· Free" arm is written for a state the zone table does not produce.
    test('the only free zone is the one every hunter starts with', async () => {
        const free = ZONE_LIST.filter(z => !(z.unlockCost > 0));
        expect(free.map(z => z.id)).toEqual(['beginner_forest']);
        expect(free[0].defaultUnlocked).toBe(true);
    });

    test('a harder zone advertises its difficulty and payout, an easy one stays quiet', async () => {
        seedUser();
        const interaction = makeInteraction();
        await executeZone(interaction, 'list');

        const text = repliedText(interaction);
        const harder = ZONE_LIST.find(z => z.difficultyMod !== 0);
        const paying = ZONE_LIST.find(z => z.payoutBonus > 0);
        const plain = ZONE_LIST.find(z => z.difficultyMod === 0 && !(z.payoutBonus > 0));
        expect(text).toContain(`${Math.round(harder.difficultyMod * 100)}% success`);
        expect(text).toContain(`+${Math.round(paying.payoutBonus * 100)}% payout`);
        expect(text).toContain(plain.description);
    });

    test('the footer names the active zone and the hunter level', async () => {
        seedUser({ level: 42, activeZone: 'desert_wastes' });
        const interaction = makeInteraction();
        await executeZone(interaction, 'list');
        const text = repliedText(interaction);
        expect(text).toContain(`Active zone: ${ZONES.desert_wastes.name}`);
        expect(text).toContain('Your level: 42');
    });

    // `ensureHuntData` puts a real zone back, so the fallback guards a shape the
    // read does not produce rather than one a player can reach.
    test('an unrecognised active zone renders a placeholder rather than undefined', async () => {
        seedUser({ activeZone: 'the_moon' });
        const interaction = makeInteraction();
        await executeZone(interaction, 'list');
        expect(repliedText(interaction)).not.toContain('undefined');
    });

    test('the currency falls back when the guild has not set one', async () => {
        Guild.findOne.mockResolvedValue({ economy: { enabled: true } });
        seedUser({ unlockedZones: ['beginner_forest'] });
        const paid = ZONE_LIST.find(z => z.unlockCost > 0);
        const interaction = makeInteraction();
        await executeZone(interaction, 'list');
        expect(repliedText(interaction)).toContain(`💰${paid.unlockCost.toLocaleString()}`);
    });
});

describe('zone set', () => {
    test('switching to an unlocked zone saves it and names both ends of the move', async () => {
        const user = seedUser();
        const interaction = makeInteraction({ options: { zone: 'desert_wastes' } });
        await executeZone(interaction, 'set');

        expect(user.hunt.activeZone).toBe('desert_wastes');
        expect(user.markModified).toHaveBeenCalledWith('hunt');
        expect(user.save).toHaveBeenCalled();

        const text = repliedText(interaction);
        expect(text).toContain('Zone Changed');
        expect(text).toContain(ZONES.beginner_forest.name);
        expect(text).toContain(ZONES.desert_wastes.name);
    });

    test('a zone the game has never heard of is refused', async () => {
        const user = seedUser();
        const interaction = makeInteraction({ options: { zone: 'the_moon' } });
        await executeZone(interaction, 'set');

        expect(repliedText(interaction)).toContain('Unknown zone.');
        expect(user.save).not.toHaveBeenCalled();
    });

    test('a real but un-unlocked zone points at the shop', async () => {
        const user = seedUser({ unlockedZones: ['beginner_forest'] });
        const interaction = makeInteraction({ options: { zone: 'desert_wastes' } });
        await executeZone(interaction, 'set');

        expect(repliedText(interaction)).toContain('/hunt shop unlock');
        expect(user.save).not.toHaveBeenCalled();
    });

    // Unlocking and the level requirement are separate gates: a prestige resets
    // the level while the unlock list survives, which leaves a hunter holding a
    // zone they can no longer enter.
    test('an unlocked zone above the hunter level is refused on level', async () => {
        const deep = ZONE_LIST.find(z => z.unlockLevel > 1);
        const user = seedUser({
            unlockedZones: ['beginner_forest', deep.id],
            level: deep.unlockLevel - 1,
        });
        const interaction = makeInteraction({ options: { zone: deep.id } });
        await executeZone(interaction, 'set');

        expect(repliedText(interaction)).toContain(`You need Hunter Level **${deep.unlockLevel}**`);
        expect(repliedText(interaction)).toContain(`Level ${deep.unlockLevel - 1}`);
        expect(user.save).not.toHaveBeenCalled();
    });

    test('switching to the zone already active is refused rather than written', async () => {
        const user = seedUser({ activeZone: 'desert_wastes' });
        const interaction = makeInteraction({ options: { zone: 'desert_wastes' } });
        await executeZone(interaction, 'set');

        expect(repliedText(interaction)).toContain('already hunting in');
        expect(user.save).not.toHaveBeenCalled();
        expect(user.hunt.activeZone).toBe('desert_wastes');
    });

    test('a zone with no penalty and no bonus says so rather than rendering a zero', async () => {
        const easy = ZONE_LIST.find(z => z.difficultyMod >= 0 && !(z.payoutBonus > 0) && z.id !== 'beginner_forest')
            ?? ZONES.beginner_forest;
        const user = seedUser({
            unlockedZones: ['desert_wastes', easy.id],
            activeZone: 'desert_wastes',
            level: 99,
        });
        const interaction = makeInteraction({ options: { zone: easy.id } });
        await executeZone(interaction, 'set');

        expect(user.save).toHaveBeenCalled();
        const text = repliedText(interaction);
        expect(text).toContain('No penalty');
        expect(text).toContain('Standard');
    });

    test('a harder zone reports its difficulty and payout bonus', async () => {
        const harsh = ZONE_LIST.find(z => z.difficultyMod < 0 && z.payoutBonus > 0);
        const user = seedUser({
            unlockedZones: ['beginner_forest', harsh.id],
            activeZone: 'beginner_forest',
            level: 99,
        });
        const interaction = makeInteraction({ options: { zone: harsh.id } });
        await executeZone(interaction, 'set');

        expect(user.save).toHaveBeenCalled();
        const text = repliedText(interaction);
        expect(text).toContain(`${Math.round(harsh.difficultyMod * 100)}% success`);
        expect(text).toContain(`+${Math.round(harsh.payoutBonus * 100)}%`);
    });
});
