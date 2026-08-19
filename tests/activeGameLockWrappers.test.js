'use strict';

/**
 * The action lock, exercised through the wrappers that actually hold money still.
 *
 * tests/activeGameLock.test.js covers the primitive: acquire, release, token
 * validation, expiry. Every one of those tests calls `tryAcquire` directly, so
 * none of them touch the code that decides whether a *user* gets to run two
 * paying actions at once. That code is a wrapper around each command's
 * `execute` — `src/commands/economy/hunt.js` and its three siblings replace
 * `module.exports.execute` at the bottom of the file, and `casino.js` takes the
 * lock inline — and a lock is only as good as the wrapper around it.
 *
 * Two properties matter here and cannot be seen from the primitive:
 *
 *   1. Two overlapping `execute()` calls for one user: exactly one runs the
 *      command body, and the other is turned away rather than queued. Testing
 *      this needs the first call genuinely parked *inside* the body while the
 *      second arrives, which is what the gate below arranges.
 *
 *   2. A throw inside the body still releases the lock. This is the expensive
 *      one to get wrong: the lease is not reclaimed early, so a leaked lock
 *      locks the user out of the command for the full TTL — 120s for the grind
 *      commands, 10 minutes for casino — with nothing to tell them why.
 *
 * The lock is Mongo-backed, so the fake model stands in for the collection; it
 * models the unique-index-rejects-the-insert behaviour that "already held"
 * actually is. The real `activeGameLock` and the real wrappers run.
 */

jest.mock('../src/models/ActiveLock', () => require('./helpers/fakeActiveLock'));

jest.mock('../src/models/Guild', () => ({
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/services/casinoJackpotService', () => ({
    processJackpotBet: jest.fn().mockResolvedValue(undefined),
    getJackpotDisplay: jest.fn().mockResolvedValue({ pool: 0, hot: false, display: '0' }),
}));

// One casino game stands in for all eight: the wrapper does not care which game
// it is holding the lock for, and a stub is the only way to control when the
// game finishes — which is the whole point of the concurrency test.
jest.mock('../src/games/casino/slots', () => ({
    name: 'slots',
    description: 'Stub slots game.',
    cooldown: 3,
    execute: jest.fn(),
}));

const Guild      = require('../src/models/Guild');
const fakeLocks  = require('./helpers/fakeActiveLock');
const slots      = require('../src/games/casino/slots');
const { tryAcquire, release } = require('../src/utils/activeGameLock');

/** Economy off: the command body replies and returns without touching a user document. */
const ECONOMY_OFF = { economy: { enabled: false } };

/** A promise whose settlement this test controls, for parking a call mid-body. */
function gate() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    // An unsettled rejection handler keeps Node quiet if a test resolves instead.
    promise.catch(() => {});
    return { promise, resolve, reject };
}

/**
 * Drains the microtask and timer queues until `predicate` holds.
 *
 * The alternative — awaiting a fixed number of ticks — encodes how many awaits
 * deep the wrapper happens to be today, and silently stops proving anything the
 * moment that changes.
 */
async function until(predicate, label) {
    for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error(`timed out waiting for: ${label}`);
}

function makeInteraction({ userId = 'u1', guildId = 'g1', sub }) {
    return {
        guild: { id: guildId },
        user:  { id: userId, username: `user-${userId}` },
        options: {
            getSubcommandGroup: () => null,
            getSubcommand:      () => sub,
            getString:          () => null,
            getInteger:         () => 0,
        },
        memberPermissions: { has: () => true },
        reply:      jest.fn().mockResolvedValue(undefined),
        editReply:  jest.fn().mockResolvedValue(undefined),
        deferReply: jest.fn().mockResolvedValue(undefined),
        followUp:   jest.fn().mockResolvedValue(undefined),
        replied:  false,
        deferred: false,
    };
}

/** Content of the first reply a turned-away call made. */
function replyContent(interaction) {
    return interaction.reply.mock.calls[0]?.[0]?.content ?? '';
}

