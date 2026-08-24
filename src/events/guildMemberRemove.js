const { getGuildSettings } = require('../utils/guildSettingsCache');
const GuildAnalytics = require('../models/GuildAnalytics');
const { EmbedBuilder, AuditLogEvent, PermissionFlagsBits } = require('discord.js');
const { trackAction } = require('../services/antiNukeService');
async function trackMemberEvent(guildId, dateKey, field) {
    const result = await GuildAnalytics.updateOne(
        { guildId, 'memberEvents.date': dateKey },
        { $inc: { [`memberEvents.$.${field}`]: 1 } }
    );
    if (!result.matchedCount) {
        await GuildAnalytics.updateOne(
            { guildId, 'memberEvents.date': { $ne: dateKey } },
            {
                $push: {
                    memberEvents: {
                        $each: [{ date: dateKey, joins: field === 'joins' ? 1 : 0, leaves: field === 'leaves' ? 1 : 0 }],
                        $slice: -120
                    }
                }
            },
            { upsert: true }
        );
    }
}

function applyVariables(template, member) {
    return template
        .replace(/{user}/g, member.user.globalName ?? member.user.username)
        .replace(/{username}/g, member.user.globalName ?? member.user.username)
        .replace(/{tag}/g, member.user.username)
        .replace(/{server}/g, member.guild.name)
        .replace(/{memberCount}/g, member.guild.memberCount);
}

module.exports = {
    name: 'guildMemberRemove',
    async execute(member, _client) {
        try {
            // Detect kick via audit log; bans fire guildBanAdd separately.
            await trackAction(member.guild, 'kick', AuditLogEvent.MemberKick, member.id).catch(console.error);

            const guildSettings = await getGuildSettings(member.guild.id);
            if (!guildSettings) return;

            const dateKey = new Date().toISOString().slice(0, 10);
            try {
                await trackMemberEvent(member.guild.id, dateKey, 'leaves');
            } catch (analyticsError) {
                console.error('Member leave analytics error:', analyticsError);
            }

            if (!guildSettings.farewell.enabled) return;

            const channel = member.guild.channels.cache.get(guildSettings.farewell.channelId);
            if (!channel) return;

            const perms = channel.permissionsFor(member.guild.members.me);
            if (!perms?.has(PermissionFlagsBits.SendMessages)) {
                console.error(`Missing SendMessages permission for farewell channel ${channel.id} in guild ${member.guild.id}`);
                return;
            }

            const message = applyVariables(guildSettings.farewell.message, member);

            const embed = new EmbedBuilder()
                .setColor('#ED4245')
                .setTitle('Goodbye!')
                .setDescription(message)
                .setThumbnail(member.user.displayAvatarURL())
                .setTimestamp();

            await channel.send({ embeds: [embed] });

            if (guildSettings.eventLog?.enabled && guildSettings.eventLog.logMemberLeave) {
                const logChannel = member.guild.channels.cache.get(guildSettings.eventLog.channelId);
                if (logChannel) {
                    const logEmbed = new EmbedBuilder()
                        .setColor('#ED4245')
                        .setTitle('Member Left')
                        .setAuthor({ name: member.user.username, iconURL: member.user.displayAvatarURL() })
                        .addFields(
                            { name: 'Joined', value: member.joinedAt ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Unknown', inline: true },
                            { name: 'Member Count', value: member.guild.memberCount.toString(), inline: true }
                        )
                        .setTimestamp();
                    await logChannel.send({ embeds: [logEmbed] }).catch(console.error);
                }
            }
        } catch (error) {
            console.error('Error in guildMemberRemove:', error);
        }
    }
};
