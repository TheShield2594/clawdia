'use strict';

const { rollTier, rollOre, hasOreAtDepth } = require('../src/services/mineService');
const { DEPTHS, DEPTH_LIST, ORES_BY_TIER, MINE_QUEST_TEMPLATES } = require('../src/data/mineData');

const TIERS = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'event'];

/** A miner carrying every rarity boost the game can stack onto a tier roll. */
function maxBoostUser() {
    return {
        mining: {
            activeMagnet: 'premium_magnet',
            prestige: 5,
            pickaxes: [{ tier: 5, upgrade: 'gem_lens' }],
            equippedPickaxeIndex: 0,
        },
        accountPrestige: { rank: 10 },
    };
}

describe('depth tier weights', () => {
    test('no depth carries weight on a tier it has no ore for', () => {
        for (const depth of DEPTH_LIST) {
            for (const tier of TIERS) {
                const weight = depth.tierWeights[tier] ?? 0;
                if (weight > 0) {
                    expect([depth.id, tier, hasOreAtDepth(tier, depth.id)]).toEqual([depth.id, tier, true]);
                }
            }
        }
    });

    test('rare-or-better odds rise monotonically with depth', () => {
        const rarePlus = depth => {
            const w = depth.tierWeights;
            const total = TIERS.reduce((s, t) => s + (w[t] ?? 0), 0);
            return (w.rare + w.epic + w.legendary + w.event) / total;
        };
        const ordered = DEPTH_LIST.map(rarePlus);
        for (let i = 1; i < ordered.length; i++) {
            expect(ordered[i]).toBeGreaterThan(ordered[i - 1]);
        }
    });

    test('epic and legendary ore first appear at the depths their quests gate on', () => {
        const questLevel = id => MINE_QUEST_TEMPLATES.find(t => t.id === id).minLevel;
        const firstDepthWith = tier => DEPTH_LIST.find(d => (d.tierWeights[tier] ?? 0) > 0);

        expect(firstDepthWith('epic').unlockLevel).toBe(questLevel('mq_epic_1'));
        expect(firstDepthWith('legendary').unlockLevel).toBe(questLevel('mq_legendary_1'));
    });
});

describe('rollOre stays inside the depth', () => {
    test('a tier the depth cannot produce steps down instead of reaching outside it', () => {
        // The starter quarry has no epic or legendary ore at all.
        for (const tier of ['epic', 'legendary']) {
            const ore = rollOre(tier, 'surface_quarry');
            expect(ore.depths.includes('all') || ore.depths.includes('surface_quarry')).toBe(true);
            expect(TIERS.indexOf(ore.tier)).toBeLessThan(TIERS.indexOf(tier));
        }
    });

    test('a legal tier is still honoured', () => {
        const ore = rollOre('legendary', 'the_abyss');
        expect(ore.tier).toBe('legendary');
    });

    test('every ore the abyss can roll is reachable there', () => {
        const seen = new Set();
        for (let i = 0; i < 5_000; i++) seen.add(rollOre('legendary', 'the_abyss').id);
        const expected = ORES_BY_TIER.legendary
            .filter(o => o.depths.includes('all') || o.depths.includes('the_abyss'))
            .map(o => o.id);
        expect([...seen].sort()).toEqual(expected.sort());
    });
});

describe('rarity boosts cannot resurrect an impossible tier', () => {
    // Every boost in rollTier adds to w.rare/w.epic/w.legendary unconditionally, so
    // without the depth guard a Void Pickaxe would hand out Abyss ore in the quarry.
    test.each(DEPTH_LIST.map(d => [d.id]))('%s never yields out-of-depth ore under max boosts', depthId => {
        const user = maxBoostUser();
        const depth = DEPTHS[depthId];

        for (let i = 0; i < 8_000; i++) {
            const tier = rollTier(user, depth);
            expect(hasOreAtDepth(tier, depthId)).toBe(true);

            const ore = rollOre(tier, depthId);
            expect(ore.depths.includes('all') || ore.depths.includes(depthId)).toBe(true);
        }
    });

    test('the starter quarry never rolls legendary, however boosted', () => {
        const user = maxBoostUser();
        for (let i = 0; i < 20_000; i++) {
            expect(rollTier(user, DEPTHS.surface_quarry)).not.toBe('legendary');
        }
    });
});
