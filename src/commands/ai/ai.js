const { SlashCommandBuilder } = require('discord.js');
const { getCompletion, resolveProviderConfig, checkRateLimit, checkChannelRateLimit } = require('../../services/aiService');
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
            const ai = guildSettings?.ai || {};

            if (!ai.enabled) {
                return interaction.editReply('AI is not enabled for this server. Enable it in the dashboard.');
            }

            if (!checkRateLimit(interaction.user.id, ai.rateLimitPerUser, ai.rateLimitWindowMin)) {
                return interaction.editReply(`Rate limit reached (${ai.rateLimitPerUser} per ${ai.rateLimitWindowMin}m). Please slow down.`);
            }

            if (!checkChannelRateLimit(interaction.channelId, ai.rateLimitPerChannel, ai.rateLimitWindowMin)) {
                return interaction.editReply('This channel has reached the AI request limit. Please wait before sending more AI requests here.');
            }

            const { provider, model, apiKey, baseUrl, temperature, maxTokens } = resolveProviderConfig(ai);

            if (provider !== 'ollama' && !apiKey) {
                return interaction.editReply('AI API key is not configured. Add one in the dashboard.');
            }

            const systemPrompt = ai.systemPrompt || 'You are a helpful Discord bot assistant.';
            const response = await getCompletion({ provider, model, apiKey, baseUrl, systemPrompt, history: [], prompt, temperature, maxTokens });

            const reply = response?.trim() || '(empty response)';
            if (reply.length > 2000) {
                await interaction.editReply(reply.substring(0, 1997) + '...');
            } else {
                await interaction.editReply(reply);
            }
        } catch (error) {
            console.error('AI command error:', error);
            const detail = error?.status ? ` (HTTP ${error.status})` : '';
            await interaction.editReply(`Sorry, I encountered an error processing your request${detail}.`);
        }
    }
};
