'use strict';

// `/hunt shop use` and `/mine shop use` (#1134): the status each service gives
// the picker, the rows the shared picker builds from it, and the result embed.
// `/fish shop use` is driven end to end in fishShopCommands.test.js.

const { makeInteraction } = require('./helpers/fakeInteraction');
const huntService = require('../src/services/huntService');
const mineService = require('../src/services/mineService');
const { LIMITS: HUNT_LIMITS } = require('../src/data/huntData');
const { LIMITS: MINE_LIMITS } = require('../src/data/mineData');
const { consumableRows, resolveConsumableId } = require('../src/utils/grindUsePicker');
const { matchesName, rankByName } = require('../src/utils/pickerRank');
const huntUse = require('../src/commands/economy/hunt/shop/use');
const mineUse = require('../src/commands/economy/mine/shop/use');

function hunter(overrides = {}) {
    const user = { markModified: () => {}, save: jest.fn(async () => {}) };
    huntService.ensureHuntData(user);
    Object.assign(user.hunt, { stamina: 5, staminaLastRegen: new Date() }, overrides);
    return user;
}

function miner(overrides = {}) {
    const user = { markModified: () => {}, save: jest.fn(async () => {}) };
    mineService.ensureMineData(user);
    Object.assign(user.mining, { stamina: 5, staminaLastRegen: new Date() }, overrides);
    return user;
}

describe('pickerRank', () => {
    const items = [
        { name: 'Carpet', itemId: 'carpet', ready: true },
        { name: 'Pet Food', itemId: 'pet_food', ready: false },
        { name: 'Apple', itemId: 'fruit_pet', ready: true },
    ];

    test('matches on name or id; empty matches everything', () => {
        expect(items.filter(i => matchesName(i, 'pet')).map(i => i.name)).toEqual(['Carpet', 'Pet Food', 'Apple']);
        expect(items.filter(i => matchesName(i, 'food')).map(i => i.name)).toEqual(['Pet Food']);
        expect(items.filter(i => matchesName(i, ''))).toHaveLength(3);
    });

    test('prefix matches first, then A–Z', () => {
        expect(rankByName(items, 'pet').map(i => i.name)).toEqual(['Pet Food', 'Apple', 'Carpet']);
        expect(rankByName(items, '').map(i => i.name)).toEqual(['Apple', 'Carpet', 'Pet Food']);
    });

    test('an optional first key leads, ahead of the prefix', () => {
        expect(rankByName(items, 'pet', { first: i => i.ready }).map(i => i.name))
            .toEqual(['Apple', 'Carpet', 'Pet Food']);
    });

    test('never sorts the caller\'s array in place', () => {
        const copy = [...items];
        rankByName(items, 'pet');
        expect(items).toEqual(copy);
    });
});

