'use strict';

// /mine map — the depths, and which of them the player has opened.

const Guild = require('../../../models/Guild');
const { MessageFlags, EmbedBuilder } = require('discord.js');
const User = require('../../../models/User');
const { attachGrind } = require('../../../utils/grindProfile');
const { ensureMineData, renderMineMap, getRaidableMaterials, RAID_MAX_PER_MATERIAL } = require('../../../services/mineService');
const { DEPTHS, MATERIAL_NAMES } = require('../../../data/mineData');

// ─── MAP ──────────────────────────────────────────────────────────────────────

async function handleMap(interaction) {
    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
    }

    const user = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
    if (!user) {
        return interaction.reply({
            content: "You haven't started mining yet! Use `/mine dig` to begin.",
            flags: MessageFlags.Ephemeral
        });
    }
    await attachGrind(user);
    ensureMineData(user);
    const m = user.mining;

    const grid     = renderMineMap(user);
    const depth    = DEPTHS[m.activeDepth];
    const mapSize  = 10;
    const explored = (m.mineMap ?? []).filter(c => c !== 0).length;
    const total    = mapSize * mapSize;

    // Yield multiplier comes from the intensity the miner picks before digging, with
    // a correct vein read promoting it one rung at the same risk.
    const intensityHint = '0.7×–3.0×, set by the risk you choose';

    const raidableLines = getRaidableMaterials(user).map(([id, qty]) => `${MATERIAL_NAMES[id] ?? id}: **${qty}**`);

    const embed = new EmbedBuilder()
        .setColor('#8B4513')
        .setTitle(`🗺️ ${interaction.user.username}'s Mine Map`)
        .setDescription(`\`\`\`\n${grid}\n\`\`\`\n` +
            `${depth ? `**Depth:** ${depth.emoji} ${depth.name}` : ''} | **Yield range:** ${intensityHint}`)
        .addFields(
            {
                name: '📊 Excavation Progress',
                value: `${explored}/${total} cells explored`,
                inline: true
            },
            {
                name: '📦 Exposed to Raiders',
                value: raidableLines.length
                    ? raidableLines.join('\n') + `\n*A raid takes up to ${RAID_MAX_PER_MATERIAL} of each — spend or craft them to shrink the pile.*`
                    : 'Nothing exposed — raiders can only reach materials you hold 2+ of.',
                inline: true
            },
            {
                name: '🔑 Legend',
                value: '🪨 Unexplored  ⬛ Excavated  💎 Ore Vein  💥 Cave-in  ⛏️ You',
                inline: false
            }
        )
        .setFooter({ text: 'Mine more to expand your map • Use /mine raid to steal from others' })
        .setTimestamp();

    const spareLocks = m.consumables?.mine_lock ?? 0;
    if (m.mineLockActive) {
        embed.addFields({ name: '🔒 Mine Lock', value: `Armed — the next raid on your mine bounces off it.${spareLocks > 0 ? `\n${spareLocks} spare in your bag.` : ''}`, inline: true });
    } else if (spareLocks > 0) {
        embed.addFields({ name: '🔓 Mine Lock', value: `${spareLocks} in your bag, none armed — use \`/mine shop use item:mine_lock\`.`, inline: true });
    }

    return interaction.reply({ embeds: [embed] });
}

module.exports = {
    handleMap,
};
