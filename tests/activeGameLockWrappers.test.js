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
 * `/casino` holds two leases with different lifetimes (#955): the shared
 * `economy:` key for the length of `execute`, and a `casino:` key of its own for
 * the whole hand. Which lease is held when is most of what the casino tests
 * below are about, because the split is exactly what stops an abandoned
 * blackjack hand locking a player out of `/fish` for ten minutes.
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
jest.mock('../src/utils/guildSettingsCache', () =>
    require('./helpers/guildSettingsCacheMock')());

jest.mock('../src/services/casinoJackpotService', () => ({
    processJackpotBet: jest.fn().mockResolvedValue(undefined),
    getJackpotDisplay: jest.fn().mockResolvedValue({ pool: 0, hot: false, display: '0' }),
    // Slots destructures these two at require time — it plays for the shared
    // progressive pool rather than a jackpot of its own.
    claimJackpot: jest.fn().mockResolvedValue({ credited: false, wonAmount: 0, newPool: 0 }),
    DEFAULT_SEED: 10_000,
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

/**
 * Waits until the lease on `key` is actually gone.
 *
 * Casino releases fire-and-forget — `release(...).catch(...)`, never awaited —
 * so `execute()` resolving does not mean the delete has landed. Asserting
 * immediately after it only passes while the fake happens to delete
 * synchronously, which is a property of the fake rather than of the code under
 * test: give the fake a round trip and three of these tests fail.
 *
 * The predicate reads the lock store rather than calling `tryAcquire`, which
 * would take the lock as a side effect of asking whether it was free.
 */
function releaseLanded(key) {
    return until(() => !fakeLocks.__locks.has(key), `the lease on ${key} to be released`);
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

// One key for all four — that is the property under test now, not an incidental
// duplication in the table.
const KEY = 'economy:g1:u1';

const GRIND = [
    // `read` is a subcommand from that command's read-only allowlist. hunt and
    // fish use a grouped one, which also exercises the "group sub" key form.
    { name: 'hunt',    sub: 'start', busy: /hunting action in progress/, read: { group: 'shop', sub: 'list' } },
    { name: 'mine',    sub: 'dig',   busy: /mining action in progress/,  read: { sub: 'map' } },
    { name: 'fish',    sub: 'cast',  busy: /fishing action in progress/, read: { group: 'shop', sub: 'list' } },
    { name: 'explore', sub: 'go',    busy: /exploration in progress/,    read: { sub: 'journal' } },
];

describe.each(GRIND)('/$name — the lock wrapper around execute', ({ name, sub, busy, read }) => {
    const key = KEY;
    /** An interaction for a read-only subcommand, grouped or not. */
    const readInteraction = ({ group = null, sub: readSub }) => {
        const interaction = makeInteraction({ sub: readSub });
        interaction.options.getSubcommandGroup = () => group;
        return interaction;
    };
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

    test('a read-only subcommand takes no lease at all', async () => {
        // These write nothing, so they have no read-modify-write to protect —
        // and one shared key means a lock here would refuse to show a player
        // their own profile because another of their commands is mid-flight.
        await command.execute(readInteraction(read));

        // Free, and takeable exactly once — so it was never taken, rather than
        // taken and released.
        const token = await tryAcquire(key);
        expect(token).toBeTruthy();
        await release(key, token);
    });

    test('a read-only subcommand runs while a lease is held', async () => {
        // The property as the player meets it: mid-action, they can still look.
        // The activity on the lease only words the message it is not going to
        // print — what is under test is that the read never asks for the key.
        const held = await tryAcquire(key, 60_000, 'casino');
        expect(held).toBeTruthy();

        const looking = readInteraction(read);
        await command.execute(looking);

        expect(replyContent(looking)).not.toMatch(/in progress/);
        await release(key, held);
    });

    test('a mutating subcommand still waits on that same lease', async () => {
        // The other half: exempting reads must not have exempted the action.
        const held = await tryAcquire(key, 60_000, 'casino');

        const acting = makeInteraction({ sub });
        await command.execute(acting);

        expect(replyContent(acting)).toMatch(/casino game in progress/);
        await release(key, held);
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
//
// Which lock, though, is now the question. `releaseLock` frees the `casino:`
// key, the one that says this player has a game open; the shared `economy:` key
// is released in a `finally` exactly like a grind command's, because its job is
// finished when `execute` returns (#955).

describe('/casino — the lock around a game that outlives execute()', () => {
    const casino = require('../src/commands/economy/casino');
    const BUSY = /casino game in progress/;
    /** The lease a hand holds for as long as it is being played. */
    const GAME_KEY = 'casino:g1:u1';

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

        // Both of them: the shared key in the command's `finally`, the game key
        // through `releaseLock` on the catch path.
        for (const key of [KEY, GAME_KEY]) {
            await releaseLanded(key);
            const token = await tryAcquire(key);
            expect([key, Boolean(token)]).toEqual([key, true]);
            await release(key, token);
        }
    });

    test('a game that calls releaseLock frees the slot for the next hand', async () => {
        slots.execute.mockImplementationOnce(async (interaction, { releaseLock }) => {
            releaseLock();
        });

        await casino.execute(interactionFor());

        await releaseLanded(GAME_KEY);
        const token = await tryAcquire(GAME_KEY);
        expect(token).toBeTruthy();
        await release(GAME_KEY, token);
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
        await releaseLanded(GAME_KEY);
        const token = await tryAcquire(GAME_KEY);
        expect(token).toBeTruthy();
        await expect(tryAcquire(GAME_KEY)).resolves.toBeNull();
        await release(GAME_KEY, token);
    });

    test('a game that returns without releasing leaves the game lease to its TTL', async () => {
        // Documented behaviour rather than a bug: execute() returning means the
        // hand is still being played in collectors, so the game key has to
        // outlive it. This test exists so that the day that stops being true,
        // it is a deliberate change and not a silent one.
        slots.execute.mockResolvedValueOnce(undefined);

        await casino.execute(interactionFor());

        // The hand ran and simply did not release — that is the case under
        // test, not a game that never started and so never took the lock.
        expect(slots.execute).toHaveBeenCalledTimes(1);
        await expect(tryAcquire(GAME_KEY)).resolves.toBeNull();

        const next = interactionFor();
        await casino.execute(next);
        expect(replyContent(next)).toMatch(BUSY);
        // Turned away by the still-held lease rather than allowed to start a
        // second hand: the game ran once in total, for the first call.
        expect(slots.execute).toHaveBeenCalledTimes(1);
    });

    test('the shared economy lease is handed back when execute returns', async () => {
        // The other half of the same case, and the whole of #955: the hand is
        // still open on the game key, and the key every *other* economy command
        // contends for is already free.
        slots.execute.mockResolvedValueOnce(undefined);

        await casino.execute(interactionFor());

        await releaseLanded(KEY);
        const token = await tryAcquire(KEY);
        expect(token).toBeTruthy();
        await release(KEY, token);
    });

    test('a second game refused mid-hand does not strand the shared lease', async () => {
        // The refusal path takes the economy key before it discovers the game
        // key is held. Keeping it would lock the player out of the grind
        // commands for a hand that never started.
        slots.execute.mockResolvedValueOnce(undefined);
        await casino.execute(interactionFor());

        const refused = interactionFor();
        await casino.execute(refused);
        expect(replyContent(refused)).toMatch(BUSY);

        await releaseLanded(KEY);
        const token = await tryAcquire(KEY);
        expect(token).toBeTruthy();
        await release(KEY, token);
    });
});

// ── One lock, every command ──────────────────────────────────────────────────
//
// The keys used to be namespaced per subsystem, so `/fish` and `/casino
// blackjack` from one user took different leases and ran side by side over the
// same user document — the interleaving the surviving read-modify-write sites
// lose coins to. The whole point of the shared `economy:{guild}:{user}` key is
// that these two contend, so a per-command test cannot see it: only a test that
// runs *two different commands* can.
//
// The second property is the message. One key means the command that turns you
// away is not the one holding the lease, so "you already have a fishing action
// in progress" has to come from what is actually running, not from whichever
// command you happened to type.
//
// The third is where the shared key stops. It covers each command's own
// invocation, not a casino hand's whole life in its collectors (#955), so what
// contends is `/fish cast` against `/casino slots` *starting* — not against a
// blackjack hand the player opened ten minutes ago and walked away from. Both
// halves are asserted below, because the one that is easy to lose by accident is
// the second.

describe('one economy lock across every money-moving command', () => {
    const fish     = require('../src/commands/economy/fish');
    const casino   = require('../src/commands/economy/casino');
    const KEY      = 'economy:g1:u1';
    const GAME_KEY = 'casino:g1:u1';

    test('a cast in progress turns away a casino game, and says so', async () => {
        const parked = gate();
        Guild.findOne.mockReturnValueOnce(parked.promise);  // parks /fish inside its body
        Guild.findOne.mockResolvedValue({});                // /casino reads its settings and falls through

        const casting = fish.execute(makeInteraction({ sub: 'cast' }));
        await until(() => Guild.findOne.mock.calls.length === 1, '/fish to reach its first read');

        const blocked = makeInteraction({ sub: 'slots' });
        await casino.execute(blocked);

        expect(replyContent(blocked)).toMatch(/fishing action in progress/);
        expect(slots.execute).not.toHaveBeenCalled();

        parked.resolve(ECONOMY_OFF);
        await casting;
    });

    test('a game still being dealt turns away a cast, and says so', async () => {
        // `execute` parked: the hand is still inside the command invocation, so
        // the shared lease is genuinely held and /fish must wait on it.
        const parked = gate();
        Guild.findOne.mockResolvedValue({});
        slots.execute.mockReturnValueOnce(parked.promise);

        const dealing = casino.execute(makeInteraction({ sub: 'slots' }));
        await until(() => slots.execute.mock.calls.length === 1, '/casino to reach the game');

        const blocked = makeInteraction({ sub: 'cast' });
        await fish.execute(blocked);

        expect(replyContent(blocked)).toMatch(/casino game in progress/);
        // Turned away before the body: /fish never got as far as its own read.
        expect(Guild.findOne).toHaveBeenCalledTimes(1);

        parked.resolve(undefined);
        await dealing;
    });

    test('an open hand no longer turns away a cast', async () => {
        // #955, as the player meets it. A game that returns without releasing is
        // a hand still being played in collectors — a real lease, on the casino
        // key, for up to ten minutes. What it must not be is a ten-minute
        // lockout from every other economy command.
        Guild.findOne.mockResolvedValue({});
        slots.execute.mockResolvedValueOnce(undefined);
        await casino.execute(makeInteraction({ sub: 'slots' }));

        // Still open, so a second game is still refused.
        await expect(tryAcquire(GAME_KEY)).resolves.toBeNull();

        Guild.findOne.mockResolvedValue(ECONOMY_OFF);
        const casting = makeInteraction({ sub: 'cast' });
        await fish.execute(casting);

        expect(replyContent(casting)).not.toMatch(/in progress/);
        // Reached its own body rather than being answered by the wrapper.
        expect(Guild.findOne.mock.calls.length).toBeGreaterThan(1);
    });

    test('the lease is still per user — one player mid-hand does not stop another fishing', async () => {
        Guild.findOne.mockResolvedValue({});
        slots.execute.mockResolvedValueOnce(undefined);
        await casino.execute(makeInteraction({ sub: 'slots', userId: 'u1' }));

        Guild.findOne.mockResolvedValue(ECONOMY_OFF);
        const other = makeInteraction({ sub: 'cast', userId: 'u2' });
        await fish.execute(other);

        expect(replyContent(other)).not.toMatch(/in progress/);
    });

    test('a lease with no recorded activity still blocks, with generic wording', async () => {
        // Locks taken before this field existed, and any future caller that
        // forgets to pass one: the message degrades, the lock does not.
        const token = await tryAcquire(KEY, 60_000);
        expect(token).toBeTruthy();

        Guild.findOne.mockResolvedValue(ECONOMY_OFF);
        const blocked = makeInteraction({ sub: 'cast' });
        await fish.execute(blocked);

        expect(replyContent(blocked)).toMatch(/economy action in progress/);
        await release(KEY, token);
    });
});

describe('exceptReadOnly', () => {
    const { exceptReadOnly } = require('../src/utils/economyLock');

    /** The two shapes discord.js reports: a bare subcommand, and one in a group. */
    const at = (group, sub) => ({
        options: { getSubcommandGroup: () => group, getSubcommand: () => sub },
    });

    const only = exceptReadOnly(['profile', 'shop list']);

    test('exempts a bare subcommand on the list', () => {
        expect(only(at(null, 'profile'))).toBe(false);
    });

    test('exempts a grouped subcommand on the list', () => {
        expect(only(at('shop', 'list'))).toBe(false);
    });

    test('locks anything not on it — an allowlist, so the miss is a needless lock', () => {
        expect(only(at(null, 'start'))).toBe(true);
        expect(only(at('shop', 'weapon'))).toBe(true);
        expect(only(at('inv', 'discard'))).toBe(true);
    });

    test('does not confuse a grouped subcommand with a bare one of the same name', () => {
        // `list` is read-only under `shop` and says nothing about `zone list`.
        expect(only(at(null, 'list'))).toBe(true);
        expect(only(at('zone', 'list'))).toBe(true);
    });
});