describe('huntService.consumableStatus', () => {
    const status = (user, id) => huntService.consumableStatus(user, id);

    test('a bait or charm lasts some hunts, and is blocked while one runs', () => {
        expect(status(hunter(), 'basic_bait')).toEqual({ ready: true, status: 'lasts 3 hunts' });
        expect(status(hunter(), 'luck_charm')).toEqual({ ready: true, status: 'lasts 5 hunts' });

        const baited = hunter({ activeBait: 'basic_bait', activeBaitHuntsLeft: 2 });
        expect(status(baited, 'basic_bait')).toEqual({ ready: false, status: 'active · 2 hunts left' });
        expect(status(baited, 'premium_bait')).toEqual({ ready: false, status: 'Basic Bait active · 2 hunts left' });

        const charmed = hunter({ activeCharm: 'luck_charm', activeCharmHuntsLeft: 1 });
        expect(status(charmed, 'luck_charm')).toEqual({ ready: false, status: 'active · 1 hunt left' });
    });

    test('focus and the XP scroll queue for the next hunt', () => {
        expect(status(hunter(), 'hunters_focus')).toEqual({ ready: true, status: 'applies to your next hunt' });
        expect(status(hunter({ activeFocus: true }), 'hunters_focus')).toEqual({ ready: false, status: 'queued for your next hunt' });
        expect(status(hunter({ activeXpScroll: true }), 'xp_scroll').ready).toBe(false);
    });

    test('a tonic shows the bar, and is blocked when full or at the daily limit', () => {
        const max = huntService.getMaxStamina(hunter());
        expect(status(hunter({ stamina: 2 }), 'stamina_tonic')).toEqual({ ready: true, status: `stamina 2/${max} · +3` });
        expect(status(hunter({ stamina: max }), 'stamina_tonic')).toEqual({ ready: false, status: `stamina full · ${max}/${max}` });

        const limit = HUNT_LIMITS.STAMINA_TONICS_PER_DAY;
        const capped = hunter({ stamina: 0, staminaTonicsToday: limit, lastTonicDayReset: new Date(), dailyWindowStart: new Date(Date.now() - 1000) });
        expect(status(capped, 'stamina_tonic')).toEqual({ ready: false, status: `daily limit reached · ${limit}/${limit} today` });

        // A count from before the current window started is yesterday's.
        const stale = hunter({ stamina: 0, staminaTonicsToday: limit, lastTonicDayReset: new Date(Date.now() - 5000), dailyWindowStart: new Date() });
        expect(status(stale, 'stamina_tonic').ready).toBe(true);
    });

    test('agrees with activateConsumable on every activatable item', () => {
        const stock = Object.fromEntries(huntUse.USE_PICKER.activatable.map(id => [id, 1]));
        const states = [
            {},
            { activeBait: 'premium_bait', activeBaitHuntsLeft: 1, activeCharm: 'luck_charm', activeCharmHuntsLeft: 2,
                activeFocus: true, activeXpScroll: true, stamina: 99 },
        ];
        for (const state of states) {
            for (const id of huntUse.USE_PICKER.activatable) {
                const user = hunter({ consumables: { ...stock }, ...state });
                const expected = status(user, id).ready;
                expect([id, huntService.activateConsumable(user, id).success]).toEqual([id, expected]);
            }
        }
    });

    test('a repair kit or an unknown id is never ready', () => {
        expect(status(hunter(), 'repair_kit_small')).toEqual({ ready: false, status: 'use it with /hunt shop repair' });
        expect(status(hunter(), 'nope').ready).toBe(false);
    });
});

describe('huntService.activateConsumable and stamina regen', () => {
    test('a tonic is judged on the regenerated bar, not the stored one', () => {
        const max = huntService.getMaxStamina(hunter());
        // Stored one short of full, but a full regen interval has passed.
        const user = hunter({
            consumables: { stamina_tonic: 1 },
            stamina: max - 1,
            staminaLastRegen: new Date(Date.now() - HUNT_LIMITS.STAMINA_REGEN_MS - 1000),
        });
        const result = huntService.activateConsumable(user, 'stamina_tonic');
        expect(result).toEqual({ success: false, error: 'Your stamina is already full.' });
        expect(user.hunt.consumables.stamina_tonic).toBe(1);
    });
});

describe('mineService.consumableStatus', () => {
    const status = (user, id) => mineService.consumableStatus(user, id);

    test('magnets and lamps last some mines, and are blocked while one runs', () => {
        expect(status(miner(), 'ore_magnet')).toEqual({ ready: true, status: 'lasts 3 mines' });
        const running = miner({ activeMagnet: 'premium_magnet', activeMagnetMinesLeft: 2 });
        expect(status(running, 'ore_magnet')).toEqual({ ready: false, status: 'Premium Magnet active · 2 mines left' });
        expect(status(miner({ activeLamp: 'miners_lamp', activeLampMinesLeft: 1 }), 'miners_lamp'))
            .toEqual({ ready: false, status: 'active · 1 mine left' });
    });

    test('the reinforced trap and the mine lock', () => {
        expect(status(miner(), 'reinforced_trap')).toEqual({ ready: true, status: 'lasts 10 mines' });
        expect(status(miner({ activeReinforcedTrapMinesLeft: 4 }), 'reinforced_trap')).toEqual({ ready: false, status: 'active · 4 mines left' });
        expect(status(miner(), 'mine_lock')).toEqual({ ready: true, status: 'arms against the next raid' });
        expect(status(miner({ mineLockActive: true }), 'mine_lock')).toEqual({ ready: false, status: 'armed until a raider trips it' });
    });

    test('a tonic at the daily limit', () => {
        const limit = MINE_LIMITS.ENERGY_TONICS_PER_DAY;
        const user = miner({ stamina: 0, energyTonicsToday: limit, lastTonicDayReset: new Date() });
        expect(status(user, 'energy_tonic')).toEqual({ ready: false, status: `daily limit reached · ${limit}/${limit} today` });
        // Yesterday's window no longer counts.
        const old = miner({ stamina: 0, energyTonicsToday: limit, lastTonicDayReset: new Date(Date.now() - MINE_LIMITS.DAILY_WINDOW_MS - 1) });
        expect(status(old, 'energy_tonic').ready).toBe(true);
    });

    test('agrees with activateConsumable on every activatable item', () => {
        const stock = Object.fromEntries(mineUse.USE_PICKER.activatable.map(id => [id, 1]));
        const states = [
            {},
            { activeMagnet: 'ore_magnet', activeMagnetMinesLeft: 1, activeLamp: 'miners_lamp', activeLampMinesLeft: 1,
                activeInstinct: true, activeXpScroll: true, activeReinforcedTrapMinesLeft: 2, mineLockActive: true, stamina: 99 },
        ];
        for (const state of states) {
            for (const id of mineUse.USE_PICKER.activatable) {
                const user = miner({ consumables: { ...stock }, ...state });
                const expected = status(user, id).ready;
                expect([id, mineService.activateConsumable(user, id).success]).toEqual([id, expected]);
            }
        }
    });
});

