const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Delete multiple messages')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('Number of messages to delete (1-100)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    async execute(interaction) {
        const amount = interaction.options.getInteger('amount');

        try {
            await interaction.channel.bulkDelete(amount, true);
            await interaction.reply({ content: `Successfully deleted ${amount} messages.`, ephemeral: true });
        } catch (error) {
            console.error('Clear error:', error);
            await interaction.reply({ content: 'Failed to delete messages. Messages may be too old (14+ days).', ephemeral: true });
        }
    }
};