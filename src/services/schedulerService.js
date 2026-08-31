/**
 * The periodic economy and competition jobs: war and season resolution, the
 * weekly awards, shop price recalculation, bank interest, and returning expired
 * market listings.
 *
 * Nothing here schedules itself. Every exported function is registered as a job
 * in `services/scheduler/index.js`, which owns the cron expressions and runs
 * each through `runJob` — so a throw is recorded on the health payload and
 * filed as a dead-letter entry, and a tick is dropped rather than overlapped
 * while the previous run is still going. Adding a `setInterval` here instead
 * costs all of that (#611).
 *
 * They share a shape, and it is the shape a job that pays people out has to
 * have:
 *
 * - **Idempotent.** Payouts go through `creditCoinsOnce` / `grantItemOnce`
 *   against a payout key, so a job that runs twice — a retry, two processes,
 *   a resolution racing a manual one — pays once.
 * - **Per-guild failure isolation.** One guild's error is logged and the loop
 *   moves to the next; a bad document does not cost every other server its
 *   week. What propagates is a failure of the job itself, which is what
 *   `runJob` is there to record.
 * - **Announcements are best-effort.** A missing channel or a revoked
 *   permission never rolls back a payout that already landed.
 *
 * Each takes the Discord client and resolves when the sweep is done. None
 * returns a value; what they did is in the database and the announcements.
 * `returnExpiredMarketListings` is the exception — it posts nothing, so it
 * takes no client.
 *
 * @module services/schedulerService
 */

const Guild = require('../models/Guild');
const User  = require('../models/User');
const SeasonRecord = require('../models/SeasonRecord');
const { createWarVictoryBanner, createSeasonRecapCard } = require('../utils/cardGenerator');
const { PET_DEFINITIONS, heartBar } = require('./petService');
const { ensurePricingFields, nextPrice, decayDemand, demandDecayFactor, trendBucket, HISTORY_CAP } = require('../utils/dynamicPricing');
const { softResetElo, tierFor, makeSeasonId } = require('../utils/duelElo');
const { topByNetWorth } = require('../utils/netWorth');
const { recordOwedPayout } = require('../utils/owedPayout');
const { creditCoinsOnce, grantItemOnce, weeklyChampionPayoutKey, listingPayoutKey } = require('../utils/payoutKey');
const { eventCommentary, addCommentary } = require('./commentaryService');
const COLORS = require('../utils/embedColors');

const WAR_BOOSTER_DURATION_MS = 24 * 60 * 60 * 1000;
const WAR_BADGE_DURATION_MS   = 30 * 24 * 60 * 60 * 1000;
const LEADERBOARD_BADGE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

async function postAnnouncement(client, guildId, channelId, payload) {
    if (!channelId) return;
    try {
        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return;
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased?.()) return;
        await channel.send(typeof payload === 'object' && !payload.embeds ? { embeds: [payload] } : payload).catch(() => {});
    } catch (err) {
        console.error(`[scheduler] announcement post failed for guild ${guildId}:`, err.message);
    }
}

