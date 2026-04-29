const { EmbedBuilder } = require('discord.js');
const Guild = require('../models/Guild');

module.exports = {
    name: 'messageReactionAdd',
    async execute(reaction, user, client) {
        if (user.bot) return;

        if (reaction.partial) {
            try { await reaction.fetch(); } catch { return; }
        }
        if (reaction.message.partial) {
            try { await reaction.message.fetch(); } catch { return; }
        }

        const guild = reaction.message.guild;
        if (!guild) return;

        const guildSettings = await Guild.findOne({ guildId: guild.id });
        if (!guildSettings) return;

        await handleReactionRole(reaction, user, guild, guildSettings);
        await handleStarboard(reaction, user, guild, guildSettings);
    }
};

async function handleReactionRole(reaction, user, guild, guildSettings) {
    if (!guildSettings.reactionRoles?.length) return;

    const emojiKey = reaction.emoji.id
        ? `<${reaction.emoji.animated ? 'a' : ''}:${reaction.emoji.name}:${reaction.emoji.id}>`
        : reaction.emoji.name;

    const entry = guildSettings.reactionRoles.find(
        rr => rr.messageId === reaction.message.id && rr.emoji === emojiKey
    );
    if (!entry) return;

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;

    await member.roles.add(entry.roleId).catch(console.error);
}

async function handleStarboard(reaction, user, guild, guildSettings) {
    const sb = guildSettings.starboard;
    if (!sb?.enabled || !sb.channelId) return;

    const emojiKey = reaction.emoji.id
        ? `<${reaction.emoji.animated ? 'a' : ''}:${reaction.emoji.name}:${reaction.emoji.id}>`
        : reaction.emoji.name;

    if (emojiKey !== sb.emoji) return;

    const message = reaction.message;
    if (message.channel.id === sb.channelId) return;

    const reactionObj = message.reactions.cache.find(r => {
        const key = r.emoji.id
            ? `<${r.emoji.animated ? 'a' : ''}:${r.emoji.name}:${r.emoji.id}>`
            : r.emoji.name;
        return key === sb.emoji;
    });

    const count = reactionObj?.count ?? 0;
    if (count < sb.threshold) return;

    if (sb.starredMessages.includes(message.id)) return;

    sb.starredMessages.push(message.id);
    await guildSettings.save();

    const starChannel = guild.channels.cache.get(sb.channelId);
    if (!starChannel) return;

    const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
        .setDescription(message.content || null)
        .addFields({ name: 'Source', value: `[Jump to message](${message.url})` })
        .setTimestamp(message.createdAt);

    if (message.attachments.size > 0) {
        const img = message.attachments.find(a => a.contentType?.startsWith('image/'));
        if (img) embed.setImage(img.url);
    }

    await starChannel.send({
        content: `${sb.emoji} **${count}** | <#${message.channel.id}>`,
        embeds: [embed]
    }).catch(console.error);
}
