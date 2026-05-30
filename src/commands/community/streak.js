const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const { getStreakMultiplier, getNextMultiplierTier, getNextMilestone } = require('../../utils/streakMultiplier');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('streak')
        .setDescription('View the server streak leaderboard or a user\'s streak')
        .addUserOption(o =>
            o.setName('user').setDescription('User to check (default: leaderboard view)').setRequired(false)),

    async execute(interaction) {
        const target = interaction.options.getUser('user');

        // ── Personal streak view ──────────────────────────────────────────────
        if (target) {
            const user = await User.findOne({ userId: target.id, guildId: interaction.guild.id });

            if (!user) {
                return interaction.reply({
                    content: `${target.id === interaction.user.id ? 'You have' : `${target.username} has`} no activity recorded yet.`,
                    ephemeral: true
                });
            }

            const current = user.streak?.current ?? 0;
            const longest = user.streak?.longest ?? 0;
            const lastActive = user.streak?.lastActive;

            const now = new Date();
            const isActive = lastActive && (now - lastActive) < 172800000;

            const flameEmoji = current >= 30 ? '🔥🔥🔥' : current >= 14 ? '🔥🔥' : current >= 7 ? '🔥' : '❄️';
            const status = isActive ? '✅ Active' : '⚠️ At risk — send a message to keep it!';

            const multiplier = getStreakMultiplier(current);
            const nextTier = getNextMultiplierTier(current);
            const nextMilestone = getNextMilestone(current);
            const multiplierText = multiplier > 1.0
                ? `🔥 **${multiplier}x** coins and XP`
                : '1.0x (reach 7 days for a bonus!)';
            const nextTierText = nextTier
                ? `Keep going! **${nextTier.days - current}** more day${nextTier.days - current !== 1 ? 's' : ''} for **${nextTier.multiplier}x**`
                : '🏆 Maximum multiplier reached!';
            const nextMilestoneText = nextMilestone
                ? `**${nextMilestone.days}** days — ${nextMilestone.coins.toLocaleString()} coins + **${nextMilestone.badge}** badge`
                : '✅ All milestones claimed!';

            const embed = new EmbedBuilder()
                .setColor(current >= 7 ? '#ff6600' : '#5865F2')
                .setTitle(`${flameEmoji} ${target.displayName}'s Streak`)
                .setThumbnail(target.displayAvatarURL({ dynamic: true }))
                .addFields(
                    { name: 'Current Streak', value: `**${current}** day${current !== 1 ? 's' : ''}`, inline: true },
                    { name: 'Longest Streak', value: `**${longest}** day${longest !== 1 ? 's' : ''}`, inline: true },
                    { name: 'Status', value: status, inline: true },
                    { name: '⚡ Multiplier', value: multiplierText, inline: true },
                    { name: '📈 Next Multiplier', value: nextTierText, inline: false },
                    { name: '🎁 Next Reward Milestone', value: nextMilestoneText, inline: false }
                )
                .setFooter({ text: 'Send at least one message per day to keep your streak' })
                .setTimestamp();

            if (lastActive) {
                embed.addFields({ name: 'Last Active', value: `<t:${Math.floor(lastActive / 1000)}:R>`, inline: true });
            }

            return interaction.reply({ embeds: [embed], ephemeral: target.id !== interaction.user.id });
        }

        // ── Server leaderboard view ───────────────────────────────────────────
        const [topUsers, selfUser] = await Promise.all([
            User.find(
                { guildId: interaction.guild.id, 'streak.current': { $gt: 0 } },
                { userId: 1, 'streak.current': 1 }
            ).sort({ 'streak.current': -1 }).limit(5).lean(),
            User.findOne(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { userId: 1, 'streak.current': 1 }
            ).lean()
        ]);

        const medals = ['🥇', '🥈', '🥉'];
        const div = '━━━━━━━━━━━━━━━━━━━━━━━━━━';

        // Resolve display names for top 5
        const nameCache = new Map();
        await Promise.allSettled(
            topUsers.map(async u => {
                try {
                    const member = await interaction.guild.members.fetch(u.userId);
                    nameCache.set(u.userId, member.displayName);
                } catch {
                    nameCache.set(u.userId, `<@${u.userId}>`);
                }
            })
        );

        const leaderboardLines = topUsers.map((u, i) => {
            const prefix = medals[i] ?? `${i + 1}.`;
            const name = nameCache.get(u.userId) ?? `<@${u.userId}>`;
            const days = u.streak.current;
            return `${prefix}  ${name}  ━━  **${days}** day${days !== 1 ? 's' : ''}`;
        });

        if (leaderboardLines.length === 0) {
            leaderboardLines.push('No active streaks on this server yet.');
        }

        // Self rank
        const selfCurrent = selfUser?.streak?.current ?? 0;
        let selfRankText = 'You have no active streak.';
        if (selfCurrent > 0) {
            const aheadCount = await User.countDocuments({
                guildId: interaction.guild.id,
                'streak.current': { $gt: selfCurrent }
            });
            const selfRank = aheadCount + 1;
            const rankMedals = { 1: '🥇', 2: '🥈', 3: '🥉' };
            const rankBadge = rankMedals[selfRank] ? `${rankMedals[selfRank]} ` : '';
            selfRankText = `Your streak: 🔥 **${selfCurrent}** day${selfCurrent !== 1 ? 's' : ''}  ·  ${rankBadge}Rank #${selfRank}`;
        }

        const description = leaderboardLines.join('\n') +
            `\n\n${div}\n  ${selfRankText}\n${div}`;

        const embed = new EmbedBuilder()
            .setColor('#ff6b00')
            .setTitle(`🔥 Streak Leaderboard — ${interaction.guild.name}`)
            .setDescription(description)
            .setFooter({ text: 'Claim /daily every day to build your streak' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};
