'use strict';

/**
 * The crash restart refund actually refunds (#873, pass 12).
 *
 * `pendingCrashRefund` is the one record that returns a crash stake a restart
 * stranded mid-round, and pass 4 left two paths leaning on it by name. The sweep
 * that turns it back into coins issued
 *
 *     [{ $inc: { balance: '$pendingCrashRefund' } }, { $set: { pendingCrashRefund: 0 } }]
 *
 * as an update pipeline. `$inc` is not a pipeline stage, Mongoose refuses the
 * update before it is sent, and so the sweep failed on the first stranded
 * player on every boot there has ever been. Its test mocked the model and
 * asserted that exact shape — which is how a sweep that could not run stayed
 * green. So these run the update through things that evaluate it: Mongoose's own
 * cast against the real schema, and the pipeline evaluator the rest of the
 * economy's tests use, which throws on a stage it does not know just as the
 * server does.
 */

const { fakeCollection } = require('./helpers/fakeCollection');

const mockUsers = fakeCollection('User', { balance: 0, pendingCrashRefund: 0 });
jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));

const { logTransaction } = require('../src/utils/logTransaction');
const { reconcileCrashRefunds } = require('../src/games/casino/crashRefund');

const GUILD_A = '111222333444555666';
const GUILD_B = '222333444555666777';

/** Every update the sweep sent, in order. */
const sweepWrites = () => mockUsers.model.findOneAndUpdate.mock.calls.map(([, update]) => update);

let errorSpy;

beforeEach(() => {
    mockUsers.reset();
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => errorSpy.mockRestore());

describe('the update the sweep sends', () => {
    test('is one Mongoose will cast — the shape it replaced was refused before it was sent', async () => {
        // The real model, not the fake store: whether an update pipeline's stages
        // are legal is decided by Mongoose's cast, and no mock can answer it.
        // With commands unbuffered and no connection, a legal update gets as far
        // as the connection check; an illegal one never gets that far.
        const results = {};
        await jest.isolateModulesAsync(async () => {
            jest.unmock('../src/models/User');
            const mongoose = require('mongoose');
            mongoose.set('bufferCommands', false);
            const RealUser = require('../src/models/User');
            const attempt = update => RealUser
                .findOneAndUpdate({ _id: new mongoose.Types.ObjectId() }, update, { updatePipeline: true })
                .then(() => 'sent', err => err.message);

            // Capture what the sweep issues, then replay it against the real model.
            mockUsers.seed({ _id: 'u1', userId: 'u1', guildId: GUILD_A, balance: 0, pendingCrashRefund: 100 });
            await reconcileCrashRefunds();
            const [issued] = sweepWrites();

            results.old = await attempt([{ $inc: { balance: '$pendingCrashRefund' } }, { $set: { pendingCrashRefund: 0 } }]);
            results.now = await attempt(issued);
        });

        expect(results.old).toMatch(/Invalid update pipeline operator: "\$inc"/);
        expect(results.now).not.toMatch(/Invalid update pipeline/);
        expect(results.now).toMatch(/before initial connection/);
    });
});

describe('a stranded stake is returned', () => {
    test('the marker goes into the balance and is cleared in the same write', async () => {
        mockUsers.seed({ _id: 'u1', userId: 'u1', guildId: GUILD_A, balance: 40, pendingCrashRefund: 250 });

        const result = await reconcileCrashRefunds();

        expect(result).toEqual({ refunded: 1, failed: 0 });
        expect(mockUsers.get('u1')).toMatchObject({ balance: 290, pendingCrashRefund: 0 });
        expect(sweepWrites()).toHaveLength(1);
    });

    test('a player in two stranded lobbies gets both stakes back', async () => {
        // The marker is a sum: every lobby the player sat in added its stake.
        mockUsers.seed({ _id: 'u1', userId: 'u1', guildId: GUILD_A, balance: 0, pendingCrashRefund: 300 });

        await reconcileCrashRefunds();

        expect(mockUsers.get('u1').balance).toBe(300);
    });

    test('the transaction log records what was actually paid', async () => {
        mockUsers.seed({ _id: 'u1', userId: 'u1', guildId: GUILD_A, balance: 40, pendingCrashRefund: 250 });

        await reconcileCrashRefunds();

        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'u1', guildId: GUILD_A, type: 'crash_refund', amount: 250, balance: 290,
        }));
    });

    test('nobody without a marker is written to', async () => {
        mockUsers.seed(
            { _id: 'u1', userId: 'u1', guildId: GUILD_A, balance: 40, pendingCrashRefund: 0 },
            // A negative marker is not a debt to collect.
            { _id: 'u2', userId: 'u2', guildId: GUILD_A, balance: 40, pendingCrashRefund: -50 },
        );

        expect(await reconcileCrashRefunds()).toEqual({ refunded: 0, failed: 0 });
        expect(sweepWrites()).toEqual([]);
    });
});

