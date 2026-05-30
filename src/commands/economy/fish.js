'use strict';

const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { getItemImageAttachment } = require('../../utils/itemImageHelper');
const { runShopBrowse }          = require('../../utils/shopBrowse');
const {
    LOCATIONS, LOCATION_LIST, TIER_COLORS, LIMITS, ROD_BY_TIER,
    ROD_UPGRADES, MATERIAL_NAMES, BAIT_PACKS, CONSUMABLES,
    ROD_TIERS, ROD_BY_SLUG,
    FISHER_LEVELS, PRESTIGE_BONUSES,
    FISH_QUEST_TEMPLATES, FISH_CRAFT_RECIPES
} = require('../../data/fishData');
const { MATERIAL_NAMES: HUNT_MATERIAL_NAMES } = require('../../data/huntData');
const { checkAndAward, announceAchievements } = require('../../services/achievementService');
const {
    ensureFishingData,
    applyStaminaRegen,
    applyDailyReset,
    msUntilNextStamina,
    getMaxStamina,
    calculateSuccessChance,
    executeCast,
    resolveBossEncounter,
    assignDailyFishQuests,
    updateFishQuestProgress,
    formatMs,
    rodStatusEmoji,
    durabilityBar,
    getLevelData,
    xpToNextLevel,
    activateConsumable,
    applyRepair,
    updateRodStatus,
    applyXp
} = require('../../services/fishService');
const { getCurrentWeather } = require('../../services/weatherService');
const { FISH_TRAITS, TIME_OF_DAY_BONUSES, getTimeOfDay } = require('../../data/fishData');
const { ensureHuntData } = require('../../services/huntService');

const LOCATION_CHOICES = LOCATION_LIST.map(l => ({ name: l.name, value: l.id }));

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

const RECIPE_CHOICES = Object.values(FISH_CRAFT_RECIPES).map(r => ({ name: r.name, value: r.id }));

const PRESTIGE_BADGES = ['', '🥉', '🥈', '🥇', '🏆', '💎'];

const MAX_PRESTIGE = PRESTIGE_BONUSES.length - 1;

const PRESTIGE_LABELS = [
    null,
    '🥉 Bronze Angler',
    '🥈 Silver Angler',
    '🥇 Gold Angler',
    '🏆 Champion Angler',
    '💎 Diamond Angler'
];

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('fish')
        .setDescription('Fishing: cast lines, manage gear, shop, craft, quests, locations, and prestige.')
        .addSubcommand(sub =>
            sub.setName('cast')
                .setDescription('Cast your line and catch fish. 1 stamina per cast. Cooldown: 45s.')
                .addStringOption(o =>
                    o.setName('location')
                        .setDescription('Location to fish at (defaults to your active location).')
                        .setRequired(false)
                        .addChoices(...LOCATION_CHOICES)))
        .addSubcommand(sub =>
            sub.setName('profile')
                .setDescription("View your or another player's fishing profile")
                .addUserOption(o =>
                    o.setName('user')
                        .setDescription('Player to inspect')
                        .setRequired(false)))
        .addSubcommand(sub =>
            sub.setName('prestige')
                .setDescription('Reset your fisher level for permanent prestige bonuses (requires Level 50)'))
        .addSubcommandGroup(group =>
            group.setName('inv')
                .setDescription('View and manage your fishing inventory')
                .addSubcommand(sub =>
                    sub.setName('rods')
                        .setDescription('View your fishing rods'))
                .addSubcommand(sub =>
                    sub.setName('equip')
                        .setDescription('Equip a rod by its inventory number')
                        .addIntegerOption(o =>
                            o.setName('number')
                                .setDescription('Rod number from /fish inv rods')
                                .setMinValue(1)
                                .setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('bait')
                        .setDescription('View your bait and consumable stock'))
                .addSubcommand(sub =>
                    sub.setName('materials')
                        .setDescription('View your crafting materials')))
        .addSubcommandGroup(group =>
            group.setName('quests')
                .setDescription('View and claim your daily fishing quests')
                .addSubcommand(sub =>
                    sub.setName('view')
                        .setDescription('View your active daily fishing quests'))
                .addSubcommand(sub =>
                    sub.setName('claim')
                        .setDescription('Claim rewards for a completed quest')
                        .addIntegerOption(o =>
                            o.setName('number')
                                .setDescription('Quest number to claim')
                                .setMinValue(1)
                                .setRequired(true))))
        .addSubcommandGroup(group =>
            group.setName('shop')
                .setDescription('Browse and purchase fishing gear, bait, and supplies')
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
                                .addChoices(...UNLOCK_CHOICES))))
        .addSubcommandGroup(group =>
            group.setName('craft')
                .setDescription('Craft items from fishing (and hunting) materials')
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('Browse all available fishing crafting recipes'))
                .addSubcommand(sub =>
                    sub.setName('make')
                        .setDescription('Craft an item from your materials')
                        .addStringOption(o =>
                            o.setName('recipe')
                                .setDescription('Recipe to craft')
                                .setRequired(true)
                                .addChoices(...RECIPE_CHOICES))))
        .addSubcommandGroup(group =>
            group.setName('location')
                .setDescription('View and switch your active fishing location')
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('View all fishing locations and their requirements'))
                .addSubcommand(sub =>
                    sub.setName('set')
                        .setDescription('Switch to an unlocked location')
                        .addStringOption(o =>
                            o.setName('location')
                                .setDescription('Location to fish at')
                                .setRequired(true)
                                .addChoices(...LOCATION_LIST.map(l => ({ name: `${l.emoji} ${l.name}`, value: l.id })))))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup(false);
        const sub   = interaction.options.getSubcommand();

        if (!group) {
            if (sub === 'cast')     return handleCast(interaction);
            if (sub === 'profile')  return handleProfile(interaction);
            if (sub === 'prestige') return handlePrestige(interaction);
            return;
        }

        if (group === 'inv')      return handleInv(interaction, sub);
        if (group === 'quests')   return handleQuests(interaction, sub);
        if (group === 'shop')     return handleShop(interaction, sub);
        if (group === 'craft')    return handleCraft(interaction, sub);
        if (group === 'location') return handleLocation(interaction, sub);
    }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CAST
// ═══════════════════════════════════════════════════════════════════════════════

