'use strict';

// The half of a grind shop that is the same in all three of them (#892).
//
// /hunt shop, /fish shop and /mine shop sell different things, but they take
// the money the same way, and each folder's shared.js had its own copy of that
// — the wallet filter, the charge, the refund, and the prestige badge ladder
// the profiles print. Four functions and a table, three times over.

const { chargeExact, refundCharge } = require('./balanceDebit');
const { creditCoinsOrOwe } = require('./creditOrOwe');
const { shopRefundPayoutKey } = require('./payoutKey');
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
        // The keyed, replayable refund the failure paths that promise the player
        // their coins back have to use (#873, pass 9). `refundBalance` above is a
        // bare best-effort `$inc` that reads nothing back and swallows its own
        // error, and the repair/upgrade/unlock handlers replied "your coins were
        // refunded" over it whether or not it landed — the pass-3/pass-6 unwind
        // shape, in the shop handlers pass 6 did not reach. This routes the same
        // refund through `creditCoinsOrOwe`: keyed so a replay cannot pay twice,
        // and recorded as owed when it will not land, so the caller can word the
        // reply from the outcome instead of asserting one. Kept beside
        // `refundBalance` rather than replacing it because the two answer
        // different questions — `refundBalance` is the #884 best-effort primitive
        // its own tests pin, this is the recoverable refund a player is told about.
        refundBalanceOrOwe: (interaction, cost) => creditCoinsOrOwe(
            walletOf(interaction),
            cost,
            { payoutKey: shopRefundPayoutKey(interaction.id), service: activity, jobName: 'shopRefund' },
        ),
    };
}

/**
 * Word a shop refund reply from what `refundBalanceOrOwe` actually did, so a
 * repair/upgrade/unlock whose refund missed no longer tells the player it landed.
 *
 * `action` is the lead clause — 'The repair failed', 'Installing the upgrade
 * failed' — so the three shops share one three-way wording (refunded / recorded
 * as owed / neither) the way pass 6's buy handlers do.
 */
function shopRefundMessage(refund, { action, currency = '💰', amount }) {
    if (refund.credited) return `${action} — your coins were refunded. Please try again.`;
    if (refund.owed) {
        return `${action}, and the ${currency}${amount.toLocaleString()} charged could not be returned automatically ` +
            '— it has been recorded as owed and will be paid back once the problem clears. Tell an admin if it does not.';
    }
    return `${action}, and the ${currency}${amount.toLocaleString()} charged could not be returned or recorded ` +
        '— please contact a server admin.';
}

module.exports = { walletOf, grindWallet, shopRefundMessage, PRESTIGE_BADGES };
