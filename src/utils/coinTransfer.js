'use strict';

/**
 * Moving coins from one player to another, once, for every command that does it.
 *
 * There were two of these. `/gift type:coins` enforced the anti-alt daily caps
 * — 10k out, 25k in — atomically, gated on account age, and rolled the sender
 * back when the credit missed. `/bank transfer` moved coins between the same two
 * parties with none of it: no cap, no age gate, no daily accounting, and no
 * rollback at all, so a failed credit simply destroyed the sender's coins
 * (#868) while the caps next door were decorative — anyone who hit the gift cap
 * used transfer instead (#897).
 *
 * Two implementations of one operation is what made that possible, so there is
 * one now, and the caps are a property of moving coins rather than a property of
 * having typed `/gift`. What is left at each call site is its own wording and
 * its own confirmation prompt, which is the part that genuinely differs.
 *
 * The order of operations is the one gift.js established, and each step is here
 * for a failure it prevents:
 *
 *   1. Debit the sender, with the balance check and the send-cap `$expr` in the
 *      same filter. A concurrent transfer cannot slip past a check it
 *      invalidated, because there is no gap between the check and the spend.
 *   2. Credit the receiver, with the receive cap in *that* filter.
 *   3. If the credit does not land — a cap reached in the race, a transient
 *      error, an E11000 on the upsert — roll the debit back, budget and all.
 *   4. If the rollback does not land either, write the refund down as an owed
 *      payout so `npm run payouts:replay` can settle it. That is the case that
 *      used to destroy coins outright.
 *
 * There is no transaction to reach for: the deployment is a standalone mongod
 * and PR #520 removed the transactions this codebase had. Atomic filters plus a
 * rollback plus a durable record of a rollback that failed is the shape the rest
 * of the economy already uses.
 */

const DEFAULT_USER = require('../models/User');
const { BUDGETS, budgetState, spendBudget, refundBudget } = require('./giftCaps');
const { recordOwedPayout } = require('./owedPayout');
const { transferRefundPayoutKey, isDuplicateKeyError } = require('./payoutKey');

/**
 * Fresh Discord accounts can't send or receive coins — blocks throwaway-alt
 * funnels, which is the same thing the daily caps are for and is worth applying
 * wherever they are.
 */
const MIN_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether either party's Discord account is too new, as the sentence to show
 * them, or null when both are old enough.
 *
 * Returned as a message rather than a boolean because which of the two it is
 * changes what the user can do about it, and a caller that had to work that out
 * again from a boolean would get it wrong in one of the two commands. `noun` is
 * what the command calls the thing being moved, so `/gift` keeps saying "gifts".
 */
function accountAgeRefusal(sender, receiver, { now = Date.now(), noun = 'coins' } = {}) {
    if (now - sender.createdTimestamp < MIN_ACCOUNT_AGE_MS) {
        return `Your Discord account is too new to send ${noun}. Try again in a few days.`;
    }
    if (now - receiver.createdTimestamp < MIN_ACCOUNT_AGE_MS) {
        return `${receiver.username}'s Discord account is too new to receive ${noun}.`;
    }
    return null;
}

/**
 * Where both coin budgets stand for a particular pair of users.
 *
 * Split out from the transfer itself because the pre-flight refusal has to name
 * the number that is left, and the confirmation prompt has to be shown before
 * anything is written. The states it returns are then handed back to
 * `commitCoinTransfer`, so the message the user saw and the filter that enforces
 * it were computed from the same reading.
 */
function coinBudgets(senderDoc, receiverDoc, limits) {
    return {
        send:    budgetState(senderDoc,   { ...BUDGETS.coinSend,    cap: limits.coinSend }),
        receive: budgetState(receiverDoc, { ...BUDGETS.coinReceive, cap: limits.coinReceive }),
    };
}