async function handleCast(interaction) {
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

    ensureFishingData(user);
    applyStaminaRegen(user);
    applyDailyReset(user);
    assignDailyFishQuests(user);

    if (user.isModified()) {
        await user.save().catch(e => console.error('[fish] pre-check save error:', e));
    }

    const f = user.fishing;

    // ── Location resolution ────────────────────────────────────────────
    const requestedLoc = interaction.options.getString('location');
    const locationId   = requestedLoc ?? f.activeLocation;
    const location     = LOCATIONS[locationId];

    if (!location) {
        return interaction.reply({ content: `Unknown location. Use \`/fish location list\` to see available spots.`, ephemeral: true });
    }
    if (!f.unlockedLocations.includes(locationId)) {
        return interaction.reply({
            content: `You haven't unlocked **${location.name}** yet. Use \`/fish shop unlock\` to unlock it.`,
            ephemeral: true
        });
    }
    if (f.level < location.unlockLevel) {
        return interaction.reply({
            content: `You need to be Fisher Level **${location.unlockLevel}** to fish at **${location.name}**.`,
            ephemeral: true
        });
    }

    // ── Injury cooldown ────────────────────────────────────────────────
    if (f.injuryUntil && Date.now() < f.injuryUntil.getTime()) {
        const remaining = f.injuryUntil.getTime() - Date.now();
        return interaction.reply({
            content: `You're still drying off from your mishap! Back in action in **${formatMs(remaining)}**.`,
            ephemeral: true
        });
    }

    // ── Cast cooldown ──────────────────────────────────────────────────
    if (f.lastCast && Date.now() - f.lastCast.getTime() < LIMITS.CAST_COOLDOWN_MS) {
        const remaining = LIMITS.CAST_COOLDOWN_MS - (Date.now() - f.lastCast.getTime());
        return interaction.reply({
            content: `Your line is still settling. Ready again in **${formatMs(remaining)}**.`,
            ephemeral: true
        });
    }

    // ── Stamina check ──────────────────────────────────────────────────
    if (f.stamina <= 0) {
        const regenMs = msUntilNextStamina(user);
        return interaction.reply({
            content: `You're too tired to cast! Stamina regens in **${formatMs(regenMs)}**. Buy an Energy Drink from \`/fish shop\` to recover faster.`,
            ephemeral: true
        });
    }

    // ── Rod check ─────────────────────────────────────────────────────
    if (f.equippedRodIndex < 0 || !f.rods[f.equippedRodIndex]) {
        return interaction.reply({
            content: `You don't have a rod equipped! Buy one with \`/fish shop rod\` and equip it with \`/fish inv equip 1\`.`,
            ephemeral: true
        });
    }

    const rod = f.rods[f.equippedRodIndex];

    if (rod.status === 'broken' || rod.currentDurability <= 0) {
        return interaction.reply({
            content: `Your **${rod.name}** is broken! Repair it with \`/fish shop repair\` or buy a new one with \`/fish shop rod\`.`,
            ephemeral: true
        });
    }

    // ── Bait check ────────────────────────────────────────────────────
    const rodData = ROD_BY_TIER[rod.tier];
    if (rodData.requiresBait) {
        const baitStock = f.bait[rodData.baitType] ?? 0;
        if (baitStock <= 0) {
            return interaction.reply({
                content: `You're out of **${rodData.baitType.replace(/_/g, ' ')}**! Buy more with \`/fish shop\`.`,
                ephemeral: true
            });
        }
        f.bait[rodData.baitType] = baitStock - 1;
        user.markModified('fishing');
    }

    await interaction.deferReply();

    // ── Reaction Window Mechanic ───────────────────────────────────────────────
    // Show "lure in water" embed, then after a random delay enable a "Reel In!" button.
    // reaction < 2s = 1.2x payout bonus | 2–4s = 1.0x normal | timeout = 0 (no payout)
    const reelId = `fish_reel_${interaction.id}_${Date.now()}`;
    const delay  = ms => new Promise(r => setTimeout(r, ms));

    const luringEmbed = new EmbedBuilder()
        .setColor('#4169E1')
        .setTitle('🎣 Cast!')
        .setDescription('*Your lure hits the water with a satisfying plop…*\n\n🎣 **Lure in water… waiting…**')
        .setAuthor({ name: interaction.member?.displayName || interaction.user.username, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) });

    await interaction.editReply({ embeds: [luringEmbed], components: [] });

    // Random wait before fish bites (3–8 seconds)
    const waitMs = 3000 + Math.floor(Math.random() * 5001);
    await delay(waitMs);

    const bitingEmbed = new EmbedBuilder()
        .setColor('#FF6600')
        .setTitle('🐟 Something\'s Biting!')
        .setDescription('⚡ **REEL IT IN!** ⚡\n\n*React fast for a bonus — you have 4 seconds!*')
        .setAuthor({ name: interaction.member?.displayName || interaction.user.username, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) });

    const reelRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(reelId).setLabel('🎣 Reel In!').setStyle(ButtonStyle.Success)
    );

    await interaction.editReply({ embeds: [bitingEmbed], components: [reelRow] });
    const biteTime = Date.now();

    // Wait for reaction (4s window)
    const reelMsg   = await interaction.fetchReply();
    const reactionMs = await new Promise(resolve => {
        const col = reelMsg.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && i.customId === reelId,
            time: 4_000,
            max: 1,
        });
        col.on('collect', async i => { await i.deferUpdate(); resolve(Date.now() - biteTime); });
        col.on('end',     (_, reason) => { if (reason !== 'limit') resolve(null); });
    });

    let reactionFactor;
    if (reactionMs === null) {
        reactionFactor = 0; // missed
    } else if (reactionMs < 2000) {
        reactionFactor = 1.2; // fast reel bonus
    } else {
        reactionFactor = 1.0; // normal
    }

    // If missed, show brief missed message before showing full result
    if (reactionFactor === 0) {
        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor('#888888')
                .setTitle('🐟 The Fish Got Away!')
                .setDescription('*You were too slow — the fish slipped free.*\n\nStamina spent, no reward.')
                .setAuthor({ name: interaction.member?.displayName || interaction.user.username, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })],
            components: [],
        });
        await delay(1200);
    }

    // Fish/Shark pet: +5%/+15% yield (only if hunger >= 30)
    const { getTotalBonus } = require('../../services/petService');
    const petFishYieldPct = getTotalBonus(user.pets || [], 'fish_yield');

    const result = executeCast(user, locationId, { reactionFactor });

    if (result.success && result.finalPayout > 0 && petFishYieldPct > 0) {
        const bonus = Math.round(result.finalPayout * petFishYieldPct / 100);
        if (bonus > 0) {
            user.balance              += bonus;
            user.fishing.totalEarned  += bonus;
            user.fishing.dailyCoins   += bonus;
            result.finalPayout        += bonus;
            result.petYieldBonus       = bonus;
        }
    }

    updateFishQuestProgress(user, result, locationId);

    const fishAchievements = await checkAndAward(user, guildSettings).catch(() => []);

    try {
        await user.save();
        if (fishAchievements.length) {
            announceAchievements(interaction.client, guildSettings, user, interaction.member, fishAchievements).catch(() => null);
        }
    } catch (err) {
        if (err.name === 'VersionError') {
            return interaction.editReply({ content: 'A simultaneous request conflicted. Please try `/fish cast` again.' });
        }
        console.error('[fish] save error:', err);
        return interaction.editReply({ content: 'Something went wrong saving your catch. Please try again.' });
    }

    const embed = buildCastEmbed(result, user, location, rod, currency, interaction.user);

    if (result.petYieldBonus > 0) {
        embed.addFields({ name: '🐠 Pet Bonus', value: `+${result.petYieldBonus.toLocaleString()} coins (${petFishYieldPct}% yield)`, inline: true });
    }

    // Annotate embed with reaction window result
    if (result.reactionFactor !== undefined) {
        const desc = embed.data.description ?? '';
        if (result.reactionFactor === 0) {
            embed.setDescription(desc + '\n> ⏰ *Reaction too slow — fish escaped (no payout)*');
        } else if (result.reactionFactor > 1.0) {
            embed.setDescription(desc + `\n> ⚡ *Quick reel! ${((result.reactionFactor - 1) * 100).toFixed(0)}% payout bonus applied*`);
        }
    }

    // Boss encounter — present choices if triggered
    if (result.bossEncounter) {
        const bossRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('boss_fight').setLabel('⚔️ Fight').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('boss_loosen').setLabel('〰️ Loosen Line').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('boss_cut').setLabel('✂️ Cut Line').setStyle(ButtonStyle.Secondary)
        );
        const bossEmbed = new EmbedBuilder()
            .setColor('#e74c3c')
            .setTitle('⚠️ Something enormous bites your line...')
            .setDescription(
                `A **${result.bossEncounter.fish.emoji} ${result.bossEncounter.fish.name}** latches on with terrifying force!\n\n` +
                `**What do you do?**\n` +
                `⚔️ **Fight** — high risk, big reward. Your rod will take damage.\n` +
                `〰️ **Loosen Line** — safer fight, partial payout.\n` +
                `✂️ **Cut Line** — safe retreat, no reward.`
            )
            .setFooter({ text: 'You have 30 seconds to decide!' });

        await interaction.editReply({ embeds: [embed, bossEmbed], components: [bossRow] });

        const bossReply = await interaction.fetchReply();
        const bossCollector = bossReply.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id && ['boss_fight', 'boss_loosen', 'boss_cut'].includes(i.customId),
            time: 30_000, max: 1
        });

        bossCollector.on('collect', async btn => {
            const choiceMap = { boss_fight: 'fight', boss_loosen: 'loosen', boss_cut: 'cut' };
            const choice    = choiceMap[btn.customId];

            const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            ensureFishingData(freshUser);
            const bossResult = resolveBossEncounter(freshUser, result.bossEncounter.fish, result.bossEncounter.tier, choice);

            if (bossResult.bonusPayout > 0) {
                const bossLocation = LOCATIONS[freshUser.fishing.activeLocation] ?? location;
                const { adjustedPayout } = applyPayoutModifiers(freshUser, bossResult.bonusPayout, bossLocation);
                bossResult.bonusPayout = adjustedPayout;
                freshUser.balance                 += adjustedPayout;
                freshUser.fishing.totalEarned     += adjustedPayout;
                freshUser.fishing.dailyCoins      += adjustedPayout;
                if (adjustedPayout > freshUser.fishing.bestPayout) freshUser.fishing.bestPayout = adjustedPayout;
            }
            freshUser.markModified('fishing');
            try {
                await freshUser.save();
            } catch (saveErr) {
                console.error('[fish boss] save error:', saveErr);
                return btn.update({ content: 'Something went wrong saving your boss result. Please try again.', embeds: [], components: [] });
            }

            const freshCurrency = currency;
            const bossResultEmbed = new EmbedBuilder()
                .setColor(bossResult.outcome === 'win' ? '#2ecc71' : bossResult.outcome === 'loss' ? '#e74c3c' : '#95a5a6')
                .setTitle(bossResult.outcome === 'win' ? '🎉 Boss Defeated!' : bossResult.outcome === 'loss' ? '💥 Got Away!' : bossResult.outcome === 'loosen' ? '〰️ Partial Victory' : '✂️ Line Cut')
                .setDescription(bossResult.message)
                .addFields(
                    { name: 'Bonus Payout',   value: bossResult.bonusPayout > 0 ? `${freshCurrency}${bossResult.bonusPayout.toLocaleString()}` : 'None', inline: true },
                    { name: 'Rod Damage',     value: `-${bossResult.durabilityLost} durability`, inline: true }
                )
                .setTimestamp();

            await btn.update({ embeds: [embed, bossResultEmbed], components: [] });
        });

        bossCollector.on('end', (collected, reason) => {
            if (reason === 'time' && collected.size === 0) {
                interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
            }
        });
        return;
    }

    await interaction.editReply({ embeds: [embed] });

    if (result.success && result.tier === 'legendary' && guildSettings?.economy?.announceRareDrops !== false) {
        const announceChannelId = guildSettings?.economy?.announcementChannelId;
        const resolved = announceChannelId ? interaction.guild.channels.cache.get(announceChannelId) : null;
        const announceChannel = resolved?.isTextBased() ? resolved : interaction.channel;
        const announcementEmbed = new EmbedBuilder()
            .setColor('#ff9800')
            .setTitle('✨ Legendary Catch! ✨')
            .setDescription(
                `<@${interaction.user.id}> just pulled a ${result.fish.emoji} **${result.fish.name}** [⭐⭐⭐⭐⭐]\n` +
                `while fishing in the **${location.name}**.\n\n` +
                `That's incredibly rare.`
            )
            .setTimestamp();
        announceChannel.send({ embeds: [announcementEmbed] }).catch(() => null);
    }
}

