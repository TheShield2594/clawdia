const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const Guild = require('../../models/Guild');
const { generateNewspaper } = require('../../services/newspaperService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('newspaper')
        .setDescription('Server newspaper commands.')
        .addSubcommand(sub =>
            sub.setName('preview')
               .setDescription('Generate a preview of this week\'s server newspaper (admin only).')
        ),
    cooldownKey: () => 'newspaper',
    cooldownAmount: () => 30,
    async execute(interaction, client) {
        if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: 'You need the **Manage Server** permission to use this command.', ephemeral: true });
        }

        const guildDoc = await Guild.findOne({ guildId: interaction.guild.id });
        if (!guildDoc?.newspaper?.enabled) {
            return interaction.reply({
                content: 'The Server Newspaper is not enabled. Enable it in the Dashboard under **Engagement → Newspaper**.',
                ephemeral: true
            });
        }

        await interaction.deferReply();

        try {
            const embed = await generateNewspaper(client, guildDoc);
            await interaction.editReply({ content: '📰 *Preview — this is how the newspaper will look when delivered:*', embeds: [embed] });
        } catch (err) {
            console.error('[newspaper] preview failed:', err);
            await interaction.editReply({ content: 'Failed to generate the newspaper. Check that your AI provider is configured.' });
        }
    }
};
