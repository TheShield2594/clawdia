const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');

const XP_COOLDOWN_SECONDS = 60;

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('xpinfo')
        .setDescription('See which channels and roles are excluded from XP gain in this server.'),
    async execute(interaction) {
        try {
            const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
            const leveling = guildSettings?.leveling ?? {};

            const xpRate = leveling.xpRate ?? 1.0;
            const voiceEnabled = leveling.voiceXpEnabled ?? false;
            const excludedChannelIds = leveling.noXpChannelIds ?? [];
            const excludedRoleIds = leveling.noXpRoleIds ?? [];

            const channelMentions = excludedChannelIds
                .map(id => `<#${id}>`)
                .join(', ') || 'None';

            const roleMentions = excludedRoleIds
                .map(id => `<@&${id}>`)
                .join(', ') || 'None';

            const xpRateLabel = xpRate === 1.0 ? `${xpRate}x (default)` : `${xpRate}x`;

            const hasExclusions = excludedChannelIds.length > 0 || excludedRoleIds.length > 0;
            const statusLine = hasExclusions
                ? 'Some channels or roles may limit your XP gain — see above.'
                : 'You are currently earning XP normally.';

            const embed = new EmbedBuilder()
                .setColor('#3498db')
                .setTitle(`📊 XP Settings for ${interaction.guild.name}`)
                .addFields(
                    { name: 'XP Rate', value: xpRateLabel, inline: true },
                    { name: 'Cooldown', value: `${XP_COOLDOWN_SECONDS} seconds`, inline: true },
                    { name: 'Voice XP', value: voiceEnabled ? 'Enabled' : 'Disabled', inline: true },
                    { name: '🚫 XP-Excluded Channels', value: channelMentions, inline: false },
                    { name: '🚫 XP-Excluded Roles', value: roleMentions, inline: false }
                )
                .setFooter({ text: statusLine });

            await interaction.reply({ embeds: [embed], ephemeral: true });
        } catch (error) {
            console.error('XP info error:', error);
            await interaction.reply({ content: 'Failed to fetch XP settings.', ephemeral: true });
        }
    }
};
