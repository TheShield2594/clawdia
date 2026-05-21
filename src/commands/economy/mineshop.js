'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const {
    CONSUMABLES, BLAST_PACKS,
    PICKAXE_TIERS, PICKAXE_BY_TIER, PICKAXE_BY_SLUG, PICKAXE_UPGRADES,
    DEPTHS, DEPTH_LIST
} = require('../../data/mineData');
const {
    ensureMineData, activateConsumable, getMaxStamina,
    applyRepair, pickaxeStatusEmoji, durabilityBar, updatePickaxeStatus
} = require('../../services/mineService');

const PICKAXE_CHOICES  = PICKAXE_TIERS.map(p => ({ name: `${p.emoji} ${p.name} — ${p.cost.toLocaleString()} coins`, value: p.slug }));
const ALL_ITEMS        = [...Object.values(CONSUMABLES), ...BLAST_PACKS];
const ITEM_CHOICES     = ALL_ITEMS.map(i => ({ name: `${i.emoji ?? ''} ${i.name} — ${i.cost} coins`.trim(), value: i.id }));
const ACTIVATABLE      = ['ore_magnet', 'premium_magnet', 'miners_lamp', 'miners_instinct', 'xp_scroll', 'energy_tonic'];
const UPGRADE_CHOICES  = Object.values(PICKAXE_UPGRADES).map(u => ({ name: `${u.emoji} ${u.name} — ${u.description}`, value: u.id }));
const UNLOCK_CHOICES   = DEPTH_LIST.filter(d => !d.defaultUnlocked).map(d => ({ name: `${d.emoji} ${d.name}`, value: d.id }));

