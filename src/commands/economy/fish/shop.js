'use strict';

// The /fish shop group: browsing, buying rods, upgrades, bait and consumables,
// using them, repairing a rod, and unlocking a location.

const Guild = require('../../../models/Guild');
const { MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User = require('../../../models/User');
const { attachGrind, persistGrindIfNew } = require('../../../utils/grindProfile');
const {
    ensureFishingData,
    activateConsumable,
    updateRodStatus,
    durabilityBar,
    rodStatusEmoji,
    quoteRepair,
    applyRepair
} = require('../../../services/fishService');
const {
    ROD_TIERS,
    ROD_UPGRADES,
    BAIT_PACKS,
    CONSUMABLES,
    LOCATION_LIST,
    ROD_BY_SLUG,
    ROD_BY_TIER,
    LOCATIONS
} = require('../../../data/fishData');
const { runShopBrowse } = require('../../../utils/shopBrowse');
const { getItemImageAttachment } = require('../../../utils/itemImageHelper');
const GrindProfile = require('../../../models/GrindProfile');
const { chargeBalance, refundBalance } = require('./shared');
const COLORS = require('../../../utils/embedColors');

// ═══════════════════════════════════════════════════════════════════════════════
// SHOP
// ═══════════════════════════════════════════════════════════════════════════════

async function handleShop(interaction, sub) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }
    const currency = guildSettings?.economy?.currency ?? '💰';

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureFishingData(user);

    switch (sub) {
        case 'list':    return showShopList(interaction, user, currency);
        case 'rod':     return handleBuyRod(interaction, user, currency);
        case 'upgrade': return handleBuyUpgrade(interaction, user, currency);
        case 'buy':     return handleBuy(interaction, user, currency);
        case 'use':     return handleUse(interaction, user);
        case 'repair':  return handleRepair(interaction, user, currency);
        case 'unlock':  return handleUnlock(interaction, user, currency);
    }
}

