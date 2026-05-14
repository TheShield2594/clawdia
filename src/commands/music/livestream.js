const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const { checkDjPermission } = require('../../utils/musicPermissions');
const { startLivestream, stopLivestream, isLivestreamActive } = require('../../services/livestreamService');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('livestream')
        .setDescription('Manage the 24/7 livestream for this server. Requires DJ role.')
        .addSubcommand(sub =>
            sub.setName('start')
                .setDescription('Start a YouTube livestream or 24/7 video in a stage/voice channel')
                .addStringOption(opt =>
                    opt.setName('url')
                        .setDescription('YouTube URL to stream (video or livestream)')
                        .setRequired(true))
                .addChannelOption(opt =>
                    opt.setName('channel')
                        .setDescription('Stage or voice channel to stream in')
                        .addChannelTypes(ChannelType.GuildStageVoice, ChannelType.GuildVoice)
                        .setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('stop')
                .setDescription('Stop the 24/7 livestream'))
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Show the current livestream configuration')),

    async execute(interaction, client) {
        if (!await checkDjPermission(interaction)) {
            return interaction.reply({ content: 'You need the DJ role to manage the livestream!', ephemeral: true });
        }

        const sub = interaction.options.getSubcommand();

        if (sub === 'start') {
            const url = interaction.options.getString('url');
            const channel = interaction.options.getChannel('channel');

            let parsedUrl;
            try { parsedUrl = new URL(url); } catch { parsedUrl = null; }
            const YOUTUBE_HOSTNAMES = new Set(['www.youtube.com', 'youtube.com', 'youtu.be', 'm.youtube.com']);
            if (!parsedUrl || !YOUTUBE_HOSTNAMES.has(parsedUrl.hostname)) {
                return interaction.reply({ content: 'Only YouTube URLs are supported.', ephemeral: true });
            }

            await interaction.deferReply();

            // Stop any existing livestream before reconfiguring
            stopLivestream(interaction.guild.id);

            const saved = await Guild.findOneAndUpdate(
                { guildId: interaction.guild.id },
                {
                    'music.livestream.enabled': true,
                    'music.livestream.url': url,
                    'music.livestream.channelId': channel.id
                },
                { upsert: true, new: true }
            );

            if (!saved) {
                return interaction.editReply('Failed to save livestream settings. Please try again.');
            }

            await startLivestream(client, interaction.guild.id);

            const embed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('📡 Livestream Started')
                .addFields(
                    { name: 'Channel', value: `<#${channel.id}>`, inline: true },
                    { name: 'URL', value: url, inline: false }
                )
                .setFooter({ text: 'The stream will auto-resume after bot restarts and when the music queue ends.' })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

        } else if (sub === 'stop') {
            stopLivestream(interaction.guild.id);

            await Guild.findOneAndUpdate(
                { guildId: interaction.guild.id },
                { 'music.livestream.enabled': false }
            );

            await interaction.reply('📴 Livestream stopped and disabled.');

        } else if (sub === 'status') {
            const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
            const ls = guildSettings?.music?.livestream;

            const embed = new EmbedBuilder()
                .setColor(isLivestreamActive(interaction.guild.id) ? '#00ff00' : '#888888')
                .setTitle('📡 Livestream Status');

            if (!ls?.url) {
                embed.setDescription('No livestream configured. Use `/livestream start` to set one up.');
            } else {
                const channelMention = ls.channelId ? `<#${ls.channelId}>` : 'Unknown';
                embed.addFields(
                    { name: 'Status', value: isLivestreamActive(interaction.guild.id) ? '🟢 Active' : '🔴 Inactive', inline: true },
                    { name: 'Enabled', value: ls.enabled ? 'Yes' : 'No', inline: true },
                    { name: 'Channel', value: channelMention, inline: true },
                    { name: 'URL', value: ls.url, inline: false }
                );
            }

            await interaction.reply({ embeds: [embed] });
        }
    }
};
