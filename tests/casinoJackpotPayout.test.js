'use strict';

/**
 * The progressive jackpot: the one pot in the casino that exists outside
 * anybody's balance.
 *
 * #784 brought the service under test at all — it was 14.6% lines and 0%
 * branches, every decision in a payout path unexecuted. #873's economy audit
 * came back to it because of what those branches were doing: the pot was claimed
 * in one write and its *amount* recorded in a second, unawaited one; the credit
 * was an unkeyed `$inc` retried three times, so a write that committed and lost
 * its response was paid again; and when the credit would not land at all the
 * pool was rolled back, which is only the right recovery if the credit
 * definitely did not happen — which an unkeyed retry can never establish.
 *
 * So these run the service against stores that evaluate the claim pipeline and
 * the payout-key guard for real. A mock that waved either through would report
 * the retry as safe when the key is the only thing that makes it safe, and would
 * let the claim's arithmetic — the pool as it stood at the win, plus the
 * triggering bet's contribution — pass whatever it computed.
 *
 * `Math.random` is stubbed throughout: the trigger is a probability, and a test
 * that waits for a 0.01% event is not a test.
 */

const { fakeCollection } = require('./helpers/fakeCollection');

const mockGuilds = fakeCollection('Guild', {}, { unique: ['guildId'] });
const mockUsers  = fakeCollection('User', { balance: 0, paidPayouts: [] });

jest.mock('discord.js', () => {
    class EmbedBuilder {
        constructor() { this.fields = []; }
        setColor(c) { this.color = c; return this; }
        setThumbnail(t) { this.thumbnail = t; return this; }
        setTitle(t) { this.title = t; return this; }
        setDescription(d) { this.description = d; return this; }
        setTimestamp() { return this; }
    }
    return { EmbedBuilder };
});

jest.mock('../src/models/Guild', () => mockGuilds.model);
jest.mock('../src/models/User',  () => mockUsers.model);
jest.mock('../src/utils/logTransaction', () => ({ logTransaction: jest.fn() }));
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));

const { logTransaction } = require('../src/utils/logTransaction');
const { recordOwedPayout } = require('../src/utils/owedPayout');
const {
    processJackpotBet, claimJackpot, reconcileJackpotClaims, getJackpotDisplay, HOT_POOL_THRESHOLD,
} = require('../src/services/casinoJackpotService');

const BASE_TRIGGER_RATE = 0.0001;
const TRIGGER_INCREMENT = 0.00001;

const GUILD = 'g1';
const USER  = 'u1';

// The stores' own implementations, captured before a test replaces one — a
// `mockImplementation` survives `reset()`, so a test that makes a write fail
// would make it fail for every test after it.
const userUpdate  = mockUsers.model.findOneAndUpdate.getMockImplementation();
const guildUpdate = mockGuilds.model.updateOne.getMockImplementation();
const guildClaim  = mockGuilds.model.findOneAndUpdate.getMockImplementation();

/** Forces the trigger roll one way or the other, deterministically. */
function roll(trigger) {
    jest.spyOn(Math, 'random').mockReturnValue(trigger ? 0 : 0.9999);
}

function jackpot(over = {}) {
    return { pool: 250_000, betsCount: 40, contributionRate: 0.005, seedAmount: 10_000, ...over };
}

function bet(over = {}) {
    return { guildId: GUILD, userId: USER, username: 'Ada', bet: 10_000, ...over };
}

const guildDoc = () => mockGuilds.get(GUILD);
const balance  = () => mockUsers.get(USER)?.balance;
/** The claim marker: the payout key of a pot taken out of the pool and not yet paid. */
const marker   = () => guildDoc()?.casinoJackpot?.pendingPayoutKey ?? null;

let errorLog;

beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    mockGuilds.reset();
    mockUsers.reset();
    mockUsers.model.findOneAndUpdate.mockImplementation(userUpdate);
    mockGuilds.model.updateOne.mockImplementation(guildUpdate);
    mockGuilds.model.findOneAndUpdate.mockImplementation(guildClaim);
    recordOwedPayout.mockResolvedValue(true);
    mockGuilds.seed({ guildId: GUILD, casinoJackpot: jackpot() });
    mockUsers.seed({ userId: USER, guildId: GUILD, balance: 999, paidPayouts: [] });
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

