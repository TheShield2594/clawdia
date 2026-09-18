'use strict';

// /fish profile, /fish prestige, /fish inv and /fish equip: what the player has
// and what they have become.

const User = require('../../../models/User');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { attachGrind } = require('../../../utils/grindProfile');
const { MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
    ensureFishingData,
    applyStaminaRegen,
    getLevelData,
    xpToNextLevel,
    getMaxStamina,
    msUntilNextStamina,
    formatMs,
    rodStatusEmoji,
    durabilityBar
} = require('../../../services/fishService');
const {
    LOCATIONS,
    PRESTIGE_BONUSES,
    FISHER_LEVELS,
    LIMITS,
    ROD_UPGRADES,
    BAIT_PACKS,
    CONSUMABLES,
    MATERIAL_NAMES
} = require('../../../data/fishData');
const { getActiveSynergies } = require('../../../services/synergyService');
const { chunkByLength } = require('../../../utils/embedFields');
const { paginate } = require('../../../utils/paginator');
const { MAX_PRESTIGE, PRESTIGE_BADGES, PRESTIGE_LABELS } = require('./shared');
const { buildXpBar, formatPrestigeBonuses } = require('./embeds');
const COLORS = require('../../../utils/embedColors');
const { ownedBy } = require('../../../utils/collectorOwner');

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILE
// ═══════════════════════════════════════════════════════════════════════════════

