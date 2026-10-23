const { Schema, model } = require('mongoose');

// A guild's ranked pet ladder (#1185): the current season and every rated
// pet's standing in it, in one document.
//
// One document per guild, not one per pet, so that a rated battle can move
// both pets' ratings in a single conditional write — the filter pins both
// entries to the versions the new ratings were computed from, and the season
// number, so a concurrent rated fight or a rollover makes the write miss
// instead of landing on stale numbers. See services/petLadderService.js.
//
// `ratings` is keyed by the pet's `_id` (a hex string, so no dots) and each
// value is:
//   userId, petId, name   the owner and a display snapshot, for the season recap
//   rating, peak          this season's rating and its high point
//   wins, losses, games   this season's rated record; `games` is the entry's
//                         version for the conditional write
//   recent                [{ vs, at }] the rated fights of the last day, by
//                         opposing owner, for the same-opponent cap
//
// `rev` goes up on every rated write, so the season rollover — which rewrites
// every entry — can tell whether a battle landed after it read them.
const petLadderSchema = new Schema({
    guildId:         { type: String, required: true },
    seasonNumber:    { type: Number, default: 1, min: 1 },
    seasonStartedAt: { type: Date, default: Date.now },
    seasonEndsAt:    { type: Date, default: null },
    rev:             { type: Number, default: 0 },
    ratings:         { type: Schema.Types.Mixed, default: () => ({}) },
}, { minimize: false });

petLadderSchema.index({ guildId: 1 }, { unique: true });
// The rollover's query: ladders whose season has run out.
petLadderSchema.index({ seasonEndsAt: 1 });

module.exports = model('PetLadder', petLadderSchema);
