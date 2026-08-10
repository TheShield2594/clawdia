'use strict';

const { resolvePetRef } = require('../src/services/petService');

const pets = () => [
    { _id: 'aaaaaaaaaaaaaaaaaaaaaaa1', petId: 'dog',  name: 'Biscuit' },
    { _id: 'aaaaaaaaaaaaaaaaaaaaaaa2', petId: 'wolf', name: 'Rex'     },
    { _id: 'aaaaaaaaaaaaaaaaaaaaaaa3', petId: 'cat',  name: null      },
];

describe('resolvePetRef', () => {
    test('resolves the stable id autocomplete sends', () => {
        const p = pets();
        expect(resolvePetRef(p, 'aaaaaaaaaaaaaaaaaaaaaaa2')).toEqual({ index: 1, pet: p[1] });
    });

    test('an id keeps pointing at the same pet after an earlier one is removed', () => {
        // This is the whole point: positional slots silently retargeted here.
        const before = pets();
        const rexId  = String(before[1]._id);
        expect(resolvePetRef(before, rexId).pet.name).toBe('Rex');
        expect(resolvePetRef(before, '1').pet.name).toBe('Rex');

        const after = before.filter(p => p.name !== 'Biscuit'); // Biscuit starves
        expect(resolvePetRef(after, rexId).pet.name).toBe('Rex'); // id still correct
        expect(resolvePetRef(after, '1').pet.name).toBe(null);    // index now the cat
    });

    test('still accepts a bare positional number', () => {
        const p = pets();
        expect(resolvePetRef(p, '0').pet.name).toBe('Biscuit');
        expect(resolvePetRef(p, 2).pet.petId).toBe('cat');
    });

    test('rejects an out-of-range index rather than defaulting', () => {
        expect(resolvePetRef(pets(), '9')).toBeNull();
        expect(resolvePetRef(pets(), '3')).toBeNull();
    });

    test('falls back to a name, case-insensitively', () => {
        expect(resolvePetRef(pets(), 'rex').pet.petId).toBe('wolf');
        expect(resolvePetRef(pets(), 'BISCUIT').pet.petId).toBe('dog');
    });

    test('falls back to a species for unnamed pets', () => {
        expect(resolvePetRef(pets(), 'cat').index).toBe(2);
    });

    test('an unknown reference resolves to nothing', () => {
        expect(resolvePetRef(pets(), 'nobody')).toBeNull();
    });

    test('an omitted reference means the first pet', () => {
        expect(resolvePetRef(pets(), undefined).index).toBe(0);
        expect(resolvePetRef(pets(), null).index).toBe(0);
        expect(resolvePetRef(pets(), '   ').index).toBe(0);
    });

    test('an empty or missing collection resolves to nothing', () => {
        expect(resolvePetRef([], 'anything')).toBeNull();
        expect(resolvePetRef(undefined, '0')).toBeNull();
        expect(resolvePetRef(null, undefined)).toBeNull();
    });

    test('an all-digit id is matched as an id, not as an index', () => {
        const digits = [{ _id: '123456789012345678901234', petId: 'fox', name: 'Sly' }];
        expect(resolvePetRef(digits, '123456789012345678901234').index).toBe(0);
    });
});
