const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const SeasonRecord = require('../../models/SeasonRecord');
const { generateDailyMissions } = require('../../data/seasonMissions');

// ── Battle pass tier reward definitions ──────────────────────────────────────
// 20 tiers; alternating between coin bonuses, cosmetic badges, material bundles, rare items
const TIER_REWARDS = [
    { tier: 1,  coins: 500,   label: '💰 500 coins' },
    { tier: 2,  coins: 0,     label: '🎖️ Apprentice Badge' },
    { tier: 3,  coins: 1000,  label: '💰 1,000 coins' },
    { tier: 4,  coins: 0,     label: '🗡️ Hunter\'s Crest Badge' },
    { tier: 5,  coins: 2000,  label: '💰 2,000 coins' },
    { tier: 6,  coins: 0,     label: '⚗️ Material Bundle (×5 random)' },
    { tier: 7,  coins: 3000,  label: '💰 3,000 coins' },
    { tier: 8,  coins: 0,     label: '🎭 Prestige Frame Badge' },
    { tier: 9,  coins: 4000,  label: '💰 4,000 coins' },
    { tier: 10, coins: 0,     label: '🛡️ Lifesaver (rare item)' },
    { tier: 11, coins: 5000,  label: '💰 5,000 coins' },
    { tier: 12, coins: 0,     label: '🌟 Elite Badge' },
    { tier: 13, coins: 6000,  label: '💰 6,000 coins' },
    { tier: 14, coins: 0,     label: '⚗️ Premium Material Bundle (×10)' },
    { tier: 15, coins: 8000,  label: '💰 8,000 coins' },
    { tier: 16, coins: 0,     label: '💫 Radiant Badge' },
    { tier: 17, coins: 10000, label: '💰 10,000 coins' },
    { tier: 18, coins: 0,     label: '🔥 Legend Badge' },
    { tier: 19, coins: 15000, label: '💰 15,000 coins' },
    { tier: 20, coins: 0,     label: '❄️ Streak Shield (rare item)' }
];

const XP_PER_TIER = 100;
const MAX_TIERS = 20;

function getTierFromXp(xp) {
    return Math.min(MAX_TIERS, Math.floor(xp / XP_PER_TIER));
}

