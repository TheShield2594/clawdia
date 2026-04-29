const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Warning = require('../../models/Warning');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('warnings')
        .setDescription('View warnings for a user')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to check warnings for')
                .setRequired(true)),
    async execute(interaction) {
        const user = interaction.options.getUser('user');

        try {
            const warnings = await Warning.find({
                guildId: interaction.guild.id,
                userId: user.id
            }).sort({ date: -1 });

            if (warnings.length === 0) {
                return interaction.reply({ content: `${user.tag} has no warnings.`, ephemeral: true });
            }

            const embed = new EmbedBuilder()
                .setColor('#ffff00')
                .setTitle(`Warnings for ${user.tag}`)
                .setDescription(`Total warnings: ${warnings.length}`)
                .setThumbnail(user.displayAvatarURL({ dynamic: true }));

            warnings.slice(0, 10).forEach((warning, index) => {
                embed.addFields({
                    name: `Warning ${index + 1}`,
                    value: `**Reason:** ${warning.reason}\n**Date:** <t:${Math.floor(warning.date.getTime() / 1000)}:R>\n**Moderator:** <@${warning.moderatorId}>`
                });
            });

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Warnings error:', error);
            await interaction.reply({ content: 'Failed to fetch warnings.', ephemeral: true });
        }
    }
};