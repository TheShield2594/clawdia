const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
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

    async execute(interaction) {
        const caseId = interaction.options.getInteger('case_id');
        const resolution = interaction.options.getString('resolution') ?? 'Closed by moderator.';

        const modCase = await getCase(interaction.guild.id, caseId);
        if (!modCase) {
            return interaction.reply({ content: `Case #${caseId} not found.`, ephemeral: true });
        }
        if (modCase.status === 'closed') {
            return interaction.reply({ content: `Case #${caseId} is already closed.`, ephemeral: true });
        }

        await closeCase(interaction.guild.id, caseId, interaction.user.id, resolution);

        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle(`Case #${caseId} Closed`)
            .addFields(
                { name: 'Target', value: `<@${modCase.targetUserId}>`, inline: true },
                { name: 'Closed By', value: interaction.user.tag, inline: true },
                { name: 'Resolution', value: resolution }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};
