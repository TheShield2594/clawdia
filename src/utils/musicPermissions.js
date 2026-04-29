const Guild = require('../models/Guild');

async function checkDjPermission(interaction) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (!guildSettings?.music?.djRoleId) return true;

    const member = interaction.member;
    if (member.permissions.has('ManageChannels')) return true;
    return member.roles.cache.has(guildSettings.music.djRoleId);
}

module.exports = { checkDjPermission };
