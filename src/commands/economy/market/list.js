'use strict';

// `/market list` — moving stock out of the seller's bag and into a listing slot.

const { EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../../models/User');
const MarketListing = require('../../../models/MarketListing');
const { listingCreateRefundPayoutKey } = require('../../../utils/payoutKey');
const { grantItemsOrOwe } = require('../../../utils/creditOrOwe');
const COLORS = require('../../../utils/embedColors');
const { isSoulbound } = require('../../../data/soulboundItems');
const { itemDescriber } = require('../../../utils/aiItemLookup');
const { priceSnapshot, priceCheck } = require('../../../services/marketPriceService');
const { MAX_LISTINGS_PER_USER, LISTING_SLOTS, LISTING_TTL_MS, itemLabel } = require('./shared');

async function handleList(interaction, currency, guildSettings) {
    // Deferred first, and ephemerally, as every reply below is. Between the
    // upsert, the debit, the slot claim and the price lookup this does enough
    // database work to outrun Discord's three-second window — and by the end
    // the listing is written, so a missed acknowledgement would leave the
    // seller told "the application did not respond" over a listing that exists.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const respond = ({ content = '', embeds = [] }) => interaction.editReply({ content, embeds });

    const typedItem = interaction.options.getString('item');
    const qty       = interaction.options.getInteger('quantity');
    const price     = interaction.options.getInteger('price');

    const seller = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        {},
        { upsert: true, new: true }
    );

    // Resolve what was typed against the seller's own bag, case-insensitively.
    //
    // This used to be `getString('item').toLowerCase()` compared with `===`
    // against the stored id, which is only ever right for the snake_cased shop
    // items. Relics are stored under their prose name ("The Tenth Owl") and a
    // custom guild item under whatever an admin called it, since shop.js stores
    // an item as `itemId || name` — so neither could be listed at all, whatever
    // the seller typed. Same resolution /gift and /use do.
    //
    // `stack`, not `slot`: a slot in this file is one of the seller's five
    // listing slots now, and this is the inventory stack being sold out of.
    const wanted = typedItem.trim().toLowerCase();
    const owned  = (seller.inventory ?? []).filter(i => i.itemId.toLowerCase() === wanted && i.quantity > 0);
    // The same predicate as the atomic debit below: a duplicate stack too small
    // to cover the sale must not reject one that can.
    const stack  = owned.find(i => i.quantity >= qty);

    if (!owned.length) {
        return respond({
            content: `You don't have **${typedItem}** in your inventory. Start typing in the \`item\` box to pick from what you're holding.`,
        });
    }

    // Canonical casing, for every database match and every label from here down
    // — including the soulbound test, which on the raw string let `Lifesaver`
    // past and refused it several lines later with the wrong reason.
    const itemId = (stack ?? owned[0]).itemId;
    const meta   = (await itemDescriber([itemId], guildSettings?.shop ?? []))(itemId);
    const label  = itemLabel(meta);

    if (isSoulbound(itemId)) {
        return respond({ content: `${label} is soulbound and cannot be listed.` });
    }

    if (!stack) {
        const held = owned.reduce((n, i) => n + i.quantity, 0);
        return respond({ content: `You don't have ${qty}x ${label} in your inventory — you hold ${held}.` });
    }

    // The friendly refusal, before any stock moves: a seller who is already full
    // is told so without their items being taken and handed back. It is not what
    // enforces the cap — two calls can pass this together — which is what the
    // slot the insert claims below is for.
    const openListings = await MarketListing.find(
        { guildId: interaction.guild.id, sellerId: interaction.user.id },
        'slot',
    ).lean();
    if (openListings.length >= MAX_LISTINGS_PER_USER) {
        return respond({ content: `You can only have ${MAX_LISTINGS_PER_USER} active listings at a time.` });
    }

    // The stock leaves as a compare-and-set, not `stack.quantity -= qty` followed
    // by a save: the quantity read above is history by now, and two concurrent
    // `/market list` calls for the same stack would each see the full count and
    // both take it — one stack backing two listings. The `$elemMatch` filter
    // makes the check and the debit the same write (same shape as use.js).
    const debited = await User.findOneAndUpdate(
        {
            userId:    interaction.user.id,
            guildId:   interaction.guild.id,
            inventory: { $elemMatch: { itemId, quantity: { $gte: qty } } },
        },
        { $inc: { 'inventory.$.quantity': -qty } },
        { new: true },
    );
    if (!debited) {
        return respond({ content: `You don't have ${qty}x ${label} in your inventory.` });
    }
    // Drop inventory stacks the decrement above emptied. Advisory: a failure
    // leaves an empty stack, not wrong quantities.
    await User.updateOne(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $pull: { inventory: { quantity: { $lte: 0 } } } },
    ).catch(err => console.error('[market list] inventory cleanup failed:', err));

    // Hand the stock back the same way every other credit lands — one atomic
    // upsert, so the return can't duplicate an inventory stack a concurrent
    // credit is creating (src/utils/inventoryGrant.js).
    //
    // The debit has already committed by the time anything calls this, so a
    // return that does not land is an item the player no longer has and no
    // listing to show for it. Two ways it fails to land: the update rejects, or
    // it matches no document and resolves null. Both are failures, and neither
    // may be reported as a return — the credit is written down as owed instead,
    // the same shape `replayOwedPayout` pays and `npm run payouts:replay` lists
    // (src/utils/owedPayout.js), which is what utils/balanceDelta.js does for a
    // credit that will not land in a command.
    //
    // This was the first of the three to be written and the only one that got it
    // right; it is `grantItemsOrOwe` now so all three share the rule rather than
    // one of them carrying it (#873). The one thing it gains is the key: the
    // record it files could previously be replayed against a write that had in
    // fact committed and merely lost its response, which would hand the seller a
    // second copy of the stock.
    //
    // The whole result, not just `granted`: `recordOwedPayout` answers false
    // when even the queue write failed, and collapsing that into the same
    // boolean would make the reply below promise an operator a record that is
    // not there — which is the same class of untrue reassurance as the ones the
    // rest of this pass removed.
    const returnStock = () => grantItemsOrOwe(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        itemId, qty,
        {
            payoutKey: listingCreateRefundPayoutKey(interaction.id),
            service: 'market',
            jobName: 'listItem',
        },
    );

    // What to tell the seller about their stock. Saying it came back when it did
    // not is the one thing this must never do: they would have no reason to
    // mention it to anyone. Saying it is recorded when it is not is the second.
    const stockNote = ({ granted, owed }) => (granted
        ? 'Your item has been returned.'
        : owed
            ? 'Your item could not be returned automatically — it is recorded as owed and an operator can restore it.'
            : 'Your item could not be returned and could not be recorded. Please contact a server admin.');

    let listing;
    try {
        listing = await createListingInFreeSlot({
            guildId:      interaction.guild.id,
            sellerId:     interaction.user.id,
            itemId,
            quantity:     qty,
            pricePerUnit: price,
            expiresAt:    new Date(Date.now() + LISTING_TTL_MS),
        });
    } catch (err) {
        const returned = await returnStock();
        console.error('[market list] MarketListing.create failed:', err);
        return respond({ content: `Failed to create listing. ${stockNote(returned)}` });
    }

    // Every slot was taken by the time the insert went in — the check above and
    // another `/market list` both passed it. The stock is handed straight back,
    // so losing the race costs the seller nothing but the refusal.
    if (!listing) {
        const returned = await returnStock();
        return respond({
            content: `You can only have ${MAX_LISTINGS_PER_USER} active listings at a time. ${stockNote(returned)}`,
        });
    }

    const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle('📦 Item Listed!')
        .setDescription(`**${qty}x** ${label} listed for **${currency}${price.toLocaleString()}** per unit.`)
        .addFields(
            { name: 'Listing ID', value: `\`${listing._id}\``, inline: false },
            { name: 'Expires',    value: `<t:${Math.floor(listing.expiresAt.getTime() / 1000)}:R>`, inline: true },
            { name: 'Fee Note',   value: `5% market fee deducted on sale`, inline: true },
        )
        .setTimestamp();

    // Advice while cancelling is still free; own listings excluded, so this one
    // is not reported back as the "cheapest other listing".
    const snapshot = (await priceSnapshot(interaction.guild.id, [itemId], { excludeSellerId: interaction.user.id })).get(itemId);
    const check = priceCheck(snapshot, meta, currency, price);
    if (check) embed.addFields({ name: '💡 Price Check', value: check, inline: false });

    return respond({ embeds: [embed] });
}

