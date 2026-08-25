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

function distinctMcpServerNames(servers) {
    if (!Array.isArray(servers)) return true;

    const seen = new Set();
    for (const server of servers) {
        if (!server || !server.name) continue;
        if (seen.has(server.name)) return false;
        seen.add(server.name);
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
        inviteAllowlist: [{ type: String }],
        linkFilter: { type: Boolean, default: false },
        linkAllowlist: [{ type: String }],
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
        disableLevelUpAnnounce: { type: Boolean, default: false },
        maxLevel: { type: Number, default: null, min: 1, max: 9999 },
        xpBoostEvent: {
            multiplier: { type: Number, default: null, min: 1.1, max: 10 },
            startTime:  { type: Date,   default: null },
            endTime:    { type: Date,   default: null }
        }
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
        dailyAmount: { type: Number, default: 2500 },
        workMin: { type: Number, default: 50 },
        workMax: { type: Number, default: 150 },
        shopEnabled: { type: Boolean, default: true },
        gamesEnabled: { type: Boolean, default: true },
        coinflipEnabled: { type: Boolean, default: true },
        // Ambient chat events (airdrops, crates, flash trivia) — see chatEventService
        chatEventsEnabled: { type: Boolean, default: true },
        rollEnabled: { type: Boolean, default: true },
        blackjackEnabled: { type: Boolean, default: true },
        jobsEnabled: { type: Boolean, default: true },
        robEnabled: { type: Boolean, default: true },
        robMinWallet: { type: Number, default: 100, min: 0 },
        robFailFineRate: { type: Number, default: 0.2, min: 0, max: 1 },
        duelEnabled: { type: Boolean, default: true },
        duelMaxBet: { type: Number, default: 10000, min: 1 },
        // Coins paid to the Pet of the Week winner (0 disables the payout).
        potwReward: { type: Number, default: 5000, min: 0 },
        casinoEnabled: { type: Boolean, default: true },
        crimeEnabled: { type: Boolean, default: true },
        quizEnabled: { type: Boolean, default: true },
        // max: 0.5 ensures winnerPayout >= amount so netGain is never negative
        duelHouseCut: { type: Number, default: 0.05, min: 0, max: 0.5 },
        betConfirmThreshold: { type: Number, default: 10000, min: 0 },
        casinoMaxBet: { type: Number, default: 0, min: 0 },
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

    casinoStats: {
        rouletteHistory: [{ type: Number }],
        crashHistory:    [{ type: Number }],
    },

    fishingWorldRecords: [{
        fish:     { type: String },
        weight:   { type: Number },
        userId:   { type: String },
        username: { type: String },
        date:     { type: Date },
    }],

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
        timezone: { type: String, default: 'UTC' },
        sentLinks: [{
            link: { type: String, required: true },
            sentAt: { type: Date, required: true }
        }]
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
            maxItemsPerFeed: { type: Number, default: 3 },
            sentLinks: [{
                link: { type: String, required: true },
                sentAt: { type: Date, required: true }
            }]
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
        // Remote MCP servers this guild has connected in the dashboard. Merged
        // with the operator-wide config file at request time; a name defined in
        // both places resolves to the guild's entry. Whichever provider the
        // guild picked uses them: Anthropic's API takes the servers directly,
        // and for the rest the bot is the MCP client (src/services/ai/mcp/).
        mcpServers: {
            type: [{
                name:               { type: String, required: true },
                url:                { type: String, required: true },
                enabled:            { type: Boolean, default: true },
                // Stored as given. Never rendered back to the dashboard: the UI
                // shows whether a token exists, never what it is.
                authorizationToken: { type: String, default: null },
                // Empty allowedTools means "every tool"; anything in
                // blockedTools is switched off even if also allowed.
                allowedTools:       [{ type: String }],
                blockedTools:       [{ type: String }],
                // Tools that need a person to approve them before they run,
                // whatever ai.mcpConfirm is set to. The block list is for tools
                // nobody may call; this is for the ones that are fine with a
                // moderator watching and not otherwise.
                confirmTools:       [{ type: String }],
                addedBy:            { type: String, default: null },
                createdAt:          { type: Date, default: Date.now }
            }],
            validate: {
                validator: distinctMcpServerNames,
                message: 'mcpServers contains duplicate name values.'
            }
        },
        // Which MCP tool calls wait for a person to click Approve in the
        // channel. 'destructive' and 'writes' both read the tool annotations
        // the server publishes, and differ over a tool that publishes none:
        // 'destructive' believes it, 'writes' asks anyway. See
        // CONFIRM_MODES in src/config/mcpServers.js.
        mcpConfirm: {
            type: String,
            enum: ['off', 'destructive', 'writes', 'always'],
            default: 'off'
        },
        // Allow the AI to execute in-channel actions (polls, reminders, mod suggestions)
        actionsEnabled: { type: Boolean, default: false },
        dailyDigest: {
            enabled:          { type: Boolean, default: false },
            channelId:        { type: String, default: null },
            sourceChannelIds: [{ type: String }],
            hour:             { type: Number, default: 9, min: 0, max: 23 },
            minute:           { type: Number, default: 0, min: 0, max: 59 },
            timezone:         { type: String, default: 'UTC' },
            lastRun:          { type: Date, default: null }
        }
    },

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
        type:           { type: String, enum: ['winter_wonderland', 'spooky_season', 'summer_festival', 'valentines_day', 'winter_hunt', 'custom', null], default: null },
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
        // Premium track unlock price (coin sink) and weekly season-XP cap (pacing)
        premiumCost: { type: Number, default: 100000, min: 0 },
        weeklyXpCap: { type: Number, default: 1500, min: 0 },
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
        winnerIds: [{ type: String }],
        // Entrant user IDs. Persisted rather than kept on the in-memory Message
        // object so a restart (or a Discord.js message-cache eviction) between
        // the giveaway opening and closing does not silently empty the pool.
        entrantIds: [{ type: String }]
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

    // Recorded telemetry (memberEvents, commandUsage) lives in its own
    // GuildAnalytics collection — see models/GuildAnalytics.js and
    // migrations/013_split_guild_analytics.js.

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

    // World Exploration System
    exploration: {
        enabled:            { type: Boolean, default: true },
        // Scales all expedition coin payouts (0.1×–5×)
        dropRateMultiplier: { type: Number,  default: 1,   min: 0.1, max: 5 },
        // Shifts event-table weight from quiet/trap rolls toward treasure & secrets (0–0.25)
        rareEventBonus:     { type: Number,  default: 0,   min: 0,   max: 0.25 },
        // Region ids switched off by admins (hidden from /explore and the map)
        disabledRegions:    [{ type: String }],
        // Broadcast secret discoveries to the economy announcement channel
        announceSecrets:    { type: Boolean, default: true }
    },

    // Scheduler claim timestamps — prevent duplicate runs across cron restarts
    potwLastRunAt:          { type: Date, default: null },
    bankInterestLastRunAt:  { type: Date, default: null },
    badgesLastAwardedAt:    { type: Date, default: null },
    badgesAwardLeaseAt:     { type: Date, default: null },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// ── Indexes ─────────────────────────────────────────────────────────────────
//
// #576. The schema is the home for index definitions — here and in User.js,
// which already declared eleven this way. Index truth used to be split: the
// only thing this model said was `unique` on guildId, while migration 001
// created two more on the guilds collection, so answering "what is indexed"
// meant reading both files and hoping neither had drifted. It had: 001's
// `idx_giveaways_active` was built for a giveaway sweep that has since been
// rewritten, and indexes paths (`giveaways.ended`, `giveaways.endsAt`) that no
// query in the codebase filters on. Migration 015 drops it.
//
// A migration still creates an index when — and only when — the schema cannot
// say the thing: dropping one Mongoose would never drop on its own, or renaming
// one in place. `idx_guilds_rssfeeds` below is declared under the exact name and
// spec 001 built it with, so an existing deployment already has it and
// autoIndex finds nothing to do; a fresh one gets it from here.
//
// Every index below is partial or sparse, which matters more on this collection
// than on most: a guild document carries analytics history and inline shop item
// image Buffers, and each of these queries is a scheduled sweep looking for the
// few guilds that have a feature turned on. A partial index holds only the
// documents matching its filter, so guilds with the feature off cost nothing to
// index and are never read.

// giveawayService.checkGiveaways — every guild holding at least one giveaway.
guildSchema.index({ 'giveaways.0': 1 }, { name: 'idx_guilds_giveaways', sparse: true });

// rssService.checkFeeds — every guild with at least one feed. Declared here
// under the name and spec migration 001 created it with.
guildSchema.index({ 'rssFeeds.0': 1 }, { name: 'idx_guilds_rssfeeds', sparse: true });

// tempVoiceService.checkTempVoice — guilds with temp voice on and channels open.
guildSchema.index(
    { 'tempVoice.activeChannels.0': 1 },
    { name: 'idx_guilds_tempvoice_active', partialFilterExpression: { 'tempVoice.enabled': true } }
);

// schedulerService.recalcShopPrices — guilds with dynamic pricing on. The key
// is the flag itself because the sweep filters on nothing else; the partial
// filter is what keeps the index to just those guilds.
guildSchema.index(
    { 'dynamicPricing.enabled': 1 },
    { name: 'idx_guilds_dynamic_pricing', partialFilterExpression: { 'dynamicPricing.enabled': true } }
);

// schedulerService bank-district payout — an $elemMatch on districtId and
// activeUntil. Both keys are paths into the same array, so this is one multikey
// index rather than the parallel-array case Mongo refuses.
guildSchema.index(
    { 'districts.districtId': 1, 'districts.activeUntil': 1 },
    { name: 'idx_guilds_district_active' }
);

// Not indexed, deliberately: the hourly and per-minute sweeps in
// schedulerService, birthdayService, newspaperService, dailyBibleService and
// summaryService follow this same "feature enabled, due now" shape and would
// each take a partial index of their own. They are left alone here because #576
// scoped this to the queries it named, and because ten more indexes on the
// collection every settings save writes is a cost worth measuring first rather
// than assuming. The pattern to copy is directly above.

guildSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

// --- Guild settings cache invalidation ---------------------------------------
//
// utils/guildSettingsCache serves guild configuration to the per-message and
// per-command read paths. Invalidating from here rather than from each write
// site means a newly added writer is covered automatically; middleware also has
// to be attached before model() compiles the schema, which is why it lives in
// this file rather than in the cache module.
//
// Required lazily to avoid a circular import at load time; the handlers
// themselves live beside the cache so they can be unit tested without driving
// Mongoose middleware.
function cacheHook(name, arg) {
    try {
        require('../utils/guildSettingsCache')[name](arg);
    } catch (err) {
        console.error(`[GUILD] Settings cache ${name} failed:`, err.message);
    }
}

// Document writes: Model.create() routes through save(), so this covers both.
guildSchema.post('save', function (doc) {
    cacheHook('onGuildDocumentSaved', doc);
});

// Query writes.
guildSchema.post(
    ['findOneAndUpdate', 'updateOne', 'updateMany', 'findOneAndDelete', 'deleteOne', 'deleteMany', 'replaceOne'],
    function () {
        cacheHook('onGuildQueryWrite', this);
    }
);

module.exports = model('Guild', guildSchema);
