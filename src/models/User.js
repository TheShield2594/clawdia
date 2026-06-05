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
    lastSnowball: { type: Date, default: null },
    lastTrickOrTreat: { type: Date, default: null },
    lastRob: { type: Date, default: null },
    lastRobbedAt: { type: Date, default: null },
    lastDuel: { type: Date, default: null },
    // TODO: wheel game removed — this field is unused and can be dropped in a future migration
    // lastWheelSpin: { type: Date, default: null },
    lastFish: { type: Date, default: null },
    lastMine: { type: Date, default: null },
    lastCrime: { type: Date, default: null },
    lastHeist:        { type: Date, default: null },
    heistJailedUntil: { type: Date, default: null },
    wantedUntil: { type: Date, default: null },
    shiftsWorked: { type: Number, default: 0 },

    // Daily hard quiz attempt counter (resets midnight UTC)
    dailyQuizHard: { type: Number, default: 0 },
    dailyQuizHardReset: { type: Date, default: null },

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

    birthday: {
        month: { type: Number, min: 1, max: 12, default: null },
        day: { type: Number, min: 1, max: 31, default: null },
        year: { type: Number, min: 1900, max: 2100, default: null },
        lastCelebratedYear: { type: Number, default: null }
    },

    // ── Hunt System ──────────────────────────────────────────────────────────
    hunt: {
        // Stamina (regenerates over time, gates how often you can hunt)
        stamina:             { type: Number, default: 10 },
        staminaLastRegen:    { type: Date,   default: null },
        staminaTonicsToday:  { type: Number, default: 0 },
        lastTonicDayReset:   { type: Date,   default: null },

        // Hunter progression (separate from Discord leveling XP)
        xp:       { type: Number, default: 0 },
        level:    { type: Number, default: 1 },
        prestige: { type: Number, default: 0 },

        // Cooldowns
        lastHunt:     { type: Date, default: null },
        injuryUntil:  { type: Date, default: null },

        // Active zone & unlocked zones
        activeZone:    { type: String, default: 'beginner_forest' },
        unlockedZones: [{ type: String }],

        // Equipped weapon (index into weapons array; -1 = none)
        equippedWeaponIndex: { type: Number, default: -1 },

        // Weapons inventory (each weapon has persistent state)
        weapons: [{
            name:             { type: String },
            tier:             { type: Number },
            slug:             { type: String },
            currentDurability:{ type: Number },
            maxDurability:    { type: Number },
            baseDurability:   { type: Number },
            repairCount:      { type: Number, default: 0 },
            upgrade:          { type: String, default: null },
            status:           { type: String, default: 'good' }, // good|degraded|condemned|broken
            acquiredAt:       { type: Date,   default: Date.now }
        }],

        // Ammo stock (per type)
        ammo: {
            iron_shot:        { type: Number, default: 0 },
            steel_shot:       { type: Number, default: 0 },
            composite_round:  { type: Number, default: 0 },
            titanium_round:   { type: Number, default: 0 }
        },

        // Hunt consumables stock
        consumables: {
            basic_bait:        { type: Number, default: 0 },
            premium_bait:      { type: Number, default: 0 },
            luck_charm:        { type: Number, default: 0 },
            hunters_focus:     { type: Number, default: 0 },
            repair_kit_small:  { type: Number, default: 0 },
            repair_kit_large:  { type: Number, default: 0 },
            stamina_tonic:     { type: Number, default: 0 },
            xp_scroll:         { type: Number, default: 0 }
        },

        // Active consumable buffs
        activeBait:           { type: String, default: null },
        activeBaitHuntsLeft:  { type: Number, default: 0 },
        activeCharm:          { type: String, default: null },
        activeCharmHuntsLeft: { type: Number, default: 0 },
        activeFocus:          { type: Boolean, default: false },
        activeXpScroll:       { type: Boolean, default: false },

        // Crafting materials (special drops from animals)
        materials: {
            rabbits_foot:      { type: Number, default: 0 },
            acorn_cache:       { type: Number, default: 0 },
            feather:           { type: Number, default: 0 },
            down_feather:      { type: Number, default: 0 },
            antler_fragment:   { type: Number, default: 0 },
            tusk_shard:        { type: Number, default: 0 },
            badger_pelt:       { type: Number, default: 0 },
            beaver_pelt:       { type: Number, default: 0 },
            coyote_fang:       { type: Number, default: 0 },
            wolf_pelt:         { type: Number, default: 0 },
            elk_antler:        { type: Number, default: 0 },
            lynx_fang:         { type: Number, default: 0 },
            eagle_talon:       { type: Number, default: 0 },
            mountain_horn:     { type: Number, default: 0 },
            bear_claw:         { type: Number, default: 0 },
            moose_rack:        { type: Number, default: 0 },
            lion_tooth:        { type: Number, default: 0 },
            wolverine_fur:     { type: Number, default: 0 },
            spirit_pelt:       { type: Number, default: 0 },
            megaloceros_crown: { type: Number, default: 0 },
            golden_fur:        { type: Number, default: 0 },
            spirit_essence:    { type: Number, default: 0 },
            ancient_claw:      { type: Number, default: 0 },
            thunderfeather:    { type: Number, default: 0 },
            spectral_bone:     { type: Number, default: 0 },
            bandit_mask:       { type: Number, default: 0 }
        },

        // Permanent account upgrades
        luckyPaw: { type: Boolean, default: false },

        // Trophy collection (displayed on /hunt profile; awarded on legendary/event kills)
        trophies: [{ type: String }],

        // Hunt statistics
        totalHunts:        { type: Number, default: 0 },
        successfulHunts:   { type: Number, default: 0 },
        totalEarned:       { type: Number, default: 0 },
        legendaryKills:    { type: Number, default: 0 },
        eventKills:        { type: Number, default: 0 },
        bestPayout:        { type: Number, default: 0 },
        consecutiveFails:  { type: Number, default: 0 },
        sinceRare:         { type: Number, default: 0 },  // hunts since last rare+ drop

        // Anti-exploit: rolling 24-hour window tracking
        dailyCoins:        { type: Number, default: 0 },
        dailyHunts:        { type: Number, default: 0 },
        dailyWindowStart:  { type: Date,   default: null }
    },
    // ─────────────────────────────────────────────────────────────────────────

    // ── Fishing System ───────────────────────────────────────────────────────
    fishing: {
        stamina:             { type: Number, default: 10 },
        staminaLastRegen:    { type: Date,   default: null },
        energyDrinksToday:   { type: Number, default: 0 },
        lastDrinkDayReset:   { type: Date,   default: null },

        xp:       { type: Number, default: 0 },
        level:    { type: Number, default: 1 },
        prestige: { type: Number, default: 0 },

        lastCast:     { type: Date, default: null },
        injuryUntil:  { type: Date, default: null },

        activeLocation:    { type: String, default: 'pond' },
        unlockedLocations: [{ type: String }],

        equippedRodIndex: { type: Number, default: -1 },

        rods: [{
            name:              { type: String },
            tier:              { type: Number },
            slug:              { type: String },
            currentDurability: { type: Number },
            maxDurability:     { type: Number },
            baseDurability:    { type: Number },
            repairCount:       { type: Number, default: 0 },
            upgrade:           { type: String, default: null },
            status:            { type: String, default: 'good' },
            acquiredAt:        { type: Date,   default: Date.now }
        }],

        bait: {
            worm_bait:      { type: Number, default: 0 },
            shrimp_bait:    { type: Number, default: 0 },
            lure:           { type: Number, default: 0 },
            enchanted_lure: { type: Number, default: 0 }
        },

        consumables: {
            chum_bait:        { type: Number, default: 0 },
            premium_chum:     { type: Number, default: 0 },
            anglers_luck:     { type: Number, default: 0 },
            fish_xp_scroll:   { type: Number, default: 0 },
            repair_kit_small: { type: Number, default: 0 },
            repair_kit_large: { type: Number, default: 0 },
            energy_drink:     { type: Number, default: 0 }
        },

        activeBait:          { type: String,  default: null },
        activeBaitCastsLeft: { type: Number,  default: 0 },
        activeLuck:          { type: Boolean, default: false },
        activeXpScroll:      { type: Boolean, default: false },

        materials: {
            fish_scale:     { type: Number, default: 0 },
            rare_scale:     { type: Number, default: 0 },
            mythic_scale:   { type: Number, default: 0 },
            pearl:          { type: Number, default: 0 },
            seaweed_bundle: { type: Number, default: 0 },
            driftwood:      { type: Number, default: 0 },
            old_coin:       { type: Number, default: 0 },
            shark_tooth:    { type: Number, default: 0 },
            tentacle_ink:   { type: Number, default: 0 },
            coral_fragment: { type: Number, default: 0 }
        },

        luckyHook: { type: Boolean, default: false },

        trophies: [{ type: String }],

        totalCasts:       { type: Number, default: 0 },
        successfulCasts:  { type: Number, default: 0 },
        totalEarned:      { type: Number, default: 0 },
        legendaryCatches: { type: Number, default: 0 },
        eventCatches:     { type: Number, default: 0 },
        bestPayout:       { type: Number, default: 0 },
        consecutiveFails: { type: Number, default: 0 },
        sinceRare:        { type: Number, default: 0 },  // casts since last rare+ catch

        dailyCoins:       { type: Number, default: 0 },
        dailyCasts:       { type: Number, default: 0 },
        dailyWindowStart: { type: Date,   default: null },

        personalBest: {
            fish:     { type: String, default: null },
            weight:   { type: Number, default: 0    },
            payout:   { type: Number, default: 0    },
            caughtAt: { type: Date,   default: null }
        },
        weeklyRecord: {
            fish:      { type: String, default: null },
            weight:    { type: Number, default: 0    },
            weekStart: { type: Date,   default: null }
        },
        lastBossEncounter: { type: Date, default: null }
    },
    // ─────────────────────────────────────────────────────────────────────────

    // ── Mining System ────────────────────────────────────────────────────────
    mining: {
        stamina:             { type: Number, default: 10 },
        staminaLastRegen:    { type: Date,   default: null },
        energyTonicsToday:   { type: Number, default: 0 },
        lastTonicDayReset:   { type: Date,   default: null },

        xp:       { type: Number, default: 0 },
        level:    { type: Number, default: 1 },
        prestige: { type: Number, default: 0 },

        lastMine:     { type: Date, default: null },
        injuryUntil:  { type: Date, default: null },

        activeDepth:    { type: String, default: 'surface_quarry' },
        unlockedDepths: [{ type: String }],

        equippedPickaxeIndex: { type: Number, default: -1 },

        pickaxes: [{
            name:              { type: String },
            tier:              { type: Number },
            slug:              { type: String },
            currentDurability: { type: Number },
            maxDurability:     { type: Number },
            baseDurability:    { type: Number },
            repairCount:       { type: Number, default: 0 },
            upgrade:           { type: String, default: null },
            status:            { type: String, default: 'good' },
            acquiredAt:        { type: Date,   default: Date.now }
        }],

        charges: {
            iron_blast:        { type: Number, default: 0 },
            steel_blast:       { type: Number, default: 0 },
            explosive_charge:  { type: Number, default: 0 },
            void_charge:       { type: Number, default: 0 }
        },

        consumables: {
            ore_magnet:        { type: Number, default: 0 },
            premium_magnet:    { type: Number, default: 0 },
            miners_lamp:       { type: Number, default: 0 },
            miners_instinct:   { type: Number, default: 0 },
            repair_kit_small:  { type: Number, default: 0 },
            repair_kit_large:  { type: Number, default: 0 },
            energy_tonic:      { type: Number, default: 0 },
            xp_scroll:         { type: Number, default: 0 }
        },

        activeMagnet:          { type: String,  default: null },
        activeMagnetMinesLeft: { type: Number,  default: 0 },
        activeLamp:            { type: String,  default: null },
        activeLampMinesLeft:   { type: Number,  default: 0 },
        activeInstinct:        { type: Boolean, default: false },
        activeXpScroll:        { type: Boolean, default: false },

        materials: {
            rock_fragment:  { type: Number, default: 0 },
            coal_dust:      { type: Number, default: 0 },
            copper_flake:   { type: Number, default: 0 },
            iron_filing:    { type: Number, default: 0 },
            silver_dust:    { type: Number, default: 0 },
            lead_slug:      { type: Number, default: 0 },
            quartz_shard:   { type: Number, default: 0 },
            gold_nugget:    { type: Number, default: 0 },
            raw_sapphire:   { type: Number, default: 0 },
            amethyst_chip:  { type: Number, default: 0 },
            topaz_shard:    { type: Number, default: 0 },
            raw_emerald:    { type: Number, default: 0 },
            raw_ruby:       { type: Number, default: 0 },
            obsidian_chip:  { type: Number, default: 0 },
            platinum_dust:  { type: Number, default: 0 },
            raw_diamond:    { type: Number, default: 0 },
            crystal_sliver: { type: Number, default: 0 },
            mythril_dust:   { type: Number, default: 0 },
            zenith_essence: { type: Number, default: 0 },
            primordial_ash: { type: Number, default: 0 },
            stardust:       { type: Number, default: 0 },
            void_essence:   { type: Number, default: 0 }
        },

        sharpPick: { type: Boolean, default: false },

        totalMines:       { type: Number, default: 0 },
        successfulMines:  { type: Number, default: 0 },
        totalEarned:      { type: Number, default: 0 },
        legendaryFinds:   { type: Number, default: 0 },
        eventFinds:       { type: Number, default: 0 },
        bestPayout:       { type: Number, default: 0 },
        consecutiveFails: { type: Number, default: 0 },
        sinceRare:        { type: Number, default: 0 },  // mines since last rare+ material

        dailyCoins:       { type: Number, default: 0 },
        dailyMines:       { type: Number, default: 0 },
        dailyWindowStart: { type: Date,   default: null },

        // Persistent mine map (10×10 grid stored as flat array of 100 cell codes)
        // Cell codes: 0=unexplored, 1=excavated, 2=ore-vein, 3=cave-in
        mineMap:          [{ type: Number, default: 0 }],
        mineMapRow:       { type: Number, default: 5 },
        mineMapCol:       { type: Number, default: 5 },
        // Unprocessed ore stash — stolen during raids (material id → quantity map)
        oreStash:         { type: Object, default: {} },
        // Raid cooldowns
        lastRaidSent:     { type: Date, default: null },
        lastRaidReceived: { type: Date, default: null },
        // Mine Lock consumable stock
        mineLockActive:   { type: Boolean, default: false }
    },
    // ─────────────────────────────────────────────────────────────────────────

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
    pets: [{
        petId:              { type: String,  required: true },
        name:               { type: String,  default: null },
        hunger:             { type: Number,  default: 100, min: 0, max: 100 },
        lastFed:            { type: Date,    default: Date.now },
        adoptedAt:          { type: Date,    default: Date.now },
        starving:           { type: Boolean, default: false },
        starvingStartAt:    { type: Date,    default: null },
        lastPlay:           { type: Date,    default: null },
        restUntil:          { type: Date,    default: null },
        potw:               { type: Boolean, default: false },
        weeklyInteractions: { type: Number,  default: 0    },
        personality:        { type: String,  default: null },
    }],

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
    achievementsCount: { type: Number, default: 0 },

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
        announcedRank:  { type: Number, default: 0 }   // highest rank announced server-wide
    },

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

    // Crime syndicate membership
    syndicateId: { type: String, default: null },

    // Crash game: bet amount deducted but not yet resolved (cleared on cash out or crash end)
    pendingCrashRefund: { type: Number, default: 0 },

    // Crash weekly leaderboard — tracks best cash-out multiplier per calendar week
    crashStats: {
        weekBest:     { type: Number, default: 0 },
        weekStart:    { type: Date,   default: null },
        allTimeBest:  { type: Number, default: 0 },
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

userSchema.pre('save', function(next) {
    this.updatedAt = Date.now();

    const ids = (this.achievements || []).map(a => a.id);
    if (new Set(ids).size !== ids.length) {
        return next(new Error('User achievements contains duplicate id values'));
    }

    next();
});

module.exports = model('User', userSchema);
