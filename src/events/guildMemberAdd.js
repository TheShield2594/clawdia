const { getGuildSettings } = require('../utils/guildSettingsCache');
const GuildAnalytics = require('../models/GuildAnalytics');
const { EmbedBuilder, AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const { createWelcomeCard } = require('../utils/cardGenerator');
const { handleMemberJoin: raidCheck } = require('../services/raidService');
const { enforceJoinGate } = require('../services/antiNukeService');

async function trackMemberEvent(guildId, dateKey, field) {
    // Try to atomically increment today's existing entry (fix #8 — simpler, no spurious $push).
    const result = await GuildAnalytics.updateOne(
        { guildId, 'memberEvents.date': dateKey },
        { $inc: { [`memberEvents.$.${field}`]: 1 } }
    );
    if (!result.matchedCount) {
        // No entry for today yet; add one and trim array to 120 days.
        // The $ne guard prevents a duplicate insert when concurrent joins both
        // miss the first update and race to this branch.
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
        .replace(/{user}/g, `<@${member.id}>`)
        .replace(/{username}/g, member.user.displayName ?? member.user.username)
        .replace(/{tag}/g, member.user.username)
        .replace(/{server}/g, member.guild.name)
        .replace(/{memberCount}/g, member.guild.memberCount);
}

module.exports = {
    name: 'guildMemberAdd',
    // Exported for unit testing only
    _applyVariables: applyVariables,
    async execute(member, client) {
        try {
            // One settings read serves this whole handler. The join gate and the
            // raid check each used to issue their own uncached Guild.findOne, so a
            // single join hydrated the full guild document three times — shop image
            // Buffers, analytics and all (#593). Resolve once, hand the same object
            // down, and let the cache absorb the read.
            const guildSettings = await getGuildSettings(member.guild.id);

            // Join gate runs first; if it removes the member, skip the rest.
            const gated = await enforceJoinGate(member, guildSettings).catch(err => { console.error(err); return false; });
            if (gated) return;

            // Raid detection runs next, independently of the welcome/autorole work below
            await raidCheck(member, client, guildSettings).catch(console.error);

            if (!guildSettings) return;
            const dateKey = new Date().toISOString().slice(0, 10);
            try {
                await trackMemberEvent(member.guild.id, dateKey, 'joins');
            } catch (analyticsError) {
                console.error('Member join analytics error:', analyticsError);
            }

            if (guildSettings.welcome.enabled) {
                const channel = member.guild.channels.cache.get(guildSettings.welcome.channelId);
                if (channel) {
                    // Check that the bot actually has permission to post before trying (fix #10)
                    const perms = channel.permissionsFor(member.guild.members.me);
                    const canSend = perms?.has(PermissionFlagsBits.SendMessages);
                    const canAttach = perms?.has(PermissionFlagsBits.AttachFiles);

                    if (!canSend) {
                        console.error(`Missing SendMessages permission for welcome channel ${channel.id} in guild ${member.guild.id}`);
                    } else {
                        const message = applyVariables(guildSettings.welcome.message, member);

                        if (guildSettings.welcome.cardEnabled && canAttach) {
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
                                // Remove deprecated { dynamic: true } option (fix #4)
                                .setThumbnail(member.user.displayAvatarURL())
                                .setTimestamp();

                            await channel.send({ embeds: [embed] });
                        }
                    }
                }
            }

            if (guildSettings.welcome.dmEnabled) {
                const dmMessage = applyVariables(guildSettings.welcome.dmMessage, member);
                await member.send(dmMessage).catch(() => null);
            }

            if (guildSettings.autoRoles.length > 0) {
                const results = await Promise.allSettled(
                    guildSettings.autoRoles
                        .map(autoRole => ({ roleId: autoRole.roleId, role: member.guild.roles.cache.get(autoRole.roleId) }))
                        .filter(({ role }) => role)
                        .map(({ roleId, role }) => member.roles.add(role).catch(err => { throw Object.assign(err, { roleId }); }))
                );
                for (const r of results) {
                    if (r.status === 'rejected') {
                        console.error(`Failed to add auto-role ${r.reason?.roleId} to ${member.id}:`, r.reason);
                    }
                }
            }

            if (guildSettings.eventLog?.enabled && guildSettings.eventLog.logMemberJoin) {
                const logChannel = member.guild.channels.cache.get(guildSettings.eventLog.channelId);
                if (logChannel) {
                    const logEmbed = new EmbedBuilder()
                        .setColor('#5865F2')
                        .setTitle('Member Joined')
                        // Use username instead of deprecated .tag (fix #5); drop deprecated dynamic option (fix #4)
                        .setAuthor({ name: member.user.username, iconURL: member.user.displayAvatarURL() })
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
