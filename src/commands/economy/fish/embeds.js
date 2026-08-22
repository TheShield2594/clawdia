'use strict';

// Every embed and progress bar /fish renders. Pure functions of their
// arguments: they read no database and touch no interaction, so a handler can
// build a reply without this file knowing which handler asked.

const { EmbedBuilder } = require('discord.js');
const { TIER_COLORS, FISH_TRAITS, LIMITS, getTimeOfDay, TIME_OF_DAY_BONUSES, FISHER_LEVELS } = require('../../../data/fishData');
const { TIER_RIBBON, TIER_NUM, TIER_STARS } = require('../../../data/materialRarity');
const { getCurrentWeather } = require('../../../services/weatherService');
const { stackBar } = require('../../../utils/rewardReveal');
const { buildPityStreakField, PITY_COPY } = require('../../../utils/pityBonus');
const { formatMs, rodStatusEmoji, durabilityBar, getMaxStamina, xpToNextLevel, getLevelData } = require('../../../services/fishService');

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
        // An event catch keeps its own colour even on a critical: the tier is the
        // rarer fact of the two, and the title already announces it as one. Without
        // this a critical event drop rendered crit-gold under a MYTHICAL headline.
        const color = tier === 'event' ? TIER_COLORS.event : isCrit ? '#FFD700' : TIER_COLORS[tier];
        const tierLabel  = tier.charAt(0).toUpperCase() + tier.slice(1);
        const weightStr  = result.weightLbs > 0 ? ` (${result.weightLbs} lbs)` : '';
        const sizeStr    = sizeLabel ? ` [${sizeLabel}${weightStr}]` : '';
        const payDisplay = cappedByHard
            ? `~~${currency}${finalPayout}~~ (daily cap)`
            : `**${currency}${finalPayout.toLocaleString()}**`;

        const isLegendary = tier === 'legendary';
        const isEvent     = tier === 'event';
        const isEpic      = tier === 'epic';
        const ribbon = TIER_RIBBON(TIER_NUM[tier] ?? 1);

        // Weather banner — surfaced only when active weather gives a bonus at this location
        const weather      = getCurrentWeather();
        const weatherNote  = buildWeatherNote(weather, location.id);
        const weatherBanner = weatherNote ? `> ${weatherNote}\n\n` : '';

        // Tier-specific title decoration — each rarity bracket has a distinct visual
        // signature. Event outranks legendary, so it is checked first, and both sit
        // ahead of the crit decoration: a critical event catch is still an event catch.
        const embedTitle = isEvent
            ? `☄️🌊 MYTHICAL CATCH 🌊☄️`
            : isLegendary
            ? `🌊✨ LEGENDARY CATCH ✨🌊`
            : isCrit
            ? `${fish.emoji} ✨ CRITICAL! ${fish.name}${sizeStr} ✨`
            : isEpic
            ? `⚡ ${fish.emoji} ${fish.name}${sizeStr} ⚡`
            : `${fish.emoji} ${fish.name}${sizeStr}`;

        // Tier-specific description — escalates in drama with rarity
        const headlineStars = TIER_STARS[TIER_NUM[tier] ?? 5];
        const embedDesc = isEvent
            ? `${weatherBanner}${ribbon}\n\nSomething that shouldn't exist rises from below.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  ${fish.emoji}  **${fish.name}**${sizeStr}  [${headlineStars}]\n  *${fish.flavor}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nAdded to your inventory.`
            : isLegendary
            ? `${weatherBanner}${ribbon}\n\nYou pulled something impossible from the deep.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  ${fish.emoji}  **${fish.name}**${sizeStr}  [${headlineStars}]\n  *${fish.flavor}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nAdded to your inventory.`
            : isEpic
            ? `${weatherBanner}${ribbon}\n\nAn exceptional catch that tests every fibre of your rod.\n\n*${fish.flavor}*`
            : `${weatherBanner}${ribbon}\n\n*${fish.flavor}*`;

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

        const fishMultEntries = [];
        if ((result.streakMult ?? 1) > 1.0) fishMultEntries.push({ emoji: '🔥', label: `${(result.streakMult).toFixed(2)}x` });
        if (isCrit)                          fishMultEntries.push({ emoji: '⚡', label: `${critMultiplier.toFixed(2)}x crit` });
        if (fishMultEntries.length > 0) {
            const fishCombined  = (result.streakMult ?? 1) * critMultiplier;
            const preBonusPayout = finalPayout - (result.petYieldBonus ?? 0) - (result.featuredSpotBonus ?? 0) - (result.wildernessBonus ?? 0);
            embed.addFields({ name: '📈 Multipliers', value: stackBar(fishMultEntries, fishCombined, Math.max(0, preBonusPayout), currency), inline: false });
        }

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
            {
                name: 'Stamina',
                value: result.staminaSpared
                    ? `${buildStaminaLine(user)}\n*Slack line — no stamina spent*`
                    : buildStaminaLine(user),
                inline: true
            }
        );

    if ((user.fishing.consecutiveFails ?? 0) > 0) {
        embed.addFields(buildPityStreakField(user.fishing.consecutiveFails, LIMITS, PITY_COPY.fishing));
    }

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

