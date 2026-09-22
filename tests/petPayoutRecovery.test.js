'use strict';

/**
 * #873, pass 10 — the /pet command's PvP-battle payouts and adopt refund.
 *
 * The gathering runs' pet *drops* were found sound in pass 9 (they ride the
 * run's atomic `save()`), and this pass takes the `/pet` command itself. It has
 * three currency-mutation paths the audit found on a bare, unkeyed write:
 *
 *   - The wagered-battle winner payout was a bare `$inc` that read nothing back
 *     and announced the win regardless — the durability gap `/duel`'s pot had
 *     before pass 1. Through `payBattleWinner` (`creditCoinsOrOwe` under
 *     `petBattlePayoutKey`) it is exactly-once, recorded as owed when it will
 *     not land, and the embed is worded from the result.
 *   - The escrow refunds — the challenger's when the opponent cannot cover, and
 *     both when a fighter drops out after accepting — were bare `$inc`s that
 *     announced the refund regardless (the pass-3 `/market` unwind shape). The
 *     debit they reverse is read back in the same handler, so an unconditional
 *     keyed credit is the right compensation. Through `refundBattleStake` /
 *     `refundBothStakes` under `petBattleRefundPayoutKey`.
 *   - The adopt fee handed back on a failed save was a bare `$inc` that told the
 *     player their coins came back over a write it never read. Through
 *     `refundAdoptFee` under `petAdoptRefundPayoutKey`.
 *
 * The behavioural half drives the helpers against a store that evaluates the
 * payout-key guard for real. The static half holds the two call sites —
 * `battle.js` and `adopt.js` — to the keyed path, since their interactive flows
 * (a 60s challenge collector, a save that has to be made to throw) are awkward
 * to drive and the contract is "spell this correctly at the call site".
 */

const fs   = require('fs');
const path = require('path');
const { fakeCollection } = require('./helpers/fakeCollection');

const mockUsers = fakeCollection('User', { balance: 0, paidPayouts: [] });
jest.mock('../src/models/User', () => mockUsers.model);
jest.mock('../src/utils/owedPayout', () => ({ recordOwedPayout: jest.fn(async () => true) }));
jest.mock('../src/utils/delay', () => ({ delay: jest.fn(async () => {}) }));

const {
    payBattleWinner, refundBattleStake, refundBothStakes,
    battleRefundNote, stakeRefundNote, refundAdoptFee, adoptRefundNote,
} = require('../src/utils/petEconomy');
const {
    petBattlePayoutKey, petBattleRefundPayoutKey, petAdoptRefundPayoutKey,
} = require('../src/utils/payoutKey');
const { recordOwedPayout } = require('../src/utils/owedPayout');

const GUILD = 'guild-1';
const WINNER = 'winner-1';
const LOSER  = 'loser-1';
const BATTLE = 'battle-1';

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockUsers.reset();
    recordOwedPayout.mockResolvedValue(true);
});

afterEach(() => jest.restoreAllMocks());

// ─── The keys the live payout and its replay have to agree on ───────────────────

describe('the pass-10 payout keys name their payout and nothing else', () => {
    test('a battle payout is keyed by the battle and the winner', () => {
        expect(petBattlePayoutKey(BATTLE, WINNER)).toBe('pet:battle:battle-1:winner-1:payout');
        // Two battles the same player wins are two interactions and pay separately.
        expect(petBattlePayoutKey('battle-2', WINNER)).not.toBe(petBattlePayoutKey(BATTLE, WINNER));
    });

    test('a battle refund is keyed apart from the payout on the same battle', () => {
        expect(petBattleRefundPayoutKey(BATTLE, WINNER)).toBe('pet:battle:battle-1:winner-1:refund');
        // The winner's payout and a refund on the same battle share a battle id
        // and a wallet; the phase is what keeps one from satisfying the other.
        expect(petBattleRefundPayoutKey(BATTLE, WINNER)).not.toBe(petBattlePayoutKey(BATTLE, WINNER));
    });

    test('an adopt refund is keyed by the interaction', () => {
        expect(petAdoptRefundPayoutKey('i9')).toBe('pet:adopt:i9:refund');
    });
});

// ─── payBattleWinner: the keyed pot credit ──────────────────────────────────────