// ─── EMBED BUILDER ────────────────────────────────────────────────────────────

function buildCastEmbed(result, user, location, rod, currency, discordUser) {
    const f = user.fishing;

    if (result.success) {
        const { catchType, finalPayout, xpEarned, levelUp, cappedByHard } = result;

        if (catchType === 'junk') {
            const junk = result.junkItem;
            const embed = new EmbedBuilder()
                .setColor(TIER_COLORS.junk)
                .setTitle(`${junk.emoji} ${junk.name}`)
                .setDescription(
                    finalPayout > 0
                        ? `You reeled in **junk** — a ${junk.name}. Sold for **${currency}${finalPayout}**.`
                        : `You reeled in **junk** — a ${junk.name}. Worth nothing.`
                )
                .addFields(
                    { name: 'Location', value: `${location.emoji} ${location.name}`, inline: true },
                    { name: 'Reward',   value: finalPayout > 0 ? `${currency}${finalPayout}` : 'Nothing', inline: true },
                    { name: 'XP',       value: `+${xpEarned} XP`, inline: true },
                    { name: 'Rod',      value: buildRodLine(rod), inline: true },
                    { name: 'Stamina',  value: buildStaminaLine(user), inline: true }
                )
                .setFooter({ text: buildFooter(user) })
                .setTimestamp();
            if (levelUp) embed.addFields({ name: '⬆️ Level Up!', value: buildLevelUpLine(levelUp) });
            return embed;
        }

        if (catchType === 'treasure') {
            const treasure = result.treasureItem;
            const embed = new EmbedBuilder()
                .setColor(TIER_COLORS.treasure)
                .setTitle(`${treasure.emoji} ${treasure.name} — Treasure!`)
                .setDescription(`You pulled up **${treasure.name}** from the depths! Sold for **${currency}${finalPayout.toLocaleString()}**.`)
                .addFields(
                    { name: 'Location', value: `${location.emoji} ${location.name}`, inline: true },
                    { name: 'Reward',   value: `**${currency}${finalPayout.toLocaleString()}**`, inline: true },
                    { name: 'XP',       value: `+${xpEarned} XP`, inline: true },
                    { name: 'Rod',      value: buildRodLine(rod), inline: true },
                    { name: 'Stamina',  value: buildStaminaLine(user), inline: true }
                )
                .setFooter({ text: buildFooter(user) })
                .setTimestamp();
            if (levelUp)       embed.addFields({ name: '⬆️ Level Up!', value: buildLevelUpLine(levelUp), inline: false });
            if (cappedByHard)  embed.addFields({ name: '⚠️ Daily Cap', value: 'Daily coin limit reached. Rewards reduced.', inline: false });
            return embed;
        }

        // Fish catch
        const { fish, tier, isCrit, critMultiplier, sizeLabel, specialDrop } = result;
        const color      = isCrit ? '#FFD700' : TIER_COLORS[tier];
        const tierLabel  = tier.charAt(0).toUpperCase() + tier.slice(1);
        const weightStr  = result.weightLbs > 0 ? ` (${result.weightLbs} lbs)` : '';
        const sizeStr    = sizeLabel ? ` [${sizeLabel}${weightStr}]` : '';
        const payDisplay = cappedByHard
            ? `~~${currency}${finalPayout}~~ (daily cap)`
            : `**${currency}${finalPayout.toLocaleString()}**`;

        const isLegendary = tier === 'legendary';
        const embedTitle = isLegendary
            ? `🌊✨ LEGENDARY CATCH ✨🌊`
            : `${fish.emoji} ${isCrit ? '✨ CRITICAL! ' : ''}${fish.name}${sizeStr}${isCrit ? ' ✨' : ''}`;
        const embedDesc = isLegendary
            ? `You pulled something impossible from the deep.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  ${fish.emoji}  **${fish.name}**${sizeStr}  [⭐⭐⭐⭐⭐]\n  *${fish.flavor}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nAdded to your inventory.`
            : `*${fish.flavor}*`;

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(embedTitle)
            .setDescription(embedDesc)
            .addFields(
                { name: 'Location', value: `${location.emoji} ${location.name}`,    inline: true },
                { name: 'Tier',     value: tierLabel,                                inline: true },
                { name: 'Reward',   value: payDisplay,                               inline: true },
                { name: 'XP',       value: `+${xpEarned} XP${isCrit ? ' (crit)' : ''}`, inline: true },
                { name: 'Rod',      value: buildRodLine(rod),                        inline: true },
                { name: 'Stamina',  value: buildStaminaLine(user),                   inline: true }
            );

        if (isCrit) embed.addFields({ name: 'Crit Multiplier', value: `×${critMultiplier}`, inline: true });

        // Fish traits display
        if (result.traitEffects?.length) {
            const traitLines = result.traitEffects.map(t => {
                const def = FISH_TRAITS[t];
                return def ? `• **${t}** — ${def.description}` : `• ${t}`;
            });
            embed.addFields({ name: '🧬 Traits', value: traitLines.join('\n'), inline: false });
        }
        if (result.venomousDrain) embed.addFields({ name: '☠️ Venomous!', value: 'The fish stung you — extra stamina drained!', inline: true });

        // Personal best
        if (result.isPersonalBest && result.weightLbs > 0) {
            embed.addFields({ name: '🏆 New Personal Best!', value: `${fish.name} — ${result.weightLbs} lbs!`, inline: false });
        }

        if (specialDrop) embed.addFields({ name: '🎁 Material Drop!', value: `You found **${specialDrop.name}**!`, inline: false });
        if (levelUp) embed.addFields({ name: '⬆️ Level Up!', value: buildLevelUpLine(levelUp), inline: false });
        if (result.expiredBait) embed.addFields({ name: '🐟 Bait Expired', value: `Your ${result.expiredBait.replace(/_/g, ' ')} has worn off.`, inline: false });

        if (rod.status === 'broken') {
            embed.addFields({ name: '❌ Rod Broke!', value: `Your **${rod.name}** has broken! Use \`/fish shop repair\` before casting again.`, inline: false });
        } else if (rod.currentDurability <= Math.floor(rod.maxDurability * 0.20)) {
            embed.addFields({ name: '⚠️ Low Durability', value: `Your rod is nearly worn out (${rod.currentDurability}/${rod.maxDurability}). Repair soon!`, inline: false });
        }

        embed.addFields(
            { name: 'Balance',   value: `${currency}${user.balance.toLocaleString()}`, inline: true },
            { name: 'Fisher XP', value: buildXpLine(user), inline: true }
        );
        embed.setFooter({ text: buildFooter(user) });
        embed.setTimestamp();
        return embed;
    }

    // ── Trait escape ──────────────────────────────────────────────────────
    if (result.traitEscape) {
        const { fish } = result.traitEscape;
        const escEmbed = new EmbedBuilder()
            .setColor('#e67e22')
            .setTitle(`😤 ${fish.emoji} ${fish.name} Escaped!`)
            .setDescription(`*${result.failure?.message ?? 'The fish slipped free.'}*`)
            .addFields(
                { name: 'Location', value: `${location.emoji} ${location.name}`, inline: true },
                { name: 'Trait',    value: `🧬 ${result.traitEscape.trait}`,      inline: true },
                { name: 'Rod',      value: buildRodLine(rod),                     inline: true },
                { name: 'Stamina',  value: buildStaminaLine(user),                inline: true }
            )
            .setFooter({ text: buildFooter(user) })
            .setTimestamp();
        return escEmbed;
    }

    // ── Failure embed ──────────────────────────────────────────────────────
    const { failure, xpEarned, levelUp } = result;
    const embed = new EmbedBuilder()
        .setColor('#e74c3c')
        .setTitle(buildFailureTitle(failure.severity.id))
        .setDescription(`*${failure.message}*`)
        .addFields(
            { name: 'Location', value: `${location.emoji} ${location.name}`, inline: true },
            { name: 'Reward',   value: 'Nothing',                             inline: true },
            { name: 'XP',       value: xpEarned > 0 ? `+${xpEarned} XP` : 'None', inline: true },
            { name: 'Rod',      value: buildRodLine(rod),                     inline: true },
            { name: 'Stamina',  value: buildStaminaLine(user),                inline: true }
        );

    if (failure.severity.injuryMs > 0) {
        embed.addFields({ name: '🤕 Soaked!', value: `Extra cooldown: **${formatMs(failure.severity.injuryMs)}**`, inline: true });
    }
    if (levelUp) embed.addFields({ name: '⬆️ Level Up!', value: buildLevelUpLine(levelUp), inline: false });
    if (rod.status === 'broken') {
        embed.addFields({ name: '❌ Rod Broke!', value: `Your **${rod.name}** has broken! Use \`/fish shop repair\` before casting again.`, inline: false });
    }

    embed.setFooter({ text: 'Tip: Use consumables from /fish shop to boost your success chance' });
    embed.setTimestamp();
    return embed;
}

