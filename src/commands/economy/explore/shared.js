'use strict';

// Values and helpers more than one part of /explore needs. Nothing here reaches
// for a sibling module, which is what keeps the folder free of require cycles.

const { MessageFlags } = require('discord.js');
const User = require('../../../models/User');
const { attachGrind } = require('../../../utils/grindProfile');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const {
    ensureExploreData,
    isRegionInSeason,
    isRegionEnabled,
    isRegionFullyCharted,
    relicCapacityForBonus,
} = require('../../../services/exploreService');
const { REGION_LIST, RELIC_LIST } = require('../../../data/exploreData');

const EVENT_TYPE_EMOJI = {
    discovery: '🗿', lore: '📜', secret: '✨', treasure: '🪙',
    trap: '🪤', encounter: '👁️', quiet: '🌫️',
};

// ─── Shared guards ────────────────────────────────────────────────────────────

// Returns the guild doc, or null after replying if exploration is switched off.
async function loadGuildOrReply(interaction) {
    const guildSettings = await getGuildSettings(interaction.guild.id);
    if (guildSettings?.economy?.enabled === false) {
        await interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        return null;
    }
    if (guildSettings?.exploration?.enabled === false) {
        await interaction.reply({ content: 'Exploration is switched off on this server. The wilds will wait — they\'re good at it.', flags: MessageFlags.Ephemeral });
        return null;
    }
    return guildSettings ?? {};
}

async function loadContext(interaction) {
    const guildSettings = await loadGuildOrReply(interaction);
    if (!guildSettings) return null;
    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    await attachGrind(user);
    ensureExploreData(user);
    return { guildSettings, user, currency: guildSettings?.economy?.currency ?? '💰' };
}

/**
 * Read-only loader for map/journal/relics/profile: honours the same enable
 * switches as the write paths, and loads whichever user is being inspected.
 */
async function loadReadContext(interaction, target = interaction.user) {
    const guildSettings = await loadGuildOrReply(interaction);
    if (!guildSettings) return null;
    const user = await User.findOne({ userId: target.id, guildId: interaction.guild.id });
    await attachGrind(user);
    return { guildSettings, user, currency: guildSettings?.economy?.currency ?? '💰' };
}

// Region gate shared by go/travel: returns an error string or null
function regionGateError(user, region, guildSettings) {
    const e = user.exploration;
    if (!region) {
        return 'I don\'t have that place on any map, and I have several maps.';
    }
    if (!isRegionEnabled(region, guildSettings)) {
        return `**${region.name}** is closed by decree of the server staff. Even the wilds answer to someone.`;
    }
    if (region.seasonalEventId && !isRegionInSeason(region, guildSettings)) {
        return `**${region.emoji} ${region.name}** is out of season. It will be back — that kind of place always comes back. Keep an eye on \`/event status\`.`;
    }
    if (!region.seasonalEventId && !e.unlockedRegions.includes(region.id)) {
        return `You haven't opened the way to **${region.emoji} ${region.name}** yet. Use \`/explore travel\` — it costs **${region.unlockCost.toLocaleString()}** coins and Explorer Level **${region.unlockLevel}**.`;
    }
    if (!region.seasonalEventId && e.level < region.unlockLevel) {
        return `**${region.emoji} ${region.name}** requires Explorer Level **${region.unlockLevel}**. The place isn't going anywhere. You should be, though — go level up.`;
    }
    return null;
}

// How many regions the player has charted end to end.
function surveyedCount(user, guildSettings) {
    return REGION_LIST.filter(region => {
        if (!isRegionEnabled(region, guildSettings)) return false;
        const progress = user.exploration.regions.find(r => r.regionId === region.id);
        return isRegionFullyCharted(region, progress);
    }).length;
}

/** Formats one row of EXPLORER_PRESTIGE as the lines a player sees. */
function prestigeBonusLines(bonus, previous = null) {
    const lines = [];
    if (bonus.payoutBonus > 0)   lines.push(`💰 +${Math.round(bonus.payoutBonus * 100)}% on every coin the wilds pay you`);
    if (bonus.staminaBonus > 0)  lines.push(`⚡ +${bonus.staminaBonus} max stamina`);
    if (bonus.secretBonus > 0)   lines.push(`✨ +${Math.round(bonus.secretBonus * 100)}% weight on the secret slot`);
    if (bonus.relicCapBonus > 0) lines.push(`🏺 Relic case holds **${relicCapacityForBonus(bonus.relicCapBonus)}** of ${RELIC_LIST.length}`);
    // With a previous row to compare against, a rank that adds nothing new says
    // so rather than re-listing the bonuses the player already has.
    if (previous) {
        const keys = ['payoutBonus', 'staminaBonus', 'secretBonus', 'relicCapBonus'];
        const gained = keys.filter(k => (bonus[k] ?? 0) > (previous[k] ?? 0));
        if (!gained.length) lines.push('*(nothing new at this rank — the one after it is the step)*');
    }
    return lines;
}

module.exports = {
    EVENT_TYPE_EMOJI,
    loadGuildOrReply,
    loadContext,
    loadReadContext,
    regionGateError,
    surveyedCount,
    prestigeBonusLines,
};