// Resolves a single expired war atomically. Returns true if this call performed
// the resolution (idempotent — concurrent invocations will only resolve once).
async function resolveOneWar(client, guildDoc) {
    const guildId = guildDoc.guildId;
    const war = guildDoc.activeWar;

    // Atomically flip status='active' → 'ended' so duplicate sweeps no-op
    const claimed = await Guild.findOneAndUpdate(
        { guildId, 'activeWar.status': 'active' },
        { $set: { 'activeWar.status': 'ended' } },
        { new: false }
    );
    if (!claimed) return false;

    const myScore = war.myScore ?? 0;
    const oppScore = war.opponentScore ?? 0;
    const tied = myScore === oppScore;
    const iWon = myScore > oppScore;

    // Opponent guild id and doc
    const opponentGuildId = war.opponentGuildId;
    const oppName = war.opponentGuildName ?? 'Enemy Server';

    // End the opponent's mirrored war record too
    if (opponentGuildId) {
        await Guild.findOneAndUpdate(
            { guildId: opponentGuildId, 'activeWar.opponentGuildId': guildId, 'activeWar.status': 'active' },
            { $set: { 'activeWar.status': 'ended' } }
        ).catch(err => console.error(`[scheduler] opponent war end failed:`, err.message));
    }

    // Determine winning/losing guild ids for badge and booster grants
    const winnerGuildId = iWon ? guildId : (tied ? null : opponentGuildId);
    const winnerName    = iWon ? guildDoc.name : (tied ? null : oppName);
    const loserName     = iWon ? oppName        : (tied ? null : guildDoc.name);
    const winnerScore   = iWon ? myScore : oppScore;
    const loserScore    = iWon ? oppScore : myScore;

    // Find MVP (highest duel wins in winning guild) and most-clutch (highest streak)
    let mvpUserId = null, mvpName = null, clutchUserId = null, clutchName = null;
    if (winnerGuildId && !tied) {
        try {
            const discordGuild = await client.guilds.fetch(winnerGuildId).catch(() => null);
            const [mvpUser, clutchUser] = await Promise.all([
                User.findOne({ guildId: winnerGuildId }).sort({ duelWins: -1 }).select('userId duelWins').lean(),
                User.findOne({ guildId: winnerGuildId }).sort({ 'streak.current': -1 }).select('userId streak').lean(),
            ]);
            if (mvpUser && discordGuild) {
                const m = await discordGuild.members.fetch(mvpUser.userId).catch(() => null);
                mvpUserId = mvpUser.userId;
                mvpName = m?.user?.username ?? null;
            }
            if (clutchUser && discordGuild && clutchUser.userId !== mvpUserId) {
                const c = await discordGuild.members.fetch(clutchUser.userId).catch(() => null);
                clutchUserId = clutchUser.userId;
                clutchName = c?.user?.username ?? null;
            }
        } catch {}
    }

    // Reward winners with a 24h 2x coin booster + 30d War Victor badge
    if (!tied && winnerGuildId) {
        const boosterExpiry = new Date(Date.now() + WAR_BOOSTER_DURATION_MS);
        const badgeExpiry   = new Date(Date.now() + WAR_BADGE_DURATION_MS);
        await User.updateMany(
            { guildId: winnerGuildId },
            {
                $push: {
                    activeEffects: { type: 'coin_booster_2x', expiresAt: boosterExpiry, charges: -1 },
                    badges:        { id: 'war_victor', label: '🎖️ War Victor', expiresAt: badgeExpiry }
                }
            }
        ).catch(err => console.error(`[scheduler] war rewards grant failed:`, err.message));
    }

    const { EmbedBuilder, AttachmentBuilder } = require('discord.js');

    // Build the victory banner image for the winning guild announcement
    let bannerAttachment = null;
    if (!tied && winnerName) {
        try {
            const buf = await createWarVictoryBanner(winnerName, winnerScore, loserName, loserScore, mvpName);
            bannerAttachment = new AttachmentBuilder(buf, {
                name: 'war_victory.png',
                description: `Victory banner: ${winnerName} beat ${loserName} by ${winnerScore} points to ${loserScore}`
                    + (mvpName ? `, with ${mvpName} as MVP.` : '.'),
            });
        } catch (err) {
            console.error('[scheduler] war banner generation failed:', err.message);
        }
    }

    // Helper to build guild-specific embed
    function buildWarEmbed(perspective) {
        // perspective: 'winner' | 'loser' | 'tie'
        if (perspective === 'tie') {
            return new EmbedBuilder()
                .setColor(COLORS.NEUTRAL)
                .setTitle('⚔️ War Ended — Tie!')
                .setDescription(
                    `The war between **${guildDoc.name}** and **${oppName}** ended in a tie!\n\n` +
                    `**${myScore.toLocaleString()}** pts — **${oppScore.toLocaleString()}** pts`
                )
                .setTimestamp();
        }
        if (perspective === 'winner') {
            const embed = new EmbedBuilder()
                .setColor(COLORS.PRIZE)
                .setTitle(`🏆 ${winnerName} WINS THE WAR`)
                .setDescription(
                    `**${winnerName}** has crushed **${loserName}**!\n\n` +
                    `**Score:** ${winnerScore.toLocaleString()} — ${loserScore.toLocaleString()}\n\n` +
                    `All members receive a **2× coin booster** for 24 hours and a **🎖️ War Victor** badge for 30 days!`
                )
                .setImage('attachment://war_victory.png');
            if (mvpUserId) embed.addFields({ name: '🏅 MVP', value: `<@${mvpUserId}> • ${mvpName ?? ''}`, inline: true });
            if (clutchUserId) embed.addFields({ name: '💪 Most Clutch', value: `<@${clutchUserId}> • ${clutchName ?? ''}`, inline: true });
            embed.setTimestamp();
            return embed;
        }
        // loser perspective
        return new EmbedBuilder()
            .setColor(COLORS.ERROR)
            .setTitle('⚔️ War Lost')
            .setDescription(
                `**${oppName}** has defeated **${guildDoc.name}**.\n\n` +
                `**Score:** ${myScore.toLocaleString()} — ${oppScore.toLocaleString()}\n\n` +
                `Train harder and challenge them again!`
            )
            .setTimestamp();
    }

    // Everything a commentator may say about this war, and nothing else (#836).
    // Built from the numbers the resolution above already computed, so the
    // colour commentary cannot invent a score or a player.
    const warFacts = {
        outcome: tied
            ? `${guildDoc.name} and ${oppName} drew`
            : `${winnerName} beat ${loserName}`,
        'final score': tied
            ? `${guildDoc.name} ${myScore.toLocaleString()} — ${oppName} ${oppScore.toLocaleString()}`
            : `${winnerName} ${winnerScore.toLocaleString()} — ${loserName} ${loserScore.toLocaleString()}`,
        margin: tied ? 'nothing in it — a draw' : Math.abs(myScore - oppScore).toLocaleString(),
        'MVP of the winning server': mvpName,
        'most clutch player': clutchName,
        'what the winners get': tied ? null : 'a 24-hour 2× coin booster and a 30-day War Victor badge'
    };

    /**
     * Post one side's announcement, with that server's own commentary on it.
     *
     * Each guild is asked separately and pays for its own: the two servers have
     * different personas, different budgets, and one of them may have the
     * feature switched off entirely. A guild that does gets exactly the embed it
     * would have got before — the commentary is a field on top of a complete
     * announcement, never a replacement for one, so a provider outage here costs
     * nobody their war result.
     */
    async function announceWar(targetDoc, targetGuildId, channelId, perspective) {
        if (!channelId) return;
        const embed = buildWarEmbed(perspective);

        const commentary = await eventCommentary(targetDoc, {
            event: 'war',
            facts: {
                ...warFacts,
                'the server you are writing for': targetDoc?.name || 'this server',
                'how it went for them': perspective === 'tie' ? 'a draw' : perspective === 'winner' ? 'they won' : 'they lost'
            }
        }).catch(() => null);
        addCommentary(embed, commentary);

        // The banner is the winner's, and only the winner's.
        const payload = perspective === 'winner' && bannerAttachment
            ? { embeds: [embed], files: [bannerAttachment] }
            : { embeds: [embed] };
        await postAnnouncement(client, targetGuildId, channelId, payload);
    }

    const oppDoc = opponentGuildId
        ? await Guild.findOne({ guildId: opponentGuildId }).lean()
        : null;
    const oppChannelId = oppDoc?.activeWar?.announcementChannelId ?? null;

    if (tied) {
        await announceWar(guildDoc, guildId, war.announcementChannelId, 'tie');
        if (opponentGuildId) await announceWar(oppDoc, opponentGuildId, oppChannelId, 'tie');
    } else if (iWon) {
        await announceWar(guildDoc, guildId, war.announcementChannelId, 'winner');
        if (opponentGuildId) await announceWar(oppDoc, opponentGuildId, oppChannelId, 'loser');
    } else {
        await announceWar(guildDoc, guildId, war.announcementChannelId, 'loser');
        if (opponentGuildId) await announceWar(oppDoc, opponentGuildId, oppChannelId, 'winner');
    }

    return true;
}

