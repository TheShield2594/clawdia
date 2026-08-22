'use strict';

// Values and helpers more than one part of /fish needs. Nothing here reaches
// for a sibling module, which is what keeps the folder free of require cycles.

const { chargeExact, refundCharge } = require('../../../utils/balanceDebit');
const User = require('../../../models/User');
const { PRESTIGE_BONUSES } = require('../../../data/fishData');

const walletOf = interaction => ({ userId: interaction.user.id, guildId: interaction.guild.id });

// One contract for both, shared with the other grind shops: the charge is a
// conditional update rather than `user.balance -= cost` followed by a save,
// because the loaded document's balance goes stale the moment any other
// command pays the player. See src/utils/balanceDebit.js.
const chargeBalance = (interaction, cost) => chargeExact(User, walletOf(interaction), cost);

const refundBalance = (interaction, cost) => refundCharge(User, walletOf(interaction), cost, 'fishshop');

const FISH_TIER_SCORE = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, event: 6 };

const PRESTIGE_BADGES = ['', '🥉', '🥈', '🥇', '🏆', '💎'];

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
