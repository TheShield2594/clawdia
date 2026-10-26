'use strict';

// /mine map — the depths, and which of them the player has opened.

const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { MessageFlags, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const User = require('../../../models/User');
const { attachGrind } = require('../../../utils/grindProfile');
const { ensureMineData, renderMineMap, getRaidableMaterials, RAID_MAX_PER_MATERIAL } = require('../../../services/mineService');
const { DEPTHS, INTENSITY_LEVELS, MATERIAL_NAMES } = require('../../../data/mineData');
const { createMineMapCard, mineMapAltText, siteCounts, plural, FILE_EXT } = require('../../../utils/mineMapCard');

const MAP_FILE = `mine-map.${FILE_EXT}`;

/**
 * The drawn mine map as an attachment, or null when it will not render — the
 * reply then falls back to the emoji grid, so a failed draw costs the picture
 * only.
 */
async function renderMapCard(m, depth, username) {
    const opts = {
        cells: m.mineMap, row: m.mineMapRow, col: m.mineMapCol,
        depthId: m.activeDepth, depthName: depth?.name, username,
    };
    try {
        const buffer = await createMineMapCard(opts);
        return new AttachmentBuilder(buffer, { name: MAP_FILE, description: mineMapAltText(opts).slice(0, 1024) });
    } catch (err) {
        console.error('[mine] map card render failed:', err);
        return null;
    }
}

// ─── MAP ──────────────────────────────────────────────────────────────────────

async function handleMap(interaction) {
    const guildSettings = await getGuildSettings(interaction.guild.id);
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }

    const user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
    await attachGrind(user);
    // Gated on having dug, not on having a user document (#873, pass 16): every
    // member who has chatted has one, so the old `!user` check almost never
    // fired and a player who had never mined got a blank grid, a pickaxe in the
    // middle and "0/100 cells explored" instead of being pointed at /mine dig —
    // the same gate /explore map puts on totalExpeditions.
    if (!user?.mining?.totalMines) {
        return interaction.reply({
            content: "You haven't started mining yet! Use `/mine dig` to begin.",
            flags: MessageFlags.Ephemeral
        });
    }
    ensureMineData(user);
    const m = user.mining;

    const depth  = DEPTHS[m.activeDepth];
    const counts = siteCounts(m.mineMap);

    // Yield multiplier comes from the intensity the miner picks before digging, with
    // a good or rich seam lifting it a rung or two at the same risk. Read off the
    // ladder so the range cannot drift from it again: it said 0.7× long after
    // Careful moved to 0.8×.
    const mults = INTENSITY_LEVELS.map(l => l.multiplier);
    const intensityHint = `${Math.min(...mults).toFixed(1)}×–${Math.max(...mults).toFixed(1)}×, set by the risk you choose`;

    const raidableLines = getRaidableMaterials(user).map(([id, qty]) => `${MATERIAL_NAMES[id] ?? id}: **${qty}**`);

    // The picture carries the grid; the emoji grid and its legend are only the
    // fallback when it will not render. Every number on the picture is here too.
    const card = await renderMapCard(m, depth, interaction.user.username);
    const grid = card ? '' : `\`\`\`\n${renderMineMap(user)}\n\`\`\`\n`;

    const embed = new EmbedBuilder()
        .setColor('#8B4513')
        .setTitle(`🗺️ ${interaction.user.username}'s Mine Map`)
        .setDescription(grid +
            `${depth ? `**Depth:** ${depth.emoji} ${depth.name}` : ''} | **Yield range:** ${intensityHint}`)
        .addFields(
            {
                name: '📊 Excavation Progress',
                value: `${counts.explored}/${counts.total} cells explored\n💎 ${plural(counts.ore, 'ore vein')} · 💥 ${plural(counts.caveIn, 'cave-in')}`,
                inline: true
            },
            {
                name: '📦 Exposed to Raiders',
                value: raidableLines.length
                    ? raidableLines.join('\n') + `\n*A raid takes up to ${RAID_MAX_PER_MATERIAL} of each — spend or craft them to shrink the pile.*`
                    : 'Nothing exposed — raiders can only reach materials you hold 2+ of.',
                inline: true
            },
        )
        .setFooter({ text: 'Mine more to expand your map • Use /mine raid to steal from others' })
        .setTimestamp();

    const spareLocks = m.consumables?.mine_lock ?? 0;
    if (m.mineLockActive) {
        embed.addFields({ name: '🔒 Mine Lock', value: `Armed — the next raid on your mine bounces off it.${spareLocks > 0 ? `\n${spareLocks} spare in your bag.` : ''}`, inline: true });
    } else if (spareLocks > 0) {
        embed.addFields({ name: '🔓 Mine Lock', value: `${spareLocks} in your bag, none armed — use \`/mine shop use item:mine_lock\`.`, inline: true });
    }

    if (!card) {
        embed.addFields({ name: '🔑 Legend', value: '🪨 Unexplored  ⬛ Excavated  💎 Ore Vein  💥 Cave-in  ⛏️ You', inline: false });
        return interaction.reply({ embeds: [embed] });
    }
    embed.setImage(`attachment://${MAP_FILE}`);
    return interaction.reply({ embeds: [embed], files: [card] });
}

module.exports = {
    handleMap,
};
