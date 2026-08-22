const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { closeCase, getCase } = require('../../services/caseService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('closecase')
        .setDescription('Close a moderation case')
        .addIntegerOption(o =>
            o.setName('case_id').setDescription('Case ID to close').setRequired(true).setMinValue(1))
        .addStringOption(o =>
            o.setName('resolution').setDescription('Resolution / closing note').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    // Re-checked inside the gate in events/interactionCreate — the builder line
    // above is only Discord's default, which a guild admin can reassign.
    requiredPermissions: [PermissionFlagsBits.ModerateMembers],
    async execute(interaction) {
        const caseId = interaction.options.getInteger('case_id');
        const resolution = interaction.options.getString('resolution') ?? 'Closed by moderator.';

        const modCase = await getCase(interaction.guild.id, caseId);
        if (!modCase) {
            return interaction.reply({ content: `Case #${caseId} not found.`, flags: MessageFlags.Ephemeral });
        }
        if (modCase.status === 'closed') {
            return interaction.reply({ content: `Case #${caseId} is already closed.`, flags: MessageFlags.Ephemeral });
        }

        await closeCase(interaction.guild.id, caseId, interaction.user.id, resolution);

        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle(`Case #${caseId} Closed`)
            .addFields(
                { name: 'Target', value: `<@${modCase.targetUserId}>`, inline: true },
                { name: 'Closed By', value: interaction.user.globalName ?? interaction.user.username, inline: true },
                { name: 'Resolution', value: resolution }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};
