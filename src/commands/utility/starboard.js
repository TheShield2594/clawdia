const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('starboard')
        .setDescription('Configure the starboard')
        .addSubcommand(sub =>
            sub.setName('setup')
                .setDescription('Enable and configure the starboard')
                .addChannelOption(o => o.setName('channel').setDescription('Starboard channel').setRequired(true))
                .addIntegerOption(o => o.setName('threshold').setDescription('Reactions needed (default 3)').setMinValue(1))
                .addStringOption(o => o.setName('emoji').setDescription('Reaction emoji to track (default ⭐)')))
        .addSubcommand(sub =>
            sub.setName('disable')
                .setDescription('Disable the starboard'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOneAndUpdate(
            { guildId: interaction.guild.id },
            { $setOnInsert: { name: interaction.guild.name } },
            { upsert: true, new: true }
        );

        if (sub === 'setup') {
            const channel = interaction.options.getChannel('channel');
            const threshold = interaction.options.getInteger('threshold') ?? 3;
            const emoji = interaction.options.getString('emoji') ?? '⭐';

            guildSettings.starboard.enabled = true;
            guildSettings.starboard.channelId = channel.id;
            guildSettings.starboard.threshold = threshold;
            guildSettings.starboard.emoji = emoji;
            await guildSettings.save();

            const embed = new EmbedBuilder()
                .setColor('#FFD700')
                .setTitle('Starboard Configured')
                .addFields(
                    { name: 'Channel', value: channel.toString(), inline: true },
                    { name: 'Emoji', value: emoji, inline: true },
                    { name: 'Threshold', value: threshold.toString(), inline: true }
                );

            await interaction.reply({ embeds: [embed] });

        } else if (sub === 'disable') {
            guildSettings.starboard.enabled = false;
            await guildSettings.save();
            await interaction.reply({ content: 'Starboard disabled.' });
        }
    }
};
