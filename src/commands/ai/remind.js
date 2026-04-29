const { SlashCommandBuilder } = require('discord.js');
const Reminder = require('../../models/Reminder');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('remind')
        .setDescription('Set a reminder')
        .addStringOption(option =>
            option.setName('message')
                .setDescription('What to remind you about')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('minutes')
                .setDescription('Minutes from now')
                .setRequired(false)
                .setMinValue(1))
        .addIntegerOption(option =>
            option.setName('hours')
                .setDescription('Hours from now')
                .setRequired(false)
                .setMinValue(1))
        .addIntegerOption(option =>
            option.setName('days')
                .setDescription('Days from now')
                .setRequired(false)
                .setMinValue(1)),
    async execute(interaction) {
        const message = interaction.options.getString('message');
        const minutes = interaction.options.getInteger('minutes') || 0;
        const hours = interaction.options.getInteger('hours') || 0;
        const days = interaction.options.getInteger('days') || 0;

        if (minutes === 0 && hours === 0 && days === 0) {
            return interaction.reply({ content: 'Please specify at least one time unit!', ephemeral: true });
        }

        const totalMinutes = minutes + (hours * 60) + (days * 1440);
        const remindAt = new Date(Date.now() + totalMinutes * 60000);

        try {
            await Reminder.create({
                userId: interaction.user.id,
                guildId: interaction.guild?.id,
                channelId: interaction.channel.id,
                message: message,
                remindAt: remindAt
            });

            await interaction.reply(`✅ I'll remind you about "${message}" <t:${Math.floor(remindAt.getTime() / 1000)}:R>`);
        } catch (error) {
            console.error('Reminder error:', error);
            await interaction.reply({ content: 'Failed to create reminder.', ephemeral: true });
        }
    }
};