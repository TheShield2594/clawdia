const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('vc')
        .setDescription('Manage your temporary voice channel')
        .addSubcommand(sub =>
            sub.setName('rename')
                .setDescription('Rename your temp voice channel')
                .addStringOption(o =>
                    o.setName('name')
                        .setDescription('New channel name')
                        .setRequired(true)
                        .setMaxLength(100)))
        .addSubcommand(sub =>
            sub.setName('limit')
                .setDescription('Set the user limit for your temp voice channel (0 = unlimited)')
                .addIntegerOption(o =>
                    o.setName('limit')
                        .setDescription('Max users (0–99)')
                        .setRequired(true)
                        .setMinValue(0)
                        .setMaxValue(99)))
        .addSubcommand(sub =>
            sub.setName('lock')
                .setDescription('Lock your temp voice channel — only you can invite others'))
        .addSubcommand(sub =>
            sub.setName('unlock')
                .setDescription('Unlock your temp voice channel so anyone can join')),

    async execute(interaction) {
        const sub           = interaction.options.getSubcommand();
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        if (!guildSettings?.tempVoice?.enabled) {
            return interaction.reply({ content: 'Temporary voice channels are not enabled on this server.', ephemeral: true });
        }

        const member = await interaction.guild.members.fetch(interaction.user.id);
        const voiceChannel = member.voice?.channel;

        if (!voiceChannel) {
            return interaction.reply({ content: 'You must be in a voice channel to use this command.', ephemeral: true });
        }

        if (!(guildSettings.tempVoice.activeChannels ?? []).includes(voiceChannel.id)) {
            return interaction.reply({ content: 'You must be in your own temporary voice channel to use this command.', ephemeral: true });
        }

        const overwrite = voiceChannel.permissionOverwrites.cache.get(interaction.user.id);
        if (!overwrite?.allow.has(PermissionFlagsBits.ManageChannels)) {
            return interaction.reply({ content: 'This is not your temporary voice channel.', ephemeral: true });
        }

        try {
            if (sub === 'rename') {
                const name = interaction.options.getString('name');
                await voiceChannel.setName(name);
                return interaction.reply({ content: `Your channel has been renamed to **${name}**.`, ephemeral: true });
            }

            if (sub === 'limit') {
                const limit = interaction.options.getInteger('limit');
                await voiceChannel.setUserLimit(limit);
                return interaction.reply({
                    content: limit === 0
                        ? 'User limit removed — anyone can join.'
                        : `User limit set to **${limit}**.`,
                    ephemeral: true
                });
            }

            if (sub === 'lock') {
                await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: false });
                return interaction.reply({ content: 'Your channel is now **locked**. Only users you invite can join.', ephemeral: true });
            }

            if (sub === 'unlock') {
                await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: null });
                return interaction.reply({ content: 'Your channel is now **unlocked**. Anyone can join.', ephemeral: true });
            }
        } catch (error) {
            console.error('VC command error:', error);
            await interaction.reply({ content: 'Failed to update your voice channel.', ephemeral: true });
        }
    }
};
