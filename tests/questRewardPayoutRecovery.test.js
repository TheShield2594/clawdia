'use strict';

/**
 * #873, pass 11 — the quest-reward credit is keyed at every caller.
 *
 * Every command and event that ticks a quest hook routes its reward through the
 * one `awardQuest`, which adds the coins to `balance` in memory for the flow's
 * `save()` to persist as an `$inc` (src/utils/balanceDelta.js). The gathering
 * runs already fold that credit into the run's keyed delta; everywhere else —
 * `/work`, `/daily`, `/pet`, and the message, reaction and command-use handlers
 * — it rode `saveWithBalanceDelta` with no key, the pass-6 degraded branch: the
 * retry re-credits a write whose response was lost, a run against a pruned
 * document is reported as paid though no coins moved (#804), and a payout that
 * ultimately fails is filed as a keyless `FailedJob` that `payouts:replay`
 * cannot settle.
 *
 * Keyed (`questRewardPayoutKey`), the credit is exactly-once and a failure is a
 * replayable owed `coins` payload. The one wrinkle is the freeze: the passive
 * hooks escape the command gate, so their credit carries the economy-freeze
 * sanction — and a keyed credit that matches nothing is otherwise recorded as
 * owed and replayed, which would pay the frozen member later. `refuseWhenFrozen`
 * confirms the freeze on a miss and withholds the credit rather than queuing it.
 *
 * The behavioural half drives `commitBalanceDelta` against a store that
 * evaluates the payout-key guard and the freeze guard for real; the static half
 * holds the call sites to the keyed path, since their collector and event flows
 * are awkward to drive and the contract is "spell this correctly at the call
 * site".
 */

const fs   = require('fs');
const path = require('path');
const { fakeCollection } = require('./helpers/fakeCollection');

const mockUsers = fakeCollection('User', { balance: 0, paidPayouts: [] });
jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));

const User = require('../src/models/User');
const { commitBalanceDelta } = require('../src/utils/balanceDelta');
const { questRewardPayoutKey } = require('../src/utils/payoutKey');
const { recordOwedPayout } = require('../src/utils/owedPayout');

const GUILD = 'guild-1';
const USER  = 'user-1';
const WHO   = { userId: USER, guildId: GUILD };
const KEY   = questRewardPayoutKey('pet', 'i1');

/** The in-memory document the flow hands the credit — its balance is detached
 *  before the save, so only the store's balance decides the outcome. */
const inMemory = balance => ({ balance, unmarkModified() {} });

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsers.reset();
    recordOwedPayout.mockResolvedValue(true);
});

afterEach(() => jest.restoreAllMocks());

describe('a keyed quest reward is credited exactly once', () => {
    test('the reward lands under its key, which is written on the document', async () => {
        mockUsers.seed({ ...WHO, balance: 100, paidPayouts: [] });

        const result = await commitBalanceDelta(User, WHO, inMemory(150), 50, { payoutKey: KEY });

        expect(result.credited).toBe(true);
        expect(mockUsers.get(USER).balance).toBe(150);
        expect(mockUsers.get(USER).paidPayouts.some(p => p.key === KEY)).toBe(true);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    test('a second credit under the same key moves no coins', async () => {
        // A write that committed and lost its response is retried under the same
        // key; the guard makes the retry a no-op rather than a double payment.
        mockUsers.seed({ ...WHO, balance: 150, paidPayouts: [{ key: KEY, at: new Date() }] });

        const result = await commitBalanceDelta(User, WHO, inMemory(150), 50, { payoutKey: KEY });

        expect(result.credited).toBe(true);          // duplicate is success
        expect(mockUsers.get(USER).balance).toBe(150); // unchanged
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    test('a reward with no document to land on is recorded as replayable coins', async () => {
        // No seeded document: the guarded credit matches nothing, is classified
        // 'missing', and is filed with a `kind` and the key — the shape
        // `payouts:replay` can settle, not the keyless `FailedJob` the unkeyed
        // quest credit used to leave.
        const result = await commitBalanceDelta(User, WHO, inMemory(50), 50, {
            payoutKey: KEY, service: 'pet', jobName: 'feedQuestReward',
        });

        expect(result.credited).toBe(false);
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'pet',
            jobName: 'feedQuestReward',
            guildId: GUILD,
            payload: { kind: 'coins', userId: USER, guildId: GUILD, amount: 50, payoutKey: KEY },
        }));
    });
});

describe('the freeze sanction withholds without owing', () => {
    const CMD_KEY = questRewardPayoutKey('command', 'i1');

    test('a frozen member is refused, and the refusal is not recorded as owed', async () => {
        // The command-use hook escapes the gate, so its credit carries the
        // freeze. A guarded credit that matched nothing here would otherwise be
        // filed as owed and replayed — paying the frozen member the moment an
        // operator runs the sweep, which is the sanction not being a sanction.
        mockUsers.seed({ ...WHO, balance: 100, economyFrozen: true, paidPayouts: [] });

        const result = await commitBalanceDelta(User, WHO, inMemory(150), 50, {
            payoutKey: CMD_KEY, refuseWhenFrozen: true,
        });

        expect(result.credited).toBe(false);
        expect(result.owed).toBe(false);
        expect(mockUsers.get(USER).balance).toBe(100);           // withheld
        expect(mockUsers.get(USER).paidPayouts).toEqual([]);     // nothing keyed
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    test('an unfrozen member with the same sanction is paid', async () => {
        mockUsers.seed({ ...WHO, balance: 100, economyFrozen: false, paidPayouts: [] });

        const result = await commitBalanceDelta(User, WHO, inMemory(150), 50, {
            payoutKey: CMD_KEY, refuseWhenFrozen: true,
        });

        expect(result.credited).toBe(true);
        expect(mockUsers.get(USER).balance).toBe(150);
    });

    test('a missing document with the sanction is still owed, not silently dropped', async () => {
        // No document at all is 'missing', which the freeze cannot explain — a
        // credit that cannot land on a pruned account is owed exactly as it is
        // without the sanction, so a real failure is never mistaken for a freeze.
        const result = await commitBalanceDelta(User, WHO, inMemory(50), 50, {
            payoutKey: CMD_KEY, refuseWhenFrozen: true, service: 'interactionCreate',
            jobName: 'commandQuestReward',
        });

        expect(result.credited).toBe(false);
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({ kind: 'coins', amount: 50, payoutKey: CMD_KEY }),
        }));
    });
});

