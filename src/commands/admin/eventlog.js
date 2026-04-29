const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('eventlog')
        .setDescription('Configure the event log')
        .addSubcommand(sub =>
            sub.setName('setup')
                .setDescription('Enable event logging')
                .addChannelOption(o => o.setName('channel').setDescription('Channel to send logs to').setRequired(true)))
        .addSubcommand(sub =>
            sub.setName('disable')
                .setDescription('Disable event logging'))
        .addSubcommand(sub =>
            sub.setName('config')
                .setDescription('Toggle individual log types')
                .addStringOption(o =>
                    o.setName('type')
                        .setDescription('Log type to toggle')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Message Edits', value: 'logMessageEdit' },
                            { name: 'Message Deletes', value: 'logMessageDelete' },
                            { name: 'Member Join', value: 'logMemberJoin' },
                            { name: 'Member Leave', value: 'logMemberLeave' },
                            { name: 'Role Changes', value: 'logRoleChanges' },
                            { name: 'Channel Changes', value: 'logChannelChanges' }
                        ))
                .addBooleanOption(o => o.setName('enabled').setDescription('Enable or disable').setRequired(true)))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOneAndUpdate(
            { guildId: interaction.guild.id },
            { $setOnInsert: { name: interaction.guild.name } },
            { upsert: true, new: true }
        );

        if (sub === 'setup') {
            const channel = interaction.options.getChannel('channel');
            guildSettings.eventLog.enabled = true;
            guildSettings.eventLog.channelId = channel.id;
            await guildSettings.save();
            await interaction.reply({ content: `Event logging enabled in ${channel}.` });

        } else if (sub === 'disable') {
            guildSettings.eventLog.enabled = false;
            await guildSettings.save();
            await interaction.reply({ content: 'Event logging disabled.' });

        } else if (sub === 'config') {
            const type = interaction.options.getString('type');
            const enabled = interaction.options.getBoolean('enabled');
            guildSettings.eventLog[type] = enabled;
            await guildSettings.save();

            const labels = {
                logMessageEdit: 'Message Edits',
                logMessageDelete: 'Message Deletes',
                logMemberJoin: 'Member Join',
                logMemberLeave: 'Member Leave',
                logRoleChanges: 'Role Changes',
                logChannelChanges: 'Channel Changes'
            };
            await interaction.reply({ content: `**${labels[type]}** logging ${enabled ? 'enabled' : 'disabled'}.` });
        }
    }
};