async function showShopList(interaction, user, currency) {
    const f = user.fishing;

    const rodItems = ROD_TIERS.map(r => ({
        imageId: `fish:${r.slug}`,
        name:    r.name,
        price:   r.cost,
        emoji:   r.emoji,
        badge:   `T${r.tier}`
    }));
    const rodList = ROD_TIERS.map(r =>
        `${r.emoji} **T${r.tier} ${r.name}** — ${currency}${r.cost.toLocaleString()} · \`/fish shop rod type:${r.slug}\``
    ).join('\n');

    const upgradeItems = Object.values(ROD_UPGRADES).map(u => ({
        imageId: `fish:${u.id}`,
        name:    u.name,
        emoji:   u.emoji,
        subline: `~${Math.round(u.costMultiplier * 100)}% of rod`
    }));
    const upgradeList = Object.values(ROD_UPGRADES).map(u =>
        `${u.emoji} **${u.name}** — *${u.description}* · \`/fish shop upgrade type:${u.id}\``
    ).join('\n');

    const baitItems = BAIT_PACKS.map(p => ({
        imageId: `fish:${p.id}`,
        name:    p.name,
        price:   p.cost,
        emoji:   p.emoji
    }));
    const baitList = BAIT_PACKS.map(p =>
        `${p.emoji} **${p.name}** — ${currency}${p.cost} · \`/fish shop buy item:${p.id}\``
    ).join('\n');

    const consumableItems = Object.values(CONSUMABLES).map(c => ({
        imageId: `fish:${c.id}`,
        name:    c.name,
        price:   c.cost,
        emoji:   c.emoji
    }));
    const consumableList = Object.values(CONSUMABLES).map(c =>
        `${c.emoji} **${c.name}** — ${currency}${c.cost} · \`/fish shop buy item:${c.id}\``
    ).join('\n');

    const locationItems = LOCATION_LIST.map(loc => {
        const unlocked = f.unlockedLocations.includes(loc.id);
        const isActive = f.activeLocation === loc.id;
        return {
            imageId: `fish:${loc.id}`,
            name:    loc.name,
            emoji:   loc.emoji,
            badge:   isActive ? 'ACTIVE' : (unlocked ? 'OWNED' : `Lv.${loc.unlockLevel}`),
            subline: unlocked ? (isActive ? 'Currently fishing' : 'Unlocked') : (loc.unlockCost > 0 ? `${currency}${loc.unlockCost.toLocaleString()}` : 'Free')
        };
    });
    const locationList = LOCATION_LIST.map(loc => {
        const unlocked = f.unlockedLocations.includes(loc.id);
        const isActive = f.activeLocation === loc.id;
        const status = unlocked
            ? (isActive ? '✅ **ACTIVE**' : '✅ Unlocked')
            : `🔒 Lv.${loc.unlockLevel}${loc.unlockCost > 0 ? ` / ${currency}${loc.unlockCost.toLocaleString()}` : ' (free)'}`;
        return `${loc.emoji} **${loc.name}** — ${status}`;
    }).join('\n');

    return runShopBrowse(interaction, {
        activity: 'fish',
        title:    'Fishing Shop',
        currency,
        // Activity images are per guild since #561; without this the browse view
        // only ever finds the shared pre-#561 rows.
        guildId:  interaction.guild.id,
        footer:   'rod • upgrade • buy • use • repair • unlock',
        pages: [
            { id: 'rods',        label: 'Rods',        emoji: '🎣',  subtitle: 'Better rods, better catches.',           items: rodItems,        listText: rodList        },
            { id: 'upgrades',    label: 'Upgrades',    emoji: '🔧',  subtitle: 'One module per rod, permanent.',         items: upgradeItems,    listText: upgradeList    },
            { id: 'bait',        label: 'Bait',        emoji: '🪱',  subtitle: 'The right bait pulls the right fish.',   items: baitItems,       listText: baitList       },
            { id: 'consumables', label: 'Consumables', emoji: '🧪',  subtitle: 'Luck, XP and quick boosts.',             items: consumableItems, listText: consumableList },
            { id: 'locations',   label: 'Locations',   emoji: '🗺️', subtitle: 'New waters, new species.',                items: locationItems,   listText: locationList   }
        ]
    });
}

