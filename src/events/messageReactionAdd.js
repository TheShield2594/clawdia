const { EmbedBuilder } = require('discord.js');
const Guild = require('../models/Guild');
const User = require('../models/User');
const { getGuildSettings } = require('../utils/guildSettingsCache');
const { ensureQuests, onReaction, notifyQuestComplete, notifyQuestNearComplete } = require('../services/questService');
const { saveWithBalanceDelta } = require('../utils/balanceDelta');
const COLORS = require('../utils/embedColors');

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

        // Read-only for three of the four handlers below; the starboard's one
        // write claims its message with a targeted update rather than saving
        // this object, which is shared with every other reader of this guild.
        const guildSettings = await getGuildSettings(guild.id);
        if (!guildSettings) return;

        await handleReactionRole(reaction, user, guild, guildSettings);
        await handleStarboard(reaction, user, guild, guildSettings);
        await handleReactionQuests(reaction, user, guild, guildSettings);
        await handleMemoryPin(reaction, user, guild, client);
    }
};

async function handleReactionQuests(reaction, discordUser, guild, guildSettings) {
    if (!guildSettings?.quests?.enabled) return;
    const userDoc = await User.findOneAndUpdate(
        { userId: discordUser.id, guildId: guild.id },
        { $setOnInsert: { userId: discordUser.id, guildId: guild.id } },
        { upsert: true, new: true }
    );
    if (!userDoc) return;

    // Quest coins are credited with an `$inc` at the save: `save()` writes
    // `balance` as an absolute `$set`, and a reaction handler has no idea what
    // else the player is doing in another channel.
    const balanceAtLoad = userDoc.balance ?? 0;

    await ensureQuests(userDoc, guildSettings);
    const { completed, nearComplete } = await onReaction(userDoc, guildSettings);
    await saveWithBalanceDelta(User, userDoc, balanceAtLoad, {
        service: 'messageReactionAdd',
        jobName: 'reactionQuestReward',
        guildId: guild.id,
    });
    const member = await guild.members.fetch(discordUser.id).catch(() => null);
    if (member) {
        await notifyQuestComplete(guildSettings, member, completed, reaction.message.channel);
        await notifyQuestNearComplete(guildSettings, member, nearComplete, reaction.message.channel);
    }
}

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

    // Claim the message in one atomic update instead of pushing onto the shared
    // settings object and saving it. The `$ne` in the filter *is* the claim: if
    // another reaction crossed the threshold first, the update matches nothing
    // and modifies nothing, so exactly one of them posts the star. The check
    // above is now only a cheap pre-filter against the cached list — the old
    // read-modify-write let two concurrent reactions both clear it and post the
    // same message twice.
    const claimed = await Guild.updateOne(
        { guildId: guild.id, 'starboard.starredMessages': { $ne: message.id } },
        { $push: { 'starboard.starredMessages': message.id } }
    );
    if (!claimed.modifiedCount) return;

    const starChannel = guild.channels.cache.get(sb.channelId);
    if (!starChannel) return;

    const embed = new EmbedBuilder()
        .setColor(COLORS.PRIZE)
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

const MEMORY_PIN_EMOJI = '📌';
const MEMORY_CAP = 10;

async function handleMemoryPin(reaction, discordUser, guild, client) {
    const emojiKey = reaction.emoji.id
        ? `<${reaction.emoji.animated ? 'a' : ''}:${reaction.emoji.name}:${reaction.emoji.id}>`
        : reaction.emoji.name;

    if (emojiKey !== MEMORY_PIN_EMOJI) return;

    const message = reaction.message;
    const botUser = client?.user;
    if (!botUser || message.author.id !== botUser.id) return;

    const content = message.content || (message.embeds[0]?.description ?? '');
    if (!content) return;

    const userDoc = await User.findOneAndUpdate(
        { userId: discordUser.id, guildId: guild.id },
        { $setOnInsert: { userId: discordUser.id, guildId: guild.id } },
        { upsert: true, new: true }
    );
    if (!userDoc) return;

    if (!userDoc.pinnedMemories) userDoc.pinnedMemories = [];

    if (userDoc.pinnedMemories.length >= MEMORY_CAP) {
        const dmChannel = await discordUser.createDM().catch(() => null);
        if (dmChannel) {
            await dmChannel.send(
                `Your pinned memory limit (${MEMORY_CAP}) is full. Use \`/ai memories\` to delete some before pinning more.`
            ).catch(() => null);
        }
        return;
    }

    // Truncate to a reasonable length for context injection
    const truncated = content.length > 500 ? content.slice(0, 500) + '…' : content;
    userDoc.pinnedMemories.push({ content: truncated, pinnedAt: new Date(), channelId: message.channel.id });
    await userDoc.save();

    const dmChannel = await discordUser.createDM().catch(() => null);
    if (dmChannel) {
        await dmChannel.send(`📌 Memory pinned! I'll remember this in future conversations.\n> ${truncated.slice(0, 100)}${truncated.length > 100 ? '…' : ''}`).catch(() => null);
    }
}
