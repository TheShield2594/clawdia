const { Schema, model } = require('mongoose');

const bigWinSchema = new Schema({
    guildId:   { type: String, required: true },
    userId:    { type: String, required: true },
    username:  { type: String, required: true },
    amount:    { type: Number, required: true },
    source:    { type: String, required: true },  // 'hunt', 'fish', 'mine', 'casino_slots', 'casino_crash', 'casino_keno', 'duel'
    details:   { type: require('mongoose').Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now },
});

bigWinSchema.index({ guildId: 1, createdAt: -1 });
bigWinSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

module.exports = model('BigWin', bigWinSchema);
