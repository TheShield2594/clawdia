'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const {
    BAIT_PACKS, CONSUMABLES,
    ROD_TIERS, ROD_BY_SLUG, ROD_BY_TIER, ROD_UPGRADES,
    LOCATIONS, LOCATION_LIST
} = require('../../data/fishData');
const {
    ensureFishingData, activateConsumable,
    applyRepair, rodStatusEmoji, durabilityBar, updateRodStatus
} = require('../../services/fishService');

const SHOP_CHOICES = [
    ...BAIT_PACKS.map(p => ({ name: `${p.emoji} ${p.name} — ${p.cost} coins`, value: p.id })),
    ...Object.values(CONSUMABLES).map(c => ({ name: `${c.emoji} ${c.name} — ${c.cost} coins`, value: c.id }))
];

const USE_CHOICES = Object.values(CONSUMABLES)
    .filter(c => c.type !== 'repair')
    .map(c => ({ name: `${c.emoji} ${c.name}`, value: c.id }));

const ROD_CHOICES     = ROD_TIERS.map(r => ({ name: `${r.emoji} ${r.name} (${r.cost.toLocaleString()} coins)`, value: r.slug }));
const UPGRADE_CHOICES = Object.values(ROD_UPGRADES).map(u => ({ name: `${u.emoji} ${u.name} — ${u.description}`, value: u.id }));
const UNLOCK_CHOICES  = LOCATION_LIST.filter(l => !l.defaultUnlocked).map(l => ({ name: `${l.emoji} ${l.name}`, value: l.id }));

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('fishshop')
        .setDescription('Browse and purchase all fishing gear, bait, and supplies')
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('Browse everything available in the fishing shop'))
        .addSubcommand(sub =>
            sub.setName('rod')
                .setDescription('Buy a new fishing rod')
                .addStringOption(o =>
                    o.setName('type')
                        .setDescription('Which rod to buy')
                        .setRequired(true)
                        .addChoices(...ROD_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('upgrade')
                .setDescription('Install an upgrade on your equipped rod (one per rod, permanent)')
                .addStringOption(o =>
                    o.setName('type')
                        .setDescription('Which upgrade to install')
                        .setRequired(true)
                        .addChoices(...UPGRADE_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('buy')
                .setDescription('Purchase bait packs or consumables')
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
                        .addChoices(...USE_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('repair')
                .setDescription('Repair your equipped rod at the shop or use a repair kit')
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
                            { name: 'Small Repair Kit (+20 durability)', value: 'repair_kit_small' },
                            { name: 'Large Repair Kit (+50 durability)', value: 'repair_kit_large' }
                        ))
                .addIntegerOption(o =>
                    o.setName('amount')
                        .setDescription('Durability to restore at shop (default: full repair)')
                        .setMinValue(1)
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('unlock')
                .setDescription('Unlock a new fishing location')
                .addStringOption(o =>
                    o.setName('location')
                        .setDescription('Location to unlock')
                        .setRequired(true)
                        .addChoices(...UNLOCK_CHOICES))),

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
            case 'list':    return showList(interaction, user, currency);
            case 'rod':     return handleBuyRod(interaction, user, currency);
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
    const f = user.fishing;

    const rodSection = ROD_TIERS.map(r =>
        `${r.emoji} **T${r.tier} ${r.name}** — ${currency}${r.cost.toLocaleString()}\n   ${r.description}`
    ).join('\n');

    const upgradeSection = Object.values(ROD_UPGRADES).map(u =>
        `${u.emoji} **${u.name}** — ~${Math.round(u.costMultiplier * 100)}% of rod price\n   *${u.description}*`
    ).join('\n');

    const baitSection = BAIT_PACKS.map(p =>
        `${p.emoji} **${p.name}** — ${currency}${p.cost} \`${p.id}\``
    ).join('\n');

    const consumableSection = Object.values(CONSUMABLES).map(c =>
        `${c.emoji} **${c.name}** — ${currency}${c.cost}\n   *${c.description}*`
    ).join('\n');

    const locationSection = LOCATION_LIST.map(loc => {
        const unlocked = f.unlockedLocations.includes(loc.id);
        const isActive = f.activeLocation === loc.id;
        const status = unlocked
            ? (isActive ? '✅ **ACTIVE**' : '✅ Unlocked')
            : `🔒 Lv.${loc.unlockLevel}${loc.unlockCost > 0 ? ` / ${currency}${loc.unlockCost.toLocaleString()}` : ' (free)'}`;
        return `${loc.emoji} **${loc.name}** — ${status}\n   *${loc.description}*`;
    }).join('\n');

    const embed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle('🏪 Fishing Shop')
        .addFields(
            { name: '🎣 Rods',                     value: rodSection,        inline: false },
            { name: '🔧 Rod Upgrades (1 per rod)', value: upgradeSection,    inline: false },
            { name: '🪱 Bait Packs',               value: baitSection,       inline: false },
            { name: '🧪 Consumables',              value: consumableSection,  inline: false },
            { name: '🗺️ Locations',                value: locationSection,   inline: false }
        )
        .setFooter({ text: '/fishshop rod • /fishshop upgrade • /fishshop buy • /fishshop use • /fishshop repair • /fishshop unlock' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ─── BUY ROD ─────────────────────────────────────────────────────────────────

async function handleBuyRod(interaction, user, currency) {
    const slug    = interaction.options.getString('type');
    const rodData = ROD_BY_SLUG[slug];

    if (!rodData) {
        return interaction.reply({ content: 'Unknown rod type.', ephemeral: true });
    }
    if (user.balance < rodData.cost) {
        return interaction.reply({
            content: `You need **${currency}${rodData.cost.toLocaleString()}** to buy the **${rodData.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            ephemeral: true
        });
    }

    const confirmEmbed = new EmbedBuilder()
        .setColor('#3498db')
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

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buyrod_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('buyrod_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], ephemeral: true, fetchReply: true });
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', ephemeral: true });
        }
        collector.stop();

        if (btn.customId === 'buyrod_cancel') {
            return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
        }

        const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        ensureFishingData(freshUser);

        if (freshUser.balance < rodData.cost) {
            return btn.update({ content: `Insufficient funds. You need ${currency}${rodData.cost.toLocaleString()}.`, embeds: [], components: [] });
        }

        freshUser.balance -= rodData.cost;
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
            return btn.update({ content: 'Something went wrong. Please try again.', embeds: [], components: [] });
        }

        const rodIndex = freshUser.fishing.rods.length;
        return btn.update({
            embeds: [
                new EmbedBuilder()
                    .setColor('#2ecc71')
                    .setTitle(`${rodData.emoji} ${rodData.name} Purchased!`)
                    .setDescription(`You now own a **${rodData.name}**. Equip it with \`/fishinv equip ${rodIndex}\`.`)
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

// ─── BUY UPGRADE ─────────────────────────────────────────────────────────────

async function handleBuyUpgrade(interaction, user, currency) {
    const f = user.fishing;

    if (f.equippedRodIndex < 0 || !f.rods[f.equippedRodIndex]) {
        return interaction.reply({ content: `You don't have a rod equipped. Use \`/fishinv equip\` first.`, ephemeral: true });
    }

    const upgradeId  = interaction.options.getString('type');
    const upgradeDef = ROD_UPGRADES[upgradeId];

    if (!upgradeDef) {
        return interaction.reply({ content: 'Unknown upgrade.', ephemeral: true });
    }

    const rod     = f.rods[f.equippedRodIndex];
    const rodData = ROD_BY_TIER[rod.tier];
    const cost    = Math.round(rodData.cost * upgradeDef.costMultiplier);

    if (rod.upgrade) {
        return interaction.reply({
            content: `Your **${rod.name}** already has the **${rod.upgrade.replace(/_/g, ' ')}** upgrade. Each rod can only hold one upgrade.`,
            ephemeral: true
        });
    }
    if (user.balance < cost) {
        return interaction.reply({
            content: `You need **${currency}${cost.toLocaleString()}** to install **${upgradeDef.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            ephemeral: true
        });
    }

    const confirmEmbed = new EmbedBuilder()
        .setColor('#9b59b6')
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

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], ephemeral: true, fetchReply: true });
    const collector = reply.createMessageComponentCollector({ time: 30_000 });

    collector.on('collect', async btn => {
        if (btn.user.id !== interaction.user.id) {
            return btn.reply({ content: 'This is not your confirmation.', ephemeral: true });
        }
        collector.stop();

        if (btn.customId === 'upgrade_cancel') {
            return btn.update({ content: 'Installation cancelled.', embeds: [], components: [] });
        }

        const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        ensureFishingData(freshUser);

        if (freshUser.balance < cost) {
            return btn.update({ content: 'Insufficient funds.', embeds: [], components: [] });
        }

        const freshRod = freshUser.fishing.rods[freshUser.fishing.equippedRodIndex];
        if (!freshRod || freshRod.upgrade) {
            return btn.update({ content: 'Rod already has an upgrade or is no longer equipped.', embeds: [], components: [] });
        }

        freshUser.balance -= cost;
        freshRod.upgrade   = upgradeId;
        freshUser.markModified('fishing');

        try {
            await freshUser.save();
        } catch (err) {
            console.error('[fishshop upgrade] save error:', err);
            return btn.update({ content: 'Something went wrong. Please try again.', embeds: [], components: [] });
        }

        return btn.update({
            embeds: [
                new EmbedBuilder()
                    .setColor('#2ecc71')
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

// ─── BUY SUPPLIES ────────────────────────────────────────────────────────────

async function handleBuy(interaction, user, currency) {
    const itemId   = interaction.options.getString('item');
    const quantity = interaction.options.getInteger('quantity') ?? 1;
    const f        = user.fishing;

    const baitPack = BAIT_PACKS.find(p => p.id === itemId);
    if (baitPack) {
        const totalCost = baitPack.cost * quantity;
        if (user.balance < totalCost) {
            return interaction.reply({
                content: `You need **${currency}${totalCost.toLocaleString()}** for ${quantity}x **${baitPack.name}**. You have **${currency}${user.balance.toLocaleString()}**.`,
                ephemeral: true
            });
        }

        const totalBait = (f.bait[baitPack.baitType] ?? 0) + baitPack.quantity * quantity;
        if (totalBait > 200) {
            return interaction.reply({ content: `You can't carry more than 200 of that bait type.`, ephemeral: true });
        }

        const baitField = `fishing.bait.${baitPack.baitType}`;
        const addedQty  = baitPack.quantity * quantity;

        const updated = await User.findOneAndUpdate(
            {
                userId:  interaction.user.id,
                guildId: interaction.guild.id,
                balance: { $gte: totalCost },
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
                        { name: 'Spent',   value: `${currency}${totalCost.toLocaleString()}`,               inline: true },
                        { name: 'Balance', value: `${currency}${updated.balance.toLocaleString()}`,         inline: true },
                        { name: 'Stock',   value: `${newBaitQty} ${baitPack.baitType.replace(/_/g, ' ')}`, inline: true }
                    )
                    .setTimestamp()
            ]
        });
    }

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
                    { name: 'Spent',   value: `${currency}${totalCost.toLocaleString()}`,                            inline: true },
                    { name: 'Balance', value: `${currency}${updated.balance.toLocaleString()}`,                      inline: true },
                    { name: 'Stock',   value: `${updated.fishing?.consumables?.[itemId] ?? quantity} owned`,         inline: true }
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
    if (f.activeBait)     statusLines.push(`🐟 ${f.activeBait.replace(/_/g, ' ')} active (${f.activeBaitCastsLeft} casts left)`);
    if (f.activeLuck)     statusLines.push(`🍀 Angler's Luck queued for next cast`);
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

// ─── REPAIR ──────────────────────────────────────────────────────────────────

async function handleRepair(interaction, user, currency) {
    const f = user.fishing;

    if (f.equippedRodIndex < 0 || !f.rods[f.equippedRodIndex]) {
        return interaction.reply({ content: `You don't have a rod equipped. Buy one with \`/fishshop rod\`.`, ephemeral: true });
    }

    const rod    = f.rods[f.equippedRodIndex];
    const method = interaction.options.getString('method');

    if (method === 'kit') {
        const kitId = interaction.options.getString('kit');
        if (!kitId) {
            return interaction.reply({ content: 'Please specify a kit size using the `kit` option.', ephemeral: true });
        }

        const kitStock   = f.consumables[kitId] ?? 0;
        const kitRestore = kitId === 'repair_kit_small' ? 20 : 50;
        const kitName    = kitId === 'repair_kit_small' ? 'Small Repair Kit' : 'Large Repair Kit';

        if (kitStock <= 0) {
            return interaction.reply({ content: `You don't have any **${kitName}**. Buy one with \`/fishshop buy\`.`, ephemeral: true });
        }
        if (rod.status === 'condemned') {
            return interaction.reply({ content: 'This rod is condemned and cannot be repaired.', ephemeral: true });
        }
        if (rod.currentDurability >= rod.maxDurability && rod.status !== 'broken') {
            return interaction.reply({ content: 'Your rod is already at full durability.', ephemeral: true });
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
            return interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true });
        }

        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor('#2ecc71')
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

    // Shop repair
    const requestedAmount = interaction.options.getInteger('amount') ?? null;
    const result = applyRepair(rod, requestedAmount);

    if (result.error) {
        return interaction.reply({ content: result.error, ephemeral: true });
    }
    if (user.balance < result.cost) {
        return interaction.reply({
            content: `Repairing **${result.restoredAmount}** durability costs **${currency}${result.cost.toLocaleString()}**. You only have **${currency}${user.balance.toLocaleString()}**.`,
            ephemeral: true
        });
    }

    user.balance -= result.cost;
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[fishshop repair shop] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setColor('#2ecc71')
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
        embed.setColor('#e74c3c');
        embed.addFields({ name: '⚠️ Condemned', value: 'This rod has been repaired too many times and cannot be repaired again. Consider buying a new one with `/fishshop rod`.', inline: false });
    } else {
        embed.addFields({ name: 'ℹ️ Note', value: `Max durability slightly reduced to ${rod.maxDurability} after this repair.`, inline: false });
    }

    return interaction.reply({ embeds: [embed] });
}

// ─── UNLOCK LOCATION ─────────────────────────────────────────────────────────

async function handleUnlock(interaction, user, currency) {
    const f          = user.fishing;
    const locationId = interaction.options.getString('location');
    const location   = LOCATIONS[locationId];

    if (!location) {
        return interaction.reply({ content: 'Unknown location.', ephemeral: true });
    }
    if (f.unlockedLocations.includes(locationId)) {
        return interaction.reply({ content: `**${location.name}** is already unlocked.`, ephemeral: true });
    }
    if (f.level < location.unlockLevel) {
        return interaction.reply({
            content: `You need Fisher Level **${location.unlockLevel}** to unlock **${location.name}**. You are Level **${f.level}**.`,
            ephemeral: true
        });
    }
    if (user.balance < location.unlockCost) {
        return interaction.reply({
            content: `Unlocking **${location.name}** costs **${currency}${location.unlockCost.toLocaleString()}**. You have **${currency}${user.balance.toLocaleString()}**.`,
            ephemeral: true
        });
    }

    const updated = await User.findOneAndUpdate(
        {
            userId:   interaction.user.id,
            guildId:  interaction.guild.id,
            balance:  { $gte: location.unlockCost },
            'fishing.level': { $gte: location.unlockLevel },
            'fishing.unlockedLocations': { $ne: locationId }
        },
        {
            $inc:      { balance: -location.unlockCost },
            $addToSet: { 'fishing.unlockedLocations': locationId },
            $set:      { 'fishing.activeLocation': locationId }
        },
        { new: true }
    );

    if (!updated) {
        return interaction.reply({ content: 'Purchase failed. Conditions may have changed — please try again.', ephemeral: true });
    }

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor('#f39c12')
                .setTitle(`🗺️ ${location.emoji} ${location.name} Unlocked!`)
                .setDescription(location.description)
                .addFields(
                    { name: 'Cost Paid', value: location.unlockCost > 0 ? `${currency}${location.unlockCost.toLocaleString()}` : 'Free', inline: true },
                    { name: 'Balance',   value: `${currency}${updated.balance.toLocaleString()}`,                                          inline: true },
                    { name: 'Status',    value: 'Now your active location!',                                                              inline: true }
                )
                .setFooter({ text: 'Use /fish to start catching from this location • Switch anytime with /fishlocation set' })
                .setTimestamp()
        ]
    });
}