describe('processJackpotBet — the bet that does not win', () => {
    test('grows the pool by the contribution and counts the bet', async () => {
        roll(false);

        const result = await processJackpotBet(bet());

        expect(guildDoc().casinoJackpot).toMatchObject({ pool: 250_050, betsCount: 41 });
        expect(result).toEqual({ triggered: false, newPool: 250_050 });
        expect(balance()).toBe(999);
    });

    test('a bet too small to round to a contribution still contributes one coin', async () => {
        roll(false);

        // floor(10 * 0.005) is 0, and a pool that never grows is not a jackpot.
        await processJackpotBet(bet({ bet: 10 }));

        expect(guildDoc().casinoJackpot.pool).toBe(250_001);
    });

    test('an unconfigured guild uses the documented defaults', async () => {
        roll(false);
        mockGuilds.reset();
        mockGuilds.seed({ guildId: GUILD });

        const result = await processJackpotBet(bet());

        // 0.5% rate, and a pool that reads as the 10,000 seed.
        expect(result.newPool).toBe(10_050);
    });

    test('a guild with no document at all is left alone', async () => {
        mockGuilds.reset();

        expect(await processJackpotBet(bet())).toEqual({ triggered: false });
        expect(mockGuilds.writes).toHaveLength(0);
    });

    test('the trigger chance climbs with the bets since the last drop', async () => {
        // One roll, held between the two rates: above what a freshly reset pool
        // (betsCount 0) drops at, below what a pool cold for 100 bets does. The
        // same roll therefore has to lose the first and win the second, which is
        // the climb itself rather than a restatement of the formula.
        const between = (BASE_TRIGGER_RATE + (BASE_TRIGGER_RATE + 100 * TRIGGER_INCREMENT)) / 2;
        jest.spyOn(Math, 'random').mockReturnValue(between);

        mockGuilds.reset();
        mockGuilds.seed({ guildId: GUILD, casinoJackpot: jackpot({ betsCount: 0 }) });
        expect(await processJackpotBet(bet())).toMatchObject({ triggered: false });

        mockGuilds.reset();
        mockGuilds.seed({ guildId: GUILD, casinoJackpot: jackpot({ betsCount: 100 }) });
        expect(await processJackpotBet(bet())).toMatchObject({ triggered: true });
    });
});

describe('the claim', () => {
    test('reseeds the pool and records what was claimed in the same write', async () => {
        roll(true);

        await processJackpotBet(bet());

        // One write against the guild, and it holds the whole claim: the pot as
        // it stood, the winner, the reset pool and the key the credit is
        // guarded by. The amount used to be a second, unawaited update — and a
        // process that died in between left the *previous* winner's amount
        // sitting under this winner's name for the restart reconciler to pay.
        const claims = mockGuilds.writes.filter(w => Array.isArray(w.update));
        expect(claims).toHaveLength(1);
        expect(guildDoc().casinoJackpot).toMatchObject({
            pool:           10_000,
            betsCount:      0,
            lastWinnerId:   USER,
            lastWinnerName: 'Ada',
            lastWonAmount:  250_050,
        });
        expect(guildDoc().casinoJackpot.lastWonAt).toBeInstanceOf(Date);
    });

    test('pays the pre-reset pool plus this bet’s contribution', async () => {
        roll(true);

        const result = await processJackpotBet(bet());

        expect(result).toMatchObject({ triggered: true, wonAmount: 250_050, newPool: 10_000 });
        expect(balance()).toBe(999 + 250_050);
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({
            userId: USER, guildId: GUILD, type: 'casino_jackpot', amount: 250_050,
        }));
    });

    test('clears the claim marker once the coins have landed', async () => {
        roll(true);

        await processJackpotBet(bet());

        // Nothing outstanding, so no recovery path picks this guild up again.
        expect(marker()).toBeNull();
        // And the last-winner display survives it: that is what /casino jackpot
        // reads, and the reconciler used to wipe it on every restart.
        expect(guildDoc().casinoJackpot).toMatchObject({ lastWinnerId: USER, lastWonAmount: 250_050 });
    });

    test('a marker that will not clear costs the winner nothing', async () => {
        roll(true);
        mockGuilds.model.updateOne.mockRejectedValue(new Error('mongo down'));

        const result = await processJackpotBet(bet());

        // The coins are in the balance; only the bookkeeping that says so
        // failed. Throwing here would take the win down with it, and the next
        // boot settles the marker as a duplicate anyway.
        expect(result.triggered).toBe(true);
        expect(balance()).toBe(999 + 250_050);
        expect(errorLog.mock.calls.flat().join(' ')).toContain('clearing the settled claim failed');
    });

    test('a username that looks like a field path is stored as text', async () => {
        roll(true);

        await processJackpotBet(bet({ username: '$casinoJackpot.pool' }));

        // The claim is a pipeline update, where a value beginning with `$` is a
        // field path. Stored raw, the display name would resolve to whatever
        // that path held.
        expect(guildDoc().casinoJackpot.lastWinnerName).toBe('$casinoJackpot.pool');
    });

    test('two wins in a row are two different claims', async () => {
        roll(true);
        const keys = [];

        await processJackpotBet(bet());
        keys.push(mockUsers.get(USER).paidPayouts.at(-1).key);
        await processJackpotBet(bet());
        keys.push(mockUsers.get(USER).paidPayouts.at(-1).key);

        // A key built from the guild and the amount would make the second win a
        // replay of the first and pay nothing for it.
        expect(keys[0]).not.toBe(keys[1]);
        expect(balance()).toBe(999 + 250_050 + 10_050);
    });

    test('a guild document that goes away between the read and the claim wins nothing', async () => {
        roll(true);
        // processJackpotBet has already read the pool; the document is gone by
        // the time the claim lands. Falling back to the seed here would credit a
        // five-figure pot nobody ever played for.
        mockGuilds.model.findOneAndUpdate.mockResolvedValueOnce(null);

        const result = await processJackpotBet(bet());

        expect(result.triggered).toBe(false);
        expect(balance()).toBe(999);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });
});

