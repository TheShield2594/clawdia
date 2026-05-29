const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');

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
                    { name: 'Duels (Most Wins)',          value: 'duels'           }
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
                users = await User.find({ guildId: interaction.guild.id }).sort(sortField).limit(10);
                title = type === 'streaks'
                    ? '🔥 Streak Leaderboard'
                    : '🏆 All-Time Streak Records';
                descriptionHeader = type === 'streaks'
                    ? 'Top 10 by Current Active Streak'
                    : 'Top 10 by Longest Streak Ever';
            } else if (type === 'duels') {
                users = await User.find({ guildId: interaction.guild.id }).sort({ duelWins: -1 }).limit(10);
                title = '⚔️ Duel Leaderboard';
                descriptionHeader = 'Top 10 Duelists by Win Count';
            } else {
                const sortField = type === 'levels' ? { level: -1, xp: -1 } : { balance: -1, bank: -1 };
                users = await User.find({ guildId: interaction.guild.id }).sort(sortField).limit(10);
                title = '🏆 Leaderboard';
                descriptionHeader = type === 'levels' ? 'Top 10 by Level' : 'Top 10 by Balance';
            }

            if (users.length === 0) {
                return interaction.reply({ content: 'No users found on the leaderboard!', ephemeral: true });
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
                    if (callerRank > 10 && topVal > 0) {
                        callerRankLine = `\n\nYour rank: **#${callerRank}** — ${callerVal} day${callerVal !== 1 ? 's' : ''} 🔥`;
                    }
                }
            }

            let description = descriptionHeader + '\n\n';
            for (let i = 0; i < users.length; i++) {
                const user = users[i];
                const discordUser = await interaction.client.users.fetch(user.userId).catch(() => null);
                if (!discordUser) continue;

                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;

                if (type === 'levels') {
                    description += `${medal} ${discordUser.tag} — Level ${user.level} (${user.xp} XP)\n`;
                } else if (type === 'economy') {
                    const total = user.balance + user.bank;
                    description += `${medal} ${discordUser.tag} — ${total.toLocaleString()} coins\n`;
                } else if (type === 'streaks') {
                    const days = user.streak?.current ?? 0;
                    description += `${medal} ${discordUser.tag} — 🔥 ${days} day${days !== 1 ? 's' : ''}\n`;
                } else if (type === 'streaks_longest') {
                    const days = user.streak?.longest ?? 0;
                    description += `${medal} ${discordUser.tag} — 🔥 ${days} day${days !== 1 ? 's' : ''}\n`;
                } else {
                    const wins   = user.duelWins   ?? 0;
                    const losses = user.duelLosses ?? 0;
                    description += `${medal} ${discordUser.tag} — ⚔️ ${wins}W / ${losses}L\n`;
                }
            }

            embed.setDescription(description + callerRankLine);
            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Leaderboard error:', error);
            await interaction.reply({ content: 'Failed to fetch leaderboard.', ephemeral: true });
        }
    }
};
