const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('settings')
        .setDescription('Get the dashboard link to configure the bot')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    async execute(interaction) {
        const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';
        
        await interaction.reply({
            content: `⚙️ **Bot Configuration Dashboard**\n\nVisit the dashboard to configure all bot settings:\n${dashboardUrl}\n\nYou can configure:\n• Welcome & Farewell messages\n• Moderation settings\n• Leveling system\n• Economy settings\n• Music preferences\n• RSS feeds\n• AI chat\n• And more!`,
            ephemeral: true
        });
    }
};