describe('the credit', () => {
    test('retries a credit that fails, and pays exactly once when a retry lands', async () => {
        roll(true);
        mockUsers.model.findOneAndUpdate.mockImplementationOnce(async () => { throw new Error('mongo down'); });

        const result = await processJackpotBet(bet());

        expect(result.triggered).toBe(true);
        expect(balance()).toBe(999 + 250_050);
    });

    test('a credit that committed and lost its response is not paid a second time', async () => {
        roll(true);
        // The failure mode the key exists for, and the one the old three-attempt
        // `$inc` had no defence against: the write lands, the client never hears
        // so, and the retry runs against a balance that already holds the pot.
        mockUsers.model.findOneAndUpdate.mockImplementationOnce(async (...args) => {
            await userUpdate(...args);
            throw new Error('connection reset');
        });

        const result = await processJackpotBet(bet());

        expect(result.triggered).toBe(true);
        expect(balance()).toBe(999 + 250_050);
        // One ledger entry too: the second attempt found the key and moved
        // nothing, and a second entry would double the win in every report that
        // reads the log.
        expect(logTransaction).toHaveBeenCalledTimes(1);
    });

    test('a credit that will not land is written down rather than rolled back', async () => {
        roll(true);
        mockUsers.model.findOneAndUpdate.mockImplementation(async () => { throw new Error('mongo down'); });

        const result = await processJackpotBet(bet());

        // The pool stays reseeded. Restoring it *and* recording the debt pays
        // the pot twice, and the restore is only correct if the credit
        // definitely did not land — which is exactly what an unknown outcome
        // cannot tell you.
        expect(guildDoc().casinoJackpot.pool).toBe(10_000);
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'casinoJackpot',
            jobName: 'jackpot',
            guildId: GUILD,
            payload: expect.objectContaining({
                kind: 'coins', userId: USER, guildId: GUILD, amount: 250_050,
                payoutKey: expect.stringContaining(`jackpot:${GUILD}:`),
            }),
        }));
        // The owed record and the marker carry the same key, so the replay and
        // the restart reconciler cannot pay it between them twice.
        expect(marker()).toBe(recordOwedPayout.mock.calls[0][0].payload.payoutKey);
        // And nothing reports a win the player has not received.
        expect(result).toMatchObject({ triggered: false, owed: true });
        expect(logTransaction).not.toHaveBeenCalled();
    });

    test('a debt that cannot even be written down says so', async () => {
        roll(true);
        mockUsers.model.findOneAndUpdate.mockImplementation(async () => { throw new Error('mongo down'); });
        recordOwedPayout.mockResolvedValue(false);

        const result = await processJackpotBet(bet());

        expect(result).toMatchObject({ triggered: false, owed: false });
        expect(errorLog.mock.calls.flat().join(' ')).toContain('NOT recorded');
    });
});

