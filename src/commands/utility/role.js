const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('role')
        .setDescription('Self-assign or remove a role from the server reaction role panels')
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Give yourself a self-assignable role')
                .addRoleOption(o => o.setName('role').setDescription('Role to assign').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove a self-assignable role from yourself')
                .addRoleOption(o => o.setName('role').setDescription('Role to remove').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List all self-assignable roles')),

    async execute(interaction) {
        const sub           = interaction.options.getSubcommand();
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });

        // Collect all unique roleIds from reaction role panels
        const selfRoleIds = [...new Set((guildSettings?.reactionRoles || []).map(r => r.roleId))];

        if (sub === 'list') {
            if (!selfRoleIds.length) {
                return interaction.reply({ content: 'No self-assignable roles have been configured. Admins can set them up via Reaction Roles in the dashboard.', ephemeral: true });
            }

            const lines = selfRoleIds.map(id => `<@&${id}>`).join('\n');
            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('Self-Assignable Roles')
                .setDescription(lines)
                .setFooter({ text: 'Use /role add <role> to assign one' });

            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        const role = interaction.options.getRole('role');

        if (!selfRoleIds.includes(role.id)) {
            return interaction.reply({ content: `**${role.name}** is not a self-assignable role. Use \`/role list\` to see available roles.`, ephemeral: true });
        }

        const member = await interaction.guild.members.fetch(interaction.user.id);

        if (sub === 'add') {
            if (member.roles.cache.has(role.id)) {
                return interaction.reply({ content: `You already have the **${role.name}** role.`, ephemeral: true });
            }

            try {
                await member.roles.add(role.id, 'Self-assigned via /role add');
                return interaction.reply({ content: `You've been given the **${role.name}** role.`, ephemeral: true });
            } catch (error) {
                console.error('Role add error:', error);
                return interaction.reply({ content: 'Failed to assign the role. I may not have permission.', ephemeral: true });
            }
        }

        if (sub === 'remove') {
            if (!member.roles.cache.has(role.id)) {
                return interaction.reply({ content: `You don't have the **${role.name}** role.`, ephemeral: true });
            }

            try {
                await member.roles.remove(role.id, 'Self-removed via /role remove');
                return interaction.reply({ content: `The **${role.name}** role has been removed.`, ephemeral: true });
            } catch (error) {
                console.error('Role remove error:', error);
                return interaction.reply({ content: 'Failed to remove the role. I may not have permission.', ephemeral: true });
            }
        }
    }
};
