'use strict';

// Every embed, field and progress bar /hunt renders. Pure functions of their
// arguments: they read no database and touch no interaction.

const { TIER_COLORS, ANIMAL_TRAITS, LIMITS, WEAPON_BY_TIER, AMMO_PACKS, HUNTER_LEVELS } = require('../../../data/huntData');
const {
    formatMs,
    msUntilDailyReset,
    weaponStatusEmoji,
    durabilityBar,
    getLevelData,
    isCondemned,
    getRarePityThreshold,
    getMaxStamina,
    xpToNextLevel
} = require('../../../services/huntService');
const { TIER_NUM, TIER_RIBBON, TIER_STARS } = require('../../../data/materialRarity');
const { EmbedBuilder } = require('discord.js');
const { stackBar } = require('../../../utils/rewardReveal');
const { randomFrom, HUNT_EMPTY_LINES } = require('../../../utils/copyLines');
const { buildPityStreakField, PITY_COPY } = require('../../../utils/pityBonus');
const { FEATURED_PAYOUT_BONUS } = require('../../../data/featuredRotation');
const { WILDERNESS_YIELD_BONUS } = require('./shared');

function buildHuntEmbed(result, user, zone, weapon, currency, _discordUser) {
    const h = user.hunt;

    if (result.success) {
        const { animal, tier, traits, finalPayout, isCrit, critMultiplier, trophyQuality, specialDrop, xpEarned, levelUp, cappedByHard, traitEffects } = result;
        // An event catch keeps its own colour even on a critical: the tier is the
        // rarer fact of the two, and the title already announces it as one. Without
        // this a critical event drop rendered crit-gold under a MYTHICAL headline.
        const color = tier === 'event' ? TIER_COLORS.event : isCrit ? '#FFD700' : TIER_COLORS[tier];

        const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
        const payoutDisplay = cappedByHard
            ? `~~${currency}${(result.forfeitedPayout ?? 0).toLocaleString()}~~\n*Daily cap reached — resets in ${formatMs(msUntilDailyReset(h))}*`
            : `**${currency}${finalPayout.toLocaleString()}**`;

        const qualityLabel = trophyQuality
            ? `${trophyQuality.emoji} **${trophyQuality.label}** (×${trophyQuality.multiplier.toFixed(2)})`
            : '—';

        const tierNum    = TIER_NUM[tier] ?? 1;
        const isEvent    = tier === 'event';
        const isHeadline = tierNum >= 5;   // legendary and event both get the full treatment
        const ribbon = TIER_RIBBON(tierNum);
        const embedTitle = isHeadline
            ? (isEvent ? `☄️⚡ MYTHICAL FIND ⚡☄️` : `🌟✨ LEGENDARY FIND ✨🌟`)
            : `${animal.emoji} ${isCrit ? '✨ CRITICAL! ' : ''}${trophyQuality ? trophyQuality.label + ' ' : ''}${animal.name}${isCrit ? ' ✨' : ''}`;
        const headlineLede = isEvent
            ? 'Something walked out of the treeline that has no business existing.'
            : 'You found something impossible in the wild.';
        const embedDesc = isHeadline
            ? `${ribbon}\n\n${headlineLede}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  ${animal.emoji}  **${animal.name}**  [${TIER_STARS[tierNum]}]\n  *${animal.flavor}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n\nAdded to your inventory.`
            : `${ribbon}\n\n*${animal.flavor}*`;

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(embedTitle)
            .setDescription(embedDesc)
            .addFields(
                { name: 'Zone',     value: `${zone.emoji} ${zone.name}`,         inline: true },
                { name: 'Tier',     value: `${tierLabel}`,                        inline: true },
                { name: 'Quality',  value: qualityLabel,                          inline: true },
                { name: 'Reward',   value: payoutDisplay,                         inline: true },
                { name: 'XP',       value: `+${xpEarned} XP${isCrit ? ' (crit bonus)' : ''}`, inline: true },
                { name: 'Weapon',   value: `${weapon.name} ${weaponStatusEmoji(weapon.status)}\n${durabilityBar(weapon.currentDurability, weapon.maxDurability)} ${weapon.currentDurability}/${weapon.maxDurability}`, inline: true },
                { name: 'Stamina',  value: buildStaminaLine(user),                inline: true }
            );

        const ammoField = buildAmmoField(user, weapon);
        if (ammoField) embed.addFields(ammoField);

        const huntMultEntries = [];
        if ((result.streakMult ?? 1) > 1.0) huntMultEntries.push({ emoji: '🔥', label: `${(result.streakMult).toFixed(2)}x` });
        if (isCrit)                          huntMultEntries.push({ emoji: '⚡', label: `${critMultiplier.toFixed(2)}x crit` });
        if (trophyQuality && trophyQuality.multiplier > 1.0) huntMultEntries.push({ emoji: trophyQuality.emoji, label: `${trophyQuality.multiplier.toFixed(2)}x` });
        if (huntMultEntries.length > 0) {
            const combined = (result.streakMult ?? 1) * critMultiplier * (trophyQuality?.multiplier ?? 1);
            embed.addFields({ name: '📈 Multipliers', value: stackBar(huntMultEntries, combined, finalPayout, currency), inline: false });
        }

        if (traits && traits.length > 0) {
            const traitLine = traits.map(t => {
                const def = ANIMAL_TRAITS[t];
                return def ? `${def.emoji} **${def.name}**` : t;
            }).join('  ');
            embed.addFields({ name: '🧬 Traits', value: traitLine, inline: false });
        }

        if (traitEffects && traitEffects.length > 0) {
            const effectLines = traitEffects.map(e => `• ${e.msg}`).join('\n');
            embed.addFields({ name: '⚡ Trait Effects', value: effectLines, inline: false });
        }

        const dailyToll = buildDailyTollField(result, user, currency);
        if (dailyToll) embed.addFields(dailyToll);

        if (specialDrop) {
            embed.addFields({ name: '🎁 Special Drop!', value: `You found **${specialDrop.name}**!`, inline: false });
        }

        if (levelUp) {
            const ld = getLevelData(levelUp.newLevel);
            embed.addFields({ name: '⬆️ Level Up!', value: `Hunter Level **${levelUp.oldLevel}** → **${levelUp.newLevel}** (${ld.title})`, inline: false });
        }

        const expiredBuffs = [];
        if (result.expiredBait)  expiredBuffs.push(`🪱 Your ${result.expiredBait.replace(/_/g, ' ')} has worn off.`);
        if (result.expiredCharm) expiredBuffs.push(`🍀 Your luck charm has worn off.`);
        if (expiredBuffs.length) {
            embed.addFields({ name: 'Buffs Expired', value: expiredBuffs.join('\n'), inline: false });
        }

        if (weapon.status === 'broken') {
            embed.addFields({ name: '⚠️ Weapon Broke!', value: buildBrokenWeaponNote(weapon), inline: false });
        } else if (weapon.currentDurability <= Math.floor(weapon.maxDurability * 0.20)) {
            embed.addFields({ name: '⚠️ Low Durability', value: `Your **${weapon.name}** is nearly worn out (${weapon.currentDurability}/${weapon.maxDurability}). Repair soon!`, inline: false });
        }

        const lowAmmoField = buildLowAmmoField(user, weapon);
        if (lowAmmoField) embed.addFields(lowAmmoField);

        const balanceLine = `${currency}${user.balance.toLocaleString()}`;
        const xpLine = buildXpLine(user);
        embed.addFields({ name: 'Balance', value: balanceLine, inline: true }, { name: 'Hunter XP', value: xpLine, inline: true });

        const sinceRareNow = user.hunt.sinceRare ?? 0;
        if (sinceRareNow >= 5) embed.addFields(buildPityField(user, zone));

        embed.setFooter({ text: `Cooldown: 45s • ${buildActiveConsumablesLine(user)}` });
        embed.setTimestamp();
        return embed;
    }

    const { failure, xpEarned, levelUp, animal: failAnimal, traits: failTraits, traitEffects: failTraitEffects } = result;
    const embed = new EmbedBuilder()
        .setColor('#e74c3c')
        .setTitle(buildFailureTitle(failure.severity.id))
        .setDescription(failAnimal ? `*Encountered: ${failAnimal.emoji} **${failAnimal.name}***\n${failure.message}` : `*${failure.severity.id === 'clean_miss' ? randomFrom(HUNT_EMPTY_LINES) : failure.message}*`)
        .addFields(
            { name: 'Zone',    value: `${zone.emoji} ${zone.name}`,  inline: true },
            { name: 'Reward',  value: 'Nothing',                      inline: true },
            { name: 'XP',      value: xpEarned > 0 ? `+${xpEarned} XP` : 'None', inline: true },
            { name: 'Weapon',  value: `${weapon.name} ${weaponStatusEmoji(weapon.status)}\n${durabilityBar(weapon.currentDurability, weapon.maxDurability)} ${weapon.currentDurability}/${weapon.maxDurability}`, inline: true },
            {
                name: 'Stamina',
                value: result.staminaSpared
                    ? `${buildStaminaLine(user)}\n*Clean miss — no stamina spent*`
                    : buildStaminaLine(user),
                inline: true
            }
        );

    const failAmmoField = buildAmmoField(user, weapon);
    if (failAmmoField) embed.addFields(failAmmoField);

    if ((user.hunt.consecutiveFails ?? 0) > 0) {
        embed.addFields(buildPityStreakField(user.hunt.consecutiveFails, LIMITS, PITY_COPY.hunt));
    }

    if (failTraits && failTraits.length > 0) {
        const traitLine = failTraits.map(t => {
            const def = ANIMAL_TRAITS[t];
            return def ? `${def.emoji} **${def.name}**` : t;
        }).join('  ');
        embed.addFields({ name: '🧬 Traits', value: traitLine, inline: false });
    }

    if (failTraitEffects && failTraitEffects.length > 0) {
        const effectLines = failTraitEffects.map(e => `• ${e.msg}`).join('\n');
        embed.addFields({ name: '⚡ Trait Effects', value: effectLines, inline: false });
    }

    if (failure.severity.injuryMs > 0) {
        embed.addFields({ name: '🤕 Injured', value: `Extra cooldown: **${formatMs(failure.severity.injuryMs)}**`, inline: true });
    }

    if (result.deathEvent) {
        if (result.deathEvent.saved) {
            embed.setColor('#e67e22');
            embed.addFields({ name: '🛟 Lifesaver Activated!', value: `A severe injury would have destroyed your **${result.deathEvent.weaponName}**, but your Lifesaver absorbed it! (consumed)`, inline: false });
        } else {
            embed.setColor('#8B0000');
            embed.addFields({
                name: '💀 Severe Injury!',
                value: isCondemned(weapon)
                    ? `The encounter was catastrophic — your **${result.deathEvent.weaponName}** was wrecked outright, and it's condemned: too many shop repairs have worn it out, so it can't be fixed. Replace it with \`/hunt shop weapon\`.`
                    : `The encounter was catastrophic — your **${result.deathEvent.weaponName}** was wrecked outright! Use \`/hunt shop repair\` to fix it.`,
                inline: false
            });
        }
    }

    if (levelUp) {
        const ld = getLevelData(levelUp.newLevel);
        embed.addFields({ name: '⬆️ Level Up!', value: `Hunter Level **${levelUp.oldLevel}** → **${levelUp.newLevel}** (${ld.title})`, inline: false });
    }

    if (weapon.status === 'broken' && !result.deathEvent) {
        embed.addFields({ name: '❌ Weapon Broke!', value: buildBrokenWeaponNote(weapon), inline: false });
    }

    const failLowAmmoField = buildLowAmmoField(user, weapon);
    if (failLowAmmoField) embed.addFields(failLowAmmoField);

    const sinceRareNow = user.hunt.sinceRare ?? 0;
    if (sinceRareNow >= 5) embed.addFields(buildPityField(user, zone));

    embed.setFooter({ text: 'Tip: Use consumables from /hunt shop to boost your success chance' });
    embed.setTimestamp();
    return embed;
}

