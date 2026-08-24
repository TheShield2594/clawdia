const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getGuildSettings } = require('../utils/guildSettingsCache');
const COLORS = require('../utils/embedColors');

module.exports = {
    name: 'guildMemberUpdate',
    async execute(oldMember, newMember, _client) {
        const guildSettings = await getGuildSettings(newMember.guild.id);
        if (!guildSettings?.eventLog?.enabled || !guildSettings.eventLog.logRoleChanges) return;

        const logChannel = newMember.guild.channels.cache.get(guildSettings.eventLog.channelId);
        if (!logChannel) return;

        if (!logChannel.permissionsFor(newMember.guild.members.me)?.has(PermissionFlagsBits.SendMessages)) return;

        const oldRoles = oldMember.roles.cache;
        const newRoles = newMember.roles.cache;

        const added = newRoles.filter(r => !oldRoles.has(r.id));
        const removed = oldRoles.filter(r => !newRoles.has(r.id));

        if (!added.size && !removed.size) return;

        const embed = new EmbedBuilder()
            .setColor(COLORS.INFO)
            .setTitle('Member Roles Updated')
            .setAuthor({ name: newMember.user.globalName ?? newMember.user.username, iconURL: newMember.user.displayAvatarURL() })
            .setTimestamp();

        if (added.size) embed.addFields({ name: 'Roles Added', value: added.map(r => r.toString()).join(', ') });
        if (removed.size) embed.addFields({ name: 'Roles Removed', value: removed.map(r => r.toString()).join(', ') });

        await logChannel.send({ embeds: [embed] }).catch(console.error);
    }
};
