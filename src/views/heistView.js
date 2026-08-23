'use strict';

/**
 * How a heist looks: the lobby embed, its role buttons, and the skill-check
 * button row sent by DM.
 *
 * Split out of the command with `handleHeistButton` (#614). The button handler
 * redraws the lobby on every join, so whichever module owns the handler needs
 * these builders — and `events/interactionCreate` reaching into a command for
 * them, or the service reaching back up, is the dependency direction the layer
 * rule refuses. None of this touches a model or a service; it is a view.
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { ROLES, TARGETS } = require('../data/heistData');

function makeSkillRow(heistId, userId, check) {
    const row = new ActionRowBuilder();
    for (const choice of check.choices) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`heist_skill_${heistId}_${userId}_${String(choice)}`)
                .setLabel(String(choice))
                .setStyle(ButtonStyle.Primary)
        );
    }
    return row;
}

function buildLobbyEmbed(heist) {
    const target = TARGETS[heist.target] ?? TARGETS.bank;
    const secondsLeft = Math.max(0, Math.floor((heist.lobbyEndsAt - Date.now()) / 1000));
    const roleLines = Object.entries(ROLES).map(([key, r]) => {
        const player = [...heist.players.entries()].find(([, p]) => p.role === key);
        return `${r.emoji} **${r.label}** — ${player ? `✅ ${player[1].username}` : '_open_'}`;
    });

    return new EmbedBuilder()
        .setColor('#f39c12')
        .setTitle(`🎭 Heist Lobby — ${target.label}`)
        .setDescription(
            `**Initiator:** <@${heist.initiatorId}>\n\n` +
            `Pick a role and join the crew. Each role has a unique skill check that affects the payout.\n\n` +
            roleLines.join('\n')
        )
        .addFields({ name: '⏳ Lobby closes in', value: `${secondsLeft}s`, inline: true },
                   { name: '👥 Players', value: `${heist.players.size} / 4`, inline: true })
        .setFooter({ text: 'Click a role button below to join. Only one player per role.' })
        .setTimestamp();
}

function buildLobbyRows(heistId, heist) {
    const row = new ActionRowBuilder();
    for (const [key, r] of Object.entries(ROLES)) {
        const taken = [...heist.players.values()].some(p => p.role === key);
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`heist_join_${heistId}_${key}`)
                .setLabel(`${r.emoji} ${r.label}`)
                .setStyle(taken ? ButtonStyle.Secondary : ButtonStyle.Primary)
                .setDisabled(taken)
        );
    }
    return [row];
}

module.exports = { makeSkillRow, buildLobbyEmbed, buildLobbyRows };
