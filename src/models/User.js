const { Schema, model } = require('mongoose');

// How many starved pets are retained for revival, most recent first.
const DECEASED_PET_LIMIT = 5;

// Shared between `pets` and `deceasedPets` so a revived pet round-trips with
// every field intact.
const PET_FIELDS = {
    petId:              { type: String,  required: true },
    name:               { type: String,  default: null },
    hunger:             { type: Number,  default: 100, min: 0, max: 100 },
    lastFed:            { type: Date,    default: Date.now },
    // Cursor tracking how far hunger decay has been applied. Kept separate
    // from lastFed so that feeding restores hunger without also rewinding
    // the decay clock (which used to make decay avoidable entirely).
    lastDecayAt:        { type: Date,    default: Date.now },
    adoptedAt:          { type: Date,    default: Date.now },
    starving:           { type: Boolean, default: false },
    starvingStartAt:    { type: Date,    default: null },
    lastPlay:           { type: Date,    default: null },
    restUntil:          { type: Date,    default: null },
    potw:               { type: Boolean, default: false },
    weeklyInteractions: { type: Number,  default: 0    },
    personality:        { type: String,  default: null },
    // Progression (Phase 4): pets gain XP from feeding and battles, level up,
    // and evolve through stages that scale their passive bonus.
    level:              { type: Number,  default: 1, min: 1 },
    xp:                 { type: Number,  default: 0, min: 0 },
    evolutionStage:     { type: Number,  default: 1, min: 1, max: 3 },
    battleWins:         { type: Number,  default: 0 },
    battleLosses:       { type: Number,  default: 0 },
    lastBattle:         { type: Date,    default: null },
};

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
    lastSnowball: { type: Date, default: null },
    lastTrickOrTreat: { type: Date, default: null },
    lastSandcastle: { type: Date, default: null },
    lastLoveNote: { type: Date, default: null },
    lastTrackHunt: { type: Date, default: null },
    lastRob: { type: Date, default: null },
    lastRobbedAt: { type: Date, default: null },
    lastDuel: { type: Date, default: null },
    lastFish: { type: Date, default: null },
    lastMine: { type: Date, default: null },
    lastCrime: { type: Date, default: null },
    lastHeist:        { type: Date, default: null },
    heistJailedUntil: { type: Date, default: null },
    wantedUntil: { type: Date, default: null },
    crimeRecord: {
        totalCrimes:      { type: Number, default: 0 },
        successfulCrimes: { type: Number, default: 0 },
    },
    shiftsWorked: { type: Number, default: 0 },

    // Daily quiz attempt counters per difficulty (each resets midnight UTC)
    dailyQuizHard: { type: Number, default: 0 },
    dailyQuizHardReset: { type: Date, default: null },
    dailyQuizMedium: { type: Number, default: 0 },
    dailyQuizMediumReset: { type: Date, default: null },
    dailyQuizEasy: { type: Number, default: 0 },
    dailyQuizEasyReset: { type: Date, default: null },

    inventory: [{
        itemId: { type: String, required: true },
        quantity: { type: Number, default: 1 }
    }],

    warnings: { type: Number, default: 0 },
    kicks: { type: Number, default: 0 },
    bans: { type: Number, default: 0 },
    economyFrozen: { type: Boolean, default: false },

    // Weighted automod behavior score (decays over time)
    behaviorScore: { type: Number, default: 0 },
    lastScoreDecay: { type: Date, default: null },

    // Attendance streak
    streak: {
        current: { type: Number, default: 0 },
        longest: { type: Number, default: 0 },
        lastActive: { type: Date, default: null },
        claimedMilestones: [{ type: Number }],
        freezes: { type: Number, default: 0, min: 0, max: 2 },
        pendingRestore: { type: Number, default: 0 },  // broken streak count awaiting freeze decision
        claimedDropMilestones: [{ type: Number }],      // streak days where guaranteed drop was given
        revivalToken: { type: Boolean, default: false } // ultra-rare item that restores a broken streak
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
        claimedTiers: [{ type: Number }],
        // Premium track (unlocked via a large coin sink — see /season unlock)
        premium: { type: Boolean, default: false },
        claimedPremiumTiers: [{ type: Number }],
        // Weekly XP pacing
        weekXp: { type: Number, default: 0 },
        weekStart: { type: Date, default: null },
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

    birthday: {
        month: { type: Number, min: 1, max: 12, default: null },
        day: { type: Number, min: 1, max: 31, default: null },
        year: { type: Number, min: 1900, max: 2100, default: null },
        lastCelebratedYear: { type: Number, default: null }
    },

    // ── Grind systems (fishing / hunt / mining / exploration) ────────────────
    // Moved to the GrindProfile collection (one document per user × system) —
    // see src/models/GrindProfile.js and src/utils/grindProfile.js. They held
    // unbounded nested state that pushed heavy users toward the 16MB document
    // limit. Migration: src/migrations/005_grind_profiles.js.


    // Rob trap — set via /trap set; triggers on successful rob against this user
    trap: {
        setAt:     { type: Date, default: null },
        expiresAt: { type: Date, default: null }
    },

    // Active item effects (populated by /use; pruned on read)
    activeEffects: [{
        type:      { type: String, required: true },
        expiresAt: { type: Date,   default: null },
        charges:   { type: Number, default: -1 }
    }],

    // Event currency balances (e.g. snowflakes, candy, shells, hearts)
    eventCurrency: [{
        currencyId: { type: String, required: true },
        amount:     { type: Number, default: 0, min: 0 }
    }],

    // Pinned AI memories (set via 📌 reaction on bot messages)
    pinnedMemories: [{
        content: { type: String, required: true },
        pinnedAt: { type: Date, default: Date.now },
        channelId: { type: String, default: null }
    }],

    // Self-declared IANA timezone (e.g. "America/New_York") — Discord's API doesn't
    // expose one, so this powers timezone-aware reminders (/timezone, /remind, AI reminders).
    timezone: { type: String, default: null },

    // Per-user notification preferences
    notifications: {
        leaderboard: {
            overtaken: { type: Boolean, default: true },  // DM when someone passes you
            climbed:   { type: Boolean, default: false }  // DM when you hit a major rank threshold
        }
    },

    // Leaderboard rivalry anti-spam timestamps
    leaderboard: {
        lastOvertakenNotification: { type: Date, default: null },
        lastClimbedNotification:   { type: Date, default: null }
    },

    // Pet system
    // Extra pet slots bought with the Pet Slot Expansion item (capped in petService).
    petSlots: { type: Number, default: 0, min: 0 },
    pets: [PET_FIELDS],

    // Pets lost to starvation, most recent first. Retained so a Revive Scroll
    // can restore one with its level, bond and battle record intact; capped at
    // DECEASED_PET_LIMIT so the array can't grow without bound.
    deceasedPets: [{ ...PET_FIELDS, diedAt: { type: Date, default: Date.now } }],

    // Pet of the Week tracking
    petInteractionLog: { type: Date,    default: null },
    petOfTheWeek:      { type: Boolean, default: false },

    // Season pass daily missions (reset at midnight UTC)
    seasonMissions: [{
        id:          { type: String, required: true },
        description: { type: String },
        target:      { type: Number },
        event:       { type: String },
        seasonXp:    { type: Number },
        coinReward:  { type: Number },
        progress:    { type: Number, default: 0 },
        completed:   { type: Boolean, default: false },
        claimed:     { type: Boolean, default: false }
    }],
    seasonMissionsDate: { type: Date, default: null },

    // Season economy tracking (separate from balance; resets each economy season)
    seasonCoins: { type: Number, default: 0 },

    // Achievement tracking
    achievements: [{
        id:       { type: String, required: true },
        earnedAt: { type: Date, default: Date.now },
        claimed:  { type: Boolean, default: false }
    }],
    achievementsCount:  { type: Number, default: 0 },
    pinnedAchievement: { type: String,  default: null },

    casinoStats: {
        slotsLossStreak: { type: Number, default: 0 },
    },

    grandPrestige: {
        level:       { type: Number, default: 0 },
        awardedAt:   { type: Date,   default: null },
        announcedAt: { type: Date,   default: null },
    },

    // Duel win/loss tracking
    duelWins:   { type: Number, default: 0 },
    duelLosses: { type: Number, default: 0 },

    // Ranked duel ladder (per-guild ELO + seasonal records)
    ranked: {
        elo:                  { type: Number, default: 1000 },
        peakElo:              { type: Number, default: 1000 },
        seasonPeakElo:        { type: Number, default: 1000 },
        rankedWins:           { type: Number, default: 0 },
        rankedLosses:         { type: Number, default: 0 },
        seasonRankedWins:     { type: Number, default: 0 },
        seasonRankedLosses:   { type: Number, default: 0 },
        currentSeasonId:      { type: String, default: null },
        peakSeasonTitle:      { type: String, default: null },  // best peak tier label across all seasons
        seasonalTitles:       [{ type: String }],               // earned end-of-season titles (e.g. "S1 Champion")
        lastSeasonId:         { type: String, default: null }
    },

    // Top-level (account) prestige — separate from per-skill hunt/fish/mine prestige
    accountPrestige: {
        rank:           { type: Number, default: 0, min: 0 },
        prestigedAt:    { type: Date,   default: null },
        unlocks:        [{ type: String }],   // ordered list of feature unlock ids
        lifetimePrestigeXp: { type: Number, default: 0 },
        announcedRank:  { type: Number, default: 0 },  // highest rank announced server-wide
        lastDailyChallengeAt: { type: Date, default: null }, // P6+ daily_challenge board claim cooldown
    },

    // Permanent crime success bonus stacks from Black Market Contract (max 3)
    crimeContractStacks: { type: Number, default: 0, min: 0, max: 3 },

    // Transient social badges (war victor, leaderboard #1, etc.) with optional expiry
    badges: [{
        id:        { type: String, required: true },
        label:     { type: String, required: true },
        expiresAt: { type: Date, default: null }
    }],

    // Highest wealth milestone tier ever broadcast (0=none,1=1M,2=10M,3=100M,4=1B)
    wealthTier: { type: Number, default: 0 },

    // Opt-out of level-up announce embeds in chat
    disableLevelUpAnnounce: { type: Boolean, default: false },

    // Gift cap tracking (daily outgoing coin gifts)
    dailyGiftSent:  { type: Number, default: 0 },
    dailyGiftReset: { type: Date,   default: null },

    // Gift cap tracking (daily incoming coin gifts — limits multi-alt funneling)
    dailyGiftReceived:      { type: Number, default: 0 },
    dailyGiftReceivedReset: { type: Date,   default: null },

    // Crime syndicate membership
    syndicateId: { type: String, default: null },

    // Crash game: bet amount deducted but not yet resolved (cleared on cash out or crash end)
    pendingCrashRefund: { type: Number, default: 0 },

    // Crash weekly leaderboard — tracks best cash-out multiplier per calendar week
    crashStats: {
        weekBest:     { type: Number, default: 0 },
        weekStart:    { type: Date,   default: null },
        allTimeBest:  { type: Number, default: 0 },
        username:     { type: String, default: null },
    },

    // New user onboarding state
    onboarding: {
        starterKitClaimed: { type: Boolean, default: false },
        firstDailyClaimed: { type: Boolean, default: false },
        firstWorkDone:     { type: Boolean, default: false },
        firstHuntDone:     { type: Boolean, default: false },
    },

    // Lifetime stats used for achievement checks
    lifetimeGambled: { type: Number, default: 0 },
    successfulRobs:  { type: Number, default: 0 },
    failedRobs:      { type: Number, default: 0 },
    questsCompleted: { type: Number, default: 0 },
    lastWarnedAt:    { type: Date, default: null },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

userSchema.set('optimisticConcurrency', true);

userSchema.index({ userId: 1, guildId: 1 }, { unique: true });
userSchema.index({ guildId: 1, 'streak.current': -1 });
userSchema.index({ guildId: 1, 'streak.longest': -1 });
userSchema.index({ guildId: 1, duelWins: -1 });
userSchema.index({ guildId: 1, 'ranked.elo': -1 });
userSchema.index({ guildId: 1, 'accountPrestige.rank': -1 });
userSchema.index({ guildId: 1, achievementsCount: -1 });
userSchema.index({ guildId: 1, seasonCoins: -1 }); // used by executeLeaderboard / executeSeasonMe
userSchema.index({ guildId: 1, syndicateId: 1 });  // used by syndicate member lookups
userSchema.index({ guildId: 1, level: -1, xp: -1 });          // leaderboard level sort + rank.js countDocuments
userSchema.index({ guildId: 1, balance: -1, bank: -1 });      // leaderboard wealth sort

userSchema.pre('save', function(next) {
    this.updatedAt = Date.now();

    const ids = (this.achievements || []).map(a => a.id);
    if (new Set(ids).size !== ids.length) {
        return next(new Error('User achievements contains duplicate id values'));
    }

    next();
});

module.exports = model('User', userSchema);
module.exports.DECEASED_PET_LIMIT = DECEASED_PET_LIMIT;