function buildBonusLines(result, petYieldPct, petXpPct) {
    const lines = [];

    if (result.gatheringYield) {
        const { label, emoji, chargesLeft } = result.gatheringYield;
        lines.push(`${emoji} **${label}** — payout doubled · ${
            chargesLeft > 0
                ? `${chargesLeft} charge${chargesLeft === 1 ? '' : 's'} left`
                : '**last charge**'
        }`);
    }
    if (result.petYieldBonus > 0) {
        lines.push(`🐺 **Pet** — +${result.petYieldBonus.toLocaleString()} coins (${petYieldPct}% yield)`);
    }
    if (result.petXpBonus > 0) {
        lines.push(`🦅 **Pet** — +${result.petXpBonus.toLocaleString()} XP (${petXpPct}%)`);
    }
    if (result.featuredZoneBonus > 0) {
        lines.push(`🌟 **Featured Zone** — +${result.featuredZoneBonus.toLocaleString()} coins (+${Math.round(FEATURED_PAYOUT_BONUS * 100)}%)`);
    }
    if (result.wildernessBonus > 0) {
        lines.push(`🌲 **Wilderness District** — +${result.wildernessBonus.toLocaleString()} coins (+${Math.round(WILDERNESS_YIELD_BONUS * 100)}% yield)`);
    }

    return lines;
}

