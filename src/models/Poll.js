const mongoose = require('mongoose');

const pollSchema = new mongoose.Schema({
    messageId: { type: String, required: true, unique: true },
    guildId: { type: String, required: true },
    channelId: { type: String, required: true },
    question: { type: String, required: true },
    options: [String],
    votes: { type: Map, of: Number, default: () => new Map() },
    endsAt: Date,
    closed: { type: Boolean, default: false },
    // The creator's tag, for display in the poll embed.
    createdBy: String,
    // The creator's user id, so a data-erasure request can find the polls a
    // member created (#1158) — the tag alone changes and is not a key.
    createdById: { type: String, default: null }
});

module.exports = mongoose.model('Poll', pollSchema);
