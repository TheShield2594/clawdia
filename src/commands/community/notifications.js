const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../models/User');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('notifications')
        .setDescription('Manage your personal notification preferences.')
        .addSubcommand(sub => sub
            .setName('leaderboard')
            .setDescription('Toggle leaderboard rivalry DM notifications.')
            .addStringOption(opt => opt
                .setName('type')
                .setDescription('Which notification to toggle')
                .setRequired(true)
                .addChoices(
                    { name: 'Overtaken — when someone passes your rank (default: on)', value: 'overtaken' },
                    { name: 'Climbed — when you hit a major rank milestone (default: off)', value: 'climbed' }
                ))
            .addStringOption(opt => opt
                .setName('value')
                .setDescription('Turn the notification on or off')
                .setRequired(true)
                .addChoices(
                    { name: 'On', value: 'on' },
                    { name: 'Off', value: 'off' }
                ))
        )
        .addSubcommand(sub => sub
            .setName('pets')
            .setDescription('Toggle DMs when a pet gets hungry or is about to run away (default: on).')
            .addStringOption(opt => opt
                .setName('value')
                .setDescription('Turn the notification on or off')
                .setRequired(true)
                .addChoices(
                    { name: 'On', value: 'on' },
                    { name: 'Off', value: 'off' }
                ))
        ),
    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'pets') {
            const value = interaction.options.getString('value') === 'on';
            await User.updateOne(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $set: { 'notifications.pets.hunger': value } },
                { upsert: true }
            );
            const embed = new EmbedBuilder()
                .setColor(value ? '#57f287' : '#ed4245')
                .setTitle(`${value ? '✅' : '🔕'} Pet Notifications Updated`)
                .setDescription(`**Pet hunger DMs** have been **${value ? 'enabled' : 'disabled'}** for this server.`)
                .addFields({
                    name: 'What this means',
                    value: value
                        ? 'You will get a DM when a pet\'s passive switches off from hunger, and another when it runs out of food and is about to run away.'
                        : 'You will no longer be warned before a hungry pet runs away. `/pet vacation` still pauses hunger while you are away.'
                })
                .setFooter({ text: 'Use /notifications pets to change this at any time.' });
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        if (sub === 'leaderboard') {
            const type = interaction.options.getString('type');
            const value = interaction.options.getString('value') === 'on';
            const field = `notifications.leaderboard.${type}`;

            await User.updateOne(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $set: { [field]: value } },
                { upsert: true }
            );

            const label = type === 'overtaken'
                ? 'Overtaken notifications'
                : 'Climbed notifications';
            const status = value ? 'enabled' : 'disabled';
            const icon = value ? '✅' : '🔕';

            const embed = new EmbedBuilder()
                .setColor(value ? '#57f287' : '#ed4245')
                .setTitle(`${icon} Leaderboard Notifications Updated`)
                .setDescription(`**${label}** have been **${status}** for this server.`)
                .addFields({
                    name: 'What this means',
                    value: type === 'overtaken'
                        ? value
                            ? 'You will receive a DM when someone passes your rank on the leaderboard.'
                            : 'You will no longer be notified when someone passes your rank.'
                        : value
                            ? 'You will receive a DM when you reach a major rank milestone (top 100, 50, or 10).'
                            : 'You will no longer be notified when you reach a major rank milestone.'
                })
                .setFooter({ text: 'Use /notifications leaderboard to change this at any time.' });

            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
    }
};
