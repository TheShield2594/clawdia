'use strict';

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/GrindProfile', () => ({ find: jest.fn(), findOneAndUpdate: jest.fn() }));

const {
    ensureHuntData,
    getMaxStamina,
    applyDurabilityLoss,
    apexNerveAfter,
    apexNerveMax,
    rollTier,
    executeHunt,
    FIELD_TROPHY_FLAGS,
} = require('../src/services/huntService');
const {
    ANIMALS, CRAFT_RECIPES, FIELD_TROPHIES, ZONES, ZONE_LIST,
} = require('../src/data/huntData');
const { CROSS_CRAFT_RECIPES } = require('../src/data/crossSystemData');
const { __test__ } = require('../src/commands/economy/hunt');
const { buildFieldTrophyField } = __test__;

/** Every material any recipe can consume, hunt-side and cross-system. */
function craftableMaterials() {
    const used = new Set();
    for (const recipe of [...Object.values(CRAFT_RECIPES), ...Object.values(CROSS_CRAFT_RECIPES)]) {
        for (const ing of recipe.ingredients ?? []) used.add(ing.material);
    }
    return used;
}

/** Every material a hunt can actually drop. */
function droppableMaterials() {
    const drops = new Set();
    for (const animal of Object.values(ANIMALS)) {
        if (animal.specialDrop) drops.add(animal.specialDrop.itemId);
    }
    return drops;
}

describe('material sinks', () => {
    it('leaves no droppable material without a recipe', () => {
        const used = craftableMaterials();
        const dead = [...droppableMaterials()].filter(m => !used.has(m));
        expect(dead).toEqual([]);
    });

    it('gives every zone past the starter one a recipe fed by its own drops', () => {
        const used = craftableMaterials();
        for (const zone of ZONE_LIST) {
            const fed = zone.zoneMaterials.filter(m => used.has(m));
            expect(fed.length).toBeGreaterThan(0);
        }
    });

    it('never asks for a material that no animal drops', () => {
        const drops = droppableMaterials();
        const phantom = [];
        for (const recipe of Object.values(CRAFT_RECIPES)) {
            for (const ing of recipe.ingredients) {
                if (!drops.has(ing.material)) phantom.push(`${recipe.id}:${ing.material}`);
            }
        }
        expect(phantom).toEqual([]);
    });
});