async function handleProfile(interaction) {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const isSelf = target.id === interaction.user.id;

    const [userData, guildSettings] = await Promise.all([
        User.findOne({ userId: target.id, guildId: interaction.guild.id }),
        getGuildSettings(interaction.guild.id)
    ]);
    await attachGrind(userData);

    const currency = guildSettings?.economy?.currency ?? '💰';

    if (!userData) {
        return interaction.reply({
            content: isSelf
                ? "You haven't started fishing yet! Buy a rod with `/fish shop rod` and use `/fish cast` to begin."
                : `${target.username} hasn't started fishing yet.`,
            flags: MessageFlags.Ephemeral
        });
    }

    ensureFishingData(userData);
    if (isSelf) applyStaminaRegen(userData);

    const f         = userData.fishing;
    const levelData = getLevelData(f.level);
    const toNext    = xpToNextLevel(f.level, f.xp);
    const maxStam   = getMaxStamina(userData);
    const regenMs   = msUntilNextStamina(userData);
    const location  = LOCATIONS[f.activeLocation];
    const prestige  = f.prestige ?? 0;
    const badge     = PRESTIGE_BADGES[Math.min(prestige, PRESTIGE_BADGES.length - 1)] ?? '';

    const successRate = f.totalCasts > 0
        ? `${Math.round((f.successfulCasts / f.totalCasts) * 100)}%`
        : 'N/A';

    const xpBar   = buildXpBar(f, toNext);
    const stamBar = '⚡'.repeat(f.stamina) + '▪️'.repeat(Math.max(0, maxStam - f.stamina));

    const buffs = [];
    if (f.activeBait)    buffs.push(`Bait (${f.activeBaitCastsLeft} casts)`);
    if (f.activeLuck)    buffs.push('Luck (queued)');
    if (f.activeXpScroll) buffs.push('XP Scroll (queued)');

    const pBonus = PRESTIGE_BONUSES[Math.min(prestige, PRESTIGE_BONUSES.length - 1)];

    const embed = new EmbedBuilder()
        .setColor(prestige >= 4 ? '#f39c12' : prestige >= 2 ? '#95a5a6' : '#3498db')
        .setTitle(`${badge} ${target.username}'s Fishing Profile`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .addFields(
            {
                name: '🏆 Rank',
                value: `**${levelData.title}** (Level ${f.level})${prestige > 0 ? `\nPrestige ${badge} P${prestige}` : ''}`,
                inline: true
            },
            {
                name: '⭐ Fisher XP',
                value: toNext !== null
                    ? `${f.xp.toLocaleString()} / ${FISHER_LEVELS[f.level]?.xpRequired?.toLocaleString() ?? '?'} XP\n${xpBar}\n${toNext.toLocaleString()} to Level ${f.level + 1}`
                    : `${f.xp.toLocaleString()} XP — **MAX LEVEL**`,
                inline: true
            },
            {
                name: '📍 Active Location',
                value: location ? `${location.emoji} ${location.name}` : 'Unknown',
                inline: true
            },
            {
                name: '⚡ Stamina',
                value: `${stamBar}\n${f.stamina}/${maxStam}${f.stamina < maxStam ? `\nNext regen: ${formatMs(regenMs)}` : '\nFull!'}`,
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
                name: '📊 Fishing Stats',
                value: [
                    `Total Casts:       **${f.totalCasts.toLocaleString()}**`,
                    `Success Rate:      **${successRate}**`,
                    `Total Earned:      **${currency}${f.totalEarned.toLocaleString()}**`,
                    `Best Payout:       **${currency}${f.bestPayout.toLocaleString()}**`,
                    `Legendary Catches: **${f.legendaryCatches}**`,
                    `Event Catches:     **${f.eventCatches}**`
                ].join('\n'),
                inline: false
            }
        );

    if (prestige > 0) {
        embed.addFields({
            name: `${badge} Prestige Bonuses`,
            value: [
                pBonus.critBonus    > 0 ? `+${Math.round(pBonus.critBonus    * 100)}% crit chance`  : null,
                pBonus.staminaBonus > 0 ? `+${pBonus.staminaBonus} max stamina`                      : null,
                pBonus.payoutBonus  > 0 ? `+${Math.round(pBonus.payoutBonus  * 100)}% all payouts`   : null,
                pBonus.rarityBonus  > 0 ? `+${Math.round(pBonus.rarityBonus  * 100)}% rarity boost`  : null
            ].filter(Boolean).join('\n') || 'None yet',
            inline: true
        });
    }

    const locationList = f.unlockedLocations.map(id => {
        const loc = LOCATIONS[id];
        return loc ? `${loc.emoji} ${loc.name}` : id;
    }).join('\n');
    embed.addFields({ name: '🗺️ Unlocked Locations', value: locationList || 'Quiet Pond only', inline: true });

    if (f.trophies?.length) {
        embed.addFields({ name: '🏆 Trophies', value: f.trophies.join(', '), inline: true });
    }

    // Cross-system synergies
    const activeSynergies = getActiveSynergies(userData);
    if (activeSynergies.length > 0) {
        embed.addFields({
            name: '🔗 Active Synergies',
            value: activeSynergies.map(s => `${s.emoji} **${s.name}** — ${s.description}`).join('\n'),
            inline: false
        });
    } else if (f.level >= 25) {
        embed.addFields({
            name: '🔗 Synergies',
            value: 'Reach combined level milestones across Hunt, Fish & Mine to unlock cross-system bonuses! Use `/synergies` to see details.',
            inline: false
        });
    }

    if (prestige === 0 && f.level >= 50) {
        embed.setFooter({ text: 'Max level reached! Use /fish prestige to reset and unlock new bonuses.' });
    } else if (isSelf) {
        embed.setFooter({ text: `Daily: ${f.dailyCasts} casts · ${currency}${f.dailyCoins.toLocaleString()} earned (cap: ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()})` });
    }

    embed.setTimestamp();
    return interaction.reply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRESTIGE
// ═══════════════════════════════════════════════════════════════════════════════

async function handlePrestige(interaction) {
    const guildSettings = await getGuildSettings(interaction.guild.id);
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureFishingData(user);
    const f = user.fishing;

    if (f.level < 50) {
        return interaction.reply({
            content: `You need Fisher Level **50** to prestige. You are currently Level **${f.level}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const currentPrestige = f.prestige ?? 0;
    if (currentPrestige >= MAX_PRESTIGE) {
        return interaction.reply({
            content: `You have already reached the maximum prestige (**P${MAX_PRESTIGE} — Diamond Angler**). You are a true legend of the sea! 💎`,
            flags: MessageFlags.Ephemeral
        });
    }

    const nextPrestige   = currentPrestige + 1;
    const currentBonuses = PRESTIGE_BONUSES[currentPrestige];
    const nextBonuses    = PRESTIGE_BONUSES[nextPrestige];

    const confirmEmbed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle('⚠️ Fishing Prestige Confirmation')
        .setDescription(
            `You are about to prestige from **P${currentPrestige}** → **P${nextPrestige}** (${PRESTIGE_LABELS[nextPrestige]}).\n\n` +
            `**Your fisher level and XP will reset to 1.**\n` +
            `Rods, bait, materials, balance, location unlocks, and trophies are all kept.`
        )
        .addFields(
            { name: `Current Bonuses (P${currentPrestige})`, value: formatPrestigeBonuses(currentBonuses), inline: true },
            { name: `New Bonuses (P${nextPrestige})`,        value: formatPrestigeBonuses(nextBonuses),    inline: true }
        )
        .setFooter({ text: 'This action cannot be undone! You have 30 seconds to confirm.' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('fishprestige_confirm')
            .setLabel('Prestige Now!')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId('fishprestige_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
    );

    const reply = await interaction.reply({ embeds: [confirmEmbed], components: [row], fetchReply: true });

    const collector = reply.createMessageComponentCollector({
        filter: ownedBy(
            interaction.user.id,
            i => ['fishprestige_confirm', 'fishprestige_cancel'].includes(i.customId),
            "This isn't your prestige confirmation.",
        ),
        time:   30_000,
        max:    1
    });

    collector.on('collect', async i => {
        if (i.customId === 'fishprestige_cancel') {
            await i.update({ content: 'Prestige cancelled.', embeds: [], components: [] });
            return;
        }

        const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        await attachGrind(freshUser);
        ensureFishingData(freshUser);
        const ff = freshUser.fishing;

        if (ff.level < 50 || (ff.prestige ?? 0) >= MAX_PRESTIGE) {
            await i.update({
                content: 'Prestige conditions are no longer met (level changed, or already prestiged).',
                embeds: [], components: []
            });
            return;
        }

        ff.prestige = (ff.prestige ?? 0) + 1;
        ff.level    = 1;
        ff.xp       = 0;

        if (!Array.isArray(ff.trophies)) ff.trophies = [];
        const trophy = PRESTIGE_LABELS[ff.prestige];
        if (trophy && !ff.trophies.includes(trophy)) {
            ff.trophies.push(trophy);
        }

        freshUser.markModified('fishing');

        try {
            await freshUser.save();
        } catch (err) {
            console.error('[fishprestige] save error:', err);
            await i.update({ content: 'Something went wrong saving your prestige. Please try again.', embeds: [], components: [] });
            return;
        }

        // Check grand prestige after successful fish prestige
        checkGrandPrestige(i.client, freshUser, interaction.guild, interaction.guildId).catch(() => null);

        const resultEmbed = new EmbedBuilder()
            .setColor(COLORS.WARN)
            .setTitle(`✨ Fishing Prestige ${ff.prestige} Achieved!`)
            .setDescription(
                `You are now **${PRESTIGE_LABELS[ff.prestige]}**!\n\n` +
                `Your fisher level has been reset to **1**. Prove yourself again from the water's edge.`
            )
            .addFields(
                { name: 'Prestige Bonuses', value: formatPrestigeBonuses(PRESTIGE_BONUSES[ff.prestige]), inline: false },
                { name: '🏆 Trophy Earned', value: trophy,                                                inline: true  },
                { name: '⚡ Max Stamina',   value: `${getMaxStamina(freshUser)}`,                         inline: true  }
            )
            .setFooter({ text: 'Use /fish profile to see your updated stats' })
            .setTimestamp();

        await i.update({ embeds: [resultEmbed], components: [] });
    });

    collector.on('end', collected => {
        if (collected.size === 0) {
            interaction.editReply({ content: 'Prestige timed out. No changes were made.', embeds: [], components: [] })
                .catch(() => {});
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// INV
// ═══════════════════════════════════════════════════════════════════════════════

// The /fish inventory surface — one read-only /fish inv that shows rods, bait
// and materials at a glance, with a `category` option that opens one of them in
// full, plus /fish equip as its own top-level subcommand. It was a subcommand
// group (/fish inv rods / equip / bait / materials); the group collapsed because
// Discord will not run a subcommand *group* on its own, so /fish inv had to
// become a plain subcommand to be runnable.

// Loads the user's fishing data, or replies and returns null when the economy is
// off. Every /fish inv and /fish equip invocation starts here.
async function loadFishing(interaction) {
    const guildSettings = await getGuildSettings(interaction.guild.id);
    if (guildSettings?.economy?.enabled === false) {
        await interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        return null;
    }

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureFishingData(user);
    applyStaminaRegen(user);
    return user;
}

// Rods sorted equipped-first, then by tier, carrying the original index so the
// number a player reads is the one /fish equip takes.
function orderedRods(f) {
    return f.rods
        .map((rod, index) => ({ rod, index }))
        .sort((a, b) => {
            if (a.index === f.equippedRodIndex) return -1;
            if (b.index === f.equippedRodIndex) return 1;
            return (b.rod.tier ?? 0) - (a.rod.tier ?? 0);
        });
}

async function handleInv(interaction) {
    const user = await loadFishing(interaction);
    if (!user) return;

    const category = interaction.options.getString('category');
    switch (category) {
        case 'rods':      return paginate(interaction, rodPages(interaction, user));
        case 'bait':      return interaction.reply({ embeds: [baitEmbed(interaction, user)] });
        case 'materials': return interaction.reply({ embeds: [materialsEmbed(interaction, user)] });
        default:          return interaction.reply({ embeds: [overviewEmbed(interaction, user)] });
    }
}

function rodPages(interaction, user) {
    const f = user.fishing;

    if (!f.rods.length) {
        return [new EmbedBuilder()
            .setColor(COLORS.INFO)
            .setTitle(`🎣 ${interaction.user.username}'s Rods`)
            .setDescription("You don't own any rods yet. Buy one with `/fish shop rod`.")];
    }

    // Paged for the same reason /hunt inv is: rods accumulate without limit —
    // nothing forces a working spare out of the inventory — and one joined
    // description overflows the 4096-character embed cap somewhere past thirty
    // rods, which fails the whole command rather than truncating it. The number
    // in each heading is what /fish equip takes, so trimming the tail would put
    // those rods permanently out of reach.
    const lines = orderedRods(f).map(({ rod, index }) => {
        const equipped    = index === f.equippedRodIndex ? ' **[EQUIPPED]**' : '';
        const statusEmoji = rodStatusEmoji(rod.status);
        const bar         = durabilityBar(rod.currentDurability, rod.maxDurability, 8);
        const upgradeStr  = rod.upgrade ? ` | ${ROD_UPGRADES[rod.upgrade]?.emoji ?? ''} ${rod.upgrade.replace(/_/g, ' ')}` : '';
        return `**${index + 1}.** ${rod.name}${equipped}\n   ${statusEmoji} ${bar} ${rod.currentDurability}/${rod.maxDurability}${upgradeStr}`;
    });

    return chunkByLength(lines, { separator: '\n\n', maxPerChunk: 8 }).map((chunk, _i, all) => new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle(all.length > 1 ? `🎣 ${interaction.user.username}'s Rods (${f.rods.length})` : `🎣 ${interaction.user.username}'s Rods`)
        .setDescription(chunk.join('\n\n'))
        .setFooter({ text: 'Use /fish equip <number> to equip a rod • /fish shop repair to repair' })
        .setTimestamp());
}

async function handleEquip(interaction) {
    const user = await loadFishing(interaction);
    if (!user) return;

    const f      = user.fishing;
    const number = interaction.options.getInteger('number');
    const index  = number - 1;

    if (index < 0 || index >= f.rods.length) {
        return interaction.reply({ content: `Invalid rod number. You have **${f.rods.length}** rod(s).`, flags: MessageFlags.Ephemeral });
    }

    const rod = f.rods[index];
    if (rod.status === 'broken') {
        return interaction.reply({ content: `Your **${rod.name}** is broken and cannot be equipped. Repair it first with \`/fish shop repair\`.`, flags: MessageFlags.Ephemeral });
    }

    f.equippedRodIndex = index;
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[fish equip] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral });
    }

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor(COLORS.SUCCESS)
                .setTitle('✅ Rod Equipped')
                .setDescription(`You equipped **${rod.name}** (Slot ${number}).`)
                .addFields({ name: 'Durability', value: `${durabilityBar(rod.currentDurability, rod.maxDurability)} ${rod.currentDurability}/${rod.maxDurability}`, inline: true })
                .setTimestamp()
        ]
    });
}

