const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const { netWorthOf, topByNetWorth, netWorthRank } = require('../../utils/netWorth');

module.exports = {
    cooldown: 10,
    data: new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('View the top 10 members on the server leaderboard.')
        .addStringOption(option =>
            option.setName('type')
                .setDescription('Which leaderboard to show (default: Levels).')
                .setRequired(false)
                .addChoices(
                    { name: 'Levels',          value: 'levels' },
                    { name: 'Economy',         value: 'economy' },
                    { name: 'Streaks',         value: 'streaks' },
                    { name: 'Streaks (Longest All-Time)', value: 'streaks_longest' },
                    { name: 'Duels (Most Wins)',          value: 'duels'           },
                    { name: 'Achievements',               value: 'achievements'    }
                )),
    async execute(interaction) {
        const type = interaction.options.getString('type') || 'levels';

        try {
            let users;
            let title;
            let descriptionHeader;

            if (type === 'streaks' || type === 'streaks_longest') {
                const sortField = type === 'streaks'
                    ? { 'streak.current': -1 }
                    : { 'streak.longest': -1 };
                users = await User.find({ guildId: interaction.guild.id, ...(type === 'streaks' ? { 'streak.current': { $gt: 0 } } : {}) }).sort(sortField).limit(10);
                title = type === 'streaks'
                    ? '🔥 Daily Streak Leaderboard'
                    : '🏆 All-Time Streak Records';
                descriptionHeader = type === 'streaks'
                    ? 'Top 10 Active Streaks'
                    : 'Top 10 by Longest Streak Ever';
            } else if (type === 'duels') {
                users = await User.find({
                    guildId: interaction.guild.id,
                    $or: [{ duelWins: { $gt: 0 } }, { duelLosses: { $gt: 0 } }],
                }).sort({ duelWins: -1 }).limit(10);
                title = '⚔️ Duel Leaderboard';
                descriptionHeader = 'Top 10 Duelists by Win Count';
            } else if (type === 'achievements') {
                const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
                if (!guildSettings?.achievements?.enabled) {
                    return interaction.reply({ content: 'Achievements are not enabled on this server.', flags: MessageFlags.Ephemeral });
                }
                users = await User.find({ guildId: interaction.guild.id, achievementsCount: { $gt: 0 } })
                    .sort({ achievementsCount: -1 })
                    .limit(10);
                title = '🏅 Achievement Leaderboard';
                descriptionHeader = 'Top 10 by Total Achievements Earned';
            } else if (type === 'economy') {
                // Ranked by the same balance + bank total the rows below display,
                // and by the same total the dashboard and newspaper rank on.
                users = await topByNetWorth(User, interaction.guild.id, 10);
                title = '🏆 Leaderboard';
                descriptionHeader = 'Top 10 by Net Worth';
            } else {
                users = await User.find({ guildId: interaction.guild.id }).sort({ level: -1, xp: -1 }).limit(10);
                title = '🏆 Leaderboard';
                descriptionHeader = 'Top 10 by Level';
            }

            if (users.length === 0) {
                return interaction.reply({ content: 'No users found on the leaderboard!', flags: MessageFlags.Ephemeral });
            }

            const embed = new EmbedBuilder()
                .setColor('#ffd700')
                .setTitle(`${title} — ${interaction.guild.name}`)
                .setTimestamp();

            // Find caller's rank for streak leaderboards
            let callerRankLine = '';
            if (type === 'streaks' || type === 'streaks_longest') {
                const callerUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
                if (callerUser) {
                    const callerVal = type === 'streaks'
                        ? (callerUser.streak?.current ?? 0)
                        : (callerUser.streak?.longest ?? 0);
                    const field = type === 'streaks' ? 'streak.current' : 'streak.longest';
                    const aboveCount = await User.countDocuments({
                        guildId: interaction.guild.id,
                        [field]: { $gt: callerVal }
                    });
                    const callerRank = aboveCount + 1;
                    const topEntry = users[0];
                    const topVal = type === 'streaks'
                        ? (topEntry?.streak?.current ?? 0)
                        : (topEntry?.streak?.longest ?? 0);
                    const div = '━━━━━━━━━━━━━━━━━━━━━━━━━━━';
                    if (callerRank > 10 && topVal > 0) {
                        callerRankLine = `\n${div}\n📍 You: **#${callerRank}** — 🔥 ${callerVal} day${callerVal !== 1 ? 's' : ''}`;
                    } else if (callerRank <= 10) {
                        callerRankLine = `\n${div}\n📍 You: **#${callerRank}** — 🔥 ${callerVal} day${callerVal !== 1 ? 's' : ''}`;
                    }
                }
            }

            // One round trip per row turned rendering a ten-name board into ten
            // serial Discord API calls. Nothing in the loop below depends on the
            // previous row, so the fetches are issued together and awaited once.
            // A user the API cannot resolve still yields null and is skipped, and
            // the medal still comes from the row's rank rather than its position
            // in the printed list.
            const discordUsers = await Promise.all(
                users.map(u => interaction.client.users.fetch(u.userId).catch(() => null))
            );

            let description = descriptionHeader + '\n\n';
            for (let i = 0; i < users.length; i++) {
                const user = users[i];
                const discordUser = discordUsers[i];
                if (!discordUser) continue;

                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;

                if (type === 'levels') {
                    description += `${medal} ${discordUser.tag} — Level ${user.level} (${user.xp} XP)\n`;
                } else if (type === 'economy') {
                    description += `${medal} ${discordUser.tag} — ${user.netWorth.toLocaleString()} coins\n`;
                } else if (type === 'streaks') {
                    const days    = user.streak?.current ?? 0;
                    const freezes = user.streak?.freezes ?? 0;
                    const milestones = [100, 30, 7];
                    const topMilestone = milestones.find(m => days >= m);
                    const badges = [
                        topMilestone === 100 ? '⭐ 100-day milestone achieved' : topMilestone === 30 ? '⭐ 30-day milestone achieved' : topMilestone === 7 ? '⭐ 7-day milestone achieved' : null,
                        freezes > 0 ? `🧊 ${freezes} freeze${freezes !== 1 ? 's' : ''} banked` : null,
                        (user.streak?.revivalToken) ? '💫 Revival Token' : null,
                    ].filter(Boolean).join('  ');
                    description += `${medal} ${discordUser.tag} — 🔥 ${days} day${days !== 1 ? 's' : ''}${badges ? `  ${badges}` : ''}\n`;
                } else if (type === 'streaks_longest') {
                    const days = user.streak?.longest ?? 0;
                    description += `${medal} ${discordUser.tag} — 🔥 ${days} day${days !== 1 ? 's' : ''}\n`;
                } else if (type === 'achievements') {
                    const count = user.achievementsCount ?? 0;
                    description += `${medal} ${discordUser.tag} — 🏅 ${count} achievement${count !== 1 ? 's' : ''}\n`;
                } else {
                    const wins   = user.duelWins   ?? 0;
                    const losses = user.duelLosses ?? 0;
                    description += `${medal} ${discordUser.tag} — ⚔️ ${wins}W / ${losses}L\n`;
                }
            }

            // "You are here" self-rank for types that didn't already compute it above
            if (!callerRankLine && !['streaks', 'streaks_longest'].includes(type)) {
                const callerUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
                if (callerUser) {
                    let callerRank, callerDisplay;
                    const div = '━━━━━━━━━━━━━━━━━━━━━━━━━━━';

                    if (type === 'levels') {
                        callerRank = await User.countDocuments({
                            guildId: interaction.guild.id,
                            $or: [
                                { level: { $gt: callerUser.level } },
                                { level: callerUser.level, xp: { $gt: callerUser.xp } },
                            ],
                        }) + 1;
                        callerDisplay = `Lv${callerUser.level} (${callerUser.xp} XP)`;
                    } else if (type === 'economy') {
                        const callerTotal = netWorthOf(callerUser);
                        callerRank = await netWorthRank(User, interaction.guild.id, callerTotal, callerUser._id);
                        callerDisplay = `${callerTotal.toLocaleString()} coins`;
                    } else if (type === 'duels') {
                        const callerWins = callerUser.duelWins ?? 0;
                        callerRank = await User.countDocuments({
                            guildId: interaction.guild.id,
                            duelWins: { $gt: callerWins },
                        }) + 1;
                        callerDisplay = `${callerWins}W / ${callerUser.duelLosses ?? 0}L`;
                    } else if (type === 'achievements') {
                        const callerAch = callerUser.achievementsCount ?? 0;
                        callerRank = await User.countDocuments({
                            guildId: interaction.guild.id,
                            achievementsCount: { $gt: callerAch },
                        }) + 1;
                        callerDisplay = `${callerAch} achievement${callerAch !== 1 ? 's' : ''}`;
                    }

                    if (callerRank !== undefined) {
                        callerRankLine = `\n${div}\n📍 You: **#${callerRank}** — ${callerDisplay}`;
                    }
                }
            }

            embed.setDescription(description + callerRankLine);
            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Leaderboard error:', error);
            await interaction.reply({ content: 'Failed to fetch leaderboard.', flags: MessageFlags.Ephemeral });
        }
    }
};
