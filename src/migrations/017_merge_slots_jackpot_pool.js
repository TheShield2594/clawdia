const mongoose = require('mongoose');

// The retired pool's seed. Anything above it is coins players actually fed in,
// a flat 10 per spin; the seed itself was house money.
const LEGACY_SLOTS_SEED = 5000;

// Guild.casinoJackpot.seedAmount's default, for documents that somehow reached
// this point with no progressive pool of their own to add to.
const PROGRESSIVE_SEED = 10000;

/**
 * Folds each guild's retired slots-only jackpot pool into the shared
 * progressive pool, and drops the fields it lived in.
 *
 * The casino ran two progressive pools at once and gave them the same name.
 * `/casino jackpot` reported `casinoJackpot.pool` — seeded at 10,000, fed 0.5%
 * of every casino bet, dropped on a random per-bet trigger. Slots reported
 * `slots.jackpotPool` under the label "🏆 Jackpot Pool" — seeded at 5,000, fed a
 * flat 10 a spin, won on Triple Wild. One spin paid into both and each embed
 * showed its own total, so a player who ran `/casino jackpot` and then spun was
 * told two different figures for what reads as one prize.
 *
 * Slots now plays for the shared pool like every other game, which leaves
 * `slots.jackpotPool` holding real coins that no command can pay out any more.
 * This moves them.
 *
 * Only the balance above the old 5,000 seed carries over. Mongoose applied that
 * default to every Guild document it ever created, spun or not, so carrying the
 * whole figure would mint 5,000 coins into servers that never touched the slot
 * machine — and `$max` pins the floor at zero rather than at a debt for any
 * document sitting below the seed.
 *
 * One aggregation-pipeline update per document, so the read of the old value and
 * the write of the new total cannot interleave with a spin landing mid-migration.
 * Idempotent by construction: the filter stops matching the moment the field is
 * unset, so a re-run — or a second process racing this one — folds nothing twice.
 */
module.exports = {
    name: '017_merge_slots_jackpot_pool',

    // The old per-guild figure is unset, not recorded, so the split between the
    // two pools cannot be reconstructed afterwards; the pre-migration backup is
    // the only place it survives. Rolling back to a pre-merge image still *runs*
    // — that build's schema carries its own 5,000 default, so slots finds a pool
    // where it expects one — it just finds the players' coins in the other pot.
    irreversible: true,

    async up() {
        const guilds = mongoose.connection.db.collection('guilds');

        const result = await guilds.updateMany(
            { 'slots.jackpotPool': { $exists: true } },
            [
                {
                    $set: {
                        'casinoJackpot.pool': {
                            $add: [
                                { $ifNull: ['$casinoJackpot.pool', PROGRESSIVE_SEED] },
                                { $max: [0, { $subtract: [{ $ifNull: ['$slots.jackpotPool', 0] }, LEGACY_SLOTS_SEED] }] },
                            ],
                        },
                    },
                },
                {
                    $unset: [
                        'slots.jackpotPool',
                        'slots.lastJackpotWinner',
                        'slots.lastJackpotAmount',
                        'slots.lastJackpotAt',
                    ],
                },
            ],
        );

        if (result.modifiedCount > 0) {
            console.log(`[MIGRATIONS] 017: folded ${result.modifiedCount} slots jackpot pool(s) into the progressive jackpot.`);
        }
    },
};