describe('the shared picker rows', () => {
    test('held only, ready first, with count and status', () => {
        const user = hunter({
            consumables: { basic_bait: 2, luck_charm: 0, hunters_focus: 1, stamina_tonic: 1 },
            activeFocus: true,
            stamina: 0,
        });
        const rows = consumableRows(user, huntUse.USE_PICKER, '');
        expect(rows.map(r => [r.itemId, r.quantity, r.ready])).toEqual([
            ['basic_bait', 2, true],
            ['stamina_tonic', 1, true],
            ['hunters_focus', 1, false],
        ]);
    });

    test('a typed name or id narrows it', () => {
        const user = hunter({ consumables: { basic_bait: 1, premium_bait: 1, xp_scroll: 1 } });
        expect(consumableRows(user, huntUse.USE_PICKER, 'bait').map(r => r.itemId)).toEqual(['basic_bait', 'premium_bait']);
        expect(consumableRows(user, huntUse.USE_PICKER, 'xp_').map(r => r.itemId)).toEqual(['xp_scroll']);
    });

    test('a submitted value resolves by id, then by name, else passes through', () => {
        expect(resolveConsumableId('luck_charm', huntUse.USE_PICKER)).toBe('luck_charm');
        expect(resolveConsumableId(' Luck CHARM ', huntUse.USE_PICKER)).toBe('luck_charm');
        expect(resolveConsumableId('Ore Magnet', mineUse.USE_PICKER)).toBe('ore_magnet');
        expect(resolveConsumableId('nope', huntUse.USE_PICKER)).toBe('nope');
    });
});

describe('the result embed', () => {
    test('/hunt shop use says what is left in the bag', async () => {
        const user = hunter({ consumables: { luck_charm: 3 } });
        const interaction = makeInteraction({ options: { item: 'Luck Charm' } });
        await huntUse.handleUse(interaction, user);
        expect(user.save).toHaveBeenCalled();
        const embed = interaction.replies[0].embeds[0].data;
        expect(embed.title).toBe('🍀 Luck Charm Activated!');
        expect(embed.fields).toEqual([{ name: '🎒 Left in bag', value: '2x', inline: true }]);
    });

    test('/mine shop use says what is left in the bag', async () => {
        const user = miner({ consumables: { mine_lock: 1 } });
        const interaction = makeInteraction({ options: { item: 'mine_lock' } });
        await mineUse.handleUse(interaction, user);
        expect(interaction.replies[0].embeds[0].data.fields).toEqual([{ name: '🎒 Left in bag', value: '0x', inline: true }]);
    });

    test('a refusal says nothing was used, and saves nothing', async () => {
        const user = hunter({ consumables: { luck_charm: 1 }, activeCharm: 'luck_charm', activeCharmHuntsLeft: 2 });
        const interaction = makeInteraction({ options: { item: 'luck_charm' } });
        await huntUse.handleUse(interaction, user);
        expect(interaction.replies[0].content).toMatch(/already have .* active.*Nothing was used\.$/);
        expect(user.save).not.toHaveBeenCalled();
        expect(user.hunt.consumables.luck_charm).toBe(1);
    });
});
