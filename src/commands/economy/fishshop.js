'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { BAIT_PACKS, CONSUMABLES, ROD_BY_TIER } = require('../../data/fishData');
const { ensureFishingData, activateConsumable } = require('../../services/fishService');

// Build flat choices list for shop items
const SHOP_ITEMS = [
    ...BAIT_PACKS.map(p => ({ name: `${p.emoji} ${p.name} — ${p.cost} coins`, value: p.id, isBaitPack: true, pack: p })),
    ...Object.values(CONSUMABLES).map(c => ({ name: `${c.emoji} ${c.name} — ${c.cost} coins`, value: c.id, isBaitPack: false, consumable: c }))
];

const SHOP_CHOICES = SHOP_ITEMS.map(i => ({ name: i.name, value: i.value }));

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('fishshop')
        .setDescription('Browse and purchase fishing supplies')
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('Browse all available fishing supplies'))
        .addSubcommand(sub =>
            sub.setName('buy')
                .setDescription('Purchase a supply item')
                .addStringOption(o =>
                    o.setName('item')
                        .setDescription('Item to buy')
                        .setRequired(true)
                        .addChoices(...SHOP_CHOICES))
                .addIntegerOption(o =>
                    o.setName('quantity')
                        .setDescription('How many to buy (default 1; bait packs are per-pack)')
                        .setMinValue(1)
                        .setMaxValue(10)
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('use')
                .setDescription('Activate a consumable (bait / luck / xp scroll / energy drink)')
                .addStringOption(o =>
                    o.setName('item')
                        .setDescription('Which consumable to activate')
                        .setRequired(true)
                        .addChoices(
                            { name: '🐟 Chum Bait',         value: 'chum_bait' },
                            { name: '🦐 Premium Chum',      value: 'premium_chum' },
                            { name: '🍀 Angler\'s Luck',    value: 'anglers_luck' },
                            { name: '📜 XP Scroll',         value: 'fish_xp_scroll' },
                            { name: '⚡ Energy Drink',       value: 'energy_drink' }
                        ))),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }
        const currency = guildSettings?.economy?.currency ?? '💰';
        const sub      = interaction.options.getSubcommand();

        const user = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        );
        ensureFishingData(user);

        switch (sub) {
            case 'list': return showList(interaction, currency);
            case 'buy':  return handleBuy(interaction, user, currency);
            case 'use':  return handleUse(interaction, user);
        }
    }
};

// ─── LIST ─────────────────────────────────────────────────────────────────────

