/**
 * Net worth = liquid balance + banked coins.
 *
 * Every surface that ranks users by wealth has to agree on what "wealth" means.
 * They did not: `/leaderboard economy` sorted by `{ balance: -1, bank: -1 }`
 * while displaying `balance + bank`, so a bank-heavy user showed a high total
 * and still never placed; the dashboard, the weekly badge job and the
 * newspaper each picked their own field. Same guild, four rankings.
 *
 * The sort is done in an aggregation rather than against a denormalised
 * `netWorth` column because the column would have to be kept in step by all 41
 * files that move coins — one missed `$inc` and the ranking silently rots. The
 * `{ guildId: 1, balance: -1, bank: -1 }` index still selects the guild's
 * documents; only the ordering of that one guild's users is computed, which is
 * what the dashboard has always done.
 */

// `$ifNull` guards documents written before `balance`/`bank` had defaults.
const NET_WORTH_EXPR = { $add: [{ $ifNull: ['$balance', 0] }, { $ifNull: ['$bank', 0] }] };

/** Net worth of an already-loaded user document or lean object. */
function netWorthOf(user) {
    return (user?.balance ?? 0) + (user?.bank ?? 0);
}

/**
 * Top `limit` users in `guildId` by net worth, richest first.
 *
 * `_id` breaks ties so two surfaces listing the same guild produce the same
 * order rather than whichever order the storage engine happened to return.
 * Results are plain objects: `{ userId, balance, bank, netWorth, ...extra }`.
 */
async function topByNetWorth(User, guildId, limit, extraProject = {}) {
    return User.aggregate([
        { $match: { guildId } },
        { $addFields: { netWorth: NET_WORTH_EXPR } },
        { $sort: { netWorth: -1, _id: 1 } },
        { $limit: limit },
        { $project: { _id: 0, userId: 1, balance: 1, bank: 1, netWorth: 1, ...extraProject } },
    ]);
}

/**
 * 1-based rank of `netWorth` within `guildId` — the count of users strictly
 * richer, plus one. Matches the ordering `topByNetWorth` produces.
 */
async function netWorthRank(User, guildId, netWorth) {
    const richer = await User.countDocuments({
        guildId,
        $expr: { $gt: [NET_WORTH_EXPR, netWorth] },
    });
    return richer + 1;
}

module.exports = { NET_WORTH_EXPR, netWorthOf, topByNetWorth, netWorthRank };
