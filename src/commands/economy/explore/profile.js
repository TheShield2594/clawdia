'use strict';

// /explore profile — a wanderer's explorer profile, in the carded, tabbed shape
// it shares with /hunt and /fish (utils/grindProfileView.js): the overview, the
// relic case as a collection, and standing bonuses with where the road goes next.

const { EmbedBuilder, MessageFlags } = require('discord.js');
const {
    LIMITS, EXPLORER_LEVELS, REGIONS, REGION_LIST,
    RELIC_LIST, RELIC_RARITY_ORDER, PRESTIGE_BADGES, MAX_EXPLORER_PRESTIGE,
} = require('../../../data/exploreData');
const {
    ensureExploreData, getMaxStamina, applyStaminaRegen, applyDailyReset,
    msUntilNextStamina, isRegionEnabled, getRelicCollection,
    getRelicBonus, getRelicCapacity, getExplorerPrestige, getExplorerTitle, formatMs,
} = require('../../../services/exploreService');
const { loadReadContext, surveyedCount, prestigeBonusLines, EXPLORE_COLORS } = require('./shared');
const { buildMissingRelicsField } = require('./relics');
const { relicItemId, exploreRegionItemId } = require('../../../data/activityItems');
const { msUntilDailyReset } = require('../../../services/grindEngine');
const { getActiveSynergies } = require('../../../services/synergyService');
const { createGrindProfileCard, createGrindCollectionCard } = require('../../../utils/grindProfileCard');
const {
    buildTodayField, levelProgress, pagePayload, renderAttachment, sendProfileTabs, staminaLine, xpLine,
} = require('../../../utils/grindProfileView');

const RELIC_COLORS = { rare: '#3498db', epic: '#9b59b6', legendary: '#f39c12' };
const RARITY_LABEL = r => r.charAt(0).toUpperCase() + r.slice(1);

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
    // Read-only, but Today should reflect a window that has already rolled over
    // rather than yesterday's numbers.
    applyDailyReset(userData);

    const collection = getRelicCollection(userData);
    const rarestFirst = [...RELIC_RARITY_ORDER].reverse();
    const shelf = [...collection]
        .sort((a, b) => rarestFirst.indexOf(a.rarity) - rarestFirst.indexOf(b.rarity) || b.value - a.value)
        .slice(0, 10);
    const view = { target, isSelf, userData, guildSettings, currency, collection, shelf };

    return sendProfileTabs(interaction, [
        { id: 'overview', label: 'Overview', emoji: '🧭', build: () => overviewPage(view) },
        { id: 'relics',   label: 'Relics',   emoji: '🏺', build: () => relicsPage(view) },
        { id: 'progress', label: 'Progress', emoji: '🎖️', build: () => progressPage(view) },
    ]);
}

function prestigeOf(e) {
    const rank = Math.max(0, Number(e.prestige) || 0);
    return { rank, badge: PRESTIGE_BADGES[Math.min(rank, PRESTIGE_BADGES.length - 1)] ?? '' };
}

