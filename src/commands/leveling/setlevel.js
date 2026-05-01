const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setlevel')
        .setDescription('Directly assign a level to a member (admin use / MEE6 migration)')
        .addUserOption(o =>
            o.setName('user').setDescription('Member to assign the level to').setRequired(true))
        .addIntegerOption(o =>
            o.setName('level').setDescription('Level to assign').setRequired(true).setMinValue(0).setMaxValue(500))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const targetUser = interaction.options.getUser('user');
        const newLevel = interaction.options.getInteger('level');

        if (targetUser.bot) {
            return interaction.editReply({ content: 'You cannot assign levels to bots.' });
        }

        const [guildSettings, user] = await Promise.all([
            Guild.findOneAndUpdate(
                { guildId: interaction.guild.id },
                { $setOnInsert: { name: interaction.guild.name } },
                { upsert: true, new: true }
            ),
            User.findOneAndUpdate(
                { userId: targetUser.id, guildId: interaction.guild.id },
                { $setOnInsert: { userId: targetUser.id, guildId: interaction.guild.id } },
                { upsert: true, new: true }
            )
        ]);

        const previousLevel = user.level;
        user.level = newLevel;
        user.xp = 0;
        await user.save();

        // Assign the highest applicable level role reward
        if (guildSettings.levelRoles?.length) {
            const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
            if (member) {
                const applicable = guildSettings.levelRoles
                    .filter(lr => lr.level <= newLevel)
                    .sort((a, b) => b.level - a.level);

                const toAdd = applicable[0];
                if (toAdd) {
                    await member.roles.add(toAdd.roleId).catch(console.error);
                }

                // Remove level roles that are above the assigned level
                const toRemove = guildSettings.levelRoles.filter(lr => lr.level > newLevel);
                for (const lr of toRemove) {
                    if (member.roles.cache.has(lr.roleId)) {
                        await member.roles.remove(lr.roleId).catch(console.error);
                    }
                }
            }
        }

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('Level Assigned')
            .setDescription(`${targetUser} has been set to **level ${newLevel}**.`)
            .addFields({ name: 'Previous Level', value: `${previousLevel}`, inline: true },
                       { name: 'New Level', value: `${newLevel}`, inline: true })
            .setFooter({ text: `Set by ${interaction.user.tag}` })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
};