describe('payBattleWinner pays the pot exactly once', () => {
    const KEY = petBattlePayoutKey(BATTLE, WINNER);

    test('a payout lands under its key, which is written on the document', async () => {
        mockUsers.seed({ userId: WINNER, guildId: GUILD, balance: 100, paidPayouts: [] });

        const paid = await payBattleWinner(WINNER, GUILD, 380, BATTLE);

        expect(paid.credited).toBe(true);
        expect(mockUsers.get(WINNER).balance).toBe(480);
        expect(mockUsers.get(WINNER).paidPayouts.some(p => p.key === KEY)).toBe(true);
    });

    test('a second payout under the same key moves no coins', async () => {
        // A credit that committed and lost its response is retried under the same
        // key — the guard makes the retry a no-op, not a double payment.
        mockUsers.seed({ userId: WINNER, guildId: GUILD, balance: 480, paidPayouts: [{ key: KEY, at: new Date() }] });

        const paid = await payBattleWinner(WINNER, GUILD, 380, BATTLE);

        expect(paid.credited).toBe(true);            // duplicate is success
        expect(mockUsers.get(WINNER).balance).toBe(480);
        expect(recordOwedPayout).not.toHaveBeenCalled();
    });

    test('a payout with no document to land on is recorded as replayable coins', async () => {
        const paid = await payBattleWinner(WINNER, GUILD, 380, BATTLE);

        expect(paid.credited).toBe(false);
        expect(paid.owed).toBe(true);
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'pet',
            jobName: 'petBattlePayout',
            payload: { kind: 'coins', userId: WINNER, guildId: GUILD, amount: 380, payoutKey: KEY },
        }));
    });
});

// ─── refundBattleStake / refundBothStakes: the keyed escrow refunds ──────────────

describe('refundBattleStake puts one stake back exactly once', () => {
    const KEY = petBattleRefundPayoutKey(BATTLE, WINNER);

    test('a refund lands under its key', async () => {
        mockUsers.seed({ userId: WINNER, guildId: GUILD, balance: 0, paidPayouts: [] });

        const back = await refundBattleStake(WINNER, GUILD, 200, BATTLE);

        expect(back.credited).toBe(true);
        expect(mockUsers.get(WINNER).balance).toBe(200);
        expect(mockUsers.get(WINNER).paidPayouts.some(p => p.key === KEY)).toBe(true);
    });

    test('a refund with no document is recorded as replayable coins', async () => {
        const back = await refundBattleStake(WINNER, GUILD, 200, BATTLE);

        expect(back.credited).toBe(false);
        expect(back.owed).toBe(true);
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'pet',
            jobName: 'petBattleRefund',
            payload: expect.objectContaining({ kind: 'coins', amount: 200, payoutKey: KEY }),
        }));
    });
});

describe('refundBothStakes reports which of the two arrived', () => {
    test('both landing reads as refunded', async () => {
        mockUsers.seed({ userId: WINNER, guildId: GUILD, balance: 0, paidPayouts: [] });
        mockUsers.seed({ userId: LOSER,  guildId: GUILD, balance: 0, paidPayouts: [] });

        const returned = await refundBothStakes(WINNER, LOSER, GUILD, 200, BATTLE);

        expect(returned).toEqual({ refunded: true, owed: false });
        expect(mockUsers.get(WINNER).balance).toBe(200);
        expect(mockUsers.get(LOSER).balance).toBe(200);
    });

    test('one missing document leaves the pair owed, not silently lost', async () => {
        // Only the challenger has a document; the opponent's is gone.
        mockUsers.seed({ userId: WINNER, guildId: GUILD, balance: 0, paidPayouts: [] });

        const returned = await refundBothStakes(WINNER, LOSER, GUILD, 200, BATTLE);

        expect(returned.refunded).toBe(false);
        expect(returned.owed).toBe(true);
        expect(mockUsers.get(WINNER).balance).toBe(200); // the one that could land, did
        expect(recordOwedPayout).toHaveBeenCalledTimes(1);
    });
});

// ─── refundAdoptFee: the keyed adoption-fee refund ──────────────────────────────

