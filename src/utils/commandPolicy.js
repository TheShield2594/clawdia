'use strict';

// The guild's command policies (dashboard → Command Policies): per-command
// deny rules scoped by role, channel and a UTC time window, with user and role
// exceptions.
//
// This lived inside events/interactionCreate.js, where only slash commands
// reached it. Buttons that start an action a slash command would otherwise
// start — /hunt's "Hunt again" — have to answer to the same rules, or a
// channel that blocks /hunt would still host hunts one button press at a time.
// So the check takes the command name rather than reading it off a chat-input
// interaction.

function memberHasAnyRole(member, roleIds = []) {
    if (!member || !Array.isArray(roleIds) || roleIds.length === 0) return false;
    return roleIds.some(roleId => member.roles?.cache?.has(roleId));
}

function isWithinRuleWindow(rule, now) {
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    if (Array.isArray(rule.daysOfWeek) && rule.daysOfWeek.length > 0 && !rule.daysOfWeek.includes(day)) {
        return false;
    }
    if (rule.startHourUtc == null || rule.endHourUtc == null) return true;
    if (rule.startHourUtc <= rule.endHourUtc) {
        return hour >= rule.startHourUtc && hour <= rule.endHourUtc;
    }
    return hour >= rule.startHourUtc || hour <= rule.endHourUtc;
}

/**
 * Whether `commandName` may run for this interaction's member and channel.
 * `interaction` needs only `user`, `member` and `channelId`, so a component
 * interaction answers as well as the command it stands in for.
 *
 * @returns {{ allowed: true } | { allowed: false, reason: string }}
 */
function getPolicyDecision(interaction, guildSettings, commandName = interaction.commandName) {
    const policies = guildSettings?.commandPolicies;
    if (!policies?.enabled) return { allowed: true };
    if (policies.exceptions?.userIds?.includes(interaction.user.id)) return { allowed: true };
    if (memberHasAnyRole(interaction.member, policies.exceptions?.roleIds)) return { allowed: true };

    const now = new Date();
    const applicableRules = (policies.rules || []).filter(rule => {
        if (rule.command !== commandName && rule.command !== '*') return false;
        if (Array.isArray(rule.roleIds) && rule.roleIds.length > 0 && !memberHasAnyRole(interaction.member, rule.roleIds)) return false;
        if (Array.isArray(rule.channelIds) && rule.channelIds.length > 0 && !rule.channelIds.includes(interaction.channelId)) return false;
        return isWithinRuleWindow(rule, now);
    });
    const denied = applicableRules.find(rule => rule.effect === 'deny');
    if (denied) return { allowed: false, reason: 'This command is blocked by server policy for your context.' };
    return { allowed: true };
}

module.exports = { getPolicyDecision, memberHasAnyRole, isWithinRuleWindow };