/**
 * Move `amount` coins from one user to another.
 *
 * @param {object}  opts
 * @param {string}  opts.senderId
 * @param {string}  opts.receiverId
 * @param {string}  opts.guildId
 * @param {number}  opts.amount        positive; the caller has already validated it
 * @param {object}  opts.limits        from `giftLimits(guildSettings)`
 * @param {object}  opts.budgets       from `coinBudgets`, taken before the confirm prompt
 * @param {string}  opts.refundKey     names *this* transfer, so a replayed refund
 *                                     cannot pay twice — `interaction.id` is what
 *                                     both callers use
 * @param {string}  [opts.service]     for the owed-payout record and the logs
 * @param {string}  [opts.jobName]
 * @param {object}  [opts.Model]
 *
 * @returns {Promise<object>} one of
 *   `{ status: 'ok', sender, receiver }`             both documents, post-write
 *   `{ status: 'debit_failed' }`                     balance or send cap moved under it
 *   `{ status: 'receive_cap', refunded, owed }`      receiver hit their cap in the race
 *   `{ status: 'credit_failed', refunded, owed, error }`
 *
 * `refunded` false with `owed` true means the coins are neither with the sender
 * nor the receiver but are written down for an operator to settle — the caller
 * has to say so rather than reporting a plain failure.
 */
async function commitCoinTransfer({
    senderId, receiverId, guildId, amount, limits, budgets,
    refundKey, service = 'economy', jobName = 'coinTransfer', Model = DEFAULT_USER,
}) {
    const sendSpend = spendBudget({
        ...BUDGETS.coinSend, cap: limits.coinSend, expired: budgets.send.expired, amount,
    });

    // The balance guard and the cap guard in one filter: if either has moved
    // since the pre-flight read, this matches nothing and no coins leave.
    const sender = await Model.findOneAndUpdate(
        { userId: senderId, guildId, balance: { $gte: amount }, ...sendSpend.filter },
        {
            $inc: { balance: -amount, ...sendSpend.inc },
            ...(Object.keys(sendSpend.set).length ? { $set: sendSpend.set } : {}),
        },
        { new: true },
    );
    if (!sender) return { status: 'debit_failed' };

    const rxSpend = spendBudget({
        ...BUDGETS.coinReceive, cap: limits.coinReceive, expired: budgets.receive.expired, amount,
    });

    // Two attempts, and only for E11000. The receiver's document is created by
    // an upsert that races every other command they are running, and losing that
    // race raises a duplicate-key error on the unique { userId, guildId } index
    // — which means the document now exists, so the second pass finds it and
    // needs no insert. Any other error is a real failure and is not retried:
    // repeating a write whose outcome is unknown is how a credit lands twice.
    let receiver = null;
    let creditError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            // No conditional upsert on the credit itself: an upsert whose filter
            // misses because of the cap `$expr` would try to *insert* a second
            // document for this user, which the unique index rejects.
            await Model.updateOne({ userId: receiverId, guildId }, {}, { upsert: true });
            receiver = await Model.findOneAndUpdate(
                { userId: receiverId, guildId, ...rxSpend.filter },
                {
                    $inc: { balance: amount, ...rxSpend.inc },
                    ...(Object.keys(rxSpend.set).length ? { $set: rxSpend.set } : {}),
                },
                { new: true },
            );
            creditError = null;
            break;
        } catch (err) {
            creditError = err;
            if (!isDuplicateKeyError(err)) break;
        }
    }

    if (receiver) return { status: 'ok', sender, receiver };

    // Nothing reached the receiver, so the sender's coins have to come back —
    // balance and the send budget both, or a failed transfer would quietly eat
    // the sender's allowance for the day.
    const status = creditError ? 'credit_failed' : 'receive_cap';
    let rollbackError;
    try {
        await Model.updateOne(
            { userId: senderId, guildId },
            { $inc: { balance: amount, ...refundBudget({ ...BUDGETS.coinSend, cap: limits.coinSend, amount }) } },
        );
        return { status, refunded: true, owed: false, error: creditError ?? null };
    } catch (err) {
        rollbackError = err;
    }

    // The debit committed and the refund will not. This is the point at which
    // coins used to simply cease to exist: written down instead, keyed so the
    // replay cannot pay it a second time, and reported to the caller as
    // unrefunded so nobody is told their coins came back when they did not.
    const owed = await recordOwedPayout({
        service,
        jobName,
        guildId,
        payload: {
            kind:      'coins',
            userId:    senderId,
            guildId,
            amount,
            payoutKey: transferRefundPayoutKey(refundKey),
        },
        error: rollbackError,
    });

    console.error(
        `[${service}] CRITICAL: ${amount} coins debited from ${senderId} in ${guildId} could not be ` +
        `credited or refunded — ${owed ? 'recorded as owed' : 'NOT RECORDED'}:`, rollbackError,
    );

    return { status, refunded: false, owed, error: creditError ?? rollbackError };
}

module.exports = { MIN_ACCOUNT_AGE_MS, accountAgeRefusal, coinBudgets, commitCoinTransfer };