// Returns a one-line weather effect note when the weather grants a bonus at the given location.
// Returns null when the current weather has no effect at this location.
function buildWeatherNote(weather, locationId) {
    const bonus = weather.locationBonus?.[locationId];
    if (!bonus) return null;
    if (bonus.rareChance)      return `${weather.emoji} **${weather.name}** — fish are biting harder *(+rare chance)*`;
    if (bonus.legendaryChance) return `${weather.emoji} **${weather.name}** — something stirs beneath the surface *(+legendary chance)*`;
    if (bonus.epicChance)      return `${weather.emoji} **${weather.name}** — ocean predators are active in this weather *(+epic chance)*`;
    if (bonus.mythicalChance)  return `${weather.emoji} **${weather.name}** — ancient creatures are drawn upward by the light *(+event chance)*`;
    if (bonus.junkMod)         return `${weather.emoji} **${weather.name}** — fish have retreated from the heat *(junk chance up)*`;
    return `${weather.emoji} **${weather.name}**`;
}

function buildXpBar(f, toNext) {
    if (toNext === null) return '████████████████████ MAX';
    const nextLevelXp = FISHER_LEVELS[f.level]?.xpRequired ?? 1;
    const progress    = nextLevelXp > 0 ? Math.min(1, f.xp / nextLevelXp) : 0;
    const filled      = Math.min(20, Math.max(0, Math.round(progress * 20)));
    const pct         = Math.min(100, Math.max(0, Math.round(progress * 100)));
    return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${pct}%`;
}

function formatPrestigeBonuses(bonus) {
    const lines = [];
    if (bonus.critBonus    > 0) lines.push(`+${Math.round(bonus.critBonus    * 100)}% crit chance`);
    if (bonus.staminaBonus > 0) lines.push(`+${bonus.staminaBonus} max stamina`);
    if (bonus.payoutBonus  > 0) lines.push(`+${Math.round(bonus.payoutBonus  * 100)}% all payouts`);
    if (bonus.rarityBonus  > 0) lines.push(`+${Math.round(bonus.rarityBonus  * 100)}% rarity boost`);
    return lines.length ? lines.join('\n') : 'None';
}

function buildQuestProgressBar(current, total, length) {
    const filled = Math.min(length, Math.max(0, Math.round((current / Math.max(1, total)) * length)));
    return `[${'█'.repeat(filled)}${'░'.repeat(length - filled)}]`;
}

function formatTierWeights(weights) {
    const total = Object.values(weights).reduce((s, v) => s + v, 0);
    return Object.entries(weights)
        .filter(([, w]) => w > 0)
        .map(([tier, w]) => `${tier} ${Math.round((w / total) * 100)}%`)
        .join(', ');
}

module.exports = {
    buildCastEmbed,
    buildFailureTitle,
    buildFooter,
    buildLevelUpLine,
    buildQuestProgressBar,
    buildRodLine,
    buildStaminaLine,
    buildWeatherNote,
    buildXpBar,
    buildXpLine,
    formatPrestigeBonuses,
    formatTierWeights,
};
