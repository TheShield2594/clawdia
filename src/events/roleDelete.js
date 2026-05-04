const { AuditLogEvent } = require('discord.js');
const { trackAction } = require('../services/antiNukeService');

module.exports = {
    name: 'roleDelete',
    async execute(role) {
        await trackAction(role.guild, 'roleDelete', AuditLogEvent.RoleDelete, role.id).catch(console.error);
    }
};
