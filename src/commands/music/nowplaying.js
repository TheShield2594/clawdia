const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('nowplaying')
        .setDescription('Show the currently playing song'),
    async execute(interaction, client) {
        const queue = client.musicQueues.get(interaction.guild.id);

        if (!queue || !queue.playing) {
            return interaction.reply({ content: 'There is no song playing!', ephemeral: true });
        }

        const song = queue.songs[0];

        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('🎵 Now Playing')
            .setDescription(`[${song.title}](${song.url})`)
            .setThumbnail(song.thumbnail)
            .addFields(
                { name: 'Requested by', value: song.requester.tag, inline: true },
                { name: 'Songs in Queue', value: (queue.songs.length - 1).toString(), inline: true }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};