beforeEach(() => {
    fakeLocks.__locks.clear();
    jest.clearAllMocks();
    Guild.findOne.mockResolvedValue(ECONOMY_OFF);
    Guild.findOneAndUpdate.mockResolvedValue({});
});

// ── The four grind commands ──────────────────────────────────────────────────
//
// Identical wrappers over four different commands, so they are driven by one
// table: a wrapper that stopped calling `release` in its `finally` would be a
// per-command regression, not a shared-helper one, and only a per-command test
// catches it.

const GRIND = [
    { name: 'hunt',    sub: 'start', busy: /hunting action in progress/,     key: 'grind:hunt:g1:u1' },
    { name: 'mine',    sub: 'dig',   busy: /mining action in progress/,      key: 'grind:mine:g1:u1' },
    { name: 'fish',    sub: 'cast',  busy: /fishing action in progress/,     key: 'grind:fish:g1:u1' },
    { name: 'explore', sub: 'go',    busy: /exploration action in progress/, key: 'grind:explore:g1:u1' },
];

describe.each(GRIND)('/$name — the lock wrapper around execute', ({ name, sub, busy, key }) => {
    const command = require(`../src/commands/economy/${name}`);
    const interactionFor = overrides => makeInteraction({ sub, ...overrides });

    test('two concurrent execute() calls: one runs, the other is turned away', async () => {
        // The first call parks inside the command body — past the lock, on its
        // first database read — so the second genuinely overlaps it rather than
        // arriving after it finished.
        const parked = gate();
        Guild.findOne.mockReturnValueOnce(parked.promise);

        const first  = interactionFor();
        const second = interactionFor();

        const both = Promise.all([command.execute(first), command.execute(second)]);

        await until(() => second.reply.mock.calls.length > 0, 'the second call to be answered');

        expect(replyContent(second)).toMatch(busy);
        // Turned away *before* the body: the command's first read ran once, for
        // the winner. A wrapper that let both through would show two.
        expect(Guild.findOne).toHaveBeenCalledTimes(1);
        expect(first.reply).not.toHaveBeenCalled();

        parked.resolve(ECONOMY_OFF);
        await both;

        // The winner did run the body, and the loser's rejection did not consume
        // the lock the winner was holding.
        expect(first.reply).toHaveBeenCalledTimes(1);
        expect(replyContent(first)).not.toMatch(busy);
    });

    test('the lock is released once execute resolves', async () => {
        await command.execute(interactionFor());

        const token = await tryAcquire(key);
        expect(token).toBeTruthy();
        await release(key, token);
    });

    test('a throw inside execute still releases the lock', async () => {
        // Without the `finally`, this is where the user loses the command for
        // the full 120s TTL — for a failure that already cost them the action.
        Guild.findOne.mockRejectedValueOnce(new Error('mongo went away'));

        await expect(command.execute(interactionFor())).rejects.toThrow('mongo went away');

        const token = await tryAcquire(key);
        expect(token).toBeTruthy();
        await release(key, token);
    });

    test('a user whose action threw can run the command again immediately', async () => {
        // The same property as above, stated the way the player meets it: the
        // retry has to reach the command body, not a "already in progress" reply.
        Guild.findOne.mockRejectedValueOnce(new Error('mongo went away'));
        await expect(command.execute(interactionFor())).rejects.toThrow();

        const retry = interactionFor();
        await command.execute(retry);

        expect(replyContent(retry)).not.toMatch(busy);
        expect(Guild.findOne).toHaveBeenCalledTimes(2);
    });

    test('the lock is per user, not per command', async () => {
        // One player mid-action must not block the rest of the server.
        const parked = gate();
        Guild.findOne.mockReturnValueOnce(parked.promise);

        const mine   = interactionFor({ userId: 'u1' });
        const theirs = interactionFor({ userId: 'u2' });

        const both = Promise.all([command.execute(mine), command.execute(theirs)]);

        // Reaching the command's first read at all is the assertion: a lock
        // that were shared would have turned this call away instead.
        await until(() => Guild.findOne.mock.calls.length === 2, 'the second user to reach the body');

        parked.resolve(ECONOMY_OFF);
        await both;

        expect(replyContent(theirs)).not.toMatch(busy);
    });

    test('the lock is per guild, not global', async () => {
        const parked = gate();
        Guild.findOne.mockReturnValueOnce(parked.promise);

        const here      = interactionFor({ guildId: 'g1' });
        const elsewhere = interactionFor({ guildId: 'g2' });

        const both = Promise.all([command.execute(here), command.execute(elsewhere)]);

        await until(() => Guild.findOne.mock.calls.length === 2, 'the other guild to reach the body');

        parked.resolve(ECONOMY_OFF);
        await both;

        expect(replyContent(elsewhere)).not.toMatch(busy);
    });
});

