const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop the music and clear the queue'),
    async execute(interaction, client) {
        const member = interaction.member;

        if (!member.voice.channel) {
            return interaction.reply({ content: 'You need to be in a voice channel!', ephemeral: true });
        }

        const queue = client.musicQueues.get(interaction.guild.id);

        if (!queue) {
            return interaction.reply({ content: 'There is no music playing!', ephemeral: true });
        }

        queue.songs = [];
        queue.player.stop();
        
        if (queue.connection) {
            queue.connection.destroy();
        }

        client.musicQueues.delete(interaction.guild.id);

        await interaction.reply('⏹️ Stopped the music and cleared the queue!');
    }
};