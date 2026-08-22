'use strict';

// The /mine shop group: browsing, buying pickaxes, upgrades, blasts and
// consumables, using them, repairing a pickaxe, and unlocking a depth.

const Guild = require('../../../models/Guild');
const { MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User = require('../../../models/User');
const { attachGrind, persistGrindIfNew, saveGrind } = require('../../../utils/grindProfile');
const {
    ensureMineData,
    activateConsumable,
    quoteRepair,
    applyRepair,
    pickaxeStatusEmoji,
    isCondemned,
    updatePickaxeStatus
} = require('../../../services/mineService');
const {
    PICKAXE_TIERS,
    PICKAXE_UPGRADES,
    BLAST_PACKS,
    CONSUMABLES,
    DEPTH_LIST,
    PICKAXE_BY_SLUG,
    PICKAXE_BY_TIER,
    DEPTHS
} = require('../../../data/mineData');
const { runShopBrowse } = require('../../../utils/shopBrowse');
const { getItemImageAttachment } = require('../../../utils/itemImageHelper');
const GrindProfile = require('../../../models/GrindProfile');
const { chargeBalance, refundBalance, resolveConsumableDef } = require('./shared');

// ─── SHOP ─────────────────────────────────────────────────────────────────────

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
    ensureMineData(user);
    const m = user.mining;

    if (sub === 'list') {
        const pickaxeItems = PICKAXE_TIERS.map(p => ({
            imageId: `mine:${p.slug}`,
            name:    p.name,
            price:   p.cost,
            emoji:   p.emoji,
            badge:   `T${p.tier}`,
            subline: `${Math.round(p.successRate * 100)}% • +${Math.round(p.rarityBoost * 100)}% rare`
        }));
        const pickaxeList = PICKAXE_TIERS.map(p =>
            `${p.emoji} **${p.name}** — ${currency}${p.cost.toLocaleString()} · \`/mine shop pickaxe type:${p.slug}\``
        ).join('\n');

        const upgradeItems = Object.values(PICKAXE_UPGRADES).map(u => ({
            imageId: `mine:${u.id}`,
            name:    u.name,
            emoji:   u.emoji,
            subline: `${Math.round(u.costMultiplier * 100)}% of pickaxe`
        }));
        const upgradeList = Object.values(PICKAXE_UPGRADES).map(u =>
            `${u.emoji} **${u.name}** — *${u.description}* · \`/mine shop upgrade module:${u.id}\``
        ).join('\n');

        const blastItems = BLAST_PACKS.map(b => ({
            imageId: `mine:${b.id}`,
            name:    b.name,
            price:   b.cost,
            emoji:   b.emoji
        }));
        const blastList = BLAST_PACKS.map(b =>
            `${b.emoji} **${b.name}** — ${currency}${b.cost} · \`/mine shop buy item:${b.id}\``
        ).join('\n');

        const consumableItems = Object.values(CONSUMABLES).map(c => ({
            imageId: `mine:${c.id}`,
            name:    c.name,
            price:   c.cost,
            emoji:   c.emoji
        }));
        const consumableList = Object.values(CONSUMABLES).map(c =>
            `${c.emoji} **${c.name}** — ${currency}${c.cost} · \`/mine shop buy item:${c.id}\``
        ).join('\n');

        const depthItems = DEPTH_LIST.map(d => {
            const unlocked = m.unlockedDepths?.includes(d.id) ?? d.defaultUnlocked;
            const isActive = m.activeDepth === d.id;
            return {
                imageId: `mine:${d.id}`,
                name:    d.name,
                emoji:   d.emoji,
                badge:   isActive ? 'ACTIVE' : (unlocked ? 'OWNED' : `Lv.${d.unlockLevel}`),
                subline: unlocked ? (isActive ? 'Currently mining' : 'Unlocked') : `${currency}${d.unlockCost.toLocaleString()}`
            };
        });
        const depthList = DEPTH_LIST.map(d => {
            const unlocked = m.unlockedDepths?.includes(d.id) ?? d.defaultUnlocked;
            const isActive = m.activeDepth === d.id;
            const status = unlocked
                ? (isActive ? '✅ **ACTIVE**' : '✅ Unlocked')
                : `🔒 Lv.${d.unlockLevel} / ${currency}${d.unlockCost.toLocaleString()}`;
            return `${d.emoji} **${d.name}** — ${status}`;
        }).join('\n');

        return runShopBrowse(interaction, {
            activity: 'mine',
            title:    'Mining Shop',
            currency,
            footer:   'pickaxe • upgrade • buy • use • repair • unlock',
            pages: [
                { id: 'pickaxes',    label: 'Pickaxes',    emoji: '🪓',  subtitle: 'Stronger picks bite deeper veins.',     items: pickaxeItems,    listText: pickaxeList    },
                { id: 'upgrades',    label: 'Upgrades',    emoji: '🔩',  subtitle: 'One module per pickaxe, permanent.',     items: upgradeItems,    listText: upgradeList    },
                { id: 'blasts',      label: 'Blast Charges', emoji: '💥', subtitle: 'Crack through stubborn rock.',          items: blastItems,      listText: blastList      },
                { id: 'consumables', label: 'Consumables', emoji: '🎒',  subtitle: 'Repairs, charms and quick boosts.',      items: consumableItems, listText: consumableList },
                { id: 'depths',      label: 'Depths',      emoji: '🗺️', subtitle: 'New depths, new ores.',                  items: depthItems,      listText: depthList      }
            ]
        });
    }

    if (sub === 'pickaxe') {
        const slug = interaction.options.getString('type');
        const autoEquip = interaction.options.getBoolean('equip') ?? true;
        const pickaxeData = PICKAXE_BY_SLUG[slug];

        if (!pickaxeData) return interaction.reply({ content: 'Unknown pickaxe type.', flags: MessageFlags.Ephemeral });

        if (user.balance < pickaxeData.cost) {
            return interaction.reply({
                content: `You need ${currency}${pickaxeData.cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`,
                flags: MessageFlags.Ephemeral
            });
        }

        const confirmEmbed = new EmbedBuilder()
            .setColor('#f39c12')
            .setTitle(`${pickaxeData.emoji} Purchase ${pickaxeData.name}?`)
            .addFields(
                { name: 'Cost',          value: `${currency}${pickaxeData.cost.toLocaleString()}`, inline: true },
                { name: 'Success Rate',  value: `${Math.round(pickaxeData.successRate * 100)}%`, inline: true },
                { name: 'Rarity Boost',  value: `+${Math.round(pickaxeData.rarityBoost * 100)}%`, inline: true },
                { name: 'Durability',    value: `${pickaxeData.baseDurability}`, inline: true },
                { name: 'Your Balance',  value: `${currency}${user.balance.toLocaleString()}`, inline: true }
            )
            .setFooter({ text: 'Confirmation expires in 30 seconds' });

        const pickaxeImg = await getItemImageAttachment(`mine:${pickaxeData.slug || pickaxeData.id}`).catch(() => null);
        if (pickaxeImg) confirmEmbed.setThumbnail(pickaxeImg.url);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('minepickaxe_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
            new ButtonBuilder().setCustomId('minepickaxe_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
        );

        const confirmPayload = { embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, withResponse: true };
        if (pickaxeImg) confirmPayload.files = [pickaxeImg.attachment];
        const response = await interaction.reply(confirmPayload);
        const reply = response.resource.message;
        const collector = reply.createMessageComponentCollector({ time: 30_000 });

        let actionPromise = null;
        collector.on('collect', btn => {
            if (btn.user.id !== interaction.user.id) {
                return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
            }

            if (btn.customId === 'minepickaxe_cancel') {
                collector.stop();
                return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
            }

            actionPromise = (async () => {
            try {
                await btn.deferUpdate();

                const newPickaxe = {
                    name: pickaxeData.name,
                    tier: pickaxeData.tier,
                    slug: pickaxeData.slug,
                    currentDurability: pickaxeData.baseDurability,
                    maxDurability: pickaxeData.baseDurability,
                    baseDurability: pickaxeData.baseDurability,
                    repairCount: 0,
                    upgrade: null,
                    status: 'good',
                    acquiredAt: new Date()
                };

                const updated = await User.findOneAndUpdate(
                    { userId: user.userId, guildId: user.guildId, balance: { $gte: pickaxeData.cost } },
                    { $inc: { balance: -pickaxeData.cost } },
                    { new: true }
                );
                if (!updated) {
                    return interaction.editReply({ content: `Insufficient funds. You need ${currency}${pickaxeData.cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`, embeds: [], components: [] });
                }

                await persistGrindIfNew(user, 'mining');
                const profUpdated = await GrindProfile.findOneAndUpdate(
                    { userId: user.userId, guildId: user.guildId, system: 'mining' },
                    { $push: { 'data.pickaxes': newPickaxe } },
                    { new: true }
                ).catch(err => { console.error('[mineshop pickaxe] profile push error:', err); return null; });

                if (!profUpdated) {
                    await User.updateOne({ userId: user.userId, guildId: user.guildId }, { $inc: { balance: pickaxeData.cost } }).catch(() => {});
                    return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
                }

                m.pickaxes = profUpdated.data.pickaxes;
                const newIndex = m.pickaxes.length - 1;

                if (autoEquip) {
                    const oldIndex = m.equippedPickaxeIndex;
                    m.equippedPickaxeIndex = newIndex;
                    try {
                        await GrindProfile.updateOne(
                            { userId: user.userId, guildId: user.guildId, system: 'mining' },
                            { $set: { 'data.equippedPickaxeIndex': newIndex } }
                        );
                    } catch (err) {
                        console.error('[mineshop pickaxe] equip update error:', err);
                        m.equippedPickaxeIndex = oldIndex;
                    }
                }

                const equipped = m.equippedPickaxeIndex === newIndex;
                const embed = new EmbedBuilder()
                    .setColor('#b5651d')
                    .setTitle(`${pickaxeData.emoji} Pickaxe Purchased!`)
                    .setDescription(`You bought a **${pickaxeData.name}**!${equipped ? ' It has been equipped.' : ' Use `/mine inv equip` to equip it.'}`)
                    .addFields(
                        { name: 'Success Rate',  value: `${Math.round(pickaxeData.successRate * 100)}%`, inline: true },
                        { name: 'Rarity Boost',  value: `+${Math.round(pickaxeData.rarityBoost * 100)}%`, inline: true },
                        { name: 'Durability',    value: `${pickaxeData.baseDurability}`, inline: true },
                        { name: 'Balance',       value: `${currency}${updated.balance.toLocaleString()}`, inline: true }
                    )
                    .setTimestamp();

                await interaction.editReply({ embeds: [embed], components: [] });
            } catch (err) {
                console.error('[mineshop pickaxe] purchase error:', err);
                interaction.editReply({ content: 'Something went wrong. Please try again.', embeds: [], components: [] }).catch(() => {});
            }
            })();

            collector.stop();
        });

        return new Promise(resolve => {
            collector.on('end', async (_, reason) => {
                if (reason === 'time') {
                    interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
                }
                if (actionPromise) await actionPromise.catch(() => {});
                resolve();
            });
        });
    }

    if (sub === 'upgrade') {
        const moduleId = interaction.options.getString('module');
        const upgradeDef = PICKAXE_UPGRADES[moduleId];
        if (!upgradeDef) return interaction.reply({ content: 'Unknown upgrade module.', flags: MessageFlags.Ephemeral });

        if (m.equippedPickaxeIndex < 0 || !m.pickaxes[m.equippedPickaxeIndex]) {
            return interaction.reply({ content: `You don't have a pickaxe equipped. Equip one with \`/mine inv equip\`.`, flags: MessageFlags.Ephemeral });
        }

        const pickaxe = m.pickaxes[m.equippedPickaxeIndex];
        if (pickaxe.upgrade) {
            return interaction.reply({ content: `Your **${pickaxe.name}** already has the **${pickaxe.upgrade.replace(/_/g, ' ')}** upgrade installed. Each pickaxe can only have one upgrade.`, flags: MessageFlags.Ephemeral });
        }

        const pickaxeData = PICKAXE_BY_TIER[pickaxe.tier];
        const cost = Math.round(pickaxeData.cost * upgradeDef.costMultiplier);

        if (user.balance < cost) {
            return interaction.reply({ content: `This upgrade costs ${currency}${cost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`, flags: MessageFlags.Ephemeral });
        }

        await persistGrindIfNew(user, 'mining');
        const charged = await chargeBalance(interaction, cost);
        if (!charged) {
            return interaction.reply({ content: `This upgrade costs ${currency}${cost.toLocaleString()} — you no longer have enough. Check \`/balance\` and try again.`, flags: MessageFlags.Ephemeral });
        }
        // Take the authoritative balance and keep any later save off that path.
        user.balance = charged.balance;
        user.unmarkModified('balance');

        pickaxe.upgrade = moduleId;
        user.markModified('mining');
        try {
            await saveGrind(user, ['mining']);
        } catch (err) {
            console.error('[mineshop upgrade] save error:', err);
            pickaxe.upgrade = null;
            await refundBalance(interaction, cost);
            return interaction.reply({ content: 'Installing the upgrade failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
        }

        const embed = new EmbedBuilder()
            .setColor('#b5651d')
            .setTitle(`${upgradeDef.emoji} Upgrade Installed!`)
            .setDescription(`**${upgradeDef.name}** has been installed on your **${pickaxe.name}**.\n> ${upgradeDef.description}`)
            .addFields({ name: 'Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true })
            .setTimestamp();
        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'buy') {
        const itemId  = interaction.options.getString('item');
        const qty     = interaction.options.getInteger('quantity') ?? 1;

        const consumableDef = CONSUMABLES[itemId];
        const blastDef      = BLAST_PACKS.find(b => b.id === itemId);
        const itemDef       = consumableDef || blastDef;

        if (!itemDef) return interaction.reply({ content: 'Unknown item.', flags: MessageFlags.Ephemeral });

        const totalCost = itemDef.cost * qty;
        if (user.balance < totalCost) {
            return interaction.reply({ content: `You need ${currency}${totalCost.toLocaleString()} for ${qty}× but only have ${currency}${user.balance.toLocaleString()}.`, flags: MessageFlags.Ephemeral });
        }

        if (consumableDef) {
            const current = m.consumables[itemId] ?? 0;
            if (current + qty > consumableDef.maxStack) {
                return interaction.reply({ content: `You can only carry ${consumableDef.maxStack}× **${consumableDef.name}**. You already have ${current}.`, flags: MessageFlags.Ephemeral });
            }
        }

        const gainedLabel  = blastDef
            ? `${blastDef.quantity * qty}× ${blastDef.chargeType.replace(/_/g, ' ')}`
            : `${qty}× ${consumableDef.name}`;
        const currentStock = blastDef
            ? `${m.charges[blastDef.chargeType] ?? 0} in stock`
            : `${m.consumables[itemId] ?? 0}/${consumableDef.maxStack} in stock`;

        const confirmEmbed = new EmbedBuilder()
            .setColor('#f39c12')
            .setTitle(`${itemDef.emoji ?? '🛒'} Confirm Purchase`)
            .setDescription(itemDef.description ?? '')
            .addFields(
                { name: 'Item',         value: itemDef.name,                                  inline: true },
                { name: 'Quantity',     value: gainedLabel,                                   inline: true },
                { name: 'Total Cost',   value: `${currency}${totalCost.toLocaleString()}`,    inline: true },
                { name: 'Your Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true },
                { name: 'Currently',    value: currentStock,                                   inline: true }
            )
            .setFooter({ text: 'Confirmation expires in 30 seconds' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('minebuy_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
            new ButtonBuilder().setCustomId('minebuy_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
        );

        const response = await interaction.reply({ embeds: [confirmEmbed], components: [row], flags: MessageFlags.Ephemeral, withResponse: true });
        const reply = response.resource.message;
        const collector = reply.createMessageComponentCollector({ time: 30_000 });

        let actionPromise = null;
        collector.on('collect', btn => {
            if (btn.user.id !== interaction.user.id) {
                return btn.reply({ content: 'This is not your confirmation.', flags: MessageFlags.Ephemeral });
            }

            if (btn.customId === 'minebuy_cancel') {
                collector.stop();
                return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
            }

            actionPromise = (async () => {
            try {
                await btn.deferUpdate();

                await persistGrindIfNew(user, 'mining');
                const balanceUpdated = await User.findOneAndUpdate(
                    { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: totalCost } },
                    { $inc: { balance: -totalCost } },
                    { new: true }
                );
                if (!balanceUpdated) {
                    return interaction.editReply({ content: 'Insufficient funds. Please try again.', embeds: [], components: [] });
                }

                if (consumableDef) {
                    const consumableField = `data.consumables.${itemId}`;
                    const profUpdated = await GrindProfile.findOneAndUpdate(
                        {
                            userId:  interaction.user.id,
                            guildId: interaction.guild.id,
                            system:  'mining',
                            $expr: { $lte: [{ $add: [{ $ifNull: [`$${consumableField}`, 0] }, qty] }, consumableDef.maxStack] }
                        },
                        { $inc: { [consumableField]: qty } },
                        { new: true }
                    ).catch(() => null);

                    if (!profUpdated) {
                        await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } }).catch(() => {});
                        return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
                    }
                    m.consumables[itemId] = profUpdated.data?.consumables?.[itemId] ?? qty;
                } else {
                    const chargeField = `data.charges.${blastDef.chargeType}`;
                    const profUpdated = await GrindProfile.findOneAndUpdate(
                        { userId: interaction.user.id, guildId: interaction.guild.id, system: 'mining' },
                        { $inc: { [chargeField]: blastDef.quantity * qty } },
                        { new: true }
                    ).catch(() => null);

                    if (!profUpdated) {
                        await User.updateOne({ userId: interaction.user.id, guildId: interaction.guild.id }, { $inc: { balance: totalCost } }).catch(() => {});
                        return interaction.editReply({ content: 'Purchase failed — your coins were refunded. Please try again.', embeds: [], components: [] });
                    }
                    m.charges[blastDef.chargeType] = profUpdated.data?.charges?.[blastDef.chargeType] ?? (blastDef.quantity * qty);
                }

                const received = blastDef
                    ? `${blastDef.quantity * qty}× ${blastDef.chargeType.replace(/_/g, ' ')}`
                    : `${qty}× ${consumableDef.name}`;

                await interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor('#2ecc71')
                            .setTitle('✅ Purchase Complete')
                            .setDescription(`Bought **${received}** for **${currency}${totalCost.toLocaleString()}**.`)
                            .addFields({ name: 'Balance', value: `${currency}${balanceUpdated.balance.toLocaleString()}`, inline: true })
                            .setTimestamp()
                    ],
                    components: []
                });
            } catch (err) {
                console.error('[mineshop buy] purchase error:', err);
                interaction.editReply({ content: 'Something went wrong. Please try again.', embeds: [], components: [] }).catch(() => {});
            }
            })();

            collector.stop();
        });

        return new Promise(resolve => {
            collector.on('end', async (_, reason) => {
                if (reason === 'time') {
                    interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
                }
                if (actionPromise) await actionPromise.catch(() => {});
                resolve();
            });
        });
    }

    if (sub === 'use') {
        const itemId = interaction.options.getString('item');
        const result = activateConsumable(user, itemId);

        if (!result.success) {
            return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
        }

        await user.save();

        const def = resolveConsumableDef(itemId);
        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor('#2ecc71')
                    .setTitle(`${def?.emoji ?? '✅'} ${def?.name ?? itemId} Activated!`)
                    .setDescription(def?.description ?? 'Consumable activated.')
                    .setTimestamp()
            ]
        });
    }

    if (sub === 'repair') {
        const method = interaction.options.getString('method');

        if (m.equippedPickaxeIndex < 0 || !m.pickaxes[m.equippedPickaxeIndex]) {
            return interaction.reply({ content: `You don't have a pickaxe equipped.`, flags: MessageFlags.Ephemeral });
        }

        const pickaxe = m.pickaxes[m.equippedPickaxeIndex];

        if (method === 'shop') {
            // Price it before touching the pickaxe: applyRepair permanently degrades
            // max durability, so quoting first keeps a player who can't pay from
            // wearing their pickaxe down for nothing.
            const quote = quoteRepair(pickaxe, null);
            if (quote.error) return interaction.reply({ content: quote.error, flags: MessageFlags.Ephemeral });

            if (user.balance < quote.cost) {
                return interaction.reply({ content: `Repair costs ${currency}${quote.cost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`, flags: MessageFlags.Ephemeral });
            }

            await persistGrindIfNew(user, 'mining');
            const charged = await chargeBalance(interaction, quote.cost);
            if (!charged) {
                return interaction.reply({ content: `Repair costs ${currency}${quote.cost.toLocaleString()} — you no longer have enough. Check \`/balance\` and try again.`, flags: MessageFlags.Ephemeral });
            }
            user.balance = charged.balance;
            user.unmarkModified('balance');

            const repairResult = applyRepair(pickaxe, null);
            user.markModified('mining');
            try {
                await saveGrind(user, ['mining']);
            } catch (err) {
                console.error('[mineshop repair] save error:', err);
                await refundBalance(interaction, quote.cost);
                return interaction.reply({ content: 'The repair failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
            }

            const embed = new EmbedBuilder()
                .setColor('#b5651d')
                .setTitle('🔧 Pickaxe Repaired')
                .setDescription(`**${pickaxe.name}** repaired at the shop.`)
                .addFields(
                    { name: 'Durability',  value: `${pickaxe.currentDurability}/${pickaxe.maxDurability}`, inline: true },
                    { name: 'Status',      value: `${pickaxeStatusEmoji(pickaxe.status)} ${pickaxe.status}`, inline: true },
                    { name: 'Cost',        value: `${currency}${repairResult.cost.toLocaleString()}`, inline: true },
                    { name: 'Balance',     value: `${currency}${user.balance.toLocaleString()}`, inline: true }
                );

            if (repairResult.condemned) {
                embed.addFields({ name: '💀 Condemned', value: `After so many repairs, your **${pickaxe.name}** has been condemned. It cannot be repaired again. Time for a new one.`, inline: false });
            }
            embed.setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        if (method === 'kit_small' || method === 'kit_large') {
            const kitId = method === 'kit_small' ? 'repair_kit_small' : 'repair_kit_large';
            const kit   = CONSUMABLES[kitId];
            const stock = m.consumables[kitId] ?? 0;

            if (stock <= 0) {
                return interaction.reply({ content: `You don't have any **${kit.name}**. Buy one with \`/mine shop buy\`.`, flags: MessageFlags.Ephemeral });
            }

            if (isCondemned(pickaxe)) {
                return interaction.reply({ content: 'This pickaxe is condemned and cannot be repaired. Replace it with `/mine shop pickaxe`.', flags: MessageFlags.Ephemeral });
            }
            if (pickaxe.currentDurability >= pickaxe.maxDurability) {
                return interaction.reply({ content: 'Pickaxe is already at full durability.', flags: MessageFlags.Ephemeral });
            }

            m.consumables[kitId] -= 1;
            const restored = Math.min(kit.durabilityRestore, pickaxe.maxDurability - pickaxe.currentDurability);
            pickaxe.currentDurability = Math.min(pickaxe.maxDurability, pickaxe.currentDurability + kit.durabilityRestore);
            updatePickaxeStatus(pickaxe);
            user.markModified('mining');
            await user.save();

            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor('#b5651d')
                        .setTitle(`${kit.emoji} Repair Kit Used`)
                        .setDescription(`Restored **${restored}** durability to **${pickaxe.name}**.`)
                        .addFields(
                            { name: 'Durability', value: `${pickaxe.currentDurability}/${pickaxe.maxDurability}`, inline: true },
                            { name: 'Status',     value: `${pickaxeStatusEmoji(pickaxe.status)} ${pickaxe.status}`, inline: true }
                        )
                        .setTimestamp()
                ]
            });
        }
    }

    if (sub === 'unlock') {
        const depthId  = interaction.options.getString('depth');
        const depthDef = DEPTHS[depthId];

        if (!depthDef) return interaction.reply({ content: 'Unknown depth.', flags: MessageFlags.Ephemeral });
        if (depthDef.defaultUnlocked || m.unlockedDepths.includes(depthId)) {
            return interaction.reply({ content: `You've already unlocked **${depthDef.name}**.`, flags: MessageFlags.Ephemeral });
        }
        if (m.level < depthDef.unlockLevel) {
            return interaction.reply({ content: `You need Miner Level **${depthDef.unlockLevel}** to unlock **${depthDef.name}**. You're Level ${m.level}.`, flags: MessageFlags.Ephemeral });
        }
        if (user.balance < depthDef.unlockCost) {
            return interaction.reply({ content: `Unlocking **${depthDef.name}** costs ${currency}${depthDef.unlockCost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`, flags: MessageFlags.Ephemeral });
        }

        await persistGrindIfNew(user, 'mining');
        const charged = await chargeBalance(interaction, depthDef.unlockCost);
        if (!charged) {
            return interaction.reply({ content: `Unlocking **${depthDef.name}** costs ${currency}${depthDef.unlockCost.toLocaleString()} — you no longer have enough. Check \`/balance\` and try again.`, flags: MessageFlags.Ephemeral });
        }
        user.balance = charged.balance;
        user.unmarkModified('balance');

        const priorDepth = m.activeDepth;
        m.unlockedDepths.push(depthId);
        m.activeDepth = depthId;
        user.markModified('mining');
        try {
            await saveGrind(user, ['mining']);
        } catch (err) {
            console.error('[mineshop unlock] save error:', err);
            m.unlockedDepths = m.unlockedDepths.filter(id => id !== depthId);
            m.activeDepth = priorDepth;
            await refundBalance(interaction, depthDef.unlockCost);
            return interaction.reply({ content: 'The unlock failed — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
        }

        const embed = new EmbedBuilder()
            .setColor('#b5651d')
            .setTitle(`${depthDef.emoji} Depth Unlocked!`)
            .setDescription(`**${depthDef.name}** is now accessible.\n> ${depthDef.description}`)
            .addFields({ name: 'Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true })
            .setFooter({ text: `Now set as your active depth — use /mine dig to start digging!` })
            .setTimestamp();
        return interaction.reply({ embeds: [embed] });
    }
}

module.exports = {
    handleShop,
};
