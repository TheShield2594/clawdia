'use strict';

const {
    getRaidableMaterials,
    hasRaidableMaterials,
    planRaidHaul,
    ensureMineData,
    updateMineMap,
    RAID_MAX_MATERIAL_TYPES,
    RAID_MAX_PER_MATERIAL,
    RAID_MIN_HOLDING,
} = require('../src/services/mineService');
const { RAID_STEAL_MIN, RAID_STEAL_MAX } = require('../src/data/mineData');

function makeUser(materials = {}) {
    const user = { mining: { materials }, markModified() {} };
    return user;
}

describe('raidable materials', () => {
    test('ignores anything the miner holds only one of', () => {
        const user = makeUser({ gold_nugget: 1, iron_filing: 4 });
        expect(getRaidableMaterials(user).map(([id]) => id)).toEqual(['iron_filing']);
    });

    test('exposes only the largest piles, largest first', () => {
        const user = makeUser({
            a: 2, b: 9, c: 4, d: 7, e: 3, f: 5, g: 8,
        });
        const exposed = getRaidableMaterials(user);
        expect(exposed).toHaveLength(RAID_MAX_MATERIAL_TYPES);
        expect(exposed.map(([id]) => id)).toEqual(['b', 'g', 'd', 'f', 'c']);
    });

    test('a miner with nothing stacked has nothing to raid', () => {
        expect(hasRaidableMaterials(makeUser({}))).toBe(false);
        expect(hasRaidableMaterials(makeUser({ gold_nugget: 1 }))).toBe(false);
        expect(hasRaidableMaterials(makeUser({ gold_nugget: RAID_MIN_HOLDING }))).toBe(true);
    });
});

describe('raid haul', () => {
    test('never takes more than the per-material cap, however large the hoard', () => {
        const user = makeUser({ gold_nugget: 10_000 });
        const haul = planRaidHaul(user, RAID_STEAL_MAX);
        expect(haul).toEqual([{ matId: 'gold_nugget', take: RAID_MAX_PER_MATERIAL }]);
    });

    test('always takes at least one from an exposed pile', () => {
        // floor(2 * 0.05) is 0 — a raid that reached the pile must still take something.
        const haul = planRaidHaul(makeUser({ gold_nugget: 2 }), RAID_STEAL_MIN);
        expect(haul).toEqual([{ matId: 'gold_nugget', take: 1 }]);
    });

    test('never takes a miner down below what they held', () => {
        const materials = { a: 2, b: 3, c: 12, d: 40, e: 5 };
        for (const fraction of [RAID_STEAL_MIN, 0.12, RAID_STEAL_MAX]) {
            for (const { matId, take } of planRaidHaul(makeUser(materials), fraction)) {
                expect(take).toBeLessThanOrEqual(materials[matId]);
                expect(take).toBeGreaterThan(0);
            }
        }
    });

    test('a raid conserves materials — what the defender loses, the raider gains', () => {
        // The bug this replaces credited the raider from a parallel `oreStash` map
        // while leaving the defender's real pile untouched, minting materials.
        const defender = makeUser({ gold_nugget: 20, iron_filing: 6 });
        const raider = makeUser({ gold_nugget: 1 });

        const before = total(defender) + total(raider);
        for (const { matId, take } of planRaidHaul(defender, RAID_STEAL_MAX)) {
            defender.mining.materials[matId] -= take;
            raider.mining.materials[matId] = (raider.mining.materials[matId] ?? 0) + take;
        }

        expect(total(defender) + total(raider)).toBe(before);
        expect(defender.mining.materials.gold_nugget).toBe(20 - RAID_MAX_PER_MATERIAL);
        expect(raider.mining.materials.gold_nugget).toBe(1 + RAID_MAX_PER_MATERIAL);
    });
});

function total(user) {
    return Object.values(user.mining.materials).reduce((s, q) => s + q, 0);
}

describe('the mine map no longer shadows the material pile', () => {
    test('a material drop is booked once, not once per store', () => {
        const user = { mining: {}, markModified() {} };
        ensureMineData(user);
        user.mining.materials.gold_nugget = 1;

        updateMineMap(user, {
            success: true,
            ore: { id: 'gold', emoji: '🟡' },
            specialDrop: { itemId: 'gold_nugget', name: 'Gold Nugget' },
        });

        expect(user.mining.materials.gold_nugget).toBe(1);
        expect(user.mining.oreStash).toBeUndefined();
    });

    test('the map still records where the miner dug', () => {
        const user = { mining: {}, markModified() {} };
        ensureMineData(user);
        // updateMineMap marks the cell the miner is standing on, then walks them to
        // the next one — so the cell to assert on is the position from before the call.
        const oreCell = user.mining.mineMapRow * 10 + user.mining.mineMapCol;
        updateMineMap(user, { success: true, ore: { id: 'gold' } });
        expect(user.mining.mineMap[oreCell]).toBe(2); // CELL.ORE

        const dugCell = user.mining.mineMapRow * 10 + user.mining.mineMapCol;
        updateMineMap(user, { success: false });
        expect(user.mining.mineMap[dugCell]).toBe(1); // CELL.DUG

        const caveCell = user.mining.mineMapRow * 10 + user.mining.mineMapCol;
        updateMineMap(user, { success: true, caveIn: true, ore: { id: 'gold' } });
        expect(user.mining.mineMap[caveCell]).toBe(3); // CELL.CAVE_IN
    });
});
