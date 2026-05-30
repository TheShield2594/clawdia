'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { getItemImageAttachment } = require('../../utils/itemImageHelper');
const {
    DEPTHS, DEPTH_LIST, TIER_COLORS, LIMITS, PICKAXE_BY_TIER,
    MATERIAL_NAMES, CONSUMABLES, BLAST_PACKS,
    PICKAXE_TIERS, PICKAXE_BY_SLUG, PICKAXE_UPGRADES,
    MINER_LEVELS, PRESTIGE_BONUSES, MINE_QUEST_TEMPLATES
} = require('../../data/mineData');
const { checkAndAward, announceAchievements } = require('../../services/achievementService');
const {
    ensureMineData,
    applyStaminaRegen,
    applyDailyReset,
    msUntilNextStamina,
    getMaxStamina,
    executeMine,
    assignDailyMineQuests,
    updateMineQuestProgress,
    formatMs,
    pickaxeStatusEmoji,
    durabilityBar,
    getLevelData,
    xpToNextLevel,
    activateConsumable,
    applyRepair,
    updatePickaxeStatus,
    applyXp
} = require('../../services/mineService');

const DEPTH_CHOICES    = DEPTH_LIST.map(d => ({ name: d.name, value: d.id }));
const PICKAXE_CHOICES  = PICKAXE_TIERS.map(p => ({ name: `${p.emoji} ${p.name} — ${p.cost.toLocaleString()} coins`, value: p.slug }));
const ALL_ITEMS        = [...Object.values(CONSUMABLES), ...BLAST_PACKS];
const ITEM_CHOICES     = ALL_ITEMS.map(i => ({ name: `${i.emoji ?? ''} ${i.name} — ${i.cost} coins`.trim(), value: i.id }));
const ACTIVATABLE      = ['ore_magnet', 'premium_magnet', 'miners_lamp', 'miners_instinct', 'xp_scroll', 'energy_tonic'];
const UPGRADE_CHOICES  = Object.values(PICKAXE_UPGRADES).map(u => ({ name: `${u.emoji} ${u.name} — ${u.description}`, value: u.id }));
const UNLOCK_CHOICES   = DEPTH_LIST.filter(d => !d.defaultUnlocked).map(d => ({ name: `${d.emoji} ${d.name}`, value: d.id }));

const PRESTIGE_BADGES = ['', '🥉', '🥈', '🥇', '🏆', '💎'];

// Depth risk levels for the pre-dig selection prompt
const INTENSITY_LEVELS = [
    { level: 1, name: 'Surface',  emoji: '☀️',  multiplier: 0.7, caveInRisk: 0.00, durLoss: 1 },
    { level: 2, name: 'Shallow',  emoji: '🪨',  multiplier: 1.0, caveInRisk: 0.05, durLoss: 1 },
    { level: 3, name: 'Mid',      emoji: '🔩',  multiplier: 1.4, caveInRisk: 0.12, durLoss: 2 },
    { level: 4, name: 'Deep',     emoji: '💎',  multiplier: 2.0, caveInRisk: 0.20, durLoss: 3 },
    { level: 5, name: 'Abyss',    emoji: '🌑',  multiplier: 3.0, caveInRisk: 0.30, durLoss: 4 },
];

module.exports = {
    cooldown: 30,

    data: new SlashCommandBuilder()
        .setName('mine')
        .setDescription('Mining: dig, profile, inventory, quests, and shop.')
        .addSubcommand(sub =>
            sub.setName('dig')
                .setDescription('Mine ore in your current depth. Uses 1 stamina. Cooldown: 30s.')
                .addStringOption(o =>
                    o.setName('depth')
                        .setDescription('Depth to mine in (defaults to your active depth).')
                        .setRequired(false)
                        .addChoices(...DEPTH_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('profile')
                .setDescription("View your or another player's miner profile")
                .addUserOption(o =>
                    o.setName('user')
                        .setDescription('Player to inspect')
                        .setRequired(false)))
        .addSubcommandGroup(group =>
            group.setName('inv')
                .setDescription('Manage your mining inventory and pickaxes')
                .addSubcommand(sub =>
                    sub.setName('view')
                        .setDescription('View your pickaxes, charges, consumables, and materials'))
                .addSubcommand(sub =>
                    sub.setName('equip')
                        .setDescription('Equip a pickaxe from your inventory')
                        .addIntegerOption(o =>
                            o.setName('slot')
                                .setDescription('Pickaxe slot number (use /mine inv view to see slots)')
                                .setRequired(true)
                                .setMinValue(1))))
        .addSubcommandGroup(group =>
            group.setName('quests')
                .setDescription('View and claim your daily mine quests')
                .addSubcommand(sub =>
                    sub.setName('view')
                        .setDescription('See your active daily mine quests'))
                .addSubcommand(sub =>
                    sub.setName('claim')
                        .setDescription('Claim rewards for a completed quest')
                        .addStringOption(o =>
                            o.setName('quest')
                                .setDescription('Quest to claim')
                                .setRequired(true)
                                .addChoices(...MINE_QUEST_TEMPLATES.map(t => ({ name: t.name, value: t.id }))))))
        .addSubcommandGroup(group =>
            group.setName('shop')
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
                                .addChoices(...UNLOCK_CHOICES)))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup(false);
        const sub   = interaction.options.getSubcommand();

        if (!group) {
            if (sub === 'dig')     return handleDig(interaction);
            if (sub === 'profile') return handleProfile(interaction);
        }
        if (group === 'inv')    return handleInv(interaction, sub);
        if (group === 'quests') return handleQuests(interaction, sub);
        if (group === 'shop')   return handleShop(interaction, sub);
    }
};