function buildFailureTitle(severityId) {
    return {
        line_slack: '💨 Nothing Biting...',
        spooked:    '😰 Spooked!',
        line_snap:  '💥 Line Snapped!',
        fell_in:    '💦 Fell In!'
    }[severityId] ?? '❌ Failed Cast';
}

function buildRodLine(rod) {
    return `${rod.name} ${rodStatusEmoji(rod.status)}\n${durabilityBar(rod.currentDurability, rod.maxDurability)} ${rod.currentDurability}/${rod.maxDurability}`;
}

function buildStaminaLine(user) {
    const max = getMaxStamina(user);
    return `${user.fishing.stamina}/${max} ⚡`;
}

function buildXpLine(user) {
    const f      = user.fishing;
    const toNext = xpToNextLevel(f.level, f.xp);
    if (toNext === null) return `${f.xp.toLocaleString()} XP (MAX)`;
    return `${f.xp.toLocaleString()} XP (${toNext} to Lv.${f.level + 1})`;
}

function buildLevelUpLine(levelUp) {
    const ld = getLevelData(levelUp.newLevel);
    return `Fisher Level **${levelUp.oldLevel}** → **${levelUp.newLevel}** (${ld.title})`;
}

function buildFooter(user) {
    const f = user.fishing;
    const parts = [`Cooldown: 45s`];
    if (f.activeBait)  parts.push(`Bait (${f.activeBaitCastsLeft} casts left)`);
    if (f.activeLuck)  parts.push(`Luck (queued)`);
    if (f.activeXpScroll) parts.push(`XP Scroll (queued)`);

    const weather = getCurrentWeather();
    const tod     = getTimeOfDay();
    const todData = TIME_OF_DAY_BONUSES[tod];
    parts.push(`${weather.emoji} ${weather.name}`);
    if (todData) parts.push(todData.description);

    return parts.join(' • ');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILE
// ═══════════════════════════════════════════════════════════════════════════════

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
                ? "You haven't started fishing yet! Buy a rod with `/fish shop rod` and use `/fish cast` to begin."
                : `${target.username} hasn't started fishing yet.`,
            ephemeral: true
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

    if (prestige === 0 && f.level >= 50) {
        embed.setFooter({ text: 'Max level reached! Use /fish prestige to reset and unlock new bonuses.' });
    } else if (isSelf) {
        embed.setFooter({ text: `Daily: ${f.dailyCasts} casts · ${currency}${f.dailyCoins.toLocaleString()} earned (cap: ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()})` });
    }

    embed.setTimestamp();
    return interaction.reply({ embeds: [embed] });
}

