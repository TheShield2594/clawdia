'use strict';

const { Schema, model } = require('mongoose');

const entrySchema = new Schema({
    userId:      { type: String, required: true },
    username:    { type: String, required: true },
    fishName:    { type: String, required: true },
    fishEmoji:   { type: String, default: '🐟' },
    tier:        { type: String, required: true },
    score:       { type: Number, required: true },  // coin value used for ranking
    caughtAt:    { type: Date,   required: true },
    isBossKill:  { type: Boolean, default: false }  // boss encounter win during tournament
}, { _id: false });

const tournamentSchema = new Schema({
    guildId: { type: String, required: true },

    status:    { type: String, enum: ['scheduled', 'active', 'ended'], default: 'scheduled' },
    startedAt: { type: Date, default: null },
    endsAt:    { type: Date, required: true },

    prizePool:    { type: Number, default: 0 },
    entryFee:     { type: Number, default: 0 },
    seedAmount:   { type: Number, default: 0 },

    announceChannelId:   { type: String, default: null },
    leaderboardMessageId: { type: String, default: null },

    entries: [entrySchema],

    prizes: [{
        place:   { type: Number },
        userId:  { type: String },
        amount:  { type: Number },
        paidOut: { type: Boolean, default: false }
    }],

    winnersAnnouncedAt: { type: Date, default: null }
}, { timestamps: true });

// Every lookup this collection gets asks for a guild *and* a status —
// tournamentService reads `{ guildId, status: 'active' }` before each cast that
// might score, and `{ guildId, status: { $in: [...] } }` before starting one. A
// single-field index on guildId (which is what this schema declared) narrows to
// the guild and then scans every tournament that guild has ever run, and the
// documents being scanned carry the whole entries array.
//
// `guildId` alone stays covered as this index's prefix, so nothing is lost by
// dropping the single-field one — migration 016 removes it, since Mongoose
// leaves an index it built earlier exactly where it is (#585).
tournamentSchema.index({ guildId: 1, status: 1 }, { name: 'idx_tournament_guild_status' });

module.exports = model('FishingTournament', tournamentSchema);
