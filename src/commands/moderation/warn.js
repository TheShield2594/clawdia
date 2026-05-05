const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Case = require('../../models/Case');
const { logModeration } = require('../../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Manage member warnings')
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Issue a warning to a member')
                .addUserOption(o => o.setName('user').setDescription('The user to warn').setRequired(true))
                .addStringOption(o => o.setName('reason').setDescription('Reason for the warning').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List all warnings for a member')
                .addUserOption(o => o.setName('user').setDescription('The user to look up').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove a warning by its case ID')
                .addIntegerOption(o => o.setName('case_id').setDescription('The case ID of the warning to remove').setRequired(true).setMinValue(1)))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'add') {
            const user   = interaction.options.getUser('user');
            const reason = interaction.options.getString('reason');

            if (user.bot) return interaction.reply({ content: 'You cannot warn bots.', ephemeral: true });

            try {
                await logModeration(interaction.guild.id, 'warn', user, interaction.user, reason);

                const warningCount = await Case.countDocuments({
                    guildId: interaction.guild.id,
                    targetUserId: user.id,
                    type: 'warn'
                });

                const embed = new EmbedBuilder()
                    .setColor('#ffff00')
                    .setTitle('User Warned')
                    .setDescription(`**${user.tag}** has been warned.`)
                    .addFields(
                        { name: 'Reason', value: reason },
                        { name: 'Total Warnings', value: warningCount.toString() },
                        { name: 'Moderator', value: interaction.user.tag }
                    )
                    .setTimestamp();

                await interaction.reply({ embeds: [embed] });
                await user.send(`You have been warned in **${interaction.guild.name}** for: ${reason}`).catch(() => {});
            } catch (error) {
                console.error('Warn error:', error);
                if (!interaction.replied) {
                    await interaction.reply({ content: 'Failed to warn the user.', ephemeral: true });
                }
            }
        }

        if (sub === 'list') {
            const user = interaction.options.getUser('user');

            try {
                const warnings = await Case.find({
                    guildId: interaction.guild.id,
                    targetUserId: user.id,
                    type: 'warn'
                }).sort({ createdAt: -1 }).limit(20);

                if (!warnings.length) {
                    return interaction.reply({ content: `${user.tag} has no warnings.`, ephemeral: true });
                }

                const lines = warnings.map(w => {
                    const date = w.createdAt.toISOString().slice(0, 10);
                    return `**#${w.caseId}** \`${date}\` — ${w.reason}`;
                });

                const embed = new EmbedBuilder()
                    .setColor('#ffff00')
                    .setTitle(`Warnings for ${user.tag}`)
                    .setDescription(lines.join('\n'))
                    .setFooter({ text: `${warnings.length} warning(s) shown · use /warn remove <case_id> to clear one` })
                    .setTimestamp();

                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Warn list error:', error);
                if (!interaction.replied) {
                    await interaction.reply({ content: 'Failed to fetch warnings.', ephemeral: true });
                }
            }
        }

        if (sub === 'remove') {
            const caseId = interaction.options.getInteger('case_id');

            try {
                const warnCase = await Case.findOne({
                    guildId: interaction.guild.id,
                    caseId,
                    type: 'warn'
                });

                if (!warnCase) {
                    return interaction.reply({ content: `Warning case #${caseId} not found in this server.`, ephemeral: true });
                }

                await Case.deleteOne({ _id: warnCase._id });

                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Warning Removed')
                    .setDescription(`Case **#${caseId}** has been deleted.`)
                    .addFields(
                        { name: 'Original Reason', value: warnCase.reason },
                        { name: 'Removed by', value: interaction.user.tag }
                    )
                    .setTimestamp();

                await interaction.reply({ embeds: [embed] });
            } catch (error) {
                console.error('Warn remove error:', error);
                if (!interaction.replied) {
                    await interaction.reply({ content: 'Failed to remove the warning.', ephemeral: true });
                }
            }
        }
    }
};
