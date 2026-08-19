const mongoose = require('mongoose');

/**
 * Raises any already-negative `balance` or `bank` to zero.
 *
 * The User schema now declares `min: 0` on both. Mongoose validates the whole
 * document on `save()`, not just the paths that changed, so a user left
 * negative by one of the unguarded debits that have since been fixed would fail
 * validation on their next `save()` — and stay stuck there, unable to run any
 * command that saves, which is a worse state than the negative number itself.
 *
 * Zero is the repair: a negative balance is not a debt the economy models
 * anywhere (every debit is meant to be capped at the wallet), it is the residue
 * of a write that overshot. The count is logged so the damage is visible rather
 * than quietly erased.
 */
module.exports = {
    name: '011_clamp_negative_balances',

    async up() {
        const users = mongoose.connection.db.collection('users');

        for (const field of ['balance', 'bank']) {
            const result = await users.updateMany(
                { [field]: { $lt: 0 } },
                [{ $set: { [field]: 0 } }],
            );
            if (result.modifiedCount > 0) {
                console.log(`[MIGRATIONS] 011: clamped ${result.modifiedCount} negative ${field}(s) to 0.`);
            }
        }
    },
};
