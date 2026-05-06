const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('slowmode')
        .setDescription('Set or clear the slowmode for a channel')
        .addIntegerOption(o =>
            o.setName('seconds')
                .setDescription('Cooldown in seconds (0 to disable, max 21600)')
                .setRequired(true)
                .setMinValue(0)
                .setMaxValue(21600))
        .addChannelOption(o =>
            o.setName('channel')
                .setDescription('Channel to apply slowmode to (defaults to current channel)')
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        const seconds = interaction.options.getInteger('seconds');
        const channel = interaction.options.getChannel('channel') ?? interaction.channel;

        if (!channel.isTextBased()) {
            return interaction.reply({ content: 'Slowmode can only be set on text channels.', ephemeral: true });
        }

        try {
            await channel.setRateLimitPerUser(seconds, `Set by ${interaction.user.tag}`);

            const embed = new EmbedBuilder()
                .setColor(seconds === 0 ? '#00ff00' : '#ff9900')
                .setTitle(seconds === 0 ? 'Slowmode Disabled' : 'Slowmode Enabled')
                .setDescription(
                    seconds === 0
                        ? `Slowmode has been removed from ${channel}.`
                        : `${channel} now has a **${seconds}s** slowmode.`
                )
                .addFields({ name: 'Set by', value: interaction.user.tag, inline: true })
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Slowmode error:', error);
            await interaction.reply({ content: 'Failed to update slowmode.', ephemeral: true });
        }
    }
};
