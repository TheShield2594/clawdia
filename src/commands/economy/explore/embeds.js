'use strict';

// Everything /explore go says about an expedition once it is over: the result
// embed, the one-line journal summary, and the secret-odds readouts. Split out
// of go.js so the command file is the expedition's flow — claim, roll, save,
// pay — and this one is how it reads (the same split hunt/embeds.js makes).
//
// The result embed has one job: say what happened. The haul, a level crossed,
// the cap biting, and an overdue secret are shown when they are true on this
// run; the rest (standing bonuses, stamina, next trip) rides one line each.

const { EmbedBuilder } = require('discord.js');
const {
    LIMITS, TIER_COLORS, REGION_LIST, FOOTER_LINES, INJURY_LINES,
} = require('../../../data/exploreData');
const { TIER_STARS } = require('../../../data/materialRarity');
const { SEASONAL_EVENTS } = require('../../../data/seasonalEvents');
const { FEATURED_PAYOUT_BONUS } = require('../../../data/featuredRotation');
const {
    getMaxStamina, msUntilNextStamina, getRegionProgress, isRegionEnabled,
    getRelicBonus, getSecretOdds, randomFrom, formatMs, resolveRoute, getLiveStreak,
} = require('../../../services/exploreService');
const { petCompanionLine } = require('../../../services/petService');
const COLORS = require('../../../utils/embedColors');
const { EXPLORE_COLORS } = require('./shared');

// A dry run of fewer than this many expeditions is ordinary luck, not a
// drought, and does not earn a line on the result. Past it, the pity curve is
// the thing a player wants to see — that it is climbing, and how far.
const PITY_SHOW_AFTER = 10;

const INJURY_NOTE = `(${Math.round(LIMITS.INJURY_PENALTY_MS / 60_000)} min)`;

function summarizeResult(result, currency) {
    // Once the daily cap bites, payouts land at zero — say so rather than
    // logging a triumphant haul of nothing.
    const haul = result.payout > 0
        ? `${currency}${result.payout.toLocaleString()}`
        : result.cappedByDailyCap ? 'nothing the daily cap would let you keep' : `${currency}0`;

    switch (result.type) {
        case 'discovery': return result.anomaly
            ? `Investigated ${result.anomaly.name}`
            : `Charted ${result.landmark.name}`;
        case 'lore':      return `Recovered a lore fragment`;
        case 'secret':    return `Uncovered the secret: ${result.secret.name}`;
        case 'treasure':  return `${result.relic ? `Recovered ${result.relic.itemId} and ` : ''}hauled ${haul} in treasure`;
        case 'trap':      return `Sprang ${result.trap.name} (−${currency}${(result.penalty ?? 0).toLocaleString()})`;
        case 'encounter': return result.outcome === 'win'
            ? `Faced ${result.encounter.name} and came out ahead`
            : result.outcome === 'safe'
                ? `Watched ${result.encounter.name} from a respectful distance`
                : `Faced ${result.encounter.name} and paid the tuition`;
        default:          return 'A long, quiet walk';
    }
}

/**
 * "It's been N expeditions since your last secret" is only true while the
 * region still HAS a secret to give. Once it's fully uncovered, saying it is
 * a promise nothing can keep, so say something honest instead.
 */
function secretTeaser(user, region, guildSettings, route = null) {
    if (!region) return 'The map never fills itself in.';
    const odds = getSecretOdds(user, region, getRegionProgress(user, region.id), guildSettings, route);
    if (odds.exhausted) {
        return `${region.name} has nothing left to hide from you. Other maps still do.`;
    }
    if (odds.sinceSecret >= PITY_SHOW_AFTER) {
        return `It's been ${odds.sinceSecret} expeditions since your last secret — the odds are up to ${(odds.chance * 100).toFixed(1)}% and still climbing.`;
    }
    return 'The map never fills itself in.';
}

/**
 * Where the player sits on the secret curve, once a drought is long enough to
 * be worth saying. Without it the pity system is invisible and a dry run just
 * looks like bad luck with no reason to believe it lets up; shown on every
 * run, it was a bar that said "0.0% overdue" under most results.
 */
