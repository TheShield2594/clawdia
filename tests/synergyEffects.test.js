'use strict';

// Every synergy in crossSystemData is advertised by /synergies, /mine profile and
// FEATURES.md. Several of them had a helper in synergyService and no call site at
// all, so a player could see "Artificer — +5% ore yield, +1 max mining stamina"
// listed as active and get neither. These tests pin each advertised bonus to the
// code path that pays it out.

const { getMaxStamina: mineMaxStamina } = require('../src/services/mineService');
const { getMaxStamina: fishMaxStamina } = require('../src/services/fishService');
const {
    getActiveSynergies,
    getArtificerMineYieldBonus,
    getMerchantCoinBonus,
} = require('../src/services/synergyService');
const { SYNERGIES, SYNERGY_LIST } = require('../src/data/crossSystemData');
const { LIMITS } = require('../src/data/mineData');

/** A player at the given grind levels, with nothing else going on. */
function player({ hunt = 0, fishing = 0, mining = 0, inventory = [] } = {}) {
    return {
        hunt:    { level: hunt,    prestige: 0 },
        fishing: { level: fishing, prestige: 0 },
        mining:  { level: mining,  prestige: 0 },
        inventory,
    };
}

describe('mining stamina synergies', () => {
    test('a miner below the thresholds gets the base pool', () => {
        expect(mineMaxStamina(player({ mining: 29, fishing: 29 }))).toBe(LIMITS.MAX_STAMINA_BASE);
    });

    test('Deep Prospector adds its advertised +1', () => {
        const p = player({ mining: 30, fishing: 30 });
        expect(getActiveSynergies(p).map(s => s.id)).toContain('deep_prospector');
        expect(mineMaxStamina(p)).toBe(LIMITS.MAX_STAMINA_BASE + SYNERGIES.deep_prospector.bonuses.miningStamina);
    });

    test('Artificer adds its advertised +1', () => {
        const p = player({ mining: 50 });
        expect(getActiveSynergies(p).map(s => s.id)).toContain('artificer');
        expect(mineMaxStamina(p)).toBe(LIMITS.MAX_STAMINA_BASE + SYNERGIES.artificer.bonuses.miningStamina);
    });

    test('both stack for a miner who has earned both', () => {
        const expected = LIMITS.MAX_STAMINA_BASE
            + SYNERGIES.deep_prospector.bonuses.miningStamina
            + SYNERGIES.artificer.bonuses.miningStamina;
        expect(mineMaxStamina(player({ mining: 50, fishing: 30 }))).toBe(expected);
    });
});

describe('fishing stamina synergies', () => {
    test('Outdoorsman and Deep Prospector both apply, and stack', () => {
        const outdoorsmanOnly = player({ fishing: 30, hunt: 30 });
        const both            = player({ fishing: 30, hunt: 30, mining: 30 });

        expect(fishMaxStamina(outdoorsmanOnly))
            .toBe(LIMITS.MAX_STAMINA_BASE + SYNERGIES.outdoorsman.bonuses.fishingStamina);
        expect(fishMaxStamina(both)).toBe(
            LIMITS.MAX_STAMINA_BASE
            + SYNERGIES.outdoorsman.bonuses.fishingStamina
            + SYNERGIES.deep_prospector.bonuses.fishingStamina,
        );
    });
});

describe('Artificer ore yield', () => {
    test('pays nothing below Mining 50 and the advertised rate at 50', () => {
        expect(getArtificerMineYieldBonus(player({ mining: 49 }))).toBe(0);
        expect(getArtificerMineYieldBonus(player({ mining: 50 }))).toBe(SYNERGIES.artificer.bonuses.mineYieldPct);
    });
});

describe('Merchant coin bonus', () => {
    const qualified = extra => player({ hunt: 20, fishing: 20, mining: 20, ...extra });

    test('needs the levels and something in the bag', () => {
        expect(getMerchantCoinBonus(qualified({ inventory: [] }))).toBe(0);
        expect(getMerchantCoinBonus(qualified({ inventory: [{ quantity: 0 }] }))).toBe(0);
        expect(getMerchantCoinBonus(qualified({ inventory: [{ quantity: 1 }] })))
            .toBe(SYNERGIES.merchant.bonuses.workCrimeCoinPct);
    });

    test('does not pay below the level requirement', () => {
        const under = player({ hunt: 20, fishing: 20, mining: 19, inventory: [{ quantity: 5 }] });
        expect(getMerchantCoinBonus(under)).toBe(0);
    });
});

describe('no advertised synergy is left unwired', () => {
    // A synergy whose bonuses nothing reads is a promise the game cannot keep. If a
    // new one is added, wire it up (and assert it here) rather than relaxing this.
    const WIRED = {
        outdoorsman:     ['huntStamina', 'fishingStamina'],
        iron_will:       ['mineIronWill'],
        deep_prospector: ['fishingStamina', 'miningStamina'],
        artificer:       ['mineYieldPct', 'miningStamina'],
        merchant:        ['workCrimeCoinPct'],
    };

    test.each(SYNERGY_LIST.map(s => [s.id]))('%s has every bonus key accounted for', id => {
        expect(Object.keys(SYNERGIES[id].bonuses).sort()).toEqual(WIRED[id].sort());
    });
});