function xpProgressBar(xp) {
    const currentTier = getTierFromXp(xp);
    if (currentTier >= MAX_TIERS) return 'MAX TIER ✅';
    const xpInTier = xp % XP_PER_TIER;
    const pct = xpInTier / XP_PER_TIER;
    const filled = Math.round(pct * 10);
    return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${xpInTier}/${XP_PER_TIER} XP (Tier ${currentTier} → ${currentTier + 1})`;
}

async function ensureMissions(user) {
    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    if (!user.seasonMissionsDate || new Date(user.seasonMissionsDate).getTime() < todayUtc.getTime()) {
        user.seasonMissions = generateDailyMissions();
        user.seasonMissionsDate = todayUtc;
        user.markModified('seasonMissions');
        user.markModified('seasonMissionsDate');
    }
}

// ── Subcommand handlers ───────────────────────────────────────────────────────

async function executeView(interaction) {
    const [user, guildSettings] = await Promise.all([
        User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        ),
        Guild.findOne({ guildId: interaction.guild.id })
    ]);

    const season = guildSettings?.season;
    if (!season?.enabled || !season?.seasonId) {
        return interaction.reply({ content: 'No active season pass is running on this server right now.', ephemeral: true });
    }

    await ensureMissions(user);

    const userXp = user.season?.xp ?? 0;
    const currentTier = getTierFromXp(userXp);
    const claimedTiers = new Set(user.season?.claimedTiers ?? []);
    const currency = guildSettings?.economy?.currency ?? '💰';

    const nextRewards = TIER_REWARDS
        .filter(r => r.tier > currentTier)
        .slice(0, 5)
        .map(r => `Tier ${r.tier}: ${r.label}`)
        .join('\n') || 'All tiers unlocked! 🎉';

    const endsIn = season.endDate
        ? `<t:${Math.floor(new Date(season.endDate).getTime() / 1000)}:R>`
        : '*No end date set*';

    const embed = new EmbedBuilder()
        .setColor('#5865f2')
        .setTitle(`🎫 ${season.name ?? 'Season Pass'}`)
        .addFields(
            { name: '📊 Your Progress', value: xpProgressBar(userXp) },
            { name: '🏆 Current Tier', value: `**Tier ${currentTier} / ${MAX_TIERS}**`, inline: true },
            { name: '⏰ Season Ends', value: endsIn, inline: true },
            { name: '🎁 Upcoming Rewards', value: nextRewards },
            {
                name: '📋 Today\'s Missions',
                value: (user.seasonMissions ?? []).map(m =>
                    `${m.completed ? '✅' : '🔲'} ${m.description} (${m.progress}/${m.target}) → +${m.seasonXp} XP, ${m.coinReward} ${currency}`
                ).join('\n') || '*No missions generated*'
            }
        )
        .setFooter({ text: `Season XP: ${userXp} total | Use /season claim to collect tier rewards` })
        .setTimestamp();

    await user.save().catch(() => {});
    return interaction.reply({ embeds: [embed] });
}

async function executeClaim(interaction) {
    const tier = interaction.options.getInteger('tier');
    const [user, guildSettings] = await Promise.all([
        User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        ),
        Guild.findOne({ guildId: interaction.guild.id })
    ]);

    const season = guildSettings?.season;
    if (!season?.enabled || !season?.seasonId) {
        return interaction.reply({ content: 'No active season pass is running.', ephemeral: true });
    }

    const currency = guildSettings?.economy?.currency ?? '💰';
    const userXp = user.season?.xp ?? 0;
    const unlockedTier = getTierFromXp(userXp);
    const claimedTiers = new Set(user.season?.claimedTiers ?? []);

    if (tier > MAX_TIERS || tier < 1) {
        return interaction.reply({ content: `Tier must be between 1 and ${MAX_TIERS}.`, ephemeral: true });
    }
    if (tier > unlockedTier) {
        return interaction.reply({
            content: `You haven't unlocked Tier ${tier} yet! You're at Tier ${unlockedTier}.`,
            ephemeral: true
        });
    }
    if (claimedTiers.has(tier)) {
        return interaction.reply({ content: `You've already claimed Tier ${tier}'s reward!`, ephemeral: true });
    }

    const reward = TIER_REWARDS.find(r => r.tier === tier);
    if (!reward) return interaction.reply({ content: 'Invalid tier.', ephemeral: true });

    user.season.claimedTiers.push(tier);
    if (reward.coins > 0) user.balance += reward.coins;
    user.markModified('season');

    try {
        await user.save();
    } catch (err) {
        if (err.name === 'VersionError') return interaction.reply({ content: 'Edit conflict — try again.', ephemeral: true });
        throw err;
    }

    const embed = new EmbedBuilder()
        .setColor('#ffd700')
        .setTitle(`🎁 Tier ${tier} Reward Claimed!`)
        .setDescription(`You received: **${reward.label}**${reward.coins > 0 ? `\n+${reward.coins.toLocaleString()} ${currency} added to your wallet` : ''}`)
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeMissions(interaction) {
    const [user, guildSettings] = await Promise.all([
        User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        ),
        Guild.findOne({ guildId: interaction.guild.id })
    ]);

    const season = guildSettings?.season;
    if (!season?.enabled) {
        return interaction.reply({ content: 'No active season on this server.', ephemeral: true });
    }

    await ensureMissions(user);
    const currency = guildSettings?.economy?.currency ?? '💰';

    const missionLines = (user.seasonMissions ?? []).map((m, i) => {
        const status = m.claimed ? '✅ Claimed' : m.completed ? '🎯 Complete — use /season claim-mission' : `🔲 ${m.progress}/${m.target}`;
        return `**Mission ${i + 1}:** ${m.description}\n${status} → +${m.seasonXp} Season XP, ${m.coinReward.toLocaleString()} ${currency}`;
    });

    const resetAt = new Date();
    resetAt.setUTCHours(24, 0, 0, 0);

    const embed = new EmbedBuilder()
        .setColor('#5865f2')
        .setTitle('📋 Daily Missions')
        .setDescription(missionLines.join('\n\n') || '*No missions generated*')
        .setFooter({ text: `Resets at midnight UTC` })
        .addFields({ name: '⏰ Next Reset', value: `<t:${Math.floor(resetAt.getTime() / 1000)}:R>`, inline: true })
        .setTimestamp();

    await user.save().catch(() => {});
    return interaction.reply({ embeds: [embed] });
}

async function executeClaimMission(interaction) {
    const missionIndex = interaction.options.getInteger('mission') - 1;
    const [user, guildSettings] = await Promise.all([
        User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        ),
        Guild.findOne({ guildId: interaction.guild.id })
    ]);

    const season = guildSettings?.season;
    if (!season?.enabled) return interaction.reply({ content: 'No active season.', ephemeral: true });

    await ensureMissions(user);
    const currency = guildSettings?.economy?.currency ?? '💰';
    const mission = user.seasonMissions?.[missionIndex];

    if (!mission) return interaction.reply({ content: 'Invalid mission number.', ephemeral: true });
    if (!mission.completed) return interaction.reply({ content: 'Mission not completed yet.', ephemeral: true });
    if (mission.claimed) return interaction.reply({ content: 'Already claimed!', ephemeral: true });

    user.seasonMissions[missionIndex].claimed = true;
    if (!user.season) user.season = {};
    user.season.xp = (user.season.xp ?? 0) + mission.seasonXp;
    user.season.tier = getTierFromXp(user.season.xp);
    user.balance += mission.coinReward;
    user.markModified('seasonMissions');
    user.markModified('season');

    try {
        await user.save();
    } catch (err) {
        if (err.name === 'VersionError') return interaction.reply({ content: 'Edit conflict — try again.', ephemeral: true });
        throw err;
    }

    return interaction.reply({
        content: `✅ Mission claimed! +**${mission.seasonXp} Season XP** and +**${mission.coinReward.toLocaleString()} ${currency}**`,
        ephemeral: true
    });
}

// ── Economy season (issue #238) subcommands ───────────────────────────────────

async function executeLeaderboard(interaction) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    const currentSeason = guildSettings?.currentSeason;

    if (!currentSeason?.id) {
        return interaction.reply({ content: 'No active economy season on this server.', ephemeral: true });
    }

    const topUsers = await User.find({ guildId: interaction.guild.id })
        .sort({ seasonCoins: -1 })
        .limit(10)
        .select('userId seasonCoins');

    if (topUsers.length === 0) {
        return interaction.reply({ content: 'No season data yet.', ephemeral: true });
    }

    const currency = guildSettings?.economy?.currency ?? '💰';
    const medals = ['🥇', '🥈', '🥉'];
    const lines = topUsers.map((u, i) =>
        `${medals[i] ?? `${i + 1}.`} <@${u.userId}> — **${(u.seasonCoins ?? 0).toLocaleString()}** ${currency}`
    );

    const endsAt = currentSeason.endsAt
        ? `<t:${Math.floor(new Date(currentSeason.endsAt).getTime() / 1000)}:R>`
        : '*No end date*';

    const embed = new EmbedBuilder()
        .setColor('#ffd700')
        .setTitle(`📊 Season Leaderboard — ${currentSeason.name ?? currentSeason.id}`)
        .setDescription(lines.join('\n'))
        .addFields({ name: '⏰ Season Ends', value: endsAt, inline: true })
        .setFooter({ text: 'Only season coins earned this season count — wallet is never reset!' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeSeasonMe(interaction) {
    const [user, guildSettings] = await Promise.all([
        User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }),
        Guild.findOne({ guildId: interaction.guild.id })
    ]);

    const currentSeason = guildSettings?.currentSeason;
    if (!currentSeason?.id) {
        return interaction.reply({ content: 'No active economy season on this server.', ephemeral: true });
    }

    if (!user) {
        return interaction.reply({ content: 'No profile found. Use an economy command first.', ephemeral: true });
    }

    const currency = guildSettings?.economy?.currency ?? '💰';
    const rank = await User.countDocuments({
        guildId: interaction.guild.id,
        seasonCoins: { $gt: user.seasonCoins ?? 0 }
    }) + 1;

    const embed = new EmbedBuilder()
        .setColor('#5865f2')
        .setTitle(`📊 Your Season Stats — ${currentSeason.name ?? currentSeason.id}`)
        .addFields(
            { name: 'Season Rank', value: `#${rank}`, inline: true },
            { name: 'Season Coins', value: `${(user.seasonCoins ?? 0).toLocaleString()} ${currency}`, inline: true }
        )
        .setFooter({ text: 'Season coins track earnings only — your wallet balance is unaffected' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeHistory(interaction) {
    const records = await SeasonRecord.find({ guildId: interaction.guild.id })
        .sort({ endedAt: -1 })
        .limit(5);

    if (records.length === 0) {
        return interaction.reply({ content: 'No past seasons recorded for this server.', ephemeral: true });
    }

    const fields = records.map(r => ({
        name: `${r.seasonName ?? r.seasonId} (ended <t:${Math.floor(new Date(r.endedAt).getTime() / 1000)}:D>)`,
        value: r.top10.slice(0, 3).map((u, i) => {
            const medals = ['🥇', '🥈', '🥉'];
            return `${medals[i]} <@${u.userId}> — ${u.coins.toLocaleString()} coins`;
        }).join('\n') || 'No data',
        inline: false
    }));

    const embed = new EmbedBuilder()
        .setColor('#9e9e9e')
        .setTitle('📜 Season History')
        .addFields(fields)
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// Admin: start economy season
async function executeAdminStart(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Administrator only.', ephemeral: true });
    }

    const name = interaction.options.getString('name') ?? `Season ${Date.now()}`;
    const durationDays = interaction.options.getInteger('duration') ?? 90;
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

    if (guildSettings?.currentSeason?.id) {
        return interaction.reply({ content: 'A season is already active. End it first with `/season end`.', ephemeral: true });
    }

    const seasonId = `season_${Date.now()}`;
    const now = new Date();
    const endsAt = new Date(now.getTime() + durationDays * 86400000);

    await Guild.findOneAndUpdate(
        { guildId: interaction.guild.id },
        { $set: { currentSeason: { id: seasonId, name, startedAt: now, endsAt } } }
    );

    return interaction.reply({
        content: `✅ Economy season **${name}** started! Ends <t:${Math.floor(endsAt.getTime() / 1000)}:R>.`,
        ephemeral: false
    });
}

// Admin: end economy season
async function executeAdminEnd(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Administrator only.', ephemeral: true });
    }

    await interaction.deferReply();

    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    const currentSeason = guildSettings?.currentSeason;

    if (!currentSeason?.id) {
        return interaction.editReply('No active economy season to end.');
    }

    const topUsers = await User.find({ guildId: interaction.guild.id })
        .sort({ seasonCoins: -1 })
        .limit(10)
        .select('userId seasonCoins');

    let resolvedNames = {};
    try {
        for (const u of topUsers.slice(0, 3)) {
            const member = await interaction.guild.members.fetch(u.userId).catch(() => null);
            resolvedNames[u.userId] = member?.user?.username ?? 'Unknown';
        }
    } catch {}

    await SeasonRecord.create({
        guildId: interaction.guild.id,
        seasonId: currentSeason.id,
        seasonName: currentSeason.name,
        startedAt: currentSeason.startedAt,
        endedAt: new Date(),
        top10: topUsers.map(u => ({
            userId: u.userId,
            username: resolvedNames[u.userId] ?? 'Unknown',
            coins: u.seasonCoins ?? 0
        }))
    });

    // Reset all seasonCoins for this guild
    await User.updateMany({ guildId: interaction.guild.id }, { $set: { seasonCoins: 0 } });

    // Clear currentSeason from guild
    await Guild.findOneAndUpdate(
        { guildId: interaction.guild.id },
        { $set: { currentSeason: { id: null, name: null, startedAt: null, endsAt: null } } }
    );

    const medals = ['🥇', '🥈', '🥉'];
    const winners = topUsers.slice(0, 3);
    const winnerLines = winners.map((u, i) =>
        `${medals[i]} <@${u.userId}> — ${(u.seasonCoins ?? 0).toLocaleString()} coins`
    ).join('\n') || '*No participants*';

    const embed = new EmbedBuilder()
        .setColor('#ffd700')
        .setTitle(`🏁 Season Ended: ${currentSeason.name ?? currentSeason.id}`)
        .setDescription('The season leaderboard has been frozen and season coins have been reset.')
        .addFields({ name: '🏆 Final Top 3', value: winnerLines })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

// ── Module export ─────────────────────────────────────────────────────────────

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('season')
        .setDescription('Season pass and economy season commands.')
        .addSubcommand(sub =>
            sub.setName('view')
                .setDescription('View your season pass progress and tier rewards.')
        )
        .addSubcommand(sub =>
            sub.setName('claim')
                .setDescription('Claim a tier reward from the season pass.')
                .addIntegerOption(opt =>
                    opt.setName('tier')
                        .setDescription('Tier number to claim (1–20)')
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(20)
                )
        )
        .addSubcommand(sub =>
            sub.setName('missions')
                .setDescription("View today's daily missions.")
        )
        .addSubcommand(sub =>
            sub.setName('claim-mission')
                .setDescription('Claim a completed daily mission reward.')
                .addIntegerOption(opt =>
                    opt.setName('mission')
                        .setDescription('Mission number (1, 2, or 3)')
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(3)
                )
        )
        .addSubcommand(sub =>
            sub.setName('leaderboard')
                .setDescription('View the current economy season leaderboard (top 10).')
        )
        .addSubcommand(sub =>
            sub.setName('me')
                .setDescription('View your economy season rank and coins earned.')
        )
        .addSubcommand(sub =>
            sub.setName('history')
                .setDescription('View past economy season winners.')
        )
        .addSubcommand(sub =>
            sub.setName('start')
                .setDescription('[Admin] Start a new 90-day economy season.')
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('Season name (e.g. "Season 1")')
                        .setRequired(false)
                )
                .addIntegerOption(opt =>
                    opt.setName('duration')
                        .setDescription('Duration in days (default 90)')
                        .setRequired(false)
                        .setMinValue(7)
                        .setMaxValue(365)
                )
        )
        .addSubcommand(sub =>
            sub.setName('end')
                .setDescription('[Admin] End the current economy season and freeze the leaderboard.')
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        try {
            if (sub === 'view')          return await executeView(interaction);
            if (sub === 'claim')         return await executeClaim(interaction);
            if (sub === 'missions')      return await executeMissions(interaction);
            if (sub === 'claim-mission') return await executeClaimMission(interaction);
            if (sub === 'leaderboard')   return await executeLeaderboard(interaction);
            if (sub === 'me')            return await executeSeasonMe(interaction);
            if (sub === 'history')       return await executeHistory(interaction);
            if (sub === 'start')         return await executeAdminStart(interaction);
            if (sub === 'end')           return await executeAdminEnd(interaction);
        } catch (err) {
            console.error('[season] error:', err);
            const msg = { content: 'Something went wrong with the season command.', ephemeral: true };
            if (interaction.replied || interaction.deferred) return interaction.followUp(msg);
            return interaction.reply(msg);
        }
    }
};
