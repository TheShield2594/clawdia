'use strict';

// Values and helpers more than one part of /hunt needs. Nothing here reaches
// for a sibling module, which is what keeps the folder free of require cycles.

const { walletOf, grindWallet, PRESTIGE_BADGES } = require('../../../utils/grindShop');
const { PRESTIGE_BONUSES } = require('../../../data/huntData');
const { WILDERNESS_YIELD_BONUS } = require('../../../data/crossSystemData');

// The wallet, the charge and the refund are the same in all three grind
// shops and live in utils/grindShop.js (#892).
const { chargeBalance, refundBalance } = grindWallet('hunt');

const ACTIVATABLE     = ['basic_bait', 'premium_bait', 'luck_charm', 'hunters_focus', 'xp_scroll', 'stamina_tonic'];

const MAX_PRESTIGE = PRESTIGE_BONUSES.length - 1;

const PRESTIGE_LABELS = [
    null,
    '🥉 Bronze Prestige',
    '🥈 Silver Prestige',
    '🥇 Gold Prestige',
    '🏆 Champion Prestige',
    '💎 Diamond Prestige'
];

module.exports = {
    ACTIVATABLE,
    MAX_PRESTIGE,
    PRESTIGE_BADGES,
    PRESTIGE_LABELS,
    WILDERNESS_YIELD_BONUS,
    chargeBalance,
    refundBalance,
    walletOf,
};
