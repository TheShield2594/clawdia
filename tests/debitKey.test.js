'use strict';

/**
 * #969. A debit whose outcome is unknown, made knowable.
 *
 * #807 made credits exactly-once with a key in the write's own filter. Debits
 * had no equivalent, and what that cost was not duplicates — it was that a
 * failed debit could not be reconciled at all. When `findOneAndUpdate` rejects,
 * the caller cannot tell whether the write never landed (the coins are still
 * with the player, and refunding would mint them) or committed and lost its
 * response (the coins are gone, and not refunding destroys them). Both branches
 * are currency bugs, so `takeEscrow` named the case in a comment rather than
 * guessing at it.
 *
 * These are grouped by the three things that close it, because they are three
 * separate claims:
 *
 *   1. The key makes a retry safe — the second attempt moves no coins.
 *   2. The key makes the outcome *readable* — when every attempt has failed,
 *      the document still says whether one of them committed.
 *   3. The key makes the compensation safe — giving the debit back is
 *      conditioned on the same key, so a caller who does not know can
 *      compensate anyway without minting anything.
 *
 * Driven against a store that evaluates the filters and the pipeline for real.
 * A mock that waved the key guard through would report the whole thing working.
 */

const { fakeCollection } = require('./helpers/fakeCollection');

const mockUsers = fakeCollection('User', { balance: 0, lifetimeGambled: 0 });

jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));

const {
    debitCoinsOnce, debitCoinsOrKnow, reverseKeyedDebit, resolveKeyedDebit,
    KEY_CAP, RETENTION_MS,
} = require('../src/utils/debitKey');

const User = mockUsers.model;

const GUILD  = 'guild-1';
const PLAYER = 'player-1';
const KEY    = 'duel:d1:escrow:player-1';

const filter = { userId: PLAYER, guildId: GUILD };
const seed = fields => mockUsers.seed({ userId: PLAYER, guildId: GUILD, balance: 0, ...fields });
const stored = () => mockUsers.get(PLAYER);
const keys = () => (stored()?.spentDebits ?? []).map(e => e.key);

/** The store's own implementations, so a test that breaks one can restore it. */
const storeImpl = new Map(Object.entries(User)
    .filter(([, fn]) => typeof fn?.getMockImplementation === 'function')
    .map(([name, fn]) => [name, fn.getMockImplementation()]));

beforeEach(() => {
    jest.clearAllMocks();
    mockUsers.reset();
    for (const [name, impl] of storeImpl) User[name].mockImplementation(impl);
});

/** Makes `findOneAndUpdate` reject while leaving the reads working. */
function breakWrites() {
    User.findOneAndUpdate.mockImplementation(async () => { throw new Error('mongo is down'); });
}