async function overviewPage({ target, isSelf, userData, guildSettings, currency, collection, shelf }) {
    const e = userData.exploration;
    const progress = levelProgress(EXPLORER_LEVELS, e.level, e.xp);
    const { rank: prestigeRank, badge: prestigeBadge } = prestigeOf(e);
    const activeRegion = REGIONS[e.activeRegion];
    const maxStam = getMaxStamina(userData);
    const title = getExplorerTitle(userData);
    const surveyed = surveyedCount(userData, guildSettings);
    const relicBonus = getRelicBonus(userData);

    // Level 30 is no longer the end of the road, so the profile points at the
    // road rather than declaring a dead end (#750).
    const xpText = progress.span == null
        ? `${xpLine(progress, e.level)}${prestigeRank < MAX_EXPLORER_PRESTIGE
            ? ` · ${isSelf ? '`/explore prestige` to ascend' : 'ready to ascend'}`
            : ' · *the last rank there is*'}`
        : xpLine(progress, e.level);

    const embed = new EmbedBuilder()
        .setColor(activeRegion?.color ?? EXPLORE_COLORS.TRAIL)
        .setTitle(`${prestigeBadge || '🧭'} ${target.username}'s Explorer Profile`)
        .setDescription([
            `**${title}** · Level ${e.level}${activeRegion ? ` · ${activeRegion.emoji} ${activeRegion.name}` : ''}`
                + (prestigeRank > 0 ? ` · ${prestigeBadge} P${prestigeRank}` : ''),
            xpText,
            staminaLine(e.stamina, maxStam, msUntilNextStamina(userData), formatMs),
        ].join('\n'))
        .addFields(
            {
                name: '📊 Field Record',
                value: [
                    `${e.totalExpeditions.toLocaleString()} expeditions · ${surveyed} region${surveyed === 1 ? '' : 's'} surveyed`,
                    `${currency}${e.totalEarned.toLocaleString()} earned · best ${currency}${e.bestHaul.toLocaleString()}`,
                    `${e.secretsFound} secrets · ${e.trapsSprung} traps sprung *(we don't judge)*`,
                ].join('\n'),
                inline: true,
            },
            {
                name: '🏺 Relic Case',
                value: `${collection.length}/${RELIC_LIST.length} relics · ${e.relicsRecovered} recovered`
                    + (relicBonus > 0 ? `\n+${Math.round(relicBonus * 100)}% on every haul` : ''),
                inline: true,
            }
        );

    if (isSelf) {
        embed.addFields(buildTodayField({
            coins:    e.dailyCoins ?? 0,
            actions:  e.dailyExpeditions ?? 0,
            noun:     'expeditions',
            limits:   LIMITS,
            resetMs:  msUntilDailyReset(userData, 'explore'),
            softRate: LIMITS.DAILY_SOFT_CAP_RATE,
            currency,
            formatMs,
        }));
    }

    const card = await renderAttachment(() => createGrindProfileCard({
        activity:      'explore',
        name:          target.username,
        avatarUrl:     target.displayAvatarURL({ extension: 'png', size: 256 }),
        rankTitle:     title,
        level:         e.level,
        prestige:      prestigeRank,
        prestigeLabel: prestigeRank > 0 ? `${prestigeBadge} Prestige ${prestigeRank}` : null,
        xp:            { total: e.xp, into: progress.into, span: progress.span },
        place:         activeRegion
            ? { name: activeRegion.name, color: activeRegion.color, iconId: exploreRegionItemId(activeRegion.id) }
            : null,
        stamina:       { current: e.stamina, max: maxStam },
        stats: [
            { label: 'Expeditions', value: e.totalExpeditions.toLocaleString('en-US') },
            { label: 'Earned',      value: e.totalEarned.toLocaleString('en-US') },
            { label: 'Secrets',     value: e.secretsFound.toLocaleString('en-US') },
            { label: 'Surveyed',    value: String(surveyed) },
        ],
        shelfTitle: `Relic case · ${collection.length}/${RELIC_LIST.length}`,
        shelf: shelf.map(r => ({ iconId: relicItemId(r.slug), name: r.itemId, color: RELIC_COLORS[r.rarity] })),
        shelfEmpty: 'The case is empty — rare treasure carries relics out of the wilds.',
    }), 'explore-profile.png',
        `Explorer profile card for ${target.username}: ${title}, level ${e.level}, `
        + `${progress.span == null ? 'max level' : `${Math.floor(progress.frac * 100)}% to level ${e.level + 1}`}, `
        + `${activeRegion ? `exploring ${activeRegion.name}, ` : ''}stamina ${e.stamina} of ${maxStam}, `
        + `${e.totalExpeditions} expeditions, ${e.secretsFound} secrets, ${surveyed} regions surveyed. `
        + (shelf.length ? `Relics on the shelf: ${shelf.map(r => r.itemId).join(', ')}.` : 'No relics yet.'));

    return pagePayload(embed, card);
}

