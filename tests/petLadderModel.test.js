'use strict';

// #1185 — the PetLadder schema: one document per guild, a fresh ladder with
// its own empty ratings map, kept even when empty so the dotted conditional
// writes on `ratings.<petId>` always have a parent to land in.

const PetLadder = require('../src/models/PetLadder');

test('a new ladder starts at season 1 with its own empty ratings', () => {
    const a = new PetLadder({ guildId: 'g1' });
    const b = new PetLadder({ guildId: 'g2' });

    expect(a.seasonNumber).toBe(1);
    expect(a.rev).toBe(0);
    expect(a.ratings).toEqual({});
    expect(a.ratings).not.toBe(b.ratings);
    expect(a.toObject().ratings).toEqual({});
    expect(a.validateSync()).toBeUndefined();
});

test('a ladder needs its guild', () => {
    expect(new PetLadder({}).validateSync().errors.guildId).toBeDefined();
});

test('one ladder per guild, and the rollover query is indexed', () => {
    const indexes = PetLadder.schema.indexes();
    expect(indexes).toContainEqual([{ guildId: 1 }, expect.objectContaining({ unique: true })]);
    expect(indexes.map(([keys]) => keys)).toContainEqual({ seasonEndsAt: 1 });
});
