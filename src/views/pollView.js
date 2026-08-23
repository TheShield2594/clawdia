'use strict';

/**
 * How a poll looks. No model, no service, no scheduling — an embed and a row of
 * buttons built from values the caller already has.
 *
 * It lives here because three layers needed it and the only copy was inside a
 * command (#614): `services/ai/actions.js` reached up into
 * `commands/utility/poll` for `buildPollEmbed` so the AI could open a poll, and
 * the vote handler needed the same builder to redraw the message. A service
 * importing a command is the dependency direction that lets cycles in, and the
 * shared thing was never command-specific to begin with — it is a view.
 *
 * `src/views/` is below `services/` and may import nothing but discord.js and
 * static data; see the layer rule in eslint.config.js.
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

function tallyVotes(voteMap, optionCount) {
    const counts = new Array(optionCount).fill(0);
    for (const idx of voteMap.values()) counts[idx]++;
    return counts;
}

function buildPollEmbed(question, options, counts, endsAt, author, closed = false) {
    const total = counts.reduce((a, b) => a + b, 0);

    const lines = options.map((opt, i) => {
        const pct = total > 0 ? Math.round((counts[i] / total) * 100) : 0;
        const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
        return `**${i + 1}. ${opt}**\n${bar} ${pct}% (${counts[i]} vote${counts[i] !== 1 ? 's' : ''})`;
    });

    const authorTag = typeof author === 'string' ? author : author.tag;

    const embed = new EmbedBuilder()
        .setColor(closed ? '#ff0000' : '#5865F2')
        .setTitle(`${closed ? '🔒 ' : '📊 '}${question}`)
        .setDescription(lines.join('\n\n'))
        .addFields({ name: 'Total votes', value: total.toString(), inline: true })
        .setFooter({ text: `Created by ${authorTag}${closed ? ' • Poll closed' : ''}` });

    if (endsAt && !closed) {
        embed.addFields({ name: 'Ends', value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>`, inline: true });
    }

    return embed;
}

function buildPollRows(options) {
    const rows = [];
    for (let i = 0; i < options.length; i += 5) {
        const row = new ActionRowBuilder();
        options.slice(i, i + 5).forEach((opt, j) => {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`poll_${i + j}`)
                    .setLabel(`${i + j + 1}. ${opt.substring(0, 77)}`)
                    .setStyle(ButtonStyle.Secondary)
            );
        });
        rows.push(row);
    }
    return rows;
}

module.exports = { tallyVotes, buildPollEmbed, buildPollRows };
