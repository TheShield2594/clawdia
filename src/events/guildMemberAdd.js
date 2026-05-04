const Guild = require('../models/Guild');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { createWelcomeCard } = require('../utils/cardGenerator');
const { handleMemberJoin: raidCheck } = require('../services/raidService');
const { enforceJoinGate } = require('../services/antiNukeService');
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
        .replace(/{user}/g, `<@${member.id}>`)
        .replace(/{username}/g, member.user.displayName ?? member.user.username)
        .replace(/{tag}/g, member.user.tag)
        .replace(/{server}/g, member.guild.name)
        .replace(/{memberCount}/g, member.guild.memberCount);
}

module.exports = {
    name: 'guildMemberAdd',
    async execute(member, client) {
        try {
            // Join gate runs first; if it removes the member, skip the rest.
            const gated = await enforceJoinGate(member).catch(err => { console.error(err); return false; });
            if (gated) return;

            // Raid detection runs next, independently of guild settings load below
            await raidCheck(member, client).catch(console.error);

            const guildSettings = await Guild.findOne({ guildId: member.guild.id });

            if (!guildSettings) return;
            const dateKey = new Date().toISOString().slice(0, 10);
            try {
                await trackMemberEvent(guildSettings, dateKey, 'joins');
            } catch (analyticsError) {
                console.error('Member join analytics error:', analyticsError);
            }

            if (guildSettings.welcome.enabled) {
                const channel = member.guild.channels.cache.get(guildSettings.welcome.channelId);
                if (channel) {
                    const message = applyVariables(guildSettings.welcome.message, member);

                    if (guildSettings.welcome.cardEnabled) {
                        const card = await createWelcomeCard(member);
                        const attachment = new AttachmentBuilder(card, { name: 'welcome.png' });

                        const embed = new EmbedBuilder()
                            .setColor('#5865F2')
                            .setDescription(message)
                            .setImage('attachment://welcome.png')
                            .setTimestamp();

                        await channel.send({ embeds: [embed], files: [attachment] });
                    } else {
                        const embed = new EmbedBuilder()
                            .setColor('#5865F2')
                            .setTitle('Welcome!')
                            .setDescription(message)
                            .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                            .setTimestamp();

                        await channel.send({ embeds: [embed] });
                    }
                }
            }

            if (guildSettings.welcome.dmEnabled) {
                const dmMessage = applyVariables(guildSettings.welcome.dmMessage, member);
                await member.send(dmMessage).catch(() => null);
            }

            if (guildSettings.autoRoles.length > 0) {
                for (const autoRole of guildSettings.autoRoles) {
                    const role = member.guild.roles.cache.get(autoRole.roleId);
                    if (role) {
                        await member.roles.add(role).catch(console.error);
                    }
                }
            }

            if (guildSettings.eventLog?.enabled && guildSettings.eventLog.logMemberJoin) {
                const logChannel = member.guild.channels.cache.get(guildSettings.eventLog.channelId);
                if (logChannel) {
                    const logEmbed = new EmbedBuilder()
                        .setColor('#5865F2')
                        .setTitle('Member Joined')
                        .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL({ dynamic: true }) })
                        .addFields(
                            { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
                            { name: 'Member Count', value: member.guild.memberCount.toString(), inline: true }
                        )
                        .setTimestamp();
                    await logChannel.send({ embeds: [logEmbed] }).catch(console.error);
                }
            }
        } catch (error) {
            console.error('Error in guildMemberAdd:', error);
        }
    }
};
