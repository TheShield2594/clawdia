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
        { new: false },
    );

    if (!before) return { taken: 0, balance: 0, matched: false };

    const prior = before.balance ?? 0;
    const taken = Math.min(wanted, prior);
    return { taken, balance: prior - taken, matched: true };
}

module.exports = { clampedDebitExpr, incExpr, debitUpTo };
