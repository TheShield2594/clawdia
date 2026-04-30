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

    // Weighted automod behavior score (decays over time)
    behaviorScore: { type: Number, default: 0 },
    lastScoreDecay: { type: Date, default: null },

    // Attendance streak
    streak: {
        current: { type: Number, default: 0 },
        longest: { type: Number, default: 0 },
        lastActive: { type: Date, default: null }
    },

    // Quest progress: each entry tracks one quest instance
    quests: [{
        questId: { type: String, required: true },
        progress: { type: Number, default: 0 },
        completedAt: { type: Date, default: null },
        expiresAt: { type: Date, required: true }
    }],

    // Season pass progress
    season: {
        seasonId: { type: String, default: null },
        xp: { type: Number, default: 0 },
        tier: { type: Number, default: 0 },
        claimedTiers: [{ type: Number }]
    },

    // Progression archetype track
    track: {
        type: String,
        enum: ['none', 'creator', 'helper', 'raider'],
        default: 'none'
    },

    // Daily activity counter for raider track bonus
    dailyMessages: { type: Number, default: 0 },
    lastDailyReset: { type: Date, default: null },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

userSchema.index({ userId: 1, guildId: 1 }, { unique: true });

userSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = model('User', userSchema);
