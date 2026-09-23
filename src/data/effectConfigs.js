'use strict';

// Every usable item effect: its label, emoji, how long it lasts and how many
// charges it carries (-1 for unlimited).
//
// Pure data, in the data layer so the User model's save hooks can read it (they
// commit charge spends — see src/models/effectSpends.js) without requiring a
// service. services/effectsService.js re-exports it for everything else.
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

module.exports = { EFFECT_CONFIGS };