/**
 * Inserts the listing into the seller's first free slot, or answers null when
 * they have none left.
 *
 * The cap used to be a `countDocuments` followed by an insert (#926), which two
 * concurrent calls could both pass — cosmetic, but the pattern is the same one
 * that loses money elsewhere, and the fix is the one the rest of the economy
 * uses: let the write itself be the check. The unique index on
 * { guildId, sellerId, slot } means only one insert per slot can land, so the
 * loser of the race is told no rather than quietly making it six.
 *
 * Each attempt re-reads the taken slots, because an E11000 means exactly that
 * they have changed. One attempt per slot plus one is the most that can be
 * useful: every retry loses a different slot to somebody, and the read after the
 * last one finds the seller full.
 */
async function createListingInFreeSlot(fields) {
    for (let attempt = 0; attempt <= MAX_LISTINGS_PER_USER; attempt++) {
        const open = await MarketListing.find(
            { guildId: fields.guildId, sellerId: fields.sellerId },
            'slot',
        ).lean();
        const slotted = open.filter(l => l.slot != null);
        const taken   = new Set(slotted.map(l => l.slot));
        const free    = LISTING_SLOTS.filter(s => !taken.has(s));

        // A listing written before the slot field existed carries none, and the
        // index skips it — but it is still one of the seller's five, and taking
        // the lowest free number beside it would let a seller with four legacy
        // listings open five more. The legacy rows stand in for that many free
        // slots, so the seller has as many places left as they should and the
        // unique index still decides who gets each remaining number.
        const slot = free[open.length - slotted.length];
        if (slot === undefined) return null;

        try {
            return await MarketListing.create({ ...fields, slot });
        } catch (err) {
            // 11000 is the index doing its job: somebody else took this slot
            // between the read and the insert. Anything else is a real failure
            // and belongs to the caller, which hands the stock back.
            if (err?.code !== 11000) throw err;
        }
    }
    return null;
}

module.exports = { handleList, createListingInFreeSlot };
