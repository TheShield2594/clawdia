const { EmbedBuilder, AuditLogEvent } = require('discord.js');
const Guild = require('../models/Guild');
const { trackAction } = require('../services/antiNukeService');

module.exports = {
    name: 'channelDelete',
    async execute(channel, client) {
        if (!channel.guild) return;

        await trackAction(channel.guild, 'channelDelete', AuditLogEvent.ChannelDelete, channel.id).catch(console.error);

        const guildSettings = await Guild.findOne({ guildId: channel.guild.id });

        // If a temp voice channel was manually deleted, remove it from the active list
        if (guildSettings?.tempVoice?.enabled && guildSettings.tempVoice.activeChannels.includes(channel.id)) {
            await Guild.updateOne(
                { guildId: channel.guild.id },
                { $pull: { 'tempVoice.activeChannels': channel.id } }
            ).catch(console.error);
        }

        if (!guildSettings?.eventLog?.enabled || !guildSettings.eventLog.logChannelChanges) return;

        const logChannel = channel.guild.channels.cache.get(guildSettings.eventLog.channelId);
        if (!logChannel) return;

        const embed = new EmbedBuilder()
            .setColor('#ff0000')
            .setTitle('Channel Deleted')
            .addFields(
                { name: 'Name', value: channel.name, inline: true },
                { name: 'Type', value: channel.type.toString(), inline: true },
                { name: 'Category', value: channel.parent?.name ?? 'None', inline: true }
            )
            .setTimestamp();

        await logChannel.send({ embeds: [embed] }).catch(console.error);
    }
};
