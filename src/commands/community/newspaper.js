const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const Guild = require('../../models/Guild');
const { generateNewspaper } = require('../../services/newspaperService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('newspaper')
        .setDescription('Server newspaper commands.')
        .setDMPermission(false)
        .addSubcommand(sub =>
            sub.setName('preview')
               .setDescription('Generate a preview of this week\'s server newspaper (admin only).')
        ),
    cooldownKey: () => 'newspaper',
    cooldownAmount: () => 30,
    async execute(interaction, client) {
        if (!interaction.inGuild()) {
            return interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
        }
        if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: 'You need the **Manage Server** permission to use this command.', flags: MessageFlags.Ephemeral });
        }

        const guildDoc = await Guild.findOne({ guildId: interaction.guild.id });
        if (!guildDoc?.newspaper?.enabled) {
            return interaction.reply({
                content: 'The Server Newspaper is not enabled. Enable it in the Dashboard under **Engagement → Newspaper**.',
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply();

        try {
            const embed = await generateNewspaper(client, guildDoc, undefined, {
                userId: interaction.user.id,
                channelId: interaction.channelId,
            });
            await interaction.editReply({ content: '📰 *Preview — this is how the newspaper will look when delivered:*', embeds: [embed] });
        } catch (err) {
            if (err?.rateLimited) {
                await interaction.editReply({ content: `This server's AI request limit has been reached (${err.limit} per ${err.windowMin}m). Please wait a few minutes.` });
                return;
            }
            console.error('[newspaper] preview failed:', err);
            await interaction.editReply({ content: 'Failed to generate the newspaper. Check that your AI provider is configured.' });
        }
    }
};