function buildXpBar(f, toNext) {
    if (toNext === null) return '████████████████████ MAX';
    const nextLevelXp = FISHER_LEVELS[f.level]?.xpRequired ?? 1;
    const progress    = nextLevelXp > 0 ? Math.min(1, f.xp / nextLevelXp) : 0;
    const filled      = Math.min(20, Math.max(0, Math.round(progress * 20)));
    const pct         = Math.min(100, Math.max(0, Math.round(progress * 100)));
    return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${pct}%`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRESTIGE
// ═══════════════════════════════════════════════════════════════════════════════

async function handlePrestige(interaction) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
    }

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    ensureFishingData(user);
    const f = user.fishing;

    if (f.level < 50) {
        return interaction.reply({
            content: `You need Fisher Level **50** to prestige. You are currently Level **${f.level}**.`,
            ephemeral: true
        });
    }

    const currentPrestige = f.prestige ?? 0;
    if (currentPrestige >= MAX_PRESTIGE) {
        return interaction.reply({
            content: `You have already reached the maximum prestige (**P${MAX_PRESTIGE} — Diamond Angler**). You are a true legend of the sea! 💎`,
            ephemeral: true
        });
    }

    const nextPrestige   = currentPrestige + 1;
    const currentBonuses = PRESTIGE_BONUSES[currentPrestige];
    const nextBonuses    = PRESTIGE_BONUSES[nextPrestige];

    const confirmEmbed = new EmbedBuilder()
        .setColor('#f39c12')
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
        filter: i => i.user.id === interaction.user.id &&
                     ['fishprestige_confirm', 'fishprestige_cancel'].includes(i.customId),
        time:   30_000,
        max:    1
    });

    collector.on('collect', async i => {
        if (i.customId === 'fishprestige_cancel') {
            await i.update({ content: 'Prestige cancelled.', embeds: [], components: [] });
            return;
        }

        const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
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

        const resultEmbed = new EmbedBuilder()
            .setColor('#f39c12')
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

function formatPrestigeBonuses(bonus) {
    const lines = [];
    if (bonus.critBonus    > 0) lines.push(`+${Math.round(bonus.critBonus    * 100)}% crit chance`);
    if (bonus.staminaBonus > 0) lines.push(`+${bonus.staminaBonus} max stamina`);
    if (bonus.payoutBonus  > 0) lines.push(`+${Math.round(bonus.payoutBonus  * 100)}% all payouts`);
    if (bonus.rarityBonus  > 0) lines.push(`+${Math.round(bonus.rarityBonus  * 100)}% rarity boost`);
    return lines.length ? lines.join('\n') : 'None';
}

// ═══════════════════════════════════════════════════════════════════════════════
// INV
// ═══════════════════════════════════════════════════════════════════════════════

async function handleInv(interaction, sub) {
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
    ensureFishingData(user);
    applyStaminaRegen(user);

    switch (sub) {
        case 'rods':      return showRods(interaction, user);
        case 'equip':     return equipRod(interaction, user);
        case 'bait':      return showBait(interaction, user, currency);
        case 'materials': return showMaterials(interaction, user);
    }
}

async function showRods(interaction, user) {
    const f = user.fishing;

    if (!f.rods.length) {
        return interaction.reply({ content: `You don't own any rods yet. Buy one with \`/fish shop rod\`.`, ephemeral: true });
    }

    const lines = f.rods.map((rod, i) => {
        const equipped   = i === f.equippedRodIndex ? ' **[EQUIPPED]**' : '';
        const statusEmoji = rodStatusEmoji(rod.status);
        const bar         = durabilityBar(rod.currentDurability, rod.maxDurability, 8);
        const upgradeStr  = rod.upgrade ? ` | ${ROD_UPGRADES[rod.upgrade]?.emoji ?? ''} ${rod.upgrade.replace(/_/g, ' ')}` : '';
        return `**${i + 1}.** ${rod.name}${equipped}\n   ${statusEmoji} ${bar} ${rod.currentDurability}/${rod.maxDurability}${upgradeStr}`;
    });

    const embed = new EmbedBuilder()
        .setColor('#3498db')
        .setTitle(`🎣 ${interaction.user.username}'s Rods`)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Use /fish inv equip <number> to equip a rod • /fish shop repair to repair' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function equipRod(interaction, user) {
    const f      = user.fishing;
    const number = interaction.options.getInteger('number');
    const index  = number - 1;

    if (index < 0 || index >= f.rods.length) {
        return interaction.reply({ content: `Invalid rod number. You have **${f.rods.length}** rod(s).`, ephemeral: true });
    }

    const rod = f.rods[index];
    if (rod.status === 'broken') {
        return interaction.reply({ content: `Your **${rod.name}** is broken and cannot be equipped. Repair it first with \`/fish shop repair\`.`, ephemeral: true });
    }

    f.equippedRodIndex = index;
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[fishinv equip] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true });
    }

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle('✅ Rod Equipped')
                .setDescription(`You equipped **${rod.name}** (Slot ${number}).`)
                .addFields({ name: 'Durability', value: `${durabilityBar(rod.currentDurability, rod.maxDurability)} ${rod.currentDurability}/${rod.maxDurability}`, inline: true })
                .setTimestamp()
        ]
    });
}

