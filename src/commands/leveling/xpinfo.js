const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');

const XP_COOLDOWN_SECONDS = 60;
const FIELD_LIMIT = 1024;

function truncateMentionList(ids, format) {
    const items = [];
    let length = 0;
    for (let i = 0; i < ids.length; i++) {
        const mention = format(ids[i]);
        const separator = items.length > 0 ? ', ' : '';
        const added = separator.length + mention.length;
        const remaining = ids.length - i;
        const suffix = `, … and ${remaining} more`;
        if (length + added + (remaining > 1 ? suffix.length : 0) > FIELD_LIMIT) {
            items.push(`… and ${remaining} more`);
            break;
        }
        items.push(mention);
        length += added;
    }
    return items.length > 0 ? items.join(', ') : 'None';
}

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('xpinfo')
        .setDescription('See which channels and roles are excluded from XP gain in this server.')
        .setDMPermission(false),
    async execute(interaction) {
        if (!interaction.inGuild()) return;
        try {
            const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
            const leveling = guildSettings?.leveling ?? {};

            const xpRate = leveling.xpRate ?? 1.0;
            const voiceEnabled = leveling.voiceXpEnabled ?? false;
            const excludedChannelIds = leveling.noXpChannelIds ?? [];
            const excludedRoleIds = leveling.noXpRoleIds ?? [];

            const channelMentions = truncateMentionList(excludedChannelIds, id => `<#${id}>`);
            const roleMentions = truncateMentionList(excludedRoleIds, id => `<@&${id}>`);

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
