'use strict';

/**
 * The two helpers #786 added are mocks, and a mock that answers wrongly turns a
 * refusal test green without anyone noticing. These pin the parts of their
 * contract the command suites lean on hardest and cannot themselves observe.
 */

const { fakeCollection } = require('./helpers/fakeCollection');
const { makeInteraction } = require('./helpers/fakeInteraction');

describe('fakeCollection upserts', () => {
    let users;

    beforeEach(() => {
        users = fakeCollection('User', { balance: 0, inventory: [] });
    });

    it('creates the row from the filter when findOneAndUpdate misses', async () => {
        const doc = await users.model.findOneAndUpdate(
            { userId: 'u1', guildId: 'g1' },
            { $setOnInsert: { userId: 'u1', guildId: 'g1' }, $inc: { balance: 5 } },
            { upsert: true, new: true },
        );

        expect(doc).toMatchObject({ userId: 'u1', guildId: 'g1', balance: 5 });
        expect(users.get('u1').balance).toBe(5);
    });

    it('creates it for updateOne too, rather than reporting no match', async () => {
        // /gift uses `updateOne(filter, {}, { upsert: true })` to make sure the
        // recipient exists before crediting them. A mock that answered
        // matchedCount 0 here would read as a refusal the real call never makes.
        const result = await users.model.updateOne(
            { userId: 'u2', guildId: 'g1' }, {}, { upsert: true },
        );

        expect(result).toEqual({ matchedCount: 0, modifiedCount: 0, upsertedCount: 1 });
        expect(users.get('u2')).toMatchObject({ userId: 'u2', guildId: 'g1', balance: 0 });
    });

    it('updates in place when updateOne does match', async () => {
        users.seed({ userId: 'u3', guildId: 'g1', balance: 10 });

        const result = await users.model.updateOne(
            { userId: 'u3', guildId: 'g1' }, { $inc: { balance: 5 } }, { upsert: true },
        );

        expect(result).toEqual({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 });
        expect(users.get('u3').balance).toBe(15);
        expect(users.all()).toHaveLength(1);
    });

    it('still reports no match without upsert', async () => {
        expect(await users.model.updateOne({ userId: 'nobody', guildId: 'g1' }, { $inc: { balance: 1 } }))
            .toEqual({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0 });
        expect(users.all()).toEqual([]);
    });

    it('answers a duplicate of the unique key with E11000, from either call', async () => {
        users.seed({ userId: 'u4', guildId: 'g1', balance: 1 });

        // A guarded upsert whose guard fails does not match, so it tries to
        // insert — and the unique index is what makes that an error rather than
        // a second row. /crime shipped with exactly this shape (#786).
        const guarded = { userId: 'u4', guildId: 'g1', balance: { $gte: 100 } };
        await expect(users.model.findOneAndUpdate(guarded, { $inc: { balance: 1 } }, { upsert: true }))
            .rejects.toMatchObject({ code: 11000 });
        await expect(users.model.updateOne(guarded, { $inc: { balance: 1 } }, { upsert: true }))
            .rejects.toMatchObject({ code: 11000 });

        expect(users.all()).toHaveLength(1);
    });
});

describe('fakeInteraction runs the command\'s own filter', () => {
    const ownedBy = require('../src/utils/collectorOwner').ownedBy;

    it('collects a press the filter accepts', async () => {
        const interaction = makeInteraction({ components: [{ customId: 'go' }] });
        const message = await interaction.reply({ content: 'press it' });

        const collected = [];
        message.createMessageComponentCollector({ filter: ownedBy('user-1', 'Not yours.') })
            .on('collect', press => collected.push(press.customId));
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(collected).toEqual(['go']);
    });

    it('drops one it turns away, and goes on to the next', async () => {
        const interaction = makeInteraction({
            components: [{ customId: 'go', user: 'someone-else' }, { customId: 'go' }],
        });
        const message = await interaction.reply({ content: 'press it' });

        const collected = [];
        message.createMessageComponentCollector({ filter: ownedBy('user-1', 'Not yours.') })
            .on('collect', press => collected.push(press.user.id));
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(collected).toEqual(['user-1']);
    });

    it('does not resolve an await on a press the filter rejects', async () => {
        const interaction = makeInteraction({ components: [{ customId: 'go', user: 'someone-else' }] });
        const message = await interaction.reply({ content: 'press it' });

        await expect(message.awaitMessageComponent({ filter: ownedBy('user-1', 'Not yours.') }))
            .rejects.toMatchObject({ name: 'InteractionCollectorError' });
    });

    it('resolves the await on the first press that passes', async () => {
        const interaction = makeInteraction({
            components: [{ customId: 'go', user: 'someone-else' }, { customId: 'go' }],
        });
        const message = await interaction.reply({ content: 'press it' });

        const press = await message.awaitMessageComponent({ filter: ownedBy('user-1', 'Not yours.') });
        expect(press.user.id).toBe('user-1');
    });

    it('collects everything when there is no filter', async () => {
        const interaction = makeInteraction({
            components: [{ customId: 'a', user: 'someone-else' }, { customId: 'b' }],
        });
        const message = await interaction.reply({ content: 'press it' });

        const collected = [];
        message.createMessageComponentCollector().on('collect', press => collected.push(press.customId));
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(collected).toEqual(['a', 'b']);
    });
});
