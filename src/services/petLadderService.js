'use strict';

/**
 * The ranked pet ladder (#1185): an Elo-style rating per pet that only rated
 * member battles move, matchmaking rules on who may fight a rated battle, and
 * seasons that pull every rating part-way back toward the middle.
 *
 * Raw PvP win counts rewarded volume — the pet that fought most topped the
 * board. A rating rewards beating pets that are good, and three rules keep it
 * from being farmed:
 *
 *  - a rated battle is fought level-matched, as a wager is, so the rating
 *    measures the pet and its owner's reads rather than time spent grinding;
 *  - both pets must be within RATING_BAND of each other;
 *  - two owners may fight at most SAME_OPPONENT_DAILY_CAP rated battles
 *    against each other in any 24 hours, whichever pets they field.
 *
 * The arithmetic is utils/duelElo.js's, shared with ranked duels: the same
 * expected score, the same zero-sum update and the same soft reset toward
 * 1200 at a season's end. The season clock is the ladder's own rather than
 * `Guild.rankedDuels`, which is gated on ranked duels being enabled and tuned
 * for coin duels.
 *
 * @module services/petLadderService
 */

const Guild     = require('../models/Guild');
const User      = require('../models/User');
const PetLadder = require('../models/PetLadder');
const { handlesGuild } = require('../utils/sharding');
const { applyElo, softResetElo, tierFor, makeSeasonId, SOFT_RESET_TARGET } = require('../utils/duelElo');
const { postAnnouncement } = require('../utils/guildAnnounce');
const COLORS = require('../utils/embedColors');

const LADDER_START_RATING     = SOFT_RESET_TARGET; // the middle every season pulls toward
const LADDER_K_FACTOR         = 32;
const RATING_BAND             = 300;
const SAME_OPPONENT_DAILY_CAP = 3;
const LADDER_SEASON_DAYS      = 30;
const LADDER_TITLES           = ['Ladder Champion', 'Ladder Runner-Up', 'Ladder Third'];
const DAY_MS = 86_400_000;
const WRITE_ATTEMPTS = 3;

const seasonEnd = (now, days = LADDER_SEASON_DAYS) => new Date(now + days * DAY_MS);

/** The guild's ladder, created on first use with season 1 starting now. */
async function getLadder(guildId, now = Date.now()) {
    try {
        const doc = await PetLadder.findOneAndUpdate(
            { guildId },
            { $setOnInsert: { seasonNumber: 1, seasonStartedAt: new Date(now), seasonEndsAt: seasonEnd(now), rev: 0, ratings: {} } },
            { upsert: true, new: true },
        );
        return doc?.toObject ? doc.toObject() : doc;
    } catch (err) {
        // Two first-ever rated battles in a guild racing the upsert: the loser
        // hits the unique index, and the ladder the winner made is the one.
        if (err?.code !== 11000) throw err;
        return PetLadder.findOne({ guildId }).lean();
    }
}

/** A pet's standing this season, or the unrated default. */
function entryOf(ladder, petRef) {
    const stored = ladder?.ratings?.[String(petRef)];
    return {
        rating: LADDER_START_RATING, peak: LADDER_START_RATING,
        wins: 0, losses: 0, games: 0, recent: [],
        ...(stored ?? {}),
        exists: !!stored,
    };
}

/** How many rated battles the two owners have fought against each other in the last day. */
function ratedFightsBetween(ladder, userA, userB, now = Date.now()) {
    const since = now - DAY_MS;
    let n = 0;
    for (const entry of Object.values(ladder?.ratings ?? {})) {
        if (entry?.userId !== userA) continue;
        n += (entry.recent ?? []).filter(r => r.vs === userB && new Date(r.at).getTime() > since).length;
    }
    return n;
}

/**
 * Whether two owners may fight a rated battle at all right now — the daily
 * cap, before either pet is chosen. `{ ok: true }` or `{ ok: false, reason }`.
 */
function ratedPairAllowed(ladder, userA, userB, now = Date.now()) {
    if (ratedFightsBetween(ladder, userA, userB, now) >= SAME_OPPONENT_DAILY_CAP) {
        return { ok: false, reason: `you've already fought **${SAME_OPPONENT_DAILY_CAP}** rated battles against each other today — try again tomorrow, or fight a friendly match` };
    }
    return { ok: true };
}

/** Whether two pets are close enough in rating for a rated battle. */
function withinBand(ladder, petRefA, petRefB) {
    return Math.abs(entryOf(ladder, petRefA).rating - entryOf(ladder, petRefB).rating) <= RATING_BAND;
}

