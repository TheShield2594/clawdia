const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('raidmode')
        .setDescription('Configure raid detection and case management settings')
        .addSubcommand(sub =>
            sub.setName('raid')
                .setDescription('Configure raid detection')
                .addBooleanOption(o => o.setName('enabled').setDescription('Enable raid detection').setRequired(true))
                .addIntegerOption(o => o.setName('threshold').setDescription('Joins that trigger raid (default 10)').setMinValue(3).setRequired(false))
                .addIntegerOption(o => o.setName('window').setDescription('Time window in seconds (default 60)').setMinValue(10).setRequired(false))
                .addIntegerOption(o => o.setName('min_account_age').setDescription('Flag accounts younger than N days (default 7)').setMinValue(0).setRequired(false))
                .addStringOption(o =>
                    o.setName('action').setDescription('Action when raid detected (default: alert)').setRequired(false)
                        .addChoices(
                            { name: 'Alert only', value: 'alert' },
                            { name: 'Quarantine new accounts', value: 'quarantine' },
                            { name: 'Kick new accounts', value: 'kick' }
                        ))
                .addChannelOption(o => o.setName('alert_channel').setDescription('Channel for raid alerts (default: mod log)').setRequired(false))
                .addRoleOption(o => o.setName('quarantine_role').setDescription('Role applied when action is quarantine').setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('cases')
                .setDescription('Configure case SLA and appeals')
                .addIntegerOption(o => o.setName('sla_hours').setDescription('Hours before an open case triggers SLA ping (default 48)').setMinValue(1).setRequired(false))
                .addChannelOption(o => o.setName('sla_channel').setDescription('Channel for SLA overdue pings').setRequired(false))
                .addBooleanOption(o => o.setName('appeals_enabled').setDescription('Allow users to appeal cases via /appeal').setRequired(false))
                .addChannelOption(o => o.setName('appeal_channel').setDescription('Channel where appeal notifications are posted').setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('tracks')
                .setDescription('Configure progression tracks')
                .addBooleanOption(o => o.setName('enabled').setDescription('Enable progression tracks').setRequired(true))
                .addIntegerOption(o => o.setName('creator_bonus').setDescription('Creator track XP bonus % (default 20)').setMinValue(0).setMaxValue(100).setRequired(false))
                .addIntegerOption(o => o.setName('helper_bonus').setDescription('Helper track XP bonus % (default 20)').setMinValue(0).setMaxValue(100).setRequired(false))
                .addIntegerOption(o => o.setName('raider_bonus').setDescription('Raider track XP bonus % (default 20)').setMinValue(0).setMaxValue(100).setRequired(false))
                .addStringOption(o => o.setName('helper_channels').setDescription('Comma-separated channel IDs for helper track').setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('quests')
                .setDescription('Configure the quests system')
                .addBooleanOption(o => o.setName('enabled').setDescription('Enable quests').setRequired(true))
                .addIntegerOption(o => o.setName('daily_xp').setDescription('XP reward per daily quest (default 50)').setMinValue(0).setRequired(false))
                .addIntegerOption(o => o.setName('daily_coins').setDescription('Coin reward per daily quest (default 25)').setMinValue(0).setRequired(false))
                .addIntegerOption(o => o.setName('weekly_xp').setDescription('XP reward per weekly quest (default 300)').setMinValue(0).setRequired(false))
                .addIntegerOption(o => o.setName('weekly_coins').setDescription('Coin reward per weekly quest (default 150)').setMinValue(0).setRequired(false)))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'raid') {
            const enabled = interaction.options.getBoolean('enabled');
            const threshold = interaction.options.getInteger('threshold');
            const window = interaction.options.getInteger('window');
            const minAge = interaction.options.getInteger('min_account_age');
            const action = interaction.options.getString('action');
            const alertChannel = interaction.options.getChannel('alert_channel');
            const quarantineRole = interaction.options.getRole('quarantine_role');

            const update = { 'raidDetection.enabled': enabled };
            if (threshold != null) update['raidDetection.threshold'] = threshold;
            if (window != null) update['raidDetection.windowSeconds'] = window;
            if (minAge != null) update['raidDetection.minAccountAgeDays'] = minAge;
            if (action) update['raidDetection.action'] = action;
            if (alertChannel) update['raidDetection.alertChannelId'] = alertChannel.id;
            if (quarantineRole) update['raidDetection.quarantineRoleId'] = quarantineRole.id;

            await Guild.updateOne({ guildId: interaction.guild.id }, { $set: update });

            const embed = new EmbedBuilder()
                .setColor(enabled ? '#00ff00' : '#ff0000')
                .setTitle(`Raid Detection ${enabled ? 'Enabled' : 'Disabled'}`)
                .addFields(
                    { name: 'Threshold', value: (threshold ?? 10).toString(), inline: true },
                    { name: 'Window', value: `${window ?? 60}s`, inline: true },
                    { name: 'Action', value: action ?? 'alert', inline: true }
                )
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }

        if (sub === 'cases') {
            const slaHours = interaction.options.getInteger('sla_hours');
            const slaChannel = interaction.options.getChannel('sla_channel');
            const appealsEnabled = interaction.options.getBoolean('appeals_enabled');
            const appealChannel = interaction.options.getChannel('appeal_channel');

            const update = {};
            if (slaHours != null) update['caseSettings.slaHours'] = slaHours;
            if (slaChannel) update['caseSettings.slaChannelId'] = slaChannel.id;
            if (appealsEnabled != null) update['moderation.appealsEnabled'] = appealsEnabled;
            if (appealChannel) update['moderation.appealChannelId'] = appealChannel.id;

            if (Object.keys(update).length === 0) {
                return interaction.reply({
                    content: 'Please provide at least one option to update (sla_hours, sla_channel, appeals_enabled, or appeal_channel).',
                    ephemeral: true
                });
            }

            await Guild.updateOne({ guildId: interaction.guild.id }, { $set: update });

            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor('#5865F2')
                    .setTitle('Case Settings Updated')
                    .addFields(
                        { name: 'SLA Hours', value: (slaHours ?? '(unchanged)').toString(), inline: true },
                        { name: 'Appeals', value: appealsEnabled != null ? (appealsEnabled ? 'Enabled' : 'Disabled') : '(unchanged)', inline: true }
                    )]
            });
        }

        if (sub === 'tracks') {
            const enabled = interaction.options.getBoolean('enabled');
            const creatorBonus = interaction.options.getInteger('creator_bonus');
            const helperBonus = interaction.options.getInteger('helper_bonus');
            const raiderBonus = interaction.options.getInteger('raider_bonus');
            const helperChannelsRaw = interaction.options.getString('helper_channels');

            const update = { 'progressionTracks.enabled': enabled };
            if (creatorBonus != null) update['progressionTracks.creatorBonus'] = creatorBonus;
            if (helperBonus != null) update['progressionTracks.helperBonus'] = helperBonus;
            if (raiderBonus != null) update['progressionTracks.raiderBonus'] = raiderBonus;
            if (helperChannelsRaw) {
                update['progressionTracks.helperChannels'] = helperChannelsRaw.split(',').map(s => s.trim());
            }

            await Guild.updateOne({ guildId: interaction.guild.id }, { $set: update });

            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(enabled ? '#00ff00' : '#ff0000')
                    .setTitle(`Progression Tracks ${enabled ? 'Enabled' : 'Disabled'}`)
                    .addFields(
                        { name: 'Creator Bonus', value: `+${creatorBonus ?? 20}%`, inline: true },
                        { name: 'Helper Bonus', value: `+${helperBonus ?? 20}%`, inline: true },
                        { name: 'Raider Bonus', value: `+${raiderBonus ?? 20}%`, inline: true }
                    )]
            });
        }

        if (sub === 'quests') {
            const enabled = interaction.options.getBoolean('enabled');
            const dailyXp = interaction.options.getInteger('daily_xp');
            const dailyCoins = interaction.options.getInteger('daily_coins');
            const weeklyXp = interaction.options.getInteger('weekly_xp');
            const weeklyCoins = interaction.options.getInteger('weekly_coins');

            const update = { 'quests.enabled': enabled };
            if (dailyXp != null) update['quests.dailyXpReward'] = dailyXp;
            if (dailyCoins != null) update['quests.dailyCoinReward'] = dailyCoins;
            if (weeklyXp != null) update['quests.weeklyXpReward'] = weeklyXp;
            if (weeklyCoins != null) update['quests.weeklyCoinReward'] = weeklyCoins;

            await Guild.updateOne({ guildId: interaction.guild.id }, { $set: update });

            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor(enabled ? '#00ff00' : '#ff0000')
                    .setTitle(`Quests ${enabled ? 'Enabled' : 'Disabled'}`)
                    .addFields(
                        { name: 'Daily Rewards', value: `+${dailyXp ?? 50} XP, +${dailyCoins ?? 25} coins`, inline: true },
                        { name: 'Weekly Rewards', value: `+${weeklyXp ?? 300} XP, +${weeklyCoins ?? 150} coins`, inline: true }
                    )]
            });
        }
    }
};
