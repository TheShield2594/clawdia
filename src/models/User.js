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
    lastWheelSpin: { type: Date, default: null },
    lastFish: { type: Date, default: null },
    lastMine: { type: Date, default: null },
    lastCrime: { type: Date, default: null },
    shiftsWorked: { type: Number, default: 0 },

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

        // Hunt statistics
        totalHunts:        { type: Number, default: 0 },
        successfulHunts:   { type: Number, default: 0 },
        totalEarned:       { type: Number, default: 0 },
        legendaryKills:    { type: Number, default: 0 },
        eventKills:        { type: Number, default: 0 },
        bestPayout:        { type: Number, default: 0 },
        consecutiveFails:  { type: Number, default: 0 },

        // Anti-exploit: rolling 24-hour window tracking
        dailyCoins:        { type: Number, default: 0 },
        dailyHunts:        { type: Number, default: 0 },
        dailyWindowStart:  { type: Date,   default: null }
    },
    // ─────────────────────────────────────────────────────────────────────────

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

userSchema.index({ userId: 1, guildId: 1 }, { unique: true });

userSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = model('User', userSchema);