module.exports = {
    cooldown: 3,

    data: new SlashCommandBuilder()
        .setName('mineshop')
        .setDescription('Browse and purchase all mining gear, charges, and supplies')
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('Browse everything available in the mining shop'))
        .addSubcommand(sub =>
            sub.setName('pickaxe')
                .setDescription('Buy a new pickaxe')
                .addStringOption(o =>
                    o.setName('type')
                        .setDescription('Which pickaxe to buy')
                        .setRequired(true)
                        .addChoices(...PICKAXE_CHOICES))
                .addBooleanOption(o =>
                    o.setName('equip')
                        .setDescription('Auto-equip after purchase (default: true)')
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('upgrade')
                .setDescription('Install a module upgrade on your equipped pickaxe (one per pickaxe, permanent)')
                .addStringOption(o =>
                    o.setName('module')
                        .setDescription('Upgrade module to install')
                        .setRequired(true)
                        .addChoices(...UPGRADE_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('buy')
                .setDescription('Purchase blast charge packs or consumables')
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
                .setDescription('Repair your equipped pickaxe at the shop or use a repair kit')
                .addStringOption(o =>
                    o.setName('method')
                        .setDescription('Repair method')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Shop repair (pay coins)', value: 'shop' },
                            { name: 'Use Small Repair Kit',    value: 'kit_small' },
                            { name: 'Use Large Repair Kit',    value: 'kit_large' }
                        )))
        .addSubcommand(sub =>
            sub.setName('unlock')
                .setDescription('Unlock a new mine depth')
                .addStringOption(o =>
                    o.setName('depth')
                        .setDescription('Depth to unlock')
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
        ensureMineData(user);
        const m = user.mining;

        // ── LIST ───────────────────────────────────────────────────────────
        if (sub === 'list') {
            const embed = new EmbedBuilder()
                .setColor('#b5651d')
                .setTitle('⛏️ Mining Shop')
                .addFields(
                    {
                        name: '🪓 Pickaxes',
                        value: PICKAXE_TIERS.map(p =>
                            `${p.emoji} **${p.name}** — ${currency}${p.cost.toLocaleString()}\n> Success: ${Math.round(p.successRate * 100)}% • Rarity: +${Math.round(p.rarityBoost * 100)}% • Durability: ${p.baseDurability}${p.requiresCharge ? ` • Requires: ${p.chargeType.replace(/_/g, ' ')}` : ''}`
                        ).join('\n'),
                        inline: false
                    },
                    {
                        name: '🔩 Upgrades (one per pickaxe)',
                        value: Object.values(PICKAXE_UPGRADES).map(u =>
                            `${u.emoji} **${u.name}** — ${Math.round(u.costMultiplier * 100)}% of pickaxe cost\n> ${u.description}`
                        ).join('\n'),
                        inline: false
                    },
                    {
                        name: '💥 Blast Charges',
                        value: BLAST_PACKS.map(b =>
                            `${b.emoji} **${b.name}** — ${currency}${b.cost}\n> ${b.description}`
                        ).join('\n'),
                        inline: false
                    },
                    {
                        name: '🎒 Consumables',
                        value: Object.values(CONSUMABLES).map(c =>
                            `${c.emoji} **${c.name}** — ${currency}${c.cost}\n> ${c.description}`
                        ).join('\n'),
                        inline: false
                    },
                    {
                        name: '🗺️ Depths to Unlock',
                        value: DEPTH_LIST.filter(d => !d.defaultUnlocked).map(d =>
                            `${d.emoji} **${d.name}** — ${currency}${d.unlockCost.toLocaleString()} • Requires Lv.${d.unlockLevel}\n> ${d.description}`
                        ).join('\n'),
                        inline: false
                    }
                )
                .setFooter({ text: 'Use /mineshop pickaxe|buy|upgrade|repair|unlock to purchase' })
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        // ── PICKAXE ────────────────────────────────────────────────────────
        if (sub === 'pickaxe') {
            const slug = interaction.options.getString('type');
            const autoEquip = interaction.options.getBoolean('equip') ?? true;
            const pickaxeData = PICKAXE_BY_SLUG[slug];

            if (!pickaxeData) return interaction.reply({ content: 'Unknown pickaxe type.', ephemeral: true });

            if (user.balance < pickaxeData.cost) {
                return interaction.reply({
                    content: `You need ${currency}${pickaxeData.cost.toLocaleString()} but only have ${currency}${user.balance.toLocaleString()}.`,
                    ephemeral: true
                });
            }

            user.balance -= pickaxeData.cost;

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
            m.pickaxes.push(newPickaxe);
            user.markModified('mining');

            if (autoEquip) {
                m.equippedPickaxeIndex = m.pickaxes.length - 1;
                user.markModified('mining');
            }

            await user.save();

            const embed = new EmbedBuilder()
                .setColor('#b5651d')
                .setTitle(`${pickaxeData.emoji} Pickaxe Purchased!`)
                .setDescription(`You bought a **${pickaxeData.name}**!${autoEquip ? ' It has been equipped.' : ' Use `/mineinv equip` to equip it.'}`)
                .addFields(
                    { name: 'Success Rate',  value: `${Math.round(pickaxeData.successRate * 100)}%`, inline: true },
                    { name: 'Rarity Boost',  value: `+${Math.round(pickaxeData.rarityBoost * 100)}%`, inline: true },
                    { name: 'Durability',    value: `${pickaxeData.baseDurability}`, inline: true },
                    { name: 'Balance',       value: `${currency}${user.balance.toLocaleString()}`, inline: true }
                )
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        // ── UPGRADE ────────────────────────────────────────────────────────
        if (sub === 'upgrade') {
            const moduleId = interaction.options.getString('module');
            const upgradeDef = PICKAXE_UPGRADES[moduleId];
            if (!upgradeDef) return interaction.reply({ content: 'Unknown upgrade module.', ephemeral: true });

            if (m.equippedPickaxeIndex < 0 || !m.pickaxes[m.equippedPickaxeIndex]) {
                return interaction.reply({ content: `You don't have a pickaxe equipped. Equip one with \`/mineinv equip\`.`, ephemeral: true });
            }

            const pickaxe = m.pickaxes[m.equippedPickaxeIndex];
            if (pickaxe.upgrade) {
                return interaction.reply({ content: `Your **${pickaxe.name}** already has the **${pickaxe.upgrade.replace(/_/g, ' ')}** upgrade installed. Each pickaxe can only have one upgrade.`, ephemeral: true });
            }

            const pickaxeData = PICKAXE_BY_TIER[pickaxe.tier];
            const cost = Math.round(pickaxeData.cost * upgradeDef.costMultiplier);

            if (user.balance < cost) {
                return interaction.reply({ content: `This upgrade costs ${currency}${cost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`, ephemeral: true });
            }

            user.balance -= cost;
            pickaxe.upgrade = moduleId;
            user.markModified('mining');
            await user.save();

            const embed = new EmbedBuilder()
                .setColor('#b5651d')
                .setTitle(`${upgradeDef.emoji} Upgrade Installed!`)
                .setDescription(`**${upgradeDef.name}** has been installed on your **${pickaxe.name}**.\n> ${upgradeDef.description}`)
                .addFields({ name: 'Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true })
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        // ── BUY ────────────────────────────────────────────────────────────
        if (sub === 'buy') {
            const itemId  = interaction.options.getString('item');
            const qty     = interaction.options.getInteger('quantity') ?? 1;

            const consumableDef = CONSUMABLES[itemId];
            const blastDef      = BLAST_PACKS.find(b => b.id === itemId);
            const itemDef       = consumableDef || blastDef;

            if (!itemDef) return interaction.reply({ content: 'Unknown item.', ephemeral: true });

            const totalCost = itemDef.cost * qty;
            if (user.balance < totalCost) {
                return interaction.reply({ content: `You need ${currency}${totalCost.toLocaleString()} for ${qty}× but only have ${currency}${user.balance.toLocaleString()}.`, ephemeral: true });
            }

            // Stack limit check for consumables
            if (consumableDef) {
                const current = m.consumables[itemId] ?? 0;
                if (current + qty > consumableDef.maxStack) {
                    return interaction.reply({ content: `You can only carry ${consumableDef.maxStack}× **${consumableDef.name}**. You already have ${current}.`, ephemeral: true });
                }
                user.balance -= totalCost;
                m.consumables[itemId] = (m.consumables[itemId] ?? 0) + qty;
            } else {
                // Blast charges
                user.balance -= totalCost;
                m.charges[blastDef.chargeType] = (m.charges[blastDef.chargeType] ?? 0) + (blastDef.quantity * qty);
            }

            user.markModified('mining');
            await user.save();

            const received = blastDef ? `${blastDef.quantity * qty}× ${blastDef.chargeType.replace(/_/g, ' ')}` : `${qty}× ${consumableDef.name}`;
            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor('#b5651d')
                        .setTitle('✅ Purchase Complete')
                        .setDescription(`Bought **${received}** for **${currency}${totalCost.toLocaleString()}**.`)
                        .addFields({ name: 'Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true })
                        .setTimestamp()
                ]
            });
        }

        // ── USE ────────────────────────────────────────────────────────────
        if (sub === 'use') {
            const itemId = interaction.options.getString('item');
            const result = activateConsumable(user, itemId);

            if (!result.success) {
                return interaction.reply({ content: result.error, ephemeral: true });
            }

            await user.save();

            const def = CONSUMABLES[itemId];
            return interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor('#2ecc71')
                        .setTitle(`${def.emoji} ${def.name} Activated!`)
                        .setDescription(def.description)
                        .setTimestamp()
                ]
            });
        }

        // ── REPAIR ────────────────────────────────────────────────────────
        if (sub === 'repair') {
            const method = interaction.options.getString('method');

            if (m.equippedPickaxeIndex < 0 || !m.pickaxes[m.equippedPickaxeIndex]) {
                return interaction.reply({ content: `You don't have a pickaxe equipped.`, ephemeral: true });
            }

            const pickaxe = m.pickaxes[m.equippedPickaxeIndex];

            if (method === 'shop') {
                const repairResult = applyRepair(pickaxe, null);
                if (repairResult.error) return interaction.reply({ content: repairResult.error, ephemeral: true });

                if (user.balance < repairResult.cost) {
                    return interaction.reply({ content: `Repair costs ${currency}${repairResult.cost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`, ephemeral: true });
                }

                user.balance -= repairResult.cost;
                user.markModified('mining');
                await user.save();

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
                    return interaction.reply({ content: `You don't have any **${kit.name}**. Buy one with \`/mineshop buy\`.`, ephemeral: true });
                }

                if (pickaxe.status === 'condemned') {
                    return interaction.reply({ content: 'This pickaxe is condemned and cannot be repaired.', ephemeral: true });
                }
                if (pickaxe.currentDurability >= pickaxe.maxDurability) {
                    return interaction.reply({ content: 'Pickaxe is already at full durability.', ephemeral: true });
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

        // ── UNLOCK ────────────────────────────────────────────────────────
        if (sub === 'unlock') {
            const depthId  = interaction.options.getString('depth');
            const depthDef = DEPTHS[depthId];

            if (!depthDef) return interaction.reply({ content: 'Unknown depth.', ephemeral: true });
            if (depthDef.defaultUnlocked || m.unlockedDepths.includes(depthId)) {
                return interaction.reply({ content: `You've already unlocked **${depthDef.name}**.`, ephemeral: true });
            }
            if (m.level < depthDef.unlockLevel) {
                return interaction.reply({ content: `You need Miner Level **${depthDef.unlockLevel}** to unlock **${depthDef.name}**. You're Level ${m.level}.`, ephemeral: true });
            }
            if (user.balance < depthDef.unlockCost) {
                return interaction.reply({ content: `Unlocking **${depthDef.name}** costs ${currency}${depthDef.unlockCost.toLocaleString()} but you only have ${currency}${user.balance.toLocaleString()}.`, ephemeral: true });
            }

            user.balance -= depthDef.unlockCost;
            m.unlockedDepths.push(depthId);
            m.activeDepth = depthId;
            user.markModified('mining');
            await user.save();

            const embed = new EmbedBuilder()
                .setColor('#b5651d')
                .setTitle(`${depthDef.emoji} Depth Unlocked!`)
                .setDescription(`**${depthDef.name}** is now accessible.\n> ${depthDef.description}`)
                .addFields({ name: 'Balance', value: `${currency}${user.balance.toLocaleString()}`, inline: true })
                .setFooter({ text: `Now set as your active depth — use /mine to start digging!` })
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }
    }
};
