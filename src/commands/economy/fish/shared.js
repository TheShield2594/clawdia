'use strict';

// Values and helpers more than one part of /fish needs. Nothing here reaches
// for a sibling module, which is what keeps the folder free of require cycles.

const { walletOf, grindWallet, PRESTIGE_BADGES } = require('../../../utils/grindShop');
const { PRESTIGE_BONUSES } = require('../../../data/fishData');

// The wallet, the charge and the refund are the same in all three grind
// shops and live in utils/grindShop.js (#892).
const { chargeBalance, refundBalance } = grindWallet('fish');

const FISH_TIER_SCORE = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, event: 6 };

const MAX_PRESTIGE = PRESTIGE_BONUSES.length - 1;

const PRESTIGE_LABELS = [
    null,
    '🥉 Bronze Angler',
    '🥈 Silver Angler',
    '🥇 Gold Angler',
    '🏆 Champion Angler',
    '💎 Diamond Angler'
];

module.exports = {
    FISH_TIER_SCORE,
    MAX_PRESTIGE,
    PRESTIGE_BADGES,
    PRESTIGE_LABELS,
    chargeBalance,
    refundBalance,
    walletOf,
};
