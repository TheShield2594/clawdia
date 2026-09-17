'use strict';

/**
 * Where a two-way trade's assets are while the swap is happening (#1010).
 *
 * A trade is a symmetric duel escrow: both sides commit coins and/or an item,
 * both accept, and instead of one winning the assets are swapped. Like the duel,
 * the committed assets leave their owners and belong to nobody until the trade
 * resolves — so the same rule holds and for the same reason (#873, #969): a step
 * that gets it wrong here does not misreport a number, it makes or unmakes one.
 * None of this is about buttons or embeds, so it lives beside the other money
 * helpers rather than in the command.
 *
 * The shape is two phases with a hard boundary between them:
 *
 *   TAKE   — debit every committed asset out of its owner. Coins go through the
 *            keyed debit (`debitCoinsOrKnow`), so a lost response is a question
 *            the document can answer rather than a coin flip between minting and
 *            destroying. Items move by the same atomic `$elemMatch` debit `/gift`
 *            uses. If any take fails, everything already taken is handed back —
 *            coins through the keyed reversal, items through a keyed grant — and
 *            the trade is refused. Nothing has been delivered, so a refused take
 *            is a no-op the two parties never see the inside of.
 *
 *   DELIVER — the point of no return. Every credit goes through
 *            `creditCoinsOrOwe` / `grantItemsOrOwe`, which never throw and file
 *            an owed record when a delivery cannot land. So once both takes have
 *            succeeded the swap always completes: each asset is either delivered
 *            or written down for `npm run payouts:replay`, never left in limbo
 *            and never duplicated.
 *
 * The one window this shares with `/gift` is the un-keyed item debit: a removal
 * whose response is lost looks like one that never happened. It is the same
 * risk `/gift` has carried since #873 and is handled the same way — the coin
 * side, where it matters most, is keyed.
 */

const DEFAULT_USER = require('../models/User');
const { NOT_FROZEN } = require('./economyFreeze');
const { debitCoinsOrKnow, reverseKeyedDebit, resolveKeyedDebit } = require('./debitKey');
const { creditCoinsOrOwe, grantItemsOrOwe } = require('./creditOrOwe');
const {
    tradeCoinPayoutKey, tradeItemDeliverPayoutKey, tradeItemReturnPayoutKey,
} = require('./payoutKey');
const { BUDGETS, budgetState, spendBudget } = require('./giftCaps');
const { logTransaction } = require('./logTransaction');

/**
 * Names one side's coin stake in one trade, for the keyed debit that takes it.
 * Separate array from the payout keys below, exactly as the duel's escrow key is
 * separate from `duelPayoutKey`: a debit key and a credit key answer different
 * questions and a shared string would let one satisfy the other.
 */
function tradeCoinEscrowKey(tradeId, userId) {
    return `trade:${tradeId}:escrow:${userId}`;
}

/** The debit outcomes that mean "cannot cover", as opposed to "went wrong". */
const SHORT_STATUSES = new Set(['insufficient', 'frozen', 'missing']);

/** Takes one side's coins into escrow, keyed. No wager counter — a trade is not a bet. */
function takeCoins(userId, guildId, amount, tradeId, Model = DEFAULT_USER) {
    return debitCoinsOrKnow({ userId, guildId }, amount, tradeCoinEscrowKey(tradeId, userId), { Model });
}

/**
 * Hands an escrowed coin stake back, keyed. Safe to call without knowing whether
 * the debit landed: `reverseKeyedDebit` matches only a recorded, un-reversed
 * debit, so it cannot mint and cannot pay twice. When the reversal's own outcome
 * is unknown it reports not-returned rather than guessing — the escrow key on the
 * document is the durable record, and a later attempt settles it. This is the
 * `rollbackStake` reasoning from duelEscrow.js, applied to a trade.
 */
async function rollbackCoins(userId, guildId, amount, tradeId, Model = DEFAULT_USER) {
    if (amount <= 0) return { credited: true };
    const undo = await reverseKeyedDebit({ userId, guildId }, amount, tradeCoinEscrowKey(tradeId, userId), { Model });
    if (undo.resolved) return { credited: true };

    let state = null;
    try {
        state = await resolveKeyedDebit(Model, { userId, guildId }, tradeCoinEscrowKey(tradeId, userId));
    } catch (err) {
        console.error(`[trade] could not read the escrow key for ${userId} in ${guildId}:`, err.message);
    }
    if (state && (!state.landed || state.reversed)) return { credited: true };

    console.error(`[trade] coin reversal for ${userId} in ${guildId} is unconfirmed; the escrow key is the record`);
    return { credited: false };
}

