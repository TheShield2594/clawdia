const { Schema, model } = require('mongoose');

const tempBanSchema = new Schema({
    guildId:     { type: String, required: true },
    userId:      { type: String, required: true },
    moderatorId: { type: String, required: true },
    reason:      { type: String, default: 'Temporary ban' },
    expiresAt:   { type: Date, required: true },
    createdAt:   { type: Date, default: Date.now }
});

tempBanSchema.index({ expiresAt: 1 });
tempBanSchema.index({ guildId: 1, userId: 1 }, { unique: true });

module.exports = model('TempBan', tempBanSchema);
