const { Schema, model } = require('mongoose');

const summaryJobSchema = new Schema({
    guildId:         { type: String, required: true, index: true },
    sourceChannelId: { type: String, required: true },
    targetChannelId: { type: String, required: true },
    hour:            { type: Number, default: 9,  min: 0, max: 23 },
    minute:          { type: Number, default: 0,  min: 0, max: 59 },
    label:           { type: String, default: 'Daily Summary' },
    enabled:         { type: Boolean, default: true },
    lastRun:         { type: Date, default: null },
    createdAt:       { type: Date, default: Date.now }
});

module.exports = model('SummaryJob', summaryJobSchema);
