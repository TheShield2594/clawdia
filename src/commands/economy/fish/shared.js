'use strict';

// Values and helpers more than one part of /fish needs. Nothing here reaches
// for a sibling module, which is what keeps the folder free of require cycles.

const { walletOf, grindWallet, shopRefundMessage, PRESTIGE_BADGES } = require('../../../utils/grindShop');
const { randomInt } = require('crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { PRESTIGE_BONUSES, FIGHT_MOVES } = require('../../../data/fishData');
const { ownedBy } = require('../../../utils/collectorOwner');

// The wallet, the charge and the refund are the same in all three grind
// shops and live in utils/grindShop.js (#892). `refundBalanceOrOwe` is the
// keyed, recoverable refund the repair/upgrade/unlock handlers use (#873).
const { chargeBalance, refundBalance, refundBalanceOrOwe } = grindWallet('fish');

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


// Waits for one click on `message` from the caster, among `customIds`.
//
// The collector exists before the prompt it listens for is sent, so a click that
// lands the moment the buttons appear is never dropped. Its clock starts only
// when the caller says the prompt is up (`start`), so the time it takes to edit
// the message in does not come out of the player's window.
//
// Resolves with the clicked customId, or null when the window closes. The click
// is acknowledged after the promise has settled and its failure is swallowed:
// an acknowledgement that fails must not leave the handler waiting forever.
function awaitCasterClick(message, userId, customIds) {
    let collector;
    const choice = new Promise(resolve => {
        collector = message.createMessageComponentCollector({
            filter: ownedBy(userId, i => customIds.includes(i.customId), "This isn't your cast."),
            // Generous until `start` sets the real window; covers the edit round-trip.
            time: 60_000,
            max: 1,
        });
        collector.on('collect', i => {
            resolve(i.customId);
            i.deferUpdate().catch(() => null);
        });
        collector.on('end', () => resolve(null));
    });
    return { choice, start: windowMs => collector.resetTimer({ time: windowMs }) };
}

// The three fight moves (FIGHT_MOVES) as a button row, in a fresh order every
// time so the answer is read off the cue rather than off where the button was
// last time. Shared by the reel-in and the boss rounds.
function buildMoveRow(customIdFor) {
    const moves = Object.values(FIGHT_MOVES);
    for (let i = moves.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [moves[i], moves[j]] = [moves[j], moves[i]];
    }
    return new ActionRowBuilder().addComponents(moves.map(m =>
        new ButtonBuilder().setCustomId(customIdFor(m.id)).setEmoji(m.emoji).setLabel(m.label).setStyle(ButtonStyle.Secondary)
    ));
}

/** The move a buildMoveRow button stands for, from its custom id. */
function moveFromCustomId(customId) {
    return customId.slice(customId.lastIndexOf('_') + 1);
}

module.exports = {
    awaitCasterClick,
    buildMoveRow,
    moveFromCustomId,
    FISH_TIER_SCORE,
    MAX_PRESTIGE,
    PRESTIGE_BADGES,
    PRESTIGE_LABELS,
    chargeBalance,
    refundBalance,
    refundBalanceOrOwe,
    shopRefundMessage,
    walletOf,
};