async function relicsPage({ target, isSelf, userData, collection }) {
    const owned = new Set(collection.map(r => r.itemId));
    const core = RELIC_LIST.filter(r => !REGIONS[r.regionId]?.seasonalEventId);
    const seasonal = RELIC_LIST.filter(r => REGIONS[r.regionId]?.seasonalEventId);
    const bonus = getRelicBonus(userData);
    const capacity = getRelicCapacity(userData);

    // Counted the way the card groups them: core relics by rarity, then the
    // seasonal ones on their own, since those only drop while their event runs.
    const countOf = list => `${list.filter(r => owned.has(r.itemId)).length}/${list.length}`;
    const rarityCounts = [
        ...RELIC_RARITY_ORDER.map(rarity => `${RARITY_LABEL(rarity)} ${countOf(core.filter(r => r.rarity === rarity))}`),
        `Seasonal ${countOf(seasonal)}`,
    ];

    const embed = new EmbedBuilder()
        .setColor(EXPLORE_COLORS.RELIC)
        .setTitle(`🏺 ${target.username}'s Relic Case`)
        .setDescription([
            `**${collection.length} of ${RELIC_LIST.length} relics** · ${rarityCounts.join(' · ')}`,
            `+${Math.round(bonus * 100)}% on every coin exploration pays · the case counts **${capacity}** at this rank`,
        ].join('\n'))
        .setFooter({ text: 'Lore, values and duplicates: /explore relics' });

    const missing = buildMissingRelicsField(collection, isSelf, target.username);
    if (missing) embed.addFields(missing);

    const entry = r => ({
        iconId: relicItemId(r.slug), name: r.itemId,
        owned: owned.has(r.itemId), color: RELIC_COLORS[r.rarity],
    });
    const sections = RELIC_RARITY_ORDER.map(rarity => ({
        label: RARITY_LABEL(rarity),
        color: RELIC_COLORS[rarity],
        entries: core.filter(r => r.rarity === rarity).map(entry),
    }));
    sections.push({ label: 'Seasonal', color: '#e67e22', entries: seasonal.map(entry) });

    const card = await renderAttachment(() => createGrindCollectionCard({
        activity: 'explore',
        title:    `${target.username}'s Relic Case`,
        subtitle: `${collection.length} of ${RELIC_LIST.length} relics · +${Math.round(bonus * 100)}% on every haul`,
        sections,
    }), 'explore-relics.png',
        `Relic case for ${target.username}: ${collection.length} of ${RELIC_LIST.length} relics. ${rarityCounts.join(', ')}.`);

    return pagePayload(embed, card);
}

async function progressPage({ target, isSelf, userData, guildSettings, currency }) {
    const e = userData.exploration;
    const { rank: prestigeRank, badge: prestigeBadge } = prestigeOf(e);
    const relicBonus = getRelicBonus(userData);
    const surveyed = surveyedCount(userData, guildSettings);

    const embed = new EmbedBuilder()
        .setColor(REGIONS[e.activeRegion]?.color ?? EXPLORE_COLORS.TRAIL)
        .setTitle(`🎖️ ${target.username}'s Exploring Progress`);

    const boosts = [];
    if (surveyed > 0)   boosts.push(`🏅 **+${Math.round(LIMITS.SURVEY_BONUS * 100)}%** in ${surveyed} fully surveyed region${surveyed === 1 ? '' : 's'}`);
    if (relicBonus > 0) {
        boosts.push(`🏺 **+${Math.round(relicBonus * 100)}%** everywhere, from the relic case *(holds ${getRelicCapacity(userData)} of ${RELIC_LIST.length})*`);
    }
    if (prestigeRank > 0) boosts.push(...prestigeBonusLines(getExplorerPrestige(userData)).map(l => `${prestigeBadge} ${l}`));
    embed.addFields({
        name: '📈 Standing Bonuses',
        value: boosts.length ? boosts.join('\n') : 'None yet — survey a region fully or bring home a relic.',
        inline: false,
    });

    const regions = REGION_LIST.filter(r => !r.seasonalEventId && isRegionEnabled(r, guildSettings));
    embed.addFields({
        name: `🗺️ Regions (${regions.filter(r => e.unlockedRegions.includes(r.id)).length}/${regions.length})`,
        value: regions.map(r => e.unlockedRegions.includes(r.id)
            ? `${r.emoji} ${r.name}`
            : `🔒 ${r.name} · Lv ${r.unlockLevel}`).join('\n'),
        inline: true,
    });

    // Where the road goes next. Explorer level gates every region, and nothing
    // anywhere told a player how close the next one was — the level bar measures
    // progress toward a number, not toward a place.
    const nextGate = regions
        .filter(r => !e.unlockedRegions.includes(r.id))
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
            inline: true,
        });
    }

    const activeSynergies = getActiveSynergies(userData);
    embed.addFields({
        name: '🔗 Synergies',
        value: activeSynergies.length
            ? activeSynergies.map(s => `${s.emoji} **${s.name}** — ${s.description}`).join('\n')
            : 'Reach combined level milestones across Hunt, Fish, Mine & Explore to unlock cross-system bonuses — see `/synergies`.',
        inline: false,
    });

    return pagePayload(embed, null);
}

module.exports = {
    handleProfile,
};
