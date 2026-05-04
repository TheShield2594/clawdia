const { AuditLogEvent } = require('discord.js');
const { trackAction } = require('../services/antiNukeService');

module.exports = {
    name: 'roleCreate',
    async execute(role) {
        await trackAction(role.guild, 'roleCreate', AuditLogEvent.RoleCreate, role.id).catch(console.error);
    }
};
