const Guild = require('../models/Guild');
const User = require('../models/User');
const { closeTicket } = require('../commands/moderation/ticket');
const { handlePollVote } = require('../commands/utility/poll');
const { ensureQuests, onCommandUse } = require('../services/questService');
async function logCommandMetric(interaction, success, reason = null) {
    try {
        const entry = {
            command: interaction.commandName,
            channelId: interaction.channelId || null,
            hour: new Date().getUTCHours(),
            success,
            reason
        };
        await Guild.updateOne(
            { guildId: interaction.guild.id },
            {
                $push: {
                    'analytics.commandUsage': {
                        $each: [entry],
                        $slice: -3000
                    }
                },
                $setOnInsert: {
                    guildId: interaction.guild.id,
                    name: interaction.guild.name || 'Unknown Guild'
                }
            },
            { upsert: true }
        );
    } catch (error) {
        console.error('Command metric error:', error);
    }
}

async function trackQuestCommandUse(interaction) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (!guildSettings?.quests?.enabled) return;

    let user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
    if (!user) {
        user = await User.create({ userId: interaction.user.id, guildId: interaction.guild.id });
    }

    await ensureQuests(user, guildSettings);
    const completed = await onCommandUse(user, guildSettings);
    await user.save();

    for (const reward of completed) {
        if (!reward) continue;
        const ch = interaction.channel;
        if (ch) {
            await ch.send(`${interaction.user} completed a quest! **+${reward.xp} XP, +${reward.coins} coins**`).catch(() => {});
        }
    }
}

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

function getPolicyDecision(interaction, guildSettings) {
    const policies = guildSettings?.commandPolicies;
    if (!policies?.enabled) return { allowed: true };
    if (policies.exceptions?.userIds?.includes(interaction.user.id)) return { allowed: true };
    if (memberHasAnyRole(interaction.member, policies.exceptions?.roleIds)) return { allowed: true };

    const cmd = interaction.commandName;
    const now = new Date();
    const applicableRules = (policies.rules || []).filter(rule => {
        if (rule.command !== cmd && rule.command !== '*') return false;
        if (Array.isArray(rule.roleIds) && rule.roleIds.length > 0 && !memberHasAnyRole(interaction.member, rule.roleIds)) return false;
        if (Array.isArray(rule.channelIds) && rule.channelIds.length > 0 && !rule.channelIds.includes(interaction.channelId)) return false;
        return isWithinRuleWindow(rule, now);
    });
    const denied = applicableRules.find(rule => rule.effect === 'deny');
    if (denied) return { allowed: false, reason: 'This command is blocked by server policy for your context.' };
    return { allowed: true };
}

function getCooldownSeconds(command, interaction, guildSettings) {
    const defaultCooldownDuration = command.cooldown ?? 3;
    const overrides = guildSettings?.commandPolicies?.cooldownOverrides || [];
    const matches = overrides.filter(entry => entry.command === command.data.name && interaction.member?.roles?.cache?.has(entry.roleId));
    if (!matches.length) return defaultCooldownDuration;
    return Math.min(...matches.map(match => match.cooldownSeconds));
}

module.exports = {
    name: 'interactionCreate',
    async execute(interaction, client) {
        if (interaction.isButton()) {
            if (interaction.customId === 'ticket_close') {
                const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
                await closeTicket(interaction, guildSettings);
            }

            if (interaction.customId === 'giveaway_enter') {
                const msg = interaction.message;
                if (!msg.giveawayEntrants) msg.giveawayEntrants = [];

                if (msg.giveawayEntrants.includes(interaction.user.id)) {
                    msg.giveawayEntrants = msg.giveawayEntrants.filter(id => id !== interaction.user.id);
                    await interaction.reply({ content: 'You have left the giveaway.', ephemeral: true });
                } else {
                    msg.giveawayEntrants.push(interaction.user.id);
                    await interaction.reply({ content: `${interaction.user}, you have entered the giveaway! Good luck!`, ephemeral: true });
                }
            }

            if (interaction.customId.startsWith('poll_')) {
                await handlePollVote(interaction);
            }

            return;
        }

        if (!interaction.isChatInputCommand()) return;
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        const command = client.commands.get(interaction.commandName);

        if (!command) {
            console.error(`No command matching ${interaction.commandName} was found.`);
            await logCommandMetric(interaction, false, 'unknown_command');
            return;
        }

        const policy = getPolicyDecision(interaction, guildSettings);
        if (!policy.allowed) {
            await logCommandMetric(interaction, false, 'policy_denied');
            return interaction.reply({ content: policy.reason, ephemeral: true });
        }

        const { cooldowns } = client;

        if (!cooldowns.has(command.data.name)) {
            cooldowns.set(command.data.name, new Map());
        }

        const now = Date.now();
        const timestamps = cooldowns.get(command.data.name);
        const cooldownAmount = getCooldownSeconds(command, interaction, guildSettings) * 1000;

        if (timestamps.has(interaction.user.id)) {
            const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;

            if (now < expirationTime) {
                const expiredTimestamp = Math.round(expirationTime / 1000);
                return interaction.reply({
                    content: `Please wait, you are on cooldown. You can use \`/${command.data.name}\` again <t:${expiredTimestamp}:R>.`,
                    ephemeral: true
                });
            }
        }

        timestamps.set(interaction.user.id, now);
        setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

        try {
            await command.execute(interaction, client);
            await logCommandMetric(interaction, true);

            // Quest: track command usage (fire-and-forget)
            trackQuestCommandUse(interaction).catch(console.error);
        } catch (error) {
            console.error(`Error executing ${interaction.commandName}:`, error);
            await logCommandMetric(interaction, false, error.name || 'execution_error');
            const errorMessage = { content: 'There was an error while executing this command!', ephemeral: true };
            
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(errorMessage);
            } else {
                await interaction.reply(errorMessage);
            }
        }
    }
};
