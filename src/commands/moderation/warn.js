const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Warning = require('../../models/Warning');
const { logModeration } = require('../../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('warn')
        .setDescription('Warn a member')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to warn')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('reason')
                .setDescription('Reason for the warning')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    async execute(interaction) {
        const user = interaction.options.getUser('user');
        const reason = interaction.options.getString('reason');

        if (user.bot) {
            return interaction.reply({ content: 'You cannot warn bots!', ephemeral: true });
        }

        try {
            await Warning.create({
                guildId: interaction.guild.id,
                userId: user.id,
                moderatorId: interaction.user.id,
                reason: reason
            });

            const warningCount = await Warning.countDocuments({
                guildId: interaction.guild.id,
                userId: user.id
            });

            const embed = new EmbedBuilder()
                .setColor('#ffff00')
                .setTitle('User Warned')
                .setDescription(`**${user.tag}** has been warned.`)
                .addFields(
                    { name: 'Reason', value: reason },
                    { name: 'Total Warnings', value: warningCount.toString() },
                    { name: 'Moderator', value: interaction.user.tag }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [embed] });
            await logModeration(interaction.guild.id, 'warn', user, interaction.user, reason);

            try {
                await user.send(`You have been warned in **${interaction.guild.name}** for: ${reason}`);
            } catch {
                console.log('Could not DM user');
            }
        } catch (error) {
            console.error('Warn error:', error);
            await interaction.reply({ content: 'Failed to warn the user.', ephemeral: true });
        }
    }
};