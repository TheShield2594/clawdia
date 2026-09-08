const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { logModeration } = require('../../services/moderationLogService');
const { hierarchyDenial, resolveMember } = require('../../utils/moderationHierarchy');
const COLORS = require('../../utils/embedColors');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick a member from the server')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to kick')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for the kick')
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
    // Re-checked inside the gate in events/interactionCreate — the builder line
    // above is only Discord's default, which a guild admin can reassign.
    requiredPermissions: [PermissionFlagsBits.KickMembers],
    async execute(interaction) {
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        // Not `members.cache.get`. The member cache is capped at 200 per guild
        // and swept hourly (utils/cacheOptions), so a miss says "this member has
        // been quiet", not "this member has left" -- and every quiet member was
        // unkickable with a flat "not in this server". `resolveMember` fetches,
        // and distinguishes a confirmed absence from a fetch that failed.
        const { member, indeterminate } = await resolveMember(interaction.guild, user.id);

        if (indeterminate) {
            return interaction.reply({ content: 'Could not look that member up just now — try again in a moment.', flags: MessageFlags.Ephemeral });
        }

        if (!member) {
            return interaction.reply({ content: 'User not found in this server!', flags: MessageFlags.Ephemeral });
        }

        if (user.id === interaction.user.id) {
            return interaction.reply({ content: 'You cannot kick yourself!', flags: MessageFlags.Ephemeral });
        }

        if (!member.kickable) {
            return interaction.reply({ content: 'I cannot kick this user! They may have higher permissions.', flags: MessageFlags.Ephemeral });
        }

        // `kickable` above answered whether the bot outranks the target. This
        // answers whether the moderator does.
        const denial = hierarchyDenial(interaction.member, member, 'kick');
        if (denial) {
            return interaction.reply({ content: denial, flags: MessageFlags.Ephemeral });
        }

        try {
            await member.kick(reason);

            const embed = new EmbedBuilder()
                .setColor(COLORS.WARN)
                .setTitle('User Kicked')
                .setDescription(`**${user.globalName ?? user.username}** has been kicked from the server.`)
                .addFields(
                    { name: 'Reason', value: reason },
                    { name: 'Moderator', value: interaction.user.globalName ?? interaction.user.username }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
            await logModeration(interaction.guild.id, 'kick', user, interaction.user, reason);
        } catch (error) {
            console.error('Kick error:', error);
            await interaction.reply({ content: 'Failed to kick the user.', flags: MessageFlags.Ephemeral });
        }
    }
};