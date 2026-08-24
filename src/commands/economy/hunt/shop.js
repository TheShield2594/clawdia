'use strict';

// The /hunt shop group: browsing, buying weapons, upgrades, ammo and
// consumables, using them, repairing a weapon, and unlocking a zone.

const Guild = require('../../../models/Guild');
const { MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User = require('../../../models/User');
const { attachGrind, persistGrindIfNew } = require('../../../utils/grindProfile');
const {
    ensureHuntData,
    projectWeaponLifetime,
    activateConsumable,
    getMaxStamina,
    isCondemned,
    updateWeaponStatus,
    durabilityBar,
    quoteRepair,
    applyRepair,
    weaponStatusEmoji,
    repairsRemaining
} = require('../../../services/huntService');
const {
    LIMITS,
    WEAPON_TIERS,
    WEAPON_UPGRADES,
    AMMO_PACKS,
    CONSUMABLES,
    ZONE_LIST,
    WEAPON_BY_SLUG,
    WEAPON_BY_TIER,
    ZONES,
    MATERIAL_NAMES
} = require('../../../data/huntData');
const { runShopBrowse } = require('../../../utils/shopBrowse');
const { getItemImageAttachment } = require('../../../utils/itemImageHelper');
const GrindProfile = require('../../../models/GrindProfile');
const { ACTIVATABLE, chargeBalance, refundBalance } = require('./shared');

// ═══════════════════════════════════════════════════════════════════════════════
// SHOP (was /huntshop)
// ═══════════════════════════════════════════════════════════════════════════════

async function executeShop(interaction, sub) {
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
    ensureHuntData(user);

    switch (sub) {
        case 'list':    return showShopList(interaction, user, currency);
        case 'weapon':  return handleBuyWeapon(interaction, user, currency);
        case 'upgrade': return handleBuyUpgrade(interaction, user, currency);
        case 'buy':     return handleBuy(interaction, user, currency);
        case 'use':     return handleUse(interaction, user);
        case 'repair':  return handleRepair(interaction, user, currency);
        case 'unlock':  return handleUnlock(interaction, user, currency);
    }
}

const CROSS_ECONOMY_DAYS = 30;

function huntingDaysFor(cost) {
    return cost / LIMITS.DAILY_SOFT_CAP;
}

function fullRepairCost(weapon) {
    return Math.ceil(weapon.baseDurability / 20) * weapon.repairCostPer20;
}

function isCrossEconomyWeapon(weapon) {
    return huntingDaysFor(weapon.cost) > CROSS_ECONOMY_DAYS;
}

function huntingDaysLabel(cost) {
    const days = huntingDaysFor(cost);
    return days >= 10 ? Math.round(days) : Math.round(days * 10) / 10;
}

async function showShopList(interaction, user, currency) {
    const h = user.hunt;

    const weaponItems = WEAPON_TIERS.map(w => ({
        imageId: `hunt:${w.slug}`,
        name:    w.name,
        price:   w.cost,
        emoji:   w.emoji,
        badge:   `T${w.tier}`,
        subline: `${Math.round(w.successRate * 100)}% • +${Math.round(w.rarityBoost * 100)}% rare`
            + (isCrossEconomyWeapon(w) ? ` • 🌐 ~${huntingDaysLabel(w.cost)}d of hunting` : '')
    }));
    const weaponLines = WEAPON_TIERS.map(w =>
        `${w.emoji} **${w.name}** — ${currency}${w.cost.toLocaleString()}`
        + (isCrossEconomyWeapon(w) ? ` 🌐` : '')
        + ` · \`/hunt shop weapon type:${w.slug}\``
    );
    // The legend goes in the embed description rather than the banner subtitle:
    // the banner is drawn with fillText on a canvas, which has no line breaks.
    if (WEAPON_TIERS.some(isCrossEconomyWeapon)) {
        weaponLines.push('', '🌐 *Costs more than hunting alone can fund — casino, work, crime and the rest all pay into the same wallet.*');
    }
    const weaponList = weaponLines.join('\n');

    const upgradeItems = Object.values(WEAPON_UPGRADES).map(u => ({
        imageId: `hunt:${u.id}`,
        name:    u.name,
        emoji:   u.emoji,
        subline: `~${Math.round(u.costMultiplier * 100)}% of weapon`
    }));
    const upgradeList = Object.values(WEAPON_UPGRADES).map(u =>
        `${u.emoji} **${u.name}** — *${u.description}* · \`/hunt shop upgrade module:${u.id}\``
    ).join('\n');

    const ammoItems = AMMO_PACKS.map(a => ({
        imageId: `hunt:${a.id}`,
        name:    a.name,
        price:   a.cost,
        emoji:   a.emoji
    }));
    const ammoList = AMMO_PACKS.map(a =>
        `${a.emoji} **${a.name}** — ${currency}${a.cost} · \`/hunt shop buy item:${a.id}\``
    ).join('\n');

    const consumableItems = Object.values(CONSUMABLES).map(c => ({
        imageId: `hunt:${c.id}`,
        name:    c.name,
        price:   c.cost,
        emoji:   c.emoji
    }));
    const consumableList = Object.values(CONSUMABLES).map(c =>
        `${c.emoji} **${c.name}** — ${currency}${c.cost} · \`/hunt shop buy item:${c.id}\``
    ).join('\n');

    const zoneItems = ZONE_LIST.map(z => {
        const unlocked = h.unlockedZones.includes(z.id);
        const isActive = h.activeZone === z.id;
        return {
            imageId: `hunt:${z.id}`,
            name:    z.name,
            emoji:   z.emoji,
            badge:   isActive ? 'ACTIVE' : (unlocked ? 'OWNED' : `Lv.${z.unlockLevel}`),
            subline: unlocked ? (isActive ? 'Currently hunting' : 'Unlocked') : (z.unlockCost > 0 ? `${currency}${z.unlockCost.toLocaleString()}` : 'Free')
        };
    });
    const zoneList = ZONE_LIST.map(z => {
        const unlocked = h.unlockedZones.includes(z.id);
        const isActive = h.activeZone === z.id;
        const status = unlocked
            ? (isActive ? '✅ **ACTIVE**' : '✅ Unlocked')
            : `🔒 Lv.${z.unlockLevel}${z.unlockCost > 0 ? ` / ${currency}${z.unlockCost.toLocaleString()}` : ' (free)'}`;
        return `${z.emoji} **${z.name}** — ${status}`;
    }).join('\n');

    return runShopBrowse(interaction, {
        activity: 'hunt',
        title:    'Hunt Shop',
        currency,
        // Activity images are per guild since #561; without this the browse view
        // only ever finds the shared pre-#561 rows.
        guildId:  interaction.guild.id,
        footer:   'weapon • upgrade • buy • use • repair • unlock',
        pages: [
            { id: 'weapons',     label: 'Weapons',     emoji: '🔫',  subtitle: 'Pick your tier — better gear, better trophies.', items: weaponItems,     listText: weaponList     },
            { id: 'upgrades',    label: 'Upgrades',    emoji: '🔧',  subtitle: 'One module per weapon, permanent.',                items: upgradeItems,    listText: upgradeList    },
            { id: 'ammo',        label: 'Ammunition',  emoji: '🔶',  subtitle: 'Keep your rifle fed.',                              items: ammoItems,       listText: ammoList       },
            { id: 'consumables', label: 'Consumables', emoji: '🧪',  subtitle: 'Bait, charms, repairs and more.',                   items: consumableItems, listText: consumableList },
            { id: 'zones',       label: 'Zones',       emoji: '🗺️', subtitle: 'New regions, new prey.',                            items: zoneItems,       listText: zoneList       }
        ]
    });
}

async function handleBuyWeapon(interaction, user, currency) {
    const slug       = interaction.options.getString('type');
    const autoEquip  = interaction.options.getBoolean('equip') ?? true;
    const weaponData = WEAPON_BY_SLUG[slug];

    if (!weaponData) {
        return interaction.reply({ content: 'Unknown weapon type.', flags: MessageFlags.Ephemeral });
    }
    if (user.balance < weaponData.cost) {
        return interaction.reply({
            content: `You need **${currency}${weaponData.cost.toLocaleString()}** to buy the **${weaponData.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const ammoValue = weaponData.requiresAmmo
        ? `${weaponData.ammoType.replace(/_/g, ' ')} (${currency}${weaponData.ammoCost}/hunt)`
        : 'None required';

    const confirmEmbed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle(`${weaponData.emoji} Purchase ${weaponData.name}?`)
        .setDescription(weaponData.description)
        .addFields(
            { name: 'Cost',         value: `${currency}${weaponData.cost.toLocaleString()}`,                         inline: true },
            { name: 'Durability',   value: `${weaponData.baseDurability}`,                                            inline: true },
            { name: 'Success Rate', value: `${Math.round(weaponData.successRate * 100)}%`,                            inline: true },
            { name: 'Rarity Boost', value: weaponData.rarityBoost > 0 ? `+${Math.round(weaponData.rarityBoost * 100)}%` : 'None', inline: true },
            { name: 'Ammo',         value: ammoValue,                                                                 inline: true },
            { name: 'Your Balance', value: `${currency}${user.balance.toLocaleString()}`,                             inline: true }
        )
        .setFooter({ text: 'Confirmation expires in 30 seconds' });

    // The one place a hunter commits to the number, so it is the place to say
    // what the number means. A weapon is a consumable — every shop repair drops
    // maxDurability by 10% of base, so the top tiers cost their purchase price
    // again several times over before they are condemned — and at the top of
    // the ladder none of it is fundable from hunting alone.
    if (isCrossEconomyWeapon(weaponData)) {
        const { repairs, maintenance, lifetimeCost, firstRepairCost } = projectWeaponLifetime(weaponData);
        confirmEmbed.addFields({
            name: '🌐 A whole-economy purchase',
            value: [
                `Hunting is capped at ${currency}${LIMITS.DAILY_SOFT_CAP.toLocaleString()} a day before payouts halve, so the sticker price alone is about **${huntingDaysLabel(weaponData.cost)} days** of hunting.`,
                `The sticker price is the down payment. A full repair runs ${currency}${firstRepairCost.toLocaleString()}, it has **${repairs}** of them before the wear condemns it, and keeping it in the field costs ${currency}${maintenance.toLocaleString()} over that life.`,
                `**Total cost of ownership: ${currency}${lifetimeCost.toLocaleString()}** — about **${huntingDaysLabel(lifetimeCost)} days** of hunting.`,
                `It is priced for a wallet fed by everything you do: casino, work, crime, heists and the rest all pay into the same balance.`,
            ].join('\n'),
            inline: false,
        });
    }

    const weaponImg = await getItemImageAttachment(`hunt:${weaponData.slug || weaponData.id}`, interaction.guild.id).catch(() => null);
    if (weaponImg) confirmEmbed.setThumbnail(weaponImg.url);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buygun_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('buygun_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const huntConfirmPayload = { embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, fetchReply: true };
    if (weaponImg) huntConfirmPayload.files = [weaponImg.attachment];
    const reply = await interaction.reply(huntConfirmPayload);
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
        }
        collector.stop();

        if (btn.customId === 'buygun_cancel') {
            return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
        }

        try {
            await btn.deferUpdate();
            await completePurchase(btn, user, weaponData, autoEquip, currency);
        } catch (err) {
            console.error('[huntshop weapon] purchase error:', err);
            btn.editReply({ content: 'Something went wrong. Please try again.', embeds: [], components: [] }).catch(() => {});
        }
    });

    collector.on('end', (_, reason) => {
        if (reason === 'time') {
            interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
        }
    });
}

async function completePurchase(interactionOrBtn, user, weaponData, autoEquip, currency) {
    const newWeapon = {
        name:              weaponData.name,
        tier:              weaponData.tier,
        slug:              weaponData.slug,
        currentDurability: weaponData.baseDurability,
        maxDurability:     weaponData.baseDurability,
        baseDurability:    weaponData.baseDurability,
        repairCount:       0,
        upgrade:           null,
        status:            'good',
        acquiredAt:        new Date()
    };

    const updated = await User.findOneAndUpdate(
        { userId: user.userId, guildId: user.guildId, balance: { $gte: weaponData.cost } },
        { $inc: { balance: -weaponData.cost } },
        { new: true }
    );

    if (!updated) {
        const reply = { content: `Insufficient funds. You need ${currency}${weaponData.cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`, embeds: [], components: [] };
        return interactionOrBtn.editReply ? interactionOrBtn.editReply(reply) : interactionOrBtn.update(reply);
    }

    await persistGrindIfNew(user, 'hunt');
    const profUpdated = await GrindProfile.findOneAndUpdate(
        { userId: user.userId, guildId: user.guildId, system: 'hunt' },
        { $push: { 'data.weapons': newWeapon } },
        { new: true }
    ).catch(err => { console.error('[huntshop weapon] profile push error:', err); return null; });

    if (!profUpdated) {
        // Refund the debit — the weapon was never granted
        await User.updateOne({ userId: user.userId, guildId: user.guildId }, { $inc: { balance: weaponData.cost } }).catch(() => {});
        const reply = { content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] };
        return interactionOrBtn.editReply ? interactionOrBtn.editReply(reply) : interactionOrBtn.update(reply);
    }

    // Sync the in-memory profile so any later save doesn't clobber the purchase
    user.hunt.weapons = profUpdated.data.weapons;
    const h = user.hunt;
    const newIndex = h.weapons.length - 1;

    if (autoEquip) {
        const oldIndex = h.equippedWeaponIndex;
        h.equippedWeaponIndex = newIndex;
        try {
            await GrindProfile.updateOne(
                { userId: user.userId, guildId: user.guildId, system: 'hunt' },
                { $set: { 'data.equippedWeaponIndex': newIndex } }
            );
        } catch (err) {
            console.error('[huntshop weapon] equip update error:', err);
            h.equippedWeaponIndex = oldIndex;
        }
    }

    const equipped = h.equippedWeaponIndex === newIndex;
    const embed = new EmbedBuilder()
        .setColor('#2ecc71')
        .setTitle(`${weaponData.emoji} ${weaponData.name} Purchased!`)
        .setDescription(weaponData.description)
        .addFields(
            { name: 'Durability',   value: `${weaponData.baseDurability}/${weaponData.baseDurability}`,                                                               inline: true },
            { name: 'Success Rate', value: `${Math.round(weaponData.successRate * 100)}%`,                                                                            inline: true },
            { name: 'Rarity Boost', value: `+${Math.round(weaponData.rarityBoost * 100)}%`,                                                                          inline: true },
            { name: 'Ammo',         value: weaponData.requiresAmmo ? `${weaponData.ammoType.replace(/_/g, ' ')} (${currency}${weaponData.ammoCost}/hunt)` : 'None required', inline: true },
            { name: 'Weapon #',     value: `#${newIndex + 1} in inventory`,                                                                                           inline: true },
            { name: 'Status',       value: equipped ? '✅ Equipped' : `Use \`/hunt inv equip ${newIndex + 1}\``,                                                       inline: true }
        )
        .addFields({ name: 'New Balance', value: `${currency}${updated.balance.toLocaleString()}` })
        .setFooter({ text: equipped ? 'Ready to hunt! Use /hunt start' : `Equip with /hunt inv equip ${newIndex + 1}` });

    const reply = { embeds: [embed], components: [] };
    if (interactionOrBtn.editReply) return interactionOrBtn.editReply(reply);
    return interactionOrBtn.update(reply);
}

async function handleBuyUpgrade(interaction, user, currency) {
    const moduleId   = interaction.options.getString('module');
    const upgradeDef = WEAPON_UPGRADES[moduleId];

    if (!upgradeDef) {
        return interaction.reply({ content: 'Unknown upgrade module.', flags: MessageFlags.Ephemeral });
    }

    const h = user.hunt;
    if (h.equippedWeaponIndex < 0 || !h.weapons[h.equippedWeaponIndex]) {
        return interaction.reply({ content: 'No weapon equipped. Equip a weapon first with `/hunt inv equip`.', flags: MessageFlags.Ephemeral });
    }

    const weapon     = h.weapons[h.equippedWeaponIndex];
    const weaponData = WEAPON_BY_TIER[weapon.tier];
    const cost       = Math.round(weaponData.cost * upgradeDef.costMultiplier);

    if (weapon.upgrade) {
        return interaction.reply({
            content: `Your **${weapon.name}** already has a **${weapon.upgrade.replace(/_/g, ' ')}** installed. Each weapon supports only one upgrade.`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (user.balance < cost) {
        return interaction.reply({
            content: `You need ${currency}${cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const charged = await chargeBalance(interaction, cost);
    if (!charged) {
        return interaction.reply({
            content: `This upgrade costs ${currency}${cost.toLocaleString()} — you no longer have enough. Check \`/balance\` and try again.`,
            flags: MessageFlags.Ephemeral
        });
    }
    // Take the authoritative balance and keep the save off that path.
    user.balance   = charged.balance;
    user.unmarkModified('balance');
    weapon.upgrade  = moduleId;
    user.markModified('hunt');
    try {
        await user.save();
    } catch (err) {
        console.error('[huntshop upgrade] save error:', err);
        weapon.upgrade = null;
        await refundBalance(interaction, cost);
        return interaction.reply({ content: 'Installing the upgrade failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`${upgradeDef.emoji} Upgrade Installed!`)
                .setDescription(`**${upgradeDef.name}** has been installed on your **${weapon.name}**.`)
                .addFields(
                    { name: 'Effect',      value: upgradeDef.description,                       inline: true },
                    { name: 'Cost',        value: `${currency}${cost.toLocaleString()}`,         inline: true },
                    { name: 'New Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true }
                )
                .setFooter({ text: 'Upgrade is permanently attached to this weapon instance.' })
        ]
    });
}

async function handleBuy(interaction, user, currency) {
    const itemId   = interaction.options.getString('item');
    const quantity = interaction.options.getInteger('quantity') ?? 1;
    const h        = user.hunt;

    const consumableDef = CONSUMABLES[itemId];
    const ammoDef       = AMMO_PACKS.find(a => a.id === itemId);
    const itemDef       = consumableDef ?? ammoDef;

    if (!itemDef) {
        return interaction.reply({ content: 'Unknown item. Use `/hunt shop list` to see available items.', flags: MessageFlags.Ephemeral });
    }

    const totalCost = itemDef.cost * quantity;
    if (user.balance < totalCost) {
        return interaction.reply({
            content: `You need ${currency}${totalCost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const isAmmo       = !!ammoDef;
    const currentStock = isAmmo
        ? (h.ammo[ammoDef.ammoType] ?? 0)
        : (h.consumables[itemId] ?? 0);

    if (consumableDef) {
        if (currentStock + quantity > consumableDef.maxStack) {
            return interaction.reply({
                content: `You can only hold **${consumableDef.maxStack}× ${consumableDef.name}** at once (you have ${currentStock}).`,
                flags: MessageFlags.Ephemeral
            });
        }
    }

    const gainedLabel = isAmmo
        ? `${ammoDef.quantity * quantity} ${ammoDef.ammoType.replace(/_/g, ' ')} rounds`
        : `${quantity}× ${consumableDef.name}`;

    const confirmEmbed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle(`${itemDef.emoji} Confirm Purchase`)
        .setDescription(itemDef.description ?? '')
        .addFields(
            { name: 'Item',        value: itemDef.name,                                inline: true },
            { name: 'Quantity',    value: gainedLabel,                                 inline: true },
            { name: 'Total Cost',  value: `${currency}${totalCost.toLocaleString()}`,  inline: true },
            { name: 'Your Balance',value: `${currency}${user.balance.toLocaleString()}`, inline: true },
            { name: 'Currently',   value: isAmmo
                ? `${currentStock} rounds in stock`
                : `${currentStock}/${consumableDef.maxStack} in stock`, inline: true }
        )
        .setFooter({ text: 'Confirmation expires in 30 seconds' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('huntbuy_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('huntbuy_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, fetchReply: true });
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
        }
        collector.stop();

        if (btn.customId === 'huntbuy_cancel') {
            return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
        }

        try {
            await btn.deferUpdate();

            await persistGrindIfNew(user, 'hunt');
            const balanceUpdated = await User.findOneAndUpdate(
                { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: totalCost } },
                { $inc: { balance: -totalCost } },
                { new: true }
            );
            if (!balanceUpdated) {
                return interaction.editReply({ content: 'Insufficient funds. Please try again.', embeds: [], components: [] });
            }

            let newStock;
            if (consumableDef) {
                const consumableField = `data.consumables.${itemId}`;
                const profUpdated = await GrindProfile.findOneAndUpdate(
                    {
                        userId:  interaction.user.id,
                        guildId: interaction.guild.id,
                        system:  'hunt',
                        $expr: { $lte: [{ $add: [{ $ifNull: [`$${consumableField}`, 0] }, quantity] }, consumableDef.maxStack] }
                    },
                    { $inc: { [consumableField]: quantity } },
                    { new: true }
                ).catch(() => null);

                if (!profUpdated) {
                    await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } }).catch(() => {});
                    return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
                }
                h.consumables[itemId] = profUpdated.data?.consumables?.[itemId] ?? quantity;
                newStock = `${h.consumables[itemId]}× ${consumableDef.name}`;
            } else {
                const ammoField = `data.ammo.${ammoDef.ammoType}`;
                const profUpdated = await GrindProfile.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id, system: 'hunt' },
                    { $inc: { [ammoField]: ammoDef.quantity * quantity } },
                    { new: true }
                ).catch(() => null);

                if (!profUpdated) {
                    await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } }).catch(() => {});
                    return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
                }
                h.ammo[ammoDef.ammoType] = profUpdated.data?.ammo?.[ammoDef.ammoType] ?? (ammoDef.quantity * quantity);
                newStock = `${h.ammo[ammoDef.ammoType]} ${ammoDef.ammoType.replace(/_/g, ' ')}`;
            }

            const finalGained = isAmmo ? `${ammoDef.quantity * quantity} rounds` : `${quantity}× ${consumableDef.name}`;
            const ammoNote    = isAmmo ? `\nAmmo stock for **${ammoDef.ammoType.replace(/_/g, ' ')}**: ${h.ammo[ammoDef.ammoType]}` : '';

            const successEmbed = new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`${itemDef.emoji} Purchase Successful`)
                .setDescription(`You bought **${finalGained}** for ${currency}${totalCost.toLocaleString()}.${ammoNote}`)
                .addFields(
                    { name: 'New Balance', value: `${currency}${balanceUpdated.balance.toLocaleString()}`, inline: true },
                    { name: 'In Stock',    value: newStock, inline: true }
                );

            if (!isAmmo && ACTIVATABLE.includes(itemId)) {
                successEmbed.setFooter({ text: `Activate with /hunt shop use ${itemId}` });
            }

            await interaction.editReply({ embeds: [successEmbed], components: [] });
        } catch (err) {
            console.error('[huntshop buy] purchase error:', err);
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
    const { success, error } = activateConsumable(user, itemId);

    if (!success) {
        return interaction.reply({ content: error, flags: MessageFlags.Ephemeral });
    }

    await user.save();

    const def = CONSUMABLES[itemId];
    const h   = user.hunt;
    let statusMsg = '';

    if (def.type === 'bait')                              statusMsg = `Active for **${h.activeBaitHuntsLeft}** hunts.`;
    if (def.type === 'charm')                             statusMsg = `Active for **${h.activeCharmHuntsLeft}** hunts.`;
    if (def.type === 'instant' && itemId === 'hunters_focus') statusMsg = `Will apply on your next hunt.`;
    if (def.type === 'instant' && itemId === 'xp_scroll') statusMsg = `Will apply on your next hunt.`;
    if (def.type === 'stamina')                           statusMsg = `Stamina: **${h.stamina}/${getMaxStamina(user)}** — restored ${def.staminaRestore} points.`;

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`${def.emoji} ${def.name} Activated!`)
                .setDescription(`${def.description}\n${statusMsg}`)
                .setFooter({ text: 'Go hunt! Use /hunt start' })
        ]
    });
}

async function handleRepair(interaction, user, currency) {
    const h = user.hunt;

    if (h.equippedWeaponIndex < 0 || !h.weapons[h.equippedWeaponIndex]) {
        return interaction.reply({ content: 'No weapon equipped. Buy one with `/hunt shop weapon` first.', flags: MessageFlags.Ephemeral });
    }

    const weapon = h.weapons[h.equippedWeaponIndex];
    const method = interaction.options.getString('method');

    if (method === 'kit') {
        const kitId = interaction.options.getString('kit');
        if (!kitId) {
            return interaction.reply({ content: 'Please specify a kit size using the `kit` option.', flags: MessageFlags.Ephemeral });
        }

        const kitDef = CONSUMABLES[kitId];
        const stock  = h.consumables[kitId] ?? 0;

        if (stock <= 0) {
            return interaction.reply({
                content: `You don't have any **${kitDef.name}**. Buy them with \`/hunt shop buy\`.`,
                flags: MessageFlags.Ephemeral
            });
        }
        if (isCondemned(weapon)) {
            return interaction.reply({ content: 'This weapon is condemned and cannot be repaired. Replace it with `/hunt shop weapon`.', flags: MessageFlags.Ephemeral });
        }
        if (weapon.currentDurability >= weapon.maxDurability) {
            return interaction.reply({ content: `Your **${weapon.name}** is already at full durability.`, flags: MessageFlags.Ephemeral });
        }

        const before = weapon.currentDurability;
        weapon.currentDurability = Math.min(weapon.maxDurability, weapon.currentDurability + kitDef.durabilityRestore);
        updateWeaponStatus(weapon);
        h.consumables[kitId] -= 1;
        user.markModified('hunt');
        await user.save();

        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor('#2ecc71')
                    .setTitle(`${kitDef.emoji} Repair Kit Used`)
                    .setDescription(`Your **${weapon.name}** has been field-repaired.`)
                    .addFields(
                        { name: 'Before',         value: `${before}/${weapon.maxDurability}`,                                                  inline: true },
                        { name: 'After',          value: `${weapon.currentDurability}/${weapon.maxDurability}`,                                 inline: true },
                        { name: 'Kits Remaining', value: `${h.consumables[kitId]} × ${kitDef.name}`,                                          inline: true },
                        { name: 'Durability Bar', value: `${durabilityBar(weapon.currentDurability, weapon.maxDurability)} ${weapon.currentDurability}/${weapon.maxDurability}` }
                    )
                    .setFooter({ text: 'Field repairs do not degrade max durability' })
            ]
        });
    }

    if (isCondemned(weapon)) {
        return interaction.reply({ content: 'This weapon is **condemned** and cannot be repaired. Replace it with `/hunt shop weapon`.', flags: MessageFlags.Ephemeral });
    }
    if (weapon.currentDurability >= weapon.maxDurability && weapon.status !== 'broken') {
        return interaction.reply({ content: `Your **${weapon.name}** is already at full durability (${weapon.currentDurability}/${weapon.maxDurability}).`, flags: MessageFlags.Ephemeral });
    }

    const needed     = weapon.maxDurability - weapon.currentDurability;
    let requestedAmt = interaction.options.getInteger('amount');
    if (!requestedAmt || requestedAmt > needed) requestedAmt = needed;
    requestedAmt = Math.ceil(requestedAmt / 20) * 20;

    // Price the repair before applying it — applyRepair degrades max durability and
    // bumps the repair count, and none of that should happen on a quote the player
    // can't afford.
    const quote = quoteRepair(weapon, requestedAmt);

    if (quote.error) {
        return interaction.reply({ content: quote.error, flags: MessageFlags.Ephemeral });
    }
    if (user.balance < quote.cost) {
        return interaction.reply({
            content: `Repair costs ${currency}${quote.cost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const result = applyRepair(weapon, requestedAmt);
    if (result.error) {
        return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
    }

    const chargedRepair = await chargeBalance(interaction, result.cost);
    if (!chargedRepair) {
        return interaction.reply({
            content: `Repair costs ${currency}${result.cost.toLocaleString()} — you no longer have enough. Check \`/balance\` and try again.`,
            flags: MessageFlags.Ephemeral
        });
    }
    user.balance = chargedRepair.balance;
    user.unmarkModified('balance');
    user.markModified('hunt');
    try {
        await user.save();
    } catch (err) {
        console.error('[huntshop repair] save error:', err);
        await refundBalance(interaction, result.cost);
        return interaction.reply({ content: 'The repair failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
    }

    const statusIcon = weaponStatusEmoji(result.newStatus);
    // How many repairs are left is the number that decides whether to keep
    // paying into this weapon or replace it, and it was never shown — the embed
    // only counted the ones already spent (#747).
    const repairsLeft = repairsRemaining(weapon);
    const repairCountValue = result.condemned
        ? `${weapon.repairCount} — no repairs left`
        : `${weapon.repairCount} used · **${repairsLeft}** left (max dur -10% each)`;
    const embed = new EmbedBuilder()
        .setColor(result.condemned ? '#e74c3c' : '#2ecc71')
        .setTitle('🔧 Weapon Repaired')
        .setDescription(`Your **${weapon.name}** has been repaired.`)
        .addFields(
            { name: 'Durability Restored', value: `+${result.restoredAmount}`,                             inline: true },
            { name: 'New Durability',       value: `${weapon.currentDurability}/${weapon.maxDurability}`,   inline: true },
            { name: 'Weapon Status',        value: `${statusIcon} ${result.newStatus}`,                     inline: true },
            { name: 'Repair Cost',          value: `${currency}${result.cost.toLocaleString()}`,            inline: true },
            { name: 'New Balance',          value: `${currency}${user.balance.toLocaleString()}`,           inline: true },
            { name: 'Repair Count',         value: repairCountValue,                                       inline: true },
            { name: 'Durability Bar',       value: `${durabilityBar(weapon.currentDurability, weapon.maxDurability)} ${weapon.currentDurability}/${weapon.maxDurability}` }
        );

    if (result.condemned) {
        embed.addFields({ name: '⚠️ Condemned!', value: 'Max durability has dropped too low. This weapon **cannot be repaired again**. Consider replacing it with `/hunt shop weapon`.' });
    } else if (result.newStatus === 'degraded') {
        embed.addFields({ name: '⚠️ Degraded', value: 'Max durability is below 50% of original. Performance is reduced.' });
    }

    embed.setFooter({ text: 'Each shop repair permanently reduces max durability by 10% • Use repair kits to avoid degradation' });

    return interaction.reply({ embeds: [embed] });
}

async function handleUnlock(interaction, user, currency) {
    const h      = user.hunt;
    const zoneId = interaction.options.getString('zone');
    const zone   = ZONES[zoneId];

    if (!zone) {
        return interaction.reply({ content: 'Unknown zone.', flags: MessageFlags.Ephemeral });
    }
    if (zone.defaultUnlocked || h.unlockedZones.includes(zoneId)) {
        return interaction.reply({ content: `**${zone.name}** is already unlocked.`, flags: MessageFlags.Ephemeral });
    }
    if (h.level < zone.unlockLevel) {
        return interaction.reply({
            content: `You need Hunter Level **${zone.unlockLevel}** to unlock **${zone.name}**. You're Level ${h.level}.`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (user.balance < zone.unlockCost) {
        return interaction.reply({
            content: `Unlocking **${zone.name}** costs ${currency}${zone.unlockCost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const chargedUnlock = await chargeBalance(interaction, zone.unlockCost);
    if (!chargedUnlock) {
        return interaction.reply({
            content: `Unlocking **${zone.name}** costs ${currency}${zone.unlockCost.toLocaleString()} — you no longer have enough. Check \`/balance\` and try again.`,
            flags: MessageFlags.Ephemeral
        });
    }
    user.balance = chargedUnlock.balance;
    user.unmarkModified('balance');
    h.unlockedZones.push(zoneId);
    user.markModified('hunt');
    try {
        await user.save();
    } catch (err) {
        console.error('[hunt unlock] save error:', err);
        h.unlockedZones = h.unlockedZones.filter(z => z !== zoneId);
        await refundBalance(interaction, zone.unlockCost);
        return interaction.reply({ content: 'Unlocking the zone failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
    }

    const tierStr = Object.entries(zone.tierWeights)
        .filter(([, w]) => w > 0)
        .map(([t, w]) => `${t}: ${w}%`)
        .join(' · ');

    const materialStr = (zone.zoneMaterials ?? [])
        .map(id => MATERIAL_NAMES[id] ?? id)
        .join(' · ');

    const unlockEmbed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle(`${zone.emoji} Zone Unlocked: ${zone.name}!`)
        .setDescription(zone.description)
        .addFields(
            { name: 'Loot Table',   value: tierStr,                                                                                             inline: false },
            { name: 'Difficulty',   value: zone.difficultyMod < 0 ? `${Math.round(zone.difficultyMod * 100)}% success` : 'No penalty',           inline: true },
            { name: 'Payout Bonus', value: zone.payoutBonus > 0 ? `+${Math.round(zone.payoutBonus * 100)}%` : 'Standard',                        inline: true },
            { name: 'Unlock Cost',  value: `${currency}${zone.unlockCost.toLocaleString()}`,                                                     inline: true },
            { name: 'New Balance',  value: `${currency}${user.balance.toLocaleString()}`,                                                        inline: true }
        )
        .setFooter({ text: `Switch to it with /hunt zone set ${zoneId}` });

    if (materialStr) {
        unlockEmbed.addFields({ name: '🪨 Materials Found Here', value: materialStr, inline: false });
    }

    return interaction.reply({ embeds: [unlockEmbed] });
}

module.exports = {
    CROSS_ECONOMY_DAYS,
    completePurchase,
    executeShop,
    fullRepairCost,
    handleBuy,
    handleBuyUpgrade,
    handleBuyWeapon,
    handleRepair,
    handleUnlock,
    handleUse,
    huntingDaysFor,
    huntingDaysLabel,
    isCrossEconomyWeapon,
    showShopList,
};
