'use strict';

/**
 * A User save never writes `pets` or `deceasedPets` back whole
 * (src/models/petWrites.js). Each test loads a document, lets one of the
 * atomic pet writers land — the Pet of the Week ribbon, a ladder title, a
 * revive's `$push`/`$pull` — and then saves the stale document the way a /pet
 * command does. Before the change, every one of these erased the atomic
 * write: `markModified('pets')` (or any save that both edited a pet and added
 * or removed one) wrote the loaded snapshot over it.
 *
 * Against a real mongod, because what is at stake is which update the server
 * receives and what it does with it.
 */

const { useMongo } = require('../helpers/mongo');

useMongo();

const User = require('../../src/models/User');
const { __test__: { canonical } } = require('../../src/models/petWrites');
const { recordMissionDeal } = require('../../src/models/seasonWrites');

const filter = { userId: 'u1', guildId: 'g1' };

async function seed(extra = {}) {
    await User.create({
        ...filter,
        pets: [{ petId: 'dog', name: 'Rex' }, { petId: 'cat', name: 'Tom' }],
        deceasedPets: [{ petId: 'fox', name: 'Red' }],
        ...extra,
    });
    return User.findOne(filter);
}

/** The atomic writes a command's save must not undo. */
async function concurrentWriters() {
    await User.updateOne({ ...filter, 'pets.petId': 'cat' }, { $set: { 'pets.$.potw': true, 'pets.$.ladderTitle': 'S1 Ladder Champion' } });
    // A revive: the memorial record out, the pet back in.
    await User.updateOne(filter, {
        $pull: { deceasedPets: { petId: 'fox' } },
        $push: { pets: { petId: 'fox', name: 'Red' } },
    });
}

const stored = () => User.findOne(filter).lean();
const byName = (doc, name) => doc.pets.find(p => p.name === name);

