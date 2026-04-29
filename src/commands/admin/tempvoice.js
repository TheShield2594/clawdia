const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('tempvoice')
        .setDescription('Configure temporary voice channels')
        .addSubcommand(sub =>
            sub.setName('setup')
                .setDescription('Set the lobby channel that creates temp VCs when joined')
                .addChannelOption(o => o.setName('lobby').setDescription('Voice channel to use as the lobby').setRequired(true))
                .addChannelOption(o => o.setName('category').setDescription('Category to create temp channels in (defaults to lobby category)')))
        .addSubcommand(sub =>
            sub.setName('disable')
                .setDescription('Disable temp voice channels'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOneAndUpdate(
            { guildId: interaction.guild.id },
            { $setOnInsert: { name: interaction.guild.name } },
            { upsert: true, new: true }
        );

        if (sub === 'setup') {
            const lobby = interaction.options.getChannel('lobby');
            const category = interaction.options.getChannel('category');

            if (lobby.type !== ChannelType.GuildVoice) {
                return interaction.reply({ content: 'The lobby must be a voice channel.', ephemeral: true });
            }

            guildSettings.tempVoice.enabled = true;
            guildSettings.tempVoice.lobbyChannelId = lobby.id;
            guildSettings.tempVoice.categoryId = category?.id ?? lobby.parentId ?? null;
            await guildSettings.save();

            await interaction.reply({
                content: `Temp voice enabled. Members who join ${lobby} will get their own private VC.`
            });

        } else if (sub === 'disable') {
            guildSettings.tempVoice.enabled = false;
            await guildSettings.save();
            await interaction.reply({ content: 'Temp voice channels disabled.' });
        }
    }
};
