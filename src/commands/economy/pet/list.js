'use strict';

const { EmbedBuilder } = require('discord.js');
const { PET_DEFINITIONS, PET_MAX_LEVEL, RARE_PET_DROP_CHANCE, formatPetBonus, petBonusParts } = require('../../../services/petService');
const COLORS = require('../../../utils/embedColors');

// The rare companions and where they turn up, read off PET_DEFINITIONS rather
// than spelled out: the footer named three pets and three grinds for as long as
// there were three, and stayed that way when the Lantern Owl was added (#753) —
// leaving the only in-game mention of a pet nobody can buy pointing at the
// wrong set. Deriving it means the next one added lists itself.
function rareCompanionFooter() {
    const rare    = Object.values(PET_DEFINITIONS).filter(d => !d.purchasable);
    const names   = rare.map(d => d.name);
    const sources = [...new Set(rare.map(d => d.materialSource))];
    const nameList = names.length > 1
        ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
        : names[0];
    return `${nameList} aren't sold — each has a ${Math.round(RARE_PET_DROP_CHANCE * 100)}% chance to appear on a legendary ${sources.join(' / ')} · see every species in /pet codex`;
}

async function executeList(interaction) {
    const lines = Object.values(PET_DEFINITIONS)
        .filter(d => d.purchasable)
        .map(d => `${d.emoji} **${d.name}** — ${d.cost.toLocaleString()} coins\n`
                + `Bonus: ${formatPetBonus(d.bonusType, d.bonusPct)} → **+${(d.bonusPct * 2.5).toFixed(1)}${petBonusParts(d.bonusType).unit}** at Lv.${PET_MAX_LEVEL}  |  Fave food: \`${d.favoriteMaterial}\``);

    const embed = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle('🐾 Pet Shop')
        .setDescription(`Pets level up from feeding and battling, and their passive grows with them.\n\n${lines.join('\n\n')}`)
        .setFooter({ text: rareCompanionFooter() })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

module.exports = { executeList, rareCompanionFooter };
