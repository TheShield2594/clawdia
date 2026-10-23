'use strict';

/**
 * The player's blackjack record — hands, wins, naturals and the current and
 * best winning streak — kept on `casinoStats` and shown in the table footer.
 *
 * One pipeline update, so the streak and the best streak move together and a
 * second hand settling at the same moment cannot read a half-written pair.
 * Best-effort by design: the coins have already moved by the time this runs,
 * and a record that fails to update must never hold up the result a player is
 * waiting to see.
 */

const User = require('../../models/User');

const field = name => ({ $ifNull: [`$casinoStats.${name}`, 0] });

/**
 * @param {object} filter  the player's `{ userId, guildId }`
 * @param {object} round
 * @param {number} round.net       coins the round came out ahead (negative behind)
 * @param {boolean} [round.natural] the player was dealt blackjack
 * @returns {Promise<?object>} the updated `casinoStats`, or null if it did not land
 */
async function recordBlackjackRound(filter, { net, natural = false }) {
    const won  = net > 0;
    const lost = net < 0;
    const streak = won ? { $add: [field('bjStreak'), 1] } : lost ? 0 : field('bjStreak');
    try {
        const doc = await User.findOneAndUpdate(filter, [
            { $set: {
                'casinoStats.bjHands':      { $add: [field('bjHands'), 1] },
                'casinoStats.bjWins':       { $add: [field('bjWins'), won ? 1 : 0] },
                'casinoStats.bjBlackjacks': { $add: [field('bjBlackjacks'), natural ? 1 : 0] },
                'casinoStats.bjStreak':     streak,
            } },
            { $set: {
                'casinoStats.bjBestStreak': { $max: [field('bjBestStreak'), '$casinoStats.bjStreak'] },
            } },
        ], { new: true, projection: { casinoStats: 1 }, updatePipeline: true });
        return doc?.casinoStats ?? null;
    } catch (err) {
        console.error('[blackjack] stats update failed:', err);
        return null;
    }
}

/** The footer's record line, or '' when there is nothing to show. */
function statsLine(stats) {
    if (!stats?.bjHands) return '';
    const parts = [`${stats.bjHands.toLocaleString()} hands`, `${stats.bjWins.toLocaleString()} won`];
    if (stats.bjBlackjacks) parts.push(`${stats.bjBlackjacks.toLocaleString()} blackjacks`);
    if (stats.bjStreak > 1) parts.push(`🔥 ${stats.bjStreak} in a row`);
    if (stats.bjBestStreak > 1) parts.push(`best ${stats.bjBestStreak}`);
    return parts.join(' · ');
}

module.exports = { recordBlackjackRound, statsLine };
