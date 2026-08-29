'use strict';

// The draw and the paytable for `/casino keno`, lifted out of keno.js (#785).
//
// keno.js measured 19.8% lines / 12.7% branches: the debit was covered by
// #623's guard tests and the paytable — the thing that decides whether a
// player is handed back 1× or 150× — had never been looked up under test,
// because it sat behind a ten-step animated draw driven by a collector.
//
// The pool shuffle takes an injectable rng so a test can fix the draw.

const POOL_SIZE  = 40;
const PICK_COUNT = 5;
const DRAW_COUNT = 10;

// Approximate RTP ~92% (hypergeometric: P2≈27.8%, P3≈7.9%, P4≈0.96%, P5≈0.038%)
// EV = 0.278×1 + 0.079×5 + 0.0096×20 + 0.00038×150 ≈ 0.923
const PAYOUTS = { 2: 1, 3: 5, 4: 20, 5: 150 };
const PAYTABLE_FOOTER = `2 matches = ${PAYOUTS[2]}× · 3 = ${PAYOUTS[3]}× · 4 = ${PAYOUTS[4]}× · 5 = ${PAYOUTS[5]}×`;

/** Ten of forty, ascending. `rng` returns a float in [0, 1) — Math.random by default. */
function drawNumbers(rng = Math.random) {
    const pool = Array.from({ length: POOL_SIZE }, (_, i) => i + 1);
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, DRAW_COUNT).sort((a, b) => a - b);
}

/** How many of the player's picks came up. */
function countHits(picked, drawn) {
    return picked.filter(n => drawn.includes(n)).length;
}

/** The multiplier for a hit count — 0 for anything below two matches. */
function payoutMultiplier(hits) {
    return PAYOUTS[hits] ?? 0;
}

/** What the player is handed back, stake included. 0 is a loss, not a push. */
function payoutFor(bet, hits) {
    return Math.floor(bet * payoutMultiplier(hits));
}

/** Picks that landed within 2 of a drawn number without being drawn themselves. */
function nearMissCount(picked, drawn) {
    return picked.filter(p => drawn.some(d => Math.abs(d - p) <= 2 && !drawn.includes(p))).length;
}

module.exports = {
    POOL_SIZE, PICK_COUNT, DRAW_COUNT, PAYOUTS, PAYTABLE_FOOTER,
    drawNumbers, countHits, payoutMultiplier, payoutFor, nearMissCount,
};
