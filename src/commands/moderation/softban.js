const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { logModeration } = require('../../services/moderationLogService');
const { hierarchyDenial, resolveMember } = require('../../utils/moderationHierarchy');
const { sendPublicResponse, sendEphemeralResponse } = require('../../utils/interactionAck');
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

    // Acknowledged up front by the dispatcher (#995): resolveMember below can
    // miss the member cache and fetch from the gateway, which can outrun
    // Discord's three-second window. Public deferral keeps the success embed in
    // the channel; refusals go out ephemerally via sendEphemeralResponse.
    deferral: { ephemeral: false },
    async execute(interaction) {
        const user       = interaction.options.getUser('user');
        const reason     = interaction.options.getString('reason') || 'No reason provided';
        const deleteDays = interaction.options.getInteger('delete_days') ?? 1;

        if (user.id === interaction.user.id) {
            return sendEphemeralResponse(interaction, { content: 'You cannot softban yourself.' });
        }
        if (user.id === interaction.client.user.id) {
            return sendEphemeralResponse(interaction, { content: 'I cannot softban myself.' });
        }

        const { member, indeterminate } = await resolveMember(interaction.guild, user.id);
        // Not the same as "not in the guild": we could not find out. Proceeding
        // would skip both checks below on a target who may well outrank you.
        if (indeterminate) {
            return sendEphemeralResponse(interaction, {
                content: 'I could not look this user up just now, so I have not softbanned them. Try again in a moment.',
            });
        }

        if (member && !member.bannable) {
            return sendEphemeralResponse(interaction, { content: 'I cannot ban this user — they may have higher permissions.' });
        }

        // `bannable` above answered whether the bot outranks the target. This
        // answers whether the moderator does.
        const denial = hierarchyDenial(interaction.member, member, 'softban');
        if (denial) {
            return sendEphemeralResponse(interaction, { content: denial });
        }

        try {
            await interaction.guild.members.ban(user, {
                deleteMessageSeconds: deleteDays * 86400,
                reason: `[Softban] ${reason}`
            });
        } catch (error) {
            console.error('Softban (ban step) error:', error);
            return sendEphemeralResponse(interaction, { content: 'Failed to ban the user.' });
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

        await sendPublicResponse(interaction, { embeds: [embed] });
        await logModeration(interaction.guild.id, 'ban', user, interaction.user, `[Softban] ${reason}`);
    }
};