describe('a save writes only what the flow changed in the pet arrays', () => {
    test('a field edit with markModified keeps a concurrent ribbon, title and revived pet', async () => {
        const user = await seed();
        await concurrentWriters();

        user.pets[0].hunger = 40;
        user.markModified('pets');
        await user.save();

        const after = await stored();
        expect(byName(after, 'Rex').hunger).toBe(40);
        expect(byName(after, 'Tom')).toMatchObject({ potw: true, ladderTitle: 'S1 Ladder Champion' });
        expect(byName(after, 'Red')).toBeDefined();
        expect(after.deceasedPets).toHaveLength(0);
    });

    test('an edit plus an adoption (Mongoose would write the array whole) keeps them too', async () => {
        const user = await seed();
        await concurrentWriters();

        user.pets[0].level = 7;
        user.pets.push({ petId: 'wolf', name: 'Ghost' });
        await user.save();

        const after = await stored();
        expect(after.pets.map(p => p.name).sort()).toEqual(['Ghost', 'Red', 'Rex', 'Tom']);
        expect(byName(after, 'Rex').level).toBe(7);
        expect(byName(after, 'Tom').potw).toBe(true);
    });

    test('a runaway moves the pet to the memorial without restoring a revived record', async () => {
        const user = await seed();
        await concurrentWriters();

        // syncHungerAndRunaway's shape: snapshot to the front, trim, pull.
        const gone = user.pets[0].toObject();
        delete gone._id;
        user.deceasedPets.unshift({ ...gone, diedAt: new Date() });
        user.deceasedPets = user.deceasedPets.slice(0, User.DECEASED_PET_LIMIT);
        user.markModified('deceasedPets');
        user.pets.pull(user.pets[0]._id);
        user.pets[0].hunger = 25;
        user.markModified('pets');
        await user.save();

        const after = await stored();
        expect(after.pets.map(p => p.name).sort()).toEqual(['Red', 'Tom']);
        expect(byName(after, 'Tom')).toMatchObject({ hunger: 25, potw: true });
        // Red was revived meanwhile; only the new runaway is in the memorial.
        expect(after.deceasedPets.map(p => p.name)).toEqual(['Rex']);
    });

    test('the memorial keeps its newest-first order and its limit', async () => {
        const dead = Array.from({ length: User.DECEASED_PET_LIMIT }, (_, i) => ({ petId: 'dog', name: `Old${i}` }));
        const user = await seed({ deceasedPets: dead });

        user.deceasedPets.unshift({ petId: 'cat', name: 'Newest', diedAt: new Date() });
        user.deceasedPets = user.deceasedPets.slice(0, User.DECEASED_PET_LIMIT);
        await user.save();

        const after = await stored();
        expect(after.deceasedPets).toHaveLength(User.DECEASED_PET_LIMIT);
        expect(after.deceasedPets[0].name).toBe('Newest');
        expect(after.deceasedPets.map(p => p.name)).not.toContain(`Old${User.DECEASED_PET_LIMIT - 1}`);
    });

    test('an edit to a pet another writer removed is dropped, not resurrected', async () => {
        const user = await seed();
        await User.updateOne(filter, { $pull: { pets: { name: 'Rex' } } });

        user.pets[0].hunger = 10;
        user.markModified('pets');
        await user.save();

        expect((await stored()).pets.map(p => p.name)).toEqual(['Tom']);
    });

    test('a second save of the same document diffs from what the first one stored', async () => {
        const user = await seed();
        user.pets[0].level = 3;
        await user.save();
        await User.updateOne({ ...filter, 'pets.name': 'Rex' }, { $set: { 'pets.$.potw': true } });

        user.pets[1].level = 9;
        await user.save();

        const after = await stored();
        expect(byName(after, 'Rex')).toMatchObject({ level: 3, potw: true });
        expect(byName(after, 'Tom').level).toBe(9);
    });

    test('a rare drop goes out in the same write as the rest of the save', async () => {
        const user = await seed({ balance: 0 });
        await concurrentWriters();
        const writes = [];
        const real = User.updateOne.bind(User);
        const spy = jest.spyOn(User, 'updateOne').mockImplementation((...a) => { writes.push(a); return real(...a); });
        try {
            user.balance = 250;
            user.pets.push({ petId: 'eagle', name: 'Sky' });
            user.markModified('pets');
            await user.save();
        } finally {
            spy.mockRestore();
        }
        // Nothing after the save: the push rode the save's own update, so a
        // failure cannot store the hunt and drop the pet, or the other way round.
        expect(writes).toHaveLength(0);
        const after = await stored();
        expect(after.balance).toBe(250);
        expect(after.pets.map(p => p.name).sort()).toEqual(['Red', 'Rex', 'Sky', 'Tom']);
    });

    test('field edits on a marked array also go out with the save, as per-field paths', async () => {
        const user = await seed();
        await concurrentWriters();
        const writes = [];
        const real = User.updateOne.bind(User);
        const spy = jest.spyOn(User, 'updateOne').mockImplementation((...a) => { writes.push(a); return real(...a); });
        try {
            user.pets[1].level = 4;
            user.markModified('pets');
            await user.save();
        } finally {
            spy.mockRestore();
        }
        expect(writes).toHaveLength(0);
        expect(byName(await stored(), 'Tom')).toMatchObject({ level: 4, potw: true });
    });

    test('a runaway leaves the pets list and enters the memorial in one write', async () => {
        const user = await seed();
        const gone = user.pets[0].toObject();
        delete gone._id;
        user.deceasedPets.unshift({ ...gone, diedAt: new Date() });
        user.markModified('deceasedPets');
        user.pets.pull(user.pets[0]._id);
        user.pets[0].hunger = 25;
        user.markModified('pets');

        const real = User.updateOne.bind(User);
        const spy = jest.spyOn(User, 'updateOne').mockImplementation((f, u, o) => (
            u.$pull ? Promise.reject(new Error('write failed')) : real(f, u, o)
        ));
        try {
            await expect(user.save()).rejects.toThrow('write failed');
        } finally {
            spy.mockRestore();
        }
        // Not half done: the pet is still a pet, and no memorial record was made.
        const after = await stored();
        expect(after.pets.map(p => p.name)).toContain('Rex');
        expect(after.deceasedPets.map(p => p.name)).toEqual(['Red']);
    });

    test('a full memorial is trimmed against what is stored, not pulled from the snapshot', async () => {
        const dead = Array.from({ length: User.DECEASED_PET_LIMIT }, (_, i) => ({ petId: 'dog', name: `Old${i}` }));
        const user = await seed({ deceasedPets: dead });
        // A revive takes one record while the runaway is being worked out.
        await User.updateOne(filter, { $pull: { deceasedPets: { name: 'Old1' } } });

        user.deceasedPets.unshift({ petId: 'cat', name: 'Newest', diedAt: new Date() });
        user.deceasedPets = user.deceasedPets.slice(0, User.DECEASED_PET_LIMIT);
        user.markModified('deceasedPets');
        await user.save();

        // The tail record the snapshot would have trimmed still fits, so it stays.
        const names = (await stored()).deceasedPets.map(p => p.name);
        expect(names).toEqual(['Newest', 'Old0', 'Old2', 'Old3', 'Old4']);
    });

    test('nested fields such as training are written', async () => {
        const user = await seed();
        user.pets[0].training = { power: 2, guard: 1, agility: 0 };
        await user.save();
        expect(byName(await stored(), 'Rex').training).toEqual({ power: 2, guard: 1, agility: 0 });
    });
});