function baitStockLines(f) {
    return Object.entries(f.bait ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([type, qty]) => {
            const pack = BAIT_PACKS.find(b => b.baitType === type);
            return `${pack?.emoji ?? '🪱'} **${type.replace(/_/g, ' ')}**: ${qty}`;
        });
}

function consumableStockLines(f) {
    return Object.entries(f.consumables ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => {
            const def = CONSUMABLES[id];
            return `${def?.emoji ?? '📦'} **${def?.name ?? id}**: ${qty}`;
        });
}

function activeBuffLines(f) {
    const activeLines = [];
    if (f.activeBait) {
        const activeDef = CONSUMABLES[f.activeBait];
        const activeName = activeDef?.name ?? f.activeBait.replace(/_/g, ' ');
        activeLines.push(`${activeDef?.emoji ?? '🐟'} ${activeName} active (${f.activeBaitCastsLeft} casts left)`);
    }
    if (f.activeLuck)     activeLines.push(`🍀 Angler's Luck queued`);
    if (f.activeXpScroll) activeLines.push(`📜 XP Scroll queued`);
    return activeLines;
}

function baitEmbed(interaction, user) {
    const f = user.fishing;
    const baitLines = baitStockLines(f);
    const consumableLines = consumableStockLines(f);
    const activeLines = activeBuffLines(f);

    return new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle(`🎒 ${interaction.user.username}'s Fishing Supplies`)
        .addFields(
            { name: '🪱 Bait Stock', value: baitLines.length ? baitLines.join('\n') : 'None', inline: false },
            { name: '🧪 Consumables', value: consumableLines.length ? consumableLines.join('\n') : 'None', inline: false },
            { name: '⚡ Active Buffs', value: activeLines.length ? activeLines.join('\n') : 'None', inline: false }
        )
        .setFooter({ text: 'Use /fish shop to buy supplies • /use <item> to activate consumables' })
        .setTimestamp();
}

