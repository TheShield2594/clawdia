const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { logModeration } = require('../../services/moderationLogService');
const { hierarchyDenial, resolveMember } = require('../../utils/moderationHierarchy');
const COLORS = require('../../utils/embedColors');

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

    // Re-checked inside the gate in events/interactionCreate — the builder line
    // above is only Discord's default, which a guild admin can reassign.
    requiredPermissions: [PermissionFlagsBits.BanMembers],
    async execute(interaction) {
        const user       = interaction.options.getUser('user');
        const reason     = interaction.options.getString('reason') || 'No reason provided';
        const deleteDays = interaction.options.getInteger('delete_days') ?? 1;

        if (user.id === interaction.user.id) {
            return interaction.reply({ content: 'You cannot softban yourself.', flags: MessageFlags.Ephemeral });
        }
        if (user.id === interaction.client.user.id) {
            return interaction.reply({ content: 'I cannot softban myself.', flags: MessageFlags.Ephemeral });
        }

        const { member, indeterminate } = await resolveMember(interaction.guild, user.id);
        // Not the same as "not in the guild": we could not find out. Proceeding
        // would skip both checks below on a target who may well outrank you.
        if (indeterminate) {
            return interaction.reply({
                content: 'I could not look this user up just now, so I have not softbanned them. Try again in a moment.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (member && !member.bannable) {
            return interaction.reply({ content: 'I cannot ban this user — they may have higher permissions.', flags: MessageFlags.Ephemeral });
        }

        // `bannable` above answered whether the bot outranks the target. This
        // answers whether the moderator does.
        const denial = hierarchyDenial(interaction.member, member, 'softban');
        if (denial) {
            return interaction.reply({ content: denial, flags: MessageFlags.Ephemeral });
        }

        try {
            await interaction.guild.members.ban(user, {
                deleteMessageSeconds: deleteDays * 86400,
                reason: `[Softban] ${reason}`
            });
        } catch (error) {
            console.error('Softban (ban step) error:', error);
            return interaction.reply({ content: 'Failed to ban the user.', flags: MessageFlags.Ephemeral });
        }

        try {
            await interaction.guild.members.unban(user.id, `[Softban] Auto-unban after message purge`);
        } catch (error) {
            console.error('Softban (unban step) error:', error);
        }

        const embed = new EmbedBuilder()
            .setColor(COLORS.WARN)
            .setTitle('User Softbanned')
            .setDescription(`**${user.globalName ?? user.username}** has been softbanned — their last ${deleteDays} day(s) of messages were removed and they may rejoin.`)
            .addFields(
                { name: 'Reason', value: reason },
                { name: 'Messages Deleted', value: `${deleteDays} day(s)` },
                { name: 'Moderator', value: interaction.user.globalName ?? interaction.user.username }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        await logModeration(interaction.guild.id, 'ban', user, interaction.user, `[Softban] ${reason}`);
    }
};
