'use strict';

// Server records for /fish cast: the heaviest catch of each species. The check
// used to read the record and then write it, so two catches racing each other
// could both push an entry for the same species, or a lighter fish could land
// its write after a heavier one and overwrite it. Both writes are conditional
// now, and the result says whether this catch set the record — so the cast can
// announce it — and what the standing record is, for the catch card's gauge.

const mockGuild = {
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
    findOne: jest.fn(),
};
jest.mock('../src/models/Guild', () => mockGuild);

const { checkAndUpdateWorldRecord } = require('../src/commands/economy/fish/cast');
const { FISH_WEIGHT_SCALE } = require('../src/data/fishData');

const lean = value => ({ lean: () => Promise.resolve(value) });
const leanCatch = value => ({ lean: () => ({ catch: () => Promise.resolve(value) }) });
const catchOf = weight => ({ fish: 'Pike', weight, userId: 'u2', username: 'bob' });

beforeEach(() => {
    mockGuild.findOneAndUpdate.mockReset();
    mockGuild.updateOne.mockReset();
    mockGuild.findOne.mockReset();
});

test('beating a standing record replaces it and reports the old one', async () => {
    const old = { fish: 'Pike', weight: 10, userId: 'u1', username: 'alice', scale: FISH_WEIGHT_SCALE };
    mockGuild.findOneAndUpdate.mockReturnValue(lean({ fishingWorldRecords: [old] }));

    const out = await checkAndUpdateWorldRecord('g1', catchOf(12));

    expect(out.set).toBe(true);
    expect(out.previous).toEqual(old);
    expect(out.record).toMatchObject({ ...catchOf(12), scale: FISH_WEIGHT_SCALE });
    const [filter, update] = mockGuild.findOneAndUpdate.mock.calls[0];
    // Only a record that is still lighter at write time — or one weighed on an
    // older weight table — can be replaced.
    expect(filter).toEqual({
        guildId: 'g1',
        fishingWorldRecords: { $elemMatch: { fish: 'Pike', $or: [{ weight: { $lt: 12 } }, { scale: { $ne: FISH_WEIGHT_SCALE } }] } },
    });
    expect(update.$set['fishingWorldRecords.$']).toMatchObject({ ...catchOf(12), scale: FISH_WEIGHT_SCALE });
    expect(mockGuild.updateOne).not.toHaveBeenCalled();
});

test('replacing a record from the old weight table is a first record, not a beaten one', async () => {
    const legacy = { fish: 'Pike', weight: 40, userId: 'u1', username: 'alice' };
    mockGuild.findOneAndUpdate.mockReturnValue(lean({ fishingWorldRecords: [legacy] }));

    const out = await checkAndUpdateWorldRecord('g1', catchOf(12));

    expect(out.set).toBe(true);
    expect(out.previous).toBeNull();
});

test('the first of a species is pushed only while no entry for it exists', async () => {
    mockGuild.findOneAndUpdate.mockReturnValue(lean(null));
    mockGuild.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const out = await checkAndUpdateWorldRecord('g1', catchOf(5));

    expect(out).toMatchObject({ set: true, previous: null });
    const [filter, update] = mockGuild.updateOne.mock.calls[0];
    expect(filter).toEqual({ guildId: 'g1', 'fishingWorldRecords.fish': { $ne: 'Pike' } });
    expect(update.$push.fishingWorldRecords).toMatchObject(catchOf(5));
});

test('a catch that beats nothing is not a record, and reports the one that stands', async () => {
    const standing = { fish: 'Pike', weight: 30, userId: 'u1', username: 'alice', scale: FISH_WEIGHT_SCALE };
    mockGuild.findOneAndUpdate.mockReturnValue(lean(null));
    mockGuild.updateOne.mockResolvedValue({ modifiedCount: 0 });
    mockGuild.findOne.mockReturnValue(leanCatch({ fishingWorldRecords: [standing] }));

    expect(await checkAndUpdateWorldRecord('g1', catchOf(3))).toEqual({ set: false, previous: null, record: standing });
});