function fishingMaterialLines(user) {
    const f = user.fishing;
    const matLines = Object.entries(f.materials ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => `• **${MATERIAL_NAMES[id] ?? id}**: ${qty}`);

    const huntMats = user.hunt?.materials ?? {};
    const huntMatLines = ['rabbits_foot', 'feather'].map(id => {
        const qty = huntMats[id] ?? 0;
        if (!qty) return null;
        return `• **${id.replace(/_/g, ' ')}** (hunt): ${qty}`;
    }).filter(Boolean);

    return { matLines, huntMatLines };
}

function materialsEmbed(interaction, user) {
    const { matLines, huntMatLines } = fishingMaterialLines(user);

    const embed = new EmbedBuilder()
        .setColor(COLORS.NEUTRAL)
        .setTitle(`🪨 ${interaction.user.username}'s Fishing Materials`)
        .addFields(
            { name: 'Fishing Materials', value: matLines.length ? matLines.join('\n') : 'None yet — catch fish for material drops!', inline: false }
        );

    if (huntMatLines.length) {
        embed.addFields({ name: 'Hunt Materials (cross-system)', value: huntMatLines.join('\n'), inline: false });
    }

    embed.setFooter({ text: 'Materials are used in crafting recipes. Use /fish craft list to see what you can make.' });
    embed.setTimestamp();
    return embed;
}

