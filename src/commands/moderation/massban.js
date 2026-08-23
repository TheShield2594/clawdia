const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { logModeration } = require('../../services/moderationLogService');
const { hierarchyDenial, resolveMembers } = require('../../utils/moderationHierarchy');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('massban')
        .setDescription('Ban multiple users by ID — useful for raid cleanup')
        .addStringOption(o =>
            o.setName('user_ids')
                .setDescription('Space or comma-separated list of user IDs')
                .setRequired(true))
        .addStringOption(o =>
            o.setName('reason')
                .setDescription('Reason applied to all bans')
                .setMaxLength(1024)
                .setRequired(false))
        .addIntegerOption(o =>
            o.setName('delete_days')
                .setDescription('Days of messages to delete per user (0–7)')
                .setMinValue(0)
                .setMaxValue(7)
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers | PermissionFlagsBits.ManageGuild),

    // Re-checked inside the gate in events/interactionCreate — the builder line
    // above is only Discord's default, which a guild admin can reassign.
    requiredPermissions: [PermissionFlagsBits.BanMembers, PermissionFlagsBits.ManageGuild],
    async execute(interaction) {
        await interaction.deferReply();

        const raw        = interaction.options.getString('user_ids');
        const reason     = interaction.options.getString('reason') || 'Mass ban';
        const deleteDays = interaction.options.getInteger('delete_days') ?? 0;

        const ids = [...new Set(raw.split(/[\s,]+/).filter(id => /^\d{17,20}$/.test(id)))];

        if (ids.length === 0) {
            return interaction.editReply('No valid user IDs found. Provide 17–20 digit Discord IDs.');
        }
        if (ids.length > 50) {
            return interaction.editReply('Maximum 50 users per mass ban. Split into multiple calls if needed.');
        }

        // One resolution pass for the whole batch: the member cache holds at most
        // 200 per guild, so reading it alone would leave most of these ids
        // looking like non-members and skip both checks below.
        const { members, indeterminate } = await resolveMembers(interaction.guild, ids);

        const succeeded  = [];
        const failed     = [];
        const refused    = [];
        const unverified = [];

        for (const userId of ids) {
            if (userId === interaction.user.id || userId === interaction.client.user.id) {
                failed.push(userId);
                continue;
            }

            // The single-target commands run these two checks; this one looped
            // guild.members.ban() over raw IDs with neither, which made it the
            // way around the hierarchy rule the others enforce. IDs belonging to
            // nobody in the guild — the raid cleanup this command exists for —
            // have no member to check and fall straight through.
            // Unsettled, not confirmed absent — banning here would skip both
            // checks below on someone who may outrank the moderator.
            if (indeterminate.has(userId)) {
                unverified.push(userId);
                continue;
            }

            const member = members.get(userId);
            if (member && !member.bannable) {
                refused.push(userId);
                continue;
            }
            if (hierarchyDenial(interaction.member, member, 'ban')) {
                refused.push(userId);
                continue;
            }

            try {
                await interaction.guild.members.ban(userId, {
                    deleteMessageSeconds: deleteDays * 86400,
                    reason: `[MassBan] ${reason}`
                });
                succeeded.push(userId);

                const fetchedUser = await interaction.client.users.fetch(userId).catch(() => ({ id: userId, globalName: null, username: userId }));
                await logModeration(interaction.guild.id, 'ban', fetchedUser, interaction.user, `[MassBan] ${reason}`);
            } catch {
                failed.push(userId);
            }
        }

        const embed = new EmbedBuilder()
            .setColor(failed.length === 0 && refused.length === 0 && unverified.length === 0 ? '#ff0000' : '#ff9900')
            .setTitle('Mass Ban Complete')
            .addFields(
                { name: 'Banned', value: `${succeeded.length} user(s)`, inline: true },
                { name: 'Failed', value: `${failed.length} user(s)`, inline: true },
                { name: 'Reason', value: reason.slice(0, 1024) }
            )
            .setTimestamp();

        if (failed.length > 0) {
            embed.addFields({ name: 'Failed IDs', value: failed.slice(0, 20).join(', ') });
        }

        // Reported apart from failures: these did not error, they were declined,
        // and a moderator who cannot tell the two apart will just retry them.
        if (refused.length > 0) {
            embed.addFields({
                name: 'Skipped — outranks you or the bot',
                value: refused.slice(0, 20).join(', ')
            });
        }

        // These are the ones worth retrying: nothing was decided about them.
        if (unverified.length > 0) {
            embed.addFields({
                name: 'Skipped — could not be looked up, try again',
                value: unverified.slice(0, 20).join(', ')
            });
        }

        await interaction.editReply({ embeds: [embed] });
    }
};