/**
 * Removes one item stack from a side's inventory, atomically. The positional `$`
 * and the `$elemMatch` with `quantity: { $gte }` are the same guard `/gift`
 * uses: a single stack that can cover the amount, decremented once, never every
 * duplicate slot. `NOT_FROZEN` rides in the filter so a freeze landing mid-trade
 * cannot be squeezed past. Not keyed — the same un-keyed debit `/gift` has always
 * used — so the caller reads whether the write matched, not a key.
 *
 * @returns {Promise<{taken: boolean, doc: ?object}>}
 */
async function takeItem(userId, guildId, itemId, quantity, Model = DEFAULT_USER) {
    if (quantity <= 0) return { taken: true, doc: null };
    const debited = await Model.findOneAndUpdate(
        {
            userId, guildId, ...NOT_FROZEN,
            inventory: { $elemMatch: { itemId, quantity: { $gte: quantity } } },
        },
        { $inc: { 'inventory.$.quantity': -quantity } },
        { new: true },
    ).catch(err => {
        console.error(`[trade] item debit failed — user=${userId} guild=${guildId} item=${itemId}:`, err.message);
        return null;
    });
    if (!debited) return { taken: false, doc: null };
    // Drop the empty slot; cosmetic, so a failure here is ignored.
    await Model.updateOne(
        { userId, guildId },
        { $pull: { inventory: { itemId, quantity: { $lte: 0 } } } },
    ).catch(() => null);
    return { taken: true, doc: debited };
}

/**
 * Hands a committed item back to its owner on an aborted take, keyed so the
 * retry inside `grantItemsOrOwe` cannot hand back two copies and the owed record
 * it may file replays under the same guard.
 */
function returnItem(userId, guildId, itemId, quantity, tradeId, Model = DEFAULT_USER) {
    if (quantity <= 0) return Promise.resolve({ granted: true, owed: false });
    return grantItemsOrOwe({ userId, guildId }, itemId, quantity, {
        payoutKey: tradeItemReturnPayoutKey(tradeId, userId, itemId),
        service: 'trade', jobName: 'tradeItemReturn', Model,
    });
}

/** Delivers coins to one side, keyed and owed-on-failure. */
function deliverCoins(userId, guildId, amount, tradeId, Model = DEFAULT_USER) {
    return creditCoinsOrOwe({ userId, guildId }, amount, {
        payoutKey: tradeCoinPayoutKey(tradeId, userId),
        service: 'trade', jobName: 'tradeCoins', Model,
    });
}

/** Delivers an item to one side, keyed and owed-on-failure. */
function deliverItem(userId, guildId, itemId, quantity, tradeId, Model = DEFAULT_USER) {
    if (quantity <= 0) return Promise.resolve({ granted: true, owed: false });
    return grantItemsOrOwe({ userId, guildId }, itemId, quantity, {
        payoutKey: tradeItemDeliverPayoutKey(tradeId, userId, itemId),
        service: 'trade', jobName: 'tradeItemDeliver', Model,
    });
}

/**
 * The net value each side gives away, split by category, for the anti-funnel
 * caps (#1010). A fair swap nets to zero and consumes no budget; an unfair one
 * consumes budget equal to the imbalance, so a trade cannot launder a gift past
 * the daily caps. Coins and item value are kept apart because they are four
 * separate budgets — they are not offset against each other.
 *
 * @returns {{coinNet: number, itemNet: number}} positive means side A is the net
 *   giver in that category.
 */
function tradeBudgetFlows(offer) {
    const coinNet = (offer.a.coins || 0) - (offer.b.coins || 0);
    const itemNet = (offer.a.item?.value || 0) - (offer.b.item?.value || 0);
    return { coinNet, itemNet };
}

/**
 * Whether either daily cap would be exceeded by the net value moving in this
 * trade, as the sentence to show, or null when both sides are within their caps.
 *
 * Checked at confirm from freshly-read documents, not at open — the same reading
 * that words this refusal is the one the caps are measured against. The
 * enforcement is a pre-flight: the load-bearing guards on the coins themselves
 * are the keyed debits in the take phase, and these caps are the anti-alt-funnel
 * limit on top.
 */
