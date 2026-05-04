const { AuditLogEvent } = require('discord.js');
const { trackAction } = require('../services/antiNukeService');

module.exports = {
    name: 'guildBanAdd',
    async execute(ban) {
        await trackAction(ban.guild, 'ban', AuditLogEvent.MemberBanAdd, ban.user.id).catch(console.error);
    }
};
