const Guild = require('../models/Guild');
const { closeTicket } = require('../commands/moderation/ticket');
const { handlePollVote } = require('../commands/utility/poll');
async function logCommandMetric(interaction, success, reason = null) {
    try {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (!guildSettings) return;
        guildSettings.analytics = guildSettings.analytics || {};
        guildSettings.analytics.commandUsage = guildSettings.analytics.commandUsage || [];
        guildSettings.analytics.commandUsage.push({
            command: interaction.commandName,
            channelId: interaction.channelId || null,
            hour: new Date().getUTCHours(),
            success,
            reason
        });
        guildSettings.analytics.commandUsage = guildSettings.analytics.commandUsage.slice(-3000);
        await guildSettings.save();
    } catch (error) {
        console.error('Command metric error:', error);
    }
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

        const command = client.commands.get(interaction.commandName);

        if (!command) {
            console.error(`No command matching ${interaction.commandName} was found.`);
            await logCommandMetric(interaction, false, 'unknown_command');
            return;
        }

        const { cooldowns } = client;

        if (!cooldowns.has(command.data.name)) {
            cooldowns.set(command.data.name, new Map());
        }

        const now = Date.now();
        const timestamps = cooldowns.get(command.data.name);
        const defaultCooldownDuration = 3;
        const cooldownAmount = (command.cooldown ?? defaultCooldownDuration) * 1000;

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
