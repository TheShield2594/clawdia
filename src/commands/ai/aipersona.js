const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('aipersona')
        .setDescription('Set per-channel AI personas (different bot identity per channel)')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub => sub
            .setName('set')
            .setDescription('Assign a persona to a channel — the bot will use it whenever active in that channel')
            .addChannelOption(o => o.setName('channel').setDescription('Target channel').setRequired(true))
            .addStringOption(o => o.setName('name').setDescription('Persona display name (e.g. "Support Bot")').setRequired(true))
            .addStringOption(o => o.setName('prompt').setDescription('System prompt / personality for this channel').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('remove')
            .setDescription('Remove the persona from a channel (falls back to server default)')
            .addChannelOption(o => o.setName('channel').setDescription('Target channel').setRequired(true)))
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('List all active channel personas')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (!guildSettings) return interaction.reply({ content: 'Guild not configured.', ephemeral: true });

        if (!guildSettings.ai.channelPersonas) guildSettings.ai.channelPersonas = [];

        if (sub === 'set') {
            const channel = interaction.options.getChannel('channel');
            if (!channel.isTextBased()) {
                return interaction.reply({ content: 'Personas can only be set on text-based channels (text, thread, announcement, etc.).', ephemeral: true });
            }
            const name = interaction.options.getString('name');
            const prompt = interaction.options.getString('prompt');

            const existing = guildSettings.ai.channelPersonas.find(p => p.channelId === channel.id);
            if (existing) {
                existing.personaName = name;
                existing.systemPrompt = prompt;
            } else {
                guildSettings.ai.channelPersonas.push({ channelId: channel.id, personaName: name, systemPrompt: prompt });
            }
            await guildSettings.save();

            await interaction.reply({
                content: `Persona **${name}** assigned to <#${channel.id}>.\nMessages in that channel will now use this persona. Make sure AI is enabled and that channel is an AI channel (or set as one via the dashboard).`,
                ephemeral: true
            });

        } else if (sub === 'remove') {
            const channel = interaction.options.getChannel('channel');
            const before = guildSettings.ai.channelPersonas.length;
            guildSettings.ai.channelPersonas = guildSettings.ai.channelPersonas.filter(p => p.channelId !== channel.id);
            if (guildSettings.ai.channelPersonas.length === before) {
                return interaction.reply({ content: 'No persona found for that channel.', ephemeral: true });
            }
            await guildSettings.save();
            await interaction.reply({ content: `Persona removed from <#${channel.id}>. It will now use the server default.`, ephemeral: true });

        } else if (sub === 'list') {
            const personas = guildSettings.ai.channelPersonas;
            if (!personas?.length) return interaction.reply({ content: 'No channel personas configured.', ephemeral: true });

            const lines = personas.map(p => {
                const preview = p.systemPrompt.length > 100 ? p.systemPrompt.slice(0, 100) + '…' : p.systemPrompt;
                return `<#${p.channelId}> — **${p.personaName}**\n> ${preview}`;
            });

            const embed = new EmbedBuilder()
                .setTitle('Channel AI Personas')
                .setColor(0x5865F2)
                .setDescription(lines.join('\n\n').slice(0, 4000))
                .setFooter({ text: `${personas.length} persona${personas.length !== 1 ? 's' : ''}` });

            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }
};
