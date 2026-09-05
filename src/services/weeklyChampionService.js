/**
 * The weekly grind competition: crowning and paying one champion per category,
 * per guild (#931).
 *
 * `utils/weeklyChampion.js` is what the grind commands call to record a run;
 * this is the other end — the Monday sweep that reads the closed week, claims
 * each winner and announces them. Registered as a job in
 * `services/scheduler/index.js`, which owns the cron expression and runs it
 * through `runJob`. Nothing here schedules itself (#611).
 *
 * This was an hourly competition: four categories, one winner each, announced
 * every hour on the hour for 500 coins apiece. In a large server that is a
 * lively ticker; in a small one it is 96 announcements a day naming the same
 * two people, and the announcement channel becomes something members mute.
 *
 * So the window is a week and the metric is cumulative — see
 * models/WeeklyChampion for why a week decided by a single lucky roll would not
 * be worth entering — and the reward is a week-sized prize rather than 168
 * hour-sized ones.
 *
 * @module services/weeklyChampionService
 */

const Guild = require('../models/Guild');
const { handlesGuild } = require('../utils/sharding');
const { recordOwedPayout, owedSummary } = require('../utils/owedPayout');
const { creditCoinsOnce, weeklyChampionPayoutKey } = require('../utils/payoutKey');
const { postAnnouncement } = require('../utils/guildAnnounce');
const { eventCommentary, addCommentary } = require('./commentaryService');
const COLORS = require('../utils/embedColors');

const WEEKLY_CATEGORY_LABELS = {
    // `unit` because `total` is not the same quantity in every category: three
    // of these accumulate coins and fish accumulates rarity tiers, and a line
    // reading "4,200 coins" for a scoreboard that never counted coins is a
    // number members will try to reconcile against their balance.
    fish:    { title: '🎣 Angler of the Week',   emoji: '🐟', unit: 'rarity score' },
    mine:    { title: '⛏️ Miner of the Week',     emoji: '💎', unit: 'coins mined' },
    hunt:    { title: '🏹 Hunter of the Week',    emoji: '🦌', unit: 'coins hunted' },
    // A category with no entry here is skipped when the week is announced — the
    // champion is still paid, just never named — so a new competition has to be
    // added in both places or it wins in silence.
    explore: { title: '🧭 Explorer of the Week',  emoji: '🗺️', unit: 'coins recovered' },
};

// Fixed order so the four lines of an announcement read the same way every
// week, whatever order the aggregation happened to group them in.
const WEEKLY_CATEGORY_ORDER = ['hunt', 'mine', 'fish', 'explore'];

// One prize per category per guild. Deliberately not 500 × 168: the hourly
// payout was a firehose that scaled with how often people played rather than
// with how well, and the point of the change is a prize worth winning that
// does not print coins by the hour.
const WEEKLY_CHAMPION_REWARD = 10_000;

