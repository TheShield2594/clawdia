const { Schema, model } = require('mongoose');

// Tracks the current leader per guild+hour+category for micro-competitions.
// hour format: 'YYYY-MM-DDTHH' (UTC)
// category: 'fish' | 'mine' | 'hunt' | 'explore'
// value: rarity score (fish) or payout coins (mine/hunt/explore)
const hourlyWinnerSchema = new Schema({
    guildId:   { type: String, required: true },
    hour:      { type: String, required: true },
    category:  { type: String, required: true },
    userId:    { type: String, required: true },
    username:  { type: String, required: true },
    value:     { type: Number, required: true },
    details:   { type: String, default: null },
    rewarded:  { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
});

hourlyWinnerSchema.index({ guildId: 1, hour: 1, category: 1 }, { unique: true });
hourlyWinnerSchema.index({ hour: 1 });
hourlyWinnerSchema.index({ createdAt: 1 }, { expireAfterSeconds: 48 * 3600 });

module.exports = model('HourlyWinner', hourlyWinnerSchema);
