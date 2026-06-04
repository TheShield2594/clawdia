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

function distinctLadderThresholds(ladder) {
    if (!Array.isArray(ladder)) return true;

    const seen = new Set();
    for (const step of ladder) {
        if (!step || step.threshold == null) continue;
        if (seen.has(step.threshold)) return false;
        seen.add(step.threshold);
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
        message: { type: String, default: 'Welcome {user} to {server}!', maxlength: 4000 },
        cardEnabled: { type: Boolean, default: true },
        dmEnabled: { type: Boolean, default: false },
        dmMessage: { type: String, default: 'Welcome to {server}! We\'re glad to have you here.', maxlength: 4000 }
    },
    
    farewell: {
        enabled: { type: Boolean, default: false },
        channelId: { type: String, default: null },
        message: { type: String, default: 'Goodbye {user}!', maxlength: 4000 }
    },

    birthdays: {
        enabled: { type: Boolean, default: false },
        channelId: { type: String, default: null },
        wishingHourUtc: { type: Number, default: 9, min: 0, max: 23 },
        roleId: { type: String, default: null },
        message: { type: String, default: "It's the birthday of {user} ({age}) ! 🎂", maxlength: 2000 }
    },
    
    moderation: {
        enabled: { type: Boolean, default: true },
        logChannelId: { type: String, default: null },
        muteRoleId: { type: String, default: null },
        autoModEnabled: { type: Boolean, default: false },
        immunityRoleIds: [{ type: String }],
        spamProtection: { type: Boolean, default: false },
        spamThreshold: { type: Number, default: 5 },
        spamWindow: { type: Number, default: 5 },
        inviteFilter: { type: Boolean, default: false },
        linkFilter: { type: Boolean, default: false },
        profanityFilter: { type: Boolean, default: false },
        customBadWords: [{ type: String }],
        repeatedTextFilter: { type: Boolean, default: false },
        excessiveCapsFilter: { type: Boolean, default: false },
        capsThresholdPercent: { type: Number, default: 70 },
        excessiveEmojisFilter: { type: Boolean, default: false },
        emojiThreshold: { type: Number, default: 8 },
        zalgoFilter: { type: Boolean, default: false },
        excessiveMentionsFilter: { type: Boolean, default: false },
        mentionThreshold: { type: Number, default: 5 },
        warnThreshold: { type: Number, default: 3 },
        kickThreshold: { type: Number, default: 5 },
        banThreshold: { type: Number, default: 0 },
        behaviorScoreMuteAt: { type: Number, default: 10, min: 0 },
        behaviorScoreKickAt: { type: Number, default: 20, min: 0 },
        behaviorScoreBanAt: { type: Number, default: 30, min: 0 },
        behaviorScoreDecayDays: { type: Number, default: 7, min: 1 },
        appealsEnabled: { type: Boolean, default: false },
        appealChannelId: { type: String, default: null },
        escalation: {
            enabled: { type: Boolean, default: true },
            ladder: {
                type: [{
                    threshold:       { type: Number, required: true, min: 1 },
                    action:          { type: String, enum: ['mute', 'kick', 'ban', 'tempban'], required: true },
                    durationMinutes: { type: Number, default: null, min: 1, max: 40320 },
                    dmUser:          { type: Boolean, default: true },
                    reason:          { type: String, default: 'Automatic escalation: {count} warnings reached' }
                }],
                default: () => [
                    { threshold: 3,  action: 'mute',    durationMinutes: 10,   dmUser: true, reason: 'Automatic escalation: {count} warnings reached' },
                    { threshold: 5,  action: 'mute',    durationMinutes: 60,   dmUser: true, reason: 'Automatic escalation: {count} warnings reached' },
                    { threshold: 7,  action: 'kick',    durationMinutes: null, dmUser: true, reason: 'Automatic escalation: {count} warnings reached' },
                    { threshold: 10, action: 'ban',     durationMinutes: null, dmUser: true, reason: 'Automatic escalation: {count} warnings reached' }
                ],
                validate: {
                    validator: distinctLadderThresholds,
                    message: 'escalation.ladder contains duplicate threshold values.'
                }
            }
        }
    },
    
    leveling: {
        enabled: { type: Boolean, default: true },
        announceChannel: { type: String, default: null },
        announceInChannel: { type: Boolean, default: true },
        xpRate: { type: Number, default: 1.0 },
        levelUpMessage: { type: String, default: 'Congratulations {user}! You reached level {level}!' },
        rewardsEnabled: { type: Boolean, default: true },
        noXpRoleIds: [{ type: String }],
        noXpChannelIds: [{ type: String }],
        rewardChannelId: { type: String, default: null },
        voiceXpEnabled: { type: Boolean, default: false },
        voiceXpRate: { type: Number, default: 1.0 },
        disableLevelUpAnnounce: { type: Boolean, default: false }
    },
    
    serverBoost: {
        type:        { type: String, enum: ['coin', 'xp', null], default: null },
        multiplier:  { type: Number, default: 1.5, min: 1.0, max: 10.0 },
        expiresAt:   { type: Date,   default: null },
        activatedBy: { type: String, default: null }
    },

    economy: {
        enabled: { type: Boolean, default: true },
        currency: { type: String, default: '💰' },
        dailyAmount: { type: Number, default: 100 },
        workMin: { type: Number, default: 50 },
        workMax: { type: Number, default: 150 },
        shopEnabled: { type: Boolean, default: true },
        gamesEnabled: { type: Boolean, default: true },
        coinflipEnabled: { type: Boolean, default: true },
        rollEnabled: { type: Boolean, default: true },
        blackjackEnabled: { type: Boolean, default: true },
        jobsEnabled: { type: Boolean, default: true },
        robEnabled: { type: Boolean, default: true },
        robMinWallet: { type: Number, default: 100, min: 0 },
        robFailFineRate: { type: Number, default: 0.2, min: 0, max: 1 },
        // TODO: wheel game removed — these fields are unused and can be dropped in a future migration
        // wheelEnabled: { type: Boolean, default: true },
        // wheelCooldownHours: { type: Number, default: 24, min: 1, max: 168 },
        // wheelExtraSpinCost: { type: Number, default: 200, min: 1 },
        duelEnabled: { type: Boolean, default: true },
        duelMaxBet: { type: Number, default: 10000, min: 1 },
        casinoEnabled: { type: Boolean, default: true },
        crimeEnabled: { type: Boolean, default: true },
        quizEnabled: { type: Boolean, default: true },
        // max: 0.5 ensures winnerPayout >= amount so netGain is never negative
        duelHouseCut: { type: Number, default: 0.05, min: 0, max: 0.5 },
        betConfirmThreshold: { type: Number, default: 10000, min: 0 },
        announcementChannelId: { type: String, default: null },
        announceRareDrops: { type: Boolean, default: true },
        announceStreakMilestones: { type: Boolean, default: true }
    },

    slots: {
        jackpotPool:       { type: Number,  default: 5000 },
        lastJackpotWinner: { type: String,  default: null },
        lastJackpotAmount: { type: Number,  default: null },
        lastJackpotAt:     { type: Date,    default: null },
        announceJackpot:   { type: Boolean, default: true },
        jackpotPingHere:   { type: Boolean, default: false },
        jackpotChannelId:  { type: String,  default: null },
    },

    // Progressive jackpot pool fed by all casino bets
    casinoJackpot: {
        pool:                 { type: Number,  default: 10000 },
        betsCount:            { type: Number,  default: 0 },     // total eligible bets since last drop
        seedAmount:           { type: Number,  default: 10000 },
        contributionRate:     { type: Number,  default: 0.005 }, // 0.5%
        announceChannelId:    { type: String,  default: null },
        lastWinnerId:         { type: String,  default: null },
        lastWinnerName:       { type: String,  default: null },
        lastWonAmount:        { type: Number,  default: null },
        lastWonAt:            { type: Date,    default: null },
        claimToken:           { type: String,  default: null },
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
        maxItemsPerFeed: { type: Number, default: 3 },
        timezone: { type: String, default: 'UTC' }
    },

    dailyNewsProfiles: {
        type: [{
            profileId: { type: String, required: true },
            name: { type: String, default: '' },
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
        rateLimitPerChannel: { type: Number, default: 0 },
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
        itemId: { type: String, default: null },
        description: { type: String, default: '' },
        price: { type: Number, required: true },
        roleId: { type: String, default: null },
        stock:     { type: Number, default: -1 },
        imageData: { type: Buffer, default: null },
        imageType: { type: String, default: 'image/png' },
        createdAt: { type: Date, default: null },
        // ── Dynamic pricing (issue #354) ──
        // basePrice is the canonical anchor; currentPrice is what buyers actually pay.
        // demandScore drifts up on buys and down on idle ticks / market listings.
        basePrice:     { type: Number, default: null },
        currentPrice:  { type: Number, default: null },
        demandScore:   { type: Number, default: 0 },
        priceHistory:  [{
            at:    { type: Date,   required: true },
            price: { type: Number, required: true },
            demandScore: { type: Number, default: 0 }
        }]
    }],

    shopDefaultsSeeded: { type: Boolean, default: false },

    // Dynamic pricing config for shop items
    dynamicPricing: {
        enabled:         { type: Boolean, default: false },
        volatility:      { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
        // ±band as a fraction of basePrice; capped here at recalc time
        priceBand:       { type: Number, default: 0.5, min: 0.05, max: 0.9 },
        // How often the scheduled job recalculates prices (minutes)
        recalcMinutes:   { type: Number, default: 60, min: 15, max: 1440 },
        lastRecalcAt:    { type: Date, default: null }
    },

    // Ranked duel ladder (issue #339)
    rankedDuels: {
        enabled:           { type: Boolean, default: true },
        minBet:            { type: Number, default: 100, min: 1 },
        kFactor:           { type: Number, default: 32, min: 8, max: 64 },
        seasonDurationDays:{ type: Number, default: 60, min: 7, max: 365 },
        currentSeasonId:   { type: String, default: null },
        seasonStartedAt:   { type: Date,   default: null },
        seasonEndsAt:      { type: Date,   default: null },
        seasonNumber:      { type: Number, default: 1, min: 1 },
        // Top-3 reward at season end
        topReward:         { type: Number, default: 50_000, min: 0 },
        announceChannelId: { type: String, default: null }
    },

    // Account prestige settings (issue #342)
    accountPrestige: {
        enabled:              { type: Boolean, default: true },
        minLevelToPrestige:   { type: Number, default: 50, min: 5 },
        softPrestigeAt:       { type: Number, default: 25, min: 5 },  // optional soft prestige threshold
        announceChannelId:    { type: String, default: null },
        // Server role granted to high-prestige users (optional)
        eliteRoleId:          { type: String, default: null },
        eliteRoleMinRank:     { type: Number, default: 5, min: 1 }
    },

    // Server investment districts — cooperative money sink
    districts: {
        type: [{
            districtId:    { type: String, required: true },
            pool:          { type: Number, default: 0 },
            goal:          { type: Number, default: 1_000_000 },
            activeUntil:   { type: Date,   default: null },
            topContributors: [{
                userId:   { type: String, required: true },
                username: { type: String, default: '' },
                amount:   { type: Number, default: 0 },
            }],
        }],
        default: () => [
            { districtId: 'marketplace', pool: 0, goal: 1_000_000, activeUntil: null, topContributors: [] },
            { districtId: 'bank',        pool: 0, goal: 1_000_000, activeUntil: null, topContributors: [] },
            { districtId: 'underground', pool: 0, goal: 1_000_000, activeUntil: null, topContributors: [] },
            { districtId: 'wilderness',  pool: 0, goal: 1_000_000, activeUntil: null, topContributors: [] },
            { districtId: 'arena',       pool: 0, goal: 1_000_000, activeUntil: null, topContributors: [] },
        ],
    },
    districtAnnounceChannelId: { type: String, default: null },

    jobTiers: [{
        tier:      { type: Number, required: true, min: 1, max: 4 },
        name:      { type: String, required: true },
        minShifts: { type: Number, default: 0, min: 0 }
    }],

    jobs: [{
        name:   { type: String, required: true },
        emoji:  { type: String, default: '' },
        tier:   { type: Number, default: 1, min: 1, max: 4 },
        minPay: { type: Number, default: 50, min: 0 },
        maxPay: { type: Number, default: 150, min: 0 }
    }],

    raidDetection: {
        enabled: { type: Boolean, default: false },
        threshold: { type: Number, default: 10, min: 1 },
        windowSeconds: { type: Number, default: 60, min: 1 },
        minAccountAgeDays: { type: Number, default: 7, min: 0 },
        action: {
            type: String,
            enum: ['alert', 'quarantine', 'kick'],
            default: 'alert'
        },
        quarantineRoleId: { type: String, default: null },
        alertChannelId: { type: String, default: null },
        caseIdCounter: { type: Number, default: 0, min: 0 },
        autoDisable: { type: Boolean, default: true },
        calmWindowSeconds: { type: Number, default: 300, min: 30 },
        requireManualDisable: { type: Boolean, default: false },
        raidModeActive: { type: Boolean, default: false },
        raidModeActivatedBy: { type: String, enum: ['auto', 'manual', null], default: null },
        raidModeActivatedAt: { type: Date, default: null }
    },

    antiNuke: {
        enabled: { type: Boolean, default: false },
        alertChannelId: { type: String, default: null },
        whitelistUserIds: [{ type: String }],
        whitelistRoleIds: [{ type: String }],
        // Per-action thresholds: how many of an action a single user can take
        // within `windowSeconds` before they trip the punishment.
        windowSeconds: { type: Number, default: 30, min: 5 },
        thresholds: {
            channelDelete: { type: Number, default: 3, min: 1 },
            channelCreate: { type: Number, default: 5, min: 1 },
            roleDelete:    { type: Number, default: 3, min: 1 },
            roleCreate:    { type: Number, default: 5, min: 1 },
            ban:           { type: Number, default: 3, min: 1 },
            kick:          { type: Number, default: 5, min: 1 },
            webhookCreate: { type: Number, default: 2, min: 1 }
        },
        // What to do to the offending user (the one whose action burst tripped).
        punishment: {
            type: String,
            enum: ['alert', 'strip-roles', 'kick', 'ban'],
            default: 'strip-roles'
        },
        // If true, the bot will lock all text channels (deny SendMessages for @everyone)
        // when a nuke event fires, until /lockdown end is run.
        autoLockdown: { type: Boolean, default: false },
        // Active lockdown bookkeeping (so we can restore permissions on /lockdown end).
        lockdown: {
            active: { type: Boolean, default: false },
            startedAt: { type: Date, default: null },
            startedBy: { type: String, default: null },
            reason: { type: String, default: null },
            // Channels that had their @everyone SendMessages overwrite changed by the
            // lockdown so we can revert. Only stores channels the bot touched.
            affectedChannels: [{
                channelId: { type: String, required: true },
                hadOverwrite: { type: Boolean, default: false },
                previousAllow: { type: String, default: null },
                previousDeny:  { type: String, default: null }
            }]
        },
        // Optional join gate: refuse joins from accounts younger than N days.
        joinGate: {
            enabled: { type: Boolean, default: false },
            minAccountAgeDays: { type: Number, default: 3, min: 0 },
            action: {
                type: String,
                enum: ['kick', 'ban'],
                default: 'kick'
            }
        }
    },

    caseSettings: {
        slaHours: { type: Number, default: 48, min: 1 },
        slaChannelId: { type: String, default: null },
        nextCaseId: { type: Number, default: 1, min: 1 }
    },

    quests: {
        enabled: { type: Boolean, default: false },
        notificationChannelId: { type: String, default: null },
        questsPerDay: { type: Number, default: 3, min: 1, max: 6 },
        questsPerWeek: { type: Number, default: 2, min: 1, max: 4 },
        dailyXpReward: { type: Number, default: 50 },
        dailyCoinReward: { type: Number, default: 25 },
        weeklyXpReward: { type: Number, default: 300 },
        weeklyCoinReward: { type: Number, default: 150 }
    },

    activeEvent: {
        type:           { type: String, enum: ['winter_wonderland', 'spooky_season', 'summer_festival', 'valentines_day', 'custom', null], default: null },
        name:           { type: String, default: null },
        emoji:          { type: String, default: null },
        color:          { type: String, default: null },
        startedAt:      { type: Date, default: null },
        endsAt:         { type: Date, default: null },
        coinMultiplier: { type: Number, default: 1.0, min: 1.0, max: 5.0 },
        xpMultiplier:   { type: Number, default: 1.0, min: 1.0, max: 5.0 },
        startedBy:      { type: String, default: null },
        announcementChannelId: { type: String, default: null },
        eventShop: [{
            itemId:      { type: String, required: true },
            name:        { type: String, required: true },
            description: { type: String, default: '' },
            emoji:       { type: String, default: '' },
            cost:        { type: Number, required: true, min: 0 },
            stock:       { type: Number, default: -1 }
        }]
    },

    season: {
        enabled: { type: Boolean, default: false },
        seasonId: { type: String, default: null },
        name: { type: String, default: 'Season 1' },
        startDate: { type: Date, default: null },
        endDate: { type: Date, default: null },
        xpPerTier: { type: Number, default: 100 },
        maxTiers: { type: Number, default: 50 },
        tierRewards: [{
            tier: { type: Number, required: true },
            coins: { type: Number, default: 0 },
            roleId: { type: String, default: null },
            label: { type: String, default: '' }
        }]
    },

    progressionTracks: {
        enabled: { type: Boolean, default: false },
        helperChannels: [{ type: String }],
        creatorBonus: { type: Number, default: 20 },
        helperBonus: { type: Number, default: 20 },
        raiderBonus: { type: Number, default: 20 }
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

    suggestions: {
        enabled: { type: Boolean, default: false },
        channelId: { type: String, default: null },
        upvoteEmoji: { type: String, default: '👍' },
        downvoteEmoji: { type: String, default: '👎' }
    },

    commandPolicies: {
        enabled: { type: Boolean, default: false },
        exceptions: {
            userIds: [{ type: String }],
            roleIds: [{ type: String }]
        },
        rules: [{
            command: { type: String, required: true },
            effect: { type: String, enum: ['allow', 'deny'], default: 'allow' },
            roleIds: [{ type: String }],
            channelIds: [{ type: String }],
            daysOfWeek: [{ type: Number, min: 0, max: 6 }],
            startHourUtc: { type: Number, min: 0, max: 23, default: null },
            endHourUtc: { type: Number, min: 0, max: 23, default: null }
        }],
        cooldownOverrides: [{
            command: { type: String, required: true },
            roleId: { type: String, required: true },
            cooldownSeconds: { type: Number, min: 0, default: 3 }
        }]
    },

    bibleVerse: {
        enabled: { type: Boolean, default: false },
        channelId: { type: String, default: null },
        time: { type: String, default: '08:00' },
        timezone: { type: String, default: 'UTC' },
        translation: {
            type: String,
            default: 'kjv',
            enum: {
                values: ['kjv', 'niv', 'asv', 'web', 'ylt', 'darby', 'bbe', 'webbe'],
                message: 'bibleVerse.translation must be one of: kjv, niv, asv, web, ylt, darby, bbe, webbe'
            }
        },
        autoRespond: { type: Boolean, default: true }
    },

    achievements: {
        enabled: { type: Boolean, default: false },
        announcementChannelId: { type: String, default: null },
        // Minimum tier to broadcast server-wide: 'rare' | 'secret' | 'legendary'
        achievementAnnounceThreshold: { type: String, enum: ['rare', 'secret', 'legendary'], default: 'rare' },
        disabledAchievements: [{ type: String }],
        customAchievements: [{
            id:          { type: String, required: true },
            name:        { type: String, required: true },
            description: { type: String, default: '' },
            emoji:       { type: String, default: '🏆' },
            category:    { type: String, default: 'custom' },
            xpReward:    { type: Number, default: 0, min: 0 },
            coinReward:  { type: Number, default: 0, min: 0 }
        }]
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

    // Server vs server war
    activeWar: {
        opponentGuildId:   { type: String, default: null },
        opponentGuildName: { type: String, default: null },
        initiatorGuildId:  { type: String, default: null },
        status:            { type: String, enum: ['pending', 'active', 'ended', null], default: null },
        myScore:           { type: Number, default: 0 },
        opponentScore:     { type: Number, default: 0 },
        startedAt:         { type: Date, default: null },
        endsAt:            { type: Date, default: null },
        announcementChannelId: { type: String, default: null },
        inviteCode:        { type: String, default: null }
    },

    // 90-day economy season (separate from battle pass season)
    currentSeason: {
        id:        { type: String, default: null },
        name:      { type: String, default: null },
        startedAt: { type: Date, default: null },
        endsAt:    { type: Date, default: null }
    },

    // Server Newspaper (issue #356)
    newspaper: {
        enabled:          { type: Boolean, default: false },
        channelId:        { type: String,  default: null },
        deliveryDay:      { type: Number,  default: 1, min: 0, max: 6 }, // 0=Sun … 6=Sat
        deliveryHourUtc:  { type: Number,  default: 9, min: 0, max: 23 },
        sections: {
            topEarners:        { type: Boolean, default: true },
            levelUps:          { type: Boolean, default: true },
            casinoHighlights:  { type: Boolean, default: true },
            moderationDigest:  { type: Boolean, default: true },
            gameStandouts:     { type: Boolean, default: true },
            quoteOfTheWeek:    { type: Boolean, default: true },
            newMembers:        { type: Boolean, default: true },
        },
        quoteChannelIds: [{ type: String }],
        lastRunAt:        { type: Date, default: null }
    },

    // Crime Syndicate System (issue #341)
    syndicates: {
        enabled:            { type: Boolean, default: false },
        heistCooldownHours: { type: Number,  default: 4, min: 1, max: 48 },
    },

    // Strategic Heist System (issue #358)
    heist: {
        enabled:               { type: Boolean, default: false },
        cooldownHours:         { type: Number,  default: 6,     min: 1, max: 168 },
        minPlayers:            { type: Number,  default: 2,     min: 2, max: 4 },
        lobbyDurationSeconds:  { type: Number,  default: 60,    min: 30, max: 300 },
        jailDurationMinutes:   { type: Number,  default: 30,    min: 5, max: 1440 },
        maxPayout:             { type: Number,  default: 10000, min: 100 },
        announceChannelId:     { type: String,  default: null }
    },

    // Scheduler claim timestamps — prevent duplicate runs across cron restarts
    potwLastRunAt:          { type: Date, default: null },
    bankInterestLastRunAt:  { type: Date, default: null },
    badgesLastAwardedAt:    { type: Date, default: null },
    badgesAwardLeaseAt:     { type: Date, default: null },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

guildSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = model('Guild', guildSchema);
