const { Schema, model } = require('mongoose');

const syndicateSchema = new Schema({
    syndicateId:      { type: String, required: true },
    guildId:          { type: String, required: true },
    name:             { type: String, required: true, maxlength: 32 },
    nameLower:        { type: String, required: true },  // lowercase of name; used for unique index
    tag:              { type: String, default: null, maxlength: 5 },
    leaderId:         { type: String, required: true },
    memberIds:        [{ type: String }],
    heat:             { type: Number, default: 0, min: 0, max: 100 },
    lastHeistAt:      { type: Date, default: null },
    lifetimeEarnings: { type: Number, default: 0 },
    heistCount:       { type: Number, default: 0 },
    openToJoin:       { type: Boolean, default: false },
    pendingInvites:   [{ type: String }],
    createdAt:        { type: Date, default: Date.now },
    updatedAt:        { type: Date, default: Date.now },
});

// Case-insensitive unique name enforcement via normalized field
syndicateSchema.index({ syndicateId: 1 }, { unique: true });
syndicateSchema.index({ guildId: 1, nameLower: 1 }, { unique: true });
syndicateSchema.index({ guildId: 1, lifetimeEarnings: -1 });

syndicateSchema.pre('save', function(next) {
    this.nameLower = this.name.toLowerCase();
    this.updatedAt = Date.now();
    next();
});

module.exports = model('Syndicate', syndicateSchema);