// ─── DIG ──────────────────────────────────────────────────────────────────────

async function handleDig(interaction) {
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
    applyStaminaRegen(user);
    applyDailyReset(user);
    assignDailyMineQuests(user);

    if (user.isModified()) {
        await user.save().catch(e => console.error('[mine] pre-check save error:', e));
    }

    const m = user.mining;

    const requestedDepth = interaction.options.getString('depth');
    const depthId = requestedDepth ?? m.activeDepth;
    const depth   = DEPTHS[depthId];

    if (!depth) {
        return interaction.reply({ content: `Unknown depth \`${depthId}\`. Use \`/mine shop list\` to see available depths.`, ephemeral: true });
    }
    if (!m.unlockedDepths.includes(depthId)) {
        return interaction.reply({
            content: `You haven't unlocked **${depth.name}** yet. Use \`/mine shop unlock\` to unlock it.`,
            ephemeral: true
        });
    }
    if (m.level < depth.unlockLevel) {
        return interaction.reply({
            content: `You need to be Miner Level **${depth.unlockLevel}** to mine in **${depth.name}**.`,
            ephemeral: true
        });
    }

    if (m.injuryUntil && Date.now() < m.injuryUntil.getTime()) {
        const remaining = m.injuryUntil.getTime() - Date.now();
        return interaction.reply({
            content: `You're injured and need to rest. Back to work in **${formatMs(remaining)}**.`,
            ephemeral: true
        });
    }

    if (m.lastMine && Date.now() - m.lastMine.getTime() < LIMITS.MINE_COOLDOWN_MS) {
        const remaining = LIMITS.MINE_COOLDOWN_MS - (Date.now() - m.lastMine.getTime());
        return interaction.reply({
            content: `You need a breather. Ready again in **${formatMs(remaining)}**.`,
            ephemeral: true
        });
    }

    if (m.stamina <= 0) {
        const regenMs = msUntilNextStamina(user);
        return interaction.reply({
            content: `You're exhausted! Stamina regens in **${formatMs(regenMs)}**. Buy an Energy Tonic from \`/mine shop\` to recover faster.`,
            ephemeral: true
        });
    }

    if (m.equippedPickaxeIndex < 0 || !m.pickaxes[m.equippedPickaxeIndex]) {
        return interaction.reply({
            content: `You don't have a pickaxe equipped! Buy one with \`/mine shop pickaxe\` and equip it with \`/mine inv equip 1\`.`,
            ephemeral: true
        });
    }

    const pickaxe = m.pickaxes[m.equippedPickaxeIndex];

    if (pickaxe.status === 'broken' || pickaxe.currentDurability <= 0) {
        return interaction.reply({
            content: `Your **${pickaxe.name}** is broken! Repair it with \`/mine shop repair\` or buy a new one with \`/mine shop pickaxe\`.`,
            ephemeral: true
        });
    }

    const pickaxeData = PICKAXE_BY_TIER[pickaxe.tier];
    if (pickaxeData.requiresCharge) {
        const chargeStock = m.charges[pickaxeData.chargeType] ?? 0;
        if (chargeStock <= 0) {
            return interaction.reply({
                content: `You're out of **${pickaxeData.chargeType.replace(/_/g, ' ')}**! Buy more with \`/mine shop buy\`.`,
                ephemeral: true
            });
        }
        m.charges[pickaxeData.chargeType] = chargeStock - 1;
        user.markModified('mining');
    }

    // ── Depth Risk Selection Prompt ────────────────────────────────────────────
    // Show a risk/reward table and 5 intensity buttons before digging.
    const riskTable = INTENSITY_LEVELS.map(l =>
        `${l.emoji} **${l.name}** — ${l.multiplier}× payout  |  ${(l.caveInRisk * 100).toFixed(0)}% cave-in  |  ${l.durLoss} dur loss`
    ).join('\n');

    const riskEmbed = new EmbedBuilder()
        .setColor('#8B4513')
        .setTitle('⛏️ Choose Mining Depth')
        .setDescription(
            `How deep will you dig in **${depth.emoji} ${depth.name}**?\n\n${riskTable}\n\n` +
            `*Cave-in = 0 coins, extra durability loss.*`
        )
        .setFooter({ text: 'You have 20 seconds to decide — defaults to Surface (0.7×, no cave-in risk) on timeout.' });

    const intensityRow = new ActionRowBuilder().addComponents(
        ...INTENSITY_LEVELS.map(l => new ButtonBuilder()
            .setCustomId(`mine_intensity_${l.level}`)
            .setLabel(`${l.emoji} ${l.name}`)
            .setStyle(l.level <= 2 ? ButtonStyle.Secondary : l.level === 3 ? ButtonStyle.Primary : ButtonStyle.Danger)
        )
    );

    await interaction.reply({ embeds: [riskEmbed], components: [intensityRow] });

    const riskMsg    = await interaction.fetchReply();
    const pickedLevel = await new Promise(resolve => {
        const col = riskMsg.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && i.customId.startsWith('mine_intensity_'),
            time: 20_000,
            max: 1,
        });
        col.on('collect', async i => { await i.deferUpdate(); resolve(parseInt(i.customId.replace('mine_intensity_', ''), 10)); });
        col.on('end',     (_, reason) => { if (reason !== 'limit') resolve(1); }); // default: Surface (no cave-in)
    });

    const chosenIntensity = INTENSITY_LEVELS.find(l => l.level === pickedLevel) ?? INTENSITY_LEVELS[1];

    const confirmEmbed = new EmbedBuilder()
        .setColor(chosenIntensity.level >= 4 ? '#FF4444' : chosenIntensity.level >= 3 ? '#FFA500' : '#00AA55')
        .setTitle(`${chosenIntensity.emoji} Digging ${chosenIntensity.name}…`)
        .setDescription(`**${chosenIntensity.multiplier}×** payout  |  **${(chosenIntensity.caveInRisk * 100).toFixed(0)}%** cave-in risk`);

    await interaction.editReply({ embeds: [confirmEmbed], components: [] });

    // Crystal Fox pet: +15% mine yield (only if hunger >= 30)
    const { getTotalBonus } = require('../../services/petService');
    const petMineYieldPct = getTotalBonus(user.pets || [], 'mine_yield');

    const result = executeMine(user, depthId, { intensity: chosenIntensity });

    if (result.success && result.finalPayout > 0 && petMineYieldPct > 0) {
        const bonus = Math.round(result.finalPayout * petMineYieldPct / 100);
        if (bonus > 0) {
            user.balance              += bonus;
            user.mining.totalEarned   += bonus;
            user.mining.dailyCoins    += bonus;
            result.finalPayout        += bonus;
            result.petYieldBonus       = bonus;
        }
    }

    updateMineQuestProgress(user, result, depthId);

    const mineAchievements = await checkAndAward(user, guildSettings).catch(() => []);

    try {
        await user.save();
        if (mineAchievements.length) {
            announceAchievements(interaction.client, guildSettings, user, interaction.member, mineAchievements).catch(() => null);
        }
    } catch (err) {
        if (err.name === 'VersionError') {
            return interaction.editReply({ content: 'A simultaneous request conflicted with your mine. Please try `/mine dig` again.' });
        }
        console.error('[mine] save error:', err);
        return interaction.editReply({ content: 'Something went wrong saving your mine. Please try again.' });
    }

    const embed = buildMineEmbed(result, user, depth, pickaxe, currency, interaction.user);
    if (result.caveIn) {
        const desc = embed.data.description ?? '';
        embed.setDescription(desc + '\n> 💥 *Cave-in! No payout — watch your durability.*');
    } else if (result.intensityLevel && result.intensityLevel.multiplier !== 1.0) {
        const desc = embed.data.description ?? '';
        embed.setDescription(desc + `\n> ${result.intensityLevel.emoji} *${result.intensityLevel.name} depth: ${result.intensityLevel.multiplier}× payout applied*`);
    }
    if (result.petYieldBonus > 0) {
        embed.addFields({ name: '💎 Pet Bonus', value: `+${result.petYieldBonus.toLocaleString()} coins (${petMineYieldPct}% yield)`, inline: true });
    }
    await interaction.editReply({ embeds: [embed] });

    if (result.success && result.tier === 'legendary' && guildSettings?.economy?.announceRareDrops !== false) {
        const announceChannelId = guildSettings?.economy?.announcementChannelId;
        const resolved = announceChannelId ? interaction.guild.channels.cache.get(announceChannelId) : null;
        const announceChannel = resolved?.isTextBased() ? resolved : interaction.channel;
        const announcementEmbed = new EmbedBuilder()
            .setColor('#ff9800')
            .setTitle('✨ Legendary Strike! ✨')
            .setDescription(
                `<@${interaction.user.id}> just unearthed ${result.ore.emoji} **${result.ore.name}** [⭐⭐⭐⭐⭐]\n` +
                `at the **${depth.name}** depth.\n\n` +
                `That vein runs deep — and dangerous.`
            )
            .setTimestamp();
        announceChannel.send({ embeds: [announcementEmbed] }).catch(() => null);
    }
}

