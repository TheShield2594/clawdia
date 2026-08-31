/**
 * "Take up to N coins, never more than they have" — atomically.
 *
 * A penalty that is capped at the player's wallet (a crime fine, a quiz
 * forfeit, coins knocked loose by a snowball) was written as a read followed by
 * a clamp followed by an unguarded `$inc`:
 *
 *     const fresh = await User.findOne(filter);
 *     const paid  = Math.min(fine, fresh.balance);
 *     await User.findOneAndUpdate(filter, { $inc: { balance: -paid } });
 *
 * The clamp is computed against a balance that is already history by the time
 * the `$inc` lands — spend coins in between and the debit takes more than is
 * there, which `$inc` will happily do straight past zero. The guarded form used
 * everywhere else (`balance: { $gte: cost }`) does not fit these: a fine is not
 * all-or-nothing, so a filter miss would have to fall back to another read and
 * another clamp, which is the same race one round deeper.
 *
 * Doing the clamp inside the update removes the window entirely — the balance
 * the subtraction reads is the balance being written.
 */

/**
 * Pipeline expression for `balance` after taking up to `amount`, floored at zero.
 */
function clampedDebitExpr(amount) {
    return { $max: [0, { $subtract: [{ $ifNull: ['$balance', 0] }, amount] }] };
}

/** Pipeline form of `$inc: { [path]: by }`, for folding counters into the same update. */
function incExpr(path, by) {
    return { $add: [{ $ifNull: [`$${path}`, 0] }, by] };
}

/**
 * Debits up to `amount` from the matched user and reports what was actually
 * taken, so callers can report the real figure rather than the one they hoped
 * for.
 *
 * `extraSet` holds further pipeline `$set` fields committed in the same update
 * (use `incExpr` for counters). Returns
 * `{ taken, balance, matched }` — `balance` being the balance after the debit,
 * and `matched` false when the filter matched nothing.
 */
async function debitUpTo(Model, filter, amount, extraSet = {}) {
    const wanted = Math.max(0, Math.floor(amount) || 0);

    // `new: false` returns the pre-image, which is the only way to learn how
    // much the clamp actually let through.
    const before = await Model.findOneAndUpdate(
        filter,
        [{ $set: { balance: clampedDebitExpr(wanted), ...extraSet } }],
        { updatePipeline: true, new: false },
    );

    if (!before) return { taken: 0, balance: 0, matched: false };

    const prior = before.balance ?? 0;
    const taken = Math.min(wanted, prior);
    return { taken, balance: prior - taken, matched: true };
}

/**
 * "Take exactly N coins, but only if they are still there" — the all-or-nothing
 * charge behind every purchase, as opposed to the clamped debit above.
 *
 * The balance a command reads to decide whether the player can afford something
 * goes stale the moment anything else pays or charges them, and `save()` would
 * write that stale value back as an absolute `$set`, erasing whatever landed in
 * between. Folding the check into the update's filter closes that window: if the
 * money moved, the filter matches nothing and the purchase simply does not
 * happen.
 *
 * Returns the updated document (balance only), or null when the player can no
 * longer afford it. The caller is expected to take `balance` from the result and
 * clear the path with `unmarkModified('balance')` before saving anything else.
 */
function chargeExact(Model, filter, cost) {
    return Model.findOneAndUpdate(
        { ...filter, balance: { $gte: cost } },
        { $inc: { balance: -cost } },
        { new: true, projection: { balance: 1 } },
    );
}

/**
 * Undoes a `chargeExact` when the purchase it paid for could not be persisted.
 *
 * `tag` names the caller in the log line, since a refund that itself fails is
 * the point at which a human has to go looking.
 */
function refundCharge(Model, filter, cost, tag = 'balance') {
    return Model.updateOne(filter, { $inc: { balance: cost } })
        .catch(err => console.error(`[${tag}] refund error:`, err));
}

module.exports = { clampedDebitExpr, incExpr, debitUpTo, chargeExact, refundCharge };
