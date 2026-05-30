'use strict';

const { EmbedBuilder } = require('discord.js');
const { delay } = require('./delay');
const { TIER_RIBBON: rarityRibbon } = require('../data/materialRarity');

// Formats a canonical multiplier stack-bar line.
// multipliers: Array of { emoji, label } where label is the pre-formatted string
//   e.g. { emoji: '🔥', label: '1.5x' }  or  { emoji: '🐺', label: '+12%' }
//   Pass label: null or omit to show only the emoji (binary presence indicator).
// finalMult: combined multiplier after clamping
// finalAmount: final coin payout
// currency: currency emoji/symbol
// Returns empty string if multipliers is empty.
function stackBar(multipliers, finalMult, finalAmount, currency) {
    if (!multipliers || multipliers.length === 0) return '';
    const parts = multipliers.map(m => m.label ? `${m.emoji} ${m.label}` : m.emoji);
    return `${parts.join(' × ')} = **${finalMult.toFixed(2)}x** → **+${finalAmount.toLocaleString()} ${currency}**`;
}

// 2-stage reward reveal: suspense embed → delay → result embed.
// Handles both fresh replies and deferred/already-replied interactions.
//
// Options:
//   interaction     – Discord interaction object
//   suspenseTitle   – Title for the suspense embed  (default: '⏳ Rolling…')
//   suspenseText    – Description text              (default: '*Hold on…*')
//   suspenseColor   – Embed color for suspense      (default: '#888888')
//   resultEmbed     – Final EmbedBuilder to display
//   delayMs         – Delay between suspense and result (default: 700–1200 random)
//   broadcast       – Optional async () => void called after reveal (fire-and-forget)
async function rewardReveal({ interaction, suspenseTitle, suspenseText, suspenseColor, resultEmbed, delayMs, broadcast }) {
    const ms = delayMs ?? (700 + Math.floor(Math.random() * 500));

    const suspense = new EmbedBuilder()
        .setColor(suspenseColor ?? '#888888')
        .setTitle(suspenseTitle ?? '⏳ Rolling…')
        .setDescription(suspenseText ?? '*Hold on…*');

    if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ embeds: [suspense] });
    } else {
        await interaction.editReply({ embeds: [suspense], components: [] });
    }

    await delay(ms);
    await interaction.editReply({ embeds: [resultEmbed], components: [] });

    if (broadcast) broadcast().catch(() => {});
}

module.exports = { rarityRibbon, stackBar, rewardReveal };