describe('reconcileJackpotClaims', () => {
    /** A guild carrying an unsettled claim, as a process that died mid-payout leaves one. */
    function outstanding(over = {}) {
        mockGuilds.reset();
        mockGuilds.seed({
            guildId: GUILD,
            casinoJackpot: {
                ...jackpot({ pool: 10_000, betsCount: 0 }),
                lastWinnerId:     USER,
                lastWinnerName:   'Ada',
                lastWonAmount:    250_050,
                lastWonAt:        new Date('2026-09-01T00:00:00Z'),
                pendingPayoutKey: `jackpot:${GUILD}:claim-1`,
                // The schema's default, and what the sweep's `$in: [null, …]`
                // lease check reads: an unheld claim is free for any shard.
                claimToken:       null,
                ...over,
            },
        });
    }

    test('pays a claim the process that took it never delivered', async () => {
        outstanding();

        expect(await reconcileJackpotClaims()).toEqual({ reconciled: 1, failed: 0 });

        expect(balance()).toBe(999 + 250_050);
        expect(marker()).toBeNull();
        expect(logTransaction).toHaveBeenCalledWith(expect.objectContaining({
            type: 'casino_jackpot', amount: 250_050, note: 'jackpot reconciliation on restart',
        }));
    });

    test('does not pay again a claim whose credit had actually landed', async () => {
        // The exact case the old reconciler got wrong. It asked the transaction
        // log whether the win had been paid — a log written fire-and-forget,
        // which never throws and whose absence therefore proves nothing — and
        // paid the pot a second time whenever the credit had landed and its
        // ledger entry had not. The key is on the user document, written by the
        // credit itself, so there is nothing left to ask.
        outstanding();
        mockUsers.get(USER).paidPayouts.push({ key: `jackpot:${GUILD}:claim-1`, at: new Date() });

        expect(await reconcileJackpotClaims()).toEqual({ reconciled: 0, failed: 0 });

        expect(balance()).toBe(999);
        expect(logTransaction).not.toHaveBeenCalled();
        // Settled either way, so it is not carried into the next restart.
        expect(marker()).toBeNull();
    });

    test('leaves a paid win alone', async () => {
        // A guild whose last win was paid keeps `lastWinnerId` and
        // `lastWonAmount` set — they are what /casino jackpot displays. The old
        // sweep selected on exactly those two fields, so every restart went
        // looking for a payout in every guild that had ever dropped a jackpot.
        mockGuilds.reset();
        mockGuilds.seed({
            guildId: GUILD,
            casinoJackpot: { ...jackpot(), lastWinnerId: USER, lastWonAmount: 250_050, pendingPayoutKey: null },
        });

        expect(await reconcileJackpotClaims()).toEqual({ reconciled: 0, failed: 0 });

        expect(balance()).toBe(999);
        expect(guildDoc().casinoJackpot).toMatchObject({ lastWinnerId: USER, lastWonAmount: 250_050 });
    });

    test('keeps the claim and hands back the lease when the credit fails', async () => {
        outstanding();
        mockUsers.model.findOneAndUpdate.mockImplementation(async () => { throw new Error('mongo down'); });

        expect(await reconcileJackpotClaims()).toEqual({ reconciled: 0, failed: 1 });

        // Still owed, and nothing holding it: the next boot picks it up again.
        expect(marker()).toBe(`jackpot:${GUILD}:claim-1`);
        expect(guildDoc().casinoJackpot.claimToken).toBeNull();
    });

    test('a lease that will not release is logged rather than thrown at startup', async () => {
        outstanding();
        mockUsers.model.findOneAndUpdate.mockImplementation(async () => { throw new Error('mongo down'); });
        mockGuilds.model.updateOne.mockRejectedValue(new Error('mongo down'));

        // The sweep runs from events/ready.js, where a rejection would skip the
        // crash-refund sweep behind it.
        await expect(reconcileJackpotClaims()).resolves.toEqual({ reconciled: 0, failed: 1 });
        expect(errorLog.mock.calls.flat().join(' ')).toContain('releasing the reconcile lease failed');
    });

    test('clears a claim that names no payout', async () => {
        outstanding({ lastWinnerId: null });

        expect(await reconcileJackpotClaims()).toEqual({ reconciled: 0, failed: 0 });

        // Left set, it would stall every later claim in this guild behind a
        // record nobody can settle.
        expect(marker()).toBeNull();
    });

    test('stops rather than spinning on a marker that will not clear', async () => {
        outstanding();
        // The credit lands but the clear does not, so the same guild is selected
        // again — the one shape of this loop that does not terminate.
        mockGuilds.model.updateOne.mockResolvedValue({ matchedCount: 0 });

        await expect(reconcileJackpotClaims()).resolves.toEqual({ reconciled: 1, failed: 0 });
    });

    test('a guild claimed by another shard’s lease is left to it', async () => {
        outstanding({ claimToken: 'other-shard-99' });

        expect(await reconcileJackpotClaims()).toEqual({ reconciled: 0, failed: 0 });

        expect(balance()).toBe(999);
    });
});

