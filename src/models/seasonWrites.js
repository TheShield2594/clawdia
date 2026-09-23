'use strict';

// Persisting season-pass progress: season XP, tier claims, the new-season
// reset, and the daily missions (#873, pass 19).
//
// The flows that grant season XP (`awardSeasonXp`, reached from every quest
// reward), advance a mission (`recordMissionProgress`, from the grind commands,
// /work and /daily) or claim a tier (/season claim, claim-all) did it on the
// loaded document and let `save()` write it. `save()` writes `season` and
// `seasonMissions` back as they were read — the claim paths mark the whole
// `season` object modified — so anything that landed in between through an
// atomic update was erased: a mission /crime, /quiz, /casino or a duel advanced
// (`advanceMissions`), a Tier Skip Token's XP, and a /season unlock, which sets
// `season.premium` in the same write that takes 100,000 coins.
// `optimisticConcurrency` does not catch it: atomic updates do not bump `__v`.
//
// This is the pass-15 effects fix on two more fields. The User model's pre-save
// hook keeps them out of every save of an existing document
// (`detachSeasonWrites`); what the flow did is recorded on the document as
// operations, and the post-save hook commits them as guarded writes
// (`applySeasonWrites`) — save first, then these, as utils/balanceDelta.js does
// for coins.

const OPS_KEY = 'seasonWrites';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The shape a season sub-document starts from. */
function freshSeason(seasonId) {
    return { seasonId, xp: 0, tier: 0, claimedTiers: [], premium: false, claimedPremiumTiers: [], weekXp: 0, weekStart: null };
}

function opsOf(user) {
    const locals = user?.$locals;
    if (!locals) return null;
    return locals[OPS_KEY] ?? (locals[OPS_KEY] = { reset: null, xp: [], claims: [], deal: null, advances: {} });
}

// ── Recorders ────────────────────────────────────────────────────────────────
// Each is a no-op on a plain object (no `$locals`), so code paths that hand
// these a lean read or a test double keep working.

/** A new season began for this player: reset the stored sub-document. */
function recordSeasonReset(user, seasonId) {
    const ops = opsOf(user);
    if (ops && seasonId) ops.reset = seasonId;
}

/**
 * Season XP granted. Recorded as requested, not as the capped amount the
 * in-memory copy computed: the weekly cap is re-applied server-side against the
 * stored week, which is the only copy that knows what else was granted.
 */
function recordSeasonXp(user, amount, { seasonId, weeklyCap = 0, xpPerTier = 100, maxTiers = 50 } = {}) {
    const ops = opsOf(user);
    if (ops && seasonId && amount > 0) ops.xp.push({ amount, seasonId, weeklyCap, xpPerTier, maxTiers });
}

/** A tier's reward claimed on one track. */
function recordTierClaim(user, seasonId, track, tier) {
    const ops = opsOf(user);
    if (ops && seasonId) ops.claims.push({ seasonId, track, tier });
}

/** Today's mission hand, dealt in memory. */
function recordMissionDeal(user, missions, date) {
    const ops = opsOf(user);
    if (ops) ops.deal = { missions, date };
}

/** `step` progress on every mission listening for `event`. */
function recordMissionAdvance(user, event, step) {
    const ops = opsOf(user);
    if (ops && event && step > 0) ops.advances[event] = (ops.advances[event] ?? 0) + step;
}

// ── Detach (pre-save) ────────────────────────────────────────────────────────

/**
 * Every path a `save()` of `doc` would write: the ones the flow modified, and
 * the ones Mongoose filled from a schema default on load. The second set matters
 * as much as the first — a document stored without `seasonMissions` (every user
 * an upsert created, until their first deal) loads with the default `[]` in
 * place, and saves it, over a hand another command dealt in between.
 */
function pendingPaths(doc) {
    const defaults = doc.$__?.activePaths?.getStatePaths?.('default') ?? {};
    return new Set([...(doc.directModifiedPaths?.() ?? []), ...Object.keys(defaults)]);
}

const DETACHED = ['season', 'seasonMissions', 'seasonMissionsDate'];

/**
 * Take `season`, `seasonMissions` and `seasonMissionsDate` out of the pending
 * `save()` of an existing document, and hand back what the flow recorded
 * (clearing it) for `applySeasonWrites` to commit after the save lands. A new
 * document's insert is left whole.
 */
