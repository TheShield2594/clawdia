const { ChannelType, PermissionFlagsBits } = require('discord.js');
const Guild = require('../models/Guild');

async function handleVoiceStateUpdate(oldState, newState, client) {
    const guild = newState.guild ?? oldState.guild;
    if (!guild) return;

    const guildSettings = await Guild.findOne({ guildId: guild.id });
    if (!guildSettings?.tempVoice?.enabled) return;

    const { lobbyChannelId, categoryId } = guildSettings.tempVoice;

    // Member joined the lobby → create their channel
    if (newState.channelId === lobbyChannelId && newState.member) {
        const member = newState.member;
        const channel = await guild.channels.create({
            name: `${member.displayName}'s VC`,
            type: ChannelType.GuildVoice,
            parent: categoryId ?? null,
            permissionOverwrites: [
                { id: member.id, allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MuteMembers, PermissionFlagsBits.DeafenMembers] }
            ]
        }).catch(console.error);

        if (!channel) return;

        await member.voice.setChannel(channel).catch(console.error);

        guildSettings.tempVoice.activeChannels.push(channel.id);
        await guildSettings.save();
    }

    // Member left a temp channel → delete if empty
    if (oldState.channelId && oldState.channelId !== lobbyChannelId) {
        if (!guildSettings.tempVoice.activeChannels.includes(oldState.channelId)) return;

        const leftChannel = guild.channels.cache.get(oldState.channelId);
        if (leftChannel && leftChannel.members.size === 0) {
            await leftChannel.delete().catch(console.error);
            guildSettings.tempVoice.activeChannels = guildSettings.tempVoice.activeChannels.filter(
                id => id !== oldState.channelId
            );
            await guildSettings.save();
        }
    }
}

// Cleanup stale temp channels (empty ones that weren't caught by voiceStateUpdate)
async function checkTempVoice(client) {
    try {
        const guilds = await Guild.find({ 'tempVoice.enabled': true, 'tempVoice.activeChannels.0': { $exists: true } });

        for (const guildSettings of guilds) {
            const guild = client.guilds.cache.get(guildSettings.guildId);
            if (!guild) continue;

            let dirty = false;
            const toKeep = [];

            for (const channelId of guildSettings.tempVoice.activeChannels) {
                const channel = guild.channels.cache.get(channelId);
                if (!channel || channel.members.size === 0) {
                    if (channel) await channel.delete().catch(() => {});
                    dirty = true;
                } else {
                    toKeep.push(channelId);
                }
            }

            if (dirty) {
                guildSettings.tempVoice.activeChannels = toKeep;
                await guildSettings.save();
            }
        }
    } catch (err) {
        console.error('[TEMPVOICE] Error in checkTempVoice:', err);
    }
}

module.exports = { handleVoiceStateUpdate, checkTempVoice };
