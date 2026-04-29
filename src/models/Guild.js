const { Schema, model } = require('mongoose');

const guildSchema = new Schema({
    guildId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    
    prefix: { type: String, default: '!' },
    
    welcome: {
        enabled: { type: Boolean, default: false },
        channelId: { type: String, default: null },
        message: { type: String, default: 'Welcome {user} to {server}!' },
        cardEnabled: { type: Boolean, default: true }
    },
    
    farewell: {
        enabled: { type: Boolean, default: false },
        channelId: { type: String, default: null },
        message: { type: String, default: 'Goodbye {user}!' }
    },
    
    moderation: {
        enabled: { type: Boolean, default: true },
        logChannelId: { type: String, default: null },
        muteRoleId: { type: String, default: null },
        autoModEnabled: { type: Boolean, default: false },
        spamProtection: { type: Boolean, default: false },
        spamThreshold: { type: Number, default: 5 },
        spamWindow: { type: Number, default: 5 },
        inviteFilter: { type: Boolean, default: false },
        linkFilter: { type: Boolean, default: false },
        profanityFilter: { type: Boolean, default: false },
        customBadWords: [{ type: String }],
        warnThreshold: { type: Number, default: 3 },
        kickThreshold: { type: Number, default: 5 },
        banThreshold: { type: Number, default: 0 }
    },
    
    leveling: {
        enabled: { type: Boolean, default: true },
        announceChannel: { type: String, default: null },
        announceInChannel: { type: Boolean, default: true },
        xpRate: { type: Number, default: 1.0 },
        levelUpMessage: { type: String, default: 'Congratulations {user}! You reached level {level}!' }
    },
    
    economy: {
        enabled: { type: Boolean, default: true },
        currency: { type: String, default: '💰' },
        dailyAmount: { type: Number, default: 100 },
        workMin: { type: Number, default: 50 },
        workMax: { type: Number, default: 150 }
    },
    
    music: {
        djRoleId: { type: String, default: null },
        defaultVolume: { type: Number, default: 50 },
        maxQueueSize: { type: Number, default: 100 }
    },
    
    rssFeeds: [{
        url: { type: String, required: true },
        channelId: { type: String, required: true },
        lastPublished: { type: Date, default: null }
    }],
    
    dailyNews: {
        enabled: { type: Boolean, default: false },
        channelId: { type: String, default: null },
        time: { type: String, default: '09:00' },
        feeds: [{ type: String }],
        title: { type: String, default: '📰 Daily News Digest' },
        maxItemsPerFeed: { type: Number, default: 3 }
    },
    
    ai: {
        enabled: { type: Boolean, default: false },
        provider: { type: String, enum: ['openai', 'gemini'], default: 'openai' },
        openaiKey: { type: String, default: null },
        geminiKey: { type: String, default: null },
        channelId: { type: String, default: null },
        systemPrompt: { type: String, default: 'You are a helpful Discord bot assistant.' }
    },
    
    customCommands: [{
        name: { type: String, required: true },
        response: { type: String, required: true }
    }],

    autoRoles: [{
        roleId: { type: String, required: true }
    }],

    reactionRoles: [{
        messageId: { type: String, required: true },
        channelId: { type: String, required: true },
        emoji: { type: String, required: true },
        roleId: { type: String, required: true }
    }],

    levelRoles: [{
        level: { type: Number, required: true },
        roleId: { type: String, required: true }
    }],

    shop: [{
        name: { type: String, required: true },
        description: { type: String, default: '' },
        price: { type: Number, required: true },
        roleId: { type: String, default: null },
        stock: { type: Number, default: -1 }
    }],

    tickets: {
        enabled: { type: Boolean, default: false },
        categoryId: { type: String, default: null },
        logChannelId: { type: String, default: null },
        supportRoleId: { type: String, default: null },
        openMessage: { type: String, default: 'A support agent will be with you shortly.' },
        count: { type: Number, default: 0 }
    },
    
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

guildSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = model('Guild', guildSchema);