'use strict';

// /explore profile — a wanderer's explorer profile: rank, XP, stamina, standing
// bonuses, the field record, and where the road goes next.

const { EmbedBuilder, MessageFlags } = require('discord.js');
const {
    LIMITS, EXPLORER_LEVELS, REGIONS, REGION_LIST,
    RELIC_LIST, PRESTIGE_BADGES, MAX_EXPLORER_PRESTIGE,
} = require('../../../data/exploreData');
const {
    ensureExploreData, getMaxStamina, applyStaminaRegen, applyDailyReset,
    msUntilNextStamina, xpToNextLevel, isRegionEnabled,
    getRelicBonus, getRelicCapacity, getExplorerPrestige, getExplorerTitle, formatMs,
} = require('../../../services/exploreService');
const { progressBar } = require('../../../utils/progressBar');
const { loadReadContext, surveyedCount, prestigeBonusLines } = require('./shared');

async function handleProfile(interaction) {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const isSelf = target.id === interaction.user.id;

    const ctx = await loadReadContext(interaction, target);
    if (!ctx) return;
    const { user: userData, guildSettings, currency } = ctx;

    if (!userData?.exploration?.totalExpeditions) {
        return interaction.reply({
            content: isSelf
                ? 'You haven\'t set out yet. The wilds have noticed. `/explore go` settles the matter.'
                : `${target.username} hasn't set a single boot past the gate yet.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    ensureExploreData(userData);
    if (isSelf) applyStaminaRegen(userData);
    // Read-only, but the daily footer should reflect a window that has already
    // rolled over rather than yesterday's numbers.
    applyDailyReset(userData);

    const e = userData.exploration;
    const toNext = xpToNextLevel(e.level, e.xp);
    const prestigeRank  = Math.max(0, Number(e.prestige) || 0);
    const prestigeBadge = PRESTIGE_BADGES[Math.min(prestigeRank, PRESTIGE_BADGES.length - 1)] ?? '';
    const activeRegion = REGIONS[e.activeRegion];
    const nextThreshold = EXPLORER_LEVELS.find(l => l.level === e.level + 1)?.xpRequired;

    const maxStam = getMaxStamina(userData);
    const stamBar = '⚡'.repeat(e.stamina) + '▪️'.repeat(Math.max(0, maxStam - e.stamina));
    const regenMs = msUntilNextStamina(userData);

    const embed = new EmbedBuilder()
        .setColor(activeRegion?.color ?? '#2e7d32')
        .setTitle(`🧭 ${target.username}'s Explorer Profile`)
        .setThumbnail(target.displayAvatarURL({ dynamic: true }))
        .addFields(
            {
                name: '🥾 Rank',
                value: `**${getExplorerTitle(userData)}** (Level ${e.level})`
                     + (prestigeRank > 0 ? `\n${prestigeBadge} **Prestige ${prestigeRank}**` : ''),
                inline: true,
            },
            {
                name: '⭐ Explorer XP',
                value: toNext !== null
                    ? `${e.xp.toLocaleString()} / ${nextThreshold.toLocaleString()} XP\n${progressBar(e.xp, nextThreshold, 12)}\n${toNext.toLocaleString()} to Level ${e.level + 1}`
                    // Level 30 is no longer the end of the road, so the profile
                    // points at the road rather than declaring a dead end (#750).
                    : `${e.xp.toLocaleString()} XP — **MAX LEVEL**`
                        + (prestigeRank < MAX_EXPLORER_PRESTIGE
                            ? `\n${isSelf ? '`/explore prestige` to ascend' : 'ready to ascend'}`
                            : '\n*the last rank there is*'),
                inline: true,
            },
            {
                name: '🗺️ Active Region',
                value: activeRegion ? `${activeRegion.emoji} ${activeRegion.name}` : 'Unknown',
                inline: true,
            },
            {
                name: '⚡ Stamina',
                value: `${stamBar}\n${e.stamina}/${maxStam}${e.stamina < maxStam ? `\nNext regen: ${formatMs(regenMs)}` : '\nFull!'}`,
                inline: true,
            },
            {
                name: '💰 Balance',
                value: `${currency}${userData.balance.toLocaleString()}`,
                inline: true,
            },
            {
                name: '📊 Field Record',
                value: [
                    `Expeditions:     **${e.totalExpeditions.toLocaleString()}**`,
                    `Total Earned:    **${currency}${e.totalEarned.toLocaleString()}**`,
                    `Best Haul:       **${currency}${e.bestHaul.toLocaleString()}**`,
                    `Secrets Found:   **${e.secretsFound}**`,
                    `Relics:          **${e.relicsRecovered}**`,
                    `Regions Surveyed:**${surveyedCount(userData, guildSettings)}**`,
                    `Traps Sprung:    **${e.trapsSprung}** *(we don't judge here. much.)*`,
                ].join('\n'),
                inline: false,
            }
        )
        .setTimestamp();

    const relicBonus = getRelicBonus(userData);
    const surveyed = surveyedCount(userData, guildSettings);
    const prestigeRow = getExplorerPrestige(userData);
    if (relicBonus > 0 || surveyed > 0 || prestigeRank > 0) {
        const boosts = [];
        if (surveyed > 0)   boosts.push(`🏅 **+${Math.round(LIMITS.SURVEY_BONUS * 100)}%** in ${surveyed} fully surveyed region${surveyed === 1 ? '' : 's'}`);
        if (relicBonus > 0) {
            const capacity = getRelicCapacity(userData);
            boosts.push(`🏺 **+${Math.round(relicBonus * 100)}%** everywhere, from the relic case *(holds ${capacity} of ${RELIC_LIST.length})*`);
        }
        if (prestigeRank > 0) boosts.push(...prestigeBonusLines(prestigeRow).map(l => `${prestigeBadge} ${l}`));
        embed.addFields({ name: '📈 Standing Bonuses', value: boosts.join('\n'), inline: false });
    }

    // Where the road goes next. Explorer level gates every region, and nothing
    // anywhere told a player how close the next one was — the level bar measures
    // progress toward a number, not toward a place.
    const nextGate = REGION_LIST
        .filter(r => !r.seasonalEventId
            && isRegionEnabled(r, guildSettings)
            && !e.unlockedRegions.includes(r.id))
        .sort((a, b) => a.unlockLevel - b.unlockLevel)[0];
    if (isSelf && nextGate) {
        const short = nextGate.unlockLevel - e.level;
        embed.addFields({
            name: '🔭 Next Horizon',
            value: short > 0
                ? `**${nextGate.emoji} ${nextGate.name}** — Explorer Lv ${nextGate.unlockLevel} and ${currency}${nextGate.unlockCost.toLocaleString()}. `
                  + `You're ${short} level${short === 1 ? '' : 's'} short.`
                : `**${nextGate.emoji} ${nextGate.name}** — the level is yours. `
                  + `${currency}${nextGate.unlockCost.toLocaleString()} opens the route via \`/explore travel\`.`,
            inline: false,
        });
    }

    if (isSelf) {
        embed.setFooter({
            text: `Daily: ${e.dailyExpeditions} expeditions · ${currency}${e.dailyCoins.toLocaleString()} earned `
                + `(full rate to ${currency}${LIMITS.DAILY_SOFT_CAP.toLocaleString()}, `
                + `${Math.round(LIMITS.DAILY_SOFT_CAP_RATE * 100)}% to ${currency}${LIMITS.DAILY_HARD_CAP.toLocaleString()})`,
        });
    }

    return interaction.reply({ embeds: [embed] });
}

module.exports = {
    handleProfile,
};
