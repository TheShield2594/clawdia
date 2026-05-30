const Guild = require('../models/Guild');
const User = require('../models/User');
const SeasonRecord = require('../models/SeasonRecord');
const { createWarVictoryBanner } = require('../utils/cardGenerator');

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
            const buf = await createWarVictoryBanner(winnerName, winnerScore, oppName, loserScore, mvpName);
            bannerAttachment = new AttachmentBuilder(buf, { name: 'war_victory.png' });
        } catch (err) {
            console.error('[scheduler] war banner generation failed:', err.message);
        }
    }

    // Helper to build guild-specific embed
    function buildWarEmbed(perspective) {
        // perspective: 'winner' | 'loser' | 'tie'
        if (perspective === 'tie') {
            return new EmbedBuilder()
                .setColor('#95a5a6')
                .setTitle('⚔️ War Ended — Tie!')
                .setDescription(
                    `The war between **${guildDoc.name}** and **${oppName}** ended in a tie!\n\n` +
                    `**${myScore.toLocaleString()}** pts — **${oppScore.toLocaleString()}** pts`
                )
                .setTimestamp();
        }
        if (perspective === 'winner') {
            const embed = new EmbedBuilder()
                .setColor('#FFD700')
                .setTitle(`🏆 ${winnerName} WINS THE WAR`)
                .setDescription(
                    `**${winnerName}** has crushed **${oppName}**!\n\n` +
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
            .setColor('#e74c3c')
            .setTitle('⚔️ War Lost')
            .setDescription(
                `**${oppName}** has defeated **${guildDoc.name}**.\n\n` +
                `**Score:** ${myScore.toLocaleString()} — ${oppScore.toLocaleString()}\n\n` +
                `Train harder and challenge them again!`
            )
            .setTimestamp();
    }

    if (tied) {
        const embed = buildWarEmbed('tie');
        await postAnnouncement(client, guildId, war.announcementChannelId, embed);
        if (opponentGuildId) {
            const oppDoc = await Guild.findOne({ guildId: opponentGuildId }).lean();
            await postAnnouncement(client, opponentGuildId, oppDoc?.activeWar?.announcementChannelId ?? null, embed);
        }
    } else if (iWon) {
        // Winner = this guild, loser = opponent
        const winEmbed = buildWarEmbed('winner');
        const loseEmbed = buildWarEmbed('loser');
        const winPayload = bannerAttachment
            ? { embeds: [winEmbed], files: [bannerAttachment] }
            : { embeds: [winEmbed] };
        await postAnnouncement(client, guildId, war.announcementChannelId, winPayload);
        if (opponentGuildId) {
            const oppDoc = await Guild.findOne({ guildId: opponentGuildId }).lean();
            await postAnnouncement(client, opponentGuildId, oppDoc?.activeWar?.announcementChannelId ?? null, loseEmbed);
        }
    } else {
        // Loser = this guild, winner = opponent
        const loseEmbed = buildWarEmbed('loser');
        await postAnnouncement(client, guildId, war.announcementChannelId, loseEmbed);
        if (opponentGuildId) {
            const oppDoc = await Guild.findOne({ guildId: opponentGuildId }).lean();
            const winEmbed = buildWarEmbed('winner');
            const winPayload = bannerAttachment
                ? { embeds: [winEmbed], files: [bannerAttachment] }
                : { embeds: [winEmbed] };
            await postAnnouncement(client, opponentGuildId, oppDoc?.activeWar?.announcementChannelId ?? null, winPayload);
        }
    }

    return true;
}

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

    let resolvedNames = {};
    try {
        const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
        if (discordGuild) {
            for (const u of topUsers.slice(0, 3)) {
                const member = await discordGuild.members.fetch(u.userId).catch(() => null);
                resolvedNames[u.userId] = member?.user?.username ?? 'Unknown';
            }
        }
    } catch {}

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

    // Reset seasonCoins for everyone in the guild
    await User.updateMany({ guildId }, { $set: { seasonCoins: 0 } })
        .catch(err => console.error('[scheduler] seasonCoins reset failed:', err.message));

    const { EmbedBuilder } = require('discord.js');
    const currency = guildDoc.economy?.currency ?? '💰';
    const medals = ['🥇', '🥈', '🥉'];
    const winnerLines = topUsers.slice(0, 3).map((u, i) =>
        `${medals[i]} <@${u.userId}> — ${(u.seasonCoins ?? 0).toLocaleString()} ${currency}`
    ).join('\n') || '*No participants*';

    const embed = new EmbedBuilder()
        .setColor('#ffd700')
        .setTitle(`🏁 Season Ended: ${season.name ?? season.id}`)
        .setDescription('The season leaderboard has been frozen and season coins have been reset.')
        .addFields({ name: '🏆 Final Top 3', value: winnerLines })
        .setTimestamp();

    // Announcement channel: reuse the war channel only if set on the season; otherwise
    // fall back to the system channel of the guild.
    let announceChannelId = null;
    try {
        const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
        announceChannelId = discordGuild?.systemChannelId ?? null;
    } catch {}

    await postAnnouncement(client, guildId, announceChannelId, embed);
    return true;
}

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

