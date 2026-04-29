const { EmbedBuilder, AuditLogEvent } = require('discord.js');
const Guild = require('../models/Guild');

module.exports = {
    name: 'guildMemberUpdate',
    async execute(oldMember, newMember, client) {
        const guildSettings = await Guild.findOne({ guildId: newMember.guild.id });
        if (!guildSettings?.eventLog?.enabled || !guildSettings.eventLog.logRoleChanges) return;

        const logChannel = newMember.guild.channels.cache.get(guildSettings.eventLog.channelId);
        if (!logChannel) return;

        const oldRoles = oldMember.roles.cache;
        const newRoles = newMember.roles.cache;

        const added = newRoles.filter(r => !oldRoles.has(r.id));
        const removed = oldRoles.filter(r => !newRoles.has(r.id));

        if (!added.size && !removed.size) return;

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('Member Roles Updated')
            .setAuthor({ name: newMember.user.tag, iconURL: newMember.user.displayAvatarURL({ dynamic: true }) })
            .setTimestamp();

        if (added.size) embed.addFields({ name: 'Roles Added', value: added.map(r => r.toString()).join(', ') });
        if (removed.size) embed.addFields({ name: 'Roles Removed', value: removed.map(r => r.toString()).join(', ') });

        await logChannel.send({ embeds: [embed] }).catch(console.error);
    }
};
