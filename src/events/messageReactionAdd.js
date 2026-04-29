const Guild = require('../models/Guild');

module.exports = {
    name: 'messageReactionAdd',
    async execute(reaction, user, client) {
        if (user.bot) return;

        if (reaction.partial) {
            try { await reaction.fetch(); } catch { return; }
        }

        const guild = reaction.message.guild;
        if (!guild) return;

        const guildSettings = await Guild.findOne({ guildId: guild.id });
        if (!guildSettings?.reactionRoles?.length) return;

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
};
