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

        let roleSyncStatus = 'no level roles configured';

        if (guildSettings.levelRoles?.length) {
            const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
            if (!member) {
                roleSyncStatus = 'skipped: user not in guild';
            } else {
                const toAdd = guildSettings.levelRoles
                    .filter(lr => lr.level <= newLevel)
                    .sort((a, b) => b.level - a.level)[0];

                const toRemove = guildSettings.levelRoles.filter(
                    lr => lr.level > newLevel && member.roles.cache.has(lr.roleId)
                );

                const addOutcome = toAdd
                    ? await member.roles.add(toAdd.roleId).then(() => 'fulfilled').catch(err => { console.error(err); return 'rejected'; })
                    : 'fulfilled';

                const removeOutcomes = await Promise.allSettled(
                    toRemove.map(lr => member.roles.remove(lr.roleId))
                );
                removeOutcomes.filter(r => r.status === 'rejected').forEach(r => console.error(r.reason));

                const anyFailed = addOutcome === 'rejected' || removeOutcomes.some(r => r.status === 'rejected');
                roleSyncStatus = anyFailed ? 'partial sync: failed to add/remove some roles' : 'roles synced';
            }
        }

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('Level Assigned')
            .setDescription(`${targetUser} has been set to **level ${newLevel}**.`)
            .addFields(
                { name: 'Previous Level', value: `${previousLevel}`, inline: true },
                { name: 'New Level', value: `${newLevel}`, inline: true },
                { name: 'Role Sync', value: roleSyncStatus, inline: false }
            )
            .setFooter({ text: `Set by ${interaction.user.tag}` })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
};
