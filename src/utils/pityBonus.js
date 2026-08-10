'use strict';

/**
 * Success-chance bonus granted by a run of consecutive failures.
 *
 * Nothing accrues until the streak reaches `PITY_CONSECUTIVE_FAILS`. From there
 * each further failure adds one `PITY_BONUS_PER_STACK` stack, capped at
 * `PITY_CONSECUTIVE_FAILS` stacks — so with the standard 4 / 0.15 settings the
 * 4th consecutive miss is worth +15% and the 7th and beyond +60%.
 *
 * Hunting, fishing and mining all share this curve; keeping it here stops the
 * three from drifting apart.
 */
function getPityBonus(consecutiveFails, limits) {
    const threshold = limits.PITY_CONSECUTIVE_FAILS;
    const stacks    = Math.min(
        Math.max(0, (consecutiveFails ?? 0) - threshold + 1),
        threshold
    );
    return stacks * limits.PITY_BONUS_PER_STACK;
}

module.exports = { getPityBonus };