// ─── PROFILE ──────────────────────────────────────────────────────────────────

async function handleProfile(interaction) {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const isSelf = target.id === interaction.user.id;

    const [userData, guildSettings] = await Promise.all([
        User.findOne({ userId: target.id, guildId: interaction.guild.id }),
        Guild.findOne({ guildId: interaction.guild.id })
    ]);

    const currency = guildSettings?.economy?.currency ?? '💰';

    if (!userData) {
        return interaction.reply({
            content: isSelf
                ? "You haven't started mining yet! Buy a pickaxe with `/mine shop pickaxe` and use `/mine dig` to begin."
                : `${target.username} hasn't started mining yet.`,
            ephemeral: true
        });
    }

    ensureMineData(userData);
    if (isSelf) applyStaminaRegen(userData);

    const m         = userData.mining;
    const levelData = getLevelData(m.level);
    const toNext    = xpToNextLevel(m.level, m.xp);
    const maxStam   = getMaxStamina(userData);
    const regenMs   = msUntilNextStamina(userData);
    const depth     = DEPTHS[m.activeDepth];
    const prestige  = m.prestige ?? 0;
    const badge     = PRESTIGE_BADGES[Math.min(prestige, PRESTIGE_BADGES.length - 1)] ?? '';

    const successRate = m.totalMines > 0
        ? `${Math.round((m.successfulMines / m.totalMines) * 100)}%`
        : 'N/A';

    const xpProgressBar = buildXpBar(m, toNext);
    const stamBar = '⚡'.repeat(m.stamina) + '▪️'.repeat(Math.max(0, maxStam - m.stamina));

    const buffs = [];
    if (m.activeMagnet)   buffs.push(`Magnet (${m.activeMagnetMinesLeft} mines)`);
    if (m.activeLamp)     buffs.push(`Lamp (${m.activeLampMinesLeft} mines)`);
    if (m.activeInstinct) buffs.push('Instinct (queued)');
    if (m.activeXpScroll) buffs.push('XP Scroll (queued)');

    const pBonus = PRESTIGE_BONUSES[Math.min(prestige, PRESTIGE_BONUSES.length - 1)];

    const embed = new EmbedBuilder()
        .setColor(prestige >= 4 ? '#f39c12' : prestige >= 2 ? '#95a5a6' : '#b5651d')
        .setTitle(`${badge} ${target.username}'s Miner Profile`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .addFields(
            {
                name: '⛏️ Rank',
                value: `**${levelData.title}** (Level ${m.level})${prestige > 0 ? `\nPrestige ${badge} P${prestige}` : ''}`,
                inline: true
            },
            {
                name: '⭐ Miner XP',
                value: toNext !== null
                    ? `${m.xp.toLocaleString()} / ${MINER_LEVELS[m.level]?.xpRequired?.toLocaleString() ?? '?'} XP\n${xpProgressBar}\n${toNext.toLocaleString()} to Level ${m.level + 1}`
                    : `${m.xp.toLocaleString()} XP — **MAX LEVEL**`,
                inline: true
            },
            {
                name: '🗺️ Active Depth',
                value: depth ? `${depth.emoji} ${depth.name}` : 'Unknown',
                inline: true
            },
            {
                name: '⚡ Stamina',
                value: `${stamBar}\n${m.stamina}/${maxStam}${m.stamina < maxStam ? `\nNext regen: ${formatMs(regenMs)}` : '\nFull!'}`,
                inline: true
            },
            {
                name: '💰 Balance',
                value: `${currency}${userData.balance.toLocaleString()}`,
                inline: true
            },
            {
                name: '🔋 Active Buffs',
                value: buffs.length ? buffs.join('\n') : 'None',
                inline: true
            },
            {
                name: '📊 Mining Stats',
                value: [
                    `Total Mines:     **${m.totalMines.toLocaleString()}**`,
                    `Success Rate:    **${successRate}**`,
                    `Total Earned:    **${currency}${m.totalEarned.toLocaleString()}**`,
                    `Best Payout:     **${currency}${m.bestPayout.toLocaleString()}**`,
                    `Legendary Finds: **${m.legendaryFinds}**`,
                    `Event Finds:     **${m.eventFinds}**`
                ].join('\n'),
                inline: false
            }
        );

    if (prestige > 0) {
        embed.addFields({
            name: `${badge} Prestige Bonuses`,
            value: [
                pBonus.critBonus    > 0 ? `+${Math.round(pBonus.critBonus    * 100)}% crit chance`  : null,
                pBonus.staminaBonus > 0 ? `+${pBonus.staminaBonus} max stamina`                     : null,
                pBonus.payoutBonus  > 0 ? `+${Math.round(pBonus.payoutBonus  * 100)}% all payouts`   : null,
                pBonus.rarityBonus  > 0 ? `+${Math.round(pBonus.rarityBonus  * 100)}% rarity boost`  : null
            ].filter(Boolean).join('\n') || 'None yet',
            inline: true
        });
    }

    const depthList = m.unlockedDepths.map(id => {
        const d = DEPTHS[id];
        return d ? `${d.emoji} ${d.name}` : id;
    }).join('\n');
    embed.addFields({ name: '🗺️ Unlocked Depths', value: depthList || 'Surface Quarry only', inline: true });

    if (prestige === 0 && m.level >= 50) {
        embed.setFooter({ text: 'Max level reached!' });
    } else if (isSelf) {
        embed.setFooter({ text: `Daily: ${m.dailyMines} mines · ${currency}${m.dailyCoins.toLocaleString()} earned (cap: ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()})` });
    }

    embed.setTimestamp();
    return interaction.reply({ embeds: [embed] });
}

// ─── INV ──────────────────────────────────────────────────────────────────────

async function handleInv(interaction, sub) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
    }

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    ensureMineData(user);
    const m = user.mining;

    if (sub === 'view') {
        const embed = new EmbedBuilder()
            .setColor('#b5651d')
            .setTitle(`⛏️ ${interaction.user.username}'s Mining Inventory`)
            .setTimestamp();

        if (!m.pickaxes.length) {
            embed.addFields({ name: '🪓 Pickaxes', value: 'None — buy one with `/mine shop pickaxe`', inline: false });
        } else {
            const lines = m.pickaxes.map((p, i) => {
                const isEquipped = i === m.equippedPickaxeIndex;
                const bar = durabilityBar(p.currentDurability, p.maxDurability);
                const upgradeStr = p.upgrade ? ` [${p.upgrade.replace(/_/g, ' ')}]` : '';
                return `**Slot ${i + 1}**${isEquipped ? ' *(equipped)*' : ''} — ${p.name}${upgradeStr} ${pickaxeStatusEmoji(p.status)}\n> ${bar} ${p.currentDurability}/${p.maxDurability}`;
            });
            embed.addFields({ name: '🪓 Pickaxes', value: lines.join('\n'), inline: false });
        }

        const chargeLines = BLAST_PACKS.map(b => {
            const stock = m.charges[b.chargeType] ?? 0;
            return `${b.emoji} ${b.chargeType.replace(/_/g, ' ')}: **${stock}**`;
        }).filter((_, i) => (m.charges[BLAST_PACKS[i].chargeType] ?? 0) > 0);

        embed.addFields({
            name: '💥 Blast Charges',
            value: chargeLines.length ? chargeLines.join('\n') : 'None',
            inline: true
        });

        const consumableLines = Object.entries(m.consumables ?? {})
            .filter(([, qty]) => qty > 0)
            .map(([id, qty]) => {
                const def = CONSUMABLES[id];
                return def ? `${def.emoji} ${def.name}: **${qty}**` : `${id}: **${qty}**`;
            });

        embed.addFields({
            name: '🎒 Consumables',
            value: consumableLines.length ? consumableLines.join('\n') : 'None',
            inline: true
        });

        const buffs = [];
        if (m.activeMagnet)   buffs.push(`🧲 ${m.activeMagnet.replace(/_/g, ' ')} (${m.activeMagnetMinesLeft} mines left)`);
        if (m.activeLamp)     buffs.push(`🪔 Miner's Lamp (${m.activeLampMinesLeft} mines left)`);
        if (m.activeInstinct) buffs.push(`🎯 Miner's Instinct (queued)`);
        if (m.activeXpScroll) buffs.push(`📜 XP Scroll (queued)`);
        embed.addFields({ name: '🔋 Active Buffs', value: buffs.length ? buffs.join('\n') : 'None', inline: false });

        const matLines = Object.entries(m.materials ?? {})
            .filter(([, qty]) => qty > 0)
            .map(([id, qty]) => `${MATERIAL_NAMES[id] ?? id}: **${qty}**`);

        embed.addFields({
            name: '🪨 Materials',
            value: matLines.length ? matLines.join('\n') : 'None — find them by mining rare ores',
            inline: false
        });

        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'equip') {
        const slot = interaction.options.getInteger('slot') - 1;

        if (!m.pickaxes[slot]) {
            return interaction.reply({ content: `No pickaxe in slot ${slot + 1}.`, ephemeral: true });
        }

        const pickaxe = m.pickaxes[slot];
        if (pickaxe.status === 'broken') {
            return interaction.reply({ content: `**${pickaxe.name}** is broken and can't be equipped. Repair it first with \`/mine shop repair\`.`, ephemeral: true });
        }

        m.equippedPickaxeIndex = slot;
        user.markModified('mining');
        await user.save();

        return interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setColor('#b5651d')
                    .setTitle('⛏️ Pickaxe Equipped')
                    .setDescription(`You equipped **${pickaxe.name}**.`)
                    .addFields(
                        { name: 'Durability', value: `${pickaxe.currentDurability}/${pickaxe.maxDurability}`, inline: true },
                        { name: 'Status',     value: `${pickaxeStatusEmoji(pickaxe.status)} ${pickaxe.status}`, inline: true },
                        { name: 'Upgrade',    value: pickaxe.upgrade ? pickaxe.upgrade.replace(/_/g, ' ') : 'None', inline: true }
                    )
                    .setTimestamp()
            ]
        });
    }
}

