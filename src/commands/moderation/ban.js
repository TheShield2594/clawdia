const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { logModeration } = require('../../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban a member from the server')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to ban')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for the ban')
                .setRequired(false))
        .addIntegerOption(option =>
            option.setName('delete_days')
                .setDescription('Delete messages from the last X days (0-7)')
                .setMinValue(0)
                .setMaxValue(7)
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    async execute(interaction) {
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const deleteDays = interaction.options.getInteger('delete_days') || 0;

        if (user.id === interaction.user.id) {
            return interaction.reply({ content: 'You cannot ban yourself!', ephemeral: true });
        }

        if (user.id === interaction.client.user.id) {
            return interaction.reply({ content: 'I cannot ban myself!', ephemeral: true });
        }

        const member = interaction.guild.members.cache.get(user.id);
        
        if (member && !member.bannable) {
            return interaction.reply({ content: 'I cannot ban this user! They may have higher permissions.', ephemeral: true });
        }

        try {
            await interaction.guild.members.ban(user, { deleteMessageSeconds: deleteDays * 86400, reason });

            const embed = new EmbedBuilder()
                .setColor('#ff0000')
                .setTitle('User Banned')
                .setDescription(`**${user.tag}** has been banned from the server.`)
                .addFields(
                    { name: 'Reason', value: reason },
                    { name: 'Moderator', value: interaction.user.tag }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
            await logModeration(interaction.guild.id, 'ban', user, interaction.user, reason);
        } catch (error) {
            console.error('Ban error:', error);
            await interaction.reply({ content: 'Failed to ban the user.', ephemeral: true });
        }
    }
};