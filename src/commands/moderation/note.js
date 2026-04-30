const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { addNote, getCase } = require('../../services/caseService');
const Case = require('../../models/Case');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('note')
        .setDescription('Add a note to a case, or assign/label it')
        .addIntegerOption(o =>
            o.setName('case_id').setDescription('Case ID').setRequired(true).setMinValue(1))
        .addStringOption(o =>
            o.setName('text').setDescription('Note text').setRequired(true))
        .addStringOption(o =>
            o.setName('label').setDescription('Add a label to the case').setRequired(false))
        .addUserOption(o =>
            o.setName('assign').setDescription('Assign this case to a moderator').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

    async execute(interaction) {
        const caseId = interaction.options.getInteger('case_id');
        const text = interaction.options.getString('text');
        const label = interaction.options.getString('label');
        const assignee = interaction.options.getUser('assign');

        const modCase = await getCase(interaction.guild.id, caseId);
        if (!modCase) {
            return interaction.reply({ content: `Case #${caseId} not found.`, ephemeral: true });
        }

        await addNote(interaction.guild.id, caseId, interaction.user.id, text);

        const updates = {};
        if (label) updates.$addToSet = { labels: label };
        if (assignee) updates.$set = { assignedModId: assignee.id };
        if (Object.keys(updates).length) {
            await Case.updateOne({ guildId: interaction.guild.id, caseId }, updates);
        }

        const embed = new EmbedBuilder()
            .setColor('#888888')
            .setTitle(`Note added to Case #${caseId}`)
            .addFields({ name: 'Note', value: text });

        if (label) embed.addFields({ name: 'Label Added', value: label, inline: true });
        if (assignee) embed.addFields({ name: 'Assigned To', value: assignee.tag, inline: true });

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
};
