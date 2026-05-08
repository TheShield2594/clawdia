const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('avatar')
        .setDescription('Fetch and display a user\'s full-size avatar image.')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User whose avatar to display (defaults to yourself).')
                .setRequired(false)),
    async execute(interaction) {
        const user = interaction.options.getUser('user') || interaction.user;

        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle(`${user.username}'s Avatar`)
            .setImage(user.displayAvatarURL({ dynamic: true, size: 1024 }))
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};