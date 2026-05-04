const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const Guild = require('../../models/Guild');

const ACTIONS = ['channelDelete', 'channelCreate', 'roleDelete', 'roleCreate', 'ban', 'kick', 'webhookCreate'];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('antinuke')
        .setDescription('Configure anti-nuke protection (mass-action burst detection + auto-lockdown)')
        .addSubcommand(s => s.setName('status').setDescription('Show current anti-nuke configuration'))
        .addSubcommand(s => s.setName('enable')
            .setDescription('Enable anti-nuke and optionally set defaults')
            .addChannelOption(o => o.setName('alert_channel').setDescription('Where to send anti-nuke alerts').setRequired(false))
            .addStringOption(o => o.setName('punishment').setDescription('What to do to the offender')
                .addChoices(
                    { name: 'Alert only', value: 'alert' },
                    { name: 'Strip roles', value: 'strip-roles' },
                    { name: 'Kick',        value: 'kick' },
                    { name: 'Ban',         value: 'ban' }
                ).setRequired(false))
            .addBooleanOption(o => o.setName('auto_lockdown').setDescription('Auto-lock the server when triggered').setRequired(false)))
        .addSubcommand(s => s.setName('disable').setDescription('Disable anti-nuke'))
        .addSubcommand(s => s.setName('threshold')
            .setDescription('Set burst threshold for an action')
            .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true)
                .addChoices(...ACTIONS.map(a => ({ name: a, value: a }))))
            .addIntegerOption(o => o.setName('count').setDescription('Trigger after N actions').setRequired(true).setMinValue(1))
            .addIntegerOption(o => o.setName('window_seconds').setDescription('Sliding window (default 30)').setMinValue(5).setRequired(false)))
        .addSubcommand(s => s.setName('whitelist-add')
            .setDescription('Add a user or role to the bypass whitelist')
            .addUserOption(o => o.setName('user').setDescription('User to whitelist').setRequired(false))
            .addRoleOption(o => o.setName('role').setDescription('Role to whitelist').setRequired(false)))
        .addSubcommand(s => s.setName('whitelist-remove')
            .setDescription('Remove a user or role from the bypass whitelist')
            .addUserOption(o => o.setName('user').setDescription('User').setRequired(false))
            .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(false)))
        .addSubcommand(s => s.setName('joingate')
            .setDescription('Configure the join gate (reject young accounts)')
            .addBooleanOption(o => o.setName('enabled').setDescription('Enable join gate').setRequired(true))
            .addIntegerOption(o => o.setName('min_account_age_days').setDescription('Reject accounts younger than N days').setMinValue(0).setRequired(false))
            .addStringOption(o => o.setName('action').setDescription('What to do').setRequired(false)
                .addChoices({ name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' })))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        if (sub === 'status') {
            const settings = await Guild.findOne({ guildId });
            const an = settings?.antiNuke || {};
            const t = an.thresholds || {};
            const embed = new EmbedBuilder()
                .setColor(an.enabled ? '#00ff00' : '#888888')
                .setTitle(`Anti-Nuke: ${an.enabled ? 'ENABLED' : 'DISABLED'}`)
                .addFields(
                    { name: 'Punishment', value: an.punishment || 'strip-roles', inline: true },
                    { name: 'Window',     value: `${an.windowSeconds || 30}s`,    inline: true },
                    { name: 'Auto-Lockdown', value: an.autoLockdown ? 'on' : 'off', inline: true },
                    { name: 'Alert Channel', value: an.alertChannelId ? `<#${an.alertChannelId}>` : '*(uses mod log)*', inline: false },
                    { name: 'Thresholds', value: ACTIONS.map(a => `\`${a}\`: ${t[a] ?? '—'}`).join('\n'), inline: false },
                    { name: 'Whitelist Users', value: (an.whitelistUserIds || []).map(id => `<@${id}>`).join(' ') || '*(none)*', inline: false },
                    { name: 'Whitelist Roles', value: (an.whitelistRoleIds || []).map(id => `<@&${id}>`).join(' ') || '*(none)*', inline: false },
                    { name: 'Join Gate', value: an.joinGate?.enabled
                        ? `enabled — reject accounts <${an.joinGate.minAccountAgeDays}d (${an.joinGate.action})`
                        : 'disabled', inline: false },
                    { name: 'Lockdown', value: an.lockdown?.active
                        ? `ACTIVE since <t:${Math.floor(new Date(an.lockdown.startedAt).getTime() / 1000)}:R>`
                        : 'inactive', inline: false }
                );
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (sub === 'enable') {
            const update = { 'antiNuke.enabled': true };
            const ch = interaction.options.getChannel('alert_channel');
            const punishment = interaction.options.getString('punishment');
            const autoLockdown = interaction.options.getBoolean('auto_lockdown');
            if (ch) update['antiNuke.alertChannelId'] = ch.id;
            if (punishment) update['antiNuke.punishment'] = punishment;
            if (autoLockdown != null) update['antiNuke.autoLockdown'] = autoLockdown;
            await Guild.updateOne({ guildId }, { $set: update }, { upsert: true });
            return interaction.reply({ content: 'Anti-nuke enabled.', ephemeral: true });
        }

        if (sub === 'disable') {
            await Guild.updateOne({ guildId }, { $set: { 'antiNuke.enabled': false } });
            return interaction.reply({ content: 'Anti-nuke disabled.', ephemeral: true });
        }

        if (sub === 'threshold') {
            const action = interaction.options.getString('action');
            const count = interaction.options.getInteger('count');
            const window = interaction.options.getInteger('window_seconds');
            const update = { [`antiNuke.thresholds.${action}`]: count };
            if (window != null) update['antiNuke.windowSeconds'] = window;
            await Guild.updateOne({ guildId }, { $set: update });
            return interaction.reply({
                content: `Threshold for \`${action}\` set to **${count}**${window ? ` (window ${window}s)` : ''}.`,
                ephemeral: true
            });
        }

        if (sub === 'whitelist-add' || sub === 'whitelist-remove') {
            const user = interaction.options.getUser('user');
            const role = interaction.options.getRole('role');
            if (!user && !role) {
                return interaction.reply({ content: 'Provide a user or a role.', ephemeral: true });
            }
            const op = sub === 'whitelist-add' ? '$addToSet' : '$pull';
            const update = {};
            if (user) update['antiNuke.whitelistUserIds'] = user.id;
            if (role) update['antiNuke.whitelistRoleIds'] = role.id;
            await Guild.updateOne({ guildId }, { [op]: update });
            return interaction.reply({
                content: `Whitelist updated.${user ? ` User: <@${user.id}>` : ''}${role ? ` Role: <@&${role.id}>` : ''}`,
                ephemeral: true
            });
        }

        if (sub === 'joingate') {
            const enabled = interaction.options.getBoolean('enabled');
            const minAge = interaction.options.getInteger('min_account_age_days');
            const action = interaction.options.getString('action');
            const update = { 'antiNuke.joinGate.enabled': enabled };
            if (minAge != null) update['antiNuke.joinGate.minAccountAgeDays'] = minAge;
            if (action)         update['antiNuke.joinGate.action'] = action;
            await Guild.updateOne({ guildId }, { $set: update });
            return interaction.reply({
                content: `Join gate ${enabled ? 'enabled' : 'disabled'}.`,
                ephemeral: true
            });
        }
    }
};