describe('refundAdoptFee hands the fee back exactly once', () => {
    const KEY = petAdoptRefundPayoutKey('i1');

    test('a refund lands under its key', async () => {
        mockUsers.seed({ userId: WINNER, guildId: GUILD, balance: 0, paidPayouts: [] });

        const back = await refundAdoptFee(WINNER, GUILD, 5000, 'i1');

        expect(back.credited).toBe(true);
        expect(mockUsers.get(WINNER).balance).toBe(5000);
        expect(mockUsers.get(WINNER).paidPayouts.some(p => p.key === KEY)).toBe(true);
    });

    test('a refund with no document is recorded as replayable coins', async () => {
        const back = await refundAdoptFee(WINNER, GUILD, 5000, 'i1');

        expect(back.credited).toBe(false);
        expect(back.owed).toBe(true);
        expect(recordOwedPayout).toHaveBeenCalledWith(expect.objectContaining({
            service: 'pet',
            jobName: 'petAdoptRefund',
            payload: expect.objectContaining({ kind: 'coins', amount: 5000, payoutKey: KEY }),
        }));
    });
});

// ─── The wording is read off the result, three ways ─────────────────────────────

describe('the notes say what actually happened to the coins', () => {
    test('a landed two-stake refund tells both players their wagers came back', () => {
        expect(battleRefundNote({ refunded: true })).toMatch(/Both wagers have been refunded/);
    });

    test('an owed two-stake refund says it was recorded, not returned', () => {
        const note = battleRefundNote({ refunded: false, owed: true });
        expect(note).toMatch(/recorded/);
        expect(note).not.toMatch(/Both wagers have been refunded/);
    });

    test('a two-stake refund that could not be recorded points at an admin', () => {
        expect(battleRefundNote({ refunded: false, owed: false })).toMatch(/contact a server admin/i);
    });

    test('a single-stake refund is worded from its own outcome', () => {
        expect(stakeRefundNote({ credited: true })).toMatch(/refunded/i);
        expect(stakeRefundNote({ credited: false, owed: true })).toMatch(/recorded/);
        expect(stakeRefundNote({ credited: false, owed: false })).toMatch(/contact a server admin/i);
    });

    test('the adopt refund note never claims coins came back when they did not', () => {
        expect(adoptRefundNote({ credited: true })).toMatch(/your coins were refunded/i);
        const owed = adoptRefundNote({ credited: false, owed: true });
        expect(owed).toMatch(/owed/);
        expect(owed).not.toMatch(/your coins were refunded/i);
        expect(adoptRefundNote({ credited: false, owed: false })).toMatch(/contact a server admin/i);
    });
});

// ─── The call sites go through the keyed path ───────────────────────────────────

const PET = path.join(__dirname, '..', 'src', 'commands', 'economy', 'pet');
const read = rel => fs.readFileSync(path.join(PET, rel), 'utf8');

describe('battle.js pays and refunds through the keyed helpers', () => {
    const src = () => read('battle.js');

    test('the winner payout goes through payBattleWinner, not a bare $inc', () => {
        expect(src()).toMatch(/payBattleWinner\(/);
        // The bare `$inc: { balance: payout }` that read nothing back is gone.
        expect(src()).not.toMatch(/\$inc:\s*\{\s*balance:\s*payout\s*\}/);
    });

    test('the escrow refunds go through the keyed helpers, not bare $incs', () => {
        expect(src()).toMatch(/refundBattleStake\(/);
        expect(src()).toMatch(/refundBothStakes\(/);
        // The bare `$inc: { balance: bet }` refunds are gone; the guarded escrow
        // debit `$inc: { balance: -bet }` stays.
        expect(src()).not.toMatch(/\$inc:\s*\{\s*balance:\s*bet\s*\}/);
        expect(src()).toMatch(/\$inc:\s*\{\s*balance:\s*-bet\s*\}/);
    });

    test('the payout and refund replies are worded from the result', () => {
        expect(src()).toMatch(/battleRefundNote\(/);
        expect(src()).toMatch(/stakeRefundNote\(/);
        expect(src()).toMatch(/paid\.credited/);
    });
});

describe('adopt.js refunds the fee through the keyed helper', () => {
    const src = () => read('adopt.js');

    test('the failed-save refund goes through refundAdoptFee, not a bare $inc', () => {
        expect(src()).toMatch(/refundAdoptFee\(/);
        expect(src()).toMatch(/adoptRefundNote\(/);
        // The bare `$inc: { balance: def.cost }` refund is gone; the guarded
        // debit `$inc: { balance: -def.cost }` stays.
        expect(src()).not.toMatch(/\$inc:\s*\{\s*balance:\s*def\.cost\s*\}/);
        expect(src()).toMatch(/\$inc:\s*\{\s*balance:\s*-def\.cost\s*\}/);
    });
});
