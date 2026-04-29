const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('customcommand')
        .setDescription('Manage custom text commands for this server')
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Add a custom command')
                .addStringOption(o => o.setName('name').setDescription('Command name (no spaces)').setRequired(true))
                .addStringOption(o => o.setName('response').setDescription('Response the bot sends').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove a custom command')
                .addStringOption(o => o.setName('name').setDescription('Command name to remove').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List all custom commands'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOneAndUpdate(
            { guildId: interaction.guild.id },
            { $setOnInsert: { name: interaction.guild.name } },
            { upsert: true, new: true }
        );

        if (sub === 'add') {
            const name = interaction.options.getString('name').toLowerCase().replace(/\s+/g, '-');
            const response = interaction.options.getString('response');

            if (name.length > 32) {
                return interaction.reply({ content: 'Command name must be 32 characters or fewer.', ephemeral: true });
            }

            const existing = guildSettings.customCommands.find(c => c.name === name);
            if (existing) {
                existing.response = response;
            } else {
                if (guildSettings.customCommands.length >= 100) {
                    return interaction.reply({ content: 'You have reached the maximum of 100 custom commands.', ephemeral: true });
                }
                guildSettings.customCommands.push({ name, response });
            }

            await guildSettings.save();
            await interaction.reply({ content: `Custom command \`/${name}\` saved.` });

        } else if (sub === 'remove') {
            const name = interaction.options.getString('name').toLowerCase();
            const before = guildSettings.customCommands.length;
            guildSettings.customCommands = guildSettings.customCommands.filter(c => c.name !== name);

            if (guildSettings.customCommands.length === before) {
                return interaction.reply({ content: `No custom command named \`${name}\` found.`, ephemeral: true });
            }

            await guildSettings.save();
            await interaction.reply({ content: `Custom command \`/${name}\` removed.` });

        } else if (sub === 'list') {
            if (!guildSettings.customCommands.length) {
                return interaction.reply({ content: 'No custom commands set up yet. Use `/customcommand add` to create one.', ephemeral: true });
            }

            const pages = [];
            const pageSize = 15;
            for (let i = 0; i < guildSettings.customCommands.length; i += pageSize) {
                const chunk = guildSettings.customCommands.slice(i, i + pageSize);
                pages.push(chunk.map(c => `\`/${c.name}\` — ${c.response.substring(0, 60)}${c.response.length > 60 ? '…' : ''}`).join('\n'));
            }

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle(`Custom Commands (${guildSettings.customCommands.length})`)
                .setDescription(pages[0])
                .setFooter({ text: 'Trigger with /<command-name> in chat' });

            await interaction.reply({ embeds: [embed] });
        }
    }
};
