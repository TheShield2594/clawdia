const { Schema, model } = require('mongoose');

const aiUsageSchema = new Schema({
    guildId:      { type: String, required: true, index: true },
    provider:     { type: String, required: true },
    model:        { type: String, required: true },
    // ISO date string (YYYY-MM-DD, UTC) — one row per guild/provider/model/day.
    day:          { type: String, required: true },
    inputTokens:  { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    requestCount: { type: Number, default: 0 },
    updatedAt:    { type: Date, default: Date.now }
});

aiUsageSchema.index(
    { guildId: 1, day: 1, provider: 1, model: 1 },
    { unique: true }
);

module.exports = model('AIUsage', aiUsageSchema);
