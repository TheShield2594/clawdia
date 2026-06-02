/**
 * Progressive casino jackpot pool — fed by all casino bets at a configurable rate.
 *
 * Trigger probability starts at 0.01% and increases by 0.001% with each eligible bet,
 * resetting after each drop.
 */

const Guild = require('../models/Guild');

const BASE_TRIGGER_RATE  = 0.0001;  // 0.01%
const TRIGGER_INCREMENT  = 0.00001; // 0.001% per bet
const HOT_POOL_THRESHOLD = 500_000; // 🔥 indicator above this amount

/**
 * Contributes `bet` coins to the guild's progressive jackpot pool and checks whether
 * the jackpot triggers this bet.
 *
 * Returns { triggered, wonAmount, newPool } — caller should announce if triggered.
 */
async function processJackpotBet({ guildId, userId, username, bet, interaction }) {
    const guild = await Guild.findOne({ guildId });
    if (!guild) return { triggered: false };

    const rate       = guild.casinoJackpot?.contributionRate ?? 0.005;
    const seedAmount = guild.casinoJackpot?.seedAmount       ?? 10000;
    const pool       = guild.casinoJackpot?.pool             ?? seedAmount;
    const betsCount  = guild.casinoJackpot?.betsCount        ?? 0;

    const contribution = Math.max(1, Math.floor(bet * rate));
    const newBetsCount = betsCount + 1;

    // Increasing probability per bet
    const triggerChance = BASE_TRIGGER_RATE + (betsCount * TRIGGER_INCREMENT);
    const triggered     = Math.random() < triggerChance;

    if (triggered) {
        const wonAmount = pool + contribution;
        await Guild.updateOne({ guildId }, {
            $set: {
                'casinoJackpot.pool':           seedAmount,
                'casinoJackpot.betsCount':      0,
                'casinoJackpot.lastWinnerId':   userId,
                'casinoJackpot.lastWinnerName': username,
                'casinoJackpot.lastWonAmount':  wonAmount,
                'casinoJackpot.lastWonAt':      new Date(),
            },
        });

        if (interaction) {
            await announceJackpot({ guild, interaction, wonAmount, newPool: seedAmount }).catch(() => {});
        }

        return { triggered: true, wonAmount, newPool: seedAmount };
    }

    // Not triggered — just grow the pool
    await Guild.updateOne({ guildId }, {
        $inc: {
            'casinoJackpot.pool':      contribution,
            'casinoJackpot.betsCount': 1,
        },
    });

    return { triggered: false, newPool: pool + contribution };
}

async function announceJackpot({ guild, interaction, wonAmount, newPool }) {
    const { EmbedBuilder } = require('discord.js');
    const channelId = guild.casinoJackpot?.announceChannelId ?? guild.economy?.announcementChannelId ?? null;
    const channel   = channelId
        ? (interaction.guild?.channels?.cache?.get(channelId) ?? interaction.channel)
        : interaction.channel;

    const embed = new EmbedBuilder()
        .setColor('#FF00FF')
        .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
        .setTitle('🎰 ✨ PROGRESSIVE JACKPOT ✨ 🎰')
        .setDescription(
            `${interaction.user} just **triggered the progressive jackpot!** 🎊\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `  💰 Won: **${wonAmount.toLocaleString()}** coins\n` +
            `  🔄 Pool resets to: **${newPool.toLocaleString()}** coins\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `> Every casino bet feeds the pot. Could be you next. 🎲`
        )
        .setTimestamp();

    await channel?.send({ embeds: [embed] });
}

/**
 * Returns a display string for the current jackpot pool with hot indicator.
 */
async function getJackpotDisplay(guildId) {
    const guild = await Guild.findOne({ guildId }, 'casinoJackpot');
    const pool  = guild?.casinoJackpot?.pool ?? 10000;
    const hot   = pool >= HOT_POOL_THRESHOLD;
    return { pool, hot, display: `${hot ? '🔥 ' : '🏆 '}**${pool.toLocaleString()}** coins` };
}

module.exports = { processJackpotBet, getJackpotDisplay, HOT_POOL_THRESHOLD };
