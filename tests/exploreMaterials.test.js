'use strict';

// #753. Hunting, fishing and mining each drop an unpurchasable companion;
// exploration did not, and could not — `rarePetForSource('explore')` returned
// null because no pet named that source, and no pet could, because a companion
// needs a favourite food and exploration produced nothing feedable. It paid in
// coins, Explorer XP and relics, and relics are the wrong shape: the display
// case pays a standing bonus on *distinct* relics, so eating a duplicate would
// delete part of that bonus.
//
// Exploration has its own fieldcraft materials now, and the Lantern Owl eats
// one of them. These tests hold the join: that the materials exist and drop,
// that the owl's favourite resolves to one, and that the piles the rest of the
// game reads are the piles exploration writes.

const fs = require('fs');
const path = require('path');

const { MATERIAL_RARITY, TIER_LABELS } = require('../src/data/materialRarity');
const { TREASURE_MATERIALS, TREASURE_TIERS } = require('../src/data/exploreData');
const {
    ensureExploreData,
    rollTreasureMaterial,
    grantTreasureMaterial,
    applyExploreXpBonus,
    EXPLORE_MATERIALS_BY_TIER,
} = require('../src/services/exploreService');
const {
    PET_DEFINITIONS,
    rarePetForSource,
    rollRarePet,
    tryGrantRarePet,
    feedPet,
    createPet,
    getTotalBonus,
} = require('../src/services/petService');

const EXPLORE_MATERIALS = Object.entries(MATERIAL_RARITY).filter(([, d]) => d.source === 'explore');

/** A user document stub with only what the exploration service touches. */
function stubUser() {
    const user = { exploration: null, pets: [], markModified: () => {} };
    ensureExploreData(user);
    return user;
}

