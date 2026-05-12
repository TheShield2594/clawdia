// Configuration for every usable item effect
const EFFECT_CONFIGS = {
    shield:             { label: 'Shield',            emoji: '🛡️',   durationMs: 12 * 3_600_000, charges: -1 },
    padlock:            { label: 'Padlock',            emoji: '🔒',   durationMs: null,            charges: -1 },
    lucky_charm:        { label: 'Lucky Charm',        emoji: '🍀',   durationMs: 2  * 3_600_000, charges: -1 },
    lifesaver:          { label: 'Lifesaver',          emoji: '🛟',   durationMs: null,            charges: 1  },
    invisibility_cloak: { label: 'Invisibility Cloak', emoji: '🧥',   durationMs: 6  * 3_600_000, charges: -1 },
    knife:              { label: 'Knife',              emoji: '🔪',   durationMs: null,            charges: -1 },
    robbery_bag:        { label: 'Robbery Bag',        emoji: '💼',   durationMs: null,            charges: -1 },
    finders_fee:        { label: "Finder's Fee",       emoji: '💸',   durationMs: null,            charges: -1 },
    streak_shield:      { label: 'Streak Shield',      emoji: '🔥🛡️', durationMs: null,            charges: 1  },

    // ── Booster effects ───────────────────────────────────────────────────────
    coin_booster_2x:    { label: '2x Coin Booster',   emoji: '💰🚀', durationMs: 1  * 3_600_000, charges: -1 },
    xp_booster_2x:      { label: '2x XP Booster',     emoji: '⭐🚀', durationMs: 1  * 3_600_000, charges: -1 },
    lucky_streak:       { label: 'Lucky Streak',       emoji: '🎯',   durationMs: 30 * 60_000,     charges: -1 },
    salary_raise:       { label: 'Salary Raise',       emoji: '📈',   durationMs: 2  * 3_600_000, charges: -1 },
};

// Maps item names (as stored in inventory) to effect type keys
const ITEM_TO_EFFECT = {
    'shield':             'shield',
    'padlock':            'padlock',
    'lucky charm':        'lucky_charm',
    'lifesaver':          'lifesaver',
    'invisibility cloak': 'invisibility_cloak',
    'knife':              'knife',
    'robbery bag':        'robbery_bag',
    "finder's fee":       'finders_fee',
    'finders fee':        'finders_fee',
    'streak shield':      'streak_shield',
    '2x coin booster':    'coin_booster_2x',
    'coin booster':       'coin_booster_2x',
    '2x xp booster':      'xp_booster_2x',
    'xp booster':         'xp_booster_2x',
    'lucky streak':       'lucky_streak',
    'salary raise':       'salary_raise',
};

function resolveEffectType(itemName) {
    return ITEM_TO_EFFECT[itemName.toLowerCase()] ?? null;
}

function pruneEffects(user) {
    if (!user.activeEffects) { user.activeEffects = []; return; }
    const now = Date.now();
    user.activeEffects = user.activeEffects.filter(e => {
        if (e.charges === 0) return false;
        if (e.expiresAt && new Date(e.expiresAt).getTime() <= now) return false;
        return true;
    });
}

function hasEffect(user, type) {
    pruneEffects(user);
    return user.activeEffects.some(e => e.type === type);
}

function getEffect(user, type) {
    pruneEffects(user);
    return user.activeEffects.find(e => e.type === type) ?? null;
}

function addEffect(user, type) {
    const cfg = EFFECT_CONFIGS[type];
    if (!cfg) return null;
    pruneEffects(user);
    // Remove any existing effect of the same type before re-adding
    user.activeEffects = user.activeEffects.filter(e => e.type !== type);
    const effect = {
        type,
        expiresAt: cfg.durationMs ? new Date(Date.now() + cfg.durationMs) : null,
        charges:   cfg.charges,
    };
    user.activeEffects.push(effect);
    return effect;
}

// Consume one charge; removes effect if charges reach 0.
// No-op for unlimited-charge effects (charges === -1).
function consumeEffect(user, type) {
    pruneEffects(user);
    const idx = user.activeEffects.findIndex(e => e.type === type);
    if (idx === -1) return false;
    const effect = user.activeEffects[idx];
    if (effect.charges > 0) {
        effect.charges -= 1;
        if (effect.charges === 0) user.activeEffects.splice(idx, 1);
    }
    return true;
}

// Returns a human-readable time-remaining string (e.g. "1h 23m")
function timeRemaining(expiresAt) {
    if (!expiresAt) return 'permanent';
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (ms <= 0) return 'expired';
    const h = Math.floor(ms / 3_600_000);
    const m = Math.ceil((ms % 3_600_000) / 60_000);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

// ── Booster multiplier helpers ────────────────────────────────────────────────

// Returns coin multiplier from personal boosters (coin_booster_2x stacks with salary_raise for work)
function getCoinMultiplier(user) {
    return hasEffect(user, 'coin_booster_2x') ? 2.0 : 1.0;
}

// Returns the salary raise multiplier (applies only to /work earnings)
function getSalaryMultiplier(user) {
    return hasEffect(user, 'salary_raise') ? 1.5 : 1.0;
}

// Returns XP multiplier from personal booster
function getXpMultiplier(user) {
    return hasEffect(user, 'xp_booster_2x') ? 2.0 : 1.0;
}

// Returns the lucky_streak win-rate bonus (0.25 if active, else 0)
function getLuckyStreakBonus(user) {
    return hasEffect(user, 'lucky_streak') ? 0.25 : 0.0;
}

// Returns server-wide coin boost multiplier (1.0 if none active)
function getServerCoinMultiplier(guildSettings) {
    const sb = guildSettings?.serverBoost;
    if (!sb || sb.type !== 'coin' || !sb.expiresAt) return 1.0;
    if (new Date(sb.expiresAt).getTime() <= Date.now()) return 1.0;
    return sb.multiplier ?? 1.5;
}

// Returns server-wide XP boost multiplier (1.0 if none active)
function getServerXpMultiplier(guildSettings) {
    const sb = guildSettings?.serverBoost;
    if (!sb || sb.type !== 'xp' || !sb.expiresAt) return 1.0;
    if (new Date(sb.expiresAt).getTime() <= Date.now()) return 1.0;
    return sb.multiplier ?? 1.5;
}

module.exports = {
    EFFECT_CONFIGS,
    resolveEffectType,
    pruneEffects,
    hasEffect,
    getEffect,
    addEffect,
    consumeEffect,
    timeRemaining,
    getCoinMultiplier,
    getSalaryMultiplier,
    getXpMultiplier,
    getLuckyStreakBonus,
    getServerCoinMultiplier,
    getServerXpMultiplier,
};
