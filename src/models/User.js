const { Schema, model } = require('mongoose');

const userSchema = new Schema({
    userId: { type: String, required: true },
    guildId: { type: String, required: true },
    
    xp: { type: Number, default: 0 },
    level: { type: Number, default: 0 },
    messages: { type: Number, default: 0 },
    lastXpGain: { type: Date, default: null },
    
    balance: { type: Number, default: 0 },
    bank: { type: Number, default: 0 },
    lastDaily: { type: Date, default: null },
    lastWork: { type: Date, default: null },
    
    inventory: [{
        itemId: { type: String, required: true },
        quantity: { type: Number, default: 1 }
    }],
    
    warnings: { type: Number, default: 0 },
    kicks: { type: Number, default: 0 },
    bans: { type: Number, default: 0 },
    
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

userSchema.index({ userId: 1, guildId: 1 }, { unique: true });

userSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = model('User', userSchema);