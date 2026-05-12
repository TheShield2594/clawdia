const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const Guild = require('../../models/Guild');
const { SEASONAL_EVENTS } = require('../../data/seasonalEvents');
const { buildClearedEvent } = require('../../services/seasonalEventService');

const EVENT_TYPE_CHOICES = [
    { name: '❄️ Winter Wonderland', value: 'winter_wonderland' },
    { name: '🎃 Spooky Season',     value: 'spooky_season' },
    { name: '☀️ Summer Festival',   value: 'summer_festival' },
    { name: "💝 Valentine's Day",   value: 'valentines_day' },
    { name: '✨ Custom',            value: 'custom' },
];

module.exports = {
    data: new SlashCommandBuilder()
        .setName('event')
        .setDescription('Manage limited-time events')
        .addSubcommand(sub =>
            sub.setName('start')
                .setDescription('Start a limited-time event')
                .addStringOption(o =>
                    o.setName('type')
                        .setDescription('Event type')
                        .setRequired(true)
                        .addChoices(...EVENT_TYPE_CHOICES))
                .addIntegerOption(o =>
                    o.setName('duration_hours')
                        .setDescription('Duration in hours (default: 24)')
                        .setMinValue(1)
                        .setMaxValue(720)
                        .setRequired(false))
                .addStringOption(o =>
                    o.setName('name')
                        .setDescription('Custom event name (for "custom" type or override)')
                        .setRequired(false))
                .addNumberOption(o =>
                    o.setName('coin_multiplier')
                        .setDescription('Coin multiplier (default: 2x for double coins event)')
                        .setMinValue(1.0)
                        .setMaxValue(5.0)
                        .setRequired(false))
                .addNumberOption(o =>
                    o.setName('xp_multiplier')
                        .setDescription('XP multiplier (default: 1.5x for XP boost event)')
                        .setMinValue(1.0)
                        .setMaxValue(5.0)
                        .setRequired(false))
                .addChannelOption(o =>
                    o.setName('announcement_channel')
                        .setDescription('Channel to announce this event in')
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('end')
                .setDescription('End the current event early'))
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Show the currently active event')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'status') {
            return handleStatus(interaction);
        }

        // start and end require ManageGuild
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: 'You need **Manage Server** permission to manage events.', ephemeral: true });
        }

        if (sub === 'start') return handleStart(interaction);
        if (sub === 'end')   return handleEnd(interaction);
    }
};

async function handleStatus(interaction) {
    await interaction.deferReply();

    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    const ev = guildSettings?.activeEvent;

    if (!ev?.type) {
        return interaction.editReply({ content: 'There is no active event on this server right now.' });
    }

    if (ev.endsAt && new Date(ev.endsAt) <= new Date()) {
        return interaction.editReply({ content: 'The last event has expired. No active event right now.' });
    }

    const def = SEASONAL_EVENTS[ev.type];
    const currencyInfo = def?.currency ? `${def.currency.emoji} **${def.currency.name}**` : null;

    const embed = new EmbedBuilder()
        .setColor(ev.color ?? '#5865F2')
        .setTitle(`${ev.emoji ?? '🎉'} ${ev.name}`)
        .addFields(
            { name: 'Started', value: `<t:${Math.floor(new Date(ev.startedAt) / 1000)}:R>`, inline: true },
            { name: 'Ends',    value: ev.endsAt ? `<t:${Math.floor(new Date(ev.endsAt) / 1000)}:R>` : 'Ongoing', inline: true },
            { name: 'Started By', value: ev.startedBy === 'auto' ? '🤖 Auto (seasonal)' : `<@${ev.startedBy}>`, inline: true }
        )
        .setTimestamp();

    if (ev.xpMultiplier > 1)   embed.addFields({ name: '⭐ XP Boost',   value: `${ev.xpMultiplier}x`,   inline: true });
    if (ev.coinMultiplier > 1) embed.addFields({ name: '💰 Coin Boost', value: `${ev.coinMultiplier}x`, inline: true });
    if (currencyInfo) embed.addFields({ name: '🪙 Event Currency', value: currencyInfo, inline: true });

    if (ev.eventShop?.length) {
        const shopLines = ev.eventShop.slice(0, 5)
            .map(s => `${s.emoji || '•'} **${s.name}** — ${s.cost} ${def?.currency?.emoji ?? '🪙'}`)
            .join('\n');
        embed.addFields({ name: '🛒 Event Shop Preview', value: shopLines + (ev.eventShop.length > 5 ? '\n*…and more*' : '') });
    }

    embed.setFooter({ text: 'Use /eventshop to browse and purchase event items' });
    return interaction.editReply({ embeds: [embed] });
}

