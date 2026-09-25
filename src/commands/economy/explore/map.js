'use strict';

// /explore map — every region, landmark and secret the player has charted.
//
// Exposed as the module's handleMap (see index.js) so sibling commands can
// render the same Explorer's Map.

const { EmbedBuilder, MessageFlags, AttachmentBuilder } = require('discord.js');
const { PRESTIGE_BADGES } = require('../../../data/exploreData');
const { ensureExploreData, renderMap, mapRegionStates, getExplorerTitle } = require('../../../services/exploreService');
const { createExploreMapCard, mapAltText } = require('../../../utils/exploreMapCard');
const { loadReadContext, surveyedCount, EXPLORE_COLORS } = require('./shared');

const MAP_FILE = 'explorer-map.png';

/**
 * The drawn map as an attachment, or null when it will not render — the text
 * map below it carries every number, so a failed draw costs the picture only.
 */
async function renderMapCard(userData, guildSettings, username) {
    const states = mapRegionStates(userData, guildSettings);
    try {
        const buffer = await createExploreMapCard({ states, username, level: userData.exploration.level });
        return new AttachmentBuilder(buffer, { name: MAP_FILE, description: mapAltText(states, username).slice(0, 1024) });
    } catch (err) {
        console.error('[explore] map card render failed:', err);
        return null;
    }
}

async function handleMap(interaction) {
    const ctx = await loadReadContext(interaction);
    if (!ctx) return;
    const { user: userData, guildSettings } = ctx;

    if (!userData?.exploration?.totalExpeditions) {
        return interaction.reply({
            content: 'Your map is a blank page with your name on it. Poetic, but useless. `/explore go` fixes that.',
            flags: MessageFlags.Ephemeral,
        });
    }

    ensureExploreData(userData);
    const e = userData.exploration;
    const lines = renderMap(userData, guildSettings);
    const mapRank = Math.max(0, Number(e.prestige) || 0);
    const mapBadge = mapRank > 0 ? `${PRESTIGE_BADGES[Math.min(mapRank, PRESTIGE_BADGES.length - 1)]} P${mapRank} · ` : '';

    const embed = new EmbedBuilder()
        .setColor(EXPLORE_COLORS.TRAIL)
        .setTitle(`🗺️ The Explorer's Map — ${interaction.user.username}`)
        .setDescription(
            `*Every line on this map cost somebody shoe leather. These lines cost yours.*\n\n` +
            lines.join('\n\n')
        )
        .addFields({
            name: '🧭 The Tally',
            value: [
                `${mapBadge}**${getExplorerTitle(userData)}** — Explorer Lv ${e.level}`,
                `🗿 ${e.landmarksDiscovered} landmarks · 📜 ${e.loreCollected} lore · ✨ ${e.secretsFound} secrets · 🏺 ${e.relicsRecovered} relics`,
                `${e.totalExpeditions.toLocaleString()} expeditions logged · 🏅 ${surveyedCount(userData, guildSettings)} regions fully surveyed`,
            ].join('\n'),
            inline: false,
        })
        .setFooter({ text: 'The blank spaces aren\'t empty. They\'re waiting.' })
        .setTimestamp();

    const card = await renderMapCard(userData, guildSettings, interaction.user.username);
    if (!card) return interaction.reply({ embeds: [embed] });
    embed.setImage(`attachment://${MAP_FILE}`);
    return interaction.reply({ embeds: [embed], files: [card] });
}

module.exports = {
    handleMap,
};
