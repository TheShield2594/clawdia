'use strict';

// /explore regions — every known region, its requirements, season window and
// the player's progress through it.

const { EmbedBuilder } = require('discord.js');
const { REGION_LIST } = require('../../../data/exploreData');
const { isRegionEnabled, isRegionInSeason, regionCompletion } = require('../../../services/exploreService');
const { getDailyFeatured, FEATURED_PAYOUT_BONUS } = require('../../../data/featuredRotation');
const { loadContext } = require('./shared');

async function handleRegions(interaction) {
    const ctx = await loadContext(interaction);
    if (!ctx) return;
    const { guildSettings, user, currency } = ctx;
    const e = user.exploration;
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
                status = e.level >= region.unlockLevel ? '🟢 Open to you' : `🟡 Unlocked, needs Explorer Lv ${region.unlockLevel}`;
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
        .setColor('#2e7d32')
        .setTitle('🧭 Known Regions')
        .setDescription(sections.join('\n\n'))
        .setFooter({ text: `🌟 ${todaysFeature.name} pays +${Math.round(FEATURED_PAYOUT_BONUS * 100)}% today · seasonal regions come and go with /event seasons.` })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

module.exports = {
    handleRegions,
};