function buildSecretPityField(user, region, guildSettings, route = null) {
    const odds = getSecretOdds(user, region, getRegionProgress(user, region.id), guildSettings, route);
    if (odds.exhausted || odds.sinceSecret < PITY_SHOW_AFTER) return null;

    const barLen = 16;
    const ratio  = Math.min(1, odds.pity / LIMITS.SECRET_PITY_MAX);
    const bar    = '█'.repeat(Math.round(ratio * barLen)) + '░'.repeat(barLen - Math.round(ratio * barLen));
    const maxed  = odds.pity >= LIMITS.SECRET_PITY_MAX;
    const lift   = odds.chance / odds.baseChance;
    const via    = route ? ` by the ${route.name}` : '';

    return {
        name: `✨ Something's Overdue — ${odds.sinceSecret} expeditions dry`,
        value: `\`${bar}\`\n**${(odds.chance * 100).toFixed(1)}% secret chance** next time out${via} `
             + `— ×${lift.toFixed(2)} the base rate${maxed ? ' *(max)*' : ', climbing with every dry run'}.`,
        inline: false,
    };
}

/**
 * The standing bonuses that lifted this run's coins, as one line. Only said on
 * a run that paid — on a trap or a quiet walk they multiplied nothing.
 */
function standingBonusLine(result, user) {
    if (!(result.payout > 0)) return null;
    const boosts = [];
    const route = result.route ? resolveRoute(result.route) : null;
    if (route?.payoutBonus) {
        const pct = Math.round(route.payoutBonus * 100);
        boosts.push(`${route.emoji} ${route.name.toLowerCase()} ${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`);
    }
    if (result.streakBonus > 0) boosts.push(`🔥 streak +${Math.round(result.streakBonus * 100)}%`);
    if (result.featured) boosts.push(`🌟 featured +${Math.round(FEATURED_PAYOUT_BONUS * 100)}%`);
    if (result.surveyed) boosts.push(`🏅 surveyed +${Math.round(LIMITS.SURVEY_BONUS * 100)}%`);
    const relicBonus = getRelicBonus(user);
    if (relicBonus > 0) boosts.push(`🏺 relics +${Math.round(relicBonus * 100)}%`);
    return boosts.length ? `📈 ${boosts.join(' · ')}` : null;
}

/**
 * @param {object} opts
 * @param {string}  opts.currency
 * @param {object}  [opts.eventDrop]
 * @param {number}  [opts.mainXp]
 * @param {boolean} [opts.firstVisit]
 * @param {object}  [opts.guildSettings]
 * @param {object}  [opts.weeklyLeader]
 * @param {boolean} [opts.unsaved] - the run's second write failed: what it
 *        carried (journal, quests, server XP) is named as not recorded
 * @param {string}  [opts.intro] - the setting-out line, for a run that skipped
 *        the staged "Setting out" beat and so has not shown it yet
 */
