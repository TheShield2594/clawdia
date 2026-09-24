'use strict';

// The guild's command policies (dashboard → Command Policies): per-command
// deny rules scoped by role, channel and a UTC time window, with user and role
// exceptions — and the per-command cooldown, with the per-role overrides the
// same dashboard page sets.
//
// This lived inside events/interactionCreate.js, where only slash commands
// reached it. Buttons that start an action a slash command would otherwise
// start — /hunt's "Hunt again" — have to answer to the same rules, or a
// channel that blocks /hunt would still host hunts one button press at a time.
// So the check takes the command name rather than reading it off a chat-input
// interaction, and the cooldown claim takes the command module, so a button
// standing in for a command spends the same cooldown the command would.

const cooldownStore = require('./commandCooldowns');

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

// Node's setTimeout treats delays > 2^31-1 ms as 1 ms, which would wipe the
// cooldown timestamp almost immediately and let the next call slip past the
// gate. Clamp cooldown seconds so seconds * 1000 stays within timer bounds.
const MAX_TIMER_MS = 2_147_483_647;
const MAX_COOLDOWN_SECONDS = Math.floor(MAX_TIMER_MS / 1000);

function coerceCooldown(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.floor(Math.min(n, MAX_COOLDOWN_SECONDS));
}

function getCooldownSeconds(command, interaction, guildSettings) {
    const rawBase = typeof command.cooldownAmount === 'function'
        ? command.cooldownAmount(interaction)
        : (command.cooldown ?? 3);
    const baseCooldown = coerceCooldown(rawBase, 3);
    const overrides = guildSettings?.commandPolicies?.cooldownOverrides || [];
    const matches = overrides.filter(entry =>
        entry.command === command.data.name &&
        Number.isFinite(Number(entry.cooldownSeconds)) &&
        Number(entry.cooldownSeconds) >= 0 &&
        interaction.member?.roles?.cache?.has(entry.roleId));
    if (!matches.length) return baseCooldown;
    return coerceCooldown(Math.min(...matches.map(match => Number(match.cooldownSeconds))), baseCooldown);
}

function getCooldownKey(command, interaction) {
    return typeof command.cooldownKey === 'function'
        ? command.cooldownKey(interaction)
        : command.data.name;
}

/**
 * Claims `command`'s cooldown for this member, or says why it cannot.
 *
 * One operation, not a check followed by a claim: the yield between two awaits
 * was a window in which a user firing the same command twice passed the check
 * twice. Short cooldowns are process-local; anything from 15 minutes up is
 * read from and written to the User document (#621, utils/commandCooldowns).
 *
 * @returns {Promise<?string>} the refusal to show, or null once claimed
 */
async function claimCommandCooldown(client, command, interaction, guildSettings) {
    const expirationTime = await cooldownStore.claimIfAvailable(client, {
        bucket: getCooldownKey(command, interaction),
        userId: interaction.user.id,
        guildId: interaction.guild.id,
        cooldownMs: getCooldownSeconds(command, interaction, guildSettings) * 1000,
    });
    if (!expirationTime) return null;

    const expiredTimestamp = Math.round(expirationTime / 1000);
    const longCooldown = (expirationTime - Date.now()) > 12 * 60 * 60 * 1000;
    const exactTime = longCooldown ? ` (<t:${expiredTimestamp}:F>)` : '';
    return `Please wait, you are on cooldown. You can use \`/${command.data.name}\` again <t:${expiredTimestamp}:R>${exactTime}.`;
}

module.exports = {
    claimCommandCooldown,
    getCooldownKey,
    getCooldownSeconds,
    getPolicyDecision,
    isWithinRuleWindow,
    memberHasAnyRole,
};
