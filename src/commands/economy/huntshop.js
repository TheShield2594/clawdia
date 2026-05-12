'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const {
    CONSUMABLES, AMMO_PACKS,
    WEAPON_TIERS, WEAPON_BY_TIER, WEAPON_BY_SLUG, WEAPON_UPGRADES,
    ZONES, ZONE_LIST
} = require('../../data/huntData');
const {
    ensureHuntData, activateConsumable, getMaxStamina,
    applyRepair, weaponStatusEmoji, durabilityBar, updateWeaponStatus
} = require('../../services/huntService');

const WEAPON_CHOICES  = WEAPON_TIERS.map(w => ({ name: `${w.emoji} ${w.name} — ${w.cost.toLocaleString()} coins`, value: w.slug }));
const ALL_ITEMS       = [...Object.values(CONSUMABLES), ...AMMO_PACKS];
const ITEM_CHOICES    = ALL_ITEMS.map(i => ({ name: `${i.emoji ?? ''} ${i.name} — ${i.cost} coins`.trim(), value: i.id }));
const ACTIVATABLE     = ['basic_bait', 'premium_bait', 'luck_charm', 'hunters_focus', 'xp_scroll', 'stamina_tonic'];
const UPGRADE_CHOICES = Object.values(WEAPON_UPGRADES).map(u => ({ name: `${u.emoji} ${u.name} — ${u.description}`, value: u.id }));
const UNLOCK_CHOICES  = ZONE_LIST.filter(z => !z.defaultUnlocked).map(z => ({ name: `${z.emoji} ${z.name}`, value: z.id }));

module.exports = {
    cooldown: 3,

    data: new SlashCommandBuilder()
        .setName('huntshop')
        .setDescription('Browse and purchase all hunting gear, ammo, and supplies')
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('Browse everything available in the hunting shop'))
        .addSubcommand(sub =>
            sub.setName('weapon')
                .setDescription('Buy a new hunting weapon')
                .addStringOption(o =>
                    o.setName('type')
                        .setDescription('Which weapon to buy')
                        .setRequired(true)
                        .addChoices(...WEAPON_CHOICES))
                .addBooleanOption(o =>
                    o.setName('equip')
                        .setDescription('Auto-equip after purchase (default: true)')
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('upgrade')
                .setDescription('Install a module upgrade on your equipped weapon (one per weapon, permanent)')
                .addStringOption(o =>
                    o.setName('module')
                        .setDescription('Upgrade module to install')
                        .setRequired(true)
                        .addChoices(...UPGRADE_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('buy')
                .setDescription('Purchase ammo packs or consumables')
                .addStringOption(o =>
                    o.setName('item')
                        .setDescription('Item to buy')
                        .setRequired(true)
                        .addChoices(...ITEM_CHOICES))
                .addIntegerOption(o =>
                    o.setName('quantity')
                        .setDescription('How many to buy (default: 1)')
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(20)))
        .addSubcommand(sub =>
            sub.setName('use')
                .setDescription('Activate a consumable buff')
                .addStringOption(o =>
                    o.setName('item')
                        .setDescription('Consumable to activate')
                        .setRequired(true)
                        .addChoices(...ACTIVATABLE.map(id => ({ name: CONSUMABLES[id].name, value: id })))))
        .addSubcommand(sub =>
            sub.setName('repair')
                .setDescription('Repair your equipped weapon at the shop or use a repair kit')
                .addStringOption(o =>
                    o.setName('method')
                        .setDescription('Repair method')
                        .setRequired(true)
                        .addChoices(
                            { name: '🔧 Shop Repair — costs coins, slightly degrades max durability', value: 'shop' },
                            { name: '🪛 Repair Kit — free from inventory, no degradation',           value: 'kit' }
                        ))
                .addStringOption(o =>
                    o.setName('kit')
                        .setDescription('Kit size to use (kit method only)')
                        .setRequired(false)
                        .addChoices(
                            { name: 'Small (+20 durability)', value: 'repair_kit_small' },
                            { name: 'Large (+50 durability)', value: 'repair_kit_large' }
                        ))
                .addIntegerOption(o =>
                    o.setName('amount')
                        .setDescription('Durability to restore at shop (default: full repair)')
                        .setRequired(false)
                        .setMinValue(20)))
        .addSubcommand(sub =>
            sub.setName('unlock')
                .setDescription('Unlock a new hunting zone')
                .addStringOption(o =>
                    o.setName('zone')
                        .setDescription('Zone to unlock')
                        .setRequired(true)
                        .addChoices(...UNLOCK_CHOICES))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }
        const currency = guildSettings?.economy?.currency ?? '💰';

        const user = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        );
        ensureHuntData(user);

        switch (sub) {
            case 'list':    return showList(interaction, user, currency);
            case 'weapon':  return handleBuyWeapon(interaction, user, currency);
            case 'upgrade': return handleBuyUpgrade(interaction, user, currency);
            case 'buy':     return handleBuy(interaction, user, currency);
            case 'use':     return handleUse(interaction, user);
            case 'repair':  return handleRepair(interaction, user, currency);
            case 'unlock':  return handleUnlock(interaction, user, currency);
        }
    }
};