describe('a marker is paid once', () => {
    test('a second sweep over the same list pays nothing', async () => {
        // Two processes booting together each read the list before either
        // writes. The marker rides the update's own filter, so the second write
        // finds it already zeroed and matches nothing.
        mockUsers.seed({ _id: 'u1', userId: 'u1', guildId: GUILD_A, balance: 0, pendingCrashRefund: 100 });

        const listed = await mockUsers.model.find({ pendingCrashRefund: { $gt: 0 } }).lean();
        // Once per sweep, so the stale list does not outlive this test.
        mockUsers.model.find
            .mockReturnValueOnce({ lean: async () => listed })
            .mockReturnValueOnce({ lean: async () => listed });

        const first  = await reconcileCrashRefunds();
        const second = await reconcileCrashRefunds();

        expect(first.refunded).toBe(1);
        expect(second.refunded).toBe(0);
        expect(mockUsers.get('u1').balance).toBe(100);
        expect(logTransaction).toHaveBeenCalledTimes(1);
    });
});

describe('one failure does not strand everyone else', () => {
    test('the sweep moves on, and leaves the failed marker for the next boot', async () => {
        mockUsers.seed(
            { _id: 'u1', userId: 'u1', guildId: GUILD_A, balance: 0, pendingCrashRefund: 100 },
            { _id: 'u2', userId: 'u2', guildId: GUILD_A, balance: 0, pendingCrashRefund: 200 },
        );
        const real = mockUsers.model.findOneAndUpdate.getMockImplementation();
        mockUsers.model.findOneAndUpdate
            .mockImplementationOnce(async () => { throw new Error('socket reset'); })
            .mockImplementation(real);

        const result = await reconcileCrashRefunds();

        expect(result).toEqual({ refunded: 1, failed: 1 });
        expect(mockUsers.get('u1').pendingCrashRefund).toBe(100);
        expect(mockUsers.get('u2')).toMatchObject({ balance: 200, pendingCrashRefund: 0 });
    });
});

describe('only this shard\'s guilds are swept', () => {
    const shardOf = guildId => Number((BigInt(guildId) >> 22n) % 2n);

    test('a marker in a guild another shard owns is left for that shard', async () => {
        // Another shard's marker may be a stake riding a round that is live on
        // that shard right now. Refunding it would pay the stake back and then
        // let the round settle it as well.
        expect(shardOf(GUILD_A)).not.toBe(shardOf(GUILD_B));
        mockUsers.seed(
            { _id: 'a', userId: 'a', guildId: GUILD_A, balance: 0, pendingCrashRefund: 100 },
            { _id: 'b', userId: 'b', guildId: GUILD_B, balance: 0, pendingCrashRefund: 100 },
        );
        const client = { shard: { count: 2, ids: [shardOf(GUILD_A)] } };

        const result = await reconcileCrashRefunds(client);

        expect(result.refunded).toBe(1);
        expect(mockUsers.get('a').balance).toBe(100);
        expect(mockUsers.get('b')).toMatchObject({ balance: 0, pendingCrashRefund: 100 });
    });

    test('unsharded, every guild is this process\'s', async () => {
        mockUsers.seed(
            { _id: 'a', userId: 'a', guildId: GUILD_A, balance: 0, pendingCrashRefund: 100 },
            { _id: 'b', userId: 'b', guildId: GUILD_B, balance: 0, pendingCrashRefund: 100 },
        );

        expect((await reconcileCrashRefunds()).refunded).toBe(2);
    });
});
