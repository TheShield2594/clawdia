'use strict';

// Values and helpers more than one part of /mine needs. Nothing here reaches
// for a sibling module, which is what keeps the folder free of require cycles.

const { CONSUMABLES, MINER_LEVELS, PRESTIGE_BONUSES } = require('../../../data/mineData');
const { CROSS_CONSUMABLES, WILDERNESS_YIELD_BONUS } = require('../../../data/crossSystemData');
const { walletOf, grindWallet, PRESTIGE_BADGES } = require('../../../utils/grindShop');

// Resolve a consumable's display metadata from the mine shop or cross-system registry.
function resolveConsumableDef(id) {
    return CONSUMABLES[id] ?? CROSS_CONSUMABLES[id] ?? null;
}

// The wallet, the charge and the refund are the same in all three grind
// shops and live in utils/grindShop.js (#892).
const { chargeBalance, refundBalance } = grindWallet('mine');

const ACTIVATABLE      = ['ore_magnet', 'premium_magnet', 'miners_lamp', 'miners_instinct', 'xp_scroll', 'energy_tonic', 'reinforced_trap', 'mine_lock'];

// Miner Level tops out at the end of the MINER_LEVELS ladder; prestige tops out at
// the end of the bonus table. Both are derived so the two tables stay the authority.
const MAX_MINER_LEVEL   = MINER_LEVELS.length;

const MAX_MINE_PRESTIGE = PRESTIGE_BONUSES.length - 1;

module.exports = {
    ACTIVATABLE,
    MAX_MINER_LEVEL,
    MAX_MINE_PRESTIGE,
    PRESTIGE_BADGES,
    WILDERNESS_YIELD_BONUS,
    chargeBalance,
    refundBalance,
    resolveConsumableDef,
    walletOf,
};