function buildDailyTollField(result, user, currency) {
    const report = result.dailyReport;
    if (!report || report.lostToDaily <= 0) return null;

    const h = user.hunt;
    const lines = [];

    if (report.dimReturns) {
        const pct = Math.round((1 - report.dimReturns.multiplier) * 100);
        lines.push(`📉 **Diminishing returns** −${pct}% · ${h.dailyHunts} hunts today (past ${report.dimReturns.threshold})`
            + (report.dimReturns.nextAt
                ? `\n> Drops again at ${report.dimReturns.nextAt} hunts.`
                : ''));
    }
    if (report.softCapped) {
        lines.push(`🪙 **Daily soft cap** −50% · past ${currency}${LIMITS.DAILY_SOFT_CAP.toLocaleString()} earned today`);
    }
    if (report.headroomClamped) {
        lines.push(`🧱 **Hard cap in sight** — only ${currency}${Math.max(0, LIMITS.DAILY_HARD_CAP - h.dailyCoins).toLocaleString()} of headroom left`);
    }

    lines.push(`*Worth ${currency}${report.grossPayout.toLocaleString()} on a fresh day — ${currency}${report.lostToDaily.toLocaleString()} withheld. Resets in ${formatMs(msUntilDailyReset(h))}.*`);

    return { name: '⚖️ Daily Limits', value: lines.join('\n'), inline: false };
}