const OVERVIEW_ROD_PREVIEW = 5;

function overviewEmbed(interaction, user) {
    const f = user.fishing;
    const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle(`🎒 ${interaction.user.username}'s Fishing Inventory`)
        .setTimestamp();

    // Rods — a short preview, equipped first, pointing at the full list.
    if (!f.rods.length) {
        embed.addFields({ name: '🎣 Rods', value: 'None — buy one with `/fish shop rod`', inline: false });
    } else {
        const ordered = orderedRods(f);
        const preview = ordered.slice(0, OVERVIEW_ROD_PREVIEW).map(({ rod, index }) => {
            const equipped = index === f.equippedRodIndex ? ' **[E]**' : '';
            return `**${index + 1}.** ${rod.name}${equipped} — ${rodStatusEmoji(rod.status)} ${rod.currentDurability}/${rod.maxDurability}`;
        });
        const extra = ordered.length - preview.length;
        if (extra > 0) preview.push(`…and ${extra} more — \`/fish inv category:rods\` for the full list`);
        embed.addFields({ name: `🎣 Rods (${f.rods.length})`, value: preview.join('\n'), inline: false });
    }

    const baitLines = baitStockLines(f);
    embed.addFields({ name: '🪱 Bait', value: baitLines.length ? baitLines.join('\n') : 'None', inline: true });

    const consumableLines = consumableStockLines(f);
    embed.addFields({ name: '🧪 Consumables', value: consumableLines.length ? consumableLines.join('\n') : 'None', inline: true });

    const activeLines = activeBuffLines(f);
    if (activeLines.length) embed.addFields({ name: '⚡ Active Buffs', value: activeLines.join('\n'), inline: false });

    const { matLines, huntMatLines } = fishingMaterialLines(user);
    const allMats = [...matLines, ...huntMatLines];
    embed.addFields({ name: '🪨 Materials', value: allMats.length ? allMats.join('\n') : 'None yet — catch fish for drops', inline: false });

    embed.setFooter({ text: 'Open a section with /fish inv category:<name> • Equip a rod with /fish equip <number>' });
    return embed;
}

