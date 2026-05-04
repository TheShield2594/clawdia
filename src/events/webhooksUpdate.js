const { AuditLogEvent } = require('discord.js');
const { trackAction } = require('../services/antiNukeService');

// Discord fires `webhooksUpdate` when webhooks in a channel change. We use the
// audit log to figure out whether this was a create vs. update vs. delete and
// only count creates against the burst threshold.
module.exports = {
    name: 'webhooksUpdate',
    async execute(channel) {
        if (!channel?.guild) return;
        await trackAction(channel.guild, 'webhookCreate', AuditLogEvent.WebhookCreate, null).catch(console.error);
    }
};