/**
 * Resolve every guild war whose window has closed: award the winner, hand out
 * boosters and badges, and post the victory banner to both servers.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function resolveExpiredWars(client) {
    const expired = await Guild.find({
        'activeWar.status': 'active',
        'activeWar.endsAt': { $ne: null, $lte: new Date() }
    });

    for (const guildDoc of expired) {
        try {
            await resolveOneWar(client, guildDoc);
        } catch (err) {
            console.error(`[scheduler] resolveOneWar failed for guild ${guildDoc.guildId}:`, err);
        }
    }
}

async function resolveOneSeason(client, guildDoc) {
    const guildId = guildDoc.guildId;
    const season = guildDoc.currentSeason;
    if (!season?.id) return false;

    // Atomically claim this season by clearing currentSeason.id. Duplicate sweeps no-op.
    const claimed = await Guild.findOneAndUpdate(
        { guildId, 'currentSeason.id': season.id },
        { $set: { currentSeason: { id: null, name: null, startedAt: null, endsAt: null } } },
        { new: false }
    );
    if (!claimed) return false;

    const topUsers = await User.find({ guildId })
        .sort({ seasonCoins: -1 })
        .limit(10)
        .select('userId seasonCoins')
        .lean();

    // Single guild fetch shared by name resolution, recap DMs, and announcement
    let seasonDiscordGuild = null;
    let announceChannelId  = null;
    try {
        seasonDiscordGuild = await client.guilds.fetch(guildId).catch(() => null);
        announceChannelId  = guildDoc.economy?.announcementChannelId
            ?? seasonDiscordGuild?.systemChannelId
            ?? null;
    } catch {}

    const resolvedNames = {};
    if (seasonDiscordGuild) {
        for (const u of topUsers.slice(0, 3)) {
            const member = await seasonDiscordGuild.members.fetch(u.userId).catch(() => null);
            resolvedNames[u.userId] = member?.user?.username ?? 'Unknown';
        }
    }

    // Freeze the leaderboard. Unique index on (guildId, seasonId) makes this idempotent.
    try {
        await SeasonRecord.create({
            guildId,
            seasonId: season.id,
            seasonName: season.name,
            startedAt: season.startedAt,
            endedAt: new Date(),
            top10: topUsers.map(u => ({
                userId: u.userId,
                username: resolvedNames[u.userId] ?? 'Unknown',
                coins: u.seasonCoins ?? 0
            }))
        });
    } catch (err) {
        // duplicate key means another worker already froze this season
        if (err.code !== 11000) throw err;
    }

    // Gather active participants for recap before resetting their coins
    const activePlayers = await User.find(
        { guildId, 'season.seasonId': season.id, 'season.xp': { $gt: 0 } },
        'userId season duelWins duelLosses questsCompleted hunt fishing mining'
    ).lean();

    // Build a rank map by seasonCoins for the recap cards
    const allRanked = await User.find(
        { guildId, 'season.seasonId': season.id },
        'userId seasonCoins'
    ).sort({ seasonCoins: -1 }).lean();
    const rankMap          = new Map(allRanked.map((u, i) => [u.userId, i + 1]));
    const totalParticipants = allRanked.length;

    // Reset seasonCoins for everyone in the guild
    await User.updateMany({ guildId }, { $set: { seasonCoins: 0 } })
        .catch(err => console.error('[scheduler] seasonCoins reset failed:', err.message));

    // DM each active player a personalised recap card (fire-and-forget)
    if (activePlayers.length > 0 && seasonDiscordGuild) {
        const { AttachmentBuilder } = require('discord.js');
        const capturedChannelId = announceChannelId;
        (async () => {
            for (const u of activePlayers) {
                try {
                    const member = await seasonDiscordGuild.members.fetch(u.userId).catch(() => null);
                    if (!member) continue;

                    const rank = rankMap.get(u.userId) ?? null;
                    const buf  = await createSeasonRecapCard(u, season.name ?? season.id, rank, totalParticipants);
                    const file = new AttachmentBuilder(buf, {
                        name: 'season_recap.png',
                        description: `${season.name ?? season.id} recap card for ${member.user.username}`
                            + (rank ? `, finishing ${rank} of ${totalParticipants}.` : '.'),
                    });

                    await member.send({
                        content: `🏁 **Your ${season.name ?? season.id} recap is here!** Screenshot and share it — see you next season!`,
                        files:   [file],
                    }).catch(() => {});
                } catch { /* non-critical per-user failure */ }
            }

            if (capturedChannelId) {
                await postAnnouncement(client, guildId, capturedChannelId,
                    `📸 **Season ended!** Check your DMs for your personalised recap card. Share it here and show off your season!`
                );
            }
        })().catch(err => console.error('[scheduler] season recap DMs failed:', err.message));
    }

    const { EmbedBuilder } = require('discord.js');
    const currency = guildDoc.economy?.currency ?? '💰';
    const medals = ['🥇', '🥈', '🥉'];
    const winnerLines = topUsers.slice(0, 3).map((u, i) =>
        `${medals[i]} <@${u.userId}> — ${(u.seasonCoins ?? 0).toLocaleString()} ${currency}`
    ).join('\n') || '*No participants*';

    const embed = new EmbedBuilder()
        .setColor(COLORS.PRIZE)
        .setTitle(`🏁 Season Ended: ${season.name ?? season.id}`)
        .setDescription('The season leaderboard has been frozen and season coins have been reset.')
        .addFields({ name: '🏆 Final Top 3', value: winnerLines })
        .setTimestamp();

    // The season's own sign-off, in the guild's voice (#836). The podium is
    // named rather than mentioned: the commentary is prose, and a model handed
    // `<@123>` writes it back into a sentence where it reads as noise.
    const podium = topUsers.slice(0, 3).map((u, i) =>
        `${i + 1}. ${resolvedNames[u.userId] ?? 'Unknown'} — ${(u.seasonCoins ?? 0).toLocaleString()} ${currency}`
    );
    addCommentary(embed, await eventCommentary(guildDoc, {
        event: 'season',
        facts: {
            season: season.name ?? season.id,
            'final podium': podium.length ? podium.join('; ') : 'nobody scored',
            'players who took part': totalParticipants,
            'winner\'s margin over second': topUsers.length > 1
                ? ((topUsers[0].seasonCoins ?? 0) - (topUsers[1].seasonCoins ?? 0)).toLocaleString()
                : null
        }
    }).catch(() => null));

    await postAnnouncement(client, guildId, announceChannelId, embed);
    return true;
}