// ─── Grand Prestige Check ─────────────────────────────────────────────────────
const GRAND_PRESTIGE_DIAMOND = 5;

async function checkGrandPrestige(client, user, guild, guildId) {
    const huntDiamond  = (user.hunt?.prestige ?? 0)    >= GRAND_PRESTIGE_DIAMOND;
    const fishDiamond  = (user.fishing?.prestige ?? 0) >= GRAND_PRESTIGE_DIAMOND;
    const mineDiamond  = (user.mining?.prestige ?? 0)  >= GRAND_PRESTIGE_DIAMOND;
    const allDiamond   = huntDiamond && fishDiamond && mineDiamond;

    if (!allDiamond) return;

    const currentLevel = user.grandPrestige?.level ?? 0;
    if (currentLevel >= 1) return; // already achieved Grand Master or higher

    await User.updateOne(
        { userId: user.userId, guildId },
        { $set: { 'grandPrestige.level': 1, 'grandPrestige.awardedAt': new Date() } }
    ).catch(() => {});

    // Broadcast to economy channel
    const guildSettings = await getGuildSettings(guildId).catch(() => null);
    const announceChannelId = guildSettings?.accountPrestige?.announceChannelId
        ?? guildSettings?.economy?.announcementChannelId
        ?? null;

    if (announceChannelId && client) {
        const broadcastEmbed = new EmbedBuilder()
            .setColor(COLORS.PRIZE)
            .setTitle('⚜️ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ⚜️')
            .setDescription(
                `**GRAND MASTER ACHIEVED!**\n\n` +
                `<@${user.userId}> has reached **Diamond Prestige** in all three skill tracks!\n\n` +
                `🏹 Diamond Hunter · 🎣 Diamond Angler · ⛏️ Diamond Miner\n\n` +
                `*The rarest achievement in this server.*`
            )
            .setTimestamp();
        try {
            const g  = guild ?? await client.guilds.fetch(guildId).catch(() => null);
            const ch = g?.channels?.cache?.get(announceChannelId);
            if (ch?.isTextBased?.()) ch.send({ embeds: [broadcastEmbed] }).catch(() => {});
        } catch { /* non-critical */ }
    }
}

module.exports = {
    GRAND_PRESTIGE_DIAMOND,
    checkGrandPrestige,
    handleEquip,
    handleInv,
    handlePrestige,
    handleProfile,
};
