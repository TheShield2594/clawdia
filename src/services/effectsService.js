const { EFFECT_CONFIGS } = require('../data/effectConfigs');
const { recordEffectSpend, detachEffectWrites, applyEffectSpends } = require('../models/effectSpends');

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
    'shift_booster':      'shift_booster',
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

    // /daily's drop table hands these out under their short ids. Nothing ever
    // mapped them, so a dropped booster could not be activated at all — and
    // /use, finding no handler, would consume it for nothing.
    'coin_booster':       'coin_booster_2x',
    'xp_booster':         'xp_booster_2x',
};

function resolveEffectType(itemName) {
    return ITEM_TO_EFFECT[itemName.toLowerCase()] ?? null;
}

/**
 * Whether one stored effect is still live: charges left and not expired. The
 * one definition of "active" — pruneEffects filters on it, and read-only
 * callers (the /use picker, over a lean document) test it without mutating.
 */
function isActiveEffect(effect, now = Date.now()) {
    if (effect.charges === 0) return false;
    if (effect.expiresAt && new Date(effect.expiresAt).getTime() <= now) return false;
    return true;
}

function pruneEffects(user) {
    if (!user.activeEffects) { user.activeEffects = []; return; }
    const now = Date.now();
    user.activeEffects = user.activeEffects.filter(e => isActiveEffect(e, now));
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

// Charge spends made on a loaded document (`consumeEffect`,
// `refundEffectCharge` below) are never persisted by `save()`: the User model's
// save hooks keep `activeEffects` out of it and commit the recorded spends as
// guarded writes afterwards (#873, pass 15). The mechanics live in
// src/models/effectSpends.js, below the model that needs them.

/**
 * Spend one charge of `type` in a single guarded write, for a flow that decides
 * under its own compare-and-set (`/rob`, `/crime`) and so can claim the charge
 * at the moment it acts on it rather than after a save.
 *
 * `cond` and `update` are merged into the same write — `/rob` uses them to put
 * its cooldown claim in the filter, so the charge and the attempt it absorbs
 * land together or not at all. An unlimited effect (charges -1) is only checked
 * for being live.
 *
 * @returns {Promise<?object>} the post-image when the charge was spent, else null.
 */
async function spendEffectCharge(Model, filter, type, { cond = {}, update = {}, now = Date.now() } = {}) {
    const cfg = EFFECT_CONFIGS[type];
    if (!cfg) return null;
    // Live: no expiry, or one still ahead. `$not: { $lte }` matches both, null included.
    const live = { type, expiresAt: { $not: { $lte: new Date(now) } } };
    const charged = cfg.charges !== -1;
    const doc = await Model.findOneAndUpdate(
        {
            ...filter,
            ...cond,
            activeEffects: { $elemMatch: charged ? { ...live, charges: { $gt: 0 } } : live },
        },
        charged
            ? { ...update, $inc: { ...(update.$inc ?? {}), 'activeEffects.$.charges': -1 } }
            : update,
        { new: true },
    );
    if (doc && charged) {
        await Model.updateOne(filter, { $pull: { activeEffects: { type, charges: 0 } } })
            .catch(err => console.error(`[effects] pruning spent ${type} failed:`, err?.message));
    }
    return doc;
}

// Consume one charge; removes effect if charges reach 0.
// No-op for unlimited-charge effects (charges === -1).
//
// In memory only: the charge is recorded for the post-save hook to commit as a
// guarded `$inc` (see `applyEffectSpends` above), never persisted by `save()`.
function consumeEffect(user, type) {
    pruneEffects(user);
    const idx = user.activeEffects.findIndex(e => e.type === type);
    if (idx === -1) return false;
    const effect = user.activeEffects[idx];
    if (effect.charges > 0) {
        effect.charges -= 1;
        recordEffectSpend(user, type, 1);
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
    recordEffectSpend(user, type, -1);
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
    // Round up to the minute first, then split: rounding the minute part on
    // its own read 2h59m30s as "2h 60m".
    const total = Math.ceil(ms / 60_000);
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
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

// The Shift Booster's /work pay multiplier. Its own factor rather than part of
// getSalaryMultiplier, so it stacks with a Salary Raise instead of competing.
function getShiftMultiplier(user) {
    return hasEffect(user, 'shift_booster') ? 1.25 : 1.0;
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

// Lucky Charm / Lucky Streak loss-saves only apply to bets at or below this size.
const LUCKY_SAVE_MAX_BET = 25_000;

// What Lucky Charm and Lucky Streak are worth in each casino game: the chance a
// losing hand is saved. `charm` and `streak` are each game's own mechanic —
// a re-spin in slots and roulette, a refund of the stake everywhere else.
//
// Sized per game so that holding both items never takes a game past 99% return
// under the best strategy the game allows (#873, pass 26). They used to be 20%
// and 25% everywhere, and every game with a save paid its players: keno 118%,
// the cup game 120%, higher-or-lower 132% on a long-shot call, roulette 116% on
// a straight number, blackjack 111%, poker 108%, and a crash lobby whose host
// held a charm 119%. The figures are pinned in tests/casinoLuckAndBoosters.test.js.
//
// Blackjack, poker and crash return 99% or more before any save, so there is no
// save small enough to fit, and the items do nothing there.
const { LUCKY_CHARM_RESPIN, LUCKY_STREAK_REFUND } = require('../games/casino/slotsReels');
const CASINO_LUCK = Object.freeze({
    slots:       Object.freeze({ charm: LUCKY_CHARM_RESPIN, streak: LUCKY_STREAK_REFUND }),
    keno:        Object.freeze({ charm: 0.05,  streak: 0.05 }),
    cupgame:     Object.freeze({ charm: 0.04,  streak: 0.04 }),
    higherlower: Object.freeze({ charm: 0.02,  streak: 0.02 }),
    roulette:    Object.freeze({ charm: 0.015, streak: 0 }),
    blackjack:   Object.freeze({ charm: 0,     streak: 0 }),
    poker:       Object.freeze({ charm: 0,     streak: 0 }),
    crash:       Object.freeze({ charm: 0,     streak: 0 }),
});

/**
 * The save chances this player has in this casino game for this bet:
 * `{ charm, streak }`, each 0 when the item is not active, the bet is over
 * LUCKY_SAVE_MAX_BET, or the game gives the item nothing.
 */
function casinoLuck(game, user, bet) {
    const rates = CASINO_LUCK[game];
    if (!rates || !luckySaveEligible(bet)) return { charm: 0, streak: 0 };
    return {
        charm:  hasEffect(user, 'lucky_charm')  ? rates.charm  : 0,
        streak: hasEffect(user, 'lucky_streak') ? rates.streak : 0,
    };
}

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
    isActiveEffect,
    pruneEffects,
    hasEffect,
    getEffect,
    addEffect,
    activateEffect,
    consumeEffect,
    detachEffectWrites,
    applyEffectSpends,
    spendEffectCharge,
    refundEffectCharge,
    timeRemaining,
    getCoinMultiplier,
    getSalaryMultiplier,
    getShiftMultiplier,
    getXpMultiplier,
    CASINO_LUCK,
    casinoLuck,
    LUCKY_SAVE_MAX_BET,
    luckySaveEligible,
    getServerCoinMultiplier,
    getServerXpMultiplier,
    getPublicProtectionStatus,
    getGatheringYieldMultiplier,
    getGatheringYieldEffect,
};
