'use strict';

const User = require('../models/User');
const { logTransaction } = require('./logTransaction');

/**
 * Best-effort return of coins a game already took.
 *
 * Never throws. Every caller is on a path that is itself handling a failure —
 * a wager escrowed for a flip that can't resolve, a payout that didn't land —
 * and losing the refund to a second error would be worse than logging it.
 * Shared so the two gambling commands can't drift apart on that guarantee.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.guildId
 * @param {number} opts.amount  - coins to credit back
 * @param {string} opts.type    - transaction type, e.g. 'coinflip' or 'roll'
 * @param {string} opts.note    - why the coins came back, for the audit log
 */
async function refundWager({ userId, guildId, amount, type, note }) {
    try {
        const doc = await User.findOneAndUpdate(
            { userId, guildId },
            { $inc: { balance: amount } },
            { new: true }
        );
        logTransaction({ userId, guildId, type, amount, balance: doc?.balance ?? 0, note });
    } catch (error) {
        console.error(`[${type}] refund of ${amount} to ${userId} in ${guildId} failed:`, error);
    }
}

module.exports = { refundWager };