// ── /casino ──────────────────────────────────────────────────────────────────
//
// A different shape, and the reason it gets its own tests: the grind wrappers
// release in a `finally` when `execute` returns, but a casino hand continues in
// button collectors long after that, so the game releases the lock itself via
// the `releaseLock` it is handed. `execute` returning is therefore *not* the
// end of the critical section — except on the throw path, which the command
// still has to cover itself.

describe('/casino — the lock around a game that outlives execute()', () => {
    const casino = require('../src/commands/economy/casino');
    const KEY = 'casino:g1:u1';
    const BUSY = /casino game in progress/;

    const interactionFor = overrides => makeInteraction({ sub: 'slots', ...overrides });

    beforeEach(() => {
        // No economy flags set: the command falls through to the game.
        Guild.findOne.mockResolvedValue({});
    });

    test('two concurrent execute() calls: one gets the game, the other is turned away', async () => {
        const parked = gate();
        slots.execute.mockReturnValueOnce(parked.promise);

        const first  = interactionFor();
        const second = interactionFor();

        const both = Promise.all([casino.execute(first), casino.execute(second)]);

        await until(() => second.reply.mock.calls.length > 0, 'the second call to be answered');

        expect(replyContent(second)).toMatch(BUSY);
        expect(slots.execute).toHaveBeenCalledTimes(1);

        parked.resolve(undefined);
        await both;
    });

    test('a throwing game releases the lock instead of stranding it for the TTL', async () => {
        // The casino lease is 10 minutes — the whole default TTL — so a leak
        // here is the longest lockout in the codebase.
        slots.execute.mockRejectedValueOnce(new Error('dealer exploded'));

        await expect(casino.execute(interactionFor())).rejects.toThrow('dealer exploded');

        const token = await tryAcquire(KEY);
        expect(token).toBeTruthy();
        await release(KEY, token);
    });

    test('a game that calls releaseLock frees the slot for the next hand', async () => {
        slots.execute.mockImplementationOnce(async (interaction, { releaseLock }) => {
            releaseLock();
        });

        await casino.execute(interactionFor());

        const token = await tryAcquire(KEY);
        expect(token).toBeTruthy();
        await release(KEY, token);
    });

    test('releaseLock is idempotent — a game may call it on several exit paths', async () => {
        slots.execute.mockImplementationOnce(async (interaction, { releaseLock }) => {
            releaseLock();
            releaseLock();
            releaseLock();
        });

        await casino.execute(interactionFor());

        // A second release must not have freed a lock someone else took in the
        // meantime; the key is simply free, and takeable exactly once.
        const token = await tryAcquire(KEY);
        expect(token).toBeTruthy();
        await expect(tryAcquire(KEY)).resolves.toBeNull();
        await release(KEY, token);
    });

    test('a game that returns without releasing leaves the lease to its TTL', async () => {
        // Documented behaviour rather than a bug: execute() returning means the
        // hand is still being played in collectors, so the lock has to outlive
        // it. This test exists so that the day the wrapper grows a `finally`,
        // it is a deliberate change and not a silent one.
        slots.execute.mockResolvedValueOnce(undefined);

        await casino.execute(interactionFor());

        await expect(tryAcquire(KEY)).resolves.toBeNull();

        const next = interactionFor();
        await casino.execute(next);
        expect(replyContent(next)).toMatch(BUSY);
    });
});
