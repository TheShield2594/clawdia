const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');

module.exports = {
    cooldown: 10,
    data: new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('View the server leaderboard')
        .addStringOption(option =>
            option.setName('type')
                .setDescription('Type of leaderboard')
                .setRequired(false)
                .addChoices(
                    { name: 'Levels', value: 'levels' },
                    { name: 'Economy', value: 'economy' }
                )),
    async execute(interaction) {
        const type = interaction.options.getString('type') || 'levels';

        try {
            const sortField = type === 'levels' ? { level: -1, xp: -1 } : { balance: -1, bank: -1 };
            const users = await User.find({ guildId: interaction.guild.id }).sort(sortField).limit(10);

            if (users.length === 0) {
                return interaction.reply({ content: 'No users found on the leaderboard!', ephemeral: true });
            }

            const embed = new EmbedBuilder()
                .setColor('#ffd700')
                .setTitle(`🏆 ${interaction.guild.name} Leaderboard`)
                .setDescription(type === 'levels' ? 'Top 10 by Level' : 'Top 10 by Balance')
                .setTimestamp();

            let description = '';
            for (let i = 0; i < users.length; i++) {
                const user = users[i];
                const discordUser = await interaction.client.users.fetch(user.userId).catch(() => null);
                
                if (!discordUser) continue;

                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
                
                if (type === 'levels') {
                    description += `${medal} ${discordUser.tag} - Level ${user.level} (${user.xp} XP)\n`;
                } else {
                    const total = user.balance + user.bank;
                    description += `${medal} ${discordUser.tag} - ${total.toLocaleString()} coins\n`;
                }
            }

            embed.setDescription(description);
            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Leaderboard error:', error);
            await interaction.reply({ content: 'Failed to fetch leaderboard.', ephemeral: true });
        }
    }
};