/**
 * Crown one champion per grind category — hunt, mine, fish, explore — in each
 * guild, and pay each 10,000 coins.
 *
 * Weekly and one prize per category, deliberately: the hourly payout this
 * replaced scaled with how often people played rather than how well, and
 * printed coins by the hour.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function announceWeeklyChampions(client) {
    const { EmbedBuilder } = require('discord.js');
    const WeeklyChampion = require('../models/WeeklyChampion');
    const User           = require('../models/User');
    const { getPreviousWeekKey } = require('../utils/weeklyChampion');

    const prevWeek = getPreviousWeekKey();

    // The champion of each guild+category, picked in the database rather than by
    // pulling a week of every player's rows into the process. `rewarded` is
    // deliberately *not* in the `$match`: excluding an already-claimed row would
    // not skip that competition, it would crown whoever came second and pay them
    // too. The claim below is what makes the sweep safe to run twice.
    const candidates = await WeeklyChampion.aggregate([
        { $match: { week: prevWeek } },
        // `runs` then `createdAt` break a tie the same way every run, so a
        // re-run after a partial failure cannot crown a different player.
        { $sort: { total: -1, runs: -1, createdAt: 1 } },
        { $group: { _id: { guildId: '$guildId', category: '$category' }, top: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$top' } },
    ]);
    if (!candidates.length) return;

    // Per-guild job (src/services/scheduler): the aggregation spans every guild,
    // so the partition happens here, before the reward claim. A shard that
    // claimed another shard's champion would mark them rewarded and then be
    // unable to announce it.
    const mine = candidates.filter(c => handlesGuild(c.guildId, client));
    if (!mine.length) return;

    mine.sort((a, b) =>
        String(a.guildId).localeCompare(String(b.guildId)) ||
        WEEKLY_CATEGORY_ORDER.indexOf(a.category) - WEEKLY_CATEGORY_ORDER.indexOf(b.category));

    // Claim each champion atomically to prevent double-pay under concurrent runs
    const actualWinners = [];
    for (const w of mine) {
        const claimed = await WeeklyChampion.findOneAndUpdate(
            { _id: w._id, rewarded: false },
            { $set: { rewarded: true } },
            { new: true }
        );
        if (claimed) actualWinners.push(w);
    }
    if (!actualWinners.length) return;

    // Grant coin rewards first, decoupled from announcement availability.
    //
    // The claim above is one-way: this winner is `rewarded: true` now, so the
    // next tick will not find them again whatever happens here. That makes a
    // failed credit unrepeatable rather than merely unreported, so it is
    // written down as owed (#804) and counted, and the sweep fails at the end.
    //
    // A `null` return counts as a failure too. `findOneAndUpdate` without
    // `upsert` resolves to `null` when the user has no document in that guild —
    // it does not throw, so the old `.catch` never fired and a winner whose
    // record had been pruned was silently not paid while the announcement went
    // on naming them as rewarded.
    //
    // The credit carries a payout key (#807) so it is exactly-once rather than
    // at-least-once: a `$inc` whose response is lost is written down as owed and
    // paid a second time by the replay script, minting coins. The key is in the
    // credit's own filter, so the replay simply matches nothing.
    //
    // Which is also why `null` now has two meanings and the classification
    // matters — 'missing' is owed, 'duplicate' is done, and treating the second
    // as the first is #804 returning under a new name.
    const rewardAmount = WEEKLY_CHAMPION_REWARD;
    const paidWinners = [];
    let failedCredits = 0;
    let unrecordedCredits = 0;

    for (const winner of actualWinners) {
        const payoutKey = weeklyChampionPayoutKey(prevWeek, winner.category);
        let status = null;
        let creditErr = null;
        try {
            ({ status } = await creditCoinsOnce(
                { userId: winner.userId, guildId: winner.guildId },
                rewardAmount,
                payoutKey,
                { Model: User },
            ));
        } catch (err) {
            creditErr = err;
        }

        if (status === 'paid') {
            paidWinners.push(winner);
            continue;
        }

        // Already applied by an earlier attempt whose response was lost. The
        // winner has their coins, so they are announced with everyone else and
        // nothing is owed — the one outcome that is neither a success to credit
        // nor a failure to record.
        if (status === 'duplicate') {
            paidWinners.push(winner);
            console.warn(
                `[scheduler] weekly reward for ${winner.userId} in ${winner.guildId} ` +
                `(${winner.category}) was already applied under ${payoutKey} — not paid again`,
            );
            continue;
        }

        failedCredits += 1;
        const reason = creditErr?.message ?? (
            status === 'missing'
                ? `no user document for ${winner.userId} in ${winner.guildId}`
                : `credit for ${winner.userId} in ${winner.guildId} matched nothing without the payout key present`
        );
        const recorded = await recordOwedPayout({
            service: 'weeklyChampionService',
            jobName: 'announceWeeklyChampions',
            guildId: winner.guildId,
            payload: {
                kind:      'coins',
                userId:    winner.userId,
                guildId:   winner.guildId,
                amount:    rewardAmount,
                week:      prevWeek,
                category:  winner.category,
                payoutKey,
            },
            error: creditErr ?? new Error(reason),
        });
        if (!recorded) unrecordedCredits += 1;

        // Logged after the record write, not before it: this line is the only
        // trace of an unrecorded payout, so it has to say which of the two
        // happened rather than assume the queue write it has not made yet.
        console.error(
            `[scheduler] weekly reward credit failed for ${winner.userId} in ${winner.guildId} ` +
            `(${winner.category}, ${rewardAmount} coins) — ` +
            `${recorded ? 'recorded as owed' : 'NOT recorded, must be paid by hand'}:`, reason,
        );
    }

    // Announce per guild (best-effort — reward already granted above).
    // Only winners actually paid: the embed says "rewarded +10,000 coins", and a
    // winner whose credit is sitting in the owed queue has not been.
    const byGuild = new Map();
    for (const w of paidWinners) {
        if (!byGuild.has(w.guildId)) byGuild.set(w.guildId, []);
        byGuild.get(w.guildId).push(w);
    }

    for (const [guildId, guildWinners] of byGuild) {
        try {
            // `ai` rides along in the projection so the commentary below can be
            // asked for without a second read of the same document (#836).
            const guildDoc  = await Guild.findOne({ guildId }, 'economy name ai').lean();
            const channelId = guildDoc?.economy?.announcementChannelId ?? null;
            if (!channelId) continue;

            const lines = [];
            for (const winner of guildWinners) {
                const meta = WEEKLY_CATEGORY_LABELS[winner.category];
                if (!meta) continue;
                lines.push(
                    `${meta.emoji} **${meta.title}**\n` +
                    `<@${winner.userId}> (${winner.username}) — ` +
                    `**${(winner.total ?? 0).toLocaleString()} ${meta.unit}**${weeklyRunNote(winner)}` +
                    `${winner.bestDetails ? `\nBest of the week: **${winner.bestDetails}**` : ''}\n` +
                    `Rewarded **+${rewardAmount.toLocaleString()} coins**`
                );
            }

            if (!lines.length) continue;

            const embed = new EmbedBuilder()
                .setColor(COLORS.PRIZE)
                .setTitle('👑 Champions of the Week')
                .setDescription(lines.join('\n\n'))
                .setFooter({ text: 'Weekly competitions reset every Monday. Hunt, fish, mine and explore all week to compete!' })
                .setTimestamp();

            // One call for the week's whole slate rather than one per category:
            // four separate paragraphs about four winners is what the embed
            // above already is, and the commentary is worth having only if it
            // can read across them (#836).
            addCommentary(embed, await eventCommentary(guildDoc, {
                event: 'champions',
                facts: {
                    'this week\'s champions': guildWinners
                        .filter(w => WEEKLY_CATEGORY_LABELS[w.category])
                        .map(w => {
                            const meta = WEEKLY_CATEGORY_LABELS[w.category];
                            return `${meta.title}: ${w.username} with ${(w.total ?? 0).toLocaleString()} ${meta.unit}`
                                + `${w.bestDetails ? ` (best single result: ${w.bestDetails})` : ''}`;
                        })
                        .join('; '),
                    'what each of them won': `${rewardAmount.toLocaleString()} coins`,
                    'week ending': prevWeek
                }
            }).catch(() => null));

            await postAnnouncement(client, guildId, channelId, embed);
        } catch (err) {
            console.error(`[scheduler] announceWeeklyChampions failed for guild ${guildId}:`, err.message);
        }
    }

    // Last, so the winners who *were* paid are still announced. The per-winner
    // catch above is what stops one bad credit stranding the rest of the week;
    // on its own it also meant a week in which every credit failed returned
    // normally and runJob recorded a healthy run. Throwing here is what puts it
    // on /health and files the run-level dead-letter entry — the owed records
    // above are what make it recoverable.
    if (failedCredits) {
        throw new Error(
            `${failedCredits} of ${actualWinners.length} weekly reward(s) could not be credited — ` +
            owedSummary(failedCredits, unrecordedCredits)
        );
    }
}

// "over 37 runs" is the part of a weekly total that says how it was earned, and
// a champion crowned on a single run should not read as if they ground for it.
function weeklyRunNote(winner) {
    const runs = winner.runs ?? 0;
    if (runs <= 1) return '';
    return ` over ${runs.toLocaleString()} runs`;
}

module.exports = { announceWeeklyChampions, WEEKLY_CATEGORY_LABELS };
