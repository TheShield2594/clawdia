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
    guildId: { type: String, required: true, index: true },

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

module.exports = model('FishingTournament', tournamentSchema);
