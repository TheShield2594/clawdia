const { EmbedBuilder } = require('discord.js');
const Guild = require('../models/Guild');
const User = require('../models/User');
const { getGuildSettings } = require('../utils/guildSettingsCache');
const {
    ensureQuests, onReaction, questEventCanProgress, questAssignmentNeeded,
    notifyQuestComplete, notifyQuestNearComplete,
} = require('../services/questService');
const { saveWithBalanceDelta } = require('../utils/balanceDelta');
const COLORS = require('../utils/embedColors');
const { MEMORY_CAP, MAX_MEMORY_LENGTH } = require('../utils/memoryLimits');

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

        // Reaction roles and the starboard share no document with each other or
        // with anything below — one adds a role, the other claims a message in
        // the guild document — so they run together rather than one behind the
        // other (#929). Settled, not raced: a handler that throws must not take
        // the other three down with it, which is what the old sequential awaits
        // did.
        const independent = await Promise.allSettled([
            handleReactionRole(reaction, user, guild, guildSettings),
            handleStarboard(reaction, user, guild, guildSettings),
        ]);
        for (const outcome of independent) {
            if (outcome.status === 'rejected') console.error('Error in messageReactionAdd:', outcome.reason);
        }

        // These two stay in sequence, and must. Both load the reacting member's
        // `User` document and both `save()` it, so running them concurrently
        // would have each write back the copy it read — the pinned memory or
        // the quest progress, whichever landed second, silently erasing the
        // other.
        try {
            await handleReactionQuests(reaction, user, guild, guildSettings);
        } catch (err) {
            console.error('Error in messageReactionAdd:', err);
        }
        await handleMemoryPin(reaction, user, guild, client);
    }
};

async function handleReactionQuests(reaction, discordUser, guild, guildSettings) {
    if (!guildSettings?.quests?.enabled) return;

    const filter = { userId: discordUser.id, guildId: guild.id };

    // Cheap read first (#929). Every reaction used to pay an upsert, a full
    // user hydrate, a save and a member fetch, for four quest ids that a given
    // member has usually either finished for the day or never been assigned.
    // Reaction bursts are what makes that expensive: a message that catches on,
    // or a starboard-active channel, lands dozens of these in seconds and each
    // one paid in full.
    //
    // A projected quest list answers whether anything could move. When nothing
    // can, the reaction costs this one small read — and, notably, no upsert, so
    // a passer-by who reacts once no longer has a document created for them
    // here. The upsert still runs on the path that has work to do, which is the
    // path that needs the document to exist.
    const snapshot = await User.findOne(filter, { quests: 1 }).lean();
    if (snapshot
        && !questEventCanProgress(snapshot.quests, 'reaction')
        && !questAssignmentNeeded(snapshot.quests, guildSettings)) return;

    const userDoc = await User.findOneAndUpdate(
        filter,
        { $setOnInsert: filter },
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
    // The member fetch exists only to address the notification, so it is not
    // worth a REST call — or a cache miss's round trip — on the overwhelming
    // majority of reactions, which complete nothing and near-complete nothing.
    if (!completed.length && !nearComplete.length) return;

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
    const truncated = content.length > MAX_MEMORY_LENGTH ? content.slice(0, MAX_MEMORY_LENGTH) + '…' : content;
    userDoc.pinnedMemories.push({ content: truncated, pinnedAt: new Date(), channelId: message.channel.id });
    await userDoc.save();

    const dmChannel = await discordUser.createDM().catch(() => null);
    if (dmChannel) {
        await dmChannel.send(`📌 Memory pinned! I'll remember this in future conversations.\n> ${truncated.slice(0, 100)}${truncated.length > 100 ? '…' : ''}`).catch(() => null);
    }
}