function checkTradeBudgets(offer, { aDoc, bDoc, limits, currency = '💰', now = Date.now() }) {
    const { coinNet, itemNet } = tradeBudgetFlows(offer);
    const mention = id => `<@${id}>`;

    const overCap = (net, sendBudget, recvBudget, label, fmt) => {
        if (net === 0) return null;
        const senderId = net > 0 ? offer.a.userId : offer.b.userId;
        const recvId   = net > 0 ? offer.b.userId : offer.a.userId;
        const senderDoc = net > 0 ? aDoc : bDoc;
        const recvDoc   = net > 0 ? bDoc : aDoc;
        const amount = Math.abs(net);

        const send = budgetState(senderDoc, { ...sendBudget, cap: sendBudget.cap, now });
        if (amount > send.remaining) {
            return `${senderId === offer.a.userId ? 'You' : mention(senderId)} would send **${fmt(amount)}** net in ${label} — over the daily cap, with **${fmt(send.remaining)}** left today.`;
        }
        const recv = budgetState(recvDoc, { ...recvBudget, cap: recvBudget.cap, now });
        if (amount > recv.remaining) {
            return `${mention(recvId)} can only receive **${fmt(recv.remaining)}** more in ${label} today, and this trade nets them **${fmt(amount)}**.`;
        }
        return null;
    };

    const coins = fmt => `${currency}${fmt.toLocaleString()}`;
    return (
        overCap(coinNet,
            { ...BUDGETS.coinSend, cap: limits.coinSend },
            { ...BUDGETS.coinReceive, cap: limits.coinReceive },
            'coins', coins)
        || overCap(itemNet,
            { ...BUDGETS.itemValueSend, cap: limits.itemValueSend },
            { ...BUDGETS.itemValueReceive, cap: limits.itemValueReceive },
            'item value', coins)
    );
}

/**
 * Records the net value each side moved against their daily caps, once the swap
 * has gone through. Best-effort and after the fact rather than folded into the
 * take: the take is keyed on the coins, which is the guarantee; this is the
 * anti-funnel counter, and a trade is rare enough next to a gift that recording
 * it just behind the swap is a bounded, documented trade-off rather than a race
 * that can move a coin.
 */
async function recordTradeBudgets(offer, { aDoc, bDoc, limits, now = new Date(), Model = DEFAULT_USER }) {
    const { coinNet, itemNet } = tradeBudgetFlows(offer);

    const apply = async (net, sendBudget, recvBudget) => {
        if (net === 0) return;
        const amount = Math.abs(net);
        const senderId = net > 0 ? offer.a.userId : offer.b.userId;
        const recvId   = net > 0 ? offer.b.userId : offer.a.userId;
        const senderDoc = net > 0 ? aDoc : bDoc;
        const recvDoc   = net > 0 ? bDoc : aDoc;

        const send = spendBudget({ ...sendBudget, cap: sendBudget.cap, expired: budgetState(senderDoc, { ...sendBudget, cap: sendBudget.cap }).expired, amount, now });
        const recv = spendBudget({ ...recvBudget, cap: recvBudget.cap, expired: budgetState(recvDoc, { ...recvBudget, cap: recvBudget.cap }).expired, amount, now });

        const write = (userId, frag) => {
            if (!Object.keys(frag.inc).length && !Object.keys(frag.set).length) return null;
            const update = {};
            if (Object.keys(frag.inc).length) update.$inc = frag.inc;
            if (Object.keys(frag.set).length) update.$set = frag.set;
            return Model.updateOne({ userId, guildId: offer.guildId }, update).catch(() => null);
        };
        await Promise.all([write(senderId, send), write(recvId, recv)].filter(Boolean));
    };

    try {
        await apply(coinNet, { ...BUDGETS.coinSend, cap: limits.coinSend }, { ...BUDGETS.coinReceive, cap: limits.coinReceive });
        await apply(itemNet, { ...BUDGETS.itemValueSend, cap: limits.itemValueSend }, { ...BUDGETS.itemValueReceive, cap: limits.itemValueReceive });
    } catch (err) {
        console.error('[trade] recording daily budgets failed:', err.message);
    }
}

/**
 * The take phase: debit every committed asset out of its owner, unwinding
 * everything already taken if any step fails. Order is fixed (A's coins, A's
 * item, B's coins, B's item) so the unwind is a well-defined reverse.
 *
 * @returns {Promise<{success: boolean, reason: ?string}>}
 */