async function showBait(interaction, user, currency) {
    const f = user.fishing;

    const baitLines = Object.entries(f.bait ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([type, qty]) => {
            const pack = BAIT_PACKS.find(b => b.baitType === type);
            return `${pack?.emoji ?? '🪱'} **${type.replace(/_/g, ' ')}**: ${qty}`;
        });

    const consumableLines = Object.entries(f.consumables ?? {})
        .filter(([, qty]) => qty > 0)
        .map(([id, qty]) => {
            const def = CONSUMABLES[id];
            return `${def?.emoji ?? '📦'} **${def?.name ?? id}**: ${qty}`;
        });

    const activeLines = [];
    if (f.activeBait)    activeLines.push(`🐟 Chum Bait active (${f.activeBaitCastsLeft} casts left)`);
    if (f.activeLuck)    activeLines.push(`🍀 Angler's Luck queued`);
    if (f.activeXpScroll) activeLines.push(`📜 XP Scroll queued`);

    const embed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle(`🎒 ${interaction.user.username}'s Fishing Supplies`)
        .addFields(
            { name: '🪱 Bait Stock', value: baitLines.length ? baitLines.join('\n') : 'None', inline: false },
            { name: '🧪 Consumables', value: consumableLines.length ? consumableLines.join('\n') : 'None', inline: false },
            { name: '⚡ Active Buffs', value: activeLines.length ? activeLines.join('\n') : 'None', inline: false }
        )
        .setFooter({ text: 'Use /fish shop to buy supplies • /use <item> to activate consumables' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function showMaterials(interaction, user) {
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

    const embed = new EmbedBuilder()
        .setColor('#95a5a6')
        .setTitle(`🪨 ${interaction.user.username}'s Fishing Materials`)
        .addFields(
            { name: 'Fishing Materials', value: matLines.length ? matLines.join('\n') : 'None yet — catch fish for material drops!', inline: false }
        );

    if (huntMatLines.length) {
        embed.addFields({ name: 'Hunt Materials (cross-system)', value: huntMatLines.join('\n'), inline: false });
    }

    embed.setFooter({ text: 'Materials are used in crafting recipes. Use /fish craft list to see what you can make.' });
    embed.setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUESTS
// ═══════════════════════════════════════════════════════════════════════════════

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
    ensureFishingData(user);
    assignDailyFishQuests(user);

    if (user.isModified()) {
        await user.save().catch(e => console.error('[fishquests] pre-save error:', e));
    }

    if (sub === 'view') return showQuests(interaction, user, currency);
    return claimQuest(interaction, user, currency);
}

async function showQuests(interaction, user, currency) {
    const now         = Date.now();
    const fishQuests  = user.quests.filter(q =>
        q.questId.startsWith('fq_') &&
        q.expiresAt?.getTime() > now
    );

    if (!fishQuests.length) {
        return interaction.reply({ content: 'No fishing quests assigned yet. Use `/fish cast` to start fishing!', ephemeral: true });
    }

    const lines = fishQuests.map((q, i) => {
        const template  = FISH_QUEST_TEMPLATES.find(t => t.id === q.questId);
        if (!template) return null;

        const isClaimed   = q.progress === -1;
        const isCompleted = q.completedAt && !isClaimed;
        const progress    = isClaimed ? template.target : Math.min(q.progress, template.target);
        const bar         = buildQuestProgressBar(progress, template.target, 10);
        const rewardStr   = `${currency}${template.reward.coins} + ${template.reward.xp} XP`;
        const expiresIn   = formatMs(q.expiresAt.getTime() - now);

        const statusIcon  = isClaimed ? '✅' : isCompleted ? '🎁' : '⏳';
        return [
            `**${i + 1}.** ${template.emoji} **${template.name}** ${statusIcon}`,
            `   ${template.description}`,
            `   ${bar} ${progress}/${template.target}`,
            `   Reward: ${rewardStr}${isClaimed ? ' (claimed)' : isCompleted ? ' — **/fish quests claim ' + (i + 1) + '**' : ''}`,
            `   Expires in: ${expiresIn}`
        ].join('\n');
    }).filter(Boolean);

    const embed = new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle(`🎣 ${interaction.user.username}'s Daily Fishing Quests`)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Quests refresh every 24h after all are completed or claimed' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function claimQuest(interaction, user, currency) {
    const now        = Date.now();
    const number     = interaction.options.getInteger('number');
    const fishQuests = user.quests.filter(q =>
        q.questId.startsWith('fq_') &&
        q.expiresAt?.getTime() > now
    );

    const questEntry = fishQuests[number - 1];
    if (!questEntry) {
        return interaction.reply({ content: `No quest at slot #${number}. Use \`/fish quests view\` to see your quests.`, ephemeral: true });
    }

    const template = FISH_QUEST_TEMPLATES.find(t => t.id === questEntry.questId);
    if (!template) {
        return interaction.reply({ content: 'Quest data not found.', ephemeral: true });
    }

    if (questEntry.progress === -1) {
        return interaction.reply({ content: `**${template.name}** has already been claimed.`, ephemeral: true });
    }
    if (!questEntry.completedAt) {
        const progress = Math.min(questEntry.progress, template.target);
        return interaction.reply({
            content: `**${template.name}** is not complete yet. Progress: **${progress}/${template.target}**.`,
            ephemeral: true
        });
    }

    const oldLevel      = user.fishing.level;
    user.balance       += template.reward.coins;
    questEntry.progress = -1;

    const lvResult = applyXp(user, template.reward.xp);
    const leveledUp = lvResult.leveledUp;

    user.markModified('quests');
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[fishquests claim] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setColor('#2ecc71')
        .setTitle(`${template.emoji} Quest Reward Claimed!`)
        .setDescription(`**${template.name}** completed!`)
        .addFields(
            { name: 'Coins Earned', value: `${currency}${template.reward.coins.toLocaleString()}`, inline: true },
            { name: 'XP Earned',   value: `+${template.reward.xp} Fishing XP`,                   inline: true },
            { name: 'Balance',     value: `${currency}${user.balance.toLocaleString()}`,           inline: true }
        )
        .setTimestamp();

    if (leveledUp) {
        const ld = getLevelData(lvResult.newLevel);
        embed.addFields({ name: '⬆️ Level Up!', value: `Fisher Level **${oldLevel}** → **${lvResult.newLevel}** (${ld.title})`, inline: false });
    }

    return interaction.reply({ embeds: [embed] });
}

function buildQuestProgressBar(current, total, length) {
    const filled = Math.min(length, Math.max(0, Math.round((current / Math.max(1, total)) * length)));
    return `[${'█'.repeat(filled)}${'░'.repeat(length - filled)}]`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHOP
// ═══════════════════════════════════════════════════════════════════════════════

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
        `${u.emoji} **${u.name}** — *${u.description}* · \`/fish shop upgrade module:${u.id}\``
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

    const rodImg = await getItemImageAttachment(`fish:${rodData.slug || rodData.id}`).catch(() => null);
    if (rodImg) confirmEmbed.setThumbnail(rodImg.url);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('buyrod_confirm').setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('buyrod_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    const fishConfirmPayload = { embeds: [confirmEmbed], components: [row], ephemeral: true, fetchReply: true };
    if (rodImg) fishConfirmPayload.files = [rodImg.attachment];
    const reply = await interaction.reply(fishConfirmPayload);
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
        return interaction.reply({ content: `You don't have a rod equipped. Use \`/fish inv equip\` first.`, ephemeral: true });
    }

    const upgradeId  = interaction.options.getString('type');
    const upgradeDef = ROD_UPGRADES[upgradeId];

    if (!upgradeDef) {
        return interaction.reply({ content: 'Unknown upgrade.', ephemeral: true });
    }

    const targetRodIndex = f.equippedRodIndex;
    const rod     = f.rods[targetRodIndex];
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

        const freshRod = freshUser.fishing.rods[targetRodIndex];
        if (!freshRod) {
            return btn.update({ content: 'That rod is no longer in your inventory.', embeds: [], components: [] });
        }
        if (freshRod.upgrade) {
            return btn.update({ content: `**${freshRod.name}** already has an upgrade installed.`, embeds: [], components: [] });
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
                .setFooter({ text: `Use /fish shop use ${consumable.id} to activate it` })
                .setTimestamp()
        ]
    });
}

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

async function handleRepair(interaction, user, currency) {
    const f = user.fishing;

    if (f.equippedRodIndex < 0 || !f.rods[f.equippedRodIndex]) {
        return interaction.reply({ content: `You don't have a rod equipped. Buy one with \`/fish shop rod\`.`, ephemeral: true });
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
            return interaction.reply({ content: `You don't have any **${kitName}**. Buy one with \`/fish shop buy\`.`, ephemeral: true });
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
                .setFooter({ text: 'Use /fish cast to start catching from this location • Switch anytime with /fish location set' })
                .setTimestamp()
        ]
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRAFT
// ═══════════════════════════════════════════════════════════════════════════════

async function handleCraft(interaction, sub) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
    }

    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    ensureFishingData(user);
    ensureHuntData(user);
    const f = user.fishing;
    const h = user.hunt;

    if (sub === 'list') {
        const lines = Object.values(FISH_CRAFT_RECIPES).map(r => {
            const ingredientStr = r.ingredients
                .map(ing => {
                    const name = getCraftMaterialName(ing.material, ing.source);
                    const tag  = ing.source === 'hunt' ? ' *(hunt)*' : '';
                    return `${name}${tag} ×${ing.qty}`;
                })
                .join(', ');

            const canCraft = r.ingredients.every(ing =>
                getCraftMaterialStock(ing.material, ing.source, h, f) >= ing.qty
            );
            const uniqueDone = r.unique && r.output.id === 'luckyHook' && f.luckyHook;
            const status = uniqueDone ? '✅ **[OWNED]**' : canCraft ? '✅' : '❌';

            return `${status} **${r.emoji} ${r.name}**\n> ${r.description}\n> Requires: ${ingredientStr}`;
        });

        const embed = new EmbedBuilder()
            .setColor('#3498db')
            .setTitle('🎣 Fishing Crafting Recipes')
            .setDescription(lines.join('\n\n'))
            .setFooter({ text: '✅ = you can craft now  •  Use /fish craft make <recipe> to craft  •  /fish inv materials to check stock' });

        return interaction.reply({ embeds: [embed] });
    }

    if (sub === 'make') {
        const recipeId = interaction.options.getString('recipe');
        const recipe   = FISH_CRAFT_RECIPES[recipeId];

        if (!recipe) {
            return interaction.reply({
                content: 'Unknown recipe. Use `/fish craft list` to see available recipes.',
                ephemeral: true
            });
        }

        if (recipe.unique && recipe.output.id === 'luckyHook' && f.luckyHook) {
            return interaction.reply({
                content: 'You already have the **🎣 Lucky Hook** upgrade!',
                ephemeral: true
            });
        }

        if (recipe.output.type === 'consumable' || recipe.output.type === 'dual_stamina') {
            const def          = CONSUMABLES[recipe.output.id];
            const currentStock = f.consumables[recipe.output.id] ?? 0;
            const qty          = recipe.output.qty ?? 1;
            if (def && currentStock + qty > def.maxStack) {
                return interaction.reply({
                    content: `You can only hold **${def.maxStack}× ${def.name}** (you have ${currentStock}). ` +
                             `Free up space before crafting more.`,
                    ephemeral: true
                });
            }
        }

        const missing = recipe.ingredients
            .filter(ing => getCraftMaterialStock(ing.material, ing.source, h, f) < ing.qty)
            .map(ing => {
                const have = getCraftMaterialStock(ing.material, ing.source, h, f);
                const name = getCraftMaterialName(ing.material, ing.source);
                const tag  = ing.source === 'hunt' ? ' (hunt material)' : '';
                return `**${name}${tag}** (need ${ing.qty}, have ${have})`;
            });

        if (missing.length) {
            return interaction.reply({
                content: `You are missing the following materials:\n${missing.join('\n')}`,
                ephemeral: true
            });
        }

        for (const ing of recipe.ingredients) {
            if (ing.source === 'hunt') {
                h.materials[ing.material] -= ing.qty;
            } else {
                f.materials[ing.material] -= ing.qty;
            }
        }

        let outputDesc = '';
        if (recipe.output.type === 'consumable') {
            const qty = recipe.output.qty ?? 1;
            f.consumables[recipe.output.id] = (f.consumables[recipe.output.id] ?? 0) + qty;
            const def = CONSUMABLES[recipe.output.id];
            outputDesc = `${def?.emoji ?? '📦'} **${qty}× ${def?.name ?? recipe.output.id}**`;
        } else if (recipe.output.type === 'dual_stamina') {
            const qty = recipe.output.qty ?? 1;
            f.consumables[recipe.output.id] = (f.consumables[recipe.output.id] ?? 0) + qty;
            const def = CONSUMABLES[recipe.output.id];
            outputDesc = `${def?.emoji ?? '⚗️'} **${qty}× ${def?.name ?? recipe.output.id}** — use with \`/use\` to restore stamina in both systems`;
        } else if (recipe.output.type === 'permanent') {
            if (recipe.output.id === 'luckyHook') {
                f.luckyHook = true;
                outputDesc = '🎣 **Lucky Hook** — permanently +1% critical catch chance!';
            }
        }

        const huntModified = recipe.ingredients.some(ing => ing.source === 'hunt');
        if (huntModified) user.markModified('hunt');
        user.markModified('fishing');
        await user.save();

        const usedLines = recipe.ingredients.map(ing => {
            const remaining = getCraftMaterialStock(ing.material, ing.source, h, f);
            const name      = getCraftMaterialName(ing.material, ing.source);
            const tag       = ing.source === 'hunt' ? ' *(hunt)*' : '';
            return `• ${name}${tag} ×${ing.qty}  (remaining: ${remaining})`;
        }).join('\n');

        const embed = new EmbedBuilder()
            .setColor('#2ecc71')
            .setTitle(`${recipe.emoji} Crafted: ${recipe.name}`)
            .setDescription(`You crafted ${outputDesc}!`)
            .addFields({ name: 'Materials Consumed', value: usedLines, inline: false })
            .setFooter({ text: 'Use /fish inv materials to check your remaining stock' })
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }
}

