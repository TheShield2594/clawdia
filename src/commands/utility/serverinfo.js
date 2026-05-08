const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');
const { raidModeActive, raidModeActivatedBy } = require('../../services/raidService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('serverinfo')
        .setDescription('Display server stats: member count, channels, roles, boost level, and creation date.'),
    async execute(interaction) {
        const { guild } = interaction;

        const guildSettings = await Guild.findOne({ guildId: guild.id }).catch(() => null);
        const rd = guildSettings?.raidDetection;

        let raidStatus = 'Detection disabled';
        if (rd?.enabled) {
            const isActive = raidModeActive.has(guild.id) || rd.raidModeActive;
            if (isActive) {
                const by = raidModeActivatedBy.get(guild.id) || rd.raidModeActivatedBy;
                raidStatus = `🔴 ACTIVE (${by === 'manual' ? 'manual' : 'auto'})`;
            } else {
                raidStatus = `🟢 Monitoring (${rd.threshold} joins/${rd.windowSeconds}s)`;
            }
        }

        const embed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('Server Information')
            .setThumbnail(guild.iconURL({ dynamic: true }))
            .addFields(
                { name: 'Server Name', value: guild.name, inline: true },
                { name: 'Server ID', value: guild.id, inline: true },
                { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
                { name: 'Members', value: guild.memberCount.toString(), inline: true },
                { name: 'Channels', value: guild.channels.cache.size.toString(), inline: true },
                { name: 'Roles', value: guild.roles.cache.size.toString(), inline: true },
                { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
                { name: 'Boost Tier', value: `Tier ${guild.premiumTier}`, inline: true },
                { name: 'Boosts', value: guild.premiumSubscriptionCount.toString(), inline: true },
                { name: 'Raid Mode', value: raidStatus, inline: true }
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};
