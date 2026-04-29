const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { sendDailyNews } = require('../../services/rssService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('dailynews')
        .setDescription('Manually trigger the daily news digest')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        try {
            await sendDailyNews(interaction.client, interaction.guild.id);
            await interaction.editReply('✅ Daily news digest sent successfully!');
        } catch (error) {
            console.error('Daily news manual trigger error:', error);
            await interaction.editReply('❌ Failed to send daily news. Make sure you have configured the daily news settings in the dashboard.');
        }
    }
};