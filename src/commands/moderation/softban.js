const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { logModeration } = require('../../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('softban')
        .setDescription('Ban then immediately unban a member to purge their recent messages')
        .addUserOption(o =>
            o.setName('user')
                .setDescription('The member to softban')
                .setRequired(true))
        .addStringOption(o =>
            o.setName('reason')
                .setDescription('Reason for the softban')
                .setRequired(false))
        .addIntegerOption(o =>
            o.setName('delete_days')
                .setDescription('Days of messages to delete (1–7, default 1)')
                .setMinValue(1)
                .setMaxValue(7)
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

    async execute(interaction) {
        const user       = interaction.options.getUser('user');
        const reason     = interaction.options.getString('reason') || 'No reason provided';
        const deleteDays = interaction.options.getInteger('delete_days') ?? 1;

        if (user.id === interaction.user.id) {
            return interaction.reply({ content: 'You cannot softban yourself.', ephemeral: true });
        }
        if (user.id === interaction.client.user.id) {
            return interaction.reply({ content: 'I cannot softban myself.', ephemeral: true });
        }

        const member = interaction.guild.members.cache.get(user.id);
        if (member && !member.bannable) {
            return interaction.reply({ content: 'I cannot ban this user — they may have higher permissions.', ephemeral: true });
        }

        try {
            await interaction.guild.members.ban(user, {
                deleteMessageSeconds: deleteDays * 86400,
                reason: `[Softban] ${reason}`
            });
        } catch (error) {
            console.error('Softban (ban step) error:', error);
            return interaction.reply({ content: 'Failed to ban the user.', ephemeral: true });
        }

        try {
            await interaction.guild.members.unban(user.id, `[Softban] Auto-unban after message purge`);
        } catch (error) {
            console.error('Softban (unban step) error:', error);
        }

        const embed = new EmbedBuilder()
            .setColor('#ff9900')
            .setTitle('User Softbanned')
            .setDescription(`**${user.tag}** has been softbanned — their last ${deleteDays} day(s) of messages were removed and they may rejoin.`)
            .addFields(
                { name: 'Reason', value: reason },
                { name: 'Messages Deleted', value: `${deleteDays} day(s)` },
                { name: 'Moderator', value: interaction.user.tag }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        await logModeration(interaction.guild.id, 'ban', user, interaction.user, `[Softban] ${reason}`);
    }
};