function buildResultEmbed(result, region, user, {
    currency, eventDrop = null, mainXp = 0, firstVisit = false, guildSettings = null, weeklyLeader = null, unsaved = false, intro = null,
} = {}) {
    const e = user.exploration;
    const route = result.route ? resolveRoute(result.route) : null;
    // The "Setting out — <region>" embed is edited away by this one, so without
    // an author line the message a player scrolls back to never says where any
    // of this happened. The titles below are landmark and creature names; only
    // the embed colour hinted at the region, which is not something you can read.
    const embed = new EmbedBuilder()
        .setAuthor({ name: `${region.emoji} ${region.name}${route ? ` · ${route.emoji} ${route.name}` : ''}` })
        .setTimestamp();
    const lines = [];
    if (intro) lines.push(`-# ${intro}`, '');

    switch (result.type) {
        case 'discovery':
            if (result.anomaly) {
                embed.setColor(region.color).setTitle(`${result.anomaly.emoji} Anomaly — ${result.anomaly.name}`);
                lines.push(`*${result.anomaly.line}*`);
            } else {
                embed.setColor(region.color).setTitle(`🗿 Landmark Charted — ${result.landmark.name}`);
                lines.push(`*${result.landmark.line}*`);
            }
            break;
        case 'lore':
            embed.setColor(COLORS.RARE).setTitle('📜 Lore Fragment Recovered');
            lines.push(`*You find words someone meant to be found:*`, '', `> ${result.lore.text}`);
            if (result.loreCompleted) {
                lines.push('', `📖 *That's every fragment ${region.name} had. You know its story now — and its locals can tell. Approaches here win **+${Math.round(LIMITS.ENCOUNTER_LORE_BONUS * 100)}%** more often.*`);
            }
            break;
        case 'secret':
            embed.setColor(COLORS.PRIZE).setTitle(`✨ SECRET UNCOVERED — ${result.secret.name}`);
            lines.push(`*${result.secret.reveal}*`);
            break;
        case 'treasure': {
            const tier = result.treasureTier;
            embed.setColor(TIER_COLORS[tier.tier] ?? region.color)
                .setTitle(`🪙 Treasure — ${tier.tier.charAt(0).toUpperCase() + tier.tier.slice(1)} ${tier.stars}`);
            lines.push(`*${result.treasureLine}*`);
            if (result.relic) {
                const relicHome = !result.relicOwed  // only claim it's in the bag once the grant landed (#873)
                    ? `> It's in your \`/inventory\` now, and in \`/explore relics\`, where it earns its keep.`
                    : `> ⚠️ It couldn't be added to your \`/inventory\` just now${result.relicOwed === 'owed' ? " and has been recorded as owed — it'll appear once the problem clears. Tell an admin if it doesn't." : ' or recorded — please contact a server admin.'}`;
                lines.push('', `🏺 **Relic recovered: ${result.relic.itemId}**${result.relicIsNew ? ' — *new to your case*' : ''}`, `> *${result.relic.lore}*`, relicHome);
            }
            if (result.material) {
                lines.push(
                    '',
                    `${result.material.emoji} **Fieldcraft: ${result.material.label}** — ${TIER_STARS[result.material.tier]}`,
                    `> Packed away with the rest of your kit. \`/inventory\` has it under **Explore**, and a companion will eat it.`,
                );
            }
            break;
        }
        case 'trap':
            embed.setColor(EXPLORE_COLORS.TRAP).setTitle(`🪤 Trap — ${result.trap.name}`);
            lines.push(`*${result.trap.line}*`);
            if (result.injured) lines.push('', `🤕 *${randomFrom(INJURY_LINES)}* ${INJURY_NOTE}`);
            break;
        case 'encounter': {
            const enc = result.encounter;
            if (result.outcome === 'win') {
                embed.setColor(COLORS.SUCCESS).setTitle(`${enc.emoji} ${enc.name} — Well Played`);
                lines.push(`*${enc.winLine}*`);
            } else if (result.outcome === 'safe') {
                embed.setColor(region.color).setTitle(`${enc.emoji} ${enc.name} — Watched From the Ferns`);
                // A timeout resolves as keeping your distance. Say so, rather
                // than presenting a choice the player never made as theirs.
                if (result.hesitated) lines.push('*You hesitated. The ferns decided for you.*', '');
                lines.push(`*${enc.safeLine}*`);
            } else {
                embed.setColor(EXPLORE_COLORS.LOSS).setTitle(`${enc.emoji} ${enc.name} — That Went Differently`);
                lines.push(`*${enc.loseLine}*`);
                if (result.injured) lines.push('', `🤕 *${randomFrom(INJURY_LINES)}* ${INJURY_NOTE}`);
            }
            break;
        }
        default:
            embed.setColor(COLORS.NEUTRAL).setTitle('🌫️ A Quiet Expedition');
            lines.push(`*${result.quietLine}*`);
            break;
    }

    if (firstVisit) {
        lines.push('', `🗺️ **New region charted: ${region.emoji} ${region.name}** — it has a place on your map now. So do its blank spaces.`);
    }

    if (result.regionCompleted) {
        lines.push(
            '',
            `🏅 **${region.emoji} ${region.name} — fully surveyed.**`,
            `Every landmark, every fragment, every secret. There is nothing left in this region that you haven't stood in front of.`,
            `Everything it pays you from here carries a standing **+${Math.round(result.surveyBonus * 100)}%**. The map keeps its debts.`,
        );
    }

    const streakNews = streakLine(result);
    if (streakNews) lines.push('', streakNews);

    const petLine = petCompanionLine(user?.pets, 'explore');
    if (petLine) lines.push('', petLine);

    embed.setDescription(lines.join('\n'));

    const gains = [];
    if (result.payout > 0) {
        gains.push(`+${currency}${result.payout.toLocaleString()}`);
    } else if (result.cappedByDailyCap && result.grossPayout > 0) {
        // Don't render a legendary haul with a blank coin line and no reason.
        gains.push(`~~+${currency}${result.grossPayout.toLocaleString()}~~ *(daily cap)*`);
    }
    if (result.payout > 0 && result.cappedByDailyCap) {
        gains.push(`*(trimmed from ${currency}${result.grossPayout.toLocaleString()} — daily cap)*`);
    }
    if (result.penalty > 0) gains.push(`−${currency}${result.penalty.toLocaleString()}`);
    if (result.xp > 0)      gains.push(`+${result.xp} Explorer XP${result.petXp > 0 ? ` *(🦉 +${result.petXp})*` : ''}`);
    if (mainXp > 0)         gains.push(`+${mainXp} XP`);
    if (eventDrop) {
        const def = Object.values(SEASONAL_EVENTS).find(s => s.currency?.id === eventDrop.currencyId);
        const dropLabel = `${eventDrop.amount} ${def?.currency?.emoji ?? '🎟️'} ${def?.currency?.name ?? eventDrop.currencyId}`;
        // Only announce the drop as gained once the credit landed (#873, pass 13).
        if (!eventDrop.owed) gains.push(`+${dropLabel}`);
        else gains.push(`~~+${dropLabel}~~ *(${eventDrop.owed === 'owed' ? 'owed' : 'not delivered'})*`);
    }
    if (gains.length) {
        const bonusLine = standingBonusLine(result, user);
        embed.addFields({ name: '🎒 The Haul', value: [gains.join('  ·  '), bonusLine].filter(Boolean).join('\n'), inline: false });
    }

    // Crossing an explorer level is the only thing that opens new regions, so it
    // gets said out loud — and if the new level actually put one within reach,
    // it gets named. Seasonal regions are left out: the calendar gates those,
    // not the level, so promising one here would be a promise about the weather.
    if (result.explorerLevelUp) {
        const lift = result.explorerLevelUp;
        const liftLines = [`Explorer Level **${lift.oldLevel}** → **${lift.newLevel}** — *${lift.newTitle}*`];
        const opened = REGION_LIST.filter(r =>
            !r.seasonalEventId
            && isRegionEnabled(r, guildSettings)
            && !e.unlockedRegions.includes(r.id)
            && r.unlockLevel > lift.oldLevel
            && r.unlockLevel <= lift.newLevel);
        for (const opening of opened) {
            liftLines.push(
                `🔓 **${opening.emoji} ${opening.name}** is within reach — `
                + `\`/explore travel\` opens the route for ${currency}${opening.unlockCost.toLocaleString()}.`
            );
        }
        embed.addFields({ name: '⬆️ Level Up!', value: liftLines.join('\n'), inline: false });
    }

    if (result.hardCapped) {
        embed.addFields({
            name: '🧾 Daily Cap Reached',
            value: `You've banked ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()} from exploring in the last 24 hours, which is where the coins stop. `
                 + `Expeditions still chart the map and still pay Explorer XP — the wilds just stop paying cash until the window rolls over.`,
            inline: false,
        });
    } else if (result.softCapped) {
        embed.addFields({
            name: '🧾 Past the Soft Cap',
            value: `You're over ${currency}${LIMITS.DAILY_SOFT_CAP.toLocaleString()} for the last 24 hours, so hauls settle at `
                 + `**${Math.round(LIMITS.DAILY_SOFT_CAP_RATE * 100)}%** from here — down to ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()}, `
                 + `where they stop entirely. Charting and Explorer XP are untouched.`,
            inline: false,
        });
    }

    // Pity curve — only on runs that didn't turn up the secret
    if (result.type !== 'secret') {
        const pityField = buildSecretPityField(user, region, guildSettings, route);
        if (pityField) embed.addFields(pityField);
    }

    if (unsaved) {
        embed.addFields({
            name: '⚠️ Not Everything Was Written Down',
            value: 'The find above is yours and its coins are paid, but the rest of this run — its journal entry, quest progress and server XP — '
                 + "couldn't be saved. Your next expedition isn't affected.",
            inline: false,
        });
    }

    // The weekly race is only news on a run that entered it. Everywhere else
    // the footer keeps its flavour line — it used to show the leader on every
    // run once anyone had scored, and the flavour lines were never seen again.
    const staminaNote = result.staminaSpared ? ' *(a blank walk costs no stamina)*' : '';
    const liveStreak = getLiveStreak(user);
    const streakNote = liveStreak > 0 ? ` · 🔥 ${liveStreak}-run streak` : '';
    const leaderNote = weeklyLeader && result.payout > 0
        ? `👑 Explorer of the Week so far: ${weeklyLeader.username} — ${currency}${(weeklyLeader.total ?? 0).toLocaleString()} recovered`
        : randomFrom(FOOTER_LINES);
    embed.setFooter({ text: `⚡ ${e.stamina}/${getMaxStamina(user)} stamina${staminaNote}${streakNote} · ${nextExpeditionNote(user)}\n${leaderNote}` });
    return embed;
}

