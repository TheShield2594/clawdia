const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('View all available commands'),
    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('🤖 UltraBot Commands')
            .setDescription('Here are all the available commands:')
            .addFields(
                {
                    name: '⚔️ Moderation',
                    value: '`/ban` `/kick` `/warn` `/mute` `/unmute` `/clear`'
                },
                {
                    name: '💰 Economy',
                    value: '`/balance` `/daily` `/work` `/transfer`'
                },
                {
                    name: '📊 Leveling',
                    value: '`/rank` `/leaderboard`'
                },
                {
                    name: '🎵 Music',
                    value: '`/play` `/skip` `/stop` `/queue` `/nowplaying`'
                },
                {
                    name: '🎮 Fun',
                    value: '`/8ball` `/roll` `/coinflip`'
                },
                {
                    name: '🔧 Utility',
                    value: '`/avatar` `/userinfo` `/serverinfo` `/help` `/ping`'
                },
                {
                    name: '🤖 AI',
                    value: '`/remind` - Ping the bot to chat with AI'
                },
                {
                    name: '⚙️ Admin',
                    value: '`/settings` - Configure the bot via the web dashboard'
                },
                {
                    name: '🖥️ Dashboard Features',
                    value: 'Temp Voices, Reaction Roles, Knowledge Base, Event Logs, Auto Roles, and Anti-Nuke are configured in the dashboard'
                }
            )
            .setFooter({ text: 'Use /command to see details about each command' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};