function buildBrokenWeaponNote(weapon) {
    return isCondemned(weapon)
        ? `Your **${weapon.name}** has broken, and it's condemned — too many shop repairs have worn it out, so it can't be fixed. Replace it with \`/hunt shop weapon\`.`
        : `Your **${weapon.name}** has broken! Use \`/hunt shop repair\` before hunting again.`;
}

function buildFailureTitle(severityId) {
    return { clean_miss: '💨 Miss!', spooked: '😰 Spooked!', jammed: '🔧 Jammed!', injured: '🤕 Injured!' }[severityId] ?? '❌ Failed Hunt';
}

// Heat bands as a fraction of the zone's own threshold — the numbers used to be
// hardcoded against a flat 50, which no longer holds now that each zone sets its
// own.
const PITY_HOT_FRACTION  = 0.80;

const PITY_WARM_FRACTION = 0.50;

function buildPityField(user, zone) {
    const sinceRare  = user.hunt.sinceRare ?? 0;
    const threshold  = getRarePityThreshold(zone);
    const filled     = Math.min(sinceRare, threshold);
    const barLen     = 16;
    const filledLen  = Math.round((filled / threshold) * barLen);
    const bar        = '█'.repeat(filledLen) + '░'.repeat(barLen - filledLen);

    let heat, label;
    if (sinceRare >= threshold) {
        heat  = '⚡';
        label = `**GUARANTEED NEXT HUNT**`;
    } else if (sinceRare >= threshold * PITY_HOT_FRACTION) {
        heat  = '🔥';
        label = `Getting hot — ~${threshold - sinceRare} more`;
    } else if (sinceRare >= threshold * PITY_WARM_FRACTION) {
        heat  = '🌡️';
        label = `Warming up — ~${threshold - sinceRare} more`;
    } else {
        heat  = '❄️';
        label = `~${threshold - sinceRare} more for guaranteed Rare+`;
    }

    return { name: `${heat} Rare Pity: ${sinceRare}/${threshold}`, value: `\`${bar}\`\n${label}`, inline: false };
}

function buildStaminaLine(user) {
    const h   = user.hunt;
    const max = getMaxStamina(user);
    return `${h.stamina}/${max} ⚡`;
}

// A hunt spends three consumables: durability, stamina, and — from T2 up — a
// round of ammo. The first two have always been on the result embed; ammo was
// only ever surfaced as the ephemeral refusal on the *next* hunt, after the
// cooldown had already been claimed. These two fields give it the same
// treatment durability gets: a running count on every result, and a warning
// naming the pack to buy before the well runs dry mid-session.
const AMMO_LOW_THRESHOLD = 5;

