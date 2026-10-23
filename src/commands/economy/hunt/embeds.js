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
    msUntilNextStamina,
    xpToNextLevel
} = require('../../../services/huntService');
const { TIER_NUM, TIER_RIBBON, TIER_STARS } = require('../../../data/materialRarity');
const { EmbedBuilder } = require('discord.js');
const { randomFrom, HUNT_EMPTY_LINES } = require('../../../utils/copyLines');
const { buildPityStreakField, PITY_COPY } = require('../../../utils/pityBonus');
const { FEATURED_PAYOUT_BONUS } = require('../../../data/featuredRotation');
const { WILDERNESS_YIELD_BONUS } = require('./shared');
const COLORS = require('../../../utils/embedColors');

// ─── THE RESULT CARD ──────────────────────────────────────────────────────────
//
// Read top to bottom, the card answers four questions in the order a player
// asks them: what did I get, what was it worth, why, and can I go again.
//
//   author       the zone — the same header every beat of the encounter wore
//   title        the animal, graded (crit, trophy quality, headline tier)
//   description  tier ribbon and flavour, then the payout / XP line and the
//                multiplier stack; the caller appends the run's own chips
//                (approach, shot, featured zone) and the pet's line
//   fields       only what happened this time — traits, a drop, a level-up,
//                the daily toll, one "Heads Up" for anything that needs doing —
//                and last the Kit: weapon, stamina, ammo, balance, level, pity
//                and a live countdown to the next hunt.
//
// It used to be sixteen-odd fields of equal weight, most of them status that
// never changed between hunts, with the reward in the fourth box of a grid.

const tsRel = date => `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>`;

function sceneAuthor(zone, discordUser) {
    const author = { name: `${zone.emoji} ${zone.name}` };
    const icon = discordUser?.displayAvatarURL?.();
    if (icon) author.iconURL = icon;
    return author;
}

/**
 * When this hunter can next head out — the cooldown, an injury, or an empty
 * stamina bar, whichever lifts last. Returns { ready, at, reason }.
 */
function nextHuntReadiness(user, now = Date.now()) {
    const h = user.hunt;
    const cooldownAt = h.lastHunt ? new Date(h.lastHunt).getTime() + LIMITS.HUNT_COOLDOWN_MS : 0;
    const injuryAt   = h.injuryUntil ? new Date(h.injuryUntil).getTime() : 0;
    let staminaAt = 0;
    if ((h.stamina ?? 0) <= 0) {
        try { staminaAt = now + msUntilNextStamina(user); } catch { staminaAt = 0; }
    }
    const at = Math.max(cooldownAt, injuryAt, staminaAt);
    if (at <= now) return { ready: true, at: null, reason: null };
    const reason = at === staminaAt ? 'stamina' : at === injuryAt ? 'injury' : 'cooldown';
    return { ready: false, at: new Date(at), reason };
}

function buildReadinessLine(user, now = Date.now()) {
    const next = nextHuntReadiness(user, now);
    if (next.ready) return '🏹 Ready to head back out';
    if (next.reason === 'injury')  return `🤕 Injured — back on your feet ${tsRel(next.at)}`;
    if (next.reason === 'stamina') return `😮‍💨 Out of stamina — next point ${tsRel(next.at)}`;
    return `⏱️ Next hunt ${tsRel(next.at)}`;
}

function pityState(user, zone) {
    const sinceRare = user.hunt.sinceRare ?? 0;
    const threshold = getRarePityThreshold(zone);
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
    return { sinceRare, threshold, heat, label };
}

/** The status block every result ends on — the things that carry over to the next hunt. */
function buildKitField(user, weapon, zone, currency, now = Date.now()) {
    const h = user.hunt;
    const lines = [];

    lines.push(`🔫 **${weapon.name}** ${weaponStatusEmoji(weapon.status)} \`${durabilityBar(weapon.currentDurability, weapon.maxDurability)}\` ${weapon.currentDurability}/${weapon.maxDurability}`);

    const ammo = ammoContext(user, weapon);
    lines.push(`⚡ ${h.stamina}/${getMaxStamina(user)} stamina${ammo ? ` · ${ammo.emoji} ${ammo.label} ×${ammo.remaining}` : ''}`);

    const toNext = xpToNextLevel(h.level, h.xp);
    const levelPart = toNext === null ? `Lv ${h.level} (MAX)` : `Lv ${h.level} — ${toNext.toLocaleString()} XP to Lv ${h.level + 1}`;
    lines.push(`${currency}${(user.balance ?? 0).toLocaleString()} · 📊 ${levelPart}`);

    if ((h.sinceRare ?? 0) >= 5) {
        const p = pityState(user, zone);
        lines.push(`${p.heat} Rare pity ${p.sinceRare}/${p.threshold} — ${p.label}`);
    }

    lines.push(buildReadinessLine(user, now));
    return { name: '🎒 Kit', value: lines.join('\n'), inline: false };
}