/**
 * Close out every expired economy season: freeze the leaderboard, pay the top
 * three, reset season coins, and post the recap.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function resolveExpiredSeasons(client) {
    const expired = await Guild.find({
        'currentSeason.id': { $ne: null },
        'currentSeason.endsAt': { $ne: null, $lte: new Date() }
    });

    for (const guildDoc of expired) {
        try {
            await resolveOneSeason(client, guildDoc);
        } catch (err) {
            console.error(`[scheduler] resolveOneSeason failed for guild ${guildDoc.guildId}:`, err);
        }
    }
}

/**
 * Award the 7-day 👑 #1 badge to the top member in each leaderboard category,
 * in every guild. Weekly.
 *
 * Takes a short lease per guild (`badgesAwardLeaseAt`) so a second runner
 * cannot double-award the same week.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function awardWeeklyLeaderboardBadges(client) {
    const { EmbedBuilder } = require('discord.js');

    const guilds = await Guild.find({}, 'guildId name economy').lean();
    const weekAgo = new Date(Date.now() - LEADERBOARD_BADGE_DURATION_MS);

    for (const guildDoc of guilds) {
        const guildId = guildDoc.guildId;
        try {
            // Atomically acquire a short-lived lease; badgesLastAwardedAt is only written on success
            const leaseUntil = new Date(Date.now() + 5 * 60 * 1000); // 5-minute lease window
            const leased = await Guild.findOneAndUpdate(
                {
                    guildId,
                    // Both conditions, under $and. They were two `$or` keys in
                    // one object literal, so the second silently replaced the
                    // first and only the lease was ever checked: the weekly
                    // cadence was not enforced at all, and badges could be
                    // re-awarded as soon as a five-minute lease lapsed.
                    $and: [
                        { $or: [{ badgesLastAwardedAt: null }, { badgesLastAwardedAt: { $lte: weekAgo } }] },
                        { $or: [{ badgesAwardLeaseAt: null }, { badgesAwardLeaseAt: { $lte: new Date() } }] },
                    ],
                },
                { $set: { badgesAwardLeaseAt: leaseUntil } },
                { new: false }
            );
            if (!leased) continue;

            const categories = [
                { key: 'levels',       sort: { level: -1, xp: -1 },            label: '📈 Top Level' },
                // Wealth ranks on balance + bank, same as every other wealth surface —
                // sorting on `balance` alone crowned whoever kept the most cash out
                // of the bank rather than whoever actually had the most. `netWorth`
                // routes this one through the shared aggregation instead of `sort`.
                { key: 'economy',      netWorth: true,                          label: '💰 Wealthiest' },
                { key: 'streaks',      sort: { 'streak.current': -1 },          label: '🔥 Longest Streak' },
                { key: 'duels',        sort: { duelWins: -1 },                  label: '⚔️ Duel Champion' },
                { key: 'achievements', sort: { achievementsCount: -1 },         label: '🏅 Achievement Hunter' },
            ];

            const badgeExpiry = new Date(Date.now() + LEADERBOARD_BADGE_DURATION_MS);
            const champLines = [];
            const discordGuild = await client.guilds.fetch(guildId).catch(() => null);

            for (const cat of categories) {
                const top = cat.netWorth
                    ? (await topByNetWorth(User, guildId, 1))[0]
                    : await User.findOne({ guildId }).sort(cat.sort).select('userId').lean();
                if (!top) continue;

                // Award badge (deduplicate: remove existing #1 badge for this category first)
                await User.updateOne(
                    { userId: top.userId, guildId },
                    {
                        $pull:  { badges: { id: `leaderboard_1_${cat.key}` } },
                    }
                ).catch(err => console.error(`[scheduler] badge $pull failed for ${top.userId}:`, err.message));
                await User.updateOne(
                    { userId: top.userId, guildId },
                    {
                        $push: { badges: { id: `leaderboard_1_${cat.key}`, label: '👑 #1', expiresAt: badgeExpiry } }
                    }
                ).catch(err => console.error(`[scheduler] badge $push failed for ${top.userId}:`, err.message));

                let username = `<@${top.userId}>`;
                if (discordGuild) {
                    const member = await discordGuild.members.fetch(top.userId).catch(() => null);
                    if (member) username = `<@${top.userId}> (${member.user.username})`;
                }
                champLines.push(`${cat.label}: ${username}`);
            }

            if (!champLines.length) {
                await Guild.updateOne({ guildId }, { $set: { badgesLastAwardedAt: new Date(), badgesAwardLeaseAt: null } });
                continue;
            }

            // Find announcement channel: economy.announcementChannelId or systemChannel
            let announceChannelId = guildDoc.economy?.announcementChannelId ?? null;
            if (!announceChannelId && discordGuild) {
                announceChannelId = discordGuild.systemChannelId ?? null;
            }
            if (!announceChannelId) {
                await Guild.updateOne({ guildId }, { $set: { badgesLastAwardedAt: new Date(), badgesAwardLeaseAt: null } });
                continue;
            }

            const embed = new EmbedBuilder()
                .setColor(COLORS.PRIZE)
                .setTitle('👑 Last Week\'s Champions')
                .setDescription(
                    'These legends dominated the leaderboards this week.\n' +
                    'Each earns a **👑 #1** badge for 7 days, visible on `/rank` and `/leaderboard`.'
                )
                .addFields({ name: '🏆 Winners', value: champLines.join('\n') })
                .setTimestamp();

            await postAnnouncement(client, guildId, announceChannelId, embed);
            // All work succeeded — commit the run timestamp and release lease
            await Guild.updateOne({ guildId }, { $set: { badgesLastAwardedAt: new Date(), badgesAwardLeaseAt: null } });
        } catch (err) {
            console.error(`[scheduler] weeklyLeaderboardBadges failed for guild ${guildId}:`, err.message);
            // Release lease so this guild is eligible for retry on the next cron tick
            await Guild.updateOne({ guildId }, { $set: { badgesAwardLeaseAt: null } }).catch(() => {});
        }
    }
}

// ── Pet of the Week ───────────────────────────────────────────────────────────

// Pet of the Week payout. Overridable per guild via economy.potwReward.
const POTW_COIN_REWARD = 5_000;

/**
 * Pick each guild's Pet of the Week and pay its owner — 5,000 coins by default,
 * overridable per guild with `economy.potwReward`.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function selectPetOfTheWeek(client) {
    const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
    const { generatePetSprite } = require('../utils/cardGenerator');
    const { logTransaction } = require('../utils/logTransaction');

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const guilds  = await Guild.find({}, 'guildId economy potwLastRunAt').lean();

    for (const guildDoc of guilds) {
        const guildId = guildDoc.guildId;
        try {
            // Atomic claim: only proceed if this guild hasn't been processed this week
            const claimed = await Guild.findOneAndUpdate(
                { guildId, $or: [{ potwLastRunAt: null }, { potwLastRunAt: { $lte: weekAgo } }] },
                { $set: { potwLastRunAt: new Date() } },
                { new: false }
            );
            if (!claimed) continue; // another worker already ran POTW for this guild this week

            // Pick the winner in the database rather than loading every user with a
            // pet into memory and scanning in JS.
            const [top] = await User.aggregate([
                { $match: { guildId, 'pets.0': { $exists: true } } },
                { $unwind: '$pets' },
                { $match: { 'pets.weeklyInteractions': { $gt: 0 } } },
                { $sort: { 'pets.weeklyInteractions': -1 } },
                { $limit: 1 },
                { $project: { _id: 0, userId: 1, pet: '$pets' } },
            ]);

            // Crown the winner BEFORE clearing counters. Doing it the other way
            // round meant a failure between the two left the week with no POTW and
            // the counts already wiped, with nothing to recompute from.
            if (top?.pet?._id) {
                await User.updateOne(
                    { guildId, userId: top.userId, 'pets._id': top.pet._id },
                    { $set: { 'pets.$.potw': true } }
                );
            }

            // Clear last week's ribbons and counters, leaving the new winner's flag.
            // Two writes rather than one: mixing $[] and $[old] over the same array
            // in a single $set is a path conflict MongoDB can reject.
            await User.updateMany(
                { guildId },
                { $set: { 'pets.$[old].potw': false } },
                { arrayFilters: [{ 'old._id': { $ne: top?.pet?._id ?? null } }] }
            );
            await User.updateMany({ guildId }, { $set: { 'pets.$[].weeklyInteractions': 0 } });

            if (!top?.pet) continue;
            const bestUser  = { userId: top.userId };
            const bestPet   = top.pet;
            const bestCount = bestPet.weeklyInteractions ?? 0;

            // Winning is worth something now — it used to be a flag and an embed.
            const potwCoins = guildDoc.economy?.potwReward ?? POTW_COIN_REWARD;
            if (potwCoins > 0) {
                const paid = await User.findOneAndUpdate(
                    { guildId, userId: bestUser.userId },
                    { $inc: { balance: potwCoins } },
                    { new: true }
                );
                logTransaction({
                    userId: bestUser.userId, guildId, type: 'potw_reward', amount: potwCoins,
                    balance: paid?.balance ?? 0, note: 'Pet of the Week reward',
                });
            }

            // Determine announcement channel
            let channelId = guildDoc.economy?.announcementChannelId ?? null;
            if (!channelId) {
                const dg = await client.guilds.fetch(guildId).catch(() => null);
                if (dg) channelId = dg.systemChannelId ?? null;
            }
            if (!channelId) continue;

            const def      = PET_DEFINITIONS[bestPet.petId];
            const name     = bestPet.name || def?.name || bestPet.petId;
            const bondDays = Math.floor((Date.now() - new Date(bestPet.adoptedAt).getTime()) / 86400000);

            const embed = new EmbedBuilder()
                .setColor(COLORS.PRIZE)
                .setTitle('🌟 Pet of the Week!')
                .setDescription(
                    `This week's most beloved pet is:\n\n` +
                    `${def?.emoji ?? '🐾'} **${name}** — owned by <@${bestUser.userId}>\n\n` +
                    `_${bestCount} interaction${bestCount !== 1 ? 's' : ''} this week_`
                )
                .addFields({ name: '❤️ Bond', value: `${heartBar(bondDays)} ${bondDays} days`, inline: true })
                .setFooter({ text: 'Earn the ribbon by feeding, playing with, or resting your pet!' })
                .setTimestamp();

            // Only advertise a prize when one is actually paid; potwReward can be 0.
            if (potwCoins > 0) {
                embed.addFields({ name: '🏆 Prize', value: `${potwCoins.toLocaleString()} coins`, inline: true });
            }

            let files = [];
            try {
                const spriteBuf = await generatePetSprite(bestPet.petId, 80, bestPet.evolutionStage ?? 1);
                embed.setThumbnail('attachment://potw_sprite.png');
                files = [new AttachmentBuilder(spriteBuf, {
                    name: 'potw_sprite.png',
                    description: `Pixel-art sprite of ${name}, the pet of the week.`,
                })];
            } catch { /* non-critical */ }

            await postAnnouncement(client, guildId, channelId, { embeds: [embed], files });
        } catch (err) {
            console.error(`[scheduler] selectPetOfTheWeek failed for guild ${guildId}:`, err.message);
        }
    }
}