describe('field trophies', () => {
    function hunter(overrides = {}) {
        const user = { balance: 0, hunt: {}, markModified() {} };
        ensureHuntData(user);
        Object.assign(user.hunt, overrides);
        return user;
    }

    it('defaults every flag to false for a new hunter', () => {
        const user = hunter();
        for (const flag of FIELD_TROPHY_FLAGS) expect(user.hunt[flag]).toBe(false);
    });

    it('has exactly one craftable recipe per trophy', () => {
        for (const flag of FIELD_TROPHY_FLAGS) {
            const recipes = Object.values(CRAFT_RECIPES).filter(r => r.output?.id === flag);
            expect(recipes).toHaveLength(1);
            expect(recipes[0].unique).toBe(true);
            expect(recipes[0].output.type).toBe('hunt_permanent');
        }
    });

    it('sources each zone-bound trophy from that zone\'s own materials', () => {
        for (const [flag, trophy] of Object.entries(FIELD_TROPHIES)) {
            if (!trophy.zone) continue;
            const recipe = Object.values(CRAFT_RECIPES).find(r => r.output?.id === flag);
            const zoneMats = ZONES[trophy.zone].zoneMaterials;
            for (const ing of recipe.ingredients) {
                expect(zoneMats).toContain(ing.material);
            }
        }
    });

    describe('Woodland Instinct', () => {
        it('raises the stamina ceiling by one', () => {
            const without = getMaxStamina(hunter());
            const with_   = getMaxStamina(hunter({ woodlandInstinct: true }));
            expect(with_).toBe(without + 1);
        });
    });

    describe('Insulated Kit', () => {
        const weapon = () => ({ tier: 4, baseDurability: 100, maxDurability: 100, currentDurability: 100 });

        it('shaves a point off a durability hit', () => {
            const w = weapon();
            applyDurabilityLoss(w, 5, 1);
            expect(w.currentDurability).toBe(96);
        });

        it('stacks with a reinforced stock', () => {
            const w = { ...weapon(), upgrade: 'reinforced_stock' };
            applyDurabilityLoss(w, 5, 1);
            expect(w.currentDurability).toBe(97);
        });

        it('never reduces a hit below one point', () => {
            const w = { ...weapon(), upgrade: 'reinforced_stock' };
            applyDurabilityLoss(w, 1, 1);
            expect(w.currentDurability).toBe(99);
        });
    });

    describe("Apex Predator's Mark", () => {
        it('grants a whole extra misread, not a point that rounds away', () => {
            // Nerve is only ever spent two at a time, so +1 would buy nothing.
            expect(apexNerveMax(hunter())).toBe(3);
            expect(apexNerveMax(hunter({ apexPredatorsMark: true }))).toBe(5);
        });

        it('lets a marked hunter survive two misreads that would otherwise bust', () => {
            const misreads = [
                { correct: false, chosen: 'match' },
                { correct: false, chosen: 'match' },
            ];
            expect(apexNerveAfter(misreads, hunter())).toBe(0);
            expect(apexNerveAfter(misreads, hunter({ apexPredatorsMark: true }))).toBeGreaterThan(0);
        });
    });

    describe("Stormcaller's Totem", () => {
        it('puts mythical prey in the starter forest, which otherwise has none', () => {
            expect(ZONES.beginner_forest.tierWeights.event).toBe(0);

            const user = hunter({ stormcallersTotem: true, weapons: [], equippedWeaponIndex: -1 });
            const tiers = new Set();
            for (let i = 0; i < 20_000; i++) tiers.add(rollTier(user, ZONES.beginner_forest));
            expect(tiers.has('event')).toBe(true);
        });

        it('leaves the starter forest free of mythical prey without it', () => {
            const user = hunter({ weapons: [], equippedWeaponIndex: -1 });
            for (let i = 0; i < 5_000; i++) {
                expect(rollTier(user, ZONES.beginner_forest)).not.toBe('event');
            }
        });
    });

    describe("Venom Ward and Swampwalker's Charm", () => {
        /** Run hunts until the trait under test has fired, collecting the messages. */
        function traitMessages(overrides, zoneId, trait, runs = 4000) {
            const messages = [];
            for (let i = 0; i < runs; i++) {
                const user = hunter({
                    level: 50, stamina: 10, activeZone: zoneId, equippedWeaponIndex: 0,
                    weapons: [{
                        tier: 12, name: 'Altair Rifle', upgrade: null, repairCount: 0,
                        baseDurability: 400, maxDurability: 400, currentDurability: 400, status: 'good',
                    }],
                    ...overrides,
                });
                const before = user.hunt.stamina;
                const result = executeHunt(user, zoneId);
                if (!result.traits?.includes(trait)) continue;
                messages.push({
                    success:      result.success,
                    effects:      (result.traitEffects ?? []).map(e => e.msg),
                    staminaSpent: before - user.hunt.stamina,
                    durability:   result.durabilityLost,
                });
            }
            return messages;
        }

        it('spares the extra stamina venomous prey normally costs', () => {
            const plain  = traitMessages({}, 'murky_swamp', 'venomous').filter(m => m.success);
            const warded = traitMessages({ venomWard: true }, 'murky_swamp', 'venomous').filter(m => m.success);

            expect(plain.length).toBeGreaterThan(0);
            expect(warded.length).toBeGreaterThan(0);

            // Unwarded, a venomous kill costs the hunt's point plus one more.
            expect(plain.some(m => m.staminaSpent === 2)).toBe(true);
            // Warded, it never costs more than the hunt itself.
            expect(warded.every(m => m.staminaSpent <= 1)).toBe(true);
            expect(warded.some(m => m.effects.some(msg => msg.includes('Venom Ward')))).toBe(true);
        });

        it('keeps a pack from savaging the weapon on a failed hunt', () => {
            const plain   = traitMessages({}, 'legendary_peaks', 'pack_hunter').filter(m => !m.success);
            const charmed = traitMessages({ swampwalkersCharm: true }, 'legendary_peaks', 'pack_hunter').filter(m => !m.success);

            expect(plain.length).toBeGreaterThan(0);
            expect(charmed.length).toBeGreaterThan(0);

            // The pack adds 3 durability damage on top of the failure severity.
            // Asserted as invariants of every observed failure rather than as a
            // some() over the severity roll: the old check needed at least one
            // severity ≥ 3 among a handful of pack failures, which flaked when
            // the sample ran unlucky (CI run 127). Uncharmed, every pack
            // failure pays at least the minimum severity (1) plus the pack's 3;
            // charmed, the pack never piles on, so the loss stays within the
            // plain severity table (worst case 5).
            expect(plain.every(m => m.durability >= 4)).toBe(true);
            expect(plain.every(m => m.effects.some(msg => msg.includes('pack descended')))).toBe(true);
            expect(charmed.every(m => m.durability <= 5)).toBe(true);
            expect(charmed.every(m => m.effects.some(msg => msg.includes('Swampwalker')))).toBe(true);
        });

        it('halves how often aggressive prey injures a successful hunter', () => {
            const plain   = traitMessages({}, 'murky_swamp', 'aggressive').filter(m => m.success);
            const charmed = traitMessages({ swampwalkersCharm: true }, 'murky_swamp', 'aggressive').filter(m => m.success);

            const injuryRate = rows =>
                rows.filter(m => m.effects.some(msg => msg.includes('injuring you'))).length / rows.length;

            expect(plain.length).toBeGreaterThan(100);
            expect(charmed.length).toBeGreaterThan(100);
            expect(injuryRate(charmed)).toBeLessThan(injuryRate(plain));
        });
    });
});

describe('permanent upgrade profile field', () => {
    it('is omitted for a hunter who owns nothing', () => {
        expect(buildFieldTrophyField({})).toBeNull();
    });

    it('lists what each owned upgrade does', () => {
        const field = buildFieldTrophyField({ woodlandInstinct: true, luckyPaw: true });
        expect(field.name).toContain('2/');
        expect(field.value).toContain('Woodland Instinct');
        expect(field.value).toContain('Lucky Paw');
        expect(field.value).toContain(FIELD_TROPHIES.woodlandInstinct.effect);
    });

    it('stays inside Discord limits with every upgrade owned', () => {
        const everything = { luckyPaw: true, precisionScope: true };
        for (const flag of FIELD_TROPHY_FLAGS) everything[flag] = true;
        const field = buildFieldTrophyField(everything);
        expect(field.value.length).toBeLessThanOrEqual(1024);
        expect(field.name.length).toBeLessThanOrEqual(256);
    });
});
