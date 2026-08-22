'use strict';

// Every embed, field and progress bar /mine renders. Pure functions of their
// arguments: they read no database and touch no interaction.

const { TIER_COLORS, LIMITS, MINER_LEVELS } = require('../../../data/mineData');
const { TIER_NUM, TIER_RIBBON, TIER_STARS } = require('../../../data/materialRarity');
const { EmbedBuilder } = require('discord.js');
const {
    pickaxeStatusEmoji,
    durabilityBar,
    getLevelData,
    formatMs,
    msUntilDailyReset,
    getMaxStamina,
    xpToNextLevel
} = require('../../../services/mineService');
const { FEATURED_PAYOUT_BONUS } = require('../../../data/featuredRotation');
const { stackBar } = require('../../../utils/rewardReveal');
const { buildPityStreakField, PITY_COPY } = require('../../../utils/pityBonus');
const { WILDERNESS_YIELD_BONUS } = require('./shared');

function prestigeBonusLines(bonus) {
    return [
        bonus.critBonus    > 0 ? `+${Math.round(bonus.critBonus * 100)}% crit chance`   : null,
        bonus.staminaBonus > 0 ? `+${bonus.staminaBonus} max stamina`                   : null,
        bonus.payoutBonus  > 0 ? `+${Math.round(bonus.payoutBonus * 100)}% all payouts` : null,
        bonus.rarityBonus  > 0 ? `+${Math.round(bonus.rarityBonus * 100)}% rarity boost`: null,
    ].filter(Boolean);
}

// ─── EMBED BUILDERS / HELPERS ─────────────────────────────────────────────────

