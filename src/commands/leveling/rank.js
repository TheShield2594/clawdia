const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const User = require('../../models/User');
const { createRankCard } = require('../../utils/cardGenerator');

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('rank')
        .setDescription('Check your or another user\'s rank')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to check rank for')
                .setRequired(false)),
    async execute(interaction) {
        const targetUser = interaction.options.getUser('user') || interaction.user;

        try {
            let user = await User.findOne({ userId: targetUser.id, guildId: interaction.guild.id });

            if (!user) {
                return interaction.reply({ content: `${targetUser.username} hasn't earned any XP yet!`, ephemeral: true });
            }

            const allUsers = await User.find({ guildId: interaction.guild.id }).sort({ level: -1, xp: -1 });
            const rank = allUsers.findIndex(u => u.userId === targetUser.id) + 1;

            const requiredXp = user.level * 100 + 100;
            
            const card = await createRankCard(targetUser, user, rank, requiredXp);
            const attachment = new AttachmentBuilder(card, { name: 'rank.png' });

            await interaction.reply({ files: [attachment] });
        } catch (error) {
            console.error('Rank error:', error);
            await interaction.reply({ content: 'Failed to fetch rank.', ephemeral: true });
        }
    }
};