describe('debitCoinsOnce', () => {
    test('takes the coins and records the key in the same write', async () => {
        seed({ balance: 500 });

        const { status } = await debitCoinsOnce(filter, 100, KEY);

        expect(status).toBe('debited');
        expect(stored().balance).toBe(400);
        expect(keys()).toEqual([KEY]);
    });

    // The whole point. Nothing outside this function knows whether the first
    // attempt committed, so the second attempt has to be the one that decides.
    test('a second call with the same key moves no coins', async () => {
        seed({ balance: 500 });

        await debitCoinsOnce(filter, 100, KEY);
        const second = await debitCoinsOnce(filter, 100, KEY);

        expect(second.status).toBe('duplicate');
        expect(stored().balance).toBe(400);
        expect(keys()).toEqual([KEY]);
    });

    test('a different key is a different debit', async () => {
        seed({ balance: 500 });

        await debitCoinsOnce(filter, 100, KEY);
        await debitCoinsOnce(filter, 100, 'duel:d2:escrow:player-1');

        expect(stored().balance).toBe(300);
        expect(keys()).toHaveLength(2);
    });

    test('moves its counters in the same write, so a stake cannot land uncounted', async () => {
        seed({ balance: 500, lifetimeGambled: 40 });

        await debitCoinsOnce(filter, 100, KEY, { counters: { lifetimeGambled: 100 } });

        expect(stored()).toMatchObject({ balance: 400, lifetimeGambled: 140 });
    });

    // Each of these is a different thing for the caller to do, which is why the
    // classification is not a boolean: two are the player's, one means there is
    // nobody to charge, and one means something wrote concurrently.
    describe('says why it matched nothing', () => {
        test('insufficient, and takes nothing', async () => {
            seed({ balance: 50 });

            expect((await debitCoinsOnce(filter, 100, KEY)).status).toBe('insufficient');
            expect(stored().balance).toBe(50);
            expect(keys()).toEqual([]);
        });

        test('frozen, ahead of insufficient — that is the one an admin can explain', async () => {
            seed({ balance: 10, economyFrozen: true });

            expect((await debitCoinsOnce(filter, 100, KEY)).status).toBe('frozen');
        });

        test('missing, when there is no document to charge', async () => {
            expect((await debitCoinsOnce(filter, 100, KEY)).status).toBe('missing');
        });

        test('unknown, when the write should have matched and did not', async () => {
            seed({ balance: 500 });
            // Everything the filter asks for is true of the document, and the
            // update still matched nothing. That is a concurrent writer, not a
            // verdict on the player's wallet.
            User.findOneAndUpdate.mockImplementation(async () => null);

            expect((await debitCoinsOnce(filter, 100, KEY)).status).toBe('unknown');
        });
    });

    describe('the key array is bounded', () => {
        test('drops entries past the retention window', async () => {
            const old = new Date(Date.now() - RETENTION_MS - 60_000);
            seed({ balance: 500, spentDebits: [{ key: 'ancient', at: old }] });

            await debitCoinsOnce(filter, 100, KEY);

            expect(keys()).toEqual([KEY]);
        });

        test('keeps an entry with no timestamp at all', async () => {
            // Keeping a key too long is a debit not taken twice; dropping one
            // early is a debit taken twice. Only one of those is worth
            // defaulting to.
            seed({ balance: 500, spentDebits: [{ key: 'undated' }] });

            await debitCoinsOnce(filter, 100, KEY);

            expect(keys()).toEqual(['undated', KEY]);
        });

        test('evicts the oldest once the cap is reached, never an arbitrary one', async () => {
            const at = new Date();
            const full = Array.from({ length: KEY_CAP }, (_, i) => ({ key: `k${i}`, at }));
            seed({ balance: 500, spentDebits: full });

            await debitCoinsOnce(filter, 100, KEY);

            const after = keys();
            expect(after).toHaveLength(KEY_CAP);
            expect(after[0]).toBe('k1');            // k0 went, not a random one
            expect(after.at(-1)).toBe(KEY);
        });
    });
});

describe('debitCoinsOrKnow', () => {
    test('reports a debit that landed', async () => {
        seed({ balance: 500 });

        expect(await debitCoinsOrKnow(filter, 100, KEY)).toMatchObject({
            resolved: true, debited: true, status: 'debited',
        });
    });

    test('reports a refusal as resolved but not debited', async () => {
        seed({ balance: 50 });

        expect(await debitCoinsOrKnow(filter, 100, KEY)).toMatchObject({
            resolved: true, debited: false, status: 'insufficient',
        });
    });

    // The retry is only allowed to exist because of the key: a `$inc` retried
    // after an unknown failure is how a debit lands twice.
    test('retries a rejection and takes the coins exactly once', async () => {
        seed({ balance: 500 });
        const store = storeImpl.get('findOneAndUpdate');
        let attempts = 0;
        User.findOneAndUpdate.mockImplementation(async (f, u, o) => {
            if (++attempts === 1) throw new Error('transient');
            return store(f, u, o);
        });

        expect(await debitCoinsOrKnow(filter, 100, KEY)).toMatchObject({ resolved: true, debited: true });
        expect(stored().balance).toBe(400);
    });

    // ── The case #969 is about ──────────────────────────────────────────────
    //
    // Every attempt rejected, so nothing came back to read. Before the key
    // there was nothing else to ask, and the two possible answers called for
    // opposite handling. Now the document holds the answer.
    test('reads the key when every attempt has failed, and finds the debit landed', async () => {
        // The write committed and the response was lost: the key is on the
        // document, the coins are gone, and the caller must not refund on the
        // assumption that nothing happened.
        seed({ balance: 400, spentDebits: [{ key: KEY, at: new Date() }] });
        breakWrites();

        expect(await debitCoinsOrKnow(filter, 100, KEY)).toMatchObject({
            resolved: true, debited: true, status: 'duplicate',
        });
    });

    test('and finds it did not, when the key is absent', async () => {
        // Nothing else in the system writes this key, so its absence is not a
        // race — it is an answer. The coins are still with the player and
        // refunding them would mint.
        seed({ balance: 500 });
        breakWrites();

        expect(await debitCoinsOrKnow(filter, 100, KEY)).toMatchObject({
            resolved: true, debited: false, status: 'failed',
        });
        expect(stored().balance).toBe(500);
    });

    test('says so, rather than guessing, when it cannot read either', async () => {
        seed({ balance: 500 });
        breakWrites();
        User.findOne.mockImplementation(() => { throw new Error('mongo is down'); });

        expect(await debitCoinsOrKnow(filter, 100, KEY)).toMatchObject({
            resolved: false, debited: false,
        });
    });

    test('carries the last error out for the log line', async () => {
        seed({ balance: 500 });
        breakWrites();

        const result = await debitCoinsOrKnow(filter, 100, KEY);

        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe('mongo is down');
    });
});

