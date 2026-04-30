const { Schema, model } = require('mongoose');

function distinctProfileIds(profiles) {
    if (!Array.isArray(profiles)) return true;

    const seen = new Set();
    for (const profile of profiles) {
        if (!profile || !profile.profileId) continue;
        if (seen.has(profile.profileId)) return false;
        seen.add(profile.profileId);
    }

    return true;
}

function distinctChannelPersonaIds(personas) {
    if (!Array.isArray(personas)) return true;

    const seen = new Set();
    for (const persona of personas) {
        if (!persona || !persona.channelId) continue;
        if (seen.has(persona.channelId)) return false;
        seen.add(persona.channelId);
    }

    return true;
}

const guildSchema = new Schema({
    guildId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    
    prefix: { type: String, default: '!' },
    
    welcome: {
        enabled: { type: Boolean, default: false },
        channelId: { type: String, default: null },
        message: { type: String, default: 'Welcome {user} to {server}!' },
        cardEnabled: { type: Boolean, default: true },
        dmEnabled: { type: Boolean, default: false },
        dmMessage: { type: String, default: 'Welcome to {server}! We\'re glad to have you here.' }
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

    dailyNewsProfiles: {
        type: [{
            profileId: { type: String, required: true },
            enabled: { type: Boolean, default: false },
            channelId: { type: String, default: null },
            time: { type: String, default: '09:00' },
            timezone: { type: String, default: null },
            feeds: [{ type: String }],
            title: { type: String, default: '📰 Daily News Digest' },
            maxItemsPerFeed: { type: Number, default: 3 }
        }],
        validate: {
            validator: distinctProfileIds,
            message: 'dailyNewsProfiles contains duplicate profileId values.'
        }
    },
    
    ai: {
        enabled: { type: Boolean, default: false },
        provider: {
            type: String,
            enum: ['openai', 'gemini', 'anthropic', 'ollama', 'openrouter'],
            default: 'openai'
        },
        model: { type: String, default: null },
        openaiKey: { type: String, default: null },
        geminiKey: { type: String, default: null },
        anthropicKey: { type: String, default: null },
        openrouterKey: { type: String, default: null },
        ollamaBaseUrl: { type: String, default: 'http://localhost:11434' },
        channelId: { type: String, default: null },
        systemPrompt: { type: String, default: 'You are a helpful Discord bot assistant.' },
        temperature: { type: Number, default: 0.7, min: 0, max: 2 },
        maxTokens: { type: Number, default: 1024, min: 32, max: 8192 },
        maxHistory: { type: Number, default: 20, min: 0, max: 100 },
        streaming: { type: Boolean, default: true },
        rateLimitPerUser: { type: Number, default: 20 },
        rateLimitWindowMin: { type: Number, default: 10 },
        // Per-channel personas: each entry overrides systemPrompt for that channel
        channelPersonas: {
            type: [{
                channelId:    { type: String, required: true },
                personaName:  { type: String, default: 'Assistant' },
                systemPrompt: { type: String, required: true }
            }],
            validate: {
                validator: distinctChannelPersonaIds,
                message: 'channelPersonas contains duplicate channelId values.'
            }
        },
        // Allow the AI to execute in-channel actions (polls, reminders, mod suggestions)
        actionsEnabled: { type: Boolean, default: false }
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

    starboard: {
        enabled: { type: Boolean, default: false },
        channelId: { type: String, default: null },
        emoji: { type: String, default: '⭐' },
        threshold: { type: Number, default: 3 },
        starredMessages: [{ type: String }]
    },

    giveaways: [{
        messageId: { type: String, required: true },
        channelId: { type: String, required: true },
        prize: { type: String, required: true },
        winners: { type: Number, default: 1 },
        endsAt: { type: Date, required: true },
        hostId: { type: String, required: true },
        ended: { type: Boolean, default: false },
        winnerIds: [{ type: String }]
    }],

    tempVoice: {
        enabled: { type: Boolean, default: false },
        lobbyChannelId: { type: String, default: null },
        categoryId: { type: String, default: null },
        activeChannels: [{ type: String }],
        channelName: { type: String, default: "{username}'s VC" },
        userLimit: { type: Number, default: 0 },
        bitrate: { type: Number, default: 64 }
    },

    eventLog: {
        enabled: { type: Boolean, default: false },
        channelId: { type: String, default: null },
        logMessageEdit: { type: Boolean, default: true },
        logMessageDelete: { type: Boolean, default: true },
        logMemberJoin: { type: Boolean, default: true },
        logMemberLeave: { type: Boolean, default: true },
        logRoleChanges: { type: Boolean, default: true },
        logChannelChanges: { type: Boolean, default: true }
    },

    analytics: {
        memberEvents: [{
            date: { type: String, required: true },
            joins: { type: Number, default: 0 },
            leaves: { type: Number, default: 0 }
        }],
        commandUsage: [{
            command: { type: String, required: true },
            channelId: { type: String, default: null },
            hour: { type: Number, required: true },
            success: { type: Boolean, default: true },
            reason: { type: String, default: null },
            createdAt: { type: Date, default: Date.now }
        }]
    },
    
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

guildSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = model('Guild', guildSchema);
