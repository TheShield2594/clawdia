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
                    value: '`/ban` `/kick` `/warn` `/mute` `/unmute` `/clear` `/warnings`'
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
                    value: '`/ai` `/remind`'
                },
                {
                    name: '⚙️ Admin',
                    value: '`/settings` - Configure the bot via the web dashboard'
                }
            )
            .setFooter({ text: 'Use /command to see details about each command' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};