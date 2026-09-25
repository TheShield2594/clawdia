'use strict';

// /pet codex and the evolution reveal (#1187).

const {
    PET_DEFINITIONS,
    codexSpecies,
    noteCodex,
    tryGrantRarePet,
    rarePetHint,
    applyPetXp,
    evolutionSummary,
    getEffectiveBonusPct,
    xpForLevel,
    createPet,
} = require('../src/services/petService');
const { codexEntries, codexLine } = require('../src/commands/economy/pet/codex');
const { evolutionEmbed } = require('../src/commands/economy/pet/evolution');

const rare = Object.values(PET_DEFINITIONS).filter(d => !d.purchasable);

describe('what the codex counts as owned', () => {
    test('the roster, the memorial and every species ever recorded', () => {
        const seen = codexSpecies({ petCodex: ['cat'], pets: [{ petId: 'dog' }], deceasedPets: [{ petId: 'shark' }] });
        expect([...seen].sort()).toEqual(['cat', 'dog', 'shark']);
    });

    test('noteCodex records each species once', () => {
        const user = { petCodex: [], markModified: jest.fn() };
        noteCodex(user, 'dog');
        noteCodex(user, 'dog');
        expect(user.petCodex).toEqual(['dog']);
    });

    test('a released pet stays in the codex', () => {
        const user = { petCodex: [], pets: [], markModified: jest.fn() };
        tryGrantRarePet(user, 'hunt', 'legendary', () => 0);
        user.pets = []; // released
        expect(codexSpecies(user).has('eagle')).toBe(true);
    });
});

describe('the codex lists every species', () => {
    test('shop and rare, with the right totals', () => {
        const { shop, rare: r, owned, total } = codexEntries({ pets: [{ petId: 'wolf' }] });
        expect(total).toBe(Object.keys(PET_DEFINITIONS).length);
        expect(shop.length + r.length).toBe(total);
        expect(owned).toBe(1);
    });

    test('an unowned rare pet still shows its name and where it comes from', () => {
        const { rare: entries } = codexEntries({});
        for (const e of entries) {
            const line = codexLine(e);
            expect(line).toContain(e.def.name);
            expect(line).toContain('legendary');
            expect(line).toContain(`/${e.def.materialSource}`);
        }
    });

    test('every rare pet has a hint naming its grind', () => {
        for (const def of rare) expect(rarePetHint(def)).toMatch(new RegExp(`^appears on a legendary .+ \\(/${def.materialSource}\\)$`));
    });
});

describe('evolution summary', () => {
    test('reports the titles and passive before and after', () => {
        const pet = { ...createPet('wolf'), name: 'Rex', level: 9, xp: xpForLevel(9) };
        const before = getEffectiveBonusPct(pet);
        const res = applyPetXp(pet, xpForLevel(10) - pet.xp);
        const s = evolutionSummary(pet, res);
        expect(s).toMatchObject({ fromStage: 1, toStage: 2, fromTitle: 'Rex', toTitle: 'Seasoned Rex', bonusType: 'hunt_yield' });
        expect(s.fromPct).toBe(before);
        expect(s.toPct).toBeGreaterThan(s.fromPct);
        expect(s.toEmoji).not.toBe(s.fromEmoji);
    });

    test('is null when the pet did not evolve', () => {
        const pet = createPet('cat');
        expect(evolutionSummary(pet, applyPetXp(pet, 10))).toBeNull();
    });

    test('the reveal embed carries the new title, the stage and both passives', () => {
        const pet = { ...createPet('fox'), name: 'Vix', level: 19, evolutionStage: 2, xp: xpForLevel(19) };
        const s = evolutionSummary(pet, applyPetXp(pet, xpForLevel(20) - pet.xp));
        const json = evolutionEmbed(s, 'u1', 'evolution-card.png').toJSON();
        expect(json.description).toContain('Apex Vix');
        expect(json.fields.map(f => f.value).join(' ')).toContain('2 → **3**');
        expect(json.fields.find(f => f.name.includes('Passive')).value).toMatch(/pts rob success chance → \*\*\+.+pts rob success chance\*\*/);
        expect(json.image.url).toBe('attachment://evolution-card.png');
    });
});