// What a sweep says about the payouts it could not deliver.
//
// The distinction matters to whoever reads the failure: a payout recorded as
// owed is one command away from being paid, and one that could not even be
// recorded is not — the claim is still spent, so nothing will find it again and
// the log line is all that is left of it. Reporting both as "recorded as owed"
// would send an operator to `payouts:replay` for a record that is not there.
function owedSummary(failed, unrecorded) {
    const recorded = failed - unrecorded;
    if (!unrecorded) return 'recorded as owed, replay with `npm run payouts:replay`';
    if (!recorded) return 'none could be recorded as owed; they must be paid by hand, see the log above';
    return (
        `${recorded} recorded as owed (replay with \`npm run payouts:replay\`); ` +
        `${unrecorded} could not be recorded and must be paid by hand, see the log above`
    );
}

// ── Weekly Champion Announcements ─────────────────────────────────────────────
//
// This was an hourly competition: four categories, one winner each, announced
// every hour on the hour for 500 coins apiece. In a large server that is a
// lively ticker; in a small one it is 96 announcements a day naming the same
// two people, and the announcement channel becomes something members mute.
//
// So the window is a week and the metric is cumulative — see models/WeeklyChampion
// for why a week decided by a single lucky roll would not be worth entering —
// and the reward is a week-sized prize rather than 168 hour-sized ones.

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

    candidates.sort((a, b) =>
        String(a.guildId).localeCompare(String(b.guildId)) ||
        WEEKLY_CATEGORY_ORDER.indexOf(a.category) - WEEKLY_CATEGORY_ORDER.indexOf(b.category));

    // Claim each champion atomically to prevent double-pay under concurrent runs
    const actualWinners = [];
    for (const w of candidates) {
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
            service: 'schedulerService',
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

// ─── Dynamic shop pricing recalculation (issue #354) ────────────────────────
//
// Shop items carry their icon inline, as an `imageData` Buffer on the subdocument
// (see the `shop` array in models/Guild.js). That makes the whole-document
// read-mutate-`save()` shape this job used to have proportional to the size of a
// guild's uploaded artwork rather than to the handful of numbers it changes:
// every fifteen minutes it pulled every icon of every dynamic-pricing guild into
// the process, and `markModified('shop')` then wrote all of them back untouched.
//
// So the shop is read under a projection that names only the pricing fields, and
// the new prices go back as a `bulkWrite` of per-item `$set`s. The Buffers are
// never read and never rewritten.
/**
 * Move every dynamic-pricing guild's shop prices one step toward what demand
 * says they should be, decay the demand scores, and append to the price history.
 *
 * Reads the shop under a projection naming only the pricing fields and writes
 * the new prices as a `bulkWrite` of per-item `$set`s. That is not a
 * micro-optimisation: shop items carry their icon inline as an `imageData`
 * Buffer, so the whole-document read-mutate-`save()` this replaced pulled every
 * icon of every guild into the process every fifteen minutes and wrote them all
 * back untouched.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function recalcShopPrices(client) {
    const { EmbedBuilder } = require('discord.js');
    // Only the lease window is needed here; the claim below re-reads the guild.
    const guilds = await Guild.find({ 'dynamicPricing.enabled': true }, 'guildId dynamicPricing.recalcMinutes').lean();

    for (const guildSummary of guilds) {
        try {
            const recalcMs = (guildSummary.dynamicPricing?.recalcMinutes ?? 60) * 60_000;
            const now      = new Date();
            const leaseCutoff = new Date(now.getTime() - recalcMs);

            // Atomically claim this guild's recalc window. The update only
            // succeeds when lastRecalcAt is null or older than the lease window,
            // ensuring concurrent workers (multi-instance deployments) don't
            // both run the recalc for the same guild.
            //
            // `priceHistory` is deliberately absent from the projection: the write
            // below appends to it with `$push`/`$slice` rather than replacing it,
            // so there is no reason to carry thirty entries per item back and forth.
            const guildDoc = await Guild.findOneAndUpdate(
                {
                    guildId: guildSummary.guildId,
                    'dynamicPricing.enabled': true,
                    $or: [
                        { 'dynamicPricing.lastRecalcAt': null },
                        { 'dynamicPricing.lastRecalcAt': { $lte: leaseCutoff } },
                    ],
                },
                { $set: { 'dynamicPricing.lastRecalcAt': now } },
                {
                    new: true,
                    projection: 'guildId dynamicPricing economy.announcementChannelId economy.currency '
                        + 'shop._id shop.name shop.price shop.basePrice shop.currentPrice shop.demandScore',
                }
            ).lean();
            if (!guildDoc) continue; // another worker already claimed this window

            const shop = Array.isArray(guildDoc.shop) ? guildDoc.shop : [];
            // Captured before the backfill, because the write below names a field
            // only where this job is the one that changed it. `basePrice` is set by
            // admins through the dashboard, and writing back the value we read
            // would undo an edit made while we were computing.
            const priorState = shop.map(item => ({
                hadBasePrice: item.basePrice != null,
                // `$mul` rejects a null, and treats a missing field as zero — which
                // is the right answer for an item that predates demand tracking, but
                // has to be reached with `$set` rather than by multiplying.
                hadDemandScore: typeof item.demandScore === 'number',
            }));
            ensurePricingFields(shop);

            const band        = guildDoc.dynamicPricing.priceBand ?? 0.5;
            const volatility  = guildDoc.dynamicPricing.volatility ?? 'medium';
            const decayFactor = demandDecayFactor(volatility);
            const changedMovers = [];
            const writes = [];

            for (const [index, item] of shop.entries()) {
                const prev = item.currentPrice ?? item.basePrice ?? item.price;
                // Both read the demand score as it was at claim time, which is what
                // the price is supposed to follow; only the stored score is left to
                // the database to decay.
                item.currentPrice = nextPrice(item, band, volatility);
                item.demandScore  = decayDemand(item, volatility);

                // Nothing else writes `currentPrice`, and this job holds the guild's
                // recalc lease, so it is the sole author of that field.
                const set = { 'shop.$.currentPrice': item.currentPrice };
                if (!priorState[index].hadBasePrice) set['shop.$.basePrice'] = item.basePrice;

                const update = {
                    $set: set,
                    $push: {
                        'shop.$.priceHistory': {
                            // A snapshot of the score this tick's price was computed
                            // from; a buy landing during the write moves the stored
                            // score without rewriting this row.
                            $each: [{ at: now, price: item.currentPrice, demandScore: item.demandScore }],
                            $slice: -HISTORY_CAP,
                        },
                    },
                };
                if (priorState[index].hadDemandScore) {
                    update.$mul = { 'shop.$.demandScore': decayFactor };
                } else {
                    set['shop.$.demandScore'] = item.demandScore;
                }

                // Matched by subdocument `_id` rather than by array index: an admin
                // adding or removing a shop item between the read and the write
                // shifts the indices, and an index-addressed `$set` would then land
                // the new price on somebody else's item. A stale `_id` simply
                // matches nothing.
                //
                // Backfilling an item additionally requires that it still have no
                // basePrice. That is the one field here whose value is read rather
                // than derived, so an admin setting it between the claim and this
                // write is a real edit to lose. Failing the predicate skips the item
                // for this tick — including its currentPrice and history entry,
                // which were computed from the basePrice that no longer applies —
                // and the next tick recomputes from the admin's value.
                //
                // `{ basePrice: null }` matches an absent field as well as an
                // explicit null, which is the same set `item.basePrice == null`
                // selected when priorState was captured.
                const filter = priorState[index].hadBasePrice
                    ? { guildId: guildDoc.guildId, 'shop._id': item._id }
                    : { guildId: guildDoc.guildId, shop: { $elemMatch: { _id: item._id, basePrice: null } } };

                writes.push({
                    updateOne: {
                        filter,
                        update,
                    },
                });

                // Movers are collected from the computed values rather than from
                // what the write matched, since bulkWrite reports matches only in
                // aggregate. A backfill item losing its predicate could therefore be
                // named in the embed without its price having landed — cosmetic, and
                // it needs an admin edit to land inside the same few milliseconds.
                if (Math.abs(item.currentPrice - prev) / Math.max(1, prev) > 0.05) {
                    changedMovers.push({ name: item.name, prev, next: item.currentPrice, item });
                }
            }

            if (writes.length) await Guild.bulkWrite(writes);

            const channelId = guildDoc.economy?.announcementChannelId;
            if (channelId && changedMovers.length) {
                const currency = guildDoc.economy?.currency ?? '💰';
                const top = changedMovers
                    .sort((a, b) => Math.abs(b.next - b.prev) - Math.abs(a.next - a.prev))
                    .slice(0, 5);
                const lines = top.map(m => {
                    const tb = trendBucket(m.item);
                    return `${tb.arrow} **${m.name}** — ${currency}${m.prev.toLocaleString()} → ${currency}${m.next.toLocaleString()}`;
                });
                const embed = new EmbedBuilder()
                    .setColor(COLORS.INFO)
                    .setTitle('📊 Market Update')
                    .setDescription(lines.join('\n'))
                    .setFooter({ text: 'Supply and demand shifted shop prices. Use /shop trends for the full board.' })
                    .setTimestamp();
                await postAnnouncement(client, guildDoc.guildId, channelId, embed);
            }
        } catch (err) {
            console.error(`[scheduler] recalcShopPrices failed for guild ${guildSummary.guildId}:`, err);
        }
    }
}

// ─── Ranked duel season rollover (issue #339) ────────────────────────────────
// Resolves and rolls over expired ranked-duel seasons:
//  1. Awards top-3 prizes (coins + seasonal title)
//  2. Soft-decays all ELO toward 1200
//  3. Resets season counters and starts the next season
/**
 * Roll over expired ranked-duel seasons: pay the top three and give them the
 * seasonal title, soft-decay every ELO toward 1200, reset the counters and
 * start the next season.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function resolveRankedSeasons(client) {
    const { EmbedBuilder } = require('discord.js');
    const now = new Date();
    // Initialize the first season for any guild that has ranked enabled but no season yet
    const uninitialized = await Guild.find({
        'rankedDuels.enabled': true,
        $or: [
            { 'rankedDuels.currentSeasonId': null },
            { 'rankedDuels.seasonEndsAt': null },
        ]
    });
    for (const g of uninitialized) {
        const seasonNumber = g.rankedDuels.seasonNumber ?? 1;
        const days = g.rankedDuels.seasonDurationDays ?? 60;
        g.rankedDuels.currentSeasonId = makeSeasonId(seasonNumber);
        g.rankedDuels.seasonStartedAt = now;
        g.rankedDuels.seasonEndsAt    = new Date(now.getTime() + days * 86_400_000);
        await g.save().catch(err => console.error('[scheduler] ranked season init failed:', err.message));
    }

    const expired = await Guild.find({
        'rankedDuels.enabled': true,
        'rankedDuels.seasonEndsAt': { $ne: null, $lte: now },
    });

    for (const guildDoc of expired) {
        try {
            const guildId  = guildDoc.guildId;
            const seasonId = guildDoc.rankedDuels.currentSeasonId;
            const seasonNumber = guildDoc.rankedDuels.seasonNumber ?? 1;
            const reward   = guildDoc.rankedDuels.topReward ?? 50_000;
            const currency = guildDoc.economy?.currency ?? '💰';

            // Atomically claim this season-end so concurrent sweeps no-op
            const days = guildDoc.rankedDuels.seasonDurationDays ?? 60;
            const newSeasonNumber = seasonNumber + 1;
            const claimed = await Guild.findOneAndUpdate(
                { guildId, 'rankedDuels.currentSeasonId': seasonId },
                {
                    $set: {
                        'rankedDuels.currentSeasonId': makeSeasonId(newSeasonNumber),
                        'rankedDuels.seasonNumber':    newSeasonNumber,
                        'rankedDuels.seasonStartedAt': now,
                        'rankedDuels.seasonEndsAt':    new Date(now.getTime() + days * 86_400_000),
                    }
                },
                { new: false }
            );
            if (!claimed) continue;

            // Only count users active *this* season so that prior-season
            // winners (whose seasonPeakElo lingers until the next soft-reset
            // ticks them) don't reclaim a top-3 slot without playing.
            const top = await User.find({
                guildId,
                $or: [
                    { 'ranked.seasonRankedWins':   { $gt: 0 } },
                    { 'ranked.seasonRankedLosses': { $gt: 0 } },
                ],
                'ranked.currentSeasonId': seasonId,
            })
                .sort({ 'ranked.seasonPeakElo': -1 })
                .limit(3)
                .select('userId ranked')
                .lean();

            const rewards = [reward, Math.floor(reward * 0.6), Math.floor(reward * 0.3)];
            const medals  = ['🥇', '🥈', '🥉'];

            for (let i = 0; i < top.length; i++) {
                const u = top[i];
                const titleLabel = `${seasonId} ${i === 0 ? 'Champion' : i === 1 ? 'Runner-Up' : 'Third Place'}`;
                const peakTier   = tierFor(u.ranked?.seasonPeakElo ?? 1000);
                await User.updateOne(
                    { userId: u.userId, guildId },
                    {
                        $inc: { balance: rewards[i] },
                        $addToSet: { 'ranked.seasonalTitles': titleLabel },
                        $set: {
                            'ranked.peakSeasonTitle': peakTier.label,
                            'ranked.lastSeasonId':   seasonId,
                        },
                    },
                ).catch(err => console.error('[scheduler] ranked reward update failed:', err.message));
            }

            // Soft-reset ELO toward 1200 for every participant
            const participants = await User.find({
                guildId,
                $or: [
                    { 'ranked.rankedWins': { $gt: 0 } },
                    { 'ranked.rankedLosses': { $gt: 0 } },
                ]
            }).select('_id ranked').lean();
            const bulk = participants.map(u => ({
                updateOne: {
                    filter: { _id: u._id },
                    update: {
                        $set: {
                            'ranked.elo':                softResetElo(u.ranked?.elo ?? 1000),
                            'ranked.seasonPeakElo':      softResetElo(u.ranked?.elo ?? 1000),
                            'ranked.seasonRankedWins':   0,
                            'ranked.seasonRankedLosses': 0,
                            'ranked.currentSeasonId':    makeSeasonId(newSeasonNumber),
                        }
                    }
                }
            }));
            if (bulk.length) {
                await User.bulkWrite(bulk, { ordered: false })
                    .catch(err => console.error('[scheduler] ranked soft reset failed:', err.message));
            }

            const channelId = guildDoc.rankedDuels.announceChannelId
                ?? guildDoc.economy?.announcementChannelId
                ?? null;
            if (channelId) {
                const lines = top.length
                    ? top.map((u, i) => `${medals[i]} <@${u.userId}> — ${u.ranked?.seasonPeakElo ?? 1000} ELO · earned **${currency}${rewards[i].toLocaleString()}** + title *"${seasonId} ${i === 0 ? 'Champion' : i === 1 ? 'Runner-Up' : 'Third Place'}"*`).join('\n')
                    : '_No ranked games played this season._';
                const embed = new EmbedBuilder()
                    .setColor(COLORS.RARE)
                    .setTitle(`🏆 Ranked Season Ended — ${seasonId}`)
                    .setDescription(lines)
                    .setFooter({ text: `Season ${newSeasonNumber} starts now — ELO soft-reset toward 1200.` })
                    .setTimestamp();
                await postAnnouncement(client, guildId, channelId, embed);
            }
        } catch (err) {
            console.error(`[scheduler] resolveRankedSeasons failed for guild ${guildDoc.guildId}:`, err);
        }
    }
}

// ─── Bank district interest (issue #370) ─────────────────────────────────────
// Credits 5% of each user's banked coins in guilds where the Bank district is active.
// Intended to run once per week. Only the first INTEREST_BEARING_CAP coins of a
// user's bank earn interest — uncapped 5%/week compounds to ~260% APY and lets
// large balances inflate the economy unboundedly.
const INTEREST_BEARING_CAP = 100_000;

// Users are credited in batches rather than one document at a time. A guild with
// tens of thousands of bankers would otherwise cost that many sequential round
// trips, and holding every op in one array before sending it trades the round
// trips for an equally unbounded amount of memory.
const INTEREST_BATCH_SIZE = 1_000;

/**
 * Pay weekly interest on bank balances, in batches of 1,000 users.
 *
 * Only the first 100,000 coins of a balance earn: uncapped 5%/week compounds to
 * roughly 260% APY, which lets a large balance inflate the economy without
 * bound. Batched rather than one document at a time because a guild with tens
 * of thousands of bankers would otherwise cost that many sequential round
 * trips, and holding every operation in one array trades those round trips for
 * an equally unbounded amount of memory.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
async function applyBankInterest(client) {
    const { EmbedBuilder } = require('discord.js');
    const { isDistrictActive } = require('./districtService');
    const Transaction = require('../models/Transaction');

    const now     = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const guilds  = await Guild.find({
        'districts': { $elemMatch: { districtId: 'bank', activeUntil: { $gt: now } } }
    }).lean();

    for (const guildDoc of guilds) {
        const guildId = guildDoc.guildId;
        try {
            // Atomic weekly claim — skip if already run within the last 7 days
            const claimed = await Guild.findOneAndUpdate(
                {
                    guildId,
                    $or: [
                        { bankInterestLastRunAt: null },
                        { bankInterestLastRunAt: { $lte: weekAgo } },
                    ],
                },
                { $set: { bankInterestLastRunAt: now } },
                { new: false }
            );
            if (!claimed) continue;

            if (!isDistrictActive(guildDoc, 'bank')) continue;

            // Projected and lean: the credit needs three fields, and hydrating full
            // user documents for the whole guild is what makes this job expensive.
            const users = await User.find({ guildId, bank: { $gt: 0 } })
                .select('userId bank balance')
                .lean();

            const note = `5% weekly bank interest (Bank district active, first ${INTEREST_BEARING_CAP.toLocaleString()} coins)`;
            let totalInterestPaid = 0;
            let credits = [];
            let ledger  = [];

            const flush = async () => {
                if (!credits.length) return;
                await User.bulkWrite(credits, { ordered: false });
                // The ledger is written after the credit for the same reason the rest of
                // the economy does it in that order: an entry with no matching credit
                // claims coins nobody was paid.
                await Transaction.insertMany(ledger, { ordered: false })
                    .catch(err => console.error('[scheduler] bank interest ledger write failed:', err.message));
                credits = [];
                ledger  = [];
            };

            for (const user of users) {
                const interest = Math.floor(Math.min(user.bank, INTEREST_BEARING_CAP) * 0.05);
                if (interest <= 0) continue;
                credits.push({ updateOne: { filter: { _id: user._id }, update: { $inc: { bank: interest } } } });
                ledger.push({ userId: user.userId, guildId, type: 'bank_interest', amount: interest, balance: user.balance, note });
                totalInterestPaid += interest;
                if (credits.length >= INTEREST_BATCH_SIZE) await flush();
            }
            await flush();

            if (totalInterestPaid <= 0) continue;

            const channelId = guildDoc.economy?.announcementChannelId ?? null;
            if (!channelId) continue;

            const currency = guildDoc.economy?.currency ?? '💰';
            const embed = new EmbedBuilder()
                .setColor('#f1c40f')
                .setTitle('🏦 Weekly Bank Interest Paid')
                .setDescription(
                    `The **Bank district** is active — all members with banked coins earned **5% weekly interest** (on the first ${INTEREST_BEARING_CAP.toLocaleString()} coins).\n\n` +
                    `Total interest distributed: **${currency}${totalInterestPaid.toLocaleString()}**`
                )
                .setFooter({ text: 'Deposit coins with /bank deposit to earn interest each week.' })
                .setTimestamp();

            await postAnnouncement(client, guildId, channelId, embed);
        } catch (err) {
            console.error(`[scheduler] applyBankInterest failed for guild ${guildId}:`, err.message);
        }
    }
}

/**
 * Return expired market listings to their sellers before the MongoDB TTL index
 * deletes them.
 *
 * TTL-deleted documents do not fire Mongoose hooks, so without this job an item
 * whose listing expired unclaimed would vanish from the economy permanently.
 * The one job here that needs no client: it posts nothing.
 *
 * @returns {Promise<void>}
 */
async function returnExpiredMarketListings() {
    const MarketListing = require('../models/MarketListing');
    const now = new Date();
    let processed = 0;
    let failed = 0;
    let unrecordedReturns = 0;

    // Process in batches of 50 to avoid large memory spikes
    const expired = await MarketListing.find({ expiresAt: { $lte: now } }).limit(50).lean();

    for (const listing of expired) {
        try {
            // Claim the listing by deleting it before crediting anything. The
            // listing document is the only record that this return is owed, so
            // whoever deletes it owns the credit: a second worker, or this job's
            // next tick after a crash, finds nothing and does nothing.
            //
            // Crediting first and deleting after inverts that — a delete that
            // fails leaves the listing to be found and credited again on the next
            // tick, minting items. Losing a return is recoverable from this log;
            // silently doubling one is not.
            const claimed = await MarketListing.findOneAndDelete({ _id: listing._id });
            if (!claimed) continue;

            // Return items to the seller in one atomic update — the match-then-push
            // it replaced could hand two expiring listings of the same item their
            // own slot each, stranding one of them.
            //
            // Keyed by the listing id (#807), so a return whose write committed
            // without its response reaching here is not applied twice by the
            // replay script. The listing is gone, so the id will never be reused.
            const payoutKey = listingPayoutKey(listing._id);
            let status = null;
            let creditErr = null;
            try {
                ({ status } = await grantItemOnce(
                    { userId: listing.sellerId, guildId: listing.guildId },
                    listing.itemId, listing.quantity, payoutKey,
                    { upsert: true },
                ));
            } catch (err) {
                creditErr = err;
            }

            // 'duplicate' means an earlier attempt already returned these items.
            // Counted with the successes: the seller has them, and recording the
            // return as owed would put it straight back on the replay queue.
            if (status === 'paid' || status === 'duplicate') {
                if (status === 'duplicate') {
                    console.warn(
                        `[scheduler] listing ${listing._id} was already returned under ${payoutKey} — not returned again`,
                    );
                }
                processed++;
                continue;
            }

            {
                // The listing is already deleted, so nothing will find this
                // again — which is why the credit is written down as owed
                // rather than left to a retry that will never come (#804).
                //
                // `upsert` is on above, so 'missing' cannot come back from a
                // seller who simply has no document; anything here is a real
                // failure or a concurrent write that beat the guard.
                failed++;
                const reason = creditErr?.message ??
                    `return for ${listing.sellerId} in ${listing.guildId} matched nothing (${status})`;
                const recorded = await recordOwedPayout({
                    service: 'schedulerService',
                    jobName: 'returnExpiredMarketListings',
                    guildId: listing.guildId,
                    payload: {
                        kind:      'items',
                        userId:    listing.sellerId,
                        guildId:   listing.guildId,
                        itemId:    listing.itemId,
                        quantity:  listing.quantity,
                        listingId: String(listing._id),
                        payoutKey,
                    },
                    error: creditErr ?? new Error(reason),
                });
                if (!recorded) unrecordedReturns += 1;

                // After the record write, for the same reason as the weekly
                // credit above.
                console.error(
                    `[scheduler] listing ${listing._id} was claimed but crediting ` +
                    `${listing.quantity}x ${listing.itemId} to ${listing.sellerId} failed — ` +
                    `${recorded ? 'items owed, recorded for replay' : 'items owed and NOT recorded, must be returned by hand'}:`,
                    reason,
                );
                continue;
            }
        } catch (err) {
            // A failure before the claim — the listing is untouched, so the
            // next tick finds it again. Counted all the same: a sweep that
            // returned nothing must not report a healthy run.
            failed++;
            console.error(`[scheduler] returnExpiredMarketListings failed for listing ${listing._id}:`, err.message);
        }
    }

    if (processed > 0) {
        console.log(`[scheduler] returnExpiredMarketListings: returned items from ${processed} expired listing(s).`);
    }

    // Same reasoning as announceWeeklyChampions: the per-listing catches keep one
    // bad listing from stranding the batch, and would otherwise also keep the
    // whole batch failing off /health and out of the dead-letter queue.
    if (failed) {
        throw new Error(
            `${failed} of ${expired.length} expired listing(s) could not be returned` +
            (processed ? ` (${processed} were)` : '') +
            (unrecordedReturns ? ` — ${owedSummary(failed, unrecordedReturns)}` : '')
        );
    }
}

module.exports = { resolveExpiredWars, resolveExpiredSeasons, awardWeeklyLeaderboardBadges, selectPetOfTheWeek, announceWeeklyChampions, recalcShopPrices, resolveRankedSeasons, applyBankInterest, returnExpiredMarketListings, postScheduledNewspapers: require('./newspaperService').postScheduledNewspapers };