// ─── QUESTS ───────────────────────────────────────────────────────────────────

async function handleQuests(interaction, sub) {
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
    assignDailyMineQuests(user);

    const now = Date.now();

    if (sub === 'view') {
        const mineQuests = user.quests.filter(q =>
            q.questId.startsWith('mq_') && q.expiresAt?.getTime() > now
        );

        if (!mineQuests.length) {
            const embed = new EmbedBuilder()
                .setColor('#b5651d')
                .setTitle('📋 Daily Mine Quests')
                .setDescription('No active quests right now.\nUse `/mine dig` to start mining — quests will be assigned automatically!')
                .setFooter({ text: 'Quests are assigned in batches of 3 and last 24 hours' });
            return interaction.reply({ embeds: [embed] });
        }

        if (user.isModified()) {
            await user.save().catch(e => console.error('[minequests] save error:', e));
        }

        const lines = mineQuests.map(q => {
            const template = MINE_QUEST_TEMPLATES.find(t => t.id === q.questId);
            if (!template) return null;

            const isClaimed  = q.progress === -1;
            const isComplete = !!q.completedAt && !isClaimed;
            const progress   = isClaimed ? template.target : Math.min(q.progress, template.target);
            const bar        = buildProgressBar(progress, template.target);
            const timeLeft   = formatExpiry(q.expiresAt.getTime() - now);
            const rewardStr  = `${currency}${template.reward.coins.toLocaleString()} · ${template.reward.xp} Miner XP`;

            let statusLine;
            if (isClaimed)       statusLine = '✅ **Claimed**';
            else if (isComplete) statusLine = '🎁 **Ready to claim!** — Use `/mine quests claim`';
            else                 statusLine = `${bar} ${progress}/${template.target}`;

            return [
                `${template.emoji} **${template.name}**`,
                `> ${template.description}`,
                `> ${statusLine}`,
                `> Reward: ${rewardStr} · Expires: ${timeLeft}`
            ].join('\n');
        }).filter(Boolean);

        const readyCount = mineQuests.filter(q => q.completedAt && q.progress !== -1).length;

        const embed = new EmbedBuilder()
            .setColor('#b5651d')
            .setTitle('📋 Daily Mine Quests')
            .setDescription(lines.join('\n\n'))
            .setTimestamp();

        embed.setFooter({ text: readyCount > 0
            ? `${readyCount} quest(s) ready to claim! Use /mine quests claim`
            : 'Complete quests by mining • Claim rewards with /mine quests claim' });

        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'claim') {
        if (user.isModified()) {
            await user.save().catch(e => console.error('[minequests] pre-claim save error:', e));
        }

        const questId  = interaction.options.getString('quest');
        const template = MINE_QUEST_TEMPLATES.find(t => t.id === questId);

        if (!template) {
            return interaction.reply({ content: 'Unknown quest.', ephemeral: true });
        }

        const questEntry = user.quests.find(q =>
            q.questId === questId &&
            q.expiresAt?.getTime() > now
        );

        if (!questEntry) {
            return interaction.reply({
                content: `You don't have an active **${template.name}** quest. Go mining to get quests assigned!`,
                ephemeral: true
            });
        }

        if (questEntry.progress === -1) {
            return interaction.reply({
                content: `You already claimed **${template.name}**. Complete your other quests or wait for new ones!`,
                ephemeral: true
            });
        }

        if (!questEntry.completedAt) {
            const progress = Math.min(questEntry.progress, template.target);
            return interaction.reply({
                content: `**${template.name}** is not complete yet (${progress}/${template.target}). Keep mining!`,
                ephemeral: true
            });
        }

        user.balance += template.reward.coins;
        const lvResult = applyXp(user, template.reward.xp);

        questEntry.progress = -1;
        user.markModified('quests');
        await user.save();

        const embed = new EmbedBuilder()
            .setColor('#2ecc71')
            .setTitle(`${template.emoji} Quest Complete — ${template.name}!`)
            .setDescription(template.description)
            .addFields(
                { name: `${currency} Coins`,  value: `+${template.reward.coins.toLocaleString()}`,  inline: true },
                { name: '⭐ Miner XP',         value: `+${template.reward.xp}`,                     inline: true },
                { name: '💳 New Balance',       value: `${currency}${user.balance.toLocaleString()}`, inline: true }
            );

        if (lvResult.leveledUp) {
            const ld = getLevelData(lvResult.newLevel);
            embed.addFields({
                name:  '⬆️ Level Up!',
                value: `Miner Level **${lvResult.oldLevel}** → **${lvResult.newLevel}** (${ld.title})`,
                inline: false
            });
        }

        const remaining = user.quests.filter(q =>
            q.questId.startsWith('mq_') &&
            q.expiresAt?.getTime() > now &&
            q.progress !== -1
        ).length;

        embed.setFooter({ text: remaining > 0
            ? `${remaining} quest(s) remaining — use /mine quests view`
            : 'All quests claimed! Mine again to receive a fresh set.' });
        embed.setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }
}

