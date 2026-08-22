'use strict';

// Values and helpers more than one part of /hunt needs. Nothing here reaches
// for a sibling module, which is what keeps the folder free of require cycles.

const { chargeExact, refundCharge } = require('../../../utils/balanceDebit');
const User = require('../../../models/User');
const { PRESTIGE_BONUSES } = require('../../../data/huntData');

const WILDERNESS_YIELD_BONUS = 0.10;

const walletOf = interaction => ({ userId: interaction.user.id, guildId: interaction.guild.id });

// One contract for both, shared with the other grind shops: the charge is a
// conditional update rather than `user.balance -= cost` followed by a save,
// because the loaded document's balance goes stale the moment any other
// command pays the player. See src/utils/balanceDebit.js.
const chargeBalance = (interaction, cost) => chargeExact(User, walletOf(interaction), cost);

const refundBalance = (interaction, cost) => refundCharge(User, walletOf(interaction), cost, 'huntshop');

const ACTIVATABLE     = ['basic_bait', 'premium_bait', 'luck_charm', 'hunters_focus', 'xp_scroll', 'stamina_tonic'];

const PRESTIGE_BADGES = ['', '🥉', '🥈', '🥇', '🏆', '💎'];

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