async function handleBuyRod(interaction, user, currency) {
    const slug    = interaction.options.getString('type');
    const rodData = ROD_BY_SLUG[slug];

    if (!rodData) {
        return interaction.reply({ content: 'Unknown rod type.', flags: MessageFlags.Ephemeral });
    }
    if (user.balance < rodData.cost) {
        return interaction.reply({
            content: `You need **${currency}${rodData.cost.toLocaleString()}** to buy the **${rodData.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const confirmEmbed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle(`${rodData.emoji} Purchase ${rodData.name}?`)
        .setDescription(rodData.description)
        .addFields(
            { name: 'Cost',         value: `${currency}${rodData.cost.toLocaleString()}`,                                               inline: true },
            { name: 'Durability',   value: `${rodData.baseDurability}`,                                                                  inline: true },
            { name: 'Success Rate', value: `${Math.round(rodData.successRate * 100)}%`,                                                  inline: true },
            { name: 'Rarity Boost', value: rodData.rarityBoost > 0 ? `+${Math.round(rodData.rarityBoost * 100)}%` : 'None',             inline: true },
            { name: 'Bait Type',    value: rodData.requiresBait ? rodData.baitType.replace(/_/g, ' ') : 'No bait needed',               inline: true },
            { name: 'Your Balance', value: `${currency}${user.balance.toLocaleString()}`,                                               inline: true }
        )
        .setFooter({ text: 'Confirmation expires in 30 seconds' });

    const rodImg = await getItemImageAttachment(`fish:${rodData.slug || rodData.id}`, interaction.guild.id, { label: rodData.name }).catch(() => null);
    if (rodImg) confirmEmbed.setThumbnail(rodImg.url);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buyrod_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('buyrod_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const fishConfirmPayload = { embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, fetchReply: true };
    if (rodImg) fishConfirmPayload.files = [rodImg.attachment];
    const reply = await interaction.reply(fishConfirmPayload);
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
        }
        collector.stop();

        if (btn.customId === 'buyrod_cancel') {
            return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
        }

        const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        await attachGrind(freshUser);
        ensureFishingData(freshUser);

        // The charge is a guarded atomic debit, not `balance -= cost` followed by
        // a save. This runs in a button callback up to 30 seconds after the
        // confirmation was drawn, and `save()` writes balance as an absolute
        // `$set` — long enough for a casino bet in another channel to be wiped by
        // a rod purchase. The lock the command holds does not help: casino takes
        // a different key.
        const debited = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: rodData.cost } },
            { $inc: { balance: -rodData.cost } },
            { new: true, projection: { balance: 1 } },
        );
        if (!debited) {
            return btn.update({ content: `Insufficient funds. You need ${currency}${rodData.cost.toLocaleString()}.`, embeds: [], components: [] });
        }

        // Take the authoritative balance and keep the save off that path.
        freshUser.balance = debited.balance;
        freshUser.unmarkModified('balance');
        freshUser.fishing.rods.push({
            name:              rodData.name,
            tier:              rodData.tier,
            slug:              rodData.slug,
            currentDurability: rodData.baseDurability,
            maxDurability:     rodData.baseDurability,
            baseDurability:    rodData.baseDurability,
            repairCount:       0,
            upgrade:           null,
            status:            'good'
        });
        freshUser.markModified('fishing');

        try {
            await freshUser.save();
        } catch (err) {
            console.error('[fishshop rod] save error:', err);
            // The coins are already gone; hand them back rather than charging for
            // a rod that was never added.
            await User.updateOne(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $inc: { balance: rodData.cost } },
            ).catch(refundErr => console.error('[fishshop rod] refund after failed save:', refundErr));
            return btn.update({ content: 'Something went wrong and your coins were refunded. Please try again.', embeds: [], components: [] });
        }

        const rodIndex = freshUser.fishing.rods.length;
        return btn.update({
            embeds: [
                new EmbedBuilder()
                    .setColor(COLORS.SUCCESS)
                    .setTitle(`${rodData.emoji} ${rodData.name} Purchased!`)
                    .setDescription(`You now own a **${rodData.name}**. Equip it with \`/fish inv equip ${rodIndex}\`.`)
                    .addFields(
                        { name: 'Spent',   value: `${currency}${rodData.cost.toLocaleString()}`,      inline: true },
                        { name: 'Balance', value: `${currency}${freshUser.balance.toLocaleString()}`, inline: true }
                    )
            ],
            components: []
        });
    });

    collector.on('end', (_, reason) => {
        if (reason === 'time') {
            interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
        }
    });
}