/**
 * Everything on this result that asks the player to do something, in one
 * place: a broken or worn weapon, the last rounds of ammo, a buff that ran out.
 * Null when there is nothing to say.
 */
function buildHeadsUpField(result, user, weapon, { includeBroken = true } = {}) {
    const lines = [];
    if (weapon.status === 'broken') {
        if (includeBroken) lines.push(`❌ ${buildBrokenWeaponNote(weapon)}`);
    } else if (weapon.currentDurability <= Math.floor(weapon.maxDurability * 0.20)) {
        lines.push(`🔧 Your **${weapon.name}** is nearly worn out (${weapon.currentDurability}/${weapon.maxDurability}) — repair soon.`);
    }
    const lowAmmo = buildLowAmmoField(user, weapon);
    if (lowAmmo) lines.push(`${ammoContext(user, weapon).emoji} ${lowAmmo.value}`);
    if (result.expiredBait)  lines.push(`🪱 Your ${result.expiredBait.replace(/_/g, ' ')} has worn off.`);
    if (result.expiredCharm) lines.push(`🍀 Your luck charm has worn off.`);
    return lines.length ? { name: '⚠️ Heads Up', value: lines.join('\n'), inline: false } : null;
}

function buildTraitsField(traits, traitEffects) {
    if (!traits?.length && !traitEffects?.length) return null;
    const lines = [];
    if (traits?.length) {
        lines.push(traits.map(t => {
            const def = ANIMAL_TRAITS[t];
            return def ? `${def.emoji} **${def.name}**` : t;
        }).join('  '));
    }
    for (const e of traitEffects ?? []) lines.push(`• ${e.msg}`);
    return { name: '🧬 Traits', value: lines.join('\n'), inline: false };
}

/** "🔥 1.50x × ⚡ 2.00x crit × 🟢 1.20x = 3.60x", or null for a flat kill. */
function buildMultiplierLine(result) {
    const { isCrit, critMultiplier, trophyQuality } = result;
    const streak = result.streakMult ?? 1;
    const parts = [];
    if (streak > 1.0) parts.push(`🔥 ${streak.toFixed(2)}x`);
    if (isCrit)       parts.push(`⚡ ${critMultiplier.toFixed(2)}x crit`);
    if (trophyQuality && trophyQuality.multiplier > 1.0) parts.push(`${trophyQuality.emoji} ${trophyQuality.multiplier.toFixed(2)}x`);
    if (!parts.length) return null;
    const combined = streak * (isCrit ? critMultiplier : 1) * (trophyQuality?.multiplier ?? 1);
    return `📈 ${parts.join(' × ')} = **${combined.toFixed(2)}x**`;
}