// ─── The call sites ────────────────────────────────────────────────────────────

describe('every quest-reward credit is keyed at its call site', () => {
    const SRC = path.join(__dirname, '..', 'src');
    const read = rel => fs.readFileSync(path.join(SRC, rel), 'utf8');

    const cases = [
        ['events/interactionCreate.js',        [`questRewardPayoutKey('command', interaction.id)`, 'refuseWhenFrozen: true']],
        ['events/messageCreate.js',            [`questRewardPayoutKey('message', message.id)`]],
        ['events/messageReactionAdd.js',       [`questRewardPayoutKey('reaction'`]],
        ['commands/economy/work.js',           [`questRewardPayoutKey('work', interaction.id)`, `questRewardPayoutKey('work-bonus', interaction.id)`]],
        ['commands/economy/daily.js',          [`questRewardPayoutKey('daily', interaction.id)`, `questRewardPayoutKey('daily-bonus', interaction.id)`]],
        ['commands/economy/pet/feed.js',       [`questRewardPayoutKey('pet', interaction.id)`]],
    ];

    test.each(cases)('%s keys its quest reward', (file, needles) => {
        const src = read(file);
        for (const needle of needles) expect(src).toContain(needle);
    });

    const countOf = (src, needle) => src.split(needle).length - 1;

    // status.js and battle.js each key more than one write, and the writes share
    // a key *shape*, so a bare substring check passes even if one of them lost
    // its key. Assert each write independently (occurrence count, and the
    // distinct per-fighter interpolations) so a regression on any single credit
    // fails here.
    test('pet status keys both the play and the train care write', () => {
        const src = read('commands/economy/pet/status.js');
        // Play and train each key by the button interaction; the string is
        // identical, so the guard is that it appears once per write.
        expect(countOf(src, `questRewardPayoutKey('pet', btn.id)`)).toBe(2);
        for (const job of ['playQuestReward', 'trainQuestReward']) expect(src).toContain(job);
    });

    test('pet battle keys the wild write and each PvP fighter apart', () => {
        // The member battle moved to pvp.js in #1184.
        const src = read('commands/economy/pet/battle.js') + read('commands/economy/pet/pvp.js');
        // Wild (single fighter) plus the two PvP fighters — three keyed writes.
        expect(countOf(src, `questRewardPayoutKey('pet'`)).toBe(3);
        expect(src).toContain(`questRewardPayoutKey('pet', interaction.id)`);       // wild
        expect(src).toContain('${interaction.id}:${chUser.userId}');                // challenger
        expect(src).toContain('${interaction.id}:${opUser.userId}');                // opponent
    });

    // The command-use handler is the one that escapes the freeze gate, so it must
    // no longer hand the credit the plain `guard` — a keyed credit refused by a
    // filter is owed and replayed. It carries the sanction instead.
    test('the command-use credit uses the freeze sanction, not the plain guard', () => {
        const src = read('events/interactionCreate.js');
        expect(src).toMatch(/refuseWhenFrozen: true/);
        expect(src).not.toMatch(/guard: NOT_FROZEN/);
    });

    // The message handler folds streak-milestone coins into the same delta as the
    // quest reward; both must ride the one key, so the credit is keyed and there
    // is no separate unkeyed milestone write.
    test('the message handler keys the whole streak-and-quest delta', () => {
        const src = read('events/messageCreate.js');
        expect(src).toMatch(/questRewardPayoutKey\('message', message\.id\)/);
    });
});
