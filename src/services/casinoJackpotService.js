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
 *
 * The pool is the one place in the casino where coins exist outside anybody's
 * balance — the same shape as `/duel`'s escrow, and the reason the economy audit
 * (#873) came here next. A pot that is claimed and not delivered is not a
 * misreported number; it is coins destroyed. A pot delivered twice is coins
 * minted. Everything below is arranged around making both impossible:
 *
 *   the claim      one atomic update that resets the pool, records the exact
 *                  amount claimed and mints the payout key for it, so there is
 *                  no window where the pot is gone and nothing says how much it
 *                  was or who it belongs to
 *   the credit     `creditCoinsOrOwe` under that key — retried, verified, and
 *                  written down as an owed payout when it will not land
 *   the recovery   `reconcileJackpotClaims` on the next boot, and
 *                  `npm run payouts:replay`, both under the same key, so the
 *                  three of them together still pay exactly once
 */

const { randomUUID } = require('crypto');

const Guild = require('../models/Guild');
const User  = require('../models/User');
const { logTransaction } = require('../utils/logTransaction');
const { creditCoinsOrOwe } = require('../utils/creditOrOwe');
const { jackpotPayoutKey } = require('../utils/payoutKey');

const BASE_TRIGGER_RATE  = 0.0001;  // 0.01%
const TRIGGER_INCREMENT  = 0.00001; // 0.001% per bet
const HOT_POOL_THRESHOLD = 500_000; // 🔥 indicator above this amount
const DEFAULT_SEED       = 10_000;  // mirrors Guild.casinoJackpot.seedAmount's default

const SERVICE = 'casinoJackpot';

// How many outstanding claims one boot settles. A bound rather than a target:
// the normal number is zero, and a hundred of them means an outage during which
// every guild's credit failed — worth working through a batch at a time instead
// of holding startup open on a database that has just come back.
const MAX_RECONCILE_PER_BOOT = 100;

/**
 * Clears the outstanding marker for a settled claim.
 *
 * Keyed rather than blind: a slow settle must not clear the marker of a *newer*
 * claim. Two wins seconds apart leave two keys, and the one this credit belongs
 * to is the only one it may say is finished — clearing the other would strand a
 * pot that is still owed somewhere no recovery path looks.
 *
 * `claimToken` goes with it. Nothing writes that field any more — the sweep
 * below used to take it as a lease — and clearing it here retires the values
 * left on documents by the version that did.
 */
async function clearClaim(guildId, payoutKey) {
    await Guild.updateOne(
        { guildId, 'casinoJackpot.pendingPayoutKey': payoutKey },
        { $set: { 'casinoJackpot.pendingPayoutKey': null, 'casinoJackpot.claimToken': null } },
    ).catch(err => console.error(`[${SERVICE}] clearing the settled claim failed:`, err.message));
}

/**
 * Claims the entire pool for one player, reseeds it, and credits the win.
 *
 * The claim is a single update-pipeline write and it does four things at once:
 * reseeds the pool, records who won, records *how much* — computed from the pool
 * as it stood at the start of the same write — and mints the payout key that
 * every later attempt at this credit is guarded by.
 *
 * The amount used to be a second, unawaited `updateOne` sent after the claim,
 * which is one write too many for the field the restart reconciler pays from: a
 * process that died in between left the pot reset, the new winner recorded and
 * the *previous* winner's amount still sitting in `lastWonAmount`, and the
 * reconciler paid that number to this player. Two writes cannot hold one fact.
 *
 * `extra` is added to the claimed pool — the triggering bet's own contribution,
 * which processJackpotBet has not written yet at the moment it claims.
 *
 * The credit is not transactionally linked to the claim (replica-set
 * transactions are not assumed here), so the pot is claimed before any credit is
 * attempted and the marker outlives the attempt. What that leaves is an unpaid
 * winner with a durable record of the debt, in up to three places that cannot
 * double-pay each other: the owed payout `creditCoinsOrOwe` files for
 * `npm run payouts:replay`, the marker `reconcileJackpotClaims` picks up on the
 * next boot, and the key both of them credit under.
 *
 * The pool is *not* rolled back when the credit fails, which is the change #873
 * made here. Restoring it and recording the debt are mutually exclusive
 * recoveries — do both and the pot is paid twice — and the restore is only the
 * right one if the credit definitely did not land, which an unkeyed `$inc`
 * retried three times can never establish. It could not: a write that commits
 * and loses its response is indistinguishable from one that never ran, so the
 * old rollback put the pool back under a player who had already been paid, and
 * the retry above it paid a second time whenever the first attempt had actually
 * committed.
 *
 * Returns `{ claimed, credited, owed, wonAmount, newPool }`. `claimed: false`
 * means no pot was taken and there is nothing to pay or record — the caller is
 * free to fall back. `claimed: true, credited: false` means the pot is the
 * player's and has not arrived yet; `owed` says whether that is written down.
 */
async function awardPool({ guildId, userId, username, seedAmount, extra = 0, note = 'Progressive jackpot win', interaction = null }) {
    const payoutKey = jackpotPayoutKey(guildId, randomUUID());

    // Two stages rather than one $set, so that the amount is read from the pool
    // before the same write reseeds it. A single stage would be correct — every
    // expression in one $set is evaluated against the stage's input document —
    // but "correct because of how $set evaluates" is not what this write should
    // rest on when getting it wrong claims a pot of `seedAmount` for a pool
    // worth twenty times that.
    //
    // $literal around the two strings because they land in a pipeline, where a
    // value beginning with `$` is a field path and not the text. A username is
    // not ours to promise never starts with one.
    //
    // The marker holds one claim at a time, so a guild that drops a second
    // jackpot while the first is still unpaid overwrites it and the boot-time
    // sweep loses sight of the first. The owed payout is what carries that one:
    // it is the durable record, and this is the second chance. A field that held
    // every outstanding claim would close the gap, and is not worth a growing
    // array on the guild document for a case that needs a failed credit and a
    // 0.01% trigger in the same guild before the debt is settled.
    const claimed = await Guild.findOneAndUpdate(
        { guildId },
        [
            {
                $set: {
                    'casinoJackpot.lastWonAmount': {
                        $add: [{ $ifNull: ['$casinoJackpot.pool', seedAmount] }, extra],
                    },
                },
            },
            {
                $set: {
                    'casinoJackpot.pool':             seedAmount,
                    'casinoJackpot.betsCount':        0,
                    'casinoJackpot.lastWinnerId':     { $literal: userId },
                    'casinoJackpot.lastWinnerName':   { $literal: username },
                    'casinoJackpot.lastWonAt':        '$$NOW',
                    'casinoJackpot.pendingPayoutKey': { $literal: payoutKey },
                },
            },
        ],
        { updatePipeline: true, new: true },
    );

    // No document, no pool. The pot is the guild's accumulated contributions and
    // a guild without a document has none; crediting `seedAmount` here would pay
    // a five-figure pot nobody ever played for. Both callers guard for this
    // ahead of the claim, so reaching it means the document went away in
    // between — still nothing claimed, and nothing owed.
    if (!claimed) {
        return { claimed: false, credited: false, owed: false, wonAmount: 0, newPool: seedAmount };
    }

    const wonAmount = claimed.casinoJackpot?.lastWonAmount ?? 0;

    const { credited, owed, doc } = await creditCoinsOrOwe(
        { userId, guildId },
        wonAmount,
        { payoutKey, service: SERVICE, jobName: 'jackpot' },
    );

    if (credited) {
        await clearClaim(guildId, payoutKey);
        if (wonAmount > 0) {
            // `doc` is absent when the key found the payout already applied —
            // here that can only be an attempt of this same call that committed
            // and lost its response, since the key was minted above and nothing
            // else has seen it. So the entry is still this call's to file, and
            // the balance is read back rather than the entry dropped: this is
            // the largest payout the casino makes and the ledger is where an
            // operator goes looking for it.
            const after = doc ?? await User.findOne({ userId, guildId }, 'balance').lean().catch(() => null);
            logTransaction({
                userId,
                guildId,
                type:    'casino_jackpot',
                amount:  wonAmount,
                balance: after?.balance ?? 0,
                note,
            });
        }
    } else {
        console.error(
            `[${SERVICE}] CRITICAL: ${wonAmount} coins claimed for ${userId} in guild ${guildId} ` +
            `could not be credited — ${owed ? 'recorded as owed' : 'NOT recorded'}, key ${payoutKey}`,
        );
    }

    if (interaction) {
        await announceJackpot({ guildDoc: claimed, interaction, wonAmount, newPool: seedAmount, credited, owed }).catch(() => {});
    }

    return { claimed: true, credited, owed, wonAmount, newPool: seedAmount };
}

/**
 * Settles jackpot claims that were taken out of a pool and never delivered.
 *
 * Runs on boot, from events/ready.js, because the failure this exists for is a
 * process that stopped between claiming the pot and crediting it — there is no
 * live caller left to retry, and the marker is the only thing that knows.
 *
 * It used to decide "has this already been paid?" by looking for a matching
 * `casino_jackpot` row in the transaction log. That log is written
 * fire-and-forget and documents that it never throws, so its absence proves
 * nothing: a credit that landed and whose ledger entry did not is
 * indistinguishable from a credit that never happened, and the reconciler paid
 * the pot again. Clearing on a *match* was no better — every restart wiped the
 * `/casino jackpot` last-winner display of any guild whose entry it did find.
 *
 * Now the question is not asked at all. The credit carries the claim's own
 * payout key, so an attempt against a pot that has already been paid moves no
 * coins by construction, and the marker — not the ledger — says whether
 * anything is outstanding.
 *
 * There is no lease. One used to be taken — a `claimToken` written onto the
 * guild before the credit — and it could strand a payout permanently: a process
 * that stopped after stamping its token left a claim no later run would ever
 * select, because every run mints a different one and the filter only matched
 * `null` or its own. A lease that can outlive the process holding it is a worse
 * failure than the work it saves, and there is no work to save here: N shards
 * all crediting the same pot is safe by construction, since the credit carries
 * the claim's payout key and only one of them can move coins. So the sweep reads
 * the outstanding claims and settles them, and two shards racing settle one pot
 * between them.
 *
 * Reading the set up front rather than re-querying is also what bounds the loop:
 * a claim whose marker will not clear is visited once and not selected again.
 *
 * Note for the upgrade: a claim left unpaid by a process that died *before* this
 * shipped carries no marker, and is not reconciled here. Nothing can pick those
 * out — the old code left `lastWinnerId` and `lastWonAmount` set on successful
 * wins too, which is exactly the ambiguity the ledger probe was trying and
 * failing to resolve. They are recoverable by hand from those fields and the
 * CRITICAL line the failed credit logged.
 */
async function reconcileJackpotClaims({ limit = MAX_RECONCILE_PER_BOOT } = {}) {
    const outstanding = await Guild
        .find({ 'casinoJackpot.pendingPayoutKey': { $ne: null } }, 'guildId casinoJackpot')
        .limit(limit)
        .lean();

    let reconciled = 0;
    let failed     = 0;

    for (const candidate of outstanding) {
        const guildId = candidate.guildId;
        const { lastWinnerId, lastWonAmount, pendingPayoutKey } = candidate.casinoJackpot ?? {};

        // A marker with no winner or nothing to pay names no payout. Clearing it
        // is the only thing to do with it; leaving it would stall every later
        // claim in this guild behind a record nobody can settle.
        if (!lastWinnerId || !(lastWonAmount > 0)) {
            console.error(`[${SERVICE}] claim ${pendingPayoutKey} in guild ${guildId} names no payout — clearing it`);
            await clearClaim(guildId, pendingPayoutKey);
            continue;
        }

        // A failure here files a second owed record for a pot `awardPool` may
        // already have written down — the live attempt records what it could not
        // pay, and so does this one. Two records, one key: whichever the replay
        // reaches first pays, and the other settles as a duplicate. Duplicated
        // bookkeeping is the acceptable half of that trade; the case this covers
        // is a process that died before it could write anything down at all.
        const { credited, doc } = await creditCoinsOrOwe(
            { userId: lastWinnerId, guildId },
            lastWonAmount,
            { payoutKey: pendingPayoutKey, service: SERVICE, jobName: 'jackpot_reconcile' },
        );

        if (!credited) {
            // The marker stays, because the pot is still owed, and the next boot
            // picks it up. Stopping rather than working through the rest: the
            // reason a credit fails here is almost always that the database is
            // unreachable, and the guild after this one will fail the same way.
            failed++;
            break;
        }

        // Absent `doc` means the key found the payout already applied — the
        // credit did land, its response was lost, and there is nothing to log.
        if (doc) {
            logTransaction({
                userId:  lastWinnerId,
                guildId,
                type:    'casino_jackpot',
                amount:  lastWonAmount,
                balance: doc.balance ?? 0,
                note:    'jackpot reconciliation on restart',
            });
            console.log(`[${SERVICE}] reconciled a jackpot payout of ${lastWonAmount} to ${lastWinnerId} in guild ${guildId}`);
            reconciled++;
        }
        await clearClaim(guildId, pendingPayoutKey);
    }

    return { reconciled, failed };
}

/**
 * Contributes `bet` coins to the guild's progressive jackpot pool and checks whether
 * the jackpot triggers this bet.
 *
 * Returns `{ triggered, wonAmount, newPool }`, where `triggered` means a pot was
 * won *and paid*: a claim whose credit has not landed is reported as `owed`
 * instead, so nothing downstream counts a win the player has not received.
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
        const { credited, owed, wonAmount, newPool } = await awardPool({
            guildId, userId, username, seedAmount, interaction,
            extra: contribution,
        });
        return { triggered: credited, owed: owed ?? false, wonAmount, newPool };
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
 * credit the win itself: on `credited` the coins are already in the winner's
 * balance and a `casino_jackpot` transaction is logged; on `claimed` without
 * `credited` the pot is still theirs and is being recovered under its key, so
 * paying anything in its place would pay the same win twice.
 *
 * The spin's own 0.5% contribution races this claim, because processJackpotBet is
 * fired and forgotten from placeWager. Either order is fine — the contribution
 * lands in the pot being claimed or in the fresh seed, and never twice.
 *
 * Returns `{ claimed, credited, owed, wonAmount, newPool }`.
 */
async function claimJackpot({ guildId, userId, username, note = 'Progressive jackpot win' }) {
    const guild = await Guild.findOne({ guildId }, 'casinoJackpot').lean();
    // No document means no pool: the claim would match nothing, and the caller
    // needs to hear that no pot was taken so it can fall back. The same guard
    // processJackpotBet opens with.
    if (!guild) return { claimed: false, credited: false, owed: false, wonAmount: 0, newPool: DEFAULT_SEED };

    const seedAmount = guild.casinoJackpot?.seedAmount ?? DEFAULT_SEED;
    return awardPool({ guildId, userId, username, seedAmount, note });
}

async function announceJackpot({ guildDoc, interaction, wonAmount, newPool, credited = true, owed = false }) {
    const { EmbedBuilder } = require('discord.js');
    const channelId = guildDoc?.casinoJackpot?.announceChannelId ?? guildDoc?.economy?.announcementChannelId ?? null;
    const channel   = channelId
        ? (interaction.guild?.channels?.cache?.get(channelId) ?? interaction.channel)
        : interaction.channel;

    // Announced either way, and worded from what actually happened. The pot is
    // won at the claim, not at the credit, and this announcement is the only
    // thing that ever tells a player the random trigger fired for them — going
    // quiet on a failed credit leaves them never knowing, on top of not being
    // paid.
    const outcome = credited
        ? `  💰 Won: **${wonAmount.toLocaleString()}** coins\n`
        : `  💰 Won: **${wonAmount.toLocaleString()}** coins — not delivered yet\n` +
          (owed
              ? '  📝 Recorded for an admin to settle\n'
              : '  ⚠️ Could not be recorded — tell an admin\n');

    const embed = new EmbedBuilder()
        .setColor('#FF00FF')
        .setThumbnail(interaction.user.displayAvatarURL())
        .setTitle('🎰 ✨ PROGRESSIVE JACKPOT ✨ 🎰')
        .setDescription(
            `${interaction.user} just **triggered the progressive jackpot!** 🎊\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            outcome +
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
    reconcileJackpotClaims,
    getJackpotDisplay,
    HOT_POOL_THRESHOLD,
    DEFAULT_SEED,
};