async function takeAll(offer, Model) {
    const { tradeId, guildId, a, b } = offer;
    const undo = [];
    const unwind = async () => { for (const fn of undo.reverse()) await fn(); };

    const takeSideCoins = async side => {
        if (!side.coins) return null;
        const r = await takeCoins(side.userId, guildId, side.coins, tradeId, Model);
        if (r.debited) {
            undo.push(() => rollbackCoins(side.userId, guildId, side.coins, tradeId, Model));
            return null;
        }
        // Unresolved: the coins may have left, so a blind keyed reversal is the
        // safe move — it is a no-op if they did not.
        if (!r.resolved) {
            await rollbackCoins(side.userId, guildId, side.coins, tradeId, Model);
            return 'error';
        }
        return SHORT_STATUSES.has(r.status) ? `short:${side.userId}` : 'error';
    };

    const takeSideItem = async side => {
        if (!side.item) return null;
        const r = await takeItem(side.userId, guildId, side.item.itemId, side.item.quantity, Model);
        if (r.taken) {
            undo.push(() => returnItem(side.userId, guildId, side.item.itemId, side.item.quantity, tradeId, Model));
            return null;
        }
        return `item:${side.userId}`;
    };

    for (const step of [
        () => takeSideCoins(a), () => takeSideItem(a),
        () => takeSideCoins(b), () => takeSideItem(b),
    ]) {
        const reason = await step();
        if (reason) {
            await unwind();
            return { success: false, reason };
        }
    }
    return { success: true, reason: null };
}

/**
 * The deliver phase: swap the taken assets across. Never throws — every credit
 * is owed-on-failure — so once this runs the trade has completed, delivered or
 * filed. `logTransaction` records a ledger row per asset moved, with the balance
 * read back from the credit rather than fabricated (a failed delivery logs
 * nothing, since nothing landed).
 */
async function deliverAll(offer, Model) {
    const { tradeId, guildId, a, b } = offer;
    const outcomes = [];

    const coin = async (fromId, toId, amount) => {
        if (!amount) return;
        const res = await deliverCoins(toId, guildId, amount, tradeId, Model);
        outcomes.push(res.credited);
        if (res.credited && res.doc) {
            logTransaction({ userId: toId, guildId, type: 'trade_coins_receive', amount, balance: res.doc.balance, relatedUserId: fromId, note: `Trade ${tradeId}` });
            logTransaction({ userId: fromId, guildId, type: 'trade_coins_send', amount: -amount, balance: null, relatedUserId: toId, note: `Trade ${tradeId}` });
        }
    };
    const item = async (fromId, toId, spec) => {
        if (!spec) return;
        const res = await deliverItem(toId, guildId, spec.itemId, spec.quantity, tradeId, Model);
        outcomes.push(res.granted);
        if (res.granted && res.doc) {
            logTransaction({ userId: toId, guildId, type: 'trade_item_receive', amount: 0, balance: res.doc.balance, relatedUserId: fromId, note: `Trade ${tradeId}: ${spec.quantity}x ${spec.itemId}` });
            logTransaction({ userId: fromId, guildId, type: 'trade_item_send', amount: 0, balance: null, relatedUserId: toId, note: `Trade ${tradeId}: ${spec.quantity}x ${spec.itemId}` });
        }
    };

    // A receives B's assets; B receives A's assets.
    await coin(b.userId, a.userId, b.coins);
    await coin(a.userId, b.userId, a.coins);
    await item(a.userId, b.userId, a.item);
    await item(b.userId, a.userId, b.item);

    return { delivered: outcomes.every(Boolean), owed: outcomes.some(o => o === false) };
}

/**
 * Run a confirmed trade end to end: take, then deliver.
 *
 * The caller has already resolved and validated both offers and the daily caps.
 * A refused take returns `success: false` and has unwound itself, so nothing
 * moved. A successful take always reaches a completed deliver.
 *
 * @param {{tradeId, guildId, a, b}} offer where each side is
 *        `{ userId, coins, item: { itemId, quantity, value } | null }`
 * @returns {Promise<{success: boolean, reason: ?string, delivered: boolean, owed: boolean}>}
 */
async function settleTrade(offer, { Model = DEFAULT_USER } = {}) {
    const took = await takeAll(offer, Model);
    if (!took.success) return { success: false, reason: took.reason, delivered: false, owed: false };
    const out = await deliverAll(offer, Model);
    return { success: true, reason: null, delivered: out.delivered, owed: out.owed };
}

module.exports = {
    settleTrade, takeAll, deliverAll,
    takeCoins, rollbackCoins, takeItem, returnItem, deliverCoins, deliverItem,
    tradeCoinEscrowKey, tradeBudgetFlows, checkTradeBudgets, recordTradeBudgets,
    SHORT_STATUSES,
};