// ─── LIST ─────────────────────────────────────────────────────────────────────

async function showList(interaction, user, currency) {
    const h = user.hunt;

    const weaponSection = WEAPON_TIERS.map(w => {
        const ammo = w.requiresAmmo ? `${w.ammoType.replace(/_/g, ' ')} (${currency}${w.ammoCost}/hunt)` : 'None';
        return `**T${w.tier} ${w.emoji} ${w.name}** — ${currency}${w.cost.toLocaleString()}\n   Success: ${Math.round(w.successRate * 100)}% | Rarity: +${Math.round(w.rarityBoost * 100)}% | Ammo: ${ammo}`;
    }).join('\n');

    const upgradeSection = Object.values(WEAPON_UPGRADES).map(u =>
        `${u.emoji} **${u.name}** — ~${Math.round(u.costMultiplier * 100)}% of weapon price\n   *${u.description}*`
    ).join('\n');

    const ammoSection = AMMO_PACKS.map(a =>
        `${a.emoji} **${a.name}** — ${currency}${a.cost}\n   *${a.description}*`
    ).join('\n');

    const consumableSection = Object.values(CONSUMABLES).map(c =>
        `${c.emoji} **${c.name}** — ${currency}${c.cost}\n   *${c.description}*`
    ).join('\n');

    const zoneSection = ZONE_LIST.map(zone => {
        const unlocked = h.unlockedZones.includes(zone.id);
        const isActive = h.activeZone === zone.id;
        const status = unlocked
            ? (isActive ? '✅ **ACTIVE**' : '✅ Unlocked')
            : `🔒 Lv.${zone.unlockLevel}${zone.unlockCost > 0 ? ` / ${currency}${zone.unlockCost.toLocaleString()}` : ' (free)'}`;
        return `${zone.emoji} **${zone.name}** — ${status}\n   *${zone.description}*`;
    }).join('\n');

    const embed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle('🏪 Hunt Shop')
        .addFields(
            { name: '🔫 Weapons',                        value: weaponSection,     inline: false },
            { name: '🔧 Weapon Upgrades (1 per weapon)', value: upgradeSection,    inline: false },
            { name: '🔶 Ammunition',                     value: ammoSection,       inline: false },
            { name: '🧪 Consumables',                    value: consumableSection, inline: false },
            { name: '🗺️ Zones',                          value: zoneSection,       inline: false }
        )
        .setFooter({ text: '/huntshop weapon • /huntshop upgrade • /huntshop buy • /huntshop use • /huntshop repair • /huntshop unlock' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ─── BUY WEAPON ──────────────────────────────────────────────────────────────

async function handleBuyWeapon(interaction, user, currency) {
    const slug       = interaction.options.getString('type');
    const autoEquip  = interaction.options.getBoolean('equip') ?? true;
    const weaponData = WEAPON_BY_SLUG[slug];

    if (!weaponData) {
        return interaction.reply({ content: 'Unknown weapon type.', ephemeral: true });
    }
    if (user.balance < weaponData.cost) {
        return interaction.reply({
            content: `You need **${currency}${weaponData.cost.toLocaleString()}** to buy the **${weaponData.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            ephemeral: true
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

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buygun_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('buygun_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], ephemeral: true, fetchReply: true });
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', ephemeral: true });
        }
        collector.stop();

        if (btn.customId === 'buygun_cancel') {
            return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
        }

        await btn.deferUpdate();
        await completePurchase(btn, user, weaponData, autoEquip, currency);
    });

    collector.on('end', (_, reason) => {
        if (reason === 'time') {
            interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
        }
    });
}

async function completePurchase(interactionOrBtn, user, weaponData, autoEquip, currency) {
    const h = user.hunt;

    if (user.balance < weaponData.cost) {
        const reply = { content: `Insufficient funds. You need ${currency}${weaponData.cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`, embeds: [], components: [] };
        return interactionOrBtn.editReply ? interactionOrBtn.editReply(reply) : interactionOrBtn.update(reply);
    }

    user.balance -= weaponData.cost;

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

    h.weapons.push(newWeapon);
    const newIndex = h.weapons.length - 1;

    if (autoEquip && (h.equippedWeaponIndex < 0 || !h.weapons[h.equippedWeaponIndex] || h.weapons[h.equippedWeaponIndex].status === 'broken')) {
        h.equippedWeaponIndex = newIndex;
    }

    user.markModified('hunt');
    await user.save();

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
            { name: 'Status',       value: equipped ? '✅ Equipped' : `Use \`/huntinv equip ${newIndex + 1}\``,                                                       inline: true }
        )
        .addFields({ name: 'New Balance', value: `${currency}${user.balance.toLocaleString()}` })
        .setFooter({ text: equipped ? 'Ready to hunt! Use /hunt' : `Equip with /huntinv equip ${newIndex + 1}` });

    const reply = { embeds: [embed], components: [] };
    if (interactionOrBtn.editReply) return interactionOrBtn.editReply(reply);
    return interactionOrBtn.update(reply);
}

// ─── BUY UPGRADE ─────────────────────────────────────────────────────────────

async function handleBuyUpgrade(interaction, user, currency) {
    const moduleId   = interaction.options.getString('module');
    const upgradeDef = WEAPON_UPGRADES[moduleId];

    if (!upgradeDef) {
        return interaction.reply({ content: 'Unknown upgrade module.', ephemeral: true });
    }

    const h = user.hunt;
    if (h.equippedWeaponIndex < 0 || !h.weapons[h.equippedWeaponIndex]) {
        return interaction.reply({ content: 'No weapon equipped. Equip a weapon first with `/huntinv equip`.', ephemeral: true });
    }

    const weapon     = h.weapons[h.equippedWeaponIndex];
    const weaponData = WEAPON_BY_TIER[weapon.tier];
    const cost       = Math.round(weaponData.cost * upgradeDef.costMultiplier);

    if (weapon.upgrade) {
        return interaction.reply({
            content: `Your **${weapon.name}** already has a **${weapon.upgrade.replace(/_/g, ' ')}** installed. Each weapon supports only one upgrade.`,
            ephemeral: true
        });
    }
    if (user.balance < cost) {
        return interaction.reply({
            content: `You need ${currency}${cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`,
            ephemeral: true
        });
    }

    user.balance   -= cost;
    weapon.upgrade  = moduleId;
    user.markModified('hunt');
    await user.save();

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

// ─── BUY SUPPLIES ────────────────────────────────────────────────────────────

async function handleBuy(interaction, user, currency) {
    const itemId   = interaction.options.getString('item');
    const quantity = interaction.options.getInteger('quantity') ?? 1;
    const h        = user.hunt;

    const consumableDef = CONSUMABLES[itemId];
    const ammoDef       = AMMO_PACKS.find(a => a.id === itemId);
    const itemDef       = consumableDef ?? ammoDef;

    if (!itemDef) {
        return interaction.reply({ content: 'Unknown item. Use `/huntshop list` to see available items.', ephemeral: true });
    }

    const totalCost = itemDef.cost * quantity;
    if (user.balance < totalCost) {
        return interaction.reply({
            content: `You need ${currency}${totalCost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`,
            ephemeral: true
        });
    }

    if (consumableDef) {
        const currentStock = h.consumables[itemId] ?? 0;
        if (currentStock + quantity > consumableDef.maxStack) {
            return interaction.reply({
                content: `You can only hold **${consumableDef.maxStack}× ${consumableDef.name}** at once (you have ${currentStock}).`,
                ephemeral: true
            });
        }
        user.balance          -= totalCost;
        h.consumables[itemId]  = currentStock + quantity;
    } else {
        const ammoType   = ammoDef.ammoType;
        const gained     = ammoDef.quantity * quantity;
        user.balance    -= totalCost;
        h.ammo[ammoType] = (h.ammo[ammoType] ?? 0) + gained;
    }

    user.markModified('hunt');
    await user.save();

    const isAmmo   = !!ammoDef;
    const gained   = isAmmo ? `${ammoDef.quantity * quantity} rounds` : `${quantity}× ${consumableDef.name}`;
    const ammoNote = isAmmo ? `\nAmmo stock for **${ammoDef.ammoType.replace(/_/g, ' ')}**: ${h.ammo[ammoDef.ammoType]}` : '';

    const embed = new EmbedBuilder()
        .setColor('#2ecc71')
        .setTitle(`${itemDef.emoji} Purchase Successful`)
        .setDescription(`You bought **${gained}** for ${currency}${totalCost.toLocaleString()}.${ammoNote}`)
        .addFields(
            { name: 'New Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true },
            { name: 'In Stock',    value: isAmmo
                ? `${h.ammo[ammoDef.ammoType]} ${ammoDef.ammoType.replace(/_/g, ' ')}`
                : `${h.consumables[itemId]}× ${consumableDef.name}`, inline: true }
        );

    if (!isAmmo && ACTIVATABLE.includes(itemId)) {
        embed.setFooter({ text: `Activate with /huntshop use ${itemId}` });
    }

    return interaction.reply({ embeds: [embed] });
}

// ─── USE ──────────────────────────────────────────────────────────────────────

async function handleUse(interaction, user) {
    const itemId = interaction.options.getString('item');
    const { success, error } = activateConsumable(user, itemId);

    if (!success) {
        return interaction.reply({ content: error, ephemeral: true });
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
                .setFooter({ text: 'Go hunt! Use /hunt' })
        ]
    });
}

// ─── REPAIR ──────────────────────────────────────────────────────────────────

async function handleRepair(interaction, user, currency) {
    const h = user.hunt;

    if (h.equippedWeaponIndex < 0 || !h.weapons[h.equippedWeaponIndex]) {
        return interaction.reply({ content: 'No weapon equipped. Buy one with `/huntshop weapon` first.', ephemeral: true });
    }

    const weapon = h.weapons[h.equippedWeaponIndex];
    const method = interaction.options.getString('method');

    if (method === 'kit') {
        const kitId = interaction.options.getString('kit');
        if (!kitId) {
            return interaction.reply({ content: 'Please specify a kit size using the `kit` option.', ephemeral: true });
        }

        const kitDef = CONSUMABLES[kitId];
        const stock  = h.consumables[kitId] ?? 0;

        if (stock <= 0) {
            return interaction.reply({
                content: `You don't have any **${kitDef.name}**. Buy them with \`/huntshop buy\`.`,
                ephemeral: true
            });
        }
        if (weapon.status === 'condemned') {
            return interaction.reply({ content: 'This weapon is condemned and cannot be repaired. Replace it with `/huntshop weapon`.', ephemeral: true });
        }
        if (weapon.currentDurability >= weapon.maxDurability) {
            return interaction.reply({ content: `Your **${weapon.name}** is already at full durability.`, ephemeral: true });
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

    // Shop repair
    if (weapon.status === 'condemned') {
        return interaction.reply({ content: 'This weapon is **condemned** and cannot be repaired. Replace it with `/huntshop weapon`.', ephemeral: true });
    }
    if (weapon.currentDurability >= weapon.maxDurability && weapon.status !== 'broken') {
        return interaction.reply({ content: `Your **${weapon.name}** is already at full durability (${weapon.currentDurability}/${weapon.maxDurability}).`, ephemeral: true });
    }

    const needed     = weapon.maxDurability - weapon.currentDurability;
    let requestedAmt = interaction.options.getInteger('amount');
    if (!requestedAmt || requestedAmt > needed) requestedAmt = needed;
    requestedAmt = Math.ceil(requestedAmt / 20) * 20;

    const result = applyRepair(weapon, requestedAmt);

    if (result.error) {
        return interaction.reply({ content: result.error, ephemeral: true });
    }
    if (user.balance < result.cost) {
        return interaction.reply({
            content: `Repair costs ${currency}${result.cost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`,
            ephemeral: true
        });
    }

    user.balance -= result.cost;
    user.markModified('hunt');
    await user.save();

    const statusIcon = weaponStatusEmoji(result.newStatus);
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
            { name: 'Repair Count',         value: `${weapon.repairCount} (max dur -10% per repair)`,      inline: true },
            { name: 'Durability Bar',       value: `${durabilityBar(weapon.currentDurability, weapon.maxDurability)} ${weapon.currentDurability}/${weapon.maxDurability}` }
        );

    if (result.condemned) {
        embed.addFields({ name: '⚠️ Condemned!', value: 'Max durability has dropped too low. This weapon **cannot be repaired again**. Consider replacing it with `/huntshop weapon`.' });
    } else if (result.newStatus === 'degraded') {
        embed.addFields({ name: '⚠️ Degraded', value: 'Max durability is below 50% of original. Performance is reduced.' });
    }

    embed.setFooter({ text: 'Each shop repair permanently reduces max durability by 10% • Use repair kits to avoid degradation' });

    return interaction.reply({ embeds: [embed] });
}

// ─── UNLOCK ZONE ─────────────────────────────────────────────────────────────

async function handleUnlock(interaction, user, currency) {
    const h      = user.hunt;
    const zoneId = interaction.options.getString('zone');
    const zone   = ZONES[zoneId];

    if (!zone) {
        return interaction.reply({ content: 'Unknown zone.', ephemeral: true });
    }
    if (zone.defaultUnlocked || h.unlockedZones.includes(zoneId)) {
        return interaction.reply({ content: `**${zone.name}** is already unlocked.`, ephemeral: true });
    }
    if (h.level < zone.unlockLevel) {
        return interaction.reply({
            content: `You need Hunter Level **${zone.unlockLevel}** to unlock **${zone.name}**. You're Level ${h.level}.`,
            ephemeral: true
        });
    }
    if (user.balance < zone.unlockCost) {
        return interaction.reply({
            content: `Unlocking **${zone.name}** costs ${currency}${zone.unlockCost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`,
            ephemeral: true
        });
    }

    user.balance      -= zone.unlockCost;
    h.unlockedZones.push(zoneId);
    user.markModified('hunt');
    await user.save();

    const tierStr = Object.entries(zone.tierWeights)
        .filter(([, w]) => w > 0)
        .map(([t, w]) => `${t}: ${w}%`)
        .join(' · ');

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor('#f39c12')
                .setTitle(`${zone.emoji} Zone Unlocked: ${zone.name}!`)
                .setDescription(zone.description)
                .addFields(
                    { name: 'Loot Table',   value: tierStr,                                                                                                        inline: false },
                    { name: 'Difficulty',   value: zone.difficultyMod < 0 ? `${Math.round(zone.difficultyMod * 100)}% success` : 'No penalty',                    inline: true },
                    { name: 'Payout Bonus', value: zone.payoutBonus > 0 ? `+${Math.round(zone.payoutBonus * 100)}%` : 'Standard',                                 inline: true },
                    { name: 'Unlock Cost',  value: `${currency}${zone.unlockCost.toLocaleString()}`,                                                              inline: true },
                    { name: 'New Balance',  value: `${currency}${user.balance.toLocaleString()}`,                                                                  inline: true }
                )
                .setFooter({ text: `Switch to it with /huntzone set ${zoneId}` })
        ]
    });
}
