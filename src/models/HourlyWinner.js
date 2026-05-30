const { Schema, model } = require('mongoose');

// Tracks the current leader per guild+hour+category for micro-competitions.
// hour format: 'YYYY-MM-DDTHH' (UTC)
// category: 'fish' | 'mine' | 'hunt'
// value: rarity score (fish) or payout coins (mine/hunt)
const hourlyWinnerSchema = new Schema({
    guildId:  { type: String, required: true },
    hour:     { type: String, required: true },
    category: { type: String, required: true },
    userId:   { type: String, required: true },
    username: { type: String, required: true },
    value:    { type: Number, required: true },
    details:  { type: String, default: null },
    rewarded: { type: Boolean, default: false },
});

hourlyWinnerSchema.index({ guildId: 1, hour: 1, category: 1 }, { unique: true });
hourlyWinnerSchema.index({ hour: 1 });

module.exports = model('HourlyWinner', hourlyWinnerSchema);