// ─── SHOP ─────────────────────────────────────────────────────────────────────

async function handleShop(interaction, sub) {
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

    if (sub === 'list') {
        const COLOR = '#b5651d';
        const embeds = [];
        const files  = [];

        embeds.push(new EmbedBuilder()
            .setColor(COLOR)
            .setTitle('⛏️ Mining Shop — Pickaxes')
            .setDescription('Browse the available pickaxes. Upgrades, blast charges, consumables and depths are listed below.')
        );

        for (const p of PICKAXE_TIERS) {
            const card = new EmbedBuilder()
                .setColor(COLOR)
                .setTitle(`${p.emoji} T${p.tier} ${p.name}`)
                .addFields(
                    { name: 'Cost',         value: `${currency}${p.cost.toLocaleString()}`,                       inline: true },
                    { name: 'Durability',   value: `${p.baseDurability}`,                                          inline: true },
                    { name: 'Success',      value: `${Math.round(p.successRate * 100)}%`,                          inline: true },
                    { name: 'Rarity Boost', value: `+${Math.round(p.rarityBoost * 100)}%`,                         inline: true },
                    { name: 'Charge',       value: p.requiresCharge ? p.chargeType.replace(/_/g, ' ') : 'None',    inline: true },
                    { name: 'Buy',          value: `\`/mine shop pickaxe type:${p.slug}\``,                         inline: true }
                );
            const img = await getItemImageAttachment(`mine:${p.slug}`).catch(() => null);
            if (img) {
                card.setThumbnail(img.url);
                files.push(img.attachment);
            }
            embeds.push(card);
        }

        embeds.push(new EmbedBuilder()
            .setColor(COLOR)
            .setTitle('🛠️ Shop Extras')
            .addFields(
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
            .setFooter({ text: 'Use /mine shop pickaxe|buy|upgrade|repair|unlock to purchase' })
            .setTimestamp()
        );

        return interaction.reply({ embeds, files });
    }

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
            .setDescription(`You bought a **${pickaxeData.name}**!${autoEquip ? ' It has been equipped.' : ' Use `/mine inv equip` to equip it.'}`)
            .addFields(
                { name: 'Success Rate',  value: `${Math.round(pickaxeData.successRate * 100)}%`, inline: true },
                { name: 'Rarity Boost',  value: `+${Math.round(pickaxeData.rarityBoost * 100)}%`, inline: true },
                { name: 'Durability',    value: `${pickaxeData.baseDurability}`, inline: true },
                { name: 'Balance',       value: `${currency}${user.balance.toLocaleString()}`, inline: true }
            )
            .setTimestamp();
        const pickaxeImg = await getItemImageAttachment(`mine:${pickaxeData.slug || pickaxeData.id}`).catch(() => null);
        if (pickaxeImg) embed.setThumbnail(pickaxeImg.url);
        const minePayload = { embeds: [embed] };
        if (pickaxeImg) minePayload.files = [pickaxeImg.attachment];
        return interaction.reply(minePayload);
    }

    if (sub === 'upgrade') {
        const moduleId = interaction.options.getString('module');
        const upgradeDef = PICKAXE_UPGRADES[moduleId];
        if (!upgradeDef) return interaction.reply({ content: 'Unknown upgrade module.', ephemeral: true });

        if (m.equippedPickaxeIndex < 0 || !m.pickaxes[m.equippedPickaxeIndex]) {
            return interaction.reply({ content: `You don't have a pickaxe equipped. Equip one with \`/mine inv equip\`.`, ephemeral: true });
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

        if (consumableDef) {
            const current = m.consumables[itemId] ?? 0;
            if (current + qty > consumableDef.maxStack) {
                return interaction.reply({ content: `You can only carry ${consumableDef.maxStack}× **${consumableDef.name}**. You already have ${current}.`, ephemeral: true });
            }
            user.balance -= totalCost;
            m.consumables[itemId] = (m.consumables[itemId] ?? 0) + qty;
        } else {
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
                return interaction.reply({ content: `You don't have any **${kit.name}**. Buy one with \`/mine shop buy\`.`, ephemeral: true });
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
            .setFooter({ text: `Now set as your active depth — use /mine dig to start digging!` })
            .setTimestamp();
        return interaction.reply({ embeds: [embed] });
    }
}

// ─── EMBED BUILDERS / HELPERS ─────────────────────────────────────────────────

function buildMineEmbed(result, user, depth, pickaxe, currency, discordUser) {
    const m = user.mining;

    if (result.success) {
        const { ore, tier, finalPayout, isCrit, critMultiplier, specialDrop, xpEarned, levelUp, cappedByHard } = result;
        const color = isCrit ? '#FFD700' : TIER_COLORS[tier];

        const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
        const payoutDisplay = cappedByHard ? `~~${currency}${finalPayout}~~ (daily cap reached)` : `**${currency}${finalPayout.toLocaleString()}**`;

        const isLegendary = tier === 'legendary';
        const embedTitle = isLegendary
            ? `⛏️✨ LEGENDARY STRIKE ✨⛏️`
            : `${ore.emoji} ${isCrit ? '✨ CRITICAL! ' : ''}${ore.name} ${isCrit ? '✨' : ''}`;
        const embedDesc = isLegendary
            ? `You struck something impossible in the deep.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  ${ore.emoji}  **${ore.name}**  [⭐⭐⭐⭐⭐]\n  *${ore.flavor}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nAdded to your inventory.`
            : `*${ore.flavor}*`;

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(embedTitle)
            .setDescription(embedDesc)
            .addFields(
                { name: 'Depth',    value: `${depth.emoji} ${depth.name}`,         inline: true },
                { name: 'Tier',     value: tierLabel,                               inline: true },
                { name: 'Reward',   value: payoutDisplay,                           inline: true },
                { name: 'XP',       value: `+${xpEarned} XP${isCrit ? ' (crit bonus)' : ''}`, inline: true },
                { name: 'Pickaxe',  value: `${pickaxe.name} ${pickaxeStatusEmoji(pickaxe.status)}\n${durabilityBar(pickaxe.currentDurability, pickaxe.maxDurability)} ${pickaxe.currentDurability}/${pickaxe.maxDurability}`, inline: true },
                { name: 'Stamina',  value: buildStaminaLine(user),                  inline: true }
            );

        if (isCrit) {
            embed.addFields({ name: 'Crit Multiplier', value: `×${critMultiplier}`, inline: true });
        }

        if (specialDrop) {
            embed.addFields({ name: '🪨 Material Drop!', value: `You found **${specialDrop.name}**!`, inline: false });
        }

        if (levelUp) {
            const ld = getLevelData(levelUp.newLevel);
            embed.addFields({ name: '⬆️ Level Up!', value: `Miner Level **${levelUp.oldLevel}** → **${levelUp.newLevel}** (${ld.title})`, inline: false });
        }

        if (result.expiredMagnet) embed.addFields({ name: '🧲 Magnet Expired', value: `Your ${result.expiredMagnet.replace(/_/g, ' ')} has worn off.`, inline: false });
        if (result.expiredLamp)   embed.addFields({ name: '🪔 Lamp Expired',    value: `Your miner's lamp has flickered out.`, inline: false });

        if (pickaxe.status === 'broken') {
            embed.addFields({ name: '⚠️ Pickaxe Broke!', value: `Your **${pickaxe.name}** has broken! Use \`/mine shop repair\` before mining again.`, inline: false });
        } else if (pickaxe.currentDurability <= Math.floor(pickaxe.maxDurability * 0.20)) {
            embed.addFields({ name: '⚠️ Low Durability', value: `Your **${pickaxe.name}** is nearly worn out (${pickaxe.currentDurability}/${pickaxe.maxDurability}). Repair soon!`, inline: false });
        }

        embed.addFields(
            { name: 'Balance',   value: `${currency}${user.balance.toLocaleString()}`,   inline: true },
            { name: 'Miner XP',  value: buildXpLine(user),                               inline: true }
        );
        embed.setFooter({ text: `Cooldown: 30s • ${buildActiveConsumablesLine(user)}` });
        embed.setTimestamp();
        return embed;
    }

    const { failure, xpEarned, levelUp } = result;
    const embed = new EmbedBuilder()
        .setColor('#e74c3c')
        .setTitle(buildFailureTitle(failure.severity.id))
        .setDescription(`*${failure.message}*`)
        .addFields(
            { name: 'Depth',   value: `${depth.emoji} ${depth.name}`,  inline: true },
            { name: 'Reward',  value: 'Nothing',                        inline: true },
            { name: 'XP',      value: xpEarned > 0 ? `+${xpEarned} XP` : 'None', inline: true },
            { name: 'Pickaxe', value: `${pickaxe.name} ${pickaxeStatusEmoji(pickaxe.status)}\n${durabilityBar(pickaxe.currentDurability, pickaxe.maxDurability)} ${pickaxe.currentDurability}/${pickaxe.maxDurability}`, inline: true },
            { name: 'Stamina', value: buildStaminaLine(user), inline: true }
        );

    if (failure.severity.injuryMs > 0) {
        embed.addFields({ name: '🤕 Cave-in', value: `Extra cooldown: **${formatMs(failure.severity.injuryMs)}**`, inline: true });
    }

    if (result.collapseEvent) {
        embed.setColor('#8B0000');
        embed.addFields({ name: '💀 Catastrophic Collapse!', value: `The tunnel caved in around you — your **${result.collapseEvent.weaponName}** was completely destroyed! Use \`/mine shop repair\` to fix it.`, inline: false });
    }

    if (levelUp) {
        const ld = getLevelData(levelUp.newLevel);
        embed.addFields({ name: '⬆️ Level Up!', value: `Miner Level **${levelUp.oldLevel}** → **${levelUp.newLevel}** (${ld.title})`, inline: false });
    }

    if (pickaxe.status === 'broken' && !result.collapseEvent) {
        embed.addFields({ name: '❌ Pickaxe Broke!', value: `Your **${pickaxe.name}** has broken! Use \`/mine shop repair\` before mining again.`, inline: false });
    }

    embed.setFooter({ text: 'Tip: Use consumables from /mine shop to boost your success chance' });
    embed.setTimestamp();
    return embed;
}

function buildFailureTitle(severityId) {
    return {
        clean_miss: '💨 Empty Vein!',
        rockfall:   '🪨 Rockfall!',
        stuck:      '🔧 Pickaxe Stuck!',
        cave_in:    '🕳️ Cave-in!'
    }[severityId] ?? '❌ Failed Mine';
}

function buildStaminaLine(user) {
    const m   = user.mining;
    const max = getMaxStamina(user);
    return `${m.stamina}/${max} ⚡`;
}

function buildXpLine(user) {
    const m      = user.mining;
    const toNext = xpToNextLevel(m.level, m.xp);
    if (toNext === null) return `${m.xp.toLocaleString()} XP (MAX)`;
    return `${m.xp.toLocaleString()} XP (${toNext} to Lv.${m.level + 1})`;
}

function buildActiveConsumablesLine(user) {
    const m = user.mining;
    const parts = [];
    if (m.activeMagnet)   parts.push(`Magnet (${m.activeMagnetMinesLeft} mines left)`);
    if (m.activeLamp)     parts.push(`Lamp (${m.activeLampMinesLeft} mines left)`);
    if (m.activeInstinct) parts.push(`Instinct (queued)`);
    if (m.activeXpScroll) parts.push(`XP Scroll (queued)`);
    return parts.length ? parts.join(' • ') : 'No active buffs';
}

function buildXpBar(m, toNext) {
    if (toNext === null) return '████████████████████ MAX';
    const currentLevelXp = MINER_LEVELS[m.level - 1]?.xpRequired ?? 0;
    const nextLevelXp    = MINER_LEVELS[m.level]?.xpRequired ?? 1;
    const denominator    = nextLevelXp - currentLevelXp;
    const progress       = denominator > 0 ? (m.xp - currentLevelXp) / denominator : 0;
    const filled         = Math.min(20, Math.max(0, Math.round(progress * 20)));
    const pct            = Math.min(100, Math.max(0, Math.round(progress * 100)));
    return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${pct}%`;
}

function buildProgressBar(current, target, length = 10) {
    const filled = Math.min(length, Math.round((current / target) * length));
    return `[${'█'.repeat(filled)}${'░'.repeat(length - filled)}]`;
}

function formatExpiry(ms) {
    if (ms <= 0) return 'expired';
    const hrs  = Math.floor(ms / 3_600_000);
    const mins = Math.floor((ms % 3_600_000) / 60_000);
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m`;
}
