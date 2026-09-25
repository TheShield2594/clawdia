'use strict';

// #1184 — the PendingPetBattle schema the restart sweep reads.

const PendingPetBattle = require('../src/models/PendingPetBattle');

test('a pending battle starts with no stakes recorded, and needs its parties and amount', () => {
    const doc = new PendingPetBattle({ battleId: 'b', guildId: 'g', challengerId: 'a', opponentId: 'b', amount: 5 });
    expect(doc.stakes.toObject ? doc.stakes.toObject() : doc.stakes).toEqual([]);
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.validateSync()).toBeUndefined();
    expect(Object.keys(new PendingPetBattle({}).validateSync().errors).sort())
        .toEqual(['amount', 'battleId', 'challengerId', 'guildId', 'opponentId']);
});

test('one entry per battle, expired by a TTL backstop', () => {
    const indexes = PendingPetBattle.schema.indexes();
    expect(indexes).toContainEqual([{ battleId: 1 }, expect.objectContaining({ unique: true })]);
    expect(indexes).toContainEqual([{ createdAt: 1 }, expect.objectContaining({ expireAfterSeconds: 604800 })]);
});