describe('the fieldcraft materials exploration now drops', () => {
    test('exist, and are tagged to the explore source', () => {
        expect(EXPLORE_MATERIALS.length).toBeGreaterThan(0);
        for (const [id, data] of EXPLORE_MATERIALS) {
            expect([id, data.source]).toEqual([id, 'explore']);
        }
    });

    // Every presentation path — /inventory tabs, /showcase, the /pet feed
    // autocomplete — reads emoji, label and tier off this table. A material
    // missing one renders as a blank row rather than failing loudly.
    test('each carry an emoji, a label and a tier the ladder knows', () => {
        for (const [id, data] of EXPLORE_MATERIALS) {
            expect([id, data.emoji?.length > 0]).toEqual([id, true]);
            expect([id, data.label?.length > 0]).toEqual([id, true]);
            expect([id, TIER_LABELS[data.tier]]).toEqual([id, TIER_LABELS[data.tier]]);
            expect([id, data.tier >= 1 && data.tier <= 5]).toEqual([id, true]);
        }
    });

    test('span the whole rarity ladder, so every treasure tier has something to give', () => {
        expect(Object.keys(EXPLORE_MATERIALS_BY_TIER).map(Number).sort()).toEqual([1, 2, 3, 4, 5]);
    });

    test('collide with no material id another system already uses', () => {
        const ids = EXPLORE_MATERIALS.map(([id]) => id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('the treasure drop table', () => {
    test('covers every treasure tier, and nothing that is not one', () => {
        expect(Object.keys(TREASURE_MATERIALS).sort()).toEqual(TREASURE_TIERS.map(t => t.tier).sort());
    });

    // A tier naming material tiers the catalog has nothing for would roll a
    // drop and then hand back nothing, which reads as a bug in the drop rate.
    test('names only material tiers that exist', () => {
        for (const [tier, table] of Object.entries(TREASURE_MATERIALS)) {
            for (const materialTier of table.tiers) {
                expect([tier, materialTier, (EXPLORE_MATERIALS_BY_TIER[materialTier] ?? []).length > 0])
                    .toEqual([tier, materialTier, true]);
            }
        }
    });

    test('gets more generous, never less, as the treasure gets better', () => {
        const chances = TREASURE_TIERS.map(t => TREASURE_MATERIALS[t.tier].chance);
        expect(chances).toEqual([...chances].sort((a, b) => a - b));
    });

    test('makes a legendary treasure always carry one', () => {
        expect(TREASURE_MATERIALS.legendary.chance).toBe(1);
    });
});

describe('rollTreasureMaterial', () => {
    test('respects the per-tier chance', () => {
        // rng below the chance hits, at or above it misses.
        expect(rollTreasureMaterial('common', () => TREASURE_MATERIALS.common.chance)).toBeNull();
        expect(rollTreasureMaterial('common', () => 0)).not.toBeNull();
    });

    test('only ever returns a material of a tier its table names', () => {
        for (const [tier, table] of Object.entries(TREASURE_MATERIALS)) {
            // Sweep the pool-selection roll across its whole range.
            for (let i = 0; i < 20; i++) {
                const id = rollTreasureMaterial(tier, () => i / 20 * (i === 0 ? 0 : 1) || 0);
                if (!id) continue;
                expect([tier, id, table.tiers.includes(MATERIAL_RARITY[id].tier)])
                    .toEqual([tier, id, true]);
            }
        }
    });

    test('reaches every material in a tier its table names', () => {
        const seen = new Set();
        for (let i = 0; i < 200; i++) seen.add(rollTreasureMaterial('legendary'));
        const reachable = TREASURE_MATERIALS.legendary.tiers.flatMap(t => EXPLORE_MATERIALS_BY_TIER[t]);
        expect([...seen].sort()).toEqual(reachable.sort());
    });

    test('answers null for a tier that is not a treasure tier', () => {
        expect(rollTreasureMaterial('event', () => 0)).toBeNull();
        expect(rollTreasureMaterial(undefined, () => 0)).toBeNull();
    });
});

describe('granting one to an explorer', () => {
    test('seeds the pile on a profile that predates it', () => {
        // GrindProfile.data is schemaless, so an existing explorer has no
        // `materials` key at all until something writes one. No migration ran.
        const user = { exploration: { stamina: 5 }, markModified: () => {} };
        ensureExploreData(user);
        expect(user.exploration.materials).toEqual({});
    });

    test('adds one unit to the explorer pile, not to hunt/fish/mine', () => {
        const user = stubUser();
        const granted = grantTreasureMaterial(user, 'legendary', () => 0);

        expect(granted.id).toBeTruthy();
        expect(user.exploration.materials[granted.id]).toBe(1);
        expect(user.hunt).toBeUndefined();
    });

    test('stacks repeat finds', () => {
        const user = stubUser();
        const first = grantTreasureMaterial(user, 'legendary', () => 0);
        grantTreasureMaterial(user, 'legendary', () => 0);

        expect(user.exploration.materials[first.id]).toBe(2);
    });

    test('returns the catalog entry, so the embed can name what was found', () => {
        const user = stubUser();
        const granted = grantTreasureMaterial(user, 'legendary', () => 0);

        expect(granted).toMatchObject(MATERIAL_RARITY[granted.id]);
        expect(granted.source).toBe('explore');
    });

    test('writes nothing on a miss', () => {
        const user = stubUser();
        expect(grantTreasureMaterial(user, 'common', () => 0.999)).toBeNull();
        expect(user.exploration.materials).toEqual({});
    });
});

describe('the Lantern Owl', () => {
    const owl = PET_DEFINITIONS.lantern_owl;

    test('is the rare companion exploration was missing', () => {
        expect(rarePetForSource('explore')).toEqual(owl);
        expect(owl.purchasable).toBe(false);
        expect(owl.cost).toBeNull();
    });

    // The half-connected shape the issue warned about: a companion whose
    // favourite food does not exist.
    test('has a favourite food that is a real, droppable exploration material', () => {
        const favourite = MATERIAL_RARITY[owl.favoriteMaterial];

        expect(favourite).toBeDefined();
        expect(favourite.source).toBe('explore');
        const droppable = Object.values(TREASURE_MATERIALS).flatMap(t => t.tiers);
        expect(droppable).toContain(favourite.tier);
    });

    test('feeding it its favourite restores more than feeding it anything else', () => {
        const pet = createPet('lantern_owl');
        pet.hunger = 10;

        const favourite = feedPet(pet, owl.favoriteMaterial);
        const other = feedPet(pet, 'survey_chalk');

        expect(favourite.isFavorite).toBe(true);
        expect(other.isFavorite).toBe(false);
        expect(favourite.restored).toBeGreaterThan(other.restored);
    });

    test('drops only from a legendary treasure, at the shared rare-pet rate', () => {
        for (const tier of ['common', 'uncommon', 'rare', 'epic']) {
            expect(rollRarePet([], 'explore', tier, () => 0)).toBeNull();
        }
        expect(rollRarePet([], 'explore', 'legendary', () => 0)).toEqual(owl);
        expect(rollRarePet([], 'explore', 'legendary', () => 0.999)).toBeNull();
    });

    test('is granted at full hunger and never twice', () => {
        const user = { pets: [] };

        expect(tryGrantRarePet(user, 'explore', 'legendary', () => 0)).toEqual(owl);
        expect(user.pets).toHaveLength(1);
        expect(user.pets[0]).toMatchObject({ petId: 'lantern_owl', hunger: 100, level: 1 });

        expect(tryGrantRarePet(user, 'explore', 'legendary', () => 0)).toBeNull();
        expect(user.pets).toHaveLength(1);
    });

    // Exploration coin payouts already run through a rolling daily cap and two
    // standing bonuses, so another yield multiplier there would compound into
    // something the cap eats. The bonus is Explorer XP instead.
    test('pays in Explorer XP rather than coins', () => {
        expect(owl.bonusType).toBe('explore_xp');
        expect(owl.bonusPct).toBeGreaterThan(0);
    });

    test('takes a pet slot from nobody — rare companions are exempt', () => {
        const { hasFreePetSlot } = require('../src/services/petService');
        const user = { pets: [], petSlots: 0 };
        for (let i = 0; i < 3; i++) user.pets.push(createPet('dog'));

        expect(hasFreePetSlot(user)).toBe(false);
        expect(tryGrantRarePet(user, 'explore', 'legendary', () => 0)).toEqual(owl);
    });
});

describe('the Explorer XP passive', () => {
    test('adds its percentage on top of the expedition XP', () => {
        const user = stubUser();
        const result = { xp: 100 };

        const bonus = applyExploreXpBonus(user, result, 15);

        expect(bonus).toBe(15);
        expect(result.xp).toBe(115);
        expect(result.petXp).toBe(15);
    });

    test('credits the bonus to the explorer, not just the result object', () => {
        const user = stubUser();
        const before = user.exploration.xp;

        applyExploreXpBonus(user, { xp: 100 }, 15);

        expect(user.exploration.xp).toBe(before + 15);
    });

    test('does nothing for an expedition that granted no XP', () => {
        const user = stubUser();
        const result = { xp: 0 };

        expect(applyExploreXpBonus(user, result, 15)).toBe(0);
        expect(result.petXp).toBeUndefined();
    });

    test('does nothing for a player with no owl', () => {
        const user = stubUser();
        const result = { xp: 100 };

        expect(applyExploreXpBonus(user, result, 0)).toBe(0);
        expect(result.xp).toBe(100);
    });

    // A hungry pet's passive lapses. getTotalBonus is what the command passes in.
    test('is what a fed owl contributes, and nothing is what a starved one does', () => {
        const fed = createPet('lantern_owl');
        const starved = { ...createPet('lantern_owl'), hunger: 0, lastFed: new Date(0), lastDecayAt: new Date(0) };

        expect(getTotalBonus([fed], 'explore_xp')).toBeGreaterThan(0);
        expect(getTotalBonus([starved], 'explore_xp')).toBe(0);
    });
});

describe('the piles the rest of the game reads', () => {
    const source = file => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');

    // Each of these enumerated the three original systems by name. A fourth
    // source added to MATERIAL_RARITY without them makes the collection
    // denominator unreachable, or — in /inventory's case, which routed by a
    // ternary chain ending in the mining pile — counts explore materials
    // against mining and shows zero forever.
    test('/pet feed draws from the exploration pile', () => {
        expect(source('commands/economy/pet.js')).toContain("const MATERIAL_SYSTEMS = ['hunt', 'fishing', 'mining', 'exploration']");
    });

    test('/showcase counts the exploration pile', () => {
        expect(source('commands/economy/showcase.js')).toContain("const MATERIAL_TRACKS = ['hunt', 'fishing', 'mining', 'exploration']");
    });

    test('/inventory gives exploration a tab of its own', () => {
        const inventory = source('commands/economy/inventory.js');

        expect(inventory).toContain("explore: '🧭 Explore'");
        expect(inventory).toContain('exploration?.materials');
        // The routing that made a fourth source impossible: a ternary chain
        // whose final branch was the mining pile, so anything that was not
        // hunt or fish was counted as mined.
        expect(inventory).toContain('piles[data.source]');
    });
});