describe('the announcement', () => {
    function interaction(channels = new Map()) {
        const sent = [];
        return {
            sent,
            user:    { displayAvatarURL: () => 'avatar', toString: () => '<@u1>' },
            guild:   { channels: { cache: channels } },
            channel: { send: async p => sent.push(['fallback', p]) },
        };
    }

    test('announces the drop in the configured channel', async () => {
        roll(true);
        mockGuilds.reset();
        mockGuilds.seed({ guildId: GUILD, casinoJackpot: { ...jackpot(), announceChannelId: 'jackpot-c' } });
        const sent = [];
        const source = interaction(new Map([['jackpot-c', { send: async p => sent.push(['announce', p]) }]]));

        await processJackpotBet(bet({ interaction: source }));

        expect(sent.map(([where]) => where)).toEqual(['announce']);
        expect(sent[0][1].embeds[0].description).toContain('250,050');
        expect(sent[0][1].embeds[0].description).toContain('10,000');
        expect(source.sent).toHaveLength(0);
    });

    test('falls back to the channel the bet was placed in', async () => {
        roll(true);
        const source = interaction();

        await processJackpotBet(bet({ interaction: source }));

        expect(source.sent).toHaveLength(1);
    });

    test('says so when the pot has not been delivered', async () => {
        roll(true);
        mockUsers.model.findOneAndUpdate.mockImplementation(async () => { throw new Error('mongo down'); });
        const source = interaction();

        await processJackpotBet(bet({ interaction: source }));

        // This announcement is the only thing that ever tells a player the
        // random trigger fired for them, so going quiet on a failed credit
        // leaves them never knowing on top of not being paid.
        const [, payload] = source.sent[0];
        expect(payload.embeds[0].description).toContain('not delivered yet');
        expect(payload.embeds[0].description).toContain('Recorded for an admin');
    });

    test('an announcement that throws does not cost the winner their win', async () => {
        roll(true);

        const result = await processJackpotBet(bet({ interaction: {
            user: { displayAvatarURL: () => { throw new Error('no avatar'); } },
            channel: { send: async () => {} },
        } }));

        expect(result).toMatchObject({ triggered: true, wonAmount: 250_050 });
        expect(balance()).toBe(999 + 250_050);
    });
});

describe('claimJackpot — the game that deals its own jackpot', () => {
    test('claims the pool and reports the pot it paid', async () => {
        const claim = await claimJackpot({ guildId: GUILD, userId: USER, username: 'Ada' });

        // No `extra`: nothing is riding on this claim but the pool itself.
        expect(claim).toMatchObject({ claimed: true, credited: true, wonAmount: 250_000, newPool: 10_000 });
        expect(balance()).toBe(999 + 250_000);
    });

    test('a guild with no document has no pool to claim', async () => {
        mockGuilds.reset();

        const claim = await claimJackpot({ guildId: GUILD, userId: USER, username: 'Ada' });

        // `claimed: false` is what lets the caller pay a fallback: nothing came
        // out of a pool, so nothing is owed and nothing will be recovered.
        expect(claim).toMatchObject({ claimed: false, credited: false, owed: false, wonAmount: 0 });
        expect(balance()).toBe(999);
    });

    test('a pot that could not be paid is still the player’s', async () => {
        mockUsers.model.findOneAndUpdate.mockImplementation(async () => { throw new Error('mongo down'); });

        const claim = await claimJackpot({ guildId: GUILD, userId: USER, username: 'Ada' });

        expect(claim).toMatchObject({ claimed: true, credited: false, owed: true, wonAmount: 250_000 });
    });
});

describe('getJackpotDisplay', () => {
    test('marks a pool hot once it crosses the threshold', async () => {
        mockGuilds.reset();
        mockGuilds.seed({ guildId: GUILD, casinoJackpot: { pool: HOT_POOL_THRESHOLD } });
        expect(await getJackpotDisplay(GUILD)).toEqual({
            pool: HOT_POOL_THRESHOLD, hot: true, display: '🔥 **500,000** coins',
        });
    });

    test('a pool just under it is not hot', async () => {
        mockGuilds.reset();
        mockGuilds.seed({ guildId: GUILD, casinoJackpot: { pool: HOT_POOL_THRESHOLD - 1 } });
        expect(await getJackpotDisplay(GUILD)).toMatchObject({ hot: false, display: '🏆 **499,999** coins' });
    });

    test('an unconfigured guild reads as the seed rather than as an error', async () => {
        mockGuilds.reset();
        expect(await getJackpotDisplay(GUILD)).toMatchObject({ pool: 10_000, hot: false });
    });
});
