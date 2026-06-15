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
    partyState: { type: Schema.Types.Mixed, default: {} },
    active: { type: Boolean, default: true },
    statCardMessageId: { type: String, default: null }
}, { timestamps: true });

dmSessionSchema.index({ guildId: 1, channelId: 1, active: 1 });

module.exports = model('DmSession', dmSessionSchema);
