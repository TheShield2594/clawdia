/**
 * Progressive casino jackpot pool — fed by all casino bets at a configurable rate.
 *
 * Trigger probability starts at 0.01% and increases by 0.001% with each eligible bet,
 * resetting after each drop.
 *
 * This is the *only* jackpot pool. Slots used to keep a second one of its own
 * (`slots.jackpotPool`: seeded at 5,000, grown by a flat 10 a spin, won on Triple
 * Wild) and label it "Jackpot Pool" in its embed — the same words `/casino jackpot`
 * uses for this pool. A player who ran both saw two different totals for what reads
 * as one prize, because both were true and neither was the same pot (#794 follow-up).
 * Slots now reads and claims this pool like every other game, and
 * migration 017 folded whatever the retired pool had accumulated into this one.
 */

const Guild = require('../models/Guild');
const User  = require('../models/User');
const { logTransaction } = require('../utils/logTransaction');

const BASE_TRIGGER_RATE  = 0.0001;  // 0.01%
const TRIGGER_INCREMENT  = 0.00001; // 0.001% per bet
const HOT_POOL_THRESHOLD = 500_000; // 🔥 indicator above this amount
const DEFAULT_SEED       = 10_000;  // mirrors Guild.casinoJackpot.seedAmount's default

/**
 * Claims the entire pool for one player, reseeds it, and credits the win.
 *
 * The pool reset and winner metadata are applied atomically via findOneAndUpdate
 * (new: false), so wonAmount is computed from the pre-update document — preventing
 * stale reads from concurrent bets. Two winners landing at once settle cleanly: the
 * first takes the accumulated pool, the second takes the fresh seed. Nothing is
 * minted and nobody gets zero.
 *
 * The user credit happens immediately after and is not transactionally linked
 * (replica-set transactions are not assumed), but the pool is already claimed
 * before any credit attempt, so the worst failure mode is an unpaid winner that
 * can be reconciled from the lastWinnerId/lastWonAmount fields.
 *
 * `extra` is added to the claimed pool — the triggering bet's own contribution,
 * which processJackpotBet has not written yet at the moment it claims.
 *
 * Returns { credited, wonAmount, newPool }. On a failed credit the pool is restored
 * and `wonAmount` is what the player *would* have won, so callers can fall back.
 */
async function awardPool({ guildId, userId, username, seedAmount, extra = 0, note = 'Progressive jackpot win', interaction = null }) {
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
    const wonAmount = poolAtWin + extra;

    // Persist the exact amount won now that we know it
    Guild.updateOne({ guildId }, { $set: { 'casinoJackpot.lastWonAmount': wonAmount } }).catch(err => console.error('[casinoJackpot] lastWonAmount persist failed:', err.message));

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
        // The claim above set the pool to seedAmount; restore it to
        // poolAtWin + extra. Using the $inc delta (rather than $set)
        // preserves contributions from bets that landed in between.
        //
        // Clearing the winner fields in the same update matters: the restart
        // reconciler in events/ready.js pays out any guild still carrying a
        // lastWinnerId/lastWonAmount, and the coins are back in the pool now —
        // leaving them set would pay this win a second time out of a pot
        // somebody else is playing for.
        const restoreDelta = poolAtWin + extra - seedAmount;
        await Guild.updateOne({ guildId }, {
            $inc: { 'casinoJackpot.pool': restoreDelta },
            $set: { 'casinoJackpot.lastWinnerId': null, 'casinoJackpot.lastWinnerName': null, 'casinoJackpot.lastWonAmount': null },
        }).catch(err => console.error('[CasinoJackpot] pool restore also failed:', err));
        return { credited: false, wonAmount, newPool: poolAtWin + extra };
    }

    logTransaction({
        userId,
        guildId,
        type:    'casino_jackpot',
        amount:  wonAmount,
        balance: updatedUser?.balance ?? 0,
        note,
    });

    if (interaction) {
        await announceJackpot({ guildDoc: claimed, interaction, wonAmount, newPool: seedAmount }).catch(() => {});
    }

    return { credited: true, wonAmount, newPool: seedAmount };
}

/**
 * Contributes `bet` coins to the guild's progressive jackpot pool and checks whether
 * the jackpot triggers this bet.
 *
 * Returns { triggered, wonAmount, newPool }.
 */
async function processJackpotBet({ guildId, userId, username, bet, interaction }) {
    const guild = await Guild.findOne({ guildId }, 'casinoJackpot');
    if (!guild) return { triggered: false };

    const rate       = guild.casinoJackpot?.contributionRate ?? 0.005;
    const seedAmount = guild.casinoJackpot?.seedAmount       ?? DEFAULT_SEED;
    const betsCount  = guild.casinoJackpot?.betsCount        ?? 0;

    const contribution  = Math.max(1, Math.floor(bet * rate));
    const triggerChance = BASE_TRIGGER_RATE + (betsCount * TRIGGER_INCREMENT);
    const triggered     = Math.random() < triggerChance;

    if (triggered) {
        const { credited, wonAmount, newPool } = await awardPool({
            guildId, userId, username, seedAmount, interaction,
            extra: contribution,
        });
        if (!credited) return { triggered: false, newPool };
        return { triggered: true, wonAmount, newPool };
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

/**
 * Awards the whole pool to a player whose game dealt them its own jackpot hand —
 * slots' Triple Wild — rather than the random per-bet trigger. The caller must not
 * credit the win itself: the coins are already in the winner's balance when this
 * resolves, and a `casino_jackpot` transaction is logged so the restart reconciler
 * knows the payout landed.
 *
 * The spin's own 0.5% contribution races this claim, because processJackpotBet is
 * fired and forgotten from placeWager. Either order is fine — the contribution
 * lands in the pot being claimed or in the fresh seed, and never twice.
 *
 * Returns { credited, wonAmount, newPool }.
 */
async function claimJackpot({ guildId, userId, username, note = 'Progressive jackpot win' }) {
    const guild      = await Guild.findOne({ guildId }, 'casinoJackpot').lean();
    const seedAmount = guild?.casinoJackpot?.seedAmount ?? DEFAULT_SEED;
    return awardPool({ guildId, userId, username, seedAmount, note });
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
    const pool  = guild?.casinoJackpot?.pool ?? DEFAULT_SEED;
    const hot   = pool >= HOT_POOL_THRESHOLD;
    return { pool, hot, display: `${hot ? '🔥 ' : '🏆 '}**${pool.toLocaleString()}** coins` };
}

module.exports = {
    processJackpotBet,
    claimJackpot,
    getJackpotDisplay,
    HOT_POOL_THRESHOLD,
    DEFAULT_SEED,
};
