const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { logModeration } = require('../../services/moderationLogService');
const { hierarchyDenial, resolveMember } = require('../../utils/moderationHierarchy');
const { sendPublicResponse, sendEphemeralResponse } = require('../../utils/interactionAck');
const COLORS = require('../../utils/embedColors');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mute')
        .setDescription('Timeout a member')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to mute')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('duration')
                .setDescription('Timeout duration in minutes (min: 1, max: 40,320 = 28 days)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(40320))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for the timeout')
                .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    // Re-checked inside the gate in events/interactionCreate — the builder line
    // above is only Discord's default, which a guild admin can reassign.
    requiredPermissions: [PermissionFlagsBits.ModerateMembers],

    // Acknowledged up front by the dispatcher (#995): resolveMember below can
    // miss the member cache and fetch from the gateway, which can outrun
    // Discord's three-second window. Public deferral keeps the success embed in
    // the channel; refusals go out ephemerally via sendEphemeralResponse.
    deferral: { ephemeral: false },
    async execute(interaction) {
        const user = interaction.options.getUser('user');
        const duration = interaction.options.getInteger('duration');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        // See kick.js: a cache miss is "quiet lately", not "gone". Muting the
        // quiet ones is most of what a timeout command is for.
        const { member, indeterminate } = await resolveMember(interaction.guild, user.id);

        if (indeterminate) {
            return sendEphemeralResponse(interaction, { content: 'Could not look that member up just now — try again in a moment.' });
        }

        if (!member) {
            return sendEphemeralResponse(interaction, { content: 'User not found!' });
        }

        if (!member.moderatable) {
            return sendEphemeralResponse(interaction, { content: 'I cannot mute this user!' });
        }

        // `moderatable` above answered whether the bot outranks the target. This
        // answers whether the moderator does.
        const denial = hierarchyDenial(interaction.member, member, 'mute');
        if (denial) {
            return sendEphemeralResponse(interaction, { content: denial });
        }

        try {
            await member.timeout(duration * 60 * 1000, reason);

            const embed = new EmbedBuilder()
                .setColor(COLORS.WARN)
                .setTitle('User Muted')
                .setDescription(`**${user.globalName ?? user.username}** has been muted.`)
                .addFields(
                    { name: 'Duration', value: `${duration} minutes` },
                    { name: 'Reason', value: reason },
                    { name: 'Moderator', value: interaction.user.globalName ?? interaction.user.username }
                )
                .setTimestamp();

            await sendPublicResponse(interaction, { embeds: [embed] });
            await logModeration(interaction.guild.id, 'mute', user, interaction.user, reason);
        } catch (error) {
            console.error('Mute error:', error);
            await sendEphemeralResponse(interaction, { content: 'Failed to mute the user.' }).catch(() => {});
        }
    }
};