describe('reverseKeyedDebit', () => {
    test('gives back a debit that actually happened', async () => {
        seed({ balance: 500, lifetimeGambled: 0 });
        await debitCoinsOnce(filter, 100, KEY, { counters: { lifetimeGambled: 100 } });

        const back = await reverseKeyedDebit(filter, 100, KEY, { counters: { lifetimeGambled: -100 } });

        expect(back).toMatchObject({ reversed: true, resolved: true });
        expect(stored()).toMatchObject({ balance: 500, lifetimeGambled: 0 });
    });

    // The reason a caller who does not know may call it anyway, and the whole
    // of what makes the ambiguous case safe.
    test('mints nothing against a debit that never landed', async () => {
        seed({ balance: 500 });

        const back = await reverseKeyedDebit(filter, 100, KEY);

        expect(back).toMatchObject({ reversed: false, resolved: true });
        expect(stored().balance).toBe(500);
    });

    test('cannot pay twice', async () => {
        seed({ balance: 500 });
        await debitCoinsOnce(filter, 100, KEY);

        await reverseKeyedDebit(filter, 100, KEY);
        const second = await reverseKeyedDebit(filter, 100, KEY);

        expect(second.reversed).toBe(false);
        expect(stored().balance).toBe(500);
    });

    test('marks the entry rather than removing it, so the debit cannot be retaken', async () => {
        seed({ balance: 500 });
        await debitCoinsOnce(filter, 100, KEY);
        await reverseKeyedDebit(filter, 100, KEY);

        // The guard is still the key's presence, so a stale retry of the
        // original debit is refused rather than charging a second time.
        expect((await debitCoinsOnce(filter, 100, KEY)).status).toBe('reversed');
        expect(stored().balance).toBe(500);
    });

    // No freeze guard, deliberately: this returns coins the player already had,
    // and a sanction that ate a refund would destroy them.
    test('returns a frozen member their stake', async () => {
        seed({ balance: 500 });
        await debitCoinsOnce(filter, 100, KEY);
        await User.updateOne(filter, { $set: { economyFrozen: true } });

        expect((await reverseKeyedDebit(filter, 100, KEY)).reversed).toBe(true);
        expect(stored().balance).toBe(500);
    });

    test('reports a write it could not make, instead of a reversal it did not do', async () => {
        seed({ balance: 500 });
        await debitCoinsOnce(filter, 100, KEY);
        breakWrites();

        expect(await reverseKeyedDebit(filter, 100, KEY)).toMatchObject({
            reversed: false, resolved: false,
        });
        // The key is still there, so the same call can be made again later.
        expect(keys()).toEqual([KEY]);
    });
});

describe('resolveKeyedDebit', () => {
    test('answers for a debit that landed', async () => {
        seed({ balance: 500 });
        await debitCoinsOnce(filter, 100, KEY);

        expect(await resolveKeyedDebit(User, filter, KEY))
            .toMatchObject({ landed: true, reversed: false });
    });

    test('answers for one that was given back', async () => {
        seed({ balance: 500 });
        await debitCoinsOnce(filter, 100, KEY);
        await reverseKeyedDebit(filter, 100, KEY);

        expect(await resolveKeyedDebit(User, filter, KEY))
            .toMatchObject({ landed: true, reversed: true });
    });

    test('answers for a member with no document', async () => {
        expect(await resolveKeyedDebit(User, filter, KEY))
            .toMatchObject({ landed: false, doc: null });
    });
});
