const { SlashCommandBuilder } = require('discord.js');
const { checkDjPermission } = require('../../utils/musicPermissions');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Skip the current song'),
    async execute(interaction, client) {
        const member = interaction.member;

        if (!member.voice.channel) {
            return interaction.reply({ content: 'You need to be in a voice channel!', ephemeral: true });
        }

        if (!await checkDjPermission(interaction)) {
            return interaction.reply({ content: 'You need the DJ role to use music commands!', ephemeral: true });
        }

        const queue = client.musicQueues.get(interaction.guild.id);

        if (!queue || !queue.playing) {
            return interaction.reply({ content: 'There is no song playing!', ephemeral: true });
        }

        queue.player.stop();
        await interaction.reply('⏭️ Skipped the current song!');
    }
};