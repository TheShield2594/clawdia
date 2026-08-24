const { EmbedBuilder, AuditLogEvent, PermissionFlagsBits } = require('discord.js');
const { getGuildSettings } = require('../utils/guildSettingsCache');
const { trackAction } = require('../services/antiNukeService');

module.exports = {
    name: 'channelCreate',
    async execute(channel, _client) {
        if (!channel.guild) return;

        await trackAction(channel.guild, 'channelCreate', AuditLogEvent.ChannelCreate, channel.id).catch(console.error);

        const guildSettings = await getGuildSettings(channel.guild.id);
        if (!guildSettings?.eventLog?.enabled || !guildSettings.eventLog.logChannelChanges) return;

        const logChannel = channel.guild.channels.cache.get(guildSettings.eventLog.channelId);
        if (!logChannel || logChannel.id === channel.id) return;

        if (!logChannel.permissionsFor(channel.guild.members.me)?.has(PermissionFlagsBits.SendMessages)) return;

        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('Channel Created')
            .addFields(
                { name: 'Name', value: channel.name, inline: true },
                { name: 'Type', value: channel.type.toString(), inline: true },
                { name: 'Category', value: channel.parent?.name ?? 'None', inline: true }
            )
            .setTimestamp();

        await logChannel.send({ embeds: [embed] }).catch(console.error);
    }
};
