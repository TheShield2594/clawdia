'use strict';

/**
 * Returning the crash stakes a restart stranded (#873, pass 12).
 *
 * Every crash stake is taken with `pendingCrashRefund: +bet` in the same write
 * as the debit, and every way a round resolves takes the marker back down. A
 * process that dies mid-round resolves nothing, so the marker is left standing,
 * and this sweep — run once from `src/events/ready.js` — is what turns it back
 * into coins. Pass 4 leaned on it by name: the join refund was left as a bare
 * `$inc` *because* a failure there leaves the marker for this sweep, and a
 * failed cash-out keeps its marker for the same reason.
 *
 * It had never refunded anything. The update was written as a pipeline —
 *
 *     [{ $inc: { balance: '$pendingCrashRefund' } }, { $set: { pendingCrashRefund: 0 } }]
 *
 * — and `$inc` is not a pipeline stage: an update pipeline takes `$set`/
 * `$addFields`, `$unset`/`$project` and `$replaceRoot`/`$replaceWith` and
 * nothing else. Mongoose rejects it before it reaches the server ("Invalid
 * update pipeline operator"), so the first stranded player threw out of the
 * loop, the whole sweep was logged as failed, and every marker in the database
 * was left exactly where it was, on every boot. The unit test beside it mocked
 * the model and asserted the broken shape, which is why nothing noticed.
 *
 * Three things beyond the stage are fixed with it:
 *
 *   - **The marker is claimed in the write that pays it.** `pendingCrashRefund`
 *     rides the update's filter, and the amount credited is the marker's own
 *     value in the same pipeline, so two sweeps racing each other (two
 *     processes booting together) cannot both pay one marker: the second finds
 *     it zeroed and matches nothing.
 *   - **The amount reported is the one that was paid.** It comes from the
 *     document as the write found it, not from the list read a moment earlier.
 *   - **Only this shard's guilds are swept.** A lobby lives in the one process
 *     Discord routes its guild to (`utils/sharding.js`), so a marker belonging
 *     to another shard's guild may be a stake riding a round that is live right
 *     now. Refunding it would return the stake and then let the round pay it
 *     out or lose it as well. Unsharded, `ownsGuild` is always true and this
 *     changes nothing.
 */

const User = require('../../models/User');
const { logTransaction } = require('../../utils/logTransaction');
const { ownsGuild } = require('../../utils/sharding');

/**
 * Refunds every stranded crash stake in the guilds this process owns.
 *
 * A failure on one player is logged and the sweep moves on to the next: the
 * marker it could not settle is still standing, so the next boot tries again.
 *
 * @param {object} [client]  the Discord client, for the shard it is
 * @returns {Promise<{refunded: number, failed: number}>}
 */
async function reconcileCrashRefunds(client = null) {
    const pending = await User.find(
        { pendingCrashRefund: { $gt: 0 } },
        'userId guildId pendingCrashRefund',
    ).lean();

    let refunded = 0;
    let failed   = 0;
    for (const stranded of pending) {
        if (!ownsGuild(stranded.guildId, client)) continue;
        try {
            // `new: false` so the document comes back as the write found it:
            // its marker is exactly what this write moved into the balance.
            const before = await User.findOneAndUpdate(
                { _id: stranded._id, pendingCrashRefund: { $gt: 0 } },
                [{
                    $set: {
                        balance: { $add: [{ $ifNull: ['$balance', 0] }, '$pendingCrashRefund'] },
                        pendingCrashRefund: 0,
                    },
                }],
                { updatePipeline: true, new: false, projection: { balance: 1, pendingCrashRefund: 1 } },
            );
            // Nothing matched: another sweep, or the round itself, got there first.
            if (!before) continue;

            const amount = before.pendingCrashRefund;
            logTransaction({
                userId:  stranded.userId,
                guildId: stranded.guildId,
                type:    'crash_refund',
                amount,
                balance: (before.balance ?? 0) + amount,
                note:    'bot restart refund',
            });
            refunded++;
        } catch (err) {
            failed++;
            console.error(`[crash] restart refund failed for ${stranded.userId} in ${stranded.guildId}:`, err);
        }
    }
    return { refunded, failed };
}

module.exports = { reconcileCrashRefunds };
