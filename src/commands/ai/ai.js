const { SlashCommandBuilder } = require('discord.js');
const { getChatCompletion } = require('../../services/aiService');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ai')
        .setDescription('Ask the AI a question')
        .addStringOption(option =>
            option.setName('prompt')
                .setDescription('Your question or prompt')
                .setRequired(true)),
    cooldown: 10,
    async execute(interaction) {
        const prompt = interaction.options.getString('prompt');

        await interaction.deferReply();

        try {
            const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
            const provider = guildSettings?.ai.provider || 'openai';
            const apiKey = provider === 'openai' ? guildSettings?.ai.openaiKey : guildSettings?.ai.geminiKey;
            
            const response = await getChatCompletion(prompt, 'You are a helpful Discord bot assistant.', provider, apiKey);
            
            if (response.length > 2000) {
                await interaction.editReply(response.substring(0, 1997) + '...');
            } else {
                await interaction.editReply(response);
            }
        } catch (error) {
            console.error('AI error:', error);
            await interaction.editReply('Sorry, I encountered an error processing your request. Make sure the AI API key is configured in the dashboard.');
        }
    }
};