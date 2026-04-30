const Guild = require('../models/Guild');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { createWelcomeCard } = require('../utils/cardGenerator');

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
            const guildSettings = await Guild.findOne({ guildId: member.guild.id });

            if (!guildSettings) return;
            const dateKey = new Date().toISOString().slice(0, 10);
            const day = guildSettings.analytics?.memberEvents?.find(d => d.date === dateKey);
            if (day) {
                day.joins += 1;
            } else {
                guildSettings.analytics = guildSettings.analytics || {};
                guildSettings.analytics.memberEvents = guildSettings.analytics.memberEvents || [];
                guildSettings.analytics.memberEvents.push({ date: dateKey, joins: 1, leaves: 0 });
            }
            guildSettings.analytics.memberEvents = guildSettings.analytics.memberEvents.slice(-120);
            await guildSettings.save();

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