describe('the guards around it still hold', () => {
    test('two saves of the same document still lose a version race', async () => {
        await seed();
        const a = await User.findOne(filter);
        const b = await User.findOne(filter);
        a.pets[0].hunger = 1;
        await a.save();
        b.pets[0].hunger = 2;
        await expect(b.save()).rejects.toMatchObject({ name: 'VersionError' });
        expect(byName(await stored(), 'Rex').hunger).toBe(1);
    });

    test('schema validation still rejects a bad pet field', async () => {
        const user = await seed();
        user.pets[0].hunger = 150;
        await expect(user.save()).rejects.toThrow(/hunger/);
        expect(byName(await stored(), 'Rex').hunger).toBe(100);
    });

    test('a pet write that fails rejects the save, after the season commit has run', async () => {
        const user = await seed();
        // An edit with an adoption is the shape that needs a write after the save.
        user.pets[0].hunger = 5;
        user.pets.push({ petId: 'wolf', name: 'Ghost' });
        const dealt = new Date('2026-11-05T00:00:00Z');
        recordMissionDeal(user, [], dealt);
        const real = User.updateOne.bind(User);
        const spy = jest.spyOn(User, 'updateOne').mockImplementation((f, u, o) => (
            JSON.stringify(u).includes('$[') ? Promise.reject(new Error('write failed')) : real(f, u, o)
        ));
        try {
            await expect(user.save()).rejects.toThrow('write failed');
        } finally {
            spy.mockRestore();
        }
        expect((await stored()).seasonMissionsDate).toEqual(dealt);
    });

    test('a new document is inserted with its pets', async () => {
        const user = new User({ ...filter, pets: [{ petId: 'dog', name: 'Rex' }] });
        await user.save();
        user.pets[0].hunger = 60;
        await user.save();
        expect(byName(await stored(), 'Rex').hunger).toBe(60);
    });

    test('a pet stored without an _id is written whole once, which stores the id', async () => {
        await User.collection.insertOne({ ...filter, pets: [{ petId: 'dog', name: 'Rex', hunger: 100 }], __v: 0 });
        const user = await User.findOne(filter);
        user.pets[0].hunger = 30;
        await user.save();

        const raw = await User.collection.findOne(filter);
        expect(raw.pets[0]).toMatchObject({ hunger: 30, _id: expect.anything() });

        const again = await User.findOne(filter);
        again.pets[0].level = 4;
        await again.save();
        expect(byName(await stored(), 'Rex')).toMatchObject({ hunger: 30, level: 4 });
    });
});

describe('canonical values', () => {
    test('equal dates and ids compare equal, different ones do not', () => {
        expect(canonical(new Date(5))).toBe(canonical(new Date(5)));
        expect(canonical(new Date(5))).not.toBe(canonical(new Date(6)));
        expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
        expect(canonical(null)).toBe(canonical(null));
        expect(canonical(undefined)).toBeUndefined();
    });
});
