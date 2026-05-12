const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const Guild = require('../../models/Guild');
const { timeRemaining, getServerCoinMultiplier, getServerXpMultiplier } = require('../../services/effectsService');

const BOOST_LABELS = {
    coin: { emoji: '💰', label: 'Coin Boost', description: 'Increases coin earnings from work, daily, and games' },
    xp:   { emoji: '⭐', label: 'XP Boost',   description: 'Increases XP gained from messages'                 },
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('boost')
        .setDescription('Manage server-wide economy boosts (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(sub =>
            sub.setName('server')
                .setDescription('Activate a server-wide boost')
                .addStringOption(o =>
                    o.setName('type')
                        .setDescription('Type of boost to activate')
                        .setRequired(true)
                        .addChoices(
                            { name: '💰 Coin Boost — multiplies all coin earnings', value: 'coin' },
                            { name: '⭐ XP Boost — multiplies XP from messages',    value: 'xp'   }
                        ))
                .addIntegerOption(o =>
                    o.setName('duration')
                        .setDescription('Duration in minutes (1–1440, i.e. up to 24 hours)')
                        .setRequired(true)
                        .setMinValue(1)
                        .setMaxValue(1440))
                .addNumberOption(o =>
                    o.setName('multiplier')
                        .setDescription('Boost strength (e.g. 1.5 for 1.5x, 2 for 2x). Default: 1.5')
                        .setRequired(false)
                        .setMinValue(1.1)
                        .setMaxValue(10.0)))
        .addSubcommand(sub =>
            sub.setName('end')
                .setDescription('End the currently active server boost'))
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Check the current server boost status')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        try {
            let guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
            if (!guildSettings) {
                return interaction.reply({ content: 'Guild settings not found.', ephemeral: true });
            }

            if (sub === 'server') {
                const type       = interaction.options.getString('type');
                const duration   = interaction.options.getInteger('duration');
                const multiplier = interaction.options.getNumber('multiplier') ?? 1.5;
                const expiresAt  = new Date(Date.now() + duration * 60_000);
                const info       = BOOST_LABELS[type];

                guildSettings.serverBoost = {
                    type,
                    multiplier,
                    expiresAt,
                    activatedBy: interaction.user.id,
                };
                await guildSettings.save();

                const announcementChannelId = guildSettings.economy?.announcementChannelId;
                const embed = new EmbedBuilder()
                    .setColor('#f39c12')
                    .setTitle(`🚀 Server Boost Activated!`)
                    .setDescription(`${info.emoji} **${multiplier}x ${info.label}** is now active!\n${info.description}.`)
                    .addFields(
                        { name: 'Multiplier', value: `**${multiplier}x**`,             inline: true },
                        { name: 'Duration',   value: `**${duration} minutes**`,         inline: true },
                        { name: 'Expires',    value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>`, inline: true },
                        { name: 'Activated by', value: `<@${interaction.user.id}>`,    inline: false }
                    )
                    .setTimestamp();

                await interaction.reply({ embeds: [embed] });

                // Announce in configured channel if different from this channel
                if (announcementChannelId && announcementChannelId !== interaction.channel.id) {
                    const announceChannel = interaction.guild.channels.cache.get(announcementChannelId);
                    if (announceChannel?.isTextBased()) {
                        await announceChannel.send({ embeds: [embed] }).catch(console.error);
                    }
                }
                return;
            }

            if (sub === 'end') {
                const sb = guildSettings.serverBoost;
                if (!sb?.type || !sb.expiresAt || new Date(sb.expiresAt).getTime() <= Date.now()) {
                    return interaction.reply({ content: 'There is no active server boost to end.', ephemeral: true });
                }

                const endedType = sb.type;
                guildSettings.serverBoost = { type: null, multiplier: 1.5, expiresAt: null, activatedBy: null };
                await guildSettings.save();

                const info = BOOST_LABELS[endedType];
                const embed = new EmbedBuilder()
                    .setColor('#e74c3c')
                    .setTitle('Server Boost Ended')
                    .setDescription(`${info.emoji} The **${info.label}** has been manually ended.`)
                    .setTimestamp();

                return interaction.reply({ embeds: [embed] });
            }

            if (sub === 'status') {
                const coinMult = getServerCoinMultiplier(guildSettings);
                const xpMult   = getServerXpMultiplier(guildSettings);
                const sb       = guildSettings.serverBoost;
                const isActive = (coinMult > 1.0 || xpMult > 1.0) && sb?.expiresAt;

                if (!isActive) {
                    return interaction.reply({ content: '❌ No server boost is currently active.', ephemeral: true });
                }

                const info = BOOST_LABELS[sb.type];
                const embed = new EmbedBuilder()
                    .setColor('#2ecc71')
                    .setTitle('🚀 Server Boost Status')
                    .addFields(
                        { name: 'Type',       value: `${info.emoji} ${info.label}`,                inline: true },
                        { name: 'Multiplier', value: `**${sb.multiplier}x**`,                      inline: true },
                        { name: 'Remaining',  value: `**${timeRemaining(sb.expiresAt)}**`,          inline: true },
                        { name: 'Expires',    value: `<t:${Math.floor(new Date(sb.expiresAt).getTime() / 1000)}:F>`, inline: false }
                    )
                    .setTimestamp();

                return interaction.reply({ embeds: [embed] });
            }

        } catch (error) {
            console.error('Boost error:', error);
            const errMsg = { content: 'Failed to manage server boost.', ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(errMsg);
            } else {
                await interaction.reply(errMsg);
            }
        }
    }
};