function buildHuntEmbed(result, user, zone, weapon, currency, discordUser, { now = Date.now() } = {}) {
    if (result.success) {
        const { animal, tier, traits, finalPayout, isCrit, trophyQuality, specialDrop, xpEarned, levelUp, cappedByHard, traitEffects } = result;
        // An event catch keeps its own colour even on a critical: the tier is the
        // rarer fact of the two, and the title already announces it as one.
        const color = tier === 'event' ? TIER_COLORS.event : isCrit ? '#FFD700' : TIER_COLORS[tier];

        const tierLabel  = tier.charAt(0).toUpperCase() + tier.slice(1);
        const tierNum    = TIER_NUM[tier] ?? 1;
        const isEvent    = tier === 'event';
        const isHeadline = tierNum >= 5;   // legendary and event both get the full treatment
        const ribbon = `${TIER_RIBBON(tierNum)}  **${tierLabel}**`;

        // The headline keeps the animal in the title — it is the trophy.
        const embedTitle = isHeadline
            ? `${isEvent ? '☄️ MYTHICAL' : '🌟 LEGENDARY'} — ${animal.emoji} ${isCrit ? 'CRITICAL! ' : ''}${animal.name}`
            : `${animal.emoji} ${isCrit ? '✨ CRITICAL! ' : ''}${trophyQuality ? trophyQuality.label + ' ' : ''}${animal.name}`;
        const headlineLede = isEvent
            ? 'Something walked out of the treeline that has no business existing.'
            : 'You found something impossible in the wild.';
        const story = isHeadline
            ? `${ribbon}\n\n${headlineLede}\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n  ${animal.emoji}  **${animal.name}**  [${TIER_STARS[tierNum]}]\n  *${animal.flavor}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━`
            : `${ribbon}\n*${animal.flavor}*`;

        const coins = cappedByHard
            ? `~~${currency}${(result.forfeitedPayout ?? 0).toLocaleString()}~~ *Daily cap reached — resets in ${formatMs(msUntilDailyReset(user))}*`
            : `**+${currency}${finalPayout.toLocaleString()}**`;
        const xp = `✨ **+${xpEarned} XP**${isCrit ? ' (crit bonus)' : ''}`;
        const grade = trophyQuality ? `${trophyQuality.emoji} ${trophyQuality.label} trophy` : null;
        const rewardLine = [coins, xp, grade].filter(Boolean).join('  ·  ');
        const multLine = buildMultiplierLine(result);

        const embed = new EmbedBuilder()
            .setColor(color)
            .setAuthor(sceneAuthor(zone, discordUser))
            .setTitle(embedTitle)
            .setDescription([story, '', rewardLine, multLine].filter(v => v !== null).join('\n'));

        const traitsField = buildTraitsField(traits, traitEffects);
        if (traitsField) embed.addFields(traitsField);

        if (specialDrop) {
            embed.addFields({ name: '🎁 Special Drop!', value: `You found **${specialDrop.name}**!`, inline: true });
        }
        if (levelUp) {
            const ld = getLevelData(levelUp.newLevel);
            embed.addFields({ name: '⬆️ Level Up!', value: `Hunter Level **${levelUp.oldLevel}** → **${levelUp.newLevel}** (${ld.title})`, inline: true });
        }

        const dailyToll = buildDailyTollField(result, user, currency);
        if (dailyToll) embed.addFields(dailyToll);

        const headsUp = buildHeadsUpField(result, user, weapon);
        if (headsUp) embed.addFields(headsUp);

        embed.addFields(buildKitField(user, weapon, zone, currency, now));

        const buffs = buildActiveConsumablesLine(user);
        if (buffs !== 'No active buffs') embed.setFooter({ text: `Active: ${buffs}` });
        embed.setTimestamp();
        return embed;
    }

    const { failure, xpEarned, levelUp, animal: failAnimal, traits: failTraits, traitEffects: failTraitEffects } = result;
    const story = failAnimal
        ? `*Encountered: ${failAnimal.emoji} **${failAnimal.name}***\n${failure.message}`
        : `*${failure.severity.id === 'clean_miss' ? randomFrom(HUNT_EMPTY_LINES) : failure.message}*`;
    const outcomeLine = [
        '💨 No reward',
        xpEarned > 0 ? `✨ +${xpEarned} XP` : 'No XP',
        result.staminaSpared ? '*clean miss — no stamina spent*' : null,
    ].filter(Boolean).join('  ·  ');

    const embed = new EmbedBuilder()
        .setColor(COLORS.ERROR)
        .setAuthor(sceneAuthor(zone, discordUser))
        .setTitle(buildFailureTitle(failure.severity.id))
        .setDescription(`${story}\n\n${outcomeLine}`);

    if ((user.hunt.consecutiveFails ?? 0) > 0) {
        embed.addFields(buildPityStreakField(user.hunt.consecutiveFails, LIMITS, PITY_COPY.hunt));
    }

    const traitsField = buildTraitsField(failTraits, failTraitEffects);
    if (traitsField) embed.addFields(traitsField);

    if (failure.severity.injuryMs > 0) {
        embed.addFields({ name: '🤕 Injured', value: `Extra cooldown: **${formatMs(failure.severity.injuryMs)}**`, inline: true });
    }

    if (result.deathEvent) {
        if (result.deathEvent.saved) {
            embed.setColor('#e67e22');
            embed.addFields({ name: '🛟 Lifesaver Activated!', value: `A catastrophic encounter would have destroyed your **${result.deathEvent.weaponName}**, but your Lifesaver absorbed it! (consumed)`, inline: false });
        } else {
            embed.setColor('#8B0000');
            // A wrecked weapon, not a wounded hunter: the event breaks the gun
            // and sets no injury timer, so it is not called one.
            embed.addFields({
                name: '💀 Catastrophe!',
                value: isCondemned(weapon)
                    ? `The encounter went badly wrong — your **${result.deathEvent.weaponName}** was wrecked outright, and it's condemned: too many shop repairs have worn it out, so it can't be fixed. Replace it with \`/hunt shop weapon\`.`
                    : `The encounter went badly wrong — your **${result.deathEvent.weaponName}** was wrecked outright! Use \`/hunt shop repair\` to fix it.`,
                inline: false
            });
        }
    }

    if (levelUp) {
        const ld = getLevelData(levelUp.newLevel);
        embed.addFields({ name: '⬆️ Level Up!', value: `Hunter Level **${levelUp.oldLevel}** → **${levelUp.newLevel}** (${ld.title})`, inline: false });
    }

    const headsUp = buildHeadsUpField(result, user, weapon, { includeBroken: !result.deathEvent });
    if (headsUp) embed.addFields(headsUp);

    embed.addFields(buildKitField(user, weapon, zone, currency, now));

    embed.setFooter({ text: 'Tip: consumables from /hunt shop raise your odds' });
    embed.setTimestamp();
    return embed;
}

