const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const play = require('play-dl');
const { checkDjPermission } = require('../../utils/musicPermissions');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play a song or add to queue')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('Song name or URL')
                .setRequired(true)),
    async execute(interaction, client) {
        const query = interaction.options.getString('query');
        const member = interaction.member;

        if (!member.voice.channel) {
            return interaction.reply({ content: 'You need to be in a voice channel!', ephemeral: true });
        }

        if (!await checkDjPermission(interaction)) {
            return interaction.reply({ content: 'You need the DJ role to use music commands!', ephemeral: true });
        }

        await interaction.deferReply();

        try {
            let queue = client.musicQueues.get(interaction.guild.id);

            if (!queue) {
                queue = {
                    voiceChannel: member.voice.channel,
                    textChannel: interaction.channel,
                    connection: null,
                    player: createAudioPlayer(),
                    songs: [],
                    playing: false
                };
                client.musicQueues.set(interaction.guild.id, queue);
            }

            let songInfo;
            if (play.yt_validate(query) === 'video') {
                songInfo = await play.video_info(query);
            } else {
                const searched = await play.search(query, { limit: 1 });
                if (searched.length === 0) {
                    return interaction.editReply('No results found!');
                }
                songInfo = searched[0];
            }

            const song = {
                title: songInfo.title,
                url: songInfo.url,
                duration: songInfo.durationInSec,
                thumbnail: songInfo.thumbnails[0]?.url,
                requester: interaction.user
            };

            queue.songs.push(song);

            if (!queue.playing) {
                playSong(queue, client, interaction.guild);
                
                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('🎵 Now Playing')
                    .setDescription(`[${song.title}](${song.url})`)
                    .setThumbnail(song.thumbnail)
                    .addFields(
                        { name: 'Duration', value: formatDuration(song.duration), inline: true },
                        { name: 'Requested by', value: song.requester.tag, inline: true }
                    )
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed] });
            } else {
                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('➕ Added to Queue')
                    .setDescription(`[${song.title}](${song.url})`)
                    .setThumbnail(song.thumbnail)
                    .addFields(
                        { name: 'Position', value: queue.songs.length.toString(), inline: true },
                        { name: 'Duration', value: formatDuration(song.duration), inline: true }
                    )
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed] });
            }
        } catch (error) {
            console.error('Play error:', error);
            await interaction.editReply('An error occurred while trying to play the song.');
        }
    }
};

async function playSong(queue, client, guild) {
    if (queue.songs.length === 0) {
        queue.playing = false;
        if (queue.connection) {
            queue.connection.destroy();
        }
        client.musicQueues.delete(guild.id);
        return;
    }

    queue.playing = true;
    const song = queue.songs[0];

    if (!queue.connection) {
        queue.connection = joinVoiceChannel({
            channelId: queue.voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator
        });
    }

    const stream = await play.stream(song.url);
    const resource = createAudioResource(stream.stream, { inputType: stream.type });

    queue.player.play(resource);
    queue.connection.subscribe(queue.player);

    queue.player.on(AudioPlayerStatus.Idle, () => {
        queue.songs.shift();
        playSong(queue, client, guild);
    });

    queue.player.on('error', error => {
        console.error('Player error:', error);
        queue.songs.shift();
        playSong(queue, client, guild);
    });
}

function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}