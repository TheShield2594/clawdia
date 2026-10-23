'use strict';

// /explore regions — every known region, its requirements, season window and
// the player's progress through it.

const { EmbedBuilder } = require('discord.js');
const { REGION_LIST, ROUTE_LIST, LIMITS } = require('../../../data/exploreData');
const { ensureExploreData, isRegionEnabled, isRegionInSeason, regionCompletion } = require('../../../services/exploreService');
const { getDailyFeatured, FEATURED_PAYOUT_BONUS } = require('../../../data/featuredRotation');
const { exploreRegionItemId } = require('../../../data/activityItems');
const { attachItemThumbnail } = require('../../../utils/itemImageHelper');
const { loadReadContext, EXPLORE_COLORS } = require('./shared');

// What a player who has never set out sees: the starter region open, nothing
// charted. Read-only, so a browse never creates a profile it would then leave
// behind.
const NEWCOMER = Object.freeze({
    level: 1,
    activeRegion: 'whispering_forest',
    unlockedRegions: ['whispering_forest'],
    regions: [],
});

async function handleRegions(interaction) {
    // Listed as read-only in index.js, so it takes the read loader: the write
    // one upserts a User document, which a browse has no business doing.
    const ctx = await loadReadContext(interaction);
    if (!ctx) return;
    const { guildSettings, user, currency } = ctx;
    if (user?.exploration) ensureExploreData(user);
    const e = user?.exploration ?? NEWCOMER;
    const todaysFeature = getDailyFeatured(interaction.guild.id).region;

    const sections = REGION_LIST
        .filter(r => isRegionEnabled(r, guildSettings))
        .map(region => {
            const progress = e.regions.find(r => r.regionId === region.id) ?? null;
            const pct = progress ? regionCompletion(region, progress) : 0;
            const active = e.activeRegion === region.id ? ' 🧭 *(active)*' : '';
            const star   = region.id === todaysFeature.id ? ' 🌟' : '';

            let status;
            if (region.seasonalEventId) {
                status = isRegionInSeason(region, guildSettings)
                    ? '🟢 **In season** — open to everyone, free entry, limited time'
                    : '⚪ Out of season — returns with its event';
            } else if (e.unlockedRegions.includes(region.id)) {
                status = '🟢 Open to you';
            } else {
                status = `🔒 Explorer Lv ${region.unlockLevel} + ${currency}${region.unlockCost.toLocaleString()} via \`/explore travel\``;
            }

            return [
                `${region.emoji} **${region.name}**${active}${star} — *${region.tagline}*`,
                `> ${status}`,
                `> ${progress ? `${pct}% charted · ${progress.expeditions} expeditions` : 'Uncharted'}`,
            ].join('\n');
        });

    const embed = new EmbedBuilder()
        .setColor(EXPLORE_COLORS.TRAIL)
        .setTitle('🧭 Known Regions')
        .setDescription(sections.join('\n\n'))
        // The route is the other half of where you go: how you set out. Said
        // here once, since the result buttons only have room for its name.
        .addFields({
            name: '🧭 Routes',
            value: ROUTE_LIST.map(r => `${r.emoji} **${r.name}** — ${r.description}`).join('\n')
                + `\n🔥 *Every run that dodges traps and lost encounters builds your streak: `
                + `+${Math.round(LIMITS.STREAK_BONUS_PER * 100)}% coins each, up to +${Math.round(LIMITS.STREAK_MAX * LIMITS.STREAK_BONUS_PER * 100)}%.*`,
            inline: false,
        })
        .setFooter({ text: `🌟 ${todaysFeature.name} pays +${Math.round(FEATURED_PAYOUT_BONUS * 100)}% today · seasonal regions come and go with /event seasons.` })
        .setTimestamp();

    // The list has no single focal region, so the header wears the one you're
    // standing in. Bundle-only art — no-ops to no thumbnail until baked.
    const active = e.activeRegion ? REGION_LIST.find(r => r.id === e.activeRegion) : null;
    const files = active
        ? await attachItemThumbnail(embed, exploreRegionItemId(active.id), interaction.guild.id, active.name)
        : [];

    return interaction.reply({ embeds: [embed], files });
}

module.exports = {
    handleRegions,
};
