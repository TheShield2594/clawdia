'use strict';

/**
 * Giveaways: drawing them, ending them, and sweeping the ones whose time is up.
 *
 * `endGiveaway` and the draw beneath it used to live in
 * `commands/utility/giveaway.js`, and this service imported the command to get
 * at them (#614) — a service reaching up into a command, which is the direction
 * that lets require cycles in. None of it was command-specific: `/giveaway end`
 * and the scheduled sweep are two callers of one operation. The command now
 * imports this, and nothing here knows an interaction exists.
 */

const { EmbedBuilder } = require('discord.js');
const Guild = require('../models/Guild');

// Ended giveaways are kept around so `/giveaway reroll` still works, but not
// forever: each one carries a full entrant list, and nothing else prunes the
// array, so a busy server would grow its Guild document without bound.
const GIVEAWAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function checkGiveaways(client) {
    const now = new Date();

    try {
        // Projected: this sweep runs on a schedule across every guild holding a
        // giveaway, and it only ever touches the giveaways array. Without this it
        // pulls whole guild documents — analytics history and inline shop item
        // image Buffers included — to read one field.
        //
        // guildId is selected because endGiveaway resolves the channel through it.
        // Mongoose skips required-validators for paths a projection excluded, so
        // saving these partial documents is safe.
        const guilds = await Guild.find({ 'giveaways.0': { $exists: true } })
            .select('guildId giveaways');

        for (const guildSettings of guilds) {
            let dirty = false;

            for (const ga of guildSettings.giveaways) {
                if (ga.ended) continue;
                if (ga.endsAt <= now) {
                    await endGiveaway(client, guildSettings, ga);
                    dirty = true;
                }
            }

            const cutoff = now.getTime() - GIVEAWAY_RETENTION_MS;
            const keep = guildSettings.giveaways.filter(
                ga => !ga.ended || !ga.endsAt || ga.endsAt.getTime() > cutoff
            );
            if (keep.length !== guildSettings.giveaways.length) {
                guildSettings.giveaways = keep;
                dirty = true;
            }

            if (dirty) await guildSettings.save();
        }
    } catch (err) {
        console.error('[GIVEAWAY] Error checking giveaways:', err);
    }
}

function parseDuration(str) {
    const match = str.match(/^(\d+)(s|m|h|d)$/i);
    if (!match) return null;
    const amount = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    return amount * multipliers[unit];
}

// Entrants are persisted on the giveaway subdocument by the giveaway_enter
// button handler in events/interactionCreate.js, so they survive restarts.
function getEntrants(ga) {
    return Array.isArray(ga?.entrantIds) ? [...ga.entrantIds] : [];
}

// Fisher-Yates. The previous `.sort(() => Math.random() - 0.5)` is not a
// uniform shuffle — comparison sorts with an inconsistent comparator leave
// elements strongly biased toward their original positions, so entrants who
// clicked first were measurably more likely to win.
function pickWinners(entrants, count) {
    const shuffled = [...entrants];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, Math.min(count, shuffled.length));
}

async function endGiveaway(client, guildSettings, ga) {
    ga.ended = true;

    // Draw before looking anything up. The caller persists the giveaway either
    // way, so bailing out early on a deleted channel or message used to mark it
    // ended with an empty winnerIds — the entrants were still there, but the
    // result was never recorded. Announcing is best-effort; deciding is not.
    const entrants = getEntrants(ga);
    const winners = pickWinners(entrants, ga.winners);
    ga.winnerIds = winners;

    const channel = client.guilds.cache
        .get(guildSettings.guildId)
        ?.channels.cache.get(ga.channelId);

    if (!channel) return;

    const msg = await channel.messages.fetch(ga.messageId).catch(() => null);
    if (!msg) return;

    const winnerText = winners.length
        ? winners.map(id => `<@${id}>`).join(', ')
        : 'No valid entrants';

    const endEmbed = new EmbedBuilder()
        .setColor('#ff0000')
        .setTitle('🎉 GIVEAWAY ENDED 🎉')
        .setDescription(`**Prize:** ${ga.prize}\n\n**Winner${winners.length !== 1 ? 's' : ''}:** ${winnerText}`)
        .addFields({ name: 'Hosted by', value: `<@${ga.hostId}>` })
        .setTimestamp();

    await msg.edit({ embeds: [endEmbed], components: [] }).catch(console.error);

    if (winners.length) {
        await channel.send(`🎉 Congratulations ${winnerText}! You won **${ga.prize}**!`).catch(console.error);
    }
}

module.exports = {
    checkGiveaways,
    endGiveaway,
    parseDuration,
    // Exported for tests: winner selection has to stay a uniform shuffle, and
    // that is only assertable against the real implementation.
    pickWinners,
    getEntrants,
};

