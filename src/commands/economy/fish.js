'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const { LOCATIONS, LOCATION_LIST, TIER_COLORS, LIMITS, ROD_BY_TIER } = require('../../data/fishData');
const {
    ensureFishingData,
    applyStaminaRegen,
    applyDailyReset,
    msUntilNextStamina,
    getMaxStamina,
    calculateSuccessChance,
    executeCast,
    assignDailyFishQuests,
    updateFishQuestProgress,
    formatMs,
    rodStatusEmoji,
    durabilityBar,
    getLevelData,
    xpToNextLevel
} = require('../../services/fishService');

const LOCATION_CHOICES = LOCATION_LIST.map(l => ({ name: l.name, value: l.id }));

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('fish')
        .setDescription('Cast your line and see what you catch')
        .addStringOption(o =>
            o.setName('location')
                .setDescription('Fishing location to use (defaults to your active location)')
                .setRequired(false)
                .addChoices(...LOCATION_CHOICES)),

    async execute(interaction) {
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
            return interaction.reply({ content: `Unknown location. Use \`/fishlocation list\` to see available spots.`, ephemeral: true });
        }
        if (!f.unlockedLocations.includes(locationId)) {
            return interaction.reply({
                content: `You haven't unlocked **${location.name}** yet. Use \`/fishlocation unlock ${locationId}\` to unlock it.`,
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
                content: `You're too tired to cast! Stamina regens in **${formatMs(regenMs)}**. Buy an Energy Drink from \`/fishshop\` to recover faster.`,
                ephemeral: true
            });
        }

        // ── Rod check ─────────────────────────────────────────────────────
        if (f.equippedRodIndex < 0 || !f.rods[f.equippedRodIndex]) {
            return interaction.reply({
                content: `You don't have a rod equipped! Buy one with \`/fishbuyrod\` and equip it with \`/fishinv equip 1\`.`,
                ephemeral: true
            });
        }

        const rod = f.rods[f.equippedRodIndex];

        if (rod.status === 'broken' || rod.currentDurability <= 0) {
            return interaction.reply({
                content: `Your **${rod.name}** is broken! Repair it with \`/fishrepair\` or buy a new one with \`/fishbuyrod\`.`,
                ephemeral: true
            });
        }

        // ── Bait check ────────────────────────────────────────────────────
        const rodData = ROD_BY_TIER[rod.tier];
        if (rodData.requiresBait) {
            const baitStock = f.bait[rodData.baitType] ?? 0;
            if (baitStock <= 0) {
                return interaction.reply({
                    content: `You're out of **${rodData.baitType.replace(/_/g, ' ')}**! Buy more with \`/fishshop\`.`,
                    ephemeral: true
                });
            }
            f.bait[rodData.baitType] = baitStock - 1;
            user.markModified('fishing');
        }

        await interaction.deferReply();

        const result = executeCast(user, locationId);
        updateFishQuestProgress(user, result, locationId);

        try {
            await user.save();
        } catch (err) {
            if (err.name === 'VersionError') {
                return interaction.editReply({ content: 'A simultaneous request conflicted. Please try `/fish` again.' });
            }
            console.error('[fish] save error:', err);
            return interaction.editReply({ content: 'Something went wrong saving your catch. Please try again.' });
        }

        const embed = buildCastEmbed(result, user, location, rod, currency, interaction.user);
        await interaction.editReply({ embeds: [embed] });
    }
};

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
        const sizeStr    = sizeLabel ? ` [${sizeLabel}]` : '';
        const payDisplay = cappedByHard
            ? `~~${currency}${finalPayout}~~ (daily cap)`
            : `**${currency}${finalPayout.toLocaleString()}**`;

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`${fish.emoji} ${isCrit ? '✨ CRITICAL! ' : ''}${fish.name}${sizeStr}${isCrit ? ' ✨' : ''}`)
            .setDescription(`*${fish.flavor}*`)
            .addFields(
                { name: 'Location', value: `${location.emoji} ${location.name}`,    inline: true },
                { name: 'Tier',     value: tierLabel,                                inline: true },
                { name: 'Reward',   value: payDisplay,                               inline: true },
                { name: 'XP',       value: `+${xpEarned} XP${isCrit ? ' (crit)' : ''}`, inline: true },
                { name: 'Rod',      value: buildRodLine(rod),                        inline: true },
                { name: 'Stamina',  value: buildStaminaLine(user),                   inline: true }
            );

        if (isCrit) embed.addFields({ name: 'Crit Multiplier', value: `×${critMultiplier}`, inline: true });
        if (specialDrop) embed.addFields({ name: '🎁 Material Drop!', value: `You found **${specialDrop.name}**!`, inline: false });
        if (levelUp) embed.addFields({ name: '⬆️ Level Up!', value: buildLevelUpLine(levelUp), inline: false });
        if (result.expiredBait) embed.addFields({ name: '🐟 Bait Expired', value: `Your ${result.expiredBait.replace(/_/g, ' ')} has worn off.`, inline: false });

        if (rod.status === 'broken') {
            embed.addFields({ name: '❌ Rod Broke!', value: `Your **${rod.name}** has broken! Use \`/fishrepair\` before casting again.`, inline: false });
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
        embed.addFields({ name: '❌ Rod Broke!', value: `Your **${rod.name}** has broken! Use \`/fishrepair\` before casting again.`, inline: false });
    }

    embed.setFooter({ text: 'Tip: Use consumables from /fishshop to boost your success chance' });
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
    const parts = [`Cooldown: 25s`];
    if (f.activeBait)  parts.push(`Bait (${f.activeBaitCastsLeft} casts left)`);
    if (f.activeLuck)  parts.push(`Luck (queued)`);
    if (f.activeXpScroll) parts.push(`XP Scroll (queued)`);
    return parts.join(' • ');
}
