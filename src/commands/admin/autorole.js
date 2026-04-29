const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('autorole')
        .setDescription('Manage roles automatically assigned to new members')
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Add a role to auto-assign on member join')
                .addRoleOption(o => o.setName('role').setDescription('Role to auto-assign').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove a role from auto-assign')
                .addRoleOption(o => o.setName('role').setDescription('Role to remove').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('Show all auto-assigned roles'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOneAndUpdate(
            { guildId: interaction.guild.id },
            { $setOnInsert: { name: interaction.guild.name } },
            { upsert: true, new: true }
        );

        if (sub === 'add') {
            const role = interaction.options.getRole('role');

            if (role.managed || role.id === interaction.guild.id) {
                return interaction.reply({ content: 'That role cannot be auto-assigned.', ephemeral: true });
            }

            if (interaction.guild.members.me.roles.highest.comparePositionTo(role) <= 0) {
                return interaction.reply({ content: 'My highest role is below that role — I cannot assign it.', ephemeral: true });
            }

            if (guildSettings.autoRoles.some(r => r.roleId === role.id)) {
                return interaction.reply({ content: `${role} is already in the auto-role list.`, ephemeral: true });
            }

            guildSettings.autoRoles.push({ roleId: role.id });
            await guildSettings.save();

            await interaction.reply({ content: `${role} will now be assigned to all new members.` });

        } else if (sub === 'remove') {
            const role = interaction.options.getRole('role');
            const before = guildSettings.autoRoles.length;
            guildSettings.autoRoles = guildSettings.autoRoles.filter(r => r.roleId !== role.id);

            if (guildSettings.autoRoles.length === before) {
                return interaction.reply({ content: `${role} is not in the auto-role list.`, ephemeral: true });
            }

            await guildSettings.save();
            await interaction.reply({ content: `${role} removed from auto-roles.` });

        } else if (sub === 'list') {
            if (!guildSettings.autoRoles.length) {
                return interaction.reply({ content: 'No auto-roles configured. Use `/autorole add` to add one.', ephemeral: true });
            }

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('Auto-Roles')
                .setDescription(guildSettings.autoRoles.map(r => `<@&${r.roleId}>`).join('\n'))
                .setFooter({ text: 'These roles are assigned when a new member joins.' });

            await interaction.reply({ embeds: [embed] });
        }
    }
};
