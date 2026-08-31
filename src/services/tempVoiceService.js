const { ChannelType, PermissionFlagsBits } = require('discord.js');
const Guild = require('../models/Guild');
const { handlesGuild } = require('../utils/sharding');

async function handleVoiceStateUpdate(oldState, newState, _client) {
    const guild = newState.guild ?? oldState.guild;
    if (!guild) return;

    const guildSettings = await Guild.findOne({ guildId: guild.id });
    if (!guildSettings?.tempVoice?.enabled) return;

    const { lobbyChannelId, categoryId, channelName, userLimit, bitrate } = guildSettings.tempVoice;

    // Member joined the lobby → create their channel
    if (newState.channelId === lobbyChannelId && newState.member) {
        const member = newState.member;

        const botMember = guild.members.me;
        if (!botMember) return;
        const targetParent = categoryId ? guild.channels.cache.get(categoryId) : null;
        if (!botMember.permissionsIn(targetParent ?? guild).has(PermissionFlagsBits.ManageChannels)) {
            console.warn(`[TEMPVOICE] Bot lacks ManageChannels in guild ${guild.id}`);
            return;
        }

        const nameTemplate = channelName || "{username}'s VC";
        const resolvedName = nameTemplate
            .replace(/{username}/gi, member.user.username)
            .replace(/{displayname}/gi, member.displayName)
            .replace(/{tag}/gi, member.user.globalName ?? member.user.username);

        const channel = await guild.channels.create({
            name: resolvedName,
            type: ChannelType.GuildVoice,
            parent: categoryId ?? null,
            userLimit: userLimit ?? 0,
            bitrate: (bitrate ?? 64) * 1000,
            permissionOverwrites: [
                { id: member.id, allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MuteMembers, PermissionFlagsBits.DeafenMembers] }
            ]
        }).catch(console.error);

        if (!channel) return;

        await member.voice.setChannel(channel).catch(console.error);

        await Guild.updateOne(
            { guildId: guild.id },
            { $addToSet: { 'tempVoice.activeChannels': channel.id } }
        );
    }

    // Member left a temp channel → delete if empty
    if (oldState.channelId && oldState.channelId !== lobbyChannelId) {
        if (!guildSettings.tempVoice.activeChannels.includes(oldState.channelId)) return;

        const leftChannel = guild.channels.cache.get(oldState.channelId);
        if (leftChannel && leftChannel.members.size === 0) {
            await leftChannel.delete().catch(console.error);
            await Guild.updateOne(
                { guildId: guild.id },
                { $pull: { 'tempVoice.activeChannels': oldState.channelId } }
            );
        }
    }
}

// Cleanup stale temp channels (empty ones that weren't caught by voiceStateUpdate)
async function checkTempVoice(client) {
    try {
        const guilds = await Guild.find({ 'tempVoice.enabled': true, 'tempVoice.activeChannels.0': { $exists: true } });

        for (const guildSettings of guilds) {
            // Per-guild job. The cache miss below already skips another shard's
            // guilds, but it cannot tell them apart from a guild this shard owns
            // and has not cached yet — which would silently clear activeChannels.
            if (!handlesGuild(guildSettings.guildId, client)) continue;

            const guild = client.guilds.cache.get(guildSettings.guildId);
            if (!guild) continue;

            const toKeep = [];

            for (const channelId of guildSettings.tempVoice.activeChannels) {
                const channel = guild.channels.cache.get(channelId);
                if (!channel || channel.members.size === 0) {
                    if (channel) await channel.delete().catch(() => {});
                } else {
                    toKeep.push(channelId);
                }
            }

            if (toKeep.length !== guildSettings.tempVoice.activeChannels.length) {
                await Guild.updateOne(
                    { guildId: guildSettings.guildId },
                    { $set: { 'tempVoice.activeChannels': toKeep } }
                );
            }
        }
    } catch (err) {
        console.error('[TEMPVOICE] Error in checkTempVoice:', err);
    }
}

module.exports = { handleVoiceStateUpdate, checkTempVoice };
