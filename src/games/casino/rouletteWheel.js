'use strict';
const { secureRandom } = require('../../utils/secureRandom');

/**
 * The roulette wheel and the table's bets, as data and pure functions.
 *
 * Nothing here touches Discord, the database or a canvas, so the rules can be
 * tested exhaustively: which pockets a bet covers, where each number sits on
 * the wheel, and the frames the spin is drawn in.
 *
 * @module games/casino/rouletteWheel
 */

/**
 * The single-zero European wheel, clockwise from zero.
 *
 * The strip the game used to draw walked 0, 1, 2 … 36 in numeric order, which
 * no wheel does — it put 10 and 11 side by side in black and 18 and 19 in red.
 * The real order alternates colours all the way round.
 */
const WHEEL_ORDER = Object.freeze([
    0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10,
    5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
]);

const POCKETS = WHEEL_ORDER.length;

/** Where each number sits on the wheel: `WHEEL_INDEX[n]` is its position in WHEEL_ORDER. */
const WHEEL_INDEX = Object.freeze(WHEEL_ORDER.reduce((acc, n, i) => { acc[n] = i; return acc; }, []));

const RED_NUMBERS = new Set([
    1, 3, 5, 7, 9, 12, 14, 16, 18,
    19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

/** @returns {'green'|'red'|'black'} */
function colorOf(n) {
    if (n === 0) return 'green';
    return RED_NUMBERS.has(n) ? 'red' : 'black';
}

function pocketEmoji(n) {
    const c = colorOf(n);
    if (c === 'green') return '🟢';
    if (c === 'red')   return '🔴';
    return '⚫';
}

/**
 * Every bet the table takes. `short` is the label drawn on the felt, where
 * space is tight; `label` is what the embed says.
 */
const BETS = Object.freeze({
    red:    { label: 'Red',               short: 'RED',        payout: 1,  matches: n => colorOf(n) === 'red'    },
    black:  { label: 'Black',             short: 'BLACK',      payout: 1,  matches: n => colorOf(n) === 'black'  },
    odd:    { label: 'Odd',               short: 'ODD',        payout: 1,  matches: n => n !== 0 && n % 2 === 1  },
    even:   { label: 'Even',              short: 'EVEN',       payout: 1,  matches: n => n !== 0 && n % 2 === 0  },
    low:    { label: 'Low (1–18)',        short: '1–18',       payout: 1,  matches: n => n >= 1 && n <= 18       },
    high:   { label: 'High (19–36)',      short: '19–36',      payout: 1,  matches: n => n >= 19 && n <= 36      },
    dozen1: { label: '1st Dozen (1–12)',  short: '1st 12',     payout: 2,  matches: n => n >= 1  && n <= 12      },
    dozen2: { label: '2nd Dozen (13–24)', short: '2nd 12',     payout: 2,  matches: n => n >= 13 && n <= 24      },
    dozen3: { label: '3rd Dozen (25–36)', short: '3rd 12',     payout: 2,  matches: n => n >= 25 && n <= 36      },
    col1:   { label: 'Column 1',          short: 'COLUMN 1',   payout: 2,  matches: n => n !== 0 && n % 3 === 1  },
    col2:   { label: 'Column 2',          short: 'COLUMN 2',   payout: 2,  matches: n => n !== 0 && n % 3 === 2  },
    col3:   { label: 'Column 3',          short: 'COLUMN 3',   payout: 2,  matches: n => n !== 0 && n % 3 === 0  },
    number: { label: 'Straight Number',   short: 'STRAIGHT',   payout: 35, matches: (n, target) => n === target  },
});

/** "Red", or "Straight #17". */
function describeBet(betKey, target) {
    if (betKey === 'number') return `Straight #${target}`;
    return BETS[betKey].label;
}

/** The label drawn on the felt: "RED", or "#17". */
function shortBet(betKey, target) {
    if (betKey === 'number') return `#${target}`;
    return BETS[betKey].short;
}

function betOdds(betKey) {
    const payout = BETS[betKey]?.payout;
    return payout ? `${payout}:1` : '';
}

/** Every pocket the bet wins on, in numeric order. */
function coveredNumbers(betKey, target) {
    const bet = BETS[betKey];
    const out = [];
    for (let n = 0; n < POCKETS; n++) if (bet.matches(n, target)) out.push(n);
    return out;
}

/** A pocket number, uniformly. */
function spin(random = secureRandom) {
    return Math.floor(random() * POCKETS);
}

/** How many pockets apart two numbers sit on the wheel, the short way round. */
function wheelDistance(a, b) {
    const d = Math.abs(WHEEL_INDEX[a] - WHEEL_INDEX[b]);
    return Math.min(d, POCKETS - d);
}

/**
 * The nearest pocket to `result` on the wheel that the bet would have won on,
 * if it is right next door — "so close" material. Null otherwise.
 *
 * Only asked for single-number bets: on an outside bet half the wheel is a win,
 * and a neighbour that would have paid is noise, not a near miss.
 */
function nearMiss(result, betKey, target) {
    if (betKey !== 'number') return null;
    return wheelDistance(result, target) === 1 ? target : null;
}

/**
 * The frames the spin is drawn in, ending on the result.
 *
 * Each frame is where the wheel and the ball are, in radians, and how long the
 * frame stays up before the next replaces it. The wheel turns clockwise and the
 * ball runs anticlockwise round the track, both slowing; the ball drops off the
 * track on the second-to-last frame, a pocket or two from home, and settles in
 * the result on the last.
 *
 * Few frames, held long, because every one is an edit to a Discord message and
 * an image upload: a flurry of short ones queues behind the rate limit and the
 * wheel stutters instead of slowing.
 *
 * The final wheel angle puts the result at twelve o'clock, under the marker,
 * so the pocket that won is where the eye goes.
 *
 * @param {number} result      the pocket the ball lands in
 * @param {() => number} [random]  source of the start angle and the bounce
 * @returns {{ wheel: number, ball: number, onTrack: boolean, speed: number, holdMs: number }[]}
 */
function spinFrames(result, random = secureRandom) {
    const step = (Math.PI * 2) / POCKETS;
    const TOP  = -Math.PI / 2;
    // Wheel angle is the rotation applied to the wheel image, whose pocket 0 is
    // drawn at twelve o'clock; rotating by -index·step brings `result` there.
    const finalWheel = -WHEEL_INDEX[result] * step;

    // How far each frame is from the end, as a fraction of the spin, and how
    // long it holds. Front-loaded motion, back-loaded time: the ease-out.
    const SCHEDULE = [
        { t: 0.00, holdMs: 650  },
        { t: 0.38, holdMs: 750  },
        { t: 0.64, holdMs: 900  },
        { t: 0.82, holdMs: 1100 },
        { t: 0.94, holdMs: 1300 },
        { t: 1.00, holdMs: 0    },
    ];
    const WHEEL_TRAVEL = Math.PI * 2 * 1.5;   // the wheel turns a turn and a half
    const BALL_TRAVEL  = Math.PI * 2 * 4;     // the ball runs four laps
    // The start is random, so no two spins open on the same picture.
    const jitter = random() * Math.PI * 2;
    // The bounce: the ball drops a pocket or two either side of home first.
    const bounce = (random() < 0.5 ? -1 : 1) * (1 + Math.floor(random() * 2)) * step;

    return SCHEDULE.map(({ t, holdMs }, i) => {
        const left = 1 - t;
        // Cubic ease-out: distance still to cover falls off as (1-t)^3.
        const remaining = left ** 3;
        const last = i === SCHEDULE.length - 1;
        const dropping = i === SCHEDULE.length - 2;
        return {
            wheel:   finalWheel - WHEEL_TRAVEL * remaining + (remaining > 0 ? jitter * remaining : 0),
            ball:    last ? TOP : dropping ? TOP + bounce : TOP + BALL_TRAVEL * remaining + jitter * remaining,
            onTrack: !last && !dropping,
            speed:   left ** 2,
            holdMs,
        };
    });
}

/**
 * The number under the ball in a frame: the pocket whose centre, once the
 * wheel is turned by `frame.wheel`, is nearest the ball's angle.
 */
function pocketUnderBall(frame) {
    const step = (Math.PI * 2) / POCKETS;
    const k = Math.round((frame.ball + Math.PI / 2 - frame.wheel) / step);
    return WHEEL_ORDER[((k % POCKETS) + POCKETS) % POCKETS];
}

module.exports = {
    WHEEL_ORDER,
    WHEEL_INDEX,
    POCKETS,
    RED_NUMBERS,
    BETS,
    colorOf,
    pocketEmoji,
    describeBet,
    shortBet,
    betOdds,
    coveredNumbers,
    spin,
    wheelDistance,
    nearMiss,
    spinFrames,
    pocketUnderBall,
};
