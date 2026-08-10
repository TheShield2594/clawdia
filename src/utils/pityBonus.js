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

/**
 * Per-activity vocabulary for the streak field. Kept side by side so the three
 * minigames keep a consistent voice.
 */
const PITY_COPY = {
    hunt: {
        buildingTitle: 'Bad Run',
        activeTitle:   'Steadying Your Aim',
        streakNoun:    'straight misses',
        missNoun:      'miss',
        missNounPlural:'misses',
        attemptNoun:   'hunt',
    },
    fishing: {
        buildingTitle: 'Slow Water',
        activeTitle:   'Reading the Water',
        streakNoun:    'casts without a bite',
        missNoun:      'cast',
        missNounPlural:'casts',
        attemptNoun:   'cast',
    },
    mining: {
        buildingTitle: 'Barren Rock',
        activeTitle:   'Finding the Seam',
        streakNoun:    'dry swings',
        missNoun:      'swing',
        missNounPlural:'swings',
        attemptNoun:   'swing',
    },
};

/**
 * Discord embed field showing where the player sits on the pity curve.
 *
 * Failure-embed only — a success resets the streak, so there is nothing to show.
 * Without it the curve is invisible: a dry run just looks like bad luck with no
 * reason to believe it will let up.
 *
 * `copy` is one of the PITY_COPY presets.
 */
function buildPityStreakField(consecutiveFails, limits, copy) {
    const fails     = consecutiveFails ?? 0;
    const threshold = limits.PITY_CONSECUTIVE_FAILS;
    const stacks    = Math.min(Math.max(0, fails - threshold + 1), threshold);

    const barLen    = 16;
    const filledLen = Math.min(barLen, Math.round((Math.min(fails, threshold) / threshold) * barLen));
    const bar       = '█'.repeat(filledLen) + '░'.repeat(barLen - filledLen);

    if (stacks > 0) {
        const bonus = Math.round(stacks * limits.PITY_BONUS_PER_STACK * 100);
        const maxed = stacks >= threshold;
        return {
            name:  `⚡ ${copy.activeTitle} — ${fails} ${copy.streakNoun}`,
            value: `\`${bar}\`\n**+${bonus}% success** on your next ${copy.attemptNoun}${maxed ? ' *(max)*' : ' — climbing with every one'}`,
            inline: false,
        };
    }

    const remaining = threshold - fails;
    return {
        name:  `❄️ ${copy.buildingTitle} — ${fails}/${threshold}`,
        value: `\`${bar}\`\n${remaining} more ${remaining === 1 ? copy.missNoun : copy.missNounPlural} and pity kicks in: `
             + `**+${Math.round(limits.PITY_BONUS_PER_STACK * 100)}% success**, growing with each one after.`,
        inline: false,
    };
}

module.exports = { getPityBonus, buildPityStreakField, PITY_COPY };
