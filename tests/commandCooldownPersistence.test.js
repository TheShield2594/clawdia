'use strict';

// #621: cooldowns lived only in a process-local map, with one setTimeout per
// entry. A deploy handed every window back — including the multi-hour economy
// ones — and a six-hour cooldown parked a six-hour timer to delete a map key.
//
// These hold the split: short cooldowns stay in memory (no query, no timer),
// long ones survive a restart, and nothing schedules per entry.

jest.mock('../src/models/User', () => ({
    findOne: jest.fn(),
    updateOne: jest.fn(),
}));

const User = require('../src/models/User');
const store = require('../src/utils/commandCooldowns');

function fakeClient() {
    return { cooldowns: new Map() };
}

const SHORT = 5_000;
const LONG = 6 * 60 * 60 * 1000;
const scope = extra => ({ bucket: 'daily', userId: 'u1', guildId: 'g1', ...extra });

function leanDoc(value) {
    return { lean: () => Promise.resolve(value) };
}

beforeEach(() => {
    jest.clearAllMocks();
    User.updateOne.mockResolvedValue({});
    User.findOne.mockReturnValue(leanDoc(null));
});

describe('the threshold', () => {
    test('is 15 minutes', () => {
        expect(store.PERSIST_THRESHOLD_MS).toBe(15 * 60 * 1000);
    });

    test('a short cooldown never touches the database, on read or on write', async () => {
        const client = fakeClient();
        await store.claim(client, scope({ cooldownMs: SHORT }));
        expect(await store.expiresAt(client, scope({ cooldownMs: SHORT }))).toBeGreaterThan(Date.now());

        expect(User.updateOne).not.toHaveBeenCalled();
        expect(User.findOne).not.toHaveBeenCalled();
    });

    test('a long cooldown is written to the User document as one keyed $set', async () => {
        await store.claim(fakeClient(), scope({ cooldownMs: LONG }));

        expect(User.updateOne).toHaveBeenCalledTimes(1);
        const [filter, update, options] = User.updateOne.mock.calls[0];
        expect(filter).toEqual({ userId: 'u1', guildId: 'g1' });
        expect(update.$set['commandCooldowns.daily']).toBeInstanceOf(Date);
        expect(options).toEqual({ upsert: true });
    });

    test('a zero cooldown records nothing at all', async () => {
        const client = fakeClient();
        await store.claim(client, scope({ cooldownMs: 0 }));
        expect(await store.expiresAt(client, scope({ cooldownMs: 0 }))).toBe(0);
        expect(User.updateOne).not.toHaveBeenCalled();
    });
});

describe('surviving a restart', () => {
    test('a fresh process reads the long cooldown back out of Mongo', async () => {
        const startedAt = new Date(Date.now() - 60_000);
        User.findOne.mockReturnValue(leanDoc({ commandCooldowns: { daily: startedAt } }));

        // A brand new client: nothing in memory, exactly as after a deploy.
        const expiry = await store.expiresAt(fakeClient(), scope({ cooldownMs: LONG }));

        expect(expiry).toBe(startedAt.getTime() + LONG);
        expect(User.findOne).toHaveBeenCalledWith(
            { userId: 'u1', guildId: 'g1' },
            { 'commandCooldowns.daily': 1 },
        );
    });

    test('an already-elapsed persisted window does not hold anything back', async () => {
        User.findOne.mockReturnValue(leanDoc({
            commandCooldowns: { daily: new Date(Date.now() - LONG - 1000) },
        }));

        expect(await store.expiresAt(fakeClient(), scope({ cooldownMs: LONG }))).toBe(0);
    });

    test('the read happens once — memory answers for the rest of the process', async () => {
        User.findOne.mockReturnValue(leanDoc({
            commandCooldowns: { daily: new Date(Date.now() - 60_000) },
        }));

        const client = fakeClient();
        await store.expiresAt(client, scope({ cooldownMs: LONG }));
        await store.expiresAt(client, scope({ cooldownMs: LONG }));
        await store.expiresAt(client, scope({ cooldownMs: LONG }));

        expect(User.findOne).toHaveBeenCalledTimes(1);
    });

    test('a database that will not answer reports "not on cooldown" rather than throwing', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        User.findOne.mockReturnValue({ lean: () => Promise.reject(new Error('no mongo')) });

        expect(await store.expiresAt(fakeClient(), scope({ cooldownMs: LONG }))).toBe(0);
    });

    test('a failed persist still leaves the cooldown holding in this process', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        User.updateOne.mockRejectedValue(new Error('no mongo'));

        const client = fakeClient();
        await expect(store.claim(client, scope({ cooldownMs: LONG }))).resolves.toBeUndefined();
        expect(await store.expiresAt(client, scope({ cooldownMs: LONG }))).toBeGreaterThan(Date.now());
    });
});

