'use strict';

// `/market buy` — coins one way, the item the other, minus the fee.

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags,
} = require('discord.js');
const User = require('../../../models/User');
const MarketListing = require('../../../models/MarketListing');
const { logTransaction } = require('../../../utils/logTransaction');
const {
    creditPurchasedItem, unwindPurchase, payListingSeller, recordAmbiguousClaim,
} = require('../../../services/marketService');
const COLORS = require('../../../utils/embedColors');
const { ownedBy } = require('../../../utils/collectorOwner');
const { itemDescriber } = require('../../../utils/aiItemLookup');
const { recordSale } = require('../../../services/marketPriceService');
const { MARKET_FEE_RATE, CONFIRM_BUY_THRESHOLD, itemLabel, live } = require('./shared');

async function handleBuy(interaction, currency, guildSettings) {
    const rawId = interaction.options.getString('listing_id');

    let listing;
    try {
        listing = await MarketListing.findOne({ _id: rawId, guildId: interaction.guild.id, ...live() });
    } catch {
        return interaction.reply({ content: 'Invalid listing ID.', flags: MessageFlags.Ephemeral });
    }

    if (!listing) {
        return interaction.reply({ content: 'Listing not found or already expired/sold.', flags: MessageFlags.Ephemeral });
    }
    if (listing.sellerId === interaction.user.id) {
        return interaction.reply({ content: "You can't buy your own listing.", flags: MessageFlags.Ephemeral });
    }
    const label          = itemLabel((await itemDescriber([listing.itemId], guildSettings?.shop ?? []))(listing.itemId));
    const totalCost      = listing.pricePerUnit * listing.quantity;
    const feeAmount      = Math.floor(totalCost * MARKET_FEE_RATE);
    const sellerReceives = totalCost - feeAmount;

    const executePurchase = async (editReply) => {
        const buyer = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: totalCost } },
            { $inc: { balance: -totalCost } },
            { new: true }
        );
        if (!buyer) {
            const fresh = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
            return editReply({
                content: `You need **${currency}${totalCost.toLocaleString()}** but only have **${currency}${(fresh?.balance ?? 0).toLocaleString()}**.`,
                embeds: [], components: [],
            });
        }

        // What to tell the buyer about their coins. Saying they came back when
        // they did not is the one thing this must never do; saying they are
        // recorded when the queue write failed too is the second. The writes
        // themselves are `unwindPurchase` in services/marketService.js, beside
        // the expiry sweep that unwinds the other way (#873).
        const refundNote = ({ credited, owed }) => (credited
            ? 'Your coins have been refunded.'
            : owed
                ? 'Returning your coins failed — it is recorded and an admin can restore them.'
                : 'Returning your coins failed and could not be recorded. Please contact a server admin.');

        const unwind = (jobName, returnStock) => unwindPurchase({
            buyerId: interaction.user.id, sellerId: listing.sellerId,
            guildId: interaction.guild.id, listing, totalCost,
            refundKey: interaction.id, jobName, returnStock,
        });

        // The claim, and the one write in this flow whose *failure* says nothing
        // about its outcome (#873). It had no `catch` at all, so a rejection
        // escaped a purchase that had already taken the buyer's money — the
        // coins gone, with nothing written down anywhere.
        let removed;
        try {
            removed = await MarketListing.findOneAndDelete({ _id: listing._id, guildId: interaction.guild.id });
        } catch (claimErr) {
            console.error('[market buy] claiming the listing failed after the buyer was debited:', claimErr);
            // The buyer is refunded; the stock is not, because a rejection
            // leaves it unknowable whether this delete landed or a concurrent
            // buyer's did, and returning stock for a listing somebody else
            // bought mints an item. But "not granted" must not mean "not written
            // down" (#873): the record goes in first, where an operator can find
            // it, rather than into a log line nobody was reading at the time.
            // Tri-state on purpose: `true`, `false`, or `null` when the
            // re-read itself failed. `Boolean()` here turned a failed read into
            // "the listing is gone", which is guidance that ends in stock being
            // returned for a listing that may still be live.
            const stillListed = await MarketListing
                .findOne({ _id: listing._id, guildId: interaction.guild.id }, '_id').lean()
                .then(Boolean)
                .catch(() => null);
            const recorded = await recordAmbiguousClaim({
                listing, buyerId: interaction.user.id, guildId: interaction.guild.id,
                stillListed, error: claimErr,
            });
            const { refund } = await unwind('buyRefundClaim', false);
            if (stillListed !== true) {
                console.error(
                    `[market buy] listing ${listing._id} ` +
                    `${stillListed === false ? 'is gone' : 'could not be re-read'} after a claim that rejected — ` +
                    `${listing.quantity}x ${listing.itemId} may be owed back to ${listing.sellerId}; ` +
                    `${recorded ? 'recorded for an operator to adjudicate' : 'NOT RECORDED'}`,
                );
            }
            return editReply({ content: `Something went wrong claiming the listing. ${refundNote(refund)}`, embeds: [], components: [] });
        }

        if (!removed) {
            // Somebody else's purchase won the delete, so the item is theirs and
            // only the coins come back.
            const { refund } = await unwind('buyRefundLost', false);
            return editReply({ content: `This listing was just sold. ${refundNote(refund)}`, embeds: [], components: [] });
        }

        // Update buyer inventory first; roll back the buyer deduction if it
        // fails. One atomic upsert rather than read-modify-save: a save computed
        // from a read here would flatten any credit that landed in between, and
        // two concurrent credits of the same item could each push their own slot.
        //
        // Keyed, which is what lets the unwind below decide rather than assume —
        // see `creditPurchasedItem`.
        // `indeterminate` is not `!delivered`, and unwinding on it is worse than
        // either guess (#873): undoing a purchase whose credit had in fact
        // landed refunds the buyer *and* returns the seller's stock, so the
        // buyer keeps a free item and a second copy appears in the seller's bag.
        // Nothing is undone for that state — `creditPurchasedItem` files it
        // under the purchase's own key, which settles it whichever way it went.
        const {
            delivered, indeterminate, owed: itemOwed, error: inventoryErr,
        } = await creditPurchasedItem({
            buyerId: interaction.user.id, guildId: interaction.guild.id, listing,
        });

        if (!delivered && !indeterminate) {
            console.error('[market buy] inventory update failed, refunding buyer:', inventoryErr);
            // A definite miss, so the purchase comes apart. The listing is
            // claimed, so the stock comes back too: it left the seller's bag
            // when they listed it and the row that held it is gone.
            const { refund } = await unwind('buyRefundItem', true);
            return editReply({ content: `Something went wrong crediting the item. ${refundNote(refund)}`, embeds: [], components: [] });
        }

        // The seller's proceeds — keyed, verified and filed as owed when they
        // will not land, in `payListingSeller` (#869).
        const {
            paid: sellerPaid, owed: owedRecorded, balance: sellerBalance, payoutKey: saleKey,
        } = await payListingSeller({
            sellerId: listing.sellerId, guildId: interaction.guild.id,
            listing, amount: sellerReceives,
        });

        // Logged whether or not the credit landed: the sale happened, and a row
        // that only appears when the credit lands leaves the coins unaccounted
        // for exactly when someone goes looking for them. The note says which it
        // was, so an operator reading a `market_sell` whose balance did not move
        // has the reason in front of them rather than a discrepancy to work out.
        //
        // The one thing that stops the row being written is not knowing the
        // balance to put on it (#873). `balance` is required on the Transaction
        // schema, and the figure used to fall back to `0` — a number nobody
        // read, filed in the ledger as though somebody had. A missing row is a
        // gap an operator can see; a fabricated balance is one they cannot.
        if (sellerBalance === null) {
            console.error(
                `[market buy] listing ${listing._id} sold and the seller's balance could not be read — ` +
                `no market_sell row filed for ${sellerReceives} to ${listing.sellerId} ` +
                `(payout ${sellerPaid ? 'landed' : `owed under ${saleKey}`})`,
            );
        } else {
            logTransaction({
                userId: listing.sellerId, guildId: interaction.guild.id, type: 'market_sell',
                amount: sellerReceives, balance: sellerBalance,
                note: sellerPaid ? listing.itemId : `${listing.itemId} — payout owed (${saleKey})`,
            });
        }
        logTransaction({ userId: interaction.user.id, guildId: interaction.guild.id, type: 'market_buy', amount: -totalCost, balance: buyer.balance, note: listing.itemId });
        // Price history for the /market list hint — the sale is final by here.
        recordSale({ guildId: interaction.guild.id, itemId: listing.itemId, quantity: listing.quantity, pricePerUnit: listing.pricePerUnit });

        // The buyer's side of the trade is complete whatever happened above, so
        // this is still a success — but the receipt does not claim the seller
        // was paid when they were not, nor that the payout is recorded when the
        // queue write failed too: `recordOwedPayout` returns false for that, and
        // an unrecorded payout is the one case a human has to be told about.
        return editReply({
            embeds: [new EmbedBuilder()
                .setColor(COLORS.SUCCESS)
                .setTitle('✅ Purchase Complete!')
                .setDescription(`You bought **${listing.quantity}x** ${label} for **${currency}${totalCost.toLocaleString()}**.`)
                .addFields(
                    { name: 'Fee Burned', value: `${currency}${feeAmount.toLocaleString()}`, inline: true },
                    sellerPaid
                        ? { name: 'Seller Received', value: `${currency}${sellerReceives.toLocaleString()}`, inline: true }
                        : {
                            name: 'Seller Payout',
                            value: owedRecorded
                                ? `${currency}${sellerReceives.toLocaleString()} — delayed, recorded as owed`
                                : `${currency}${sellerReceives.toLocaleString()} — delayed and not recorded, please contact a server admin`,
                            inline: true,
                        },
                    // Said out loud rather than left to the buyer to notice. The
                    // sale is real and the coins are spent either way, but a bag
                    // that may not have the item in it is not something to find
                    // out by looking.
                    ...(indeterminate ? [{
                        name: 'Your Item',
                        value: itemOwed
                            ? 'Delivery could not be confirmed — it is recorded and will be settled without charging you twice'
                            : 'Delivery could not be confirmed and could not be recorded, please contact a server admin',
                        inline: false,
                    }] : []),
                )
                .setTimestamp()
            ],
            components: [],
        });
    };

    // Confirmation step for purchases over the threshold
    if (totalCost >= CONFIRM_BUY_THRESHOLD) {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('mkt_buy_confirm').setLabel('Confirm Purchase').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('mkt_buy_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        );
        const confirmEmbed = new EmbedBuilder()
            .setColor(COLORS.WARN)
            .setTitle('🛒 Confirm Market Purchase')
            .setDescription(`Buy **${listing.quantity}x** ${label} for **${currency}${totalCost.toLocaleString()}**?`)
            .addFields(
                { name: 'Price/ea',    value: `${currency}${listing.pricePerUnit.toLocaleString()}`, inline: true },
                { name: 'Fee (5%)',    value: `${currency}${feeAmount.toLocaleString()}`,             inline: true },
                { name: 'You Pay',     value: `${currency}${totalCost.toLocaleString()}`,             inline: true },
            )
            .setFooter({ text: 'Confirmation expires in 30 seconds' });

        const msg = await interaction.reply({ embeds: [confirmEmbed], components: [row], fetchReply: true });
        const collector = msg.createMessageComponentCollector({
            componentType: ComponentType.Button,
            filter: ownedBy(interaction.user.id, "This isn't your purchase."),
            time: 30_000,
            max: 1,
        });
        collector.on('collect', async btn => {
            if (btn.customId === 'mkt_buy_cancel') {
                return btn.update({ content: 'Purchase cancelled.', embeds: [], components: [] });
            }
            await btn.deferUpdate();
            await executePurchase(opts => interaction.editReply(opts)).catch(err => {
                console.error('[market buy]', err);
                interaction.editReply({ content: 'Something went wrong. Please try again.', embeds: [], components: [] }).catch(() => {});
            });
        });
        collector.on('end', (collected, reason) => {
            if (reason === 'time' && collected.size === 0) {
                interaction.editReply({ content: 'Purchase timed out.', embeds: [], components: [] }).catch(() => {});
            }
        });
        return;
    }

    await interaction.deferReply();
    await executePurchase(opts => interaction.editReply(opts));
}

module.exports = { handleBuy };
