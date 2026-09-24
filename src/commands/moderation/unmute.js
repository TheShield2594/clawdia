const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { logModeration } = require('../../services/moderationLogService');
const { hierarchyDenial, resolveMember } = require('../../utils/moderationHierarchy');
const { sendPublicResponse, sendEphemeralResponse } = require('../../utils/interactionAck');
const COLORS = require('../../utils/embedColors');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unmute')
        .setDescription('Remove timeout from a member')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to unmute')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    // Re-checked inside the gate in events/interactionCreate — the builder line
    // above is only Discord's default, which a guild admin can reassign.
    requiredPermissions: [PermissionFlagsBits.ModerateMembers],

    // See mute.js: resolveMember can fetch from the gateway on a cache miss.
    deferral: { ephemeral: false },
    async execute(interaction) {
        const user = interaction.options.getUser('user');
        // The cache is a recently-seen sample, not a roster, and a timed-out
        // member has usually been quiet: reading the cache alone made /unmute
        // fail for most of the people it exists for (#1154).
        const { member, indeterminate } = await resolveMember(interaction.guild, user.id);

        if (indeterminate) {
            return sendEphemeralResponse(interaction, { content: 'Could not look that member up just now — try again in a moment.' });
        }

        if (!member) {
            return sendEphemeralResponse(interaction, { content: 'User not found!' });
        }

        if (!member.moderatable) {
            return sendEphemeralResponse(interaction, { content: 'I cannot unmute this user!' });
        }

        // Lifting a timeout undoes another moderator's decision, so it takes the
        // same rank as applying one: a trial moderator cannot release someone a
        // senior muted by un-muting a member who outranks them (#1154).
        const denial = hierarchyDenial(interaction.member, member, 'unmute');
        if (denial) {
            return sendEphemeralResponse(interaction, { content: denial });
        }

        try {
            await member.timeout(null);

            const embed = new EmbedBuilder()
                .setColor(COLORS.SUCCESS)
                .setTitle('User Unmuted')
                .setDescription(`**${user.globalName ?? user.username}** has been unmuted.`)
                .setTimestamp();

            await sendPublicResponse(interaction, { embeds: [embed] });
            await logModeration(interaction.guild.id, 'unmute', user, interaction.user, 'No reason provided');
        } catch (error) {
            console.error('Unmute error:', error);
            await sendEphemeralResponse(interaction, { content: 'Failed to unmute the user.' }).catch(() => {});
        }
    }
};
