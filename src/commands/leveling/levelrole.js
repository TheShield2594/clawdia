const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('levelrole')
        .setDescription('Manage roles awarded when members reach a level')
        .addSubcommand(sub =>
            sub.setName('add')
                .setDescription('Award a role when a member reaches a level')
                .addIntegerOption(o => o.setName('level').setDescription('Level required').setRequired(true).setMinValue(1))
                .addRoleOption(o => o.setName('role').setDescription('Role to award').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove a level role reward')
                .addIntegerOption(o => o.setName('level').setDescription('Level to remove the reward from').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('Show all level role rewards'))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOneAndUpdate(
            { guildId: interaction.guild.id },
            { $setOnInsert: { name: interaction.guild.name } },
            { upsert: true, new: true }
        );

        if (sub === 'add') {
            const level = interaction.options.getInteger('level');
            const role = interaction.options.getRole('role');

            if (role.managed || role.id === interaction.guild.id) {
                return interaction.reply({ content: 'That role cannot be assigned.', ephemeral: true });
            }

            if (interaction.guild.members.me.roles.highest.comparePositionTo(role) <= 0) {
                return interaction.reply({ content: 'My highest role is below that role — I cannot assign it.', ephemeral: true });
            }

            const existing = guildSettings.levelRoles.find(lr => lr.level === level);
            if (existing) {
                existing.roleId = role.id;
            } else {
                guildSettings.levelRoles.push({ level, roleId: role.id });
            }
            guildSettings.levelRoles.sort((a, b) => a.level - b.level);
            await guildSettings.save();

            await interaction.reply({ content: `Members will now receive ${role} when they reach **level ${level}**.` });

        } else if (sub === 'remove') {
            const level = interaction.options.getInteger('level');
            const before = guildSettings.levelRoles.length;
            guildSettings.levelRoles = guildSettings.levelRoles.filter(lr => lr.level !== level);

            if (guildSettings.levelRoles.length === before) {
                return interaction.reply({ content: `No level role reward found for level ${level}.`, ephemeral: true });
            }

            await guildSettings.save();
            await interaction.reply({ content: `Level role reward for level ${level} removed.` });

        } else if (sub === 'list') {
            if (!guildSettings.levelRoles.length) {
                return interaction.reply({ content: 'No level role rewards configured.', ephemeral: true });
            }

            const lines = guildSettings.levelRoles.map(lr => `Level **${lr.level}** → <@&${lr.roleId}>`);

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('Level Role Rewards')
                .setDescription(lines.join('\n'));

            await interaction.reply({ embeds: [embed] });
        }
    }
};