async function showList(interaction, currency) {
    const baitSection = BAIT_PACKS.map(p =>
        `${p.emoji} **${p.name}** — ${currency}${p.cost} | \`${p.id}\``
    ).join('\n');

    const consumableSection = Object.values(CONSUMABLES).map(c =>
        `${c.emoji} **${c.name}** — ${currency}${c.cost}\n   *${c.description}*`
    ).join('\n');

    const embed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle('🏪 Fishing Supply Shop')
        .addFields(
            { name: '🪱 Bait Packs', value: baitSection, inline: false },
            { name: '🧪 Consumables', value: consumableSection, inline: false }
        )
        .setFooter({ text: 'Use /fishshop buy <item> to purchase • /fishshop use <item> to activate' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ─── BUY ──────────────────────────────────────────────────────────────────────

async function handleBuy(interaction, user, currency) {
    const itemId   = interaction.options.getString('item');
    const quantity = interaction.options.getInteger('quantity') ?? 1;
    const f        = user.fishing;

    // Check bait packs first
    const baitPack = BAIT_PACKS.find(p => p.id === itemId);
    if (baitPack) {
        const totalCost = baitPack.cost * quantity;
        if (user.balance < totalCost) {
            return interaction.reply({
                content: `You need **${currency}${totalCost.toLocaleString()}** for ${quantity}x **${baitPack.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
                ephemeral: true
            });
        }

        // Check bait stack cap (each pack adds `quantity` to bait type)
        const totalBait = (f.bait[baitPack.baitType] ?? 0) + baitPack.quantity * quantity;
        if (totalBait > 200) {
            return interaction.reply({ content: `You can't carry more than 200 of that bait type.`, ephemeral: true });
        }

        const baitField = `fishing.bait.${baitPack.baitType}`;
        const addedQty  = baitPack.quantity * quantity;

        const updated = await User.findOneAndUpdate(
            {
                userId:   interaction.user.id,
                guildId:  interaction.guild.id,
                balance:  { $gte: totalCost },
                $expr: { $lte: [{ $add: [{ $ifNull: [`$${baitField}`, 0] }, addedQty] }, 200] }
            },
            { $inc: { balance: -totalCost, [baitField]: addedQty } },
            { new: true }
        );

        if (!updated) {
            return interaction.reply({ content: 'Purchase failed. Conditions may have changed — please try again.', ephemeral: true });
        }

        const newBaitQty = updated.fishing?.bait?.[baitPack.baitType] ?? addedQty;
        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor('#2ecc71')
                    .setTitle(`${baitPack.emoji} Purchased!`)
                    .setDescription(`Bought **${quantity}x ${baitPack.name}** (+${addedQty} ${baitPack.baitType.replace(/_/g, ' ')}).`)
                    .addFields(
                        { name: 'Spent',   value: `${currency}${totalCost.toLocaleString()}`,              inline: true },
                        { name: 'Balance', value: `${currency}${updated.balance.toLocaleString()}`,        inline: true },
                        { name: 'Stock',   value: `${newBaitQty} ${baitPack.baitType.replace(/_/g, ' ')}`, inline: true }
                    )
                    .setTimestamp()
            ]
        });
    }

    // Consumable
    const consumable = CONSUMABLES[itemId];
    if (!consumable) {
        return interaction.reply({ content: 'Unknown item.', ephemeral: true });
    }

    const totalCost  = consumable.cost * quantity;
    const currentQty = f.consumables[itemId] ?? 0;
    const newQty     = currentQty + quantity;

    if (user.balance < totalCost) {
        return interaction.reply({
            content: `You need **${currency}${totalCost.toLocaleString()}** for ${quantity}x **${consumable.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            ephemeral: true
        });
    }
    if (newQty > (consumable.maxStack ?? 99)) {
        return interaction.reply({ content: `You can only carry ${consumable.maxStack} **${consumable.name}** at a time.`, ephemeral: true });
    }

    const consumableField = `fishing.consumables.${itemId}`;
    const stackCap        = consumable.maxStack ?? 99;

    const updated = await User.findOneAndUpdate(
        {
            userId:  interaction.user.id,
            guildId: interaction.guild.id,
            balance: { $gte: totalCost },
            $expr: { $lte: [{ $add: [{ $ifNull: [`$${consumableField}`, 0] }, quantity] }, stackCap] }
        },
        { $inc: { balance: -totalCost, [consumableField]: quantity } },
        { new: true }
    );

    if (!updated) {
        return interaction.reply({ content: 'Purchase failed. Conditions may have changed — please try again.', ephemeral: true });
    }

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`${consumable.emoji} Purchased!`)
                .setDescription(`Bought **${quantity}x ${consumable.name}**.`)
                .addFields(
                    { name: 'Spent',   value: `${currency}${totalCost.toLocaleString()}`,                                              inline: true },
                    { name: 'Balance', value: `${currency}${updated.balance.toLocaleString()}`,                                        inline: true },
                    { name: 'Stock',   value: `${updated.fishing?.consumables?.[itemId] ?? quantity} owned`,                           inline: true }
                )
                .setFooter({ text: `Use /fishshop use ${consumable.id} to activate it` })
                .setTimestamp()
        ]
    });
}

// ─── USE ──────────────────────────────────────────────────────────────────────

async function handleUse(interaction, user) {
    const itemId = interaction.options.getString('item');
    const result = activateConsumable(user, itemId);

    if (!result.success) {
        return interaction.reply({ content: result.error, ephemeral: true });
    }

    try {
        await user.save();
    } catch (err) {
        console.error('[fishshop use] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true });
    }

    const def = CONSUMABLES[itemId];
    const f   = user.fishing;

    const statusLines = [];
    if (f.activeBait)    statusLines.push(`🐟 ${f.activeBait.replace(/_/g, ' ')} active (${f.activeBaitCastsLeft} casts left)`);
    if (f.activeLuck)    statusLines.push(`🍀 Angler's Luck queued for next cast`);
    if (f.activeXpScroll) statusLines.push(`📜 XP Scroll queued for next cast`);

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor('#9b59b6')
                .setTitle(`${def?.emoji ?? '✅'} ${def?.name ?? itemId} Activated!`)
                .setDescription(`*${def?.description ?? 'Effect applied.'}*`)
                .addFields({ name: 'Active Buffs', value: statusLines.length ? statusLines.join('\n') : 'None' })
                .setTimestamp()
        ]
    });
}