function ammoContext(user, weapon) {
    const weaponData = WEAPON_BY_TIER[weapon.tier];
    if (!weaponData?.requiresAmmo) return null;
    const pack = AMMO_PACKS.find(p => p.ammoType === weaponData.ammoType);
    return {
        remaining: user.hunt.ammo?.[weaponData.ammoType] ?? 0,
        label: weaponData.ammoType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        emoji: pack?.emoji ?? '🔶',
        packName: pack?.name ?? weaponData.ammoType.replace(/_/g, ' '),
    };
}

function buildAmmoField(user, weapon) {
    const ammo = ammoContext(user, weapon);
    if (!ammo) return null;
    return { name: 'Ammo', value: `${ammo.emoji} ${ammo.label} ×${ammo.remaining}`, inline: true };
}

function buildLowAmmoField(user, weapon) {
    const ammo = ammoContext(user, weapon);
    if (!ammo || ammo.remaining > AMMO_LOW_THRESHOLD) return null;
    const value = ammo.remaining <= 0
        ? `That was your last **${ammo.label}** round! Buy **${ammo.packName}** with \`/hunt shop buy\` before your next hunt.`
        : `Only **${ammo.remaining}** ${ammo.label} round${ammo.remaining === 1 ? '' : 's'} left. Stock up on **${ammo.packName}** with \`/hunt shop buy\`.`;
    return { name: '⚠️ Low Ammo', value, inline: false };
}

function buildXpLine(user) {
    const h   = user.hunt;
    const toNext = xpToNextLevel(h.level, h.xp);
    if (toNext === null) return `${h.xp.toLocaleString()} XP (MAX)`;
    return `${h.xp.toLocaleString()} XP (${toNext} to Lv.${h.level + 1})`;
}

function buildActiveConsumablesLine(user) {
    const h = user.hunt;
    const parts = [];
    if (h.activeBait)  parts.push(`Bait (${h.activeBaitHuntsLeft} hunts left)`);
    if (h.activeCharm) parts.push(`Charm (${h.activeCharmHuntsLeft} hunts left)`);
    if (h.activeFocus) parts.push(`Focus (queued)`);
    if (h.activeXpScroll) parts.push(`XP Scroll (queued)`);
    return parts.length ? parts.join(' • ') : 'No active buffs';
}

function buildXpBar(h, toNext) {
    if (toNext === null) return '████████████████████ MAX';
    const currentLevelXp = HUNTER_LEVELS[h.level - 1]?.xpRequired ?? 0;
    const nextLevelXp    = HUNTER_LEVELS[h.level]?.xpRequired ?? 1;
    const denominator    = nextLevelXp - currentLevelXp;
    const progress       = denominator > 0 ? (h.xp - currentLevelXp) / denominator : 0;
    const filled         = Math.min(20, Math.max(0, Math.round(progress * 20)));
    const pct            = Math.min(100, Math.max(0, Math.round(progress * 100)));
    return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${pct}%`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRESTIGE (was /huntprestige)
// ═══════════════════════════════════════════════════════════════════════════════

function formatBonuses(bonus) {
    const lines = [];
    if (bonus.critBonus    > 0) lines.push(`+${Math.round(bonus.critBonus    * 100)}% crit chance`);
    if (bonus.staminaBonus > 0) lines.push(`+${bonus.staminaBonus} max stamina`);
    if (bonus.payoutBonus  > 0) lines.push(`+${Math.round(bonus.payoutBonus  * 100)}% all payouts`);
    if (bonus.rarityBonus  > 0) lines.push(`+${Math.round(bonus.rarityBonus  * 100)}% rarity boost`);
    return lines.length ? lines.join('\n') : 'None';
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
    AMMO_LOW_THRESHOLD,
    PITY_HOT_FRACTION,
    PITY_WARM_FRACTION,
    ammoContext,
    buildActiveConsumablesLine,
    buildAmmoField,
    buildBonusLines,
    buildBrokenWeaponNote,
    buildDailyTollField,
    buildFailureTitle,
    buildHuntEmbed,
    buildLowAmmoField,
    buildPityField,
    buildProgressBar,
    buildStaminaLine,
    buildXpBar,
    buildXpLine,
    formatBonuses,
    formatExpiry,
};
