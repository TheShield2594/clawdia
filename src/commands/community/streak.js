const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const { getStreakMultiplier, getNextMultiplierTier, getNextMilestone } = require('../../utils/streakMultiplier');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('streak')
        .setDescription('View your activity streak')
        .addUserOption(o =>
            o.setName('user').setDescription('User to check (default: yourself)').setRequired(false)),

    async execute(interaction) {
        const target = interaction.options.getUser('user') ?? interaction.user;
        const user = await User.findOne({ userId: target.id, guildId: interaction.guild.id });

        if (!user) {
            return interaction.reply({
                content: `${target.id === interaction.user.id ? 'You have' : `${target.tag} has`} no activity recorded yet.`,
                ephemeral: true
            });
        }

        const current = user.streak?.current ?? 0;
        const longest = user.streak?.longest ?? 0;
        const lastActive = user.streak?.lastActive;

        const now = new Date();
        const isActive = lastActive && (now - lastActive) < 172800000; // within 48h

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

        await interaction.reply({ embeds: [embed], ephemeral: target.id !== interaction.user.id });
    }
};