// Awards 7-day 👑 #1 badges to the top user in each leaderboard category across all guilds.
// Run once per week (Sunday 23:59 UTC recommended).
async function awardWeeklyLeaderboardBadges(client) {
    const { EmbedBuilder } = require('discord.js');

    const guilds = await Guild.find({}, 'guildId name economy').lean();

    for (const guildDoc of guilds) {
        const guildId = guildDoc.guildId;
        try {
            const categories = [
                { key: 'levels',       sort: { level: -1, xp: -1 },            label: '📈 Top Level' },
                { key: 'economy',      sort: { balance: -1 },                   label: '💰 Wealthiest' },
                { key: 'streaks',      sort: { 'streak.current': -1 },          label: '🔥 Longest Streak' },
                { key: 'duels',        sort: { duelWins: -1 },                  label: '⚔️ Duel Champion' },
                { key: 'achievements', sort: { achievementsCount: -1 },         label: '🏅 Achievement Hunter' },
            ];

            const badgeExpiry = new Date(Date.now() + LEADERBOARD_BADGE_DURATION_MS);
            const champLines = [];
            const discordGuild = await client.guilds.fetch(guildId).catch(() => null);

            for (const cat of categories) {
                const top = await User.findOne({ guildId }).sort(cat.sort).select('userId').lean();
                if (!top) continue;

                // Award badge (deduplicate: remove existing #1 badge for this category first)
                await User.updateOne(
                    { userId: top.userId, guildId },
                    {
                        $pull:  { badges: { id: `leaderboard_1_${cat.key}` } },
                    }
                ).catch(() => {});
                await User.updateOne(
                    { userId: top.userId, guildId },
                    {
                        $push: { badges: { id: `leaderboard_1_${cat.key}`, label: '👑 #1', expiresAt: badgeExpiry } }
                    }
                ).catch(() => {});

                let username = `<@${top.userId}>`;
                if (discordGuild) {
                    const member = await discordGuild.members.fetch(top.userId).catch(() => null);
                    if (member) username = `<@${top.userId}> (${member.user.username})`;
                }
                champLines.push(`${cat.label}: ${username}`);
            }

            if (!champLines.length) continue;

            // Find announcement channel: economy.announcementChannelId or systemChannel
            let announceChannelId = guildDoc.economy?.announcementChannelId ?? null;
            if (!announceChannelId && discordGuild) {
                announceChannelId = discordGuild.systemChannelId ?? null;
            }
            if (!announceChannelId) continue;

            const embed = new EmbedBuilder()
                .setColor('#ffd700')
                .setTitle('👑 Last Week\'s Champions')
                .setDescription(
                    'These legends dominated the leaderboards this week.\n' +
                    'Each earns a **👑 #1** badge for 7 days, visible on `/rank` and `/leaderboard`.'
                )
                .addFields({ name: '🏆 Winners', value: champLines.join('\n') })
                .setTimestamp();

            await postAnnouncement(client, guildId, announceChannelId, embed);
        } catch (err) {
            console.error(`[scheduler] weeklyLeaderboardBadges failed for guild ${guildId}:`, err.message);
        }
    }
}

module.exports = { resolveExpiredWars, resolveExpiredSeasons, awardWeeklyLeaderboardBadges };
