'use strict';

// The half of a grind shop that is the same in all three of them (#892).
//
// /hunt shop, /fish shop and /mine shop sell different things, but they take
// the money the same way, and each folder's shared.js had its own copy of that
// — the wallet filter, the charge, the refund, and the prestige badge ladder
// the profiles print. Four functions and a table, three times over.

const { chargeExact, refundCharge } = require('./balanceDebit');
const User = require('../models/User');

/** The filter that identifies a player's wallet in this guild. */
const walletOf = interaction => ({ userId: interaction.user.id, guildId: interaction.guild.id });

// The prestige rank badges, in rank order — index 0 is "no prestige yet", so
// it is deliberately blank rather than absent.
const PRESTIGE_BADGES = ['', '🥉', '🥈', '🥇', '🏆', '💎'];

/**
 * The charge and refund pair a grind shop spends through.
 *
 * The charge is a conditional update rather than `user.balance -= cost`
 * followed by a save, because the loaded document's balance goes stale the
 * moment any other command pays the player — see utils/balanceDebit.js. The
 * refund carries the shop's own ledger tag, so a rolled-back purchase is
 * attributable to the shop that failed it.
 *
 * @param {string} activity 'hunt', 'fish' or 'mine' — the ledger tag's prefix.
 */
function grindWallet(activity) {
    const tag = `${activity}shop`;
    return {
        chargeBalance: (interaction, cost) => chargeExact(User, walletOf(interaction), cost),
        refundBalance: (interaction, cost) => refundCharge(User, walletOf(interaction), cost, tag),
    };
}

module.exports = { walletOf, grindWallet, PRESTIGE_BADGES };