async function handleStart(interaction) {
    await interaction.deferReply();

    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    const current = guildSettings?.activeEvent;

    if (current?.type && !(current.endsAt && new Date(current.endsAt) <= new Date())) {
        return interaction.editReply({
            content: `There is already an active event: **${current.name}**. Use \`/event end\` first.`
        });
    }

    const type            = interaction.options.getString('type');
    const durationHours   = interaction.options.getInteger('duration_hours') ?? 24;
    const customName      = interaction.options.getString('name');
    const coinMultiplier  = interaction.options.getNumber('coin_multiplier');
    const xpMultiplier    = interaction.options.getNumber('xp_multiplier');
    const announceCh      = interaction.options.getChannel('announcement_channel');

    const def = SEASONAL_EVENTS[type];
    const endsAt = new Date(Date.now() + durationHours * 3_600_000);

    const eventName = customName || def?.name || 'Custom Event';
    const finalCoinMult = coinMultiplier ?? def?.coinMultiplier ?? 2.0;
    const finalXpMult   = xpMultiplier   ?? def?.xpMultiplier   ?? 1.5;

    const shop = def?.shop?.map(s => ({
        itemId:      s.itemId,
        name:        s.name,
        description: s.description ?? '',
        emoji:       s.emoji ?? '',
        cost:        s.cost,
        stock:       s.stock ?? -1
    })) ?? [];

    const newEvent = {
        type,
        name:           eventName,
        emoji:          def?.emoji ?? '🎉',
        color:          def?.color ?? '#5865F2',
        startedAt:      new Date(),
        endsAt,
        coinMultiplier: finalCoinMult,
        xpMultiplier:   finalXpMult,
        startedBy:      interaction.user.id,
        announcementChannelId: announceCh?.id ?? guildSettings?.economy?.announcementChannelId ?? null,
        eventShop:      shop
    };

    await Guild.findOneAndUpdate(
        { guildId: interaction.guild.id },
        {
            $set: { activeEvent: newEvent },
            $setOnInsert: { guildId: interaction.guild.id, name: interaction.guild.name }
        },
        { upsert: true }
    );

    const embed = new EmbedBuilder()
        .setColor(newEvent.color)
        .setTitle(`${newEvent.emoji} Event Started: ${eventName}`)
        .addFields(
            { name: 'Duration',       value: `${durationHours} hours`, inline: true },
            { name: 'Ends',           value: `<t:${Math.floor(endsAt / 1000)}:R>`, inline: true },
            { name: '💰 Coin Boost',  value: `${finalCoinMult}x`, inline: true },
            { name: '⭐ XP Boost',    value: `${finalXpMult}x`, inline: true }
        )
        .setTimestamp();

    if (def?.currency) {
        embed.addFields({ name: '🪙 Event Currency', value: `${def.currency.emoji} ${def.currency.name}` });
    }

    // Post announcement if channel provided
    if (announceCh?.isTextBased()) {
        const announceEmbed = new EmbedBuilder()
            .setColor(newEvent.color)
            .setTitle(`${newEvent.emoji} ${eventName} Has Begun!`)
            .setDescription(buildStartDescription(newEvent, def))
            .setTimestamp();
        announceCh.send({ embeds: [announceEmbed] }).catch(() => {});
    }

    return interaction.editReply({ embeds: [embed] });
}

async function handleEnd(interaction) {
    await interaction.deferReply();

    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    const current = guildSettings?.activeEvent;

    if (!current?.type) {
        return interaction.editReply({ content: 'There is no active event to end.' });
    }

    await Guild.findOneAndUpdate(
        { guildId: interaction.guild.id },
        { $set: { activeEvent: buildClearedEvent() } }
    );

    return interaction.editReply({
        embeds: [new EmbedBuilder()
            .setColor('#888888')
            .setTitle('Event Ended')
            .setDescription(`**${current.name}** has been ended early by ${interaction.user}.`)
            .setTimestamp()]
    });
}

function buildStartDescription(ev, def) {
    const lines = [];
    if (ev.xpMultiplier > 1)   lines.push(`⭐ **${ev.xpMultiplier}x XP** all event long`);
    if (ev.coinMultiplier > 1) lines.push(`💰 **${ev.coinMultiplier}x Coins** all event long`);
    if (def?.currency)          lines.push(`🪙 Earn **${def.currency.name}** ${def.currency.emoji} to spend in the event shop`);
    lines.push(`⏰ Ends <t:${Math.floor(new Date(ev.endsAt) / 1000)}:R>`);
    lines.push('\nUse `/event status` for info and `/eventshop` to spend event currency!');
    return lines.join('\n');
}