/** The full rated check for two chosen pets: the cap, then the band. */
function ratedEligibility(ladder, a, b, now = Date.now()) {
    const pair = ratedPairAllowed(ladder, a.userId, b.userId, now);
    if (!pair.ok) return pair;
    if (!withinBand(ladder, a.petRef, b.petRef)) {
        const ra = entryOf(ladder, a.petRef).rating, rb = entryOf(ladder, b.petRef).rating;
        return { ok: false, reason: `the pets are rated **${ra}** and **${rb}** — more than ${RATING_BAND} apart, the limit for a rated battle` };
    }
    return { ok: true };
}

function nextEntry(entry, side, now) {
    const { exists: _exists, ...kept } = entry;
    const since = now - DAY_MS;
    return {
        ...kept,
        userId: side.userId,
        petId:  side.petId,
        name:   side.name ?? null,
        rating: side.newRating,
        peak:   Math.max(entry.peak ?? LADDER_START_RATING, side.newRating),
        wins:   (entry.wins ?? 0) + (side.won ? 1 : 0),
        losses: (entry.losses ?? 0) + (side.won ? 0 : 1),
        games:  (entry.games ?? 0) + 1,
        recent: [...(entry.recent ?? []).filter(r => new Date(r.at).getTime() > since), { vs: side.vs, at: new Date(now) }],
    };
}

/** The filter term pinning one entry to the version it was read at. */
function entryGuard(petRef, entry) {
    return entry.exists
        ? { [`ratings.${petRef}.games`]: entry.games ?? 0 }
        : { [`ratings.${petRef}`]: { $exists: false } };
}

/**
 * Record a rated result: both pets' new ratings, peaks, records and the
 * same-opponent log, in one conditional write on the ladder. The filter pins
 * the season and both entries' versions, so a write computed from numbers
 * someone else has since changed misses, and is recomputed from a fresh read.
 *
 * The cap is asked again of that fresh read: two rated battles between the
 * same owners resolving at once cannot both slip under it.
 *
 * `winner` and `loser` are `{ userId, petRef, petId, name }`. Resolves to
 * `{ rated: true, seasonId, winner: { before, after, delta }, loser: {…} }`,
 * or `{ rated: false, reason }` when it could not be recorded.
 */
async function recordRatedResult(guildId, winner, loser, now = Date.now()) {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
        const ladder = await getLadder(guildId, now);
        const pair = ratedPairAllowed(ladder, winner.userId, loser.userId, now);
        if (!pair.ok) return { rated: false, reason: 'cap' };

        const w = entryOf(ladder, winner.petRef);
        const l = entryOf(ladder, loser.petRef);
        const { winnerNewElo, loserNewElo, winnerDelta, loserDelta } = applyElo(w.rating, l.rating, LADDER_K_FACTOR);

        const filter = {
            guildId,
            seasonNumber: ladder.seasonNumber,
            ...entryGuard(winner.petRef, w),
            ...entryGuard(loser.petRef, l),
        };
        const update = {
            $set: {
                [`ratings.${winner.petRef}`]: nextEntry(w, { ...winner, newRating: winnerNewElo, won: true,  vs: loser.userId  }, now),
                [`ratings.${loser.petRef}`]:  nextEntry(l, { ...loser,  newRating: loserNewElo,  won: false, vs: winner.userId }, now),
            },
            $inc: { rev: 1 },
        };
        const written = await PetLadder.findOneAndUpdate(filter, update, { new: true });
        if (written) {
            return {
                rated: true,
                seasonId: makeSeasonId(ladder.seasonNumber),
                winner: { before: w.rating, after: winnerNewElo, delta: winnerDelta },
                loser:  { before: l.rating, after: loserNewElo,  delta: loserDelta },
            };
        }
    }
    return { rated: false, reason: 'conflict' };
}

/** The ladder's rated pets, highest rating first. */
function standings(ladder) {
    return Object.entries(ladder?.ratings ?? {})
        .filter(([, e]) => (e?.games ?? 0) > 0)
        .map(([petRef, e]) => ({ petRef, ...e }))
        .sort((a, b) => b.rating - a.rating || b.wins - a.wins);
}

/**
 * The rating leaderboard rows: the top rated pets that are still with their
 * owners, each joined to the live pet so its current name and stage show.
 */
async function ratingLeaderboard(guildId, limit = 10) {
    const ladder = await PetLadder.findOne({ guildId }).lean();
    const top = standings(ladder).slice(0, limit * 2);
    if (top.length === 0) return { seasonId: makeSeasonId(ladder?.seasonNumber ?? 1), rows: [] };
    const owners = await User.find({ guildId, userId: { $in: [...new Set(top.map(e => e.userId))] } }, 'userId pets').lean();
    const pets = new Map();
    for (const owner of owners) for (const pet of owner.pets ?? []) pets.set(String(pet._id), pet);
    const rows = top
        .filter(e => pets.has(e.petRef))
        .slice(0, limit)
        .map(e => ({ ...e, pet: pets.get(e.petRef), tier: tierFor(e.rating) }));
    return { seasonId: makeSeasonId(ladder.seasonNumber), seasonEndsAt: ladder.seasonEndsAt, rows };
}

