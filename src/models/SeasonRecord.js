const { Schema, model } = require('mongoose');

const seasonRecordSchema = new Schema({
    guildId:    { type: String, required: true },
    seasonId:   { type: String, required: true },
    seasonName: { type: String, default: null },
    startedAt:  { type: Date, required: true },
    endedAt:    { type: Date, required: true },
    top10: [{
        userId:   { type: String, required: true },
        username: { type: String, default: 'Unknown' },
        coins:    { type: Number, default: 0 }
    }],
    createdAt:  { type: Date, default: Date.now }
});

seasonRecordSchema.index({ guildId: 1, endedAt: -1 });

module.exports = model('SeasonRecord', seasonRecordSchema);
