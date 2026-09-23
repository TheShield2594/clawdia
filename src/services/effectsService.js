// Configuration for every usable item effect
const EFFECT_CONFIGS = {
    shield:             { label: 'Shield',            emoji: '🛡️',   durationMs: 12 * 3_600_000, charges: -1 },
    padlock:            { label: 'Padlock',            emoji: '🔒',   durationMs: null,            charges: 1  },
    lucky_charm:        { label: 'Lucky Charm',        emoji: '🍀',   durationMs: 2  * 3_600_000, charges: -1 },
    lifesaver:          { label: 'Lifesaver',          emoji: '🛟',   durationMs: null,            charges: 1  },
    invisibility_cloak: { label: 'Invisibility Cloak', emoji: '🧥',   durationMs: 6  * 3_600_000, charges: -1 },
    knife:              { label: 'Knife',              emoji: '🔪',   durationMs: 1  * 3_600_000, charges: -1 },
    robbery_bag:        { label: 'Robbery Bag',        emoji: '💼',   durationMs: 1  * 3_600_000, charges: -1 },
    streak_shield:      { label: 'Streak Shield',      emoji: '🔥🛡️', durationMs: null,            charges: 1  },

    // ── Booster effects ───────────────────────────────────────────────────────
    coin_booster_2x:    { label: '2x Coin Booster',   emoji: '💰🚀', durationMs: 1  * 3_600_000, charges: -1 },
    xp_booster_2x:      { label: '2x XP Booster',     emoji: '⭐🚀', durationMs: 1  * 3_600_000, charges: -1 },
    lucky_streak:       { label: 'Lucky Streak',       emoji: '🎯',   durationMs: 30 * 60_000,     charges: -1 },
    salary_raise:       { label: 'Salary Raise',       emoji: '📈',   durationMs: 2  * 3_600_000, charges: -1 },

    // ── P8 Black Market effects ───────────────────────────────────────────────
    obsidian_crown:     { label: 'Obsidian Crown',      emoji: '👑',   durationMs: 2  * 3_600_000, charges: -1 },
    voidsteel_cache:    { label: 'Voidsteel Cache',     emoji: '🌌',   durationMs: null,            charges: 10 },
    ghost_ledger:       { label: 'Ghost Ledger',        emoji: '📒',   durationMs: null,            charges: 3  },

    // ── Black Market effects (P1+) ────────────────────────────────────────────
    silvered_talisman:  { label: 'Silvered Talisman',   emoji: '🪙',   durationMs: null,            charges: 5  },
    phantom_token:      { label: 'Phantom Token',       emoji: '👻',   durationMs: null,            charges: 1  },
    // black_market_contract is permanent (stored on user.crimeContractStacks) — no activeEffects entry
};

