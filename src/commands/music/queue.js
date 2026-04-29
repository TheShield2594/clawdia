const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('queue')
        .setDescription('View the music queue'),
    async execute(interaction, client) {
        const queue = client.musicQueues.get(interaction.guild.id);

        if (!queue || queue.songs.length === 0) {
            return interaction.reply({ content: 'The queue is empty!', ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('🎵 Music Queue')
            .setDescription(`**Now Playing:**\n[${queue.songs[0].title}](${queue.songs[0].url})\n\n**Up Next:**`)
            .setTimestamp();

        const upcoming = queue.songs.slice(1, 11).map((song, index) => {
            return `${index + 1}. [${song.title}](${song.url}) - ${song.requester.tag}`;
        }).join('\n');

        if (upcoming) {
            embed.addFields({ name: 'Queue', value: upcoming });
        }

        if (queue.songs.length > 11) {
            embed.setFooter({ text: `And ${queue.songs.length - 11} more...` });
        }

        await interaction.reply({ embeds: [embed] });
    }
};