async function handleBuyUpgrade(interaction, user, currency) {
    const f = user.fishing;

    if (f.equippedRodIndex < 0 || !f.rods[f.equippedRodIndex]) {
        return interaction.reply({ content: `You don't have a rod equipped. Use \`/fish inv equip\` first.`, flags: MessageFlags.Ephemeral });
    }

    const upgradeId  = interaction.options.getString('type');
    const upgradeDef = ROD_UPGRADES[upgradeId];

    if (!upgradeDef) {
        return interaction.reply({ content: 'Unknown upgrade.', flags: MessageFlags.Ephemeral });
    }

    const targetRodIndex = f.equippedRodIndex;
    const rod     = f.rods[targetRodIndex];
    const rodData = ROD_BY_TIER[rod.tier];
    const cost    = Math.round(rodData.cost * upgradeDef.costMultiplier);

    if (rod.upgrade) {
        return interaction.reply({
            content: `Your **${rod.name}** already has the **${rod.upgrade.replace(/_/g, ' ')}** upgrade. Each rod can only hold one upgrade.`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (user.balance < cost) {
        return interaction.reply({
            content: `You need **${currency}${cost.toLocaleString()}** to install **${upgradeDef.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const confirmEmbed = new EmbedBuilder()
        .setColor(COLORS.RARE)
        .setTitle(`${upgradeDef.emoji} Install ${upgradeDef.name}?`)
        .setDescription(`Installing on **${rod.name}**\n${upgradeDef.description}`)
        .addFields(
            { name: 'Cost',         value: `${currency}${cost.toLocaleString()}`,      inline: true },
            { name: 'Your Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true }
        )
        .setFooter({ text: 'One upgrade per rod. This cannot be removed.' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('upgrade_confirm').setLabel('Install').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('upgrade_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, fetchReply: true });
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
        }
        collector.stop();

        if (btn.customId === 'upgrade_cancel') {
            return btn.update({ content: 'Installation cancelled.', embeds: [], components: [] });
        }

        const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        await attachGrind(freshUser);
        ensureFishingData(freshUser);

        const freshRod = freshUser.fishing.rods[targetRodIndex];
        if (!freshRod) {
            return btn.update({ content: 'That rod is no longer in your inventory.', embeds: [], components: [] });
        }
        if (freshRod.upgrade) {
            return btn.update({ content: `**${freshRod.name}** already has an upgrade installed.`, embeds: [], components: [] });
        }

        // Guarded atomic debit for the same reason as the rod purchase above: this
        // lands up to 30 seconds after the prompt, and a `save()` would write an
        // absolute balance over anything spent in between. Charged only once the
        // rod is known to be upgradeable, so a rejected install costs nothing.
        const debited = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: cost } },
            { $inc: { balance: -cost } },
            { new: true, projection: { balance: 1 } },
        );
        if (!debited) {
            return btn.update({ content: 'Insufficient funds.', embeds: [], components: [] });
        }

        freshUser.balance = debited.balance;
        freshUser.unmarkModified('balance');
        freshRod.upgrade   = upgradeId;
        freshUser.markModified('fishing');

        try {
            await freshUser.save();
        } catch (err) {
            console.error('[fishshop upgrade] save error:', err);
            // The coins are already gone; hand them back rather than charging for
            // an upgrade that was never installed.
            await User.updateOne(
                { userId: interaction.user.id, guildId: interaction.guild.id },
                { $inc: { balance: cost } },
            ).catch(refundErr => console.error('[fishshop upgrade] refund after failed save:', refundErr));
            return btn.update({ content: 'Something went wrong and your coins were refunded. Please try again.', embeds: [], components: [] });
        }

        return btn.update({
            embeds: [
                new EmbedBuilder()
                    .setColor(COLORS.SUCCESS)
                    .setTitle(`${upgradeDef.emoji} ${upgradeDef.name} Installed!`)
                    .setDescription(`**${freshRod.name}** now has **${upgradeDef.name}** installed permanently.`)
                    .addFields(
                        { name: 'Effect',  value: upgradeDef.description,                       inline: true },
                        { name: 'Balance', value: `${currency}${freshUser.balance.toLocaleString()}`, inline: true }
                    )
            ],
            components: []
        });
    });

    collector.on('end', (_, reason) => {
        if (reason === 'time') {
            interaction.editReply({ content: 'Installation timed out.', embeds: [], components: [] }).catch(() => {});
        }
    });
}

async function handleBuy(interaction, user, currency) {
    const itemId   = interaction.options.getString('item');
    const quantity = interaction.options.getInteger('quantity') ?? 1;
    const f        = user.fishing;

    const baitPack   = BAIT_PACKS.find(p => p.id === itemId);
    const consumable = baitPack ? null : CONSUMABLES[itemId];
    const itemDef    = baitPack ?? consumable;

    if (!itemDef) {
        return interaction.reply({ content: 'Unknown item.', flags: MessageFlags.Ephemeral });
    }

    const totalCost = itemDef.cost * quantity;
    if (user.balance < totalCost) {
        return interaction.reply({
            content: `You need **${currency}${totalCost.toLocaleString()}** for ${quantity}× **${itemDef.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    if (baitPack) {
        const totalBait = (f.bait[baitPack.baitType] ?? 0) + baitPack.quantity * quantity;
        if (totalBait > 200) {
            return interaction.reply({ content: `You can't carry more than 200 of that bait type.`, flags: MessageFlags.Ephemeral });
        }
    } else {
        const currentQty = f.consumables[itemId] ?? 0;
        if (currentQty + quantity > (consumable.maxStack ?? 99)) {
            return interaction.reply({ content: `You can only carry ${consumable.maxStack} **${consumable.name}** at a time.`, flags: MessageFlags.Ephemeral });
        }
    }

    const gainedLabel = baitPack
        ? `${baitPack.quantity * quantity} ${baitPack.baitType.replace(/_/g, ' ')}`
        : `${quantity}× ${consumable.name}`;
    const currentStock = baitPack
        ? `${f.bait[baitPack.baitType] ?? 0} in stock`
        : `${f.consumables[itemId] ?? 0}/${consumable.maxStack ?? 99} in stock`;

    const confirmEmbed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle(`${itemDef.emoji} Confirm Purchase`)
        .setDescription(itemDef.description ?? '')
        .addFields(
            { name: 'Item',         value: itemDef.name,                                 inline: true },
            { name: 'Quantity',     value: gainedLabel,                                  inline: true },
            { name: 'Total Cost',   value: `${currency}${totalCost.toLocaleString()}`,   inline: true },
            { name: 'Your Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true },
            { name: 'Currently',    value: currentStock,                                  inline: true }
        )
        .setFooter({ text: 'Confirmation expires in 30 seconds' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('fishbuy_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('fishbuy_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, fetchReply: true });
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
        }
        collector.stop();

        if (btn.customId === 'fishbuy_cancel') {
            return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
        }

        try {
            await btn.deferUpdate();

            if (baitPack) {
                const baitField = `data.bait.${baitPack.baitType}`;
                const addedQty  = baitPack.quantity * quantity;

                await persistGrindIfNew(user, 'fishing');
                const updated = await User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: totalCost } },
                    { $inc: { balance: -totalCost } },
                    { new: true }
                );
                if (!updated) {
                    return interaction.editReply({ content: 'Purchase failed. Conditions may have changed — please try again.', embeds: [], components: [] });
                }

                const profUpdated = await GrindProfile.findOneAndUpdate(
                    {
                        userId:  interaction.user.id,
                        guildId: interaction.guild.id,
                        system:  'fishing',
                        $expr: { $lte: [{ $add: [{ $ifNull: [`$${baitField}`, 0] }, addedQty] }, 200] }
                    },
                    { $inc: { [baitField]: addedQty } },
                    { new: true }
                ).catch(() => null);

                if (!profUpdated) {
                    await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } }).catch(() => {});
                    return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
                }

                f.bait[baitPack.baitType] = profUpdated.data?.bait?.[baitPack.baitType] ?? addedQty;
                return interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(COLORS.SUCCESS)
                            .setTitle(`${baitPack.emoji} Purchased!`)
                            .setDescription(`Bought **${quantity}× ${baitPack.name}** (+${addedQty} ${baitPack.baitType.replace(/_/g, ' ')}).`)
                            .addFields(
                                { name: 'Spent',   value: `${currency}${totalCost.toLocaleString()}`,                           inline: true },
                                { name: 'Balance', value: `${currency}${updated.balance.toLocaleString()}`,                      inline: true },
                                { name: 'Stock',   value: `${f.bait[baitPack.baitType]} ${baitPack.baitType.replace(/_/g, ' ')}`, inline: true }
                            )
                            .setTimestamp()
                    ],
                    components: []
                });
            }

            // consumable path
            const consumableField = `data.consumables.${itemId}`;
            const stackCap        = consumable.maxStack ?? 99;

            await persistGrindIfNew(user, 'fishing');
            const updated = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: totalCost } },
                { $inc: { balance: -totalCost } },
                { new: true }
            );
            if (!updated) {
                return interaction.editReply({ content: 'Purchase failed. Conditions may have changed — please try again.', embeds: [], components: [] });
            }

            const profUpdated = await GrindProfile.findOneAndUpdate(
                {
                    userId:  interaction.user.id,
                    guildId: interaction.guild.id,
                    system:  'fishing',
                    $expr: { $lte: [{ $add: [{ $ifNull: [`$${consumableField}`, 0] }, quantity] }, stackCap] }
                },
                { $inc: { [consumableField]: quantity } },
                { new: true }
            ).catch(() => null);

            if (!profUpdated) {
                await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } }).catch(() => {});
                return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
            }

            f.consumables[itemId] = profUpdated.data?.consumables?.[itemId] ?? quantity;

            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(COLORS.SUCCESS)
                        .setTitle(`${consumable.emoji} Purchased!`)
                        .setDescription(`Bought **${quantity}× ${consumable.name}**.`)
                        .addFields(
                            { name: 'Spent',   value: `${currency}${totalCost.toLocaleString()}`,   inline: true },
                            { name: 'Balance', value: `${currency}${updated.balance.toLocaleString()}`, inline: true },
                            { name: 'Stock',   value: `${f.consumables[itemId]} owned`,              inline: true }
                        )
                        .setFooter({ text: `Use /fish shop use ${consumable.id} to activate it` })
                        .setTimestamp()
                ],
                components: []
            });
        } catch (err) {
            console.error('[fishshop buy] purchase error:', err);
            interaction.editReply({ content: 'Something went wrong. Please try again.', embeds: [], components: [] }).catch(() => {});
        }
    });

    collector.on('end', (_, reason) => {
        if (reason === 'time') {
            interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
        }
    });
}

