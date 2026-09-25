'use strict';

// The evolution reveal (#1187). Reaching Stage 2 or 3 used to be one line in
// the feed, play or battle reply; it now posts its own public moment: the
// companion card at the new stage, the new title, and the passive before and
// after. It follows the reply that caused it, so it lands in the same channel.

const { EmbedBuilder } = require('discord.js');
const { evolutionSummary, formatPetBonus } = require('../../../services/petService');
const { renderPetCard } = require('../../../services/petStatusView');
const COLORS = require('../../../utils/embedColors');

/** The reveal embed for an evolution summary. Pure. */
function evolutionEmbed(summary, ownerId, cardName = null) {
    const passive = summary.bonusType
        ? `${formatPetBonus(summary.bonusType, summary.fromPct)} → **${formatPetBonus(summary.bonusType, summary.toPct)}**`
        : null;
    const embed = new EmbedBuilder()
        .setColor(COLORS.PRIZE)
        .setTitle(`🌟 ${summary.fromEmoji} → ${summary.toEmoji} Evolution!`)
        .setDescription(`${ownerId ? `<@${ownerId}>'s ` : ''}**${summary.fromTitle}** evolved into **${summary.toTitle}**!`)
        .addFields({ name: '⭐ Stage', value: `${summary.fromStage} → **${summary.toStage}**`, inline: true })
        .setTimestamp();
    if (passive) embed.addFields({ name: '✨ Passive', value: passive, inline: true });
    if (cardName) embed.setImage(`attachment://${cardName}`);
    return embed;
}

/**
 * Post the reveal for `pet` if `res` (applyPetXp's result) is an evolution.
 * `interaction` must already have been answered: this is a follow-up. Never
 * throws — a reveal that cannot be posted costs the moment, not the command.
 */
async function revealEvolution(interaction, pet, res, { ownerId = null, ownerName = null } = {}) {
    const summary = evolutionSummary(pet, res);
    if (!summary) return false;
    try {
        const card = await renderPetCard(pet, {
            kicker:      ownerName ? `${ownerName}'s companion evolved` : 'A companion evolved',
            footerLeft:  `Stage ${summary.fromStage} → ${summary.toStage}`,
            footerRight: 'Evolution',
        }, 'evolution-card.png');
        await interaction.followUp({
            embeds:          [evolutionEmbed(summary, ownerId, card?.name ?? null)],
            files:           card ? [card] : [],
            // Pet names are player-chosen; the owner is named, never pinged.
            allowedMentions: { parse: [] },
        });
        return true;
    } catch (err) {
        console.error('[pet] evolution reveal failed:', err.message);
        return false;
    }
}

module.exports = { revealEvolution, evolutionEmbed };