// Maps item IDs (as stored in inventory) to effect type keys.
// Snake_case keys are the canonical IDs; legacy space/title-case entries
// remain for backward compatibility with items in existing inventories.
const ITEM_TO_EFFECT = {
    // Canonical snake_case IDs (primary — new items use these)
    'shield':             'shield',
    'padlock':            'padlock',
    'lifesaver':          'lifesaver',
    'knife':              'knife',
    'lucky_charm':        'lucky_charm',
    'streak_shield':      'streak_shield',
    'invisibility_cloak': 'invisibility_cloak',
    'robbery_bag':        'robbery_bag',
    'coin_booster_2x':    'coin_booster_2x',
    'xp_booster_2x':      'xp_booster_2x',
    'lucky_streak':       'lucky_streak',
    'salary_raise':       'salary_raise',
    'obsidian_crown':     'obsidian_crown',
    'voidsteel_cache':    'voidsteel_cache',
    'ghost_ledger':       'ghost_ledger',
    'silvered_talisman':  'silvered_talisman',
    'phantom_token':      'phantom_token',

    // Legacy space-separated IDs (backward compat for existing inventory items)
    'lucky charm':        'lucky_charm',
    'streak shield':      'streak_shield',
    'invisibility cloak': 'invisibility_cloak',
    'robbery bag':        'robbery_bag',
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

/**
 * Start an effect in the database, in one guarded write — optionally consuming
 * the inventory item that pays for it in the same write (#873, pass 14).
 *
 * `addEffect` above mutates a loaded document for its caller to `save()`, and
 * `save()` writes `activeEffects` back as a `$set` of the array as it was read.
 * `/use` consumed the item atomically and then did exactly that, so a save that
 * failed left the item spent and no effect running, and one that landed wrote
 * back a snapshot over any effect change made in between. This is the same
 * thing as a single update:
 *
 *   1. `$pull` this type's spent or expired entries. That only removes what
 *      `pruneEffects` would drop on the next read anyway, so it is safe on its
 *      own even if step 2 then refuses.
 *   2. Push the fresh effect, filtered on no entry of this type being left. A
 *      live one means it is already running, and the write matches nothing, so
 *      two clicks cannot both activate one effect and spend two items for it.
 *      With `consumeItemId`, the item's decrement rides the same filter, so
 *      the item goes exactly when the effect starts and never otherwise.
 *
 * `arrayFilters` rather than the positional `$` for the decrement: the filter
 * names two arrays, which makes `$` ambiguous about which one it indexes.
 *
 * @returns {Promise<{status: 'activated'|'refused'|'unknown', doc: ?object, effect: ?object}>}
 *   `refused` means the effect is already running, or (with `consumeItemId`)
 *   the item is gone; nothing was written beyond the stale-entry prune.
 */
async function activateEffect(Model, filter, type, { consumeItemId = null, now = Date.now() } = {}) {
    const cfg = EFFECT_CONFIGS[type];
    if (!cfg) return { status: 'unknown', doc: null, effect: null };

    const at = new Date(now);
    await Model.updateOne(
        filter,
        { $pull: { activeEffects: { type, $or: [{ charges: 0 }, { expiresAt: { $lte: at } }] } } },
    );

    const effect = {
        type,
        expiresAt: cfg.durationMs ? new Date(now + cfg.durationMs) : null,
        charges:   cfg.charges,
    };
    const query   = { ...filter, 'activeEffects.type': { $ne: type } };
    const update  = { $push: { activeEffects: effect } };
    const options = { new: true };
    if (consumeItemId) {
        query.inventory = { $elemMatch: { itemId: consumeItemId, quantity: { $gt: 0 } } };
        update.$inc = { 'inventory.$[inv].quantity': -1 };
        options.arrayFilters = [{ 'inv.itemId': consumeItemId, 'inv.quantity': { $gt: 0 } }];
    }

    const doc = await Model.findOneAndUpdate(query, update, options);
    return doc
        ? { status: 'activated', doc, effect }
        : { status: 'refused', doc: null, effect: null };
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

// Restore one charge consumed by consumeEffect, re-adding the effect if spending
// the last charge removed it. Used when an action that already charged the player
// is reversed (e.g. a fish escaping after the payout was rolled).
// No-op for unlimited-charge effects (charges === -1), which are never spent.
function refundEffectCharge(user, type) {
    const cfg = EFFECT_CONFIGS[type];
    if (!cfg || cfg.charges === -1) return false;
    pruneEffects(user);
    const effect = user.activeEffects.find(e => e.type === type);
    if (effect) {
        effect.charges = Math.min(cfg.charges, effect.charges + 1);
    } else {
        user.activeEffects.push({
            type,
            expiresAt: cfg.durationMs ? new Date(Date.now() + cfg.durationMs) : null,
            charges:   1,
        });
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
    if (hasEffect(user, 'obsidian_crown')) return 4.0;
    return hasEffect(user, 'salary_raise') ? 1.5 : 1.0;
}

// Returns gathering yield multiplier from Silvered Talisman (5-charge, P1+) or Voidsteel Cache
// (10-charge, P8+). Voidsteel Cache takes priority if both are active. Returns the effect key
// that should be consumed, or null if neither is active, so callers can consumeEffect correctly.
function getGatheringYieldEffect(user) {
    if (hasEffect(user, 'voidsteel_cache'))   return 'voidsteel_cache';
    if (hasEffect(user, 'silvered_talisman')) return 'silvered_talisman';
    return null;
}

function getGatheringYieldMultiplier(user) {
    return getGatheringYieldEffect(user) ? 2.0 : 1.0;
}

// Returns XP multiplier from personal booster
function getXpMultiplier(user) {
    return hasEffect(user, 'xp_booster_2x') ? 2.0 : 1.0;
}

// Returns the lucky_streak win-rate bonus (0.25 if active, else 0)
function getLuckyStreakBonus(user) {
    return hasEffect(user, 'lucky_streak') ? 0.25 : 0.0;
}

// Lucky Charm / Lucky Streak loss-saves only apply to bets at or below this size.
// A 20-25% loss refund on an unbounded bet flips every casino game's house edge
// player-positive, so the saves are capped to low-stakes play.
const LUCKY_SAVE_MAX_BET = 25_000;

// Whether lucky loss-save effects (charm re-spin / streak push) may trigger for this bet.
function luckySaveEligible(bet) {
    return bet <= LUCKY_SAVE_MAX_BET;
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

// Returns public-safe protection status for a target user (omits padlock intentionally).
function getPublicProtectionStatus(user) {
    pruneEffects(user);
    const shield = user.activeEffects.find(e => e.type === 'shield');
    const cloak  = user.activeEffects.find(e => e.type === 'invisibility_cloak');
    return { shield: shield ?? null, cloak: cloak ?? null };
}

module.exports = {
    EFFECT_CONFIGS,
    resolveEffectType,
    pruneEffects,
    hasEffect,
    getEffect,
    addEffect,
    activateEffect,
    consumeEffect,
    refundEffectCharge,
    timeRemaining,
    getCoinMultiplier,
    getSalaryMultiplier,
    getXpMultiplier,
    getLuckyStreakBonus,
    LUCKY_SAVE_MAX_BET,
    luckySaveEligible,
    getServerCoinMultiplier,
    getServerXpMultiplier,
    getPublicProtectionStatus,
    getGatheringYieldMultiplier,
    getGatheringYieldEffect,
};