async function handleUse(interaction, user) {
    const itemId = interaction.options.getString('item');
    const result = activateConsumable(user, itemId);

    if (!result.success) {
        return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
    }

    try {
        await user.save();
    } catch (err) {
        console.error('[fishshop use] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
    }

    const def = CONSUMABLES[itemId];
    const f   = user.fishing;

    const statusLines = [];
    if (f.activeBait)     statusLines.push(`🐟 ${f.activeBait.replace(/_/g, ' ')} active (${f.activeBaitCastsLeft} casts left)`);
    if (f.activeLuck)     statusLines.push(`🍀 Angler's Luck queued for next cast`);
    if (f.activeXpScroll) statusLines.push(`📜 XP Scroll queued for next cast`);

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(COLORS.RARE)
                .setTitle(`${def?.emoji ?? '✅'} ${def?.name ?? itemId} Activated!`)
                .setDescription(`*${def?.description ?? 'Effect applied.'}*`)
                .addFields({ name: 'Active Buffs', value: statusLines.length ? statusLines.join('\n') : 'None' })
                .setTimestamp()
        ]
    });
}

async function handleRepair(interaction, user, currency) {
    const f = user.fishing;

    if (f.equippedRodIndex < 0 || !f.rods[f.equippedRodIndex]) {
        return interaction.reply({ content: `You don't have a rod equipped. Buy one with \`/fish shop rod\`.`, flags: MessageFlags.Ephemeral });
    }

    const rod    = f.rods[f.equippedRodIndex];
    const method = interaction.options.getString('method');

    if (method === 'kit') {
        const kitId = interaction.options.getString('kit');
        if (!kitId) {
            return interaction.reply({ content: 'Please specify a kit size using the `kit` option.', flags: MessageFlags.Ephemeral });
        }

        const kitStock   = f.consumables[kitId] ?? 0;
        const kitRestore = kitId === 'repair_kit_small' ? 20 : 50;
        const kitName    = kitId === 'repair_kit_small' ? 'Small Repair Kit' : 'Large Repair Kit';

        if (kitStock <= 0) {
            return interaction.reply({ content: `You don't have any **${kitName}**. Buy one with \`/fish shop buy\`.`, flags: MessageFlags.Ephemeral });
        }
        if (rod.status === 'condemned') {
            return interaction.reply({ content: 'This rod is condemned and cannot be repaired.', flags: MessageFlags.Ephemeral });
        }
        if (rod.currentDurability >= rod.maxDurability && rod.status !== 'broken') {
            return interaction.reply({ content: 'Your rod is already at full durability.', flags: MessageFlags.Ephemeral });
        }

        const restored = Math.min(kitRestore, rod.maxDurability - rod.currentDurability);
        rod.currentDurability = Math.min(rod.maxDurability, rod.currentDurability + restored);
        updateRodStatus(rod);
        f.consumables[kitId] -= 1;
        user.markModified('fishing');

        try {
            await user.save();
        } catch (err) {
            console.error('[fishshop repair kit] save error:', err);
            return interaction.reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
        }

        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor(COLORS.SUCCESS)
                    .setTitle(`${kitId === 'repair_kit_small' ? '🔧' : '🔨'} ${kitName} Used`)
                    .addFields(
                        { name: 'Rod',       value: rod.name,                                                                               inline: true },
                        { name: 'Restored',  value: `+${restored} durability`,                                                              inline: true },
                        { name: 'Remaining', value: `${kitStock - 1} kit(s) left`,                                                          inline: true },
                        { name: 'Durability',value: `${durabilityBar(rod.currentDurability, rod.maxDurability)} ${rod.currentDurability}/${rod.maxDurability}`, inline: false },
                        { name: 'Status',    value: `${rodStatusEmoji(rod.status)} ${rod.status}`,                                          inline: true }
                    )
                    .setFooter({ text: 'Repair kits do not degrade max durability.' })
                    .setTimestamp()
            ]
        });
    }

    const requestedAmount = interaction.options.getInteger('amount') ?? null;

    // Price the repair before committing — applying it permanently degrades the
    // rod's max durability, which must not happen on a quote the player can't buy.
    const quote = quoteRepair(rod, requestedAmount);
    if (quote.error) {
        return interaction.reply({ content: quote.error, flags: MessageFlags.Ephemeral });
    }
    if (user.balance < quote.cost) {
        return interaction.reply({
            content: `Repairing **${quote.restoredAmount}** durability costs **${currency}${quote.cost.toLocaleString()}**. You only have **${currency}${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const result = applyRepair(rod, requestedAmount);
    const charged = await chargeBalance(interaction, result.cost);
    if (!charged) {
        return interaction.reply({
            content: `Repairing **${result.restoredAmount}** durability costs **${currency}${result.cost.toLocaleString()}** — you no longer have enough. Check \`/balance\` and try again.`,
            flags: MessageFlags.Ephemeral
        });
    }
    // Take the authoritative balance and keep the save off that path.
    user.balance = charged.balance;
    user.unmarkModified('balance');
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[fishshop repair shop] save error:', err);
        await refundBalance(interaction, result.cost);
        return interaction.reply({ content: 'The repair failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
    }

    const embed = new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setTitle('🔧 Rod Repaired')
        .addFields(
            { name: 'Rod',        value: rod.name,                                                                               inline: true },
            { name: 'Restored',   value: `+${result.restoredAmount} durability`,                                                 inline: true },
            { name: 'Cost',       value: `${currency}${result.cost.toLocaleString()}`,                                           inline: true },
            { name: 'Durability', value: `${durabilityBar(rod.currentDurability, rod.maxDurability)} ${rod.currentDurability}/${rod.maxDurability}`, inline: false },
            { name: 'Status',     value: `${rodStatusEmoji(rod.status)} ${rod.status}`,                                          inline: true },
            { name: 'Balance',    value: `${currency}${user.balance.toLocaleString()}`,                                          inline: true }
        )
        .setTimestamp();

    if (result.condemned) {
        embed.setColor(COLORS.ERROR);
        embed.addFields({ name: '⚠️ Condemned', value: 'This rod has been repaired too many times and cannot be repaired again. Consider buying a new one with `/fish shop rod`.', inline: false });
    } else {
        embed.addFields({ name: 'ℹ️ Note', value: `Max durability slightly reduced to ${rod.maxDurability} after this repair.`, inline: false });
    }

    return interaction.reply({ embeds: [embed] });
}