function getCraftMaterialName(materialId, source) {
    if (source === 'hunt') return HUNT_MATERIAL_NAMES[materialId] ?? materialId;
    return MATERIAL_NAMES[materialId] ?? materialId;
}

function getCraftMaterialStock(materialId, source, h, f) {
    if (source === 'hunt') return h.materials[materialId] ?? 0;
    return f.materials[materialId] ?? 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOCATION
// ═══════════════════════════════════════════════════════════════════════════════

async function handleLocation(interaction, sub) {
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
    ensureFishingData(user);

    switch (sub) {
        case 'list': return showLocationList(interaction, user, currency);
        case 'set':  return setLocation(interaction, user, currency);
    }
}

async function showLocationList(interaction, user, currency) {
    const f = user.fishing;

    const locationLines = LOCATION_LIST.map(loc => {
        const isUnlocked = f.unlockedLocations.includes(loc.id);
        const isActive   = f.activeLocation === loc.id;
        const tierStr    = formatTierWeights(loc.tierWeights);
        const status     = isActive ? ' **[ACTIVE]**' : isUnlocked ? ' ✅' : ` 🔒 Lv.${loc.unlockLevel}${loc.unlockCost > 0 ? ` / ${currency}${loc.unlockCost.toLocaleString()}` : ''}`;

        return [
            `${loc.emoji} **${loc.name}**${status}`,
            `   ${loc.description}`,
            `   Tiers: ${tierStr}`,
            `   Junk: ${Math.round(loc.junkChance * 100)}% | Treasure: ${Math.round(loc.treasureChance * 100)}%${loc.payoutBonus > 0 ? ` | Payout +${Math.round(loc.payoutBonus * 100)}%` : ''}`
        ].join('\n');
    });

    const embed = new EmbedBuilder()
        .setColor('#3498db')
        .setTitle('🗺️ Fishing Locations')
        .setDescription(locationLines.join('\n\n'))
        .setFooter({ text: 'Unlock new locations with /fish shop unlock • Switch with /fish location set' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function setLocation(interaction, user, currency) {
    const f          = user.fishing;
    const locationId = interaction.options.getString('location');
    const location   = LOCATIONS[locationId];

    if (!location) {
        return interaction.reply({ content: 'Unknown location.', ephemeral: true });
    }
    if (!f.unlockedLocations.includes(locationId)) {
        return interaction.reply({
            content: `**${location.name}** is locked. Unlock it with \`/fish shop unlock\`.`,
            ephemeral: true
        });
    }
    if (f.level < location.unlockLevel) {
        return interaction.reply({
            content: `You need Fisher Level **${location.unlockLevel}** to fish at **${location.name}**. You are Level **${f.level}**.`,
            ephemeral: true
        });
    }

    f.activeLocation = locationId;
    user.markModified('fishing');

    try {
        await user.save();
    } catch (err) {
        console.error('[location set] save error:', err);
        return interaction.reply({ content: 'Something went wrong. Please try again.', ephemeral: true });
    }

    return interaction.reply({
        embeds: [
            new EmbedBuilder()
                .setColor('#2ecc71')
                .setTitle(`📍 Location Changed`)
                .setDescription(`You are now fishing at **${location.emoji} ${location.name}**.`)
                .addFields({ name: 'About', value: location.description, inline: false })
                .setTimestamp()
        ]
    });
}

function formatTierWeights(weights) {
    const total = Object.values(weights).reduce((s, v) => s + v, 0);
    return Object.entries(weights)
        .filter(([, w]) => w > 0)
        .map(([tier, w]) => `${tier} ${Math.round((w / total) * 100)}%`)
        .join(', ');
}