/** Every entry soft-reset for a new season: rating pulled halfway to the middle, record cleared. */
function resetRatings(ratings) {
    const out = {};
    for (const [petRef, e] of Object.entries(ratings ?? {})) {
        const rating = softResetElo(e.rating ?? LADDER_START_RATING);
        out[petRef] = { ...e, rating, peak: rating, wins: 0, losses: 0, games: 0, recent: [] };
    }
    return out;
}

/**
 * Close one ladder's season: claim the rollover (the season number and `rev`
 * it was read at, so a rated battle landing in between makes it wait for the
 * next tick rather than be erased), soft-reset every rating, title the top
 * three pets and post the recap. Returns the podium, or null when another
 * run got there first or a battle moved the ladder.
 */
async function rollLadderSeason(client, ladder, now = Date.now()) {
    const guildId = ladder.guildId;
    const seasonId = makeSeasonId(ladder.seasonNumber);
    const podium = standings(ladder).slice(0, LADDER_TITLES.length);

    const claimed = await PetLadder.findOneAndUpdate(
        { guildId, seasonNumber: ladder.seasonNumber, rev: ladder.rev ?? 0 },
        {
            $set: {
                seasonNumber:    ladder.seasonNumber + 1,
                seasonStartedAt: new Date(now),
                seasonEndsAt:    seasonEnd(now),
                ratings:         resetRatings(ladder.ratings),
            },
            $inc: { rev: 1 },
        },
        { new: true },
    );
    if (!claimed) return null;

    // The title is the badge on the companion card. A pet released since has
    // nowhere to wear it, and the write simply matches nothing.
    for (let i = 0; i < podium.length; i++) {
        const e = podium[i];
        await User.updateOne(
            { guildId, userId: e.userId, pets: { $elemMatch: { _id: e.petRef } } },
            { $set: { 'pets.$.ladderTitle': `${seasonId} ${LADDER_TITLES[i]}` } },
        ).catch(err => console.error('[petLadder] title write failed:', err.message));
    }

    const guildDoc = await Guild.findOne({ guildId }).select('economy').lean().catch(() => null);
    const channelId = guildDoc?.economy?.announcementChannelId ?? null;
    if (channelId && podium.length > 0) {
        const { EmbedBuilder } = require('discord.js');
        const medals = ['🥇', '🥈', '🥉'];
        const lines = podium.map((e, i) =>
            `${medals[i]} **${e.name ?? 'A pet'}** — ${tierFor(e.rating).icon} **${e.rating}** (${e.wins}W / ${e.losses}L) — <@${e.userId}>`);
        const embed = new EmbedBuilder()
            .setColor(COLORS.RARE)
            .setTitle(`🏆 Pet Ladder — ${seasonId} has ended`)
            .setDescription(lines.join('\n'))
            .setFooter({ text: `${makeSeasonId(ladder.seasonNumber + 1)} starts now — every rating moves halfway back toward ${LADDER_START_RATING}.` })
            .setTimestamp(new Date(now));
        await postAnnouncement(client, guildId, channelId, { embeds: [embed] });
    }
    return podium;
}

/**
 * Roll over every ladder whose season has ended. Registered in
 * services/scheduler/index.js; nothing here schedules itself.
 */
async function resolvePetLadderSeasons(client, now = Date.now()) {
    const due = await PetLadder.find({ seasonEndsAt: { $ne: null, $lte: new Date(now) } }).lean();
    for (const ladder of due) {
        if (!handlesGuild(ladder.guildId, client)) continue;
        try {
            await rollLadderSeason(client, ladder, now);
        } catch (err) {
            console.error(`[petLadder] season rollover failed for guild ${ladder.guildId}:`, err);
        }
    }
}

module.exports = {
    LADDER_START_RATING,
    LADDER_K_FACTOR,
    RATING_BAND,
    SAME_OPPONENT_DAILY_CAP,
    LADDER_SEASON_DAYS,
    LADDER_TITLES,
    getLadder,
    entryOf,
    ratedFightsBetween,
    ratedPairAllowed,
    withinBand,
    ratedEligibility,
    recordRatedResult,
    standings,
    ratingLeaderboard,
    resetRatings,
    rollLadderSeason,
    resolvePetLadderSeasons,
};
