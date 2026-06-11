/**
 * Progressive casino jackpot pool — fed by all casino bets at a configurable rate.
 *
 * Trigger probability starts at 0.01% and increases by 0.001% with each eligible bet,
 * resetting after each drop.
 */

const Guild = require('../models/Guild');
const User  = require('../models/User');
const { logTransaction } = require('../utils/logTransaction');

const BASE_TRIGGER_RATE  = 0.0001;  // 0.01%
const TRIGGER_INCREMENT  = 0.00001; // 0.001% per bet
const HOT_POOL_THRESHOLD = 500_000; // 🔥 indicator above this amount

/**
 * Contributes `bet` coins to the guild's progressive jackpot pool and checks whether
 * the jackpot triggers this bet.
 *
 * The pool reset and winner metadata are applied atomically via findOneAndUpdate
 * (new: false), so wonAmount is computed from the pre-update document — preventing
 * stale reads from concurrent bets. The user credit happens immediately after and
 * is not transactionally linked (replica-set transactions are not assumed), but the
 * pool is already claimed before any credit attempt, so the worst failure mode is an
 * unpaid winner that can be reconciled from the lastWinnerId/lastWonAmount fields.
 *
 * Returns { triggered, wonAmount, newPool }.
 */
async function processJackpotBet({ guildId, userId, username, bet, interaction }) {
    const guild = await Guild.findOne({ guildId }, 'casinoJackpot');
    if (!guild) return { triggered: false };

    const rate       = guild.casinoJackpot?.contributionRate ?? 0.005;
    const seedAmount = guild.casinoJackpot?.seedAmount       ?? 10000;
    const betsCount  = guild.casinoJackpot?.betsCount        ?? 0;

    const contribution  = Math.max(1, Math.floor(bet * rate));
    const triggerChance = BASE_TRIGGER_RATE + (betsCount * TRIGGER_INCREMENT);
    const triggered     = Math.random() < triggerChance;

    if (triggered) {
        // Atomically claim the pool: read the pre-update document (new: false) so we
        // compute wonAmount from the actual pool at the moment of the win.
        const claimed = await Guild.findOneAndUpdate(
            { guildId },
            {
                $set: {
                    'casinoJackpot.pool':           seedAmount,
                    'casinoJackpot.betsCount':      0,
                    'casinoJackpot.lastWinnerId':   userId,
                    'casinoJackpot.lastWinnerName': username,
                    'casinoJackpot.lastWonAt':      new Date(),
                },
            },
            { new: false }
        );

        const poolAtWin = claimed?.casinoJackpot?.pool ?? seedAmount;
        const wonAmount = poolAtWin + contribution;

        // Persist the exact amount won now that we know it
        Guild.updateOne({ guildId }, { $set: { 'casinoJackpot.lastWonAmount': wonAmount } }).catch(() => {});

        // Credit the winner — pool is already reset above so this is safe to retry.
        // If the credit persistently fails, restore the pool so the coins aren't lost.
        let updatedUser = null;
        for (let attempt = 0; attempt < 3 && !updatedUser; attempt++) {
            try {
                updatedUser = await User.findOneAndUpdate(
                    { userId, guildId },
                    { $inc: { balance: wonAmount } },
                    { new: true }
                );
            } catch (err) {
                console.error(`[CasinoJackpot] credit attempt ${attempt + 1} failed for ${userId} (${wonAmount} coins):`, err);
                await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
            }
        }
        if (!updatedUser) {
            console.error(`[CasinoJackpot] CRITICAL: could not credit ${wonAmount} coins to ${userId} in guild ${guildId} — restoring pool`);
            await Guild.updateOne({ guildId }, { $inc: { 'casinoJackpot.pool': poolAtWin } }).catch(err =>
                console.error('[CasinoJackpot] pool restore also failed:', err));
            return { triggered: false, newPool: poolAtWin + contribution };
        }

        logTransaction({
            userId,
            guildId,
            type:    'casino_jackpot',
            amount:  wonAmount,
            balance: updatedUser?.balance ?? 0,
            note:    'Progressive jackpot win',
        });

        if (interaction) {
            await announceJackpot({ guildDoc: claimed, interaction, wonAmount, newPool: seedAmount }).catch(() => {});
        }

        return { triggered: true, wonAmount, newPool: seedAmount };
    }

    // Not triggered — grow the pool
    await Guild.updateOne({ guildId }, {
        $inc: {
            'casinoJackpot.pool':      contribution,
            'casinoJackpot.betsCount': 1,
        },
    });

    const currentPool = (guild.casinoJackpot?.pool ?? seedAmount) + contribution;
    return { triggered: false, newPool: currentPool };
}

async function announceJackpot({ guildDoc, interaction, wonAmount, newPool }) {
    const { EmbedBuilder } = require('discord.js');
    const channelId = guildDoc?.casinoJackpot?.announceChannelId ?? guildDoc?.economy?.announcementChannelId ?? null;
    const channel   = channelId
        ? (interaction.guild?.channels?.cache?.get(channelId) ?? interaction.channel)
        : interaction.channel;

    const embed = new EmbedBuilder()
        .setColor('#FF00FF')
        .setThumbnail(interaction.user.displayAvatarURL())
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