/**
 * What this run did to the streak, when it is news: it ended, it went cold
 * before the run began, or it just reached the most it can pay. A streak that
 * simply ticked up is in the footer, not the story.
 */
function streakLine(result) {
    if (result.streakBroken) {
        return `💥 **Streak over** — your ${result.streakBroken}-run trail sense is gone. The wilds were counting too.`;
    }
    const lines = [];
    if (result.streakCooled) {
        lines.push(`🌫️ *The trail went cold while you were away — your ${result.streakCooled}-run streak reset.*`);
    }
    if (result.streak === LIMITS.STREAK_MAX) {
        lines.push(`🔥 **Trail sense maxed** — ${LIMITS.STREAK_MAX} runs clean, **+${Math.round(LIMITS.STREAK_MAX * LIMITS.STREAK_BONUS_PER * 100)}%** on every haul while it lasts.`);
    }
    return lines.join('\n') || null;
}

/**
 * When they can set out again — every other detail of the run is on the embed
 * except the one thing that decides what they do next. Whichever gate is further
 * out wins: an injury outlasts the cooldown by minutes, and quoting the cooldown
 * while a trap has them sitting down would be a lie with a countdown on it.
 */
function nextExpeditionNote(user) {
    const e = user.exploration;
    const now = Date.now();
    const cooldownLeft = e.lastExplore ? (e.lastExplore.getTime() + LIMITS.EXPLORE_COOLDOWN_MS) - now : 0;
    const injuryLeft   = e.injuryUntil ? e.injuryUntil.getTime() - now : 0;

    if (injuryLeft > cooldownLeft && injuryLeft > 0) return `🤕 walking again in ${formatMs(injuryLeft)}`;
    if (e.stamina <= 0) {
        const staminaLeft = msUntilNextStamina(user);
        if (staminaLeft > cooldownLeft) return `😮‍💨 stamina back in ${formatMs(staminaLeft)}`;
    }
    if (cooldownLeft > 0) return `🥾 ready in ${formatMs(cooldownLeft)}`;
    return '🥾 ready now';
}

module.exports = {
    PITY_SHOW_AFTER,
    buildResultEmbed,
    buildSecretPityField,
    nextExpeditionNote,
    streakLine,
    secretTeaser,
    summarizeResult,
};
