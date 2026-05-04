const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { startLockdown, endLockdown } = require('../../services/antiNukeService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('lockdown')
        .setDescription('Lock or unlock all text channels server-wide')
        .addSubcommand(s => s.setName('start')
            .setDescription('Lock all text channels (deny SendMessages for @everyone)')
            .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(false)))
        .addSubcommand(s => s.setName('end')
            .setDescription('Lift the active lockdown'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        await interaction.deferReply({ ephemeral: true });

        if (sub === 'start') {
            const reason = interaction.options.getString('reason') || 'Manual lockdown';
            const result = await startLockdown(interaction.guild, interaction.client, {
                startedBy: interaction.user.id,
                reason
            });
            if (!result.ok) return interaction.editReply(`Could not start lockdown: ${result.error}`);
            return interaction.editReply(`Lockdown active. Locked **${result.locked}** channels.`);
        }

        if (sub === 'end') {
            const result = await endLockdown(interaction.guild, { endedBy: interaction.user.id });
            if (!result.ok) return interaction.editReply(`Could not end lockdown: ${result.error}`);
            return interaction.editReply(`Lockdown lifted. Restored **${result.restored}** channels.`);
        }
    }
};