function buildMineEmbed(result, user, depth, pickaxe, currency, _discordUser) {
    if (result.success) {
        const { ore, tier, finalPayout, isCrit, critMultiplier, specialDrop, xpEarned, levelUp, cappedByHard } = result;
        // An event catch keeps its own colour even on a critical: the tier is the
        // rarer fact of the two, and the title already announces it as one. Without
        // this a critical event drop rendered crit-gold under a MYTHICAL headline.
        const color = tier === 'event' ? TIER_COLORS.event : isCrit ? '#FFD700' : TIER_COLORS[tier];

        const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
        // At the hard cap finalPayout is already 0, so the old strikethrough rendered
        // as "~~0~~ (daily cap reached)" — it struck out the wrong number and never
        // told the player what the cap had actually cost them.
        const payoutDisplay = cappedByHard
            ? `~~${currency}${(result.forfeited ?? 0).toLocaleString()}~~ → **${currency}0**`
            : `**${currency}${finalPayout.toLocaleString()}**`;

        const tierNum  = TIER_NUM[tier] ?? 1;
        const isEvent  = tier === 'event';
        const isHeadline = tierNum >= 5;   // legendary and event both get the full treatment
        const ribbon = TIER_RIBBON(tierNum);
        const embedTitle = isHeadline
            ? (isEvent ? `☄️🌋 PRIMORDIAL STRIKE 🌋☄️` : `⛏️✨ LEGENDARY STRIKE ✨⛏️`)
            : `${ore.emoji} ${isCrit ? '✨ CRITICAL! ' : ''}${ore.name} ${isCrit ? '✨' : ''}`;
        const headlineLede = isEvent
            ? 'You broke into something that should not be down there.'
            : 'You struck something impossible in the deep.';
        const embedDesc = isHeadline
            ? `${ribbon}\n\n${headlineLede}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  ${ore.emoji}  **${ore.name}**  [${TIER_STARS[tierNum]}]\n  *${ore.flavor}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nAdded to your inventory.`
            : `${ribbon}\n\n*${ore.flavor}*`;

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

        // Every multiplicative factor that touched this haul, so the arithmetic on
        // screen reconciles. This used to list streak and crit, multiply just those
        // two, and then print the *final* payout — which also carried the intensity
        // multiplier (up to 3x), the featured depth, the pet, the district and the
        // Artificer bonus. Players saw "2.52x → +1,340" when the real stack was 5x.
        const mineMultEntries = [];
        let mineCombined = 1;
        const addMult = (emoji, label, factor) => {
            if (!(factor > 0) || Math.abs(factor - 1) < 0.005) return;
            mineMultEntries.push({ emoji, label });
            mineCombined *= factor;
        };

        const intensityMult = result.caveIn && !result.caveInBonusPaid ? 1 : (result.intensityLevel?.multiplier ?? 1);
        addMult('🔥', `${(result.streakMult ?? 1).toFixed(2)}x`, result.streakMult ?? 1);
        addMult('⚡', `${critMultiplier.toFixed(2)}x crit`, critMultiplier);
        addMult(result.intensityLevel?.emoji ?? '⛏️', `${intensityMult.toFixed(2)}x depth`, intensityMult);
        addMult('🌟', `${(1 + FEATURED_PAYOUT_BONUS).toFixed(2)}x featured`, result.featuredDepthBonus > 0 ? 1 + FEATURED_PAYOUT_BONUS : 1);
        addMult('💎', `${(1 + (result.petYieldPct ?? 0) / 100).toFixed(2)}x pet`, result.petYieldBonus > 0 ? 1 + (result.petYieldPct ?? 0) / 100 : 1);
        addMult('🌲', `${(1 + WILDERNESS_YIELD_BONUS).toFixed(2)}x district`, result.wildernessBonus > 0 ? 1 + WILDERNESS_YIELD_BONUS : 1);
        addMult('⚒️', `${(1 + (result.artificerRate ?? 0)).toFixed(2)}x artificer`, 1 + (result.artificerRate ?? 0));
        addMult('✨', '2.00x yield', result.gatheringYield ? 2 : 1);

        if (mineMultEntries.length > 0 && finalPayout > 0) {
            // What the stack itself contributed: the haul, less what a flat 1x roll of
            // the same ore would have paid.
            const stackGain = Math.max(0, finalPayout - Math.round(finalPayout / mineCombined));
            embed.addFields({ name: '📈 Multipliers', value: stackBar(mineMultEntries, mineCombined, stackGain, currency), inline: false });
        }

        if (result.gatheringYield) {
            const { label, emoji, chargesLeft } = result.gatheringYield;
            embed.addFields({
                name: `${emoji} ${label}`,
                value: `Payout doubled · ${chargesLeft > 0 ? `${chargesLeft} charge${chargesLeft === 1 ? '' : 's'} left` : '**last charge**'}`,
                inline: false,
            });
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

        const throttleField = buildThrottleField(user, result, currency);
        if (throttleField) embed.addFields(throttleField);

        embed.addFields(
            { name: 'Balance',   value: `${currency}${user.balance.toLocaleString()}`,   inline: true },
            { name: 'Miner XP',  value: buildXpLine(user),                               inline: true }
        );
        embed.setFooter({ text: `Cooldown: 30s • ${buildDailyProgressLine(user, currency)} • ${buildActiveConsumablesLine(user)}` });
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
            {
                name: 'Stamina',
                value: result.staminaSpared
                    ? `${buildStaminaLine(user)}\n*Empty vein — no stamina spent*`
                    : buildStaminaLine(user),
                inline: true
            }
        );

    if ((user.mining.consecutiveFails ?? 0) > 0) {
        embed.addFields(buildPityStreakField(user.mining.consecutiveFails, LIMITS, PITY_COPY.mining));
    }

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

function buildThrottleField(user, result, currency) {
    const m       = user.mining;
    const resetIn = msUntilDailyReset(user);
    const resetNote = resetIn == null ? '' : ` Resets in **${formatMs(resetIn)}**.`;

    if (result.cappedByHard) {
        return {
            name: '🛑 Daily Cap Reached',
            value: `You've earned the daily maximum of ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()}. `
                 + `This haul paid nothing.${resetNote}\nXP, materials and quest progress still count.`,
            inline: false,
        };
    }

    const notes = [];
    if (result.softCapped) {
        notes.push(`💰 Past ${currency}${LIMITS.DAILY_SOFT_CAP.toLocaleString()} today — **payouts are halved** until the window resets.`);
    }
    if ((result.fatigueMult ?? 1) < 1) {
        notes.push(`😪 **${m.dailyMines}** digs today — **fatigue** has payouts at **${Math.round(result.fatigueMult * 100)}%**.`);
    }
    if (!notes.length) return null;

    if (result.forfeited > 0) {
        notes.push(`This dig gave up ${currency}${result.forfeited.toLocaleString()}.${resetNote}`);
    } else if (resetNote) {
        notes.push(resetNote.trim());
    }

    return { name: '⏳ Daily Throttle', value: notes.join('\n'), inline: false };
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

function buildDailyProgressLine(user, currency) {
    const earned = user.mining.dailyCoins ?? 0;
    const compact = n => n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`;
    return `Today: ${currency}${compact(earned)}/${compact(LIMITS.DAILY_SOFT_CAP)}`;
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

module.exports = {
    buildActiveConsumablesLine,
    buildDailyProgressLine,
    buildFailureTitle,
    buildMineEmbed,
    buildProgressBar,
    buildStaminaLine,
    buildThrottleField,
    buildXpBar,
    buildXpLine,
    formatExpiry,
    prestigeBonusLines,
};
