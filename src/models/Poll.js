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
    createdBy: String
});

module.exports = mongoose.model('Poll', pollSchema);
