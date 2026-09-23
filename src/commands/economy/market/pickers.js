'use strict';

// `/market` autocomplete: the seller's bag for `list`, listed items for `browse`,
// and addressable listings for `buy` and `cancel`.

const User = require('../../../models/User');
const MarketListing = require('../../../models/MarketListing');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const { isSoulbound } = require('../../../data/soulboundItems');
const { itemDescriber } = require('../../../utils/aiItemLookup');
const { priceSnapshot, shortHint } = require('../../../services/marketPriceService');

/** Prefix matches first, then substring, then alphabetical — as /shop buy ranks. */
function rankByName(items, typed) {
    if (!typed) return [...items].sort((a, b) => a.name.localeCompare(b.name));
    return [...items].sort((a, b) => {
        const aPre = a.name.toLowerCase().startsWith(typed) ? 0 : 1;
        const bPre = b.name.toLowerCase().startsWith(typed) ? 0 : 1;
        return aPre - bPre || a.name.localeCompare(b.name);
    });
}

/** What the seller is holding and is allowed to list, for `/market list`. */
async function inventoryChoices(interaction, typed) {
    const [seller, guildSettings] = await Promise.all([
        User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id }, 'inventory').lean(),
        getGuildSettings(interaction.guild.id),
    ]);
    const held     = (seller?.inventory ?? []).filter(e => e.quantity > 0 && !isSoulbound(e.itemId));
    const heldIds  = held.map(e => e.itemId);
    const currency = guildSettings?.economy?.currency || '💰';
    const describe = await itemDescriber(heldIds, guildSettings?.shop ?? []);

    const items = held
        .map(e => ({ quantity: e.quantity, ...describe(e.itemId) }))
        .filter(i => !typed || i.name.toLowerCase().includes(typed) || i.itemId.toLowerCase().includes(typed));
    const shown = rankByName(items, typed).slice(0, 25);

    // The seller's price comes next, so the price hint belongs here — looked up
    // for the (at most 25) rows actually shown, not the whole bag, since this
    // runs on every keystroke.
    const prices = await priceSnapshot(interaction.guild.id, shown.map(i => i.itemId), { excludeSellerId: interaction.user.id });

    return shown.map(i => {
        // Hint before rarity: the rarity is what the 100-char cap should cut.
        const tags = [shortHint(prices.get(i.itemId), i, currency), i.rarity && `${i.rarityEmoji} ${i.rarity}`].filter(Boolean);
        return {
            name: `${i.emoji} ${i.name} — ${i.quantity} held${tags.map(t => ` · ${t}`).join('')}`.slice(0, 100),
            value: i.itemId.slice(0, 100),
        };
    });
}

/** The items that actually have listings, for the `/market browse` filter. */
async function listedItemChoices(interaction, typed) {
    const [itemIds, guildSettings] = await Promise.all([
        MarketListing.distinct('itemId', { guildId: interaction.guild.id }),
        getGuildSettings(interaction.guild.id),
    ]);
    const describe = await itemDescriber(itemIds, guildSettings?.shop ?? []);

    const items = itemIds
        .map(describe)
        .filter(i => !typed || i.name.toLowerCase().includes(typed) || i.itemId.toLowerCase().includes(typed));

    return rankByName(items, typed).slice(0, 25).map(i => ({
        name: `${i.emoji} ${i.name}`.slice(0, 100),
        value: i.itemId.slice(0, 100),
    }));
}

/**
 * Listings addressable by the caller: their own for `cancel`, everyone else's
 * for `buy` — the same split the handlers enforce, so the picker never offers a
 * listing that would be refused on submit.
 */
async function listingChoices(interaction, typed, sub) {
    const query = sub === 'cancel'
        ? { guildId: interaction.guild.id, sellerId: interaction.user.id }
        : { guildId: interaction.guild.id, sellerId: { $ne: interaction.user.id } };

    const [listings, guildSettings] = await Promise.all([
        MarketListing.find(query).sort({ pricePerUnit: 1 }).limit(100).lean(),
        getGuildSettings(interaction.guild.id),
    ]);
    const describe = await itemDescriber(listings.map(l => l.itemId), guildSettings?.shop ?? []);
    const currency = guildSettings?.economy?.currency ?? '';

    return listings
        .map(l => ({ listing: l, ...describe(l.itemId) }))
        .filter(i => !typed
            || i.name.toLowerCase().includes(typed)
            || String(i.listing._id).toLowerCase().startsWith(typed))
        .slice(0, 25)
        .map(i => ({
            name: `${i.emoji} ${i.listing.quantity}× ${i.name} — ${currency}${(i.listing.pricePerUnit * i.listing.quantity).toLocaleString()} total`.slice(0, 100),
            value: String(i.listing._id).slice(0, 100),
        }));
}

module.exports = { inventoryChoices, listedItemChoices, listingChoices };
