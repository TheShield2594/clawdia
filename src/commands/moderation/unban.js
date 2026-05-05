const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { logModeration } = require('../../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unban')
        .setDescription('Unban a user from the server')
        .addStringOption(o =>
            o.setName('user_id')
                .setDescription('The user ID to unban')
                .setRequired(true))
        .addStringOption(o =>
            o.setName('reason')
                .setDescription('Reason for the unban')
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

    async execute(interaction) {
        const userId = interaction.options.getString('user_id').trim();
        const reason = interaction.options.getString('reason') || 'No reason provided';

        if (!/^\d{17,20}$/.test(userId)) {
            return interaction.reply({ content: 'Invalid user ID. Provide a valid Discord user ID (17–20 digits).', ephemeral: true });
        }

        try {
            const ban = await interaction.guild.bans.fetch(userId).catch(() => null);
            if (!ban) {
                return interaction.reply({ content: 'That user is not banned.', ephemeral: true });
            }

            await interaction.guild.members.unban(userId, reason);

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('User Unbanned')
                .setDescription(`**${ban.user.tag}** has been unbanned.`)
                .addFields(
                    { name: 'Reason', value: reason },
                    { name: 'Moderator', value: interaction.user.tag }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
            await logModeration(interaction.guild.id, 'unban', ban.user, interaction.user, reason);
        } catch (error) {
            console.error('Unban error:', error);
            await interaction.reply({ content: 'Failed to unban the user.', ephemeral: true });
        }
    }
};
