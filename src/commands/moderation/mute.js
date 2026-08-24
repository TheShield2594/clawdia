const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { logModeration } = require('../../services/moderationLogService');
const { hierarchyDenial } = require('../../utils/moderationHierarchy');
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
    async execute(interaction) {
        const user = interaction.options.getUser('user');
        const duration = interaction.options.getInteger('duration');
        const reason = interaction.options.getString('reason') || 'No reason provided';
        const member = interaction.guild.members.cache.get(user.id);

        if (!member) {
            return interaction.reply({ content: 'User not found!', flags: MessageFlags.Ephemeral });
        }

        if (!member.moderatable) {
            return interaction.reply({ content: 'I cannot mute this user!', flags: MessageFlags.Ephemeral });
        }

        // `moderatable` above answered whether the bot outranks the target. This
        // answers whether the moderator does.
        const denial = hierarchyDenial(interaction.member, member, 'mute');
        if (denial) {
            return interaction.reply({ content: denial, flags: MessageFlags.Ephemeral });
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

            await interaction.reply({ embeds: [embed] });
            await logModeration(interaction.guild.id, 'mute', user, interaction.user, reason);
        } catch (error) {
            console.error('Mute error:', error);
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: 'Failed to mute the user.', flags: MessageFlags.Ephemeral }).catch(() => {});
            } else {
                await interaction.reply({ content: 'Failed to mute the user.', flags: MessageFlags.Ephemeral }).catch(() => {});
            }
        }
    }
};