async function handleUnlock(interaction, user, currency) {
    const f          = user.fishing;
    const locationId = interaction.options.getString('location');
    const location   = LOCATIONS[locationId];

    if (!location) {
        return interaction.reply({ content: 'Unknown location.', flags: MessageFlags.Ephemeral });
    }
    if (f.unlockedLocations.includes(locationId)) {
        return interaction.reply({ content: `**${location.name}** is already unlocked.`, flags: MessageFlags.Ephemeral });
    }
    if (f.level < location.unlockLevel) {
        return interaction.reply({
            content: `You need Fisher Level **${location.unlockLevel}** to unlock **${location.name}**. You are Level **${f.level}**.`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (user.balance < location.unlockCost) {
        return interaction.reply({
            content: `Unlocking **${location.name}** costs **${currency}${location.unlockCost.toLocaleString()}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // Phase 1: claim the unlock on the fishing profile (level gate + not-yet-unlocked)
    await persistGrindIfNew(user, 'fishing');
    const profUpdated = await GrindProfile.findOneAndUpdate(
        {
            userId:  interaction.user.id,
            guildId: interaction.guild.id,
            system:  'fishing',
            'data.level': { $gte: location.unlockLevel },
            'data.unlockedLocations': { $ne: locationId }
        },
        {
            $addToSet: { 'data.unlockedLocations': locationId },
            $set:      { 'data.activeLocation': locationId }
        },
        { new: true }
    ).catch(() => null);

    if (!profUpdated) {
        return interaction.reply({ content: 'Purchase failed. Conditions may have changed — please try again.', flags: MessageFlags.Ephemeral });
    }

    // Phase 2: charge the unlock cost; roll the unlock back if the debit fails
    const updated = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: location.unlockCost } },
        { $inc: { balance: -location.unlockCost } },
        { new: true }
    );

    if (!updated) {
        await GrindProfile.updateOne(
            { userId: interaction.user.id, guildId: interaction.guild.id, system: 'fishing' },
            { $pull: { 'data.unlockedLocations': locationId }, $set: { 'data.activeLocation': user.fishing.activeLocation } }
        ).catch(() => {});
        return interaction.reply({ content: 'Purchase failed. Conditions may have changed — please try again.', flags: MessageFlags.Ephemeral });
    }

    // Sync the in-memory profile so a later save doesn't clobber the unlock
    user.fishing.unlockedLocations = profUpdated.data.unlockedLocations;
    user.fishing.activeLocation    = locationId;

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(COLORS.WARN)
                .setTitle(`🗺️ ${location.emoji} ${location.name} Unlocked!`)
                .setDescription(location.description)
                .addFields(
                    { name: 'Cost Paid', value: location.unlockCost > 0 ? `${currency}${location.unlockCost.toLocaleString()}` : 'Free', inline: true },
                    { name: 'Balance',   value: `${currency}${updated.balance.toLocaleString()}`,                                          inline: true },
                    { name: 'Status',    value: 'Now your active location!',                                                              inline: true }
                )
                .setFooter({ text: 'Use /fish cast to start catching from this location • Switch anytime with /fish location set' })
                .setTimestamp()
        ]
    });
}

module.exports = {
    handleBuy,
    handleBuyRod,
    handleBuyUpgrade,
    handleRepair,
    handleShop,
    handleUnlock,
    handleUse,
    showShopList,
};