function detachSeasonWrites(doc) {
    if (!doc || doc.isNew) return null;
    for (const path of pendingPaths(doc)) {
        if (DETACHED.some(root => path === root || path.startsWith(`${root}.`))) doc.unmarkModified(path);
    }
    const ops = doc.$locals?.[OPS_KEY];
    if (!ops) return null;
    delete doc.$locals[OPS_KEY];
    const empty = !ops.reset && !ops.xp.length && !ops.claims.length && !ops.deal && !Object.keys(ops.advances).length;
    return empty ? null : ops;
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * The server-side mission advance: `step` progress on every uncompleted mission
 * listening for `event`, touching only `progress` and `completed`, so a
 * `claimed` flag or anything else written at the same moment survives.
 */
function missionAdvancePipeline(event, step) {
    return [{
        $set: {
            seasonMissions: {
                $map: {
                    input: { $ifNull: ['$seasonMissions', []] },
                    as: 'm',
                    in: {
                        $cond: [
                            { $and: [
                                { $eq: ['$$m.event', event] },
                                { $ne: ['$$m.completed', true] },
                            ] },
                            { $let: {
                                vars: { next: { $add: [{ $ifNull: ['$$m.progress', 0] }, step] } },
                                in: {
                                    $mergeObjects: ['$$m', {
                                        // min(next, target) and next >= target, in the
                                        // operators Mongo and the test evaluator share.
                                        progress:  { $cond: [{ $gt: ['$$next', '$$m.target'] }, '$$m.target', '$$next'] },
                                        completed: { $not: [{ $gt: ['$$m.target', '$$next'] }] },
                                    }],
                                },
                            } },
                            '$$m',
                        ],
                    },
                },
            },
        },
    }];
}

/**
 * Grant `amount` season XP server-side: reset a stale season, roll the weekly
 * window, cap the grant against the stored week, add it, and recompute the tier
 * — the rules `awardSeasonXp` applies in memory, applied to the stored copy.
 */
function seasonXpPipeline({ amount, seasonId, weeklyCap, xpPerTier, maxTiers }) {
    const stages = [
        { $set: { season: { $cond: [
            { $eq: [{ $ifNull: ['$season.seasonId', null] }, seasonId] },
            '$season',
            { $literal: freshSeason(seasonId) },
        ] } } },
    ];
    let grant = amount;
    if (weeklyCap > 0) {
        const stale = { $or: [
            { $eq: [{ $ifNull: ['$season.weekStart', null] }, null] },
            { $gte: [{ $subtract: ['$$NOW', '$season.weekStart'] }, WEEK_MS] },
        ] };
        stages.push({ $set: {
            'season.weekStart': { $cond: [stale, '$$NOW', '$season.weekStart'] },
            'season.weekXp':    { $cond: [stale, 0, { $ifNull: ['$season.weekXp', 0] }] },
        } });
        grant = { $max: [0, { $min: [amount, { $subtract: [weeklyCap, '$season.weekXp'] }] }] };
        stages.push({ $set: {
            'season.xp':     { $add: [{ $ifNull: ['$season.xp', 0] }, grant] },
            'season.weekXp': { $add: ['$season.weekXp', grant] },
        } });
    } else {
        stages.push({ $set: { 'season.xp': { $add: [{ $ifNull: ['$season.xp', 0] }, grant] } } });
    }
    stages.push({ $set: { 'season.tier': { $min: [{ $floor: { $divide: ['$season.xp', xpPerTier] } }, maxTiers] } } });
    return stages;
}

/** Reset a season sub-document left over from an earlier season. Guarded, so it is a no-op once current. */
function resetStaleSeason(Model, filter, seasonId) {
    return Model.updateOne(
        { ...filter, 'season.seasonId': { $ne: seasonId } },
        { $set: { season: freshSeason(seasonId) } },
    );
}

/**
 * Mark mission slot `index` claimed, in one guarded write (#873, pass 19).
 *
 * `/season claim-mission` set `claimed` on the loaded document and let `save()`
 * write the whole missions array back. Now that the array never rides a save,
 * the flag is claimed directly — guarded on the same day's hand, the same
 * mission in the slot, and it not being claimed yet, so a double-click or a
 * hand re-dealt in between claims nothing.
 *
 * @returns {Promise<boolean>} true when this call claimed it
 */
async function claimMissionSlot(Model, filter, index, mission, dealtOn) {
    const slot = `seasonMissions.${index}`;
    const res = await Model.updateOne(
        { ...filter, seasonMissionsDate: dealtOn, [`${slot}.id`]: mission.id, [`${slot}.claimed`]: { $ne: true } },
        { $set: { [`${slot}.claimed`]: true } },
    );
    return (res?.matchedCount ?? 0) > 0;
}

/**
 * Commit what a flow recorded, in dependency order: the season reset, today's
 * hand, the mission advances, the XP grants, the tier claims. Each is its own
 * guarded write. Never throws: it runs after a save that has already landed,
 * and a failure here must not turn that save into an error the caller retries.
 */
async function applySeasonWrites(Model, filter, ops) {
    const step = async (label, fn) => {
        try { await fn(); } catch (err) { console.error(`[season] committing ${label} for ${filter.userId} failed:`, err?.message); }
    };

    if (ops.reset) await step('season reset', () => resetStaleSeason(Model, filter, ops.reset));

    if (ops.deal) {
        const { missions, date } = ops.deal;
        // Guarded on the stored date: a hand another command dealt today stands,
        // and the advances below land on it instead.
        await step('mission deal', () => Model.updateOne(
            { ...filter, $or: [
                { seasonMissionsDate: null },
                { seasonMissionsDate: { $exists: false } },
                { seasonMissionsDate: { $lt: date } },
            ] },
            { $set: { seasonMissions: missions, seasonMissionsDate: date } },
        ));
    }

    for (const [event, amount] of Object.entries(ops.advances)) {
        await step(`${event} mission progress`, () => Model.updateOne(filter, missionAdvancePipeline(event, amount), { updatePipeline: true }));
    }

    for (const grant of ops.xp) {
        await step('season XP', () => Model.updateOne(filter, seasonXpPipeline(grant), { updatePipeline: true }));
    }

    const claims = {};
    for (const { seasonId, track, tier } of ops.claims) {
        const field = track === 'premium' ? 'season.claimedPremiumTiers' : 'season.claimedTiers';
        ((claims[seasonId] ??= {})[field] ??= []).push(tier);
    }
    for (const [seasonId, fields] of Object.entries(claims)) {
        const addToSet = Object.fromEntries(Object.entries(fields).map(([f, tiers]) => [f, { $each: tiers }]));
        await step('tier claims', async () => {
            await resetStaleSeason(Model, filter, seasonId);
            await Model.updateOne({ ...filter, 'season.seasonId': seasonId }, { $addToSet: addToSet });
        });
    }
}

module.exports = {
    freshSeason,
    recordSeasonReset, recordSeasonXp, recordTierClaim, recordMissionDeal, recordMissionAdvance,
    detachSeasonWrites, applySeasonWrites,
    missionAdvancePipeline, seasonXpPipeline, resetStaleSeason, claimMissionSlot, pendingPaths,
};