describe('the in-memory half schedules nothing', () => {
    test('claiming a cooldown does not park a timer for it', async () => {
        jest.useFakeTimers();
        try {
            const client = fakeClient();
            await store.claim(client, scope({ cooldownMs: SHORT }));
            // One setTimeout per entry is what put multi-hour timers in the
            // process; expiry is a comparison against the clock instead.
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    test('reading an expired entry is what deletes it', async () => {
        const client = fakeClient();
        client.cooldowns.set('g1:daily', new Map([['u1', Date.now() - SHORT - 1]]));

        expect(await store.expiresAt(client, scope({ cooldownMs: SHORT }))).toBe(0);
        expect(client.cooldowns.get('g1:daily').has('u1')).toBe(false);
    });

    test('the sweep drops entries older than any window, and empties the bucket', () => {
        const cooldowns = new Map([
            ['daily', new Map([['old', 0], ['recent', Date.now()]])],
            ['work', new Map([['old', 0]])],
        ]);

        expect(store.sweep(cooldowns, 60_000)).toBe(2);
        expect([...cooldowns.get('daily').keys()]).toEqual(['recent']);
        expect(cooldowns.has('work')).toBe(false);
    });

    test('the sweeper is unref\'d so it cannot hold the process open', () => {
        const client = fakeClient();
        const timer = store.startCooldownSweeper(client, 1000);
        try {
            expect(timer.hasRef()).toBe(false);
        } finally {
            clearInterval(timer);
        }
    });
});

describe('scoping', () => {
    test('a cooldown in one guild does not hold the same command in another', async () => {
        const client = fakeClient();
        await store.claim(client, scope({ cooldownMs: SHORT }));

        expect(await store.expiresAt(client, scope({ cooldownMs: SHORT }))).toBeGreaterThan(Date.now());
        // The persisted half lives on the per-guild User document, so the memory
        // half has to be keyed the same way or the two disagree.
        expect(await store.expiresAt(client, scope({ guildId: 'g2', cooldownMs: SHORT }))).toBe(0);
    });

    test('two commands do not share a window', async () => {
        const client = fakeClient();
        await store.claim(client, scope({ cooldownMs: SHORT }));

        expect(await store.expiresAt(client, scope({ bucket: 'work', cooldownMs: SHORT }))).toBe(0);
    });
});

describe('claiming is one operation, not a check and then a claim', () => {
    test('two concurrent uses of a short cooldown: one runs, one is refused', async () => {
        const client = fakeClient();

        const [first, second] = await Promise.all([
            store.claimIfAvailable(client, scope({ cooldownMs: SHORT })),
            store.claimIfAvailable(client, scope({ cooldownMs: SHORT })),
        ]);

        // 0 means "the window is yours"; anything else is the expiry of the
        // window someone else holds. Exactly one caller may get 0.
        expect([first, second].filter(v => v === 0)).toHaveLength(1);
    });

    test('two concurrent uses of a long cooldown: the Mongo read cannot be raced', async () => {
        const client = fakeClient();
        // A slow read is the whole of the window the old check-then-claim left
        // open: both callers were through the check before either had claimed.
        User.findOne.mockReturnValue({
            lean: () => new Promise(resolve => setTimeout(() => resolve(null), 20)),
        });

        const results = await Promise.all([
            store.claimIfAvailable(client, scope({ cooldownMs: LONG })),
            store.claimIfAvailable(client, scope({ cooldownMs: LONG })),
        ]);

        expect(results.filter(v => v === 0)).toHaveLength(1);
        expect(User.updateOne).toHaveBeenCalledTimes(1);
    });

    test('a free window is taken, and reports itself free', async () => {
        const client = fakeClient();

        expect(await store.claimIfAvailable(client, scope({ cooldownMs: SHORT }))).toBe(0);
        expect(await store.claimIfAvailable(client, scope({ cooldownMs: SHORT }))).toBeGreaterThan(Date.now());
    });

    test('a held window is reported without being extended', async () => {
        const client = fakeClient();
        await store.claimIfAvailable(client, scope({ cooldownMs: SHORT }));
        const first = await store.claimIfAvailable(client, scope({ cooldownMs: SHORT }));
        const second = await store.claimIfAvailable(client, scope({ cooldownMs: SHORT }));

        expect(second).toBe(first);
    });

    test('a zero cooldown is always free and records nothing', async () => {
        const client = fakeClient();

        expect(await store.claimIfAvailable(client, scope({ cooldownMs: 0 }))).toBe(0);
        expect(await store.claimIfAvailable(client, scope({ cooldownMs: 0 }))).toBe(0);
        expect(User.updateOne).not.toHaveBeenCalled();
    });

    test('a persisted window from a previous process refuses the first use', async () => {
        const startedAt = new Date(Date.now() - 60_000);
        User.findOne.mockReturnValue(leanDoc({ commandCooldowns: { daily: startedAt } }));

        const held = await store.claimIfAvailable(fakeClient(), scope({ cooldownMs: LONG }));

        expect(held).toBe(startedAt.getTime() + LONG);
        expect(User.updateOne).not.toHaveBeenCalled();
    });
});

describe('the User document carries the field', () => {
    test('commandCooldowns is a Map of Dates on the schema', () => {
        jest.isolateModules(() => {
            jest.unmock('../src/models/User');
            const RealUser = jest.requireActual('../src/models/User');
            const path = RealUser.schema.path('commandCooldowns');
            expect(path).toBeDefined();
            expect(path.instance).toBe('Map');
            expect(path.$__schemaType.instance).toBe('Date');
        });
    });
});
