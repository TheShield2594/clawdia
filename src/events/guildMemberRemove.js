const Guild = require('../models/Guild');
const { EmbedBuilder, AuditLogEvent } = require('discord.js');
const { trackAction } = require('../services/antiNukeService');
async function trackMemberEvent(guildSettings, dateKey, field) {
    const result = await guildSettings.constructor.updateOne(
        { guildId: guildSettings.guildId, 'analytics.memberEvents.date': dateKey },
        {
            $inc: { [`analytics.memberEvents.$.${field}`]: 1 },
            $push: { 'analytics.memberEvents': { $each: [], $slice: -120 } }
        }
    );
    if (!result.matchedCount) {
        await guildSettings.constructor.updateOne(
            { guildId: guildSettings.guildId, 'analytics.memberEvents.date': { $ne: dateKey } },
            {
                $push: {
                    'analytics.memberEvents': {
                        $each: [{ date: dateKey, joins: field === 'joins' ? 1 : 0, leaves: field === 'leaves' ? 1 : 0 }],
                        $slice: -120
                    }
                }
            }
        );
    }
}

function applyVariables(template, member) {
    return template
        .replace(/{user}/g, member.user.tag)
        .replace(/{username}/g, member.user.displayName ?? member.user.username)
        .replace(/{tag}/g, member.user.tag)
        .replace(/{server}/g, member.guild.name)
        .replace(/{memberCount}/g, member.guild.memberCount);
}

module.exports = {
    name: 'guildMemberRemove',
    async execute(member, client) {
        try {
            // Detect kick via audit log; bans fire guildBanAdd separately.
            await trackAction(member.guild, 'kick', AuditLogEvent.MemberKick, member.id).catch(console.error);

            const guildSettings = await Guild.findOne({ guildId: member.guild.id });
            if (!guildSettings) return;

            const dateKey = new Date().toISOString().slice(0, 10);
            try {
                await trackMemberEvent(guildSettings, dateKey, 'leaves');
            } catch (analyticsError) {
                console.error('Member leave analytics error:', analyticsError);
            }

            if (!guildSettings.farewell.enabled) return;

            const channel = member.guild.channels.cache.get(guildSettings.farewell.channelId);
            if (!channel) return;

            const message = applyVariables(guildSettings.farewell.message, member);

            const embed = new EmbedBuilder()
                .setColor('#ED4245')
                .setTitle('Goodbye!')
                .setDescription(message)
                .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                .setTimestamp();

            await channel.send({ embeds: [embed] });

            if (guildSettings.eventLog?.enabled && guildSettings.eventLog.logMemberLeave) {
                const logChannel = member.guild.channels.cache.get(guildSettings.eventLog.channelId);
                if (logChannel) {
                    const logEmbed = new EmbedBuilder()
                        .setColor('#ED4245')
                        .setTitle('Member Left')
                        .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL({ dynamic: true }) })
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