// Discord refuses a message outright — not the one embed, the whole edit — past
// 25 fields in an embed or 6,000 characters across every embed it carries. An
// apex duel sends the result card and the duel card together, so the budget is
// the pair's. Rather than lose the result to an exception, the least important
// fields go first; the Kit, the payout and anything the player was just given
// are last to go.
const EMBED_MAX_FIELDS = 25;
const MESSAGE_MAX_CHARS = 6000;
const FIELD_DROP_ORDER = ['🧬 Traits', '✨ Bonuses', '⚖️ Daily Limits', '⚠️ Heads Up', '🎒 Kit'];

function embedLength(embed) {
    const d = embed.data ?? embed;
    return (d.title?.length ?? 0) + (d.description?.length ?? 0)
        + (d.footer?.text?.length ?? 0) + (d.author?.name?.length ?? 0)
        + (d.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
}

function fitEmbeds(embeds) {
    const total = () => embeds.reduce((n, e) => n + embedLength(e), 0);
    const dropOne = () => {
        for (const name of FIELD_DROP_ORDER) {
            for (const e of embeds) {
                const idx = (e.data.fields ?? []).findIndex(f => f.name === name);
                if (idx >= 0) { e.data.fields.splice(idx, 1); return true; }
            }
        }
        // Nothing named is left: drop the last field of the largest embed.
        const withFields = embeds.filter(e => e.data.fields?.length);
        if (!withFields.length) return false;
        withFields.sort((a, b) => embedLength(b) - embedLength(a))[0].data.fields.pop();
        return true;
    };
    for (const e of embeds) {
        while ((e.data.fields?.length ?? 0) > EMBED_MAX_FIELDS) e.data.fields.pop();
    }
    while (total() > MESSAGE_MAX_CHARS && dropOne()) { /* keep trimming */ }
    return embeds;
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

    lines.push(`*Worth ${currency}${report.grossPayout.toLocaleString()} on a fresh day — ${currency}${report.lostToDaily.toLocaleString()} withheld. Resets in ${formatMs(msUntilDailyReset(user))}.*`);

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
    const { sinceRare, threshold, heat, label } = pityState(user, zone);
    const filled     = Math.min(sinceRare, threshold);
    const barLen     = 16;
    const filledLen  = Math.round((filled / threshold) * barLen);
    const bar        = '█'.repeat(filledLen) + '░'.repeat(barLen - filledLen);
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
    buildHeadsUpField,
    buildHuntEmbed,
    buildKitField,
    buildLowAmmoField,
    buildMultiplierLine,
    buildReadinessLine,
    buildTraitsField,
    nextHuntReadiness,
    sceneAuthor,
    buildPityField,
    buildProgressBar,
    buildStaminaLine,
    buildXpBar,
    buildXpLine,
    fitEmbeds,
    formatBonuses,
    formatExpiry,
};
