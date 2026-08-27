'use strict';

// The Pet Shop footer is the only place in-game that says the rare companions
// exist and where to look for them. It named three pets and three grinds, and
// stayed that way when the Lantern Owl was added (#753) — so the owl, and
// exploration as a place a pet can turn up, went unmentioned everywhere a
// player could see. It is derived from PET_DEFINITIONS now; these lock that in.
const { __test__: { rareCompanionFooter } } = require('../src/commands/economy/pet');
const { PET_DEFINITIONS, RARE_PET_DROP_CHANCE } = require('../src/services/petService');

const rare = Object.values(PET_DEFINITIONS).filter(d => !d.purchasable);

describe('the Pet Shop rare-companion footer', () => {
    test('names every pet that cannot be bought', () => {
        const footer = rareCompanionFooter();
        for (const def of rare) expect(footer).toContain(def.name);
    });

    test('names every grind one can drop from', () => {
        const footer = rareCompanionFooter();
        for (const source of new Set(rare.map(d => d.materialSource))) {
            expect(footer).toContain(source);
        }
    });

    // Substring checks can't do this one — the purchasable Fox lives inside
    // "Crystal Fox" — so read the list back out of the sentence and compare it
    // as a set.
    test('lists the rare companions and nothing else', () => {
        const listed = rareCompanionFooter()
            .replace(/ aren't sold —.*$/, '')
            .split(/, | and /);
        expect(listed.sort()).toEqual(rare.map(d => d.name).sort());
    });

    test('quotes the drop chance from the service', () => {
        expect(rareCompanionFooter()).toContain(`${Math.round(RARE_PET_DROP_CHANCE * 100)}%`);
    });

    test('reads as a sentence, not a bare list', () => {
        expect(rareCompanionFooter()).toMatch(/^Eagle, Shark, Crystal Fox and Lantern Owl aren't sold — /);
    });
});
