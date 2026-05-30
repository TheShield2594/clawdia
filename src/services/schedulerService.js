const Guild = require('../models/Guild');
const User  = require('../models/User');
const SeasonRecord = require('../models/SeasonRecord');
const { createWarVictoryBanner, createSeasonRecapCard } = require('../utils/cardGenerator');
const { PET_DEFINITIONS, heartBar } = require('./petService');

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

    // Single guild fetch shared by name resolution, recap DMs, and announcement
    let seasonDiscordGuild = null;
    let announceChannelId  = null;
    try {
        seasonDiscordGuild = await client.guilds.fetch(guildId).catch(() => null);
        announceChannelId  = guildDoc.economy?.announcementChannelId
            ?? seasonDiscordGuild?.systemChannelId
            ?? null;
    } catch {}

    let resolvedNames = {};
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
                    const file = new AttachmentBuilder(buf, { name: 'season_recap.png' });

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
        .setColor('#ffd700')
        .setTitle(`🏁 Season Ended: ${season.name ?? season.id}`)
        .setDescription('The season leaderboard has been frozen and season coins have been reset.')
        .addFields({ name: '🏆 Final Top 3', value: winnerLines })
        .setTimestamp();

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

// ── Pet of the Week ───────────────────────────────────────────────────────────

async function selectPetOfTheWeek(client) {
    const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
    const { generatePetSprite } = require('../utils/cardGenerator');

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

            const users = await User.find({ guildId, 'pets.0': { $exists: true } }, 'userId pets').lean();
            if (!users.length) continue;

            // Find pet with most weekly interactions
            let bestUser = null, bestPet = null, bestCount = 0;
            for (const u of users) {
                for (const pet of (u.pets ?? [])) {
                    if ((pet.weeklyInteractions || 0) > bestCount) {
                        bestCount = pet.weeklyInteractions;
                        bestPet   = pet;
                        bestUser  = u;
                    }
                }
            }

            // Reset weekly interaction counts + clear old POTW flags for all pets in guild
            await User.updateMany({ guildId }, { $set: { 'pets.$[].potw': false, 'pets.$[].weeklyInteractions': 0 } });

            if (!bestPet || bestCount === 0) continue;

            // Set POTW on winning pet
            await User.updateOne(
                { guildId, userId: bestUser.userId, 'pets._id': bestPet._id },
                { $set: { 'pets.$.potw': true } }
            );

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
                .setColor('#ffd700')
                .setTitle('🌟 Pet of the Week!')
                .setDescription(
                    `This week's most beloved pet is:\n\n` +
                    `${def?.emoji ?? '🐾'} **${name}** — owned by <@${bestUser.userId}>\n\n` +
                    `_${bestCount} interaction${bestCount !== 1 ? 's' : ''} this week_`
                )
                .addFields({ name: '❤️ Bond', value: `${heartBar(bondDays)} ${bondDays} days`, inline: true })
                .setFooter({ text: 'Earn the ribbon by feeding, playing with, or resting your pet!' })
                .setTimestamp();

            let files = [];
            try {
                const spriteBuf = await generatePetSprite(bestPet.petId, 80);
                embed.setThumbnail('attachment://potw_sprite.png');
                files = [new AttachmentBuilder(spriteBuf, { name: 'potw_sprite.png' })];
            } catch { /* non-critical */ }

            await postAnnouncement(client, guildId, channelId, { embeds: [embed], files });
        } catch (err) {
            console.error(`[scheduler] selectPetOfTheWeek failed for guild ${guildId}:`, err.message);
        }
    }
}

// ── Hourly Micro-Competition Announcements ────────────────────────────────────

const HOURLY_CATEGORY_LABELS = {
    fish: { title: '🎣 Rarest Catch Last Hour',  reward: 500,  emoji: '🐟' },
    mine: { title: '⛏️ Biggest Dig Last Hour',    reward: 500,  emoji: '💎' },
    hunt: { title: '🏹 Largest Haul Last Hour',   reward: 500,  emoji: '🦌' },
};

async function announceHourlyWinners(client) {
    const { EmbedBuilder } = require('discord.js');
    const HourlyWinner = require('../models/HourlyWinner');
    const User         = require('../models/User');
    const { getPreviousHourKey } = require('../utils/hourlyWinner');

    const prevHour   = getPreviousHourKey();
    const candidates = await HourlyWinner.find({ hour: prevHour, rewarded: false }).lean();
    if (!candidates.length) return;

    // Claim each winner atomically to prevent double-pay under concurrent runs
    const actualWinners = [];
    for (const w of candidates) {
        const claimed = await HourlyWinner.findOneAndUpdate(
            { _id: w._id, rewarded: false },
            { $set: { rewarded: true } },
            { new: true }
        );
        if (claimed) actualWinners.push(w);
    }
    if (!actualWinners.length) return;

    // Grant coin rewards first, decoupled from announcement availability
    const rewardAmount = 500;
    for (const winner of actualWinners) {
        await User.findOneAndUpdate(
            { userId: winner.userId, guildId: winner.guildId },
            { $inc: { balance: rewardAmount } }
        ).catch(() => {});
    }

    // Announce per guild (best-effort — reward already granted above)
    const byGuild = new Map();
    for (const w of actualWinners) {
        if (!byGuild.has(w.guildId)) byGuild.set(w.guildId, []);
        byGuild.get(w.guildId).push(w);
    }

    for (const [guildId, guildWinners] of byGuild) {
        try {
            const guildDoc  = await Guild.findOne({ guildId }, 'economy name').lean();
            const channelId = guildDoc?.economy?.announcementChannelId ?? null;
            if (!channelId) continue;

            const lines = [];
            for (const winner of guildWinners) {
                const meta = HOURLY_CATEGORY_LABELS[winner.category];
                if (!meta) continue;
                const detail = winner.details ? ` with **${winner.details}**` : '';
                lines.push(`${meta.emoji} **${meta.title}**\n<@${winner.userId}> (${winner.username})${detail} — rewarded **+${rewardAmount.toLocaleString()} coins**`);
            }

            if (!lines.length) continue;

            const embed = new EmbedBuilder()
                .setColor('#FFD700')
                .setTitle('🏆 Last Hour\'s Champions')
                .setDescription(lines.join('\n\n'))
                .setFooter({ text: 'Hourly micro-competitions reset each hour. Hunt, fish, and mine to compete!' })
                .setTimestamp();

            await postAnnouncement(client, guildId, channelId, embed);
        } catch (err) {
            console.error(`[scheduler] announceHourlyWinners failed for guild ${guildId}:`, err.message);
        }
    }
}

module.exports = { resolveExpiredWars, resolveExpiredSeasons, awardWeeklyLeaderboardBadges, selectPetOfTheWeek, announceHourlyWinners };
