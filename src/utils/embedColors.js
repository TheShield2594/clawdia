'use strict';

/**
 * The colours an embed uses to say what kind of thing just happened (#664).
 *
 * There were sixty-one distinct hex literals across a hundred and twenty files
 * and no module holding any of them, so the same event wore a different colour
 * depending on which command produced it. Success was `#2ecc71` in the economy,
 * `#00ff00` in moderation, `#4caf50` when a pet was adopted and `#00cc55` out
 * on an expedition; failure was `#e74c3c`, `#ff0000`, `#ff3333`, `#ff6b6b` and
 * `#c0392b`. None of that was a decision anyone made — it is what happens when
 * every call site picks its own red.
 *
 * Seven roles, one value each:
 *
 *   SUCCESS  it worked — bought, claimed, unbanned, crafted, equipped
 *   ERROR    it failed, was refused, or was cancelled against the user's wish
 *   WARN     confirm first, or something needs attention but nothing is broken
 *   INFO     a listing, a profile, a settings readout — a neutral statement
 *   NEUTRAL  nothing happened: expired, timed out, empty, no longer running
 *   RARE     the uncommon and the earned — prestige, ranked tiers, rare finds
 *   PRIZE    a win, a payout, a leaderboard — the moment worth celebrating
 *
 * PRIZE is a seventh the issue's six did not name, and it earns its place the
 * same way the others do: `#ffd700` was retyped in twenty-one files, all of
 * them saying "you won something". Leaving it out would have left the largest
 * single family of repeated literals exactly where it was.
 *
 * ── What this deliberately does not cover ──────────────────────────────────
 *
 * A colour that belongs to one feature rather than to an outcome is that
 * feature's own, and stays where it is used: mining's browns, the magenta a
 * progressive jackpot arrives in, the near-black of an apex predator, the
 * severity ramp in the hunt and fishing failure embeds, the masthead of the
 * weekly newspaper. Those were never the problem the issue described — nobody
 * is confused about which command they are in. Flattening them into these
 * seven would trade a real inconsistency for a real loss.
 *
 * The rule that separates them: a hex spelling one of these roles across
 * several features belongs here. A hex that only ever appears inside a single
 * feature is that feature's identity, and belongs at its call sites.
 * tests/embedColors.test.js holds that line.
 */
// Imported as a namespace — `const COLORS = require(...)` and `COLORS.SUCCESS`
// — so a call site reads as the role it means without a bare `SUCCESS` floating
// loose in a nine-hundred-line command file.
module.exports = Object.freeze({
    SUCCESS: '#2ecc71',
    ERROR:   '#e74c3c',
    WARN:    '#f39c12',
    INFO:    '#5865f2',
    NEUTRAL: '#95a5a6',
    RARE:    '#9b59b6',
    PRIZE:   '#ffd700',
});
