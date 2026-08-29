const { Schema, model } = require('mongoose');

const dmCharacterSchema = new Schema({
    userId: { type: String, required: true },
    name: { type: String, required: true },
    characterClass: { type: String, required: true },
    hp: { type: Number, default: 100 },
    inventory: { type: [String], default: [] }
}, { _id: false });

const dmSessionSchema = new Schema({
    sessionId: { type: String, required: true, unique: true },
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true, index: true },
    hostId: { type: String, required: true },
    players: { type: [dmCharacterSchema], default: [] },
    storyLog: { type: [String], default: [] },
    // Where the party is and how many turns deep they are (#837). This was a
    // `Mixed` field nothing ever wrote to — a schema that promised state
    // tracking and delivered an empty object. The DM now sets `scene` through a
    // `set_scene` effect, which is what lets a campaign resumed after a restart
    // (or trimmed past the opening scene by the storyLog `$slice`) still know
    // what room everyone is standing in.
    partyState: {
        scene:     { type: String, default: null },
        turns:     { type: Number, default: 0 },
        updatedAt: { type: Date,   default: null }
    },
    active: { type: Boolean, default: true },
    statCardMessageId: { type: String, default: null }
}, { timestamps: true });

dmSessionSchema.index({ guildId: 1, channelId: 1, active: 1 });

module.exports = model('DmSession', dmSessionSchema);
