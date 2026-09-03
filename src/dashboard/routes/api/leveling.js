const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const User = require('../../../models/User');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');
const { isValidDiscordId, readAdjustAmount, MAX_ADJUST_TOTAL } = require('../../lib/apiHelpers');
const { readPage, pageEnvelope } = require('../../lib/apiPage');
const { normalizeLevelProgress, xpToAdvance } = require('../../../services/levelingService');

// One page of members ranked by level then XP, 25 to a page.
router.get('/guild/:guildId/leveling/leaderboard', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;
    const { page, limit, skip } = readPage(req, { defaultLimit: 25, maxLimit: 25 });
    try {
        const [users, total] = await Promise.all([
            User.find({ guildId, $or: [{ level: { $gt: 0 } }, { xp: { $gt: 0 } }] }).sort({ level: -1, xp: -1 }).skip(skip).limit(limit).select('userId level xp messages'),
            User.countDocuments({ guildId, $or: [{ level: { $gt: 0 } }, { xp: { $gt: 0 } }] })
        ]);
        res.json(pageEnvelope({
            items: users.map((u, i) => ({ rank: skip + i + 1, userId: u.userId, level: u.level, xp: u.xp, messages: u.messages })),
            total,
            page,
            limit
        }));
    } catch (err) {
        console.error('Leveling leaderboard error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// How many times a settle will re-read and try again after losing its guard.
// Each loss is a real concurrent write to this one member, so the bound is about
// giving up on a pathologically contended document rather than about retrying a
// likely race.
const SETTLE_ATTEMPTS = 5;

/**
 * Whether a document's XP is where its level says it should be: below the
 * threshold for advancing out of that level.
 *
 * @param {{ level: number, xp: number }} doc
 * @returns {boolean}
 */
function isSettled(doc) {
    return (doc.xp || 0) < xpToAdvance(doc.level);
}

/**
 * Fold a member's XP into levels after an adjustment, and persist the result.
 *
 * The adjustment itself is a pipeline update so the ceiling clamp is atomic, but
 * a pipeline cannot express the catch-up: working out how many levels a pile of
 * XP buys is a quadratic solve, not an arithmetic expression over the document.
 * So the fold is a second write — a compare-and-set on the whole `(level, xp)`
 * pair it was computed from.
 *
 * The pair, not the XP alone. Guarding on XP is an ABA check: a `set_level`
 * landing in between moves `level` while a following give can put `xp` back on
 * the value this read, and the settle would then write a level derived from the
 * level that has since been replaced, silently undoing it.
 *
 * A no-op when the pair is already consistent, which is the ordinary case: a
 * give that does not cross a threshold writes nothing here.
 *
 * @param {object} filter    the `{ userId, guildId }` the adjustment matched
 * @param {object} user      the document the adjustment returned
 * @returns {Promise<object>} the document as it now stands, which the caller
 *                            must check with `isSettled` rather than assume
 */
async function settleLevel(filter, user) {
    let current = user;
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
        if (isSettled(current)) return current;

        const written = await User.findOneAndUpdate(
            { ...filter, level: current.level, xp: current.xp },
            { $set: normalizeLevelProgress(current.level, current.xp) },
            { new: true },
        );
        if (written) return written;

        const reread = await User.findOne(filter).select('userId level xp');
        if (!reread) return current;
        current = reread;
    }
    return current;
}

// Gives, takes, resets or sets one member's XP or level.
router.post('/guild/:guildId/leveling/adjust', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const { userId, action, amount } = req.body;
    if (!userId || !isValidDiscordId(String(userId))) return res.status(400).json({ error: 'userId must be a valid Discord snowflake' });
    if (!action || !['give', 'take', 'reset', 'set_level'].includes(action)) {
        return res.status(400).json({ error: 'action must be give, take, reset, or set_level' });
    }
    // Same ceilings as the economy route (#925): an XP total or a level past
    // Number.MAX_SAFE_INTEGER stops being exact, and an unbounded XP grant is an
    // unbounded catch-up loop in applyXpGain the next time the member speaks.
    let amt = null;
    if (['give', 'take', 'set_level'].includes(action)) {
        const read = action === 'set_level'
            ? readAdjustAmount(amount, { min: 0, max: MAX_ADJUST_TOTAL, label: 'level' })
            : readAdjustAmount(amount);
        if (read.error) return res.status(400).json({ error: read.error });
        amt = read.value;
    }
    try {
        const filter = { userId: String(userId), guildId };
        let update;
        // Mongoose 9 throws on a pipeline update that does not opt in — see
        // tests/updatePipelineOption.test.js.
        const options = { new: true };
        if (action === 'give') {
            // Clamped inside the update rather than after a read, for the reason
            // the economy route's give explains.
            // `level` is written as itself so a document predating the field
            // comes back with a number rather than an absent one — the settle's
            // compare-and-set has to be able to name it.
            update = [{ $set: {
                xp:    { $min: [MAX_ADJUST_TOTAL, { $add: [{ $ifNull: ['$xp', 0] }, amt] }] },
                level: { $ifNull: ['$level', 0] },
            } }];
            options.updatePipeline = true;
        } else if (action === 'take') {
            update = [{ $set: {
                xp:    { $max: [0, { $subtract: [{ $ifNull: ['$xp', 0] }, amt] }] },
                level: { $ifNull: ['$level', 0] },
            } }];
            options.updatePipeline = true;
        } else if (action === 'reset') {
            update = { $set: { xp: 0, level: 0 } };
        } else {
            // XP is progress within the current level, so the level a moderator
            // sets means "at the start of level N" and its XP is zero (#924).
            // Leaving the old XP behind is what let the next message re-derive a
            // different level and undo the adjustment on the spot.
            update = { $set: { level: amt, xp: 0 } };
        }
        // No upsert (#584) — see the note on the economy adjust route: a mistyped
        // snowflake is still a well-formed one, and upserting turned it into a
        // phantom member document instead of an error the admin could act on.
        const user = await User.findOneAndUpdate(filter, update, options);
        if (!user) return res.status(404).json({ error: 'That member has no leveling record in this server' });

        // `give` and `take` move XP without touching the level it implies, and
        // the leaderboard sorts by `{ level: -1, xp: -1 }` — so until this runs,
        // a 50,000 XP grant left the member ranked where they were and only
        // caught up whenever they next happened to speak (#924).
        const settled = ['give', 'take'].includes(action) ? await settleLevel(filter, user) : user;

        // `settled: false` only when the compare-and-set lost every attempt, and
        // it says what is true: the XP moved and is durable, but the level it
        // implies is not written yet. Reporting that as a plain success would
        // hand the dashboard a rank the database does not hold. It is not an
        // error either — answering 4xx here would invite the moderator to grant
        // the XP a second time — and the pair does converge, since every writer
        // of this member's XP settles it, the last of them with nobody left to
        // race.
        const body = { success: true, level: settled.level, xp: settled.xp };
        if (!isSettled(settled)) body.settled = false;
        res.json(body);
    } catch (err) {
        console.error('Leveling adjust error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Starts a timed XP multiplier event, replacing any event already running.
router.post('/guild/:guildId/leveling/xp-event', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const { multiplier, durationHours } = req.body;
    const mult = Number(multiplier);
    const hours = Number(durationHours);
    if (!Number.isFinite(mult) || mult < 1.1 || mult > 10) return res.status(400).json({ error: 'multiplier must be between 1.1 and 10' });
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) return res.status(400).json({ error: 'durationHours must be between 1 and 168' });
    try {
        const existing = await Guild.findOne({ guildId }).select('leveling.xpBoostEvent').lean();
        const existingEvent = existing?.leveling?.xpBoostEvent;
        const isActive = existingEvent?.multiplier && existingEvent?.endTime && new Date(existingEvent.endTime).getTime() > Date.now();
        const startTime = new Date();
        const endTime = new Date(startTime.getTime() + hours * 3600 * 1000);
        await Guild.findOneAndUpdate({ guildId }, {
            $set: { 'leveling.xpBoostEvent.multiplier': mult, 'leveling.xpBoostEvent.startTime': startTime, 'leveling.xpBoostEvent.endTime': endTime }
        }, { upsert: true });
        res.json({ success: true, multiplier: mult, startTime, endTime, replacedActive: !!isActive });
    } catch (err) {
        console.error('XP event error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
