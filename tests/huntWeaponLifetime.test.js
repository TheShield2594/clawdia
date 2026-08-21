'use strict';

// #747 — the shop told a hunter what a top-tier rifle costs at the till, and
// what one repair costs, but never what owning one costs. A weapon is a
// consumable: every shop repair permanently drops maxDurability by 10% of base,
// so the sticker price is a down payment. These cover the projection that puts
// the real number in front of the player, and the repairs-left count that says
// when to stop paying into a worn weapon.

const {
    projectWeaponLifetime,
    repairsRemaining,
    applyRepair,
    isCondemned,
} = require('../src/services/huntService');
const { WEAPON_TIERS, WEAPON_BY_TIER, LIMITS } = require('../src/data/huntData');

const byTier = tier => WEAPON_TIERS.find(w => w.tier === tier);

function freshWeapon(tier) {
    const wd = WEAPON_BY_TIER[tier];
    return {
        tier,
        baseDurability:    wd.baseDurability,
        maxDurability:     wd.baseDurability,
        currentDurability: wd.baseDurability,
        repairCount:       0,
        status:            'good',
    };
}

describe('projectWeaponLifetime', () => {
    it('walks a weapon out to condemnation and totals what it cost', () => {
        const t12 = byTier(12);
        const life = projectWeaponLifetime(t12);

        // Nine repairs, not the "roughly eight" the shop copy used to assert:
        // max durability falls by floor(base * 0.10) each time and condemnation
        // trips below 20% of base, so the ninth repair is the one that ends it.
        expect(life.repairs).toBe(9);
        expect(life.maintenance).toBe(35_000_000);
        expect(life.lifetimeCost).toBe(t12.cost + life.maintenance);
        expect(life.lifetimeCost).toBe(55_000_000);
    });

    it('quotes a first repair that matches what the shop would actually charge', () => {
        const t12 = byTier(12);
        const { firstRepairCost } = projectWeaponLifetime(t12);
        expect(firstRepairCost).toBe(Math.ceil(t12.baseDurability / 20) * t12.repairCostPer20);
    });

    it('makes maintenance the larger half of the bill at the top of the ladder', () => {
        // This is the fact the issue is about: the 20M rifle is the cheap part.
        const life = projectWeaponLifetime(byTier(12));
        expect(life.maintenance).toBeGreaterThan(byTier(12).cost);
    });

    it('agrees with the repair mechanic rather than restating it', () => {
        // Drive the real applyRepair the way the shop does and check the
        // projection landed on the same totals. If the degradation rule, its
        // floor or the condemnation threshold moves, both sides move together.
        for (const wd of WEAPON_TIERS) {
            const sim = freshWeapon(wd.tier);
            sim.currentDurability = 0;
            let repairs = 0, maintenance = 0;
            while (repairs < 100) {
                const r = applyRepair(sim, sim.maxDurability);
                if (r.error) break;
                repairs += 1;
                maintenance += r.cost;
                if (r.condemned) break;
                sim.currentDurability = 0;
            }
            const life = projectWeaponLifetime(wd);
            expect(life.repairs).toBe(repairs);
            expect(life.maintenance).toBe(maintenance);
            expect(isCondemned(sim)).toBe(true);
        }
    });

    it('measures the real commitment in days of hunting, not the sticker price', () => {
        // 250 days was the number the shop quoted. The honest one is closer to
        // 700, and only the second one tells a hunter not to grind toward it.
        const life = projectWeaponLifetime(byTier(12));
        const stickerDays  = byTier(12).cost / LIMITS.DAILY_SOFT_CAP;
        const lifetimeDays = life.lifetimeCost / LIMITS.DAILY_SOFT_CAP;
        expect(Math.round(stickerDays)).toBe(250);
        expect(lifetimeDays).toBeGreaterThan(2 * stickerDays);
    });
});

describe('repairsRemaining', () => {
    it('gives a fresh weapon its whole repair budget', () => {
        for (const wd of WEAPON_TIERS) {
            expect(repairsRemaining(freshWeapon(wd.tier))).toBe(projectWeaponLifetime(wd).repairs);
        }
    });

    it('counts down as the weapon is worn', () => {
        const weapon = freshWeapon(12);
        let previous = repairsRemaining(weapon);
        for (let i = 0; i < 9; i++) {
            weapon.currentDurability = 0;
            const result = applyRepair(weapon, weapon.maxDurability);
            expect(result.error).toBeUndefined();
            const left = repairsRemaining(weapon);
            expect(left).toBe(previous - 1);
            previous = left;
            if (result.condemned) break;
        }
        expect(previous).toBe(0);
    });

    it('reports nothing left for a condemned weapon', () => {
        const weapon = freshWeapon(12);
        weapon.maxDurability = Math.floor(weapon.baseDurability * 0.10);
        expect(isCondemned(weapon)).toBe(true);
        expect(repairsRemaining(weapon)).toBe(0);
    });

    it('does not mutate the weapon it is asked about', () => {
        const weapon = freshWeapon(12);
        const before = { ...weapon };
        repairsRemaining(weapon);
        expect(weapon).toEqual(before);
    });

    it('returns zero for a weapon whose tier is not in the table', () => {
        expect(repairsRemaining({ tier: 99, baseDurability: 100, maxDurability: 100 })).toBe(0);
        expect(repairsRemaining(null)).toBe(0);
    });
});
