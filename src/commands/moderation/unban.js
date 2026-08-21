const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
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
                .setMaxLength(1024)
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

    // Re-checked inside the gate in events/interactionCreate — the builder line
    // above is only Discord's default, which a guild admin can reassign.
    requiredPermissions: [PermissionFlagsBits.BanMembers],
    async execute(interaction) {
        const userId = interaction.options.getString('user_id').trim();
        const reason = interaction.options.getString('reason') || 'No reason provided';

        if (!/^\d{17,20}$/.test(userId)) {
            return interaction.reply({ content: 'Invalid user ID. Provide a valid Discord user ID (17–20 digits).', flags: MessageFlags.Ephemeral });
        }

        try {
            const ban = await interaction.guild.bans.fetch(userId).catch(() => null);
            if (!ban) {
                return interaction.reply({ content: 'That user is not banned.', flags: MessageFlags.Ephemeral });
            }

            await interaction.guild.members.unban(userId, reason);

            const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setTitle('User Unbanned')
                .setDescription(`**${ban.user.globalName ?? ban.user.username}** has been unbanned.`)
                .addFields(
                    { name: 'Reason', value: reason },
                    { name: 'Moderator', value: interaction.user.globalName ?? interaction.user.username }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
            await logModeration(interaction.guild.id, 'unban', ban.user, interaction.user, reason).catch(err => {
                console.error('Unban log error:', err);
                if (interaction.replied || interaction.deferred) {
                    interaction.followUp({ content: 'Unban succeeded, but failed to log the action.', flags: MessageFlags.Ephemeral }).catch(() => {});
                }
            });
        } catch (error) {
            console.error('Unban error:', error);
            await interaction.reply({ content: 'Failed to unban the user.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    }
};
